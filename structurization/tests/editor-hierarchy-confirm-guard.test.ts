import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  EditorHierarchyController,
  EditorHierarchyWorkspace,
  confirmModeHierarchyIssues,
  initialEditorHierarchyPlan,
  type EditorHierarchyPlan,
  type HierarchyConfirmContext,
} from "../src/editor-hierarchy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function planWithTwoLots(atomId: string): EditorHierarchyPlan {
  const fragment = [{ atom_id: atomId, text: "分项范围" }];
  return {
    ...initialEditorHierarchyPlan({
      schema_version: "editor-hierarchy-evidence/v1",
      job_id: "confirm-job",
      business_result_sha256: "x",
      document: {
        schema_version: "document-evidence/v1",
        source: { file_name: "x.md", sha256: "s", char_count: 10, atom_chars: 6000 },
        atoms: [],
        evidence_fingerprint: "fp",
      },
      lots: [],
      evidence_fingerprint: "ev",
    }),
    semantic_constraints: [
      {
        constraint_id: "root-scope",
        kind: "scope_assignment",
        parent_node_id: "root",
        node_type: "子分部",
        node_ids: ["group"],
        expected_count: null,
        exhaustive: false,
        evidence_fragments: fragment,
        interpretation: "一个子分部",
      },
      {
        constraint_id: "division-count",
        kind: "child_count",
        parent_node_id: "group",
        node_type: "分项",
        node_ids: ["division-a", "division-b"],
        expected_count: 2,
        exhaustive: true,
        evidence_fragments: fragment,
        interpretation: "两个分项",
      },
    ],
    atom_dispositions: [
      { atom_id: atomId, disposition: "hierarchy_authority", constraint_ids: ["root-scope", "division-count"], reason: "范围" },
    ],
    nodes: [
      { node_id: "group", parent_node_id: "root", node_type: "子分部", name: "主体", constraint_ids: ["root-scope"], evidence_fragments: fragment, reason: "子分部" },
      { node_id: "division-a", parent_node_id: "group", node_type: "分项", name: "分项甲", constraint_ids: ["division-count"], evidence_fragments: fragment, reason: "甲" },
      { node_id: "division-b", parent_node_id: "group", node_type: "分项", name: "分项乙", constraint_ids: ["division-count"], evidence_fragments: fragment, reason: "乙" },
    ],
    lot_bindings: [
      {
        lot_key: "t1::L1",
        parent_node_id: "division-a",
        constraint_ids: ["division-count"],
        evidence_fragments: fragment,
        reason: "确定绑定",
      },
      {
        lot_key: "t2::L2",
        parent_node_id: "division-a",
        constraint_ids: ["division-count"],
        evidence_fragments: fragment,
        reason: "待确认",
      },
    ],
  };
}

describe("hierarchy confirm-mode rebuild guard", () => {
  it("allows explicit product organization but cannot erase the new contract to restore implicit batches", () => {
    const baseline = { ...planWithTwoLots("atom:1"), inspection_units: [] };
    const after = structuredClone(baseline) as EditorHierarchyPlan;
    const confirm: HierarchyConfirmContext = { uncertain_lot_keys: [], unmapped_division_names: [], ledger_summary: { record_tables: [], chapters: [], windows: [], anomalies: [] } };
    after.inspection_units = [{ unit_id: "u", name: "共同单元", lot_keys: ["t1::L1", "t2::L2"], source_title_fragments: [], evidence_fragments: [{ atom_id: "atom:1", text: "分项范围" }], reason: "共同组织依据" }];
    expect(confirmModeHierarchyIssues(baseline, after, confirm)).toEqual([]);
    delete after.inspection_units;
    expect(confirmModeHierarchyIssues(baseline, after, confirm)).toContainEqual(expect.objectContaining({
      code: "inspection_units_required", details: expect.objectContaining({ save_tool: "edit_hierarchy_records" }),
    }));
  });
  it("rejects rewriting certain bindings or assembled nodes", () => {
    const baseline = planWithTwoLots("atom:1");
    const confirm: HierarchyConfirmContext = {
      uncertain_lot_keys: ["t2::L2"],
      unmapped_division_names: [],
      ledger_summary: { record_tables: [], chapters: [], windows: [], anomalies: [] },
    };
    // 检验批绑到哪个分项同样只是名字匹配的产物，confirm 阶段可以改；
    // 但不能把检验批弄丢——「恰好绑定一次」由基础校验器兜底，这里只拦丢失。
    const movedCertain = structuredClone(baseline);
    movedCertain.lot_bindings[0]!.parent_node_id = "division-b";
    expect(confirmModeHierarchyIssues(baseline, movedCertain, confirm)).toEqual([]);

    const droppedBinding = structuredClone(baseline);
    droppedBinding.lot_bindings.splice(0, 1);
    expect(confirmModeHierarchyIssues(baseline, droppedBinding, confirm).map((issue) => issue.code))
      .toContain("confirm_lot_binding_dropped");

    // 命名是 confirm 阶段的本职：装配出来的分项名是从附录记录表题注回看切的整句话，
    // 必须允许改成文档真正使用的名字（正文章标题）。
    const renamedNode = structuredClone(baseline);
    renamedNode.nodes[1]!.name = "铝合金焊接工程";
    expect(confirmModeHierarchyIssues(baseline, renamedNode, confirm)).toEqual([]);

    // 分项挂到别的子分部也是语义判断，放行；但节点类型属于结构，仍然锁死。
    const reparentedDivision = structuredClone(baseline);
    reparentedDivision.nodes.push({
      ...structuredClone(baseline.nodes[0]!),
      node_id: "group-2",
      name: "另一子分部",
    });
    reparentedDivision.nodes[1]!.parent_node_id = "group-2";
    expect(confirmModeHierarchyIssues(baseline, reparentedDivision, confirm)).toEqual([]);

    const retypedNode = structuredClone(baseline);
    retypedNode.nodes[1]!.node_type = "子分部";
    expect(confirmModeHierarchyIssues(baseline, retypedNode, confirm).map((issue) => issue.code))
      .toContain("confirm_node_type_changed");

    const reparentedSubdivision = structuredClone(baseline);
    reparentedSubdivision.nodes[0]!.parent_node_id = "division-a";
    expect(confirmModeHierarchyIssues(baseline, reparentedSubdivision, confirm).map((issue) => issue.code))
      .toContain("confirm_node_reparented");

    // 合并分项（金标把普通紧固件+高强度螺栓合成一个）必须允许删节点，
    // 否则装配出几个分项就永远是几个。
    const mergedDivisions = structuredClone(baseline);
    mergedDivisions.nodes.splice(2, 1);
    for (const binding of mergedDivisions.lot_bindings) {
      if (binding.parent_node_id === "division-b") binding.parent_node_id = "division-a";
    }
    expect(confirmModeHierarchyIssues(baseline, mergedDivisions, confirm)).toEqual([]);

    const reboundUncertain = structuredClone(baseline);
    reboundUncertain.lot_bindings[1]!.parent_node_id = "division-b";
    expect(confirmModeHierarchyIssues(baseline, reboundUncertain, confirm)).toEqual([]);
  });

  it("patch tool refuses rebuilds in confirm mode but allows uncertain rebinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "hier-confirm-guard-"));
    tempRoots.push(root);
    const markdownPath = join(root, "current.md");
    await writeFile(markdownPath, [
      "第4章 电梯安装分项范围与数量说明",
      "表H.0.1 分项甲检验批质量验收记录",
      "表H.0.2 分项乙检验批质量验收记录",
    ].join("\n"), "utf8");
    const aggregate = {
      targets: [
        { target_id: "t1", inspection_lots: [{ lot_id: "L1", name: "批一", items: [{ name: "项目一" }] }] },
        { target_id: "t2", inspection_lots: [{ lot_id: "L2", name: "批二", items: [{ name: "项目二" }] }] },
      ],
    };
    const batch = {
      targets: [
        { target_id: "t1", name: "目标一", description: "", evidence_fragments: [] },
        { target_id: "t2", name: "目标二", description: "", evidence_fragments: [] },
      ],
    };
    const workspace = await EditorHierarchyWorkspace.openOrCreate(root, "job-confirm", markdownPath, aggregate, batch);
    const evidence = await workspace.readEvidence();
    const atomId = evidence.document.atoms[0]!.atom_id;
    const plan = planWithTwoLots(atomId);
    plan.job_id = evidence.job_id;
    plan.evidence_fingerprint = evidence.evidence_fingerprint;
    plan.business_result_sha256 = evidence.business_result_sha256;
    plan.atom_dispositions = evidence.document.atoms.map((atom) => ({
      atom_id: atom.atom_id,
      disposition: "hierarchy_authority" as const,
      constraint_ids: ["root-scope", "division-count"],
      reason: "范围",
    }));
    await workspace.writePlan(JSON.stringify(plan, null, 2));

    const confirm: HierarchyConfirmContext = {
      uncertain_lot_keys: ["t2::L2"],
      unmapped_division_names: [],
      ledger_summary: { record_tables: [], chapters: [], windows: [], anomalies: [] },
    };
    const controller = await EditorHierarchyController.create(workspace, "candidate", confirm);

    // 重绑任意检验批都放行——绑定本来就只是名字匹配的产物。
    const reboundCertain = await controller.dispatch("patch_hierarchy_plan", {
      operations: [{ op: "replace", path: "/lot_bindings/0/parent_node_id", value: "division-b" }],
    });
    expect(reboundCertain).toMatchObject({ ok: true });

    const allowed = await controller.dispatch("patch_hierarchy_plan", {
      operations: [{ op: "replace", path: "/lot_bindings/1/parent_node_id", value: "division-b" }],
    });
    expect(allowed).toMatchObject({ ok: true });

    // 但把检验批整条删掉不行：分项可以合并，检验批不能丢。
    const dropped = await controller.dispatch("patch_hierarchy_plan", {
      operations: [{ op: "remove", path: "/lot_bindings/0" }],
    });
    expect(dropped).toMatchObject({ ok: false, error: "confirm_mode_rebuild_forbidden" });

    const keyed = await controller.dispatch("edit_hierarchy_records", {
      edits: [{ collection: "lot_bindings", key: "t1::L1", op: "update", value: { parent_node_id: "division-a" } }],
    });
    expect(keyed).toMatchObject({ ok: true });
    expect(await controller.dispatch("edit_hierarchy_records", {
      edits: [{ collection: "lot_bindings", key: "t1::L1", op: "remove" }],
    })).toMatchObject({ ok: false, error: "confirm_mode_rebuild_forbidden" });
    expect(await controller.dispatch("edit_hierarchy_records", {
      edits: [{ collection: "nodes", key: "missing", op: "update", value: { name: "不可保存" } }],
    })).toMatchObject({ ok: false, error: "hierarchy_record_edit_rejected", candidate_read_tool: "read_hierarchy_plan" });
    expect(await controller.dispatch("read_hierarchy_plan", {})).toMatchObject({
      preferred_edit_tool: "edit_hierarchy_records",
      record_catalog: { lot_bindings: expect.arrayContaining([expect.objectContaining({ key: "t1::L1", parent_node_id: "division-a" })]) },
    });
    expect(await controller.dispatch("validate_hierarchy_plan", {})).toMatchObject({ ok: false,
      repair_targets: expect.arrayContaining([expect.objectContaining({ key: "root-scope", source_read_tool: "open_document_atom" })]),
    });

    // 判断分项边界得看得见每个检验批，不能只放行 uncertain 的那些。
    for (const lotKey of ["t1::L1", "t2::L2"]) {
      expect(await controller.dispatch("open_sealed_lot", { lot_key: lotKey }))
        .toMatchObject({ ok: true });
    }
  });
});
