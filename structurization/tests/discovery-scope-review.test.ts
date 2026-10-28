import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { prettyJson } from "../src/canonical.js";
import { buildDocumentEvidence, DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { discoveryScopeWindows, scanDocumentLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors, discoveryScopeReviewHints, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";

// Invented objects and variable numbering: no production document or answer inventory.
function fixture(chapter = 7, middleHeading: string | null = "", count = 4, interruptFlatWitness = false) {
  const sections = Array.from({ length: count }, (_, index) => {
    const number = `${chapter}.${index + 2}`;
    const name = `检测装置${index + 1}`;
    const marker = index === 0 || index === count - 1 ? "## " : middleHeading;
    const criterion = `${number}.1 ${name}的外壳应完整。\n检查数量：全数检查。`;
    const heading = marker === null ? "" : `${marker}${number} ${name}\n`;
    // A nonblank OCR interruption deliberately prevents the adjacent child
    // clause from proving a flat heading. Keep uncertain-boundary fixtures
    // separate from plain headings which the ledger can now identify.
    const interruption = interruptFlatWitness && marker === "" ? "本页版式标识。\n" : "";
    return { name, criterion, text: `${heading}${interruption}${criterion}\n` };
  });
  const source = `# ${chapter} 检测设施\n${sections.map(section => section.text).join("\n")}`;
  const evidence = buildDocumentEvidence(source, "synthetic.md");
  const atom = evidence.atoms[0]!;
  let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [{ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }]);
  const fullSpan = registry.spans[0]!.span_id;
  const locate = (quote: string) => {
    const located = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
    registry = located.registry;
    return located.spans[0]!.span_id;
  };
  const selectors = initialDocumentSelectorPlan("job");
  selectors.targets = sections.map((section, index) => {
    const span = locate(section.text + (index < sections.length - 1 ? "\n" : ""));
    const criterion = locate(section.criterion);
    return {
      key: `device-${index}`, name: section.name, group_key: "facilities", group_name: "检测设施", group_reason: "按设施分组",
      lot_basis_summary: "外壳完整性验收", scope_span_ids: [span], lot_basis_span_ids: [criterion], reason: "独立装置具有具体质量要求",
      source_blocks: [{ kind: "explicit_range", anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "按本装置原文明确范围" }],
      semantic_basis: { subject: section.name, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [criterion], acceptance_reason: "原文要求本装置外壳完整", boundary_reason: "本段约束该装置，相邻段约束另一独立装置" },
    };
  });
  selectors.dispositions = [{ atom_span_id: fullSpan, disposition: "target", target_keys: selectors.targets.map(target => target.key), reason: "全文装置均已分配" }];
  const ledger = scanDocumentLedger(source, "synthetic.md");
  const windows = discoveryScopeWindows(ledger);
  return { source, evidence, registry, selectors, windows };
}

async function workspaceFor(f: ReturnType<typeof fixture>) {
  const root = resolve(".tmp-tests", `discovery-scope-review-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "synthetic.md");
  await writeFile(path, f.source, "utf8");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "job", path);
  await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry), "utf8");
  await workspace.writeWorkingSelectors(prettyJson(f.selectors));
  await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
  return workspace;
}

describe("semantic review owns candidate window disagreements", () => {
  test.each([7, 12, 23])("missing heading markers do not veto source-bound targets in chapter %i", chapter => {
    for (const marker of ["## ", "", null]) {
      const f = fixture(chapter, marker);
      const plan = compileDocumentSelectors(f.selectors, f.registry, f.evidence, "job", { requireSemanticBasis: true, discoveryScopeCandidates: f.windows });
      expect(plan.targets).toHaveLength(4);
      const hints = discoveryScopeReviewHints(plan, f.selectors, f.evidence, f.windows);
      if (marker !== null) {
        // Both Markdown headings and witnessed flat headings have known
        // physical boundaries; neither should manufacture review conflicts.
        expect(hints).toEqual([]);
        expect(f.windows[0]!.end_exclusive_line).toBeLessThanOrEqual(f.windows[1]!.start_line);
      }
      else {
        // Truly absent headings still leave heuristic overlap for semantic review.
        expect(f.windows[0]!.end_exclusive_line).toBeGreaterThan(f.windows[1]!.start_line);
        expect(hints).toEqual(expect.arrayContaining([expect.objectContaining({ target: { key: "device-1", name: "检测装置2" } })]));
        expect(hints[0]!.source_atom_ids).toEqual([f.evidence.atoms[0]!.atom_id]);
      }
    }
  });

  test.each([null, ""])("a valid checkpoint survives conflicting candidates and independent review (heading marker %j)", async marker => {
    const f = fixture(7, marker, 4, true);
    const hintCount = marker === null ? 2 : 4;
    const workspace = await workspaceFor(f);
    const author = await DocumentDiscoveryController.create(workspace);
    const change = { edits: [{ collection: "targets", key: "device-3", op: "update", value: { reason: "核对原文后保留独立装置范围" } }] };
    expect(await author.dispatch("edit_document_selectors", change)).toMatchObject({ ok: true, saved: true, final_compile_ready: true, scope_review_hint_count: hintCount });
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).targets[3].reason).toBe("核对原文后保留独立装置范围");
    const pending = await author.dispatch("read_discovery_obligations", {});
    expect(pending).toMatchObject({ pending_count: 0, ledger_agreement: { complete: true }, scope_review_hint_count: hintCount, scope_review_hints: expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ key: "device-1" }) })]) });
    await author.dispatch("batch_open_document_atoms", { atom_ids: f.evidence.atoms.map(atom => atom.atom_id) });
    const compiled = await author.dispatch("compile_document_selectors", {});
    expect(compiled).toMatchObject({ ok: true, scope_review_hint_count: hintCount, next_tool: "seal_discovery_plan" });
    expect(await author.dispatch("submit_discovery_candidate", { fingerprint: compiled.fingerprint })).toMatchObject({ ok: true });

    const reviewer = await DocumentDiscoveryController.create(workspace, "review");
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: compiled.fingerprint })).toMatchObject({ ok: false });
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false });
    await reviewer.dispatch("batch_open_document_atoms", { atom_ids: f.evidence.atoms.map(atom => atom.atom_id) });
    expect(await reviewer.dispatch("read_discovery_obligations", {})).toMatchObject({ scope_review_hint_count: hintCount });
    // Scripted semantic verdict: keep the independently checked source-bound split.
    const reviewed = await reviewer.dispatch("compile_document_selectors", {});
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: true, target_count: 4 });
    const receipt = JSON.parse(await readFile(workspace.sealReceiptPath, "utf8"));
    expect(receipt.coverage_review.scope_review_hints).toHaveLength(hintCount);
    if (marker === "") expect(receipt.coverage_review.scope_review_hints).toContainEqual(expect.objectContaining({
      code: "candidate_clause_split_across_targets", clause_id: "7.2.1",
      targets: expect.arrayContaining([expect.objectContaining({ key: "device-0" }), expect.objectContaining({ key: "device-1" })]),
    }));
    expect(await readFile(workspace.sourcePath, "utf8")).toBe(f.source);
  }, 30_000);

  test("true primary overlap and invalid source spans still reject edits atomically", async () => {
    const f = fixture();
    const workspace = await workspaceFor(f);
    const author = await DocumentDiscoveryController.create(workspace);
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const overlapping = { ...f.selectors.targets[0]!, key: "device-1", name: "另一个装置" };
    const rejectedOverlap = await author.dispatch("edit_document_selectors", { edits: [{ collection: "targets", key: "device-1", op: "upsert", value: overlapping }] });
    expect(rejectedOverlap).toMatchObject({
      ok: false, selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_target_primary_overlap" })]),
    });
    // Test the span rejection independently, not the pending-transaction guard.
    expect(await author.dispatch("discard_document_selector_draft", { draft_id: rejectedOverlap.draft_id })).toMatchObject({ ok: true });
    expect(await author.dispatch("edit_document_selectors", { edits: [{ collection: "targets", key: "device-1", op: "update", value: { scope_span_ids: ["missing-span"] } }] })).toMatchObject({
      ok: false, selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_span_id_format" })]),
    });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  });

  test("window hints paginate even when no clauses are pending", async () => {
    const f = fixture(17, "", 14, true);
    const workspace = await workspaceFor(f);
    const author = await DocumentDiscoveryController.create(workspace);
    const first = await author.dispatch("read_discovery_obligations", {});
    expect(first).toMatchObject({ pending_count: 0, scope_review_hint_count: 24, next_cursor: 10 });
    expect(first.scope_review_hints).toHaveLength(10);
    const second = await author.dispatch("read_discovery_obligations", { cursor: first.next_cursor });
    expect(second).toMatchObject({ pending_count: 0, scope_review_hint_count: 24, next_cursor: 20 });
    expect(second.scope_review_hints).toHaveLength(10);
    const third = await author.dispatch("read_discovery_obligations", { cursor: second.next_cursor });
    expect(third).toMatchObject({ pending_count: 0, scope_review_hint_count: 24, next_cursor: null });
    expect(third.scope_review_hints).toHaveLength(4);
  });
});
