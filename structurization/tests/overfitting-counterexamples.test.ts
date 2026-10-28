import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { prettyJson, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import {
  compileTargetSelectors as compilePersisted,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registerHtmlTableCellSpans,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import { validatePlanText } from "../src/validator.js";

interface SourceInput {
  id: string;
  text: string;
  locator?: string;
  table_fragment_id?: string;
  row_index?: number;
}

function manifestFor(sources: SourceInput[]): EvidenceManifest {
  const allText = sources.map((source) => source.text).join("\n");
  const targetId = "target:counterexample";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "job:counterexample",
    target_id: targetId,
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "counterexamples.md",
      sha256: sha256Text(allText),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: targetId,
      source_line_count: allText.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: allText.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "Counterexamples selected by exact source position only",
      selected_atom_ids: sources.map((source) => source.id),
      target_evidence_fragments: sources.map((source) => ({ atom_id: source.id, text: source.text })),
      candidates: [],
    },
    evidence: sources.map((source) => ({
      evidence_id: source.id,
      kind: "paragraph",
      role: "supporting_clause",
      locator: source.locator ?? `char:0-${source.text.length}`,
      text: source.text,
      text_sha256: sha256Text(source.text),
      requires_disposition: true,
      evidence_scope: "primary",
      ...(source.table_fragment_id ? { table_fragment_id: source.table_fragment_id } : {}),
      ...(source.row_index === undefined ? {} : { row_index: source.row_index }),
    })),
    table_fragments: sources.flatMap((source, index) => source.table_fragment_id ? [{
      fragment_id: source.table_fragment_id,
      source_order: index === 0 ? 20 : 10,
      title_candidate_evidence_ids: [],
      row_evidence_ids: [source.id],
      formal_row_evidence_ids: [source.id],
      columns: [],
    }] : []),
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`counterexample\0${allText}`),
  };
}

function register(
  manifest: EvidenceManifest,
  requests: Array<{ evidence_id: string; quote: string }>,
  htmlCells = false,
): { registry: SourceSpanRegistry; span: (evidenceId: string, quote: string) => string } {
  const sources: ImmutableTextSource[] = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  if (htmlCells) {
    registry = registerHtmlTableCellSpans(registry, sources).registry;
  }
  const ids = new Map<string, string>();
  for (const request of requests) {
    const source = sources.find((candidate) => candidate.evidence_id === request.evidence_id)!;
    const located = locateAndRegisterSourceQuote(registry, source, request.quote);
    registry = located.registry;
    ids.set(`${request.evidence_id}\0${request.quote}`, located.spans[0]!.span_id);
  }
  return {
    registry,
    span: (evidenceId, quote) => ids.get(`${evidenceId}\0${quote}`)!,
  };
}

function addItem(
  selectors: TargetSelectorPlan,
  input: {
    key: string;
    lot_key: string;
    name: string;
    criterion_span_id: string;
    name_span_id?: string;
    name_composition?: "verbatim" | "semantic_summary";
  },
): void {
  selectors.items.push({
    key: input.key,
    lot_key: input.lot_key,
    name: input.name,
    category: "一般项目",
    criterion_span_ids: [input.criterion_span_id],
    continuation_span_ids: [],
    fields: {
      name: {
        composition: input.name_composition ?? "semantic_summary",
        span_ids: [input.name_span_id ?? input.criterion_span_id],
        separator: "",
        reason: "夹具：Exact inspected business concept",
      },
      requirement: {
        composition: "verbatim",
        span_ids: [input.criterion_span_id],
        separator: "",
        reason: "夹具：Exact acceptance judgment",
      },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "夹具：No method in this case" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "夹具：No quantity in this case" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "夹具：No note in this case" },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "夹具：The counterexample does not infer a data type from wording",
    inspection_data_type_span_ids: [input.criterion_span_id],
    sampling: {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "夹具：No sampling assertion in this case",
      confidence: 1,
    },
    reason: "夹具：Independent judgment selected by source structure",
  });
}

function compiled(selectors: TargetSelectorPlan, registry: SourceSpanRegistry, manifest: EvidenceManifest) {
  return hydrateSemanticSourcePlan(compilePersisted(selectors, registry, manifest), manifest);
}

function oneItem(text: string, name: string, nameComposition: "verbatim" | "semantic_summary") {
  const evidenceId = "atom:one";
  const manifest = manifestFor([{ id: evidenceId, text }]);
  const registered = register(manifest, [{ evidence_id: evidenceId, quote: text }]);
  const full = registered.span(evidenceId, text);
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [full], reason: "夹具：One exact scope" });
  addItem(selectors, {
    key: "item",
    lot_key: "lot",
    name,
    criterion_span_id: full,
    name_span_id: full,
    name_composition: nameComposition,
  });
  return { manifest, registry: registered.registry, selectors };
}

describe("project-name overfitting counterexamples", () => {
  test("allows a concise exact prose business phrase as a verbatim name", () => {
    const fixture = oneItem("基层表面平整度", "基层表面平整度", "verbatim");
    const plan = compiled(fixture.selectors, fixture.registry, fixture.manifest);
    expect(validatePlanText(prettyJson(plan), fixture.manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("does not reject a concise name merely because it equals the concise requirement", () => {
    const fixture = oneItem("基层表面平整度", "基层表面平整度", "semantic_summary");
    const plan = compiled(fixture.selectors, fixture.registry, fixture.manifest);
    expect(validatePlanText(prettyJson(plan), fixture.manifest).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "inspection_name_not_short_form" }),
    ]));
  });

  test("allows an exact HTML table row noun phrase as a verbatim name", () => {
    const text = "<table><tr><td>检查对象</td><td>判定值</td></tr><tr><td>节点接触状态</td><td>符合约定</td></tr></table>";
    const evidenceId = "atom:table";
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: "节点接触状态" },
      { evidence_id: evidenceId, quote: "符合约定" },
      { evidence_id: evidenceId, quote: "判定值" },
    ], true);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, text)], reason: "夹具：Exact table scope" });
    addItem(selectors, {
      key: "row",
      lot_key: "lot",
      name: "节点接触状态",
      criterion_span_id: registered.span(evidenceId, "符合约定"),
      name_span_id: registered.span(evidenceId, "节点接触状态"),
      name_composition: "verbatim",
    });
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "table",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[registered.span(evidenceId, "节点接触状态")]],
        column_path_span_ids: [[registered.span(evidenceId, "判定值")]],
        unit_span_ids: [], condition_span_ids: [],
        allowed_value_span_ids: [registered.span(evidenceId, "符合约定")],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "夹具：The exact data row is independently judged",
    };
    expect(() => compiled(selectors, registered.registry, manifest)).not.toThrow();
  });

  test("rejects a semantic-summary name that structurally mixes other display roles", () => {
    const requirement = "接触状态符合约定";
    const quantity = "抽取若干单元";
    const method = "使用记录仪复核";
    const note = "异常时另行处置";
    const text = [requirement, quantity, method, note].join("；");
    const evidenceId = "atom:mixed-name";
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: requirement },
      { evidence_id: evidenceId, quote: quantity },
      { evidence_id: evidenceId, quote: method },
      { evidence_id: evidenceId, quote: note },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, text)], reason: "夹具：One exact scope" });
    addItem(selectors, {
      key: "item",
      lot_key: "lot",
      name: text,
      criterion_span_id: registered.span(evidenceId, requirement),
      name_span_id: registered.span(evidenceId, text),
      name_composition: "semantic_summary",
    });
    selectors.items[0]!.fields.quantity = { composition: "verbatim", span_ids: [registered.span(evidenceId, quantity)], separator: "", reason: "夹具：Exact quantity" };
    selectors.items[0]!.fields.method = { composition: "verbatim", span_ids: [registered.span(evidenceId, method)], separator: "", reason: "夹具：Exact method" };
    selectors.items[0]!.fields.note = { composition: "verbatim", span_ids: [registered.span(evidenceId, note)], separator: "", reason: "夹具：Exact note" };
    expect(() => compiled(selectors, registered.registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_name_short_form_required" }),
      ]),
    }) as TargetSelectorCompileError);
  });
});

describe("GB50202 scalar overlap counterexample", () => {
  test("allows an exact quantity subspan inside a complete requirement sentence", () => {
    const requirement = "灌注桩施工前应进行试成孔，试成孔数量应根据工程规模和场地地层特点确定，且不宜少于2个。";
    const quantity = "试成孔数量应根据工程规模和场地地层特点确定，且不宜少于2个";
    const evidenceId = "atom:gb50202-complete-requirement";
    const manifest = manifestFor([{ id: evidenceId, text: requirement }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: requirement },
      { evidence_id: evidenceId, quote: quantity },
    ]);
    const full = registered.span(evidenceId, requirement);
    const exactQuantity = registered.span(evidenceId, quantity);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [full], reason: "夹具：One exact scope" });
    addItem(selectors, {
      key: "item",
      lot_key: "lot",
      name: "试成孔",
      criterion_span_id: full,
      name_span_id: full,
      name_composition: "semantic_summary",
    });
    selectors.items[0]!.fields.quantity = {
      composition: "verbatim",
      span_ids: [exactQuantity],
      separator: "",
      reason: "夹具：Exact quantity subspan",
    };
    selectors.items[0]!.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [exactQuantity],
      script_span_ids: [full],
      condition_span_ids: [],
      reason: "夹具：The complete requirement contains the sampling action and quantity",
      confidence: 1,
    };
    expect(() => compiled(selectors, registered.registry, manifest)).not.toThrow();
  });
});

describe("referenced-table role counterexamples", () => {
  test("rejects one typed table-title span masquerading as both a value and a method", () => {
    const text = "<table><tr><td>Matrix Alpha</td></tr><tr><td>Member Delta</td><td>Value Sigma</td><td>Procedure Omega</td></tr></table>";
    const evidenceId = "atom:typed-table-roles";
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: "Matrix Alpha" },
      { evidence_id: evidenceId, quote: "Member Delta" },
    ], true);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, text)], reason: "夹具：One table scope" });
    addItem(selectors, {
      key: "row",
      lot_key: "lot",
      name: "Member Delta",
      criterion_span_id: registered.span(evidenceId, "Member Delta"),
    });
    const title = registered.span(evidenceId, "Matrix Alpha");
    selectors.items[0]!.fields.method = { composition: "verbatim", span_ids: [title], separator: "", reason: "夹具：Deliberately polluted typed role" };
    selectors.items[0]!.table = {
      source_kind: "reference",
      table_key: "matrix",
      properties: {
        table_no_span_ids: [],
        table_title_span_ids: [title],
        applicability_span_ids: [],
        row_path_span_ids: [[registered.span(evidenceId, "Member Delta")]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [title],
        inspection_method_span_ids: [title],
      },
      reference_span_ids: [title],
      reason: "夹具：The typed title role must not become a leaf value or procedure",
    };
    expect(() => compiled(selectors, registered.registry, manifest)).toThrow();
  });

  test("allows a genuine table-level compliance judgment as reference-only provenance", () => {
    const judgment = "Assembly group conforms as a whole to the referenced matrix.";
    const literal = "referenced matrix";
    const caption = "Matrix Alpha";
    const text = `${judgment}\n${caption}`;
    const evidenceId = "atom:overall-table-judgment";
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: judgment },
      { evidence_id: evidenceId, quote: literal },
      { evidence_id: evidenceId, quote: caption },
    ]);
    manifest.reference_occurrences.push({
      occurrence_id: "reference:overall-matrix",
      origin_evidence_id: evidenceId,
      reference_literal_span_id: registered.span(evidenceId, literal),
      reference_literal: { evidence_id: evidenceId, start: judgment.indexOf(literal), end: judgment.indexOf(literal) + literal.length },
      origin_fields: ["requirement"], raw_reference: literal,
      target_evidence_ids: [evidenceId], required: true, status: "resolved", depth: 1,
      path: ["table:matrix-alpha"], reference_kind: "table", target_table_id: "matrix-alpha",
    });
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, text)], reason: "夹具：One exact scope" });
    addItem(selectors, { key: "overall", lot_key: "lot", name: "Overall conformity", criterion_span_id: registered.span(evidenceId, judgment) });
    selectors.references.push({
      key: "overall-reference",
      occurrence_id: "reference:overall-matrix",
      origin_binding: { item_key: "overall", target_field: "requirement" },
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "整体合规判断仅引用验收要求，不导入方法或抽样。" },
      anchor_span_ids: [registered.span(evidenceId, literal)],
      target_span_ids: [registered.span(evidenceId, caption)],
      action: "mention",
      application_mode: "reference_only",
      // Reference-only is the application mode; its destination remains a
      // real authoring field and must not overwrite that field's local text.
      destinations: [{ item_key: "overall", target_field: "requirement" }],
      reason: "夹具：The matrix supports one explicitly stated overall judgment",
    });
    const plan = compiled(selectors, registered.registry, manifest);
    expect(plan.acceptance_items[0]).toMatchObject({
      requirement: judgment,
      method: "",
      quantity: "",
      note: "",
    });
  });

  test("rejects a reference-only anchor appended to a substantive visible requirement", () => {
    const judgment = "Surface condition conforms to the specified acceptance value.";
    const anchor = "Matrix Alpha";
    const target = "Member Delta has the allowed value Sigma.";
    const text = `${judgment}\n${anchor}\n${target}`;
    const evidenceId = "atom:reference-anchor-display-leak";
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: judgment },
      { evidence_id: evidenceId, quote: anchor },
      { evidence_id: evidenceId, quote: target },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, text)], reason: "夹具：One exact scope" });
    addItem(selectors, { key: "item", lot_key: "lot", name: "Surface condition", criterion_span_id: registered.span(evidenceId, judgment) });
    selectors.items[0]!.fields.requirement = {
      composition: "verbatim",
      span_ids: [registered.span(evidenceId, judgment), registered.span(evidenceId, anchor)],
      separator: " ",
      reason: "夹具：Deliberately appends a provenance-only anchor to a substantive display value",
    };
    selectors.references.push({
      key: "reference",
      anchor_span_ids: [registered.span(evidenceId, anchor)],
      target_span_ids: [registered.span(evidenceId, target)],
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "夹具：The anchor must remain provenance rather than display content",
    });
    expect(() => compiled(selectors, registered.registry, manifest)).toThrow();
  });
});

describe("source-order counterexamples", () => {
  test("sorts reverse model submission by exact character position", () => {
    const evidenceId = "atom:ordered";
    const first = "第一判断";
    const second = "第二判断";
    const manifest = manifestFor([{ id: evidenceId, text: `${first}\n${second}`, locator: "char:400-420" }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: `${first}\n${second}` },
      { evidence_id: evidenceId, quote: first },
      { evidence_id: evidenceId, quote: second },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span(evidenceId, `${first}\n${second}`)], reason: "夹具：One scope" });
    addItem(selectors, { key: "second", lot_key: "lot", name: "第二项 Second", criterion_span_id: registered.span(evidenceId, second) });
    addItem(selectors, { key: "first", lot_key: "lot", name: "第一项 First", criterion_span_id: registered.span(evidenceId, first) });
    expect(compiled(selectors, registered.registry, manifest).acceptance_items.map((item) => item.name)).toEqual(["第一项 First", "第二项 Second"]);
  });

  test("uses table fragment source_order rather than evidence-array order", () => {
    const manifest = manifestFor([
      { id: "atom:later", text: "后行判断", locator: "table/later", table_fragment_id: "fragment:later", row_index: 2 },
      { id: "atom:earlier", text: "先行判断", locator: "table/earlier", table_fragment_id: "fragment:earlier", row_index: 1 },
    ]);
    const registered = register(manifest, [
      { evidence_id: "atom:later", quote: "后行判断" },
      { evidence_id: "atom:earlier", quote: "先行判断" },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span("atom:later", "后行判断")], reason: "夹具：Table scope" });
    addItem(selectors, { key: "later", lot_key: "lot", name: "后行项 Later", criterion_span_id: registered.span("atom:later", "后行判断") });
    addItem(selectors, { key: "earlier", lot_key: "lot", name: "先行项 Earlier", criterion_span_id: registered.span("atom:earlier", "先行判断") });
    expect(compiled(selectors, registered.registry, manifest).acceptance_items.map((item) => item.name)).toEqual(["先行项 Earlier", "后行项 Later"]);
  });

  test("keeps fallback ordering stable when character locators are absent", () => {
    const manifest = manifestFor([
      { id: "atom:a", text: "判断甲", locator: "opaque:a" },
      { id: "atom:b", text: "判断乙", locator: "opaque:b" },
    ]);
    const registered = register(manifest, [
      { evidence_id: "atom:a", quote: "判断甲" },
      { evidence_id: "atom:b", quote: "判断乙" },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [registered.span("atom:a", "判断甲")], reason: "夹具：Fallback scope" });
    addItem(selectors, { key: "b", lot_key: "lot", name: "B", criterion_span_id: registered.span("atom:b", "判断乙") });
    addItem(selectors, { key: "a", lot_key: "lot", name: "A", criterion_span_id: registered.span("atom:a", "判断甲") });
    const first = compiled(selectors, registered.registry, manifest).acceptance_items.map((item) => item.item_id);
    const second = compiled(selectors, registered.registry, manifest).acceptance_items.map((item) => item.item_id);
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.stringContaining("item:"),
      expect.stringContaining("item:"),
    ]);
  });

  test("does not interleave multiple lots in materialized output", () => {
    const evidenceId = "atom:lots";
    const a1 = "甲组首项";
    const b1 = "乙组首项";
    const a2 = "甲组次项";
    const text = [a1, b1, a2].join("\n");
    const manifest = manifestFor([{ id: evidenceId, text }]);
    const registered = register(manifest, [
      { evidence_id: evidenceId, quote: text },
      { evidence_id: evidenceId, quote: a1 },
      { evidence_id: evidenceId, quote: b1 },
      { evidence_id: evidenceId, quote: a2 },
    ]);
    const selectors = initialTargetSelectorPlan(manifest);
    const full = registered.span(evidenceId, text);
    selectors.lots.push(
      { key: "lot-a", name: "A", scope_span_ids: [full], reason: "夹具：First lot" },
      { key: "lot-b", name: "B", scope_span_ids: [full], reason: "夹具：Second lot" },
    );
    addItem(selectors, { key: "a2", lot_key: "lot-a", name: "A2", criterion_span_id: registered.span(evidenceId, a2) });
    addItem(selectors, { key: "b1", lot_key: "lot-b", name: "B1", criterion_span_id: registered.span(evidenceId, b1) });
    addItem(selectors, { key: "a1", lot_key: "lot-a", name: "A1", criterion_span_id: registered.span(evidenceId, a1) });
    const plan = compiled(selectors, registered.registry, manifest);
    const validation = validatePlanText(prettyJson(plan), manifest);
    expect(validation.ok).toBe(true);
    const result = materialize(plan, manifest, validation.fingerprint!).result;
    expect(result.inspection_lots.map((lot) => lot.items.map((item) => item.name))).toEqual([
      ["A1", "A2"],
      ["B1"],
    ]);
  });

  test("compiler invariants associate reordered selectors by stable item ID", () => {
    const fixture = oneItem("独立判断", "判断 Judgment", "semantic_summary");
    const second = structuredClone(fixture.selectors.items[0]!);
    second.key = "second";
    second.name = "第二项 Second";
    fixture.selectors.items.push(second);
    const plan = compiled(fixture.selectors, fixture.registry, fixture.manifest);
    const reversed = { ...fixture.selectors, items: [...fixture.selectors.items].reverse() };
    expect(checkTargetCompilerInvariants(reversed, plan, fixture.manifest)).toEqual([]);
  });
});

const archiveTargetsRoot = join(
  process.cwd(),
  "data", "job-archive", "20260812-161216-c005-pre-fresh-20260814",
  "pi-agent", "jobs", "20260812-161216-c005", "targets",
);

describe("read-only real compatibility scan", () => {
  test.runIf(existsSync(archiveTargetsRoot))("compiles all 28 latest archived selectors and emits current issues", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const targetDirectory of (await readdir(archiveTargetsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const revisionsRoot = join(archiveTargetsRoot, targetDirectory.name, "revisions");
      const revision = (await readdir(revisionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .at(-1)!;
      const root = join(revisionsRoot, revision);
      const [selectors, registry, manifest] = await Promise.all([
        readFile(join(root, "target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
        readFile(join(root, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
        readFile(join(root, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
      ]);
      try {
        compilePersisted(selectors, registry, manifest);
        rows.push({ target_id: manifest.target_id, revision, compile_ok: true, issues: [] });
      } catch (error) {
        if (!(error instanceof TargetSelectorCompileError)) throw error;
        const spans = new Map(registry.spans.map((span) => [span.span_id, span]));
        const evidence = new Map(manifest.evidence.map((record) => [record.evidence_id, record.text]));
        rows.push({
          target_id: manifest.target_id,
          revision,
          compile_ok: false,
          issues: error.issues.map((issue) => {
            const offending = (issue.details as { offending_binding?: { span_id?: string } } | undefined)?.offending_binding;
            const span = offending?.span_id ? spans.get(offending.span_id) : undefined;
            return {
              code: issue.code,
              path: issue.path,
              role: issue.path.replace(/^.*\/fields\//, "field:").replace(/\/span_ids.*$/, "")
                .replace(/^.*\/sampling\//, "sampling:").replace(/^\/items\/\d+$/, "item"),
              span_id: offending?.span_id ?? "",
              span_text: span ? evidence.get(span.evidence_id)?.slice(span.start, span.end) ?? "" : "",
              details: issue.details,
            };
          }),
        });
      }
    }
    rows.sort((left, right) => String(left.target_id).localeCompare(String(right.target_id)));
    console.info(`OVERFITTING_ARCHIVE_SCAN=${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(28);
  });
});
