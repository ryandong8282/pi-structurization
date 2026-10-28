import { setTimeout as delay } from "node:timers/promises";
import { pathExists, readJson } from "./atomic.js";
import { transportErrorKey as discoveryTransportErrorKey, targetTransportRetryDelayMs } from "./attempt-budget.js";
import { sha256Json } from "./canonical.js";
import type { DocumentDiscoveryWorkspace } from "./document-discovery.js";

export type DiscoveryTransportPhase = "candidate" | "review";
export const DISCOVERY_CONSECUTIVE_FAILURE_LIMIT = 3;

export { discoveryTransportErrorKey };

export async function discoveryTransportCheckpoint(workspace: DocumentDiscoveryWorkspace, phase: DiscoveryTransportPhase): Promise<string> {
  const state = await workspace.readState();
  const selectors = await readJson<unknown>(workspace.workingSelectorPath);
  const decisions = await pathExists(workspace.decisionsPath) ? await readJson<unknown>(workspace.decisionsPath) : [];
  return sha256Json({
    status: state.status,
    opened_atom_ids: [...(phase === "candidate" ? state.opened_atom_ids : state.reviewer_opened_atom_ids ?? [])].sort(),
    selectors,
    decisions,
  });
}

/** Network recovery does not consume semantic/context-handoff attempts. */
export async function runDiscoveryWithTransportRetry<T extends { error?: string }>(
  workspace: DocumentDiscoveryWorkspace,
  phase: DiscoveryTransportPhase,
  resume: boolean,
  run: (resume: boolean) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let previous: { error_key: string; checkpoint: string; consecutive_failures: number } | undefined;
  for (;;) {
    signal?.throwIfAborted();
    let result: T | undefined;
    let error: string;
    try {
      result = await run(resume);
      if (!result.error) return result;
      error = result.error;
    } catch (cause) {
      signal?.throwIfAborted();
      error = cause instanceof Error ? cause.message : String(cause);
      if (!discoveryTransportErrorKey(error)) throw cause;
    }
    signal?.throwIfAborted();
    const errorKey = discoveryTransportErrorKey(error);
    if (!errorKey) return result!;
    const checkpoint = await discoveryTransportCheckpoint(workspace, phase);
    const consecutive = previous?.error_key === errorKey && previous.checkpoint === checkpoint
      ? previous.consecutive_failures + 1 : 1;
    const progress = previous !== undefined && previous.checkpoint !== checkpoint;
    previous = { error_key: errorKey, checkpoint, consecutive_failures: consecutive };
    const exhausted = consecutive >= DISCOVERY_CONSECUTIVE_FAILURE_LIMIT;
    const delayMs = exhausted ? 0 : targetTransportRetryDelayMs(error, consecutive);
    await workspace.appendEvent(exhausted ? "discovery_transport_retry_exhausted" : "discovery_transport_retry_scheduled", {
      phase, ...previous, durable_progress: progress, consecutive_failure_limit: DISCOVERY_CONSECUTIVE_FAILURE_LIMIT,
      delay_ms: delayMs, error, durable_workfile_preserved: true,
      required_action: exhausted ? "check_provider_then_resume_same_job" : "resume_same_session_from_saved_work",
    });
    if (exhausted) {
      throw new Error(`discovery_transport_retry_exhausted: ${phase} 阶段同类网络错误 ${errorKey} 连续 ${consecutive} 次且无新增已保存进展；草稿和已读原文已保留。检查本地反代/上游恢复后续跑同一任务，无需新建或重做 OCR。最后错误：${error}`);
    }
    await delay(delayMs, undefined, { signal });
    resume = true;
  }
}
