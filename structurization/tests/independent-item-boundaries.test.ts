import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest, EvidenceRecord } from "../src/contracts.js";
import { independentItemMergeIssues } from "../src/independent-item-boundaries.js";
import { registryWithFullSourceSpans, registerSourceSpan } from "../src/source-span-registry.js";
import { compileTargetSelectors, initialTargetSelectorPlan } from "../src/target-selector-compiler.js";
import { COVERAGE_REVIEW_SYSTEM_PROMPT, TARGET_SELECTOR_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { TARGET_SELECTOR_PROTOCOLS, LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE, LEGACY_COVERAGE_REVIEW_PROTOCOL } from "../src/acceptance-prompt-suite.js";

function row(label: string, options: { table?: string; sequence?: string; condition?: string; category?: string } = {}): EvidenceRecord {
  const columns = ["项", "序", "检查项目", "条件", "允许值或允许偏差 / 数值", "检查方法"];
  const cells = [options.category ?? "一般项目", options.sequence ?? "1", label, options.condition ?? "全部", "±10", "用钢尺量"];
  const table = options.table ?? "A.1";
  const text = `表${table} | 数据行 1 | ${columns.map((column, index) => `${column}=${cells[index]}`).join(" | ")}`;
  return {
    evidence_id: `evidence:${sha256Text(text)}`, text, text_sha256: sha256Text(text),
    kind: "table_row", role: "formal_table_row", table_row_kind: "data", table_id: table,
    locator: `table:${table}/${sha256Text(text).slice(0, 8)}`, columns, cells,
    requires_disposition: true, evidence_scope: "primary",
  };
}

function fixture(records: EvidenceRecord[]) {
  const manifest = {
    job_id: "merge-test", target_id: "target:test", evidence: records,
    evidence_fingerprint: sha256Text(JSON.stringify(records)), table_fragments: [], reference_occurrences: [],
  } as unknown as EvidenceManifest;
  const sources = records.map((record) => ({
    source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
  }));
  const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const ids = registry.spans.map((span) => span.span_id);
  const field = (span_ids: string[]) => ({
    composition: span_ids.length ? "verbatim" as const : "not_applicable" as const,
    span_ids, separator: "\n" as const, reason: "原文依据",
  });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots = [{ key: "lot", name: "验收", scope_span_ids: [], reason: "验收范围" }];
  selectors.items = [{
    key: "item", lot_key: "lot", name: "质量", category: "一般项目",
    criterion_span_ids: ids, continuation_span_ids: [],
    fields: { name: field(ids), requirement: field(ids), method: field([]), quantity: field([]), note: field([]) },
    table: null, inspection_data_type: "measurement", inspection_data_type_reason: "测量尺寸", inspection_data_type_span_ids: ids,
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无抽样", confidence: 1 },
    reason: "验收项目",
  }];
  return { manifest, registry, selectors, ids, sources };
}

describe("source acceptance item boundaries", () => {
  test("rejects copying separately labelled rows into one item even without table metadata", () => {
    const { selectors, registry, manifest } = fixture([row("孔深"), row("混凝土强度")]);
    expect(independentItemMergeIssues(selectors, registry, manifest)).toMatchObject([{
      code: "selector_independent_items_merged", path: "/items/0",
      details: { source_items: [{ item_label: "孔深" }, { item_label: "混凝土强度" }] },
    }]);
    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: "selector_independent_items_merged" })]),
    }));
  });

  test("moving sibling origins into requirement or continuation does not bypass the guard", () => {
    const { selectors, registry, manifest, ids } = fixture([row("长度"), row("直径")]);
    selectors.items[0]!.criterion_span_ids = [ids[0]!];
    expect(independentItemMergeIssues(selectors, registry, manifest)).toHaveLength(1);
    selectors.items[0]!.fields.requirement.span_ids = [ids[0]!];
    selectors.items[0]!.continuation_span_ids = [ids[1]!];
    expect(independentItemMergeIssues(selectors, registry, manifest)).toHaveLength(1);
  });

  test("explicit table allowed-value bindings also preserve independent source-item boundaries", () => {
    const { selectors, registry, manifest, ids } = fixture([row("长度"), row("直径")]);
    selectors.items[0]!.criterion_span_ids = [ids[0]!];
    selectors.items[0]!.fields.requirement.span_ids = [ids[0]!];
    selectors.items[0]!.table = {
      source_kind: "direct", table_key: "table", reference_span_ids: [], reason: "来源表",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [],
        allowed_value_span_ids: [ids[1]!], inspection_method_span_ids: [],
      },
    };
    expect(independentItemMergeIssues(selectors, registry, manifest)).toHaveLength(1);
  });

  test("separate items and further splitting of one source item are allowed", () => {
    const { selectors, registry, manifest, ids } = fixture([row("长度"), row("直径")]);
    const template = selectors.items[0]!;
    selectors.items = [ids[0]!, ids[1]!, ids[1]!].map((span, index) => ({
      ...structuredClone(template), key: `item-${index}`, criterion_span_ids: [span],
      fields: { ...structuredClone(template.fields), requirement: { ...template.fields.requirement, span_ids: [span] } },
    }));
    expect(independentItemMergeIssues(selectors, registry, manifest)).toEqual([]);
  });

  test("one property with separately labelled condition branches remains one item", () => {
    const { selectors, registry, manifest } = fixture([
      row("尺寸偏差", { condition: "小型构件" }), row("尺寸偏差", { condition: "大型构件" }),
    ]);
    expect(independentItemMergeIssues(selectors, registry, manifest)).toEqual([]);
  });

  test("same item name in different tables or source categories is not deduplicated", () => {
    for (const second of [row("桩长", { table: "B.1" }), row("桩长", { category: "主控项目" }), row("桩长", { sequence: "2" })]) {
      const { selectors, registry, manifest } = fixture([row("桩长"), second]);
      expect(independentItemMergeIssues(selectors, registry, manifest)).toHaveLength(1);
    }
  });

  test("shared supporting methods and sampling do not create a second item origin", () => {
    const { selectors, registry, manifest, ids, sources } = fixture([row("孔深"), row("直径")]);
    const item = selectors.items[0]!;
    item.criterion_span_ids = [ids[0]!];
    item.fields.requirement.span_ids = [ids[0]!];
    item.fields.method.span_ids = [ids[1]!];
    item.sampling.quantity_span_ids = [ids[1]!];
    expect(independentItemMergeIssues(selectors, registry, manifest)).toEqual([]);
    // Even in requirement, an exact method fragment is support, not the sibling criterion.
    const source = sources[1]!;
    const start = source.text.indexOf("用钢尺量");
    const registered = registerSourceSpan(registry, source, start, start + "用钢尺量".length);
    item.fields.requirement.span_ids.push(registered.span.span_id);
    expect(independentItemMergeIssues(selectors, registered.registry, manifest)).toEqual([]);
  });

  test("generic rows and prose are not mechanically promoted to acceptance items", () => {
    const records = [row("长度"), row("直径")].map((record) => ({ ...record, role: "context" as const }));
    const { selectors, registry, manifest } = fixture(records);
    expect(independentItemMergeIssues(selectors, registry, manifest)).toEqual([]);
  });

  test("parent and child check-item columns retain independent subitem identity", () => {
    const records = [row("钢筋笼质量"), row("钢筋笼质量", { condition: "第二项" })];
    records.forEach((record, index) => {
      record.columns![3] = "检查项目";
      record.cells![3] = index === 0 ? "长度" : "连接质量";
      record.text = `表A.1 | 数据行 ${index + 1} | ${record.columns!.map((column, i) => `${column}=${record.cells![i]}`).join(" | ")}`;
    });
    const { selectors, registry, manifest } = fixture(records);
    expect(independentItemMergeIssues(selectors, registry, manifest)[0]?.details).toMatchObject({
      source_items: [{ item_label: "钢筋笼质量 / 长度" }, { item_label: "钢筋笼质量 / 连接质量" }],
    });
  });

  test("cross-table merges tell the model to retarget destinations onto each referenced-table child", () => {
    const { selectors, registry, manifest } = fixture([
      row("焊缝质量", { table: "5.5.4-1" }),
      row("咬边深度", { table: "5.10.4" }),
    ]);
    selectors.references.push({
      key: "ref-weld-table",
      occurrence_id: "reference:table-5-10-4",
      anchor_span_ids: [],
      target_span_ids: [],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["requirement"],
        reason: "焊缝质量引用本标准表 5.10.4。",
      },
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "本标准表 5.10.4 焊缝质量。",
    });
    expect(independentItemMergeIssues(selectors, registry, manifest)[0]).toMatchObject({
      code: "selector_independent_items_merged",
      details: {
        required_action: "split_into_separate_items_then_retarget_resolved_reference_destinations_onto_each_referenced_table_child",
        writable_collection: "references",
        next_tool: "list_reference_occurrences",
        candidate_references: [{ reference_key: "ref-weld-table", path: "/references/0/destinations" }],
      },
    });
  });

  test("extractor and reviewer both treat source-item merging as a blocking defect", () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE);
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("实际拆项同步修正引用接收及成员");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("may author one coarse item");
    expect(LEGACY_COVERAGE_REVIEW_PROTOCOL).toContain("semantic_coverage_gap");
    expect(LEGACY_COVERAGE_REVIEW_PROTOCOL).toContain("真正独立属性分开");
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).not.toContain("is a granularity opinion, not a gap");
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).toContain("不同适用条件可以无损拆项，也可以用 acceptance_branches");
  });
});
