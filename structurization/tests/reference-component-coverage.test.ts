import { expect, test } from "vitest";
import type { ReferenceOccurrence } from "../src/contracts.js";
import { resolvedReferenceComponentCoverageIssues } from "../src/reference-component-coverage.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";

function fixture(extraComponents = 0) {
  const texts = ["部件安装应符合被引条款。", "连接应牢固。", "检验方法：观察连接。", "另一种材料的专用要求。",
    ...Array.from({ length: extraComponents }, (_, index) => `虚构的其他对象要求 ${index + 1}。`)];
  const registry = registryWithFullSourceSpans("neutral-source", texts.map((text, index) => ({
    source_id: `source:${index}`, evidence_id: `source:${index}`, atom_id: `source:${index}`, text,
  })));
  const occurrence: ReferenceOccurrence = {
    occurrence_id: "occurrence:neutral", reference_kind: "clause", origin_evidence_id: "source:0",
    origin_fields: ["requirement"], raw_reference: "被引条款", target_evidence_ids: texts.slice(1).map((_, index) => `source:${index + 1}`),
    required: true, status: "resolved", depth: 1, path: [],
    target_address: { source_id: "neutral-source", locator_kind: "clause", locator: "7.4.2" },
  };
  const span = (index: number) => registry.spans.find(entry => entry.evidence_id === `source:${index}`)!;
  const reference: TargetSelectorPlan["references"][number] = {
    key: "route", occurrence_id: occurrence.occurrence_id, anchor_span_ids: [span(0).span_id],
    target_span_ids: [span(1).span_id], action: "adopt", application_mode: "reference_only",
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "当前仅导入判据。" },
    destinations: [{ item_key: "receiver", target_field: "requirement" }], reason: "来源映射。",
  };
  const selectors = { references: [reference], source_dispositions: [] as TargetSelectorPlan["source_dispositions"] };
  const check = (applied = [span(1)]) => resolvedReferenceComponentCoverageIssues(selectors, { reference_occurrences: [occurrence] }, registry, new Map([["receiver", applied]]));
  return { reference, occurrence, registry, span, check, selectors };
}

test("whole-standard omissions offer explicit scope correction without flooding the model or waiving the inventory", () => {
  const f = fixture(40);
  f.occurrence.external_standard = { standard_no: 'XQ 901-2099', status: 'resolved', usage: 'content_required' };
  f.occurrence.target_address = { source_id: 'neutral-source', locator_kind: 'standard', locator: 'standard:XQ901-2099' };
  f.occurrence.content_scope = { mode: 'whole_standard', reason: '先核对适用内容' };
  const before = structuredClone(f.occurrence);
  const [issue] = f.check();
  expect(issue).toMatchObject({ code: 'selector_resolved_reference_components_unaccounted', details: {
    actual: { resolved_component_count: 43, unaccounted_component_count: 42 },
    evidence_ids_complete: false, evidence_ids_total: 42,
    next_tool: 'resolve_external_standard_reference',
    scope_review: { current_occurrence_id: f.occurrence.occurrence_id,
      correction_arguments: { replaces_occurrence_id: f.occurrence.occurrence_id },
      reader_skip_changes_business_scope: false },
  } });
  expect((issue!.details!.evidence_ids as string[]).length).toBeLessThanOrEqual(12);
  expect(f.occurrence).toEqual(before);
  // The full inventory remains enforced when the author really adopts the whole source.
  f.reference.target_span_ids = f.registry.spans.filter(span => span.evidence_id !== 'source:0').map(span => span.span_id);
  expect(f.check()).toEqual([]);
});

test("a selected external range still requires every component and does not suggest silently shrinking it again", () => {
  const f = fixture();
  f.occurrence.external_standard = { standard_no: 'XQ 901-2099', status: 'resolved', usage: 'content_required' };
  f.occurrence.target_address = { source_id: 'neutral-source', locator_kind: 'standard', locator: 'standard:XQ901-2099/scope:neutral' };
  f.occurrence.content_scope = { mode: 'selected_targets', targets: [{ kind: 'section', number: '2' }], reason: '本对象的完整章节' };
  expect(f.check()[0]).toMatchObject({code:'selector_resolved_reference_components_unaccounted',
    details:{actual:{unaccounted_component_count:2},evidence_ids:['source:2','source:3'],next_tool:'list_reference_occurrences'}});
  expect(f.check()[0]!.details).not.toHaveProperty('scope_review');
});

test("single resolved reference cannot hide unaccounted components by selecting fewer target spans", () => {
  const { reference, occurrence, span, check } = fixture();
  const before = structuredClone({ reference, occurrence });
  const issues = check();
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ code: "selector_resolved_reference_components_unaccounted",
    details: { evidence_ids: ["source:2", "source:3"], actual: { resolved_component_count: 3, unaccounted_component_count: 2 },
      next_tool: "list_reference_occurrences", save_tool: "stage_target_selector_draft" } });
  expect({ reference, occurrence }).toEqual(before);
  reference.destinations = [];
  reference.target_span_ids = [span(1).span_id, span(2).span_id, span(3).span_id];
  reference.component_dispositions = [{ component_span_ids: reference.target_span_ids, decision: "same_judgment", item_keys: ["receiver"], reason: "声明接收不能代替真实来源绑定。" }];
  expect(check()[0]!.details).toMatchObject({ evidence_ids: ["source:2", "source:3"] });
  expect(check([span(1), span(2), span(3)])).toEqual([]);
});

test("field-specific imports can account for intentionally excluded source components without manufacturing items", () => {
  const { reference, span, check } = fixture();
  reference.application_mode = "reference_placeholder";
  reference.destinations = [];
  reference.target_span_ids.push(span(2).span_id, span(3).span_id);
  reference.component_dispositions = [
    { component_span_ids: [span(2).span_id], decision: "not_applicable", item_keys: [], reason: "本引用只用于判据，方法沿用本地明确规定。" },
    { component_span_ids: [span(3).span_id], decision: "not_applicable", item_keys: [], reason: "该组件限定另一种材料，本地适用条件排除了它。" },
  ];
  expect(check()).toEqual([]);
  reference.component_dispositions[1]!.reason = "";
  expect(check()[0]!.details).toMatchObject({ evidence_ids: ["source:3"] });
  reference.component_dispositions[1]!.reason = "排除另一种材料。";
  reference.component_dispositions[1]!.item_keys = ["receiver"];
  expect(check()[0]!.details).toMatchObject({ evidence_ids: ["source:3"] });
});

test("another occurrence's exclusions and an unresolved target do not change this inventory", () => {
  const { reference, occurrence, registry, span, check } = fixture();
  const other = structuredClone(reference);
  other.occurrence_id = "occurrence:other";
  other.target_span_ids.push(span(2).span_id, span(3).span_id);
  other.component_dispositions = [{ component_span_ids: other.target_span_ids, decision: "not_applicable", item_keys: [], reason: "其他引用的判断。" }];
  expect(resolvedReferenceComponentCoverageIssues({ references: [reference, other], source_dispositions: [] }, { reference_occurrences: [occurrence] }, registry, new Map([["receiver", [span(1)]]])))
    .toHaveLength(1);
  occurrence.status = "target_not_found";
  expect(check()).toEqual([]);
});

test("real inline reference receivers and explicit structural context count without copying facts into business fields", () => {
  const { reference, selectors, span, check } = fixture();
  reference.target_span_ids.push(span(2).span_id);
  selectors.source_dispositions.push({ span_ids: [span(3).span_id], disposition: "context", reason: "此合成组件为组织上下文，不是验收事实。" });
  expect(check()).toEqual([]);
  reference.destinations[0]!.item_key = "missing-receiver";
  expect(check()[0]!.details).toMatchObject({ evidence_ids: ["source:2"] });
});
