import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Json } from "../src/canonical.js";
import { buildDocumentEvidence, createDocumentDiscoveryTools, DocumentDiscoveryController, DocumentDiscoveryWorkspace, validateDocumentTargetPlan } from "../src/document-discovery.js";
import { bindDiscoverySources, resolveDiscoveryAliases } from "../src/discovery-source-bindings.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { documentSelectorFingerprint, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";

async function fixture(markdown: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-discovery-perf-"));
  const path = join(root, "source.md");
  await writeFile(path, markdown);
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "test", path);
  await workspace.writeWorkingSelectors(JSON.stringify(initialDocumentSelectorPlan("test")));
  await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
  const controller = await DocumentDiscoveryController.create(workspace);
  const atom = controller.evidence.atoms[0]!;
  const atomSpan = (await workspace.readSourceSpanRegistry()).spans.find(span => span.start === 0 && span.end === atom.text.length)!.span_id;
  return { workspace, controller, atom, atomSpan };
}

function target(key: string, alias: string, name = "传感器") {
  return { key, group_key: "devices", group_name: "检测设备", group_reason: "按受检设备归组", name,
    lot_basis_summary: "本段规定具体设备的质量要求", scope_span_ids: [alias], lot_basis_span_ids: [alias], reason: "具体实体要求",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: alias, start_span_id: alias, end_span_id: alias, reason: "确认完整物理条文" }],
    semantic_basis: { subject: name, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [alias],
      acceptance_reason: "原文有明确质量判据", boundary_reason: "按实际受检对象独立判断" } };
}

describe("discovery transactions and mechanical source bindings", () => {
  test("reviewer narrowing reopens global coverage, including the final seal after a local-only validation", async () => {
    const f = await fixture("7.2.1 传感器外壳应完好。\n检查数量：全数。\n7.2.2 连接点应牢固。\n检查数量：全数。\n");
    await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const complete = { source_bindings: [{ key: "whole", start_line: 1, end_exclusive_line: 5 }], edits: [
      { collection: "targets", key: "sensor", op: "upsert", value: target("sensor", "$whole") },
      { collection: "dispositions", key: f.atomSpan, op: "upsert", value: { atom_span_id: f.atomSpan, disposition: "target", target_keys: ["sensor"], reason: "设备全部实体要求" } },
    ] };
    expect(await f.controller.dispatch("edit_document_selectors", complete)).toMatchObject({ ok: true });
    const candidate = await f.controller.dispatch("compile_document_selectors", {});
    expect(candidate.ok).toBe(true);
    await f.controller.dispatch("submit_discovery_candidate", { fingerprint: candidate.fingerprint });
    const reviewer = await DocumentDiscoveryController.create(f.workspace, "review");
    await reviewer.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
    const narrowed = await reviewer.dispatch("edit_document_selectors", { source_bindings: [{ key: "first", start_line: 1, extent: "clause" }], edits: [
      { collection: "targets", key: "sensor", op: "upsert", value: target("sensor", "$first") },
    ] });
    expect(narrowed).toMatchObject({ ok: true, saved: true, global_coverage_ready: false, pending_clause_count: 1 });
    const blocked = await reviewer.dispatch("compile_document_selectors", {});
    expect(blocked).toMatchObject({ ok: false, error: "discovery_coverage_unresolved", pending_clause_ids: ["7.2.2"],
      ledger_agreement: { uncovered_clause_ids: ["7.2.2"], conflict_atom_ids: [f.atom.atom_id] } });
    // Simulate a persisted local validation from an older controller. Seal must
    // recompute the global invariant even if every local fingerprint matches.
    const plan = JSON.parse(await readFile(f.workspace.workingPlanPath, "utf8"));
    const local = validateDocumentTargetPlan(plan, f.controller.evidence, "test", new Set([f.atom.atom_id]));
    expect(local.ok).toBe(true);
    await f.workspace.recordValidation(local, "review");
    await f.workspace.recordSelectorOutcome(documentSelectorFingerprint(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"))), "");
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: local.fingerprint })).toMatchObject({ ok: false, error: "discovery_coverage_unresolved" });
    expect((await f.workspace.readState()).status).toBe("candidate");
    await expect(readFile(f.workspace.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reviewer.dispatch("edit_document_selectors", complete)).toMatchObject({ ok: true, global_coverage_ready: true });
    const restored = await reviewer.dispatch("compile_document_selectors", {});
    expect(restored.ok).toBe(true);
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: restored.fingerprint })).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(f.workspace.sealReceiptPath, "utf8"))).toMatchObject({ ledger_agreement: { complete: true, uncovered_clause_ids: [] } });
  }, 30_000);
  test("provider-facing short disposition keys and line aliases work in the same transaction", async () => {
    const f = await fixture("仪表应完好。\n");
    const codec = await ModelSourceHandles.open(f.workspace.root);
    const tools = codec.wrapTools(createDocumentDiscoveryTools(f.controller));
    const invoke = async (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("test", args, undefined as never, undefined as never);
    await invoke("open_document_atom", { atom_id: f.atom.atom_id });
    const encoded = await codec.encode({ atom_span_id: f.atomSpan }) as { atom_span_id: string };
    const written = await invoke("edit_document_selectors", { source_handle_scope: codec.scope,
      source_bindings: [{ key: "clause", start_line: 1, end_exclusive_line: 2 }], edits: [
        { collection: "targets", key: "instrument", op: "upsert", value: target("instrument", "$clause", "仪表") },
        { collection: "contexts", key: "note", op: "upsert", value: { role: "other_context", name: "补充说明", span_ids: ["$clause"], reason: "同一原文中的辅助说明" } },
        { collection: "dispositions", key: encoded.atom_span_id, op: "upsert", value: { key: "redundant-wrapper-copy", disposition: "target", target_keys: [], reason: "实体质量要求" } },
      ] });
    expect(written.details).toMatchObject({ ok: true, saved: true });
    const read = await invoke("read_document_selectors", { collection: "dispositions", key: encoded.atom_span_id, source_handle_scope: codec.scope });
    expect(read.details).toMatchObject({ rows: [expect.objectContaining({ atom_span_id: f.atomSpan, target_keys: ["instrument"] })] });
    expect(await f.controller.dispatch("read_document_selectors", { collection: "contexts", key: "note" })).toMatchObject({ rows: [expect.objectContaining({ key: "note" })] });
  }, 30_000);
  test("one semantic edit derives clause anchors, adjacent starts and disposition relations", async () => {
    const f = await fixture("## 4.1 传感器安装\n\n4.1.1 传感器应安装牢固。\n检查数量：全数。\n");
    await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const value = target("sensor", "$clause");
    value.source_blocks = [{
      kind: "heading_section",
      anchor_span_id: "$heading",
      start_span_id: "$clause",
      end_span_id: "$clause",
      reason: "Agent 选择标题锚点及完整物理条文",
    }];
    const written = await f.controller.dispatch("edit_document_selectors", {
      source_bindings: [
        { key: "heading", start_line: 1, end_exclusive_line: 2, extent: "lines" },
        { key: "clause", start_line: 3, extent: "clause" },
      ],
      edits: [
        { collection: "targets", key: "sensor", op: "upsert", value },
        { collection: "dispositions", key: f.atomSpan, op: "upsert", value: { atom_span_id: f.atomSpan, disposition: "target", target_keys: ["stale-model-mirror"], reason: "包含受检对象" } },
      ],
    });
    expect(written).toMatchObject({
      ok: true,
      saved: true,
      reconciled_source_block_keys: ["sensor"],
      reconciled_disposition_keys: [f.atomSpan],
    });
    const saved = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(saved.targets[0].source_blocks[0].start_span_id).toBe(saved.targets[0].source_blocks[0].anchor_span_id);
    expect(saved.targets[0].semantic_basis.acceptance_span_ids).not.toContain(saved.targets[0].source_blocks[0].anchor_span_id);
    expect(saved.dispositions[0]).toMatchObject({ disposition: "target", target_keys: ["sensor"] });
  }, 30_000);
  test.each(["\n", "\r\n"])("registers complete clauses across atom boundaries and preserves %j source bytes", (newline) => {
    const source = ["# 7 检测设备", "7.2.1 外壳应完好。", "检查方法：" + "观察其外表。".repeat(230), "检查数量：全数。", "7.2.2 连接应牢固。"].join(newline);
    const evidence = buildDocumentEvidence(source, "source.md", 1000);
    const ledger = scanDocumentLedger(source, "source.md");
    const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
    const binding = { key: "complete", start_line: 2, extent: "clause" as const };
    expect(() => bindDiscoverySources([binding], evidence, ledger, new Set([evidence.atoms[0]!.atom_id]), registry)).toThrow();
    const result = bindDiscoverySources([binding], evidence, ledger, new Set(evidence.atoms.map(atom => atom.atom_id)), registry);
    const endLine = ledger.clauses.find(clause => clause.line === 2)!.end_exclusive_line;
    const redundantBoundary = bindDiscoverySources([{ ...binding, end_exclusive_line: endLine }], evidence, ledger, new Set(evidence.atoms.map(atom => atom.atom_id)), registry);
    expect(redundantBoundary.aliases).toEqual(result.aliases);
    expect(() => bindDiscoverySources([{ ...binding, end_exclusive_line: endLine - 1 }], evidence, ledger, new Set(evidence.atoms.map(atom => atom.atom_id)), registry)).toThrow();
    const alias = result.aliases.get("complete")!;
    const selected = alias.span_ids.map(id => result.registry.spans.find(span => span.span_id === id)!);
    const text = selected.map(span => evidence.atoms.find(atom => atom.atom_id === span.atom_id)!.text.slice(span.start, span.end)).join("");
    expect(text).toBe(source.slice(source.indexOf("7.2.1"), source.indexOf("7.2.2")));
    expect(text).toContain("检查数量：全数。");
    expect(resolveDiscoveryAliases({ scope_span_ids: ["$complete"], anchor_span_id: "$complete", end_span_id: "$complete" }, result.aliases)).toEqual({ scope_span_ids: selected.map(span => span.span_id), anchor_span_id: alias.anchor_span_id, end_span_id: selected.at(-1)!.span_id });
    expect(registry.spans.length).toBe(evidence.atoms.length);
  });

  test("same-atom source lines have exact addresses without duplicate raw text in model output", async () => {
    const f = await fixture("探测器应可靠。\r\n检查数量：全数。\r\n");
    const tool = createDocumentDiscoveryTools(f.controller).find(tool => tool.name === "open_document_atom")!;
    const result = await tool.execute("read", { atom_id: f.atom.atom_id }, undefined as never, undefined as never);
    const visible = JSON.parse((result.content[0] as { text: string }).text);
    expect(visible.atom).not.toHaveProperty("text");
    expect(visible.atom.source_lines).toEqual([{ line: 1, text: "探测器应可靠。" }, { line: 2, text: "检查数量：全数。" }]);
  });

  test("invalid bindings, stale edits, dry runs and overlap rejection leave both durable files unchanged", async () => {
    const f = await fixture("探测器应可靠。\n检查数量：全数。\n接插件应牢固。");
    const request = { source_bindings: [{ key: "scope", start_line: 1, end_exclusive_line: 3 }], edits: [
      { collection: "targets", key: "sensor", op: "upsert", value: target("sensor", "$scope") },
      { collection: "dispositions", key: f.atomSpan, op: "upsert", value: { atom_span_id: f.atomSpan, disposition: "target", target_keys: ["sensor"], reason: "本段设备要求" } },
    ] };
    const snapshot = async () => Promise.all([readFile(f.workspace.workingSelectorPath, "utf8"), readFile(f.workspace.sourceSpanRegistryPath, "utf8")]);
    const before = await snapshot();
    expect(await f.controller.dispatch("edit_document_selectors", request)).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
    await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const malformed = await f.controller.dispatch("edit_document_selectors", { ...request, edits: [
      { ...request.edits[0], value: { ...target("sensor", "$scope"), name: 123 } }, request.edits[1],
    ] });
    expect(malformed).toMatchObject({ ok: false, saved: false, error: "document_selector_schema_rejected",
      selector_issues: expect.arrayContaining([expect.objectContaining({ writable_path: "/targets/0/name", actual: 123 })]) });
    expect(await snapshot()).toEqual(before);
    const prepared = await f.controller.dispatch("edit_document_selectors", { draft_id: malformed.draft_id, dry_run: true,
      edits: [{ collection: "targets", key: "sensor", op: "update", value: { name: target("sensor", "$scope").name } }] });
    expect(prepared).toMatchObject({ ok: true, saved: false });
    expect(await snapshot()).toEqual(before);
    expect((await f.workspace.readState()).validation_attempts).toBe(0);
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [], expected_selector_fingerprint: "stale" })).toMatchObject({ error: "selector_edit_stale", saved: false });
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ ok: true, saved: true });
    const saved = await snapshot();
    const conflict = { source_bindings: [{ key: "overlap", start_line: 2, end_exclusive_line: 4 }], edits: [
      { collection: "targets", key: "connector", op: "upsert", value: target("connector", "$overlap", "接插件") },
      { collection: "dispositions", key: f.atomSpan, op: "update", value: { target_keys: ["sensor", "connector"] } },
    ] };
    const rejected = await f.controller.dispatch("edit_document_selectors", conflict);
    expect(rejected).toMatchObject({ ok: false, saved: false,
      selector_issues: expect.arrayContaining([expect.objectContaining({ code: "selector_target_primary_overlap" })]) });
    expect(await snapshot()).toEqual(saved);
    // A single transaction both adjusts the old boundary and creates the next owner.
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: rejected.draft_id, source_bindings: [{ key: "other", start_line: 3, end_exclusive_line: 4 }], edits: [
      { ...conflict.edits[0], value: target("connector", "$other", "接插件") }, conflict.edits[1],
    ] })).toMatchObject({ ok: true, saved: true });
    const compiled = await f.controller.dispatch("compile_document_selectors", {});
    expect(compiled).toMatchObject({ ok: true, target_count: 2 });
    expect(compiled).not.toHaveProperty("plan");
    expect(Buffer.byteLength(JSON.stringify(compiled))).toBeLessThan(1500);
    expect(await f.controller.dispatch("submit_discovery_candidate", { fingerprint: compiled.fingerprint })).toMatchObject({ ok: true });
    const reviewer = await DocumentDiscoveryController.create(f.workspace, "review");
    expect(await reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false });
    expect(await reviewer.dispatch("edit_document_selectors", { source_bindings: request.source_bindings,
      edits: [{ collection: "targets", key: "sensor", op: "update", value: { lot_basis_span_ids: ["$scope"] } }] })).toMatchObject({ ok: false, saved: false });
    await reviewer.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const independent = await reviewer.dispatch("compile_document_selectors", {});
    expect(independent).toMatchObject({ ok: true });
    expect(await reviewer.dispatch("seal_discovery_plan", { fingerprint: independent.fingerprint })).toMatchObject({ ok: true });
  }, 30_000);

  test("keyed update preserves unrelated fields and large record reads remain explicitly paged", async () => {
    const f = await fixture("传感器应完好。");
    await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const selectors = initialDocumentSelectorPlan("test");
    selectors.contexts = Array.from({ length: 12 }, (_, i) => ({ key: `context-${i}`, role: "other_context", name: "说明", span_ids: [f.atomSpan], reason: "原文说明".repeat(1000) }));
    await atomicWriteJson(f.workspace.workingSelectorPath, selectors);
    const listing = await f.controller.dispatch("read_document_selectors", { collection: "contexts" });
    expect(listing).toMatchObject({ view: "summary", next_cursor: 10 });
    expect(Buffer.byteLength(JSON.stringify(listing))).toBeLessThan(2000);
    const page = await f.controller.dispatch("read_document_selectors", { collection: "contexts", view: "full" });
    expect(page.next_cursor).toBeGreaterThan(0);
    expect(page.next_cursor).toBeLessThan(10);
    const before = sha256Json(selectors.contexts.slice(1));
    expect(await f.controller.dispatch("edit_document_selectors", { edits: [{ collection: "contexts", key: "context-0", op: "update", value: { name: "修订说明" } }] })).toMatchObject({ ok: true });
    const saved = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(sha256Json(saved.contexts.slice(1))).toBe(before);
    expect(saved.contexts[0]).toEqual({ ...selectors.contexts[0], name: "修订说明" });
    expect(await f.controller.dispatch("edit_document_selectors", { edits: [
      ...selectors.contexts.slice(0, 5).map(context => ({ collection: "contexts", key: context.key, op: "remove" })),
      ...selectors.contexts.slice(0, 5).map((context, index) => ({ collection: "contexts", key: `new-${index}`, op: "upsert", value: { ...context, key: `new-${index}` } })),
    ] })).toMatchObject({ ok: false, error: "incremental_discovery_checkpoint_required", new_semantic_records: 5, saved: false });
    expect(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"))).toEqual(saved);
  }, 30_000);
});
