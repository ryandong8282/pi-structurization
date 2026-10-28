import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { prettyJson } from "../src/canonical.js";
import { ToolController, selectorIssueToolPage } from "../src/tools.js";
import { runLengthContinuationLoop, targetSelectorStartupPrompt } from "../src/pi-runtime.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";
import type { ReferenceOccurrence } from "../src/contracts.js";
import { resolvedReferenceComponentCoverageIssues } from "../src/reference-component-coverage.js";
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

describe("selector diagnostic snapshots", () => {
  test("fresh stage diagnostics restore hidden blockers' historical handoff before another completion can stop them", async () => {
    const { workspace, manifest } = await buildSelectorStageScenario([
      "# 2 虚构组件验收", "", "## 2.1 虚构组件检查", "",
      "2.1.1 虚构组件甲的标记应清晰。检验数量：逐件检查。", "",
      "2.1.2 虚构组件乙的编号应完整。检验数量：逐件检查。", "",
      "2.1.3 虚构组件甲的表面应平整。", "",
      "2.1.4 虚构组件乙的接口应完整。", "",
    ].join("\n"));
    const source = clauseRecord(manifest, "2.1.3"), oldSource = clauseRecord(manifest, "2.1.4");
    const registry = await workspace.readSourceSpanRegistry();
    const newSpan = fullSpanFor(registry, source.evidence_id, source.text.length);
    const oldSpan = fullSpanFor(registry, oldSource.evidence_id, oldSource.text.length);
    const selectors = seedPlan(manifest, newSpan);
    selectors.lots[0]!.name = "虚构组件检查";
    const pending = { ...selectors.items[0]!.sampling, status: "pending" as const, reason: "中性未完成判断", confidence: 0 };
    selectors.items = [
      { ...itemRecord("new-work", "虚构组件甲表面", "一般项目", newSpan, "独立虚构条文 2.1.3。"), sampling: pending },
      { ...itemRecord("old-work", "虚构组件乙接口", "一般项目", oldSpan, "独立虚构条文 2.1.4。"), sampling: pending },
    ];
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await workspace.updateState(state => { state.selector_stage = "sampling"; });
    const controller = await ToolController.create(workspace);
    // Exercise completed stage-snapshot playback independently of admission.
    vi.spyOn(controller, "selectorRepairWork").mockResolvedValue(undefined);
    await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
    const initial = (await controller.selectorBlockingIssues())!;
    const cachePath = join(workspace.root, "selector-diagnostics.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    expect(cache.probes).not.toContainEqual(expect.objectContaining({ code: "selector_duplicate_item_payload" }));
    const oldIdentity = cache.probes.find((probe: any) => probe.code === "selector_sampling_decision_pending"
      && probe.bindings.some((binding: any) => binding.collection === "items" && binding.key === "old-work")).identity;
    const old = initial.filter(row => row.identity === oldIdentity);
    await controller.recordSelectorBlockingProgress(old, old);
    await controller.recordSelectorBlockingProgress(old, old);
    await (controller as any).saveSelectorDiagnostics([{ code: "prerequisite", path: "/lots" }], selectors,
      { scope: "earlier-check", completed_scopes: [] });
    await controller.recordSelectorBlockingProgress(old, (await controller.selectorBlockingIssues())!);
    expect(await controller.selectorBlockingSummary()).not.toContain("old-work");
    const fresh = await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
    expect(fresh).toMatchObject({ ok: false, budget_consumed: false, selector_issues: expect.arrayContaining([
      expect.objectContaining({ record_identity: { collection: "items", key: "new-work" } }),
    ]) });
    expect(fresh.stage_retry_accounting).toMatchObject({ consumed: true, count: 0 });
    expect(fresh.selector_blocker_handoff).toBeTypeOf("string");
    const handoff = fresh.selector_blocker_handoff as string;
    const entries = JSON.parse(handoff.slice(handoff.indexOf("["), handoff.indexOf("]。") + 1));
    const relevant = entries.find((entry: any) => entry.code === "selector_sampling_decision_pending"
      && entry.author_records.some((binding: any) => binding.collection === "items" && binding.key === "old-work"));
    expect(relevant).toMatchObject({ unchanged_rounds: 2, history_only: true, next_tool: "read_target_selector_issues" });
    expect(relevant.next_tool_arguments.issue_key).toMatch(/^issue:/);
    expect(relevant.next_tool_arguments.draft_fingerprint).toBe(await currentFingerprint(controller));
    const historyBeforeRead = JSON.parse(await readFile(cachePath, "utf8")).convergence;
    const stateBefore = await workspace.readState();
    const detail = await controller.dispatch(relevant.next_tool, relevant.next_tool_arguments);
    expect(detail).toMatchObject({ ok: true, validation_performed: false, budget_consumed: false,
      selector_issues: [expect.objectContaining({ record_identity: { collection: "items", key: "old-work" } })] });
    expect(JSON.parse(await readFile(cachePath, "utf8")).convergence).toEqual(historyBeforeRead);
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))).toEqual(selectors);
    const afterState = await workspace.readState();
    expect(afterState.selector_protocol).toEqual(stateBefore.selector_protocol);
    expect(afterState.validation_attempts).toBe(stateBefore.validation_attempts);
    expect(afterState.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
    const result = await controller.recordSelectorBlockingProgress(old, (await controller.selectorBlockingIssues())!);
    expect(result?.stalled).toContain(oldIdentity);
    expect(result?.history.blockers.find(row => row.identity === oldIdentity)?.unchanged_rounds).toBe(3);
  });

  test("a current reduced obligation is not presented as unchanged historical urgency", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const issue = (keys: string[]) => ({ code: "source_problem", path: "/items/0/sampling",
      details: { unaccounted_components: keys.map(key => ({ key })), evidence_ids: ["evidence:neutral"] } });
    await (controller as any).saveSelectorDiagnostics([issue(["a", "b"])], selectors);
    const before = (await controller.selectorBlockingIssues())!;
    await controller.recordSelectorBlockingProgress(before, before);
    await controller.recordSelectorBlockingProgress(before, before);
    await (controller as any).saveSelectorDiagnostics([issue(["b"])], selectors);
    expect(await controller.selectorBlockingSummary()).not.toContain('"unchanged_rounds":2');
    expect(await controller.recordSelectorBlockingProgress(before, (await controller.selectorBlockingIssues())!))
      .toMatchObject({ progress: true, stalled: [], history: { blockers: [{ unchanged_rounds: 0 }] } });
  });

  test("real preflight persists a readable snapshot and detail reads do not rerun validation", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const fingerprint = await currentFingerprint(controller);
    const preflight = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
    expect(preflight).toMatchObject({ ok: false, issue_details_read: { tool: "read_target_selector_issues" } });
    const evaluate = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
    const details = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: await currentFingerprint(controller) });
    expect(details).toMatchObject({ ok: true, validation_performed: false, budget_consumed: false });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8")).toContain("selector-diagnostics/v1");
  });

  test("later pages and copied problem keys are readable before fixing the first page, with stale protection", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const issues = Array.from({ length: 40 }, (_, index) => ({ code: "source_problem", path: `/items/${index}`,
      message: "核对来源", actual: { index }, next_tool: "read_target_selectors" }));
    await (controller as any).saveSelectorDiagnostics(issues, selectors);
    const fingerprint = await currentFingerprint(controller);
    const first = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
    expect(first).toMatchObject({ ok: true, selector_issue_page: { next_cursor: 32, raw_issue_count: 40 } });
    const next = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 32 });
    expect(next).toMatchObject({ ok: true, selector_issue_page: { next_cursor: null, reported_issue_count: 8 } });
    expect((next.selector_issues as any[])[0].path).toBe("/items/32");
    const key = (first.selector_issue_page as any).issue_index[35].issue_key;
    const keyed = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: key });
    expect(keyed.selector_issues).toHaveLength(1);
    expect((keyed.selector_issues as any[])[0].path).toBe("/items/35");
    expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, issue_key: "invented" }))
      .toMatchObject({ ok: false, error: "selector_issue_key_unknown", next_tool: "read_target_selector_issues" });
    selectors.lots.push({ key: "new-lot", name: "新批", scope_span_ids: [], reason: "仅测试快照过期" });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 32 }))
      .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
  });

  test("controller reconstruction inherits convergence without inheriting session source handles", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    await (controller as any).saveSelectorDiagnostics([{ code: "unresolved", path: "/items" }], selectors);
    const before = await controller.selectorBlockingIssues();
    const first = await controller.recordSelectorBlockingProgress(before, before);
    expect(first?.history.blockers[0]?.unchanged_rounds).toBe(1);
    const resumed = await ToolController.create(workspace);
    const current = await resumed.selectorBlockingIssues();
    expect(current).toEqual(before);
    await resumed.recordSelectorBlockingProgress(current, current);
    const third = await (await ToolController.create(workspace)).recordSelectorBlockingProgress(current, current);
    expect(third?.stalled).toHaveLength(1);
    expect(await resumed.selectorBlockingSummary()).toContain("unresolved");
  });

  test("a wrong request fingerprint can reread the exact current issue without another preflight", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const issues = Array.from({ length: 40 }, (_, index) => ({ code: "source_problem", path: `/items/${index}`,
      message: "核对合成来源", actual: { index } }));
    await (controller as any).saveSelectorDiagnostics(issues, selectors);
    const fingerprint = await currentFingerprint(controller);
    const key = (selectorIssueToolPage(issues).page.issue_index[35] as any).issue_key;
    const cachePath = join(workspace.root, "selector-diagnostics.json");
    const cache = await readFile(cachePath, "utf8");
    const state = await workspace.readState();
    const evaluate = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
    const mismatch = await controller.dispatch("read_target_selector_issues", {
      draft_fingerprint: "wrong-request-fingerprint", cursor: 35, issue_key: key,
    });
    expect(mismatch).toMatchObject({ ok: false, error: "selector_issue_request_fingerprint_mismatch",
      validation_performed: false, budget_consumed: false,
      actual: { requested_fingerprint: "wrong-request-fingerprint", current_draft_fingerprint: fingerprint,
        snapshot_fingerprint: fingerprint, snapshot_status: "current" },
      writable_path: "/draft_fingerprint", next_tool: "read_target_selector_issues",
      next_tool_arguments: { draft_fingerprint: fingerprint, issue_key: key } });
    expect(await readFile(cachePath, "utf8")).toBe(cache);
    const { next_event_sequence: _eventsBefore, ...stateBefore } = state;
    const { next_event_sequence: _eventsAfter, ...stateAfter } = await workspace.readState();
    expect(stateAfter).toEqual(stateBefore);
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))).toEqual(selectors);
    const recovered = await controller.dispatch(mismatch.next_tool as string, mismatch.next_tool_arguments as any);
    expect(recovered).toMatchObject({ ok: true, validation_performed: false, budget_consumed: false,
      selector_issues: [{ path: "/items/35", actual: { index: 35 } }] });
    expect(recovered.selector_issues).toHaveLength(1);
    expect(evaluate).not.toHaveBeenCalled();

    const unknown = await controller.dispatch("read_target_selector_issues", {
      draft_fingerprint: "wrong-request-fingerprint", issue_key: "not-in-this-snapshot",
    });
    expect(unknown.next_tool_arguments).toEqual({ draft_fingerprint: fingerprint, cursor: 0 });
    selectors.lots.push({ key: "changed-lot", name: "合成新批", scope_span_ids: [], reason: "真实草稿变化使旧页失效。" });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: "wrong-request-fingerprint", issue_key: key }))
      .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
  });

  test("displayed independent records may be saved before reading later pages while old detail snapshots stay protected", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    selectors.lots = [{ key: "first-lot", name: "合成第一批", scope_span_ids: [], reason: "待独立复核的合成分组。" },
      { key: "other-lot", name: "合成另一批", scope_span_ids: [], reason: "其他正确记录保留。" }];
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const issues = Array.from({ length: 40 }, (_, index) => ({ code: "neutral_review", path: `/lots/${index}`,
      message: "分别核对各记录", actual: { index }, how_to_pass: "依据已读来源独立保存完整记录。" }));
    await (controller as any).saveSelectorDiagnostics(issues, selectors);
    const fingerprint = await currentFingerprint(controller);
    const page = await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint });
    expect(page).toMatchObject({ ok: true, selector_issue_page: { next_cursor: 32,
      required_action: "repair_source_grounded_displayed_issues_or_read_needed_current_details" } });
    expect((page.selector_issue_page as any).index_instruction).toContain("不必先读完全部后页");
    const record = selectors.lots[0]!;
    expect(record).toBeDefined();
    await controller.dispatch("read_target_selectors", { collection: "lots", key: record.key });
    const revised = { ...record, reason: "已读来源支持此合成分组，独立核对完成。" };
    const staged = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert", collection: "lots", draft: { lots: [revised] },
    });
    expect(staged.ok).toBe(true);
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    expect(saved).toEqual({ ...selectors, lots: [revised, ...selectors.lots.slice(1)] });
    expect(await controller.dispatch("read_target_selector_issues", { draft_fingerprint: fingerprint, cursor: 32 }))
      .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale", next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
  });

  test("an earlier preflight gate cannot erase downstream blockers or their cross-session counts", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: await currentFingerprint(controller) });
    const before = (await controller.selectorBlockingIssues())!;
    expect(before.length).toBeGreaterThan(0);
    const path = join(workspace.root, "selector-diagnostics.json");
    const initial = JSON.parse(await readFile(path, "utf8"));
    expect(initial.assessment_scope).toBe("source-dispositions");
    await controller.recordSelectorBlockingProgress(before, before);
    await controller.recordSelectorBlockingProgress(before, before);

    vi.spyOn(controller as any, "targetFieldRoleIssues").mockResolvedValueOnce([
      { code: "prerequisite_binding_review", path: "/items", message: "前置来源关系需复核" },
    ]);
    const gated = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: await currentFingerprint(controller) });
    expect((gated.selector_issues as any[]).map(issue => issue.code)).toEqual(["prerequisite_binding_review"]);
    const masked = (await controller.selectorBlockingIssues())!;
    const observed = await controller.recordSelectorBlockingProgress(before, masked);
    expect(observed?.progress).toBe(false);
    expect(observed?.stalled).toEqual([]);
    expect(observed?.history.blockers.filter(row => row.assessed === false))
      .toEqual(before.map(row => ({ ...row, assessed: false, unchanged_rounds: 2 })));
    expect(await controller.selectorBlockingSummary()).toContain("尚未重新核验");

    const resumed = await ToolController.create(workspace);
    const repeated = await resumed.dispatch("commit_target_selector_draft", { draft_fingerprint: await currentFingerprint(resumed) });
    expect(repeated.preflight_reused).toBe(true);
    expect(await resumed.selectorBlockingIssues()).toEqual(masked);
    // Changing the assessed phase requires a fresh full assessment. Merely
    // restoring the controller must not rerun identical checks.
    await workspace.updateState(state => { state.selector_stage = state.selector_stage === "table" ? "commit" : "table"; });
    await resumed.dispatch("commit_target_selector_draft", { draft_fingerprint: await currentFingerprint(resumed) });
    const after = (await resumed.selectorBlockingIssues())!;
    expect(after).toEqual(before);
    const result = await resumed.recordSelectorBlockingProgress(masked, after);
    expect(result?.progress).toBe(true); // The prerequisite really passed, while old obligations remain.
    expect(result?.stalled).toEqual(before.map(row => row.identity));
    expect(result?.history.blockers.every(row => row.unchanged_rounds === 3)).toBe(true);
  });

  test("only a covered check can retire an absent obligation; partial closure preserves other units", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const group = (ids: string[]) => ({ code: "source_group", path: "/source_dispositions", details: { evidence_ids: ids } });
    await (controller as any).saveSelectorDiagnostics([group(["evidence:a", "evidence:b"])], selectors,
      { scope: "source-check", completed_scopes: [] });
    const before = (await controller.selectorBlockingIssues())!;
    await controller.recordSelectorBlockingProgress(before, before);
    await (controller as any).saveSelectorDiagnostics([group(["evidence:a"])], selectors,
      { scope: "source-check", completed_scopes: [] });
    const reduced = (await controller.selectorBlockingIssues())!;
    expect(await controller.recordSelectorBlockingProgress(before, reduced)).toMatchObject({ progress: true });
    expect(reduced[0]?.units).toEqual(["evidence:evidence:a"]);
    await (controller as any).saveSelectorDiagnostics([{ code: "later_review", path: "/items" }], selectors,
      { scope: "later-check", completed_scopes: ["source-check"] });
    const after = (await controller.selectorBlockingIssues())!;
    expect(after.some(row => row.identity === reduced[0]?.identity)).toBe(false);
    expect(await controller.recordSelectorBlockingProgress(reduced, after)).toMatchObject({ progress: true });
    await (controller as any).saveSelectorDiagnostics([], selectors,
      { scope: "complete", completed_scopes: [], complete: true });
    expect(await controller.selectorBlockingIssues()).toEqual([]);
  });

  test("display removes duplicate properties while preserving every actual value and repair route", () => {
    const actual = { item_key: "one", evidence_id: "evidence:source", selected: [1, 2] };
    const source = { code: "binding", path: "/items/0", actual, how_to_pass: "核对原文后修复",
      next_tool: "read_target_selectors", details: { actual, how_to_pass: "核对原文后修复", extra: "保留" } };
    const copy = structuredClone(source);
    const displayed = selectorIssueToolPage([source]).issues[0] as any;
    expect(displayed.actual).toEqual(actual);
    expect(displayed.next_tool).toBe(source.next_tool);
    expect(displayed.details).toEqual({ extra: "保留" });
    expect(Buffer.byteLength(JSON.stringify(displayed))).toBeLessThan(Buffer.byteLength(JSON.stringify(source)));
    expect(source).toEqual(copy);
  });

  test("continuation identifies same-code blockers with executable current detail reads across sessions", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const issues = ["evidence:first", "evidence:second"].map(id => ({ code: "source_problem",
      path: "/source_dispositions", details: { evidence_ids: [id] } }));
    await (controller as any).saveSelectorDiagnostics(issues, selectors);
    const before = await controller.selectorBlockingIssues();
    await controller.recordSelectorBlockingProgress(before, before);
    const resumed = await ToolController.create(workspace);
    const summary = await resumed.selectorBlockingSummary();
    const entries = JSON.parse(summary.slice(summary.indexOf("["), summary.indexOf("]。") + 1));
    expect(entries.map((entry: any) => entry.evidence_ids)).toEqual([["evidence:first"], ["evidence:second"]]);
    expect(new Set(entries.map((entry: any) => entry.next_tool_arguments.issue_key)).size).toBe(2);
    const evaluate = vi.spyOn(resumed as any, "evaluateTargetSelectorPreflight");
    for (const entry of entries) {
      const details = await resumed.dispatch(entry.next_tool, entry.next_tool_arguments);
      expect(details).toMatchObject({ ok: true, validation_performed: false });
      expect((details.selector_issues as any[])[0].details.evidence_ids).toEqual(entry.evidence_ids);
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("continuation distinguishes saved attempts from current validation and never hands off stale problem keys", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    await (controller as any).saveSelectorDiagnostics([{ code: "unresolved", path: "/items/0" }], selectors);
    const before = await controller.selectorBlockingIssues();
    await controller.recordSelectorBlockingProgress(before, before);
    const cachePath = join(workspace.root, "selector-diagnostics.json");
    const cached = await readFile(cachePath, "utf8");
    selectors.lots.push({ key: "another-lot", name: "另一批", scope_span_ids: [], reason: "中性新增记录" });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const summary = await controller.selectorBlockingSummary();
    expect(summary).toContain("作者草稿与快照不一致");
    expect(summary).toContain('"dependency":"draft_fingerprint"');
    expect(summary).toContain('"next_tool":"get_target_context"');
    expect(summary).toContain('"field_diagnostic_cursor":0');
    expect(summary).not.toContain('"issue_key"');
    expect(summary).not.toContain("作者输入及必要来源读取/定位仍未变化");
    expect(await readFile(cachePath, "utf8")).toBe(cached);
    expect(await controller.recordSelectorBlockingProgress(before, await controller.selectorBlockingIssues()))
      .toMatchObject({ progress: false, history: { blockers: [{ unchanged_rounds: 2 }] } });
  });

  test("the first resumed prompt receives precise diagnostics before the inherited stop guard can fire", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    await (controller as any).saveSelectorDiagnostics([{ code: "source_problem", path: "/source_dispositions",
      details: { evidence_ids: ["evidence:pending-source"] } }], selectors);
    const before = (await controller.selectorBlockingIssues())!;
    for (let round = 0; round < 3; round++) await controller.recordSelectorBlockingProgress(before, before);
    const resumed = await ToolController.create(workspace);
    const prompts: string[] = [];
    const result = await runLengthContinuationLoop({
      initialPrompt: targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
        recovering_coverage_failure: false, resume: true, current_selector_state: "current_existing",
        selector_blocker_handoff: await resumed.selectorBlockingSummary() }),
      continuationPrompt: "continue",
      shouldContinueAfterCompleted: () => true,
      promptRound: async prompt => { prompts.push(prompt); return { kind: "completed" }; },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => ({ checkpoint: "unchanged", working_plan_sha256: "unchanged", history_sequence: 1,
        last_valid_fingerprint: "", blocking_issues: (await resumed.selectorBlockingIssues())! }),
      observeBlockingProgress: (previous, current) => resumed.recordSelectorBlockingProgress(previous.blocking_issues, current.blocking_issues),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("evidence:pending-source");
    expect(prompts[0]).toContain('"next_tool":"read_target_selector_issues"');
    expect(prompts[0]).toContain('"issue_key":"issue:');
    expect(result.error).toContain("target_progress_stalled");
    const cache = JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8"));
    expect(cache.convergence.blockers[0].unchanged_rounds).toBe(4);
  });

  test("a local compiler receipt preserves verified component reduction across sessions without refreshing global details", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    const registry = await workspace.readSourceSpanRegistry();
    const spans = [...new Map(registry.spans.filter(span => span.end > span.start)
      .map(span => [span.evidence_id, span])).values()].slice(0, 3);
    expect(spans).toHaveLength(3);
    const occurrence = { occurrence_id: "occurrence:neutral", reference_kind: "clause", status: "resolved",
      target_evidence_ids: spans.map(span => span.evidence_id) } as ReferenceOccurrence;
    const reference: TargetSelectorPlan["references"][number] = {
      key: "neutral-route", occurrence_id: occurrence.occurrence_id, anchor_span_ids: [spans[0]!.span_id],
      target_span_ids: [spans[0]!.span_id], action: "adopt", application_mode: "reference_placeholder",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "合成来源范围。" },
      destinations: [], reason: "合成引用记录。",
    };
    selectors.references = [reference];
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const coverage = (plan: TargetSelectorPlan) => resolvedReferenceComponentCoverageIssues(plan,
      { reference_occurrences: [occurrence] }, registry, new Map());
    await (controller as any).saveSelectorDiagnostics(coverage(selectors), selectors,
      { scope: "selector-compiler", completed_scopes: [] });
    const before = (await controller.selectorBlockingIssues())!;
    await controller.recordSelectorBlockingProgress(before, before);
    await controller.recordSelectorBlockingProgress(before, before);
    const fingerprint = await currentFingerprint(controller);
    vi.spyOn(controller as any, "selectorCompilerIssues").mockImplementation(async (plan: unknown) => coverage(plan as TargetSelectorPlan));
    const patched = { ...reference, component_dispositions: [{ component_span_ids: [spans[0]!.span_id],
      decision: "not_applicable" as const, item_keys: [], reason: "合成组件只属于另一种对象。" }] };
    const saved = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert", collection: "references", draft: { references: [patched] },
    });
    expect(saved).toMatchObject({ ok: true, local_validation: { ok: false, validation_scope: "touched_records",
      issues: [{ actual: { unaccounted_component_count: 2 } }] } });
    const resumed = await ToolController.create(workspace);
    const after = (await resumed.selectorBlockingIssues())!;
    expect(after[0]?.units).toHaveLength(2);
    const result = await resumed.recordSelectorBlockingProgress(before, after);
    expect(result).toMatchObject({ progress: true, stalled: [], history: { blockers: [{ unchanged_rounds: 0 }] } });
    const cache = JSON.parse(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8"));
    expect(cache.draft_fingerprint).toBe(fingerprint);
    expect(cache.issues[0].actual.unaccounted_component_count).toBe(3);
    expect(cache.local_blocker_assessment).toMatchObject({ validation_scope: "touched_records", matched_blocker_count: 1 });
    expect(await resumed.dispatch("read_target_selector_issues", { draft_fingerprint: await currentFingerprint(resumed) }))
      .toMatchObject({ ok: false, error: "selector_issue_snapshot_stale" });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual(selectors.items);

    // Rewriting a reason while the same compiler obligations remain is not repair.
    vi.spyOn(resumed as any, "selectorCompilerIssues").mockImplementation(async (plan: unknown) => coverage(plan as TargetSelectorPlan));
    await resumed.dispatch("stage_target_selector_draft", { operation: "upsert", collection: "references",
      draft: { references: [{ ...patched, reason: "只改作者理由。" }] } });
    expect(await resumed.recordSelectorBlockingProgress(after, await resumed.selectorBlockingIssues()))
      .toMatchObject({ progress: false, history: { blockers: [{ unchanged_rounds: 1 }] } });
  });

  test("a local compiler omission cannot close or re-count an unassessed global blocker", async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    await (controller as any).saveSelectorDiagnostics([{ code: "downstream_source_obligation", path: "/items",
      details: { evidence_ids: ["evidence:unchanged-source"] } }], selectors,
      { scope: "selector-compiler", completed_scopes: [] });
    const before = (await controller.selectorBlockingIssues())!;
    await controller.recordSelectorBlockingProgress(before, before);
    await controller.recordSelectorBlockingProgress(before, before);
    vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([]);
    const saved = await controller.dispatch("stage_target_selector_draft", { operation: "upsert", collection: "lots",
      draft: { lots: [{ key: "neutral-lot", name: "合成批", scope_span_ids: [], reason: "只保存另一个记录。" }] } });
    expect(saved.ok).toBe(true);
    const resumed = await ToolController.create(workspace);
    const after = (await resumed.selectorBlockingIssues())!;
    expect(after).toEqual(before.map(row => ({ ...row, assessed: false })));
    expect(await resumed.recordSelectorBlockingProgress(before, after))
      .toMatchObject({ progress: false, stalled: [], history: { blockers: [{ unchanged_rounds: 2, assessed: false }] } });
    await (resumed as any).saveSelectorDiagnostics([{ code: "downstream_source_obligation", path: "/items",
      details: { evidence_ids: ["evidence:unchanged-source"] } }],
      JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")), { scope: "selector-compiler", completed_scopes: [] });
    expect(await resumed.recordSelectorBlockingProgress(after, await resumed.selectorBlockingIssues()))
      .toMatchObject({ progress: false, stalled: [before[0]!.identity], history: { blockers: [{ unchanged_rounds: 3 }] } });
  });
});
