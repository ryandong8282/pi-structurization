import { describe, expect, test } from "vitest";

import { coverageRepairBudgetStatus, coverageRepairShouldHalt } from "../src/batch.js";
import {
  coverageScopeFromLedgerGate,
  evaluateTargetLedgerCoverage,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { contaminatedItemIds, evidenceLineIndex, resolveItemClauseId } from "../src/ledger-reconciliation.js";

/**
 * GB 50310「土建交接检验」实测死循环的两个成因，各锁一条回归。
 *
 * 那一条是整节转指（`5.2 土建交接检验应符合本规范第 4.2 节的规定`），底账不给它建窗口，
 * 于是 per-target 闸门 vacuous、缺口为空，却仍然判 complete=false；
 * 拿这个结果去收窄复核范围就得到「零缺口零项目」的 ledger_gap 任务，
 * 复核 agent 空手而归 → 机械收尾 → 再进一轮修复，40+ 分钟不收敛。
 */
const DELEGATING_SECTION = `
# 4 电力驱动的曳引式或强制式电梯安装工程

## 4.2 土建交接检验

主控项目

4.2.1 机房内应设有固定的电气照明装置。

检验方法：观察检查。

# 5 液压电梯安装工程

## 5.2 土建交接检验

5.2.1 土建交接检验应符合本规范第 4.2 节的规定。
`.trim();

describe("vacuous ledger gate must not scope the coverage review", () => {
  const ledger = scanDocumentLedger(DELEGATING_SECTION, "GB_50310-shape.md");

  test("整节转指的节不产生抽取窗口，闸门对它 vacuous", () => {
    expect(ledger.clauses.find((clause) => clause.clause_id === "5.2.1")?.kind).toBe("non_item");
    expect(ledger.windows.some((window) => !window.ignored && window.number === "5.2")).toBe(false);

    // 窗口解析不出来时闸门只覆盖标题一行，范围内没有任何底账条文。
    const heading = ledger.headings.find((entry) => entry.number === "5.2")!;
    const coverage = evaluateTargetLedgerCoverage({
      ledger,
      start_line: heading.line,
      end_exclusive_line: heading.line + 1,
      source_clauses: ["4.2.1"],
    });
    expect(coverage.vacuous).toBe(true);
    expect(coverage.complete).toBe(false);
    expect(coverage.gap_clause_ids).toEqual([]);
  });

  test("vacuous 闸门给出的 ledger_gap 范围是空的——不能拿它去派复核任务", () => {
    const heading = ledger.headings.find((entry) => entry.number === "5.2")!;
    const coverage = evaluateTargetLedgerCoverage({
      ledger,
      start_line: heading.line,
      end_exclusive_line: heading.line + 1,
      source_clauses: ["4.2.1"],
    });
    const scope = coverageScopeFromLedgerGate({
      coverage,
      items: [{ item_id: "item:1", source_clause: "4.2.1" }],
    });
    // 零缺口 + 零受影响项目：复核 agent 拿到这个只能空手而归，然后无限重来。
    expect(scope.gap_clause_ids).toEqual([]);
    expect(scope.affected_item_ids).toEqual([]);
    expect(scope.affected_evidence_ids).toEqual([]);
    // 所以 batch 侧必须在 vacuous 时退回全文复核，而不是用这个范围。
    expect(coverage.vacuous).toBe(true);
  });
});

describe("coverage repair rounds are bounded even inside one transaction", () => {
  const recheck = (fingerprint: string) => ({
    selector_protocol: { coverage_repairs: 1 },
    coverage_recheck: {
      schema_version: "coverage-recheck-scope/v1",
      plan_fingerprint: fingerprint,
    },
  });

  test("同一笔事务的豁免让 available 恒真——所以它不能是唯一的终止条件", () => {
    const budget = coverageRepairBudgetStatus(recheck("fp-1"), "fp-1", 3);
    expect(budget.continuing_transaction).toBe(true);
    // 提交次数早已超过上限，available 仍然为真：这正是死循环的来源。
    const exhausted = coverageRepairBudgetStatus(
      { selector_protocol: { coverage_repairs: 99 }, coverage_recheck: recheck("fp-1").coverage_recheck },
      "fp-1",
      3,
    );
    expect(exhausted.committed_repairs).toBe(99);
    expect(exhausted.available).toBe(true);
  });

  test("轮次天花板与已提交事务预算相互独立，且不能收紧后者", () => {
    // batch 侧的绝对天花板：max(4, 预算×3)。它只负责兜死循环，
    // 不能把「一笔修复事务允许多轮往返」这件正常的事掐掉——
    // 之前误把轮次并进 coverage_repair_attempts，预算 1 就变成「两轮即失败」，
    // 真实作业里 4 个本来能修好的 target 被误判成失败。
    for (const [limit, expected] of [[1, 4], [3, 9], [12, 36]] as const) {
      expect(Math.max(4, limit * 3)).toBe(expected);
      expect(Math.max(4, limit * 3)).toBeGreaterThan(limit);
    }
  });

  test("延续中 available 仍为真时，红笔两轮不变也必须停", () => {
    const budget = coverageRepairBudgetStatus(recheck("fp-1"), "fp-1", 3);
    expect(budget.continuing_transaction).toBe(true);
    expect(budget.available).toBe(true);
    expect(coverageRepairShouldHalt({
      continuingTransaction: budget.continuing_transaction,
      budgetAvailable: budget.available,
      roundsExhausted: false,
      progressStop: true,
    })).toEqual({ halt: true, reason: "progress_stalled" });
  });

  test("红笔在变时，延续事务可以继续改，不靠换编号续命", () => {
    expect(coverageRepairShouldHalt({
      continuingTransaction: true,
      budgetAvailable: true,
      roundsExhausted: false,
      progressStop: false,
    })).toEqual({ halt: false });
  });

  test("红笔在变但轮次用尽时，仍按轮次天花板停", () => {
    expect(coverageRepairShouldHalt({
      continuingTransaction: true,
      budgetAvailable: true,
      roundsExhausted: true,
      progressStop: false,
    })).toEqual({ halt: true, reason: "rounds_exhausted" });
  });

  test("不是同一笔事务时才按已提交次数封顶", () => {
    expect(coverageRepairBudgetStatus(recheck("fp-other"), "fp-1", 3).available).toBe(true);
    expect(
      coverageRepairBudgetStatus(
        { selector_protocol: { coverage_repairs: 3 }, coverage_recheck: recheck("fp-other").coverage_recheck },
        "fp-1",
        3,
      ).available,
    ).toBe(false);
  });
});

describe("按行号归属条文（物化层位置归属失效时的必需兜底）", () => {
  const SOURCE = `
# 5 液压电梯安装工程

## 5.11 整机安装验收

5.11.2 限速器(安全绳)安全钳联动试验必须符合下列规定:

1 限速器与安全钳电气开关在联动试验中必须动作可靠。

2 联动试验时轿厢载荷及速度应符合规定。

5.11.3 层门与轿门的试验必须符合下列规定:

1 每层层门必须能够用三角钥匙正常开启。
`.trim();

  test("项目抽自不带编号的子条时，仍能按证据行号归到所属条文", () => {
    const ledger = scanDocumentLedger(SOURCE, "GB_50310-shape.md");
    const ids = new Set(ledger.clauses.map((clause) => clause.clause_id));
    const lines = SOURCE.split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle)) + 1;

    const evidence = [
      { evidence_id: "e-sub-1", locator: `line:${lineOf("限速器与安全钳电气开关")}` },
      { evidence_id: "e-sub-2", locator: `line:${lineOf("联动试验时轿厢载荷")}` },
      { evidence_id: "e-sub-3", locator: `line:${lineOf("每层层门必须能够")}` },
    ];
    const index = evidenceLineIndex(evidence);

    // 子条正文不带条文号，前两条路（source_clause / 正文开头）都失效。
    const subItem = {
      name: "限速器与安全钳电气开关动作可靠",
      requirement: "1 限速器与安全钳电气开关在联动试验中必须动作可靠。",
      evidence_ids: ["e-sub-1"],
    };
    expect(resolveItemClauseId(subItem, ids)).toBe("");
    expect(resolveItemClauseId(subItem, ids, ledger, index)).toBe("5.11.2");

    expect(resolveItemClauseId(
      { name: "轿厢载荷及速度", requirement: "2 联动试验时轿厢载荷及速度应符合规定。", evidence_ids: ["e-sub-2"] },
      ids, ledger, index,
    )).toBe("5.11.2");
    expect(resolveItemClauseId(
      { name: "三角钥匙开启", requirement: "1 每层层门必须能够用三角钥匙正常开启。", evidence_ids: ["e-sub-3"] },
      ids, ledger, index,
    )).toBe("5.11.3");
  });

  test("抽取端已写 source_clause 时以它为准，行号只是兜底", () => {
    const ledger = scanDocumentLedger(SOURCE, "x.md");
    const ids = new Set(ledger.clauses.map((clause) => clause.clause_id));
    const index = evidenceLineIndex([{ evidence_id: "e", locator: "line:6" }]);
    expect(resolveItemClauseId(
      { source_clause: "5.11.3", requirement: "无关正文", evidence_ids: ["e"] },
      ids, ledger, index,
    )).toBe("5.11.3");
  });

  test("没有证据行号时不猜，返回空", () => {
    const ledger = scanDocumentLedger(SOURCE, "x.md");
    const ids = new Set(ledger.clauses.map((clause) => clause.clause_id));
    // `char:` 整原子没有行号，索引里查不到 → 不归属
    const index = evidenceLineIndex([{ evidence_id: "e", locator: "char:0-100" }]);
    expect(resolveItemClauseId(
      { name: "无编号", requirement: "一段不带编号的话", evidence_ids: ["e"] },
      ids, ledger, index,
    )).toBe("");
  });
});

describe("零 LLM 直封的可信度护栏（per-target 侧）", () => {
  /** 家族 A：条文自带检查数量 + 检验方法，必抽集有模板字段支撑。 */
  const TEMPLATE_BACKED = `
# 4 原材料进场

## 4.2 铝合金材料

### I 主控项目

4.2.1 铝合金材料的品种、规格、性能应符合设计文件要求。

检查数量：全数检查。

检验方法：检查质量证明文件。
`.trim();

  /** 家族 C：全文没有检查数量/检验方法，必抽集只能靠主控/一般栏目向下继承。 */
  const COLUMN_INFERRED = `
# 4 电力驱动电梯安装

## 4.10 电气装置

主控项目

4.10.1 电气设备接地必须符合规定。

4.10.2 导体之间和导体对地之间的绝缘电阻必须大于 1000Ω/V。
`.trim();

  const columnOnlyClausesIn = (source: string) => {
    const ledger = scanDocumentLedger(source, "x.md");
    const window = ledger.windows.find((entry) => !entry.ignored && entry.extractable_clause_ids.length)!;
    return ledger.clauses.filter((clause) =>
      clause.kind === "item_candidate"
      && clause.line >= window.start_line
      && clause.line < window.end_exclusive_line
      && !clause.has_quantity
      && !clause.has_method
    );
  };

  test("必抽集由检查数量/检验方法支撑时，允许零 LLM 直封", () => {
    expect(columnOnlyClausesIn(TEMPLATE_BACKED)).toEqual([]);
  });

  test("必抽集只靠栏目继承推出来时，必须拦下——这是三种信号里最弱的一种", () => {
    const columnOnly = columnOnlyClausesIn(COLUMN_INFERRED);
    expect(columnOnly.length).toBeGreaterThan(0);
    expect(columnOnly.map((clause) => clause.clause_id)).toEqual(["4.10.1", "4.10.2"]);
    // 这些条文确实是必抽集的一部分——不是「没识别到」，而是「识别依据太弱，
    // 不能零复核定稿」。GB 50310 实测 21/25 个检验批走的就是这条路。
    const ledger = scanDocumentLedger(COLUMN_INFERRED, "x.md");
    for (const clause of columnOnly) {
      expect(ledger.clauses.find((entry) => entry.clause_id === clause.clause_id)?.column).toBeDefined();
    }
  });
});

describe("串条文机械拦截（有客观对错的部分才拦）", () => {
  const SOURCE = `
# 4 电力驱动电梯安装

## 4.7 对重(平衡重)

4.7.1 对重应设置反绳轮防护及挡绳装置。

检验方法：观察检查。

4.7.2 平衡重块应可靠固定。

检验方法：观察检查。

## 4.11 整机安装验收

4.11.10 观感检查应符合下列规定。
`.trim();

  const ledger = scanDocumentLedger(SOURCE, "x.md");
  const lines = SOURCE.split("\n");
  const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle)) + 1;

  test("直接证据落在本条文范围内时放行", () => {
    const evidence = [{ evidence_id: "e-own", locator: `line:${lineOf("对重应设置反绳轮防护")}` }];
    expect(contaminatedItemIds({
      ledger,
      items: [{ item_id: "item:ok", source_clause: "4.7.1", evidence_ids: ["e-own"] }],
      lineIndex: evidenceLineIndex(evidence),
    })).toEqual([]);
  });

  test("项目抄进了别的条文的原文时拦下", () => {
    // 归属 4.7.1，却绑了 4.11.10 的行——实测形态就是这样（隔了两百多行）。
    const evidence = [
      { evidence_id: "e-own", locator: `line:${lineOf("对重应设置反绳轮防护")}` },
      { evidence_id: "e-foreign", locator: `line:${lineOf("观感检查应符合下列规定")}` },
    ];
    expect(contaminatedItemIds({
      ledger,
      items: [{ item_id: "item:bad", source_clause: "4.7.1", evidence_ids: ["e-own", "e-foreign"] }],
      lineIndex: evidenceLineIndex(evidence),
    })).toEqual(["item:bad"]);
  });

  test("跨条文引用走 reference_evidence_ids，不算串条文", () => {
    const evidence = [
      { evidence_id: "e-own", locator: `line:${lineOf("对重应设置反绳轮防护")}` },
      { evidence_id: "e-ref", locator: `line:${lineOf("观感检查应符合下列规定")}` },
    ];
    // 只看 evidence_ids；引用证据不在其中，所以不触发。
    expect(contaminatedItemIds({
      ledger,
      items: [{ item_id: "item:ref", source_clause: "4.7.1", evidence_ids: ["e-own"] }],
      lineIndex: evidenceLineIndex(evidence),
    })).toEqual([]);
  });

  test("归属不出条文号的项目不参与判定，避免误伤", () => {
    expect(contaminatedItemIds({
      ledger,
      items: [{ item_id: "item:unknown", requirement: "一段没有编号的话", evidence_ids: [] }],
      lineIndex: evidenceLineIndex([]),
    })).toEqual([]);
  });
});
