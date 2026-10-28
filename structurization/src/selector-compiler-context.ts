import { canonicalize, sha256Json } from "./canonical.js";
import type { EvidenceManifest, PersistedSemanticSourcePlan } from "./contracts.js";
import {
  compileTargetSelectors,
  targetSelectorFingerprint,
  type TargetSelectorPlan,
} from "./target-selector-compiler.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";
import { STRUCTURAL_VALIDATION_BOUNDARY, type ValidationBoundary } from "./validation-boundary.js";
import {
  TABLE_STRUCTURE_SCHEMA_VERSION,
  type TableStructurePlan,
} from "./table-structure.js";

export const SELECTOR_COMPILER_CONTEXT_SCHEMA_VERSION = "selector-compiler-context/v1" as const;

export interface SelectorCompilerAcceptedReview {
  item_key: string;
  name: string;
}

export interface SelectorCompilerContext {
  validation_boundary?: ValidationBoundary;
  schema_version: typeof SELECTOR_COMPILER_CONTEXT_SCHEMA_VERSION;
  evidence_fingerprint: string;
  selector_fingerprint: string;
  table_structure_plan: TableStructurePlan;
  eligible_table_evidence_ids: string[];
  accepted_source_language_reviews: SelectorCompilerAcceptedReview[];
  accepted_verdict_name_reviews: SelectorCompilerAcceptedReview[];
  /** Missing on historical contexts, whose table coverage used parser roles. */
  confirmed_table_row_roles?: boolean;
}

type ReviewMarker = {
  item_key?: unknown;
  original_name?: unknown;
};

function normalizedReviews(
  reviews: readonly SelectorCompilerAcceptedReview[],
): SelectorCompilerAcceptedReview[] {
  return [...new Map(reviews
    .filter((entry) => entry.item_key && entry.name)
    .map((entry) => [`${entry.item_key}\0${entry.name}`, {
      item_key: entry.item_key,
      name: entry.name,
    }])).values()]
    .sort((left, right) => (
      left.item_key.localeCompare(right.item_key)
      || left.name.localeCompare(right.name)
    ));
}

export function selectorCompilerAcceptedReviews(
  markers: readonly ReviewMarker[] | undefined,
): SelectorCompilerAcceptedReview[] {
  return normalizedReviews((markers ?? []).flatMap((marker) => (
    typeof marker.item_key === "string"
    && marker.item_key.length > 0
    && typeof marker.original_name === "string"
    && marker.original_name.length > 0
      ? [{ item_key: marker.item_key, name: marker.original_name }]
      : []
  )));
}

export function createSelectorCompilerContext(input: {
  manifest: EvidenceManifest;
  selectors: TargetSelectorPlan;
  tableStructurePlan: TableStructurePlan;
  eligibleTableEvidenceIds: ReadonlySet<string>;
  acceptedSourceLanguageReviews: readonly SelectorCompilerAcceptedReview[];
  acceptedVerdictNameReviews: readonly SelectorCompilerAcceptedReview[];
}): SelectorCompilerContext {
  return {
    schema_version: SELECTOR_COMPILER_CONTEXT_SCHEMA_VERSION,
    validation_boundary: STRUCTURAL_VALIDATION_BOUNDARY,
    evidence_fingerprint: input.manifest.evidence_fingerprint,
    selector_fingerprint: targetSelectorFingerprint(input.selectors),
    // Saved decisions bind the immutable source document, while reference
    // registration can extend its evidence envelope. Snapshot that envelope
    // at this compilation without rewriting the author's saved table decisions.
    table_structure_plan: {
      ...input.tableStructurePlan,
      evidence_fingerprint: input.manifest.evidence_fingerprint,
    },
    eligible_table_evidence_ids: [...input.eligibleTableEvidenceIds].sort(),
    accepted_source_language_reviews: normalizedReviews(input.acceptedSourceLanguageReviews),
    accepted_verdict_name_reviews: normalizedReviews(input.acceptedVerdictNameReviews),
    confirmed_table_row_roles: true,
  };
}

export function selectorCompilerContextFingerprint(
  context: SelectorCompilerContext,
): string {
  return sha256Json(context);
}

function isAcceptedReviewArray(value: unknown): value is SelectorCompilerAcceptedReview[] {
  return Array.isArray(value) && value.every((entry) => (
    entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).item_key === "string"
    && typeof (entry as Record<string, unknown>).name === "string"
  ));
}

export function validatedSelectorCompilerContext(
  raw: unknown,
  input: {
    manifest: EvidenceManifest;
    selectors: TargetSelectorPlan;
    acceptedSourceLanguageReviews: readonly SelectorCompilerAcceptedReview[];
    acceptedVerdictNameReviews: readonly SelectorCompilerAcceptedReview[];
  },
): SelectorCompilerContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const tableStructure = record.table_structure_plan;
  if (
    record.schema_version !== SELECTOR_COMPILER_CONTEXT_SCHEMA_VERSION
    || record.evidence_fingerprint !== input.manifest.evidence_fingerprint
    || record.selector_fingerprint !== targetSelectorFingerprint(input.selectors)
    || !tableStructure
    || typeof tableStructure !== "object"
    || Array.isArray(tableStructure)
    || (tableStructure as Record<string, unknown>).schema_version !== TABLE_STRUCTURE_SCHEMA_VERSION
    || (tableStructure as Record<string, unknown>).source_version !== input.manifest.source.sha256
    || (tableStructure as Record<string, unknown>).evidence_fingerprint !== input.manifest.evidence_fingerprint
    || !Array.isArray((tableStructure as Record<string, unknown>).tables)
    || !Array.isArray(record.eligible_table_evidence_ids)
    || !record.eligible_table_evidence_ids.every((value) => typeof value === "string")
    || !isAcceptedReviewArray(record.accepted_source_language_reviews)
    || !isAcceptedReviewArray(record.accepted_verdict_name_reviews)
    || (record.confirmed_table_row_roles !== undefined && typeof record.confirmed_table_row_roles !== "boolean")
    || (record.validation_boundary !== undefined && record.validation_boundary !== STRUCTURAL_VALIDATION_BOUNDARY)
  ) {
    return undefined;
  }
  const context = record as unknown as SelectorCompilerContext;
  const evidenceIds = new Set(input.manifest.evidence.map((entry) => entry.evidence_id));
  const normalizedEligible = [...new Set(context.eligible_table_evidence_ids)].sort();
  if (
    normalizedEligible.some((evidenceId) => !evidenceIds.has(evidenceId))
    || canonicalize(normalizedEligible) !== canonicalize(context.eligible_table_evidence_ids)
    || canonicalize(normalizedReviews(context.accepted_source_language_reviews))
      !== canonicalize(context.accepted_source_language_reviews)
    || canonicalize(normalizedReviews(context.accepted_verdict_name_reviews))
      !== canonicalize(context.accepted_verdict_name_reviews)
    || canonicalize(context.accepted_source_language_reviews)
      !== canonicalize(normalizedReviews(input.acceptedSourceLanguageReviews))
    || canonicalize(context.accepted_verdict_name_reviews)
      !== canonicalize(normalizedReviews(input.acceptedVerdictNameReviews))
  ) {
    return undefined;
  }
  return context;
}

export function selectorCompilerOptionsFromContext(
  context: SelectorCompilerContext,
): NonNullable<Parameters<typeof compileTargetSelectors>[3]> {
  return {
    acceptedSourceLanguageReviews: context.accepted_source_language_reviews,
    acceptedVerdictNameReviews: context.accepted_verdict_name_reviews,
    tableStructurePlan: context.table_structure_plan,
    eligibleTableEvidenceIds: new Set(context.eligible_table_evidence_ids),
    confirmedTableRowRoles: context.confirmed_table_row_roles === true,
    ...(context.validation_boundary ? { validationBoundary: context.validation_boundary } : {}),
  };
}

export function compileTargetSelectorsWithContext(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
  context: SelectorCompilerContext,
  onModelReview?: NonNullable<Parameters<typeof compileTargetSelectors>[3]>["onModelReview"],
): PersistedSemanticSourcePlan {
  return compileTargetSelectors(
    selectors,
    registry,
    manifest,
    { ...selectorCompilerOptionsFromContext(context), ...(onModelReview ? { onModelReview } : {}) },
  );
}
