import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Json } from "../src/canonical.js";
import { createDocumentDiscoveryTools, DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { bindDiscoverySources, resolveDiscoveryAliases } from "../src/discovery-source-bindings.js";
import { initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { discoveryDraftOperations, mergeDiscoveryDraftRegistry } from "../src/discovery-pending-draft.js";
import { applyJsonPatch } from "../src/json-patch.js";

async function fixture(count = 3, brokenLast = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-pending-draft-"));
  const path = join(root, "source.md");
  const markdown = Array.from({ length: count }, (_, i) => `7.2.${i + 1} 装置${i + 1}外壳应完好。\n`).join("");
  await writeFile(path, markdown);
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "test", path);
  await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
  const controller = await DocumentDiscoveryController.create(workspace);
  await controller.dispatch("batch_open_document_atoms", { atom_ids: controller.evidence.atoms.map(atom => atom.atom_id) });
  const bound = bindDiscoverySources(Array.from({ length: count }, (_, i) => ({ key: `part${i}`, start_line: i + 1, extent: "clause" as const })),
    controller.evidence, await workspace.readLedger(), new Set(controller.evidence.atoms.map(atom => atom.atom_id)), await workspace.readSourceSpanRegistry());
  const selectors = initialDocumentSelectorPlan("test");
  selectors.targets = resolveDiscoveryAliases(Array.from({ length: count }, (_, i) => ({
    key: `target-${i}`, name: `装置${i + 1}`, group_key: "devices", group_name: "检测设备", group_reason: "按受检设备归组",
    lot_basis_summary: "设备外壳的质量要求", scope_span_ids: [`$part${i}`], lot_basis_span_ids: [`$part${i}`], reason: "具体受检设备",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: `$part${i}`, start_span_id: `$part${i}`, end_span_id: `$part${i}`, reason: "完整设备条文" }],
    semantic_basis: { subject: `装置${i + 1}`, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [`$part${brokenLast && i === count - 1 ? 0 : i}`],
      acceptance_reason: "原文给出外壳质量判据", boundary_reason: "每一条文验收一个独立设备" },
  })), bound.aliases) as typeof selectors.targets;
  selectors.dispositions = controller.evidence.atoms.map(atom => ({
    atom_span_id: bound.registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
    disposition: "target", target_keys: selectors.targets.map(target => target.key), reason: "原文规定各受检设备要求",
  }));
  await atomicWriteJson(workspace.sourceSpanRegistryPath, bound.registry);
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const pendingPath = join(workspace.root, "pending.document-selectors.json");
  const snapshot = async () => ({ selectors: await readFile(workspace.workingSelectorPath, "utf8"), registry: await readFile(workspace.sourceSpanRegistryPath, "utf8"),
    history: await readdir(workspace.historyDirectory), validations: (await workspace.readState()).validation_attempts });
  const edit = (i: number, value: Record<string, unknown>) => ({ collection: "targets", key: `target-${i}`, op: "update", value });
  return { workspace, controller, selectors, bound, pendingPath, snapshot, edit };
}

describe("durable discovery pending transactions", () => {
  test("a missing patch field exposes its failed operation and accepted keyed read without saving preceding edits", async () => {
    const f = await fixture(2);
    const basis = structuredClone(f.selectors.targets[1]!.semantic_basis!);
    delete f.selectors.targets[1]!.semantic_basis;
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const operations = [{ op: "replace", path: "/targets/0/name", value: "作者原定名称" },
      { op: "replace", path: "/targets/1/semantic_basis", value: basis }];
    const before = await f.snapshot(), untouched = structuredClone(operations);
    const rejected = await f.controller.dispatch("patch_document_selectors", { operations });
    expect(rejected).toMatchObject({ ok: false, error: "discovery_tool_rejected", saved: false,
      durable_mutation: false, budget_consumed: false,
      actual: { operation_index: 1, op: "replace", path: "/targets/1/semantic_basis",
        preceding_operations_applied_in_memory: 1, persisted_operations_applied: 0 },
      expected: { replace_remove_target_must_exist: true, add_parent_must_exist: true },
      writable_paths: ["/operations"], writable_collection: "targets",
      next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", key: "target-1" },
      schema_read: { tool: "get_document_selector_contract", arguments: {} }, retry_tool: "patch_document_selectors" });
    expect(rejected.actual_error).toContain("JSON pointer does not exist");
    expect(rejected.instruction).toContain("整笔补丁未保存");
    expect(await f.snapshot()).toEqual(before); expect(operations).toEqual(untouched);
    const current = await f.controller.dispatch(String(rejected.next_tool), rejected.next_tool_arguments as Record<string, unknown>);
    expect(current).toMatchObject({ ok: true, rows: [expect.objectContaining({ key: "target-1" })] });
    const repaired = await f.controller.dispatch("patch_document_selectors", { operations: [operations[0], { ...operations[1], op: "add" }] });
    expect(repaired).toMatchObject({ ok: true, saved: true });
    const saved = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(saved.targets[0].name).toBe("作者原定名称"); expect(saved.targets[1].semantic_basis).toEqual(basis);
    const beforeInvalid = await f.snapshot();
    const unknownField = await f.controller.dispatch("patch_document_selectors", { operations: [
      { op: "add", path: "/targets/1/not_author_field", value: "不允许写入" },
    ] });
    expect(unknownField).toMatchObject({ ok: false, error: "document_selector_schema_rejected", saved: false });
    expect(await f.snapshot()).toEqual(beforeInvalid);
  });
  test("patch rejection reads the accepted stable key after in-memory index shifts and does not invent a read for an unsaved new row", async () => {
    const f = await fixture(2);
    const basis = structuredClone(f.selectors.targets[1]!.semantic_basis!);
    delete f.selectors.targets[1]!.semantic_basis;
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const before = await f.snapshot();
    const shifted = await f.controller.dispatch("patch_document_selectors", { operations: [
      { op: "remove", path: "/targets/0" }, { op: "replace", path: "/targets/0/semantic_basis", value: basis },
    ] });
    expect(shifted).toMatchObject({ ok: false,
      actual: { operation_index: 1, path: "/targets/0/semantic_basis", persisted_operations_applied: 0 },
      next_tool_arguments: { collection: "targets", key: "target-1" } });
    expect(await f.snapshot()).toEqual(before);
    const newRow = { ...f.selectors.targets[0]!, key: "not-saved" };
    const unsaved = await f.controller.dispatch("patch_document_selectors", { operations: [
      { op: "add", path: "/targets/-", value: newRow },
      { op: "replace", path: "/targets/2/not_author_field", value: "作者尚未确认的字段" },
    ] });
    expect(unsaved).toMatchObject({ ok: false, saved: false, draft_retained: false,
      next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets" } });
    expect(await f.snapshot()).toEqual(before);
    const unsafe = await f.controller.dispatch("patch_document_selectors", { operations: [
      { op: "add", path: "/__proto__/polluted", value: true },
    ] });
    expect(unsafe).toMatchObject({ ok: false, actual_error: "Unsafe JSON pointer segment", saved: false,
      next_tool_arguments: { view: "summary" } });
    expect(await f.snapshot()).toEqual(before); expect({}).not.toHaveProperty("polluted");
  });
  test.each([false, true])("missing edit keys recover the %s pending baseline without losing earlier unexecuted edits", async (withPending) => {
    const f = await fixture();
    const prepared = withPending ? await f.controller.dispatch("edit_document_selectors", { dry_run: true,
      edits: [f.edit(2, { name: "已保留装置" })] }) : undefined;
    const before = await f.snapshot();
    const pendingBefore = withPending ? await readFile(f.pendingPath, "utf8") : undefined;
    const tools = createDocumentDiscoveryTools(f.controller);
    const invoke = async (name: string, args: Record<string, unknown>) => (await tools.find(tool => tool.name === name)!
      .execute("call", args, undefined as never, undefined as never)).details as Record<string, unknown>;
    for (const removedInSameCall of [false, true]) {
      const requestedKey = removedInSameCall ? "target-1" : "unregistered-device";
      const rejected = await invoke("edit_document_selectors", {
        ...(withPending ? { draft_id: prepared!.draft_id } : {}),
        edits: [removedInSameCall ? { collection: "targets", key: requestedKey, op: "remove" } : f.edit(0, { name: "尚未保存的修订" }),
          f.edit(2, { name: "尚未保存的另一修订" }), { ...f.edit(1, { name: "应重试的修订" }), key: requestedKey }],
      });
      // The first two edits remain unaccepted even when the missing key was caused by a prior remove.
      expect(rejected).toMatchObject({ ok: false, error: "selector_edit_key_missing", actual: requestedKey,
        saved: false, durable_mutation: false, budget_consumed: false, edit_index: 2,
        matching_basis: "requested_transaction_after_prior_edits", writable_paths: ["/edits/2/key", "/edits/2/collection", "/edits/2/op", "/edits/2/value"],
        next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", cursor: 0,
          ...(withPending ? { draft_id: prepared!.draft_id } : {}) } });
      expect(rejected.instruction).toContain("earlier edits in this call");
      expect(await f.snapshot()).toEqual(before);
      if (withPending) expect(await readFile(f.pendingPath, "utf8")).toBe(pendingBefore);
      const read = await invoke(String(rejected.next_tool), rejected.next_tool_arguments as Record<string, unknown>);
      expect(read).toMatchObject({ ok: true, view_source: withPending ? "pending" : "accepted", next_cursor: null });
      expect((read.rows as Array<{ key: string }>).map(row => row.key)).toEqual(["target-0", "target-1", "target-2"]);
      expect(await f.snapshot()).toEqual(before);
    }
  });

  test("overlap receipts offer tools that can repair the retained transaction without a blocked patch or compile", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const original = f.selectors.targets[1]!;
    const overlappingBlocks = [{ ...original.source_blocks[0]!, start_span_id: f.selectors.targets[0]!.source_blocks[0]!.start_span_id }];
    const rejected = await f.controller.dispatch("edit_document_selectors", { dry_run: true,
      edits: [f.edit(1, { name: "已核对装置", source_blocks: overlappingBlocks })],
    });
    expect(rejected).toMatchObject({ ok: false, saved: false, draft_retained: true,
      next_tool: "read_document_selectors", next_tool_arguments: { draft_id: rejected.draft_id, collection: "targets", key: "target-1" } });
    const overlap = (rejected.selector_issues as Array<{ code: string; details: { next_tools: string[]; required_action: string } }>)
      .find(issue => issue.code === "selector_target_primary_overlap")!;
    expect(overlap.details.next_tools).toEqual(["open_document_atom", "locate_document_span", "read_document_selectors", "edit_document_selectors"]);
    expect(overlap.details.required_action).toContain("draft_id");
    expect(await f.snapshot()).toEqual(before);
    const codec = await ModelSourceHandles.open(f.workspace.root);
    const tools = codec.wrapTools(createDocumentDiscoveryTools(f.controller));
    const invoke = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!
      .execute("call", args, undefined as never, undefined as never);
    const read = await invoke(String(rejected.next_tool), rejected.next_tool_arguments as Record<string, unknown>);
    expect(read.details).toMatchObject({ ok: true, view_source: "pending", draft_retained: true });
    const row = (read.details as { rows: Array<{ source_blocks: Array<Record<string, unknown>> }> }).rows[0]!;
    const originalRead = await invoke("read_document_selectors", { collection: "targets", key: "target-1" });
    const originalRow = (originalRead.details as { rows: Array<{ source_blocks: Array<Record<string, unknown>> }> }).rows[0]!;
    expect(row.source_blocks).not.toEqual(originalRow.source_blocks);
    const repaired = await invoke("edit_document_selectors", { source_handle_scope: codec.scope, draft_id: rejected.draft_id,
      edits: [f.edit(1, { source_blocks: originalRow.source_blocks })] });
    expect(repaired.details).toMatchObject({ ok: true, saved: true, draft_retained: false });
    const accepted = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(accepted.targets[1].name).toBe("已核对装置");
    expect(accepted.targets[1].source_blocks).toEqual(original.source_blocks);
    expect(accepted.targets.filter((_: unknown, i: number) => i !== 1)).toEqual(f.selectors.targets.filter((_, i) => i !== 1));
    expect((await f.workspace.readState()).validation_attempts).toBe(before.validations);
  });

  test("empty draft_id reads accepted selectors and unavailable tokens give a runnable accepted read", async () => {
    const f = await fixture();
    const requested = { collection: "targets", key: "target-0", view: "full" };
    const blank = await f.controller.dispatch("read_document_selectors", { ...requested, draft_id: "" });
    expect(blank).toMatchObject({ ok: true, view_source: "accepted", collection: "targets", view: "full" });
    expect((blank.rows as Array<{ key: string }>)[0]!.key).toBe("target-0");

    const unavailable = await f.controller.dispatch("read_document_selectors", { ...requested, draft_id: "accepted" });
    expect(unavailable).toMatchObject({ ok: false, error: "selector_draft_unavailable",
      next_tool: "read_document_selectors", next_tool_arguments: requested });
    expect(unavailable.instruction).toContain("Omit draft_id entirely");
    const recovered = await f.controller.dispatch("read_document_selectors", unavailable.next_tool_arguments as Record<string, unknown>);
    expect(recovered).toMatchObject({ ok: true, view_source: "accepted", collection: "targets", view: "full" });
  });

  test("successful dry run commits without repeating edits, across controllers, through provider codec", async () => {
    const f = await fixture();
    const codec = await ModelSourceHandles.open(f.workspace.root);
    let tools = codec.wrapTools(createDocumentDiscoveryTools(f.controller));
    const invoke = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("call", args, undefined as never, undefined as never);
    const before = await f.snapshot();
    const prepared = await invoke("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "已审传感装置" })] });
    const response = prepared.details as Record<string, unknown>;
    expect(response).toMatchObject({ ok: true, saved: false, draft_retained: true });
    expect(await f.snapshot()).toEqual(before);
    const reopened = await DocumentDiscoveryController.create(f.workspace);
    tools = codec.wrapTools(createDocumentDiscoveryTools(reopened));
    const read = await invoke("read_document_selectors", { draft_id: response.draft_id, collection: "targets", key: "target-0" });
    const visible = JSON.parse((read.content[0] as { text: string }).text);
    expect(visible.rows[0].name).toBe("已审传感装置");
    expect(visible.rows[0].scope_span_ids[0]).toMatch(/^s\d+$/);
    const stored = JSON.parse(await readFile(f.pendingPath, "utf8"));
    expect(JSON.stringify(stored)).toContain("span:");
    expect(JSON.stringify(stored)).not.toContain('"$part');
    const committed = await invoke("edit_document_selectors", { draft_id: response.draft_id, edits: [] });
    expect(committed.details).toMatchObject({ ok: true, saved: true, draft_retained: false });
    expect(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8")).targets[0].name).toBe("已审传感装置");
    expect((await f.workspace.readState()).validation_attempts).toBe(before.validations);
    expect(await reopened.dispatch("edit_document_selectors", { draft_id: response.draft_id, edits: [] })).toMatchObject({ ok: false, saved: false });
    expect(await reopened.dispatch("edit_document_selectors", { edits: [] })).toMatchObject({ error: "invalid_selector_edits" });
  });

  test("a rejected twenty-target edit is retained and repaired with one delta, not regenerated", async () => {
    const f = await fixture(21, true);
    const before = await f.snapshot();
    const failed = await f.controller.dispatch("edit_document_selectors", { edits: Array.from({ length: 20 }, (_, i) => f.edit(i, { name: `已审装置${i + 1}` })) });
    expect(failed).toMatchObject({ ok: false, saved: false, draft_retained: true, pre_existing_target_keys: ["target-20"],
      next_tool: "read_document_selectors", next_tool_arguments: { collection: "targets", key: "target-20", draft_id: failed.draft_id } });
    expect(await f.snapshot()).toEqual(before);
    const stillInvalid = await f.controller.dispatch("edit_document_selectors", { draft_id: failed.draft_id, edits: [] });
    expect(stillInvalid).toMatchObject({ ok: false, saved: false, draft_retained: true });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.controller.dispatch("read_document_selectors", { draft_id: failed.draft_id })).toMatchObject({ error: "selector_draft_token_stale" });
    const pending = await f.controller.dispatch("read_document_selectors", { draft_id: stillInvalid.draft_id, collection: "targets", view: "full", limit: 100 });
    const retained = (pending.rows as unknown[]).slice(0, 20);
    const fixed = await f.controller.dispatch("edit_document_selectors", { draft_id: stillInvalid.draft_id,
      edits: [f.edit(20, { semantic_basis: { ...f.selectors.targets[20]!.semantic_basis!, acceptance_span_ids: f.bound.aliases.get("part20")!.span_ids } })] });
    expect(fixed).toMatchObject({ ok: true, saved: true });
    const accepted = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(accepted.targets.slice(0, retained.length)).toEqual(retained);
    expect(accepted.targets.slice(0, 20).map((target: { name: string }) => target.name)).toEqual(Array.from({ length: 20 }, (_, i) => `已审装置${i + 1}`));
  });

  test("schema-invalid drafts can be repaired but accepted files remain unchanged until valid", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const bad = await f.controller.dispatch("edit_document_selectors", { edits: [f.edit(0, { name: 17 })] });
    expect(bad).toMatchObject({ error: "document_selector_schema_rejected", saved: false, draft_retained: true });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: bad.draft_id, edits: [f.edit(0, { name: "修正装置" })] })).toMatchObject({ ok: true, saved: true });
  });

  test("new pending bindings coexist with spans located after preflight", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const prepared = await f.controller.dispatch("edit_document_selectors", { dry_run: true,
      source_bindings: [{ key: "pair", start_line: 1, end_exclusive_line: 3 }],
      edits: [{ collection: "contexts", key: "pair-note", op: "upsert", value: { role: "other_context", name: "设备说明", span_ids: ["$pair"], reason: "已读两设备条文" } }],
    });
    expect(prepared).toMatchObject({ ok: true, saved: false });
    expect(await f.snapshot()).toEqual(before);
    await f.controller.dispatch("locate_document_span", { atom_id: f.controller.evidence.atoms[0]!.atom_id, quote: "装置3外壳" });
    const located = await f.workspace.readSourceSpanRegistry();
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ ok: true, saved: true });
    const committed = await f.workspace.readSourceSpanRegistry();
    for (const span of located.spans) expect(committed.spans).toContainEqual(span);
    const selectors = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(committed.spans.some(span => span.span_id === selectors.contexts[0].span_ids[0])).toBe(true);
    const conflicting = structuredClone(committed);
    conflicting.spans[0]!.start += 1;
    expect(() => mergeDiscoveryDraftRegistry(committed, conflicting)).toThrow("selector_draft_registry_conflict");
  });

  test("wrong phase, stale accepted base, corrupt token and copied ownership are rejected without writes", async () => {
    const f = await fixture();
    const prepare = () => f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "待审" })] });
    let prepared = await prepare();
    let before = await f.snapshot();
    const reviewer = await DocumentDiscoveryController.create(f.workspace, "review");
    expect(await reviewer.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ error: "selector_draft_scope_mismatch", saved: false });
    expect(await f.controller.dispatch("read_document_selectors", { draft_id: "../../elsewhere" })).toMatchObject({ error: "selector_draft_token_invalid" });
    expect(await f.snapshot()).toEqual(before);
    const changed = structuredClone(f.selectors); changed.targets[1]!.name = "独立保存的修改";
    await f.workspace.writeWorkingSelectors(JSON.stringify(changed));
    before = await f.snapshot();
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ error: "selector_draft_base_stale" });
    expect(await f.snapshot()).toEqual(before);
    prepared = await prepare();
    const original = JSON.parse(await readFile(f.pendingPath, "utf8"));
    await atomicWriteJson(f.pendingPath, { ...original, draft: { ...original.draft, phase_epoch: "corrupt" } });
    expect(await f.controller.dispatch("read_document_selectors", { draft_id: prepared.draft_id })).toMatchObject({ error: "selector_draft_corrupt" });
    const copied = { ...original.draft, owner_root: "other-workspace" };
    await atomicWriteJson(f.pendingPath, { draft_id: sha256Json(copied), draft: copied });
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: sha256Json(copied), edits: [] })).toMatchObject({ error: "selector_draft_corrupt" });
    expect(await f.snapshot()).toEqual(before);
  });

  test("starting a new independent review invalidates an earlier review draft", async () => {
    const f = await fixture();
    await f.workspace.markCandidate();
    const review = await DocumentDiscoveryController.create(f.workspace, "review");
    await review.dispatch("batch_open_document_atoms", { atom_ids: review.evidence.atoms.map(atom => atom.atom_id) });
    const prepared = await review.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "复核修订" })] });
    expect(prepared).toMatchObject({ ok: true, draft_retained: true });
    await f.workspace.markCandidate();
    const before = await f.snapshot();
    expect(await review.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ error: "selector_draft_scope_mismatch" });
    expect(await f.snapshot()).toEqual(before);
  });

  test("pending deltas cannot bypass total operation, byte or new-record limits", async () => {
    const f = await fixture(41);
    const before = await f.snapshot();
    const forty = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: Array.from({ length: 40 }, (_, i) => f.edit(i, { name: `修订${i}` })) });
    expect(forty).toMatchObject({ ok: true, draft_retained: true });
    const repaired = await f.controller.dispatch("edit_document_selectors", { draft_id: forty.draft_id, dry_run: true, edits: [f.edit(0, { name: "修好第一个" })] });
    expect(repaired).toMatchObject({ ok: true, saved: false, draft_retained: true });
    expect(JSON.parse(await readFile(f.pendingPath, "utf8")).draft.operations).toHaveLength(40);
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: repaired.draft_id, edits: [f.edit(40, { name: "越界" })] })).toMatchObject({ error: "selector_draft_limit_exceeded", saved: false });
    expect(await f.controller.dispatch("discard_document_selector_draft", { draft_id: repaired.draft_id })).toMatchObject({ ok: true, discarded_change_count: 40 });
    const large = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { reason: "甲".repeat(24 * 1024) })] });
    expect(large).toMatchObject({ ok: true, draft_retained: true });
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: large.draft_id, edits: [f.edit(1, { reason: "乙".repeat(24 * 1024) })] })).toMatchObject({ error: "selector_draft_limit_exceeded", saved: false });
    const revised = await f.controller.dispatch("edit_document_selectors", { draft_id: large.draft_id, dry_run: true, edits: [f.edit(0, { reason: "丙".repeat(24 * 1024) })] });
    expect(revised).toMatchObject({ ok: true, saved: false });
    expect(await f.controller.dispatch("discard_document_selector_draft", { draft_id: revised.draft_id })).toMatchObject({ ok: true });
    const context = (i: number) => ({ collection: "contexts", key: `note-${i}`, op: "upsert", value: { role: "other_context", name: "辅助说明", span_ids: f.selectors.targets[0]!.scope_span_ids, reason: "原文说明" } });
    const four = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: Array.from({ length: 4 }, (_, i) => context(i)) });
    expect(four).toMatchObject({ ok: true, draft_retained: true });
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: four.draft_id, edits: [context(4)] })).toMatchObject({ error: "incremental_discovery_checkpoint_required", saved: false });
    expect(await f.snapshot()).toEqual(before);
  });

  test("net keyed patches preserve order through removes and reinsertions", async () => {
    const f = await fixture();
    const after = structuredClone(f.selectors);
    after.targets = [after.targets[2]!, { ...after.targets[0]!, name: "调整后的顺序" }];
    expect(applyJsonPatch(f.selectors, discoveryDraftOperations(f.selectors, after))).toEqual(after);
  });

  test("misspelled handle recovers the retained twenty-target transaction, never restarts it", async () => {
    const f = await fixture(21, true);
    const before = await f.snapshot();
    const failed = await f.controller.dispatch("edit_document_selectors", { edits: Array.from({ length: 20 }, (_, i) => f.edit(i, { name: `已审装置${i + 1}` })) });
    expect(failed.draft_id).toMatch(/^d_[a-f0-9]{12}$/);
    const recovery = await f.controller.dispatch("read_document_selectors", { draft_id: String(failed.draft_id).slice(0, -1) });
    expect(recovery).toMatchObject({ ok: false, saved: false, draft_retained: true, error: "selector_draft_token_invalid",
      draft_id: failed.draft_id, next_tool: "read_document_selectors", next_tool_arguments: { draft_id: failed.draft_id } });
    const repair = f.edit(20, { semantic_basis: { ...f.selectors.targets[20]!.semantic_basis!, acceptance_span_ids: f.bound.aliases.get("part20")!.span_ids } });
    const omitted = await f.controller.dispatch("edit_document_selectors", { edits: [repair] });
    expect(omitted).toMatchObject({ error: "selector_pending_draft_requires_action", draft_id: failed.draft_id, pending_change_count: 20 });
    expect(await f.snapshot()).toEqual(before);
    const acceptedRead = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "target-0" });
    expect(acceptedRead).toMatchObject({ view_source: "accepted", pending_draft: { draft_id: failed.draft_id } });
    expect((acceptedRead.rows as Array<{ name: string }>)[0]!.name).toBe("装置1");
    const tools = createDocumentDiscoveryTools(f.controller);
    expect(tools.some(tool => tool.name === "discard_document_selector_draft")).toBe(true);
    const committed = await f.controller.dispatch("edit_document_selectors", { draft_id: recovery.draft_id, edits: [repair] });
    expect(committed).toMatchObject({ ok: true, saved: true, draft_retained: false });
    const accepted = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    expect(accepted.targets.slice(0, 20).map((target: { name: string }) => target.name)).toEqual(Array.from({ length: 20 }, (_, i) => `已审装置${i + 1}`));
    expect((await readdir(f.workspace.historyDirectory)).length).toBe(before.history.length + 1);
  });

  test("pending transaction blocks patch, replacement and finalization until explicitly discarded", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const prepared = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "必须保留的待修记录" })] });
    for (const tool of ["patch_document_selectors", "replace_document_selectors", "submit_document_selectors", "correct_document_selectors",
      "compile_document_selectors", "submit_discovery_candidate", "seal_discovery_plan"]) {
      expect(await f.controller.dispatch(tool, {})).toMatchObject({ error: "selector_pending_draft_requires_action", saved: false, draft_id: prepared.draft_id });
    }
    expect(await f.controller.dispatch("discard_document_selector_draft", { draft_id: "d_000000000000" })).toMatchObject({ ok: false, draft_retained: true });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.controller.dispatch("discard_document_selector_draft", { draft_id: prepared.draft_id }))
      .toMatchObject({ ok: true, saved: false, draft_retained: false, discarded_change_count: 1 });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.controller.dispatch("edit_document_selectors", { edits: [f.edit(1, { name: "另起明确事务" })] }))
      .toMatchObject({ ok: true, saved: true });
    expect(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8")).targets[0].name).toBe("装置1");
  });

  test("all missing aliases in a repair are reported without replacing the pending transaction", async () => {
    const f = await fixture();
    const prepared = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "保留已审结果" })] });
    const pendingBefore = await readFile(f.pendingPath, "utf8");
    const before = await f.snapshot();
    const rejected = await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id,
      edits: [f.edit(1, { scope_span_ids: ["$c632"], lot_basis_span_ids: ["$c633"] })] });
    expect(rejected).toMatchObject({ error: "discovery_source_binding_rejected", saved: false, draft_retained: true, draft_id: prepared.draft_id,
      issues: [
        { code: "discovery_binding_alias_unknown", path: "/edits/0/value/scope_span_ids/0", details: { unknown_alias_count: 2, missing_alias_keys: ["c632", "c633"] } },
        { code: "discovery_binding_alias_unknown", path: "/edits/0/value/lot_basis_span_ids/0" },
      ] });
    expect(await readFile(f.pendingPath, "utf8")).toBe(pendingBefore);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [] })).toMatchObject({ ok: true, saved: true });
    expect(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8")).targets[0].name).toBe("保留已审结果");
  });

  test("idempotent edits and cancelling every pending change leave no unusable token or checkpoint", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    expect(await f.controller.dispatch("edit_document_selectors", { edits: [f.edit(0, { name: f.selectors.targets[0]!.name })] }))
      .toMatchObject({ ok: true, saved: false, changed: false, draft_retained: false });
    expect(await f.snapshot()).toEqual(before);
    const prepared = await f.controller.dispatch("edit_document_selectors", { dry_run: true, edits: [f.edit(0, { name: "待修" })] });
    const cancelled = await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, edits: [f.edit(0, { name: f.selectors.targets[0]!.name })] });
    expect(cancelled).toMatchObject({ ok: true, saved: false, changed: false, draft_retained: false });
    expect(cancelled).not.toHaveProperty("draft_id");
    expect(await f.snapshot()).toEqual(before);
  });

  test("preflight fingerprint matches its reconciled draft and supports fingerprint-guarded commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-pending-anchor-"));
    const path = join(root, "source.md");
    await writeFile(path, "## 4.1 设备安装\n\n4.1.1 外壳应完好。\n检查数量：全数。\n");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "test", path);
    await workspace.writeWorkingSelectors(JSON.stringify(initialDocumentSelectorPlan("test")));
    await workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
    const controller = await DocumentDiscoveryController.create(workspace);
    const atom = controller.evidence.atoms[0]!;
    await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
    const atomSpan = (await workspace.readSourceSpanRegistry()).spans.find(span => span.start === 0 && span.end === atom.text.length)!.span_id;
    const f = await fixture();
    const value = { ...f.selectors.targets[0]!, key: "device", scope_span_ids: ["$clause"], lot_basis_span_ids: ["$clause"],
      source_blocks: [{ kind: "heading_section", anchor_span_id: "$heading", start_span_id: "$clause", end_span_id: "$clause", reason: "含相邻标题的设备范围" }],
      semantic_basis: { ...f.selectors.targets[0]!.semantic_basis!, acceptance_span_ids: ["$clause"] } };
    const prepared = await controller.dispatch("edit_document_selectors", { dry_run: true,
      source_bindings: [{ key: "heading", start_line: 1, end_exclusive_line: 2 }, { key: "clause", start_line: 3, extent: "clause" }],
      edits: [{ collection: "targets", key: "device", op: "upsert", value },
        { collection: "dispositions", key: atomSpan, op: "upsert", value: { disposition: "target", target_keys: [], reason: "实体质量要求" } }],
    });
    expect(prepared).toMatchObject({ ok: true, saved: false, reconciled_source_block_keys: ["device"], reconciled_disposition_keys: [atomSpan] });
    const pending = await controller.dispatch("read_document_selectors", { draft_id: prepared.draft_id, collection: "targets", key: "device" });
    expect(pending.selector_fingerprint).toBe(prepared.selector_fingerprint);
    const row = (pending.rows as typeof f.selectors.targets)[0]!;
    expect(row.source_blocks[0]!.start_span_id).toBe(row.source_blocks[0]!.anchor_span_id);
    expect(await controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, expected_selector_fingerprint: prepared.selector_fingerprint, edits: [] })).toMatchObject({ ok: true, saved: true });
  });

  test("forty authored changes plus derived mirrors stay resumable without charging derived fields", async () => {
    const f = await fixture(41);
    f.selectors.dispositions[0]!.target_keys = [];
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const prepared = await f.controller.dispatch("edit_document_selectors", { dry_run: true,
      edits: Array.from({ length: 40 }, (_, i) => f.edit(i, { name: `核对装置${i}` })),
    });
    expect(prepared).toMatchObject({ ok: true, saved: false, draft_retained: true });
    const stored = JSON.parse(await readFile(f.pendingPath, "utf8"));
    expect(stored.draft.operations).toHaveLength(40);
    expect(discoveryDraftOperations(f.selectors, stored.draft.selectors)).toHaveLength(41);
    const pending = await f.controller.dispatch("read_document_selectors", { draft_id: prepared.draft_id });
    expect(pending.selector_fingerprint).toBe(prepared.selector_fingerprint);
    expect(await f.controller.dispatch("edit_document_selectors", { draft_id: prepared.draft_id, expected_selector_fingerprint: prepared.selector_fingerprint, edits: [] }))
      .toMatchObject({ ok: true, saved: true });
  });

  test("a nonempty edit normalized back to accepted creates neither pending token nor checkpoint", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    for (const dry_run of [true, false]) {
      const result = await f.controller.dispatch("edit_document_selectors", { dry_run,
        edits: [{ collection: "dispositions", key: f.selectors.dispositions[0]!.atom_span_id, op: "update", value: { target_keys: [] } }],
      });
      expect(result).toMatchObject({ ok: true, saved: false, changed: false, draft_retained: false });
      expect(result).not.toHaveProperty("draft_id");
      expect(await f.snapshot()).toEqual(before);
    }
  });

  test("live obligations use checkpoint semantics for pending seed overlap and surface authored errors first", async () => {
    const f = await fixture(15);
    for (const target of f.selectors.targets.slice(1)) delete target.semantic_basis;
    f.selectors.targets[2]!.source_blocks = structuredClone(f.selectors.targets[1]!.source_blocks);
    f.selectors.targets[2]!.scope_span_ids = [...f.selectors.targets[1]!.scope_span_ids];
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const saved = await f.controller.dispatch("edit_document_selectors", { edits: [f.edit(0, { reason: "核对完整条文" })] });
    expect(saved).toMatchObject({ ok: true, saved: true, final_compile_ready: false });
    const pending = await f.controller.dispatch("read_discovery_obligations", {});
    expect(pending.selector_issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "selector_target_primary_overlap" })]));
    const broken = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"));
    broken.targets[0].semantic_basis.acceptance_span_ids = f.bound.aliases.get("part1")!.span_ids;
    await f.workspace.writeWorkingSelectors(JSON.stringify(broken));
    const issues = await f.controller.dispatch("read_discovery_obligations", {});
    expect(issues.selector_issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "selector_semantic_evidence_unbound" })]));
    expect((issues.selector_issues as Array<{ code: string }>)[0]!.code).not.toBe("selector_target_semantic_basis_required");
  });
});
