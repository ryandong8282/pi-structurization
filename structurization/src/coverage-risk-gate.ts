import type {
  EvidenceManifest,
  MaterializedAcceptanceItem,
} from "./contracts.js";
import { deliveryInvestigationHints } from "./acceptance-delivery-contract.js";

export const COVERAGE_RISK_GATE_SCHEMA_VERSION = "coverage-risk-gate/v1" as const;

export type CoverageRiskCode =
  | "ledger_unavailable"
  | "ledger_scope_unresolved"
  | "ledger_vacuous"
  | "ledger_scope_anomaly"
  | "ledger_unaccounted_candidate"
  | "ledger_gap"
  | "ledger_extra_item"
  | "ledger_unlabeled_item"
  | "ledger_contamination"
  | "uncovered_primary_evidence"
  | "missing_item_provenance"
  | "document_reference"
  | "sampling_reference"
  | "sampling_external_evidence"
  | "sampling_fallback"
  | "inspection_data_type_review"
  | "name_review_marker"
  | "prose_semantic_review"
  | "table_multi_row_merge"
  | "table_row_split"
  | "table_branch_complexity"
  | "prose_branch_complexity"
  | "delivery_field_comparison";

export interface CoverageRiskReason {
  code: CoverageRiskCode;
  item_ids: string[];
  evidence_ids: string[];
  detail: string;
}

export interface CoverageRiskGateInput {
  evidence: EvidenceManifest;
  items: readonly MaterializedAcceptanceItem[];
  ledger_available: boolean;
  ledger_scope_resolved: boolean;
  ledger_vacuous: boolean;
  ledger_scope_has_anomalies?: boolean;
  unaccounted_candidate_clause_ids?: readonly string[];
  gap_clause_ids?: readonly string[];
  gap_evidence_ids?: readonly string[];
  extra_item_ids?: readonly string[];
  unlabeled_item_ids?: readonly string[];
  contaminated_item_ids?: readonly string[];
  uncovered_primary_evidence_ids?: readonly string[];
}

export interface CoverageRiskGateResult {
  schema_version: typeof COVERAGE_RISK_GATE_SCHEMA_VERSION;
  clean: boolean;
  scope: {
    mode: "risk_delta";
    affected_item_ids: string[];
    affected_evidence_ids: string[];
    finding_ids: string[];
  };
  reasons: CoverageRiskReason[];
  counts: {
    total_item_count: number;
    affected_item_count: number;
    affected_evidence_count: number;
    reason_count: number;
  };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function clauseMatches(itemClause: string, clauseId: string): boolean {
  return Boolean(
    itemClause
    && clauseId
    && (
      itemClause === clauseId
      || itemClause.startsWith(`${clauseId}.`)
      || clauseId.startsWith(`${itemClause}.`)
    )
  );
}

function itemEvidenceIds(item: MaterializedAcceptanceItem): string[] {
  return unique([
    ...item.evidence_ids,
    ...item.reference_evidence_ids,
    ...item.inspection_data_type_evidence_ids,
    ...item.sampling.evidence_ids,
    ...(item.table_semantics?.cell_evidence.map((entry) => entry.evidence_id) ?? []),
    ...(item.table_semantics?.reference_fragments.map((entry) => entry.evidence_id) ?? []),
  ]);
}

function strongProseBranchCount(value: string): number {
  const markers = [
    ...value.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/gu),
    ...value.matchAll(/[（(][一二三四五六七八九十]+[）)]/gu),
    ...value.matchAll(/(?:^|[；;。]\s*)\d+[)）]/gmu),
  ];
  if (markers.length >= 2) return markers.length;
  const normativeSegments = value
    .split(/[；;]/u)
    .map((segment) => segment.trim())
    .filter((segment) => /(?:应|不应|不得|严禁|必须|允许|不宜)/u.test(segment));
  return normativeSegments.length >= 2 ? normativeSegments.length : 0;
}

export function deriveCoverageRiskGate(
  input: CoverageRiskGateInput,
): CoverageRiskGateResult {
  const itemById = new Map(input.items.map((item) => [item.item_id, item]));
  const evidenceById = new Map(input.evidence.evidence.map((record) => [record.evidence_id, record]));
  const affectedItems = new Set<string>();
  const affectedEvidence = new Set<string>();
  const reasons: CoverageRiskReason[] = [];

  const addRisk = (
    code: CoverageRiskCode,
    itemIds: Iterable<string>,
    evidenceIds: Iterable<string>,
    detail: string,
  ): void => {
    const scopedItems = unique(itemIds).filter((itemId) => itemById.has(itemId));
    const scopedEvidence = unique(evidenceIds).filter((evidenceId) => evidenceById.has(evidenceId));
    scopedItems.forEach((itemId) => affectedItems.add(itemId));
    scopedEvidence.forEach((evidenceId) => affectedEvidence.add(evidenceId));
    reasons.push({ code, item_ids: scopedItems, evidence_ids: scopedEvidence, detail });
  };

  const allItemIds = input.items.map((item) => item.item_id);
  const primaryEvidenceIds = input.evidence.evidence
    .filter((record) => record.evidence_scope === "primary" || record.requires_disposition)
    .map((record) => record.evidence_id);

  if (!input.ledger_available) {
    addRisk(
      "ledger_unavailable",
      allItemIds,
      primaryEvidenceIds,
      "No deterministic document ledger is available, so the initial semantic review remains full-scope.",
    );
  } else if (!input.ledger_scope_resolved) {
    addRisk(
      "ledger_scope_unresolved",
      allItemIds,
      primaryEvidenceIds,
      "The target cannot be bound to a deterministic ledger window, so narrowing would be unsafe.",
    );
  } else if (input.ledger_vacuous) {
    addRisk(
      "ledger_vacuous",
      allItemIds,
      primaryEvidenceIds,
      "The resolved ledger window has no accountable clauses; semantic review cannot be skipped.",
    );
  } else if (input.ledger_scope_has_anomalies) {
    addRisk(
      "ledger_scope_anomaly",
      allItemIds,
      primaryEvidenceIds,
      "The deterministic ledger has OCR/structure anomalies inside this target window, so clean auto-approval is unsafe.",
    );
  }

  const unaccountedClauses = unique(input.unaccounted_candidate_clause_ids ?? []);
  if (unaccountedClauses.length) {
    const evidenceIds = input.evidence.evidence
      .filter((record) =>
        record.evidence_scope === "primary"
        && (
          (record.clause_id ? unaccountedClauses.includes(record.clause_id) : false)
          || unaccountedClauses.some((clauseId) => record.text.includes(clauseId))
        )
      )
      .map((record) => record.evidence_id);
    addRisk(
      "ledger_unaccounted_candidate",
      [],
      evidenceIds.length ? evidenceIds : primaryEvidenceIds,
      `Candidate clauses remain unaccounted by the final result: ${unaccountedClauses.join(", ")}.`,
    );
  }

  const gapClauses = unique(input.gap_clause_ids ?? []);
  const gapEvidence = unique(input.gap_evidence_ids ?? []);
  if (gapClauses.length || gapEvidence.length) {
    const gapItems = input.items
      .filter((item) => gapClauses.some((clauseId) => clauseMatches(item.source_clause, clauseId)))
      .map((item) => item.item_id);
    addRisk(
      "ledger_gap",
      gapItems,
      gapEvidence,
      `Deterministic ledger reconciliation found uncovered clauses: ${gapClauses.join(", ") || "(evidence-only gap)"}.`,
    );
  }

  const uncoveredPrimary = unique(input.uncovered_primary_evidence_ids ?? []);
  if (uncoveredPrimary.length) {
    addRisk(
      "uncovered_primary_evidence",
      [],
      uncoveredPrimary,
      "Primary source evidence is not carried by the candidate plan and requires a semantic disposition.",
    );
  }

  const extraItemIds = unique(input.extra_item_ids ?? []);
  if (extraItemIds.length) {
    addRisk(
      "ledger_extra_item",
      extraItemIds,
      extraItemIds.flatMap((itemId) => itemEvidenceIds(itemById.get(itemId)!)),
      "The candidate resolves an item to a clause outside the deterministic ledger inventory.",
    );
  }

  const unlabeledItemIds = unique(input.unlabeled_item_ids ?? []);
  if (unlabeledItemIds.length) {
    addRisk(
      "ledger_unlabeled_item",
      unlabeledItemIds,
      unlabeledItemIds.flatMap((itemId) => itemEvidenceIds(itemById.get(itemId)!)),
      "The materialized item has no deterministic source-clause identity.",
    );
  }

  const contaminatedItemIds = unique(input.contaminated_item_ids ?? []);
  if (contaminatedItemIds.length) {
    addRisk(
      "ledger_contamination",
      contaminatedItemIds,
      contaminatedItemIds.flatMap((itemId) => itemEvidenceIds(itemById.get(itemId)!)),
      "The item carries source content from a different deterministic clause/window.",
    );
  }

  const itemsByTableRow = new Map<string, string[]>();

  for (const item of input.items) {
    const evidenceIds = itemEvidenceIds(item);
    for (const hint of deliveryInvestigationHints(item, input.items, input.evidence.evidence)) {
      addRisk("delivery_field_comparison", hint.item_ids, hint.evidence_ids, `${hint.code}: ${hint.instruction}`);
    }
    if (evidenceIds.length === 0) {
      addRisk(
        "missing_item_provenance",
        [item.item_id],
        [],
        "The final leaf has no immutable source evidence IDs.",
      );
    }

    if (
      item.reference_evidence_ids.length > 0
      || item.reference_resolution_ids.length > 0
      || item.reference_path.length > 0
      || item.table_semantics?.source_kind === "reference"
      || (item.inline_references?.length ?? 0) > 0
    ) {
      addRisk(
        "document_reference",
        [item.item_id],
        evidenceIds,
        "Referenced meaning requires an independent applicability/import check.",
      );
    }

    if (item.sampling.status === "reference" || item.sampling.status === "reference_unspecified_quantity") {
      addRisk(
        "sampling_reference",
        [item.item_id],
        item.sampling.evidence_ids,
        "Referenced/shared sampling requires a semantic applicability check.",
      );
    } else if (
      item.sampling.status === "explicit"
      && item.table_semantics
      && item.sampling.evidence_ids.some((evidenceId) =>
        !item.table_semantics!.cell_evidence.some((entry) => entry.evidence_id === evidenceId)
      )
    ) {
      addRisk(
        "sampling_external_evidence",
        [item.item_id],
        item.sampling.evidence_ids,
        "A table leaf takes explicit sampling semantics from evidence outside its direct table cells; verify that the external quantity/condition is attached to the correct inspected item.",
      );
    } else if (item.sampling.status === "fallback") {
      addRisk(
        "sampling_fallback",
        [item.item_id],
        item.sampling.evidence_ids.length ? item.sampling.evidence_ids : evidenceIds,
        "Sampling fell back without an exact executable quantity and must be reviewed.",
      );
    }

    if (item.inspection_data_type === "review") {
      addRisk(
        "inspection_data_type_review",
        [item.item_id],
        item.inspection_data_type_evidence_ids,
        "The candidate explicitly left inspection_data_type unresolved.",
      );
    }

    if (item.name.startsWith("⚠ 待复核 · ")) {
      addRisk(
        "name_review_marker",
        [item.item_id],
        evidenceIds,
        "The candidate carries the explicit manual-review name marker.",
      );
    }

    if (!item.table_semantics) {
      addRisk(
        "prose_semantic_review",
        [item.item_id],
        evidenceIds,
        "Prose acceptance semantics cannot be proven complete from row/column structure alone; keep this leaf in narrow semantic review.",
      );
    }

    const tableEvidenceIds = item.table_semantics
      ? unique(item.table_semantics.cell_evidence.map((entry) => entry.evidence_id))
      : evidenceIds;
    const tableRowIds = tableEvidenceIds.filter((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      return record?.role === "formal_table_row" && record.table_row_kind === "data";
    });
    for (const evidenceId of unique(tableRowIds)) {
      itemsByTableRow.set(evidenceId, [...(itemsByTableRow.get(evidenceId) ?? []), item.item_id]);
    }

    if (unique(tableRowIds).length > 1) {
      addRisk(
        "table_multi_row_merge",
        [item.item_id],
        tableRowIds,
        "One final leaf consumes multiple independent formal table data rows; verify that they are one judgment rather than an accidental merge.",
      );
    }

    if (item.table_semantics) {
      const allowedValueBindings = item.table_semantics.cell_evidence
        .filter((entry) => entry.role === "allowed_value");
      const conditionBindings = item.table_semantics.cell_evidence
        .filter((entry) => entry.role === "condition");
      if (
        allowedValueBindings.length > 1
        || conditionBindings.length > 1
        || strongProseBranchCount(item.table_semantics.condition) >= 2
        || strongProseBranchCount(item.table_semantics.allowed_value) >= 2
      ) {
        addRisk(
          "table_branch_complexity",
          [item.item_id],
          [...allowedValueBindings, ...conditionBindings].map((entry) => entry.evidence_id),
          "The table leaf carries multiple allowed-value/condition branches; verify branch grouping and split semantics.",
        );
      }
    } else {
      const primaryText = evidenceIds
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter((record) =>
          record?.evidence_scope === "primary"
          && record.role === "supporting_clause"
        )
        .map((record) => record!.text)
        .join("\n");
      if (strongProseBranchCount(primaryText || item.requirement) >= 2) {
        addRisk(
          "prose_branch_complexity",
          [item.item_id],
          evidenceIds,
          "The prose source contains multiple strong enumerated/normative branches; verify that independent judgments were not merged or dropped.",
        );
      }
    }
  }

  for (const [evidenceId, itemIds] of itemsByTableRow) {
    const distinctItems = unique(itemIds);
    if (distinctItems.length <= 1) continue;
    addRisk(
      "table_row_split",
      distinctItems,
      [evidenceId],
      "One formal table data row materializes into multiple final leaves; verify that the splits are independently pass/fail judgments.",
    );
  }

  const affectedItemIds = unique(affectedItems);
  const affectedEvidenceIds = unique(affectedEvidence);
  return {
    schema_version: COVERAGE_RISK_GATE_SCHEMA_VERSION,
    clean: affectedItemIds.length === 0 && affectedEvidenceIds.length === 0,
    scope: {
      mode: "risk_delta",
      affected_item_ids: affectedItemIds,
      affected_evidence_ids: affectedEvidenceIds,
      finding_ids: [],
    },
    reasons,
    counts: {
      total_item_count: input.items.length,
      affected_item_count: affectedItemIds.length,
      affected_evidence_count: affectedEvidenceIds.length,
      reason_count: reasons.length,
    },
  };
}
