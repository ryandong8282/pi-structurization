import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import { Check } from "typebox/value";

import { sha256Json, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { CoverageReviewController } from "../src/coverage-review.js";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import { buildGranularProseCoverageEvidence, buildStructuredTargetEvidence } from "../src/evidence.js";
import {
  evidenceRequiresSelectorDisposition,
  selectorDispositionCoverage,
} from "../src/evidence-disposition-coverage.js";
import { actionableSelectorIssue, createPiTools, ToolController, validFixturePlan } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { classifyCompilerInvariantIssues } from "../src/selector-issue-ownership.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";

const roots: string[] = [];

test.each([80, 0.5])("invalid direct evidence window cursor %s returns exact bounds and a source-scoped reader without mutation", async cursor => {
  const fixture = await routingFixture();
  const { workspace, controller, directEvidenceId } = fixture;
  const stateBefore = await workspace.readState();
  const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const result = await controller.dispatch("open_evidence", { evidence_id: directEvidenceId, cursor }) as any;
  expect(result).toMatchObject({ ok: false, terminal: false, error: "invalid_evidence_cursor",
    actual: { evidence_id: directEvidenceId, cursor, window_count: 1 },
    expected: { cursor_unit: "zero_based_text_window_index", integer: true, minimum: 0, maximum: 0, cursor_available: true },
    writable_paths: ["/cursor"], next_tool: "open_evidence", next_tool_arguments: { evidence_id: directEvidenceId, cursor: 0 },
    budget_consumed: false, full_stage_check_performed: false, author_draft_mutation: false });
  expect(result).not.toHaveProperty("text_window");
  const after = await workspace.readState();
  expect(after.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect(after.opened_evidence_window_keys).toEqual(stateBefore.opened_evidence_window_keys);
  expect(after.selector_protocol).toEqual(stateBefore.selector_protocol);
  expect(after.validation_attempts).toBe(stateBefore.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
  const handles = await ModelSourceHandles.open(workspace.root);
  const publicResult = await handles.encode(result) as any;
  expect(JSON.stringify(publicResult)).not.toContain(directEvidenceId);
  expect(publicResult.next_tool_arguments.evidence_id).toMatch(/^e\d+$/u);
  expect(Check(createPiTools(controller).find(tool => tool.name === publicResult.next_tool)!.parameters, publicResult.next_tool_arguments)).toBe(true);
  const decoded = await handles.decodeArguments({ ...publicResult.next_tool_arguments, source_handle_scope: handles.scope });
  const read = await controller.dispatch(publicResult.next_tool, decoded) as any;
  expect(read).toMatchObject({ ok: true, cursor: 0, next_cursor: null,
    text_window: { text: fixture.manifest.evidence.find(row => row.evidence_id === directEvidenceId)!.text } });
});

test("empty evidence has no legal cursor and does not advertise an invalid same-resource retry", async () => {
  const markdown = "中性空来源占位";
  const manifest = manifestFor(markdown, [markdown]);
  manifest.evidence[0]!.text = "";
  const root = await mkdtemp(join(tmpdir(), "empty-evidence-reader-")); roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) });
  const controller = await ToolController.create(workspace), before = await workspace.readState();
  const draft = await readFile(workspace.workingSelectorPath, "utf8"), registry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const result = await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 }) as any;
  expect(result).toMatchObject({ ok: false, error: "invalid_evidence_cursor", actual: { cursor: 0, window_count: 0 },
    expected: { maximum: null, cursor_available: false }, writable_paths: [], next_tool: "list_evidence_resources",
    next_tool_arguments: { cursor: 0 }, budget_consumed: false, author_draft_mutation: false });
  expect(result.instruction).toContain("改成 0 仍不能读取");
  expect(Check(createPiTools(controller).find(tool => tool.name === result.next_tool)!.parameters, result.next_tool_arguments)).toBe(true);
  expect(await controller.dispatch(result.next_tool, result.next_tool_arguments)).toMatchObject({ ok: true });
  expect((await workspace.readState()).opened_evidence_ids).toEqual(before.opened_evidence_ids);
  expect((await workspace.readState()).opened_evidence_window_keys).toEqual(before.opened_evidence_window_keys);
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registry);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  ));
});

function manifestFor(markdown: string, primaryTexts: string[]): EvidenceManifest {
  const sourceSha = sha256Text(markdown);
  const lines = markdown.split("\n");
  const primaryLines = primaryTexts.map((text) => lines.findIndex((line) => line === text) + 1);
  const evidence = buildGranularProseCoverageEvidence(
    markdown,
    sourceSha,
    primaryLines.map((line) => ({ start_line: line, end_exclusive_line: line + 1 })),
  ).map((record) => ({
    ...record,
    ...(record.text.includes("每批") ? { role: "sampling_rule" as const } : {}),
    requires_disposition: true,
  }));
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "evidence-access-routing-job",
    target_id: "target:evidence-access-routing",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "source.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered" as const,
      target_id: "target:evidence-access-routing",
      source_line_count: lines.length,
      selected_start_line: Math.min(...primaryLines),
      selected_end_exclusive_line: Math.max(...primaryLines) + 1,
      selected_heading: "中性访问路由",
      selection_reason: "只验证读取工具的机械分流",
      selected_atom_ids: evidence.map((record) => record.evidence_id),
      target_evidence_fragments: evidence.map((record) => ({
        atom_id: record.evidence_id,
        text: record.text,
      })),
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
  };
  return { ...payload, evidence_fingerprint: sha256Json(payload) };
}

async function routingFixture(withOtherIsolatedTarget = false) {
  const inlineText = "1.1.1 小型规则应抽查一个样本。";
  const isolatedRows = Array.from(
    { length: 26 },
    (_, index) => `2.1.${index + 1} 大型目录规则 ${index + 1} 应抽查一个样本。`,
  );
  const otherIsolatedRows = Array.from(
    { length: 26 },
    (_, index) => `3.1.${index + 1} 次级目录规则 ${index + 1} 应抽查一个样本。`,
  );
  const inlineOrigin = "9.1.1 构件甲应符合本规范第 1.1.1 条的规定。";
  const isolatedOrigin = "9.1.2 构件乙应符合本规范第 2.1 节的规定。";
  const otherIsolatedOrigin = "9.1.4 构件丁应符合本规范第 3.1 节的规定。";
  const directGlobalMarker = "opaque-padding-marker";
  const neutralPadding = `${"z".repeat(6500)}-${directGlobalMarker}`;
  const directText = "9.1.3 构件丙每批应核对一次。";
  const markdown = [
    "# 1 小型规则",
    inlineText,
    "# 2 大型规则",
    "# 2.1 大型目录",
    ...isolatedRows,
    ...(withOtherIsolatedTarget ? ["# 3 次级规则", "# 3.1 次级目录", ...otherIsolatedRows] : []),
    "# 9 当前目标",
    inlineOrigin,
    isolatedOrigin,
    ...(withOtherIsolatedTarget ? [otherIsolatedOrigin] : []),
    neutralPadding,
    directText,
  ].join("\n");
  const manifest = manifestFor(markdown, [
    inlineOrigin,
    isolatedOrigin,
    ...(withOtherIsolatedTarget ? [otherIsolatedOrigin] : []),
    directText,
  ]);
  const root = await mkdtemp(join(tmpdir(), "evidence-access-routing-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const controller = await ToolController.create(workspace);
  const registry = await workspace.readSourceSpanRegistry();
  const originSpan = (text: string) => {
    const record = manifest.evidence.find((entry) => entry.text === text)!;
    return registry.spans.find((span) =>
      span.evidence_id === record.evidence_id
      && span.start === 0
      && span.end === record.text.length
    )!.span_id;
  };
  const inlineReceipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan(inlineOrigin),
    raw_reference: "本规范第 1.1.1 条",
    target: { kind: "clause", number: "1.1.1" },
    relation: "中性小型引用",
  }) as Record<string, any>;
  const isolatedReceipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan(isolatedOrigin),
    raw_reference: "本规范第 2.1 节",
    target: { kind: "section", number: "2.1" },
    relation: "中性大型引用",
  }) as Record<string, any>;
  const otherIsolatedReceipt = withOtherIsolatedTarget
    ? await controller.dispatch("resolve_document_reference", {
        origin_span_id: originSpan(otherIsolatedOrigin),
        raw_reference: "本规范第 3.1 节",
        target: { kind: "section", number: "3.1" },
        relation: "中性次级大型引用",
      }) as Record<string, any>
    : undefined;
  expect(inlineReceipt).toMatchObject({ ok: true, analysis_mode: "inline" });
  expect(isolatedReceipt).toMatchObject({ ok: true, analysis_mode: "isolated" });
  if (otherIsolatedReceipt) {
    expect(otherIsolatedReceipt).toMatchObject({ ok: true, analysis_mode: "isolated" });
  }

  const currentManifest = await workspace.readEvidenceManifest();
  const inlineOccurrence = currentManifest.reference_occurrences.find((entry) =>
    entry.occurrence_id === inlineReceipt.occurrence_id
  )!;
  const isolatedOccurrence = currentManifest.reference_occurrences.find((entry) =>
    entry.occurrence_id === isolatedReceipt.occurrence_id
  )!;
  const otherIsolatedOccurrence = otherIsolatedReceipt
    ? currentManifest.reference_occurrences.find((entry) =>
        entry.occurrence_id === otherIsolatedReceipt.occurrence_id
      )
    : undefined;
  const inlineEvidenceId = inlineOccurrence.target_evidence_ids.find((evidenceId) =>
    currentManifest.evidence.find((entry) => entry.evidence_id === evidenceId)?.text.includes("小型规则")
  )!;
  const isolatedEvidenceId = isolatedOccurrence.target_evidence_ids.find((evidenceId) =>
    currentManifest.evidence.find((entry) => entry.evidence_id === evidenceId)?.text.includes("大型目录规则 1 ")
  )!;
  const secondIsolatedEvidenceId = isolatedOccurrence.target_evidence_ids.find((evidenceId) =>
    currentManifest.evidence.find((entry) => entry.evidence_id === evidenceId)?.text.includes("大型目录规则 2 ")
  )!;
  const otherIsolatedEvidenceId = otherIsolatedOccurrence?.target_evidence_ids.find((evidenceId) =>
    currentManifest.evidence.find((entry) => entry.evidence_id === evidenceId)?.text.includes("次级目录规则 1 ")
  ) ?? "";
  const directEvidenceId = currentManifest.evidence.find((entry) => entry.text === directText)!.evidence_id;
  const isolatedStart = markdown.indexOf(isolatedRows[0]!);
  const isolatedParentAtomId = buildDocumentEvidence(markdown, currentManifest.source.file_name).atoms.find((atom) =>
    atom.start_offset <= isolatedStart && atom.end_offset > isolatedStart
  )!.atom_id;
  return {
    workspace,
    controller,
    manifest: currentManifest,
    inlineText,
    isolatedText: isolatedRows[0]!,
    inlineTargetKey: String(inlineReceipt.target_key),
    isolatedTargetKey: String(isolatedReceipt.target_key),
    otherIsolatedText: otherIsolatedRows[0]!,
    otherIsolatedTargetKey: otherIsolatedReceipt ? String(otherIsolatedReceipt.target_key) : "",
    directGlobalMarker,
    inlineEvidenceId,
    isolatedEvidenceId,
    secondIsolatedEvidenceId,
    otherIsolatedEvidenceId,
    directEvidenceId,
    isolatedParentAtomId,
  };
}

async function adoptedReviewSourceOverlapFixture() {
  const fixture = await routingFixture();
  const source = await readFile(fixture.workspace.sourceMarkdownPath, "utf8");
  const start = source.indexOf(fixture.isolatedText);
  expect(start).toBeGreaterThanOrEqual(0);
  const reviewSourceId = `review-source:${sha256Text(`${fixture.manifest.source.sha256}:${start}:${start + fixture.isolatedText.length}`)}`;
  const adopted = await fixture.workspace.extendEvidenceManifest({
    evidence_id: reviewSourceId,
    kind: "paragraph",
    role: "context",
    locator: `char:${start}-${start + fixture.isolatedText.length}`,
    text: fixture.isolatedText,
    text_sha256: sha256Text(fixture.isolatedText),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  });
  return {
    ...fixture,
    controller: await ToolController.create(fixture.workspace),
    manifest: adopted,
    reviewSourceId,
  };
}

test("current field diagnostics and their cache do not expose isolated reference text or earn source reads", async () => {
  const { workspace, controller, isolatedText, isolatedEvidenceId } = await routingFixture();
  const before = await workspace.readState();
  for (const reused of [false, true]) {
    const response = await controller.dispatch("get_target_context", { field_diagnostic_cursor: 0 });
    expect(response).toMatchObject({ ok: true, diagnostics_reused: reused,
      full_stage_check_performed: false, budget_consumed: false });
    expect(JSON.stringify(response)).not.toContain(isolatedText);
    const after = await workspace.readState();
    expect(after.opened_evidence_ids).toEqual(before.opened_evidence_ids);
    expect(after.opened_evidence_window_keys).toEqual(before.opened_evidence_window_keys);
    expect(after.validation_attempts).toBe(before.validation_attempts);
    expect(after.opened_evidence_ids).not.toContain(isolatedEvidenceId);
  }
});

test("zero-match locator recovery keeps an isolated reference on its catalog reader", async () => {
  const f = await routingFixture();
  const requested = { evidence_id: f.isolatedEvidenceId, quote: "不存在的中性摘录" };
  expect(await f.controller.dispatch("locate_evidence_span", requested))
    .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
  const catalog = await f.controller.dispatch("read_reference_facts", { target_key: f.isolatedTargetKey }) as Record<string, any>;
  expect(catalog.ok).toBe(true);
  const opened = await f.controller.dispatch("read_reference_facts", { target_key: f.isolatedTargetKey,
    entry_ids: [catalog.catalog[0].entry_id] });
  expect(opened.ok).toBe(true);
  expect((await f.workspace.readState()).opened_evidence_ids).toContain(f.isolatedEvidenceId);
  const registry = await f.workspace.readSourceSpanRegistry();
  const state = await f.workspace.readState();
  const rejected = await f.controller.dispatch("locate_evidence_span", requested) as Record<string, any>;
  expect(rejected).toMatchObject({ ok: false, error: "selector_span_not_found", retry_tool: "locate_evidence_span",
    next_tool: "read_reference_facts", next_tool_arguments: { target_key: f.isolatedTargetKey },
    issues: [{ details: { quote_match_count: 0, next_tool: "read_reference_facts",
      next_tool_arguments: { target_key: f.isolatedTargetKey } } }] });
  expect(JSON.stringify(rejected.next_tool_arguments)).not.toContain("evidence_id");
  const tool = createPiTools(f.controller).find(tool => tool.name === rejected.next_tool)!;
  const recovered = await tool.execute("call", rejected.next_tool_arguments, undefined as never, undefined as never);
  expect(recovered.details).toMatchObject({ ok: true, target_key: f.isolatedTargetKey });
  expect(await f.workspace.readSourceSpanRegistry()).toEqual(registry);
  expect((await f.workspace.readState()).validation_attempts).toBe(state.validation_attempts);
  expect((await f.workspace.readState()).selector_protocol).toEqual(state.selector_protocol);
});

async function cumulativeReferenceBudgetFixture() {
  const originId = "evidence:neutral-origin";
  const itemId = "item:neutral";
  const originText = "当前对象依次引用中性目标甲、中性目标乙和中性目标丙，并保留本地条件。";
  const targetSpecs = ["甲", "乙", "丙"].map((label, index) => {
    const text = `中性目标${label}：${"中性正文".repeat(1500)}`;
    return { label, index, evidenceId: `evidence:neutral-target-${index + 1}`, text };
  });
  const duplicateQuery = "中性目标丙：";
  const markdown = [
    originText,
    ...targetSpecs.map((entry) => entry.text),
    "z".repeat(6500),
    targetSpecs[2]!.text,
  ].join("\n");
  const sourceSha = sha256Text(markdown);
  const evidence: EvidenceManifest["evidence"] = [{
    evidence_id: originId,
    kind: "paragraph",
    role: "supporting_clause",
    locator: "line:1",
    text: originText,
    text_sha256: sha256Text(originText),
    requires_disposition: true,
    evidence_scope: "primary",
  }, ...targetSpecs.map((entry) => ({
    evidence_id: entry.evidenceId,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: `line:${entry.index + 2}`,
    text: entry.text,
    text_sha256: sha256Text(entry.text),
    requires_disposition: false,
    evidence_scope: "reference" as const,
    registered_dependency: true,
  }))];
  const referenceOccurrences: EvidenceManifest["reference_occurrences"] = targetSpecs.map((entry) => ({
    occurrence_id: `occurrence:neutral-${entry.index + 1}`,
    origin_evidence_id: originId,
    origin_fields: ["requirement"],
    raw_reference: `中性目标${entry.label}`,
    relation: "中性引用关系",
    target_evidence_ids: [entry.evidenceId],
    required: true,
    status: "resolved",
    depth: 1,
    path: [],
    reference_kind: "clause",
    target_address: {
      source_id: sourceSha,
      locator_kind: "clause",
      locator: `clause:neutral-${entry.index + 1}`,
    },
  }));
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "reference-route-budget-job",
    target_id: "target:reference-route-budget",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "source.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered" as const,
      target_id: "target:reference-route-budget",
      source_line_count: markdown.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "中性累计预算",
      selection_reason: "只验证引用读取路由的累计预算",
      selected_atom_ids: [originId],
      target_evidence_fragments: [{ atom_id: originId, text: originText }],
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: referenceOccurrences,
  };
  const manifest: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const root = await mkdtemp(join(tmpdir(), "reference-route-budget-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const fields = {
    name: "当前对象",
    requirement: originText,
    method: "",
    quantity: "",
    note: "",
  };
  const plan: SemanticSourcePlan = {
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
      lot_id: "lot:neutral",
      name: "中性验收批",
      evidence_ids: [originId],
      item_ids: [itemId],
    }],
    acceptance_items: [{
      item_id: itemId,
      lot_id: "lot:neutral",
      ...fields,
      category: "一般项目",
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "中性 fixture 不作业务分类判断。",
      inspection_data_type_evidence_ids: [originId],
      evidence_ids: [originId],
      reference_evidence_ids: targetSpecs.map((entry) => entry.evidenceId),
      field_bindings: buildItemFieldBindings(fields, [originId], manifest),
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "本 fixture 不包含抽样语义。",
        reason: "只验证读取路由。",
        confidence: 1,
        evidence_ids: [],
      },
    }],
    reference_resolutions: targetSpecs.map((entry) => ({
      resolution_id: `resolution:neutral-${entry.index + 1}`,
      occurrence_id: referenceOccurrences[entry.index]!.occurrence_id,
      origin_evidence_id: originId,
      action: "keep_reference" as const,
      application_mode: "reference_only" as const,
      import_scope: {
        mode: "field_specific" as const,
        allowed_fields: ["requirement"] as const,
        reason: "中性引用仅验证读取路由。",
      },
      target_evidence_ids: [entry.evidenceId],
      destination_bindings: [{ item_id: itemId, target_field: "reference_only" as const }],
      reason: "保留中性引用关系。",
    })),
    evidence_dispositions: [{
      evidence_id: originId,
      disposition: "used",
      item_ids: [itemId],
      reason: "当前目标来源。",
    }],
    semantic_evidence: [{
      semantic_id: "semantic:neutral",
      role: "acceptance_item",
      evidence_id: originId,
      exact_fragment: originText,
      parent_semantic_id: "",
      materialized_item_id: itemId,
      reason: "中性主来源。",
    }],
    semantic_references: [],
    shared_sampling_rules: [],
  };
  const planText = JSON.stringify(plan);
  const validated = validatePlanText(planText, manifest);
  expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
  await writeFile(workspace.lastValidPlanPath, planText, "utf8");
  await workspace.updateState((state) => {
    state.last_valid_fingerprint = validated.fingerprint!;
    state.last_valid_plan_sha256 = validated.plan_sha256!;
  });
  return {
    workspace,
    targetController: await ToolController.create(workspace),
    coverageController: await CoverageReviewController.create(workspace, validated.fingerprint!),
    itemId,
    duplicateQuery,
  };
}

async function rawSameAtomIsolationFixture(texts: { isolatedText?: string; safeText?: string } = {}) {
  const originId = "evidence:raw-range-origin";
  const isolatedId = "evidence:raw-range-isolated";
  const originText = "neutral origin keeps one local requirement.";
  const isolatedText = texts.isolatedText ?? "neutral isolated reference body 每批.";
  const safeText = texts.safeText ?? "neutral safe raw source remains reachable.";
  const markdown = [originText, isolatedText, safeText].join("\n");
  const sourceSha = sha256Text(markdown);
  const document = buildDocumentEvidence(markdown, "source.md");
  expect(document.atoms).toHaveLength(1);
  const atomId = document.atoms[0]!.atom_id;
  const wholeAtomId = atomId;
  const evidence: EvidenceManifest["evidence"] = [{
    evidence_id: originId,
    atom_id: atomId,
    kind: "paragraph",
    role: "supporting_clause",
    locator: "line:1",
    text: originText,
    text_sha256: sha256Text(originText),
    requires_disposition: true,
    evidence_scope: "primary",
  }, {
    evidence_id: isolatedId,
    atom_id: atomId,
    kind: "paragraph",
    role: "sampling_rule",
    locator: "line:2",
    text: isolatedText,
    text_sha256: sha256Text(isolatedText),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  }, {
    evidence_id: wholeAtomId,
    atom_id: wholeAtomId,
    kind: "paragraph",
    role: "context",
    locator: `char:0-${markdown.length}`,
    text: markdown,
    text_sha256: sha256Text(markdown),
    requires_disposition: false,
    evidence_scope: "reference",
  }];
  const occurrence: EvidenceManifest["reference_occurrences"][number] = {
    occurrence_id: "occurrence:raw-range-isolated",
    origin_evidence_id: originId,
    origin_fields: ["requirement"],
    raw_reference: "neutral isolated reference",
    relation: "neutral mechanical routing fixture",
    target_evidence_ids: [isolatedId],
    required: true,
    status: "resolved",
    depth: 1,
    path: [],
    reference_kind: "clause",
    target_address: {
      source_id: sourceSha,
      locator_kind: "clause",
      locator: "line:2",
    },
  };
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "raw-range-routing-job",
    target_id: "target:raw-range-routing",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "source.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered" as const,
      target_id: "target:raw-range-routing",
      source_line_count: 3,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "neutral raw range",
      selection_reason: "mechanical routing fixture",
      selected_atom_ids: [originId],
      target_evidence_fragments: [{ atom_id: originId, text: originText }],
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [occurrence],
  };
  const manifest: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const root = await mkdtemp(join(tmpdir(), "raw-range-routing-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const plan = validFixturePlan(manifest);
  const itemId = plan.acceptance_items[0]!.item_id;
  plan.acceptance_items[0]!.reference_evidence_ids = [isolatedId];
  plan.reference_resolutions = [{
    resolution_id: "resolution:raw-range-isolated",
    occurrence_id: occurrence.occurrence_id,
    origin_evidence_id: originId,
    action: "keep_reference",
    application_mode: "reference_only",
    import_scope: {
      mode: "field_specific",
      allowed_fields: ["requirement"],
      reason: "neutral mechanical routing fixture",
    },
    target_evidence_ids: [isolatedId],
    destination_bindings: [{ item_id: itemId, target_field: "reference_only" }],
    reason: "neutral mechanical routing fixture",
  }];
  const planText = JSON.stringify(plan);
  const validated = validatePlanText(planText, manifest);
  expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
  await writeFile(workspace.lastValidPlanPath, planText, "utf8");
  const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
  const isolatedPolicy = {
    analysis_mode: "isolated" as const,
    target_text_utf8_bytes: Buffer.byteLength(isolatedText, "utf8"),
    estimated_compact_page_count: 1,
    evidence_count: 1,
    mode_reason: "neutral_test_fixture",
  };
  await workspace.updateState((state) => {
    state.last_valid_fingerprint = validated.fingerprint!;
    state.last_valid_plan_sha256 = validated.plan_sha256!;
    state.reference_analysis_modes = {
      ...(state.reference_analysis_modes ?? {}),
      [`target:${targetKey}`]: isolatedPolicy,
      [`coverage:${targetKey}`]: isolatedPolicy,
    };
  });
  return {
    workspace,
    targetController: await ToolController.create(workspace),
    coverageController: await CoverageReviewController.create(workspace, validated.fingerprint!),
    manifest,
    isolatedId,
    isolatedText,
    safeText,
    wholeAtomId,
    targetKey,
  };
}

async function crossAtomHtmlIsolationCoverageFixture() {
  const originId = "evidence:opaque-origin";
  const itemId = "item:opaque";
  const originText = "opaque-origin points to table Q.";
  const rows = Array.from({ length: 26 }, (_, index) => {
    const label = `opaque-row-${String.fromCharCode(97 + (index % 26))}`;
    const value = `raw-cell-marker-${String.fromCharCode(97 + (index % 26))}-${"x".repeat(280)}`;
    return {
      evidenceId: `evidence:opaque-table-${index + 1}`,
      cells: [label, value],
      text: `${label} | ${value}`,
      raw: `<tr><td>${label}</td><td>${value}</td></tr>`,
    };
  });
  const tableLine = `<table>${rows.map((row) => row.raw).join("")}</table>`;
  const markdown = ["opaque-table-caption-Q", tableLine, originText].join("\n");
  const sourceSha = sha256Text(markdown);
  const reviewSourceText = rows[0]!.raw;
  const reviewSourceStart = markdown.indexOf(reviewSourceText);
  const reviewSourceId = `review-source:${sha256Text(`${sourceSha}:${reviewSourceStart}:${reviewSourceStart + reviewSourceText.length}`)}`;
  const targetEvidence: EvidenceManifest["evidence"] = rows.map((row, index) => ({
    evidence_id: row.evidenceId,
    kind: "table_row",
    role: "context",
    locator: `line:2/table:Q/row:${index + 1}`,
    text: row.text,
    text_sha256: sha256Text(row.text),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
    table_id: "Q",
    row_index: index + 1,
    table_row_kind: "data",
    table_text_format: "cell_values_v1",
    columns: ["opaque-left", "opaque-right"],
    cells: row.cells,
  }));
  const originEvidence: EvidenceManifest["evidence"][number] = {
    evidence_id: originId,
    kind: "paragraph",
    role: "supporting_clause",
    locator: "line:3",
    text: originText,
    text_sha256: sha256Text(originText),
    requires_disposition: true,
    evidence_scope: "primary",
  };
  const reviewSourceEvidence: EvidenceManifest["evidence"][number] = {
    evidence_id: reviewSourceId,
    kind: "paragraph",
    role: "context",
    locator: `char:${reviewSourceStart}-${reviewSourceStart + reviewSourceText.length}`,
    text: reviewSourceText,
    text_sha256: sha256Text(reviewSourceText),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  };
  const occurrence: EvidenceManifest["reference_occurrences"][number] = {
    occurrence_id: "occurrence:opaque-table",
    origin_evidence_id: originId,
    origin_fields: ["requirement"],
    raw_reference: "table Q",
    relation: "opaque mechanical reference",
    target_evidence_ids: rows.map((row) => row.evidenceId),
    required: true,
    status: "resolved",
    depth: 1,
    path: [],
    reference_kind: "table",
    target_table_id: "Q",
    target_address: {
      source_id: sourceSha,
      locator_kind: "table",
      locator: "table:Q",
    },
  };
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "opaque-html-route-job",
    target_id: "target:opaque-html-route",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "source.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered" as const,
      target_id: "target:opaque-html-route",
      source_line_count: 3,
      selected_start_line: 3,
      selected_end_exclusive_line: 4,
      selected_heading: "opaque current target",
      selection_reason: "mechanical route fixture",
      selected_atom_ids: [originId],
      target_evidence_fragments: [{ atom_id: originId, text: originText }],
      candidates: [],
    },
    evidence: [originEvidence, ...targetEvidence, reviewSourceEvidence],
    table_fragments: [],
    reference_occurrences: [occurrence],
  };
  const manifest: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const root = await mkdtemp(join(tmpdir(), "opaque-html-route-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const fields = {
    name: "opaque item",
    requirement: originText,
    method: "",
    quantity: "",
    note: "",
  };
  const plan: SemanticSourcePlan = {
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
      lot_id: "lot:opaque",
      name: "opaque lot",
      evidence_ids: [originId],
      item_ids: [itemId],
    }],
    acceptance_items: [{
      item_id: itemId,
      lot_id: "lot:opaque",
      ...fields,
      category: "一般项目",
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "mechanical route fixture",
      inspection_data_type_evidence_ids: [originId],
      evidence_ids: [originId],
      reference_evidence_ids: rows.map((row) => row.evidenceId),
      field_bindings: buildItemFieldBindings(fields, [originId], manifest),
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "mechanical route fixture",
        reason: "mechanical route fixture",
        confidence: 1,
        evidence_ids: [],
      },
    }],
    reference_resolutions: [{
      resolution_id: "resolution:opaque-table",
      occurrence_id: occurrence.occurrence_id,
      origin_evidence_id: originId,
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["requirement"],
        reason: "mechanical route fixture",
      },
      target_evidence_ids: rows.map((row) => row.evidenceId),
      destination_bindings: [{ item_id: itemId, target_field: "reference_only" }],
      reason: "mechanical route fixture",
    }],
    evidence_dispositions: [{
      evidence_id: originId,
      disposition: "used",
      item_ids: [itemId],
      reason: "mechanical route fixture",
    }],
    semantic_evidence: [{
      semantic_id: "semantic:opaque",
      role: "acceptance_item",
      evidence_id: originId,
      exact_fragment: originText,
      parent_semantic_id: "",
      materialized_item_id: itemId,
      reason: "mechanical route fixture",
    }],
    semantic_references: [],
    shared_sampling_rules: [],
  };
  const planText = JSON.stringify(plan);
  const validated = validatePlanText(planText, manifest);
  expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
  await writeFile(workspace.lastValidPlanPath, planText, "utf8");
  await workspace.updateState((state) => {
    state.last_valid_fingerprint = validated.fingerprint!;
    state.last_valid_plan_sha256 = validated.plan_sha256!;
  });
  const document = buildDocumentEvidence(markdown, manifest.source.file_name);
  const tableStart = markdown.indexOf(tableLine);
  const tableEnd = tableStart + tableLine.length;
  return {
    workspace,
    controller: await CoverageReviewController.create(workspace, validated.fingerprint!),
    targetController: await ToolController.create(workspace),
    targetKey: `reference-target:${sha256Text(`table:Q\0${sha256Json(rows.map((row) => row.evidenceId))}`)}`,
    rawCellMarker: "raw-cell-marker-a-",
    reviewSourceId,
    reviewSourceText,
    protectedAtomIds: document.atoms
      .filter((atom) => atom.start_offset < tableEnd && atom.end_offset > tableStart)
      .map((atom) => atom.atom_id),
  };
}

async function registeredIsolatedHtmlTableFixture(options: {
  isolatedTableScope?: "reference" | "primary";
} = {}) {
  const tableNumber = "7.7.1-1";
  const safeTableNumber = "7.7.1-2";
  const caption = `表 ${tableNumber} 中性访问表`;
  const rowCells = Array.from({ length: 26 }, (_, index) => [
    `neutral-table-sentinel-${index + 1}`,
    `neutral-value-${index + 1}-每批`,
  ]);
  const tableLine = [
    "<table>",
    "<tr><th>中性对象</th><th>中性值</th></tr>",
    ...rowCells.map((cells) => `<tr><td>${cells[0]}</td><td>${cells[1]}</td></tr>`),
    "</table>",
  ].join("");
  const safeCaption = `表 ${safeTableNumber} 独立安全表`;
  const safeTableLine = [
    "<table><tr><th>安全对象</th><th>安全值</th></tr>",
    "<tr><td>safe-table-row-a</td><td>safe-table-value-a</td></tr>",
    "<tr><td>safe-table-row-b</td><td>safe-table-value-b</td></tr></table>",
  ].join("");
  const safeText = "neutral-safe-neighbour-in-the-same-table-atom";
  const originText = `9.9.1 当前对象应符合本规范表 ${tableNumber} 的规定。`;
  const safeOriginText = `9.9.2 另一对象应符合本规范表 ${safeTableNumber} 的规定。`;
  const markdown = [
    caption,
    tableLine,
    safeText,
    safeCaption,
    safeTableLine,
    "# 9 当前目标",
    originText,
    safeOriginText,
  ].join("\n");
  const baseManifest = manifestFor(markdown, [safeText, originText, safeOriginText]);
  const structured = buildStructuredTargetEvidence(
    markdown,
    baseManifest.source.sha256,
    [
      ...(options.isolatedTableScope === "primary"
        ? [{ start_line: 1, end_exclusive_line: 3 }]
        : []),
      { start_line: 4, end_exclusive_line: 6 },
    ],
    false,
  );
  const evidence = [...new Map([
    ...baseManifest.evidence,
    ...structured.evidence,
  ].map((record) => [record.evidence_id, record])).values()];
  const { evidence_fingerprint: _baseFingerprint, ...basePayload } = baseManifest;
  const payload = {
    ...basePayload,
    scope: {
      ...baseManifest.scope,
      confirmed_scope_fingerprint: `scope-${sha256Text(tableLine)}`,
      ...(options.isolatedTableScope === "primary"
        ? {
            primary_source_ranges: [{ start_line: 1, end_exclusive_line: 9 }],
          }
        : {}),
      selected_atom_ids: evidence.map((record) => record.evidence_id),
      target_evidence_fragments: evidence.map((record) => ({
        atom_id: record.evidence_id,
        text: record.text,
      })),
    },
    evidence,
    table_fragments: structured.table_fragments,
  };
  const manifest: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
  const root = await mkdtemp(join(tmpdir(), "registered-isolated-html-table-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const controller = await ToolController.create(workspace);
  const registry = await workspace.readSourceSpanRegistry();
  const origin = manifest.evidence.find((record) => record.text === originText)!;
  const safeOrigin = manifest.evidence.find((record) => record.text === safeOriginText)!;
  const originSpan = registry.spans.find((span) =>
    span.evidence_id === origin.evidence_id
    && span.start === 0
    && span.end === origin.text.length
  )!;
  const safeOriginSpan = registry.spans.find((span) =>
    span.evidence_id === safeOrigin.evidence_id
    && span.start === 0
    && span.end === safeOrigin.text.length
  )!;
  const resolved = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan.span_id,
    origin_field: "requirement",
    raw_reference: `本规范表 ${tableNumber}`,
    target: { kind: "table", number: tableNumber },
    relation: "中性表格引用访问",
  }) as Record<string, any>;
  expect(resolved).toMatchObject({ ok: true, analysis_mode: "isolated" });
  const safeResolved = await controller.dispatch("resolve_document_reference", {
    origin_span_id: safeOriginSpan.span_id,
    origin_field: "requirement",
    raw_reference: `本规范表 ${safeTableNumber}`,
    target: { kind: "table", number: safeTableNumber },
    relation: "独立安全表格引用访问",
  }) as Record<string, any>;
  expect(safeResolved).toMatchObject({ ok: true, analysis_mode: "inline" });
  const current = await workspace.readEvidenceManifest();
  const occurrence = current.reference_occurrences.find((entry) =>
    entry.occurrence_id === resolved.occurrence_id
  )!;
  const fragment = current.table_fragments.find((entry) =>
    entry.row_evidence_ids.some((evidenceId) => occurrence.target_evidence_ids.includes(evidenceId))
  )!;
  const safeOccurrence = current.reference_occurrences.find((entry) =>
    entry.occurrence_id === safeResolved.occurrence_id
  )!;
  const safeFragment = current.table_fragments.find((entry) =>
    entry.row_evidence_ids.some((evidenceId) => safeOccurrence.target_evidence_ids.includes(evidenceId))
  )!;
  const isolatedRow = current.evidence.find((record) =>
    occurrence.target_evidence_ids.includes(record.evidence_id)
    && record.kind === "table_row"
  )!;
  const safeHeader = current.evidence.find((record) =>
    safeFragment.header_evidence_ids.includes(record.evidence_id)
  )!;
  const safeRecord = current.evidence.find((record) => record.text === safeText)!;
  expect(markdown).not.toContain(isolatedRow.text);
  return {
    workspace,
    controller,
    fragmentId: fragment.fragment_id,
    tableKey: tableNumber,
    safeFragmentId: safeFragment.fragment_id,
    safeTableKey: safeTableNumber,
    targetKey: String(resolved.target_key),
    isolatedRow,
    safeHeader,
    safeRecord,
    scopeFingerprint: current.scope.confirmed_scope_fingerprint ?? "",
    sentinel: rowCells[0]![0]!,
  };
}

function byEvidenceId(rows: Array<Record<string, any>>, evidenceId: string) {
  return rows.find((row) => row.evidence_id === evidenceId)!;
}

test("all evidence directories expose stable body-free access routes across reopen", async () => {
  const fixture = await routingFixture();
  const context = await fixture.controller.dispatch("get_target_context", { limit: 100 }) as any;
  const direct = byEvidenceId(context.resource_inventory, fixture.directEvidenceId);
  const inline = byEvidenceId(context.resource_inventory, fixture.inlineEvidenceId);
  const isolated = byEvidenceId(context.resource_inventory, fixture.isolatedEvidenceId);
  expect(direct).toMatchObject({
    access_mode: "direct", read_tool: "open_evidence", open_evidence_allowed: true,
  });
  expect(inline).toMatchObject({
    access_mode: "inline_reference",
    read_tool: "read_document_reference_evidence",
    open_evidence_allowed: true,
    target_key: fixture.inlineTargetKey,
  });
  expect(isolated).toMatchObject({
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_evidence_allowed: false,
    target_key: fixture.isolatedTargetKey,
  });
  const inventoryText = JSON.stringify(context.resource_inventory);
  expect(inventoryText).not.toContain(fixture.inlineText);
  expect(inventoryText).not.toContain(fixture.isolatedText);

  const reopened = await ToolController.create(fixture.workspace);
  const listed = await reopened.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect(byEvidenceId(listed.resources, fixture.directEvidenceId)).toMatchObject(direct);
  expect(byEvidenceId(listed.resources, fixture.inlineEvidenceId)).toMatchObject(inline);
  expect(byEvidenceId(listed.resources, fixture.isolatedEvidenceId)).toMatchObject(isolated);

  const searched = await reopened.dispatch("search_evidence", { query: "大型目录规则" }) as any;
  expect(byEvidenceId(searched.matches, fixture.isolatedEvidenceId)).toBeUndefined();
  expect(searched.matches).toEqual([]);
  expect(JSON.stringify(searched)).not.toContain(fixture.isolatedText);

  const batchSearched = await reopened.dispatch("batch_search_evidence", {
    queries: ["小型规则", "大型目录规则"],
  }) as any;
  expect(byEvidenceId(batchSearched.results[0].matches, fixture.inlineEvidenceId)).toMatchObject({
    access_mode: inline.access_mode,
    read_tool: inline.read_tool,
    open_evidence_allowed: inline.open_evidence_allowed,
    target_key: inline.target_key,
  });
  expect(byEvidenceId(batchSearched.results[1].matches, fixture.isolatedEvidenceId)).toBeUndefined();
  expect(batchSearched.results[1].matches).toEqual([]);
  expect(JSON.stringify(batchSearched.results[1])).not.toContain(fixture.isolatedText);

  const sampling = await reopened.dispatch("list_sampling_rules", { limit: 100 }) as any;
  expect(byEvidenceId(sampling.candidates, fixture.directEvidenceId)).toMatchObject({
    access_mode: "direct", read_tool: "open_evidence", open_evidence_allowed: true,
  });
  const navigation = sampling.navigation_candidates as Array<Record<string, any>>;
  expect(byEvidenceId(navigation, fixture.inlineEvidenceId)).toMatchObject({
    access_mode: inline.access_mode,
    read_tool: inline.read_tool,
    open_evidence_allowed: inline.open_evidence_allowed,
    target_key: inline.target_key,
  });
  expect(byEvidenceId(navigation, fixture.isolatedEvidenceId)).toMatchObject({
    access_mode: isolated.access_mode,
    read_tool: isolated.read_tool,
    open_evidence_allowed: isolated.open_evidence_allowed,
    target_key: isolated.target_key,
  });
  expect(byEvidenceId(navigation, fixture.isolatedEvidenceId)).not.toHaveProperty("preview");
});

test("mixed batch open rejects atomically and successful inline batches do not persist route policy", async () => {
  const fixture = await routingFixture();
  const stateBefore = await fixture.workspace.readState();
  const registryBefore = await fixture.workspace.readSourceSpanRegistry();
  const rejected = await fixture.controller.dispatch("batch_open_evidence", {
    evidence_ids: [
      fixture.directEvidenceId,
      fixture.inlineEvidenceId,
      fixture.isolatedEvidenceId,
      fixture.secondIsolatedEvidenceId,
    ],
  }) as any;
  expect(rejected).toMatchObject({
    ok: false,
    error: "batch_open_contains_isolated_reference_evidence",
    durable_mutation: false,
    openable_evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId],
    routed_references: [{
      target_key: fixture.isolatedTargetKey,
      evidence_ids: [fixture.isolatedEvidenceId, fixture.secondIsolatedEvidenceId],
      read_tool: "read_reference_facts",
      open_evidence_allowed: false,
      tool_arguments: { target_key: fixture.isolatedTargetKey },
    }],
    retry_tool: "batch_open_evidence",
    retry_arguments: { evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId] },
    next_tools: ["batch_open_evidence", "read_reference_facts"],
  });
  const stateAfter = await fixture.workspace.readState();
  expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect(stateAfter.opened_evidence_window_keys).toEqual(stateBefore.opened_evidence_window_keys);
  expect(stateAfter.reference_analysis_modes).toEqual(stateBefore.reference_analysis_modes);
  expect(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);
  expect(JSON.stringify(rejected)).not.toContain(fixture.isolatedText);

  await fixture.workspace.updateState((state) => {
    const modes = { ...(state.reference_analysis_modes ?? {}) };
    delete modes[`target:${fixture.inlineTargetKey}`];
    state.reference_analysis_modes = modes;
  });
  const opened = await fixture.controller.dispatch("batch_open_evidence", {
    evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId],
  }) as any;
  expect(opened).toMatchObject({ ok: true, opened: [{}, {}] });
  expect((await fixture.workspace.readState()).reference_analysis_modes?.[
    `target:${fixture.inlineTargetKey}`
  ]).toBeUndefined();
});

const sourceDispositionReceiptCodes = ["compiler_unhandled_evidence", "agent_primary_atom_unhandled", "unhandled_evidence", "compiler_semantic_primary_atom_unclassified"] as const;
test.each(sourceDispositionReceiptCodes.flatMap(code => [false, true].map(mixed => [code, mixed] as const)))("%s repair routes model-visible reads by permission (mixed=%s)", async (code, mixed) => {
  const fixture = await routingFixture(true);
  const registry = await fixture.workspace.readSourceSpanRegistry();
  const evidenceIds = [fixture.isolatedEvidenceId, fixture.secondIsolatedEvidenceId,
    ...(mixed ? [fixture.directEvidenceId, fixture.inlineEvidenceId, fixture.otherIsolatedEvidenceId] : [])];
  const [classified] = classifyCompilerInvariantIssues(
    { references: [], source_dispositions: [] } as any, registry, [{
      code, path: "/evidence_dispositions", message: "Unbound sources",
      details: { evidence_ids: evidenceIds },
    }],
  );
  const [routed] = await (fixture.controller as any).routeSelectorCompilerEvidenceReads([classified]);
  expect(routed.details.next_tool).toBe("read_reference_facts");
  expect(routed.details.candidate_read_tool).toBe("read_reference_facts");
  expect(routed.details.next_tool_arguments).toEqual({ target_key: fixture.isolatedTargetKey });
  expect(routed.details.source_access.map((entry: any) => entry.evidence_id)).toEqual(evidenceIds);
  expect(routed.details.how_to_pass).not.toContain("先按 next_tool_arguments 调用 open_evidence");
  expect(routed.details.how_to_pass).toContain("不替模型决定");
  expect(routed.details.how_to_pass).toContain("draft.source_dispositions");
  expect(routed.details.tool_argument_hints).not.toHaveProperty("locate_evidence_span");
  expect(routed.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
  expect(routed.details.how_to_pass).toContain("不要求依次通读四个集合");
  expect(routed.details.author_record_read_policy).toContain("备选入口");
  const dispositionRead = routed.details.tool_argument_hints.read_target_selectors.find((entry: any) => entry.collection === "source_dispositions");
  expect(dispositionRead).toEqual({ collection: "source_dispositions", evidence_ids: evidenceIds });
  const selectorBeforeRead = await readFile(fixture.workspace.workingSelectorPath, "utf8");
  expect(await fixture.controller.dispatch("read_target_selectors", dispositionRead)).toMatchObject({ ok: true, budget_consumed: false });
  expect(await readFile(fixture.workspace.workingSelectorPath, "utf8")).toBe(selectorBeforeRead);
  if (mixed) {
    expect(routed.details.tool_argument_hints.open_evidence).toEqual({ evidence_id: fixture.directEvidenceId, cursor: 0 });
    expect(routed.details.tool_argument_hints.read_reference_facts).toEqual([
      { target_key: fixture.isolatedTargetKey }, { target_key: fixture.otherIsolatedTargetKey },
    ]);
  } else {
    expect(routed.details.next_tools).not.toContain("open_evidence");
    expect(routed.details.candidate_read_tools).not.toContain("open_evidence");
    expect(routed.details.tool_argument_hints).not.toHaveProperty("open_evidence");
    expect(routed.details.tool_argument_hints.read_reference_facts).toEqual({ target_key: fixture.isolatedTargetKey });
  }
  // Exercise the same short-handle tool boundary the model uses, not only internal details.
  const codec = await ModelSourceHandles.open(fixture.workspace.root);
  const visible = await codec.encode(routed) as any;
  const tools = new Map(codec.wrapTools(createPiTools(fixture.controller)).map(tool => [tool.name, tool]));
  const calls = new Set<string>();
  for (const access of visible.details.source_access) {
    const key = JSON.stringify([access.read_tool, access.tool_arguments]);
    if (calls.has(key)) continue;
    calls.add(key);
    const result = await tools.get(access.read_tool)!.execute(key, {
      ...access.tool_arguments, source_handle_scope: codec.scope,
    }, undefined as any, undefined as any, undefined as any);
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ ok: true });
  }
  for (const text of [fixture.isolatedText, fixture.otherIsolatedText]) {
    expect(JSON.stringify(visible)).not.toContain(text);
  }
  expect(await fixture.controller.dispatch("open_evidence", { evidence_id: fixture.isolatedEvidenceId }))
    .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
});

test.each(sourceDispositionReceiptCodes)("%s repair advances past durable full reads before suggesting another source read", async code => {
  const fixture = await routingFixture();
  const registry = await fixture.workspace.readSourceSpanRegistry();
  const [classified] = classifyCompilerInvariantIssues(
    { references: [], source_dispositions: [] } as any, registry, [{
      code, path: "/evidence_dispositions", message: "Unbound sources",
      details: { evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId] },
    }],
  );
  const route = async () => (await (fixture.controller as any)
    .routeSelectorCompilerEvidenceReads([classified]) as any[])[0].details;

  const unread = await route();
  expect(unread).toMatchObject({
    next_tool: "open_evidence",
    next_tool_arguments: { evidence_id: fixture.directEvidenceId, cursor: 0 },
    already_read_evidence_ids: [],
    unread_evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId],
  });

  expect(await fixture.controller.dispatch("open_evidence", { evidence_id: fixture.directEvidenceId }))
    .toMatchObject({ ok: true, next_cursor: null });
  expect((await fixture.workspace.readState()).opened_evidence_ids).toContain(fixture.directEvidenceId);
  const partlyRead = await route();
  expect(partlyRead).toMatchObject({
    next_tool: "read_document_reference_evidence",
    next_tool_arguments: { target_key: fixture.inlineTargetKey, cursor: 0, limit: 24 },
    already_read_evidence_ids: [fixture.directEvidenceId],
    unread_evidence_ids: [fixture.inlineEvidenceId],
  });
  expect(partlyRead.how_to_pass).toContain("仅 unread_evidence_ids 需按 source_access");

  expect(await fixture.controller.dispatch("read_document_reference_evidence", {
    target_key: fixture.inlineTargetKey, cursor: 0, limit: 24,
  })).toMatchObject({ ok: true });
  expect((await fixture.workspace.readState()).opened_evidence_ids).toContain(fixture.inlineEvidenceId);
  const fullyRead = await route();
  expect(fullyRead).toMatchObject({
    next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "source_dispositions", evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId] },
    already_read_evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId],
    unread_evidence_ids: [],
    required_affected_evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId],
    repair_options: expect.arrayContaining([
      expect.objectContaining({ kind: "bind_source", next_tool_arguments: { collection: "items" } }),
      expect.objectContaining({ kind: "source_disposition", next_tool_arguments: { collection: "source_dispositions", evidence_ids: [fixture.directEvidenceId, fixture.inlineEvidenceId] } }),
    ]),
  });
  expect(await fixture.controller.dispatch(fullyRead.next_tool, fullyRead.next_tool_arguments)).toMatchObject({ ok: true });
  expect(fullyRead.how_to_pass).toContain("增量保存");
  expect(fullyRead.how_to_pass).toContain("不必等所有来源都处理完才保存");
  expect(fullyRead.how_to_pass).toContain("逐条保存不等于逐条重检");
  expect(fullyRead.how_to_pass).toContain("get_target_context({source_repair_cursor:0})");
  expect(fullyRead.how_to_pass).not.toContain("保留其他 keyed records，再重试原验证");
  expect(fullyRead.how_to_pass).toContain("不要仅重读后重复提交未修改的草稿");
});

test("read conditional reference origins route to their unsaved resolved occurrences", async () => {
  const origins = [
    "9.1.1 采用工法甲时，按第 1.1.1 条验收。",
    "9.1.2 采用工法乙时，按第 2.1.1 条验收。",
  ];
  const markdown = [
    "# 1 工法甲",
    "1.1.1 工法甲的质量验收应检查属性甲。",
    "# 2 工法乙",
    "2.1.1 工法乙的质量验收应检查属性乙。",
    "# 9 当前对象",
    ...origins,
  ].join("\n");
  const manifest = manifestFor(markdown, origins);
  const root = await mkdtemp(join(tmpdir(), "conditional-reference-routing-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(
    root, manifest.job_id, manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const controller = await ToolController.create(workspace);
  const registry = await workspace.readSourceSpanRegistry();
  const originEvidenceIds = origins.map((text) =>
    manifest.evidence.find((entry) => entry.text === text)!.evidence_id
  );
  const originSpanIds = originEvidenceIds.map((evidenceId) =>
    registry.spans.find((span) => span.evidence_id === evidenceId
      && span.start === 0 && span.end === manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!.text.length)!.span_id
  );
  const receipts: Array<Record<string, any>> = [];
  for (const index of [0, 1]) {
    receipts.push(await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanIds[index],
      raw_reference: index === 0 ? "第 1.1.1 条" : "第 2.1.1 条",
      target: { kind: "clause", number: index === 0 ? "1.1.1" : "2.1.1" },
      relation: "条件适用的中性来源",
    }) as Record<string, any>);
  }
  expect(receipts).toEqual([
    expect.objectContaining({ ok: true, analysis_mode: "inline" }),
    expect.objectContaining({ ok: true, analysis_mode: "inline" }),
  ]);
  for (const evidenceId of originEvidenceIds) {
    expect(await controller.dispatch("open_evidence", { evidence_id: evidenceId, cursor: 0 }))
      .toMatchObject({ ok: true, next_cursor: null });
  }
  const [classified] = classifyCompilerInvariantIssues(
    { references: [], source_dispositions: [] } as any,
    await workspace.readSourceSpanRegistry(),
    [{
      code: "compiler_unhandled_evidence", path: "/evidence_dispositions", message: "Unbound origins",
      details: { evidence_ids: originEvidenceIds },
    }],
  );
  const route = async () => (await (controller as any)
    .routeSelectorCompilerEvidenceReads([classified]) as any[])[0];
  const beforeTargetRead = await route();
  expect(beforeTargetRead.details.missing_resolved_reference_routes).toEqual([
    expect.objectContaining({ target_fully_read: false }),
    expect.objectContaining({ target_fully_read: false }),
  ]);
  expect(beforeTargetRead.details.how_to_pass).toContain("被引目标尚未完整读取");
  for (const receipt of receipts) {
    expect(await controller.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: 0, limit: 24,
    })).toMatchObject({ ok: true, next_cursor: null });
  }
  const routed = await route();
  expect(routed.details).toMatchObject({
    already_read_evidence_ids: originEvidenceIds,
    unread_evidence_ids: [],
    next_tool: "list_reference_occurrences",
    next_tool_arguments: { cursor: 0, limit: 100 },
    missing_resolved_reference_routes: receipts.map((receipt, index) => ({
      occurrence_id: receipt.occurrence_id,
      origin_evidence_ids: [originEvidenceIds[index]],
      raw_reference: index === 0 ? "第 1.1.1 条" : "第 2.1.1 条",
      analysis_mode: "inline",
      target_fully_read: true,
      saved_reference_keys: [],
    })),
  });
  expect(routed.details.next_tools).toContain("stage_target_selector_draft");
  expect(routed.details.how_to_pass).toContain("增量暂存完整、真实的 item");
  expect(routed.details.how_to_pass).toContain("不可机械复制");
  expect(routed.details.how_to_pass).toContain("适用条件");
  expect(routed.details.how_to_pass).not.toContain("工法甲");
});

test.each(["direct", "inline", "isolated"] as const)("reference origin repair supplies an executable %s evidence read", async (mode) => {
  const fixture = await routingFixture();
  const evidenceId = mode === "direct" ? fixture.directEvidenceId
    : mode === "inline" ? fixture.inlineEvidenceId : fixture.isolatedEvidenceId;
  const nextTool = mode === "direct" ? "open_evidence"
    : mode === "inline" ? "read_document_reference_evidence" : "read_reference_facts";
  const nextArguments = mode === "direct" ? { evidence_id: evidenceId, cursor: 0 }
    : mode === "inline" ? { target_key: fixture.inlineTargetKey, cursor: 0, limit: 24 }
      : { target_key: fixture.isolatedTargetKey };
  const [routed] = await (fixture.controller as any).routeSelectorCompilerEvidenceReads([{
    code: "reference_origin_relation", path: "/references/0/destinations/0/item_key",
    owner: "selector_input_error",
    details: {
      origin_evidence_ids: [evidenceId],
      candidate_read_tools: ["open_evidence", "read_target_selectors"],
      next_tool: "open_evidence",
      how_to_pass: "先用 open_evidence 核对 origin_evidence_ids 的原文，再用 read_target_selectors 读取接收 item。",
    },
  }]) as any[];
  const actionable = actionableSelectorIssue(routed) as any;
  expect(actionable).toMatchObject({
    next_tool: nextTool,
    next_tool_arguments: nextArguments,
    tool_argument_hints: { [nextTool]: nextArguments },
    details: {
      origin_evidence_ids: [evidenceId],
      source_access: [{ evidence_id: evidenceId, read_tool: nextTool, tool_arguments: nextArguments }],
    },
  });
  expect(actionable.how_to_pass).toContain("按 source_access");
  expect(actionable.how_to_pass).not.toContain("先用 open_evidence 核对 origin_evidence_ids");
  if (mode === "isolated") {
    expect(actionable.candidate_read_tools).not.toContain("open_evidence");
    expect(actionable.tool_argument_hints).not.toHaveProperty("open_evidence");
  }
  expect(await fixture.controller.dispatch(nextTool, nextArguments)).toMatchObject({ ok: true });
});

test("reference origin repair keeps exact read arguments for every mixed origin", async () => {
  const fixture = await routingFixture(true);
  const evidenceIds = [fixture.isolatedEvidenceId, fixture.secondIsolatedEvidenceId,
    fixture.directEvidenceId, fixture.inlineEvidenceId, fixture.otherIsolatedEvidenceId];
  const [routed] = await (fixture.controller as any).routeSelectorCompilerEvidenceReads([{
    code: "reference_origin_relation", path: "/references/0/destinations/0/item_key",
    owner: "selector_input_error",
    details: { origin_evidence_ids: evidenceIds, next_tool: "open_evidence",
      candidate_read_tools: ["open_evidence", "read_target_selectors"] },
  }]) as any[];
  const actionable = actionableSelectorIssue(routed) as any;
  expect(actionable.next_tool).toBe("read_reference_facts");
  expect(actionable.next_tool_arguments).toEqual({ target_key: fixture.isolatedTargetKey });
  expect(actionable.details.source_access.map((access: any) => access.evidence_id)).toEqual(evidenceIds);
  expect(actionable.tool_argument_hints).toMatchObject({
    read_reference_facts: [
      { target_key: fixture.isolatedTargetKey }, { target_key: fixture.otherIsolatedTargetKey },
    ],
    open_evidence: { evidence_id: fixture.directEvidenceId, cursor: 0 },
    read_document_reference_evidence: { target_key: fixture.inlineTargetKey, cursor: 0, limit: 24 },
  });
  expect(JSON.stringify(actionable)).not.toContain(fixture.isolatedText);
});

test("unaccounted isolated components have an executable exact-source route through public handles", async () => {
  const fixture = await routingFixture();
  const { controller, workspace, isolatedEvidenceId, isolatedTargetKey } = fixture;
  const [routed] = await (controller as any).routeSelectorCompilerEvidenceReads([{
    code: "selector_resolved_reference_components_unaccounted", path: "/references/0/component_dispositions",
    details: { evidence_ids: [isolatedEvidenceId], next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0 } },
  }]) as any[];
  const actionable = actionableSelectorIssue(routed) as any;
  expect(actionable).toMatchObject({ next_tool: "read_reference_facts",
    next_tool_arguments: { target_key: isolatedTargetKey, evidence_ids: [isolatedEvidenceId] } });
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const handles = await ModelSourceHandles.open(workspace.root);
  const visible = await handles.encode(actionable) as any;
  expect(visible.next_tool_arguments.evidence_ids[0]).toMatch(/^e\d+$/u);
  const publicArguments = { ...visible.next_tool_arguments, source_handle_scope: handles.scope };
  expect(Check(handles.wrapTools(createPiTools(controller)).find(tool => tool.name === visible.next_tool)!.parameters, publicArguments)).toBe(true);
  const args = await handles.decodeArguments({ ...visible.next_tool_arguments, source_handle_scope: handles.scope });
  const route = await controller.dispatch(visible.next_tool, args) as any;
  expect(route).toMatchObject({ ok: true, metadata_only: true, source_routes: [{ evidence_id: isolatedEvidenceId }] });
  expect(route).not.toHaveProperty("resolved_rows");
  expect((await workspace.readState()).opened_evidence_ids).toEqual(before.opened_evidence_ids);
  expect(Check(createPiTools(controller).find(tool => tool.name === route.next_tool)!.parameters, route.next_tool_arguments)).toBe(true);
  const body = await controller.dispatch(route.next_tool, route.next_tool_arguments) as any;
  expect(body).toMatchObject({ ok: true, resolved_rows: expect.arrayContaining([
    expect.objectContaining({ evidence_id: isolatedEvidenceId, span_id: expect.any(String) }),
  ]) });
  expect((await workspace.readState()).opened_evidence_ids).toContain(isolatedEvidenceId);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
});

test("component mismatch routes isolated spans without removing direct or inline readers", async () => {
  const fixture = await routingFixture();
  const registry = await fixture.workspace.readSourceSpanRegistry();
  const fullSpan = (evidenceId: string) => {
    const record = fixture.manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
    return registry.spans.find((span) =>
      span.evidence_id === evidenceId && span.start === 0 && span.end === record.text.length
    )!.span_id;
  };
  const issue = (spanId: string) => ({
    code: "selector_reference_component_item_mismatch",
    path: "/references/0/component_dispositions/0/item_keys",
    details: {
      uncovered_span_ids: [spanId],
      actual: { component_span_ids: [spanId], item_keys: ["neutral-item"] },
      candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
      next_tools: ["read_target_selectors", "open_evidence", "stage_target_selector_draft"],
      tool_argument_hints: { open_evidence: { evidence_id: "placeholder", cursor: 0 } },
      save_tool_instruction: "operation=upsert; draft.items / draft.references 使用修改后的完整记录；writable_paths 仅为诊断元数据。",
    },
  });
  const [isolated, direct, inline] = await (fixture.controller as any)
    .routeSelectorCompilerEvidenceReads([
      issue(fullSpan(fixture.isolatedEvidenceId)),
      issue(fullSpan(fixture.directEvidenceId)),
      issue(fullSpan(fixture.inlineEvidenceId)),
    ]) as any[];
  expect(isolated.details.source_access).toEqual([expect.objectContaining({
    evidence_id: fixture.isolatedEvidenceId,
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    target_key: fixture.isolatedTargetKey,
    tool_arguments: { target_key: fixture.isolatedTargetKey },
  })]);
  expect(isolated.details.candidate_read_tools).not.toContain("open_evidence");
  expect(isolated.details.next_tools).not.toContain("open_evidence");
  expect(isolated.details.tool_argument_hints).not.toHaveProperty("open_evidence");
  expect(isolated.details.how_to_pass).toContain("不要调用 open_evidence");
  for (const routed of [isolated, direct, inline]) {
    expect(routed.details.save_tool_instruction).toBe(issue(fullSpan(fixture.directEvidenceId)).details.save_tool_instruction);
    expect(routed.details.tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
  }

  expect(direct.details.candidate_read_tools).toContain("open_evidence");
  expect(direct.details.next_tools).toContain("open_evidence");
  expect(direct.details.source_access).toEqual([expect.objectContaining({
    access_mode: "direct", read_tool: "open_evidence", open_evidence_allowed: true,
  })]);
  expect(inline.details.candidate_read_tools).toContain("read_document_reference_evidence");
  expect(inline.details.next_tools).toContain("read_document_reference_evidence");
  expect(inline.details.candidate_read_tools).not.toContain("open_evidence");
  expect(inline.details.next_tools).not.toContain("open_evidence");
  expect(inline.details.source_access).toEqual([expect.objectContaining({
    access_mode: "inline_reference",
    read_tool: "read_document_reference_evidence",
    open_evidence_allowed: true,
    target_key: fixture.inlineTargetKey,
  })]);
});

test("one mixed component mismatch gives exact non-conflicting read arguments for every source", async () => {
  const fixture = await routingFixture(true);
  const registry = await fixture.workspace.readSourceSpanRegistry();
  const fullSpan = (evidenceId: string) => {
    const record = fixture.manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
    return registry.spans.find((span) =>
      span.evidence_id === evidenceId && span.start === 0 && span.end === record.text.length
    )!.span_id;
  };
  const spanIds = [
    fullSpan(fixture.directEvidenceId),
    fullSpan(fixture.inlineEvidenceId),
    fullSpan(fixture.isolatedEvidenceId),
    fullSpan(fixture.secondIsolatedEvidenceId),
    fullSpan(fixture.otherIsolatedEvidenceId),
  ];
  const [routed] = await (fixture.controller as any).routeSelectorCompilerEvidenceReads([{
    code: "selector_reference_component_item_mismatch",
    path: "/references/0/component_dispositions/0/item_keys",
    details: {
      uncovered_span_ids: spanIds,
      actual: { component_span_ids: spanIds, item_keys: ["neutral-item"] },
      candidate_read_tools: [
        "read_target_selectors", "read_document_reference_evidence",
        "read_reference_facts", "open_evidence", "locate_evidence_span",
      ],
      next_tools: [
        "read_target_selectors", "read_document_reference_evidence",
        "read_reference_facts", "open_evidence", "stage_target_selector_draft",
      ],
      tool_argument_hints: {
        open_evidence: { evidence_id: "来自任一 component span", cursor: 0 },
        read_document_reference_evidence: { target_key: "猜测的 inline key", cursor: 0, limit: 24 },
        read_reference_facts: { target_key: "猜测的 isolated key" },
      },
    },
  }]) as any[];

  expect(routed.details.source_access).toEqual(expect.arrayContaining([
    expect.objectContaining({
      evidence_id: fixture.directEvidenceId,
      read_tool: "open_evidence",
      tool_arguments: { evidence_id: fixture.directEvidenceId, cursor: 0 },
    }),
    expect.objectContaining({
      evidence_id: fixture.inlineEvidenceId,
      read_tool: "read_document_reference_evidence",
      tool_arguments: { target_key: fixture.inlineTargetKey, cursor: 0, limit: 24 },
    }),
    expect.objectContaining({
      evidence_id: fixture.isolatedEvidenceId,
      read_tool: "read_reference_facts",
      tool_arguments: { target_key: fixture.isolatedTargetKey },
    }),
    expect.objectContaining({
      evidence_id: fixture.secondIsolatedEvidenceId,
      read_tool: "read_reference_facts",
      tool_arguments: { target_key: fixture.isolatedTargetKey },
    }),
    expect.objectContaining({
      evidence_id: fixture.otherIsolatedEvidenceId,
      read_tool: "read_reference_facts",
      tool_arguments: { target_key: fixture.otherIsolatedTargetKey },
    }),
  ]));
  expect(routed.details.source_access.filter((access: Record<string, any>) =>
    access.read_tool === "read_reference_facts"
  )).toEqual([
    expect.objectContaining({
      evidence_id: fixture.isolatedEvidenceId,
      access_mode: "isolated_reference",
      open_evidence_allowed: false,
      target_key: fixture.isolatedTargetKey,
      tool_arguments: { target_key: fixture.isolatedTargetKey },
    }),
    expect.objectContaining({
      evidence_id: fixture.secondIsolatedEvidenceId,
      access_mode: "isolated_reference",
      open_evidence_allowed: false,
      target_key: fixture.isolatedTargetKey,
      tool_arguments: { target_key: fixture.isolatedTargetKey },
    }),
    expect.objectContaining({
      evidence_id: fixture.otherIsolatedEvidenceId,
      access_mode: "isolated_reference",
      open_evidence_allowed: false,
      target_key: fixture.otherIsolatedTargetKey,
      tool_arguments: { target_key: fixture.otherIsolatedTargetKey },
    }),
  ]);
  expect(routed.details.tool_argument_hints).toMatchObject({
    open_evidence: { evidence_id: fixture.directEvidenceId, cursor: 0 },
    read_document_reference_evidence: {
      target_key: fixture.inlineTargetKey,
      cursor: 0,
      limit: 24,
    },
    read_reference_facts: [
      { target_key: fixture.isolatedTargetKey },
      { target_key: fixture.otherIsolatedTargetKey },
    ],
  });
  const referenceFactHints = routed.details.tool_argument_hints.read_reference_facts as Array<{
    target_key: string;
  }>;
  expect(referenceFactHints).toEqual([
    { target_key: fixture.isolatedTargetKey },
    { target_key: fixture.otherIsolatedTargetKey },
  ]);
  expect(routed.details.openable_evidence_ids).toEqual([
    fixture.directEvidenceId,
    fixture.inlineEvidenceId,
  ]);
  for (const toolArguments of referenceFactHints) {
    expect(await fixture.controller.dispatch("read_reference_facts", toolArguments)).toMatchObject({
      ok: true,
      target_key: toolArguments.target_key,
    });
  }
  for (const [evidenceId, targetKey] of [
    [fixture.isolatedEvidenceId, fixture.isolatedTargetKey],
    [fixture.secondIsolatedEvidenceId, fixture.isolatedTargetKey],
    [fixture.otherIsolatedEvidenceId, fixture.otherIsolatedTargetKey],
  ]) {
    expect(await fixture.controller.dispatch("open_evidence", { evidence_id: evidenceId })).toMatchObject({
      ok: false,
      error: "isolated_reference_body_access_forbidden",
      target_key: targetKey,
    });
  }
  expect(routed.details.how_to_pass).toContain("严格按 source_access");
  expect(routed.details.how_to_pass).toContain("isolated_reference 不要调用 open_evidence");
});

test("tool descriptions and successful stage receipts use the same Chinese routing contract", async () => {
  const fixture = await routingFixture();
  const descriptions = new Map(createPiTools(fixture.controller).map((tool) => [tool.name, tool.description]));
  expect(descriptions.get("open_evidence")).toContain("isolated只读事实");
  expect(TARGET_SELECTOR_PROTOCOLS.source_access).toContain("read_document_reference_evidence");
  expect(descriptions.get("batch_open_evidence")).toContain("整批在写入前拒绝");
  expect(descriptions.get("search_evidence")).toContain("不暴露隔离正文");
  expect(TARGET_SELECTOR_PROTOCOLS.source_access).toContain("不借 open/search/table/global 工具绕过隔离");

  vi.spyOn(fixture.controller as any, "validateSelectorStageCompleteness").mockResolvedValue({
    ok: true,
    issues: [],
    globalCandidateComplete: false,
  });
  const nextStage = await (fixture.controller as any).advanceTargetSelectorStage("sampling") as any;
  expect(nextStage).toMatchObject({ ok: true, completed_stage: "primary", stage: "sampling" });
  expect(nextStage.instruction).toContain("仅刚完成阶段通过");
  expect(nextStage.instruction).not.toContain("The completed stage");

  (fixture.controller as any).selectorStage = "table";
  const commitStage = await (fixture.controller as any).advanceTargetSelectorStage("commit") as any;
  expect(commitStage).toMatchObject({ ok: true, completed_stage: "table", stage: "commit" });
  expect(commitStage.instruction).toContain("table阶段完整预检已通过");
  expect(commitStage.instruction).not.toContain("The table stage");
});

test("adopted review source overlapping an isolated reference is catalogued but never participates in search", async () => {
  const fixture = await adoptedReviewSourceOverlapFixture();
  const listed = await fixture.controller.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect.soft(byEvidenceId(listed.resources, fixture.reviewSourceId)).toMatchObject({
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_evidence_allowed: false,
    target_key: fixture.isolatedTargetKey,
  });

  const searched = await fixture.controller.dispatch("search_evidence", {
    query: "大型目录规则",
  }) as any;
  expect.soft(byEvidenceId(searched.matches, fixture.reviewSourceId)).toBeUndefined();
  expect.soft(searched.matches).toEqual([]);
  expect.soft(JSON.stringify(searched)).not.toContain(fixture.isolatedText);
});

test("author open_evidence uses raw table provenance when transformed cells are absent from Markdown", async () => {
  const fixture = await crossAtomHtmlIsolationCoverageFixture();
  const listed = await fixture.targetController.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect(byEvidenceId(listed.resources, fixture.reviewSourceId)).toMatchObject({
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_evidence_allowed: false,
    target_key: fixture.targetKey,
  });
  const before = await fixture.workspace.readState();
  const opened = await fixture.targetController.dispatch("open_evidence", {
    evidence_id: fixture.reviewSourceId,
  }) as any;
  expect(opened).toMatchObject({
    ok: false,
    error: "isolated_reference_body_access_forbidden",
    target_key: fixture.targetKey,
  });
  expect(JSON.stringify(opened)).not.toContain(fixture.reviewSourceText);
  expect((await fixture.workspace.readState()).opened_evidence_ids).toEqual(before.opened_evidence_ids);
});

test("an explicit target line does not isolate an unrelated duplicate review-source locator", async () => {
  const fixture = await cumulativeReferenceBudgetFixture();
  const manifest = await fixture.workspace.readEvidenceManifest();
  const isolatedOccurrence = manifest.reference_occurrences[2]!;
  const targetText = manifest.evidence.find((record) =>
    record.evidence_id === isolatedOccurrence.target_evidence_ids[0]
  )!.text;
  const source = await readFile(fixture.workspace.sourceMarkdownPath, "utf8");
  const duplicateStart = source.lastIndexOf(targetText);
  expect(duplicateStart).toBeGreaterThan(source.indexOf(targetText));
  const duplicateId = `review-source:${sha256Text(`${manifest.source.sha256}:${duplicateStart}:${duplicateStart + targetText.length}`)}`;
  await fixture.workspace.extendEvidenceManifest({
    evidence_id: duplicateId,
    kind: "paragraph",
    role: "context",
    locator: `char:${duplicateStart}-${duplicateStart + targetText.length}`,
    text: targetText,
    text_sha256: sha256Text(targetText),
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  });
  const controller = await ToolController.create(fixture.workspace);
  const listed = await controller.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect(byEvidenceId(listed.resources, duplicateId)).toMatchObject({
    access_mode: "direct",
    read_tool: "open_evidence",
    open_evidence_allowed: true,
  });
  expect(await controller.dispatch("open_evidence", { evidence_id: duplicateId }))
    .toMatchObject({ ok: true, text_window: { text: targetText } });
});

test("batch open applies the same isolated overlap gate as a single adopted review-source open", async () => {
  const fixture = await adoptedReviewSourceOverlapFixture();
  expect(await fixture.controller.dispatch("open_evidence", {
    evidence_id: fixture.reviewSourceId,
  })).toMatchObject({
    ok: false,
    error: "isolated_reference_body_access_forbidden",
    target_key: fixture.isolatedTargetKey,
  });
  await fixture.workspace.updateState((state) => {
    const modes = { ...(state.reference_analysis_modes ?? {}) };
    delete modes[`target:${fixture.isolatedTargetKey}`];
    state.reference_analysis_modes = modes;
  });
  const stateBefore = await fixture.workspace.readState();
  const registryBefore = await fixture.workspace.readSourceSpanRegistry();

  const rejected = await fixture.controller.dispatch("batch_open_evidence", {
    evidence_ids: [fixture.directEvidenceId, fixture.reviewSourceId],
  }) as any;
  expect.soft(rejected).toMatchObject({
    ok: false,
    error: "batch_open_contains_isolated_reference_evidence",
    durable_mutation: false,
    openable_evidence_ids: [fixture.directEvidenceId],
    routed_references: [expect.objectContaining({
      target_key: fixture.isolatedTargetKey,
      evidence_ids: [fixture.reviewSourceId],
      read_tool: "read_reference_facts",
      open_evidence_allowed: false,
    })],
  });
  expect.soft(JSON.stringify(rejected)).not.toContain(fixture.isolatedText);
  const stateAfter = await fixture.workspace.readState();
  expect.soft(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect.soft(stateAfter.opened_evidence_window_keys).toEqual(stateBefore.opened_evidence_window_keys);
  expect.soft(stateAfter.reference_analysis_modes).toEqual(stateBefore.reference_analysis_modes);
  expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);

  const assigned = await fixture.controller.dispatch("read_reference_facts", {
    target_key: fixture.isolatedTargetKey,
  }) as any;
  expect.soft(assigned).toMatchObject({ ok: true, target_key: fixture.isolatedTargetKey });
  expect.soft((await fixture.workspace.readState()).reference_analysis_modes?.[
    `target:${fixture.isolatedTargetKey}`
  ]?.analysis_mode).toBe("isolated");
});

test("author full-document search and open route an isolated overlapping atom without body text", async () => {
  const fixture = await routingFixture();
  const stateBefore = await fixture.workspace.readState();
  const searched = await fixture.controller.dispatch("search_global_document_resources", {
    query: "大型目录规则",
  }) as any;
  expect(searched.matches).toEqual([]);
  expect(JSON.stringify(searched)).not.toContain(fixture.isolatedTargetKey);
  expect(JSON.stringify(searched)).not.toContain(fixture.isolatedText);

  const opened = await fixture.controller.dispatch("open_global_document_resource", {
    atom_id: fixture.isolatedParentAtomId,
  }) as any;
  expect(opened).toMatchObject({
    ok: false,
    error: "global_document_resource_isolated_reference",
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_global_document_resource_allowed: false,
    target_key: fixture.isolatedTargetKey,
    next_tool: "read_reference_facts",
    tool_arguments: { target_key: fixture.isolatedTargetKey },
    durable_mutation: false,
  });
  expect(JSON.stringify(opened)).not.toContain(fixture.isolatedText);
  expect((await fixture.workspace.readState()).opened_global_resource_ids)
    .toEqual(stateBefore.opened_global_resource_ids);

  const directSearch = await fixture.controller.dispatch("search_global_document_resources", {
    query: fixture.directGlobalMarker,
  }) as any;
  const directMatch = directSearch.matches[0] as Record<string, any>;
  expect(directMatch).toHaveProperty("preview");
  expect(directMatch).not.toHaveProperty("access_mode", "isolated_reference");
  expect(await fixture.controller.dispatch("open_global_document_resource", {
    atom_id: directMatch.atom_id,
  })).toMatchObject({ ok: true });
});

test("author and coverage full-document readers keep a safe raw range reachable beside an isolated range in one atom", async () => {
  const fixture = await rawSameAtomIsolationFixture();
  const safeQuery = fixture.safeText;
  const manifest = await fixture.workspace.readEvidenceManifest();
  expect(manifest.evidence.some((record) => record.evidence_id === fixture.wholeAtomId)).toBe(true);

  const authorSearch = await fixture.targetController.dispatch(
    "search_global_document_resources",
    { query: safeQuery },
  ) as any;
  const authorSafe = (authorSearch.matches as Array<Record<string, any>>).find((match) =>
    typeof match.preview === "string" && match.preview.includes(safeQuery)
  );
  expect(authorSafe).toMatchObject({
    atom_id: expect.stringMatching(/^source-range:/u),
    parent_atom_id: fixture.wholeAtomId,
    start_line: 3,
    end_line: 3,
    source_range: {
      source_sha256: manifest.source.sha256,
      start: expect.any(Number),
      end: expect.any(Number),
    },
  });
  expect(await fixture.targetController.dispatch("open_global_document_resource", {
    atom_id: authorSafe.atom_id,
  })).toMatchObject({ ok: true, text: expect.stringContaining(safeQuery) });

  const coverageSearch = await fixture.coverageController.dispatch(
    "search_review_document",
    { query: safeQuery },
  ) as any;
  const coverageSafe = (coverageSearch.matches as Array<Record<string, any>>).find((match) =>
    typeof match.snippet === "string" && match.snippet.includes(safeQuery)
  );
  expect(coverageSafe).toMatchObject({
    atom_id: expect.any(String),
    source_range: {
      source_sha256: manifest.source.sha256,
      start: expect.any(Number),
      end: expect.any(Number),
    },
  });
  expect(await fixture.coverageController.dispatch("open_review_document", {
    atom_id: coverageSafe.atom_id,
  })).toMatchObject({
    ok: true,
    evidence: { text: expect.stringContaining(safeQuery) },
  });
});

test("legacy whole-atom evidence overlapping an isolated subrange is protected in author and coverage readers", async () => {
  const fixture = await rawSameAtomIsolationFixture();
  const authorInventory = await fixture.targetController.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect(byEvidenceId(authorInventory.resources, fixture.wholeAtomId)).toMatchObject({
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_evidence_allowed: false,
    target_key: fixture.targetKey,
  });
  expect(await fixture.targetController.dispatch("open_evidence", { evidence_id: fixture.wholeAtomId }))
    .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden", target_key: fixture.targetKey });

  const authorSearch = await fixture.targetController.dispatch("search_evidence", {
    // Search the protected-only term; the alternative term "neutral" is also
    // present in the legitimate direct record under ranked-OR semantics.
    query: "isolated",
  }) as any;
  expect(authorSearch.matches).toEqual([]);
  expect(JSON.stringify(authorSearch)).not.toContain(fixture.wholeAtomId);
  expect(JSON.stringify(authorSearch)).not.toContain(sha256Text(fixture.isolatedText));

  expect(await fixture.coverageController.dispatch("open_review_evidence", {
    evidence_id: fixture.wholeAtomId,
  })).toMatchObject({
    ok: false,
    error: "isolated_reference_body_access_forbidden",
    target_key: fixture.targetKey,
  });
  const coverageSearch = await fixture.coverageController.dispatch("search_review_evidence", {
    query: "isolated",
  }) as any;
  expect(coverageSearch).toMatchObject({ ok: true, matches: [], total_match_resources: 0 });
  expect(JSON.stringify(coverageSearch)).not.toContain(fixture.wholeAtomId);
  expect(JSON.stringify(coverageSearch)).not.toContain(sha256Text(fixture.isolatedText));
});

test("global directory pages readable ranges without keywords, body reads, or isolated content", async () => {
  const fixture = await rawSameAtomIsolationFixture();
  const controller = await ToolController.create(fixture.workspace);
  const before = await Promise.all([fixture.workspace.workingSelectorPath, fixture.workspace.sourceSpanRegistryPath].map(path => readFile(path, "utf8")));
  const { next_event_sequence: _beforeEvent, ...beforeState } = await fixture.workspace.readState();
  const tools = createPiTools(controller);
  expect(tools.some(tool => tool.name === "list_global_document_resources")).toBe(true);
  const rows: any[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = await controller.dispatch("list_global_document_resources", { cursor, limit: 1 }) as any;
    expect(page).toMatchObject({ ok: true, inventory_scope: "directly_readable_global_resources", applicability_checked: false });
    expect(page.instruction).toContain("不是正文、适用结论或调查完成证明");
    expect(JSON.stringify(page)).not.toContain(fixture.isolatedText);
    expect(JSON.stringify(page)).not.toContain(sha256Text(fixture.isolatedText));
    for (const row of page.resources) {
      expect(Check(tools.find(tool => tool.name === row.read_tool)!.parameters, row.tool_arguments)).toBe(true);
      expect(row).not.toHaveProperty("text");
      rows.push(row);
    }
    expect(page.next_cursor === null || page.next_cursor > cursor).toBe(true);
    cursor = page.next_cursor;
  }
  expect(rows.some(row => row.preview.includes(fixture.safeText))).toBe(true);
  expect(new Set(rows.map(row => row.atom_id)).size).toBe(rows.length);
  expect(await Promise.all([fixture.workspace.workingSelectorPath, fixture.workspace.sourceSpanRegistryPath].map(path => readFile(path, "utf8")))).toEqual(before);
  const { next_event_sequence: _afterEvent, ...afterState } = await fixture.workspace.readState();
  expect(afterState).toEqual(beforeState);
  const invalid = await controller.dispatch("list_global_document_resources", { cursor: -1, limit: 1 }) as any;
  expect(invalid).toMatchObject({ ok: false, error: "global_document_catalog_cursor_invalid", actual: { cursor: -1 },
    next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 1 }, budget_consumed: false });
  for (const tool of ["open_global_document_resource", "open_adjacent_document_resource"]) {
    const unknown = await controller.dispatch(tool, { atom_id: "missing-resource", direction: "next" }) as any;
    expect(unknown).toMatchObject({ ok: false, error: "unknown_global_document_resource", atom_id: "missing-resource",
      next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 }, budget_consumed: false });
  }
  for (const [row, direction] of [[rows[0], "previous"], [rows.at(-1), "next"]] as const) {
    const boundary = await controller.dispatch("open_adjacent_document_resource", { atom_id: row.atom_id, direction }) as any;
    expect(boundary).toMatchObject({ ok: false, error: "adjacent_document_resource_missing",
      actual: { atom_id: row.atom_id, direction, adjacent_available: false },
      next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 },
      budget_consumed: false, durable_mutation: false, writable_tool_arguments: ["atom_id", "direction"] });
    expect(Check(tools.find(tool => tool.name === boundary.next_tool)!.parameters, boundary.next_tool_arguments)).toBe(true);
    expect(boundary.instruction).toContain("不证明");
  }
  expect(await controller.dispatch("open_global_document_resource", { atom_id: rows[0].atom_id }))
    .toMatchObject({ ok: true, resource: { atom_id: rows[0].atom_id } });
});

test("global heading navigation excludes protected titles while retaining a complete safe title in the same atom", async () => {
  const fixture = await rawSameAtomIsolationFixture({ isolatedText: "## 8 隔离引用标题", safeText: "## 9 可读来源标题" });
  const controller = await ToolController.create(fixture.workspace);
  const stateBefore = await fixture.workspace.readState();
  const sourcesBefore = await readFile(fixture.workspace.sourceSpanRegistryPath, "utf8");
  const directory = await controller.dispatch("list_global_document_resources", { cursor: 0, limit: 30 }) as any;
  expect(JSON.stringify(directory)).not.toContain(fixture.isolatedText);
  const headings = directory.resources.flatMap((row: any) => row.heading_navigation.headings);
  expect(headings).toEqual([{ line: 3, preview: fixture.safeText, preview_truncated: false }]);
  expect(await readFile(fixture.workspace.sourceSpanRegistryPath, "utf8")).toBe(sourcesBefore);
  const { next_event_sequence: _afterEvent, ...afterState } = await fixture.workspace.readState();
  const { next_event_sequence: _beforeEvent, ...beforeState } = stateBefore;
  expect(afterState).toEqual(beforeState);
});

test("a safe source-range resource can be registered by its own provenance while a protected range stays closed", async () => {
  const fixture = await rawSameAtomIsolationFixture();
  await fixture.workspace.updateState((state) => {
    delete state.last_valid_fingerprint;
    delete state.last_valid_plan_sha256;
    state.validation_attempts = 0;
  });
  const controller = await ToolController.create(fixture.workspace);
  const search = await controller.dispatch("search_global_document_resources", {
    query: fixture.safeText,
  }) as any;
  expect(search).toMatchObject({ navigation_is_exhaustive: false, total_match_resources: search.matches.length,
    next_tool: "open_global_document_resource", matches: expect.arrayContaining([expect.objectContaining({ read_tool: "open_global_document_resource", tool_arguments: { atom_id: search.matches[0].atom_id } })]) });
  expect(search).not.toHaveProperty("next_tool_arguments");
  expect(Check(createPiTools(controller).find(tool => tool.name === search.matches[0].read_tool)!.parameters, search.matches[0].tool_arguments)).toBe(true);
  expect(search.instruction).toContain("词面匹配");
  expect(search.instruction).toContain("不能证明");
  expect(search.instruction).toContain("fallback");
  const beforeEmptySearch = await Promise.all([fixture.workspace.workingSelectorPath, fixture.workspace.sourceSpanRegistryPath].map(path => readFile(path, "utf8")));
  const { next_event_sequence: beforeEventSequence, ...beforeSearchState } = await fixture.workspace.readState();
  const emptySearch = await controller.dispatch("search_global_document_resources", { query: "不存在的中性搜索文本" }) as any;
  expect(emptySearch).toMatchObject({ matches: [], total_match_resources: 0, navigation_is_exhaustive: false });
  expect(emptySearch).toMatchObject({ next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 } });
  expect(emptySearch.instruction).toContain("不能证明");
  expect(await Promise.all([fixture.workspace.workingSelectorPath, fixture.workspace.sourceSpanRegistryPath].map(path => readFile(path, "utf8")))).toEqual(beforeEmptySearch);
  const { next_event_sequence: afterEventSequence, ...afterSearchState } = await fixture.workspace.readState();
  expect(afterSearchState).toEqual(beforeSearchState);
  expect(afterEventSequence).toBeGreaterThan(beforeEventSequence);
  const safe = search.matches[0] as Record<string, any>;
  expect(safe).toMatchObject({
    atom_id: expect.stringMatching(/^source-range:/u),
    parent_atom_id: fixture.wholeAtomId,
    start_line: 3,
    end_line: 3,
  });
  expect(await controller.dispatch("open_global_document_resource", { atom_id: safe.atom_id }))
    .toMatchObject({ ok: true, resource: { atom_id: safe.atom_id } });
  expect(await controller.dispatch("register_external_dependency", {
    atom_id: safe.atom_id,
    mode: "scope_extension",
    reason: "neutral direct source range belongs to target scope",
  })).toMatchObject({
    ok: false,
    terminal: false,
    error: "scope_extension_requires_precise_blocker",
    resource: expect.objectContaining({ atom_id: safe.atom_id }),
  });
  const registered = await controller.dispatch("register_external_dependency", {
    atom_id: safe.atom_id,
    mode: "dependency",
    reason: "neutral shared context dependency",
  }) as any;
  expect(registered).toMatchObject({
    ok: true,
    dependency_registered: true,
    resource: {
      evidence_id: safe.atom_id,
      atom_id: safe.atom_id,
      locator: `char:${safe.source_range.start}-${safe.source_range.end}`,
      registered_dependency: true,
    },
  });
  const stored = (await fixture.workspace.readEvidenceManifest()).evidence.find((record) =>
    record.evidence_id === safe.atom_id
  );
  expect(stored).toMatchObject({
    evidence_id: safe.atom_id,
    atom_id: safe.atom_id,
    locator: `char:${safe.source_range.start}-${safe.source_range.end}`,
    text: fixture.safeText,
    registered_dependency: true,
  });

  const source = await readFile(fixture.workspace.sourceMarkdownPath, "utf8");
  const isolatedStart = source.indexOf(fixture.isolatedText);
  const isolatedEnd = isolatedStart + fixture.isolatedText.length + 1;
  const protectedRangeId = `source-range:${sha256Text(`${fixture.manifest.source.sha256}\0${isolatedStart}\0${isolatedEnd}`)}`;
  const before = await fixture.workspace.readState();
  const rejected = await controller.dispatch("register_external_dependency", {
    atom_id: protectedRangeId,
    mode: "dependency",
    reason: "must not bypass isolated range",
  }) as any;
  expect(rejected).toMatchObject({
    ok: false,
    error: "global_document_resource_isolated_reference",
    atom_id: protectedRangeId,
    target_key: fixture.targetKey,
    durable_mutation: false,
  });
  expect(JSON.stringify(rejected)).not.toContain(fixture.isolatedText);
  expect((await fixture.workspace.readState()).opened_global_resource_ids)
    .toEqual(before.opened_global_resource_ids);
});

test("coverage protects every raw atom crossed by isolated transformed HTML table rows", async () => {
  const fixture = await crossAtomHtmlIsolationCoverageFixture();
  const searched = await fixture.controller.dispatch("search_review_document", {
    query: fixture.rawCellMarker,
  }) as any;
  expect(searched).toMatchObject({ ok: true, matches: [], total_match_resources: 0 });
  expect(JSON.stringify(searched)).not.toContain(fixture.targetKey);
  expect(JSON.stringify(searched)).not.toContain(fixture.rawCellMarker);
  for (const atomId of fixture.protectedAtomIds) {
    expect(await fixture.controller.dispatch("open_review_document", {
      atom_id: atomId,
    })).toMatchObject({
      ok: false,
      error: "coverage_document_isolated_reference",
      target_keys: [fixture.targetKey],
    });
  }
});

test("an explicit line locator protects only its isolated occurrence when identical text repeats", async () => {
  const fixture = await cumulativeReferenceBudgetFixture();
  const catalog = await fixture.targetController.dispatch("list_reference_occurrences", {
    cursor: 0,
    limit: 100,
  }) as any;
  const isolated = catalog.occurrences[2] as Record<string, any>;
  expect(isolated).toMatchObject({ analysis_mode: "isolated" });

  const authorSearch = await fixture.targetController.dispatch(
    "search_global_document_resources",
    { query: fixture.duplicateQuery },
  ) as any;
  const authorProtected = (authorSearch.matches as Array<Record<string, any>>).filter((match) =>
    match.target_key === isolated.target_key
  );
  const authorDirect = (authorSearch.matches as Array<Record<string, any>>).filter((match) =>
    match.access_mode !== "isolated_reference"
  );
  expect(authorProtected).toHaveLength(0);
  expect(authorDirect).toHaveLength(1);
  expect(authorDirect[0]).toHaveProperty("preview");
  expect(await fixture.targetController.dispatch("open_global_document_resource", {
    atom_id: authorDirect[0]!.atom_id,
  })).toMatchObject({ ok: true });

  const coverageSearch = await fixture.coverageController.dispatch(
    "search_review_document",
    { query: fixture.duplicateQuery },
  ) as any;
  const coverageProtected = (coverageSearch.matches as Array<Record<string, any>>).filter((match) =>
    match.target_key === isolated.target_key
  );
  const coverageDirect = (coverageSearch.matches as Array<Record<string, any>>).filter((match) =>
    !match.isolated_target_keys
  );
  expect(coverageProtected).toHaveLength(0);
  expect(coverageDirect).toHaveLength(1);
  expect(coverageDirect[0]).toHaveProperty("snippet");
  expect(await fixture.coverageController.dispatch("open_review_document", {
    atom_id: coverageDirect[0]!.atom_id,
  })).toMatchObject({ ok: true });
});

test("target reference ledger advertises the same cumulative route that the selected reader persists", async () => {
  const fixture = await cumulativeReferenceBudgetFixture();
  const before = await fixture.workspace.readState();
  expect(Object.keys(before.reference_analysis_modes ?? {}).filter((key) => key.startsWith("target:"))).toEqual([]);

  const listed = await fixture.targetController.dispatch("list_reference_occurrences", {
    cursor: 0,
    limit: 100,
  }) as any;
  const occurrences = listed.occurrences as Array<Record<string, any>>;
  expect(occurrences).toHaveLength(3);
  expect.soft(occurrences.map((entry) => entry.analysis_mode)).toEqual([
    "inline",
    "inline",
    "isolated",
  ]);

  for (const occurrence of [occurrences[2]!, occurrences[0]!, occurrences[1]!]) {
    const readTool = occurrence.analysis_mode === "isolated"
      ? "read_reference_facts"
      : "read_document_reference_evidence";
    const output = await fixture.targetController.dispatch(readTool, {
      target_key: occurrence.target_key,
      ...(readTool === "read_document_reference_evidence" ? { cursor: 0, limit: 24 } : {}),
    }) as any;
    const persisted = (await fixture.workspace.readState()).reference_analysis_modes?.[
      `target:${occurrence.target_key}`
    ];
    expect.soft(persisted?.analysis_mode).toBe(occurrence.analysis_mode);
    if (typeof output.analysis_mode === "string") {
      expect.soft(output.analysis_mode).toBe(persisted?.analysis_mode);
    }
  }
});

test("cumulative projection preserves inline budget already used by a same-phase target outside the manifest", async () => {
  const fixture = await cumulativeReferenceBudgetFixture();
  const externalPolicy = {
    analysis_mode: "inline" as const,
    target_text_utf8_bytes: 18 * 1024,
    estimated_compact_page_count: 1,
    evidence_count: 1,
    mode_reason: "within_inline_limits",
  };
  await fixture.workspace.updateState((state) => {
    state.reference_analysis_modes = {
      ...(state.reference_analysis_modes ?? {}),
      "target:reference-target:neutral-external": externalPolicy,
    };
  });

  const listed = await fixture.targetController.dispatch("list_reference_occurrences", {
    cursor: 0,
    limit: 100,
  }) as any;
  const occurrences = listed.occurrences as Array<Record<string, any>>;
  expect.soft(occurrences.map((entry) => entry.analysis_mode)).toEqual([
    "inline",
    "isolated",
    "isolated",
  ]);

  const selected = occurrences[1]!;
  await fixture.targetController.dispatch("read_reference_facts", {
    target_key: selected.target_key,
  });
  const persisted = (await fixture.workspace.readState()).reference_analysis_modes!;
  expect.soft(persisted["target:reference-target:neutral-external"]).toEqual(externalPolicy);
  expect.soft(persisted[`target:${selected.target_key}`]?.analysis_mode).toBe("isolated");
});

test("coverage leaf reference targets advertise the same cumulative read tool that assign persists", async () => {
  const fixture = await cumulativeReferenceBudgetFixture();
  const before = await fixture.workspace.readState();
  expect(Object.keys(before.reference_analysis_modes ?? {}).filter((key) => key.startsWith("coverage:"))).toEqual([]);

  const result = await fixture.coverageController.dispatch("read_candidate_leaf_details", {
    item_ids: [fixture.itemId],
    view: "full",
  }) as any;
  expect(result).toMatchObject({ ok: true, details: [expect.any(Object)] });
  const targets = result.details[0].reference_targets as Array<Record<string, any>>;
  expect(targets).toHaveLength(3);
  expect.soft(targets.map((entry) => [entry.analysis_mode, entry.read_tool])).toEqual([
    ["inline", "read_document_reference_evidence"],
    ["inline", "read_document_reference_evidence"],
    ["isolated", "read_reference_facts"],
  ]);

  for (const target of [targets[2]!, targets[0]!, targets[1]!]) {
    const output = await fixture.coverageController.dispatch(target.read_tool, {
      target_key: target.target_key,
      ...(target.read_tool === "read_document_reference_evidence" ? { cursor: 0, limit: 24 } : {}),
    }) as any;
    const persisted = (await fixture.workspace.readState()).reference_analysis_modes?.[
      `coverage:${target.target_key}`
    ];
    expect.soft(persisted?.analysis_mode).toBe(target.analysis_mode);
    expect.soft(
      persisted?.analysis_mode === "isolated"
        ? "read_reference_facts"
        : "read_document_reference_evidence",
    ).toBe(target.read_tool);
    if (typeof output.analysis_mode === "string") {
      expect.soft(output.analysis_mode).toBe(persisted?.analysis_mode);
    }
  }
});

test("isolated evidence directories serialize only opaque route metadata", async () => {
  const fixture = await rawSameAtomIsolationFixture();
  const expected = {
    evidence_id: fixture.isolatedId,
    access_mode: "isolated_reference",
    read_tool: "read_reference_facts",
    open_evidence_allowed: false,
    target_key: fixture.targetKey,
    tool_arguments: { target_key: fixture.targetKey },
    context_directory: { available: false, unavailable_reasons: ["reference_access_required"] },
  };
  const context = await fixture.targetController.dispatch("get_target_context", { limit: 100 }) as any;
  expect(byEvidenceId(context.resource_inventory, fixture.isolatedId)).toEqual(expected);

  const resources = await fixture.targetController.dispatch("list_evidence_resources", { limit: 100 }) as any;
  expect(byEvidenceId(resources.resources, fixture.isolatedId)).toEqual(expected);

  const sampling = await fixture.targetController.dispatch("list_sampling_rules", { limit: 100 }) as any;
  expect(byEvidenceId(sampling.candidates, fixture.isolatedId)).toEqual(expected);
  expect(byEvidenceId(sampling.navigation_candidates, fixture.isolatedId)).toEqual(expected);
});

test("registered HTML table directories keep safe fragments and gate isolated bodies before mutations", async () => {
  const fixture = await registeredIsolatedHtmlTableFixture();
  const directoryStateBefore = await fixture.workspace.readState();
  const directoryRegistryBefore = await fixture.workspace.readSourceSpanRegistry();
  const directory = await fixture.controller.dispatch("list_table_fragments", {
    cursor: 0,
    limit: 100,
  }) as any;
  expect.soft(directory).toMatchObject({ ok: true });
  expect.soft(directory.fragments).toEqual(expect.arrayContaining([
    expect.objectContaining({ fragment_id: fixture.safeFragmentId }),
    {
      access_mode: "isolated_reference",
      read_tool: "read_reference_facts",
      open_table_fragment_allowed: false,
      target_keys: [fixture.targetKey],
    },
  ]));
  expect.soft(directory.table_expansion_work_packages).toEqual(expect.arrayContaining([
    expect.objectContaining({ table_id: fixture.safeTableKey }),
  ]));
  const directoryText = JSON.stringify(directory);
  expect.soft(directoryText).not.toContain(fixture.fragmentId);
  expect.soft(directoryText).not.toContain(fixture.sentinel);
  expect.soft(directoryText).not.toContain(fixture.isolatedRow.text);
  expect.soft(directoryText).not.toContain(fixture.isolatedRow.text_sha256);
  const directoryStateAfter = await fixture.workspace.readState();
  expect.soft({
    ...directoryStateAfter,
    next_event_sequence: directoryStateBefore.next_event_sequence,
  }).toEqual(directoryStateBefore);
  expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(directoryRegistryBefore);
  const selectors = JSON.parse(await readFile(fixture.workspace.workingSelectorPath, "utf8"));
  const preflight = await (fixture.controller as any).evaluateTargetSelectorPreflight(
    selectors,
    false,
    false,
  );
  expect.soft(preflight.issues).not.toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "table_structure_confirmation_pending",
      details: expect.objectContaining({ table_key: fixture.tableKey }),
    }),
  ]));
  expect.soft(await fixture.controller.dispatch("read_table_summary", {
    table_key: fixture.safeTableKey,
  })).toMatchObject({ ok: true });
  const safeHeader = await fixture.controller.dispatch("open_evidence", {
    evidence_id: fixture.safeHeader.evidence_id,
  });
  expect.soft(safeHeader).toMatchObject({ ok: true });
  expect.soft(await fixture.controller.dispatch("open_evidence", {
    evidence_id: fixture.safeRecord.evidence_id,
  })).toMatchObject({ ok: true });

  const stateBefore = await fixture.workspace.readState();
  const registryBefore = await fixture.workspace.readSourceSpanRegistry();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["read_table_summary", { table_key: fixture.tableKey }],
    ["read_table_rows", { table_key: fixture.tableKey, cursor: 0, limit: 50 }],
    ["read_adjacent_source", { fragment_id: fixture.fragmentId, before: 2, after: 2 }],
  ];
  for (const [tool, input] of calls) {
    const output = await fixture.controller.dispatch(tool, input) as any;
    expect.soft(output).toMatchObject({
      ok: false,
      error: "table_fragment_isolated_reference",
      target_keys: [fixture.targetKey],
      next_tool: "read_reference_facts",
      next_tools: ["read_reference_facts", "read_target_selectors", "stage_target_selector_draft"],
      save_tool: "stage_target_selector_draft",
      durable_mutation: false,
    });
    expect.soft(output.instruction).toContain("读取完成也不会开放隐藏 table-structure 的写权限");
    const serialized = JSON.stringify(output);
    expect.soft(serialized).not.toContain(fixture.sentinel);
    expect.soft(serialized).not.toContain(fixture.isolatedRow.text);
    expect.soft(serialized).not.toContain(fixture.isolatedRow.text_sha256);
    expect.soft(serialized).not.toContain("text_length");
    expect.soft(serialized).not.toContain("utf8_bytes");
    expect.soft(serialized).not.toContain("\"cells\"");
    expect.soft(serialized).not.toContain("row_count");
    const stateAfter = await fixture.workspace.readState();
    expect.soft({ ...stateAfter, next_event_sequence: stateBefore.next_event_sequence }).toEqual(stateBefore);
    expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);
  }

  const saved = await fixture.controller.dispatch("read_saved_table_structure", {}) as any;
  expect.soft(saved).toMatchObject({
    ok: true,
    structure: {
      tables: [expect.objectContaining({
        table_key: fixture.safeTableKey,
        fragment_ids: [fixture.safeFragmentId],
      })],
    },
  });
  expect.soft(saved.structure).not.toHaveProperty("evidence_fingerprint");
  expect.soft(saved).not.toHaveProperty("fingerprint");
  const savedText = JSON.stringify(saved);
  expect.soft(savedText).not.toContain(fixture.fragmentId);
  expect.soft(savedText).not.toContain(fixture.tableKey);
  expect.soft(savedText).not.toContain(fixture.sentinel);
  expect.soft(savedText).not.toContain(fixture.isolatedRow.text);
  expect.soft(savedText).not.toContain(fixture.isolatedRow.text_sha256);
  expect.soft({ ...(await fixture.workspace.readState()), next_event_sequence: stateBefore.next_event_sequence })
    .toEqual(stateBefore);
  expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);

  const rawPlan = await (fixture.controller as any).readTableStructurePlan();
  const hiddenTable = rawPlan.tables.find((table: any) => table.table_key === fixture.tableKey)!;
  const structureBefore = await readFile(join(fixture.workspace.root, "table-structure.json"), "utf8").catch(() => null);
  const hiddenStage = await fixture.controller.dispatch("stage_table_structure", {
    table: hiddenTable,
    remove_table_keys: [],
  }) as any;
  expect.soft(hiddenStage).toMatchObject({
    ok: false,
    error: "table_fragment_isolated_reference",
    target_keys: [fixture.targetKey],
    durable_mutation: false,
  });
  expect.soft(await readFile(join(fixture.workspace.root, "table-structure.json"), "utf8").catch(() => null))
    .toBe(structureBefore);

  const safeTable = saved.structure.tables[0];
  const guessedHiddenRemoval = await fixture.controller.dispatch("stage_table_structure", {
    table: safeTable,
    remove_table_keys: [fixture.tableKey],
  }) as any;
  expect.soft(guessedHiddenRemoval).toMatchObject({
    ok: false,
    error: "unknown_table_structure_remove_key",
    durable_mutation: false,
  });
  expect.soft(JSON.stringify(guessedHiddenRemoval)).not.toContain(fixture.fragmentId);
  expect.soft(await readFile(join(fixture.workspace.root, "table-structure.json"), "utf8").catch(() => null))
    .toBe(structureBefore);

  expect.soft(await fixture.controller.dispatch("locate_evidence_span", {
    evidence_id: fixture.isolatedRow.evidence_id,
    quote: fixture.sentinel,
  })).toMatchObject({
    ok: false,
    error: "isolated_reference_body_access_forbidden",
    target_key: fixture.targetKey,
  });
  const emptyField = {
    value: "",
    composition: "not_applicable",
    source_fragments: [],
    reason: "neutral field is absent",
  };
  expect.soft(await fixture.controller.dispatch("prepare_field_bindings", {
    fields: {
      name: {
        value: fixture.sentinel,
        composition: "verbatim",
        source_fragments: [{ evidence_id: fixture.isolatedRow.evidence_id, text: fixture.sentinel }],
        reason: "neutral binding probe",
      },
      requirement: emptyField,
      method: emptyField,
      quantity: emptyField,
      note: emptyField,
    },
  })).toMatchObject({
    ok: false,
    error: "field_binding_evidence_not_opened",
    evidence_id: fixture.isolatedRow.evidence_id,
  });
  const finalState = await fixture.workspace.readState();
  expect.soft({ ...finalState, next_event_sequence: stateBefore.next_event_sequence }).toEqual(stateBefore);
  expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);
});

test("isolated table navigation explains the independently authored selector grouping key", async () => {
  const fixture = await registeredIsolatedHtmlTableFixture();
  const replies = [
    await fixture.controller.dispatch("list_table_fragments", { limit: 100 }),
    await fixture.controller.dispatch("read_table_summary", { table_key: "author-group" }),
    await fixture.controller.dispatch("read_table_rows", { table_key: "author-group" }),
    await fixture.controller.dispatch("read_table_summary", { table_key: fixture.tableKey }),
  ] as any[];
  for (const reply of replies) {
    expect(reply.selector_table_authoring).toMatchObject({
      writable_paths: ["/items/*/table"],
      read_tool: "read_reference_facts",
      save_tool: "stage_target_selector_draft",
      navigation_key_required: false,
    });
    expect(reply.selector_table_authoring.instruction).toContain("table_key");
    expect(reply.selector_table_authoring.instruction).toContain("locate_evidence_span");
    expect(JSON.stringify(reply)).not.toContain(fixture.sentinel);
    expect(JSON.stringify(reply)).not.toContain(fixture.fragmentId);
  }
  expect(replies[1].error).toBe("unknown_table_key_or_fragment");
  expect(replies[3].error).toBe("table_fragment_isolated_reference");
});

test("target context projects registered isolated table metadata while retaining safe primary work", async () => {
  const fixture = await registeredIsolatedHtmlTableFixture();
  const context = await fixture.controller.dispatch("get_target_context", {
    cursor: 0,
    limit: 100,
  }) as any;

  expect.soft(context).toMatchObject({
    ok: true,
    table_structure_checkpoint: {
      pending_tables: [expect.objectContaining({
        table_key: fixture.safeTableKey,
        fragment_ids: [fixture.safeFragmentId],
      })],
    },
    current_table_work_packages: [expect.objectContaining({
      table_id: fixture.safeTableKey,
    })],
    navigation_candidate_counts: {
      tables: 1,
    },
  });
  expect.soft(context.table_structure_checkpoint).not.toHaveProperty("structure_fingerprint");
  expect.soft(context.target_scope.confirmed_scope_fingerprint).toBe(fixture.scopeFingerprint);
  const tableContext = JSON.stringify({
    table_structure_checkpoint: context.table_structure_checkpoint,
    current_table_work_packages: context.current_table_work_packages,
    table_navigation_count: context.navigation_candidate_counts.tables,
  });
  expect.soft(tableContext).not.toContain(fixture.tableKey);
  expect.soft(tableContext).not.toContain(fixture.fragmentId);
  expect.soft(tableContext).not.toContain(fixture.isolatedRow.text_sha256);
  expect.soft(tableContext).not.toContain(fixture.sentinel);
});

test.each([false, true])("primary table rows overlapping an isolated target stay out of public scope and expansion obligations (continuation=%s)", async continuation => {
  const fixture = await registeredIsolatedHtmlTableFixture({ isolatedTableScope: "primary" });
  expect(fixture.isolatedRow.evidence_scope).toBe("primary");
  if (continuation) {
    await fixture.workspace.updateState(state => {
      state.selector_stage = "table";
      state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 1, best_issue_count: 1, consecutive_non_improvements: 3 };
    });
    await writeFile(join(fixture.workspace.root, "modeling-handoff.json"), JSON.stringify({
      job_id: fixture.workspace.jobId, target_id: fixture.workspace.targetId, revision: fixture.workspace.revision,
      proof: { selector_sha256: sha256Text(await readFile(fixture.workspace.workingSelectorPath, "utf8")) },
    }));
    fixture.controller = await ToolController.create(fixture.workspace);
  }
  await ToolController.create(fixture.workspace);
  const durableObligations = JSON.parse(await readFile(
    join(fixture.workspace.root, "table-expansion-obligations.json"),
    "utf8",
  ));
  expect.soft(durableObligations.work_packages).toEqual(expect.arrayContaining([
    expect.objectContaining({ table_id: fixture.safeTableKey }),
  ]));
  expect.soft(durableObligations.work_packages).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ table_id: fixture.tableKey }),
  ]));
  const durableObligationsText = JSON.stringify(durableObligations);
  expect.soft(durableObligationsText).not.toContain(fixture.isolatedRow.evidence_id);
  expect.soft(durableObligationsText).not.toContain(fixture.sentinel);

  const listed = await fixture.controller.dispatch("list_table_fragments", {
    cursor: 0,
    limit: 100,
  }) as any;
  expect.soft(listed).toMatchObject({
    ok: true,
    fragments: expect.arrayContaining([
      expect.objectContaining({ fragment_id: fixture.safeFragmentId }),
    ]),
    table_expansion_work_packages: [expect.objectContaining({ table_id: fixture.safeTableKey })],
  });

  const context = await fixture.controller.dispatch("get_target_context", {
    cursor: 0,
    limit: 100,
  }) as any;
  const selectors = JSON.parse(await readFile(fixture.workspace.workingSelectorPath, "utf8"));
  const accessByEvidenceId = await (fixture.controller as any).evidenceAccessIndex(false);
  const accessibleEvidence = fixture.controller.evidence.evidence.filter((record) =>
    accessByEvidenceId.get(record.evidence_id)?.access_mode !== "isolated_reference"
  );
  const accessibleEvidenceIds = new Set(accessibleEvidence.map((record) => record.evidence_id));
  const registry = await fixture.workspace.readSourceSpanRegistry();
  const accessibleCoverage = selectorDispositionCoverage({
    selectors,
    evidence: accessibleEvidence,
    spans: registry.spans.filter((span) => accessibleEvidenceIds.has(span.evidence_id)),
  });
  expect.soft(context.target_scope).not.toHaveProperty("confirmed_scope_fingerprint");
  // Startup/resume must use the same access-filtered scope as the public tool.
  const handoff = await fixture.controller.selectorScopeHandoff();
  expect.soft(handoff.target_scope).toEqual(context.target_scope);
  expect.soft(handoff).not.toHaveProperty("target_evidence_fragments");
  expect.soft(context.target_scope.selected_atom_ids).not.toContain(fixture.isolatedRow.evidence_id);
  expect.soft(context.target_scope.primary_source_ranges.every((range: any) =>
    range.end_exclusive_line <= 1 || range.start_line >= 3
  )).toBe(true);
  expect.soft(context.primary_disposition_requirement).toMatchObject({
    evidence_requiring_disposition: accessibleEvidence.filter(evidenceRequiresSelectorDisposition).length,
    uncovered_required_count: accessibleCoverage.uncovered_required_ids.length,
  });
  if (continuation) {
    expect.soft(context.current_source_repair).toMatchObject({
      validation_scope: "source_and_reference_receipt_coverage", budget_consumed: false,
      actual: { issue_count: accessibleCoverage.uncovered_required_ids.length + 2 },
    });
    expect.soft((await fixture.workspace.readState()).selector_protocol?.stage_retries?.consecutive_non_improvements).toBe(3);
    const retries = (await fixture.workspace.readState()).selector_protocol?.stage_retries;
    const selectorsBefore = await readFile(fixture.workspace.workingSelectorPath, "utf8");
    const receiptIssues: any[] = [];
    let repairCursor: number | null = 0;
    while (repairCursor !== null) {
      const details = await fixture.controller.dispatch("get_target_context", { source_repair_cursor: repairCursor, source_repair_limit: 2 }) as any;
      const serialized = JSON.stringify(details);
      expect.soft(serialized).not.toContain(fixture.isolatedRow.evidence_id);
      expect.soft(serialized).not.toContain(fixture.sentinel);
      receiptIssues.push(...details.current_source_repair.selector_issues.filter((issue: any) =>
        issue.code === "selector_registered_reference_receipt_missing"
      ));
      repairCursor = details.current_source_repair?.issue_page.next_cursor ?? null;
    }
    expect(receiptIssues).toHaveLength(2);
    expect(receiptIssues.every(issue => issue.actual.target_evidence_count > 0)).toBe(true);
    expect(receiptIssues.every(issue => !Object.hasOwn(issue.actual, "target_evidence_ids"))).toBe(true);
    expect((await fixture.workspace.readState()).selector_protocol?.stage_retries).toEqual(retries);
    expect(await readFile(fixture.workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
  }

  const preflight = await (fixture.controller as any).evaluateTargetSelectorPreflight(
    selectors,
    false,
    false,
  );
  for (const output of [listed, context, preflight]) {
    const serialized = JSON.stringify(output);
    expect.soft(serialized).not.toContain(fixture.tableKey);
    expect.soft(serialized).not.toContain(fixture.fragmentId);
    expect.soft(serialized).not.toContain(fixture.isolatedRow.evidence_id);
    expect.soft(serialized).not.toContain(fixture.isolatedRow.text);
    expect.soft(serialized).not.toContain(fixture.isolatedRow.text_sha256);
    expect.soft(serialized).not.toContain(fixture.sentinel);
    expect.soft(serialized).not.toContain(fixture.scopeFingerprint);
  }
});

test("safe table staging does not expose a fingerprint bound to isolated evidence", async () => {
  const fixture = await registeredIsolatedHtmlTableFixture();
  const saved = await fixture.controller.dispatch("read_saved_table_structure", {}) as any;
  const safeTable = saved.structure.tables.find((table: any) =>
    table.table_key === fixture.safeTableKey
  );
  const staged = await fixture.controller.dispatch("stage_table_structure", {
    table: safeTable,
    remove_table_keys: [],
  }) as any;

  expect.soft(staged).toMatchObject({ ok: true, table_key: fixture.safeTableKey });
  expect.soft(staged).not.toHaveProperty("structure_fingerprint");
  const checkpoint = JSON.parse(await readFile(
    join(fixture.workspace.root, "table-structure-checkpoint.json"),
    "utf8",
  ));
  expect.soft(checkpoint).toHaveProperty("structure_fingerprint");
  expect.soft(checkpoint).toHaveProperty("evidence_fingerprint");
});

test("saved mixed table keys project inaccessible fragments without hiding their safe members", async () => {
  const fixture = await registeredIsolatedHtmlTableFixture();
  const rawPlan = await (fixture.controller as any).readTableStructurePlan();
  const hiddenTable = rawPlan.tables.find((table: any) => table.table_key === fixture.tableKey)!;
  const safeTable = rawPlan.tables.find((table: any) => table.table_key === fixture.safeTableKey)!;
  const mixedTable = {
    ...safeTable,
    fragment_ids: [...safeTable.fragment_ids, ...hiddenTable.fragment_ids],
    formal_title_span_ids: [...safeTable.formal_title_span_ids, ...hiddenTable.formal_title_span_ids],
    header_rows: [...safeTable.header_rows, ...hiddenTable.header_rows],
    data_rows: [...safeTable.data_rows, ...hiddenTable.data_rows],
    repeated_header_rows: [...safeTable.repeated_header_rows, ...hiddenTable.repeated_header_rows],
    note_rows: [...safeTable.note_rows, ...hiddenTable.note_rows],
    context_rows: [...safeTable.context_rows, ...hiddenTable.context_rows],
    review_rows: [...safeTable.review_rows, ...hiddenTable.review_rows],
    row_role_overrides: [...safeTable.row_role_overrides, ...hiddenTable.row_role_overrides],
    continuation_caption_span_ids: [
      ...safeTable.continuation_caption_span_ids,
      ...hiddenTable.continuation_caption_span_ids,
    ],
    note_span_ids: [...safeTable.note_span_ids, ...hiddenTable.note_span_ids],
    reason: `safe fragment retained; isolated history: ${fixture.sentinel} ${fixture.fragmentId} ${fixture.isolatedRow.text_sha256}`,
  };
  await writeFile(join(fixture.workspace.root, "table-structure.json"), JSON.stringify({
    ...rawPlan,
    tables: [mixedTable],
  }), "utf8");

  const stateBefore = await fixture.workspace.readState();
  const registryBefore = await fixture.workspace.readSourceSpanRegistry();
  const saved = await fixture.controller.dispatch("read_saved_table_structure", {}) as any;
  expect.soft(saved).toMatchObject({
    ok: true,
    structure: {
      tables: [expect.objectContaining({
        table_key: fixture.safeTableKey,
        fragment_ids: [fixture.safeFragmentId],
      })],
    },
  });
  const serialized = JSON.stringify(saved);
  expect.soft(serialized).not.toContain(fixture.fragmentId);
  expect.soft(serialized).not.toContain(fixture.tableKey);
  expect.soft(serialized).not.toContain(fixture.sentinel);
  expect.soft(serialized).not.toContain(fixture.isolatedRow.text);
  expect.soft(serialized).not.toContain(fixture.isolatedRow.text_sha256);
  expect.soft(saved.structure.tables[0].reason).not.toContain(fixture.sentinel);

  const directory = await fixture.controller.dispatch("list_table_fragments", {
    cursor: 0,
    limit: 100,
  }) as any;
  expect.soft(directory.table_expansion_work_packages).toEqual(expect.arrayContaining([
    expect.objectContaining({ table_id: fixture.safeTableKey }),
  ]));
  const selectors = JSON.parse(await readFile(fixture.workspace.workingSelectorPath, "utf8"));
  const preflight = await (fixture.controller as any).evaluateTargetSelectorPreflight(
    selectors,
    false,
    false,
  );
  expect.soft(preflight.issues).not.toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "table_structure_confirmation_pending",
      details: expect.objectContaining({ table_key: fixture.tableKey }),
    }),
  ]));
  expect.soft({ ...(await fixture.workspace.readState()), next_event_sequence: stateBefore.next_event_sequence })
    .toEqual(stateBefore);
  expect.soft(await fixture.workspace.readSourceSpanRegistry()).toEqual(registryBefore);

  const summary = await fixture.controller.dispatch("read_table_summary", {
    table_key: fixture.safeTableKey,
  }) as any;
  expect.soft(summary).toMatchObject({
    ok: true,
    table_key: fixture.safeTableKey,
    fragment_ids: [fixture.safeFragmentId],
  });
  expect.soft(summary.saved_decision.reason).not.toContain(fixture.sentinel);
  const rows = await fixture.controller.dispatch("read_table_rows", {
    table_key: fixture.safeTableKey,
    cursor: 0,
    limit: 50,
  }) as any;
  expect.soft(rows).toMatchObject({ ok: true, table_key: fixture.safeTableKey });
  for (const output of [summary, rows]) {
    const outputText = JSON.stringify(output);
    expect.soft(outputText).not.toContain(fixture.fragmentId);
    expect.soft(outputText).not.toContain(fixture.tableKey);
    expect.soft(outputText).not.toContain(fixture.sentinel);
    expect.soft(outputText).not.toContain(fixture.isolatedRow.text);
    expect.soft(outputText).not.toContain(fixture.isolatedRow.text_sha256);
  }

  const confirmedSafe = {
    ...saved.structure.tables[0],
    status: "confirmed",
    header_rows: [fixture.safeHeader.evidence_id],
    data_rows: saved.structure.tables[0].review_rows.filter((rowId: string) =>
      rowId !== fixture.safeHeader.evidence_id
    ),
    review_rows: [],
    reason: "safe fragment independently confirmed from its visible header and data rows",
  };
  const staged = await fixture.controller.dispatch("stage_table_structure", {
    table: confirmedSafe,
    remove_table_keys: [],
  }) as any;
  expect.soft(staged).toMatchObject({
    ok: true,
    table_key: fixture.safeTableKey,
    validation: { ok: true },
  });
  const afterStage = JSON.parse(await readFile(
    join(fixture.workspace.root, "table-structure.json"),
    "utf8",
  ));
  const retainedHidden = afterStage.tables.find((table: any) =>
    table.fragment_ids.includes(fixture.fragmentId)
  );
  expect.soft(retainedHidden).toMatchObject({
    table_key: fixture.safeTableKey,
    status: mixedTable.status,
    reason: mixedTable.reason,
    fragment_ids: [fixture.fragmentId],
    formal_title_span_ids: hiddenTable.formal_title_span_ids,
    header_rows: hiddenTable.header_rows,
    data_rows: hiddenTable.data_rows,
    repeated_header_rows: hiddenTable.repeated_header_rows,
    note_rows: hiddenTable.note_rows,
    context_rows: hiddenTable.context_rows,
    review_rows: hiddenTable.review_rows,
    row_role_overrides: hiddenTable.row_role_overrides,
    continuation_caption_span_ids: hiddenTable.continuation_caption_span_ids,
    note_span_ids: hiddenTable.note_span_ids,
  });
  expect.soft(afterStage.tables.find((table: any) =>
    table.fragment_ids.includes(fixture.safeFragmentId)
  )).toMatchObject({
    table_key: fixture.safeTableKey,
    status: "confirmed",
    fragment_ids: [fixture.safeFragmentId],
    reason: confirmedSafe.reason,
  });

  const reread = await fixture.controller.dispatch("read_saved_table_structure", {}) as any;
  expect.soft(reread.structure.tables).toEqual([
    expect.objectContaining({
      table_key: fixture.safeTableKey,
      status: "confirmed",
      fragment_ids: [fixture.safeFragmentId],
    }),
  ]);
  const restaged = await fixture.controller.dispatch("stage_table_structure", {
    table: { ...reread.structure.tables[0], reason: `${confirmedSafe.reason}; restaged` },
    remove_table_keys: [],
  }) as any;
  expect.soft(restaged).toMatchObject({ ok: true, validation: { ok: true } });
  const postStageSelectors = JSON.parse(await readFile(
    fixture.workspace.workingSelectorPath,
    "utf8",
  ));
  const postStagePreflight = await (fixture.controller as any).evaluateTargetSelectorPreflight(
    postStageSelectors,
    false,
    false,
  );
  expect.soft(postStagePreflight.issues).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "table_structure_confirmation_pending" }),
    expect.objectContaining({
      code: "selector_table_expansion_obligations_pending",
      details: expect.objectContaining({ table_id: fixture.tableKey }),
    }),
  ]));
  const postStagePreflightText = JSON.stringify(postStagePreflight);
  for (const hiddenValue of [
    fixture.fragmentId,
    fixture.tableKey,
    fixture.sentinel,
    fixture.isolatedRow.evidence_id,
    fixture.isolatedRow.text,
    fixture.isolatedRow.text_sha256,
    mixedTable.reason,
    ...hiddenTable.header_rows,
    ...hiddenTable.data_rows,
    ...hiddenTable.repeated_header_rows,
    ...hiddenTable.note_rows,
    ...hiddenTable.context_rows,
    ...hiddenTable.review_rows,
  ]) {
    expect.soft(postStagePreflightText).not.toContain(hiddenValue);
  }
  const afterRestage = JSON.parse(await readFile(
    join(fixture.workspace.root, "table-structure.json"),
    "utf8",
  ));
  expect.soft(afterRestage.tables.find((table: any) =>
    table.fragment_ids.includes(fixture.fragmentId)
  )).toEqual(retainedHidden);
});
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
