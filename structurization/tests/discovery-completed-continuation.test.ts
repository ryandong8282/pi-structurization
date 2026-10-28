import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { documentSelectorFingerprint, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { retainDiscoveryDraft } from "../src/discovery-pending-draft.js";
import { DISCOVERY_CONTINUATION_PROMPT, discoveryPromptSnapshot, runLengthContinuationLoop } from "../src/pi-runtime.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discovery-completion-")); roots.push(root);
  const markdown = join(root, "input.md");
  await writeFile(markdown, "设备外壳应完好。\n");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "neutral", markdown);
  const controller = await DocumentDiscoveryController.create(workspace);
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!;
  const selectors = initialDocumentSelectorPlan("neutral");
  selectors.targets = [{
    key: "device", name: "设备", group_key: "devices", group_name: "设备", group_reason: "设备验收",
    lot_basis_summary: "设备外壳质量", scope_span_ids: [span.span_id], lot_basis_span_ids: [span.span_id], reason: "实体质量要求",
    source_blocks: [{ kind: "explicit_range", anchor_span_id: span.span_id, start_span_id: span.span_id, end_span_id: span.span_id, reason: "完整原文" }],
    semantic_basis: { subject: "设备", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span.span_id], acceptance_reason: "外壳完好", boundary_reason: "单一设备" },
  }];
  selectors.dispositions = [{ atom_span_id: span.span_id, disposition: "target", target_keys: ["device"], reason: "实体要求" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  return { workspace, controller, selectors };
}

test("continues normal checkpoint stops through actual submission without spending final-validation budget on each stop", async () => {
  const { workspace, controller, selectors } = await fixture();
  let rounds = 0;
  const prompts: string[] = [];
  const result = await runLengthContinuationLoop({
    initialPrompt: "调查全文", continuationPrompt: DISCOVERY_CONTINUATION_PROMPT,
    completedContinuationPrompt: DISCOVERY_CONTINUATION_PROMPT,
    snapshot: () => discoveryPromptSnapshot(workspace, "candidate"),
    shouldContinueAfterCompleted: async () => (await workspace.readState()).status !== "sealed",
    lastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "小检查点已保存" }] }),
    promptRound: async prompt => {
      prompts.push(prompt); rounds++;
      if (rounds === 1) await controller.dispatch("open_document_atom", { atom_id: controller.evidence.atoms[0]!.atom_id });
      else if (rounds < 6) {
        selectors.targets[0]!.reason = `已核对的来源说明 ${rounds}`;
        await workspace.writeWorkingSelectors(JSON.stringify(selectors));
      } else {
        const validated = await controller.dispatch("compile_document_selectors", {});
        expect(validated.ok).toBe(true);
        expect(await controller.dispatch("seal_discovery_plan", { fingerprint: validated.fingerprint })).toMatchObject({ ok: true });
      }
      return { kind: "completed" };
    },
  });
  expect(result).toMatchObject({ error: "", completion_continuations: 5 });
  expect(rounds).toBe(6);
  expect(prompts.slice(1)).toEqual(Array(5).fill(DISCOVERY_CONTINUATION_PROMPT));
  expect(await workspace.readState()).toMatchObject({ status: "sealed", validation_attempts: 1, reviewer_validation_attempts: 0 });
});

test("transcript growth and repeated source reads cannot disguise a stalled incomplete discovery", async () => {
  const { workspace, controller } = await fixture();
  await controller.dispatch("open_document_atom", { atom_id: controller.evidence.atoms[0]!.atom_id });
  const original = await readFile(workspace.workingSelectorPath, "utf8");
  let rounds = 0;
  const result = await runLengthContinuationLoop({
    initialPrompt: "继续", continuationPrompt: DISCOVERY_CONTINUATION_PROMPT,
    snapshot: () => discoveryPromptSnapshot(workspace, "candidate"),
    shouldContinueAfterCompleted: async () => true,
    lastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [] }),
    promptRound: async () => {
      rounds++;
      await controller.dispatch("open_document_atom", { atom_id: controller.evidence.atoms[0]!.atom_id });
      await workspace.appendEvent("checkpoint_summary", { round: rounds });
      return { kind: "completed" };
    },
  });
  expect(result.error).toContain("incomplete_repair_without_durable_progress: 3");
  expect(rounds).toBe(3);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(original);
  expect((await workspace.readState()).validation_attempts).toBe(0);
});

test("counts retained transaction content, excluding new nonce and handle for identical unaccepted work", async () => {
  const { workspace, controller, selectors } = await fixture();
  const baseline = await discoveryPromptSnapshot(workspace, "candidate");
  const pendingSelectors = structuredClone(selectors);
  pendingSelectors.targets[0]!.reason = "待提交的来源说明";
  const retain = async () => retainDiscoveryDraft(workspace.root, {
    job_id: workspace.jobId, evidence_fingerprint: controller.evidence.evidence_fingerprint,
    phase: "candidate", phase_epoch: "initial", base_selector_fingerprint: documentSelectorFingerprint(selectors),
    operations: [{ op: "replace", path: "/targets/0/reason", value: pendingSelectors.targets[0]!.reason }],
    selectors: pendingSelectors, registry: await workspace.readSourceSpanRegistry(),
  });
  const firstId = await retain();
  const first = await discoveryPromptSnapshot(workspace, "candidate");
  expect(first.checkpoint).not.toBe(baseline.checkpoint);
  expect(await retain()).not.toBe(firstId);
  expect((await discoveryPromptSnapshot(workspace, "candidate")).checkpoint).toBe(first.checkpoint);
  expect((await discoveryPromptSnapshot(workspace, "review")).checkpoint).toBe(baseline.checkpoint);
});
