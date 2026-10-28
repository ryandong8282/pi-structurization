import { describe, expect, it } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type AcceptanceItemPlan,
  type EvidenceManifest,
  type FieldSourceBinding,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import { assistantTerminalError } from "../src/pi-runtime.js";
import { canRetryTargetFailure, classifyTargetFailure } from "../src/attempt-budget.js";
import { batchResultMatchesPlan } from "../src/batch.js";

function binding(evidenceId: string, value: string): FieldSourceBinding {
  return {
    status: value ? "bound" : "not_applicable",
    composition: value ? "verbatim" : "not_applicable",
    evidence_ids: value ? [evidenceId] : [],
    source_fragments: value ? [{ evidence_id: evidenceId, text: value }] : [],
    value_sha256: sha256Text(value),
    reason: "regression fixture",
  };
}

function item(
  itemId: string,
  evidenceId: string,
  requirement: string,
): AcceptanceItemPlan {
  return {
    item_id: itemId,
    lot_id: "lot",
    name: itemId,
    category: "主控项目",
    requirement,
    method: "观察检查。",
    quantity: "每批检查。",
    note: "",
    evidence_ids: [evidenceId],
    reference_evidence_ids: [evidenceId],
    inspection_data_type: "counting",
    inspection_data_type_reason: "检查形成符合或不符合的属性结果；逐项判定；最终按不符合项评价。",
    inspection_data_type_evidence_ids: [evidenceId],
    field_bindings: {
      name: binding(evidenceId, itemId),
      requirement: binding(evidenceId, requirement),
      method: binding(evidenceId, "观察检查。"),
      quantity: binding(evidenceId, "每批检查。"),
      note: binding(evidenceId, ""),
    },
    sampling: {
      status: "explicit",
      min_sampling: "每批检查",
      script: "每批检查。",
      reason: "原文明确",
      confidence: 1,
      evidence_ids: [evidenceId],
    },
  };
}

function manifest(text: string): EvidenceManifest {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "job",
    target_id: "target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: "source-sha256",
      semantic_workflow: true,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "target_section",
      target_id: "target",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "regression fixture",
      candidates: [],
    },
    evidence: [{
      evidence_id: "evidence",
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: "evidence-fingerprint",
  };
}

function plan(items: AcceptanceItemPlan[]): SemanticSourcePlan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: "job",
    target_id: "target",
    evidence_fingerprint: "evidence-fingerprint",
    table_assembly: {
      schema_version: "table-assembly-plan/v1",
      evidence_fingerprint: "evidence-fingerprint",
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: [{
      lot_id: "lot",
      name: "检验批 lot",
      evidence_ids: ["evidence"],
      item_ids: items.map((candidate) => candidate.item_id),
    }],
    acceptance_items: items,
    reference_resolutions: [],
    evidence_dispositions: [],
    semantic_evidence: [],
    semantic_references: [],
    shared_sampling_rules: [],
  };
}

describe("Pi runtime and provenance regressions", () => {
  it('does not invalidate old seals for presentation order or missing coordinates, but still rejects changed facts', () => {
    const text = '对象甲应完好。对象乙应密实。';
    const sourcePlan = plan([item('甲项', 'evidence', '对象甲应完好。'), item('乙项', 'evidence', '对象乙应密实。')]);
    const result = materialize(sourcePlan, manifest(text), 'fingerprint').result;
    result.inspection_lots[0]!.items.reverse();
    for (const leaf of result.inspection_lots[0]!.items) delete leaf.source_anchors;
    expect(batchResultMatchesPlan(result, sourcePlan, manifest(text), 'fingerprint')).toBe(true);
    result.inspection_lots[0]!.items[0]!.requirement = '篡改要求';
    expect(batchResultMatchesPlan(result, sourcePlan, manifest(text), 'fingerprint')).toBe(false);
  });
  it("keeps a generic continuation fragment from stealing the acceptance clause", () => {
    const text = [
      "5.8.6 其他面层材料要求。",
      "观察检查。",
      "5.10.4 塑胶面层材料要求。",
      "观察检查。",
    ].join("\n");
    const candidate = item("plastic-material", "evidence", "5.10.4 塑胶面层材料要求。");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      {
        semantic_id: "plastic-item",
        role: "acceptance_item",
        evidence_id: "evidence",
        exact_fragment: "5.10.4 塑胶面层材料要求。",
        parent_semantic_id: "",
        materialized_item_id: candidate.item_id,
        reason: "验收条款主体",
      },
      {
        semantic_id: "plastic-method",
        role: "continuation",
        evidence_id: "evidence",
        exact_fragment: "观察检查。",
        parent_semantic_id: "plastic-item",
        materialized_item_id: candidate.item_id,
        reason: "条款续文",
      },
    ];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    expect(result.inspection_lots[0]!.items[0]!.source_clause).toBe("5.10.4");
  });

  it("prefers the clause carried by a direct semantic fragment over a wide-window background anchor", () => {
    const text = [
      "3.0.5 共享的检验批合格条件。",
      "4.6.1 面板原材料应符合设计要求。",
    ].join("\n");
    const candidate = item("panel-material", "evidence", "4.6.1 面板原材料应符合设计要求。");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [{
      semantic_id: "panel-material-item",
      role: "acceptance_item",
      evidence_id: "evidence",
      exact_fragment: "4.6.1 面板原材料应符合设计要求。",
      parent_semantic_id: "",
      materialized_item_id: candidate.item_id,
      reason: "直接验收条款",
    }];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    expect(result.inspection_lots[0]!.items[0]!.source_clause).toBe("4.6.1");
  });

  it("uses a unique longer binding when a semantic fragment repeats under different clauses", () => {
    const repeated = "熟化石灰颗粒粒径不应大于5mm";
    const laterClause = `4.7.5 炉渣颗粒应符合要求；${repeated}。`;
    const text = [
      `4.6.3 三合土材料要求；${repeated}。`,
      "4.7.4 炉渣垫层施工条件。",
      "I 主控项目",
      laterClause,
    ].join("\n");
    const candidate = item("lime-particle-size", "evidence", `${repeated}。`);
    candidate.note = "主控项目";
    candidate.field_bindings.note = {
      ...binding("evidence", candidate.note),
      source_fragments: [
        { evidence_id: "evidence", text: "I 主控项目" },
        { evidence_id: "evidence", text: laterClause },
      ],
    };
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [{
      semantic_id: "lime-particle-size-item",
      role: "acceptance_item",
      evidence_id: "evidence",
      exact_fragment: repeated,
      parent_semantic_id: "",
      materialized_item_id: candidate.item_id,
      reason: "同一句验收特征在相邻条文重复，完整条文绑定负责消歧。",
    }];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    expect(result.inspection_lots[0]!.items[0]!.source_clause).toBe("4.7.5");
  });

  it("selects the referenced clause assigned to each destination item", () => {
    const text = [
      "5.11.5 其余项目应符合第5.2节的规定。",
      "5.2.3 粗骨料要求。",
      "5.2.5 强度等级要求。",
    ].join("\n");
    const aggregate = item("aggregate", "evidence", "5.2.3 粗骨料要求。");
    const strength = item("strength", "evidence", "5.2.5 强度等级要求。");
    const sourcePlan = plan([aggregate, strength]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "anchor", role: "reference_anchor", evidence_id: "evidence", exact_fragment: "5.11.5 其余项目应符合第5.2节的规定。", parent_semantic_id: "", materialized_item_id: "", reason: "引用锚点" },
      { semantic_id: "reference-aggregate", role: "referenced_clause", evidence_id: "evidence", exact_fragment: "5.2.3 粗骨料要求。", parent_semantic_id: "anchor", materialized_item_id: "", reason: "引用条款" },
      { semantic_id: "reference-strength", role: "referenced_clause", evidence_id: "evidence", exact_fragment: "5.2.5 强度等级要求。", parent_semantic_id: "anchor", materialized_item_id: "", reason: "引用条款" },
      { semantic_id: "aggregate-item", role: "acceptance_item", evidence_id: "evidence", exact_fragment: "5.2.3 粗骨料要求。", parent_semantic_id: "reference-aggregate", materialized_item_id: aggregate.item_id, reason: "引用后的验收项目" },
      { semantic_id: "strength-item", role: "acceptance_item", evidence_id: "evidence", exact_fragment: "5.2.5 强度等级要求。", parent_semantic_id: "reference-strength", materialized_item_id: strength.item_id, reason: "引用后的验收项目" },
    ];
    sourcePlan.semantic_references = [{
      expansion_id: "section-5.2",
      anchor_semantic_id: "anchor",
      status: "resolved",
      target_semantic_ids: [
        "reference-aggregate",
        "reference-strength",
        "aggregate-item",
        "strength-item",
      ],
      destination_bindings: [
        { item_id: aggregate.item_id, fields: ["requirement"] },
        { item_id: strength.item_id, fields: ["requirement"] },
      ],
      reason: "引用展开到两个独立项目",
    }];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    const items = result.inspection_lots[0]!.items;
    expect(items.find((candidate) => candidate.item_id === aggregate.item_id)?.reference_source_clause)
      .toBe("5.2.3");
    expect(items.find((candidate) => candidate.item_id === strength.item_id)?.reference_source_clause)
      .toBe("5.2.5");
  });

  it("derives each destination clause from its own field bindings when referenced nodes are shared", () => {
    const origin = "5.7.1 如果有平衡重，应符合本规范第 4.7 节的规定。";
    const firstRequirement = "4.7.1 反绳轮应设置防护装置和挡绳装置。";
    const secondRequirement = "4.7.2 对重块应可靠固定。";
    const text = [origin, firstRequirement, secondRequirement].join("\n");
    const first = item("reverse-sheave", "evidence", firstRequirement);
    const second = item("counterweight-block", "evidence", secondRequirement);
    const sourcePlan = plan([first, second]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "anchor", role: "reference_anchor", evidence_id: "evidence", exact_fragment: origin, parent_semantic_id: "", materialized_item_id: "", reason: "5.7.1 引用锚点" },
      { semantic_id: "first-item", role: "acceptance_item", evidence_id: "evidence", exact_fragment: origin, parent_semantic_id: "", materialized_item_id: first.item_id, reason: "条件引用接收项" },
      { semantic_id: "second-item", role: "acceptance_item", evidence_id: "evidence", exact_fragment: origin, parent_semantic_id: "", materialized_item_id: second.item_id, reason: "条件引用接收项" },
      { semantic_id: "first-target", role: "referenced_clause", evidence_id: "evidence", exact_fragment: firstRequirement, parent_semantic_id: "anchor", materialized_item_id: "", reason: "4.7.1" },
      { semantic_id: "second-target", role: "referenced_clause", evidence_id: "evidence", exact_fragment: secondRequirement, parent_semantic_id: "anchor", materialized_item_id: "", reason: "4.7.2" },
    ];
    sourcePlan.semantic_references = [{
      expansion_id: "section-4.7",
      anchor_semantic_id: "anchor",
      status: "resolved",
      target_semantic_ids: ["first-target", "second-target"],
      destination_bindings: [
        { item_id: first.item_id, fields: ["reference_only"] },
        { item_id: second.item_id, fields: ["reference_only"] },
      ],
      reason: "第4.7节共享引用目录",
    }];

    const items = materialize(sourcePlan, manifest(text), "fingerprint").result.inspection_lots[0]!.items;
    expect(items.map((candidate) => ({
      source: candidate.source_clause,
      reference: candidate.reference_source_clause,
      from: candidate.reference_from_clause,
    }))).toEqual([
      { source: "5.7.1", reference: "4.7.1", from: "5.7.1" },
      { source: "5.7.1", reference: "4.7.2", from: "5.7.1" },
    ]);
  });

  it("keeps a direct item clause when a shared reference anchor is also routed to it", () => {
    const text = [
      "3.0.5 共享检验批合格条件。",
      "4.6.1 面板原材料应符合设计要求。",
    ].join("\n");
    const candidate = item("panel-material", "evidence", "4.6.1 面板原材料应符合设计要求。");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "shared-anchor", role: "reference_anchor", evidence_id: "evidence", exact_fragment: "3.0.5 共享检验批合格条件。", parent_semantic_id: "", materialized_item_id: "", reason: "共享引用" },
      { semantic_id: "panel-item", role: "acceptance_item", evidence_id: "evidence", exact_fragment: "4.6.1 面板原材料应符合设计要求。", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "直接验收条款" },
    ];
    sourcePlan.semantic_references = [{
      expansion_id: "shared-acceptance",
      anchor_semantic_id: "shared-anchor",
      status: "resolved",
      target_semantic_ids: ["panel-item"],
      destination_bindings: [{ item_id: candidate.item_id, fields: ["requirement"] }],
      reason: "共享合格条件路由到直接项",
    }];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    const materialized = result.inspection_lots[0]!.items[0]!;
    expect(materialized.source_clause).toBe("4.6.1");
    expect(materialized.reference_from_clause).toBe("3.0.5");
    expect(batchResultMatchesPlan(result, sourcePlan, manifest(text), "fingerprint")).toBe(true);
    const legacyWithoutCoordinates = structuredClone(result);
    for (const lot of legacyWithoutCoordinates.inspection_lots) {
      lot.items.reverse();
      for (const item of lot.items) delete item.source_anchors;
    }
    expect(batchResultMatchesPlan(legacyWithoutCoordinates, sourcePlan, manifest(text), "fingerprint")).toBe(true);
    const stale = structuredClone(result);
    stale.inspection_lots[0]!.items[0]!.reference_from_clause = "9.9.9";
    expect(batchResultMatchesPlan(stale, sourcePlan, manifest(text), "fingerprint")).toBe(false);
  });

  it("keeps a unique primary clause when supplementary scope is added, without hiding primary conflicts", () => {
    const direct = "6.2.1 构件尺寸应符合设计要求。";
    const shared = "2.0.8 每两层划分一个检验批。";
    const evidence = manifest(direct);
    evidence.evidence[0]!.evidence_scope = "primary";
    evidence.evidence.push({ evidence_id: "shared", kind: "paragraph", role: "context", locator: "line:20", clause_id: "2.0.8",
      text: shared, text_sha256: sha256Text(shared), requires_disposition: false, evidence_scope: "reference" });
    const candidate = item("dimensions", "evidence", direct);
    candidate.note = shared; candidate.field_bindings.note = binding("shared", shared); candidate.evidence_ids.push("shared");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "direct", role: "acceptance_item", evidence_id: "evidence", exact_fragment: direct, parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "direct" },
      { semantic_id: "shared", role: "acceptance_item", evidence_id: "shared", exact_fragment: shared, parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "supplementary scope" },
    ];
    const result = materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!;
    expect(result.source_clause).toBe("6.2.1");
    expect(result.note).toBe(shared);
    expect(result.evidence_ids).toContain("shared");
    evidence.evidence[1]!.evidence_scope = "primary";
    expect(materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!.source_clause).toBe("");
  });

  it("does not choose a source clause when one item has semantic evidence in two formal clauses", () => {
    const text = [
      "6.1.1 必须提供技术资料。",
      "6.1.2 随机文件还应提供装箱单。",
    ].join("\n");
    const candidate = item("mixed-clause-item", "evidence", text);
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "first", role: "acceptance_item", evidence_id: "evidence", exact_fragment: "6.1.1 必须提供技术资料。", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "第一条" },
      { semantic_id: "second", role: "acceptance_item", evidence_id: "evidence", exact_fragment: "6.1.2 随机文件还应提供装箱单。", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "第二条" },
    ];

    const result = materialize(sourcePlan, manifest(text), "fingerprint").result;
    expect(result.inspection_lots[0]!.items[0]!.source_clause).toBe("");
  });

  it("projects one formal line owner across duplicate evidence representations", () => {
    const first = item("technical-document", "child-611", "梯级型式试验报告复印件");
    const second = item("packing-list", "child-612", "装箱单");
    const sourcePlan = plan([first, second]);
    sourcePlan.inspection_lots[0]!.evidence_ids = ["child-611", "child-612"];
    sourcePlan.semantic_evidence = [
      { semantic_id: "first", role: "acceptance_item", evidence_id: "child-611", exact_fragment: "梯级型式试验报告复印件", parent_semantic_id: "", materialized_item_id: first.item_id, reason: "6.1.1 子项" },
      { semantic_id: "second", role: "acceptance_item", evidence_id: "child-612", exact_fragment: "装箱单", parent_semantic_id: "", materialized_item_id: second.item_id, reason: "6.1.2 子项" },
    ];
    const evidence = manifest("");
    evidence.evidence = [
      { evidence_id: "owner-611", kind: "paragraph", role: "supporting_clause", locator: "line:1", text: "6.1.1 必须提供以下资料:", text_sha256: sha256Text("6.1.1 必须提供以下资料:"), requires_disposition: false, clause_id: "6.1.1" },
      { evidence_id: "child-611", kind: "paragraph", role: "context", locator: "line:2", text: "梯级型式试验报告复印件", text_sha256: sha256Text("梯级型式试验报告复印件"), requires_disposition: false },
      { evidence_id: "owner-612", kind: "paragraph", role: "supporting_clause", locator: "line:3", text: "6.1.2 随机文件还应提供以下资料；", text_sha256: sha256Text("6.1.2 随机文件还应提供以下资料；"), requires_disposition: false },
      { evidence_id: "child-612", kind: "paragraph", role: "context", locator: "line:4", text: "装箱单", text_sha256: sha256Text("装箱单"), requires_disposition: false },
    ];

    const items = materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items;
    expect(items.map((entry) => entry.source_clause)).toEqual(["6.1.1", "6.1.2"]);
  });

  it("inherits an appendix clause such as B.1.6 for numbered child paragraphs", () => {
    const candidate = item("appendix-verdict", "child-b16", "1 全部检验结果满足要求时，该批构件可判为合格；");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [{
      semantic_id: "appendix-child",
      role: "acceptance_item",
      evidence_id: "child-b16",
      exact_fragment: candidate.requirement,
      parent_semantic_id: "",
      materialized_item_id: candidate.item_id,
      reason: "B.1.6 的第一款",
    }];
    const evidence = manifest("");
    evidence.evidence = [
      { evidence_id: "owner-b16", kind: "paragraph", role: "context", locator: "line:1606", text: "B.1.6 预制构件结构性能检验的合格判定应符合下列规定：", text_sha256: sha256Text("B.1.6 预制构件结构性能检验的合格判定应符合下列规定："), requires_disposition: false, evidence_scope: "primary" },
      { evidence_id: "child-b16", kind: "paragraph", role: "context", locator: "line:1608", text: candidate.requirement, text_sha256: sha256Text(candidate.requirement), requires_disposition: false, evidence_scope: "primary" },
    ];

    const materialized = materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!;
    expect(materialized.source_clause).toBe("B.1.6");
  });

  it("does not treat a two-part equipment model as a parent clause", () => {
    const candidate = item("equipment-model", "model-child", "设备铭牌应清晰。");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [{
      semantic_id: "model-child",
      role: "acceptance_item",
      evidence_id: "model-child",
      exact_fragment: candidate.requirement,
      parent_semantic_id: "",
      materialized_item_id: candidate.item_id,
      reason: "设备要求",
    }];
    const evidence = manifest("");
    evidence.evidence = [
      { evidence_id: "model-owner", kind: "paragraph", role: "context", locator: "line:1", text: "2024.1 型设备性能", text_sha256: sha256Text("2024.1 型设备性能"), requires_disposition: false, evidence_scope: "primary" },
      { evidence_id: "model-child", kind: "paragraph", role: "context", locator: "line:2", text: candidate.requirement, text_sha256: sha256Text(candidate.requirement), requires_disposition: false, evidence_scope: "primary" },
    ];

    expect(materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!.source_clause).toBe("");
  });

  it("uses direct table ownership spans instead of supporting method or sampling clauses", () => {
    const candidate = item("embedded-plate", "table-row", "预埋板中心线位置允许偏差为3mm。");
    candidate.evidence_ids = ["clause-424", "supporting-424", "clause-429", "table-caption", "table-row"];
    candidate.field_bindings.requirement = binding("clause-429", candidate.requirement);
    candidate.field_bindings.method = binding("supporting-424", "观察检查。");
    candidate.field_bindings.quantity = binding("supporting-424", "每批检查。");
    candidate.table_semantics = {
      source_kind: "direct",
      table_id: "table-429",
      table_no: "4.2.9",
      table_title: "预埋件和预留孔洞的安装允许偏差",
      applicability: "",
      row_path: ["预埋板中心线位置"],
      column_path: ["允许偏差"],
      unit: "mm",
      condition: "",
      allowed_value: "3",
      inspection_method: "观察检查。",
      cell_evidence: [
        { role: "table_no", evidence_id: "table-caption", text: "表 4.2.9 预埋件和预留孔洞的安装允许偏差" },
        { role: "row_header", evidence_id: "table-row", text: "预埋板中心线位置" },
        { role: "allowed_value", evidence_id: "table-row", text: "3" },
        { role: "inspection_method", evidence_id: "supporting-424", text: "观察检查。" },
      ],
      reference_fragments: [],
      reason: "表4.2.9的直接验收行",
      confidence: 1,
    };
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "table-row", role: "table_criterion", evidence_id: "table-row", exact_fragment: "预埋板中心线位置 | 3", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "主判据" },
      { semantic_id: "supporting", role: "table_criterion", evidence_id: "supporting-424", exact_fragment: "观察检查。", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "辅助字段，不参与主条款归属" },
    ];
    const evidence = manifest("");
    const record = (evidence_id: string, locator: string, text: string) => ({
      evidence_id, kind: "paragraph" as const, role: "context" as const, locator, text,
      text_sha256: sha256Text(text), requires_disposition: false, evidence_scope: "primary" as const,
    });
    evidence.evidence = [
      record("clause-424", "line:1", "4.2.4 支架竖杆安装应符合规定。"),
      record("supporting-424", "line:2", "观察检查。每批检查。"),
      record("clause-429", "line:4", "4.2.9 固定在模板上的预埋件不得遗漏。"),
      record("table-caption", "line:5", "表 4.2.9 预埋件和预留孔洞的安装允许偏差"),
      record("table-row", "line:6/table:4.2.9/row:2", "预埋板中心线位置 | 3"),
    ];

    expect(materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!.source_clause).toBe("4.2.9");
  });

  it("does not let a category heading inherit the preceding clause", () => {
    const candidate = item("power-switch", "clause-4103", "主电源开关不应切断规定供电电路");
    const sourcePlan = plan([candidate]);
    sourcePlan.semantic_evidence = [
      { semantic_id: "category", role: "acceptance_item", evidence_id: "category", exact_fragment: "## 一 般 项 目", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "栏目" },
      { semantic_id: "criterion", role: "acceptance_item", evidence_id: "clause-4103", exact_fragment: "4.10.3 主电源开关不应切断规定供电电路", parent_semantic_id: "", materialized_item_id: candidate.item_id, reason: "验收条款" },
    ];
    const evidence = manifest("");
    evidence.evidence = [
      { evidence_id: "clause-4102", kind: "paragraph", role: "supporting_clause", locator: "line:1", text: "4.10.2 绝缘电阻应符合规定", text_sha256: sha256Text("4.10.2 绝缘电阻应符合规定"), requires_disposition: false, clause_id: "4.10.2" },
      { evidence_id: "category", kind: "heading", role: "section_heading", locator: "line:2", text: "## 一 般 项 目", text_sha256: sha256Text("## 一 般 项 目"), requires_disposition: false },
      { evidence_id: "clause-4103", kind: "paragraph", role: "supporting_clause", locator: "line:3", text: "4.10.3 主电源开关不应切断规定供电电路", text_sha256: sha256Text("4.10.3 主电源开关不应切断规定供电电路"), requires_disposition: false, clause_id: "4.10.3" },
    ];

    const materialized = materialize(sourcePlan, evidence, "fingerprint").result.inspection_lots[0]!.items[0]!;
    expect(materialized.source_clause).toBe("4.10.3");
  });

  it("turns an output-length stop into an explicit retryable error", () => {
    expect(assistantTerminalError({ stopReason: "length", errorMessage: null }))
      .toBe("finish_reason=length");
    expect(assistantTerminalError({ stopReason: "stop", errorMessage: null })).toBe("");
    expect(assistantTerminalError({ stopReason: "error", errorMessage: "provider failed" }))
      .toBe("provider failed");
  });

  it("classifies a message-less provider stream death as a transport failure", () => {
    // Round-11 dimensions fresh (16:02:30Z): the provider stream died while a
    // stage_target_selector_draft tool call was half-generated, leaving
    // stopReason "error" with no error payload. The wording must route the
    // target into the bounded transport retry (fresh session from the durable
    // checkpoint) instead of a terminal candidate failure.
    const error = assistantTerminalError({ stopReason: "error", errorMessage: null });
    expect(error).toBe("provider stream error: stream terminated before response completed (stopReason=error)");
    expect(classifyTargetFailure(error)).toBe("transport");
    expect(canRetryTargetFailure(error, {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 2,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 1,
    }, { checkpoint: "cp", consecutive_failures: 1 })).toBe(true);
  });
});
