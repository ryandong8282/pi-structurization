import { describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sha256Json, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  CoverageReviewController,
  coverageFieldScopedReferenceRoutesForItem,
  coverageReferencePlaceholderDetailsForItem,
  coverageMandatoryEvidenceIds,
  coverageFindingRoute,
  coverageReviewProgressFingerprint,
  coverageReviewObligations,
  createCoverageReviewTools,
  deriveCoverageRepairRecheckScope,
  migrateCoverageReview,
  normalizeCoverageReviewMechanicalFields,
  repairDurableCoverageCandidateCheckpoint,
  validateCoverageReview,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import {
  COVERAGE_FINALIZATION_SYSTEM_PROMPT,
  COVERAGE_REVIEW_SYSTEM_PROMPT,
  LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE,
  TARGET_SELECTOR_SYSTEM_PROMPT,
  isProviderContextTooLargeError,
  runLiveCoverageReview,
} from "../src/pi-runtime.js";
import {
  compileSemanticDecisionsV8,
  type EvidenceSpanDecision,
  type SemanticDecisionPlan,
} from "../src/semantic-decision-compiler.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { validatePlanText, validateSemanticPlanViews } from "../src/validator.js";
import {
  COVERAGE_FINALIZATION_PROTOCOL,
  LEGACY_COVERAGE_REVIEW_PROTOCOL,
  PROMPT_SUITE_VERSION,
  TARGET_SELECTOR_PROTOCOLS,
} from "../src/acceptance-prompt-suite.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "../src/acceptance-tool-text.js";

function fixture(): {
  evidence: EvidenceManifest;
  plan: SemanticSourcePlan;
  planFingerprint: string;
} {
  const primaryUsed = "atom:primary-used";
  const primaryUncovered = "atom:primary-uncovered";
  const dependency = "atom:dependency";
  const navigation = "atom:navigation";
  const evidence: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "coverage-v4",
    target_id: "target:coverage-v4",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "coverage-v4.md",
      sha256: sha256Text("coverage-v4"),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: "markdown-target-scope/v1",
      mode: "agent_discovered",
      target_id: "target:coverage-v4",
      source_line_count: 4,
      selected_start_line: 0,
      selected_end_exclusive_line: 4,
      selected_heading: "",
      selection_reason: "Formatting-neutral test scope.",
      selected_atom_ids: [primaryUsed],
      candidates: [],
    },
    evidence: [
      [primaryUsed, "承载力应符合设计要求", true, "primary"],
      [primaryUncovered, "施工前应校核设备", false, "primary"],
      [dependency, "采用方法A检测", true, "reference"],
      [navigation, "仅供全文搜索的相邻内容", false, undefined],
    ].map(([evidenceId, text, requiresDisposition, evidenceScope]) => ({
      evidence_id: evidenceId as string,
      kind: "paragraph" as const,
      role: "context" as const,
      locator: `test:${evidenceId}`,
      text: text as string,
      text_sha256: sha256Text(text as string),
      requires_disposition: requiresDisposition as boolean,
      ...(evidenceScope ? { evidence_scope: evidenceScope as "primary" | "reference" } : {}),
      ...(evidenceId === dependency ? { registered_dependency: true } : {}),
    })),
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text("coverage-v4-evidence"),
  };
  const fields = {
    name: "承载力",
    requirement: "承载力应符合设计要求",
    method: "采用方法A检测",
    quantity: "",
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
      name: "桩验收",
      evidence_ids: [primaryUsed],
      item_ids: ["item:1"],
    }],
    acceptance_items: [{
      item_id: "item:1",
      lot_id: "lot:1",
      ...fields,
      category: "主控项目",
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "Coverage fixture keeps classification under review.",
      inspection_data_type_evidence_ids: [primaryUsed],
      evidence_ids: [primaryUsed, dependency],
      reference_evidence_ids: [dependency],
      field_bindings: buildItemFieldBindings(fields, [primaryUsed, dependency], evidence),
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "本项没有抽样含义。",
        reason: "No sampling semantics in this fixture.",
        confidence: 1,
        evidence_ids: [],
      },
    }],
    reference_resolutions: [],
    evidence_dispositions: [
      { evidence_id: primaryUsed, disposition: "used", item_ids: ["item:1"], reason: "Direct item evidence." },
      { evidence_id: dependency, disposition: "used", item_ids: ["item:1"], reason: "Registered dependency is bound to the leaf." },
    ],
    semantic_evidence: [
      { semantic_id: "semantic:1", role: "acceptance_item", evidence_id: primaryUsed, exact_fragment: "承载力应符合设计要求", parent_semantic_id: "", materialized_item_id: "item:1", reason: "Direct criterion." },
      { semantic_id: "semantic:2", role: "acceptance_condition", evidence_id: dependency, exact_fragment: "采用方法A检测", parent_semantic_id: "semantic:1", materialized_item_id: "item:1", reason: "Bound method." },
    ],
    semantic_references: [],
    shared_sampling_rules: [],
  };
  return { evidence, plan, planFingerprint: sha256Text("coverage-v4-plan") };
}

async function compactControllerFixture(
  itemCount = 47,
  requirementRepeat = 80,
  structuralNodeCount = 1,
  structuralNodeReasonRepeat = 0,
  extraSource = "",
): Promise<{
  controller: CoverageReviewController;
  plan: SemanticSourcePlan;
  root: string;
}> {
  const source = fixture();
  const markdown = source.evidence.evidence.map(record => record.text).join("\n") + extraSource;
  source.evidence.source.sha256 = sha256Text(markdown);
  const template = source.plan.acceptance_items[0]!;
  source.plan.acceptance_items = Array.from({ length: itemCount }, (_, index) => {
    const item = {
      ...structuredClone(template),
      item_id: `item:${String(index + 1).padStart(3, "0")}`,
      name: `构件验收${index + 1}`,
      requirement: `长要求哨兵-${index + 1}-${"要求内容".repeat(requirementRepeat)}`,
      reference_evidence_ids: [],
    };
    item.field_bindings = buildItemFieldBindings(
      {
        name: item.name,
        requirement: item.requirement,
        method: item.method,
        quantity: item.quantity,
        note: item.note,
      },
      item.evidence_ids,
      source.evidence,
    );
    return item;
  });
  source.plan.inspection_lots[0]!.item_ids = source.plan.acceptance_items.map((item) => item.item_id);
  source.plan.semantic_evidence = source.plan.acceptance_items.flatMap((item, itemIndex) => (
    Array.from({ length: structuralNodeCount }, (_, nodeIndex) => ({
      semantic_id: `semantic:${itemIndex + 1}:${nodeIndex + 1}`,
      role: "acceptance_item" as const,
      evidence_id: "atom:primary-used",
      exact_fragment: "承载力应符合设计要求",
      parent_semantic_id: "",
      materialized_item_id: item.item_id,
      reason: `Structural provenance node ${nodeIndex + 1}. ${"结构化审核依据".repeat(structuralNodeReasonRepeat)}`,
    }))
  ));
  source.plan.evidence_dispositions = source.plan.evidence_dispositions.map((entry) =>
    entry.evidence_id === "atom:primary-used" || entry.evidence_id === "atom:dependency"
      ? { ...entry, item_ids: source.plan.acceptance_items.map((item) => item.item_id) }
      : entry
  );
  const root = await mkdtemp(join(tmpdir(), "coverage-compact-"));
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    source.evidence.job_id,
    source.evidence.target_id,
    {
      manifest: source.evidence,
      markdown: Buffer.from(markdown, "utf8"),
    },
  );
  await writeFile(workspace.lastValidPlanPath, JSON.stringify(source.plan), "utf8");
  const validated = validatePlanText(JSON.stringify(source.plan), source.evidence);
  expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
  const revisionState = await workspace.readState();
  revisionState.last_valid_fingerprint = validated.fingerprint!;
  revisionState.last_valid_plan_sha256 = validated.plan_sha256!;
  await workspace.writeState(revisionState);
  return {
    controller: await CoverageReviewController.create(workspace, validated.fingerprint!),
    plan: source.plan,
    root,
  };
}

async function readReachableCoverageProtocols() {
  const { controller, root } = await compactControllerFixture(1, 1);
  try {
    const contract = await controller.dispatch("get_coverage_review_contract", {});
    expect(contract).toMatchObject({
      ok: true,
      prompt_protocol_version: PROMPT_SUITE_VERSION,
      review_model_protocol: LEGACY_COVERAGE_REVIEW_PROTOCOL,
      review_finalization_protocol: COVERAGE_FINALIZATION_PROTOCOL,
    });
    // The compact system must route to the actual readable contract. A module
    // export alone cannot prove the reviewer can obtain its working protocol.
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).toContain("get_coverage_review_contract.review_model_protocol");
    expect(COVERAGE_REVIEW_SYSTEM_PROMPT).toContain("review_lineage");
    expect(COVERAGE_FINALIZATION_SYSTEM_PROMPT).toContain(COVERAGE_FINALIZATION_PROTOCOL);
    return {
      contract,
      review: `${COVERAGE_REVIEW_SYSTEM_PROMPT}\n${String(contract.review_model_protocol)}`,
      finalization: `${COVERAGE_FINALIZATION_SYSTEM_PROMPT}\n${String(contract.review_finalization_protocol)}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function compactSamplingComponentControllerFixture(): Promise<{
  controller: CoverageReviewController;
  evidence: EvidenceManifest;
  hydratedPlan: SemanticSourcePlan;
  itemId: string;
  samplingEvidenceId: string;
  branchIds: string[];
  root: string;
}> {
  const primaryEvidenceId = "atom:compact-primary";
  const samplingEvidenceId = "atom:compact-sampling-components";
  const primaryText = "连接件外观应完整，检查方法为观察。";
  const samplingText = "共同验收判据。甲分支例外。乙分支备注。";
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "coverage-v8-components",
    target_id: "target:coverage-v8-components",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "coverage-v8-components.md",
      sha256: sha256Text(`${primaryText}\n${samplingText}`),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: "markdown-target-scope/v1" as const,
      mode: "agent_discovered" as const,
      target_id: "target:coverage-v8-components",
      source_line_count: 2,
      selected_start_line: 0,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "Formatting-neutral compact sampling fixture.",
      selected_atom_ids: [primaryEvidenceId],
      candidates: [],
    },
    evidence: [
      {
        evidence_id: primaryEvidenceId,
        kind: "paragraph" as const,
        role: "supporting_clause" as const,
        locator: "fixture:primary",
        text: primaryText,
        text_sha256: sha256Text(primaryText),
        requires_disposition: true,
        evidence_scope: "primary" as const,
      },
      {
        evidence_id: samplingEvidenceId,
        kind: "paragraph" as const,
        role: "supporting_clause" as const,
        locator: "fixture:sampling",
        text: samplingText,
        text_sha256: sha256Text(samplingText),
        requires_disposition: false,
        evidence_scope: "reference" as const,
      },
    ],
    table_fragments: [],
    reference_occurrences: [],
  };
  const evidence: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const span = (evidenceId: string, text: string, exact: string): EvidenceSpanDecision => {
    const start = text.indexOf(exact);
    expect(start, `fixture fragment ${JSON.stringify(exact)} must exist`).toBeGreaterThanOrEqual(0);
    return { evidence_id: evidenceId, start, end: start + exact.length };
  };
  const primaryFull = span(primaryEvidenceId, primaryText, primaryText);
  const samplingFull = span(samplingEvidenceId, samplingText, samplingText);
  const name = span(primaryEvidenceId, primaryText, "连接件外观");
  const requirement = span(primaryEvidenceId, primaryText, "连接件外观应完整");
  const method = span(primaryEvidenceId, primaryText, "观察");
  const criterion = span(samplingEvidenceId, samplingText, "共同验收判据");
  const exception = span(samplingEvidenceId, samplingText, "甲分支例外");
  const note = span(samplingEvidenceId, samplingText, "乙分支备注");
  const notApplicable = {
    value: "",
    composition: "not_applicable" as const,
    spans: [],
    reason: "Not present in this fixture.",
  };
  const decisions: SemanticDecisionPlan = {
    schema_version: "semantic-decision-plan/v1",
    job_id: evidence.job_id,
    target_id: evidence.target_id,
    evidence_fingerprint: evidence.evidence_fingerprint,
    table_assembly: { tables: [], fragment_dispositions: [] },
    lots: [{ key: "lot", name: "连接件", evidence_spans: [primaryFull], reason: "Fixture lot." }],
    items: [{
      key: "item",
      lot_key: "lot",
      category: "一般项目",
      fields: {
        name: { value: "连接件外观", composition: "verbatim", spans: [name], reason: "Fixture name." },
        requirement: { value: "", composition: "verbatim", spans: [requirement], reason: "Fixture requirement." },
        method: { value: "", composition: "verbatim", spans: [method], reason: "Fixture method." },
        quantity: notApplicable,
        note: notApplicable,
      },
      primary_spans: [primaryFull],
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "Fixture keeps classification under review.",
      inspection_data_type_spans: [requirement, method],
      sampling: {
        status: "reference",
        min_sampling: "",
        script: "",
        reason: "Both registered branches apply to this fixture leaf.",
        confidence: 1,
        evidence_spans: [criterion, exception, note],
        rule_keys: ["shared-rule"],
        branch_keys: ["branch-a", "branch-b"],
      },
    }],
    semantic_nodes: [{
      key: "item-node",
      role: "acceptance_item",
      span: requirement,
      parent_key: "",
      item_key: "item",
      reason: "Fixture final-leaf source.",
    }, {
      key: "sampling-node",
      role: "sampling_rule",
      span: samplingFull,
      parent_key: "",
      item_key: "",
      reason: "Fixture shared sampling source.",
    }],
    references: [],
    sampling_rules: [{
      key: "shared-rule",
      source_semantic_key: "sampling-node",
      complete_span: samplingFull,
      components: [{
        key: "criterion",
        role: "acceptance_criterion",
        disposition: "present",
        spans: [criterion],
        reason: "Shared criterion fixture.",
      }],
      branches: [{
        key: "branch-a",
        applies_to_category: "all_items",
        min_sampling: "甲数量",
        script: "甲方法",
        span: exception,
        components: [{
          key: "exception-a",
          role: "exception",
          disposition: "present",
          spans: [exception],
          reason: "Branch A exception fixture.",
        }],
        conditions: [],
      }, {
        key: "branch-b",
        applies_to_category: "all_items",
        min_sampling: "乙数量",
        script: "乙方法",
        span: note,
        components: [{
          key: "note-b",
          role: "note",
          disposition: "present",
          spans: [note],
          reason: "Branch B note fixture.",
        }],
        conditions: [],
      }],
      shared_conditions: [],
      reason: "Fixture shared sampling rule.",
    }],
    occurrence_resolutions: [],
    evidence_dispositions: [
      { evidence_id: primaryEvidenceId, disposition: "context", reason: "Fixture primary evidence." },
      { evidence_id: samplingEvidenceId, disposition: "context", reason: "Fixture component evidence." },
    ],
  };
  const compactPlan = compileSemanticDecisionsV8(decisions, evidence);
  const validation = validatePlanText(JSON.stringify(compactPlan), evidence);
  expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
  expect(validation.plan).toBeDefined();
  const root = await mkdtemp(join(tmpdir(), "coverage-v8-components-"));
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    evidence.job_id,
    evidence.target_id,
    {
      manifest: evidence,
      markdown: Buffer.from(`${primaryText}\n${samplingText}`, "utf8"),
    },
  );
  await writeFile(workspace.lastValidPlanPath, JSON.stringify(compactPlan), "utf8");
  const revisionState = await workspace.readState();
  revisionState.last_valid_fingerprint = validation.fingerprint!;
  revisionState.last_valid_plan_sha256 = validation.plan_sha256!;
  await workspace.writeState(revisionState);
  const hydratedPlan = validation.plan!;
  return {
    controller: await CoverageReviewController.create(workspace, validation.fingerprint!),
    evidence,
    hydratedPlan,
    itemId: hydratedPlan.acceptance_items[0]!.item_id,
    samplingEvidenceId,
    branchIds: hydratedPlan.shared_sampling_rules![0]!.branches.map((branch) => branch.branch_id),
    root,
  };
}

function nestedRecordsWithStringField(value: unknown, field: string): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((entry) => nestedRecordsWithStringField(entry, field));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record[field] === "string" ? [record] : []),
    ...Object.values(record).flatMap((entry) => nestedRecordsWithStringField(entry, field)),
  ];
}

describe("leaf-based coverage review v4", () => {
  test("reference origin mismatch names executable reviewer reads without changing the candidate", async () => {
    const { controller, plan, root } = await compactControllerFixture(1, 1);
    try {
      const opened = await controller.dispatch("open_review_evidence", { evidence_id: "atom:primary-used" });
      const spanId = (opened.registered_spans as Array<{ span_id: string }>)[0]!.span_id;
      const rejected = await controller.dispatch("resolve_document_reference", {
        origin_span_id: spanId, origin_field: "requirement", raw_reference: "第9.9.9条",
        target: { kind: "clause", number: "9.9.9" }, relation: "核对原文",
      });
      expect(rejected).toMatchObject({
        ok: false, error: "origin_span_does_not_contain_raw_reference", dependency_registered: false,
        candidate_evidence_unchanged: true, next_tool: "open_review_evidence",
        next_tool_arguments: { evidence_id: "atom:primary-used" },
        context_investigation_tools: [{ name: "search_review_document", arguments: { cursor: 0 } }],
      });
      const names = new Set(createCoverageReviewTools(controller).map(tool => tool.name));
      for (const name of rejected.next_tools as string[]) expect(names.has(name)).toBe(true);
      const workspace = await RevisionWorkspace.openRevision(root, plan.job_id, plan.target_id, 1);
      expect(JSON.parse(await readFile(workspace.lastValidPlanPath, "utf8"))).toEqual(plan);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exposes a destination-free table placeholder to its source item and materialized table leaves", () => {
    const { evidence, plan } = fixture();
    const occurrenceId = "reference:table-5.5.3";
    evidence.reference_occurrences = [{
      occurrence_id: occurrenceId,
      origin_evidence_id: "atom:primary-used",
      reference_literal_span_id: "span:table-5.5.3",
      origin_fields: ["requirement"],
      raw_reference: "承载力",
      target_evidence_ids: ["atom:dependency"],
      required: true,
      status: "resolved",
      depth: 0,
      path: [],
      reference_kind: "table",
      target_table_id: "5.5.3",
    }];
    plan.reference_resolutions = [{
      resolution_id: "resolution:table-5.5.3",
      occurrence_id: occurrenceId,
      origin_evidence_id: "atom:primary-used",
      action: "mention",
      application_mode: "reference_placeholder",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "仅保留表格引用 provenance。" },
      target_evidence_ids: ["atom:dependency"],
      destination_bindings: [],
      reason: "表格业务叶已物化，原引用仅保留占位。",
    }];
    const tableItem = structuredClone(plan.acceptance_items[0]!);
    tableItem.item_id = "item:table-5.5.3-row";
    tableItem.table_semantics = { table_no: "表 5.5.3" } as typeof tableItem.table_semantics;
    plan.acceptance_items.push(tableItem);

    const sourceDetails = coverageReferencePlaceholderDetailsForItem(
      plan,
      evidence,
      new Set(["item:1"]),
      plan.acceptance_items[0],
    );
    expect(sourceDetails).toEqual([
      expect.objectContaining({
        occurrence_id: occurrenceId,
        application_mode: "reference_placeholder",
        destination_bindings: [],
        materialized_item_ids: ["item:table-5.5.3-row"],
        closure_status: "materialized",
      }),
    ]);
    expect(coverageReferencePlaceholderDetailsForItem(
      plan,
      evidence,
      new Set(["item:table-5.5.3-row"]),
      tableItem,
    )).toEqual(sourceDetails);
  });

  test("exposes one authoritative field-scoped route instead of importing a referenced clause wholesale", async () => {
    const { evidence, plan } = fixture();
    const occurrenceId = "reference:9.3.6-to-7.4.1";
    evidence.reference_occurrences = [{
      occurrence_id: occurrenceId,
      origin_evidence_id: "atom:primary-used",
      reference_literal_span_id: "span:9.3.6-7.4.1",
      origin_fields: ["quantity"],
      raw_reference: "本规范第7.4.1条",
      target_evidence_ids: ["atom:dependency"],
      required: true,
      status: "resolved",
      depth: 1,
      path: ["clause:7.4.1"],
      reference_kind: "clause",
      target_address: {
        source_id: evidence.source.sha256,
        locator_kind: "clause",
        locator: "clause:7.4.1",
      },
    }];
    plan.reference_resolutions = [{
      resolution_id: "resolution:9.3.6-to-7.4.1",
      occurrence_id: occurrenceId,
      origin_evidence_id: "atom:primary-used",
      action: "mention",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["quantity", "sampling"], reason: "本地引用只委托检查数量和抽样程序。" },
      target_evidence_ids: ["atom:dependency"],
      destination_bindings: [{ item_id: "item:1", target_field: "quantity" }],
      reason: "9.3.6 的检查数量引用 7.4.1。",
    }];

    const routes = coverageFieldScopedReferenceRoutesForItem(
      plan,
      evidence,
      new Set(["item:1"]),
    );
    expect(routes).toEqual([expect.objectContaining({
      occurrence_id: occurrenceId,
      raw_reference: "本规范第7.4.1条",
      registered_origin_fields: ["quantity"],
      authoritative_target_field: "quantity",
      route_consistency: "exact",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["quantity", "sampling"],
        reason: "本地引用只委托检查数量和抽样程序。",
      },
    })]);
    const mismatched = structuredClone(plan);
    mismatched.reference_resolutions[0]!.destination_bindings[0]!.target_field = "method";
    expect(coverageFieldScopedReferenceRoutesForItem(
      mismatched,
      evidence,
      new Set(["item:1"]),
    )[0]).toMatchObject({
      authoritative_target_field: null,
      route_consistency: "origin_field_mismatch",
    });
    const { review } = await readReachableCoverageProtocols();
    expect(review).toMatch(/field_scoped_reference_routes.*持久import_scope.*约束引用/s);
    expect(routes[0]?.instruction).toContain("authoritative_target_field");
    expect(routes[0]?.instruction).toContain("import_scope.allowed_fields");
    // The source's method cannot leak through a quantity/sampling-only import.
    expect(routes[0]?.import_scope?.allowed_fields).not.toContain("method");
  });
  test("durable progress ignores prose drift but tracks typed coverage state", () => {
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: "a".repeat(64),
      evidence_fingerprint: "b".repeat(64),
      status: "repair",
      semantic_coverage: [{
        coverage_id: "coverage:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [{ evidence_id: "atom:1", exact_fragment: "验收原文" }],
        reason: "first wording",
      }],
      findings: [{
        finding_id: "finding:1",
        finding_type: "semantic_coverage_gap",
        evidence_id: "atom:1",
        exact_fragment: "遗漏原文",
        affected_item_ids: ["item:1"],
        description: "first description",
        reason: "first rationale",
      }],
      summary: "first summary",
    };
    const checkpoint = {
      mode: "full",
      required_item_ids: ["item:1"],
      uncovered_primary_evidence_ids: [],
      completed_item_count: 1,
      completed_uncovered_primary_count: 0,
      missing_item_ids: [],
      missing_uncovered_primary_evidence_ids: [],
      missing_opened_evidence_ids: [],
      readiness_issues: [],
      ready_for_validation: true,
    };
    const state = {
      opened_evidence_ids: ["atom:1"],
      last_valid_review_fingerprint: "",
      status: "working" as const,
      local_validation_issue_fingerprint: "typed-issues-a",
    };
    const original = coverageReviewProgressFingerprint(review, checkpoint, state);
    const statusOnly = structuredClone(review);
    statusOnly.status = "harness_defect";
    expect(coverageReviewProgressFingerprint(statusOnly, {
      ...checkpoint,
      readiness_issues: [{
        code: "coverage_checkpoint_status_route_mismatch",
        expected_status: "repair",
        actual_status: "harness_defect",
      }],
    }, state)).toBe(original);
    const incompleteCheckpoint = {
      ...checkpoint,
      completed_item_count: 0,
      missing_item_ids: ["item:still-missing"],
      readiness_issues: [{
        code: "coverage_checkpoint_missing_final_items",
        item_ids: ["item:still-missing"],
      }],
      ready_for_validation: false,
    };
    const summaryMissing = structuredClone(review);
    summaryMissing.summary = "";
    expect(coverageReviewProgressFingerprint(summaryMissing, {
      ...incompleteCheckpoint,
      readiness_issues: [
        ...incompleteCheckpoint.readiness_issues,
        { code: "coverage_checkpoint_summary_required" },
      ],
    }, state)).toBe(coverageReviewProgressFingerprint(review, incompleteCheckpoint, state));
    const proseOnly = structuredClone(review);
    proseOnly.summary = "rewritten summary";
    proseOnly.semantic_coverage[0]!.reason = "rewritten reason";
    proseOnly.findings[0]!.finding_id = "finding:renamed-same-typed-issue";
    proseOnly.findings[0]!.description = "rewritten description";
    proseOnly.findings[0]!.reason = "rewritten rationale";
    expect(coverageReviewProgressFingerprint(proseOnly, checkpoint, state)).toBe(original);

    const structural = structuredClone(review);
    structural.semantic_coverage[0]!.coverage_id = "coverage:item:1:replacement";
    expect(coverageReviewProgressFingerprint(structural, checkpoint, state)).not.toBe(original);
    expect(coverageReviewProgressFingerprint(review, checkpoint, {
      ...state,
      opened_evidence_ids: ["atom:1", "atom:2"],
    })).not.toBe(original);
    expect(coverageReviewProgressFingerprint(review, checkpoint, {
      ...state,
      last_valid_review_fingerprint: "c".repeat(64),
    })).not.toBe(original);
  });

  test("routes a required final leaf replaced by context to mechanical finalization", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      await controller.dispatch("open_review_evidence", { evidence_id: "atom:primary-used" });
      await controller.dispatch("open_review_evidence", { evidence_id: "atom:primary-uncovered" });
      await controller.dispatch("open_review_evidence", { evidence_id: "atom:dependency" });

      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "The candidate leaf needs repair but remains the required final-leaf review subject.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "shared_context",
          judgment_id: "",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:primary-used",
            exact_fragment: "承载力应符合设计要求",
          }],
          reason: "The candidate leaf is defective.",
        }, {
          coverage_id: "coverage:uncovered",
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{
            evidence_id: "atom:primary-uncovered",
            exact_fragment: "施工前应校核设备",
          }],
          reason: "This construction prerequisite is not a final acceptance leaf.",
        }],
        finding_upserts: [{
          finding_id: "finding:item:1",
          finding_type: "semantic_coverage_gap",
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
          affected_item_ids: ["item:001"],
          description: "The materialized leaf needs semantic repair.",
          reason: "The finding carries the defect verdict; the final-leaf row still reviews item:1.",
        }],
      });

      expect(staged).toMatchObject({
        ok: true,
        semantic_progress_changed: true,
        mechanical_finalization_required: true,
        coverage_checkpoint: {
          completed_item_count: 0,
          missing_item_ids: ["item:001"],
          ready_for_validation: false,
          readiness_issues: expect.arrayContaining([expect.objectContaining({
            code: "coverage_checkpoint_final_leaf_disposition_required",
            path: "/semantic_coverage/0/disposition",
            item_id: "item:001",
            actual_disposition: "shared_context",
            required_disposition: "acceptance_item",
          })]),
        },
      });

      const corrected = await controller.dispatch("stage_coverage_review_draft", {
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:primary-used",
            exact_fragment: "承载力应符合设计要求",
          }, {
            evidence_id: "atom:dependency",
            exact_fragment: "采用方法A检测",
          }],
          reason: "This row reviews the immutable final-leaf subject; its defect remains in the finding.",
        }, {
          coverage_id: "coverage:shared-method",
          disposition: "shared_context",
          judgment_id: "",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:dependency",
            exact_fragment: "采用方法A检测",
          }],
          reason: "A separate shared qualifier may still bind the affected final leaf.",
        }],
      });
      expect(corrected).toMatchObject({
        ok: true,
        semantic_progress_changed: true,
        coverage_checkpoint: {
          completed_item_count: 1,
          missing_item_ids: [],
          ready_for_validation: true,
        },
        validation: { ok: true },
        ready_for_seal: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists ownership-normalized repair status identically in working, last-valid, and sealed review", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "harness_defect",
        summary: "The compiler label is provisional until deterministic ownership routing.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{ evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
            { evidence_id: "atom:dependency", exact_fragment: "采用方法A检测" }],
          reason: "The exact candidate leaf is reviewed.",
        }, {
          coverage_id: "coverage:primary-uncovered",
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{ evidence_id: "atom:primary-uncovered", exact_fragment: "施工前应校核设备" }],
          reason: "This prerequisite is not an acceptance leaf.",
        }],
        finding_upserts: [{
          finding_id: "finding:misowned-compiler-defect",
          finding_type: "compiler_materialization_defect",
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
          affected_item_ids: ["item:001"],
          description: "The candidate-authored requirement needs semantic repair.",
          reason: "Materialization faithfully preserved the candidate, so the candidate owns the defect.",
        }],
      });
      expect(staged).toMatchObject({
        ok: true,
        validation: { ok: true },
        ready_for_seal: true,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const working = JSON.parse(readFileSync(controller.workingPath, "utf8")) as DomainCoverageReview;
      const lastValid = JSON.parse(readFileSync(join(controller.root, "last-valid.coverage-review.json"), "utf8")) as DomainCoverageReview;
      expect(working).toEqual(lastValid);
      expect(working).toMatchObject({
        status: "repair",
        findings: [expect.objectContaining({ finding_type: "semantic_coverage_gap" })],
      });
      expect(await controller.dispatch("seal_coverage_review", { fingerprint: staged.fingerprint }))
        .toMatchObject({ ok: true, status: "repair" });
      const sealed = JSON.parse(readFileSync(join(controller.root, "coverage-review.json"), "utf8")) as DomainCoverageReview;
      expect(sealed).toEqual(working);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mechanically clears non-acceptance judgment IDs beyond one model stage", () => {
    const review = {
      semantic_coverage: Array.from({ length: 40 }, (_, index) => ({
        coverage_id: `coverage:context:${index}`,
        disposition: index % 2 === 0 ? "shared_context" : "irrelevant",
        judgment_id: `judgment:invalid:${index}`,
      })),
    };
    const normalized = normalizeCoverageReviewMechanicalFields(review);
    expect(normalized.changed_record_count).toBe(40);
    expect(normalized.value.semantic_coverage).toHaveLength(40);
    expect(normalized.value.semantic_coverage.every((row) => row.judgment_id === "")).toBe(true);
  });

  test("finalizes a complete legacy review after deterministic context normalization", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "approved",
        summary: "The final leaf and separate primary context are fully reviewed.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:primary-used",
            exact_fragment: "承载力应符合设计要求",
          }, {
            evidence_id: "atom:dependency",
            exact_fragment: "采用方法A检测",
          }],
          reason: "This row reviews the final leaf.",
        }, {
          coverage_id: "coverage:primary-uncovered",
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{
            evidence_id: "atom:primary-uncovered",
            exact_fragment: "施工前应校核设备",
          }],
          reason: "This prerequisite is not a final acceptance judgment.",
        }],
      });
      expect(staged).toMatchObject({ validation: { ok: true } });

      const legacy = JSON.parse(readFileSync(controller.workingPath, "utf8")) as DomainCoverageReview;
      legacy.semantic_coverage[1]!.judgment_id = "judgment:legacy-context";
      await writeFile(controller.workingPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
      const before = await controller.readState();

      expect(await controller.finalizeMechanicallyReady()).toMatchObject({
        ok: true,
        status: "approved",
      });
      const normalized = JSON.parse(readFileSync(controller.workingPath, "utf8")) as DomainCoverageReview;
      expect(normalized.semantic_coverage[1]!.judgment_id).toBe("");
      expect((await controller.readState()).next_history_sequence).toBeGreaterThan(
        before.next_history_sequence,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tells finalization to stage oversized mechanical repairs in bounded batches", async () => {
    const { finalization } = await readReachableCoverageProtocols();
    expect(finalization).toMatch(/按stage原容量先保存首批机械修复/);
    expect(finalization).toMatch(/多批由原harness继续/);
    expect(finalization).toMatch(/不以容量声明替工作/);
  });

  test("requires deterministic uncovered-primary coverage even when selector disposition metadata is false", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      await controller.dispatch("open_review_evidence", { evidence_id: "atom:primary-used" });
      await controller.dispatch("open_review_evidence", { evidence_id: "atom:dependency" });
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "approved",
        summary: "The final leaf is covered; one separate primary coverage disposition remains.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:primary-used",
            exact_fragment: "承载力应符合设计要求",
          }, {
            evidence_id: "atom:dependency",
            exact_fragment: "采用方法A检测",
          }],
          reason: "This row reviews the immutable final leaf.",
        }],
      });
      expect(staged).toMatchObject({
        ok: true,
        coverage_checkpoint: {
          missing_uncovered_primary_evidence_ids: ["atom:primary-uncovered"],
          ready_for_validation: false,
          readiness_issues: expect.arrayContaining([expect.objectContaining({
            code: "coverage_checkpoint_missing_primary_dispositions",
            evidence_ids: ["atom:primary-uncovered"],
            required_dispositions: ["shared_context", "irrelevant", "validated_blocking_finding"],
            action: expect.stringContaining("requires_disposition=false"),
          })]),
        },
      });

      await controller.dispatch("open_review_evidence", { evidence_id: "atom:primary-uncovered" });
      const completed = await controller.dispatch("stage_coverage_review_draft", {
        semantic_coverage_upserts: [{
          coverage_id: "coverage:primary-uncovered",
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{
            evidence_id: "atom:primary-uncovered",
            exact_fragment: "施工前应校核设备",
          }],
          reason: "This construction prerequisite is not a final acceptance judgment.",
        }],
      });
      expect(completed).toMatchObject({
        ok: true,
        coverage_checkpoint: {
          missing_uncovered_primary_evidence_ids: [],
          ready_for_validation: true,
        },
        validation: { ok: true },
        ready_for_seal: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a validated blocking finding hands uncovered primary evidence to repair without candidate binding", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const base = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "The uncovered primary evidence proves a candidate omission that must be repaired.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [
            { evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
            { evidence_id: "atom:dependency", exact_fragment: "采用方法A检测" },
          ],
          reason: "The candidate leaf itself has been reviewed.",
        }],
      });
      expect(base).toMatchObject({
        coverage_checkpoint: {
          missing_uncovered_primary_evidence_ids: ["atom:primary-uncovered"],
          ready_for_validation: false,
        },
      });
      const before = await controller.readDurableProgressSnapshot();
      const uncoveredSpanId = controller.spanRegistry!.spans.find((span) =>
        span.evidence_id === "atom:primary-uncovered" && span.start === 0
      )!.span_id;
      const handedOff = await controller.dispatch("stage_coverage_review_draft", {
        finding_upserts: [{
          finding_id: "finding:missing-primary-meaning",
          finding_type: "semantic_coverage_gap",
          evidence_id: "atom:primary-uncovered",
          span_id: uncoveredSpanId,
          affected_item_ids: ["item:001"],
          description: "The candidate leaf omits this relevant primary requirement.",
          reason: "The reviewer cannot edit the candidate; the repair agent must add the missing provenance and meaning.",
        }],
      });
      expect(handedOff).toMatchObject({
        coverage_checkpoint: {
          blocking_finding_evidence_ids: ["atom:primary-uncovered"],
          missing_uncovered_primary_evidence_ids: [],
          completed_uncovered_primary_count: 1,
          ready_for_validation: true,
        },
        validation: { ok: true },
        ready_for_seal: true,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const after = await controller.readDurableProgressSnapshot();
      expect(after.progress_fingerprint).not.toBe(before.progress_fingerprint);
      expect(await controller.dispatch("seal_coverage_review", { fingerprint: handedOff.fingerprint }))
        .toMatchObject({ ok: true, status: "repair" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["soft_classification_disagreement", "source_glyph_review"] as const)(
    "a valid but nonblocking %s finding does not discharge uncovered primary evidence",
    async (findingType) => {
      const { controller, root } = await compactControllerFixture(1, 1);
      try {
        for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]) {
          await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
        }
        const uncoveredSpanId = controller.spanRegistry!.spans.find((span) =>
          span.evidence_id === "atom:primary-uncovered" && span.start === 0
        )!.span_id;
        const staged = await controller.dispatch("stage_coverage_review_draft", {
          status: "approved",
          summary: "A nonblocking note cannot replace a disposition or repair handoff.",
          semantic_coverage_upserts: [{
            coverage_id: "coverage:item:1",
            disposition: "acceptance_item",
            judgment_id: "judgment:item:1",
            item_ids: ["item:001"],
            evidence_bindings: [{ evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" }],
            reason: "The final leaf has been reviewed.",
          }],
          finding_upserts: [{
            finding_id: `finding:${findingType}`,
            finding_type: findingType,
            evidence_id: "atom:primary-uncovered",
            span_id: uncoveredSpanId,
            affected_item_ids: ["item:001"],
            description: "Nonblocking review note.",
            reason: "This finding type does not request candidate repair.",
          }],
        });
        expect(staged).toMatchObject({
          coverage_checkpoint: {
            blocking_finding_evidence_ids: [],
            missing_uncovered_primary_evidence_ids: ["atom:primary-uncovered"],
            ready_for_validation: false,
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("an invalid blocking finding cannot discharge uncovered primary evidence", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const uncoveredSpanId = controller.spanRegistry!.spans.find((span) =>
        span.evidence_id === "atom:primary-uncovered" && span.start === 0
      )!.span_id;
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "An unknown affected leaf makes the finding locally invalid.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{ evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" }],
          reason: "The final leaf has been reviewed.",
        }],
        finding_upserts: [{
          finding_id: "finding:unknown-item",
          finding_type: "semantic_coverage_gap",
          evidence_id: "atom:primary-uncovered",
          span_id: uncoveredSpanId,
          affected_item_ids: ["item:unknown"],
          description: "Invalid candidate gap owner.",
          reason: "The affected item is not a materialized final leaf.",
        }],
      });
      expect(staged).toMatchObject({
        coverage_checkpoint: {
          blocking_finding_evidence_ids: [],
          missing_uncovered_primary_evidence_ids: ["atom:primary-uncovered"],
          ready_for_validation: false,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a mismatched finding span is rejected before it can discharge uncovered primary evidence", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const wrongSpanId = controller.spanRegistry!.spans.find((span) =>
        span.evidence_id === "atom:primary-used" && span.start === 0
      )!.span_id;
      const rejected = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "A mismatched pointer is not an exact repair handoff.",
        finding_upserts: [{
          finding_id: "finding:mismatched-span",
          finding_type: "semantic_coverage_gap",
          evidence_id: "atom:primary-uncovered",
          span_id: wrongSpanId,
          affected_item_ids: ["item:001"],
          description: "Invalid pointer.",
          reason: "The span belongs to another evidence resource.",
        }],
      });
      expect(rejected).toMatchObject({
        error: "coverage_review_span_unresolved",
        issues: [expect.objectContaining({ code: "coverage_review_span_evidence_mismatch" })],
      });
      expect(await controller.dispatch("read_working_coverage_review", {})).toMatchObject({
        coverage_checkpoint: {
          missing_uncovered_primary_evidence_ids: ["atom:primary-uncovered"],
          ready_for_validation: false,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unbound shared context stays invalid without turning every binding error into a semantic gap", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      for (const evidenceId of ["atom:primary-used", "atom:primary-uncovered"]) {
        await controller.dispatch("open_review_evidence", { evidence_id: evidenceId });
      }
      const uncoveredSpanId = controller.spanRegistry!.spans.find((span) =>
        span.evidence_id === "atom:primary-uncovered" && span.start === 0
      )!.span_id;
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "The candidate does not carry the uncovered primary evidence.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:item:1",
          item_ids: ["item:001"],
          evidence_bindings: [{ evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" }],
          reason: "The final leaf has been reviewed.",
        }, {
          coverage_id: "coverage:invalid-shared",
          disposition: "shared_context",
          judgment_id: "",
          item_ids: ["item:001"],
          evidence_bindings: [{ evidence_id: "atom:primary-uncovered", exact_fragment: "施工前应校核设备" }],
          reason: "Invalidly binds evidence absent from candidate provenance.",
        }],
        finding_upserts: [{
          finding_id: "finding:missing-primary-meaning",
          finding_type: "semantic_coverage_gap",
          evidence_id: "atom:primary-uncovered",
          span_id: uncoveredSpanId,
          affected_item_ids: ["item:001"],
          description: "The candidate omits this relevant primary requirement.",
          reason: "The exact finding, not the unbound shared-context item_ids, hands the defect to Repair.",
        }],
      });
      expect(staged).toMatchObject({
        error: "coverage_review_local_validation",
        local_issues: expect.arrayContaining([expect.objectContaining({
          code: "coverage_review_shared_fragment_unbound",
          details: expect.objectContaining({
            required_action: "reassess_shared_context_binding",
            writable_collection: "semantic_coverage",
            next_tool: "stage_coverage_review_draft",
            candidate_carries_fragment: false,
            instruction: expect.stringContaining("an unsupported review link from a source-proven business omission"),
          }),
        })]),
      });
      const fixedBinding = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "The unsupported link is removed, but the source-proven omission still requires Repair.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:invalid-shared",
          disposition: "shared_context",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{ evidence_id: "atom:primary-uncovered", span_id: uncoveredSpanId }],
          reason: "Keep the original source while the independent semantic finding remains blocking.",
        }],
      });
      expect(fixedBinding).toMatchObject({ ok: true, ready_for_seal: true });
      const durable = JSON.parse(readFileSync(controller.workingPath, "utf8"));
      expect(durable.status).toBe("repair");
      expect(durable.findings).toHaveLength(1);
      expect(durable.findings[0].finding_id).toBe("finding:missing-primary-meaning");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a heading binding can be repaired in the review without changing candidate content or creating a finding", async () => {
    const { evidence, plan, planFingerprint } = fixture();
    const heading = evidence.evidence.find((entry) => entry.evidence_id === "atom:primary-uncovered")!;
    heading.text = "## 7.4 混凝土施工";
    heading.text_sha256 = sha256Text(heading.text);
    heading.kind = "heading";
    heading.role = "section_heading";
    plan.inspection_lots[0]!.evidence_ids.push(heading.evidence_id);
    const originalPlanHash = sha256Json(plan);
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      summary: "The criterion is complete; the parent heading is context, not another criterion.",
      semantic_coverage: [{
        coverage_id: "coverage:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:item:1",
        item_ids: ["item:1"],
        evidence_bindings: [
          { evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
          { evidence_id: "atom:dependency", exact_fragment: "采用方法A检测" },
        ],
        reason: "The criterion and method are retained.",
      }, {
        coverage_id: "coverage:heading",
        disposition: "shared_context",
        judgment_id: "",
        item_ids: ["item:1"],
        evidence_bindings: [{ evidence_id: heading.evidence_id, exact_fragment: heading.text }],
        reason: "The heading already names the parent group.",
      }],
      findings: [],
    };
    const opened = new Set(evidence.evidence.map((entry) => entry.evidence_id));
    const rejected = validateCoverageReview(review, planFingerprint, evidence, opened, plan);
    expect(rejected.issues.map((issue) => issue.code)).toEqual(["coverage_review_shared_fragment_unbound"]);
    expect(rejected.issues[0]!.details).toMatchObject({
      required_action: "reassess_shared_context_binding",
      writable_path: "/semantic_coverage/1/item_ids",
      instruction: expect.stringContaining("do not create a blocking finding solely because this link failed"),
    });

    review.semantic_coverage[1]!.item_ids = [];
    const corrected = validateCoverageReview(review, planFingerprint, evidence, opened, plan);
    expect(corrected.issues).toEqual([]);
    expect(corrected.review).toMatchObject({ status: "approved", findings: [] });
    expect(sha256Json(plan)).toBe(originalPlanHash);
    const { review: reviewProtocol, finalization } = await readReachableCoverageProtocols();
    expect(finalization).toMatch(/shared_fragment_unbound只证明复核链接无据/);
    expect(finalization).toMatch(/仅清无据shared_context.item_ids.*不虚造业务缺陷/s);
    expect(finalization).toMatch(/真实缺陷finding/);
    expect(reviewProtocol).toMatch(/semantic_coverage_gap.*遗漏.*错字段.*错引用.*错条件/s);
  });

  test("coverage tool rejects keep the actual tool name", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      const unknown = await controller.dispatch("not_a_coverage_tool", {});
      expect(unknown).toMatchObject({
        ok: false,
        error: "unknown_coverage_review_tool",
        actual_tool: "not_a_coverage_tool",
      });
      expect(String(unknown.instruction)).toMatch(/get_coverage_review_contract/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("surfaces irrelevant item bindings before the mandatory set is complete", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      const staged = await controller.dispatch("stage_coverage_review_draft", {
        status: "repair",
        summary: "Persist the invalid row so its exact path can be repaired.",
        semantic_coverage_upserts: [{
          coverage_id: "coverage:item:1",
          disposition: "irrelevant",
          judgment_id: "judgment:invalid",
          item_ids: ["item:001"],
          evidence_bindings: [{
            evidence_id: "atom:primary-used",
            exact_fragment: "承载力应符合设计要求",
          }],
          reason: "Invalid substitute for a final-leaf review record.",
        }],
      });
      expect(staged).toMatchObject({
        ok: true,
        coverage_checkpoint: {
          ready_for_validation: false,
          readiness_issues: expect.arrayContaining([
            expect.objectContaining({
              code: "coverage_review_irrelevant_items",
              path: "/semantic_coverage/0/item_ids",
            }),
            expect.objectContaining({
              code: "coverage_checkpoint_final_leaf_disposition_required",
              path: "/semantic_coverage/0/disposition",
            }),
          ]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves compact v8 sampling component provenance for one final-leaf review without crossing branches", async () => {
    const {
      controller,
      evidence,
      hydratedPlan,
      itemId,
      samplingEvidenceId,
      branchIds,
      root,
    } = await compactSamplingComponentControllerFixture();
    try {
      const details = await controller.dispatch("read_candidate_leaf_details", { item_ids: [itemId] });
      expect(details).toMatchObject({
        ok: true,
        schema_version: "coverage-candidate-leaf-details/v1",
        requested_item_ids: [itemId],
      });
      const detail = (details.details as Array<Record<string, unknown>>)[0]!;
      const allowedSamplingBinding = (detail.allowed_bindings as Array<{
        evidence_id: string;
        exact_fragment_candidates: string[];
      }>).find((binding) => binding.evidence_id === samplingEvidenceId);
      expect(allowedSamplingBinding?.exact_fragment_candidates).toEqual(expect.arrayContaining([
        "共同验收判据",
        "甲分支例外",
        "乙分支备注",
      ]));

      const componentProvenance = detail.sampling_component_provenance;
      expect(JSON.stringify(componentProvenance)).toContain("共同验收判据");
      const branchRows = nestedRecordsWithStringField(componentProvenance, "branch_id");
      const branchA = branchRows.find((row) => row.branch_id === branchIds[0]);
      const branchB = branchRows.find((row) => row.branch_id === branchIds[1]);
      expect(JSON.stringify(branchA)).toContain("甲分支例外");
      expect(JSON.stringify(branchA)).not.toContain("乙分支备注");
      expect(JSON.stringify(branchB)).toContain("乙分支备注");
      expect(JSON.stringify(branchB)).not.toContain("甲分支例外");

      expect(coverageMandatoryEvidenceIds(evidence, hydratedPlan)).toContain(samplingEvidenceId);
      expect(coverageReviewObligations(evidence, hydratedPlan)).toMatchObject({
        required_item_ids: [itemId],
        review_record_count: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enumerates a large candidate through compact bounded inventory pages", async () => {
    const { controller, plan, root } = await compactControllerFixture();
    try {
      const itemIds: string[] = [];
      let cursor = 0;
      let inventoryFingerprint = "";
      do {
        const page = await controller.dispatch("read_candidate_plan", { cursor, max_items: 9 });
        expect(page).toMatchObject({
          ok: true,
          schema_version: "coverage-candidate-inventory/v2",
          page: { cursor, returned_count: expect.any(Number) },
        });
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
        expect(JSON.stringify(page)).not.toContain("长要求哨兵");
        const fingerprint = String(page.inventory_fingerprint);
        inventoryFingerprint ||= fingerprint;
        expect(fingerprint).toBe(inventoryFingerprint);
        itemIds.push(...(page.leaves as Array<{ item_id: string }>).map((leaf) => leaf.item_id));
        const nextCursor = (page.page as { next_cursor: number | null }).next_cursor;
        if (nextCursor === null) break;
        expect(nextCursor).toBeGreaterThan(cursor);
        cursor = nextCursor;
      } while (true);
      expect(itemIds).toEqual(plan.acceptance_items.map((item) => item.item_id));
      expect(new Set(itemIds).size).toBe(itemIds.length);

      const restarted = await CoverageReviewController.create(
        controller.workspace,
        controller.planFingerprint,
      );
      const firstPageAgain = await restarted.dispatch("read_candidate_plan", { cursor: 0, max_items: 9 });
      expect(firstPageAgain.inventory_fingerprint).toBe(inventoryFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("risk_delta inventory and exact leaf reads expose only suspicious leaves", async () => {
    const { controller, plan, root } = await compactControllerFixture(12, 2);
    try {
      const suspicious = [plan.acceptance_items[2]!.item_id, plan.acceptance_items[9]!.item_id];
      const narrowed = await CoverageReviewController.create(
        controller.workspace,
        controller.planFingerprint,
        {
          mode: "risk_delta",
          affected_item_ids: suspicious,
          affected_evidence_ids: [],
          finding_ids: [],
        },
      );
      const page = await narrowed.dispatch("read_candidate_plan", { cursor: 0, max_items: 12 });
      expect(page).toMatchObject({
        ok: true,
        total_leaf_count: 12,
        scoped_leaf_count: 2,
        out_of_scope_leaf_count: 10,
        inventory_scope: "current_review_scope",
        required_leaf_count: 2,
      });
      expect((page.leaves as Array<{ item_id: string }>).map((leaf) => leaf.item_id).sort())
        .toEqual([...suspicious].sort());

      const details = await narrowed.dispatch("read_candidate_leaf_details", { item_ids: [suspicious[0]!] });
      expect(details).toMatchObject({ ok: true, requested_item_ids: [suspicious[0]] });

      const cleanItemId = plan.acceptance_items[0]!.item_id;
      const blocked = await narrowed.dispatch("read_candidate_leaf_details", { item_ids: [cleanItemId] });
      expect(blocked).toMatchObject({
        ok: false,
        error: "coverage_candidate_item_outside_review_scope",
        outside_scope_item_ids: [cleanItemId],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distinguishes an eighteen-item candidate from a one-item repair worklist", async () => {
    const { controller, plan, root } = await compactControllerFixture(18, 1);
    try {
      const itemId = plan.acceptance_items[0]!.item_id;
      const narrowed = await CoverageReviewController.create(controller.workspace, controller.planFingerprint, {
        mode: "repair_delta", affected_item_ids: [itemId], affected_evidence_ids: [], finding_ids: ["fix:one"],
      });
      const contract = await narrowed.dispatch("get_coverage_review_contract", {});
      expect(contract).toMatchObject({
        candidate_inventory: { total_leaf_count: 18, scoped_leaf_count: 1, out_of_scope_leaf_count: 17 },
        coverage_obligations: { required_item_ids: [itemId] },
      });
      expect(contract.scope_instruction).toContain("not the full candidate inventory");
      const inventory = await narrowed.dispatch("read_candidate_plan", { cursor: 0, max_items: 5 });
      expect(inventory).toMatchObject({
        schema_version: "coverage-candidate-inventory/v2",
        total_leaf_count: 18, scoped_leaf_count: 1, out_of_scope_leaf_count: 17,
        page: { returned_count: 1, next_cursor: null, complete: true },
      });
      expect(inventory.leaves).toHaveLength(1);
      expect(inventory.instruction).toContain("Out-of-scope items still exist");
      expect(JSON.stringify(inventory)).not.toContain("长要求哨兵");
      expect(await narrowed.dispatch("read_candidate_plan", { cursor: 2 })).toMatchObject({
        ok: false, error: "coverage_candidate_inventory_cursor_invalid", total_leaf_count: 18, scoped_leaf_count: 1,
      });
      expect(await narrowed.dispatch("read_candidate_leaf_details", { item_ids: [plan.acceptance_items[1]!.item_id] }))
        .toMatchObject({ ok: false, error: "coverage_candidate_item_outside_review_scope" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("delta review can read sibling allocations without expanding obligations and must read them before alleging a gap", async () => {
    const { controller, plan, root } = await compactControllerFixture(3, 1);
    try {
      const itemId = plan.acceptance_items[1]!.item_id;
      const narrowed = await CoverageReviewController.create(controller.workspace, controller.planFingerprint, {
        mode: "repair_delta", affected_item_ids: [itemId], affected_evidence_ids: [], finding_ids: ["old-sampling"],
      });
      const finding = { finding_id: "new-omission", finding_type: "semantic_coverage_gap", defect_field: "requirement",
        evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求", affected_item_ids: [itemId], description: "alleged gap", reason: "fixture" };
      expect(await narrowed.dispatch("stage_coverage_review_draft", { finding_upserts: [finding] }))
        .toMatchObject({ ok: false, error: "coverage_related_context_incomplete", budget_consumed: false });
      expect(await narrowed.dispatch("read_candidate_related_context", { item_id: itemId, cursor: 4 }))
        .toMatchObject({ ok: false, error: "coverage_related_context_cursor_gap", next_cursor: 0 });
      const before = await narrowed.readDurableProgressSnapshot();
      let cursor: number | null = 0;
      const records: Array<{ item_id: string; field: string; text: string }> = [];
      while (cursor !== null) {
        const page = await narrowed.dispatch("read_candidate_related_context", { item_id: itemId, cursor, max_records: 2 });
        expect(page).toMatchObject({ ok: true, related_leaf_count: 2, context_only: true });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
        records.push(...page.records as typeof records);
        cursor = page.next_cursor as number | null;
        if (cursor === 2) {
          expect(await narrowed.dispatch("stage_coverage_review_draft", { finding_upserts: [finding] }))
            .toMatchObject({ ok: false, error: "coverage_related_context_incomplete" });
        }
      }
      expect(records.filter((record) => record.field === "requirement").map((record) => record.text))
        .toEqual([plan.acceptance_items[0]!.requirement, plan.acceptance_items[2]!.requirement]);
      expect(await narrowed.readDurableProgressSnapshot()).not.toEqual(before);
      const reopened = await CoverageReviewController.create(controller.workspace, controller.planFingerprint, narrowed.reviewScope);
      // Existing completed read receipts survive fresh sessions. Findings still undergo normal validation.
      const staged = await reopened.dispatch("stage_coverage_review_draft", { finding_upserts: [finding] });
      expect(staged.error).not.toBe("coverage_related_context_incomplete");
      expect(await reopened.dispatch("get_coverage_review_contract", {})).toMatchObject({
        coverage_obligations: { required_item_ids: [itemId] }, candidate_inventory: { scoped_leaf_count: 1 },
      });
      expect(await reopened.dispatch("read_candidate_leaf_details", { item_ids: [plan.acceptance_items[0]!.item_id] }))
        .toMatchObject({ ok: false, error: "coverage_candidate_item_outside_review_scope" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("repair-added same-source duplicate stays scoped but requires existing-peer context before a finding", async () => {
    const { controller, plan, root } = await compactControllerFixture(2, 1);
    try {
      const existingItem = plan.acceptance_items[0]!;
      const addedItem = plan.acceptance_items[1]!;
      addedItem.name = existingItem.name;
      addedItem.requirement = existingItem.requirement;
      addedItem.field_bindings = structuredClone(existingItem.field_bindings);

      const sourcePlan = structuredClone(plan);
      sourcePlan.acceptance_items = sourcePlan.acceptance_items.filter((item) => item.item_id !== addedItem.item_id);
      sourcePlan.inspection_lots[0]!.item_ids = [existingItem.item_id];
      sourcePlan.semantic_evidence = (sourcePlan.semantic_evidence ?? [])
        .filter((node) => node.materialized_item_id !== addedItem.item_id);
      sourcePlan.evidence_dispositions = sourcePlan.evidence_dispositions.map((entry) => ({
        ...entry,
        item_ids: entry.item_ids.filter((itemId) => itemId !== addedItem.item_id),
      }));

      const evidence = await controller.workspace.readEvidenceManifest();
      const validated = validatePlanText(JSON.stringify(plan), evidence);
      expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
      await writeFile(controller.workspace.lastValidPlanPath, JSON.stringify(plan), "utf8");
      await controller.workspace.updateState((state) => {
        state.last_valid_fingerprint = validated.fingerprint!;
        state.last_valid_plan_sha256 = validated.plan_sha256!;
      });

      const scope = deriveCoverageRepairRecheckScope(evidence, sourcePlan, plan, {
        mode: "repair_delta",
        affected_item_ids: [addedItem.item_id],
        affected_evidence_ids: [],
        finding_ids: ["duplicate-after-repair"],
      });
      expect(scope.affected_item_ids).toEqual([addedItem.item_id]);
      expect(coverageReviewObligations(evidence, plan, scope).required_item_ids).toEqual([addedItem.item_id]);

      const repaired = await CoverageReviewController.create(controller.workspace, validated.fingerprint!, scope);
      const duplicateFinding = {
        finding_id: "duplicate-after-repair",
        finding_type: "semantic_coverage_gap",
        defect_field: "requirement",
        evidence_id: "atom:primary-used",
        exact_fragment: "承载力应符合设计要求",
        affected_item_ids: [addedItem.item_id],
        description: "Repair introduced a duplicate acceptance item",
        reason: "The repaired item repeats the existing same-source judgment",
      };
      expect(await repaired.dispatch("stage_coverage_review_draft", { finding_upserts: [duplicateFinding] }))
        .toMatchObject({ ok: false, error: "coverage_related_context_incomplete", budget_consumed: false });

      let cursor: number | null = 0;
      const records: Array<{ item_id: string; field: string; text: string }> = [];
      while (cursor !== null) {
        const page = await repaired.dispatch("read_candidate_related_context", {
          item_id: addedItem.item_id,
          cursor,
          max_records: 2,
        });
        expect(page).toMatchObject({ ok: true, related_leaf_count: 1, context_only: true });
        records.push(...page.records as typeof records);
        cursor = page.next_cursor as number | null;
      }
      expect(records).toContainEqual(expect.objectContaining({
        item_id: existingItem.item_id,
        field: "requirement",
        text: existingItem.requirement,
      }));
      expect((await repaired.dispatch("stage_coverage_review_draft", { finding_upserts: [duplicateFinding] })).error)
        .not.toBe("coverage_related_context_incomplete");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("absent siblings are not invented and a real omission can still be staged", async () => {
    const { controller, plan, root } = await compactControllerFixture(1, 1);
    try {
      const itemId = plan.acceptance_items[0]!.item_id;
      const narrowed = await CoverageReviewController.create(controller.workspace, controller.planFingerprint, {
        mode: "repair_delta", affected_item_ids: [itemId], affected_evidence_ids: [], finding_ids: [],
      });
      expect(await narrowed.dispatch("read_candidate_related_context", { item_id: itemId }))
        .toMatchObject({ ok: true, related_leaf_count: 0, records: [], next_cursor: null });
      const staged = await narrowed.dispatch("stage_coverage_review_draft", { finding_upserts: [{
        finding_id: "real-omission", finding_type: "semantic_coverage_gap", defect_field: "requirement",
        evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求", affected_item_ids: [itemId],
        description: "A source-backed requirement really is absent", reason: "No sibling carries this criterion",
      }] });
      expect(staged.error).not.toBe("coverage_related_context_incomplete");
      const saved = JSON.parse(readFileSync(narrowed.workingPath, "utf8"));
      expect(saved.findings).toMatchObject([{ finding_id: "real-omission", defect_field: "requirement" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("an empty repair worklist does not report an empty candidate", async () => {
    const { controller, root } = await compactControllerFixture(3, 1);
    try {
      const narrowed = await CoverageReviewController.create(controller.workspace, controller.planFingerprint, {
        mode: "repair_delta", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [],
      });
      expect(await narrowed.dispatch("read_candidate_plan", {})).toMatchObject({
        total_leaf_count: 3, scoped_leaf_count: 0, out_of_scope_leaf_count: 3,
        leaves: [], page: { complete: true, next_cursor: null },
      });
      const contract = await narrowed.dispatch("get_coverage_review_contract", {});
      expect(contract.review_model_protocol).toBe(LEGACY_COVERAGE_REVIEW_PROTOCOL);
      expect(String(contract.review_model_protocol)).toContain("不能因目录没列就报遗漏或重造表行");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles a lagging event checkpoint before the first reopened append", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      await controller.appendPiEvent({ phase: "before-checkpoint-write" });
      const lagging = await controller.readState();
      expect(lagging.next_event_sequence).toBe(2);
      lagging.next_event_sequence = 1;
      await writeFile(controller.statePath, JSON.stringify(lagging), "utf8");

      const reopened = await CoverageReviewController.create(
        controller.workspace,
        controller.planFingerprint,
      );
      expect((await reopened.readState()).next_event_sequence).toBe(2);
      await reopened.appendPiEvent({ phase: "after-reopen" });
      const sequences = readFileSync(reopened.transcriptPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
      expect(sequences).toEqual([1, 2]);

      const ahead = await reopened.readState();
      ahead.next_event_sequence = 9;
      await writeFile(reopened.statePath, JSON.stringify(ahead), "utf8");
      const reopenedAhead = await CoverageReviewController.create(
        controller.workspace,
        controller.planFingerprint,
      );
      expect((await reopenedAhead.readState()).next_event_sequence).toBe(9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a coverage event transcript ends with invalid JSON", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      await controller.appendPiEvent({ phase: "durable-event" });
      const beforeState = await controller.readState();
      const malformed = `${readFileSync(controller.transcriptPath, "utf8")}{"schema_version":`;
      await writeFile(controller.transcriptPath, malformed, "utf8");

      await expect(CoverageReviewController.create(
        controller.workspace,
        controller.planFingerprint,
      )).rejects.toThrow();
      expect(readFileSync(controller.transcriptPath, "utf8")).toBe(malformed);
      expect((await controller.readState()).next_event_sequence).toBe(beforeState.next_event_sequence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads at most eight exact leaves atomically without opening their evidence", async () => {
    const { controller, plan, root } = await compactControllerFixture(9);
    try {
      const stateBefore = await controller.readState();
      const itemIds = plan.acceptance_items.slice(0, 8).map((item) => item.item_id);
      const details = await controller.dispatch("read_candidate_leaf_details", { item_ids: itemIds });
      expect(details).toMatchObject({
        ok: true,
        schema_version: "coverage-candidate-leaf-details/v1",
        requested_item_ids: itemIds,
      });
      expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect((details.details as Array<{ materialized_leaf: { item_id: string; requirement: string } }>).map((entry) =>
        entry.materialized_leaf.item_id
      )).toEqual(itemIds);
      expect((details.details as Array<{ materialized_leaf: { requirement: string } }>)[0]!.materialized_leaf.requirement)
        .toContain("长要求哨兵-1");
      const stateAfter = await controller.readState();
      expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
      expect(stateAfter.next_history_sequence).toBe(stateBefore.next_history_sequence);

      await expect(controller.dispatch("read_candidate_leaf_details", {
        item_ids: plan.acceptance_items.map((item) => item.item_id),
      })).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_detail_batch_limit",
        max_item_ids: 8,
        budget_consumed: false,
      });
      await expect(controller.dispatch("read_candidate_leaf_details", {
        item_ids: [plan.acceptance_items[0]!.item_id, "item:unknown"],
      })).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_unknown_item_ids",
        unknown_item_ids: ["item:unknown"],
        budget_consumed: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("business pages preserve all requested leaves and exact field values within the byte budget", async () => {
    const { controller, plan, root } = await compactControllerFixture(8, 80, 50);
    try {
      let pending = plan.acceptance_items.map(item => item.item_id);
      const seen: string[] = [];
      while (pending.length) {
        const page = await controller.dispatch("read_candidate_leaf_details", { item_ids: pending, view: "business" }) as any;
        expect(page.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
        expect(page.requested_item_ids.length).toBeGreaterThan(0);
        for (const detail of page.details) {
          const source = plan.acceptance_items.find(item => item.item_id === detail.item_id)!;
          expect(detail.materialized_leaf.requirement).toBe(source.requirement);
          expect(detail.allowed_bindings.length).toBeGreaterThan(0);
        }
        seen.push(...page.requested_item_ids);
        const next = page.remaining_item_ids ?? [];
        expect(next.length).toBeLessThan(pending.length);
        pending = next;
      }
      expect(seen).toEqual(plan.acceptance_items.map(item => item.item_id));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("keeps bounded reads available across saved batches and allows revisiting exact business fields", async () => {
    const { controller, plan, root } = await compactControllerFixture(32);
    try {
      const batches = Array.from({ length: 4 }, (_, b) => plan.acceptance_items.slice(b * 8, b * 8 + 8).map(i => i.item_id));
      for (const item_ids of batches) {
        const result = await controller.dispatch("read_candidate_leaf_details", { item_ids, view: "business" });
        expect(result.ok).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
        const first = (result.details as any[])[0];
        expect(first.materialized_leaf.requirement).toContain("长要求哨兵");
        expect(first).not.toHaveProperty("source_plan_item");
        expect(first.provenance_read.view).toBe("full");
      }
      expect((await controller.dispatch("read_candidate_leaf_details", { item_ids: batches[0], view: "business" })).ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });


  test("business-to-full expansion is allowed once and consumes the same bounded context allowance", async () => {
    const { controller, plan, root } = await compactControllerFixture(24);
    try {
      controller.beginFreshCoveragePhase();
      const ids = plan.acceptance_items.map(i => i.item_id);
      expect((await controller.dispatch("read_candidate_leaf_details", {item_ids: ids.slice(0, 8), view: "business"})).ok).toBe(true);
      expect((await controller.dispatch("read_candidate_leaf_details", {item_ids: ids.slice(0, 8), view: "full"})).ok).toBe(true);
      expect((await controller.dispatch("read_candidate_leaf_details", {item_ids: ids.slice(8, 16), view: "business"})).ok).toBe(true);
      expect((await controller.dispatch("read_candidate_leaf_details", {item_ids: [ids[0]], view: "full"})).error).toBe("coverage_candidate_detail_phase_budget_reached");
      expect((await controller.dispatch("read_candidate_leaf_details", {item_ids: [ids[16]], view: "business"})).error).toBe("coverage_candidate_detail_phase_budget_reached");
    } finally { await rm(root, {recursive: true, force: true}); }
  });

  test("bounds parallel live detail reads to one durable fresh-phase slice", async () => {
    const { controller, plan, root } = await compactControllerFixture(32);
    try {
      controller.beginFreshCoveragePhase();
      const batches = Array.from({ length: 4 }, (_, batch) =>
        plan.acceptance_items
          .slice(batch * 8, (batch + 1) * 8)
          .map((item) => item.item_id)
      );
      const results = await Promise.all(batches.map((itemIds) =>
        controller.dispatch("read_candidate_leaf_details", { item_ids: itemIds })
      ));
      const successful = results.filter((result) => result.ok === true);
      const blocked = results.filter((result) => result.error === "coverage_candidate_detail_phase_budget_reached");
      expect(successful).toHaveLength(3);
      expect(successful.flatMap((result) => result.requested_item_ids as string[])).toHaveLength(24);
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({
        ok: false,
        budget_consumed: false,
        max_unique_item_ids_per_fresh_phase: 24,
        remaining_item_capacity: 0,
        required_action: "stage_coverage_review_draft",
      });
      expect(blocked[0]).not.toHaveProperty("details");

      const alreadyRead = (successful[0]!.requested_item_ids as string[])[0]!;
      await expect(controller.dispatch("read_candidate_leaf_details", {
        item_ids: [alreadyRead],
      })).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_detail_phase_budget_reached",
        already_read_item_ids: [alreadyRead],
      });

      const unserved = (blocked[0]!.requested_item_ids as string[])[0]!;
      controller.beginFreshCoveragePhase();
      await expect(controller.dispatch("read_candidate_leaf_details", {
        item_ids: [unserved],
      })).resolves.toMatchObject({
        ok: true,
        requested_item_ids: [unserved],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("compacts an oversized multi-leaf batch without truncating it", async () => {
    const { controller, plan, root } = await compactControllerFixture(2, 3_000);
    try {
      const itemIds = plan.acceptance_items.map((item) => item.item_id);
      const compact = await controller.dispatch("read_candidate_leaf_details", { item_ids: itemIds });
      expect(compact).toMatchObject({
        ok: true,
        schema_version: "coverage-candidate-leaf-details/v2",
        requested_item_ids: itemIds,
      });
      expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect(compact.text_registry).toEqual(expect.arrayContaining([
        expect.objectContaining({ text_ref: expect.stringMatching(/^text:[a-f0-9]{64}$/u) }),
      ]));
      const split = await controller.dispatch("read_candidate_leaf_details", { item_ids: [itemIds[0]!] });
      expect(split).toMatchObject({ ok: true, requested_item_ids: [itemIds[0]] });
      expect((split.details as Array<{ materialized_leaf: { requirement: string } }>)[0]!.materialized_leaf.requirement)
        .toBe(plan.acceptance_items[0]!.requirement);
      expect(Buffer.byteLength(JSON.stringify(split), "utf8")).toBeLessThanOrEqual(128 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves an oversized single leaf through deduplicated exact text pages", async () => {
    const { controller, plan, root } = await compactControllerFixture(1, 8_000);
    try {
      const itemId = plan.acceptance_items[0]!.item_id;
      const stateBefore = await controller.readState();
      const details = await controller.dispatch("read_candidate_leaf_details", { item_ids: [itemId] });
      expect(details).toMatchObject({
        ok: true,
        schema_version: "coverage-candidate-leaf-details/v2",
        requested_item_ids: [itemId],
      });
      expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(128 * 1024);
      const detail = (details.details as Array<{
        materialized_leaf: { requirement: { $text_ref: string; sha256: string } };
      }>)[0]!;
      const textRef = detail.materialized_leaf.requirement.$text_ref;
      const registryEntry = (details.text_registry as Array<{
        text_ref: string;
        occurrence_count: number;
      }>).find((entry) => entry.text_ref === textRef);
      expect(registryEntry?.occurrence_count).toBeGreaterThan(1);

      let cursor = 0;
      let reconstructed = "";
      do {
        const page = await controller.dispatch("read_candidate_leaf_text", {
          item_id: itemId,
          text_ref: textRef,
          cursor,
          max_code_points: 2048,
        });
        expect(page).toMatchObject({
          ok: true,
          schema_version: "coverage-candidate-leaf-text/v1",
          item_id: itemId,
          text_ref: textRef,
          cursor,
        });
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
        reconstructed += String(page.text);
        const nextCursor = page.next_cursor as number | null;
        if (nextCursor === null) break;
        expect(nextCursor).toBeGreaterThan(cursor);
        cursor = nextCursor;
      } while (true);
      expect(reconstructed).toBe(plan.acceptance_items[0]!.requirement);
      expect(sha256Text(reconstructed)).toBe(detail.materialized_leaf.requirement.sha256);
      await expect(controller.dispatch("read_candidate_leaf_text", {
        item_id: itemId,
        text_ref: `text:${"f".repeat(64)}`,
      })).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_unknown_text_reference",
        budget_consumed: false,
      });
      const stateAfter = await controller.readState();
      expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
      expect(stateAfter.next_history_sequence).toBe(stateBefore.next_history_sequence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pages a structurally oversized leaf through an immutable section manifest", async () => {
    const { controller, plan, root } = await compactControllerFixture(1, 1, 300, 42);
    try {
      const itemId = plan.acceptance_items[0]!.item_id;
      const before = await controller.readDurableProgressSnapshot();
      const details = await controller.dispatch("read_candidate_leaf_details", { item_ids: [itemId] });
      expect(details).toMatchObject({
        ok: true,
        schema_version: "coverage-candidate-leaf-details/v3",
        requested_item_ids: [itemId],
      });
      expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(128 * 1024);
      const manifest = (details.details as Array<{
        mode: string;
        candidate_snapshot_id: string;
        sections: Array<{ section_ref: string; section_id: string; sha256: string }>;
      }>)[0]!;
      expect(manifest.mode).toBe("manifest");
      expect(manifest.sections).toEqual(expect.arrayContaining([
        expect.objectContaining({ section_id: "applicable_semantic_evidence" }),
      ]));
      await expect(controller.dispatch("read_candidate_leaf_section", {
        item_id: itemId,
        candidate_snapshot_id: `candidate:${"f".repeat(64)}`,
        section_ref: manifest.sections[0]!.section_ref,
      })).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_snapshot_stale",
      });
      await expect(controller.finalizeMechanicallyReady()).resolves.toMatchObject({
        ok: false,
        error: "coverage_candidate_sections_incomplete",
      });

      const queued = new Map(manifest.sections.map((section) => [section.section_ref, section]));
      const completed = new Set<string>();
      const semanticSection = manifest.sections.find((section) => section.section_id === "applicable_semantic_evidence")!;
      const semanticUnits: unknown[] = [];
      const nestedRefs = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(nestedRefs);
        if (!value || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        const own = typeof record.$section_ref === "string" ? [record.$section_ref] : [];
        return [...own, ...Object.values(record).flatMap(nestedRefs)];
      };
      while (queued.size > 0) {
        const [sectionRef, section] = queued.entries().next().value as [string, { section_ref: string; section_id: string; sha256: string }];
        queued.delete(sectionRef);
        if (completed.has(sectionRef)) continue;
        let pageToken: string | undefined;
        do {
          const page = await controller.dispatch("read_candidate_leaf_section", {
            item_id: itemId,
            candidate_snapshot_id: manifest.candidate_snapshot_id,
            section_ref: sectionRef,
            ...(pageToken ? { page_token: pageToken } : {}),
          });
          expect(page).toMatchObject({
            ok: true,
            schema_version: "coverage-candidate-leaf-section/v1",
            candidate_snapshot_id: manifest.candidate_snapshot_id,
            section_ref: sectionRef,
          });
          expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
          const units = page.units as Array<{ value: unknown }>;
          if (sectionRef === semanticSection.section_ref) semanticUnits.push(...units.map((unit) => unit.value));
          for (const nestedRef of units.flatMap((unit) => nestedRefs(unit.value))) {
            if (!completed.has(nestedRef) && !queued.has(nestedRef)) {
              queued.set(nestedRef, { section_ref: nestedRef, section_id: "nested", sha256: "" });
            }
          }
          pageToken = (page.page as { next_page_token: string | null }).next_page_token ?? undefined;
        } while (pageToken);
        completed.add(sectionRef);
      }
      expect(sha256Json(semanticUnits)).toBe(semanticSection.sha256);
      const after = await controller.readDurableProgressSnapshot();
      expect(after.progress_fingerprint).not.toBe(before.progress_fingerprint);
      await expect(controller.finalizeMechanicallyReady()).resolves.not.toMatchObject({
        error: "coverage_candidate_sections_incomplete",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recognizes only stable provider context-window 400s for fresh handoff", () => {
    expect(isProviderContextTooLargeError(
      new Error('400: {"code":"context_too_large","message":"Your input exceeds the context window of this model."}'),
    )).toBe(true);
    expect(isProviderContextTooLargeError("ETIMEDOUT: model stream was idle for 180 seconds")).toBe(false);
    expect(isProviderContextTooLargeError("429 rate limit")).toBe(false);
    expect(isProviderContextTooLargeError("400 invalid tool arguments")).toBe(false);
  });

  test("tells the reviewer that deterministic primary coverage overrides selector disposition metadata", async () => {
    const { contract, review } = await readReachableCoverageProtocols();
    expect(contract.coverage_obligations).toMatchObject({
      uncovered_primary_evidence_ids: expect.any(Array),
      handled_context_evidence_ids: expect.any(Array),
      handled_ignored_evidence_ids: expect.any(Array),
    });
    expect(review).toContain("requires_disposition=false不免除复核明确义务");
    expect(review).toContain("handled_context/ignored不重复列");
    expect(review).toContain("只有uncovered_primary名单要求新增shared_context/irrelevant或有据阻塞finding");
  });

  test("commits and seals without a separate self-review turn", () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain(TARGET_SELECTOR_PROTOCOLS.lifecycle);
    expect(ACCEPTANCE_TOOL_DESCRIPTIONS.commit_target_selector_draft).toContain("完整compiler/strict验证");
    expect(TARGET_SELECTOR_PROTOCOLS.lifecycle).toMatch(/commit.*通过后立即.*seal/s);
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("review_target_selector_draft");
    expect(TARGET_SELECTOR_PROTOCOLS.lifecycle).toContain("不新增语义审核轮次");
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain("核心质量属性");
  });

  test("classifies authored non-item parents as semantic repair rather than compiler faults", async () => {
    const { review: prompt } = await readReachableCoverageProtocols();
    expect(prompt).toContain("finding_type按来源计划到结果实际对比定责");
    expect(prompt).toContain("source_plan_item→materialized_leaf");
    expect(prompt).toMatch(/semantic_coverage_gap是模型选择本已错误.*错引用.*结果忠实继承仍归模型/s);
    expect(prompt).toMatch(/总项仅剩组织、导语或已由子项完全交付的判断时不留重复父叶/);
    expect(coverageFindingRoute([{ finding_type: "semantic_coverage_gap" }])).toBe("repair");
    expect(prompt).not.toContain("semantic_coverage_gap is reserved for defects");
  });

  test("requires concrete plan-to-result drift before reporting a compiler fault", async () => {
    const { review: prompt } = await readReachableCoverageProtocols();
    expect(prompt).toContain("compiler_materialization_defect须证明未经授权的source_plan_item→materialized_leaf变更");
    expect(prompt).toContain("reason给字段和前后精确证据");
    expect(prompt).toContain("比较不足继续查，不凭结果坏、引用或父子同存猜程序归属");
    expect(coverageFindingRoute([{ finding_type: "compiler_materialization_defect" }])).toBe("harness_defect");
  });

  test("preserves independent parent requirements and existing semantic review safeguards", async () => {
    const { review: prompt } = await readReachableCoverageProtocols();
    expect(prompt).toContain("存在独立剩余判据则保留并精确绑定");
    expect(prompt).toContain("不凭结果坏、引用或父子同存猜程序归属");
    expect(prompt).toMatch(/每个required最终叶且仅一条acceptance_item审查记录并绑定一个不可变item_id/);
    expect(prompt).toMatch(/无客观缺陷的分类\/粒度偏好用soft_classification_disagreement/);
    expect(prompt).toContain("同测量条件阈值可无损分支");
    const preservationRule = prompt.split(/[。\n]/u).find(sentence =>
      ["否定", "数值", "单位", "条件", "例外", "引用"].every(meaning => sentence.includes(meaning))
      && /保留|不得丢|不丢/u.test(sentence));
    expect(preservationRule, "a common preservation rule must protect every source meaning").toBeDefined();
    expect(prompt).toMatch(/直接或引用table_criterion均须有table_semantics和精确角色单元格来源/);
    expect(prompt).toMatch(/保留最具体适用的抽样规则/);
    expect(prompt).toContain("inspection_data_type先按业务解释产生什么数据、单个检验单元怎样判断、最终怎样评价");
    expect(prompt).toContain("不以数字、单位、表格、关键词或版式做代理");
  });

  test("makes the closing review status agree with finding ownership and severity", async () => {
    const { review: prompt } = await readReachableCoverageProtocols();
    expect(prompt).toContain("存在已证实compiler_materialization_defect则status=harness_defect");
    expect(prompt).toContain("否则有semantic_coverage_gap则repair");
    expect(prompt).toMatch(/soft_classification_disagreement.*source_glyph_review.*后二者不阻塞/s);
    expect(prompt).toContain("repair_issues是复核稿自身结构/来源/必读前提修法，不自动变成候选业务缺陷");
    expect(coverageFindingRoute([{ finding_type: "compiler_materialization_defect" }, { finding_type: "semantic_coverage_gap" }])).toBe("harness_defect");
    expect(coverageFindingRoute([{ finding_type: "source_glyph_review" }, { finding_type: "soft_classification_disagreement" }])).toBe("approved");
    expect(prompt).not.toContain("write status=repair with one exact-evidence finding per defect");
  });

  test("treats lossless merged and split representations as non-blocking without waiving real semantic defects", async () => {
    const selectorPrompt = TARGET_SELECTOR_SYSTEM_PROMPT.replace(/\s+/gu, " ");
    const { review } = await readReachableCoverageProtocols();
    const reviewPrompt = review.replace(/\s+/gu, " ");
    const sharedRule = LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE.replace(/\s+/gu, " ");

    expect(selectorPrompt).toContain(sharedRule);
    expect(reviewPrompt).toContain(sharedRule);
    expect(sharedRule).toContain("同一核心质量属性");
    expect(sharedRule).toContain("类别、方法、抽样程序及公式相容");
    expect(sharedRule).toMatch(/完整.*不重叠|完整.*互斥/);
    expect(sharedRule).toMatch(/可独立评价/);
    expect(sharedRule).toContain("不同属性、类别或不相容判定公式须分开");
    expect(reviewPrompt).toMatch(/无客观缺陷的分类\/粒度偏好用soft_classification_disagreement/);
    expect(reviewPrompt).toMatch(/条件、例外、方法、抽样绑定受影响叶，不造额外判断/);
    expect(coverageFindingRoute([{ finding_type: "soft_classification_disagreement" }])).toBe("approved");
    expect(coverageFindingRoute([{ finding_type: "semantic_coverage_gap" }])).toBe("repair");
  });

  test("exposes the ownership reminder at the model-facing finding_type field", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      const stageTool = createCoverageReviewTools(controller)
        .find((tool) => tool.name === "stage_coverage_review_draft")!;
      const schema = stageTool.parameters as unknown as {
        properties: { finding_upserts: { items: { properties: {
          finding_type: { description?: string; anyOf: Array<{ const: string }> };
        } } } };
      };
      const findingType = schema.properties.finding_upserts.items.properties.finding_type;
      expect(findingType.description).toContain("缺陷分类");
      expect(findingType.description).toContain("候选语义选择错误与已证实的计划到结果偏移");
      expect(findingType.anyOf.map((entry) => entry.const)).toEqual([
        "semantic_coverage_gap", "compiler_materialization_defect",
        "soft_classification_disagreement", "source_glyph_review",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a resolved referenced clause routed to the reviewed leaf sampling field", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const referencedClause = "一般项目80%以上检查点应符合规定";
    evidence.evidence[2]!.text = referencedClause;
    evidence.evidence[2]!.text_sha256 = sha256Text(referencedClause);
    plan.acceptance_items[0]!.reference_evidence_ids = ["atom:dependency"];
    plan.semantic_evidence = [
      ...(plan.semantic_evidence ?? []).filter((node) => node.semantic_id !== "semantic:2"),
      {
        semantic_id: "semantic:reference-anchor",
        role: "reference_anchor",
        evidence_id: "atom:primary-used",
        exact_fragment: "承载力应符合设计要求",
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "The item cites a shared acceptance rule.",
      },
      {
        semantic_id: "semantic:referenced-clause",
        role: "referenced_clause",
        evidence_id: "atom:dependency",
        exact_fragment: referencedClause,
        parent_semantic_id: "semantic:reference-anchor",
        materialized_item_id: "",
        reason: "The resolved clause supplies the cited acceptance rule.",
      },
    ];
    plan.semantic_references = [{
      expansion_id: "reference:acceptance-rule",
      anchor_semantic_id: "semantic:reference-anchor",
      status: "resolved",
      import_scope: { mode: "field_specific", allowed_fields: ["sampling"], reason: "引用仅导入抽样规则。" },
      target_semantic_ids: ["semantic:referenced-clause"],
      destination_bindings: [{ item_id: "item:1", fields: ["sampling"] }],
      reason: "Route the cited rule to the leaf sampling semantics.",
    }];
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [
          { evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
          { evidence_id: "atom:dependency", exact_fragment: referencedClause },
        ],
        reason: "The final leaf retains its resolved acceptance rule.",
      }],
      findings: [],
      summary: "Resolved reference provenance is reviewed on its receiving leaf.",
    };

    expect(validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used", "atom:dependency"]),
      plan,
      {
        mode: "repair_delta",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:dependency"],
        finding_ids: ["finding:acceptance-rule"],
      },
    ).issues).toEqual([]);
  });

  test("delta scope includes every final leaf added by a semantic repair", () => {
    const { evidence, plan: sourcePlan } = fixture();
    const unaffectedItem = {
      ...structuredClone(sourcePlan.acceptance_items[0]!),
      item_id: "item:unaffected",
    };
    sourcePlan.inspection_lots[0]!.item_ids.push(unaffectedItem.item_id);
    sourcePlan.acceptance_items.push(unaffectedItem);
    const repairedPlan = structuredClone(sourcePlan);
    const replacementFields = {
      name: "设备校核",
      requirement: "施工前应校核设备",
      method: "",
      quantity: "",
      note: "",
    };
    repairedPlan.inspection_lots[0]!.item_ids.push("item:2");
    repairedPlan.acceptance_items.push({
      ...structuredClone(sourcePlan.acceptance_items[0]!),
      item_id: "item:2",
      ...replacementFields,
      evidence_ids: ["atom:primary-uncovered"],
      reference_evidence_ids: [],
      field_bindings: buildItemFieldBindings(
        replacementFields,
        ["atom:primary-uncovered"],
        evidence,
      ),
    });

    const scope = deriveCoverageRepairRecheckScope(
      evidence,
      sourcePlan,
      repairedPlan,
      {
        mode: "repair_delta",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:primary-used"],
        finding_ids: ["finding:split"],
      },
    );

    expect(scope.affected_item_ids).toEqual(["item:1", "item:2"]);
    expect(scope.affected_item_ids).not.toContain(unaffectedItem.item_id);
    expect(scope.affected_evidence_ids).toEqual(expect.arrayContaining([
      "atom:primary-used",
      "atom:primary-uncovered",
    ]));
    expect(coverageReviewObligations(evidence, repairedPlan, scope).required_item_ids)
      .toEqual(["item:1", "item:2"]);
  });

  test("requires one record per final leaf plus only uncovered primary content", () => {
    const { evidence, plan } = fixture();
    const obligations = coverageReviewObligations(evidence, plan);
    expect(obligations.required_item_ids).toEqual(["item:1"]);
    expect(obligations.uncovered_primary_evidence_ids).toEqual(["atom:primary-uncovered"]);
    expect(obligations.review_record_count).toBe(2);
    expect(obligations.searchable_evidence_count).toBe(4);
  });

  test("compiled context and ignored dispositions are handled coverage, not uncovered primary", () => {
    const { evidence, plan } = fixture();
    plan.evidence_dispositions = plan.evidence_dispositions.filter(
      (row) => row.evidence_id !== "atom:primary-uncovered",
    );
    expect(coverageReviewObligations(evidence, plan).uncovered_primary_evidence_ids)
      .toEqual(["atom:primary-uncovered"]);

    plan.evidence_dispositions.push({
      evidence_id: "atom:primary-uncovered",
      disposition: "context",
      item_ids: [],
      reason: "施工前过程检验，不当最终验收叶。",
    });
    const withContext = coverageReviewObligations(evidence, plan);
    expect(withContext.uncovered_primary_evidence_ids).toEqual([]);
    expect(withContext.handled_context_evidence_ids).toEqual(["atom:primary-uncovered"]);
    expect(withContext.handled_ignored_evidence_ids).toEqual([]);
    expect(withContext.review_record_count).toBe(1);

    plan.evidence_dispositions[plan.evidence_dispositions.length - 1]!.disposition = "ignored";
    const withIgnored = coverageReviewObligations(evidence, plan);
    expect(withIgnored.uncovered_primary_evidence_ids).toEqual([]);
    expect(withIgnored.handled_context_evidence_ids).toEqual([]);
    expect(withIgnored.handled_ignored_evidence_ids).toEqual(["atom:primary-uncovered"]);
  });

  test("ledger_gap obligations stay on the listed gap clauses", () => {
    const { evidence, plan } = fixture();
    const obligations = coverageReviewObligations(evidence, plan, {
      mode: "ledger_gap",
      affected_item_ids: [],
      affected_evidence_ids: [],
      finding_ids: [],
      gap_clause_ids: ["no-such-clause"],
    });
    expect(obligations.mode).toBe("ledger_gap");
    expect(obligations.required_item_ids).toEqual([]);
  });

  test("ledger_gap also keeps explicitly affected items even without matching clauses", () => {
    const { evidence, plan } = fixture();
    const obligations = coverageReviewObligations(evidence, plan, {
      mode: "ledger_gap",
      affected_item_ids: ["item:1"],
      affected_evidence_ids: [],
      finding_ids: [],
      gap_clause_ids: ["no-such-clause"],
    });
    expect(obligations.required_item_ids).toEqual(["item:1"]);
  });

  test("risk_delta obligations contain only deterministic suspicious items and evidence", () => {
    const { evidence, plan } = fixture();
    const obligations = coverageReviewObligations(evidence, plan, {
      mode: "risk_delta",
      affected_item_ids: ["item:1"],
      affected_evidence_ids: ["atom:primary-uncovered"],
      finding_ids: [],
    });
    expect(obligations.mode).toBe("risk_delta");
    expect(obligations.required_item_ids).toEqual(["item:1"]);
    expect(obligations.uncovered_primary_evidence_ids).toEqual(["atom:primary-uncovered"]);
    expect(obligations.review_record_count).toBe(2);
  });

  test("empty risk_delta has no semantic-review obligations", () => {
    const { evidence, plan } = fixture();
    const obligations = coverageReviewObligations(evidence, plan, {
      mode: "risk_delta",
      affected_item_ids: [],
      affected_evidence_ids: [],
      finding_ids: [],
    });
    expect(obligations.required_item_ids).toEqual([]);
    expect(obligations.uncovered_primary_evidence_ids).toEqual([]);
    expect(obligations.review_record_count).toBe(0);
  });

  test("a skipped_ledger_complete summary cannot bypass required item and evidence review", () => {
    const { evidence, planFingerprint, plan } = fixture();
    const validation = validateCoverageReview({
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [],
      findings: [],
      summary: "skipped_ledger_complete",
    }, planFingerprint, evidence, undefined, plan);
    expect(validation.ok).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
  });

  test("credits a promoted source block only when it resolves uniquely inside its selected atom", () => {
    const { evidence, plan } = fixture();
    const granularEvidenceId = "evidence:primary-used-line";
    evidence.evidence.push({
      evidence_id: granularEvidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: "line:2",
      text: "承载力应符合设计要求",
      text_sha256: sha256Text("承载力应符合设计要求"),
      requires_disposition: false,
      evidence_scope: "primary",
    });

    expect(coverageReviewObligations(evidence, plan).uncovered_primary_evidence_ids)
      .not.toContain(granularEvidenceId);

    const selectedAtom = evidence.evidence.find((record) =>
      record.evidence_id === "atom:primary-used"
    )!;
    selectedAtom.text = "承载力应符合设计要求；承载力应符合设计要求";
    selectedAtom.text_sha256 = sha256Text(selectedAtom.text);
    expect(coverageReviewObligations(evidence, plan).uncovered_primary_evidence_ids)
      .toContain(granularEvidenceId);
  });

  test("one final-leaf record binds multiple exact sources while navigation stays optional", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [
        {
          coverage_id: "leaf:item:1",
          disposition: "acceptance_item",
          judgment_id: "judgment:1",
          item_ids: ["item:1"],
          evidence_bindings: [
            { evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
            { evidence_id: "atom:dependency", exact_fragment: "采用方法A检测" },
          ],
          reason: "The final leaf preserves the direct criterion and its method dependency.",
        },
        {
          coverage_id: "primary:atom:primary-uncovered",
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{ evidence_id: "atom:primary-uncovered", exact_fragment: "施工前应校核设备" }],
          reason: "This primary construction prerequisite is not an independently judged acceptance leaf.",
        },
      ],
      findings: [],
      summary: "Every final leaf and uncovered primary meaning was reviewed.",
    };
    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used", "atom:primary-uncovered", "atom:dependency"]),
      plan,
    );
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  test("delta approval does not pull an unrelated leaf from a shared evidence resource", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const unrelated = {
      ...structuredClone(plan.acceptance_items[0]!),
      item_id: "item:unrelated",
    };
    plan.acceptance_items.push(unrelated);
    plan.inspection_lots[0]!.item_ids.push(unrelated.item_id);
    plan.semantic_evidence.push({
      semantic_id: "semantic:unrelated",
      role: "acceptance_condition",
      evidence_id: "atom:primary-used",
      exact_fragment: "设计要求",
      parent_semantic_id: "",
      materialized_item_id: unrelated.item_id,
      reason: "A distinct leaf happens to use the same physical evidence resource.",
    });
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [
          { evidence_id: "atom:primary-used", exact_fragment: "承载力应符合设计要求" },
          { evidence_id: "atom:dependency", exact_fragment: "采用方法A检测" },
        ],
        reason: "Only the repaired leaf is rechecked.",
      }],
      findings: [],
      summary: "The affected final leaf remains lossless.",
    };
    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used", "atom:dependency"]),
      plan,
      {
        mode: "repair_delta",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:primary-used", "atom:dependency"],
        finding_ids: ["finding:repaired"],
      },
    );

    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  test("ledger-gap approval checks only semantic nodes carried by its required leaves", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const unrelated = {
      ...structuredClone(plan.acceptance_items[0]!),
      item_id: "item:unrelated",
    };
    plan.acceptance_items.push(unrelated);
    plan.inspection_lots[0]!.item_ids.push(unrelated.item_id);
    plan.semantic_evidence.push({
      semantic_id: "semantic:unrelated",
      role: "acceptance_condition",
      evidence_id: "atom:primary-uncovered",
      exact_fragment: "施工前应校核设备",
      parent_semantic_id: "",
      materialized_item_id: unrelated.item_id,
      reason: "A sibling outside the ledger-gap item list has unrelated semantic evidence.",
    });
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [{
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
        }],
        reason: "Only the deterministically affected ledger-gap leaf is reviewed.",
      }],
      findings: [],
      summary: "The affected ledger-gap leaf remains lossless.",
    };
    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used"]),
      plan,
      {
        mode: "ledger_gap",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:primary-used"],
        finding_ids: [],
        gap_clause_ids: [],
      },
    );

    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  test("rejects approval while a deterministic required-clause gap remains", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [],
      findings: [],
      summary: "No issue found.",
    };

    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(),
      plan,
      {
        mode: "risk_delta",
        affected_item_ids: [],
        affected_evidence_ids: [],
        finding_ids: [],
        gap_clause_ids: ["5.11.8"],
      },
    );

    expect(validated.ok).toBe(false);
    expect(validated.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "coverage_review_approved_with_ledger_gap" }),
    ]));
  });

  test("a reviewed final leaf mechanically covers ownerless semantic provenance it carries", () => {
    const { evidence, plan, planFingerprint } = fixture();
    plan.semantic_evidence.push({
      semantic_id: "semantic:ownerless-method",
      role: "acceptance_condition",
      evidence_id: "atom:dependency",
      exact_fragment: "采用方法A检测",
      parent_semantic_id: "",
      materialized_item_id: "",
      reason: "Shared method provenance already received by the final leaf.",
    });
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [{
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
        }],
        reason: "The final judgment and all compiled provenance are reviewed once.",
      }],
      findings: [],
      summary: "Ownerless provenance carried by the reviewed leaf is not a duplicate task.",
    };

    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used", "atom:dependency"]),
      plan,
      {
        mode: "repair_delta",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:dependency"],
        finding_ids: ["finding:method"],
      },
    );

    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  test("ownerless semantic provenance follows its carrier leaf instead of its broad atom", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const unrelated = structuredClone(plan.acceptance_items[0]!);
    unrelated.item_id = "item:unrelated";
    plan.acceptance_items.push(unrelated);
    plan.inspection_lots[0]!.item_ids.push(unrelated.item_id);
    plan.semantic_evidence.push({
      semantic_id: "semantic:ownerless-unrelated",
      role: "acceptance_condition",
      evidence_id: "atom:primary-used",
      exact_fragment: "设计要求",
      parent_semantic_id: "",
      materialized_item_id: "",
      reason: "Ownerless provenance carried by the unchanged sibling leaf.",
    });
    plan.semantic_references = [{
      expansion_id: "reference:outside-repair-delta",
      anchor_semantic_id: "semantic:1",
      status: "resolved",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用仅导入要求字段。" },
      target_semantic_ids: ["semantic:ownerless-unrelated"],
      destination_bindings: [{ item_id: unrelated.item_id, fields: ["requirement"] }],
      reason: "The ownerless node is explicitly routed only to the unchanged sibling.",
    }];
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [{
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
        }],
        reason: "Only the repaired final leaf is rechecked.",
      }],
      findings: [],
      summary: "A shared physical atom does not expand the repair delta.",
    };

    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      new Set(["atom:primary-used"]),
      plan,
      {
        mode: "repair_delta",
        affected_item_ids: ["item:1"],
        affected_evidence_ids: ["atom:primary-used"],
        finding_ids: ["finding:repaired"],
      },
    );

    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  test("rejects a missing-materialization finding contradicted by deterministic carriers", () => {
    const { evidence, plan, planFingerprint } = fixture();
    const review: DomainCoverageReview = {
      schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: evidence.evidence_fingerprint,
      status: "harness_defect",
      semantic_coverage: [{
        coverage_id: "leaf:item:1",
        disposition: "acceptance_item",
        judgment_id: "judgment:1",
        item_ids: ["item:1"],
        evidence_bindings: [{
          evidence_id: "atom:primary-used",
          exact_fragment: "承载力应符合设计要求",
        }],
        reason: "The final leaf is present.",
      }],
      findings: [{
        finding_id: "finding:false-missing",
        finding_type: "compiler_materialization_defect",
        evidence_id: "atom:dependency",
        exact_fragment: "采用方法A检测",
        affected_item_ids: [],
        description: "The method was allegedly not materialized.",
        reason: "Reviewer claim contradicted by compiled provenance.",
      }],
      summary: "Contradictory compiler finding.",
    };

    const validated = validateCoverageReview(review, planFingerprint, evidence, undefined, plan);
    expect(validated.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "coverage_review_compiler_defect_carrier_conflict",
      details: expect.objectContaining({ matched_item_ids: ["item:1"] }),
    })]));
    expect(validated.ok).toBe(false);
  });

  test("routes only semantic gaps to model repair", () => {
    expect(coverageFindingRoute([])).toBe("approved");
    expect(coverageFindingRoute([{ finding_type: "soft_classification_disagreement" }])).toBe("approved");
    expect(coverageFindingRoute([{ finding_type: "source_glyph_review" }])).toBe("approved");
    expect(coverageFindingRoute([{ finding_type: "semantic_coverage_gap" }])).toBe("repair");
    expect(coverageFindingRoute([
      { finding_type: "semantic_coverage_gap" },
      { finding_type: "source_glyph_review" },
    ])).toBe("repair");
    expect(coverageFindingRoute([
      { finding_type: "semantic_coverage_gap" },
      { finding_type: "compiler_materialization_defect" },
    ])).toBe("harness_defect");
  });

  test.runIf(existsSync(resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A8574d30d9f558dc47437e576/revisions/000003",
  )))("downgrades only a provenance-retained entity/prime display difference", () => {
    const root = resolve(
      "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A8574d30d9f558dc47437e576/revisions/000003",
    );
    const fingerprint = "e3e04f74166d8dae2d76595899d2493afad30e31f4187ff72434b838369619eb";
    const evidence = JSON.parse(readFileSync(resolve(root, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const plan = JSON.parse(readFileSync(resolve(root, "last-valid.semantic-source-plan.json"), "utf8")) as SemanticSourcePlan;
    const review = JSON.parse(readFileSync(resolve(
      root,
      "coverage-review",
      fingerprint,
      "coverage-review.json",
    ), "utf8")) as DomainCoverageReview;

    const validated = validateCoverageReview(review, fingerprint, evidence, undefined, plan);
    expect(validated).toMatchObject({
      ok: true,
      review: {
        status: "repair",
        findings: expect.arrayContaining([expect.objectContaining({
          finding_id: "finding:table722-garbled-semantics",
          finding_type: "source_glyph_review",
          exact_fragment: "-30&#x27;且不大于0.3mm",
        })]),
      },
    });

    const reviewWithoutProvenance = structuredClone(review);
    const glyphFinding = reviewWithoutProvenance.findings.find((finding) =>
      finding.finding_id === "finding:table722-garbled-semantics"
    )!;
    glyphFinding.affected_item_ids = [reviewWithoutProvenance.semantic_coverage
      .flatMap((row) => row.item_ids)
      .find((itemId) => !glyphFinding.affected_item_ids.includes(itemId))!];
    const withoutProvenance = validateCoverageReview(
      reviewWithoutProvenance,
      fingerprint,
      evidence,
      undefined,
      plan,
    );
    expect(withoutProvenance).toMatchObject({
      ok: true,
      review: {
        status: "harness_defect",
        findings: expect.arrayContaining([expect.objectContaining({
          finding_id: "finding:table722-garbled-semantics",
          finding_type: "compiler_materialization_defect",
        })]),
      },
    });
  });

  test.runIf(existsSync(resolve(
    "data/selector-regression/selector-regression-2026-08-11T09-26-40-046Z-fc0e162a/artifacts/jobs/selector-regression-2026-08-11T09-26-40-046Z-fc0e162a-gb50202/targets/t-f-5-5/revisions/000001",
  )))("replays the sealed GB50202 target as 14 leaves with compiled context already handled", () => {
    const root = resolve(
      "data/selector-regression/selector-regression-2026-08-11T09-26-40-046Z-fc0e162a/artifacts/jobs/selector-regression-2026-08-11T09-26-40-046Z-fc0e162a-gb50202/targets/t-f-5-5/revisions/000001",
    );
    const evidence = JSON.parse(readFileSync(resolve(root, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const plan = JSON.parse(readFileSync(resolve(root, "last-valid.semantic-source-plan.json"), "utf8")) as SemanticSourcePlan;
    const planFingerprint = "7cc296caedf13596aca2d77d72a9347a62ecf5dc69d9f9c5c996d8a2898d5e3f";
    const legacyReview = JSON.parse(readFileSync(resolve(
      root,
      `coverage-review/${planFingerprint}/coverage-review.json`,
    ), "utf8"));
    const obligations = coverageReviewObligations(evidence, plan);
    expect(obligations.required_item_ids).toHaveLength(14);
    expect(obligations.uncovered_primary_evidence_ids).toEqual([]);
    expect(obligations.review_record_count).toBe(14);
    expect(obligations.handled_context_evidence_ids.length + obligations.handled_ignored_evidence_ids.length)
      .toBeGreaterThan(0);
    const migrated = migrateCoverageReview(legacyReview);
    const validation = validateCoverageReview(migrated, planFingerprint, evidence, undefined, plan);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});


describe("independent original document investigation", () => {
  test("a stale controller terminates before readiness checks or a provider session", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    const staleFingerprint = controller.planFingerprint;
    const currentFingerprint = staleFingerprint === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const providerSession = vi.fn(async () => {
      throw new Error("provider session must not start for a stale coverage controller");
    });
    try {
      const state = await controller.workspace.readState();
      const durablePlanSha256 = state.last_valid_plan_sha256;
      const durablePlanSource = await readFile(controller.workspace.lastValidPlanPath, "utf8");
      const durableEvidence = await controller.workspace.readEvidenceManifest();
      const durableViews = validateSemanticPlanViews(
        durablePlanSource,
        durableEvidence,
        { expected_fingerprint: staleFingerprint },
      );
      expect(durableViews.ok).toBe(true);
      if (!durableViews.ok) throw new Error("test fixture lacks a valid durable candidate");
      await writeFile(controller.workspace.workingPlanPath, durablePlanSource, "utf8");
      await writeFile(controller.workspace.validationReceiptPath, JSON.stringify({
        schema_version: "validation-receipt/v1",
        ok: true,
        evidence_fingerprint: durableEvidence.evidence_fingerprint,
        validation_fingerprint: staleFingerprint,
        plan_sha256: durableViews.value.plan_sha256,
        validator: durableViews.value.validator,
      }), "utf8");
      state.last_valid_fingerprint = currentFingerprint;
      state.last_valid_plan_sha256 = "c".repeat(64);
      await controller.workspace.writeState(state);

      await expect(controller.finalizeMechanicallyReady()).resolves.toMatchObject({
        ok: false,
        error: "coverage_review_candidate_changed",
        terminal: true,
        budget_consumed: false,
        control_kind: "coverage_controller_rebuild",
        stale_plan_fingerprint: staleFingerprint,
        current_plan_fingerprint: currentFingerprint,
      });

      await expect(runLiveCoverageReview(
        controller.workspace,
        staleFingerprint,
        undefined,
        undefined,
        undefined,
        { runSession: providerSession as never },
      )).resolves.toMatchObject({
        sealed: false,
        terminal: true,
        model: "coverage-controller-stale",
        error: "coverage_review_candidate_changed",
        control: {
          kind: "coverage_controller_rebuild",
          stale_plan_fingerprint: staleFingerprint,
          current_plan_fingerprint: currentFingerprint,
        },
      });
      expect(providerSession).toHaveBeenCalledTimes(0);

      const stableFingerprintInvalidPlan = await controller.workspace.readState();
      stableFingerprintInvalidPlan.last_valid_fingerprint = staleFingerprint;
      stableFingerprintInvalidPlan.last_valid_plan_sha256 = "c".repeat(64);
      await controller.workspace.writeState(stableFingerprintInvalidPlan);
      await expect(runLiveCoverageReview(
        controller.workspace,
        staleFingerprint,
        undefined,
        undefined,
        undefined,
        { runSession: providerSession as never },
      )).resolves.toMatchObject({
        sealed: false,
        terminal: true,
        error: "coverage_review_candidate_changed",
        control: {
          kind: "coverage_controller_rebuild",
          reason: "current_candidate_not_durably_valid",
          current_plan_fingerprint: staleFingerprint,
        },
      });
      expect(providerSession).toHaveBeenCalledTimes(0);
      await expect(repairDurableCoverageCandidateCheckpoint(
        controller.workspace,
        staleFingerprint,
      )).resolves.toBe(true);
      expect((await controller.workspace.readState()).last_valid_plan_sha256)
        .toBe(durablePlanSha256);
      const rebuilt = await CoverageReviewController.create(
        controller.workspace,
        staleFingerprint,
      );
      await expect(rebuilt.currentCandidateChangeReceipt()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaf detail exposes its actual parent scope without expanding review obligations", async () => {
    const { controller, plan, root } = await compactControllerFixture(2, 1);
    try {
      const before = await controller.dispatch("get_coverage_review_contract", {}) as any;
      const reply = await controller.dispatch("read_candidate_leaf_details", { item_ids: [plan.acceptance_items[0]!.item_id] }) as any;
      const detail = reply.details[0];
      expect(detail?.parent_lot).toMatchObject({ lot_id: plan.inspection_lots[0]!.lot_id, name: plan.inspection_lots[0]!.name, evidence_ids: plan.inspection_lots[0]!.evidence_ids });
      expect((await controller.dispatch("get_coverage_review_contract", {}) as any).coverage_obligations).toEqual(before.coverage_obligations);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source investigation covers all scoped fields without adding coverage obligations", async () => {
    const { controller, root } = await compactControllerFixture(2, 1);
    try {
      const contract = await controller.dispatch("get_coverage_review_contract", {}) as any;
      expect(contract.source_investigation.scoped_item_ids).toEqual(contract.coverage_obligations.required_item_ids);
      expect(contract.source_investigation.field_checks).toEqual(["requirement", "method", "quantity/sampling", "applicability", "lot_basis"]);
      expect(contract.source_investigation.instruction).toContain("not the investigation boundary");
      expect(contract.coverage_obligations.required_item_ids).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("finds unselected rules without headings, persists observations and leaves candidate frozen", async () => {
    const { controller, root } = await compactControllerFixture(1, 1, 1, 0, "\n补充说明：本类构件每批随机检查七处。\n其他对象全部检查。");
    try {
      const before = readFileSync(controller.workspace.evidenceManifestPath, "utf8");
      const planBefore = readFileSync(controller.workspace.lastValidPlanPath, "utf8");
      const found = await controller.dispatch("search_review_document", { query: "随机检查" }) as any;
      expect(found.search_scope).toBe("entire_original_document");
      expect(found.matches.length).toBeGreaterThan(0);
      const opened = await controller.dispatch("open_review_document", { atom_id: found.matches[0].atom_id }) as any;
      expect(opened.ok).toBe(true);
      expect(opened.evidence.text).toContain("每批随机检查七处");
      expect(opened.evidence.requires_disposition).toBe(false);
      expect(opened.registered_spans.length).toBeGreaterThan(0);
      expect(readFileSync(controller.workspace.evidenceManifestPath, "utf8")).toBe(before);
      expect(readFileSync(controller.workspace.lastValidPlanPath, "utf8")).toBe(planBefore);
      const resumed = await CoverageReviewController.create(controller.workspace, controller.planFingerprint);
      expect((await resumed.dispatch("open_review_evidence", { evidence_id: opened.evidence.evidence_id })).ok).toBe(true);
      await expect(controller.workspace.adoptReferenceObservations()).rejects.toThrow("finding-bound");
      const state = await controller.workspace.readState();
      state.last_valid_fingerprint = "";
      await controller.workspace.writeState(state);
      expect((await controller.dispatch("open_review_document", { atom_id: found.matches[0].atom_id })).error).toBe("coverage_review_candidate_changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("rejects unknown atoms, bad pagination, and changed original bytes", async () => {
    const { controller, root } = await compactControllerFixture(1, 1);
    try {
      expect((await controller.dispatch("open_review_document", { atom_id: "invented" })).error).toBe("coverage_document_atom_unknown");
      expect((await controller.dispatch("search_review_document", { query: "检查", cursor: -1 })).error).toBe("coverage_document_search_invalid");
      const { chmod } = await import("node:fs/promises");
      await chmod(controller.workspace.sourceMarkdownPath, 0o644);
      await writeFile(controller.workspace.sourceMarkdownPath, "changed");
      expect((await controller.dispatch("search_review_document", { query: "changed" })).error).toBe("coverage_review_source_changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


test.each([220, 30])("coverage quote context feedback uses callable tools (%i context repeats)", async (contextRepeat) => {
  const source = fixture();
  source.plan.acceptance_items[0]!.reference_evidence_ids = [];
  source.plan.semantic_evidence = source.plan.semantic_evidence.filter(entry => entry.role === "acceptance_item");
  const quote = "虚构定位要求";
  const padding = "重复".repeat(contextRepeat);
  const record = source.evidence.evidence.find(entry => entry.evidence_id === "atom:primary-uncovered")!;
  record.text = ["甲", "乙"].map(label => label + padding + quote + padding + label).join(" | ");
  record.text_sha256 = sha256Text(record.text);
  const markdown = source.evidence.evidence.map(entry => entry.text).join("\n");
  source.evidence.source.sha256 = sha256Text(markdown);
  const root = await mkdtemp(join(tmpdir(), "coverage-long-quote-context-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, source.evidence.job_id, source.evidence.target_id, {
      manifest: source.evidence, markdown: Buffer.from(markdown),
    });
    const validation = validatePlanText(JSON.stringify(source.plan), source.evidence);
    expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
    await writeFile(workspace.lastValidPlanPath, JSON.stringify(source.plan), "utf8");
    const state = await workspace.readState();
    state.last_valid_fingerprint = validation.fingerprint!;
    state.last_valid_plan_sha256 = validation.plan_sha256!;
    await workspace.writeState(state);
    const controller = await CoverageReviewController.create(workspace, validation.fingerprint!);
    await controller.dispatch("open_review_evidence", { evidence_id: record.evidence_id });
    const registryBefore = await workspace.readSourceSpanRegistry();
    const result = await controller.dispatch("locate_review_span", { evidence_id: record.evidence_id, quote }) as any;
    expect(result).toMatchObject({ ok: false, error: "coverage_review_span_not_unique" });
    const details = result.issues[0].details;
    expect(JSON.stringify(result)).not.toContain("list_evidence_resources");
    expect(details).not.toHaveProperty("batch_next_tool");
    expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
    if (contextRepeat === 220) {
      expect(result.instruction).toContain("仍有歧义");
      expect(details).toMatchObject({ next_tool: "open_review_evidence", next_tool_arguments: { evidence_id: record.evidence_id },
        context_read: { tool: "open_review_evidence", arguments: { evidence_id: record.evidence_id } } });
      expect(Object.keys(details.context_read.arguments)).toEqual(["evidence_id"]);
      expect(details.disambiguation_candidates.every((candidate: any) => !candidate.context_unique)).toBe(true);
      expect(await controller.dispatch(details.next_tool, details.next_tool_arguments)).toMatchObject({ ok: true });
      expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
    } else {
      expect(details).toMatchObject({ next_tool: "locate_review_span" });
      expect(details.disambiguation_candidates.every((candidate: any) => candidate.context_unique)).toBe(true);
      const candidate = details.disambiguation_candidates[0];
      expect(await controller.dispatch(details.next_tool, { evidence_id: record.evidence_id, quote,
        prefix: candidate.prefix, suffix: candidate.suffix })).toMatchObject({ ok: true });
    }
    expect(await controller.dispatch("locate_review_span", { evidence_id: record.evidence_id, quote, prefix: "乙" + padding })).toMatchObject({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
