import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { registerSourceSpan, registryWithFullSourceSpans } from "../src/source-span-registry.js";
import {
  compileTargetSelectors, initialTargetSelectorPlan, tableExpansionState, type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";

function fixture(sameProperty = false) {
  const records: EvidenceManifest["evidence"] = [
    ["fictional:row:a", "虚构尺寸甲", "5"],
    ["fictional:row:b", sameProperty ? "虚构尺寸甲" : "虚构尺寸乙", "7"],
  ].map(([evidenceId, name, value], index) => {
    const cells = [name!, value!, "mm"];
    const text = cells.join(" | ");
    return { evidence_id: evidenceId!, kind: "table_row", role: "formal_table_row", locator: "row:" + (index + 1),
      text, text_sha256: sha256Text(text), requires_disposition: true, evidence_scope: "primary",
      table_id: "XQ.1", table_row_kind: "data", columns: ["检查项目", "允许值", "单位"], cells };
  });
  const markdown = records.map(record => record.text).join("\n");
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "fictional-unit-job", target_id: "fictional-unit-target",
    source: { adapter: "document-domain-agent/v1", file_name: "fictional-unit.md", sha256: sha256Text(markdown),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "fictional-unit-target",
      source_line_count: 2, selected_start_line: 1, selected_end_exclusive_line: 3,
      selected_heading: "虚构表格", selection_reason: "中性共享单位回归", selected_atom_ids: records.map(record => record.evidence_id),
      target_evidence_fragments: records.map(record => ({ atom_id: record.evidence_id, text: record.text })), candidates: [] },
    evidence: records, table_fragments: [], reference_occurrences: [], evidence_fingerprint: sha256Text(markdown),
  };
  const sources = records.map(record => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const spans = sources.map((source, index) => {
    const ids = records[index]!.cells!.map(quote => {
      const start = source.text.indexOf(quote);
      const registered = registerSourceSpan(registry, source, start, start + quote.length);
      registry = registered.registry;
      return registered.span.span_id;
    });
    return { name: ids[0]!, value: ids[1]!, unit: ids[2]! };
  });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "虚构表格", scope_span_ids: spans.map(row => row.name), reason: "两行范围" });
  const emptyField = () => ({ composition: "not_applicable" as const, span_ids: [], separator: "" as const, reason: "原文未声明" });
  selectors.items = spans.map((row, index): TargetSelectorPlan["items"][number] => ({
    key: "item:" + index, lot_key: "lot", name: records[index]!.cells![0]!, category: "一般项目",
    criterion_span_ids: [row.value], continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [row.name], separator: "", reason: "独立项目名称" },
      requirement: { composition: "verbatim", span_ids: [row.value], separator: "", reason: "本行允许值" },
      method: emptyField(), quantity: emptyField(), note: emptyField(),
    },
    table: { source_kind: "direct", table_key: "XQ.1", reference_span_ids: [], reason: "本行表格判据",
      properties: { table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[row.name]], column_path_span_ids: [], unit_span_ids: [row.unit], condition_span_ids: [],
        allowed_value_span_ids: [row.value], inspection_method_span_ids: [] } },
    inspection_data_type: "measurement", inspection_data_type_reason: "虚构量测值", inspection_data_type_span_ids: [row.value],
    sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [],
      condition_span_ids: [], reason: "原文未声明抽样", confidence: 1 }, reason: "独立属性逐行保留",
  }));
  selectors.items[1]!.table!.properties.unit_span_ids = [spans[0]!.unit];
  return { manifest, registry, selectors, spans };
}

function mergedIssue(value: ReturnType<typeof tableExpansionState>) {
  return value.issues.find(issue => issue.code === "selector_table_distinct_core_properties_merged");
}

describe("shared unit provenance does not own an independent table property", () => {
  test.each(["单位工程名称", "施工单位", "建设单位 / 验收依据", "单位负责人"])(
    "administrative header %s is not a measurement-unit column", label => {
      const { manifest, registry, selectors, spans } = fixture(true);
      // Fictional rows share one property; their different values must not become different properties.
      for (const record of manifest.evidence) record.columns![0] = label;
      selectors.items[0]!.criterion_span_ids.push(spans[1]!.value);
      const result = tableExpansionState(manifest, registry, selectors);
      expect(result.work_packages[0]!.rows.map(row => row.unit)).toEqual(["mm", "mm"]);
      expect(result.work_packages[0]!.rows.map(row => row.parent_property)).toEqual(["虚构尺寸甲", "虚构尺寸甲"]);
      expect(mergedIssue(result)).toBeUndefined();
    },
  );

  test.each(["单位", "计量单位", "单位（mm）"])("actual unit header %s retains independent-property protection", label => {
    const { manifest, registry, selectors, spans } = fixture();
    for (const record of manifest.evidence) record.columns![2] = label;
    selectors.items[0]!.criterion_span_ids.push(spans[1]!.value);
    const result = tableExpansionState(manifest, registry, selectors);
    expect(result.work_packages[0]!.rows.map(row => row.unit)).toEqual(["mm", "mm"]);
    expect(mergedIssue(result)).toMatchObject({ details: { core_properties: ["虚构尺寸甲", "虚构尺寸乙"] } });
  });

  test("keeps separate row owners while preserving the shared unit in compiled output", () => {
    const { manifest, registry, selectors, spans } = fixture();
    const before = structuredClone({ manifest, registry, selectors });
    const state = tableExpansionState(manifest, registry, selectors);
    expect(state.issues).toEqual([]);
    expect(state.work_packages[0]!.rows.map(row => ({ evidence_id: row.evidence_id, item_keys: row.item_keys }))).toEqual([
      { evidence_id: "fictional:row:a", item_keys: ["item:0"] },
      { evidence_id: "fictional:row:b", item_keys: ["item:1"] },
    ]);
    const compiled = hydrateSemanticSourcePlan(compileTargetSelectors(selectors, registry, manifest), manifest);
    const item = compiled.acceptance_items.find(entry => entry.name === "虚构尺寸乙")!;
    expect(item.table_semantics?.unit).toBe("mm");
    expect(item.table_semantics?.cell_evidence).toContainEqual({ role: "unit", evidence_id: "fictional:row:a", text: "mm" });
    expect(selectors.items[1]!.table!.properties.unit_span_ids).toEqual([spans[0]!.unit]);
    expect({ manifest, registry, selectors }).toEqual(before);
  });

  test("a unit-only reference cannot discharge the source row's pending obligation", () => {
    const { manifest, registry, selectors } = fixture();
    selectors.items.shift();
    const state = tableExpansionState(manifest, registry, selectors);
    expect(mergedIssue(state)).toBeUndefined();
    expect(state.work_packages[0]!.rows[0]).toMatchObject({ evidence_id: "fictional:row:a", disposition: "pending", item_keys: [] });
    expect(state.issues).toContainEqual(expect.objectContaining({ code: "selector_table_expansion_obligations_pending",
      details: expect.objectContaining({ pending_evidence_ids: ["fictional:row:a"] }) }));
  });

  test.each(["criterion", "requirement", "allowed_value", "row_path"] as const)(
    "the same unit span still owns the source row when also bound as %s", role => {
      const { manifest, registry, selectors, spans } = fixture();
      const item = selectors.items[1]!;
      const unit = spans[0]!.unit;
      if (role === "criterion") item.criterion_span_ids.push(unit);
      else if (role === "requirement") item.fields.requirement.span_ids.push(unit);
      else if (role === "allowed_value") item.table!.properties.allowed_value_span_ids.push(unit);
      else item.table!.properties.row_path_span_ids.push([unit]);
      expect(mergedIssue(tableExpansionState(manifest, registry, selectors))).toMatchObject({
        details: { item_key: item.key, core_properties: ["虚构尺寸甲", "虚构尺寸乙"] },
      });
    },
  );

  test.each(["criterion", "subject", "requirement", "row_path", "allowed_value", "branch"] as const)(
    "genuine cross-property %s provenance still rejects merging independent rows", role => {
      const { manifest, registry, selectors, spans } = fixture();
      const item = selectors.items[1]!;
      const first = spans[0]!;
      if (role === "criterion") item.criterion_span_ids.push(first.value);
      else if (role === "subject") item.fields.name.span_ids.push(first.name);
      else if (role === "requirement") item.fields.requirement.span_ids.push(first.value);
      else if (role === "row_path") item.table!.properties.row_path_span_ids.push([first.name]);
      else if (role === "allowed_value") item.table!.properties.allowed_value_span_ids.push(first.value);
      else item.table!.properties.acceptance_branches = spans.map((row, index) => ({
        key: "branch:" + index, condition_span_ids: [row.name], requirement_span_ids: [row.value],
        allowed_value_span_ids: [row.value], reason: "反例：不能用分支合并独立属性",
      }));
      expect(mergedIssue(tableExpansionState(manifest, registry, selectors))).toMatchObject({
        details: { item_key: item.key, core_properties: ["虚构尺寸甲", "虚构尺寸乙"] },
      });
    },
  );
});
