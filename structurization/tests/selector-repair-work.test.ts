import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ToolController } from "../src/tools.js";
import { selectorDiagnosticToolResponse } from "../src/selector-diagnostics.js";
import { selectSelectorRepairFocus } from "../src/selector-repair-work.js";
import { Check } from "typebox/value";
import { createPiTools } from "../src/tools.js";
import { actionableSelectorIssue } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

async function fixture(subject = "包装封口", count = 7) {
  const scenario = await buildSelectorStageScenario([
    `# 2 虚构${subject}`, "", `## 2.1 ${subject}检查`, "",
    `2.1.1 ${subject}应连续。检验数量：每批抽查${count}件。`, "",
    "2.1.2 标签应清楚。检验数量：每批抽查5件。", "",
    "2.1.3 外观应完整。", "",
  ].join("\n"));
  const registry = await scenario.workspace.readSourceSpanRegistry();
  const first = clauseRecord(scenario.manifest, "2.1.1");
  const second = clauseRecord(scenario.manifest, "2.1.2");
  const span = fullSpanFor(registry, first.evidence_id, first.text.length);
  const selectors = seedPlan(scenario.manifest, span);
  selectors.items = [itemRecord("first", subject, "主控项目", span, "虚构测试记录。"),
    itemRecord("second", "标签清楚", "一般项目", fullSpanFor(registry, second.evidence_id, second.text.length), "另一独立记录。")];
  selectors.items.forEach(row => { row.sampling.status = "pending"; });
  await scenario.workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await scenario.workspace.updateState(state => { state.selector_stage = "sampling"; });
  return { ...scenario, selectors, span, controller: await ToolController.create(scenario.workspace) };
}

describe("durable author repair work", () => {
  test("primary routes a failed author record to repair while temporary sampling remains legal until sampling", async () => {
    const { workspace, selectors } = await fixture("虚构隔振装置", 19);
    await workspace.updateState(state => { state.selector_stage = "primary"; });
    const controller = await ToolController.create(workspace);
    expect(await controller.selectorRepairWork()).toBeUndefined();
    const malformed = structuredClone(selectors.items[0]!);
    malformed.sampling = { ...malformed.sampling, status: "reference", rule_key: "undeclared-neutral-rule", branch_keys: ["default"] };
    const saved = await controller.dispatch("stage_target_selector_draft", { draft: { items: [malformed] } });
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, draft_status: "saved_local_validation_failed",
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "first" } });
    const stageCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
    const before = await workspace.readState();
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }))
      .toMatchObject({ error: "selector_repair_required", full_stage_check_performed: false });
    expect(stageCheck).not.toHaveBeenCalled();
    expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
    await controller.dispatch("stage_target_selector_draft", { draft: { items: [selectors.items[0]!] } });
    expect(await controller.selectorRepairWork()).toBeUndefined();
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }))
      .toMatchObject({ ok: true, stage: "sampling" });
    expect((await controller.selectorRepairWork())?.record_read?.arguments).toEqual({ collection: "items", key: "first" });
  });

  test("an exact prior structural check joins current work without rechecking, and reads or edits retire its stale actuals", async () => {
    const { workspace, controller, selectors, manifest } = await fixture();
    vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([]);
    expect(await controller.selectorRepairWork()).toBeUndefined();
    const stageCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
    const fullCheck = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
    const issue = actionableSelectorIssue({ code: "neutral_reference_permission", path: "/items/0/fields/requirement",
      message: "虚构结构检查发现该字段尚未登记接收关系。", actual: "missing_declared_route",
      writable_paths: ["/items/0/fields/requirement"], record_read: { tool: "read_target_selectors", arguments: { collection: "items", key: "first" } } }, selectors);
    await (controller as any).saveSelectorDiagnostics([issue], selectors);
    const snapshot = await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8");
    expect((await controller.selectorRepairWork())?.code).toBe("neutral_reference_permission");
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }))
      .toMatchObject({ error: "selector_repair_required", next_tool_arguments: { key: "first" } });
    expect(stageCheck).not.toHaveBeenCalled(); expect(fullCheck).not.toHaveBeenCalled();
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 });
    expect(await controller.selectorRepairWork()).toBeUndefined();
    expect(await readFile(join(workspace.root, "selector-diagnostics.json"), "utf8")).toBe(snapshot);
    await (controller as any).saveSelectorDiagnostics([issue], selectors);
    expect((await controller.selectorRepairWork())?.code).toBe("neutral_reference_permission");
    selectors.items[0]!.name = "修改后的中性记录";
    await workspace.writeWorkingSelectors(JSON.stringify(selectors));
    expect(await controller.selectorRepairWork()).toBeUndefined();
    expect(stageCheck).not.toHaveBeenCalled(); expect(fullCheck).not.toHaveBeenCalled();
  });

  test.each([["密封容器焊缝", 9], ["环境记录仪外壳", 17]] as const)(
    "%s: pending work precedes parameter repair and formal checks without spending retained retries", async (subject, count) => {
      const { workspace, controller, selectors, span } = await fixture(subject, count);
      await workspace.updateState(state => {
        state.selector_protocol!.stage_retries = { stage: "sampling", best_stage_rank: 1,
          best_issue_count: 1, consecutive_non_improvements: 3 };
      });
      const before = await workspace.readState();
      const draft = await readFile(workspace.workingSelectorPath, "utf8");
      const stageCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
      const fullCheck = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
      for (const [tool, input] of [
        ["advance_target_selector_stage", { next_stage: "sampling" }],
        ["advance_target_selector_stage", { next_stage: "table" }],
        ["commit_target_selector_draft", { draft_fingerprint: "invalid-before-repair" }],
      ] as const) {
        const reply = await controller.dispatch(tool, input);
        expect(reply).toMatchObject({ ok: false, terminal: false, error: "selector_repair_required",
          full_stage_check_performed: false, content_validation_performed: false, budget_consumed: false,
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "first" },
          stage_retry_accounting: { consumed: false, count: 3, limit: 3 } });
        expect(reply).not.toHaveProperty("expected_next_stage");
        expect(reply).not.toHaveProperty("selector_blocker_handoff");
        expect(reply.issue_details_read).toEqual((reply.selector_repair_work as any).diagnostic_read);
        expect(Check(createPiTools(controller).find(t => t.name === reply.next_tool)!.parameters, reply.next_tool_arguments)).toBe(true);
      }
      expect(stageCheck).not.toHaveBeenCalled();
      expect(fullCheck).not.toHaveBeenCalled();
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
      expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
      expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
      expect((await workspace.readState()).next_history_sequence).toBe(before.next_history_sequence);

      await controller.dispatch("read_target_selectors", { collection: "items", key: "first" });
      const first = structuredClone(selectors.items[0]!);
      first.sampling = { ...first.sampling, status: "explicit", quantity_span_ids: [span], script_span_ids: [span],
        reason: "采用虚构原文的完整抽查数量。" };
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [first] } })).toMatchObject({
        ok: true, next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "second" } });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }))
        .toMatchObject({ error: "selector_repair_required", next_tool_arguments: { key: "second" } });
      expect(stageCheck).not.toHaveBeenCalled();
      const second = structuredClone(selectors.items[1]!);
      const secondSpan = second.criterion_span_ids[0]!;
      second.sampling = { ...second.sampling, status: "explicit", quantity_span_ids: [secondSpan], script_span_ids: [secondSpan],
        reason: "采用另一虚构条文的明确抽查数量。" };
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [second] } }))
        .toMatchObject({ ok: true, next_tool: "advance_target_selector_stage", next_tool_arguments: { next_stage: "table" } });
      expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
      await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
      expect(stageCheck).toHaveBeenCalledTimes(1);
    },
  );

  test("a collection-wide receipt cannot starve addressable author decisions, and recovery retains its assigned key", async () => {
    const { selectors } = await fixture("虚构涂层", 13);
    const issues = [
      { code: "selector_registered_reference_receipt_missing", path: "/references", message: "虚构引用缺声明。", details: { occurrence_id: "reference-neutral" } },
      { code: "selector_sampling_decision_pending", path: "/items/0/sampling/status", message: "虚构待定项。" },
      { code: "selector_sampling_decision_pending", path: "/items/1/sampling/status", message: "另一虚构待定项。" },
    ].map(issue => actionableSelectorIssue(issue, selectors));
    const first = selectSelectorRepairFocus(issues, selectors)!;
    expect(first.focus.record_read?.arguments.key).toBe("first");
    expect(selectSelectorRepairFocus([...issues].reverse(), selectors, first.focus)?.focus.identity).toBe(first.focus.identity);
  });

  test.each([["包装封口", 7], ["仪器外壳接缝", 11]] as const)(
    "%s: survives recovery, ignores unrelated edits, advances only after a real saved decision", async (subject, count) => {
      const { workspace, controller, selectors, span } = await fixture(subject, count);
      const before = await workspace.readState();
      const work = await controller.selectorRepairWork();
      expect(work?.record_read?.arguments).toEqual({ collection: "items", key: "first" });
      expect(work?.diagnostic.actual).toBe("pending");
      const checkpoint = join(workspace.root, "selector-repair-work.json");
      const bytes = await readFile(checkpoint, "utf8");
      const resumed = await ToolController.create(workspace);
      expect(await resumed.selectorRepairWork()).toEqual(work);
      expect(await readFile(checkpoint, "utf8")).toBe(bytes);
      await resumed.dispatch("read_target_selectors", {});
      const unrelated = structuredClone(selectors.items[1]!);
      unrelated.reason = "改动其他记录的理由不会完成当前待办。";
      expect(await resumed.dispatch("stage_target_selector_draft", { collection: "items", draft: { items: [unrelated] } }))
        .toMatchObject({ ok: true, selector_repair_work: { identity: work!.identity } });
      const observation = await resumed.selectorRepairWorkSnapshot();
      await resumed.recordSelectorRepairProgress(observation, observation);
      const focusHistory = JSON.parse(await readFile(checkpoint, "utf8")).convergence;
      const repaired = structuredClone(selectors.items[0]!);
      repaired.sampling = { ...repaired.sampling, status: "explicit", quantity_span_ids: [span],
        script_span_ids: [span], reason: "采用虚构原文明确规定的抽查数量。" };
      const result = await resumed.dispatch("stage_target_selector_draft", { collection: "items", draft: { items: [repaired] } });
      expect(result).toMatchObject({ ok: true, selector_repair_work: { record_read: { arguments: { key: "second" } } } });
      const afterObservation = await resumed.selectorRepairWorkSnapshot();
      expect(await resumed.recordSelectorRepairProgress(observation, afterObservation)).toMatchObject({ progress: true, stalled: [] });
      const persisted = JSON.parse(await readFile(checkpoint, "utf8"));
      expect(persisted.convergence.blockers).toContainEqual(focusHistory.blockers[0]);
      const after = await workspace.readState();
      expect(after.validation_attempts).toBe(before.validation_attempts);
      expect(after.selector_protocol).toEqual(before.selector_protocol);
      expect(after.next_history_sequence).toBe(before.next_history_sequence + 2);
    },
  );

  test("reordering retains the assigned stable key; reading and rewriting a reason earn no progress", async () => {
    const { workspace, controller, selectors } = await fixture();
    const work = await controller.selectorRepairWork();
    const before = await controller.selectorRepairWorkSnapshot();
    selectors.items.reverse();
    selectors.items.find(row => row.key === "first")!.sampling.reason = "仍然没有作出抽样决定。";
    await workspace.writeWorkingSelectors(JSON.stringify(selectors));
    const resumed = await ToolController.create(workspace);
    expect((await resumed.selectorRepairWork())?.identity).toBe(work?.identity);
    expect(await resumed.selectorRepairWorkSnapshot()).toEqual(before);
  });

  test("field diagnostic pages and their row links use one matching tool and fingerprint namespace", async () => {
    const { workspace, controller, selectors } = await fixture();
    selectors.items = Array.from({ length: 40 }, (_, index) => ({ ...structuredClone(selectors.items[0]!), key: `neutral-${index}` }));
    await workspace.writeWorkingSelectors(JSON.stringify(selectors));
    const compile = vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue(selectors.items.map((row, index) => ({
      code: "selector_sampling_decision_pending", path: `/items/${index}/sampling/status`, message: "虚构记录待作决定。",
      details: { item_key: row.key, allowed_statuses: ["explicit", "reference", "fallback", "not_sampling"] },
    })));
    const first = selectorDiagnosticToolResponse(await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 })) as any;
    expect(first.selector_issue_page.index_instruction).not.toContain("read_target_selector_issues");
    expect(first.selector_issue_page.required_action).not.toContain("preflight");
    const link = first.selector_issue_page.issue_index[35].detail_read;
    expect(link).toMatchObject({ tool: "get_target_context", arguments: {
      field_diagnostic_cursor: 35, field_diagnostic_fingerprint: first.field_diagnostic_fingerprint } });
    expect(first.selector_issue_page.issue_index[35]).not.toHaveProperty("issue_key");
    const next = await controller.dispatch(first.next_diagnostic_page.next_tool, first.next_diagnostic_page.next_tool_arguments);
    expect(next.ok).toBe(true);
    expect(next.field_diagnostic_fingerprint).toBe(first.field_diagnostic_fingerprint);
    const detail = await controller.dispatch(link.tool, { ...link.arguments, field_diagnostic_detail_mode: "full" });
    expect((detail.selector_issues as any[])[0].record_read.arguments.key).toBe("neutral-35");
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
