import { describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { prettyJson, sha256Text } from "../src/canonical.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { sealedWorkspaceSatisfiesCurrentContract } from "../src/batch.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  UNLABELED_ITEM_CATEGORY,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import {
  acceptanceItemNameShapeIssues,
  compileTargetSelectors as compileTargetSelectorsPersisted,
  initialTargetSelectorPlan,
  migrateTargetSelectorPlan,
  migrateTargetSelectorPlanForAuthoring,
  TARGET_SELECTOR_DRAFT_JSON_SCHEMA,
  TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA,
  TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA,
  TARGET_SELECTOR_PLAN_JSON_SCHEMA,
  TargetSelectorCompileError,
  targetSelectorFingerprint,
  targetSelectorSchemaIssues,
  targetSelectorReferenceCycleIssues,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  compileTargetSelectorsWithContext,
  createSelectorCompilerContext,
  selectorCompilerContextFingerprint,
  validatedSelectorCompilerContext,
  type SelectorCompilerContext,
} from "../src/selector-compiler-context.js";
import {
  htmlTableCellSpans,
  locateAndRegisterSourceQuote,
  registerHtmlTableCellSpans,
  registerSourceSpan,
  renderedTableCellSpans,
  tableEvidenceCellSpans,
  registryWithFullSourceSpans,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import { validatePlanText } from "../src/validator.js";
import { materialize } from "../src/materializer.js";
import {
  actionableSelectorIssue,
  compareTargetSelectorPreflightScore,
  createPiTools,
  selectorIssueToolPage,
  SAME_AGENT_SELF_REVIEW_PROTOCOL,
  ToolController,
} from "../src/tools.js";
import {
  CoverageReviewController,
  type SemanticCoverageDisposition,
} from "../src/coverage-review.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import { semanticItemIdForSelectorKey } from "../src/semantic-decision-compiler.js";
import {
  COVERAGE_REVIEW_SYSTEM_PROMPT,
  SelectorCompletedPreflightHandoff,
  SYSTEM_PROMPT,
  TARGET_SELECTOR_SYSTEM_PROMPT,
} from "../src/pi-runtime.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { semanticReferenceEvidenceIdsForDestination, validateSemanticDraft } from "../src/semantic-draft.js";
import { hydrateSemanticSourcePlan, PlanHydrationError } from "../src/plan-hydration.js";
import { applyRepeatedVerdictNamePolicy, classifySelectorIssue, classifyStrictSelectorIssues } from "../src/selector-issue-ownership.js";
import { initialTableStructurePlan } from "../src/table-structure.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { STRUCTURAL_VALIDATION_BOUNDARY } from "../src/validation-boundary.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { SAMPLING_COMPLETE_SPAN_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE, SELECTOR_PATCH_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE } from "../src/acceptance-delivery-contract.js";

function compileTargetSelectors(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): SemanticSourcePlan {
  const hydrated = hydrateSemanticSourcePlan(
    compileTargetSelectorsPersisted(selectors, registry, manifest),
    manifest,
  );
  // Most of this legacy regression file asserts the pre-v8 runtime view. v8
  // component persistence/materialization is covered independently.
  hydrated.acceptance_items.forEach((item) => {
    item.sampling.applied_branches?.forEach((branch) => { delete branch.components; });
  });
  hydrated.shared_sampling_rules?.forEach((rule) => {
    delete rule.components;
    rule.branches.forEach((branch) => { delete branch.components; });
  });
  return hydrated;
}

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:selector-compiler";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "selector-job",
    target_id: "target-base-layer",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-base-layer",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "全文语义选择",
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
    evidence_fingerprint: sha256Text(`evidence\0${text}`),
  };
}

function registerQuotes(manifest: EvidenceManifest, quotes: string[]): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  const source = manifest.evidence[0]!;
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [{
    source_id: source.evidence_id,
    evidence_id: source.evidence_id,
    atom_id: source.evidence_id,
    text: source.text,
  }]);
  const ids = new Map<string, string>();
  for (const quote of quotes) {
    const located = locateAndRegisterSourceQuote(registry, {
      source_id: source.evidence_id,
      evidence_id: source.evidence_id,
      atom_id: source.evidence_id,
      text: source.text,
    }, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function fixture(text = "基层表面应平整、密实。检验方法：用2m靠尺检查。"): {
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  selectors: TargetSelectorPlan;
} {
  const manifest = manifestFor(text);
  const registered = registerQuotes(manifest, [text]);
  const full = registered.ids.get(text)!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "base", name: "基层检验批", scope_span_ids: [full], reason: "同一基层验收范围" });
  selectors.items.push({
    key: "surface",
    lot_key: "base",
    name: "基层表面质量",
    category: "一般项目",
    criterion_span_ids: [full],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [full], separator: "", reason: "被检对象和质量特性" },
      requirement: { composition: "verbatim", span_ids: [full], separator: "", reason: "完整要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "最小用例不拆字段" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "靠尺产生测量结果。",
    inspection_data_type_span_ids: [full],
    sampling: {
      status: "fallback", rule_key: "", branch_keys: [],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "最小用例已核对，无可靠抽样依据", confidence: 0,
    },
    reason: "可以独立检查并判定",
  });
  return { manifest, registry: registered.registry, selectors };
}

test("joined clause replay corrects stale method candidates and literal source ownership without rewriting the checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "joined-clause-replay-"));
  try {
    const lines = ["7.3.1 中性前项应符合要求。", "检查数量：抽查2件。", "检验方法：观察。",
      "7.3.2中性后项应符合要求。", "检查数量：全数检查。", "检验方法：核对记录。"];
    const markdown = lines.join("\n");
    const { manifest, selectors } = fixture(markdown);
    const base = manifest.evidence[0]!;
    // Deliberately preserve the former preparer's missed-boundary metadata.
    manifest.evidence = lines.map((text, index) => ({ ...base, evidence_id: `atom:joined-${index}`,
      locator: `line:${index + 1}`, text, text_sha256: sha256Text(text), clause_id: "7.3.1" }));
    manifest.scope.source_line_count = 6;
    manifest.scope.selected_end_exclusive_line = 7;
    manifest.scope.primary_source_ranges = [{ start_line: 1, end_exclusive_line: 7 }];
    manifest.scope.selected_atom_ids = manifest.evidence.map(record => record.evidence_id);
    manifest.scope.target_evidence_fragments = manifest.evidence.map(record => ({ atom_id: record.evidence_id, text: record.text }));
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const spans = manifest.evidence.map(record => registry.spans.find(span => span.evidence_id === record.evidence_id)!.span_id);
    const item = selectors.items[0]!;
    selectors.lots[0]!.scope_span_ids = [spans[0]!];
    selectors.items = [0, 3].map((start, index) => {
      const row = structuredClone(item);
      row.key = `neutral-${index}`;
      row.criterion_span_ids = [spans[start]!];
      row.fields.name.span_ids = [spans[start]!];
      row.fields.requirement.span_ids = [spans[start]!];
      row.fields.method = { composition: "verbatim", span_ids: [spans[start + 2]!], separator: "", reason: "本项方法原句。" };
      row.fields.quantity = { composition: "verbatim", span_ids: [spans[start + 1]!], separator: "", reason: "本项数量原句。" };
      row.inspection_data_type_span_ids = [spans[start + 2]!];
      row.sampling = { status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [spans[start + 1]!],
        script_span_ids: [spans[start + 1]!], condition_span_ids: [], reason: "本项数量原句。", confidence: 1 };
      return row;
    });
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const cached = scanDocumentLedger(markdown.replace("7.3.2中性后项应符合要求。", "中性后项应符合要求。"), "source.md");
    cached.source_sha256 = sha256Text(markdown);
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson(cached), "utf8");
    const controller = await ToolController.create(workspace);
    const openedJoined = await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[3]!.evidence_id }) as any;
    expect(openedJoined.resource.clause_id).toBe("7.3.2");
    expect((await workspace.readEvidenceManifest()).evidence[3]!.clause_id).toBe("7.3.1");
    const context = await controller.dispatch("get_target_context", {}) as any;
    expect(context.target_scope).toMatchObject({ primary_source_ranges: [{ start_line: 1, end_exclusive_line: 7 }],
      scope_authority: { primary_source_ranges: "confirmed_scope_coordinates", end_exclusive_line: "not_included",
        selection_reason_clause_lists: "navigation_only_not_exhaustive" } });
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const beforeState = await workspace.readState();
    expect(await (controller as any).targetFieldRoleIssues(selectors)).toEqual([]);
    const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
    expect(materialize(compiled, manifest, "neutral-joined").result.inspection_lots.flatMap(lot => lot.items).map(row => row.source_clause))
      .toEqual(["7.3.1", "7.3.2"]);
    // Cross-binding still fails and points to the true first clause's method.
    const wrong = structuredClone(selectors);
    wrong.items[0]!.fields.method.span_ids = [spans[5]!];
    expect(await (controller as any).targetFieldRoleIssues(wrong)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_field_clause_line_mismatch", details: expect.objectContaining({ expected_line: 3 }) }),
    ]));
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await workspace.readState()).toEqual(beforeState);
    expect(JSON.parse(await readFile(workspace.documentLedgerPath, "utf8"))).toEqual(cached);
    // A stale-checkpoint continuation can inspect this current field error
    // before spending another inherited stage check, even without a handoff.
    await workspace.writeWorkingSelectors(prettyJson(wrong));
    await workspace.updateState(state => {
      state.selector_stage = "table";
      state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 0.5, best_issue_count: 1, consecutive_non_improvements: 3 };
    });
    const resumed = await ToolController.create(workspace);
    const stateBeforeRead = await workspace.readState();
    const draftBeforeRead = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBeforeRead = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const check = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
    const reply = await resumed.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
    expect(reply.target_scope).toMatchObject({ primary_source_ranges: [{ start_line: 1, end_exclusive_line: 7 }],
      scope_authority: { selection_reason_clause_lists: "navigation_only_not_exhaustive" } });
    expect(reply.current_source_repair).toBeNull();
    expect(reply.model_review).toMatchObject({
      blocking: false, decision_owner: "model", observations: [{ code: "selector_field_clause_line_mismatch",
        record_read: { tool: "read_target_selectors", arguments: { collection: "items", key: "neutral-0" } },
        details: { expected_line: 3, actual_clause_id: "7.3.2", owner_clause_id: "7.3.1" } }],
    });
    expect(check).not.toHaveBeenCalled();
    expect((await workspace.readState()).selector_protocol).toEqual(stateBeforeRead.selector_protocol);
    expect((await workspace.readState()).opened_evidence_ids).toEqual(stateBeforeRead.opened_evidence_ids);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBeforeRead);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBeforeRead);
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("source-grounded items without a category label", () => {
  test("preserves an unlabeled prose item through strict validation and materialization", () => {
    const prepared = fixture("构件接缝应连续。检验方法：观察检查。");
    prepared.selectors.lots[0]!.name = "构件接缝检验批";
    prepared.selectors.items[0]!.name = "构件接缝连续性";
    prepared.selectors.items[0]!.category = UNLABELED_ITEM_CATEGORY;
    prepared.selectors.items[0]!.reason = "正文、所在标题和上位分组均未标明项目类别；无适用索引或引用分类。";

    const compiled = compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    expect(compiled.acceptance_items[0]!.category).toBe(UNLABELED_ITEM_CATEGORY);
    expect(validatePlanText(prettyJson(compiled), prepared.manifest)).toMatchObject({ ok: true, issues: [] });
    expect(materialize(compiled, prepared.manifest, "unlabeled-category").result.inspection_lots[0]!.items[0]!.category)
      .toBe(UNLABELED_ITEM_CATEGORY);
  });

  test("keeps an unlabeled item's explicit quantity scoped to that item", () => {
    const criterion = "构件接缝应连续。";
    const quantity = "检查数量：全数检查。";
    const text = `${criterion}${quantity}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, criterion, quantity]);
    const selectors = fixture(text).selectors;
    const criterionSpanId = registered.ids.get(criterion)!;
    const quantitySpanId = registered.ids.get(quantity)!;
    selectors.lots[0]!.scope_span_ids = [criterionSpanId];
    const item = selectors.items[0]!;
    selectors.lots[0]!.name = "构件接缝检验批";
    item.name = "构件接缝连续性";
    item.category = UNLABELED_ITEM_CATEGORY;
    item.criterion_span_ids = [criterionSpanId];
    item.fields.name.span_ids = [criterionSpanId];
    item.fields.requirement.span_ids = [criterionSpanId];
    item.fields.quantity = {
      composition: "verbatim", span_ids: [quantitySpanId], separator: "", reason: "本项检查数量原文",
    };
    item.inspection_data_type_span_ids = [criterionSpanId];
    item.sampling = {
      status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [quantitySpanId],
      script_span_ids: [quantitySpanId], condition_span_ids: [], reason: "本项数量直接规定", confidence: 1,
    };

    const compiled = compileTargetSelectorsPersisted(selectors, registered.registry, manifest);
    expect(compiled.acceptance_items[0]!.category).toBe(UNLABELED_ITEM_CATEGORY);
    expect(compiled.shared_sampling_rules?.[0]?.branches[0]?.applies_to_category).toBe("all_items");
    expect(compiled.shared_sampling_rules?.[0]?.receiving_item_ids).toEqual([compiled.acceptance_items[0]!.item_id]);
  });
});

describe("reference target span feedback", () => {
  test("missing receipt permits source-grounded receiving items before the reference is saved", () => {
    const { manifest, registry, selectors } = fixture("构件检验应符合附录 R 的规定。");
    const source = manifest.evidence[0]!;
    const originSpanId = registry.spans.find((span) => span.evidence_id === source.evidence_id
      && span.start === 0 && span.end === source.text.length)!.span_id;
    manifest.reference_occurrences.push({
      occurrence_id: "reference:neutral-appendix-r",
      origin_evidence_id: source.evidence_id,
      origin_span_id: originSpanId,
      reference_literal_span_id: originSpanId,
      origin_fields: ["requirement"],
      raw_reference: "附录 R",
      target_evidence_ids: ["atom:neutral-appendix-r"],
      required: true,
      status: "resolved",
      depth: 1,
      path: ["source:appendix:R"],
      reference_kind: "clause",
      target_address: { source_id: "source", locator_kind: "appendix", locator: "appendix:R" },
    });
    selectors.items = [];
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected a missing reference receipt issue");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find((row) =>
        row.code === "selector_registered_reference_receipt_missing");
      expect(issue?.details).toMatchObject({
        writable_paths: ["/items", "/references"],
        candidate_read_tools: expect.arrayContaining([
          "list_reference_occurrences", "read_target_selectors",
          "read_document_reference_evidence", "read_reference_facts",
        ]),
        next_tool: "list_reference_occurrences",
        save_tool: "stage_target_selector_draft",
        save_tool_instruction: expect.stringContaining("draft.items"),
        how_to_pass: expect.stringContaining("先按原文补齐 draft.items"),
      });
      expect(String(issue?.details?.how_to_pass).length).toBeLessThanOrEqual(420);
      expect(actionableSelectorIssue(classifySelectorIssue("selector-local", issue!))).toMatchObject({
        writable_paths: ["/items", "/references"],
        next_tool: "list_reference_occurrences",
        save_tool: "stage_target_selector_draft",
      });
    }
  });

  function missingTargetSpansIssue(status: "resolved" | "ambiguous") {
    const { manifest, registry, selectors } = fixture("构件检验应符合附录 R 的规定。");
    const source = manifest.evidence[0]!;
    const originSpanId = registry.spans.find((span) => span.evidence_id === source.evidence_id
      && span.start === 0 && span.end === source.text.length)!.span_id;
    const targetEvidenceId = "atom:neutral-appendix-r";
    manifest.evidence.push({
      ...source,
      evidence_id: targetEvidenceId,
      text: "附录 R 构件检验要求。",
      text_sha256: sha256Text("附录 R 构件检验要求。"),
      evidence_scope: "reference",
      requires_disposition: false,
      registered_dependency: true,
    });
    manifest.reference_occurrences.push({
      occurrence_id: "reference:neutral-appendix-r",
      origin_evidence_id: source.evidence_id,
      origin_span_id: originSpanId,
      reference_literal_span_id: originSpanId,
      origin_fields: ["requirement"],
      raw_reference: "附录 R",
      target_evidence_ids: status === "resolved" ? [targetEvidenceId] : [],
      required: true,
      status,
      depth: 1,
      path: ["source:appendix:R"],
      reference_kind: "clause",
      target_address: { source_id: "source", locator_kind: "appendix", locator: "appendix:R" },
    });
    selectors.references.push({
      key: "appendix-r",
      occurrence_id: "reference:neutral-appendix-r",
      anchor_span_ids: [originSpanId],
      target_span_ids: [],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "按原文保留引用。" },
      destinations: [],
      reason: "待核对被引目标。",
    });
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected a missing target span issue");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      return (error as TargetSelectorCompileError).issues.find((issue) => issue.code === "selector_reference_target_required")!;
    }
  }

  test("routes an already resolved target to its registered read tools", () => {
    const issue = missingTargetSpansIssue("resolved");
    expect(issue).toMatchObject({
      path: "/references/0/target_span_ids",
      details: {
        occurrence_id: "reference:neutral-appendix-r",
        status: "resolved",
        required_action: "read_resolved_reference_target_then_bind_applicable_spans",
        next_tool: "list_reference_occurrences",
        next_tool_arguments: { cursor: 0 },
        save_tool: "stage_target_selector_draft",
      },
    });
    expect(issue.message).toContain("已解析");
    expect(JSON.stringify(issue.details)).toContain("read_document_reference_evidence");
    expect(JSON.stringify(issue.details)).toContain("read_reference_facts");
    expect(JSON.stringify(issue.details)).not.toContain("allowed_unresolved_values");
    expect(actionableSelectorIssue(classifySelectorIssue("selector-local", issue))).toMatchObject({
      next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: 0 },
      save_tool: "stage_target_selector_draft",
    });
  });

  test("keeps the resolution instruction for an unresolved target", () => {
    const issue = missingTargetSpansIssue("ambiguous");
    expect(issue.details).toMatchObject({
      required_action: expect.stringContaining("resolve_document_reference"),
      allowed_unresolved_values: {
        action: "keep_reference",
        application_mode: "reference_only",
        target_span_ids: [],
      },
    });
    expect(JSON.stringify(issue.details)).not.toContain("read_resolved_reference_target_then_bind_applicable_spans");
  });
});

describe("not_sampling requires a positive source basis", () => {
  test("rejects absence of a quantity as proof and returns an executable source-preserving repair", async () => {
    const { manifest, registry, selectors } = fixture("连接处应牢固。检验方法：核对记录。");
    selectors.items[0]!.sampling.status = "not_sampling";
    selectors.items[0]!.sampling.reason = "未单列检查数量";
    const before = structuredClone({ selectors, registry, manifest });
    let issue;
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      issue = (error as TargetSelectorCompileError).issues.find(entry => entry.code === "selector_not_sampling_basis_missing");
    }
    expect(issue).toMatchObject({
      path: "/items/0/sampling/condition_span_ids",
      details: {
        item_key: "surface",
        actual: { status: "not_sampling", condition_span_ids: [], reason: "未单列检查数量" },
        expected: { positive_source_basis_required: true },
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "surface" },
        save_tool: "stage_target_selector_draft",
      },
    });
    expect(JSON.stringify(issue)).toContain("共同规定");
    expect(JSON.stringify(issue)).toContain("reference_unspecified_quantity");
    const root = await mkdtemp(join(tmpdir(), "not-sampling-basis-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const handles = await ModelSourceHandles.open(workspace.root);
      const publicIssue = await handles.encode(issue) as any;
      const reader = createPiTools(await ToolController.create(workspace)).find(tool => tool.name === "read_target_selectors")!;
      expect(Check(reader.parameters, publicIssue.details.next_tool_arguments)).toBe(true);
      const result = await reader.execute("basis-read", publicIssue.details.next_tool_arguments, undefined as never, undefined as never);
      expect(JSON.stringify(result.content)).toContain("未单列检查数量");
      expect(JSON.stringify(publicIssue)).not.toContain(manifest.evidence[0]!.evidence_id);
    } finally {
      if (!root.startsWith(join(tmpdir(), "not-sampling-basis-"))) throw new Error("Unexpected test cleanup path");
      await rm(root, { recursive: true, force: true });
    }
    expect({ selectors, registry, manifest }).toEqual(before);
  });

  test("retains an author's source-backed non-sampling decision and leaves an unknown fallback distinct", () => {
    const text = "连接处应牢固。本项只核对资料，不采用数量抽样。";
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, "本项只核对资料，不采用数量抽样。"]);
    const item = selectors.items[0]!;
    item.sampling.status = "not_sampling";
    item.sampling.condition_span_ids = [ids.get("本项只核对资料，不采用数量抽样。")!];
    item.sampling.reason = "原文明示适用范围；理由中的待核对字样不改变作者已完成的状态";
    const before = structuredClone({ selectors, registry, manifest });
    const plan = compileTargetSelectors(selectors, registry, manifest);
    expect(plan.acceptance_items[0]!.sampling).toMatchObject({ status: "not_sampling", script: "灰显", confidence: 1,
      evidence_ids: [manifest.evidence[0]!.evidence_id], min_sampling: "" });
    expect({ selectors, registry, manifest }).toEqual(before);
    item.sampling.status = "fallback";
    item.sampling.condition_span_ids = [];
    item.sampling.reason = "完成本项和共同规定核对，仍无可靠数量抽样依据";
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.sampling)
      .toMatchObject({ status: "fallback", script: "灰显", confidence: 0, evidence_ids: [] });
    item.sampling.status = "not_sampling";
    item.sampling.condition_span_ids = ["span:unregistered-neutral-basis"];
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
  });
});

describe("unfinished sampling is an authoring state, not a final decision", () => {
  test("accepts pending drafts but reports pending and unrelated field errors together", () => {
    const { manifest, registry, selectors } = fixture();
    const item = selectors.items[0]!;
    item.sampling.status = "pending";
    item.sampling.reason = "尚未核对适用的共同规定";
    expect(targetSelectorSchemaIssues(selectors)).toEqual([]);
    expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, { draft: { items: selectors.items } })).toBe(true);
    expect(migrateTargetSelectorPlanForAuthoring(selectors).plan.items[0]!.sampling.status).toBe("pending");
    item.fields.requirement.composition = "semantic_summary";
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_fact_summary_forbidden" }),
        expect.objectContaining({ code: "selector_sampling_decision_pending", path: "/items/0/sampling/status", details: expect.objectContaining({
          item_key: item.key, actual: "pending", writable_path: "/items/0/sampling",
          writable_paths: ["/items/0/sampling", "/sampling_rules"],
          writable_collections: ["items", "sampling_rules"],
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: item.key },
          save_tool: "stage_target_selector_draft", how_to_pass: expect.stringContaining("共同规则"),
          allowed_statuses: ["explicit", "reference", "reference_unspecified_quantity", "fallback", "not_sampling"],
        }) }),
      ]),
    }));
    try { compileTargetSelectorsPersisted(selectors, registry, manifest); } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_sampling_decision_pending")!;
      expect(String(issue.details?.how_to_pass)).toContain("get_target_selector_contract.authoring_protocols.sampling");
      expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("未知工程型式不是停在 pending 的理由");
      expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("实际有据的全部条件分支");
      expect(String(issue.details?.how_to_pass)).toContain("不靠只改 status/reason");
    }
  });

  test.each(["fallback", "not_sampling"] as const)("keeps an authored final %s unchanged without classifying reason keywords", status => {
    const { manifest, registry, selectors } = fixture("连接处应牢固。本项只核对资料，不采用数量抽样。");
    selectors.items[0]!.sampling.status = status;
    if (status === "not_sampling") selectors.items[0]!.sampling.condition_span_ids = selectors.items[0]!.criterion_span_ids;
    selectors.items[0]!.sampling.reason = "测试文字含有待核对，但状态由作者显式声明，不按关键词改变决定";
    const before = structuredClone(selectors);
    const plan = compileTargetSelectors(selectors, registry, manifest);
    expect(plan.acceptance_items[0]!.sampling.status).toBe(status);
    expect(migrateTargetSelectorPlanForAuthoring(selectors).plan).toEqual(before);
    expect(selectors).toEqual(before);
  });

  test("saves and resumes pending work, gates sampling and direct commit, then seals only after author completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-pending-sampling-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const item = selectors.items[0]!;
      item.sampling.status = "pending";
      item.sampling.reason = "抽样判断尚未完成";
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {
        manifest, markdown: Buffer.from(manifest.evidence[0]!.text),
      });
      await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const staged = await controller.dispatch("stage_target_selector_draft", { draft: { lots: selectors.lots, items: [item] } });
      expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, local_validation: { ok: true } });
      const commit = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint });
      expect(commit).toMatchObject({ ok: false, error: "selector_global_preflight_failed", budget_consumed: false });
      expect(JSON.stringify(commit)).toContain("selector_sampling_decision_pending");
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");

      const malformed = structuredClone(item);
      malformed.fields.requirement.composition = "semantic_summary";
      const badSave = await controller.dispatch("stage_target_selector_draft", { draft: { items: [malformed] } });
      expect(badSave).toMatchObject({ ok: false, error: 'selector_draft_shape_invalid' });
      // Old checkpoints remain diagnosable even though new writes reject this value.
      await workspace.writeWorkingSelectors(prettyJson({ ...selectors, items: [malformed] }));
      const primaryBlocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
      expect(primaryBlocked).toMatchObject({ ok: false, error: "selector_repair_required", full_stage_check_performed: false });
      // The focused page first reports the criterion no longer carried by a
      // literal field; the complete compiler diagnostics above also cover the
      // forbidden summary composition. Neither route admits the old draft.
      expect(primaryBlocked).toMatchObject({ actual: { pending_code: "selector_criterion_not_materialized" },
        next_tool_arguments: { collection: "items", key: item.key } });
      await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" })).toMatchObject({ ok: true, stage: "sampling" });

      controller = await ToolController.create(workspace);
      const restored = await controller.dispatch("read_target_selectors", { collection: "items", key: item.key });
      expect(JSON.stringify(restored)).toContain('"status":"pending"');
      const index = await controller.dispatch("read_target_selectors", { collection: "items" });
      expect(JSON.stringify(index)).toContain('"sampling_status":"pending"');
      const unfinishedSave = await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
      expect(unfinishedSave).toMatchObject({ ok: true, draft_status: "saved_local_validation_failed", local_validation: { ok: false } });
      const blocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
      expect(blocked).toMatchObject({ ok: false, error: "selector_repair_required", full_stage_check_performed: false,
        stage_retry_accounting: { consumed: false } });
      expect(JSON.stringify(blocked)).toContain("selector_sampling_decision_pending");
      expect(await controller.dispatch("compile_target_selectors", {})).toMatchObject({ ok: false });
      expect(await controller.dispatch("seal_validated_plan", { fingerprint: staged.draft_fingerprint })).toMatchObject({ ok: false });

      item.sampling.status = "fallback";
      item.sampling.reason = "已核对本用例原文及适用范围，未规定抽样依据";
      const fixed = await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
      expect(fixed).toMatchObject({ ok: true, local_validation: { ok: true } });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" })).toMatchObject({ ok: true });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" })).toMatchObject({ ok: true });
      const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fixed.draft_fingerprint });
      expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
      expect(await controller.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint })).toMatchObject({ ok: true, status: "passed" });
      expect(existsSync(join(workspace.coverageReviewDirectory, "sealed.coverage-review.json"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});

describe("table-cell boundaries across source representations", () => {
  test("keeps detached HTML cell offsets exact and never splits unrecognized prose", () => {
    const text = '  <tr><td colspan="2">2</td><td>尺量</td></tr> ';
    const cells = tableEvidenceCellSpans({ kind: "table_row", text });
    expect(cells.map(cell => text.slice(cell.start, cell.end))).toEqual(["2", "尺量"]);
    expect(cells[0]!.start).toBe(text.indexOf(">2<") + 1);
    expect(tableEvidenceCellSpans({ kind: "paragraph", text: "A | B | C" })).toEqual([]);
    expect(tableEvidenceCellSpans({ kind: "table_row", text: "A | B | C", columns: ["x"], cells: ["A"], row_index: 1 })).toEqual([]);
  });

  test.each(["html_table", "html_row", "rendered_row", "legacy_row"] as const)("rejects row containers and accepts exact cells in %s", (format) => {
    const row = "<tr><td>涂层厚度</td><td>10mm</td><td>测厚仪</td><td></td></tr>";
    const text = format === "html_table" ? `<table>${row}</table>`
      : format === "html_row" ? row
      : format === "legacy_row" ? " | 数据行 1 | 检查项目=涂层厚度 | 允许值=10mm | 检查方法=测厚仪"
      : "涂层厚度 | 10mm | 测厚仪";
    const prepared = fixture(text);
    Object.assign(prepared.manifest.evidence[0]!, {
      kind: "table_row", role: "formal_table_row", row_index: 1,
      columns: ["检查项目", "允许值", "检查方法"], cells: ["涂层厚度", "10mm", "测厚仪"],
      ...(format === "rendered_row" ? { table_text_format: "cell_values_v1" } : {}),
    });
    const registered = registerQuotes(prepared.manifest, [text, "涂层厚度", "10mm", "测厚仪"]);
    const full = registered.ids.get(text)!;
    const value = registered.ids.get("10mm")!;
    const method = registered.ids.get("测厚仪")!;
    const item = prepared.selectors.items[0]!;
    item.fields.name.span_ids = [registered.ids.get("涂层厚度")!];
    item.fields.method = { composition: "verbatim", span_ids: [full], separator: "", reason: "完整行误作方法" };
    item.table = {
      source_kind: "direct", table_key: "coating", reference_span_ids: [], reason: "通用表格属性",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[registered.ids.get("涂层厚度")!]], column_path_span_ids: [],
        unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [full], inspection_method_span_ids: [full],
      },
    };
    const issues = () => {
      try { compileTargetSelectors(prepared.selectors, registered.registry, prepared.manifest); return []; }
      catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        return (error as TargetSelectorCompileError).issues;
      }
    };
    expect(issues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_table_role_span_crosses_cells", details: expect.objectContaining({
        actual: expect.objectContaining({ item_key: item.key, span_id: full }),
        writable_collection: "items", next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft",
        allowed_bindings: expect.arrayContaining([expect.objectContaining({ span_id: value, text: "10mm" })]),
      }) }),
    ]));
    const candidates = issues().find(issue => issue.code === "selector_table_role_span_crosses_cells")!
      .details!.allowed_bindings as Array<{ start: number; end: number }>;
    expect(candidates.every(candidate => candidate.end > candidate.start)).toBe(true);
    item.table.properties.allowed_value_span_ids = [value];
    item.table.properties.inspection_method_span_ids = [method];
    expect(issues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_table_visible_field_role_conflation" }),
    ]));
    item.fields.requirement.span_ids = [value];
    item.fields.method.span_ids = [method];
    expect(issues()).toEqual([]);
  });
});

describe("table identity is not an acceptance criterion", () => {
  test.each(["formal_table_title", "table_continuation_caption"] as const)("rejects a table-number prefix selected from %s with actionable author paths", role => {
    const prepared = fixture("续表 7.3.20");
    prepared.manifest.evidence[0]!.role = role;
    prepared.manifest.evidence[0]!.table_id = "7.3.20";
    const registered = registerQuotes(prepared.manifest, ["7.3.2"]);
    const id = registered.ids.get("7.3.2")!;
    const item = prepared.selectors.items[0]!;
    item.criterion_span_ids = [id];
    item.fields.name.span_ids = [id];
    item.fields.requirement.span_ids = [id];
    item.inspection_data_type_span_ids = [id];
    try {
      compileTargetSelectors(prepared.selectors, registered.registry, prepared.manifest);
      expect.fail("navigation-only criterion must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(issue => issue.code === "selector_table_identity_without_criterion")!;
      expect(issue.details).toMatchObject({
        actual: { item_key: item.key, bindings: [{ text: "7.3.2", source_text: "续表 7.3.20", source_role: role }] },
        writable_collection: "items", writable_paths: ["/items/0"],
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: item.key },
        save_tool: "stage_target_selector_draft",
      });
    }
  });

  test.each(["supporting_clause", "section_heading"] as const)("does not classify numeric values or OCR headings as navigation by their text (%s)", role => {
    const prepared = fixture(role === "section_heading" ? "# 检查数量：全数检查。" : "7.3.2");
    prepared.manifest.evidence[0]!.role = role;
    prepared.manifest.evidence[0]!.table_id = "7.3.2";
    expect(() => compileTargetSelectors(prepared.selectors, prepared.registry, prepared.manifest)).not.toThrow();
  });

  test("allows a navigation anchor alongside a real requirement", () => {
    const prepared = fixture("续表 7.3.20\n构件外观应完整。");
    prepared.manifest.evidence[0]!.role = "formal_table_title";
    prepared.manifest.evidence[0]!.table_id = "7.3.20";
    const registered = registerQuotes(prepared.manifest, ["7.3.20", "构件外观应完整。"]);
    const item = prepared.selectors.items[0]!;
    item.criterion_span_ids = [registered.ids.get("构件外观应完整。")!];
    item.fields.name.span_ids = [registered.ids.get("7.3.20")!];
    item.fields.requirement.span_ids = [registered.ids.get("构件外观应完整。")!];
    item.inspection_data_type_span_ids = [registered.ids.get("构件外观应完整。")!];
    expect(() => compileTargetSelectors(prepared.selectors, registered.registry, prepared.manifest)).not.toThrow();
    // An exact visible name also retains its literal table locator; a summary
    // source alone cannot stand in for that content.
    item.fields.name.composition = "verbatim";
    item.criterion_span_ids = [registered.ids.get("7.3.20")!, registered.ids.get("构件外观应完整。")!];
    expect(() => compileTargetSelectors(prepared.selectors, registered.registry, prepared.manifest)).not.toThrow();
  });
});

function reverseOrderedSelectorsWithInvalidFirstItem(): {
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  selectors: TargetSelectorPlan;
} {
  const earlierText = "较早项目应符合要求。";
  const laterText = "较晚项目应符合要求。";
  const prepared = fixture(`${earlierText}${laterText}`);
  const registered = registerQuotes(prepared.manifest, [
    prepared.manifest.evidence[0]!.text,
    earlierText,
    laterText,
  ]);
  const base = prepared.selectors.items[0]!;
  const item = (key: string, name: string, sourceText: string, lotKey: string) => {
    const spanId = registered.ids.get(sourceText)!;
    return {
      ...structuredClone(base),
      key,
      lot_key: lotKey,
      name,
      criterion_span_ids: [spanId],
      fields: {
        ...structuredClone(base.fields),
        name: { composition: "semantic_summary" as const, span_ids: [spanId], separator: "" as const, reason: "被检对象和质量特性" },
        requirement: { composition: "verbatim" as const, span_ids: [spanId], separator: "" as const, reason: "完整要求" },
      },
      inspection_data_type_span_ids: [spanId],
    };
  };
  prepared.selectors.items = [
    item("later", "较晚项目", laterText, "missing-lot"),
    item("earlier", "较早项目", earlierText, prepared.selectors.lots[0]!.key),
  ];
  return { ...prepared, registry: registered.registry };
}

function neutralSamplingTablePlaceholder(disposeRows: boolean) {
  const prepared = fixture("试件外观应完好。");
  const { manifest, selectors } = prepared;
  const origin = "抽样见表 S。";
  const rows = ["小批 | 抽查2件", "大批 | 抽查4件"];
  [origin, ...rows].forEach((text, index) => manifest.evidence.push({
    evidence_id: `neutral:sampling:${index}`, kind: index ? "table_row" : "paragraph",
    role: "context", locator: `line:${index + 2}`, text, text_sha256: sha256Text(text),
    requires_disposition: false, evidence_scope: "reference", registered_dependency: true,
    ...(index ? { table_id: "S", table_row_kind: "data" as const, cells: text.split(" | ") } : {}),
  }));
  const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint,
    manifest.evidence.map(row => ({ source_id: row.evidence_id, evidence_id: row.evidence_id, atom_id: row.evidence_id, text: row.text })));
  const span = (id: string) => registry.spans.find(row => row.evidence_id === id)!.span_id;
  const baseSpan = span(manifest.evidence[0]!.evidence_id);
  selectors.lots[0]!.scope_span_ids = [baseSpan];
  const item = selectors.items[0]!;
  item.criterion_span_ids = [baseSpan];
  item.fields.name.span_ids = [baseSpan];
  item.fields.requirement.span_ids = [baseSpan];
  item.inspection_data_type_span_ids = [baseSpan];
  item.sampling = { ...item.sampling, status: "reference", rule_key: "sampling-table", branch_keys: ["small", "large"] };
  selectors.sampling_rules = [{ key: "sampling-table", complete_span_ids: rows.map((_, i) => span(`neutral:sampling:${i + 1}`)),
    components: sharedSamplingDispositions(), branches: ["small", "large"].map((key, i) => ({
      key, applies_to_category: "all_items", components: branchSamplingComponents(key, [span(`neutral:sampling:${i + 1}`)], [], []), reason: "按原文容量选择分支",
    })), reason: "共享抽样表" }];
  manifest.reference_occurrences.push({ occurrence_id: "reference:neutral-sampling-table", origin_evidence_id: "neutral:sampling:0",
    origin_span_id: span("neutral:sampling:0"), reference_literal_span_id: span("neutral:sampling:0"),
    reference_literal: { evidence_id: "neutral:sampling:0", start: 0, end: origin.length },
    origin_fields: ["sampling"], raw_reference: origin, target_table_id: "S", target_evidence_ids: ["neutral:sampling:1", "neutral:sampling:2"],
    required: true, status: "resolved", depth: 1, path: ["table:S"], reference_kind: "table",
  });
  const targets = rows.map((_, i) => span(`neutral:sampling:${i + 1}`));
  selectors.references = [{ key: "sampling-pointer", occurrence_id: "reference:neutral-sampling-table",
    anchor_span_ids: [span("neutral:sampling:0")], target_span_ids: targets,
    action: "adopt", application_mode: "reference_placeholder", destinations: [],
    import_scope: { mode: "field_specific", allowed_fields: ["sampling"], reason: "只接收抽样来源" },
    component_dispositions: targets.map(id => ({ component_span_ids: [id], decision: "acceptance_branch", item_keys: [item.key], reason: "项目实际选用的抽样分支" })),
    reason: "抽样来源已由真实项目选用，不另造验收叶",
  }];
  if (disposeRows) selectors.source_dispositions = targets.map(id => ({ span_ids: [id], disposition: "context", reason: "该行已有抽样接收者，不是独立质量判据" }));
  return { manifest, selectors, registry };
}

test.each([false, true])("table placeholder counts selected sampling components through strict validation (context=%s)", (disposeRows) => {
  const { manifest, selectors, registry } = neutralSamplingTablePlaceholder(disposeRows);
  const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
  expect(compiled.evidence_dispositions.filter(row => row.evidence_id.startsWith("neutral:sampling:") && row.evidence_id !== "neutral:sampling:0"))
    .toEqual([expect.objectContaining({ disposition: "used" }), expect.objectContaining({ disposition: "used" })]);
  const result = validatePlanText(JSON.stringify(compiled), manifest, new Set(manifest.evidence.map(row => row.evidence_id)));
  expect(result.issues, JSON.stringify(result.issues)).toEqual([]);
});

test("table placeholder rejects an unselected sampling sibling despite the full rule envelope", () => {
  const { manifest, selectors, registry } = neutralSamplingTablePlaceholder(false);
  selectors.items[0]!.sampling.branch_keys = ["small"];
  expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrowError(expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: "selector_reference_placeholder_table_items_missing" })]),
  }));
});

test("strict table placeholder rejects unselected, mismatched or absent compiled sampling components", () => {
  const { manifest, selectors, registry } = neutralSamplingTablePlaceholder(true);
  const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
  for (const tamper of ["unselected", "wrong-rule", "absent"] as const) {
    const changed = structuredClone(compiled);
    const item = changed.acceptance_items[0]!;
    if (tamper === "unselected") item.sampling.branch_ids = [];
    else if (tamper === "wrong-rule") item.sampling.rule_ids = [];
    else item.sampling.applied_branches!.forEach(branch => branch.effective_components.forEach(component => { component.disposition = "absent"; component.source_span_ids = []; }));
    const result = validatePlanText(JSON.stringify(changed), manifest);
    expect(result.ok).toBe(false);
    // Invalid component projections fail before business coverage is evaluated.
    const code = tamper === "absent" ? "sampling_applied_components_incomplete" : "reference_placeholder_table_leaf_missing";
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  }
});

function sharedSamplingDispositions() {
  return [
    { key: "shared-applicability", role: "applicability" as const, disposition: "absent" as const, span_ids: [], reason: "无共享适用条件" },
    { key: "shared-acceptance", role: "acceptance_criterion" as const, disposition: "absent" as const, span_ids: [], reason: "无共享判定标准" },
    { key: "shared-exception", role: "exception" as const, disposition: "absent" as const, span_ids: [], reason: "无共享例外" },
    { key: "shared-note", role: "note" as const, disposition: "absent" as const, span_ids: [], reason: "无共享备注" },
  ];
}

function branchSamplingComponents(
  key: string,
  quantitySpanIds: string[],
  methodSpanIds: string[],
  conditionSpanIds: string[],
) {
  return [
    { key: `${key}:quantity`, role: "quantity" as const, disposition: quantitySpanIds.length ? "present" as const : "absent" as const, span_ids: quantitySpanIds, reason: "分支抽样数量" },
    { key: `${key}:method`, role: "method" as const, disposition: methodSpanIds.length ? "present" as const : "absent" as const, span_ids: methodSpanIds, reason: "分支执行方法" },
    { key: `${key}:condition`, role: "branch_condition" as const, disposition: conditionSpanIds.length ? "present" as const : "absent" as const, span_ids: conditionSpanIds, reason: "分支适用条件" },
  ];
}

async function sealSelectorRepairReview(
  workspace: RevisionWorkspace,
  controller: ToolController,
  planFingerprint: string,
  plan: SemanticSourcePlan,
  findingId = "finding:selector-binding",
): Promise<string> {
  const finalItems = materialize(plan, controller.evidence, planFingerprint).result.inspection_lots
    .flatMap((lot) => lot.items);
  const sourceItemById = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
  const semanticCoverage: SemanticCoverageDisposition[] = finalItems.map((item, index) => ({
    coverage_id: `coverage:selector:${index + 1}`,
    disposition: "acceptance_item",
    judgment_id: `judgment:${item.item_id}`,
    item_ids: [item.item_id],
    evidence_bindings: [{
      evidence_id: controller.evidence.evidence[0]!.evidence_id,
      exact_fragment: sourceItemById.get(item.reference_origin_item_id || item.item_id)
        ?.field_bindings.requirement.source_fragments[0]?.text
        ?? controller.evidence.evidence[0]!.text,
    }],
    reason: "The final leaf is bound to its complete authoritative source fragment.",
  }));
  const review = await CoverageReviewController.create(workspace, planFingerprint);
  for (const record of controller.evidence.evidence) {
    await review.dispatch("open_review_evidence", { evidence_id: record.evidence_id });
  }
  const staged = await review.dispatch("stage_coverage_review_draft", {
    status: "repair",
    summary: "The affected final leaf requires a selector binding change.",
    semantic_coverage_upserts: semanticCoverage,
    finding_upserts: [{
      finding_id: findingId,
      finding_type: "semantic_coverage_gap",
      evidence_id: controller.evidence.evidence[0]!.evidence_id,
      exact_fragment: controller.evidence.evidence[0]!.text,
      affected_item_ids: [finalItems[0]!.item_id],
      description: "The affected leaf does not preserve the intended exact binding.",
      reason: "A typed selector repair is required.",
    }],
  });
  expect(staged.validation).toMatchObject({ ok: true });
  expect(await review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
  return finalItems[0]!.item_id;
}

const gb50202ReplayBase = join(
  process.cwd(),
  "data",
  "selector-regression",
  "selector-regression-2026-08-11T05-49-11-068Z-63ed4c44",
  "artifacts",
  "jobs",
  "selector-regression-2026-08-11T05-49-11-068Z-63ed4c44-gb50202",
  "targets",
  "t-f-5-5",
  "revisions",
  "000001",
);

describe("target selector compiler", () => {
  test('compares table-fragment and prose records by the same physical line coordinate', () => {
    const prepared = fixture('共同来源。');
    const base = prepared.selectors.items[0]!;
    const full = prepared.manifest.evidence[0]!;
    let registry = prepared.registry;
    prepared.manifest.table_fragments.push({ fragment_id: 'table-fragment', source_order: 0, locator: 'line:90', provisional_table_id: 'T', provisional_title: '', title_candidate_evidence_ids: [], header_evidence_ids: [], row_evidence_ids: [], formal_row_evidence_ids: [], columns: [] });
    prepared.selectors.items = [90, 10, 40].map(line => {
      const record = { ...full, evidence_id: `source-${line}`, locator: `line:${line}`, text: `第${line}处独立要求。`, ...(line === 90 ? { table_fragment_id: 'table-fragment' } : {}) };
      record.text_sha256 = sha256Text(record.text);
      prepared.manifest.evidence.push(record);
      const registered = registerSourceSpan(registry, { source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text }, 0, record.text.length);
      registry = registered.registry;
      const span = registered.span.span_id;
      return { ...structuredClone(base), key: `item-${line}`, name: `对象${line}`, criterion_span_ids: [span], inspection_data_type_span_ids: [span], fields: { ...structuredClone(base.fields), name: { ...base.fields.name, span_ids: [span] }, requirement: { ...base.fields.requirement, span_ids: [span] } } };
    });
    const plan = compileTargetSelectors(prepared.selectors, registry, prepared.manifest);
    expect(plan.acceptance_items.map(item => item.name)).toEqual(['对象10', '对象40', '对象90']);
  });
  test.each([
    ["压降"], ["压降", "支路甲"], ["压降", "支路甲", "低温工况"],
  ])("preserves model-authored name paths through compact compilation and materialization: %j", (...parts) => {
    const prepared = fixture("管路压降按支路甲及低温工况的要求检查。");
    const path = parts as string[];
    prepared.selectors.items[0]!.name_path = path;
    const persisted = compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    const output = materialize(persisted, prepared.manifest, 'test-path');
    const result = output.result.inspection_lots[0]!.items[0]!;
    expect(result.name).toBe(path.join("\\"));
    expect(result.name_path).toEqual(path);
    expect(result.requirement).toBe(prepared.manifest.evidence[0]!.text);
    expect(result.category).toBe('一般项目');
    expect(output.result.inspection_lots).toHaveLength(1);
    expect(output.result.inspection_lots[0]!.items).toHaveLength(1);
    expect(result.source_anchors).toEqual([{ offset: 0, row: 0, column: 0 }]);
  });

  test('name path errors point to the authored field and give a usable repair route', () => {
    const prepared = fixture();
    prepared.selectors.items[0]!.name_path = ['基层', ' '];
    try {
      compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
      expect.fail('blank path must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(entry => entry.code === 'selector_name_path_binding');
      expect(issue?.path).toBe('/items/0/name_path');
      expect(issue?.details).toMatchObject({ next_tools: ['read_target_selectors', 'stage_target_selector_draft'] });
    }
    prepared.selectors.items[0]!.name_path = ['基层', '表面质量'];
    expect(() => compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest)).not.toThrow();
    prepared.selectors.items[0]!.name_path = ['基层\\表面'];
    expect(targetSelectorSchemaIssues(prepared.selectors).some(issue => issue.path.includes('name_path'))).toBe(true);
  });
  test("reports source-sorted compiler failures at the authoring item path", () => {
    const { manifest, registry, selectors } = reverseOrderedSelectorsWithInvalidFirstItem();
    const valid = structuredClone(selectors);
    valid.items[0]!.lot_key = valid.lots[0]!.key;
    expect(compileTargetSelectorsPersisted(valid, registry, manifest).acceptance_items.map((item) => item.name))
      .toEqual(["较早项目", "较晚项目"]);

    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected unknown lot rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issues = (error as TargetSelectorCompileError).issues;
      expect(issues).toContainEqual(expect.objectContaining({
        code: "selector_unknown_lot",
        path: "/items/0/lot_key",
      }));
      expect(issues).not.toContainEqual(expect.objectContaining({
        code: "selector_unknown_lot",
        path: "/items/1/lot_key",
      }));
    }
  });

  test("keeps source-sorted failures deferred until their authored item is touched", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-author-index-"));
    try {
      const { manifest, registry, selectors } = reverseOrderedSelectorsWithInvalidFirstItem();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      const controller = await ToolController.create(workspace);

      const unrelated = await controller.dispatch("stage_target_selector_draft", {
        draft: { items: [structuredClone(selectors.items[1]!)] },
      });
      expect(unrelated).toMatchObject({
        ok: true,
        draft_status: "saved_local_validation_passed",
        local_validation: {
          ok: true,
          touched_paths: ["/items/1"],
          issue_count: 0,
          deferred_nonlocal_issue_count: 1,
        },
      });

      const affected = await controller.dispatch("stage_target_selector_draft", {
        draft: { items: [structuredClone(selectors.items[0]!)] },
      });
      expect(affected).toMatchObject({
        ok: true,
        draft_status: "saved_local_validation_failed",
        local_validation: {
          ok: false,
          touched_paths: ["/items/0"],
          issue_count: 1,
          deferred_nonlocal_issue_count: 0,
          issues: [expect.objectContaining({
            code: "selector_unknown_lot",
            path: "/items/0/lot_key",
            actual: selectors.items[0]!.lot_key,
            record_identity: { collection: "items", key: selectors.items[0]!.key },
          })],
        },
        mutation_receipt: { status: "saved", collections: [{ collection: "items", submitted_keys: [selectors.items[0]!.key] }] },
      });
      const issue = (affected as any).local_validation.issues[0];
      const read = await controller.dispatch(issue.record_read.tool, issue.record_read.arguments) as any;
      expect(read.rows[0].key).toBe(selectors.items[0]!.key);
      read.rows[0].lot_key = selectors.lots[0]!.key;
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: read.rows } }))
        .toMatchObject({ ok: true, draft_status: "saved_local_validation_passed",
          mutation_receipt: { status: "saved", collections: [{ submitted_keys: [selectors.items[0]!.key] }] } });
      const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
      expect(saved.items[1]).toEqual(selectors.items[1]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("model short handles preserve local reads, saved canonical selectors and compiler output across reopen", { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(),"selector-short-handles-"));
    try {
      const {manifest,registry,selectors}=fixture();
      const workspace=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await writeFile(workspace.sourceSpanRegistryPath,prettyJson(registry),"utf8");
      const codec=await ModelSourceHandles.open(workspace.root);
      const tools=codec.wrapTools(createPiTools(await ToolController.create(workspace)));
      const call=async(name:string,args:Record<string,unknown>)=>{
        const result=await tools.find(t=>t.name===name)!.execute(`short-${name}`,args,undefined as any,undefined as any,undefined as any);
        expect(result.details).toMatchObject({ok:true});
        return JSON.parse((result.content[0] as {text:string}).text);
      };
      const context=await call("get_target_context",{});
      const source=context.resource_inventory[0];
      await call("open_evidence",{evidence_id:source.evidence_id,source_handle_scope:codec.scope});
      const roster=await call("read_target_selectors",{collection:"items",limit:1});
      expect(roster.view).toBe("index");
      expect(roster.rows).toHaveLength(1);
      const page=await call("read_target_selectors",{collection:"items",key:roster.rows[0].key});
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0].criterion_span_ids[0]).toMatch(/^s[0-9]+$/u);
      page.rows[0].reason="局部更新理由，保留全部来源字段。";
      page.rows[0].name_path=["基层", "表面质量"];
      await call("stage_target_selector_draft",{operation:"upsert",draft:{items:[page.rows[0]]},source_handle_scope:codec.scope});
      const saved=JSON.parse(await readFile(workspace.workingSelectorPath,"utf8"));
      const expected=structuredClone(selectors);expected.items[0]!.reason=page.rows[0].reason;
      expected.items[0]!.name_path=["基层", "表面质量"];
      expect(saved).toEqual(expected);
      expect(compileTargetSelectorsPersisted(saved,registry,manifest)).toEqual(compileTargetSelectorsPersisted(expected,registry,manifest));
      expect(await readFile(workspace.sourceMarkdownPath,"utf8")).toBe(manifest.evidence[0]!.text);
      const reopened=await ModelSourceHandles.open(workspace.root);
      expect(reopened.scope).toBe(codec.scope);
      expect(await reopened.decodeArguments({span_ids:page.rows[0].criterion_span_ids,source_handle_scope:codec.scope})).toEqual({span_ids:selectors.items[0]!.criterion_span_ids});
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");
      const inline = await call("stage_target_selector_draft", {
        source_handle_scope:codec.scope,
        quote_bindings:[{key:"$whole",evidence_id:source.evidence_id,quote:manifest.evidence[0]!.text}],
        draft:{items:[{...page.rows[0],criterion_span_ids:["$whole"]}]},
      });
      expect(inline.ok).toBe(true);
      expect(JSON.parse(await readFile(workspace.workingSelectorPath,"utf8"))).toEqual(expected);
    } finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });

  test("keeps the target assignment separate from authored lots and provisional background", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-scope-contract-"));
    try {
      const { manifest } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("get_target_context", {})).toMatchObject({
        scope_contract: { target_is_single_inspection_lot: false, preserve_in_scope_objects_and_conditions: true },
        primary_disposition_requirement: { residual_disposition_is_coverage_approval: false },
      });
      expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("一个 target 可以有多个业务检验批");
      expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("执行分片不得丢失共同上位单元的依据");
      expect(TARGET_SELECTOR_PROTOCOLS.tables).toContain("整行不复制到每个标量");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("rejects English lot and item prose for Chinese evidence while preserving short technical tokens", () => {
    const translated = fixture();
    translated.selectors.lots[0]!.name = "Incoming welding materials";
    translated.selectors.items[0]!.name = "Welding-material variety, specification and performance";
    translated.selectors.items[0]!.inspection_data_type_reason = "The inspection produces a measured result.";
    translated.selectors.items[0]!.sampling.reason = "The source does not define a sampling quantity.";
    try {
      compileTargetSelectorsPersisted(translated.selectors, translated.registry, translated.manifest);
      throw new Error("Expected source-language validation to reject translated selector prose");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/lots/0/name" }),
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/items/0/name" }),
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/items/0/inspection_data_type_reason" }),
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/items/0/sampling/reason" }),
      ]));
    }

    const technical = fixture();
    technical.selectors.lots[0]!.name = "GB 50576";
    technical.selectors.items[0]!.name = "H/1500";
    expect(() => compileTargetSelectorsPersisted(
      technical.selectors,
      technical.registry,
      technical.manifest,
    )).not.toThrow();
  });

  test("uses the Chinese criterion context when a short table-name span is language-undetermined", () => {
    const text = "咬边深度应符合表A.0.1的规定，检验方法采用焊缝量规检查。";
    const translated = fixture(text);
    const source = translated.manifest.evidence[0]!;
    const located = locateAndRegisterSourceQuote(translated.registry, {
      source_id: source.evidence_id,
      evidence_id: source.evidence_id,
      atom_id: source.evidence_id,
      text: source.text,
    }, "咬边深度");
    translated.registry = located.registry;
    translated.selectors.items[0]!.name = "Weld undercut depth";
    translated.selectors.items[0]!.fields.name.span_ids = [located.spans[0]!.span_id];
    expect(() => compileTargetSelectorsPersisted(
      translated.selectors,
      translated.registry,
      translated.manifest,
    )).toThrowError(TargetSelectorCompileError);
    try {
      compileTargetSelectorsPersisted(
        translated.selectors,
        translated.registry,
        translated.manifest,
      );
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_source_language_mismatch",
        path: "/items/0/name",
      }));
    }
  });

  test("ignores formula commands when detecting the language of a Chinese table row", () => {
    const translated = fixture(
      "咬边深度</td><td>母材 $t$ \\leqslant 10mm 时，允许偏差 $\\leqslant 0.5mm$，连续长度不大于100mm</td>",
    );
    translated.selectors.items[0]!.name = "Weld undercut depth";
    try {
      compileTargetSelectorsPersisted(
        translated.selectors,
        translated.registry,
        translated.manifest,
      );
      throw new Error("Expected a Chinese table row with formulas to reject an English display name");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_source_language_mismatch",
        path: "/items/0/name",
      }));
    }
  });

  test("requires an inherited selector checkpoint to be read before locate or stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-inherited-read-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => {
        state.lineage = {
          schema_version: "revision-lineage/v1",
          source_revision: 3,
          selector_checkpoint_revision: 3,
          registry_checkpoint_revision: 3,
          recovery_kind: "terminal_checkpoint",
        };
      });

      let controller = await ToolController.create(workspace);
      const context = await controller.dispatch("get_target_context", {});
      expect(context).toMatchObject({
        ok: true,
        current_selector_state: "inherited_existing",
        read_target_selectors_required: true,
        current_selector_summary: {
          draft_fingerprint: targetSelectorFingerprint(selectors),
          counts: {
            lots: 1,
            items: 1,
            sampling_rules: 0,
            references: 0,
            source_dispositions: 0,
          },
          lineage: {
            source_revision: 3,
            selector_checkpoint_revision: 3,
            recovery_kind: "terminal_checkpoint",
          },
        },
      });
      expect(context).not.toHaveProperty("blank_selector");
      expect(controller.selectorProviderPolicy().allowed_tools).not.toEqual(expect.arrayContaining([
        "locate_evidence_span",
        "batch_locate_evidence_spans",
        "stage_target_selector_draft",
        "advance_target_selector_stage",
      ]));

      expect(await controller.dispatch("open_evidence", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        cursor: 0,
      })).toMatchObject({ ok: true });
      const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
      const protocolBefore = (await workspace.readState()).selector_protocol;
      for (const blocked of [
        await controller.dispatch("locate_evidence_span", {
          evidence_id: manifest.evidence[0]!.evidence_id,
          quote: manifest.evidence[0]!.text,
        }),
        await controller.dispatch("batch_locate_evidence_spans", {
          requests: [{
            evidence_id: manifest.evidence[0]!.evidence_id,
            quote: manifest.evidence[0]!.text,
          }],
        }),
        await controller.dispatch("stage_target_selector_draft", {
          draft: { lots: [selectors.lots[0]!] },
        }),
        await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }),
      ]) {
        expect(blocked).toMatchObject({
          ok: false,
          error: "inherited_selector_read_required",
          current_selector_state: "inherited_existing",
          required_tool: "read_target_selectors",
          budget_consumed: false,
        });
      }
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect((await workspace.readState()).selector_protocol).toEqual(protocolBefore);

      expect(await controller.dispatch("read_target_selectors", {})).toMatchObject({
        ok: true,
        summary: { counts: { lots: 1, items: 1 } },
      });
      expect(controller.selectorStartupContext()).toMatchObject({
        current_selector_state: "inherited_existing",
        read_target_selectors_required: false,
      });
      expect(controller.selectorProviderPolicy().allowed_tools).toEqual(expect.arrayContaining([
        "locate_evidence_span",
        "stage_target_selector_draft",
      ]));
      expect(await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: manifest.evidence[0]!.text,
      })).toMatchObject({ ok: true });

      controller = await ToolController.create(workspace);
      expect(controller.selectorStartupContext()).toMatchObject({
        current_selector_state: "inherited_existing",
        read_target_selectors_required: true,
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: [selectors.lots[0]!] },
      })).toMatchObject({ ok: false, error: "inherited_selector_read_required" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("keeps a genuinely blank fresh selector revision on the normal authoring path", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-fresh-blank-"));
    try {
      const { manifest } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("get_target_context", {})).toMatchObject({
        ok: true,
        current_selector_state: "blank",
        read_target_selectors_required: false,
        blank_selector: {
          lots: [],
          items: [],
          sampling_rules: [],
          references: [],
          source_dispositions: [],
        },
      });
      expect(controller.selectorProviderPolicy().allowed_tools).toEqual(expect.arrayContaining([
        "locate_evidence_span",
        "stage_target_selector_draft",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("expands generic rowspan and colspan grid provenance without changing the selected value cell", () => {
    const text = '<table><tr><td colspan="2">项目</td><td>允许值</td></tr><tr><td rowspan="2">父项</td><td>子项甲</td><td>10</td></tr><tr><td>子项乙</td><td>20</td></tr></table>';
    const cells = htmlTableCellSpans(text);
    const child = cells.find((cell) => cell.text === "子项乙")!;
    const value = cells.find((cell) => cell.text === "20")!;
    expect(child.inherited_cell_indices.map((index) => cells[index]!.text)).toEqual(["父项"]);
    expect(value.inherited_cell_indices.map((index) => cells[index]!.text)).toEqual(["父项"]);
    expect(value.text).toBe("20");
    expect(cells.filter((cell) => cell.text === "项目")).toHaveLength(1);
  });

  test("rejects table-role spans that cross cells or adjacent table boundaries with exact registered candidates", () => {
    const text = [
      "<table><tr><td>A</td><td>1</td></tr></table>",
      "<table><tr><td>B</td><td>2</td></tr></table>",
      "<table><tr><td>C</td><td>3</td></tr></table>",
      "后续普通正文",
    ].join("\n");
    const manifest = manifestFor(text);
    const sources = manifest.evidence.map((record) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    }));
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
    registry = registerHtmlTableCellSpans(registry, sources).registry;
    const selectors = fixture(text).selectors;
    const fullSpan = registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    const cellSpan = (value: string) => {
      const cell = htmlTableCellSpans(text).find((candidate) => candidate.text === value)!;
      return registry.spans.find((span) => span.start === cell.start && span.end === cell.end)!.span_id;
    };
    selectors.lots[0]!.scope_span_ids = [fullSpan];
    selectors.items[0]!.criterion_span_ids = [fullSpan];
    selectors.items[0]!.fields.name.span_ids = [cellSpan("B")];
    selectors.items[0]!.fields.requirement.span_ids = [fullSpan];
    selectors.items[0]!.inspection_data_type_span_ids = [cellSpan("2")];
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "middle",
      properties: {
        table_no_span_ids: [fullSpan], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[cellSpan("B")]], column_path_span_ids: [], unit_span_ids: [],
        condition_span_ids: [], allowed_value_span_ids: [fullSpan], inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "The selector chooses the middle table semantically.",
    };
    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_table_role_span_crosses_cells" }),
        expect.objectContaining({ code: "selector_field_span_crosses_table_boundaries" }),
      ]));
    }
  });

  test("rejects a sampling component span that crosses multiple HTML tables", () => {
    const text = [
      "<table><tr><td>批量</td><td>抽样数</td></tr><tr><td>1~10</td><td>全部</td></tr></table>",
      "<table><tr><td>项目</td><td>允许值</td></tr><tr><td>膜厚</td><td>10</td></tr></table>",
    ].join("\n");
    const prepared = fixture(text);
    const fullSpan = prepared.registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
    prepared.selectors.sampling_rules.push({
      key: "shared-table-rule",
      complete_span_ids: [fullSpan],
      components: [
        { key: "applicability", role: "applicability", disposition: "present", span_ids: [fullSpan], reason: "适用范围" },
        { key: "acceptance", role: "acceptance_criterion", disposition: "present", span_ids: [fullSpan], reason: "判定阈值" },
        { key: "exception", role: "exception", disposition: "absent", span_ids: [], reason: "无例外" },
        { key: "note", role: "note", disposition: "absent", span_ids: [], reason: "无备注" },
      ],
      branches: [{
        key: "all-items",
        applies_to_category: "all_items",
        components: branchSamplingComponents("all-items", [fullSpan], [fullSpan], [fullSpan]),
        reason: "共同抽样分支",
      }],
      reason: "共享表格抽样规则",
    });
    prepared.selectors.items[0]!.sampling = {
      status: "reference",
      rule_key: "shared-table-rule",
      branch_keys: ["all-items"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "引用共享规则",
      confidence: 1,
    };

    expect(() => compileTargetSelectors(prepared.selectors, prepared.registry, prepared.manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_sampling_component_span_crosses_table_boundaries",
            path: "/sampling_rules/0/components/0/span_ids/0",
            details: expect.objectContaining({
              role: "applicability",
              crossed_table_count: 2,
              required_action: "locate_exact_sampling_role_spans_within_one_rule_table",
            }),
          }),
        ]),
      }) as TargetSelectorCompileError,
    );
    try {
      compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find((row) =>
        row.code === "selector_sampling_component_span_crosses_table_boundaries"
      )!;
      const issueDetails = issue.details as Record<string, any>;
      expect(issue).toMatchObject({ message: expect.stringMatching(/[\u3400-\u9fff]/u) });
      expect(issueDetails).toMatchObject({
        actual: {
          path: "/sampling_rules/0/components/0/span_ids/0",
          rule_key: "shared-table-rule",
          component_key: "applicability",
          role: "applicability",
          span_id: fullSpan,
          source: {
            source_id: prepared.manifest.evidence[0]!.evidence_id,
            evidence_id: prepared.manifest.evidence[0]!.evidence_id,
            atom_id: prepared.manifest.evidence[0]!.evidence_id,
            source_length: text.length,
            start: 0,
            end: text.length,
          },
          crossed_tables: [
            { table_index: 0, table_start: 0, table_end: expect.any(Number) },
            { table_index: 1, table_start: expect.any(Number), table_end: expect.any(Number) },
          ],
        },
        role: "applicability",
        rule_key: "shared-table-rule",
        component_key: "applicability",
        writable_collection: "sampling_rules",
        writable_collections: ["sampling_rules"],
        writable_path: "/sampling_rules/0/components/0/span_ids/0",
        writable_paths: ["/sampling_rules/0/components/0/span_ids/0"],
        candidate_read_tool: "read_target_selectors",
        candidate_read_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "open_evidence",
          "locate_evidence_span",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "sampling_rules", key: "shared-table-rule" },
        next_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
        ],
        save_tool: "stage_target_selector_draft",
        allowed_actions: [expect.stringContaining("同一条规则表")],
        how_to_pass: expect.stringContaining("不能跨表"),
        do_not_edit: expect.stringContaining("不可变原文"),
      });
      const surfaced = selectorIssueToolPage([issue]).issues[0] as Record<string, any>;
      expect(surfaced).toMatchObject({
        code: issue.code,
        path: issue.path,
        message: issue.message,
        details: {
          actual: expect.objectContaining({ path: issue.path, role: "applicability" }),
          candidate_read_tools: issueDetails.candidate_read_tools,
          next_tool: "read_target_selectors",
          next_tools: issueDetails.next_tools,
          writable_path: issueDetails.writable_path,
          writable_paths: issueDetails.writable_paths,
          how_to_pass: expect.stringContaining("不能跨表"),
        },
      });
    }
  });

  test("rejects condition and allowed-value bindings from different physical grid rows", () => {
    const text = '<table><tr><td>项目</td><td>条件</td><td>允许值</td></tr><tr><td rowspan="2">父项</td><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr></table>';
    const manifest = manifestFor(text);
    const source = {
      source_id: manifest.evidence[0]!.evidence_id,
      evidence_id: manifest.evidence[0]!.evidence_id,
      atom_id: manifest.evidence[0]!.evidence_id,
      text,
    };
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
    registry = registerHtmlTableCellSpans(registry, [source]).registry;
    const cellSpan = (value: string) => {
      const cell = htmlTableCellSpans(text).find((candidate) => candidate.text === value)!;
      return registry.spans.find((span) => span.start === cell.start && span.end === cell.end)!.span_id;
    };
    const selectors = fixture(text).selectors;
    selectors.lots[0]!.scope_span_ids = [cellSpan("父项")];
    selectors.items[0]!.criterion_span_ids = [cellSpan("父项")];
    selectors.items[0]!.fields.name.span_ids = [cellSpan("父项")];
    selectors.items[0]!.fields.requirement.span_ids = [cellSpan("10")];
    selectors.items[0]!.inspection_data_type_span_ids = [cellSpan("10")];
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "grid",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[cellSpan("父项"), cellSpan("A"), cellSpan("20")]],
        column_path_span_ids: [], unit_span_ids: [],
        condition_span_ids: [cellSpan("A")],
        allowed_value_span_ids: [cellSpan("20")],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "Typed row branch must remain mechanically row-coherent.",
    };

    try {
      compileTargetSelectors(selectors, registry, manifest);
      throw new Error("expected row-coherence rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_table_row_path_role_mismatch",
          details: expect.objectContaining({
            allowed_bindings: expect.arrayContaining([
              expect.objectContaining({ text: "10", row_index: 1 }),
            ]),
            required_action: "replace_condition_or_allowed_value_with_a_registered_cell_from_the_same_physical_grid_row",
          }),
        }),
      ]));
    }
  });

  test("allows an exact concise prose noun phrase as a verbatim name", () => {
    const prose = fixture("基层表面平整度");
    prose.selectors.items[0]!.name = "基层表面平整度";
    prose.selectors.items[0]!.fields.name = {
      composition: "verbatim",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "The source phrase is already the exact inspected characteristic.",
    };
    const compiled = compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
    expect(compiled.acceptance_items[0]!.name).toBe("基层表面平整度");
    expect(compiled.acceptance_items[0]!.requirement).toBe("基层表面平整度");
  });

  test("allows an arbitrarily long verbatim name when the registered span has only one semantic role", () => {
    const singleRolePhrase = "基层界面处理范围".repeat(80);
    const prose = fixture(singleRolePhrase);
    prose.selectors.items[0]!.name = singleRolePhrase;
    prose.selectors.items[0]!.fields.name = {
      composition: "verbatim",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Length alone is not mechanical evidence of role conflation.",
    };
    expect(compileTargetSelectors(prose.selectors, prose.registry, prose.manifest).acceptance_items[0]!.name)
      .toBe(singleRolePhrase);
  });

  test("rejects a verbatim name span that structurally contains requirement, quantity, and method roles", () => {
    const text = "基层表面平整度应符合要求。检查数量：全数检查。检验方法：用2m靠尺检查。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [
      text,
      "基层表面平整度应符合要求。",
      "检查数量：全数检查。",
      "检验方法：用2m靠尺检查。",
    ]);
    const selectors = fixture(text).selectors;
    const item = selectors.items[0]!;
    item.name = text;
    item.criterion_span_ids = [registered.ids.get(text)!];
    item.fields.name = { composition: "verbatim", span_ids: [registered.ids.get(text)!], separator: "", reason: "Whole clause copied as name." };
    item.fields.requirement = { composition: "verbatim", span_ids: [registered.ids.get("基层表面平整度应符合要求。")!], separator: "", reason: "Exact requirement." };
    item.fields.quantity = { composition: "verbatim", span_ids: [registered.ids.get("检查数量：全数检查。")!], separator: "", reason: "Exact quantity." };
    item.fields.method = { composition: "verbatim", span_ids: [registered.ids.get("检验方法：用2m靠尺检查。")!], separator: "", reason: "Exact method." };
    item.inspection_data_type_span_ids = [registered.ids.get("检验方法：用2m靠尺检查。")!];
    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_name_short_form_required",
          path: "/items/0/fields/name/span_ids/0",
          details: expect.objectContaining({
            contained_roles: expect.arrayContaining(["method", "quantity"]),
          }),
        }),
      ]));
    }
  });

  test("rejects a verbatim name span that crosses independent item boundaries", () => {
    const text = "项目甲表面平整度。项目乙表面垂直度。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, "项目甲表面平整度。", "项目乙表面垂直度。"]);
    const selectors = fixture(text).selectors;
    const first = selectors.items[0]!;
    first.name = text;
    first.criterion_span_ids = [registered.ids.get("项目甲表面平整度。")!];
    first.fields.name = { composition: "verbatim", span_ids: [registered.ids.get(text)!], separator: "", reason: "Cross-item source window." };
    first.fields.requirement = { composition: "verbatim", span_ids: [registered.ids.get("项目甲表面平整度。")!], separator: "", reason: "First item." };
    first.inspection_data_type_span_ids = [registered.ids.get("项目甲表面平整度。")!];
    const second = structuredClone(first);
    second.key = "surface-b";
    second.name = "项目乙表面垂直度";
    second.criterion_span_ids = [registered.ids.get("项目乙表面垂直度。")!];
    second.fields.name = { composition: "semantic_summary", span_ids: second.criterion_span_ids, separator: "", reason: "Second item name." };
    second.fields.requirement = { composition: "verbatim", span_ids: second.criterion_span_ids, separator: "", reason: "Second item." };
    second.inspection_data_type_span_ids = second.criterion_span_ids;
    selectors.items.push(second);
    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_name_short_form_required",
          path: "/items/0/fields/name/span_ids/0",
          details: expect.objectContaining({
            crossed_item_keys: expect.arrayContaining(["surface", "surface-b"]),
          }),
        }),
      ]));
    }
  });

  test("rejects only the trailing sentence terminator on a semantic_summary name", () => {
    const text = "导轨安装位置必须符合土建布置图要求。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = text;
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Verdict sentence copied as the item name.",
    };
    try {
      compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
      throw new Error("expected trailing name punctuation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_name_verdict_sentence") as any;
      expect(issue).toMatchObject({
        path: "/items/0/name",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          name: text,
          signals: ["sentence_punctuation"],
          required_action: "remove_trailing_sentence_punctuation_without_changing_name_semantics_or_requirement",
          actual: expect.objectContaining({
            item_key: prose.selectors.items[0]!.key,
            current_name: text,
            detected_signals: ["sentence_punctuation"],
          }),
          writable_paths: ["/items/0/name"],
          candidate_read_tool: "read_target_selectors",
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("只移除"),
        },
      });
      expect(issue.details.how_to_pass).toContain("requirement");
    }
  });

  test.each([
    "不满足要求时的专项检测委托",
    "设备适宜性评价",
    "连接件应固定牢固",
  ])("leaves name semantics to the model without keyword rejection: %s", (name) => {
    const text = "连接件应固定牢固。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = name;
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Name semantics are selected by the model from the source.",
    };

    expect(acceptanceItemNameShapeIssues(name)).toEqual([]);
    expect(compileTargetSelectors(prose.selectors, prose.registry, prose.manifest).acceptance_items[0]!.name).toBe(name);
  });

  test("does not reject punctuation inside a name and reports only a trailing terminator", () => {
    expect(acceptanceItemNameShapeIssues("“是否适用？”专项评价，复核记录")).toEqual([]);
    expect(acceptanceItemNameShapeIssues("设备专项评价？")).toEqual(["sentence_punctuation"]);
  });

  test("rejects trailing sentence punctuation on a verbatim name", () => {
    const text = "安全钳与导轨的间隙应符合产品设计要求。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = text;
    prose.selectors.items[0]!.fields.name = {
      composition: "verbatim",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Whole clause copied as the item name.",
    };
    try {
      compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
      throw new Error("expected trailing name punctuation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_name_verdict_sentence",
          path: "/items/0/fields/name/span_ids",
        }),
      ]));
    }
  });

  test("a summary name cannot be the only materialization of a declared criterion", () => {
    const heading = "对象甲面板应安装贴实，且方向应正确。";
    const tail = "端正。";
    const text = `${heading}\n${tail}`;
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, heading, tail]);
    const item = selectors.items[0]!;
    item.name = "对象甲面板安装";
    item.criterion_span_ids = [ids.get(heading)!];
    item.fields.name.span_ids = [ids.get(heading)!];
    item.fields.requirement.span_ids = [ids.get(tail)!];
    const before = structuredClone({ selectors, registry, manifest });
    let issue;
    try { compileTargetSelectorsPersisted(selectors, registry, manifest); }
    catch (error) { issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_criterion_not_materialized"); }
    expect(issue).toMatchObject({ path: "/items/0/criterion_span_ids/0", details: {
      item_key: item.key, non_materializing_name_span_ids: [ids.get(heading)!],
      materializing_span_ids: [ids.get(tail)!], next_tool_arguments: { collection: "items", key: item.key },
      actual: { criterion_carried: false, name_composition: "semantic_summary" },
      expected: { criterion_carried_by_same_item_literal_field_or_typed_table: true },
      candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
    } });
    expect({ selectors, registry, manifest }).toEqual(before);
    item.fields.requirement.reason = "已保留全部适用判据";
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: "selector_criterion_not_materialized" })]),
    }));
    item.fields.requirement.span_ids = [ids.get(heading)!, ids.get(tail)!];
    item.fields.requirement.separator = "\n";
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.requirement).toBe(text);
  });

  test("rejects two prose author records differing only in key and explanations without deleting either", () => {
    const { manifest, selectors, registry } = fixture("构件应保持完整。");
    const first = selectors.items[0]!;
    const second = structuredClone(first);
    second.key = "second-copy";
    second.reason = "另一段说明不能创造新的验收判断。";
    second.fields.requirement.reason = "相同原文的再次说明。";
    selectors.items.push(second);
    const before = structuredClone({ selectors, registry, manifest });
    let issue;
    try { compileTargetSelectorsPersisted(selectors, registry, manifest); }
    catch (error) { issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_duplicate_item_payload"); }
    expect(issue).toMatchObject({ path: "/items/0", details: {
      actual: { item_keys: [first.key, second.key], duplicate_count: 2 },
      writable_collection: "items", candidate_read_tool: "read_target_selectors", save_tool: "stage_target_selector_draft",
      next_tool_arguments: { collection: "items", key: first.key },
      how_to_pass: expect.stringContaining("remove_keys"),
    } });
    expect({ selectors, registry, manifest }).toEqual(before);
    selectors.items.pop();
    expect(() => compileTargetSelectors(selectors, registry, manifest)).not.toThrow();
  });

  test("equal prose names and text at distinct immutable source locations remain separate records", () => {
    const text = "构件应保持完整。";
    const { manifest, selectors, registry } = fixture(text);
    const source = { ...manifest.evidence[0]!, evidence_id: "atom:another-location", atom_id: "atom:another-location", locator: "line:2" };
    manifest.evidence.push(source);
    const registered = registerSourceSpan(registry, source, 0, text.length);
    const second = structuredClone(selectors.items[0]!);
    second.key = "another-location";
    second.criterion_span_ids = [registered.span.span_id];
    second.fields.name.span_ids = second.criterion_span_ids;
    second.fields.requirement.span_ids = second.criterion_span_ids;
    second.inspection_data_type_span_ids = second.criterion_span_ids;
    selectors.items.push(second);
    expect(compileTargetSelectors(selectors, registered.registry, manifest).acceptance_items).toHaveLength(2);
  });

  test.each(["contained", "partial"])("rejects %s literal field ranges that repeat a physical source interval", kind => {
    const text = "对象甲应保持完整，并符合约定条件";
    const left = kind === "contained" ? text : "对象甲应保持完整";
    const right = kind === "contained" ? "并符合约定条件" : "保持完整，并符合约定条件";
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, left, right]);
    const item = selectors.items[0]!;
    item.fields.requirement.span_ids = [ids.get(left)!, ids.get(right)!];
    item.fields.requirement.separator = "\n";
    const before = structuredClone({ manifest, selectors, registry });
    let issue;
    try { compileTargetSelectorsPersisted(selectors, registry, manifest); }
    catch (error) { issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_field_source_overlap"); }
    expect(issue).toMatchObject({ path: "/items/0/fields/requirement/span_ids", details: {
      actual: { item_key: item.key, field: "requirement", overlap_count: 1 },
      expected: { distinct_display_fragments_must_not_repeat_the_same_source_interval: true },
      writable_paths: ["/items/0/fields/requirement/span_ids"],
      next_tool_arguments: { collection: "items", key: item.key }, save_tool: "stage_target_selector_draft",
    } });
    expect({ manifest, selectors, registry }).toEqual(before);
    item.fields.requirement.span_ids = [ids.get(text)!];
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.requirement).toBe(text);
  });

  test("keeps equal display fragments, adjacent literal ranges and summary-name overlaps legal", () => {
    const text = " 对象甲保持完整 ";
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, text.trim(), "对象甲", "保持完整"]);
    const item = selectors.items[0]!;
    item.fields.name.span_ids = [ids.get(text)!, ids.get("对象甲")!];
    item.fields.requirement.span_ids = [ids.get(text)!, ids.get(text.trim())!, ids.get(text)!];
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.requirement.trim()).toBe(text.trim());
    item.fields.requirement.span_ids = [ids.get("对象甲")!, ids.get("保持完整")!];
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.requirement).toBe(text.trim());
  });

  test("a summary name does not merge a continuation into visible acceptance content", () => {
    const heading = "对象乙表面应完整。";
    const tail = "接合处还应保持连续。";
    const text = `${heading}\n${tail}`;
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, heading, tail]);
    const item = selectors.items[0]!;
    item.name = "对象乙表面连续性";
    item.criterion_span_ids = [ids.get(heading)!];
    item.continuation_span_ids = [ids.get(tail)!];
    item.fields.name.span_ids = [ids.get(tail)!];
    item.fields.requirement.span_ids = [ids.get(heading)!];
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: "selector_continuation_not_merged" })]),
    }));
    item.fields.note = { composition: "verbatim", span_ids: [ids.get(tail)!], separator: "", reason: "保留后续限定" };
    expect(() => compileTargetSelectors(selectors, registry, manifest)).not.toThrow();
  });

  test("checks the source-backed effective name and keeps a declarative-only edit blocked", () => {
    const text = "资料完整性；";
    const { manifest, selectors } = fixture(text);
    const { registry, ids } = registerQuotes(manifest, [text, "资料完整性"]);
    const item = selectors.items[0]!;
    item.name = "资料完整性";
    item.fields.name = { composition: "verbatim", span_ids: [ids.get(text)!], separator: "", reason: "名称原句" };
    const before = structuredClone({ selectors, registry, manifest });
    let issue;
    try { compileTargetSelectorsPersisted(selectors, registry, manifest); }
    catch (error) { issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_name_verdict_sentence"); }
    expect(issue).toMatchObject({ path: "/items/0/fields/name/span_ids", details: {
      actual: { current_name: text, declared_name: "资料完整性", authoritative_name_path: "/items/0/fields/name" },
      writable_paths: ["/items/0/fields/name"],
      next_tool_arguments: { collection: "items", key: "surface" },
    } });
    expect({ selectors, registry, manifest }).toEqual(before);
    const firstReview = applyRepeatedVerdictNamePolicy(selectors, [issue!], {}, "first-name-fingerprint");
    item.name = "资料核查";
    expect(applyRepeatedVerdictNamePolicy(selectors, [issue!], firstReview.correction_attempts,
      "unused-name-changed").markers).toEqual([]);
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    item.fields.name.span_ids = [ids.get("资料完整性")!];
    const result = compileTargetSelectors(selectors, registry, manifest);
    expect(result.acceptance_items[0]!.name).toBe("资料完整性");
    expect(result.acceptance_items[0]!.requirement).toBe(text);
  });

  test("checks the authoritative joined name path while ignoring unused declarative punctuation", () => {
    const { manifest, registry, selectors } = fixture("范围名称与属性名称");
    const item = selectors.items[0]!;
    item.name = "不参与显示的名称。";
    item.name_path = ["范围", "属性"];
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.name).toBe("范围\\属性");
    item.name_path[1] = "属性；";
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: "selector_name_verdict_sentence", path: "/items/0/name_path",
        details: expect.objectContaining({ writable_paths: ["/items/0/name_path"] }) })]),
    }));
  });

  test("allows threshold wording in a name: condition-vs-limit is a semantic judgment", () => {
    // Round-10 dimensions regression: "层高不大于6m" is an applicability
    // condition inside the name; mechanically rejecting threshold operators
    // mis-blocked legitimate names, so acceptance_limit was withdrawn.
    const text = "两列导轨顶面间的距离偏差应为:轿厢导轨 0～+2mm；对重导轨 0～+3mm。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = "层高不大于6m的垂直度";
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "适用条件属于名称的一部分，阈值语义由模型判断。",
    };
    const compiled = compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
    expect(compiled.acceptance_items[0]!.name).toBe("层高不大于6m的垂直度");
  });

  test("allows a concise inspected-object noun phrase as a semantic_summary name", () => {
    const text = "安全钳与导轨的间隙应符合产品设计要求。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = "安全钳与导轨间隙";
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Inspected object plus its core quality characteristic.",
    };
    const compiled = compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
    expect(compiled.acceptance_items[0]!.name).toBe("安全钳与导轨间隙");
  });

  test("allows business grade tokens without acceptance-limit false positives", () => {
    const text = "C30 混凝土强度应满足设计要求。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = "C30 混凝土强度";
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Strength grade is part of the inspected object identity.",
    };
    const compiled = compileTargetSelectors(prose.selectors, prose.registry, prose.manifest);
    expect(compiled.acceptance_items[0]!.name).toBe("C30 混凝土强度");
  });

  test("allows an internally reviewed punctuated name without changing the business name", () => {
    const text = "导轨安装位置必须符合土建布置图要求。";
    const prose = fixture(text);
    prose.selectors.items[0]!.name = text;
    prose.selectors.items[0]!.fields.name = {
      composition: "semantic_summary",
      span_ids: prose.selectors.items[0]!.criterion_span_ids,
      separator: "",
      reason: "Repeated trailing-punctuation name seals with an internal review marker.",
    };
    const compiled = compileTargetSelectorsPersisted(prose.selectors, prose.registry, prose.manifest, {
      acceptedVerdictNameReviews: [{
        item_key: prose.selectors.items[0]!.key,
        name: text,
      }],
    });
    expect(compiled.acceptance_items[0]!.name).toBe(text);
  });

  test("stages a trailing-punctuation name and exposes a nonblocking model observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-verdict-stage-"));
    try {
      const text = "导轨安装位置必须符合土建布置图要求。";
      const { manifest, selectors } = fixture(text);
      selectors.items[0]!.name = text;
      selectors.items[0]!.fields.name = {
        composition: "semantic_summary",
        span_ids: selectors.items[0]!.criterion_span_ids,
        separator: "",
        reason: "Verdict sentence copied as the item name.",
      };
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      const controller = await ToolController.create(workspace);
      const partial = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { lots: selectors.lots },
      });
      expect(partial).toMatchObject({
        ok: true,
        draft_status: "saved_local_validation_passed",
        global_candidate_complete: false,
        local_validation: {
          ok: true,
          validation_scope: "touched_records",
          global_completeness_checked: false,
        },
      });
      expect(JSON.stringify(partial)).not.toContain("selector_primary_item_required");
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: selectors.items },
      });
      expect(staged).toMatchObject({ ok: true, draft_fingerprint: expect.any(String) });
      expect(staged).toMatchObject({ok:true,draft_status:"saved_local_validation_passed",content_validation_performed:true,budget_consumed:false,model_review:{blocking:false}});

      const advanced = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
      expect(advanced).toMatchObject({ ok: true });
      const observation = (staged as any).model_review.observations.find((row: any) => row.code === "selector_name_verdict_sentence");
      const issue = actionableSelectorIssue(observation, selectors) as any;
      expect(issue).toMatchObject({
        path: "/items/0/name",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        actual: expect.objectContaining({ item_key: selectors.items[0]!.key, current_name: text }),
        writable_path: "/items/0/name",
        writable_paths: ["/items/0/name"],
        next_tool: "read_target_selectors",
        how_to_pass: expect.stringContaining("requirement"),
        save_tool: "stage_target_selector_draft",
        details: {
          required_action: "remove_trailing_sentence_punctuation_without_changing_name_semantics_or_requirement",
          candidate_read_tool: "read_target_selectors",
        },
      });
      expect(issue.how_to_pass).not.toContain(issue.details.required_action);
      expect(createPiTools(controller).map(tool => tool.name)).toEqual(expect.arrayContaining([
        issue.details.candidate_read_tool,
        issue.save_tool,
      ]));
      const working = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
      expect(working.items[0]!.name).toBe(text);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("allows an exact table row label as a verbatim name", () => {

    const tableText = "<table><tr><td>检查项目</td><td>允许值</td></tr><tr><td>基层表面平整度</td><td>2mm</td></tr></table>";
    const manifest = manifestFor(tableText);
    const source = {
      source_id: manifest.evidence[0]!.evidence_id,
      evidence_id: manifest.evidence[0]!.evidence_id,
      atom_id: manifest.evidence[0]!.evidence_id,
      text: tableText,
    };
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
    registry = registerHtmlTableCellSpans(registry, [source]).registry;
    const cellSpan = (value: string) => {
      const cell = htmlTableCellSpans(tableText).find((candidate) => candidate.text === value)!;
      return registry.spans.find((span) => span.start === cell.start && span.end === cell.end)!.span_id;
    };
    const selectors = fixture(tableText).selectors;
    selectors.lots[0]!.scope_span_ids = [cellSpan("基层表面平整度")];
    const item = selectors.items[0]!;
    item.name = "基层表面平整度";
    item.criterion_span_ids = [cellSpan("基层表面平整度")];
    item.fields.name = {
      composition: "verbatim",
      span_ids: [cellSpan("基层表面平整度")],
      separator: "",
      reason: "The exact row label is already a concise inspected characteristic.",
    };
    item.fields.requirement = {
      composition: "verbatim",
      span_ids: [cellSpan("2mm")],
      separator: "",
      reason: "Exact allowed value.",
    };
    item.inspection_data_type_span_ids = [cellSpan("2mm")];
    item.table = {
      source_kind: "direct",
      table_key: "flatness",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[cellSpan("基层表面平整度")]],
        column_path_span_ids: [[cellSpan("允许值")]], unit_span_ids: [],
        condition_span_ids: [], allowed_value_span_ids: [cellSpan("2mm")],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "Exact typed table entry.",
    };
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.name)
      .toBe("基层表面平整度");
  });

  test("rejects a referenced table title without a row or column entry path", () => {
    const current = fixture();
    const full = current.selectors.items[0]!.criterion_span_ids[0]!;
    current.selectors.items[0]!.table = {
      source_kind: "reference",
      table_key: "referenced-table",
      properties: {
        table_no_span_ids: [full], table_title_span_ids: [full], applicability_span_ids: [],
        row_path_span_ids: [], column_path_span_ids: [], unit_span_ids: [],
        condition_span_ids: [], allowed_value_span_ids: [full], inspection_method_span_ids: [],
      },
      reference_span_ids: [full],
      reason: "Only the title was selected.",
    };
    expect(() => compileTargetSelectors(current.selectors, current.registry, current.manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(current.selectors, current.registry, current.manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_table_entry_path_required",
          path: "/items/0/table/properties",
        }),
      ]));
    }
  });

  test("compares convergence by furthest deterministic preflight stage before issue count", () => {
    expect(compareTargetSelectorPreflightScore(
      { stage_rank: 2, issue_count: 6 },
      { stage_rank: 1, issue_count: 2 },
    )).toBe("improved");
    expect(compareTargetSelectorPreflightScore(
      { stage_rank: 2, issue_count: 5 },
      { stage_rank: 2, issue_count: 6 },
    )).toBe("improved");
    expect(compareTargetSelectorPreflightScore(
      { stage_rank: 2, issue_count: 6 },
      { stage_rank: 2, issue_count: 6 },
    )).toBe("stagnation");
    expect(compareTargetSelectorPreflightScore(
      { stage_rank: 1, issue_count: 1 },
      { stage_rank: 2, issue_count: 6 },
    )).toBe("regression");
  });

  test("typed selector draft schema leaves record count to the serialized byte budget", () => {
    const draftSchema = TARGET_SELECTOR_DRAFT_JSON_SCHEMA as any;
    for (const collection of ["lots", "items", "sampling_rules", "references", "source_dispositions"]) {
      expect(draftSchema.properties[collection].maxItems).toBeUndefined();
    }
  });

  test("protocol errors identify the missing input and provide an exact stale-commit retry without changing the draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-protocol-guidance-"));
    try {
      const {manifest} = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {manifest, markdown: Buffer.from(manifest.evidence[0]!.text)});
      const controller = await ToolController.create(workspace);
      const before = await readFile(workspace.workingSelectorPath, "utf8");
      expect(await controller.dispatch("stage_target_selector_draft", {collection: "items"})).toMatchObject({
        error: "selector_draft_must_be_object", terminal: false, writable_path: "draft", next_tool: "stage_target_selector_draft", actual: {draft_type: "undefined"},
      });
      const rejected = await controller.dispatch("commit_target_selector_draft", {draft_fingerprint: "0".repeat(64)});
      expect(rejected).toMatchObject({error: "selector_draft_fingerprint_mismatch", terminal: false, next_tool: "commit_target_selector_draft", actual_draft_fingerprint: "0".repeat(64)});
      expect(rejected.retry_arguments).toEqual({draft_fingerprint: rejected.current_draft_fingerprint});
      const exhausted = await controller.dispatch("commit_target_selector_draft", {draft_fingerprint: "0".repeat(64)});
      expect(exhausted).toMatchObject({terminal: true, next_tool: null});
      expect(exhausted).not.toHaveProperty("retry_arguments");
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    } finally { await rm(root, {recursive: true, force: true}); }
  });

  test("stages dynamic record counts while repeated oversized drafts stay nonterminal and preserve the working checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-dynamic-batch-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      const lots = Array.from({ length: 9 }, (_value, index) => ({
        ...structuredClone(selectors.lots[0]!),
        key: `lot-${index + 1}`,
        name: `检验批 ${index + 1}`,
      }));
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { lots: lots.slice(0, 8) },
      })).toMatchObject({
        ok: true,
        staged_record_count: 8,
        counts: { lots: 8 },
        budget_consumed: false,
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { lots },
      })).toMatchObject({
        ok: true,
        staged_record_count: 9,
        counts: { lots: 9 },
        budget_consumed: false,
      });
      const oversized = lots.map((lot) => ({
        ...lot,
        reason: "x".repeat(20_000),
      }));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await controller.dispatch("stage_target_selector_draft", {
          operation: "replace_collection",
          draft: { lots: oversized },
        })).toMatchObject({
          ok: false,
          error: "selector_draft_size_limit",
          requested_record_count: 9,
          max_serialized_bytes: 128 * 1024,
          recommended_record_count: expect.any(Number),
          terminal: false,
          budget_consumed: false,
        });
      }
      expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).lots).toHaveLength(9);
      expect(await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: [lots[0]!], items: selectors.items },
      })).toMatchObject({ ok: true, collections: ["lots", "items"], staged_record_count: 2 });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 0,
        corrections: 0,
        protocol_failures: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("atomically removes existing selector keys without replacing the rest of the collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-remove-keys-"));
    try {
      const { manifest, selectors } = fixture();
      const items = Array.from({ length: 41 }, (_value, index) => ({
        ...structuredClone(selectors.items[0]!),
        key: `item-${index + 1}`,
        name: `验收项目 ${index + 1}`,
      }));
      const initial = structuredClone(selectors);
      initial.items = items;
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(initial));
      let controller = await ToolController.create(workspace);

      const updated = structuredClone(items[0]!);
      updated.reason = "同一原子 patch 内更新另一个现存项目";
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        collection: "items",
        remove_keys: ["item-41"],
        draft: { items: [updated] },
      })).toMatchObject({
        ok: true,
        collection: "items",
        staged_record_count: 1,
        removed_record_count: 1,
        counts: { items: 40 },
        budget_consumed: false,
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      expect(await readdir(workspace.historyDirectory)).toEqual(["000001.json"]);

      const reopened = await RevisionWorkspace.openLatest(root, manifest.job_id, manifest.target_id);
      controller = await ToolController.create(reopened);
      const afterRestart = await controller.dispatch("read_target_selectors", { collection: "items", limit: 100 });
      expect(afterRestart).toMatchObject({ ok: true, collection: "items", view: "index" });
      expect((afterRestart.rows as Array<{ key: string }>)).toHaveLength(40);
      expect((afterRestart.rows as Array<{ key: string }>).map((item) => item.key)).not.toContain("item-41");
      const item1 = await controller.dispatch("read_target_selectors", { collection: "items", key: "item-1" });
      expect(item1).toMatchObject({
        ok: true,
        view: "record",
        rows: [expect.objectContaining({
          key: "item-1",
          reason: "同一原子 patch 内更新另一个现存项目",
        })],
      });

      const selectorWithReference = migrateTargetSelectorPlan(JSON.parse(
        await readFile(reopened.workingSelectorPath, "utf8"),
      ));
      selectorWithReference.references.push({
        key: "ref-to-item-40",
        anchor_span_ids: selectorWithReference.items[1]!.criterion_span_ids,
        target_span_ids: selectorWithReference.items[0]!.criterion_span_ids,
        action: "keep_reference",
        application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["method"], reason: "引用只进入方法字段。" },
        destinations: [{ item_key: "item-40", target_field: "method" }],
        reason: "显式依赖必须跟随目标 item 生命周期",
      });
      await reopened.writeWorkingSelectors(prettyJson(selectorWithReference));
      await reopened.updateState((state) => { state.selector_stage = "commit"; });
      controller = await ToolController.create(reopened);
      const dangling = await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        remove_keys: ["item-40"],
      });
      expect(dangling).toMatchObject({ok: true,removed_record_count: 1,budget_consumed: false,draft_status:"saved_local_validation_passed",content_validation_performed:true});
      expect(dangling).not.toHaveProperty("preflight_issues");
      const dependencyRemoved = await controller.dispatch("stage_target_selector_draft", {
        collection: "references",
        remove_keys: ["ref-to-item-40"],
      });
      expect(dependencyRemoved).toMatchObject({ok: true,removed_record_count: 1,budget_consumed: false,draft_status:"saved_local_validation_passed",content_validation_performed:true});

      const sequenceBeforeRejectedPatches = (await reopened.readState()).next_history_sequence;
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        remove_keys: ["missing-item"],
      })).toMatchObject({
        ok: false,
        error: "selector_draft_remove_key_unknown",
        unknown_keys: ["missing-item"],
        allowed_existing_keys: expect.arrayContaining(["item-1", "item-39"]),
        budget_consumed: false,
        durable_mutation: false,
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", cursor: 0 },
        retry_tool: "stage_target_selector_draft",
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        remove_keys: ["item-2", "item-2"],
      })).toMatchObject({
        ok: false,
        error: "selector_draft_remove_keys_duplicate",
        duplicate_keys: ["item-2"],
        budget_consumed: false,
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        remove_keys: ["item-1"],
        draft: { items: [updated] },
      })).toMatchObject({
        ok: false,
        error: "selector_draft_upsert_remove_conflict",
        conflicting_keys: ["item-1"],
        budget_consumed: false,
        durable_mutation: false,
        actual: { collection: "items", conflicts: [{ key: "item-1", saved_record_count: 1,
          remove_paths: ["/remove_keys/0"], upsert_paths: ["/draft/items/0"] }] },
        expected: { actions_per_conflicting_key: 1 },
        writable_paths: ["/remove_keys/0", "/draft/items/0", "/remove_keys"],
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "item-1" },
        retry_tool: "stage_target_selector_draft",
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        remove_keys: ["item-2"],
        draft: { lots: [selectors.lots[0]!] },
      })).toMatchObject({
        ok: false,
        error: "selector_draft_collection_patch_invalid",
        draft_collections: ["lots"],
        removal_collection: "items",
      });
      expect((await reopened.readState()).next_history_sequence).toBe(sequenceBeforeRejectedPatches);
      expect((await reopened.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      expect(await readdir(reopened.historyDirectory)).toEqual(["000001.json", "000002.json", "000003.json"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("recovers a hashed disposition remove/upsert conflict through its exact public paths without partial saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-disposition-conflict-"));
    try {
      const text = "中性组织标题甲。中性组织标题乙。";
      const { manifest, selectors } = fixture(text);
      const registered = registerQuotes(manifest, ["中性组织标题甲。", "中性组织标题乙。"]);
      selectors.source_dispositions = [
        { span_ids: [registered.ids.get("中性组织标题甲。")!], disposition: "context", reason: "组织标题甲。" },
        { span_ids: [registered.ids.get("中性组织标题乙。")!], disposition: "context", reason: "组织标题乙。" },
      ];
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(text) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registered.registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const call = async (name: string, input: Record<string, unknown>) => {
        const result = await tools.find(tool => tool.name === name)!.execute(name, input, undefined as never, undefined as never);
        return JSON.parse(result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n"));
      };
      const directory = await call("read_target_selectors", { collection: "source_dispositions" });
      const key = directory.rows[0].key as string;
      expect(key).toMatch(/^disposition:/u);
      for (const row of directory.rows) await call("read_target_selectors", { collection: "source_dispositions", key: row.key });
      const changedNeighbor = { ...selectors.source_dispositions[1]!, reason: "作者核对后补充的组织标题乙说明。" };
      const encoded = await codec.encode({ draft: { source_dispositions: [selectors.source_dispositions[0]!, changedNeighbor] } }) as Record<string, unknown>;
      const patch = { ...encoded, source_handle_scope: codec.scope, operation: "upsert", collection: "source_dispositions", remove_keys: [key] };
      const before = await readFile(workspace.workingSelectorPath, "utf8");
      const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
      const stateBefore = await workspace.readState();
      const rejected = await call("stage_target_selector_draft", patch);
      expect(rejected).toMatchObject({ ok: false, error: "selector_draft_upsert_remove_conflict", durable_mutation: false,
        budget_consumed: false, actual: { collection: "source_dispositions", conflicts: [{ key, saved_record_count: 1,
          remove_paths: ["/remove_keys/0"], upsert_paths: ["/draft/source_dispositions/0"] }] },
        expected: { actions_per_conflicting_key: 1 },
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "source_dispositions", key },
        writable_paths: ["/remove_keys/0", "/draft/source_dispositions/0", "/remove_keys"],
        mutation_receipt: { status: "not_applied", remove_keys: [key] } });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect((await workspace.readState()).next_history_sequence).toBe(stateBefore.next_history_sequence);
      expect((await workspace.readState()).selector_protocol).toEqual(stateBefore.selector_protocol);
      const read = await call(rejected.next_tool, rejected.next_tool_arguments);
      expect(read).toMatchObject({ ok: true, read_key: key, rows: [{ reason: "组织标题甲。" }] });
      // The author chooses to keep the complete upsert; the harness makes no
      // business choice and must preserve the unrelated pending update.
      const { remove_keys: confirmedConflictRemoved, ...repairedPatch } = patch;
      const repaired = await call(rejected.retry_tool, repairedPatch);
      expect(repaired).toMatchObject({ ok: true, budget_consumed: false, removed_record_count: 0 });
      const after = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
      expect(after.source_dispositions).toEqual([selectors.source_dispositions[0]!, changedNeighbor]);
      expect(after.items).toEqual(selectors.items);
      expect((await workspace.readState()).next_history_sequence).toBe(stateBefore.next_history_sequence + 1);
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  test("repairs eight fallback source conflicts in one no-budget typed batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-fallback-batch-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      const invalidItems = Array.from({ length: 8 }, (_value, index) => {
        const item = structuredClone(selectors.items[0]!);
        item.key = `fallback-${index + 1}`;
        item.name = `兜底项目 ${index + 1}`;
        item.sampling.rule_key = "invalid-shared-rule";
        item.sampling.branch_keys = ["invalid-branch"];
        return item;
      });
      const invalidPlan = structuredClone(selectors);
      invalidPlan.items = invalidItems;
      expect(await controller.dispatch("submit_target_selectors", {
        content: prettyJson(invalidPlan),
      })).toMatchObject({
        ok: false,
        selector_issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_sampling_fallback_has_source" }),
        ]),
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 0 });
      const repairedItems = invalidItems.map((item) => ({
        ...item,
        sampling: { ...item.sampling, rule_key: "", branch_keys: [] },
      }));
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: repairedItems },
      })).toMatchObject({ok: true,staged_record_count: 8,budget_consumed: false,draft_status:"saved_local_validation_passed",content_validation_performed:true});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 0 });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  test("reference_only routes carry referenced table evidence to the exact item", () => {
    const plan = {
      semantic_evidence: [
        { semantic_id: "anchor", evidence_id: "atom:primary", materialized_item_id: "item-1" },
        { semantic_id: "target", evidence_id: "atom:referenced-table", materialized_item_id: "item-1" },
      ],
      semantic_references: [{
        status: "resolved",
        anchor_semantic_id: "anchor",
        target_semantic_ids: ["target"],
        destination_bindings: [{ item_id: "item-1", fields: ["reference_only"] }],
      }],
    } as unknown as SemanticSourcePlan;
    expect([...semanticReferenceEvidenceIdsForDestination(
      plan,
      "item-1",
      "reference_only",
    )]).toEqual(["atom:primary", "atom:referenced-table"]);
  });

  test("compiles identical selectors byte-identically and rationale cannot change source facts", () => {
    const { manifest, registry, selectors } = fixture();
    const first = compileTargetSelectors(selectors, registry, manifest);
    const changed = structuredClone(selectors);
    changed.rationale = "另一段不参与事实编译的审计说明";
    changed.items[0]!.reason = "另一段业务判断说明";
    const second = compileTargetSelectors(changed, registry, manifest);
    expect(prettyJson(second)).not.toContain(changed.rationale);
    expect(second.acceptance_items[0]!.requirement).toBe(first.acceptance_items[0]!.requirement);
    expect(second.acceptance_items[0]!.field_bindings.requirement).toEqual(first.acceptance_items[0]!.field_bindings.requirement);
    expect(prettyJson(compileTargetSelectors(selectors, registry, manifest))).toBe(prettyJson(first));
    expect(validatePlanText(prettyJson(first), manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("deduplicates repeated display text while retaining both exact source spans", () => {
    const repeated = "承载力应符合设计要求。";
    const text = `${repeated}${repeated}`;
    const { manifest, registry: initialRegistry, selectors } = fixture(text);
    const first = registerSourceSpan(initialRegistry, {
      source_id: manifest.evidence[0]!.evidence_id,
      evidence_id: manifest.evidence[0]!.evidence_id,
      atom_id: manifest.evidence[0]!.evidence_id,
      text,
    }, 0, repeated.length);
    const second = registerSourceSpan(first.registry, {
      source_id: manifest.evidence[0]!.evidence_id,
      evidence_id: manifest.evidence[0]!.evidence_id,
      atom_id: manifest.evidence[0]!.evidence_id,
      text,
    }, repeated.length, text.length);
    selectors.lots[0]!.scope_span_ids = [first.span.span_id, second.span.span_id];
    selectors.items[0]!.criterion_span_ids = [first.span.span_id, second.span.span_id];
    selectors.items[0]!.fields.name.span_ids = [first.span.span_id, second.span.span_id];
    selectors.items[0]!.fields.requirement.span_ids = [first.span.span_id, second.span.span_id];
    selectors.items[0]!.fields.requirement.separator = "\n";
    selectors.items[0]!.inspection_data_type_span_ids = [first.span.span_id, second.span.span_id];

    const compiled = compileTargetSelectors(selectors, second.registry, manifest);
    expect(compiled.acceptance_items[0]!.requirement).toBe(repeated);
    expect(compiled.acceptance_items[0]!.field_bindings.requirement.source_fragments).toHaveLength(2);
    expect((compiled.semantic_evidence ?? []).filter((node) =>
      node.exact_fragment === repeated
    )).toHaveLength(2);
  });

  test("routes a shared unmerged continuation through two neutral author choices", async () => {
    const text = "基层表面应平整。基层接合应完整。施工前应完成技术交底。";
    const criterion = "基层表面应平整。";
    const secondCriterion = "基层接合应完整。";
    const continuation = "施工前应完成技术交底。";
    const { manifest, selectors } = fixture(text);
    const registered = registerQuotes(manifest, [text, criterion, secondCriterion, continuation]);
    const criterionSpanId = registered.ids.get(criterion)!;
    selectors.items[0]!.criterion_span_ids = [criterionSpanId];
    selectors.items[0]!.continuation_span_ids = [registered.ids.get(continuation)!];
    selectors.items[0]!.fields.name.span_ids = [criterionSpanId];
    selectors.items[0]!.fields.requirement.span_ids = [criterionSpanId];
    selectors.items[0]!.inspection_data_type_span_ids = [criterionSpanId];
    const secondItem = structuredClone(selectors.items[0]!);
    secondItem.key = "surface-second";
    secondItem.name = "基层接合完整性";
    secondItem.criterion_span_ids = [registered.ids.get(secondCriterion)!];
    secondItem.fields.name.span_ids = secondItem.criterion_span_ids;
    secondItem.fields.requirement.span_ids = secondItem.criterion_span_ids;
    secondItem.inspection_data_type_span_ids = secondItem.criterion_span_ids;
    selectors.items.push(secondItem);

    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
      throw new Error("expected an unmerged continuation issue");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find((entry) =>
        entry.code === "selector_continuation_not_merged"
      ) as any;
      expect(issue).toMatchObject({
        code: "selector_continuation_not_merged",
        path: "/items/0/continuation_span_ids/0",
        message: expect.stringMatching(/[\u3400-\u9fff]/u),
        details: {
          required_action: "route_continuation_to_real_item_provenance_or_source_disposition",
          actual: {
            span_id: registered.ids.get(continuation),
            evidence_id: manifest.evidence[0]!.evidence_id,
            occurrence_count: 2,
            item_keys: [selectors.items[0]!.key, secondItem.key],
            paths: [
              "/items/0/continuation_span_ids/0",
              "/items/1/continuation_span_ids/0",
            ],
            affected_items: [
              expect.objectContaining({ item_key: selectors.items[0]!.key, readable_path: "/items/0" }),
              expect.objectContaining({ item_key: secondItem.key, readable_path: "/items/1" }),
            ],
          },
          allowed_actions: [
            expect.stringMatching(/fields.*table.*sampling provenance/u),
            expect.stringMatching(/source_dispositions.*context\/ignored/u),
          ],
          writable_paths: expect.arrayContaining([
            "/items/0/continuation_span_ids/0",
            "/items/0/fields",
            "/items/0/table",
            "/items/0/sampling",
            "/items/1/continuation_span_ids/0",
            "/items/1/fields",
            "/items/1/table",
            "/items/1/sampling",
            "/source_dispositions",
          ]),
          writable_collections: ["items", "source_dispositions"],
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: selectors.items[0]!.key },
          affected_item_reads: [
            { tool: "read_target_selectors", arguments: { collection: "items", key: selectors.items[0]!.key } },
            { tool: "read_target_selectors", arguments: { collection: "items", key: secondItem.key } },
          ],
          source_disposition_read: {
            tool: "read_target_selectors",
            arguments: { collection: "source_dispositions" },
          },
          next_tools: expect.arrayContaining(["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"]),
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringMatching(/affected_item_reads.*allowed_actions.*writable_paths.*harness 不替模型/u),
          do_not_edit: expect.stringContaining("不可变原文"),
        },
      });
      expect(JSON.stringify(issue)).not.toContain(continuation);

      const deliveredAsItemContent = structuredClone(selectors);
      for (const item of deliveredAsItemContent.items) {
        item.fields.note = {
          composition: "verbatim",
          span_ids: [registered.ids.get(continuation)!],
          separator: "",
          reason: "中性测试：该 continuation 是当前 item 的最终可见内容。",
        };
      }
      expect(() => compileTargetSelectors(deliveredAsItemContent, registered.registry, manifest)).not.toThrow();

      const disposedAsContext = structuredClone(selectors);
      for (const item of disposedAsContext.items) item.continuation_span_ids = [];
      disposedAsContext.source_dispositions.push({
        span_ids: [registered.ids.get(continuation)!],
        disposition: "context",
        reason: "中性测试：该 span 只作为背景上下文。",
      });
      expect(() => compileTargetSelectors(disposedAsContext, registered.registry, manifest)).not.toThrow();

      const root = await mkdtemp(join(tmpdir(), "continuation-feedback-tools-"));
      try {
        const workspace = await RevisionWorkspace.createFromEvidence(
          root,
          manifest.job_id,
          manifest.target_id,
          { manifest, markdown: Buffer.from(text) },
        );
        const availableTools = createPiTools(await ToolController.create(workspace)).map((tool) => tool.name);
        expect(availableTools).toEqual(expect.arrayContaining([
          ...issue.details.candidate_read_tools,
          issue.details.save_tool,
        ]));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("allows multiple fine-grained items under one parent lot", () => {
    const parent = "电缆桥架和线槽的安装应符合下列规定：";
    const firstChild = "1 桥架顶部距顶棚不宜小于300mm。";
    const secondChild = "2 线槽内缆线布放应自然平直。";
    const text = [parent, firstChild, secondChild].join("\n");
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [parent, firstChild, secondChild]);
    const template = fixture().selectors.items[0]!;
    const child = (key: string, name: string, spanId: string) => ({
      ...structuredClone(template),
      key,
      lot_key: "cable-support",
      name,
      criterion_span_ids: [spanId],
      continuation_span_ids: [],
      fields: {
        ...structuredClone(template.fields),
        name: { ...template.fields.name, span_ids: [spanId] },
        requirement: { ...template.fields.requirement, span_ids: [spanId] },
      },
      inspection_data_type_span_ids: [spanId],
    });
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({
      key: "cable-support",
      name: "电缆桥架和线槽的安装",
      scope_span_ids: [registered.ids.get(parent)!],
      reason: "父标题定义下属独立条款的共同分组。",
    });
    selectors.items.push(
      child("bridge-clearance", "桥架顶部净距", registered.ids.get(firstChild)!),
      child("trunking-lay", "线槽内缆线布放", registered.ids.get(secondChild)!),
    );

    const plan = compileTargetSelectors(selectors, registered.registry, manifest);
    const result = materialize(plan, manifest, "grouped-cable-protection").result;
    expect(plan.inspection_lots).toHaveLength(1);
    expect(plan.inspection_lots[0]!.item_ids).toHaveLength(2);
    expect(selectors.items.every((item) => item.continuation_span_ids.length === 0)).toBe(true);
    expect(result.inspection_lots.flatMap((lot) =>
      lot.items.map((item) => `${lot.name}\\${item.name}`)
    )).toEqual([
      "电缆桥架和线槽的安装\\桥架顶部净距",
      "电缆桥架和线槽的安装\\线槽内缆线布放",
    ]);

    const invalid = structuredClone(selectors);
    invalid.items[0]!.continuation_span_ids = [registered.ids.get(parent)!];
    invalid.items[0]!.fields.requirement.span_ids = [
      registered.ids.get(parent)!,
      registered.ids.get(firstChild)!,
    ];
    expect(() => compileTargetSelectors(invalid, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_group_scope_used_as_continuation" }),
        ]),
      }),
    );
  });

  test("keeps scope roles exclusive even for prose aggregates that require semantic review", () => {
    const parent = "电缆桥架和线槽的安装应符合下列规定：";
    const firstChild = "1 桥架顶部距顶棚不宜小于300mm。";
    const secondChild = "2 线槽内缆线布放应自然平直。";
    const text = [parent, firstChild, secondChild].join("\n");
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [parent, firstChild, secondChild]);
    const parentSpanId = registered.ids.get(parent)!;
    const childSpanIds = [registered.ids.get(firstChild)!, registered.ids.get(secondChild)!];
    const template = structuredClone(fixture().selectors.items[0]!);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({
      key: "cable-support",
      name: "电缆桥架和线槽的安装",
      scope_span_ids: [parentSpanId],
      reason: "父标题定义共同分组。",
    });
    selectors.items.push({
      ...template,
      key: "cable-support-requirements",
      lot_key: "cable-support",
      name: "桥架与线槽安装要求",
      criterion_span_ids: childSpanIds,
      continuation_span_ids: [],
      fields: {
        ...template.fields,
        name: { ...template.fields.name, span_ids: childSpanIds },
        requirement: { ...template.fields.requirement, span_ids: childSpanIds, separator: "\n" },
      },
      inspection_data_type_span_ids: childSpanIds,
    });

    const continuationConflict = structuredClone(selectors);
    continuationConflict.items[0]!.continuation_span_ids = [parentSpanId];
    continuationConflict.items[0]!.fields.requirement.span_ids = [parentSpanId, ...childSpanIds];
    expect(() => compileTargetSelectors(continuationConflict, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_group_scope_used_as_continuation" }),
        ]),
      }),
    );

    const contextConflict = structuredClone(selectors);
    contextConflict.source_dispositions.push({
      span_ids: [parentSpanId],
      disposition: "context",
      reason: "错误地把父分组标题再次声明为上下文。",
    });
    expect(() => compileTargetSelectors(contextConflict, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({
          code: "selector_lot_scope_context_conflict",
          details: expect.objectContaining({
            span_id: parentSpanId,
            lot_keys: ["cable-support"],
            disposition_paths: ["/source_dispositions/0/span_ids/0"],
          }),
        })],
      }),
    );
  });

  test("saves unfinished grouping and continuation bindings without draft-rule rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-group-continuation-"));
    try {
      const parent = "电缆桥架和线槽的安装应符合下列规定：";
      const firstChild = "1 桥架顶部距顶棚不宜小于300mm。";
      const secondChild = "2 线槽内缆线布放应自然平直。";
      const text = [parent, firstChild, secondChild].join("\n");
      const manifest = manifestFor(text);
      const registered = registerQuotes(manifest, [parent, firstChild, secondChild]);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registered.registry), "utf8");
      const controller = await ToolController.create(workspace);
      const parentSpanId = registered.ids.get(parent)!;
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { lots: [{
          key: "cable-support",
          name: "电缆桥架和线槽的安装",
          scope_span_ids: [parentSpanId],
          reason: "共同分组标题。",
        }] },
      })).toMatchObject({ ok: true });
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { source_dispositions: [{
          span_ids: [parentSpanId],
          disposition: "context",
          reason: "错误地把父分组标题再次声明为上下文。",
        }] },
      })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false});
      const template = fixture().selectors.items[0]!;
      const child = (key: string, name: string, spanId: string) => ({
        ...structuredClone(template),
        key,
        lot_key: "cable-support",
        name,
        criterion_span_ids: [spanId],
        continuation_span_ids: [parentSpanId],
        fields: {
          ...structuredClone(template.fields),
          name: { ...template.fields.name, span_ids: [spanId] },
          requirement: { ...template.fields.requirement, span_ids: [spanId] },
        },
        inspection_data_type_span_ids: [spanId],
      });
      const children = [
        child("bridge-clearance", "桥架顶部净距", registered.ids.get(firstChild)!),
        child("trunking-lay", "线槽内缆线布放", registered.ids.get(secondChild)!),
      ];
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: children },
      })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false});

      const parentVisible = children.map((item, index) => {
        const copy = structuredClone(item);
        copy.fields.requirement.span_ids = [
          parentSpanId,
          index === 0 ? registered.ids.get(firstChild)! : registered.ids.get(secondChild)!,
        ];
        return copy;
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: parentVisible },
      })).toMatchObject({ok:true,draft_status:expect.stringMatching(/^saved_local_validation_/u),content_validation_performed:true,budget_consumed:false});
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("aggregates empty bound fields with earlier selector preflight issues", () => {
    const text = "基层表面应平整。施工前应完成技术交底。";
    const criterion = "基层表面应平整。";
    const continuation = "施工前应完成技术交底。";
    const { manifest, selectors } = fixture(text);
    const registered = registerQuotes(manifest, [text, criterion, continuation]);
    const criterionSpanId = registered.ids.get(criterion)!;
    selectors.items[0]!.criterion_span_ids = [criterionSpanId];
    selectors.items[0]!.continuation_span_ids = [registered.ids.get(continuation)!];
    selectors.items[0]!.fields.name.span_ids = [criterionSpanId];
    selectors.items[0]!.fields.requirement.span_ids = [criterionSpanId];
    selectors.items[0]!.fields.quantity = {
      composition: "reference",
      span_ids: [],
      separator: "",
      reason: "错误地把抽样规则引用当成字段引用",
    };
    selectors.items[0]!.inspection_data_type_span_ids = [criterionSpanId];

    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
      throw new Error("expected aggregated selector issues");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_continuation_not_merged" }),
      ]));
      const issue = (error as TargetSelectorCompileError).issues.find(entry => entry.code === "selector_nonempty_field_unbound") as any;
      expect(issue).toMatchObject({
        path: "/items/0/fields/quantity",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "bind_evidence_spans_or_mark_field_not_applicable",
          actual: { item_key: "surface", field: "quantity", composition: "reference", span_ids: [] },
          writable_path: "/items/0/fields/quantity",
          candidate_read_tool: "read_target_selectors",
          next_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("两种合法修法"),
        },
      });
    }
  });

  test("an explicit source disposition classifies a selected primary atom", () => {
    const { manifest, registry: initialRegistry, selectors } = fixture();
    const evidenceId = "atom:explicit-context";
    const text = "本段仅说明施工准备，不形成验收项目。";
    manifest.evidence.push({
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "context",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    });
    manifest.scope.selected_atom_ids = [evidenceId];
    const registered = registerSourceSpan(initialRegistry, {
      source_id: evidenceId,
      evidence_id: evidenceId,
      atom_id: evidenceId,
      text,
    }, 0, text.length);
    selectors.source_dispositions = [{
      span_ids: [registered.span.span_id],
      disposition: "context",
      reason: "显式保留为上下文，不生成验收项目",
    }];

    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest).filter((issue) =>
      issue.code === "compiler_semantic_primary_atom_unclassified"
    )).toEqual([]);
  });

  test("public schema keeps facts pointer-based and requires Agent-authored reference import scope", () => {
    const schemaText = JSON.stringify(TARGET_SELECTOR_PLAN_JSON_SCHEMA);
    expect(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.schema_version.const).toBe("target-selector-plan/v6");
    expect(schemaText).toContain('"additionalProperties":false');
    for (const forbidden of ['"min_sampling":', '"receiver"', '"evidence_text"', '"value_sha256"', "span_registry_fingerprint", "evidence_fingerprint"]) {
      expect(schemaText).not.toContain(forbidden);
    }
    const schema = TARGET_SELECTOR_PLAN_JSON_SCHEMA as any;
    const tableProperties = schema.properties.items.items.properties.table.anyOf[1].properties.properties.properties;
    for (const fact of ["table_no_span_ids", "unit_span_ids", "allowed_value_span_ids", "inspection_method_span_ids"]) {
      expect(tableProperties[fact].type).toBe("array");
      expect(tableProperties[fact].items.type).toBe("string");
      expect(tableProperties[fact].items.pattern).toBe("^span:[a-f0-9]{32}$");
    }
    for (const ambiguous of ["table_no", "table_title", "applicability", "row_path", "column_path"])
      expect(tableProperties).not.toHaveProperty(ambiguous);
    const samplingProperties = schema.properties.items.items.properties.sampling.properties;
    expect(samplingProperties.branch_keys).toMatchObject({
      type: "array",
      items: { type: "string", minLength: 1 },
    });
    expect(samplingProperties).not.toHaveProperty("branch_key");
    const referenceProperties = schema.properties.references.items.properties;
    expect(referenceProperties).toHaveProperty("import_scope");
    expect(referenceProperties.reason).toMatchObject({
      type: "string",
      description: expect.stringContaining("引用顶层说明"),
    });
    expect(referenceProperties.import_scope.properties).toMatchObject({
      mode: { anyOf: expect.any(Array) },
      allowed_fields: { type: "array", minItems: 1, uniqueItems: true },
      reason: { type: "string", minLength: 1 },
    });
    expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("顶层 reason");
    const samplingRuleProperties = schema.properties.sampling_rules.items.properties;
    const samplingBranchProperties = samplingRuleProperties.branches.items.properties;
    expect(samplingRuleProperties.components.items.properties).toHaveProperty("role");
    expect(samplingBranchProperties.components.items.properties).toHaveProperty("disposition");
    for (const legacy of ["shared_conditions", "minimum_span_ids", "script_span_ids", "condition_span_ids"]) {
      expect(samplingRuleProperties).not.toHaveProperty(legacy);
      expect(samplingBranchProperties).not.toHaveProperty(legacy);
    }
  });

  test("rejects authored replace_field and does not advertise it on the selector schema", () => {
    const { manifest, registry, selectors } = fixture();
    const spanId = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.references = [{
      key: "banned-replace-field",
      anchor_span_ids: [spanId],
      target_span_ids: [spanId],
      action: "adopt",
      application_mode: "replace_field",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["requirement"],
        reason: "引用只允许进入要求字段。",
      },
      destinations: [{ item_key: "surface", target_field: "requirement" }],
      reason: "旧整字段替换不得再写",
    } as TargetSelectorPlan["references"][number]];

    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected selector compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_reference_replace_field_forbidden",
        path: "/references/0/application_mode",
        details: expect.objectContaining({
          writable_collection: "references",
          actual: "replace_field",
          allowed_application_modes: ["reference_only", "reference_placeholder"],
          required_action: "set_application_mode_to_reference_only_and_keep_local_field",
        }),
      }));
    }

    const encoded = JSON.stringify(
      TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.references.items.properties.application_mode,
    );
    expect(encoded).not.toMatch(/"const":"replace_field"/);
    expect(encoded).toContain("reference_only");
    expect(encoded).toContain("reference_placeholder");
  });

  test("requires a non-empty reference_only top-level reason without imposing a minimum length", () => {
    const { manifest, registry, selectors } = fixture();
    const spanId = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.references.push({
      key: "literal-only-reference",
      anchor_span_ids: [spanId],
      target_span_ids: [spanId],
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["requirement"],
        reason: "引用只允许进入要求字段。",
      },
      destinations: [{ item_key: "surface", target_field: "requirement" }],
      reason: " ",
    });

    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected selector compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_reference_only_reason_required",
        path: "/references/0/reason",
        details: expect.objectContaining({
          required_action: "write_a_top_level_reference_reason_before_commit",
        }),
      }));
    }

    selectors.references[0]!.reason = "见表";
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).not.toContainEqual(expect.objectContaining({
        code: "selector_reference_only_reason_required",
      }));
    }
  });

  test("derives sampling values, IDs, membership and receivers from selected spans", () => {
    const text = "基层表面应平整。一般项目每检验批抽查10%。";
    const criterion = "基层表面应平整。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, criterion, "一般项目每检验批抽查10%。", "10%"]);
    const full = registered.ids.get(text)!;
    const script = registered.ids.get("一般项目每检验批抽查10%。")!;
    const minimum = registered.ids.get("10%")!;
    const selectors = fixture(text).selectors;
    selectors.lots[0]!.scope_span_ids = [full];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [registered.ids.get(criterion)!];
    item.fields.name.span_ids = [registered.ids.get(criterion)!];
    item.fields.requirement.span_ids = [registered.ids.get(criterion)!];
    item.inspection_data_type_span_ids = [registered.ids.get(criterion)!];
    item.sampling = {
      status: "reference", rule_key: "general", branch_keys: ["ten-percent"],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "一般项目分支适用", confidence: 1,
    };
    selectors.sampling_rules = [{
      key: "general",
      complete_span_ids: [script],
      components: sharedSamplingDispositions(),
      branches: [{ key: "ten-percent", applies_to_category: "一般项目", components: branchSamplingComponents("ten-percent", [minimum], [script], []), reason: "一般项目分支" }],
      reason: "共享抽样规则",
    }];
    let compiled;
    try {
      compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      if (error instanceof TargetSelectorCompileError) throw new Error(JSON.stringify(error.issues));
      throw error;
    }
    const compiledItem = compiled.acceptance_items[0]!;
    const rule = compiled.shared_sampling_rules![0]!;
    expect(compiled.inspection_lots[0]!.item_ids).toEqual([compiledItem.item_id]);
    expect(compiledItem.sampling.min_sampling).toBe("10%");
    expect(compiledItem.sampling.script).toBe("抽查10%");
    expect(rule.receiving_item_ids).toEqual([compiledItem.item_id]);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);

    item.sampling = {
      status: "explicit", rule_key: "", branch_keys: [],
      quantity_span_ids: [minimum], script_span_ids: [script], condition_span_ids: [],
      reason: "条款内直接规定抽查比例", confidence: 1,
    };
    selectors.sampling_rules = [];
    selectors.references = [];
    const explicitPlan = compileTargetSelectors(selectors, registered.registry, manifest);
    const explicit = explicitPlan.acceptance_items[0]!;
    expect(explicit.sampling.min_sampling).toBe("10%");
    expect(explicit.sampling.script).toBe("抽查10%");
    expect(checkTargetCompilerInvariants(selectors, explicitPlan, manifest)).toEqual([]);
  });

  test("compiles an explicit applicable branch subset and rejects invalid selections", () => {
    const text = "构件承载力应符合要求。条件一时抽查一组并采用方法一。条件二时抽查两组并采用方法二。";
    const criterion = "构件承载力应符合要求。";
    const branchOne = "条件一时抽查一组并采用方法一。";
    const branchTwo = "条件二时抽查两组并采用方法二。";
    const ruleText = `${branchOne}${branchTwo}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, criterion, ruleText, branchOne, branchTwo, "条件一时", "抽查一组", "方法一", "条件二时", "抽查两组", "方法二"]);
    const selectors = fixture(text).selectors as any;
    selectors.lots[0].scope_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].criterion_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].fields.name.span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].fields.requirement.span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].inspection_data_type_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].sampling = {
      status: "reference",
      rule_key: "shared-rule",
      branch_keys: ["condition-one"],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "规则与项目语义关联成立", confidence: 1,
    };
    selectors.sampling_rules = [{
      key: "shared-rule",
      complete_span_ids: [registered.ids.get(ruleText)!],
      components: sharedSamplingDispositions(),
      branches: [
        { key: "condition-one", applies_to_category: "一般项目", components: branchSamplingComponents("condition-one", [registered.ids.get("抽查一组")!], [registered.ids.get("方法一")!], [registered.ids.get("条件一时")!]), reason: "第一个条件分支" },
        { key: "condition-two", applies_to_category: "一般项目", components: branchSamplingComponents("condition-two", [registered.ids.get("抽查两组")!], [registered.ids.get("方法二")!], [registered.ids.get("条件二时")!]), reason: "第二个条件分支" },
      ],
      reason: "同一项目类别下的条件分支必须完整保留",
    }];

    const plan = compileTargetSelectors(selectors, registered.registry, manifest);
    const compiledRule = plan.shared_sampling_rules?.[0];
    const compiledItem = plan.acceptance_items[0]!;
    expect(compiledRule?.branches).toHaveLength(2);
    expect(compiledItem.sampling.branch_ids).toEqual([compiledRule?.branches[0]?.branch_id]);
    expect(compiledItem.sampling.applied_branches?.map((branch) => branch.branch_id))
      .toEqual([compiledRule?.branches[0]?.branch_id]);
    expect(checkTargetCompilerInvariants(selectors, plan, manifest)).toEqual([]);

    const missingQuantity = structuredClone(selectors);
    missingQuantity.sampling_rules[0]!.branches[0]!.components = branchSamplingComponents(
      "condition-one",
      [],
      [registered.ids.get("方法一")!],
      [registered.ids.get("条件一时")!],
    );
    expect(() => compileTargetSelectors(missingQuantity, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_sampling_branch_quantity_missing",
            path: "/sampling_rules/0/branches/0",
          }),
          expect.objectContaining({
            code: "selector_sampling_selected_branch_quantity_missing",
            path: "/items/0/sampling/branch_keys/0",
          }),
        ]),
      }),
    );

    const unusedEmptySibling = structuredClone(selectors);
    unusedEmptySibling.sampling_rules[0]!.branches[1]!.components = branchSamplingComponents(
      "condition-two",
      [],
      [registered.ids.get("方法二")!],
      [registered.ids.get("条件二时")!],
    );
    try {
      compileTargetSelectors(unusedEmptySibling, registered.registry, manifest);
      throw new Error("expected unused empty-quantity sibling branch to fail compile");
    } catch (error) {
      expect(error).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_sampling_branch_quantity_missing",
            path: "/sampling_rules/0/branches/1",
            details: expect.objectContaining({
              required_action: "bind_source_quantity_or_declare_supported_unspecified_exception; remove_only_source_routing_branches",
            }),
          }),
        ]),
      });
      expect((error as { issues: Array<{ code: string }> }).issues.map((issue) => issue.code))
        .not.toContain("selector_sampling_selected_branch_quantity_missing");
    }

    const noSamplingEvidence = structuredClone(missingQuantity);
    noSamplingEvidence.items[0]!.sampling = {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "原文未提供可执行的抽样数量。",
      confidence: 1,
    };
    noSamplingEvidence.sampling_rules = [];
    expect(() => compileTargetSelectors(noSamplingEvidence, registered.registry, manifest)).not.toThrow();

    const expectSelectionIssue = (
      invalidSelectors: typeof selectors,
      code: string,
    ) => expect(() => compileTargetSelectors(invalidSelectors, registered.registry, manifest)).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ code, path: "/items/0/sampling/branch_keys" }),
          ]),
        }),
      );

    const empty = structuredClone(selectors);
    empty.items[0].sampling.branch_keys = [];
    expectSelectionIssue(empty, "selector_sampling_branch_required");

    const unknown = structuredClone(selectors);
    unknown.items[0].sampling.branch_keys = ["missing-branch"];
    expectSelectionIssue(unknown, "selector_sampling_branch_unknown");

    const duplicate = structuredClone(selectors);
    duplicate.items[0].sampling.branch_keys = ["condition-one", "condition-one"];
    expectSelectionIssue(duplicate, "selector_sampling_branch_duplicate");

    const categoryMismatch = structuredClone(selectors);
    categoryMismatch.sampling_rules[0].branches[0].applies_to_category = "主控项目";
    expectSelectionIssue(categoryMismatch, "selector_sampling_branch_category_mismatch");

    const unlabeled = structuredClone(selectors);
    unlabeled.items[0].category = UNLABELED_ITEM_CATEGORY;
    expectSelectionIssue(unlabeled, "selector_sampling_branch_category_mismatch");
    unlabeled.sampling_rules[0].branches[0].applies_to_category = "all_items";
    expect(() => compileTargetSelectors(unlabeled, registered.registry, manifest)).not.toThrow();
  });

  const fastenerRev2Root = join(
    "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A587b3a30ad2b3c947120dd40/revisions/000002",
  );
  test.runIf(
    existsSync(join(fastenerRev2Root, "working.target-selectors.json"))
    && existsSync(join(fastenerRev2Root, "source-span-registry.json"))
    && existsSync(join(fastenerRev2Root, "evidence/evidence.json")),
  )("replays the current 587b selector with one explicit branch per receiving item", async () => {
    const [selectorText, registryText, evidenceText] = await Promise.all([
      readFile(join(fastenerRev2Root, "working.target-selectors.json"), "utf8"),
      readFile(join(fastenerRev2Root, "source-span-registry.json"), "utf8"),
      readFile(join(fastenerRev2Root, "evidence/evidence.json"), "utf8"),
    ]);
    const selectors = migrateTargetSelectorPlan(JSON.parse(selectorText));
    const registry = JSON.parse(registryText) as SourceSpanRegistry;
    const evidence = JSON.parse(evidenceText) as EvidenceManifest;
    const selectedItems = selectors.items.filter((item) => item.sampling.status === "reference");

    expect(selectedItems.length).toBeGreaterThan(0);
    expect(selectedItems.every((item) => item.sampling.branch_keys.length === 1)).toBe(true);

    let plan: SemanticSourcePlan;
    try {
      plan = compileTargetSelectors(selectors, registry, evidence);
    } catch (error) {
      if (
        error instanceof TargetSelectorCompileError
        && error.issues.length > 0
        && error.issues.every((issue) => issue.code === "selector_source_language_mismatch")
      ) {
        // The mutable live-job fixture predates the source-language contract.
        // Its selector is intentionally invalid until that job is rematerialized.
        expect(error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "selector_source_language_mismatch" }),
        ]));
        return;
      }
      throw error;
    }
    for (const selectorItem of selectedItems) {
      const selectorRuleIndex = selectors.sampling_rules.findIndex((rule) =>
        rule.key === selectorItem.sampling.rule_key
      );
      const selectorRule = selectors.sampling_rules[selectorRuleIndex]!;
      const compiledRule = plan.shared_sampling_rules?.[selectorRuleIndex]!;
      const expectedBranchIds = selectorRule.branches.flatMap((branch, branchIndex) =>
        selectorItem.sampling.branch_keys.includes(branch.key)
          ? [compiledRule.branches[branchIndex]!.branch_id]
          : []
      );
      const compiledItem = plan.acceptance_items.find((item) =>
        item.item_id === semanticItemIdForSelectorKey(evidence.target_id, selectorItem.key)
      );
      expect(compiledItem?.sampling.branch_ids).toEqual(expectedBranchIds);
      expect(compiledItem?.sampling.applied_branches?.map((branch) => branch.branch_id))
        .toEqual(expectedBranchIds);
    }
    expect(checkTargetCompilerInvariants(selectors, plan, evidence)).toEqual([]);
  });

  test("materializes every explicitly submitted sampling branch with its own condition-method-quantity relation", () => {
    const text = "构件承载力应符合要求。条件一时抽查一组并采用方法一。条件二时抽查两组并采用方法二。";
    const criterion = "构件承载力应符合要求。";
    const ruleText = "条件一时抽查一组并采用方法一。条件二时抽查两组并采用方法二。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, criterion, ruleText, "条件一时", "抽查一组", "方法一", "条件二时", "抽查两组", "方法二"]);
    const selectors = fixture(text).selectors as any;
    selectors.lots[0].scope_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].criterion_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].fields.name.span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].fields.requirement.span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].inspection_data_type_span_ids = [registered.ids.get(criterion)!];
    selectors.items[0].sampling = {
      status: "reference",
      rule_key: "shared-rule",
      branch_keys: ["condition-two", "condition-one"],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "规则与项目语义关联成立", confidence: 1,
    };
    selectors.sampling_rules = [{
      key: "shared-rule",
      complete_span_ids: [registered.ids.get(ruleText)!],
      components: sharedSamplingDispositions(),
      branches: [
        { key: "condition-one", applies_to_category: "一般项目", components: branchSamplingComponents("condition-one", [registered.ids.get("抽查一组")!], [registered.ids.get("方法一")!], [registered.ids.get("条件一时")!]), reason: "第一个条件分支" },
        { key: "condition-two", applies_to_category: "一般项目", components: branchSamplingComponents("condition-two", [registered.ids.get("抽查两组")!], [registered.ids.get("方法二")!], [registered.ids.get("条件二时")!]), reason: "第二个条件分支" },
      ],
      reason: "同一项目类别下的条件分支必须完整保留",
    }];

    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    const sampling = compiled.acceptance_items[0]!.sampling as any;
    const rule = compiled.shared_sampling_rules![0]! as any;
    expect(sampling.branch_ids).toEqual(rule.branches.map((branch: any) => branch.branch_id));
    expect(sampling.applied_branches).toEqual(rule.branches.map((branch: any) => ({
      rule_id: rule.rule_id,
      branch_id: branch.branch_id,
      min_sampling: branch.min_sampling,
      script: branch.script,
      conditions: branch.conditions,
      evidence_ids: expect.arrayContaining([branch.evidence_id]),
    })));
    expect(rule.branches.map((branch: any) => branch.conditions.map((condition: any) => condition.text))).toEqual([
      ["条件一时"],
      ["条件二时"],
    ]);
    const materializedSampling = materialize(compiled, manifest, "multi-branch-plan").result.inspection_lots[0]!.items[0]!.sampling;
    expect(materializedSampling.branch_ids).toEqual(sampling.branch_ids);
    expect(materializedSampling.applied_branches).toEqual(sampling.applied_branches);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
  });

  test("migrates v3 item selection and v4 sampling rules into v6 without guessing unknown roles", () => {
    const { selectors } = fixture();
    const legacy = structuredClone(selectors) as any;
    legacy.schema_version = "target-selector-plan/v3";
    legacy.items[0].sampling.branch_key = "legacy-branch";
    delete legacy.items[0].sampling.branch_keys;

    const migrated = migrateTargetSelectorPlan(legacy) as any;
    expect(migrated.schema_version).toBe("target-selector-plan/v6");
    expect(migrated.items[0].sampling.branch_keys).toEqual(["legacy-branch"]);
    expect(migrated.items[0].sampling).not.toHaveProperty("branch_key");

    const legacyV4 = structuredClone(selectors) as any;
    legacyV4.schema_version = "target-selector-plan/v4";
    legacyV4.sampling_rules = [{
      key: "legacy-rule",
      complete_span_ids: [],
      branches: [{
        key: "legacy-branch",
        applies_to_category: "一般项目",
        minimum_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "旧 sealed/working 分支",
      }],
      shared_conditions: [],
      reason: "旧格式兼容输入",
    }];
    const authoringMigration = migrateTargetSelectorPlanForAuthoring(legacyV4);
    expect(authoringMigration.plan.schema_version).toBe("target-selector-plan/v6");
    expect(authoringMigration.plan.sampling_rules[0]!.branches[0]!.components).toHaveLength(3);
    expect(authoringMigration.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_sampling_component_migration_required",
        details: expect.objectContaining({
          missing_roles: ["applicability", "acceptance_criterion", "exception", "note"],
        }),
      }),
    ]));
  });

  test.skipIf(!existsSync(join(gb50202ReplayBase, "working.target-selectors.json")))(
    "rejects legacy GB50202 cross-item aggregates even after repairing f-001 sampling branches",
    async () => {
      const [manifestText, registryText, selectorText, lastValidText, coverageText] = await Promise.all([
        readFile(join(gb50202ReplayBase, "evidence", "evidence.json"), "utf8"),
        readFile(join(gb50202ReplayBase, "source-span-registry.json"), "utf8"),
        readFile(join(gb50202ReplayBase, "working.target-selectors.json"), "utf8"),
        readFile(join(gb50202ReplayBase, "last-valid.semantic-source-plan.json"), "utf8"),
        readFile(join(
          gb50202ReplayBase,
          "coverage-review",
          "5aef8a0587de6e6e9a05fbc96c4e1388f2a05d8ab318e18903726dc63a6e7a4d",
          "last-valid.coverage-review.json",
        ), "utf8"),
      ]);
      const manifest = JSON.parse(manifestText) as EvidenceManifest;
      const registry = JSON.parse(registryText) as SourceSpanRegistry;
      const lastValid = JSON.parse(lastValidText) as SemanticSourcePlan;
      const coverage = JSON.parse(coverageText) as { findings: Array<{ finding_id: string; exact_fragment: string }> };
      const selectors = migrateTargetSelectorPlan(JSON.parse(selectorText));
      selectors.references.forEach((reference) => {
        // Bring obsolete reference syntax up to the current authoring contract
        // before exercising this fixture's independent cross-item merge defect.
        if ((reference.application_mode as string) === "replace_field") reference.application_mode = "reference_placeholder";
        reference.destinations.forEach(destination => {
          if ((destination.target_field as string) === "reference_only") destination.target_field = "requirement";
        });
        reference.import_scope ??= {
          mode: "full_acceptance_procedure",
          allowed_fields: ["name", "requirement", "method", "quantity", "sampling"],
          reason: "历史回放 fixture 缺少当前必填的引用导入范围；保留原有完整引用语义。",
        };
      });
      selectors.items.forEach((candidate) => {
        candidate.fields.name.composition = "semantic_summary";
      });
      const item = selectors.items.find((candidate) => candidate.key === "item-bear")!;
      const rule = selectors.sampling_rules.find((candidate) => candidate.key === "rule-pile-bear")!;
      selectors.sampling_rules.forEach((candidate) => candidate.components.push(...sharedSamplingDispositions()));
      const oldItem = lastValid.acceptance_items.find((candidate) => candidate.name.includes("承载力"))!;
      const finding = coverage.findings.find((candidate) => candidate.finding_id === "f-001")!;

      expect(oldItem.sampling.branch_ids).toHaveLength(1);
      item.sampling.branch_keys = rule.branches
        .filter((branch) => branch.applies_to_category === "all_items" || branch.applies_to_category === item.category)
        .map((branch) => branch.key);

      expect(item.sampling.branch_keys).toHaveLength(2);
      expect(finding.exact_fragment).not.toBe("");
      // Branch materialization is covered by the independent synthetic test
      // above. This historical artifact also merged rows from different tables
      // and different check items; repairing sampling cannot waive those defects.
      expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({
          code: "selector_independent_items_merged",
          details: expect.objectContaining({ item_key: "item-bear" }),
        })]),
      }));
    },
  );

  test("derives explicit sampling from the same source fact used by quantity", () => {
    const { manifest, registry, selectors } = fixture("基层表面每检验批抽查10%。");
    const full = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.items[0]!.fields.quantity = {
      composition: "verbatim",
      span_ids: [full],
      separator: "",
      reason: "同一句原文是检查数量来源",
    };
    selectors.items[0]!.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [full],
      script_span_ids: [full],
      condition_span_ids: [],
      reason: "同一句原文确定性派生 quantity 和 explicit sampling",
      confidence: 1,
    };
    const compiled = compileTargetSelectors(selectors, registry, manifest);
    expect(compiled.acceptance_items[0]!.sampling).toMatchObject({
      status: "explicit",
      min_sampling: "基层表面每检验批抽查10%。",
      script: "抽查10%",
    });
    expect(compiled.shared_sampling_rules).toHaveLength(1);
    expect(compiled.shared_sampling_rules![0]!.receiving_item_ids).toEqual([
      compiled.acceptance_items[0]!.item_id,
    ]);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
    expect(validatePlanText(prettyJson(compiled), manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("keeps repeated explicit sampling text bound to each item's own source span", () => {
    const quantity = "检查数量: 同一工程、同一材料、同一生产厂家、同一型号、同一规格、同一批号检查一次。";
    const firstRequirement = "6.9.7 地毯面层采用的材料应符合设计要求。";
    const secondRequirement = "6.9.8 进场材料应有检测报告。";
    const firstClause = `${firstRequirement}${quantity}`;
    const secondClause = `${secondRequirement}${quantity}`;
    const text = `${firstClause}\n${secondClause}`;
    const { manifest, selectors } = fixture(text);
    const source = manifest.evidence[0]!;
    const immutableSource = {
      source_id: source.evidence_id,
      evidence_id: source.evidence_id,
      atom_id: source.evidence_id,
      text: source.text,
    };
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [immutableSource]);
    const first = registerSourceSpan(registry, immutableSource, 0, firstClause.length);
    registry = first.registry;
    const firstRequirementSpan = registerSourceSpan(registry, immutableSource, 0, firstRequirement.length);
    registry = firstRequirementSpan.registry;
    const firstQuantityStart = firstClause.indexOf(quantity);
    const firstQuantity = registerSourceSpan(registry, immutableSource, firstQuantityStart, firstQuantityStart + quantity.length);
    registry = firstQuantity.registry;
    const secondStart = firstClause.length + 1;
    const second = registerSourceSpan(registry, immutableSource, secondStart, secondStart + secondClause.length);
    registry = second.registry;
    const secondRequirementSpan = registerSourceSpan(
      registry,
      immutableSource,
      secondStart,
      secondStart + secondRequirement.length,
    );
    registry = secondRequirementSpan.registry;
    const secondQuantityStart = secondStart + secondClause.indexOf(quantity);
    const secondQuantity = registerSourceSpan(registry, immutableSource, secondQuantityStart, secondQuantityStart + quantity.length);
    registry = secondQuantity.registry;

    const configureExplicit = (item: TargetSelectorPlan["items"][number], requirementSpanId: string, quantitySpanId: string): void => {
      item.criterion_span_ids = [requirementSpanId];
      item.fields.requirement = { composition: "verbatim", span_ids: [requirementSpanId], separator: "", reason: "验收要求原文" };
      item.fields.quantity = { composition: "verbatim", span_ids: [quantitySpanId], separator: "", reason: "项内明确检查数量" };
      item.sampling = {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [quantitySpanId],
        script_span_ids: [quantitySpanId],
        condition_span_ids: [],
        reason: "每个项目各自明确同文检查数量",
        confidence: 1,
      };
    };
    configureExplicit(selectors.items[0]!, firstRequirementSpan.span.span_id, firstQuantity.span.span_id);
    const secondItem = structuredClone(selectors.items[0]!);
    secondItem.key = "surface-second";
    secondItem.name = "进场材料检测";
    configureExplicit(secondItem, secondRequirementSpan.span.span_id, secondQuantity.span.span_id);
    selectors.items.push(secondItem);

    const compiled = compileTargetSelectors(selectors, registry, manifest);
    expect(compiled.shared_sampling_rules).toHaveLength(2);
    expect(compiled.shared_sampling_rules!.map((rule) => rule.receiving_item_ids)).toEqual([
      [compiled.acceptance_items[0]!.item_id],
      [compiled.acceptance_items[1]!.item_id],
    ]);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
  });

  test("derives one immutable complete rule envelope from adjacent explicit sampling spans", () => {
    const requirementText = "基层表面应平整。";
    const text = `${requirementText}检查数量: 同一工程、同一体积比检查一次。检验方法: 观察检查和检查配合比试验报告。`;
    const quantityText = "检查数量: 同一工程、同一体积比检查一次。";
    const scriptText = "检验方法: 观察检查和检查配合比试验报告。";
    const { manifest, selectors } = fixture(text);
    const registered = registerQuotes(manifest, [text, requirementText, quantityText, scriptText]);
    selectors.items[0]!.criterion_span_ids = [registered.ids.get(requirementText)!];
    selectors.items[0]!.fields.requirement = {
      composition: "verbatim",
      span_ids: [registered.ids.get(requirementText)!],
      separator: "",
      reason: "验收要求原文",
    };
    selectors.items[0]!.fields.quantity = {
      composition: "verbatim",
      span_ids: [registered.ids.get(quantityText)!],
      separator: "",
      reason: "检查数量原文",
    };
    selectors.items[0]!.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [registered.ids.get(quantityText)!],
      script_span_ids: [registered.ids.get(scriptText)!],
      condition_span_ids: [],
      reason: "同一 evidence 中相邻的数量和方法共同构成完整抽样规则",
      confidence: 1,
    };

    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(compiled.shared_sampling_rules![0]!.complete_source_fragment).toBe(`${quantityText}${scriptText}`);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
    expect(validatePlanText(prettyJson(compiled), manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("does not let a line-broken method prefix truncate the complete shared sampling script", () => {
    const requirementText = "7.3.7 混凝土有抗冻要求时，应进行混凝土含气量检验。";
    const samplingPrefix = "检查数量：同一配合比的混凝土，取样不应少于一次，取样数量应符合现行国家标准《普通混凝土拌合物性能试验方法标";
    const samplingContinuation = "准》GB/T 50080 的规定。";
    const manifest = manifestFor(requirementText);
    const base = manifest.evidence[0]!;
    manifest.evidence = [
      { ...base, evidence_id: "evidence:requirement", text: requirementText, text_sha256: sha256Text(requirementText), locator: "line:1" },
      { ...base, evidence_id: "evidence:sampling-prefix", role: "context", text: samplingPrefix, text_sha256: sha256Text(samplingPrefix), locator: "line:2" },
      { ...base, evidence_id: "evidence:sampling-continuation", role: "context", text: samplingContinuation, text_sha256: sha256Text(samplingContinuation), locator: "line:3" },
    ];
    manifest.evidence_fingerprint = sha256Text(`line-broken-sampling\0${requirementText}\0${samplingPrefix}\0${samplingContinuation}`);
    const sources = manifest.evidence.map((record) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    }));
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
    const fullSpan = (evidenceId: string): string => {
      const record = manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
      return registry.spans.find((span) => (
        span.evidence_id === evidenceId && span.start === 0 && span.end === record.text.length
      ))!.span_id;
    };
    const requirementSpan = fullSpan("evidence:requirement");
    const prefixSpan = fullSpan("evidence:sampling-prefix");
    const continuationSpan = fullSpan("evidence:sampling-continuation");
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots = [{ key: "concrete", name: "混凝土检验批", scope_span_ids: [requirementSpan], reason: "7.3.7 验收范围" }];
    selectors.items = [{
      key: "air-content",
      lot_key: "concrete",
      name: "混凝土含气量检验",
      category: "一般项目",
      criterion_span_ids: [requirementSpan],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [requirementSpan], separator: "", reason: "检验对象" },
        requirement: { composition: "verbatim", span_ids: [requirementSpan], separator: "", reason: "含气量要求" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "无独立检验方法" },
        quantity: { composition: "verbatim", span_ids: [prefixSpan, continuationSpan], separator: "", reason: "跨行完整取样规则" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
      },
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "核验含气量检验结果。",
      inspection_data_type_span_ids: [requirementSpan],
      sampling: {
        status: "reference",
        rule_key: "sampling:7.3.7",
        branch_keys: ["same-mix"],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "使用完整的跨行取样规则",
        confidence: 1,
      },
      reason: "独立含气量验收项目",
    }];
    selectors.sampling_rules = [{
      key: "sampling:7.3.7",
      complete_span_ids: [prefixSpan, continuationSpan],
      components: [
        ...sharedSamplingDispositions(),
        { key: "shared-method-prefix", role: "method", disposition: "present", span_ids: [prefixSpan], reason: "断行前半段曾被重复标成方法" },
      ],
      branches: [{
        key: "same-mix",
        applies_to_category: "一般项目",
        components: branchSamplingComponents("same-mix", [prefixSpan, continuationSpan], [], []),
        reason: "同一配合比完整取样规则",
      }],
      reason: "原文跨两个连续 evidence 记录",
    }];

    const compiled = compileTargetSelectors(selectors, registry, manifest);
    const expected = `${samplingPrefix}${samplingContinuation}`;
    expect(compiled.shared_sampling_rules![0]!.branches[0]!.script).toBe("");
    expect(compiled.acceptance_items[0]!.sampling.script).toBe("");
    expect(compiled.acceptance_items[0]!.sampling.min_sampling).toBe(expected);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
    expect(validatePlanText(prettyJson(compiled), manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test.each(["reference", "reference_unspecified_quantity"] as const)("explains safe inline sampling repair for %s without discarding evidence", (status) => {
    const { manifest, registry, selectors } = fixture();
    const sampling = selectors.items[0]!.sampling;
    sampling.status = status;
    sampling.rule_key = "missing-shared-rule";
    sampling.branch_keys = ["selected-branch"];
    sampling.quantity_span_ids = [selectors.items[0]!.criterion_span_ids[0]!];
    const before = JSON.stringify(selectors);
    try {
      compileTargetSelectors(selectors, registry, manifest);
      throw new Error("expected conflicting sampling modes to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(entry => entry.code === "selector_nonexplicit_sampling_has_inline_spans");
      expect(issue).toMatchObject({
        path: "/items/0/sampling",
        details: {
          actual: { status, quantity_span_ids: sampling.quantity_span_ids },
          shared_rule_found: false,
          selected_rule_key: "missing-shared-rule",
          selected_branch_keys: ["selected-branch"],
          required_action: "verify_shared_rule_evidence_then_clear_inline_spans",
          required_inline_values_for_current_mode: { quantity_span_ids: [], script_span_ids: [], condition_span_ids: [] },
          read_tool: "read_target_selectors",
          next_tool: "stage_target_selector_draft",
        },
      });
      expect(issue!.message).toContain("先确认");
      const missingRule = (error as TargetSelectorCompileError).issues.find(entry => entry.code === "selector_sampling_rule_missing") as any;
      expect(missingRule).toMatchObject({
        path: "/items/0/sampling/rule_key",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "declare_real_shared_sampling_rule_or_change_item_sampling_mode",
          actual: {
            item_key: "surface",
            status,
            rule_key: "missing-shared-rule",
            declared_rule_keys: [],
          },
          writable_paths: ["/sampling_rules", "/items/0/sampling"],
          candidate_read_tool: "read_target_selectors",
          next_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("两种合法修法"),
        },
      });
    }
    expect(JSON.stringify(selectors)).toBe(before);
  });

  test("sampling schema explains mutually exclusive authoring modes", () => {
    const sampling = TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties.items.items.properties.sampling;
    expect(sampling.properties.rule_key.description).toContain("explicit/fallback/not_sampling");
    for (const field of ["quantity_span_ids", "script_span_ids"] as const) {
      expect(sampling.properties[field].description).toContain("仅 explicit");
      expect(sampling.properties[field].description).toContain("必须填 []");
    }
    expect(sampling.properties.condition_span_ids.description).toContain("not_sampling 必须绑定原文");
    expect(sampling.properties.condition_span_ids.description).toContain("未单列数量不能证明不抽样");
  });

  test("rejects a declared shared sampling rule that no item selects before strict compilation", () => {
    const { manifest, registry, selectors } = fixture("基层表面每检验批抽查10%。");
    const full = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.sampling_rules = [{
      key: "unused-threshold",
      complete_span_ids: [full],
      components: sharedSamplingDispositions(),
      branches: [{
        key: "general",
        applies_to_category: "一般项目",
        components: branchSamplingComponents("general", [full], [full], []),
        reason: "无人选择的多余规则",
      }],
      reason: "应在 selector 层阻止空 receiver",
    }];

    try {
      compileTargetSelectors(selectors, registry, manifest);
      throw new Error("expected selector compiler to reject an unreferenced rule");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_sampling_rule_unreferenced") as any;
      expect(issue).toMatchObject({
        code: "selector_sampling_rule_unreferenced",
        path: "/sampling_rules/0",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "select_the_rule_from_each_semantic_receiver_or_remove_the_unused_rule",
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors"],
          next_tool: "read_target_selectors",
          next_tools: ["read_target_selectors", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          writable_paths: expect.arrayContaining(["/sampling_rules/0", "/items"]),
          how_to_pass: expect.stringContaining("二选一完成修复"),
        },
      });
    }
  });

  test("rejects a present sampling method component without an evidence span", () => {
    const { manifest, registry, selectors } = fixture("基层表面每检验批抽查10%。");
    const full = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.items[0]!.sampling = {
      status: "reference",
      rule_key: "general",
      branch_keys: ["ten-percent"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "选择共享抽样分支",
      confidence: 1,
    };
    selectors.sampling_rules = [{
      key: "general",
      complete_span_ids: [full],
      components: sharedSamplingDispositions(),
      branches: [{
        key: "ten-percent",
        applies_to_category: "一般项目",
        components: [
          ...branchSamplingComponents("ten-percent", [full], [], []),
          { key: "invalid-present-method", role: "method", disposition: "present", span_ids: [], reason: "声明存在却未绑定" },
        ],
        reason: "缺少可执行话述 span",
      }],
      reason: "共享抽样规则",
    }];

    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_sampling_component_binding_invalid",
            path: "/sampling_rules/0/branches/0/components/3/span_ids",
          }),
        ]),
      }),
    );
  });

  test("folds multiple span dispositions into one evidence disposition", () => {
    const text = "基层表面应平整。灰土垫层标题。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, "基层表面应平整。", "灰土垫层标题。"]);
    const selectors = fixture(text).selectors;
    const criterion = registered.ids.get("基层表面应平整。")!;
    selectors.lots[0]!.scope_span_ids = [criterion];
    selectors.items[0]!.criterion_span_ids = [criterion];
    selectors.items[0]!.fields.name.span_ids = [criterion];
    selectors.items[0]!.fields.requirement.span_ids = [criterion];
    selectors.items[0]!.inspection_data_type_span_ids = [criterion];
    selectors.source_dispositions = [
      { span_ids: [registered.ids.get("灰土垫层标题。")!], disposition: "context", reason: "标题上下文" },
      { span_ids: [registered.ids.get("基层表面应平整。")!], disposition: "ignored", reason: "重复 atom 内的局部处置" },
    ];
    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(compiled.evidence_dispositions.filter((entry) => entry.evidence_id === manifest.evidence[0]!.evidence_id)).toHaveLength(1);
  });

  test("derives reference parentage and destination field materialization", () => {
    const text = "基层表面应符合表4.1.7。表4.1.7规定用2m靠尺检查。";
    const anchorText = "基层表面应符合表4.1.7。";
    const targetText = "表4.1.7规定用2m靠尺检查。";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, anchorText, targetText]);
    const selectors = fixture(text).selectors;
    const anchor = registered.ids.get(anchorText)!;
    selectors.lots[0]!.scope_span_ids = [anchor];
    selectors.items[0]!.criterion_span_ids = [anchor];
    selectors.items[0]!.fields.name.span_ids = [anchor];
    selectors.items[0]!.fields.requirement.span_ids = [anchor];
    selectors.items[0]!.inspection_data_type_span_ids = [anchor];
    selectors.references = [{
      key: "table-method",
      anchor_span_ids: [anchor],
      target_span_ids: [registered.ids.get(targetText)!],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["method"], reason: "引用只替换方法字段。" },
      destinations: [{ item_key: "surface", target_field: "method" }],
      reason: "引用表格检验方法",
    }];
    let compiled;
    try {
      compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      if (error instanceof TargetSelectorCompileError) throw new Error(JSON.stringify(error.issues));
      throw error;
    }
    const anchorNode = compiled.semantic_evidence!.find((node) => node.role === "reference_anchor")!;
    const targetNode = compiled.semantic_evidence!.find((node) => node.role === "referenced_clause")!;
    expect(targetNode.parent_semantic_id).toBe(anchorNode.semantic_id);
    expect(compiled.acceptance_items[0]!.field_bindings.method.composition).not.toBe("reference");
    expect(anchorNode.exact_fragment).toBe(anchorText);
    expect(compiled.semantic_references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        anchor_semantic_id: anchorNode.semantic_id,
        target_semantic_ids: expect.arrayContaining([targetNode.semantic_id]),
      }),
    ]));
  });

  test("rejects a resolved reference without a typed destination before compilation", () => {
    const { manifest, registry, selectors } = fixture();
    const spanId = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.references = [{
      key: "missing-destination",
      anchor_span_ids: [spanId],
      target_span_ids: [spanId],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "缺失 destination 的结构测试。" },
      destinations: [],
      reason: "构造缺失接收字段的已解析引用",
    }];

    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_destination_required",
          path: "/references/0/destinations",
          details: expect.objectContaining({
            required_action: "choose_a_valid_reference_receiver_route_from_the_source",
            allowed_actions: [expect.stringContaining("reference_only")],
            next_tool: "read_target_selectors",
            next_tools: expect.arrayContaining(["list_reference_occurrences", "stage_target_selector_draft"]),
            save_tool: "stage_target_selector_draft",
          }),
        }),
      ]));
    }
  });

  test("explains conditional receivers for a resolved clause without selecting a site method", () => {
    const { manifest, registry, selectors } = fixture("构件可用甲或乙工法，验收应符合第4.2节。");
    const source = manifest.evidence[0]!;
    const originSpanId = selectors.items[0]!.criterion_span_ids[0]!;
    const targetEvidenceId = "atom:method-b-rule";
    const targetText = "表4.2.1 | 乙工法连接外观 | 裂纹 | 不得有";
    manifest.evidence.push({
      ...source,
      evidence_id: targetEvidenceId,
      kind: "table_row",
      role: "context",
      text: targetText,
      text_sha256: sha256Text(targetText),
      evidence_scope: "reference",
      requires_disposition: false,
      registered_dependency: true,
      table_id: "4.2.1",
      cells: ["乙工法连接外观", "裂纹", "不得有"],
    });
    manifest.reference_occurrences.push({
      occurrence_id: "reference:method-b-clause",
      origin_evidence_id: source.evidence_id,
      origin_span_id: originSpanId,
      reference_literal_span_id: originSpanId,
      origin_fields: ["requirement"],
      raw_reference: "第4.2节",
      target_evidence_ids: [targetEvidenceId],
      required: true,
      status: "resolved",
      depth: 1,
      path: ["source:clause:4.2"],
      reference_kind: "clause",
      target_address: { source_id: "source", locator_kind: "clause", locator: "4.2" },
    });
    selectors.references = [{
      key: "method-b-clause",
      occurrence_id: "reference:method-b-clause",
      anchor_span_ids: [originSpanId],
      target_span_ids: [],
      action: "review",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "按来源条件核对。" },
      destinations: [],
      reason: "保留原引用和本地适用条件，待建立真实接收关系。",
    }];

    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected an unresolved receiver route");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find((row) =>
        row.code === "selector_reference_destination_required");
      expect(issue?.details).toMatchObject({
        reference_key: "method-b-clause",
        writable_paths: expect.arrayContaining(["/references/0/destinations", "/items"]),
        writable_collections: ["references", "items", "source_dispositions"],
        context_reference_alternative: { expected: { origin_context_coverage: "all_complete_and_explicit", business_origin_bindings: [] } },
        allowed_actions: expect.arrayContaining([
          expect.stringContaining("新增真实 item"),
          expect.stringContaining("不需推断现场最终采用哪支工法"),
        ]),
        candidate_read_tools: expect.arrayContaining([
          "read_target_selectors", "list_reference_occurrences",
          "read_document_reference_evidence", "read_reference_facts",
        ]),
        next_tool: "list_reference_occurrences",
        save_tool: "stage_target_selector_draft",
        save_tool_instruction: expect.stringContaining("draft.items"),
        how_to_pass: expect.stringContaining("现场工法未选定不阻止条件性抽取"),
      });
      expect(String(issue?.details?.how_to_pass).length).toBeLessThanOrEqual(420);
      expect(issue?.details?.placeholder_values).toBeUndefined();
    }
  });

  test("returns an executable read-then-save route for an unknown reference destination key", () => {
    const { manifest, registry, selectors } = fixture();
    const spanId = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.references = [{
      key: "stale-destination",
      anchor_span_ids: [spanId],
      target_span_ids: [spanId],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "中性引用路由测试。" },
      destinations: [{ item_key: "removed-item", target_field: "requirement" }],
      reason: "模拟增量编辑后遗留的旧 item key。",
    }];

    try {
      compileTargetSelectors(selectors, registry, manifest);
      throw new Error("expected an unknown destination item key");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(
        (entry) => entry.code === "selector_reference_destination_missing",
      ) as any;
      expect(issue).toMatchObject({
        path: "/references/0/destinations/0/item_key",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          reference_key: "stale-destination",
          unknown_item_key: "removed-item",
          target_field: "requirement",
          required_action: "repair_or_remove_the_unknown_reference_destination_from_source_evidence",
          writable_paths: [
            "/references/0/destinations/0",
            "/references/0/component_dispositions",
          ],
          writable_collections: ["references"],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence"],
          next_tool: "read_target_selectors",
          next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("不得猜测 item_key"),
        },
      });
    }
  });

  test("rejects external_reference_placeholder keep_reference/reference_only without origin-field destination", () => {
    const text = "检查数量：应符合现行国家标准《建筑工程施工质量验收统一标准》GB 50300 的规定。";
    const { manifest, registry, selectors } = fixture(text);
    const full = selectors.items[0]!.criterion_span_ids[0]!;
    const occurrenceId = "reference:external-gb50300-sampling";
    manifest.reference_occurrences.push({
      occurrence_id: occurrenceId,
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      origin_evidence_ids: [manifest.evidence[0]!.evidence_id],
      origin_span_id: full,
      origin_span_ids: [full],
      reference_literal_span_id: full,
      reference_literal_span_ids: [full],
      origin_fields: ["requirement"],
      raw_reference: "GB 50300",
      relation: "sampling_standard",
      external_standard: { standard_no: "GB 50300", status: "placeholder" },
      target_evidence_ids: [],
      required: false,
      status: "target_not_found",
      depth: 1,
      path: ["external-standard:GB50300:standard:GB50300"],
      reference_kind: "clause",
      target_address: {
        source_id: "external-standard:GB50300",
        locator_kind: "standard",
        locator: "standard:GB50300",
      },
    });
    selectors.references = [{
      key: "external-sampling-ref",
      occurrence_id: occurrenceId,
      anchor_span_ids: [full],
      target_span_ids: [],
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["requirement"],
        reason: "外部标准占位只保留原业务字段引用位置。",
      },
      destinations: [],
      reason: "外部正文不可用，按 guidance 保留原业务字段引用。",
    }];

    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registry, manifest);
    } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find(
        (entry) => entry.code === "selector_reference_destination_required",
      );
      expect(issue).toMatchObject({
        code: "selector_reference_destination_required",
        path: "/references/0/destinations",
        details: expect.objectContaining({
          origin_field: "requirement",
          external_reference_placeholder: true,
          required_action: "choose_a_valid_reference_receiver_route_from_the_source",
          allowed_actions: [expect.stringContaining("reference_only")],
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
        }),
      });
      const details = issue?.details as Record<string, unknown> | undefined;
      const unresolved = details?.unresolved_values as Record<string, unknown> | undefined;
      expect(unresolved?.destinations).not.toEqual([]);
    }

    selectors.references[0]!.destinations = [{ item_key: "surface", target_field: "requirement" }];
    expect(() => compileTargetSelectors(selectors, registry, manifest)).not.toThrow();
  });

  test("advances an unfinished primary draft without claiming source coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-stage-gate-"));
    try {
      const { manifest, selectors } = fixture();
      const omittedText = "另一个已纳入 target scope 的原始证据。";
      manifest.evidence.push({
        evidence_id: "atom:omitted-primary",
        kind: "paragraph",
        role: "supporting_clause",
        locator: `char:0-${omittedText.length}`,
        text: omittedText,
        text_sha256: sha256Text(omittedText),
        requires_disposition: true,
        evidence_scope: "primary",
      });
      manifest.scope.selected_atom_ids = [
        ...(manifest.scope.selected_atom_ids ?? []),
        "atom:omitted-primary",
      ];
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(`${manifest.evidence[0]!.text}\n${omittedText}`) },
      );
      const controller = await ToolController.create(workspace);
      await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { lots: selectors.lots },
      });
      await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: selectors.items },
      });

      const blocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
      expect(blocked).toMatchObject({ok:true,stage:"sampling",draft_status:"stage_complete",content_validation_performed:true,budget_consumed:false,global_candidate_complete:false});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("pages a large primary evidence backlog without losing obligations or consuming submission budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-primary-page-"));
    try {
      const { manifest, selectors } = fixture();
      for (let index = 0; index < 278; index += 1) {
        const text = `第${index + 1}份测试背景说明。`;
        manifest.evidence.push({
          evidence_id: `evidence:${sha256Text(`primary-page-${index}`)}`,
          kind: "paragraph", role: "context", locator: `line:${index + 2}`,
          text, text_sha256: sha256Text(text),
          requires_disposition: index % 2 === 0, evidence_scope: "primary",
        });
      }
      const workspace = await RevisionWorkspace.createFromEvidence(
        root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence.map((record) => record.text).join("\n")) },
      );
      const controller = await ToolController.create(workspace);
      await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { lots: selectors.lots } });
      await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { items: selectors.items } });
      const before = await workspace.readState();
      const advanced = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
      expect(advanced).toMatchObject({ok:true,stage:"sampling",draft_status:"stage_complete",content_validation_performed:true});
      expect(advanced).not.toHaveProperty("selector_issues");
      expect(await workspace.readEvidenceManifest()).toEqual(manifest);
      expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
      const submitted = await controller.dispatch("compile_target_selectors", {});
      expect(submitted.ok).toBe(false);
      expect(JSON.stringify(submitted)).toContain("compiler_unhandled_evidence");
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("allows a saved reference draft to advance while its destination is unfinished", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-reference-stage-gate-"));
    try {
      const { manifest, selectors } = fixture();
      const spanId = selectors.items[0]!.criterion_span_ids[0]!;
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { lots: selectors.lots } });
      await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { items: selectors.items } });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }))
        .toMatchObject({ ok: true, stage: "sampling" });
      await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { references: [{
          key: "missing-destination",
          anchor_span_ids: [spanId],
          target_span_ids: [spanId],
          action: "adopt",
          application_mode: "reference_only",
          destinations: [],
          reason: "已解析引用必须声明接收字段",
        }] },
      });

      const blocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
      expect(blocked).toMatchObject({ok:true,stage:"table",draft_status:"stage_complete",content_validation_performed:true,budget_consumed:false});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("returns registry-backed full-span bindings for unhandled evidence at commit preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-actionable-unhandled-"));
    try {
      const { manifest, selectors } = fixture();
      const omittedText = "纳入目标但尚未获得语义角色的原始证据。";
      manifest.evidence.push({
        evidence_id: "atom:unhandled-actionable",
        kind: "paragraph",
        role: "supporting_clause",
        locator: `char:0-${omittedText.length}`,
        text: omittedText,
        text_sha256: sha256Text(omittedText),
        requires_disposition: true,
        evidence_scope: "primary",
      });
      manifest.scope.selected_atom_ids = [
        ...(manifest.scope.selected_atom_ids ?? []),
        "atom:unhandled-actionable",
      ];
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(`${manifest.evidence[0]!.text}\n${omittedText}`) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: selectors.items },
      });

      expect(staged).toMatchObject({ok:true,draft_status:"saved_local_validation_passed",content_validation_performed:true});
      const stageBlocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      const stageIssue = (stageBlocked.selector_issues as Array<Record<string, any>>)
        .find((entry) => entry.code === "compiler_unhandled_evidence")!;
      expect(stageIssue).toMatchObject({
        message: "编译器未能物化所有必须处理的来源；请依据原文补齐真实业务绑定或显式来源处置。",
        actual: {
          evidence_ids: ["atom:unhandled-actionable"],
          candidate_spans: expect.arrayContaining([expect.objectContaining({
            evidence_id: "atom:unhandled-actionable",
            span_id: expect.stringMatching(/^span:/),
            start: 0,
            end: omittedText.length,
          })]),
        },
        writable_paths: ["/items", "/sampling_rules", "/references", "/lots", "/source_dispositions"],
        writable_collections: ["items", "sampling_rules", "references", "lots", "source_dispositions"],
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: "atom:unhandled-actionable", cursor: 0 },
        save_tool: "stage_target_selector_draft",
      });
      expect(stageIssue.allowed_actions).toEqual([
        expect.stringContaining("真实业务内容"),
        expect.stringContaining("仅是实际验收范围或分组依据"),
        expect.stringContaining("非业务上下文"),
      ]);
      expect(stageIssue.how_to_pass).toContain("与来源含义一致的合法路径");
      expect(stageIssue.how_to_pass).toContain("draft.lots.scope_span_ids");
      expect(stageIssue.how_to_pass).toContain("实际适用字段");
      expect(stageIssue.how_to_pass).toContain("draft.source_dispositions");
      expect(stageIssue.how_to_pass).toContain("不替模型决定");
      expect(stageIssue.details.repair_identity).toEqual({
        kind: "evidence_id",
        evidence_ids: ["atom:unhandled-actionable"],
      });
      expect(stageIssue.details.post_save_verification).toMatchObject({
        tool: "advance_target_selector_stage",
        same_identity_meaning: expect.stringContaining("仍未形成有效的来源处置"),
        required_action: expect.stringContaining("actual.evidence_ids 与 actual.candidate_spans"),
      });
      expect(stageIssue.do_not_edit).toContain("未列入 actual.evidence_ids 的其他来源");
      expect(stageIssue.details.binding_requirement).toContain("仅有 anchor_span_ids 或 origin_binding 定位");
      expect(stageIssue.actual.reference_anchor_bindings).toEqual([]);
      expect(stageIssue.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(stageIssue.details.save_tool_instruction).toContain("draft.source_dispositions");
      expect(stageIssue.details.source_access).toEqual([expect.objectContaining({
        evidence_id: "atom:unhandled-actionable", access_mode: "direct", read_tool: "open_evidence",
        tool_arguments: { evidence_id: "atom:unhandled-actionable", cursor: 0 },
      })]);
      const evidenceTool = createPiTools(controller).find((tool) => tool.name === stageIssue.next_tool)!;
      expect(Check(evidenceTool.parameters, stageIssue.next_tool_arguments)).toBe(true);
      const submitted = await controller.dispatch("compile_target_selectors",{});
      expect(submitted).toMatchObject({
        ok: false,
        terminal: false,
        stage: "target-selectors",
        allowed_bindings: expect.arrayContaining([
          expect.objectContaining({
            evidence_id: "atom:unhandled-actionable",
            span_id: expect.stringMatching(/^span:/),
          }),
        ]),
        required_action: "bind_semantically_or_stage_source_disposition",
        selector_issues: expect.arrayContaining([
          expect.objectContaining({
            code: "compiler_unhandled_evidence",
            owner: "selector_input_error",
            path: "/source_dispositions",
            next_tool: "open_evidence",
            next_tool_arguments: { evidence_id: "atom:unhandled-actionable", cursor: 0 },
            details: expect.objectContaining({
              compiled_path: "/evidence_dispositions",
              writable_collection: "source_dispositions",
              required_action: "bind_semantically_or_stage_an_explicit_source_disposition",
            }),
          }),
        ]),
      });
      expect(submitted).not.toHaveProperty("compiled_plan_sha256");
      expect(submitted).not.toHaveProperty("issues");
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 0,
        corrections: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("reports each uncovered source as an executable issue and advances after one valid disposition", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-atomic-unhandled-"));
    try {
      const { manifest, selectors } = fixture();
      const sources = [
        { evidence_id: "atom:neutral-context-a", text: "背景说明甲，不提出验收要求。" },
        { evidence_id: "atom:neutral-context-b", text: "基层接缝应连续。" },
      ];
      const markdown = [manifest.evidence[0]!.text, ...sources.map((source) => source.text)].join("\n");
      for (const source of sources) {
        manifest.evidence.push({
          evidence_id: source.evidence_id,
          kind: "paragraph",
          role: "context",
          locator: `char:${markdown.indexOf(source.text)}-${markdown.indexOf(source.text) + source.text.length}`,
          text: source.text,
          text_sha256: sha256Text(source.text),
          requires_disposition: true,
          evidence_scope: "primary",
        });
        manifest.scope.selected_atom_ids!.push(source.evidence_id);
      }
      const workspace = await RevisionWorkspace.createFromEvidence(
        root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(markdown) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);

      const blocked = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      expect(blocked).toMatchObject({ ok: false, error: "selector_stage_incomplete" });
      const groups = (blocked.selector_issues as Array<Record<string, any>>)
        .filter((issue) => issue.code === "compiler_unhandled_evidence");
      expect(groups).toHaveLength(1);
      expect(blocked.selector_issue_page).toMatchObject({ raw_issue_count: sources.length });
      const issues = groups.flatMap((group) => (
        (group.details.members ?? [group.details]).map((member: Record<string, any>) => ({
          ...group,
          ...member,
          details: { ...group.details, ...member },
        }))
      ));
      expect(issues).toHaveLength(sources.length);
      expect(issues.map((issue) => issue.actual.evidence_ids)).toEqual(
        sources.map((source) => [source.evidence_id]),
      );
      for (const issue of issues) {
        expect(issue.details.source_access).toEqual([
          expect.objectContaining({ evidence_id: issue.actual.evidence_ids[0] }),
        ]);
        expect(issue.next_tool).toBe("open_evidence");
        expect(issue.next_tool_arguments).toEqual({ evidence_id: issue.actual.evidence_ids[0], cursor: 0 });
        const tool = createPiTools(controller).find((candidate) => candidate.name === issue.next_tool)!;
        expect(Check(tool.parameters, issue.next_tool_arguments)).toBe(true);
      }

      const first = issues[0]!;
      expect(await controller.dispatch(first.next_tool, first.next_tool_arguments)).toMatchObject({ ok: true });
      const afterRead = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      const readIssue = (afterRead.selector_issues as Array<Record<string, any>>)
        .find(issue => issue.actual?.evidence_ids?.includes(sources[0]!.evidence_id))!;
      expect(readIssue.how_to_pass).toContain("draft.source_dispositions");
      expect(readIssue.how_to_pass).toContain("不得把真实判据降为上下文");
      expect(readIssue.writable_collections).toContain("source_dispositions");
      expect(readIssue.next_tool_arguments).toEqual({ collection: "source_dispositions", evidence_ids: [sources[0]!.evidence_id] });
      expect(readIssue.details.repair_options).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source_disposition", next_tool_arguments: { collection: "source_dispositions", evidence_ids: [sources[0]!.evidence_id] } }),
        expect.objectContaining({ kind: "bind_source", next_tool_arguments: { collection: "items" } }),
      ]));
      expect(readIssue.how_to_pass).toContain("调查交接");
      expect(await controller.dispatch(readIssue.next_tool, readIssue.next_tool_arguments))
        .toMatchObject({ ok: true, view: "records", matching_record_count: 0, rows: [] });
      const unrelatedItem = structuredClone(selectors.items[0]!);
      unrelatedItem.reason = "保留当前项目，不改变被点名来源的绑定。";
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert", draft: { items: [unrelatedItem] },
      })).toMatchObject({ ok: true });
      const unrelatedRetry = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      expect(unrelatedRetry).toMatchObject({ actual: { issue_count: sources.length }, stage_retry: { progress: "stagnation" } });
      const sourceSpan = first.actual.candidate_spans.find((span: { start: number; end: number }) =>
        span.start === 0 && span.end === sources[0]!.text.length,
      );
      expect(sourceSpan?.span_id).toMatch(/^span:/);
      const saved = await controller.dispatch(readIssue.save_tool, {
        operation: "upsert",
        draft: { source_dispositions: [{
          span_ids: [sourceSpan.span_id],
          disposition: "context",
          reason: "已读原文仅为背景说明，不提出验收要求。",
        }] },
      });
      expect(saved).toMatchObject({ ok: true });

      const remaining = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      const remainingIssues = (remaining.selector_issues as Array<Record<string, any>>)
        .filter((issue) => issue.code === "compiler_unhandled_evidence");
      expect(remainingIssues).toHaveLength(1);
      expect(remainingIssues[0]).toMatchObject({
        actual: { evidence_ids: [sources[1]!.evidence_id] },
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: sources[1]!.evidence_id, cursor: 0 },
      });
      expect((await workspace.readState()).selector_stage).toBe("table");
      expect(await controller.dispatch(remainingIssues[0]!.next_tool, remainingIssues[0]!.next_tool_arguments)).toMatchObject({ ok: true });
      const afterSecondRead = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
      const businessIssue = (afterSecondRead.selector_issues as Array<Record<string, any>>)[0]!;
      const businessRoute = businessIssue.details.repair_options.find((option: any) => option.kind === "bind_source");
      expect(await controller.dispatch(businessRoute.next_tool, businessRoute.next_tool_arguments)).toMatchObject({ ok: true });
      const current = migrateTargetSelectorPlan(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")));
      const item = structuredClone(current.items[0]!);
      const secondSpan = businessIssue.actual.candidate_spans.find((span: any) => span.start === 0 && span.end === sources[1]!.text.length)!;
      item.criterion_span_ids.push(secondSpan.span_id);
      item.fields.requirement.span_ids.push(secondSpan.span_id);
      expect(await controller.dispatch(businessIssue.save_tool, { operation: "upsert", draft: { items: [item] } })).toMatchObject({ ok: true });
      expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" })).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("reports saved reference anchors without treating them as materialized source dispositions", () => {
    const { manifest, registry: initialRegistry, selectors } = fixture();
    const evidenceId = "atom:anchor-only-context";
    const text = "相关背景参见附录甲。";
    manifest.evidence.push({
      evidence_id: evidenceId, kind: "paragraph", role: "context",
      locator: `char:0-${text.length}`, text, text_sha256: sha256Text(text),
      requires_disposition: true, evidence_scope: "primary",
    });
    const { registry, span } = registerSourceSpan(initialRegistry, {
      source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text,
    }, 0, text.length);
    selectors.references = [{
      key: "background-reference", anchor_span_ids: [span.span_id],
      target_span_ids: selectors.items[0]!.criterion_span_ids,
      action: "adopt", application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用要求" },
      destinations: [{ item_key: selectors.items[0]!.key, target_field: "requirement" }],
      reason: "记录引用定位",
    }];
    const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
    const issues = checkTargetCompilerInvariants(selectors, hydrateSemanticSourcePlan(compiled, manifest), manifest)
      .filter((entry) => entry.code === "compiler_unhandled_evidence");
    expect(issues).toHaveLength(1);
    expect(compiled.evidence_dispositions.map((entry) => entry.evidence_id)).not.toContain(evidenceId);
    const [feedback] = classifyStrictSelectorIssues(selectors, compiled, registry, issues);
    expect(feedback).toMatchObject({
      owner: "selector_input_error",
      details: {
        actual: { reference_anchor_bindings: [{
          reference_key: "background-reference", evidence_id: evidenceId, span_id: span.span_id,
          path: "/references/0/anchor_span_ids/0",
        }] },
        repair_identity: { kind: "evidence_id", evidence_ids: [evidenceId] },
        save_tool: "stage_target_selector_draft",
        post_save_verification: {
          same_identity_meaning: expect.stringContaining("仍未形成有效的来源处置"),
        },
      },
    });
    expect(JSON.stringify(feedback)).not.toContain("仍未保存任何");
    expect(SELECTOR_PATCH_GUIDANCE).not.toContain("仍未使用属于该 evidence 的已登记 span");

    // Explicit semantic disposition is an author action; an anchor alone must not silence the invariant.
    selectors.source_dispositions = [{ span_ids: [span.span_id], disposition: "context", reason: "此来源仅提供背景引用" }];
    const repaired = compileTargetSelectorsPersisted(selectors, registry, manifest);
    expect(checkTargetCompilerInvariants(selectors, hydrateSemanticSourcePlan(repaired, manifest), manifest)
      .filter((entry) => entry.code === "compiler_unhandled_evidence")).toEqual([]);
    expect(repaired.evidence_dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_id: evidenceId, disposition: "context" }),
    ]));
  });

  test("routes each local reference anchor only to its own destination item", () => {
    const firstText = "锤击桩桩位应符合表5.1.2。";
    const secondText = "静压桩桩位应符合表5.1.2。";
    const targetText = "表5.1.2规定桩位允许偏差。";
    const { manifest, registry: initialRegistry, selectors } = fixture(firstText);
    let registry = initialRegistry;
    const addEvidence = (evidenceId: string, text: string) => {
      manifest.evidence.push({
        evidence_id: evidenceId,
        kind: "paragraph",
        role: "supporting_clause",
        locator: `char:0-${text.length}`,
        text,
        text_sha256: sha256Text(text),
        requires_disposition: false,
        evidence_scope: "reference",
      });
      const registered = registerSourceSpan(registry, {
        source_id: evidenceId,
        evidence_id: evidenceId,
        atom_id: evidenceId,
        text,
      }, 0, text.length);
      registry = registered.registry;
      return registered.span.span_id;
    };
    const secondSpanId = addEvidence("atom:second-local-anchor", secondText);
    const targetSpanId = addEvidence("atom:shared-reference-target", targetText);
    const locateQuote = (evidenceId: string, text: string, quote: string) => {
      const located = locateAndRegisterSourceQuote(registry, {
        source_id: evidenceId,
        evidence_id: evidenceId,
        atom_id: evidenceId,
        text,
      }, quote);
      registry = located.registry;
      return located.spans[0]!.span_id;
    };
    const firstAnchorId = locateQuote(manifest.evidence[0]!.evidence_id, firstText, "表5.1.2");
    const secondAnchorId = locateQuote("atom:second-local-anchor", secondText, "表5.1.2");

    const secondItem = structuredClone(selectors.items[0]!);
    secondItem.key = "surface-static";
    secondItem.name = "静压桩桩位";
    secondItem.criterion_span_ids = [secondSpanId];
    secondItem.fields.name.span_ids = [secondSpanId];
    secondItem.fields.requirement.span_ids = [secondSpanId];
    secondItem.inspection_data_type_span_ids = [secondSpanId];
    selectors.items.push(secondItem);
    selectors.references = [{
      key: "shared-position-table",
      anchor_span_ids: [firstAnchorId, secondAnchorId],
      target_span_ids: [targetSpanId],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "两个引用均导入要求字段。" },
      destinations: [
        { item_key: selectors.items[0]!.key, target_field: "requirement" },
        { item_key: secondItem.key, target_field: "requirement" },
      ],
      reason: "两个本地表格行分别引用同一允许偏差表",
    }];

    const compiled = compileTargetSelectors(selectors, registry, manifest);
    expect(validatePlanText(prettyJson(compiled), manifest)).toMatchObject({ ok: true, issues: [] });
    expect(compiled.acceptance_items[0]!.field_bindings.requirement.evidence_ids)
      .not.toContain("atom:second-local-anchor");
    expect(compiled.acceptance_items[1]!.field_bindings.requirement.evidence_ids)
      .toEqual(["atom:second-local-anchor"]);
    expect(compiled.semantic_evidence?.filter((node) => node.role === "reference_anchor")
      .map((node) => node.evidence_id)).toEqual(expect.arrayContaining([
        manifest.evidence[0]!.evidence_id,
        "atom:second-local-anchor",
      ]));
  });

  test("rejects a header chunk as a title locally and inherits the one formal title candidate", { timeout: 15_000 }, async () => {
    const authoredTitle = "预埋件和预留孔洞的安装允许偏差";
    const formalTitle = "表 4.2.9 预埋件和预留孔洞的安装允许偏差";
    const headerText = `${formalTitle} | 数据行 1 | 项目=项目 | 允许偏差(mm)=允许偏差(mm)`;
    const rowText = `${formalTitle} | 数据行 2 | 项目=预埋板中心线位置 | 允许偏差(mm)=3`;
    const manifest = manifestFor(rowText);
    const base = manifest.evidence[0]!;
    const titleEvidenceId = "evidence:formal-title-4.2.9";
    const headerEvidenceId = "evidence:header-4.2.9";
    manifest.evidence = [
      { ...base, evidence_id: titleEvidenceId, role: "formal_table_title", text: formalTitle, text_sha256: sha256Text(formalTitle), table_fragment_id: "fragment:4.2.9", table_id: "4.2.9", table_title: formalTitle },
      { ...base, evidence_id: headerEvidenceId, kind: "table_row", role: "formal_table_header", text: headerText, text_sha256: sha256Text(headerText), table_row_kind: "header", table_fragment_id: "fragment:4.2.9", table_id: "4.2.9", table_title: formalTitle },
      { ...base, evidence_id: "evidence:row-4.2.9", kind: "table_row", role: "context", text: rowText, text_sha256: sha256Text(rowText), table_row_kind: "data", table_fragment_id: "fragment:4.2.9", table_id: "4.2.9", table_title: formalTitle },
    ];
    manifest.table_fragments = [{ fragment_id: "fragment:4.2.9", source_order: 1, locator: "line:1", provisional_table_id: "4.2.9", provisional_title: formalTitle, title_candidate_evidence_ids: [titleEvidenceId], header_evidence_ids: [headerEvidenceId], row_evidence_ids: ["evidence:row-4.2.9"], formal_row_evidence_ids: ["evidence:row-4.2.9"], columns: ["项目", "允许偏差(mm)"] }];
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((record) => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text })));
    const locate = (evidenceId: string, quote: string) => {
      const record = manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
      const located = locateAndRegisterSourceQuote(registry, { source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text: record.text }, quote);
      registry = located.registry;
      return located.spans[0]!.span_id;
    };
    const authoredSpanId = locate(headerEvidenceId, authoredTitle);
    const rowSpanId = locate("evidence:row-4.2.9", rowText);
    const formalSpanId = registry.spans.find((span) => span.evidence_id === titleEvidenceId && span.start === 0 && span.end === formalTitle.length)!.span_id;
    const selectors = fixture(rowText).selectors;
    selectors.lots[0]!.scope_span_ids = [rowSpanId];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [rowSpanId];
    item.fields.name.span_ids = [rowSpanId];
    item.fields.requirement.span_ids = [rowSpanId];
    item.inspection_data_type_span_ids = [rowSpanId];
    item.table = { source_kind: "direct", table_key: "4.2.9", reference_span_ids: [], reason: "同一物理表", properties: { table_no_span_ids: [], table_title_span_ids: [authoredSpanId], applicability_span_ids: [], row_path_span_ids: [[rowSpanId]], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [rowSpanId], inspection_method_span_ids: [] } };

    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_table_title_role_invalid",
          path: "/items/0/table/properties/table_title_span_ids",
          details: expect.objectContaining({
            offending_bindings: expect.arrayContaining([expect.objectContaining({
              evidence_id: headerEvidenceId,
              evidence_role: "formal_table_header",
            })]),
            formal_title_candidates: [expect.objectContaining({ evidence_id: titleEvidenceId, span_id: formalSpanId })],
          }),
        }),
      ]));
    }
    selectors.items[0]!.table!.properties.table_title_span_ids = [];
    const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
    expect(compiled.table_assembly.logical_tables[0]!.canonical_title_span_ids).toEqual([formalSpanId]);
    expect(hydrateSemanticSourcePlan(compiled, manifest).table_assembly.logical_tables[0]!.canonical_title_fragments)
      .toEqual([{ evidence_id: titleEvidenceId, text: formalTitle }]);

    const alreadyFormal = structuredClone(selectors);
    alreadyFormal.items[0]!.table!.properties.table_title_span_ids = [formalSpanId];
    expect(compileTargetSelectorsPersisted(alreadyFormal, registry, manifest).table_assembly.logical_tables[0]!.canonical_title_span_ids)
      .toEqual([formalSpanId]);

    const semanticOnly = compileTargetSelectorsPersisted(selectors, registry, manifest, {
      eligibleTableEvidenceIds: new Set(),
    });
    expect(semanticOnly.table_assembly.logical_tables[0]).toMatchObject({
      canonical_title_span_ids: [],
      fragment_ids: [],
    });

    const root = await mkdtemp(join(tmpdir(), "table-title-local-role-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(rowText) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: headerEvidenceId });
      const badItem = structuredClone(selectors.items[0]!);
      badItem.table!.properties.table_title_span_ids = [authoredSpanId];
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        collection: "items",
        draft: { items: [badItem] },
      })).toMatchObject({
        ok: true,
        draft_status: "saved_local_validation_failed",
        local_validation: {
          issues: expect.arrayContaining([expect.objectContaining({
            code: "selector_table_title_role_invalid",
            path: "/items/0/table/properties/table_title_span_ids",
          })]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tool admission reports misplaced root collections without accepting them as selectors or losing draft data", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-root-collection-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      const tool = createPiTools(controller).find(tool => tool.name === "stage_target_selector_draft")!;
      const beforeDraft = await readFile(workspace.workingSelectorPath, "utf8");
      const beforeRegistry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
      for (const collection of Object.keys(TARGET_SELECTOR_DRAFT_JSON_SCHEMA.properties)) {
        const input = { draft: { items: selectors.items }, [collection]: [] };
        // The model sees only writable fields; the SDK hook still gives the
        // precise repair before native validation or durable execution.
        expect(Check(tool.parameters, input)).toBe(false);
        expect(() => tool.prepareArguments!(input)).toThrow("selector_draft_collection_misplaced");
        expect(Check(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA, input)).toBe(false);
        const result = await tool.execute(`misplaced-${collection}`, input as never);
        expect(result.details).toMatchObject({
          ok: false, error: "selector_draft_collection_misplaced", budget_consumed: false,
          selector_issues: [expect.objectContaining({ path: `/${collection}`, severity: "error",
            actual: { path: `/${collection}` }, writable_paths: [`/draft/${collection}`],
            next_tool: "stage_target_selector_draft", do_not_edit: expect.any(String),
          })],
        });
        expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeDraft);
        expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(beforeRegistry);
      }
      const correctedInput = { draft: { lots: selectors.lots, items: selectors.items }, quote_bindings: [] };
      expect(Check(tool.parameters, correctedInput)).toBe(true);
      expect(Check(TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA, correctedInput)).toBe(true);
      const corrected = await tool.execute("corrected", correctedInput as never);
      expect(corrected.details).toMatchObject({ ok: true });
      // Replay a root-placement error followed by a metadata error. Neither call
      // performed the requested removal; the corrected call must still perform it.
      const beforeRetry = await readFile(workspace.workingSelectorPath, "utf8");
      const codec = await ModelSourceHandles.open(workspace.root);
      const wrapped = codec.wrapTools([tool])[0]!;
      const replacement = { ...structuredClone(selectors.items[0]!), key: "replacement-item" };
      const shortInput = await codec.encode({ operation: "upsert", collection: "items", remove_keys: [selectors.items[0]!.key],
        draft: { items: [replacement] }, source_dispositions: [], quote_bindings: [] }) as any;
      expect(() => wrapped.prepareArguments!(shortInput)).toThrow("selector_draft_collection_misplaced");
      const { source_dispositions: unusedEmptyCollection, ...repairedPlacement } = shortInput;
      expect(unusedEmptyCollection).toEqual([]);
      const missingScope = await wrapped.execute("missing-scope", repairedPlacement);
      expect(missingScope.details).toMatchObject({ error: "source_handle_scope_required" });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeRetry);
      const repairedInput = { ...repairedPlacement, ...(missingScope.details as any).required_argument };
      expect(wrapped.prepareArguments!(repairedInput)).toBe(repairedInput);
      expect((await wrapped.execute("preserved-removal", repairedInput)).details).toMatchObject({ ok: true });
      const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
      expect(saved.items.map((item: any) => item.key)).toEqual(["replacement-item"]);
      expect(saved.items[0].fields).toEqual(replacement.fields);
      expect(saved.lots).toEqual(selectors.lots);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each([false, true])("routes misplaced item reference spans according to actual table carrier (table=%s)", async (hasTable) => {
    const root = await mkdtemp(join(tmpdir(), "selector-misplaced-table-reference-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      const item = { ...structuredClone(selectors.items[0]!), reference_span_ids: selectors.items[0]!.criterion_span_ids };
      if (hasTable) item.table = { source_kind: "reference", table_key: "example", reference_span_ids: [], properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [], row_path_span_ids: [], column_path_span_ids: [],
        unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: item.criterion_span_ids, inspection_method_span_ids: [],
      }, reason: "仅测试表格引用字段的迁移路径" };
      const tool = createPiTools(controller).find(tool => tool.name === "stage_target_selector_draft")!;
      const misplacedInput = { operation: "upsert", collection: "items", draft: { items: [item] } };
      expect(Check(tool.parameters, misplacedInput)).toBe(false);
      let admission: any;
      try { tool.prepareArguments!(misplacedInput); } catch (error) { admission = JSON.parse((error as Error).message); }
      expect(admission).toMatchObject({ error: "selector_item_reference_spans_misplaced", durable_mutation: false,
        selector_issues: [expect.objectContaining({ details: expect.objectContaining({
          writable_path: hasTable ? "/draft/items/0/table/reference_span_ids" : "/draft/references",
        }) })] });
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        collection: "items",
        draft: { items: [item] },
      })).toMatchObject({
        ok: false,
        error: "selector_item_reference_spans_misplaced",
        selector_issues: [expect.objectContaining({
          path: "/draft/items/0/reference_span_ids",
          details: expect.objectContaining({
            writable_path: hasTable ? "/draft/items/0/table/reference_span_ids" : "/draft/references",
            next_tool: "stage_target_selector_draft",
          }),
        })],
      });
      expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))).toEqual(selectors);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("groups repeated invalid title bindings for one logical table into one actionable issue", () => {
    const titleA = "表 4.2.9 相同标题";
    const titleB = "表 4.2.10 相同标题";
    const headerA = `${titleA} | 数据行 1 | 项目=项目`;
    const rowA = `${titleA} | 数据行 2 | 项目=A`;
    const manifest = manifestFor(rowA);
    const base = manifest.evidence[0]!;
    const record = (evidence_id: string, text: string, role: EvidenceManifest["evidence"][number]["role"], fragment: string) => ({ ...base, evidence_id, text, text_sha256: sha256Text(text), role, table_fragment_id: fragment, table_id: fragment, table_title: text });
    manifest.evidence = [record("title:a", titleA, "formal_table_title", "fragment:a"), record("title:a:duplicate", "表4.2.9 备用正式标题", "formal_table_title", "fragment:a"), { ...record("header:a", headerA, "formal_table_header", "fragment:a"), kind: "table_row" as const, table_row_kind: "header" as const }, { ...record("row:a", rowA, "context", "fragment:a"), kind: "table_row" as const, table_row_kind: "data" as const }, record("title:b", titleB, "formal_table_title", "fragment:b")];
    manifest.table_fragments = [
      { fragment_id: "fragment:a", source_order: 1, locator: "a", provisional_table_id: "4.2.9", provisional_title: titleA, title_candidate_evidence_ids: ["title:a", "title:a:duplicate"], header_evidence_ids: ["header:a"], row_evidence_ids: ["row:a"], formal_row_evidence_ids: ["row:a"], columns: ["项目"] },
      { fragment_id: "fragment:b", source_order: 2, locator: "b", provisional_table_id: "4.2.10", provisional_title: titleB, title_candidate_evidence_ids: ["title:b"], header_evidence_ids: [], row_evidence_ids: [], formal_row_evidence_ids: [], columns: [] },
    ];
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((entry) => ({ source_id: entry.evidence_id, evidence_id: entry.evidence_id, atom_id: entry.evidence_id, text: entry.text })));
    const locate = (evidenceId: string, quote: string) => { const entry = manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId)!; const found = locateAndRegisterSourceQuote(registry, { source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text: entry.text }, quote); registry = found.registry; return found.spans[0]!.span_id; };
    const authored = locate("header:a", "相同标题");
    const row = locate("row:a", rowA);
    const selectors = fixture(rowA).selectors;
    selectors.lots[0]!.scope_span_ids = [row];
    Object.assign(selectors.items[0]!, { criterion_span_ids: [row], inspection_data_type_span_ids: [row] });
    selectors.items[0]!.fields.name.span_ids = [row]; selectors.items[0]!.fields.requirement.span_ids = [row];
    selectors.items[0]!.table = { source_kind: "direct", table_key: "a", reference_span_ids: [], reason: "首项使用正式表题", properties: { table_no_span_ids: [], table_title_span_ids: [registry.spans.find((span) => span.evidence_id === "title:a")!.span_id], applicability_span_ids: [], row_path_span_ids: [[row]], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [row], inspection_method_span_ids: [] } };
    const badTitleItem = structuredClone(selectors.items[0]!);
    badTitleItem.key = "bad-title-second-item";
    badTitleItem.table!.reason = "第二项误把表头片段当成表题";
    badTitleItem.table!.properties.table_title_span_ids = [authored];
    const anotherBadTitleItem = structuredClone(badTitleItem);
    anotherBadTitleItem.key = "bad-title-third-item";
    anotherBadTitleItem.table!.reason = "第三项也误把表头片段当成表题";
    selectors.items.push(badTitleItem, anotherBadTitleItem);
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected selector title-role failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const grouped = (error as TargetSelectorCompileError).issues.filter((issue) =>
        issue.code === "selector_table_title_role_invalid"
      );
      expect(grouped).toHaveLength(1);
      expect(grouped[0]).toMatchObject({
        path: "/items/1/table/properties/table_title_span_ids",
        details: expect.objectContaining({
          affected_item_keys: ["bad-title-second-item", "bad-title-third-item"],
          affected_paths: [
            "/items/1/table/properties/table_title_span_ids",
            "/items/2/table/properties/table_title_span_ids",
          ],
          writable_paths: [
            "/items/1/table/properties/table_title_span_ids",
            "/items/2/table/properties/table_title_span_ids",
          ],
          batch_repair: expect.objectContaining({ writable_paths: [
            "/items/1/table/properties/table_title_span_ids",
            "/items/2/table/properties/table_title_span_ids",
          ] }),
          offending_bindings: expect.arrayContaining([
            expect.objectContaining({ item_key: "bad-title-second-item", evidence_role: "formal_table_header", span_id: authored }),
            expect.objectContaining({ item_key: "bad-title-third-item", evidence_role: "formal_table_header", span_id: authored }),
          ]),
        }),
      });
    }
    const partiallyRepaired = structuredClone(selectors);
    partiallyRepaired.items[1]!.table!.properties.table_title_span_ids = [];
    try {
      compileTargetSelectorsPersisted(partiallyRepaired, registry, manifest);
      throw new Error("expected the remaining title-role failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(issue =>
        issue.code === "selector_table_title_role_invalid"
      )!;
      expect(issue.details).toMatchObject({
        affected_item_keys: ["bad-title-third-item"],
        affected_paths: ["/items/2/table/properties/table_title_span_ids"],
        writable_paths: ["/items/2/table/properties/table_title_span_ids"],
        batch_repair: { writable_paths: ["/items/2/table/properties/table_title_span_ids"] },
        next_tool_arguments: { collection: "items", key: "bad-title-third-item" },
      });
      expect(issue.details.offending_bindings).toHaveLength(1);
    }
    const structureOnly = structuredClone(selectors);
    structureOnly.items = [structureOnly.items[0]!];
    structureOnly.items[0]!.table!.properties.table_title_span_ids = [];
    expect(() => compileTargetSelectorsPersisted(structureOnly, registry, manifest)).toThrow(TargetSelectorCompileError);
    const selectedTitleSpanId = registry.spans.find((span) => span.evidence_id === "title:a" && span.start === 0 && span.end === titleA.length)!.span_id;
    const tableStructurePlan = {
      schema_version: "table-structure-decisions/v1" as const,
      source_version: manifest.source.sha256,
      evidence_fingerprint: manifest.evidence_fingerprint,
      tables: [{
        table_key: "a",
        status: "confirmed" as const,
        source_version: manifest.source.sha256,
        formal_title_span_ids: [selectedTitleSpanId],
        fragment_ids: ["fragment:a"],
        header_rows: ["header:a"],
        data_rows: ["row:a"],
        repeated_header_rows: [],
        note_rows: [],
        context_rows: [],
        review_rows: [],
        row_role_overrides: [],
        continuation_caption_span_ids: [],
        note_span_ids: [],
        reason: "结构层在两个正式候选中确认一次。",
      }],
    };
    const compiledFromStructure = compileTargetSelectorsPersisted(structureOnly, registry, manifest, {
      tableStructurePlan,
    });
    expect(compiledFromStructure.table_assembly.logical_tables[0]!.canonical_title_span_ids).toEqual([selectedTitleSpanId]);
    expect(compiledFromStructure.acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);

    tableStructurePlan.evidence_fingerprint = sha256Text("same-document-before-reference-extension");
    const historicalTableStructure = structuredClone(tableStructurePlan);
    const context = createSelectorCompilerContext({
      manifest,
      selectors: structureOnly,
      tableStructurePlan,
      eligibleTableEvidenceIds: new Set(manifest.evidence.map((entry) => entry.evidence_id)),
      acceptedSourceLanguageReviews: [],
      acceptedVerdictNameReviews: [],
    });
    expect(tableStructurePlan).toEqual(historicalTableStructure);
    expect(context.table_structure_plan.tables).toEqual(historicalTableStructure.tables);
    expect(context.table_structure_plan.source_version).toBe(historicalTableStructure.source_version);
    expect(context.table_structure_plan.evidence_fingerprint).toBe(manifest.evidence_fingerprint);
    const persistedContext = validatedSelectorCompilerContext(
      JSON.parse(JSON.stringify(context)),
      {
        manifest,
        selectors: structureOnly,
        acceptedSourceLanguageReviews: [],
        acceptedVerdictNameReviews: [],
      },
    );
    expect(persistedContext).toBeDefined();
    expect(selectorCompilerContextFingerprint(persistedContext!))
      .toBe(selectorCompilerContextFingerprint(context));
    expect(compileTargetSelectorsWithContext(structureOnly, registry, manifest, persistedContext!))
      .toEqual({ ...compiledFromStructure, validation_boundary: STRUCTURAL_VALIDATION_BOUNDARY });
    expect(validatedSelectorCompilerContext({ ...context, table_structure_plan: {
      ...context.table_structure_plan, source_version: sha256Text("another-source-document"),
    } }, { manifest, selectors: structureOnly, acceptedSourceLanguageReviews: [], acceptedVerdictNameReviews: [] })).toBeUndefined();
  });

  test.each([false, true])("binds formal title by table identity despite cross-table field provenance (own first=%s)", (ownFirst) => {
    const titleA = "表 4.2.9 涂层允许偏差";
    const titleB = "表 4.2.10 检测方法";
    const rowA = `${titleA} | 项目=厚度 | 偏差=2mm`;
    const rowB = `${titleB} | 方法=测厚仪检查`;
    const manifest = manifestFor(rowA);
    const base = manifest.evidence[0]!;
    const record = (id: string, text: string, fragment: string, title: boolean) => ({
      ...base, evidence_id: id, text, text_sha256: sha256Text(text),
      role: title ? "formal_table_title" as const : "context" as const,
      ...(title ? {} : { kind: "table_row" as const, table_row_kind: "data" as const }),
      table_fragment_id: fragment, table_id: fragment, table_title: fragment === "fragment:a" ? titleA : titleB,
    });
    manifest.evidence = [record("title:a", titleA, "fragment:a", true), record("row:a", rowA, "fragment:a", false),
      record("title:b", titleB, "fragment:b", true), record("row:b", rowB, "fragment:b", false)];
    manifest.table_fragments = ["a", "b"].map((key, index) => ({
      fragment_id: `fragment:${key}`, source_order: index + 1, locator: key,
      provisional_table_id: key, provisional_title: key === "a" ? titleA : titleB,
      title_candidate_evidence_ids: [`title:${key}`], header_evidence_ids: [],
      row_evidence_ids: [`row:${key}`], formal_row_evidence_ids: [`row:${key}`], columns: [],
    }));
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint,
      manifest.evidence.map((entry) => ({ source_id: entry.evidence_id, evidence_id: entry.evidence_id, atom_id: entry.evidence_id, text: entry.text })));
    const span = (id: string) => registry.spans.find((entry) => entry.evidence_id === id)!.span_id;
    const selectors = fixture(rowA).selectors;
    selectors.lots[0]!.scope_span_ids = [span("row:a")];
    const item = selectors.items[0]!;
    Object.assign(item, { criterion_span_ids: [span("row:a")], inspection_data_type_span_ids: [span("row:a")] });
    item.fields.name.span_ids = [span("row:a")]; item.fields.requirement.span_ids = [span("row:a")];
    item.fields.method.span_ids = [span("row:b")]; item.fields.method.composition = "verbatim";
    item.table = { source_kind: "direct", table_key: "a", reference_span_ids: [], reason: "跨表方法不改变本表身份", properties: {
      table_no_span_ids: [], table_title_span_ids: [span("title:a")], applicability_span_ids: [],
      row_path_span_ids: [[span("row:a")]], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [],
      allowed_value_span_ids: [span("row:a")], inspection_method_span_ids: [span("row:b")],
    } };
    const decision = (key: string) => ({
      table_key: key, status: "confirmed" as const, source_version: manifest.source.sha256,
      formal_title_span_ids: [span(`title:${key}`)], fragment_ids: [`fragment:${key}`],
      header_rows: [], data_rows: [`row:${key}`], repeated_header_rows: [], note_rows: [], context_rows: [], review_rows: [],
      row_role_overrides: [], continuation_caption_span_ids: [], note_span_ids: [], reason: "独立确认本表题注",
    });
    const tableStructurePlan = { schema_version: "table-structure-decisions/v1" as const,
      source_version: manifest.source.sha256, evidence_fingerprint: manifest.evidence_fingerprint,
      tables: (ownFirst ? ["a", "b"] : ["b", "a"]).map(decision) };
    const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan });
    expect(compiled.table_assembly.logical_tables[0]!.canonical_title_span_ids).toEqual([span("title:a")]);
    expect(compiled.acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
    expect(compiled.acceptance_items[0]!.table_semantics?.inspection_method).toBe(rowB);
    // A real conflict with this table's own structure still requires an authored repair.
    item.table.properties.table_title_span_ids = [span("title:b")];
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan });
      throw new Error("expected conflicting title selection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_table_title_selection_required",
        details: expect.objectContaining({
          selected_title_group_count: 2,
          authored_title_bindings: [expect.objectContaining({ span_id: span("title:b") })],
          selected_structure: expect.objectContaining({ table_key: "a", formal_title_span_ids: [span("title:a")] }),
          next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft",
          structure_repair: expect.objectContaining({ next_tool: "read_saved_table_structure", save_tool: "stage_table_structure" }),
        }),
      }));
    }
    // A key alias must not arbitrarily inherit one of several overlapping tables.
    item.table.table_key = "alias";
    item.table.properties.table_title_span_ids = [span("title:a")];
    expect(compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan })
      .table_assembly.logical_tables[0]!.canonical_title_span_ids).toEqual([span("title:a")]);
    // Preserve the existing fallback when there is exactly one overlapping structure.
    item.table.properties.inspection_method_span_ids = [];
    item.table.properties.table_title_span_ids = [];
    expect(compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan })
      .acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
  });

  test.each(["续表 4.2.9", "表@line-120"])("rejects noncanonical title role %s before compilation", (badTitle) => {
    const titleA = badTitle;
    const titleB = "表 4.2.10 相同标题";
    const headerA = `${titleA} | 数据行 1 | 项目=项目`;
    const rowA = `${titleA} | 数据行 2 | 项目=A`;
    const manifest = manifestFor(rowA);
    const base = manifest.evidence[0]!;
    const record = (evidence_id: string, text: string, role: EvidenceManifest["evidence"][number]["role"], fragment: string) => ({ ...base, evidence_id, text, text_sha256: sha256Text(text), role, table_fragment_id: fragment, table_id: fragment, table_title: text });
    manifest.evidence = [record("title:a", titleA, "formal_table_title", "fragment:a"), record("title:a:duplicate", `表4.2.9，相同标题`, "formal_table_title", "fragment:a"), { ...record("header:a", headerA, "formal_table_header", "fragment:a"), kind: "table_row" as const, table_row_kind: "header" as const }, { ...record("row:a", rowA, "context", "fragment:a"), kind: "table_row" as const, table_row_kind: "data" as const }, record("title:b", titleB, "formal_table_title", "fragment:b")];
    manifest.table_fragments = [
      { fragment_id: "fragment:a", source_order: 1, locator: "a", provisional_table_id: "4.2.9", provisional_title: titleA, title_candidate_evidence_ids: ["title:a", "title:a:duplicate"], header_evidence_ids: ["header:a"], row_evidence_ids: ["row:a"], formal_row_evidence_ids: ["row:a"], columns: ["项目"] },
      { fragment_id: "fragment:b", source_order: 2, locator: "b", provisional_table_id: "4.2.10", provisional_title: titleB, title_candidate_evidence_ids: ["title:b"], header_evidence_ids: [], row_evidence_ids: [], formal_row_evidence_ids: [], columns: [] },
    ];
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((entry) => ({ source_id: entry.evidence_id, evidence_id: entry.evidence_id, atom_id: entry.evidence_id, text: entry.text })));
    const locate = (evidenceId: string, quote: string) => { const entry = manifest.evidence.find((candidate) => candidate.evidence_id === evidenceId)!; const found = locateAndRegisterSourceQuote(registry, { source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text: entry.text }, quote); registry = found.registry; return found.spans[0]!.span_id; };
    const authored = locate("title:a", titleA);
    const row = locate("row:a", rowA);
    const selectors = fixture(rowA).selectors;
    selectors.lots[0]!.scope_span_ids = [row];
    Object.assign(selectors.items[0]!, { criterion_span_ids: [row], inspection_data_type_span_ids: [row] });
    selectors.items[0]!.fields.name.span_ids = [row]; selectors.items[0]!.fields.requirement.span_ids = [row];
    selectors.items[0]!.table = { source_kind: "direct", table_key: "a", reference_span_ids: [], reason: "歧义不得猜", properties: { table_no_span_ids: [], table_title_span_ids: [authored], applicability_span_ids: [], row_path_span_ids: [[row]], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [row], inspection_method_span_ids: [] } };
    try {
      compileTargetSelectorsPersisted(selectors, registry, manifest);
      throw new Error("expected title-role rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_table_title_role_invalid",
          path: "/items/0/table/properties/table_title_span_ids",
          details: expect.objectContaining({
            offending_bindings: [expect.objectContaining({ span_id: authored, text: badTitle })],
          }),
        }),
      ]));
    }
  });

  test("coalesces row-level table keys that share one physical table fragment", () => {
    const text = [
      "表4.4.4 土工合成材料地基质量检验标准",
      "主控项目 地基承载力 不小于设计值 静载试验",
      "主控项目 土工合成材料强度 ≥-5% 拉伸试验",
      "允许值或允许偏差",
    ].join("。\n");
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [
      text,
      "表4.4.4 土工合成材料地基质量检验标准",
      "表4.4.4",
      "地基承载力",
      "不小于设计值",
      "静载试验",
      "土工合成材料强度",
      "≥-5%",
      "拉伸试验",
      "允许值或允许偏差",
    ]);
    const evidenceId = manifest.evidence[0]!.evidence_id;
    manifest.table_fragments = [{
      fragment_id: "table-fragment:line-1",
      source_order: 1,
      locator: "line:1",
      provisional_table_id: "4.4.4",
      provisional_title: "表4.4.4 土工合成材料地基质量检验标准",
      title_candidate_evidence_ids: [evidenceId],
      header_evidence_ids: [evidenceId],
      row_evidence_ids: [evidenceId],
      formal_row_evidence_ids: [evidenceId],
      columns: ["项目", "检查项目", "允许值或允许偏差", "检查方法"],
    }];
    const selectors = fixture(text).selectors;
    const id = (quote: string) => registered.ids.get(quote)!;
    selectors.lots[0]!.scope_span_ids = [id(text)];
    const first = selectors.items[0]!;
    first.key = "bearing-capacity";
    first.name = "地基承载力";
    first.criterion_span_ids = [id("地基承载力"), id("不小于设计值"), id("静载试验")];
    first.fields.name.span_ids = [id("地基承载力")];
    first.fields.requirement.span_ids = [id("不小于设计值")];
    first.inspection_data_type_span_ids = [id("静载试验")];
    first.table = {
      source_kind: "direct",
      table_key: "table-4-4-4-bearing",
      properties: {
        table_no_span_ids: [id("表4.4.4")],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[id("地基承载力")]],
        column_path_span_ids: [[id("允许值或允许偏差")]],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [id("不小于设计值")],
        inspection_method_span_ids: [id("静载试验")],
      },
      reference_span_ids: [],
      reason: "表4.4.4主控项目第1行",
    };
    const second = structuredClone(first);
    second.key = "geosynthetic-strength";
    second.name = "土工合成材料强度";
    second.criterion_span_ids = [id("土工合成材料强度"), id("≥-5%"), id("拉伸试验")];
    second.fields.name.span_ids = [id("土工合成材料强度")];
    second.fields.requirement.span_ids = [id("≥-5%")];
    second.inspection_data_type_span_ids = [id("拉伸试验")];
    second.table!.table_key = "table-4-4-4-strength";
    second.table!.properties.row_path_span_ids = [[id("土工合成材料强度")]];
    second.table!.properties.allowed_value_span_ids = [id("≥-5%")];
    second.table!.properties.inspection_method_span_ids = [id("拉伸试验")];
    second.table!.reason = "表4.4.4主控项目第2行";
    selectors.items.push(second);

    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(compiled.table_assembly.logical_tables).toHaveLength(1);
    expect(compiled.table_assembly.fragment_dispositions).toEqual([expect.objectContaining({
      fragment_id: "table-fragment:line-1",
      disposition: "assigned",
      logical_table_id: compiled.table_assembly.logical_tables[0]!.logical_table_id,
    })]);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compiler_duplicate_table_fragment_owner" }),
      expect.objectContaining({ code: "compiler_table_fragment_relation_mismatch" }),
    ]));
  });

  test.each([
    { sourceKind: "direct" as const, fullAnchorSpan: true },
    { sourceKind: "direct" as const, fullAnchorSpan: false },
    { sourceKind: "reference" as const, fullAnchorSpan: true },
    { sourceKind: "reference" as const, fullAnchorSpan: false },
  ])("retains only missing structural row anchors ($sourceKind, full span: $fullAnchorSpan)", ({ sourceKind, fullAnchorSpan }) => {
    const title = "表 4.4.4 基础质量检验标准";
    const firstRow = "第一段：承载力 不小于设计值 静载试验";
    const continuation = "续表 4.4.4";
    const secondRow = "第二段：桩位 10mm 尺量";
    const manifest = manifestFor([title, firstRow, continuation, secondRow].join("\n"));
    const base = manifest.evidence[0]!;
    const record = (evidenceId: string, text: string, fragmentId: string, role: EvidenceManifest["evidence"][number]["role"], kind: EvidenceManifest["evidence"][number]["kind"] = "paragraph") => ({
      ...base,
      evidence_id: evidenceId,
      text,
      text_sha256: sha256Text(text),
      role,
      kind,
      table_fragment_id: fragmentId,
      table_id: "4.4.4",
      table_title: title,
    });
    manifest.evidence = [
      { ...base, evidence_id: "origin", text: "检验应符合表 4.4.4 的规定。", text_sha256: sha256Text("检验应符合表 4.4.4 的规定。") },
      record("title", title, "fragment:first", "formal_table_title"),
      { ...record("row:first", firstRow, "fragment:first", "context", "table_row"), table_row_kind: "data" as const },
      record("caption", continuation, "fragment:second", "table_continuation_caption"),
      { ...record("row:unused", "续表首行：不涉及的项目", "fragment:second", "context", "table_row"), table_row_kind: "data" as const },
      { ...record("row:second", secondRow, "fragment:second", "context", "table_row"), table_row_kind: "data" as const },
      { ...record("row:unselected", "未选择片段中的行", "fragment:unselected", "context", "table_row"), table_row_kind: "data" as const },
    ];
    manifest.table_fragments = [
      { fragment_id: "fragment:first", source_order: 1, locator: "line:1", provisional_table_id: "4.4.4", provisional_title: title, title_candidate_evidence_ids: ["title"], header_evidence_ids: [], row_evidence_ids: ["row:first"], formal_row_evidence_ids: ["row:first"], columns: ["项目"] },
      { fragment_id: "fragment:second", source_order: 2, locator: "line:3", provisional_table_id: "4.4.4", provisional_title: title, title_candidate_evidence_ids: [], header_evidence_ids: [], row_evidence_ids: ["row:unused", "row:second"], formal_row_evidence_ids: ["row:unused", "row:second"], continuation_caption_evidence_ids: ["caption"], columns: ["项目"] },
      { fragment_id: "fragment:unselected", source_order: 3, locator: "line:6", provisional_table_id: "4.4.4", provisional_title: title, title_candidate_evidence_ids: [], header_evidence_ids: [], row_evidence_ids: ["row:unselected"], formal_row_evidence_ids: ["row:unselected"], columns: ["项目"] },
    ];
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint,
      manifest.evidence.map(entry => ({ source_id: entry.evidence_id, evidence_id: entry.evidence_id, atom_id: entry.evidence_id, text: entry.text })));
    if (!fullAnchorSpan) registry.spans = registry.spans.filter(entry => entry.evidence_id !== "row:first");
    const span = (evidenceId: string) => registry.spans.find(entry => entry.evidence_id === evidenceId)!.span_id;
    const selectors = fixture(secondRow).selectors;
    selectors.lots[0]!.scope_span_ids = [span("row:second")];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [span("row:second")];
    item.fields.name.span_ids = [span("row:second")];
    item.fields.requirement.span_ids = [span("row:second")];
    item.inspection_data_type_span_ids = [span("row:second")];
    item.table = {
      source_kind: sourceKind,
      table_key: "4.4.4",
      reference_span_ids: sourceKind === "reference" ? [span("origin")] : [],
      reason: "模型选择续表中的具体验收行。",
      properties: {
        table_no_span_ids: [span("title")],
        table_title_span_ids: [span("title")],
        applicability_span_ids: [],
        row_path_span_ids: [[span("row:second")]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [span("row:second")],
        inspection_method_span_ids: [],
      },
    };

    const inputsBefore = structuredClone({ selectors, registry, manifest });
    const compiled = compileTargetSelectors(selectors, registry, manifest);
    const logical = compiled.table_assembly.logical_tables[0]!;
    expect(logical.fragment_ids).toEqual(["fragment:first", "fragment:second"]);
    expect(logical.evidence_ids).toContain("row:first");
    expect(logical.evidence_ids).not.toContain("row:unused");
    expect(logical.evidence_ids).not.toContain("row:unselected");
    expect(compiled.acceptance_items).toHaveLength(1);
    expect(compiled.acceptance_items[0]!.requirement).toBe(secondRow);
    expect({ selectors, registry, manifest }).toEqual(inputsBefore);
    expect(compileTargetSelectors(selectors, registry, manifest)).toEqual(compiled);
    expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compiler_table_fragment_semantic_evidence_missing" }),
    ]));
    const restricted = hydrateSemanticSourcePlan(compileTargetSelectorsPersisted(selectors, registry, manifest, {
      eligibleTableEvidenceIds: new Set(manifest.evidence.filter(record => record.evidence_id !== "row:first").map(record => record.evidence_id)),
    }), manifest);
    expect(restricted.table_assembly.logical_tables[0]!.evidence_ids).not.toContain("row:first");
    expect(checkTargetCompilerInvariants(selectors, restricted, manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compiler_table_fragment_semantic_evidence_missing" }),
    ]));
  });

  test("assembles table facts from spans when Markdown table structure is absent", () => {
    const text = "表4.1.7 表面平整度 允许偏差 10mm 用2m靠尺检查";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, "表4.1.7", "表面平整度", "允许偏差", "10mm", "用2m靠尺检查"]);
    const selectors = fixture(text).selectors;
    const id = (quote: string) => registered.ids.get(quote)!;
    selectors.lots[0]!.scope_span_ids = [id(text)];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [id(text)];
    item.fields.name.span_ids = [id("表面平整度")];
    item.fields.requirement.span_ids = [id(text)];
    item.inspection_data_type_span_ids = [id("10mm"), id("用2m靠尺检查")];
    item.table = {
      source_kind: "direct",
      table_key: "flatness",
      properties: {
        table_no_span_ids: [id("表4.1.7")], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[id("表面平整度")]], column_path_span_ids: [[id("允许偏差")]],
        unit_span_ids: [id("10mm")], condition_span_ids: [], allowed_value_span_ids: [id("10mm")],
        inspection_method_span_ids: [id("用2m靠尺检查")],
      },
      reference_span_ids: [],
      reason: "扁平文本仍表达同一表格判据",
    };
    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(compiled.acceptance_items[0]!.table_semantics).toMatchObject({
      table_no: "表4.1.7",
      row_path: ["表面平整度"],
      column_path: ["允许偏差"],
      unit: "10mm",
      allowed_value: "10mm",
      inspection_method: "用2m靠尺检查",
    });
    expect(compiled.table_assembly.fragment_dispositions).toEqual([]);
    const tableOnlySemantic = structuredClone(compiled);
    tableOnlySemantic.semantic_evidence = [{
      semantic_id: "semantic:table-value-only",
      role: "table_criterion",
      evidence_id: manifest.evidence[0]!.evidence_id,
      exact_fragment: "10mm",
      parent_semantic_id: "",
      materialized_item_id: compiled.acceptance_items[0]!.item_id,
      reason: "表格允许值由 table_semantics 物化，不需要伪装成普通字段",
    }];
    expect(validateSemanticDraft(tableOnlySemantic, manifest).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "semantic_item_fragment_not_materialized" }),
    ]));

    const referencedSelectors = structuredClone(selectors);
    referencedSelectors.items[0]!.table!.source_kind = "reference";
    referencedSelectors.items[0]!.table!.reference_span_ids = [id(text)];
    const referencedCompiled = compileTargetSelectors(referencedSelectors, registered.registry, manifest);
    expect(referencedCompiled.semantic_references ?? []).toEqual([]);
    expect(checkTargetCompilerInvariants(referencedSelectors, referencedCompiled, manifest)).toEqual([]);
    expect(validatePlanText(prettyJson(referencedCompiled), manifest)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "table_reference_route_missing" })],
    });

    const unresolvedReferenceSelectors = structuredClone(referencedSelectors);
    unresolvedReferenceSelectors.items[0]!.table!.properties.row_path_span_ids = [];
    unresolvedReferenceSelectors.items[0]!.table!.properties.column_path_span_ids = [];
    expect(() => compileTargetSelectors(
      unresolvedReferenceSelectors,
      registered.registry,
      manifest,
    )).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(unresolvedReferenceSelectors, registered.registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_reference_table_entry_path_required" }),
      ]));
    }

    const referencedEvidenceId = "atom:referenced-table";
    const routedManifest = structuredClone(manifest);
    routedManifest.evidence.push({
      ...structuredClone(manifest.evidence[0]!),
      evidence_id: referencedEvidenceId,
      evidence_scope: "reference",
      requires_disposition: false,
    });
    const routed = structuredClone(compiled);
    const routedItem = routed.acceptance_items[0]!;
    for (const cell of routedItem.table_semantics!.cell_evidence) {
      cell.evidence_id = referencedEvidenceId;
    }
    routed.semantic_evidence ??= [];
    routed.semantic_references ??= [];
    routed.semantic_evidence.push(
      {
        semantic_id: "reference-anchor",
        role: "reference_anchor",
        evidence_id: manifest.evidence[0]!.evidence_id,
        exact_fragment: text,
        parent_semantic_id: "",
        materialized_item_id: "",
        reason: "当前条款引用外部表格",
      },
      {
        semantic_id: "reference-target",
        role: "referenced_clause",
        evidence_id: referencedEvidenceId,
        exact_fragment: text,
        parent_semantic_id: "reference-anchor",
        materialized_item_id: "",
        reason: "引用表格为该 item 提供结构化表事实",
      },
    );
    routed.semantic_references.push({
      expansion_id: "reference-expansion",
      anchor_semantic_id: "reference-anchor",
      status: "resolved",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用仅保留要求 provenance。" },
      target_semantic_ids: ["reference-target"],
      destination_bindings: [{ item_id: routedItem.item_id, fields: ["reference_only"] }],
      reason: "引用只承载表格语义，不替换普通字段",
    });
    expect(validatePlanText(prettyJson(routed), routedManifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("derives a referenced-table route from a unique component disposition", () => {
    const originText = "结构实体混凝土强度应按附录C或附录D检验。";
    const appendixCText = "附录C 同条件养护试件要求";
    const appendixDText = "附录D 表D.0.1 构件总数量 最小抽样数量 20~150 20个";
    const { manifest, selectors } = fixture(originText);
    const originEvidenceId = manifest.evidence[0]!.evidence_id;
    const appendixCEvidenceId = "atom:appendix-c";
    const appendixDEvidenceId = "atom:appendix-d";
    manifest.evidence.push(
      {
        ...manifest.evidence[0]!,
        evidence_id: appendixCEvidenceId,
        locator: "line:100",
        text: appendixCText,
        text_sha256: sha256Text(appendixCText),
        requires_disposition: false,
        evidence_scope: "reference",
      },
      {
        ...manifest.evidence[0]!,
        evidence_id: appendixDEvidenceId,
        locator: "line:200",
        text: appendixDText,
        text_sha256: sha256Text(appendixDText),
        requires_disposition: false,
        evidence_scope: "reference",
      },
    );
    manifest.evidence_fingerprint = sha256Text(`component-table-route\0${originText}\0${appendixCText}\0${appendixDText}`);
    let registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const take = (evidenceId: string, quote: string): string => {
      const record = manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
      const located = locateAndRegisterSourceQuote(registry, {
        source_id: evidenceId,
        evidence_id: evidenceId,
        atom_id: evidenceId,
        text: record.text,
      }, quote);
      registry = located.registry;
      return located.spans[0]!.span_id;
    };
    const originSpanId = take(originEvidenceId, originText);
    const appendixCAnchorId = take(originEvidenceId, "附录C");
    const appendixDAnchorId = take(originEvidenceId, "附录D");
    const appendixCSpanId = take(appendixCEvidenceId, appendixCText);
    const appendixDTitleSpanId = take(appendixDEvidenceId, "表D.0.1");
    const appendixDColumnSpanId = take(appendixDEvidenceId, "最小抽样数量");
    const appendixDConditionSpanId = take(appendixDEvidenceId, "20~150");
    const appendixDValueSpanId = take(appendixDEvidenceId, "20个");
    const literal = (spanId: string) => {
      const span = registry.spans.find((entry) => entry.span_id === spanId)!;
      return { evidence_id: span.evidence_id, start: span.start, end: span.end };
    };
    manifest.reference_occurrences.push(
      {
        occurrence_id: "reference:appendix-c",
        reference_kind: "clause",
        origin_evidence_id: originEvidenceId,
        origin_span_id: originSpanId,
        reference_literal_span_id: appendixCAnchorId,
        reference_literal: literal(appendixCAnchorId),
        origin_fields: ["requirement"],
        raw_reference: "附录C",
        target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "C" },
        target_evidence_ids: [appendixCEvidenceId],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["appendix:C"],
      },
      {
        occurrence_id: "reference:appendix-d",
        reference_kind: "clause",
        origin_evidence_id: originEvidenceId,
        origin_span_id: originSpanId,
        reference_literal_span_id: appendixDAnchorId,
        reference_literal: literal(appendixDAnchorId),
        origin_fields: ["requirement"],
        raw_reference: "附录D",
        target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "D" },
        target_evidence_ids: [appendixDEvidenceId],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["appendix:D"],
      },
    );

    selectors.lots[0]!.scope_span_ids = [originSpanId];
    const parent = selectors.items[0]!;
    parent.key = "item-structure-strength";
    parent.name = "结构实体混凝土强度";
    parent.criterion_span_ids = [originSpanId];
    parent.fields.name.span_ids = [originSpanId];
    parent.fields.requirement.span_ids = [originSpanId];
    parent.inspection_data_type_span_ids = [originSpanId];
    selectors.items.push({
      key: "item-d-rebound-components",
      lot_key: parent.lot_key,
      name: "回弹构件抽取",
      category: "主控项目",
      criterion_span_ids: [appendixDConditionSpanId, appendixDValueSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [appendixDColumnSpanId], separator: "", reason: "回弹构件抽取。" },
        requirement: { composition: "verbatim", span_ids: [appendixDConditionSpanId, appendixDValueSpanId], separator: " ", reason: "数量分支。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未另列方法。" },
        quantity: { composition: "verbatim", span_ids: [appendixDValueSpanId], separator: "", reason: "最小抽样数量。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
      },
      table: {
        source_kind: "reference",
        table_key: "table-d-0-1",
        properties: {
          table_no_span_ids: [appendixDTitleSpanId],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [[appendixDConditionSpanId]],
          column_path_span_ids: [[appendixDColumnSpanId]],
          unit_span_ids: [],
          condition_span_ids: [appendixDConditionSpanId],
          allowed_value_span_ids: [appendixDValueSpanId],
          inspection_method_span_ids: [],
        },
        reference_span_ids: [appendixDAnchorId],
        reason: "附录D引用的表D.0.1数量分支。",
      },
      inspection_data_type: "counting",
      inspection_data_type_reason: "核对最小抽样数量。",
      inspection_data_type_span_ids: [appendixDValueSpanId],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "本用例只验证引用路由。",
        confidence: 1,
      },
      reason: "表D.0.1形成独立表格验收叶。",
    });
    selectors.references.push(
      {
        key: "ref-appendix-c",
        occurrence_id: "reference:appendix-c",
        anchor_span_ids: [appendixCAnchorId],
        target_span_ids: [appendixCSpanId],
        component_dispositions: [{
          component_span_ids: [appendixCSpanId],
          decision: "not_applicable",
          item_keys: [],
          reason: "本用例不展开附录C。",
        }],
        action: "adopt",
        application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "本地要求引用附录C。" },
        destinations: [{ item_key: parent.key, target_field: "requirement" }],
        reason: "保留附录C父项引用。",
      },
      {
        key: "ref-appendix-d",
        occurrence_id: "reference:appendix-d",
        anchor_span_ids: [appendixDAnchorId],
        target_span_ids: [appendixDTitleSpanId, appendixDConditionSpanId, appendixDValueSpanId],
        component_dispositions: [
          {
            component_span_ids: [appendixDTitleSpanId],
            decision: "not_applicable",
            item_keys: [],
            reason: "表号不是独立判断。",
          },
          {
            component_span_ids: [appendixDConditionSpanId, appendixDValueSpanId],
            decision: "same_judgment",
            item_keys: ["item-d-rebound-components"],
            reason: "条件与数量共同形成回弹构件抽取判断。",
          },
        ],
        action: "adopt",
        application_mode: "reference_only",
        import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["requirement", "quantity"], reason: "附录D提供完整数量分支。" },
        destinations: [{ item_key: parent.key, target_field: "requirement" }],
        reason: "父项保留附录D路径，组件由子项物化。",
      },
    );

    const compiled = compileTargetSelectors(selectors, registry, manifest);
    const child = compiled.acceptance_items.find((item) => item.name === "回弹构件抽取")!;
    const componentRoute = compiled.semantic_references?.find((reference) =>
      reference.destination_bindings.some((destination) => destination.item_id === child.item_id)
    );
    expect(componentRoute).toMatchObject({
      status: "resolved",
      destination_bindings: expect.arrayContaining([
        { item_id: child.item_id, fields: ["reference_only"] },
      ]),
    });
    expect(componentRoute!.target_semantic_ids).toHaveLength(3);
    expect(compiled.reference_resolutions.find((resolution) =>
      resolution.occurrence_id === "reference:appendix-d"
    )?.destination_bindings).toEqual([
      { item_id: compiled.acceptance_items[0]!.item_id, target_field: "requirement" },
      { item_id: child.item_id, target_field: "requirement" },
    ]);
    expect(validatePlanText(prettyJson(compiled), manifest).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_reference_route_missing" }),
      expect.objectContaining({ code: "table_evidence_relation" }),
    ]));

    const emptyTarget = structuredClone(selectors);
    emptyTarget.references[0]!.target_span_ids = [];
    emptyTarget.references[0]!.component_dispositions = [];
    const compileIssues = (draft: typeof selectors) => {
      try {
        compileTargetSelectors(draft, registry, manifest);
        return [];
      } catch (error) {
        if (!(error instanceof TargetSelectorCompileError)) throw error;
        return error.issues;
      }
    };
    const emptyTargetIssues = compileIssues(emptyTarget);
    expect(emptyTargetIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_reference_target_required", path: "/references/0/target_span_ids" }),
    ]));
    expect(emptyTargetIssues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_reference_component_dispositions_required", path: "/references/0/component_dispositions" }),
    ]));

    emptyTarget.references[0]!.target_span_ids = [appendixCSpanId];
    const missingDispositionIssue = compileIssues(emptyTarget).find((issue) =>
      issue.code === "selector_reference_component_dispositions_required" && issue.path === "/references/0/component_dispositions"
    );
    expect(missingDispositionIssue).toMatchObject({
      details: {
        reference_key: "ref-appendix-c",
        occurrence_id: "reference:appendix-c",
        required_target_span_ids: [appendixCSpanId],
        writable_paths: expect.arrayContaining(["/references/0/target_span_ids", "/references/0/component_dispositions", "/items"]),
        candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts"]),
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "ref-appendix-c" },
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("analysis_mode"),
      },
    });
    expect(actionableSelectorIssue(classifySelectorIssue("selector-local", missingDispositionIssue!))).toMatchObject({
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "references", key: "ref-appendix-c" },
      save_tool: "stage_target_selector_draft",
    });
    const repairInstruction = String(missingDispositionIssue!.details?.how_to_pass);
    expect(repairInstruction.length).toBeLessThanOrEqual(420);
    expect(repairInstruction).toContain("建立真实 item");
    expect(repairInstruction).toContain("保留实质要求");
    expect(repairInstruction).toContain("保留适用条件");
    expect(repairInstruction).toContain("draft.references、必要时 draft.items");
    const handoff = new SelectorCompletedPreflightHandoff();
    const draftFingerprint = "a".repeat(64);
    handoff.setDraftFingerprint(draftFingerprint);
    handoff.observe({
      type: "tool_execution_end",
      toolName: "commit_target_selector_draft",
      result: { details: {
        ok: false,
        current_draft_fingerprint: draftFingerprint,
        selector_issues: [actionableSelectorIssue(classifySelectorIssue("selector-local", missingDispositionIssue!))],
      } },
    });
    const continuationNote = handoff.continuationNote(draftFingerprint);
    expect(continuationNote).toContain('"writable_paths":["/references/0/target_span_ids","/references/0/component_dispositions","/items"]');
    expect(continuationNote).not.toContain('"repair_instruction"');
    expect(continuationNote).toContain('"next_tool"');

    const mismatchedReceiver = structuredClone(selectors);
    const mismatchedReferenceIndex = mismatchedReceiver.references.findIndex((reference) => reference.key === "ref-appendix-d");
    const mismatchedDispositionIndex = mismatchedReceiver.references[mismatchedReferenceIndex]!.component_dispositions!
      .findIndex((disposition) => disposition.decision === "same_judgment");
    mismatchedReceiver.references[mismatchedReferenceIndex]!.component_dispositions![mismatchedDispositionIndex]!
      .item_keys = [parent.key];
    const parentIndex = mismatchedReceiver.items.findIndex((item) => item.key === parent.key);
    try {
      compileTargetSelectors(mismatchedReceiver, registry, manifest);
      throw new Error("expected component receiver provenance mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_component_item_mismatch") as any;
      expect(issue.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(issue.details.save_tool_instruction).toContain("operation=upsert");
      expect(issue.details.save_tool_instruction).toContain("draft.references");
      expect(issue).toMatchObject({
        path: `/references/${mismatchedReferenceIndex}/component_dispositions/${mismatchedDispositionIndex}/item_keys`,
        details: {
          required_action: "组件处置点名的真实 item 必须用自身 provenance 完整覆盖这些 component spans。",
          actual: expect.objectContaining({ reference_key: "ref-appendix-d", item_keys: [parent.key] }),
          save_tool_instruction: expect.stringContaining("operation=upsert"),
          writable_paths: expect.arrayContaining([
            `/references/${mismatchedReferenceIndex}/component_dispositions/${mismatchedDispositionIndex}/item_keys`,
            `/items/${parentIndex}/criterion_span_ids`,
            `/items/${parentIndex}/fields`,
            `/items/${parentIndex}/table`,
            `/items/${parentIndex}/sampling`,
          ]),
          candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_reference_occurrences", "read_reference_facts"]),
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("删除错误 key"),
        },
      });
    }

    // A real receiver can cover the selected facts while an author mistakenly
    // maps the entire paragraph, including its surrounding navigation text.
    const overbroadComponent = structuredClone(selectors);
    const broadReference = overbroadComponent.references.find(row => row.key === "ref-appendix-d")!;
    const fullAppendixSpan = take(appendixDEvidenceId, appendixDText);
    broadReference.target_span_ids = [appendixDTitleSpanId, fullAppendixSpan];
    broadReference.component_dispositions![1]!.component_span_ids = [fullAppendixSpan];
    const beforeScopeReview = structuredClone(overbroadComponent);
    const scopeIssue = compileIssues(overbroadComponent).find(row => row.code === "selector_reference_component_item_mismatch")!;
    expect(scopeIssue.details).toMatchObject({
      writable_paths: expect.arrayContaining([
        "/references/1/component_dispositions/1/component_span_ids", "/references/1/target_span_ids",
      ]),
      allowed_actions: expect.arrayContaining([expect.stringContaining("组件范围选得过宽")]),
      how_to_pass: expect.stringContaining("不自动缩小"),
    });
    expect(String(scopeIssue.details?.how_to_pass)).toContain("仍须交代");
    expect(overbroadComponent).toEqual(beforeScopeReview);
    // The original precise, source-backed selection remains valid; the compiler
    // must neither rewrite the broad draft nor accept its uncovered component.
    expect(compileIssues(selectors)).toEqual([]);

    // The reported author paths remain metadata; a real save contains a complete record.
    const referenceSave = { operation: "upsert", draft: { references: [mismatchedReceiver.references[mismatchedReferenceIndex]] } };
    expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, referenceSave)).toBe(true);
    expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, { ...referenceSave, writable_paths: ["/references/0"] })).toBe(false);

    const unknownReceiver = structuredClone(selectors);
    const unknownReferenceIndex = unknownReceiver.references.findIndex((reference) => reference.key === "ref-appendix-d");
    const unknownDispositionIndex = unknownReceiver.references[unknownReferenceIndex]!.component_dispositions!
      .findIndex((disposition) => disposition.decision === "same_judgment");
    unknownReceiver.references[unknownReferenceIndex]!.component_dispositions![unknownDispositionIndex]!
      .item_keys = ["missing-item-from-source"];
    try {
      compileTargetSelectors(unknownReceiver, registry, manifest);
      throw new Error("expected an unknown component receiver to fail compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_component_item_mismatch") as any;
      expect(issue.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(issue.details.save_tool_instruction).toContain("operation=upsert");
      expect(issue.details.save_tool_instruction).toContain("draft.references");
      expect(issue.details.writable_paths).not.toContain(
        `/references/${unknownReferenceIndex}/component_dispositions/${unknownDispositionIndex}/component_span_ids`,
      );
      expect(issue).toMatchObject({
        path: `/references/${unknownReferenceIndex}/component_dispositions/${unknownDispositionIndex}/item_keys`,
        details: {
          actual: expect.objectContaining({
            reference_key: "ref-appendix-d",
            unknown_item_keys: ["missing-item-from-source"],
            named_item_coverage: [{ item_key: "missing-item-from-source", item_index: null, exists: false, coverage_span_ids: [] }],
          }),
          writable_paths: expect.arrayContaining([
            `/references/${unknownReferenceIndex}/component_dispositions/${unknownDispositionIndex}/item_keys`,
            "/items",
          ]),
          writable_collections: ["references", "items"],
          candidate_read_tools: [
            "read_target_selectors",
            "list_reference_occurrences",
            "read_document_reference_evidence",
            "read_reference_facts",
            "open_evidence",
            "locate_evidence_span",
          ],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "references", key: "ref-appendix-d" },
          next_tools: [
            "read_target_selectors",
            "list_reference_occurrences",
            "read_document_reference_evidence",
            "read_reference_facts",
            "open_evidence",
            "locate_evidence_span",
            "stage_target_selector_draft",
          ],
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringMatching(/读取.*items.*引用.*删除错误 key.*不得替模型决定应创建哪些 item/u),
        },
      });
    }

    const independentReceiver = structuredClone(selectors);
    const independentReference = independentReceiver.references.find(reference => reference.key === "ref-appendix-d")!;
    const independentDisposition = independentReference.component_dispositions!.find(disposition => disposition.decision === "same_judgment")!;
    independentDisposition.decision = "independent_item";
    independentDisposition.item_keys = [parent.key, "item-d-rebound-components"];
    try {
      compileTargetSelectors(independentReceiver, registry, manifest);
      throw new Error("expected multiple independent receivers to fail compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const independentIssue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_component_independent_item_count") as any;
      expect(independentIssue.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(independentIssue.details.save_tool_instruction).toContain("operation=upsert");
      expect(independentIssue.details.save_tool_instruction).toContain("draft.references");
      expect(independentIssue.details.writable_collections).toEqual(["references"]);
    }

    const missingBranchContract = structuredClone(selectors);
    const branchReferenceIndex = missingBranchContract.references.findIndex((reference) => reference.key === "ref-appendix-d");
    const branchDispositionIndex = missingBranchContract.references[branchReferenceIndex]!.component_dispositions!
      .findIndex((disposition) => disposition.decision === "same_judgment");
    const branchDisposition = missingBranchContract.references[branchReferenceIndex]!.component_dispositions![branchDispositionIndex]!;
    branchDisposition.decision = "acceptance_branch";
    branchDisposition.item_keys = ["item-d-rebound-components"];
    try {
      compileTargetSelectors(missingBranchContract, registry, manifest);
      throw new Error("expected an incomplete acceptance branch contract to fail compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_component_branch_contract_required") as any;
      expect(issue.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(issue.details.save_tool_instruction).toContain("operation=upsert");
      expect(issue.details.save_tool_instruction).toContain("draft.references");
      expect(issue).toMatchObject({
        path: `/references/${branchReferenceIndex}/component_dispositions/${branchDispositionIndex}/decision`,
        details: {
          actual: {
            reference_key: "ref-appendix-d",
            disposition_index: branchDispositionIndex,
            decision: "acceptance_branch",
            item_keys: ["item-d-rebound-components"],
            branch_contract_summary: [{
              item_key: "item-d-rebound-components",
              item_index: 1,
              exists: true,
              table_present: true,
              acceptance_branch_count: 0,
              branch_keys: [],
              has_complete_acceptance_branches_contract: false,
            }],
          },
          allowed_actions: [
            expect.stringContaining("item_key 或 decision 点错"),
            expect.stringContaining("补齐该真实 item.table.properties.acceptance_branches"),
          ],
          writable_paths: expect.arrayContaining([
            `/references/${branchReferenceIndex}/component_dispositions/${branchDispositionIndex}/item_keys`,
            `/references/${branchReferenceIndex}/component_dispositions/${branchDispositionIndex}/decision`,
            "/items/1/table",
            "/items/1/table/properties/acceptance_branches",
          ]),
          candidate_read_tools: expect.arrayContaining([
            "read_target_selectors",
            "list_reference_occurrences",
            "read_document_reference_evidence",
            "read_reference_facts",
            "list_table_fragments",
            "read_table_summary",
            "read_table_rows",
            "open_evidence",
            "locate_evidence_span",
          ]),
          next_tool: "read_target_selectors",
          next_tools: expect.arrayContaining(["read_target_selectors", "read_table_rows", "stage_target_selector_draft"]),
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringMatching(/补齐.*acceptance_branches.*不得替模型决定.*分支数量.*允许值/u),
        },
      });
    }

    const outsideTarget = structuredClone(selectors);
    const outsideReferenceIndex = outsideTarget.references.findIndex((reference) => reference.key === "ref-appendix-d");
    const outsideDispositionIndex = outsideTarget.references[outsideReferenceIndex]!.component_dispositions!
      .findIndex((disposition) => disposition.decision === "same_judgment");
    outsideTarget.references[outsideReferenceIndex]!.component_dispositions![outsideDispositionIndex]!
      .component_span_ids = [appendixCSpanId];
    try {
      compileTargetSelectors(outsideTarget, registry, manifest);
      throw new Error("expected a component outside its reference targets");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_component_outside_target") as any;
      expect(issue).toMatchObject({
        path: `/references/${outsideReferenceIndex}/component_dispositions/${outsideDispositionIndex}/component_span_ids`,
        details: {
          required_action: "组件处置只能使用本 reference 已登记的 target_span_ids。",
          actual: expect.objectContaining({
            reference_key: "ref-appendix-d",
            invalid_span_ids: [appendixCSpanId],
            declared_target_span_ids: expect.arrayContaining([appendixDConditionSpanId, appendixDValueSpanId]),
          }),
          writable_paths: [
            `/references/${outsideReferenceIndex}/component_dispositions/${outsideDispositionIndex}/component_span_ids`,
            `/references/${outsideReferenceIndex}/target_span_ids`,
          ],
          candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_reference_occurrences", "read_reference_facts"]),
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("invalid_span_ids"),
        },
      });
    }

    const mismatchedAnchor = structuredClone(selectors);
    mismatchedAnchor.items.find((item) => item.key === "item-d-rebound-components")!
      .table!.reference_span_ids = [appendixCAnchorId];
    const mismatchedPlan = compileTargetSelectors(mismatchedAnchor, registry, manifest);
    expect(validatePlanText(prettyJson(mismatchedPlan), manifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_reference_route_missing" }),
    ]));

    const ambiguousOwner = structuredClone(selectors);
    const ambiguousParent = ambiguousOwner.items.find((item) => item.key === parent.key)!;
    ambiguousParent.criterion_span_ids.push(appendixDConditionSpanId, appendixDValueSpanId);
    ambiguousParent.fields.requirement.span_ids.push(appendixDConditionSpanId, appendixDValueSpanId);
    ambiguousParent.fields.requirement.separator = "\n";
    ambiguousOwner.references.find((reference) => reference.key === "ref-appendix-d")!
      .component_dispositions!.find((disposition) => disposition.decision === "same_judgment")!
      .item_keys = [parent.key, "item-d-rebound-components"];
    const ambiguousPlan = compileTargetSelectors(ambiguousOwner, registry, manifest);
    const ambiguousChild = ambiguousPlan.acceptance_items.find((item) => item.name === "回弹构件抽取")!;
    expect(ambiguousPlan.semantic_references?.some((reference) =>
      reference.destination_bindings.some((destination) => destination.item_id === ambiguousChild.item_id)
    )).toBe(true);
    expect(validatePlanText(prettyJson(ambiguousPlan), manifest).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_reference_route_missing" }),
    ]));
  });

  test.each([[], ["applicability"], ["condition"], ["applicability", "condition"]])("reference origin and local context %j do not assign their physical table to the referenced table", (...roles) => {
    const local = "表甲 检查项目 泥浆指标按表乙执行 一般项目 桩墙合一时";
    const remote = "表乙 泥浆质量标准\n比重\n1.10~1.25\n用比重计测";
    const { manifest, selectors } = fixture(local);
    const originId = manifest.evidence[0]!.evidence_id;
    const remoteId = "atom:remote-mud-table";
    manifest.evidence.push({ ...manifest.evidence[0]!, evidence_id: remoteId, locator: "line:20", text: remote, text_sha256: sha256Text(remote), evidence_scope: "reference", requires_disposition: false });
    manifest.table_fragments = [{ fragment_id: "fragment:local", source_order: 1, locator: "line:1", provisional_table_id: "A", provisional_title: "表甲", title_candidate_evidence_ids: [originId], header_evidence_ids: [originId], row_evidence_ids: [originId], formal_row_evidence_ids: [originId], columns: ["检查项目"] }];
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(e => ({ source_id: e.evidence_id, evidence_id: e.evidence_id, text: e.text })));
    const take = (evidenceId: string, text: string) => {
      const e = manifest.evidence.find(e => e.evidence_id === evidenceId)!;
      const located = locateAndRegisterSourceQuote(registry, { source_id: evidenceId, evidence_id: evidenceId, text: e.text }, text,
        text === "比重" ? { prefix: "表乙 泥浆质量标准\n" } : {});
      registry = located.registry;
      return located.spans[0]!.span_id;
    };
    const anchor = take(originId, local);
    const title = take(remoteId, "表乙 泥浆质量标准");
    const name = take(remoteId, "比重");
    const value = take(remoteId, "1.10~1.25");
    const method = take(remoteId, "用比重计测");
    selectors.lots[0]!.scope_span_ids = [];
    const item = selectors.items[0]!;
    item.name = "泥浆比重";
    item.criterion_span_ids = [anchor, value];
    item.inspection_data_type_span_ids = [value];
    item.fields.name.span_ids = [name];
    item.fields.requirement.span_ids = [value];
    item.fields.method = { composition: "verbatim", span_ids: [method], separator: "", reason: "原文方法" };
    item.fields.note = { composition: "verbatim", span_ids: [anchor], separator: "", reason: "保留本地引用发起来源" };
    item.table = { source_kind: "reference", table_key: "remote", reference_span_ids: [anchor], reason: "按被引表的独立项目展开", properties: { table_no_span_ids: [], table_title_span_ids: [title], applicability_span_ids: [], row_path_span_ids: [[name]], column_path_span_ids: [[value]], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [value], inspection_method_span_ids: [method] } };
    if (roles.includes("applicability")) item.table.properties.applicability_span_ids = [take(originId, "一般项目")];
    if (roles.includes("condition")) item.table.properties.condition_span_ids = [take(originId, "桩墙合一时")];
    const plan = compileTargetSelectors(selectors, registry, manifest);
    expect(plan.table_assembly.logical_tables).toHaveLength(1);
    expect(plan.table_assembly.logical_tables[0]!.fragment_ids).toEqual([]);
    expect(plan.table_assembly.logical_tables[0]!.canonical_title).toBe("表乙 泥浆质量标准");
    expect(plan.acceptance_items[0]!.evidence_ids).toContain(originId);
    expect(plan.acceptance_items[0]!.table_semantics).toMatchObject({
      applicability: roles.includes("applicability") ? "一般项目" : "",
      condition: roles.includes("condition") ? "桩墙合一时" : "",
    });
    expect(checkTargetCompilerInvariants(selectors, plan, manifest)).toEqual([]);
  });

  test("rejects a navigation-only method span when an exact table method binding exists", () => {
    const anchor = "正文引用目标表；抽样十件；检验方法见目标表。";
    const caption = "目标表的中性定位说明";
    const rowName = "构件表面平整度";
    const allowedValue = "允许偏差10mm";
    const exactMethod = "用2m靠尺检查";
    const text = [anchor, caption, rowName, allowedValue, exactMethod].join("\n");
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [
      text,
      anchor,
      caption,
      rowName,
      allowedValue,
      exactMethod,
    ]);
    const id = (quote: string) => registered.ids.get(quote)!;
    const selectors = fixture(text).selectors;
    selectors.lots[0]!.scope_span_ids = [id(text)];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [id(text)];
    item.fields.name.span_ids = [id(rowName)];
    item.fields.requirement.span_ids = [id(allowedValue)];
    item.fields.method = {
      composition: "verbatim",
      span_ids: [id(anchor), id(exactMethod)],
      separator: "",
      reason: "构造把引用导航误混入行级方法的候选",
    };
    item.inspection_data_type_span_ids = [id(allowedValue), id(exactMethod)];
    item.table = {
      source_kind: "reference",
      table_key: "referenced-flatness",
      properties: {
        table_no_span_ids: [],
        table_title_span_ids: [id(caption)],
        applicability_span_ids: [id(anchor)],
        row_path_span_ids: [[id(rowName)]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [id(allowedValue)],
        inspection_method_span_ids: [id(exactMethod)],
      },
      reference_span_ids: [id(anchor)],
      reason: "正文锚点只建立引用来源，行级方法另有精确绑定",
    };

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest))
      .toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_table_method_role_conflict",
          path: "/items/0/fields/method/span_ids",
          details: expect.objectContaining({
            conflicting_bindings: [{
              span_id: id(anchor),
              roles: expect.arrayContaining(["reference_span_ids", "applicability_span_ids"]),
            }],
            allowed_bindings: [expect.objectContaining({
              span_id: id(exactMethod),
              text: exactMethod,
            })],
            required_actions: expect.arrayContaining([
              expect.objectContaining({ action: "remove", span_ids: [id(anchor)] }),
              expect.objectContaining({ action: "replace", span_ids: [id(exactMethod)] }),
            ]),
          }),
        }),
      ]));
    }

    const exact = structuredClone(selectors);
    exact.items[0]!.fields.method.span_ids = [id(exactMethod)];
    expect(compileTargetSelectors(exact, registered.registry, manifest).acceptance_items[0])
      .toMatchObject({ method: exactMethod });

    const flatTextMethod = structuredClone(selectors);
    flatTextMethod.items[0]!.fields.method.span_ids = [id(anchor)];
    flatTextMethod.items[0]!.table!.properties.inspection_method_span_ids = [id(anchor)];
    expect(compileTargetSelectors(flatTextMethod, registered.registry, manifest).acceptance_items[0])
      .toMatchObject({ method: anchor });
  });

  test("compacts table navigation display without truncating exact cell provenance", () => {
    const criterion = "承载力应符合设计要求。";
    const rowNavigation = `中性物理行 ${"完整内容".repeat(80)}`;
    const columnNavigation = `中性物理列 ${"完整栏目".repeat(80)}`;
    const allowedValue = "允许值10";
    const text = `${criterion}${rowNavigation}${columnNavigation}${allowedValue}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, criterion, rowNavigation, columnNavigation, allowedValue]);
    const selectors = fixture(text).selectors;
    const rowSpan = registered.ids.get(rowNavigation)!;
    const columnSpan = registered.ids.get(columnNavigation)!;
    const criterionSpan = registered.ids.get(criterion)!;
    selectors.lots[0]!.scope_span_ids = [registered.ids.get(text)!];
    selectors.items[0]!.criterion_span_ids = [criterionSpan];
    selectors.items[0]!.fields.name.span_ids = [criterionSpan];
    selectors.items[0]!.fields.requirement.span_ids = [criterionSpan];
    selectors.items[0]!.inspection_data_type_span_ids = [criterionSpan];
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "long-navigation",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[rowSpan]], column_path_span_ids: [[columnSpan]],
        unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [registered.ids.get(allowedValue)!], inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "The long physical row is navigation only; exact provenance remains immutable.",
    };
    const compiled = compileTargetSelectors(selectors, registered.registry, manifest);
    const table = compiled.acceptance_items[0]!.table_semantics!;
    expect(table.row_path[0]!.length).toBeLessThanOrEqual(120);
    expect(table.column_path[0]!.length).toBeLessThanOrEqual(120);
    expect(table.cell_evidence.filter((cell) => cell.role === "row_header" || cell.role === "column_header"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ text: rowNavigation }),
        expect.objectContaining({ text: columnNavigation }),
      ]));
  });

  test("carries directly selected table evidence from every in-scope atom into item membership", () => {
    const primaryText = "4.3.8 灰土垫层表面允许偏差应符合表4.1.7。";
    const adjacentText = "表4.1.7 基层表面允许偏差 表面平整度 10mm 用2m靠尺检查";
    const manifest = manifestFor(primaryText);
    const adjacentEvidenceId = "atom:adjacent-table-window";
    manifest.evidence.push({
      evidence_id: adjacentEvidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${adjacentText.length}`,
      text: adjacentText,
      text_sha256: sha256Text(adjacentText),
      requires_disposition: true,
      evidence_scope: "adjacent",
    });
    manifest.evidence_fingerprint = sha256Text(`evidence\0${primaryText}\0${adjacentText}`);
    const sources = manifest.evidence.map((record) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    }));
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
    const ids = new Map<string, string>();
    for (const quote of ["表4.1.7", "基层表面允许偏差", "表面平整度", "10mm", "用2m靠尺检查"]) {
      const located = locateAndRegisterSourceQuote(registry, sources[1]!, quote);
      registry = located.registry;
      ids.set(quote, located.spans[0]!.span_id);
    }
    const selectors = fixture(primaryText).selectors;
    const id = (quote: string) => ids.get(quote)!;
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "adjacent-flatness",
      properties: {
        table_no_span_ids: [id("表4.1.7")],
        table_title_span_ids: [id("基层表面允许偏差")],
        applicability_span_ids: selectors.items[0]!.criterion_span_ids,
        row_path_span_ids: [[id("表面平整度")]],
        column_path_span_ids: [[id("基层表面允许偏差")]],
        unit_span_ids: [id("10mm")],
        condition_span_ids: [],
        allowed_value_span_ids: [id("10mm")],
        inspection_method_span_ids: [id("用2m靠尺检查")],
      },
      reference_span_ids: selectors.items[0]!.criterion_span_ids,
      reason: "相邻物理窗口已在 target scope，直接选中的表事实属于同一 item",
    };

    const compiled = compileTargetSelectors(selectors, registry, manifest);
    expect(compiled.acceptance_items[0]!.evidence_ids).toContain(adjacentEvidenceId);
    expect(validatePlanText(prettyJson(compiled), manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("keeps semantic table assembly valid after HTML removal and column-order perturbation", () => {
    const variants = [
      "<table><tr><td>表4.1.7</td><td>表面平整度</td><td>允许偏差</td><td>10mm</td><td>用2m靠尺检查</td></tr></table>",
      "用2m靠尺检查；允许偏差10mm；项目为表面平整度；来源表4.1.7。",
    ];
    const compiled = variants.map((text) => {
      const manifest = manifestFor(text);
      const registered = registerQuotes(manifest, [text, "表4.1.7", "表面平整度", "允许偏差", "10mm", "用2m靠尺检查"]);
      const selectors = fixture(text).selectors;
      const id = (quote: string) => registered.ids.get(quote)!;
      selectors.lots[0]!.scope_span_ids = [id(text)];
      const item = selectors.items[0]!;
      item.criterion_span_ids = [id(text)];
      item.fields.name.span_ids = [id("表面平整度")];
      item.fields.requirement.span_ids = [id("10mm")];
      item.inspection_data_type_span_ids = [id("10mm"), id("用2m靠尺检查")];
      item.table = {
        source_kind: "direct",
        table_key: "flatness",
        properties: {
          table_no_span_ids: [id("表4.1.7")], table_title_span_ids: [], applicability_span_ids: [],
          row_path_span_ids: [[id("表面平整度")]], column_path_span_ids: [[id("允许偏差")]],
          unit_span_ids: [id("10mm")], condition_span_ids: [], allowed_value_span_ids: [id("10mm")],
          inspection_method_span_ids: [id("用2m靠尺检查")],
        },
        reference_span_ids: [],
        reason: "格式仅作导航",
      };
      const plan = compileTargetSelectors(selectors, registered.registry, manifest);
      expect(checkTargetCompilerInvariants(selectors, plan, manifest)).toEqual([]);
      expect(validatePlanText(prettyJson(plan), manifest)).toMatchObject({ ok: true, issues: [] });
      expect(plan.table_assembly.fragment_dispositions).toEqual([]);
      return plan.acceptance_items[0]!.table_semantics;
    });
    expect(compiled[1]).toMatchObject({
      table_no: compiled[0]!.table_no,
      row_path: compiled[0]!.row_path,
      column_path: compiled[0]!.column_path,
      allowed_value: compiled[0]!.allowed_value,
      inspection_method: compiled[0]!.inspection_method,
    });
  });

  test("rejects reference cycles before final validation", () => {
    const { manifest, registry, selectors } = fixture();
    const spanId = selectors.items[0]!.criterion_span_ids[0]!;
    selectors.references = [{
      key: "self-cycle",
      anchor_span_ids: [spanId],
      target_span_ids: [spanId],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "循环结构测试。" },
      destinations: [{ item_key: "surface", target_field: "requirement" }],
      reason: "构造循环用例",
    }];
    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_cycle",
          path: "/references",
          details: expect.objectContaining({ cycle: ["self-cycle", "self-cycle"], edges: expect.any(Array) }),
        }),
      ]));
    }
  });

  test("reference dependencies follow source spans, not shared item membership", () => {
    const { manifest, registry, selectors } = fixture();
    const source = manifest.evidence[0]!;
    const a = registerSourceSpan(registry, { source_id: source.evidence_id, evidence_id: source.evidence_id,
      atom_id: source.evidence_id, text: source.text }, 0, 2);
    const b = registerSourceSpan(a.registry, { source_id: source.evidence_id, evidence_id: source.evidence_id,
      atom_id: source.evidence_id, text: source.text }, 4, 6);
    selectors.items[0]!.criterion_span_ids = [a.span.span_id, b.span.span_id];
    const reference = { key: "甲引乙", anchor_span_ids: [a.span.span_id], target_span_ids: [b.span.span_id],
      action: "adopt" as const, application_mode: "reference_only" as const,
      import_scope: { mode: "field_specific" as const, allowed_fields: ["requirement" as const], reason: "来源关系测试" },
      destinations: [{ item_key: selectors.items[0]!.key, target_field: "requirement" as const }], reason: "来源关系测试" };
    selectors.references = [reference];
    expect(targetSelectorReferenceCycleIssues(selectors, b.registry)).toEqual([]);
    selectors.references.push({ ...reference, key: "乙引甲", anchor_span_ids: [b.span.span_id], target_span_ids: [a.span.span_id] });
    expect(targetSelectorReferenceCycleIssues(selectors, b.registry)).toMatchObject([{
      code: "selector_reference_cycle", details: { cycle: ["甲引乙", "乙引甲", "甲引乙"],
        next_tool: "read_target_selectors", edges: [{ reference_key: "甲引乙" }, { reference_key: "乙引甲" }] },
    }]);
    expect(targetSelectorReferenceCycleIssues({ references: [...selectors.references].reverse() }, b.registry)).toHaveLength(1);
  });

  test("reports stale hash at the exact selector path", () => {
    const { manifest, registry, selectors } = fixture();
    registry.spans[0]!.text_sha256 = "0".repeat(64);
    expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_span_hash_mismatch", path: "/lots/0/scope_span_ids/0" }),
      ]));
    }
  });

  test("Agent tool surface contains selectors and no complete-plan or old decision mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-tools-"));
    try {
      const { manifest } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      const names = createPiTools(controller).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "get_target_context", "list_evidence_resources", "open_evidence", "search_evidence",
        "batch_open_evidence", "batch_search_evidence", "locate_evidence_span", "batch_locate_evidence_spans",
        "search_global_document_resources", "open_global_document_resource", "open_adjacent_document_resource",
        "register_external_dependency",
        "get_target_selector_contract",
        "read_target_selectors", "stage_target_selector_draft", "commit_target_selector_draft",
        "report_target_blocker", "seal_validated_plan",
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "submit_target_selectors", "correct_target_selectors", "compile_target_selectors",
      ]));
      const stage = createPiTools(controller).find((tool) => tool.name === "stage_target_selector_draft")!;
      const authoring = (await controller.dispatch("get_target_selector_contract", {}) as any).authoring_protocols;
      expect(authoring.fields).toContain("只有 fields.name 可用 semantic_summary");
      expect(authoring.fields).toContain("not_applicable、span_ids=[]");
      expect(authoring.fields).toContain("不得从合格判据反推检查方法");
      expect(authoring.patch).toBe(SELECTOR_PATCH_GUIDANCE);
      expect(authoring.field_roles).toBe(SELECTOR_FIELD_ROLE_GUIDANCE);
      expect(authoring.patch).toContain("顶层 reason");
      const stagedItemSchema = (stage.parameters as any).properties.draft.properties.items.items;
      expect(stagedItemSchema.required).toContain("reason");
      expect(stagedItemSchema.properties.reason).toMatchObject({
        type: "string",
        description: expect.stringContaining("内层 reason 都不能代替"),
      });
      expect((stage.parameters as any).properties.draft.properties.items.items.properties.sampling.description).toBe(SELECTOR_SAMPLING_GUIDANCE);
      expect((stage.parameters as any).properties.draft.properties.sampling_rules.items.properties.complete_span_ids.description).toBe(SAMPLING_COMPLETE_SPAN_GUIDANCE);
      expect((stage.parameters as any).properties.draft.properties.sampling_rules.items.properties.complete_span_ids).not.toHaveProperty("minItems");
      expect(SELECTOR_SAMPLING_GUIDANCE).toContain(SAMPLING_COMPLETE_SPAN_GUIDANCE);
      const contractResponse = await controller.dispatch("get_target_selector_contract", {}) as any;
      const contractItemSchema = contractResponse.json_schema.properties.items.items;
      expect(contractItemSchema.required).toContain("reason");
      expect(contractItemSchema.properties.reason).toMatchObject({
        type: "string",
        description: expect.stringContaining("内层 reason 都不能代替"),
      });
      expect(contractResponse.authoring_protocols.patch).toContain("item 保留顶层 reason");
      const contract = JSON.stringify(contractResponse);
      for (const guidance of [SELECTOR_FIELD_ROLE_GUIDANCE, SELECTOR_PATCH_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE]) {
        expect(contract).toContain(JSON.stringify(guidance).slice(1, -1));
      }
      const stageSchema = JSON.stringify(stage.parameters);
      expect(stageSchema).toContain('"draft"');
      expect(stageSchema).toContain('"remove_keys"');
      expect(stageSchema).toContain('"collection"');
      expect(stageSchema).toContain('"table_no_span_ids"');
      expect(stageSchema).toContain('"branch_keys"');
      expect(stageSchema).toContain("semantic_summary 仅适用于 item.fields.name");
      expect(stageSchema).toContain("不能从验收要求推断检验方法");
      expect(stageSchema).not.toContain('"branch_key"');
      expect(stageSchema).not.toContain('"content"');
      expect(names).not.toContain("get_target_bundle");
      const listSampling = createPiTools(controller).find((tool) => tool.name === "list_sampling_rules")!;
      expect(listSampling.description).toContain("非穷尽抽样定位线索");
      expect(authoring.sampling).toContain("除数量未规定特例外每个可执行分支有有效 quantity");
      for (const forbidden of ["replace_working_plan", "patch_working_plan", "replace_target_selectors", "patch_target_selectors", "get_semantic_decision_contract", "patch_working_decisions", "compile_semantic_decisions"]) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("selector prompt preserves agent-directed resource investigation", () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("按对象、属性、工法、条件和时间阶段比较候选");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("get_target_selector_contract");
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("branch_keys");
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("一个接收项也可用");
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("共有 components 与分支专属 components 分开");
    for (const role of ["applicability", "branch_condition", "method", "quantity", "acceptance_criterion", "exception", "note"]) {
      expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain(role);
    }
    for (const requirement of [
      "条/节/表/附录", "并列目标分别登记", "连续范围核对起止和实际存在的每个目标",
      "主资料一级验收依据", "无则按 literal_only", "保留完整原字段及 anchor",
    ]) {
      expect(TARGET_SELECTOR_PROTOCOLS.references).toContain(requirement);
      expect(SYSTEM_PROMPT).toContain(requirement);
    }
    expect(TARGET_SELECTOR_PROTOCOLS.tables).toContain("题注不代替判据");
    for (const prompt of [TARGET_SELECTOR_SYSTEM_PROMPT, SYSTEM_PROMPT, COVERAGE_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain("reference_commit_checklist");
      expect(prompt).not.toContain("提交前引用检查清单");
    }
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("分支 absent 不撤销共同 present");
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("除数量未规定特例外每个可执行分支有有效 quantity");
    expect(TARGET_SELECTOR_PROTOCOLS.sampling).toContain("无业务分支也建默认结构 branch");
    expect(TARGET_SELECTOR_PROTOCOLS.lifecycle).toContain("advance 是当前阶段完整性检查");
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("occurrence_id、raw_reference、origin_evidence_id、target_locator");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("best_draft_fingerprint");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("best_history_sequence");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("Read every get_target_bundle page");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("get_target_bundle");
  });

  test("locating new spans after reading the contract cannot stale a model-authored fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-harness-fingerprint-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      const contract = await controller.dispatch("get_target_selector_contract", {});
      expect(JSON.stringify(contract)).not.toContain("span_registry_fingerprint");
      expect(JSON.stringify(contract)).not.toContain("evidence_fingerprint");
      expect(await controller.dispatch("open_evidence", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        cursor: 0,
      })).toMatchObject({ ok: true });
      expect(await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: "基层表面",
      })).toMatchObject({ ok: true, span: { span_id: expect.any(String) } });
      const submitted = await controller.dispatch("submit_target_selectors", {
        content: prettyJson(selectors),
      });
      expect(submitted).toMatchObject({ ok: true });
      expect(JSON.stringify(submitted)).not.toContain("selector_registry_mismatch");
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 1,
        corrections: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("transport/protocol failures do not consume semantic commit or correction budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-transaction-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      const contract = await controller.dispatch("get_target_selector_contract", {});
      expect(Buffer.byteLength(JSON.stringify(contract), "utf8")).toBeLessThanOrEqual(128 * 1024);
      const context = await controller.dispatch("get_target_context", {});
      expect(context).toMatchObject({ ok: true, next_resource_cursor: null });
      expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect(JSON.stringify(context)).not.toContain(manifest.evidence[0]!.text);
      expect(await controller.dispatch("read_target_selectors", {})).toMatchObject({
        ok: true,
        summary: { draft_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      });
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const completePart = await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: "基层表面应平整、密实。",
      });
      const branchPart = await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: "检验方法：用2m靠尺检查。",
      });
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { sampling_rules: [{
        key: "invalid-local-rule",
        complete_span_ids: [(completePart.span as { span_id: string }).span_id],
        components: [...sharedSamplingDispositions(), ...sharedSamplingDispositions()],
        branches: [{
          key: "branch",
          applies_to_category: "一般项目",
          components: branchSamplingComponents(
            "branch",
            [(branchPart.span as { span_id: string }).span_id],
            [(branchPart.span as { span_id: string }).span_id],
            [],
          ),
          reason: "分支不在 complete span 内",
        }],
        reason: "重复组件 key 是记录自身错误，与接收项目尚未连接无关",
      }] } })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false,
        local_validation: { issues: expect.arrayContaining([expect.objectContaining({ code: "selector_sampling_component_duplicate" })]) } });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      const malformedLegacy = await controller.dispatch("submit_target_selectors", { content: "{" });
      expect(malformedLegacy).toMatchObject({ ok: false, error_class: "protocol", error: "selector_invalid_json" });
      // This case exercises protocol accounting after admission, independently
      // of the author-error gate covered by the workflow tests.
      vi.spyOn(controller, "selectorRepairWork").mockResolvedValue(undefined);
      const wrongFingerprint = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: "0".repeat(64) });
      expect(wrongFingerprint).toMatchObject({ ok: false, error_class: "protocol", error: "selector_draft_fingerprint_mismatch" });
      const exhaustedProtocol = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: "1".repeat(64) });
      expect(exhaustedProtocol).toMatchObject({
        ok: false,
        terminal: true,
        protocol_failure: { count: 3, exhausted: true },
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 0,
        corrections: 0,
        transport_failures: 0,
        protocol_failures: 3,
      });

      await controller.recordSelectorTransportFailure("provider_output_length");
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 0,
        corrections: 0,
        transport_failures: 1,
        protocol_failures: 3,
      });

      const invalidDraft = await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: [{ key: "bad", name: "bad", scope_span_ids: ["span:00000000000000000000000000000000"], reason: "bad" }] },
      });
      expect(invalidDraft).toMatchObject({
        ok: false,
        issue_owner: "selector_input_error",
        error: "selector_draft_span_validation",
        budget_consumed: false,
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      const explicitWithoutScript = structuredClone(selectors.items[0]!);
      explicitWithoutScript.sampling = {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: explicitWithoutScript.criterion_span_ids,
        script_span_ids: [],
        condition_span_ids: [],
        reason: "本地校验应在 commit 前发现缺失 script",
        confidence: 1,
      };
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [explicitWithoutScript] } })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 0, corrections: 0 });
      await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { lots: selectors.lots } });
      await controller.dispatch("stage_target_selector_draft",{collection:"sampling_rules",remove_keys:["invalid-local-rule"]});
      const semanticallyInvalidItem = structuredClone(selectors.items[0]!);
      semanticallyInvalidItem.lot_key = "missing-lot";
      const invalidSemanticDraft = await controller.dispatch("stage_target_selector_draft", {
        draft: { items: [semanticallyInvalidItem] },
      });
      expect(invalidSemanticDraft).toMatchObject({ ok: true, draft_fingerprint: expect.any(String) });
      const first = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: invalidSemanticDraft.draft_fingerprint,
      });
      expect(first).toMatchObject({ ok: false, issue_owner: "selector_input_error", selector_transaction: "initial" });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 0 });

      const locallyInvalidCorrectionItem = structuredClone(selectors.items[0]!);
      locallyInvalidCorrectionItem.fields.quantity = {
        composition: "reference",
        span_ids: [],
        separator: "",
        reason: "修复其他问题时新制造的空 reference 绑定",
      };
      const rejectedCorrectionStage = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: [locallyInvalidCorrectionItem] },
      });
      expect(rejectedCorrectionStage).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 0 });

      const locallyInvalidNotApplicableItem = structuredClone(selectors.items[0]!);
      locallyInvalidNotApplicableItem.fields.quantity = {
        composition: "not_applicable",
        span_ids: [...locallyInvalidNotApplicableItem.criterion_span_ids],
        separator: "",
        reason: "not_applicable 不得携带来源 span",
      };
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: [locallyInvalidNotApplicableItem] },
      })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true,budget_consumed:false});
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 0 });

      const staged = await controller.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { items: selectors.items } });
      expect(staged).toMatchObject({ ok: true, draft_fingerprint: expect.any(String) });
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const correction = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: staged.draft_fingerprint,
      });
      expect(correction).toMatchObject({ ok: true, selector_transaction: "correction", fingerprint: expect.any(String) });
      expect((await workspace.readState()).selector_protocol).toMatchObject({ submissions: 1, corrections: 1 });
      await workspace.updateState((state) => { state.validation_attempts = 3; });
      expect(await controller.dispatch("compile_target_selectors", {}))
        .toMatchObject({ ok: true, fingerprint: expect.any(String) });
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        await writeFile(
          join(workspace.validationDirectory, `${String(sequence).padStart(6, "0")}.json`),
          JSON.stringify({
            schema_version: "validation-receipt/v1",
            sequence,
            attempt: sequence,
            ok: false,
            evidence_fingerprint: manifest.evidence_fingerprint,
            validator: "semantic-source-plan-validator/v5",
            trigger: "decision-compile",
          }),
          "utf8",
        );
      }
      expect(await controller.dispatch("compile_target_selectors", {}))
        .toMatchObject({ ok: false, terminal: true, error: "final_validator_attempt_limit" });
      await workspace.markTerminal("failed", "test terminal");
      expect(await workspace.readState()).toMatchObject({ status: "failed", terminal_reason: "test terminal" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("counts only failed strict decision validations across the 894/c137/fe8 receipt sequences", async () => {
    const sequences = [
      { name: "894", outcomes: [false, true, true] },
      { name: "c137", outcomes: [true, true, true] },
      { name: "fe8", outcomes: [true, true, true] },
    ] as const;
    for (const sequenceCase of sequences) {
      const root = await mkdtemp(join(tmpdir(), `target-selector-validation-${sequenceCase.name}-`));
      try {
        const { manifest, selectors } = fixture();
        const workspace = await RevisionWorkspace.createFromEvidence(
          root,
          manifest.job_id,
          manifest.target_id,
          { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
        );
        await workspace.writeWorkingSelectors(prettyJson(selectors));
        for (const [index, ok] of sequenceCase.outcomes.entries()) {
          const receiptSequence = index + 1;
          await writeFile(
            join(workspace.validationDirectory, `${String(receiptSequence).padStart(6, "0")}.json`),
            prettyJson({
              schema_version: "validation-receipt/v1",
              sequence: receiptSequence,
              attempt: receiptSequence,
              ok,
              issues: ok ? [] : [{ code: "fixture_failure", path: "/", message: "fixture" }],
              evidence_fingerprint: manifest.evidence_fingerprint,
              plan_sha256: ok ? `${receiptSequence}`.repeat(64).slice(0, 64) : "",
              validation_fingerprint: ok ? `${receiptSequence + 3}`.repeat(64).slice(0, 64) : "",
              validator: "semantic-source-plan-validator/v4",
              trigger: "decision-compile",
            }),
            "utf8",
          );
        }
        await workspace.updateState((state) => {
          state.next_validation_sequence = 4;
          state.validation_attempts = 3;
        });
        const controller = await ToolController.create(workspace);
        await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });

        expect(await controller.dispatch("compile_target_selectors", {})).toMatchObject({
          ok: true,
          validation_sequence: 4,
        });
        expect((await workspace.readState()).validation_attempts).toBe(4);
        expect((await readdir(workspace.validationDirectory)).filter((name) => /^\d{6}\.json$/u.test(name))).toHaveLength(4);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  test("reuses an identical successful selector validation and revalidates a changed candidate after recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-validation-reuse-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });

      const first = await controller.dispatch("compile_target_selectors", {});
      expect(first).toMatchObject({ ok: true, validation_sequence: 1 });
      const firstWorkingPlan = JSON.parse(await readFile(workspace.workingPlanPath, "utf8")) as Record<string, unknown>;
      const firstLastValidPlan = JSON.parse(await readFile(workspace.lastValidPlanPath, "utf8")) as Record<string, unknown>;
      const firstReceipt = JSON.parse(await readFile(
        join(workspace.validationDirectory, "000001.json"),
        "utf8",
      )) as Record<string, unknown>;
      expect(firstWorkingPlan).toMatchObject({
        schema_version: "semantic-source-plan/v8",
        source_spans: expect.any(Array),
      });
      expect(firstLastValidPlan).toEqual(firstWorkingPlan);
      expect(JSON.stringify(firstLastValidPlan)).not.toContain("source_fragments");
      expect(firstReceipt).toMatchObject({ validator: "semantic-source-plan-validator/v5" });
      const firstState = await workspace.readState();
      expect(firstState).toMatchObject({ validation_attempts: 1, next_validation_sequence: 2 });

      const reused = await controller.dispatch("compile_target_selectors", {});
      expect(reused).toMatchObject({
        ok: true,
        validation_sequence: 1,
        validation_reused: true,
        fingerprint: first.fingerprint,
        plan_sha256: first.plan_sha256,
      });
      expect(await workspace.readState()).toMatchObject({ validation_attempts: 1, next_validation_sequence: 2 });
      expect((await readdir(workspace.validationDirectory)).filter((name) => /^\d{6}\.json$/u.test(name))).toHaveLength(1);

      const changed = structuredClone(selectors);
      changed.items[0]!.reason = `${changed.items[0]!.reason}（候选已改变）`;
      await workspace.writeWorkingSelectors(prettyJson(changed));
      await workspace.updateState((state) => {
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.repair = {
          ...state.repair!,
          mode: "modeling",
        };
      });
      const revalidated = await controller.dispatch("compile_target_selectors", {});
      expect(revalidated).toMatchObject({ ok: true, validation_sequence: 2 });
      expect(revalidated).not.toHaveProperty("validation_reused");
      expect(await workspace.readState()).toMatchObject({ validation_attempts: 2, next_validation_sequence: 3 });

      await workspace.markTerminal("failed", "exercise deterministic receipt recovery");
      const recoveredWorkspace = await RevisionWorkspace.reviseFromTerminalFailure(
        root,
        manifest.job_id,
        manifest.target_id,
      );
      controller = await ToolController.create(recoveredWorkspace);
      const recovered = await controller.dispatch("compile_target_selectors", {});
      expect(recovered).toMatchObject({
        ok: true,
        validation_sequence: 2,
        validation_reused: true,
        fingerprint: revalidated.fingerprint,
        plan_sha256: revalidated.plan_sha256,
      });
      expect(await recoveredWorkspace.readState()).toMatchObject({
        validation_attempts: 2,
        next_validation_sequence: 3,
      });
      expect((await readdir(recoveredWorkspace.validationDirectory)).filter((name) => /^\d{6}\.json$/u.test(name))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("draft saves expose local compiler errors and stage gates block them without rollback", async () => {
    const root=await mkdtemp(join(tmpdir(),"draft-no-compile-"));
    try {
      const {manifest,selectors}=fixture();
      const workspace=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller=await ToolController.create(workspace);
      const item=structuredClone(selectors.items[0]!);
      item.fields.method={composition:"not_applicable",span_ids:item.criterion_span_ids,separator:"",reason:"尚未完成的字段决定"};
      const staged = await controller.dispatch("stage_target_selector_draft",{draft:{items:[item]}});
      expect(staged).toMatchObject({
        ok:true,
        draft_status:"saved_local_validation_failed",
        content_validation_performed:true,
        global_candidate_complete:false,
        local_validation:{ok:false,validation_scope:"touched_records",global_completeness_checked:false},
      });
      expect(JSON.stringify(staged)).toContain("selector_empty_field_binding");
      expect(await controller.dispatch("advance_target_selector_stage",{next_stage:"sampling"})).toMatchObject({
        ok:false,
        error:"selector_repair_required",
        current_stage:"primary",
        next_tool:"read_target_selectors",
        full_stage_check_performed:false,
      });
      const repaired = await controller.dispatch("stage_target_selector_draft",{draft:{items:selectors.items}});
      expect(repaired).toMatchObject({ok:true,draft_status:"saved_local_validation_passed",local_validation:{ok:true}});
      expect(await controller.dispatch("advance_target_selector_stage",{next_stage:"sampling"})).toMatchObject({ok:true,draft_status:"stage_complete",content_validation_performed:true});
      expect(await controller.dispatch("patch_target_selectors",{operations:[{op:"replace",path:"/items/0/name",value:"局部修改后的项目"}]})).toMatchObject({ok:true,draft_status:"saved_not_validated"});
      const before=await readFile(workspace.workingSelectorPath,"utf8");
      expect(await controller.dispatch("patch_target_selectors",{operations:[{op:"replace",path:"/items/0/criterion_span_ids/0",value:"span:00000000000000000000000000000000"}]})).toMatchObject({ok:false,error:"selector_draft_span_validation"});
      expect(await readFile(workspace.workingSelectorPath,"utf8")).toBe(before);
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");
      expect(await controller.dispatch("compile_target_selectors",{})).toMatchObject({ok:false});
    } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  });

  test("keeps incremental correction drafts without automatic rule checks or rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "draft-no-rollback-"));
    try {
      const {manifest,selectors}=fixture();
      const workspace=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
      let controller=await ToolController.create(workspace);
      await controller.dispatch("stage_target_selector_draft",{draft:{lots:selectors.lots}});
      const item=structuredClone(selectors.items[0]!);
      item.lot_key="unfinished-lot";
      let saved=await controller.dispatch("stage_target_selector_draft",{draft:{items:[item]}});
      expect(saved).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true});
      await workspace.updateState(s=>{s.selector_stage="commit";});
      controller=await ToolController.create(workspace);
      const failed=await controller.dispatch("commit_target_selector_draft",{draft_fingerprint:saved.draft_fingerprint});
      expect(failed).toMatchObject({ok:false,issue_owner:"selector_input_error"});
      const protocol=(await workspace.readState()).selector_protocol;
      for (const name of ["第一版草稿","第二版草稿","第三版草稿"]) {
        item.name=name;
        saved=await controller.dispatch("stage_target_selector_draft",{draft:{items:[item]}});
        expect(saved).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true});
        expect(saved).not.toHaveProperty("preflight_ok");
        expect(saved).not.toHaveProperty("restored_to_best");
        expect((await workspace.readState()).selector_protocol).toEqual(protocol);
      }
      const before=await readFile(workspace.workingSelectorPath,"utf8");
      controller=await ToolController.create(await RevisionWorkspace.openLatest(root,manifest.job_id,manifest.target_id));
      expect(await readFile(workspace.workingSelectorPath,"utf8")).toBe(before);
      expect(JSON.parse(before).items[0]).toEqual(item);
      saved=await controller.dispatch("stage_target_selector_draft",{draft:{items:selectors.items}});
      await controller.dispatch("open_evidence",{evidence_id:manifest.evidence[0]!.evidence_id});
      expect(await controller.dispatch("commit_target_selector_draft",{draft_fingerprint:saved.draft_fingerprint})).toMatchObject({ok:true});
      expect((await workspace.readState()).status).not.toBe("sealed");
    } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  });

  test("one semantic correction remains available after an initially valid selector commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-valid-correction-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      expect(await controller.dispatch("submit_target_selectors", {
        content: prettyJson(selectors),
      })).toMatchObject({ ok: true });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 1,
        corrections: 0,
        last_issue_owner: "",
      });

      const correctedLots = structuredClone(selectors.lots);
      correctedLots[0]!.reason = `${correctedLots[0]!.reason} coverage repair`;
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { lots: correctedLots },
      });
      expect(staged).toMatchObject({ ok: true, draft_fingerprint: expect.any(String) });
      expect(await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: staged.draft_fingerprint,
      })).toMatchObject({
        ok: true,
        selector_transaction: "correction",
        budget_consumed: true,
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 1,
        corrections: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("coverage draft saves retain the whole affected-item checklist while reporting local diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-quiet-draft-"));
    try {
      const { manifest, selectors } = fixture();
      selectors.items = Array.from({ length: 5 }, (_, index) => ({
        ...structuredClone(selectors.items[0]!), key: `surface-${index}`, name: `基层表面质量${index}`,
      }));
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await writeFile(workspace.lastValidSelectorPath, prettyJson(selectors));
      await workspace.updateState((state) => {
        state.selector_stage = "coverage_repair";
        state.repair = { ...state.repair!, mode: "repair", repair_source: "coverage",
          coverage_finding_ids: ["finding:five-items"],
          coverage_item_ids: selectors.items.map((item) => semanticItemIdForSelectorKey(manifest.target_id, item.key)),
        };
      });
      const controller = await ToolController.create(workspace);
      const before = await workspace.readState();
      const compiledBefore = await readFile(workspace.workingPlanPath, "utf8");
      const first = structuredClone(selectors.items[0]!);
      first.sampling.status = "pending"; // legal author draft, incomplete final decision
      const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [first] } });
      expect(staged).toMatchObject({
        ok: true, draft_status: "saved_local_validation_failed", budget_consumed: false,
        repair_progress: { affected_item_count: 5, changed_item_count: 1,
          changed_item_keys: ["surface-0"], unchanged_item_keys: ["surface-1", "surface-2", "surface-3", "surface-4"],
          review_required: true },
      });
      for (const key of ["preflight_ok", "preflight_issue_count", "preflight_stage", "ready_for_seal", "restored_to_best"]) {
        expect(staged).not.toHaveProperty(key);
      }
      expect(await readFile(workspace.workingPlanPath, "utf8")).toBe(compiledBefore);
      expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
      expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
      const explanationOnly = structuredClone(selectors.items[1]!);
      explanationOnly.reason += " 仅补充解释";
      const savedAgain = await controller.dispatch("stage_target_selector_draft", { draft: { items: [explanationOnly] } });
      expect(savedAgain.repair_progress).toMatchObject({ changed_item_count: 1, unchanged_item_keys: expect.arrayContaining(["surface-1"]) });
      const invalid = structuredClone(first);
      invalid.criterion_span_ids = [`span:${"f".repeat(32)}`];
      const content = await readFile(workspace.workingSelectorPath, "utf8");
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [invalid] } }))
        .toMatchObject({ ok: false, error: "selector_draft_span_validation" });
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [{ key: "broken" }] } }))
        .toMatchObject({ ok: false, error: "selector_draft_shape_invalid" });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("coverage repair defers semantic validation until commit and keeps its original review readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-quiet-commit-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const submitted = await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
      expect(submitted).toMatchObject({ ok: true });
      expect(await controller.dispatch("compile_target_selectors", {})).toMatchObject({ ok: true });
      const original = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest);
      await sealSelectorRepairReview(workspace, controller, original.fingerprint!, original.plan!);
      await controller.beginCoverageRepair(original.fingerprint!);
      const bad = structuredClone(selectors.items[0]!);
      bad.sampling.status = "pending";
      const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [bad] } });
      expect(staged).toMatchObject({ ok: true, draft_status: "saved_local_validation_failed" });
      expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({ ok: true, review: { status: "repair" } });
      const rejected = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint });
      expect(rejected).toMatchObject({ ok: false, issue_owner: "selector_input_error", budget_consumed: false });
      expect((await workspace.readState()).selector_protocol?.coverage_repairs).toBe(0);
      const located = await controller.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: manifest.evidence[0]!.evidence_id, quote: "基层表面应平整、密实。" }],
      });
      const precise = String((located.results as Array<{ span: { span_id: string } }>)[0]!.span.span_id);
      const fixed = structuredClone(selectors.items[0]!);
      fixed.fields.requirement.span_ids = [precise];
      const saved = await controller.dispatch("stage_target_selector_draft", { draft: { items: [fixed] } });
      expect(saved).toMatchObject({ ok: true, draft_status: "saved_local_validation_passed" });
      expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: saved.draft_fingerprint }))
        .toMatchObject({ ok: true, selector_transaction: "coverage_repair", budget_consumed: true });
      expect(await workspace.readState()).toMatchObject({ coverage_recheck: { finding_ids: ["finding:selector-binding"] } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("coverage instructions distinguish a saved draft from completion", () => {
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("同一已读共同规则及其适用结论可复用");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("本地通过、阶段通过、正式验证通过、封存是不同状态");
    expect(LEGACY_COVERAGE_PROTOCOL).toContain("缺项无现存 item 映射时允许有据最小新增修复");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("after one legal span batch, immediately stage");
  });

  test("failed final validation keeps coverage ownership and permits a corrected commit after reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-validation-ownership-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
      const original = await controller.dispatch("compile_target_selectors", {});
      expect(original.ok).toBe(true);
      const sourcePlan = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest).plan!;
      await sealSelectorRepairReview(workspace, controller, String(original.fingerprint), sourcePlan);
      const repair = await controller.beginCoverageRepair(String(original.fingerprint));

      // Simulate a missing target read receipt without changing immutable evidence.
      const fixed = structuredClone(selectors.items[0]!);
      fixed.name = "基层表面平整密实质量";
      const draft = await controller.dispatch("stage_target_selector_draft", { draft: { items: [fixed] } });
      (controller as unknown as { openedEvidenceIds: Set<string> }).openedEvidenceIds.clear();
      const rejected = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: draft.draft_fingerprint });
      expect(rejected).toMatchObject({ ok: false, issues: expect.arrayContaining([
        expect.objectContaining({ code: "semantic_evidence_not_opened" }),
      ]) });
      expect((await workspace.readState()).repair).toMatchObject({
        mode: "modeling", repair_source: "coverage",
        coverage_review_fingerprint: original.fingerprint,
        coverage_finding_ids: repair.coverage_finding_ids,
        coverage_item_ids: repair.coverage_item_ids,
        validation_fingerprint: repair.validation_fingerprint,
      });
      expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: draft.draft_fingerprint }))
        .toMatchObject({ ok: false, error: "non_converging_selector_repeat" });
      await controller.beginFreshRepairSession();
      controller = await ToolController.create(workspace);
      expect(controller.selectorProviderPolicy().allowed_tools).toEqual(expect.arrayContaining([
        "get_target_context", "read_coverage_review", "list_reference_occurrences", "read_reference_facts",
      ]));
      expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({ ok: true, review: { status: "repair" } });
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [fixed] } });
      expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint }))
        .toMatchObject({ ok: true, selector_transaction: "coverage_repair" });
      expect(await workspace.readState()).toMatchObject({
        selector_protocol: { submissions: 1, corrections: 0, coverage_repairs: 1 },
        coverage_recheck: { source_plan_fingerprint: original.fingerprint, finding_ids: repair.coverage_finding_ids },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("a fresh finding on the repaired candidate continues the bound transaction without spending initial submissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-followup-transaction-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
      let committed = await controller.dispatch("compile_target_selectors", {});
      for (let round = 1; round <= 2; round += 1) {
        const plan = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest).plan!;
        const sourceFingerprint = String(committed.fingerprint);
        await sealSelectorRepairReview(workspace, controller, sourceFingerprint, plan, `finding:round-${round}`);
        await controller.beginCoverageRepair(sourceFingerprint);
        controller = await ToolController.create(workspace);
        expect(await workspace.readState()).toMatchObject({
          last_valid_fingerprint: "", selector_stage: "coverage_repair",
          repair: { repair_source: "coverage", coverage_review_fingerprint: sourceFingerprint },
        });
        expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({ ok: true });
        const fixed = structuredClone(selectors.items[0]!);
        fixed.name = round === 1 ? "基层表面平整质量" : "基层表面平整密实质量";
        const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [fixed] } });
        expect(staged).toMatchObject({ ok: true, draft_status: expect.stringMatching(/^saved_local_validation_/u) });
        committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint });
        expect(committed, JSON.stringify({ round, committed, staged })).toMatchObject({ ok: true, selector_transaction: "coverage_repair" });
        expect(await workspace.readState()).toMatchObject({
          selector_protocol: { submissions: 1, corrections: 0, coverage_repairs: 1 },
          coverage_recheck: { source_plan_fingerprint: sourceFingerprint, finding_ids: [`finding:round-${round}`] },
        });
      }
      expect((await workspace.readState()).validation_attempts).toBe(3);
      expect(await controller.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint }))
        .toMatchObject({ ok: false, error: "domain_coverage_review_required" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("one coverage repair commit is independent from the single semantic correction budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-coverage-budget-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      expect(await controller.dispatch("submit_target_selectors", {
        content: prettyJson(selectors),
      })).toMatchObject({ ok: true });

      const corrected = structuredClone(selectors.items);
      corrected[0]!.reason = `${corrected[0]!.reason} semantic correction`;
      const correctionDraft = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: corrected },
      });
      expect(await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: correctionDraft.draft_fingerprint,
      })).toMatchObject({ ok: true, selector_transaction: "correction" });

      await workspace.updateState((state) => {
        state.selector_stage = "coverage_repair";
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.repair = {
          ...(state.repair!),
          mode: "repair",
          repair_source: "coverage",
          active_cluster: {
            key: "coverage:test",
            issue_count: 1,
            issue_fingerprint: "coverage-fixture",
            issue_codes: ["domain_coverage_repair_required"],
            item_ids: [selectors.items[0]!.key],
          },
          total_issue_count: 1,
          validation_fingerprint: "coverage-fixture",
          coverage_finding_ids: ["finding:test"],
          coverage_evidence_ids: [manifest.evidence[0]!.evidence_id],
        };
      });
      controller = await ToolController.create(workspace);
      expect(controller.selectorProviderPolicy().stage).toBe("coverage_repair");
      const repaired = structuredClone(corrected);
      repaired[0]!.reason = `${repaired[0]!.reason} coverage repair`;
      const repairDraft = await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: [repaired[0]!] },
      });
      expect(repairDraft).toMatchObject({ ok: true, draft_fingerprint: expect.any(String) });
      const repairCommit = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: repairDraft.draft_fingerprint,
      });
      expect(repairCommit, JSON.stringify(repairCommit, null, 2)).toMatchObject({
        ok: true,
        selector_transaction: "coverage_repair",
        budget_consumed: true,
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 1,
        corrections: 1,
        coverage_repairs: 1,
      });
      expect(await readFile(workspace.lastValidSelectorPath, "utf8"))
        .toBe(await readFile(workspace.workingSelectorPath, "utf8"));

      const committedSelectors = await readFile(workspace.workingSelectorPath, "utf8");
      const afterCommit = structuredClone(repaired);
      afterCommit[0]!.reason = `${afterCommit[0]!.reason} legacy post-commit mutation`;
      const mutatedSelectors = prettyJson({
        ...selectors,
        items: afterCommit,
      });
      await workspace.writeWorkingSelectors(mutatedSelectors);
      await writeFile(join(workspace.historyDirectory, "999999.json"), prettyJson({
        schema_version: "selector-history/v1",
        sequence: 999999,
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        operation: "legacy-post-commit-stage",
        repair_finding_ids: [],
        before_sha256: sha256Text(committedSelectors),
        after_sha256: sha256Text(mutatedSelectors),
        unified_patch: createTwoFilesPatch(
          "working.target-selectors.json",
          "working.target-selectors.json",
          committedSelectors,
          mutatedSelectors,
          "before",
          "after",
        ),
      }), "utf8");
      await unlink(workspace.lastValidSelectorPath);
      await workspace.updateState((state) => {
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.selector_stage = "coverage_repair";
        state.repair = {
          ...state.repair!,
          mode: "modeling",
          repair_source: "validation",
        };
      });
      controller = await ToolController.create(workspace);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(committedSelectors);
      expect(await workspace.readState()).toMatchObject({
        selector_stage: "commit",
        repair: { mode: "validated" },
        last_valid_fingerprint: repairCommit.fingerprint,
      });

      const secondRepair = structuredClone(repaired);
      secondRepair[0]!.reason = `${secondRepair[0]!.reason} second`;
      const secondDraft = await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: secondRepair },
      });
      expect(secondDraft).toMatchObject({
        ok: false,
        terminal: false,
        error: "validated_selectors_require_seal",
        budget_consumed: false,
      });
      expect((await workspace.readState()).selector_protocol).toMatchObject({
        submissions: 1,
        corrections: 1,
        coverage_repairs: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("routes coverage findings while preserving agent-authored repair changes for re-review", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-coverage-no-effect-"));
    try {
      const affectedText = "基层表面应平整、密实。";
      const unrelatedText = "辅助表面应清洁、完整。";
      const { manifest, selectors } = fixture(`${affectedText}\n${unrelatedText}`);
      const registered = registerQuotes(manifest, [affectedText, unrelatedText]);
      const affectedSpanId = registered.ids.get(affectedText)!;
      const unrelatedSpanId = registered.ids.get(unrelatedText)!;
      selectors.items[0]!.criterion_span_ids = [affectedSpanId];
      selectors.items[0]!.fields.name.span_ids = [affectedSpanId];
      selectors.items[0]!.fields.requirement.span_ids = [affectedSpanId];
      selectors.items[0]!.inspection_data_type_span_ids = [affectedSpanId];
      const unrelatedItem = structuredClone(selectors.items[0]!);
      unrelatedItem.key = "unrelated-surface";
      unrelatedItem.name = "辅助表面质量";
      unrelatedItem.criterion_span_ids = [unrelatedSpanId];
      unrelatedItem.fields.name.span_ids = [unrelatedSpanId];
      unrelatedItem.fields.requirement.span_ids = [unrelatedSpanId];
      unrelatedItem.inspection_data_type_span_ids = [unrelatedSpanId];
      selectors.items.push(unrelatedItem);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registered.registry), "utf8");
      const controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      expect(await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) }))
        .toMatchObject({ ok: true });
      const submitted = await controller.dispatch("compile_target_selectors", {});
      expect(submitted).toMatchObject({ ok: true, fingerprint: expect.any(String) });
      const planFingerprint = String(submitted.fingerprint);
      const planValidation = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest);
      expect(planValidation).toMatchObject({ ok: true, fingerprint: planFingerprint });
      const plan = planValidation.plan!;
      const affectedItemId = await sealSelectorRepairReview(workspace, controller, planFingerprint, plan);

      expect(await controller.dispatch("read_coverage_review", {})).toMatchObject({
        ok: true,
        review: { status: "repair" },
        affected_selector_bindings: [expect.objectContaining({
          final_item_id: affectedItemId,
          reference_origin_item_id: affectedItemId,
          selector_key: "surface",
          selector_path: "/items/0",
          current_span_ids: expect.arrayContaining([selectors.items[0]!.criterion_span_ids[0]]),
          mapping_status: "mapped",
        })],
      });
      expect(await controller.dispatch("seal_validated_plan", { fingerprint: planFingerprint })).toMatchObject({
        ok: false,
        error: "domain_coverage_repair_required",
        affected_selector_bindings: [expect.objectContaining({ selector_key: "surface" })],
      });

      const repair = await controller.beginCoverageRepair(planFingerprint);
      expect(repair.coverage_item_ids).toEqual([affectedItemId]);
      const replayed = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: targetSelectorFingerprint(selectors),
      });
      expect(replayed).toMatchObject({
        ok: false,
        error: "coverage_repair_candidate_already_rejected",
        budget_consumed: false,
        affected_selector_bindings: [expect.objectContaining({ selector_key: "surface" })],
      });

      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "replace_collection",
        draft: { items: [selectors.items[0]!] },
      })).toMatchObject({
        ok: false,
        error: "coverage_repair_replace_collection_forbidden",
      });

      const collateral = structuredClone(selectors.items);
      collateral[0]!.name = "基层表面质量复核";
      collateral[1]!.name = "辅助表面质量复核";
      const repairLot = {
        ...structuredClone(selectors.lots[0]!),
        key: "repair-lot",
        name: "修复新增检验批",
      };
      expect(await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { lots: [repairLot] },
      })).toMatchObject({ ok: true });
      const splitOwner = structuredClone(collateral[0]!);
      splitOwner.key = "surface-split";
      splitOwner.name = "基层密实度";
      splitOwner.lot_key = repairLot.key;
      const changedOwnerStage = await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: [...collateral, splitOwner] },
      });
      expect(await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: changedOwnerStage.draft_fingerprint,
      })).toMatchObject({
        ok: true,
        selector_transaction: "coverage_repair",
        budget_consumed: true,
      });
      expect(await workspace.readState()).toMatchObject({
        selector_protocol: { coverage_repairs: 1 },
        coverage_recheck: {
          finding_ids: ["finding:selector-binding"],
          affected_item_ids: expect.arrayContaining([
            affectedItemId,
            semanticItemIdForSelectorKey(manifest.target_id, "unrelated-surface"),
            semanticItemIdForSelectorKey(manifest.target_id, "surface-split"),
          ]),
        },
      });
      const repairedSelectors = migrateTargetSelectorPlanForAuthoring(
        JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")),
      ).plan;
      expect(repairedSelectors.items[1]).toEqual(collateral[1]);
      expect(repairedSelectors.items.map((item) => item.key)).toContain("surface-split");
      expect(repairedSelectors.lots).toContainEqual(repairLot);
      const events = (await readFile(workspace.transcriptPath, "utf8")).trim().split(/\r?\n/u)
        .filter(Boolean).map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
      expect(events.some((event) => event.event_type === "coverage_repair_unaffected_changes_reverted")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  test("reused successful coverage validation restores the deterministic recheck checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-coverage-reuse-"));
    try {
      const { manifest, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      let controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      const located = await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: "基层表面应平整、密实。",
      });
      const preciseSpanId = String((located.span as { span_id: string }).span_id);
      expect(await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) }))
        .toMatchObject({ ok: true });
      const submitted = await controller.dispatch("compile_target_selectors", {});
      expect(submitted).toMatchObject({ ok: true, fingerprint: expect.any(String) });
      const sourceFingerprint = String(submitted.fingerprint);
      const sourceValidation = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest);
      expect(sourceValidation).toMatchObject({ ok: true, fingerprint: sourceFingerprint });
      const sourcePlan = sourceValidation.plan!;
      await sealSelectorRepairReview(workspace, controller, sourceFingerprint, sourcePlan, "finding:receipt-reuse");
      const repairCheckpoint = await controller.beginCoverageRepair(sourceFingerprint);

      const changedItems = structuredClone(selectors.items);
      changedItems[0]!.fields.requirement.span_ids = [preciseSpanId];
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: [changedItems[0]!] },
      });
      const firstCommit = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: staged.draft_fingerprint,
      });
      expect(firstCommit).toMatchObject({
        ok: true,
        selector_transaction: "coverage_repair",
        validation_sequence: expect.any(Number),
      });
      const receiptCount = (await readdir(workspace.validationDirectory))
        .filter((name) => /^\d{6}\.json$/u.test(name)).length;

      await workspace.updateState((state) => {
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        state.selector_stage = "coverage_repair";
        state.repair = repairCheckpoint;
        state.selector_protocol = {
          ...state.selector_protocol!,
          coverage_repairs: 0,
        };
        delete state.coverage_recheck;
      });
      controller = await ToolController.create(workspace);
      const reused = await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: String(staged.draft_fingerprint),
      });
      expect(reused).toMatchObject({
        ok: true,
        selector_transaction: "coverage_repair",
        validation_reused: true,
      });
      expect((await readdir(workspace.validationDirectory))
        .filter((name) => /^\d{6}\.json$/u.test(name))).toHaveLength(receiptCount);
      expect(await workspace.readState()).toMatchObject({
        coverage_recheck: {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: reused.fingerprint,
          source_plan_fingerprint: sourceFingerprint,
          finding_ids: ["finding:receipt-reuse"],
          affected_item_ids: expect.arrayContaining(repairCheckpoint.coverage_item_ids),
          affected_evidence_ids: expect.arrayContaining([manifest.evidence[0]!.evidence_id]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker keeps actionable selector preflight issues nonterminal and exposes repair tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-blocker-gate-"));
    try {
      const firstCriterion = "项目甲应符合设计要求。";
      const secondCriterion = "项目乙应符合设计要求。";
      const text = `${firstCriterion}\n${secondCriterion}\n每批抽取3件检查。`;
      const manifest = manifestFor(text);
      const registered = registerQuotes(manifest, [text, firstCriterion, secondCriterion]);
      const fullSpanId = registered.ids.get(text)!;
      const firstSpanId = registered.ids.get(firstCriterion)!;
      const secondSpanId = registered.ids.get(secondCriterion)!;
      const selectors = fixture(text).selectors;
      selectors.lots[0]!.scope_span_ids = [fullSpanId];
      const firstItem = selectors.items[0]!;
      firstItem.key = "first";
      firstItem.name = "项目甲";
      firstItem.criterion_span_ids = [firstSpanId];
      firstItem.fields.name.span_ids = [firstSpanId];
      firstItem.fields.requirement.span_ids = [firstSpanId];
      firstItem.fields.quantity = {
        composition: "verbatim",
        span_ids: [fullSpanId],
        separator: "",
        reason: "复现跨项目窗口被误绑为标量数量",
      };
      firstItem.inspection_data_type_span_ids = [firstSpanId];
      firstItem.sampling = {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [fullSpanId],
        script_span_ids: [fullSpanId],
        condition_span_ids: [],
        reason: "复现跨项目窗口被误绑为行内抽样",
        confidence: 1,
      };
      const secondItem = structuredClone(firstItem);
      secondItem.key = "second";
      secondItem.name = "项目乙";
      secondItem.criterion_span_ids = [secondSpanId];
      secondItem.fields.name.span_ids = [secondSpanId];
      secondItem.fields.requirement.span_ids = [secondSpanId];
      secondItem.fields.quantity = {
        composition: "not_applicable",
        span_ids: [],
        separator: "",
        reason: "第二项目不绑定数量",
      };
      secondItem.inspection_data_type_span_ids = [secondSpanId];
      secondItem.sampling = {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "第二项目不形成抽样",
        confidence: 1,
      };
      selectors.items.push(secondItem);
      // Two real structural omissions; the broad-range business concern is advisory.
      firstItem.fields.quantity.span_ids = [];
      firstItem.fields.method = { composition: "verbatim", span_ids: [], separator: "", reason: "待填写来源决定。" };

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registered.registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "commit"; });
      const controller = await ToolController.create(workspace);

      expect(controller.selectorProviderPolicy()).toMatchObject({
        stage: "commit",
        allowed_tools: expect.arrayContaining([
          "read_target_selectors",
          "list_evidence_resources",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
        ]),
      });
      expect(await controller.dispatch("compile_target_selectors",{})).toMatchObject({ok:false});
      const protocolBefore = (await workspace.readState()).selector_protocol;
      const blocked = await controller.dispatch("report_target_blocker", {
        kind: "harness_contract_defect",
        evidence_span_ids: [fullSpanId],
        affected_selector_paths: ["/items/0/fields/quantity/span_ids/0"],
        finding_ids: ["selector_nonempty_field_unbound"],
        explanation: "当前标量绑定跨越多个项目边界，需要先登记精确来源 span。",
      });
      expect(blocked).toMatchObject({
        ok: false,
        terminal: false,
        ready: false,
        budget_consumed: false,
        error: "target_blocker_rejected_actionable_selector_issues",
        issue_owner: "selector_input_error",
        preflight_stage: "selector-local",
        selector_issue_page: {
          reported_issue_count: 2,
          total_issue_count: 2,
          remaining_issue_count: 0,
        },
        required_tools: expect.arrayContaining([
          "read_target_selectors",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
        ]),
      });
      expect(blocked.selector_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_nonempty_field_unbound" }),
      ]));
      expect(blocked.actionable_issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_nonempty_field_unbound",
          path: expect.stringMatching(/^\/items\/0/),
        }),
      ]));
      expect(controller.selectorProviderPolicy().allowed_tools).not.toContain("report_target_blocker");
      expect((await workspace.readState()).selector_protocol).toEqual(protocolBefore);
      const events = (await readFile(workspace.transcriptPath, "utf8"))
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { event_type: string });
      expect(events.some((event) => event.event_type === "target_selector_blocker")).toBe(false);

      expect(await controller.dispatch("read_target_selectors", {
        collection: "items",
        key: "first",
      })).toMatchObject({ ok: true, rows: [expect.objectContaining({ key: "first" })] });
      expect(await controller.dispatch("open_evidence", {
        evidence_id: manifest.evidence[0]!.evidence_id,
      })).toMatchObject({ ok: true });
      const located = await controller.dispatch("locate_evidence_span", {
        evidence_id: manifest.evidence[0]!.evidence_id,
        quote: "每批抽取3件检查。",
      });
      expect(located).toMatchObject({ ok: true, span: { span_id: expect.any(String) } });
      const preciseSamplingSpanId = String((located.span as { span_id: string }).span_id);
      const repairedFirstItem = structuredClone(firstItem);
      repairedFirstItem.fields.method = { composition: "not_applicable", span_ids: [], separator: "", reason: "本例原文未指定方法。" };
      repairedFirstItem.fields.quantity.span_ids = [preciseSamplingSpanId];
      repairedFirstItem.sampling.quantity_span_ids = [preciseSamplingSpanId];
      repairedFirstItem.sampling.script_span_ids = [preciseSamplingSpanId];
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert",
        draft: { items: [repairedFirstItem] },
      });
      expect(staged).toMatchObject({ok:true,draft_status:"saved_local_validation_passed",content_validation_performed:true,budget_consumed:false});
      expect(controller.selectorProviderPolicy().allowed_tools).toContain("report_target_blocker");
      expect(await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: staged.draft_fingerprint,
      })).toMatchObject({
        ok: true,
        selector_transaction: "initial",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("allows one indivisible merged table cell to serve as both allowed value and inspection method", () => {
    const text = "<table><tr><td>Member Delta</td><td colspan=\"2\">Value and method combined</td></tr></table>";
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [text, "Member Delta", "Value and method combined"]);
    const fullSpan = registered.ids.get(text)!;
    const memberSpan = registered.ids.get("Member Delta")!;
    const mergedCellSpan = registered.ids.get("Value and method combined")!;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "Lot", scope_span_ids: [fullSpan], reason: "One table scope" });
    selectors.items.push({
      key: "merged-cell",
      lot_key: "lot",
      name: "Member Delta",
      category: "一般项目",
      criterion_span_ids: [memberSpan],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [memberSpan], separator: "", reason: "Exact row name" },
        requirement: { composition: "verbatim", span_ids: [mergedCellSpan], separator: "", reason: "The cell contains the criterion" },
        method: { composition: "verbatim", span_ids: [mergedCellSpan], separator: "", reason: "The same indivisible cell contains the method" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "No quantity" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "No note" },
      },
      table: {
        source_kind: "direct",
        table_key: "merged-cell-table",
        properties: {
          table_no_span_ids: [],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [[memberSpan]],
          column_path_span_ids: [],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [mergedCellSpan],
          inspection_method_span_ids: [mergedCellSpan],
        },
        reference_span_ids: [],
        reason: "The source has one indivisible merged value/method cell",
      },
      inspection_data_type: "mixed",
      inspection_data_type_reason: "The merged cell contains criterion and method",
      inspection_data_type_span_ids: [mergedCellSpan],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "No sampling",
        confidence: 1,
      },
      reason: "One physical table row",
    });
    expect(() => compileTargetSelectorsPersisted(selectors, registered.registry, manifest)).not.toThrow();
  });

  test("keeps a faithfully authored empty lot in selector correction instead of terminating the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-empty-lot-owner-"));
    try {
      const { manifest, registry, selectors } = fixture();
      selectors.lots.push({
        key: "unsupported-empty-lot",
        name: "待补充检验批",
        scope_span_ids: [selectors.lots[0]!.scope_span_ids[0]!],
        reason: "故意构造没有验收项目的可修草稿",
      });
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "commit"; });
      const controller = await ToolController.create(workspace);

      expect(await controller.dispatch("commit_target_selector_draft", {
        draft_fingerprint: targetSelectorFingerprint(selectors),
      })).toMatchObject({
        ok: false,
        terminal: false,
        error: "selector_input_error",
        issue_owner: "selector_input_error",
        stage: "strict-validator-preflight",
        budget_consumed: false,
        issues: [expect.objectContaining({
          code: "agent_empty_lot",
          path: "/lots/1",
          owner: "selector_input_error",
          details: expect.objectContaining({
            lot_key: "unsupported-empty-lot",
            required_action: "add_at_least_one_acceptance_item_to_this_lot_or_remove_the_unsupported_lot",
          }),
        })],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("routes faithful strict field relation failures to the exact authored selector span while preserving real compiler drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-strict-owner-"));
    try {
      const criterion = "Platform installation shall satisfy the acceptance criterion.";
      const externalMethod = "Inspect with the referenced gauge.";
      const manifest = manifestFor(criterion);
      const externalEvidenceId = "atom:selector-external-method";
      manifest.evidence.push({
        evidence_id: externalEvidenceId,
        kind: "paragraph",
        role: "supporting_clause",
        locator: `char:0-${externalMethod.length}`,
        text: externalMethod,
        text_sha256: sha256Text(externalMethod),
        requires_disposition: false,
        evidence_scope: "reference",
      });
      manifest.evidence_fingerprint = sha256Text(`evidence\0${criterion}\0${externalMethod}`);
      const sources = manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      }));
      let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
      const primarySpan = registry.spans.find((span) => span.evidence_id === manifest.evidence[0]!.evidence_id)!;
      const locatedMethod = locateAndRegisterSourceQuote(
        registry,
        sources.find((source) => source.evidence_id === externalEvidenceId)!,
        externalMethod,
      );
      registry = locatedMethod.registry;
      const methodSpan = locatedMethod.spans[0]!;
      const selectors = initialTargetSelectorPlan(manifest);
      selectors.lots.push({ key: "lot", name: "Platform lot", scope_span_ids: [primarySpan.span_id], reason: "Primary scope" });
      selectors.items.push({
        key: "platform",
        lot_key: "lot",
        name: "Platform installation",
        category: "一般项目",
        criterion_span_ids: [primarySpan.span_id],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [primarySpan.span_id], separator: "", reason: "Business name" },
          requirement: { composition: "verbatim", span_ids: [primarySpan.span_id], separator: "", reason: "Exact criterion" },
          method: { composition: "reference", span_ids: [methodSpan.span_id], separator: "", reason: "Deliberately unrouted external method" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "No quantity" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "No note" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "Review criterion",
        inspection_data_type_span_ids: [primarySpan.span_id],
        sampling: {
          status: "fallback",
          rule_key: "",
          branch_keys: [],
          quantity_span_ids: [],
          script_span_ids: [],
          condition_span_ids: [],
          reason: "No sampling",
          confidence: 1,
        },
        reason: "Independent item",
      });

      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const strict = validatePlanText(prettyJson(persisted), manifest);
      expect(strict.ok).toBe(false);
      const faithful = classifyStrictSelectorIssues(selectors, persisted, registry, strict.issues);
      expect(faithful).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "field_binding_relation",
          path: "/items/0/fields/method/span_ids/0",
          owner: "selector_input_error",
          details: expect.objectContaining({
            compiled_path: "/acceptance_items/0/field_bindings/method/evidence_ids",
          }),
        }),
        expect.objectContaining({
          code: "field_binding_reference_route",
          path: "/items/0/fields/method/span_ids/0",
          owner: "selector_input_error",
        }),
      ]));

      const drifted = structuredClone(persisted);
      if (drifted.schema_version !== "semantic-source-plan/v8") throw new Error("Expected compact compiler output");
      drifted.acceptance_items[0]!.field_bindings.method.source_span_ids = [
        drifted.acceptance_items[0]!.field_bindings.requirement.source_span_ids[0]!,
      ];
      expect(classifyStrictSelectorIssues(selectors, drifted, registry, strict.issues))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "field_binding_relation", owner: "compiler_invariant_violation" }),
        ]));

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(criterion) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);
      const stagePreflight = await controller.dispatch("compile_target_selectors", {});
      expect(stagePreflight).toMatchObject({ok: false,error: "selector_input_error",issue_owner: "selector_input_error",stage: "strict-validator-preflight",issues: expect.arrayContaining([
            expect.objectContaining({
              code: "field_binding_relation",
              path: "/items/0/fields/method/span_ids/0",
              owner: "selector_input_error",
            }),
          ])});
      expect(stagePreflight).not.toHaveProperty("reference_commit_checklist");
      await workspace.updateState((state) => { state.selector_stage = "commit"; });
      const commitController = await ToolController.create(workspace);
      const commitPreflight = await commitController.dispatch("commit_target_selector_draft", {
        draft_fingerprint: targetSelectorFingerprint(selectors),
      });
      expect(commitPreflight).toMatchObject({
        ok: false,
        terminal: false,
        issue_owner: "selector_input_error",
        stage: "strict-validator-preflight",
        budget_consumed: false,
      });
      expect(commitPreflight).not.toHaveProperty("reference_commit_checklist");
      expect(await workspace.readState()).toMatchObject({
        selector_protocol: {
          submissions: 0,
          corrections: 0,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  describe("table path input contract", () => {
    function pathFixture(text?: string) {
      const prepared = fixture(text);
      const full = prepared.selectors.items[0]!.criterion_span_ids[0]!;
      prepared.selectors.items[0]!.table = {
        source_kind: "direct", table_key: "surface-table", reference_span_ids: [],
        reason: "Synthetic table navigation contract, independent of any specification.",
        properties: {
          table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
          row_path_span_ids: [[full]], column_path_span_ids: [], unit_span_ids: [],
          condition_span_ids: [], allowed_value_span_ids: [full], inspection_method_span_ids: [],
        },
      };
      return { ...prepared, full };
    }

    test.each(["row_path_span_ids", "column_path_span_ids"] as const)("rejects empty and mixed %s entries through every schema and the compiler", field => {
      const { manifest, registry, selectors, full } = pathFixture();
      for (const paths of [[[]], [[full], []], [[], [full]]]) {
        selectors.items[0]!.table!.properties[field] = paths;
        const index = paths.findIndex(ids => ids.length === 0);
        const path = `/items/0/table/properties/${field}/${index}`;
        expect(Check(TARGET_SELECTOR_PLAN_JSON_SCHEMA, selectors)).toBe(false);
        expect(Check(TARGET_SELECTOR_DRAFT_JSON_SCHEMA, { items: selectors.items })).toBe(false);
        for (const schema of [TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA]) {
          expect(Check(schema, { draft: { items: selectors.items } })).toBe(false);
        }
        expect(targetSelectorSchemaIssues(selectors)).toContainEqual(expect.objectContaining({
          code: "selector_schema", path,
          details: expect.objectContaining({
            actual: [], expected: { type: "array", minItems: 1 }, writable_path: path,
            required_action: expect.stringContaining("外层 []"),
            next_tools: expect.arrayContaining(["stage_target_selector_draft"]),
          }),
        }));
        expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
        // No automatic filtering, field deletion or semantic correction.
        expect(selectors.items[0]!.table!.properties[field]).toEqual(paths);
      }
    });

    test("keeps an absent axis legal and reports unrelated malformed structures at author paths", () => {
      const { manifest, registry, selectors } = pathFixture();
      expect(Check(TARGET_SELECTOR_PLAN_JSON_SCHEMA, selectors)).toBe(true);
      const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
      expect(compiled.acceptance_items[0]!.table_semantics?.column_path).toEqual([]);
      expect(validatePlanText(prettyJson(compiled), manifest).issues).toEqual([]);
      const malformed = structuredClone(selectors) as unknown as { items: Array<{ fields: { name: { span_ids: unknown } } }> };
      malformed.items[0]!.fields.name.span_ids = null;
      expect(targetSelectorSchemaIssues(malformed)).toContainEqual(expect.objectContaining({
        path: "/items/0/fields/name/span_ids", details: expect.objectContaining({ actual: null, expected: { type: "array" } }),
      }));
      expect(() => compileTargetSelectorsPersisted(malformed, registry, manifest)).toThrow(TargetSelectorCompileError);
      expect(targetSelectorSchemaIssues(initialTargetSelectorPlan(manifest))).toEqual([]);
    });

    test("reports enum choices, missing fields and extra properties without contradictory repair instructions", () => {
      const { selectors } = pathFixture();
      const malformed = structuredClone(selectors) as any;
      malformed.items[0].fields.name.separator = "；";
      delete malformed.items[0].reason;
      malformed.items[0].extra = "misplaced value";
      const issues = targetSelectorSchemaIssues(malformed);
      expect(issues.filter(issue => issue.path === "/items/0/fields/name/separator")).toEqual([
        expect.objectContaining({ details: expect.objectContaining({
          actual: "；", expected: { allowed_values: ["", " ", "\n"] },
        }) }),
      ]);
      expect(issues).toContainEqual(expect.objectContaining({ path: "/items/0/reason",
        details: expect.objectContaining({ actual_present: false, expected: expect.objectContaining({ type: "string" }) }),
      }));
      expect(issues).toContainEqual(expect.objectContaining({ path: "/items/0/extra",
        details: expect.objectContaining({ actual: "misplaced value", expected: expect.objectContaining({
          additionalProperties: false, allowed_fields: expect.arrayContaining(["reason", "fields", "table"]),
        }) }),
      }));
    });

    test("does not lose a long enum rejection when schema diagnostics are truncated", () => {
      const choices = Array.from({ length: 20 }, (_, index) => `choice-${index}`);
      const schema = Type.Object({ choice: Type.Union(choices.map(choice => Type.Literal(choice))) });
      expect(targetSelectorSchemaIssues({ choice: "invalid" }, schema)).toEqual([
        expect.objectContaining({ path: "/choice", details: expect.objectContaining({
          actual: "invalid", expected: { allowed_values: choices },
        }) }),
      ]);
    });

    test.each([
      ["/items", (plan: any) => { plan.items = {}; }],
      ["/items/0", (plan: any) => { plan.items[0] = null; }],
      ["/items/0/fields", (plan: any) => { plan.items[0].fields = null; }],
      ["/items/0/table/properties", (plan: any) => { plan.items[0].table.properties = null; }],
      ["/items/0/sampling/branch_keys", (plan: any) => { plan.items[0].sampling.branch_keys = {}; }],
    ] as const)("rejects malformed %s before compiler assumptions can throw", (path, mutate) => {
      const { manifest, registry, selectors } = pathFixture();
      mutate(selectors);
      const before = structuredClone(selectors);
      try {
        compileTargetSelectorsPersisted(selectors, registry, manifest);
        throw new Error("Expected authoring contract rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
          code: "selector_schema", path,
          details: expect.objectContaining({ writable_path: path, next_tools: expect.arrayContaining(["stage_target_selector_draft"]) }),
        }));
      }
      expect(selectors).toEqual(before);
    });

    test.each(["row_path_span_ids", "column_path_span_ids"] as const)("rejects whitespace-only source in %s without changing the authored bindings", field => {
      const { manifest, registry, selectors } = pathFixture("基层表面应平整。 \t\n检验方法：用靠尺检查。");
      const record = manifest.evidence[0]!;
      const start = record.text.indexOf(" \t\n");
      const registered = registerSourceSpan(registry, {
        source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
      }, start, start + 3);
      selectors.items[0]!.table!.properties[field] = [[registered.span.span_id]];
      expect(Check(TARGET_SELECTOR_PLAN_JSON_SCHEMA, selectors)).toBe(true);
      try {
        compileTargetSelectorsPersisted(selectors, registered.registry, manifest);
        throw new Error("Expected empty resolved path rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
          code: "selector_table_path_empty", path: `/items/0/table/properties/${field}/0`,
          details: expect.objectContaining({ actual: { span_ids: [registered.span.span_id], resolved_text: "" },
            next_tools: expect.arrayContaining(["locate_evidence_span", "stage_target_selector_draft"]) }),
        }));
      }
      expect(selectors.items[0]!.table!.properties[field]).toEqual([[registered.span.span_id]]);
    });

    test("returns a repairable error for saved malformed paths and continues after correction without mutating a rejected patch", async () => {
      const root = await mkdtemp(join(tmpdir(), "target-selector-path-contract-"));
      try {
        const { manifest, registry, selectors } = pathFixture();
        const malformed = structuredClone(selectors);
        malformed.items[0]!.table!.properties.column_path_span_ids = [[]];
        const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {
          manifest, markdown: Buffer.from(manifest.evidence[0]!.text),
        });
        await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
        await workspace.writeWorkingSelectors(prettyJson(malformed));
        await workspace.updateState(state => {
          state.selector_stage = "table";
          state.target_review_protocol = "direct-validation/v1";
        });
        const controller = await ToolController.create(workspace);
        for (const record of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
        const compiled = await controller.dispatch("compile_target_selectors", {});
        expect(compiled).toMatchObject({ ok: false, terminal: false, issue_owner: "selector_input_error" });
        const selectorBefore = await readFile(workspace.workingSelectorPath, "utf8");
        const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
        const patch = { operation: "upsert", draft: { items: malformed.items } };
        const rejected = await controller.dispatch("stage_target_selector_draft", patch);
        expect(rejected).toMatchObject({
          ok: false, terminal: false, durable_mutation: false, budget_consumed: false,
          selector_issues: expect.arrayContaining([expect.objectContaining({
            path: "/draft/items/0/table/properties/column_path_span_ids/0",
            details: expect.objectContaining({ actual: [], expected: { minItems: 1, type: "array" } }),
          })]),
        });
        expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorBefore);
        expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
        const tool = createPiTools(controller).find(tool => tool.name === "stage_target_selector_draft")!;
        const codec = await ModelSourceHandles.open(workspace.root);
        const wrapped = codec.wrapTools([tool])[0]!;
        const encoded = await codec.encode(patch) as any;
        let admission: any;
        try { wrapped.prepareArguments!(encoded); } catch (error) { admission = JSON.parse((error as Error).message); }
        expect(admission).toMatchObject({
          error: "tool_argument_shape_invalid", terminal: false, durable_mutation: false, budget_consumed: false,
          issues: [expect.objectContaining({
            path: "/draft/items/0/table/properties/column_path_span_ids/0", actual: [],
            expected: { json_type: "array", minItems: 1, description: expect.stringContaining("外层 []") },
            next_tool: "stage_target_selector_draft",
          })],
        });
        const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: selectors.items } });
        expect(staged).toMatchObject({ ok: true });
        const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint });
        expect(committed).toMatchObject({ ok: true });
        expect(await controller.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint }))
          .toMatchObject({ ok: true, status: "passed" });
        expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(true);
        expect((await workspace.readState()).selector_protocol).toMatchObject({ corrections: 0, protocol_failures: 0 });
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  test("routes a faithfully empty direct-table semantic path back to selector repair and preserves compiler drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-table-path-owner-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const full = selectors.items[0]!.criterion_span_ids[0]!;
      selectors.items[0]!.table = {
        source_kind: "direct",
        table_key: "surface-table",
        properties: {
          table_no_span_ids: [],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [],
          column_path_span_ids: [],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [full],
          inspection_method_span_ids: [],
        },
        reference_span_ids: [],
        reason: "Deliberately omits the authored semantic row or column path.",
      };

      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const strict = validatePlanText(prettyJson(persisted), manifest);
      expect(strict.ok).toBe(false);
      expect(strict.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "table_semantic_path_missing",
          path: "/acceptance_items/0/table_semantics",
        }),
      ]));
      expect(classifyStrictSelectorIssues(selectors, persisted, registry, strict.issues))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: "table_semantic_path_missing",
            path: "/items/0/table/properties/row_path_span_ids",
            owner: "selector_input_error",
            details: expect.objectContaining({
              compiled_path: "/acceptance_items/0/table_semantics",
              alternative_selector_path: "/items/0/table/properties/column_path_span_ids",
              required_action: "bind_at_least_one_exact_semantic_row_or_column_path_cell",
            }),
          }),
        ]));

      const authoredPathButCompilerLostIt = structuredClone(selectors);
      authoredPathButCompilerLostIt.items[0]!.table!.properties.row_path_span_ids = [[full]];
      expect(classifyStrictSelectorIssues(
        authoredPathButCompilerLostIt,
        persisted,
        registry,
        strict.issues,
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "table_semantic_path_missing",
          owner: "compiler_invariant_violation",
        }),
      ]));

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("compile_target_selectors", {}))
        .toMatchObject({ok: false,error: "selector_input_error",issue_owner: "selector_input_error",stage: "strict-validator-preflight",issues: expect.arrayContaining([
            expect.objectContaining({
              code: "table_semantic_path_missing",
              path: "/items/0/table/properties/row_path_span_ids",
              owner: "selector_input_error",
            }),
          ])});
      expect(await controller.dispatch("report_target_blocker", {
        kind: "harness_contract_defect",
        evidence_span_ids: [full],
        affected_selector_paths: ["/items/0/table/properties/row_path_span_ids"],
        explanation: "A faithful selector omission is not a harness defect.",
      })).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "target_blocker_rejected_actionable_selector_issues",
        issue_owner: "selector_input_error",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("a routed referenced-table data row carries the same table's header without criterion duplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-table-evidence-owner-"));
    try {
      const anchorText = "检验方法：见表 C.0.1。";
      const headerText = "序号 | 项目 | 允许偏差(mm) | 检查方法";
      const rowText = "1 | 单元构件长度≤2000 | ±1.5 | 钢尺";
      const unroutedRowText = "2 | 单元构件长度＞2000 | ±3.0 | 钢尺";
      const manifest = manifestFor(anchorText);
      manifest.evidence.push(
        {
          evidence_id: "atom:referenced-table-header",
          kind: "table_row",
          role: "formal_table_header",
          locator: "table:C.0.1/row:1",
          text: headerText,
          text_sha256: sha256Text(headerText),
          requires_disposition: false,
          evidence_scope: "reference",
          table_row_kind: "header",
          table_id: "C.0.1",
          row_index: 1,
          registered_dependency: true,
        },
        {
          evidence_id: "atom:referenced-table-row",
          kind: "table_row",
          role: "context",
          locator: "table:C.0.1/row:2",
          text: rowText,
          text_sha256: sha256Text(rowText),
          requires_disposition: false,
          evidence_scope: "reference",
          table_row_kind: "data",
          table_id: "C.0.1",
          row_index: 2,
          registered_dependency: true,
        },
        {
          evidence_id: "atom:unrouted-referenced-table-row",
          kind: "table_row",
          role: "context",
          locator: "table:C.0.1/row:3",
          text: unroutedRowText,
          text_sha256: sha256Text(unroutedRowText),
          requires_disposition: false,
          evidence_scope: "reference",
          table_row_kind: "data",
          table_id: "C.0.1",
          row_index: 3,
          registered_dependency: true,
        },
      );
      manifest.evidence_fingerprint = sha256Text(`referenced-table\0${anchorText}\0${headerText}\0${rowText}\0${unroutedRowText}`);
      const sources = manifest.evidence.map((evidence) => ({
        source_id: evidence.evidence_id,
        evidence_id: evidence.evidence_id,
        atom_id: evidence.evidence_id,
        text: evidence.text,
      }));
      let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
      const anchorSource = sources[0]!;
      const locatedReference = locateAndRegisterSourceQuote(registry, anchorSource, "表 C.0.1");
      registry = locatedReference.registry;
      const referenceSpanId = locatedReference.spans[0]!.span_id;
      const fullSpan = (evidenceId: string) => registry.spans.find((span) =>
        span.evidence_id === evidenceId
        && span.start === 0
        && span.end === manifest.evidence.find((evidence) => evidence.evidence_id === evidenceId)!.text.length
      )!.span_id;
      const anchorSpanId = fullSpan(manifest.evidence[0]!.evidence_id);
      const headerSpanId = fullSpan("atom:referenced-table-header");
      const rowSpanId = fullSpan("atom:referenced-table-row");
      const unroutedRowSpanId = fullSpan("atom:unrouted-referenced-table-row");
      manifest.reference_occurrences.push({
        occurrence_id: "reference:table-c-0-1",
        origin_evidence_id: manifest.evidence[0]!.evidence_id,
        origin_span_id: anchorSpanId,
        reference_literal_span_id: referenceSpanId,
        reference_literal: {
          evidence_id: manifest.evidence[0]!.evidence_id,
          start: anchorText.indexOf("表 C.0.1"),
          end: anchorText.indexOf("表 C.0.1") + "表 C.0.1".length,
        },
        origin_fields: ["method"],
        raw_reference: "表 C.0.1",
        relation: "8.2.1 单元构件组装允许偏差的检验方法及验收依据",
        target_evidence_ids: ["atom:referenced-table-row", "atom:unrouted-referenced-table-row"],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["source:table:C.0.1"],
        reference_kind: "table",
        target_table_id: "C.0.1",
        target_address: {
          source_id: "source",
          locator_kind: "table",
          locator: "table:C.0.1",
        },
      });
      const selectors = initialTargetSelectorPlan(manifest);
      selectors.lots.push({
        key: "assembly-lot",
        name: "组装检验批",
        scope_span_ids: [anchorSpanId],
        reason: "8.2.1 组装范围",
      });
      selectors.items.push({
        key: "clause-8.2.1",
        lot_key: "assembly-lot",
        name: "单元构件组装允许偏差",
        category: "一般项目",
        criterion_span_ids: [rowSpanId],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [rowSpanId], separator: "", reason: "表内项目" },
          requirement: { composition: "verbatim", span_ids: [rowSpanId], separator: "", reason: "表内允许偏差" },
          method: { composition: "verbatim", span_ids: [anchorSpanId], separator: "", reason: "正文引用表 C.0.1" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "fixture 无抽样" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
        },
        table: {
          source_kind: "reference",
          table_key: "C.0.1",
          properties: {
            table_no_span_ids: [headerSpanId],
            table_title_span_ids: [],
            applicability_span_ids: [],
            row_path_span_ids: [[rowSpanId]],
            column_path_span_ids: [[headerSpanId]],
            unit_span_ids: [headerSpanId],
            condition_span_ids: [rowSpanId],
            allowed_value_span_ids: [rowSpanId],
            inspection_method_span_ids: [rowSpanId],
          },
          reference_span_ids: [referenceSpanId],
          reason: "正文引用表 C.0.1，表头和数据行为独立 evidence；表头只作列路径，未登记题注来源",
        },
        inspection_data_type: "measurement",
        inspection_data_type_reason: "表内允许偏差为量测值",
        inspection_data_type_span_ids: [rowSpanId],
        sampling: {
          status: "fallback",
          rule_key: "",
          branch_keys: [],
          quantity_span_ids: [],
          script_span_ids: [],
          condition_span_ids: [],
          reason: "fixture 不形成抽样",
          confidence: 1,
        },
        reason: "8.2.1 引用表验收项目",
      });
      selectors.references.push({
        key: "ref-8.2.1-table-c.0.1",
        anchor_span_ids: [referenceSpanId],
        target_span_ids: [rowSpanId],
        occurrence_id: "reference:table-c-0-1",
        action: "adopt",
        application_mode: "reference_only",
        import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement", "method"], reason: "引用表行提供项目名、要求和方法。" },
        destinations: [{ item_key: "clause-8.2.1", target_field: "method" }],
        reason: "引用路由只登记合法数据行；同表表头作为结构上下文随表格语义携带",
      });

      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      const strict = validatePlanText(prettyJson(persisted), manifest);
      expect(strict, JSON.stringify(strict, null, 2)).toMatchObject({ ok: true, issues: [] });

      const wronglyBorrowedDataRow = structuredClone(selectors);
      wronglyBorrowedDataRow.items[0]!.table!.properties.condition_span_ids.push(unroutedRowSpanId);
      const invalidPersisted = compileTargetSelectorsPersisted(wronglyBorrowedDataRow, registry, manifest);
      expect(validatePlanText(prettyJson(invalidPersisted), manifest)).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({
          code: "table_evidence_relation",
          details: expect.objectContaining({ actual: ["atom:unrouted-referenced-table-row"] }),
        })],
      });

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(anchorText) },
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);
      await controller.dispatch("advance_target_selector_stage", {next_stage:"commit"});
      const incompleteReference = await controller.dispatch("commit_target_selector_draft", {draft_fingerprint:targetSelectorFingerprint(selectors)});
      expect(incompleteReference).toMatchObject({
        ok: false,
        error: "inline_reference_read_incomplete",
        selector_issues: [expect.objectContaining({ code: "inline_reference_read_incomplete" })],
      });
      const targetKey = String(((incompleteReference.selector_issues as Array<{ details: { target_key: string } }>)[0]!).details.target_key);
      expect(await controller.dispatch("read_document_reference_evidence", { target_key: targetKey }))
        .toMatchObject({ ok: true, done: true });
      const compiledResult = await controller.dispatch("compile_target_selectors", {});
      expect((compiledResult.issues as Array<{ code?: string }> | undefined) ?? [])
        .not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "table_evidence_relation" }),
        ]));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  test("a referenced-table formal title bound as table_title carries provenance without criterion duplication", async () => {
    // Round-10 anchors regression: the compiler projects the logical-table
    // formal caption into every member item's cell_evidence. That caption must
    // stay reachable through the compiled structure instead of forcing the
    // model to duplicate it into criterion_span_ids (11× table_evidence_relation
    // with one shared caption source dead-ended the anchors run).
    const root = await mkdtemp(join(tmpdir(), "target-selector-inherited-title-provenance-"));
    try {
      const anchorText = "检验方法：见表 C.0.1。";
      const headerText = "序号 | 项目 | 允许偏差(mm) | 检查方法";
      const rowText = "1 | 单元构件长度≤2000 | ±1.5 | 钢尺";
      const manifest = manifestFor(anchorText);
      manifest.evidence.push(
        {
          evidence_id: "atom:referenced-table-title",
          kind: "table_title",
          role: "context",
          locator: "table:C.0.1/title",
          text: "表 C.0.1 单元构件组装允许偏差",
          text_sha256: sha256Text("表 C.0.1 单元构件组装允许偏差"),
          requires_disposition: false,
          evidence_scope: "reference",
          table_id: "C.0.1",
          registered_dependency: true,
        },
        {
          evidence_id: "atom:referenced-table-row",
          kind: "table_row",
          role: "context",
          locator: "table:C.0.1/row:2",
          text: rowText,
          text_sha256: sha256Text(rowText),
          requires_disposition: false,
          evidence_scope: "reference",
          table_row_kind: "data",
          table_id: "C.0.1",
          row_index: 2,
          registered_dependency: true,
        },
      );
      manifest.evidence_fingerprint = sha256Text(`inherited-title\0${anchorText}\0${rowText}`);
      const sources = manifest.evidence.map((evidence) => ({
        source_id: evidence.evidence_id,
        evidence_id: evidence.evidence_id,
        atom_id: evidence.evidence_id,
        text: evidence.text,
      }));
      let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
      const anchorSource = sources[0]!;
      const locatedReference = locateAndRegisterSourceQuote(registry, anchorSource, "表 C.0.1");
      registry = locatedReference.registry;
      const referenceSpanId = locatedReference.spans[0]!.span_id;
      const fullSpan = (evidenceId: string) => registry.spans.find((span) =>
        span.evidence_id === evidenceId
        && span.start === 0
        && span.end === manifest.evidence.find((evidence) => evidence.evidence_id === evidenceId)!.text.length
      )!.span_id;
      const titleSpanId = fullSpan("atom:referenced-table-title");
      const rowSpanId = fullSpan("atom:referenced-table-row");
      const anchorSpanId = fullSpan(manifest.evidence[0]!.evidence_id);
      manifest.reference_occurrences.push({
        occurrence_id: "reference:table-c-0-1",
        origin_evidence_id: manifest.evidence[0]!.evidence_id,
        origin_span_id: referenceSpanId,
        reference_literal_span_id: referenceSpanId,
        reference_literal: {
          evidence_id: manifest.evidence[0]!.evidence_id,
          start: anchorText.indexOf("表 C.0.1"),
          end: anchorText.indexOf("表 C.0.1") + "表 C.0.1".length,
        },
        origin_fields: ["method"],
        raw_reference: "表 C.0.1",
        relation: "8.2.1 单元构件组装允许偏差的检验方法及验收依据",
        target_evidence_ids: ["atom:referenced-table-row"],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["source:table:C.0.1"],
        reference_kind: "table",
        target_table_id: "C.0.1",
        target_address: {
          source_id: "source",
          locator_kind: "table",
          locator: "table:C.0.1",
        },
      });
      const selectors = initialTargetSelectorPlan(manifest);
      selectors.lots.push({
        key: "assembly-lot",
        name: "组装检验批",
        scope_span_ids: [anchorSpanId],
        reason: "8.2.1 组装范围",
      });
      selectors.items.push({
        key: "clause-8.2.1",
        lot_key: "assembly-lot",
        name: "单元构件组装允许偏差",
        category: "一般项目",
        criterion_span_ids: [rowSpanId],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [rowSpanId], separator: "", reason: "表内项目" },
          requirement: { composition: "verbatim", span_ids: [rowSpanId], separator: "", reason: "表内允许偏差" },
          method: { composition: "verbatim", span_ids: [anchorSpanId], separator: "", reason: "正文引用表 C.0.1" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "fixture 无抽样" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
        },
        table: {
          source_kind: "reference",
          table_key: "C.0.1",
          properties: {
            table_no_span_ids: [titleSpanId],
            table_title_span_ids: [titleSpanId],
            applicability_span_ids: [],
            row_path_span_ids: [[rowSpanId]],
            column_path_span_ids: [[titleSpanId]],
            unit_span_ids: [],
            condition_span_ids: [rowSpanId],
            allowed_value_span_ids: [rowSpanId],
            inspection_method_span_ids: [rowSpanId],
          },
          reference_span_ids: [referenceSpanId],
          reason: "正式题注只登记在 table_title，路由与 criterion 均不重复登记",
        },
        inspection_data_type: "measurement",
        inspection_data_type_reason: "表内允许偏差为量测值",
        inspection_data_type_span_ids: [rowSpanId],
        sampling: {
          status: "fallback",
          rule_key: "",
          branch_keys: [],
          quantity_span_ids: [],
          script_span_ids: [],
          condition_span_ids: [],
          reason: "fixture 不形成抽样",
          confidence: 1,
        },
        reason: "8.2.1 引用表验收项目",
      });
      selectors.references.push({
        key: "ref-8.2.1-table-c.0.1",
        anchor_span_ids: [referenceSpanId],
        target_span_ids: [rowSpanId],
        occurrence_id: "reference:table-c-0-1",
        action: "adopt",
        application_mode: "reference_only",
        import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement", "method"], reason: "引用表行提供项目名、要求和方法。" },
        destinations: [{ item_key: "clause-8.2.1", target_field: "method" }],
        reason: "引用路由只登记数据行；题注来源随编译结构携带",
      });

      const persisted = compileTargetSelectorsPersisted(selectors, registry, manifest);
      expect(validatePlanText(prettyJson(persisted), manifest))
        .toMatchObject({ ok: true, issues: [] });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker rejects scope extension for evidence already inside primary scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-primary-scope-blocker-"));
    try {
      const { manifest, registry } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", {
        kind: "scope_extension_required",
        evidence_span_ids: [registry.spans[0]!.span_id],
        affected_selector_paths: ["/items"],
        explanation: "模型简报遗漏了这段，但证据已经在当前 primary scope。",
      })).toMatchObject({
        ok: false,
        terminal: false,
        error: "scope_extension_not_required",
        issue_owner: "selector_input_error",
        primary_evidence_ids: [manifest.evidence[0]!.evidence_id],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker preserves a valid scope-extension root code under the terminal wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-scope-extension-blocker-"));
    try {
      const prepared = fixture();
      prepared.manifest.evidence[0]!.evidence_scope = "reference";
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        prepared.manifest.job_id,
        prepared.manifest.target_id,
        { manifest: prepared.manifest, markdown: Buffer.from(prepared.manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", {
        kind: "scope_extension_required",
        evidence_span_ids: [prepared.registry.spans[0]!.span_id],
        affected_selector_paths: ["/items"],
        explanation: "这段直接目标正文位于当前 primary scope 之外，需要扩展范围。",
      })).toMatchObject({
        ok: false,
        terminal: true,
        error: "target_blocked_with_evidence",
        blocker_code: "scope_extension_required",
        failure_class: "scope_extension",
        blocker: { kind: "scope_extension_required" },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker requires registered evidence spans and never satisfies coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-blocker-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source",
        evidence_span_ids: ["span:00000000000000000000000000000000"],
        affected_selector_paths: ["/items"],
        explanation: "存在两个不能由现有原文消除的候选。",
      })).toMatchObject({ ok: false, error: "blocker_evidence_invalid" });
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      expect(await controller.dispatch("report_target_blocker", {
        kind: "harness_contract_defect",
        evidence_span_ids: [registry.spans[0]!.span_id],
        affected_selector_paths: ["/items"],
        explanation: "The model cannot self-certify a harness defect without mechanical drift.",
      })).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "coverage_blocker_owner_unverified",
        issue_owner: "harness_contract",
        actionable: true,
      });
      const protocolBeforeTerminalBlocker = (await workspace.readState()).selector_protocol;
      expect(await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source",
        evidence_span_ids: [registry.spans[0]!.span_id],
        affected_selector_paths: ["/items"],
        explanation: "存在两个不能由现有原文消除的候选。",
      })).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "ambiguous_source_requires_selector_disambiguation",
        issue_owner: "selector_input_error",
        fresh_session_retry_eligible: true,
      });
      expect((await workspace.readState()).selector_protocol).toEqual(protocolBeforeTerminalBlocker);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("ambiguous source feedback exposes the empty authoring state and an executable read route without inventing criteria", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-empty-ambiguity-"));
    try {
      const { manifest, registry, selectors } = fixture("验收项目清单包括面层与连接。");
      selectors.items = [];
      const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
      const text = prettyJson(selectors);
      await workspace.writeWorkingSelectors(text);
      const controller = await ToolController.create(workspace);
      const before = await workspace.readState();
      const reply = await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source", evidence_span_ids: [registry.spans[0]!.span_id],
        affected_selector_paths: ["/items"], explanation: "已读文字列出项目，但不能据此确定完整判据。",
      });
      expect(reply).toMatchObject({
        ok: false, terminal: false, budget_consumed: false,
        error: "ambiguous_source_requires_selector_disambiguation", fresh_session_started: false,
        actual: { selector_stage: before.selector_stage, selector_counts: { items: 0 }, related_reference_occurrences: [] },
        writable_paths: ["/items"], writable_collections: ["items"],
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" }, save_tool: "stage_target_selector_draft",
        required_tools: expect.arrayContaining(["get_target_selector_contract", "open_evidence"]),
        how_to_pass: expect.stringContaining("若原文没有可执行依据，保留真实缺口"),
      });
      expect(await controller.dispatch(String(reply.next_tool), reply.next_tool_arguments as Record<string, unknown>))
        .toMatchObject({ ok: true, collection: "items", rows: [] });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(text);
      expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
      expect(reply).not.toHaveProperty("draft");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker routes resolved reference applicability to source facts and conditional selectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-resolved-blocker-"));
    try {
      const { manifest, registry, selectors } = fixture("构件可用甲或乙工法，验收应符合第4.2节。");
      const source = manifest.evidence[0]!;
      const originSpanId = registry.spans[0]!.span_id;
      const targetEvidenceId = "atom:conditional-method-rule";
      const targetText = "乙工法连接外观不得有裂纹。";
      manifest.evidence.push({
        ...source,
        evidence_id: targetEvidenceId,
        text: targetText,
        text_sha256: sha256Text(targetText),
        evidence_scope: "reference",
        requires_disposition: false,
        registered_dependency: true,
      });
      manifest.reference_occurrences.push({
        occurrence_id: "reference:conditional-method",
        origin_evidence_id: source.evidence_id,
        origin_span_id: originSpanId,
        reference_literal_span_id: originSpanId,
        origin_fields: ["requirement"],
        raw_reference: "第4.2节",
        target_evidence_ids: [targetEvidenceId],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["source:clause:4.2"],
        reference_kind: "clause",
        target_address: { source_id: "source", locator_kind: "clause", locator: "4.2" },
      });
      selectors.references = [{
        key: "conditional-method",
        occurrence_id: "reference:conditional-method",
        anchor_span_ids: [originSpanId],
        target_span_ids: [],
        action: "review",
        application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "按来源条件核对。" },
        destinations: [],
        reason: "保留原引用和适用条件，待建立真实接收关系。",
      }];
      const workspace = await RevisionWorkspace.createFromEvidence(
        root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      const reply = await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source",
        evidence_span_ids: [originSpanId],
        affected_selector_paths: ["/references/0/target_span_ids", "/references/0/destinations"],
        explanation: "已解析条款含来源条件，当前材料没有工程实例工法。",
      });
      expect(reply).toMatchObject({
        ok: false,
        terminal: false,
        error: "resolved_reference_requires_source_grounded_selector_decision",
        resolved_references: [{ reference_key: "conditional-method", occurrence_id: "reference:conditional-method" }],
        writable_paths: expect.arrayContaining(["/references/0/destinations", "/items"]),
        required_tools: expect.arrayContaining([
          "list_reference_occurrences", "read_target_selectors",
          "read_document_reference_evidence", "read_reference_facts", "stage_target_selector_draft",
        ]),
        next_tool: "list_reference_occurrences",
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("保留来源条件"),
      });
      expect(reply.required_tools).not.toContain("resolve_document_reference");
      expect(String(reply.how_to_pass).length).toBeLessThanOrEqual(420);
      expect(await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source",
        evidence_span_ids: [originSpanId],
        affected_selector_paths: ["/references/0/destinations", "/items/0/fields/requirement"],
        explanation: "引用路由和本地项目来源各有不同歧义。",
      })).toMatchObject({
        error: "ambiguous_source_requires_selector_disambiguation",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker routes a resolved occurrence without a selector receipt, but not an unresolved locator", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-missing-reference-blocker-"));
    const unresolvedRoot = await mkdtemp(join(tmpdir(), "target-selector-unresolved-reference-blocker-"));
    try {
      const { manifest, registry, selectors } = fixture("连接构件应符合第4.2节的规定。");
      const source = manifest.evidence[0]!;
      const originSpanId = registry.spans[0]!.span_id;
      const targetEvidenceId = "atom:neutral-connection-rule";
      const targetText = "乙工法连接外观不得有裂纹。";
      manifest.evidence.push({
        ...source,
        evidence_id: targetEvidenceId,
        text: targetText,
        text_sha256: sha256Text(targetText),
        evidence_scope: "reference",
        requires_disposition: false,
        registered_dependency: true,
      });
      manifest.reference_occurrences.push({
        occurrence_id: "reference:neutral-connection",
        origin_evidence_id: source.evidence_id,
        origin_span_id: originSpanId,
        reference_literal_span_id: originSpanId,
        origin_fields: ["requirement"],
        raw_reference: "第4.2节",
        target_evidence_ids: [targetEvidenceId],
        required: true,
        status: "resolved",
        depth: 1,
        path: ["source:section:4.2"],
        reference_kind: "clause",
        target_address: { source_id: "source", locator_kind: "section", locator: "4.2" },
      });
      expect(selectors.references).toHaveLength(0);
      const workspace = await RevisionWorkspace.createFromEvidence(
        root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      const input = {
        kind: "ambiguous_source",
        evidence_span_ids: [originSpanId],
        affected_selector_paths: ["/references/reference:neutral-connection", "/items"],
        explanation: "被引条款已经定位，仍须判断适用组件与真实接收项。",
      };
      const reply = await controller.dispatch("report_target_blocker", input);
      expect(reply).toMatchObject({
        ok: false,
        terminal: false,
        error: "resolved_reference_requires_source_grounded_selector_decision",
        resolved_references: [{ occurrence_id: "reference:neutral-connection" }],
        writable_paths: expect.arrayContaining(["/items", "/references"]),
        next_tool: "list_reference_occurrences",
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("新建 draft.references"),
      });
      expect(reply.required_tools).not.toContain("resolve_document_reference");
      expect(reply.writable_paths).not.toContain("/references/reference:neutral-connection");

      manifest.reference_occurrences[0]!.status = "ambiguous";
      const unresolvedWorkspace = await RevisionWorkspace.createFromEvidence(
        unresolvedRoot, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source.text) },
      );
      await unresolvedWorkspace.writeWorkingSelectors(prettyJson(selectors));
      const unresolvedController = await ToolController.create(unresolvedWorkspace);
      expect(await unresolvedController.dispatch("report_target_blocker", input)).toMatchObject({
        error: "ambiguous_source_requires_selector_disambiguation",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(unresolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("report_target_blocker rejects an affected ledger item from another evidence clause", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-selector-blocker-clause-owner-"));
    try {
      const { manifest, registry, selectors } = fixture();
      manifest.evidence[0]!.clause_id = "7.3.7";
      selectors.items[0]!.key = "ledger-clause:7.3.5";
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const controller = await ToolController.create(workspace);
      expect(await controller.dispatch("report_target_blocker", {
        kind: "ambiguous_source",
        evidence_span_ids: [registry.spans[0]!.span_id],
        affected_selector_paths: ["/items/0/fields/requirement"],
        explanation: "7.3.7 的证据不应误报给 7.3.5。",
      })).toMatchObject({
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "blocker_selector_path_clause_mismatch",
        issue_owner: "selector_input_error",
        evidence_clause_ids: ["7.3.7"],
        affected_selector_items: [expect.objectContaining({ item_key: "ledger-clause:7.3.5", clause_id: "7.3.5" })],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("table-origin gate", () => {
  test("exposes branch, split, and non-acceptance reclassification paths for ambiguous table arrays", () => {
    const text = "条件甲允许值为1；条件乙允许值为2。";
    const prepared = fixture(text);
    const registered = registerQuotes(prepared.manifest, [text, "条件甲", "条件乙", "允许值为1", "允许值为2"]);
    const ids = registered.ids;
    prepared.selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "table:conditions",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[ids.get("条件甲")!], [ids.get("条件乙")!]],
        column_path_span_ids: [], unit_span_ids: [],
        condition_span_ids: [ids.get("条件甲")!, ids.get("条件乙")!],
        allowed_value_span_ids: [ids.get("允许值为1")!, ids.get("允许值为2")!],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "保留两组条件和值的来源绑定",
    };
    try {
      compileTargetSelectorsPersisted(prepared.selectors, registered.registry, prepared.manifest);
      throw new Error("expected an explicit authoring-route issue for ambiguous table arrays");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_acceptance_branches_required") as any;
      expect(issue).toMatchObject({
        path: "/items/0/table/properties/acceptance_branches",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "choose_acceptance_branch_split_or_reclassify_non_acceptance_rows",
          actual: expect.objectContaining({ item_key: "surface", acceptance_branches: [] }),
          legal_paths: expect.arrayContaining([
            expect.objectContaining({ when: "same_core_property_with_mutually_exclusive_acceptance_conditions" }),
            expect.objectContaining({ when: "different_acceptance_properties_or_formulas" }),
            expect.objectContaining({ when: "selected_rows_are_sampling_method_or_non_item_context" }),
          ]),
          allowed_actions: expect.arrayContaining([
            expect.stringContaining("acceptance_branches"),
            expect.stringContaining("拆成多个真实 items"),
            expect.stringContaining("不是验收判据分支"),
          ]),
          writable_paths: expect.arrayContaining([
            "/items/0/table/properties/acceptance_branches",
            "/items/0/table",
            "/items/0/criterion_span_ids",
            "/items/0/continuation_span_ids",
            "/items/0/fields/method",
            "/items/0/sampling",
            "/sampling_rules",
            "/source_dispositions",
            "/items",
          ]),
          writable_collections: ["items", "sampling_rules", "source_dispositions"],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: [
            "read_target_selectors",
            "list_table_fragments",
            "read_table_summary",
            "read_table_rows",
            "list_sampling_rules",
            "open_evidence",
            "locate_evidence_span",
          ],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: prepared.selectors.items[0]!.key },
          next_tools: [
            "read_target_selectors",
            "list_table_fragments",
            "read_table_summary",
            "read_table_rows",
            "list_sampling_rules",
            "open_evidence",
            "locate_evidence_span",
            "stage_target_selector_draft",
          ],
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("由模型根据原文"),
        },
      });
      expect(issue.message).toContain("并非验收判据");
      expect(issue.details.how_to_pass).toContain("criterion_span_ids");
    }
  });

  test("keeps true-branch repair while exposing reclassification from completeness and visibility issues", () => {
    const text = "共同要求。条件甲对应数值一；条件乙对应数值二。";
    const prepared = fixture(text);
    const registered = registerQuotes(prepared.manifest, [
      text,
      "共同要求。",
      "条件甲",
      "数值一",
      "条件甲对应数值一",
      "条件乙",
      "数值二",
      "条件乙对应数值二",
    ]);
    const ids = registered.ids;
    const item = prepared.selectors.items[0]!;
    item.criterion_span_ids = [ids.get(text)!, ids.get("条件甲对应数值一")!, ids.get("条件乙对应数值二")!];
    item.fields.requirement.span_ids = [ids.get("共同要求。")!];
    item.table = {
      source_kind: "direct",
      table_key: "table:neutral-branches",
      properties: {
        table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
        row_path_span_ids: [[ids.get("条件甲对应数值一")!], [ids.get("条件乙对应数值二")!]],
        column_path_span_ids: [], unit_span_ids: [],
        condition_span_ids: [ids.get("条件甲")!, ids.get("条件乙")!],
        allowed_value_span_ids: [ids.get("数值一")!, ids.get("数值二")!],
        inspection_method_span_ids: [],
        acceptance_branches: [
          {
            key: "case-a",
            condition_span_ids: [ids.get("条件甲")!],
            requirement_span_ids: [ids.get("条件甲对应数值一")!],
            allowed_value_span_ids: [ids.get("数值一")!],
            reason: "中性分支甲。",
          },
          {
            key: "case-b",
            condition_span_ids: [ids.get("条件乙")!],
            requirement_span_ids: [ids.get("条件乙对应数值二")!],
            allowed_value_span_ids: [ids.get("数值二")!],
            reason: "中性分支乙。",
          },
        ],
      },
      reference_span_ids: [],
      reason: "中性表格分支结构。",
    };

    const collectIssues = (selectors: TargetSelectorPlan) => {
      try {
        compileTargetSelectorsPersisted(selectors, registered.registry, prepared.manifest);
        throw new Error("expected branch issue");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        return (error as TargetSelectorCompileError).issues;
      }
    };
    const assertAlternativeRoutes = (issue: any) => {
      expect(issue).toMatchObject({ details: {
        allowed_actions: expect.arrayContaining([
          expect.stringContaining("验收条件"),
          expect.stringContaining("拆成多个真实 items"),
          expect.stringContaining("不是验收判据分支"),
        ]),
        writable_paths: expect.arrayContaining([
          "/items/0/table",
          "/items/0/fields/method",
          "/items/0/sampling",
          "/sampling_rules",
          "/source_dispositions",
          "/items",
        ]),
        writable_collections: ["items", "sampling_rules", "source_dispositions"],
        item_key: prepared.selectors.items[0]!.key,
        table_key: prepared.selectors.items[0]!.table!.table_key,
        candidate_read_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "list_sampling_rules",
          "open_evidence",
          "locate_evidence_span",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: prepared.selectors.items[0]!.key },
        next_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "list_sampling_rules",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
        ],
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringMatching(/read_target_selectors.*read_table_summary.*read_table_rows.*save_tool/u),
      } });
    };

    const visibilityIssue = collectIssues(prepared.selectors)
      .find(issue => issue.code === "selector_acceptance_branch_requirement_not_visible") as any;
    expect(visibilityIssue).toMatchObject({
      path: "/items/0/fields/requirement/span_ids",
      details: {
        writable_path: "/items/0/fields/requirement/span_ids",
        required_action: "make_true_acceptance_branch_requirement_visible_or_reclassify_misclassified_content",
      },
    });
    assertAlternativeRoutes(visibilityIssue);

    const incomplete = structuredClone(prepared.selectors);
    incomplete.items[0]!.table!.properties.acceptance_branches![0]!.requirement_span_ids = [ids.get("条件甲")!];
    const incompleteIssue = collectIssues(incomplete)
      .find(issue => issue.code === "selector_acceptance_branch_requirement_incomplete") as any;
    expect(incompleteIssue).toMatchObject({
      path: "/items/0/table/properties/acceptance_branches/0/requirement_span_ids",
      details: {
        writable_path: "/items/0/table/properties/acceptance_branches/0/requirement_span_ids",
        required_action: "complete_true_acceptance_branch_requirement_or_reclassify_misclassified_content",
      },
    });
    assertAlternativeRoutes(incompleteIssue);

    const conditionMismatch = structuredClone(prepared.selectors);
    conditionMismatch.items[0]!.table!.properties.acceptance_branches![1]!.condition_span_ids = [ids.get("条件甲")!];
    const conditionIssue = collectIssues(conditionMismatch)
      .find(issue => issue.code === "selector_acceptance_branch_condition_coverage") as any;
    expect(conditionIssue).toMatchObject({
      path: "/items/0/table/properties/acceptance_branches",
      details: {
        item_key: item.key,
        missing_from_branches: [ids.get("条件乙")!],
        required_action: "make_branch_condition_span_union_equal_table_condition_span_ids_or_split_independent_rows_into_items",
        writable_paths: expect.arrayContaining([
          "/items/0/table/properties/acceptance_branches",
          "/items/0/table/properties/condition_span_ids",
        ]),
      },
    });
    assertAlternativeRoutes(conditionIssue);
    const duplicateConditionIssue = collectIssues(conditionMismatch)
      .find(issue => issue.code === "selector_acceptance_branch_condition_duplicate") as any;
    expect(duplicateConditionIssue).toMatchObject({
      path: "/items/0/table/properties/acceptance_branches",
      details: {
        item_key: item.key,
        required_action: "add_the_missing_distinguishing_row_path_condition_or_split_independent_table_rows_into_separate_items",
      },
    });
    assertAlternativeRoutes(duplicateConditionIssue);

    const allowedValueMismatch = structuredClone(prepared.selectors);
    allowedValueMismatch.items[0]!.table!.properties.acceptance_branches![1]!.allowed_value_span_ids = [ids.get("数值一")!];
    const allowedValueIssue = collectIssues(allowedValueMismatch)
      .find(issue => issue.code === "selector_acceptance_branch_allowed_value_coverage") as any;
    expect(allowedValueIssue).toMatchObject({
      path: "/items/0/table/properties/acceptance_branches",
      details: {
        item_key: item.key,
        missing_from_branches: [ids.get("数值二")!],
        required_action: "make_branch_allowed_value_span_union_equal_table_allowed_value_span_ids_or_split_independent_rows_into_items",
        writable_paths: expect.arrayContaining([
          "/items/0/table/properties/acceptance_branches",
          "/items/0/table/properties/allowed_value_span_ids",
        ]),
      },
    });
    assertAlternativeRoutes(allowedValueIssue);

    const duplicateKey = structuredClone(prepared.selectors);
    duplicateKey.items[0]!.table!.properties.acceptance_branches![1]!.key = "case-a";
    const duplicateKeyIssue = collectIssues(duplicateKey)
      .find(issue => issue.code === "selector_acceptance_branch_duplicate") as any;
    expect(duplicateKeyIssue).toMatchObject({
      path: "/items/0/table/properties/acceptance_branches",
      details: {
        item_key: item.key,
        actual: { item_key: item.key, duplicate_branch_keys: ["case-a"] },
        required_action: "make_true_acceptance_branch_keys_unique_or_choose_another_lossless_authoring_path",
      },
    });
    assertAlternativeRoutes(duplicateKeyIssue);

    const noteMisuse = structuredClone(prepared.selectors);
    noteMisuse.items[0]!.fields.note = {
      composition: "verbatim",
      span_ids: [ids.get("条件甲")!],
      separator: "",
      reason: "构造反馈契约测试，不预设业务答案。",
    };
    const noteIssue = collectIssues(noteMisuse)
      .find(issue => issue.code === "selector_acceptance_branch_note_misuse") as any;
    expect(noteIssue).toMatchObject({
      path: "/items/0/fields/note/span_ids",
      details: {
        item_key: item.key,
        actual: { item_key: item.key, branch_key: "case-a" },
        required_action: "remove_duplicate_note_role_or_reclassify_content_without_discarding_source_facts",
      },
    });
    assertAlternativeRoutes(noteIssue);
  });

  test("requires a typed table block when criterion spans land on formal table data rows", () => {
    const rowText = "表 5.6.4 泥浆护壁成孔灌注桩质量检验标准 | 数据行 4 | 检查项目=孔深 | 允许值或允许偏差 | ±50 | 检查方法：用钢尺量";
    const prepared = fixture(rowText);
    const record = prepared.manifest.evidence[0]!;
    record.kind = "table_row";
    record.role = "formal_table_row";
    record.table_row_kind = "data";
    record.table_id = "表 5.6.4";
    record.table_title = "表 5.6.4 泥浆护壁成孔灌注桩质量检验标准";

    try {
      compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
      throw new Error("Expected a table-origin item without a typed table block to fail compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_table_block_required_for_table_origin_items") as any;
      expect(issue).toMatchObject({
        code: "selector_table_block_required_for_table_origin_items",
        path: "/items/0/table",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "author_typed_table_block_or_reclassify_non_criterion_sources",
          candidate_read_tools: [
            "read_target_selectors",
            "list_table_fragments",
            "read_table_summary",
            "read_table_rows",
            "open_evidence",
            "locate_evidence_span",
          ],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: "surface" },
          next_tools: [
            "read_target_selectors",
            "list_table_fragments",
            "read_table_summary",
            "read_table_rows",
            "open_evidence",
            "locate_evidence_span",
            "stage_target_selector_draft",
          ],
          writable_path: "/items/0/table",
          writable_paths: expect.arrayContaining(["/items/0/table", "/items/0/criterion_span_ids", "/items/0/continuation_span_ids"]),
          writable_collections: ["items", "sampling_rules", "source_dispositions"],
          tool_argument_hints: expect.objectContaining({
            list_table_fragments: { cursor: 0, limit: 100 },
            read_table_summary: { table_key: expect.any(String) },
            read_table_rows: { table_key: expect.any(String), cursor: 0, limit: 50 },
            open_evidence: { evidence_id: expect.any(String), cursor: 0 },
            locate_evidence_span: expect.objectContaining({ evidence_id: expect.any(String) }),
          }),
          how_to_pass: expect.stringContaining("item.table"),
          do_not_edit: expect.stringContaining("不可变原文"),
        },
      });
      expect(issue.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect(issue.details.save_tool).toBe("stage_target_selector_draft");
      expect(issue.details.save_tool_instruction).toContain("draft.items");
    }

    const fullSpan = prepared.registry.spans.find((span) =>
      span.evidence_id === record.evidence_id && span.start === 0 && span.end === record.text.length
    );
    expect(fullSpan).toBeDefined();
    prepared.selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "表 5.6.4",
      properties: {
        table_no_span_ids: [],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[fullSpan!.span_id]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [fullSpan!.span_id],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "该项目的允许值来自本节质量检验标准表",
    };
    try {
      compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    } catch (error) {
      const issues = error instanceof TargetSelectorCompileError ? error.issues : [];
      expect(issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_table_block_required_for_table_origin_items" }),
      ]));
    }
  });

  test.each(["criterion_span_ids", "continuation_span_ids"] as const)("exposes the triggering %s binding and preserves a reclassified method row", (role) => {
    const prepared = fixture();
    const rowText = "<tr><td>检查工具</td><td>塞尺</td></tr>";
    const row = {
      ...prepared.manifest.evidence[0]!, evidence_id: "atom:method-row", text: rowText,
      text_sha256: sha256Text(rowText), locator: `char:0-${rowText.length}`,
      kind: "table_row" as const, role: "formal_table_row" as const,
      table_row_kind: "data" as const, table_id: "table:method", requires_disposition: false,
    };
    prepared.manifest.evidence.push(row);
    prepared.registry = registryWithFullSourceSpans(prepared.manifest.evidence_fingerprint,
      prepared.manifest.evidence.map(record => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text })));
    const rowSpan = prepared.registry.spans.find(span => span.evidence_id === row.evidence_id)!;
    const item = prepared.selectors.items[0]!;
    item[role].push(rowSpan.span_id);
    let gate: any;
    try {
      compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      gate = (error as TargetSelectorCompileError).issues.find(issue => issue.code === "selector_table_block_required_for_table_origin_items");
    }
    expect(gate).toBeDefined();
    expect(gate.details.actual).toMatchObject({
      item_key: item.key, table: null,
      triggering_source_bindings: [expect.objectContaining({
        path: `/items/0/${role}/${item[role].length - 1}`, span_id: rowSpan.span_id,
        evidence_id: row.evidence_id, text: rowText,
      })],
    });
    expect(gate.details.writable_paths).toContain(`/items/0/${role}`);
    expect(gate.details.how_to_pass).toContain("criterion_span_ids");
    expect(gate.details.how_to_pass).toContain("continuation_span_ids");
    expect(gate.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");

    // The author, not the harness, classifies the row as a method and keeps its source.
    item[role] = item[role].filter(id => id !== rowSpan.span_id);
    item.fields.method = { composition: "verbatim", span_ids: [rowSpan.span_id], separator: "", reason: "该行只说明检验工具，保留为方法来源。" };
    expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, { operation: "upsert", draft: { items: [item] } })).toBe(true);
    const compiled = compileTargetSelectorsPersisted(prepared.selectors, prepared.registry, prepared.manifest);
    expect(JSON.stringify(compiled)).toContain(rowSpan.span_id);
    expect(item.table).toBeNull();
  });
});

describe("target selector draft readback", () => {
  test("collection without a key returns a key/name/filled roster, not full records", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-index-read-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      const controller = await ToolController.create(workspace);

      const roster = await controller.dispatch("read_target_selectors", {
        collection: "items",
        limit: 100,
      });
      expect(roster).toMatchObject({
        ok: true,
        collection: "items",
        view: "index",
        next_cursor: null,
      });
      expect(roster.rows).toEqual([
        expect.objectContaining({
          key: "surface",
          name: "基层表面质量",
          lot_key: "base",
          filled: expect.objectContaining({
            name: true,
            requirement: true,
            method: false,
            quantity: false,
            table: false,
          }),
        }),
      ]);
      expect(roster.rows[0]).not.toHaveProperty("criterion_span_ids");
      expect(roster.rows[0]).not.toHaveProperty("fields");
      expect(roster.rows[0]).not.toHaveProperty("sampling");
      expect(roster.rows[0]).not.toHaveProperty("reason");
      expect(String(roster.instruction)).toMatch(/key=/u);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("keyed read still returns the full persisted record", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-key-read-"));
    try {
      const { manifest, registry, selectors } = fixture();
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      const controller = await ToolController.create(workspace);

      const detail = await controller.dispatch("read_target_selectors", {
        collection: "items",
        key: "surface",
      });
      expect(detail).toMatchObject({
        ok: true,
        collection: "items",
        view: "record",
        rows: [expect.objectContaining({
          key: "surface",
          name: "基层表面质量",
          reason: "可以独立检查并判定",
        })],
      });
      expect(detail.rows[0]).toHaveProperty("criterion_span_ids");
      expect(detail.rows[0]).toHaveProperty("fields");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});


test("inline quote binding saves several collections in one checkpoint and never persists aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-inline-"));
  try {
    const { manifest, selectors } = fixture();
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    const controller = await ToolController.create(workspace);
    const evidence_id = manifest.evidence[0]!.evidence_id;
    await controller.dispatch("open_evidence", { evidence_id });
    const before = (await workspace.readState()).next_history_sequence;
    const staged = await controller.dispatch("stage_target_selector_draft", {
      quote_bindings: [{ key: "$requirement", evidence_id, quote: "基层表面应平整、密实。" }],
      draft: { lots: selectors.lots, items: [{ ...selectors.items[0],
        fields: { ...selectors.items[0]!.fields, requirement: {
          ...selectors.items[0]!.fields.requirement, span_ids: ["$requirement"], reason: "$requirement is literal prose here",
        } },
      }] },
    });
    expect(staged).toMatchObject({ ok: true, collections: ["lots", "items"], content_validation_performed: true });
    expect((await workspace.readState()).next_history_sequence).toBe(before + 1);
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    const field = saved.items[0].fields.requirement;
    expect(field.span_ids[0]).toMatch(/^span:[a-f0-9]{32}$/);
    expect(field.reason).toBe("$requirement is literal prose here");
    const located = await controller.dispatch("locate_evidence_span", { evidence_id, quote: "基层表面应平整、密实。" });
    expect(field.span_ids).toEqual([(located.span as any).span_id]);
    expect(controller.selectorProviderPolicy()).toMatchObject({ stage: "primary", allowed_tools: expect.arrayContaining(["commit_target_selector_draft"]) });
    expect((await workspace.readState()).last_valid_fingerprint).toBeFalsy();
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("quote aliases resembling system handles are rejected atomically and descriptive aliases can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-alias-names-"));
  try {
    const { manifest, selectors } = fixture();
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    const controller = await ToolController.create(workspace);
    const evidence_id = manifest.evidence[0]!.evidence_id;
    await controller.dispatch("open_evidence", { evidence_id });
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = (await workspace.readState()).next_history_sequence;
    const patchFor = (key: string) => ({
      quote_bindings: [
        { key: "$valid", evidence_id, quote: "基层表面应平整、密实。" },
        { key, evidence_id, quote: "基层表面应平整、密实。" },
      ],
      draft: { lots: [{ ...selectors.lots[0], scope_span_ids: [key] }] },
    });
    for (const key of ["$s9", "$e1", "$a12", "$S9", "$E1", "$A12", "$s009", "$r1", "$t2", "$R1", "$T2"]) {
      expect(await controller.dispatch("stage_target_selector_draft", patchFor(key))).toMatchObject({
        ok: false, error: "quote_binding_reserved_source_handle_alias", durable_mutation: false,
        selector_issues: [{
          path: "/quote_bindings/1/key", actual: key,
          how_to_pass: expect.stringContaining("同时重命名此 key"),
          next_tool: "stage_target_selector_draft",
        }],
      });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect((await workspace.readState()).next_history_sequence).toBe(historyBefore);
    }
    expect(await controller.dispatch("stage_target_selector_draft", patchFor("$surface_requirement")))
      .toMatchObject({ ok: true });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.lots[0].scope_span_ids[0]).toMatch(/^span:[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous quotes and invalid later collections reject the entire staging batch without registry or draft writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-inline-reject-"));
  try {
    const { manifest, selectors } = fixture("甲：检查报告。乙：检查报告。基层应平整。");
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    const controller = await ToolController.create(workspace);
    const evidence_id = manifest.evidence[0]!.evidence_id;
    await controller.dispatch("open_evidence", { evidence_id });
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const historyBefore = (await workspace.readState()).next_history_sequence;
    for (const patch of [
      { quote_bindings: [{key:"$valid",evidence_id,quote:"基层应平整。"},{key:"$ambiguous",evidence_id,quote:"检查报告。"}], draft: {lots:selectors.lots} },
      { quote_bindings: [{key:"$valid",evidence_id,quote:"基层应平整。"}], draft: {lots:selectors.lots,items:[{key:"broken"}]} },
      { draft: {lots:selectors.lots,items:[{...selectors.items[0],criterion_span_ids:["$undefined"]}]} },
      { quote_bindings: [{key:"$dup",evidence_id,quote:"基层应平整。"},{key:"$dup",evidence_id,quote:"基层应平整。"}],draft:{lots:selectors.lots} },
      { quote_bindings: [{key:"$valid",evidence_id,quote:"基层应平整。"}], draft:{lots:selectors.lots,items:[{...selectors.items[0],criterion_span_ids:["span:"+"f".repeat(32)]}]} },
    ]) {
      expect(await controller.dispatch("stage_target_selector_draft",patch)).toMatchObject({ok:false,budget_consumed:false});
      expect(await readFile(workspace.workingSelectorPath,"utf8")).toBe(before);
      expect(await readFile(workspace.sourceSpanRegistryPath,"utf8")).toBe(registryBefore);
      expect((await workspace.readState()).next_history_sequence).toBe(historyBefore);
    }
    expect(await controller.dispatch("stage_target_selector_draft", {
      quote_bindings:[{key:"$method",evidence_id,quote:"检查报告。",prefix:"乙："}],
      draft:{lots:[{...selectors.lots[0],scope_span_ids:["$method"]}]},
    })).toMatchObject({ok:true});
  } finally { await rm(root,{recursive:true,force:true}); }
});


test.each(["primary", "sampling", "table"])("direct commit from %s opens sealing while retaining independent review", async stage => {
  const root = await mkdtemp(join(tmpdir(), "selector-direct-commit-"));
  try {
    const {manifest,selectors}=fixture();
    const workspace=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
    await workspace.updateState(state => { state.selector_stage = stage as any; });
    const controller=await ToolController.create(workspace);
    await controller.dispatch("open_evidence", {evidence_id:manifest.evidence[0]!.evidence_id});
    const saved=await controller.dispatch("stage_target_selector_draft",{draft:{lots:selectors.lots,items:selectors.items}});
    const committed=await controller.dispatch("commit_target_selector_draft",{draft_fingerprint:saved.draft_fingerprint});
    expect(committed, JSON.stringify(committed)).toMatchObject({ok:true});
    expect(controller.selectorProviderPolicy()).toMatchObject({stage:"commit",allowed_tools:expect.arrayContaining(["seal_validated_plan"])});
    expect((await workspace.readState()).selector_stage).toBe("commit");
    expect(await controller.dispatch("seal_validated_plan",{fingerprint:(await workspace.readState()).last_valid_fingerprint})).toMatchObject({ok:false,error:"domain_coverage_review_required"});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("full selector preflight reports an unlabeled item to the model without invalidating structural validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-source-clause-gate-"));
  try {
    const { manifest, selectors } = fixture();
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
    );
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson({
      schema_version: "document-ledger/v1",
      source_sha256: manifest.source.sha256,
      file_name: manifest.source.file_name,
      clauses: [{
        clause_id: "4.2.1",
        line: 1,
        end_exclusive_line: 3,
        text: "4.2.1 基层表面应平整、密实。",
        kind: "item_candidate",
        has_quantity: true,
        has_method: true,
      }],
      headings: [],
      windows: [],
      record_tables: [],
      tables: [],
      anomalies: [],
    }), "utf8");
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    await controller.dispatch("stage_target_selector_draft", {
      draft: { lots: selectors.lots, items: selectors.items },
    });

    const compiled = await controller.dispatch("compile_target_selectors", {});
    expect(compiled).toMatchObject({
      ok: true,
      model_review: { blocking: false, decision_owner: "model" },
    });
    const sourceClauseIssue = (compiled as any).model_review.observations.find((issue: any) =>
      issue.code === "selector_source_clause_unresolved"
    );
    expect(sourceClauseIssue).toMatchObject({
      code: "selector_source_clause_unresolved",
      path: "/items/0/criterion_span_ids",
      message: expect.stringMatching(/[\u3400-\u9fff]/),
      actual: {
        item_id: expect.any(String),
        item_name: selectors.items[0]!.name,
        source_clause: "",
        derived_source_clause: "",
        candidate_clause_ids: [],
        candidate_evidence_ids: expect.arrayContaining([manifest.evidence[0]!.evidence_id]),
        current_bindings: expect.objectContaining({
          criterion_span_ids: selectors.items[0]!.criterion_span_ids,
          continuation_span_ids: selectors.items[0]!.continuation_span_ids,
          field_span_ids: expect.objectContaining({
            requirement: selectors.items[0]!.fields.requirement.span_ids,
          }),
        }),
        ledger_clause_candidates_by_binding: expect.objectContaining({
          fields: expect.objectContaining({ requirement: [] }),
        }),
        ledger_clause_candidate_note: expect.stringContaining("不表示 materializer 已采用"),
      },
      writable_path: "/items/0/criterion_span_ids",
      writable_paths: expect.arrayContaining([
        "/items/0/criterion_span_ids",
        "/items/0/continuation_span_ids",
        "/items/0/fields/name/span_ids",
        "/items/0/fields/requirement/span_ids",
        "/items/0/fields/method/span_ids",
        "/items/0/fields/quantity/span_ids",
        "/items/0/fields/note/span_ids",
      ]),
      next_tool: "read_target_selectors",
      how_to_pass: expect.stringContaining("父条款"),
      candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
      save_tool: "stage_target_selector_draft",
      details: expect.objectContaining({
        candidate_clause_ids: [],
        required_action: expect.stringContaining("derivation_priority"),
        candidate_read_tool: "read_target_selectors",
        do_not: expect.stringContaining("source_clause directly"),
        derivation_priority: expect.arrayContaining([
          expect.objectContaining({
            source: "field_binding_fallback",
            available_when: expect.stringContaining("按文字长度降序"),
          }),
        ]),
      }),
    });
    expect(sourceClauseIssue.how_to_pass).toContain("ledger_clause_candidates_by_binding");
    expect(sourceClauseIssue.how_to_pass).not.toContain(sourceClauseIssue.details.required_action);
    expect(sourceClauseIssue.candidate_read_tools).not.toContain("read_reference_facts");
    expect(controller.selectorProviderPolicy().allowed_tools).toEqual(expect.arrayContaining([
      ...sourceClauseIssue.candidate_read_tools,
      sourceClauseIssue.save_tool,
    ]));
    expect((await workspace.readState()).last_valid_fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const persistedPlan = compileTargetSelectorsPersisted(
      selectors,
      await workspace.readSourceSpanRegistry(),
      manifest,
    );
    const persistedContent = prettyJson(persistedPlan);
    await writeFile(workspace.workingPlanPath, persistedContent, "utf8");
    const legacyValidation = validatePlanText(persistedContent, manifest);
    expect(legacyValidation.ok, JSON.stringify(legacyValidation.issues)).toBe(true);
    expect(legacyValidation).toMatchObject({ fingerprint: expect.any(String), plan_sha256: expect.any(String) });
    await workspace.updateState((state) => {
      state.last_valid_fingerprint = legacyValidation.fingerprint!;
      state.last_valid_plan_sha256 = legacyValidation.plan_sha256!;
    });
    expect(await controller.dispatch("seal_validated_plan", {
      fingerprint: legacyValidation.fingerprint,
    })).toMatchObject({
      ok: false,
      error: "selector_source_clause_unresolved",
      next_tool: "read_target_selectors",
      how_to_pass: expect.stringMatching(/[\u3400-\u9fff]/),
      selector_issues: [expect.objectContaining({
        code: "selector_source_clause_unresolved",
        actual: expect.objectContaining({ derived_source_clause: "" }),
        next_tool: "read_target_selectors",
        how_to_pass: expect.stringContaining("父条款"),
      })],
      budget_consumed: false,
    });
    expect(existsSync(workspace.manifestPath)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "检查数量：在同一检验批内抽查总数的5%，且不应少于5处。",
  "检查数量：在同一检验批内抽查总数的3%，且不应少于5束。",
  "检查数量：全数检查。",
])("same-clause sampling feedback has two executable repair routes without losing the method: %s", async (quantity) => {
  const root = await mkdtemp(join(tmpdir(), "selector-sampling-repair-route-"));
  try {
    const requirement = "9.2.1 基层表面应平整、密实。";
    const method = "检验方法：观察，尺量。";
    const { manifest, selectors } = fixture(requirement);
    const base = manifest.evidence[0]!;
    manifest.evidence = [requirement, quantity, method].map((text, index) => ({
      ...base, evidence_id: `atom:repair-${index}`, locator: `line:${index + 1}`,
      text, text_sha256: sha256Text(text),
    }));
    manifest.scope.selected_atom_ids = manifest.evidence.map(record => record.evidence_id);
    manifest.scope.target_evidence_fragments = manifest.evidence.map(record => ({ atom_id: record.evidence_id, text: record.text }));
    manifest.evidence_fingerprint = sha256Text(manifest.evidence.map(record => record.text).join("\n"));
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const spans = manifest.evidence.map(record => registry.spans.find(span => span.evidence_id === record.evidence_id)!.span_id);
    selectors.lots[0]!.scope_span_ids = [spans[0]!];
    const item = selectors.items[0]!;
    item.criterion_span_ids = [spans[0]!];
    item.fields.name.span_ids = [spans[0]!];
    item.fields.requirement.span_ids = [spans[0]!];
    item.fields.method = { composition: "verbatim", span_ids: [spans[2]!], separator: "", reason: "原文明示方法" };
    item.fields.quantity = { composition: "verbatim", span_ids: [spans[1]!], separator: "", reason: "原文明示数量" };
    item.inspection_data_type_span_ids = [spans[2]!];
    item.sampling = { status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [spans[1]!],
      script_span_ids: [spans[2]!], condition_span_ids: [], reason: "重放数量和方法来自同条款不同记录的输入", confidence: 1 };
    const originalFields = structuredClone(item.fields);
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence.map(record => record.text).join("\n")) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson({
      schema_version: "document-ledger/v1", source_sha256: manifest.source.sha256, file_name: manifest.source.file_name,
      clauses: [{ clause_id: "9.2.1", line: 1, end_exclusive_line: 4, text: requirement, kind: "item_candidate",
        has_quantity: true, has_method: true, quantity_line: 2, method_line: 3 }],
      headings: [], windows: [], record_tables: [], tables: [], anomalies: [],
    }), "utf8");
    const controller = await ToolController.create(workspace);
    const rejected = await controller.dispatch("stage_target_selector_draft", { draft: { lots: selectors.lots, items: selectors.items } });
    expect(rejected).toMatchObject({ ok: true, draft_status: "saved_local_validation_failed" });
    const issues = (rejected.local_validation as any).issues;
    const roleIssue = (rejected.model_review as any).observations.find((issue: any) => issue.code === "selector_field_clause_line_mismatch");
    expect(rejected.model_review).toMatchObject({ blocking: false, decision_owner: "model" });
    expect(roleIssue).toMatchObject({ writable_path: "/draft/items/0/sampling/script_span_ids/0", details: {
      actual_clause_id: "9.2.1", owner_clause_id: "9.2.1", expected_role: "sampling_quantity",
      preserve_fields: expect.arrayContaining(["fields.method", "fields.requirement", "fields.quantity"]),
    } });
    expect(roleIssue.message).not.toContain("another clause");
    const crossIssue = issues.find((issue: any) => issue.code === "selector_explicit_sampling_cross_evidence");
    expect(crossIssue).toMatchObject({
      writable_paths: ["/items/0/sampling", "/sampling_rules"], next_tool: "stage_target_selector_draft", details: {
      repair_options: expect.any(Array),
    } });
    // Follow the returned replacement candidate, not a hard-coded hidden answer.
    item.sampling.script_span_ids = [roleIssue.details.expected_candidates[0].span_ids[0]];
    const repaired = await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
    expect(repaired).toMatchObject({ ok: true, draft_status: "saved_local_validation_passed" });
    let saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.items[0].fields).toEqual(originalFields);
    let plan = compileTargetSelectors(saved, registry, manifest);
    expect(validatePlanText(prettyJson(plan), manifest)).toMatchObject({ ok: true });
    expect(plan.acceptance_items[0]!.method).toBe(method);
    expect(plan.acceptance_items[0]!.sampling.script).toBe(quantity === "检查数量：全数检查。" ? "全"
      : quantity.includes("5%") ? "抽查5%，且不少于5处" : "");
    // The alternative route retains a genuine cross-evidence quantity + method rule.
    selectors.sampling_rules = [{ key: "shared-check", complete_span_ids: [spans[1]!, spans[2]!],
      components: sharedSamplingDispositions(), branches: [{ key: "only", applies_to_category: "一般项目",
        components: branchSamplingComponents("only", [spans[1]!], [spans[2]!], []), reason: "同一条件下的数量和方法" }], reason: "跨证据组合" }];
    item.sampling = { ...item.sampling, status: "reference", rule_key: "shared-check", branch_keys: ["only"],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [] };
    expect(await controller.dispatch("stage_target_selector_draft", { draft: { items: [item], sampling_rules: selectors.sampling_rules } }))
      .toMatchObject({ ok: true, draft_status: "saved_local_validation_passed" });
    saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.items[0].fields).toEqual(originalFields);
    plan = compileTargetSelectors(saved, registry, manifest);
    expect(validatePlanText(prettyJson(plan), manifest)).toMatchObject({ ok: true });
    expect(plan.acceptance_items[0]!.sampling.script).toBe("");
    expect(plan.acceptance_items[0]!.method).toBe(method);
    expect(plan.acceptance_items[0]!.sampling.min_sampling).toBe(quantity);
    for (const evidence of manifest.evidence) {
      expect(await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id })).toMatchObject({ ok: true });
    }
    const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: targetSelectorFingerprint(saved) });
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    expect((await workspace.readState()).status).not.toBe("sealed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["context", "section_heading"] as const)("field-role preflight uses semantic role %s rather than Markdown typography", async (role) => {
  const root = await mkdtemp(join(tmpdir(), "heading-field-role-"));
  try {
    const source = "## 壳体应密闭。验证操作：观察表面。取样范围：逐件检查。";
    const { manifest, selectors } = fixture(source);
    manifest.evidence[0]!.kind = "heading";
    manifest.evidence[0]!.role = role;
    const { registry, ids } = registerQuotes(manifest, [source, "壳体应密闭。", "观察表面。", "逐件检查。"]);
    const item = selectors.items[0]!;
    item.name = "壳体密闭性";
    item.criterion_span_ids = [ids.get("壳体应密闭。")!];
    item.fields.requirement.span_ids = item.criterion_span_ids;
    item.fields.method = { composition: "verbatim", span_ids: [ids.get("观察表面。")!], separator: "", reason: "原文给出的验证操作" };
    item.fields.quantity = { composition: "verbatim", span_ids: [ids.get("逐件检查。")!], separator: "", reason: "原文给出的检查范围" };
    item.sampling = { ...item.sampling, status: "explicit", quantity_span_ids: item.fields.quantity.span_ids,
      script_span_ids: item.fields.quantity.span_ids, reason: "原文明确逐件检查" };
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: selectors.items } });
    const issues = (staged.model_review as { observations?: Array<{ code: string }> } | undefined)?.observations ?? [];
    expect(staged).toMatchObject({ ok: true });
    if (role === "section_heading") expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_field_heading_evidence_forbidden" }),
    ]));
    else {
      expect(issues, JSON.stringify(staged)).toEqual([]);
      expect(staged).toMatchObject({ delivery_investigation: { advisory_only: true,
        hints: expect.arrayContaining([expect.objectContaining({ code: "heading_source_role_unconfirmed", item_keys: [item.key] })]),
      } });
      const compiled = await controller.dispatch("compile_target_selectors", {});
      expect(compiled, JSON.stringify(compiled)).toMatchObject({ ok: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging a child nominates an enclosing requirement for semantic comparison without deleting either item", async () => {
  const root = await mkdtemp(join(tmpdir(), "parent-child-review-"));
  try {
    const source = "壳体应密闭。接头应锁紧。";
    const { manifest, selectors } = fixture(source);
    const { registry, ids } = registerQuotes(manifest, [source, "接头应锁紧。"]);
    const parent = selectors.items[0]!;
    parent.name = "壳体及接头质量";
    const child = structuredClone(parent);
    child.key = "joint";
    child.name = "接头锁紧";
    child.criterion_span_ids = [ids.get("接头应锁紧。")!];
    child.fields.requirement.span_ids = child.criterion_span_ids;
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [child] } });
    expect(staged).toMatchObject({ ok: true, delivery_investigation: {
      advisory_only: true,
      hints: expect.arrayContaining([expect.objectContaining({
        code: "sibling_requirement_contains", item_keys: [parent.key, child.key], next_tool: "read_target_selectors",
      })]),
    } });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.items).toEqual([parent, child]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging a fragmented child reports exact source containment without rewriting or validating the whole candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "fragmented-parent-child-review-"));
  try {
    const source = "壳体应密闭。接头应锁紧。偏差超限时应修整。";
    const { manifest, selectors } = fixture(source);
    const fragments = ["接头应锁紧", "偏差超限时应修整"];
    const { registry, ids } = registerQuotes(manifest, [source, ...fragments]);
    const parent = selectors.items[0]!;
    parent.name = "壳体及接头质量";
    const child = structuredClone(parent);
    child.key = "joint";
    child.name = "接头锁紧及超限修整";
    child.criterion_span_ids = fragments.map(text => ids.get(text)!);
    child.fields.requirement.span_ids = child.criterion_span_ids;
    child.fields.requirement.separator = "\n";
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const stateBefore = await workspace.readState();
    const sourcesBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [child] } });
    expect(staged).toMatchObject({ ok: true, full_stage_check_performed: false, budget_consumed: false,
      delivery_investigation: { advisory_only: true, hints: expect.arrayContaining([expect.objectContaining({
        code: "sibling_requirement_contains", item_keys: [parent.key, child.key], next_tool: "read_target_selectors",
        actual: { comparison_basis: "strict_requirement_source_containment", containing_item_key: parent.key,
          contained_item_count: 1, contained_items_complete: true },
        source_read_tools: [{ name: "open_evidence", arguments: { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 } }],
      })]) } });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual([parent, child]);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(sourcesBefore);
    expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([true, false])("split prose receipts expose source allocation with shared text already carried=%s", async alreadyCarried => {
  const root = await mkdtemp(join(tmpdir(), "split-prose-condition-"));
  try {
    const condition = "工况甲下，";
    const first = "组件应完整，";
    const second = "连接处应连续。";
    const source = condition + first + second;
    const { manifest, selectors } = fixture(source);
    const { registry, ids } = registerQuotes(manifest, [source, condition + first, condition, first, second]);
    const parent = selectors.items[0]!;
    parent.name = "组件完整性";
    parent.criterion_span_ids = [ids.get(alreadyCarried ? condition + first : first)!];
    parent.fields.requirement.span_ids = parent.criterion_span_ids;
    const child = structuredClone(parent);
    child.key = "connection";
    child.name = "连接连续性";
    child.criterion_span_ids = [ids.get(second)!];
    child.fields.requirement.span_ids = child.criterion_span_ids;
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [child] } });
    expect(staged).toMatchObject({ ok: true, draft_status: "saved_local_validation_passed", budget_consumed: false,
      delivery_investigation: { advisory_only: true, hints: expect.arrayContaining([expect.objectContaining({
        code: "prose_source_split", item_keys: [parent.key, child.key], evidence_ids: [manifest.evidence[0]!.evidence_id],
        actual: { source_text_length: source.length, unassigned_requirement_interval_count: alreadyCarried ? 0 : 1,
          unassigned_requirement_intervals: alreadyCarried ? [] : [{ evidence_id: manifest.evidence[0]!.evidence_id, start: 0, end: condition.length }],
          intervals_complete: true },
        source_read_tools: [{ name: "open_evidence", arguments: { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 } }],
        save_tool: "stage_target_selector_draft",
        next_tool: "read_target_selectors", read_arguments: [
          { collection: "items", key: parent.key }, { collection: "items", key: child.key },
        ], instruction: expect.stringContaining("兄弟项已保留条件不代表当前项"),
      })]) },
    });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual([parent, child]);
    expect(JSON.parse(await readFile(workspace.sourceSpanRegistryPath, "utf8"))).toEqual(registry);
    child.fields.requirement.span_ids = [ids.get(condition)!, ids.get(second)!];
    const repaired = await controller.dispatch("stage_target_selector_draft", { draft: { items: [child] } });
    expect(repaired).toMatchObject({ ok: true, draft_status: "saved_local_validation_passed", budget_consumed: false });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(compileTargetSelectors(saved, registry, manifest).acceptance_items.find(item => item.name === child.name)!.requirement).toBe(condition + second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upsert receipts nominate removed requirement source without restoring or approving it", async () => {
  const root = await mkdtemp(join(tmpdir(), "requirement-change-receipt-"));
  try {
    const first = "组件应完整。";
    const second = "连接处应连续。";
    const source = first + second;
    const { manifest, selectors } = fixture(source);
    const { registry, ids } = registerQuotes(manifest, [source, first, second]);
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const changed = structuredClone(selectors.items[0]!);
    changed.name = "连接连续性";
    changed.criterion_span_ids = [ids.get(second)!];
    changed.fields.name.span_ids = changed.criterion_span_ids;
    changed.fields.requirement.span_ids = changed.criterion_span_ids;
    changed.inspection_data_type_span_ids = changed.criterion_span_ids;
    const staged = await controller.dispatch("stage_target_selector_draft", { draft: { items: [changed] } });
    expect(staged).toMatchObject({ ok: true, budget_consumed: false, delivery_investigation: {
      advisory_only: true, hints: expect.arrayContaining([expect.objectContaining({
        code: "requirement_source_removed", item_keys: [changed.key], evidence_ids: [manifest.evidence[0]!.evidence_id],
        actual: { previous_requirement_span_ids: [ids.get(source)!], current_requirement_span_ids: [ids.get(second)!],
          previous_requirement_span_count: 1, previous_span_ids_complete: true,
          current_requirement_span_count: 1, current_span_ids_complete: true,
          uncarried_interval_count: 1, uncarried_intervals: [{ evidence_id: manifest.evidence[0]!.evidence_id, start: 0, end: first.length }], intervals_complete: true },
        instruction: expect.stringContaining("不能只因兄弟项"),
      })]) },
    });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual([changed]);
    expect(JSON.parse(await readFile(workspace.sourceSpanRegistryPath, "utf8"))).toEqual(registry);
    const repeated = await controller.dispatch("stage_target_selector_draft", { draft: { items: [changed] } });
    expect((repeated.delivery_investigation as any).hints.filter((hint: any) => hint.code === "requirement_source_removed")).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("field-role preflight rejects heading and foreign-clause method or quantity spans with exact replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-field-role-gate-"));
  try {
    const texts = {
      owner: "4.2.9 预埋件和预留孔洞的位置偏差应符合规定。",
      quantity: "检查数量：在同一检验批内抽查10%。",
      method: "检验方法：观察，尺量。",
      caption: "表 4.2.9 预埋件和预留孔洞的安装允许偏差",
      row: "预埋板中心线位置 | 3",
      heading: "## 一般项目 [PDF p.18]",
      foreign: "3 支架竖杆下应有底座或垫板。",
      foreignTable: "表 9.9.9 其他表 | 数据行 1 | 检验方法=错误表方法",
    };
    const manifest = manifestFor(Object.values(texts).join("\n"));
    manifest.evidence = [
      { evidence_id: "owner", kind: "paragraph", role: "supporting_clause", locator: "line:1", text: texts.owner, text_sha256: sha256Text(texts.owner), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "quantity", kind: "paragraph", role: "sampling_rule", locator: "line:3", text: texts.quantity, text_sha256: sha256Text(texts.quantity), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "method", kind: "paragraph", role: "inspection_method", locator: "line:4", text: texts.method, text_sha256: sha256Text(texts.method), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "caption", kind: "paragraph", role: "table_caption", locator: "line:5", text: texts.caption, text_sha256: sha256Text(texts.caption), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "row", kind: "table_row", role: "formal_table_row", locator: "line:6/table:4.2.9/row:2", text: texts.row, text_sha256: sha256Text(texts.row), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "heading", kind: "paragraph", role: "section_heading", locator: "line:8", text: texts.heading, text_sha256: sha256Text(texts.heading), requires_disposition: false, evidence_scope: "primary" },
      { evidence_id: "foreign", kind: "paragraph", role: "supporting_clause", locator: "line:11", text: texts.foreign, text_sha256: sha256Text(texts.foreign), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "foreign-table", kind: "table_row", role: "formal_table_row", locator: "line:12/table:9.9.9/row:1", text: texts.foreignTable, text_sha256: sha256Text(texts.foreignTable), requires_disposition: true, evidence_scope: "primary", table_row_kind: "data", table_fragment_id: "foreign-fragment", table_id: "9.9.9", table_title: "表 9.9.9 其他表", row_index: 1, columns: ["检验方法"], cells: ["错误表方法"] },
    ];
    manifest.scope.selected_atom_ids = manifest.evidence.map((record) => record.evidence_id);
    manifest.evidence_fingerprint = sha256Text(`field-role\0${Object.values(texts).join("\n")}`);
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((record) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    })));
    const foreignTableRecord = manifest.evidence.find((record) => record.evidence_id === "foreign-table")!;
    const foreignMethodCell = renderedTableCellSpans(foreignTableRecord)[0]!;
    const registeredForeignMethod = registerSourceSpan(registry, {
      source_id: foreignTableRecord.evidence_id,
      evidence_id: foreignTableRecord.evidence_id,
      atom_id: foreignTableRecord.evidence_id,
      text: foreignTableRecord.text,
    }, foreignMethodCell.start, foreignMethodCell.end);
    registry = registeredForeignMethod.registry;
    const foreignMethodSpanId = registeredForeignMethod.span.span_id;
    const span = (evidenceId: string): string => registry.spans.find((entry) =>
      entry.evidence_id === evidenceId && entry.start === 0
    )!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "模板安装", scope_span_ids: [span("owner")], reason: "4.2.9范围" });
    selectors.items.push({
      ...structuredClone(fixture().selectors.items[0]!),
      key: "embedded-plate",
      lot_key: "lot",
      name: "预埋板中心线位置",
      criterion_span_ids: [span("caption"), span("row"), span("heading"), span("foreign")],
      fields: {
        name: { composition: "verbatim", span_ids: [span("row")], separator: "", reason: "表格项目" },
        requirement: { composition: "verbatim", span_ids: [span("row")], separator: "", reason: "允许偏差" },
        method: { composition: "verbatim", span_ids: [span("heading")], separator: "", reason: "错误地把标题当方法" },
        quantity: { composition: "verbatim", span_ids: [span("foreign")], separator: "", reason: "错误地引用其他条款" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
      },
      table: {
        source_kind: "direct",
        table_key: "4.2.9",
        properties: {
          table_no_span_ids: [span("caption")],
          table_title_span_ids: [span("caption")],
          applicability_span_ids: [],
          row_path_span_ids: [[span("row")]],
          column_path_span_ids: [[span("row")]],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [span("row")],
          inspection_method_span_ids: [foreignMethodSpanId],
        },
        reference_span_ids: [],
        reason: "表4.2.9直接项目",
      },
      inspection_data_type_span_ids: [span("row")],
      sampling: {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [span("foreign")],
        script_span_ids: [span("foreign")],
        condition_span_ids: [],
        reason: "错误地引用其他条款",
        confidence: 1,
      },
    });
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(Object.values(texts).join("\n")) },
    );
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson({
      schema_version: "document-ledger/v1",
      source_sha256: manifest.source.sha256,
      file_name: manifest.source.file_name,
      clauses: [
        { clause_id: "4.2.9", line: 1, end_exclusive_line: 8, text: texts.owner, kind: "item_candidate", has_quantity: true, has_method: true, quantity_line: 3, method_line: 4 },
        { clause_id: "4.2.4", line: 10, end_exclusive_line: 13, text: "4.2.4 支架竖杆安装要求", kind: "item_candidate", has_quantity: false, has_method: false },
      ],
      headings: [], windows: [], record_tables: [], tables: [], anomalies: [],
    }), "utf8");
    const controller = await ToolController.create(workspace);

    const staged = await controller.dispatch("stage_target_selector_draft", {
      draft: { items: selectors.items },
    });
    expect(staged).toMatchObject({
      ok: true,
      model_review: {
        blocking: false,
        observations: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_field_heading_evidence_forbidden",
            path: "/items/0/fields/method/span_ids/0",
          }),
          expect.objectContaining({
            code: "selector_field_clause_line_mismatch",
            path: "/items/0/fields/quantity/span_ids/0",
          }),
        ]),
      },
    });

    const response = await controller.dispatch("compile_target_selectors", {});
    expect(response).toMatchObject({
      model_review: { blocking: false, observations: expect.arrayContaining([
        expect.objectContaining({
          code: "selector_field_heading_evidence_forbidden",
          path: "/items/0/fields/method/span_ids/0",
          actual: expect.objectContaining({ text: texts.heading }),
          details: expect.objectContaining({
            expected_candidates: expect.arrayContaining([
              expect.objectContaining({ text: texts.method, span_ids: [span("method")] }),
            ]),
          }),
        }),
        expect.objectContaining({
          code: "selector_field_clause_line_mismatch",
          path: "/items/0/fields/quantity/span_ids/0",
          actual: expect.objectContaining({ text: texts.foreign }),
          details: expect.objectContaining({
            owner_clause_id: "4.2.9",
            expected_line: 3,
            expected_candidates: expect.arrayContaining([
              expect.objectContaining({ text: texts.quantity, span_ids: [span("quantity")] }),
            ]),
          }),
        }),
        expect.objectContaining({
          code: "selector_field_clause_line_mismatch",
          path: "/items/0/table/properties/inspection_method_span_ids/0",
          actual: expect.objectContaining({ text: "错误表方法", evidence_id: "foreign-table" }),
          details: expect.objectContaining({
            owner_clause_id: "4.2.9",
          }),
        }),
      ]) },
    });

    const validSelectors = initialTargetSelectorPlan(manifest);
    validSelectors.lots = structuredClone(selectors.lots);
    validSelectors.items.push({
      ...structuredClone(fixture().selectors.items[0]!),
      key: "valid-checkpoint-item",
      lot_key: "lot",
      name: "预埋件安装质量",
      criterion_span_ids: [span("owner")],
      fields: {
        name: { composition: "semantic_summary", span_ids: [span("owner")], separator: "", reason: "被检对象" },
        requirement: { composition: "verbatim", span_ids: [span("owner")], separator: "", reason: "验收要求" },
        method: { composition: "verbatim", span_ids: [span("method")], separator: "", reason: "检验方法" },
        quantity: { composition: "verbatim", span_ids: [span("quantity")], separator: "", reason: "检查数量" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
      },
      table: null,
      inspection_data_type_span_ids: [span("owner")],
      sampling: {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [span("quantity")],
        script_span_ids: [span("quantity")],
        condition_span_ids: [],
        reason: "本条明确检查数量",
        confidence: 1,
      },
    });
    validSelectors.source_dispositions = ["caption", "row", "heading", "foreign", "foreign-table"].map((evidenceId) => ({
      span_ids: [span(evidenceId)],
      disposition: "context" as const,
      reason: "旧验证计划夹具显式处置未参与该有效项目的其他证据。",
    }));
    const persistedPlan = compileTargetSelectorsPersisted(validSelectors, registry, manifest);
    const persistedContent = prettyJson(persistedPlan);
    await writeFile(workspace.workingPlanPath, persistedContent, "utf8");
    const legacyValidation = validatePlanText(persistedContent, manifest);
    expect(legacyValidation.ok, JSON.stringify(legacyValidation.issues)).toBe(true);
    expect(legacyValidation).toMatchObject({ fingerprint: expect.any(String), plan_sha256: expect.any(String) });
    await workspace.updateState((state) => {
      state.last_valid_fingerprint = legacyValidation.fingerprint!;
      state.last_valid_plan_sha256 = legacyValidation.plan_sha256!;
    });
    expect(await controller.dispatch("seal_validated_plan", {
      fingerprint: legacyValidation.fingerprint,
    })).toMatchObject({
      ok: false,
      error: "selector_field_role_invalid",
      next_tool: "stage_target_selector_draft",
      budget_consumed: false,
    });
    expect(existsSync(workspace.manifestPath)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])("a referenced-table item binds its imported method cell without a clause-line mismatch (substring=%s)", async (substring) => {
  // Round-10 anchors regression (seq 617): the citation clause's method_line
  // was poisoned by a continuation table's markup, and the item's physical
  // table membership ignored the imported row/column bindings, so an exact
  // "检查方法" cell in the referenced table was rejected and the model was
  // told to replace it with unrelated continuation-table candidates.
  const root = await mkdtemp(join(tmpdir(), "selector-reference-method-cell-"));
  try {
    const texts = {
      anchor: "7.11.4 锚杆质量检验应符合表 7.11.7 的规定。",
      row: "3 | 抗拔承载力 | 锚杆抗拔试验，每组抽查两件",
      foreign: "错误表方法",
    };
    const manifest = manifestFor(Object.values(texts).join("\n"));
    manifest.evidence = [
      { evidence_id: "anchor", kind: "paragraph", role: "supporting_clause", locator: "line:1", text: texts.anchor, text_sha256: sha256Text(texts.anchor), requires_disposition: true, evidence_scope: "primary" },
      { evidence_id: "row", kind: "table_row", role: "formal_table_row", locator: "line:2/table:7.11.7/row:3", text: texts.row, text_sha256: sha256Text(texts.row), requires_disposition: true, evidence_scope: "primary", table_row_kind: "data", table_id: "7.11.7", row_index: 3, columns: ["序号", "项目", "检查方法"], cells: ["3", "抗拔承载力", "锚杆抗拔试验，每组抽查两件"], table_text_format: "cell_values_v1" },
      { evidence_id: "foreign", kind: "table_row", role: "formal_table_row", locator: "line:5/table:9.9.9/row:1", text: texts.foreign, text_sha256: sha256Text(texts.foreign), requires_disposition: true, evidence_scope: "primary", table_row_kind: "data", table_fragment_id: "foreign-fragment", table_id: "9.9.9", row_index: 1, columns: ["检验方法"], cells: ["错误表方法"], table_text_format: "cell_values_v1" },
    ];
    manifest.scope.selected_atom_ids = manifest.evidence.map((record) => record.evidence_id);
    manifest.evidence_fingerprint = sha256Text(`reference-method-cell\0${Object.values(texts).join("\n")}`);
    const source = (record: typeof manifest.evidence[number]) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    });
    let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(source));
    const rowRecord = manifest.evidence.find((record) => record.evidence_id === "row")!;
    const foreignRecord = manifest.evidence.find((record) => record.evidence_id === "foreign")!;
    const methodCell = renderedTableCellSpans(rowRecord).find((cell) => /(?:检验|检查)方法/u.test(cell.label))!;
    if (substring) methodCell.end = methodCell.start + "锚杆抗拔试验".length;
    const foreignCell = renderedTableCellSpans(foreignRecord)[0]!;
    const crossCell = { start: methodCell.start - 2, end: methodCell.end };
    for (const [record, cell] of [[rowRecord, methodCell], [foreignRecord, foreignCell], [rowRecord, crossCell]] as const) {
      const registered = registerSourceSpan(registry, source(record), cell.start, cell.end);
      registry = registered.registry;
    }
    const spanOf = (evidenceId: string, start = 0): string => registry.spans.find((entry) =>
      entry.evidence_id === evidenceId && entry.start === start
    )!.span_id;
    const methodCellSpanId = registry.spans.find((entry) =>
      entry.evidence_id === "row" && entry.start === methodCell.start && entry.end === methodCell.end
    )!.span_id;
    const foreignMethodSpanId = registry.spans.find((entry) =>
      entry.evidence_id === "foreign" && entry.start === foreignCell.start && entry.end === foreignCell.end
    )!.span_id;
    const anchorSpanId = spanOf("anchor");
    const rowSpanId = spanOf("row");
    const crossCellSpanId = spanOf("row", crossCell.start);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "锚杆检验批", scope_span_ids: [anchorSpanId], reason: "7.11.4范围" });
    selectors.items.push({
      ...structuredClone(fixture().selectors.items[0]!),
      key: "anchor-pullout",
      lot_key: "lot",
      name: "抗拔承载力",
      category: "主控项目",
      criterion_span_ids: [anchorSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [rowSpanId], separator: "", reason: "表内项目" },
        requirement: { composition: "verbatim", span_ids: [rowSpanId], separator: "", reason: "表内要求" },
        method: { composition: "verbatim", span_ids: [methodCellSpanId], separator: "", reason: "方法来自导入表格的单元格" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "fixture 无数量" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
      },
      table: {
        source_kind: "reference",
        table_key: "7.11.7",
        properties: {
          table_no_span_ids: [anchorSpanId],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [[rowSpanId]],
          column_path_span_ids: [[rowSpanId]],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [rowSpanId],
          inspection_method_span_ids: [methodCellSpanId, foreignMethodSpanId, crossCellSpanId],
        },
        reference_span_ids: [anchorSpanId],
        reason: "引用表 7.11.7 的导入行；方法单元格来自同一逻辑表，另一单元格来自外表",
      },
      inspection_data_type: "mixed",
      inspection_data_type_reason: "承载力量测加抗拔试验",
      inspection_data_type_span_ids: [rowSpanId],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "fixture 不形成抽样",
        confidence: 1,
      },
      reason: "7.11.4 引用表验收项目",
    });
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(Object.values(texts).join("\n")) },
    );
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson({
      schema_version: "document-ledger/v1",
      source_sha256: manifest.source.sha256,
      file_name: manifest.source.file_name,
      clauses: [
        { clause_id: "7.11.4", line: 1, end_exclusive_line: 4, text: texts.anchor, kind: "item_candidate", has_quantity: false, has_method: true, method_line: 4 },
      ],
      headings: [], windows: [], record_tables: [], tables: [], anomalies: [],
    }), "utf8");
    const controller = await ToolController.create(workspace);
    const staged = await controller.dispatch("stage_target_selector_draft", {
      draft: { items: selectors.items },
    });
    const issues = [
      ...((staged.local_validation as any)?.issues ?? []),
      ...((staged.model_review as any)?.observations ?? []),
    ] as Array<{ code: string; path?: string }>;
    // The imported-table method cell must not be flagged against the clause's
    // (table-poisoned) method line, while the genuinely foreign method still is.
    expect(issues).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ code: "selector_field_clause_line_mismatch", path: "/items/0/fields/method/span_ids/0" }),
      expect.objectContaining({ code: "selector_field_clause_line_mismatch", path: "/items/0/table/properties/inspection_method_span_ids/0" }),
    ]));
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_field_clause_line_mismatch", path: "/items/0/table/properties/inspection_method_span_ids/1" }),
      expect.objectContaining({ code: "selector_field_clause_line_mismatch", path: "/items/0/table/properties/inspection_method_span_ids/2" }),
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["direct-validation/v1", false], ["direct-validation/v1", true],
  [SAME_AGENT_SELF_REVIEW_PROTOCOL, false], [SAME_AGENT_SELF_REVIEW_PROTOCOL, true],
] as const)("target %s validates and seals without self-review or Coverage, historical table fingerprint=%s", async (reviewProtocol, historicalTableFingerprint) => {
  const root = await mkdtemp(join(tmpdir(), "selector-same-agent-review-"));
  try {
    const { manifest, selectors } = fixture("1.2.3 基层表面应平整、密实。检验方法：用2m靠尺检查。");
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
    );
    await workspace.updateState((state) => {
      state.target_review_protocol = reviewProtocol;
    });
    if (historicalTableFingerprint) {
      // Table decisions are tied to the immutable source document. Registering
      // another reference can change the evidence envelope without editing them.
      await writeFile(join(workspace.root, "table-structure.json"), prettyJson({
        schema_version: "table-structure-decisions/v1", source_version: manifest.source.sha256,
        evidence_fingerprint: sha256Text("evidence-before-reference-registration"), tables: [],
      }));
    }
    const controller = await ToolController.create(workspace);
    expect(createPiTools(controller).map((tool) => tool.name)).not.toContain("review_target_selector_draft");
    for (const name of ["open_evidence", "batch_open_evidence", "read_document_reference_evidence"]) {
      expect(createPiTools(controller).find((tool) => tool.name === name)).toBeDefined();
    }
    expect((await controller.dispatch("get_target_selector_contract", {}) as any).authoring_protocols.tables)
      .toContain("整行不复制到每个标量");
    const opened = await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    expect(opened).toMatchObject({ ok: true });
    expect(TARGET_SELECTOR_PROTOCOLS.tables).toContain("整行不复制到每个标量");
    const batchOpened = await controller.dispatch("batch_open_evidence", { evidence_ids: [manifest.evidence[0]!.evidence_id] });
    expect(batchOpened).toMatchObject({ ok: true });
    expect(TARGET_SELECTOR_PROTOCOLS.patch).toContain("已读精确子串");
    const invalidItem = structuredClone(selectors.items[0]!);
    invalidItem.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: invalidItem.criterion_span_ids,
      script_span_ids: [],
      condition_span_ids: [],
      reason: "故意缺少可执行抽样脚本以验证自检前预检",
      confidence: 1,
    };
    const invalidStage = await controller.dispatch("stage_target_selector_draft", {
      draft: { lots: selectors.lots, items: [invalidItem] },
    });
    expect(invalidStage).toMatchObject({
      ok: true,
      draft_status: "saved_local_validation_failed",
      local_validation: { ok: false, global_completeness_checked: false },
    });
    const rejectedBeforeReview = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: invalidStage.draft_fingerprint,
    });
    expect(rejectedBeforeReview).toMatchObject({
      ok: false,
      error: "selector_repair_required",
      full_stage_check_performed: false,
      global_candidate_complete: false,
      next_tool: "read_target_selectors",
      budget_consumed: false,
    });
    expect((await workspace.readState()).selector_protocol?.self_review_completed).not.toBe(true);

    const staged = await controller.dispatch("stage_target_selector_draft", {
      draft: { lots: selectors.lots, items: selectors.items },
    });
    const firstCommit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: staged.draft_fingerprint,
    });
    const committed = firstCommit;
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    const compilerContextContent = await readFile(workspace.selectorCompilerContextPath, "utf8");
    const compilerContext = JSON.parse(compilerContextContent) as SelectorCompilerContext;
    const validationReceipt = JSON.parse(await readFile(workspace.validationReceiptPath, "utf8"));
    expect(validationReceipt.selector_compiler_context_fingerprint)
      .toBe(selectorCompilerContextFingerprint(compilerContext));
    expect((await workspace.readState()).selector_protocol).toMatchObject({
      submissions: 1,
      corrections: 0,
      self_review_completed: false,
    });
    const sealed = await controller.dispatch("seal_validated_plan", {
      fingerprint: (committed as { fingerprint: string }).fingerprint,
    });
    expect(sealed, JSON.stringify(sealed)).toMatchObject({ ok: true, status: "passed" });
    expect(await existsSync(workspace.manifestPath)).toBe(true);
    expect(await existsSync(join(workspace.coverageReviewDirectory, "sealed.coverage-review.json"))).toBe(false);
    const sealedManifest = JSON.parse(await readFile(workspace.manifestPath, "utf8"));
    expect(sealedManifest.fingerprints.files["selector-compiler-context.json"])
      .toBe(sha256Text(compilerContextContent));
    expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(true);
    expect(compilerContext.table_structure_plan.evidence_fingerprint).toBe(manifest.evidence_fingerprint);
    await workspace.updateState(state => { state.target_review_protocol = "legacy-independent-coverage/v1"; });
    expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(false);
    await workspace.updateState(state => { state.target_review_protocol = reviewProtocol; });
    expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(true);
    await chmod(workspace.selectorCompilerContextPath, 0o666);
    await writeFile(workspace.selectorCompilerContextPath, `${compilerContextContent}\n`, "utf8");
    expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);


test("sampling navigation finds 检验数量 but never claims missing keyword matches prove no applicable rule", async () => {
  const root=await mkdtemp(join(tmpdir(),"sampling-navigation-"));
  try {
    const {manifest}=fixture("地基承载力的检验数量每 300m² 不应少于 1 点。每单位工程不应少于 3 点。");
    const workspace=await RevisionWorkspace.createFromEvidence(root,manifest.job_id,manifest.target_id,{manifest,markdown:Buffer.from(manifest.evidence[0]!.text)});
    const controller=await ToolController.create(workspace);
    const before=await readFile(workspace.workingSelectorPath,"utf8");
    const navigation=await controller.dispatch("list_sampling_rules",{});
    expect(navigation).toMatchObject({ok:true,candidates:[],navigation_is_exhaustive:false,navigation_candidates:expect.arrayContaining([expect.objectContaining({evidence_id:manifest.evidence[0]!.evidence_id})])});
    expect(await readFile(workspace.workingSelectorPath,"utf8")).toBe(before);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test.each(["not_sampling", "fallback"] as const)("a directly bound full-inspection quantity cannot be classified as %s", status => {
  const criterionText = "构件应无裂纹。";
  const quantityText = "检查数量：全数检查。";
  const text = criterionText + quantityText;
  const { manifest, selectors } = fixture(text);
  const { registry, ids } = registerQuotes(manifest, [text, criterionText, quantityText]);
  const item = selectors.items[0]!;
  item.criterion_span_ids = [ids.get(criterionText)!];
  item.fields.name.span_ids = [...item.criterion_span_ids];
  item.fields.requirement.span_ids = [...item.criterion_span_ids];
  item.inspection_data_type_span_ids = [...item.criterion_span_ids];
  item.fields.quantity = { composition: "verbatim", span_ids: [ids.get(quantityText)!], separator: "", reason: "本地明确全数检查" };
  item.sampling.status = status;
  expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({
    code: "selector_full_inspection_sampling_required", details: expect.objectContaining({ actual: expect.objectContaining({ status }), how_to_pass: expect.stringContaining("explicit"), writable_path: "/items/0/sampling", next_tool: "stage_target_selector_draft" }),
  })]) }));
  item.sampling = { status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [ids.get(quantityText)!], script_span_ids: [ids.get(quantityText)!], condition_span_ids: [], reason: "单条本地全数检查是可执行数量", confidence: 1 };
  expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.sampling.min_sampling).toBe(quantityText);
});

test("an empty shared rule routes repair to its branch declarations, never an empty choice list", () => {
  const text = "构件应无裂纹。每批抽查三件。";
  const { manifest, selectors } = fixture(text);
  const { registry, ids } = registerQuotes(manifest, [text, "构件应无裂纹。", "每批抽查三件。"]);
  const spanId = ids.get("每批抽查三件。")!;
  const criterion = ids.get("构件应无裂纹。")!;
  selectors.items[0]!.criterion_span_ids = [criterion];
  selectors.items[0]!.fields.name.span_ids = [criterion];
  selectors.items[0]!.fields.requirement.span_ids = [criterion];
  selectors.items[0]!.inspection_data_type_span_ids = [criterion];
  selectors.items[0]!.sampling = { status: "reference", rule_key: "shared", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "共享规则适用", confidence: 1 };
  selectors.sampling_rules = [{ key: "shared", complete_span_ids: [spanId], components: [...sharedSamplingDispositions(), ...branchSamplingComponents("shared", [spanId], [spanId], [])], branches: [], reason: "无业务条件分支的单一抽查决定" }];
  try { compileTargetSelectors(selectors, registry, manifest); throw new Error("expected repair"); }
  catch (error) {
    const issue = (error as TargetSelectorCompileError).issues.find(issue => issue.code === "selector_sampling_branch_required")!;
    expect(issue.details).toMatchObject({ required_action: "declare_default_or_source_branches_then_select_applicable_keys", writable_path: "/sampling_rules/0/branches", next_tool: "stage_target_selector_draft", how_to_pass: expect.stringContaining("默认分支") });
    expect(issue.details?.how_to_pass).not.toContain("从空");
  }
  selectors.sampling_rules[0]!.branches = [{ key: "default", applies_to_category: "一般项目", components: [], reason: "默认分支继承共同组件，不虚构条件" }];
  selectors.items[0]!.sampling.branch_keys = ["default"];
  expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0]!.sampling.min_sampling).toBe("每批抽查三件。");
});

test("staging a shared rule before its receivers defers linkage checks but full compile still rejects it", async () => {
  const text = "构件应无裂纹。每批抽查三件。";
  const { manifest, selectors } = fixture(text);
  const { registry, ids } = registerQuotes(manifest, [text, "每批抽查三件。"]);
  const spanId = ids.get("每批抽查三件。")!;
  const rule = { key: "shared", complete_span_ids: [spanId], components: sharedSamplingDispositions(), branches: [{ key: "default", applies_to_category: "一般项目" as const, components: branchSamplingComponents("default", [spanId], [spanId], []), reason: "明确的抽查数量" }], reason: "先保存共同规则，再连接接收项目" };
  const root = await mkdtemp(join(tmpdir(), "sampling-linkage-feedback-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(text) });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const result = await controller.dispatch("stage_target_selector_draft", { draft: { sampling_rules: [rule] } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, local_validation: { ok: true, deferred_nonlocal_issue_count: expect.any(Number) } });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(() => compileTargetSelectors(saved, registry, manifest)).toThrowError(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: "selector_sampling_rule_unreferenced" })]) }));
    const advanced = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }) as any;
    expect(advanced).toMatchObject({ ok: false, error: "selector_repair_required", current_stage: "primary", full_stage_check_performed: false });
    const issue = advanced.selector_issues.find((row: any) => row.code === "selector_sampling_rule_unreferenced");
    expect(issue).toMatchObject({
      message: expect.stringMatching(/[\u3400-\u9fff]/),
      how_to_pass: expect.stringContaining("二选一完成修复"),
      writable_paths: expect.arrayContaining(["/sampling_rules/0", "/items"]),
      next_tool: "read_target_selectors",
      candidate_read_tools: ["read_target_selectors"],
      next_tools: ["read_target_selectors", "stage_target_selector_draft"],
      save_tool: "stage_target_selector_draft",
      details: {
        required_action: "select_the_rule_from_each_semantic_receiver_or_remove_the_unused_rule",
        candidate_read_tool: "read_target_selectors",
      },
    });
    expect(issue.how_to_pass).not.toContain("select_the_rule_from_each_semantic_receiver_or_remove_the_unused_rule");
    expect(createPiTools(controller).map(tool => tool.name)).toContain(issue.details.candidate_read_tool);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([false, true])("preserves an unspecified sampling branch alongside full inspection (mixed=%s)", (mixed) => {
  const criterion = "安全钳与导轨的间隙应符合产品设计要求。";
  const samplingRule = "各分项工程中的一般项目应进行抽验。";
  const masterRule = "各分项工程中的主控项目应全验。";
  const text = `${criterion}\n${mixed ? masterRule : ""}${samplingRule}`;
  const manifest = manifestFor(text);
  const registered = registerQuotes(manifest, [text, criterion, samplingRule, ...(mixed ? [masterRule] : [])]);
  const fullSpanId = registered.ids.get(text)!;
  const criterionSpanId = registered.ids.get(criterion)!;
  const samplingSpanId = registered.ids.get(samplingRule)!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "safety-components",
    name: "安全部件",
    scope_span_ids: [fullSpanId],
    reason: "同一安全部件验收范围",
  });
  selectors.sampling_rules.push({
    key: "general-items-sampled",
    complete_span_ids: [samplingSpanId],
    components: sharedSamplingDispositions(),
    branches: [{
      key: "general-items",
      applies_to_category: "一般项目",
      components: branchSamplingComponents("general-items", [], [samplingSpanId], []),
      reason: "原文要求一般项目抽验，但没有规定具体数量。",
    }],
    reason: "保留抽验义务，同时如实记录数量未规定。",
  });
  if (mixed) {
    const masterSpanId = registered.ids.get(masterRule)!;
    selectors.sampling_rules[0]!.complete_span_ids.unshift(masterSpanId);
    selectors.sampling_rules[0]!.branches.unshift({
      key: "master-items",
      applies_to_category: "主控项目",
      components: branchSamplingComponents("master-items", [masterSpanId], [masterSpanId], []),
      reason: "相邻主控项目全验，不属于一般项目的抽验分支。",
    });
  }
  selectors.items.push({
    key: "safety-gear-guide-clearance",
    lot_key: "safety-components",
    name: "安全钳与导轨的间隙",
    category: "一般项目",
    criterion_span_ids: [criterionSpanId],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [criterionSpanId], separator: "", reason: "被检对象" },
      requirement: { composition: "verbatim", span_ids: [criterionSpanId], separator: "", reason: "完整合格判据" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给具体方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给具体数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "按产品设计要求核查间隙。",
    inspection_data_type_span_ids: [criterionSpanId],
    sampling: {
      status: "reference_unspecified_quantity",
      rule_key: "general-items-sampled",
      branch_keys: ["general-items"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "原文要求抽验，但没有给出可执行数量。",
      confidence: 1,
    },
    reason: "一个可独立判定的安全部件要求。",
  });

  const plan = compileTargetSelectors(selectors, registered.registry, manifest);
  expect(plan.acceptance_items[0]!.sampling).toMatchObject({
    status: "reference_unspecified_quantity",
    min_sampling: "",
    script: "",
    evidence_ids: [manifest.evidence[0]!.evidence_id],
    rule_ids: [expect.any(String)],
    branch_ids: [expect.any(String)],
  });
  expect(plan.acceptance_items[0]!.sampling.applied_branches).toEqual([
    expect.objectContaining({ min_sampling: "", script: "" }),
  ]);
  const validation = validatePlanText(prettyJson(plan), manifest);
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });

  const quantityActuallyPresent = structuredClone(selectors);
  quantityActuallyPresent.sampling_rules[0]!.branches.find(branch => branch.key === "general-items")!.components = branchSamplingComponents(
    "general-items",
    [samplingSpanId],
    [samplingSpanId],
    [],
  );
  expect(() => compileTargetSelectors(quantityActuallyPresent, registered.registry, manifest)).toThrowError(
    expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_sampling_unspecified_quantity_has_quantity" }),
      ]),
    }),
  );

  const instructionNotBound = structuredClone(selectors);
  instructionNotBound.sampling_rules[0]!.branches.find(branch => branch.key === "general-items")!.components = branchSamplingComponents(
    "general-items",
    [],
    [],
    [],
  );
  expect(() => compileTargetSelectors(instructionNotBound, registered.registry, manifest)).toThrowError(
    expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_sampling_unspecified_script_missing" }),
      ]),
    }),
  );
});

test("reports executable routes when unspecified sampling has a quantity component", async () => {
  const criterion = "构件应符合设计要求。";
  const samplingRule = "按检验批抽查。";
  const text = `${criterion}\n${samplingRule}`;
  const manifest = manifestFor(text);
  const registered = registerQuotes(manifest, [text, criterion, samplingRule]);
  const criterionSpanId = registered.ids.get(criterion)!;
  const samplingSpanId = registered.ids.get(samplingRule)!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "generic-lot",
    name: "通用检验批",
    scope_span_ids: [registered.ids.get(text)!],
    reason: "同一来源范围",
  });
  selectors.sampling_rules.push({
    key: "generic-sampling",
    complete_span_ids: [samplingSpanId],
    components: [
      ...sharedSamplingDispositions(),
      { key: "shared-quantity", role: "quantity" as const, disposition: "present" as const, span_ids: [samplingSpanId], reason: "共享抽查数量" },
    ],
    branches: [{
      key: "generic-branch",
      applies_to_category: "一般项目",
      components: branchSamplingComponents("generic-branch", [samplingSpanId], [samplingSpanId], []),
      reason: "通用抽查分支",
    }],
    reason: "通用共享抽查规则",
  });
  selectors.items.push({
    key: "generic-item",
    lot_key: "generic-lot",
    name: "通用检验项",
    category: "一般项目",
    criterion_span_ids: [criterionSpanId],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [criterionSpanId], separator: "", reason: "通用检验对象" },
      requirement: { composition: "verbatim", span_ids: [criterionSpanId], separator: "", reason: "通用判据" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给独立方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给独立数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "按原文核查",
    inspection_data_type_span_ids: [criterionSpanId],
    sampling: {
      status: "reference_unspecified_quantity",
      rule_key: "generic-sampling",
      branch_keys: ["generic-branch"],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "原文没有给出可执行数量",
      confidence: 1,
    },
    reason: "通用验收项",
  });
  const badItem = selectors.items[0]!;
  const badRule = selectors.sampling_rules[0]!;
  const root = await mkdtemp(join(tmpdir(), "sampling-feedback-route-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(text) });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registered.registry), "utf8");
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const result = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      collection: "items",
      draft: {
        items: [{
          ...badItem,
          sampling: { ...badItem.sampling, status: "reference_unspecified_quantity" },
        }],
      },
    }) as any;
    const issue = result.local_validation.issues.find((row: any) => row.code === "selector_sampling_unspecified_quantity_has_quantity");
    expect(issue).toMatchObject({
      path: "/items/0/sampling/branch_keys/0",
      writable_path: "/items/0/sampling/status",
      writable_paths: expect.arrayContaining([
        "/items/0/sampling/status",
        "/sampling_rules/0/branches/0/components",
      ]),
      candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_sampling_rules", "open_evidence", "locate_evidence_span"]),
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "sampling_rules", key: "generic-sampling" },
      next_tools: expect.arrayContaining(["stage_target_selector_draft"]),
      save_tool: "stage_target_selector_draft",
      actual: {
          item_key: "generic-item",
          sampling_status: "reference_unspecified_quantity",
          rule_key: "generic-sampling",
          branch_key: "generic-branch",
          quantity_span_ids: [samplingSpanId],
          effective_quantity_components: [expect.objectContaining({
            scope: "shared",
            path: "/sampling_rules/0/components/4",
            key: "shared-quantity",
            role: "quantity",
            disposition: "present",
            span_ids: [samplingSpanId],
          }), expect.objectContaining({
            scope: "branch",
            path: "/sampling_rules/0/branches/0/components/0",
            key: "generic-branch:quantity",
            role: "quantity",
            disposition: "present",
            span_ids: [samplingSpanId],
          })],
        },
    });
    expect(issue.details).not.toHaveProperty("tool_argument_hints");
    expect(issue.tool_argument_hints.open_evidence).toEqual([
      { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 },
    ]);
    expect(issue.writable_paths).toContain("/items/0/sampling");
    for (const readArgs of issue.tool_argument_hints.read_target_selectors) {
      const readResult = await controller.dispatch("read_target_selectors", readArgs) as any;
      expect(readResult).toMatchObject({ ok: true, collection: readArgs.collection, view: "record" });
      expect(readResult.rows).toHaveLength(1);
    }
    const listResult = await controller.dispatch("list_sampling_rules", issue.tool_argument_hints.list_sampling_rules) as any;
    expect(listResult).toMatchObject({ ok: true });
    expect(listResult).toHaveProperty("next_cursor");
    for (const openArgs of issue.tool_argument_hints.open_evidence) {
      expect(await controller.dispatch("open_evidence", openArgs)).toMatchObject({ ok: true });
    }
    expect(result.local_validation.ok).toBe(false);

    const keepQuantity = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      collection: "items",
      draft: { items: [{ ...badItem, sampling: { ...badItem.sampling, status: "reference" } }] },
    }) as any;
    expect(keepQuantity).toMatchObject({ ok: true, local_validation: { ok: true } });
    const removeQuantityRule = structuredClone(badRule);
    removeQuantityRule.components[4] = {
      ...removeQuantityRule.components[4]!,
      disposition: "absent",
      span_ids: [],
      reason: "原文核对后该共享规则没有可执行数量",
    };
    removeQuantityRule.branches[0]!.components = branchSamplingComponents("generic-branch", [], [samplingSpanId], []);
    const removeQuantity = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      collection: "sampling_rules",
      draft: {
        items: [{ ...badItem }],
        sampling_rules: [removeQuantityRule],
      },
    }) as any;
    expect(removeQuantity).toMatchObject({ ok: true, local_validation: { ok: true } });
    const readback = await controller.dispatch("read_target_selectors", { collection: "sampling_rules", key: "generic-sampling" }) as any;
    expect(readback.rows[0].components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "shared-applicability", disposition: "absent", span_ids: [] }),
      expect.objectContaining({ key: "shared-quantity", role: "quantity", disposition: "absent", span_ids: [] }),
    ]));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test.each(["主控项目", "一般项目", "all_items"] as const)("rejects treating full inspection as an unspecified sampling quantity for %s", (category) => {
  const text = `构件应符合要求。${category === "all_items" ? "所有项目" : category}应全验。`;
  const { manifest, registry, selectors } = fixture(text);
  const fullSpanId = registry.spans.find((span) => span.start === 0 && span.end === text.length)!.span_id;
  selectors.items[0]!.category = category === "all_items" ? "一般项目" : category;
  selectors.items[0]!.sampling = {
    status: "reference_unspecified_quantity",
    rule_key: "master-full-inspection",
    branch_keys: ["master"],
    quantity_span_ids: [],
    script_span_ids: [],
    condition_span_ids: [],
    reason: "错误地把全验当成数量未规定。",
    confidence: 1,
  };
  selectors.sampling_rules = [{
    key: "master-full-inspection",
    complete_span_ids: [fullSpanId],
    components: sharedSamplingDispositions(),
    branches: [{
      key: "master",
      applies_to_category: category,
      components: branchSamplingComponents("master", [], [fullSpanId], []),
      reason: "主控项目全验。",
    }],
    reason: "主控项目全验规则。",
  }];

  expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrowError(
    expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "selector_sampling_unspecified_quantity_is_full_inspection",
          details: expect.objectContaining({
            actual_script: text,
            writable_paths: expect.arrayContaining(["/items/0/sampling"]),
            writable_collections: ["sampling_rules", "items"],
            repair_options: expect.arrayContaining([expect.stringContaining("相邻分支")]),
            do_not_edit: expect.any(String),
            candidate_read_tools: expect.arrayContaining([
              "read_target_selectors",
              "list_sampling_rules",
              "open_evidence",
              "locate_evidence_span",
            ]),
            next_tool: "read_target_selectors",
            next_tools: expect.arrayContaining(["locate_evidence_span", "stage_target_selector_draft"]),
            save_tool: "stage_target_selector_draft",
            writable_path: "/sampling_rules/0/components",
            how_to_pass: expect.stringContaining("reference_unspecified_quantity"),
            required_action: "check_branch_scope_then_bind_quantity_or_narrow_sampling_instruction",
          }),
        }),
      ]),
    }),
  );
});

test("full-inspection feedback traces inherited script to the exact shared author component without assigning its business scope", () => {
  const text = "构件应完好。甲类应全数检查，乙类应抽查。";
  const { manifest, registry, selectors } = fixture(text);
  const fullSpan = registry.spans.find(span => span.start === 0 && span.end === text.length)!;
  const item = selectors.items[0]!;
  item.category = "一般项目";
  item.sampling = { status: "reference_unspecified_quantity", rule_key: "shared-rule", branch_keys: ["selected"],
    quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "原文数量未规定的作者声明", confidence: 1 };
  const components = sharedSamplingDispositions();
  components[0] = { key: "joint-scope", role: "applicability", disposition: "present", span_ids: [fullSpan.span_id], reason: "作者选取共同范围" };
  selectors.sampling_rules = [{ key: "shared-rule", complete_span_ids: [fullSpan.span_id], components,
    branches: [{ key: "selected", applies_to_category: "一般项目", components: sharedSamplingDispositions(), reason: "所选分支" }], reason: "共同规则" }];
  const before = JSON.stringify({ selectors, registry });
  let rejected: TargetSelectorCompileError | undefined;
  try { compileTargetSelectors(selectors, registry, manifest); } catch (error) { rejected = error as TargetSelectorCompileError; }
  expect(rejected).toBeInstanceOf(TargetSelectorCompileError);
  const issue = rejected!.issues.find(issue => issue.code === "selector_sampling_unspecified_quantity_is_full_inspection")!;
  expect(issue.details).toMatchObject({
    item_key: item.key,
    actual: { status: "reference_unspecified_quantity", script: text, quantity_span_ids: [], script_components: [{
      scope: "shared", path: "/sampling_rules/0/components/0", key: "joint-scope", role: "applicability",
      span_ids: [fullSpan.span_id],
    }] },
    expected: { quantity: "absent", instruction: "source_backed_and_scoped_to_the_selected_branch_without_inapplicable_full_inspection" },
    affected_item_reads: [{ tool: "read_target_selectors", arguments: { collection: "items", key: item.key } }],
    next_tool_arguments: { collection: "sampling_rules", key: "shared-rule" },
    unchanged_input_note: expect.stringContaining("共享"),
  });
  expect((issue.details as any).how_to_pass).toContain("actual.script_components");
  expect((issue.details as any).repair_options).toEqual(expect.arrayContaining([
    expect.stringContaining("适用于本分支"), expect.stringContaining("相邻分支"),
  ]));
  expect(JSON.stringify({ selectors, registry })).toBe(before);
});

test("missing read receipts retry the same selector commit after reading without editing selectors", async () => {
  const { manifest, selectors } = fixture();
  const root = await mkdtemp(join(tmpdir(), "missing-read-feedback-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; });
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const draft = await controller.dispatch("stage_target_selector_draft", { draft: { lots: selectors.lots, items: selectors.items } });
    (controller as unknown as { openedEvidenceIds: Set<string> }).openedEvidenceIds.clear();
    const rejected = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: draft.draft_fingerprint }) as any;
    expect(rejected).toMatchObject({ ok: false, next_tool: "batch_open_evidence", tool_arguments: { evidence_ids: [manifest.evidence[0]!.evidence_id] }, writable_paths: [], issues: expect.arrayContaining([expect.objectContaining({ code: "semantic_evidence_not_opened", next_tool: "open_evidence", writable_path: null })]) });
    expect(rejected.instruction).toContain("无需改selector");
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    expect(Check(createPiTools(controller).find(tool => tool.name === rejected.next_tool)!.parameters, rejected.tool_arguments)).toBe(true);
    await controller.dispatch(rejected.next_tool, rejected.tool_arguments);
    expect(await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: draft.draft_fingerprint })).toMatchObject({ ok: true });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["own", "neighbor"] as const)("executes both full-inspection feedback repair routes (%s)", async (route) => {
  const text = "构件应完好。甲类应全数检查，乙类应抽查。";
  const { manifest, selectors } = fixture(text);
  const root = await mkdtemp(join(tmpdir(), "sampling-feedback-route-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(text) });
    await workspace.updateState(state => { state.selector_stage = "sampling"; });
    const controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
    const full = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    selectors.items[0]!.sampling = { status: "reference_unspecified_quantity", rule_key: "shared", branch_keys: ["default"], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "核对当前适用分支", confidence: 1 };
    selectors.sampling_rules = [{ key: "shared", complete_span_ids: [full], components: [...sharedSamplingDispositions(), ...branchSamplingComponents("shared", [], [full], [])], branches: [{ key: "default", applies_to_category: "all_items", components: [], reason: "默认结构分支" }], reason: "验证来源选择过宽时的两种修复路径" }];
    const first = await controller.dispatch("stage_target_selector_draft", { draft: { lots: selectors.lots, items: selectors.items, sampling_rules: selectors.sampling_rules } }) as any;
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, local_validation: { ok: true }, model_review: { blocking: false } });
    const issue = actionableSelectorIssue(first.model_review.observations.find((row: any) => row.code === "selector_sampling_unspecified_quantity_is_full_inspection"), selectors) as any;
    expect(issue).toMatchObject({
      actual: { script_components: expect.arrayContaining([expect.objectContaining({ scope: "shared", role: "method", span_ids: [full] })]) },
      detail_fields_at_issue_level: expect.arrayContaining(["actual"]),
      details: { item_key: selectors.items[0]!.key,
        affected_item_reads: [{ tool: "read_target_selectors", arguments: { collection: "items", key: selectors.items[0]!.key } }] },
      writable_path: "/sampling_rules/0/components",
      how_to_pass: expect.stringContaining("reference_unspecified_quantity"),
      writable_paths: expect.arrayContaining(["/sampling_rules/0/components", "/items/0/sampling"]),
      writable_collections: ["sampling_rules", "items"],
      candidate_read_tools: expect.arrayContaining(["open_evidence", "locate_evidence_span"]),
      next_tool: "read_target_selectors",
      next_tools: expect.arrayContaining(["open_evidence", "locate_evidence_span", "stage_target_selector_draft"]),
      save_tool: "stage_target_selector_draft",
      do_not_edit: expect.stringContaining("item.fields.quantity"),
    });
    const codec = await ModelSourceHandles.open(workspace.root);
    const beforeRead = await readFile(workspace.workingSelectorPath, "utf8");
    const publicIssue = await codec.encode(issue) as any;
    expect(publicIssue.actual.script_components.every((component: any) => component.span_ids.every((id: string) => /^s\d+$/u.test(id)))).toBe(true);
    expect(await codec.decodeResponse({ ...publicIssue, source_handle_scope: codec.scope })).toEqual(issue);
    const readTool = createPiTools(controller).find(tool => tool.name === issue.next_tool)!;
    expect(Check(readTool.parameters, issue.next_tool_arguments)).toBe(true);
    const read = await controller.dispatch(issue.next_tool, issue.next_tool_arguments) as any;
    expect(read.rows[0].key).toBe("shared");
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeRead);
    const rule = structuredClone(selectors.sampling_rules[0]!);
    const quote = route === "own" ? "甲类应全数检查" : "乙类应抽查";
    rule.components = [...sharedSamplingDispositions(), ...branchSamplingComponents("shared", route === "own" ? ["$instruction"] : [], ["$instruction"], [])];
    // Keep the full original coverage span; only the effective branch instruction is narrowed.
    selectors.items[0]!.sampling.status = route === "own" ? "reference" : "reference_unspecified_quantity";
    const repaired = await controller.dispatch(issue.save_tool, { draft: { sampling_rules: [rule], items: selectors.items }, quote_bindings: [{ key: "$instruction", evidence_id: manifest.evidence[0]!.evidence_id, quote }] }) as any;
    expect(repaired, JSON.stringify(repaired)).toMatchObject({ ok: true, local_validation: { ok: true } });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.sampling_rules[0].complete_span_ids).toEqual([full]);
    expect(saved.items[0].fields).toEqual(selectors.items[0]!.fields);
    const plan = compileTargetSelectors(saved, await workspace.readSourceSpanRegistry(), manifest);
    expect(plan.acceptance_items[0]!.sampling).toMatchObject({ status: route === "own" ? "reference" : "reference_unspecified_quantity", min_sampling: route === "own" ? quote : "", script: "" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a self-reported missing external source unless durable reference state proves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "missing-external-source-guard-"));
  try {
    const { manifest } = fixture("一般项目应进行抽验，但本规范未规定具体数量。");
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
    );
    const controller = await ToolController.create(workspace);
    const spanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    expect(await controller.dispatch("report_target_blocker", {
      kind: "missing_external_source",
      evidence_span_ids: [spanId],
      affected_selector_paths: ["/sampling"],
      explanation: "原文要求抽验但没有提供具体数量，不能编造。",
    })).toMatchObject({
      ok: false,
      terminal: false,
      budget_consumed: false,
      error: "missing_external_source_unverified",
      issue_owner: "selector_input_error",
      instruction: expect.stringContaining("reference_unspecified_quantity"),
    });
    expect((await workspace.readState()).status).toBe("working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a proved unresolved external-standard blocker terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "missing-external-source-proved-"));
  try {
    const { manifest } = fixture("抽样数量应符合外部标准 GB 99999 的规定。");
    const origin = manifest.evidence[0]!;
    manifest.reference_occurrences.push({
      occurrence_id: "reference:missing-gb99999",
      origin_evidence_id: origin.evidence_id,
      origin_evidence_ids: [origin.evidence_id],
      origin_fields: ["sampling"],
      raw_reference: "GB 99999",
      normalized_reference: "GB 99999",
      external_standard: { standard_no: "GB 99999", status: "placeholder" },
      target_evidence_ids: [],
      required: true,
      status: "target_not_found",
      depth: 1,
      path: ["GB 99999"],
      reference_kind: "clause",
      target_address: {
        source_id: "external:GB99999",
        locator_kind: "standard",
        locator: "GB 99999",
      },
    });
    const workspace = await RevisionWorkspace.createFromEvidence(
      root,
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(origin.text) },
    );
    const controller = await ToolController.create(workspace);
    const spanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const routed = await controller.dispatch("report_target_blocker", {
      kind: "ambiguous_source", evidence_span_ids: [spanId], affected_selector_paths: ["/sampling"],
      explanation: "原文明确引用的外部标准没有提供，无法取得其抽样规则。",
    }) as any;
    expect(routed).toMatchObject({
      ok: false, terminal: false, budget_consumed: false,
      error: "ambiguous_source_external_reference_unresolved",
      actual: { references: [{ occurrence_id: "reference:missing-gb99999", status: "target_not_found", external_standard_status: "placeholder" }] },
      writable_path: "/kind", allowed_values: ["missing_external_source"], next_tool: "report_target_blocker",
      next_tool_arguments: { kind: "missing_external_source", evidence_span_ids: [spanId], affected_selector_paths: ["/sampling"] },
    });
    expect((await workspace.readState()).status).toBe("working");
    expect(await controller.dispatch(routed.next_tool, routed.next_tool_arguments)).toMatchObject({
      ok: false,
      terminal: true,
      error: "target_blocked_with_evidence",
      blocker_code: "missing_external_source",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference-placeholder table feedback also repairs a mistaken placeholder mode without extra items", () => {
  const originText = "本项检查见表 T。";
  const targetText = "项目甲 | 应符合要求";
  const manifest = manifestFor(originText);
  manifest.evidence.push({
    evidence_id: "atom:neutral-reference-table-row",
    kind: "table_row",
    role: "context",
    locator: "table:T/row:1",
    text: targetText,
    text_sha256: sha256Text(targetText),
    requires_disposition: false,
    evidence_scope: "reference",
    table_row_kind: "data",
    table_id: "T",
    row_index: 1,
    registered_dependency: true,
  });
  manifest.evidence_fingerprint = sha256Text(`neutral-reference-table\0${originText}\0${targetText}`);
  const sources = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const literal = locateAndRegisterSourceQuote(registry, sources[0]!, "表 T");
  registry = literal.registry;
  const anchorSpanId = literal.spans[0]!.span_id;
  const originSpanId = registry.spans.find((span) => span.evidence_id === manifest.evidence[0]!.evidence_id
    && span.start === 0 && span.end === originText.length)!.span_id;
  const targetSpanId = registry.spans.find((span) => span.evidence_id === "atom:neutral-reference-table-row"
    && span.start === 0 && span.end === targetText.length)!.span_id;
  manifest.reference_occurrences.push({
    occurrence_id: "reference:neutral-table-t",
    origin_evidence_id: manifest.evidence[0]!.evidence_id,
    origin_span_id: originSpanId,
    reference_literal_span_id: anchorSpanId,
    reference_literal: { evidence_id: manifest.evidence[0]!.evidence_id, start: originText.indexOf("表 T"), end: originText.indexOf("表 T") + "表 T".length },
    origin_fields: ["method"],
    raw_reference: "表 T",
    relation: "中性表格引用",
    target_evidence_ids: ["atom:neutral-reference-table-row"],
    required: true,
    status: "resolved",
    depth: 1,
    path: ["source:table:T"],
    reference_kind: "table",
    target_table_id: "T",
    target_address: { source_id: "source", locator_kind: "table", locator: "table:T" },
  });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "neutral-lot", name: "中性检验批", scope_span_ids: [originSpanId], reason: "中性测试范围" });
  selectors.references.push({
    key: "neutral-table-placeholder",
    occurrence_id: "reference:neutral-table-t",
    anchor_span_ids: [anchorSpanId],
    target_span_ids: [targetSpanId],
    action: "adopt",
    application_mode: "reference_placeholder",
    import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement", "method"], reason: "保留被引表业务事实。" },
    destinations: [],
    reason: "被引内容应由真实业务叶承载。",
  });

  let placeholderIssue: any;
  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected missing referenced-table items");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    placeholderIssue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_placeholder_table_items_missing");
    expect(placeholderIssue).toBeDefined();
  }

  // The same resolved table can supply an existing item's field. Changing an
  // incorrectly chosen application mode must not require inventing table items.
  const receiver = fixture(originText).selectors.items[0]!;
  receiver.lot_key = "neutral-lot";
  receiver.fields.requirement = { composition: "not_applicable", span_ids: [], separator: "", reason: "本地只规定检查方法的引用来源" };
  receiver.fields.method = { composition: "reference", span_ids: [originSpanId], separator: "", reason: "按原文引用被引表中的检查内容" };
  selectors.items = [receiver];
  selectors.references[0] = {
    ...selectors.references[0]!,
    application_mode: "reference_only",
    origin_binding: { item_key: receiver.key, target_field: "method" },
    import_scope: { mode: "field_specific", allowed_fields: ["method"], reason: "只向原文指明的检查方法字段提供内容" },
    destinations: [{ item_key: receiver.key, target_field: "method" }],
  };
  const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
  const validation = validatePlanText(JSON.stringify(compiled), manifest);
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
  expect(hydrateSemanticSourcePlan(compiled, manifest).acceptance_items).toHaveLength(1);
  expect(selectors.items[0]!.table).toBeNull();
  expect(selectors.references[0]!.target_span_ids).toEqual([targetSpanId]);

  const withoutDestination = structuredClone(selectors);
  withoutDestination.references[0]!.destinations = [];
  try {
    compileTargetSelectorsPersisted(withoutDestination, registry, manifest);
    throw new Error("changing mode alone must not bypass the real receiver route");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_reference_destination_required" }),
    ]));
  }

  expect(placeholderIssue).toMatchObject({
    path: "/references/0/target_span_ids",
    details: {
        actual: { reference_key: "neutral-table-placeholder", application_mode: "reference_placeholder", target_table_id: "T", table_is_materialized: false },
        allowed_actions: expect.arrayContaining([expect.stringContaining("已经存在"), expect.stringContaining("新增"), expect.stringContaining("reference_only")]),
        writable_paths: expect.arrayContaining(["/items", "/references/0/component_dispositions", "/references/0/application_mode", "/references/0/destinations", "/references/0/origin_binding", "/references/0/import_scope"]),
        writable_collections: ["items", "references", "sampling_rules", "lots", "source_dispositions"],
        candidate_read_tools: expect.arrayContaining(["read_reference_facts", "read_document_reference_evidence", "read_table_rows"]),
        next_tool: "read_target_selectors",
        next_tools: expect.arrayContaining(["read_reference_facts", "read_document_reference_evidence", "stage_target_selector_draft"]),
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("analysis_mode"),
    },
  });
  expect(placeholderIssue.details.allowed_actions.join("\n")).not.toMatch(/不适用|skip/iu);
});

test.each([false, true])("partial referenced-table rows keep confirmed header roles (continued=%s)", continued => {
  const originText = "本项检查见表 R。";
  const rows = ["项目甲 | 指标甲", "项目乙 | 指标乙"];
  const manifest = manifestFor(originText);
  for (const [index, text] of rows.entries()) {
    manifest.evidence.push({
      evidence_id: `atom:neutral-table-r-row-${index + 1}`,
      kind: "table_row",
      role: "context",
      locator: `table:R/row:${index + 1}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: false,
      evidence_scope: "reference",
      table_row_kind: "data",
      table_id: "R",
      row_index: index + 1,
      registered_dependency: true,
    });
  }
  manifest.evidence_fingerprint = sha256Text(`neutral-reference-table-rows\0${originText}\0${rows.join("\0")}`);
  const sources = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const registered = locateAndRegisterSourceQuote(registry, sources[0]!, "表 R");
  registry = registered.registry;
  const fullSpan = (evidenceId: string): string => registry.spans.find((span) =>
    span.evidence_id === evidenceId && span.start === 0 && span.end === manifest.evidence.find((evidence) => evidence.evidence_id === evidenceId)!.text.length
  )!.span_id;
  const originSpanId = fullSpan(manifest.evidence[0]!.evidence_id);
  const rowSpanIds = [fullSpan("atom:neutral-table-r-row-1"), fullSpan("atom:neutral-table-r-row-2")];
  manifest.reference_occurrences.push({
    occurrence_id: "reference:neutral-table-r",
    origin_evidence_id: manifest.evidence[0]!.evidence_id,
    origin_span_id: originSpanId,
    reference_literal_span_id: registered.spans[0]!.span_id,
    reference_literal: { evidence_id: manifest.evidence[0]!.evidence_id, start: originText.indexOf("表 R"), end: originText.indexOf("表 R") + 3 },
    origin_fields: ["requirement"],
    raw_reference: "表 R",
    relation: "中性表格引用",
    target_evidence_ids: ["atom:neutral-table-r-row-1", "atom:neutral-table-r-row-2"],
    required: true,
    status: "resolved",
    depth: 1,
    path: ["source:table:R"],
    reference_kind: "table",
    target_table_id: "R",
    target_address: { source_id: "source", locator_kind: "table", locator: "table:R" },
  });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "neutral-lot", name: "中性检验批", scope_span_ids: [originSpanId], reason: "中性测试范围" });
  selectors.items.push({
    ...structuredClone(fixture().selectors.items[0]!),
    key: "first-row",
    lot_key: "neutral-lot",
    criterion_span_ids: [rowSpanIds[0]!],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [rowSpanIds[0]!], separator: "", reason: "第一行检查属性" },
      requirement: { composition: "verbatim", span_ids: [rowSpanIds[0]!], separator: "", reason: "第一行检查要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给备注" },
    },
    inspection_data_type_span_ids: [rowSpanIds[0]!],
    table: {
      source_kind: "direct",
      table_key: "R",
      properties: {
        table_no_span_ids: [registered.spans[0]!.span_id],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[rowSpanIds[0]!]],
        column_path_span_ids: [[rowSpanIds[0]!]],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [rowSpanIds[0]!],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "第一行真实业务叶",
    },
  });
  selectors.references.push({
    key: "neutral-table-r",
    occurrence_id: "reference:neutral-table-r",
    anchor_span_ids: [registered.spans[0]!.span_id],
    target_span_ids: rowSpanIds,
    action: "adopt",
    application_mode: "reference_only",
    import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement"], reason: "保留被引表业务事实。" },
    destinations: [],
    reason: "待核对被引表接收关系。",
  });

  let issue: any;
  let issueCodes: string[] = [];
  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected a receiver issue for partially materialized table");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    issueCodes = (error as TargetSelectorCompileError).issues.map((row) => row.code);
    issue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_destination_required");
  }
  expect(issue, issueCodes.join(", ")).toMatchObject({
    details: {
      uncovered_target_data_row_count: 1,
      uncovered_target_data_row_evidence_ids: ["atom:neutral-table-r-row-2"],
      writable_paths: expect.arrayContaining(["/references/0/destinations", "/items"]),
      writable_collections: ["references", "items", "source_dispositions"],
      context_reference_alternative: { expected: { origin_context_coverage: "all_complete_and_explicit", business_origin_bindings: [] } },
      candidate_read_tools: expect.arrayContaining(["list_reference_occurrences", "read_reference_facts", "read_document_reference_evidence", "read_table_rows", "read_target_selectors"]),
      next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: 0, limit: 100 },
      save_tool: "stage_target_selector_draft",
      how_to_pass: expect.stringContaining("draft.items 与 draft.references"),
    },
  });
  expect(issue.details).not.toHaveProperty("placeholder_values");
  expect(actionableSelectorIssue(classifySelectorIssue("selector-local", issue))).toMatchObject({
    next_tool: "list_reference_occurrences",
    next_tool_arguments: { cursor: 0, limit: 100 },
    save_tool: "stage_target_selector_draft",
  });

  selectors.references[0]!.application_mode = "reference_placeholder";
  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected a partial table placeholder issue");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_reference_placeholder_table_items_missing",
        details: expect.objectContaining({
          uncovered_target_data_row_count: 1,
          uncovered_target_data_row_evidence_ids: ["atom:neutral-table-r-row-2"],
        }),
      }),
    ]));
  }

  // A continuation's second header level may be labelled data by the parser.
  // Only the confirmed author's structure can supply its actual row role.
  const captionId = "atom:neutral-table-r-caption";
  const headerId = "atom:neutral-table-r-repeated-header";
  manifest.evidence.push({
    ...manifest.evidence[1]!, evidence_id: captionId, kind: "paragraph", role: "formal_table_title",
    text: "表 R 中性检验", text_sha256: sha256Text("表 R 中性检验"), table_fragment_id: "fragment:r",
  }, {
    ...manifest.evidence[1]!, evidence_id: headerId,
    requires_disposition: true,
    text: "分类甲 | 分类乙", text_sha256: sha256Text("分类甲 | 分类乙"), table_fragment_id: "fragment:r",
  });
  manifest.table_fragments = [{ fragment_id: "fragment:r", source_order: 1, locator: "table:R",
    provisional_table_id: "R", provisional_title: "表 R 中性检验",
    title_candidate_evidence_ids: [captionId], header_evidence_ids: [],
    row_evidence_ids: ["atom:neutral-table-r-row-1", "atom:neutral-table-r-row-2", headerId],
    formal_row_evidence_ids: [], columns: [],
  }];
  if (continued) {
    manifest.table_fragments[0]!.row_evidence_ids = ["atom:neutral-table-r-row-1"];
    manifest.table_fragments.push({ ...manifest.table_fragments[0]!, fragment_id: "fragment:r-continuation", source_order: 2,
      provisional_table_id: "", provisional_title: "", title_candidate_evidence_ids: [],
      row_evidence_ids: ["atom:neutral-table-r-row-2", headerId],
    });
    manifest.evidence.find(row => row.evidence_id === headerId)!.table_fragment_id = "fragment:r-continuation";
  }
  manifest.evidence_fingerprint = sha256Text("neutral-confirmed-row-roles");
  registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
    source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
  })));
  registry = locateAndRegisterSourceQuote(registry, sources[0]!, "表 R").registry;
  manifest.reference_occurrences[0]!.target_evidence_ids.push(headerId);
  const secondItem = structuredClone(selectors.items[0]!);
  secondItem.key = "second-row";
  secondItem.name = "项目乙";
  secondItem.criterion_span_ids = [rowSpanIds[1]!];
  secondItem.inspection_data_type_span_ids = [rowSpanIds[1]!];
  secondItem.fields.name.span_ids = secondItem.fields.requirement.span_ids = [rowSpanIds[1]!];
  secondItem.table!.properties.row_path_span_ids = secondItem.table!.properties.column_path_span_ids = [[rowSpanIds[1]!]];
  secondItem.table!.properties.allowed_value_span_ids = [rowSpanIds[1]!];
  selectors.items[0]!.name = "项目甲";
  selectors.items.push(secondItem);
  for (const item of selectors.items) item.table!.properties.table_title_span_ids = [fullSpan(captionId)];
  const structure = initialTableStructurePlan(manifest, registry);
  structure.tables = [structure.tables[0]!];
  Object.assign(structure.tables[0]!, { status: "confirmed", data_rows: ["atom:neutral-table-r-row-1", "atom:neutral-table-r-row-2"],
    fragment_ids: manifest.table_fragments.map(fragment => fragment.fragment_id),
    repeated_header_rows: [headerId], review_rows: [], reason: "原文给出两条数据行和一条续表分类标题。",
    row_role_overrides: [{ row_id: headerId, program_hint: "data_candidate", selected_role: "repeated_header", reason: "续表分类列标题。" }],
  });
  expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
  const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan: structure });
  expect(compiled.table_assembly.logical_tables[0]!.row_roles).toContainEqual({ evidence_id: headerId, role: "repeated_header", reason: "续表分类列标题。" });
  expect(compiled.table_assembly.logical_tables[0]!.evidence_ids).toContain(headerId);
  expect(compiled.evidence_dispositions).toContainEqual(expect.objectContaining({
    evidence_id: headerId, disposition: "used", item_ids: expect.arrayContaining(compiled.acceptance_items.map(item => item.item_id)),
  }));
  expect(checkTargetCompilerInvariants(selectors, hydrateSemanticSourcePlan(compiled, manifest), manifest)).toEqual([]);
  expect(validatePlanText(JSON.stringify(compiled), manifest).issues).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_placeholder_table_leaf_missing" }),
  ]));
  expect(validatePlanText(JSON.stringify(compiled), manifest).ok).toBe(true);
  // A second reader may register a cell-expanded view of the same physical
  // table, sharing its title evidence but using different row identities.
  // The selected rows determine which view owns the logical table.
  const aliasManifest = structuredClone(manifest);
  const originalFragment = aliasManifest.table_fragments[0]!;
  const aliasFragment = structuredClone(originalFragment);
  aliasFragment.fragment_id = "fragment:cell-expanded-alias";
  const aliasRows = originalFragment.row_evidence_ids.map(id => {
    const row = structuredClone(aliasManifest.evidence.find(record => record.evidence_id === id)!);
    row.evidence_id = `${id}:cell-expanded`;
    row.table_fragment_id = aliasFragment.fragment_id;
    row.requires_disposition = false;
    return row;
  });
  aliasFragment.row_evidence_ids = aliasRows.map(row => row.evidence_id);
  aliasFragment.header_evidence_ids = [];
  aliasFragment.formal_row_evidence_ids = [];
  aliasManifest.evidence.push(...aliasRows);
  aliasManifest.table_fragments.push(aliasFragment);
  const aliasCompiled = compileTargetSelectorsPersisted(selectors, registry, aliasManifest, { tableStructurePlan: structure });
  expect(aliasCompiled.table_assembly.logical_tables[0]!.fragment_ids).toEqual(compiled.table_assembly.logical_tables[0]!.fragment_ids);
  expect(aliasCompiled.table_assembly.logical_tables[0]!.row_roles).toEqual(compiled.table_assembly.logical_tables[0]!.row_roles);
  expect(checkTargetCompilerInvariants(selectors, hydrateSemanticSourcePlan(aliasCompiled, aliasManifest), aliasManifest)).toEqual([]);
  const otherLocation = structuredClone(aliasManifest);
  otherLocation.table_fragments.at(-1)!.locator = "table:R/continuation";
  expect(compileTargetSelectorsPersisted(selectors, registry, otherLocation, { tableStructurePlan: structure })
    .table_assembly.logical_tables[0]!.fragment_ids).toContain(aliasFragment.fragment_id);
  const selectedAlias = structuredClone(aliasManifest);
  selectedAlias.table_fragments.at(-1)!.row_evidence_ids.push(originalFragment.row_evidence_ids[0]!);
  expect(compileTargetSelectorsPersisted(selectors, registry, selectedAlias, { tableStructurePlan: structure })
    .table_assembly.logical_tables[0]!.fragment_ids).toContain(aliasFragment.fragment_id);
  const legacySelectors = structuredClone(selectors);
  legacySelectors.items[0]!.table!.properties.condition_span_ids.push(fullSpan(headerId));
  legacySelectors.items[0]!.fields.requirement.span_ids.push(fullSpan(headerId));
  const historicalStructure = structuredClone(structure);
  Object.assign(historicalStructure.tables[0]!, { data_rows: [], repeated_header_rows: [],
    context_rows: [...structure.tables[0]!.data_rows, headerId],
    row_role_overrides: [...structure.tables[0]!.data_rows, headerId].map(row_id => ({
      row_id, program_hint: "data_candidate", selected_role: "context", reason: "历史结构决定的上下文角色。",
    })),
  });
  const currentContext = createSelectorCompilerContext({ manifest, selectors: legacySelectors, tableStructurePlan: historicalStructure,
    eligibleTableEvidenceIds: new Set(manifest.evidence.map(row => row.evidence_id)), acceptedSourceLanguageReviews: [], acceptedVerdictNameReviews: [] });
  expect(currentContext.confirmed_table_row_roles).toBe(true);
  const historicalContext = structuredClone(currentContext);
  delete historicalContext.confirmed_table_row_roles;
  const historicalReplay = compileTargetSelectorsWithContext(legacySelectors, registry, manifest, historicalContext);
  expect(historicalReplay.table_assembly.logical_tables[0]).not.toHaveProperty("row_roles");
  expect(validatePlanText(JSON.stringify(historicalReplay), manifest).ok).toBe(true);
  expect(() => compileTargetSelectorsWithContext(legacySelectors, registry, manifest, currentContext)).toThrow(TargetSelectorCompileError);
  const missingLeaf = structuredClone(compiled);
  missingLeaf.acceptance_items.pop();
  expect(validatePlanText(JSON.stringify(missingLeaf), manifest).issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_placeholder_table_leaf_missing", details: expect.objectContaining({ uncovered_data_row_evidence_ids: ["atom:neutral-table-r-row-2"] }) }),
  ]));
  for (const mode of ["missing", "foreign", "duplicate"] as const) {
    const invalid = structuredClone(compiled);
    const roles = invalid.table_assembly.logical_tables[0]!.row_roles!;
    if (mode === "missing") roles.pop();
    if (mode === "foreign") roles[0]!.evidence_id = manifest.evidence[0]!.evidence_id;
    if (mode === "duplicate") roles.push(roles[0]!);
    expect(validatePlanText(JSON.stringify(invalid), manifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_assembly_row_roles_invalid" }),
    ]));
  }
});

test("multi-receiver local-requirement feedback stays compact and exposes ordered read and save routes", () => {
  const originText = "构件应稳固；具体做法见第 R 节。";
  const targetText = "连接部位应紧固。";
  const prepared = fixture(originText);
  const { manifest, selectors } = prepared;
  manifest.evidence.push({
    evidence_id: "atom:neutral-reference-clause",
    kind: "paragraph",
    role: "context",
    locator: "clause:R",
    text: targetText,
    text_sha256: sha256Text(targetText),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  });
  manifest.evidence_fingerprint = sha256Text(`neutral-reference-clause\0${originText}\0${targetText}`);
  const sources = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const literal = locateAndRegisterSourceQuote(registry, sources[0]!, "第 R 节");
  registry = literal.registry;
  const anchorSpanId = literal.spans[0]!.span_id;
  const originSpanId = registry.spans.find((span) => span.evidence_id === manifest.evidence[0]!.evidence_id
    && span.start === 0 && span.end === originText.length)!.span_id;
  const targetSpanId = registry.spans.find((span) => span.evidence_id === "atom:neutral-reference-clause"
    && span.start === 0 && span.end === targetText.length)!.span_id;
  selectors.lots[0]!.scope_span_ids = [originSpanId];
  selectors.items[0]!.criterion_span_ids = [originSpanId];
  selectors.items[0]!.fields.name.span_ids = [originSpanId];
  selectors.items[0]!.fields.requirement.span_ids = [originSpanId];
  selectors.items[0]!.inspection_data_type_span_ids = [originSpanId];
  manifest.reference_occurrences.push({
    occurrence_id: "reference:neutral-clause-r",
    origin_evidence_id: manifest.evidence[0]!.evidence_id,
    origin_span_id: originSpanId,
    reference_literal_span_id: anchorSpanId,
    reference_literal: { evidence_id: manifest.evidence[0]!.evidence_id, start: originText.indexOf("第 R 节"), end: originText.indexOf("第 R 节") + "第 R 节".length },
    origin_fields: ["requirement"],
    raw_reference: "第 R 节",
    relation: "中性条款引用",
    target_evidence_ids: ["atom:neutral-reference-clause"],
    required: true,
    status: "resolved",
    depth: 1,
    path: ["source:clause:R"],
    reference_kind: "clause",
    target_address: { source_id: "source", locator_kind: "clause", locator: "clause:R" },
  });
  selectors.references.push({
    key: "neutral-clause-placeholder",
    occurrence_id: "reference:neutral-clause-r",
    anchor_span_ids: [anchorSpanId],
    target_span_ids: [targetSpanId],
    action: "adopt",
    application_mode: "reference_placeholder",
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "保留条款要求来源。" },
    destinations: [],
    reason: "构造含本地要求的占位反馈。",
  });
  const receiverKeys = Array.from({ length: 7 }, (_, index) => `neutral-receiver-${index + 1}`);
  selectors.items = receiverKeys.map((key) => {
    const item = structuredClone(selectors.items[0]!);
    item.key = key;
    item.fields.requirement.composition = "reference";
    return item;
  });

  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected local requirement placeholder issue");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    const issue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_placeholder_local_requirement") as any;
    expect(issue).toMatchObject({
      path: "/references/0/application_mode",
      details: {
        local_criterion_bindings: expect.arrayContaining(receiverKeys.map((item_key, item_index) =>
          expect.objectContaining({ item_key, item_index })
        )),
        writable_collections: ["references", "items"],
        allowed_actions: [expect.any(String), expect.any(String)],
        candidate_read_tools: expect.arrayContaining([
          "read_reference_facts",
          "read_document_reference_evidence",
          "open_evidence",
          "locate_evidence_span",
        ]),
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "neutral-clause-placeholder" },
        next_tools: expect.arrayContaining(["read_reference_facts", "read_document_reference_evidence", "stage_target_selector_draft"]),
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringMatching(/item_key.*read_target_selectors.*collection=items.*isolated.*read_reference_facts.*inline.*read_document_reference_evidence/u),
      },
    });
    expect(issue.details.local_criterion_bindings).toHaveLength(receiverKeys.length);
    expect(issue.details.allowed_actions).toHaveLength(2);
    expect(issue.details.writable_paths).toEqual(expect.arrayContaining([
      "/references/0/application_mode",
      "/references/0/destinations",
      "/references/0/import_scope",
    ]));
    const receiverSummaries = issue.details.actual.current_receiver_fields;
    expect(receiverSummaries).toEqual(receiverKeys.map((item_key, item_index) => ({
      item_key,
      item_index,
      readable_path: `/items/${item_index}`,
    })));
    for (const receiver of receiverSummaries) {
      expect(receiver).not.toHaveProperty("criterion_span_ids");
      expect(receiver).not.toHaveProperty("continuation_span_ids");
      expect(receiver).not.toHaveProperty("fields");
      expect(receiver).not.toHaveProperty("table");
      expect(receiver).not.toHaveProperty("sampling");
    }
    for (const itemIndex of receiverKeys.keys()) {
      expect(issue.details.writable_paths).toEqual(expect.arrayContaining([
        `/items/${itemIndex}/criterion_span_ids`,
        `/items/${itemIndex}/continuation_span_ids`,
        `/items/${itemIndex}/fields`,
        `/items/${itemIndex}/sampling`,
      ]));
    }
    expect(Buffer.byteLength(JSON.stringify(issue), "utf8")).toBeLessThan(24 * 1024);
    expect(issue.details.how_to_pass).not.toContain("不要调用 read_reference_facts");
    const compositionIssue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_composition_without_resolve_receipt") as any;
    expect(compositionIssue).toMatchObject({
      path: "/items/0/fields/requirement/composition",
      details: {
        allowed_actions: [expect.stringContaining("semantic_summary 仅适用于 name"), expect.any(String), expect.any(String)],
      },
    });
    expect(compositionIssue.details.allowed_actions[0]).not.toContain("verbatim 或 semantic_summary");
    const coverageIssue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_placeholder_target_uncovered") as any;
    expect(coverageIssue).toMatchObject({
      path: "/references/0/target_span_ids",
      details: {
        writable_collections: ["references", "items", "sampling_rules", "lots", "source_dispositions"],
        candidate_read_tool: "list_reference_occurrences",
        candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_reference_occurrences"]),
        next_tool: "list_reference_occurrences",
        next_tool_arguments: { cursor: 0, limit: 100 },
        next_tools: expect.arrayContaining(["read_target_selectors", "stage_target_selector_draft"]),
        save_tool: "stage_target_selector_draft",
      },
    });
  }
});

test("field-role preflight accepts multiline method and quantity blocks without admitting neighboring roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-multiline-roles-"));
  try {
    const lines = [
      "3.1.1 中性装置应固定牢固。",
      "检验方法：",
      "1 操作检查。",
      "并核对返回状态。",
      "2 检查记录。",
      "检查数量：",
      "每批抽取两个装置。",
      "不同规格分别计数。",
      "表 3.1.1 装置分类",
      "<table><tr><td>其他数据</td></tr></table>",
      "3.1.2 其他装置应标识清晰。",
      "检验方法：观察。",
      "## 3.2 其他范围",
      "后续内容。",
    ];
    const markdown = lines.join("\n");
    const manifest = manifestFor(markdown);
    manifest.evidence = lines.map((text, index) => ({
      evidence_id: `neutral-line:${index + 1}`, kind: "paragraph", role: "supporting_clause",
      locator: `line:${index + 1}`, text, text_sha256: sha256Text(text),
      requires_disposition: true, evidence_scope: "primary",
    }));
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const span = (line: number) => registry.spans.find(entry => entry.evidence_id === `neutral-line:${line}`)!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots = [{ key: "lot", name: "中性装置", scope_span_ids: [span(1)], reason: "源条款范围" }];
    const item = structuredClone(fixture().selectors.items[0]!);
    Object.assign(item, { key: "device", lot_key: "lot", name: "中性装置固定", criterion_span_ids: [span(1)], inspection_data_type_span_ids: [span(1)] });
    item.fields.name.span_ids = [span(1)];
    item.fields.requirement.span_ids = [span(1)];
    item.fields.method = { composition: "verbatim", span_ids: [span(3), span(4), span(5)], separator: "\n", reason: "完整方法步骤" };
    item.fields.quantity = { composition: "verbatim", span_ids: [span(7), span(8)], separator: "\n", reason: "完整数量依据" };
    selectors.items = [item];
    const ledger = scanDocumentLedger(markdown, "neutral.md");
    expect(ledger.clauses[0]!.field_role_ranges).toEqual([
      { role: "method", start_line: 2, end_exclusive_line: 6 },
      { role: "quantity", start_line: 6, end_exclusive_line: 9 },
    ]);
    expect(ledger.clauses[1]!.field_role_ranges).toEqual([
      { role: "method", start_line: 12, end_exclusive_line: 13 },
    ]);
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry));
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, prettyJson(ledger));
    const controller = await ToolController.create(workspace);
    const stage = () => controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
    const valid = await stage();
    expect(valid.ok).toBe(true);
    expect(valid).toHaveProperty("local_validation");
    const roleIssues = (reply: Record<string, unknown>) => ((reply.model_review as { observations?: Array<{ code: string; path: string; details: unknown }> })?.observations ?? [])
      .filter(issue => issue.code === "selector_field_clause_line_mismatch");
    expect(roleIssues(valid)).toEqual([]);
    item.fields.method.span_ids = [span(1), span(7), span(12), span(14)];
    item.fields.quantity.span_ids = [span(3), span(9), span(10)];
    const invalid = await stage();
    expect(roleIssues(invalid)).toHaveLength(7);
    expect(roleIssues(invalid)[0]).toMatchObject({ details: {
      expected_line_ranges: [{ role: "method", start_line: 2, end_exclusive_line: 6 }],
      expected_candidates: expect.arrayContaining([expect.objectContaining({ text: lines[3], span_ids: [span(4)] })]),
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing current-request quote aliases offer an executable retry and preserve unrelated records", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-alias-recovery-"));
  try {
    const { manifest, selectors } = fixture();
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    const evidence_id = manifest.evidence[0]!.evidence_id;
    await controller.dispatch("open_evidence", { evidence_id });
    const patch = { draft: { lots: [{ ...selectors.lots[0]!, scope_span_ids: ["$scope"] }] } };
    const bindings = [{ key: "$scope", evidence_id, quote: manifest.evidence[0]!.text }];
    expect(await controller.dispatch("stage_target_selector_draft", { ...patch, quote_bindings: bindings })).toMatchObject({ ok: true });
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const rejected = await controller.dispatch("stage_target_selector_draft", patch) as any;
    expect(rejected).toMatchObject({ ok: false, durable_mutation: false, quote_binding_scope: "current_request",
      quote_binding_summary: { defined_keys: [], resolved_keys: [] }, next_tool: "stage_target_selector_draft",
      selector_issues: [expect.objectContaining({ path: "/draft/lots/0/scope_span_ids/0", key: "$scope",
        actual: { alias: "$scope", binding_status: "missing", definition_path: "/quote_bindings" },
        writable_paths: ["/quote_bindings", "/draft/lots/0/scope_span_ids/0"], next_tool: "stage_target_selector_draft" })] });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    expect(await controller.dispatch(rejected.next_tool, { ...patch, quote_bindings: bindings })).toMatchObject({ ok: true });
    const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(saved.items).toEqual(JSON.parse(before).items);
    expect(saved.lots[0].scope_span_ids[0]).toMatch(/^span:[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unresolved quote alias identifies its failed definition and does not persist sibling bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-alias-unresolved-"));
  try {
    const { manifest, selectors } = fixture();
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) });
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    const controller = await ToolController.create(workspace);
    const evidence_id = manifest.evidence[0]!.evidence_id;
    await controller.dispatch("open_evidence", { evidence_id });
    const patch = { draft: { lots: [{ ...selectors.lots[0]!, scope_span_ids: ["$scope", "$method"] }] },
      quote_bindings: [{ key: "$scope", evidence_id, quote: "基层表面应平整、密实。", suffix: "原文不存在的后文" },
        { key: "$method", evidence_id, quote: "检验方法：用2m靠尺检查。" }] };
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
    const rejected = await controller.dispatch("stage_target_selector_draft", patch) as any;
    expect(rejected).toMatchObject({ ok: false, durable_mutation: false,
      quote_binding_summary: { defined_keys: ["$scope", "$method"], resolved_keys: ["$method"] } });
    expect(rejected.selector_issues).toContainEqual(expect.objectContaining({ key: "$scope", error: "quote_binding_unknown",
      actual: { alias: "$scope", binding_status: "unresolved", definition_path: "/quote_bindings/0" },
      writable_paths: ["/quote_bindings/0", "/draft/lots/0/scope_span_ids/0"] }));
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    const corrected = { ...patch, quote_bindings: patch.quote_bindings.map(({ suffix: _suffix, ...binding }) => binding) };
    expect(await controller.dispatch(rejected.next_tool, corrected)).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual(JSON.parse(before).items);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial referenced-table rows do not advertise an empty-destination placeholder", () => {
  const originText = "本项检查见表 R。";
  const rows = ["项目甲 | 指标甲", "项目乙 | 指标乙"];
  const manifest = manifestFor(originText);
  for (const [index, text] of rows.entries()) {
    manifest.evidence.push({
      evidence_id: `atom:neutral-table-r-row-${index + 1}`,
      kind: "table_row",
      role: "context",
      locator: `table:R/row:${index + 1}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: false,
      evidence_scope: "reference",
      table_row_kind: "data",
      table_id: "R",
      row_index: index + 1,
      registered_dependency: true,
    });
  }
  manifest.evidence_fingerprint = sha256Text(`neutral-reference-table-rows\0${originText}\0${rows.join("\0")}`);
  const sources = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const registered = locateAndRegisterSourceQuote(registry, sources[0]!, "表 R");
  registry = registered.registry;
  const fullSpan = (evidenceId: string): string => registry.spans.find((span) =>
    span.evidence_id === evidenceId && span.start === 0 && span.end === manifest.evidence.find((evidence) => evidence.evidence_id === evidenceId)!.text.length
  )!.span_id;
  const originSpanId = fullSpan(manifest.evidence[0]!.evidence_id);
  const rowSpanIds = [fullSpan("atom:neutral-table-r-row-1"), fullSpan("atom:neutral-table-r-row-2")];
  manifest.reference_occurrences.push({
    occurrence_id: "reference:neutral-table-r",
    origin_evidence_id: manifest.evidence[0]!.evidence_id,
    origin_span_id: originSpanId,
    reference_literal_span_id: registered.spans[0]!.span_id,
    reference_literal: { evidence_id: manifest.evidence[0]!.evidence_id, start: originText.indexOf("表 R"), end: originText.indexOf("表 R") + 3 },
    origin_fields: ["requirement"],
    raw_reference: "表 R",
    relation: "中性表格引用",
    target_evidence_ids: ["atom:neutral-table-r-row-1", "atom:neutral-table-r-row-2"],
    required: true,
    status: "resolved",
    depth: 1,
    path: ["source:table:R"],
    reference_kind: "table",
    target_table_id: "R",
    target_address: { source_id: "source", locator_kind: "table", locator: "table:R" },
  });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "neutral-lot", name: "中性检验批", scope_span_ids: [originSpanId], reason: "中性测试范围" });
  selectors.items.push({
    ...structuredClone(fixture().selectors.items[0]!),
    key: "first-row",
    lot_key: "neutral-lot",
    criterion_span_ids: [rowSpanIds[0]!],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [rowSpanIds[0]!], separator: "", reason: "第一行检查属性" },
      requirement: { composition: "verbatim", span_ids: [rowSpanIds[0]!], separator: "", reason: "第一行检查要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给备注" },
    },
    inspection_data_type_span_ids: [rowSpanIds[0]!],
    table: {
      source_kind: "direct",
      table_key: "R",
      properties: {
        table_no_span_ids: [registered.spans[0]!.span_id],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[rowSpanIds[0]!]],
        column_path_span_ids: [[rowSpanIds[0]!]],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [rowSpanIds[0]!],
        inspection_method_span_ids: [],
      },
      reference_span_ids: [],
      reason: "第一行真实业务叶",
    },
  });
  selectors.references.push({
    key: "neutral-table-r",
    occurrence_id: "reference:neutral-table-r",
    anchor_span_ids: [registered.spans[0]!.span_id],
    target_span_ids: rowSpanIds,
    action: "adopt",
    application_mode: "reference_only",
    import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement"], reason: "保留被引表业务事实。" },
    destinations: [],
    reason: "待核对被引表接收关系。",
  });

  let issue: any;
  let issueCodes: string[] = [];
  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected a receiver issue for partially materialized table");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    issueCodes = (error as TargetSelectorCompileError).issues.map((row) => row.code);
    issue = (error as TargetSelectorCompileError).issues.find((row) => row.code === "selector_reference_destination_required");
  }
  expect(issue, issueCodes.join(", ")).toMatchObject({
    details: {
      uncovered_target_data_row_count: 1,
      uncovered_target_data_row_evidence_ids: ["atom:neutral-table-r-row-2"],
      writable_paths: expect.arrayContaining(["/references/0/destinations", "/items"]),
      writable_collections: ["references", "items", "source_dispositions"],
      candidate_read_tools: expect.arrayContaining(["list_reference_occurrences", "read_reference_facts", "read_document_reference_evidence", "read_table_rows", "read_target_selectors"]),
      next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: 0, limit: 100 },
      save_tool: "stage_target_selector_draft",
      how_to_pass: expect.stringContaining("draft.items 与 draft.references"),
    },
  });
  expect(issue.details).not.toHaveProperty("placeholder_values");
  expect(actionableSelectorIssue(classifySelectorIssue("selector-local", issue))).toMatchObject({
    next_tool: "list_reference_occurrences",
    next_tool_arguments: { cursor: 0, limit: 100 },
    save_tool: "stage_target_selector_draft",
  });

  selectors.references[0]!.application_mode = "reference_placeholder";
  try {
    compileTargetSelectorsPersisted(selectors, registry, manifest);
    throw new Error("expected a partial table placeholder issue");
  } catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_reference_placeholder_table_items_missing",
        details: expect.objectContaining({
          uncovered_target_data_row_count: 1,
          uncovered_target_data_row_evidence_ids: ["atom:neutral-table-r-row-2"],
        }),
      }),
    ]));
  }
});
import { TARGET_SELECTOR_PROTOCOLS, LEGACY_COVERAGE_PROTOCOL } from "../src/acceptance-prompt-suite.js";
