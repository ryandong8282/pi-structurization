import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import {
  CoverageReviewController,
  readSealedCoverageReview,
  type CoverageReviewScope,
} from "../src/coverage-review.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

function manifestAndPlan(): { evidence: EvidenceManifest; plan: SemanticSourcePlan } {
  const text = "4.4.5 高强度螺栓外观不得有裂纹或损伤。检查数量：全数检查。";
  const evidenceId = "atom:gap";
  const evidence: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "ledger-gap-handoff",
    target_id: "target:ledger-gap-handoff",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "gap.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:ledger-gap-handoff",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "标准紧固件",
      selection_reason: "ledger gap handoff fixture",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: "line:1",
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text("ledger-gap-handoff"),
  };
  const itemId = "item:gap-incomplete";
  const fields = {
    name: "高强度螺栓",
    requirement: "4.4.5 高强度螺栓外观不得有裂纹或损伤。",
    method: "观察检查",
    quantity: "全数检查",
    note: "",
  };
  const plan: SemanticSourcePlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: evidence.job_id,
    target_id: evidence.target_id,
    evidence_fingerprint: evidence.evidence_fingerprint,
    table_assembly: {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: [{
      lot_id: "lot:1",
      name: "标准紧固件",
      evidence_ids: [evidenceId],
      item_ids: [itemId],
    }],
    acceptance_items: [{
      item_id: itemId,
      lot_id: "lot:1",
      ...fields,
      category: "主控项目",
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "fixture",
      inspection_data_type_evidence_ids: [evidenceId],
      evidence_ids: [evidenceId],
      reference_evidence_ids: [],
      field_bindings: buildItemFieldBindings(fields, [evidenceId], evidence),
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "本项没有抽样含义。",
        reason: "fixture",
        confidence: 1,
        evidence_ids: [],
      },
    }],
    reference_resolutions: [],
    evidence_dispositions: [{
      evidence_id: evidenceId,
      disposition: "used",
      item_ids: [itemId],
      reason: "fixture",
    }],
    semantic_evidence: [{
      semantic_id: "semantic:1",
      role: "acceptance_item",
      evidence_id: evidenceId,
      exact_fragment: fields.requirement,
      parent_semantic_id: "",
      materialized_item_id: itemId,
      reason: "fixture",
    }],
    semantic_references: [],
    shared_sampling_rules: [],
  };
  return { evidence, plan };
}

describe("ledger_gap coverage seal handoff", () => {
  test("persists review scope so a repair seal remains readable without re-running full validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ledger-gap-handoff-"));
    try {
      const { evidence, plan } = manifestAndPlan();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        evidence.job_id,
        evidence.target_id,
        { manifest: evidence, markdown: Buffer.from(evidence.evidence[0]!.text, "utf8") },
      );
      await writeFile(workspace.lastValidPlanPath, JSON.stringify(plan), "utf8");
      const validated = validatePlanText(JSON.stringify(plan), evidence);
      expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
      const revisionState = await workspace.readState();
      revisionState.last_valid_fingerprint = validated.fingerprint!;
      revisionState.last_valid_plan_sha256 = validated.plan_sha256!;
      revisionState.opened_evidence_ids = evidence.evidence.map((record) => record.evidence_id);
      await workspace.writeState(revisionState);
      const planFingerprint = validated.fingerprint!;

      const gapScope: CoverageReviewScope = {
        mode: "ledger_gap",
        affected_item_ids: [plan.acceptance_items[0]!.item_id],
        affected_evidence_ids: [evidence.evidence[0]!.evidence_id],
        finding_ids: [],
        gap_clause_ids: ["4.4.5"],
      };
      const reviewController = await CoverageReviewController.create(
        workspace,
        planFingerprint,
        gapScope,
      );
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: evidence.evidence[0]!.evidence_id,
      });
      const staged = await reviewController.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "Clause 4.4.5 is incomplete in the candidate.",
        finding_upserts: [{
          finding_id: "finding:gap-4.4.5",
          finding_type: "semantic_coverage_gap",
          evidence_id: evidence.evidence[0]!.evidence_id,
          exact_fragment: "不得有裂纹或损伤",
          affected_item_ids: [plan.acceptance_items[0]!.item_id],
          description: "Missing prohibition against cracks.",
          reason: "ledger gap fixture",
        }],
        semantic_coverage_upserts: [{
          coverage_id: "cov:item:gap-incomplete",
          disposition: "acceptance_item",
          judgment_id: plan.acceptance_items[0]!.item_id,
          item_ids: [plan.acceptance_items[0]!.item_id],
          evidence_bindings: [{
            evidence_id: evidence.evidence[0]!.evidence_id,
            exact_fragment: "4.4.5 高强度螺栓外观不得有裂纹或损伤。",
          }],
          reason: "scoped leaf under ledger_gap",
        }],
      });
      expect(staged.ok, JSON.stringify(staged)).toBe(true);

      const sealed = await reviewController.finalizeMechanicallyReady();
      expect(sealed.ok, JSON.stringify(sealed)).toBe(true);
      expect(sealed.status).toBe("repair");

      const scopePath = join(reviewController.root, "review-scope.json");
      expect(JSON.parse(await readFile(scopePath, "utf8"))).toMatchObject({
        mode: "ledger_gap",
        gap_clause_ids: ["4.4.5"],
      });

      const readable = await readSealedCoverageReview(
        workspace,
        planFingerprint,
        evidence,
      );
      expect(readable?.status).toBe("repair");
      expect(readable?.findings).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
