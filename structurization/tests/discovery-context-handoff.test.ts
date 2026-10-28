import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Check } from "typebox/value";
import { prettyJson, sha256Text, sha256Json } from "../src/canonical.js";
import { buildDocumentEvidence, initialDocumentTargetPlan, DocumentDiscoveryWorkspace, DocumentDiscoveryController } from "../src/document-discovery.js";
import { initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { readDiscoveryContextNotes } from "../src/discovery-context.js";
import { createPiTools } from "../src/tools.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { buildSelectorStageScenario } from "./selector-stage-fixture.js";

const source = ["# 2 记录器", "", "## 2.1 接口", "", "2.1.1 接口应牢固。", "检验方法：手动检查。", "",
  "# 9 现场备忘", "9.0.1 本文件各装置每批随机检查12件，不足12件时全数检查，另有约定时从其约定。", ""].join("\n");

async function fixture(count = 1) {
  const result = await buildSelectorStageScenario(source);
  const root = join(result.workspace.artifactRoot, "jobs", result.workspace.jobId, "discovery");
  const document = buildDocumentEvidence(source, "selector-stage.md"), atom = document.atoms[0]!;
  const fragment = source.slice(source.indexOf("9.0.1"));
  const plan = initialDocumentTargetPlan(result.workspace.jobId, document);
  plan.context_notes = Array.from({ length: count }, (_, i) => ({ context_id: `context:neutral-${i}`,
    role: i % 2 ? "definition" as const : "governing_rule" as const, name: `跨范围候选${i}`,
    evidence_atom_ids: [atom.atom_id], evidence_fragments: [{ atom_id: atom.atom_id, text: fragment }],
    reason: "可能约束多个装置，由后续作者核对条件。" }));
  await mkdir(root, { recursive: true });
  async function save() {
    const planText = prettyJson(plan), evidenceText = prettyJson(document);
    await writeFile(join(root, "document-target-plan.json"), planText);
    await writeFile(join(root, "document-evidence.json"), evidenceText);
    await writeFile(join(root, "manifest.json"), prettyJson({ job_id: result.workspace.jobId,
      files: { plan_sha256: sha256Text(planText), evidence_sha256: sha256Json(document) } }));
  }
  await save();
  return { ...result, root, plan, document, fragment, save };
}

test("sealed discovery notes provide executable routes without loading bodies or altering checkpoint, manifest or budgets", async () => {
  const { controller, workspace } = await fixture();
  const before = await workspace.readState(), manifest = await readFile(workspace.evidenceManifestPath), draft = await readFile(workspace.workingSelectorPath);
  const page = await controller.discoveryContextPage() as any;
  expect(page).toMatchObject({ ok: true, status: "available", total: 1, metadata_only: true, applicability_checked: false });
  expect(page.notes[0]).toMatchObject({ name: "跨范围候选0", reason: "可能约束多个装置，由后续作者核对条件。", read_tool: "open_global_document_resource" });
  expect(JSON.stringify(page)).not.toContain("随机检查12件");
  expect(await workspace.readState()).toEqual(before);
  const tool = createPiTools(controller).find(t => t.name === page.notes[0].read_tool)!;
  expect(Check(tool.parameters, page.notes[0].tool_arguments)).toBe(true);
  const opened = await controller.dispatch(page.notes[0].read_tool, page.notes[0].tool_arguments);
  expect(JSON.stringify(opened)).toContain("不足12件时全数检查");
  expect(await readFile(workspace.evidenceManifestPath)).toEqual(manifest);
  expect(await readFile(workspace.workingSelectorPath)).toEqual(draft);
  const after = await workspace.readState();
  expect(after.validation_attempts).toBe(before.validation_attempts);
  expect(after.next_history_sequence).toBe(before.next_history_sequence);
});

test("independent context cursor pages all roles without repeating target orientation or reading source", async () => {
  const { controller, workspace } = await fixture(7);
  const before = await workspace.readState();
  const first = await controller.dispatch("get_target_context", { discovery_context_cursor: 0, discovery_context_limit: 3 }) as any;
  expect(first.notes).toHaveLength(3);
  expect(first.notes[1].role).toBe("definition");
  expect(first).not.toHaveProperty("resource_inventory");
  const next = first.next_context_page;
  expect(Check(createPiTools(controller).find(t => t.name === next.tool)!.parameters, next.arguments)).toBe(true);
  const second = await controller.dispatch(next.tool, next.arguments) as any;
  const third = await controller.dispatch(second.next_context_page.tool, second.next_context_page.arguments) as any;
  expect([...first.notes, ...second.notes, ...third.notes].map(row => row.context_id)).toEqual(Array.from({ length: 7 }, (_, i) => `context:neutral-${i}`));
  expect(third.next_context_page).toBeNull();
  expect((await workspace.readState()).opened_evidence_ids).toEqual(before.opened_evidence_ids);
});

test.each(["plan_hash", "source_version", "ambiguous_fragment"])("%s never silently supplies a stale candidate", async mode => {
  const { controller, root, plan, document, fragment, save } = await fixture();
  if (mode === "plan_hash") await writeFile(join(root, "document-target-plan.json"), prettyJson({ ...plan, context_notes: [] }));
  if (mode === "source_version") { document.source.sha256 = "0".repeat(64); await save(); }
  if (mode === "ambiguous_fragment") { plan.context_notes[0]!.evidence_fragments[0]!.text = "检查"; await save(); }
  const page = await controller.discoveryContextPage() as any;
  expect(page).toMatchObject({ status: "stale_or_invalid", notes: [], applicability_checked: false });
  expect(JSON.stringify(page)).not.toContain(fragment);
});

test("isolated source routes to reference facts without leaking discovery label, reason or raw body", async () => {
  const { controller, plan, fragment } = await fixture();
  const start = source.indexOf("9.0.1");
  vi.spyOn(controller as any, "isolatedGlobalDocumentRanges").mockResolvedValue([{ start, end: source.length, target_key: "reference-target:neutral" }]);
  const page = await controller.discoveryContextPage() as any;
  expect(page.notes[0]).toMatchObject({ access_mode: "isolated_reference", read_tool: "read_reference_facts", tool_arguments: { target_key: "reference-target:neutral" } });
  expect(JSON.stringify(page)).not.toContain(plan.context_notes[0]!.name);
  expect(JSON.stringify(page)).not.toContain(plan.context_notes[0]!.reason);
  expect(JSON.stringify(page)).not.toContain(fragment);
});

test("an identical quote from another source atom is not substituted for the discovered source", async () => {
  const { controller, manifest, fragment } = await fixture();
  const foreign = { ...manifest.evidence[0]!, evidence_id: "evidence:foreign-quote", atom_id: "atom:another-source",
    text: fragment, locator: `char:${source.indexOf("9.0.1")}-${source.length}` };
  controller.evidence.evidence.push(foreign);
  const page = await controller.discoveryContextPage() as any;
  expect(page.notes[0].read_tool).toBe("open_global_document_resource");
  expect(page.notes[0]).not.toHaveProperty("evidence_id", foreign.evidence_id);
});

test("initial context includes a small shared page and short handles preserve executable source routes", async () => {
  const { controller, workspace } = await fixture(8);
  const full = await controller.dispatch("get_target_context", {}) as any;
  expect(full.discovery_context.notes).toHaveLength(5);
  const handles = await ModelSourceHandles.open(workspace.root);
  const encoded = await handles.encode(full.discovery_context) as any;
  expect(encoded.notes[0].atom_id).toMatch(/^a\d+$/u);
  const decoded = await handles.decodeArguments({ ...encoded.notes[0].tool_arguments, source_handle_scope: handles.scope });
  const opened = await controller.dispatch(encoded.notes[0].read_tool, decoded);
  expect(JSON.stringify(opened)).toContain("不足12件时全数检查");
});

test("old tasks without discovery files keep their frozen inputs and return an explicit unavailable directory", async () => {
  const result = await buildSelectorStageScenario(source);
  const before = await readFile(result.workspace.evidenceManifestPath);
  expect(await result.controller.discoveryContextPage()).toMatchObject({ status: "unavailable", total: 0, notes: [] });
  expect(await readFile(result.workspace.evidenceManifestPath)).toEqual(before);
  expect(await readDiscoveryContextNotes(join(result.workspace.root, "missing"), result.workspace.jobId, "0".repeat(64)))
    .toMatchObject({ status: "unavailable", entries: [] });
});

test("a real discovery seal uses canonical evidence hash and its existing context notes load unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "discovery-context-real-seal-")), path = join(root, "source.md");
  const text = "信号垫片边缘应平整。\n本资料各装置每批抽取4件。\n";
  await writeFile(path, text);
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "real-seal", path);
  const controller = await DocumentDiscoveryController.create(workspace, "candidate"), atom = controller.evidence.atoms[0]!;
  await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
  const primary = await controller.dispatch("locate_document_span", { atom_id: atom.atom_id, quote: "信号垫片边缘应平整。" }) as any;
  const shared = await controller.dispatch("locate_document_span", { atom_id: atom.atom_id, quote: "本资料各装置每批抽取4件。" }) as any;
  expect(primary.ok).toBe(true); expect(shared.ok).toBe(true);
  const full = (await workspace.readSourceSpanRegistry()).spans.find(s => s.start === 0 && s.end === text.length)!;
  const p = primary.spans[0].span_id, c = shared.spans[0].span_id, selectors = initialDocumentSelectorPlan("real-seal");
  selectors.targets = [{ key: "pad", name: "信号垫片", group_key: "pads", group_name: "垫片", group_reason: "受检产品",
    scope_span_ids: [p], lot_basis_span_ids: [p], lot_basis_summary: "垫片边缘质量", reason: "产品直接验收要求",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: p, start_span_id: p, end_span_id: p, reason: "完整产品要求" }],
    semantic_basis: { subject: "信号垫片", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [p], acceptance_reason: "边缘平整", boundary_reason: "共享抽样另作上下文" } }];
  selectors.contexts = [{ key: "shared", role: "governing_rule", name: "装置抽样线索", span_ids: [c], reason: "可能约束多个装置" }];
  selectors.dispositions = [{ atom_span_id: full.span_id, disposition: "target", target_keys: [], reason: "含产品要求及共享抽样" }];
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  await workspace.setRuntime({ kind: "pi-sdk", session_id: "neutral-test", session_file: "neutral.jsonl" });
  const validation = await controller.dispatch("compile_document_selectors", {});
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
  expect(await controller.dispatch("seal_discovery_plan", { fingerprint: validation.fingerprint })).toMatchObject({ ok: true });
  const before = await readFile(workspace.manifestPath);
  const notes = await readDiscoveryContextNotes(workspace.root, "real-seal", sha256Text(text));
  expect(notes.status).toBe("available");
  expect(notes.entries[0]!.note).toMatchObject({ name: "装置抽样线索", role: "governing_rule" });
  expect(await readFile(workspace.manifestPath)).toEqual(before);
});
