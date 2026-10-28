import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { coverageBlockerOwnerDecision } from "../src/coverage-blocker-routing.js";
import {
  validateCoverageReview,
  type CoverageReviewFinding,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import type { EvidenceManifest } from "../src/contracts.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
} from "../src/contracts.js";
import { prettyJson, sha256Text } from "../src/canonical.js";
import { CoverageReviewController } from "../src/coverage-review.js";
import { materialize } from "../src/materializer.js";
import { initialTargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

function finding(
  findingId: string,
  findingType: CoverageReviewFinding["finding_type"],
): CoverageReviewFinding {
  return {
    finding_id: findingId,
    finding_type: findingType,
    evidence_id: "atom:test",
    exact_fragment: "exact source",
    affected_item_ids: ["item:test"],
    description: "test finding",
    reason: "测试理由 fixture",
  };
}

describe("coverage blocker owner routing", () => {
  test("requires an explicit harness-only subset for a mixed cluster", () => {
    const review = {
      findings: [
        finding("finding:harness", "compiler_materialization_defect"),
        finding("finding:semantic", "semantic_coverage_gap"),
      ],
    };

    expect(coverageBlockerOwnerDecision(review)).toEqual(expect.objectContaining({
      allowed: false,
      error: "coverage_blocker_mixed_findings_require_explicit_ids",
      harness_finding_ids: ["finding:harness"],
      semantic_finding_ids: ["finding:semantic"],
    }));
    expect(coverageBlockerOwnerDecision(review, ["finding:semantic"])).toEqual(expect.objectContaining({
      allowed: false,
      error: "coverage_blocker_finding_owner_mismatch",
    }));
    expect(coverageBlockerOwnerDecision(review, ["finding:harness"])).toEqual(expect.objectContaining({
      allowed: true,
      selected_harness_finding_ids: ["finding:harness"],
      semantic_finding_ids: ["finding:semantic"],
    }));
  });

  test("tool refuses a harness blocker during the modeling phase of a durable semantic-only repair", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "coverage-blocker-owner-"));
    try {
      const text = "构件应符合要求。检验方法：观察。";
      const evidenceId = "atom:blocker-owner";
      const manifest: EvidenceManifest = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        job_id: "blocker-owner-job",
        target_id: "target:blocker-owner",
        source: {
          adapter: "document-domain-agent/v1",
          file_name: "source.md",
          sha256: sha256Text(text),
          semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
        },
        scope: {
          schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
          mode: "agent_discovered",
          target_id: "target:blocker-owner",
          source_line_count: 1,
          selected_start_line: 0,
          selected_end_exclusive_line: 1,
          selected_heading: "",
          selection_reason: "format-neutral fixture",
          selected_atom_ids: [evidenceId],
          target_evidence_fragments: [{ atom_id: evidenceId, text }],
          candidates: [],
        },
        evidence: [{
          evidence_id: evidenceId,
          kind: "paragraph",
          role: "supporting_clause",
          locator: `char:0-${text.length}`,
          text,
          text_sha256: sha256Text(text),
          requires_disposition: true,
          evidence_scope: "primary",
        }],
        table_fragments: [],
        reference_occurrences: [],
        evidence_fingerprint: sha256Text(`blocker-owner\0${text}`),
      };
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      const registry = await workspace.readSourceSpanRegistry();
      const fullSpanId = registry.spans[0]!.span_id;
      const selectors = initialTargetSelectorPlan(manifest);
      const sourceField = (composition: "verbatim" | "semantic_summary") => ({
        composition,
        span_ids: [fullSpanId],
        separator: "",
        reason: "夹具的精确绑定 fixture",
      });
      selectors.lots.push({
        key: "lot",
        name: "构件检验批",
        scope_span_ids: [fullSpanId],
        reason: "一个语义检验批 fixture",
      });
      selectors.items.push({
        key: "item",
        lot_key: "lot",
        name: "构件质量",
        category: "一般项目",
        criterion_span_ids: [fullSpanId],
        continuation_span_ids: [],
        fields: {
          name: sourceField("semantic_summary"),
          requirement: sourceField("verbatim"),
          method: { composition: "not_applicable", span_ids: [], separator: "", reason: "夹具只保留一个字段 fixture" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "无检查数量 fixture" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "复核夹具 fixture",
        inspection_data_type_span_ids: [fullSpanId],
        sampling: {
          status: "fallback",
          rule_key: "",
          branch_keys: [],
          quantity_span_ids: [],
          script_span_ids: [],
          condition_span_ids: [],
          reason: "无抽样 fixture",
          confidence: 1,
        },
        reason: "一条独立判定 fixture",
      });
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: evidenceId });
      expect(await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) }))
        .toMatchObject({ ok: true });
      const compiled = await controller.dispatch("compile_target_selectors", {});
      expect(compiled).toMatchObject({ ok: true, fingerprint: expect.any(String) });
      const selfReported = await controller.dispatch("report_target_blocker", {
        kind: "harness_contract_defect",
        evidence_span_ids: [fullSpanId],
        affected_selector_paths: ["/items/0/table/properties/acceptance_branches"],
        finding_ids: ["selector_acceptance_branches_required"],
        explanation: "调用方仅凭可选字段的参数形状自行推断 harness contract defect。",
      });
      expect(selfReported).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "coverage_blocker_owner_unverified",
        actionable: true,
        evidence_span_ids: [fullSpanId],
        affected_selector_paths: ["/items/0/table/properties/acceptance_branches"],
        submitted_finding_ids: ["selector_acceptance_branches_required"],
        durable_finding_ids: [],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items" },
        next_tools: expect.arrayContaining([
          "read_target_selectors",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
          "report_target_blocker",
        ]),
        required_tools: expect.arrayContaining([
          "read_target_selectors",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
        ]),
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringMatching(/affected_selector_paths.*可选字段.*durable coverage review/u),
        instruction: expect.stringMatching(/自报.*typed selector.*durable coverage finding/u),
      });
      expect(selfReported).not.toHaveProperty("writable_paths");
      const planFingerprint = String(compiled.fingerprint);
      const validation = validatePlanText(readFileSync(workspace.lastValidPlanPath, "utf8"), manifest);
      const finalItem = materialize(
        JSON.parse(readFileSync(workspace.lastValidPlanPath, "utf8")),
        manifest,
        planFingerprint,
      ).result.inspection_lots[0]!.items[0]!;
      const reviewer = await CoverageReviewController.create(workspace, planFingerprint);
      await reviewer.dispatch("open_review_evidence", { evidence_id: evidenceId });
      const staged = await reviewer.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "The final leaf requires a semantic selector repair.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item",
          disposition: "acceptance_item",
          judgment_id: "judgment:item",
          item_ids: [finalItem.item_id],
          evidence_bindings: [{ evidence_id: evidenceId, exact_fragment: text }],
          reason: "末级叶子绑定到完整原文。 fixture",
        }],
        finding_upserts: [finding("finding:semantic", "semantic_coverage_gap")].map((entry) => ({
          ...entry,
          evidence_id: evidenceId,
          exact_fragment: text,
          affected_item_ids: [finalItem.item_id],
        })),
      });
      expect(staged.validation).toMatchObject({ ok: true });
      expect(await reviewer.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
      expect(validation.ok).toBe(true);
      await controller.beginCoverageRepair(planFingerprint);
      await workspace.updateState((current) => {
        if (!current.repair) throw new Error("coverage repair state is missing");
        current.repair.mode = "modeling";
        current.selector_stage = "coverage_repair";
      });
      controller = await ToolController.create(workspace);

      const blockerInput = {
        kind: "harness_contract_defect",
        evidence_span_ids: [fullSpanId],
        affected_selector_paths: ["/items/0"],
        explanation: "The model claims a harness defect, but the durable owner route is semantic.",
      };
      expect(await controller.dispatch("report_target_blocker", blockerInput)).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "coverage_blocker_requires_semantic_repair",
        issue_owner: "semantic_coverage_gap",
        finding_ids: ["finding:semantic"],
        affected_selector_bindings: [expect.objectContaining({ selector_key: "item" })],
      });
      expect(await workspace.readState()).toMatchObject({
        status: "working",
        selector_protocol: { coverage_repairs: 0 },
      });

      await workspace.updateState((current) => {
        if (!current.repair) throw new Error("coverage repair state is missing");
        current.repair.coverage_finding_ids = [];
      });
      controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", blockerInput)).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "coverage_blocker_owner_unverified",
        active_finding_ids: [],
        unknown_active_finding_ids: [],
      });

      await workspace.updateState((current) => {
        if (!current.repair) throw new Error("coverage repair state is missing");
        current.repair.coverage_finding_ids = ["finding:stale"];
      });
      controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", blockerInput)).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "coverage_blocker_owner_unverified",
        active_finding_ids: ["finding:stale"],
        unknown_active_finding_ids: ["finding:stale"],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  const jobRoot = resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A1c656cff520ed53d1be02c14/revisions/000002",
  );
  const fingerprint = "7c58bf8b678057bfa2d36ee3cdf2e4ce393cefbf09c554efafd76ecd10e602fa";
  test.runIf(existsSync(resolve(jobRoot, "coverage-review", fingerprint, "coverage-review.json")))(
    "rejects the normalized 1c real replay as semantic-only",
    () => {
      const evidence = JSON.parse(readFileSync(
        resolve(jobRoot, "evidence/evidence.json"),
        "utf8",
      )) as EvidenceManifest;
      const planText = readFileSync(resolve(jobRoot, "last-valid.semantic-source-plan.json"), "utf8");
      const planValidation = validatePlanText(planText, evidence);
      expect(planValidation.ok).toBe(true);
      const rawReview = JSON.parse(readFileSync(
        resolve(jobRoot, "coverage-review", fingerprint, "coverage-review.json"),
        "utf8",
      )) as DomainCoverageReview;
      const normalized = validateCoverageReview(
        rawReview,
        fingerprint,
        evidence,
        undefined,
        planValidation.plan,
      );
      expect(normalized.ok).toBe(true);
      expect(normalized.review?.findings.every((entry) =>
        entry.finding_type === "semantic_coverage_gap"
      )).toBe(true);

      expect(coverageBlockerOwnerDecision(normalized.review!)).toEqual(expect.objectContaining({
        allowed: false,
        error: "coverage_blocker_requires_semantic_repair",
        harness_finding_ids: [],
        semantic_finding_ids: rawReview.findings.map((entry) => entry.finding_id).sort(),
      }));
    },
  );
});
