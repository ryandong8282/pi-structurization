import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import { atomicWriteJson, pathExists } from "../src/atomic.js";
import { persistedManifestExtendsPreparedBase, persistedManifestResumeMismatch } from "../src/batch.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  CoverageReviewController,
  coverageFieldScopedReferenceRoutesForItem,
  coverageMandatoryEvidenceIds,
  createCoverageReviewTools,
} from "../src/coverage-review.js";
import { compositeReferenceReviewCandidate, compositeReferenceReviewCandidates, documentReferenceTargetReadIdentity, resolveAndRegisterDocumentReference, resolveDocumentReferenceTarget } from "../src/document-reference.js";
import {
  createReferenceAnalysisTools,
  inlineReferenceReadIssues,
  isolatedReferenceTargetForEvidence,
  ReferenceAnalysisController,
  readInlineReferenceEvidencePage,
  readReferenceCatalog,
  readAnalyzedReferenceCatalog,
  referenceAnalysisIssues,
  referenceAnalysisPolicy,
  REFERENCE_INLINE_PHASE_BYTES_BUDGET,
} from "../src/reference-analysis.js";
import { buildGranularProseCoverageEvidence, buildStructuredTargetEvidence } from "../src/evidence.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { materialize } from "../src/materializer.js";
import {
  runLiveReferenceAnalysis,
  TARGET_MODELING_PHASE_LIMITS,
  TargetModelingPhaseBudget,
  terminalToolFailure,
} from "../src/pi-runtime.js";
import {
  classifySelectorIssues,
  classifyStrictSelectorIssues,
} from "../src/selector-issue-ownership.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  registeredDocumentReferenceReceiptIssues,
  REFERENCE_APPLICATION_MODE_SEMANTICS,
  selectorItemsMaterializeReferencedTable,
  TARGET_SELECTOR_PLAN_JSON_SCHEMA,
  TargetSelectorCompileError,
  targetSelectorFingerprint,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { ToolController, createPiTools, referenceBindingOscillation, validFixturePlan } from "../src/tools.js";
import { clauseReferenceGroupLocalResidual, clauseReferenceLocalResidual, validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { selectorFieldDiagnostic } from "../src/selector-diagnostics.js";
import { locateAndRegisterSourceQuote } from "../src/source-span-registry.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import { initialTableStructurePlan } from "../src/table-structure.js";
import { compileSemanticDecisionsV8, semanticDecisionsFromPlan } from "../src/semantic-decision-compiler.js";

const SOURCE = [
  "# 1 基础规定",
  "# 1.1 通用要求",
  "1.1.1 基础要求应符合下列规定：",
  "1 第一款原文。",
  "2 第二款精确原文。",
  "3 第三款原文。",
  "1.1.2 后续条文。",
  "# 1.2 后续小节",
  "1.2.1 后续小节正文。",
  "表 1.2.1-1 被引限值",
  "<table><tr><td>项目</td><td>序号</td><td>检查项目</td><td>单位</td><td>允许值</td><td>检查方法</td></tr><tr><td>主控项目</td><td>1</td><td>间距</td><td>mm</td><td>10</td><td>尺量</td></tr></table>",
  "# 6 安装检验",
  "# 6.2 保护措施",
  "6.2.1 安装间距应符合本规范第 1.1.1 条第 2 款的规定。",
  "# 附录 A 试验方法",
  "A.0.1 附录正文。",
].join("\n");

const MIXED_FIRST = "1 缆线不得布放在电梯或供水、供气、供暖管道竖井中，亦不宜布放在强电竖井中。当与强电共用竖井布放时，缆线的布放应符合本规范第6.1.1条第8款的规定。";
const MIXED_SECOND = "2 电信间、设备间、进线间之间干线通道应沟通。";
const GB50312_MIXED_REFERENCE = [
  "# 6.1 缆线的敷设",
  "6.1.1 缆线的敷设应符合下列规定：",
  "8 综合布线系统缆线与其他管线的间距应符合设计文件要求。",
  "表 6.1.1-2 对绞电缆与电力电缆最小净距",
  "<table><tr><td>条件</td><td>小于2kV·A</td><td>2kV·A～5kV·A</td></tr><tr><td>平行敷设</td><td>130</td><td>300</td></tr></table>",
  "6.1.2 后续条文。",
  "# 6.2 保护措施",
  "6.2.3 干线子系统缆线敷设的保护方式应符合下列规定：",
  MIXED_FIRST,
  MIXED_SECOND,
].join("\n");

async function tempRoot(label: string): Promise<string> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function receiptEvidence(
  workspace: RevisionWorkspace,
  receipt: Record<string, unknown>,
): Promise<Array<{ evidence_id: string; span_id: string; text: string }>> {
  const manifest = await workspace.readEvidenceManifest();
  const registry = await workspace.readSourceSpanRegistry();
  const occurrence = manifest.reference_occurrences.find((entry) => entry.occurrence_id === receipt.occurrence_id)!;
  const records = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  return occurrence.target_evidence_ids.map((evidenceId) => {
    const record = records.get(evidenceId)!;
    const span = registry.spans.find((candidate) => candidate.evidence_id === evidenceId && candidate.start === 0 && candidate.end === record.text.length)!;
    return { evidence_id: evidenceId, span_id: span.span_id, text: record.text };
  });
}

test("missing registered receipts point to exact catalog rows without granting source reads or choosing bindings", async () => {
  const origins = ["6.1.1 第一装置应符合第 2.1.1 条的规定。", "6.1.2 第二装置应符合第 2.1.1 条的规定。"];
  const source = ["2.1.1 装置表面应平整。", "2.1.2 后续要求。", ...origins].join("\n");
  const manifest = manifestFor(source, origins);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("neutral-reference-receipt-routes"),
    manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source) });
  const controller = await ToolController.create(workspace);
  for (const origin of origins) {
    const record = manifest.evidence.find(row => row.text === origin)!;
    const span = (await workspace.readSourceSpanRegistry()).spans.find(row => row.evidence_id === record.evidence_id)!;
    await controller.dispatch("open_evidence", { evidence_id: record.evidence_id, cursor: 0 });
    expect(await controller.dispatch("resolve_document_reference", { origin_span_id: span.span_id,
      origin_field: "requirement", raw_reference: "第 2.1.1 条", target: { kind: "clause", number: "2.1.1" },
      relation: "requirement_adoption" })).toMatchObject({ ok: true });
  }
  const current = await workspace.readEvidenceManifest();
  expect(current.reference_occurrences).toHaveLength(2);
  const legacy = { ...current.reference_occurrences[0]!, occurrence_id: "legacy-without-literal",
    reference_literal_span_id: undefined, reference_literal_span_ids: [] };
  const { evidence_fingerprint: _fingerprint, ...content } = current;
  const mixedContent = { ...content, reference_occurrences: [legacy, ...current.reference_occurrences],
    scope: { ...content.scope, reference_candidates: origins.map((origin, index) => ({
      candidate_id: `navigation-${index}`, evidence_id: manifest.evidence.find(row => row.text === origin)!.evidence_id,
      exact_fragment: "第 2.1.1 条", discovery_basis: "text-retrieval" as const, reason: "合成导航候选。",
    })) } };
  const mixed = { ...mixedContent, evidence_fingerprint: sha256Json(mixedContent) };
  await chmod(workspace.evidenceManifestPath, 0o644);
  await atomicWriteJson(workspace.evidenceManifestPath, mixed);
  await chmod(workspace.evidenceManifestPath, 0o444);
  const resumed = await ToolController.create(workspace);
  const selectors = initialTargetSelectorPlan(mixed);
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  const registry = await workspace.readSourceSpanRegistry();
  const issues = registeredDocumentReferenceReceiptIssues(selectors, mixed, registry);
  expect(issues).toHaveLength(2);
  const stateBefore = await workspace.readState();
  for (const [index, issue] of issues.entries()) {
    const args = issue.details.next_tool_arguments;
    expect(issue.details).toMatchObject({ manifest_index: index + 1, next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: index + 1, limit: 1,
        candidate_cursor: mixed.scope.reference_candidates?.length ?? 0, candidate_limit: 1 } });
    const page = await resumed.dispatch(issue.details.next_tool as string, args as Record<string, unknown>);
    expect(page.ok).toBe(true);
    expect(page.occurrences).toHaveLength(1);
    expect((page.occurrences as any[])[0]).toMatchObject({ occurrence_id: current.reference_occurrences[index]!.occurrence_id,
      target_key: expect.any(String), analysis_mode: expect.any(String) });
    expect(page.navigation_candidates).toEqual([]);
  }
  const { next_event_sequence: _beforeEvents, ...before } = stateBefore;
  const { next_event_sequence: _afterEvents, ...after } = await workspace.readState();
  expect(after).toEqual(before);
  expect(await workspace.readSourceSpanRegistry()).toEqual(registry);
  expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))).toEqual(selectors);
  expect(registeredDocumentReferenceReceiptIssues(selectors, mixed, registry)).toEqual(issues);
});

test("single clause reference reports omitted components through an executable source route", async () => {
  const origin = "6.1.1 装置验收应符合第 2.1.1 条的规定。本项不进行数量抽样。";
  const source = ["2.1.1 装置应符合下列规定：", "1 表面应平整。", "2 连接应牢固。", "2.1.2 后续条款。", origin].join("\n");
  const manifest = manifestFor(source, origin);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("neutral-reference-inventory"), manifest.job_id, manifest.target_id,
    { manifest, markdown: Buffer.from(source) });
  const controller = await ToolController.create(workspace);
  const originSpan = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  const receipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan, origin_field: "requirement", raw_reference: "第 2.1.1 条",
    target: { kind: "clause", number: "2.1.1" }, relation: "requirement_adoption",
  });
  expect(receipt.ok).toBe(true);
  const parts = await receiptEvidence(workspace, receipt);
  const first = parts.find(row => row.text === "1 表面应平整。")!;
  const second = parts.find(row => row.text === "2 连接应牢固。")!;
  const lead = parts.find(row => row.text.startsWith("2.1.1"))!;
  const currentManifest = await workspace.readEvidenceManifest();
  const registry = await workspace.readSourceSpanRegistry();
  const selectors = initialTargetSelectorPlan(currentManifest);
  selectors.lots = [{ key: "lot", name: "装置验收", scope_span_ids: [originSpan], reason: "本地来源限定的验收范围。" }];
  const absent = { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "原文未给。" };
  selectors.items = [{ key: "receiver", lot_key: "lot", name: "装置表面与连接", category: "一般项目",
    criterion_span_ids: [originSpan], continuation_span_ids: [],
    fields: { name: { composition: "semantic_summary", span_ids: [originSpan], separator: "", reason: "本地对象。" },
      requirement: { composition: "verbatim", span_ids: [originSpan], separator: "", reason: "保留引用字面及范围。" },
      method: absent, quantity: absent, note: absent },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "原文验收要求。", inspection_data_type_span_ids: [originSpan],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [originSpan], reason: "原文明示不进行数量抽样。", confidence: 1 },
    reason: "通过内联附件保留被引判据。" }];
  selectors.references = [{ key: "route", occurrence_id: receipt.occurrence_id as string,
    anchor_span_ids: [receipt.reference_literal_span_id as string], target_span_ids: [first.span_id],
    action: "adopt", application_mode: "reference_only", destinations: [{ item_key: "receiver", target_field: "requirement" }],
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用用于判据。" }, reason: "原字段的内联附件保留已解析判据。" }];
  selectors.source_dispositions = [{ span_ids: [lead.span_id], disposition: "context", reason: "列项引导语，业务由两个分项展开。" }];
  let issue: unknown;
  try { compileTargetSelectors(selectors, registry, currentManifest); }
  catch (error) {
    expect(error).toBeInstanceOf(TargetSelectorCompileError);
    issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_resolved_reference_components_unaccounted");
  }
  expect(issue).toMatchObject({ details: { evidence_ids: [second.evidence_id] } });
  const [routed] = await (controller as any).routeSelectorCompilerEvidenceReads([issue]);
  expect(routed.details.how_to_pass).toContain("not_applicable");
  expect(routed.details.how_to_pass).toContain("source_dispositions");
  expect(routed.details.how_to_pass).not.toContain("actual.item_keys");
  expect(routed.details.actual).toEqual({ resolved_component_count: parts.length, unaccounted_component_count: 1 });
  expect(routed.details.source_access[0]).toMatchObject({ evidence_id: second.evidence_id, next_tool: "read_document_reference_evidence" });
  const route = routed.details.source_access[0];
  expect(await controller.dispatch(route.next_tool, route.tool_arguments)).toMatchObject({ ok: true });
  selectors.references[0]!.target_span_ids.push(second.span_id);
  expect(() => compileTargetSelectors(selectors, registry, currentManifest)).not.toThrow();
});

test("invalid internal locator is rejected before registering a durable missing dependency", async () => {
  const origin = "6.1.1 材料试验执行《材料试验规程》QX 1234；连接检查按第 2.1.1 条，复核按第 9.9.9 条。";
  const source = ["2.1.1 连接应牢固。", "2.1.2 后续条款。", origin].join("\n");
  const manifest = manifestFor(source, origin);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("neutral-invalid-reference-locator"), manifest.job_id, manifest.target_id,
    { manifest, markdown: Buffer.from(source) });
  const controller = await ToolController.create(workspace);
  const originSpan = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  const before = (await workspace.readEvidenceManifest()).reference_occurrences;
  const invalid = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan, origin_field: "requirement", raw_reference: "《材料试验规程》QX 1234",
    target: { kind: "clause", number: "unknown" }, relation: "按原文核对来源。",
  });
  expect(invalid).toMatchObject({ ok: false, error: "invalid_internal_reference_locator", budget_consumed: false,
    requested_target: { kind: "clause", number: "unknown" }, next_tool: "open_evidence",
    writable_paths: ["/target", "/raw_reference", "/origin_span_id", "/reference_literal_span_id"] });
  expect(invalid.instruction).toContain("尚未登记");
  expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual(before);
  expect(await controller.dispatch(invalid.next_tool as string, invalid.next_tool_arguments as Record<string, unknown>)).toMatchObject({ ok: true });
  expect(await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan, origin_field: "requirement", raw_reference: "第 2.1.1 条",
    target: { kind: "clause", number: "2.1.1" }, relation: "连接检查依据。",
  })).toMatchObject({ ok: true });
  // A valid, genuinely missing numbered reference must retain its gap.
  expect(await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan, origin_field: "requirement", raw_reference: "第 9.9.9 条",
    target: { kind: "clause", number: "9.9.9" }, relation: "复核依据。",
  })).toMatchObject({ ok: false, error: "target_not_found" });
});

test.each(["clause", "table"] as const)("non-item %s reference retains explicit context and lot scope without inventing an item", async (kind) => {
  const literal = kind === "clause" ? "第 2.1.1 条" : "表 2.1.1";
  const origin = `6.1.1 检验批划分应符合${literal}的规定。`;
  const criterion = "6.1.2 装置表面应平整。本项不进行数量抽样。";
  const source = [
    ...(kind === "clause" ? ["2.1.1 检验批按施工区段划分。", "1 北区单独组织验收。", "2 南区单独组织验收。"]
      : ["表 2.1.1 检验批分类", "<table><tr><td>施工区</td><td>组织方式</td></tr><tr><td>北区</td><td>单独组织验收</td></tr><tr><td>南区</td><td>单独组织验收</td></tr></table>"]),
    "2.1.2 后续条款。", origin, criterion,
  ].join("\n");
  const manifest = manifestFor(source, [origin, criterion]);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("neutral-reference-context"), manifest.job_id, manifest.target_id,
    { manifest, markdown: Buffer.from(source) });
  const controller = await ToolController.create(workspace);
  const initialRegistry = await workspace.readSourceSpanRegistry();
  const originSpan = initialRegistry.spans.find(s => manifest.evidence.find(e => e.evidence_id === s.evidence_id)?.text === origin)!.span_id;
  const criterionSpan = initialRegistry.spans.find(s => manifest.evidence.find(e => e.evidence_id === s.evidence_id)?.text === criterion)!.span_id;
  const receipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpan, origin_field: "note", raw_reference: literal,
    target: { kind, number: "2.1.1" }, relation: "检验批组织依据。",
  });
  expect(receipt.ok).toBe(true);
  const parts = await receiptEvidence(workspace, receipt);
  const currentManifest = await workspace.readEvidenceManifest();
  const registry = await workspace.readSourceSpanRegistry();
  const selectors = initialTargetSelectorPlan(currentManifest);
  selectors.lots = [{ key: "lot", name: "装置检验批", scope_span_ids: [originSpan, parts[0]!.span_id], reason: "引用给出检验批组织范围。" }];
  const absent = { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "原文未给出。" };
  selectors.items = [{ key: "surface", lot_key: "lot", name: "装置表面", category: "一般项目", criterion_span_ids: [criterionSpan], continuation_span_ids: [],
    fields: { name: { composition: "semantic_summary", span_ids: [criterionSpan], separator: "", reason: "概括原文对象。" },
      requirement: { composition: "verbatim", span_ids: [criterionSpan], separator: "", reason: "保留独立验收判据。" }, method: absent, quantity: absent, note: absent },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "按原文核查。", inspection_data_type_span_ids: [criterionSpan],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [criterionSpan], reason: "原文明示不进行数量抽样。", confidence: 1 }, reason: "唯一批内验收判断。" }];
  selectors.references = [{ key: "organization", occurrence_id: receipt.occurrence_id as string,
    anchor_span_ids: [receipt.reference_literal_span_id as string], target_span_ids: parts.map(p => p.span_id), action: "keep_reference", application_mode: "reference_placeholder", destinations: [],
    import_scope: { mode: "field_specific", allowed_fields: ["note"], reason: "仅保留检验批组织依据。" },
    component_dispositions: parts.map(p => ({ component_span_ids: [p.span_id], decision: "not_applicable", item_keys: [], reason: "此组件规定检验批组织，不构成批内验收判据。" })),
    reason: "已读组织条款保留为可追溯引用，不附加到表面验收项目。" }];
  // Reasons alone are not a non-item source binding.
  expect(() => compileTargetSelectors(selectors, registry, currentManifest)).toThrow(TargetSelectorCompileError);
  selectors.source_dispositions = parts.slice(1).map(p => ({ span_ids: [p.span_id], disposition: "context", reason: "来源为其他施工区的组织依据，作为有来源上下文保留。" }));
  const compiled = compileTargetSelectors(selectors, registry, currentManifest);
  const plan = hydrateSemanticSourcePlan(compiled, currentManifest);
  expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
  expect(plan.reference_resolutions[0]).toMatchObject({ application_mode: "reference_placeholder", destination_bindings: [], target_evidence_ids: parts.map(p => p.evidence_id) });
  expect(materialize(plan, currentManifest, "neutral-organization-reference").result.inspection_lots[0]!.items).toHaveLength(1);
  expect(plan.acceptance_items[0]!.note).toBe("");
  const missing = structuredClone(selectors);
  missing.source_dispositions.pop();
  expect(() => compileTargetSelectors(missing, registry, currentManifest)).toThrow(TargetSelectorCompileError);
  // A partial context span cannot discharge the rest of a complete component.
  const last = parts.at(-1)!;
  const partial = locateAndRegisterSourceQuote(registry, {
    source_id: last.evidence_id, evidence_id: last.evidence_id, atom_id: last.evidence_id, text: last.text,
  }, last.text.slice(0, 3), { suffix: last.text.slice(3) });
  missing.source_dispositions.push({ span_ids: [partial.spans[0]!.span_id], disposition: "context", reason: "只读了局部文字，不能代替完整来源。" });
  expect(() => compileTargetSelectors(missing, partial.registry, currentManifest)).toThrowError(expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: kind === "clause"
      ? "selector_reference_placeholder_target_uncovered" : "selector_reference_placeholder_table_items_missing" })]),
  }));
});

async function registerExactLiteralSpans(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  fragments: Array<{ evidence_id: string; quote: string }>,
): Promise<{ origin_span_ids: string[]; reference_literal_span_ids: string[] }> {
  let registry = await workspace.readSourceSpanRegistry();
  const records = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const originSpanIds: string[] = [];
  const literalSpanIds: string[] = [];
  for (const fragment of fragments) {
    const record = records.get(fragment.evidence_id)!;
    originSpanIds.push(registry.spans.find((span) =>
      span.evidence_id === record.evidence_id && span.start === 0 && span.end === record.text.length
    )!.span_id);
    const located = locateAndRegisterSourceQuote(registry, {
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    }, fragment.quote);
    registry = located.registry;
    literalSpanIds.push(located.spans[0]!.span_id);
  }
  await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
  return { origin_span_ids: originSpanIds, reference_literal_span_ids: literalSpanIds };
}

function manifestFor(markdown: string, primaryInput: string | string[]): EvidenceManifest {
  const sourceSha = sha256Text(markdown);
  const primaryTexts = Array.isArray(primaryInput) ? primaryInput : [primaryInput];
  const sourceLines = markdown.split("\n");
  const primaryLines = primaryTexts.map((primaryText) =>
    sourceLines.findIndex((line) => line === primaryText) + 1
  );
  const primaryRecords = buildGranularProseCoverageEvidence(
    markdown,
    sourceSha,
    primaryLines.map((primaryLine) => ({
      start_line: primaryLine,
      end_exclusive_line: primaryLine + 1,
    })),
  );
  const evidenceId = primaryRecords[0]!.evidence_id;
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "document-reference-job",
    target_id: "target:document-reference",
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: "source.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered" as const,
      target_id: "target:document-reference",
      source_line_count: sourceLines.length,
      selected_start_line: Math.min(...primaryLines),
      selected_end_exclusive_line: Math.max(...primaryLines) + 1,
      selected_heading: "保护措施",
      selection_reason: "stable section work scope",
      selected_atom_ids: primaryRecords.map((record) => record.evidence_id),
      target_evidence_fragments: primaryRecords.map((record) => ({
        atom_id: record.evidence_id,
        text: record.text,
      })),
      candidates: [],
    },
    evidence: primaryRecords.map((record) => ({ ...record, requires_disposition: true })),
    table_fragments: [],
    reference_occurrences: [],
  };
  return { ...payload, evidence_fingerprint: sha256Json(payload) };
}

async function controllerFor(markdown = SOURCE): Promise<{
  controller: ToolController;
  workspace: RevisionWorkspace;
  manifest: EvidenceManifest;
  originSpanId: string;
}> {
  const primaryText = "6.2.1 安装间距应符合本规范第 1.1.1 条第 2 款的规定。";
  const manifest = manifestFor(markdown, primaryText);
  const workspace = await RevisionWorkspace.createFromEvidence(
    await tempRoot("document-reference"),
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown) },
  );
  const registry = await workspace.readSourceSpanRegistry();
  return {
    controller: await ToolController.create(workspace),
    workspace,
    manifest,
    originSpanId: registry.spans[0]!.span_id,
  };
}

async function isolatedReferenceFixture(referenceRowCount = 25): Promise<{
  workspace: RevisionWorkspace;
  manifest: EvidenceManifest;
  targetKey: string;
}> {
  const origin = "6.2.1 安装要求应符合本规范第 1.1 节的规定。";
  const source = [
    "# 1 基础规定",
    "# 1.1 大型被引节",
    ...Array.from({ length: referenceRowCount }, (_entry, index) => `1.1.${index + 1} 被引要求 ${index + 1}。`),
    "# 6 安装检验",
    origin,
  ].join("\n");
  const manifest = manifestFor(source, origin);
  const workspace = await RevisionWorkspace.createFromEvidence(
    await tempRoot("reference-analysis-transport"),
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(source) },
  );
  const controller = await ToolController.create(workspace);
  const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  const receipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpanId,
    raw_reference: "本规范第 1.1 节",
    target: { kind: "section", number: "1.1" },
    relation: "section_requirement",
  });
  expect(receipt).toMatchObject({ ok: true, analysis_mode: "isolated" });
  return {
    workspace,
    manifest: await workspace.readEvidenceManifest(),
    targetKey: String(receipt.target_key),
  };
}

test("display-field repair feedback keeps open_evidence executable for normal and inline sources", async () => {
  const { controller, workspace, manifest, originSpanId } = await controllerFor();
  const issueFor = (evidenceId: string) => ({
    code: "selector_display_field_span_role_conflict",
    path: "/items/0",
    message: "方法和数量字段复用同一来源区间。",
    details: {
      actual: { offending_binding: { evidence_id: evidenceId } },
      candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
    },
    owner: "selector_input_error",
  });
  const normalEvidenceId = manifest.evidence[0]!.evidence_id;
  const [normal] = await (controller as any).routeSelectorCompilerEvidenceReads([issueFor(normalEvidenceId)]) as any[];
  expect(normal.details).toMatchObject({
    source_access: {
      analysis_mode: "normal", evidence_id: normalEvidenceId,
      next_tool: "open_evidence", tool_arguments: { evidence_id: normalEvidenceId, cursor: 0 },
    },
  });
  expect(normal.details.candidate_read_tools).toContain("open_evidence");
  expect(await controller.dispatch("open_evidence", { evidence_id: normalEvidenceId })).toMatchObject({ ok: true });

  const receipt = await controller.dispatch("resolve_document_reference", {
    origin_span_id: originSpanId,
    raw_reference: "本规范第 1.1.1 条第 2 款",
    target: { kind: "clause", number: "1.1.1", paragraph: "2" },
    relation: "中性 inline 路由回归",
  });
  expect(receipt).toMatchObject({ ok: true, analysis_mode: "inline" });
  const inlineEvidence = (await receiptEvidence(workspace, receipt))[0]!;
  const inlineController = await ToolController.create(workspace);
  const [inline] = await (inlineController as any).routeSelectorCompilerEvidenceReads([issueFor(inlineEvidence.evidence_id)]) as any[];
  expect(inline.details).toMatchObject({
    source_access: {
      analysis_mode: "inline", evidence_id: inlineEvidence.evidence_id,
      next_tool: "open_evidence", tool_arguments: { evidence_id: inlineEvidence.evidence_id, cursor: 0 },
    },
  });
  expect(inline.details.candidate_read_tools).toContain("open_evidence");
  expect(await inlineController.dispatch("open_evidence", { evidence_id: inlineEvidence.evidence_id })).toMatchObject({ ok: true });
});

test("selector repair feedback preserves isolated reference reads and leaves component semantics to the author", async () => {
  const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
  const controller = await ToolController.create(workspace);
  const occurrence = manifest.reference_occurrences.find(entry => (
    entry.status === "resolved"
    && documentReferenceTargetReadIdentity(entry).target_key === targetKey
  ))!;
  const registry = await workspace.readSourceSpanRegistry();
  const targetEvidence = manifest.evidence.find(record => (
    occurrence.target_evidence_ids.includes(record.evidence_id)
    && record.text.includes("被引要求 1")
  ))!;
  const targetSpan = registry.spans.find(span => (
    span.evidence_id === targetEvidence.evidence_id
    && span.start === 0
    && span.end === targetEvidence.text.length
  ))!;
  const originSpanId = occurrence.origin_span_ids?.[0] ?? occurrence.origin_span_id!;
  const literalSpanId = occurrence.reference_literal_span_ids?.[0] ?? occurrence.reference_literal_span_id!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "neutral-lot", name: "中性引用检验批", scope_span_ids: [originSpanId], reason: "只用于验证修复路由。" });
  selectors.items.push({
    key: "neutral-item", lot_key: "neutral-lot", name: "中性被引项", category: "一般项目",
    criterion_span_ids: [targetSpan.span_id], continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [targetSpan.span_id], separator: "", reason: "中性对象名称。" },
      requirement: { composition: "reference", span_ids: [originSpanId, targetSpan.span_id], separator: "\n", reason: "保留本地条件和被引内容。" },
      method: { composition: "reference", span_ids: [targetSpan.span_id], separator: "", reason: "故意复用区间以触发中性反馈。" },
      quantity: { composition: "reference", span_ids: [targetSpan.span_id], separator: "", reason: "故意复用区间以触发中性反馈。" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "本测试不处置备注。" },
    },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "仅验证工具路由。", inspection_data_type_span_ids: [targetSpan.span_id],
    sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "本测试不处置抽样。", confidence: 1 },
    reason: "中性反馈回归项。",
  });
  selectors.references.push({
    key: "neutral-reference", occurrence_id: occurrence.occurrence_id,
    anchor_span_ids: [literalSpanId], target_span_ids: [targetSpan.span_id],
    component_dispositions: [{
      component_span_ids: [targetSpan.span_id], decision: "independent_item",
      item_keys: ["neutral-item", "second-neutral-item"], reason: "故意使用两个接收者以验证两条合法修复路线。",
    }],
    action: "adopt", application_mode: "reference_only",
    import_scope: { mode: "field_specific", allowed_fields: ["requirement", "method", "quantity"], reason: "中性测试的可见字段。" },
    origin_binding: { item_key: "neutral-item", target_field: "requirement" },
    destinations: [{ item_key: "neutral-item", target_field: "requirement" }],
    reason: "保留引用路由以验证反馈，不预设修复后的决策或接收项。",
  });
  selectors.references.push({
    ...structuredClone(selectors.references[0]!),
    key: "neutral-reference-sibling",
    component_dispositions: [{
      component_span_ids: [targetSpan.span_id], decision: "same_judgment",
      item_keys: ["neutral-item"], reason: "只用于让同来源引用组进入组件决策检查。",
    }],
  });

  const compilerIssues = await (controller as any).selectorCompilerIssues(selectors) as any[];
  expect(compilerIssues.some(row => row.code === "selector_display_field_span_role_conflict")).toBe(false);
  const observation = [...(controller as any).modelReviewObservations.values()].find((row: any) => row.code === "selector_display_field_span_role_conflict") as any;
  expect(observation.owner).toBe("model_review");
  expect(selectorFieldDiagnostic(observation, true)).toMatchObject({ severity: "information", decision_owner: "model",
    related_information: { source_access: { analysis_mode: "isolated", target_key: targetKey,
      next_tool: "read_reference_facts", tool_arguments: { target_key: targetKey }, open_evidence_allowed: false } } });
  const roleIssue = { ...observation, details: { ...observation.details,
    ...Object.fromEntries((observation.detail_fields_at_issue_level ?? []).map((key: string) => [key, observation[key]])) } };
  expect(roleIssue.details).toMatchObject({
    source_access: {
      analysis_mode: "isolated", evidence_id: targetEvidence.evidence_id, target_key: targetKey,
      next_tool: "read_reference_facts", tool_arguments: { target_key: targetKey },
    },
    candidate_read_tools: expect.arrayContaining(["read_target_selectors", "read_reference_facts", "locate_evidence_span"]),
    tool_argument_hints: { read_reference_facts: { target_key: targetKey } },
    save_tool: "stage_target_selector_draft",
  });
  expect(roleIssue.details.candidate_read_tools).not.toContain("open_evidence");
  expect(roleIssue.details.how_to_pass).toContain("不得调用 open_evidence 绕过未读闸门");

  const countIssue = compilerIssues.find(row => row.code === "selector_reference_component_independent_item_count");
  expect(countIssue.details).toMatchObject({
    actual: {
      reference_key: "neutral-reference", occurrence_id: occurrence.occurrence_id, disposition_index: 0,
      component_span_ids: [targetSpan.span_id], item_keys: ["neutral-item", "second-neutral-item"], decision: "independent_item",
    },
    writable_paths: [
      "/references/0/component_dispositions/0/item_keys",
      "/references/0/component_dispositions/0/decision",
    ],
    writable_collections: ["references"],
    candidate_read_tools: expect.arrayContaining([
      "read_target_selectors", "list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts",
    ]),
    next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "references", key: "neutral-reference" },
    save_tool: "stage_target_selector_draft",
  });
  expect(countIssue.details.allowed_actions).toHaveLength(2);
  expect(countIssue.details.tool_argument_hints.read_target_selectors).toEqual([
    { collection: "references", key: "neutral-reference" },
    { collection: "items", key: expect.stringContaining("actual.item_keys") },
  ]);
  expect(countIssue.details).not.toHaveProperty("correct_item_key");
  expect(countIssue.details).not.toHaveProperty("recommended_decision");

  expect(await controller.dispatch("open_evidence", { evidence_id: targetEvidence.evidence_id }))
    .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden", target_key: targetKey });
  const readFactsTool = createPiTools(controller).find(tool => tool.name === "read_reference_facts")!;
  const catalogReceipt = await readFactsTool.execute(
    "neutral-catalog-read",
    roleIssue.details.source_access.tool_arguments,
    undefined as never,
    undefined as never,
  ) as { details: Record<string, any> };
  expect(catalogReceipt.details).toMatchObject({ ok: true, target_key: targetKey, catalog: expect.any(Array) });
  expect(await controller.dispatch("open_evidence", { evidence_id: targetEvidence.evidence_id }))
    .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
  const entryId = catalogReceipt.details.catalog[0]!.entry_id as string;
  const openedReceipt = await readFactsTool.execute(
    "neutral-entry-read",
    { target_key: targetKey, entry_ids: [entryId], resolve_rows: [{ entry_id: entryId, row_index: 0 }] },
    undefined as never,
    undefined as never,
  ) as { details: Record<string, any> };
  const resolvedRow = openedReceipt.details.resolved_rows[0] as { evidence_id: string };
  const resolvedEvidence = manifest.evidence.find(record => record.evidence_id === resolvedRow.evidence_id)!;
  expect(await controller.dispatch("locate_evidence_span", {
    evidence_id: resolvedEvidence.evidence_id,
    quote: resolvedEvidence.text.slice(0, 4),
  })).toMatchObject({ ok: true });
});

describe("resolve_document_reference", () => {
  test("keeps every requested member of a fictional section range as a distinct occurrence", async () => {
    const origin = "9.1.1 构件验收应符合第8.2节～第8.4节的规定。";
    const markdown = [
      "# 8.2 甲工法",
      "8.2.1 甲工法检查要求。",
      "# 8.3 乙工法",
      "8.3.1 乙工法检查要求。",
      "# 8.4 丙工法",
      "8.4.1 丙工法检查要求。",
      "# 9.1 本地范围",
      origin,
    ].join("\n");
    const manifest = manifestFor(markdown, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("reference-section-range"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans.find((span) =>
      span.evidence_id === manifest.evidence[0]!.evidence_id
      && span.start === 0
      && span.end === origin.length
    )!.span_id;
    const rangeLiteral = "第8.2节～第8.4节";
    const resolve = (number: string) => controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "requirement",
      raw_reference: rangeLiteral,
      target: { kind: "section", number },
      relation: "逐项核对规范列出的工法",
    });

    expect(await resolve("8.2")).toMatchObject({ ok: true });
    expect(await resolve("8.4")).toMatchObject({ ok: true });
    expect((await workspace.readEvidenceManifest()).reference_occurrences.map((entry) => entry.target_address?.locator))
      .toEqual(["section:8.2", "section:8.4"]);
    expect(await resolve("8.3")).toMatchObject({ ok: true });
    const occurrences = (await workspace.readEvidenceManifest()).reference_occurrences;
    expect(occurrences.map((entry) => entry.target_address?.locator))
      .toEqual(["section:8.2", "section:8.4", "section:8.3"]);
    expect(new Set(occurrences.map((entry) => entry.occurrence_id)).size).toBe(3);
    expect(new Set(occurrences.map((entry) => entry.reference_literal_span_id)).size).toBe(1);
    expect((await controller.dispatch("get_target_selector_contract", {}) as any).authoring_protocols.references)
      .toContain("连续范围核对起止和实际存在的每个目标");
  });

  test("a chapter literal with clause kind returns a retry route before persisting an unresolved occurrence", async () => {
    const origin = "1.1.1 构件验收应符合第 2 章的规定。";
    const markdown = [
      "# 1 总则",
      origin,
      "# 2 材料要求",
      "## 2.1 一般要求",
      "2.1.1 材料应符合设计要求。",
      "# 3 施工要求",
    ].join("\n");
    const manifest = manifestFor(markdown, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("reference-target-kind-retry"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans.find((span) =>
      span.evidence_id === manifest.evidence[0]!.evidence_id
      && span.start === 0
      && span.end === origin.length
    )!.span_id;
    const result = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "requirement",
      raw_reference: "第 2 章",
      target: { kind: "clause", number: "2" },
      relation: "中性章节引用",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "reference_target_kind_mismatch",
      suggested_target: { kind: "section", number: "2" },
      next_tool: "resolve_document_reference",
      next_tool_arguments: {
        origin_span_id: originSpanId,
        raw_reference: "第 2 章",
        target: { kind: "section", number: "2" },
      },
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([]);
    const corrected = await controller.dispatch(
      "resolve_document_reference",
      (result as { next_tool_arguments: Record<string, unknown> }).next_tool_arguments,
    );
    expect(corrected).toMatchObject({ ok: true, occurrence_id: expect.stringMatching(/^reference:/u) });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([
      expect.objectContaining({ status: "resolved", target_address: expect.objectContaining({ locator_kind: "section" }) }),
    ]);
  });

  test.each([
    { kind: "section", number: "1.1", literal: "第 1.1 节" },
    { kind: "clause", number: "1.1.1", literal: "第 1.1.1 条" },
    { kind: "table", number: "1.1.1", literal: "表 1.1.1" },
  ])("inline $kind full-text pages earn durable read receipts only for returned evidence", async ({ kind, number, literal }) => {
    const origin = `6.2.1 本项应符合${literal}的规定。`;
    const source = [
      "# 1.1 引用范围",
      "1.1.1 被引正文甲。",
      "1 后续正文乙。",
      "2 后续正文丙。",
      "表 1.1.1 被引参数",
      "<table><tr><td>项目</td><td>要求</td></tr><tr><td>甲</td><td>原文甲</td></tr><tr><td>乙</td><td>原文乙</td></tr></table>",
      "# 6.2 本地范围",
      origin,
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const artifactRoot = await tempRoot("inline-reference-read-receipt");
    const workspace = await RevisionWorkspace.createFromEvidence(
      artifactRoot, manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const receipt = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, raw_reference: literal, target: { kind, number }, relation: "本地引用",
    });
    expect(receipt).toMatchObject({ ok: true, analysis_mode: "inline" });
    const targets = await receiptEvidence(workspace, receipt);
    expect(targets.length).toBeGreaterThan(1);
    expect(await controller.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: targets.length - 1, limit: 24,
    })).toMatchObject({
      ok: false,
      error: "document_reference_evidence_cursor_mismatch",
      expected_cursor: 0,
      received_cursor: targets.length - 1,
    });
    expect(await inlineReferenceReadIssues(workspace, await workspace.readEvidenceManifest()))
      .toEqual([expect.objectContaining({ code: "inline_reference_read_incomplete" })]);
    const locate = (toolController: ToolController, row: typeof targets[number]) =>
      toolController.dispatch("locate_evidence_span", { evidence_id: row.evidence_id, quote: row.text });
    expect(await locate(controller, targets[0]!)).toMatchObject({ ok: false, error: "span_evidence_not_opened" });
    const before = (await workspace.readState()).opened_evidence_ids;
    expect(await controller.dispatch("read_document_reference_evidence", { target_key: "missing" }))
      .toMatchObject({ ok: false });
    expect((await workspace.readState()).opened_evidence_ids).toEqual(before);
    const page = await controller.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: 0, limit: 1,
    });
    expect(page).toMatchObject({ ok: true, done: false, rows: [{ evidence_id: targets[0]!.evidence_id, text: targets[0]!.text }] });
    expect(await controller.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: 0, limit: 1,
    })).toMatchObject({
      ok: false,
      error: "document_reference_evidence_cursor_mismatch",
      expected_cursor: page.next_cursor,
      received_cursor: 0,
    });
    expect(await locate(controller, targets[0]!)).toMatchObject({ ok: true });
    expect(await locate(controller, targets[1]!)).toMatchObject({ ok: false, error: "span_evidence_not_opened" });
    await workspace.updateState((state) => {
      const legacyProgress = state.document_reference_reads?.[String(receipt.occurrence_id)];
      if (!legacyProgress) throw new Error("expected durable inline reference progress");
      delete legacyProgress.phase;
      delete legacyProgress.read_policy;
      delete legacyProgress.target_key;
    });
    const resumed = await ToolController.create(workspace);
    expect(await locate(resumed, targets[0]!)).toMatchObject({ ok: true });
    expect(await locate(resumed, targets[1]!)).toMatchObject({ ok: false, error: "span_evidence_not_opened" });
    const last = await resumed.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: page.next_cursor, limit: 24,
    });
    expect(last).toMatchObject({ ok: true, done: true });
    expect(await locate(resumed, targets[1]!)).toMatchObject({ ok: true });
    expect(await inlineReferenceReadIssues(workspace, await workspace.readEvidenceManifest())).toEqual([]);

    const completedProgress = (await workspace.readState()).document_reference_reads;
    const freshSession = await ToolController.create(workspace);
    const replayFirst = await freshSession.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: 0, limit: 1,
    });
    expect(replayFirst).toMatchObject({
      ok: true,
      cursor: 0,
      done: false,
      rows: [{ evidence_id: targets[0]!.evidence_id, text: targets[0]!.text }],
    });
    expect(await inlineReferenceReadIssues(workspace, await workspace.readEvidenceManifest())).toEqual([]);
    const replayLast = await freshSession.dispatch("read_document_reference_evidence", {
      target_key: receipt.target_key, cursor: replayFirst.next_cursor, limit: 24,
    });
    expect(replayLast).toMatchObject({
      ok: true,
      done: true,
      rows: expect.arrayContaining([
        expect.objectContaining({ evidence_id: targets[1]!.evidence_id, text: targets[1]!.text }),
      ]),
    });
    expect((await workspace.readState()).document_reference_reads).toEqual(completedProgress);

    await workspace.updateState((state) => {
      for (const progress of Object.values(state.document_reference_reads ?? {})) delete progress.phase;
    });
    expect(await inlineReferenceReadIssues(workspace, await workspace.readEvidenceManifest(), "target")).toEqual([]);
    expect(await inlineReferenceReadIssues(workspace, await workspace.readEvidenceManifest(), "coverage"))
      .toEqual([expect.objectContaining({ code: "inline_reference_read_incomplete" })]);

    const coverageFirst = await readInlineReferenceEvidencePage(
      workspace, await workspace.readEvidenceManifest(), String(receipt.target_key), 0, 1, "coverage",
    );
    expect(coverageFirst).toMatchObject({ ok: true, done: false, cursor: 0 });
    const reopenedForCoverage = await RevisionWorkspace.openLatest(
      artifactRoot, manifest.job_id, manifest.target_id,
    );
    expect(await inlineReferenceReadIssues(reopenedForCoverage, await reopenedForCoverage.readEvidenceManifest(), "coverage"))
      .toEqual([expect.objectContaining({ code: "inline_reference_read_incomplete" })]);
    const coverageLast = await readInlineReferenceEvidencePage(
      reopenedForCoverage, await reopenedForCoverage.readEvidenceManifest(), String(receipt.target_key), Number(coverageFirst.next_cursor), 24, "coverage",
    );
    expect(coverageLast).toMatchObject({ ok: true, done: true });
    expect(await inlineReferenceReadIssues(reopenedForCoverage, await reopenedForCoverage.readEvidenceManifest(), "coverage")).toEqual([]);

    const phaseProgress = (await workspace.readState()).document_reference_reads;
    expect(Object.values(phaseProgress ?? {}).map((progress) => progress.phase ?? "target").sort())
      .toEqual(["coverage", "target"]);
    await atomicWriteJson(
      workspace.sealedPlanPath,
      JSON.parse(await readFile(workspace.workingPlanPath, "utf8")),
    );
    await workspace.updateState((state) => { state.status = "sealed"; });
    const rebuilt = await RevisionWorkspace.reviseFromSealed(
      artifactRoot, manifest.job_id, manifest.target_id, workspace.revision,
    );
    expect((await rebuilt.readState()).document_reference_reads).toEqual(phaseProgress);
    expect(await inlineReferenceReadIssues(rebuilt, await rebuilt.readEvidenceManifest(), "target")).toEqual([]);
    expect(await inlineReferenceReadIssues(rebuilt, await rebuilt.readEvidenceManifest(), "coverage")).toEqual([]);
  });

  test("wrong literal explains the selected text and the unique-match recovery path", async () => {
    const { controller, originSpanId } = await controllerFor();
    const request = { origin_span_id: originSpanId, origin_field: "requirement", raw_reference: "本规范第 1.1.1 条第 2 款", target: { kind: "clause", number: "1.1.1", paragraph: "2" }, relation: "质量要求" };
    const rejected = await controller.dispatch("resolve_document_reference", { ...request, reference_literal_span_id: originSpanId });
    expect(rejected).toMatchObject({ ok: false, error: "invalid_reference_literal_span", details: {
      expected_text: request.raw_reference, received_span_id: originSpanId,
      unique_literal_match: true, required_action: "omit_reference_literal_span_id_and_retry", next_tool: "resolve_document_reference",
    } });
    expect(rejected.instruction).toContain("不要修改来源或编译产物");
    expect(await controller.dispatch("resolve_document_reference", request)).toMatchObject({ ok: true });
  });

  test("short handles resolve cross-chapter references without changing canonical provenance or source text", { timeout: 20_000 }, async () => {
    const {controller,workspace,manifest,originSpanId}=await controllerFor();
    const codec=await ModelSourceHandles.open(workspace.root);
    const tools=codec.wrapTools(createPiTools(controller));
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await tools.find(t=>t.name===name)!.execute(`short-${name}`,args,undefined as any,undefined as any,undefined as any);
      expect(result.details).toMatchObject({ok:true});
      return {visible:JSON.parse((result.content[0] as {text:string}).text),canonical:result.details as Record<string,any>};
    };
    const context=await call("get_target_context",{});
    await call("open_evidence",{evidence_id:context.visible.resource_inventory[0].evidence_id,source_handle_scope:codec.scope});
    const spanView=await codec.encode({origin_span_id:originSpanId}) as Record<string,unknown>;
    const resolved=await call("resolve_document_reference",{...spanView,source_handle_scope:codec.scope,origin_field:"requirement",raw_reference:"本规范第 1.1.1 条第 2 款",target:{kind:"clause",number:"1.1.1",paragraph:"2"},relation:"跨章原位引用"});
    expect(resolved.visible.reference_literal_span_id).toMatch(/^s[0-9]+$/u);
    expect(resolved.canonical.reference_literal_span_id).toMatch(/^span:/u);
    const current=await workspace.readEvidenceManifest();
    const occurrence=current.reference_occurrences.find(o=>o.occurrence_id===resolved.canonical.occurrence_id)!;
    expect(occurrence.origin_evidence_id).toBe(manifest.evidence[0]!.evidence_id);
    expect(current.evidence.filter(e=>occurrence.target_evidence_ids.includes(e.evidence_id)).map(e=>e.text)).toEqual(["2 第二款精确原文。"]);
    const targets=await call("read_document_reference_evidence",{target_key:resolved.canonical.target_key,cursor:0,limit:10});
    expect(await codec.decodeResponse(targets.visible)).toEqual(targets.canonical);
    const reopened=await ModelSourceHandles.open(workspace.root);
    expect(await reopened.decodeArguments({span_ids:[resolved.visible.reference_literal_span_id],source_handle_scope:codec.scope})).toEqual({span_ids:[occurrence.reference_literal_span_id]});
  });

  test("resolves exact paragraph, whole clause, whole section, table, and appendix by structure", () => {
    const sourceId = sha256Text(SOURCE);
    const paragraph = resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "clause", number: "1.1.1", paragraph: "2",
    });
    expect(paragraph).toMatchObject({ ok: true, locator: "clause:1.1.1/paragraph:2" });
    if (paragraph.ok) {
      const expectedParagraph = ["2 第二款精确原文。"];
      expect(paragraph.evidence.map((record) => record.text)).toEqual(expectedParagraph);
    }

    const clause = resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "clause", number: "1.1.1",
    });
    expect(clause.ok && clause.evidence.map((record) => record.text)).toEqual([
      "1.1.1 基础要求应符合下列规定：",
      "1 第一款原文。",
      "2 第二款精确原文。",
      "3 第三款原文。",
    ]);

    const section = resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "section", number: "1.1",
    });
    expect(section.ok && section.evidence.some((record) => record.text === "1.1.2 后续条文。")).toBe(true);
    expect(section.ok && section.evidence.some((record) => record.text === "1.2.1 后续小节正文。")).toBe(false);

    const table = resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "table", number: "1.2.1-1",
    });
    expect(table.ok && table.target_evidence_ids).toHaveLength(1);

    const appendix = resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "appendix", number: "A",
    });
    expect(appendix.ok && appendix.evidence.map((record) => record.text)).toContain("A.0.1 附录正文。");
  });

  test("resumes parser-restored metadata over unchanged prefetched table evidence", async () => {
    const primary = "6.2.1 检验应符合表 A.0.1 的规定。";
    const markdown = ["# 6 安装检验", primary, "# 附录 A 检验方法", "表 A.0.1 抽取数量",
      "<table><tr><td>项目</td><td>允许值</td></tr><tr><td>间距</td><td>10mm</td></tr></table>"].join("\n");
    const rehash = (value: EvidenceManifest): EvidenceManifest => {
      const { evidence_fingerprint: _fingerprint, ...payload } = value;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const structured = buildStructuredTargetEvidence(markdown, sha256Text(markdown),
      [{ start_line: 4, end_exclusive_line: 6 }], false);
    const manifest = rehash({ ...manifestFor(markdown, primary),
      evidence: [...manifestFor(markdown, primary).evidence, ...structured.evidence], table_fragments: [] });
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("prefetched-table-resume"),
      manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
    const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
    await ToolController.create(workspace);
    const restored = await workspace.readEvidenceManifest();
    expect(restored.table_fragments.length).toBeGreaterThan(0);
    expect(restored.evidence).toEqual(manifest.evidence);
    expect(persistedManifestExtendsPreparedBase(restored, manifest)).toBe(true);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    for (const field of ["text", "locator", "text_sha256", "table_fragment_id"] as const) {
      const changed = structuredClone(restored);
      changed.evidence.find(e => e.table_row_kind === "data")![field] = "changed";
      expect(persistedManifestExtendsPreparedBase(rehash(changed), manifest)).toBe(false);
    }
  });

  test.each(["primary", "sampling"] as const)("reference tables can reuse unchanged %s evidence across resume", async (scope) => {
    const primary = "6.2.1 检验应符合附录 A 的规定。";
    const title = "表 A.0.1 抽取数量";
    const markdown = ["# 6 安装检验", primary, "# 附录 A 检验方法", title,
      "<table><tr><td>项目</td><td>序号</td><td>检查项目</td><td>单位</td><td>允许值</td><td>检查方法</td></tr><tr><td>一般项目</td><td>1</td><td>间距</td><td>mm</td><td>10</td><td>尺量</td></tr></table>"].join("\n");
    const rehash = (value: EvidenceManifest): EvidenceManifest => {
      const { evidence_fingerprint: _fingerprint, ...payload } = value;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const structured = buildStructuredTargetEvidence(markdown, sha256Text(markdown),
      [{ start_line: 4, end_exclusive_line: 6 }], false);
    const manifest = rehash({ ...manifestFor(markdown, primary),
      evidence: [...manifestFor(markdown, primary).evidence,
        ...structured.evidence.map(record => ({ ...record, evidence_scope: scope, requires_disposition: true }))],
      table_fragments: structured.table_fragments });
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("reference-base-reuse"),
      manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
    const controller = await ToolController.create(workspace);
    const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans.find(span =>
      span.evidence_id === manifest.evidence[0]!.evidence_id)!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, origin_field: "requirement", raw_reference: "附录 A",
      target: { kind: "appendix", number: "A" }, relation: "读取正文明确引用的附录",
    });
    expect(resolved, JSON.stringify(resolved)).toMatchObject({ ok: true });
    const registered = await workspace.readEvidenceManifest();
    const titleRecord = registered.evidence.find(record => record.text === title)!;
    expect(titleRecord).toMatchObject({ evidence_scope: scope, registered_dependency: true, requires_disposition: true });
    expect(registered.table_fragments.length).toBeGreaterThan(manifest.table_fragments.length);
    expect(persistedManifestExtendsPreparedBase(registered, manifest)).toBe(true);
    await ToolController.create(await RevisionWorkspace.openLatest(workspace.artifactRoot, manifest.job_id, manifest.target_id));
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    expect((await workspace.readSourceSpanRegistry()).source_fingerprint).toBe(registered.evidence_fingerprint);

    // Rehash adversarial mutations so the tests exercise source/scope guards,
    // not merely the final payload checksum.
    const rejectMutation = (mutate: (value: EvidenceManifest) => void) => {
      const changed = structuredClone(registered);
      mutate(changed);
      expect(persistedManifestExtendsPreparedBase(rehash(changed), manifest)).toBe(false);
    };
    const mutateTitle = (value: EvidenceManifest) => value.evidence.find(record => record.evidence_id === titleRecord.evidence_id)!;
    rejectMutation(value => { mutateTitle(value).text += " altered"; });
    rejectMutation(value => { mutateTitle(value).locator = "line:999"; });
    rejectMutation(value => { mutateTitle(value).text_sha256 = "changed"; });
    rejectMutation(value => { mutateTitle(value).registered_dependency = false; });
    rejectMutation(value => { mutateTitle(value).evidence_scope = "reference"; });
    rejectMutation(value => { mutateTitle(value).requires_disposition = false; });
    rejectMutation(value => { value.table_fragments[0]!.provisional_title = "rewritten primary fragment"; });
    const addedId = registered.evidence[manifest.evidence.length]!.evidence_id;
    rejectMutation(value => { value.evidence.find(record => record.evidence_id === addedId)!.evidence_scope = "primary"; });
    rejectMutation(value => { value.evidence.find(record => record.evidence_id === addedId)!.registered_dependency = false; });
    expect(persistedManifestExtendsPreparedBase({ ...registered, evidence_fingerprint: "invalid" }, manifest)).toBe(false);
  });

  test.each(["7.3.1", "7.3.1, 7.3.2", "暂无"])("resumes the same confirmed source when its generated clause locator summary was %s", previousIds => {
    const markdown = "7.3.1 中性前项。\n7.3.2中性后项。";
    const rehash = (manifest: EvidenceManifest): EvidenceManifest => {
      const { evidence_fingerprint: _fingerprint, ...payload } = manifest;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const summary = (ids: string) => `sealed neutral decision 程序识别的条款定位候选：${ids}。此清单可能不完整，仅用于定位和检查可能遗漏；本次任务范围由已确认的目标计划确定，清单不能覆盖或扩大该范围。`;
    const prepared = manifestFor(markdown, markdown.split("\n"));
    prepared.scope.confirmed_scope_fingerprint = "a".repeat(64);
    prepared.scope.primary_source_ranges = [{ start_line: 1, end_exclusive_line: 3 }];
    prepared.scope.selection_reason = summary("7.3.1, 7.3.2");
    const current = rehash(prepared);
    const persisted = rehash({ ...current, scope: { ...current.scope, selection_reason: summary(previousIds) } });
    const before = JSON.stringify(persisted);
    expect(persistedManifestResumeMismatch(persisted, current)).toBeNull();
    expect(JSON.stringify(persisted)).toBe(before);
    const reject = (mutate: (value: EvidenceManifest) => void, code: string) => {
      const changed = structuredClone(persisted);
      mutate(changed);
      expect(persistedManifestResumeMismatch(rehash(changed), current)).toContain(code);
    };
    reject(value => { value.source.sha256 = "changed"; }, "prepared_base_changed at /source");
    reject(value => { value.scope.confirmed_scope_fingerprint = "changed"; }, "prepared_base_changed at /scope");
    reject(value => { value.scope.primary_source_ranges![0]!.end_exclusive_line = 4; }, "prepared_base_changed at /scope");
    reject(value => { value.scope.target_evidence_fragments![0]!.text += " changed"; }, "prepared_base_changed at /scope");
    reject(value => { value.scope.selection_reason = value.scope.selection_reason.replace("sealed neutral decision", "changed decision"); }, "prepared_base_changed at /scope");
    reject(value => { value.scope.selection_reason = value.scope.selection_reason.replace("程序识别的条款定位候选", "作者范围"); }, "prepared_base_changed at /scope");
    reject(value => { value.scope.selection_reason = summary("arbitrary prose"); }, "prepared_base_changed at /scope");
    reject(value => { delete value.scope.confirmed_scope_fingerprint; }, "prepared_base_changed at /scope");
    reject(value => { value.evidence[1]!.text += " changed"; }, "immutable_evidence_changed");
    reject(value => { value.evidence[1]!.locator = "line:99"; }, "immutable_evidence_changed");
    reject(value => { value.evidence[1]!.requires_disposition = false; }, "evidence_disposition_dropped");
    expect(persistedManifestResumeMismatch({ ...persisted, evidence_fingerprint: "invalid" }, current))
      .toContain("evidence_fingerprint_mismatch");
  });

  test.each(["primary", "sampling", "reference", undefined] as const)("resumes after startup restores metadata for frozen %s table evidence", async (scope) => {
    const primary = "6.2.1 安装要求应符合表 A.0.1 的规定。";
    const markdown = [
      "# 6 安装检验",
      primary,
      "表 A.0.1 安装允许偏差",
      "<table><tr><td>项目</td><td>允许值</td></tr><tr><td>间距</td><td>10mm</td></tr></table>",
    ].join("\n");
    const rehash = (value: EvidenceManifest): EvidenceManifest => {
      const { evidence_fingerprint: _fingerprint, ...payload } = value;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const structured = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [
      { start_line: 3, end_exclusive_line: 5 },
    ], false);
    const prepared = rehash({
      ...manifestFor(markdown, primary),
      evidence: [
        ...manifestFor(markdown, primary).evidence,
        ...structured.evidence.map(record => ({
          ...record,
          ...(scope ? { evidence_scope: scope } : {}),
          requires_disposition: true,
        })),
      ],
      table_fragments: [],
    });
    // Exercise the actual startup producer, then the resume consumer. No model
    // turn or reference registration should be needed for these frozen records.
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("restored-base-table"),
      prepared.job_id, prepared.target_id, { manifest: prepared, markdown: Buffer.from(markdown) });
    await ToolController.create(workspace);
    const registered = await workspace.readEvidenceManifest();
    expect(registered.evidence).toEqual(prepared.evidence);
    expect(registered.table_fragments).toEqual(structured.table_fragments);
    expect(registered.evidence_fingerprint).not.toBe(prepared.evidence_fingerprint);
    expect(persistedManifestExtendsPreparedBase(registered, prepared)).toBe(true);
    expect(persistedManifestResumeMismatch(registered, prepared)).toBeNull();
    const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
    const reopened = await RevisionWorkspace.openLatest(workspace.artifactRoot, prepared.job_id, prepared.target_id);
    await ToolController.create(reopened);
    expect(reopened.revision).toBe(workspace.revision);
    expect(await reopened.readEvidenceManifest()).toEqual(registered);
    expect(await readFile(reopened.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    expect((await reopened.readSourceSpanRegistry()).source_fingerprint).toBe(registered.evidence_fingerprint);

    const rejectMutation = (mutate: (value: EvidenceManifest) => void, reason: string) => {
      const changed = structuredClone(registered);
      mutate(changed);
      const mutated = rehash(changed);
      expect(persistedManifestExtendsPreparedBase(mutated, prepared)).toBe(false);
      expect(persistedManifestResumeMismatch(mutated, prepared)).toContain(reason);
      expect(persistedManifestResumeMismatch(mutated, prepared)).toMatch(/actual=.*; expected=/);
    };
    rejectMutation(value => { value.evidence[1]!.text += " changed"; }, "immutable_evidence_changed at /evidence/1/text");
    rejectMutation(value => { value.evidence[1]!.locator = "line:999"; }, "immutable_evidence_changed at /evidence/1/locator");
    rejectMutation(value => { value.evidence[1]!.requires_disposition = false; }, "evidence_disposition_dropped");
    rejectMutation(value => { value.source.sha256 = "changed"; }, "prepared_base_changed at /source");
    rejectMutation(value => { value.evidence.push({ ...value.evidence[0]!, evidence_id: "unexpected" }); }, "unregistered_evidence_extension");
    rejectMutation(value => { value.evidence.push({ ...value.evidence[0]!, evidence_scope: "reference", registered_dependency: true, requires_disposition: false }); }, "duplicate_evidence_id");
    rejectMutation(value => { value.table_fragments.push(value.table_fragments[0]!); }, "duplicate_table_fragment");
    rejectMutation(value => { value.table_fragments[0]!.row_evidence_ids.push("missing"); }, "unregistered_table_evidence");
    rejectMutation(value => { value.table_fragments[0]!.formal_row_evidence_ids.push(prepared.evidence[0]!.evidence_id); }, "table_row_membership_mismatch");
    rejectMutation(value => { value.table_fragments[0]!.header_evidence_ids.push(prepared.evidence[0]!.evidence_id); }, "table_row_membership_mismatch");
    rejectMutation(value => { value.evidence.find(record => record.evidence_id === value.table_fragments[0]!.row_evidence_ids[0])!.table_fragment_id = "foreign"; }, "table_row_fragment_mismatch");
    expect(persistedManifestResumeMismatch({ ...registered, evidence_fingerprint: "invalid" }, prepared))
      .toContain("evidence_fingerprint_mismatch at /evidence_fingerprint");
    const largeMismatch = structuredClone(registered);
    largeMismatch.scope.selection_reason = "changed ".repeat(2000);
    const diagnostic = persistedManifestResumeMismatch(rehash(largeMismatch), prepared)!;
    expect(diagnostic).toContain("prepared_base_changed at /scope");
    expect(diagnostic).toContain('"truncated":true');
    expect(diagnostic.length).toBeLessThan(2200);

    const markedBase = rehash({ ...prepared, evidence: prepared.evidence.map(record => ({ ...record, registered_dependency: true })) });
    expect(persistedManifestResumeMismatch(registered, markedBase)).toContain("dependency_registration_changed");
    const unregisteredBase = rehash({ ...prepared, evidence: prepared.evidence.map(record => ({ ...record, registered_dependency: false })) });
    expect(persistedManifestResumeMismatch(rehash({ ...unregisteredBase, table_fragments: registered.table_fragments }), unregisteredBase)).toBeNull();
  });

  test("runtime line slices inside the target's own scope resume; out-of-scope slices stay rejected", () => {
    const markdown = [
      "# 6 安装检验",
      "6.2.1 安装要求应符合表 A.0.1 的规定。",
      "检查数量：全数检查。",
    ].join("\n");
    const base = manifestFor(markdown, "6.2.1 安装要求应符合表 A.0.1 的规定。");
    const rehash = (value: EvidenceManifest): EvidenceManifest => {
      const { evidence_fingerprint: _fingerprint, ...payload } = value;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const lineSlice = (line: number, text: string) => ({
      evidence_id: `evidence:${sha256Text(text)}`,
      atom_id: `atom:${sha256Text(text)}`,
      kind: "paragraph" as const,
      role: "context" as const,
      locator: `line:${line}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary" as const,
    });
    // GB 50205 连接节点安装实测形态：模型在自己计划范围内按行打开主资料，
    // 运行时清单比 prepared 多出这些行切片——是授权读取，不是无声扩张。
    const ownScope = [{ start_line: 2, end_exclusive_line: 4 }];
    const inScopeSlices = rehash({
      ...base,
      evidence: [...base.evidence, lineSlice(2, "6.2.1 安装要求应符合表 A.0.1 的规定。"), lineSlice(3, "检查数量：全数检查。")],
    });
    expect(persistedManifestResumeMismatch(inScopeSlices, base, ownScope)).toBeNull();
    // 不传范围参数保持旧严格行为（旧调用点语义不变）。
    expect(persistedManifestResumeMismatch(inScopeSlices, base)).toContain("unregistered_evidence_extension");
    // 表片段引用范围内切片同样合法（负例在证据层先被拦，见 outOfScope）。
    const tableSlices = rehash({
      ...base,
      evidence: [
        ...base.evidence,
        lineSlice(2, "6.2.1 安装要求应符合表 A.0.1 的规定。"),
        { ...lineSlice(3, "检查数量：全数检查。"), table_fragment_id: "table-fragment:line-3" },
      ],
      table_fragments: [{
        fragment_id: "table-fragment:line-3",
        caption: "检查数量",
        row_evidence_ids: [`evidence:${sha256Text("检查数量：全数检查。")}`],
        formal_row_evidence_ids: [],
        header_evidence_ids: [],
        title_candidate_evidence_ids: [],
      } as never],
    });
    expect(persistedManifestResumeMismatch(tableSlices, base, ownScope)).toBeNull();
  });

  test("referenced table metadata is available immediately and restored for legacy working checkpoints", async () => {
    const primary = "6.2.1 安装间距应符合表 1.2.1-1 的规定。";
    const markdown = SOURCE.replace("6.2.1 安装间距应符合本规范第 1.1.1 条第 2 款的规定。", primary)
      .replace("# 6 安装检验", "续表 1.2.1-1\n<table><tr><td>项目</td><td>序号</td><td>检查项目</td><td>单位</td><td>允许值</td><td>检查方法</td></tr><tr><td>一般项目</td><td>2</td><td>高度</td><td>mm</td><td>20</td><td>尺量</td></tr></table>\n# 6 安装检验");
    const manifest = manifestFor(markdown, primary);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("reference-table-directory"),
      manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
    const controller = await ToolController.create(workspace);
    const originalSelectors = await readFile(workspace.workingSelectorPath, "utf8");
    const registry = await workspace.readSourceSpanRegistry();
    const request = { origin_span_id: registry.spans[0]!.span_id, origin_field: "requirement",
      raw_reference: "表 1.2.1-1", target: { kind: "table", number: "1.2.1-1" }, relation: "读取原文引用" };
    expect(await controller.dispatch("resolve_document_reference", request)).toMatchObject({ ok: true });
    const directory = await controller.dispatch("list_table_fragments", { cursor: 0, limit: 100 });
    expect(directory.fragments).toHaveLength(2);
    expect(await controller.dispatch("read_table_summary", { table_key: "1.2.1-1" })).toMatchObject({
      ok: true, row_count: 4, saved_decision: { status: "review" },
    });
    const registered = await workspace.readEvidenceManifest();
    expect(persistedManifestExtendsPreparedBase(registered, manifest)).toBe(true);
    const rehash = (value: EvidenceManifest) => {
      const { evidence_fingerprint: _fingerprint, ...payload } = value;
      return { ...payload, evidence_fingerprint: sha256Json(payload) };
    };
    const missingRow = structuredClone(registered);
    missingRow.table_fragments[0]!.row_evidence_ids.push("unregistered-row");
    expect(persistedManifestExtendsPreparedBase(rehash(missingRow), manifest)).toBe(false);
    const changedBase = structuredClone(registered);
    changedBase.table_fragments[0]!.provisional_title = "changed primary table";
    expect(persistedManifestExtendsPreparedBase(rehash(changedBase), registered)).toBe(false);
    const duplicateFragment = structuredClone(registered);
    duplicateFragment.table_fragments.push(duplicateFragment.table_fragments[0]!);
    expect(persistedManifestExtendsPreparedBase(rehash(duplicateFragment), manifest)).toBe(false);
    const selectorAfter = await readFile(workspace.workingSelectorPath, "utf8");
    expect(selectorAfter).toBe(originalSelectors);
    // Simulate the old registration bug. No semantic author records are changed.
    const { evidence_fingerprint: _old, ...legacy } = { ...registered, table_fragments: [] };
    await chmod(workspace.evidenceManifestPath, 0o644);
    await atomicWriteJson(workspace.evidenceManifestPath, { ...legacy, evidence_fingerprint: sha256Json(legacy) });
    const legacyRegistry = { ...await workspace.readSourceSpanRegistry(), source_fingerprint: sha256Json(legacy) };
    await atomicWriteJson(workspace.sourceSpanRegistryPath, legacyRegistry);
    const restored = await ToolController.create(workspace);
    const restoredManifest = await workspace.readEvidenceManifest();
    expect(restoredManifest.evidence).toEqual(registered.evidence);
    expect(restoredManifest.table_fragments).toEqual(registered.table_fragments);
    expect((await restored.dispatch("list_table_fragments", { cursor: 0, limit: 100 })).fragments).toEqual(directory.fragments);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorAfter);
    expect((await workspace.readSourceSpanRegistry()).source_fingerprint).toBe(restoredManifest.evidence_fingerprint);
    await ToolController.create(workspace);
    expect((await workspace.readEvidenceManifest()).evidence_fingerprint).toBe(restoredManifest.evidence_fingerprint);
    // Crash after the manifest rename: the exact write-ahead receipt repairs
    // only the registry fingerprint, leaving all source spans unchanged.
    await atomicWriteJson(workspace.sourceSpanRegistryPath, legacyRegistry);
    await ToolController.create(workspace);
    expect(await workspace.readSourceSpanRegistry()).toEqual({ ...legacyRegistry, source_fingerprint: restoredManifest.evidence_fingerprint });
    const unrelated = { ...legacyRegistry, source_fingerprint: "unrelated-checkpoint" };
    await atomicWriteJson(workspace.sourceSpanRegistryPath, unrelated);
    await ToolController.create(workspace);
    expect(await workspace.readSourceSpanRegistry()).toEqual(unrelated);
  });

  test("excludes repeated targets after the normative body without matching TOC labels", () => {
    const sourceId = sha256Text(SOURCE);
    expect(resolveDocumentReferenceTarget(SOURCE, sourceId, {
      kind: "clause", number: "9.9.9",
    })).toMatchObject({ ok: false, error: "not_found", candidates: [] });

    const commentary = [
      SOURCE,
      "# 附：条文说明",
      "1.1.1 重复说明文本。",
      "# 附录 A 试验方法",
      "A.0.1 条文说明中的附录文本。",
    ].join("\n");
    const clause = resolveDocumentReferenceTarget(commentary, sha256Text(commentary), {
      kind: "clause", number: "1.1.1",
    });
    expect(clause.ok && clause.evidence.map((record) => record.text)).toContain("1.1.1 基础要求应符合下列规定：");
    expect(clause.ok && clause.evidence.map((record) => record.text)).not.toContain("1.1.1 重复说明文本。");
    const appendix = resolveDocumentReferenceTarget(commentary, sha256Text(commentary), {
      kind: "appendix", number: "A",
    });
    expect(appendix.ok && appendix.evidence.map((record) => record.text)).toContain("A.0.1 附录正文。");
    expect(appendix.ok && appendix.evidence.map((record) => record.text))
      .not.toContain("A.0.1 条文说明中的附录文本。");

    const tocBeforeBody = `# 本规范用词说明 80 [PDF p.12]\n${SOURCE}`;
    expect(resolveDocumentReferenceTarget(tocBeforeBody, sha256Text(tocBeforeBody), {
      kind: "clause", number: "1.1.1",
    })).toMatchObject({ ok: true });
  });

  test("returns the first in-body candidate and lets the caller name another by start line", () => {
    const duplicate = [
      "1.1.1 第一候选正文。",
      "1.1.2 第一候选之后。",
      "1.1.1 第二候选正文。",
      "1.1.2 第二候选之后。",
    ].join("\n");
    const sourceId = sha256Text(duplicate);
    const first = resolveDocumentReferenceTarget(duplicate, sourceId, {
      kind: "clause", number: "1.1.1",
    });
    expect(first).toMatchObject({
      ok: true,
      selected_candidate: { start_line: 1 },
      other_candidates: [{ start_line: 3 }],
    });
    expect(first.ok && first.evidence.map((record) => record.text)).toEqual(["1.1.1 第一候选正文。"]);

    const second = resolveDocumentReferenceTarget(duplicate, sourceId, {
      kind: "clause", number: "1.1.1", candidate_start_line: 3,
    });
    expect(second).toMatchObject({
      ok: true,
      selected_candidate: { start_line: 3 },
      other_candidates: [{ start_line: 1 }],
    });
    expect(second.ok && second.evidence.map((record) => record.text)).toEqual(["1.1.1 第二候选正文。"]);

    expect(resolveDocumentReferenceTarget(duplicate, sourceId, {
      kind: "clause", number: "1.1.1", candidate_start_line: 99,
    })).toMatchObject({
      ok: false,
      error: "candidate_not_found",
      candidates: [{ start_line: 1 }, { start_line: 3 }],
    });
  });

  test("registers the returned in-body candidate and gives alternate candidates distinct occurrences", async () => {
    const origin = "6.2.1 应符合本规范第1.1.1条的规定。";
    const source = [
      origin,
      "1.1.1 第一候选正文。",
      "1.1.2 第一候选之后。",
      "1.1.1 第二候选正文。",
      "1.1.2 第二候选之后。",
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("named-reference-candidate"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const request = {
      origin_span_id: originSpanId,
      raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" },
      relation: "duplicate_target",
    };
    const first = await controller.dispatch("resolve_document_reference", request);
    expect(first).toMatchObject({
      ok: true,
      target_key: expect.stringMatching(/^reference-target:/u),
      receipt_compacted: true,
    });
    const second = await controller.dispatch("resolve_document_reference", {
      ...request,
      target: { ...request.target, candidate_start_line: 4 },
    });
    expect(second).toMatchObject({ ok: true, target_key: expect.stringMatching(/^reference-target:/u) });
    expect(second.occurrence_id).not.toBe(first.occurrence_id);
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(2);
  });

  test.each(["commit", "coverage_repair"] as const)(
    "%s exposes the inherited reference ledger and unlocks the commit prerequisite after its last page",
    async (stage) => {
      const { controller, workspace, originSpanId } = await controllerFor();
      const receipts: Array<Record<string, unknown>> = [];
      for (const paragraph of ["2", undefined]) {
        const receipt = await controller.dispatch("resolve_document_reference", {
          origin_span_id: originSpanId,
          raw_reference: "本规范第 1.1.1 条第 2 款",
          target: { kind: "clause", number: "1.1.1", ...(paragraph ? { paragraph } : {}) },
          relation: "requirement_adoption",
        });
        expect(receipt).toMatchObject({ ok: true });
        expect(await controller.dispatch("read_document_reference_evidence", { target_key: receipt.target_key }))
          .toMatchObject({ ok: true, done: true });
        receipts.push(receipt);
      }
      const selectors = initialTargetSelectorPlan(await workspace.readEvidenceManifest());
      selectors.references = receipts.map((receipt, index) => ({
        key: `inherited-reference-${index}`,
        occurrence_id: String(receipt.occurrence_id),
        anchor_span_ids: [String(receipt.reference_literal_span_id)],
        target_span_ids: [],
        action: "mention",
        application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用恢复 fixture。" },
        destinations: [],
        reason: "引用清单前置检查的恢复用例。",
      }));
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      await workspace.updateState((state) => {
        state.selector_stage = stage;
        state.lineage = {
          schema_version: "revision-lineage/v1",
          source_revision: 1,
          selector_checkpoint_revision: 1,
          registry_checkpoint_revision: 1,
          recovery_kind: "interrupted_checkpoint",
        };
      });
      const resumed = await ToolController.create(workspace);
      expect(resumed.selectorStartupContext().current_selector_state).toBe("inherited_existing");
      const allowed = resumed.selectorProviderPolicy().allowed_tools;
      const tools = createPiTools(resumed).filter((tool) => allowed.includes(tool.name));
      const ledger = tools.find((tool) => tool.name === "list_reference_occurrences");
      expect(ledger).toBeDefined();

      // A stale fingerprint stops immediately AFTER the ledger prerequisite;
      // this test does not invoke compilation or spend a semantic repair budget.
      // Isolate these prerequisites from the separately tested author-work guard.
      vi.spyOn(resumed, "selectorRepairWork").mockResolvedValue(undefined);
      const commit = () => resumed.dispatch("commit_target_selector_draft", { draft_fingerprint: "stale" });
      await resumed.dispatch("read_target_selectors", { collection: "references" });
      expect(await commit()).toMatchObject({ error: "inherited_reference_occurrence_ledger_read_required" });
      const first = await ledger!.execute("ledger-page-1", { cursor: 0, limit: 1 }, undefined as never, undefined as never) as { details: Record<string, unknown> };
      expect(first.details).toMatchObject({ ok: true, next_cursor: 1 });
      expect(await commit()).toMatchObject({ error: "inherited_reference_occurrence_ledger_read_required" });
      const last = await ledger!.execute("ledger-page-2", { cursor: 1, limit: 1 }, undefined as never, undefined as never) as { details: Record<string, unknown> };
      expect(last.details).toMatchObject({ ok: true, next_cursor: null });
      expect(await commit()).toMatchObject({ error: "selector_draft_fingerprint_mismatch" });
      expect((await workspace.readState()).selector_protocol?.coverage_repairs).toBe(0);
    },
  );

  test("verifies the origin, registers idempotently, and exposes the tool contract", async () => {
    const { controller, workspace, originSpanId } = await controllerFor();
    const modelTools = createPiTools(controller);
    expect(modelTools.map((tool) => tool.name)).toContain("resolve_document_reference");
    const resolveTool = modelTools.find((tool) => tool.name === "resolve_document_reference")!;
    const listOccurrencesTool = modelTools.find((tool) => tool.name === "list_reference_occurrences")!;
    const advanceTool = modelTools.find((tool) => tool.name === "advance_target_selector_stage")!;
    expect(resolveTool.description).toContain("明确内部引用的一个目标");
    expect(TARGET_SELECTOR_PROTOCOLS.references).toContain("条/节/表/附录");
    expect(TARGET_SELECTOR_PROTOCOLS.references).toContain("主资料一级验收依据");
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("不按 key、理由、数组位置推身份");
    expect(listOccurrencesTool.description).toContain("不可变occurrence");
    expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toContain("occurrence_id");
    expect(TARGET_SELECTOR_PROTOCOLS.tables).toContain("题注不代替判据");
    expect(advanceTool.description).not.toContain("reference_commit_checklist");
    expect(advanceTool.description).not.toContain("提交前引用检查");
    const resolveParameters = JSON.stringify(resolveTool.parameters);
    expect(resolveParameters).toContain("origin_field");
    expect(resolveParameters).toContain("条、节、表或附录编号");
    expect(resolveParameters).toContain('"section"');
    expect(resolveParameters).toContain('"clause"');
    expect(resolveParameters).toContain('"appendix"');
    expect(createCoverageReviewTools({} as CoverageReviewController).map((tool) => tool.name))
      .toEqual(expect.arrayContaining(["resolve_document_reference", "read_document_reference_evidence", "read_reference_facts"]));
    const applicationModeSchema = TARGET_SELECTOR_PLAN_JSON_SCHEMA
      .properties.references.items.properties.application_mode;
    expect(JSON.stringify(applicationModeSchema)).not.toMatch(/"const":"replace_field"/);
    expect(applicationModeSchema.description).toContain("retain_local_field_and_attach_reference");
    expect(applicationModeSchema.description).toContain("retain_non_item_reference_placeholder");
    expect(applicationModeSchema.description).not.toContain("replace_entire_destination_field");
    const coverageResolveTool = createCoverageReviewTools({} as CoverageReviewController)
      .find((tool) => tool.name === "resolve_document_reference")!;
    expect(coverageResolveTool.description).toBe(resolveTool.description);
    const coverageResolveParameters = JSON.stringify(coverageResolveTool.parameters);
    expect(coverageResolveParameters).toContain("origin_field");
    expect(coverageResolveParameters).toContain("条、节、表或附录编号");
    expect(coverageResolveParameters).toContain('"section"');
    const contract = await controller.dispatch("get_target_selector_contract", {});
    expect(contract.reference_application_mode_semantics).toEqual(REFERENCE_APPLICATION_MODE_SEMANTICS);
    expect(contract.reference_action_guidance).toBe(TARGET_SELECTOR_PROTOCOLS.references);
    expect(contract).not.toHaveProperty("reference_commit_checklist");
    const request = {
      origin_span_id: originSpanId,
      raw_reference: "本规范第 1.1.1 条第 2 款",
      target: { kind: "clause", number: "1.1.1", paragraph: "2" },
      relation: "requirement_adoption",
    };
    const first = await controller.dispatch("resolve_document_reference", request);
    const second = await controller.dispatch("resolve_document_reference", {
      ...request,
      relation: "reviewer_confirmed_requirement_dependency",
    });
    expect(first).toMatchObject({
      ok: true,
      idempotent: false,
      occurrence_id: expect.any(String),
      target_key: expect.stringMatching(/^reference-target:[a-f0-9]{64}$/u),
      analysis_status: "not_required",
      analysis_mode: "inline",
      target_text_utf8_bytes: expect.any(Number),
      estimated_compact_page_count: 1,
      mode_reason: "within_inline_limits",
      instruction: expect.stringContaining("This receipt covers only this occurrence and target"),
    });
    expect(second).toMatchObject({ ok: true, idempotent: true, occurrence_id: first.occurrence_id });
    const inlineTool = modelTools.find((tool) => tool.name === "read_document_reference_evidence")!;
    const inlinePage = await inlineTool.execute("inline-reference", { target_key: first.target_key }, undefined as never, undefined as never) as { details: Record<string, unknown> };
    expect(inlinePage.details).toMatchObject({ ok: true, analysis_mode: "inline", done: true, rows: expect.any(Array) });
    expect(await pathExists(resolve(workspace.root, "..", "..", "reference-analysis"))).toBe(false);
    const persisted = await workspace.readEvidenceManifest();
    const persistedRegistry = await workspace.readSourceSpanRegistry();
    expect(persisted.reference_occurrences).toHaveLength(1);
    expect(persisted.evidence.filter((record) => record.registered_dependency)).toHaveLength(1);
    expect(() => compileTargetSelectors(
      initialTargetSelectorPlan(persisted),
      persistedRegistry,
      persisted,
    )).toThrowError(TargetSelectorCompileError);
    try {
      compileTargetSelectors(
        initialTargetSelectorPlan(persisted),
        persistedRegistry,
        persisted,
      );
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_registered_reference_receipt_missing" }),
      ]));
    }

    expect(await controller.dispatch("resolve_document_reference", {
      ...request,
      raw_reference: "并不存在于锚点的引用",
    })).toMatchObject({ ok: false, error: "origin_span_does_not_contain_raw_reference" });
  });

  test("rejects an invented reference with executable source investigation and unchanged author state", async () => {
    const origin = "6.2.1 安装件必须牢固。";
    const source = ["# 1 通用要求", "1.1.1 检查应记录结果。", "# 6 安装检验", origin].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("invented-reference-feedback"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const paths = [workspace.workingSelectorPath, workspace.sourceSpanRegistryPath, workspace.sourceMarkdownPath];
    const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
    const beforeManifest = await workspace.readEvidenceManifest();
    const beforeState = await workspace.readState();
    const rejected = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, origin_field: "sampling", raw_reference: "第1章",
      target: { kind: "section", number: "1" }, relation: "调查共同规则",
    });
    expect(rejected).toMatchObject({
      ok: false, error: "origin_span_does_not_contain_raw_reference",
      budget_consumed: false, dependency_registered: false,
      actual: {
        raw_reference: "第1章", origin_field: "sampling", target: { kind: "section", number: "1" },
        origin_span: { span_id: originSpanId, evidence_id: manifest.evidence[0]!.evidence_id },
        raw_reference_candidate_count: 0,
      },
      expected: { raw_reference: expect.any(String), target: expect.any(String) },
      writable_collection: "resolve_document_reference arguments",
      writable_paths: expect.arrayContaining(["/origin_span_id", "/raw_reference", "/target", "/origin_field"]),
      next_tool: "open_evidence", next_tool_arguments: { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 },
      retry_tool: "resolve_document_reference",
      context_investigation_tools: [
        { name: "list_global_document_resources", arguments: { cursor: 0, limit: 20 } },
      ],
      instruction: expect.stringContaining("没有明确引用编号"),
    });
    const available = new Set(createPiTools(controller).map(tool => tool.name));
    for (const name of rejected.next_tools as string[]) expect(available.has(name)).toBe(true);
    const directory = await controller.dispatch("list_global_document_resources", { cursor: 0, limit: 20 });
    expect(directory.ok).toBe(true);
    expect(await Promise.all(paths.map(path => readFile(path, "utf8")))).toEqual(before);
    expect(await workspace.readEvidenceManifest()).toEqual(beforeManifest);
    const afterState = await workspace.readState();
    expect(afterState.next_event_sequence).toBeGreaterThan(beforeState.next_event_sequence);
    expect({ ...afterState, next_event_sequence: beforeState.next_event_sequence }).toEqual(beforeState);
  });

  test("encodes origin mismatch inputs and recovery arguments in the current source handle scope", async () => {
    const { controller, workspace, manifest, originSpanId } = await controllerFor();
    const codec = await ModelSourceHandles.open(workspace.root);
    const tool = codec.wrapTools(createPiTools(controller)).find(tool => tool.name === "resolve_document_reference")!;
    const input = await codec.encode({ origin_span_id: originSpanId });
    const result = await tool.execute("origin-mismatch", {
      ...input, source_handle_scope: codec.scope, origin_field: "requirement",
      raw_reference: "第9.9.9条", target: { kind: "clause", number: "9.9.9" }, relation: "核对引用",
    }, undefined as never, undefined as never);
    const visible = JSON.parse((result.content[0] as { text: string }).text);
    expect(visible.actual.origin_span.span_id).toMatch(/^s[0-9]+$/u);
    expect(visible.actual.origin_span.evidence_id).toMatch(/^e[0-9]+$/u);
    expect(visible.next_tool_arguments.evidence_id).toBe(visible.actual.origin_span.evidence_id);
    expect(visible.actual.target.number).toBe("9.9.9");
    expect(await codec.decodeResponse(visible)).toEqual(result.details);
    expect((result.details as Record<string, any>).next_tool_arguments.evidence_id).toBe(manifest.evidence[0]!.evidence_id);
  });

  test("origin mismatch recovery retains the isolated reference reading route", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
    const record = manifest.evidence.find(row => row.registered_dependency)!;
    const span = (await workspace.readSourceSpanRegistry()).spans.find(row => row.evidence_id === record.evidence_id)!;
    const controller = await ToolController.create(workspace);
    const rejected = await controller.dispatch("resolve_document_reference", {
      origin_span_id: span.span_id, origin_field: "sampling", raw_reference: "第9.9.9条",
      target: { kind: "clause", number: "9.9.9" }, relation: "核对共同规则",
    });
    expect(rejected).toMatchObject({
      ok: false, error: "origin_span_does_not_contain_raw_reference",
      dependency_registered: false, next_tool: "read_reference_facts", next_tool_arguments: { target_key: targetKey },
    });
    expect(rejected.next_tools).not.toContain("open_evidence");
  });

  test("detects an explicitly registered reference cycle", async () => {
    const cyclic = SOURCE.replace(
      "1.1.1 基础要求应符合下列规定：",
      "1.1.1 基础要求应符合本规范第 6.2.1 条的规定。",
    );
    const { controller, workspace, originSpanId } = await controllerFor(cyclic);
    const first = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范第 1.1.1 条第 2 款",
      target: { kind: "clause", number: "1.1.1" },
      relation: "requirement_adoption",
    });
    expect(first).toMatchObject({ ok: true });
    const targetEvidence = await receiptEvidence(workspace, first);
    const backOrigin = targetEvidence.find((record) => record.text.startsWith("1.1.1 "))!;
    const beforeManifest = await workspace.readEvidenceManifest();
    const beforeState = await workspace.readState();
    const beforeSelectors = await readFile(workspace.workingSelectorPath, "utf8");
    const rejected = await controller.dispatch("resolve_document_reference", {
      origin_span_id: backOrigin.span_id,
      raw_reference: "本规范第 6.2.1 条",
      target: { kind: "clause", number: "6.2.1" },
      relation: "requirement_adoption",
    });
    expect(rejected).toMatchObject({
      ok: false, error: "cycle", terminal: false, budget_consumed: false, dependency_registered: false,
      actual: {
        origin_evidence_ids: [backOrigin.evidence_id], origin_span_ids: [backOrigin.span_id],
        raw_reference: "本规范第 6.2.1 条", requested_target: { kind: "clause", number: "6.2.1" },
        target_evidence_ids: expect.any(Array), cycle_evidence_ids: expect.any(Array),
      },
      expected: { dependency_graph: "acyclic" },
      writable_paths: expect.arrayContaining(["/origin_span_id", "/reference_literal_span_id", "/target"]),
      next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 100 },
      how_to_pass: expect.stringContaining("改 relation、理由或重复同一请求不会解除闭环"),
      instruction: expect.stringContaining("literal span 可以保留"),
    });
    expect((rejected.actual as any).cycle_evidence_ids).toEqual(rejected.cycle_path);
    expect((rejected.actual as any).reference_literal_span_ids).toHaveLength(1);
    expect(await workspace.readEvidenceManifest()).toEqual(beforeManifest);
    expect({ ...await workspace.readState(), next_event_sequence: beforeState.next_event_sequence }).toEqual(beforeState);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeSelectors);
    expect(await controller.dispatch(String(rejected.next_tool), rejected.next_tool_arguments as any)).toMatchObject({ ok: true });
  });

  test.each(["7.3.2中性后项。", "## 7.3.2中性后项。", "7．3．2中性后项。"])("joined formal clauses resolve independently and retain granular ownership: %s", second => {
    const source = ["7.3.1 中性前项。", "检查数量：抽查2件。", "检验方法：观察。", second,
      "检查数量：全数检查。", "检验方法：核对记录。", "7.3.3 中性末项。"].join("\n");
    const sourceId = sha256Text(source);
    const target = resolveDocumentReferenceTarget(source, sourceId, { kind: "clause", number: "7.3.2" });
    expect(target).toMatchObject({ ok: true });
    const selected = target.evidence.filter(record => target.target_evidence_ids.includes(record.evidence_id));
    expect(selected.map(record => record.text).join("\n")).toContain("全数检查");
    expect(selected.map(record => record.text).join("\n")).not.toMatch(/抽查2件|中性末项/);
    const granular = buildGranularProseCoverageEvidence(source, sourceId, [{ start_line: 1, end_exclusive_line: 8 }]);
    expect(granular.filter(record => ["line:4", "line:5", "line:6"].includes(record.locator)).map(record => record.clause_id))
      .toEqual(["7.3.2", "7.3.2", "7.3.2"]);
  });

  test("self-reference cycle receipt identifies the rejected source without creating a dependency", async () => {
    const origin = "1.1.1 中性要求见本规范第1.1.1条。";
    const source = [origin, "1.1.2 中性后续要求。"].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("self-reference-cycle-feedback"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpan = (await workspace.readSourceSpanRegistry()).spans[0]!;
    const beforeManifest = await workspace.readEvidenceManifest();
    const rejected = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpan.span_id, raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" }, relation: "中性引用",
    });
    expect(rejected).toMatchObject({
      ok: false, error: "cycle", dependency_registered: false,
      actual: { origin_evidence_ids: [originSpan.evidence_id], cycle_evidence_ids: [originSpan.evidence_id] },
      do_not_edit: expect.stringContaining("不得删除已有引用"),
      instruction: expect.stringContaining("相同参数和依赖图下不可恢复"),
    });
    expect(await workspace.readEvidenceManifest()).toEqual(beforeManifest);
    expect(await controller.dispatch(String(rejected.next_tool), rejected.next_tool_arguments as any)).toMatchObject({ ok: true });
    const reviewReceipt = await resolveAndRegisterDocumentReference(workspace, beforeManifest, {
      origin_span_id: originSpan.span_id, origin_field: "requirement", raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" }, relation: "中性复核引用",
    }, true);
    expect(reviewReceipt).toMatchObject({
      ok: false, error: "cycle", next_tool: "list_coverage_reference_targets",
      next_tool_arguments: { cursor: 0, limit: 100 },
    });
    const reviewTools = new Set(createCoverageReviewTools({} as CoverageReviewController).map((tool) => tool.name));
    for (const tool of reviewReceipt.next_tools as string[]) expect(reviewTools.has(tool), tool).toBe(true);
    expect(await workspace.readEvidenceManifest()).toEqual(beforeManifest);
  });

  test("requires an exact literal span when raw reference repeats in one origin", async () => {
    const origin = "6.2.1 前项见本规范第1.1.1条，后项仍见本规范第1.1.1条。";
    const source = [
      "1.1.1 被引内容。",
      "1.1.2 后续条文。",
      origin,
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("repeated-reference-literal"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const evidenceId = manifest.evidence[0]!.evidence_id;
    const registry = await workspace.readSourceSpanRegistry();
    const originSpanId = registry.spans[0]!.span_id;
    const ambiguous = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" },
      relation: "repeated_reference",
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: "reference_literal_ambiguous",
      candidates: [expect.any(Object), expect.any(Object)],
    });
    await controller.dispatch("open_evidence", { evidence_id: evidenceId });
    const located = await controller.dispatch("locate_evidence_span", {
      evidence_id: evidenceId,
      quote: "本规范第1.1.1条",
      prefix: "后项仍见",
      suffix: "。",
    });
    const referenceLiteralSpanId = (located.span as { span_id: string }).span_id;
    expect(await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      reference_literal_span_id: referenceLiteralSpanId,
      raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" },
      relation: "repeated_reference",
    })).toMatchObject({
      ok: true,
      reference_literal_span_id: referenceLiteralSpanId,
    });
  });

  test("resolves a shared Chinese prefix to the exact literal and suggests real substrings on failure", async () => {
    const origin = "6.2.1 测试内容应按本规范附录 A、附录 B、附录 C 的规定。";
    const source = [
      origin,
      "# 附录 A 测试内容 A",
      "A.0.1 A 的内容。",
      "# 附录 B 测试内容 B",
      "B.0.1 B 的内容。",
      "# 附录 C 测试内容 C",
      "C.0.1 C 的内容。",
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("shared-reference-prefix"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范附录 B",
      target: { kind: "appendix", number: "B" },
      relation: "shared_prefix_list",
    });
    expect(resolved).toMatchObject({
      ok: true,
      reference_literal_span_id: expect.any(String),
      analysis_status: "not_required",
      analysis_mode: "inline",
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences[0]).toMatchObject({
      raw_reference: "附录 B",
    });

    expect(await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范附录第 B",
      target: { kind: "appendix", number: "B" },
      relation: "malformed_shared_prefix_list",
    })).toMatchObject({
      ok: false,
      error: "origin_span_does_not_contain_raw_reference",
      raw_reference_candidates: [expect.objectContaining({ text: "附录 B" })],
    });
  });

  test("deduplicates overlapping literals for the same origin and target occurrence", async () => {
    const origin = "8.0.3 对绞电缆指标参数应符合本规范附录 B 的规定。";
    const source = [
      origin,
      "# 附录 B 对绞电缆指标参数",
      "B.0.1 指标参数正文。",
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("overlapping-reference-literals"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const call = (rawReference: string, sourceSpanId = originSpanId) => controller.dispatch("resolve_document_reference", {
      origin_span_id: sourceSpanId,
      raw_reference: rawReference,
      target: { kind: "appendix", number: "B" },
      relation: "appendix_b_requirement",
    });
    const containing = await call("本规范附录 B");
    const narrow = await call("附录 B", String(containing.reference_literal_span_id));
    expect(containing).toMatchObject({ ok: true, idempotent: false });
    expect(narrow).toMatchObject({
      ok: true,
      idempotent: true,
      logical_occurrence_deduplicated: true,
      occurrence_id: containing.occurrence_id,
      reference_literal_span_id: containing.reference_literal_span_id,
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(1);

    const invalidStage = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: {
        references: [{
          key: "invalid-occurrence-binding",
          occurrence_id: narrow.occurrence_id,
          anchor_span_ids: [originSpanId],
          target_span_ids: [originSpanId],
          action: "adopt",
          application_mode: "reference_only",
          import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "无效绑定 fixture。" },
          destinations: [],
          reason: "故意提交不一致的 anchor 和 target span。",
        }],
      },
    });
    expect(invalidStage).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true});

    const validReference = {
      key: "appendix-b-reference",
      occurrence_id: containing.occurrence_id,
      anchor_span_ids: [containing.reference_literal_span_id],
      target_span_ids: [(await receiptEvidence(workspace, narrow))[0]!.span_id],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "精确附录引用 fixture。" },
      destinations: [],
      reason: "精确绑定去重后的附录 B 回执。",
    };
    expect(await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: { references: [validReference] },
    })).toMatchObject({ ok: true });
    expect(await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: { references: [{ ...validReference, key: "duplicate-appendix-b-reference" }] },
    })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true});
  });

  test("corrects one unvalidated occurrence route and freezes it once coverage repair starts", async () => {
    const origin = "D.0.6 芯样试件应按现行国家标准《普通混凝土力学性能试验方法标准》GB/T 50081 中圆柱体试件的规定进行抗压强度试验。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("correct-unvalidated-reference-route"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(origin) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const input = {
      origin_span_id: originSpanId,
      raw_reference: "GB/T 50081",
      standard_no: "GB/T 50081",
      standard_title: "普通混凝土力学性能试验方法标准",
      // 原文未给出节号；保留整本标准引用，主体范围由原句和 relation 保留。
      relation: "芯样试件抗压强度试验规定",
    };
    const first = await controller.dispatch("resolve_external_standard_reference", {
      ...input,
      origin_field: "method",
    });
    const corrected = await controller.dispatch("resolve_external_standard_reference", {
      ...input,
      origin_span_id: first.reference_literal_span_id,
      reference_literal_span_id: first.reference_literal_span_id,
      origin_field: "requirement",
    });

    expect(corrected).toMatchObject({
      ok: true,
      occurrence_id: first.occurrence_id,
      origin_field: "requirement",
      idempotent: true,
      logical_occurrence_deduplicated: true,
      origin_field_corrected: true,
      previous_origin_fields: ["method"],
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([
      expect.objectContaining({
        occurrence_id: first.occurrence_id,
        origin_fields: ["requirement"],
      }),
    ]);

    await workspace.updateState((state) => {
      state.selector_stage = "coverage_repair";
      state.last_valid_fingerprint = "";
      state.last_valid_plan_sha256 = "";
      state.repair = {
        ...state.repair!,
        mode: "repair",
        repair_source: "coverage",
        coverage_review_fingerprint: "f".repeat(64),
        coverage_finding_ids: ["finding:route-is-now-frozen"],
      };
    });
    const frozen = await controller.dispatch("resolve_external_standard_reference", {
      ...input,
      origin_span_id: first.reference_literal_span_id,
      reference_literal_span_id: first.reference_literal_span_id,
      origin_field: "method",
    });
    expect(frozen).toMatchObject({
      ok: true,
      occurrence_id: first.occurrence_id,
      origin_field: "requirement",
      origin_field_correction_rejected: true,
      requested_origin_field: "method",
      route_frozen: true,
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences[0]!.origin_fields)
      .toEqual(["requirement"]);
  });

  test("saves transient duplicate reference routes without treating the draft as validated", async () => {
    const firstOrigin = "8.0.3 第一项应符合附录 B 的规定。";
    const secondOrigin = "8.0.4 第二项也应符合附录 B 的规定。";
    const source = [
      firstOrigin,
      secondOrigin,
      "# 附录 B 共同指标参数",
      "B.0.1 共同被引内容。",
    ].join("\n");
    const manifest = manifestFor(source, [firstOrigin, secondOrigin]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("duplicate-reference-route-staging"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const registry = await workspace.readSourceSpanRegistry();
    const originSpanIds = manifest.evidence.map((record) =>
      registry.spans.find((span) => span.evidence_id === record.evidence_id)!.span_id
    );
    const resolveFrom = (originSpanId: string) => controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "附录 B",
      target: { kind: "appendix", number: "B" },
      relation: "shared_appendix_requirement",
    });
    const first = await resolveFrom(originSpanIds[0]!);
    const second = await resolveFrom(originSpanIds[1]!);
    expect(first.occurrence_id).not.toBe(second.occurrence_id);
    expect(first).toMatchObject({ analysis_mode: "inline", target_key: second.target_key });
    expect(await controller.dispatch("read_document_reference_evidence", { target_key: first.target_key }))
      .toMatchObject({ ok: true, done: true, rows: expect.any(Array) });
    const sharedReplay = await controller.dispatch("read_document_reference_evidence", { target_key: second.target_key });
    expect(sharedReplay).toMatchObject({ ok: true, done: true, rows: expect.any(Array) });
    expect(sharedReplay.rows).not.toHaveLength(0);
    const sharedTargetSpanId = (await receiptEvidence(workspace, first))[0]!.span_id;
    expect(second).toMatchObject({
      ok: true,
      target_key: first.target_key,
      target_fingerprint: first.target_fingerprint,
    });
    const referenceFor = (key: string, receipt: Record<string, unknown>) => ({
      key,
      occurrence_id: receipt.occurrence_id,
      anchor_span_ids: [receipt.reference_literal_span_id],
      target_span_ids: [sharedTargetSpanId],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用只进入要求字段。" },
      destinations: [{ item_key: "shared-item", target_field: "requirement" }],
      reason: "两处来源暂时尝试路由到同一字段。",
    });
    expect(await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: {
        references: [
          referenceFor("first-reference", first),
          referenceFor("second-reference", second),
        ],
      },
    })).toMatchObject({ok:true,draft_status:"saved_local_validation_failed",content_validation_performed:true});
  });

  test("stages one confirmed reference receiver while other read components remain undecided", async () => {
    const origin = "8.0.3 构件甲应符合附录 B 的规定。";
    const source = [origin, "# 附录 B 施工要求", "B.0.1 构件甲的安装缝应紧密。", "B.0.2 部件乙的涂层应完整。"].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("partial-confirmed-reference"),
      manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source) });
    await workspace.updateState(state => { state.selector_stage = "table"; });
    const controller = await ToolController.create(workspace);
    const registry = await workspace.readSourceSpanRegistry();
    const originSpan = registry.spans.find(span => span.evidence_id === manifest.evidence[0]!.evidence_id)!.span_id;
    await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 });
    const receipt = await controller.dispatch("resolve_document_reference", { origin_span_id: originSpan,
      raw_reference: "附录 B", target: { kind: "appendix", number: "B" }, relation: "shared_appendix_requirement" });
    expect(receipt).toMatchObject({ ok: true, analysis_mode: "inline" });
    await controller.dispatch("read_document_reference_evidence", { target_key: receipt.target_key });
    const parts = await receiptEvidence(workspace, receipt);
    const confirmed = parts.find(part => part.text.includes("构件甲的安装缝"))!;
    const undecided = parts.find(part => part.text.includes("部件乙的涂层"))!;
    expect(confirmed).toBeDefined(); expect(undecided).toBeDefined();
    await controller.dispatch("read_target_selectors", {});
    const routeIssue = { code: "compiler_unhandled_evidence", path: "/source_dispositions",
      details: { evidence_ids: [manifest.evidence[0]!.evidence_id] } };
    const routedBefore = (await (controller as any).routeSelectorCompilerEvidenceReads([routeIssue]))[0];
    expect(routedBefore.details.missing_resolved_reference_routes).toHaveLength(1);
    expect(routedBefore.details.registered_reference_routes[0].target_fully_read).toBe(true);
    expect(routedBefore.details.how_to_pass).toContain("以已确认记录为暂存单位");
    expect(routedBefore.details.how_to_pass).toContain("未处理组件仍须后续全量校验");
    const before = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    const stateBefore = await workspace.readState(), registryBefore = await workspace.readSourceSpanRegistry();
    const field = (composition: string, span_ids: string[]) => ({ composition, span_ids, separator: " ", reason: "合成原文依据。" });
    const item = { key: "confirmed-receiver", lot_key: "confirmed-lot", name: "构件甲安装缝",
      category: "原文未标明类别", criterion_span_ids: [originSpan, confirmed.span_id], continuation_span_ids: [],
      fields: { name: field("semantic_summary", [originSpan, confirmed.span_id]),
        requirement: field("reference", [originSpan, confirmed.span_id]), method: field("not_applicable", []),
        quantity: field("not_applicable", []), note: field("not_applicable", []) }, table: null,
      inspection_data_type: "review", inspection_data_type_reason: "原文规定紧密状态。",
      inspection_data_type_span_ids: [confirmed.span_id], sampling: { status: "pending", rule_key: "", branch_keys: [],
        quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "抽样仍待调查。", confidence: 0 },
      reason: "只保存已经核对的构件甲来源，不替未判断组件作处置。" };
    const reference = { key: "partial-reference", occurrence_id: receipt.occurrence_id,
      anchor_span_ids: [receipt.reference_literal_span_id], target_span_ids: parts.map(part => part.span_id), action: "adopt",
      application_mode: "reference_only", import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "合成引用仅进入要求。" },
      origin_binding: { item_key: item.key, target_field: "requirement" },
      destinations: [{ item_key: item.key, target_field: "requirement" }],
      component_dispositions: [{ component_span_ids: [confirmed.span_id], decision: "same_judgment", item_keys: [item.key], reason: "真实字段已绑定这一条。" }],
      reason: "其余已读组件仍未判断，保存不表示整引用完成。" };
    const saved = await controller.dispatch("stage_target_selector_draft", { operation: "upsert", draft: {
      lots: [{ key: "confirmed-lot", name: "构件甲施工", scope_span_ids: [originSpan], reason: "合成原文界定本批对象。" }],
      items: [item], references: [reference],
    } });
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, budget_consumed: false, global_candidate_complete: false,
      local_validation: { ok: false } });
    expect(saved.content_validation_performed).toBe(true);
    const after = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    expect(after.references.find((r: any) => r.key === reference.key)).toEqual(reference);
    expect(after.references.find((r: any) => r.key === reference.key).component_dispositions)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ component_span_ids: [undecided.span_id] })]));
    expect(after.items.filter((i: any) => i.key !== item.key)).toEqual(before.items);
    const routedAfter = (await (controller as any).routeSelectorCompilerEvidenceReads([routeIssue]))[0];
    expect(routedAfter.details.missing_resolved_reference_routes).toEqual([]);
    expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
    const stateAfter = await workspace.readState();
    expect(stateAfter.selector_protocol).toEqual(stateBefore.selector_protocol);
    expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
    expect(stateAfter.validation_attempts).toBe(stateBefore.validation_attempts);
  });

  test("provider catalog reads do not launch independent analysis", async () => {
    const origin = "8.0.3 指标参数应符合本规范附录 B 的规定。";
    const source = [origin, "# 附录 B 测试指标", ...Array.from({ length: 25 }, (_, i) => `B.0.${i + 1} 第${i + 1}项允许偏差为1mm。`)].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("catalog-analysis-gate"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source) });
    const controller = await ToolController.create(workspace);
    const receipt = await controller.dispatch("resolve_document_reference", {
      origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id,
      raw_reference: "附录 B", target: { kind: "appendix", number: "B" }, relation: "appendix_requirement",
    });
    expect(receipt.ok).toBe(true);
    const targetKey = String(receipt.target_key);
    for (const phase of ["target", "coverage"] as const) {
      expect(await readAnalyzedReferenceCatalog(workspace, await workspace.readEvidenceManifest(), targetKey, {}, phase))
        .toMatchObject({ ok: true, catalog: expect.any(Array) });
    }
    const ensureReferenceFacts = vi.fn(async () => {
      const analysis = await ReferenceAnalysisController.openOrCreate(workspace, await workspace.readEvidenceManifest(), targetKey);
      let pageNumber = 0;
      while ((await analysis.readState()).next_cursor !== null) {
        const page = await analysis.dispatch("read_reference_target_page", {});
        expect((await analysis.dispatch("stage_reference_facts", { upserts: [{ fact_key: `page-${++pageNumber}`, role: "requirement", page_handle: page.page_handle, row_indices: [0], reason: "测试分析来源" }] })).ok).toBe(true);
      }
      return analysis.dispatch("seal_reference_analysis", {});
    });
    const tool = createPiTools(controller, { ensureReferenceFacts }).find((tool) => tool.name === "read_reference_facts")!;
    const result = await tool.execute("catalog-gate", { target_key: targetKey }, undefined as never, undefined as never) as { details: Record<string, unknown> };
    expect(result.details).toMatchObject({ ok: true, catalog: expect.any(Array) });
    expect(ensureReferenceFacts).not.toHaveBeenCalled();
    await tool.execute("catalog-cached", { target_key: targetKey }, undefined as never, undefined as never);
    expect(ensureReferenceFacts).not.toHaveBeenCalled();
    expect(await referenceAnalysisIssues(workspace, await workspace.readEvidenceManifest()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "reference_catalog_entries_undisposed" })]));
    const beforeReads = (await workspace.readState()).opened_evidence_ids;
    const entryId = (result.details.catalog as Array<{ entry_id: string }>)[0]!.entry_id;
    const resolved = await controller.dispatch("read_reference_facts", {
      target_key: targetKey, entry_ids: [entryId],
      resolve_rows: [{ entry_id: entryId, row_index: 0 }],
      skip_rest: { reason: "本测试只引用第一行" },
    });
    expect(resolved.ok).toBe(true);
    const resolvedRowIds = (resolved.resolved_rows as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
    const rowId = resolvedRowIds[0]!;
    expect((await workspace.readState()).opened_evidence_ids).toEqual([...new Set([...beforeReads, ...resolvedRowIds])].sort());
    const row = (await workspace.readEvidenceManifest()).evidence.find(e => e.evidence_id === rowId)!;
    const narrow = await controller.dispatch("locate_evidence_span", { evidence_id: rowId, quote: row.text.slice(0, 4) });
    expect(narrow.ok, JSON.stringify(narrow)).toBe(true);
    const unread = (await workspace.readEvidenceManifest()).evidence.find(e => !resolvedRowIds.includes(e.evidence_id) && e.evidence_scope === "reference")!;
    expect(unread).toBeDefined();
    expect(await controller.dispatch("locate_evidence_span", { evidence_id: unread.evidence_id, quote: unread.text }))
      .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
    expect(await controller.dispatch("batch_locate_evidence_spans", { requests: [
      { evidence_id: rowId, quote: row.text.slice(0, 4) },
      { evidence_id: unread.evidence_id, quote: "not present in the unread row" },
    ] })).toMatchObject({ ok: false, results: [
      { ok: true, evidence_id: rowId },
      { ok: false, error: "isolated_reference_body_access_forbidden" },
    ] });
    await controller.dispatch("read_reference_facts", { target_key: targetKey });
    expect((await workspace.readState()).opened_evidence_ids).toEqual([...new Set([...beforeReads, ...resolvedRowIds])].sort());
  });

  test("keeps a large appendix success receipt below the modeling response budget and pages its inventory", async () => {
    const origin = "8.0.3 指标参数应符合本规范附录 B 的规定。";
    const appendixLines = Array.from({ length: 450 }, (_entry, index) =>
      `B.0.${index + 1} ${"性能指标与测试条件".repeat(10)} ${index + 1}`
    );
    const source = [origin, "# 附录 B 大型测试指标", ...appendixLines].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("large-reference-receipt"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const tools = createPiTools(controller);
    const resolveTool = tools.find((tool) => tool.name === "resolve_document_reference")!;
    const result = await resolveTool.execute("large-reference-call", {
      origin_span_id: originSpanId,
      origin_field: "requirement",
      raw_reference: "附录 B",
      target: { kind: "appendix", number: "B" },
      relation: "large_appendix_requirement",
    }, undefined as never, undefined as never) as {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    };
    const responseBytes = Buffer.byteLength(result.content[0]!.text, "utf8");
    expect(responseBytes).toBeLessThanOrEqual(TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes);
    expect(result.content[0]!.text).not.toContain("reference_commit_checklist");
    expect(new TargetModelingPhaseBudget().recordToolResult(
      "resolve_document_reference",
      result,
      "primary",
    )).toMatchObject({ exceeded: false, reason: "" });
    expect(result.details).toMatchObject({ ok: true, receipt_compacted: true, occurrence_id: expect.any(String), target_key: expect.stringMatching(/^reference-target:[a-f0-9]{64}$/u), evidence_count: 451, analysis_status: "not_required", analysis_mode: "isolated", target_text_utf8_bytes: expect.any(Number), estimated_compact_page_count: Math.ceil(451 / 24), target_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(result.details).not.toHaveProperty("target_evidence_ids");
    expect(result.details).not.toHaveProperty("evidence");
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_document_reference_evidence", "read_reference_facts"]));

    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }))
      .toMatchObject({ok:false,error:"selector_stage_incomplete",draft_status:"saved_stage_incomplete",content_validation_performed:true,current_stage:"primary"});
    const readBodyTool = tools.find((tool) => tool.name === "read_document_reference_evidence")!;
    const isolatedRead = await readBodyTool.execute("isolated-reference-body", {
      target_key: result.details.target_key,
    }, undefined as never, undefined as never) as {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    };
    const visibleIsolatedRead = JSON.parse(isolatedRead.content[0]!.text);
    for (const receipt of [isolatedRead.details, visibleIsolatedRead]) {
      expect(receipt).toMatchObject({
        ok: false,
        error: "isolated_reference_body_read_forbidden",
        target_key: result.details.target_key,
        analysis_mode: "isolated",
        required_action: "call_read_reference_facts_with_target_key_then_open_selected_entry_ids",
        next_tool: "read_reference_facts",
        tool_arguments: { target_key: result.details.target_key },
        writable_parameters: ["target_key"],
        do_not_edit: expect.any(String),
        instruction: expect.stringContaining("read_reference_facts 的 target_key 取得目录"),
      });
      expect(String(receipt.instruction)).toContain("按 entry_ids 及分页参数完整读取所选行");
      expect(String(receipt.instruction)).toContain("resolved_rows 返回已读行的 evidence_id 和整行 span_id");
      expect(String(receipt.instruction)).toContain("不能用 open_evidence、read_document_reference_evidence 或定位工具读取尚未交付的隔离正文");
      expect(String(receipt.instruction)).toContain("读完一行后，可按该行 quote_locator 用 locate_evidence_span");
    }
    const isolatedEvidence = (await receiptEvidence(workspace, result.details))[0]!;
    expect(await controller.dispatch("open_evidence", { evidence_id: isolatedEvidence.evidence_id }))
      .toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden", target_key: result.details.target_key });
    expect(await isolatedReferenceTargetForEvidence(workspace, await workspace.readEvidenceManifest(), isolatedEvidence.evidence_id, "coverage"))
      .toMatchObject({ analysis_mode: "isolated", target_key: result.details.target_key });
    const analysis = await ReferenceAnalysisController.openOrCreate(workspace, await workspace.readEvidenceManifest(), String(result.details.target_key));
    const analysisTools = createReferenceAnalysisTools(analysis);
    expect(analysisTools.map((tool) => tool.name)).toEqual([
      "read_reference_target_page", "stage_reference_facts", "read_staged_reference_facts", "seal_reference_analysis", "report_reference_analysis_blocker",
    ]);
    let pageCount = 0;
    while ((await analysis.readState()).next_cursor !== null) {
      const page = await analysis.dispatch("read_reference_target_page", {});
      pageCount += 1;
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(48 * 1024);
      expect(JSON.stringify(page)).not.toContain("evidence_id");
      await analysis.dispatch("stage_reference_facts", { upserts: [{ fact_key: `page-${pageCount}`, role: "requirement", page_handle: page.page_handle, row_indices: [0], reason: "分页精确事实" }] });
    }
    expect(pageCount).toBe(Math.ceil(450 / 16));
    const firstPageHandle = Object.keys((await analysis.readState()).pages)[0]!;
    expect(await analysis.dispatch("stage_reference_facts", { upserts: [{ fact_key: "bad-row", role: "requirement", page_handle: firstPageHandle, row_indices: [999], reason: "越界行" }] }))
      .toMatchObject({ ok: false, error: "reference_fact_page_binding_invalid" });
    expect(await analysis.dispatch("seal_reference_analysis", {})).toMatchObject({ ok: true, analysis_status: "sealed", fact_count: pageCount });
    const currentManifest = await workspace.readEvidenceManifest();
    // 消费侧现在拿的是目录，不是全部要点：标题加 450 条同级条文没有可聚合结构，
    // 确定性规则会被「粒度过碎」闸门拒绝，退到分段兜底——目录照样全覆盖、可挑选。
    const targetKey = String(result.details.target_key);
    const catalogView = await readReferenceCatalog(workspace, currentManifest, targetKey);
    expect(catalogView).toMatchObject({ ok: true, rule_source: "fallback", evidence_count: 451 });
    const catalogEntries = catalogView.catalog as Array<{ entry_id: string }>;
    expect(catalogEntries.length).toBeGreaterThan(1);
    // 目录本身必须远小于把全部正文推过来
    expect(Buffer.byteLength(JSON.stringify(catalogView), "utf8"))
      .toBeLessThan(TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes);

    expect(await referenceAnalysisIssues(workspace, currentManifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
    ]));

    // 只取第一条，其余用一句共同理由一次处理掉。逐条写理由比全开还贵，模型就会一律全开——
    // 现场实测它拿到 34 条目录后零推理直接全列进 entry_ids，所以便宜的收尾方式必须存在。
    const opened = await readReferenceCatalog(workspace, currentManifest, targetKey, {
      entry_ids: [catalogEntries[0]!.entry_id],
      skip_rest: { reason: "与本目标验收项目无关" },
    });
    expect(opened).toMatchObject({ ok: true, disposition: { used: 1, ignored: catalogEntries.length - 1, pending: 0 } });
    // 展开的行只有 [行号, 正文]：每行挂一个 75 字节 evidence_id 曾占掉整个响应的 32%
    const openedRows = (opened.entries as Array<{ rows: unknown[] }>)[0]!.rows;
    expect(openedRows.length).toBeGreaterThan(0);
    expect(openedRows[0]).toEqual([0, expect.any(String)]);
    expect(JSON.stringify(opened.entries)).not.toContain("evidence:");
    expect(await referenceAnalysisIssues(workspace, await workspace.readEvidenceManifest())).toEqual([]);

    // 点名行后直接取得整行引用凭证，不再要求第二次定位。
    const resolvedRows = await readReferenceCatalog(workspace, await workspace.readEvidenceManifest(), targetKey, {
      resolve_rows: [{ entry_id: catalogEntries[0]!.entry_id, row_index: 0 }],
    });
    expect((resolvedRows.resolved_rows as Array<{ evidence_id: string }>)[0]!.evidence_id)
      .toMatch(/^evidence:[a-f0-9]{64}$/u);
    expect((resolvedRows.resolved_rows as Array<{ span_id: string }>)[0]!.span_id)
      .toMatch(/^span:[a-f0-9]{32}$/u);
    expect(resolvedRows).toMatchObject({ citation_scope: "full_row" });

    // 目录里没有的 entry_id 必须被拒，不能默默当成已表态
    expect(await readReferenceCatalog(workspace, await workspace.readEvidenceManifest(), targetKey, { entry_ids: ["seg:9999"] }))
      .toMatchObject({ ok: false, error: "reference_catalog_entry_not_found" });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(1);
  }, 15_000);

  test("shares one bounded appendix inventory across two real occurrences", async () => {
    const firstOrigin = "4 对绞电缆布线系统链路或信道的指标参数应符合本规范附录 B 规定。";
    const secondOrigin = "8.0.7 测试内容应按本规范附录 A、附录 B、附录 C 的规定记录。";
    const appendixLines = Array.from({ length: 422 }, (_entry, index) =>
      `B.0.${index + 1} ${"性能指标与测试条件".repeat(6)} ${index + 1}`
    );
    const source = [firstOrigin, secondOrigin, "# 附录 B 对绞电缆指标参数", ...appendixLines].join("\n");
    const manifest = manifestFor(source, [firstOrigin, secondOrigin]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("shared-large-reference-target"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const registry = await workspace.readSourceSpanRegistry();
    const originSpanIds = manifest.evidence.map((record) =>
      registry.spans.find((span) => span.evidence_id === record.evidence_id)!.span_id
    );
    const resolveFrom = async (originSpanId: string, rawReference: string) =>
      controller.dispatch("resolve_document_reference", {
        origin_span_id: originSpanId,
        raw_reference: rawReference,
        target: { kind: "appendix", number: "B" },
        relation: "appendix_b_requirement",
      });
    const first = await resolveFrom(originSpanIds[0]!, "本规范附录 B");
    const second = await resolveFrom(originSpanIds[1]!, "附录 B");
    expect(first.occurrence_id).not.toBe(second.occurrence_id);
    expect(first.target_key).toBe(second.target_key);
    expect(first.target_fingerprint).toBe(second.target_fingerprint);
    const firstAnalysis = await ReferenceAnalysisController.openOrCreate(workspace, await workspace.readEvidenceManifest(), String(first.target_key));
    const secondAnalysis = await ReferenceAnalysisController.openOrCreate(workspace, await workspace.readEvidenceManifest(), String(second.target_key));
    expect(secondAnalysis.root).toBe(firstAnalysis.root);
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(2);
  });

  test("creates independent auditable analysis workspaces for A, B, and C targets", async () => {
    const origin = "8.0.7 测试内容应按本规范附录 A、附录 B、附录 C 的规定。";
    const source = [origin, ...["A", "B", "C"].flatMap((appendix) => [`# 附录 ${appendix} 项目`, ...Array.from({ length: 25 }, (_entry, index) => `${appendix}.0.${index + 1} ${appendix}要求${index + 1}。`)])].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("abc-reference-analysis"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source) });
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const receipts = [];
    for (const appendix of ["A", "B", "C"]) {
      receipts.push(await controller.dispatch("resolve_document_reference", {
        origin_span_id: originSpanId,
        raw_reference: `附录 ${appendix}`,
        target: { kind: "appendix", number: appendix },
        relation: `appendix_${appendix.toLowerCase()}_requirement`,
      }));
    }
    expect(new Set(receipts.map((receipt) => receipt.occurrence_id)).size).toBe(3);
    expect(new Set(receipts.map((receipt) => receipt.target_key)).size).toBe(3);
    expect(receipts.every((receipt) => receipt.analysis_mode === "isolated")).toBe(true);
    const currentManifest = await workspace.readEvidenceManifest();
    const analyses = await Promise.all(receipts.map((receipt) => ReferenceAnalysisController.openOrCreate(workspace, currentManifest, String(receipt.target_key))));
    expect(new Set(analyses.map((analysis) => analysis.root)).size).toBe(3);
    expect(new Set(analyses.map((analysis) => analysis.piSessionDirectory)).size).toBe(3);
  });

  test("retries a first 429 in a fresh session from the durable reference cursor", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
    let sessionCalls = 0;
    const seenCursors: number[] = [];
    const result = await runLiveReferenceAnalysis(
      workspace,
      manifest,
      targetKey,
      undefined,
      undefined,
      {
        transportRetries: 1,
        runSession: async (_sessionWorkspace, options) => {
          sessionCalls += 1;
          await options.setRuntime({
            kind: "pi-sdk",
            session_id: `reference-session-${sessionCalls}`,
            session_file: `reference-session-${sessionCalls}.jsonl`,
          });
          expect(options.resume).toBe(false);
          const call = async (name: string, input: Record<string, unknown>) => {
            const tool = options.customTools.find((entry) => entry.name === name)!;
            return (await tool.execute(
              `${name}-${sessionCalls}`,
              input,
              undefined as never,
              undefined as never,
            )).details as Record<string, unknown>;
          };
          const page = await call("read_reference_target_page", {});
          seenCursors.push(Number(page.cursor));
          await call("stage_reference_facts", {
            upserts: [{
              fact_key: `fact-${sessionCalls}`,
              role: "requirement",
              page_handle: page.page_handle,
              row_indices: [0],
              reason: "回归测试精确行",
            }],
          });
          if (sessionCalls === 1) throw new Error("429 status code (no body)");
          expect(page.next_cursor).toBeNull();
          await call("seal_reference_analysis", {});
          return {
            session_id: `reference-session-${sessionCalls}`,
            session_file: `reference-session-${sessionCalls}.jsonl`,
            completed: true,
            model: "scripted-reference-analysis",
          };
        },
      },
    );

    expect(result).toMatchObject({ analysis_status: "sealed", fact_count: 2 });
    expect(sessionCalls).toBe(2);
    expect(seenCursors).toEqual([0, 16]);
    const state = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey)
      .then((controller) => controller.readState());
    expect(state).toMatchObject({
      status: "sealed",
      next_cursor: null,
      transport_failures: 1,
      last_transport_failure: "429 status code (no body)",
    });
  });

  test("rejects a false page-gap blocker and resumes from the persisted next page without losing facts", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture(112);
    const analysis = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
    let stagedFacts = 0;
    for (const expectedCursor of [0, 16, 32, 48]) {
      const page = await analysis.dispatch("read_reference_target_page", {});
      expect(page).toMatchObject({ ok: true, cursor: expectedCursor, next_cursor: expectedCursor + 16 });
      const rowIndices = expectedCursor === 48 ? [0, 1, 2, 3, 4, 5, 6] : [0];
      const staged = await analysis.dispatch("stage_reference_facts", {
        upserts: rowIndices.map((rowIndex) => ({
          fact_key: `page-${expectedCursor}-row-${rowIndex}`,
          role: "requirement",
          page_handle: page.page_handle,
          row_indices: [rowIndex],
          reason: "持久化页连续性回归",
        })),
      });
      expect(staged.ok).toBe(true);
      stagedFacts += rowIndices.length;
    }

    const rejected = await analysis.dispatch("report_reference_analysis_blocker", {
      code: "page_gap",
      reason: "cursor 从 48 跳到 64，48–63 未暴露",
      reported_cursor: 48,
      reported_next_cursor: 64,
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: "reference_analysis_blocker_rejected",
      blocker_code: "page_gap",
      required_action: "continue_with_read_reference_target_page; next_cursor_is_the_start_of_the_next_page_not_a_missing_page",
      persisted_continuity: {
        continuous: true,
        persisted_next_cursor: 64,
        pages: expect.arrayContaining([
          expect.objectContaining({ cursor: 48, next_cursor: 64, fact_count: 7, staged: true }),
        ]),
      },
    });
    expect(await analysis.readState()).toMatchObject({ status: "running", next_cursor: 64, fact_count: stagedFacts });

    // Simulate a legacy/interrupted harness that had already persisted this
    // structured false blocker. Recovery must retain the staged fact draft.
    const interruptedState = await analysis.readState();
    await atomicWriteJson(analysis.statePath, {
      ...interruptedState,
      status: "failed",
      terminal_reason: "cursor 48 was reported missing",
      terminal_blocker: {
        code: "page_gap",
        reason: "cursor 48 was reported missing",
        reported_cursor: 48,
        reported_next_cursor: 64,
      },
    });
    await expect(analysis.recoverVerifiedPageGapBlocker()).resolves.toMatchObject({
      ok: true,
      next_cursor: 64,
      fact_count: stagedFacts,
      persisted_continuity: { continuous: true },
    });
    expect(await analysis.readState()).toMatchObject({ status: "pending", next_cursor: 64, fact_count: stagedFacts });
    const resumed = await analysis.dispatch("read_reference_target_page", {});
    expect(resumed).toMatchObject({ ok: true, cursor: 64, next_cursor: 80 });
    expect((await analysis.dispatch("read_staged_reference_facts", {})).facts).toHaveLength(stagedFacts);
  });

  test("reopens the last unstaged page before advancing after an interrupted analysis", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
    const analysis = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
    const first = await analysis.dispatch("read_reference_target_page", {});
    expect(first).toMatchObject({ ok: true, cursor: 0, next_cursor: 16 });

    const resumed = await analysis.dispatch("read_reference_target_page", {});
    expect(resumed).toMatchObject({
      ok: true,
      cursor: 0,
      next_cursor: 16,
      resumed_unstaged_page: true,
      page_handle: first.page_handle,
    });
    await expect(analysis.dispatch("stage_reference_facts", {
      upserts: [{
        fact_key: "recovered-first-page",
        role: "requirement",
        page_handle: resumed.page_handle,
        row_indices: [0],
        reason: "恢复时保留已打开页面",
      }],
    })).resolves.toMatchObject({ ok: true, fact_count: 1 });
    await expect(analysis.dispatch("read_reference_target_page", {})).resolves.toMatchObject({
      ok: true,
      cursor: 16,
    });
  });

  test("reads source catalog even when historical independent analysis failed", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
    const analysis = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
    await expect(analysis.dispatch("report_reference_analysis_blocker", {
      code: "source_unavailable",
      reason: "reference source was unavailable",
    })).resolves.toMatchObject({ ok: true, analysis_status: "failed" });

    const controller = await ToolController.create(workspace);
    const ensureReferenceFacts = vi.fn(async () => ({ ok: false }));
    const tool = createPiTools(controller, { ensureReferenceFacts }).find((entry) => entry.name === "read_reference_facts")!;
    const read = async () => (await tool.execute(
      "failed-reference-facts",
      { target_key: targetKey },
      undefined as never,
      undefined as never,
    )).details as Record<string, unknown>;

    const first = await read();
    expect(first).toMatchObject({ ok: true, catalog: expect.any(Array) });
    await expect(read()).resolves.toMatchObject({ ok: true, catalog: expect.any(Array) });
    expect(ensureReferenceFacts).not.toHaveBeenCalled();
  });

  test("bubbles exhausted reference transport failures without starting another session", async () => {
    const { workspace, manifest, targetKey } = await isolatedReferenceFixture();
    let sessionCalls = 0;
    const runSession = async () => {
      sessionCalls += 1;
      throw new Error("503 upstream unavailable");
    };
    const invoke = () => runLiveReferenceAnalysis(
      workspace,
      manifest,
      targetKey,
      undefined,
      undefined,
      { transportRetries: 1, runSession },
    );

    await expect(invoke()).rejects.toThrow(
      "reference_analysis_transport_retry_exhausted: 503 upstream unavailable",
    );
    expect(sessionCalls).toBe(2);
    const controller = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
    expect(await controller.readState()).toMatchObject({
      status: "pending",
      transport_failures: 2,
      last_transport_failure: "503 upstream unavailable",
    });
    await expect(invoke()).rejects.toThrow("reference_analysis_transport_retry_exhausted");
    expect(sessionCalls).toBe(2);
  });

  test("uses objective size and cumulative inline bytes rather than reference kind", async () => {
    const smallAppendixManifest = manifestFor("6.1.1 见附录 A。\n# 附录 A 小目标\nA.0.1 小要求。", "6.1.1 见附录 A。");
    const smallOccurrence = {
      occurrence_id: "small", origin_evidence_id: smallAppendixManifest.evidence[0]!.evidence_id, origin_span_id: "span", reference_literal_span_id: "span", origin_fields: ["requirement"], raw_reference: "附录 A", relation: "small", target_evidence_ids: [smallAppendixManifest.evidence.at(-1)!.evidence_id], required: true, status: "resolved", depth: 1, path: [], reference_kind: "clause", target_address: { source_id: smallAppendixManifest.source.sha256, locator_kind: "appendix", locator: "appendix:A" },
    } as const;
    expect(referenceAnalysisPolicy(smallAppendixManifest, smallOccurrence)).toMatchObject({ analysis_mode: "inline", estimated_compact_page_count: 1 });
    expect(referenceAnalysisPolicy(smallAppendixManifest, smallOccurrence, REFERENCE_INLINE_PHASE_BYTES_BUDGET + 1)).toMatchObject({ analysis_mode: "isolated", mode_reason: "inline_phase_bytes_budget" });

    const largeTableText = "表 1 大表\n<table><tr><td>序号</td><td>要求</td></tr>"
      + Array.from({ length: 25 }, (_entry, index) => `<tr><td>${index + 1}</td><td>${"数值".repeat(600)}</td></tr>`).join("")
      + "</table>";
    const largeTableSource = `1.1.1 应符合表 1。\n${largeTableText}`;
    const largeTableManifest = manifestFor(largeTableSource, "1.1.1 应符合表 1。");
    const resolvedTable = resolveDocumentReferenceTarget(largeTableSource, largeTableManifest.source.sha256, { kind: "table", number: "1" });
    expect(resolvedTable.ok).toBe(true);
    if (!resolvedTable.ok) return;
    const tableRecords = resolvedTable.target_evidence_ids;
    const policyManifest = { ...largeTableManifest, evidence: [...largeTableManifest.evidence, ...resolvedTable.evidence] };
    const largeTableOccurrence = { ...smallOccurrence, occurrence_id: "large-table", target_evidence_ids: tableRecords, raw_reference: "表 1", reference_kind: "table", target_table_id: "1", target_address: { source_id: largeTableManifest.source.sha256, locator_kind: "table", locator: "table:1" } } as const;
    expect(referenceAnalysisPolicy(policyManifest, largeTableOccurrence)).toMatchObject({ analysis_mode: "isolated" });
  });

  test("GB/T 50312 6.2.3 keeps both local spans and repairs only the reference destination", async () => {
    const manifest = manifestFor(GB50312_MIXED_REFERENCE, [MIXED_FIRST, MIXED_SECOND]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("gb50312-mixed-reference"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(GB50312_MIXED_REFERENCE) },
    );
    const controller = await ToolController.create(workspace);
    const initialRegistry = await workspace.readSourceSpanRegistry();
    const firstSpanId = initialRegistry.spans.find((span) =>
      span.evidence_id === manifest.evidence[0]!.evidence_id
    )!.span_id;
    const secondSpanId = initialRegistry.spans.find((span) =>
      span.evidence_id === manifest.evidence[1]!.evidence_id
    )!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: firstSpanId,
      raw_reference: "本规范第6.1.1条第8款",
      target: { kind: "clause", number: "6.1.1", paragraph: "8" },
      relation: "conditional_additional_requirement",
    });
    expect(resolved).toMatchObject({ ok: true });
    const referenceLiteralSpanId = resolved.reference_literal_span_id as string;
    const currentManifest = await workspace.readEvidenceManifest();
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const resolvedComponents = await receiptEvidence(workspace, resolved);
    const targetEvidence = resolvedComponents.find((entry) =>
      entry.text.includes("平行敷设")
    )!;
    const targetSpanId = targetEvidence.span_id;
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({
      key: "lot-6.2.3",
      name: "干线子系统缆线敷设保护",
      scope_span_ids: [firstSpanId, secondSpanId],
      reason: "6.2.3 两段本地要求共同形成验收范围。",
    });
    selectors.items.push({
      key: "item-ganxiantongdao",
      lot_key: "lot-6.2.3",
      name: "干线缆线竖井布放与通道连通",
      category: "主控项目",
      criterion_span_ids: [firstSpanId, secondSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [firstSpanId, secondSpanId], separator: "", reason: "两段共同定义验收对象。" },
        requirement: { composition: "verbatim", span_ids: [firstSpanId, secondSpanId], separator: "\n", reason: "完整保留本地禁止、条件和通道连通要求。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定方法。" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定数量。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
      },
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "核查竖井布放限制与通道连通状态。",
      inspection_data_type_span_ids: [firstSpanId, secondSpanId],
      sampling: {
        status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [],
        script_span_ids: [], condition_span_ids: [], reason: "无抽样规定。", confidence: 1,
      },
      reason: "两段本地原文属于同一干线通道验收判断。",
    });
    selectors.references.push({
      key: "ref-6.1.1-8",
      occurrence_id: resolved.occurrence_id as string,
      anchor_span_ids: [referenceLiteralSpanId],
      target_span_ids: resolvedComponents.map(entry => entry.span_id),
      action: "conditional",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用只补充要求字段。" },
      destinations: [{ item_key: "item-ganxiantongdao", target_field: "requirement" }],
      reason: "引用属于 requirement；保留两段本地要求和原引用，并在原 literal 位置附带解析内容。",
    });

    const validMixedPlan = hydrateSemanticSourcePlan(
      compileTargetSelectors(selectors, currentRegistry, currentManifest),
      currentManifest,
    );
    expect(validMixedPlan.reference_resolutions[0]!.target_evidence_ids)
      .toEqual(resolvedComponents.map(entry => entry.evidence_id));
    expect(validatePlanText(prettyJson(validMixedPlan), currentManifest))
      .toMatchObject({ ok: true, issues: [] });
    const materialized = materialize(validMixedPlan, currentManifest, "mixed-reference-plan").result;
    const materializedItem = materialized.inspection_lots[0]!.items[0]!;
    expect(materializedItem.requirement).toContain(MIXED_FIRST);
    expect(materializedItem.requirement).toContain(MIXED_SECOND);
    expect(materializedItem.inline_references).toEqual([expect.objectContaining({
      field: "requirement",
      raw_reference: "本规范第6.1.1条第8款",
      reference_literal_span_id: referenceLiteralSpanId,
      segments: expect.arrayContaining([
        expect.objectContaining({ kind: "reference", raw_reference: "本规范第6.1.1条第8款" }),
      ]),
      resolved_content: {
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: "table_row",
            table_id: "6.1.1-2",
            row_index: 2,
            cells: ["平行敷设", "130", "300"],
          }),
        ]),
      },
    })]);
    expect(currentManifest.reference_occurrences[0]).toMatchObject({
      raw_reference: "本规范第6.1.1条第8款",
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      relation: "conditional_additional_requirement",
      target_evidence_ids: expect.arrayContaining([expect.any(String)]),
    });
    const missingReceipt = structuredClone(selectors);
    missingReceipt.references = [];
    missingReceipt.items[0]!.fields.requirement.composition = "reference";
    try {
      compileTargetSelectors(missingReceipt, currentRegistry, currentManifest);
      throw new Error("expected unresolved reference composition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_composition_without_resolve_receipt",
          details: expect.objectContaining({
            allowed_actions: expect.arrayContaining([
              expect.stringContaining("本地原文"),
              expect.stringContaining("reference_only"),
            ]),
            candidate_read_tool: "read_target_selectors",
            next_tool: "read_target_selectors",
            save_tool: "stage_target_selector_draft",
            how_to_pass: expect.stringContaining("outside_reference_targets"),
          }),
        }),
      ]));
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_registered_reference_receipt_missing") as any;
      expect(issue).toMatchObject({
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          actual: expect.objectContaining({ occurrence_id: currentManifest.reference_occurrences[0]!.occurrence_id, matching_reference_keys: [] }),
          writable_path: "/references",
          candidate_read_tools: expect.arrayContaining(["list_reference_occurrences", "read_target_selectors"]),
          next_tool: "list_reference_occurrences",
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("occurrence_id"),
        },
      });
    }
    const itemBeforeWrongRoute = structuredClone(selectors.items[0]);
    const wrongRoute = structuredClone(selectors);
    wrongRoute.references[0]!.destinations[0]!.target_field = "note";
    const wrongCompiled = compileTargetSelectors(wrongRoute, currentRegistry, currentManifest);
    expect(wrongCompiled.reference_resolutions[0]).toMatchObject({
      origin_binding: { target_field: "requirement" },
      destination_bindings: [{ target_field: "note" }],
    });
    expect(validatePlanText(prettyJson(wrongCompiled), currentManifest).issues)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "reference_destination_field_mismatch" })]));
    expect(wrongRoute.items[0]).toEqual(itemBeforeWrongRoute);
    expect(wrongRoute.items[0]!.criterion_span_ids).toEqual([firstSpanId, secondSpanId]);
    expect(wrongRoute.items[0]!.fields.requirement.span_ids).toEqual([firstSpanId, secondSpanId]);

    const invalidPlaceholder = structuredClone(selectors);
    invalidPlaceholder.references[0]!.application_mode = "reference_placeholder";
    invalidPlaceholder.references[0]!.destinations = [];
    const invalidFingerprint = targetSelectorFingerprint(invalidPlaceholder);
    let rawIssue: any;
    try {
      compileTargetSelectors(invalidPlaceholder, currentRegistry, currentManifest);
      throw new Error("expected a mixed local requirement placeholder to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      rawIssue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_placeholder_local_requirement");
    }
    expect(rawIssue).toMatchObject({
      code: "selector_reference_placeholder_local_requirement",
      path: "/references/0/application_mode",
      message: expect.stringMatching(/[\u3400-\u9fff]/),
      details: {
        required_action: "keep_the_local_acceptance_item_and_route_the_resolved_reference_to_its_actual_field",
        actual: expect.objectContaining({
          reference_key: "ref-6.1.1-8",
          occurrence_id: resolved.occurrence_id,
          application_mode: "reference_placeholder",
          destinations: [],
          import_scope: invalidPlaceholder.references[0]!.import_scope,
          local_criterion_bindings: expect.arrayContaining([
            expect.objectContaining({ item_key: "item-ganxiantongdao", item_index: 0 }),
          ]),
          current_receiver_fields: [{
            item_key: "item-ganxiantongdao",
            item_index: 0,
            readable_path: "/items/0",
          }],
        }),
        writable_paths: expect.arrayContaining([
          "/references/0/application_mode",
          "/references/0/destinations",
          "/references/0/import_scope",
          "/items/0/criterion_span_ids",
          "/items/0/continuation_span_ids",
          "/items/0/fields",
          "/items/0/sampling",
        ]),
        candidate_read_tools: [
          "read_target_selectors",
          "list_reference_occurrences",
          "read_reference_facts",
          "read_document_reference_evidence",
          "open_evidence",
          "locate_evidence_span",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "ref-6.1.1-8" },
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("两种合法方向"),
      },
    });
    expect(rawIssue.details.actual.current_receiver_fields[0]).not.toHaveProperty("fields");
    expect(rawIssue.details.actual.current_receiver_fields[0]).not.toHaveProperty("table");
    expect(rawIssue.details.actual.current_receiver_fields[0]).not.toHaveProperty("sampling");
    expect(rawIssue.details.writable_paths).not.toContain("/references/0/component_dispositions");
    expect(rawIssue.details.candidate_read_tools).toContain("read_reference_facts");
    expect(targetSelectorFingerprint(invalidPlaceholder)).toBe(invalidFingerprint);

    const placeholderWithComponents = structuredClone(invalidPlaceholder);
    placeholderWithComponents.references[0]!.component_dispositions = [{
      component_span_ids: [targetSpanId],
      decision: "same_judgment",
      item_keys: ["item-ganxiantongdao"],
      reason: "保留现有组件接收关系以验证可写路径只按实际字段开放。",
    }];
    try {
      compileTargetSelectors(placeholderWithComponents, currentRegistry, currentManifest);
      throw new Error("expected the component-bearing mixed placeholder to fail");
    } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find(row =>
        row.code === "selector_reference_placeholder_local_requirement"
      ) as any;
      expect(issue.details.actual.component_dispositions)
        .toEqual(placeholderWithComponents.references[0]!.component_dispositions);
      expect(issue.details.writable_paths).toContain("/references/0/component_dispositions");
    }

    const staged = await controller.dispatch("stage_target_selector_draft", {
      draft: {
        lots: invalidPlaceholder.lots,
        items: invalidPlaceholder.items,
        references: invalidPlaceholder.references,
      },
    }) as any;
    expect(staged.model_review).toMatchObject({ blocking: false, decision_owner: "model" });
    const wrappedIssue = staged.model_review.observations.find((row: any) =>
      row.code === "selector_reference_placeholder_local_requirement"
    );
    expect(wrappedIssue).toMatchObject({
      code: rawIssue.code,
      actual: rawIssue.details.actual,
      writable_path: "/references/0/application_mode",
      writable_paths: expect.arrayContaining(rawIssue.details.writable_paths),
      supporting_read: { tool: "read_target_selectors", arguments: rawIssue.details.next_tool_arguments },
      candidate_read_tools: expect.arrayContaining(rawIssue.details.candidate_read_tools),
      save_tool: "stage_target_selector_draft",
      how_to_pass: expect.stringContaining("两种合法方向"),
      details: {
        required_action: rawIssue.details.required_action,
        local_criterion_bindings: rawIssue.details.local_criterion_bindings,
      },
    });
    expect(wrappedIssue).not.toHaveProperty("next_tool");
    expect(wrappedIssue.actual.current_receiver_fields[0]).not.toHaveProperty("fields");
    expect(wrappedIssue.actual.current_receiver_fields[0]).not.toHaveProperty("table");
    expect(wrappedIssue.actual.current_receiver_fields[0]).not.toHaveProperty("sampling");
    expect(controller.selectorProviderPolicy().allowed_tools).toEqual(expect.arrayContaining([
      ...wrappedIssue.candidate_read_tools,
      wrappedIssue.save_tool,
    ]));
    expect(targetSelectorFingerprint(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))))
      .toBe(invalidFingerprint);

  });

  test("pure pointer retains its literal and rejects same-text spans from another resolved occurrence", async () => {
    const pointer = "6.2.1 应符合本规范第1.1.1条的规定。";
    const source = [
      "# 1.1 被引要求",
      "1.1.1 被引实体要求。",
      "1.1.2 后续条文。",
      "# 6.2 保护措施",
      pointer,
    ].join("\n");
    const manifest = manifestFor(source, pointer);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("pure-pointer-reference"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const initialRegistry = await workspace.readSourceSpanRegistry();
    const originSpanId = initialRegistry.spans[0]!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" },
      relation: "pure_pointer_replacement",
    });
    expect(resolved).toMatchObject({ ok: true });
    const referenceLiteralSpanId = resolved.reference_literal_span_id as string;
    const currentManifest = await workspace.readEvidenceManifest();
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const targetSpanId = (await receiptEvidence(workspace, resolved))[0]!.span_id;
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({ key: "lot", name: "纯指针检验批", scope_span_ids: [originSpanId], reason: "纯指针条文。" });
    selectors.items.push({
      key: "item", lot_key: "lot", name: "被引实体要求", category: "一般项目",
      criterion_span_ids: [originSpanId], continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [originSpanId], separator: "", reason: "被引对象。" },
        requirement: { composition: "verbatim", span_ids: [originSpanId], separator: "", reason: "纯指针原文。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
      },
      table: null, inspection_data_type: "review", inspection_data_type_reason: "依据被引条文核验。",
      inspection_data_type_span_ids: [originSpanId],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无抽样。", confidence: 1 },
      reason: "纯指针允许整字段重建。",
    });
    selectors.references.push({
      key: "reference", occurrence_id: resolved.occurrence_id as string,
      anchor_span_ids: [referenceLiteralSpanId], target_span_ids: [targetSpanId],
      action: "adopt", application_mode: "reference_only",
      import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["requirement", "method", "quantity", "sampling"], reason: "纯指针委托完整验收程序。" },
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "本地字段只有引用指针，仍保留原 literal 并附带被引实体要求。",
    });
    const compiled = compileTargetSelectors(selectors, currentRegistry, currentManifest);
    const plan = hydrateSemanticSourcePlan(compiled, currentManifest);
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    expect(currentManifest.reference_occurrences[0]).toMatchObject({
      occurrence_id: resolved.occurrence_id,
      raw_reference: "本规范第1.1.1条",
      relation: "pure_pointer_replacement",
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
    });
    expect(plan.reference_resolutions[0]).toMatchObject({
      occurrence_id: resolved.occurrence_id,
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      application_mode: "reference_only",
    });
    const materialized = materialize(plan, currentManifest, "pure-pointer-plan").result;
    const item = materialized.inspection_lots[0]!.items[0]!;
    expect(item.requirement).toBe(pointer);
    expect(item.inline_references?.[0]).toMatchObject({
      field: "requirement",
      raw_reference: "本规范第1.1.1条",
      reference_literal_span_id: referenceLiteralSpanId,
      resolved_content: {
        records: [expect.objectContaining({ text: "1.1.1 被引实体要求。" })],
      },
    });

    // Equal source text and coordinates do not authorize cross-occurrence reuse.
    const foreignManifest = structuredClone(currentManifest);
    const allowedSpan = currentRegistry.spans.find(span => span.span_id === targetSpanId)!;
    const allowedEvidence = foreignManifest.evidence.find(entry => entry.evidence_id === allowedSpan.evidence_id)!;
    const foreignEvidenceId = "evidence:another-resolved-occurrence";
    foreignManifest.evidence.push({ ...structuredClone(allowedEvidence), evidence_id: foreignEvidenceId });
    foreignManifest.reference_occurrences.push({
      ...structuredClone(foreignManifest.reference_occurrences[0]!),
      occurrence_id: "reference:another-resolved-occurrence",
      target_evidence_ids: [foreignEvidenceId],
    });
    const foreignSpan = { ...allowedSpan, span_id: `span:${"f".repeat(32)}`, evidence_id: foreignEvidenceId };
    const foreignRegistry = structuredClone(currentRegistry);
    foreignRegistry.spans.push(foreignSpan);
    const wrongSelectors = structuredClone(selectors);
    wrongSelectors.references[0]!.target_span_ids.push(foreignSpan.span_id);
    const wrongCompiled = structuredClone(compiled);
    wrongCompiled.reference_resolutions[0]!.target_evidence_ids.push(foreignEvidenceId);
    const wrongPlan = structuredClone(plan);
    wrongPlan.reference_resolutions[0]!.target_evidence_ids.push(foreignEvidenceId);
    const strictIssues = validatePlanText(prettyJson(wrongPlan), foreignManifest).issues
      .filter(entry => entry.code === "reference_target_outside_occurrence");
    expect(strictIssues).toHaveLength(1);
    const [mapped] = classifyStrictSelectorIssues(wrongSelectors, wrongCompiled, foreignRegistry, strictIssues);
    const details = mapped!.details as any;
    expect(details.offending_target_spans).toEqual([{
      index: 1, span_id: foreignSpan.span_id, evidence_id: foreignEvidenceId, atom_id: foreignSpan.atom_id,
      start: foreignSpan.start, end: foreignSpan.end, writable_path: "/references/0/target_span_ids/1",
      save_template_path: "/draft/references/0/target_span_ids/1",
    }]);
    expect(details.offending_target_spans[0]).not.toHaveProperty("text");
    const save = details.tool_argument_hints.stage_target_selector_draft;
    expect(save.draft.references[0]).toEqual(wrongSelectors.references[0]);
    save.draft.references[0].target_span_ids.splice(details.offending_target_spans[0].index, 1);
    expect(await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert", draft: { lots: selectors.lots, items: selectors.items, references: selectors.references },
    })).toMatchObject({ ok: true });
    expect(await controller.dispatch("stage_target_selector_draft", save)).toMatchObject({ ok: true });
    const repairedSelectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    expect(repairedSelectors.references[0]).toEqual(selectors.references[0]);
    expect(repairedSelectors.items).toEqual(selectors.items);
    expect(wrongSelectors.references[0]!.target_span_ids).toEqual([targetSpanId, foreignSpan.span_id]);
    const repaired = compileTargetSelectors(repairedSelectors, currentRegistry, currentManifest);
    expect(validatePlanText(prettyJson(hydrateSemanticSourcePlan(repaired, currentManifest)), currentManifest))
      .toMatchObject({ ok: true, issues: [] });
  });

  test.each(["verbatim", "reference"] as const)("resolved table pointer can remain as a non-item reference placeholder (%s fields)", async (composition) => {
    const origin = "6.2.1 安装允许偏差及检验方法应符合表 1.2.1-1 的规定。";
    const source = [
      "# 1.2 安装允许偏差",
      "表 1.2.1-1 安装允许偏差",
      "<table><tr><td>项目</td><td>允许值</td><td>检查方法</td></tr><tr><td>间距</td><td>10</td><td>尺量</td></tr></table>",
      "# 6.2 安装检验",
      origin,
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("table-reference-placeholder"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const initialRegistry = await workspace.readSourceSpanRegistry();
    const originSpanId = initialRegistry.spans.find((span) =>
      span.evidence_id === manifest.evidence[0]!.evidence_id
    )!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "表 1.2.1-1",
      target: { kind: "table", number: "1.2.1-1" },
      relation: "table_acceptance_criteria",
    });
    expect(resolved).toMatchObject({ ok: true });

    const currentManifest = await workspace.readEvidenceManifest();
    let currentRegistry = await workspace.readSourceSpanRegistry();
    const targetEvidence = (await receiptEvidence(workspace, resolved))[0]!;
    const targetFragmentId = currentManifest.evidence.find((record) =>
      record.evidence_id === targetEvidence.evidence_id
    )!.table_fragment_id!;
    const registerTargetQuote = (quote: string): string => {
      const located = locateAndRegisterSourceQuote(currentRegistry, {
        source_id: targetEvidence.evidence_id,
        evidence_id: targetEvidence.evidence_id,
        atom_id: targetEvidence.evidence_id,
        text: targetEvidence.text,
      }, quote);
      currentRegistry = located.registry;
      return located.spans[0]!.span_id;
    };
    // Referenced rows and the formal caption are separate immutable records.
    const titleRecord = currentManifest.evidence.find(record =>
      record.table_fragment_id === targetFragmentId && record.role === "formal_table_title"
    )!;
    const tableTitleSpanId = currentRegistry.spans.find(span =>
      span.evidence_id === titleRecord.evidence_id && span.start === 0 && span.end === titleRecord.text.length
    )!.span_id;
    const nameSpanId = registerTargetQuote("间距");
    const valueSpanId = registerTargetQuote("10");
    const methodSpanId = registerTargetQuote("尺量");
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({
      key: "lot",
      name: "安装检验批",
      scope_span_ids: [originSpanId],
      reason: "同一安装验收范围。",
    });
    selectors.items.push({
      key: "table-row",
      lot_key: "lot",
      name: "间距允许偏差",
      category: "一般项目",
      criterion_span_ids: [nameSpanId, valueSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [nameSpanId], separator: "", reason: "表格行受检性质。" },
        requirement: { composition, span_ids: [valueSpanId], separator: "", reason: "表格行要求。" },
        method: { composition, span_ids: [methodSpanId], separator: "", reason: "表格行检查方法。" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
      },
      table: {
        source_kind: "reference",
        table_key: targetFragmentId,
        properties: {
          table_no_span_ids: [tableTitleSpanId],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [[nameSpanId]],
          column_path_span_ids: [],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [valueSpanId],
          inspection_method_span_ids: [methodSpanId],
        },
        reference_span_ids: [resolved.reference_literal_span_id as string],
        reason: "通过父条款引用表1.2.1-1的数据行。",
      },
      inspection_data_type: "measurement",
      inspection_data_type_reason: "表格给出允许偏差。",
      inspection_data_type_span_ids: [valueSpanId, methodSpanId],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "原文未给抽样。",
        confidence: 1,
      },
      reason: "表格数据行形成唯一验收叶。",
    });
    selectors.references.push({
      key: "table-placeholder",
      occurrence_id: resolved.occurrence_id as string,
      anchor_span_ids: [resolved.reference_literal_span_id as string],
      target_span_ids: [],
      action: "adopt",
      application_mode: "reference_placeholder",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "表格引用仅保留占位 provenance。" },
      destinations: [],
      reason: "父条款仅选择整表引用占位；程序从 occurrence 自动绑定全部合法数据行。",
    });

    const plan = hydrateSemanticSourcePlan(
      compileTargetSelectors(selectors, currentRegistry, currentManifest),
      currentManifest,
    );
    expect(plan.acceptance_items).toHaveLength(1);
    expect(plan.reference_resolutions[0]).toMatchObject({
      occurrence_id: resolved.occurrence_id,
      application_mode: "reference_placeholder",
      destination_bindings: [],
    });
    const occurrence = currentManifest.reference_occurrences.find((entry) =>
      entry.occurrence_id === resolved.occurrence_id
    )!;
    expect(targetFragmentId).toMatch(/^table-fragment:/u);
    expect(selectorItemsMaterializeReferencedTable(
      selectors,
      occurrence as Extract<typeof occurrence, { reference_kind: "table" }>,
      currentRegistry,
      currentManifest,
    )).toBe(true);
    expect(selectorItemsMaterializeReferencedTable(
      selectors,
      { ...occurrence, target_table_id: "9.9.9" } as Extract<typeof occurrence, { reference_kind: "table" }>,
      currentRegistry,
      currentManifest,
    )).toBe(false);
    const expectedDataRowEvidenceIds = occurrence.target_evidence_ids.filter((evidenceId) => {
      const record = currentManifest.evidence.find((entry) => entry.evidence_id === evidenceId);
      return record?.kind === "table_row" && record.table_row_kind === "data" && (record.cells?.length ?? 0) > 0;
    });
    expect(plan.reference_resolutions[0]!.target_evidence_ids).toEqual(expectedDataRowEvidenceIds);
    const legacyInvalidTarget = structuredClone(selectors);
    legacyInvalidTarget.references[0]!.target_span_ids = [originSpanId];
    const normalizedLegacyPlan = hydrateSemanticSourcePlan(
      compileTargetSelectors(legacyInvalidTarget, currentRegistry, currentManifest),
      currentManifest,
    );
    expect(normalizedLegacyPlan.reference_resolutions[0]!.target_evidence_ids)
      .toEqual(expectedDataRowEvidenceIds);
    expect(plan.semantic_references?.[0]?.destination_bindings).toEqual([]);
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    // A lower header can arrive with a parser data hint. Persist the confirmed
    // correction so strict validation also works without the authoring session.
    const correctedManifest = structuredClone(currentManifest);
    const correctedFragment = correctedManifest.table_fragments.find(fragment => fragment.fragment_id === targetFragmentId)!;
    const correctedHeader = correctedManifest.evidence.find(record =>
      record.kind === "table_row" && correctedFragment.header_evidence_ids.includes(record.evidence_id))!;
    expect(correctedHeader).toBeDefined();
    correctedHeader.table_row_kind = "data";
    correctedFragment.formal_row_evidence_ids.push(correctedHeader.evidence_id);
    const correctedOccurrence = correctedManifest.reference_occurrences.find(entry => entry.occurrence_id === occurrence.occurrence_id)!;
    correctedOccurrence.target_evidence_ids.push(correctedHeader.evidence_id);
    const { evidence_fingerprint: _oldFingerprint, ...correctedPayload } = correctedManifest;
    correctedManifest.evidence_fingerprint = sha256Json(correctedPayload);
    const correctedRegistry = { ...currentRegistry, evidence_fingerprint: correctedManifest.evidence_fingerprint };
    const structure = initialTableStructurePlan(correctedManifest, correctedRegistry);
    const confirmed = structure.tables.find(table => table.fragment_ids.includes(targetFragmentId))!;
    Object.assign(confirmed, {
      status: "confirmed", header_rows: [correctedHeader.evidence_id],
      data_rows: correctedFragment.row_evidence_ids.filter(id => id !== correctedHeader.evidence_id), review_rows: [],
      row_role_overrides: [{ row_id: correctedHeader.evidence_id, program_hint: "data_candidate", selected_role: "header", reason: "分类列名属于表头" }],
    });
    const persisted = JSON.parse(JSON.stringify(compileTargetSelectors(selectors, correctedRegistry, correctedManifest, {
      tableStructurePlan: structure,
    })));
    expect(persisted.table_assembly.logical_tables[0].row_roles).toContainEqual({
      evidence_id: correctedHeader.evidence_id, role: "header", reason: "分类列名属于表头",
    });
    expect(validatePlanText(prettyJson(persisted), correctedManifest)).toMatchObject({ ok: true, issues: [] });
    const hydrated = hydrateSemanticSourcePlan(persisted, correctedManifest);
    expect(validatePlanText(prettyJson(hydrated), correctedManifest)).toMatchObject({ ok: true, issues: [] });
    const migrated = compileSemanticDecisionsV8(semanticDecisionsFromPlan(hydrated, correctedManifest), correctedManifest);
    expect(migrated.table_assembly.logical_tables[0]!.row_roles).toEqual(persisted.table_assembly.logical_tables[0].row_roles);
    const missingLeaf = structuredClone(hydrated);
    missingLeaf.acceptance_items = [];
    expect(validatePlanText(prettyJson(missingLeaf), correctedManifest).issues).toContainEqual(expect.objectContaining({
      code: "reference_placeholder_table_leaf_missing",
      details: expect.objectContaining({ uncovered_data_row_evidence_ids: [targetEvidence.evidence_id] }),
    }));
    const wrongDataHint = structuredClone(correctedManifest);
    wrongDataHint.evidence.find(row => row.evidence_id === targetEvidence.evidence_id)!.table_row_kind = "header";
    wrongDataHint.table_fragments.find(fragment => fragment.fragment_id === targetFragmentId)!.formal_row_evidence_ids = [];
    expect(validatePlanText(prettyJson(missingLeaf), wrongDataHint).issues).toContainEqual(expect.objectContaining({
      code: "reference_placeholder_table_leaf_missing",
      details: expect.objectContaining({ uncovered_data_row_evidence_ids: [targetEvidence.evidence_id] }),
    }));
    const rowRoles = hydrated.table_assembly.logical_tables[0]!.row_roles!;
    for (const malformed of [
      rowRoles.filter(row => row.role === "header"),
      [...rowRoles, rowRoles[0]!],
      [...rowRoles, { evidence_id: originSpanId, role: "header" as const, reason: "foreign row" }],
      rowRoles.map(row => ({ ...row, reason: " " })),
    ]) {
      const invalid = structuredClone(hydrated);
      invalid.table_assembly.logical_tables[0]!.row_roles = malformed;
      expect(validatePlanText(prettyJson(invalid), correctedManifest).issues).toContainEqual(expect.objectContaining({
        code: "table_assembly_row_roles_invalid",
      }));
    }
    const materialized = materialize(plan, currentManifest, "table-reference-placeholder").result;
    expect(materialized.inspection_lots[0]!.items).toHaveLength(1);
    expect(materialized.inspection_lots[0]!.items[0]!.inline_references).toEqual([]);

    if (composition === "reference") {
      expect(plan.semantic_references!.find(entry => entry.destination_bindings.some(destination => destination.fields.includes("method"))))
        .toMatchObject({ import_scope: { mode: "field_specific", allowed_fields: ["method"] } });
      expect(plan.reference_resolutions[0]!.import_scope.allowed_fields).toEqual(["requirement"]);
      const wrongAnchor = structuredClone(selectors);
      wrongAnchor.items[0]!.table!.reference_span_ids = [originSpanId];
      expect(() => compileTargetSelectors(wrongAnchor, currentRegistry, currentManifest)).toThrowError(expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "selector_reference_composition_without_resolve_receipt" })]),
      }));
      const unowned = structuredClone(selectors);
      unowned.items[0]!.fields.method.span_ids = [originSpanId];
      expect(() => compileTargetSelectors(unowned, currentRegistry, currentManifest)).toThrowError(expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "selector_reference_composition_without_resolve_receipt", path: "/items/0/fields/method/composition" })]),
      }));
    }

    const noTargetDataRowPlan = structuredClone(plan);
    const targetEvidenceIds = new Set(occurrence.target_evidence_ids);
    const nonTargetEvidence = currentManifest.evidence.find((record) =>
      !targetEvidenceIds.has(record.evidence_id) && record.text.length > 0
    )!;
    for (const item of noTargetDataRowPlan.acceptance_items) {
      item.evidence_ids = item.evidence_ids.filter((evidenceId) => !targetEvidenceIds.has(evidenceId));
      if (item.evidence_ids.length === 0) item.evidence_ids = [nonTargetEvidence.evidence_id];
      item.reference_evidence_ids = item.reference_evidence_ids.filter(
        (evidenceId) => !targetEvidenceIds.has(evidenceId),
      );
      // Remove every actual receiver. A routed method field is also received
      // content even when the direct-evidence and typed-cell lists are empty.
      for (const binding of Object.values(item.field_bindings)) {
        binding.evidence_ids = binding.evidence_ids.filter(id => !targetEvidenceIds.has(id));
        binding.source_fragments = binding.source_fragments.filter(fragment => !targetEvidenceIds.has(fragment.evidence_id));
      }
      if (item.table_semantics) {
        item.table_semantics.cell_evidence = item.table_semantics.cell_evidence.filter(
          (cell) => !targetEvidenceIds.has(cell.evidence_id),
        );
        if (item.table_semantics.cell_evidence.length === 0) {
          item.table_semantics.cell_evidence = [{
            ...plan.acceptance_items.find((candidate) => candidate.item_id === item.item_id)!
              .table_semantics!.cell_evidence[0]!,
            evidence_id: nonTargetEvidence.evidence_id,
            text: nonTargetEvidence.text,
          }];
        }
      }
    }
    expect(validatePlanText(prettyJson(noTargetDataRowPlan), currentManifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reference_placeholder_table_leaf_missing" }),
      ]),
    );

    const secondRowText = "厚度 5 观察";
    const secondRowEvidenceId = `evidence:${sha256Text("second referenced table data row")}`;
    const firstRow = currentManifest.evidence.find((record) =>
      record.evidence_id === targetEvidence.evidence_id
    )!;
    const twoRowManifest = structuredClone(currentManifest);
    twoRowManifest.evidence.push({
      ...firstRow,
      evidence_id: secondRowEvidenceId,
      locator: `${firstRow.locator}:second-data-row`,
      text: secondRowText,
      text_sha256: sha256Text(secondRowText),
      row_index: (firstRow.row_index ?? 0) + 1,
      cells: ["厚度", "5", "观察"],
    });
    const twoRowFragment = twoRowManifest.table_fragments.find((fragment) =>
      fragment.fragment_id === targetFragmentId
    )!;
    twoRowFragment.row_evidence_ids.push(secondRowEvidenceId);
    twoRowFragment.formal_row_evidence_ids.push(secondRowEvidenceId);
    const twoRowOccurrence = twoRowManifest.reference_occurrences.find((entry) =>
      entry.occurrence_id === occurrence.occurrence_id
    )!;
    twoRowOccurrence.target_evidence_ids.push(secondRowEvidenceId);
    const headerEvidenceId = twoRowFragment.header_evidence_ids[0];
    if (headerEvidenceId && !twoRowOccurrence.target_evidence_ids.includes(headerEvidenceId)) {
      twoRowOccurrence.target_evidence_ids.push(headerEvidenceId);
    }
    const partialTablePlan = structuredClone(plan);
    partialTablePlan.reference_resolutions[0]!.target_evidence_ids.push(secondRowEvidenceId);
    const partialTableIssues = validatePlanText(prettyJson(partialTablePlan), twoRowManifest).issues;
    expect(partialTableIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "reference_placeholder_table_leaf_missing",
        details: expect.objectContaining({
          data_row_evidence_ids: [targetEvidence.evidence_id, secondRowEvidenceId],
          uncovered_data_row_evidence_ids: [secondRowEvidenceId],
        }),
      }),
    ]));
    const completeTablePlan = structuredClone(partialTablePlan);
    completeTablePlan.acceptance_items[0]!.table_semantics!.cell_evidence.push({
      role: "row_header",
      evidence_id: secondRowEvidenceId,
      text: "厚度",
    });
    expect(validatePlanText(prettyJson(completeTablePlan), twoRowManifest).issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reference_placeholder_table_leaf_missing" })]),
    );

    const noTableLeaf = structuredClone(selectors);
    noTableLeaf.items = [];
    expect(() => compileTargetSelectors(noTableLeaf, currentRegistry, currentManifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "selector_reference_placeholder_table_items_missing" }),
        ]),
      }),
    );

    const unresolvedDestination = structuredClone(selectors);
    unresolvedDestination.references[0]!.application_mode = "reference_only";
    unresolvedDestination.references[0]!.target_span_ids = [];
    unresolvedDestination.references[0]!.destinations = [];
    expect(() => compileTargetSelectors(unresolvedDestination, currentRegistry, currentManifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "selector_reference_destination_required",
            path: "/references/0/destinations",
          }),
        ]),
      }),
    );
  });

  test("confirmed referenced-table headers do not require business leaves, while data rows still do", () => {
    const manifest = manifestFor("本项按表 R 检查。", "本项按表 R 检查。");
    const rowIds = ["neutral:header", "neutral:data", "neutral:second-data"];
    const texts = ["项目 | 分类甲 | 分类乙", "属性甲 | 2 | 3", "属性乙 | 4 | 5"];
    manifest.evidence.push(...rowIds.map((evidenceId, index) => ({
      ...manifest.evidence[0]!, evidence_id: evidenceId,
      kind: "table_row" as const, role: "context" as const,
      text: texts[index]!, text_sha256: sha256Text(texts[index]!),
      evidence_scope: "reference" as const, requires_disposition: false,
      table_id: "R", table_fragment_id: "neutral:fragment",
      table_row_kind: "data" as const, cells: texts[index]!.split(" | "),
    })));
    manifest.table_fragments.push({
      fragment_id: "neutral:fragment", source_order: 1, locator: "line:2",
      provisional_table_id: "R", provisional_title: "中性检查表",
      title_candidate_evidence_ids: [], header_evidence_ids: [],
      row_evidence_ids: rowIds, formal_row_evidence_ids: rowIds,
      columns: ["项目", "分类甲", "分类乙"],
    });
    const registry: SourceSpanRegistry = {
      evidence_fingerprint: manifest.evidence_fingerprint,
      spans: rowIds.map((evidenceId, index) => ({
        span_id: `span:${String(index + 1).repeat(32)}`, evidence_id: evidenceId,
        atom_id: evidenceId, start: 0, end: texts[index]!.length,
        text_sha256: sha256Text(texts[index]!),
      })),
    };
    const selectors = initialTargetSelectorPlan(manifest);
    const dataSpan = registry.spans[1]!.span_id;
    const field = { composition: "verbatim" as const, span_ids: [dataSpan], separator: "" as const, reason: "精确数据行来源" };
    const absent = { composition: "not_applicable" as const, span_ids: [], separator: "" as const, reason: "原文未给出" };
    selectors.items.push({
      key: "attribute-a", lot_key: "lot", name: "属性甲", category: "一般项目",
      criterion_span_ids: [dataSpan], continuation_span_ids: [],
      fields: { name: field, requirement: field, method: absent, quantity: absent, note: absent },
      table: {
        source_kind: "reference", table_key: "author-chosen-group",
        properties: {
          table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [],
          row_path_span_ids: [[dataSpan]], column_path_span_ids: [], unit_span_ids: [],
          condition_span_ids: [], allowed_value_span_ids: [dataSpan], inspection_method_span_ids: [],
        },
        reference_span_ids: [], reason: "属性甲真实业务叶",
      },
      inspection_data_type: "measurement", inspection_data_type_reason: "限值检查",
      inspection_data_type_span_ids: [dataSpan],
      sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无", confidence: 1 },
      reason: "中性测试业务叶",
    });
    const occurrence = {
      occurrence_id: "neutral:reference", reference_kind: "table" as const,
      origin_evidence_id: manifest.evidence[0]!.evidence_id, origin_fields: ["requirement" as const],
      raw_reference: "表 R", target_table_id: "R", target_evidence_ids: rowIds.slice(0, 2),
      required: true, status: "resolved" as const, depth: 1, path: ["table:R"],
    };
    const structure = initialTableStructurePlan(manifest, registry);
    Object.assign(structure.tables[0]!, {
      status: "confirmed", header_rows: [rowIds[0]], data_rows: rowIds.slice(1), review_rows: [],
      row_role_overrides: [{ row_id: rowIds[0], program_hint: "data_candidate", selected_role: "header", reason: "此行是分类列名" }],
    });
    const covered = (plan = structure) => selectorItemsMaterializeReferencedTable(selectors, occurrence, registry, manifest, plan);
    expect(covered()).toBe(true);
    expect(selectorItemsMaterializeReferencedTable(selectors, occurrence, registry, manifest)).toBe(false);
    const review = structuredClone(structure);
    review.tables[0]!.status = "review";
    expect(covered(review)).toBe(false);
    const stale = structuredClone(structure);
    stale.source_version = "different-source";
    expect(covered(stale)).toBe(false);
    const wrongEvidence = structuredClone(structure);
    wrongEvidence.evidence_fingerprint = "different-evidence";
    // Reference extensions can change the inventory fingerprint. The immutable
    // source, fragment membership and complete row bindings remain authoritative.
    expect(covered(wrongEvidence)).toBe(true);
    const foreign = structuredClone(structure);
    foreign.tables[0]!.fragment_ids = ["unrelated-fragment"];
    expect(covered(foreign)).toBe(false);
    occurrence.target_evidence_ids.push(rowIds[2]!);
    expect(covered()).toBe(false);
    manifest.evidence.find((row) => row.evidence_id === rowIds[2])!.table_row_kind = "header";
    manifest.table_fragments[0]!.formal_row_evidence_ids = rowIds.slice(0, 2);
    expect(covered()).toBe(false);
    selectors.items[0]!.table!.properties.allowed_value_span_ids.push(registry.spans[2]!.span_id);
    expect(covered()).toBe(true);
  });

  test("continued physical fragments prove one business table without relying on table_key", () => {
    const targetTableId = "8.3.2";
    const firstEvidenceId = "evidence:8.3.2:first";
    const continuedEvidenceId = "evidence:8.3.2:continued";
    const firstSpanId = "span:22222222222222222222222222222222";
    const continuedSpanId = "span:11111111111111111111111111111111";
    const manifest = manifestFor("8.3.1 位置偏差应符合表8.3.2。", "8.3.1 位置偏差应符合表8.3.2。");
    const evidenceTemplate = manifest.evidence[0]!;
    manifest.evidence.push(
      {
        ...evidenceTemplate,
        evidence_id: firstEvidenceId,
        kind: "table_row",
        role: "context",
        text: "表8.3.2 | 数据行1 | 项目=轴线位置 | 允许偏差=15",
        text_sha256: sha256Text("表8.3.2 | 数据行1 | 项目=轴线位置 | 允许偏差=15"),
        table_id: targetTableId,
        table_title: "表 8.3.2 现浇结构位置和尺寸允许偏差",
        table_fragment_id: "table-fragment:line-1205",
        table_row_kind: "data",
        cells: ["轴线位置", "15"],
      },
      {
        ...evidenceTemplate,
        evidence_id: continuedEvidenceId,
        kind: "table_row",
        role: "context",
        text: "续表8.3.2 | 数据行2 | 项目=层高垂直度 | 允许偏差=10",
        text_sha256: sha256Text("续表8.3.2 | 数据行2 | 项目=层高垂直度 | 允许偏差=10"),
        table_id: targetTableId,
        table_title: "续表 8.3.2",
        table_fragment_id: "table-fragment:line-1216",
        table_row_kind: "data",
        cells: ["层高垂直度", "10"],
      },
    );
    manifest.table_fragments.push(
      {
        fragment_id: "table-fragment:line-1205",
        source_order: 1,
        locator: "line:1205",
        provisional_table_id: targetTableId,
        provisional_title: "表 8.3.2 现浇结构位置和尺寸允许偏差",
        title_candidate_evidence_ids: [],
        header_evidence_ids: [],
        row_evidence_ids: [firstEvidenceId],
        formal_row_evidence_ids: [],
        columns: ["项目", "允许偏差"],
      },
      {
        fragment_id: "table-fragment:line-1216",
        source_order: 2,
        locator: "line:1216",
        provisional_table_id: targetTableId,
        provisional_title: "续表 8.3.2",
        title_candidate_evidence_ids: [],
        header_evidence_ids: [],
        row_evidence_ids: [continuedEvidenceId],
        formal_row_evidence_ids: [],
        columns: ["项目", "允许偏差"],
      },
    );
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.items = [{
      key: "continued-row",
      lot_key: "lot",
      name: "层高垂直度",
      category: "一般项目",
      criterion_span_ids: [continuedSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "verbatim", span_ids: [continuedSpanId], separator: "", reason: "续表行" },
        requirement: { composition: "verbatim", span_ids: [continuedSpanId], separator: "", reason: "续表行" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "无" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "无" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无" },
      },
      table: {
        source_kind: "direct",
        table_key: "opaque-logical-group",
        properties: {
          table_no_span_ids: [],
          table_title_span_ids: [],
          applicability_span_ids: [],
          row_path_span_ids: [[continuedSpanId]],
          column_path_span_ids: [],
          unit_span_ids: [],
          condition_span_ids: [],
          allowed_value_span_ids: [continuedSpanId],
          inspection_method_span_ids: [],
        },
        reference_span_ids: [],
        reason: "续表数据行",
      },
      inspection_data_type: "measurement",
      inspection_data_type_reason: "允许偏差量测",
      inspection_data_type_span_ids: [continuedSpanId],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无", confidence: 1 },
      reason: "续表数据行独立验收",
    }];
    const registry = {
      evidence_fingerprint: manifest.evidence_fingerprint,
      spans: [{
        span_id: continuedSpanId,
        evidence_id: continuedEvidenceId,
        atom_id: continuedEvidenceId,
        start: 0,
        end: manifest.evidence.find((record) => record.evidence_id === continuedEvidenceId)!.text.length,
        text_sha256: manifest.evidence.find((record) => record.evidence_id === continuedEvidenceId)!.text_sha256,
      }, {
        span_id: firstSpanId,
        evidence_id: firstEvidenceId,
        atom_id: firstEvidenceId,
        start: 0,
        end: manifest.evidence.find((record) => record.evidence_id === firstEvidenceId)!.text.length,
        text_sha256: manifest.evidence.find((record) => record.evidence_id === firstEvidenceId)!.text_sha256,
      }],
    } as any;
    const occurrence = {
      occurrence_id: "reference:8.3.2",
      reference_kind: "table" as const,
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      origin_fields: ["requirement" as const],
      raw_reference: "表8.3.2",
      target_table_id: targetTableId,
      target_evidence_ids: [firstEvidenceId, continuedEvidenceId],
      required: true,
      status: "resolved" as const,
      depth: 1,
      path: ["table:8.3.2"],
    };

    expect(selectorItemsMaterializeReferencedTable(selectors, occurrence, registry, manifest)).toBe(false);
    const firstRowItem = structuredClone(selectors.items[0]!);
    firstRowItem.key = "first-row";
    firstRowItem.name = "轴线位置";
    firstRowItem.criterion_span_ids = [firstSpanId];
    firstRowItem.fields.name.span_ids = [firstSpanId];
    firstRowItem.fields.requirement.span_ids = [firstSpanId];
    firstRowItem.table!.properties.row_path_span_ids = [[firstSpanId]];
    firstRowItem.table!.properties.allowed_value_span_ids = [firstSpanId];
    firstRowItem.inspection_data_type_span_ids = [firstSpanId];
    selectors.items.push(firstRowItem);
    expect(selectorItemsMaterializeReferencedTable(selectors, occurrence, registry, manifest)).toBe(true);
    expect(selectorItemsMaterializeReferencedTable(
      selectors,
      { ...occurrence, target_table_id: "8.3.3" },
      registry,
      manifest,
    )).toBe(false);
  });

  test.each([false, true])("GB 50310 5.10.1 compiles one non-counting section placeholder plus ten real 4.10 items (normalized=%s)", async (normalized) => {
    const origin = "5.10.1 电气装置安装应符合本规范第 4.10 节的规定。";
    expect(clauseReferenceLocalResidual(origin, "本规范第 4.10 节")).toBe("");
    expect(clauseReferenceLocalResidual(
      "5.5.1 门系统安装应符合本规范第 4.5 节的规定。",
      "本规范第 4.5 节",
    )).toBe("");
    expect(clauseReferenceLocalResidual(
      "5.5.1 门系统应无损伤，并符合本规范第 4.5 节的规定。",
      "本规范第 4.5 节",
    )).not.toBe("");
    const criteria = [
      "1 所有电气设备及导管、线槽的外露可导电部分均必须可靠接地(PE)。",
      "2 接地支线应分别直接接至接地干线接线柱上，不得互相连接后再接地。",
      "4.10.2 导体之间和导体对地之间的绝缘电阻必须大于 1000Ω/V。",
      "1 主电源开关不应切断轿厢照明和通风。",
      "2 主电源开关不应切断机房和滑轮间照明。",
      "3 主电源开关不应切断机房、轿顶和底坑的电源插座。",
      "4 主电源开关不应切断井道照明。",
      "5 主电源开关不应切断报警装置。",
      "4.10.4 机房和井道内应按产品要求配线，电缆应按规定防护和敷设。",
      "4.10.5 导管、线槽敷设应整齐牢固，导线填充率和软管固定间距应符合规定。",
    ];
    const source = [
      "# 4.10 电气装置",
      "4.10.1 电气设备接地必须符合下列规定：",
      ...criteria,
      "# 5.10 电气装置",
      origin,
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("gb50310-5.10.1-placeholder"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "requirement",
      raw_reference: "本规范第 4.10 节",
      ...(normalized ? { normalized_reference: "本规范第4.10节" } : {}),
      target: { kind: "section", number: "4.10" },
      relation: "electrical_device_section_requirements",
    });
    expect(resolved).toMatchObject({ ok: true, reference_kind: "clause" });
    const currentManifest = await workspace.readEvidenceManifest();
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const evidenceByText = new Map((await receiptEvidence(workspace, resolved)).map((entry) => [entry.text, entry]));
    const criterionSpans = criteria.map((text) => evidenceByText.get(text)!.span_id);
    const selectors = initialTargetSelectorPlan(currentManifest);
    // The section heading and the lead-in are context, separately accounted
    // for instead of silently omitting them from the resolved inventory.
    selectors.source_dispositions = source.split("\n").slice(0, 2).map(text => ({
      span_ids: [evidenceByText.get(text)!.span_id], disposition: "context" as const,
      reason: "标题及列项引导语由后续独立判据具体展开，不单独形成验收项。",
    }));
    selectors.lots.push({
      key: "lot-electrical-device",
      name: "电气装置安装检验批",
      scope_span_ids: [originSpanId],
      reason: "5.10.1 指向第 4.10 节的完整电气装置验收范围。",
    });
    criterionSpans.forEach((spanId, index) => {
      selectors.items.push({
        key: `item-4.10-${index + 1}`,
        lot_key: "lot-electrical-device",
        name: `第 4.10 节验收项目 ${index + 1}`,
        category: index < 3 ? "主控项目" : "一般项目",
        criterion_span_ids: [spanId],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [spanId], separator: "", reason: "概括该独立验收判断。" },
          requirement: { composition: "verbatim", span_ids: [spanId], separator: "", reason: "保留第 4.10 节原文要求。" },
          method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定检验方法。" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定抽样数量。" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "按第 4.10 节原文核查。",
        inspection_data_type_span_ids: [spanId],
        sampling: {
          status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [],
          script_span_ids: [], condition_span_ids: [], reason: "未规定抽样。", confidence: 1,
        },
        reason: "第 4.10 节的独立验收判断。",
      });
    });
    selectors.references.push({
      key: "ref-5.10.1-4.10-placeholder",
      occurrence_id: resolved.occurrence_id as string,
      anchor_span_ids: [resolved.reference_literal_span_id as string],
      target_span_ids: criterionSpans,
      action: "keep_reference",
      application_mode: "reference_placeholder",
      import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement", "method", "quantity", "note", "sampling"], reason: "5.10.1 委托第4.10节完整验收程序。" },
      destinations: [],
      reason: "5.10.1 是纯章节指针；第 4.10 节十个真实验收项已完整承载被引内容。",
    });

    const compiled = compileTargetSelectors(selectors, currentRegistry, currentManifest);
    const plan = hydrateSemanticSourcePlan(compiled, currentManifest);
    expect(plan.acceptance_items).toHaveLength(10);
    expect(plan.reference_resolutions).toHaveLength(1);
    expect(plan.reference_resolutions[0]).toMatchObject({
      occurrence_id: resolved.occurrence_id,
      origin_evidence_id: currentManifest.reference_occurrences[0]!.origin_evidence_id,
      application_mode: "reference_placeholder",
      destination_bindings: [],
    });
    expect(plan.reference_resolutions[0]!.target_evidence_ids).toHaveLength(10);
    expect(plan.semantic_evidence?.filter((node) => node.role === "reference_anchor")).toHaveLength(1);
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    expect(materialize(plan, currentManifest, "gb50310-5.10.1").result.inspection_lots[0]!.items).toHaveLength(10);

    const referenceFields = structuredClone(selectors);
    referenceFields.items.forEach(item => { item.fields.requirement.composition = "reference"; });
    const referencedPlan = hydrateSemanticSourcePlan(compileTargetSelectors(referenceFields, currentRegistry, currentManifest), currentManifest);
    expect(validatePlanText(prettyJson(referencedPlan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    expect(referencedPlan.reference_resolutions[0]!.destination_bindings).toEqual([]);
    referenceFields.items.pop();
    expect(() => compileTargetSelectors(referenceFields, currentRegistry, currentManifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: "selector_reference_placeholder_target_uncovered" })]),
    }));

    const missingAnchor = structuredClone(selectors);
    missingAnchor.references[0]!.anchor_span_ids = [];
    expect(() => compileTargetSelectors(missingAnchor, currentRegistry, currentManifest)).toThrowError(
      expect.objectContaining({ issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_reference_literal_anchor_required" }),
      ]) }),
    );

    const duplicateParent = structuredClone(selectors);
    duplicateParent.items.push({
      ...structuredClone(duplicateParent.items[0]!),
      key: "item-5.10.1-pointer",
      name: "电气装置安装",
      criterion_span_ids: [],
      continuation_span_ids: [],
      inspection_data_type_span_ids: [],
    });
    try {
      compileTargetSelectors(duplicateParent, currentRegistry, currentManifest);
      throw new Error("Expected the non-item parent to fail selector preflight");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_item_semantic_node_required",
          path: "/items/10/criterion_span_ids",
        }),
      ]));
    }

    const uncovered = structuredClone(selectors);
    uncovered.items.pop();
    try {
      compileTargetSelectors(uncovered, currentRegistry, currentManifest);
      throw new Error("Expected uncovered placeholder target spans to fail selector preflight");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_reference_placeholder_target_uncovered" }),
      ]));
    }
  });

  test("GB 50310 6.3.7 requires component dispositions before parallel clause references can merge", async () => {
    const origin = "2 配线应符合本规范第 4.10.4、4.10.5、4.10.6 条的规定。";
    const parallelReferences = ["第 4.10.4", "4.10.5", "4.10.6 条"];
    expect(clauseReferenceGroupLocalResidual(origin, parallelReferences)).toBe("");
    expect(clauseReferenceGroupLocalResidual(
      "2 配线应整齐牢固，并符合本规范第 4.10.4、4.10.5、4.10.6 条的规定。",
      parallelReferences,
    )).toContain("配线整齐牢固");
    const clauses = [
      ["4.10.4", "4.10.4 机房和井道内应按产品要求配线，电缆应按规定防护。"],
      ["4.10.5", "4.10.5 导管、线槽敷设及导线填充率和固定间距应符合规定。"],
      ["4.10.6", "4.10.6 接地支线应采用黄绿相间的绝缘导线。"],
    ] as const;
    const source = ["# 4.10 电气装置", ...clauses.map((entry) => entry[1]), "# 6.3 整机安装验收", origin].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("gb50310-6.3.7-components"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const receipts = [];
    for (const [number] of clauses) {
      const receipt = await controller.dispatch("resolve_document_reference", {
        origin_span_id: originSpanId,
        origin_field: "requirement",
        raw_reference: number,
        target: { kind: "clause", number },
        relation: "parallel_wiring_requirement",
      });
      expect(receipt).toMatchObject({
        ok: true,
        decomposition_review: expect.objectContaining({ required: true }),
      });
      receipts.push(receipt);
    }
    const occurrenceList = await controller.dispatch("list_reference_occurrences", { cursor: 0, limit: 10 });
    expect((occurrenceList.occurrences as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decomposition_review: expect.objectContaining({ same_origin_occurrence_count: 3 }),
      }),
    ]));
    const firstPage = await controller.dispatch("read_document_reference_evidence", {
      target_key: receipts[0]!.target_key,
      cursor: 0,
      limit: 10,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      decomposition_review: expect.objectContaining({ required: true }),
      rows: [expect.objectContaining({ component_id: expect.stringMatching(/^reference-component:/u), span_id: expect.any(String) })],
    });

    const currentManifest = await workspace.readEvidenceManifest();
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const targetSpans = await Promise.all(receipts.map(async (receipt) => (
      await receiptEvidence(workspace, receipt)
    )[0]!.span_id));
    const itemFor = (key: string, spanIds: string[], name = "被引配线验收") => ({
      key,
      lot_key: "lot-6.3.7",
      name,
      category: "一般项目" as const,
      criterion_span_ids: spanIds,
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary" as const, span_ids: spanIds, separator: "", reason: "被引配线组件。" },
        requirement: { composition: "verbatim" as const, span_ids: spanIds, separator: "\n", reason: "保留被引要求。" },
        method: { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "未规定。" },
        quantity: { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "未规定。" },
        note: { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "无备注。" },
      },
      table: null,
      inspection_data_type: "review" as const,
      inspection_data_type_reason: "逐组件核查。",
      inspection_data_type_span_ids: spanIds,
      sampling: {
        status: "fallback" as const, rule_key: "", branch_keys: [], quantity_span_ids: [],
        script_span_ids: [], condition_span_ids: [], reason: "未规定抽样。", confidence: 1,
      },
      reason: "被引条款的独立验收判断。",
    });
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({ key: "lot-6.3.7", name: "整机安装验收", scope_span_ids: [originSpanId], reason: "6.3.7 配线引用范围。" });
    selectors.items.push(itemFor("combined-item", targetSpans));
    receipts.forEach((receipt, index) => selectors.references.push({
      key: `ref-${clauses[index]![0]}`,
      occurrence_id: receipt.occurrence_id as string,
      anchor_span_ids: [receipt.reference_literal_span_id as string],
      target_span_ids: [targetSpans[index]!],
      action: "keep_reference",
      application_mode: "reference_placeholder",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "配线引用只导入要求。" },
      destinations: [],
      reason: "纯转发引用由真实组件 item 承载。",
    }));

    expect(() => compileTargetSelectors(selectors, currentRegistry, currentManifest)).toThrowError(TargetSelectorCompileError);
    try {
      compileTargetSelectors(selectors, currentRegistry, currentManifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .toContain("selector_reference_component_dispositions_required");
    }

    selectors.references.forEach((reference, index) => {
      reference.component_dispositions = [{
        component_span_ids: [targetSpans[index]!],
        decision: "independent_item",
        item_keys: ["combined-item"],
        reason: "三个被引条款可分别判定。",
      }];
    });
    try {
      compileTargetSelectors(selectors, currentRegistry, currentManifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .toContain("selector_multi_reference_merge_decision_required");
    }

    const itemNames = ["配线与电缆防护", "导管线槽与固定间距", "接地支线导线颜色"];
    selectors.items = targetSpans.map((spanId, index) => itemFor(
      `item-${clauses[index]![0]}`,
      [spanId],
      itemNames[index]!,
    ));
    selectors.references.forEach((reference, index) => {
      reference.component_dispositions![0]!.item_keys = [selectors.items[index]!.key];
    });
    const compiled = compileTargetSelectors(selectors, currentRegistry, currentManifest);
    const plan = hydrateSemanticSourcePlan(compiled, currentManifest);
    expect(plan.acceptance_items).toHaveLength(3);
    expect(plan.reference_resolutions).toHaveLength(3);
    expect(plan.reference_resolutions.every((resolution) => (
      resolution.application_mode === "reference_placeholder" && resolution.destination_bindings.length === 0
    ))).toBe(true);
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
  });

  test("quantity and note references retain distinct field paths and literal positions", async () => {
    const origin = "6.2.6 数量参考本规范第1.1.1条；备注参考本规范第1.1.2条。";
    const quantityText = "数量参考本规范第1.1.1条";
    const noteText = "备注参考本规范第1.1.2条";
    const source = [
      "# 1.1 被引要求",
      "1.1.1 数量被引内容。",
      "1.1.2 备注被引内容。",
      "1.1.3 后续条文。",
      "# 6.2 保护措施",
      origin,
    ].join("\n");
    const manifest = manifestFor(source, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("two-field-references"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const evidenceId = manifest.evidence[0]!.evidence_id;
    const registry = await workspace.readSourceSpanRegistry();
    const originSpanId = registry.spans[0]!.span_id;
    await controller.dispatch("open_evidence", { evidence_id: evidenceId });
    const quantityField = await controller.dispatch("locate_evidence_span", {
      evidence_id: evidenceId,
      quote: quantityText,
    });
    const noteField = await controller.dispatch("locate_evidence_span", {
      evidence_id: evidenceId,
      quote: noteText,
    });
    const quantityReference = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "quantity",
      raw_reference: "本规范第1.1.1条",
      target: { kind: "clause", number: "1.1.1" },
      relation: "quantity_reference",
    });
    const noteReference = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "note",
      raw_reference: "本规范第1.1.2条",
      target: { kind: "clause", number: "1.1.2" },
      relation: "note_reference",
    });
    expect(quantityReference).toMatchObject({ ok: true, origin_field: "quantity" });
    expect(noteReference).toMatchObject({ ok: true, origin_field: "note" });
    const currentManifest = await workspace.readEvidenceManifest();
    expect(currentManifest.reference_occurrences.map((occurrence) => ({
      occurrence_id: occurrence.occurrence_id,
      origin_fields: occurrence.origin_fields,
    }))).toEqual(expect.arrayContaining([
      { occurrence_id: quantityReference.occurrence_id, origin_fields: ["quantity"] },
      { occurrence_id: noteReference.occurrence_id, origin_fields: ["note"] },
    ]));
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const quantityFieldSpanId = (quantityField.span as { span_id: string }).span_id;
    const noteFieldSpanId = (noteField.span as { span_id: string }).span_id;
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({ key: "lot", name: "双字段引用检验批", scope_span_ids: [originSpanId], reason: "测试字段归属。" });
    selectors.items.push({
      key: "item", lot_key: "lot", name: "双字段引用", category: "一般项目",
      criterion_span_ids: [originSpanId], continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [originSpanId], separator: "", reason: "测试对象。" },
        requirement: { composition: "verbatim", span_ids: [originSpanId], separator: "", reason: "完整原文。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        quantity: { composition: "verbatim", span_ids: [quantityFieldSpanId], separator: "", reason: "数量字段原文。" },
        note: { composition: "verbatim", span_ids: [noteFieldSpanId], separator: "", reason: "备注字段原文。" },
      },
      table: null, inspection_data_type: "review", inspection_data_type_reason: "测试引用字段归属。",
      inspection_data_type_span_ids: [originSpanId],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无抽样。", confidence: 1 },
      reason: "同一项目的 quantity 与 note 分别引用。",
    });
    const quantityTargetSpanId = (await receiptEvidence(workspace, quantityReference))[0]!.span_id;
    const noteTargetSpanId = (await receiptEvidence(workspace, noteReference))[0]!.span_id;
    selectors.references.push(
      {
        key: "quantity-ref", occurrence_id: quantityReference.occurrence_id as string,
        anchor_span_ids: [quantityReference.reference_literal_span_id as string],
        target_span_ids: [quantityTargetSpanId],
        action: "mention", application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["quantity", "sampling"], reason: "数量引用只允许数量和抽样。" },
        component_dispositions: [{ component_span_ids: [quantityTargetSpanId], decision: "not_applicable", item_keys: [], reason: "被引目标仅保留数量引用 provenance，不新增或替换本地验收叶。" }],
        destinations: [{ item_key: "item", target_field: "quantity" }],
        reason: "数量引用留在 quantity 原位置。",
      },
      {
        key: "note-ref", occurrence_id: noteReference.occurrence_id as string,
        anchor_span_ids: [noteReference.reference_literal_span_id as string],
        target_span_ids: [noteTargetSpanId],
        action: "mention", application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["note"], reason: "备注引用只允许备注。" },
        component_dispositions: [{ component_span_ids: [noteTargetSpanId], decision: "not_applicable", item_keys: [], reason: "被引目标仅保留备注引用 provenance，不新增或替换本地验收叶。" }],
        destinations: [{ item_key: "item", target_field: "note" }],
        reason: "备注引用留在 note 原位置。",
      },
    );
    const compiled = compileTargetSelectors(selectors, currentRegistry, currentManifest);
    const plan = hydrateSemanticSourcePlan(compiled, currentManifest);
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      currentRegistry,
      [{
        code: "duplicate_reference_route",
        path: "/reference_resolutions/1/destination_bindings/0",
        message: "同一条被引证据只能向同一个 item 字段路由一次。",
      }],
    )).toEqual([
      expect.objectContaining({
        code: "duplicate_reference_route",
        owner: "selector_input_error",
        path: "/references/1/destinations/0/target_field",
      }),
    ]);
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      currentRegistry,
      [{
        code: "reference_origin_relation",
        path: "/reference_resolutions/1/destination_bindings/0",
        message: "接收引用的 item 必须保留产生该引用的来源证据。",
      }],
    )).toEqual([
      expect.objectContaining({
        code: "reference_origin_relation",
        owner: "selector_input_error",
        path: "/references/1/destinations/0/item_key",
      }),
    ]);
    const reviewed = structuredClone(selectors);
    reviewed.references[0]!.action = "review";
    const reviewedCompiled = compileTargetSelectors(reviewed, currentRegistry, currentManifest);
    const reviewedPlan = hydrateSemanticSourcePlan(reviewedCompiled, currentManifest);
    const reviewedIssues = classifySelectorIssues(
      "compiler-invariant",
      checkTargetCompilerInvariants(reviewed, reviewedPlan, currentManifest, reviewedCompiled),
    ).filter((issue) => issue.code.startsWith("compiler_semantic_reference_unresolved"));
    expect(reviewedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "compiler_semantic_reference_unresolved",
        owner: "selector_input_error",
        path: "/references/0/action",
      }),
      expect.objectContaining({
        code: "compiler_semantic_reference_unresolved_targets",
        owner: "selector_input_error",
        path: "/references/0/action",
      }),
    ]));
    const item = materialize(plan, currentManifest, "two-field-plan").result.inspection_lots[0]!.items[0]!;
    expect(item.inline_references?.map((reference) => ({
      field: reference.field,
      raw_reference: reference.raw_reference,
      relation: reference.relation,
    }))).toEqual([
      { field: "note", raw_reference: "本规范第1.1.2条", relation: "note_reference" },
      { field: "quantity", raw_reference: "本规范第1.1.1条", relation: "quantity_reference" },
    ]);
    const swapped = structuredClone(selectors);
    swapped.references[0]!.destinations[0]!.target_field = "note";
    swapped.references[1]!.destinations[0]!.target_field = "quantity";
    const swappedCompiled = compileTargetSelectors(swapped, currentRegistry, currentManifest);
    expect(swappedCompiled.reference_resolutions.map(reference => reference.origin_binding?.target_field))
      .toEqual(["quantity", "note"]);
    expect(swappedCompiled.reference_resolutions.map(reference => reference.destination_bindings[0]!.target_field))
      .toEqual(["note", "quantity"]);
  });

  test.each(["legacy", "external_stub"] as const)("unresolved external GB50311 citation stays in its original requirement field (%s)", async (mode) => {
    const origin = "6.2.5 建筑物外部入线的信号线路应设置浪涌保护器，并应符合GB 50311的规定。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("external-gb50311-reference"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(origin) },
    );
    const controller = await ToolController.create(workspace);
    const registry = await workspace.readSourceSpanRegistry();
    const originSpanId = registry.spans[0]!.span_id;
    const unresolved = await controller.dispatch(mode === "external_stub" ? "resolve_external_standard_reference" : "resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "GB 50311",
      ...(mode === "external_stub" ? { standard_no: "GB 50311" } : { target: { source_id: "GB 50311", kind: "clause", number: "外部标准" } }),
      relation: "external_standard_requirement",
    });
    expect(unresolved).toMatchObject({
      ...(mode === "external_stub"
        ? { ok: true, receipt: "external_reference_placeholder", content_available: false, target_span_ids: [] }
        : { ok: false, error: "target_not_found", receipt: "target_not_found" }),
      occurrence_id: expect.any(String),
      reference_literal_span_id: expect.any(String),
    });
    const currentManifest = await workspace.readEvidenceManifest();
    const literalSpanId = unresolved.reference_literal_span_id as string;
    const selectors = initialTargetSelectorPlan(currentManifest);
    selectors.lots.push({ key: "lot", name: "浪涌保护检验批", scope_span_ids: [originSpanId], reason: "本地要求。" });
    selectors.items.push({
      key: "item", lot_key: "lot", name: "入线浪涌保护器", category: "一般项目",
      criterion_span_ids: [originSpanId], continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [originSpanId], separator: "", reason: "被检对象。" },
        requirement: { composition: "verbatim", span_ids: [originSpanId], separator: "", reason: "保留外部引用原文。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注。" },
      },
      table: null, inspection_data_type: "review", inspection_data_type_reason: "核查设置与标准符合性。",
      inspection_data_type_span_ids: [originSpanId],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无抽样。", confidence: 1 },
      reason: "外部标准未提供正文但本地要求仍完整。",
    });
    selectors.references.push({
      key: "gb50311", occurrence_id: unresolved.occurrence_id as string,
      anchor_span_ids: [literalSpanId], target_span_ids: [],
      action: "keep_reference", application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "外部引用只保留要求位置。" },
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "外部正文未提供，保留 requirement 原位置引用。",
    });
    const currentRegistry = await workspace.readSourceSpanRegistry();
    const plan = hydrateSemanticSourcePlan(
      compileTargetSelectors(selectors, currentRegistry, currentManifest),
      currentManifest,
    );
    expect(validatePlanText(prettyJson(plan), currentManifest)).toMatchObject({ ok: true, issues: [] });
    const result = materialize(plan, currentManifest, "external-reference-plan").result;
    expect(result.inspection_lots[0]!.items[0]!.requirement).toBe(origin);
    expect(result.inspection_lots[0]!.items[0]!.inline_references?.[0]).toMatchObject({
      field: "requirement",
      raw_reference: "GB 50311",
      relation: "external_standard_requirement",
      resolved_content: { records: [] },
    });
    expect(currentManifest.reference_occurrences[0]).toMatchObject({
      status: "target_not_found",
      raw_reference: "GB 50311",
      reference_literal_span_id: literalSpanId,
    });
    const nestedManifest = structuredClone(currentManifest);
    const unresolvedOccurrence = nestedManifest.reference_occurrences[0]!;
    const nestedOccurrenceId = "reference:nested-current-document-clause";
    const nestedOccurrence = {
      ...unresolvedOccurrence,
      occurrence_id: nestedOccurrenceId,
      required: true,
      status: "resolved" as const,
      target_evidence_ids: [unresolvedOccurrence.origin_evidence_id],
    };
    delete nestedOccurrence.external_standard;
    nestedManifest.reference_occurrences.push(nestedOccurrence);
    const nestedPlan = structuredClone(plan);
    nestedPlan.reference_resolutions.push({
      resolution_id: "resolution:nested-current-document-clause",
      occurrence_id: nestedOccurrenceId,
      origin_evidence_id: unresolvedOccurrence.origin_evidence_id,
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "嵌套引用只保留要求位置。" },
      target_evidence_ids: [unresolvedOccurrence.origin_evidence_id],
      destination_bindings: structuredClone(nestedPlan.reference_resolutions[0]!.destination_bindings),
      reason: "当前 PDF 内部条款承载该外部标准引用，保留内部来源关系。",
    });
    const nestedTargetNotFoundIssues = validatePlanText(
      prettyJson(nestedPlan),
      nestedManifest,
    ).issues.filter((issue) => issue.code === "reference_target_not_found");
    if (mode === "external_stub") {
      expect(nestedTargetNotFoundIssues).toEqual([]);
    } else {
      expect(nestedTargetNotFoundIssues).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            actual: expect.objectContaining({ occurrence_id: unresolvedOccurrence.occurrence_id }),
          }),
        }),
      ]);
    }
    expect(plan.semantic_evidence?.some((node) =>
      node.role === "reference_anchor" && node.exact_fragment === "GB 50311"
    )).toBe(true);
    if (mode === "external_stub") {
      expect(unresolved).not.toHaveProperty("error");
      expect(result.reference_occurrences?.[0]).toMatchObject({
        external_standard: { standard_no: "GB 50311", status: "placeholder" },
        target_address: { source_id: "external-standard:GB50311", locator_kind: "standard", locator: "standard:GB50311" },
        target_evidence_ids: [],
      });
      expect(result.inspection_lots[0]!.items[0]!.inline_references?.[0]?.target.kind).toBe("standard");
      expect(currentManifest.evidence).toHaveLength(manifest.evidence.length);
    }
  });

  test("registers the GB 50204 7.3.7 external standard citation split across adjacent evidence", async () => {
    const firstLine = "7.3.7 混凝土拌合物的取样与试样留置应符合现行国家标准《普通混凝土拌合物性能试验方法标";
    const secondLine = "准》GB/T 50080 的规定。";
    const markdownLines = [
      ...Array.from({ length: 1097 }, () => ""),
      "# 7.3 混凝土施工",
      firstLine,
      "",
      secondLine,
    ];
    const markdown = markdownLines.join("\n");
    const manifest = manifestFor(markdown, [firstLine, secondLine]);
    expect(manifest.evidence.map((record) => ({ locator: record.locator, clause_id: record.clause_id }))).toEqual([
      { locator: "line:1099", clause_id: "7.3.7" },
      { locator: "line:1101", clause_id: "7.3.7" },
    ]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("gb50204-composite-reference"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const spans = await registerExactLiteralSpans(workspace, manifest, [
      { evidence_id: manifest.evidence[0]!.evidence_id, quote: "《普通混凝土拌合物性能试验方法标" },
      { evidence_id: manifest.evidence[1]!.evidence_id, quote: secondLine },
    ]);
    const controller = await ToolController.create(workspace);
    const rawReference = "《普通混凝土拌合物性能试验方法标准》GB/T 50080 的规定。";
    const receipt = await controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: spans.reference_literal_span_ids,
      origin_field: "sampling",
      raw_reference: rawReference,
      normalized_reference: rawReference,
      standard_no: "GB/T 50080",
      standard_title: "普通混凝土拌合物性能试验方法标准",
      relation: "sampling_method_standard",
    });
    expect(receipt).toMatchObject({
      ok: true,
      receipt: "external_reference_placeholder",
      origin_field: "sampling",
      raw_reference: rawReference,
      normalized_reference: rawReference,
      reference_literal_span_id: spans.reference_literal_span_ids[0],
      reference_literal_span_ids: spans.reference_literal_span_ids,
      origin_evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      origin_span_ids: spans.reference_literal_span_ids,
      unresolved_reference: { origin_clause_id: "7.3.7", origin_locators: ["line:1099", "line:1101"] },
    });
    expect(await controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: spans.reference_literal_span_ids,
      origin_field: "sampling",
      raw_reference: rawReference,
      normalized_reference: rawReference,
      standard_no: "GB/T 50080",
      standard_title: "普通混凝土拌合物性能试验方法标准",
      relation: "同一组合引用重复登记",
    })).toMatchObject({ occurrence_id: receipt.occurrence_id, idempotent: true });
    const currentManifest = await workspace.readEvidenceManifest();
    const occurrence = currentManifest.reference_occurrences[0]!;
    expect(occurrence).toMatchObject({
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      origin_evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      reference_literal_span_id: spans.reference_literal_span_ids[0],
      reference_literal_span_ids: spans.reference_literal_span_ids,
      reference_literals: [
        expect.objectContaining({ evidence_id: manifest.evidence[0]!.evidence_id }),
        expect.objectContaining({ evidence_id: manifest.evidence[1]!.evidence_id }),
      ],
      origin_fields: ["sampling"],
      raw_reference: rawReference,
      external_standard: { standard_no: "GB/T 50080", status: "placeholder" },
      status: "target_not_found",
    });
    const incompleteSelectors = initialTargetSelectorPlan(currentManifest);
    incompleteSelectors.references.push({
      key: "gb50204-incomplete-anchor",
      occurrence_id: occurrence.occurrence_id,
      anchor_span_ids: [spans.reference_literal_span_ids[0]!],
      target_span_ids: [],
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["sampling"], reason: "仅验证组合 anchor 完整性。" },
      destinations: [],
      reason: "组合引用漏掉第二段时必须由 compiler 拒绝。",
    });
    try {
      compileTargetSelectors(incompleteSelectors, await workspace.readSourceSpanRegistry(), currentManifest);
      throw new Error("Expected the composite reference anchor to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_literal_anchor_required",
          details: expect.objectContaining({ missing_reference_literal_span_ids: [spans.reference_literal_span_ids[1]] }),
        }),
      ]));
    }
    const plan = validFixturePlan(currentManifest);
    plan.reference_resolutions.push({
      resolution_id: "resolution:gb50204-7.3.7",
      occurrence_id: occurrence.occurrence_id,
      origin_evidence_id: occurrence.origin_evidence_id,
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["sampling"], reason: "外部标准只保留抽样来源。" },
      target_evidence_ids: [],
      destination_bindings: [{ item_id: plan.acceptance_items[0]!.item_id, target_field: "sampling" }],
      reason: "外部正文未提供，按组合原文位置保留抽样引用。",
    });
    const inline = materialize(plan, currentManifest, "gb50204-composite-plan")
      .result.inspection_lots[0]!.items[0]!.inline_references?.[0];
    expect(inline).toMatchObject({
      field: "sampling",
      raw_reference: rawReference,
      origin_evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      reference_literal_span_ids: spans.reference_literal_span_ids,
      reference_literals: [expect.any(Object), expect.any(Object)],
    });
    expect(inline?.segments.filter((segment) => segment.kind === "reference")
      .map((segment) => segment.raw_reference).join("")).toBe(rawReference);
    expect(validatePlanText(prettyJson(plan), currentManifest).issues.filter((issue) =>
      issue.code === "reference_composite_provenance_invalid"
    )).toEqual([]);
    expect(coverageFieldScopedReferenceRoutesForItem(
      plan,
      currentManifest,
      new Set([plan.acceptance_items[0]!.item_id]),
    )[0]).toMatchObject({
      occurrence_id: occurrence.occurrence_id,
      origin_evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      reference_literal_span_ids: spans.reference_literal_span_ids,
      authoritative_target_field: "sampling",
      route_consistency: "exact",
    });
    const tamperedManifest = structuredClone(currentManifest);
    tamperedManifest.reference_occurrences[0]!.reference_literals!.reverse();
    expect(validatePlanText(prettyJson(plan), tamperedManifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_composite_provenance_invalid" }),
    ]));
  });

  test("fails closed for unsafe composite reference span sets", async () => {
    const prepare = async (
      label: string,
      lines: string[],
      primary: string[],
      quotes: string[],
    ) => {
      const markdown = lines.join("\n");
      const manifest = manifestFor(markdown, primary);
      const workspace = await RevisionWorkspace.createFromEvidence(
        await tempRoot(label), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) },
      );
      const spans = await registerExactLiteralSpans(workspace, manifest, quotes.map((quote, index) => ({
        evidence_id: manifest.evidence[index]!.evidence_id,
        quote,
      })));
      return { controller: await ToolController.create(workspace), manifest, spans };
    };
    const baseFirst = "7.3.7 取样应符合《普通混凝土拌合物性能试验方法标";
    const baseSecond = "准》GB/T 50080 的规定。";
    const baseRaw = "《普通混凝土拌合物性能试验方法标准》GB/T 50080 的规定。";

    const differentClause = await prepare(
      "composite-different-clause",
      [baseFirst, "7.3.8 准》GB/T 50080 的规定。"],
      [baseFirst, "7.3.8 准》GB/T 50080 的规定。"],
      ["《普通混凝土拌合物性能试验方法标", "准》GB/T 50080 的规定。"],
    );
    expect(await differentClause.controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: differentClause.spans.reference_literal_span_ids,
      origin_field: "sampling", raw_reference: baseRaw, standard_no: "GB/T 50080", relation: "sampling",
    })).toMatchObject({ ok: false, error: "unsafe_composite_reference_span_set" });

    const nonAdjacent = await prepare(
      "composite-non-adjacent",
      [baseFirst, "本条另有实质要求。", baseSecond],
      [baseFirst, baseSecond],
      ["《普通混凝土拌合物性能试验方法标", baseSecond],
    );
    expect(await nonAdjacent.controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: nonAdjacent.spans.reference_literal_span_ids,
      origin_field: "sampling", raw_reference: baseRaw, standard_no: "GB/T 50080", relation: "sampling",
    })).toMatchObject({ ok: false, error: "unsafe_composite_reference_span_set" });

    const ordered = await prepare(
      "composite-source-order",
      [baseFirst, "", baseSecond],
      [baseFirst, baseSecond],
      ["《普通混凝土拌合物性能试验方法标", baseSecond],
    );
    expect(await ordered.controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: [...ordered.spans.reference_literal_span_ids].reverse(),
      origin_field: "sampling", raw_reference: baseRaw, standard_no: "GB/T 50080", relation: "sampling",
    })).toMatchObject({ ok: false, error: "unsafe_composite_reference_span_set" });

    const multipleStandardsSecond = "准》GB/T 50080 和 GB/T 50081 的规定。";
    const multipleStandards = await prepare(
      "composite-multiple-standards",
      [baseFirst, multipleStandardsSecond],
      [baseFirst, multipleStandardsSecond],
      ["《普通混凝土拌合物性能试验方法标", multipleStandardsSecond],
    );
    expect(await multipleStandards.controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: multipleStandards.spans.reference_literal_span_ids,
      origin_field: "sampling",
      raw_reference: "《普通混凝土拌合物性能试验方法标准》GB/T 50080 和 GB/T 50081 的规定。",
      standard_no: "GB/T 50080",
      relation: "sampling",
    })).toMatchObject({ ok: false, error: "external_standard_number_not_in_citation" });

    const repeatedTargetFirst = "7.3.7 相关要求见本规范第1.1.1条和";
    const repeatedTargetSecond = "第1.1.1条的规定。";
    const repeatedTarget = await prepare(
      "composite-repeated-target",
      ["1.1.1 被引要求。", "1.1.2 后续条文。", repeatedTargetFirst, repeatedTargetSecond],
      [repeatedTargetFirst, repeatedTargetSecond],
      ["本规范第1.1.1条和", repeatedTargetSecond],
    );
    expect(await repeatedTarget.controller.dispatch("resolve_document_reference", {
      reference_literal_span_ids: repeatedTarget.spans.reference_literal_span_ids,
      origin_field: "requirement",
      raw_reference: "本规范第1.1.1条和第1.1.1条的规定。",
      normalized_reference: "本规范第1.1.1条和第1.1.1条的规定。",
      target: { kind: "clause", number: "1.1.1" },
      relation: "repeated_target",
    })).toMatchObject({ ok: false, error: "composite_reference_target_ambiguous", target_candidate_count: 2 });

    const fourParts = ["7.3.7 《普通", "混凝土拌合物", "性能试验方法标准》", "GB/T 50080"];
    const tooMany = await prepare(
      "composite-too-many-spans",
      fourParts,
      fourParts,
      ["《普通", "混凝土拌合物", "性能试验方法标准》", "GB/T 50080"],
    );
    expect(await tooMany.controller.dispatch("resolve_external_standard_reference", {
      reference_literal_span_ids: tooMany.spans.reference_literal_span_ids,
      origin_field: "sampling",
      raw_reference: "《普通混凝土拌合物性能试验方法标准》GB/T 50080",
      standard_no: "GB/T 50080",
      relation: "sampling",
    })).toMatchObject({ ok: false, error: "invalid_reference_span_set" });
  });

  test.each([
    ["附录换行", "9.2.2 检验要求和试验方法应符合本规范附录", "B 的规定。", "B", { kind: "appendix", number: "B" }],
    ["表号换行", "9.2.2 检验结果应符合表", "B.1.1 的规定。", "B.1.1", { kind: "table", number: "B.1.1" }],
    ["条号换行", "9.2.2 检验结果应符合第", "5.2.1条的规定。", "5.2.1条", { kind: "clause", number: "5.2.1" }],
    ["英文双字母附录", "9.2.2 Test method shall comply with Appendix", "AA.", "AA", { kind: "appendix", number: "AA" }],
    ["中文附录编号", "9.2.2 检验方法应符合本规范附录", "甲的规定。", "甲", { kind: "appendix", number: "甲" }],
  ] as const)("%s只返回复合引用待复核窗口，不自动拼接", async (_name, first, second, rawReference, target) => {
    const markdown = [first, "", second].join("\n");
    const manifest = manifestFor(markdown, [first, second]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("composite-reference-review"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const registry = await workspace.readSourceSpanRegistry();
    const secondRecord = manifest.evidence.find(record => record.text === second)!;
    const originSpanId = registry.spans.find(span => span.evidence_id === secondRecord.evidence_id
      && span.start === 0 && span.end === secondRecord.text.length)!.span_id;
    const controller = await ToolController.create(workspace);
    const receipt = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      origin_field: "requirement",
      raw_reference: rawReference,
      target,
      relation: "待复核组合引用",
    });
    expect(receipt).toMatchObject({
      ok: false,
      error: "composite_reference_review_required",
      status: "review",
      budget_consumed: false,
      adjacent_source_window: expect.arrayContaining([
        expect.objectContaining({ text: first, locator: expect.any(String) }),
        expect.objectContaining({ text: second, locator: expect.any(String) }),
      ]),
      writable_paths: expect.arrayContaining(["/reference_literal_span_ids", "/normalized_reference"]),
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([]);
  });

  test("GB/T 换行进入复合引用复核，而 B级和无标点结构不被自动拼接", async () => {
    const first = "7.3.7 试验应符合 GB/T";
    const second = "50081 的规定。";
    const markdown = [first, "", second].join("\n");
    const manifest = manifestFor(markdown, [first, second]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("composite-standard-review"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const registry = await workspace.readSourceSpanRegistry();
    const secondRecord = manifest.evidence.find(record => record.text === second)!;
    const originSpanId = registry.spans.find(span => span.evidence_id === secondRecord.evidence_id
      && span.start === 0 && span.end === secondRecord.text.length)!.span_id;
    const controller = await ToolController.create(workspace);
    expect(await controller.dispatch("resolve_external_standard_reference", {
      origin_span_id: originSpanId, origin_field: "method", raw_reference: "50081",
      standard_no: "50081", relation: "待复核跨片段标准号",
    })).toMatchObject({ ok: false, error: "composite_reference_review_required", status: "review" });

    const nonReference = "材料等级为B级";
    const plainManifest = manifestFor(nonReference, nonReference);
    const plainWorkspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("no-false-composite-reference"), plainManifest.job_id, plainManifest.target_id,
      { manifest: plainManifest, markdown: Buffer.from(nonReference) },
    );
    const plainSpan = (await plainWorkspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const plainReceipt = await (await ToolController.create(plainWorkspace)).dispatch("resolve_document_reference", {
      origin_span_id: plainSpan, origin_field: "requirement", raw_reference: "B",
      target: { kind: "appendix", number: "B" }, relation: "不是引用",
    });
    expect(plainReceipt.error).not.toBe("composite_reference_review_required");

    for (const [label, structural] of [
      ["无标点标题", "# 材料等级"],
      ["无标点列表", "1 材料等级"],
      ["无标点表格", "<table><tr><td>材料等级</td></tr></table>"],
    ] as const) {
      const structureMarkdown = `${structural}\nB级`;
      const structureManifest = manifestFor(structureMarkdown, [structural, "B级"]);
      const structureWorkspace = await RevisionWorkspace.createFromEvidence(
        await tempRoot(label), structureManifest.job_id, structureManifest.target_id,
        { manifest: structureManifest, markdown: Buffer.from(structureMarkdown) },
      );
      const secondEvidence = structureManifest.evidence.find(record => record.text === "B级")!;
      const structureRegistry = await structureWorkspace.readSourceSpanRegistry();
      const structureSpan = structureRegistry.spans.find(span => span.evidence_id === secondEvidence.evidence_id
        && span.start === 0 && span.end === secondEvidence.text.length)!.span_id;
      const result = await (await ToolController.create(structureWorkspace)).dispatch("resolve_document_reference", {
        origin_span_id: structureSpan, origin_field: "requirement", raw_reference: "B",
        target: { kind: "appendix", number: "B" }, relation: "结构文本不是引用",
      });
      expect(result.error, label).not.toBe("composite_reference_review_required");
    }
  });

  test("‘本规范附录’前缀本身不能冒充已包含目标 B 的完整引用", async () => {
    const first = "9.2.2 检验要求和试验方法应符合本规范附录";
    const second = "B 的规定。";
    const markdown = `${first}\n\n${second}`;
    const manifest = manifestFor(markdown, [first, second]);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("reference-prefix-is-not-target"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(markdown) },
    );
    const registry = await workspace.readSourceSpanRegistry();
    const firstRecord = manifest.evidence.find(record => record.text === first)!;
    const originSpanId = registry.spans.find(span => span.evidence_id === firstRecord.evidence_id
      && span.start === 0 && span.end === firstRecord.text.length)!.span_id;
    expect(await (await ToolController.create(workspace)).dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, origin_field: "method", raw_reference: "本规范附录",
      target: { kind: "appendix", number: "B" }, relation: "错误的前缀单段",
    })).toMatchObject({
      ok: false,
      error: "composite_reference_review_required",
      target_candidate_count: 0,
      composite_review_candidates: expect.arrayContaining([expect.objectContaining({ status: "review" })]),
    });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([]);
  });

  test("同一 occurrence 的 origin/destination A-B-A 往返被识别为 Harness 空转", () => {
    expect(referenceBindingOscillation([
      { occurrence_id: "reference:split-b", issue_codes: ["selector_reference_origin_field_mismatch"], issue_fingerprint: "a" },
      { occurrence_id: "reference:split-b", issue_codes: ["reference_destination_field_mismatch"], issue_fingerprint: "b" },
      { occurrence_id: "reference:split-b", issue_codes: ["selector_reference_origin_field_mismatch"], issue_fingerprint: "a" },
    ])).toEqual({
      occurrence_id: "reference:split-b",
      states: [["selector_reference_origin_field_mismatch"], ["reference_destination_field_mismatch"], ["selector_reference_origin_field_mismatch"]],
    });
  });

  test("组合引用 span 不能跨原文版本复用", async () => {
    const sourceA = "9.2.2 应符合本规范附录\nB 的规定。";
    const manifestA = manifestFor(sourceA, sourceA.split("\n"));
    const workspaceA = await RevisionWorkspace.createFromEvidence(
      await tempRoot("composite-version-a"), manifestA.job_id, manifestA.target_id,
      { manifest: manifestA, markdown: Buffer.from(sourceA) },
    );
    const spansA = await registerExactLiteralSpans(workspaceA, manifestA, [
      { evidence_id: manifestA.evidence[0]!.evidence_id, quote: "本规范附录" },
      { evidence_id: manifestA.evidence[1]!.evidence_id, quote: "B" },
    ]);
    const sourceB = `${sourceA}\n版本变更。`;
    const manifestB = manifestFor(sourceB, sourceA.split("\n"));
    const workspaceB = await RevisionWorkspace.createFromEvidence(
      await tempRoot("composite-version-b"), manifestB.job_id, manifestB.target_id,
      { manifest: manifestB, markdown: Buffer.from(sourceB) },
    );
    expect(await (await ToolController.create(workspaceB)).dispatch("resolve_document_reference", {
      origin_span_ids: spansA.origin_span_ids,
      reference_literal_span_ids: spansA.reference_literal_span_ids,
      origin_field: "requirement", raw_reference: "本规范附录B", normalized_reference: "本规范附录 B",
      target: { kind: "appendix", number: "B" }, relation: "跨版本不得复用",
    })).toMatchObject({ ok: false, error: "invalid_origin_span" });
  });

  const livePrecastRevision = "data/jobs/20260907-094050-gb50204-selfreview-luna-medium/pi-agent/jobs/20260907-094050-gb50204-selfreview-luna-medium/targets/target_3Ad107f9a59ae6b0d9d9dd1d13/revisions/000001";
  test.skipIf(!existsSync(join(livePrecastRevision, "evidence/evidence.json")))("GB50204 预制构件快照将‘本规范附录 / B’提升为复合引用并稳定 requirement origin", async () => {
    const manifest = JSON.parse(await readFile(join(livePrecastRevision, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const registry = JSON.parse(await readFile(join(livePrecastRevision, "source-span-registry.json"), "utf8")) as SourceSpanRegistry;
    const old = manifest.reference_occurrences.find(occurrence => occurrence.raw_reference === "B")!;
    expect(compositeReferenceReviewCandidates(manifest, registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "review",
        lead_fragment: expect.objectContaining({ text: expect.stringContaining("本规范附录") }),
        trailing_fragment: expect.objectContaining({ text: "B" }),
      }),
    ]));
    expect(compositeReferenceReviewCandidate(manifest, registry, old)).toMatchObject({
      status: "review",
      adjacent_source_window: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("本规范附录") }),
        expect.objectContaining({ text: expect.stringMatching(/^B\s*的规定/u) }),
      ]),
    });

    const first = manifest.evidence.find(record => record.clause_id === "9.2.2" && record.text.includes("本规范附录"))!;
    const second = manifest.evidence.find(record => record.clause_id === "9.2.2" && /^B\s*的规定/u.test(record.text))!;
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("gb50204-precast-composite-reference"), manifest.job_id, manifest.target_id,
      { manifest: structuredClone(manifest), markdown: await readFile(join(livePrecastRevision, "evidence/source.md")) },
    );
    const spans = await registerExactLiteralSpans(workspace, await workspace.readEvidenceManifest(), [
      { evidence_id: first.evidence_id, quote: "本规范附录" },
      { evidence_id: second.evidence_id, quote: "B" },
    ]);
    const controller = await ToolController.create(workspace);
    expect(await controller.dispatch("resolve_document_reference", {
      origin_span_ids: spans.origin_span_ids,
      reference_literal_span_ids: spans.origin_span_ids,
      origin_field: "requirement",
      raw_reference: "本规范附录B",
      normalized_reference: "本规范附录 B",
      target: { kind: "appendix", number: "B" },
      relation: "错误地把整句 span 当 literal",
    })).toMatchObject({
      ok: false,
      error: "composite_reference_literal_mismatch",
      next_tool: "locate_evidence_span",
      candidate_literal_fragments: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("本规范附录") }),
        expect.objectContaining({ text: "B" }),
      ]),
    });
    const receipt = await controller.dispatch("resolve_document_reference", {
      origin_span_ids: spans.origin_span_ids,
      reference_literal_span_ids: spans.reference_literal_span_ids,
      origin_field: "requirement",
      raw_reference: "本规范附录B",
      normalized_reference: "本规范附录 B",
      target: { kind: "appendix", number: "B" },
      relation: "检验要求与试验方法分别导入对应 destination",
    });
    expect(receipt).toMatchObject({
      ok: true,
      origin_field: "requirement",
      normalized_reference: "本规范附录 B",
      reference_literal_span_ids: spans.reference_literal_span_ids,
      superseded_occurrence_ids: [old.occurrence_id],
    });
    const repairedManifest = await workspace.readEvidenceManifest();
    expect(repairedManifest.reference_occurrences.some(occurrence => occurrence.occurrence_id === old.occurrence_id)).toBe(false);
    expect(repairedManifest.reference_occurrences.find(occurrence => occurrence.occurrence_id === receipt.occurrence_id)).toMatchObject({
      origin_fields: ["requirement"],
      normalized_reference: "本规范附录 B",
      reference_literal_span_ids: spans.reference_literal_span_ids,
    });
  }, 15_000);

  test("external placeholder never resolves a same-number internal clause and is idempotent", async () => {
    const origin = "6.2.1 检验应符合《外部规范》GB 50208第1.1.1条的规定。";
    const markdown = `${SOURCE}\n${origin}`;
    const manifest = manifestFor(markdown, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("external-standard-stub"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
    const controller = await ToolController.create(workspace);
    const request = {
      origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id,
      raw_reference: "《外部规范》GB 50208第1.1.1条",
      standard_no: "GB 50208",
      standard_title: "外部规范",
      target: { kind: "clause", number: "1.1.1" },
      relation: "引用外部验收要求",
    };
    const first = await controller.dispatch("resolve_external_standard_reference", request);
    const second = await controller.dispatch("resolve_external_standard_reference", { ...request, relation: "另一角色重新读取" });
    expect(first).toMatchObject({ ok: true, status: "external_reference_placeholder", content_available: false, locator: "clause:1.1.1" });
    expect(first.reference_literal_span_ids).toEqual([first.reference_literal_span_id]);
    expect(second).toMatchObject({ occurrence_id: first.occurrence_id, idempotent: true });
    const current = await workspace.readEvidenceManifest();
    expect(current.evidence).toEqual(manifest.evidence);
    expect(current.reference_occurrences).toHaveLength(1);
    expect(current.reference_occurrences[0]).toMatchObject({
      required: false, status: "target_not_found", target_evidence_ids: [],
      external_standard: { standard_no: "GB 50208", standard_title: "外部规范", status: "placeholder" },
      target_address: { source_id: "external-standard:GB50208", locator_kind: "clause", locator: "clause:1.1.1" },
    });
    expect(current.reference_occurrences[0]).not.toHaveProperty("reference_literal_span_ids");
    const state = await workspace.readState();
    expect(state.selector_protocol?.submissions).toBe(0);
    expect(state.validation_attempts).toBe(0);
    expect(state.reference_analysis_modes).toBeUndefined();
  });

  test("external tool rejects missing source evidence, invented standard numbers, and standard-as-section arguments", async () => {
    const { controller, workspace, originSpanId } = await controllerFor();
    const before = await workspace.readEvidenceManifest();
    const request = { origin_span_id: originSpanId, raw_reference: "GB 50208", standard_no: "GB 50208", relation: "外部引用" };
    expect(await controller.dispatch("resolve_external_standard_reference", request)).toMatchObject({ ok: false, error: "origin_span_does_not_contain_raw_reference" });
    expect(await controller.dispatch("resolve_external_standard_reference", { ...request, standard_no: "GB 99999" })).toMatchObject({ ok: false, error: "external_standard_number_not_in_citation" });
    expect(await controller.dispatch("resolve_external_standard_reference", { ...request, target: { kind: "section", number: "GB 50208" } })).toMatchObject({ ok: false, error: "invalid_external_standard_target" });
    expect(await workspace.readEvidenceManifest()).toEqual(before);
  });

  test("exact same-document references remain available in every selector and reviewer stage", async () => {
    const { controller, workspace } = await controllerFor();
    const tools = createPiTools(controller);
    const tool = tools.find((entry) => entry.name === "resolve_document_reference")!;
    expect(tool).toBeDefined();
    expect(tools.map((entry) => entry.name)).not.toContain("resolve_external_standard_reference");
    const serializedSchema = JSON.stringify(tool.parameters);
    expect(serializedSchema).toContain('"table"');
    expect(serializedSchema).toContain('"section"');
    expect(serializedSchema).toContain('"clause"');
    expect(serializedSchema).toContain('"appendix"');
    for (const stage of ["primary", "sampling", "table", "commit", "coverage_repair"] as const) {
      await workspace.updateState((state) => { state.selector_stage = stage; });
      const resumed = await ToolController.create(workspace);
      expect(resumed.selectorProviderPolicy().allowed_tools).toContain(tool.name);
      expect(resumed.selectorProviderPolicy().allowed_tools).not.toContain("resolve_external_standard_reference");
    }
    const reviewTools = createCoverageReviewTools({} as CoverageReviewController);
    expect(reviewTools.map((entry) => entry.name)).toContain(tool.name);
    expect(reviewTools.map((entry) => entry.name)).not.toContain("resolve_external_standard_reference");
    expect(reviewTools.filter((entry) => entry.name === tool.name)).toHaveLength(1);
    const reviewTool = reviewTools.find((entry) => entry.name === tool.name)!;
    expect(JSON.stringify(reviewTool.parameters)).toContain('"table"');
    expect(JSON.stringify(reviewTool.parameters)).toContain('"section"');
  });

  test("an external identifier is rejected as an internal locator before registration", async () => {
    const origin = "1.1 检查对象另见 AB 90001。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("reference-lookup-scope"), manifest.job_id, manifest.target_id,
      { manifest, markdown: Buffer.from(origin) });
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const requested = { kind: "clause", number: "AB 90001" };
    const result = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, origin_field: "requirement", raw_reference: "AB 90001",
      target: requested, relation: "调查引用指向",
    });
    expect(result).toMatchObject({ ok: false, error: "invalid_internal_reference_locator", budget_consumed: false,
      requested_target: requested, raw_reference: "AB 90001", expected: { occurrence_registered: false },
      next_tool: "open_evidence", next_tool_arguments: { evidence_id: manifest.evidence[0]!.evidence_id, cursor: 0 },
      instruction: expect.stringContaining("外部标准按任务提供的外部资料入口"),
    });
    expect(await controller.dispatch(String(result.next_tool), result.next_tool_arguments as Record<string, unknown>)).toMatchObject({ ok: true });
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toEqual([]);
    expect(createPiTools(controller).map(tool => tool.name)).not.toContain("resolve_external_standard_reference");
  });

  test("同一处外部标准被两个角色先后解析仍拿得到回执，且回执可追回原文", async () => {
    // occurrence_id 只由「来源 + 目标」算出，而 relation 是调用方自己措辞的说明。
    // 作者先解析一次、复核再解析一次时 relation 必然不同，此前登记处比整个对象逐字一致，
    // 于是同 id 不同内容 → 抛 occurrence collision → 既不给结果也不给 target_not_found 回执。
    // 这一条专打外部标准：它永远解析不成，也就永远会被第二个人再解析一次。
    // 实测 GB/T 50312 的 保护措施 因此走 coverage_harness_defect 失败。
    const origin = "6.2.5 当电缆从建筑物外面进入建筑物时，应选用适配的信号线路浪涌保护器，并应符合现行国家标准《综合布线系统工程设计规范》GB 50311 的有关规定。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("external-reference-twice"),
      manifest.job_id,
      manifest.target_id,
      { manifest, markdown: Buffer.from(origin) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
    const call = (relation: string) => controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "GB 50311",
      target: { source_id: "GB 50311", kind: "clause", number: "外部标准" },
      relation,
    });

    const first = await call("信号线路浪涌保护器适配及有关规定");
    const second = await call("强调外部设计规范的适用性");

    for (const receipt of [first, second]) {
      expect(receipt).toMatchObject({
        ok: false,
        error: "target_not_found",
        receipt: "target_not_found",
      });
      // 追溯线索：谁在第几行、上下文原句是什么、欠的是哪一本。
      expect(receipt.unresolved_reference).toMatchObject({
        origin_locator: expect.any(String),
        origin_excerpt: expect.stringContaining("GB 50311"),
        target_kind: "clause",
        target_number: "外部标准",
      });
    }
    expect(second.occurrence_id).toBe(first.occurrence_id);

    // 先到先得：登记的那份保持不变，不因第二次调用被改写。
    const occurrences = (await workspace.readEvidenceManifest()).reference_occurrences;
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      status: "target_not_found",
      raw_reference: "GB 50311",
      relation: "信号线路浪涌保护器适配及有关规定",
    });
  });

  test("mixed reference fields retain only explicitly selected local origin evidence without granting unrelated routes", async () => {
    const { controller, workspace, originSpanId } = await controllerFor();
    const receipt = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId, raw_reference: "本规范第 1.1.1 条第 2 款",
      target: { kind: "clause", number: "1.1.1", paragraph: "2" }, relation: "requirement_adoption",
    });
    expect(receipt.ok).toBe(true);
    const manifest = await workspace.readEvidenceManifest();
    const registry = await workspace.readSourceSpanRegistry();
    const targetSpanId = (await receiptEvidence(workspace, receipt))[0]!.span_id;
    const literalSpanId = receipt.reference_literal_span_id as string;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "安装检验批", scope_span_ids: [originSpanId], reason: "目标范围。" });
    selectors.items.push({
      key: "receiver", lot_key: "lot", name: "安装间距", category: "一般项目",
      criterion_span_ids: [targetSpanId], continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [targetSpanId], separator: "", reason: "被引判断对象。" },
        requirement: { composition: "reference", span_ids: [originSpanId, targetSpanId], separator: "\n", reason: "本地限定及被引判据。" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "未规定。" },
      },
      table: null, inspection_data_type: "review", inspection_data_type_reason: "依据文本核验。",
      inspection_data_type_span_ids: [targetSpanId],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "未规定。", confidence: 1 },
      reason: "真实验收判断来自被引条款，本地原文保留适用上下文。",
    });
    selectors.references.push({
      key: "route", occurrence_id: receipt.occurrence_id as string,
      anchor_span_ids: [literalSpanId], target_span_ids: [targetSpanId],
      action: "adopt", application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["name", "requirement"], reason: "仅引用判断对象和验收判据。" },
      origin_binding: { item_key: "receiver", target_field: "requirement" },
      destinations: [{ item_key: "receiver", target_field: "requirement" }],
      component_dispositions: [{ component_span_ids: [targetSpanId], decision: "same_judgment", item_keys: ["receiver"], reason: "同一判断的被引判据。" }],
      reason: "本地范围与引用文字保留在原字段，被引判据进入同一字段。",
    });
    const before = structuredClone(selectors);
    const compiled = compileTargetSelectors(selectors, registry, manifest);
    const plan = hydrateSemanticSourcePlan(compiled, manifest);
    expect(selectors).toEqual(before);
    expect(plan.acceptance_items[0]!.evidence_ids).toContain(manifest.reference_occurrences[0]!.origin_evidence_id);
    expect(plan.acceptance_items[0]!.requirement).toBe([
      manifest.evidence.find(record => record.evidence_id === manifest.reference_occurrences[0]!.origin_evidence_id)!.text,
      (await receiptEvidence(workspace, receipt))[0]!.text,
    ].join("\n"));
    expect(validatePlanText(prettyJson(plan), manifest)).toMatchObject({ ok: true, issues: [] });

    // Two independent pure forwarders in one evidence record must not force
    // this receiver to copy the other object's sentence just to retain context.
    const parallelManifest = structuredClone(manifest);
    const parallelPlan = structuredClone(plan);
    const origin = parallelManifest.evidence.find(record =>
      record.evidence_id === parallelManifest.reference_occurrences[0]!.origin_evidence_id)!;
    const ownSentence = origin.text.replace(/。$/u, "");
    origin.text = `${ownSentence}；另一构件的安装应符合本规范第 1.1.2 条的规定。`;
    origin.text_sha256 = sha256Text(origin.text);
    parallelManifest.reference_occurrences.push({
      ...structuredClone(parallelManifest.reference_occurrences[0]!),
      occurrence_id: "reference:parallel-sibling", raw_reference: "本规范第 1.1.2 条",
    });
    const receiver = parallelPlan.acceptance_items[0]!;
    receiver.field_bindings.requirement.source_fragments[0]!.text = ownSentence;
    receiver.requirement = receiver.field_bindings.requirement.source_fragments.map(fragment => fragment.text).join("\n");
    receiver.field_bindings.requirement.value_sha256 = sha256Text(receiver.requirement);
    const relationIssues = validatePlanText(prettyJson(parallelPlan), parallelManifest).issues
      .filter(issue => issue.code === "reference_origin_relation");
    expect(relationIssues).toEqual([]);

    // The other sentence need not itself be a reference for this exact origin
    // unit to remain valid. Its unrelated criterion must not become required provenance.
    const mixedManifest = structuredClone(parallelManifest);
    const mixedOrigin = mixedManifest.evidence.find(record => record.evidence_id === origin.evidence_id)!;
    mixedOrigin.text = `${ownSentence}。另一构件的表面不得有裂纹。`;
    mixedOrigin.text_sha256 = sha256Text(mixedOrigin.text);
    expect(validatePlanText(prettyJson(parallelPlan), mixedManifest).issues
      .filter(issue => issue.code === "reference_origin_relation")).toEqual([]);

    const conditionalPlan = structuredClone(parallelPlan);
    const conditionalOrigin = `固定件穿过构件时，${ownSentence.replace(/^\d+(?:\.\d+)+\s*/u, "")}`;
    mixedOrigin.text = `另一构件的表面不得有裂纹。${conditionalOrigin}。`;
    mixedOrigin.text_sha256 = sha256Text(mixedOrigin.text);
    const conditionalReceiver = conditionalPlan.acceptance_items[0]!;
    conditionalReceiver.field_bindings.requirement.source_fragments[0]!.text = conditionalOrigin;
    conditionalReceiver.requirement = conditionalReceiver.field_bindings.requirement.source_fragments.map(fragment => fragment.text).join("\n");
    conditionalReceiver.field_bindings.requirement.value_sha256 = sha256Text(conditionalReceiver.requirement);
    expect(validatePlanText(prettyJson(conditionalPlan), mixedManifest).issues
      .filter(issue => issue.code === "reference_origin_relation")).toEqual([]);
    expect(validatePlanText(prettyJson(parallelPlan), mixedManifest).issues
      .some(issue => issue.code === "reference_origin_relation")).toBe(true);


    const duplicateLiteral = structuredClone(selectors);
    duplicateLiteral.items[0]!.fields.requirement.span_ids = [originSpanId, literalSpanId, targetSpanId];
    const duplicateBefore = structuredClone(duplicateLiteral);
    expect(() => compileTargetSelectors(duplicateLiteral, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({
        code: "selector_reference_literal_display_duplicate", path: "/items/0/fields/requirement/span_ids",
        details: expect.objectContaining({
          writable_path: "/items/0/fields/requirement/span_ids", next_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("anchor_span_ids"),
        }),
      })]),
    }));
    expect(duplicateLiteral).toEqual(duplicateBefore);

    const anchorOnly = structuredClone(selectors);
    anchorOnly.items[0]!.fields.requirement.span_ids = [literalSpanId, targetSpanId];
    const anchorOnlyPlan = hydrateSemanticSourcePlan(compileTargetSelectors(anchorOnly, registry, manifest), manifest);
    expect(validatePlanText(prettyJson(anchorOnlyPlan), manifest).issues.map(issue => issue.code)).toContain("reference_origin_relation");

    // A route's anchor alone must not inject local evidence when no visible field selects it.
    const noVisibleOrigin = structuredClone(plan);
    noVisibleOrigin.acceptance_items[0]!.field_bindings.requirement.source_fragments = plan.acceptance_items[0]!.field_bindings.requirement.source_fragments.filter(fragment => fragment.evidence_id !== manifest.reference_occurrences[0]!.origin_evidence_id);
    expect(validatePlanText(prettyJson(noVisibleOrigin), manifest).issues.map(issue => issue.code)).toContain("reference_origin_relation");

    const unrelatedManifest = structuredClone(manifest);
    const unrelatedText = "另一构件的表面不得有裂纹。";
    const unrelatedId = "evidence:unrelated-component";
    unrelatedManifest.evidence.push({
      evidence_id: unrelatedId, kind: "paragraph", role: "supporting_clause",
      locator: `char:0-${unrelatedText.length}`, text: unrelatedText, text_sha256: sha256Text(unrelatedText),
      requires_disposition: false, evidence_scope: "reference",
    });
    unrelatedManifest.evidence_fingerprint = sha256Text(JSON.stringify(unrelatedManifest.evidence));
    const located = locateAndRegisterSourceQuote({ ...registry, source_fingerprint: unrelatedManifest.evidence_fingerprint }, {
      source_id: unrelatedId, evidence_id: unrelatedId, atom_id: unrelatedId, text: unrelatedText,
    }, unrelatedText);
    const unrelated = structuredClone(selectors);
    unrelated.items[0]!.fields.requirement.span_ids.push(located.spans[0]!.span_id);
    const unrelatedCompiled = compileTargetSelectors(unrelated, located.registry, unrelatedManifest);
    const unrelatedPlan = hydrateSemanticSourcePlan(unrelatedCompiled, unrelatedManifest);
    expect(unrelatedPlan.acceptance_items[0]!.evidence_ids).not.toContain(unrelatedId);
    const strict = validatePlanText(prettyJson(unrelatedPlan), unrelatedManifest);
    for (const code of ["field_binding_relation", "field_binding_reference_route"]) {
      const mapped = classifyStrictSelectorIssues(unrelated, unrelatedCompiled, located.registry, strict.issues).filter(issue => issue.code === code);
      expect(mapped).toHaveLength(1);
      expect(mapped[0]).toMatchObject({ path: "/items/0/fields/requirement/span_ids/2", details: { actual: { evidence_id: unrelatedId } } });
    }

    const wrongReceiver = structuredClone(selectors);
    wrongReceiver.items.push({ ...structuredClone(selectors.items[0]!), key: "unrouted-sibling" });
    expect(() => compileTargetSelectors(wrongReceiver, registry, manifest)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({
        code: "selector_reference_composition_without_resolve_receipt", path: "/items/1/fields/requirement/composition",
      })]),
    }));
  });

  test("registered occurrence is shared by selector compiler, validator, and coverage obligations", async () => {
    const { controller, workspace, originSpanId } = await controllerFor();
    const resolved = await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范第 1.1.1 条第 2 款",
      target: { kind: "clause", number: "1.1.1", paragraph: "2" },
      relation: "requirement_adoption",
    });
    expect(resolved).toMatchObject({ ok: true });
    const referenceLiteralSpanId = resolved.reference_literal_span_id as string;
    const manifest = await workspace.readEvidenceManifest();
    const registry = await workspace.readSourceSpanRegistry();
    const targetSpanId = (await receiptEvidence(workspace, resolved))[0]!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({
      key: "lot", name: "安装检验批", scope_span_ids: [originSpanId], reason: "目标条文",
    });
    selectors.items.push({
      key: "item",
      lot_key: "lot",
      name: "安装间距",
      category: "一般项目",
      criterion_span_ids: [originSpanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [originSpanId], separator: "", reason: "被检对象" },
        requirement: { composition: "verbatim", span_ids: [originSpanId], separator: "", reason: "引用锚点" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给方法" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给数量" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
      },
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "依据文本核验",
      inspection_data_type_span_ids: [originSpanId],
      sampling: {
        status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [],
        script_span_ids: [], condition_span_ids: [], reason: "无抽样规则", confidence: 1,
      },
      reason: "独立验收判断",
    });
    selectors.references.push({
      key: "reference",
      occurrence_id: resolved.occurrence_id as string,
      anchor_span_ids: [referenceLiteralSpanId],
      target_span_ids: [targetSpanId],
      action: "keep_reference",
      application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "安装要求引用只进入要求字段。" },
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "被引条款作为安装要求的限定依据保留在来源链中。",
    });
    const plan = hydrateSemanticSourcePlan(
      compileTargetSelectors(selectors, registry, manifest),
      manifest,
    );
    expect(validatePlanText(prettyJson(plan), manifest)).toMatchObject({ ok: true, issues: [] });
    const anchorOnly = structuredClone(selectors);
    anchorOnly.items[0]!.criterion_span_ids = [referenceLiteralSpanId];
    anchorOnly.items[0]!.fields.name.span_ids = [referenceLiteralSpanId];
    anchorOnly.items[0]!.fields.requirement.span_ids = [referenceLiteralSpanId];
    anchorOnly.items[0]!.inspection_data_type_span_ids = [referenceLiteralSpanId];
    const anchorOnlyPlan = hydrateSemanticSourcePlan(
      compileTargetSelectors(anchorOnly, registry, manifest),
      manifest,
    );
    expect(validatePlanText(prettyJson(anchorOnlyPlan), manifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "reference_origin_relation",
        details: expect.objectContaining({ anchor_only_origin_binding: true }),
      }),
    ]));
    const localOrigin = manifest.evidence.find(e=>e.evidence_id===manifest.reference_occurrences[0]!.origin_evidence_id)!;
    const splitRegistry = locateAndRegisterSourceQuote(registry,{source_id:localOrigin.evidence_id,evidence_id:localOrigin.evidence_id,text:localOrigin.text},"安装间距").registry;
    const nameSpan = splitRegistry.spans.find(span=>{
      const source=manifest.evidence.find(e=>e.evidence_id===span.evidence_id);
      return span.evidence_id===manifest.reference_occurrences[0]!.origin_evidence_id && source?.text.slice(span.start,span.end)==="安装间距";
    })!;
    const split = structuredClone(anchorOnly);
    split.items[0]!.fields.name.span_ids = [nameSpan.span_id];
    const splitPlan = hydrateSemanticSourcePlan(compileTargetSelectors(split,splitRegistry,manifest),manifest);
    expect(validatePlanText(prettyJson(splitPlan),manifest)).toMatchObject({ok:true,issues:[]});
    const differentOrigin = structuredClone(splitPlan);
    differentOrigin.acceptance_items[0]!.field_bindings.name.source_fragments[0]!.evidence_id = manifest.reference_occurrences[0]!.target_evidence_ids[0]!;
    expect(validatePlanText(prettyJson(differentOrigin),manifest).issues.map(i=>i.code)).toContain("reference_origin_relation");
    const noLiteral = structuredClone(splitPlan);
    noLiteral.acceptance_items[0]!.field_bindings.requirement.source_fragments = [];
    expect(validatePlanText(prettyJson(noLiteral),manifest).issues.map(i=>i.code)).toContain("reference_origin_relation");
    expect(clauseReferenceLocalResidual("本规范第1.1.1条；本规范第1.1.1条", "本规范第1.1.1条")).toBe("");
    expect(coverageMandatoryEvidenceIds(manifest)).toContain(
      manifest.reference_occurrences[0]!.target_evidence_ids[0],
    );

    const lossy = structuredClone(selectors);
    lossy.references[0]!.action = "conditional";
    lossy.references[0]!.application_mode = "replace_field" as TargetSelectorPlan["references"][number]["application_mode"];
    lossy.references[0]!.destinations = [{ item_key: "item", target_field: "requirement" }];
    expect(() => compileTargetSelectors(lossy, registry, manifest)).toThrow();
    expect(clauseReferenceLocalResidual(
      "6.2.1 应符合本规范第1.1.1条的规定。",
      "本规范第1.1.1条",
    )).toBe("");
    expect(clauseReferenceLocalResidual(
      "6.2.1 缆线不得布放在电梯竖井中；共用强电竖井时应符合本规范第1.1.1条的规定。",
      "本规范第1.1.1条",
    )).not.toBe("");
  });

  // 按表号取行与这本书用不用「主控/一般」分栏无关。
  // 表分支复用 buildStructuredTargetEvidence，而后者认不出 formal_table_row 时整体返回空
  //（判据是单元格里有「主控项目」或「一般项目」），于是不分栏的书一张表都查不到：
  // GB/T 50312 全书零处该词，`表6.1.1-2` 印在第 399 行却恒返回 target_not_found，
  // 继而 reference_target_not_found 禁止封存，保护措施 因此报 harness_contract_defect 退出。
  // 上面的 SOURCE 夹具表里恰好有「主控项目」，所以旧用例一直是绿的，真书上却是坏的。
  const UNCOLUMNED_SOURCE = [
    "# 6 缆线的敷设",
    "6.1.1 缆线的敷设应符合下列规定：",
    "8 综合布线系统缆线与其他管线的间距应符合表 6.1.1-2 的规定。",
    "表 6.1.1-2 对绞电缆与电力电缆最小净距",
    "<table><tr><td>条件</td><td>380V&lt;2kV·A</td><td>2kV·A~5kV·A</td><td>&gt;5kV·A</td><td>备注</td></tr>"
      + "<tr><td>平行敷设</td><td>130</td><td>300</td><td>600</td><td>-</td></tr>"
      + "<tr><td>一方在接地金属槽盒中</td><td>70</td><td>150</td><td>300</td><td>-</td></tr></table>",
  ].join("\n");

  test("按表号取行不受「主控/一般」分栏闸门影响", () => {
    const sourceId = sha256Text(UNCOLUMNED_SOURCE);
    expect(/主控项目|一般项目/.test(UNCOLUMNED_SOURCE)).toBe(false);

    const table = resolveDocumentReferenceTarget(UNCOLUMNED_SOURCE, sourceId, {
      kind: "table",
      number: "6.1.1-2",
    });
    expect(table.ok).toBe(true);
    if (table.ok) {
      expect(table.target_evidence_ids.length).toBeGreaterThan(0);
      expect(table.evidence.some((record) => record.text.includes("平行敷设"))).toBe(true);
      // 取回的行是被引依赖，不得变成本目标的交代义务。
      for (const record of table.evidence) {
        expect(record.requires_disposition).toBe(false);
        expect(record.evidence_scope).toBe("reference");
      }
    }

    // 闸门没有被开漏：文档里不存在的表照旧报找不到。
    const missing = resolveDocumentReferenceTarget(UNCOLUMNED_SOURCE, sourceId, {
      kind: "table",
      number: "99.9-9",
    });
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
  });

  test("keeps missing-reference seal errors compact and idempotent without target ID arrays", async () => {
    const { controller, workspace, originSpanId } = await controllerFor();
    await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "本规范第 1.1.1 条第 2 款",
      target: { kind: "clause", number: "1.1.1", paragraph: "2" },
      relation: "requirement_adoption",
    });
    const manifest = await workspace.readEvidenceManifest();
    await atomicWriteJson(workspace.workingPlanPath, validFixturePlan(manifest));
    await workspace.updateState((state) => { if (state.repair) state.repair.mode = "validated"; });
    const first = await controller.dispatch("seal_validated_plan", { fingerprint: "0".repeat(64) });
    expect(first).toMatchObject({ ok: false, error: "fingerprint_mismatch_or_unverified", issue_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.stringify(first)).not.toContain("selectable_target_evidence_ids");
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(8 * 1024);
    expect((await workspace.readState()).repair?.mode).toBe("modeling");
    const second = await controller.dispatch("seal_validated_plan", { fingerprint: "0".repeat(64) });
    expect(second).toMatchObject({ ok: false, error: "fingerprint_mismatch_or_unverified", idempotent: true, issue_count: expect.any(Number) });
    expect(second).not.toHaveProperty("issues");
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThan(2 * 1024);
  });

  test("enriches an existing primary table record instead of treating reference metadata as a collision", async () => {
    const origin = "8 综合布线系统缆线与其他管线的间距应符合表 6.1.1-2 的规定。";
    const source = UNCOLUMNED_SOURCE.replace(
      "8 综合布线系统缆线与其他管线的间距应符合表 6.1.1-2 的规定。",
      origin,
    );
    const baseManifest = manifestFor(source, origin);
    const target = resolveDocumentReferenceTarget(source, baseManifest.source.sha256, {
      kind: "table",
      number: "6.1.1-2",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const primaryTableRecords = target.evidence.map((record) => {
      const {
        registered_dependency: _registeredDependency,
        table_row_kind: _tableRowKind,
        table_fragment_id: _tableFragmentId,
        table_id: _tableId,
        table_alias_ids: _tableAliasIds,
        table_title: _tableTitle,
        row_index: _rowIndex,
        columns: _columns,
        cells: _cells,
        ...base
      } = record;
      return {
        ...base,
        role: "context" as const,
        requires_disposition: true,
        evidence_scope: "primary" as const,
      };
    });
    const { evidence_fingerprint: _fingerprint, ...basePayload } = baseManifest;
    const payload = {
      ...basePayload,
      evidence: [...baseManifest.evidence, ...primaryTableRecords],
    };
    const seededManifest: EvidenceManifest = {
      ...payload,
      evidence_fingerprint: sha256Json(payload),
    };
    const workspace = await RevisionWorkspace.createFromEvidence(
      await tempRoot("reference-primary-evidence-enrichment"),
      seededManifest.job_id,
      seededManifest.target_id,
      { manifest: seededManifest, markdown: Buffer.from(source) },
    );
    const controller = await ToolController.create(workspace);
    const originSpanId = (await workspace.readSourceSpanRegistry()).spans.find((span) =>
      span.evidence_id === baseManifest.evidence[0]!.evidence_id
    )!.span_id;
    expect(await controller.dispatch("resolve_document_reference", {
      origin_span_id: originSpanId,
      raw_reference: "表 6.1.1-2",
      target: { kind: "table", number: "6.1.1-2" },
      relation: "minimum_clearance_table",
    })).toMatchObject({ ok: true });
    const persisted = await workspace.readEvidenceManifest();
    const enriched = persisted.evidence.find((record) =>
      record.evidence_id === target.evidence[0]!.evidence_id
    );
    expect(enriched).toMatchObject({
      role: target.evidence[0]!.role,
      evidence_scope: "primary",
      requires_disposition: true,
      registered_dependency: true,
      table_id: "6.1.1-2",
    });
  });
});


describe("reference recovery source scope", () => {
  test("a missing local appendix does not rule out a governing external source", async () => {
    const header = "验收依据：《合成验收标准》XQ R34-2002。";
    const origin = "2.1.1 构件检验和评定应按附录Z进行。";
    const markdown = header + "\n" + origin;
    const manifest = manifestFor(markdown, [header, origin]);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("source-scope-recovery"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
    const controller = await ToolController.create(workspace);
    controller.externalSourceWorkflow = { lookup: async () => undefined, require: async () => { throw new Error("read-only feedback must not request a file"); } };
    const originSpan = (await workspace.readSourceSpanRegistry()).spans.find(span => span.evidence_id === manifest.evidence.find(row => row.text === origin)!.evidence_id)!;
    const missing = await controller.dispatch("resolve_document_reference", { origin_span_id: originSpan.span_id, raw_reference: "附录Z", target: { kind: "appendix", number: "Z" }, relation: "合成方法引用" });
    expect(missing).toMatchObject({ ok: false, error: "target_not_found", lookup_scope: { source_id: manifest.source.sha256 }, next_tool: "open_evidence", required_tools: expect.arrayContaining(["resolve_external_standard_reference"]) });
    expect(missing.instruction).not.toContain("不是外部资料缺失");
    expect(missing.instruction).toContain("上位");
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const report = await controller.dispatch("report_target_blocker", { kind: "ambiguous_source", evidence_span_ids: [missing.reference_literal_span_id], affected_selector_paths: ["/items/component/sampling"], explanation: "当前文件不存在附录正文，需核对其来源。" });
    expect(report).toMatchObject({ ok: false, error: "ambiguous_source_requires_selector_disambiguation", terminal: false, budget_consumed: false, actual: { unresolved_references: [expect.objectContaining({ occurrence_id: missing.occurrence_id, status: "target_not_found" })] }, writable_paths: ["/items"], affected_selector_paths: ["/items/component/sampling"], next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" }, required_tools: expect.arrayContaining(["resolve_external_standard_reference"]) });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(1);
  });

  test("context refreshes external readiness without resolving, reading or approving its body", async () => {
    const origin = "2.1.1 构件应符合《合成标准》XQ R34-2002的规定。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("external-readiness"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
    const controller = await ToolController.create(workspace);
    const placeholder = await controller.dispatch("resolve_external_standard_reference", { origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id, raw_reference: "《合成标准》XQ R34-2002", standard_no: "XQ R34-2002", relation: "合成要求" });
    let ready = false;
    const body = "XQ R34-2002\n# 1 合成正文\n1.1.1 构件应符合设计要求。";
    controller.externalSourceWorkflow = { lookup: async () => ready ? { standard_no: "XQ R34-2002", markdown: body, markdown_sha256: sha256Text(body) } : undefined, require: async () => { throw new Error("context must not pause the job"); } };
    const manifestBefore = await readFile(workspace.evidenceManifestPath, "utf8");
    const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
    const missing = await controller.dispatch("get_target_context", { cursor: 0, limit: 1 });
    expect(missing.external_reference_sources).toEqual([expect.objectContaining({ occurrence_id: placeholder.occurrence_id, standard_no: "XQ R34-2002", source_status: "unavailable", occurrence_status: "target_not_found" })]);
    ready = true;
    const available = await controller.dispatch("get_target_context", { cursor: 0, limit: 1 });
    expect(available).toMatchObject({ context_page_already_returned: true, external_reference_sources: [expect.objectContaining({ occurrence_id: placeholder.occurrence_id, source_status: "ready", occurrence_status: "target_not_found", next_tool: "resolve_external_standard_reference" })] });
    expect(await readFile(workspace.evidenceManifestPath, "utf8")).toBe(manifestBefore);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    expect((await workspace.readState()).opened_evidence_ids ?? []).toEqual([]);
    expect(available.resource_tools).toContain("resolve_external_standard_reference");
  });
});


describe("ready external source target failures", () => {
  async function scenario() {
    const origin = "2.1.1 构件应符合《合成标准》XQ R34-2002的规定。";
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot("external-target-feedback"), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
    const controller = await ToolController.create(workspace);
    const markdown = "XQ R34-2002\n# 1 合成要求\n1.1.1 构件应符合设计要求。";
    controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: "XQ R34-2002", markdown, markdown_sha256: sha256Text(markdown) }), require: async () => { throw new Error("ready source must not request another file"); } };
    const input = { origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id, raw_reference: "《合成标准》XQ R34-2002", standard_no: "XQ R34-2002", relation: "合成正文依赖", usage: "content_required", dependent_fields: ["requirement"], reason: "原文需要完整标准正文。" };
    return { workspace, controller, input };
  }
  test.each(["clause", "section"] as const)("rejects a placeholder %s number before persisting an occurrence", async kind => {
    const { workspace, controller, input } = await scenario();
    const before = await readFile(workspace.evidenceManifestPath, "utf8");
    const bad = await controller.dispatch("resolve_external_standard_reference", { ...input, target: { kind, number: "standard" } });
    expect(bad).toMatchObject({ ok: false, error: "invalid_external_standard_target", budget_consumed: false, actual: { target: { kind, number: "standard" } }, writable_paths: ["/target"], next_tool: "resolve_external_standard_reference" });
    expect(await readFile(workspace.evidenceManifestPath, "utf8")).toBe(before);
  });
  test("a ready document with a missing target returns a repair failure, then whole-document retry supersedes the missing occurrence", async () => {
    const { workspace, controller, input } = await scenario();
    const selectorBefore = await readFile(workspace.workingSelectorPath, "utf8");
    const missing = await controller.dispatch("resolve_external_standard_reference", { ...input, target: { kind: "clause", number: "9.9.9" } });
    expect(missing).toMatchObject({ ok: false, error: "target_not_found", source_available: true, content_available: false, source_status: "ready", next_tool: "resolve_external_standard_reference", writable_paths: ["/target"] });
    expect(missing.instruction).not.toContain("外部正文尚未接入");
    expect((await workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(1);
    const resolved = await controller.dispatch("resolve_external_standard_reference", { ...input,
      content_scope: { mode: "whole_standard", reason: "此中性用例明确验证完整标准正文接入与旧缺失回执升级。" } });
    expect(resolved).toMatchObject({ ok: true, content_available: true, superseded_occurrence_ids: [missing.occurrence_id] });
    expect(resolved.target_evidence_ids).not.toEqual([]);
    const current = await workspace.readEvidenceManifest();
    expect(current.reference_occurrences).toHaveLength(1);
    expect(current.reference_occurrences[0]!.status).toBe("resolved");
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorBefore);
    expect((await workspace.readState()).opened_evidence_ids ?? []).toEqual([]);
  });
});


test('a regional-series external code passes exact citation validation without granting source reads', async () => {
  const origin = '2.1.1 构件应符合《合成标准》ZZ12 / T — 345 — 2001的规定。';
  const manifest = manifestFor(origin, origin);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot('regional-external-citation'), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
  const controller = await ToolController.create(workspace);
  const markdown = 'ZZ12/T-345-2001\n# 1 合成要求\n1.1.1 构件应符合设计要求。';
  controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: 'ZZ12/T-345-2001', markdown, markdown_sha256: sha256Text(markdown) }), require: async () => { throw new Error('ready source must not wait'); } };
  const out = await controller.dispatch('resolve_external_standard_reference', { origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id, raw_reference: '《合成标准》ZZ12 / T — 345 — 2001', standard_no: 'ZZ12/T-345-2001', relation: '合成判据', usage: 'content_required', dependent_fields: ['requirement'], reason: '原文需要外部判据。', content_scope: { mode: 'whole_standard', reason: '完整接入中性正文以检查区域编号的身份校验与读取边界。' } });
  expect(out, JSON.stringify(out)).toMatchObject({ ok: true, content_available: true });
  expect(out.target_evidence_ids).not.toEqual([]);
  expect((await workspace.readState()).opened_evidence_ids ?? []).toEqual([]);
});


test('unchanged source does not make an old reference-tool failure current after harness deployment', async () => {
  const origin = '2.1.1 合成构件应符合设计要求。';
  const manifest = manifestFor(origin, origin);
  const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot('tool-observation-freshness'), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
  const controller = await ToolController.create(workspace);
  expect(await controller.dispatch('save_target_investigation', { summary: '合成工具曾失败，来源调查保留。', evidence_ids: [], next_steps: '取得当前工具回条再判断。' })).toMatchObject({ ok: true });
  const path = join(workspace.root, 'investigation-checkpoint.json');
  const checkpoint = JSON.parse(await readFile(path, 'utf8'));
  expect(checkpoint.reference_tool_contract_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  const current = await controller.dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(current.reference_tool_recovery).toMatchObject({ status: 'same_implementation', current_fingerprint: checkpoint.reference_tool_contract_fingerprint });
  const selectorBefore = await readFile(workspace.workingSelectorPath, 'utf8');
  const manifestBefore = await readFile(workspace.evidenceManifestPath, 'utf8');
  await atomicWriteJson(path, { ...checkpoint, reference_tool_contract_fingerprint: 'older-implementation' });
  const changed = await controller.dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(changed.reference_tool_recovery).toMatchObject({ status: 'implementation_changed', recorded_fingerprint: 'older-implementation' });
  expect(changed.reference_tool_recovery.instruction).toContain('重新调用');
  delete checkpoint.reference_tool_contract_fingerprint;
  await atomicWriteJson(path, checkpoint);
  const legacy = await (await ToolController.create(workspace)).dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(legacy.reference_tool_recovery).toMatchObject({ status: 'implementation_unknown' });
  expect(legacy.investigation_checkpoint?.stale).not.toBe(true);
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(selectorBefore);
  expect(await readFile(workspace.evidenceManifestPath, 'utf8')).toBe(manifestBefore);
  expect((await workspace.readState()).opened_evidence_ids ?? []).toEqual([]);
});


describe('whole external document provenance', () => {
  async function scenario() {
    const origin = '2.1.1 构件应符合《合成标准》XQ 902-2001的规定。';
    const manifest = manifestFor(origin, origin);
    const workspace = await RevisionWorkspace.createFromEvidence(await tempRoot('external-reference-provenance'), manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
    const controller = await ToolController.create(workspace);
    const markdown = 'XQ 902-2001\n# 1 合成要求\n1.1.1 构件应符合设计要求。';
    const document = { standard_no: 'XQ 902-2001', markdown, markdown_sha256: sha256Text(markdown) };
    const workflow = { lookup: async () => document, require: async () => { throw new Error('document exists'); } };
    controller.externalSourceWorkflow = workflow;
    await controller.dispatch('resolve_external_standard_reference', { origin_span_id: (await workspace.readSourceSpanRegistry()).spans[0]!.span_id, raw_reference: '《合成标准》XQ 902-2001', standard_no: 'XQ 902-2001', relation: '合成判据', usage: 'content_required', dependent_fields: ['requirement'], reason: '原文需要外部正文。', content_scope: { mode: 'whole_standard', reason: '此中性测试专门验证整本标准的来源元数据与恢复，不选择子范围。' } });
    return { workspace, controller, manifest, document, workflow };
  }
  test('whole-document registration marks new rows as reference dependencies and preserves prepared primary rows', async () => {
    const { workspace, manifest } = await scenario();
    const registered = await workspace.readEvidenceManifest();
    expect(registered.evidence.slice(0, manifest.evidence.length)).toEqual(manifest.evidence);
    expect(registered.evidence.slice(manifest.evidence.length)).not.toEqual([]);
    for (const row of registered.evidence.slice(manifest.evidence.length)) expect(row).toMatchObject({ registered_dependency: true, evidence_scope: 'reference', requires_disposition: false });
    expect(persistedManifestResumeMismatch(registered, manifest)).toBeNull();
  });
  test('legacy repair requires exact registered external source identity and leaves selectors, spans and primary obligations intact', async () => {
    const { workspace, manifest, workflow, document } = await scenario();
    const registered = await workspace.readEvidenceManifest();
    const legacy = structuredClone(registered);
    for (const row of legacy.evidence.slice(manifest.evidence.length)) { delete row.registered_dependency; row.requires_disposition = true; row.evidence_scope = 'primary'; }
    const { evidence_fingerprint: old, ...payload } = legacy;
    legacy.evidence_fingerprint = sha256Json(payload);
    await chmod(workspace.evidenceManifestPath, 0o644);
    await atomicWriteJson(workspace.evidenceManifestPath, legacy);
    const registry = await workspace.readSourceSpanRegistry();
    await atomicWriteJson(workspace.sourceSpanRegistryPath, { ...registry, source_fingerprint: legacy.evidence_fingerprint });
    const selector = await readFile(workspace.workingSelectorPath, 'utf8');
    const gate = (candidate: EvidenceManifest) => persistedManifestResumeMismatch(candidate, manifest) === null;
    const wrong = await workspace.restoreExternalReferenceProvenance(manifest, { ...workflow, lookup: async () => ({ ...document, markdown: document.markdown + '篡改', markdown_sha256: document.markdown_sha256 }) }, gate);
    expect(wrong).toEqual(legacy);
    const refused = await workspace.restoreExternalReferenceProvenance(manifest, workflow, () => false);
    expect(refused).toEqual(legacy);
    expect((await workspace.readSourceSpanRegistry()).source_fingerprint).toBe(legacy.evidence_fingerprint);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selector);
    // Simulate interruption after the registry update but before manifest publication.
    await atomicWriteJson(workspace.sourceSpanRegistryPath, { ...registry, source_fingerprint: registered.evidence_fingerprint });
    const repaired = await workspace.restoreExternalReferenceProvenance(manifest, workflow, gate);
    expect(persistedManifestResumeMismatch(repaired, manifest)).toBeNull();
    expect(repaired.evidence.slice(0, manifest.evidence.length)).toEqual(manifest.evidence);
    expect(repaired.evidence.map(row => [row.evidence_id, row.text, row.locator, row.text_sha256])).toEqual(legacy.evidence.map(row => [row.evidence_id, row.text, row.locator, row.text_sha256]));
    expect((await workspace.readSourceSpanRegistry()).spans).toEqual(registry.spans);
    expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(selector);
    expect((await workspace.readState()).validation_attempts).toBe(0);
    expect((await workspace.readState()).opened_evidence_ids ?? []).toEqual([]);
  });
});
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
