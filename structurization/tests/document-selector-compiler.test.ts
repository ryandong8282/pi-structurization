import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { prettyJson } from "../src/canonical.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { atomicWriteJson } from "../src/atomic.js";
import { runFullDocumentDiscovery, runFullBatch } from "../src/batch.js";
import {
  buildDocumentEvidence,
  createDocumentDiscoveryTools,
  DocumentDiscoveryController,
  DocumentDiscoveryWorkspace,
  validateDocumentTargetPlan,
} from "../src/document-discovery.js";
import {
  compileDocumentSelectors,
  DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA,
  DocumentSelectorCompileError,
  initialDocumentSelectorPlan,
} from "../src/document-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
} from "../src/source-span-registry.js";

function compileFixture(markdown: string, quote = "地基承载力应满足设计要求") {
  const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
  let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map((atom) => ({ source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
  const atom = evidence.atoms.find((candidate) => candidate.text.includes(quote))!;
  const located = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
  registry = located.registry;
  const selectors = initialDocumentSelectorPlan("job");
  selectors.targets.push({
    key: "foundation",
    group_key: "foundation-work",
    group_name: "地基工程",
    group_reason: "按被检工程实体归组",
    name: "地基验收",
    lot_basis_summary: "地基承载力满足设计要求",
    scope_span_ids: [located.spans[0]!.span_id],
    source_blocks: [{
      kind: "explicit_range",
      anchor_span_id: located.spans[0]!.span_id,
      start_span_id: located.spans[0]!.span_id,
      end_span_id: located.spans[0]!.span_id,
      reason: "无可靠标题时由 Agent 明确确认这段连续正文的起止位置",
    }],
    lot_basis_span_ids: [located.spans[0]!.span_id],
    reason: "可形成独立检验批",
  });
  selectors.dispositions = evidence.atoms.map((candidate) => ({
    atom_span_id: registry.spans.find((span) => span.atom_id === candidate.atom_id && span.start === 0 && span.end === candidate.text.length)!.span_id,
    disposition: candidate.atom_id === atom.atom_id ? "target" as const : "irrelevant" as const,
    target_keys: candidate.atom_id === atom.atom_id ? ["foundation"] : [],
    reason: candidate.atom_id === atom.atom_id ? "包含目标业务证据" : "本用例其余内容不形成业务目标",
  }));
  return { evidence, registry, selectors };
}

test("unreviewed atom receipts keep identities typed and expose all legal final dispositions without choosing one", async () => {
  const { evidence, registry, selectors } = compileFixture("## 地基\n\n地基承载力应满足设计要求");
  selectors.dispositions = [];
  const before = JSON.stringify({ selectors, registry });
  let rejected: DocumentSelectorCompileError | undefined;
  try { compileDocumentSelectors(selectors, registry, evidence, "job"); } catch (error) { rejected = error as DocumentSelectorCompileError; }
  expect(rejected).toBeInstanceOf(DocumentSelectorCompileError);
  const issue = rejected!.issues.find(issue => issue.code === "selector_atom_unreviewed")!;
  expect(issue.details).toMatchObject({ actual: { final_disposition_count: 0, full_atom_span_registered: true },
    expected: { final_disposition_count: 1, span_scope: "registered_complete_atom", allowed_final_dispositions: ["target", "context", "irrelevant"] },
    writable_paths: ["/dispositions"], writable_fields: ["atom_span_id", "disposition", "target_keys", "reason"],
    next_tool: "open_document_atom", next_tool_arguments: { atom_id: evidence.atoms[0]!.atom_id } });
  const root = resolve(`.codex-runlogs/unreviewed-receipt-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    const codec = await ModelSourceHandles.open(root);
    const publicIssue = await codec.encode(issue) as any;
    expect(JSON.stringify(publicIssue)).not.toMatch(/(?:span|atom):/u);
    expect(publicIssue.details.atom_id).toMatch(/^a\d+$/u);
    expect(publicIssue.details.atom_span_id).toMatch(/^s\d+$/u);
    expect(publicIssue.details.next_tool_arguments.atom_id).toBe(publicIssue.details.atom_id);
    expect(publicIssue.details.required_action).toContain("target/context/irrelevant");
    expect(publicIssue.details.required_action).toContain("target_keys");
    expect(await codec.decodeArguments({ ...publicIssue.details.next_tool_arguments, source_handle_scope: codec.scope }))
      .toEqual({ atom_id: evidence.atoms[0]!.atom_id });
    expect(await codec.decodeResponse({ ...publicIssue, source_handle_scope: codec.scope })).toEqual(issue);
    expect(JSON.stringify({ selectors, registry })).toBe(before);
  } finally {
    if (!resolve(root).startsWith(resolve(".codex-runlogs/unreviewed-receipt-"))) throw new Error("Unexpected test root");
    await rm(root, { recursive: true, force: true });
  }
});

describe("document selector compiler", () => {
  test("semantic reopening may demote a legacy synthetic target while preserving its archived seal", async () => {
    const root = resolve(".tmp-tests", `discovery-reclassify-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const markdownPath = join(root, "source.md");
      await writeFile(markdownPath, "检验批质量验收应包括主控项目和一般项目。", "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
      const registry = await workspace.readSourceSpanRegistry();
      const span = registry.spans[0]!.span_id;
      const selectors = initialDocumentSelectorPlan("job");
      selectors.targets = [{ key: "legacy-lot", group_key: "legacy", group_name: "通用验收", group_reason: "旧版分类", name: "检验批质量验收", lot_basis_summary: "按主控及一般项目验收", scope_span_ids: [span], lot_basis_span_ids: [span], source_blocks: [{ kind: "explicit_range", anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "整段旧版范围" }], reason: "旧模型误把通用检验批当具体对象" }];
      selectors.dispositions = [{ atom_span_id: span, disposition: "target", target_keys: ["legacy-lot"], reason: "旧版归类" }];
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      const author = await DocumentDiscoveryController.create(workspace);
      await author.dispatch("open_document_atom", { atom_id: author.evidence.atoms[0]!.atom_id });
      const candidate = await author.dispatch("compile_document_selectors", {});
      expect(await author.dispatch("submit_discovery_candidate", { fingerprint: candidate.fingerprint })).toMatchObject({ ok: true });
      const reviewer = await DocumentDiscoveryController.create(workspace, "review");
      await reviewer.dispatch("open_document_atom", { atom_id: author.evidence.atoms[0]!.atom_id });
      const reviewed = await reviewer.dispatch("compile_document_selectors", {});
      expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: true });
      const archive = await workspace.reopenForIndependentReview("核对通用层级与具体对象", "semantic_reclassification");
      expect(JSON.parse(await readFile(join(archive, "document-target-plan.json"), "utf8"))).toMatchObject({ targets: [expect.objectContaining({ name: "检验批质量验收" })] });
      await workspace.setReviewerRuntime({ kind: "pi-sdk", session_id: "reclassification", session_file: "reclassification.jsonl" });
      const patch = await reviewer.dispatch("patch_document_selectors", { operations: [
        { op: "remove", path: "/targets/0" },
        { op: "add", path: "/no_target_reason", value: "全文只说明通用检验批的项目分类，没有具体受检对象。" },
        { op: "add", path: "/contexts/-", value: { key: "rule", role: "governing_rule", name: "检验项目分类", span_ids: [span], reason: "适用于其他具体对象的通用规则" } },
        { op: "replace", path: "/dispositions/0", value: { atom_span_id: span, disposition: "context", target_keys: [], reason: "通用检验批分类" } },
      ] });
      expect(patch).toMatchObject({ ok: true, final_compile_ready: true });
      await reviewer.dispatch("open_document_atom", { atom_id: author.evidence.atoms[0]!.atom_id });
      const attemptsBeforeReview = (await workspace.readState()).reviewer_validation_attempts;
      expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({
        ok: false, error: "discovery_selector_review_reads_required", budget_consumed: false,
      });
      expect((await workspace.readState()).reviewer_validation_attempts).toBe(attemptsBeforeReview);
      expect(await reviewer.dispatch("read_document_selectors", { collection: "contexts", key: "rule", view: "full" }))
        .toMatchObject({ ok: true, rows: [{ key: "rule" }] });
      expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({
        ok: false, error: "discovery_semantic_review_incomplete", budget_consumed: false,
      });
      expect((await workspace.readState()).reviewer_validation_attempts).toBe(attemptsBeforeReview);
      expect(await reviewer.dispatch("record_discovery_review", { reviews: [{ collection: "contexts", key: "rule",
        verdict: "confirmed", source_span_ids: [span], reason: "已核对完整原文，本条为通用分类规则，没有具体受检对象。" }] }))
        .toMatchObject({ ok: true, saved_count: 1 });
      const revalidated = await reviewer.dispatch("compile_document_selectors", {});
      expect(revalidated, JSON.stringify(revalidated)).toMatchObject({ ok: true });
      const resealed = await reviewer.dispatch("seal_discovery_plan", { fingerprint: revalidated.fingerprint });
      expect(resealed, JSON.stringify(resealed)).toMatchObject({ ok: true, target_count: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("live zero-target discovery requires independent source reading and resumes its sealed outcome", async () => {
    const root = resolve(".tmp-tests", `discovery-no-scope-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const markdownPath = join(root, "source.md");
      await writeFile(markdownPath, "单位工程质量验收应由建设单位组织。", "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
      expect((await workspace.readState()).opened_atom_ids).toEqual([]);
      await workspace.setRuntime({ kind: "pi-sdk", session_id: "test-author", session_file: "test-author.jsonl" });
      const author = await DocumentDiscoveryController.create(workspace);
      const registry = await workspace.readSourceSpanRegistry();
      const selectors = initialDocumentSelectorPlan("job");
      selectors.no_target_reason = "全文仅规定验收组织责任，没有具体实物验收项目。";
      selectors.contexts = [{ key: "organization", role: "governing_rule", name: "验收组织", span_ids: [registry.spans[0]!.span_id], reason: "仅规定建设单位责任" }];
      selectors.dispositions = [{ atom_span_id: registry.spans[0]!.span_id, disposition: "context", target_keys: [], reason: "验收组织责任" }];
      await workspace.writeWorkingSelectors(prettyJson(selectors));
      expect(await author.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false });
      await author.dispatch("open_document_atom", { atom_id: author.evidence.atoms[0]!.atom_id });
      const validated = await author.dispatch("compile_document_selectors", {});
      expect(validated.ok).toBe(true);
      expect(await author.dispatch("submit_discovery_candidate", { fingerprint: validated.fingerprint })).toMatchObject({ ok: true, target_count: 0 });
      expect(await author.sealCandidateWithoutReview()).toMatchObject({ ok: false, error: "discovery_semantic_review_required" });
      const reviewer = await DocumentDiscoveryController.create(workspace, "review");
      expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false });
      await reviewer.dispatch("batch_open_document_atoms", { atom_ids: reviewer.evidence.atoms.map(atom => atom.atom_id) });
      const reviewed = await reviewer.dispatch("compile_document_selectors", {});
      expect(reviewed.ok).toBe(true);
      expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: true, target_count: 0 });
      expect(JSON.parse(await readFile(workspace.manifestPath, "utf8"))).toMatchObject({ outcome: "no_extractable_acceptance_scope", target_count: 0 });
      const resumed = await runFullDocumentDiscovery({ artifactRoot: root, jobId: "job", markdownPath, live: true, concurrency: 1, maxAttempts: 1 });
      expect(resumed.plan.no_target_reason).toBe(selectors.no_target_reason);
      expect(await readdir(join(root, "jobs/job"))).toEqual(["discovery"]);
      const batch = await runFullBatch({ artifactRoot: root, jobId: "job", markdownPath, live: true, concurrency: 1, maxAttempts: 1 });
      expect(batch).toMatchObject({ status: "passed", targets: [], discovery: { no_target_reason: selectors.no_target_reason } });
      expect(JSON.parse(await readFile(join(root, "jobs/job/result.json"), "utf8"))).toMatchObject({ outcome: "no_extractable_acceptance_scope", targets: [] });
      expect(await readdir(join(root, "jobs/job"))).not.toContain("targets");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("live semantic preflight rejects unproved candidates before closure, but preserves legacy reads", () => {
    const { evidence, registry, selectors } = compileFixture("地基承载力应满足设计要求。");
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).not.toThrow();
    selectors.dispositions = [];
    try {
      compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis: true });
      throw new Error("expected semantic rejection");
    } catch (error) {
      expect((error as DocumentSelectorCompileError).issues).toEqual([
        expect.objectContaining({ code: "selector_target_semantic_basis_required", details: expect.objectContaining({ writable_path: "/targets/0/semantic_basis", next_tool: "patch_document_selectors" }) }),
      ]);
    }
  });

  test("pending semantic proof does not hide a completed target's invalid reference", () => {
    const { evidence, registry, selectors } = compileFixture("地基承载力应满足设计要求。");
    const target = selectors.targets[0]!;
    const pending = structuredClone(target);
    pending.key = "pending-foundation";
    selectors.targets.push(pending);
    target.semantic_basis = {
      subject: "地基", subject_kind: "work", acceptance_kind: "direct_criterion",
      acceptance_span_ids: [...target.scope_span_ids], acceptance_reason: "原文要求承载力满足设计要求", boundary_reason: "独立受检地基",
    };
    target.reference_span_ids = ["span:00000000000000000000000000000000"];
    selectors.dispositions = [];
    try {
      compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis: true });
      throw new Error("expected mixed draft rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSelectorCompileError);
      const issues = (error as DocumentSelectorCompileError).issues;
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_target_semantic_basis_required", path: "/targets/1/semantic_basis" }),
        expect.objectContaining({ code: "selector_unknown_span", path: "/targets/0/reference_span_ids/0" }),
      ]));
      expect(issues.some(issue => issue.code === "selector_atom_unreviewed")).toBe(false);
    }
  });

  test("live draft overlap waits for seed confirmation but never ignores overlap between proved targets", () => {
    const { evidence, registry, selectors } = compileFixture("地基承载力应满足设计要求。");
    const first = selectors.targets[0]!;
    const second = structuredClone(first);
    second.key = "second-foundation";
    selectors.targets.push(second);
    const issuesFor = (requireSemanticBasis: boolean) => {
      try {
        compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis });
        return [];
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentSelectorCompileError);
        return (error as DocumentSelectorCompileError).issues;
      }
    };
    const overlapIssues = (requireSemanticBasis = true) => issuesFor(requireSemanticBasis)
      .filter(issue => issue.code === "selector_target_primary_overlap");
    expect(issuesFor(true).filter(issue => issue.code === "selector_target_semantic_basis_required")).toHaveLength(2);
    expect(overlapIssues()).toEqual([]);
    expect(overlapIssues(false)).toHaveLength(1);
    first.semantic_basis = {
      subject: "地基", subject_kind: "work", acceptance_kind: "direct_criterion",
      acceptance_span_ids: [...first.scope_span_ids], acceptance_reason: "原文明确承载力要求", boundary_reason: "独立受检地基",
    };
    expect(issuesFor(true).filter(issue => issue.code === "selector_target_semantic_basis_required")).toHaveLength(1);
    expect(overlapIssues()).toEqual([]);
    expect(overlapIssues(false)).toHaveLength(1);
    second.semantic_basis = structuredClone(first.semantic_basis);
    expect(overlapIssues()).toHaveLength(1);
    const third = structuredClone(first);
    delete third.semantic_basis;
    third.key = "still-pending-foundation";
    selectors.targets.push(third);
    expect(issuesFor(true).filter(issue => issue.code === "selector_target_semantic_basis_required")).toHaveLength(1);
    expect(overlapIssues()).toEqual([expect.objectContaining({ path: "/targets/1/source_blocks" })]);
    expect(overlapIssues(false)).toHaveLength(3);
  });

  test.each(["direct_criterion", "referenced_criterion"] as const)("requires bound evidence and boundary reasoning for %s", (kind) => {
    const quote = kind === "direct_criterion" ? "地基承载力应满足设计要求" : "地基承载力检验应符合本规范第4.10节的规定";
    const fixture = compileFixture(`# 地基\n${quote}。`, quote);
    const target = fixture.selectors.targets[0]!;
    target.semantic_basis = { subject: "地基", subject_kind: "work", acceptance_kind: kind, acceptance_span_ids: [...target.scope_span_ids], acceptance_reason: "原文明确约束地基承载力", boundary_reason: "本段针对同一受检地基，判据保留在同一目标中" };
    const compile = () => compileDocumentSelectors(fixture.selectors, fixture.registry, fixture.evidence, "job", { requireSemanticBasis: true });
    expect(compile().targets).toHaveLength(1);
    for (const contextKind of ["generic_inspection_lot", "aggregate_acceptance", "governing_rule"] as const) {
      target.semantic_basis.subject_kind = contextKind;
      expect(compile).toThrow(/selector_non_concrete_target/);
    }
    target.semantic_basis.subject_kind = "work";
    const before = compile();
    target.semantic_basis.boundary_reason = "同一受检对象合并其全部判据";
    expect(prettyJson(compile())).not.toBe(prettyJson(before));
    target.semantic_basis.boundary_reason = " ";
    expect(compile).toThrow(/selector_target_semantic_basis_required/);
    target.semantic_basis.boundary_reason = "独立地基范围";
    target.semantic_basis.acceptance_span_ids = [fixture.registry.spans.find(span => span.start === 0)!.span_id];
    expect(compile).toThrow(/selector_semantic_evidence_unbound/);
    target.semantic_basis.acceptance_span_ids = ["invented-span"];
    expect(compile).toThrow();
  });

  test("accepts semantic evidence contained by primary source without exact duplicate membership", () => {
    const markdown = "地基承载力应满足设计要求。\n检查数量：全数。";
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const atom = evidence.atoms[0]!;
    const source = { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text };
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [source]);
    const acceptance = locateAndRegisterSourceQuote(registry, source, "地基承载力应满足设计要求。");
    registry = acceptance.registry;
    const full = registry.spans.find((span) => span.start === 0 && span.end === atom.text.length)!.span_id;
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets = [{
      key: "foundation", group_key: "foundation", group_name: "地基工程", group_reason: "按受检对象归组",
      name: "地基承载力", lot_basis_summary: "全文条款", scope_span_ids: [full],
      source_blocks: [{ kind: "explicit_range", anchor_span_id: acceptance.spans[0]!.span_id, start_span_id: full, end_span_id: full, reason: "完整条文" }],
      lot_basis_span_ids: [full], reason: "具体对象判据",
      semantic_basis: { subject: "地基", subject_kind: "work", acceptance_kind: "direct_criterion", acceptance_span_ids: [acceptance.spans[0]!.span_id], acceptance_reason: "原文明确判据", boundary_reason: "独立受检对象" },
    }];
    selectors.dispositions = [{ atom_span_id: full, disposition: "target", target_keys: [], reason: "包含目标" }];
    expect(compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis: true }).targets).toHaveLength(1);
  });

  test("unbound semantic evidence guidance keeps public handles and leaves source ownership to the author", async () => {
    const root = resolve(".tmp-tests", `discovery-unbound-guidance-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const quote = "受检构件应保持连接稳定";
      const fixture = compileFixture(`${quote}。\n共享部位应符合约定要求。`, quote);
      const target = fixture.selectors.targets[0]!;
      const full = fixture.registry.spans.find(span => span.start === 0 && span.end === fixture.evidence.atoms[0]!.text.length)!.span_id;
      target.semantic_basis = { subject: "受检构件", subject_kind: "product", acceptance_kind: "direct_criterion",
        acceptance_span_ids: [full], acceptance_reason: "依据须按实际受检对象核对", boundary_reason: "按具体受检构件确认边界" };
      const before = prettyJson({ selectors: fixture.selectors, registry: fixture.registry });
      const compile = (selectors = fixture.selectors) => compileDocumentSelectors(selectors, fixture.registry, fixture.evidence, "job", { requireSemanticBasis: true });
      let issues: DocumentSelectorCompileError["issues"] = [];
      try { compile(); } catch (error) {
        if (!(error instanceof DocumentSelectorCompileError)) throw error;
        issues = error.issues;
      }
      const issue = issues.find(row => row.code === "selector_semantic_evidence_unbound")!;
      expect(issue).toBeDefined();
      expect(issue.details).toMatchObject({ actual: target.semantic_basis, target_key: target.key,
        expected: expect.any(String), writable_paths: ["/targets/0/source_blocks", "/targets/0/reference_span_ids", "/targets/0/semantic_basis/acceptance_span_ids", "/targets/0/semantic_basis/acceptance_reason"] });
      const codec = await ModelSourceHandles.open(root);
      const publicIssue = await codec.encode(issue) as any;
      expect(publicIssue.details.unbound_span_ids).toEqual([expect.stringMatching(/^s[1-9]\d*$/)]);
      expect(JSON.stringify(publicIssue)).not.toContain("span:");
      expect(publicIssue.details.unbound_reference_escape.how).toContain("unbound_span_ids");
      expect(publicIssue.details.required_action).toContain("主资料");
      expect(publicIssue.details.required_action).toContain("共享或引用");
      expect(publicIssue.details.required_action).toContain("误选");
      expect(publicIssue.details.required_action).not.toContain("推荐");
      expect(await codec.decodeArguments({ reference_span_ids: publicIssue.details.unbound_span_ids, source_handle_scope: codec.scope }))
        .toEqual({ reference_span_ids: [full] });
      expect(prettyJson({ selectors: fixture.selectors, registry: fixture.registry })).toBe(before);
      // These alternatives test coverage mechanics, not semantic applicability of either role.
      const primary = structuredClone(fixture.selectors);
      primary.targets[0]!.source_blocks[0]!.end_span_id = full;
      expect(compile(primary).targets).toHaveLength(1);
      const reference = structuredClone(fixture.selectors);
      reference.targets[0]!.reference_span_ids = [full];
      expect(compile(reference).targets).toHaveLength(1);
      const correctedBasis = structuredClone(fixture.selectors);
      correctedBasis.targets[0]!.semantic_basis!.acceptance_span_ids = [...target.scope_span_ids];
      expect(compile(correctedBasis).targets).toHaveLength(1);
      expect(compile).toThrow(/selector_semantic_evidence_unbound/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context-only documents can finish with explained zero targets, never an unreviewed empty draft", () => {
    const evidence = buildDocumentEvidence("检验批、分项、分部及单位工程按规定程序组织验收。", "source.md", 1000);
    const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map(atom => ({ source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
    const selectors = initialDocumentSelectorPlan("job");
    selectors.no_target_reason = "全文仅规定验收组织层级，没有具体受检工程或检验项目。";
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis: true })).toThrow(/selector_atom_unreviewed/);
    const span = registry.spans[0]!;
    selectors.contexts = [{ key: "organization", role: "aggregate_acceptance", name: "验收层级", span_ids: [span.span_id], reason: "汇总验收程序" }];
    selectors.dispositions = [{ atom_span_id: span.span_id, disposition: "context", target_keys: [], reason: "仅汇总验收程序，无具体受检对象" }];
    const compiled = compileDocumentSelectors(selectors, registry, evidence, "job", { requireSemanticBasis: true });
    expect(compiled.targets).toEqual([]);
    expect(compiled.no_target_reason).toBe(selectors.no_target_reason);
    expect(validateDocumentTargetPlan(compiled, evidence, "job", new Set())).toMatchObject({ ok: false });
    expect(validateDocumentTargetPlan(compiled, evidence, "job", new Set(evidence.atoms.map(atom => atom.atom_id)))).toMatchObject({ ok: true });
    delete selectors.no_target_reason;
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).toThrow(/selector_zero_targets/);
  });

  test("a management-system connectivity test inside an aggregate chapter remains a concrete scope", () => {
    const quote = "智能配线系统应检测物理连接与管理软件显示的连接关系的一致性";
    const { evidence, registry, selectors } = compileFixture(`# 工程验收\n${quote}。\n建设单位组织验收。`, quote);
    const target = selectors.targets[0]!;
    target.name = "智能配线系统连接一致性测试";
    target.group_name = "综合布线系统";
    target.lot_basis_summary = "比较物理连接与软件显示的连接关系";
    target.semantic_basis = { subject: "智能配线系统", subject_kind: "system", acceptance_kind: "direct_criterion", acceptance_span_ids: [...target.scope_span_ids], acceptance_reason: "系统具备可测的连接一致性要求，不是组织规则", boundary_reason: "测试要求从汇总章节中独立出来，组织责任保留为上下文" };
    const atom = evidence.atoms[0]!;
    const context = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, "建设单位组织验收");
    selectors.contexts = [{ key: "organization", role: "governing_rule", name: "组织责任", span_ids: [context.spans[0]!.span_id], reason: "仅验收组织责任" }];
    const compiled = compileDocumentSelectors(selectors, context.registry, evidence, "job", { requireSemanticBasis: true });
    expect(compiled.targets).toHaveLength(1);
    expect(compiled.targets[0]!.semantic_basis?.subject_kind).toBe("system");
    expect(compiled.context_notes).toHaveLength(1);
  });

  test("strict schema does not expose generated target IDs or exact fragment text", () => {
    const schema = JSON.stringify(DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA);
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).not.toContain("target_id");
    expect(schema).not.toContain("evidence_fragments");
    expect(schema).not.toContain("atom_id");
    expect(schema).not.toContain("document_fingerprint");
    expect(schema).not.toContain("span_registry_fingerprint");
  });

  test("compiles selectors into exact target fragments and full atom dispositions", () => {
    const { evidence, registry, selectors } = compileFixture("# 任意损坏标题\n地基承载力应满足设计要求。");
    const first = compileDocumentSelectors(selectors, registry, evidence, "job");
    const second = compileDocumentSelectors(structuredClone(selectors), registry, evidence, "job");
    expect(prettyJson(second)).toBe(prettyJson(first));
    expect(first.targets[0]).toMatchObject({
      name: "地基验收",
      evidence_fragments: [{ text: "地基承载力应满足设计要求" }],
      materialization: { lot_basis_fragments: [{ text: "地基承载力应满足设计要求" }] },
    });
    expect(validateDocumentTargetPlan(first, evidence, "job", new Set(evidence.atoms.map((atom) => atom.atom_id)))).toMatchObject({ ok: true, issues: [] });
  });

  test("rejects English model summaries for Chinese target evidence while preserving short technical tokens", () => {
    const chinese = compileFixture("地基承载力应满足设计要求。");
    chinese.selectors.targets[0]!.group_name = "Foundation work";
    chinese.selectors.targets[0]!.group_reason = "Grouped by the inspected construction entity.";
    chinese.selectors.targets[0]!.name = "Foundation acceptance";
    chinese.selectors.targets[0]!.lot_basis_summary = "Bearing capacity satisfies the design requirement.";
    chinese.selectors.targets[0]!.reason = "This forms an independent inspection lot.";
    try {
      compileDocumentSelectors(chinese.selectors, chinese.registry, chinese.evidence, "job");
      throw new Error("Expected source-language validation to reject translated target prose");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSelectorCompileError);
      expect((error as DocumentSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/targets/0/group_name" }),
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/targets/0/name" }),
        expect.objectContaining({ code: "selector_source_language_mismatch", path: "/targets/0/lot_basis_summary" }),
      ]));
    }

    const technical = compileFixture("地基承载力应满足设计要求。");
    technical.selectors.targets[0]!.name = "H/1500";
    technical.selectors.targets[0]!.group_name = "GB 50576";
    expect(() => compileDocumentSelectors(
      technical.selectors,
      technical.registry,
      technical.evidence,
      "job",
    )).not.toThrow();
  });

  test("materializes lot-basis provenance into target evidence membership when it comes from another atom", () => {
    const scopeText = "地基承载力应满足设计要求。";
    const lotBasisText = "每一独立施工段划分为一个检验批。";
    const markdown = `${scopeText}${"甲".repeat(1_000)}${lotBasisText}`;
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const sources = evidence.atoms.map((atom) => ({
      source_id: atom.atom_id,
      evidence_id: atom.atom_id,
      atom_id: atom.atom_id,
      text: atom.text,
    }));
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, sources);
    const scopeAtom = evidence.atoms.find((atom) => atom.text.includes(scopeText))!;
    const lotBasisAtom = evidence.atoms.find((atom) => atom.text.includes(lotBasisText))!;
    const scope = locateAndRegisterSourceQuote(
      registry,
      sources.find((source) => source.atom_id === scopeAtom.atom_id)!,
      scopeText,
    );
    registry = scope.registry;
    const lotBasis = locateAndRegisterSourceQuote(
      registry,
      sources.find((source) => source.atom_id === lotBasisAtom.atom_id)!,
      lotBasisText,
    );
    registry = lotBasis.registry;
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets.push({
      key: "foundation",
      group_key: "foundation-work",
      group_name: "地基工程",
      group_reason: "按被检工程实体归组",
      name: "地基验收",
      lot_basis_summary: "按独立施工段划分检验批",
      scope_span_ids: [scope.spans[0]!.span_id],
      source_blocks: [{
        kind: "explicit_range",
        anchor_span_id: scope.spans[0]!.span_id,
        start_span_id: scope.spans[0]!.span_id,
        end_span_id: scope.spans[0]!.span_id,
        reason: "范围正文没有可靠标题，Agent 明确提交起止坐标",
      }],
      reference_span_ids: [lotBasis.spans[0]!.span_id],
      lot_basis_span_ids: [scope.spans[0]!.span_id, lotBasis.spans[0]!.span_id],
      reason: "范围与划分依据来自不同全文窗口",
    });
    selectors.dispositions = evidence.atoms.map((atom) => ({
      atom_span_id: registry.spans.find((span) =>
        span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: "target" as const,
      target_keys: ["foundation"],
      reason: "该窗口提供目标范围或检验批划分依据",
    }));

    const compiled = compileDocumentSelectors(selectors, registry, evidence, "job");
    expect(compiled.targets[0]!.evidence_atom_ids).toEqual([
      scopeAtom.atom_id,
      lotBasisAtom.atom_id,
    ]);
    expect(validateDocumentTargetPlan(
      compiled,
      evidence,
      "job",
      new Set(evidence.atoms.map((atom) => atom.atom_id)),
    )).toMatchObject({ ok: true, issues: [] });
  });

  test("format and numbering perturbations remain selector-compilable", () => {
    for (const markdown of [
      "## 4.2 地基\n地基承载力应满足设计要求。",
      "错乱编号 99 | 地基承载力应满足设计要求。|",
      "<!-- page 12 -->\n**地基承载力应满足设计要求**。",
    ]) {
      const { evidence, registry, selectors } = compileFixture(markdown);
      expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).not.toThrow();
    }
  });

  test("heading_section rejects a boundary that crosses into the next numbered chapter", () => {
    const markdown = [
      "## 4.11 电梯安装验收",
      "### 4.11.1 导轨安装应符合要求",
      "本节其他连续正文。",
      "# 2 下列开关应动作可靠",
      "该行是被错误提升为标题的编号列表。",
      "# 5 液压电梯安装工程质量验收",
      "## 5.1 设备进场验收",
      "设备应具有合格证。",
    ].join("\n");
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const atom = evidence.atoms[0]!;
    const source = { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text };
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [source]);
    const locate = (quote: string) => {
      const result = locateAndRegisterSourceQuote(registry, source, quote);
      registry = result.registry;
      return result.spans[0]!.span_id;
    };
    const anchor = locate("## 4.11 电梯安装验收");
    const scope = locate("### 4.11.1 导轨安装应符合要求");
    const submittedEnd = locate("## 5.1 设备进场验收");
    const boundary = locate("# 5 液压电梯安装工程质量验收");
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets.push({
      key: "elevator", group_key: "installation", group_name: "安装工程", group_reason: "按受检实体归组",
      name: "电梯安装", lot_basis_summary: "按本节范围验收", scope_span_ids: [scope],
      source_blocks: [{ kind: "heading_section", anchor_span_id: anchor, start_span_id: anchor, end_before_span_id: submittedEnd, reason: "按编号标题范围" }],
      lot_basis_span_ids: [scope], reason: "本节形成验收范围",
    });
    selectors.dispositions = [{
      atom_span_id: registry.spans.find(span => span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: "target", target_keys: ["elevator"], reason: "含目标正文",
    }];

    try {
      compileDocumentSelectors(selectors, registry, evidence, "job");
      throw new Error("Expected structural boundary crossing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSelectorCompileError);
      expect((error as DocumentSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_heading_section_crosses_structural_boundary",
          path: "/targets/0/source_blocks/0/end_before_span_id",
          details: expect.objectContaining({
            first_conflicting_heading: expect.objectContaining({ number: "5" }),
            candidate_boundary_span_id: boundary,
            do_not_patch_until_boundary_is_fixed: "/dispositions",
          }),
        }),
      ]));
    }
  });

  test("heading_section may span atoms while descendants and promoted backward list numbers stay inside it", () => {
    const markdown = [
      "## 4.11 电梯安装验收",
      "### 4.11.1 导轨安装应符合要求",
      "甲".repeat(1_900),
      "# 2 下列安全开关应动作可靠",
      "### 4.11.2 层门安装应符合要求",
      "本节末行。",
      "## 4.12 后续验收",
    ].join("\n");
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const sources = evidence.atoms.map(atom => ({ source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }));
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, sources);
    const locate = (quote: string) => {
      const source = sources.find(candidate => candidate.text.includes(quote))!;
      const result = locateAndRegisterSourceQuote(registry, source, quote);
      registry = result.registry;
      return result.spans[0]!.span_id;
    };
    const anchor = locate("## 4.11 电梯安装验收");
    const scope = locate("### 4.11.1 导轨安装应符合要求");
    const endBefore = locate("## 4.12 后续验收");
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets.push({
      key: "elevator", group_key: "installation", group_name: "安装工程", group_reason: "按受检实体归组",
      name: "电梯安装", lot_basis_summary: "按本节范围验收", scope_span_ids: [scope],
      source_blocks: [{ kind: "heading_section", anchor_span_id: anchor, start_span_id: anchor, end_before_span_id: endBefore, reason: "完整编号节跨越多个原子" }],
      lot_basis_span_ids: [scope], reason: "本节形成验收范围",
    });
    const targetAtomIds = new Set(evidence.atoms.filter(atom => atom.start_offset < markdown.indexOf("## 4.12")).map(atom => atom.atom_id));
    selectors.dispositions = evidence.atoms.map(atom => ({
      atom_span_id: registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: targetAtomIds.has(atom.atom_id) ? "target" as const : "irrelevant" as const,
      target_keys: targetAtomIds.has(atom.atom_id) ? ["elevator"] : [],
      reason: targetAtomIds.has(atom.atom_id) ? "含本节正文" : "仅含后续节",
    }));
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).not.toThrow();
  });

  test("does not turn whitespace-only atom slices inside a continuous block into target evidence", () => {
    const markdown = `## 4.11 电梯安装验收\n### 4.11.1 导轨安装应符合要求\n${" ".repeat(2_400)}\n## 4.12 后续验收\n后续正文。`;
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const sources = evidence.atoms.map(atom => ({ source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }));
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, sources);
    const locate = (quote: string) => {
      const source = sources.find(candidate => candidate.text.includes(quote))!;
      const result = locateAndRegisterSourceQuote(registry, source, quote);
      registry = result.registry;
      return result.spans[0]!.span_id;
    };
    const anchor = locate("## 4.11 电梯安装验收");
    const scope = locate("### 4.11.1 导轨安装应符合要求");
    const endBefore = locate("## 4.12 后续验收");
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets.push({
      key: "elevator", group_key: "installation", group_name: "安装工程", group_reason: "按受检实体归组",
      name: "电梯安装", lot_basis_summary: "按本节范围验收", scope_span_ids: [scope],
      source_blocks: [{ kind: "heading_section", anchor_span_id: anchor, start_span_id: anchor, end_before_span_id: endBefore, reason: "完整编号节" }],
      lot_basis_span_ids: [scope], reason: "本节形成验收范围",
    });
    const targetAtomId = evidence.atoms.find(atom => atom.text.includes("4.11.1"))!.atom_id;
    selectors.dispositions = evidence.atoms.map(atom => ({
      atom_span_id: registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: atom.atom_id === targetAtomId ? "target" as const : "irrelevant" as const,
      target_keys: atom.atom_id === targetAtomId ? ["elevator"] : [],
      reason: atom.atom_id === targetAtomId ? "含目标正文" : "仅为空白分隔或后续节",
    }));
    const compiled = compileDocumentSelectors(selectors, registry, evidence, "job");
    expect(compiled.targets[0]!.evidence_atom_ids).toEqual([targetAtomId]);
  });

  test("explicit_range and unnumbered OCR headings are not rejected by structural-boundary preflight", () => {
    for (const kind of ["explicit_range", "heading_section"] as const) {
      const markdown = "## 电梯安装验收\n导轨安装应符合要求。\n# 液压电梯验收\n设备应具有合格证。";
      const { evidence, registry, selectors } = compileFixture(`${markdown}\n地基承载力应满足设计要求。`);
      const target = selectors.targets[0]!;
      target.source_blocks[0]!.kind = kind;
      expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).not.toThrow();
    }
  });

  test("derives disposition target relations from compiled primary evidence", () => {
    const { evidence, registry, selectors } = compileFixture("# 4 地基工程\n地基承载力应满足设计要求。");
    selectors.dispositions[0]!.target_keys = ["unknown-extra"];
    selectors.dispositions[0]!.disposition = "context";
    const compiled = compileDocumentSelectors(selectors, registry, evidence, "job");
    expect(compiled.dispositions[0]).toMatchObject({
      disposition: "target",
      target_ids: compiled.targets.map((target) => target.target_id),
    });
  });

  test("source block boundaries materialize unquoted middle text and reject cross-target primary overlap", () => {
    const markdown = "# 任意标题\n起点要求。\n中间完整正文。\n末行要求。\n# 后续标题\n后续正文。";
    const evidence = buildDocumentEvidence(markdown, "source.md", 1_000);
    const atom = evidence.atoms[0]!;
    const source = { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text };
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [source]);
    const locate = (quote: string) => {
      const result = locateAndRegisterSourceQuote(registry, source, quote);
      registry = result.registry;
      return result.spans[0]!.span_id;
    };
    const title = locate("# 任意标题");
    const middle = locate("中间完整正文。");
    const last = locate("末行要求。");
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets.push({
      key: "whole", group_key: "test", group_name: "测试", group_reason: "按受检对象归组", name: "完整范围",
      lot_basis_summary: "标题至末行", scope_span_ids: [title, last],
      source_blocks: [{ kind: "heading_section", anchor_span_id: title, start_span_id: title, end_span_id: last, reason: "Agent 确认该连续标题结构" }],
      lot_basis_span_ids: [title], reason: "覆盖连续主资料",
    });
    selectors.dispositions = [{
      atom_span_id: registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: "target", target_keys: ["whole"], reason: "本原子含目标和后继导航内容",
    }];
    const compiled = compileDocumentSelectors(selectors, registry, evidence, "job");
    expect(compiled.targets[0]!.work_scope!.primary_fragments!.map(fragment => fragment.text).join(""))
      .toContain("中间完整正文。");

    selectors.targets.push({
      key: "overlap", group_key: "test", group_name: "测试", group_reason: "按受检对象归组", name: "错误重叠范围",
      lot_basis_summary: "中间至末行", scope_span_ids: [middle, last],
      source_blocks: [{ kind: "explicit_range", anchor_span_id: middle, start_span_id: middle, end_span_id: last, reason: "故意制造跨目标重叠" }],
      lot_basis_span_ids: [middle], reason: "验证跨目标重叠会被拒绝",
    });
    selectors.dispositions[0]!.target_keys.push("overlap");
    try {
      compileDocumentSelectors(selectors, registry, evidence, "job");
      throw new Error("Expected overlapping target source blocks to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSelectorCompileError);
      expect((error as DocumentSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_target_primary_overlap", path: "/targets/1/source_blocks",
          details: expect.objectContaining({
            writable_paths: expect.arrayContaining(["/targets/0/source_blocks", "/targets/1/reference_span_ids"]),
            next_tools: expect.arrayContaining(["read_document_selectors", "edit_document_selectors"]),
            source_atom_ids: [atom.atom_id],
          }),
        }),
      ]));
    }
  });

  test("unreviewed atoms fail at the selector disposition path", () => {
    const { evidence, registry, selectors } = compileFixture(`地基承载力应满足设计要求。\n${"其他无关内容。".repeat(200)}`);
    selectors.dispositions.pop();
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job")).toThrow(DocumentSelectorCompileError);
    try {
      compileDocumentSelectors(selectors, registry, evidence, "job");
    } catch (error) {
      expect((error as DocumentSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_atom_unreviewed", path: "/dispositions" }),
      ]));
    }
  });

  test("discovery Agent surface exposes selectors and no compiled-plan mutation tools", async () => {
    const root = resolve(".tmp-tests", `document-selector-tools-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const markdownPath = resolve(root, "source.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(markdownPath, "地基承载力应满足设计要求。", "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
    const controller = await DocumentDiscoveryController.create(workspace);
    const names = createDocumentDiscoveryTools(controller).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "get_document_selector_contract", "list_document_atoms", "open_document_atom", "search_document",
      "batch_open_document_atoms", "batch_search_document", "locate_document_span", "batch_locate_document_spans",
      "read_document_selectors", "patch_document_selectors", "compile_document_selectors",
    ]));
    for (const forbidden of ["read_discovery_plan", "replace_discovery_plan", "patch_discovery_plan", "validate_discovery_plan", "replace_document_selectors", "submit_document_selectors", "correct_document_selectors"]) {
      expect(names).not.toContain(forbidden);
    }
    await rm(root, { recursive: true, force: true });
  });

  test("document span registration after contract read remains harness-owned", async () => {
    const root = resolve(".tmp-tests", `document-selector-fingerprint-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const markdown = "地基承载力应满足设计要求。";
      const markdownPath = resolve(root, "source.md");
      await writeFile(markdownPath, markdown, "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
      const controller = await DocumentDiscoveryController.create(workspace);
      const contract = await controller.dispatch("get_document_selector_contract", {});
      expect(JSON.stringify(contract)).not.toContain("span_registry_fingerprint");
      expect(JSON.stringify(contract)).not.toContain("document_fingerprint");
      const atom = controller.evidence.atoms[0]!;
      expect(await controller.dispatch("open_document_atom", { atom_id: atom.atom_id }))
        .toMatchObject({ ok: true });
      expect(await controller.dispatch("locate_document_span", {
        atom_id: atom.atom_id,
        quote: "地基承载力应满足设计要求",
      })).toMatchObject({ ok: true });
      const { selectors } = compileFixture(markdown);
      expect(await controller.dispatch("patch_document_selectors", {
        operations: [
          { op: "add", path: "/targets/-", value: selectors.targets[0] },
          { op: "add", path: "/dispositions/-", value: selectors.dispositions[0] },
        ],
      })).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("independent reviewer has a separate final-validation budget", async () => {
    const root = resolve(".tmp-tests", `document-selector-review-budget-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const markdown = "地基承载力应满足设计要求。";
      const markdownPath = resolve(root, "source.md");
      await writeFile(markdownPath, markdown, "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
      const author = await DocumentDiscoveryController.create(workspace, "candidate");
      const atom = author.evidence.atoms[0]!;
      await author.dispatch("open_document_atom", { atom_id: atom.atom_id });
      const located = await author.dispatch("locate_document_span", {
        atom_id: atom.atom_id,
        quote: "地基承载力应满足设计要求",
      }) as { spans: Array<{ span_id: string }> };
      const contract = await author.dispatch("get_document_selector_contract", {}) as {
        full_atom_spans: Array<{ atom_id: string; span_id: string }>;
      };
      const spanId = located.spans[0]!.span_id;
      const fullAtomSpanId = contract.full_atom_spans[0]!.span_id;
      expect(await author.dispatch("patch_document_selectors", {
        operations: [
          { op: "add", path: "/targets/-", value: {
            key: "foundation",
            group_key: "foundation-work",
            group_name: "地基工程",
            group_reason: "按被检工程实体归组",
            name: "地基验收",
            lot_basis_summary: "地基承载力验收",
            scope_span_ids: [spanId],
            source_blocks: [{ kind: "explicit_range", anchor_span_id: spanId, start_span_id: spanId, end_span_id: spanId, reason: "明确连续正文边界" }],
            lot_basis_span_ids: [spanId],
            reason: "可形成独立检验批",
          } },
          { op: "add", path: "/dispositions/-", value: {
            atom_span_id: fullAtomSpanId,
            disposition: "target",
            target_keys: ["foundation"],
            reason: "该窗口包含目标业务证据",
          } },
        ],
      })).toMatchObject({ ok: true, final_compile_ready: true });

      let validation: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 6; attempt += 1) {
        validation = await author.dispatch("compile_document_selectors", {});
        expect(validation).toMatchObject({ ok: true });
      }
      expect(await author.dispatch("compile_document_selectors", {})).toMatchObject({
        ok: false,
        error: "final_validator_attempt_limit",
        attempts_used: 6,
        max_attempts: 6,
      });
      expect(await author.dispatch("submit_discovery_candidate", {
        fingerprint: validation.fingerprint,
      })).toMatchObject({ ok: true, status: "candidate" });

      const reviewer = await DocumentDiscoveryController.create(workspace, "review");
      await reviewer.dispatch("open_document_atom", { atom_id: atom.atom_id });
      expect(await reviewer.dispatch("compile_document_selectors", {}))
        .toMatchObject({ ok: true });
      expect(await workspace.readState()).toMatchObject({
        validation_attempts: 6,
        reviewer_validation_attempts: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("discovery batch tools and revisable selector checkpoints stay explicit and bounded", async () => {
    const root = resolve(".tmp-tests", `document-selector-batch-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const markdownPath = resolve(root, "source.md");
      await writeFile(markdownPath, `定位请求甲。${"填充内容。".repeat(1_600)}定位请求乙。`, "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", markdownPath);
      const controller = await DocumentDiscoveryController.create(workspace);
      const atoms = controller.evidence.atoms;
      expect(atoms.length).toBeGreaterThan(1);
      const first = atoms.find((atom) => atom.text.includes("定位请求甲"))!;
      const second = atoms.find((atom) => atom.text.includes("定位请求乙"))!;

      expect(await controller.dispatch("batch_open_document_atoms", { atom_ids: [] }))
        .toMatchObject({ ok: false, error: "batch_open_document_atoms_requires_1_to_50_ids" });
      const opened = await controller.dispatch("batch_open_document_atoms", { atom_ids: [first.atom_id, second.atom_id] });
      expect(opened.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(opened), "utf8")).toBeLessThanOrEqual(128 * 1024);

      expect(await controller.dispatch("batch_locate_document_spans", { requests: [] }))
        .toMatchObject({ ok: false, error: "batch_locate_document_spans_requires_1_to_100_requests" });
      const located = await controller.dispatch("batch_locate_document_spans", {
        requests: [{ atom_id: first.atom_id, quote: "定位请求甲" }],
      });
      expect(located.ok).toBe(true);
      expect((located.results as unknown[])).toHaveLength(1);
      expect(JSON.stringify(located)).not.toContain(second.atom_id);
      expect(Object.keys(located)).not.toContain("registry");

      const span = (located.results as Array<{ spans: Array<{ span_id: string }> }>)[0]!.spans[0]!.span_id;
      const target = {
        key: "checkpoint-target",
        group_key: "checkpoint-group",
        group_name: "检查分组",
        group_reason: "业务归组",
        name: "初始名称",
        lot_basis_summary: "定位请求甲",
        scope_span_ids: [span],
        source_blocks: [{ kind: "explicit_range", anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "明确连续正文边界" }],
        lot_basis_span_ids: [span],
        reason: "可形成独立目标",
      };
      expect(await controller.dispatch("patch_document_selectors", {
        operations: [{ op: "add", path: "/targets/-", value: target }],
      })).toMatchObject({ ok: true, stage: "document-selector-checkpoint", final_compile_ready: false });
      expect(await controller.dispatch("patch_document_selectors", {
        operations: [{ op: "replace", path: "/targets/0/name", value: "修订后的名称" }],
      })).toMatchObject({ ok: true, stage: "document-selector-checkpoint" });
      expect(await controller.dispatch("read_document_selectors", { collection: "targets", key: "checkpoint-target" }))
        .toMatchObject({ ok: true, rows: [expect.objectContaining({ name: "修订后的名称" })] });

      await atomicWriteJson(join(workspace.root, "scope-repair-guard.json"), {
        schema_version: "scope-repair-guard/v1",
        required_targets: [{ key: "checkpoint-target", name: "初始名称" }],
      });
      const reviewState = await workspace.readState();
      await atomicWriteJson(workspace.statePath, { ...reviewState, review_reason: "旧范围契约迁移" });
      expect(await controller.dispatch("patch_document_selectors", {
        operations: [{ op: "remove", path: "/targets/0" }],
      })).toMatchObject({
        ok: false,
        error: "scope_repair_target_deletion_forbidden",
        missing_targets: [{ key: "checkpoint-target", name: "初始名称" }],
      });

      const tooMany = Array.from({ length: 5 }, (_, index) => ({
        op: "add",
        path: "/contexts/-",
        value: { key: `context-${index}`, role: "other_context", name: "上下文", span_ids: [span], reason: "测试" },
      }));
      expect(await controller.dispatch("patch_document_selectors", { operations: tooMany }))
        .toMatchObject({ ok: false, error: "incremental_discovery_checkpoint_required" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unclassified discovery windows carry covering atoms and convergence progress", () => {
    const markdown = [
      "## 4.2 素土、灰土地基",
      "素土、灰土地基的质量检验应符合规定。",
      "",
      "## 4.3 砂和砂石地基",
      "砂和砂石地基的质量检验应符合规定。",
      "",
    ].join("\n");
    const { evidence, registry, selectors } = compileFixture(markdown, "素土、灰土地基的质量检验");
    expect(() => compileDocumentSelectors(selectors, registry, evidence, "job", {
      discoveryScopeCandidates: [
        { window_id: "window:4.2", number: "4.2", title: "素土、灰土地基", start_line: 1, end_exclusive_line: 3 },
        { window_id: "window:4.3", number: "4.3", title: "砂和砂石地基", start_line: 4, end_exclusive_line: 6 },
      ],
    })).toThrow(DocumentSelectorCompileError);
    try {
      compileDocumentSelectors(selectors, registry, evidence, "job", {
        discoveryScopeCandidates: [
          { window_id: "window:4.2", number: "4.2", title: "素土、灰土地基", start_line: 1, end_exclusive_line: 3 },
          { window_id: "window:4.3", number: "4.3", title: "砂和砂石地基", start_line: 4, end_exclusive_line: 6 },
        ],
      });
    } catch (error) {
      if (!(error instanceof DocumentSelectorCompileError)) throw error;
      const unclassified = error.issues.filter((issue) => issue.code === "selector_discovery_window_unclassified");
      expect(unclassified).toHaveLength(1);
      const details = unclassified[0]!.details as {
        covering_atoms: Array<{ atom_id: string; start_line: number; end_line: number; first_line: string }>;
        window_classification_progress: { classified_windows: number; total_windows: number };
      };
      expect(details.covering_atoms.length).toBeGreaterThanOrEqual(1);
      const window43 = unclassified.find(issue => (issue.details as { window?: { window_id?: string } }).window?.window_id === "window:4.3");
      expect(window43).toBeDefined();
      const window43Atoms = (window43!.details as { covering_atoms: Array<{ start_line: number; end_line: number }> }).covering_atoms;
      expect(window43Atoms.some(atom => atom.start_line <= 4 && atom.end_line >= 4)).toBe(true);
      expect(details.window_classification_progress).toMatchObject({ classified_windows: 1, total_windows: 2 });
    }
  });
});
