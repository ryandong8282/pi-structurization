import type { ActionableIssueDetails, ActionableToolReject, ValidationIssue } from "./contracts.js";

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty string`);
  return trimmed;
}

/**
 * Model-facing tool failure. TypeScript rejects `{ ok: false, error }` without
 * `instruction`. Extra keys stay on the payload.
 */
export function toolReject<T extends { error: string; instruction: string }>(
  spec: T,
): T & { ok: false } {
  requireNonEmpty(spec.error, "error");
  requireNonEmpty(spec.instruction, "instruction");
  return { ...spec, ok: false };
}

/** Unexpected throw at a tool dispatch boundary. Keep the original message. */
export function catchToolReject(
  error: unknown,
  errorCode: string,
  extras: Record<string, unknown> = {},
): ActionableToolReject {
  const actual_error = error instanceof Error ? error.message : String(error);
  return toolReject({
    error: errorCode,
    instruction: "工具抛出实际异常，详见 actual_error。回条明确给出作者可写路径和修法时才修对应请求；若是不可写程序或来源故障，保留检查点交维护，不盲改 selector 或重试相同参数。",
    actual_error,
    required_action: "inspect_actual_error_and_owner_before_recovery",
    ...extras,
  });
}

/** Seal/submit fingerprint check already has both values — send both. */
export function fingerprintMismatchReject(spec: {
  error: string;
  submitted: string;
  expected: string;
  validate_tool: string;
  /** Only after current artifacts match the persisted successful checkpoint. */
  verified_retry?: { tool: string; arguments: { fingerprint: string } };
}): ActionableToolReject {
  const submitted = spec.submitted.trim() || "(empty)";
  const expected = spec.expected.trim() || "(none)";
  const retry = spec.expected && spec.verified_retry?.arguments.fingerprint === spec.expected
    ? spec.verified_retry : undefined;
  return toolReject({
    error: spec.error,
    instruction: `请求指纹 ${submitted} 与当前预期 ${expected} 不一致；本次未提交成功。${retry
      ? "当前持久验证与实际工件仍匹配，只复制 next_tool_arguments 重试；无需再次运行验证工具。"
      : `当前检查点未被证实有效，通过 ${spec.validate_tool} 取得当前有效验证回执，再原样提交其 fingerprint。`}不混用草稿、计划或诊断指纹，不改业务内容匹配旧值。`,
    actual_fingerprint: spec.submitted,
    expected_fingerprint: spec.expected,
    actual: { fingerprint: spec.submitted }, expected: { fingerprint: spec.expected || null },
    writable_paths: ["/fingerprint"], current_checkpoint_verified: Boolean(retry),
    validation_required: !retry,
    next_tool: retry?.tool ?? spec.validate_tool,
    next_tool_arguments: retry?.arguments ?? {},
    ...(!retry ? { candidate_read_tool: spec.validate_tool } : {}),
    required_action: retry ? "resubmit_latest_validation_fingerprint" : "obtain_current_validation_receipt",
    do_not_edit: "原文、作者业务内容、派生结果及历史计数；本回条只修请求参数。",
  });
}

/**
 * Model-facing validation issue. TypeScript rejects a details bag that omits
 * `required_action`. Extra diagnostic keys are allowed on `details`.
 */
export function ensureActionableIssue(issue: {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}): ValidationIssue {
  const details = issue.details;
  if (
    details
    && typeof details === "object"
    && !Array.isArray(details)
    && typeof (details as { required_action?: unknown }).required_action === "string"
    && (details as { required_action: string }).required_action.trim()
  ) {
    return { code: issue.code, path: issue.path, message: issue.message, details: details as ActionableIssueDetails };
  }
  return {
    code: issue.code,
    path: issue.path,
    message: issue.message,
    details: {
      // A details object is a diagnostic envelope, not the submitted value.
      // Keep paths, expected values and repair tools visible to downstream
      // adapters even when the producer omitted required_action.
      ...(details && typeof details === "object" && !Array.isArray(details)
        ? details as Record<string, unknown>
        : details === undefined ? {} : { actual: details }),
      required_action: issue.message,
    },
  };
}

/**
 * Model-facing validation issue. TypeScript rejects a details bag that omits
 * `required_action`. Extra diagnostic keys are allowed on `details`.
 */
export function actionableIssue(issue: {
  code: string;
  path: string;
  message: string;
  details: ActionableIssueDetails;
}): ValidationIssue {
  requireNonEmpty(issue.code, "code");
  requireNonEmpty(issue.path, "path");
  requireNonEmpty(issue.message, "message");
  requireNonEmpty(issue.details.required_action, "details.required_action");
  return issue;
}
