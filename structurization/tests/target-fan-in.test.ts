import { describe, expect, test } from "vitest";

import { estimateTargetFanIn, type FanInLedgerView } from "../src/target-fan-in.js";

/**
 * 复刻 GB/T 50312 的真实形态：第 8 章正文引附录 A/B/C，
 * 而附录内部的条文也被渲染成 H1、且底账解析不出编号（number 为空）。
 */
function ledgerFixture(): FanInLedgerView {
  return {
    headings: [
      { line: 1, level: 1, number: "8", role: "group" },
      { line: 20, level: 1, number: "9", role: "group" },
      { line: 30, level: 1, number: "A", role: "ignored" },
      { line: 40, level: 1, number: "B", role: "ignored" },
      // 附录 B 内部的条文标题：level 同为 1，编号为空——不能当作附录 B 的边界
      { line: 45, level: 1, number: "", role: "ignored" },
      { line: 55, level: 1, number: "", role: "ignored" },
      { line: 70, level: 1, number: "C", role: "ignored" },
      { line: 80, level: 1, number: "10", role: "group" },
    ],
    clauses: [
      { clause_id: "4.0.6", line: 90, end_exclusive_line: 93 },
      { clause_id: "8.0.3", line: 3, end_exclusive_line: 6 },
    ],
    tables: [
      { table_no: "8.0.6", line: 12 },
      { table_no: "8.0.7-1", line: 15 },
    ],
  };
}

function linesFixture(): string[] {
  const lines = Array.from({ length: 100 }, (_unused, index) => `line ${index + 1} filler`);
  lines[2] = "8.0.3 对绞电缆布线系统测试应符合本规范附录 B 的规定。";
  lines[10] = "8.0.6 现场测试仪应符合本规范第 4.0.6 条规定，精度应符合表 8.0.6 的规定。";
  lines[16] = "8.0.7 测试内容应按本规范附录 A、附录 B、附录 C 的规定记录。";
  return lines;
}

describe("target fan-in estimate", () => {
  const scope = { start_line: 1, end_exclusive_line: 20 };

  test("measures an appendix to its next numbered sibling, not its first inner heading", () => {
    const estimate = estimateTargetFanIn(linesFixture(), scope, ledgerFixture());
    const appendixB = estimate.citations.find((entry) => entry.kind === "appendix" && entry.key === "B")!;
    // 附录 B 从 40 管到 70（附录 C），而不是被 45 行那个无编号内部标题截断。
    // 实测这个 bug 把 32,549 B 的附录估成 2,726 B，扇入判据直接失效。
    expect(appendixB.start_line).toBe(40);
    expect(appendixB.end_exclusive_line).toBe(70);
    expect(appendixB.bytes).toBeGreaterThan(0);
  });

  test("counts one appendix once even when two clauses cite it", () => {
    const estimate = estimateTargetFanIn(linesFixture(), scope, ledgerFixture());
    // 8.0.3 和 8.0.7 都引附录 B——运行时 target_key 去重只读一次，估算必须一致
    const bCitations = estimate.citations.filter((entry) => entry.kind === "appendix" && entry.key === "B");
    expect(bCitations.length).toBe(2);
    expect(bCitations.filter((entry) => entry.bytes > 0)).toHaveLength(1);
    // 明细加总必须等于总量，否则谁按明细算预算都会重复计数
    const summed = estimate.citations.reduce((total, entry) => total + entry.bytes, 0);
    expect(summed).toBe(estimate.fan_in_bytes);
  });

  test("resolves appendix, clause and table citations", () => {
    const estimate = estimateTargetFanIn(linesFixture(), scope, ledgerFixture());
    const kinds = new Set(estimate.citations.filter((entry) => entry.resolved).map((entry) => entry.kind));
    expect(kinds).toEqual(new Set(["appendix", "clause", "table"]));
    expect(estimate.fan_in_bytes).toBeGreaterThan(estimate.own_bytes);
  });

  test("does not count a citation that points inside the target's own scope", () => {
    const estimate = estimateTargetFanIn(linesFixture(), scope, ledgerFixture());
    // 8.0.3 和 表8.0.6 都落在本目标自己的行范围内，不是扇入
    const inside = estimate.citations.filter((entry) => entry.resolved && entry.start_line >= 1 && entry.end_exclusive_line <= 20);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((entry) => entry.bytes === 0)).toBe(true);
  });

  test("records unresolved literals instead of guessing a size", () => {
    const lines = linesFixture();
    lines[5] = "本条应符合本规范附录 Z 的规定。";
    const estimate = estimateTargetFanIn(lines, scope, ledgerFixture());
    expect(estimate.unresolved_literals.some((literal) => literal.includes("Z"))).toBe(true);
    const unresolved = estimate.citations.find((entry) => entry.key === "Z")!;
    expect(unresolved.resolved).toBe(false);
    expect(unresolved.bytes).toBe(0);
  });

  test("a chapter with no outward citations has zero fan-in", () => {
    const lines = Array.from({ length: 100 }, () => "普通条文，没有任何引用。");
    const estimate = estimateTargetFanIn(lines, scope, ledgerFixture());
    expect(estimate.fan_in_bytes).toBe(0);
    expect(estimate.total_bytes).toBe(estimate.own_bytes);
  });

  test("separates the reference-heavy chapter from the rest by a wide margin", () => {
    const lines = linesFixture();
    const ledger = ledgerFixture();
    const heavy = estimateTargetFanIn(lines, { start_line: 1, end_exclusive_line: 20 }, ledger);
    const plain = estimateTargetFanIn(lines, { start_line: 20, end_exclusive_line: 30 }, ledger);
    // 判据只需要排序与阈值：现场实测 47,855 B vs 次高 4,206 B，差 11 倍
    expect(heavy.fan_in_bytes).toBeGreaterThan(plain.fan_in_bytes * 4);
  });
});
