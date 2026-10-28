import type { DomainCoverageReview } from "./coverage-review.js";

export interface CoverageBlockerOwnerDecision {
  allowed: boolean;
  error?:
    | "coverage_blocker_finding_unknown"
    | "coverage_blocker_requires_semantic_repair"
    | "coverage_blocker_mixed_findings_require_explicit_ids"
    | "coverage_blocker_finding_owner_mismatch";
  selected_harness_finding_ids: string[];
  harness_finding_ids: string[];
  semantic_finding_ids: string[];
  nonblocking_finding_ids: string[];
  unknown_finding_ids: string[];
}

/**
 * Routes a coverage blocker exclusively from the durable, normalized review.
 * The caller must not use the model's blocker kind as ownership evidence.
 */
export function coverageBlockerOwnerDecision(
  review: Pick<DomainCoverageReview, "findings">,
  requestedFindingIds: readonly string[] = [],
): CoverageBlockerOwnerDecision {
  const findingsById = new Map(review.findings.map((finding) => [finding.finding_id, finding]));
  const harnessFindingIds = review.findings
    .filter((finding) => finding.finding_type === "compiler_materialization_defect")
    .map((finding) => finding.finding_id)
    .sort();
  const semanticFindingIds = review.findings
    .filter((finding) => finding.finding_type === "semantic_coverage_gap")
    .map((finding) => finding.finding_id)
    .sort();
  const nonblockingFindingIds = review.findings
    .filter((finding) => finding.finding_type === "soft_classification_disagreement"
      || finding.finding_type === "source_glyph_review")
    .map((finding) => finding.finding_id)
    .sort();
  const requested = [...new Set(requestedFindingIds)].sort();
  const unknownFindingIds = requested.filter((findingId) => !findingsById.has(findingId));
  const selectedHarnessFindingIds = requested.length
    ? requested.filter((findingId) => harnessFindingIds.includes(findingId))
    : harnessFindingIds;

  const base = {
    selected_harness_finding_ids: selectedHarnessFindingIds,
    harness_finding_ids: harnessFindingIds,
    semantic_finding_ids: semanticFindingIds,
    nonblocking_finding_ids: nonblockingFindingIds,
    unknown_finding_ids: unknownFindingIds,
  };
  if (unknownFindingIds.length > 0) {
    return { allowed: false, error: "coverage_blocker_finding_unknown", ...base };
  }
  if (harnessFindingIds.length === 0) {
    return { allowed: false, error: "coverage_blocker_requires_semantic_repair", ...base };
  }
  if (semanticFindingIds.length > 0 && requested.length === 0) {
    return {
      allowed: false,
      error: "coverage_blocker_mixed_findings_require_explicit_ids",
      ...base,
    };
  }
  if (requested.some((findingId) => !harnessFindingIds.includes(findingId))) {
    return { allowed: false, error: "coverage_blocker_finding_owner_mismatch", ...base };
  }
  return { allowed: true, ...base };
}
