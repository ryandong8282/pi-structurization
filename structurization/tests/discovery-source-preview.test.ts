import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { initialDocumentSelectorPlan, type DocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { locateAndRegisterSourceQuote } from "../src/source-span-registry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-discovery-boundaries-")); roots.push(root);
  const first = "装置甲的接线应牢固。", second = "装置乙的外壳应完整。";
  const source = `${first}\n${second}\n`, sourcePath = join(root, "synthetic.md");
  await writeFile(sourcePath, source);
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "neutral", sourcePath);
  const controller = await DocumentDiscoveryController.create(workspace), atom = controller.evidence.atoms[0]!;
  let registry = await workspace.readSourceSpanRegistry();
  const full = registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id;
  const locate = (quote: string) => {
    const located = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
    registry = located.registry; return located.spans[0]!.span_id;
  };
  const a = locate(first), b = locate(second), selectors = initialDocumentSelectorPlan("neutral");
  const target = (key: string, name: string, anchor: string, start: string, end: string): DocumentSelectorPlan["targets"][number] => ({
    key, name, group_key: "devices", group_name: "装置", group_reason: "装置质量检查", reason: "实体质量要求",
    lot_basis_summary: "本装置质量", scope_span_ids: [start], lot_basis_span_ids: [anchor],
    semantic_basis: { subject: name, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [anchor],
      acceptance_reason: "本装置的直接质量要求", boundary_reason: "按实际受检装置确认范围" },
    source_blocks: [{ kind: "explicit_range", anchor_span_id: anchor, start_span_id: start, end_span_id: end, reason: "作者选中的边界" }],
  });
  selectors.targets = [target("a", "装置甲", a, a, a), target("b", "装置乙", b, full, full)];
  selectors.dispositions = [{ atom_span_id: full, disposition: "target", target_keys: ["a", "b"], reason: "两装置的原文" }];
  await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry));
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  return { workspace, controller, atom, source, first, second, selectors, a, b, full };
}

describe("discovery reads expose the submitted source boundaries", () => {
  test.each(["missing", "null", "invalid_entry"])("malformed %s source blocks remain readable for author repair", async kind => {
    const f = await fixture();
    const row = f.selectors.targets[1] as unknown as Record<string, unknown>;
    if (kind === "missing") delete row.source_blocks;
    else row.source_blocks = kind === "null" ? null : [null];
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const detail = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(detail).toMatchObject({ ok: true, rows: [row] });
    if (kind === "invalid_entry") expect(detail.source_block_previews[0].source_blocks[0]).toMatchObject({ status: "unavailable" });
    else expect(detail.source_block_previews[0]).toMatchObject({ source_blocks_status: "unavailable", source_blocks: [] });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await f.workspace.readState()).opened_atom_ids).toEqual([]);
  });

  test("end_before uses the start of the terminal span without including that later subject", async () => {
    const f = await fixture();
    f.selectors.targets[0]!.source_blocks = [{ kind: "explicit_range", anchor_span_id: f.a,
      start_span_id: f.a, end_before_span_id: f.b, reason: "结束于下一对象之前" }];
    await f.workspace.writeWorkingSelectors(JSON.stringify(f.selectors));
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const detail = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "a" }) as any;
    expect(detail.source_block_previews[0].source_blocks[0]).toMatchObject({ end_mode: "before_span",
      materialized_range: { start_offset: 0, end_exclusive_offset: f.first.length + 1, start_line: 1, end_exclusive_line: 2, ordered: true } });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
  });

  test("a later anchor does not hide preceding primary text, and the author can repair its exact boundary", async () => {
    const f = await fixture(), before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const unopened = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    const block = unopened.source_block_previews[0].source_blocks[0];
    expect(block.materialized_range).toMatchObject({ start_line: 1, end_exclusive_line: 3, characters_before_anchor: f.first.length + 1 });
    expect(block.start).toMatchObject({ source_read: false, read_tool: "open_document_atom", tool_arguments: { atom_id: f.atom.atom_id } });
    expect(block.start).not.toHaveProperty("source_preview");
    expect(unopened.rows).toEqual([f.selectors.targets[1]]);
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await f.workspace.readState()).opened_atom_ids).toEqual([]);
    await f.controller.dispatch(block.start.read_tool, block.start.tool_arguments);
    const opened = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(opened.source_block_previews[0].source_blocks[0].start.source_preview.first_text).toBe(f.source);
    expect(opened.source_block_previews[0].source_blocks[0].anchor.source_preview.first_text).toBe(f.second);
    const fixed = await f.controller.dispatch("edit_document_selectors", { edits: [{ collection: "targets", key: "b", op: "update",
      value: { source_blocks: [{ ...f.selectors.targets[1]!.source_blocks[0]!, start_span_id: f.b }], scope_span_ids: [f.b] } }] });
    expect(fixed, JSON.stringify(fixed)).toMatchObject({ ok: true });
    const detail = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(detail.source_block_previews[0].source_blocks[0].materialized_range).toMatchObject({ start_line: 2, end_exclusive_line: 3 });
    expect(detail.source_block_previews[0].source_blocks[0].start.source_preview.first_text).toBe(f.second);
  });

  test("the independent review requires its own source read before displaying excerpts", async () => {
    const f = await fixture(); await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    await f.workspace.markCandidate();
    const reviewer = await DocumentDiscoveryController.create(f.workspace, "review");
    const hidden = await reviewer.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(hidden.source_block_previews[0].source_blocks[0].start).toMatchObject({ source_read: false });
    expect(hidden.source_block_previews[0].source_blocks[0].start).not.toHaveProperty("source_preview");
    await reviewer.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const visible = await reviewer.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(visible.source_block_previews[0].source_blocks[0].start.source_preview.first_text).toBe(f.source);
    expect(visible.rows[0].source_blocks[0].start_span_id).toBe(f.full);
  });

  test("a retained dry-run boundary uses its pending registry while accepted records stay unchanged", async () => {
    const f = await fixture(); await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const pending = await f.controller.dispatch("edit_document_selectors", {
      dry_run: true, source_bindings: [{ key: "new_start", atom_id: f.atom.atom_id, start_line: 2, end_exclusive_line: 3 }],
      edits: [{ collection: "targets", key: "b", op: "update", value: {
        source_blocks: [{ ...f.selectors.targets[1]!.source_blocks[0]!, start_span_id: "$new_start" }], scope_span_ids: ["$new_start"],
      } }],
    }) as any;
    expect(pending, JSON.stringify(pending)).toMatchObject({ draft_retained: true, draft_id: expect.any(String) });
    const detail = await f.controller.dispatch("read_document_selectors", { draft_id: pending.draft_id, collection: "targets", key: "b" }) as any;
    expect(detail).toMatchObject({ view_source: "pending" });
    expect(detail.source_block_previews[0].source_blocks[0].start).toMatchObject({ status: "resolved", start_line: 2 });
    expect(detail.source_block_previews[0].source_blocks[0].start.source_preview.first_text).toBe(`${f.second}\n`);
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
    const accepted = await f.controller.dispatch("read_document_selectors", { collection: "targets", key: "b" }) as any;
    expect(accepted.source_block_previews[0].source_blocks[0].start.start_line).toBe(1);
  });
});
