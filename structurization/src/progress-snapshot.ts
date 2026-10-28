import { sha256Json } from "./canonical.js";

export interface TargetProgressSnapshot {
  /** Homework identity for diagnostics. Changing this alone is not progress. */
  draft: string;
  /** Red-pen list. This is the progress signal. */
  marks: string;
  /** Next instruction / error code. */
  next_action: string;
}

export interface ProgressWindow {
  last?: TargetProgressSnapshot;
  consecutive_unchanged: number;
}

export function marksFingerprint(ids: readonly string[]): string {
  return sha256Json([...ids].sort());
}

export function coverageRepairProgressSnapshot(observation: {
  structure_fingerprint: string;
  judgment_ids: readonly string[];
  finding_ids: readonly string[];
}): TargetProgressSnapshot {
  const marksSource = observation.judgment_ids.length > 0
    ? observation.judgment_ids
    : observation.finding_ids;
  return {
    draft: observation.structure_fingerprint,
    marks: marksFingerprint(marksSource),
    next_action: "coverage_repair",
  };
}

export function recordProgressRound(
  previous: ProgressWindow | undefined,
  snapshot: TargetProgressSnapshot,
  unchangedLimit = 2,
): {
  window: ProgressWindow;
  stop: boolean;
  reason: "first_round" | "marks_changed" | "identical_snapshot" | "marks_unchanged";
} {
  const last = previous?.last;
  if (!last) {
    return {
      window: { last: snapshot, consecutive_unchanged: 1 },
      stop: false,
      reason: "first_round",
    };
  }
  if (last.marks !== snapshot.marks) {
    return {
      window: { last: snapshot, consecutive_unchanged: 1 },
      stop: false,
      reason: "marks_changed",
    };
  }
  const consecutive = (previous?.consecutive_unchanged ?? 1) + 1;
  const identical = last.draft === snapshot.draft
    && last.next_action === snapshot.next_action;
  return {
    window: { last: snapshot, consecutive_unchanged: consecutive },
    stop: consecutive >= unchangedLimit,
    reason: identical ? "identical_snapshot" : "marks_unchanged",
  };
}
