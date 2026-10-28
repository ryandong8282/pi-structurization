import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type {
  MaterializedAcceptanceItem,
  TableCriterionSemantics,
} from "../src/contracts.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
} from "../src/document-discovery.js";
import {
  evaluateTargetLedgerCoverage,
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { targetOwnScopeForTarget } from "../src/batch.js";
import { deriveCoverageRiskGate } from "../src/coverage-risk-gate.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "fixtures/real/GB_50202-2018.md");

function utf8(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function percentReduction(before: number, after: number): number {
  return before === 0 ? 0 : Number((((before - after) / before) * 100).toFixed(1));
}

function directTableItem(
  row: {
    evidence_id: string;
    text: string;
    table_id?: string;
    row_index?: number;
  },
  index: number,
): MaterializedAcceptanceItem {
  const tableId = row.table_id ?? "";
  const tableSemantics: TableCriterionSemantics = {
    source_kind: "direct",
    table_id: tableId,
    table_no: tableId,
    table_title: "",
    applicability: "",
    row_path: [`row:${row.row_index ?? index + 1}`],
    column_path: [],
    unit: "",
    condition: "",
    allowed_value: "",
    inspection_method: "",
    cell_evidence: [{
      role: "row_header",
      evidence_id: row.evidence_id,
      text: row.text.slice(0, Math.min(row.text.length, 120)),
    }],
    reference_fragments: [],
  };
  return {
    item_id: `benchmark:7.2:row:${String(index + 1).padStart(2, "0")}`,
    name: row.text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || `表格行 ${index + 1}`,
    category: "一般项目",
    requirement: row.text,
    method: "",
    quantity: "",
    note: "",
    evidence_ids: [row.evidence_id],
    reference_evidence_ids: [],
    reference_resolution_ids: [],
    reference_origin_item_id: "",
    reference_path: [],
    source_clause: tableId,
    reference_source_clause: "",
    reference_from_clause: "",
    table_semantics: tableSemantics,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "Benchmark direct formal table row; semantic extraction is intentionally not re-run.",
    inspection_data_type_evidence_ids: [row.evidence_id],
    sampling: {
      status: "not_sampling",
      min_sampling: "",
      script: "灰显",
      reason: "Benchmark isolates coverage-review routing cost from sampling semantics.",
      confidence: 1,
      evidence_ids: [],
    },
  };
}

describe("GB50202 coverage-review workset benchmark", () => {
  test("quantifies full-review versus deterministic risk-delta workset for 7.2 排桩", async () => {
    const markdown = await readFile(fixturePath, "utf8");
    const document = buildDocumentEvidence(markdown, basename(fixturePath));
    const ledger = scanDocumentLedger(markdown, basename(fixturePath));
    const registry = registryWithFullSourceSpans(
      document.evidence_fingerprint,
      document.atoms.map((atom) => ({
        source_id: atom.atom_id,
        evidence_id: atom.atom_id,
        atom_id: atom.atom_id,
        text: atom.text,
      })),
    );
    const jobId = "benchmark-gb50202-risk-delta";
    const prefilled = prefillDocumentSelectorsFromLedger(jobId, document.atoms, ledger, registry);
    const selectors = compileDocumentSelectors(approveScopeFixture(prefilled.selectors, prefilled.registry, document), prefilled.registry, document, jobId);
    const target = selectors.targets.find((candidate) => candidate.name === "排桩");
    expect(target).toBeDefined();
    const own = targetOwnScopeForTarget(target!, ledger, document.atoms);
    expect(own).toBeDefined();
    const manifest = (await buildAgentScopedEvidenceManifest(
      fixturePath,
      jobId,
      target!,
      document,
      undefined,
      own!,
    )).manifest;

    const formalRows = manifest.evidence.filter((record) =>
      record.role === "formal_table_row"
      && record.table_row_kind === "data"
      && record.evidence_scope === "primary"
    );
    expect(formalRows).toHaveLength(59);
    const items = formalRows.map((row, index) => directTableItem(row, index));

    const coverage = evaluateTargetLedgerCoverage({
      ledger,
      start_line: own!.start_line,
      end_exclusive_line: own!.end_exclusive_line,
      source_clauses: items.map((item) => item.source_clause),
      evidence: manifest.evidence,
    });
    const scopeAnomalies = ledger.anomalies.filter((anomaly) =>
      anomaly.line >= own!.start_line && anomaly.line < own!.end_exclusive_line
    );
    const gate = deriveCoverageRiskGate({
      evidence: manifest,
      items,
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: coverage.vacuous,
      ledger_scope_has_anomalies: scopeAnomalies.length > 0,
      gap_clause_ids: coverage.gap_clause_ids,
      gap_evidence_ids: coverage.gap_evidence_ids,
      unaccounted_candidate_clause_ids: coverage.unaccounted_candidate_clause_ids,
    });

    const itemById = new Map(items.map((item) => [item.item_id, item]));
    const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
    const riskItems = gate.scope.affected_item_ids.map((itemId) => itemById.get(itemId)!).filter(Boolean);
    const riskEvidence = gate.scope.affected_evidence_ids
      .map((evidenceId) => evidenceById.get(evidenceId)!)
      .filter(Boolean);

    const primaryEvidence = manifest.evidence.filter((record) =>
      record.evidence_scope === "primary" || record.requires_disposition
    );
    const fullLeafPayloadBytes = utf8(items);
    const riskLeafPayloadBytes = utf8(riskItems);
    const fullSourceBytes = primaryEvidence.reduce((sum, record) => sum + utf8(record.text), 0);
    const riskSourceBytes = riskEvidence.reduce((sum, record) => sum + utf8(record.text), 0);
    const fullWorksetBytes = fullLeafPayloadBytes + fullSourceBytes;
    const riskWorksetBytes = riskLeafPayloadBytes + riskSourceBytes;

    const report = {
      schema_version: "coverage-risk-benchmark/v1",
      fixture: "GB 50202-2018",
      target: "7.2 排桩",
      note: "Uses the real current evidence parser/ledger and 59 real formal table-row evidence records. The semantic extractor/model is not re-run; each formal row is represented as a direct one-row final leaf solely to measure coverage-review routing. Byte counts are deterministic workset/wire proxies, not observed provider tokens.",
      source_scope: {
        start_line: own!.start_line,
        end_exclusive_line: own!.end_exclusive_line,
        evidence_count: manifest.evidence.length,
        primary_evidence_count: primaryEvidence.length,
        formal_table_row_count: formalRows.length,
        table_ids: [...new Set(formalRows.map((row) => row.table_id))].sort(),
      },
      ledger: {
        required_clause_ids: coverage.required_clause_ids,
        candidate_clause_ids: coverage.candidate_clause_ids,
        gap_clause_ids: coverage.gap_clause_ids,
        unaccounted_candidate_clause_ids: coverage.unaccounted_candidate_clause_ids,
        anomaly_count: scopeAnomalies.length,
      },
      full_review: {
        leaf_obligation_count: items.length,
        candidate_leaf_payload_bytes: fullLeafPayloadBytes,
        primary_source_text_bytes: fullSourceBytes,
        deterministic_workset_bytes: fullWorksetBytes,
      },
      risk_delta: {
        leaf_obligation_count: gate.scope.affected_item_ids.length,
        evidence_obligation_count: gate.scope.affected_evidence_ids.length,
        candidate_leaf_payload_bytes: riskLeafPayloadBytes,
        source_text_bytes: riskSourceBytes,
        deterministic_workset_bytes: riskWorksetBytes,
        reason_codes: [...new Set(gate.reasons.map((reason) => reason.code))],
        affected_item_ids: gate.scope.affected_item_ids,
        affected_evidence_ids: gate.scope.affected_evidence_ids,
      },
      reduction: {
        leaf_obligations_percent: Number((((items.length - gate.scope.affected_item_ids.length) / items.length) * 100).toFixed(1)),
        candidate_leaf_payload_percent: percentReduction(fullLeafPayloadBytes, riskLeafPayloadBytes),
        source_text_percent: percentReduction(fullSourceBytes, riskSourceBytes),
        deterministic_workset_percent: percentReduction(fullWorksetBytes, riskWorksetBytes),
      },
    };

    console.info(`GB50202_COVERAGE_RISK_BENCHMARK=${JSON.stringify(report)}`);

    // The purpose of the gate is to prevent the 59 simple formal table leaves
    // from being re-enumerated merely because the reviewer must inspect prose/ledger gaps.
    expect(gate.scope.affected_item_ids).toEqual([]);
    expect(gate.scope.affected_evidence_ids.length).toBeGreaterThan(0);
    expect(report.reduction.leaf_obligations_percent).toBe(100);
    expect(report.reduction.deterministic_workset_percent).toBeGreaterThan(50);
  }, 180_000);
});
