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
import { createCoverageReviewTools } from "../src/coverage-review.js";
import { COVERAGE_REVIEW_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { SOURCE_HANDLE_INSTRUCTION } from "../src/model-source-handles.js";
import { PiSessionTelemetry } from "../src/session-telemetry.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "fixtures/real/GB_50202-2018.md");

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
    item_id: `telemetry:7.2:row:${String(index + 1).padStart(2, "0")}`,
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
    inspection_data_type_reason: "Telemetry replay keeps each real formal-row source as one bounded final leaf.",
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
  item.reference_resolution_ids = [`telemetry-reference:${path}:${item.item_id}`];
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

function providerTools(): unknown[] {
  return createCoverageReviewTools({} as never).map((tool) => {
    const row = tool as unknown as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: row.name,
        description: row.description,
        parameters: row.parameters,
      },
    };
  });
}

type EmulatedStep = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

function emulateCoverageWire(
  mode: "full" | "risk_delta" | "repair_delta",
  steps: EmulatedStep[],
): ReturnType<PiSessionTelemetry["snapshot"]> {
  const systemPrompt = `${COVERAGE_REVIEW_SYSTEM_PROMPT}\n\n${SOURCE_HANDLE_INSTRUCTION}`;
  const prompt = mode === "full"
    ? "Independently review target 7.2 排桩 for lossless semantic coverage."
    : mode === "risk_delta"
      ? "Review only the deterministic risk_delta obligations for target 7.2 排桩."
      : "Review only the persisted repair_delta after the 7.2.5 coverage repair.";
  const telemetry = new PiSessionTelemetry(`coverage_review:${mode}:wire_emulation`, systemPrompt);
  telemetry.recordPrompt(prompt);
  const tools = providerTools();
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  const observe = () => telemetry.observeProviderRequest({
    model: "external-subagent-emulation",
    messages,
    tools,
    max_tokens: 32_768,
  });
  observe();
  for (const [index, step] of steps.entries()) {
    const callId = `call-${index + 1}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name: step.name,
          arguments: JSON.stringify(step.args),
        },
      }],
    });
    const text = JSON.stringify(step.result);
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: text,
    });
    telemetry.recordToolResult(step.name, {
      content: [{ type: "text", text }],
      details: step.result,
    });
    observe();
  }
  return telemetry.snapshot();
}

function stageRecords(items: MaterializedAcceptanceItem[], evidenceIds: string[]) {
  // One production fresh phase reads at most eight leaf details in this replay
  // and persists at most 32 semantic changes. Full review therefore models one
  // bounded phase, not an impossible monolithic 59-leaf stage.
  const stagedItems = items.slice(0, 8);
  const evidenceCapacity = Math.max(0, 32 - stagedItems.length);
  return {
    status: "approved",
    summary: "External subagent wire replay.",
    semantic_coverage_upserts: [
      ...stagedItems.map((item, index) => ({
        coverage_id: `coverage:item:${index + 1}`,
        disposition: "acceptance_item",
        judgment_id: `judgment:${index + 1}`,
        item_ids: [item.item_id],
        evidence_bindings: item.evidence_ids.slice(0, 1).map((evidenceId) => ({
          evidence_id: evidenceId,
          span_id: `span:${evidenceId}`,
        })),
        reason: "Scoped leaf reviewed at the external model boundary.",
      })),
      ...evidenceIds.slice(0, evidenceCapacity).map((evidenceId, index) => ({
        coverage_id: `coverage:evidence:${index + 1}`,
        disposition: "shared_context",
        judgment_id: "",
        item_ids: [],
        evidence_bindings: [{ evidence_id: evidenceId, span_id: `span:${evidenceId}` }],
        reason: "Scoped uncovered evidence reviewed as context.",
      })),
    ],
    finding_upserts: [],
  };
}

function phaseSteps(
  mode: "full" | "risk_delta" | "repair_delta",
  items: MaterializedAcceptanceItem[],
  evidence: EvidenceManifest["evidence"],
): EmulatedStep[] {
  const evidenceIds = evidence.map((record) => record.evidence_id);
  const stage = stageRecords(items, evidenceIds);
  return [
    {
      name: "get_coverage_review_contract",
      args: {},
      result: {
        ok: true,
        review_scope: {
          mode,
          affected_item_ids: items.map((item) => item.item_id),
          affected_evidence_ids: evidenceIds,
          finding_ids: mode === "repair_delta" ? ["subagent-gap:7.2.5:anti-permeability"] : [],
        },
        coverage_obligations: {
          mode,
          required_item_ids: items.map((item) => item.item_id),
          uncovered_primary_evidence_ids: evidenceIds,
          review_record_count: items.length + evidence.length,
          searchable_evidence_count: evidence.length,
        },
      },
    },
    {
      name: "read_candidate_plan",
      args: { cursor: 0, max_items: 128 },
      result: {
        ok: true,
        items: items.map((item) => ({
          item_id: item.item_id,
          name: item.name,
          category: item.category,
          source_clause: item.source_clause,
          evidence_ids: item.evidence_ids,
        })),
        next_cursor: null,
      },
    },
    {
      name: "read_candidate_leaf_details",
      args: { item_ids: items.map((item) => item.item_id).slice(0, 8) },
      result: {
        ok: true,
        items: items.slice(0, 8),
      },
    },
    {
      name: "batch_open_review_evidence",
      args: { evidence_ids: evidenceIds.slice(0, 50) },
      result: {
        ok: true,
        evidence: evidence.slice(0, 50).map((record) => ({
          evidence_id: record.evidence_id,
          locator: record.locator,
          clause_id: record.clause_id,
          table_id: record.table_id,
          text: record.text,
        })),
      },
    },
    {
      name: "stage_coverage_review_draft",
      args: stage,
      result: {
        ok: true,
        validation: { ok: true, fingerprint: "emulated-review-fingerprint" },
      },
    },
    {
      name: "seal_coverage_review",
      args: { fingerprint: "emulated-review-fingerprint" },
      result: { ok: true, status: "approved" },
    },
  ];
}

describe("GB50202 coverage provider-context telemetry", () => {
  test("measures full, risk_delta, and repair_delta model-boundary wire contexts", async () => {
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
    const jobId = "coverage-session-telemetry-gb50202";
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

    const c724 = clauseEvidenceIds(manifest, "7.2.4");
    const c725 = clauseEvidenceIds(manifest, "7.2.5");
    const c727 = clauseEvidenceIds(manifest, "7.2.7");
    const integrity = findItem(rowItems, "7.2.6", "桩身完整性");
    addReference(integrity, "7.2.4", c724);
    setSampling(integrity, "explicit", c724, "7.2.4 defines integrity sampling branches.");
    setSampling(
      findItem(rowItems, "7.2.6", "混凝土强度"),
      "explicit",
      c725,
      "7.2.5 supplies specimen frequency.",
    );
    addReference(findItem(rowItems, "7.2.6", "泥浆指标"), "5.6", []);
    const verticality = findItem(rowItems, "7.2.6", "垂直度");
    verticality.table_semantics = {
      ...verticality.table_semantics!,
      condition: "普通排桩；桩墙合一设计",
      allowed_value: "≤1/100；≤1/200",
    };
    for (const [tableId, needle] of [
      ["7.2.8", "桩身强度"],
      ["7.2.9", "桩身强度"],
      ["7.2.10", "墙体强度"],
      ["7.2.11", "桩身强度"],
    ] as const) {
      setSampling(findItem(rowItems, tableId, needle), "reference", c727, "7.2.7 shared sampling semantics.");
    }

    const ledgerCoverage = evaluateTargetLedgerCoverage({
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
      ledger_vacuous: ledgerCoverage.vacuous,
      ledger_scope_has_anomalies: ledger.anomalies.some((anomaly) =>
        anomaly.line >= own!.start_line && anomaly.line < own!.end_exclusive_line
      ),
      unaccounted_candidate_clause_ids: ledgerCoverage.unaccounted_candidate_clause_ids,
      gap_clause_ids: ledgerCoverage.gap_clause_ids,
      gap_evidence_ids: ledgerCoverage.gap_evidence_ids,
    });
    const itemById = new Map(items.map((item) => [item.item_id, item]));
    const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
    const riskItems = gate.scope.affected_item_ids
      .map((itemId) => itemById.get(itemId))
      .filter((item): item is MaterializedAcceptanceItem => Boolean(item));
    const riskEvidence = gate.scope.affected_evidence_ids
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((record): record is EvidenceManifest["evidence"][number] => Boolean(record));
    expect(riskItems.length).toBeGreaterThan(0);
    expect(riskItems.length).toBeLessThan(15);
    expect(riskEvidence.length).toBeGreaterThan(0);

    const fullEvidence = manifest.evidence.filter((record) =>
      record.evidence_scope === "primary" || record.requires_disposition
    );
    const repairedItem: MaterializedAcceptanceItem = {
      item_id: "subagent:7.2.5:anti-permeability",
      name: "抗渗等级",
      category: "主控项目",
      requirement: "有抗渗等级要求的灌注桩尚应留置抗渗等级检测试件。",
      method: "",
      quantity: "一个级配不宜少于 3 组",
      note: "",
      evidence_ids: [...c725],
      reference_evidence_ids: [],
      reference_resolution_ids: [],
      reference_origin_item_id: "",
      reference_path: [],
      source_clause: "7.2.5",
      reference_source_clause: "",
      reference_from_clause: "",
      inspection_data_type: "review",
      inspection_data_type_reason: "Coverage repair leaf; exact inspection result type remains a domain review.",
      inspection_data_type_evidence_ids: [...c725],
      sampling: {
        status: "explicit",
        min_sampling: "一个级配不宜少于 3 组",
        script: "一个级配不宜少于 3 组",
        reason: "7.2.5 conditionally requires anti-permeability specimens.",
        confidence: 1,
        evidence_ids: [...c725],
      },
    };
    const repairEvidence = c725
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((record): record is EvidenceManifest["evidence"][number] => Boolean(record));

    const full = emulateCoverageWire("full", phaseSteps("full", items, fullEvidence));
    const risk = emulateCoverageWire("risk_delta", phaseSteps("risk_delta", riskItems, riskEvidence));
    const repair = emulateCoverageWire("repair_delta", phaseSteps("repair_delta", [repairedItem], repairEvidence));

    const report = {
      schema_version: "gb50202-coverage-session-telemetry/v1",
      target: "7.2 排桩",
      measurement_mode: "provider_wire_emulation_with_real_tool_schemas_and_real_GB50202_scoped_payloads",
      token_note: "CI has no live provider call in this replay, so provider token usage remains unobserved. Production runLiveConstrainedSession now emits pi-session-telemetry/v1 with actual SDK token usage whenever the provider returns it.",
      full_review: {
        leaf_count: items.length,
        evidence_count: fullEvidence.length,
        telemetry: full,
      },
      risk_delta: {
        leaf_count: riskItems.length,
        evidence_count: riskEvidence.length,
        telemetry: risk,
      },
      repair_delta: {
        leaf_count: 1,
        evidence_count: repairEvidence.length,
        telemetry: repair,
      },
      reduction: {
        full_to_risk_peak_request_percent: Number(
          (((full.provider_request_peak_utf8_bytes - risk.provider_request_peak_utf8_bytes)
            / full.provider_request_peak_utf8_bytes) * 100).toFixed(1),
        ),
        risk_to_repair_peak_request_percent: Number(
          (((risk.provider_request_peak_utf8_bytes - repair.provider_request_peak_utf8_bytes)
            / risk.provider_request_peak_utf8_bytes) * 100).toFixed(1),
        ),
        full_to_repair_peak_request_percent: Number(
          (((full.provider_request_peak_utf8_bytes - repair.provider_request_peak_utf8_bytes)
            / full.provider_request_peak_utf8_bytes) * 100).toFixed(1),
        ),
      },
    };
    console.info(`GB50202_COVERAGE_SESSION_TELEMETRY=${JSON.stringify(report)}`);

    expect(full.token_observation_available).toBe(false);
    expect(risk.provider_request_peak_utf8_bytes).toBeLessThan(full.provider_request_peak_utf8_bytes);
    expect(repair.provider_request_peak_utf8_bytes).toBeLessThan(risk.provider_request_peak_utf8_bytes);
    expect(report.reduction.full_to_risk_peak_request_percent).toBeGreaterThan(0);
    expect(report.reduction.full_to_repair_peak_request_percent).toBeGreaterThan(0);
  }, 180_000);
});
