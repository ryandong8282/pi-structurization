import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace, createDocumentDiscoveryTools } from "../src/document-discovery.js";
import { initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { runFullDocumentDiscovery } from "../src/batch.js";
import * as runtime from "../src/pi-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-discovery-read-"));
  roots.push(root);
  const markdownPath = join(root, "source.md");
  await writeFile(markdownPath, "设备外壳应完好。\n");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "neutral", markdownPath);
  const controller = await DocumentDiscoveryController.create(workspace);
  const atom = controller.evidence.atoms[0]!;
  const span = (await workspace.readSourceSpanRegistry()).spans.find(s => s.atom_id === atom.atom_id)!;
  const selectors = initialDocumentSelectorPlan("neutral");
  selectors.targets = [{
    key: "device", name: "设备", group_key: "devices", group_name: "设备", group_reason: "设备验收",
    lot_basis_summary: "设备外壳质量", scope_span_ids: [span.span_id], lot_basis_span_ids: [span.span_id], reason: "实体质量要求",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: span.span_id, start_span_id: span.span_id, end_span_id: span.span_id, reason: "完整原文" }],
    semantic_basis: { subject: "设备", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span.span_id], acceptance_reason: "外壳完好", boundary_reason: "单一设备" },
  }];
  selectors.dispositions = [{ atom_span_id: span.span_id, disposition: "target", target_keys: ["device"], reason: "实体要求" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  return { root, markdownPath, workspace, controller, atom };
}

describe("discovery source-read recovery", () => {
  test.each(["candidate", "review"] as const)("%s receipt supplies a callable scoped handle and allows unchanged selectors after the required read", async phase => {
    const f = await fixture();
    if (phase === "review") {
      await f.controller.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
      const checked = await f.controller.dispatch("compile_document_selectors", {});
      expect(checked.ok).toBe(true);
      expect(await f.controller.dispatch("submit_discovery_candidate", { fingerprint: checked.fingerprint })).toMatchObject({ ok: true });
    }
    const controller = await DocumentDiscoveryController.create(f.workspace, phase);
    const codec = await ModelSourceHandles.open(f.workspace.root);
    await codec.encode({ atom_id: "atom:unrelated-navigation-entry" });
    const tools = codec.wrapTools(createDocumentDiscoveryTools(controller));
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await tools.find(tool => tool.name === name)!.execute("test", args, undefined as never, undefined as never);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const failed = await invoke("compile_document_selectors", {});
    expect(failed).toMatchObject({ ok: false, required_action: "open_unread_document_atoms_then_recompile", writable_paths: [],
      next_tool: "open_document_atom", next_tool_arguments: { atom_id: "a2" }, retry_tool: "compile_document_selectors", source_handle_scope: codec.scope });
    expect(failed.validation_attempts_remaining).toBe(5);
    expect(failed.actual.unopened_atom_ids).toEqual(["a2"]);
    expect(failed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unopened_target_atom", details: { atom_id: "a2" } }),
      expect.objectContaining({ code: "unopened_document_atom", details: { atom_id: "a2" } }),
    ]));
    const opened = await invoke(failed.next_tool, { ...failed.next_tool_arguments, source_handle_scope: failed.source_handle_scope });
    expect(opened).toMatchObject({ ok: true, atom: { atom_id: "a2" } });
    expect(JSON.stringify(opened.atom)).toContain(f.atom.text.trim());
    expect(await invoke(failed.retry_tool, {})).toMatchObject({ ok: true });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
  });

  test("a genuinely repeated failure stays terminal and retains the selectors", async () => {
    const f = await fixture();
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    expect((await f.controller.dispatch("compile_document_selectors", {})).ok).toBe(false);
    const repeated = await f.controller.dispatch("compile_document_selectors", {});
    expect(repeated).toMatchObject({ ok: false, error: "non_converging_selector_repeat", terminal: true });
    expect(runtime.terminalToolFailure(repeated)).toMatchObject({ error: "non_converging_selector_repeat" });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
  });

  test.each(["working", "saved_candidate"] as const)("batch does not re-prompt a terminal author from %s state", async phase => {
    const f = await fixture();
    if (phase === "saved_candidate") await f.workspace.markCandidate();
    const candidate = vi.spyOn(runtime, "runLiveDocumentDiscovery").mockResolvedValue({
      session_id: "stopped", session_file: "stopped.jsonl", candidate_ready: false, model: "test",
      error: "non_converging_selector_repeat", terminal_failure: true,
    });
    const review = vi.spyOn(runtime, "runLiveDocumentReview").mockResolvedValue({
      session_id: "stopped", session_file: "stopped.jsonl", sealed: false, model: "test",
      error: "non_converging_selector_repeat", terminal_failure: true,
    });
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    await expect(runFullDocumentDiscovery({ artifactRoot: f.root, jobId: "neutral", markdownPath: f.markdownPath,
      concurrency: 1, maxAttempts: 3, live: true })).rejects.toThrow("non_converging_selector_repeat");
    expect(candidate).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
  });
});
