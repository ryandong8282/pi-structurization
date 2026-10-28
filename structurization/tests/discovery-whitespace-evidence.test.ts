import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDocumentEvidence, DocumentDiscoveryController, DocumentDiscoveryWorkspace, validateDocumentTargetPlan } from "../src/document-discovery.js";
import { bindDiscoverySources, resolveDiscoveryAliases } from "../src/discovery-source-bindings.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors, DocumentSelectorCompileError, initialDocumentSelectorPlan, type DocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { SourceSpanRegistryError, registryWithFullSourceSpans } from "../src/source-span-registry.js";

function sourceFixture(newline: string, blank: string, atomChars = 6_000) {
  const first = (`7.2.1 传感器应安装牢固。${newline}检查方法：`).padEnd(atomChars - newline.length, "查") + newline;
  const second = `7.2.2 接插件应牢固。${newline}`;
  return { first, second, source: first + blank + second };
}

function target(key: string, alias: string, name: string): DocumentSelectorPlan["targets"][number] {
  return { key, group_key: "devices", group_name: "检测设备", group_reason: "按受检设备归组", name,
    lot_basis_summary: "本段规定设备安装质量要求", scope_span_ids: [alias], lot_basis_span_ids: [alias], reason: "具体设备的质量判据",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: alias, start_span_id: alias, end_span_id: alias, reason: "完整物理条文" }],
    semantic_basis: { subject: name, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [alias],
      acceptance_reason: "原文有明确质量判据", boundary_reason: "两个受检对象分别验收" } };
}

function compileFixture(newline = "\n", blank = "\n") {
  const source = sourceFixture(newline, blank);
  const evidence = buildDocumentEvidence(source.source, "source.md");
  const opened = new Set(evidence.atoms.map(atom => atom.atom_id));
  const initialRegistry = registryWithFullSourceSpans(evidence.evidence_fingerprint,
    evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
  const bound = bindDiscoverySources([
    { key: "first", start_line: 1, extent: "clause" },
    { key: "second", start_line: 4, extent: "clause" },
  ], evidence, scanDocumentLedger(source.source, "source.md"), opened, initialRegistry);
  const selectors = initialDocumentSelectorPlan("test");
  selectors.targets = resolveDiscoveryAliases([target("sensor", "$first", "传感器"), target("connector", "$second", "接插件")], bound.aliases) as typeof selectors.targets;
  selectors.dispositions = evidence.atoms.map((atom, index) => ({
    atom_span_id: initialRegistry.spans[index]!.span_id, disposition: "target", target_keys: [index === 0 ? "sensor" : "connector"], reason: "本原子包含设备要求",
  }));
  return { ...source, evidence, opened, selectors, registry: bound.registry, blankSpan: bound.aliases.get("first")!.span_ids[1]! };
}

describe("discovery whitespace-only evidence", () => {
  test.each([undefined, "lines"] as const)("a missing exclusive end for extent=%s identifies the exact field without guessing or retaining partial bindings", extent => {
    const source = "设备外壳应完好。\n接插件应牢固。\n";
    const evidence = buildDocumentEvidence(source, "neutral.md");
    const opened = new Set(evidence.atoms.map(atom => atom.atom_id));
    const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint,
      evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
    const before = JSON.stringify(registry);
    const bindings = [{ key: "first", start_line: 1, end_exclusive_line: 2 }, { key: "second", start_line: 2, extent }];
    try {
      bindDiscoverySources(bindings, evidence, scanDocumentLedger(source, "neutral.md"), opened, registry);
      expect.fail("lines extent must require an explicit end");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSpanRegistryError);
      expect((error as SourceSpanRegistryError).issues).toMatchObject([{
        code: "discovery_binding_end_line_required", details: {
          actual: { key: "second", start_line: 2, end_exclusive_line: null, source_line_count: 3 },
          writable_path: "/source_bindings/1/end_exclusive_line",
          expected: { end_exclusive_line: "integer", greater_than: 2, maximum: 4 },
          next_tool: "open_document_atom", next_tool_arguments: { atom_id: evidence.atoms[0]!.atom_id },
          save_tool: "edit_document_selectors",
        },
      }]);
    }
    expect(JSON.stringify(registry)).toBe(before);
    const fixed = bindDiscoverySources([bindings[0]!, { ...bindings[1]!, end_exclusive_line: 3 }],
      evidence, scanDocumentLedger(source, "neutral.md"), opened, registry);
    expect(fixed.aliases.get("second")!.span_ids).toHaveLength(1);
  });

  test.each([["\n", "\n"], ["\r\n", "\r\n"], ["\n", " \t\n"]])("ignores a separate blank citation but preserves all %j / %j source bytes", (newline, blank) => {
    const f = compileFixture(newline!, blank!);
    expect(f.evidence.atoms).toHaveLength(2);
    expect(f.selectors.targets[0]!.scope_span_ids).toContain(f.blankSpan);
    const before = JSON.stringify({ selectors: f.selectors, registry: f.registry, evidence: f.evidence });
    const plan = compileDocumentSelectors(f.selectors, f.registry, f.evidence, "test", { requireSemanticBasis: true });
    expect(validateDocumentTargetPlan(plan, f.evidence, "test", f.opened)).toMatchObject({ ok: true, issues: [] });
    const first = plan.targets[0]!;
    expect(first.evidence_atom_ids).toEqual([f.evidence.atoms[0]!.atom_id]);
    expect(first.evidence_fragments.map(fragment => fragment.text)).toEqual([f.first]);
    expect(first.materialization.lot_basis_fragments.map(fragment => fragment.text)).toEqual([f.first]);
    expect(first.work_scope!.primary_fragments!.map(fragment => fragment.text).join("")).toBe(f.first + blank);
    expect(first.work_scope!.source_blocks![0]!.end_fragment!.text).toBe(blank);
    expect(JSON.stringify({ selectors: f.selectors, registry: f.registry, evidence: f.evidence })).toBe(before);
  });

  test.each(["scope_span_ids", "lot_basis_span_ids"] as const)("rejects an entirely blank %s with an actionable selector address", (field) => {
    const f = compileFixture();
    f.selectors.targets[0]![field] = [f.blankSpan];
    try {
      compileDocumentSelectors(f.selectors, f.registry, f.evidence, "test", { requireSemanticBasis: true });
      expect.fail("blank-only evidence must not establish a target or lot basis");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSelectorCompileError);
      expect((error as DocumentSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: field === "scope_span_ids" ? "selector_target_scope_missing" : "selector_lot_basis_missing",
        path: `/targets/0/${field}`,
        details: expect.objectContaining({ target_key: "sensor", writable_path: `/targets/0/${field}`,
          actual: [{ span_id: f.blankSpan, atom_id: f.evidence.atoms[1]!.atom_id, text: "\n" }],
          next_tool: "edit_document_selectors", required_action: expect.stringContaining(field) }),
      }));
    }
  });

  test("validates a blank span's provenance before ignoring it", () => {
    const f = compileFixture();
    f.registry.spans.find(span => span.span_id === f.blankSpan)!.text_sha256 = "forged";
    expect(() => compileDocumentSelectors(f.selectors, f.registry, f.evidence, "test")).toThrow(DocumentSelectorCompileError);
  });

  test("preflight, candidate and independent seal agree without blank-line retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-blank-evidence-"));
    try {
      const source = sourceFixture("\n", "\n");
      const markdownPath = join(root, "source.md");
      await writeFile(markdownPath, source.source);
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "test", markdownPath);
      await workspace.writeWorkingSelectors(JSON.stringify(initialDocumentSelectorPlan("test")));
      await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
      const author = await DocumentDiscoveryController.create(workspace);
      const atomIds = author.evidence.atoms.map(atom => atom.atom_id);
      const atomSpans = (await workspace.readSourceSpanRegistry()).spans;
      await author.dispatch("batch_open_document_atoms", { atom_ids: atomIds });
      const request = { source_bindings: [{ key: "first", start_line: 1, extent: "clause" }, { key: "second", start_line: 4, extent: "clause" }], edits: [
        { collection: "targets", key: "sensor", op: "upsert", value: target("sensor", "$first", "传感器") },
        { collection: "targets", key: "connector", op: "upsert", value: target("connector", "$second", "接插件") },
        ...atomIds.map((atomId, index) => ({ collection: "dispositions", key: atomSpans.find(span => span.atom_id === atomId)!.span_id, op: "upsert",
          value: { disposition: "target", target_keys: [index === 0 ? "sensor" : "connector"], reason: "本原子包含设备要求" } })),
      ] };
      const before = await workspace.readState();
      const preflight = await author.dispatch("edit_document_selectors", { ...request, dry_run: true });
      expect(preflight).toMatchObject({ ok: true, saved: false, final_compile_ready: true });
      expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
      expect(await author.dispatch("edit_document_selectors", { draft_id: preflight.draft_id, edits: [] }))
        .toMatchObject({ ok: true, saved: true, final_compile_ready: true });
      const savedText = await readFile(workspace.workingSelectorPath, "utf8");
      const blankSpan = JSON.parse(savedText).targets[0].lot_basis_span_ids[1];
      const registryText = await readFile(workspace.sourceSpanRegistryPath, "utf8");
      const rejected = await author.dispatch("edit_document_selectors", { edits: [
        { collection: "targets", key: "sensor", op: "update", value: { lot_basis_span_ids: [blankSpan] } },
      ] });
      expect(rejected).toMatchObject({ ok: false, saved: false, selector_issues: expect.arrayContaining([
        expect.objectContaining({ code: "selector_lot_basis_missing", details: expect.objectContaining({ target_key: "sensor", next_tool: "edit_document_selectors" }) }),
      ]) });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(savedText);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryText);
      expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
      expect(await author.dispatch("discard_document_selector_draft", { draft_id: rejected.draft_id }))
        .toMatchObject({ ok: true, saved: false, draft_retained: false });
      const compiled = await author.dispatch("compile_document_selectors", {});
      expect(compiled).toMatchObject({ ok: true });
      expect(await author.dispatch("submit_discovery_candidate", { fingerprint: compiled.fingerprint })).toMatchObject({ ok: true });
      const reviewer = await DocumentDiscoveryController.create(workspace, "review");
      await reviewer.dispatch("batch_open_document_atoms", { atom_ids: atomIds });
      const reviewed = await reviewer.dispatch("compile_document_selectors", {});
      expect(reviewed).toMatchObject({ ok: true });
      expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: true, target_count: 2 });
      expect(await workspace.readState()).toMatchObject({ status: "sealed", validation_attempts: 1, reviewer_validation_attempts: 1 });
      expect(JSON.parse(await readFile(workspace.workingPlanPath, "utf8")).targets[0].work_scope.primary_fragments.map((fragment: { text: string }) => fragment.text).join("")).toBe(source.first + "\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
