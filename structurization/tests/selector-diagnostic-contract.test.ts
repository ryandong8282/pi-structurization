import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { ToolController } from "../src/tools.js";
import { buildSelectorStageScenario, currentFingerprint } from "./selector-stage-fixture.js";

const issue = { code: "selector_neutral_obligation", path: "/items", message: "合成义务需重新核对。",
  actual: { missing_units: ["synthetic-unit"] }, how_to_pass: "核对合成来源与作者记录。" };

test.each([undefined, "selector-stage-diagnostics/v17"])(
  "diagnostic contract %s cannot replay details or count old blockers against unchanged inputs", async version => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    await (controller as any).saveSelectorDiagnostics([issue], selectors);
    const observations = (await controller.selectorBlockingIssues())!;
    await controller.recordSelectorBlockingProgress(observations, observations);
    await controller.recordSelectorBlockingProgress(observations, observations);
    const path = join(workspace.root, "selector-diagnostics.json");
    const old = JSON.parse(await readFile(path, "utf8"));
    const currentContract = old.contract_version;
    if (version === undefined) delete old.contract_version;
    else old.contract_version = version;
    await atomicWriteJson(path, old);
    const restored = await ToolController.create(workspace);
    const protectedPaths = [workspace.workingSelectorPath, workspace.sourceSpanRegistryPath,
      workspace.evidenceManifestPath, workspace.sourceMarkdownPath];
    const protectedBytes = await Promise.all(protectedPaths.map(path => readFile(path)));
    const stateBefore = await workspace.readState();
    const fingerprint = await currentFingerprint(restored);
    const evaluate = vi.spyOn(restored as any, "evaluateTargetSelectorPreflight");
    const result = await restored.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
    expect(result).toMatchObject({ ok: false, error: "selector_issue_snapshot_stale",
      validation_performed: false, budget_consumed: false,
      actual: { current_draft_fingerprint: fingerprint, snapshot_fingerprint: fingerprint,
        stale_dependencies: [{ dependency: "contract_version", snapshot_value: version ?? null,
          current_value: currentContract }] },
      next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
    expect(result).not.toHaveProperty("selector_issues");
    const dormant = (await restored.selectorBlockingIssues())!;
    expect(dormant).toEqual(observations.map(row => ({ ...row, assessed: false })));
    expect(await restored.recordSelectorBlockingProgress(observations, observations)).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(old);
    const summary = await restored.selectorBlockingSummary();
    expect(summary).toContain("诊断契约");
    expect(summary).toContain("get_target_context");
    expect(summary).not.toContain('"next_tool":"read_target_selector_issues"');
    expect(summary).not.toContain(issue.message);

    await (restored as any).saveLocalSelectorBlockerAssessment([], selectors);
    const afterLocal = JSON.parse(await readFile(path, "utf8"));
    expect(afterLocal.probes).toEqual(old.probes.map((probe: object) => ({ ...probe, assessed: false })));
    expect(afterLocal.convergence).toEqual(old.convergence);
    expect(afterLocal.contract_version).toBe(version);
    expect(await restored.recordSelectorBlockingProgress(dormant, await restored.selectorBlockingIssues())).toBeUndefined();

    // A new assessment makes only its observed obligations current; it keeps the prior history.
    await (restored as any).saveSelectorDiagnostics([issue], selectors);
    const fresh = JSON.parse(await readFile(path, "utf8"));
    expect(fresh.contract_version).toBe(currentContract);
    expect(fresh.convergence).toEqual(old.convergence);
    expect(await restored.selectorBlockingIssues()).toEqual(observations);
    expect(await restored.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint }))
      .toMatchObject({ ok: true, validation_performed: false, budget_consumed: false,
        selector_issues: [expect.objectContaining({ code: issue.code })] });
    expect(JSON.parse(await readFile(path, "utf8")).convergence).toEqual(old.convergence);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await Promise.all(protectedPaths.map(path => readFile(path)))).toEqual(protectedBytes);
    const { next_event_sequence: _before, ...before } = stateBefore;
    const { next_event_sequence: _after, ...after } = await workspace.readState();
    expect(after).toEqual(before);
    expect(old.convergence.blockers[0].unchanged_rounds).toBe(2);
  });

test("an obsolete diagnostic snapshot is disclosed even before any unchanged-blocker history exists", async () => {
  const { workspace, controller } = await buildSelectorStageScenario();
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  await (controller as any).saveSelectorDiagnostics([issue], selectors);
  const path = join(workspace.root, "selector-diagnostics.json");
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  await atomicWriteJson(path, { ...snapshot, contract_version: "selector-stage-diagnostics/v17" });
  const before = await readFile(path, "utf8");
  const summary = await controller.selectorBlockingSummary();
  expect(summary).toContain("问题快照已过期");
  expect(summary).toContain("诊断契约");
  expect(summary).toContain("get_target_context");
  expect(summary).not.toContain(issue.message);
  expect(await readFile(path, "utf8")).toBe(before);
});
