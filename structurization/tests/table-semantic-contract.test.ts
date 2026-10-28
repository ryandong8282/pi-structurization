import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { prettyJson, sha256Text } from "../src/canonical.js";
import type {
  AcceptanceItemFieldBindings,
  EvidenceManifest,
  SourceFragment,
  TableCriterionSemantics,
} from "../src/contracts.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
  type DocumentTarget,
} from "../src/document-discovery.js";
import { materialize } from "../src/materializer.js";
import { buildPlanContract } from "../src/source-plan-contract.js";
import { ToolController, validFixturePlan } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

async function prepareAgentResources(
  label: string,
  markdown: string,
  atomSize = 12_000,
) {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const markdownPath = resolve(root, "source.md");
  await writeFile(markdownPath, markdown, "utf8");
  const document = buildDocumentEvidence(markdown, "source.md", atomSize);
  const first = document.atoms[0]!;
  const target: DocumentTarget = {
    target_id: "semantic-table-target",
    group_id: "semantic-table-group",
    group_name: "语义表格回归",
    group_reason: "跨文件、格式和OCR扰动验证",
    name: "表格验收语义",
    description: "验证表格中的可独立判定验收要求",
    evidence_atom_ids: [first.atom_id],
    evidence_fragments: [{ atom_id: first.atom_id, text: "对象质量应满足设计要求" }],
    materialization: {
      kind: "inspection_scope",
      lot_basis_summary: "按完整领域语义形成检验批",
      lot_basis_fragments: [{ atom_id: first.atom_id, text: "对象质量应满足设计要求" }],
      reason: "回归用例只固定领域语义，不固定标题、编号或版式",
    },
    reason: "存在可独立检验的领域质量要求",
  };
  const prepared = await buildAgentScopedEvidenceManifest(
    markdownPath,
    `job-${label}`,
    target,
    document,
  );
  return { root, target, prepared, manifest: prepared.manifest };
}

async function prepareAgentManifest(
  label: string,
  markdown: string,
  atomSize = 12_000,
): Promise<EvidenceManifest> {
  return (await prepareAgentResources(label, markdown, atomSize)).manifest;
}

function exactBinding(
  value: string,
  fragments: SourceFragment[],
  composition: "verbatim" | "reference" = "verbatim",
) {
  return {
    status: "bound" as const,
    composition,
    evidence_ids: [...new Set(fragments.map((fragment) => fragment.evidence_id))],
    source_fragments: fragments,
    value_sha256: sha256Text(value),
    reason: "语义概括与不可变原文片段分开保存",
  };
}

function locate(manifest: EvidenceManifest, text: string) {
  const evidence = manifest.evidence.find((record) => record.text.includes(text));
  if (!evidence) throw new Error(`missing evidence for ${text}`);
  return evidence;
}

function setDirectCriterion(
  manifest: EvidenceManifest,
  config: {
    name: string;
    requirement: string;
    method: string;
    semanticFragment: string;
    table: Omit<TableCriterionSemantics, "source_kind" | "reference_fragments" | "cell_evidence">;
    cells: Array<{ role: TableCriterionSemantics["cell_evidence"][number]["role"]; text: string }>;
  },
) {
  const plan = validFixturePlan(manifest);
  const item = plan.acceptance_items[0]!;
  const record = locate(manifest, config.semanticFragment);
  const fields = {
    name: config.name,
    requirement: config.requirement,
    method: config.method,
    quantity: "",
    note: "",
  };
  Object.assign(item, fields);
  item.field_bindings = buildItemFieldBindings(fields, item.evidence_ids, manifest);
  item.field_bindings.requirement = exactBinding(config.requirement, [{
    evidence_id: record.evidence_id,
    text: config.semanticFragment,
  }]);
  item.table_semantics = {
    source_kind: "direct",
    ...config.table,
    cell_evidence: config.cells.map((cell) => ({
      ...cell,
      evidence_id: locate(manifest, cell.text).evidence_id,
    })),
    reference_fragments: [],
  };
  plan.semantic_evidence = [{
    semantic_id: "semantic:table-criterion",
    role: "table_criterion",
    evidence_id: record.evidence_id,
    exact_fragment: config.semanticFragment,
    parent_semantic_id: "",
    materialized_item_id: item.item_id,
    reason: "完整领域语义确认该行列路径是一个独立判定检查点",
  }];
  plan.semantic_references = [];
  plan.shared_sampling_rules = [];
  return plan;
}

describe("semantic table criterion contract", () => {
  test("loads the manually checked GB 50576 table gold as semantic checkpoints", async () => {
    const gold = JSON.parse(await readFile(new URL("../fixtures/gold/gb50576_table_semantics_gold.json", import.meta.url), "utf8")) as {
      tables: Array<{
        table_no: string;
        source_kind: string;
        checkpoint_count: number;
        checkpoints?: Array<string | { name: string }>;
      }>;
      negative_cases: string[];
    };
    expect(gold.tables.map((table) => table.table_no)).toEqual([
      "7.4.3", "7.4.4", "7.5.1-1", "7.5.1-2", "7.6.1",
      "7.6.2", "7.6.3", "C.0.1", "E.0.1", "E.0.2",
    ]);
    expect(gold.tables.reduce((sum, table) => sum + table.checkpoint_count, 0)).toBe(40);
    expect(new Set(gold.tables.map((table) => table.source_kind))).toEqual(
      new Set(["direct", "reference"]),
    );
    expect(gold.tables[0]!.checkpoints?.[0]).toMatchObject({ name: "螺栓球圆度" });
    expect(gold.negative_cases).toHaveLength(3);
  });

  test.each([
    {
      label: "GB50576 merged HTML headers",
      source: [
        "对象质量应满足设计要求。",
        "表 7.4.3 螺栓球加工的允许偏差",
        "<table><tr><td colspan=\"2\">检查项目</td><td>允许偏差</td><td>检验方法</td></tr><tr><td rowspan=\"2\">圆度</td><td>d≤120mm</td><td>1.0mm</td><td rowspan=\"2\">用卡尺和游标卡尺检查</td></tr><tr><td>d>120mm</td><td>1.5mm</td></tr></table>",
      ].join("\n"),
      semanticFragment: "圆度</td><td>d≤120mm</td><td>1.0mm",
      name: "螺栓球圆度",
      requirement: "d≤120mm时允许偏差1.0mm；d>120mm时允许偏差1.5mm",
      method: "用卡尺和游标卡尺检查",
      table: {
        table_id: "table:7.4.3",
        table_no: "7.4.3",
        table_title: "螺栓球加工的允许偏差",
        applicability: "螺栓球加工",
        row_path: ["圆度"],
        column_path: ["允许偏差"],
        unit: "mm",
        condition: "d≤120mm；d>120mm",
        allowed_value: "1.0mm；1.5mm",
        inspection_method: "用卡尺和游标卡尺检查",
      },
      cells: [
        { role: "table_no" as const, text: "7.4.3" },
        { role: "table_title" as const, text: "螺栓球加工的允许偏差" },
        { role: "applicability" as const, text: "螺栓球" },
        { role: "row_header" as const, text: "圆度" },
        { role: "column_header" as const, text: "允许偏差" },
        { role: "unit" as const, text: "mm" },
        { role: "condition" as const, text: "d≤120mm" },
        { role: "condition" as const, text: "d>120mm" },
        { role: "allowed_value" as const, text: "1.0mm" },
        { role: "allowed_value" as const, text: "1.5mm" },
        { role: "inspection_method" as const, text: "用卡尺和游标卡尺检查" },
      ],
    },
    {
      label: "other trade flattened text without numbering",
      source: "对象质量应满足设计要求。接触网支柱安装检验：支柱斜率；测点位于轨面以上；允许值不大于1/100；经纬仪测量。",
      semanticFragment: "支柱斜率；测点位于轨面以上；允许值不大于1/100；经纬仪测量",
      name: "接触网支柱斜率",
      requirement: "测点位于轨面以上时，支柱斜率不大于1/100",
      method: "经纬仪测量",
      table: {
        table_id: "semantic-table:contact-line-support",
        table_no: "",
        table_title: "接触网支柱安装检验",
        applicability: "接触网支柱",
        row_path: ["支柱斜率"],
        column_path: ["允许值"],
        unit: "",
        condition: "测点位于轨面以上",
        allowed_value: "不大于1/100",
        inspection_method: "经纬仪测量",
      },
      cells: [
        { role: "table_title" as const, text: "接触网支柱安装检验" },
        { role: "applicability" as const, text: "接触网支柱" },
        { role: "row_header" as const, text: "支柱斜率" },
        { role: "column_header" as const, text: "允许值" },
        { role: "condition" as const, text: "测点位于轨面以上" },
        { role: "allowed_value" as const, text: "不大于1/100" },
        { role: "inspection_method" as const, text: "经纬仪测量" },
      ],
    },
    {
      label: "OCR line break and damaged table markup",
      source: "对象质量应满足设计要求。铝合金零部件榫头尺寸允许偏差应符合\n表 7.6.3 的规定。项目 A B C\n允许偏差 0.0-0.5 0.0-0.5 ±0.5\n检查方法 游标卡尺和卡尺。",
      semanticFragment: "项目 A B C\n允许偏差 0.0-0.5 0.0-0.5 ±0.5",
      name: "铝合金零部件榫头尺寸A",
      requirement: "榫头尺寸A允许偏差为0.0~-0.5mm",
      method: "游标卡尺和卡尺",
      table: {
        table_id: "table:7.6.3",
        table_no: "7.6.3",
        table_title: "榫头尺寸的允许偏差",
        applicability: "铝合金零部件榫头",
        row_path: ["允许偏差"],
        column_path: ["A"],
        unit: "mm",
        condition: "",
        allowed_value: "0.0~-0.5",
        inspection_method: "游标卡尺和卡尺",
      },
      cells: [
        { role: "table_no" as const, text: "7.6.3" },
        { role: "table_title" as const, text: "榫头尺寸允许偏差" },
        { role: "applicability" as const, text: "铝合金零部件榫头" },
        { role: "row_header" as const, text: "允许偏差" },
        { role: "column_header" as const, text: "A" },
        { role: "unit" as const, text: "尺寸" },
        { role: "allowed_value" as const, text: "0.0-0.5" },
        { role: "inspection_method" as const, text: "游标卡尺和卡尺" },
      ],
    },
  ])("validates and materializes $label through one semantic contract", async (fixture) => {
    const manifest = await prepareAgentManifest(fixture.label, fixture.source);
    expect(buildPlanContract(manifest).formal_rows).toEqual([]);
    const plan = setDirectCriterion(manifest, fixture);
    const opened = new Set(manifest.evidence.map((record) => record.evidence_id));
    const validation = validatePlanText(prettyJson(plan), manifest, opened);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    const item = materialize(plan, manifest, String(validation.fingerprint))
      .result.inspection_lots[0]!.items[0]!;
    expect(item.name).toBe(fixture.name);
    expect(item.table_semantics).toMatchObject({
      row_path: fixture.table.row_path,
      column_path: fixture.table.column_path,
      allowed_value: fixture.table.allowed_value,
    });
  });

  test("routes a remote appendix table split across evidence atoms to the same contract", async () => {
    const filler = "非目标上下文。".repeat(400);
    const source = [
      "对象质量应满足设计要求。8.2.1 单元件组装的允许偏差应符合本规范表 C.0.1 的规定。",
      filler,
      "附录 C 表 C.0.1 单元构件组装的允许偏差",
      filler,
      "项目 单元构件长度(mm) 条件≤2000 允许偏差±1.5 检查方法钢尺；条件>2000 允许偏差±2.0 检查方法钢尺。",
    ].join("\n");
    const resources = await prepareAgentResources("remote-appendix-table", source, 1_000);
    const anchorText = "应符合本规范表 C.0.1 的规定";
    const titleText = "附录 C 表 C.0.1 单元构件组装的允许偏差";
    const criterionText = "单元构件长度(mm) 条件≤2000 允许偏差±1.5 检查方法钢尺；条件>2000 允许偏差±2.0";
    expect(resources.manifest.evidence.some((record) => record.text.includes(anchorText))).toBe(true);
    expect(resources.manifest.evidence.some((record) => record.text.includes(titleText))).toBe(false);
    expect(resources.manifest.evidence.some((record) => record.text.includes(criterionText))).toBe(false);

    const revision = await RevisionWorkspace.createFromEvidence(
      resources.root,
      "job-remote-appendix-table",
      resources.target.target_id,
      resources.prepared,
    );
    const controller = await ToolController.create(revision);
    const dependencyAtomIds = new Set<string>();
    for (const query of [titleText, criterionText]) {
      const search = await controller.dispatch("search_global_document_resources", { query });
      expect(search).toMatchObject({ ok: true, unresolved: false });
      dependencyAtomIds.add((search.matches as Array<{ atom_id: string }>)[0]!.atom_id);
    }
    for (const atomId of dependencyAtomIds) {
      expect(await controller.dispatch("open_global_document_resource", { atom_id: atomId }))
        .toMatchObject({ ok: true });
      expect(await controller.dispatch("register_external_dependency", {
        atom_id: atomId,
        mode: "dependency",
        reason: "正文显式引用的远端附录表证据",
      })).toMatchObject({ ok: true, dependency_registered: true });
    }
    const manifest = await revision.readEvidenceManifest();
    const anchor = locate(manifest, anchorText);
    const title = locate(manifest, titleText);
    const criterion = locate(manifest, criterionText);
    expect(anchor.evidence_id).not.toBe(criterion.evidence_id);

    const plan = validFixturePlan(manifest);
    const item = plan.acceptance_items[0]!;
    const fields = {
      name: "单元构件长度",
      requirement: "长度≤2000mm时允许偏差±1.5mm；长度>2000mm时允许偏差±2.0mm",
      method: "钢尺",
      quantity: "",
      note: "",
    };
    Object.assign(item, fields);
    item.evidence_ids = [...new Set([...item.evidence_ids, criterion.evidence_id])];
    item.reference_evidence_ids = [];
    plan.inspection_lots[0]!.evidence_ids = [
      ...new Set([...plan.inspection_lots[0]!.evidence_ids, criterion.evidence_id]),
    ];
    let criterionDisposition = plan.evidence_dispositions.find(
      (disposition) => disposition.evidence_id === criterion.evidence_id,
    );
    if (!criterionDisposition) {
      criterionDisposition = {
        evidence_id: criterion.evidence_id,
        disposition: "used",
        item_ids: [item.item_id],
        reason: "远距附录表数据行形成当前判定项",
      };
      plan.evidence_dispositions.push(criterionDisposition);
    }
    criterionDisposition.disposition = "used";
    criterionDisposition.item_ids = [item.item_id];
    item.field_bindings = buildItemFieldBindings(fields, item.evidence_ids, manifest) as AcceptanceItemFieldBindings;
    item.field_bindings.requirement = exactBinding(fields.requirement, [
      { evidence_id: anchor.evidence_id, text: anchorText },
      { evidence_id: criterion.evidence_id, text: criterionText },
    ], "reference");
    item.table_semantics = {
      source_kind: "reference",
      table_id: "table:C.0.1",
      table_no: "C.0.1",
      table_title: "单元构件组装的允许偏差",
      applicability: "单元构件组装",
      row_path: ["单元构件长度"],
      column_path: ["允许偏差"],
      unit: "mm",
      condition: "≤2000；>2000",
      allowed_value: "±1.5；±2.0",
      inspection_method: "钢尺",
      cell_evidence: [
        { role: "table_no", evidence_id: title.evidence_id, text: "C.0.1" },
        { role: "table_title", evidence_id: title.evidence_id, text: "单元构件组装的允许偏差" },
        { role: "applicability", evidence_id: title.evidence_id, text: "单元构件" },
        { role: "row_header", evidence_id: criterion.evidence_id, text: "单元构件长度" },
        { role: "column_header", evidence_id: criterion.evidence_id, text: "允许偏差" },
        { role: "unit", evidence_id: criterion.evidence_id, text: "mm" },
        { role: "condition", evidence_id: criterion.evidence_id, text: "≤2000" },
        { role: "condition", evidence_id: criterion.evidence_id, text: ">2000" },
        { role: "allowed_value", evidence_id: criterion.evidence_id, text: "±1.5" },
        { role: "allowed_value", evidence_id: criterion.evidence_id, text: "±2.0" },
        { role: "inspection_method", evidence_id: criterion.evidence_id, text: "钢尺" },
      ],
      reference_fragments: [{ evidence_id: anchor.evidence_id, text: anchorText }],
    };
    plan.semantic_evidence = [
      {
        semantic_id: "semantic:appendix-anchor",
        role: "reference_anchor",
        evidence_id: anchor.evidence_id,
        exact_fragment: anchorText,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "正文引用附录表",
      },
      {
        semantic_id: "semantic:appendix-table-criterion",
        role: "table_criterion",
        evidence_id: criterion.evidence_id,
        exact_fragment: criterionText,
        parent_semantic_id: "",
        materialized_item_id: item.item_id,
        reason: "附录表中的一个独立判定检查点，条件分支合并保存",
      },
    ];
    plan.semantic_references = [{
      expansion_id: "semantic-expansion:C.0.1",
      anchor_semantic_id: "semantic:appendix-anchor",
      status: "resolved",
      target_semantic_ids: ["semantic:appendix-table-criterion"],
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "正文引用附录表的验收判据。" },
      destination_bindings: [{ item_id: item.item_id, fields: ["requirement"] }],
      reason: "正文引用与附录表要求闭合为同一验收项目",
    }];
    plan.shared_sampling_rules = [];

    const opened = new Set(manifest.evidence.map((record) => record.evidence_id));
    const validation = validatePlanText(prettyJson(plan), manifest, opened);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    const result = materialize(plan, manifest, String(validation.fingerprint)).result;
    const materialized = result.inspection_lots[0]!.items[0]!;
    expect(materialized.table_semantics).toMatchObject({
      source_kind: "reference",
      table_no: "C.0.1",
      row_path: ["单元构件长度"],
      condition: "≤2000；>2000",
      allowed_value: "±1.5；±2.0",
    });
    expect(materialized.reference_resolution_ids).toEqual(["semantic-expansion:C.0.1"]);
  });

  test("keeps same-name rows distinct by scope and preserves blank cells and units", async () => {
    const source = [
      "对象质量应满足设计要求。",
      "构件甲检查：厚度；单位mm；条件潮湿；允许偏差±1；方法游标卡尺。",
      "构件乙检查：厚度；单位%；条件干燥；允许偏差±2；检验方法留空。",
    ].join("\n");
    const manifest = await prepareAgentManifest("same-row-name-and-blank-cell", source);
    const plan = setDirectCriterion(manifest, {
      name: "构件甲厚度",
      requirement: "潮湿条件下厚度允许偏差±1mm",
      method: "游标卡尺",
      semanticFragment: "构件甲检查：厚度；单位mm；条件潮湿；允许偏差±1；方法游标卡尺",
      table: {
        table_id: "semantic-table:component-a",
        table_no: "",
        table_title: "构件甲检查",
        applicability: "构件甲",
        row_path: ["厚度"],
        column_path: ["允许偏差"],
        unit: "mm",
        condition: "潮湿",
        allowed_value: "±1",
        inspection_method: "游标卡尺",
      },
      cells: [
        { role: "table_title", text: "构件甲检查" },
        { role: "applicability", text: "构件甲" },
        { role: "row_header", text: "厚度" },
        { role: "column_header", text: "允许偏差" },
        { role: "unit", text: "mm" },
        { role: "condition", text: "潮湿" },
        { role: "allowed_value", text: "±1" },
        { role: "inspection_method", text: "游标卡尺" },
      ],
    });

    const secondRecord = locate(
      manifest,
      "构件乙检查：厚度；单位%；条件干燥；允许偏差±2；检验方法留空",
    );
    const second = structuredClone(plan.acceptance_items[0]!);
    second.item_id = "item:component-b-thickness";
    second.name = "构件乙厚度";
    second.requirement = "干燥条件下厚度允许偏差±2%";
    second.method = "";
    second.evidence_ids = [secondRecord.evidence_id];
    second.reference_evidence_ids = [];
    second.inspection_data_type_evidence_ids = [secondRecord.evidence_id];
    second.field_bindings = buildItemFieldBindings({
      name: second.name,
      requirement: second.requirement,
      method: second.method,
      quantity: second.quantity,
      note: second.note,
    }, second.evidence_ids, manifest);
    second.field_bindings.requirement = exactBinding(second.requirement, [{
      evidence_id: secondRecord.evidence_id,
      text: "构件乙检查：厚度；单位%；条件干燥；允许偏差±2；检验方法留空",
    }]);
    second.table_semantics = {
      source_kind: "direct",
      table_id: "semantic-table:component-b",
      table_no: "",
      table_title: "构件乙检查",
      applicability: "构件乙",
      row_path: ["厚度"],
      column_path: ["允许偏差"],
      unit: "%",
      condition: "干燥",
      allowed_value: "±2",
      inspection_method: "",
      cell_evidence: [
        { role: "table_title", evidence_id: secondRecord.evidence_id, text: "构件乙检查" },
        { role: "applicability", evidence_id: secondRecord.evidence_id, text: "构件乙" },
        { role: "row_header", evidence_id: secondRecord.evidence_id, text: "厚度" },
        { role: "column_header", evidence_id: secondRecord.evidence_id, text: "允许偏差" },
        { role: "unit", evidence_id: secondRecord.evidence_id, text: "%" },
        { role: "condition", evidence_id: secondRecord.evidence_id, text: "干燥" },
        { role: "allowed_value", evidence_id: secondRecord.evidence_id, text: "±2" },
      ],
      reference_fragments: [],
    };
    plan.acceptance_items.push(second);
    plan.inspection_lots[0]!.item_ids.push(second.item_id);
    const sharedDisposition = plan.evidence_dispositions.find(
      (disposition) => disposition.evidence_id === secondRecord.evidence_id,
    );
    if (!sharedDisposition) throw new Error("missing shared evidence disposition");
    sharedDisposition.item_ids.push(second.item_id);
    plan.semantic_evidence.push({
      semantic_id: "semantic:component-b-thickness",
      role: "table_criterion",
      evidence_id: secondRecord.evidence_id,
      exact_fragment: "构件乙检查：厚度；单位%；条件干燥；允许偏差±2；检验方法留空",
      parent_semantic_id: "",
      materialized_item_id: second.item_id,
      reason: "同名行按验收对象和单位保持独立，空白方法不虚构内容",
    });

    const opened = new Set(manifest.evidence.map((record) => record.evidence_id));
    const validation = validatePlanText(prettyJson(plan), manifest, opened);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    const items = materialize(plan, manifest, String(validation.fingerprint))
      .result.inspection_lots[0]!.items;
    expect(items.map((item) => item.name)).toEqual(["构件甲厚度", "构件乙厚度"]);
    expect(items.map((item) => item.table_semantics?.unit)).toEqual(["mm", "%"]);
    expect(items[1]!.table_semantics?.inspection_method).toBe("");
  });

  test("accepts a one-dimensional criterion without inventing a missing column axis", async () => {
    const source = "对象质量应满足设计要求。构件厚度允许偏差±1mm，用游标卡尺检查。";
    const manifest = await prepareAgentManifest("one-dimensional-table-criterion", source);
    const plan = setDirectCriterion(manifest, {
      name: "构件厚度允许偏差",
      requirement: "构件厚度允许偏差±1mm，用游标卡尺检查。",
      method: "用游标卡尺检查",
      semanticFragment: "构件厚度允许偏差±1mm，用游标卡尺检查。",
      table: {
        table_id: "semantic-table:one-dimensional",
        table_no: "",
        table_title: "",
        applicability: "构件",
        row_path: ["厚度"],
        column_path: [],
        unit: "mm",
        condition: "",
        allowed_value: "±1",
        inspection_method: "用游标卡尺检查",
      },
      cells: [
        { role: "applicability", text: "构件" },
        { role: "row_header", text: "厚度" },
        { role: "unit", text: "mm" },
        { role: "allowed_value", text: "±1" },
        { role: "inspection_method", text: "用游标卡尺检查" },
      ],
    });

    const validation = validatePlanText(
      prettyJson(plan),
      manifest,
      new Set(manifest.evidence.map((record) => record.evidence_id)),
    );
    expect(validation).toMatchObject({ ok: true, issues: [] });
  });

  test("rejects table shells and unverifiable cell evidence", async () => {
    const source = "对象质量应满足设计要求。表 无内容记录模板：项目____ 允许值____ 方法____。";
    const manifest = await prepareAgentManifest("negative-empty-template", source);
    const rules = buildPlanContract(manifest).rules.join("\n");
    expect(rules).toContain("Blank record templates");
    expect(rules).toContain("Do not collapse multiple independently judged rows");
    expect(rules).toContain("can pass or fail independently");
    expect(rules).toContain("after removing mutually exclusive ranges");
    expect(rules).toContain("bare property name would be ambiguous outside the table");

    const plan = validFixturePlan(manifest);
    const item = plan.acceptance_items[0]!;
    item.table_semantics = {
      source_kind: "direct",
      table_id: "template",
      table_no: "",
      table_title: "无内容记录模板",
      applicability: "",
      row_path: ["项目"],
      column_path: ["允许值"],
      unit: "",
      condition: "",
      allowed_value: "",
      inspection_method: "",
      cell_evidence: [
        { role: "row_header", evidence_id: item.evidence_ids[0]!, text: "项目" },
        { role: "column_header", evidence_id: item.evidence_ids[0]!, text: "允许值" },
        { role: "allowed_value", evidence_id: item.evidence_ids[0]!, text: "不存在的允许值" },
      ],
      reference_fragments: [],
    };
    const validation = validatePlanText(prettyJson(plan), manifest);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "schema",
    ]));
  });
});
