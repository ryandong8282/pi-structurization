import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { sha256Json } from "../src/canonical.js";
import {
  PLAN_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
  type TableCriterionSemantics,
} from "../src/contracts.js";
import {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  coverageReviewObligations,
  deriveCoverageRepairRecheckScope,
  validateCoverageReview,
  type CoverageReviewScope,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
} from "../src/document-discovery.js";
import {
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { targetOwnScopeForTarget } from "../src/batch.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "fixtures/real/GB_50202-2018.md");
const repairFixturePath = resolve(
  projectRoot,
  "fixtures/subagent/gb50202-7.2-repair.json",
);

interface RepairFixture {
  schema_version: "gb50202-subagent-repair/v1";
  target: string;
  finding_id: string;
  source_clause: string;
  action: "add_acceptance_item";
  item: {
    item_id: string;
    name: string;
    category: "主控项目" | "一般项目";
    category_reason: string;
    requirement: string;
    quantity: string;
    inspection_data_type: "review";
    inspection_data_type_reason: string;
    sampling_reason: string;
  };
  reviewer: {
    expected_status: "approved";
    reason: string;
  };
}

function clauseEvidence(manifest: EvidenceManifest, clauseId: string) {
  const escaped = clauseId.replaceAll(".", "\\.");
  const prefix = new RegExp(`^${escaped}\\s`, "u");
  const rows = manifest.evidence.filter((record) =>
    record.evidence_scope === "primary"
    && (record.clause_id === clauseId || prefix.test(record.text))
  );
  if (!rows.length) throw new Error(`No primary evidence for clause ${clauseId}`);
  return rows;
}

function rowTableSemantics(
  record: EvidenceManifest["evidence"][number],
  index: number,
): TableCriterionSemantics {
  const tableId = record.table_id ?? "";
  return {
    source_kind: "direct",
    table_id: tableId,
    table_no: tableId,
    table_title: "",
    applicability: "",
    row_path: [`row:${record.row_index ?? index + 1}`],
    column_path: [],
    unit: "",
    condition: "",
    allowed_value: "",
    inspection_method: "",
    cell_evidence: [{
      role: "row_header",
      evidence_id: record.evidence_id,
      text: record.text.slice(0, Math.min(record.text.length, 120)),
    }],
    reference_fragments: [],
  };
}

function directFormalRowPlan(
  manifest: EvidenceManifest,
  formalRows: EvidenceManifest["evidence"],
): SemanticSourcePlan {
  const lotId = "subagent:7.2:formal-tables";
  const items = formalRows.map((record, index) => {
    const fields = {
      name: record.text,
      requirement: record.text,
      method: "",
      quantity: "",
      note: "",
    };
    return {
      item_id: `subagent:7.2:row:${String(index + 1).padStart(2, "0")}`,
      lot_id: lotId,
      ...fields,
      category: "一般项目" as const,
      evidence_ids: [record.evidence_id],
      reference_evidence_ids: [],
      table_semantics: rowTableSemantics(record, index),
      inspection_data_type: "measurement" as const,
      inspection_data_type_reason: "Replay source item; classification detail is outside this convergence assertion.",
      inspection_data_type_evidence_ids: [record.evidence_id],
      field_bindings: buildItemFieldBindings(fields, [record.evidence_id], manifest),
      sampling: {
        status: "not_sampling" as const,
        min_sampling: "",
        script: "",
        reason: "No external sampling enrichment is needed for this repair-scope convergence test.",
        confidence: 1,
        evidence_ids: [],
      },
    };
  });
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: manifest.evidence_fingerprint,
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: [{
      lot_id: lotId,
      name: "7.2 排桩表格验收项",
      evidence_ids: [],
      item_ids: items.map((item) => item.item_id),
    }],
    acceptance_items: items,
    reference_resolutions: [],
    evidence_dispositions: items.map((item) => ({
      evidence_id: item.evidence_ids[0]!,
      disposition: "used" as const,
      item_ids: [item.item_id],
      reason: "Direct formal row in the external-subagent replay baseline.",
    })),
    semantic_evidence: items.map((item, index) => ({
      semantic_id: `subagent:row-semantic:${index + 1}`,
      role: "table_criterion" as const,
      evidence_id: item.evidence_ids[0]!,
      exact_fragment: item.requirement,
      parent_semantic_id: "",
      materialized_item_id: item.item_id,
      reason: "Direct table criterion retained from the real formal-row evidence.",
    })),
    semantic_references: [],
    shared_sampling_rules: [],
  };
}

describe("GB50202 subagent repair convergence", () => {
  test("keeps second-pass coverage to the newly repaired anti-permeability leaf and reaches approval", async () => {
    const [markdown, repairText] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(repairFixturePath, "utf8"),
    ]);
    const repairFixture = JSON.parse(repairText) as RepairFixture;
    expect(repairFixture.reviewer.expected_status).toBe("approved");

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
    const jobId = "subagent-repair-convergence-gb50202";
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

    const sourcePlan = directFormalRowPlan(manifest, formalRows);
    const repairedPlan = structuredClone(sourcePlan);
    const clauseRows = clauseEvidence(manifest, repairFixture.source_clause);
    const sourceEvidence = clauseRows[0]!;
    const repairedFields = {
      name: repairFixture.item.name,
      requirement: repairFixture.item.requirement,
      method: "",
      quantity: repairFixture.item.quantity,
      note: "",
    };
    const repairedItem = {
      item_id: repairFixture.item.item_id,
      lot_id: repairedPlan.inspection_lots[0]!.lot_id,
      ...repairedFields,
      category: repairFixture.item.category,
      evidence_ids: [sourceEvidence.evidence_id],
      reference_evidence_ids: [],
      table_semantics: null,
      inspection_data_type: repairFixture.item.inspection_data_type,
      inspection_data_type_reason: repairFixture.item.inspection_data_type_reason,
      inspection_data_type_evidence_ids: [sourceEvidence.evidence_id],
      field_bindings: buildItemFieldBindings(
        repairedFields,
        [sourceEvidence.evidence_id],
        manifest,
      ),
      sampling: {
        status: "explicit" as const,
        min_sampling: repairFixture.item.quantity,
        script: "",
        reason: repairFixture.item.sampling_reason,
        confidence: 1,
        evidence_ids: [sourceEvidence.evidence_id],
      },
    };
    repairedPlan.acceptance_items.push(repairedItem);
    repairedPlan.inspection_lots[0]!.item_ids.push(repairedItem.item_id);
    repairedPlan.evidence_dispositions.push({
      evidence_id: sourceEvidence.evidence_id,
      disposition: "used",
      item_ids: [repairedItem.item_id],
      reason: "Coverage repair adds the conditional anti-permeability acceptance meaning from 7.2.5.",
    });
    repairedPlan.semantic_evidence!.push({
      semantic_id: "subagent:7.2.5:anti-permeability",
      role: "acceptance_item",
      evidence_id: sourceEvidence.evidence_id,
      exact_fragment: sourceEvidence.text,
      parent_semantic_id: "",
      materialized_item_id: repairedItem.item_id,
      reason: "External subagent repair for the previously missing conditional anti-permeability judgment.",
    });

    // This mirrors beginCoverageRepair: a missing-item semantic finding has no
    // affected existing final leaf, but carries its exact finding evidence.
    const findingDrivenBaseScope: CoverageReviewScope = {
      mode: "repair_delta",
      affected_item_ids: [],
      affected_evidence_ids: [sourceEvidence.evidence_id],
      finding_ids: [repairFixture.finding_id],
    };
    const repairScope = deriveCoverageRepairRecheckScope(
      manifest,
      sourcePlan,
      repairedPlan,
      findingDrivenBaseScope,
    );

    expect(repairScope.mode).toBe("repair_delta");
    expect(repairScope.affected_item_ids).toEqual([repairedItem.item_id]);
    expect(repairScope.affected_item_ids.some((itemId) => itemId.startsWith("subagent:7.2:row:"))).toBe(false);
    expect(repairScope.affected_evidence_ids).toContain(sourceEvidence.evidence_id);

    const obligations = coverageReviewObligations(manifest, repairedPlan, repairScope);
    expect(obligations.mode).toBe("repair_delta");
    expect(obligations.required_item_ids).toEqual([repairedItem.item_id]);
    expect(obligations.required_item_ids).toHaveLength(1);
    expect(obligations.required_item_ids.some((itemId) => itemId.startsWith("subagent:7.2:row:"))).toBe(false);

    const reviewFragment = "有抗渗等级要求的灌注桩尚应留置抗渗等级检测试件，一个级配不宜少于 3 组";
    expect(sourceEvidence.text).toContain(reviewFragment);
    const repairedPlanFingerprint = sha256Json(repairedPlan);
    const approvedReview: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: repairedPlanFingerprint,
      evidence_fingerprint: manifest.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "subagent-recheck:anti-permeability",
        disposition: "acceptance_item",
        judgment_id: "judgment:anti-permeability-grade",
        item_ids: [repairedItem.item_id],
        evidence_bindings: [{
          evidence_id: sourceEvidence.evidence_id,
          exact_fragment: reviewFragment,
        }],
        reason: repairFixture.reviewer.reason,
      }],
      findings: [],
      summary: "External-subagent repair recheck approved the single repaired leaf; prior clean table leaves were not re-enumerated.",
    };
    const validatedReview = validateCoverageReview(
      approvedReview,
      repairedPlanFingerprint,
      manifest,
      undefined,
      repairedPlan,
      repairScope,
    );
    expect(validatedReview.ok, JSON.stringify(validatedReview.issues)).toBe(true);
    expect(validatedReview.review?.status).toBe("approved");

    const report = {
      schema_version: "gb50202-subagent-repair-convergence/v1",
      target: repairFixture.target,
      first_pass_direct_table_leaves: sourcePlan.acceptance_items.length,
      repaired_plan_leaf_count: repairedPlan.acceptance_items.length,
      first_pass_finding: {
        finding_id: repairFixture.finding_id,
        source_clause: repairFixture.source_clause,
        affected_existing_item_count: 0,
      },
      repair: {
        action: repairFixture.action,
        item_id: repairedItem.item_id,
        name: repairedItem.name,
        category: repairedItem.category,
        category_reason: repairFixture.item.category_reason,
        quantity: repairedItem.quantity,
      },
      second_pass: {
        scope_mode: repairScope.mode,
        required_leaf_count: obligations.required_item_ids.length,
        required_item_ids: obligations.required_item_ids,
        table_leaf_reenumeration_count: obligations.required_item_ids.filter((itemId) =>
          itemId.startsWith("subagent:7.2:row:")
        ).length,
        review_status: validatedReview.review?.status ?? "invalid",
      },
      convergence: {
        repair_rounds: 1,
        coverage_status_transition: "repair -> approved",
        full_repaired_leaf_count: repairedPlan.acceptance_items.length,
        second_pass_leaf_fraction: Number((obligations.required_item_ids.length / repairedPlan.acceptance_items.length).toFixed(4)),
        second_pass_leaf_reduction_percent: Number(
          (((repairedPlan.acceptance_items.length - obligations.required_item_ids.length)
            / repairedPlan.acceptance_items.length) * 100).toFixed(1),
        ),
      },
    };
    console.info(`GB50202_SUBAGENT_REPAIR_CONVERGENCE=${JSON.stringify(report)}`);

    expect(report.second_pass.table_leaf_reenumeration_count).toBe(0);
    expect(report.convergence.coverage_status_transition).toBe("repair -> approved");
    expect(report.convergence.second_pass_leaf_reduction_percent).toBeGreaterThan(95);
  }, 180_000);
});
