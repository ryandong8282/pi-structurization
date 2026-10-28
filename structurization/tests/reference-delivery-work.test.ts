import { readFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { ToolController, createPiTools } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

async function fixture() {
  const scenario = await buildSelectorStageScenario(["# 2 虚构检测盒", "", "## 2.1 检查", "",
    "2.1.1 检测盒封口应连续。检验数量：每批3件。", ""].join("\n"));
  const source = clauseRecord(scenario.manifest, "2.1.1");
  const span = fullSpanFor(await scenario.workspace.readSourceSpanRegistry(), source.evidence_id, source.text.length);
  const selectors = seedPlan(scenario.manifest, span);
  selectors.items = [itemRecord("seal", "封口连续性", "主控项目", span, "虚构来源。")];
  await scenario.workspace.writeWorkingSelectors(JSON.stringify(selectors));
  return scenario;
}

test("an empty references collection offers creation, not a nonexistent read key", async () => {
  const { workspace } = await fixture();
  const controller = await ToolController.create(workspace);
  const before = await workspace.readState();
  const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const output = await controller.dispatch("read_target_selectors", { collection: "references" });
  expect(output).toMatchObject({ ok: true, rows: [], collection_empty: true,
    required_action: "create_source_grounded_records", writable_paths: ["/references"], save_tool: "stage_target_selector_draft" });
  expect(output).not.toHaveProperty("next_tool_arguments.key");
  expect(output.instruction).toContain("没有可读取的 key");
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
});

test("an empty page of a populated collection routes to its actual index", async () => {
  const { workspace } = await fixture();
  const controller = await ToolController.create(workspace);
  expect(await controller.dispatch("read_target_selectors", { collection: "items", cursor: 99 }))
    .toMatchObject({ collection_empty: false, required_action: "read_collection_from_start",
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", cursor: 0 } });
  const normal = await controller.dispatch("read_target_selectors", { collection: "items" });
  expect(normal).toMatchObject({ required_action: "read_full_record_by_key", rows: [{ key: "seal" }] });
});

test("neutral chapter reference delivers all requested bodies across real controller restarts", async () => {
  const markdown = ["# 2 虚构转接盒验收", "", "## 2.1 主控项目", "",
    "2.1.1 转接盒检查应符合附录 B 的规定。检验数量：每批3件。", "",
    "# 附录 B 虚构转接盒检查", "",
    ...Array.from({ length: 64 }, (_, i) => [`虚构条目${i + 1}：记录检测状态。`, ""]).flat(),
  ].join("\n");
  const { workspace, manifest, controller } = await buildSelectorStageScenario(markdown);
  const origin = clauseRecord(manifest, "2.1.1");
  const span = fullSpanFor(await workspace.readSourceSpanRegistry(), origin.evidence_id, origin.text.length);
  const resolved = await controller.dispatch("resolve_document_reference", {
    origin_span_id: span, raw_reference: "附录 B", target: { kind: "appendix", number: "B" }, relation: "shared_appendix_requirement",
  });
  expect(resolved).toMatchObject({ ok: true, analysis_mode: "isolated" });
  const catalog = await controller.dispatch("read_reference_facts", { target_key: resolved.target_key });
  const ids = (catalog.catalog as any[]).map(row => row.entry_id);
  for (const id of ids) await controller.dispatch("read_reference_facts", { target_key: resolved.target_key, entry_ids: [id] });
  const before = await workspace.readState();
  const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
  let output = await controller.dispatch("read_reference_facts", { target_key: resolved.target_key, entry_ids: ids });
  expect(output).toMatchObject({ disposition: { pending: 0 }, delivery: { complete: false } });
  let remainingCalls = 0;
  while ((output.delivery as any).complete === false) {
    const restarted = await ToolController.create(workspace);
    const current = await restarted.selectorExecutionWork();
    expect(current).toMatchObject({ code: "reference_source_delivery_pending" });
    const args = output.next_tool_arguments as Record<string, unknown>;
    expect(Check(createPiTools(restarted).find(tool => tool.name === "read_reference_facts")!.parameters, args)).toBe(true);
    output = await restarted.dispatch("read_reference_facts", args);
    expect(output.ok).toBe(true);
    expect(++remainingCalls).toBeLessThan(4);
  }
  expect(remainingCalls).toBe(2);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
});

test("requested text delivery survives controller restart and precedes author repair without spending checks", async () => {
  const { workspace } = await fixture();
  const targetKey = `reference-target:${"a".repeat(64)}`;
  await workspace.updateState(state => {
    state.reference_catalog_dispositions = { [`target:${targetKey}`]: {
      fingerprint: "neutral", rule_source: "fallback", entry_ids: ["seg:1", "seg:2"],
      used: ["seg:1", "seg:2"], ignored: [],
      pending_delivery: [{ entry_id: "seg:2", row_cursor: 3, row_offset: 7 }],
    } };
  });
  const before = await workspace.readState();
  const controller = await ToolController.create(workspace);
  const work = await controller.selectorExecutionWork();
  expect(work).toMatchObject({ code: "reference_source_delivery_pending", diagnostic_read: {
    tool: "read_reference_facts", arguments: { target_key: targetKey, entry_ids: ["seg:2"], row_cursor: 3, row_offset: 7 },
  } });
  expect(Check(createPiTools(controller).find(tool => tool.name === "read_reference_facts")!.parameters, work!.diagnostic_read.arguments)).toBe(true);
  const context = await controller.dispatch("get_target_context", {});
  expect(context).toMatchObject({ current_work: { code: work!.code }, next_tool_arguments: work!.diagnostic_read.arguments });
  const refused = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
  expect(refused).toMatchObject({ ok: false, error: work!.code, budget_consumed: false,
    next_tool_arguments: work!.diagnostic_read.arguments });
  expect(await controller.dispatch("report_target_blocker", { kind: "ambiguous_source" }))
    .toMatchObject({ error: work!.code, terminal: false });
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
});
