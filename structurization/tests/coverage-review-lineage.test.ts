import { describe, expect, test } from "vitest";

import type { SemanticSourcePlan } from "../src/contracts.js";
import {
  coverageFindingJudgmentIdentity,
  detectCoverageRepairContractNonConvergence,
  normalizeCoverageReviewFindingLineage,
  type CoverageRepairObservation,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import { recordCoverageReviewerMisses } from "../src/batch.js";
import { COVERAGE_REVIEW_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { LEGACY_COVERAGE_REVIEW_PROTOCOL } from "../src/acceptance-prompt-suite.js";
import { coverageRepairProgressSnapshot, recordProgressRound } from "../src/progress-snapshot.js";

const fingerprint = (character: string) => character.repeat(64);

function review(planFingerprint: string, findingId: string, exactFragment: string): DomainCoverageReview {
  return {
    schema_version: "domain-coverage-review/v4",
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: fingerprint("e"),
    status: "repair",
    semantic_coverage: [],
    findings: [{
      finding_id: findingId,
      finding_type: "semantic_coverage_gap",
      evidence_id: "evidence:clause",
      exact_fragment: exactFragment,
      affected_item_ids: ["item:one"],
      description: findingId,
      reason: "source-backed defect",
    }],
    summary: findingId,
  };
}

function plan(fragments: string[]): SemanticSourcePlan {
  return {
    acceptance_items: [],
    semantic_evidence: fragments.map((exact_fragment, index) => ({
      semantic_id: `semantic:${index}`,
      evidence_id: "evidence:clause",
      exact_fragment,
    })),
  } as unknown as SemanticSourcePlan;
}

function itemPlan(options: {
  requirement: string;
  samplingStatus: "reference" | "fallback";
  samplingScript: string;
  ruleIds: string[];
}): SemanticSourcePlan {
  const quantity = "检查数量：按进场批次和产品的抽样检验方案确定。";
  const sourceFragment = { evidence_id: "evidence:clause", exact_fragment: quantity };
  const fieldBinding = (value: string) => ({
    status: "bound" as const,
    composition: "verbatim" as const,
    evidence_ids: ["evidence:clause"],
    source_fragments: [sourceFragment],
    value_sha256: value,
    reason: "fixture",
  });
  return {
    acceptance_items: [{
      item_id: "item:one",
      lot_id: "lot:one",
      name: "水泥质量",
      category: "主控项目",
      requirement: options.requirement,
      method: "检查报告",
      quantity,
      note: "",
      evidence_ids: ["evidence:clause"],
      reference_evidence_ids: ["evidence:reference"],
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "fixture",
      inspection_data_type_evidence_ids: ["evidence:clause"],
      field_bindings: {
        name: fieldBinding("name"),
        requirement: fieldBinding(options.requirement),
        method: fieldBinding("method"),
        quantity: fieldBinding("quantity"),
        note: { ...fieldBinding("note"), status: "not_applicable", composition: "not_applicable", evidence_ids: [], source_fragments: [] },
      },
      sampling: {
        status: options.samplingStatus,
        min_sampling: options.samplingStatus === "reference" ? "每批一次" : "",
        script: options.samplingScript,
        reason: "fixture",
        confidence: 1,
        evidence_ids: options.samplingStatus === "reference" ? ["evidence:reference"] : [],
        rule_ids: options.ruleIds,
        branch_ids: options.ruleIds.length ? ["branch:reference"] : [],
        applied_branches: [],
      },
    }],
    reference_resolutions: [{
      resolution_id: "resolution:one",
      occurrence_id: "occurrence:one",
      origin_evidence_id: "evidence:clause",
      action: "adopt",
      application_mode: "replace_field",
      target_evidence_ids: ["evidence:reference"],
      destination_bindings: [{ item_id: "item:one", target_field: "requirement" }],
      reason: "fixture",
    }],
    semantic_references: [],
    shared_sampling_rules: [],
    semantic_evidence: [{
      semantic_id: "semantic:quantity",
      evidence_id: "evidence:clause",
      exact_fragment: quantity,
    }],
  } as unknown as SemanticSourcePlan;
}

describe("coverage review lineage", () => {
  test("a repaired sampling defect and a new requirement allegation on the same leaf are not a stall", () => {
    const before = itemPlan({ requirement: "水泥质量符合被引条款", samplingStatus: "reference", samplingScript: "错误抽样", ruleIds: [] });
    const after = itemPlan({ requirement: "水泥质量符合被引条款", samplingStatus: "fallback", samplingScript: "按进场批次抽样", ruleIds: [] });
    const a = review(fingerprint("a"), "sampling", "按进场批次抽样");
    a.findings[0]!.defect_field = "sampling";
    const prior = normalizeCoverageReviewFindingLineage(a, undefined, undefined, before).review;
    const b = review(fingerprint("b"), "missing-requirement", "水泥品种必须符合要求");
    b.findings[0]!.defect_field = "requirement";
    const next = normalizeCoverageReviewFindingLineage(b, prior, before, after).review;
    expect(next.findings[0]!.judgment_id).not.toBe(prior.findings[0]!.judgment_id);
    expect(next.findings[0]!.prior_finding_id).toBeUndefined();
    expect(next.findings[0]!.finding_origin).toBe("reviewer_missed_preexisting");
    const snapshot = (v: DomainCoverageReview) => coverageRepairProgressSnapshot({ structure_fingerprint: v.plan_fingerprint,
      judgment_ids: v.findings.map((f) => f.judgment_id!), finding_ids: v.findings.map((f) => f.finding_id) });
    const first = recordProgressRound(undefined, snapshot(prior));
    expect(recordProgressRound(first.window, snapshot(next))).toMatchObject({ stop: false, reason: "marks_changed" });
    const renamed = structuredClone(b);
    renamed.findings[0]!.finding_id = "same-gap-new-name";
    const repeated = normalizeCoverageReviewFindingLineage(renamed, next, after, after).review;
    const second = recordProgressRound(first.window, snapshot(next));
    expect(recordProgressRound(second.window, snapshot(repeated)).stop).toBe(true);
  });

  test("legacy findings with equal leaf requirements still distinguish different source anchors", () => {
    const p = itemPlan({ requirement: "unchanged", samplingStatus: "fallback", samplingScript: "", ruleIds: [] });
    const a = review(fingerprint("a"), "sampling", "quantity clause");
    const b = review(fingerprint("b"), "requirement", "requirement clause");
    const prior = normalizeCoverageReviewFindingLineage(a, undefined, undefined, p).review;
    const next = normalizeCoverageReviewFindingLineage(b, prior, p, p).review;
    expect(next.findings[0]!.judgment_id).not.toBe(prior.findings[0]!.judgment_id);
  });

  test("a deleted sibling is repair-introduced even when the scoped leaf and its broad source quote survive", () => {
    const before = itemPlan({ requirement: "water quality", samplingStatus: "fallback", samplingScript: "fixed", ruleIds: [] });
    const after = structuredClone(before);
    before.acceptance_items.push({ ...structuredClone(before.acceptance_items[0]!), item_id: "item:sibling", requirement: "cement type" });
    before.semantic_evidence.push({ ...before.semantic_evidence[0]!, exact_fragment: "cement type and water quality" });
    after.semantic_evidence = structuredClone(before.semantic_evidence);
    const old = review(fingerprint("a"), "sampling", "quantity");
    old.findings[0]!.defect_field = "sampling";
    const next = review(fingerprint("b"), "missing-type", "cement type");
    next.findings[0]!.defect_field = "requirement";
    const normalized = normalizeCoverageReviewFindingLineage(next, old, before, after).review;
    expect(normalized.findings[0]!.finding_origin).toBe("repair_introduced");
    expect(normalized.findings[0]!.first_seen_plan_fingerprint).toBe(fingerprint("b"));
    expect(normalized.findings[0]!.prior_finding_id).toBeUndefined();
  });

  test("same source and same model finding id cannot merge explicitly different defect fields", () => {
    const a = review(fingerprint("a"), "one-id", "one clause");
    const b = review(fingerprint("b"), "one-id", "one clause");
    a.findings[0]!.defect_field = "sampling";
    b.findings[0]!.defect_field = "requirement";
    const first = normalizeCoverageReviewFindingLineage(a).review;
    const second = normalizeCoverageReviewFindingLineage(b, first, plan([]), plan([])).review;
    expect(second.findings[0]!.judgment_id).not.toBe(first.findings[0]!.judgment_id);
    expect(second.findings[0]!.prior_finding_id).toBeUndefined();
  });

  test("requires complete first-pass worklists and durable prior judgment review", () => {
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).toContain("review_lineage");
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).toContain("get_coverage_review_contract.review_model_protocol");
    // The v4 controller integration tests bind this exact protocol to the real
    // get_coverage_review_contract response; lineage need not be repeated in core.
    const protocol = LEGACY_COVERAGE_REVIEW_PROTOCOL;
    expect(protocol).toMatch(/first-pass阅读每个范围内叶子和必需证据.*完整缺陷worklist，不在.*找到首错即停止/s);
    expect(protocol).toContain("repair_delta先逐个复核prior judgment身份");
    expect(protocol).toContain("summary明确已修复项");
    expect(protocol).toContain("read_candidate_related_context以必需item为锚读到next_cursor=null");
    expect(protocol).toContain("兄弟已承载独立要求可不重复");
    expect(protocol).toContain("本叶适用条件不能仅由别项/name/note代交付");
    expect(protocol).toContain("来源context标签和已填字段不证明语义完整");
    expect(protocol).toMatch(/每finding填写defect_field=.*同叶不同实际缺陷分别留证/s);
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).not.toContain("leaves are not context for the current review and must not be reread");
  });

  test("assigns a deterministic judgment identity and preserves it across repair rounds", () => {
    const first = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "first", "7.3.5 稠度要求"),
    ).review;
    const second = normalizeCoverageReviewFindingLineage(
      review(fingerprint("b"), "renamed", "7.3.5 稠度要求"),
      first,
      plan([]),
      plan([]),
    ).review;

    expect(first.findings[0]).toMatchObject({
      judgment_id: coverageFindingJudgmentIdentity(first.findings[0]!),
      finding_origin: "initial_review",
      first_seen_plan_fingerprint: fingerprint("a"),
    });
    expect(second.findings[0]).toMatchObject({
      judgment_id: first.findings[0]!.judgment_id,
      finding_origin: "unresolved_prior",
      first_seen_plan_fingerprint: fingerprint("a"),
      prior_finding_id: "first",
    });
  });

  test("distinguishes a missed pre-existing omission from a repair-introduced loss", () => {
    const prior = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "known", "已知问题"),
    ).review;
    const missed = normalizeCoverageReviewFindingLineage(
      review(fingerprint("b"), "late", "第一版已经遗漏的芯样直径"),
      prior,
      plan([]),
      plan([]),
    ).review;
    const introduced = normalizeCoverageReviewFindingLineage(
      review(fingerprint("c"), "lost", "修复前存在、修复后丢失的方法"),
      prior,
      plan(["修复前存在、修复后丢失的方法"]),
      plan([]),
    ).review;

    expect(missed.findings[0]!.finding_origin).toBe("reviewer_missed_preexisting");
    expect(introduced.findings[0]!.finding_origin).toBe("repair_introduced");
  });

  test("links the same finding id but classifies a changed sampling projection as repair introduced", () => {
    const priorPlan = itemPlan({
      requirement: "水泥质量符合被引条款",
      samplingStatus: "reference",
      samplingScript: "采用被引条款固定抽样规则",
      ruleIds: ["rule:reference"],
    });
    const candidatePlan = itemPlan({
      requirement: "水泥质量符合展开后的被引要求",
      samplingStatus: "fallback",
      samplingScript: "按项目要求确定并记录",
      ruleIds: [],
    });
    const prior = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "finding-reference-sampling", "检查数量：按进场批次和产品的抽样检验方案确定。"),
      undefined,
      undefined,
      priorPlan,
    ).review;
    const repaired = normalizeCoverageReviewFindingLineage(
      review(fingerprint("b"), "finding-reference-sampling", "检查数量：按进场批次和产品的抽样检验方案确定。"),
      prior,
      priorPlan,
      candidatePlan,
    ).review;

    expect(repaired.findings[0]).toMatchObject({
      finding_origin: "repair_introduced",
      prior_finding_id: "finding-reference-sampling",
      judgment_id: prior.findings[0]!.judgment_id,
    });
  });

  test("classifies a newly found issue on an unchanged affected-item projection as reviewer missed", () => {
    const unchanged = itemPlan({
      requirement: "水泥质量符合被引条款",
      samplingStatus: "reference",
      samplingScript: "采用被引条款固定抽样规则",
      ruleIds: ["rule:reference"],
    });
    const prior = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "known-other-item", "其他问题"),
    ).review;
    prior.findings[0]!.affected_item_ids = ["item:other"];
    const missed = normalizeCoverageReviewFindingLineage(
      review(fingerprint("b"), "late-sampling", "检查数量：按进场批次和产品的抽样检验方案确定。"),
      prior,
      unchanged,
      unchanged,
    ).review;

    expect(missed.findings[0]!.finding_origin).toBe("reviewer_missed_preexisting");
  });

  test("fuses only a repeated stable reviewer miss identity", () => {
    const unchanged = itemPlan({
      requirement: "水泥质量符合被引条款",
      samplingStatus: "reference",
      samplingScript: "采用被引条款固定抽样规则",
      ruleIds: ["rule:reference"],
    });
    const unrelated = review(fingerprint("0"), "known-other-item", "其他问题");
    unrelated.findings[0]!.affected_item_ids = ["item:other"];
    const firstMiss = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "late", "稳定遗漏"),
      unrelated,
      unchanged,
      unchanged,
    ).review.findings[0]!;
    const missedAgain = normalizeCoverageReviewFindingLineage(
      review(fingerprint("c"), "renamed-late", "稳定遗漏"),
      unrelated,
      unchanged,
      unchanged,
    ).review.findings[0]!;
    const first = recordCoverageReviewerMisses(undefined, [firstMiss]);
    const second = recordCoverageReviewerMisses(first.counts, [missedAgain]);
    const different = recordCoverageReviewerMisses(first.counts, [{
      ...missedAgain,
      finding_id: "different",
      judgment_id: "judgment:different",
      exact_fragment: "另一个遗漏",
    }]);

    expect(firstMiss.finding_origin).toBe("reviewer_missed_preexisting");
    expect(missedAgain.finding_origin).toBe("reviewer_missed_preexisting");
    expect(first).toMatchObject({ max_count: 1, repeated_miss_identities: [] });
    expect(second.max_count).toBe(2);
    expect(second.repeated_miss_identities).toHaveLength(1);
    expect(different).toMatchObject({ max_count: 1, repeated_miss_identities: [] });
  });

  test("does not fuse the field sequence when reference sampling changes into fallback", () => {
    const priorPlan = itemPlan({
      requirement: "水泥质量符合被引条款",
      samplingStatus: "reference",
      samplingScript: "采用被引条款固定抽样规则",
      ruleIds: ["rule:reference"],
    });
    const candidatePlan = itemPlan({
      requirement: "水泥质量符合展开后的被引要求",
      samplingStatus: "fallback",
      samplingScript: "按项目要求确定并记录",
      ruleIds: [],
    });
    const earlierReview = review(fingerprint("0"), "known-other-item", "其他问题");
    earlierReview.findings[0]!.affected_item_ids = ["item:other"];
    const firstReview = normalizeCoverageReviewFindingLineage(
      review(fingerprint("a"), "finding-water-reference-sampling-route", "本规范第7.2.1条"),
      earlierReview,
      priorPlan,
      priorPlan,
    ).review;
    const firstTracking = recordCoverageReviewerMisses(undefined, firstReview.findings);
    const secondReview = normalizeCoverageReviewFindingLineage(
      review(fingerprint("b"), "finding-water-reference-sampling-route", "检查数量：按进场批次和产品的抽样检验方案确定。"),
      firstReview,
      priorPlan,
      candidatePlan,
    ).review;
    const secondTracking = recordCoverageReviewerMisses(firstTracking.counts, secondReview.findings);

    expect(firstReview.findings[0]!.finding_origin).toBe("reviewer_missed_preexisting");
    expect(secondReview.findings[0]).toMatchObject({
      finding_origin: "repair_introduced",
      prior_finding_id: "finding-water-reference-sampling-route",
    });
    expect(secondTracking).toMatchObject({ max_count: 1, repeated_miss_identities: [] });
  });

  test("stops unchanged repeated findings and A-B-A structural oscillation", () => {
    const observation = (
      planFingerprint: string,
      structureFingerprint: string,
    ): CoverageRepairObservation => ({
      plan_fingerprint: planFingerprint,
      structure_fingerprint: structureFingerprint,
      judgment_ids: ["judgment:7.3.5"],
      unresolved_judgment_ids: ["judgment:7.3.5"],
      finding_ids: [`finding:${planFingerprint}`],
    });

    expect(detectCoverageRepairContractNonConvergence([
      observation("a", "one-leaf"),
      observation("b", "one-leaf"),
    ])).toEqual({ kind: "same_structure", judgment_ids: ["judgment:7.3.5"] });
    expect(detectCoverageRepairContractNonConvergence([
      observation("a", "one-leaf"),
      observation("b", "four-leaves"),
      observation("c", "one-leaf"),
    ])).toEqual({ kind: "two_state_oscillation", judgment_ids: ["judgment:7.3.5"] });
    expect(detectCoverageRepairContractNonConvergence([
      observation("a", "one-leaf"),
      { ...observation("b", "one-leaf"), judgment_ids: ["judgment:new"], unresolved_judgment_ids: [] },
    ])).toBeUndefined();
  });
});
