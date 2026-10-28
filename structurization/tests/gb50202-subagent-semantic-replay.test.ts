import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type {
  EvidenceManifest,
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
const reviewFixturePath = resolve(
  projectRoot,
  "fixtures/subagent/gb50202-7.2-review.json",
);

interface SubagentReviewFixture {
  schema_version: "gb50202-subagent-review/v1";
  target: string;
  model_boundary: string;
  source_basis: string;
  prose_decisions: Array<{
    clause_id: string;
    disposition: string;
    target_table?: string;
    target_tables?: string[];
    target_item_contains?: string;
    target_item_contains_any?: string[];
    reason: string;
    finding?: {
      finding_type: "semantic_coverage_gap";
      missing_item_name: string;
      condition: string;
      sampling: string;
    };
  }>;
  table_risk_decisions: Array<{
    table_id: string;
    item_contains: string;
    disposition: string;
    reason: string;
  }>;
  expected_status: "approved" | "repair";
  expected_gap_count: number;
}

function utf8(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
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
    item_id: `subagent:7.2:row:${String(index + 1).padStart(2, "0")}`,
    name: row.text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100),
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
    inspection_data_type_reason: "External subagent replay keeps the real formal-row source and isolates coverage routing.",
    inspection_data_type_evidence_ids: [row.evidence_id],
    sampling: {
      status: "not_sampling",
      min_sampling: "",
      script: "灰显",
      reason: "No external sampling attached yet.",
      confidence: 1,
      evidence_ids: [],
    },
  };
}

function clauseEvidenceIds(manifest: EvidenceManifest, clauseId: string): string[] {
  const prefix = new RegExp(`^${clauseId.replaceAll(".", "\\.")}\\s`, "u");
  return manifest.evidence
    .filter((record) =>
      record.evidence_scope === "primary"
      && (record.clause_id === clauseId || prefix.test(record.text))
    )
    .map((record) => record.evidence_id);
}

function findItem(
  rows: Array<{ record: EvidenceManifest["evidence"][number]; item: MaterializedAcceptanceItem }>,
  tableId: string,
  needle: string,
): MaterializedAcceptanceItem {
  const match = rows.find(({ record }) =>
    record.table_id === tableId && record.text.includes(needle)
  );
  if (!match) throw new Error(`missing table item ${tableId} / ${needle}`);
  return match.item;
}

function addReference(item: MaterializedAcceptanceItem, path: string, evidenceIds: string[]): void {
  item.reference_path = [path];
  item.reference_resolution_ids = [`subagent-reference:${path}:${item.item_id}`];
  item.reference_evidence_ids = [...evidenceIds];
}

function setSampling(
  item: MaterializedAcceptanceItem,
  status: "explicit" | "reference",
  evidenceIds: string[],
  reason: string,
): void {
  item.sampling = {
    status,
    min_sampling: "见外部条文语义",
    script: "",
    reason,
    confidence: 1,
    evidence_ids: [...evidenceIds],
  };
}

describe("GB50202 real subagent-for-Pi replay", () => {
  test("runs the real 7.2 evidence/ledger through a model-authored selector boundary and the new risk gate", async () => {
    const [markdown, reviewFixtureText] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(reviewFixturePath, "utf8"),
    ]);
    const reviewFixture = JSON.parse(reviewFixtureText) as SubagentReviewFixture;
    expect(reviewFixture.model_boundary).toBe("external_subagent_emulated_by_chatgpt");

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
    const jobId = "subagent-semantic-replay-gb50202";
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
    const rowItems = formalRows.map((record, index) => ({
      record,
      item: directTableItem(record, index),
    }));
    const items = rowItems.map(({ item }) => item);

    // External-subagent semantic enrichment: the model boundary is replaced by
    // the checked-in review fixture and these exact source-linked decisions.
    const c724 = clauseEvidenceIds(manifest, "7.2.4");
    const c725 = clauseEvidenceIds(manifest, "7.2.5");
    const c727 = clauseEvidenceIds(manifest, "7.2.7");
    expect(c724.length).toBeGreaterThan(0);
    expect(c725.length).toBeGreaterThan(0);
    expect(c727.length).toBeGreaterThan(0);

    const integrity = findItem(rowItems, "7.2.6", "桩身完整性");
    addReference(integrity, "7.2.4", c724);
    setSampling(integrity, "explicit", c724, "7.2.4 defines method/quantity branches for the existing integrity leaf.");

    const concreteStrength = findItem(rowItems, "7.2.6", "混凝土强度");
    setSampling(
      concreteStrength,
      "explicit",
      c725,
      "7.2.5 supplies specimen frequency outside the direct table row.",
    );

    const mud = findItem(rowItems, "7.2.6", "泥浆指标");
    addReference(mud, "5.6", []);

    const verticality = findItem(rowItems, "7.2.6", "垂直度");
    verticality.table_semantics = {
      ...verticality.table_semantics!,
      condition: "普通排桩；桩墙合一设计",
      allowed_value: "≤1/100；≤1/200",
      cell_evidence: [
        ...verticality.table_semantics!.cell_evidence,
        {
          role: "allowed_value",
          evidence_id: verticality.evidence_ids[0]!,
          text: "≤1/100",
        },
        {
          role: "allowed_value",
          evidence_id: verticality.evidence_ids[0]!,
          text: "≤1/200",
        },
      ],
    };

    for (const [tableId, strengthNeedle] of [
      ["7.2.8", "桩身强度"],
      ["7.2.9", "桩身强度"],
      ["7.2.10", "墙体强度"],
      ["7.2.11", "桩身强度"],
    ] as const) {
      setSampling(
        findItem(rowItems, tableId, strengthNeedle),
        "reference",
        c727,
        "7.2.7 is a shared method/sampling rule whose branch depends on curtain construction method.",
      );
    }

    const coverage = evaluateTargetLedgerCoverage({
      ledger,
      start_line: own!.start_line,
      end_exclusive_line: own!.end_exclusive_line,
      source_clauses: items.map((item) => item.source_clause),
      evidence: manifest.evidence,
    });
    const gate = deriveCoverageRiskGate({
      evidence: manifest,
      items,
      ledger_available: true,
      ledger_scope_resolved: true,
      ledger_vacuous: coverage.vacuous,
      ledger_scope_has_anomalies: ledger.anomalies.some((anomaly) =>
        anomaly.line >= own!.start_line && anomaly.line < own!.end_exclusive_line
      ),
      unaccounted_candidate_clause_ids: coverage.unaccounted_candidate_clause_ids,
      gap_clause_ids: coverage.gap_clause_ids,
      gap_evidence_ids: coverage.gap_evidence_ids,
    });

    const riskItemById = new Map(items.map((item) => [item.item_id, item]));
    const riskItems = gate.scope.affected_item_ids.map((itemId) => riskItemById.get(itemId)!).filter(Boolean);
    const riskNames = riskItems.map((item) => ({
      table: item.source_clause,
      name: item.name,
    }));
    const reasonCodes = [...new Set(gate.reasons.map((reason) => reason.code))].sort();

    const subagentGapDecisions = reviewFixture.prose_decisions
      .flatMap((decision) => decision.finding ? [{ clause_id: decision.clause_id, ...decision.finding }] : []);
    expect(subagentGapDecisions).toHaveLength(reviewFixture.expected_gap_count);
    expect(subagentGapDecisions[0]).toMatchObject({
      clause_id: "7.2.5",
      finding_type: "semantic_coverage_gap",
      missing_item_name: "灌注桩抗渗等级",
    });

    // The narrowed packet must retain the source evidence that allowed the
    // external reviewer to discover the conditional anti-permeability gap.
    expect(gate.scope.affected_evidence_ids.some((evidenceId) => c725.includes(evidenceId))).toBe(true);

    // All table leaves that the external model said need semantic attention
    // must survive the deterministic gate.
    for (const decision of reviewFixture.table_risk_decisions) {
      const item = findItem(rowItems, decision.table_id, decision.item_contains);
      expect(gate.scope.affected_item_ids).toContain(item.item_id);
    }
    for (const decision of reviewFixture.prose_decisions) {
      if (decision.disposition === "bind_existing_item" && decision.target_table && decision.target_item_contains) {
        const item = findItem(rowItems, decision.target_table, decision.target_item_contains);
        expect(gate.scope.affected_item_ids).toContain(item.item_id);
      }
      if (decision.disposition === "bind_existing_item_and_gap" && decision.target_table && decision.target_item_contains) {
        const item = findItem(rowItems, decision.target_table, decision.target_item_contains);
        expect(gate.scope.affected_item_ids).toContain(item.item_id);
      }
      if (decision.disposition === "bind_existing_items" && decision.target_tables && decision.target_item_contains_any) {
        for (const tableId of decision.target_tables) {
          const item = decision.target_item_contains_any
            .flatMap((needle) => {
              try { return [findItem(rowItems, tableId, needle)]; } catch { return []; }
            })[0];
          expect(item, `missing reviewed strength item in ${tableId}`).toBeDefined();
          expect(gate.scope.affected_item_ids).toContain(item!.item_id);
        }
      }
    }

    const primary = manifest.evidence.filter((record) =>
      record.evidence_scope === "primary" || record.requires_disposition
    );
    const fullBytes = utf8(items)
      + primary.reduce((sum, record) => sum + utf8(record.text), 0);
    const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
    const riskEvidence = gate.scope.affected_evidence_ids
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    const riskBytes = utf8(riskItems)
      + riskEvidence.reduce((sum, record) => sum + utf8(record.text), 0);

    const report = {
      schema_version: "gb50202-subagent-live-replay/v1",
      target: reviewFixture.target,
      model_boundary: reviewFixture.model_boundary,
      full_review: {
        leaf_count: items.length,
        workset_bytes: fullBytes,
      },
      risk_delta: {
        leaf_count: riskItems.length,
        evidence_count: riskEvidence.length,
        workset_bytes: riskBytes,
        reason_codes: reasonCodes,
        items: riskNames,
      },
      external_subagent_review: {
        status: reviewFixture.expected_status,
        gap_count: subagentGapDecisions.length,
        gaps: subagentGapDecisions,
        prose_decisions: reviewFixture.prose_decisions.map((decision) => ({
          clause_id: decision.clause_id,
          disposition: decision.disposition,
        })),
      },
      reduction: {
        leaf_count_percent: Number((((items.length - riskItems.length) / items.length) * 100).toFixed(1)),
        workset_percent: Number((((fullBytes - riskBytes) / fullBytes) * 100).toFixed(1)),
      },
    };
    console.info(`GB50202_SUBAGENT_LIVE_REPLAY=${JSON.stringify(report)}`);

    expect(items).toHaveLength(59);
    expect(riskItems.length).toBeGreaterThan(0);
    expect(riskItems.length).toBeLessThan(15);
    expect(report.reduction.leaf_count_percent).toBeGreaterThan(70);
    expect(reviewFixture.expected_status).toBe("repair");
  }, 180_000);
});
