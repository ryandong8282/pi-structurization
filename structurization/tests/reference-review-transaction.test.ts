import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../src/atomic.js";
import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { CoverageReviewController, coverageFindingRoute, readSealedCoverageReview } from "../src/coverage-review.js";
import { documentReferenceTargetReadIdentity, resolveDocumentReferenceTarget } from "../src/document-reference.js";
import { readInlineReferenceEvidencePage } from "../src/reference-analysis.js";
import { initialTargetSelectorPlan, targetSelectorFingerprint } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(number = "5", withExistingDependency = false) {
  const text = `7.10.6 立柱桩应符合本标准第${number}章的规定；隔离措施和钢支撑轴线位置应逐项检验。`;
  const markdown = `# 5 基础工程\n# 5.1 一般规定\n5.1.1 立柱桩承载力应符合设计要求。\n# 6 特殊土地基\n6.0.1 后章哨兵。\n# 7 基坑支护\n${text}`;
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "reference-review", target_id: "support",
    source: { adapter: "document-domain-agent/v1" as const, file_name: "source.md", sha256: sha256Text(markdown), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: "markdown-target-scope/v1" as const, mode: "agent_discovered" as const,
      target_id: "support", source_line_count: 7, selected_start_line: 7, selected_end_exclusive_line: 8,
      selected_heading: "内支撑", selection_reason: "原始目标", selected_atom_ids: ["support:origin"],
      target_evidence_fragments: [{ atom_id: "support:origin", text }], candidates: [] },
    evidence: [{ evidence_id: "support:origin", kind: "paragraph" as const, role: "supporting_clause" as const,
      locator: "line:7", text, text_sha256: sha256Text(text), requires_disposition: true, evidence_scope: "primary" as const }] as EvidenceManifest["evidence"],
    table_fragments: [], reference_occurrences: [],
  };
  if (withExistingDependency) {
    const target = resolveDocumentReferenceTarget(markdown, payload.source.sha256, { kind: "section", number: "5" });
    if (target.ok) payload.evidence.push(...target.evidence.map(({ registered_dependency: _flag, ...record }) => record));
  }
  const manifest: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
  const root = await mkdtemp(join(tmpdir(), "reference-review-")); roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  const originSpan = (await workspace.readSourceSpanRegistry()).spans.find((span) => span.evidence_id === "support:origin")!.span_id;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "support", name: "内支撑检验批", scope_span_ids: [originSpan], reason: "当前目标" });
  selectors.items.push({ key: "support", lot_key: "support", name: "内支撑质量", category: "一般项目",
    criterion_span_ids: [originSpan], continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [originSpan], separator: "", reason: "对象" },
      requirement: { composition: "verbatim", span_ids: [originSpan], separator: "", reason: "原文" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给出" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给出" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给出" },
    }, table: null, inspection_data_type: "review", inspection_data_type_reason: "按原文核对", inspection_data_type_span_ids: [originSpan],
    sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "无抽样规定", confidence: 1 }, reason: "原始候选，仍需独立审核" });
  const controller = await ToolController.create(workspace);
  await controller.dispatch("open_evidence", { evidence_id: "support:origin" });
  const submitted = await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
  const compiled = await controller.dispatch("compile_target_selectors", {});
  expect(compiled).toMatchObject({ ok: true });
  const fingerprint = String(compiled.fingerprint);
  const plan = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), manifest).plan!;
  const review = await CoverageReviewController.create(workspace, fingerprint);
  const request = { origin_span_id: originSpan, raw_reference: `本标准第${number}章`, target: { kind: "section", number }, relation: "立柱桩质量依据" };
  const findings = ["隔离措施", "钢支撑轴线位置"].map((name, index) => ({ finding_id: `gap:${index}`, finding_type: "semantic_coverage_gap",
    evidence_id: "support:origin", exact_fragment: text, affected_item_ids: [plan.acceptance_items[0]!.item_id], description: `${name}未独立列项`, reason: "不得因引用登记而丢失待修项" }));
  const draft = { status: "repair", summary: "两项漏项及引用需要修复", finding_upserts: findings,
    semantic_coverage_upserts: [{ coverage_id: "coverage:support", disposition: "acceptance_item", judgment_id: "judgment:support",
      item_ids: [plan.acceptance_items[0]!.item_id], evidence_bindings: [{ evidence_id: "support:origin", exact_fragment: text }], reason: "审核原候选，缺陷另记" }] };
  return { root, workspace, controller, review, manifest, fingerprint, request, draft, selectors, plan };
}

describe("chapter reference boundaries", () => {
  test("chapters are structural headings, not lists, TOC entries or commentary", () => {
    const source = ["# 目次 [PDF p.1]", "# 5 基础工程", "5.1 一般规定 …… (3)", "# 6 后章", "6.1 一般规定 …… (6)",
      "# 5 基础工程 [PDF p.3]", "# 5.1 一般规定", "5.1.1 正式条文。", "1 普通列表", "# 2 被误升为标题的列表", "5.1.2 数值 10",
      "# 6 后章", "6.0.1 后章哨兵。", "# 附录 A 试验", "A.0.1 附录正文", "# 条文说明", "# 5 基础工程", "5.1.1 说明哨兵。"].join("\n");
    const chapter = resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "section", number: "5" });
    expect(chapter).toMatchObject({ ok: true, selected_candidate: { start_line: 6, end_exclusive_line: 12 } });
    if (!chapter.ok) return;
    expect(chapter.evidence.map((entry) => entry.text).join("\n")).not.toMatch(/哨兵|……/);
    expect(chapter.evidence.some((entry) => entry.text.includes("数值 10"))).toBe(true);
    expect(chapter.evidence.every((entry) => !entry.requires_disposition && entry.evidence_scope === "reference")).toBe(true);
    expect(resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "section", number: "2" })).toMatchObject({ ok: false });
    expect(resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "section", number: "6" })).toMatchObject({ ok: true, selected_candidate: { end_exclusive_line: 14 } });
  });

  test("last section stops at normative tail; Markdown clause headings work", () => {
    const source = "# 12 施工\n# 12.1 检验\n# 12.1.1 正文\n1 款一\n# 条文说明\n12.1.1 说明哨兵";
    for (const target of [{ kind: "section", number: "12" }, { kind: "section", number: "12.1" }, { kind: "clause", number: "12.1.1" }] as const) {
      expect(resolveDocumentReferenceTarget(source, sha256Text(source), target)).toMatchObject({ ok: true, selected_candidate: { end_exclusive_line: 5 } });
    }
    const unnumberedNext = "# 8 施工\n8.0.1 正文\n# 9 验收\n未编号正文";
    expect(resolveDocumentReferenceTarget(unnumberedNext, sha256Text(unnumberedNext), { kind: "section", number: "8" }))
      .toMatchObject({ ok: true, selected_candidate: { end_exclusive_line: 3 } });
  });
});

describe("reference observations do not mutate the reviewed candidate", () => {
  test("supplementary scope omissions can use the actual note defect field", async () => {
    const f = await fixture();
    await f.review.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    const draft = { ...f.draft, finding_upserts: f.draft.finding_upserts.map(finding => ({ ...finding, defect_field: "note", description: "Applicable lot-basis context is absent from the supported note field." })) };
    expect(await f.review.dispatch("stage_coverage_review_draft", draft)).toMatchObject({ validation: { ok: true } });
    expect(await f.review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
    const sealed = await readSealedCoverageReview(f.workspace, f.fingerprint, f.manifest);
    expect(sealed?.findings.every(finding => finding.defect_field === "note")).toBe(true);
  });

  test("coverage seal reports both its inline-read gate and isolated-reference gate", async () => {
    const f = await fixture();
    const inlineReceipt = await f.review.dispatch("resolve_document_reference", f.request);
    expect(inlineReceipt).toMatchObject({ ok: true, analysis_mode: "inline" });
    const firstObserved = await f.review.referenceEvidence();
    const inlineOccurrence = firstObserved.reference_occurrences.find((entry) =>
      entry.occurrence_id === inlineReceipt.occurrence_id
    )!;
    expect(await readInlineReferenceEvidencePage(
      f.workspace, firstObserved, String(inlineReceipt.target_key), 0, 24, "target",
    )).toMatchObject({ ok: true, done: true });

    const isolatedOccurrence = {
      ...structuredClone(inlineOccurrence),
      occurrence_id: "reference:coverage-isolated-gate",
      raw_reference: "中性隔离引用",
      target_address: {
        ...inlineOccurrence.target_address,
        locator: `${inlineOccurrence.target_address.locator}:isolated-gate`,
      },
    };
    await f.workspace.registerDocumentReferenceDependency([], isolatedOccurrence, true);
    const isolatedTargetKey = documentReferenceTargetReadIdentity(isolatedOccurrence).target_key;
    await f.workspace.updateState((state) => {
      state.reference_analysis_modes = {
        ...(state.reference_analysis_modes ?? {}),
        [`coverage:${isolatedTargetKey}`]: {
          analysis_mode: "isolated",
          target_text_utf8_bytes: 1,
          estimated_compact_page_count: 1,
          evidence_count: isolatedOccurrence.target_evidence_ids.length,
          mode_reason: "neutral_test_fixture",
        },
      };
    });

    await f.review.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    expect(await f.review.dispatch("stage_coverage_review_draft", f.draft))
      .toMatchObject({ validation: { ok: true } });
    const resumedReview = await CoverageReviewController.create(f.workspace, f.fingerprint);
    const blocked = await resumedReview.finalizeMechanicallyReady();
    expect(blocked).toMatchObject({
      ok: false,
      error: "coverage_reference_facts_incomplete",
      next_tool: "list_coverage_reference_targets",
      next_tool_arguments: { cursor: 0, limit: 100 },
      candidate_read_tools: expect.arrayContaining([
        "list_coverage_reference_targets",
        "read_document_reference_evidence",
        "read_reference_facts",
      ]),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "inline_reference_read_incomplete" }),
        expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
      ]),
    });
    await f.workspace.updateState((state) => {
      state.last_valid_fingerprint = "stale-candidate";
    });
    const staleSeal = await resumedReview.finalizeMechanicallyReady();
    expect(staleSeal).toMatchObject({
      ok: false,
      error: "coverage_review_candidate_changed",
      terminal: true,
      budget_consumed: false,
      required_action: "rebuild_coverage_controller_for_current_candidate",
      instruction: expect.stringMatching(/上层编排.*当前候选.*新建.*Coverage.*Controller/u),
    });
    expect(staleSeal).not.toHaveProperty("next_tool");
    expect(await resumedReview.dispatch("list_coverage_reference_targets", { cursor: 0, limit: 100 }))
      .toMatchObject({
        ok: false,
        error: "coverage_review_candidate_changed",
        terminal: true,
        budget_consumed: false,
        required_action: "rebuild_coverage_controller_for_current_candidate",
      });
  });

  test("full-source navigation and persisted observations cannot bypass later isolated reference routing", async () => {
    const f = await fixture();
    const search = await f.review.dispatch("search_review_document", { query: "承载力" });
    const atomId = (search.matches as Array<{atom_id: string}>)[0]!.atom_id;
    const opened = await f.review.dispatch("open_review_document", { atom_id: atomId });
    const observationId = (opened.evidence as {evidence_id: string}).evidence_id;
    const receipt = await f.review.dispatch("resolve_document_reference", f.request);
    const state = await f.workspace.readState();
    const key = `coverage:${receipt.target_key}`;
    state.reference_analysis_modes![key] = { ...state.reference_analysis_modes![key]!, analysis_mode: "isolated" };
    await f.workspace.writeState(state);
    const beforeBatchReviewState = await f.review.readState();
    const beforeBatchRevisionState = await f.workspace.readState();
    const beforeBatchRegistry = await f.workspace.readSourceSpanRegistry();
    const batch = await f.review.dispatch("batch_open_review_evidence", {
      evidence_ids: ["support:origin", observationId],
    });
    expect(batch).toMatchObject({
      ok: false,
      error: "batch_review_evidence_contains_isolated_reference",
      target_key: receipt.target_key,
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: receipt.target_key },
      openable_evidence_ids: ["support:origin"],
      durable_mutation: false,
    });
    expect(batch.routed_references).toContainEqual(expect.objectContaining({
      target_key: receipt.target_key,
      evidence_ids: [observationId],
      access_mode: "isolated_reference",
      read_tool: "read_reference_facts",
      open_review_evidence_allowed: false,
    }));
    expect((await f.review.readState()).opened_evidence_ids).toEqual(beforeBatchReviewState.opened_evidence_ids);
    expect((await f.workspace.readState()).reference_analysis_modes).toEqual(beforeBatchRevisionState.reference_analysis_modes);
    expect(await f.workspace.readSourceSpanRegistry()).toEqual(beforeBatchRegistry);
    const protectedSearch = await f.review.dispatch("search_review_document", { query: "承载力" });
    expect(protectedSearch).toMatchObject({ ok: true, matches: [], total_match_resources: 0 });
    expect(JSON.stringify(protectedSearch)).not.toContain(String(receipt.target_key));
    expect(JSON.stringify(protectedSearch)).not.toContain("承载力");
    expect(await f.review.dispatch("open_review_document", { atom_id: atomId })).toMatchObject({ ok: false, error: "coverage_document_isolated_reference" });
    expect(await f.review.dispatch("open_review_evidence", { evidence_id: observationId })).toMatchObject({
      ok: false,
      error: "isolated_reference_body_access_forbidden",
      target_key: receipt.target_key,
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: receipt.target_key },
      durable_mutation: false,
    });
    expect(await f.review.dispatch("locate_review_span", { evidence_id: observationId, quote: "承载力" })).toMatchObject({ ok: false, error: "isolated_reference_body_access_forbidden" });
    const evidenceSearch = await f.review.dispatch("search_review_evidence", { query: "承载力" });
    expect(evidenceSearch).toMatchObject({ ok: true, matches: [], total_match_resources: 0 });
    expect(JSON.stringify(evidenceSearch)).not.toContain(String(receipt.target_key));
    expect(JSON.stringify(evidenceSearch.matches)).not.toContain("承载力");
  });

  test("batch review evidence rejects unknown ids before opening valid entries", async () => {
    const f = await fixture();
    const beforeReviewState = await f.review.readState();
    const beforeRevisionState = await f.workspace.readState();
    const beforeRegistry = await f.workspace.readSourceSpanRegistry();
    const batch = await f.review.dispatch("batch_open_review_evidence", {
      evidence_ids: ["support:origin", "missing:evidence"],
    });
    expect(batch).toMatchObject({
      ok: false,
      error: "batch_review_evidence_not_found",
      unknown_evidence_ids: ["missing:evidence"],
      next_tool: "get_coverage_review_contract",
      tool_arguments: {},
      writable_parameters: ["evidence_ids"],
      durable_mutation: false,
    });
    expect((await f.review.readState()).opened_evidence_ids).toEqual(beforeReviewState.opened_evidence_ids);
    expect((await f.workspace.readState()).reference_analysis_modes).toEqual(beforeRevisionState.reference_analysis_modes);
    expect(await f.workspace.readSourceSpanRegistry()).toEqual(beforeRegistry);
  });

  test("neutral source reads allow approval; sealed reviews reject later observation writes", async () => {
    const f = await fixture();
    const search = await f.review.dispatch("search_review_document", {});
    const atomId = (search.matches as Array<{atom_id: string}>)[0]!.atom_id;
    expect(await f.review.dispatch("open_review_document", { atom_id: atomId })).toMatchObject({ ok: true, candidate_evidence_unchanged: true });
    await f.review.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    expect(await f.review.dispatch("stage_coverage_review_draft", { ...f.draft, status: "approved", finding_upserts: [] })).toMatchObject({ validation: { ok: true } });
    expect(await f.review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "approved" });
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
    expect((await f.review.dispatch("open_review_document", { atom_id: atomId })).ok).toBe(false);
  });

  test("a finding-bound repair adopts independently discovered source and preserves findings", async () => {
    const f = await fixture();
    const search = await f.review.dispatch("search_review_document", { query: "承载力" });
    const atomId = (search.matches as Array<{atom_id: string}>)[0]!.atom_id;
    const opened = await f.review.dispatch("open_review_document", { atom_id: atomId });
    expect(opened.ok).toBe(true);
    const observed = await f.review.referenceEvidence();
    expect(observed.reference_occurrences).toEqual([]); // navigation never fabricates a literal reference
    await f.review.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    expect(await f.review.dispatch("stage_coverage_review_draft", f.draft)).toMatchObject({ validation: { ok: true } });
    expect(await f.review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
    await f.controller.beginCoverageRepair(f.fingerprint);
    expect(await f.workspace.readEvidenceManifest()).toEqual(observed);
    expect(await f.workspace.readState()).toMatchObject({ last_valid_fingerprint: "", repair: { coverage_finding_ids: ["gap:0", "gap:1"] } });
    await ToolController.create(f.workspace);
    expect(await f.workspace.readEvidenceManifest()).toEqual(observed);
  });

  test("existing evidence enrichment stays outside the candidate; a formerly missing pointer can resolve", async () => {
    const f = await fixture("5", true);
    const receipt = await f.review.dispatch("resolve_document_reference", f.request);
    const observed = await f.review.referenceEvidence();
    expect(observed.evidence).toHaveLength(f.manifest.evidence.length);
    expect(observed.evidence.some((entry) => entry.registered_dependency)).toBe(true);
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
    expect(await f.review.dispatch("resolve_document_reference", f.request)).toMatchObject({ occurrence_id: receipt.occurrence_id, idempotent: true });
    expect(await f.review.referenceEvidence()).toEqual(observed);
    // A legacy unresolved observation is input, never a reason to retain the
    // stale failure after the locator has actually found the same address.
    const occurrence = observed.reference_occurrences[0]!;
    const { evidence_fingerprint: _hash, ...payload } = observed;
    payload.reference_occurrences = [{ ...occurrence, status: "target_not_found", required: false, target_evidence_ids: [] }];
    await atomicWriteJson(join(f.review.root, "reference-observations.json"), { ...payload, evidence_fingerprint: sha256Json(payload) });
    expect(await f.review.dispatch("resolve_document_reference", f.request)).toMatchObject({ ok: true, occurrence_id: receipt.occurrence_id });
    expect((await f.review.referenceEvidence()).reference_occurrences).toEqual([occurrence]);
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
  });

  test("missing internal reference stays traceable, idempotent and cannot approve", async () => {
    const f = await fixture("99");
    const before = await f.workspace.readState();
    const first = await f.review.dispatch("resolve_document_reference", f.request);
    expect(first).toMatchObject({ ok: false, error: "target_not_found", candidate_evidence_unchanged: true });
    expect(first).toMatchObject({ lookup_scope: { source_id: f.manifest.source.sha256, target: f.request.target }, next_tool: "open_evidence" });
    expect(first.instruction).toContain("不能确定引用属于内部还是外部");
    const resumed = await CoverageReviewController.create(f.workspace, f.fingerprint);
    expect(await resumed.dispatch("resolve_document_reference", { ...f.request, relation: "复查" })).toMatchObject({ occurrence_id: first.occurrence_id, idempotent: true });
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
    expect((await resumed.referenceEvidence()).reference_occurrences).toHaveLength(1);
    expect(await f.workspace.readState()).toMatchObject({ validation_attempts: before.validation_attempts, selector_protocol: before.selector_protocol });
    expect(validatePlanText(await readFile(f.workspace.lastValidPlanPath, "utf8"), f.manifest).ok).toBe(true);
    await resumed.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    const approved = await resumed.dispatch("stage_coverage_review_draft", { ...f.draft, status: "approved", finding_upserts: [] });
    expect(approved.validation).toMatchObject({ ok: false, budget_consumed: false, error: "coverage_reference_observation_requires_repair" });
    expect(await resumed.dispatch("stage_coverage_review_draft", f.draft)).toMatchObject({ validation: { ok: true } });
    expect(await resumed.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
    expect(await f.controller.dispatch("seal_validated_plan", { fingerprint: f.fingerprint })).toMatchObject({ ok: false, error: "domain_coverage_repair_required" });
  });

  test("explicit adoption preserves findings across resume, recompiles and requires re-review", async () => {
    const f = await fixture();
    // Real missing rows have no existing leaf to point at.
    f.draft.finding_upserts.forEach((finding) => { finding.affected_item_ids = []; });
    const before = await f.workspace.readState();
    const receipt = await f.review.dispatch("resolve_document_reference", f.request);
    expect(receipt).toMatchObject({ ok: true, candidate_evidence_unchanged: true });
    const observed = await f.review.referenceEvidence();
    expect(observed.evidence_fingerprint).not.toBe(f.manifest.evidence_fingerprint);
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
    await f.review.dispatch("read_document_reference_evidence", { target_key: receipt.target_key });
    await f.review.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    expect(await f.review.dispatch("stage_coverage_review_draft", f.draft)).toMatchObject({ validation: { ok: true } });
    expect(await f.review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
    const interrupted = vi.spyOn(f.workspace, "adoptReferenceObservations").mockRejectedValueOnce(new Error("simulated interruption after repair transition"));
    await expect(f.controller.beginCoverageRepair(f.fingerprint)).rejects.toThrow("simulated interruption");
    interrupted.mockRestore();
    expect(await f.workspace.readEvidenceManifest()).toEqual(f.manifest);
    // A restart completes the explicit transition; no query can do so.
    await ToolController.create(f.workspace);
    expect(await f.workspace.readEvidenceManifest()).toEqual(observed);
    expect(await f.workspace.readState()).toMatchObject({ last_valid_fingerprint: "", validation_attempts: before.validation_attempts,
      selector_protocol: before.selector_protocol, repair: { repair_source: "coverage", coverage_finding_ids: ["gap:0", "gap:1"] } });
    const resumed = await ToolController.create(f.workspace);
    expect(await readSealedCoverageReview(f.workspace, f.fingerprint, observed)).toMatchObject({ status: "repair", findings: f.draft.finding_upserts });
    const rejected = await resumed.dispatch("commit_target_selector_draft", { draft_fingerprint: targetSelectorFingerprint(f.selectors) });
    expect(rejected.ok).toBe(false); // new pointer has no selector receipt yet
    expect((await f.workspace.readState()).selector_protocol).toMatchObject({ corrections: 0, coverage_repairs: 0 });
    const occurrence = observed.reference_occurrences[0]!;
    const registry = await f.workspace.readSourceSpanRegistry();
    const targetSpan = registry.spans.find((span) => span.evidence_id === occurrence.target_evidence_ids[0])!;
    const quotedChapterSpans = registry.spans.filter(span => occurrence.target_evidence_ids.includes(span.evidence_id));
    const references = [{ key: "chapter", occurrence_id: occurrence.occurrence_id, anchor_span_ids: [String(receipt.reference_literal_span_id)],
      target_span_ids: quotedChapterSpans.map(span => span.span_id), action: "keep_reference", application_mode: "reference_only",
      component_dispositions: quotedChapterSpans.map(span => ({ component_span_ids: [span.span_id],
        decision: "not_applicable", item_keys: [], reason: "本次只保留引用文字；引用章的独立内容不导入本地验收项，复核遗漏仍由原 findings 保留。" })),
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "引用只保留要求字段。" },
      destinations: [{ item_key: "support", target_field: "requirement" }], reason: "保留引用；不会纳入整章项目" }];
    const stage = await resumed.dispatch("stage_target_selector_draft", { operation: "upsert", draft: { references } });
    expect(stage).toMatchObject({ ok: true });
    const targetReadRequired = await resumed.dispatch("commit_target_selector_draft", { draft_fingerprint: stage.draft_fingerprint });
    expect(targetReadRequired).toMatchObject({
      ok: false,
      error: "inline_reference_read_incomplete",
      selector_issues: [expect.objectContaining({ code: "inline_reference_read_incomplete" })],
    });
    expect(await resumed.dispatch("read_document_reference_evidence", { target_key: receipt.target_key }))
      .toMatchObject({ ok: true, done: true });
    expect(await f.workspace.readState()).toMatchObject({ selector_protocol: { corrections: 0, coverage_repairs: 0 },
      repair: { repair_source: "coverage", coverage_finding_ids: ["gap:0", "gap:1"] } });
    await f.workspace.markTerminal("failed", "offline simulated interruption");
    const recovered = await RevisionWorkspace.reviseFromTerminalFailure(f.root, f.manifest.job_id, f.manifest.target_id);
    const afterFailure = await ToolController.create(recovered);
    expect(await recovered.readEvidenceManifest()).toEqual(observed);
    expect(await recovered.readState()).toMatchObject({ selector_protocol: { submissions: 1, corrections: 0, coverage_repairs: 0 },
      repair: { repair_source: "coverage", coverage_finding_ids: ["gap:0", "gap:1"], coverage_review_fingerprint: f.fingerprint } });
    expect(await afterFailure.dispatch("read_coverage_review", {})).toMatchObject({ ok: true, review: { status: "repair" } });
    expect((await recovered.readReferenceObservations(f.fingerprint)).reference_occurrences).toEqual(observed.reference_occurrences);
    expect(afterFailure.selectorProviderPolicy().allowed_tools).toContain("list_reference_occurrences");
    expect(await afterFailure.dispatch("list_reference_occurrences", {})).toMatchObject({ ok: true });
    await afterFailure.dispatch("open_evidence", { evidence_id: targetSpan.evidence_id });
    const committed = await afterFailure.dispatch("commit_target_selector_draft", { draft_fingerprint: stage.draft_fingerprint });
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true, selector_transaction: "coverage_repair" });
    expect(await recovered.readState()).toMatchObject({ selector_protocol: { submissions: 1, corrections: 0, coverage_repairs: 1 },
      coverage_recheck: { source_plan_fingerprint: f.fingerprint, finding_ids: ["gap:0", "gap:1"] } });
    expect(await afterFailure.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint })).toMatchObject({ ok: false, error: "domain_coverage_review_required" });
    const nextReview = await CoverageReviewController.create(recovered, String(committed.fingerprint));
    await nextReview.dispatch("open_review_evidence", { evidence_id: "support:origin" });
    // The two real defect categories remain explicit blockers after recompile.
    expect(await nextReview.dispatch("stage_coverage_review_draft", f.draft)).toMatchObject({ validation: { ok: true } });
    expect(await nextReview.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
    expect(await afterFailure.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint })).toMatchObject({ ok: false, error: "domain_coverage_repair_required" });
    expect(await f.workspace.adoptReferenceObservations().catch(() => "closed")).toBe("closed");
  });
});

const replayRoot = process.env.PI_REFERENCE_REPLAY_ROOT;
// Optional read-only replay: set PI_REFERENCE_REPLAY_ROOT to the historical
// target's revisions directory. The synthetic tests above need no local job.
test.skipIf(!replayRoot)("real inner-support document: chapter 5 ends exactly before chapter 6", async () => {
  const source = await readFile(join(replayRoot!, "000001", "evidence", "source.md"), "utf8");
  const result = resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "section", number: "5" });
  expect(result).toMatchObject({ ok: true, selected_candidate: { start_line: 590, end_exclusive_line: 812 } });
  if (result.ok) {
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.other_candidates ?? []).toEqual([]);
    expect(result.evidence.every((record) => !record.requires_disposition && record.evidence_scope === "reference")).toBe(true);
  }
});

test.skipIf(!replayRoot)("historical fingerprint drift is reproduced in memory, without writing history", async () => {
  const first: EvidenceManifest = JSON.parse(await readFile(join(replayRoot!, "000001", "evidence", "evidence.json"), "utf8"));
  const second: EvidenceManifest = JSON.parse(await readFile(join(replayRoot!, "000002", "evidence", "evidence.json"), "utf8"));
  const { evidence_fingerprint: firstFingerprint, ...firstPayload } = first;
  expect(firstFingerprint).toBe("54d58ae9c98072468265f44e08146531a8e42f9ef7387f0792cf5f0165dfd1b5");
  expect(sha256Json({ ...firstPayload, reference_occurrences: [] })).toBe("c3e4f3e11944b1d113e15f78afb0bf8fb5c7582213e9e6f95e10187523b9d4a8");
  const { evidence_fingerprint: secondFingerprint, ...secondPayload } = second;
  expect(secondFingerprint).toBe("88caa5894e4bec3ba564cebdb4debc62cd5293cdc7aaa97c85be424f2c25ed2a");
  expect(first.evidence).toHaveLength(293);
  expect(second.evidence).toHaveLength(293);
  const oldRecords = new Map(first.evidence.map((entry) => [entry.evidence_id, entry]));
  const restored = second.evidence.map((entry) => {
    expect(entry.text).toBe(oldRecords.get(entry.evidence_id)!.text);
    const { registered_dependency: _flag, ...rest } = entry;
    return oldRecords.get(entry.evidence_id)!.registered_dependency ? { ...rest, registered_dependency: true } : rest;
  });
  expect(sha256Json({ ...secondPayload, evidence: restored, reference_occurrences: first.reference_occurrences })).toBe(firstFingerprint);
  const reviewRoot = join(replayRoot!, "000002", "coverage-review");
  const reviews = await Promise.all((await readdir(reviewRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    .map(async (entry) => JSON.parse(await readFile(join(reviewRoot, entry.name, "working.coverage-review.json"), "utf8"))));
  const repairReview = reviews.find((review) => review.status === "repair")!;
  expect(repairReview.findings.map((finding: { finding_id: string }) => finding.finding_id)).toEqual([
    "gap-7.10.4-isolation", "gap-7.10.5-axis",
  ]);
  expect(coverageFindingRoute(repairReview.findings)).toBe("repair");
});
