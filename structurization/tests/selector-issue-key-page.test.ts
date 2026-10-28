import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { prettyJson } from "../src/canonical.js";
import { ToolController } from "../src/tools.js";
import { buildSelectorStageScenario, currentFingerprint } from "./selector-stage-fixture.js";

async function scenario(count = 4, detailSize = 0) {
  const { workspace, controller } = await buildSelectorStageScenario();
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  const issues = Array.from({ length: count }, (_, index) => ({ code: "neutral_source_review", path: "/items/" + index,
    message: "核对已读的合成来源", actual: { index, source: "neutral-source", detail: "中性详情".repeat(detailSize) },
    how_to_pass: "依原文独立判断并保存完整记录", writable_paths: ["/items", "/references"],
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "neutral-" + index } }));
  await (controller as any).saveSelectorDiagnostics(issues, selectors);
  const fingerprint = await currentFingerprint(controller);
  return { workspace, controller, selectors, issues, fingerprint };
}

test("keyed reads deliver one complete issue with truthful pagination and an executable current directory hint", async () => {
  const { workspace, controller, selectors, fingerprint } = await scenario();
  const first = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
  const original = first.selector_issues as any[];
  const key = (first.selector_issue_page as any).issue_index[1].issue_key;
  const state = await workspace.readState(), registry = await workspace.readSourceSpanRegistry();
  const before = JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8"));
  const evaluate = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
  const result = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: key });
  expect(result.selector_issues).toEqual([original[1]]);
  expect(result.selector_issue_page).toMatchObject({ cursor: 1, reported_issue_count: 1, total_issue_count: 4,
    remaining_issue_count: 2, next_cursor: 2, indexed_issue_count: 1, index_complete: false,
    reported_issue_utf8_bytes: Buffer.byteLength(JSON.stringify(original[1]), "utf8"),
    issue_index: [{ index: 1, issue_key: key, detail_in_page: true }] });
  expect(result.selector_issue_index_read).toEqual({ tool: "read_target_selector_issues",
    arguments: { draft_fingerprint: fingerprint, cursor: 0 }, readonly: true });
  const hint = result.selector_issue_index_read as any;
  const directory = await controller.dispatch(hint.tool, hint.arguments);
  expect(directory.selector_issue_page).toEqual(first.selector_issue_page);
  expect(directory.selector_issues).toEqual(original);
  const lastKey = (directory.selector_issue_page as any).issue_index[3].issue_key;
  expect((await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: lastKey })).selector_issue_page)
    .toMatchObject({ cursor: 3, reported_issue_count: 1, remaining_issue_count: 0, next_cursor: null });
  const after = JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8"));
  expect(after.issues).toEqual(before.issues);
  expect(after.convergence).toEqual(before.convergence);
  expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))).toEqual(selectors);
  expect(await workspace.readSourceSpanRegistry()).toEqual(registry);
  const { next_event_sequence: _a, ...beforeState } = state;
  const { next_event_sequence: _b, ...afterState } = await workspace.readState();
  expect(afterState).toEqual(beforeState);
  expect(evaluate).not.toHaveBeenCalled();
});

test("byte bounded keyed reads preserve actual facts and ordinary cursor pagination", async () => {
  const { controller, fingerprint } = await scenario(40, 2000);
  const first = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
  const index = (first.selector_issue_page as any).issue_index;
  const selected = index[8];
  const cursor = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 8 });
  const result = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: selected.issue_key });
  expect(result.selector_issues).toEqual([(cursor.selector_issues as any[])[0]]);
  expect((result.selector_issues as any[])[0].actual.detail).toHaveLength(8000);
  expect(result.selector_issue_page).toMatchObject({ cursor: 8, reported_issue_count: 1, next_cursor: 9,
    remaining_issue_count: 31, indexed_issue_count: 1, issue_index: [{ index: 8, detail_in_page: true }] });
  expect((cursor.selector_issue_page as any).reported_issue_count).toBeGreaterThan(1);
  expect((cursor.selector_issue_page as any).next_cursor).toBe(8 + (cursor.selector_issues as any[]).length);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(Buffer.byteLength(JSON.stringify(cursor), "utf8"));
});

test("directory hints survive controller reconstruction while request, key and true stale gates remain", async () => {
  const { workspace, controller, selectors, fingerprint } = await scenario();
  const first = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
  const key = (first.selector_issue_page as any).issue_index[2].issue_key;
  const resumed = await ToolController.create(workspace);
  const mismatch = await resumed.dispatch("read_target_selector_issues", { draft_fingerprint: "wrong", issue_key: key });
  expect(mismatch).toMatchObject({ ok: false, error: "selector_issue_request_fingerprint_mismatch",
    next_tool_arguments: { draft_fingerprint: fingerprint, issue_key: key } });
  const result = await resumed.dispatch(mismatch.next_tool as string, mismatch.next_tool_arguments as any);
  expect(result).toMatchObject({ ok: true, validation_performed: false, budget_consumed: false,
    selector_issue_page: { cursor: 2, reported_issue_count: 1, next_cursor: 3 } });
  expect(await resumed.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: "unknown" }))
    .toMatchObject({ ok: false, error: "selector_issue_key_unknown", next_tool_arguments: { draft_fingerprint: fingerprint, cursor: 0 } });
  selectors.lots.push({ key: "neutral-new-lot", name: "中性分组", scope_span_ids: [], reason: "草稿改变使快照失效" });
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  const hint = result.selector_issue_index_read as any;
  expect(await resumed.dispatch(hint.tool, hint.arguments))
    .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
});
