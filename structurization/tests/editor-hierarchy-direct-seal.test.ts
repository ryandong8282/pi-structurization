import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  EditorHierarchyController,
  EditorHierarchyWorkspace,
  initialEditorHierarchyPlan,
} from "../src/editor-hierarchy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openTinyWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "hier-direct-seal-"));
  tempRoots.push(root);
  const markdownPath = join(root, "current.md");
  await writeFile(markdownPath, "第4章 电梯安装分项范围与数量说明", "utf8");
  const aggregate = {
    targets: [
      {
        target_id: "t1",
        inspection_lots: [
          { lot_id: "L1", name: "批一", items: [{ name: "项目一" }] },
        ],
      },
    ],
  };
  const batch = {
    targets: [{ target_id: "t1", name: "目标一", description: "", evidence_fragments: [] }],
  };
  const workspace = await EditorHierarchyWorkspace.openOrCreate(root, "job-direct", markdownPath, aggregate, batch);
  return workspace;
}

async function authorValidCandidate(workspace: EditorHierarchyWorkspace, submit = true) {
  const controller = await EditorHierarchyController.create(workspace, "candidate");
  const evidence = await workspace.readEvidence();
  const atom = evidence.document.atoms[0]!;
  const lot = evidence.lots[0]!;
  const fragment = [{ atom_id: atom.atom_id, text: "分项范围" }];
  const plan = {
    ...initialEditorHierarchyPlan(evidence),
    semantic_constraints: [
      {
        constraint_id: "root-scope",
        kind: "scope_assignment" as const,
        parent_node_id: "root",
        node_type: "子分部" as const,
        node_ids: ["group"],
        expected_count: null,
        exhaustive: false,
        evidence_fragments: fragment,
        interpretation: "当前文档构成一个子分部范围",
      },
      {
        constraint_id: "division-count",
        kind: "child_count" as const,
        parent_node_id: "group",
        node_type: "分项" as const,
        node_ids: ["division-a"],
        expected_count: 1,
        exhaustive: true,
        evidence_fragments: fragment,
        interpretation: "原文明确该范围只有一个分项",
      },
    ],
    atom_dispositions: [
      { atom_id: atom.atom_id, disposition: "hierarchy_authority" as const, constraint_ids: ["root-scope", "division-count"], reason: "包含范围与数量声明" },
    ],
    nodes: [
      { node_id: "group", parent_node_id: "root", node_type: "子分部" as const, name: "电梯安装", constraint_ids: ["root-scope"], evidence_fragments: fragment, reason: "文档领域" },
      { node_id: "division-a", parent_node_id: "group", node_type: "分项" as const, name: "分项甲", constraint_ids: ["division-count"], evidence_fragments: fragment, reason: "唯一分项" },
    ],
    lot_bindings: [
      { lot_key: lot.lot_key, parent_node_id: "division-a", constraint_ids: ["division-count"], evidence_fragments: fragment, reason: "该批属于唯一分项" },
    ],
  };
  await workspace.writePlan(JSON.stringify(plan, null, 2));
  await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
  await controller.dispatch("open_sealed_lot", { lot_key: lot.lot_key });
  const validation = await controller.dispatch("validate_hierarchy_plan", {});
  expect(validation.ok).toBe(true);
  if (submit) {
    const submitted = await controller.dispatch("submit_hierarchy_candidate", { fingerprint: String(validation.fingerprint ?? "") });
    expect(submitted.ok).toBe(true);
  }
  return controller;
}

describe("editor hierarchy direct seal (review step removed)", () => {
  it('a request typo reuses a verified checkpoint, but changed author data still requires validation', async () => {
    const workspace = await openTinyWorkspace();
    const controller = await authorValidCandidate(workspace, false);
    const before = await workspace.readState();
    expect(await controller.dispatch('submit_hierarchy_candidate', { fingerprint: 'wrong' })).toMatchObject({
      ok: false, current_checkpoint_verified: true, validation_required: false,
      next_tool: 'submit_hierarchy_candidate', next_tool_arguments: { fingerprint: before.last_candidate_fingerprint },
    });
    const { next_event_sequence: _eventsBefore, ...countsBefore } = before;
    const { next_event_sequence: _eventsAfter, ...countsAfter } = await workspace.readState();
    expect(countsAfter).toEqual(countsBefore);
    const plan = JSON.parse(await readFile(workspace.workingPlanPath, 'utf8'));
    plan.nodes[1].name = '更改后名称';
    await writeFile(workspace.workingPlanPath, JSON.stringify(plan));
    expect(await controller.dispatch('submit_hierarchy_candidate', { fingerprint: 'wrong' })).toMatchObject({
      ok: false, current_checkpoint_verified: false, validation_required: true, next_tool: 'validate_hierarchy_plan',
    });
  });
  it("hierarchy tool rejects keep the actual value and next tool", async () => {
    const workspace = await openTinyWorkspace();
    const controller = await EditorHierarchyController.create(workspace, "candidate");
    const unknownTool = await controller.dispatch("not_a_hierarchy_tool", {});
    expect(unknownTool).toMatchObject({
      ok: false,
      error: "unknown_hierarchy_tool",
      actual_tool: "not_a_hierarchy_tool",
    });
    expect(String(unknownTool.instruction)).toMatch(/get_hierarchy_contract/);
    const unknownAtom = await controller.dispatch("open_document_atom", { atom_id: "atom:missing" });
    expect(unknownAtom).toMatchObject({
      ok: false,
      error: "unknown_document_atom",
      actual_atom_id: "atom:missing",
    });
    expect(String(unknownAtom.instruction)).toMatch(/list_document_atoms/);
    const fingerprint = await controller.dispatch("submit_hierarchy_candidate", { fingerprint: "nope" });
    expect(fingerprint).toMatchObject({
      ok: false,
      actual_fingerprint: "nope",
      candidate_read_tool: "validate_hierarchy_plan",
    });
    expect(String(fingerprint.instruction)).toMatch(/nope/);
  });

  it("seals a validated candidate without the independent rebuild review", async () => {
    const workspace = await openTinyWorkspace();
    const controller = await authorValidCandidate(workspace);

    const sealed = await controller.sealCandidateWithoutReview();
    expect(sealed).toMatchObject({ ok: true, independent_review: "skipped", lot_binding_count: 1 });

    const state = await workspace.readState();
    expect(state.status).toBe("sealed");

    const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8"));
    expect(manifest.independent_review).toBe("skipped");
    expect(manifest.files.comparison_sha256).toBeNull();

    const receipt = JSON.parse(await readFile(workspace.sealReceiptPath, "utf8"));
    expect(receipt.independent_review).toBe("skipped");
    expect(receipt.comparison_sha256).toBeNull();

    const sealedPlan = JSON.parse(await readFile(workspace.sealedPlanPath, "utf8"));
    expect(sealedPlan.nodes).toHaveLength(2);
  });

  it("refuses to direct-seal when no candidate was submitted", async () => {
    const workspace = await openTinyWorkspace();
    const controller = await EditorHierarchyController.create(workspace, "candidate");
    const sealed = await controller.sealCandidateWithoutReview();
    expect(sealed.ok).toBe(false);
    expect(sealed.error).toBe("hierarchy_no_candidate");
  });

  it("refuses a candidate that fails deterministic validation", async () => {
    const workspace = await openTinyWorkspace();
    const controller = await authorValidCandidate(workspace);
    // 破坏候选：把唯一分项删掉，制造 missing_lot_bindings / invalid parent
    const candidate = JSON.parse(await readFile(workspace.candidatePlanPath, "utf8"));
    candidate.nodes = candidate.nodes.filter((node: { node_id: string }) => node.node_id !== "division-a");
    const { writeFile: write, chmod } = await import("node:fs/promises");
    await chmod(workspace.candidatePlanPath, 0o600);
    await write(workspace.candidatePlanPath, JSON.stringify(candidate, null, 2), "utf8");
    const sealed = await controller.sealCandidateWithoutReview();
    expect(sealed.ok).toBe(false);
    expect(sealed.error).toBe("hierarchy_candidate_invalid");
  });
});
