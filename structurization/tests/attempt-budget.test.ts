import { describe, expect, test } from "vitest";

import {
  canRestartRepairSession,
  canRetryTargetFailure,
  canTransitionToFreshSessionRestart,
  classifyTargetFailure,
  hasResumableTransportRetry,
  isRepairSessionRestartRequired,
  isScopeExtensionRequired,
  isUnrecoverableProtocolBudgetFailure,
  isContinuingCoverageRepair,
  protocolTargetFailure,
  recordTransportFailure,
  resetLegacyMisclassifiedTransportCounters,
  targetBlockerFailureClass,
  targetAttemptLimits,
  targetTransportRetryDelayMs,
  transportErrorKey,
} from "../src/attempt-budget.js";

describe("Pi target attempt budgets", () => {
  test.each([["HTTP 503 unavailable", "http_503"], ["Connection error.", "connection_closed"], ["Request timed out.", "timeout"]])(
    "only an unexhausted matching network checkpoint is eligible for recovery: %s", (error, errorKey) => {
      const counters = { transport_attempts: 7, candidate_validation_attempts: 3, coverage_repair_attempts: 1 };
      const limits = targetAttemptLimits({ maxAttempts: 3 });
      const window = { checkpoint: "a".repeat(64), error_key: errorKey, consecutive_failures: 3 };
      const before = structuredClone({ counters, limits, window });
      expect(hasResumableTransportRetry(error, counters, limits, window)).toBe(true);
      expect(hasResumableTransportRetry(error, counters, limits, { ...window, consecutive_failures: 4 })).toBe(false);
      expect(hasResumableTransportRetry(error, counters, limits, { ...window, error_key: "unrelated-incident" })).toBe(false);
      expect(hasResumableTransportRetry(error, counters, limits, undefined)).toBe(false);
      expect(hasResumableTransportRetry("target_progress_stalled", counters, limits, window)).toBe(false);
      expect(hasResumableTransportRetry("HTTP 401 invalid api key", counters, limits, window)).toBe(false);
      expect(hasResumableTransportRetry("500 context_too_large", counters, limits, { ...window, error_key: undefined })).toBe(false);
      expect({ counters, limits, window }).toEqual(before);
    },
  );

  test.each(["Connection error.", "Request timed out."])("SDK transport message does not spend candidate repair attempts: %s", error => {
    const counters = { transport_attempts: 7, candidate_validation_attempts: 3, coverage_repair_attempts: 1 };
    const before = structuredClone(counters);
    const limits = targetAttemptLimits({ maxAttempts: 3 });
    expect(classifyTargetFailure(error)).toBe("transport");
    let window;
    for (let failure = 1; failure <= 4; failure++) {
      window = recordTransportFailure(window, "neutral-saved-checkpoint", error);
      expect(window).toMatchObject({ error_key: error.startsWith("Connection") ? "connection_closed" : "timeout", consecutive_failures: failure });
      expect(canRetryTargetFailure(error, counters, limits, window)).toBe(failure <= 3);
    }
    expect(counters).toEqual(before);
    expect(classifyTargetFailure(`validation rejected field containing '${error}'`)).toBe("candidate");
  });

  test("does not accumulate different network failures at the same saved checkpoint", () => {
    let window;
    for (const error of ["408 stream disconnected", "500 request one", "503 auth_unavailable", "408 stream disconnected", "500 request two"]) {
      window = recordTransportFailure(window, "checkpoint", error);
      expect(window.consecutive_failures).toBe(1);
    }
    window = recordTransportFailure(window, "checkpoint", "500 request three");
    expect(window).toMatchObject({ error_key: "http_500", consecutive_failures: 2 });
    expect(recordTransportFailure(window, "new-checkpoint", "500 request four").consecutive_failures).toBe(1);
    expect(recordTransportFailure({ checkpoint: "checkpoint", consecutive_failures: 9 }, "checkpoint", "500 legacy").consecutive_failures).toBe(1);
  });

  test.each([
    "OpenAI Responses stream ended before a terminal response event",
    "Error: OpenAI Responses stream ended before a terminal response event.",
  ])("an incomplete SDK stream retries within its transport window: %s", error => {
    const counters = { transport_attempts: 7, candidate_validation_attempts: 3, coverage_repair_attempts: 1 };
    const limits = targetAttemptLimits({ maxAttempts: 3 });
    const before = structuredClone({ counters, limits });
    expect(classifyTargetFailure(error)).toBe("transport");
    expect(transportErrorKey(error)).toBe("connection_closed");
    let window;
    for (let failure = 1; failure <= 4; failure++) {
      window = recordTransportFailure(window, "b".repeat(64), error);
      expect(window.consecutive_failures).toBe(failure);
      expect(canRetryTargetFailure(error, counters, limits, window)).toBe(failure <= 3);
      expect(hasResumableTransportRetry(error, counters, limits, window)).toBe(failure <= 3);
    }
    expect({ counters, limits }).toEqual(before);
    expect(classifyTargetFailure(`validation rejected field containing '${error}'`)).toBe("candidate");
  });

  test("keeps proxy 503 cooldowns retryable, but not permanent credentials or context errors", () => {
    expect(transportErrorKey("503 auth_unavailable: no auth available; last upstream error timeout")).toBe("http_503");
    expect(transportErrorKey("auth_unavailable: no auth available")).toBeUndefined();
    expect(transportErrorKey("401 invalid api key")).toBeUndefined();
    expect(transportErrorKey("500 context_too_large")).toBeUndefined();
    expect(classifyTargetFailure("HTTP 408")).toBe("transport");
  });
  test("allows three bounded transport recoveries without granting semantic attempts", () => {
    const error = '500: {"message":"upstream: utls: TLS handshake: EOF"}';
    const limits = targetAttemptLimits({ maxAttempts: 3 });
    expect(limits).toEqual({ transport_retries: 3, candidate_validation_attempts: 3, coverage_repair_attempts: 1 });
    const counters = { transport_attempts: 0, candidate_validation_attempts: 3, coverage_repair_attempts: 1 };
    let window;
    for (let failure = 1; failure <= 4; failure += 1) {
      counters.transport_attempts += 1;
      window = recordTransportFailure(window, "unchanged-durable-checkpoint");
      expect(canRetryTargetFailure(error, counters, limits, window)).toBe(failure <= 3);
    }
    expect(canRetryTargetFailure("semantic validation rejected", counters, limits, window)).toBe(false);
    expect(targetAttemptLimits({ maxAttempts: 3, transportRetries: 1 }).transport_retries).toBe(1);
  });

  test("backs off beyond SDK short retries with bounded jitter", () => {
    expect([1, 2, 3, 4].map(n => targetTransportRetryDelayMs("TLS handshake: EOF", n, () => 0)))
      .toEqual([15_000, 30_000, 60_000, 60_000]);
    expect(targetTransportRetryDelayMs("TLS handshake: EOF", 1, () => 1)).toBe(18_000);
    expect(targetTransportRetryDelayMs("429 rate limit", 1, () => 0)).toBe(20_000);
    expect(targetTransportRetryDelayMs("429 rate limit", 3, () => 1)).toBe(60_000);
  });
  test("only the persisted current or source review can continue a coverage transaction", () => {
    const recheck = { schema_version: "coverage-recheck-scope/v1", plan_fingerprint: "repaired", source_plan_fingerprint: "original" };
    expect(isContinuingCoverageRepair(recheck, "original")).toBe(true);
    expect(isContinuingCoverageRepair(recheck, "repaired")).toBe(true);
    expect(isContinuingCoverageRepair(recheck, "unrelated")).toBe(false);
    expect(isContinuingCoverageRepair(recheck, "")).toBe(false);
    expect(isContinuingCoverageRepair(undefined, "repaired")).toBe(false);
  });
  test.each([
    "terminated",
    "Stream ended without finish_reason",
    "EOF while parsing a value",
    "HTTP 429",
    "HTTP 503",
    "HTTP 511",
    "Response incomplete: max_messages",
    "model_stream_idle_timeout",
    "stream error: stream disconnected before completion: stream closed before response.completed",
  ])("classifies broken model streams as transport failures: %s", (error) => {
    expect(classifyTargetFailure(error)).toBe("transport");
  });

  test.each([
    'HTTP 400 invalid tool schema',
    'HTTP 401 invalid api key',
    '402 "Grok Build usage balance exhausted"',
    '403 "You have run out of credits"',
    'target_modeling_provider_context_exceeded: {"provider_error":"HTTP 400 context_too_large"}',
    "auth_unavailable: no auth available",
  ])("stops on provider configuration failures without retrying or spending semantic attempts: %s", (error) => {
    expect(classifyTargetFailure(error)).toBe("provider_configuration");
    expect(canRetryTargetFailure(error, {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 1,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 1,
    })).toBe(false);
  });

  test("keeps semantic validation failures in the candidate budget", () => {
    expect(classifyTargetFailure("validation rejected 23 semantic issues")).toBe("candidate");
    expect(classifyTargetFailure("finish_reason=length")).toBe("candidate");
    expect(classifyTargetFailure("length_without_durable_progress: 3 consecutive rounds"))
      .toBe("candidate");
  });

  test("provider max_messages uses bounded transport retries at the saved checkpoint", () => {
    const error = "Response incomplete: max_messages";
    const counters = { transport_attempts: 0, candidate_validation_attempts: 3, coverage_repair_attempts: 1 };
    const limits = targetAttemptLimits({ maxAttempts: 3 });
    let window;
    for (let failure = 1; failure <= 4; failure++) {
      counters.transport_attempts++;
      window = recordTransportFailure(window, "same-checkpoint", error);
      expect(window).toMatchObject({ error_key: "max_messages", consecutive_failures: failure });
      expect(canRetryTargetFailure(error, counters, limits, window)).toBe(failure <= 3);
    }
    expect(counters.candidate_validation_attempts).toBe(3);
    expect(classifyTargetFailure("Response incomplete: max_output_tokens")).toBe("candidate");
    expect(classifyTargetFailure("validation rejected max_messages selector text")).toBe("candidate");
  });

  test("routes target scope extension outside the candidate retry budget", () => {
    const error = "scope_extension_required";
    expect(isScopeExtensionRequired(error)).toBe(true);
    expect(classifyTargetFailure(error)).toBe("scope_extension");
    expect(canRetryTargetFailure(error, {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 3,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 3,
    })).toBe(false);
  });

  test("classifies typed blocker codes without inspecting the terminal wrapper text", () => {
    expect(targetBlockerFailureClass("scope_extension_required")).toBe("scope_extension");
    expect(targetBlockerFailureClass("harness_contract_defect")).toBe("coverage_harness_defect");
    expect(targetBlockerFailureClass("ambiguous_source")).toBe("candidate");
  });

  test.each([
    "compiler_invariant_violation",
    'target_modeling_phase_budget_exceeded: {"tool_name":"list_reference_occurrences","selector_stage":"table","reason":"cumulative_tool_response_bytes"}',
    "target_selector_resume_checkpoint_missing: coverage repair requires nonblank persisted target selectors",
    "target_selector_resume_evidence_mismatch: persisted evidence changed",
    "scope_extension_requires_checkpoint_recovery: saved target items exist",
    "Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor",
  ])("fails a target immediately on nonrecoverable selector/modeling state: %s", (error) => {
    expect(classifyTargetFailure(error)).toBe("coverage_harness_defect");
    expect(canRetryTargetFailure(error, {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 1,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 1,
    })).toBe(false);
  });

  test("keeps bounded repair-session restarts out of transport retries", () => {
    const error = "repair_session_restart_required: active validation cluster did not shrink";
    expect(classifyTargetFailure(error)).toBe("candidate");
    expect(isRepairSessionRestartRequired(error)).toBe(true);
  });

  test("modeling context-token restart reuses coverage's fresh-session protocol instead of a harness kill", () => {
    const error = "repair_session_restart_required: observed modeling context is full; continue from the durable selector checkpoint in a fresh provider session";
    expect(classifyTargetFailure(error)).toBe("candidate");
    expect(isRepairSessionRestartRequired(error)).toBe(true);
    expect(canRetryTargetFailure(error, {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 1,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 1,
    })).toBe(true);
    expect(canTransitionToFreshSessionRestart({
      mode: "modeling",
      fresh_session_required: true,
      session_epoch: 0,
      repair_session_restarts: 0,
    }, error, 3)).toBe(true);
    expect(canTransitionToFreshSessionRestart({
      mode: "repair",
      fresh_session_required: true,
      session_epoch: 1,
      repair_session_restarts: 1,
    }, error, 3)).toBe(true);
    expect(canTransitionToFreshSessionRestart({
      mode: "modeling",
      fresh_session_required: false,
      session_epoch: 0,
      repair_session_restarts: 0,
    }, error, 3)).toBe(false);
    expect(canTransitionToFreshSessionRestart({
      mode: "modeling",
      fresh_session_required: true,
      session_epoch: 3,
      repair_session_restarts: 3,
    }, error, 3)).toBe(false);
  });

  test("mechanical fresh sessions do not consume the repair restart budget", () => {
    // Round-10 dimensions regression: two interrupted-session recoveries had
    // advanced session_epoch to 2, so a legitimate first context-rollover
    // restart was rejected as "exhausted". session_epoch is a serial number;
    // only repair-motivated restarts are bounded.
    const error = "repair_session_restart_required: observed modeling context is full; continue from the durable selector checkpoint in a fresh provider session";
    expect(canTransitionToFreshSessionRestart({
      mode: "modeling",
      fresh_session_required: true,
      session_epoch: 2,
      repair_session_restarts: 0,
    }, error, 1)).toBe(true);
    expect(canTransitionToFreshSessionRestart({
      mode: "modeling",
      fresh_session_required: true,
      session_epoch: 3,
      repair_session_restarts: 1,
    }, error, 1)).toBe(false);
  });

  test("allows repair-session lifecycle transitions independently of candidate failures", () => {
    expect(canRestartRepairSession(0, 3)).toBe(true);
    expect(canRestartRepairSession(2, 3)).toBe(true);
    expect(canRestartRepairSession(3, 3)).toBe(false);
  });

  test.each([
    "HTTP 429 rate limit",
    "ECONNRESET while reading model stream",
    "ETIMEDOUT",
  ])("keeps real provider failures in the transport budget: %s", (error) => {
    expect(classifyTargetFailure(error)).toBe("transport");
  });

  test("treats a status-bearing transient auth-pool failure as transport without weakening bare auth failures", () => {
    expect(classifyTargetFailure(
      '503: {"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-terra)"}',
    )).toBe("transport");
    expect(classifyTargetFailure("auth_unavailable: no auth available")).toBe("provider_configuration");
    expect(classifyTargetFailure("HTTP 503 invalid api key")).toBe("provider_configuration");
    expect(classifyTargetFailure("HTTP 500 invalid tool schema")).toBe("provider_configuration");
  });

  test("keeps coverage findings out of candidate and transport budgets", () => {
    expect(classifyTargetFailure("domain_coverage_repair_required: missing referenced rows"))
      .toBe("coverage_repair");
    expect(classifyTargetFailure("coverage_repair_contract_nonconvergence: two_state_oscillation"))
      .toBe("coverage_harness_defect");
    expect(classifyTargetFailure("coverage_reviewer_incomplete_worklist: repeated reviewer miss"))
      .toBe("coverage_harness_defect");
    expect(classifyTargetFailure(JSON.stringify({
      ok: false,
      error: "domain_coverage_repair_required",
      findings: [{ finding_id: "missing-branch" }],
    }))).toBe("coverage_repair");
    expect(classifyTargetFailure("coverage_harness_defect: duplicate materialized display"))
      .toBe("coverage_harness_defect");
    expect(classifyTargetFailure("coverage_fresh_phase_without_durable_progress: 2 consecutive phases"))
      .toBe("coverage_harness_defect");
    expect(classifyTargetFailure("coverage_fresh_phase_limit: 32 bounded phases exhausted"))
      .toBe("coverage_harness_defect");
    expect(classifyTargetFailure("target_blocked_with_evidence"))
      .toBe("coverage_harness_defect");
    expect(canRetryTargetFailure("target_blocked_with_evidence", {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 3,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 3,
    })).toBe(false);
  });

  test("repairs counters written by the old stream-error classifier", () => {
    expect(resetLegacyMisclassifiedTransportCounters(
      "external_dependency_must_precede_selector_submission",
      {
        transport_attempts: 0,
        candidate_validation_attempts: 3,
        coverage_repair_attempts: 1,
      },
    )).toEqual({
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 1,
    });
    expect(resetLegacyMisclassifiedTransportCounters("finish_reason=length", {
      transport_attempts: 4,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 0,
    })).toEqual({
      transport_attempts: 0,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 0,
    });
    expect(resetLegacyMisclassifiedTransportCounters("terminated", {
      transport_attempts: 0,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 0,
    })).toEqual({
      transport_attempts: 0,
      candidate_validation_attempts: 2,
      coverage_repair_attempts: 0,
    });
    expect(resetLegacyMisclassifiedTransportCounters("HTTP 503", {
      transport_attempts: 0,
      candidate_validation_attempts: 2,
      coverage_repair_attempts: 1,
    })).toEqual({
      transport_attempts: 0,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 1,
    });
    expect(resetLegacyMisclassifiedTransportCounters("terminated", {
      transport_attempts: 1,
      candidate_validation_attempts: 2,
      coverage_repair_attempts: 0,
    })).toEqual({
      transport_attempts: 1,
      candidate_validation_attempts: 2,
      coverage_repair_attempts: 0,
    });
  });

  test("gates retries only on the budget for the current failure class", () => {
    const counters = {
      transport_attempts: 4,
      candidate_validation_attempts: 4,
      coverage_repair_attempts: 1,
    };
    const limits = {
      transport_retries: 3,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 3,
    };
    expect(canRetryTargetFailure(
      "domain_coverage_repair_required: missing referenced rows",
      counters,
      limits,
    )).toBe(true);
    expect(canRetryTargetFailure("validation rejected", counters, limits)).toBe(false);
    expect(canRetryTargetFailure("HTTP 503", counters, limits)).toBe(false);
    expect(canRetryTargetFailure("coverage_harness_defect: deterministic output defect", counters, limits)).toBe(false);
  });

  test("counts only consecutive transport failures since the latest durable checkpoint", () => {
    const first = recordTransportFailure(undefined, "checkpoint-a");
    const secondWithoutProgress = recordTransportFailure(first, "checkpoint-a");
    const firstAfterProgress = recordTransportFailure(secondWithoutProgress, "checkpoint-b");
    expect(first).toEqual({ checkpoint: "checkpoint-a", consecutive_failures: 1 });
    expect(secondWithoutProgress).toEqual({ checkpoint: "checkpoint-a", consecutive_failures: 2 });
    expect(firstAfterProgress).toEqual({ checkpoint: "checkpoint-b", consecutive_failures: 1 });

    const counters = {
      transport_attempts: 99,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 1,
    };
    const limits = {
      transport_retries: 1,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 1,
    };
    expect(canRetryTargetFailure("ETIMEDOUT", counters, limits, firstAfterProgress)).toBe(true);
    expect(canRetryTargetFailure("ETIMEDOUT", counters, limits, secondWithoutProgress)).toBe(false);
    expect(canRetryTargetFailure("HTTP 401 invalid api key", counters, limits, firstAfterProgress)).toBe(false);
    expect(canRetryTargetFailure("coverage_harness_defect", counters, limits, firstAfterProgress)).toBe(false);
    expect(canRetryTargetFailure("semantic validation rejected", counters, limits, firstAfterProgress)).toBe(false);
  });

  test("stops retrying once the target's coverage repair budget is spent", () => {
    // 新修订继承同一份协议状态，重试必然重演同一步。实测 GB/T 50312 两个目标
    // 各空转 11 个修订，每轮只有 read_target_selectors / read_coverage_review /
    // commit 三步，12/12 校验预算全烧在这上面，模型一个有效动作都没做。
    const counters = {
      transport_attempts: 0,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 1,
    };
    const limits = {
      transport_retries: 1,
      candidate_validation_attempts: 12,
      coverage_repair_attempts: 3,
    };
    expect(isUnrecoverableProtocolBudgetFailure("selector_coverage_repair_not_available")).toBe(true);
    expect(canRetryTargetFailure("selector_coverage_repair_not_available", counters, limits)).toBe(false);
    // 预算还剩得多的普通候选失败照旧可以重试，别把这条闸门开得太宽。
    expect(canRetryTargetFailure("semantic validation rejected", counters, limits)).toBe(true);
  });

  test("classifies known protocol codes from the contract table, not surrounding prose", () => {
    expect(protocolTargetFailure("selector_coverage_repair_not_available")).toEqual({
      failure_class: "coverage_harness_defect",
      retryable: false,
    });
    expect(classifyTargetFailure(
      "commit_target_selector_draft failed: selector_coverage_repair_not_available",
    )).toBe("coverage_harness_defect");
    expect(classifyTargetFailure("selector_correction_not_available")).toBe("coverage_harness_defect");
    expect(classifyTargetFailure("target_progress_stalled: marks_unchanged")).toBe("coverage_harness_defect");
    expect(canRetryTargetFailure("target_progress_stalled: marks_unchanged", {
      transport_attempts: 0,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 1,
      candidate_validation_attempts: 12,
      coverage_repair_attempts: 3,
    })).toBe(false);
    expect(canRetryTargetFailure("selector_correction_not_available", {
      transport_attempts: 0,
      candidate_validation_attempts: 1,
      coverage_repair_attempts: 0,
    }, {
      transport_retries: 1,
      candidate_validation_attempts: 12,
      coverage_repair_attempts: 3,
    })).toBe(false);
  });

  test("prefers a stamped failure class over unstructured error text", () => {
    const counters = {
      transport_attempts: 0,
      candidate_validation_attempts: 0,
      coverage_repair_attempts: 0,
    };
    const limits = {
      transport_retries: 1,
      candidate_validation_attempts: 3,
      coverage_repair_attempts: 1,
    };
    expect(classifyTargetFailure("HTTP 503", "coverage_harness_defect")).toBe("coverage_harness_defect");
    expect(canRetryTargetFailure("HTTP 503", counters, limits, undefined, "coverage_harness_defect"))
      .toBe(false);
    expect(canRetryTargetFailure("HTTP 503", counters, limits)).toBe(true);
  });

  test.each([
    "incomplete_repair_without_durable_progress: 3 completed rounds left an unchanged draft",
    "incomplete_repair_durable_progress_cycle: a completed round repeated the same draft",
  ])("does not restart a completed-round stagnation even with spare budget: %s", (error) => {
    const counters = { transport_attempts: 2, candidate_validation_attempts: 1, coverage_repair_attempts: 0 };
    const limits = { transport_retries: 3, candidate_validation_attempts: 12, coverage_repair_attempts: 1 };
    const previous = { ...counters };
    for (const wrapped of [error, JSON.stringify({ error })]) {
      expect(protocolTargetFailure(wrapped)).toEqual({ failure_class: "coverage_harness_defect", retryable: false });
      expect(classifyTargetFailure(wrapped)).toBe("coverage_harness_defect");
      expect(canRetryTargetFailure(wrapped, counters, limits)).toBe(false);
      expect(canRetryTargetFailure(wrapped, counters, limits, undefined, "candidate")).toBe(false);
    }
    expect(counters).toEqual(previous);
    expect(limits.candidate_validation_attempts).toBe(12);
  });
});
