import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace, createDocumentDiscoveryTools, validateDocumentTargetPlan } from "../src/document-discovery.js";
import { initialDocumentSelectorPlan, type DocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { compileIssuesWorklist, discoveryReviewProgressKey } from "../src/batch.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { locateAndRegisterSourceQuote } from "../src/source-span-registry.js";

const roots: string[] = [];
const temporaryPrefix = resolve(join(tmpdir(), "pi-discovery-record-reads-"));
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(temporaryPrefix)) throw new Error("Unexpected temporary fixture path");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(reasonLength = 0, firstKey = "a") {
  const root = await mkdtemp(temporaryPrefix); roots.push(root);
  const first = "1.1 装置甲的接线应牢固。", second = "1.2 装置乙的外壳应完整。";
  const definition = "术语：装置指本文件涉及的设备。";
  const sourcePath = join(root, "neutral.md");
  await writeFile(sourcePath, `${first}\n\n${second}\n\n${definition}\n`);
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "neutral-record-reads", sourcePath);
  const author = await DocumentDiscoveryController.create(workspace, "candidate");
  const atom = author.evidence.atoms[0]!;
  await author.dispatch("open_document_atom", { atom_id: atom.atom_id });
  let registry = await workspace.readSourceSpanRegistry();
  const full = registry.spans.find(s => s.atom_id === atom.atom_id && s.start === 0 && s.end === atom.text.length)!.span_id;
  const locate = (quote: string) => {
    const result = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
    registry = result.registry; return result.spans[0]!.span_id;
  };
  const a = locate(first), b = locate(second), contextSpan = locate(definition);
  const selectors = initialDocumentSelectorPlan(workspace.jobId);
  const target = (key: string, name: string, span: string): DocumentSelectorPlan["targets"][number] => ({
    key, name, group_key: "devices", group_name: "装置", group_reason: "原文的装置质量检查",
    lot_basis_summary: "具名装置的质量要求", reason: reasonLength ? "中性来源说明。".repeat(reasonLength) : "原文指定的实体质量要求",
    scope_span_ids: [span], lot_basis_span_ids: [span],
    source_blocks: [{ kind: "explicit_range", anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "完整的具名装置条款" }],
    semantic_basis: { subject: name, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span],
      acceptance_reason: "原文直接约束该装置", boundary_reason: "两个具名装置各有独立质量要求" },
  });
  selectors.targets = [target(firstKey, "装置甲", a), target("b", "装置乙", b)];
  selectors.contexts = [{ key: "definition", name: "装置术语", role: "definition", span_ids: [contextSpan], reason: "仅定义术语" }];
  selectors.dispositions = [{ atom_span_id: full, disposition: "target", target_keys: [firstKey, "b"], reason: "两个具名装置的验收原文" }];
  await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry));
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const candidate = await author.dispatch("compile_document_selectors", {});
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ ok: true });
  expect(await author.dispatch("submit_discovery_candidate", { fingerprint: candidate.fingerprint })).toMatchObject({ ok: true });
  await workspace.setReviewerRuntime({ kind: "pi-sdk", session_id: "neutral-review", session_file: "neutral-review.jsonl" });
  const reviewer = await DocumentDiscoveryController.create(workspace, "review");
  await reviewer.dispatch("open_document_atom", { atom_id: atom.atom_id });
  return { workspace, author, reviewer, atom, selectors, candidate };
}

async function readAll(reviewer: DocumentDiscoveryController) {
  for (const collection of ["targets", "contexts"] as const) {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const response = await reviewer.dispatch("read_document_selectors", { collection, view: "full", cursor, limit: 100 });
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, view: "full" });
      cursor = response.next_cursor as number | null;
    }
  }
}

async function confirmAll(reviewer: DocumentDiscoveryController) {
  for (const collection of ["contexts", "targets"] as const) {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const full = await reviewer.dispatch("read_document_selectors", { collection, view: "full", cursor, limit: 100 });
      const rows = full.rows as Array<{ key: string; scope_span_ids?: string[]; span_ids?: string[] }>;
      expect(await reviewer.dispatch("record_discovery_review", { reviews: rows.map(row => ({
        collection, key: row.key, verdict: "confirmed", reason: "中性 fixture 的独立复核已核对该具名装置及原文边界",
        source_span_ids: row.scope_span_ids ?? row.span_ids,
      })) })).toMatchObject({ ok: true, saved_count: rows.length });
      cursor = full.next_cursor as number | null;
    }
  }
}

describe("independent discovery record reads", () => {
  test("a source-complete directory read cannot substitute for full target and context records", async () => {
    const f = await fixture();
    const before = await f.workspace.readState();
    const selectorsBefore = await readFile(f.workspace.workingSelectorPath, "utf8");
    await f.reviewer.dispatch("read_document_selectors", { collection: "targets", view: "summary", limit: 100 });
    await f.reviewer.dispatch("read_document_selectors", { collection: "contexts", view: "summary", limit: 100 });
    const blocked = await f.reviewer.dispatch("compile_document_selectors", {});
    expect(blocked).toMatchObject({ ok: false, error: "discovery_selector_review_reads_required", budget_consumed: false,
      actual: { unread_target_keys: ["a", "b"], unread_context_keys: ["definition"] }, writable_paths: [],
      next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", key: "a", view: "full" } });
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(before.reviewer_validation_attempts);
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    await readAll(f.reviewer);
    await confirmAll(f.reviewer);
    const validated = await f.reviewer.dispatch("compile_document_selectors", {});
    expect(validated, JSON.stringify(validated)).toMatchObject({ ok: true, next_tool: "seal_discovery_plan", next_tool_arguments: { fingerprint: validated.fingerprint } });
    expect(await f.reviewer.dispatch("seal_discovery_plan", { fingerprint: validated.fingerprint })).toMatchObject({ ok: true });
  });

  test("only the current unread record remains after a partial full read", async () => {
    const f = await fixture();
    await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "a" });
    await f.reviewer.dispatch("read_document_selectors", { collection: "contexts", key: "definition" });
    const blocked = await f.reviewer.dispatch("compile_document_selectors", {});
    expect(blocked).toMatchObject({ ok: false, actual: { unread_target_keys: ["b"], unread_context_keys: [] },
      next_tool_arguments: { collection: "targets", key: "b", view: "full", limit: 1 } });
    expect(await f.reviewer.dispatch(blocked.next_tool as string, blocked.next_tool_arguments as Record<string, unknown>)).toMatchObject({ ok: true, rows: [f.selectors.targets[1]] });
    await confirmAll(f.reviewer);
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
  });

  test("unchanged reads survive controller recovery; an edited target or context alone needs rereading", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    expect((await f.workspace.readState()).last_reviewed_fingerprint).toBe("");
    const resumed = await DocumentDiscoveryController.create(f.workspace, "review");
    expect(await resumed.dispatch("edit_document_selectors", { edits: [{ collection: "targets", key: "a", op: "update",
      value: { reason: "复核者修订本装置的说明" } }] })).toMatchObject({ ok: true });
    expect(await resumed.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["a"], unread_context_keys: [] }, budget_consumed: false });
    await resumed.dispatch("read_document_selectors", { collection: "targets", key: "a" });
    expect(await resumed.dispatch("edit_document_selectors", { edits: [{ collection: "contexts", key: "definition", op: "update",
      value: { reason: "复核者修订术语说明" } }] })).toMatchObject({ ok: true });
    expect(await resumed.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: [], unread_context_keys: ["definition"] }, budget_consumed: false });
    await resumed.dispatch("read_document_selectors", { collection: "contexts", key: "definition" });
    await confirmAll(resumed);
    expect(await resumed.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(1);
  });

  test("pending draft reads cannot grant receipt authority for accepted records", async () => {
    const f = await fixture();
    const draft = await f.reviewer.dispatch("edit_document_selectors", { dry_run: true,
      edits: [{ collection: "targets", key: "a", op: "update", value: { reason: "尚未接受的说明" } }] });
    expect(draft).toMatchObject({ ok: true });
    expect(typeof draft.draft_id).toBe("string");
    await f.reviewer.dispatch("read_document_selectors", { draft_id: draft.draft_id, collection: "targets", key: "a" });
    expect(await f.reviewer.dispatch("discard_document_selector_draft", { draft_id: draft.draft_id })).toMatchObject({ ok: true });
    await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "b" });
    await f.reviewer.dispatch("read_document_selectors", { collection: "contexts", key: "definition" });
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["a"], unread_context_keys: [] } });
    const accepted = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(accepted.targets[0].reason).toBe(f.selectors.targets[0]!.reason);
  });

  test("only rows actually returned after byte pagination count", async () => {
    const f = await fixture(1800);
    const page = await f.reviewer.dispatch("read_document_selectors", { collection: "targets", view: "full", cursor: 0, limit: 100 });
    expect(page).toMatchObject({ ok: true, next_cursor: 1 });
    expect((page.rows as unknown[]).length).toBe(1);
    await f.reviewer.dispatch("read_document_selectors", { collection: "contexts", key: "definition" });
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["b"], unread_context_keys: [] } });
    await f.reviewer.dispatch("read_document_selectors", { collection: "targets", view: "full", cursor: page.next_cursor, limit: 100 });
    await confirmAll(f.reviewer);
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
  });

  test("a failed oversized full read cannot count as delivered", async () => {
    const f = await fixture(7000);
    expect(await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "a" })).toMatchObject({ ok: false, error: "selector_read_exceeds_128kb" });
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["a", "b"], unread_context_keys: ["definition"] } });
  });

  test("author and scripted reads do not satisfy a live independent review", async () => {
    const f = await fixture();
    await readAll(f.author);
    await f.workspace.setReviewerRuntime({ kind: "offline-scripted", session_id: "script", session_file: "script.jsonl" });
    await readAll(f.reviewer);
    await f.workspace.setReviewerRuntime({ kind: "pi-sdk", session_id: "live", session_file: "live.jsonl" });
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["a", "b"], unread_context_keys: ["definition"] } });
  });

  test("a new candidate cannot inherit record receipts from an earlier independent review", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    await f.workspace.markCandidate();
    await f.workspace.setReviewerRuntime({ kind: "pi-sdk", session_id: "new-review", session_file: "new-review.jsonl" });
    const fresh = await DocumentDiscoveryController.create(f.workspace, "review");
    await fresh.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    expect(await fresh.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false,
      actual: { unread_target_keys: ["a", "b"], unread_context_keys: ["definition"] } });
  });

  test("a preexisting validation fingerprint cannot bypass the read check at seal", async () => {
    const f = await fixture();
    // Seed a source-valid checkpoint as an older compiler could persist. This is
    // confined to the neutral workspace; the live reviewer still uses real tools.
    const plan = JSON.parse(await readFile(f.workspace.workingPlanPath, "utf8"));
    const validation = validateDocumentTargetPlan(plan, f.reviewer.evidence, f.workspace.jobId, new Set([f.atom.atom_id]));
    expect(validation).toMatchObject({ ok: true });
    await f.workspace.recordValidation(validation, "review");
    const before = await f.workspace.readState();
    const blocked = await f.reviewer.dispatch("seal_discovery_plan", { fingerprint: validation.fingerprint });
    expect(blocked).toMatchObject({ ok: false, error: "discovery_selector_review_reads_required", budget_consumed: false, retry_tool: "seal_discovery_plan" });
    expect((await f.workspace.readState()).last_reviewed_fingerprint).toBe(before.last_reviewed_fingerprint);
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(before.reviewer_validation_attempts);
    const resumed = await DocumentDiscoveryController.create(f.workspace, "review");
    await readAll(resumed);
    await confirmAll(resumed);
    expect(await resumed.dispatch("seal_discovery_plan", { fingerprint: validation.fingerprint })).toMatchObject({ ok: true });
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(before.reviewer_validation_attempts);
  });

  test("full record reads do not bypass the existing exact source compiler", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    const registry = await f.workspace.readSourceSpanRegistry();
    registry.spans = registry.spans.filter(s => s.span_id !== f.selectors.targets[0]!.scope_span_ids[0]);
    await writeFile(f.workspace.sourceSpanRegistryPath, JSON.stringify(registry));
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "document_selector_compile_failed" });
    expect((await f.workspace.readState()).last_reviewed_fingerprint).toBe("");
  });

  test("a schema-valid stable key cannot collide with the receipt object prototype", async () => {
    const f = await fixture(0, "__proto__");
    await readAll(f.reviewer);
    await confirmAll(f.reviewer);
    expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
  });
});


describe("review recovery uses current read prerequisites", () => {
  const snapshot = (text: string) => { expect(text).toContain("当前独立复核读取前提"); return JSON.parse(text.split("\n")[1]!); };
  test("successful slice validation does not hide current unread accepted records", async () => {
    const f = await fixture();
    await f.workspace.recordLastCompileIssues(true);
    const worklist = await compileIssuesWorklist(f.workspace);
    expect(worklist).toContain("当前独立复核读取前提");
    expect(snapshot(worklist)).toMatchObject({ semantic_approval: false,
      records: { targets: { total: 2, read: 0, unread: 2, unread_keys: ["a", "b"] }, contexts: { total: 1, unread: 1 } },
      next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", key: "a", view: "full", limit: 1 }, writable_paths: [] });
  });
  test("a missing reviewer atom is visible even when every accepted record was received", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    const state = await f.workspace.readState();
    state.reviewer_opened_atom_ids = [];
    await writeFile(f.workspace.statePath, JSON.stringify(state));
    await f.workspace.recordLastCompileIssues(true);
    const current = snapshot(await compileIssuesWorklist(f.workspace));
    expect(current).toMatchObject({ semantic_approval: false, sources: { total: 1, read: 0, unread: 1 },
      records: { targets: { unread: 0 }, contexts: { unread: 0 } },
      next_tool: "list_document_atoms", next_tool_arguments: { cursor: 0, limit: 1 } });
    expect(current.sources.unread_atom_ids).toEqual([f.atom.atom_id]);
  });
  test("reports changed records only, remains read-only, and never converts reads into approval", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    let current = snapshot(await compileIssuesWorklist(f.workspace));
    expect(current).toMatchObject({ semantic_approval: false, sources: { unread: 0 }, records: { targets: { unread: 0 }, contexts: { unread: 0 } },
      semantic_review: { targets: { confirmed: 0, pending: 2 }, contexts: { pending: 1 } },
      next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0, limit: 20 }, reviewer_validation_attempts: 0 });
    const changed = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    changed.targets[0].reason = "当前记录经作者修订，须重新核对完整来源";
    await f.workspace.writeWorkingSelectors(JSON.stringify(changed));
    const paths = [f.workspace.statePath, f.workspace.workingSelectorPath, f.workspace.sourceSpanRegistryPath, f.workspace.validationReceiptPath];
    const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
    current = snapshot(await compileIssuesWorklist(f.workspace));
    expect(current.records.targets).toMatchObject({ read: 1, unread: 1, unread_keys: ["a"] });
    expect(current).toMatchObject({ semantic_approval: false, next_tool: "read_document_selectors", reviewer_validation_attempts: 0 });
    expect(await Promise.all(paths.map(path => readFile(path, "utf8")))).toEqual(before);
  });
});


test("recovery progress counts new valid reads but ignores duplicates, author and runtime telemetry", async () => {
  const f = await fixture();
  const before = await discoveryReviewProgressKey(f.workspace);
  await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "a", view: "full" });
  const advanced = await discoveryReviewProgressKey(f.workspace);
  expect(advanced).not.toBe(before);
  await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "a", view: "full" });
  await f.author.dispatch("read_document_selectors", { collection: "targets", key: "b", view: "full" });
  const state = await f.workspace.readState();
  state.reviewer_runtime.session_id = "neutral-resumed-session";
  state.next_event_sequence += 10;
  state.reviewer_opened_atom_ids.push(f.atom.atom_id, "atom:obsolete");
  await writeFile(f.workspace.statePath, JSON.stringify(state));
  expect(await discoveryReviewProgressKey(f.workspace)).toBe(advanced);
});


describe("independent semantic review checkpoints", () => {
  test("completed unchanged records have an explicit durable judgment route", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const saved = await f.reviewer.dispatch("record_discovery_review", { reviews: [{ collection: "targets", key: "a",
      verdict: "confirmed", reason: "已独立核对装置甲对象、判据及相邻来源边界，保留当前记录", source_span_ids: f.selectors.targets[0]!.scope_span_ids }] });
    expect(saved).toMatchObject({ ok: true, saved_count: 1, semantic_approval: false });
    const progress = await f.reviewer.dispatch("read_discovery_review_progress", {});
    expect(progress).toMatchObject({ ok: true, summary: { targets: { total: 2, confirmed: 1, pending: 1 } } });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(0);
  });
  test("read completeness alone cannot substitute for explicit independent record judgments", async () => {
    const f = await fixture();
    await readAll(f.reviewer);
    const before = await f.workspace.readState();
    const blocked = await f.reviewer.dispatch("compile_document_selectors", {});
    expect(blocked).toMatchObject({ ok: false, error: "discovery_semantic_review_incomplete", budget_consumed: false,
      writable_paths: [], next_tool: "read_discovery_review_progress" });
    expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(before.reviewer_validation_attempts);
  });


 test("judgments survive recovery; repeat explanations cannot manufacture progress", async () => {
   const f = await fixture(); await readAll(f.reviewer);
   const review = { collection: "targets", key: "a", verdict: "confirmed", reason: "独立核对甲的具名对象、判据和边界", source_span_ids: f.selectors.targets[0]!.scope_span_ids };
   const before = await discoveryReviewProgressKey(f.workspace);
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [review] })).toMatchObject({ ok: true });
   const saved = await discoveryReviewProgressKey(f.workspace); expect(saved).not.toBe(before);
   const resumed = await DocumentDiscoveryController.create(f.workspace, "review");
   expect(await resumed.dispatch("record_discovery_review", { reviews: [{ ...review, reason: "同一判断的说明改写" }] })).toMatchObject({ ok: true });
   expect(await discoveryReviewProgressKey(f.workspace)).toBe(saved);
   expect(await resumed.dispatch("read_discovery_review_progress", {})).toMatchObject({ rows: [{ collection: "targets", key: "b" }, { collection: "contexts", key: "definition" }], summary: { targets: { confirmed: 1 } } });
 });

 test("unread or unauthorized judgments reject the entire bounded batch", async () => {
   const f = await fixture();
   const a = { collection: "targets", key: "a", verdict: "confirmed", reason: "核对甲原文", source_span_ids: f.selectors.targets[0]!.scope_span_ids };
   expect(await f.author.dispatch("record_discovery_review", { reviews: [a] })).toMatchObject({ ok: false, error: "discovery_review_phase_required" });
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [a] })).toMatchObject({ ok: false, error: "discovery_review_record_unread", next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", key: "a", view: "full" } });
   await f.reviewer.dispatch("read_document_selectors", { collection: "targets", key: "a" });
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [a, { ...a, key: "b", source_span_ids: f.selectors.targets[1]!.scope_span_ids }] })).toMatchObject({ ok: false, error: "discovery_review_record_unread" });
   expect((await f.workspace.readState()).reviewer_semantic_review_receipts).toEqual({ targets: {}, contexts: {} });
   await f.workspace.setReviewerRuntime({ kind: "offline-scripted", session_id: "script", session_file: "script.jsonl" });
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [a] })).toMatchObject({ ok: false, error: "discovery_review_phase_required" });
 });

 test("cited originals must be read and belong to the reviewed record", async () => {
   const f = await fixture(); await readAll(f.reviewer);
   const a = { collection: "targets", key: "a", verdict: "confirmed", reason: "独立核对甲", source_span_ids: f.selectors.targets[1]!.scope_span_ids };
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [a] })).toMatchObject({ ok: false, error: "discovery_review_source_unrelated" });
   const state = await f.workspace.readState(); state.reviewer_opened_atom_ids = [];
   await writeFile(f.workspace.statePath, JSON.stringify(state));
   const blocked = await f.reviewer.dispatch("record_discovery_review", { reviews: [{ ...a, source_span_ids: f.selectors.targets[0]!.scope_span_ids }] });
   expect(blocked).toMatchObject({ ok: false, error: "discovery_review_source_unread", writable_paths: [], next_tool: "open_document_atom", next_tool_arguments: { atom_id: f.atom.atom_id } });
   expect((await f.workspace.readState()).reviewer_semantic_review_receipts).toEqual({ targets: {}, contexts: {} });
 });

 test("only edited records lose confirmation; upstream context edits invalidate target judgments", async () => {
   const f = await fixture(); await readAll(f.reviewer); await confirmAll(f.reviewer);
   const update = (collection: string, key: string, reason: string) => f.reviewer.dispatch("edit_document_selectors", { edits: [{ collection, key, op: "update", value: { reason } }] });
   expect(await update("targets", "a", "甲来源说明更新")).toMatchObject({ ok: true });
   expect(await f.reviewer.dispatch("read_discovery_review_progress", {})).toMatchObject({ rows: [{ collection: "targets", key: "a" }], summary: { targets: { confirmed: 1, pending: 1 }, contexts: { confirmed: 1 } } });
   await confirmAll(f.reviewer);
   expect(await update("contexts", "definition", "术语适用说明更新")).toMatchObject({ ok: true });
   expect(await f.reviewer.dispatch("read_discovery_review_progress", {})).toMatchObject({ summary: { targets: { confirmed: 0, pending: 2 }, contexts: { confirmed: 0, pending: 1 } } });
   await f.reviewer.dispatch("read_document_selectors", { collection: "contexts", key: "definition" });
   expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_semantic_review_incomplete", budget_consumed: false });
   await confirmAll(f.reviewer);
   expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: true });
 });

 test("needs_revision remains actionable and cannot seal an old successful validation", async () => {
   const f = await fixture(); await readAll(f.reviewer); await confirmAll(f.reviewer);
   const valid = await f.reviewer.dispatch("compile_document_selectors", {}); expect(valid).toMatchObject({ ok: true });
   const attempts = (await f.workspace.readState()).reviewer_validation_attempts;
   const finding = { collection: "targets", key: "b", verdict: "needs_revision", reason: "需重新核对乙的拆并边界", source_span_ids: f.selectors.targets[1]!.scope_span_ids };
   expect(await f.reviewer.dispatch("record_discovery_review", { reviews: [finding] })).toMatchObject({ ok: true, summary: { targets: { confirmed: 1, needs_revision: 1 } } });
   expect(await f.reviewer.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false, error: "discovery_semantic_review_incomplete", budget_consumed: false });
   expect(await f.reviewer.dispatch("seal_discovery_plan", { fingerprint: valid.fingerprint })).toMatchObject({ ok: false, error: "discovery_semantic_review_incomplete" });
   expect((await f.workspace.readState()).reviewer_validation_attempts).toBe(attempts);
   await f.workspace.markCandidate();
   expect((await f.workspace.readState()).reviewer_semantic_review_receipts).toEqual({ targets: {}, contexts: {} });
 });

 test("real model tool handles round-trip review citations without granting global approval", async () => {
   const f = await fixture(); await readAll(f.reviewer);
   const handles = await ModelSourceHandles.open(f.workspace.root);
   const tools = handles.wrapTools(createDocumentDiscoveryTools(f.reviewer));
   const invoke = async (name: string, args: Record<string, unknown>) => {
     const result = await tools.find(tool => tool.name === name)!.execute("neutral-review", args, undefined as never, undefined as never);
     return JSON.parse((result.content[0] as { text: string }).text);
   };
   const row = await invoke("read_document_selectors", { collection: "targets", key: "a", view: "full" });
   expect(row.rows[0].scope_span_ids[0]).not.toBe(f.selectors.targets[0]!.scope_span_ids[0]);
   const saved = await invoke("record_discovery_review", { source_handle_scope: row.source_handle_scope, reviews: [{ collection: "targets", key: "a", verdict: "confirmed", reason: "独立核对甲的完整原文和物理边界", source_span_ids: row.rows[0].scope_span_ids }] });
   expect(saved).toMatchObject({ ok: true, saved_count: 1, semantic_approval: false, summary: { targets: { confirmed: 1, pending: 1 } } });
   expect((await f.workspace.readState()).reviewer_semantic_review_receipts!.targets.a!.source_span_ids).toEqual(f.selectors.targets[0]!.scope_span_ids);
 });
});
