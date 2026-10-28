import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import type { EvidenceManifest, SemanticSourcePlan } from "../src/contracts.js";
import {
  CoverageReviewController,
  coverageReviewObligations,
  type SemanticCoverageDisposition,
} from "../src/coverage-review.js";
import { materialize } from "../src/materializer.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
  type DocumentTarget,
} from "../src/document-discovery.js";
import {
  canonicalizeSharedSamplingSourceFragments,
  normalizeOptionalSemanticSentinels,
  reconcileDerivedEvidenceDispositions,
} from "../src/repair-convergence.js";
import {
  compileSemanticDecisionsV8,
  type EvidenceSpanDecision,
  type SemanticDecisionPlan,
} from "../src/semantic-decision-compiler.js";
import { ToolController, validFixturePlan } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureMarkdown = resolve(packageRoot, "fixtures/stage1-like.md");

async function createWorkspace(label: string): Promise<{
  workspace: RevisionWorkspace;
  controller: ToolController;
}> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const workspace = await RevisionWorkspace.create(root, "repair-job", "4.1", fixtureMarkdown);
  return { workspace, controller: await ToolController.create(workspace) };
}

async function createDocumentWorkspace(label: string): Promise<{
  workspace: RevisionWorkspace;
  controller: ToolController;
}> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const markdown = await readFile(fixtureMarkdown, "utf8");
  const evidence = buildDocumentEvidence(markdown, "stage1-like.md");
  const target: DocumentTarget = {
    target_id: "4.1",
    group_id: "fixture-group",
    group_name: "Fixture group",
    group_reason: "The fixture is one bounded regression scope.",
    name: "Fixture target",
    description: "Fixture target for coverage-repair lifecycle regression.",
    evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
    evidence_fragments: evidence.atoms.map((atom) => ({
      atom_id: atom.atom_id,
      text: atom.text,
    })),
    materialization: {
      kind: "inspection_scope",
      lot_basis_summary: "Fixture inspection scope",
      lot_basis_fragments: evidence.atoms.slice(0, 1).map((atom) => ({
        atom_id: atom.atom_id,
        text: atom.text,
      })),
      reason: "The fixture is materialized as one inspection scope.",
    },
    reason: "Exercise the document-domain-agent coverage gate.",
  };
  const prepared = await buildAgentScopedEvidenceManifest(
    fixtureMarkdown,
    "repair-job",
    target,
    evidence,
  );
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    "repair-job",
    target.target_id,
    prepared,
  );
  return { workspace, controller: await ToolController.create(workspace) };
}

async function createCompactV8Workspace(label: string): Promise<{
  workspace: RevisionWorkspace;
  controller: ToolController;
  compact: ReturnType<typeof compileSemanticDecisionsV8>;
}> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const text = "连接件外观应完整。检查方法：观察。";
  const evidenceId = "atom:compact-repair";
  const span = (value: string): EvidenceSpanDecision => {
    const start = text.indexOf(value);
    return { evidence_id: evidenceId, start, end: start + value.length };
  };
  const evidence = [{
    evidence_id: evidenceId,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: "p1",
    text,
    text_sha256: sha256Text(text),
    requires_disposition: true,
  }];
  const manifestPayload = {
    schema_version: "evidence-manifest/v6" as const,
    job_id: "repair-job-v8",
    target_id: "target:repair-v8",
    source: {
      adapter: "markdown-target-scope/v3" as const,
      file_name: "compact-repair.md",
      sha256: sha256Text(text),
    },
    scope: {
      schema_version: "markdown-target-scope/v1" as const,
      mode: "target_section" as const,
      target_id: "target:repair-v8",
      source_line_count: 1,
      selected_start_line: 0,
      selected_end_exclusive_line: 1,
      selected_heading: "",
      selection_reason: "compact repair fixture",
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
  };
  const manifest: EvidenceManifest = {
    ...manifestPayload,
    evidence_fingerprint: sha256Json(manifestPayload),
  };
  const full = { evidence_id: evidenceId, start: 0, end: text.length };
  const notApplicable = {
    value: "",
    composition: "not_applicable" as const,
    spans: [],
    reason: "原文无此字段",
  };
  const decisions: SemanticDecisionPlan = {
    schema_version: "semantic-decision-plan/v1",
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: { tables: [], fragment_dispositions: [] },
    lots: [{ key: "lot", name: "连接件", evidence_spans: [full], reason: "fixture" }],
    items: [{
      key: "item",
      lot_key: "lot",
      category: "一般项目",
      fields: {
        name: { value: "连接件外观", composition: "verbatim", spans: [span("连接件外观")], reason: "fixture" },
        requirement: { value: "连接件外观应完整", composition: "verbatim", spans: [span("连接件外观应完整")], reason: "fixture" },
        method: { value: "观察", composition: "verbatim", spans: [span("观察")], reason: "fixture" },
        quantity: notApplicable,
        note: notApplicable,
      },
      primary_spans: [full],
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "fixture",
      inspection_data_type_spans: [span("连接件外观应完整"), span("观察")],
      sampling: {
        status: "fallback",
        min_sampling: "",
        script: "fallback",
        reason: "fixture",
        confidence: 1,
        evidence_spans: [],
        rule_keys: [],
        branch_keys: [],
      },
    }],
    semantic_nodes: [],
    references: [],
    sampling_rules: [],
    occurrence_resolutions: [],
    evidence_dispositions: [{ evidence_id: evidenceId, disposition: "context", reason: "fixture" }],
  };
  const compact = compileSemanticDecisionsV8(decisions, manifest);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(text) },
  );
  return { workspace, controller: await ToolController.create(workspace), compact };
}

describe("repair-only convergence", () => {
  test("canonicalizes one unique cross-page shared sampling source to exact bytes", () => {
    const evidenceText = [
      "3.0.21 检验应符合下列规定:",
      "1 按每层划分检验批  ",
      "<!-- pages_021_030 -->",
      "2 每批随机检验不应少于3间;不足3间全数检查。",
    ].join("\r\n\r\n");
    const manifest = {
      evidence: [{ evidence_id: "atom:sampling", text: evidenceText }],
    } as unknown as ToolController["evidence"];
    const requested = "3.0.21 检验应符合下列规定:\n1 按每层划分检验批\n2 每批随机检验不应少于3间；不足3间全数检查。";
    const exactEvidenceRange = evidenceText.slice(0, -1);
    const plan = {
      shared_sampling_rules: [{
        rule_id: "rule:3.0.21",
        evidence_ids: ["atom:sampling"],
        complete_source_fragment: requested,
      }],
    };

    const canonicalized = canonicalizeSharedSamplingSourceFragments(plan, manifest);
    expect(canonicalized.changes).toEqual([expect.objectContaining({
      rule_id: "rule:3.0.21",
      before: requested,
      after: exactEvidenceRange,
    })]);
    expect((canonicalized.plan as typeof plan).shared_sampling_rules[0]!.complete_source_fragment)
      .toBe(exactEvidenceRange);
  });

  test("normalizes only nullable semantic ID sentinels without inventing required meaning", () => {
    const input = {
      semantic_evidence: [
        {
          semantic_id: "reference-context",
          role: "referenced_clause",
          parent_semantic_id: null,
          materialized_item_id: null,
        },
        {
          semantic_id: "required-item",
          role: "acceptance_item",
          parent_semantic_id: null,
          materialized_item_id: null,
        },
      ],
    };
    const normalized = normalizeOptionalSemanticSentinels(input);
    expect(normalized.changed_semantic_ids).toEqual(["reference-context", "required-item"]);
    expect(normalized.plan).toMatchObject({
      semantic_evidence: [
        { parent_semantic_id: "", materialized_item_id: "" },
        { parent_semantic_id: "", materialized_item_id: "" },
      ],
    });
    expect((normalized.plan as typeof input).semantic_evidence[1]!.role)
      .toBe("acceptance_item");
  });

  test("rejects semantic_summary for every lossless field at the tool boundary", async () => {
    const { controller } = await createWorkspace("summary-boundary");
    const evidence = controller.evidence.evidence.find((row) => row.text.length >= 4)!;
    await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
    const exact = evidence.text.slice(0, 4);
    const empty = {
      value: "",
      composition: "not_applicable",
      source_fragments: [],
      reason: "原文无此字段",
    };
    const result = await controller.dispatch("prepare_field_bindings", {
      fields: {
        name: {
          value: "检查点",
          composition: "semantic_summary",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: exact }],
          reason: "名称可以概括",
        },
        requirement: {
          value: "错误概括",
          composition: "semantic_summary",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: exact }],
          reason: "要求不得概括",
        },
        method: empty,
        quantity: empty,
        note: empty,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: "semantic_summary_name_only",
      field: "requirement",
    });
  });

  test("refreshes cited used receivers but preserves unrelated context judgment", async () => {
    const { controller } = await createWorkspace("derived-dispositions");
    const plan = validFixturePlan(controller.evidence);
    const item = plan.acceptance_items[0]!;
    const cited = item.evidence_ids[0]!;
    const unrelated = "evidence:unrelated-business-context";
    plan.evidence_dispositions = [
      {
        evidence_id: cited,
        disposition: "context",
        item_ids: [],
        reason: "过期判断",
      },
      {
        evidence_id: unrelated,
        disposition: "context",
        item_ids: [],
        reason: "Agent 判断为背景，不得由机械规则改写",
      },
    ];
    const result = reconcileDerivedEvidenceDispositions(plan, controller.evidence);
    expect(result.plan.evidence_dispositions.find((row) => row.evidence_id === cited))
      .toMatchObject({ disposition: "used", item_ids: [item.item_id] });
    expect(result.plan.evidence_dispositions.find((row) => row.evidence_id === unrelated))
      .toEqual(plan.evidence_dispositions[1]);
  });

  test("forbids expansion and bounds two durable non-converging repair rounds", async () => {
    const { workspace, controller } = await createWorkspace("repair-state-machine");
    const valid = validFixturePlan(controller.evidence);
    const invalid = structuredClone(valid);
    invalid.acceptance_items[0]!.name = "字段绑定哈希故意失配";
    await controller.dispatch("replace_working_plan", { content: prettyJson(invalid) });
    const first = await controller.dispatch("validate_working_plan", {});
    expect(first).toMatchObject({
      ok: false,
      repair: {
        mode: "repair",
        active_cluster: { item_ids: [valid.acceptance_items[0]!.item_id] },
      },
    });
    expect(await controller.dispatch("reconcile_evidence_dispositions", {
      decisions: [],
    })).toMatchObject({
      ok: false,
      error: "repair_only_requires_coherent_patch",
    });

    const expansion = await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "add",
        path: "/acceptance_items/-",
        value: { item_id: "new-item-forbidden" },
      }],
    });
    expect(expansion).toMatchObject({
      ok: false,
      error: "repair_only_item_expansion_forbidden",
    });

    expect(await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "replace",
        path: "/acceptance_items/0/name",
        value: "仍然失配的第二个名称",
      }],
    })).toMatchObject({
      ok: true,
      repair_validation: {
        ok: false,
        issue_delta: 0,
        repair: { non_converging_rounds: 1, fresh_session_required: false },
      },
    });
    expect(await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "replace",
        path: "/acceptance_items/0/name",
        value: "仍然失配的第三个名称",
      }],
    })).toMatchObject({
      ok: true,
      fresh_repair_session_required: true,
      repair_validation: {
        ok: false,
        repair: { non_converging_rounds: 2, fresh_session_required: true },
      },
    });

    await controller.beginFreshRepairSession();
    const repaired = await controller.dispatch("patch_working_plan", {
      operations: [
        {
          op: "replace",
          path: "/acceptance_items/0/name",
          value: valid.acceptance_items[0]!.name,
        },
        {
          op: "replace",
          path: "/acceptance_items/0/sampling/reason",
          value: `${valid.acceptance_items[0]!.sampling.reason}（同一事务复核）`,
        },
        {
          op: "replace",
          path: "/acceptance_items/0/field_bindings/name",
          value: valid.acceptance_items[0]!.field_bindings.name,
        },
        {
          op: "replace",
          path: "/reference_resolutions",
          value: valid.reference_resolutions,
        },
        {
          op: "replace",
          path: "/acceptance_items/0/table_semantics",
          value: valid.acceptance_items[0]!.table_semantics,
        },
      ],
    });
    expect(repaired).toMatchObject({
      ok: true,
      changed_item_ids: [valid.acceptance_items[0]!.item_id],
      durable_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      repair_validation: { ok: true, issues: [] },
      remaining_cluster: null,
    });
    const persisted = JSON.parse(await readFile(workspace.workingPlanPath, "utf8")) as SemanticSourcePlan;
    expect(persisted.acceptance_items[0]!.sampling.reason).toContain("同一事务复核");
    expect((await controller.repairStatus()).mode).toBe("validated");
  });

  test("starts a fresh repair epoch without discarding the active durable cluster", async () => {
    const { controller } = await createWorkspace("fresh-repair-epoch");
    const valid = validFixturePlan(controller.evidence);
    const invalid = structuredClone(valid);
    invalid.acceptance_items[0]!.name = "失配";
    await controller.dispatch("replace_working_plan", { content: prettyJson(invalid) });
    await controller.dispatch("validate_working_plan", {});
    const before = await controller.repairStatus();
    const after = await controller.beginFreshRepairSession();
    expect(after.session_epoch).toBe(before.session_epoch + 1);
    expect(after.active_cluster).toEqual(before.active_cluster);
    expect(after.fresh_session_required).toBe(false);
  });

  test("turns a sealed coverage finding into bounded repair and requires a fresh review", async () => {
    const { workspace, controller } = await createDocumentWorkspace("coverage-repair-transition");
    const valid = validFixturePlan(controller.evidence);
    await controller.dispatch("replace_working_plan", { content: prettyJson(valid) });
    for (const record of controller.evidence.evidence) {
      await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
    }
    const candidateValidation = await controller.dispatch("validate_working_plan", {});
    expect(candidateValidation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    const candidateFingerprint = String(candidateValidation.fingerprint);

    const reviewController = await CoverageReviewController.create(
      workspace,
      candidateFingerprint,
    );
    for (const record of controller.evidence.evidence) {
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: record.evidence_id,
      });
    }
    const findingEvidence = controller.evidence.evidence[0]!;
    const finalItems = materialize(valid, controller.evidence, candidateFingerprint).result.inspection_lots.flatMap((lot) => lot.items);
    const semanticCoverage: SemanticCoverageDisposition[] = finalItems.map((item, index) => {
      const source = valid.acceptance_items.find((candidate) =>
        candidate.item_id === item.reference_origin_item_id || candidate.item_id === item.item_id
      )!;
      const bindings = Object.values(source.field_bindings).flatMap((binding) => binding.source_fragments)
        .map((fragment) => ({ evidence_id: fragment.evidence_id, exact_fragment: fragment.text }))
        .filter((binding, bindingIndex, rows) => rows.findIndex((candidate) =>
          candidate.evidence_id === binding.evidence_id && candidate.exact_fragment === binding.exact_fragment
        ) === bindingIndex);
      return {
        coverage_id: `coverage:leaf:${index + 1}`,
        disposition: "acceptance_item" as const,
        judgment_id: `judgment:${item.item_id}`,
        item_ids: [item.item_id],
        evidence_bindings: bindings,
        reason: "The repair review binds this final leaf to its exact field provenance.",
      };
    });
    for (const evidenceId of coverageReviewObligations(controller.evidence, valid).uncovered_primary_evidence_ids) {
      const record = controller.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId)!;
      semanticCoverage.push({
        coverage_id: `coverage:primary:${evidenceId}`,
        disposition: "irrelevant",
        judgment_id: "",
        item_ids: [],
        evidence_bindings: [{ evidence_id: evidenceId, exact_fragment: record.text }],
        reason: "Uncovered primary context receives an explicit disposition.",
      });
    }
    const stagedReview = await reviewController.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "Repair the missing branch before sealing.",
        semantic_coverage_upserts: semanticCoverage,
        finding_upserts: [{
          finding_id: "finding:missing-branch",
          finding_type: "semantic_coverage_gap",
          evidence_id: findingEvidence.evidence_id,
          exact_fragment: findingEvidence.text,
          affected_item_ids: [finalItems[0]!.item_id],
          description: "One independently executable branch is absent.",
          reason: "The candidate needs a bounded semantic repair.",
        }],
    });
    const reviewValidation = stagedReview.validation as Record<string, unknown>;
    expect(reviewValidation).toMatchObject({ ok: true, fingerprint: expect.any(String) });
    expect(await reviewController.finalizeMechanicallyReady())
      .toMatchObject({ ok: true, status: "repair" });

    // A stale materializer seal is archived before the same durable typed review
    // is finalized again. Its old immutable checkpoint must not block Windows rename.
    await rename(reviewController.sealedPath, `${reviewController.sealedPath}.stale-test`);
    await rename(
      reviewController.materializedFingerprintPath,
      `${reviewController.materializedFingerprintPath}.stale-test`,
    );
    expect(await reviewController.finalizeMechanicallyReady())
      .toMatchObject({ ok: true, status: "repair" });

    const repair = await controller.beginCoverageRepair(candidateFingerprint);
    expect(repair).toMatchObject({
      mode: "repair",
      repair_source: "coverage",
      coverage_review_fingerprint: candidateFingerprint,
      coverage_finding_ids: ["finding:missing-branch"],
    });
    expect(await workspace.readState()).toMatchObject({
      last_valid_fingerprint: "",
      last_valid_plan_sha256: "",
    });
    expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({
      ok: true,
      review: { status: "repair", plan_fingerprint: candidateFingerprint },
    });

    const expansion = await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "add",
        path: "/acceptance_items/-",
        value: { item_id: "coverage-added-item" },
      }],
    });
    expect(expansion).toMatchObject({
      ok: true,
      repair_validation: { ok: false },
    });
    expect(expansion).not.toHaveProperty("error", "repair_only_item_expansion_forbidden");
    const expansionHistory = JSON.parse(await readFile(
      resolve(
        workspace.historyDirectory,
        `${String(expansion.history_sequence).padStart(6, "0")}.json`,
      ),
      "utf8",
    )) as { repair_finding_ids: string[] };
    expect(expansionHistory.repair_finding_ids).toEqual(["finding:missing-branch"]);
    expect(await controller.repairStatus()).toMatchObject({
      mode: "repair",
      repair_source: "coverage",
      coverage_finding_ids: ["finding:missing-branch"],
    });

    const addedItemId = "coverage-added-item";
    const addedItem = {
      ...structuredClone(valid.acceptance_items[0]!),
      item_id: addedItemId,
    };
    const addedSemanticNode = {
      ...structuredClone(valid.semantic_evidence![0]!),
      semantic_id: "semantic:coverage-added-item",
      materialized_item_id: addedItemId,
      parent_semantic_id: "",
    };
    const repaired = await controller.dispatch("patch_working_plan", {
      operations: [
        {
          op: "replace",
          path: `/acceptance_items/${valid.acceptance_items.length}`,
          value: addedItem,
        },
        { op: "add", path: "/inspection_lots/0/item_ids/-", value: addedItemId },
        { op: "add", path: "/semantic_evidence/-", value: addedSemanticNode },
        {
          op: "replace",
          path: "/evidence_dispositions",
          value: valid.evidence_dispositions.map((row) => ({
            ...row,
            item_ids: [...new Set([...row.item_ids, addedItemId])],
          })),
        },
      ],
    });
    expect(repaired).toMatchObject({
      ok: true,
      repair_validation: { ok: true, fingerprint: expect.any(String) },
      remaining_cluster: null,
    });
    const repairedFingerprint = String(
      (repaired.repair_validation as { fingerprint: string }).fingerprint,
    );
    expect(repairedFingerprint).not.toBe(candidateFingerprint);
    expect(await workspace.readState()).toMatchObject({
      coverage_recheck: {
        schema_version: "coverage-recheck-scope/v1",
        plan_fingerprint: repairedFingerprint,
        source_plan_fingerprint: candidateFingerprint,
        finding_ids: ["finding:missing-branch"],
        affected_item_ids: expect.arrayContaining([finalItems[0]!.item_id, addedItemId]),
        affected_evidence_ids: expect.arrayContaining([findingEvidence.evidence_id]),
      },
    });
    const deltaReviewController = await CoverageReviewController.create(workspace, repairedFingerprint);
    expect(await deltaReviewController.dispatch("get_coverage_review_contract", {})).toMatchObject({
      ok: true,
      review_scope: {
        mode: "repair_delta",
        finding_ids: ["finding:missing-branch"],
      },
      coverage_obligations: {
        mode: "repair_delta",
        required_item_ids: expect.arrayContaining([finalItems[0]!.item_id, addedItemId]),
      },
    });
    expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({
      ok: false,
      error: "domain_coverage_review_required",
      plan_fingerprint: repairedFingerprint,
    });
    expect(await controller.dispatch("seal_validated_plan", {
      fingerprint: repairedFingerprint,
    })).toMatchObject({
      ok: false,
      error: "domain_coverage_review_required",
      current_fingerprint: repairedFingerprint,
    });
  });

  test("migrates a legacy failed validation receipt into repair-only state", async () => {
    const { workspace, controller } = await createWorkspace("legacy-repair-state");
    const invalid = validFixturePlan(controller.evidence);
    invalid.acceptance_items[0]!.name = "旧现场字段失配";
    await controller.dispatch("replace_working_plan", { content: prettyJson(invalid) });
    const validation = await controller.dispatch("validate_working_plan", {});
    expect(validation.ok).toBe(false);
    await workspace.updateState((state) => {
      delete state.repair;
    });

    const reopened = await ToolController.create(workspace);
    expect(await reopened.repairStatus()).toMatchObject({
      mode: "repair",
      total_issue_count: (validation.issues as unknown[]).length,
      active_cluster: { item_ids: [invalid.acceptance_items[0]!.item_id] },
    });
  });

  test("recovers a compact v8 working plan from a legacy failed receipt without rewriting it", async () => {
    const { workspace, controller, compact } = await createCompactV8Workspace("legacy-v8-repair-state");
    const invalid = structuredClone(compact);
    invalid.acceptance_items[0]!.name = "旧现场字段失配";
    await controller.dispatch("open_evidence", { evidence_id: controller.evidence.evidence[0]!.evidence_id });
    expect(await controller.dispatch("replace_working_plan", { content: prettyJson(invalid) }))
      .toMatchObject({ ok: true });
    const validation = await controller.dispatch("validate_working_plan", {});
    expect(validation).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("/acceptance_items/0") }),
      ]),
    });

    const legacyReceipt = JSON.parse(
      await readFile(workspace.validationReceiptPath, "utf8"),
    ) as Record<string, unknown>;
    legacyReceipt.validator = "semantic-source-plan-validator/v4";
    await writeFile(workspace.validationReceiptPath, prettyJson(legacyReceipt), "utf8");
    await workspace.updateState((state) => {
      delete state.repair;
    });
    const beforeReopen = await readFile(workspace.workingPlanPath, "utf8");

    const reopened = await ToolController.create(workspace);
    expect(await reopened.repairStatus()).toMatchObject({
      mode: "repair",
      total_issue_count: (validation.issues as unknown[]).length,
      active_cluster: { item_ids: [invalid.acceptance_items[0]!.item_id] },
    });
    const afterReopen = await readFile(workspace.workingPlanPath, "utf8");
    expect(afterReopen).toBe(beforeReopen);
    expect(JSON.parse(afterReopen)).toMatchObject({
      schema_version: "semantic-source-plan/v8",
      source_spans: expect.any(Array),
    });
    expect(afterReopen).not.toContain("source_fragments");
  });
});
