import { replaceAcceptanceToolText } from "./acceptance-tool-text.js";
import { LEGACY_COVERAGE_REVIEW_PROTOCOL, COVERAGE_FINALIZATION_PROTOCOL, PROMPT_SUITE_VERSION } from "./acceptance-prompt-suite.js";
import { chmod, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { catchToolReject, toolReject } from "./actionable-error.js";
import {
  appendText,
  atomicWriteJson,
  atomicWriteNewText,
  atomicWriteText,
  makeReadOnly,
  pathExists,
  readJson,
} from "./atomic.js";
import { prettyJson, sha256Json, sha256Text } from "./canonical.js";
import type {
  EvidenceManifest,
  EvidenceRecord,
  MaterializedAcceptanceItem,
  ReferenceTargetField,
  RevisionState,
  SemanticSourcePlan,
} from "./contracts.js";
import {
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceOriginEvidenceIds,
} from "./contracts.js";
import { materialize } from "./materializer.js";
import { buildDocumentEvidence } from "./document-discovery.js";
import {
  createEvidenceSourceRangeResolver,
  partitionDocumentSourceRanges,
  referenceOccurrenceTargetsDocument,
  sourceRangesOverlap,
} from "./source-provenance-ranges.js";
import { documentSearchMatch } from "./governing-context.js";
import { deliveryInvestigationHints, SOURCE_CONTEXT_INVESTIGATION } from "./acceptance-delivery-contract.js";
import { registerExternalStandardReference } from "./external-standard-reference.js";
import {
  documentReferenceTargetReadIdentity,
  resolveAndRegisterDocumentReference,
  type DocumentReferenceKind,
} from "./document-reference.js";
import { strictJsonParse } from "./strict-json.js";
import { applyJsonPatchOperation, type JsonPatchOperation } from "./json-patch.js";
import { canonicalizeSourceGlyphsForComparison } from "./text-normalization.js";
import { normalizePlanAuthorizedCompilerFindings } from "./coverage-finding-ownership.js";
import { validateSemanticPlanViews } from "./validator.js";
import {
  REFERENCE_ACTION_GUIDANCE_ZH,
} from "./reference-guidance.js";
import {
  assignReferenceAnalysisPolicy,
  projectReferenceAnalysisPolicies,
  readInlineReferenceEvidencePage,
  readAnalyzedReferenceCatalog,
  inlineReferenceReadIssues,
  referenceAnalysisIssues,
  type ReferenceAnalysisPolicy,
} from "./reference-analysis.js";
import type { CatalogRuleAsk } from "./reference-catalog-discovery.js";
import {
  initialSourceSpanRegistry,
  locateAndRegisterSourceQuote,
  resolveSourceSpan,
  SourceSpanRegistryError,
  type ImmutableTextSource,
  type SourceSpanIssue,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import type { RevisionWorkspace } from "./workspace.js";

export const COVERAGE_REVIEW_SCHEMA_VERSION = "domain-coverage-review/v4" as const;

const COVERAGE_EVIDENCE_ACCESS_GUIDANCE_ZH = "证据资源 evidence_id 按每条回条的 access_mode 分流：direct 和 inline_reference 使用 open_review_evidence，已知多个 ID 时使用 batch_open_review_evidence；isolated_reference 禁止用打开或定位工具读取，必须原样复制回条中的 target_key 调用 read_reference_facts，并使用其返回的 evidence_id、span_id。资源打开不替代引用目标的组件分页义务；当公开回条明确要求 read_document_reference_evidence 时，仍须按该 target_key 读到 done=true。";

type CoverageEvidenceAccessMetadata =
  | {
      access_mode: "direct" | "inline_reference";
      read_tool: "open_review_evidence";
      open_review_evidence_allowed: true;
      target_key?: string;
    }
  | {
      access_mode: "isolated_reference";
      read_tool: "read_reference_facts";
      open_review_evidence_allowed: false;
      target_key: string;
    };

export type CoverageFindingType =
  | "semantic_coverage_gap"
  | "compiler_materialization_defect"
  | "soft_classification_disagreement"
  | "source_glyph_review";

export type CoverageFindingOrigin =
  | "initial_review"
  | "unresolved_prior"
  | "reviewer_missed_preexisting"
  | "repair_introduced";

export interface CoverageEvidenceBinding {
  evidence_id: string;
  exact_fragment: string;
  /** Pointer provenance: registered span this fragment was materialized from. */
  span_id?: string;
}

export const COVERAGE_DEFECT_FIELDS = ["name", "category", "requirement", "method", "quantity", "sampling", "note", "reference", "provenance", "coverage", "structure"] as const;
export interface CoverageReviewFinding {
  finding_id: string;
  finding_type: CoverageFindingType;
  evidence_id: string;
  exact_fragment: string;
  /** Pointer provenance: registered span this fragment was materialized from. */
  span_id?: string;
  affected_item_ids: string[];
  description: string;
  reason: string;
  /** What is defective, not merely which leaf contains it. Optional for saved reviews. */
  defect_field?: typeof COVERAGE_DEFECT_FIELDS[number];
  /** Deterministic identity of the cited source judgment across repair rounds. */
  judgment_id?: string;
  /** Deterministic lineage classification relative to the prior reviewed candidate. */
  finding_origin?: CoverageFindingOrigin;
  first_seen_plan_fingerprint?: string;
  prior_finding_id?: string;
}

export interface SemanticCoverageDisposition {
  coverage_id: string;
  disposition: "acceptance_item" | "shared_context" | "irrelevant";
  judgment_id: string;
  item_ids: string[];
  evidence_bindings: CoverageEvidenceBinding[];
  reason: string;
}

export interface DomainCoverageReview {
  schema_version: typeof COVERAGE_REVIEW_SCHEMA_VERSION;
  plan_fingerprint: string;
  evidence_fingerprint: string;
  status: "approved" | "repair" | "harness_defect";
  semantic_coverage: SemanticCoverageDisposition[];
  findings: CoverageReviewFinding[];
  summary: string;
}

function normalizedFindingFragment(value: string): string {
  return canonicalizeSourceGlyphsForComparison(value).replace(/\s+/gu, " ").trim();
}

export function coverageFindingJudgmentIdentity(
  finding: Pick<CoverageReviewFinding, "evidence_id" | "exact_fragment"> & Partial<Pick<CoverageReviewFinding, "defect_field" | "affected_item_ids">>,
  _plan?: SemanticSourcePlan,
): string {
  return `judgment:${sha256Json({
    evidence_id: finding.evidence_id,
    exact_fragment: normalizedFindingFragment(finding.exact_fragment),
    defect_field: finding.defect_field ?? "unspecified",
    affected_item_ids: [...new Set(finding.affected_item_ids ?? [])].sort(),
  })}`;
}

export interface CoverageRepairObservation {
  plan_fingerprint: string;
  structure_fingerprint: string;
  judgment_ids: string[];
  unresolved_judgment_ids: string[];
  finding_ids: string[];
}

export function detectCoverageRepairContractNonConvergence(
  observations: readonly CoverageRepairObservation[],
): { kind: "same_structure" | "two_state_oscillation"; judgment_ids: string[] } | undefined {
  const commonJudgments = (...entries: CoverageRepairObservation[]): string[] => {
    const [first, ...rest] = entries;
    return first
      ? first.judgment_ids.filter((judgmentId) => rest.every((entry) => entry.judgment_ids.includes(judgmentId)))
      : [];
  };
  const current = observations.at(-1);
  const previous = observations.at(-2);
  if (!current || !previous) return undefined;
  const repeated = commonJudgments(previous, current);
  const unresolvedRepeated = repeated.filter((judgmentId) =>
    current.unresolved_judgment_ids.includes(judgmentId)
  );
  if (unresolvedRepeated.length > 0 && previous.structure_fingerprint === current.structure_fingerprint) {
    return { kind: "same_structure", judgment_ids: unresolvedRepeated.sort() };
  }
  const beforePrevious = observations.at(-3);
  if (!beforePrevious) return undefined;
  const oscillating = commonJudgments(beforePrevious, previous, current);
  if (oscillating.length > 0
    && beforePrevious.structure_fingerprint === current.structure_fingerprint
    && current.structure_fingerprint !== previous.structure_fingerprint) {
    return { kind: "two_state_oscillation", judgment_ids: oscillating.sort() };
  }
  return undefined;
}

function semanticPlanContainsFindingFragment(
  plan: SemanticSourcePlan | undefined,
  finding: Pick<CoverageReviewFinding, "evidence_id" | "exact_fragment">,
): boolean {
  if (!plan) return false;
  const expected = normalizedFindingFragment(finding.exact_fragment);
  if (!expected) return false;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    if (value.evidence_id === finding.evidence_id) {
      for (const key of ["exact_fragment", "text"] as const) {
        if (typeof value[key] !== "string") continue;
        const actual = normalizedFindingFragment(value[key]);
        if (actual && (actual.includes(expected) || expected.includes(actual))) return true;
      }
    }
    return Object.values(value).some(visit);
  };
  return visit(plan);
}

/** A broad provenance quote surviving repair does not prove the actual value survived. */
function findingCarrierProjection(plan: SemanticSourcePlan | undefined, finding: CoverageReviewFinding): string | undefined {
  if (!plan) return undefined;
  const fragment = normalizedFindingFragment(finding.exact_fragment);
  const scalarFields = ["name", "category", "requirement", "method", "quantity", "note"] as const;
  const fields = scalarFields.filter((field) => !finding.defect_field
    || finding.defect_field === "coverage" || finding.defect_field === "structure" || finding.defect_field === field);
  return sha256Json(plan.acceptance_items.flatMap((item) => {
    if (!item.evidence_ids.includes(finding.evidence_id)) return [];
    return fields.filter((field) => fragment && normalizedFindingFragment(item[field]).includes(fragment))
      .map((field) => ({ item_id: item.item_id, field }));
  }).sort((a, b) => `${a.item_id}:${a.field}`.localeCompare(`${b.item_id}:${b.field}`)));
}

function lineageProjectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lineageProjectionValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "reason" && key !== "confidence")
    .map(([key, entry]) => [key, lineageProjectionValue(entry)]));
}

function affectedItemProjection(
  plan: SemanticSourcePlan | undefined,
  itemIds: readonly string[],
  field?: CoverageReviewFinding["defect_field"],
): string | undefined {
  if (!plan) return undefined;
  const selectedItemIds = [...new Set(itemIds)].sort();
  const selectedItemIdSet = new Set(selectedItemIds);
  const itemById = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
  const referenceRoutes = (plan.reference_resolutions ?? []).flatMap((resolution) =>
    resolution.destination_bindings
      .filter((binding) => selectedItemIdSet.has(binding.item_id))
      .map((binding) => lineageProjectionValue({
        occurrence_id: resolution.occurrence_id,
        origin_evidence_id: resolution.origin_evidence_id,
        action: resolution.action,
        application_mode: resolution.application_mode,
        target_evidence_ids: [...resolution.target_evidence_ids].sort(),
        item_id: binding.item_id,
        target_field: binding.target_field,
      })),
  ).sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
  const semanticReferenceRoutes = (plan.semantic_references ?? []).flatMap((reference) =>
    reference.destination_bindings
      .filter((binding) => selectedItemIdSet.has(binding.item_id))
      .map((binding) => lineageProjectionValue({
        anchor_semantic_id: reference.anchor_semantic_id,
        status: reference.status,
        target_semantic_ids: [...reference.target_semantic_ids].sort(),
        item_id: binding.item_id,
        fields: [...binding.fields].sort(),
      })),
  ).sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
  const selectedRuleIds = new Set(selectedItemIds.flatMap((itemId) =>
    itemById.get(itemId)?.sampling.rule_ids ?? []
  ));
  const samplingRules = (plan.shared_sampling_rules ?? [])
    .filter((rule) => selectedRuleIds.has(rule.rule_id)
      || rule.receiving_item_ids.some((itemId) => selectedItemIdSet.has(itemId)))
    .map(lineageProjectionValue)
    .sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
  return sha256Json({
    items: selectedItemIds.map((itemId) => ({
      item_id: itemId,
      projection: lineageProjectionValue(field && field in (itemById.get(itemId) ?? {})
        ? { value: (itemById.get(itemId) as unknown as Record<string, unknown>)[field] }
        : itemById.get(itemId) ?? null),
    })),
    reference_routes: !field || field === "reference" ? referenceRoutes : [],
    semantic_reference_routes: !field || field === "reference" ? semanticReferenceRoutes : [],
    sampling_rules: !field || field === "sampling" || field === "quantity" ? samplingRules : [],
  });
}

export function coverageReviewerMissIdentity(
  finding: CoverageReviewFinding,
): string {
  return `reviewer-miss:${sha256Json({
    judgment_id: finding.judgment_id || coverageFindingJudgmentIdentity(finding),
    evidence_id: finding.evidence_id,
    exact_fragment: normalizedFindingFragment(finding.exact_fragment),
    affected_item_ids: [...new Set(finding.affected_item_ids)].sort(),
  })}`;
}

export function normalizeCoverageReviewFindingLineage(
  review: DomainCoverageReview,
  priorReview?: DomainCoverageReview,
  priorPlan?: SemanticSourcePlan,
  candidatePlan?: SemanticSourcePlan,
): { review: DomainCoverageReview; changed: boolean } {
  const normalized = structuredClone(review);
  const priorFindings = priorReview?.findings ?? [];
  const priorByFindingId = new Map(priorFindings.map((finding) => [
    finding.finding_id,
    finding,
  ]));
  const priorByJudgment = new Map(priorFindings.map((finding) => [
    coverageFindingJudgmentIdentity(finding, priorPlan),
    finding,
  ]));
  let changed = false;
  normalized.findings = normalized.findings.map((finding) => {
    const derivedJudgmentId = coverageFindingJudgmentIdentity(finding, candidatePlan);
    const sameId = priorByFindingId.get(finding.finding_id);
    const prior = (sameId && sameId.defect_field === finding.defect_field ? sameId : undefined)
      ?? priorByJudgment.get(derivedJudgmentId);
    const judgmentId = prior?.judgment_id || (prior ? coverageFindingJudgmentIdentity(prior, priorPlan) : derivedJudgmentId);
    const affectedItemIds = [...new Set([
      ...(prior?.affected_item_ids ?? []),
      ...finding.affected_item_ids,
    ])];
    const priorItemProjection = affectedItemProjection(priorPlan, affectedItemIds, finding.defect_field);
    const candidateItemProjection = affectedItemProjection(candidatePlan, affectedItemIds, finding.defect_field);
    const itemProjectionChanged = priorItemProjection !== undefined
      && candidateItemProjection !== undefined
      && priorItemProjection !== candidateItemProjection;
    const fragmentPresenceChanged = semanticPlanContainsFindingFragment(priorPlan, finding)
      !== semanticPlanContainsFindingFragment(candidatePlan, finding);
    const carrierChanged = priorPlan !== undefined && candidatePlan !== undefined
      && findingCarrierProjection(priorPlan, finding) !== findingCarrierProjection(candidatePlan, finding);
    const representationChanged = itemProjectionChanged || fragmentPresenceChanged || carrierChanged;
    const findingOrigin: CoverageFindingOrigin = prior
      ? representationChanged
        ? "repair_introduced"
        : "unresolved_prior"
      : priorReview
        ? representationChanged
          ? "repair_introduced"
          : "reviewer_missed_preexisting"
        : "initial_review";
    const firstSeenPlanFingerprint = prior?.first_seen_plan_fingerprint
      || (findingOrigin === "repair_introduced" ? review.plan_fingerprint : priorReview?.plan_fingerprint)
      || review.plan_fingerprint;
    const { prior_finding_id: _stalePriorFindingId, ...authoredFinding } = finding;
    const next = {
      ...authoredFinding,
      judgment_id: judgmentId,
      finding_origin: findingOrigin,
      first_seen_plan_fingerprint: firstSeenPlanFingerprint,
      ...(prior ? { prior_finding_id: prior.finding_id } : {}),
    };
    if (sha256Json(next) !== sha256Json(finding)) changed = true;
    return next;
  });
  return { review: normalized, changed };
}

export function migrateCoverageReview(value: unknown): unknown {
  if (!isRecord(value) || value.schema_version !== "domain-coverage-review/v3") return value;
  const findings = Array.isArray(value.findings) ? value.findings : [];
  if (value.status !== "approved" || findings.length !== 0) {
    return value;
  }
  const rows = Array.isArray(value.semantic_coverage) ? value.semantic_coverage.filter(isRecord) : [];
  const grouped = new Map<string, SemanticCoverageDisposition>();
  for (const row of rows) {
    const disposition = row.disposition;
    const itemIds = Array.isArray(row.item_ids)
      ? row.item_ids.filter((itemId): itemId is string => typeof itemId === "string")
      : [];
    const key = disposition === "acceptance_item"
      ? `leaf:${itemIds[0] ?? ""}`
      : `${String(disposition)}:${itemIds.slice().sort().join("|")}:${String(row.evidence_id ?? "")}`;
    const existing = grouped.get(key);
    const binding = typeof row.evidence_id === "string" && typeof row.exact_fragment === "string"
      ? [{ evidence_id: row.evidence_id, exact_fragment: row.exact_fragment }]
      : [];
    if (existing) {
      for (const candidate of binding) {
        if (!existing.evidence_bindings.some((entry) => entry.evidence_id === candidate.evidence_id && entry.exact_fragment === candidate.exact_fragment)) {
          existing.evidence_bindings.push(candidate);
        }
      }
      continue;
    }
    grouped.set(key, {
      coverage_id: typeof row.coverage_id === "string" ? row.coverage_id : `migrated:${grouped.size + 1}`,
      disposition: disposition === "acceptance_item" || disposition === "shared_context" ? disposition : "irrelevant",
      judgment_id: typeof row.judgment_id === "string" ? row.judgment_id : "",
      item_ids: itemIds,
      evidence_bindings: binding,
      reason: typeof row.reason === "string" ? row.reason : "Migrated from the validated v3 coverage artifact.",
    });
  }
  return {
    schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
    plan_fingerprint: typeof value.plan_fingerprint === "string" ? value.plan_fingerprint : "",
    evidence_fingerprint: typeof value.evidence_fingerprint === "string" ? value.evidence_fingerprint : "",
    status: "approved",
    semantic_coverage: [...grouped.values()],
    findings: [],
    summary: typeof value.summary === "string" ? value.summary : "Migrated approved coverage review.",
  } satisfies DomainCoverageReview;
}

export interface CoverageReviewIssue {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}

interface CoverageReviewState {
  schema_version: "coverage-review-state/v1";
  status: "working" | "sealed";
  next_event_sequence: number;
  next_history_sequence: number;
  next_validation_sequence: number;
  validation_attempts: number;
  opened_evidence_ids: string[];
  last_valid_review_fingerprint: string;
  related_context_delivery?: Record<string, { fingerprint: string; next_cursor: number; total_records: number }>;
  /**
   * Immutable candidate-section delivery ledger. It records successful tool
   * delivery only; semantic approval remains in working.coverage-review.json.
   */
  candidate_section_delivery?: Record<string, {
    item_id: string;
    sections: Record<string, {
      section_sha256: string;
      total_units: number;
      next_unit_index: number;
      complete: boolean;
    }>;
  }>;
  agent_runtime: RevisionState["agent_runtime"];
}

function reviewDirectory(workspace: RevisionWorkspace, planFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(planFingerprint)) {
    throw new Error("Coverage review requires a SHA-256 plan fingerprint");
  }
  return join(workspace.coverageReviewDirectory, planFingerprint);
}

function initialReview(planFingerprint: string, evidence: EvidenceManifest): DomainCoverageReview {
  return {
    schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    status: "repair",
    semantic_coverage: [],
    findings: [],
    summary: "",
  };
}

function initialState(): CoverageReviewState {
  return {
    schema_version: "coverage-review-state/v1",
    status: "working",
    next_event_sequence: 1,
    next_history_sequence: 1,
    next_validation_sequence: 1,
    validation_attempts: 0,
    opened_evidence_ids: [],
    last_valid_review_fingerprint: "",
    candidate_section_delivery: {},
    agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
  issues: CoverageReviewIssue[],
  optional: string[] = [],
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...expected, ...optional]);
  const missing = expected.filter((key) => !(key in value));
  const unexpected = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    issues.push({
      code: "coverage_review_shape",
      path,
      message: "Coverage review object keys must match the contract exactly",
      details: {
        expected: [...expected].sort(),
        actual: [...actual].sort(),
        ...(optional.length > 0 ? { optional: [...optional].sort() } : {}),
        ...(missing.length > 0 ? { missing } : {}),
        ...(unexpected.length > 0 ? { unexpected } : {}),
      },
    });
  }
}

function materializedCandidateFingerprint(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
): string {
  return sha256Json(materialize(candidatePlan, evidence, planFingerprint).result);
}

const MAX_COVERAGE_PATCH_OPERATIONS = 40;
const MAX_COVERAGE_PATCH_BYTES = 128 * 1024;
const MAX_COVERAGE_PATCH_SEMANTIC_CHANGES = 32;
const MAX_COVERAGE_READ_BYTES = 128 * 1024;
const MAX_CANDIDATE_INVENTORY_ITEMS = 128;
const MAX_CANDIDATE_DETAIL_ITEMS = 8;
const MAX_CANDIDATE_DETAIL_ITEMS_PER_FRESH_PHASE = 24;
const CANDIDATE_NAVIGATION_PREVIEW_CODE_POINTS = 160;
const CANDIDATE_DETAIL_TEXT_REFERENCE_MIN_BYTES = 1024;
const MAX_CANDIDATE_TEXT_PAGE_CODE_POINTS = 8192;
/** Keep section pages well below the 128 KiB tool-result envelope. */
const MAX_CANDIDATE_SECTION_PAGE_BYTES = 48 * 1024;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedCoverageIssues(issues: readonly unknown[]): unknown[] {
  if (serializedBytes(issues) <= 64 * 1024) return [...issues];
  return issues.slice(0, 16).map((value) => {
    const issue = isRecord(value) ? value : {};
    const details = isRecord(issue.details) ? issue.details : {};
    return {
      code: issue.code ?? "coverage_issue",
      path: issue.path ?? "/",
      message: issue.message ?? "Coverage review issue",
      details: Object.fromEntries([
        "coverage_id", "finding_id", "item_id", "evidence_id", "span_id", "required_action",
      ].flatMap((key) => Object.hasOwn(details, key) ? [[key, details[key]]] : [])),
    };
  });
}

function navigationPreview(value: string): {
  preview: string;
  truncated: boolean;
  utf8_bytes: number;
  sha256: string;
} {
  const characters = [...value];
  return {
    preview: characters.slice(0, CANDIDATE_NAVIGATION_PREVIEW_CODE_POINTS).join(""),
    truncated: characters.length > CANDIDATE_NAVIGATION_PREVIEW_CODE_POINTS,
    utf8_bytes: Buffer.byteLength(value, "utf8"),
    sha256: sha256Text(value),
  };
}

function addKnownEvidenceId(
  destination: Set<string>,
  knownIds: Set<string>,
  value: unknown,
): void {
  if (typeof value === "string" && knownIds.has(value)) destination.add(value);
}

function addKnownEvidenceIds(
  destination: Set<string>,
  knownIds: Set<string>,
  values: unknown,
): void {
  if (!Array.isArray(values)) return;
  for (const value of values) addKnownEvidenceId(destination, knownIds, value);
}

/**
 * Coverage obligations are semantic-plan obligations, not a copy of the
 * high-recall navigation inventory. Optional resources remain searchable and
 * become mandatory only when the plan actually binds them, they were
 * explicitly registered as dependencies, or the reviewer promotes them into
 * a disposition/finding.
 */
export function coverageMandatoryEvidenceIds(
  evidence: EvidenceManifest,
  candidatePlan?: SemanticSourcePlan,
  review?: unknown,
): string[] {
  const knownIds = new Set(evidence.evidence.map((record) => record.evidence_id));
  const mandatory = new Set<string>();

  for (const record of evidence.evidence) {
    if (
      record.evidence_scope === "primary"
      || record.requires_disposition
      || record.registered_dependency === true
    ) {
      mandatory.add(record.evidence_id);
    }
  }
  addKnownEvidenceIds(mandatory, knownIds, evidence.scope.selected_atom_ids);

  if (candidatePlan) {
    const occurrenceById = new Map(evidence.reference_occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
    for (const disposition of candidatePlan.evidence_dispositions) {
      if (disposition.disposition !== "ignored") {
        addKnownEvidenceId(mandatory, knownIds, disposition.evidence_id);
      }
    }
    for (const lot of candidatePlan.inspection_lots) {
      addKnownEvidenceIds(mandatory, knownIds, lot.evidence_ids);
    }
    for (const item of candidatePlan.acceptance_items) {
      addKnownEvidenceIds(mandatory, knownIds, item.evidence_ids);
      addKnownEvidenceIds(mandatory, knownIds, item.reference_evidence_ids);
      addKnownEvidenceIds(mandatory, knownIds, item.inspection_data_type_evidence_ids);
      addKnownEvidenceIds(mandatory, knownIds, item.sampling.evidence_ids);
      for (const binding of Object.values(item.field_bindings)) {
        addKnownEvidenceIds(mandatory, knownIds, binding.evidence_ids);
        for (const fragment of binding.source_fragments) {
          addKnownEvidenceId(mandatory, knownIds, fragment.evidence_id);
        }
      }
      if (item.table_semantics) {
        for (const fragment of item.table_semantics.cell_evidence) {
          addKnownEvidenceId(mandatory, knownIds, fragment.evidence_id);
        }
        for (const branch of item.table_semantics.acceptance_branches ?? []) {
          for (const fragment of [
            ...branch.condition_fragments,
            ...branch.requirement_fragments,
            ...branch.allowed_value_fragments,
          ]) addKnownEvidenceId(mandatory, knownIds, fragment.evidence_id);
        }
        for (const fragment of item.table_semantics.reference_fragments) {
          addKnownEvidenceId(mandatory, knownIds, fragment.evidence_id);
        }
      }
    }
    for (const table of candidatePlan.table_assembly.logical_tables) {
      addKnownEvidenceIds(mandatory, knownIds, table.evidence_ids);
      for (const fragment of table.canonical_title_fragments) {
        addKnownEvidenceId(mandatory, knownIds, fragment.evidence_id);
      }
    }
    for (const resolution of candidatePlan.reference_resolutions) {
      const occurrence = occurrenceById.get(resolution.occurrence_id);
      addKnownEvidenceIds(
        mandatory,
        knownIds,
        occurrence ? referenceOccurrenceOriginEvidenceIds(occurrence) : [resolution.origin_evidence_id],
      );
      addKnownEvidenceIds(mandatory, knownIds, resolution.target_evidence_ids);
    }
    for (const node of candidatePlan.semantic_evidence ?? []) {
      addKnownEvidenceId(mandatory, knownIds, node.evidence_id);
    }
    for (const rule of candidatePlan.shared_sampling_rules ?? []) {
      addKnownEvidenceIds(mandatory, knownIds, rule.evidence_ids);
      for (const branch of rule.branches) {
        addKnownEvidenceId(mandatory, knownIds, branch.evidence_id);
      }
      for (const condition of rule.shared_conditions) {
        addKnownEvidenceId(mandatory, knownIds, condition.evidence_id);
      }
    }
  }

  if (isRecord(review)) {
    for (const field of ["semantic_coverage", "findings"] as const) {
      const entries = review[field];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        addKnownEvidenceId(mandatory, knownIds, entry.evidence_id);
        if (Array.isArray(entry.evidence_bindings)) {
          for (const binding of entry.evidence_bindings) {
            if (isRecord(binding)) addKnownEvidenceId(mandatory, knownIds, binding.evidence_id);
          }
        }
      }
    }
  }
  return [...mandatory].sort();
}

export interface CoverageReviewScope {
  mode: "full" | "repair_delta" | "ledger_gap" | "risk_delta";
  affected_item_ids: string[];
  affected_evidence_ids: string[];
  finding_ids: string[];
  gap_clause_ids?: string[];
}

export interface CoverageReviewObligations {
  mode: CoverageReviewScope["mode"];
  required_item_ids: string[];
  uncovered_primary_evidence_ids: string[];
  handled_context_evidence_ids: string[];
  handled_ignored_evidence_ids: string[];
  review_record_count: number;
  searchable_evidence_count: number;
}

export function coverageFindingRoute(
  findings: ReadonlyArray<{ finding_type?: unknown }>,
): DomainCoverageReview["status"] {
  if (findings.some((finding) => finding.finding_type === "compiler_materialization_defect")) {
    return "harness_defect";
  }
  if (findings.some((finding) => finding.finding_type === "semantic_coverage_gap")) {
    return "repair";
  }
  return "approved";
}

function materializedFinalItems(candidatePlan: SemanticSourcePlan, evidence: EvidenceManifest): MaterializedAcceptanceItem[] {
  return materialize(candidatePlan, evidence, sha256Json(candidatePlan)).result.inspection_lots
    .flatMap((lot) => lot.items);
}

function finalItemEvidenceIds(item: MaterializedAcceptanceItem): Set<string> {
  return new Set([
    ...item.evidence_ids,
    ...item.reference_evidence_ids,
    ...item.sampling.evidence_ids,
  ]);
}

function normalizeCoverageSourceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function exactOccurrenceCount(value: string, fragment: string): number {
  if (!fragment) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - fragment.length) {
    const found = value.indexOf(fragment, offset);
    if (found < 0) break;
    count += 1;
    offset = found + fragment.length;
  }
  return count;
}

/**
 * Agent discovery keeps immutable source atoms as the selector address, but also
 * promotes their individual Markdown blocks to coverage obligations. A promoted
 * block is mechanically covered only when both it and one authored source fragment
 * resolve uniquely inside the same selected atom. Ambiguous repeated wording stays
 * uncovered for the independent reviewer instead of being guessed from text alone.
 */
function granularPrimaryCoveredByPlan(
  record: EvidenceRecord,
  evidence: EvidenceManifest,
  candidatePlan: SemanticSourcePlan,
  finalItems: MaterializedAcceptanceItem[],
): boolean {
  const selectedAtomIds = new Set(evidence.scope.selected_atom_ids ?? []);
  const selectedAtoms = evidence.evidence.filter((candidate) =>
    selectedAtomIds.has(candidate.evidence_id)
  );
  const recordText = normalizeCoverageSourceText(record.text);
  if (!recordText) return false;
  const parents = selectedAtoms.filter((atom) => {
    const atomText = normalizeCoverageSourceText(atom.text);
    return exactOccurrenceCount(atomText, recordText) === 1;
  });
  if (parents.length !== 1) return false;
  const parent = parents[0]!;
  const parentText = normalizeCoverageSourceText(parent.text);
  const candidateItemById = new Map(
    candidatePlan.acceptance_items.map((item) => [item.item_id, item]),
  );
  for (const item of finalItems) {
    const candidateItem = candidateItemById.get(
      item.reference_origin_item_id ?? item.item_id,
    );
    for (const fragment of itemProvenanceFragments(item, candidateItem, candidatePlan)) {
      if (fragment.evidence_id !== parent.evidence_id) continue;
      const fragmentText = normalizeCoverageSourceText(fragment.text);
      if (
        fragmentText
        && exactOccurrenceCount(parentText, fragmentText) === 1
        && (fragmentText.includes(recordText) || recordText.includes(fragmentText))
      ) return true;
    }
  }
  return false;
}

export function deriveCoverageRepairRecheckScope(
  evidence: EvidenceManifest,
  sourcePlan: SemanticSourcePlan,
  repairedPlan: SemanticSourcePlan,
  baseScope: CoverageReviewScope,
): CoverageReviewScope {
  const materializedEntries = (plan: SemanticSourcePlan) =>
    materialize(plan, evidence, sha256Json(plan)).result.inspection_lots.flatMap((lot) =>
      lot.items.map((item) => ({ lot_id: lot.lot_id, item }))
    );
  const sourceItems = materializedEntries(sourcePlan);
  const repairedItems = materializedEntries(repairedPlan);
  const sourceById = new Map(sourceItems.map((entry) => [entry.item.item_id, entry]));
  const repairedById = new Map(repairedItems.map((entry) => [entry.item.item_id, entry]));
  const affectedItemIds = new Set(baseScope.affected_item_ids);
  const affectedEvidenceIds = new Set(baseScope.affected_evidence_ids);
  const addEvidence = (item: MaterializedAcceptanceItem): void => {
    for (const evidenceId of finalItemEvidenceIds(item)) affectedEvidenceIds.add(evidenceId);
  };

  for (const repairedEntry of repairedItems) {
    const sourceEntry = sourceById.get(repairedEntry.item.item_id);
    if (sourceEntry && sha256Json(sourceEntry) === sha256Json(repairedEntry)) continue;
    affectedItemIds.add(repairedEntry.item.item_id);
    addEvidence(repairedEntry.item);
    if (sourceEntry) addEvidence(sourceEntry.item);
  }
  for (const sourceEntry of sourceItems) {
    if (repairedById.has(sourceEntry.item.item_id)) continue;
    affectedItemIds.add(sourceEntry.item.item_id);
    addEvidence(sourceEntry.item);
  }

  return {
    mode: "repair_delta",
    affected_item_ids: [...affectedItemIds].sort(),
    affected_evidence_ids: [...affectedEvidenceIds].sort(),
    finding_ids: [...new Set(baseScope.finding_ids)].sort(),
    ...(baseScope.gap_clause_ids ? { gap_clause_ids: [...baseScope.gap_clause_ids] } : {}),
  };
}

export function coverageReviewObligations(
  evidence: EvidenceManifest,
  candidatePlan: SemanticSourcePlan,
  scope?: CoverageReviewScope,
): CoverageReviewObligations {
  const finalItems = materializedFinalItems(candidatePlan, evidence);
  const affectedItems = new Set(scope?.affected_item_ids ?? []);
  const affectedEvidence = new Set(scope?.affected_evidence_ids ?? []);
  const inScope = (item: MaterializedAcceptanceItem): boolean => {
    if (!scope || scope.mode === "full") return true;
    if (affectedItems.has(item.item_id) || affectedItems.has(item.reference_origin_item_id ?? "")) {
      return true;
    }
    if (scope.mode === "ledger_gap") {
      const clause = item.source_clause ?? "";
      return (scope.gap_clause_ids ?? []).some((clauseId) =>
        clause === clauseId || clause.startsWith(`${clauseId}.`) || clauseId.startsWith(`${clause}.`)
      );
    }
    return false;
  };
  const scopedItems = finalItems.filter(inScope);
  const planCoveredEvidence = new Set(finalItems.flatMap((item) => [...finalItemEvidenceIds(item)]));
  for (const rule of candidatePlan.shared_sampling_rules ?? []) {
    for (const evidenceId of rule.evidence_ids) planCoveredEvidence.add(evidenceId);
    for (const condition of rule.shared_conditions) planCoveredEvidence.add(condition.evidence_id);
    for (const branch of rule.branches) planCoveredEvidence.add(branch.evidence_id);
  }
  const handledContext = new Set(
    (candidatePlan.evidence_dispositions ?? [])
      .filter((row) => row.disposition === "context")
      .map((row) => row.evidence_id),
  );
  const handledIgnored = new Set(
    (candidatePlan.evidence_dispositions ?? [])
      .filter((row) => row.disposition === "ignored")
      .map((row) => row.evidence_id),
  );
  const selectedIds = new Set(evidence.scope.selected_atom_ids ?? []);
  const scopedPrimaryNotOnLeaf = evidence.evidence
    .filter((record) => record.evidence_scope === "primary" || selectedIds.has(record.evidence_id))
    .filter((record) =>
      !planCoveredEvidence.has(record.evidence_id)
      && !granularPrimaryCoveredByPlan(record, evidence, candidatePlan, finalItems)
    )
    .filter((record) => {
      if (!scope || scope.mode === "full") return true;
      if (scope.mode === "ledger_gap") {
        return affectedEvidence.has(record.evidence_id)
          || (scope.gap_clause_ids ?? []).some((clauseId) => record.text.includes(clauseId));
      }
      return affectedEvidence.has(record.evidence_id);
    });
  const uncoveredPrimary = scopedPrimaryNotOnLeaf
    .filter((record) => !handledContext.has(record.evidence_id) && !handledIgnored.has(record.evidence_id))
    .map((record) => record.evidence_id)
    .sort();
  const handledContextIds = scopedPrimaryNotOnLeaf
    .filter((record) => handledContext.has(record.evidence_id))
    .map((record) => record.evidence_id)
    .sort();
  const handledIgnoredIds = scopedPrimaryNotOnLeaf
    .filter((record) => handledIgnored.has(record.evidence_id))
    .map((record) => record.evidence_id)
    .sort();
  const requiredItemIds = scopedItems.map((item) => item.item_id).sort();
  return {
    mode: scope?.mode ?? "full",
    required_item_ids: requiredItemIds,
    uncovered_primary_evidence_ids: uncoveredPrimary,
    handled_context_evidence_ids: handledContextIds,
    handled_ignored_evidence_ids: handledIgnoredIds,
    review_record_count: requiredItemIds.length + uncoveredPrimary.length,
    searchable_evidence_count: evidence.evidence.length,
  };
}

function validBlockingFindingEvidenceIds(
  value: unknown,
  evidence: EvidenceManifest,
  candidatePlan: SemanticSourcePlan,
  openedEvidenceIds: Set<string> | undefined,
  spanRegistry: SourceSpanRegistry | undefined,
): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.findings) || !spanRegistry) return new Set();
  const requiredKeys = [
    "finding_id", "finding_type", "evidence_id", "exact_fragment",
    "affected_item_ids", "description", "reason",
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    "span_id", "judgment_id", "finding_origin", "first_seen_plan_fingerprint", "prior_finding_id", "defect_field",
  ]);
  const findingIdCounts = new Map<string, number>();
  for (const finding of value.findings) {
    if (!isRecord(finding) || typeof finding.finding_id !== "string") continue;
    findingIdCounts.set(finding.finding_id, (findingIdCounts.get(finding.finding_id) ?? 0) + 1);
  }
  const evidenceById = new Map(evidence.evidence.map((record) => [record.evidence_id, record]));
  const finalItemIds = new Set(materializedFinalItems(candidatePlan, evidence).map((item) => item.item_id));
  const sources = coverageEvidenceSources(evidence);
  const covered = new Set<string>();
  for (const finding of value.findings) {
    if (!isRecord(finding)) continue;
    if (requiredKeys.some((key) => !(key in finding)) || Object.keys(finding).some((key) => !allowedKeys.has(key))) continue;
    if (finding.defect_field !== undefined && !COVERAGE_DEFECT_FIELDS.includes(finding.defect_field as typeof COVERAGE_DEFECT_FIELDS[number])) continue;
    if (finding.finding_type !== "semantic_coverage_gap" && finding.finding_type !== "compiler_materialization_defect") continue;
    if (typeof finding.finding_id !== "string" || !finding.finding_id.trim() || findingIdCounts.get(finding.finding_id) !== 1) continue;
    if (typeof finding.evidence_id !== "string" || typeof finding.exact_fragment !== "string" || !finding.exact_fragment) continue;
    if (typeof finding.description !== "string" || !finding.description.trim()
      || typeof finding.reason !== "string" || !finding.reason.trim()) continue;
    if (!Array.isArray(finding.affected_item_ids)
      || finding.affected_item_ids.some((itemId) => typeof itemId !== "string" || !itemId || !finalItemIds.has(itemId))
      || new Set(finding.affected_item_ids).size !== finding.affected_item_ids.length) continue;
    const record = evidenceById.get(finding.evidence_id);
    if (!record?.text.includes(finding.exact_fragment)) continue;
    if (openedEvidenceIds && !openedEvidenceIds.has(finding.evidence_id)) continue;
    const spanId = typeof finding.span_id === "string" ? finding.span_id.trim() : "";
    if (!spanId) continue;
    const spanIssues: SourceSpanIssue[] = [];
    const resolved = resolveSourceSpan(spanRegistry, spanId, sources, "/findings/span_id", spanIssues);
    if (!resolved || spanIssues.length > 0
      || (resolved.evidence_id !== finding.evidence_id && resolved.atom_id !== finding.evidence_id)
      || resolved.text !== finding.exact_fragment) continue;
    covered.add(finding.evidence_id);
  }
  return covered;
}

function coverageCheckpoint(
  value: unknown,
  evidence: EvidenceManifest,
  candidatePlan: SemanticSourcePlan,
  openedEvidenceIds?: Set<string>,
  scope?: CoverageReviewScope,
  spanRegistry?: SourceSpanRegistry,
): Record<string, unknown> {
  const obligations = coverageReviewObligations(evidence, candidatePlan, scope);
  const coveredItems = new Map<string, number>();
  const nonAcceptanceRowsByItem = new Map<string, Array<{
    path: string;
    disposition: string;
    coverage_id: string;
  }>>();
  const coveredPrimary = new Set<string>();
  const citedEvidence = new Set<string>();
  const rowReadinessIssues: Array<Record<string, unknown>> = [];
  const semanticCoverageRecordCount = isRecord(value) && Array.isArray(value.semantic_coverage)
    ? value.semantic_coverage.length
    : 0;
  let typedRows = true;
  if (isRecord(value) && Array.isArray(value.semantic_coverage)) {
    for (const [index, entry] of value.semantic_coverage.entries()) {
      const path = `/semantic_coverage/${index}`;
      if (!isRecord(entry) || !Array.isArray(entry.evidence_bindings)) {
        typedRows = false;
        continue;
      }
      if (
        typeof entry.coverage_id !== "string"
        || typeof entry.reason !== "string"
        || typeof entry.judgment_id !== "string"
        || !["acceptance_item", "shared_context", "irrelevant"].includes(String(entry.disposition))
        || !Array.isArray(entry.item_ids)
      ) typedRows = false;
      if (entry.disposition === "acceptance_item" && Array.isArray(entry.item_ids)) {
        for (const itemId of entry.item_ids) {
          if (typeof itemId === "string") coveredItems.set(itemId, (coveredItems.get(itemId) ?? 0) + 1);
        }
      } else if (Array.isArray(entry.item_ids)) {
        for (const itemId of entry.item_ids) {
          if (typeof itemId !== "string") continue;
          const rows = nonAcceptanceRowsByItem.get(itemId) ?? [];
          rows.push({
            path,
            disposition: typeof entry.disposition === "string" ? entry.disposition : "",
            coverage_id: typeof entry.coverage_id === "string" ? entry.coverage_id : "",
          });
          nonAcceptanceRowsByItem.set(itemId, rows);
        }
        if (entry.disposition === "irrelevant" && entry.item_ids.length > 0) {
          rowReadinessIssues.push({
            code: "coverage_review_irrelevant_items",
            path: `${path}/item_ids`,
            message: "Irrelevant meaning must not bind acceptance items",
          });
        }
      }
      for (const binding of entry.evidence_bindings) {
        if (!isRecord(binding) || typeof binding.evidence_id !== "string" || typeof binding.exact_fragment !== "string") {
          typedRows = false;
          continue;
        }
        citedEvidence.add(binding.evidence_id);
        coveredPrimary.add(binding.evidence_id);
      }
    }
  } else {
    typedRows = false;
  }
  if (isRecord(value) && Array.isArray(value.findings)) {
    for (const finding of value.findings) {
      if (
        !isRecord(finding)
        || typeof finding.finding_id !== "string"
        || !["semantic_coverage_gap", "compiler_materialization_defect", "soft_classification_disagreement", "source_glyph_review"].includes(String(finding.finding_type))
        || typeof finding.evidence_id !== "string"
        || typeof finding.exact_fragment !== "string"
        || !Array.isArray(finding.affected_item_ids)
        || typeof finding.description !== "string"
        || typeof finding.reason !== "string"
      ) {
        typedRows = false;
        continue;
      }
      citedEvidence.add(finding.evidence_id);
    }
  }
  const blockingFindingEvidenceIds = [...validBlockingFindingEvidenceIds(
    value,
    evidence,
    candidatePlan,
    openedEvidenceIds,
    spanRegistry,
  )].filter((evidenceId) => obligations.uncovered_primary_evidence_ids.includes(evidenceId)).sort();
  blockingFindingEvidenceIds.forEach((evidenceId) => coveredPrimary.add(evidenceId));
  const missingItemIds = obligations.required_item_ids.filter((id) => coveredItems.get(id) !== 1);
  const missingPrimaryIds = obligations.uncovered_primary_evidence_ids.filter((id) => !coveredPrimary.has(id));
  const missingOpenedIds = openedEvidenceIds
    ? [...citedEvidence].filter((id) => !openedEvidenceIds.has(id)).sort()
    : [];
  const routedStatus = isRecord(value) && Array.isArray(value.findings)
    ? coverageFindingRoute(value.findings.filter(isRecord))
    : undefined;
  const statusTyped = isRecord(value)
    && ["approved", "repair", "harness_defect"].includes(String(value.status));
  const summaryReady = isRecord(value)
    && typeof value.summary === "string"
    && value.summary.trim().length > 0;
  const findingsTyped = isRecord(value) && Array.isArray(value.findings);
  const statusRouted = isRecord(value) && routedStatus !== undefined && value.status === routedStatus;
  const statusReady = statusTyped && summaryReady && findingsTyped && statusRouted;
  const readinessIssues: Array<Record<string, unknown>> = [];
  readinessIssues.push(...rowReadinessIssues);
  if (!typedRows) readinessIssues.push({ code: "coverage_checkpoint_typed_rows_invalid" });
  if (!statusTyped) readinessIssues.push({ code: "coverage_checkpoint_status_invalid" });
  if (!summaryReady) readinessIssues.push({ code: "coverage_checkpoint_summary_required" });
  if (!findingsTyped) readinessIssues.push({ code: "coverage_checkpoint_findings_invalid" });
  if (findingsTyped && statusTyped && !statusRouted) {
    readinessIssues.push({
      code: "coverage_checkpoint_status_route_mismatch",
      expected_status: routedStatus,
      actual_status: isRecord(value) ? value.status : undefined,
    });
  }
  if (missingItemIds.length > 0) {
    for (const itemId of missingItemIds) {
      for (const row of nonAcceptanceRowsByItem.get(itemId) ?? []) {
        readinessIssues.push({
          code: "coverage_checkpoint_final_leaf_disposition_required",
          path: `${row.path}/disposition`,
          item_id: itemId,
          coverage_id: row.coverage_id,
          actual_disposition: row.disposition,
          required_disposition: "acceptance_item",
          action: "Keep a separate shared-context qualifier if it is genuinely needed, but upsert exactly one acceptance_item review record for this required materialized final leaf. Preserve any candidate defect as a typed finding; acceptance_item identifies the review subject and does not approve it.",
        });
      }
    }
    readinessIssues.push({ code: "coverage_checkpoint_missing_final_items", item_ids: missingItemIds });
  }
  if (missingPrimaryIds.length > 0) {
    readinessIssues.push({
      code: "coverage_checkpoint_missing_primary_dispositions",
      evidence_ids: missingPrimaryIds,
      required_dispositions: ["shared_context", "irrelevant", "validated_blocking_finding"],
      action: "Open each listed evidence resource. If the candidate already preserves its meaning, upsert an exact shared_context/irrelevant disposition. If the evidence instead proves candidate meaning or provenance is missing, preserve the exact evidence in a blocking semantic_coverage_gap finding for Repair and do not bind it into an item the candidate does not carry. Manifest requires_disposition=false applies only to selector authoring and does not waive this review obligation.",
    });
  }
  if (missingOpenedIds.length > 0) {
    readinessIssues.push({ code: "coverage_checkpoint_missing_opened_evidence", evidence_ids: missingOpenedIds });
  }
  return {
    ...obligations,
    completed_item_count: obligations.required_item_ids.length - missingItemIds.length,
    completed_uncovered_primary_count: obligations.uncovered_primary_evidence_ids.length - missingPrimaryIds.length,
    blocking_finding_evidence_ids: blockingFindingEvidenceIds,
    missing_item_ids: missingItemIds,
    missing_uncovered_primary_evidence_ids: missingPrimaryIds,
    missing_opened_evidence_ids: missingOpenedIds,
    readiness_issues: readinessIssues,
    mechanical_finalization_required:
      missingItemIds.length > 0
      && missingItemIds.every((itemId) => (nonAcceptanceRowsByItem.get(itemId)?.length ?? 0) > 0)
      && semanticCoverageRecordCount >= obligations.review_record_count
      && missingPrimaryIds.length === 0
      && missingOpenedIds.length === 0,
    ready_for_validation:
      typedRows
      && statusReady
      && missingItemIds.length === 0
      && missingPrimaryIds.length === 0
      && missingOpenedIds.length === 0,
  };
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))].sort()
    : [];
}

function typedIssueFingerprint(issues: CoverageReviewIssue[]): string {
  return sha256Json(issues
    .map((issue) => ({ code: issue.code, path: issue.path }))
    .sort((left, right) => `${left.code}\u0000${left.path}`.localeCompare(`${right.code}\u0000${right.path}`)));
}

export function coverageReviewProgressFingerprint(
  value: unknown,
  checkpoint: Record<string, unknown>,
  state: {
    opened_evidence_ids: string[];
    last_valid_review_fingerprint: string;
    status: "working" | "sealed";
    candidate_section_delivery?: CoverageReviewState["candidate_section_delivery"];
    related_context_delivery?: CoverageReviewState["related_context_delivery"];
    local_validation_issue_fingerprint?: string;
  },
): string {
  const review = isRecord(value) ? value : {};
  const semanticCoverage = Array.isArray(review.semantic_coverage)
    ? review.semantic_coverage.filter(isRecord).map((row) => ({
        coverage_id: typeof row.coverage_id === "string" ? row.coverage_id : "",
        disposition: typeof row.disposition === "string" ? row.disposition : "",
        judgment_id: typeof row.judgment_id === "string" ? row.judgment_id : "",
        item_ids: sortedStrings(row.item_ids),
        evidence_bindings: Array.isArray(row.evidence_bindings)
          ? row.evidence_bindings.filter(isRecord).map((binding) => ({
              evidence_id: typeof binding.evidence_id === "string" ? binding.evidence_id : "",
              exact_fragment_sha256: typeof binding.exact_fragment === "string"
                ? sha256Text(binding.exact_fragment)
                : "",
            })).sort((left, right) =>
              `${left.evidence_id}\u0000${left.exact_fragment_sha256}`
                .localeCompare(`${right.evidence_id}\u0000${right.exact_fragment_sha256}`))
          : [],
      })).sort((left, right) => left.coverage_id.localeCompare(right.coverage_id))
    : [];
  const findingIssueFingerprints = Array.isArray(review.findings)
    ? review.findings.filter(isRecord).map((finding) => sha256Json({
        finding_type: typeof finding.finding_type === "string" ? finding.finding_type : "",
        evidence_id: typeof finding.evidence_id === "string" ? finding.evidence_id : "",
        exact_fragment_sha256: typeof finding.exact_fragment === "string"
          ? sha256Text(finding.exact_fragment)
          : "",
        affected_item_ids: sortedStrings(finding.affected_item_ids),
      })).sort()
    : [];
  const readinessIssueFingerprints = Array.isArray(checkpoint.readiness_issues)
    ? checkpoint.readiness_issues.filter(isRecord)
      .filter((issue) =>
        issue.code !== "coverage_checkpoint_status_route_mismatch"
        && issue.code !== "coverage_checkpoint_summary_required"
      )
      .map((issue) => sha256Json({
        code: typeof issue.code === "string" ? issue.code : "",
        item_ids: sortedStrings(issue.item_ids),
        evidence_ids: sortedStrings(issue.evidence_ids),
      })).sort()
    : [];
  return sha256Json({
    semantic_coverage: semanticCoverage,
    finding_issue_fingerprints: findingIssueFingerprints,
    obligations: {
      mode: typeof checkpoint.mode === "string" ? checkpoint.mode : "",
      required_item_ids: sortedStrings(checkpoint.required_item_ids),
      uncovered_primary_evidence_ids: sortedStrings(checkpoint.uncovered_primary_evidence_ids),
      handled_context_evidence_ids: sortedStrings(checkpoint.handled_context_evidence_ids),
      handled_ignored_evidence_ids: sortedStrings(checkpoint.handled_ignored_evidence_ids),
      missing_item_ids: sortedStrings(checkpoint.missing_item_ids),
      missing_uncovered_primary_evidence_ids: sortedStrings(checkpoint.missing_uncovered_primary_evidence_ids),
      missing_opened_evidence_ids: sortedStrings(checkpoint.missing_opened_evidence_ids),
      completed_item_count: Number(checkpoint.completed_item_count ?? 0),
      completed_uncovered_primary_count: Number(checkpoint.completed_uncovered_primary_count ?? 0),
      ready_for_validation: checkpoint.ready_for_validation === true,
      readiness_issue_fingerprints: readinessIssueFingerprints,
    },
    opened_evidence_ids: sortedStrings(state.opened_evidence_ids),
    related_context_delivery: state.related_context_delivery ?? {},
    validation: {
      state_status: state.status,
      last_valid_review_fingerprint: state.last_valid_review_fingerprint,
      local_issue_fingerprint: state.local_validation_issue_fingerprint ?? "",
    },
    candidate_section_delivery: Object.entries(state.candidate_section_delivery ?? {})
      .map(([snapshotId, delivery]) => ({
        candidate_snapshot_id: snapshotId,
        item_id: delivery.item_id,
        sections: Object.entries(delivery.sections)
          .map(([sectionRef, section]) => ({ section_ref: sectionRef, ...section }))
          .sort((left, right) => left.section_ref.localeCompare(right.section_ref)),
      }))
      .sort((left, right) => left.candidate_snapshot_id.localeCompare(right.candidate_snapshot_id)),
  });
}

function keyedFingerprints(value: unknown, field: string, idField: string): Map<string, string> {
  if (!isRecord(value) || !Array.isArray(value[field])) return new Map();
  return new Map((value[field] as unknown[]).map((entry, index) => {
    const key = isRecord(entry) && typeof entry[idField] === "string"
      ? String(entry[idField])
      : `${field}:${index}`;
    return [key, sha256Json(entry)] as const;
  }));
}

function changedCoverageRecords(before: unknown, after: unknown): string[] {
  const changed: string[] = [];
  for (const [field, idField] of [
    ["semantic_coverage", "coverage_id"],
    ["findings", "finding_id"],
  ] as const) {
    const left = keyedFingerprints(before, field, idField);
    const right = keyedFingerprints(after, field, idField);
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      if (left.get(key) !== right.get(key)) changed.push(`${field}:${key}`);
    }
  }
  return changed;
}

function fragmentRepairCandidates(text: string, suppliedFragment: unknown): string[] {
  const supplied = typeof suppliedFragment === "string"
    ? suppliedFragment.replace(/\s+/g, "")
    : "";
  const suppliedUnits = Array.from(supplied);
  const suppliedUnigrams = new Set(suppliedUnits);
  const suppliedBigrams = new Set(
    suppliedUnits.slice(0, -1).map((unit, index) => `${unit}${suppliedUnits[index + 1]}`),
  );
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => ({ exact: line.trim(), index }))
    .filter((entry) => entry.exact.length > 0)
    .map((entry) => {
      const units = Array.from(entry.exact.replace(/\s+/g, ""));
      const unigrams = new Set(units);
      const bigrams = new Set(
        units.slice(0, -1).map((unit, index) => `${unit}${units[index + 1]}`),
      );
      const unigramMatches = [...suppliedUnigrams].filter((unit) => unigrams.has(unit)).length;
      const bigramMatches = [...suppliedBigrams].filter((unit) => bigrams.has(unit)).length;
      return { ...entry, score: unigramMatches + (bigramMatches * 4) };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return [...new Set(lines.slice(0, 3).map((entry) => entry.exact.slice(0, 240)))];
}

function exactFragmentRepairDetails(
  record: EvidenceManifest["evidence"][number],
  suppliedFragment: unknown,
): Record<string, unknown> {
  return {
    evidence_id: record.evidence_id,
    evidence_locator: record.locator,
    supplied_fragment: suppliedFragment,
    instruction: "Copy an exact substring from the immutable evidence; do not paraphrase or use the locator label.",
    exact_fragment_candidates: fragmentRepairCandidates(record.text, suppliedFragment),
  };
}

const MAX_AUTO_REPAIRED_GLYPH_DIFFS = 2;

function withoutWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function sameLengthCharDiffs(left: string, right: string): number {
  const leftUnits = Array.from(left);
  const rightUnits = Array.from(right);
  if (leftUnits.length !== rightUnits.length) return Number.POSITIVE_INFINITY;
  let diffs = 0;
  for (let index = 0; index < leftUnits.length; index += 1) {
    if (leftUnits[index] !== rightUnits[index]) diffs += 1;
  }
  return diffs;
}

/**
 * 机械愈合「纯字形滑笔」的引文：仅当 validator 候选与模型提交去空白后等长、
 * 差异 ≤2 字、且候选唯一时采用候选（候选本身就是证据的逐字子串，零语义判断）。
 * 长度或语义有差异一律不动，维持原有打回流程。
 */
function autoRepairableExactFragment(recordText: string, suppliedFragment: unknown): string {
  if (typeof suppliedFragment !== "string" || !suppliedFragment.trim()) return "";
  if (recordText.includes(suppliedFragment)) return "";
  const supplied = withoutWhitespace(suppliedFragment);
  const candidates = [...new Set(
    fragmentRepairCandidates(recordText, suppliedFragment)
      .filter((candidate) => recordText.includes(candidate))
      .filter((candidate) => sameLengthCharDiffs(withoutWhitespace(candidate), supplied) <= MAX_AUTO_REPAIRED_GLYPH_DIFFS),
  )];
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return only ?? "";
}

export interface CoverageFragmentAutoRepair {
  path: string;
  evidence_id: string;
  supplied_fragment: string;
  applied_fragment: string;
}

export function coverageEvidenceSources(evidence: EvidenceManifest): Map<string, ImmutableTextSource> {
  return new Map(evidence.evidence.map((record) => [record.evidence_id, {
    source_id: record.evidence_id,
    text: record.text,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
  }]));
}

export interface CoverageSpanMaterialization {
  path: string;
  span_id: string;
  evidence_id: string;
  exact_fragment: string;
}

/**
 * 指针式引用的物化：模型只交 span_id，exact_fragment 由注册表偏移 + 证据文本切出，
 * 并经 text_sha256 复核（resolveSourceSpan 内置）。识别判断（引哪条证据、什么
 * disposition）仍完全由模型决定；这里只消灭「誊写原文」这个动作。
 */
export function materializeCoverageSpanBindings(
  value: unknown,
  evidence: EvidenceManifest,
  registry: SourceSpanRegistry | undefined,
): { value: unknown; issues: SourceSpanIssue[]; materialized: CoverageSpanMaterialization[] } {
  if (!isRecord(value)) return { value, issues: [], materialized: [] };
  const sources = coverageEvidenceSources(evidence);
  const issues: SourceSpanIssue[] = [];
  const materialized: CoverageSpanMaterialization[] = [];
  const resolveBinding = (binding: unknown, path: string): unknown => {
    if (!isRecord(binding)) return binding;
    const spanId = typeof binding.span_id === "string" ? binding.span_id.trim() : "";
    if (!spanId) return binding;
    if (!registry) {
      issues.push({
        code: "coverage_review_span_registry_unavailable",
        path: `${path}/span_id`,
        message: "Span bindings require the revision source span registry",
        details: { span_id: spanId },
      });
      return binding;
    }
    const resolutionIssues: SourceSpanIssue[] = [];
    const resolved = resolveSourceSpan(registry, spanId, sources, `${path}/span_id`, resolutionIssues);
    if (!resolved) {
      for (const issue of resolutionIssues) {
        issues.push({
          ...issue,
          code: (typeof issue.code === "string" ? issue.code : "coverage_review_span_error")
            .replace(/^selector_/, "coverage_review_"),
        });
      }
      return binding;
    }
    const citedEvidenceId = typeof binding.evidence_id === "string" ? binding.evidence_id : "";
    if (citedEvidenceId && citedEvidenceId !== resolved.evidence_id && citedEvidenceId !== resolved.atom_id) {
      issues.push({
        code: "coverage_review_span_evidence_mismatch",
        path: `${path}/span_id`,
        message: "Span belongs to a different evidence resource than the cited evidence_id",
        details: { span_id: spanId, cited_evidence_id: citedEvidenceId, span_evidence_id: resolved.evidence_id },
      });
      return binding;
    }
    materialized.push({
      path,
      span_id: spanId,
      evidence_id: resolved.evidence_id,
      exact_fragment: resolved.text,
    });
    return {
      ...binding,
      evidence_id: resolved.evidence_id,
      exact_fragment: resolved.text,
      span_id: spanId,
    };
  };
  const semanticCoverage = (Array.isArray(value.semantic_coverage) ? value.semantic_coverage : []).map((entry, entryIndex) => {
    if (!isRecord(entry) || !Array.isArray(entry.evidence_bindings)) return entry;
    const bindings = entry.evidence_bindings.map((binding, bindingIndex) =>
      resolveBinding(binding, `/semantic_coverage/${entryIndex}/evidence_bindings/${bindingIndex}`));
    return { ...entry, evidence_bindings: bindings };
  });
  const findings = (Array.isArray(value.findings) ? value.findings : []).map((finding, findingIndex) =>
    resolveBinding(finding, `/findings/${findingIndex}`));
  return { value: { ...value, semantic_coverage: semanticCoverage, findings }, issues, materialized };
}

export function autoRepairCoverageFragments(
  value: unknown,
  evidence: EvidenceManifest,
): { value: unknown; repairs: CoverageFragmentAutoRepair[] } {
  if (!isRecord(value)) return { value, repairs: [] };
  const evidenceById = new Map(evidence.evidence.map((record) => [record.evidence_id, record]));
  const repairs: CoverageFragmentAutoRepair[] = [];
  const semanticCoverage = (Array.isArray(value.semantic_coverage) ? value.semantic_coverage : []).map((entry, entryIndex) => {
    if (!isRecord(entry) || !Array.isArray(entry.evidence_bindings)) return entry;
    let entryChanged = false;
    const bindings = entry.evidence_bindings.map((binding, bindingIndex) => {
      if (!isRecord(binding)) return binding;
      const record = typeof binding.evidence_id === "string" ? evidenceById.get(binding.evidence_id) : undefined;
      if (!record) return binding;
      const applied = autoRepairableExactFragment(record.text, binding.exact_fragment);
      if (!applied) return binding;
      entryChanged = true;
      repairs.push({
        path: `/semantic_coverage/${entryIndex}/evidence_bindings/${bindingIndex}/exact_fragment`,
        evidence_id: record.evidence_id,
        supplied_fragment: String(binding.exact_fragment),
        applied_fragment: applied,
      });
      return { ...binding, exact_fragment: applied };
    });
    return entryChanged ? { ...entry, evidence_bindings: bindings } : entry;
  });
  const findings = (Array.isArray(value.findings) ? value.findings : []).map((finding, findingIndex) => {
    if (!isRecord(finding)) return finding;
    const record = typeof finding.evidence_id === "string" ? evidenceById.get(finding.evidence_id) : undefined;
    if (!record) return finding;
    const applied = autoRepairableExactFragment(record.text, finding.exact_fragment);
    if (!applied) return finding;
    repairs.push({
      path: `/findings/${findingIndex}/exact_fragment`,
      evidence_id: record.evidence_id,
      supplied_fragment: String(finding.exact_fragment),
      applied_fragment: applied,
    });
    return { ...finding, exact_fragment: applied };
  });
  if (!repairs.length) return { value, repairs };
  return { value: { ...value, semantic_coverage: semanticCoverage, findings }, repairs };
}

function normalizeSourceGlyphFindingOwnership(
  value: Record<string, unknown>,
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
): Record<string, unknown> {
  if (!Array.isArray(value.findings)) return value;
  const finalItems = materializedFinalItems(candidatePlan, evidence);
  const finalItemById = new Map(finalItems.map((item) => [item.item_id, item]));
  let changed = false;
  const findings = value.findings.map((finding) => {
    if (!isRecord(finding) || finding.finding_type !== "compiler_materialization_defect") return finding;
    const evidenceId = typeof finding.evidence_id === "string" ? finding.evidence_id : "";
    const exactFragment = typeof finding.exact_fragment === "string" ? finding.exact_fragment : "";
    const normalizedFragment = canonicalizeSourceGlyphsForComparison(exactFragment);
    if (normalizedFragment === exactFragment) return finding;
    const affectedItems = Array.isArray(finding.affected_item_ids)
      ? finding.affected_item_ids.filter((itemId): itemId is string => typeof itemId === "string")
        .map((itemId) => finalItemById.get(itemId))
        .filter((item): item is MaterializedAcceptanceItem => Boolean(item))
      : [];
    const safelyRepresented = affectedItems.length > 0 && affectedItems.every((item) => {
      const candidateItem = candidatePlan.acceptance_items.find((entry) =>
        entry.item_id === item.reference_origin_item_id || entry.item_id === item.item_id
      );
      const provenanceRetained = itemProvenanceFragments(item, candidateItem, candidatePlan)
        .some((fragment) => fragment.evidence_id === evidenceId && fragmentsOverlap(fragment.text, exactFragment));
      const displayValues = [
        item.name,
        item.requirement,
        item.method,
        item.quantity,
        item.note,
        item.table_semantics?.table_no ?? "",
        item.table_semantics?.table_title ?? "",
        item.table_semantics?.applicability ?? "",
        ...(item.table_semantics?.row_path ?? []),
        ...(item.table_semantics?.column_path ?? []),
        item.table_semantics?.unit ?? "",
        item.table_semantics?.condition ?? "",
        item.table_semantics?.allowed_value ?? "",
        ...(item.table_semantics?.acceptance_branches ?? []).flatMap((branch) => [
          branch.condition,
          branch.requirement,
          branch.allowed_value,
        ]),
        item.table_semantics?.inspection_method ?? "",
      ];
      return provenanceRetained && displayValues.some((display) => fragmentsOverlap(
        canonicalizeSourceGlyphsForComparison(display),
        normalizedFragment,
      ));
    });
    if (!safelyRepresented) return finding;
    changed = true;
    return { ...finding, finding_type: "source_glyph_review" };
  });
  if (!changed) return value;
  return {
    ...value,
    findings,
    status: coverageFindingRoute(findings.filter(isRecord)),
  };
}

/**
 * Resolve finding ownership before any status is persisted. The normalized
 * findings and their routed status are one atomic review state; callers must
 * not save the pre-normalized status and validate a different representation.
 */
export function normalizeCoverageReviewFindingOwnership(
  value: Record<string, unknown>,
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
): { value: Record<string, unknown>; changed: boolean } {
  const glyphValue = normalizeSourceGlyphFindingOwnership(value, candidatePlan, evidence);
  const ownership = normalizePlanAuthorizedCompilerFindings(
    glyphValue,
    candidatePlan,
    materializedFinalItems(candidatePlan, evidence),
  );
  const changed = glyphValue !== value || ownership.changed;
  if (!changed || !Array.isArray(ownership.value.findings)) {
    return { value: ownership.value, changed };
  }
  return {
    value: {
      ...ownership.value,
      status: coverageFindingRoute(ownership.value.findings.filter(isRecord)),
    },
    changed: true,
  };
}

export function validateCoverageReview(
  value: unknown,
  planFingerprint: string,
  evidence: EvidenceManifest,
  openedEvidenceIds?: Set<string>,
  candidatePlan?: SemanticSourcePlan,
  scope?: CoverageReviewScope,
  spanRegistry?: SourceSpanRegistry,
): { ok: boolean; issues: CoverageReviewIssue[]; review?: DomainCoverageReview; fingerprint?: string } {
  const issues: CoverageReviewIssue[] = [];
  const spanSources = spanRegistry ? coverageEvidenceSources(evidence) : undefined;
  const checkSpanConsistency = (
    carrier: Record<string, unknown>,
    carrierPath: string,
    citedEvidenceId: string,
    exactFragment: string,
  ): void => {
    const spanId = typeof carrier.span_id === "string" ? carrier.span_id.trim() : "";
    if (!spanId || !spanRegistry || !spanSources) return;
    const spanIssues: SourceSpanIssue[] = [];
    const resolved = resolveSourceSpan(spanRegistry, spanId, spanSources, `${carrierPath}/span_id`, spanIssues);
    if (!resolved) {
      issues.push({
        code: "coverage_review_span_unresolved",
        path: `${carrierPath}/span_id`,
        message: "Bound span does not resolve inside the immutable evidence package",
        details: { span_id: spanId, span_issues: spanIssues },
      });
      return;
    }
    if (citedEvidenceId !== resolved.evidence_id && citedEvidenceId !== resolved.atom_id) {
      issues.push({
        code: "coverage_review_span_evidence_mismatch",
        path: `${carrierPath}/span_id`,
        message: "Bound span belongs to a different evidence resource than the cited evidence_id",
        details: { span_id: spanId, cited_evidence_id: citedEvidenceId, span_evidence_id: resolved.evidence_id },
      });
      return;
    }
    if (resolved.text !== exactFragment) {
      issues.push({
        code: "coverage_review_span_fragment_mismatch",
        path: `${carrierPath}/span_id`,
        message: "Bound span bytes no longer equal the stored exact_fragment; restage with the span pointer",
        details: { span_id: spanId },
      });
    }
  };
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ code: "coverage_review_type", path: "/", message: "Coverage review must be a JSON object" }],
    };
  }
  if (candidatePlan) {
    value = normalizeCoverageReviewFindingOwnership(value, candidatePlan, evidence).value;
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ code: "coverage_review_type", path: "/", message: "Coverage review must be a JSON object" }],
    };
  }
  exactKeys(value, [
    "schema_version",
    "plan_fingerprint",
    "evidence_fingerprint",
    "status",
    "semantic_coverage",
    "findings",
    "summary",
  ], "/", issues);
  if (value.schema_version !== COVERAGE_REVIEW_SCHEMA_VERSION) {
    issues.push({ code: "coverage_review_schema", path: "/schema_version", message: "Unsupported coverage review schema" });
  }
  if (value.plan_fingerprint !== planFingerprint) {
    issues.push({ code: "coverage_review_plan_drift", path: "/plan_fingerprint", message: "Review is not bound to the current validated plan fingerprint" });
  }
  if (value.evidence_fingerprint !== evidence.evidence_fingerprint) {
    issues.push({ code: "coverage_review_evidence_drift", path: "/evidence_fingerprint", message: "Review is not bound to the current immutable evidence" });
  }
  if (value.status !== "approved" && value.status !== "repair" && value.status !== "harness_defect") {
    issues.push({ code: "coverage_review_status", path: "/status", message: "status must be approved, repair, or harness_defect" });
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    issues.push({ code: "coverage_review_summary", path: "/summary", message: "summary must be a non-empty string" });
  }
  const evidenceById = new Map(evidence.evidence.map((record) => [record.evidence_id, record]));
  const semanticCoverage = Array.isArray(value.semantic_coverage) ? value.semantic_coverage : [];
  if (!Array.isArray(value.semantic_coverage)) {
    issues.push({
      code: "coverage_review_semantic_coverage",
      path: "/semantic_coverage",
      message: "semantic_coverage must be an array",
    });
  }
  const coverageIds = new Set<string>();
  const coverageBindings: Array<{
    row: Record<string, unknown>;
    path: string;
    evidence_id: string;
    exact_fragment: string;
  }> = [];
  semanticCoverage.forEach((entry, index) => {
    const path = `/semantic_coverage/${index}`;
    if (!isRecord(entry)) {
      issues.push({ code: "coverage_review_semantic_type", path, message: "Semantic coverage disposition must be an object" });
      return;
    }
    exactKeys(entry, [
      "coverage_id",
      "disposition",
      "judgment_id",
      "item_ids",
      "evidence_bindings",
      "reason",
    ], path, issues);
    for (const field of ["coverage_id", "reason"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        issues.push({ code: "coverage_review_semantic_field", path: `${path}/${field}`, message: `${field} must be a non-empty string` });
      }
    }
    if (typeof entry.coverage_id === "string") {
      if (coverageIds.has(entry.coverage_id)) {
        issues.push({ code: "coverage_review_duplicate_semantic_coverage", path: `${path}/coverage_id`, message: "coverage_id must be unique" });
      }
      coverageIds.add(entry.coverage_id);
    }
    if (
      entry.disposition !== "acceptance_item"
      && entry.disposition !== "shared_context"
      && entry.disposition !== "irrelevant"
    ) {
      issues.push({
        code: "coverage_review_semantic_disposition",
        path: `${path}/disposition`,
        message: "disposition must be acceptance_item, shared_context, or irrelevant",
      });
    }
    if (typeof entry.judgment_id !== "string") {
      issues.push({ code: "coverage_review_semantic_judgment", path: `${path}/judgment_id`, message: "judgment_id must be a string" });
    }
    if (
      !Array.isArray(entry.item_ids)
      || entry.item_ids.some((itemId) => typeof itemId !== "string" || !itemId)
      || new Set(entry.item_ids).size !== entry.item_ids.length
    ) {
      issues.push({ code: "coverage_review_semantic_items", path: `${path}/item_ids`, message: "item_ids must contain unique non-empty strings" });
    }
    const bindings = Array.isArray(entry.evidence_bindings) ? entry.evidence_bindings : [];
    if (!Array.isArray(entry.evidence_bindings) || bindings.length === 0) {
      issues.push({ code: "coverage_review_evidence_bindings", path: `${path}/evidence_bindings`, message: "Each review record must bind at least one exact evidence fragment" });
    }
    const bindingKeys = new Set<string>();
    bindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path}/evidence_bindings/${bindingIndex}`;
      if (!isRecord(binding)) {
        issues.push({ code: "coverage_review_binding_type", path: bindingPath, message: "Evidence binding must be an object" });
        return;
      }
      exactKeys(binding, ["evidence_id", "exact_fragment"], bindingPath, issues, ["span_id"]);
      const evidenceId = typeof binding.evidence_id === "string" ? binding.evidence_id : "";
      const exactFragment = typeof binding.exact_fragment === "string" ? binding.exact_fragment : "";
      const key = `${evidenceId}\u0000${exactFragment}`;
      if (!evidenceId || !exactFragment) {
        issues.push({ code: "coverage_review_binding_field", path: bindingPath, message: "evidence_id and exact_fragment must be non-empty strings" });
      } else if (bindingKeys.has(key)) {
        issues.push({ code: "coverage_review_duplicate_binding", path: bindingPath, message: "A review record cannot repeat the same exact evidence binding" });
      }
      bindingKeys.add(key);
      const record = evidenceById.get(evidenceId);
      if (!record) {
        issues.push({ code: "coverage_review_semantic_unknown_evidence", path: `${bindingPath}/evidence_id`, message: "Semantic coverage cites unknown evidence" });
      } else if (!record.text.includes(exactFragment)) {
        issues.push({
          code: "coverage_review_semantic_fragment_not_exact",
          path: `${bindingPath}/exact_fragment`,
          message: "Semantic coverage fragment must be an exact substring of its evidence atom",
          details: exactFragmentRepairDetails(record, exactFragment),
        });
      }
      if (openedEvidenceIds && evidenceId && !openedEvidenceIds.has(evidenceId)) {
        issues.push({
          code: "coverage_review_evidence_not_opened",
          path: `${bindingPath}/evidence_id`,
          message: "Every cited evidence resource must be opened before validation",
          details: { evidence_id: evidenceId },
        });
      }
      if (evidenceId && exactFragment) checkSpanConsistency(binding, bindingPath, evidenceId, exactFragment);
      if (evidenceId && exactFragment) coverageBindings.push({ row: entry, path, evidence_id: evidenceId, exact_fragment: exactFragment });
    });
    if (entry.disposition === "acceptance_item") {
      if (typeof entry.judgment_id !== "string" || !entry.judgment_id.trim()) {
        issues.push({ code: "coverage_review_item_judgment_missing", path: `${path}/judgment_id`, message: "An acceptance-item proposition must name its independent judgment group" });
      }
    } else {
      if (entry.judgment_id !== "") {
        issues.push({
          code: "coverage_review_context_judgment",
          path: `${path}/judgment_id`,
          message: "Shared context and irrelevant meaning must not claim an acceptance judgment",
          details: { action: "clear_judgment_id", required_value: "", coverage_id: typeof entry.coverage_id === "string" ? entry.coverage_id : "" },
        });
      }
      if (entry.disposition === "irrelevant" && Array.isArray(entry.item_ids) && entry.item_ids.length > 0) {
        issues.push({ code: "coverage_review_irrelevant_items", path: `${path}/item_ids`, message: "Irrelevant meaning must not bind acceptance items" });
      }
    }
  });

  const findings = Array.isArray(value.findings) ? value.findings : [];
  if (!Array.isArray(value.findings)) {
    issues.push({ code: "coverage_review_findings", path: "/findings", message: "findings must be an array" });
  }
  const findingIds = new Set<string>();
  findings.forEach((finding, index) => {
    const path = `/findings/${index}`;
    if (!isRecord(finding)) {
      issues.push({ code: "coverage_review_finding_type", path, message: "Finding must be an object" });
      return;
    }
    exactKeys(
      finding,
      ["finding_id", "finding_type", "evidence_id", "exact_fragment", "affected_item_ids", "description", "reason"],
      path,
      issues,
      ["span_id", "judgment_id", "finding_origin", "first_seen_plan_fingerprint", "prior_finding_id", "defect_field"],
    );
    if (finding.defect_field !== undefined && !COVERAGE_DEFECT_FIELDS.includes(finding.defect_field as typeof COVERAGE_DEFECT_FIELDS[number])) {
      issues.push({ code: "coverage_finding_defect_field_invalid", path: `${path}/defect_field`,
        message: "Specify the defective field, not a leaf title or a free-form diagnosis.",
        details: { actual: finding.defect_field, allowed: [...COVERAGE_DEFECT_FIELDS], writable_collection: "findings",
          path: "/finding_upserts/*/defect_field", required_action: "Correct defect_field via stage_coverage_review_draft; do not edit candidate or compiled output.", next_tool: "stage_coverage_review_draft" } });
    }
    for (const field of ["finding_id", "evidence_id", "exact_fragment", "description", "reason"] as const) {
      if (typeof finding[field] !== "string" || !finding[field].trim()) {
        issues.push({ code: "coverage_review_finding_field", path: `${path}/${field}`, message: `${field} must be a non-empty string` });
      }
    }
    if (typeof finding.finding_id === "string") {
      if (findingIds.has(finding.finding_id)) {
        issues.push({ code: "coverage_review_duplicate_finding", path: `${path}/finding_id`, message: "finding_id must be unique" });
      }
      findingIds.add(finding.finding_id);
    }
    if (finding.judgment_id !== undefined
      && (typeof finding.judgment_id !== "string" || !finding.judgment_id.startsWith("judgment:"))) {
      issues.push({ code: "coverage_review_finding_judgment", path: `${path}/judgment_id`, message: "judgment_id must be the deterministic judgment identity" });
    }
    if (finding.finding_origin !== undefined && ![
      "initial_review",
      "unresolved_prior",
      "reviewer_missed_preexisting",
      "repair_introduced",
    ].includes(String(finding.finding_origin))) {
      issues.push({ code: "coverage_review_finding_origin", path: `${path}/finding_origin`, message: "finding_origin must identify initial, unresolved, missed-preexisting, or repair-introduced lineage" });
    }
    for (const field of ["first_seen_plan_fingerprint", "prior_finding_id"] as const) {
      if (finding[field] !== undefined && (typeof finding[field] !== "string" || !finding[field])) {
        issues.push({ code: "coverage_review_finding_lineage", path: `${path}/${field}`, message: `${field} must be a non-empty string when present` });
      }
    }
    if (
      finding.finding_type !== "semantic_coverage_gap"
      && finding.finding_type !== "compiler_materialization_defect"
      && finding.finding_type !== "soft_classification_disagreement"
      && finding.finding_type !== "source_glyph_review"
    ) {
      issues.push({ code: "coverage_review_finding_owner", path: `${path}/finding_type`, message: "finding_type must identify semantic, compiler/materializer, or soft-classification ownership" });
    }
    if (
      !Array.isArray(finding.affected_item_ids)
      || finding.affected_item_ids.some((itemId) => typeof itemId !== "string" || !itemId)
      || new Set(finding.affected_item_ids).size !== finding.affected_item_ids.length
    ) {
      issues.push({ code: "coverage_review_finding_items", path: `${path}/affected_item_ids`, message: "affected_item_ids must contain unique non-empty final item IDs" });
    }
    const record = typeof finding.evidence_id === "string" ? evidenceById.get(finding.evidence_id) : undefined;
    if (!record) {
      issues.push({ code: "coverage_review_unknown_evidence", path: `${path}/evidence_id`, message: "Finding cites unknown evidence" });
    } else if (
      typeof finding.exact_fragment !== "string"
      || !finding.exact_fragment
      || !record.text.includes(finding.exact_fragment)
    ) {
      issues.push({
        code: "coverage_review_fragment_not_exact",
        path: `${path}/exact_fragment`,
        message: "Finding fragment must be an exact substring of its evidence atom",
        details: exactFragmentRepairDetails(record, finding.exact_fragment),
      });
    }
    if (openedEvidenceIds && typeof finding.evidence_id === "string" && !openedEvidenceIds.has(finding.evidence_id)) {
      issues.push({ code: "coverage_review_finding_evidence_not_opened", path: `${path}/evidence_id`, message: "Finding evidence must be opened before validation", details: { evidence_id: finding.evidence_id } });
    }
    if (typeof finding.evidence_id === "string" && typeof finding.exact_fragment === "string" && finding.exact_fragment) {
      checkSpanConsistency(finding, path, finding.evidence_id, finding.exact_fragment);
    }
  });
  const routedStatus = coverageFindingRoute(findings.filter(isRecord));
  if (value.status !== routedStatus) {
    issues.push({
      code: "coverage_review_status_route_mismatch",
      path: "/status",
      message: "Review status is determined by typed finding ownership",
      details: { expected_status: routedStatus },
    });
  }

  if (!candidatePlan) {
    if (value.status === "approved") {
      issues.push({
        code: "coverage_review_candidate_missing",
        path: "/semantic_coverage",
        message: "An approval must be checked against the immutable candidate plan and its materialized final leaves",
      });
    }
  } else {
    const finalItems = materializedFinalItems(candidatePlan, evidence);
    const finalItemById = new Map(finalItems.map((item) => [item.item_id, item]));
    const candidateItemById = new Map(candidatePlan.acceptance_items.map((item) => [item.item_id, item]));
    const obligations = coverageReviewObligations(evidence, candidatePlan, scope);
    if (value.status === "approved" && scope?.gap_clause_ids?.length) {
      issues.push({
        code: "coverage_review_approved_with_ledger_gap",
        path: "/status",
        message: "A coverage review cannot approve while deterministic required-clause gaps remain",
        details: {
          gap_clause_ids: [...scope.gap_clause_ids],
          required_action: "materialize_or_explicitly_account_for_every_required_clause_before_approval",
        },
      });
    }
    const requiredItemIds = new Set(obligations.required_item_ids);
    const judgmentToItem = new Map<string, string>();
    const itemCoverageCount = new Map<string, number>();
    const finalItemMatchesPlanItem = (item: MaterializedAcceptanceItem, itemId: string) =>
      item.item_id === itemId || item.reference_origin_item_id === itemId;
    const explicitSemanticCarrierIds = (node: NonNullable<SemanticSourcePlan["semantic_evidence"]>[number]) => {
      const itemIds = new Set<string>();
      if (node.materialized_item_id) itemIds.add(node.materialized_item_id);
      for (const reference of candidatePlan.semantic_references ?? []) {
        if (reference.status !== "resolved") continue;
        if (reference.anchor_semantic_id !== node.semantic_id && !reference.target_semantic_ids.includes(node.semantic_id)) continue;
        for (const binding of reference.destination_bindings) itemIds.add(binding.item_id);
      }
      for (const rule of candidatePlan.shared_sampling_rules ?? []) {
        if (rule.source_semantic_id !== node.semantic_id) continue;
        for (const itemId of rule.receiving_item_ids) itemIds.add(itemId);
      }
      return itemIds;
    };
    const finalItemsCarryingFragment = (
      evidenceId: string,
      exactFragment: string,
      explicitItemIds?: ReadonlySet<string>,
    ) => finalItems.filter((item) =>
      (!explicitItemIds || explicitItemIds.size === 0 || [...explicitItemIds].some((itemId) => finalItemMatchesPlanItem(item, itemId)))
      && materializedItemCarriesFragment(
        item,
        candidateItemById.get(item.reference_origin_item_id) ?? candidateItemById.get(item.item_id),
        candidatePlan,
        evidenceId,
        exactFragment,
      ));
    findings.forEach((finding, index) => {
      if (!isRecord(finding) || !Array.isArray(finding.affected_item_ids)) return;
      const unknownItems = finding.affected_item_ids.filter((itemId) => typeof itemId === "string" && !finalItemById.has(itemId));
      if (unknownItems.length) {
        issues.push({ code: "coverage_review_finding_unknown_item", path: `/findings/${index}/affected_item_ids`, message: "Finding affected_item_ids must name materialized final leaves", details: { item_ids: unknownItems } });
      }
      if (
        finding.finding_type === "compiler_materialization_defect"
        && finding.affected_item_ids.length === 0
        && typeof finding.evidence_id === "string"
        && typeof finding.exact_fragment === "string"
      ) {
        const carriers = finalItemsCarryingFragment(finding.evidence_id, finding.exact_fragment);
        if (carriers.length > 0) {
          issues.push({
            code: "coverage_review_compiler_defect_carrier_conflict",
            path: `/findings/${index}`,
            message: "A compiler/materializer defect cannot claim that an exact fragment is absent while deterministic final-leaf provenance carries it",
            details: {
              finding_id: typeof finding.finding_id === "string" ? finding.finding_id : "",
              matched_item_ids: carriers.map((item) => item.item_id).sort(),
              action: "remove_the_false_missing_finding_or_name_the_actual_affected_leaf_and_precise_materialization_drift",
            },
          });
        }
      }
    });
    semanticCoverage.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const path = `/semantic_coverage/${index}`;
      const itemIds = Array.isArray(entry.item_ids)
        ? entry.item_ids.filter((itemId): itemId is string => typeof itemId === "string")
        : [];
      const unknownItems = itemIds.filter((itemId) => !finalItemById.has(itemId));
      if (unknownItems.length) {
        issues.push({ code: "coverage_review_unknown_item", path: `${path}/item_ids`, message: "Semantic coverage names an unknown materialized final leaf", details: { item_ids: unknownItems } });
      }
      const bindings = Array.isArray(entry.evidence_bindings) ? entry.evidence_bindings.filter(isRecord) : [];
      if (entry.disposition === "shared_context") {
        for (const itemId of itemIds) {
          const item = finalItemById.get(itemId);
          for (const binding of bindings) {
            if (item && typeof binding.evidence_id === "string" && typeof binding.exact_fragment === "string"
              && !materializedItemCarriesFragment(
              item,
              candidateItemById.get(item.reference_origin_item_id) ?? candidateItemById.get(itemId),
              candidatePlan,
              binding.evidence_id,
              binding.exact_fragment,
            )) {
              issues.push({
                code: "coverage_review_shared_fragment_unbound",
                path: `${path}/item_ids`,
                message: "This shared_context review link is not supported by the named leaf's provenance; an invalid review link alone does not prove a candidate omission",
                details: {
                  coverage_id: typeof entry.coverage_id === "string" ? entry.coverage_id : "",
                  item_id: itemId,
                  evidence_id: binding.evidence_id,
                  actual_item_ids: itemIds,
                  candidate_carries_fragment: false,
                  writable_collection: "semantic_coverage",
                  writable_path: `${path}/item_ids`,
                  required_action: "reassess_shared_context_binding",
                  next_tool: "stage_coverage_review_draft",
                  instruction: "First distinguish an unsupported review link from a source-proven business omission. For context whose meaning is already represented (for example a section/category label), remove only the unsupported item_ids and retain the exact evidence_bindings; do not create a blocking finding solely because this link failed. Preserve valid leaf reviews and keep approved if no genuine blocking findings remain. If the source instead proves a lost requirement, classification, applicability condition, method, or sampling rule, preserve or add that precise semantic_coverage_gap in finding_upserts and use repair. Do not dismiss normative content merely because it is a heading. Never modify candidate fields, inject context into acceptance requirements, substitute another fragment, or delete justified findings to pass this check.",
                },
              });
            }
          }
        }
      }
      if (entry.disposition !== "acceptance_item") return;
      if (itemIds.length !== 1) {
        issues.push({ code: "coverage_review_item_binding_count", path: `${path}/item_ids`, message: "Each final-leaf review record must bind exactly one final acceptance leaf" });
        return;
      }
      const itemId = itemIds[0]!;
      itemCoverageCount.set(itemId, (itemCoverageCount.get(itemId) ?? 0) + 1);
      if (!requiredItemIds.has(itemId)) {
        issues.push({ code: "coverage_review_item_outside_scope", path: `${path}/item_ids`, message: "The staged leaf is outside the deterministic review scope", details: { item_id: itemId } });
      }
      const judgmentId = typeof entry.judgment_id === "string" ? entry.judgment_id : "";
      const existingItem = judgmentToItem.get(judgmentId);
      if (existingItem && existingItem !== itemId) {
        issues.push({ code: "coverage_review_judgment_split", path: `${path}/judgment_id`, message: "One inseparable judgment group cannot be duplicated across different final leaves", details: { judgment_id: judgmentId, item_ids: [existingItem, itemId] } });
      }
      judgmentToItem.set(judgmentId, itemId);
      const item = finalItemById.get(itemId);
      for (const binding of bindings) {
        if (item && typeof binding.evidence_id === "string" && typeof binding.exact_fragment === "string"
          && !materializedItemCarriesFragment(
            item,
            candidateItemById.get(item.reference_origin_item_id) ?? candidateItemById.get(itemId),
            candidatePlan,
            binding.evidence_id,
            binding.exact_fragment,
          )) {
          issues.push({
            code: "coverage_review_item_fragment_unbound",
            path: `${path}/evidence_bindings`,
            message: "The final leaf must preserve every cited exact evidence fragment and its business meaning",
            details: {
              coverage_id: typeof entry.coverage_id === "string" ? entry.coverage_id : "",
              item_id: itemId,
              evidence_id: binding.evidence_id,
              allowed_evidence_ids: [...finalItemEvidenceIds(item)].sort(),
              instruction: "Replace or remove the invalid binding. Use only an exact fragment carried by this final leaf's immutable plan provenance.",
              allowed_bindings: itemAllowedBindings(
                item,
                candidateItemById.get(item.reference_origin_item_id) ?? candidateItemById.get(itemId),
                candidatePlan,
                evidence,
              ),
            },
          });
        }
      }
    });
    const uncoveredFinalItems = obligations.required_item_ids.filter((itemId) => itemCoverageCount.get(itemId) !== 1);
    if (uncoveredFinalItems.length) {
      issues.push({ code: "coverage_review_uncovered_final_items", path: "/semantic_coverage", message: "Every scoped materialized final acceptance leaf must have exactly one review record", details: { item_ids: uncoveredFinalItems } });
    }
    const uncoveredPrimary = obligations.uncovered_primary_evidence_ids.filter((evidenceId) =>
      !coverageBindings.some((binding) => binding.evidence_id === evidenceId && binding.row.disposition !== "acceptance_item")
      && !validBlockingFindingEvidenceIds(
        value,
        evidence,
        candidatePlan,
        openedEvidenceIds,
        spanRegistry,
      ).has(evidenceId)
    );
    if (uncoveredPrimary.length) {
      issues.push({ code: "coverage_review_missing_primary_disposition", path: "/semantic_coverage", message: "Primary semantic content not covered by a final leaf or shared condition requires a separate disposition", details: { evidence_ids: uncoveredPrimary } });
    }
    const affectedItems = new Set(scope?.affected_item_ids ?? []);
    const affectedEvidence = new Set(scope?.affected_evidence_ids ?? []);
    const scopedSemanticItemIds = new Set<string>();
    for (const itemId of obligations.required_item_ids) {
      const item = finalItemById.get(itemId);
      if (!item) continue;
      scopedSemanticItemIds.add(item.item_id);
      if (item.reference_origin_item_id) scopedSemanticItemIds.add(item.reference_origin_item_id);
    }
    if (value.status === "approved") {
      for (const node of candidatePlan.semantic_evidence ?? []) {
        const explicitCarrierIds = explicitSemanticCarrierIds(node);
        const carrierItems = finalItemsCarryingFragment(
          node.evidence_id,
          node.exact_fragment,
          explicitCarrierIds,
        );
        if (scope && scope.mode !== "full") {
          const hasItemOwner = Boolean(node.materialized_item_id);
          const itemIsInScope = hasItemOwner && scopedSemanticItemIds.has(node.materialized_item_id);
          const carrierIsInScope = carrierItems.some((item) =>
            scopedSemanticItemIds.has(item.item_id)
            || scopedSemanticItemIds.has(item.reference_origin_item_id)
          );
          // Physical evidence atoms are deliberately broad. An ownerless node
          // already carried by a final leaf or applied shared rule follows that
          // leaf's narrow scope; sharing the same atom cannot pull unrelated
          // leaves or table labels into the current review.
          const ownerlessSharedMeaningIsInScope = !hasItemOwner && (
            carrierItems.length > 0 ? carrierIsInScope : affectedEvidence.has(node.evidence_id)
          );
          if (!itemIsInScope && !ownerlessSharedMeaningIsInScope) continue;
        }
        const coveredByExactBinding = coverageBindings.some((binding) =>
          binding.evidence_id === node.evidence_id
          && fragmentsOverlap(binding.exact_fragment, node.exact_fragment)
        );
        const coveredByReviewedCarrier = carrierItems.some((item) =>
          itemCoverageCount.get(item.item_id) === 1
        );
        // A final-leaf record reviews the final judgment once. Its compiled
        // provenance mechanically covers the owned semantic nodes and applied
        // shared rule fragments; the model need not duplicate one record per
        // semantic node. Truly unowned primary meaning still needs an explicit
        // shared/irrelevant disposition below.
        const covered = coveredByExactBinding || coveredByReviewedCarrier;
        if (!covered) {
          const ownedItem = carrierItems[0] ?? finalItemById.get(node.materialized_item_id);
          issues.push({
            code: "coverage_review_candidate_semantic_gap",
            path: "/semantic_coverage",
            message: "Every in-scope candidate semantic source node must be bound by a final-leaf or uncovered-primary review record",
            details: {
              semantic_id: node.semantic_id,
              evidence_id: node.evidence_id,
              materialized_item_id: node.materialized_item_id,
              action: "add_exact_binding_to_the_scoped_leaf_or_add_shared_disposition",
              allowed_bindings: ownedItem
                ? itemAllowedBindings(
                    ownedItem,
                    candidateItemById.get(ownedItem.reference_origin_item_id) ?? candidateItemById.get(ownedItem.item_id),
                    candidatePlan,
                    evidence,
                  )
                : [{ evidence_id: node.evidence_id, exact_fragment_candidates: [node.exact_fragment] }],
            },
          });
        }
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  const review = value as unknown as DomainCoverageReview;
  return { ok: true, issues: [], review, fingerprint: sha256Json(review) };
}

function fragmentsOverlap(left: string, right: string): boolean {
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function materializedItemCarriesFragment(
  item: MaterializedAcceptanceItem,
  candidateItem: SemanticSourcePlan["acceptance_items"][number] | undefined,
  candidatePlan: SemanticSourcePlan,
  evidenceId: string,
  exactFragment: string,
): boolean {
  const provenance = itemProvenanceFragments(item, candidateItem, candidatePlan);
  const itemEvidence = new Set([
    ...item.evidence_ids,
    ...item.reference_evidence_ids,
    ...item.sampling.evidence_ids,
    ...provenance.map((fragment) => fragment.evidence_id),
  ]);
  if (!itemEvidence.has(evidenceId)) return false;
  if ([item.name, item.requirement, item.method, item.quantity, item.note]
    .filter(Boolean)
    .some((value) => fragmentsOverlap(value, exactFragment))) return true;
  return provenance
    .some((fragment) => fragment.evidence_id === evidenceId && fragmentsOverlap(fragment.text, exactFragment));
}

function itemProvenanceFragments(
  item: MaterializedAcceptanceItem,
  candidateItem: SemanticSourcePlan["acceptance_items"][number] | undefined,
  candidatePlan: SemanticSourcePlan,
): Array<{ evidence_id: string; text: string }> {
  const fragments: Array<{ evidence_id: string; text: string }> = [];
  if (candidateItem) {
    for (const binding of Object.values(candidateItem.field_bindings)) {
      fragments.push(...binding.source_fragments);
    }
    if (candidateItem.table_semantics) {
      fragments.push(...candidateItem.table_semantics.cell_evidence);
      for (const branch of candidateItem.table_semantics.acceptance_branches ?? []) {
        fragments.push(...branch.condition_fragments);
        fragments.push(...branch.requirement_fragments);
        fragments.push(...branch.allowed_value_fragments);
      }
      fragments.push(...candidateItem.table_semantics.reference_fragments);
    }
  }
  const itemIds = new Set([item.item_id, item.reference_origin_item_id].filter(Boolean));
  for (const node of candidatePlan.semantic_evidence ?? []) {
    if (itemIds.has(node.materialized_item_id)) {
      fragments.push({ evidence_id: node.evidence_id, text: node.exact_fragment });
    }
  }
  const semanticNodeById = new Map(
    (candidatePlan.semantic_evidence ?? []).map((node) => [node.semantic_id, node]),
  );
  for (const reference of candidatePlan.semantic_references ?? []) {
    if (reference.status !== "resolved") continue;
    if (!reference.destination_bindings.some((binding) =>
      itemIds.has(binding.item_id) && binding.fields.length > 0
    )) continue;
    for (const semanticId of [reference.anchor_semantic_id, ...reference.target_semantic_ids]) {
      const node = semanticNodeById.get(semanticId);
      if (
        node
        && (
          semanticId === reference.anchor_semantic_id
          || !node.materialized_item_id
          || itemIds.has(node.materialized_item_id)
        )
      ) fragments.push({ evidence_id: node.evidence_id, text: node.exact_fragment });
    }
  }
  const appliedRuleIds = new Set(item.sampling.rule_ids ?? []);
  const appliedBranchIds = new Set(item.sampling.branch_ids ?? []);
  for (const rule of candidatePlan.shared_sampling_rules ?? []) {
    if (!appliedRuleIds.has(rule.rule_id)) continue;
    for (const component of rule.components ?? []) {
      fragments.push(...(component.source_fragments ?? []));
    }
    for (const condition of rule.shared_conditions) {
      fragments.push({ evidence_id: condition.evidence_id, text: condition.exact_fragment });
    }
    for (const branch of rule.branches) {
      if (appliedBranchIds.size > 0 && !appliedBranchIds.has(branch.branch_id)) continue;
      for (const component of branch.components ?? []) {
        fragments.push(...(component.source_fragments ?? []));
      }
      fragments.push({ evidence_id: branch.evidence_id, text: branch.exact_fragment });
      for (const condition of branch.conditions ?? []) {
        fragments.push({ evidence_id: condition.evidence_id, text: condition.exact_fragment });
      }
    }
  }
  return fragments;
}

function itemAllowedBindings(
  item: MaterializedAcceptanceItem,
  candidateItem: SemanticSourcePlan["acceptance_items"][number] | undefined,
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
): Array<{ evidence_id: string; exact_fragment_candidates: string[] }> {
  const recordById = new Map(evidence.evidence.map((record) => [record.evidence_id, record]));
  const byEvidenceId = new Map<string, string[]>();
  const provenance = itemProvenanceFragments(item, candidateItem, candidatePlan);
  const allowedEvidenceIds = new Set([
    ...finalItemEvidenceIds(item),
    ...provenance.map((fragment) => fragment.evidence_id),
  ]);
  for (const fragment of provenance) {
    const record = recordById.get(fragment.evidence_id);
    if (!record || !fragment.text || !record.text.includes(fragment.text)) continue;
    const candidates = byEvidenceId.get(fragment.evidence_id) ?? [];
    if (!candidates.includes(fragment.text) && candidates.length < 5) candidates.push(fragment.text);
    byEvidenceId.set(fragment.evidence_id, candidates);
  }
  for (const evidenceId of allowedEvidenceIds) {
    const record = recordById.get(evidenceId);
    if (!record) continue;
    const candidates = byEvidenceId.get(evidenceId) ?? [];
    for (const value of [item.name, item.requirement, item.method, item.quantity, item.note]) {
      if (!value || !record.text.includes(value) || candidates.includes(value) || candidates.length >= 5) continue;
      candidates.push(value);
    }
    byEvidenceId.set(evidenceId, candidates);
  }
  return [...allowedEvidenceIds].sort().map((evidenceId) => ({
    evidence_id: evidenceId,
    exact_fragment_candidates: byEvidenceId.get(evidenceId) ?? [],
  }));
}

function compactCandidateInventory(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  scope: CoverageReviewScope,
  cursorValue: unknown,
  maxItemsValue: unknown,
): ToolResponse {
  const result = materialize(candidatePlan, evidence, planFingerprint).result;
  const obligations = coverageReviewObligations(evidence, candidatePlan, scope);
  const requiredItemIds = new Set(obligations.required_item_ids);
  const allLeaves = result.inspection_lots.flatMap((lot) => lot.items.map((item) => ({
    ordinal: 0,
    item_id: item.item_id,
    lot_id: lot.lot_id,
    name: navigationPreview(item.name),
    source_clause: navigationPreview(item.source_clause),
    category: item.category,
    inspection_data_type: item.inspection_data_type,
    reference_origin_item_id: item.reference_origin_item_id || null,
    has_reference_path: item.reference_path.length > 0,
    has_table_semantics: item.table_semantics !== null,
    sampling_status: item.sampling.status,
    evidence_count: finalItemEvidenceIds(item).size,
    semantic_fingerprint: sha256Json(item),
    required_in_current_scope: requiredItemIds.has(item.item_id),
  })));
  const leaves = scope.mode !== "full"
    ? allLeaves.filter((leaf) => leaf.required_in_current_scope)
    : allLeaves;
  const counts = {
    total_leaf_count: allLeaves.length,
    scoped_leaf_count: leaves.length,
    out_of_scope_leaf_count: allLeaves.length - leaves.length,
    total_table_leaf_count: allLeaves.filter((leaf) => leaf.has_table_semantics).length,
    inventory_scope: "current_review_scope",
  };
  leaves.forEach((leaf, ordinal) => { leaf.ordinal = ordinal; });
  if (typeof cursorValue !== "number" || !Number.isInteger(cursorValue) || cursorValue < 0 || cursorValue > leaves.length) {
    return {
      ok: false,
      error: "coverage_candidate_inventory_cursor_invalid",
      cursor: cursorValue,
      ...counts,
      action: "restart_from_cursor_zero_or_use_the_previous_next_cursor",
    };
  }
  if (typeof maxItemsValue !== "number" || !Number.isInteger(maxItemsValue) || maxItemsValue < 1 || maxItemsValue > MAX_CANDIDATE_INVENTORY_ITEMS) {
    return {
      ok: false,
      error: "coverage_candidate_inventory_batch_limit",
      max_items: MAX_CANDIDATE_INVENTORY_ITEMS,
      action: "request_between_one_and_128_compact_inventory_rows",
    };
  }
  const cursor = cursorValue;
  const maxItems = maxItemsValue;
  const inventoryFingerprint = sha256Json(leaves.map((leaf) => ({
    item_id: leaf.item_id,
    semantic_fingerprint: leaf.semantic_fingerprint,
  })));
  const base = {
    ok: true,
    schema_version: "coverage-candidate-inventory/v2",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    inventory_fingerprint: inventoryFingerprint,
    review_scope: scope,
    ...counts,
    required_leaf_count: obligations.required_item_ids.length,
    uncovered_primary_evidence_count: obligations.uncovered_primary_evidence_ids.length,
    handled_context_evidence_count: obligations.handled_context_evidence_ids.length,
    handled_ignored_evidence_count: obligations.handled_ignored_evidence_ids.length,
    page: {
      cursor,
      returned_count: 0,
      next_cursor: null as number | null,
      complete: cursor === leaves.length,
    },
    leaves: [] as typeof leaves,
    // Preserve the old response keys as inert compatibility markers. They no
    // longer contain the source plan or materialized result.
    content: "compact inventory only; use leaves and read_candidate_leaf_details",
    materialized_result: { inspection_lots: [] as never[] },
    instruction: "total_leaf_count describes the FULL candidate; leaves and page.complete describe ONLY the current review scope. Out-of-scope items still exist and must not be reported missing merely because this list omits them. Counts prove inventory presence, not semantic correctness. Preview fields are neutral navigation only; page through this scope and use read_candidate_leaf_details for exact values and provenance.",
  };
  const pageLeaves: typeof leaves = [];
  const limit = Math.min(leaves.length, cursor + maxItems);
  for (let index = cursor; index < limit; index += 1) {
    const candidateLeaves = [...pageLeaves, leaves[index]!];
    const candidate = {
      ...base,
      page: {
        cursor,
        returned_count: candidateLeaves.length,
        next_cursor: index + 1 < leaves.length ? index + 1 : null,
        complete: index + 1 >= leaves.length,
      },
      leaves: candidateLeaves,
    };
    if (serializedBytes(candidate) > MAX_COVERAGE_READ_BYTES) break;
    pageLeaves.push(leaves[index]!);
  }
  if (pageLeaves.length === 0 && cursor < leaves.length) {
    return {
      ok: false,
      error: "coverage_candidate_inventory_record_exceeds_limit",
      item_id: leaves[cursor]!.item_id,
      serialized_bytes: serializedBytes({ ...base, leaves: [leaves[cursor]!] }),
      max_serialized_bytes: MAX_COVERAGE_READ_BYTES,
      action: "report_a_harness_contract_defect_without_skipping_or_truncating_the_leaf",
    };
  }
  const nextCursor = cursor + pageLeaves.length < leaves.length ? cursor + pageLeaves.length : null;
  const output: ToolResponse = {
    ...base,
    page: {
      cursor,
      returned_count: pageLeaves.length,
      next_cursor: nextCursor,
      complete: nextCursor === null,
    },
    leaves: pageLeaves,
  };
  if (serializedBytes(output) > MAX_COVERAGE_READ_BYTES) {
    return {
      ok: false,
      error: "coverage_candidate_inventory_size_limit_internal",
      max_serialized_bytes: MAX_COVERAGE_READ_BYTES,
    };
  }
  return output;
}

function candidateLeafDetailContext(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
) {
  const result = materialize(candidatePlan, evidence, planFingerprint).result;
  const materializedById = new Map(result.inspection_lots.flatMap((lot) =>
    lot.items.map((item) => [item.item_id, { lot_id: lot.lot_id, item }] as const)
  ));
  const sourceItemById = new Map(candidatePlan.acceptance_items.map((item) => [item.item_id, item]));
  const semanticNodeById = new Map(
    (candidatePlan.semantic_evidence ?? []).map((node) => [node.semantic_id, node]),
  );
  const inventoryFingerprint = sha256Json(result.inspection_lots.flatMap((lot) =>
    lot.items.map((item) => ({ item_id: item.item_id, semantic_fingerprint: sha256Json(item) }))
  ));
  return { result, materializedById, sourceItemById, semanticNodeById, inventoryFingerprint };
}

type CandidateLeafDetailContext = ReturnType<typeof candidateLeafDetailContext>;

const RELATED_CONTEXT_INSTRUCTION = "只读关联上下文，不扩大本轮审核或修改范围。同一条原文可以由多个独立验收项共同承接；先核对各项实际承接的内容，再判断遗漏，不能要求当前一项重复包含整条原文。分页读到 next_cursor=null；相关项存在不等于语义正确，仍须依据原文判断。引用正文仍走专用引用工具，不由本工具展开。";

function relatedCandidateEntries(context: CandidateLeafDetailContext, plan: SemanticSourcePlan, itemId: string) {
  const sourceIds = (item: MaterializedAcceptanceItem): Set<string> => {
    const origin = item.reference_origin_item_id || item.item_id;
    const source = context.sourceItemById.get(origin);
    return new Set([
      ...(source?.field_bindings.requirement.source_fragments ?? []).map((fragment) => fragment.evidence_id),
      ...(plan.semantic_evidence ?? []).filter((node) => node.role === "acceptance_item"
        && (node.materialized_item_id === origin || node.materialized_item_id === item.item_id))
        .map((node) => node.evidence_id),
    ]);
  };
  const anchor = context.materializedById.get(itemId);
  if (!anchor) return [];
  const anchorSources = sourceIds(anchor.item);
  return [...context.materializedById.values()].filter((entry) => entry.item.item_id !== itemId
    && entry.lot_id === anchor.lot_id
    && [...sourceIds(entry.item)].some((id) => anchorSources.has(id)));
}

function relatedContextRecords(context: CandidateLeafDetailContext, plan: SemanticSourcePlan, itemId: string) {
  const entries = relatedCandidateEntries(context, plan, itemId);
  const records = entries.flatMap(({ item }) => {
    // Do not expose expanded reference bodies through a context-only shortcut.
    const referenceOnly = (item.reference_resolution_ids?.length ?? 0) > 0 || (item.reference_path?.length ?? 0) > 0;
    const fields = referenceOnly ? ["name"] as const : ["name", "category", "requirement", "method", "quantity", "note"] as const;
    return fields.flatMap((field) => {
      const points = Array.from(item[field] ?? "");
      const chunks: Array<Record<string, unknown>> = [];
      for (let start = 0; start < Math.max(1, points.length); start += 4096) {
        chunks.push({ item_id: item.item_id, name: navigationPreview(item.name), field,
          text: points.slice(start, start + 4096).join(""), start_code_point: start, total_code_points: points.length,
          source_clause: navigationPreview(item.source_clause), context_only: true, reference_content_omitted: referenceOnly });
      }
      return chunks;
    });
  });
  return { entries, records, fingerprint: sha256Json({ plan: plan, anchor_item_id: itemId, records }) };
}

function relatedContextIssue(itemId: string, nextCursor: number, total: number): Record<string, unknown> {
  return {
    code: "coverage_related_context_incomplete", item_id: itemId, next_cursor: nextCursor, total_records: total,
    writable_collection: "findings", path: "/finding_upserts", candidate_read_tool: "read_candidate_related_context",
    required_action: "Read all related-context pages for this item, then retain only a source-proven defect or remove its finding with finding_remove_ids and stage_coverage_review_draft.",
    instruction: `${RELATED_CONTEXT_INSTRUCTION} 不得修改候选计划或给范围外项目新增审核记录。`,
  };
}

/**
 * A placeholder deliberately has no item destination, so destination-based
 * filtering cannot make it visible to Coverage. Relate it deterministically
 * either to a materialized row of the referenced table or to the source item
 * whose exact field provenance still contains this occurrence literal.
 */
export function coverageReferencePlaceholderDetailsForItem(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  semanticItemIds: ReadonlySet<string>,
  sourcePlanItem: SemanticSourcePlan["acceptance_items"][number] | undefined,
) {
  const occurrenceById = new Map(evidence.reference_occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const normalizedTableId = (value: string): string => value.replace(/^表\s*/u, "").replace(/\s+/gu, "").trim();
  const sourceCarriesOccurrence = (occurrence: EvidenceManifest["reference_occurrences"][number]): boolean => (
    Boolean(sourcePlanItem) && (
      referenceOccurrenceOriginEvidenceIds(occurrence).every((originEvidenceId) =>
        sourcePlanItem!.evidence_ids.includes(originEvidenceId)
        || Object.values(sourcePlanItem!.field_bindings).some((binding) =>
          (binding.source_fragments ?? []).some((fragment) => fragment.evidence_id === originEvidenceId)
        )
      )
    )
  );
  return candidatePlan.reference_resolutions.flatMap((resolution) => {
    if (resolution.application_mode !== "reference_placeholder") return [];
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    if (!occurrence || occurrence.status !== "resolved") return [];
    const targetTableId = occurrence.reference_kind === "table"
      ? normalizedTableId(occurrence.target_table_id)
      : "";
    const materializedItemIds = candidatePlan.acceptance_items
      .filter((candidate) => occurrence.reference_kind === "table"
        ? candidate.table_semantics !== null
          && normalizedTableId(candidate.table_semantics.table_no) === targetTableId
        : resolution.target_evidence_ids.some((evidenceId) => candidate.evidence_ids.includes(evidenceId)))
      .map((candidate) => candidate.item_id);
    const materializedEvidenceIds = new Set(candidatePlan.acceptance_items
      .filter((candidate) => materializedItemIds.includes(candidate.item_id))
      .flatMap((candidate) => candidate.evidence_ids));
    const closureComplete = occurrence.reference_kind === "table"
      ? materializedItemIds.length > 0
      : resolution.target_evidence_ids.length > 0
        && resolution.target_evidence_ids.every((evidenceId) => materializedEvidenceIds.has(evidenceId));
    if (!materializedItemIds.some((candidate) => semanticItemIds.has(candidate)) && !sourceCarriesOccurrence(occurrence)) {
      return [];
    }
    const identity = documentReferenceTargetReadIdentity(occurrence);
    return [{
      resolution_id: resolution.resolution_id,
      occurrence_id: occurrence.occurrence_id,
      application_mode: resolution.application_mode,
      raw_reference: occurrence.raw_reference,
      normalized_reference: occurrence.normalized_reference ?? occurrence.raw_reference,
      origin_evidence_id: occurrence.origin_evidence_id,
      origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
      reference_literal_span_id: occurrence.reference_literal_span_id ?? null,
      reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
      reference_kind: occurrence.reference_kind,
      target_table_id: occurrence.reference_kind === "table" ? occurrence.target_table_id : "",
      target_key: identity.target_key,
      target_locator: identity.target_locator,
      target_evidence_count: resolution.target_evidence_ids.length,
      target_evidence_fingerprint: sha256Json(resolution.target_evidence_ids),
      destination_bindings: resolution.destination_bindings,
      materialized_item_ids: materializedItemIds,
      closure_status: closureComplete ? "materialized" : "missing_materialized_target",
      reason: resolution.reason,
    }];
  });
}

/**
 * Coverage must review a resolved reference through the exact occurrence and
 * compiled destination field. Reading the full target is investigation only;
 * it never grants permission to import unrelated fields from that clause.
 */
export function coverageFieldScopedReferenceRoutesForItem(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  semanticItemIds: ReadonlySet<string>,
) {
  const occurrenceById = new Map(
    evidence.reference_occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]),
  );
  return candidatePlan.reference_resolutions.flatMap((resolution) => {
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    if (!occurrence) return [];
    const identity = documentReferenceTargetReadIdentity(occurrence);
    return resolution.destination_bindings.flatMap((binding) => {
      if (!semanticItemIds.has(binding.item_id)) return [];
      const routeConsistent = binding.target_field !== "reference_only"
        && occurrence.origin_fields.includes(binding.target_field);
      return [{
        resolution_id: resolution.resolution_id,
        occurrence_id: occurrence.occurrence_id,
        origin_evidence_id: occurrence.origin_evidence_id,
        origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
        reference_literal_span_id: occurrence.reference_literal_span_id ?? null,
        reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
        raw_reference: occurrence.raw_reference,
        normalized_reference: occurrence.normalized_reference ?? occurrence.raw_reference,
        target_key: identity.target_key,
        target_locator: identity.target_locator,
        application_mode: resolution.application_mode,
        registered_origin_fields: occurrence.origin_fields,
        authoritative_target_field: routeConsistent ? binding.target_field : null,
        route_consistency: routeConsistent ? "exact" : "origin_field_mismatch",
        import_scope: resolution.import_scope,
        instruction: routeConsistent
          ? "Keep this occurrence in authoritative_target_field and independently audit whether the Agent-authored import_scope matches the local reference meaning. Every actual imported field must remain inside import_scope.allowed_fields."
          : "Do not guess or import referenced content. Report a reference route defect because the compiled destination does not match the occurrence's registered origin field.",
      }];
    });
  });
}

function buildCandidateLeafDetail(
  context: CandidateLeafDetailContext,
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  openedEvidenceIds: ReadonlySet<string>,
  referencePolicies: ReadonlyMap<string, ReferenceAnalysisPolicy>,
  itemId: string,
) {
  const entry = context.materializedById.get(itemId)!;
  const item = entry.item;
  const semanticItemIds = new Set([item.item_id, item.reference_origin_item_id]
    .filter((id): id is string => typeof id === "string" && id.length > 0));
  const sourcePlanItem = context.sourceItemById.get(item.reference_origin_item_id ?? "")
    ?? context.sourceItemById.get(item.item_id);
  const references = (candidatePlan.semantic_references ?? []).filter((reference) =>
    reference.destination_bindings.some((binding) => semanticItemIds.has(binding.item_id))
  );
  const occurrenceById = new Map(evidence.reference_occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const referenceResolutions = candidatePlan.reference_resolutions.filter((resolution) =>
    resolution.destination_bindings.some((binding) => semanticItemIds.has(binding.item_id))
  );
  const referenceTargets = [...new Map(referenceResolutions.flatMap((resolution) => {
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    if (!occurrence || occurrence.status !== "resolved") return [];
    const identity = documentReferenceTargetReadIdentity(occurrence);
    const policy = referencePolicies.get(identity.target_key);
    if (!policy) throw new Error(`Coverage reference policy is missing: ${identity.target_key}`);
    return [[identity.target_key, {
      occurrence_id: occurrence.occurrence_id,
      target_key: identity.target_key,
      target_locator: identity.target_locator,
      evidence_count: identity.target_evidence_count,
      fingerprint: identity.target_fingerprint,
      analysis_mode: policy.analysis_mode,
      target_text_utf8_bytes: policy.target_text_utf8_bytes,
      estimated_compact_page_count: policy.estimated_compact_page_count,
      read_tool: policy.analysis_mode === "isolated" ? "read_reference_facts" : "read_document_reference_evidence",
    }] as const];
  })).values()];
  const referencedEvidenceIds = new Set(referenceResolutions.flatMap((resolution) =>
    occurrenceById.get(resolution.occurrence_id)?.target_evidence_ids ?? []
  ));
  const applicableReferencePlaceholders = coverageReferencePlaceholderDetailsForItem(
    candidatePlan,
    evidence,
    semanticItemIds,
    sourcePlanItem,
  );
  const fieldScopedReferenceRoutes = coverageFieldScopedReferenceRoutesForItem(
    candidatePlan,
    evidence,
    semanticItemIds,
  );
  const referencedSemanticIds = new Set(references.flatMap((reference) => [
    reference.anchor_semantic_id,
    ...reference.target_semantic_ids,
  ]));
  const semanticEvidence = (candidatePlan.semantic_evidence ?? []).filter((node) =>
    (semanticItemIds.has(node.materialized_item_id) || referencedSemanticIds.has(node.semantic_id))
    && !referencedEvidenceIds.has(node.evidence_id)
  );
  const appliedRuleIds = new Set(item.sampling.rule_ids ?? []);
  const sharedSamplingRules = (candidatePlan.shared_sampling_rules ?? []).filter((rule) =>
    appliedRuleIds.has(rule.rule_id) || rule.receiving_item_ids.some((id) => semanticItemIds.has(id))
  );
  const samplingComponentProvenance = sharedSamplingRules.map((rule) => ({
    rule_id: rule.rule_id,
    shared_components: (rule.components ?? []).map((component) => ({
      key: component.key,
      role: component.role,
      disposition: component.disposition,
      source_fragments: component.source_fragments ?? [],
    })),
    applied_branches: rule.branches
      .filter((branch) => (item.sampling.branch_ids ?? []).includes(branch.branch_id))
      .map((branch) => ({
        branch_id: branch.branch_id,
        components: (branch.components ?? []).map((component) => ({
          key: component.key,
          role: component.role,
          disposition: component.disposition,
          source_fragments: component.source_fragments ?? [],
        })),
      })),
  }));
  for (const rule of sharedSamplingRules) {
    const source = context.semanticNodeById.get(rule.source_semantic_id);
    if (source && !semanticEvidence.some((node) => node.semantic_id === source.semantic_id)) {
      semanticEvidence.push(source);
    }
  }
  const allowedBindings = itemAllowedBindings(item, sourcePlanItem, candidatePlan, evidence)
    .filter((binding) => !referencedEvidenceIds.has(binding.evidence_id));
  const evidenceIds = new Set([
    ...finalItemEvidenceIds(item),
    ...allowedBindings.map((binding) => binding.evidence_id),
  ]);
  const fieldDigest = (value: string) => ({ sha256: sha256Text(value), utf8_bytes: Buffer.byteLength(value, "utf8") });
  const hasIsolatedReference = referenceTargets.some(target => target.analysis_mode === "isolated");
  const compactReferencedLeaf = hasIsolatedReference ? {
    item_id: item.item_id,
    lot_id: entry.lot_id,
    name: item.name,
    category: item.category,
    inspection_data_type: item.inspection_data_type,
    inspection_data_type_reason: item.inspection_data_type_reason,
    field_digests: {
      requirement: fieldDigest(item.requirement),
      method: fieldDigest(item.method),
      quantity: fieldDigest(item.quantity),
      note: fieldDigest(item.note),
    },
    sampling: item.sampling,
    reference_content_mode: "sealed_reference_facts",
  } : item;
  const compactSourcePlanItem = hasIsolatedReference && sourcePlanItem ? {
    item_id: sourcePlanItem.item_id,
    lot_id: sourcePlanItem.lot_id,
    name: sourcePlanItem.name,
    category: sourcePlanItem.category,
    reference_content_mode: "sealed_reference_facts",
  } : sourcePlanItem ?? null;
  const detail = {
    item_id: item.item_id,
    lot_id: entry.lot_id,
    parent_lot: (() => {
      const lot = candidatePlan.inspection_lots.find(lot => lot.lot_id === entry.lot_id);
      return lot ? { lot_id: lot.lot_id, name: lot.name, evidence_ids: lot.evidence_ids,
        instruction: "This is the actual parent grouping shown with the leaf. Compare its source-backed object/scope before alleging a missing qualifier in the child. A qualifier clearly preserved by this parent need not be duplicated in every child field. A generic grouping label does not substitute for missing numerical or conditional rules." } : null;
    })(),
    related_context: {
      related_leaf_count: relatedCandidateEntries(context, candidatePlan, itemId).length,
      read_tool: "read_candidate_related_context",
      item_id: itemId,
      instruction: RELATED_CONTEXT_INSTRUCTION,
    },
    materialized_leaf: compactReferencedLeaf,
    delivery_investigation_hints: deliveryInvestigationHints(item,
      relatedCandidateEntries(context, candidatePlan, itemId).map(entry => entry.item), evidence.evidence),
    source_plan_item: compactSourcePlanItem,
    acceptance_branch_contract: item.table_semantics?.acceptance_branches ?? [],
    reference_targets: referenceTargets,
    field_scoped_reference_routes: fieldScopedReferenceRoutes,
    applicable_reference_placeholders: applicableReferencePlaceholders,
    applicable_semantic_evidence: semanticEvidence,
    applicable_semantic_references: references,
    applicable_shared_sampling_rules: sharedSamplingRules,
    sampling_component_provenance: samplingComponentProvenance,
    allowed_bindings: allowedBindings,
    evidence_ids_requiring_open: [...evidenceIds]
      .filter((evidenceId) => !openedEvidenceIds.has(evidenceId) && !referencedEvidenceIds.has(evidenceId))
      .sort(),
  };
  return { ...detail, detail_fingerprint: sha256Json(detail) };
}

/** Exact business values first; the verbose compiler graph remains available with view=full. */
function candidateBusinessDetail(detail: ReturnType<typeof buildCandidateLeafDetail>) {
  const leaf = detail.materialized_leaf as unknown as Record<string, unknown>;
  const fields = ["item_id", "lot_id", "name", "category", "requirement", "method", "quantity", "note",
    "source_clause", "reference_source_clause", "inspection_data_type", "sampling",
    "field_digests", "reference_content_mode"];
  const materialized = Object.fromEntries(fields.filter(key => key in leaf).map(key => [key, leaf[key]]));
  const table = isRecord(leaf.table_semantics) ? leaf.table_semantics : undefined;
  if (table) materialized.table_semantics = Object.fromEntries(Object.entries(table).filter(([key]) => key !== "cell_evidence"));
  return {
    item_id: detail.item_id, lot_id: detail.lot_id, parent_lot: detail.parent_lot,
    materialized_leaf: materialized, detail_fingerprint: detail.detail_fingerprint,
    related_context: detail.related_context, delivery_investigation_hints: detail.delivery_investigation_hints,
    acceptance_branch_contract: detail.acceptance_branch_contract,
    reference_targets: detail.reference_targets, field_scoped_reference_routes: detail.field_scoped_reference_routes,
    applicable_reference_placeholders: detail.applicable_reference_placeholders,
    allowed_bindings: detail.allowed_bindings,
    evidence_ids_requiring_open: detail.evidence_ids_requiring_open,
    provenance_read: { tool: "read_candidate_leaf_details", item_ids: [detail.item_id], view: "full" },
  };
}

interface CandidateTextRegistryEntry {
  text_ref: string;
  sha256: string;
  utf8_bytes: number;
  code_points: number;
  occurrence_count: number;
  text: string;
}

function compactCandidateDetailText(
  value: unknown,
  registry: Map<string, CandidateTextRegistryEntry>,
): unknown {
  if (typeof value === "string") {
    const utf8Bytes = Buffer.byteLength(value, "utf8");
    // This threshold selects only the wire representation (inline versus an
    // exact content-addressed reference). It never classifies business meaning,
    // changes the authoritative value, or removes provenance.
    if (utf8Bytes < CANDIDATE_DETAIL_TEXT_REFERENCE_MIN_BYTES) return value;
    const sha256 = sha256Text(value);
    const textRef = `text:${sha256}`;
    const existing = registry.get(textRef);
    if (existing) {
      if (existing.text !== value) throw new Error("Candidate text reference hash collision");
      existing.occurrence_count += 1;
    } else {
      registry.set(textRef, {
        text_ref: textRef,
        sha256,
        utf8_bytes: utf8Bytes,
        code_points: [...value].length,
        occurrence_count: 1,
        text: value,
      });
    }
    const entry = registry.get(textRef)!;
    return {
      $text_ref: entry.text_ref,
      sha256: entry.sha256,
      utf8_bytes: entry.utf8_bytes,
      code_points: entry.code_points,
    };
  }
  if (Array.isArray(value)) return value.map((entry) => compactCandidateDetailText(entry, registry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    compactCandidateDetailText(entry, registry),
  ]));
}

function candidateTextRegistryMetadata(registry: Map<string, CandidateTextRegistryEntry>) {
  return [...registry.values()]
    .map(({ text: _text, ...metadata }) => metadata)
    .sort((left, right) => left.text_ref.localeCompare(right.text_ref));
}

type CandidateLeafDetail = ReturnType<typeof buildCandidateLeafDetail>;

interface CandidateSectionRegistryEntry {
  section_ref: string;
  section_id: string;
  path: string;
  kind: "array" | "object" | "scalar";
  section_sha256: string;
  utf8_bytes: number;
  unit_count: number;
  value: unknown;
}

interface CandidateSectionRegistry {
  candidate_snapshot_id: string;
  item_id: string;
  entries_by_ref: Map<string, CandidateSectionRegistryEntry>;
  entries_by_path: Map<string, CandidateSectionRegistryEntry>;
  top_level_entries: CandidateSectionRegistryEntry[];
}

const CANDIDATE_LEAF_DETAIL_SECTION_KEYS = [
  "materialized_leaf",
  "delivery_investigation_hints",
  "parent_lot",
  "source_plan_item",
  "acceptance_branch_contract",
  "reference_targets",
  "field_scoped_reference_routes",
  "applicable_reference_placeholders",
  "applicable_semantic_evidence",
  "applicable_semantic_references",
  "applicable_shared_sampling_rules",
  "sampling_component_provenance",
  "allowed_bindings",
] as const;

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function candidateSectionKind(value: unknown): CandidateSectionRegistryEntry["kind"] {
  return Array.isArray(value) ? "array" : isRecord(value) ? "object" : "scalar";
}

function candidateSectionIdForPath(path: string): string {
  return path.replace(/^\//u, "").replaceAll("/", ".") || "root";
}

function candidateSectionReference(entry: CandidateSectionRegistryEntry): Record<string, unknown> {
  return {
    $section_ref: entry.section_ref,
    section_id: entry.section_id,
    kind: entry.kind,
    unit_count: entry.unit_count,
    utf8_bytes: entry.utf8_bytes,
    sha256: entry.section_sha256,
  };
}

function createCandidateSectionRegistry(
  detail: CandidateLeafDetail,
  planFingerprint: string,
  evidence: EvidenceManifest,
  inventoryFingerprint: string,
): CandidateSectionRegistry {
  const { evidence_ids_requiring_open: _openedEvidenceIds, detail_fingerprint: _detailFingerprint, ...snapshotDetail } = detail;
  const candidateSnapshotId = `candidate:${sha256Json({
    schema_version: "coverage-candidate-snapshot/v1",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    inventory_fingerprint: inventoryFingerprint,
    item_id: detail.item_id,
    candidate_detail_fingerprint: sha256Json(snapshotDetail),
  })}`;
  const entriesByRef = new Map<string, CandidateSectionRegistryEntry>();
  const entriesByPath = new Map<string, CandidateSectionRegistryEntry>();
  const register = (path: string, value: unknown): CandidateSectionRegistryEntry => {
    const existing = entriesByPath.get(path);
    if (existing) return existing;
    const sectionSha256 = sha256Json(value);
    const entry: CandidateSectionRegistryEntry = {
      section_ref: `section:${sha256Json({
        candidate_snapshot_id: candidateSnapshotId,
        item_id: detail.item_id,
        path,
        section_sha256: sectionSha256,
      })}`,
      section_id: candidateSectionIdForPath(path),
      path,
      kind: candidateSectionKind(value),
      section_sha256: sectionSha256,
      utf8_bytes: serializedBytes(value),
      unit_count: Array.isArray(value)
        ? value.length
        : isRecord(value)
          ? Object.keys(value).length
          : 1,
      value,
    };
    entriesByPath.set(path, entry);
    entriesByRef.set(entry.section_ref, entry);
    return entry;
  };
  const visitNested = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitNested(entry, `${path}/${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}/${jsonPointerSegment(key)}`;
      if (
        (Array.isArray(entry) || isRecord(entry))
        && serializedBytes(entry) > MAX_CANDIDATE_SECTION_PAGE_BYTES
      ) {
        register(childPath, entry);
      }
      visitNested(entry, childPath);
    }
  };
  const topLevelEntries = CANDIDATE_LEAF_DETAIL_SECTION_KEYS.map((key) => {
    const path = `/${key}`;
    const entry = register(path, detail[key]);
    visitNested(detail[key], path);
    return entry;
  });
  return {
    candidate_snapshot_id: candidateSnapshotId,
    item_id: detail.item_id,
    entries_by_ref: entriesByRef,
    entries_by_path: entriesByPath,
    top_level_entries: topLevelEntries,
  };
}

function compactCandidateSectionValue(
  value: unknown,
  path: string,
  textRegistry: Map<string, CandidateTextRegistryEntry>,
  sections: CandidateSectionRegistry,
): unknown {
  const nestedSection = sections.entries_by_path.get(path);
  if (nestedSection) return candidateSectionReference(nestedSection);
  if (typeof value === "string") return compactCandidateDetailText(value, textRegistry);
  if (Array.isArray(value)) return value.map((entry, index) => (
    compactCandidateSectionValue(entry, `${path}/${index}`, textRegistry, sections)
  ));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    compactCandidateSectionValue(entry, `${path}/${jsonPointerSegment(key)}`, textRegistry, sections),
  ]));
}

interface CandidateSectionUnit {
  unit_id: string;
  path: string;
  property?: string;
  value: unknown;
}

function candidateSectionUnits(section: CandidateSectionRegistryEntry): CandidateSectionUnit[] {
  if (Array.isArray(section.value)) {
    return section.value.map((value, index) => ({
      unit_id: `${section.section_id}:${index}`,
      path: `${section.path}/${index}`,
      value,
    }));
  }
  if (isRecord(section.value)) {
    return Object.entries(section.value).map(([key, value]) => ({
      unit_id: `${section.section_id}:${key}`,
      path: `${section.path}/${jsonPointerSegment(key)}`,
      property: key,
      value,
    }));
  }
  return [{
    unit_id: section.section_id,
    path: section.path,
    value: section.value,
  }];
}

function compactCandidateSectionUnit(
  unit: CandidateSectionUnit,
  textRegistry: Map<string, CandidateTextRegistryEntry>,
  sections: CandidateSectionRegistry,
): Record<string, unknown> {
  return {
    unit_id: unit.unit_id,
    path: unit.path,
    ...(unit.property ? { property: unit.property } : {}),
    value: compactCandidateSectionValue(unit.value, unit.path, textRegistry, sections),
  };
}

function candidateSectionPageToken(
  candidateSnapshotId: string,
  sectionRef: string,
  unitStart: number,
): string {
  return `section-page:${sha256Json({ candidate_snapshot_id: candidateSnapshotId, section_ref: sectionRef, unit_start: unitStart })}:${unitStart}`;
}

function parseCandidateSectionPageToken(
  value: unknown,
  candidateSnapshotId: string,
  sectionRef: string,
): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string") return undefined;
  const match = /^section-page:([a-f0-9]{64}):(\d+)$/u.exec(value);
  if (!match) return undefined;
  const unitStart = Number(match[2]);
  if (!Number.isSafeInteger(unitStart) || unitStart < 0) return undefined;
  return match[1] === sha256Json({
    candidate_snapshot_id: candidateSnapshotId,
    section_ref: sectionRef,
    unit_start: unitStart,
  }) ? unitStart : undefined;
}

function candidateLeafManifestDetail(
  detail: CandidateLeafDetail,
  planFingerprint: string,
  evidence: EvidenceManifest,
  inventoryFingerprint: string,
) {
  const sections = createCandidateSectionRegistry(detail, planFingerprint, evidence, inventoryFingerprint);
  const materializedLeaf: Record<string, unknown> = isRecord(detail.materialized_leaf)
    ? detail.materialized_leaf
    : {};
  return {
    registry: sections,
    detail: {
      mode: "manifest",
      candidate_snapshot_id: sections.candidate_snapshot_id,
      item_id: detail.item_id,
      lot_id: detail.lot_id,
      detail_fingerprint: detail.detail_fingerprint,
      leaf_summary: {
        name: typeof materializedLeaf.name === "string" ? materializedLeaf.name : "",
        category: typeof materializedLeaf.category === "string" ? materializedLeaf.category : "",
        inspection_data_type: typeof materializedLeaf.inspection_data_type === "string"
          ? materializedLeaf.inspection_data_type
          : "",
      },
      evidence_ids_requiring_open: detail.evidence_ids_requiring_open,
      sections: sections.top_level_entries.map((entry) => ({
        section_ref: entry.section_ref,
        section_id: entry.section_id,
        kind: entry.kind,
        unit_count: entry.unit_count,
        utf8_bytes: entry.utf8_bytes,
        sha256: entry.section_sha256,
        required_for_coverage: true,
      })),
      section_count: sections.entries_by_ref.size,
    },
  };
}

function manifestCandidateLeafDetailOutput(
  details: CandidateLeafDetail[],
  itemIds: string[],
  planFingerprint: string,
  evidence: EvidenceManifest,
  inventoryFingerprint: string,
): ToolResponse {
  return {
    ok: true,
    schema_version: "coverage-candidate-leaf-details/v3",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    inventory_fingerprint: inventoryFingerprint,
    requested_item_ids: itemIds,
    details: details.map((detail) => candidateLeafManifestDetail(
      detail,
      planFingerprint,
      evidence,
      inventoryFingerprint,
    ).detail),
    instruction: "This leaf exceeds the bounded detail response after exact text externalization. Its immutable candidate_snapshot_id binds every section_ref and page token to this exact candidate. Read every required top-level section and every nested section_ref returned by a page before staging or sealing coverage; use read_candidate_leaf_text for any $text_ref.",
  };
}

function compactCandidateLeafDetailOutput(
  details: unknown[],
  itemIds: string[],
  planFingerprint: string,
  evidence: EvidenceManifest,
  inventoryFingerprint: string,
  exactSerializedBytes: number,
): ToolResponse {
  const textRegistry = new Map<string, CandidateTextRegistryEntry>();
  const compactDetails = compactCandidateDetailText(details, textRegistry) as unknown[];
  return {
    ok: true,
    schema_version: "coverage-candidate-leaf-details/v2",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    inventory_fingerprint: inventoryFingerprint,
    requested_item_ids: itemIds,
    details: compactDetails,
    text_registry: candidateTextRegistryMetadata(textRegistry),
    exact_serialized_bytes: exactSerializedBytes,
    instruction: "This exact batch exceeded the bounded tool response, so long authoritative strings are represented by content-addressed $text_ref objects. Resolve every relevant reference with read_candidate_leaf_text; sequential chunks reconstruct the exact original string and do not alter provenance. Open every evidence resource actually cited before staging coverage.",
  };
}

function feasibleCompactCandidateDetailBatches(
  details: unknown[],
  itemIds: string[],
  planFingerprint: string,
  evidence: EvidenceManifest,
  inventoryFingerprint: string,
): { batches: string[][]; unserviceable_item_ids: string[] } {
  const batches: string[][] = [];
  const unserviceableItemIds: string[] = [];
  let currentDetails: unknown[] = [];
  let currentItemIds: string[] = [];
  for (let index = 0; index < itemIds.length; index += 1) {
    const nextDetails = [...currentDetails, details[index]];
    const nextItemIds = [...currentItemIds, itemIds[index]!];
    const exactBytes = serializedBytes({ details: nextDetails });
    const compact = compactCandidateLeafDetailOutput(
      nextDetails,
      nextItemIds,
      planFingerprint,
      evidence,
      inventoryFingerprint,
      exactBytes,
    );
    if (serializedBytes(compact) <= MAX_COVERAGE_READ_BYTES) {
      currentDetails = nextDetails;
      currentItemIds = nextItemIds;
      continue;
    }
    if (currentItemIds.length > 0) batches.push(currentItemIds);
    const singleton = compactCandidateLeafDetailOutput(
      [details[index]],
      [itemIds[index]!],
      planFingerprint,
      evidence,
      inventoryFingerprint,
      serializedBytes({ details: [details[index]] }),
    );
    if (serializedBytes(singleton) <= MAX_COVERAGE_READ_BYTES) {
      currentDetails = [details[index]];
      currentItemIds = [itemIds[index]!];
    } else {
      unserviceableItemIds.push(itemIds[index]!);
      currentDetails = [];
      currentItemIds = [];
    }
  }
  if (currentItemIds.length > 0) batches.push(currentItemIds);
  return { batches, unserviceable_item_ids: unserviceableItemIds };
}

function candidateLeafDetails(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  openedEvidenceIds: ReadonlySet<string>,
  referencePolicies: ReadonlyMap<string, ReferenceAnalysisPolicy>,
  scope: CoverageReviewScope,
  itemIdsValue: unknown,
  businessView = false,
): ToolResponse {
  if (!Array.isArray(itemIdsValue)) {
    return { ok: false, error: "coverage_candidate_detail_item_ids_required", budget_consumed: false };
  }
  const itemIds = itemIdsValue.filter((itemId): itemId is string => typeof itemId === "string");
  if (
    itemIds.length !== itemIdsValue.length
    || itemIds.length < 1
    || itemIds.length > MAX_CANDIDATE_DETAIL_ITEMS
  ) {
    return {
      ok: false,
      error: "coverage_candidate_detail_batch_limit",
      min_item_ids: 1,
      max_item_ids: MAX_CANDIDATE_DETAIL_ITEMS,
      budget_consumed: false,
      action: "request_one_to_eight_explicit_final_item_ids",
    };
  }
  if (new Set(itemIds).size !== itemIds.length) {
    return {
      ok: false,
      error: "coverage_candidate_detail_duplicate_item_ids",
      budget_consumed: false,
      action: "remove_duplicate_item_ids_and_retry",
    };
  }
  const context = candidateLeafDetailContext(candidatePlan, evidence, planFingerprint);
  const unknownItemIds = itemIds.filter((itemId) => !context.materializedById.has(itemId));
  if (unknownItemIds.length > 0) {
    return {
      ok: false,
      error: "coverage_candidate_unknown_item_ids",
      unknown_item_ids: unknownItemIds,
      budget_consumed: false,
      action: "read_the_compact_candidate_inventory_and_retry_with_registered_final_item_ids",
    };
  }
  if (scope.mode !== "full") {
    const allowed = new Set(coverageReviewObligations(evidence, candidatePlan, scope).required_item_ids);
    const outsideScope = itemIds.filter((itemId) => !allowed.has(itemId));
    if (outsideScope.length > 0) {
      return {
        ok: false,
        error: "coverage_candidate_item_outside_review_scope",
        review_scope_mode: scope.mode,
        outside_scope_item_ids: outsideScope,
        budget_consumed: false,
        action: "review_only_required_item_ids_from_the_current_coverage_contract",
        instruction: "Full detail reads are limited to required_item_ids. To check whether a same-source sibling already carries an allegedly missing requirement, call read_candidate_related_context with a REQUIRED item_id as anchor. This read-only context does not authorize reviewing or editing the sibling or candidate.",
        required_action: "Use read_candidate_plan to select a required anchor, then read_candidate_related_context; do not retry this out-of-scope detail request.",
        candidate_read_tool: "read_candidate_related_context",
        writable_collection: "none (read-only tool arguments)",
      };
    }
  }
  const fullDetails = itemIds.map((itemId) => buildCandidateLeafDetail(
    context,
    candidatePlan,
    evidence,
    openedEvidenceIds,
    referencePolicies,
    itemId,
  ));
  const details = businessView ? fullDetails.map(candidateBusinessDetail) : fullDetails;
  const output: ToolResponse = {
    ok: true,
    view: businessView ? "business" : "full",
    schema_version: "coverage-candidate-leaf-details/v1",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    inventory_fingerprint: context.inventoryFingerprint,
    requested_item_ids: itemIds,
    details,
    instruction: "These are exact deterministic final values and plan-derived provenance. Open every evidence resource actually cited before staging coverage. acceptance_branch_contract is the authoritative condition -> requirement/allowed-value mapping for one business leaf; do not request separate leaves solely as a representation preference when those branches are complete, non-overlapping, and independently evaluable. Lossless split items are also valid. Preserve branch-local sampling conditions and do not edit compiler or materializer output.",
  };
  const bytes = serializedBytes(output);
  const pageLimit = MAX_COVERAGE_READ_BYTES - (businessView ? 2048 : 0);
  if (bytes <= pageLimit) return output;
  const compactOutput = compactCandidateLeafDetailOutput(
    details,
    itemIds,
    planFingerprint,
    evidence,
    context.inventoryFingerprint,
    bytes,
  );
  const compactBytes = serializedBytes(compactOutput);
  if (compactBytes <= pageLimit) return compactOutput;
  if (businessView && itemIds.length > 1) {
    const page = candidateLeafDetails(candidatePlan, evidence, planFingerprint, openedEvidenceIds, referencePolicies, scope,
      itemIds.slice(0, Math.max(1, Math.floor(itemIds.length / 2))), true);
    if (page.ok === true) {
      const served = new Set(page.requested_item_ids as string[]);
      return { ...page, remaining_item_ids: itemIds.filter(id => !served.has(id)),
        instruction: "This page contains only requested_item_ids. Read remaining_item_ids next with view=business. Values and source bindings are exact; use view=full only for a specific provenance question. Saving a review stage preserves progress before the next fresh session." };
    }
  }
  const feasible = feasibleCompactCandidateDetailBatches(
    details,
    itemIds,
    planFingerprint,
    evidence,
    context.inventoryFingerprint,
  );
  if (feasible.unserviceable_item_ids.length > 0) {
    const manifest = manifestCandidateLeafDetailOutput(
      fullDetails,
      itemIds,
      planFingerprint,
      evidence,
      context.inventoryFingerprint,
    );
    if (serializedBytes(manifest) <= MAX_COVERAGE_READ_BYTES) return manifest;
  }
  return {
    ok: false,
    error: "coverage_candidate_compact_detail_size_limit",
    item_ids: itemIds,
    exact_serialized_bytes: bytes,
    compact_serialized_bytes: compactBytes,
    max_serialized_bytes: MAX_COVERAGE_READ_BYTES,
    recommended_item_id_batches: feasible.batches,
    unserviceable_item_ids: feasible.unserviceable_item_ids,
    budget_consumed: false,
    action: feasible.unserviceable_item_ids.length === 0
      ? "retry_the_exact_registered_item_id_batches_in_recommended_order"
      : "report_a_harness_contract_defect_only_for_the_listed_unserviceable_item_ids",
  };
}

function candidateLeafText(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  openedEvidenceIds: ReadonlySet<string>,
  referencePolicies: ReadonlyMap<string, ReferenceAnalysisPolicy>,
  scope: CoverageReviewScope,
  input: Record<string, unknown>,
): ToolResponse {
  const itemId = typeof input.item_id === "string" ? input.item_id : "";
  const textRef = typeof input.text_ref === "string" ? input.text_ref : "";
  const candidateSnapshotId = typeof input.candidate_snapshot_id === "string"
    ? input.candidate_snapshot_id
    : "";
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
  const maxCodePoints = input.max_code_points === undefined ? 4096 : Number(input.max_code_points);
  if (!itemId || !textRef) {
    return { ok: false, error: "coverage_candidate_text_reference_required", budget_consumed: false };
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    return { ok: false, error: "coverage_candidate_text_cursor_invalid", budget_consumed: false };
  }
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1 || maxCodePoints > MAX_CANDIDATE_TEXT_PAGE_CODE_POINTS) {
    return {
      ok: false,
      error: "coverage_candidate_text_page_limit",
      min_code_points: 1,
      max_code_points: MAX_CANDIDATE_TEXT_PAGE_CODE_POINTS,
      budget_consumed: false,
    };
  }
  const context = candidateLeafDetailContext(candidatePlan, evidence, planFingerprint);
  if (!context.materializedById.has(itemId)) {
    return {
      ok: false,
      error: "coverage_candidate_unknown_item_ids",
      unknown_item_ids: [itemId],
      budget_consumed: false,
      action: "read_the_compact_candidate_inventory_and_retry_with_a_registered_final_item_id",
    };
  }
  if (scope.mode !== "full") {
    const allowed = new Set(coverageReviewObligations(evidence, candidatePlan, scope).required_item_ids);
    if (!allowed.has(itemId)) {
      return {
        ok: false,
        error: "coverage_candidate_item_outside_review_scope",
        review_scope_mode: scope.mode,
        outside_scope_item_ids: [itemId],
        budget_consumed: false,
        action: "resolve_text_only_for_required_item_ids_from_the_current_coverage_contract",
      };
    }
  }
  const detail = buildCandidateLeafDetail(
    context,
    candidatePlan,
    evidence,
    openedEvidenceIds,
    referencePolicies,
    itemId,
  );
  if (candidateSnapshotId) {
    const sections = createCandidateSectionRegistry(detail, planFingerprint, evidence, context.inventoryFingerprint);
    if (sections.candidate_snapshot_id !== candidateSnapshotId) {
      return {
        ok: false,
        error: "coverage_candidate_snapshot_stale",
        candidate_snapshot_id: candidateSnapshotId,
        current_candidate_snapshot_id: sections.candidate_snapshot_id,
        budget_consumed: false,
        action: "read_candidate_leaf_details_again_for_the_current_candidate_snapshot",
      };
    }
  }
  const textRegistry = new Map<string, CandidateTextRegistryEntry>();
  compactCandidateDetailText(detail, textRegistry);
  const entry = textRegistry.get(textRef);
  if (!entry) {
    return {
      ok: false,
      error: "coverage_candidate_unknown_text_reference",
      item_id: itemId,
      text_ref: textRef,
      allowed_text_refs: [...textRegistry.keys()].sort(),
      budget_consumed: false,
      action: "use_a_text_ref_returned_by_read_candidate_leaf_details_for_this_exact_item",
    };
  }
  const characters = [...entry.text];
  if (cursor > characters.length) {
    return {
      ok: false,
      error: "coverage_candidate_text_cursor_out_of_range",
      cursor,
      total_code_points: characters.length,
      budget_consumed: false,
    };
  }
  const text = characters.slice(cursor, cursor + maxCodePoints).join("");
  const nextCursor = cursor + [...text].length;
  return {
    ok: true,
    schema_version: "coverage-candidate-leaf-text/v1",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
    item_id: itemId,
    text_ref: entry.text_ref,
    ...(candidateSnapshotId ? { candidate_snapshot_id: candidateSnapshotId } : {}),
    full_sha256: entry.sha256,
    full_utf8_bytes: entry.utf8_bytes,
    total_code_points: entry.code_points,
    cursor,
    returned_code_points: [...text].length,
    chunk_utf8_bytes: Buffer.byteLength(text, "utf8"),
    chunk_sha256: sha256Text(text),
    next_cursor: nextCursor < characters.length ? nextCursor : null,
    complete: nextCursor >= characters.length,
    text,
    instruction: "Concatenate text chunks in cursor order to recover the exact immutable authoritative string. This resolver does not mark evidence as opened; cite only exact fragments from separately opened evidence.",
  };
}

function candidateLeafSectionPage(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  openedEvidenceIds: ReadonlySet<string>,
  referencePolicies: ReadonlyMap<string, ReferenceAnalysisPolicy>,
  scope: CoverageReviewScope,
  delivery: CoverageReviewState["candidate_section_delivery"] | undefined,
  input: Record<string, unknown>,
): { output: ToolResponse; delivered?: { candidate_snapshot_id: string; item_id: string; section: CandidateSectionRegistryEntry; next_unit_index: number; complete: boolean } } {
  const itemId = typeof input.item_id === "string" ? input.item_id : "";
  const candidateSnapshotId = typeof input.candidate_snapshot_id === "string" ? input.candidate_snapshot_id : "";
  const sectionRef = typeof input.section_ref === "string" ? input.section_ref : "";
  if (!itemId || !candidateSnapshotId || !sectionRef) {
    return { output: { ok: false, error: "coverage_candidate_section_reference_required", budget_consumed: false } };
  }
  const context = candidateLeafDetailContext(candidatePlan, evidence, planFingerprint);
  if (!context.materializedById.has(itemId)) {
    return { output: {
      ok: false,
      error: "coverage_candidate_unknown_item_ids",
      unknown_item_ids: [itemId],
      budget_consumed: false,
    } };
  }
  if (scope.mode !== "full") {
    const allowed = new Set(coverageReviewObligations(evidence, candidatePlan, scope).required_item_ids);
    if (!allowed.has(itemId)) {
      return { output: {
        ok: false,
        error: "coverage_candidate_item_outside_review_scope",
        review_scope_mode: scope.mode,
        outside_scope_item_ids: [itemId],
        budget_consumed: false,
      } };
    }
  }
  const detail = buildCandidateLeafDetail(
    context,
    candidatePlan,
    evidence,
    openedEvidenceIds,
    referencePolicies,
    itemId,
  );
  const sections = createCandidateSectionRegistry(detail, planFingerprint, evidence, context.inventoryFingerprint);
  if (sections.candidate_snapshot_id !== candidateSnapshotId) {
    return { output: {
      ok: false,
      error: "coverage_candidate_snapshot_stale",
      candidate_snapshot_id: candidateSnapshotId,
      current_candidate_snapshot_id: sections.candidate_snapshot_id,
      budget_consumed: false,
      action: "read_candidate_leaf_details_again_for_the_current_candidate_snapshot",
    } };
  }
  const section = sections.entries_by_ref.get(sectionRef);
  if (!section) {
    return { output: {
      ok: false,
      error: "coverage_candidate_unknown_section_reference",
      candidate_snapshot_id: candidateSnapshotId,
      item_id: itemId,
      section_ref: sectionRef,
      budget_consumed: false,
    } };
  }
  const unitStart = parseCandidateSectionPageToken(input.page_token, candidateSnapshotId, sectionRef);
  if (unitStart === undefined) {
    return { output: {
      ok: false,
      error: "coverage_candidate_section_page_token_invalid",
      candidate_snapshot_id: candidateSnapshotId,
      section_ref: sectionRef,
      budget_consumed: false,
    } };
  }
  const units = candidateSectionUnits(section);
  if (unitStart > units.length) {
    return { output: {
      ok: false,
      error: "coverage_candidate_section_page_out_of_range",
      unit_start: unitStart,
      total_units: units.length,
      budget_consumed: false,
    } };
  }
  const previous = delivery?.[candidateSnapshotId]?.sections[sectionRef];
  if ((!previous && unitStart !== 0) || (previous && unitStart > previous.next_unit_index)) {
    return { output: {
      ok: false,
      error: "coverage_candidate_section_page_gap",
      candidate_snapshot_id: candidateSnapshotId,
      section_ref: sectionRef,
      expected_page_token: candidateSectionPageToken(candidateSnapshotId, sectionRef, previous?.next_unit_index ?? 0),
      budget_consumed: false,
    } };
  }
  const pageFor = (endExclusive: number): ToolResponse => {
    const textRegistry = new Map<string, CandidateTextRegistryEntry>();
    const pageUnits = units.slice(unitStart, endExclusive)
      .map((unit) => compactCandidateSectionUnit(unit, textRegistry, sections));
    const nextUnitIndex = endExclusive;
    return {
      ok: true,
      schema_version: "coverage-candidate-leaf-section/v1",
      candidate_snapshot_id: candidateSnapshotId,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      item_id: itemId,
      section_ref: section.section_ref,
      section_id: section.section_id,
      path: section.path,
      section_sha256: section.section_sha256,
      units: pageUnits,
      text_registry: candidateTextRegistryMetadata(textRegistry),
      page: {
        unit_start: unitStart,
        unit_end_exclusive: nextUnitIndex,
        total_units: units.length,
        page_sha256: sha256Json(pageUnits),
        next_page_token: nextUnitIndex < units.length
          ? candidateSectionPageToken(candidateSnapshotId, sectionRef, nextUnitIndex)
          : null,
        complete: nextUnitIndex >= units.length,
      },
      instruction: "This is an immutable structured candidate section page. Read returned units in page-token order; nested $section_ref values are separate required sections. A successful delivery is durable, but semantic approval still requires the typed coverage review record and existing validator.",
    };
  };
  let endExclusive = unitStart;
  let output = pageFor(endExclusive);
  while (endExclusive < units.length) {
    const next = pageFor(endExclusive + 1);
    const nextBytes = serializedBytes(next);
    if (nextBytes > MAX_CANDIDATE_SECTION_PAGE_BYTES && endExclusive > unitStart) break;
    if (nextBytes > MAX_COVERAGE_READ_BYTES) {
      return { output: {
        ok: false,
        error: "coverage_candidate_section_unit_unserviceable",
        candidate_snapshot_id: candidateSnapshotId,
        section_ref: sectionRef,
        unit_index: endExclusive,
        max_serialized_bytes: MAX_COVERAGE_READ_BYTES,
        budget_consumed: false,
        action: "report_a_harness_contract_defect_for_the_listed_section_unit",
      } };
    }
    output = next;
    endExclusive += 1;
    if (nextBytes >= MAX_CANDIDATE_SECTION_PAGE_BYTES) break;
  }
  return {
    output,
    delivered: {
      candidate_snapshot_id: candidateSnapshotId,
      item_id: itemId,
      section,
      next_unit_index: endExclusive,
      complete: endExclusive >= units.length,
    },
  };
}

function candidateSectionDeliveryIssues(
  candidatePlan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  openedEvidenceIds: ReadonlySet<string>,
  referencePolicies: ReadonlyMap<string, ReferenceAnalysisPolicy>,
  scope: CoverageReviewScope,
  delivery: CoverageReviewState["candidate_section_delivery"] | undefined,
): Array<Record<string, unknown>> {
  const context = candidateLeafDetailContext(candidatePlan, evidence, planFingerprint);
  const obligations = coverageReviewObligations(evidence, candidatePlan, scope);
  const issues: Array<Record<string, unknown>> = [];
  for (const itemId of obligations.required_item_ids) {
    if (!context.materializedById.has(itemId)) continue;
    const detail = buildCandidateLeafDetail(
      context,
      candidatePlan,
      evidence,
      openedEvidenceIds,
      referencePolicies,
      itemId,
    );
    const compact = compactCandidateLeafDetailOutput(
      [detail],
      [itemId],
      planFingerprint,
      evidence,
      context.inventoryFingerprint,
      serializedBytes({ details: [detail] }),
    );
    if (serializedBytes(compact) <= MAX_COVERAGE_READ_BYTES) continue;
    const sections = createCandidateSectionRegistry(detail, planFingerprint, evidence, context.inventoryFingerprint);
    const delivered = delivery?.[sections.candidate_snapshot_id];
    const missing = [...sections.entries_by_ref.values()]
      .filter((section) => {
        const receipt = delivered?.sections[section.section_ref];
        return !receipt
          || receipt.section_sha256 !== section.section_sha256
          || receipt.total_units !== section.unit_count
          || receipt.complete !== true
          || receipt.next_unit_index !== section.unit_count;
      })
      .slice(0, 24)
      .map((section) => ({
        section_ref: section.section_ref,
        section_id: section.section_id,
        path: section.path,
        total_units: section.unit_count,
        utf8_bytes: section.utf8_bytes,
      }));
    if (missing.length > 0) {
      issues.push({
        code: "coverage_candidate_sections_incomplete",
        item_id: itemId,
        candidate_snapshot_id: sections.candidate_snapshot_id,
        missing_sections: missing,
        required_action: "read_candidate_leaf_details_then_read_every_required_section_page_and_nested_section_ref_before_sealing",
      });
    }
  }
  return issues;
}

const REVIEW_SCOPE_FILE = "review-scope.json";

function isCoverageReviewScope(value: unknown): value is CoverageReviewScope {
  return isRecord(value)
    && (value.mode === "full" || value.mode === "repair_delta" || value.mode === "ledger_gap" || value.mode === "risk_delta")
    && Array.isArray(value.affected_item_ids)
    && Array.isArray(value.affected_evidence_ids)
    && Array.isArray(value.finding_ids);
}

async function readPersistedReviewScope(reviewRoot: string): Promise<CoverageReviewScope | undefined> {
  const path = join(reviewRoot, REVIEW_SCOPE_FILE);
  if (!(await pathExists(path))) return undefined;
  try {
    const value = await readJson<unknown>(path);
    return isCoverageReviewScope(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writePersistedReviewScope(
  reviewRoot: string,
  scope: CoverageReviewScope,
): Promise<void> {
  await atomicWriteJson(join(reviewRoot, REVIEW_SCOPE_FILE), {
    mode: scope.mode,
    affected_item_ids: [...scope.affected_item_ids],
    affected_evidence_ids: [...scope.affected_evidence_ids],
    finding_ids: [...scope.finding_ids],
    ...(scope.gap_clause_ids ? { gap_clause_ids: [...scope.gap_clause_ids] } : {}),
  });
}

/**
 * Resolve the scope used when the sealed review was produced.
 * Active repair_delta recheck wins for the current plan; otherwise prefer the
 * durable review-scope.json written at seal time (e.g. ledger_gap). Never
 * silently validate a narrow seal as full — that drops the repair handoff.
 */
async function resolveSealedReviewScope(input: {
  reviewRoot: string;
  revisionState: RevisionState;
  planFingerprint: string;
  extraScope?: CoverageReviewScope;
}): Promise<CoverageReviewScope | undefined> {
  const recheck = input.revisionState.coverage_recheck;
  if (recheck?.schema_version === "coverage-recheck-scope/v1"
    && recheck.plan_fingerprint === input.planFingerprint) {
    return {
      mode: "repair_delta",
      affected_item_ids: [...recheck.affected_item_ids],
      affected_evidence_ids: [...recheck.affected_evidence_ids],
      finding_ids: [...recheck.finding_ids],
    };
  }
  const persisted = await readPersistedReviewScope(input.reviewRoot);
  if (persisted) return persisted;
  return input.extraScope;
}

export async function readSealedCoverageReview(
  workspace: RevisionWorkspace,
  planFingerprint: string,
  evidence: EvidenceManifest,
  extraScope?: CoverageReviewScope,
): Promise<DomainCoverageReview | undefined> {
  const reviewRoot = reviewDirectory(workspace, planFingerprint);
  const path = join(reviewRoot, "coverage-review.json");
  if (!(await pathExists(path))) return undefined;
  const materializedFingerprintPath = join(reviewRoot, "materialized-result.sha256");
  if (!(await pathExists(materializedFingerprintPath))) return undefined;
  const snapshotPath = join(reviewRoot, "candidate.evidence.json");
  const candidateEvidence = await pathExists(snapshotPath) ? await readJson<EvidenceManifest>(snapshotPath) : evidence;
  const candidatePath = join(reviewRoot, "candidate.plan.json");
  const [value, planText, revisionState, persistedMaterializedFingerprint] = await Promise.all([
    readJson<unknown>(path),
    readFile(await pathExists(candidatePath) ? candidatePath : workspace.lastValidPlanPath, "utf8"),
    workspace.readState(),
    readFile(materializedFingerprintPath, "utf8"),
  ]);
  const planViews = validateSemanticPlanViews(planText, candidateEvidence, {
    expected_fingerprint: planFingerprint,
  });
  if (!planViews.ok) return undefined;
  const currentValidatedCheckpoint =
    revisionState.last_valid_fingerprint === planFingerprint
    && evidence.evidence_fingerprint === candidateEvidence.evidence_fingerprint
    && revisionState.last_valid_plan_sha256 === planViews.value.plan_sha256;
  const boundCoverageRepairSource =
    revisionState.last_valid_fingerprint === ""
    && revisionState.last_valid_plan_sha256 === ""
    && revisionState.selector_stage === "coverage_repair"
    && revisionState.repair?.repair_source === "coverage"
    && revisionState.repair.coverage_review_fingerprint === planFingerprint;
  if (!currentValidatedCheckpoint && !boundCoverageRepairSource) return undefined;
  const plan = planViews.value.semantic_plan;
  if (persistedMaterializedFingerprint.trim() !== materializedCandidateFingerprint(plan, candidateEvidence, planFingerprint)) {
    return undefined;
  }
  const scope = await resolveSealedReviewScope({
    reviewRoot,
    revisionState,
    planFingerprint,
    ...(extraScope ? { extraScope } : {}),
  });
  const spanRegistry = await workspace.readSourceSpanRegistry().catch(() => undefined);
  const validation = validateCoverageReview(migrateCoverageReview(value), planFingerprint, candidateEvidence, undefined, plan, scope, spanRegistry);
  if (!validation.ok || !validation.review) {
    // Validator contracts can become stricter between resumptions. An old
    // seal that no longer revalidates is never trusted, but it is recoverable
    // working input rather than a runtime crash. CoverageReviewController.create
    // quarantines the stale seal and preserves its typed draft for correction.
    return undefined;
  }
  if ((await referenceObservationIssues(workspace, planFingerprint, candidateEvidence, validation.review)).length) return undefined;
  return validation.review;
}

/** Queries are not semantic approval. New internal pointers must be handed
 * back as findings anchored in the candidate's original evidence. */
async function referenceObservationIssues(
  workspace: RevisionWorkspace,
  planFingerprint: string,
  evidence: EvidenceManifest,
  value: unknown,
): Promise<Array<{ code: string; path: string; message: string; details: unknown }>> {
  const observed = await workspace.readReferenceObservations(planFingerprint);
  const known = new Set(evidence.reference_occurrences.map((entry) => entry.occurrence_id));
  const review = value as Partial<DomainCoverageReview> | null;
  const findingOrigins = (originId: string): Set<string> => {
    const origins = new Set([originId]);
    for (const id of origins) {
      for (const parent of observed.reference_occurrences) {
        if (parent.target_evidence_ids.includes(id)) {
          referenceOccurrenceOriginEvidenceIds(parent).forEach((originEvidenceId) => origins.add(originEvidenceId));
        }
      }
    }
    return origins;
  };
  return observed.reference_occurrences.filter((entry) => (!known.has(entry.occurrence_id) || entry.status === "target_not_found")
    && !entry.external_standard
    && entry.target_address?.source_id === evidence.source.sha256
    && !(["repair", "harness_defect"].includes(review?.status ?? "") && review?.findings?.some((finding) =>
      ["semantic_coverage_gap", "compiler_materialization_defect"].includes(finding.finding_type)
      && (findingOrigins(entry.origin_evidence_id).has(finding.evidence_id)
        || entry.target_evidence_ids.includes(finding.evidence_id))
    ))).map((entry) => ({
      code: "coverage_reference_observation_requires_repair",
      path: "/findings",
      message: "本标准内部引用尚未处理完。保留原有 findings，并在候选的原引用证据上登记 semantic_coverage_gap（程序缺陷则用 compiler_materialization_defect）；查询或未找到均不表示通过。进入修复后才能正式采用、重新编译校验和复查。",
      details: { occurrence_id: entry.occurrence_id, origin_evidence_id: entry.origin_evidence_id,
        origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(entry),
        reference_literal_span_id: entry.reference_literal_span_id,
        reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(entry), status: entry.status },
    }));
}

interface ToolResponse {
  ok: boolean;
  [key: string]: unknown;
}

export interface CoverageControllerRebuildReceipt extends ToolResponse {
  ok: false;
  error: "coverage_review_candidate_changed";
  terminal: true;
  budget_consumed: false;
  control_kind: "coverage_controller_rebuild";
  retryable_control: true;
  same_job_required: true;
  stale_plan_fingerprint: string;
  current_plan_fingerprint: string;
  current_plan_sha256: string;
  reason?: "candidate_identity_changed" | "current_candidate_not_durably_valid";
  required_action: "rebuild_coverage_controller_for_current_candidate";
  instruction: string;
}

export function coverageCandidateChangedReceipt(
  stalePlanFingerprint: string,
  currentRevision: Pick<RevisionState, "last_valid_fingerprint" | "last_valid_plan_sha256">,
  reason: CoverageControllerRebuildReceipt["reason"] = "candidate_identity_changed",
): CoverageControllerRebuildReceipt {
  return toolReject({
    error: "coverage_review_candidate_changed",
    terminal: true,
    budget_consumed: false,
    control_kind: "coverage_controller_rebuild",
    retryable_control: true,
    same_job_required: true,
    stale_plan_fingerprint: stalePlanFingerprint,
    current_plan_fingerprint: currentRevision.last_valid_fingerprint,
    current_plan_sha256: currentRevision.last_valid_plan_sha256,
    reason,
    required_action: "rebuild_coverage_controller_for_current_candidate",
    instruction: "当前 CoverageReviewController 绑定的候选已过期，本会话必须终止且不得调用模型。由上层编排保留同一 job、target、revision 和已有工件，读取当前候选（即 current_plan_fingerprint 对应的持久化候选）与复核范围，有界新建 CoverageReviewController 后继续；不要创建新 job/target/revision，不要盲目重启旧 controller，也不要让模型修改 selector。",
  });
}

/**
 * Verify the complete durable candidate identity before constructing a review
 * controller. The fingerprint alone is insufficient after an interrupted
 * plan/state commit: the persisted plan bytes and checkpoint SHA must agree as
 * well. Invalid or changing durable input is a recoverable orchestration
 * control condition, not a provider or business-review failure.
 */
export async function durableCoverageCandidateChangeReceipt(
  workspace: RevisionWorkspace,
  planFingerprint: string,
): Promise<CoverageControllerRebuildReceipt | undefined> {
  const before = await workspace.readState();
  if (
    !/^[a-f0-9]{64}$/u.test(planFingerprint)
    || before.last_valid_fingerprint !== planFingerprint
    || !/^[a-f0-9]{64}$/u.test(before.last_valid_plan_sha256)
  ) {
    return coverageCandidateChangedReceipt(
      planFingerprint,
      before,
      before.last_valid_fingerprint === planFingerprint
        ? "current_candidate_not_durably_valid"
        : "candidate_identity_changed",
    );
  }

  let exactCandidate = false;
  try {
    const [evidence, planSource] = await Promise.all([
      workspace.readEvidenceManifest(),
      readFile(workspace.lastValidPlanPath, "utf8"),
    ]);
    const views = validateSemanticPlanViews(planSource, evidence, {
      expected_fingerprint: planFingerprint,
    });
    exactCandidate = views.ok && views.value.plan_sha256 === before.last_valid_plan_sha256;
  } catch {
    exactCandidate = false;
  }

  const after = await workspace.readState();
  if (
    after.last_valid_fingerprint !== before.last_valid_fingerprint
    || after.last_valid_plan_sha256 !== before.last_valid_plan_sha256
  ) {
    return coverageCandidateChangedReceipt(planFingerprint, after);
  }
  return exactCandidate
    ? undefined
    : coverageCandidateChangedReceipt(
        planFingerprint,
        after,
        "current_candidate_not_durably_valid",
      );
}

export async function repairDurableCoverageCandidateCheckpoint(
  workspace: RevisionWorkspace,
  planFingerprint: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(planFingerprint)) return false;
  const before = await workspace.readState();
  if (before.status === "sealed" || before.last_valid_fingerprint !== planFingerprint) return false;

  let evidence: EvidenceManifest;
  let receipt: Record<string, unknown>;
  try {
    [evidence, receipt] = await Promise.all([
      workspace.readEvidenceManifest(),
      readJson<Record<string, unknown>>(workspace.validationReceiptPath),
    ]);
  } catch {
    return false;
  }
  const candidatePaths = [workspace.lastValidPlanPath, workspace.workingPlanPath];
  let recovered:
    | { path: string; persisted_plan: unknown; plan_sha256: string; validator: string }
    | undefined;
  for (const path of candidatePaths) {
    try {
      const views = validateSemanticPlanViews(await readFile(path, "utf8"), evidence, {
        expected_fingerprint: planFingerprint,
      });
      if (
        views.ok
        && receipt.ok === true
        && receipt.validation_fingerprint === planFingerprint
        && receipt.plan_sha256 === views.value.plan_sha256
        && receipt.evidence_fingerprint === evidence.evidence_fingerprint
        && receipt.validator === views.value.validator
      ) {
        recovered = {
          path,
          persisted_plan: views.value.persisted_plan,
          plan_sha256: views.value.plan_sha256,
          validator: views.value.validator,
        };
        break;
      }
    } catch {
      // Try the other same-revision durable candidate copy.
    }
  }
  if (!recovered) return false;

  const unchanged = await workspace.readState();
  if (
    unchanged.status === "sealed"
    || unchanged.last_valid_fingerprint !== before.last_valid_fingerprint
    || unchanged.last_valid_plan_sha256 !== before.last_valid_plan_sha256
  ) return false;
  if (recovered.path !== workspace.lastValidPlanPath) {
    if (await pathExists(workspace.lastValidPlanPath)) {
      await chmod(workspace.lastValidPlanPath, 0o644);
    }
    await atomicWriteJson(workspace.lastValidPlanPath, recovered.persisted_plan);
  }
  try {
    await workspace.updateState((current) => {
      if (
        current.status === "sealed"
        || current.last_valid_fingerprint !== unchanged.last_valid_fingerprint
        || current.last_valid_plan_sha256 !== unchanged.last_valid_plan_sha256
      ) {
        throw new Error("coverage_candidate_changed_during_checkpoint_repair");
      }
      current.last_valid_plan_sha256 = recovered!.plan_sha256;
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "coverage_candidate_changed_during_checkpoint_repair"
    ) return false;
    throw error;
  }
  const repaired = await durableCoverageCandidateChangeReceipt(workspace, planFingerprint);
  if (repaired) return false;
  await workspace.appendEvent("coverage_candidate_checkpoint_repaired", {
    plan_fingerprint: planFingerprint,
    plan_sha256: recovered.plan_sha256,
    validator: recovered.validator,
    source: recovered.path === workspace.lastValidPlanPath ? "last_valid_plan" : "working_plan",
    author_model_called: false,
  });
  return true;
}

export function normalizeCoverageReviewMechanicalFields<T extends Record<string, unknown>>(
  value: T,
): { value: T; changed_record_count: number } {
  if (!Array.isArray(value.semantic_coverage)) {
    return { value, changed_record_count: 0 };
  }
  let changedRecordCount = 0;
  const semanticCoverage = value.semantic_coverage.map((entry) => {
    if (
      !isRecord(entry)
      || (entry.disposition !== "shared_context" && entry.disposition !== "irrelevant")
      || entry.judgment_id === ""
    ) {
      return entry;
    }
    changedRecordCount += 1;
    return { ...entry, judgment_id: "" };
  });
  return changedRecordCount === 0
    ? { value, changed_record_count: 0 }
    : {
        value: { ...value, semantic_coverage: semanticCoverage } as T,
        changed_record_count: changedRecordCount,
      };
}



export async function sealDeterministicCleanCoverageReview(
  workspace: RevisionWorkspace,
  planFingerprint: string,
  scope: CoverageReviewScope,
  summary = "Deterministic coverage risk gate found no semantic-review obligations.",
): Promise<{ sealed: boolean; review?: DomainCoverageReview; model: string; error?: string }> {
  if (scope.mode !== "risk_delta" || scope.affected_item_ids.length || scope.affected_evidence_ids.length) {
    return {
      sealed: false,
      model: "deterministic-coverage-risk-gate",
      error: "deterministic_clean_coverage_requires_empty_risk_delta_scope",
    };
  }
  const staleBeforeCreate = await durableCoverageCandidateChangeReceipt(workspace, planFingerprint);
  if (staleBeforeCreate) {
    return {
      sealed: false,
      model: "deterministic-coverage-risk-gate",
      error: staleBeforeCreate.error,
    };
  }
  let controller: CoverageReviewController;
  try {
    controller = await CoverageReviewController.create(workspace, planFingerprint, scope);
  } catch (error) {
    const staleDuringCreate = await durableCoverageCandidateChangeReceipt(workspace, planFingerprint);
    if (!staleDuringCreate) throw error;
    return {
      sealed: false,
      model: "deterministic-coverage-risk-gate",
      error: staleDuringCreate.error,
    };
  }
  const staged = await controller.dispatch("stage_coverage_review_draft", {
    status: "approved",
    summary,
  });
  if (staged.ok !== true || typeof staged.error === "string") {
    return {
      sealed: false,
      model: "deterministic-coverage-risk-gate",
      error: typeof staged.error === "string" ? staged.error : JSON.stringify(staged),
    };
  }
  const sealed = await controller.finalizeMechanicallyReady();
  if (sealed.ok !== true) {
    return {
      sealed: false,
      model: "deterministic-coverage-risk-gate",
      error: typeof sealed.error === "string" ? sealed.error : JSON.stringify(sealed),
    };
  }
  const evidence = await workspace.readEvidenceManifest();
  const review = await readSealedCoverageReview(workspace, planFingerprint, evidence, scope);
  return review
    ? { sealed: true, review, model: "deterministic-coverage-risk-gate" }
    : { sealed: false, model: "deterministic-coverage-risk-gate", error: "deterministic_clean_coverage_seal_not_readable" };
}

export function coverageDetailReadConsumesFreshPhaseBudget(output: ToolResponse): boolean {
  return output.ok === true
    && (output.schema_version === "coverage-candidate-leaf-details/v1"
      || output.schema_version === "coverage-candidate-leaf-details/v2"
      || output.schema_version === "coverage-candidate-leaf-details/v3")
    && Array.isArray(output.details);
}

export class CoverageReviewController {
  private liveDetailPhaseItemIds: Set<string> | undefined;
  private liveDetailPhaseViews = new Set<string>();
  /** 规则发现 Agent 的入口，由 pi-runtime 注入；不注入就只走确定性规则。 */
  referenceCatalogRuleAsk?: CatalogRuleAsk;
  readonly root: string;
  readonly workingPath: string;
  readonly lastValidPath: string;
  readonly sealedPath: string;
  readonly materializedFingerprintPath: string;
  readonly statePath: string;
  readonly transcriptPath: string;
  readonly historyDirectory: string;
  readonly validationDirectory: string;
  readonly piSessionDirectory: string;
  private stateMutationTail: Promise<void> = Promise.resolve();
  /** 指针式引用的注册表；老 revision 可能缺失，缺失时 span 绑定报明确错误。 */
  spanRegistry: SourceSpanRegistry | undefined;

  private constructor(
    public readonly workspace: RevisionWorkspace,
    public readonly planFingerprint: string,
    public readonly evidence: EvidenceManifest,
    public readonly reviewScope: CoverageReviewScope,
    private readonly candidatePlan: SemanticSourcePlan,
    private readonly candidatePlanSha256: string,
    private readonly priorReview?: DomainCoverageReview,
    private readonly priorCandidatePlan?: SemanticSourcePlan,
  ) {
    this.root = reviewDirectory(workspace, planFingerprint);
    this.workingPath = join(this.root, "working.coverage-review.json");
    this.lastValidPath = join(this.root, "last-valid.coverage-review.json");
    this.sealedPath = join(this.root, "coverage-review.json");
    this.materializedFingerprintPath = join(this.root, "materialized-result.sha256");
    this.statePath = join(this.root, "state.json");
    this.transcriptPath = join(this.root, "session.events.jsonl");
    this.historyDirectory = join(this.root, "history");
    this.validationDirectory = join(this.root, "validation");
    this.piSessionDirectory = join(this.root, "pi-session");
  }

  static async create(
    workspace: RevisionWorkspace,
    planFingerprint: string,
    extraScope?: CoverageReviewScope,
  ): Promise<CoverageReviewController> {
    const evidence = await workspace.readEvidenceManifest();
    const revisionState = await workspace.readState();
    if (revisionState.last_valid_fingerprint !== planFingerprint) {
      throw new Error("Coverage reviewer can only inspect the current last-valid plan");
    }
    const planSource = await readFile(workspace.lastValidPlanPath, "utf8");
    const planViews = validateSemanticPlanViews(planSource, evidence, {
      expected_fingerprint: planFingerprint,
    });
    if (!planViews.ok) {
      throw new Error("Coverage reviewer requires an exact valid persisted semantic plan");
    }
    if (revisionState.last_valid_plan_sha256 !== planViews.value.plan_sha256) {
      throw new Error("Coverage reviewer plan hash does not match the durable validation checkpoint");
    }
    const recheck = revisionState.coverage_recheck;
    const persistedScope = await readPersistedReviewScope(reviewDirectory(workspace, planFingerprint));
    const reviewScope: CoverageReviewScope = recheck?.schema_version === "coverage-recheck-scope/v1"
      && recheck.plan_fingerprint === planFingerprint
      ? {
          mode: "repair_delta",
          affected_item_ids: [...recheck.affected_item_ids],
          affected_evidence_ids: [...recheck.affected_evidence_ids],
          finding_ids: [...recheck.finding_ids],
        }
      : extraScope
        ?? persistedScope
        ?? { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] };
    let priorReview: DomainCoverageReview | undefined;
    let priorCandidatePlan: SemanticSourcePlan | undefined;
    const sourcePlanFingerprint = recheck?.schema_version === "coverage-recheck-scope/v1"
      && recheck.plan_fingerprint === planFingerprint
      ? recheck.source_plan_fingerprint
      : "";
    if (/^[a-f0-9]{64}$/u.test(sourcePlanFingerprint) && sourcePlanFingerprint !== planFingerprint) {
      const priorRoot = reviewDirectory(workspace, sourcePlanFingerprint);
      const priorReviewPath = join(priorRoot, "coverage-review.json");
      const priorPlanPath = join(priorRoot, "candidate.plan.json");
      const priorEvidencePath = join(priorRoot, "candidate.evidence.json");
      if (await pathExists(priorReviewPath) && await pathExists(priorPlanPath) && await pathExists(priorEvidencePath)) {
        const migratedPrior = migrateCoverageReview(await readJson<unknown>(priorReviewPath));
        const priorEvidence = await readJson<EvidenceManifest>(priorEvidencePath);
        const priorViews = validateSemanticPlanViews(
          await readFile(priorPlanPath, "utf8"),
          priorEvidence,
          { expected_fingerprint: sourcePlanFingerprint },
        );
        if (isRecord(migratedPrior)
          && migratedPrior.schema_version === COVERAGE_REVIEW_SCHEMA_VERSION
          && migratedPrior.plan_fingerprint === sourcePlanFingerprint
          && priorViews.ok) {
          priorReview = migratedPrior as unknown as DomainCoverageReview;
          priorCandidatePlan = priorViews.value.semantic_plan;
        }
      }
    }
    const controller = new CoverageReviewController(
      workspace,
      planFingerprint,
      evidence,
      reviewScope,
      planViews.value.semantic_plan,
      planViews.value.plan_sha256,
      priorReview,
      priorCandidatePlan,
    );
    controller.spanRegistry = await workspace.readSourceSpanRegistry().catch(() => undefined);
    await mkdir(controller.historyDirectory, { recursive: true });
    await mkdir(controller.validationDirectory, { recursive: true });
    await mkdir(controller.piSessionDirectory, { recursive: true });
    // Immutable review source survives evidence adoption, interruption and a
    // later candidate commit. Never reconstruct it by overwriting hashes.
    if (!(await pathExists(join(controller.root, "candidate.evidence.json")))) {
      await atomicWriteNewText(join(controller.root, "candidate.evidence.json"), prettyJson(evidence));
    }
    if (!(await pathExists(join(controller.root, "candidate.plan.json")))) {
      await atomicWriteNewText(join(controller.root, "candidate.plan.json"), planSource);
    }
    if (!(await pathExists(controller.workingPath))) {
      await atomicWriteJson(controller.workingPath, initialReview(planFingerprint, evidence));
    }
    if (!(await pathExists(controller.statePath))) {
      await atomicWriteJson(controller.statePath, initialState());
    }
    let transcriptNextEventSequence = 1;
    if (await pathExists(controller.transcriptPath)) {
      const lines = (await readFile(controller.transcriptPath, "utf8")).split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) {
        const event = strictJsonParse(line);
        if (
          !isRecord(event)
          || event.schema_version !== "coverage-review-event/v1"
          || event.plan_fingerprint !== planFingerprint
          || !Number.isInteger(event.sequence)
          || Number(event.sequence) < 1
        ) {
          throw new Error("Invalid coverage review event transcript");
        }
        transcriptNextEventSequence = Math.max(
          transcriptNextEventSequence,
          Number(event.sequence) + 1,
        );
      }
    }
    await controller.invalidateStaleSeal();
    if (transcriptNextEventSequence > 1) {
      await controller.updateState((state) => {
        state.next_event_sequence = Math.max(
          state.next_event_sequence,
          transcriptNextEventSequence,
        );
      });
    }
    return controller;
  }

  private async invalidateStaleSeal(): Promise<void> {
    if (!(await pathExists(this.sealedPath))) return;
    const candidatePlan = this.candidatePlan;
    const expected = materializedCandidateFingerprint(candidatePlan, this.evidence, this.planFingerprint);
    const persisted = await pathExists(this.materializedFingerprintPath)
      ? (await readFile(this.materializedFingerprintPath, "utf8")).trim()
      : "";
    const sealedValue = await readJson<unknown>(this.sealedPath);
    const validation = persisted === expected
      ? validateCoverageReview(
          migrateCoverageReview(sealedValue),
          this.planFingerprint,
          this.evidence,
          undefined,
          candidatePlan,
          this.reviewScope,
        )
      : undefined;
    if (validation?.ok && validation.review) return;
    const suffix = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, "");
    await rename(this.sealedPath, join(this.root, `coverage-review.stale-${suffix}.json`));
    if (await pathExists(this.materializedFingerprintPath)) {
      await rename(
        this.materializedFingerprintPath,
        join(this.root, `materialized-result.stale-${suffix}.sha256`),
      );
    }
    if (await pathExists(this.lastValidPath)) {
      await chmod(this.lastValidPath, 0o600);
      await rename(
        this.lastValidPath,
        join(this.root, `last-valid.coverage-review.stale-${suffix}.json`),
      );
    }
    if (persisted === expected) {
      // The candidate is unchanged; preserve the typed review so the model
      // only fixes newly actionable local issues. Keep opened evidence and
      // telemetry, but invalidate approval and start a fresh bounded session.
      await atomicWriteJson(this.workingPath, migrateCoverageReview(sealedValue));
      const current = await this.readState();
      current.status = "working";
      current.last_valid_review_fingerprint = "";
      current.agent_runtime = { kind: "unassigned", session_id: "", session_file: "" };
      await atomicWriteJson(this.statePath, current);
    } else {
      await atomicWriteJson(this.workingPath, initialReview(this.planFingerprint, this.evidence));
      await atomicWriteJson(this.statePath, initialState());
    }
  }

  async readState(): Promise<CoverageReviewState> {
    return this.withStateLock(() => readJson<CoverageReviewState>(this.statePath));
  }

  async referenceEvidence(): Promise<EvidenceManifest> {
    return this.workspace.readReferenceObservations(this.planFingerprint);
  }

  async readDurableProgressSnapshot(): Promise<{
    progress_fingerprint: string;
    working_plan_sha256: string;
    history_sequence: number;
    last_valid_fingerprint: string;
  }> {
    const [content, state] = await Promise.all([
      readFile(this.workingPath, "utf8"),
      this.readState(),
    ]);
    const value = strictJsonParse(content);
    const openedEvidenceIds = new Set(state.opened_evidence_ids);
    const checkpoint = coverageCheckpoint(
      value,
      this.evidence,
      this.candidatePlan,
      openedEvidenceIds,
      this.reviewScope,
      this.spanRegistry,
    );
    const localValidation = checkpoint.ready_for_validation === true
      ? validateCoverageReview(
          value,
          this.planFingerprint,
          this.evidence,
          openedEvidenceIds,
          this.candidatePlan,
          this.reviewScope,
        )
      : undefined;
    const localValidationIssueFingerprint = localValidation
      ? (localValidation.ok ? "valid" : typedIssueFingerprint(localValidation.issues))
      : "";
    return {
      progress_fingerprint: coverageReviewProgressFingerprint(value, checkpoint, {
        opened_evidence_ids: state.opened_evidence_ids,
        last_valid_review_fingerprint: state.last_valid_review_fingerprint,
        status: state.status,
        candidate_section_delivery: state.candidate_section_delivery,
        related_context_delivery: state.related_context_delivery,
        local_validation_issue_fingerprint: localValidationIssueFingerprint,
      }),
      working_plan_sha256: sha256Text(content),
      history_sequence: state.next_history_sequence,
      last_valid_fingerprint: state.last_valid_review_fingerprint,
    };
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationTail;
    let release!: () => void;
    this.stateMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async updateState(mutator: (state: CoverageReviewState) => void): Promise<CoverageReviewState> {
    return this.withStateLock(async () => {
      const state = await readJson<CoverageReviewState>(this.statePath);
      mutator(state);
      await atomicWriteJson(this.statePath, state);
      return state;
    });
  }

  private async referenceAnalysisPolicies(
    manifest: EvidenceManifest,
  ): Promise<Map<string, ReferenceAnalysisPolicy>> {
    const state = await this.workspace.readState();
    return projectReferenceAnalysisPolicies(
      manifest,
      state.reference_analysis_modes,
      "coverage",
    );
  }

  private async listCoverageReferenceTargets(input: Record<string, unknown>): Promise<ToolResponse> {
    const cursorValue = input.cursor === undefined ? 0 : input.cursor;
    const limitValue = input.limit === undefined ? 100 : input.limit;
    const validLimit = typeof limitValue === "number"
      && Number.isInteger(limitValue)
      && limitValue >= 1
      && limitValue <= 100;
    if (typeof cursorValue !== "number" || !Number.isInteger(cursorValue) || cursorValue < 0) {
      return {
        ok: false,
        error: "coverage_reference_target_catalog_cursor_invalid",
        parameter: "cursor",
        received_value: cursorValue,
        next_tool: "list_coverage_reference_targets",
        next_tool_arguments: { cursor: 0, limit: validLimit ? limitValue : 100 },
        writable_parameters: ["cursor"],
        required_action: "restart_catalog_from_cursor_zero",
        instruction: "首次调用 list_coverage_reference_targets 时传 cursor=0；后续只原样传上一回条的 next_cursor。只修正 cursor 后重试，不要修改候选或引用观察。",
      };
    }
    if (!validLimit) {
      return {
        ok: false,
        error: "coverage_reference_target_catalog_limit_invalid",
        parameter: "limit",
        received_value: limitValue,
        next_tool: "list_coverage_reference_targets",
        next_tool_arguments: { cursor: cursorValue, limit: 100 },
        writable_parameters: ["limit"],
        required_action: "retry_catalog_with_limit_between_one_and_one_hundred",
        instruction: "limit 必须是 1～100 的整数。保留 cursor，只把 limit 改为有效值后重试；不要修改候选或引用观察。",
      };
    }

    const referenceEvidence = await this.referenceEvidence();
    const policies = await this.referenceAnalysisPolicies(referenceEvidence);
    const candidateOccurrenceIds = new Set(
      this.evidence.reference_occurrences.map((occurrence) => occurrence.occurrence_id),
    );
    const targets = referenceEvidence.reference_occurrences.flatMap((occurrence) => {
      if (occurrence.status !== "resolved") return [];
      const identity = documentReferenceTargetReadIdentity(occurrence);
      const policy = policies.get(identity.target_key);
      if (!policy) return [];
      const readTool = policy.analysis_mode === "isolated"
        ? "read_reference_facts"
        : "read_document_reference_evidence";
      return [{
        occurrence_id: occurrence.occurrence_id,
        raw_reference: occurrence.raw_reference,
        normalized_reference: occurrence.normalized_reference ?? occurrence.raw_reference,
        target_key: identity.target_key,
        target_locator: identity.target_locator,
        registration_phase: candidateOccurrenceIds.has(occurrence.occurrence_id)
          ? "candidate"
          : "review_observation",
        analysis_mode: policy.analysis_mode,
        read_tool: readTool,
        tool_arguments: { target_key: identity.target_key },
      }];
    });
    const cursor = cursorValue;
    const limit = limitValue as number;
    if (cursor > targets.length) {
      return {
        ok: false,
        error: "coverage_reference_target_catalog_cursor_invalid",
        parameter: "cursor",
        received_value: cursor,
        next_tool: "list_coverage_reference_targets",
        next_tool_arguments: { cursor: 0, limit },
        writable_parameters: ["cursor"],
        required_action: "restart_catalog_from_cursor_zero",
        instruction: "cursor 超出当前已登记目录。用 cursor=0 重新开始，并只沿每页 next_cursor 顺序读取；不要猜测游标或修改候选。",
      };
    }
    const page = targets.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length < targets.length ? cursor + page.length : null;
    return {
      ok: true,
      schema_version: "coverage-reference-target-catalog/v1",
      plan_fingerprint: this.planFingerprint,
      cursor,
      targets: page,
      next_cursor: nextCursor,
      instruction: "这是当前 coverage 会话已登记 resolved 引用 occurrence 的只读机械路由目录，不含目标正文或语义判断。按 raw_reference、normalized_reference 和 target_locator 核对原调用意图，原样复制 target_key 及 tool_arguments 调用 read_tool；next_cursor 非 null 时原样继续分页。不要按目录顺序推断结论。",
    };
  }

  private async candidateSectionDeliveryIssues(
    state: CoverageReviewState,
  ): Promise<Array<Record<string, unknown>>> {
    const referencePolicies = await this.referenceAnalysisPolicies(this.evidence);
    return candidateSectionDeliveryIssues(
      this.candidatePlan,
      this.evidence,
      this.planFingerprint,
      new Set(state.opened_evidence_ids),
      referencePolicies,
      this.reviewScope,
      state.candidate_section_delivery,
    );
  }

  private relatedContextIssues(value: unknown, state: CoverageReviewState): Array<Record<string, unknown>> {
    if (this.reviewScope.mode === "full" || !isRecord(value) || !Array.isArray(value.findings)) return [];
    const allowed = new Set(coverageReviewObligations(this.evidence, this.candidatePlan, this.reviewScope).required_item_ids);
    const ids = new Set(value.findings.filter(isRecord).flatMap((finding) =>
      finding.finding_type === "semantic_coverage_gap" && Array.isArray(finding.affected_item_ids)
        ? finding.affected_item_ids.filter((id): id is string => typeof id === "string" && allowed.has(id)) : []));
    const context = candidateLeafDetailContext(this.candidatePlan, this.evidence, this.planFingerprint);
    return [...ids].flatMap((id) => {
      const data = relatedContextRecords(context, this.candidatePlan, id);
      const receipt = state.related_context_delivery?.[id];
      if (!data.records.length || (receipt?.fingerprint === data.fingerprint && receipt.next_cursor === data.records.length)) return [];
      return [relatedContextIssue(id, receipt?.fingerprint === data.fingerprint ? receipt.next_cursor : 0, data.records.length)];
    });
  }

  private async relatedContextBlock(value: unknown, state: CoverageReviewState): Promise<ToolResponse | undefined> {
    const issues = this.relatedContextIssues(value, state);
    if (!issues.length) return undefined;
    return { ok: false, error: "coverage_related_context_incomplete", budget_consumed: false, issues,
      candidate_read_tool: "read_candidate_related_context", instruction: RELATED_CONTEXT_INSTRUCTION,
      required_action: "Read the listed context pages before staging or sealing a semantic gap; keep the existing review scope unchanged." };
  }

  private async readRelatedContext(input: Record<string, unknown>): Promise<ToolResponse> {
    return this.withStateLock(async () => {
      const itemId = typeof input.item_id === "string" ? input.item_id : "";
      const allowed = coverageReviewObligations(this.evidence, this.candidatePlan, this.reviewScope).required_item_ids;
      const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
      const limit = input.max_records === undefined ? 4 : Number(input.max_records);
      if (!allowed.includes(itemId) || !Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 8) {
        return { ok: false, error: "coverage_related_context_request_invalid", actual: input, budget_consumed: false,
          instruction: "Use a required item_id from read_candidate_plan as anchor, cursor=0 initially, max_records=1..8. This tool is read-only; do not expand the review worklist or change the candidate.",
          candidate_read_tool: "read_candidate_plan", writable_collection: "none (read-only request)", required_action: "Correct the arguments and call read_candidate_related_context." };
      }
      const context = candidateLeafDetailContext(this.candidatePlan, this.evidence, this.planFingerprint);
      const data = relatedContextRecords(context, this.candidatePlan, itemId);
      const state = await readJson<CoverageReviewState>(this.statePath);
      const old = state.related_context_delivery?.[itemId];
      const next = old?.fingerprint === data.fingerprint ? old.next_cursor : 0;
      if (cursor > next || cursor > data.records.length) {
        return { ok: false, error: "coverage_related_context_cursor_gap", actual_cursor: cursor, next_cursor: next,
          budget_consumed: false, instruction: "Read pages in order; use the returned next_cursor. Do not edit candidate or ledger files.",
          candidate_read_tool: "read_candidate_related_context", writable_collection: "none (read-only request)", required_action: "Retry read_candidate_related_context with item_id and next_cursor." };
      }
      const records = data.records.slice(cursor, cursor + limit);
      const output = (): ToolResponse => ({ ok: true, plan_fingerprint: this.planFingerprint, context_fingerprint: data.fingerprint,
        anchor_item_id: itemId, related_leaf_count: data.entries.length, total_records: data.records.length,
        cursor, records, next_cursor: cursor + records.length < data.records.length ? cursor + records.length : null,
        context_only: true, instruction: RELATED_CONTEXT_INSTRUCTION });
      while (serializedBytes(output()) > MAX_COVERAGE_READ_BYTES && records.length > 1) records.pop();
      if (serializedBytes(output()) > MAX_COVERAGE_READ_BYTES) {
        return { ok: false, error: "coverage_related_context_record_too_large", actual_bytes: serializedBytes(output()),
          max_bytes: MAX_COVERAGE_READ_BYTES, budget_consumed: false, instruction: "Context could not be delivered. Do not infer missing content or edit the candidate; report this tool-capacity defect.",
          writable_collection: "findings", candidate_read_tool: "read_candidate_related_context", required_action: "Report the returned item_id and size to the operator.", item_id: itemId };
      }
      state.related_context_delivery ??= {};
      state.related_context_delivery[itemId] = { fingerprint: data.fingerprint, next_cursor: Math.max(next, cursor + records.length), total_records: data.records.length };
      await atomicWriteJson(this.statePath, state);
      return output();
    });
  }

  async setRuntime(runtime: RevisionState["agent_runtime"]): Promise<void> {
    await this.updateState((state) => { state.agent_runtime = runtime; });
  }

  beginFreshCoveragePhase(): void {
    // This is deliberately an in-memory provider-context budget, not durable
    // semantic state. A fresh session may reconstruct its next bounded slice,
    // while the working review remains the sole durable progress authority.
    this.liveDetailPhaseItemIds = new Set<string>();
    this.liveDetailPhaseViews.clear();
  }

  private liveDetailPhaseBudgetBlock(itemIdsValue: unknown, view: unknown): ToolResponse | undefined {
    const phaseItemIds = this.liveDetailPhaseItemIds;
    if (!phaseItemIds || !Array.isArray(itemIdsValue)) return undefined;
    const itemIds = itemIdsValue.filter((itemId): itemId is string => typeof itemId === "string");
    if (itemIds.length !== itemIdsValue.length || new Set(itemIds).size !== itemIds.length) {
      return undefined;
    }
    const readKey = (id: string) => `${view === "business" ? "business" : "full"}:${id}`;
    const alreadyReadItemIds = itemIds.filter(id => this.liveDetailPhaseViews.has(readKey(id)));
    const newItemIds = itemIds.filter(id => !this.liveDetailPhaseViews.has(readKey(id)));
    if (
      alreadyReadItemIds.length === 0
      && this.liveDetailPhaseViews.size + newItemIds.length <= MAX_CANDIDATE_DETAIL_ITEMS_PER_FRESH_PHASE
    ) return undefined;
    return {
      ok: false,
      error: "coverage_candidate_detail_phase_budget_reached",
      budget_consumed: false,
      max_unique_item_ids_per_fresh_phase: MAX_CANDIDATE_DETAIL_ITEMS_PER_FRESH_PHASE,
      served_item_ids: [...phaseItemIds],
      already_read_item_ids: alreadyReadItemIds,
      requested_item_ids: itemIds,
      remaining_item_capacity: Math.max(
        0,
        MAX_CANDIDATE_DETAIL_ITEMS_PER_FRESH_PHASE - this.liveDetailPhaseViews.size,
      ),
      required_action: "stage_coverage_review_draft",
      action: "Persist bounded typed records for the already returned exact leaf details now. The successful stage handoff starts a fresh provider session for the next remaining obligations; do not repeat the same view or fan out more detail calls in this phase. A business-to-full expansion counts as another detail view against the same 24-view context budget.",
    };
  }

  async finalizeMechanicallyReady(): Promise<ToolResponse> {
    const candidateChanged = await this.currentCandidateChangeReceipt();
    if (candidateChanged) return candidateChanged;
    if (await pathExists(this.sealedPath)) {
      // Legacy seals may lack review-scope.json; persist the controller scope so
      // readSealedCoverageReview can revalidate under the same narrow window.
      if (!(await readPersistedReviewScope(this.root))) {
        await writePersistedReviewScope(this.root, this.reviewScope);
      }
      return { ok: true, already_sealed: true };
    }
    const [content, state] = await Promise.all([
      readFile(this.workingPath, "utf8"),
      this.readState(),
    ]);
    let value = strictJsonParse(content);
    const contextBlock = await this.relatedContextBlock(value, state);
    if (contextBlock) return contextBlock;
    const deliveryIssues = await this.candidateSectionDeliveryIssues(state);
    if (deliveryIssues.length > 0) {
      return {
        ok: false,
        error: "coverage_candidate_sections_incomplete",
        candidate_section_delivery: deliveryIssues,
        required_action: "read_every_required_candidate_section_page_and_nested_section_ref_before_sealing",
      };
    }
    if (isRecord(value)) {
      const spanMaterialized = materializeCoverageSpanBindings(value, this.evidence, this.spanRegistry);
      if (spanMaterialized.issues.length > 0) {
        return { ok: false, error: "coverage_review_span_unresolved", issues: spanMaterialized.issues };
      }
      if (spanMaterialized.materialized.length) {
        value = spanMaterialized.value;
        await this.replaceWorking(prettyJson(value));
        await this.appendEvent("coverage_span_binding_materialized", {
          source: "finalize_mechanically_ready",
          bindings: spanMaterialized.materialized,
        });
      }
      const normalized = normalizeCoverageReviewMechanicalFields(value as Record<string, unknown>);
      if (normalized.changed_record_count > 0) {
        value = normalized.value;
        await this.replaceWorking(prettyJson(value));
      }
      const healed = autoRepairCoverageFragments(value, this.evidence);
      if (healed.repairs.length) {
        value = healed.value;
        await this.replaceWorking(prettyJson(value));
        await this.appendEvent("coverage_fragment_auto_repaired", {
          source: "finalize_mechanically_ready",
          repairs: healed.repairs,
        });
      }
      if (isRecord(value)) {
        const lineage = normalizeCoverageReviewFindingLineage(
          value as unknown as DomainCoverageReview,
          this.priorReview,
          this.priorCandidatePlan,
          this.candidatePlan,
        );
        if (lineage.changed) {
          value = lineage.review;
          await this.replaceWorking(prettyJson(value));
          await this.appendEvent("coverage_finding_lineage_normalized", {
            source: "finalize_mechanically_ready",
            findings: lineage.review.findings.map((finding) => ({
              finding_id: finding.finding_id,
              judgment_id: finding.judgment_id,
              finding_origin: finding.finding_origin,
              prior_finding_id: finding.prior_finding_id ?? "",
            })),
          });
        }
      }
      if (isRecord(value)) {
        const ownership = normalizeCoverageReviewFindingOwnership(value, this.candidatePlan, this.evidence);
        if (ownership.changed) {
          value = ownership.value;
          await this.replaceWorking(prettyJson(value));
          await this.appendEvent("coverage_finding_ownership_normalized", {
            source: "finalize_mechanically_ready",
            status: ownership.value.status,
          });
        }
      }
    }
    const candidatePlan = this.candidatePlan;
    const checkpoint = coverageCheckpoint(
      value,
      this.evidence,
      candidatePlan,
      new Set(state.opened_evidence_ids),
      this.reviewScope,
      this.spanRegistry,
    );
    if (checkpoint.ready_for_validation !== true) {
      return toolReject({
        error: "coverage_review_not_mechanically_ready",
        instruction: "Read coverage_checkpoint.readiness_issues. Open remaining mandatory evidence and stage missing coverage records before validating.",
        coverage_checkpoint: checkpoint,
        required_action: "complete_mandatory_set_from_checkpoint",
        candidate_read_tool: "get_coverage_review_contract",
      });
    }
    const preflight = validateCoverageReview(
      value,
      this.planFingerprint,
      this.evidence,
      new Set(state.opened_evidence_ids),
      candidatePlan,
      this.reviewScope,
      this.spanRegistry,
    );
    if (!preflight.ok) {
      return toolReject({
        error: "coverage_review_local_validation",
        instruction: "Repair the coverage draft using issues. Do not seal until local validation is clean.",
        issues: preflight.issues,
        required_action: "repair_using_returned_issues",
        candidate_read_tool: "read_working_coverage_review",
      });
    }
    const validation = await this.validateWorking();
    if (validation.ok !== true || typeof validation.fingerprint !== "string") return validation;
    return this.seal(validation.fingerprint);
  }

  async appendPiEvent(payload: unknown): Promise<void> {
    await this.appendEvent("pi_sdk_event", payload);
  }

  private async appendEvent(eventType: string, payload: unknown): Promise<void> {
    const event = await this.withStateLock(async () => {
      const state = await readJson<CoverageReviewState>(this.statePath);
      const next = {
        schema_version: "coverage-review-event/v1",
        sequence: state.next_event_sequence,
        timestamp: new Date().toISOString(),
        runtime: state.agent_runtime,
        event_type: eventType,
        plan_fingerprint: this.planFingerprint,
        payload,
      };
      await appendText(this.transcriptPath, `${JSON.stringify(next)}\n`);
      state.next_event_sequence += 1;
      await atomicWriteJson(this.statePath, state);
      return next;
    });
    await this.workspace.appendEvent("coverage_review_event", event);
  }

  async dispatch(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResponse> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    await this.appendEvent("tool_execution_start", { tool_name: name, input });
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    let output: ToolResponse;
    try {
      const navigationCandidateChanged = ["resolve_document_reference", "resolve_external_standard_reference", "list_coverage_reference_targets", "search_review_document", "open_review_document"].includes(name)
        ? await this.currentCandidateChangeReceipt()
        : undefined;
      if (navigationCandidateChanged) {
        output = navigationCandidateChanged;
      } else {
    switch (name) {
      case "get_coverage_review_contract":
        {
          const candidatePlan = this.candidatePlan;
          const obligations = coverageReviewObligations(this.evidence, candidatePlan, this.reviewScope);
          const allItems = materializedFinalItems(candidatePlan, this.evidence);
          const priorReview = this.priorReview
            ? normalizeCoverageReviewFindingLineage(
                this.priorReview,
                undefined,
                undefined,
                this.priorCandidatePlan,
              ).review
            : undefined;
          output = {
            ok: true,
            target_scope: this.evidence.scope,
            review_scope: this.reviewScope,
            prompt_protocol_version: PROMPT_SUITE_VERSION,
            review_model_protocol: LEGACY_COVERAGE_REVIEW_PROTOCOL,
            review_finalization_protocol: COVERAGE_FINALIZATION_PROTOCOL,
            coverage_obligations: obligations,
            source_investigation: {
              source_first_instruction: "First identify applicable source rules, then compare the actual fields of scoped items. A populated field is not proof that supplementary conditions were preserved. Reuse shared source reads across items.",
              scoped_item_ids: obligations.required_item_ids,
              field_checks: ["requirement", "method", "quantity/sampling", "applicability", "lot_basis"],
              governing_context_evidence_ids: this.evidence.scope.governing_context_evidence_ids ?? [],
              fallback_item_ids: allItems.filter(item => obligations.required_item_ids.includes(item.item_id) && item.sampling.status === "fallback").map(item => item.item_id),
              exhaustive: false,
              document_search_tool: "search_review_document",
              document_read_tool: "open_review_document",
              read_tool: "batch_open_review_evidence",
              instruction: "Use search_review_document and open_review_document beyond the nominated manifest. Governing-context candidates and fallback_item_ids are navigation aids, not the investigation boundary. " + SOURCE_CONTEXT_INVESTIGATION,
            },
            related_context_instruction: RELATED_CONTEXT_INSTRUCTION,
            reference_target_catalog_tool: "list_coverage_reference_targets",
            candidate_inventory: {
              total_leaf_count: allItems.length,
              scoped_leaf_count: obligations.required_item_ids.length,
              out_of_scope_leaf_count: allItems.length - obligations.required_item_ids.length,
              total_table_leaf_count: allItems.filter((item) => item.table_semantics !== null).length,
            },
            review_lineage: priorReview
              ? {
                  source_plan_fingerprint: priorReview.plan_fingerprint,
                  prior_findings: priorReview.findings.map((finding) => ({
                    defect_field: finding.defect_field ?? null,
                    finding_id: finding.finding_id,
                    judgment_id: finding.judgment_id,
                    evidence_id: finding.evidence_id,
                    exact_fragment: finding.exact_fragment,
                    affected_item_ids: finding.affected_item_ids,
                    description: finding.description,
                    reason: finding.reason,
                  })),
                  instruction: "Recheck every prior judgment identity against the repaired candidate. If fixed, explicitly say so in summary and do not refile that defect. New defects must identify their own defect_field and exact source anchor; do not relabel them as the old sampling/requirement defect merely because they affect the same leaf. Before a delta semantic finding, read_candidate_related_context to check same-source allocations. Do not demand that one split leaf repeat its siblings' requirements.",
                }
              : {
                  source_plan_fingerprint: "",
                  prior_findings: [],
                  instruction: "This is the first review of these judgments. Produce the complete current worklist after reading every scoped leaf and mandatory evidence; do not stop after the first defect in a leaf or referenced rule.",
                },
            scope_instruction: "required_item_ids is the review worklist, not the full candidate inventory. Unlisted items remain in the result and are not re-reviewed here. Do not infer missing items or recreate table rows from their absence in this scoped list; report only source-proven defects within this review's obligations.",
            searchable_evidence_count: this.evidence.evidence.length,
            review_template: initialReview(this.planFingerprint, this.evidence),
            instruction: this.reviewScope.mode === "ledger_gap"
              ? `底账缺口审查：只检查 gap_clause_ids ${JSON.stringify(this.reviewScope.gap_clause_ids ?? [])} 以及列出的 required_item_ids / uncovered_primary_evidence_ids；不要重读已覆盖条文。引用证据必须绑定 span_id，分批写入类型化记录后再 sealed。${COVERAGE_EVIDENCE_ACCESS_GUIDANCE_ZH}\n\n${REFERENCE_ACTION_GUIDANCE_ZH}`
              : this.reviewScope.mode === "risk_delta"
                ? `风险增量审查：确定性 coverage risk gate 已经核销未列出的 clean leaves。只审核 coverage_obligations.required_item_ids 和 uncovered_primary_evidence_ids；范围外叶仅能通过 read_candidate_related_context 作为只读关联上下文查看，不得扩大审核清单。你的职责是判断这些少量疑点是否真的存在语义缺失、错误合并/拆分、引用/抽样适用性或来源污染。引用证据必须绑定 span_id。${COVERAGE_EVIDENCE_ACCESS_GUIDANCE_ZH}\n\n${REFERENCE_ACTION_GUIDANCE_ZH}`
                : `格式不可信。对范围内每个最终验收叶写一条审查记录；一条记录可绑定多个精确证据片段。${COVERAGE_EVIDENCE_ACCESS_GUIDANCE_ZH} 按确定性 obligations 批量处理资源，不要逐个调用。若证据依赖尚未登记的同文档条、节、表或附录，必须调用 resolve_document_reference；Harness 不根据中文句式猜引用。只为 obligations.uncovered_primary_evidence_ids 列出的未覆盖主证据增加 shared_context 或 irrelevant。handled_context_evidence_ids / handled_ignored_evidence_ids 已由候选 evidence_dispositions 交代，不要再当 uncovered_primary 处理，也不要因此打 semantic_coverage_gap。分类 finding 时，仅 semantic_coverage_gap 交回模型修复；compiler_materialization_defect 属于 Harness；soft_classification_disagreement 和 source_glyph_review 不阻塞。条件、方法、抽样分支和引用得到的判定内容必须绑定回受影响叶，不能压平 provenance。每个新阶段最多读取 24 个不同叶详情，工具要求 stage_coverage_review_draft 时立即持久化。\n\n${REFERENCE_ACTION_GUIDANCE_ZH}`,
          };
        }
        break;
      case "open_review_evidence":
        output = await this.openEvidence(String(input.evidence_id ?? ""));
        break;
      case "batch_open_review_evidence":
        output = await this.batchOpenEvidence(input.evidence_ids);
        break;
      case "locate_review_span":
        output = await this.locateReviewSpan(input);
        break;
      case "resolve_document_reference":
        {
          const target = input.target && typeof input.target === "object" && !Array.isArray(input.target)
            ? input.target as Record<string, unknown>
            : {};
          output = await resolveAndRegisterDocumentReference(
            this.workspace,
            await this.referenceEvidence(),
            {
              ...(typeof input.origin_span_id === "string" ? { origin_span_id: input.origin_span_id } : {}),
              ...(Array.isArray(input.origin_span_ids) ? { origin_span_ids: input.origin_span_ids.map(String) } : {}),
              origin_field: (typeof input.origin_field === "string"
                ? input.origin_field
                : "requirement") as "name" | "requirement" | "method" | "quantity" | "note" | "sampling",
              ...(typeof input.reference_literal_span_id === "string"
                ? { reference_literal_span_id: input.reference_literal_span_id }
                : {}),
              ...(Array.isArray(input.reference_literal_span_ids)
                ? { reference_literal_span_ids: input.reference_literal_span_ids.map(String) }
                : {}),
              raw_reference: String(input.raw_reference ?? ""),
              ...(typeof input.normalized_reference === "string" ? { normalized_reference: input.normalized_reference } : {}),
              target: {
                ...(typeof target.source_id === "string" ? { source_id: target.source_id } : {}),
                kind: String(target.kind ?? "") as DocumentReferenceKind,
                number: String(target.number ?? ""),
                ...(typeof target.paragraph === "string" ? { paragraph: target.paragraph } : {}),
                ...(typeof target.candidate_start_line === "number"
                  ? { candidate_start_line: target.candidate_start_line }
                  : {}),
              },
              relation: String(input.relation ?? ""),
            },
            true,
          );
          this.spanRegistry = await this.workspace.readSourceSpanRegistry();
          output = { ...output, registration_phase: "review_observation", candidate_evidence_unchanged: true,
            observation_instruction: "仅保存审核观察，不改变候选依据。若需采用被引内容，在原引用所在证据上登记 finding，保留已有漏项；进入修复后才正式登记、重新编译校验和复查。整章定位不等于采用整章项目。" };
          if (output.error === "origin_span_does_not_contain_raw_reference") {
            const actual = output.actual as { origin_span: { evidence_id: string } };
            const access = (await this.evidenceAccessIndex(await this.referenceEvidence())).get(actual.origin_span.evidence_id);
            const isolated = access?.access_mode === "isolated_reference";
            const readTool = isolated ? "read_reference_facts" : "open_review_evidence";
            output = { ...output,
              next_tool: readTool,
              next_tool_arguments: isolated ? { target_key: access.target_key } : { evidence_id: actual.origin_span.evidence_id },
              next_tools: [readTool, ...(isolated ? [] : ["locate_review_span"]), "resolve_document_reference", "search_review_document"],
              context_investigation_tools: [{ name: "search_review_document", arguments: { cursor: 0 } }],
              instruction: `${output.instruction} 用 next_tool_arguments 按访问策略读取来源。普通来源的确切片段用 locate_review_span 定位；隔离引用使用 read_reference_facts 返回的 span_id。调查共同规则时用 search_review_document 分页浏览，再按返回工具打开原文；不因目录或邻接推定适用，不重试相同的无匹配调用。`,
            };
          }
          if (output.ok === true) {
            const referenceEvidence = await this.referenceEvidence();
            const occurrence = referenceEvidence.reference_occurrences.find((entry) => entry.occurrence_id === output.occurrence_id);
            if (occurrence) {
              const policy = await assignReferenceAnalysisPolicy(this.workspace, referenceEvidence, occurrence, "coverage");
              output = { ...output, ...policy, analysis_status: "not_required" };
            }
          }
        }
        break;
      case "list_coverage_reference_targets":
        output = await this.listCoverageReferenceTargets(input);
        break;
      // Compatibility-only: new coverage sessions do not receive this tool.
      case "resolve_external_standard_reference":
        output = await registerExternalStandardReference(this.workspace, await this.referenceEvidence(), input, true);
        if (output.ok === true) {
          this.spanRegistry = await this.workspace.readSourceSpanRegistry();
        }
        break;
      case "read_document_reference_evidence":
        output = await readInlineReferenceEvidencePage(
          this.workspace,
          await this.referenceEvidence(),
          String(input.target_key ?? ""),
          Number(input.cursor ?? 0),
          Number(input.limit ?? 24),
          "coverage",
        );
        break;
      case "read_reference_facts":
        output = await readAnalyzedReferenceCatalog(
          this.workspace,
          await this.referenceEvidence(),
          String(input.target_key ?? ""),
          {
            entry_ids: Array.isArray(input.entry_ids) ? input.entry_ids.map(String) : undefined,
            row_cursor: input.row_cursor as number | undefined, row_offset: input.row_offset as number | undefined, catalog_cursor: input.catalog_cursor as number | undefined,
            skip: Array.isArray(input.skip)
              ? input.skip.flatMap((entry) => {
                  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
                  const record = entry as Record<string, unknown>;
                  return [{ entry_id: String(record.entry_id ?? ""), reason: String(record.reason ?? "") }];
                })
              : undefined,
            skip_rest: input.skip_rest !== null && typeof input.skip_rest === "object" && !Array.isArray(input.skip_rest)
              ? { reason: String((input.skip_rest as Record<string, unknown>).reason ?? "") }
              : undefined,
            resolve_rows: Array.isArray(input.resolve_rows)
              ? input.resolve_rows.flatMap((entry) => {
                  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
                  const record = entry as Record<string, unknown>;
                  return [{ entry_id: String(record.entry_id ?? ""), row_index: Number(record.row_index ?? 0) }];
                })
              : undefined,
          },
          "coverage",
          this.referenceCatalogRuleAsk,
          signal,
        );
        if (output.ok === true && Array.isArray(output.resolved_rows)) {
          // Catalog resolution only returns verified spans from opened entries.
          // Record those exact rows in the review's own read ledger as well;
          // target-phase reads and skipped catalog entries are not review reads.
          const resolvedEvidenceIds = output.resolved_rows.flatMap((row) =>
            isRecord(row) && typeof row.evidence_id === "string" && typeof row.span_id === "string"
              ? [row.evidence_id]
              : []
          );
          if (resolvedEvidenceIds.length) {
            if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
            let previousOpenedEvidenceIds: string[] | undefined;
            const updated = await this.updateState((state) => {
              if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
              previousOpenedEvidenceIds = state.opened_evidence_ids;
              state.opened_evidence_ids = [...new Set([...state.opened_evidence_ids, ...resolvedEvidenceIds])];
            });
            if (signal?.aborted) {
              await this.updateState((state) => {
                if (sha256Json(state.opened_evidence_ids) !== sha256Json(updated.opened_evidence_ids)) return;
                state.opened_evidence_ids = previousOpenedEvidenceIds ?? [];
              });
              throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
            }
          }
        }
        break;
      case "search_review_document":
      case "open_review_document":
        output = await this.investigateDocument(name, input);
        break;
      case "search_review_evidence":
        output = await this.searchEvidence(
          String(input.query ?? ""),
          Number(input.cursor ?? 0),
        );
        break;
      case "read_candidate_related_context":
        output = await this.readRelatedContext(input);
        break;
      case "read_candidate_plan":
        {
          output = compactCandidateInventory(
            this.candidatePlan,
            this.evidence,
            this.planFingerprint,
            this.reviewScope,
            input.cursor === undefined ? 0 : input.cursor,
            input.max_items === undefined ? MAX_CANDIDATE_INVENTORY_ITEMS : input.max_items,
          );
        }
        break;
      case "read_candidate_leaf_details":
        {
          output = this.liveDetailPhaseBudgetBlock(input.item_ids, input.view) ?? await (async () => {
            const [state, referencePolicies] = await Promise.all([
              this.readState(),
              this.referenceAnalysisPolicies(this.evidence),
            ]);
            // Parallel tool calls can all pass the pre-await fast path. Recheck
            // after the serialized state read, then generate and reserve without
            // another await so no two calls can overrun the phase allowance.
            const concurrentBlock = this.liveDetailPhaseBudgetBlock(input.item_ids, input.view);
            if (concurrentBlock) return concurrentBlock;
            const result = candidateLeafDetails(
              this.candidatePlan,
              this.evidence,
              this.planFingerprint,
              new Set(state.opened_evidence_ids),
              referencePolicies,
              this.reviewScope,
              input.item_ids,
              input.view === "business",
            );
            if (coverageDetailReadConsumesFreshPhaseBudget(result) && this.liveDetailPhaseItemIds) {
              for (const itemId of result.requested_item_ids as string[]) {
                this.liveDetailPhaseItemIds.add(itemId);
                this.liveDetailPhaseViews.add(`${input.view === "business" ? "business" : "full"}:${itemId}`);
              }
            }
            return result;
          })();
        }
        break;
      case "read_candidate_leaf_text":
        {
          const [state, referencePolicies] = await Promise.all([
            this.readState(),
            this.referenceAnalysisPolicies(this.evidence),
          ]);
          output = candidateLeafText(
            this.candidatePlan,
            this.evidence,
            this.planFingerprint,
            new Set(state.opened_evidence_ids),
            referencePolicies,
            this.reviewScope,
            input,
          );
        }
        break;
      case "read_candidate_leaf_section":
        {
        const referencePolicies = await this.referenceAnalysisPolicies(this.evidence);
        output = await this.withStateLock(async () => {
          const state = await readJson<CoverageReviewState>(this.statePath);
          const page = candidateLeafSectionPage(
            this.candidatePlan,
            this.evidence,
            this.planFingerprint,
            new Set(state.opened_evidence_ids),
            referencePolicies,
            this.reviewScope,
            state.candidate_section_delivery,
            input,
          );
          if (page.delivered) {
            const ledgers = state.candidate_section_delivery ?? {};
            const leaf = ledgers[page.delivered.candidate_snapshot_id] ?? {
              item_id: page.delivered.item_id,
              sections: {},
            };
            const previous = leaf.sections[page.delivered.section.section_ref];
            const nextUnitIndex = Math.max(previous?.next_unit_index ?? 0, page.delivered.next_unit_index);
            leaf.sections[page.delivered.section.section_ref] = {
              section_sha256: page.delivered.section.section_sha256,
              total_units: page.delivered.section.unit_count,
              next_unit_index: nextUnitIndex,
              complete: nextUnitIndex >= page.delivered.section.unit_count,
            };
            ledgers[page.delivered.candidate_snapshot_id] = leaf;
            state.candidate_section_delivery = ledgers;
            await atomicWriteJson(this.statePath, state);
          }
          return page.output;
        });
        }
        break;
      case "read_working_coverage_review":
        {
          const [content, state] = await Promise.all([
            readFile(this.workingPath, "utf8"),
            this.readState(),
          ]);
          const value = strictJsonParse(content) as DomainCoverageReview;
          const candidatePlan = this.candidatePlan;
          const openedEvidenceIds = new Set(state.opened_evidence_ids);
          const checkpoint = coverageCheckpoint(
            value,
            this.evidence,
            candidatePlan,
            openedEvidenceIds,
            this.reviewScope,
            this.spanRegistry,
          );
          const localPreflight = checkpoint.ready_for_validation === true
            ? validateCoverageReview(
                value,
                this.planFingerprint,
                this.evidence,
                openedEvidenceIds,
                candidatePlan,
                this.reviewScope,
              )
            : undefined;
          output = {
            ok: true,
            review_summary: {
              status: value.status,
              summary: value.summary,
              semantic_coverage_count: value.semantic_coverage.length,
              finding_count: value.findings.length,
              working_sha256: sha256Text(content),
            },
            record_inventory: {
              coverage_ids: value.semantic_coverage.map((entry) => entry.coverage_id),
              finding_ids: value.findings.map((entry) => entry.finding_id),
            },
            coverage_checkpoint: checkpoint,
            candidate_section_delivery: await this.candidateSectionDeliveryIssues(state),
            related_context_delivery: state.related_context_delivery ?? {},
            related_context_issues: this.relatedContextIssues(value, state),
            ...(localPreflight
              ? { local_preflight: { ok: localPreflight.ok, issue_count: localPreflight.issues.length, issues: boundedCoverageIssues(localPreflight.issues) } }
              : {}),
          };
        }
        break;
      case "replace_working_coverage_review":
        output = await this.replaceWorking(String(input.content ?? ""));
        break;
      case "patch_working_coverage_review":
        output = await this.patchWorking(input.operations as JsonPatchOperation[]);
        break;
      case "stage_coverage_review_draft":
        output = await this.stageWorking(input);
        break;
      case "validate_coverage_review":
        output = await this.validateWorking();
        break;
      case "seal_coverage_review":
        output = await this.seal(String(input.fingerprint ?? ""));
        break;
      default:
          output = toolReject({
            error: "unknown_coverage_review_tool",
            instruction: "Use a tool listed by get_coverage_review_contract. Do not invent tool names.",
            actual_tool: name,
            candidate_read_tool: "get_coverage_review_contract",
          });
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      output = catchToolReject(error, "coverage_review_tool_rejected");
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    await this.appendEvent("tool_execution_end", { tool_name: name, output });
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    return output;
  }

  private async evidenceAccessIndex(
    referenceEvidence: EvidenceManifest,
  ): Promise<Map<string, CoverageEvidenceAccessMetadata>> {
    const state = await this.workspace.readState();
    const policies = projectReferenceAnalysisPolicies(
      referenceEvidence,
      state.reference_analysis_modes,
      "coverage",
    );

    const accessByEvidenceId = new Map<string, CoverageEvidenceAccessMetadata>();
    const isolatedDocumentOccurrences: Array<{
      occurrence: EvidenceManifest["reference_occurrences"][number];
      access: Extract<CoverageEvidenceAccessMetadata, { access_mode: "isolated_reference" }>;
    }> = [];
    for (const occurrence of referenceEvidence.reference_occurrences) {
      if (occurrence.status !== "resolved") continue;
      const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
      const policy = policies.get(targetKey);
      if (!policy) continue;
      const access: CoverageEvidenceAccessMetadata = policy.analysis_mode === "isolated"
        ? {
            access_mode: "isolated_reference",
            read_tool: "read_reference_facts",
            open_review_evidence_allowed: false,
            target_key: targetKey,
          }
        : {
            access_mode: "inline_reference",
            read_tool: "open_review_evidence",
            open_review_evidence_allowed: true,
            target_key: targetKey,
          };
      for (const evidenceId of occurrence.target_evidence_ids) {
        const existing = accessByEvidenceId.get(evidenceId);
        if (
          !existing
          || (
            existing.access_mode !== "isolated_reference"
            && access.access_mode === "isolated_reference"
          )
        ) {
          accessByEvidenceId.set(evidenceId, access);
        }
      }
      if (access.access_mode === "isolated_reference"
        && referenceOccurrenceTargetsDocument(occurrence, referenceEvidence.source.sha256)) {
        isolatedDocumentOccurrences.push({ occurrence, access });
      }
    }
    if (isolatedDocumentOccurrences.length === 0) return accessByEvidenceId;
    const source = await readFile(this.workspace.sourceMarkdownPath, "utf8");
    const sourceRangesFor = createEvidenceSourceRangeResolver(
      source,
      buildDocumentEvidence(source, referenceEvidence.source.file_name),
    );
    const rangesByEvidenceId = new Map(
      referenceEvidence.evidence.map((record) => [record.evidence_id, sourceRangesFor(record)]),
    );
    for (const { occurrence, access } of isolatedDocumentOccurrences) {
      const targetRanges = occurrence.target_evidence_ids.flatMap((evidenceId) => {
        return rangesByEvidenceId.get(evidenceId) ?? [];
      });
      for (const record of referenceEvidence.evidence) {
        if (accessByEvidenceId.get(record.evidence_id)?.access_mode === "isolated_reference") continue;
        const recordRanges = rangesByEvidenceId.get(record.evidence_id) ?? [];
        if (targetRanges.some((targetRange) =>
          recordRanges.some((recordRange) => sourceRangesOverlap(targetRange, recordRange))
        )) {
          accessByEvidenceId.set(record.evidence_id, access);
        }
      }
    }
    return accessByEvidenceId;
  }

  async currentCandidateChangeReceipt(): Promise<CoverageControllerRebuildReceipt | undefined> {
    const currentRevision = await this.workspace.readState();
    return currentRevision.last_valid_fingerprint === this.planFingerprint
      && currentRevision.last_valid_plan_sha256 === this.candidatePlanSha256
      ? undefined
      : coverageCandidateChangedReceipt(this.planFingerprint, currentRevision);
  }

  private evidenceAccess(
    record: EvidenceRecord,
    accessByEvidenceId: ReadonlyMap<string, CoverageEvidenceAccessMetadata>,
  ): CoverageEvidenceAccessMetadata {
    return accessByEvidenceId.get(record.evidence_id) ?? {
      access_mode: "direct",
      read_tool: "open_review_evidence",
      open_review_evidence_allowed: true,
    };
  }

  private isolatedEvidenceFeedback(targetKey: string): ToolResponse {
    return {
      ok: false,
      error: "isolated_reference_body_access_forbidden",
      access_mode: "isolated_reference",
      read_tool: "read_reference_facts",
      open_review_evidence_allowed: false,
      target_key: targetKey,
      required_action: "call_read_reference_facts",
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: targetKey },
      writable_parameters: ["target_key"],
      durable_mutation: false,
      budget_consumed: false,
      instruction: "该证据属于 isolated_reference，不能用 open_review_evidence、batch_open_review_evidence 或 locate_review_span 读取。原样复制本回条的 target_key 调用 read_reference_facts；先只传 target_key 取得目录，再复制模型实际需要的机器 entry_id 打开条目。",
    };
  }

  private openedEvidenceReceipt(
    record: EvidenceRecord,
    access: CoverageEvidenceAccessMetadata,
  ): ToolResponse {
    const registeredSpans = (this.spanRegistry?.spans ?? [])
      .filter((span) => span.evidence_id === record.evidence_id || span.atom_id === record.evidence_id)
      .map((span) => ({
        span_id: span.span_id,
        start: span.start,
        end: span.end,
        exact_fragment: record.text.slice(span.start, span.end),
      }));
    return {
      ok: true,
      ...access,
      evidence: record,
      registered_spans: registeredSpans,
      instruction: "用 registered_spans 中的 evidence_id、span_id 绑定证据；若没有所需精确片段，再用 locate_review_span 登记。exact_fragment 由 harness 按 span 偏移生成，不要手工重写原文。",
    };
  }

  private async openEvidence(evidenceId: string): Promise<ToolResponse> {
    const referenceEvidence = await this.referenceEvidence();
    const record = referenceEvidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (!record) {
      return toolReject({
        error: "unknown_evidence_id",
        instruction: "先调用 get_coverage_review_contract 或 search_review_evidence，从公开回条逐字复制 evidence_id；不要编造证据 ID。",
        evidence_id: evidenceId,
        candidate_read_tool: "get_coverage_review_contract",
      });
    }
    const access = this.evidenceAccess(record, await this.evidenceAccessIndex(referenceEvidence));
    if (access.access_mode === "isolated_reference") {
      return this.isolatedEvidenceFeedback(access.target_key);
    }
    await this.updateState((state) => {
      state.opened_evidence_ids = [...new Set([...state.opened_evidence_ids, evidenceId])];
    });
    return this.openedEvidenceReceipt(record, access);
  }

  /**
   * 复核端原来只有单条 open_review_evidence。实测 GB/T 50312 一轮里 41 个复核会话
   * 共调它 1088 次（每次会话中位 27 次），占复核全部工具调用的 85%；复核合计
   * 99.9 分钟，是整批 186 分钟 agent 时间里最大的一块。单次调用本身只要 0.2 秒，
   * 时间全花在每条之间的模型往返上——作者端早就有 batch_open_evidence，
   * 复核端没有，纯粹是漏了。
   */
  private async batchOpenEvidence(evidenceIds: unknown): Promise<ToolResponse> {
    if (
      !Array.isArray(evidenceIds)
      || evidenceIds.length < 1
      || evidenceIds.length > 50
      || evidenceIds.some((entry) => typeof entry !== "string" || !entry.trim())
    ) {
      return {
        ok: false,
        error: "batch_review_evidence_ids_invalid",
        writable_parameters: ["evidence_ids"],
        durable_mutation: false,
        budget_consumed: false,
        instruction: "evidence_ids 必须包含 1～50 个非空证据 ID；从公开目录或检索回条逐字复制后重试。",
      };
    }
    const requested = [...new Set(evidenceIds)];
    const referenceEvidence = await this.referenceEvidence();
    const records = requested.map((evidenceId) =>
      referenceEvidence.evidence.find((record) => record.evidence_id === evidenceId)
    );
    const unknownEvidenceIds = requested.filter((_evidenceId, index) => !records[index]);
    if (unknownEvidenceIds.length > 0) {
      return {
        ok: false,
        error: "batch_review_evidence_not_found",
        unknown_evidence_ids: unknownEvidenceIds,
        next_tool: "get_coverage_review_contract",
        tool_arguments: {},
        retry_tool: "batch_open_review_evidence",
        writable_parameters: ["evidence_ids"],
        durable_mutation: false,
        budget_consumed: false,
        instruction: "本批次未打开任何证据，也未登记 span。先调用 get_coverage_review_contract 或 search_review_evidence，从公开回条逐字复制真实 evidence_id；只修正 evidence_ids 后重试。",
      };
    }

    const accessByEvidenceId = await this.evidenceAccessIndex(referenceEvidence);
    const routed = (records as EvidenceRecord[]).map((record) => ({
      record,
      access: this.evidenceAccess(record, accessByEvidenceId),
    }));
    const isolatedGroups = new Map<string, string[]>();
    for (const { record, access } of routed) {
      if (access.access_mode !== "isolated_reference") continue;
      isolatedGroups.set(
        access.target_key,
        [...(isolatedGroups.get(access.target_key) ?? []), record.evidence_id],
      );
    }
    if (isolatedGroups.size > 0) {
      const routedReferences = [...isolatedGroups].map(([targetKey, ids]) => ({
        target_key: targetKey,
        evidence_ids: ids,
        access_mode: "isolated_reference",
        read_tool: "read_reference_facts",
        open_review_evidence_allowed: false,
        next_tool: "read_reference_facts",
        tool_arguments: { target_key: targetKey },
      }));
      const openableEvidenceIds = routed
        .filter(({ access }) => access.open_review_evidence_allowed)
        .map(({ record }) => record.evidence_id);
      return {
        ok: false,
        error: "batch_review_evidence_contains_isolated_reference",
        target_key: routedReferences[0]!.target_key,
        target_keys: routedReferences.map((route) => route.target_key),
        routed_references: routedReferences,
        openable_evidence_ids: openableEvidenceIds,
        next_tool: "read_reference_facts",
        tool_arguments: routedReferences[0]!.tool_arguments,
        retry_tool: openableEvidenceIds.length > 0 ? "batch_open_review_evidence" : "read_reference_facts",
        retry_arguments: openableEvidenceIds.length > 0
          ? { evidence_ids: openableEvidenceIds }
          : routedReferences[0]!.tool_arguments,
        writable_parameters: ["evidence_ids"],
        durable_mutation: false,
        budget_consumed: false,
        instruction: "本批次已在打开任何证据、登记 span 或写入 opened checkpoint 前原子拒绝。每个 routed_references 项都用其中的 target_key 调用 read_reference_facts；openable_evidence_ids 可另行传给 batch_open_review_evidence。不要逐个重试被隔离的 evidence_id。",
      };
    }

    await this.updateState((state) => {
      state.opened_evidence_ids = [...new Set([
        ...state.opened_evidence_ids,
        ...requested,
      ])];
    });
    return {
      ok: true,
      opened: routed.map(({ record, access }) => this.openedEvidenceReceipt(record, access)),
      instruction: "本批次已打开全部证据。用各项 registered_spans 中的 evidence_id、span_id 绑定；缺少所需精确片段时再用 locate_review_span 登记，不要手工重写原文。",
    };
  }

  private async locateReviewSpan(input: Record<string, unknown>): Promise<ToolResponse> {
    const evidenceId = String(input.evidence_id ?? "");
    const quote = String(input.quote ?? "");
    const prefix = typeof input.prefix === "string" ? input.prefix : "";
    const suffix = typeof input.suffix === "string" ? input.suffix : "";
    const referenceEvidence = await this.referenceEvidence();
    const record = referenceEvidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (!record) {
      return toolReject({
        error: "unknown_evidence_id",
        instruction: "Open or list review evidence first and copy an id from that inventory. Do not invent evidence ids.",
        evidence_id: evidenceId,
        candidate_read_tool: "get_coverage_review_contract",
      });
    }
    const access = this.evidenceAccess(record, await this.evidenceAccessIndex(referenceEvidence));
    if (access.access_mode === "isolated_reference") {
      return this.isolatedEvidenceFeedback(access.target_key);
    }
    if (!quote.trim()) return { ok: false, error: "coverage_span_quote_required" };
    const registry = this.spanRegistry ?? initialSourceSpanRegistry(this.evidence.evidence_fingerprint);
    const source: ImmutableTextSource = {
      source_id: record.evidence_id,
      text: record.text,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
    };
    try {
      const result = locateAndRegisterSourceQuote(registry, source, quote, { prefix, suffix });
      this.spanRegistry = result.registry;
      await atomicWriteJson(this.workspace.sourceSpanRegistryPath, result.registry);
      const span = result.spans[0]!;
      await this.appendEvent("coverage_span_registered", {
        evidence_id: record.evidence_id,
        span_id: span.span_id,
        start: span.start,
        end: span.end,
        normalized: result.normalized,
        disambiguated: result.disambiguated,
      });
      return {
        ok: true,
        evidence_id: record.evidence_id,
        span_id: span.span_id,
        start: span.start,
        end: span.end,
        exact_fragment: record.text.slice(span.start, span.end),
        normalized: result.normalized,
        instruction: "Bind this citation with {evidence_id, span_id}; the harness slices and stores the exact bytes from the span offsets.",
      };
    } catch (error) {
      if (error instanceof SourceSpanRegistryError) {
        return {
          ok: false,
          error: (typeof error.issues[0]?.code === "string"
            ? error.issues[0].code.replace(/^selector_/, "coverage_review_")
            : "coverage_review_span_locate_failed"),
          issues: error.issues.map(issue => {
            if (!isRecord(issue.details)) return issue;
            const { batch_next_tool: _batchNextTool, ...details } = issue.details;
            return { ...issue, details: { ...details,
              next_tool: "locate_review_span", retry_tool: "locate_review_span",
              ...(isRecord(details.context_read) ? {
                next_tool: "open_review_evidence", next_tool_arguments: { evidence_id: evidenceId },
                context_read: { tool: "open_review_evidence", arguments: { evidence_id: evidenceId },
                  instruction: "重新读取该证据的完整原文，核对真实相邻上下文；不可修改原文或编造边界标记。" },
              } : {}),
            } };
          }),
          instruction: isRecord(error.issues[0]?.details) && isRecord(error.issues[0].details.context_read)
            && typeof error.issues[0].details.required_action === "string" ? error.issues[0].details.required_action
            : "The quote was used only for locating and was not stored. Read the opened evidence text again and quote a passage that occurs exactly once, or add prefix/suffix context to disambiguate.",
        };
      }
      throw error;
    }
  }

  private async investigateDocument(name: string, input: Record<string, unknown>): Promise<ToolResponse> {
    const source = await readFile(this.workspace.sourceMarkdownPath, "utf8");
    const manifest = await this.referenceEvidence();
    if (sha256Text(source) !== manifest.source.sha256) return { ok: false, error: "coverage_review_source_changed",
      instruction: "Original source hash changed. Restore the immutable source and restart review for the validated candidate; do not edit candidate fields.",
      details: { path: "source", actual_sha256: sha256Text(source), expected_sha256: manifest.source.sha256, next_tool: "get_coverage_review_contract" } };
    const document = buildDocumentEvidence(source, manifest.source.file_name);
    // The full-document reader must not bypass isolated reference analysis, even
    // when an atom only partially overlaps a protected reference body.
    const protectedRanges: Array<{ start: number; end: number; target_key: string }> = [];
    const sourceRangesFor = createEvidenceSourceRangeResolver(source, document);
    const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
    const policies = await this.referenceAnalysisPolicies(manifest);
    for (const occurrence of manifest.reference_occurrences) {
      if (
        occurrence.status !== "resolved"
        || !referenceOccurrenceTargetsDocument(occurrence, manifest.source.sha256)
      ) continue;
      const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
      if (policies.get(targetKey)?.analysis_mode !== "isolated") continue;
      for (const evidenceId of occurrence.target_evidence_ids) {
        const record = evidenceById.get(evidenceId);
        if (!record) continue;
        protectedRanges.push(...sourceRangesFor(record).map((range) => ({
          ...range,
          target_key: targetKey,
        })));
      }
    }
    const resources = partitionDocumentSourceRanges(document, protectedRanges).map((range) => ({
      atom_id: range.resource_id,
      parent_atom_id: range.parent_atom_id,
      start_line: range.start_line,
      end_line: range.end_line,
      source_range: {
        source_sha256: manifest.source.sha256,
        start: range.start,
        end: range.end,
      },
      text: source.slice(range.start, range.end),
      target_keys: [...new Set(protectedRanges
        .filter((protectedRange) => sourceRangesOverlap(protectedRange, range))
        .map((protectedRange) => protectedRange.target_key))].sort(),
    }));
    const isolationRoute = (targetKeys: string[]) => ({
      access_mode: "isolated_reference" as const,
      read_tool: "read_reference_facts" as const,
      open_review_document_allowed: false,
      isolated_target_keys: targetKeys,
      next_tool: "read_reference_facts" as const,
      routed_references: targetKeys.map((targetKey) => ({
        target_key: targetKey,
        read_tool: "read_reference_facts",
        tool_arguments: { target_key: targetKey },
      })),
      ...(targetKeys.length === 1
        ? {
            target_key: targetKeys[0],
            tool_arguments: { target_key: targetKeys[0] },
          }
        : {}),
    });
    if (name === "search_review_document") {
      const query = String(input.query ?? "").trim();
      const cursor = Number(input.cursor ?? 0);
      if (!Number.isInteger(cursor) || cursor < 0) return { ok: false, error: "coverage_document_search_invalid",
        instruction: "Call search_review_document with an optional query (space-separated alternatives; omit to browse all windows) and cursor 0 or the returned next_cursor.",
        details: { path: !query ? "query" : "cursor", actual_query: query, actual_cursor: cursor, next_tool: "search_review_document" } };
      const matches = resources.flatMap(resource => {
        if (resource.target_keys.length > 0) return [];
        const match = query ? documentSearchMatch(resource.text, query) : { score: 0, offset: 0 };
        if (!match) return [];
        return [{
          atom_id: resource.atom_id,
          parent_atom_id: resource.parent_atom_id,
          start_line: resource.start_line,
          end_line: resource.end_line,
          source_range: resource.source_range,
          score: match.score,
          snippet: resource.text.slice(Math.max(0, match.offset - 100), match.offset + 200),
        }];
      }).sort((a, b) => b.score - a.score);
      return { ok: true, matches: matches.slice(cursor, cursor + 20), total_match_resources: matches.length,
        next_cursor: cursor + 20 < matches.length ? cursor + 20 : null, search_scope: "entire_original_document",
        instruction: "仅用于导航。省略 query 可无关键词筛选浏览全部可读取原始窗口。未受保护的相关 atom_id 可用 open_review_document；isolated_reference 原始范围不参与匹配、计数或哈希回传，须从 list_coverage_reference_targets 的无正文目录取得 target_key 后调用 read_reference_facts。是否适用必须依据允许读取的来源判断；无命中不证明规则不存在。" };
    }
    const resource = resources.find((candidate) => candidate.atom_id === input.atom_id);
    if (!resource) {
      const parentTargetKeys = [...new Set(resources
        .filter((candidate) => candidate.parent_atom_id === input.atom_id)
        .flatMap((candidate) => candidate.target_keys))].sort();
      if (parentTargetKeys.length) return { ok: false, error: "coverage_document_isolated_reference",
        target_keys: parentTargetKeys,
        ...isolationRoute(parentTargetKeys),
        durable_mutation: false,
        budget_consumed: false,
        instruction: "This source window overlaps an isolated reference. Read its analyzed facts with read_reference_facts; do not bypass reference isolation through the full-document reader.",
        details: { path: "atom_id", actual_value: input.atom_id, next_tool: "read_reference_facts" } };
      return { ok: false, error: "coverage_document_atom_unknown", instruction: "Use an atom_id returned by search_review_document.",
        details: { path: "atom_id", actual_value: input.atom_id, next_tool: "search_review_document" } };
    }
    if (resource.target_keys.length) return { ok: false, error: "coverage_document_isolated_reference",
      target_keys: resource.target_keys,
      source_range: resource.source_range,
      ...isolationRoute(resource.target_keys),
      durable_mutation: false,
      budget_consumed: false,
      instruction: "This source window overlaps an isolated reference. Read its analyzed facts with read_reference_facts; do not bypass reference isolation through the full-document reader.",
      details: { path: "atom_id", actual_value: input.atom_id, next_tool: "read_reference_facts" } };
    const record = await this.workspace.observeReviewSource(
      this.planFingerprint,
      resource.source_range.start,
      resource.source_range.end,
    );
    this.spanRegistry = await this.workspace.readSourceSpanRegistry();
    return { ...await this.openEvidence(record.evidence_id), registration_phase: "review_observation", candidate_evidence_unchanged: true,
      observation_instruction: "This is original-source investigation, not a new coverage obligation. If applicable content is missing, anchor a precise finding to the affected in-scope candidate source/leaf and name this observation's evidence_id and exact rule in the reason. Preserve the finding; its bound repair will adopt the observation and recompile. Do not bind an out-of-scope observation as the finding's primary evidence." };
  }

  private async searchEvidence(query: string, cursor: number): Promise<ToolResponse> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { ok: false, error: "coverage_search_query_required", instruction: "调用 search_review_evidence 时提供非空 query；空格分隔的词按任一词命中。不要修改候选或编译产物来修复检索参数。", details: { path: "query", actual_query: query, required_action: "supply_nonempty_query", next_tool: "search_review_evidence" } };
    if (!Number.isInteger(cursor) || cursor < 0) {
      return { ok: false, error: "coverage_search_cursor_invalid", instruction: "调用 search_review_evidence 时使用 cursor=0，或原样传入上一回条的非负整数 next_cursor；候选和编译产物只读。", details: { path: "cursor", actual_cursor: cursor, required_action: "use_nonnegative_integer_cursor", next_tool: "search_review_evidence" } };
    }
    const searchManifest = await this.referenceEvidence();
    const accessByEvidenceId = await this.evidenceAccessIndex(searchManifest);
    const matches = [];
    for (const record of searchManifest.evidence) {
      const access = this.evidenceAccess(record, accessByEvidenceId);
      if (access.access_mode === "isolated_reference") continue;
      const match = documentSearchMatch(record.text, query);
      if (!match) continue;
      matches.push({
        evidence_id: record.evidence_id,
        locator: record.locator,
        ...access,
        next_tool: access.read_tool,
        tool_arguments: { evidence_id: record.evidence_id },
        match_count_lower_bound: 1,
        matched_terms: match.matched_terms,
        score: match.score,
        snippets: [record.text.slice(Math.max(0, match.offset - 120), match.offset + query.trim().length + 120)],
      });
    }
    matches.sort((a, b) => b.score - a.score);
    const pageSize = 20;
    const rows = matches.slice(cursor, cursor + pageSize);
    return {
      ok: true,
      query: query.trim(),
      matches: rows,
      total_match_resources: matches.length,
      next_cursor: cursor + rows.length < matches.length ? cursor + rows.length : null,
      search_mode: "space_separated_terms_any_ranked",
      instruction: `检索覆盖 manifest 中全部可读取资源，包括指定的控制性上下文；isolated_reference 正文不参与匹配、计数或哈希回传，隔离目标从 list_coverage_reference_targets 的无正文目录进入 read_reference_facts。空格分隔的词按任一词命中；命中不证明适用或缺失。${COVERAGE_EVIDENCE_ACCESS_GUIDANCE_ZH}`,
    };
  }

  private async replaceWorking(content: string): Promise<ToolResponse> {
    if (await pathExists(this.sealedPath)) return { ok: false, error: "coverage_review_already_sealed" };
    if (Buffer.byteLength(content, "utf8") > 1_000_000) throw new Error("Coverage review exceeds 1 MB");
    const before = await readFile(this.workingPath, "utf8");
    const state = await this.readState();
    const sequence = state.next_history_sequence;
    await atomicWriteText(this.workingPath, content);
    await atomicWriteJson(join(this.historyDirectory, `${String(sequence).padStart(6, "0")}.json`), {
      schema_version: "coverage-review-history/v1",
      sequence,
      timestamp: new Date().toISOString(),
      before_sha256: sha256Text(before),
      after_sha256: sha256Text(content),
      unified_patch: createTwoFilesPatch("working.coverage-review.json", "working.coverage-review.json", before, content),
    });
    await this.updateState((current) => {
      current.next_history_sequence += 1;
      current.last_valid_review_fingerprint = "";
    });
    return { ok: true, history_sequence: sequence, after_sha256: sha256Text(content) };
  }

  private async patchWorking(operations: JsonPatchOperation[]): Promise<ToolResponse> {
    if (
      !Array.isArray(operations)
      || operations.length === 0
      || operations.length > MAX_COVERAGE_PATCH_OPERATIONS
    ) {
      return { ok: false, error: "bounded_coverage_patch_operation_limit", max_operations: MAX_COVERAGE_PATCH_OPERATIONS };
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(operations), "utf8");
    if (serializedBytes > MAX_COVERAGE_PATCH_BYTES) {
      return { ok: false, error: "bounded_coverage_patch_size_limit", serialized_bytes: serializedBytes, max_serialized_bytes: MAX_COVERAGE_PATCH_BYTES };
    }
    if (operations.some((operation) => operation?.path === "")) {
      return { ok: false, error: "bounded_coverage_patch_root_replacement_forbidden" };
    }
    const beforeText = await readFile(this.workingPath, "utf8");
    const before = strictJsonParse(beforeText);
    let after = before;
    for (const operation of operations) {
      if (
        !operation
        || !["add", "replace", "remove"].includes(operation.op)
        || typeof operation.path !== "string"
      ) {
        return { ok: false, error: "unsupported_coverage_json_patch_operation" };
      }
      after = applyJsonPatchOperation(after, operation);
    }
    const changedRecords = changedCoverageRecords(before, after);
    if (changedRecords.length > MAX_COVERAGE_PATCH_SEMANTIC_CHANGES) {
      return {
        ok: false,
        error: "bounded_coverage_patch_semantic_limit",
        changed_record_count: changedRecords.length,
        max_changed_record_count: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES,
        changed_records: changedRecords,
      };
    }
    const [candidatePlan, state] = [this.candidatePlan, await this.readState()];
    return {
      ...(await this.replaceWorking(prettyJson(after))),
      changed_record_count: changedRecords.length,
      changed_records: changedRecords,
      serialized_patch_bytes: serializedBytes,
      coverage_checkpoint: coverageCheckpoint(
        after,
        this.evidence,
        candidatePlan,
        new Set(state.opened_evidence_ids),
        this.reviewScope,
        this.spanRegistry,
      ),
    };
  }

  private async stageWorking(input: Record<string, unknown>): Promise<ToolResponse> {
    if (await pathExists(this.sealedPath)) return { ok: false, error: "coverage_review_already_sealed" };
    const coverageUpserts = Array.isArray(input.semantic_coverage_upserts)
      ? input.semantic_coverage_upserts
      : [];
    const coverageRemovals = Array.isArray(input.semantic_coverage_remove_ids)
      ? input.semantic_coverage_remove_ids
      : [];
    const findingUpserts = Array.isArray(input.finding_upserts) ? input.finding_upserts : [];
    const findingRemovals = Array.isArray(input.finding_remove_ids) ? input.finding_remove_ids : [];
    const changeCount = coverageUpserts.length + coverageRemovals.length + findingUpserts.length + findingRemovals.length;
    if (changeCount === 0 && input.status === undefined && input.summary === undefined) {
      return { ok: false, error: "coverage_stage_changes_required", budget_consumed: false };
    }
    if (changeCount > MAX_COVERAGE_PATCH_SEMANTIC_CHANGES) {
      return { ok: false, error: "bounded_coverage_stage_semantic_limit", changed_record_count: changeCount, max_changed_record_count: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES, budget_consumed: false };
    }
    const duplicateOrInvalidIds = (rows: unknown[], field: string): boolean => {
      const ids = rows.map((row) => isRecord(row) && typeof row[field] === "string" ? row[field] : "");
      return ids.some((id) => !id) || new Set(ids).size !== ids.length;
    };
    if (duplicateOrInvalidIds(coverageUpserts, "coverage_id") || duplicateOrInvalidIds(findingUpserts, "finding_id")) {
      return { ok: false, error: "coverage_stage_typed_id_invalid", budget_consumed: false };
    }
    const current = strictJsonParse(await readFile(this.workingPath, "utf8"));
    if (!isRecord(current)) return { ok: false, error: "coverage_working_type_invalid", budget_consumed: false };
    const stateBefore = await this.readState();
    const coverageById = new Map<string, unknown>();
    for (const row of Array.isArray(current.semantic_coverage) ? current.semantic_coverage : []) {
      if (isRecord(row) && typeof row.coverage_id === "string") coverageById.set(row.coverage_id, row);
    }
    for (const id of coverageRemovals) if (typeof id === "string") coverageById.delete(id);
    for (const row of coverageUpserts) coverageById.set((row as Record<string, unknown>).coverage_id as string, row);
    const findingsById = new Map<string, unknown>();
    for (const row of Array.isArray(current.findings) ? current.findings : []) {
      if (isRecord(row) && typeof row.finding_id === "string") findingsById.set(row.finding_id, row);
    }
    for (const id of findingRemovals) if (typeof id === "string") findingsById.delete(id);
    for (const row of findingUpserts) findingsById.set((row as Record<string, unknown>).finding_id as string, row);
    const assembled = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: this.planFingerprint,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      status: input.status ?? current.status,
      semantic_coverage: [...coverageById.values()],
      findings: [...findingsById.values()],
      summary: input.summary ?? current.summary,
    };
    const contextBlock = await this.relatedContextBlock(assembled, stateBefore);
    if (contextBlock) return contextBlock;
    const spanMaterialized = materializeCoverageSpanBindings(assembled, this.evidence, this.spanRegistry);
    if (spanMaterialized.issues.length > 0) {
      return {
        ok: false,
        error: "coverage_review_span_unresolved",
        issues: spanMaterialized.issues,
        budget_consumed: false,
        instruction: "Every span_id must resolve inside the cited immutable evidence. Reopen the evidence and pick a registered span, or register one with locate_review_span; never retype fragment text.",
      };
    }
    const healed = autoRepairCoverageFragments(
      normalizeCoverageReviewMechanicalFields(spanMaterialized.value as Record<string, unknown>).value,
      this.evidence,
    );
    const candidatePlan = this.candidatePlan;
    const ownership = normalizeCoverageReviewFindingOwnership(
      healed.value as Record<string, unknown>,
      candidatePlan,
      this.evidence,
    );
    const after = ownership.value;
    const openedEvidenceIds = new Set(stateBefore.opened_evidence_ids);
    const beforeCheckpoint = coverageCheckpoint(
      current,
      this.evidence,
      candidatePlan,
      openedEvidenceIds,
      this.reviewScope,
      this.spanRegistry,
    );
    const checkpoint = coverageCheckpoint(
      after,
      this.evidence,
      candidatePlan,
      openedEvidenceIds,
      this.reviewScope,
      this.spanRegistry,
    );
    const progressState = {
      opened_evidence_ids: stateBefore.opened_evidence_ids,
      last_valid_review_fingerprint: "",
      status: "working" as const,
      local_validation_issue_fingerprint: "",
    };
    const semanticProgressChanged = coverageReviewProgressFingerprint(
      current,
      beforeCheckpoint,
      progressState,
    ) !== coverageReviewProgressFingerprint(after, checkpoint, progressState);
    const changedRecords = changedCoverageRecords(current, after);
    const written = await this.replaceWorking(prettyJson(after));
    if (spanMaterialized.materialized.length) {
      await this.appendEvent("coverage_span_binding_materialized", {
        source: "stage_coverage_review_draft",
        bindings: spanMaterialized.materialized,
      });
    }
    if (healed.repairs.length) {
      await this.appendEvent("coverage_fragment_auto_repaired", {
        source: "stage_coverage_review_draft",
        repairs: healed.repairs,
      });
    }
    if (ownership.changed) {
      await this.appendEvent("coverage_finding_ownership_normalized", {
        source: "stage_coverage_review_draft",
        status: ownership.value.status,
      });
    }
    if (checkpoint.ready_for_validation !== true) {
      return {
        ...written,
        budget_consumed: false,
        changed_record_count: changedRecords.length,
        semantic_progress_changed: semanticProgressChanged,
        mechanical_finalization_required: checkpoint.mechanical_finalization_required === true,
        coverage_checkpoint: checkpoint,
        instruction: "The typed draft is saved but not mechanically ready. Every required materialized final leaf needs exactly one acceptance_item review record even when the candidate leaf is defective; preserve that defect in a finding. Correct only the explicit readiness_issues and listed missing/opened obligations, then stage again; validation is unavailable until readiness is complete.",
      };
    }
    const localValidation = validateCoverageReview(
      after,
      this.planFingerprint,
      this.evidence,
      openedEvidenceIds,
      candidatePlan,
      this.reviewScope,
      this.spanRegistry,
    );
    if (!localValidation.ok) {
      return {
        ...written,
        error: "coverage_review_local_validation",
        budget_consumed: false,
        changed_record_count: changedRecords.length,
        semantic_progress_changed: semanticProgressChanged,
        coverage_checkpoint: checkpoint,
        local_issue_count: localValidation.issues.length,
        local_issues: boundedCoverageIssues(localValidation.issues),
        instruction: "The typed draft is durable but mechanically invalid. Correct the first listed bounded issue batch now; if more issues remain than one stage allows, the next fresh finalization phase continues from the reduced local issue set. Do not replace the repair with a status-only capacity report. No full validation attempt was consumed.",
      };
    }
    const validation = await this.validateWorking();
    return {
      ...written,
      changed_record_count: changedRecords.length,
      semantic_progress_changed: semanticProgressChanged,
      coverage_checkpoint: checkpoint,
      validation,
      ready_for_seal: validation.ok === true,
      fingerprint: validation.ok === true ? validation.fingerprint ?? "" : "",
    };
  }

  private async validateWorking(): Promise<ToolResponse> {
    let value: unknown;
    try {
      value = strictJsonParse(await readFile(this.workingPath, "utf8"));
    } catch (error) {
      return {
        schema_version: "coverage-review-preflight/v1",
        ok: false,
        error: "invalid_json",
        budget_consumed: false,
        failure_class: "protocol",
        instruction: "Fix working coverage JSON. Read actual_error and issues.",
        actual_error: error instanceof Error ? error.message : String(error),
        issues: [{ code: "invalid_json", path: "/", message: error instanceof Error ? error.message : String(error) }],
        required_action: "fix_request_using_actual_error",
      };
    }
    const contextBlock = await this.relatedContextBlock(value, await this.readState());
    if (contextBlock) return contextBlock;
    const observationIssues = await referenceObservationIssues(this.workspace, this.planFingerprint, this.evidence, value);
    if (observationIssues.length) {
      return toolReject({
        error: "coverage_reference_observation_requires_repair",
        instruction: "Repair using issues before validating or sealing this coverage review.",
        budget_consumed: false,
        issues: observationIssues,
        required_action: "repair_using_returned_issues",
      });
    }
    const candidatePlan = this.candidatePlan;
    if (isRecord(value)) {
      const ownership = normalizeCoverageReviewFindingOwnership(value, candidatePlan, this.evidence);
      if (ownership.changed) {
        value = ownership.value;
        await this.replaceWorking(prettyJson(value));
        await this.appendEvent("coverage_finding_ownership_normalized", {
          source: "validate_working",
          status: ownership.value.status,
        });
      }
    }
    const state = await this.readState();
    const deliveryIssues = await this.candidateSectionDeliveryIssues(state);
    if (deliveryIssues.length > 0) {
      return {
        schema_version: "coverage-review-preflight/v1",
        ok: false,
        budget_consumed: false,
        failure_class: "incomplete_mandatory_set",
        candidate_section_delivery: deliveryIssues,
        issues: [{
          code: "coverage_candidate_sections_incomplete",
          path: "/",
          message: "Every required structured candidate section must be delivered from the current immutable candidate snapshot before validation or sealing.",
          details: deliveryIssues,
        }],
      };
    }
    const checkpoint = coverageCheckpoint(
      value,
      this.evidence,
      candidatePlan,
      new Set(state.opened_evidence_ids),
      this.reviewScope,
      this.spanRegistry,
    );
    if (checkpoint.ready_for_validation !== true) {
      return {
        schema_version: "coverage-review-preflight/v1",
        ok: false,
        budget_consumed: false,
        failure_class: "incomplete_mandatory_set",
        coverage_checkpoint: checkpoint,
        issues: [{
          code: "coverage_review_mandatory_set_incomplete",
          path: "/",
          message: "Open, receipt, and semantically dispose every mandatory evidence resource before spending a full validation attempt",
          details: checkpoint,
        }],
      };
    }
    const validation = validateCoverageReview(
      value,
      this.planFingerprint,
      this.evidence,
      new Set(state.opened_evidence_ids),
      candidatePlan,
      this.reviewScope,
      this.spanRegistry,
    );
    const receipt = {
      schema_version: "coverage-review-validation/v1",
      sequence: state.next_validation_sequence,
      ok: validation.ok,
      issues: validation.issues,
      fingerprint: validation.fingerprint ?? "",
    };
    await atomicWriteJson(join(this.validationDirectory, `${String(state.next_validation_sequence).padStart(6, "0")}.json`), receipt);
    if (validation.ok && validation.review && validation.fingerprint) {
      // A stale sealed review may have left this checkpoint read-only on Windows.
      // With no current seal it is a mutable validation checkpoint again.
      if (await pathExists(this.lastValidPath)) await chmod(this.lastValidPath, 0o600);
      await atomicWriteJson(this.lastValidPath, validation.review);
    }
    await this.updateState((current) => {
      current.next_validation_sequence += 1;
      current.validation_attempts += 1;
      current.last_valid_review_fingerprint = validation.ok ? validation.fingerprint ?? "" : "";
    });
    return receipt;
  }

  private async seal(fingerprint: string): Promise<ToolResponse> {
    const currentRevision = await this.workspace.readState();
    if (
      currentRevision.last_valid_fingerprint !== this.planFingerprint
      || currentRevision.last_valid_plan_sha256 !== this.candidatePlanSha256
    ) {
      return coverageCandidateChangedReceipt(this.planFingerprint, currentRevision);
    }
    const referenceEvidence = await this.referenceEvidence();
    const referenceIssues = [
      ...await inlineReferenceReadIssues(this.workspace, referenceEvidence, "coverage"),
      ...await referenceAnalysisIssues(this.workspace, referenceEvidence, "coverage"),
    ];
    if (referenceIssues.length > 0) {
      return toolReject({
        error: "coverage_reference_facts_incomplete",
        instruction: "先调用 list_coverage_reference_targets 取得每个目标的可用 read_tool；内联目标用 read_document_reference_evidence 读到 done=true，隔离目标用 read_reference_facts 完成目录条目处置，再封存 coverage。",
        budget_consumed: false,
        issues: referenceIssues,
        required_action: "list_coverage_reference_targets_then_complete_each_target_with_its_read_tool",
        candidate_read_tool: "list_coverage_reference_targets",
        candidate_read_tools: [
          "list_coverage_reference_targets",
          "read_document_reference_evidence",
          "read_reference_facts",
        ],
        next_tool: "list_coverage_reference_targets",
        next_tool_arguments: { cursor: 0, limit: 100 },
        next_tools: [
          "list_coverage_reference_targets",
          "read_document_reference_evidence",
          "read_reference_facts",
        ],
      });
    }
    if (await pathExists(this.sealedPath)) return { ok: false, error: "coverage_review_already_sealed" };
    const state = await this.readState();
    const deliveryIssues = await this.candidateSectionDeliveryIssues(state);
    if (deliveryIssues.length > 0) {
      return {
        ok: false,
        error: "coverage_candidate_sections_incomplete",
        candidate_section_delivery: deliveryIssues,
        required_action: "read_every_required_candidate_section_page_and_nested_section_ref_before_sealing",
      };
    }
    let value: unknown;
    try {
      value = strictJsonParse(await readFile(this.workingPath, "utf8"));
    } catch (error) {
      return catchToolReject(error, "coverage_review_unverified", {
        instruction: "Working coverage JSON is invalid. Read actual_error and fix the workfile, then validate_coverage_review.",
      });
    }
    const contextBlock = await this.relatedContextBlock(value, state);
    if (contextBlock) return contextBlock;
    const observationIssues = await referenceObservationIssues(this.workspace, this.planFingerprint, this.evidence, value);
    if (observationIssues.length) {
      return toolReject({
        error: "coverage_reference_observation_requires_repair",
        instruction: "Repair using issues before sealing this coverage review.",
        budget_consumed: false,
        issues: observationIssues,
        required_action: "repair_using_returned_issues",
      });
    }
    const candidatePlan = this.candidatePlan;
    if (isRecord(value)) {
      const ownership = normalizeCoverageReviewFindingOwnership(value, candidatePlan, this.evidence);
      if (ownership.changed) {
        value = ownership.value;
        await this.replaceWorking(prettyJson(value));
        await this.appendEvent("coverage_finding_ownership_normalized", {
          source: "seal_coverage_review",
          status: ownership.value.status,
        });
      }
    }
    const validation = validateCoverageReview(
      value,
      this.planFingerprint,
      this.evidence,
      new Set(state.opened_evidence_ids),
      candidatePlan,
      this.reviewScope,
      this.spanRegistry,
    );
    if (
      !validation.ok
      || !validation.review
      || !validation.fingerprint
      || fingerprint !== validation.fingerprint
      || fingerprint !== state.last_valid_review_fingerprint
    ) {
      return toolReject({
        error: "coverage_review_unverified",
        instruction: !validation.ok
          ? "Coverage review failed validation. Repair using issues, then validate_coverage_review and seal the new fingerprint."
          : `Submitted fingerprint ${fingerprint || "(empty)"} does not match expected ${validation.fingerprint || state.last_valid_review_fingerprint || "(none)"}. Call validate_coverage_review, then seal that fingerprint.`,
        issues: validation.issues,
        actual_fingerprint: fingerprint,
        expected_fingerprint: validation.fingerprint ?? "",
        last_valid_review_fingerprint: state.last_valid_review_fingerprint ?? "",
        current_fingerprint: validation.fingerprint ?? "",
        required_action: validation.ok ? "resubmit_latest_validation_fingerprint" : "repair_using_returned_issues",
        candidate_read_tool: "validate_coverage_review",
      });
    }
    await atomicWriteNewText(this.sealedPath, prettyJson(validation.review));
    await atomicWriteNewText(
      this.materializedFingerprintPath,
      `${materializedCandidateFingerprint(candidatePlan, this.evidence, this.planFingerprint)}\n`,
    );
    await writePersistedReviewScope(this.root, this.reviewScope);
    await makeReadOnly(this.sealedPath);
    await makeReadOnly(this.materializedFingerprintPath);
    await makeReadOnly(this.lastValidPath);
    await this.updateState((current) => { current.status = "sealed"; });
    return {
      ok: true,
      status: validation.review.status,
      plan_fingerprint: this.planFingerprint,
      review_fingerprint: validation.fingerprint,
      finding_count: validation.review.findings.length,
    };
  }
}

function resultContent(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

const CoverageEvidenceBindingSchema = Type.Object({
  evidence_id: Type.String(),
  exact_fragment: Type.Optional(Type.String()),
  span_id: Type.Optional(Type.String()),
});

const SemanticCoverageDispositionSchema = Type.Object({
  coverage_id: Type.String(),
  disposition: Type.Union([Type.Literal("acceptance_item"), Type.Literal("shared_context"), Type.Literal("irrelevant")]),
  judgment_id: Type.String(),
  item_ids: Type.Array(Type.String()),
  evidence_bindings: Type.Array(CoverageEvidenceBindingSchema, { minItems: 1 }),
  reason: Type.String(),
});

const CoverageFindingSchema = Type.Object({
  finding_id: Type.String(),
  defect_field: Type.Optional(Type.Union(COVERAGE_DEFECT_FIELDS.map((field) => Type.Literal(field)), { description: "始终明确缺陷所在字段：sampling 不等于 requirement；fields.note 承载的补充范围/检验批依据缺失应选 note，不选 sampling。coverage 表示涉嫌漏判断。同一缺陷保持字段稳定，新缺陷用独立字段/来源锚点。" })),
  finding_type: Type.Union([
    Type.Literal("semantic_coverage_gap"),
    Type.Literal("compiler_materialization_defect"),
    Type.Literal("soft_classification_disagreement"),
    Type.Literal("source_glyph_review"),
  ], { description: "按缺陷分类规则区分候选语义选择错误与已证实的计划到结果偏移；使用引用本身不证明编译器缺陷。" }),
  evidence_id: Type.String(),
  exact_fragment: Type.Optional(Type.String()),
  span_id: Type.Optional(Type.String()),
  affected_item_ids: Type.Array(Type.String()),
  description: Type.String(),
  reason: Type.String(),
});

export interface CoverageReviewToolHooks {
  ensureReferenceAnalysis?: (receipt: ToolResponse) => Promise<ToolResponse>;
  ensureReferenceFacts?: (targetKey: string, signal?: AbortSignal) => Promise<ToolResponse>;
}

export function createCoverageReviewTools(
  controller: CoverageReviewController,
  hooks: CoverageReviewToolHooks = {},
): ToolDefinition[] {
  return [
    defineTool({ name: "get_coverage_review_contract", label: "读取覆盖复核契约", description: "读取语义必需证据集、可检索目录大小、目标范围及精确复核 schema。", parameters: Type.Object({}), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("get_coverage_review_contract", params as Record<string, unknown>)) }),
    defineTool({ name: "open_review_evidence", label: "打开复核证据", description: "只打开 access_mode=direct 或 inline_reference 的完整不可变证据资源，返回资源及已登记引用 span。isolated_reference 会原子拒绝，并返回可直接调用 read_reference_facts 的 target_key；不得逐个重试被隔离的 evidence_id。", parameters: Type.Object({ evidence_id: Type.String() }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("open_review_evidence", params)) }),
    defineTool({ name: "locate_review_span", label: "定位复核片段", description: "只在已打开的 direct 或 inline_reference 证据中登记精确引用 span；isolated_reference 必须使用 read_reference_facts 返回的 span_id。quote 仅定位偏移，不持久化；绑定返回的 span_id，由 harness 切取精确原文字节。", parameters: Type.Object({ evidence_id: Type.String(), quote: Type.String(), prefix: Type.Optional(Type.String()), suffix: Type.Optional(Type.String()) }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("locate_review_span", params)) }),
    defineTool({ name: "resolve_document_reference", label: "解析文档引用", description: REFERENCE_ACTION_GUIDANCE_ZH, parameters: Type.Object({ origin_span_id: Type.Optional(Type.String({ minLength: 1, description: "旧单 span 输入：包含当前引用成员的已登记来源 span_id。" })), origin_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 3, uniqueItems: true, description: "组合引用各段的来源 span，必须按原文顺序排列。" })), origin_field: Type.Union([Type.Literal("name"), Type.Literal("requirement"), Type.Literal("method"), Type.Literal("quantity"), Type.Literal("note"), Type.Literal("sampling")], { description: "引用文字实际出现的本地业务字段；与被引内容要导入的 destination 字段分开。" }), reference_literal_span_id: Type.Optional(Type.String({ minLength: 1, description: "只覆盖当前单个引用成员的精确 literal span_id；不得覆盖并列引用列表或猜测位置。" })), reference_literal_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 3, uniqueItems: true, description: "同一引用被换行拆开时，按来源顺序提供 2～3 个精确 literal span；同 clause、邻接与唯一匹配由程序校验。" })), raw_reference: Type.String({ minLength: 1, description: "精确 literal fragments 按来源顺序拼接的逐字值。" }), normalized_reference: Type.Optional(Type.String({ minLength: 1, description: "组合引用的规范化值，与 literal spans 分离；只能规范空白/排版。" })), target: Type.Object({ source_id: Type.Optional(Type.String({ minLength: 1, description: "目标所在来源；同一 Markdown 可省略。" })), kind: Type.Union([Type.Literal("clause"), Type.Literal("section"), Type.Literal("table"), Type.Literal("appendix")], { description: "被引目标的结构类型：条、节、表或附录。" }), number: Type.String({ minLength: 1, description: "被引条、节、表或附录编号。" }), paragraph: Type.Optional(Type.String({ minLength: 1, description: "需要精确到第 N 款时填写款号。" })), candidate_start_line: Type.Optional(Type.Integer({ minimum: 1, description: "同名目标有多个候选时，传回某个候选的 start_line 点名；省略则先返回最靠前候选。" })) }, { additionalProperties: false, description: "单数对象，只描述当前 Tool Call 要解析的一个目标；并列成员必须分别调用。" }), relation: Type.String({ minLength: 1, description: "引用对业务字段的关系。" }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => { const receipt = await controller.dispatch("resolve_document_reference", params as Record<string, unknown>); return resultContent(receipt.ok === true && hooks.ensureReferenceAnalysis ? await hooks.ensureReferenceAnalysis(receipt) : receipt); } }),
    defineTool({ name: "list_coverage_reference_targets", label: "列出复核引用目标", description: "分页列出当前 coverage 会话已登记的 resolved 引用 occurrence 及其机械读取路由；包含候选内引用和本轮 review observation，不读取或返回目标正文，也不作语义判断。", parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0, description: "首次传 0，后续原样传上一回条的 next_cursor。" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每页返回 1～100 条已登记 occurrence；省略时为 100。" })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("list_coverage_reference_targets", params as Record<string, unknown>)) }),
    defineTool({ name: "read_document_reference_evidence", label: "读取内联引用正文", description: "按公开回条要求，分页完成一个 inline target_key 的组件处置账本；这与用 open_review_evidence 打开某个 access_mode=inline_reference 的 evidence_id 是两种不同粒度。target_key 必须从本会话公开工具回条中已登记并明确返回的 target_key 原样复制，例如候选叶详情或证据 access metadata；不得用 target_fingerprint 推导、拼接或改写。拒绝 isolated 目标；隔离目标在其独立 job 封存后使用 read_reference_facts。", parameters: Type.Object({ target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description: "从本会话公开工具回条中已登记并明确返回的 target_key 原样复制；不得填写 target_fingerprint。" }), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_document_reference_evidence", params as Record<string, unknown>)) }),
    defineTool({ name: "read_reference_facts", label: "读取引用目录", description: "读取一个隔离引用目标的精简目录，仅打开本轮复核实际需要的条目。target_key 必须从本会话公开工具回条中已登记并明确返回的 target_key 原样复制，例如候选叶详情或证据 access metadata；不得用 target_fingerprint 推导、拼接或改写。只传 target_key 取目录；目录的 source_label 仅用于展示，同号条文与表格可有相同标签，entry_ids 必须逐字复制各自机器 entry_id。entry_ids 打开分页正文；skip 可把未读或部分读取的条目连同非空理由置为 ignored 并解除 pending；以后显式把同一 entry_id 放回 entry_ids 会撤销 ignored，并可沿此前回条游标继续保留的读取进度；同一次调用同时 skip 和 entry_ids 同一条目时，以 entry_ids 重新打开为准。完整打开的每行自动返回 evidence_id 和已核验整行 span_id，可直接绑定到 evidence_bindings 或 findings，不必 locate_review_span；resolve_rows 只用于再次取得已打开行的句柄。封存前每个目录条目的全部证据行（含分页行的全部片段）都须完整读完，或有理由地跳过；used 只表示已选择或开始读取，不能独自解除 pending。不得把整个隔离目标原始页拉进覆盖会话。", parameters: Type.Object({ target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description: "从本会话公开工具回条中已登记并明确返回的 target_key 原样复制；不得填写 target_fingerprint。" }), row_cursor: Type.Optional(Type.Integer({minimum:0})), row_offset: Type.Optional(Type.Integer({minimum:0})), catalog_cursor: Type.Optional(Type.Integer({minimum:0})), entry_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "从目录逐字复制机器 entry_id，不得填写仅用于展示的 source_label。" }), { maxItems: 32 })), skip: Type.Optional(Type.Array(Type.Object({ entry_id: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { maxItems: 64 })), skip_rest: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1 }) }, { additionalProperties: false })), resolve_rows: Type.Optional(Type.Array(Type.Object({ entry_id: Type.String({ minLength: 1 }), row_index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), { maxItems: 24 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params, signal) => { const targetKey = String((params as Record<string, unknown>).target_key ?? ""); let output = await controller.dispatch("read_reference_facts", params as Record<string, unknown>, signal); if (output.error === "reference_analysis_not_sealed" && hooks.ensureReferenceFacts) { const analysis = await hooks.ensureReferenceFacts(targetKey, signal); output = await controller.dispatch("read_reference_facts", params as Record<string, unknown>, signal); if (output.ok !== true) output = { ...output, analysis }; } return resultContent(output); } }),
    defineTool({ name: "search_review_document", label: "检索原始文档", description: "检索原始 Markdown 中可直接调查的范围，包括抽取器未选择的内容。省略 query 可无筛选浏览全部可读取窗口；isolated_reference 原始范围不参与匹配、计数或哈希回传，隔离目标从 list_coverage_reference_targets 的无正文目录进入 read_reference_facts。定位结果不决定适用性。", parameters: Type.Object({ query: Type.Optional(Type.String()), cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("search_review_document", params)) }),
    defineTool({ name: "open_review_document", label: "打开原始文档窗口", description: "用 search_review_document 返回的 atom_id 打开未受保护的有界原文原子，持久化为复核观察，不修改候选。与 isolated_reference 原始范围重叠时会在写入前拒绝，并按 target_key 路由 read_reference_facts。", parameters: Type.Object({ atom_id: Type.String() }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("open_review_document", params)) }),
    defineTool({ name: "search_review_evidence", label: "检索复核证据", description: "全文检索证据目录中的可读取资源，不将定位命中提升为必需覆盖义务。每条命中都返回 access_mode、read_tool 和下一工具参数；isolated_reference 正文不参与匹配、计数或哈希回传，隔离目标从 list_coverage_reference_targets 的无正文目录进入 read_reference_facts。", parameters: Type.Object({ query: Type.String(), cursor: Type.Optional(Type.Number()) }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("search_review_evidence", params)) }),
    defineTool({ name: "read_candidate_plan", label: "读取范围内候选目录", description: "仅分页列出当前范围最终叶子，同时给出全量和范围内计数。目录未列出的范围外项目仍存在，不能据此证明遗漏；精确值和来源用 read_candidate_leaf_details。", parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })), max_items: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CANDIDATE_INVENTORY_ITEMS })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_candidate_plan", params as Record<string, unknown>)) }),
    defineTool({ name: "read_candidate_related_context", label: "读取同源叶子背景", description: "读取与必需 item_id 共享判据来源的兄弟叶子精确字段分块。锚点用范围内必需项，不用兄弟项 ID；提交增量语义缺口前按 next_cursor 读到 null。只读兄弟项不新增复核义务，先比较分配再声称遗漏，预览本身不是证明。引用正文仍用专用工具。", parameters: Type.Object({ item_id: Type.String(), cursor: Type.Optional(Type.Integer({ minimum: 0 })), max_records: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_candidate_related_context", params)) }),
    defineTool({ name: "read_candidate_leaf_details", label: "读取精确候选叶子详情", description: "先用 view=business 读取面向用户的精确值、分支、字段线索及来源绑定，不重复编译图；具体来源问题才用 view=full。每次读取 1–8 个明确已登记的最终 item_id。小叶子内联返回，结构超大叶子返回不可变 candidate_snapshot_id 和 section refs，封存前必须读完必需节页及嵌套引用。长标量仍用 $text_ref。related_context 是有界只读兄弟分配，不增加复核义务。本工具不将原始证据标记为已打开。", parameters: Type.Object({ item_ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_CANDIDATE_DETAIL_ITEMS, uniqueItems: true }), view: Type.Optional(Type.Union([Type.Literal("business"), Type.Literal("full")])) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_candidate_leaf_details", params)) }),
    defineTool({ name: "read_candidate_leaf_section", label: "读取候选叶子节页", description: "读取一个不可变结构化候选节的下一有界页。首次传 section_ref，不带 page_token；后续原样传返回的 next_page_token，不能跳页。覆盖封存前还须单独读取嵌套 $section_ref。", parameters: Type.Object({ item_id: Type.String(), candidate_snapshot_id: Type.String(), section_ref: Type.String(), page_token: Type.Optional(Type.String()) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_candidate_leaf_section", params)) }),
    defineTool({ name: "read_candidate_leaf_text", label: "读取精确候选叶子文本", description: "按 Unicode 码点分页读取超大叶子的一个按内容寻址 $text_ref，不改动或打开其原始证据。来自结构化目录时须传 candidate_snapshot_id，以拒绝过期候选内容。", parameters: Type.Object({ item_id: Type.String(), text_ref: Type.String(), candidate_snapshot_id: Type.Optional(Type.String()), cursor: Type.Optional(Type.Integer({ minimum: 0 })), max_code_points: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CANDIDATE_TEXT_PAGE_CODE_POINTS })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_candidate_leaf_text", params)) }),
    defineTool({ name: "read_working_coverage_review", label: "读取覆盖复核工作稿", description: "读取可观察的覆盖复核工作文件。", parameters: Type.Object({}), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("read_working_coverage_review", params as Record<string, unknown>)) }),
    defineTool({ name: "batch_open_review_evidence", label: "批量打开复核证据", description: "一次有界请求打开 1–50 个 access_mode=direct 或 inline_reference 的证据资源。工具先预检全部 ID；只要含未知 ID 或 isolated_reference，整批会在写入 opened checkpoint 或登记 span 前原子拒绝，并返回可执行分流参数。", parameters: Type.Object({ evidence_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("batch_open_review_evidence", params)) }),
    defineTool({ name: "stage_coverage_review_draft", label: "暂存结构化覆盖复核稿", description: "最多 upsert 或移除 32 条结构化最终叶子覆盖记录/意见。通过 open_review_evidence.registered_spans 或 locate_review_span 返回的 span_id 绑定，由 harness 按偏移物化 exact_fragment。仅草稿机械准备完成后才自动执行确定性验证。", parameters: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("approved"), Type.Literal("repair"), Type.Literal("harness_defect")])), summary: Type.Optional(Type.String()), semantic_coverage_upserts: Type.Optional(Type.Array(SemanticCoverageDispositionSchema, { maxItems: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES })), semantic_coverage_remove_ids: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES })), finding_upserts: Type.Optional(Type.Array(CoverageFindingSchema, { maxItems: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES })), finding_remove_ids: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_COVERAGE_PATCH_SEMANTIC_CHANGES })) }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("stage_coverage_review_draft", params)) }),
    defineTool({ name: "seal_coverage_review", label: "封存覆盖复核", description: "封存最近一次有效独立覆盖判断的精确指纹。", parameters: Type.Object({ fingerprint: Type.String() }), executionMode: "sequential", execute: async (_id, params) => resultContent(await controller.dispatch("seal_coverage_review", params)) }),
  ].map(replaceAcceptanceToolText);
}
