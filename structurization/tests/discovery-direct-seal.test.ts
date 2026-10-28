import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runFullDocumentDiscovery } from "../src/batch.js";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace, createDocumentDiscoveryTools } from "../src/document-discovery.js";
import { initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import * as runtime from "../src/pi-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-direct-discovery-")); roots.push(root);
  const markdownPath = join(root, "neutral.md"); await writeFile(markdownPath, "设备外壳应完好。\n");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "neutral", markdownPath);
  const author = await DocumentDiscoveryController.create(workspace, "candidate");
  const atom = author.evidence.atoms[0]!;
  const span = (await workspace.readSourceSpanRegistry()).spans.find(s => s.atom_id === atom.atom_id)!;
  const selectors = initialDocumentSelectorPlan("neutral");
  selectors.targets = [{ key: "device", name: "设备", group_key: "devices", group_name: "设备", group_reason: "设备要求", lot_basis_summary: "设备外壳质量", scope_span_ids: [span.span_id], lot_basis_span_ids: [span.span_id], reason: "原文有直接质量要求",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: span.span_id, start_span_id: span.span_id, end_span_id: span.span_id, reason: "完整的具名设备要求" }],
    semantic_basis: { subject: "设备", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span.span_id], acceptance_reason: "外壳完好", boundary_reason: "单一设备要求" } }];
  selectors.dispositions = [{ atom_span_id: span.span_id, disposition: "target", target_keys: ["device"], reason: "设备要求" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await author.dispatch("open_document_atom", { atom_id: atom.atom_id });
  return { root, markdownPath, workspace, author, atom, selectors };
}

describe("direct discovery seal", () => {
 test("the author seals validated source without independent-review tools or authority", async () => {
   const f = await fixture(); await f.workspace.setRuntime({ kind: "pi-sdk", session_id: "author", session_file: "author.jsonl" });
   const names = createDocumentDiscoveryTools(f.author).map(tool => tool.name);
   expect(names).toContain("seal_discovery_plan");
   expect(names).not.toContain("submit_discovery_candidate");
   expect(names).not.toContain("record_discovery_review");
   const valid = await f.author.dispatch("compile_document_selectors", {}); expect(valid).toMatchObject({ ok: true });
   const beforeTypo = await f.workspace.readState();
   expect(await f.author.dispatch("seal_discovery_plan", { fingerprint: "wrong" })).toMatchObject({ ok: false,
     current_checkpoint_verified: true, validation_required: false, next_tool: 'seal_discovery_plan',
     next_tool_arguments: { fingerprint: valid.fingerprint } });
   const { next_event_sequence: _eventsBefore, ...countsBefore } = beforeTypo;
   const { next_event_sequence: _eventsAfter, ...countsAfter } = await f.workspace.readState();
   expect(countsAfter).toEqual(countsBefore);
   expect(await f.author.dispatch("seal_discovery_plan", { fingerprint: valid.fingerprint })).toMatchObject({ ok: true });
   const receipt = JSON.parse(await readFile(f.workspace.sealReceiptPath, "utf8"));
   expect(receipt).toMatchObject({ independent_semantic_review_performed: false, sealing_role: "discovery_author" });
   expect((await f.workspace.readState()).reviewer_validation_attempts ?? 0).toBe(0);
 });
 test("a saved legacy candidate resumes the author and never invokes independent review", async () => {
   const f = await fixture(); const valid = await f.author.dispatch("compile_document_selectors", {});
   expect(await f.author.dispatch("submit_discovery_candidate", { fingerprint: valid.fingerprint })).toMatchObject({ ok: true });
   const before = await readFile(f.workspace.workingSelectorPath, "utf8");
   const reviewer = vi.spyOn(runtime, "runLiveDocumentReview").mockRejectedValue(new Error("Independent review must not run"));
   const author = vi.spyOn(runtime, "runLiveDocumentDiscovery").mockImplementation(async (ws, controller) => {
     await ws.setRuntime({ kind: "pi-sdk", session_id: "resumed-author", session_file: "author.jsonl" });
     const checked = await controller.dispatch("compile_document_selectors", {}); expect(checked).toMatchObject({ ok: true });
     expect(await controller.dispatch("seal_discovery_plan", { fingerprint: checked.fingerprint })).toMatchObject({ ok: true });
     return { session_id: "resumed-author", session_file: "author.jsonl", model: "neutral", candidate_ready: true };
   });
   const result = await runFullDocumentDiscovery({ artifactRoot: f.root, jobId: "neutral", markdownPath: f.markdownPath, concurrency: 1, maxAttempts: 1, live: true });
   expect(result.plan.targets).toHaveLength(1); expect(author).toHaveBeenCalledOnce(); expect(reviewer).not.toHaveBeenCalled();
   expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
 });
 test("unread source and stale selectors still block the author's finalization", async () => {
   const f = await fixture();
   const state = await f.workspace.readState(); state.opened_atom_ids = [];
   await writeFile(f.workspace.statePath, JSON.stringify(state));
   expect(await f.author.dispatch("compile_document_selectors", {})).toMatchObject({ ok: false });
   await f.author.dispatch("open_document_atom", { atom_id: f.atom.atom_id });
   const valid = await f.author.dispatch("compile_document_selectors", {}); expect(valid).toMatchObject({ ok: true });
   const selectors = { ...f.selectors, targets: [{ ...f.selectors.targets[0]!, name: "设备外壳" }] };
   await f.workspace.writeWorkingSelectors(JSON.stringify(selectors));
   expect(await f.author.dispatch("seal_discovery_plan", { fingerprint: valid.fingerprint })).toMatchObject({ ok: false });
 });
 test('an edited compiled plan cannot turn a wrong fingerprint into a verified retry', async () => {
   const f = await fixture();
   await f.author.dispatch('compile_document_selectors', {});
   const plan = JSON.parse(await readFile(f.workspace.workingPlanPath, 'utf8'));
   plan.targets[0].name = '改动后的其他名称';
   await writeFile(f.workspace.workingPlanPath, JSON.stringify(plan));
   const response = await f.author.dispatch('seal_discovery_plan', { fingerprint: 'wrong' });
   expect(response).toMatchObject({ ok: false, current_checkpoint_verified: false,
     validation_required: true, next_tool: 'compile_document_selectors' });
 });
});
