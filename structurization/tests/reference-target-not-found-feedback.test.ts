import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
  type ReferenceOccurrence,
} from "../src/contracts.js";
import { CoverageReviewController, createCoverageReviewTools } from "../src/coverage-review.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";
import {
  readInlineReferenceEvidencePage,
  readReferenceCatalog,
  readSealedReferenceFacts,
  type ReferenceAnalysisPhase,
} from "../src/reference-analysis.js";
import { initialTargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const occurrence = {
  occurrence_id: "reference:known-table",
  reference_kind: "table",
  target_table_id: "1.2.3",
  origin_evidence_id: "evidence:origin",
  origin_fields: ["requirement"],
  raw_reference: "表1.2.3",
  target_evidence_ids: ["evidence:known-target"],
  required: true,
  status: "resolved",
  depth: 1,
  path: [],
} as unknown as ReferenceOccurrence;
const knownTargetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
const receivedValue = `reference-target:${"f".repeat(64)}`;
const manifest = { reference_occurrences: [occurrence] } as unknown as EvidenceManifest;
const workspace = {} as RevisionWorkspace;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function coverageObservationFixture() {
  const originText = "1.1 中性条目关联第2章。";
  const markdown = [
    "# 1 来源",
    originText,
    "# 2 目标",
    "2.1 中性占位文本。",
    "# 3 结束",
    "3.1 中性尾部。",
  ].join("\n");
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "reference-feedback-coverage",
    target_id: "neutral-target",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "neutral.md",
      sha256: sha256Text(markdown),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: "markdown-target-scope/v1" as const,
      mode: "agent_discovered" as const,
      target_id: "neutral-target",
      source_line_count: 6,
      selected_start_line: 2,
      selected_end_exclusive_line: 3,
      selected_heading: "来源",
      selection_reason: "Neutral fixture anchor.",
      selected_atom_ids: ["evidence:origin"],
      target_evidence_fragments: [{ atom_id: "evidence:origin", text: originText }],
      candidates: [],
    },
    evidence: [{
      evidence_id: "evidence:origin",
      kind: "paragraph" as const,
      role: "supporting_clause" as const,
      locator: "line:2",
      text: originText,
      text_sha256: sha256Text(originText),
      requires_disposition: true,
      evidence_scope: "primary" as const,
    }],
    table_fragments: [],
    reference_occurrences: [],
  };
  const evidence: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const root = await mkdtemp(join(tmpdir(), "reference-feedback-coverage-"));
  roots.push(root);
  const reviewWorkspace = await RevisionWorkspace.createFromEvidence(
    root,
    evidence.job_id,
    evidence.target_id,
    { manifest: evidence, markdown: Buffer.from(markdown, "utf8") },
  );
  const originSpan = (await reviewWorkspace.readSourceSpanRegistry()).spans
    .find((span) => span.evidence_id === "evidence:origin")!.span_id;
  const selectors = initialTargetSelectorPlan(evidence);
  selectors.lots.push({
    key: "neutral-lot",
    name: "中性分组",
    scope_span_ids: [originSpan],
    reason: "中性测试分组。",
  });
  selectors.items.push({
    key: "neutral-item",
    lot_key: "neutral-lot",
    name: "中性条目",
    category: "一般项目",
    criterion_span_ids: [originSpan],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [originSpan], separator: "", reason: "中性测试名称。" },
      requirement: { composition: "verbatim", span_ids: [originSpan], separator: "", reason: "中性测试文本。" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "测试文本未包含。" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "测试文本未包含。" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "测试文本未包含。" },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "中性测试分类。",
    inspection_data_type_span_ids: [originSpan],
    sampling: {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "测试文本无抽样内容。",
      confidence: 1,
    },
    reason: "中性测试条目。",
  });
  const author = await ToolController.create(reviewWorkspace);
  expect(await author.dispatch("open_evidence", { evidence_id: "evidence:origin" })).toMatchObject({ ok: true });
  const submitted = await author.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
  const compiled = await author.dispatch("compile_target_selectors", {});
  expect(compiled).toMatchObject({ ok: true, fingerprint: expect.any(String) });
  const review = await CoverageReviewController.create(reviewWorkspace, String(compiled.fingerprint));
  const registered = await review.dispatch("resolve_document_reference", {
    origin_span_id: originSpan,
    origin_field: "requirement",
    raw_reference: "第2章",
    target: { kind: "section", number: "2" },
    relation: "neutral pointer",
  });
  expect(registered).toMatchObject({
    ok: true,
    registration_phase: "review_observation",
    candidate_evidence_unchanged: true,
    target_key: expect.any(String),
  });
  const targetKey = String(registered.target_key);
  const revisionState = await reviewWorkspace.readState();
  const policyKey = `coverage:${targetKey}`;
  const assignedPolicy = revisionState.reference_analysis_modes?.[policyKey];
  expect(assignedPolicy).toBeDefined();
  revisionState.reference_analysis_modes![policyKey] = {
    ...assignedPolicy!,
    analysis_mode: "inline",
  };
  await reviewWorkspace.writeState(revisionState);
  return { review, registered, targetKey };
}

const readers = [
  {
    name: "sealed facts",
    retryTool: "read_reference_facts",
    read: (phase: ReferenceAnalysisPhase) =>
      readSealedReferenceFacts(workspace, manifest, receivedValue, 0, 32, phase),
  },
  {
    name: "inline evidence",
    retryTool: "read_document_reference_evidence",
    read: (phase: ReferenceAnalysisPhase) =>
      readInlineReferenceEvidencePage(workspace, manifest, receivedValue, 0, 24, phase),
  },
  {
    name: "reference catalog",
    retryTool: "read_reference_facts",
    read: (phase: ReferenceAnalysisPhase) =>
      readReferenceCatalog(workspace, manifest, receivedValue, {}, phase),
  },
] as const;

describe("reference target-not-found feedback", () => {
  test.each(readers)("$name returns an executable phase-specific recovery without leaking a replacement", async ({ retryTool, read }) => {
    for (const phase of ["target", "coverage"] as const) {
      const output = await read(phase);
      const discoveryTools = phase === "coverage"
        ? ["list_coverage_reference_targets"]
        : ["list_reference_occurrences"];
      const nextToolArguments = { cursor: 0, limit: 100 };

      expect(output).toMatchObject({
        ok: false,
        error: "reference_target_not_found",
        parameter: "target_key",
        received_value: receivedValue,
        retry_tool: retryTool,
        next_tool: discoveryTools[0],
        next_tool_arguments: nextToolArguments,
        next_tools: [...discoveryTools, retryTool],
        writable_parameters: ["target_key"],
        do_not_edit: expect.any(String),
        instruction: expect.stringMatching(/[\u4e00-\u9fff]/u),
      });
      expect(output).not.toHaveProperty("target_key");
      expect(output).not.toHaveProperty("candidate");
      expect(output).not.toHaveProperty("answer");
      expect(JSON.stringify(output)).not.toContain(knownTargetKey);
      if (phase === "coverage") {
        expect(output.instruction).toMatch(/next_cursor.*raw_reference.*target_key/u);
        expect(JSON.stringify(output)).not.toContain("read_candidate");
      }
    }
  });

  test("coverage can page registered review-observation targets outside the frozen candidate", async () => {
    const { review, registered, targetKey } = await coverageObservationFixture();
    const catalogTool = createCoverageReviewTools(review)
      .find((tool) => tool.name === "list_coverage_reference_targets");
    expect(catalogTool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        cursor: { minimum: 0 },
        limit: { minimum: 1, maximum: 100 },
      },
    });
    const rejected = await review.dispatch("read_document_reference_evidence", {
      target_key: receivedValue,
      cursor: 0,
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: "reference_target_not_found",
      next_tool: "list_coverage_reference_targets",
      next_tool_arguments: { cursor: 0, limit: 100 },
      next_tools: ["list_coverage_reference_targets", "read_document_reference_evidence"],
    });

    const inventory = await review.dispatch("read_candidate_plan", { cursor: 0 });
    const leaves = inventory.leaves as Array<{ item_id: string }>;
    expect(inventory.ok).toBe(true);
    expect(leaves.length).toBeGreaterThan(0);
    const details = await review.dispatch("read_candidate_leaf_details", {
      item_ids: leaves.map((leaf) => leaf.item_id),
      view: "full",
    });
    expect(details.ok).toBe(true);
    expect(JSON.stringify([inventory, details])).not.toContain(targetKey);

    const documentPages: unknown[] = [];
    let documentCursor: number | null = 0;
    do {
      const page = await review.dispatch("search_review_document", { cursor: documentCursor }) as {
        ok: boolean;
        next_cursor: number | null;
      };
      expect(page.ok).toBe(true);
      documentPages.push(page);
      documentCursor = page.next_cursor;
    } while (documentCursor !== null);
    expect(JSON.stringify(documentPages)).not.toContain(targetKey);

    expect(await review.dispatch("get_coverage_review_contract", {})).toMatchObject({
      ok: true,
      reference_target_catalog_tool: "list_coverage_reference_targets",
    });
    expect(await review.dispatch("list_coverage_reference_targets", { cursor: -1, limit: 100 })).toMatchObject({
      ok: false,
      error: "coverage_reference_target_catalog_cursor_invalid",
      parameter: "cursor",
      received_value: -1,
      next_tool: "list_coverage_reference_targets",
      next_tool_arguments: { cursor: 0, limit: 100 },
      writable_parameters: ["cursor"],
      instruction: expect.stringMatching(/[\u4e00-\u9fff]/u),
    });
    expect(await review.dispatch("list_coverage_reference_targets", { cursor: 0, limit: 0 })).toMatchObject({
      ok: false,
      error: "coverage_reference_target_catalog_limit_invalid",
      parameter: "limit",
      received_value: 0,
      next_tool: "list_coverage_reference_targets",
      next_tool_arguments: { cursor: 0, limit: 100 },
      writable_parameters: ["limit"],
      instruction: expect.stringMatching(/[\u4e00-\u9fff]/u),
    });

    const catalog = await review.dispatch("list_coverage_reference_targets", {
      cursor: 0,
      limit: 100,
    });
    expect(catalog, JSON.stringify(catalog)).toMatchObject({
      ok: true,
      schema_version: "coverage-reference-target-catalog/v1",
      cursor: 0,
      targets: expect.arrayContaining([expect.objectContaining({
        occurrence_id: registered.occurrence_id,
        raw_reference: "第2章",
        normalized_reference: "第2章",
        target_key: targetKey,
        target_locator: expect.any(String),
        registration_phase: "review_observation",
        analysis_mode: "inline",
        read_tool: "read_document_reference_evidence",
        tool_arguments: { target_key: targetKey },
      })]),
      next_cursor: null,
    });
    expect(JSON.stringify(catalog)).not.toContain("中性占位文本");
    expect(catalog).not.toHaveProperty("total_target_count");
  });
});
