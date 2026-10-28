import type { TargetFailureClass } from "./contracts.js";

export type { TargetFailureClass } from "./contracts.js";

// SDK request retries are short (seconds); allow bounded checkpoint recovery
// after longer provider outages without spending any semantic repair budget.
export const DEFAULT_TARGET_TRANSPORT_RETRIES = 3;

export function targetTransportRetryDelayMs(
  error: string,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const baseMs = /\b429\b|rate[_ ]limit|用量上限|速率限制/i.test(error) ? 20_000 : 15_000;
  const backoffMs = baseMs * 2 ** Math.max(0, consecutiveFailures - 1);
  // Positive jitter avoids synchronized retries across target workers.
  return Math.min(60_000, Math.round(backoffMs * (1 + random() * 0.2)));
}

export interface TargetAttemptCounters {
  transport_attempts: number;
  candidate_validation_attempts: number;
  coverage_repair_attempts: number;
}

export interface TargetAttemptLimits {
  transport_retries: number;
  candidate_validation_attempts: number;
  coverage_repair_attempts: number;
}

export interface TransportRetryWindow {
  checkpoint: string;
  error_key?: string;
  consecutive_failures: number;
}

export function initialTargetAttemptCounters(): TargetAttemptCounters {
  return {
    transport_attempts: 0,
    candidate_validation_attempts: 0,
    coverage_repair_attempts: 0,
  };
}

export function targetFailureClass(value: unknown): TargetFailureClass | undefined {
  switch (value) {
    case "transport":
    case "provider_configuration":
    case "candidate":
    case "scope_extension":
    case "coverage_repair":
    case "coverage_harness_defect":
      return value;
    default:
      return undefined;
  }
}

export function targetBlockerFailureClass(blockerCode: unknown): TargetFailureClass | undefined {
  switch (blockerCode) {
    case "scope_extension_required":
      return "scope_extension";
    case "missing_external_source":
    case "harness_contract_defect":
    case "frozen_scope_conflict":
      return "coverage_harness_defect";
    case "ambiguous_source":
      return "candidate";
    default:
      return undefined;
  }
}

/** A new session alone never grants another repair; it must match the persisted review chain. */
export function isContinuingCoverageRepair(
  recheck: { schema_version: string; plan_fingerprint: string; source_plan_fingerprint?: string } | undefined,
  reviewPlanFingerprint: string,
): boolean {
  return Boolean(reviewPlanFingerprint)
    && recheck?.schema_version === "coverage-recheck-scope/v1"
    && (recheck.plan_fingerprint === reviewPlanFingerprint
      || recheck.source_plan_fingerprint === reviewPlanFingerprint);
}

export interface TargetFailurePolicy {
  failure_class: TargetFailureClass;
  retryable: boolean;
}

/**
 * Internal protocol failures stamp their class here.
 * Adding a new code is a new row, not another sentence regex.
 * Unstructured provider/network text still falls through to heuristics.
 */
export const PROTOCOL_TARGET_FAILURES: Record<string, TargetFailurePolicy> = {
  scope_extension_required: { failure_class: "scope_extension", retryable: false },
  coverage_harness_defect: { failure_class: "coverage_harness_defect", retryable: false },
  coverage_repair_contract_nonconvergence: { failure_class: "coverage_harness_defect", retryable: false },
  coverage_reviewer_incomplete_worklist: { failure_class: "coverage_harness_defect", retryable: false },
  compiler_invariant_violation: { failure_class: "coverage_harness_defect", retryable: false },
  target_blocked_with_evidence: { failure_class: "coverage_harness_defect", retryable: false },
  coverage_fresh_phase_without_durable_progress: { failure_class: "coverage_harness_defect", retryable: false },
  coverage_fresh_phase_limit: { failure_class: "coverage_harness_defect", retryable: false },
  target_modeling_phase_budget_exceeded: { failure_class: "coverage_harness_defect", retryable: false },
  scope_extension_requires_checkpoint_recovery: { failure_class: "coverage_harness_defect", retryable: false },
  target_scope_revision_required: { failure_class: "coverage_harness_defect", retryable: false },
  target_scope_conflict_requires_review: { failure_class: "coverage_harness_defect", retryable: false },
  target_selector_resume_checkpoint_missing: { failure_class: "coverage_harness_defect", retryable: false },
  target_selector_resume_evidence_mismatch: { failure_class: "coverage_harness_defect", retryable: false },
  selector_stage_incomplete_retry: { failure_class: "coverage_harness_defect", retryable: false },
  selector_coverage_repair_not_available: { failure_class: "coverage_harness_defect", retryable: false },
  selector_correction_not_available: { failure_class: "coverage_harness_defect", retryable: false },
  target_progress_stalled: { failure_class: "coverage_harness_defect", retryable: false },
  domain_coverage_repair_required: { failure_class: "coverage_repair", retryable: true },
  repair_session_restart_required: { failure_class: "candidate", retryable: true },
  length_without_durable_progress: { failure_class: "candidate", retryable: true },
  length_durable_progress_cycle: { failure_class: "candidate", retryable: true },
  target_modeling_provider_context_exceeded: { failure_class: "provider_configuration", retryable: false },
};

const PROTOCOL_FAILURE_PHRASES: ReadonlyArray<[string, TargetFailurePolicy]> = [
  [
    "Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor",
    { failure_class: "coverage_harness_defect", retryable: false },
  ],
];

const PROTOCOL_FAILURE_CODE_PATTERNS = Object.keys(PROTOCOL_TARGET_FAILURES)
  .sort((left, right) => right.length - left.length)
  .map((code) => ({ code, pattern: new RegExp(`\\b${code}\\b`) }));

function protocolCodeToken(value: string): string {
  const colon = value.indexOf(":");
  return (colon === -1 ? value : value.slice(0, colon)).trim();
}

export function protocolTargetFailure(error: string): TargetFailurePolicy | undefined {
  const trimmed = error.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed.error === "string") {
        const nested = protocolTargetFailure(parsed.error);
        if (nested) return nested;
      }
    } catch {
      // Unstructured text that happens to start with '{'.
    }
  }
  const head = protocolCodeToken(trimmed);
  if (head && PROTOCOL_TARGET_FAILURES[head]) return PROTOCOL_TARGET_FAILURES[head];
  for (const { code, pattern } of PROTOCOL_FAILURE_CODE_PATTERNS) {
    if (pattern.test(error)) return PROTOCOL_TARGET_FAILURES[code];
  }
  for (const [phrase, policy] of PROTOCOL_FAILURE_PHRASES) {
    if (error.includes(phrase)) return policy;
  }
  return undefined;
}

export function isScopeExtensionRequired(error: string): boolean {
  return protocolTargetFailure(error)?.failure_class === "scope_extension"
    || /\bscope_extension_required\b/i.test(error);
}

function classifyUnstructuredTargetFailure(error: string): TargetFailureClass {
  if (/\bResponse incomplete:\s*max_messages\b/i.test(error)) return "transport";
  if (/\b40[0-3]\b|usage balance exhausted|run out of credits|invalid api key|invalid tool schema/i.test(error)) {
    return "provider_configuration";
  }
  if (/\b408\b|\b429\b|\b5\d{2}\b|EOF|ECONN|ETIMEDOUT|timeout|socket|terminated|stream disconnected|stream closed before (?:response\.)?completed|rate[_ ]limit|用量上限|速率限制/i.test(error)) {
    return "transport";
  }
  if (/auth_unavailable|no auth available/i.test(error)) return "provider_configuration";
  if (/finish_reason=length/i.test(error)) return "candidate";
  return /finish_reason/i.test(error) ? "transport" : "candidate";
}

export function classifyTargetFailure(
  error: string,
  stampedClass?: TargetFailureClass,
): TargetFailureClass {
  const stamped = targetFailureClass(stampedClass);
  if (stamped) return stamped;
  return protocolTargetFailure(error)?.failure_class ?? classifyUnstructuredTargetFailure(error);
}

export function resetLegacyMisclassifiedTransportCounters(
  error: string,
  counters: TargetAttemptCounters,
): TargetAttemptCounters {
  const normalized = {
    ...counters,
    coverage_repair_attempts: counters.coverage_repair_attempts ?? 0,
  };
  if (/\bexternal_dependency_must_precede_selector_submission\b/i.test(error)) {
    return {
      ...normalized,
      candidate_validation_attempts: 0,
    };
  }
  if (/finish_reason=length/i.test(error)) {
    return {
      ...normalized,
      transport_attempts: 0,
    };
  }
  if (
    classifyTargetFailure(error) === "transport"
    && normalized.transport_attempts === 0
    && normalized.candidate_validation_attempts > 0
  ) {
    return {
      ...normalized,
      candidate_validation_attempts: normalized.candidate_validation_attempts - 1,
      coverage_repair_attempts: normalized.coverage_repair_attempts,
    };
  }
  return normalized;
}

export function normalizeAttemptLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 20) {
    throw new Error(`${label} must be an integer between 1 and 20`);
  }
  return resolved;
}

export function targetAttemptLimits(options: {
  maxAttempts: number;
  transportRetries?: number;
  candidateValidationAttempts?: number;
  coverageRepairAttempts?: number;
}): TargetAttemptLimits {
  return {
    transport_retries: normalizeAttemptLimit(
      options.transportRetries,
      DEFAULT_TARGET_TRANSPORT_RETRIES,
      "transportRetries",
    ),
    candidate_validation_attempts: normalizeAttemptLimit(
      options.candidateValidationAttempts,
      Math.min(options.maxAttempts, 3),
      "candidateValidationAttempts",
    ),
    coverage_repair_attempts: normalizeAttemptLimit(
      options.coverageRepairAttempts,
      1,
      "coverageRepairAttempts",
    ),
  };
}

export function isUnrecoverableProtocolBudgetFailure(error: string): boolean {
  return protocolTargetFailure(error)?.retryable === false;
}

export function canRetryTargetFailure(
  error: string,
  counters: TargetAttemptCounters,
  limits: TargetAttemptLimits,
  transportWindow?: TransportRetryWindow,
  stampedClass?: TargetFailureClass,
): boolean {
  if (isUnrecoverableProtocolBudgetFailure(error)) return false;
  switch (classifyTargetFailure(error, stampedClass)) {
    case "transport":
      return (transportWindow?.consecutive_failures ?? counters.transport_attempts)
        <= limits.transport_retries;
    case "coverage_repair":
      return counters.coverage_repair_attempts < limits.coverage_repair_attempts;
    case "coverage_harness_defect":
    case "provider_configuration":
    case "scope_extension":
      return false;
    case "candidate":
      return counters.candidate_validation_attempts < limits.candidate_validation_attempts;
  }
}

// Status codes identify incidents; variable upstream messages/request IDs do not.
export function transportErrorKey(error: string): string | undefined {
  if (/context[_ ](?:length|window|too_large)/i.test(error) || classifyTargetFailure(error) !== "transport") return undefined;
  const status = error.match(/\b(408|429|5\d{2})\b/);
  if (status) return `http_${status[1]}`;
  if (/\bResponse incomplete:\s*max_messages\b/i.test(error)) return "max_messages";
  const code = error.match(/\b(E[A-Z]*(?:CONN|TIMEDOUT|PIPE|HOST|NET)[A-Z]*)\b/i);
  if (code) return code[1]!.toUpperCase();
  if (/stream disconnected|stream closed before (?:response\.)?completed/i.test(error)) return "stream_disconnected";
  if (/timeout|timed out/i.test(error)) return "timeout";
  if (/EOF/i.test(error)) return "eof";
  if (/socket|terminated/i.test(error)) return "connection_closed";
  if (/rate[_ ]limit|用量上限|速率限制/i.test(error)) return "rate_limit";
  return "transport";
}

export function recordTransportFailure(
  previous: TransportRetryWindow | undefined,
  currentCheckpoint: string,
  error?: string,
): TransportRetryWindow {
  const errorKey = error === undefined ? undefined : transportErrorKey(error);
  return {
    checkpoint: currentCheckpoint,
    ...(errorKey ? { error_key: errorKey } : {}),
    consecutive_failures: previous?.checkpoint === currentCheckpoint && previous.error_key === errorKey
      ? previous.consecutive_failures + 1
      : 1,
  };
}

export function isRepairSessionRestartRequired(error: string): boolean {
  return /\brepair_session_restart_required\b/i.test(error);
}

export function canRestartRepairSession(
  repairRestarts: number,
  maxRestarts: number,
): boolean {
  return Number.isInteger(repairRestarts)
    && repairRestarts >= 0
    && repairRestarts < maxRestarts;
}

export function canTransitionToFreshSessionRestart(
  repair: {
    mode: string;
    fresh_session_required: boolean;
    /** Bounded budget counter: only sessions started for repair restarts. */
    repair_session_restarts: number;
  },
  error: string,
  maxRestarts: number,
): boolean {
  return isRepairSessionRestartRequired(error)
    && repair.fresh_session_required
    && (repair.mode === "repair" || repair.mode === "modeling")
    && canRestartRepairSession(repair.repair_session_restarts, maxRestarts);
}
