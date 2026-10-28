import { describe, expect, it } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type EvidenceManifest,
  type FieldSourceBinding,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";

function binding(value: string): FieldSourceBinding {
  return {
    status: "bound",
    composition: "verbatim",
    evidence_ids: ["evidence:item"],
    source_fragments: [{ evidence_id: "evidence:item", text: value }],
    value_sha256: sha256Text(value),
    reason: "item-name projection fixture",
  };
}

function materializeItem(planName: string, sourceText: string) {
  const plan: SemanticSourcePlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: "job-item-name",
    target_id: "target-item-name",
    evidence_fingerprint: "evidence-fingerprint",
    table_assembly: {
      schema_version: "table-assembly-plan/v1",
      evidence_fingerprint: "evidence-fingerprint",
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: [{
      lot_id: "lot:item-name",
      name: "检验批 lot",
      evidence_ids: ["evidence:item"],
      item_ids: ["item:item-name"],
    }],
    acceptance_items: [{
      item_id: "item:item-name",
      lot_id: "lot:item-name",
      name: planName,
      category: "主控项目",
      requirement: "完整保留 C20、6061-T6、10mm、2m、A类、Ⅰ级和3%等业务语义。",
      method: "检查原始记录。",
      quantity: "全数检查。",
      note: "不得丢失条件、数值、单位或例外。",
      evidence_ids: ["evidence:item"],
      reference_evidence_ids: [],
      field_bindings: {
        name: binding(planName),
        requirement: binding("完整保留 C20、6061-T6、10mm、2m、A类、Ⅰ级和3%等业务语义。"),
        method: binding("检查原始记录。"),
        quantity: binding("全数检查。"),
        note: binding("不得丢失条件、数值、单位或例外。"),
      },
      sampling: {
        status: "explicit",
        min_sampling: "全数检查",
        script: "全数检查。",
        reason: "原文明确。",
        confidence: 1,
        evidence_ids: ["evidence:item"],
      },
    }],
    reference_resolutions: [],
    evidence_dispositions: [],
    semantic_evidence: [{
      semantic_id: "semantic:item-name",
      role: "acceptance_item",
      evidence_id: "evidence:item",
      exact_fragment: sourceText,
      parent_semantic_id: "",
      materialized_item_id: "item:item-name",
      reason: "完整验收命题",
    }],
    semantic_references: [],
    shared_sampling_rules: [],
  };
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "job-item-name",
    target_id: "target-item-name",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "cross-format-source.md",
      sha256: "source-sha256",
      semantic_workflow: true,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "target_section",
      target_id: "target-item-name",
      source_line_count: sourceText.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: sourceText.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "cross-format item-name fixture",
      candidates: [],
    },
    evidence: [{
      evidence_id: "evidence:item",
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${sourceText.length}`,
      text: [
        sourceText,
        "完整保留 C20、6061-T6、10mm、2m、A类、Ⅰ级和3%等业务语义。",
        "检查原始记录。",
        "全数检查。",
        "不得丢失条件、数值、单位或例外。",
      ].join("\n"),
      text_sha256: sha256Text(sourceText),
      requires_disposition: true,
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: "evidence-fingerprint",
  };
  return { plan, ...materialize(plan, manifest, "plan-fingerprint") };
}

describe("acceptance item name projection", () => {
  it.each([
    {
      label: "GB 50576 direct clause",
      planName: "4.4.1 紧固标准件品种、规格、性能及出厂检验报告",
      sourceText: "4.4.1 紧固标准件品种、规格、性能及出厂检验报告",
      sourceClause: "4.4.1",
      expected: "紧固标准件品种、规格、性能及出厂检验报告",
    },
    {
      label: "appendix clause",
      planName: "A.0.1 防火封堵材料性能",
      sourceText: "A.0.1 防火封堵材料性能",
      sourceClause: "A.0.1",
      expected: "防火封堵材料性能",
    },
    {
      label: "deep clause",
      planName: "10.2.3.4 构件连接质量",
      sourceText: "10.2.3.4 构件连接质量",
      sourceClause: "10.2.3.4",
      expected: "构件连接质量",
    },
    {
      label: "Unicode Roman appendix and Roman business grade",
      planName: "Ⅰ.0.1 Ⅰ级构件耐久性",
      sourceText: "Ⅰ.0.1 Ⅰ级构件耐久性",
      sourceClause: "Ⅰ.0.1",
      expected: "Ⅰ级构件耐久性",
    },
    {
      label: "OCR line and full-width-dot damage",
      planName: "4 ． 4 ．\n1 紧固标准件出厂检验报告",
      sourceText: "4 ． 4 ．\n1 紧固标准件出厂检验报告",
      sourceClause: "4.4.1",
      expected: "紧固标准件出厂检验报告",
    },
  ])("moves only the proved locator for $label", ({ planName, sourceText, sourceClause, expected }) => {
    const { plan, result, provenance } = materializeItem(planName, sourceText);
    const item = result.inspection_lots[0]!.items[0]!;

    expect(item).toMatchObject({
      item_id: "item:item-name",
      name: expected,
      source_clause: sourceClause,
      category: "主控项目",
      requirement: "完整保留 C20、6061-T6、10mm、2m、A类、Ⅰ级和3%等业务语义。",
      method: "检查原始记录。",
      quantity: "全数检查。",
      note: "不得丢失条件、数值、单位或例外。",
      evidence_ids: ["evidence:item"],
    });
    expect(plan.acceptance_items[0]!.name).toBe(planName);
    const provenanceItem = (provenance as {
      items: Record<string, {
        field_bindings: { name: { source_fragments: Array<{ text: string }> } };
        materialized_fields: { name: { deterministic_transform: string } };
      }>;
    }).items["item:item-name"]!;
    expect(provenanceItem.field_bindings.name.source_fragments[0]!.text).toBe(planName);
    expect(provenanceItem.materialized_fields.name.deterministic_transform)
      .toContain("source_clause_prefix_removed_from_name");
  });

  it.each([
    { name: "C20混凝土强度与6061-T6铝材性能", sourceClause: "" },
    { name: "10mm厚板与2m构件尺寸", sourceClause: "" },
    { name: "A类材料、Ⅰ级连接和3%坡度", sourceClause: "" },
    { name: "2024年首批设备性能", sourceClause: "" },
    { name: "2024.1 型设备性能", sourceClause: "" },
    { name: "3%坡度允许偏差", sourceClause: "" },
    { name: "4.4.10mm厚板尺寸", sourceClause: "4.4.10" },
  ])("keeps a legitimate business-leading name: $name", ({ name, sourceClause }) => {
    const sourceText = sourceClause ? name : `验收项目：${name}`;
    const { result } = materializeItem(name, sourceText);
    const item = result.inspection_lots[0]!.items[0]!;
    expect(item.name).toBe(name);
    expect(item.source_clause).toBe(sourceClause);
  });
});
