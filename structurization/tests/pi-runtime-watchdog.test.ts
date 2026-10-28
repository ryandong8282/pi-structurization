import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveReferenceCatalog } from "../src/reference-catalog-discovery.js";
import { MAX_TOOL_PADDING_CHARACTERS, MAX_REPETITIVE_TEXT_TAIL_CHARACTERS, ModelStreamNoProgressError, createStreamRecoveryRunner } from '../src/model-stream-progress.js';

import {
  ModelStreamWatchdog,
  CATALOG_BASH_TOOL_TIMEOUT_MS,
  LOCAL_TOOL_TIMEOUT_MS,
  COVERAGE_FINALIZATION_TOOL_NAMES,
  COVERAGE_FINALIZATION_SYSTEM_PROMPT,
  TARGET_MODELING_PHASE_LIMITS,
  TargetModelingPhaseBudget,
  coverageRepairRecoveryFingerprint,
  coverageRepairSessionRoute,
  coverageCheckpointWithReferenceReads,
  coverageFinalizationBlockerPrompt,
  coverageControllerRebuildRequired,
  coverageFreshPhaseFailureClass,
  coverageFreshPhaseProgress,
  coverageFreshPhaseTerminalError,
  coverageReviewInvocationPolicy,
  coverageReviewStageHandoff,
  constrainedSessionResultError,
  isCoverageFinalizationHandoff,
  isValidRemoteModelEvent,
  modelStreamTimeoutsFromEnvironment,
  piSessionRequiresFreshStart,
  sealCoverageHandoffFingerprint,
  sessionMessagesHaveUnresolvedToolCalls,
  targetSelectorStartupPrompt,
  targetModelingCheckpointSnapshot,
  createCatalogRuleAsk,
  persistTargetModelingPhaseBudgetOutcome,
  promptWithStreamWatchdog,
  runLengthContinuationLoop,
  terminalToolFailure,
  withToolExecutionTimeout,
  withTargetModelingPhaseBudget,
  freshSessionRestartFromTool,
  requiresFreshProviderSession,
} from "../src/pi-runtime.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("model stream watchdog", () => {
  function controlledSession() {
    let listener: ((event: unknown) => void) | undefined;
    let releaseAbort!: () => void;
    let settlePrompt!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const promptGate = new Promise<void>((resolve) => { settlePrompt = resolve; });
    let active = false;
    const session = {
      prompt: vi.fn(async () => {
        active = true;
        await promptGate;
        active = false;
      }),
      abort: vi.fn(async () => {
        await abortGate;
        settlePrompt();
        await promptGate;
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => {
        listener = next;
        return vi.fn();
      }),
    };
    return {
      session,
      emit: (event: unknown) => listener?.(event),
      releaseAbort,
      isActive: () => active,
    };
  }

  test("does not expose a watchdog failure until the old session abort and prompt settle", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS", "10");
    vi.stubEnv("PI_AGENT_MODEL_IDLE_TIMEOUT_MS", "10");
    const controlled = controlledSession();
    const pending = promptWithStreamWatchdog(controlled.session, "test prompt");
    let failureVisible = false;
    let freshStartedWhileOldActive = false;
    void pending.then(() => {
      failureVisible = true;
      freshStartedWhileOldActive = controlled.isActive();
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(controlled.session.abort).toHaveBeenCalledTimes(1);
    expect(failureVisible).toBe(false);
    expect(controlled.isActive()).toBe(true);

    controlled.releaseAbort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(String(outcome.kind === "failed" ? outcome.error : "")).toContain("ETIMEDOUT");
    expect(freshStartedWhileOldActive).toBe(false);
    expect(controlled.isActive()).toBe(false);
  });

  test('aborts degenerate arguments immediately, but cannot start recovery before the old stream settles', async () => {
    const controlled = controlledSession();
    const onRecovery = vi.fn(async () => {});
    const recover = createStreamRecoveryRunner({onRecovery});
    const run = vi.fn(async (prompt: string) => run.mock.calls.length === 1
      ? promptWithStreamWatchdog(controlled.session, prompt) : {kind:'completed' as const});
    const pending = recover('preserve work',run);
    controlled.emit({type:'message_update',message:{role:'assistant'},
      assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta:'{'+ ' '.repeat(MAX_TOOL_PADDING_CHARACTERS)}});
    expect(controlled.session.abort).toHaveBeenCalled();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);expect(onRecovery).not.toHaveBeenCalled();
    controlled.releaseAbort();
    expect(await pending).toEqual({kind:'completed'});
    expect(run).toHaveBeenCalledTimes(2);expect(controlled.isActive()).toBe(false);
  });

  test('slow empty or whitespace deltas cannot keep extending the idle window', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PI_AGENT_MODEL_IDLE_TIMEOUT_MS','100');
    const controlled=controlledSession();
    const pending=promptWithStreamWatchdog(controlled.session,'task');
    controlled.emit({type:'message_start',message:{role:'assistant'}});
    for(let i=0;i<5;i++) {
      controlled.emit({type:'message_update',message:{role:'assistant'},assistantMessageEvent:{type:'toolcall_delta',delta:' ',contentIndex:0}});
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(controlled.session.abort).toHaveBeenCalled();
    controlled.releaseAbort();
    const result=await pending;
    expect(result.kind).toBe('failed');
    expect(result.kind==='failed' && result.error).toBeInstanceOf(ModelStreamNoProgressError);
  });

  test.each(['padding', 'record-type', 'text-tail'] as const)('native Pi loop preserves completed work and never executes or replays the aborted call (%s)', async fault => {
    // Exercise the installed SDK, with only the provider stream replaced (no network).
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { transformMessages } = await import('@earendil-works/pi-ai/api/transform-messages');
    const model = { id:'stream-test', provider:'test', api:'openai-completions', input:['text'] };
    const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const completedWrite = vi.fn(async () => ({content:[{type:'text',text:'draft already saved'}]}));
    const incompleteEdit = vi.fn(async () => ({content:[{type:'text',text:'must not execute'}]}));
    const editContract = { name: 'edit', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } } } };
    const contexts: any[][] = [];
    let calls = 0;
    const agent = new Agent({
      initialState: {model,tools:[
        {name:'save_draft',description:'save',parameters:{type:'object',properties:{}},execute:completedWrite},
        {...editContract,description:'edit',execute:incompleteEdit},
      ]},
      convertToLlm: (messages: unknown[]) => messages,
      streamFn: async (_model: unknown, context: any, options: {signal:AbortSignal}) => {
        contexts.push(structuredClone(transformMessages(context.messages, model)));
        const round = calls++;
        let result: any = {role:'assistant',api:model.api,provider:model.provider,model:model.id,usage,timestamp:Date.now(),
          stopReason:round < 2 ? 'toolUse' : 'stop',content:round === 0
            ? [{type:'toolCall',id:'saved-call',name:'save_draft',arguments:{}}]
            : round === 1 && fault === 'text-tail' ? [{type:'text',text:'~ '.repeat(MAX_REPETITIVE_TEXT_TAIL_CHARACTERS)}]
            : round === 1 ? [{type:'toolCall',id:'broken-call',name:'edit',arguments:fault === 'record-type' ? { rows: [{ key: 'first' }, 'wrong record'] } : {}}]
              : [{type:'text',text:'continued from saved draft'}]};
        return {
          async *[Symbol.asyncIterator]() {
            if (round === 1) {
              yield {type:'start',partial:result};
              if (fault === 'text-tail') yield {type:'text_delta',partial:result,contentIndex:0,delta:result.content[0].text};
              else yield {type:'toolcall_delta',partial:result,contentIndex:0,
                delta:fault === 'record-type' ? '{"rows":[{"key":"first"},"wrong record"' : '{"malformed prefix\n' + ' '.repeat(MAX_TOOL_PADDING_CHARACTERS)};
              expect(options.signal.aborted).toBe(true);
              result = {...result,stopReason:'aborted',errorMessage:'Operation aborted'};
              yield {type:'error',reason:'aborted',error:result};
            } else yield {type:'done',reason:result.stopReason,message:result};
          },
          result: async () => result,
        };
      },
    });
    const session = {
      prompt: (text: string) => agent.prompt(text),
      subscribe: (listener: (event: unknown) => void) => agent.subscribe(listener),
      abort: async () => {agent.abort();await agent.waitForIdle();},
    };
    const onRecovery = vi.fn(async () => {});
    const recover = createStreamRecoveryRunner({onRecovery});
    try {
      expect(await recover('complete extraction', prompt => promptWithStreamWatchdog(session,prompt,undefined,[editContract])))
        .toEqual({kind:'completed'});
      expect(completedWrite).toHaveBeenCalledTimes(1);
      expect(incompleteEdit).not.toHaveBeenCalled();
      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(calls).toBe(3);
      // Disk/in-memory history is retained; the provider's native projection omits the failed response.
      expect(agent.state.messages.some((entry: any) => entry.stopReason === 'aborted')).toBe(true);
      expect(contexts[2]).toEqual(expect.arrayContaining([
        expect.objectContaining({role:'toolResult',toolCallId:'saved-call'}),
      ]));
      expect(JSON.stringify(contexts[2])).not.toContain('broken-call');
      expect(JSON.stringify(contexts[2])).not.toContain('~ '.repeat(100));
      expect(JSON.stringify(contexts[2])).toContain('complete extraction');
    } finally {await session.abort();}
  });

  test("does not expose a provider failure until the old session abort and prompt settle", async () => {
    const controlled = controlledSession();
    const pending = promptWithStreamWatchdog(controlled.session, "test prompt");
    let failureVisible = false;
    void pending.then(() => { failureVisible = true; });

    controlled.emit({
      type: "message_end",
      message: { role: "assistant", errorMessage: "400 context_too_large: input exceeds the context window" },
    });
    await vi.waitFor(() => expect(controlled.session.abort).toHaveBeenCalledTimes(1));
    expect(failureVisible).toBe(false);
    expect(controlled.isActive()).toBe(true);

    controlled.releaseAbort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(String(outcome.kind === "failed" ? outcome.error : "")).toContain("context_too_large");
    expect(controlled.isActive()).toBe(false);
  });

  test("keeps caller abort authoritative while a provider failure waits for session settlement", async () => {
    const controlled = controlledSession();
    const caller = new AbortController();
    const callerError = new Error("caller stopped job");
    const pending = runLengthContinuationLoop({
      initialPrompt: "test prompt",
      continuationPrompt: "unused",
      promptRound: (prompt) => promptWithStreamWatchdog(controlled.session, prompt, caller.signal),
      lastAssistant: () => undefined,
      snapshot: async () => ({
        checkpoint: "same",
        working_plan_sha256: "same",
        history_sequence: 0,
        last_valid_fingerprint: "",
      }),
      signal: caller.signal,
    });
    let callerFailureVisible = false;
    void pending.catch(() => { callerFailureVisible = true; });

    await vi.waitFor(() => expect(controlled.session.prompt).toHaveBeenCalledTimes(1));
    controlled.emit({
      type: "message_end",
      message: { role: "assistant", errorMessage: "400 context_too_large: input exceeds the context window" },
    });
    caller.abort(callerError);
    await vi.waitFor(() => expect(controlled.session.abort).toHaveBeenCalledTimes(1));
    expect(callerFailureVisible).toBe(false);
    expect(controlled.isActive()).toBe(true);

    controlled.releaseAbort();
    await expect(pending).rejects.toBe(callerError);
    expect(controlled.isActive()).toBe(false);
  });

  test("passes the actual seal blocker to the next phase without repeating the full review", () => {
    const issues = Array.from({ length: 10 }, (_, index) => ({
      code: "reference_catalog_entries_undisposed", details: { target_key: `reference-target:${index}` },
    }));
    const prompt = JSON.parse(coverageFinalizationBlockerPrompt({
      ok: false, error: "coverage_reference_facts_incomplete", required_action: "read_reference_facts", issues,
    }));
    expect(prompt).toMatchObject({ error: "coverage_reference_facts_incomplete", required_action: "read_reference_facts", issue_count: 10 });
    expect(prompt.issues).toEqual(issues.slice(0, 8));
    expect(coverageFinalizationBlockerPrompt({ ok: true })).toBe("");
    expect(coverageFinalizationBlockerPrompt({ ok: false, error: "coverage_review_not_mechanically_ready" })).toBe("");
  });

  test("bubbles a changed coverage candidate instead of prompting a fresh provider session on the stale controller", () => {
    const changed = {
      ok: false,
      terminal: true,
      error: "coverage_review_candidate_changed",
      required_action: "rebuild_coverage_controller_for_current_candidate",
      instruction: "停止当前复核会话，由上层编排按当前候选新建 CoverageReviewController。",
    };
    expect(coverageControllerRebuildRequired(changed)).toBe(true);
    expect(coverageFinalizationBlockerPrompt(changed)).toBe("");
    expect(coverageControllerRebuildRequired({ ok: false, error: "coverage_reference_facts_incomplete" }))
      .toBe(false);
  });
  test("a staged or rejected coverage draft resumes the same repair instead of reopening an old transaction", () => {
    expect(coverageRepairSessionRoute({
      recovering_coverage_failure: true,
      coverage_recheck_plan_fingerprint: "old",
      sealed_repair_review_fingerprint: "old",
      repair: { mode: "modeling", repair_source: "coverage" },
    })).toBe("continue_coverage_repair");
  });

  test("reference-gate progress counts new dispositions, not reordered entries or rewritten explanations", () => {
    const entry = { fingerprint: "catalog", rule_source: "cached", entry_ids: ["a", "b"], used: ["a"], ignored: [] as Array<{ entry_id: string; reason: string }> };
    const before = { reference_catalog_dispositions: { "coverage:reference-target": entry } };
    const after = structuredClone(before);
    after.reference_catalog_dispositions["coverage:reference-target"].ignored.push({ entry_id: "b", reason: "outside current applicability" });
    const original = coverageCheckpointWithReferenceReads("same-review", after);
    expect(original).not.toBe(coverageCheckpointWithReferenceReads("same-review", before));
    after.reference_catalog_dispositions["coverage:reference-target"].ignored[0]!.reason = "rewritten reason";
    after.reference_catalog_dispositions["coverage:reference-target"].entry_ids.reverse();
    expect(coverageCheckpointWithReferenceReads("same-review", after)).toBe(original);
    expect(coverageCheckpointWithReferenceReads("same-review", { reference_catalog_dispositions: { "target:reference-target": entry } }))
      .toBe(coverageCheckpointWithReferenceReads("same-review", {}));
  });
  test("reference-gate progress counts newly opened catalog ranges for an already used entry", () => {
    const before = {
      reference_catalog_dispositions: {
        "coverage:reference-target": {
          fingerprint: "catalog",
          rule_source: "cached",
          entry_ids: ["a"],
          used: ["a"],
          ignored: [] as Array<{ entry_id: string; reason: string }>,
          opened_ranges: { a: { "0": [[0, 24] as [number, number]] } },
        },
      },
    };
    const after = structuredClone(before);
    after.reference_catalog_dispositions["coverage:reference-target"].opened_ranges.a["0"] = [[0, 48]];

    expect(coverageCheckpointWithReferenceReads("same-review", after))
      .not.toBe(coverageCheckpointWithReferenceReads("same-review", before));
  });
  test("coverage watchdog counts only coverage-phase inline reads as durable progress", () => {
    const progress = {
      read_policy: "exhaustive" as const,
      content_mode: "full_text" as const,
      total_count: 2,
      next_cursor: 1,
      done: false,
      target_key: "reference-target:neutral",
      target_fingerprint: "inventory",
    };
    const baseline = coverageCheckpointWithReferenceReads("same-review", {});
    expect(coverageCheckpointWithReferenceReads("same-review", {
      document_reference_reads: { "reference:legacy": progress },
    })).toBe(baseline);
    expect(coverageCheckpointWithReferenceReads("same-review", {
      document_reference_reads: { "reference:target": { ...progress, phase: "target" } },
    })).toBe(baseline);
    expect(coverageCheckpointWithReferenceReads("same-review", {
      document_reference_reads: { "coverage:reference:neutral": { ...progress, phase: "coverage" } },
    })).not.toBe(baseline);
  });
  test("coverage finalization exposes the tools needed to satisfy reference read gates", () => {
    expect(COVERAGE_FINALIZATION_TOOL_NAMES).toEqual(expect.arrayContaining([
      "read_working_coverage_review", "seal_coverage_review", "read_reference_facts", "read_document_reference_evidence",
      "read_candidate_related_context", "list_coverage_reference_targets",
    ]));
    expect(COVERAGE_FINALIZATION_SYSTEM_PROMPT).toContain("不为赚回执重写正确稿");
    expect(COVERAGE_FINALIZATION_SYSTEM_PROMPT).toContain("coverage_related_context_incomplete");
  });
  test("uses separate conservative first-event and relaxed idle defaults", () => {
    expect(modelStreamTimeoutsFromEnvironment({})).toEqual({
      firstEventMs: 60_000,
      idleMs: 180_000,
    });
  });

  test("accepts independent positive timeout overrides", () => {
    expect(modelStreamTimeoutsFromEnvironment({
      PI_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS: "90000",
      PI_AGENT_MODEL_IDLE_TIMEOUT_MS: "300000",
    })).toEqual({
      firstEventMs: 90_000,
      idleMs: 300_000,
    });
  });

  test("rejects invalid timeout overrides instead of silently falling back", () => {
    expect(() => modelStreamTimeoutsFromEnvironment({
      PI_AGENT_MODEL_IDLE_TIMEOUT_MS: "0",
    })).toThrow(/PI_AGENT_MODEL_IDLE_TIMEOUT_MS/);
  });

  test("retires a resumed Pi session whose active branch ends in an unresolved tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-interrupted-tool-session-"));
    try {
      const danglingPath = join(root, "dangling.jsonl");
      const completedPath = join(root, "completed.jsonl");
      const header = {
        type: "session",
        version: 3,
        id: "session-interrupted-tool",
        timestamp: "2026-08-14T00:00:00.000Z",
        cwd: root,
      };
      const assistant = {
        type: "message",
        id: "assistant-tool-call",
        parentId: null,
        timestamp: "2026-08-14T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-commit",
            name: "commit_target_selector_draft",
            arguments: { draft_fingerprint: "a".repeat(64) },
          }],
          provider: "fixture",
          model: "fixture",
          stopReason: "toolUse",
          timestamp: 1,
        },
      };
      const toolResult = {
        type: "message",
        id: "tool-result",
        parentId: assistant.id,
        timestamp: "2026-08-14T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-commit",
          toolName: "commit_target_selector_draft",
          content: [{ type: "text", text: "{\"ok\":true}" }],
          isError: false,
          timestamp: 2,
        },
      };
      await writeFile(danglingPath, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`, "utf8");
      await writeFile(completedPath, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`, "utf8");

      expect(piSessionRequiresFreshStart(danglingPath)).toBe(true);
      expect(piSessionRequiresFreshStart(completedPath)).toBe(false);
      expect(piSessionRequiresFreshStart(join(root, "missing.jsonl"))).toBe(true);
      expect(sessionMessagesHaveUnresolvedToolCalls([
        assistant.message,
        toolResult.message,
      ])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orients a new session to inherited selectors instead of asking for a rebuild", () => {
    const prompt = targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      recovering_coverage_failure: false,
      resume: false,
      current_selector_state: "inherited_existing",
    });
    expect(prompt).toContain('"current_selector_state":"inherited_existing"');
    expect(prompt).toContain("按 collection/key 读完整记录");
    expect(prompt).toContain("保留有据 keyed records，不从空白重建");
    expect(prompt).not.toContain("Build evidence-bound target selectors");

    expect(targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      recovering_coverage_failure: false,
      resume: false,
      current_selector_state: "blank",
    })).toContain("依据已确认范围抽取全部验收要求");
  });

  test("resume focus points the next session at the exact pending repairs", () => {
    const prompt = targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      recovering_coverage_failure: false,
      resume: true,
      current_selector_state: "inherited_existing",
      resume_focus: [
        { code: "compiler_unhandled_evidence", path: "/items", evidence_ids: ["e17", "e52"] },
        { code: "selector_registered_reference_receipt_missing", path: "/references" },
      ],
    });
    const navigation = JSON.parse(prompt.match(/<repair_navigation>\s*([\s\S]*?)\s*<\/repair_navigation>/u)![1]!);
    expect(navigation).toEqual([
      { code: "compiler_unhandled_evidence", path: "/items", evidence_ids: ["e17", "e52"] },
      { code: "selector_registered_reference_receipt_missing", path: "/references" },
    ]);
    expect(prompt).toContain("无需先通读目录");
    expect(prompt).toContain("未列出不等于通过");
    expect(prompt).toContain("完整 commit 通过后直接 seal");
    expect(prompt).not.toContain("把消息预算全部花在清单项上");
    // 无 focus 时不得出现空段落标题
    const plain = targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      recovering_coverage_failure: false,
      resume: true,
      current_selector_state: "inherited_existing",
    });
    expect(plain).not.toContain("<repair_navigation>");
  });

  test("table resume focus preserves its separate read and save tools", () => {
    const prompt = targetSelectorStartupPrompt({
      job_id: "job", target_id: "target", recovering_coverage_failure: false,
      resume: true, current_selector_state: "inherited_existing",
      resume_focus: [{ code: "table_structure_confirmation_pending", path: "/table_structure/tables/0/status",
        how_to_pass: "先 read_table_summary 核对 saved_decision，再 stage_table_structure 保存原文支持的完整决定。" }],
    });
    const navigation = JSON.parse(prompt.match(/<repair_navigation>\s*([\s\S]*?)\s*<\/repair_navigation>/u)![1]!);
    expect(navigation[0]).toMatchObject({ code: "table_structure_confirmation_pending",
      how_to_pass: "先 read_table_summary 核对 saved_decision，再 stage_table_structure 保存原文支持的完整决定。" });
    expect(prompt).toContain("先按当前有效读取参数处理点名记录及直接依赖");
    expect(prompt).not.toContain("按路径对应的 collection/key");
    expect(prompt).not.toContain("直接 read_target_selectors 按 focus");
    expect(prompt).not.toContain("每修复一个清单项就立刻 stage_target_selector_draft");
  });

  test.each([
    { recovering_coverage_failure: true, resume: false },
    { recovering_coverage_failure: false, resume: true },
  ])("refuses to describe a blank selector as a durable resume checkpoint", (mode) => {
    expect(() => targetSelectorStartupPrompt({
      job_id: "job",
      target_id: "target",
      current_selector_state: "blank",
      ...mode,
    })).toThrowError(/target_selector_resume_checkpoint_missing/u);
  });

  test("resumes an interrupted investigation before its first selector write without inventing a draft", () => {
    const options = {
      job_id: "job", target_id: "target", recovering_coverage_failure: false,
      resume: true, current_selector_state: "blank" as const, unstarted_selector_verified: true,
    };
    const prompt = targetSelectorStartupPrompt(options);
    expect(prompt).toContain('"current_selector_state":"blank"');
    expect(prompt).toContain("已确认首写前空白才可建立首份 selector");
    expect(prompt).not.toContain("依据已保存结论");
    expect(() => targetSelectorStartupPrompt({ ...options, recovering_coverage_failure: true }))
      .toThrowError(/target_selector_resume_checkpoint_missing/u);
  });

  test.each([
    ["program_prefill", "program_prefill 是原文候选骨架", false],
    ["unvalidated_draft", "已有记录不等于完成", true],
    ["validated_candidate", "当前候选已通过程序验证", true],
  ] as const)("distinguishes %s from completed extraction without discarding saved work", (checkpoint, expected, resume) => {
    const prompt = targetSelectorStartupPrompt({
      job_id: "job", target_id: "target", recovering_coverage_failure: false, resume,
      current_selector_state: "current_existing", current_selector_checkpoint: checkpoint,
    });
    expect(prompt).toContain(expected);
    expect(prompt).not.toContain("without rebuilding completed records");
    expect(prompt).not.toContain("Build evidence-bound target selectors");
    if (checkpoint === "program_prefill") expect(prompt).toContain("未完成用 pending，不以 fallback 冒充");
    if (checkpoint === "validated_candidate") {
      expect(prompt).toContain("seal_validated_plan");
      expect(prompt).not.toContain("<repair_navigation>");
      expect(prompt).not.toContain("independent coverage approval");
    }
  });

  test("abandons a legacy coverage session and always starts from the durable checkpoint", () => {
    const legacySession = "E:/fixture/coverage-review/legacy-54mb-session.jsonl";
    const firstInvocation = coverageReviewInvocationPolicy(legacySession);
    const sameCheckpointRetry = coverageReviewInvocationPolicy(legacySession);

    expect(firstInvocation).toEqual({
      resume: false,
      abandoned_legacy_session: true,
    });
    expect(sameCheckpointRetry).toEqual(firstInvocation);
    expect(coverageReviewInvocationPolicy("")).toEqual({
      resume: false,
      abandoned_legacy_session: false,
    });

    // The session policy has no semantic or coverage budget input/output. Repeating
    // the same durable checkpoint therefore cannot consume either budget.
    expect(Object.keys(firstInvocation).sort()).toEqual([
      "abandoned_legacy_session",
      "resume",
    ]);
  });

  test("restores a rolled-back coverage transaction from its sealed source review", () => {
    const source = "a".repeat(64);
    const rejectedCandidate = "b".repeat(64);
    expect(coverageRepairRecoveryFingerprint({
      last_valid_fingerprint: source,
      coverage_recheck_plan_fingerprint: rejectedCandidate,
      coverage_recheck_source_plan_fingerprint: source,
    })).toBe(source);
    expect(coverageRepairRecoveryFingerprint({
      last_valid_fingerprint: rejectedCandidate,
      coverage_recheck_plan_fingerprint: rejectedCandidate,
      coverage_recheck_source_plan_fingerprint: source,
    })).toBe(rejectedCandidate);
  });
  test("enters a durable coverage repair session instead of repeatedly sealing the same fingerprint", () => {
    const fingerprint = "a".repeat(64);
    const recoveredLegacyCheckpoint = coverageRepairSessionRoute({
      recovering_coverage_failure: true,
      coverage_recheck_plan_fingerprint: fingerprint,
      sealed_repair_review_fingerprint: fingerprint,
      repair: { mode: "validated" },
    });
    expect(recoveredLegacyCheckpoint).toBe("restore_coverage_repair");

    const restoredTransactionOnNextIteration = coverageRepairSessionRoute({
      recovering_coverage_failure: true,
      coverage_recheck_plan_fingerprint: fingerprint,
      repair: { mode: "repair", repair_source: "coverage" },
    });
    expect(restoredTransactionOnNextIteration).toBe("continue_coverage_repair");
    expect([
      recoveredLegacyCheckpoint,
      restoredTransactionOnNextIteration,
    ]).not.toContain("normal");
  });

  test("continues an absent or working coverage review instead of restoring repair", () => {
    const fingerprint = "a".repeat(64);
    expect(coverageRepairSessionRoute({
      recovering_coverage_failure: true,
      coverage_recheck_plan_fingerprint: fingerprint,
      repair: { mode: "validated" },
    })).toBe("normal");
    expect(coverageRepairSessionRoute({
      recovering_coverage_failure: true,
      coverage_recheck_plan_fingerprint: fingerprint,
      sealed_repair_review_fingerprint: "b".repeat(64),
      repair: { mode: "validated" },
    })).toBe("normal");
  });

  test("hands both a new coverage review and an existing repair review back to the batch", () => {
    const fingerprint = "a".repeat(64);
    expect(sealCoverageHandoffFingerprint({
      error: "domain_coverage_review_required",
      current_fingerprint: fingerprint,
    })).toBe(fingerprint);
    expect(sealCoverageHandoffFingerprint({
      error: "domain_coverage_repair_required",
      current_fingerprint: fingerprint,
    })).toBe(fingerprint);
    expect(sealCoverageHandoffFingerprint({
      error: "coverage_harness_defect",
      current_fingerprint: fingerprint,
    })).toBe("");
    expect(sealCoverageHandoffFingerprint({
      error: "domain_coverage_repair_required",
    })).toBe("");
  });

  test("hands a durable local coverage issue to a fresh finalization phase", () => {
    const localValidation = {
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: { details: { ok: true, error: "coverage_review_local_validation", budget_consumed: false } },
    };
    expect(coverageReviewStageHandoff(localValidation)).toBe("finalization");
    expect(isCoverageFinalizationHandoff(localValidation)).toBe(true);

    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: {
        details: {
          ok: true,
          budget_consumed: false,
          changed_record_count: 4,
          semantic_progress_changed: true,
          coverage_checkpoint: { ready_for_validation: false },
        },
      },
    })).toBe("investigation");
    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: {
        details: {
          ok: true,
          budget_consumed: false,
          changed_record_count: 0,
          semantic_progress_changed: false,
          coverage_checkpoint: { ready_for_validation: false },
        },
      },
    })).toBe("none");
    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: {
        details: {
          ok: true,
          budget_consumed: false,
          changed_record_count: 0,
          semantic_progress_changed: false,
          mechanical_finalization_required: true,
          coverage_checkpoint: { ready_for_validation: false },
        },
      },
    })).toBe("finalization");
    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: {
        details: {
          ok: true,
          coverage_checkpoint: { ready_for_validation: true },
          validation: { ok: true, fingerprint: "a".repeat(64) },
          ready_for_seal: true,
        },
      },
    })).toBe("ready");
    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "stage_coverage_review_draft",
      result: {
        details: {
          ok: true,
          coverage_checkpoint: { ready_for_validation: true },
          validation: { ok: false, issues: [{ code: "invalid_binding" }] },
          ready_for_seal: false,
        },
      },
    })).toBe("finalization");
    expect(coverageReviewStageHandoff({
      type: "tool_execution_end",
      toolName: "open_review_evidence",
      result: { details: { error: "coverage_review_local_validation" } },
    })).toBe("none");
  });

  test("fails a fresh coverage phase loop after two unchanged durable reviews", () => {
    const first = coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-a",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-a",
      current_last_valid_fingerprint: "",
      consecutive_without_progress: 0,
    });
    expect(first).toEqual({
      durable_progress: false,
      consecutive_without_progress: 1,
      stalled: false,
    });

    const second = coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-a",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-a",
      current_last_valid_fingerprint: "",
      consecutive_without_progress: first.consecutive_without_progress,
    });
    expect(second).toEqual({
      durable_progress: false,
      consecutive_without_progress: 2,
      stalled: true,
    });
  });

  test("coverage progress ignores history-only writes and resets after a real checkpoint change", () => {
    const historyOnly = coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-a",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-a",
      current_last_valid_fingerprint: "",
      consecutive_without_progress: 1,
    });
    expect(historyOnly.stalled).toBe(true);

    expect(coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-a",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-b",
      current_last_valid_fingerprint: "",
      consecutive_without_progress: historyOnly.consecutive_without_progress,
    })).toEqual({
      durable_progress: true,
      consecutive_without_progress: 0,
      stalled: false,
    });
  });

  test("does not count a previously seen A-B-A checkpoint cycle as new progress", () => {
    const revisitedA = coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-b",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-a",
      current_last_valid_fingerprint: "",
      current_progress_previously_seen: true,
      consecutive_without_progress: 0,
    });
    expect(revisitedA).toEqual({
      durable_progress: false,
      consecutive_without_progress: 1,
      stalled: false,
    });
    expect(coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-a",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-b",
      current_last_valid_fingerprint: "",
      current_progress_previously_seen: true,
      consecutive_without_progress: revisitedA.consecutive_without_progress,
    })).toEqual({
      durable_progress: false,
      consecutive_without_progress: 2,
      stalled: true,
    });
  });

  test("preserves provider failures instead of counting them as semantic coverage stagnation", () => {
    const providerError = '503: {"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-terra)"}';
    expect(coverageFreshPhaseFailureClass(providerError, "none")).toBe("transport");
    expect(coverageFreshPhaseFailureClass("auth_unavailable: no auth available", "none"))
      .toBe("provider_configuration");
    expect(coverageFreshPhaseFailureClass("This operation was aborted", "investigation"))
      .toBeUndefined();

    expect(coverageFreshPhaseProgress({
      previous_progress_fingerprint: "progress-13-of-25",
      previous_last_valid_fingerprint: "",
      current_progress_fingerprint: "progress-13-of-25",
      current_last_valid_fingerprint: "",
      consecutive_without_progress: 0,
      count_stagnation: false,
    })).toEqual({
      durable_progress: false,
      consecutive_without_progress: 0,
      stalled: false,
    });
  });

  test("does not surface an internal handoff abort as a constrained-session error", () => {
    expect(constrainedSessionResultError({
      current_error: "",
      prompt_loop_error: "",
      assistant_error: "This operation was aborted",
      terminal_requested: false,
      handoff_requested: true,
    })).toBe("");
    expect(constrainedSessionResultError({
      current_error: "503 upstream unavailable",
      prompt_loop_error: "",
      assistant_error: "This operation was aborted",
      terminal_requested: false,
      handoff_requested: true,
    })).toBe("503 upstream unavailable");
  });

  test("surfaces a normal assistant stop before the terminal tool as a retryable session error", () => {
    expect(constrainedSessionResultError({
      current_error: "",
      prompt_loop_error: "",
      assistant_error: "",
      terminal_requested: false,
      handoff_requested: false,
      completed: false,
      assistant_text: "Unable to submit the target plan successfully.",
    })).toBe("agent_stopped_before_terminal_tool: Unable to submit the target plan successfully.");
    expect(constrainedSessionResultError({
      current_error: "",
      prompt_loop_error: "",
      assistant_error: "",
      terminal_requested: false,
      handoff_requested: false,
      completed: true,
      assistant_text: "done",
    })).toBe("");
  });

  test("reports deterministic phase-limit ownership after natural fresh-phase exhaustion", () => {
    expect(coverageFreshPhaseTerminalError({
      completed: false,
      exhausted_phase_limit: true,
      terminal_error: "This operation was aborted",
      max_fresh_phases: 32,
    })).toBe("coverage_fresh_phase_limit: 32 fresh bounded phases did not reach a mechanically valid review");
    expect(coverageFreshPhaseTerminalError({
      completed: false,
      exhausted_phase_limit: false,
      terminal_error: "503 upstream unavailable",
      max_fresh_phases: 32,
    })).toBe("503 upstream unavailable");
    expect(coverageFreshPhaseTerminalError({
      completed: true,
      exhausted_phase_limit: true,
      terminal_error: "",
      max_fresh_phases: 32,
    })).toBe("");
  });

  test("times out when no first remote model event arrives", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 60_000,
      idleMs: 60_000,
    });
    watchdog.start();
    watchdog.observe({ type: "agent_start" });
    watchdog.observe({ type: "turn_start" });
    vi.advanceTimersByTime(59_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledWith("first_event");
  });

  test("continuous assistant stream events keep resetting the idle timer", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 60_000,
      idleMs: 60_000,
    });
    watchdog.start();
    for (let index = 0; index < 10; index += 1) {
      vi.advanceTimersByTime(50_000);
      watchdog.observe({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: String(index) },
      });
    }
    expect(expired).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  test("times out after a previously active model stream becomes idle", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 10_000,
      idleMs: 60_000,
    });
    watchdog.start();
    watchdog.observe({ type: "message_start", message: { role: "assistant" } });
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledWith("idle");
  });

  test("pauses model idle timing throughout local tool execution", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 60_000,
      idleMs: 60_000,
    });
    watchdog.start();
    watchdog.observe({ type: "message_end", message: { role: "assistant" } });
    vi.advanceTimersByTime(30_000);
    watchdog.observe({ type: "tool_execution_start", toolName: "compile_target_selectors" });
    vi.advanceTimersByTime(600_000);
    expect(expired).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  test("starts a fresh idle window after a local tool finishes", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 60_000,
      idleMs: 60_000,
    });
    watchdog.start();
    watchdog.observe({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
    watchdog.observe({ type: "tool_execution_start", toolName: "open_evidence" });
    vi.advanceTimersByTime(120_000);
    watchdog.observe({ type: "tool_execution_end", toolName: "open_evidence" });
    vi.advanceTimersByTime(59_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledWith("idle");
  });

  test("abort disposes the timer and does not report a transport timeout", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const abort = new AbortController();
    const watchdog = new ModelStreamWatchdog(expired, {
      firstEventMs: 60_000,
      idleMs: 60_000,
    });
    watchdog.start(abort.signal);
    abort.abort();
    vi.advanceTimersByTime(600_000);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("recognizes only remote assistant activity as a model event", () => {
    expect(isValidRemoteModelEvent({ type: "message_start", message: { role: "assistant" } })).toBe(true);
    expect(isValidRemoteModelEvent({ type: "message_end", message: { role: "assistant" } })).toBe(true);
    expect(isValidRemoteModelEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } })).toBe(true);
    expect(isValidRemoteModelEvent({ type: "message_start", message: { role: "user" } })).toBe(false);
    expect(isValidRemoteModelEvent({ type: "agent_start" })).toBe(false);
    expect(isValidRemoteModelEvent({ type: "turn_start" })).toBe(false);
    expect(isValidRemoteModelEvent({ type: "tool_execution_start" })).toBe(false);
  });
});

describe("local tool timeout", () => {
  test("gives the catalog autonomous session's bash a longer leash than the default watchdog", () => {
    expect(CATALOG_BASH_TOOL_TIMEOUT_MS).toBe(900_000);
    expect(CATALOG_BASH_TOOL_TIMEOUT_MS).toBeGreaterThan(LOCAL_TOOL_TIMEOUT_MS);
  });

  test("allows a scoped OCR timeout without lengthening other tools", async () => {
    vi.useFakeTimers();
    const execute = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const tools = [{name:'parse_document_with_mineru',execute}, {name:'ordinary',execute}] as unknown as ToolDefinition[];
    const [ocr, ordinary] = withToolExecutionTimeout(tools, 10_000, new Set(), {parse_document_with_mineru:30_000});
    const ocrResult = ocr!.execute('ocr', {}, undefined, undefined, {} as never);
    const ordinaryResult = ordinary!.execute('ordinary', {}, undefined, undefined, {} as never);
    const rejected = expect(ordinaryResult).rejects.toThrow('ordinary exceeded 10000ms');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    await expect(ocrResult).resolves.toMatchObject({content:[{text:'ok'}]});
  });
  test("aborts cooperatively and waits for cleanup before returning ETIMEDOUT", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    let settled = false;
    let durableWrites = 0;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const tool = {
      name: "stuck_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        receivedSignal = signal;
        await cleanup;
        durableWrites += 1;
        signal?.throwIfAborted();
        return { content: [{ type: "text", text: "late success" }] };
      },
    } as unknown as ToolDefinition;
    const [bounded] = withToolExecutionTimeout([tool], 10_000, new Set(["stuck_tool"]));
    const pending = bounded!.execute("call-1", {}, undefined as never, undefined as never)
      .finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow("ETIMEDOUT: local tool stuck_tool exceeded 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    const stateAtTimeout = { aborted: receivedSignal?.aborted, settled, durableWrites };
    releaseCleanup();
    await assertion;
    expect(stateAtTimeout).toEqual({ aborted: true, settled: false, durableWrites: 0 });
    expect(durableWrites).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(durableWrites).toBe(1);
  });

  test("returns a real fallback result when the tool handles the timeout abort", async () => {
    vi.useFakeTimers();
    const tool = {
      name: "fallback_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { content: [{ type: "text", text: "deterministic fallback" }], details: { ok: true, rule_source: "fallback" } };
      },
    } as unknown as ToolDefinition;
    const [bounded] = withToolExecutionTimeout([tool], 10_000, new Set(["fallback_tool"]));
    const pending = bounded!.execute("call-2", {}, undefined as never, undefined as never);
    const assertion = expect(pending).resolves.toMatchObject({ details: { ok: true, rule_source: "fallback" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  test("rejects an ordinary late success after cooperative timeout cleanup", async () => {
    vi.useFakeTimers();
    const tool = {
      name: "late_success_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { content: [{ type: "text", text: "ordinary late success" }], details: { ok: true } };
      },
    } as unknown as ToolDefinition;
    const [bounded] = withToolExecutionTimeout([tool], 10_000, new Set(["late_success_tool"]));
    const pending = bounded!.execute("call-late", {}, undefined as never, undefined as never);
    const assertion = expect(pending).rejects.toThrow("ETIMEDOUT: local tool late_success_tool exceeded 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  test("does not start a tool for an already aborted caller", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const [bounded] = withToolExecutionTimeout([{ name: "never_started", execute } as unknown as ToolDefinition]);
    const caller = new AbortController();
    const reason = new Error("already stopped");
    caller.abort(reason);
    await expect(bounded!.execute("call-pre-abort", {}, caller.signal, undefined as never)).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
  });

  test("retains a hard bound for tools that do not promise cooperative cleanup", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const tool = {
      name: "noncooperative_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        receivedSignal = signal;
        return new Promise<never>(() => undefined);
      },
    } as unknown as ToolDefinition;
    const [bounded] = withToolExecutionTimeout([tool], 10_000);
    const pending = bounded!.execute("call-noncooperative", {}, undefined as never, undefined as never);
    const assertion = expect(pending).rejects.toThrow("ETIMEDOUT: local tool noncooperative_tool exceeded 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(receivedSignal?.aborted).toBe(true);
    await assertion;
  });

  test("keeps ordinary success and caller abort distinct from a local timeout", async () => {
    const successTool = {
      name: "success_tool",
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { ok: true } }),
    } as unknown as ToolDefinition;
    const [successful] = withToolExecutionTimeout([successTool], 10_000);
    await expect(successful!.execute("call-3", {}, undefined as never, undefined as never))
      .resolves.toMatchObject({ details: { ok: true } });

    const caller = new AbortController();
    const callerError = new Error("job stopped");
    const abortableTool = {
      name: "abortable_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        return { content: [] };
      },
    } as unknown as ToolDefinition;
    const [abortable] = withToolExecutionTimeout([abortableTool], 10_000);
    const pending = abortable!.execute("call-4", {}, caller.signal, undefined as never);
    caller.abort(callerError);
    await expect(pending).rejects.toBe(callerError);
  });

  test("caller abort wins even if the cooperative tool swallows it and settles after the timeout", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const tool = {
      name: "caller_race_tool",
      execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        await cleanup;
        return { content: [{ type: "text", text: "swallowed abort" }], details: { ok: true } };
      },
    } as unknown as ToolDefinition;
    const [bounded] = withToolExecutionTimeout([tool], 10_000, new Set(["caller_race_tool"]));
    const caller = new AbortController();
    const callerError = new Error("job abort wins");
    const pending = bounded!.execute("call-race", {}, caller.signal, undefined as never);
    const assertion = expect(pending).rejects.toBe(callerError);
    await Promise.resolve();
    caller.abort(callerError);
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await assertion;
  });
});

describe("catalog rule discovery abort", () => {
  const request = {
    target_key: `reference-target:${"b".repeat(64)}`,
    sample: [{ locator: "line:1", role: "context", text: "第 1 条 示例" }],
    evidence_count: 1,
  };

  test("does not turn an outer job abort into an optional fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-job-abort-"));
    try {
      const job = new AbortController();
      const jobError = new Error("job aborted");
      const ask = createCatalogRuleAsk({ root } as never, job.signal, undefined, {
        runSession: vi.fn(async () => { throw new Error("run session should not start after job abort"); }) as never,
      });
      job.abort(jobError);
      await expect(ask(request)).rejects.toBe(jobError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not mistake a provider ETIMEDOUT code for our local tool timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-tool-timeout-"));
    try {
      let observedSignal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const runSession = vi.fn(async (_workspace: unknown, options: { signal?: AbortSignal }) => {
        observedSignal = options.signal;
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(options.signal?.reason);
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
        throw new Error("unreachable");
      });
      const outer = new AbortController();
      const tool = new AbortController();
      const ask = createCatalogRuleAsk({ root } as never, outer.signal, undefined, { runSession: runSession as never });
      const pending = ask(request, tool.signal);
      await started;
      expect(observedSignal).toBeDefined();
      expect(observedSignal).not.toBe(outer.signal);
      expect(observedSignal).not.toBe(tool.signal);
      const timeout = new Error("ETIMEDOUT: local tool read_reference_facts exceeded 10ms");
      (timeout as Error & { code?: string }).code = "ETIMEDOUT";
      tool.abort(timeout);
      await expect(pending).rejects.toBe(timeout);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("single waiter local timeout settles discovery cleanup and returns the deterministic fallback receipt", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "catalog-timeout-fallback-"));
    try {
      let cleanupFinished = false;
      const ask = createCatalogRuleAsk({ root } as never, undefined, undefined, {
        runSession: vi.fn(async (_workspace: unknown, options: { signal?: AbortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              cleanupFinished = true;
              reject(options.signal?.reason);
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) abort();
          });
        }) as never,
      });
      const evidence = Array.from({ length: 20 }, (_, index) => ({
        evidence_id: `evidence:${index}`,
        role: "formal_table_row",
        locator: `line:${index + 1}/table-row:${index}`,
        text: `unclassified row ${index}`,
      }));
      const tool = {
        name: "read_reference_facts",
        execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
          const resolved = await resolveReferenceCatalog({
            targetKey: "reference-target:timeout-fallback",
            evidence,
            ask,
            signal,
            flightKey: "workspace\0reference-target:timeout-fallback\0evidence",
          });
          return { content: [{ type: "text", text: resolved.rule_source }], details: { ok: true, rule_source: resolved.rule_source } };
        },
      } as unknown as ToolDefinition;
      const [bounded] = withToolExecutionTimeout([tool], 10_000);
      const pending = bounded!.execute("catalog-timeout", {}, undefined as never, undefined as never);
      const assertion = expect(pending).resolves.toMatchObject({ details: { ok: true, rule_source: "fallback" } });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(cleanupFinished).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("target modeling phase budget", () => {
  const cumulativeReadChunk = "x".repeat(100 * 1024);
  const cumulativeReadChunkBytes = Buffer.byteLength(cumulativeReadChunk, "utf8");
  const cumulativeReadsToExceed = Math.floor(
    TARGET_MODELING_PHASE_LIMITS.max_tool_response_bytes / cumulativeReadChunkBytes,
  ) + 1;

  test("rejects the real sampling failure shape at the oversized preflight", () => {
    const budget = new TargetModelingPhaseBudget();
    const realDerivedRounds = [
      { tokens: 4_299, tool: "get_target_context", bytes: 3_535 },
      { tokens: 5_350, tool: "open_evidence", bytes: 11_733 },
      { tokens: 9_932, tool: "open_evidence", bytes: 13_409 },
      { tokens: 38_441, tool: "advance_target_selector_stage", bytes: 392 },
      { tokens: 40_194, tool: "advance_target_selector_stage", bytes: 920_275 },
    ];
    let decision;
    for (const round of realDerivedRounds) {
      budget.observeSdkEvent({
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: round.tokens } },
      });
      decision = budget.recordToolResult(round.tool, {
        content: [{ type: "text", text: "x".repeat(round.bytes) }],
      }, "sampling");
    }
    expect(decision).toMatchObject({
      exceeded: true,
      reason: "single_tool_response_bytes",
      tool_name: "advance_target_selector_stage",
      selector_stage: "sampling",
      observed_context_tokens: 40_194,
      tool_result_count: 5,
      limit_name: "max_single_tool_response_bytes",
      limit: TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes,
    });
  });

  test("bounds cumulative sampling responses but leaves a small session alone", () => {
    const bounded = new TargetModelingPhaseBudget();
    for (let index = 0; index < cumulativeReadsToExceed - 1; index += 1) {
      expect(bounded.recordToolResult(
        index === 0 ? "open_evidence" : index === 1 ? "search_evidence" : "read_target_selectors",
        { content: [{ type: "text", text: cumulativeReadChunk }] },
        "sampling",
      ).exceeded).toBe(false);
    }
    expect(bounded.recordToolResult("read_target_selectors", { content: [{ type: "text", text: cumulativeReadChunk }] }, "sampling")).toMatchObject({
      exceeded: true,
      reason: "cumulative_tool_response_bytes",
    });

    const small = new TargetModelingPhaseBudget();
    small.observeSdkEvent({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: 12_000 } },
    });
    expect(small.recordToolResult("get_target_context", {
      content: [{ type: "text", text: "small bounded result" }],
    }, "primary")).toMatchObject({ exceeded: false, reason: "" });
  });

  test.each(["primary", "sampling", "table", "commit"])(
    "applies the same cumulative response ceiling in the %s modeling stage",
    (stage) => {
      const budget = new TargetModelingPhaseBudget();
      for (let index = 0; index < cumulativeReadsToExceed - 1; index += 1) {
        expect(budget.recordToolResult(`bounded-read-${index + 1}`, {
          content: [{ type: "text", text: cumulativeReadChunk }],
        }, stage).exceeded).toBe(false);
      }
      expect(budget.recordToolResult(`bounded-read-${cumulativeReadsToExceed}`, {
        content: [{ type: "text", text: cumulativeReadChunk }],
      }, stage)).toMatchObject({
        exceeded: true,
        reason: "cumulative_tool_response_bytes",
      });
    },
  );

  test("persists the selector checkpoint and returns a visible terminal failure without rollover", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-modeling-checkpoint-"));
    try {
      const selectorPath = join(root, "working.target-selectors.json");
      const selectorContent = JSON.stringify({ schema_version: "target-selector-plan/v1", items: [{ key: "kept" }] });
      await writeFile(selectorPath, selectorContent, "utf8");
      const checkpoint = vi.fn(async () => targetModelingCheckpointSnapshot({
        workingSelectorPath: selectorPath,
        readState: async () => ({
          next_history_sequence: 7,
          selector_stage: "sampling",
        }),
      } as never));
      const tool = {
        name: "advance_target_selector_stage",
        execute: async () => ({
          content: [{ type: "text", text: "x".repeat(TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes + 1) }],
          details: { ok: false, selector_issues: [] },
        }),
      } as unknown as ToolDefinition;
      const [bounded] = withTargetModelingPhaseBudget(
        [tool],
        new TargetModelingPhaseBudget(),
        () => "sampling",
        checkpoint,
      );
      const result = await bounded!.execute("call-1", {}, undefined as never, undefined as never) as {
        details: Record<string, unknown>;
        content: Array<{ text: string }>;
      };
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(result.details).toMatchObject({
        terminal: true,
        error_code: "target_modeling_phase_budget_exceeded",
        automatic_rollover: false,
        budget_consumed: false,
        phase_budget: {
          exceeded: true,
          tool_name: "advance_target_selector_stage",
          selector_stage: "sampling",
          reason: "single_tool_response_bytes",
          observed_context_tokens: 0,
          tool_response_bytes: TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes + 1,
          cumulative_tool_response_bytes: TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes + 1,
          limit_name: "max_single_tool_response_bytes",
          limit: TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes,
        },
        durable_checkpoint: {
          history_sequence: 7,
          selector_stage: "sampling",
        },
      });
      expect(result.details.error).toEqual(expect.stringContaining("target_modeling_phase_budget_exceeded"));
      expect(result.details.error).toEqual(expect.stringContaining("advance_target_selector_stage"));
      expect(result.details.error).toEqual(expect.stringContaining('"selector_stage":"sampling"'));
      expect(result.details).not.toHaveProperty("rollover_required");
      expect(result.details).not.toHaveProperty("fresh_phase");
      expect(terminalToolFailure(result.details)).toEqual({ error: result.details.error });
      expect(result.content[0]!.text.length).toBeLessThan(2_000);
      expect(await (await import("node:fs/promises")).readFile(selectorPath, "utf8")).toBe(selectorContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports the triggering tool and cumulative bytes from the terminal failure", async () => {
    const checkpoint = vi.fn(async () => ({
      checkpoint_fingerprint: "checkpoint-cumulative",
      working_selector_sha256: "selector-cumulative",
      history_sequence: 11,
      selector_stage: "table",
    }));
    const tool = {
      name: "list_reference_occurrences",
      execute: async () => ({ content: [{ type: "text", text: cumulativeReadChunk }] }),
    } as unknown as ToolDefinition;
    const [bounded] = withTargetModelingPhaseBudget(
      [tool],
      new TargetModelingPhaseBudget(),
      () => "table",
      checkpoint,
    );

    for (let index = 0; index < cumulativeReadsToExceed - 1; index += 1) {
      await bounded!.execute(`call-${index + 1}`, {}, undefined as never, undefined as never);
    }
    const result = await bounded!.execute(`call-${cumulativeReadsToExceed}`, {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
    };
    const cumulativeBytes = cumulativeReadsToExceed * cumulativeReadChunkBytes;

    expect(result.details).toMatchObject({
      terminal: true,
      automatic_rollover: false,
      phase_budget: {
        tool_name: "list_reference_occurrences",
        selector_stage: "table",
        reason: "cumulative_tool_response_bytes",
        tool_response_bytes: cumulativeReadChunkBytes,
        cumulative_tool_response_bytes: cumulativeBytes,
        limit_name: "max_tool_response_bytes",
        limit: TARGET_MODELING_PHASE_LIMITS.max_tool_response_bytes,
      },
      durable_checkpoint: {
        checkpoint_fingerprint: "checkpoint-cumulative",
        selector_stage: "table",
      },
    });
    expect(result.details.error).toEqual(expect.stringContaining("list_reference_occurrences"));
    expect(result.details.error).toEqual(expect.stringContaining(`"cumulative_tool_response_bytes":${cumulativeBytes}`));
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  test("clears cumulative bytes after a successful staged draft so later reads start a new slice", async () => {
    const checkpoint = vi.fn(async () => ({
      checkpoint_fingerprint: "checkpoint-reset",
      working_selector_sha256: "selector-reset",
      history_sequence: 3,
      selector_stage: "primary",
    }));
    const readTool = {
      name: "read_target_selectors",
      execute: async () => ({ content: [{ type: "text", text: cumulativeReadChunk }] }),
    } as unknown as ToolDefinition;
    const stageTool = {
      name: "stage_target_selector_draft",
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, draft_status: "saved_not_validated" }) }],
        details: { ok: true, draft_status: "saved_not_validated" },
      }),
    } as unknown as ToolDefinition;
    const [read, stage] = withTargetModelingPhaseBudget(
      [readTool, stageTool],
      new TargetModelingPhaseBudget(),
      () => "primary",
      checkpoint,
    );

    for (let index = 0; index < cumulativeReadsToExceed - 1; index += 1) {
      await read!.execute(`before-${index}`, {}, undefined as never, undefined as never);
    }
    await stage!.execute("save", {}, undefined as never, undefined as never);
    for (let index = 0; index < cumulativeReadsToExceed - 2; index += 1) {
      await read!.execute(`after-${index}`, {}, undefined as never, undefined as never);
    }
    const stillOpen = await read!.execute("still-open", {}, undefined as never, undefined as never) as {
      details?: Record<string, unknown>;
    };
    expect(stillOpen.details?.error_code).not.toBe("target_modeling_phase_budget_exceeded");
    expect(checkpoint).not.toHaveBeenCalled();

    const exceeded = await read!.execute("exceeded", {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
    };
    expect(exceeded.details).toMatchObject({
      error_code: "target_modeling_phase_budget_exceeded",
      phase_budget: { reason: "cumulative_tool_response_bytes", tool_result_count: cumulativeReadsToExceed },
    });
  });

  test("does not clear cumulative bytes after a failed commit", async () => {
    const checkpoint = vi.fn(async () => ({
      checkpoint_fingerprint: "checkpoint-failed-commit",
      working_selector_sha256: "selector-failed-commit",
      history_sequence: 4,
      selector_stage: "commit",
    }));
    const readTool = {
      name: "read_target_selectors",
      execute: async () => ({ content: [{ type: "text", text: cumulativeReadChunk }] }),
    } as unknown as ToolDefinition;
    const commitTool = {
      name: "commit_target_selector_draft",
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "selector_input_error" }) }],
        details: { ok: false, error: "selector_input_error" },
      }),
    } as unknown as ToolDefinition;
    const [read, commit] = withTargetModelingPhaseBudget(
      [readTool, commitTool],
      new TargetModelingPhaseBudget(),
      () => "commit",
      checkpoint,
    );

    for (let index = 0; index < cumulativeReadsToExceed - 1; index += 1) {
      await read!.execute(`r${index + 1}`, {}, undefined as never, undefined as never);
    }
    await commit!.execute("c1", {}, undefined as never, undefined as never);
    const exceeded = await read!.execute(`r${cumulativeReadsToExceed}`, {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
    };
    expect(exceeded.details).toMatchObject({
      error_code: "target_modeling_phase_budget_exceeded",
      phase_budget: { reason: "cumulative_tool_response_bytes" },
    });
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  test("returns ordinary tool results unchanged below the phase limit", async () => {
    const original = {
      content: [{ type: "text", text: "small bounded result" }],
      details: { ok: true, value: "kept" },
    };
    const checkpoint = vi.fn();
    const tool = {
      name: "get_target_context",
      execute: async () => original,
    } as unknown as ToolDefinition;
    const [bounded] = withTargetModelingPhaseBudget(
      [tool],
      new TargetModelingPhaseBudget(),
      () => "primary",
      checkpoint,
    );

    await expect(bounded!.execute("call-1", {}, undefined as never, undefined as never))
      .resolves.toBe(original);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  test("observed context-token overrun asks for coverage's fresh session from the selector checkpoint", async () => {
    const budget = new TargetModelingPhaseBudget();
    budget.observeSdkEvent({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens } },
    });
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "full roster dump" }],
      details: { ok: true },
    }));
    const checkpoint = vi.fn(async () => ({
      checkpoint_fingerprint: "checkpoint-tokens",
      working_selector_sha256: "selector-tokens",
      history_sequence: 9,
      selector_stage: "table",
    }));
    const [bounded] = withTargetModelingPhaseBudget(
      [{ name: "read_target_selectors", execute } as unknown as ToolDefinition],
      budget,
      () => "table",
      checkpoint,
    );
    const result = await bounded!.execute("call-1", {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
      content: Array<{ text: string }>;
    };

    expect(execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: false,
      terminal: false,
      error_code: "repair_session_restart_required",
      fresh_session_required: true,
      automatic_rollover: false,
      phase_budget: {
        exceeded: true,
        reason: "observed_context_tokens",
        tool_name: "read_target_selectors",
        selector_stage: "table",
        observed_context_tokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens,
        limit_name: "max_observed_context_tokens",
        limit: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens,
      },
      durable_checkpoint: {
        checkpoint_fingerprint: "checkpoint-tokens",
        selector_stage: "table",
      },
    });
    expect(String(result.details.error)).toMatch(/repair_session_restart_required/);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    expect(result.details).toMatchObject({
      current_session_stopped: true, original_tool_executed: false, author_draft_mutation: false,
      next_tool: null, next_tools: [], next_tool_scope: "none", writable_paths: [],
      required_action: "stop_current_session_and_preserve_checkpoint",
      recovery_guidance: { tool_scope: "fresh_provider_session_only", budget_policy: "preserve_existing_counters",
        candidate_read_tool: "read_target_selectors" },
    });
    expect(result.details).not.toHaveProperty("candidate_read_tool");
    expect(result.details).not.toHaveProperty("writable_collection");
    expect(String(result.details.instruction)).toMatch(/停止本会话/u);
    expect(result.details).not.toHaveProperty("rollover_required");
    expect(result.details).not.toHaveProperty("fresh_phase");
    expect(result.details.error_code).not.toBe("target_modeling_phase_budget_exceeded");
    expect(terminalToolFailure(result.details)).toBeUndefined();
    expect(freshSessionRestartFromTool(result.details)).toBe(true);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(result.content[0]!.text.length).toBeLessThan(2_000);
  });

  test.each([
    "stage_target_selector_draft",
    "advance_target_selector_stage",
    "commit_target_selector_draft",
  ])("keeps a successful %s checkpoint and continues from a fresh session when only context tokens are full", async (toolName) => {
    const publicBody = { ok: true, draft_status: "saved_not_validated", saved_count: 1,
      source_handle_scope: "current-neutral-scope", span_id: "s1",
      next_tool: "advance_target_selector_stage", next_tool_arguments: { next_stage: "sampling" },
      writable_paths: ["/items"], instruction: "Original saved result." };
    const original = {
      content: [{ type: "text", text: JSON.stringify(publicBody) }],
      details: { ...publicBody, span_id: "span:internal-neutral-source" },
    };
    const execute = vi.fn(async () => original);
    const budget = new TargetModelingPhaseBudget();
    budget.observeSdkEvent({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens } },
    });
    const checkpoint = vi.fn(async () => ({
      checkpoint_fingerprint: "checkpoint-write",
      working_selector_sha256: "selector-write",
      history_sequence: 12,
      selector_stage: "commit",
    }));
    const [bounded] = withTargetModelingPhaseBudget(
      [{ name: toolName, execute } as unknown as ToolDefinition],
      budget,
      () => "commit",
      checkpoint,
    );
    const result = await bounded!.execute("call-1", {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
      content: Array<{ text: string }>;
    };

    expect(execute).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      ok: true,
      draft_status: "saved_not_validated",
      fresh_session_required: true,
      phase_budget: { reason: "observed_context_tokens" },
      durable_checkpoint: { checkpoint_fingerprint: "checkpoint-write" },
    });
    expect(result.details.terminal).not.toBe(true);
    const published = JSON.parse(result.content[0]!.text);
    expect(published).toMatchObject({
      ok: true, draft_status: "saved_not_validated", saved_count: 1,
      source_handle_scope: "current-neutral-scope", span_id: "s1",
      current_session_stopped: true, fresh_session_required: true,
      next_tool: null, next_tools: [], writable_paths: [], next_tool_scope: "none",
      durable_checkpoint: { checkpoint_fingerprint: "checkpoint-write", history_sequence: 12 },
      recovery_guidance: { tool_scope: "fresh_provider_session_only", budget_policy: "preserve_existing_counters",
        previous_tool_recovery: { next_tool: "advance_target_selector_stage",
          next_tool_arguments: { next_stage: "sampling" }, writable_paths: ["/items"], instruction: "Original saved result." } },
    });
    expect(published).not.toHaveProperty("next_tool_arguments");
    expect(result.content[0]!.text).not.toContain("span:internal-neutral-source");
    expect(freshSessionRestartFromTool(published)).toBe(true);
    expect(terminalToolFailure(published)).toBeUndefined();
    expect(result.details.error_code).not.toBe("target_modeling_phase_budget_exceeded");
    expect(terminalToolFailure(result.details)).toBeUndefined();
    expect(freshSessionRestartFromTool(result.details)).toBe(true);
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  test("publishes a context stop alongside a failed save without claiming a successful checkpoint or leaking internal IDs", async () => {
    const publicBody = { ok: false, error: "neutral_save_rejected", actual: { span_id: "s1" },
      next_tool: "open_evidence", next_tool_arguments: { evidence_id: "e1" }, instruction: "Confirm the authored source." };
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify(publicBody) }],
      details: { ...publicBody, actual: { span_id: "span:internal-neutral-source" } } }));
    const budget = new TargetModelingPhaseBudget();
    budget.observeSdkEvent({ type: "message_end", message: { role: "assistant",
      usage: { totalTokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens } } });
    const reset = vi.spyOn(budget, "resetCumulativeSlice");
    const checkpoint = vi.fn(async () => ({ checkpoint_fingerprint: "unchanged-checkpoint",
      working_selector_sha256: "unchanged-selectors", history_sequence: 2, selector_stage: "table" }));
    const [bounded] = withTargetModelingPhaseBudget([{ name: "stage_target_selector_draft", execute } as unknown as ToolDefinition],
      budget, () => "table", checkpoint);
    const result = await bounded!.execute("failed-write", {}, undefined as never, undefined as never) as { content: Array<{ text: string }> };
    const published = JSON.parse(result.content[0]!.text);
    expect(published).toMatchObject({ ok: false, error: "neutral_save_rejected", actual: { span_id: "s1" },
      fresh_session_required: true, current_session_stopped: true, next_tool: null,
      durable_checkpoint: { history_sequence: 2 },
      recovery_guidance: { previous_tool_recovery: { next_tool: "open_evidence", next_tool_arguments: { evidence_id: "e1" } } } });
    expect(String(published.instruction)).not.toContain("检查点已保存");
    expect(result.content[0]!.text).not.toContain("span:internal-neutral-source");
    expect(reset).not.toHaveBeenCalled();
    expect(freshSessionRestartFromTool(published)).toBe(true);
    const later = await bounded!.execute("latched-write", {}, undefined as never, undefined as never) as { content: Array<{ text: string }> };
    expect(JSON.parse(later.content[0]!.text)).toMatchObject({ ok: false, error_code: "repair_session_restart_required" });
    expect(execute).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  test("does not execute a later read after a context-token restart has been latched", async () => {
    const budget = new TargetModelingPhaseBudget();
    budget.observeSdkEvent({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens } },
    });
    const read = vi.fn(async () => ({ content: [{ type: "text", text: "dump" }] }));
    const [bounded] = withTargetModelingPhaseBudget(
      [{ name: "read_target_selectors", execute: read } as unknown as ToolDefinition],
      budget,
      () => "table",
      async () => ({
        checkpoint_fingerprint: "latched",
        working_selector_sha256: "latched",
        history_sequence: 1,
        selector_stage: "table",
      }),
    );
    await bounded!.execute("first", {}, undefined as never, undefined as never);
    const later = await bounded!.execute("second", {}, undefined as never, undefined as never) as {
      details: Record<string, unknown>;
    };
    expect(read).not.toHaveBeenCalled();
    expect(later.details).toMatchObject({
      error_code: "repair_session_restart_required",
      fresh_session_required: true,
    });
  });
});

describe("fresh session restart from tool details", () => {
  test("reuses coverage's fresh-session signals and the modeling context-token flag", () => {
    expect(freshSessionRestartFromTool({ fresh_repair_session_required: true })).toBe(true);
    expect(freshSessionRestartFromTool({ error: "fresh_repair_session_required" })).toBe(true);
    expect(freshSessionRestartFromTool({ fresh_session_required: true })).toBe(true);
    expect(freshSessionRestartFromTool({ error: "repair_session_restart_required" })).toBe(true);
    expect(freshSessionRestartFromTool({ terminal: true, error: "compiler_invariant_violation" })).toBe(false);
    expect(freshSessionRestartFromTool({ ok: true })).toBe(false);
  });

  test("forces a fresh provider session when modeling sets coverage's fresh_session_required flag", () => {
    expect(requiresFreshProviderSession({
      mode: "modeling",
      fresh_session_required: true,
    })).toBe(true);
    expect(requiresFreshProviderSession({
      mode: "modeling",
      fresh_session_required: false,
    })).toBe(false);
    expect(requiresFreshProviderSession({
      mode: "repair",
      fresh_session_required: false,
      repair_source: "coverage",
    })).toBe(true);
    expect(requiresFreshProviderSession({
      mode: "repair",
      fresh_session_required: true,
      repair_source: "validation",
    })).toBe(true);
    expect(requiresFreshProviderSession({
      mode: "repair",
      fresh_session_required: false,
      repair_source: "validation",
    })).toBe(false);
  });

  test("persists coverage's fresh_session_required flag for a modeling context-token stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-fresh-session-"));
    try {
      const selectorPath = join(root, "working.target-selectors.json");
      await writeFile(selectorPath, JSON.stringify({ schema_version: "target-selector-plan/v1", items: [] }), "utf8");
      const state = {
        next_history_sequence: 4,
        selector_stage: "table",
        repair: { mode: "modeling", fresh_session_required: false, session_epoch: 0 },
      };
      const appendEvent = vi.fn(async () => undefined);
      const workspace = {
        workingSelectorPath: selectorPath,
        readState: async () => state,
        updateState: async (mutator: (value: typeof state) => void) => {
          mutator(state);
          return state;
        },
        appendEvent,
      };
      const decision = {
        exceeded: true,
        tool_name: "commit_target_selector_draft",
        selector_stage: "table",
        reason: "observed_context_tokens" as const,
        observed_context_tokens: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens,
        tool_response_bytes: 120,
        cumulative_tool_response_bytes: 120,
        tool_result_count: 3,
        limit_name: "max_observed_context_tokens" as const,
        limit: TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens,
      };
      await persistTargetModelingPhaseBudgetOutcome(workspace as never, decision);
      expect(state.repair.fresh_session_required).toBe(true);
      expect(appendEvent).toHaveBeenCalledWith(
        "repair_session_restart_required",
        expect.objectContaining({
          error_code: "repair_session_restart_required",
          reason: "observed_context_tokens",
          terminal: false,
          fresh_session_required: true,
          automatic_rollover: false,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("terminal tool failure routing", () => {
  test("stops on validator budget and compiler-owned terminal failures", () => {
    expect(terminalToolFailure({ terminal: true, error: "compiler_invariant_violation" }))
      .toEqual({ error: "compiler_invariant_violation" });
    expect(terminalToolFailure({ terminal: true, error: "target_blocked_with_evidence" }))
      .toEqual({ error: "target_blocked_with_evidence" });
    expect(terminalToolFailure({ error: "final_validator_attempt_limit" }))
      .toEqual({ error: "final_validator_attempt_limit" });
    expect(terminalToolFailure({ ok: false, issue_owner: "selector_input_error" })).toBeUndefined();
  });

  test("preserves a wrapped typed blocker failure class without inspecting error text", () => {
    expect(terminalToolFailure({
      terminal: true,
      error: "target_blocked_with_evidence",
      blocker: { kind: "scope_extension_required" },
    })).toEqual({
      error: "target_blocked_with_evidence",
      blocker_code: "scope_extension_required",
      failure_class: "scope_extension",
    });
    expect(terminalToolFailure({
      terminal: true,
      error: "target_blocked_with_evidence",
      blocker: { kind: "harness_contract_defect" },
    })).toEqual({
      error: "target_blocked_with_evidence",
      blocker_code: "harness_contract_defect",
      failure_class: "coverage_harness_defect",
    });
  });
});
