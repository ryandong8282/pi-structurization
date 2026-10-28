import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import { projectReferenceFieldSelections, type ReferenceFieldSelection } from "../src/reference-field-selection.js";
import { initialSourceSpanRegistry, registerSourceSpan } from "../src/source-span-registry.js";
import { initialTargetSelectorPlan, type TargetSelectorPlan } from "../src/target-selector-compiler.js";

function fixture() {
  const texts = {
    origin: "上电后，记录仪的检查方法按第2.3条执行。",
    method: "读取屏幕显示值。导出日志并核对。",
    table: "表4.1 到货指标\n时钟偏移|4s\n报警延迟|7s",
    sampling: "同批不超过120台抽3台；超过120台抽7台；封签损坏设备另行检查。",
    unrelated: "断电后人工清点。",
  };
  const manifest = {
    job_id: "fictional-recorder-job", target_id: "recorder-arrival", evidence_fingerprint: sha256Text(JSON.stringify(texts)),
    source: { sha256: sha256Text(JSON.stringify(texts)) },
    evidence: Object.entries(texts).map(([evidence_id, text]) => ({ evidence_id, text, text_sha256: sha256Text(text),
      kind: evidence_id === "table" ? "table_row" : "paragraph", role: "supporting_clause", locator: evidence_id, requires_disposition: true })),
    reference_occurrences: [], table_fragments: [],
  } as unknown as EvidenceManifest;
  let registry = initialSourceSpanRegistry(manifest.evidence_fingerprint);
  const quote = (evidence_id: keyof typeof texts, text: string, from = 0) => {
    const source = texts[evidence_id];
    const start = source.indexOf(text, from);
    if (start < 0) throw new Error(`fixture missing ${text}`);
    const registered = registerSourceSpan(registry, { source_id: evidence_id, evidence_id, atom_id: evidence_id, text: source }, start, start + text.length);
    registry = registered.registry;
    return registered.span.span_id;
  };
  const ids = {
    origin: quote("origin", texts.origin), literal: quote("origin", "第2.3条"), name: quote("origin", "记录仪"),
    method: quote("method", "读取屏幕显示值。"), alternative: quote("method", "导出日志并核对。"), methodWhole: quote("method", texts.method),
    table: quote("table", texts.table), clock: quote("table", "时钟偏移|4s"), alarm: quote("table", "报警延迟|7s"),
    sampling: quote("sampling", texts.sampling), unrelated: quote("unrelated", texts.unrelated),
  };
  manifest.reference_occurrences.push({ occurrence_id: "occurrence:method", origin_evidence_id: "origin",
    reference_literal_span_id: ids.literal, origin_fields: [], raw_reference: "第2.3条", target_evidence_ids: ["method"],
    required: true, status: "resolved", depth: 1, path: [], reference_kind: "clause",
    target_address: { source_id: manifest.source.sha256, locator_kind: "clause", locator: "2.3" } });
  const plan = initialTargetSelectorPlan(manifest);
  plan.lots.push({ key: "arrivals", name: "记录仪到货批", scope_span_ids: [ids.table], reason: "虚构的独立到货范围" });
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const,
    span_ids, separator: "" as const, reason: span_ids.length ? "已选原文" : "模型已核对原文未规定" });
  for (const [key, criterion] of [["clock", ids.clock], ["alarm", ids.alarm]]) {
    plan.items.push({ key: key!, lot_key: "arrivals", name: key!, category: "一般项目", criterion_span_ids: [criterion!], continuation_span_ids: [],
      fields: { name: { ...field([ids.name]), composition: "semantic_summary" }, requirement: field([criterion!]), method: field([]), quantity: field([]), note: field([]) },
      table: { source_kind: "direct", table_key: "arrival-metrics", reference_span_ids: [], reason: "独立表格指标",
        properties: { table_no_span_ids: [], table_title_span_ids: [ids.table], applicability_span_ids: [], row_path_span_ids: [[criterion!]],
          column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [criterion!], inspection_method_span_ids: [] } },
      inspection_data_type: "measurement", inspection_data_type_reason: "明确量值", inspection_data_type_span_ids: [criterion!],
      sampling: { status: "reference", rule_key: "arrival-count", branch_keys: ["up-to-120", "over-120"],
        quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "按明确批量选择分支；封签例外保留", confidence: 1 }, reason: "独立判断" });
  }
  plan.sampling_rules.push({ key: "arrival-count", complete_span_ids: [ids.sampling], components: [],
    branches: [{ key: "up-to-120", applies_to_category: "all_items", components: [], reason: "不超过120台抽3台" },
      { key: "over-120", applies_to_category: "all_items", components: [], reason: "超过120台抽7台，保留封签例外" }], reason: "虚构分支，仅检查原子事务保留" });
  const selection = (item_key = "clock", target = ids.method): ReferenceFieldSelection => ({ occurrence_id: "occurrence:method", action: "adopt",
    reason: "按明确跨节引用采用此项目的方法，保留本地适用语境。", bindings: [{ item_key, target_field: "method", target_span_ids: [target],
      component_decision: "same_judgment", local_context_fields: [{ field: "note", span_ids: [ids.origin], reason: "保留上电后的明确条件和引用原话" }], reason: "模型选择本项目适用的精确检查方法" }] });
  return { plan, manifest, registry, ids, selection, quote };
}

function apply(plan: TargetSelectorPlan, projected: ReturnType<typeof projectReferenceFieldSelections>): TargetSelectorPlan {
  const next = structuredClone(plan);
  for (const item of projected.draft.items ?? []) next.items[next.items.findIndex(existing => existing.key === item.key)] = item;
  for (const reference of projected.draft.references ?? []) {
    const index = next.references.findIndex(existing => existing.key === reference.key);
    if (index >= 0) next.references[index] = reference; else next.references.push(reference);
  }
  return next;
}

describe("explicit reference field selection", () => {
  test("one decision derives the field, exact targets, receiver and source scope without altering table or sampling decisions", () => {
    const f = fixture();
    const before = structuredClone(f.plan);
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]);
    expect(result.issues).toEqual([]);
    expect(f.plan).toEqual(before);
    expect(result.draft.items).toHaveLength(1);
    expect(result.draft.items![0]!.fields.method).toMatchObject({ composition: "reference", span_ids: [f.ids.method] });
    expect(result.draft.items![0]!.fields.note.span_ids).toEqual([f.ids.origin]);
    expect(result.draft.items![0]!.table).toEqual(before.items[0]!.table);
    expect(result.draft.items![0]!.sampling).toEqual(before.items[0]!.sampling);
    expect(result.draft.sampling_rules).toBeUndefined();
    expect(result.draft.references![0]).toMatchObject({ application_mode: "reference_only", occurrence_id: "occurrence:method",
      anchor_span_ids: [f.ids.literal], target_span_ids: [f.ids.method],
      destinations: [{ item_key: "clock", target_field: "method" }], import_scope: { mode: "field_specific", allowed_fields: ["method"] },
      origin_binding: { item_key: "clock", target_field: "note" },
      component_dispositions: [{ component_span_ids: [f.ids.method], decision: "same_judgment", item_keys: ["clock"] }] });
    expect(result.derived_relations).toHaveLength(1);
  });

  test("replaying an identical explicit choice is a no-op", () => {
    const f = fixture();
    const first = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]);
    const next = projectReferenceFieldSelections(apply(f.plan, first), f.manifest, f.registry, [f.selection()]);
    expect(next.issues).toEqual([]);
    expect(next.draft).toEqual(first.draft);
    expect(next.changed_paths).toEqual([]);
  });

  test("a partial correction preserves an untouched receiver and its precise source contribution", () => {
    const f = fixture();
    const both = f.selection();
    both.bindings.push(...f.selection("alarm").bindings);
    both.origin_binding = { item_key: "clock", target_field: "note" };
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [both]));
    const correction = f.selection("clock", f.ids.alternative);
    correction.bindings[0]!.local_context_fields = [];
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [correction]);
    expect(result.issues).toEqual([]);
    expect(result.draft.items).toHaveLength(1);
    expect(result.draft.items![0]!.key).toBe("clock");
    expect(result.draft.items![0]!.fields.note).toEqual(saved.items[0]!.fields.note);
    expect(result.draft.items![0]!.fields.method.span_ids).toEqual([f.ids.alternative]);
    expect(result.draft.references![0]!.destinations).toEqual(saved.references[0]!.destinations);
    expect(result.draft.references![0]!.target_span_ids).toEqual([f.ids.method, f.ids.alternative]);
    expect(result.draft.references![0]!.component_dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ component_span_ids: [f.ids.method], item_keys: ["alarm"] }),
      expect.objectContaining({ component_span_ids: [f.ids.alternative], item_keys: ["clock"] }),
    ]));
  });

  test("correcting the sole receiver removes only its previous target contribution", () => {
    const f = fixture();
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]));
    const update = f.selection("clock", f.ids.alternative);
    update.bindings[0]!.local_context_fields = [];
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [update]);
    expect(result.issues).toEqual([]);
    expect(result.draft.references![0]!.target_span_ids).toEqual([f.ids.alternative]);
    expect(result.draft.items![0]!.fields.note).toEqual(saved.items[0]!.fields.note);
    expect(result.draft.items![0]!.fields.requirement).toEqual(saved.items[0]!.fields.requirement);
  });

  test("another reference's contribution to the same field survives a correction", () => {
    const f = fixture();
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]));
    saved.references.push({ ...structuredClone(saved.references[0]!), key: "another-route", occurrence_id: "another-occurrence" });
    const update = f.selection("clock", f.ids.alternative);
    update.bindings[0]!.local_context_fields = [];
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [update]);
    expect(result.issues).toEqual([]);
    expect(result.draft.items![0]!.fields.method.span_ids).toEqual([f.ids.method, f.ids.alternative]);
    expect(result.draft.references).toHaveLength(1);
    expect(result.draft.references![0]!.target_span_ids).toEqual([f.ids.alternative]);
  });

  test("never invents local context or an origin binding when none was selected", () => {
    const f = fixture();
    const selection = f.selection();
    selection.bindings[0]!.local_context_fields = [];
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_origin_binding_required");
    expect(result.draft).toEqual({});
    expect(result.derived_relations).toEqual([]);
  });

  test("multiple real origin fields require an explicit choice", () => {
    const f = fixture();
    const selection = f.selection();
    selection.bindings.push(...f.selection("alarm").bindings);
    const unresolved = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(unresolved.issues.map(issue => issue.code)).toContain("reference_field_selection_origin_binding_required");
    selection.origin_binding = { item_key: "alarm", target_field: "note" };
    const selected = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(selected.issues).toEqual([]);
    expect(selected.draft.references![0]!.origin_binding).toEqual(selection.origin_binding);
  });

  test("rejects a mismatched explicit origin field instead of selecting another candidate", () => {
    const f = fixture();
    const selection = f.selection();
    selection.origin_binding = { item_key: "clock", target_field: "method" };
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_origin_binding_required");
    expect(result.draft).toEqual({});
  });

  test("a located exact literal cannot substitute for registration on the occurrence", () => {
    const f = fixture();
    delete f.manifest.reference_occurrences[0]!.reference_literal_span_id;
    const before = structuredClone({ plan: f.plan, manifest: f.manifest, registry: f.registry });
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_field_selection_literal_required",
      path: "/reference_selections/0/occurrence_id", details: expect.objectContaining({ next_tool: "resolve_document_reference",
        next_tool_arguments: { raw_reference: "第2.3条" }, transaction_applied: false,
        actual: expect.objectContaining({ reference_literal_span_ids: [], origin_span_candidates: [f.ids.origin, f.ids.literal] }),
        expected: expect.objectContaining({ model_selected_resolve_fields: ["origin_field", "target", "relation", "origin_span_id"] }) }) }));
    expect(result.draft).toEqual({});
    expect(result.changed_paths).toEqual([]);
    expect(result.derived_relations).toEqual([]);
    expect({ plan: f.plan, manifest: f.manifest, registry: f.registry }).toEqual(before);
  });

  test("a unique existing origin span routes to resolve without an unnecessary locate step", () => {
    const f = fixture();
    delete f.manifest.reference_occurrences[0]!.reference_literal_span_id;
    f.registry.spans = f.registry.spans.filter(span => span.span_id !== f.ids.literal);
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_field_selection_literal_required",
      details: expect.objectContaining({ next_tool: "resolve_document_reference", transaction_applied: false,
        next_tool_arguments: { raw_reference: "第2.3条", origin_span_id: f.ids.origin },
        expected: expect.objectContaining({ model_selected_resolve_fields: ["origin_field", "target", "relation"] }) }) }));
    expect(result.draft).toEqual({});
  });

  test("missing origin spans returns exact locate arguments without manufacturing a span", () => {
    const f = fixture();
    delete f.manifest.reference_occurrences[0]!.reference_literal_span_id;
    f.registry.spans = f.registry.spans.filter(span => span.evidence_id !== "origin");
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_field_selection_literal_required",
      details: expect.objectContaining({ next_tool: "locate_evidence_span", transaction_applied: false,
        next_tool_arguments: { evidence_id: "origin", quote: "第2.3条" } }) }));
    expect(result.draft).toEqual({});
  });

  test("an out-of-scope target rolls back the entire selection transaction", () => {
    const f = fixture();
    const before = structuredClone(f.plan);
    const selection = f.selection();
    selection.bindings.push(...f.selection("alarm", f.ids.unrelated).bindings);
    selection.origin_binding = { item_key: "clock", target_field: "note" };
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_source_invalid");
    expect(result.draft).toEqual({});
    expect(result.changed_paths).toEqual([]);
    expect(f.plan).toEqual(before);
  });

  test("does not relabel a referenced target as local origin context", () => {
    const f = fixture();
    const selection = f.selection();
    selection.bindings[0]!.local_context_fields[0]!.span_ids = [f.ids.method];
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_source_invalid");
    expect(result.draft).toEqual({});
  });

  test("refuses ambiguous legacy target contribution and leaves its draft intact", () => {
    const f = fixture();
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]));
    saved.items[0]!.fields.method.span_ids = [];
    const before = structuredClone(saved);
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [f.selection("clock", f.ids.alternative)]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_old_contribution_ambiguous");
    expect(result.issues[0]!.details).toMatchObject({
      write_mode: "full_records", writable_paths: ["/references/0", "/items/0"],
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: saved.references[0]!.key },
      record_reads: [
        { tool: "read_target_selectors", arguments: { collection: "references", key: saved.references[0]!.key } },
        { tool: "read_target_selectors", arguments: { collection: "items", key: "clock" } },
      ],
      save_tool: "stage_target_selector_draft", transaction_applied: false,
    });
    expect(result.draft).toEqual({});
    expect(saved).toEqual(before);
  });

  test("refuses a shared sampling route instead of approximating its branch dependencies", () => {
    const f = fixture();
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [f.selection()]));
    saved.references[0]!.destinations.push({ item_key: "clock", target_field: "sampling" });
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [f.selection()]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_complex_reference");
    expect(result.issues[0]!.details).toMatchObject({ write_mode: "full_records",
      writable_paths: ["/references/0", "/items/0"], next_tool: "read_target_selectors" });
    expect(result.draft).toEqual({});
  });

  test("does not rewrite an untouched receiver's component decision", () => {
    const f = fixture();
    const both = f.selection();
    both.bindings.push(...f.selection("alarm").bindings);
    both.origin_binding = { item_key: "clock", target_field: "note" };
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [both]));
    const update = f.selection();
    update.bindings[0]!.component_decision = "independent_item";
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [update]);
    expect(result.issues.map(issue => issue.code)).toContain("reference_field_selection_unselected_component_conflict");
    expect(result.draft).toEqual({});
  });

  test("retains an untouched receiver's authored component even when its legacy field uses a broader span", () => {
    const f = fixture();
    const both = f.selection();
    both.bindings.push(...f.selection("alarm").bindings);
    both.origin_binding = { item_key: "clock", target_field: "note" };
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [both]));
    saved.items[1]!.fields.method.span_ids = [f.ids.methodWhole];
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [f.selection("clock", f.ids.alternative)]);
    expect(result.issues).toEqual([]);
    expect(result.draft.items).toHaveLength(1);
    expect(result.draft.references![0]!.target_span_ids).toEqual([f.ids.method, f.ids.alternative]);
    expect(result.draft.references![0]!.component_dispositions).toContainEqual(expect.objectContaining({ component_span_ids: [f.ids.method], item_keys: ["alarm"] }));
    expect(saved.items[1]!.fields.method.span_ids).toEqual([f.ids.methodWhole]);
  });

  test("does not duplicate an inner literal inside an already selected complete local sentence", () => {
    const f = fixture();
    const selection = f.selection();
    selection.bindings[0]!.local_context_fields[0]!.span_ids.push(f.ids.literal);
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues).toEqual([]);
    expect(result.draft.items![0]!.fields.note.span_ids).toEqual([f.ids.origin]);
  });

  test("two bindings cannot silently overwrite one another's local context", () => {
    const f = fixture();
    const selection = f.selection();
    selection.bindings.push({ ...structuredClone(selection.bindings[0]!), target_field: "note", local_context_fields: [] });
    const before = structuredClone(f.plan);
    const result = projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [selection]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_field_selection_field_write_conflict",
      path: "/reference_selections/0/bindings/1" }));
    expect(result.draft).toEqual({});
    expect(f.plan).toEqual(before);
  });

  test("changing a shared reference action cannot silently change untouched receivers", () => {
    const f = fixture();
    const both = f.selection();
    both.bindings.push(...f.selection("alarm").bindings);
    both.origin_binding = { item_key: "clock", target_field: "note" };
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [both]));
    const update = f.selection();
    update.action = "conditional";
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [update]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_field_selection_unselected_action_conflict",
      path: "/reference_selections/0/action" }));
    expect(result.draft).toEqual({});
    expect(saved.references[0]!.action).toBe("adopt");
  });

  test("the author may change an action when explicitly selecting every existing receiver", () => {
    const f = fixture();
    const first = f.selection();
    const saved = apply(f.plan, projectReferenceFieldSelections(f.plan, f.manifest, f.registry, [first]));
    first.action = "conditional";
    const result = projectReferenceFieldSelections(saved, f.manifest, f.registry, [first]);
    expect(result.issues).toEqual([]);
    expect(result.draft.references![0]!.action).toBe("conditional");
  });
});
