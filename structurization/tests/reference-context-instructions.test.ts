import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Check } from "typebox/value";

import { ModelSourceHandles } from "../src/model-source-handles.js";
import { createPiTools, ToolController } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor } from "./selector-stage-fixture.js";

const markdown = [
  "# 2 构件检查", "", "## 2.1 构件检查要求", "",
  "2.1.1 构件甲应符合本规程第9.1.1条的规定。", "",
  "2.1.2 构件乙应符合本规程第10.1节的规定。", "",
  "2.1.3 标识应清晰。检验数量：全数检查。", "",
  "# 9 检查方法", "", "9.1.1 用量规检查构件甲。", "",
  "# 10 详细规则", "", "## 10.1 构件乙规则", "",
  ...Array.from({ length: 26 }, (_, i) => `10.1.${i + 1} 构件乙第${i + 1}项应符合对应尺寸要求。`),
].join("\n");

async function referenceScenario() {
  const fixture = await buildSelectorStageScenario(markdown);
  const registry = await fixture.workspace.readSourceSpanRegistry();
  for (const [clause, literal, kind, number] of [
    ["2.1.1", "本规程第9.1.1条", "clause", "9.1.1"],
    ["2.1.2", "本规程第10.1节", "section", "10.1"],
  ] as const) {
    const source = clauseRecord(fixture.manifest, clause);
    const result = await fixture.controller.dispatch("resolve_document_reference", {
      origin_span_id: fullSpanFor(registry, source.evidence_id, source.text.length),
      raw_reference: literal, target: { kind, number }, relation: "中性来源访问验证",
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  }
  return fixture;
}

test.each(["get_target_context", "list_evidence_resources"])(
  "%s supplies executable copied source routes for direct, inline and isolated evidence",
  async directory => {
    const { workspace, controller } = await referenceScenario();
    const handles = await ModelSourceHandles.open(workspace.root);
    const tools = handles.wrapTools(createPiTools(controller));
    const stateBefore = await workspace.readState();
    const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
    const result = await tools.find(tool => tool.name === directory)!.execute("directory", { limit: 100 }, undefined as never, undefined as never);
    const output = JSON.parse((result.content.find(block => block.type === "text") as { text: string }).text);
    expect(output.ok, JSON.stringify(output)).toBe(true);
    expect(output.instruction).toContain("tool_arguments 原样作为参数调用 read_tool");
    const resources = (output.resource_inventory ?? output.resources) as any[];
    const selected = ["direct", "inline_reference", "isolated_reference"].map(mode => {
      const row = resources.find(resource => resource.access_mode === mode);
      expect(row, mode).toBeDefined();
      return row;
    });
    const afterDirectory = await workspace.readState();
    expect(afterDirectory.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
    expect(afterDirectory.validation_attempts).toBe(stateBefore.validation_attempts);
    expect(afterDirectory.selector_protocol).toEqual(stateBefore.selector_protocol);
    for (const row of selected) {
      const tool = tools.find(candidate => candidate.name === row.read_tool)!;
      const args = { ...row.tool_arguments, source_handle_scope: output.source_handle_scope };
      expect(Check(tool.parameters, args), row.read_tool).toBe(true);
      if (row.access_mode === "direct") {
        expect(row.tool_arguments).toEqual({ evidence_id: row.evidence_id, cursor: 0 });
        expect(row.evidence_id).toMatch(/^e\d+$/u);
      } else {
        expect(row.tool_arguments.target_key).toBe(row.target_key);
        expect(row.target_key).toMatch(/^t\d+$/u);
        expect(row.tool_arguments).not.toHaveProperty("evidence_id");
      }
      if (row.access_mode === "isolated_reference") {
        expect(row).not.toHaveProperty("text");
        expect(row).not.toHaveProperty("locator");
        expect(row.open_evidence_allowed).toBe(false);
        const rejected = await tools.find(candidate => candidate.name === "open_evidence")!.execute("forbidden", {
          evidence_id: row.evidence_id, source_handle_scope: output.source_handle_scope,
        }, undefined as never, undefined as never);
        expect(rejected.details).toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
      }
      const read = await tool.execute(`read-${row.access_mode}`, args, undefined as never, undefined as never);
      expect(read.details, JSON.stringify(read.details)).toMatchObject({ ok: true });
      if (row.access_mode === "isolated_reference") expect(read.details).toHaveProperty("catalog");
    }
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
    expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
  },
);

test("occurrence inventory selects its declared reader and reuses registered identities without resolving again", async () => {
  const { workspace, controller } = await referenceScenario();
  const occurrencesBefore = (await workspace.readEvidenceManifest()).reference_occurrences;
  const stateBefore = await workspace.readState();
  const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const handles = await ModelSourceHandles.open(workspace.root);
  const tools = handles.wrapTools(createPiTools(controller));
  const listed = await tools.find(tool => tool.name === "list_reference_occurrences")!.execute(
    "occurrence-inventory", { limit: 100 }, undefined as never, undefined as never,
  );
  const inventory = JSON.parse((listed.content.find(block => block.type === "text") as { text: string }).text);
  expect(inventory.ok).toBe(true);
  expect(inventory.instruction).toContain("analysis_mode=inline 时调用 read_document_reference_evidence");
  expect(inventory.instruction).toContain("analysis_mode=isolated 时调用 read_reference_facts");
  expect(inventory.instruction).toContain("不为取得读取编号重复解析同一引用");
  for (const [literal, mode, reader] of [
    ["本规程第9.1.1条", "inline", "read_document_reference_evidence"],
    ["本规程第10.1节", "isolated", "read_reference_facts"],
  ]) {
    const occurrence = inventory.occurrences.find((row: any) => row.raw_reference === literal);
    expect(occurrence).toMatchObject({ status: "resolved", analysis_mode: mode, target_key: expect.stringMatching(/^t\d+$/u) });
    expect(occurrence.origin_evidence_id).toMatch(/^e\d+$/u);
    expect(occurrence.target_evidence_count).toBeGreaterThan(0);
    const tool = tools.find(candidate => candidate.name === reader)!;
    const args = { target_key: occurrence.target_key, source_handle_scope: inventory.source_handle_scope };
    expect(Check(tool.parameters, args)).toBe(true);
    const read = await tool.execute(`occurrence-${mode}`, args, undefined as never, undefined as never);
    expect(read.details, JSON.stringify(read.details)).toMatchObject({ ok: true });
    if (mode === "isolated") expect(read.details).toHaveProperty("catalog");
  }
  expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual(occurrencesBefore);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
  expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
});

test("blank context has no history advice; a real saved investigation retains its advisory status", async () => {
  const { workspace, controller, manifest } = await buildSelectorStageScenario(markdown);
  const blank = await controller.dispatch("get_target_context", {});
  expect(blank).toMatchObject({ current_selector_state: "blank", investigation_checkpoint: null,
    table_structure_checkpoint: { confirmed_tables: [], pending_tables: [], instruction: "当前没有登记的表结构。" } });
  expect(blank).not.toHaveProperty("investigation_checkpoint_instruction");
  expect(blank).not.toHaveProperty("investigation_checkpoint_advisory_only");
  const checkpoint = { evidence_fingerprint: manifest.evidence_fingerprint, summary: "原文阅读到检查方法，尚未形成业务记录。" };
  await writeFile(join(workspace.root, "investigation-checkpoint.json"), JSON.stringify(checkpoint), "utf8");
  const resumed = await ToolController.create(workspace);
  const context = await resumed.dispatch("get_target_context", {});
  expect(context).toMatchObject({ current_selector_state: "blank", investigation_checkpoint: checkpoint,
    investigation_checkpoint_advisory_only: true });
  expect(context.investigation_checkpoint_instruction).toContain("不是程序约束、验证结论或终止授权");
});

test("table instructions distinguish pending decisions from already confirmed structure", async () => {
  const source = ["# 2 构件检查", "", "## 2.1 构件检查要求", "",
    "2.1.1 构件外观应符合表2.1.1规定。检验数量：全数检查。", "", "表2.1.1 构件外观要求", "",
    "<table><tr><td>项目</td><td>要求</td></tr><tr><td>标识</td><td>应清晰</td></tr></table>", ""].join("\n");
  const { workspace, controller } = await buildSelectorStageScenario(source);
  const pending = await controller.dispatch("get_target_context", {}) as any;
  expect(pending.table_structure_checkpoint.pending_tables.length).toBeGreaterThan(0);
  expect(pending.table_structure_checkpoint.instruction).toContain("尚待确认");
  expect(pending.table_structure_checkpoint.instruction).not.toContain("恢复会话先");
  const saved = await controller.dispatch("read_saved_table_structure", {}) as any;
  const table = saved.structure.tables[0];
  // Seed a persisted structure decision to exercise the resumed-context wording.
  const path = join(workspace.root, "table-structure.json");
  const plan = { ...saved.structure, evidence_fingerprint: (await workspace.readEvidenceManifest()).evidence_fingerprint };
  plan.tables.find((candidate: any) => candidate.table_key === table.table_key).status = "confirmed";
  await writeFile(path, JSON.stringify(plan), "utf8");
  const resumed = await ToolController.create(workspace);
  const context = await resumed.dispatch("get_target_context", {}) as any;
  expect(context.table_structure_checkpoint.confirmed_tables).toEqual(expect.arrayContaining([
    { table_key: table.table_key, fragment_ids: table.fragment_ids },
  ]));
  expect(context.table_structure_checkpoint.instruction).toContain("已有已确认的表结构");
  expect(context.table_structure_checkpoint.instruction).toContain("复用已确认 fragment");
});
