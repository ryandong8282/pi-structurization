import { mkdir, rm, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/pi-runtime.js", () => ({ runLiveEditorHierarchyCandidate: vi.fn(async () => { throw new Error("test provider unavailable"); }) }));

import { assembleEditorHierarchyFromLedger, matchSubdivision } from "../src/editor-hierarchy-assemble.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { runEditorHierarchy } from "../src/editor-hierarchy-runner.js";
import { runLiveEditorHierarchyCandidate } from "../src/pi-runtime.js";
import {
  validateEditorHierarchyPlan,
  type EditorHierarchyEvidence,
} from "../src/editor-hierarchy.js";

function evidenceFor(markdown: string, lots: EditorHierarchyEvidence["lots"]): EditorHierarchyEvidence {
  return {
    schema_version: "editor-hierarchy-evidence/v1",
    job_id: "assemble-job",
    business_result_sha256: "result-sha",
    document: {
      schema_version: "document-evidence/v1",
      source: { file_name: "source.md", sha256: "src", char_count: markdown.length, atom_chars: 6000 },
      atoms: [{
        atom_id: "atom-1",
        start_offset: 0,
        end_offset: markdown.length,
        start_line: 1,
        end_line: markdown.split("\n").length,
        text: markdown,
        text_sha256: "atom",
      }],
      evidence_fingerprint: "doc-fp",
    },
    lots,
    evidence_fingerprint: "ev-fp",
  };
}

describe("editor hierarchy ledger assembly", () => {
  it("falls back to discovery target names when there is no appendix record table", () => {
    const markdown = [
      "# 4 地基工程 [PDF p.1]",
      "## 4.2 素土和灰土地基",
      "4.2.1 地基承载力应满足设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "no-table.md");
    expect(ledger.record_tables).toEqual([]);
    const evidence = evidenceFor(markdown, [
      {
        lot_key: "t1::L1",
        target_id: "t1",
        target_name: "素土和灰土地基",
        target_description: "",
        target_evidence_fragments: [],
        lot_id: "L1",
        lot_name: "批一",
        item_names: ["地基承载力"],
      },
    ]);
    const assembled = assembleEditorHierarchyFromLedger({ evidence, ledger, specTree: [] });
    expect(assembled.plan.nodes.some((node) => node.node_type === "分项" && node.name === "素土和灰土地基")).toBe(true);
    expect(assembled.plan.nodes.some((node) => node.node_type === "子分部" && node.name === "未映射")).toBe(true);
    const openedAtoms = new Set(evidence.document.atoms.map((atom) => atom.atom_id));
    const openedLots = new Set(evidence.lots.map((lot) => lot.lot_key));
    expect(validateEditorHierarchyPlan(assembled.plan, evidence, openedAtoms, openedLots).issues.map(issue => issue.code)).toEqual(['inspection_unit_coverage']);
  });

  it("builds 分项 from appendix record-table captions and binds lots by title", () => {
    const markdown = [
      "# 附录 H 检验批质量验收记录 [PDF p.40]",
      "表H.0.10 铝合金焊接检验批质量验收记录",
      "<table><tr><td>工程名称</td></tr></table>",
      "4.2.1 焊接质量应符合设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "with-table.md");
    expect(ledger.record_tables.length).toBeGreaterThan(0);
    const evidence = evidenceFor(markdown, [
      {
        lot_key: "weld::L1",
        target_id: "weld",
        target_name: "铝合金焊接",
        target_description: "",
        target_evidence_fragments: [],
        lot_id: "L1",
        lot_name: "焊接批",
        item_names: ["焊缝"],
      },
    ]);
    const assembled = assembleEditorHierarchyFromLedger({
      evidence,
      ledger,
      specTree: [{
        name: "主体结构",
        type_name: "分部",
        children: [{
          name: "钢结构",
          type_name: "子分部",
          children: [{ name: "钢结构焊接", type_name: "分项", children: [] }],
        }],
      }],
    });
    expect(assembled.plan.nodes.some((node) => node.node_type === "分项")).toBe(true);
    const openedAtoms = new Set(evidence.document.atoms.map((atom) => atom.atom_id));
    const openedLots = new Set(evidence.lots.map((lot) => lot.lot_key));
    expect(validateEditorHierarchyPlan(assembled.plan, evidence, openedAtoms, openedLots).issues.map(issue => issue.code)).toEqual(['inspection_unit_coverage']);
    expect(assembled.plan.lot_bindings).toHaveLength(1);
    expect(assembled.plan.lot_bindings[0]!.display_name).toBe("焊接批");
  });

  it("keeps unmatched lots on a fallback 分项 and lists them for confirm", () => {
    const markdown = [
      "表H.0.1 钢结构焊接检验批质量验收记录",
      "<table><tr><td>工程名称</td></tr></table>",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "unmatched.md");
    const evidence = evidenceFor(markdown, [
      {
        lot_key: "other::L1",
        target_id: "other",
        target_name: "门窗安装",
        target_description: "",
        target_evidence_fragments: [],
        lot_id: "L1",
        lot_name: "门窗批",
        item_names: ["框安装"],
      },
    ]);
    const assembled = assembleEditorHierarchyFromLedger({ evidence, ledger, specTree: [] });
    expect(assembled.uncertain_lot_keys).toEqual(["other::L1"]);
    expect(assembled.plan.lot_bindings).toHaveLength(1);
  });

  it("exact title binds are certain even when the 分项 sits under 未映射", () => {
    const markdown = [
      "# 4 原材料 [PDF p.1]",
      "## 4.2 铝合金材料",
      "4.2.1 材料应符合设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "exact-bind.md");
    const evidence = evidenceFor(markdown, [
      {
        lot_key: "mat::L1",
        target_id: "mat",
        target_name: "铝合金材料",
        target_description: "",
        target_evidence_fragments: [],
        lot_id: "L1",
        lot_name: "材料批",
        item_names: ["4.2.1 品种"],
      },
    ]);
    const assembled = assembleEditorHierarchyFromLedger({
      evidence,
      ledger,
      specTree: [{
        name: "主体结构",
        type_name: "分部",
        children: [{
          name: "钢结构",
          type_name: "子分部",
          children: [{ name: "钢结构焊接", type_name: "分项", children: [] }],
        }],
      }],
    });
    expect(assembled.unmapped_division_names).toContain("铝合金材料");
    expect(assembled.uncertain_lot_keys).toEqual([]);
    expect(assembled.plan.lot_bindings).toHaveLength(1);
  });

  it("matches 50300 subdivisions by normalized names without a per-book map", () => {
    const subdivisions = [
      { name: "钢结构", items: ["钢结构焊接", "紧固件连接"] },
      { name: "混凝土结构", items: ["钢筋", "混凝土"] },
    ];
    expect(matchSubdivision("钢结构焊接", subdivisions)).toBe("钢结构");
    expect(matchSubdivision("未知面板", subdivisions)).toBeUndefined();
  });

  it("keeps the draft and refuses publication if semantic organization could not be confirmed", async () => {
    const root = join(tmpdir(), `hier-assemble-run-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const markdown = [
      "# 4 地基工程 [PDF p.1]",
      "## 4.2 素土、灰土地基",
      "4.2.1 地基承载力应满足设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const markdownPath = join(root, "source.md");
    const aggregatePath = join(root, "result.json");
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(aggregatePath, JSON.stringify({
      targets: [{
        target_id: "t1",
        inspection_lots: [{ lot_id: "L1", name: "批一", items: [{ name: "地基承载力" }] }],
      }],
    }), "utf8");
    try {
      const run = () => runEditorHierarchy({
        artifactRoot: root,
        jobId: "assemble-run",
        markdownPath,
        aggregatePath,
        batch: {
          targets: [{ target_id: "t1", name: "素土、灰土地基", description: "", evidence_fragments: [] }],
        },
        maxAttempts: 1,
      });
      await expect(run()).rejects.toThrow(/semantic confirmation failed.*test provider unavailable/);
      const hierarchy = join(root, 'jobs', 'assemble-run', 'hierarchy');
      await expect(access(join(hierarchy, 'manifest.json'))).rejects.toThrow();
      const draftPath = join(hierarchy, 'working.editor-hierarchy-plan.json');
      const draft = JSON.parse(await readFile(draftPath, 'utf8'));
      expect(draft.inspection_units).toEqual([]);
      draft.lot_bindings[0].reason = '已保存的语义判断';
      await writeFile(draftPath, JSON.stringify(draft), 'utf8');
      await expect(run()).rejects.toThrow(/semantic confirmation failed/);
      expect(JSON.parse(await readFile(draftPath, 'utf8')).lot_bindings[0].reason).toBe('已保存的语义判断');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails immediately on provider configuration errors and retains the exact cause", async () => {
    const root = join(tmpdir(), `hier-prov-err-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const markdown = "# 4 地基\n## 4.2 素土\n4.2.1 检验\n";
    const markdownPath = join(root, "source.md");
    const aggregatePath = join(root, "result.json");
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(aggregatePath, JSON.stringify({
      targets: [{ target_id: "t1", inspection_lots: [{ lot_id: "L1", name: "批一", items: [{ name: "项" }] }] }],
    }), "utf8");

    vi.mocked(runLiveEditorHierarchyCandidate).mockRejectedValueOnce(new Error("HTTP 401 invalid api key"));
    try {
      const run = () => runEditorHierarchy({
        artifactRoot: root,
        jobId: "prov-err-job",
        markdownPath,
        aggregatePath,
        batch: { targets: [{ target_id: "t1", name: "素土", description: "", evidence_fragments: [] }] },
        maxAttempts: 3,
      });
      await expect(run()).rejects.toThrow(/provider configuration error.*HTTP 401 invalid api key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains specific failure message when candidate attempts are exhausted", async () => {
    const root = join(tmpdir(), `hier-cand-exhaust-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const markdown = "# 4 地基\n## 4.2 素土\n4.2.1 检验\n";
    const markdownPath = join(root, "source.md");
    const aggregatePath = join(root, "result.json");
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(aggregatePath, JSON.stringify({
      targets: [{ target_id: "t1", inspection_lots: [{ lot_id: "L1", name: "批一", items: [{ name: "项" }] }] }],
    }), "utf8");

    vi.mocked(runLiveEditorHierarchyCandidate)
      .mockResolvedValueOnce({ session_id: "s1", session_file: "f1", candidate_ready: false, model: "m", error: "missing inspection units in patch" })
      .mockResolvedValueOnce({ session_id: "s2", session_file: "f2", candidate_ready: false, model: "m", error: "missing inspection units in patch" });

    try {
      const run = () => runEditorHierarchy({
        artifactRoot: root,
        jobId: "cand-exhaust-job",
        markdownPath,
        aggregatePath,
        batch: { targets: [{ target_id: "t1", name: "素土", description: "", evidence_fragments: [] }] },
        maxAttempts: 2,
      });
      await expect(run()).rejects.toThrow(/semantic confirmation failed after 2 attempts.*Cause: missing inspection units in patch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
