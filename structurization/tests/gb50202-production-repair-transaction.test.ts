import { mkdtemp, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { prettyJson } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import {
  CoverageReviewController,
  coverageReviewObligations,
  type CoverageReviewScope,
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
import {
  coverageReviewScopeForRun,
  targetOwnScopeForTarget,
} from "../src/batch.js";
import {
  initialTargetSelectorPlan,
  targetSelectorFingerprint,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { registryWithFullSourceSpans, renderedTableCellSpans } from "../src/source-span-registry.js";
import { initialTableStructurePlan } from "../src/table-structure.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "fixtures/real/GB_50202-2018.md");

function clauseEvidence(manifest: EvidenceManifest, clauseId: string) {
  const escaped = clauseId.replaceAll(".", "\\.");
  const prefix = new RegExp(`^${escaped}\\s`, "u");
  const record = manifest.evidence.find((candidate) =>
    candidate.evidence_scope === "primary"
    && (candidate.clause_id === clauseId || prefix.test(candidate.text))
  );
  if (!record) throw new Error(`Missing primary evidence for ${clauseId}`);
  return record;
}

function fullSpanFor(
  registry: Awaited<ReturnType<RevisionWorkspace["readSourceSpanRegistry"]>>,
  evidenceId: string,
  textLength: number,
): string {
  const span = registry.spans.find((candidate) =>
    candidate.evidence_id === evidenceId
    && candidate.start === 0
    && candidate.end === textLength
  );
  if (!span) throw new Error(`Missing full span for ${evidenceId}`);
  return span.span_id;
}

function rowName(text: string, index: number): string {
  const match = /检查项目=([^|]+)/u.exec(text);
  return match?.[1]?.trim() || `表格验收项 ${index + 1}`;
}

function seedSelectors(
  manifest: EvidenceManifest,
  registry: Awaited<ReturnType<RevisionWorkspace["readSourceSpanRegistry"]>>,
  formalRows: EvidenceManifest["evidence"],
): TargetSelectorPlan {
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "lot:7.2",
    name: "排桩质量检验",
    scope_span_ids: [],
    reason: "真实 7.2 范围内的表格验收项基线。",
  });
  selectors.items = formalRows.map((record, index) => {
    const span = fullSpanFor(registry, record.evidence_id, record.text.length);
    // This lifecycle fixture must obey the same cell-boundary contract as live
    // authors. These test-only header selections are not extraction rules.
    const cells = renderedTableCellSpans(record);
    const cellIds = (label: string) => cells.filter(cell => cell.label.includes(label)).map(cell => {
      const registered = registry.spans.find(candidate => candidate.evidence_id === record.evidence_id
        && candidate.start === cell.start && candidate.end === cell.end);
      if (!registered) throw new Error(`Missing opened cell span for ${record.evidence_id}`);
      return registered.span_id;
    });
    const names = cellIds("检查项目");
    const values = cellIds("允许");
    const methods = cellIds("检查方法");
    expect(names.length).toBeGreaterThan(0);
    expect(values.length).toBeGreaterThan(0);
    const fragment = manifest.table_fragments.find((candidate) =>
      candidate.fragment_id === record.table_fragment_id
      || candidate.formal_row_evidence_ids.includes(record.evidence_id)
    );
    const titleEvidence = fragment?.title_candidate_evidence_ids
      .map((evidenceId) => manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId))
      .find((candidate) => candidate !== undefined);
    const titleSpan = titleEvidence
      ? fullSpanFor(registry, titleEvidence.evidence_id, titleEvidence.text.length)
      : "";
    const name = rowName(record.text, index);
    const category = record.text.includes("项=主控项目") ? "主控项目" as const : "一般项目" as const;
    return {
      key: `row:${String(index + 1).padStart(2, "0")}`,
      lot_key: "lot:7.2",
      name,
      category,
      criterion_span_ids: [span],
      continuation_span_ids: [],
      fields: {
        name: {
          composition: "semantic_summary" as const,
          span_ids: [span],
          separator: "" as const,
          reason: "项目名概括自该正式表格数据行。",
        },
        requirement: {
          composition: "verbatim" as const,
          span_ids: values,
          separator: " " as const,
          reason: "事务基线按精确单元格绑定允许值，完整行另保留为判据来源。",
        },
        method: {
          composition: methods.length ? "verbatim" as const : "not_applicable" as const,
          span_ids: methods,
          separator: " " as const,
          reason: "事务基线保留原表方法单元格。",
        },
        quantity: {
          composition: "not_applicable" as const,
          span_ids: [],
          separator: "" as const,
          reason: "本事务测试不重新建模表内数量字段。",
        },
        note: {
          composition: "not_applicable" as const,
          span_ids: [],
          separator: "" as const,
          reason: "本事务测试不重新建模备注字段。",
        },
      },
      table: {
        source_kind: "direct" as const,
        table_key: record.table_id || `table:${index + 1}`,
        properties: {
          table_no_span_ids: [],
          table_title_span_ids: titleSpan ? [titleSpan] : [],
          applicability_span_ids: [],
          row_path_span_ids: [names],
          column_path_span_ids: [],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: values,
          inspection_method_span_ids: methods,
        },
        reference_span_ids: [],
        reason: "正式表格数据行的事务基线；角色分别绑定已打开的精确单元格。",
      },
      inspection_data_type: "review" as const,
      inspection_data_type_reason: "事务回放只验证 coverage repair 生命周期，不把表格测量类型重新当成模型结论。",
      inspection_data_type_span_ids: [span],
      sampling: {
        status: "fallback" as const,
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "基线表格项的外部抽样语义留给 Coverage 风险审查。",
        confidence: 1,
      },
      reason: "真实 formal table row 的事务基线；repair 前保持不变。",
    };
  });
  selectors.residual_source_dispositions = [{
    key: "remaining-primary",
    disposition: "context",
    reason: "未绑定到 59 个表格基线项的正文仍保留为上下文，Coverage 独立判断是否构成缺口。",
  }];
  return selectors;
}

describe("GB50202 production coverage-repair transaction with external subagent", () => {
  test("runs beginCoverageRepair -> selector patch -> commit -> repair_delta review -> seal on real 7.2 evidence", async () => {
    const markdown = await readFile(fixturePath, "utf8");
    const document = buildDocumentEvidence(markdown, basename(fixturePath));
    const ledger = scanDocumentLedger(markdown, basename(fixturePath));
    const discoveryRegistry = registryWithFullSourceSpans(
      document.evidence_fingerprint,
      document.atoms.map((atom) => ({
        source_id: atom.atom_id,
        evidence_id: atom.atom_id,
        atom_id: atom.atom_id,
        text: atom.text,
      })),
    );
    const jobId = "subagent-production-repair-gb50202";
    const prefilled = prefillDocumentSelectorsFromLedger(
      jobId,
      document.atoms,
      ledger,
      discoveryRegistry,
    );
    const targets = compileDocumentSelectors(
      approveScopeFixture(prefilled.selectors, prefilled.registry, document),
      prefilled.registry,
      document,
      jobId,
    );
    const target = targets.targets.find((candidate) => candidate.name === "排桩");
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

    const root = await mkdtemp(join(tmpdir(), "gb50202-production-repair-"));
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      {
        manifest,
        markdown: Buffer.from(markdown, "utf8"),
      },
    );
    const registry = await workspace.readSourceSpanRegistry();
    const controller = await ToolController.create(workspace);

    // 固定表格事务夹具显式确认结构；生产预填仍保持 review，不自动批准。
    for (const table of initialTableStructurePlan(manifest, registry).tables) {
      const rows = manifest.evidence.filter(record => table.fragment_ids.includes(record.table_fragment_id ?? "") && record.kind === "table_row");
      const headers = rows.filter(record => record.table_row_kind === "header").map(record => record.evidence_id);
      table.header_rows = headers.slice(0, 1);
      table.repeated_header_rows = headers.slice(1);
      table.data_rows = rows.filter(record => record.table_row_kind === "data").map(record => record.evidence_id);
      table.review_rows = [];
      table.status = "confirmed";
      table.reason = "本事务夹具固定确认 7.2 正式检验表的表头、数据行及续表；不在这里测试模型结构识别。";
      const staged = await controller.dispatch("stage_table_structure", { table });
      expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, validation: { ok: true } });
    }

    // Seed/validate the pre-repair candidate using the real selector compiler.
    const seedEvidenceIds = [...new Set([
      ...formalRows.map((record) => record.evidence_id),
      ...manifest.table_fragments.flatMap((fragment) => fragment.title_candidate_evidence_ids),
      ...manifest.table_fragments.flatMap((fragment) => fragment.header_evidence_ids),
    ])];
    for (const evidenceId of seedEvidenceIds) {
      expect(await controller.dispatch("open_evidence", {
        evidence_id: evidenceId,
      })).toMatchObject({ ok: true });
    }
    const selectors = seedSelectors(manifest, await workspace.readSourceSpanRegistry(), formalRows);
    // The 59-item seed exceeds the live 128 KB single-transaction transport cap.
    // Seed it directly as an already-authored baseline, then enter the production
    // coverage-repair transaction at the exact point under test.
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const compiled = await controller.dispatch("compile_target_selectors", {});
    expect(compiled, JSON.stringify(compiled)).toMatchObject({ ok: true });
    const sourceFingerprint = String(compiled.fingerprint);
    const sourcePlan = validatePlanText(
      await readFile(workspace.lastValidPlanPath, "utf8"),
      manifest,
    ).plan!;
    expect(sourcePlan.acceptance_items).toHaveLength(59);

    const clause725 = clauseEvidence(manifest, "7.2.5");
    const gapFragment = "有抗渗等级要求的灌注桩尚应留置抗渗等级检测试件";
    expect(clause725.text).toContain(gapFragment);
    const initialScope: CoverageReviewScope = {
      mode: "risk_delta",
      affected_item_ids: [],
      affected_evidence_ids: [clause725.evidence_id],
      finding_ids: [],
    };
    const firstReview = await CoverageReviewController.create(
      workspace,
      sourceFingerprint,
      initialScope,
    );
    expect(await firstReview.dispatch("open_review_evidence", {
      evidence_id: clause725.evidence_id,
    })).toMatchObject({ ok: true });
    const stagedRepair = await firstReview.dispatch("stage_coverage_review_draft", {
      status: "repair",
      summary: "7.2.5 的条件性抗渗等级检测未被 59 个表格基线项承载。",
      semantic_coverage_upserts: [{
        coverage_id: "coverage:7.2.5:residual",
        disposition: "shared_context",
        judgment_id: "",
        item_ids: [],
        evidence_bindings: [{
          evidence_id: clause725.evidence_id,
          exact_fragment: clause725.text,
        }],
        reason: "正文先作为独立 residual 证据审核；缺失验收判断另以 finding 路由 repair。",
      }],
      finding_upserts: [{
        finding_id: "subagent-gap:7.2.5:anti-permeability",
        finding_type: "semantic_coverage_gap",
        evidence_id: clause725.evidence_id,
        exact_fragment: gapFragment,
        affected_item_ids: [],
        description: "缺少有抗渗等级要求时的抗渗等级检测试件验收项。",
        reason: "该条件性检测语义没有被当前 59 个表格最终叶承载。",
      }],
    });
    expect(stagedRepair, JSON.stringify(stagedRepair)).toMatchObject({
      validation: { ok: true },
    });
    expect(await firstReview.finalizeMechanicallyReady()).toMatchObject({
      ok: true,
      status: "repair",
    });

    // This is the real production repair transition.
    const repairState = await controller.beginCoverageRepair(sourceFingerprint);
    expect(repairState).toMatchObject({
      mode: "repair",
      repair_source: "coverage",
      coverage_finding_ids: ["subagent-gap:7.2.5:anti-permeability"],
    });
    const repairController = await ToolController.create(workspace);
    expect(repairController.selectorProviderPolicy().stage).toBe("coverage_repair");
    expect(await repairController.dispatch("read_coverage_review", {})).toMatchObject({
      ok: true,
      review: {
        status: "repair",
        findings: [expect.objectContaining({
          finding_id: "subagent-gap:7.2.5:anti-permeability",
        })],
      },
    });
    expect(await repairController.dispatch("read_target_selectors", {})).toMatchObject({
      ok: true,
      summary: { counts: { items: 59 } },
    });
    expect(await repairController.dispatch("open_evidence", {
      evidence_id: clause725.evidence_id,
    })).toMatchObject({ ok: true });

    const located = await repairController.dispatch("batch_locate_evidence_spans", {
      requests: [
        {
          evidence_id: clause725.evidence_id,
          quote: "有抗渗等级要求的灌注桩",
        },
        {
          evidence_id: clause725.evidence_id,
          quote: gapFragment,
        },
        {
          evidence_id: clause725.evidence_id,
          quote: "一个级配不宜少于 3 组",
        },
      ],
    });
    expect(located, JSON.stringify(located)).toMatchObject({ ok: true });
    const locatedRows = located.results as Array<{ span: { span_id: string } }>;
    const conditionSpan = locatedRows[0]!.span.span_id;
    const requirementSpan = locatedRows[1]!.span.span_id;
    const quantitySpan = locatedRows[2]!.span.span_id;

    // External subagent replaces Pi only at the authorship boundary: it emits
    // the same bounded selector upsert a live agent would submit.
    const newItem = {
      key: "anti-permeability-grade",
      lot_key: "lot:7.2",
      name: "抗渗等级",
      category: "主控项目" as const,
      criterion_span_ids: [requirementSpan, quantitySpan],
      continuation_span_ids: [],
      fields: {
        name: {
          composition: "semantic_summary" as const,
          span_ids: [requirementSpan],
          separator: "" as const,
          reason: "项目名概括自 7.2.5 条件性抗渗检测语义。",
        },
        requirement: {
          composition: "verbatim" as const,
          span_ids: [requirementSpan],
          separator: "" as const,
          reason: "验收要求直接来自 7.2.5 原文。",
        },
        method: {
          composition: "not_applicable" as const,
          span_ids: [],
          separator: "" as const,
          reason: "本条未给出独立检测方法字段。",
        },
        quantity: {
          composition: "verbatim" as const,
          span_ids: [quantitySpan],
          separator: "" as const,
          reason: "抽样数量直接来自 7.2.5 原文。",
        },
        note: {
          composition: "not_applicable" as const,
          span_ids: [],
          separator: "" as const,
          reason: "无独立备注字段。",
        },
      },
      table: null,
      inspection_data_type: "review" as const,
      inspection_data_type_reason: "条文要求留置抗渗等级检测试件，但结果数据类型仍需业务确认。",
      inspection_data_type_span_ids: [requirementSpan],
      sampling: {
        status: "explicit" as const,
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [quantitySpan],
        script_span_ids: [quantitySpan],
        condition_span_ids: [conditionSpan],
        reason: "有抗渗等级要求时，一个级配不宜少于 3 组。",
        confidence: 1,
      },
      reason: "修复 Coverage finding，只新增缺失的条件性抗渗等级验收判断。",
    };
    const stagedSelector = await repairController.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: { items: [newItem] },
    });
    expect(stagedSelector, JSON.stringify(stagedSelector)).toMatchObject({ ok: true });
    const committed = await repairController.dispatch("commit_target_selector_draft", {
      draft_fingerprint: stagedSelector.draft_fingerprint,
    });
    expect(committed, JSON.stringify(committed)).toMatchObject({
      ok: true,
      selector_transaction: "coverage_repair",
    });
    const repairedFingerprint = String(committed.fingerprint);
    const repairedPlan = validatePlanText(
      await readFile(workspace.lastValidPlanPath, "utf8"),
      manifest,
    ).plan!;
    expect(repairedPlan.acceptance_items).toHaveLength(60);
    const repairedItem = repairedPlan.acceptance_items.find((item) =>
      item.requirement.includes(gapFragment)
    );
    expect(repairedItem).toBeDefined();

    const persisted = (await workspace.readState()).coverage_recheck!;
    expect(persisted).toMatchObject({
      schema_version: "coverage-recheck-scope/v1",
      plan_fingerprint: repairedFingerprint,
      source_plan_fingerprint: sourceFingerprint,
      finding_ids: ["subagent-gap:7.2.5:anti-permeability"],
      affected_item_ids: [repairedItem!.item_id],
    });
    const repairScope: CoverageReviewScope = {
      mode: "repair_delta",
      affected_item_ids: [...persisted.affected_item_ids],
      affected_evidence_ids: [...persisted.affected_evidence_ids],
      finding_ids: [...persisted.finding_ids],
    };

    // Exercise the same batch handoff that used to pass deterministic risk_delta
    // even when a persisted repair_delta existed.
    const intentionallyBroadDeterministicScope: CoverageReviewScope = {
      mode: "risk_delta",
      affected_item_ids: repairedPlan.acceptance_items.map((item) => item.item_id),
      affected_evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      finding_ids: [],
    };
    const runtimeScope = coverageReviewScopeForRun(
      intentionallyBroadDeterministicScope,
      repairScope,
    );
    expect(runtimeScope).toEqual(repairScope);
    expect(coverageReviewScopeForRun(
      { ...intentionallyBroadDeterministicScope, gap_clause_ids: ["5.11.8"] },
      repairScope,
    )).toEqual({ ...repairScope, gap_clause_ids: ["5.11.8"] });

    const obligations = coverageReviewObligations(
      manifest,
      repairedPlan,
      runtimeScope,
    );
    expect(obligations.required_item_ids).toEqual([repairedItem!.item_id]);
    expect(obligations.required_item_ids).toHaveLength(1);

    const secondReview = await CoverageReviewController.create(
      workspace,
      repairedFingerprint,
      runtimeScope,
    );
    expect(secondReview.reviewScope.mode).toBe("repair_delta");
    expect(await secondReview.dispatch("open_review_evidence", {
      evidence_id: clause725.evidence_id,
    })).toMatchObject({ ok: true });
    const stagedApproved = await secondReview.dispatch("stage_coverage_review_draft", {
      status: "approved",
      summary: "修复后的抗渗等级叶完整承载 7.2.5 条件与抽样数量；仅复核 repair_delta。",
      semantic_coverage_upserts: [{
        coverage_id: "coverage:7.2.5:anti-permeability:recheck",
        disposition: "acceptance_item",
        judgment_id: "judgment:7.2.5:anti-permeability",
        item_ids: [repairedItem!.item_id],
        evidence_bindings: [{
          evidence_id: clause725.evidence_id,
          exact_fragment: gapFragment,
        }],
        reason: "新增叶已保留条件性抗渗检测语义，原 59 项无需重审。",
      }],
      finding_upserts: [],
    });
    expect(stagedApproved, JSON.stringify(stagedApproved)).toMatchObject({
      validation: { ok: true },
    });
    expect(await secondReview.finalizeMechanicallyReady()).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect(await repairController.dispatch("seal_validated_plan", {
      fingerprint: repairedFingerprint,
    })).toMatchObject({ ok: true });

    const finalState = await workspace.readState();
    expect(finalState.status).toBe("sealed");
    const report = {
      schema_version: "gb50202-production-repair-transaction/v1",
      target: "7.2 排桩",
      model_boundary: "external_subagent_emulated_by_chatgpt",
      production_path: [
        "sealed risk_delta repair review",
        "ToolController.beginCoverageRepair",
        "ToolController.read_coverage_review",
        "ToolController.read_target_selectors",
        "ToolController.batch_locate_evidence_spans",
        "ToolController.stage_target_selector_draft",
        "ToolController.commit_target_selector_draft",
        "coverageReviewScopeForRun",
        "CoverageReviewController repair_delta validation",
        "ToolController.seal_validated_plan",
      ],
      initial_leaf_count: sourcePlan.acceptance_items.length,
      repaired_leaf_count: repairedPlan.acceptance_items.length,
      second_pass_required_leaf_count: obligations.required_item_ids.length,
      prior_leaf_reenumeration_count: obligations.required_item_ids.filter((id) =>
        sourcePlan.acceptance_items.some((item) => item.item_id === id)
      ).length,
      selector_protocol: finalState.selector_protocol,
      status_transition: "repair -> approved -> sealed",
    };
    console.info(`GB50202_PRODUCTION_REPAIR_TRANSACTION=${JSON.stringify(report)}`);

    expect(report.initial_leaf_count).toBe(59);
    expect(report.repaired_leaf_count).toBe(60);
    expect(report.second_pass_required_leaf_count).toBe(1);
    expect(report.prior_leaf_reenumeration_count).toBe(0);
    expect(report.selector_protocol).toMatchObject({
      coverage_repairs: 1,
    });
  }, 180_000);
});
