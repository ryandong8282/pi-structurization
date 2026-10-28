import { describe, expect, test } from "vitest";

import type {
  EvidenceManifest,
  EvidenceRecord,
  MaterializedAcceptanceItem,
  TableCriterionSemantics,
} from "../src/contracts.js";
import { deriveCoverageRiskGate } from "../src/coverage-risk-gate.js";

function evidenceRecord(
  evidenceId: string,
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    evidence_id: evidenceId,
    kind: "table_row",
    role: "formal_table_row",
    locator: `line:10/table:1.1/row:${evidenceId}`,
    text: `row ${evidenceId}`,
    text_sha256: evidenceId.padEnd(64, "0").slice(0, 64),
    requires_disposition: true,
    evidence_scope: "primary",
    table_row_kind: "data",
    table_id: "1.1",
    row_index: 1,
    ...overrides,
  };
}

function manifest(records: EvidenceRecord[]): EvidenceManifest {
  return {
    schema_version: "evidence-manifest/v6",
    job_id: "job",
    target_id: "target",
    source: {
      adapter: "markdown-target-scope/v3",
      file_name: "fixture.md",
      sha256: "a".repeat(64),
    },
    scope: {
      schema_version: "markdown-target-scope/v1",
      mode: "target_section",
      target_id: "target",
      source_line_count: 20,
      selected_start_line: 1,
      selected_end_exclusive_line: 20,
      selected_heading: "# target",
      selection_reason: "test",
      candidates: [],
    },
    evidence: records,
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: "b".repeat(64),
  } as EvidenceManifest;
}

function tableSemantics(evidenceId: string): TableCriterionSemantics {
  return {
    source_kind: "direct",
    table_id: "1.1",
    table_no: "1.1",
    table_title: "表 1.1",
    applicability: "",
    row_path: ["项目"],
    column_path: ["允许值"],
    unit: "mm",
    condition: "",
    allowed_value: "10",
    inspection_method: "量测",
    cell_evidence: [
      { evidence_id: evidenceId, text: "项目", role: "row_header" },
      { evidence_id: evidenceId, text: "10", role: "allowed_value" },
    ],
    reference_fragments: [],
  };
}

function item(
  itemId: string,
  evidenceId: string,
  overrides: Partial<MaterializedAcceptanceItem> = {},
): MaterializedAcceptanceItem {
  return {
    item_id: itemId,
    name: `项目 ${itemId}`,
    category: "一般项目",
    requirement: "允许偏差 10mm",
    method: "量测",
    quantity: "",
    note: "",
    evidence_ids: [evidenceId],
    reference_evidence_ids: [],
    reference_resolution_ids: [],
    reference_origin_item_id: "",
    reference_path: [],
    source_clause: "7.2.6",
    reference_source_clause: "",
    reference_from_clause: "",
    table_semantics: tableSemantics(evidenceId),
    inspection_data_type: "measurement",
    inspection_data_type_reason: "量测后与允许偏差比较",
    inspection_data_type_evidence_ids: [evidenceId],
    sampling: {
      status: "explicit",
      min_sampling: "1",
      script: "",
      reason: "test",
      confidence: 1,
      evidence_ids: [evidenceId],
    },
    ...overrides,
  };
}

describe("deterministic coverage risk gate", () => {
  test("routes suspicious field equality to review instead of approving an otherwise simple table row", () => {
    const row = evidenceRecord("row-a");
    const candidate = item("item-a", row.evidence_id, { requirement: "量测", method: "量测" });
    const before = structuredClone(candidate);
    const result = deriveCoverageRiskGate({ evidence: manifest([row]), items: [candidate],
      ledger_available: true, ledger_scope_resolved: true, ledger_vacuous: false });
    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a"]);
    expect(result.reasons.some(reason => reason.code === "delivery_field_comparison")).toBe(true);
    expect(candidate).toEqual(before);
  });
  test("keeps a simple one-row direct table leaf out of semantic review", () => {
    const row = evidenceRecord("row-a");
    const result = deriveCoverageRiskGate({
      evidence: manifest([row]),
      items: [item("item-a", row.evidence_id)],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
    });

    expect(result.clean).toBe(true);
    expect(result.scope).toEqual({
      mode: "risk_delta",
      affected_item_ids: [],
      affected_evidence_ids: [],
      finding_ids: [],
    });
    expect(result.reasons).toEqual([]);
  });

  test("routes a one-row-to-many-leaves split to narrow semantic review", () => {
    const row = evidenceRecord("row-a");
    const result = deriveCoverageRiskGate({
      evidence: manifest([row]),
      items: [item("item-a", row.evidence_id), item("item-b", row.evidence_id)],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a", "item-b"]);
    expect(result.scope.affected_evidence_ids).toEqual(["row-a"]);
    expect(result.reasons.some((reason) => reason.code === "table_row_split")).toBe(true);
  });

  test("routes explicit table sampling imported from a separate prose clause", () => {
    const row = evidenceRecord("row-a");
    const sampling = evidenceRecord("sampling-a", {
      kind: "paragraph",
      role: "supporting_clause",
      table_row_kind: undefined,
      table_id: undefined,
      row_index: undefined,
      text: "每50m³至少留置1组试件。",
    } as Partial<EvidenceRecord>);
    const candidate = item("item-a", row.evidence_id, {
      sampling: {
        status: "explicit",
        min_sampling: "每50m³至少1组",
        script: "",
        reason: "外部条文给出试件数量",
        confidence: 1,
        evidence_ids: [sampling.evidence_id],
      },
    });
    const result = deriveCoverageRiskGate({
      evidence: manifest([row, sampling]),
      items: [candidate],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a"]);
    expect(result.scope.affected_evidence_ids).toEqual(["sampling-a"]);
    expect(result.reasons.some((reason) => reason.code === "sampling_external_evidence")).toBe(true);
  });

  test("routes references, fallback sampling and uncovered primary evidence", () => {
    const row = evidenceRecord("row-a");
    const uncovered = evidenceRecord("row-b", { text: "uncovered source row" });
    const risky = item("item-a", row.evidence_id, {
      reference_evidence_ids: [row.evidence_id],
      reference_resolution_ids: ["resolution-1"],
      reference_path: ["4.2"],
      sampling: {
        status: "fallback",
        min_sampling: "",
        script: "",
        reason: "no exact quantity",
        confidence: 0.2,
        evidence_ids: [],
      },
    });
    const result = deriveCoverageRiskGate({
      evidence: manifest([row, uncovered]),
      items: [risky],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
      uncovered_primary_evidence_ids: [uncovered.evidence_id],
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a"]);
    expect(result.scope.affected_evidence_ids).toEqual(["row-a", "row-b"]);
    expect(new Set(result.reasons.map((reason) => reason.code))).toEqual(new Set([
      "uncovered_primary_evidence",
      "document_reference",
      "sampling_fallback",
    ]));
  });

  test("falls back to full semantic review when ledger scope is unavailable", () => {
    const rowA = evidenceRecord("row-a");
    const rowB = evidenceRecord("row-b");
    const result = deriveCoverageRiskGate({
      evidence: manifest([rowA, rowB]),
      items: [item("item-a", rowA.evidence_id), item("item-b", rowB.evidence_id)],
      ledger_available: false,
      ledger_scope_resolved: false,
      ledger_vacuous: false,
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a", "item-b"]);
    expect(result.scope.affected_evidence_ids).toEqual(["row-a", "row-b"]);
    expect(result.reasons[0]?.code).toBe("ledger_unavailable");
  });

  test("keeps prose leaves in narrow semantic review even when ledger coverage is clean", () => {
    const source = evidenceRecord("prose-a", {
      kind: "paragraph",
      role: "supporting_clause",
      text: "7.2.7 桩顶标高应符合设计要求。",
      clause_id: "7.2.7",
    });
    delete source.table_row_kind;
    delete source.table_id;
    delete source.row_index;
    const proseItem = item("item-prose", source.evidence_id, {
      table_semantics: null,
      source_clause: "7.2.7",
    });
    const result = deriveCoverageRiskGate({
      evidence: manifest([source]),
      items: [proseItem],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-prose"]);
    expect(result.reasons.some((reason) => reason.code === "prose_semantic_review")).toBe(true);
  });

  test("does not auto-approve a target whose ledger window contains an anomaly", () => {
    const row = evidenceRecord("row-a");
    const result = deriveCoverageRiskGate({
      evidence: manifest([row]),
      items: [item("item-a", row.evidence_id)],
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: false,
      ledger_scope_has_anomalies: true,
    });

    expect(result.clean).toBe(false);
    expect(result.scope.affected_item_ids).toEqual(["item-a"]);
    expect(result.reasons[0]?.code).toBe("ledger_scope_anomaly");
  });
});
