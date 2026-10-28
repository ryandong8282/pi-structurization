import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { canRetryTargetFailure } from "../src/attempt-budget.js";
import { LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V4, migrateTargetSelectorPlan, targetSelectorFingerprint } from "../src/target-selector-compiler.js";

import {
  runLengthContinuationLoop,
  SelectorCompletedPreflightHandoff,
  selectorDraftFingerprintFromSource,
  restoreSelectorCompletedPreflightHandoff,
  type DurablePromptSnapshot,
} from "../src/pi-runtime.js";

function snapshot(hash: string, history: number): DurablePromptSnapshot {
  return {
    checkpoint: `${hash}:${history}`,
    working_plan_sha256: hash,
    history_sequence: history,
    last_valid_fingerprint: "",
  };
}

describe("Pi output-length continuation", () => {
  test("continues durable progress in one prompt session until terminal seal", async () => {
    let current = snapshot("plan-a", 1);
    let assistant: unknown;
    let round = 0;
    const prompts: string[] = [];
    const events: Array<{ durable_progress: boolean }> = [];

    const result = await runLengthContinuationLoop({
      initialPrompt: "initial",
      continuationPrompt: "read durable plan and patch the next slice",
      promptRound: async (prompt) => {
        prompts.push(prompt);
        round += 1;
        if (round === 1) {
          current = snapshot("plan-b", 2);
          assistant = { stopReason: "length", content: "truncated prose" };
          return { kind: "completed" } as const;
        }
        if (round === 2) {
          current = snapshot("plan-c", 3);
          assistant = { stopReason: "length", content: "truncated tool call" };
          return { kind: "completed" } as const;
        }
        assistant = { stopReason: "stop" };
        return { kind: "sealed" } as const;
      },
      lastAssistant: () => assistant,
      snapshot: async () => current,
      onLength: async (event) => { events.push(event); },
    });

    expect(result).toMatchObject({
      outcome: { kind: "sealed" },
      error: "",
      length_continuations: 2,
    });
    expect(prompts).toEqual([
      "initial",
      "read durable plan and patch the next slice",
      "read durable plan and patch the next slice",
    ]);
    expect(events).toEqual([
      expect.objectContaining({ durable_progress: true }),
      expect.objectContaining({ durable_progress: true }),
    ]);
  });

  test("never concatenates a truncated tool call and bounds no-progress length rounds", async () => {
    const truncated = "{\"op\":\"add\",\"path\":\"/acceptance_items/-\"";
    const durable = snapshot("unchanged-plan", 7);
    const prompts: string[] = [];
    const result = await runLengthContinuationLoop({
      initialPrompt: "initial",
      continuationPrompt: "read the durable working plan only",
      promptRound: async (prompt) => {
        prompts.push(prompt);
        return { kind: "completed" } as const;
      },
      lastAssistant: () => ({ stopReason: "length", content: truncated }),
      snapshot: async () => durable,
      maxConsecutiveWithoutProgress: 2,
    });

    expect(result.error).toMatch(/^length_without_durable_progress:/);
    expect(result.length_continuations).toBe(2);
    expect(prompts).toEqual(["initial", "read the durable working plan only"]);
    expect(prompts.join("\n")).not.toContain(truncated);
  });

  test("bounds transport repairs even when each truncated round staged durable progress", async () => {
    let revision = 0;
    let current = snapshot(`plan-${revision}`, revision);
    const result = await runLengthContinuationLoop({
      initialPrompt: "initial",
      continuationPrompt: "continue from typed draft",
      promptRound: async () => {
        revision += 1;
        current = snapshot(`plan-${revision}`, revision);
        return { kind: "completed" as const };
      },
      lastAssistant: () => ({ stopReason: "length" }),
      snapshot: async () => current,
      maxLengthContinuations: 3,
    });

    expect(result.error).toMatch(/^length_continuation_limit: 3/);
    expect(result.length_continuations).toBe(3);
  });

  test("continues after a normal assistant stop while a durable repair cluster remains", async () => {
    let current = snapshot("cluster-a", 4);
    let assistant: unknown = { stopReason: "stop" };
    let clusterPending = true;
    const prompts: string[] = [];
    const events: Array<{ durable_progress: boolean }> = [];

    const result = await runLengthContinuationLoop({
      initialPrompt: "repair cluster A",
      continuationPrompt: "length continuation",
      completedContinuationPrompt: "continue the next durable cluster",
      promptRound: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          current = snapshot("cluster-b", 5);
          return { kind: "completed" } as const;
        }
        clusterPending = false;
        current = snapshot("validated", 6);
        return { kind: "sealed" } as const;
      },
      lastAssistant: () => assistant,
      snapshot: async () => current,
      shouldContinueAfterCompleted: async () => clusterPending,
      onCompletedContinuation: async (event) => { events.push(event); },
    });

    expect(result).toMatchObject({
      outcome: { kind: "sealed" },
      error: "",
      length_continuations: 0,
      completion_continuations: 1,
    });
    expect(prompts).toEqual([
      "repair cluster A",
      "continue the next durable cluster",
    ]);
    expect(events).toEqual([expect.objectContaining({ durable_progress: true })]);
  });

  test("bounds normal completion loops that leave the same repair cluster unchanged", async () => {
    const durable = snapshot("same-cluster", 9);
    const result = await runLengthContinuationLoop({
      initialPrompt: "repair",
      continuationPrompt: "continue",
      completedContinuationPrompt: "continue remaining cluster",
      promptRound: async () => ({ kind: "completed" as const }),
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => durable,
      shouldContinueAfterCompleted: async () => true,
      maxConsecutiveWithoutProgress: 2,
    });

    expect(result.error).toMatch(/^incomplete_repair_without_durable_progress:/);
    expect(result.error).toContain("persisted target incomplete");
    expect(result.error).not.toContain("active cluster");
    expect(result.completion_continuations).toBe(2);
    expect(result.length_continuations).toBe(0);
  });

  test("carries only the first actionable preflight route into a completed continuation", async () => {
    const draftFingerprint = "a".repeat(64);
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(draftFingerprint);
    const sourceText = "原文不应进入续轮提示。".repeat(1_500);
    const prompts: string[] = [];
    let round = 0;
    const result = await runLengthContinuationLoop({
      initialPrompt: "初始任务",
      continuationPrompt: "输出截断后继续",
      completedContinuationPrompt: async () => `继续修复。${handoff.continuationNote(draftFingerprint, true)}`,
      promptRound: async prompt => {
        prompts.push(prompt);
        round += 1;
        if (round === 1) {
          handoff.observe({
            type: "tool_execution_end",
            toolName: "commit_target_selector_draft",
            result: { details: {
              ok: false,
              error: "selector_global_preflight_failed",
              current_draft_fingerprint: draftFingerprint,
              selector_issues: [
                {
                  code: "selector_test_missing_binding",
                  path: "/items/0/fields/method",
                  record_identity: { collection: "items", key: "item-alpha" },
                  next_tool: "read_target_selectors",
                  next_tool_arguments: { collection: "items", key: "item-alpha" },
                  save_tool: "stage_target_selector_draft",
                  details: {
                    actual: { text: sourceText },
                    writable_paths: ["/items/0/fields/method", "/sampling_rules"],
                    how_to_pass: "依据已读来源修正真实字段后保存草稿并重试验证。",
                  },
                },
                { code: "selector_test_second_issue", path: "/items/1", next_tool: "open_evidence", details: { text: sourceText } },
              ],
              instruction: sourceText,
            } },
          });
          handoff.observe({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read_target_selectors",
            args: { collection: "items", key: "item-alpha" } });
          handoff.observe({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read_target_selectors",
            result: { details: { ok: true, rows: [{ key: "item-alpha", content: sourceText }] } } });
          return { kind: "completed" as const };
        }
        return { kind: "sealed" as const };
      },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => snapshot("unchanged-draft", round),
      shouldContinueAfterCompleted: async () => true,
    });
    expect(result.outcome.kind).toBe("sealed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("selector_test_missing_binding");
    expect(prompts[1]).toContain("/items/0/fields/method");
    expect(prompts[1]).toContain('"identity":{"collection":"items","key":"item-alpha"}');
    expect(prompts[1]).toContain('"next_tool":"read_target_selectors"');
    expect(prompts[1]).toContain('"next_tool_arguments":{"collection":"items","key":"item-alpha"}');
    expect(prompts[1]).toContain('"save_tool":"stage_target_selector_draft"');
    expect(prompts[1]).toContain('"writable_paths":["/items/0/fields/method","/sampling_rules"]');
    expect(prompts[1]).not.toContain('"repair_instruction"');
    expect(prompts[1]).toContain('"next_tool_completed":true');
    expect(prompts[1]).toContain("不重复相同读取");
    expect(prompts[1]).toContain("不代表全部来源和作者记录完成");
    expect(prompts[1]).toContain("按当前诊断保存真实作者决定");
    expect(prompts[1]).not.toContain("selector_test_second_issue");
    expect(prompts[1]).not.toContain(sourceText);
    expect(prompts[1]!.length).toBeLessThan(1_000);
  });

  test("a completed record read still routes a multi-step repair through evidence and staging", () => {
    const fingerprint = "a".repeat(64);
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    const repairInstruction = "读取当前记录后打开相关原文，核对真实接收项，再暂存完整的修正记录。";
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: { details: { ok: false, current_draft_fingerprint: fingerprint, selector_issues: [{
        code: "selector_reference_component_dispositions_required",
        path: "/references/0/component_dispositions",
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "reference-alpha" },
        save_tool: "stage_target_selector_draft",
        how_to_pass: repairInstruction,
      }] } } });
    handoff.observe({ type: "tool_execution_start", toolCallId: "record-read",
      toolName: "read_target_selectors", args: { collection: "references", key: "reference-alpha" } });
    handoff.observe({ type: "tool_execution_end", toolCallId: "record-read",
      toolName: "read_target_selectors", result: { details: { ok: true, view: "record", rows: [{ key: "reference-alpha" }] } } });

    const note = handoff.continuationNote(fingerprint);
    expect(note).toContain('"next_tool_completed":true');
    expect(note).not.toContain('"repair_instruction"');
    expect(note).toContain('"save_tool":"stage_target_selector_draft"');
    expect(note).toContain("指定读取已成功，不代表全部来源和作者记录完成");
    expect(note).toContain("按当前诊断保存真实作者决定");
    expect(note).toContain("全部当前作者错误清空且业务判断完成后再完整验证");
  });

  test("continues a rejected author write through exact unread records, saving, validation and seal", async () => {
    const fingerprint = "e".repeat(64), handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    const reads = [
      { tool: "read_target_selectors", arguments: { collection: "references", key: "ref-sensor-method" } },
      { tool: "read_target_selectors", arguments: { collection: "items", key: "sensor-drift" } },
    ];
    const prompts: string[] = [];
    let current = snapshot("inherited-sensor-draft", 9);
    const result = await runLengthContinuationLoop({
      initialPrompt: "从检查点继续并封存",
      continuationPrompt: "输出中断后读取持久结果",
      completedContinuationPrompt: () => handoff.continuationNote(fingerprint, true),
      promptRound: async prompt => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          handoff.observe({ type: "tool_execution_end", toolName: "stage_target_selector_draft", result: { details: {
            ok: false, terminal: false, current_draft_fingerprint: fingerprint,
            selector_issues: [{ code: "reference_field_selection_complex_reference", path: "/reference_selections/0",
              details: { write_mode: "full_records", next_tool: reads[0]!.tool, next_tool_arguments: reads[0]!.arguments,
                record_reads: reads, save_tool: "stage_target_selector_draft", writable_paths: ["/references/0", "/items/0"] } }],
          } } });
          expect(handoff.hasCurrentWriteFailure()).toBe(true);
          return { kind: "completed" } as const;
        }
        if (prompts.length === 2) {
          expect(prompt).toContain('"failed_tool":"stage_target_selector_draft"');
          expect(prompt).toContain('"validation_tool":"commit_target_selector_draft"');
          expect(prompt).toContain('"next_tool_arguments":{"collection":"references","key":"ref-sensor-method"}');
          handoff.observe({ type: "tool_execution_start", toolCallId: "read-ref", toolName: reads[0]!.tool, args: reads[0]!.arguments });
          handoff.observe({ type: "tool_execution_end", toolCallId: "read-ref", toolName: reads[0]!.tool, result: { details: { ok: true } } });
          expect(handoff.continuationNote(fingerprint)).toContain('"next_tool_arguments":{"collection":"items","key":"sensor-drift"}');
          return { kind: "completed" } as const;
        }
        expect(prompt).toContain('"completed":true');
        expect(prompt).toContain("draft.items/draft.references");
        handoff.observe({ type: "tool_execution_start", toolCallId: "read-item", toolName: reads[1]!.tool, args: reads[1]!.arguments });
        handoff.observe({ type: "tool_execution_end", toolCallId: "read-item", toolName: reads[1]!.tool, result: { details: { ok: true } } });
        expect(handoff.continuationNote(fingerprint)).toContain('"next_tool_completed":true');
        current = { ...snapshot("saved-sensor-draft", 10), last_valid_fingerprint: fingerprint };
        handoff.observe({ type: "tool_execution_end", toolName: "stage_target_selector_draft", result: { details: { ok: true, draft_fingerprint: fingerprint } } });
        expect(handoff.continuationNote(fingerprint)).toBe("");
        expect(handoff.hasCurrentWriteFailure()).toBe(false);
        return { kind: "sealed" } as const;
      },
      lastAssistant: () => ({ stopReason: "stop", content: [{ type: "text", text: "尚未完成，应继续修改。" }] }),
      snapshot: async () => current,
      shouldContinueAfterCompleted: async () => true,
    });
    expect(result).toMatchObject({ outcome: { kind: "sealed" }, error: "", completion_continuations: 2 });
    expect(prompts).toHaveLength(3);
    expect(current.history_sequence).toBe(10);
  });

  test("reuses an oversized preflight receipt in the same session and refreshes it after recovery", () => {
    const fingerprint = "a".repeat(64);
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    const longRoute = "核对来源并按原文修正真实接收项后保存草稿。".repeat(30);
    const oversizedReceipt = { ok: false, current_draft_fingerprint: fingerprint, selector_issues: [{
      code: "selector_test_multi_step_repair", path: "/references/0/component_dispositions",
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "reference-alpha" },
      required_action: "逐个填写组件处置", how_to_pass: longRoute,
    }] };
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: { details: oversizedReceipt, content: [{ type: "text", text: JSON.stringify(oversizedReceipt) }] } });
    const sameSessionNote = handoff.continuationNote(fingerprint, true);
    expect(sameSessionNote).toContain('"validation_tool":"commit_target_selector_draft"');
    expect(sameSessionNote).toContain("selector_test_multi_step_repair");
    expect(sameSessionNote).toContain("已有充分来源的独立记录及时保存");
    expect(sameSessionNote).toContain('"path":"/references/0/component_dispositions"');
    expect(sameSessionNote).toContain("全部当前作者错误清空且业务判断完成后再完整验证");
    expect(sameSessionNote).toContain("必要作者记录及原文");
    expect(sameSessionNote).not.toContain(longRoute);
    expect(sameSessionNote).toContain("不可写程序故障按当前回条停止");
    expect(sameSessionNote).not.toContain("先按工具契约以当前已保存草稿指纹重新调用 validation_tool");
    expect(sameSessionNote).not.toContain(longRoute);
    expect(sameSessionNote.length).toBeLessThan(1_000);

    const recoveredNote = handoff.continuationNote(fingerprint);
    expect(recoveredNote).toContain('"validation_tool":"commit_target_selector_draft"');
    expect(recoveredNote).toContain("旧或未完整显示的修法不能作为当前实际错误");
    expect(recoveredNote).toContain("get_target_context({field_diagnostic_cursor:0})");
    expect(recoveredNote).not.toContain("重新调用 validation_tool");
    expect(recoveredNote).not.toContain('"next_tool":"read_target_selectors"');
    expect(recoveredNote).not.toContain("逐个填写组件处置");
    expect(recoveredNote).not.toContain(longRoute);
    expect(recoveredNote.length).toBeLessThan(1_000);

    const unseen = new SelectorCompletedPreflightHandoff();
    unseen.setDraftFingerprint(fingerprint);
    unseen.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: { details: oversizedReceipt } });
    expect(unseen.continuationNote(fingerprint, true)).toContain("get_target_context({field_diagnostic_cursor:0})");
    expect(unseen.continuationNote(fingerprint, true)).not.toContain("重新调用 validation_tool");

    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: { details: { ok: false, current_draft_fingerprint: fingerprint, selector_issues: [{
        code: "selector_test_multi_step_repair", path: "/references/0/component_dispositions",
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "reference-alpha" },
        how_to_pass: "依据当前回条核对来源，修正真实接收项并保存草稿。",
      }] } } });
    expect(handoff.continuationNote(fingerprint)).toContain('"next_tool":"read_target_selectors"');
  });

  test.each([
    { tool: "list_reference_occurrences", args: { cursor: 0, limit: 12 },
      instruction: "Find the registered occurrence, read its source, and repair the existing receiver." },
    { tool: "read_reference_facts", args: { target_key: "t1", entry_ids: ["seg:2"], cursor: 0 },
      instruction: "Read this source entry before deciding which existing item receives the reference." },
    { tool: "read_target_selectors", args: { collection: "items", key: "receiver-alpha" },
      instruction: "Preserve the receiver and repair only its source binding, then save the complete record." },
  ])("retains the executable $tool route across stalled multi-issue continuations", async ({ tool, args, instruction }) => {
    const fingerprint = "a".repeat(64);
    const changedFingerprint = "b".repeat(64);
    const firstIssue = {
      code: "selector_registered_reference_receipt_missing",
      path: "/references",
      details: { occurrence_id: "r1" },
      next_tool: tool,
      next_tool_arguments: args,
      save_tool: "stage_target_selector_draft",
      writable_paths: ["/items", "/references"],
      how_to_pass: instruction,
    };
    const receipt = { ok: false, current_draft_fingerprint: fingerprint,
      selector_issues: [firstIssue, { code: "selector_sampling_pending", path: "/sampling_rules" }] };
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: { details: receipt, content: [{ type: "text", text: JSON.stringify(receipt) }] } });
    const prompts: string[] = [];
    const result = await runLengthContinuationLoop({
      initialPrompt: "initial",
      continuationPrompt: "unused length route",
      completedContinuationPrompt: () => handoff.continuationNote(fingerprint, true),
      promptRound: async (prompt) => { prompts.push(prompt); return { kind: "completed" } as const; },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => snapshot("unchanged-plan", 18),
      shouldContinueAfterCompleted: async () => true,
    });
    expect(result.error).toMatch(/^incomplete_repair_without_durable_progress:/);
    expect(prompts).toHaveLength(3);
    for (const note of prompts.slice(1)) {
      expect(note).toContain('"next_tool":' + JSON.stringify(tool));
      expect(note).toContain('"next_tool_arguments":' + JSON.stringify(args));
      expect(note).not.toContain('"repair_instruction"');
      expect(note).toContain('"writable_paths":["/items","/references"]');
      expect(note).toContain('"save_tool":"stage_target_selector_draft"');
      expect(note).not.toContain("draft.items=[该项]");
      expect(note).not.toContain("不必等全部被引组件");
    }
    handoff.observe({ type: "tool_execution_end", toolName: "stage_target_selector_draft",
      result: { details: { ok: true, draft_fingerprint: changedFingerprint } } });
    expect(handoff.continuationNote(changedFingerprint, true)).toBe("");
  });

  test("carries model-visible source handles rather than internal IDs into the next round", () => {
    const fingerprint = "a".repeat(64);
    const canonicalId = `reference:${"b".repeat(64)}`;
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    const issue = (occurrenceId: string) => ({
      code: "selector_registered_reference_receipt_missing",
      path: "/references",
      details: { occurrence_id: occurrenceId },
      next_tool: "list_reference_occurrences",
      save_tool: "stage_target_selector_draft",
    });
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
      result: {
        details: { ok: false, current_draft_fingerprint: fingerprint, selector_issues: [issue(canonicalId)] },
        content: [{ type: "text", text: JSON.stringify({
          ok: false, current_draft_fingerprint: fingerprint, selector_issues: [issue("r1")],
          source_handle_scope: "session-alpha",
        }) }],
      } });
    const note = handoff.continuationNote(fingerprint);
    expect(note).toContain('"identity":{"occurrence_id":"r1"}');
    expect(note).not.toContain(canonicalId);

    handoff.observe({ type: "tool_execution_start", toolCallId: "read-1",
      toolName: "list_reference_occurrences", args: { source_handle_scope: "session-alpha", cursor: 0 } });
    handoff.observe({ type: "tool_execution_end", toolCallId: "read-1",
      toolName: "list_reference_occurrences", result: { details: { ok: true } } });
    expect(handoff.continuationNote(fingerprint)).toContain('"next_tool_completed":true');
  });

  test("recognizes an exact evidence read with an additional session scope argument", () => {
    const fingerprint = "a".repeat(64);
    const expected = { target_key: "reference-target:alpha", cursor: 0, limit: 24 };
    const makeHandoff = () => {
      const handoff = new SelectorCompletedPreflightHandoff();
      handoff.setDraftFingerprint(fingerprint);
      handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft",
        result: { details: { ok: false, error: "selector_global_preflight_failed",
          current_draft_fingerprint: fingerprint, selector_issues: [{
            code: "selector_unbound_source", path: "/source_dispositions",
            next_tool: "read_document_reference_evidence", next_tool_arguments: expected,
            save_tool: "stage_target_selector_draft",
          }] } } });
      return handoff;
    };
    const handoff = makeHandoff();
    handoff.observe({ type: "tool_execution_start", toolCallId: "read-1",
      toolName: "read_document_reference_evidence",
      args: { source_handle_scope: "session-alpha", ...expected } });
    handoff.observe({ type: "tool_execution_end", toolCallId: "read-1",
      toolName: "read_document_reference_evidence", result: { details: { ok: true } } });
    expect(handoff.continuationNote(fingerprint)).toContain('"next_tool_completed":true');
    expect(handoff.continuationNote(fingerprint)).toContain("不重复相同读取");

    const wrongRead = makeHandoff();
    wrongRead.observe({ type: "tool_execution_start", toolCallId: "read-2",
      toolName: "read_document_reference_evidence",
      args: { source_handle_scope: "session-alpha", ...expected, target_key: "reference-target:other" } });
    wrongRead.observe({ type: "tool_execution_end", toolCallId: "read-2",
      toolName: "read_document_reference_evidence", result: { details: { ok: true } } });
    expect(wrongRead.continuationNote(fingerprint)).not.toContain('"next_tool_completed":true');
  });

  test("drops a failed preflight route after a changed draft or successful validation", () => {
    const oldFingerprint = "b".repeat(64);
    const changedFingerprint = "c".repeat(64);
    const failedEvent = {
      type: "tool_execution_end",
      toolName: "advance_target_selector_stage",
      result: { details: {
        ok: false,
        error: "selector_stage_incomplete",
        selector_issues: [{
          code: "selector_test_missing_record", path: "/items",
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items" },
        }],
      } },
    };
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(oldFingerprint);
    handoff.observe(failedEvent);
    expect(handoff.continuationNote(oldFingerprint)).toContain("selector_test_missing_record");
    handoff.observe({ type: "tool_execution_end", toolName: "stage_target_selector_draft", result: { details: {
      ok: true, draft_fingerprint: changedFingerprint,
    } } });
    expect(handoff.continuationNote(changedFingerprint)).toBe("");
    handoff.observe(failedEvent);
    expect(handoff.continuationNote(changedFingerprint)).toContain("selector_test_missing_record");
    handoff.observe({ type: "tool_execution_end", toolName: "stage_target_selector_draft", result: { details: {
      ok: true, draft_fingerprint: changedFingerprint,
    } } });
    expect(handoff.continuationNote(changedFingerprint)).toBe("");
    handoff.observe(failedEvent);
    expect(handoff.continuationNote(oldFingerprint)).toBe("");
    handoff.observe(failedEvent);
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: { ok: true } } });
    expect(handoff.continuationNote(changedFingerprint)).toBe("");
  });

  test("uses an exact record-read route and omits non-executable source-text arguments", () => {
    const fingerprint = "d".repeat(64);
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
      ok: false, current_draft_fingerprint: fingerprint,
      selector_issues: [{
        code: "selector_test_reference_route", path: "/references/0",
        next_tool: "read_target_selectors",
        record_read: { tool: "read_target_selectors", arguments: { collection: "references", key: "reference-alpha" } },
      }],
    } } });
    expect(handoff.continuationNote(fingerprint)).toContain('"next_tool_arguments":{"collection":"references","key":"reference-alpha"}');
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
      ok: false, current_draft_fingerprint: fingerprint,
      selector_issues: [{
        code: "selector_test_source_query", path: "/items/0",
        next_tool: "locate_evidence_span",
        next_tool_arguments: { query: "受检对象原文片段" },
      }],
    } } });
    const note = handoff.continuationNote(fingerprint);
    expect(note).toContain("selector_test_source_query");
    expect(note).not.toContain("受检对象原文片段");
    expect(note).not.toContain('"next_tool_arguments":');
  });

  test("a failed seal routes back through commit before a new seal", () => {
    const fingerprint = "e".repeat(64);
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(fingerprint);
    handoff.observe({ type: "tool_execution_end", toolName: "seal_validated_plan", result: { details: {
      ok: false, error: "selector_field_role_invalid", selector_issues: [{
        code: "selector_test_field_source", path: "/items/0/fields/method/span_ids",
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "item-alpha" },
        save_tool: "stage_target_selector_draft",
      }],
    } } });
    const note = handoff.continuationNote(fingerprint);
    expect(note).toContain('"failed_tool":"seal_validated_plan"');
    expect(note).toContain('"validation_tool":"commit_target_selector_draft"');
    expect(note).toContain('"next_tool_arguments":{"collection":"items","key":"item-alpha"}');
    expect(note).toContain("全部当前作者错误清空后重新完整commit");
    expect(note).toContain("再seal其返回的成功fingerprint");
    expect(note).not.toContain("重试 validation_tool");
  });

  test("a legacy selector source uses the controller's migrated fingerprint for handoff", () => {
    const legacy = {
      schema_version: LEGACY_TARGET_SELECTOR_PLAN_SCHEMA_VERSION_V4,
      lots: [], items: [], sampling_rules: [], references: [], source_dispositions: [],
    };
    const source = JSON.stringify(legacy);
    const migratedFingerprint = targetSelectorFingerprint(migrateTargetSelectorPlan(legacy));
    expect(selectorDraftFingerprintFromSource(source)).toBe(migratedFingerprint);
    expect(migratedFingerprint).not.toBe(targetSelectorFingerprint(legacy as any));
    const handoff = new SelectorCompletedPreflightHandoff();
    handoff.setDraftFingerprint(selectorDraftFingerprintFromSource(source));
    handoff.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
      ok: false, current_draft_fingerprint: migratedFingerprint, selector_issues: [{
        code: "selector_test_legacy_draft", path: "/items", next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items" },
      }],
    } } });
    expect(handoff.continuationNote(selectorDraftFingerprintFromSource(source))).toContain("selector_test_legacy_draft");
  });

  test("restores only same-fingerprint identity and reads current contracts without spending a recheck", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-handoff-"));
    const path = join(root, "session.events.jsonl");
    const fingerprint = "f".repeat(64);
    const nextFingerprint = "1".repeat(64);
    const original = "不要回放原文".repeat(3_000);
    const event = (sequence: number, payload: unknown, eventType = "pi_sdk_event") =>
      JSON.stringify({ schema_version: "agent-event/v1", sequence, event_type: eventType, payload });
    const failed = event(1, { type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
      ok: false, current_draft_fingerprint: fingerprint, selector_issues: [{
        code: "selector_test_pending_source", path: "/source_dispositions",
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: "evidence-alpha", cursor: 0 },
        save_tool: "stage_target_selector_draft", details: { source_text: original },
      }], instruction: original,
    } } });
    const read = event(2, { type: "tool_execution_end", toolName: "open_evidence",
      result: { details: { ok: true, source_text: original } } });
    try {
      await writeFile(path, [failed, read, event(3, { type: "tool_execution_end", toolName: "commit_target_selector_draft",
        result: { details: { ok: false, selector_issues: [{ code: "ignored_non_sdk", path: "/items", next_tool: "read_target_selectors" }] } } }, "other_event"),
        '{"event_type":"pi_sdk_event","payload":'].join("\n"));
      const restored = await restoreSelectorCompletedPreflightHandoff(path, fingerprint);
      const note = restored.continuationNote(fingerprint);
      expect(note).toContain("selector_test_pending_source");
      expect(note).toContain('"validation_tool":"commit_target_selector_draft"');
      expect(note).toContain('"next_tool":"get_target_context"');
      expect(note).toContain("不为恢复旧页重检未改草稿");
      expect(note).not.toContain("重新调用 validation_tool");
      expect(note).not.toContain('"next_tool":"open_evidence"');
      expect(note).not.toContain("ignored_non_sdk");
      expect(note).not.toContain(original);
      expect(note).not.toContain('"next_tool_completed":true');
      expect(note.length).toBeLessThan(1_000);
      expect((await restoreSelectorCompletedPreflightHandoff(path, nextFingerprint)).continuationNote(nextFingerprint)).toBe("");

      const staged = event(4, { type: "tool_execution_end", toolName: "stage_target_selector_draft",
        result: { details: { ok: true, draft_fingerprint: nextFingerprint } } });
      await writeFile(path, [failed, staged].join("\n"));
      expect((await restoreSelectorCompletedPreflightHandoff(path, nextFingerprint)).continuationNote(nextFingerprint)).toBe("");
      const committed = event(5, { type: "tool_execution_end", toolName: "commit_target_selector_draft",
        result: { details: { ok: true } } });
      await writeFile(path, [failed, committed].join("\n"));
      expect((await restoreSelectorCompletedPreflightHandoff(path, fingerprint)).continuationNote(fingerprint)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recovered mutation reads current author contracts instead of replaying an old route or rechecking", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-handoff-stale-route-"));
    const path = join(root, "session.events.jsonl");
    const fingerprint = "2".repeat(64);
    const oldFailure = JSON.stringify({
      event_type: "pi_sdk_event",
      payload: { type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
        ok: false,
        current_draft_fingerprint: fingerprint,
        selector_issues: [{
          code: "selector_test_missing_binding",
          path: "/references/0/target_span_ids",
          record_identity: { collection: "references", key: "reference-alpha" },
          next_tool: "stage_target_selector_draft",
          save_tool: "stage_target_selector_draft",
          details: { required_action: "old route must not be replayed" },
        }],
      } } },
    });
    try {
      await writeFile(path, `${oldFailure}\n`);
      const restored = await restoreSelectorCompletedPreflightHandoff(path, fingerprint);
      const staleNote = restored.continuationNote(fingerprint);
      expect(staleNote).toContain("selector_test_missing_binding");
      expect(staleNote).toContain('"key":"reference-alpha"');
      expect(staleNote).toContain('"validation_tool":"commit_target_selector_draft"');
      expect(staleNote).toContain('"next_tool":"get_target_context"');
      expect(staleNote).toContain('"next_tool_arguments":{"field_diagnostic_cursor":0}');
      expect(staleNote).not.toContain("重新调用 validation_tool");
      expect(staleNote).not.toContain('"next_tool":"stage_target_selector_draft"');
      expect(staleNote).not.toContain("old route must not be replayed");

      restored.observe({ type: "tool_execution_end", toolName: "commit_target_selector_draft", result: { details: {
        ok: false,
        current_draft_fingerprint: fingerprint,
        selector_issues: [{
          code: "selector_test_missing_binding",
          path: "/references/0/target_span_ids",
          next_tool: "list_reference_occurrences",
          next_tool_arguments: { cursor: 0 },
        }],
      } } });
      const freshNote = restored.continuationNote(fingerprint);
      expect(freshNote).toContain('"next_tool":"list_reference_occurrences"');
      expect(freshNote).toContain('"next_tool_arguments":{"cursor":0}');
      expect(freshNote).not.toContain("恢复运行后应以当前规则重新核验");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops repeated completed failures even when history-only writes change the checkpoint", async () => {
    let history = 0;
    const result = await runLengthContinuationLoop({
      initialPrompt: "repair", continuationPrompt: "continue from saved issues",
      promptRound: async () => { history += 1; return { kind: "completed" }; },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => ({ ...snapshot("unchanged", history), issue_fingerprint: "same-input-issue" }),
      shouldContinueAfterCompleted: async () => true,
    });
    expect(history).toBe(2);
    expect(result.error).toContain("target_progress_stalled");
    expect(result.error).toContain("same-input-issue");
    expect(canRetryTargetFailure(result.error, {
      candidate_validation_attempts: 0, coverage_repair_attempts: 0, transport_attempts: 0,
    }, { candidate_validation_attempts: 3, coverage_repair_attempts: 1, transport_retries: 1 })).toBe(false);
  });

  test("resets repeated-failure tracking after a real repair and permits a successful validation", async () => {
    let round = 0;
    const result = await runLengthContinuationLoop({
      initialPrompt: "repair", continuationPrompt: "continue",
      promptRound: async () => { round += 1; return { kind: round === 4 ? "sealed" : "completed" }; },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => ({ ...snapshot(round < 2 ? "old" : "fixed", round), issue_fingerprint: round < 2 ? "old-issue" : "remaining-issue" }),
      shouldContinueAfterCompleted: async () => true,
    });
    expect(result.outcome.kind).toBe("sealed");
    expect(result.error).toBe("");
  });

  test("stage transitions on an unchanged complete draft are progress, not a plan hash cycle", async () => {
    const stages = ["primary", "sampling", "table", "commit"];
    let round = 0;
    const result = await runLengthContinuationLoop({
      initialPrompt: "continue", continuationPrompt: "advance",
      promptRound: async () => { round += 1; return { kind: round === 4 ? "sealed" : "completed" }; },
      lastAssistant: () => ({ stopReason: "stop" }),
      snapshot: async () => ({ ...snapshot("complete-draft", round), selector_stage: stages[round] }),
      shouldContinueAfterCompleted: async () => true,
    });
    expect(result.outcome.kind).toBe("sealed");
    expect(result.error).toBe("");
  });

  test.each(["HTTP 429 rate limit", "ECONNRESET"])(
    "returns real transport failures to the batch retry layer: %s",
    async (message) => {
      const result = await runLengthContinuationLoop({
        initialPrompt: "initial",
        continuationPrompt: "continue",
        promptRound: async () => ({ kind: "failed", error: new Error(message) }),
        lastAssistant: () => undefined,
        snapshot: async () => snapshot("plan", 1),
      });
      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind === "failed") {
        expect(result.outcome.error).toBeInstanceOf(Error);
        expect((result.outcome.error as Error).message).toBe(message);
      }
      expect(result.length_continuations).toBe(0);
    },
  );
});
