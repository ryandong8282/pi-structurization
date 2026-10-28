import { describe, expect, test } from "vitest";

import {
  batchLedgerGapFrom,
  describeBatchLedgerGap,
  targetCoverageSourceClauses,
  targetLedgerCoverageWithFallback,
} from "../src/batch.js";
import { ledgerWithCurrentTableCaptions, scanDocumentLedger } from "../src/document-ledger.js";

/**
 * 复刻 2026-08-20 GB 50576 那次真实作业的失效形态：
 * 10.3 节共 3 条带检查数量的条文，target 只抽到前 1 条就封存，
 * 而每个 target 的 per-target 闸门都报了 complete —— 全书对账是最后一道拦截。
 */
const SAMPLE = `
# 铝合金结构工程施工质量验收规范 [PDF p.1]

# 10 铝合金框架结构安装工程 [PDF p.41]

## 10.2 基础和支承面 [PDF p.41]

### I 主控项目 [PDF p.41]

10.2.1 基础顶面直接作为柱的支承面时，其位置和标高应符合设计要求。

检查数量：按柱基数抽查10%，且不应少于3个。

检验方法：用经纬仪和钢尺实测。

## 10.3 总拼和安装 [PDF p.43]

### I 主控项目 [PDF p.43]

10.3.1 铝合金构件运输、堆放和吊装等造成的变形应进行矫正。

检查数量：按构件数抽查10%，且不应少于3个。

检验方法：用拉线、钢尺现场实测。

10.3.2 铝合金结构柱子安装的允许偏差应符合表10.3.2的规定。

检查数量：标准柱全部检查。

检验方法：用全站仪实测。

10.3.3 设计要求顶紧的节点，接触面不应少于75%紧贴。

检查数量：按节点数抽查10%，且不应小于3个。

检验方法：用钢尺及塞尺现场实测。
`.trim();

const BATCH_TARGETS = [
  { target_id: "target-10-2", name: "基础和支承面", ledger_window_id: "window:10.2" },
  { target_id: "target-10-3", name: "总拼和安装", ledger_window_id: "window:10.3" },
];

function item(clauseId: string, requirement: string): {
  source_clause: string;
  name: string;
  requirement: string;
} {
  return { source_clause: clauseId, name: `项目 ${clauseId}`, requirement };
}

describe("batch-level ledger gate", () => {
  test("confirmed disjoint source ranges own gaps across windows without claiming the intervening source", () => {
    const ledger = scanDocumentLedger([
      "# 2 装置检查", "## 2.1 连接", "2.1.1 连接应牢固。", "检查数量：全数检查。",
      "## 2.2 标识", "2.2.1 标识应清晰。", "检查数量：全数检查。",
      "## 2.3 表面", "2.3.1 表面应完整。", "检查数量：全数检查。",
    ].join("\n"), "neutral-scopes.md");
    const { gap } = batchLedgerGapFrom({ ledger, items: [], targets: [{
      target_id: "joined", name: "连接和表面", ledger_window_id: "window:2.1",
      primary_source_ranges: [{ start_line: 3, end_exclusive_line: 5 }, { start_line: 9, end_exclusive_line: 11 }],
    }] });
    expect(gap?.owners).toEqual([expect.objectContaining({ target_id: "joined", missing_clause_ids: ["2.1.1", "2.3.1"] })]);
    expect(gap?.unowned_clause_ids).toEqual(["2.2.1"]);
  });

  const ledger = scanDocumentLedger(SAMPLE, "GB_50576-gate.md");

  test("底账适用且全覆盖时不产生缺口", () => {
    const { reconciliation, gap } = batchLedgerGapFrom({
      ledger,
      targets: BATCH_TARGETS,
      items: [
        item("10.2.1", "基础顶面位置和标高"),
        item("10.3.1", "构件变形矫正"),
        item("10.3.2", "柱子安装允许偏差"),
        item("10.3.3", "顶紧节点接触面"),
      ],
    });
    expect(reconciliation.applicable).toBe(true);
    expect(reconciliation.ok).toBe(true);
    expect(gap).toBeUndefined();
  });

  test("keeps a structured table identity when display text joins its row coordinate", () => {
    const tableLedger = scanDocumentLedger([
      "# 1 桩基础",
      "1.1.1 桩位应符合表1.1.1的规定。",
      "检查数量：全数检查。",
      "表1.1.1 灌注桩允许偏差",
      "<table><tr><td>项</td><td>允许偏差</td></tr><tr><td>桩径</td><td>3</td></tr></table>",
    ].join("\n"), "fused-table-reference.md");

    const { reconciliation, gap } = batchLedgerGapFrom({
      ledger: tableLedger,
      targets: [{ target_id: "target-1-1", name: "桩基础", ledger_window_id: "window:1" }],
      items: [{
        source_clause: "1.1.1",
        name: "桩径",
        // This is the display-only shape produced when a table-number span
        // and its row span are joined without a separator.
        requirement: "本标准表1.1.13 | 允许偏差",
        table_semantics: { table_no: "表 1.1.1 灌注桩允许偏差" },
      }],
    });

    expect(reconciliation.unresolved_table_refs).toEqual([]);
    expect(reconciliation.table_identity_ok).toBe(true);
    expect(reconciliation.ok).toBe(true);
    expect(gap).toBeUndefined();
  });

  test("accepts an exact continuation caption without equating damaged or related table identities", () => {
    const markdown = ["1.1.1 检验应符合表 C.0.4 的规定。", "检查数量：全数检查。",
      "表 C.0.X 检验要求", "<table><tr><td>尺寸</td></tr></table>",
      "续表 C.0.4", "<table><tr><td>位置</td></tr></table>",
      "表 C.0.6-1 检验要求", "<table><tr><td>其他</td></tr></table>",
    ].join("\n");
    const saved = { ...scanDocumentLedger(markdown, "continuation.md"), tables: [] };
    const ledger = ledgerWithCurrentTableCaptions(saved, markdown);
    const result = batchLedgerGapFrom({ ledger, targets: [], items: [item("1.1.1", "应符合表 C.0.4 的规定。") ] });
    expect(result.reconciliation.ok).toBe(true);
    expect(result.gap).toBeUndefined();
    const unknown = batchLedgerGapFrom({ ledger, targets: [], items: [item("1.1.1", "应符合表 C.0.5、表 C.0.6 及表 C.0.40 的规定。") ] });
    expect(unknown.reconciliation.unresolved_table_refs).toEqual(["C.0.5", "C.0.6", "C.0.40"]);
    expect(unknown.reconciliation.ok).toBe(false);
  });

  test("names an unresolved table when clause coverage itself is complete", () => {
    const tableLedger = scanDocumentLedger([
      "# 1 现场验收",
      "1.1.1 检验应按表 1.1.1 执行。",
      "检查数量：全数检查。",
      "表 1.1.1 检验标准",
      "<table><tr><td>项目</td><td>标准</td></tr></table>",
    ].join("\n"), "table-gap.md");
    const { reconciliation, gap } = batchLedgerGapFrom({
      ledger: tableLedger,
      targets: [{ target_id: "target-1", name: "现场验收" }],
      items: [{
        source_clause: "1.1.1",
        name: "现场检验",
        requirement: "应按表 1.1.2 执行。",
      }],
    });
    expect(reconciliation.missing_clause_ids).toEqual([]);
    expect(reconciliation.unresolved_table_refs).toEqual(["1.1.2"]);
    expect(gap?.unresolved_table_refs).toEqual(["1.1.2"]);
    expect(describeBatchLedgerGap(gap!)).toContain("未找到对应表题的表号 1.1.2");
    expect(describeBatchLedgerGap(gap!)).toContain("必抽条文覆盖 1/1");
    expect(describeBatchLedgerGap(gap!)).not.toContain("只覆盖");
    expect(describeBatchLedgerGap(gap!)).toContain("精确表题匹配 0（通过条件至少 1）");
    expect(describeBatchLedgerGap(gap!)).toContain("已封存记录在当前修订不可写");
    expect(gap!.table_reference_diagnostics![0]!.affected_records[0]).toMatchObject({ source_clause: "1.1.1", field: "requirement", raw_reference: "表 1.1.2" });
  });

  test("附录条文被 MinerU 识别成标题时仍是已知条文，不误报 extra", () => {
    const appendixLedger = scanDocumentLedger([
      "# 9 预制构件",
      "## 9.2 预制构件进场验收",
      "9.2.2 预制构件结构性能检验应符合规定。",
      "检查数量：按批检验。",
      "## 附录 B 受弯预制构件结构性能检验",
      "## B.1.3 挠度检验允许值应按公式计算。",
    ].join("\n"), "GB_50204-appendix-heading.md");
    const { reconciliation } = batchLedgerGapFrom({
      ledger: appendixLedger,
      targets: [{ target_id: "target-9-2", name: "预制构件进场验收", ledger_window_id: "window:9.2" }],
      items: [
        item("9.2.2", "预制构件结构性能检验"),
        item("B.1.3", "挠度检验允许值计算"),
      ],
    });

    expect(reconciliation.extra_clause_ids).toEqual([]);
    expect(reconciliation.ok).toBe(true);

    const invented = batchLedgerGapFrom({
      ledger: appendixLedger,
      targets: [{ target_id: "target-9-2", name: "预制构件进场验收", ledger_window_id: "window:9.2" }],
      items: [item("9.2.2", "预制构件结构性能检验"), item("B.9.9", "不存在的附录条文")],
    });
    expect(invented.reconciliation.extra_clause_ids).toEqual(["B.9.9"]);
    expect(invented.reconciliation.ok).toBe(false);
  });

  test("target gate counts the typed reference origin without replacing the target clause", () => {
    expect(targetCoverageSourceClauses([{
      source_clause: "4.9.1",
      reference_from_clause: "5.9.1",
    }])).toEqual(["4.9.1", "5.9.1"]);
    expect(targetCoverageSourceClauses([{
      source_clause: "5.7.1",
      reference_source_clause: "4.7.1",
      reference_from_clause: "5.7.1",
    }])).toEqual(["5.7.1", "4.7.1"]);
  });

  test("节推断不把引用来的外部条文摊给本 target（GB 50210 幕墙实测回归）", () => {
    // 幕墙各节条文是 item_candidate 且无检查数量词样（不进必抽集），窗口内必抽集为空；
    // target 的引用原点落在外部饰面砖节。旧逻辑用合并集推节，会把 10.3 整节必抽条文
    // 摊给幕墙 target，跨章引用必然误报缺口（rev95-101 连续七版卡死的形状）。
    const crossRefLedger = scanDocumentLedger([
      "# 10 饰面砖粘贴",
      "## 10.3 外墙饰面砖",
      "10.3.1 外墙饰面砖粘贴应牢固。",
      "检查数量：按批抽查。",
      "检验方法：拉拔试验。",
      "10.3.2 外墙饰面砖应无空鼓。",
      "检查数量：按批抽查。",
      "检验方法：小锤敲击。",
      "# 11 幕墙",
      "## 11.3 金属幕墙工程主控项目和一般项目",
      "11.3.1 金属幕墙工程主控项目应包括下列项目。",
      "11.3.2 金属幕墙工程一般项目应包括下列项目。",
    ].join("\n"), "cross-ref-sections.md");
    const metalWindow = { start_line: 10, end_exclusive_line: 13 };

    const inferenceOwnOnly = targetLedgerCoverageWithFallback({
      ledger: crossRefLedger,
      window: metalWindow,
      source_clauses: ["11.3.1", "10.3.1"],
      inference_source_clauses: ["11.3.1"],
    });
    expect(inferenceOwnOnly.coverage.vacuous).toBe(true);
    expect(inferenceOwnOnly.coverage.gap_clause_ids).toEqual([]);
    expect(inferenceOwnOnly.inferred_section_keys).toEqual([]);

    // 旧行为对照：引用条文参与推节时，外部 10.3 整节被要求、10.3.2 无人认领。
    const legacyMerged = targetLedgerCoverageWithFallback({
      ledger: crossRefLedger,
      window: metalWindow,
      source_clauses: ["11.3.1", "10.3.1"],
    });
    expect(legacyMerged.inferred_section_keys).toEqual(["10.3", "11.3"]);
    expect(legacyMerged.coverage.gap_clause_ids).toEqual(["10.3.2"]);
  });

  test("target 各自封存但全书漏条文时，缺口归属到拥有它的 target", () => {
    const { reconciliation, gap } = batchLedgerGapFrom({
      ledger,
      targets: BATCH_TARGETS,
      // 10.3 只抽到第一条就封存 —— 正是 10.3.9~10.3.14 被丢掉的那个形状。
      items: [item("10.2.1", "基础顶面位置和标高"), item("10.3.1", "构件变形矫正")],
    });
    expect(reconciliation.ok).toBe(false);
    expect(gap).toBeDefined();
    expect(gap!.missing_clause_ids).toEqual(["10.3.2", "10.3.3"]);
    expect(gap!.owners).toEqual([{
      target_id: "target-10-3",
      target_name: "总拼和安装",
      ledger_window_id: "window:10.3",
      missing_clause_ids: ["10.3.2", "10.3.3"],
    }]);
    expect(gap!.unowned_clause_ids).toEqual([]);
    expect(gap!.required_clause_count).toBe(4);
    expect(gap!.covered_required_clause_count).toBe(2);
  });

  test("缺口条文没有任何 target 认领时单独列出，不会被静默吞掉", () => {
    const { gap } = batchLedgerGapFrom({
      ledger,
      targets: [BATCH_TARGETS[0]!],
      items: [item("10.2.1", "基础顶面位置和标高")],
    });
    expect(gap!.owners).toEqual([]);
    expect(gap!.unowned_clause_ids).toEqual(["10.3.1", "10.3.2", "10.3.3"]);
  });

  test("没有 ledger_window_id 时靠名字回落解析窗口", () => {
    const { gap } = batchLedgerGapFrom({
      ledger,
      targets: [
        { target_id: "target-10-2", name: "基础和支承面" },
        { target_id: "target-10-3", name: "总拼和安装" },
      ],
      items: [item("10.2.1", "基础顶面位置和标高"), item("10.3.1", "构件变形矫正")],
    });
    expect(gap!.owners.map((owner) => owner.target_id)).toEqual(["target-10-3"]);
  });

  test("底账扫不到条文时闸门不适用，不报假警", () => {
    const emptyLedger = scanDocumentLedger("地基承载力应满足设计要求。".repeat(40), "plain.md");
    const { reconciliation, gap } = batchLedgerGapFrom({
      ledger: emptyLedger,
      targets: BATCH_TARGETS,
      items: [],
    });
    expect(reconciliation.applicable).toBe(false);
    expect(gap).toBeUndefined();
  });

  test("失败信息带上缺口条文和归属 target，重跑有的放矢", () => {
    const { gap } = batchLedgerGapFrom({
      ledger,
      targets: BATCH_TARGETS,
      items: [item("10.2.1", "基础顶面位置和标高"), item("10.3.1", "构件变形矫正")],
    });
    const message = describeBatchLedgerGap(gap!);
    expect(message).toContain("10.3.2");
    expect(message).toContain("10.3.3");
    expect(message).toContain("总拼和安装");
    expect(message).toContain("window:10.3");
    expect(message).toContain("必抽条文覆盖 2/4");
  });
});
