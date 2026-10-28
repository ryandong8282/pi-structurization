import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type EvidenceManifest,
  type FieldSourceBinding,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import {
  canonicalizeSourceGlyphsForComparison,
  normalizeMineruDisplayText,
  normalizeMineruInlineMath,
  collapseHanTypesettingSpacing,
} from "../src/text-normalization.js";

describe("normalizeMineruInlineMath", () => {
  it("renders the MinerU math used by GB 50202 tables as Unicode", () => {
    expect(normalizeMineruInlineMath("L(或B) $\\leqslant 30$"))
      .toBe("L(或B)≤30");
    expect(normalizeMineruInlineMath("mm $\\pm 5$"))
      .toBe("mm±5");
    expect(normalizeMineruInlineMath("$\\leqslant 3^{\\circ}$"))
      .toBe("≤3°");
    expect(normalizeMineruInlineMath(
      "$\\leqslant 1.5\\%L_1 \\sim 2.0\\%L_1$ 且 $\\leqslant 500mm$",
    )).toBe("≤1.5%L₁～2.0%L₁ 且 ≤500mm");
    expect(normalizeMineruInlineMath("$(6\\sim 12)d_{50}$"))
      .toBe("(6～12)d₅₀");
    expect(normalizeMineruInlineMath(
      "$d \\leqslant 120\\text{mm}$ 1.0mm $d >120\\text{mm}$ 1.5mm",
    )).toBe("d≤120mm 1.0mm d>120mm 1.5mm");
    expect(normalizeMineruInlineMath("$d \\leqslant 120\\text { mm }$"))
      .toBe("d≤120 mm");
  });

  it("keeps unsupported TeX intact instead of silently corrupting it", () => {
    expect(normalizeMineruInlineMath("$\\frac{1}{2}$"))
      .toBe("$\\frac{1}{2}$");
    expect(normalizeMineruInlineMath("$\\text{允许\\alpha}$"))
      .toBe("$\\text{允许\\alpha}$");
  });

  it("renders safe delimiter-free legacy math only for the final UI", () => {
    expect(normalizeMineruDisplayText(
      "圆度 1.0mm 1.5mm d \\leqslant 120\\text{mm} d >120\\text{mm}",
    )).toBe("圆度 1.0mm 1.5mm d≤120mm d>120mm");
    expect(normalizeMineruDisplayText("\\frac{1}{2} \\leqslant 1"))
      .toBe("\\frac{1}{2} \\leqslant 1");
  });

  it("renders the bounded TeX residuals found in the GB50576 final UI", () => {
    expect(normalizeMineruInlineMath("$\\mu m$"))
      .toBe("$\\mu m$");
    expect(normalizeMineruDisplayText(
      "7.3.2 边缘加工允许偏差应符合表 7.3.2 的规定。 加工面表面粗糙度 $\\underline{\\text{12.5}}$",
    )).toBe(
      "7.3.2 边缘加工允许偏差应符合表 7.3.2 的规定。 加工面表面粗糙度 12.5",
    );
    expect(normalizeMineruDisplayText(
      "孔壁表面粗糙度 R_{a} 不应大于 $12.5\\mu m$",
    )).toBe("孔壁表面粗糙度 Rₐ 不应大于 12.5μm");
    expect(normalizeMineruDisplayText(
      "$\\pm \\sum (\\Delta_{\\mathrm{h}} + \\Delta_{\\mathrm{z}} + \\Delta_{\\mathrm{w}})$\nH/1000",
    )).toBe("±∑(Δₕ + Δ_z + Δ_w)\nH/1000");
    expect(normalizeMineruDisplayText("$\\mu m$"))
      .toBe("μm");
    expect(normalizeMineruDisplayText(
      "表 14.3.1 电泳涂漆复合膜厚度( $\\mu$ m)",
    )).toBe("表 14.3.1 电泳涂漆复合膜厚度( μm)");
  });

  it("keeps unknown and structurally complex TeX expressions byte-for-byte intact", () => {
    expect(normalizeMineruDisplayText("$\\frac{\\Delta_{\\mathrm{h}}}{2}$"))
      .toBe("$\\frac{\\Delta_{\\mathrm{h}}}{2}$");
    expect(normalizeMineruDisplayText("$\\underline{\\frac{1}{2}}$"))
      .toBe("$\\underline{\\frac{1}{2}}$");
    expect(normalizeMineruDisplayText("\\frac{1}{2} + \\mu m"))
      .toBe("\\frac{1}{2} + \\mu m");
  });

  it("renders sampling areas and volumes, including MinerU's spaced math digits", () => {
    const raw = "每 $3 0 0\\mathrm {m}^{2}$ 不应少于1点，超过3000m²部分每 $5 0 0\\mathrm {m}^{2}$ 不应少于1点。每单位工程不应少于3点。";
    const readable = "每 300m² 不应少于1点，超过3000m²部分每 500m² 不应少于1点。每单位工程不应少于3点。";
    expect(normalizeMineruDisplayText(raw)).toBe(readable);
    expect(normalizeMineruDisplayText(readable)).toBe(readable);
    expect(normalizeMineruDisplayText("每 $1 0 0 \\mathrm{ m } ^ { 3 }$ 取1处，$10^{-2}\\mathrm{m}$"))
      .toBe("每 100 m³ 取1处，10⁻²m");
    expect(normalizeMineruDisplayText("抽查第 1 2 组，每300\\mathrm{m}^{2}取1点"))
      .toBe("抽查第 1 2 组，每300m²取1点");
    expect(normalizeMineruInlineMath(raw)).toBe(raw);
    expect(normalizeMineruDisplayText("每 $\\frac{1}{2}\\mathrm{m}^{2}$ 取1处"))
      .toBe("每 $\\frac{1}{2}\\mathrm{m}^{2}$ 取1处");
  });

  it("decodes numeric HTML entities in display text without changing source provenance", () => {
    expect(normalizeMineruInlineMath("-30&#x27;且不大于0.3mm"))
      .toBe("-30'且不大于0.3mm");
    expect(normalizeMineruInlineMath("A&#8242; / B&#x2032;"))
      .toBe("A′ / B′");
  });

  it("canonicalizes only entity and prime presentation for exact glyph comparison", () => {
    expect(canonicalizeSourceGlyphsForComparison("—30&amp;#x27;且不大于0.3mm"))
      .toBe(canonicalizeSourceGlyphsForComparison("—30′且不大于0.3mm"));
    expect(canonicalizeSourceGlyphsForComparison("-30'且不大于0.3mm"))
      .not.toBe(canonicalizeSourceGlyphsForComparison("—30′且不大于0.3mm"));
    expect(canonicalizeSourceGlyphsForComparison("—30′且不大于0.3mm"))
      .not.toBe(canonicalizeSourceGlyphsForComparison("—20′且不大于0.3mm"));
    expect(canonicalizeSourceGlyphsForComparison("≤0.3mm"))
      .not.toBe(canonicalizeSourceGlyphsForComparison("±0.3mm"));
  });
});

function binding(value: string): FieldSourceBinding {
  return {
    status: "bound",
    composition: "verbatim",
    evidence_ids: ["evidence:row"],
    source_fragments: [{ evidence_id: "evidence:row", text: value }],
    value_sha256: sha256Text(value),
    reason: "test fixture",
  };
}

describe("materialize", () => {
  it("normalizes display output while preserving raw plan evidence provenance", () => {
    const rawName = "L(或B) $\\leqslant 30$";
    const rawRequirement = "mm $\\pm 5$";
    const finalUiOnlyNote = "$\\mu m$";
    const plan: SemanticSourcePlan = {
      schema_version: PLAN_SCHEMA_VERSION,
      job_id: "job",
      target_id: "5.3",
      evidence_fingerprint: "evidence-fingerprint",
      table_assembly: {
        schema_version: "table-assembly-plan/v1",
        evidence_fingerprint: "evidence-fingerprint",
        logical_tables: [],
        fragment_dispositions: [],
      },
      inspection_lots: [{
        lot_id: "lot:5.3.4",
        name: "表 5.3.4 质量检验标准",
        evidence_ids: ["evidence:table"],
        item_ids: ["item:row:1"],
      }],
      acceptance_items: [{
        item_id: "item:row:1",
        lot_id: "lot:5.3.4",
        name: rawName,
        category: "一般项目",
        requirement: rawRequirement,
        method: "用钢尺量",
        quantity: "",
        note: finalUiOnlyNote,
        evidence_ids: ["evidence:row"],
        reference_evidence_ids: [],
        inspection_data_type: "measurement",
        inspection_data_type_reason: "钢尺产生长度测量值；单点与允许偏差比较；最终按测点偏差评价。",
        inspection_data_type_evidence_ids: ["evidence:row"],
        field_bindings: {
          name: binding(rawName),
          requirement: binding(rawRequirement),
          method: binding("用钢尺量"),
          quantity: binding(""),
          note: binding(finalUiOnlyNote),
        },
        sampling: {
          status: "fallback",
          min_sampling: "按 GB 50300 执行",
          script: "按 GB 50300 执行",
          reason: "兜底规则",
          confidence: 0.55,
          evidence_ids: [],
        },
      }],
      reference_resolutions: [],
      evidence_dispositions: [],
      semantic_evidence: [{
        semantic_id: "semantic:item:row:1",
        role: "acceptance_item",
        evidence_id: "evidence:row",
        exact_fragment: rawName,
        parent_semantic_id: "",
        materialized_item_id: "item:row:1",
        reason: "表 5.3.4 的验收项目",
      }],
    };
    const manifest: EvidenceManifest = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      job_id: "job",
      target_id: "5.3",
      source: {
        adapter: "markdown-target-scope/v3",
        file_name: "source.md",
        sha256: "source-sha256",
      },
      scope: {
        schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
        mode: "target_section",
        target_id: "5.3",
        source_line_count: 1,
        selected_start_line: 1,
        selected_end_exclusive_line: 2,
        selected_heading: "5.3",
        selection_reason: "test fixture",
        candidates: [],
      },
      evidence: [{
        evidence_id: "evidence:row",
        kind: "paragraph",
        role: "supporting_clause",
        locator: "char:1200-1300",
        text: `# 5.3.4 复合地基质量检验标准\n${rawName} ${rawRequirement} ${finalUiOnlyNote} 用钢尺量`,
        text_sha256: "row-sha256",
        requires_disposition: true,
      }],
      table_fragments: [],
      reference_occurrences: [],
      evidence_fingerprint: "evidence-fingerprint",
    };

    const { result, provenance } = materialize(plan, manifest, "plan-fingerprint");
    const item = result.inspection_lots[0]!.items[0]!;
    expect(item.name).toBe("L(或B)≤30");
    expect(item.requirement).toBe("mm±5");
    expect(item.note).toBe(finalUiOnlyNote);
    expect(item.source_clause).toBe("5.3.4");
    expect(item.reference_source_clause).toBe("");
    expect(item.reference_from_clause).toBe("");
    expect(plan.acceptance_items[0]!.name).toBe(rawName);

    const provenanceItem = (provenance as {
      items: Record<string, {
        field_bindings: Record<string, { source_fragments: Array<{ text: string }> }>;
        materialized_fields: Record<string, { deterministic_transform: string }>;
      }>;
    }).items["item:row:1"]!;
    expect(provenanceItem.field_bindings.name!.source_fragments[0]!.text)
      .toBe(rawName);
    expect(provenanceItem.materialized_fields.name!.deterministic_transform)
      .toBe("mineru_inline_math_to_unicode");
  });

  it("keeps the originating clause separate from an appendix reference target", () => {
    const source = "4.4.2 主项目要求应按附录 B 检验";
    const referenced = "B.0.4 每批抽取 8 套连接副";
    const plan: SemanticSourcePlan = {
      schema_version: PLAN_SCHEMA_VERSION,
      job_id: "job-reference",
      target_id: "fastener",
      evidence_fingerprint: "reference-evidence-fingerprint",
      table_assembly: { schema_version: "table-assembly-plan/v1", evidence_fingerprint: "reference-evidence-fingerprint", logical_tables: [], fragment_dispositions: [] },
      inspection_lots: [{ lot_id: "lot", name: "标准紧固件", evidence_ids: ["evidence:row"], item_ids: ["item"] }],
      acceptance_items: [{
        item_id: "item",
        lot_id: "lot",
        name: "扭矩系数复验",
        category: "主控项目",
        requirement: referenced,
        method: "检查复验报告",
        quantity: "每批 8 套",
        note: "",
        evidence_ids: ["evidence:row"],
        reference_evidence_ids: ["evidence:row"],
        inspection_data_type: "measurement",
        inspection_data_type_reason: "复验产生扭矩系数测量值；单套与规定值比较；最终按复验数据评价。",
        inspection_data_type_evidence_ids: ["evidence:row"],
        field_bindings: {
          name: binding("扭矩系数复验"),
          requirement: binding(referenced),
          method: binding("检查复验报告"),
          quantity: binding("每批 8 套"),
          note: binding(""),
        },
        sampling: { status: "explicit", min_sampling: "每批 8 套", script: "每批抽取8套。", reason: "原文明确", confidence: 1, evidence_ids: ["evidence:row"] },
      }],
      reference_resolutions: [],
      evidence_dispositions: [],
      semantic_evidence: [
        { semantic_id: "semantic:item", role: "acceptance_item", evidence_id: "evidence:row", exact_fragment: source, parent_semantic_id: "", materialized_item_id: "item", reason: "正文验收项目" },
        { semantic_id: "semantic:anchor", role: "reference_anchor", evidence_id: "evidence:row", exact_fragment: source, parent_semantic_id: "", materialized_item_id: "", reason: "正文引用起点" },
        { semantic_id: "semantic:target", role: "referenced_clause", evidence_id: "evidence:row", exact_fragment: referenced, parent_semantic_id: "semantic:anchor", materialized_item_id: "", reason: "附录引用目标" },
        { semantic_id: "semantic:target-leaf", role: "acceptance_item", evidence_id: "evidence:row", exact_fragment: "扭矩系数复验", parent_semantic_id: "semantic:target", materialized_item_id: "item", reason: "附录目标中的展开叶片" },
      ],
      semantic_references: [{ expansion_id: "expansion", anchor_semantic_id: "semantic:anchor", status: "resolved", target_semantic_ids: ["semantic:target", "semantic:target-leaf"], destination_bindings: [{ item_id: "item", fields: ["requirement"] }], reason: "当前文档唯一引用" }],
    };
    const manifest: EvidenceManifest = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      job_id: "job-reference",
      target_id: "fastener",
      source: { adapter: "document-domain-agent/v1", file_name: "source.md", sha256: "source-sha256", semantic_workflow: true },
      scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "target_section", target_id: "fastener", source_line_count: 3, selected_start_line: 1, selected_end_exclusive_line: 4, selected_heading: "", selection_reason: "test", candidates: [] },
      evidence: [{ evidence_id: "evidence:row", kind: "paragraph", role: "supporting_clause", locator: "char:0-100", text: `${source}\n\n${referenced}`, text_sha256: "row-sha256", requires_disposition: true }],
      table_fragments: [],
      reference_occurrences: [],
      evidence_fingerprint: "reference-evidence-fingerprint",
    };
    const item = materialize(plan, manifest, "plan-fingerprint").result.inspection_lots[0]!.items[0]!;
    expect(item.source_clause).toBe("4.4.2");
    expect(item.reference_source_clause).toBe("B.0.4");
    expect(item.reference_from_clause).toBe("4.4.2");
  });

  it.runIf(existsSync(resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A056505dae2e7e713c865f3fe/revisions/000001",
  )))("replays the GB50576 mixed relation-and-text unit without changing provenance", () => {
    const root = resolve(
      "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A056505dae2e7e713c865f3fe/revisions/000001",
    );
    const evidence = JSON.parse(readFileSync(resolve(root, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const plan = JSON.parse(readFileSync(resolve(root, "last-valid.semantic-source-plan.json"), "utf8")) as SemanticSourcePlan;
    const result = materialize(plan, evidence, sha256Text("gb50576-display-replay")).result;
    const item = result.inspection_lots.flatMap((lot) => lot.items)
      .find((candidate) => candidate.item_id === "item:5281299b003be8ed101d");
    const source = plan.acceptance_items.find((candidate) => candidate.item_id === "item:5281299b003be8ed101d");

    expect(item).toMatchObject({
      requirement: "d≤120mm 1.0mm d>120mm 1.5mm",
      table_semantics: {
        allowed_value: "1.0mm1.5mm",
      },
    });
    expect(source?.field_bindings.requirement.source_fragments.some((fragment) =>
      fragment.text.includes("$d \\leqslant 120\\text{mm}$")
    )).toBe(true);
    expect(source?.table_semantics?.cell_evidence.some((fragment) =>
      fragment.text.includes("$d \\leqslant 120\\text{mm}$")
    )).toBe(true);
  });
});

/**
 * 国标里两三个字的小节标题常被排成等宽拉开，OCR 原样带出这些空格
 * （语料 22 份里有 132 处编号标题是这个形态）。检验批名取自这些标题，
 * 不并拢就跟金标逐字对不上：GB 50310 实测 25 个批名里 14 个带这种空格，
 * 逐字命中金标 6/25；并拢后 15/25，其余差异是子分部前缀约定，与本项无关。
 */
describe("汉字间排版空白的并拢", () => {
  it.each([
    ["驱 动 主 机", "驱动主机"],
    ["总 则", "总则"],
    ["降 排 水", "降排水"],
    ["液 压 系 统", "液压系统"],
    ["对 重 (平 衡 重 )", "对重(平衡重)"],
    ["机 房　设 备", "机房设备"],
  ])("并拢 %s", (input, expected) => {
    expect(collapseHanTypesettingSpacing(input)).toBe(expected);
  });

  it.each([
    // 至少一侧不是汉字的空白一律不动——中文不用空格分词，只有汉字之间的空白
    // 才必然是排版产物；这些都是有意义的间隔。
    ["GB 50300 标准"],
    ["GB 50300 (2013)"],
    ["10 mm 厚板"],
    ["第 4.2 节"],
    ["设备 A 与 B"],
    ["C20 混凝土"],
  ])("不动 %s", (input) => {
    expect(collapseHanTypesettingSpacing(input)).toBe(input);
  });

  it("连续拉开的一串一次并到底", () => {
    expect(collapseHanTypesettingSpacing("悬 挂 装 置 、 随 行 电 缆"))
      .toBe("悬挂装置、随行电缆");
  });
});
