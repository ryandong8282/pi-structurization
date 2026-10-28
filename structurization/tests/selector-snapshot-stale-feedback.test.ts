import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Json } from "../src/canonical.js";
import { buildSelectorStageScenario, clauseRecord, currentFingerprint } from "./selector-stage-fixture.js";

type Scenario = Awaited<ReturnType<typeof buildSelectorStageScenario>>;

async function seedSnapshot({ workspace, controller }: Scenario) {
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  await (controller as any).saveSelectorDiagnostics([{
    code: "neutral_obligation", path: "/items/0/fields/requirement", message: "核对合成条文。",
  }], selectors);
  return JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8"));
}

async function registerNewSpan({ manifest, controller }: Scenario) {
  const source = clauseRecord(manifest, "2.1.3");
  await controller.dispatch("read_target_selectors", { collection: "items" });
  expect(await controller.dispatch("open_evidence", { evidence_id: source.evidence_id, cursor: 0 }))
    .toMatchObject({ ok: true });
  expect(await controller.dispatch("locate_evidence_span", {
    evidence_id: source.evidence_id, quote: "桩基施工前",
  })).toMatchObject({ ok: true });
}

describe("selector stale-snapshot repair feedback", () => {
  test("a new source span explains staleness when draft fingerprints are equal, and the given refresh works", async () => {
    const scenario = await buildSelectorStageScenario();
    const { workspace, controller } = scenario;
    const fingerprint = await currentFingerprint(controller);
    expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint }))
      .toMatchObject({ ok: false });
    const diagnosticPath = join(workspace.root, "selector-diagnostics.json");
    const saved = JSON.parse(await readFile(diagnosticPath, "utf8"));
    await registerNewSpan(scenario);
    expect(await currentFingerprint(controller)).toBe(fingerprint);
    const registryFingerprint = sha256Json(await workspace.readSourceSpanRegistry());
    expect(registryFingerprint).not.toBe(saved.registry_fingerprint);
    const protectedPaths = [workspace.workingSelectorPath, workspace.sourceSpanRegistryPath,
      workspace.evidenceManifestPath, workspace.sourceMarkdownPath, diagnosticPath];
    const protectedBytes = await Promise.all(protectedPaths.map(path => readFile(path)));
    const stateBefore = await workspace.readState();
    const evaluate = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
    const response = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 0 });
    expect(response).toMatchObject({ ok: false, error: "selector_issue_snapshot_stale",
      validation_performed: false, budget_consumed: false,
      actual: { requested_fingerprint: fingerprint, current_draft_fingerprint: fingerprint,
        snapshot_fingerprint: fingerprint, snapshot_status: "stale", stale_dependencies: [{
          dependency: "registry_fingerprint", snapshot_value: saved.registry_fingerprint, current_value: registryFingerprint,
        }] }, writable_paths: [], next_tool: "get_target_context",
      next_tool_arguments: { field_diagnostic_cursor: 0 } });
    expect(response.instruction).toContain("来源片段登记");
    expect(response.how_to_pass).toContain("只读刷新当前字段诊断");
    expect(response.how_to_pass).toContain("不要为读取过期问题而提交未改草稿");
    expect(response.do_not_edit).toBeTypeOf("string");
    expect(evaluate).not.toHaveBeenCalled();
    expect(await Promise.all(protectedPaths.map(path => readFile(path)))).toEqual(protectedBytes);
    const { next_event_sequence: _before, ...before } = stateBefore;
    const { next_event_sequence: _after, ...after } = await workspace.readState();
    expect(after).toEqual(before);
    expect(await controller.dispatch(response.next_tool as string, response.next_tool_arguments as any))
      .toMatchObject({ ok: true });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await readFile(diagnosticPath)).toEqual(protectedBytes[4]);
    // The registry actually changed. Only the author's explicit full check may
    // replace the stale snapshot; the suggested read must not do so implicitly.
    expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint }))
      .toMatchObject({ ok: false, terminal: false });
    const fresh = JSON.parse(await readFile(diagnosticPath, "utf8"));
    expect(fresh.registry_fingerprint).toBe(registryFingerprint);
    expect(fresh.draft_fingerprint).toBe(fingerprint);
    expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 0 }))
      .toMatchObject({ ok: true, validation_performed: false, budget_consumed: false });
    expect(await readFile(workspace.workingSelectorPath)).toEqual(protectedBytes[0]);
  });

  test.each(["source_sha256", "draft_fingerprint", "evidence_fingerprint", "registry_fingerprint", "table_fingerprint"])(
    "%s still rejects a stale snapshot and reports exact saved/current values", async dependency => {
      const scenario = await buildSelectorStageScenario();
      const { workspace, controller } = scenario;
      const fingerprint = await currentFingerprint(controller);
      const snapshot = await seedSnapshot(scenario);
      const currentValue = snapshot[dependency];
      const staleValue = "synthetic-old-" + dependency;
      await atomicWriteJson(join(workspace.root, "selector-diagnostics.json"), { ...snapshot, [dependency]: staleValue });
      expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint }))
        .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", validation_performed: false, budget_consumed: false,
          actual: { snapshot_status: "stale", stale_dependencies: [{ dependency, snapshot_value: staleValue, current_value: currentValue }] },
          next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
    });

  test("a missing snapshot is distinct and directs the author to create one", async () => {
    const { controller } = await buildSelectorStageScenario();
    const fingerprint = await currentFingerprint(controller);
    const response = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
    expect(response).toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", validation_performed: false, budget_consumed: false,
      actual: { snapshot_status: "missing", snapshot_fingerprint: null, stale_dependencies: [] },
      next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
    expect(response.instruction).toContain("尚未创建");
  });

  test("the handoff names dependency changes without claiming the author saved a different draft", async () => {
    const scenario = await buildSelectorStageScenario();
    const { workspace, controller } = scenario;
    const snapshot = await seedSnapshot(scenario);
    const observations = await controller.selectorBlockingIssues();
    expect(observations).toHaveLength(1);
    await controller.recordSelectorBlockingProgress(observations, observations);
    await registerNewSpan(scenario);
    const registryFingerprint = sha256Json(await workspace.readSourceSpanRegistry());
    expect(registryFingerprint).not.toBe(snapshot.registry_fingerprint);
    const summary = await controller.selectorBlockingSummary();
    expect(summary).toContain("来源片段登记");
    expect(summary).toContain('"dependency":"registry_fingerprint"');
    expect(summary).toContain(snapshot.registry_fingerprint);
    expect(summary).toContain(registryFingerprint);
    expect(summary).not.toContain("新保存的作者记录");
    expect(summary).toContain("get_target_context");
    expect(JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8")).convergence.blockers[0].unchanged_rounds)
      .toBe(1);
  });
});
