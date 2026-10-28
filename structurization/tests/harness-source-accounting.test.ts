import { expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import { resolvedReferenceComponentCoverageIssues } from "../src/reference-component-coverage.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { initialTargetSelectorPlan, tableExpansionState } from "../src/target-selector-compiler.js";
import { itemRecord } from "./selector-stage-fixture.js";
import { tableRowRepresentationIds } from "../src/table-row-representations.js";

function fixture() {
  const record = (id: string, text: string, locator: string, extra = {}) => ({ evidence_id: id, text,
    text_sha256: sha256Text(text), locator, kind: "paragraph" as const, role: "context" as const, requires_disposition: false, ...extra });
  const evidence: EvidenceManifest["evidence"] = [
    record("origin", "虚构测温匣按附录R的相关规定检查。", "line:1"),
    record("heading", "附录R 虚构检查", "line:10"),
    record("raw", "<tr><td colspan=\"2\">外壳</td><td>17</td></tr>", "line:12/table-row:2", {
      kind: "table_row", table_id: "R.2", row_index: 2, cells: ["外壳", "17"], evidence_scope: "reference" }),
    record("normal", "外壳 | 外壳 | 17", "line:12/table:R.2/row:2", {
      kind: "table_row", table_id: "R.2", row_index: 2, cells: ["外壳", "外壳", "17"], table_text_format: "cell_values_v1", evidence_scope: "reference",
      cell_geometry: [
        { cell_id: "c1", row: 1, column: 0, colspan: 2, rowspan: 1, text: "外壳" },
        { cell_id: "c1", row: 1, column: 0, colspan: 2, rowspan: 1, text: "外壳" },
        { cell_id: "c2", row: 1, column: 2, colspan: 1, rowspan: 1, text: "17" },
      ] }),
  ];
  const registry = registryWithFullSourceSpans("fictional-version", evidence.map(e => ({ source_id: e.evidence_id, evidence_id: e.evidence_id, text: e.text })));
  const span = (id: string) => registry.spans.find(s => s.evidence_id === id)!;
  const manifest = { schema_version: "fixture", job_id: "fictional-job", target_id: "fictional-target", source: { sha256: "fictional-version" },
    evidence, reference_occurrences: [{ occurrence_id: "ref:R", reference_kind: "clause", origin_evidence_id: "origin", origin_fields: ["requirement"],
      raw_reference: "附录R", target_evidence_ids: ["heading", "raw", "normal"], status: "resolved", required: true, depth: 1, path: [],
      target_address: { source_id: "fictional-version", locator_kind: "appendix", locator: "R" } }], evidence_fingerprint: "fixture" } as unknown as EvidenceManifest;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.references = [{ key: "reference-R", occurrence_id: "ref:R", anchor_span_ids: [span("origin").span_id], target_span_ids: [span("normal").span_id],
    action: "adopt", application_mode: "reference_only", import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "模型选择已有来源。" },
    destinations: [{ item_key: "shell", target_field: "requirement" }], reason: "中性来源关系。",
    component_dispositions: [{ component_span_ids: [span("heading").span_id], decision: "not_applicable", item_keys: [], reason: "模型已明确判断为附录标题。" }] }];
  const check = () => resolvedReferenceComponentCoverageIssues(selectors, manifest, registry, new Map([["shell", [span("normal")]]]));
  return { manifest, registry, selectors, span, check };
}

test("a stored exclusion missing its selection is diagnosed as synchronization, not an absent business decision", () => {
  const f = fixture(), before = structuredClone(f.selectors);
  const issues = f.check();
  expect(issues).toContainEqual(expect.objectContaining({ code: "selector_reference_exclusion_not_selected", details: expect.objectContaining({
    reference_key: "reference-R", save_tool: "stage_reference_component_decisions", declared_component_dispositions: f.selectors.references[0]!.component_dispositions,
  }) }));
  expect(issues.find(i => i.code === "selector_resolved_reference_components_unaccounted")).toBeUndefined();
  expect(f.selectors).toEqual(before);
});

test("the same physical table row has one accounting identity without erasing either immutable representation", () => {
  const f = fixture();
  f.selectors.references[0]!.target_span_ids.push(f.span("heading").span_id);
  const before = structuredClone({ manifest: f.manifest, selectors: f.selectors });
  expect(f.check()).toEqual([]);
  expect({ manifest: f.manifest, selectors: f.selectors }).toEqual(before);
});

test.each(["different-line", "different-cells", "ambiguous-representation"])("%s cannot borrow the accounting identity of another source", mode => {
  const f = fixture();
  f.selectors.references[0]!.target_span_ids.push(f.span("heading").span_id);
  const normal = f.manifest.evidence.find(e => e.evidence_id === "normal")!;
  if (mode === "different-line") normal.locator = "line:18/table:R.2/row:2";
  if (mode === "different-cells") normal.cell_geometry![2]!.text = "19";
  if (mode === "ambiguous-representation") {
    f.manifest.evidence.push({ ...structuredClone(normal), evidence_id: "normal-copy" });
    f.manifest.reference_occurrences[0]!.target_evidence_ids.push("normal-copy");
  }
  expect(f.check()).toContainEqual(expect.objectContaining({ code: "selector_resolved_reference_components_unaccounted", details: expect.objectContaining({ evidence_ids: expect.arrayContaining(["raw"]) }) }));
});

test("physical row identity requires both representations inside the one occurrence inventory", () => {
  const f = fixture();
  const raw = f.manifest.evidence.find(e => e.evidence_id === "raw")!;
  const normal = f.manifest.evidence.find(e => e.evidence_id === "normal")!;
  expect(tableRowRepresentationIds([raw])).toEqual(new Map());
  expect(tableRowRepresentationIds([normal])).toEqual(new Map());
  const malformed = structuredClone(normal); delete malformed.cell_geometry;
  expect(tableRowRepresentationIds([raw, malformed])).toEqual(new Map());
  // Inherited rowspan cells are not physical cells of the current raw <tr>.
  normal.cell_geometry!.unshift({ cell_id: "inherited", row: 0, column: -1, colspan: 1, rowspan: 2, text: "上行材料" });
  normal.cells!.unshift("上行材料");
  expect(tableRowRepresentationIds([raw, normal]).get("raw")).toBe("normal");
});

test("only selected present shared sampling components own table rows; unused branches stay pending", () => {
  const f = fixture();
  const rows = [1, 2].map(n => ({ ...f.manifest.evidence[0]!, evidence_id: `sample:${n}`, locator: `line:21/table:S.1/row:${n}`, text: `区间${n} | ${n + 3}件`,
    kind: "table_row" as const, evidence_scope: "primary" as const, table_id: "S.1", table_row_kind: "data" as const,
    columns: ["批容量", "抽取件数"], cells: [`区间${n}`, `${n + 3}件`] }));
  f.manifest.evidence.push(...rows);
  const reg = registryWithFullSourceSpans("fictional-version", f.manifest.evidence.map(e => ({ source_id: e.evidence_id, evidence_id: e.evidence_id, text: e.text })));
  const ids = rows.map(e => reg.spans.find(s => s.evidence_id === e.evidence_id)!.span_id);
  f.selectors.items = [itemRecord("sample-owner", "虚构连接完整性", "主控项目", f.span("origin").span_id, "中性模型作者决定。")];
  const item = f.selectors.items[0]!;
  item.sampling = { status: "reference", rule_key: "shared", branch_keys: ["small"], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "按实际容量选分支。", confidence: 1 };
  f.selectors.sampling_rules = [{ key: "shared", complete_span_ids: ids, components: [], reason: "虚构抽样规则。", branches: [
    { key: "small", applies_to_category: "all_items", reason: "已选择的分支。", components: [{ role: "quantity", disposition: "present", span_ids: [ids[0]!], reason: "模型选择的真实数量。" }] },
    { key: "large", applies_to_category: "all_items", reason: "未选择分支。", components: [{ role: "quantity", disposition: "present", span_ids: [ids[1]!], reason: "另一容量范围。" }] },
  ] }];
  const before = structuredClone(f.selectors), state = tableExpansionState(f.manifest, reg, f.selectors);
  expect(state.work_packages[0]!.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ evidence_id: "sample:1", disposition: "item", item_keys: ["sample-owner"] }),
    expect.objectContaining({ evidence_id: "sample:2", disposition: "pending", item_keys: [] }),
  ]));
  expect(state.issues.find(i => i.code === "selector_table_expansion_obligations_pending")!.details!.writable_paths).toContain("/sampling_rules");
  expect(f.selectors).toEqual(before);
  f.selectors.items[0]!.sampling.branch_keys = [];
  expect(tableExpansionState(f.manifest, reg, f.selectors).work_packages[0]!.rows.every(r => r.disposition === "pending")).toBe(true);
  item.sampling.branch_keys = ["unknown"];
  expect(tableExpansionState(f.manifest, reg, f.selectors).work_packages[0]!.rows.every(r => r.disposition === "pending")).toBe(true);
  item.sampling.branch_keys = ["small"];
  f.selectors.sampling_rules[0]!.branches[0]!.applies_to_category = "一般项目";
  expect(tableExpansionState(f.manifest, reg, f.selectors).work_packages[0]!.rows.every(r => r.disposition === "pending")).toBe(true);
});
