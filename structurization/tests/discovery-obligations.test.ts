import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { prettyJson } from "../src/canonical.js";
import { batchLedgerGapFrom } from "../src/batch.js";
import { discoveryObligations, type DiscoveryDecision } from "../src/discovery-obligations.js";
import { buildDocumentEvidence, createDocumentDiscoveryTools, DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { discoveryScopeWindows, evaluateDiscoveryLedgerAgreement, evaluateTargetLedgerCoverage, scanDocumentLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";

// Invented source: no document-specific counts, answers or production artifacts.
const firstClause = "7.2.1 传感装置的外壳应完整。\n检查数量：全数检查。";
const secondClause = "7.2.2 本节检查数量的计数单位为件。";
const markdown = `# 7 检测设施\n## 7.2 传感装置\n${firstClause}\n${secondClause}`;

function fixture(source = markdown) {
  const evidence = buildDocumentEvidence(source, "synthetic.md");
  const atom = evidence.atoms[0]!;
  let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [{ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }]);
  const locate = (quote: string) => {
    const result = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
    registry = result.registry;
    return result.spans[0]!.span_id;
  };
  const primary = locate(firstClause.replaceAll("\n", source.includes("\r\n") ? "\r\n" : "\n"));
  const context = locate(source.slice(source.indexOf("7.2.2")));
  const selectors = initialDocumentSelectorPlan("job");
  selectors.targets = [{
    key: "sensor", name: "传感装置", group_key: "facilities", group_name: "检测设施", group_reason: "按受检设施分组",
    lot_basis_summary: "检查外壳完整性", scope_span_ids: [primary], lot_basis_span_ids: [primary], reason: "外壳是具体受检对象",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: primary, start_span_id: primary, end_span_id: primary, reason: "本条完整的实体要求" }],
    semantic_basis: { subject: "传感装置", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [primary], acceptance_reason: "原文规定外壳完整性", boundary_reason: "后文是计数说明，由复核者判断是否需要另建目标" },
  }];
  selectors.contexts = [{ key: "counting", role: "governing_rule", name: "计数说明", span_ids: [context], reason: "本条说明计数单位，未另列受检对象" }];
  selectors.dispositions = [{ atom_span_id: registry.spans.find((span) => span.start === 0 && span.end === atom.text.length)!.span_id, disposition: "target", target_keys: ["sensor"], reason: "原子同时包含实体目标与上下文" }];
  const ledger = scanDocumentLedger(source, "synthetic.md");
  const plan = compileDocumentSelectors(selectors, registry, evidence, "job");
  return { evidence, registry, selectors, ledger, plan };
}

describe("source-bound discovery work queue", () => {
  test.each(["\n", "\r\n"])("merger chunk metadata does not fabricate a missing requirement with %j line endings", newline => {
    const f = fixture(markdown.replace(`\n${secondClause}`, `\n\n\n<!-- pages_301_320 -->\n\n${secondClause}`).replaceAll("\n", newline));
    const obligations = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry);
    expect(obligations.map(entry => entry.clause_id)).toEqual(["7.2.2"]);
    expect(evaluateDiscoveryLedgerAgreement(f.plan, f.ledger, f.evidence.atoms, ["7.2.2"]))
      .toMatchObject({ complete: true, uncovered_clause_ids: [], unclaimed_candidate_clause_ids: [] });
  });

  test.each([
    "检验方法：尺寸量测。\n\n<!-- pages_301_320 -->",
    "<!-- pages_301_320 -->\n\n检验方法：尺寸量测。",
    "<!-- pages_301_320 -->\n\n<table><tr><td>允许偏差</td><td>2mm</td></tr></table>",
    "<!-- 产品须逐件检验 -->",
    "注：<!-- pages_301_320 --> 应保留这一说明。",
  ])("real content near or resembling chunk metadata remains a blocking source gap: %s", extra => {
    const f = fixture(markdown.replace(`\n${secondClause}`, `\n\n${extra}\n\n${secondClause}`));
    const obligations = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry);
    expect(obligations.find(entry => entry.clause_id === "7.2.1")!.missing_ranges.length).toBeGreaterThan(0);
    expect(evaluateDiscoveryLedgerAgreement(f.plan, f.ledger, f.evidence.atoms, ["7.2.2"]).uncovered_clause_ids).toContain("7.2.1");
  });

  test("a truncated real last line before a merger marker still blocks coverage", () => {
    const f = fixture(markdown.replace(`\n${secondClause}`, `\n\n<!-- pages_301_320 -->\n\n${secondClause}`));
    const fragment = f.plan.targets[0]!.work_scope!.primary_fragments![0]!;
    fragment.end -= 2; fragment.text = fragment.text.slice(0, -2);
    const missing = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry)
      .find(entry => entry.clause_id === "7.2.1")!;
    expect(missing.missing_ranges).toMatchObject([{ excerpt: firstClause.slice(-2) }]);
    expect(evaluateDiscoveryLedgerAgreement(f.plan, f.ledger, f.evidence.atoms, ["7.2.2"]).uncovered_clause_ids).toContain("7.2.1");
  });

  test("context overlap remains pending; a reviewed decision is bound to the exact context", () => {
    const f = fixture();
    const read = (decisions: DiscoveryDecision[] = []) => discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry, decisions);
    const obligation = read()[0]!;
    expect(read()).toMatchObject([{ clause_id: "7.2.2", status: "pending", contexts: [{ key: "counting" }] }]);
    const decision: DiscoveryDecision = { clause_id: obligation.clause_id, disposition: "context", context_key: "counting", reason: "独立阅读确认只是单位解释", binding_fingerprint: obligation.contexts[0]!.binding_fingerprint };
    expect(read([decision])[0]!.status).toBe("resolved_context");
    f.selectors.contexts[0]!.reason = "尚需重新核对适用范围";
    expect(read([decision])[0]!.status).toBe("pending");
    expect(read([{ ...decision, disposition: "pending" }])[0]!.status).toBe("pending");
  });

  test("candidate clauses without quantity keywords also require a semantic decision", () => {
    const f = fixture(markdown.replace(secondClause, "7.2.2 装置的显示应清晰。"));
    expect(discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry)).toMatchObject([
      { clause_id: "7.2.2", status: "pending" },
    ]);
  });

  test("partial text on the last line cannot discharge a source clause", () => {
    const f = fixture();
    const fragment = f.plan.targets[0]!.work_scope!.primary_fragments![0]!;
    fragment.end -= 2;
    fragment.text = fragment.text.slice(0, -2);
    const obligations = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry);
    expect(obligations.map((entry) => entry.clause_id)).toEqual(["7.2.1", "7.2.2"]);
    expect(obligations[0]).toMatchObject({ missing_range_count: 1, missing_ranges: [{
      start: fragment.end, end: fragment.end + 2, start_line: 4, end_line: 4, excerpt: firstClause.slice(-2),
    }] });
  });

  test("deleting a target reopens its clauses even if another context was reviewed", () => {
    const f = fixture();
    const obligation = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry)[0]!;
    const decisions: DiscoveryDecision[] = [{ clause_id: obligation.clause_id, disposition: "context", context_key: "counting", reason: "计数定义", binding_fingerprint: obligation.contexts[0]!.binding_fingerprint }];
    f.plan.targets = [];
    const pending = discoveryObligations(f.plan, f.selectors, f.ledger, f.evidence, f.registry, decisions).filter((entry) => entry.status === "pending");
    expect(pending.map((entry) => entry.clause_id)).toEqual(["7.2.1"]);
  });

  test("keyed edits resolve changing array positions and reject an invalid batch atomically", async () => {
    const root = resolve(".tmp-tests", `discovery-keyed-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "synthetic.md");
    await writeFile(path, markdown, "utf8");
    const f = fixture();
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(f.selectors));
    const controller = await DocumentDiscoveryController.create(workspace);
    const context = f.selectors.contexts[0]!;
    expect(await controller.dispatch("edit_document_selectors", { edits: [
      { collection: "contexts", key: "first", op: "upsert", value: { ...context, key: "first" } },
      { collection: "contexts", key: "second", op: "upsert", value: { ...context, key: "second" } },
      { collection: "contexts", key: "first", op: "remove" },
      { collection: "contexts", key: "second", op: "upsert", value: { ...context, key: "second", name: "修订说明" } },
    ] })).toMatchObject({ ok: true });
    const saved = await readFile(workspace.workingSelectorPath, "utf8");
    expect(JSON.parse(saved).contexts.map((entry: { key: string }) => entry.key)).toEqual(["counting", "second"]);
    expect(await controller.dispatch("read_document_selectors", { collection: "dispositions", key: f.selectors.dispositions[0]!.atom_span_id })).toMatchObject({ rows: [f.selectors.dispositions[0]] });
    expect(await controller.dispatch("edit_document_selectors", { edits: [
      { collection: "contexts", key: "second", op: "remove" },
      { collection: "contexts", key: "missing", op: "remove" },
    ] })).toMatchObject({ ok: false, error: "selector_edit_key_missing", actual: "missing" });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(saved);
  });

  test("an unclassified window is durable checkpoint work rather than a rejected edit", async () => {
    const source = `${markdown}\n# 8 连接设施\n## 8.3 连接件\n8.3.1 连接应牢固。\n检查数量：全数检查。`;
    const root = resolve(".tmp-tests", `discovery-window-pending-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "synthetic.md");
    await writeFile(path, source, "utf8");
    const f = fixture(source);
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(f.selectors));
    const controller = await DocumentDiscoveryController.create(workspace);
    expect(await controller.dispatch("edit_document_selectors", { edits: [{ collection: "contexts", key: "counting", op: "remove" }] })).toMatchObject({ ok: true, final_compile_ready: false, pending_window_count: 1 });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).contexts).toEqual([]);
    expect(await controller.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_discovery_window_unclassified" })]) });
  });

  test("a false-positive numbered candidate can end with zero targets after author classification", async () => {
    const source = "# 6 测试说明\n## 6.2 计数约定\n6.2.1 检查数量的计数单位为件。";
    const root = resolve(".tmp-tests", `discovery-context-only-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "synthetic.md");
    await writeFile(path, source, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
    const registry = await workspace.readSourceSpanRegistry();
    const span = registry.spans.find((entry) => entry.start === 0 && entry.end === source.length)!.span_id;
    const selectors = initialDocumentSelectorPlan("job");
    selectors.no_target_reason = "全文只有计数单位约定，没有受检对象及其质量要求";
    selectors.contexts = [{ key: "units", role: "definition", name: "计数单位", span_ids: [span], reason: "只解释单位" }];
    selectors.dispositions = [{ atom_span_id: span, disposition: "context", target_keys: [], reason: "全文为单位约定" }];
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
    const author = await DocumentDiscoveryController.create(workspace);
    const atomId = author.evidence.atoms[0]!.atom_id;
    await author.dispatch("open_document_atom", { atom_id: atomId });
    expect(await author.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_coverage_unresolved" });
    expect(await author.dispatch("record_discovery_decisions", { decisions: [{ clause_id: "6.2.1", disposition: "context", context_key: "units", reason: "原文只是计数定义，关键词未构成验收目标" }] })).toMatchObject({ ok: true });
    const validated = await author.dispatch("compile_document_selectors", {});
    expect(validated.ok).toBe(true);
    expect(await author.dispatch("seal_discovery_plan", { fingerprint: validated.fingerprint })).toMatchObject({ ok: true, target_count: 0 });
  }, 30_000);

  test("the legacy reviewer resolves, invalidates and seals exclusions before extraction", async () => {
    const root = resolve(".tmp-tests", `discovery-obligations-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "synthetic.md");
    await writeFile(path, markdown, "utf8");
    const f = fixture();
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry), "utf8");
    await workspace.writeWorkingSelectors(prettyJson(f.selectors));
    await workspace.setRuntime({ kind: "offline-scripted", session_id: "legacy-author", session_file: "legacy-author.jsonl" });
    const author = await DocumentDiscoveryController.create(workspace);
    const reviewer = await DocumentDiscoveryController.create(workspace, "review");
    expect(createDocumentDiscoveryTools(author).map((tool) => tool.name)).toContain("record_discovery_decisions");
    expect(createDocumentDiscoveryTools(reviewer).map((tool) => tool.name)).toContain("record_discovery_decisions");
    await author.dispatch("batch_open_document_atoms", { atom_ids: f.evidence.atoms.map((atom) => atom.atom_id) });
    const pending = await author.dispatch("patch_document_selectors", { operations: [{ op: "replace", path: "/dispositions/0/disposition", value: "pending" }] });
    expect(pending).toMatchObject({ ok: true, final_compile_ready: false, pending_disposition_count: 1 });
    expect(await author.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_disposition_pending" })]) });
    await author.dispatch("patch_document_selectors", { operations: [{ op: "replace", path: "/dispositions/0/disposition", value: "target" }] });
    const candidate = await author.dispatch("compile_document_selectors", {});
    expect(candidate.ok).toBe(true);
    expect(await author.dispatch("submit_discovery_candidate", { fingerprint: candidate.fingerprint })).toMatchObject({ ok: true });
    const decision = { clause_id: "7.2.2", disposition: "context", context_key: "counting", reason: "阅读整条及前后文，确认是计数单位说明，不另建目标" };
    expect(await author.dispatch("record_discovery_decisions", { decisions: [decision] })).toMatchObject({ ok: false, error: "discovery_decision_phase_forbidden" });
    expect(await reviewer.dispatch("record_discovery_decisions", { decisions: [decision] })).toMatchObject({ ok: false, error: "discovery_decision_source_unread" });
    await reviewer.dispatch("batch_open_document_atoms", { atom_ids: f.evidence.atoms.map((atom) => atom.atom_id) });
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_coverage_unresolved", pending_clause_ids: ["7.2.2"] });
    expect((await workspace.readState()).reviewer_validation_attempts).toBe(0);
    expect(await reviewer.dispatch("record_discovery_decisions", { decisions: [{ ...decision, context_key: "unknown" }] })).toMatchObject({ ok: false, error: "invalid_discovery_decision" });
    expect(await reviewer.dispatch("record_discovery_decisions", { decisions: [{ ...decision, disposition: "pending" }] })).toMatchObject({ ok: true });
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_coverage_unresolved" });
    expect(await reviewer.dispatch("record_discovery_decisions", { decisions: [decision] })).toMatchObject({ ok: true });
    expect(await reviewer.dispatch("read_discovery_obligations", {})).toMatchObject({
      pending_count: 0, ledger_agreement: { skip_reviewer: true, uncovered_clause_ids: [], unclaimed_candidate_clause_ids: [], overlapping_clause_ids: [] },
    });
    const reviewed = await reviewer.dispatch("compile_document_selectors", {});
    expect(reviewed.ok).toBe(true);
    await reviewer.dispatch("patch_document_selectors", { operations: [{ op: "replace", path: "/contexts/0/reason", value: "本条解释计数口径" }] });
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: false, error: "discovery_selectors_changed" });
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_coverage_unresolved" });
    const resumedReviewer = await DocumentDiscoveryController.create(workspace, "review");
    expect(await resumedReviewer.dispatch("read_discovery_obligations", {})).toMatchObject({ pending_count: 1 });
    await resumedReviewer.dispatch("record_discovery_decisions", { decisions: [decision] });
    const revalidated = await resumedReviewer.dispatch("compile_document_selectors", {});
    expect(revalidated.ok).toBe(true);
    // A pending decision cannot reuse an earlier successful validation either.
    await resumedReviewer.dispatch("record_discovery_decisions", { decisions: [{ ...decision, disposition: "pending" }] });
    expect(await resumedReviewer.dispatch("seal_discovery_plan", { fingerprint: revalidated.fingerprint })).toMatchObject({ ok: false, error: "discovery_coverage_unresolved" });
    await resumedReviewer.dispatch("record_discovery_decisions", { decisions: [decision] });
    expect(await resumedReviewer.dispatch("seal_discovery_plan", { fingerprint: revalidated.fingerprint })).toMatchObject({ ok: true });
    const receipt = JSON.parse(await readFile(workspace.sealReceiptPath, "utf8"));
    expect(receipt.coverage_review).toMatchObject({ excluded_clause_ids: ["7.2.2"], decisions: [decision] });
    const batchInput = { ledger: f.ledger, targets: [], items: [{ source_clause: "7.2.1", requirement: firstClause }] };
    expect(batchLedgerGapFrom(batchInput).gap?.missing_clause_ids).toContain("7.2.2");
    expect(batchLedgerGapFrom({ ...batchInput, discovery_context_clause_ids: receipt.coverage_review.excluded_clause_ids }).gap).toBeUndefined();
    const window = f.ledger.windows.find((entry) => entry.number === "7.2")!;
    expect(evaluateTargetLedgerCoverage({ ledger: f.ledger, start_line: window.start_line, end_exclusive_line: window.end_exclusive_line, source_clauses: ["7.2.1"], not_item_clause_ids: receipt.coverage_review.excluded_clause_ids }).gap_clause_ids).toEqual([]);
  }, 30_000);
});

describe("physical ledger heading ownership", () => {
  test.each(["4.6", "8.3", "12.7"])("a later repeated heading cannot invert section %s", (number) => {
    const source = [
      `# ${number.split(".")[0]} 检测设施`,
      `${number} 传感装置`,
      `${number}.1 外壳应完整。`,
      "检查数量：全数检查。",
      "# 后续说明",
      `## ${number} 传感装置`,
      `${number}.1 本段解释正文。`,
    ].join("\n");
    const ledger = scanDocumentLedger(source, "repeated-heading.md");
    const window = ledger.windows.find((entry) => entry.number === number)!;
    // The first flat heading has its own child-clause witness. The later
    // repeated Markdown heading must not steal this physical occurrence.
    expect(window).toMatchObject({ start_line: 2, end_exclusive_line: 5 });
    expect(discoveryScopeWindows(ledger).find((entry) => entry.number === number)).toMatchObject({ start_line: 2, end_exclusive_line: 5 });
    expect(ledger.windows.every((entry) => entry.start_line < entry.end_exclusive_line)).toBe(true);
  });

  test("a matching body heading wins over a matching table-of-contents heading", () => {
    const source = "## 8.3 传感装置\n## 8.4 控制装置\n# 8 检测设施\n## 8.3 传感装置\n8.3.1 外壳应完整。\n检查数量：全数检查。";
    expect(scanDocumentLedger(source, "contents.md").windows.find((entry) => entry.number === "8.3")).toMatchObject({ start_line: 4 });
  });

  test("invalid persisted discovery windows produce an actionable harness issue", () => {
    const f = fixture();
    expect(() => compileDocumentSelectors(f.selectors, f.registry, f.evidence, "job", {
      discoveryScopeCandidates: [{ window_id: "window:broken", number: "7.2", title: "传感装置", start_line: 5, end_exclusive_line: 2 }],
    })).toThrow(/selector_discovery_window_invalid/);
  });
});
