import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:scalar-interval-direction";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "scalar-interval-direction-job",
    target_id: "scalar-interval-direction-target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "scalar-interval-direction-target",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "全文语义选择",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`scalar-interval-direction\0${text}`),
  };
}

function registerQuotes(
  manifest: EvidenceManifest,
  quotes: string[],
): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  const record = manifest.evidence[0]!;
  const source: ImmutableTextSource = {
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  };
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
  const ids = new Map<string, string>();
  for (const quote of quotes) {
    const located = locateAndRegisterSourceQuote(registry, source, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function addItem(
  selectors: TargetSelectorPlan,
  input: {
    key: string;
    criterion: string;
    requirement?: string;
    method?: string;
    quantity: string;
    script?: string;
  },
): void {
  selectors.items.push({
    key: input.key,
    lot_key: "lot",
    name: `${input.key}验收`,
    category: "主控项目",
    criterion_span_ids: [input.criterion],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [input.criterion], separator: "", reason: "验收对象" },
      requirement: input.requirement
        ? { composition: "verbatim", span_ids: [input.requirement], separator: "", reason: "验收要求" }
        : { composition: "not_applicable", span_ids: [], separator: "", reason: "无独立要求" },
      method: input.method
        ? { composition: "verbatim", span_ids: [input.method], separator: "", reason: "检验方法" }
        : { composition: "not_applicable", span_ids: [], separator: "", reason: "无独立方法" },
      quantity: { composition: "verbatim", span_ids: [input.quantity], separator: "", reason: "检查数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "counting",
    inspection_data_type_reason: "形成检查结果",
    inspection_data_type_span_ids: [input.criterion],
    sampling: {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [input.quantity],
      script_span_ids: [input.script ?? input.quantity],
      condition_span_ids: [],
      reason: "项内明确抽样",
      confidence: 1,
    },
    reason: "独立验收判断",
  });
}

function selectorsFor(manifest: EvidenceManifest, fullSpanId: string): TargetSelectorPlan {
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项范围" });
  return selectors;
}

describe("scalar interval direction counterexamples", () => {
  test("rejects a quantity interval that crosses a typed method boundary", () => {
    const criterion = "构件应符合要求。";
    const method = "检验方法:观察检查。检查数";
    const quantity = "检查数量:抽查五件。";
    const text = `${criterion}\n检验方法:观察检查。${quantity}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, method, quantity]);
    const fullSpanId = registered.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const selectors = selectorsFor(manifest, fullSpanId);
    addItem(selectors, {
      key: "item",
      criterion: registered.ids.get(criterion)!,
      requirement: registered.ids.get(criterion)!,
      method: registered.ids.get(method)!,
      quantity: registered.ids.get(quantity)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_scalar_span_crosses_typed_role_boundary" }),
        ]),
      }),
    );
  });

  test("rejects a quantity interval that crosses a sampling script boundary", () => {
    const criterion = "构件应符合要求。";
    const quantity = "前置片段。检查数量:抽查五件。";
    const script = "检查数量:抽查五件。下一项目。";
    const text = `${criterion}\n${quantity}下一项目。`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, script]);
    const fullSpanId = registered.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const selectors = selectorsFor(manifest, fullSpanId);
    addItem(selectors, {
      key: "item",
      criterion: registered.ids.get(criterion)!,
      requirement: registered.ids.get(criterion)!,
      quantity: registered.ids.get(quantity)!,
      script: registered.ids.get(script)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_scalar_span_crosses_typed_role_boundary" }),
        ]),
      }),
    );
  });

  test("rejects a quantity interval that strictly contains a sampling script", () => {
    const criterion = "构件应符合要求。";
    const quantity = "检查数量:抽查五件，并记录复核结果。";
    const script = "抽查五件";
    const text = `${criterion}\n${quantity}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, script]);
    const fullSpanId = registered.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const selectors = selectorsFor(manifest, fullSpanId);
    addItem(selectors, {
      key: "item",
      criterion: registered.ids.get(criterion)!,
      requirement: registered.ids.get(criterion)!,
      quantity: registered.ids.get(quantity)!,
      script: registered.ids.get(script)!,
    });

    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
      throw new Error("expected a scalar role conflation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_scalar_span_conflates_item_roles") as any;
      expect(issue).toMatchObject({
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "replace_scalar_bindings_with_exact_role_spans",
          actual: expect.objectContaining({ item_key: "item" }),
          candidate_spans: expect.arrayContaining([
            expect.objectContaining({ span_id: registered.ids.get(script), exact_fragment: script }),
          ]),
          candidate_read_tools: expect.arrayContaining(["read_target_selectors", "open_evidence", "locate_evidence_span"]),
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          writable_paths: expect.arrayContaining(["/items/0/fields/quantity/span_ids/0"]),
          how_to_pass: expect.stringContaining("candidate_spans"),
        },
      });
    }
  });

  test("rejects a quantity interval that cuts into another item boundary", () => {
    const firstCriterion = "首项构件应符合要求。";
    const firstQuantity = "检查数量:抽查五件。后一";
    const secondCriterion = "后一项目应符合要求。";
    const secondQuantity = "检查数量:全数检查。";
    const text = `${firstCriterion}\n${firstQuantity.slice(0, -2)}\n${secondCriterion}\n${secondQuantity}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [firstCriterion, firstQuantity, secondCriterion, secondQuantity]);
    const fullSpanId = registered.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const selectors = selectorsFor(manifest, fullSpanId);
    addItem(selectors, {
      key: "first",
      criterion: registered.ids.get(firstCriterion)!,
      requirement: registered.ids.get(firstCriterion)!,
      quantity: registered.ids.get(firstQuantity)!,
    });
    addItem(selectors, {
      key: "second",
      criterion: registered.ids.get(secondCriterion)!,
      requirement: registered.ids.get(secondCriterion)!,
      quantity: registered.ids.get(secondQuantity)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_scalar_span_crosses_typed_role_boundary" }),
        ]),
      }),
    );
  });

  test("allows a complete requirement and sampling script to contain an exact quantity", () => {
    const requirement = "构件应符合要求，检查数量:抽查五件。";
    const quantity = "检查数量:抽查五件。";
    const method = "检验方法:观察检查。";
    const text = `${requirement}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [requirement, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const selectors = selectorsFor(manifest, fullSpanId);
    addItem(selectors, {
      key: "item",
      criterion: registered.ids.get(requirement)!,
      requirement: registered.ids.get(requirement)!,
      method: registered.ids.get(method)!,
      quantity: registered.ids.get(quantity)!,
      script: registered.ids.get(requirement)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });
});
