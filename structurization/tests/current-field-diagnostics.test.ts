import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { ToolController } from "../src/tools.js";
import { selectorDiagnosticToolResponse } from "../src/selector-diagnostics.js";
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, fullSpanFor, seedPlan } from "./selector-stage-fixture.js";

async function pendingFixture() {
  const scenario = await buildSelectorStageScenario([
    "# 2 虚构包装件", "", "## 2.1 封口检查", "",
    "2.1.1 封口表面应连续。检验数量：每批抽查7件。", "",
    "2.1.2 标签应清楚。检验数量：每批抽查5件。", "",
    "2.1.3 接缝应平整。", "",
  ].join("\n"));
  const { workspace, manifest } = scenario;
  const record = clauseRecord(manifest, "2.1.3");
  const span = fullSpanFor(await workspace.readSourceSpanRegistry(), record.evidence_id, record.text.length);
  const selectors = seedPlan(manifest, span);
  selectors.lots[0].name = "封口检查";
  selectors.items[0].name = "接缝平整";
  selectors.items[0].sampling.status = "pending";
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await workspace.updateState(state => { state.selector_stage = "sampling"; });
  return { ...scenario, selectors, controller: await ToolController.create(workspace) };
}

describe("current field diagnostics without a full preflight", () => {
  test("stale recovery exposes pending required decisions, with executable LSP details and no business mutations", async () => {
    const { workspace, controller, selectors } = await pendingFixture();
    await (controller as any).saveSelectorDiagnostics([{ code: "old", path: "/items" }], selectors);
    const path = join(workspace.root, "selector-diagnostics.json");
    await atomicWriteJson(path, { ...JSON.parse(await readFile(path, "utf8")), contract_version: "old-contract" });
    const fingerprint = await currentFingerprint(controller);
    const paths = [workspace.workingSelectorPath, workspace.sourceSpanRegistryPath,
      workspace.evidenceManifestPath, workspace.sourceMarkdownPath, path];
    const bytes = await Promise.all(paths.map(path => readFile(path)));
    const { next_event_sequence: _before, ...before } = await workspace.readState();
    const preflight = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
    const compile = vi.spyOn(controller as any, "selectorCompilerIssues");
    const stale = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
    expect(stale).toMatchObject({ next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
    const response = await controller.dispatch(String(stale.next_tool), stale.next_tool_arguments as any);
    expect(response).toMatchObject({ ok: true, diagnostics_reused: false, full_stage_check_performed: false,
      budget_consumed: false, author_draft_mutation: false,
      selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_sampling_decision_pending" })]) });
    const visible = selectorDiagnosticToolResponse(response) as any;
    const issue = visible.selector_issues.find((row: any) => row.code === "selector_sampling_decision_pending");
    expect(issue).toMatchObject({ severity: "error", decision_owner: "program", record: { key: selectors.items[0].key },
      expected: { status: expect.any(Array) }, full_details: { tool: "get_target_context" } });
    const detail = await controller.dispatch(issue.full_details.tool, issue.full_details.arguments);
    expect(detail).toMatchObject({ diagnostics_reused: true, diagnostic_detail_mode: "full",
      selector_issues: [expect.objectContaining({ code: issue.code })] });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(preflight).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(bytes);
    const { next_event_sequence: _after, ...after } = await workspace.readState();
    expect(after).toEqual(before);
  });

  test("cache survives controller recovery, invalidates on real edits, and never reuses old detail coordinates", async () => {
    const { workspace, controller, selectors } = await pendingFixture();
    const first = await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 });
    const resumed = await ToolController.create(workspace);
    const compile = vi.spyOn(resumed as any, "selectorCompilerIssues");
    expect(await resumed.dispatch("get_target_context", { field_diagnostic_cursor: 0 }))
      .toMatchObject({ diagnostics_reused: true });
    expect(compile).not.toHaveBeenCalled();
    selectors.items[0].sampling.status = "fallback";
    await workspace.writeWorkingSelectors(JSON.stringify(selectors));
    expect(await resumed.dispatch("get_target_context", { field_diagnostic_cursor: 0,
      field_diagnostic_fingerprint: first.field_diagnostic_fingerprint, field_diagnostic_detail_mode: "full" }))
      .toMatchObject({ ok: false, error: "selector_field_diagnostic_page_stale", next_tool_arguments: { field_diagnostic_cursor: 0 } });
    expect(compile).not.toHaveBeenCalled();
    const fresh = await resumed.dispatch("get_target_context", { field_diagnostic_cursor: 0 });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(fresh).toMatchObject({ diagnostics_reused: false, global_completeness_checked: false });
    expect(fresh.selector_issues).not.toContainEqual(expect.objectContaining({ code: "selector_sampling_decision_pending" }));
    expect(fresh.instruction).toContain("不等于阶段通过或业务正确");
  });

  test("read receipts are cache dependencies; diagnostic reads never earn those receipts", async () => {
    const { workspace, controller, manifest } = await pendingFixture();
    await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 });
    const compile = vi.spyOn(controller as any, "selectorCompilerIssues");
    const before = await workspace.readState();
    const source = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: source.evidence_id, cursor: 0 })).toMatchObject({ ok: true });
    const readState = await workspace.readState();
    expect(readState.opened_evidence_ids).not.toEqual(before.opened_evidence_ids);
    expect(await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 })).toMatchObject({ diagnostics_reused: false });
    expect(await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 })).toMatchObject({ diagnostics_reused: true });
    expect(compile).toHaveBeenCalledTimes(1);
    expect((await workspace.readState()).opened_evidence_ids).toEqual(readState.opened_evidence_ids);
    expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  });
});
