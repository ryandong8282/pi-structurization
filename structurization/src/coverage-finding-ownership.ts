import { sha256Json, sha256Text } from "./canonical.js";
import type {
  AcceptanceItemPlan,
  MaterializedAcceptanceItem,
  SemanticSourcePlan,
} from "./contracts.js";
import {
  canonicalizeSourceGlyphsForComparison,
  normalizeMineruInlineMath,
} from "./text-normalization.js";
import { stripRedundantSourceClausePrefix } from "./materializer.js";
import {
  samplingConfidenceForStatus,
  samplingScriptForStatus,
  supportedSamplingScript,
} from "./sampling-script.js";

const MATERIALIZED_FIELDS = ["name", "requirement", "method", "quantity", "note"] as const;

type MaterializedField = typeof MATERIALIZED_FIELDS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function affectedItemIds(finding: Record<string, unknown>): string[] {
  return Array.isArray(finding.affected_item_ids)
    ? finding.affected_item_ids.filter((itemId): itemId is string => typeof itemId === "string")
    : [];
}

function normalizedTableSemantics(item: AcceptanceItemPlan): MaterializedAcceptanceItem["table_semantics"] {
  const table = item.table_semantics;
  if (!table) return null;
  return {
    ...table,
    table_id: normalizeMineruInlineMath(table.table_id),
    table_no: normalizeMineruInlineMath(table.table_no),
    table_title: normalizeMineruInlineMath(table.table_title),
    applicability: normalizeMineruInlineMath(table.applicability),
    row_path: table.row_path.map(normalizeMineruInlineMath),
    column_path: table.column_path.map(normalizeMineruInlineMath),
    unit: normalizeMineruInlineMath(table.unit),
    condition: normalizeMineruInlineMath(table.condition),
    allowed_value: normalizeMineruInlineMath(table.allowed_value),
    inspection_method: normalizeMineruInlineMath(table.inspection_method),
    cell_evidence: table.cell_evidence.map((fragment) => ({ ...fragment })),
    reference_fragments: table.reference_fragments.map((fragment) => ({ ...fragment })),
  };
}

function normalizedSampling(item: AcceptanceItemPlan): MaterializedAcceptanceItem["sampling"] {
  return {
    ...item.sampling,
    min_sampling: normalizeMineruInlineMath(item.sampling.min_sampling),
    script: samplingScriptForStatus(item.sampling.status, item.sampling.script),
    reason: normalizeMineruInlineMath(item.sampling.reason),
    confidence: samplingConfidenceForStatus(item.sampling.status, item.sampling.confidence),
    evidence_ids: [...item.sampling.evidence_ids],
    ...(item.sampling.rule_ids ? { rule_ids: [...item.sampling.rule_ids] } : {}),
    ...(item.sampling.branch_ids ? { branch_ids: [...item.sampling.branch_ids] } : {}),
    ...(item.sampling.applied_branches ? {
      applied_branches: item.sampling.applied_branches.map((branch) => ({
        ...branch,
        min_sampling: normalizeMineruInlineMath(branch.min_sampling),
        script: supportedSamplingScript(branch.script),
        conditions: branch.conditions.map((condition) => ({
          ...condition,
          text: normalizeMineruInlineMath(condition.text),
          exact_fragment: condition.exact_fragment,
        })),
        ...(branch.components ? {
          components: branch.components.map((component) => ({
            ...component,
            source_span_ids: [...component.source_span_ids],
            ...(component.source_fragments ? {
              source_fragments: component.source_fragments.map((fragment) => ({ ...fragment })),
            } : {}),
          })),
        } : {}),
        evidence_ids: [...branch.evidence_ids],
      })),
    } : {}),
  };
}

function hasExpandingReferenceProjection(
  candidatePlan: SemanticSourcePlan,
  itemId: string,
): boolean {
  return candidatePlan.reference_resolutions.some((resolution) =>
    resolution.destination_bindings.some((destination) => destination.item_id === itemId)
  );
}

function planAuthorizedMaterializedProjection(
  item: MaterializedAcceptanceItem,
  candidatePlan: SemanticSourcePlan,
  materializedItems: readonly MaterializedAcceptanceItem[],
): boolean {
  const candidateItem = candidatePlan.acceptance_items.find((entry) =>
    entry.item_id === item.reference_origin_item_id || entry.item_id === item.item_id
  );
  if (!candidateItem) return false;

  // Reference expansion may fan one compiled item into multiple leaves, so it
  // remains harness-owned here. A one-to-one replace_field semantic reference is
  // already reflected in candidateItem; the complete field/table/sampling hash
  // comparison below can therefore prove that materialization was faithful.
  if (hasExpandingReferenceProjection(candidatePlan, candidateItem.item_id)) {
    return false;
  }

  // The proof is intentionally limited to a one-candidate/one-leaf projection.
  // Reference expansion and fan-out remain harness-owned unless a narrower,
  // deterministic proof is added for those paths.
  if (materializedItems.filter((entry) =>
    (entry.reference_origin_item_id || entry.item_id) === candidateItem.item_id
  ).length !== 1) return false;

  const fieldsMatch = MATERIALIZED_FIELDS.every((field: MaterializedField) => {
    const compiledValue = candidateItem[field];
    const binding = candidateItem.field_bindings[field];
    const normalizedValue = normalizeMineruInlineMath(compiledValue);
    const deterministicValue = field === "name"
      ? stripRedundantSourceClausePrefix(normalizedValue, item.source_clause)
      : normalizedValue;
    return sha256Text(compiledValue) === binding.value_sha256
      && item[field] === deterministicValue;
  });
  const tableMatches = sha256Json(item.table_semantics)
    === sha256Json(normalizedTableSemantics(candidateItem));
  const samplingMatches = sha256Json(item.sampling)
    === sha256Json(normalizedSampling(candidateItem));
  return fieldsMatch && tableMatches && samplingMatches;
}

function exactFragmentsOverlap(left: string, right: string): boolean {
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

/**
 * Returns true only when the candidate plan attached the finding's exact
 * provenance to a concrete item-carrying projection. Evidence dispositions,
 * reasons and unassigned semantic nodes are deliberately insufficient: those
 * prove that source was seen, not that a final acceptance judgment was authored.
 */
function candidatePlanCarriesFindingAsItem(
  candidatePlan: SemanticSourcePlan,
  evidenceId: string,
  exactFragment: string,
): boolean {
  const candidateItemIds = new Set(candidatePlan.acceptance_items.map((item) => item.item_id));
  if ((candidatePlan.semantic_evidence ?? []).some((node) =>
    node.evidence_id === evidenceId
    && candidateItemIds.has(node.materialized_item_id)
    && exactFragmentsOverlap(node.exact_fragment, exactFragment)
  )) return true;

  return candidatePlan.acceptance_items.some((item) => {
    const fieldCarries = MATERIALIZED_FIELDS.some((field) =>
      item.field_bindings[field].source_fragments.some((fragment) =>
        fragment.evidence_id === evidenceId
        && exactFragmentsOverlap(fragment.text, exactFragment)
      )
    );
    if (fieldCarries) return true;
    const tableFragments = [
      ...(item.table_semantics?.cell_evidence ?? []),
      ...(item.table_semantics?.reference_fragments ?? []),
    ];
    if (tableFragments.some((fragment) =>
      fragment.evidence_id === evidenceId
      && exactFragmentsOverlap(fragment.text, exactFragment)
    )) return true;
    return (candidatePlan.shared_sampling_rules ?? []).some((rule) =>
      rule.receiving_item_ids.includes(item.item_id)
      && (
        (rule.evidence_ids.includes(evidenceId)
          && exactFragmentsOverlap(rule.complete_source_fragment, exactFragment))
        || rule.branches.some((branch) =>
          branch.evidence_id === evidenceId
          && exactFragmentsOverlap(branch.exact_fragment, exactFragment)
        )
        || rule.shared_conditions.some((condition) =>
          condition.evidence_id === evidenceId
          && exactFragmentsOverlap(condition.exact_fragment, exactFragment)
        )
      )
    );
  });
}

function isUnresolvedSourceGlyphProjection(
  finding: Record<string, unknown>,
): boolean {
  if (typeof finding.exact_fragment !== "string" || !finding.exact_fragment) return false;
  return canonicalizeSourceGlyphsForComparison(finding.exact_fragment)
    !== finding.exact_fragment;
}

export interface CoverageFindingOwnershipNormalization {
  value: Record<string, unknown>;
  changed: boolean;
}

/**
 * Corrects a mechanically provable ownership inversion when every affected
 * candidate has exactly one materialized leaf and its deterministic text,
 * table and sampling projections were preserved in full.
 *
 * In that case the candidate semantic plan is wrong and must go through semantic
 * repair. No source wording, table identity, layout, or business keyword is used.
 */
export function normalizePlanAuthorizedCompilerFindings(
  value: Record<string, unknown>,
  candidatePlan: SemanticSourcePlan,
  materializedItems: readonly MaterializedAcceptanceItem[],
): CoverageFindingOwnershipNormalization {
  if (!Array.isArray(value.findings)) return { value, changed: false };
  const itemById = new Map(materializedItems.map((item) => [item.item_id, item]));
  let changed = false;
  const findings = value.findings.map((finding) => {
    if (!isRecord(finding) || finding.finding_type !== "compiler_materialization_defect") {
      return finding;
    }
    const affectedIds = affectedItemIds(finding);
    if (affectedIds.length === 0) {
      const evidenceId = typeof finding.evidence_id === "string" ? finding.evidence_id : "";
      const exactFragment = typeof finding.exact_fragment === "string" ? finding.exact_fragment : "";
      if (
        !evidenceId
        || !exactFragment
        || candidatePlanCarriesFindingAsItem(candidatePlan, evidenceId, exactFragment)
      ) return finding;
      changed = true;
      return { ...finding, finding_type: "semantic_coverage_gap" };
    }
    const affectedItems = affectedIds.map((itemId) => itemById.get(itemId));
    if (
      affectedItems.some((item) => item === undefined)
      // Source-glyph normalization runs before this owner pass. If the display is
      // glyph-equivalent but that pass could not prove retained provenance, keep
      // the finding blocking rather than laundering it into semantic repair.
      || isUnresolvedSourceGlyphProjection(finding)
      || !affectedItems.every((item) =>
        planAuthorizedMaterializedProjection(
          item!, candidatePlan, materializedItems,
        )
      )
    ) return finding;
    changed = true;
    return { ...finding, finding_type: "semantic_coverage_gap" };
  });
  if (!changed) return { value, changed: false };
  return { value: { ...value, findings }, changed: true };
}
