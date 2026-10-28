import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  evaluateDiscoveryLedgerAgreement,
  extractableClauseIds,
  resolveLedgerWindowForTarget,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { buildDocumentEvidence } from "../src/document-discovery.js";

/**
 * 金标来自编辑器里同事人工核对过的两份编辑稿（见各 gold.json 的 source.editor_url）。
 * 它是「这份规范里到底有哪些验收项目」的答案，用来量底账必抽集的召回和精度：
 *  - 召回不足 = 底账少要条文 → per-target 闸门会在缺项时放行（静默丢项，最危险）
 *  - 精度不足 = 底账多要条文 → 抽取端永远交不出这条，闸门无限期卡住（假失败）
 * 两个方向都必须是 100%。
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "acceptance-gold");

interface ClauseGold {
  standard_no: string;
  source: { job_id: string; editor_url: string };
  lot_count: number;
  acceptance_item_count: number;
  clause_count: number;
  lot_names: string[];
  clauses: string[];
}

function loadGold(name: string): { gold: ClauseGold; markdown: string } {
  return {
    gold: JSON.parse(readFileSync(join(FIXTURES, `${name}.gold.json`), "utf8")) as ClauseGold,
    markdown: readFileSync(join(FIXTURES, `${name}.md`), "utf8"),
  };
}

describe.each([
  ["GB_50576-2010", 28, 141],
  ["GB_50310-2002", 25, 109],
])("底账必抽集对人工金标 %s", (name, expectedLots, expectedClauses) => {
  const { gold, markdown } = loadGold(name);
  const ledger = scanDocumentLedger(markdown, `${name}.md`);
  const required = new Set(extractableClauseIds(ledger));
  const goldClauses = new Set(gold.clauses);

  test("金标 fixture 自身与记录的计数一致", () => {
    expect(gold.clauses.length).toBe(gold.clause_count);
    expect(gold.clause_count).toBe(expectedClauses);
    expect(gold.lot_count).toBe(expectedLots);
    expect(gold.lot_names.length).toBe(gold.lot_count);
  });

  test("召回 100%：金标里的每条验收条文都在底账必抽集里", () => {
    const missed = [...goldClauses].filter((clause) => !required.has(clause)).sort();
    expect(missed).toEqual([]);
  });

  test("精度 100%：底账没有多要金标之外的条文", () => {
    const extra = [...required].filter((clause) => !goldClauses.has(clause)).sort();
    expect(extra).toEqual([]);
  });

  test("抽取窗口数不超过金标检验批数", () => {
    // 相等不是通例：整节转指的检验批（GB 50310 液压电梯 5.4「导轨安装应符合第 4.4 节」）
    // 确实是一个检验批，但它的验收项目来自被指向的那一节，本节没有自己的必抽条文，
    // 因此不会形成抽取窗口。窗口只能少于或等于检验批数，绝不能多。
    const windows = ledger.windows.filter((window) =>
      !window.ignored && window.extractable_clause_ids.length > 0
    );
    expect(windows.length).toBeLessThanOrEqual(gold.lot_count);
    expect(windows.length).toBeGreaterThan(0);
  });

  test("每条必抽条文恰好归属一个抽取窗口", () => {
    const owners = new Map<string, string[]>();
    for (const window of ledger.windows) {
      if (window.ignored) continue;
      for (const clause of window.extractable_clause_ids) {
        owners.set(clause, [...(owners.get(clause) ?? []), window.window_id]);
      }
    }
    expect([...required].filter((clause) => (owners.get(clause) ?? []).length !== 1)).toEqual([]);
  });
});

describe("底账窗口与金标检验批的一一对应（GB 50576）", () => {
  const { gold, markdown } = loadGold("GB_50576-2010");
  const ledger = scanDocumentLedger(markdown, "GB_50576-2010.md");
  const evidence = buildDocumentEvidence(markdown, "GB_50576-2010.md", 20_000);

  test("按窗口标题构造的目标计划与底账完全一致，可跳过独立复核", () => {
    const targets = ledger.windows
      .filter((window) => !window.ignored && window.extractable_clause_ids.length > 0)
      .map((window, index) => ({
        target_id: `t-${index}`,
        name: window.title,
        evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
        evidence_fragments: [{
          atom_id: evidence.atoms.find((atom) =>
            atom.start_line <= window.heading_line && atom.end_line >= window.heading_line
          )?.atom_id ?? evidence.atoms[0]!.atom_id,
          text: window.heading_text,
        }],
        ledger_window_id: window.window_id,
      }));
    expect(targets.length).toBe(gold.lot_count);
    for (const target of targets) {
      expect(resolveLedgerWindowForTarget(ledger, target, evidence.atoms)?.window_id)
        .toBe(target.ledger_window_id);
    }
    const agreement = evaluateDiscoveryLedgerAgreement({ targets }, ledger, evidence.atoms);
    expect(agreement.uncovered_clause_ids).toEqual([]);
    expect(agreement.overlapping_clause_ids).toEqual([]);
    expect(agreement.anomalies).toEqual([]);
    expect(agreement.skip_reviewer).toBe(true);
  });
});

describe("整节转指条款不进必抽集（GB 50310 液压电梯第 5 章）", () => {
  const { gold, markdown } = loadGold("GB_50310-2002");
  const ledger = scanDocumentLedger(markdown, "GB_50310-2002.md");
  const required = new Set(extractableClauseIds(ledger));

  test("转指检验批仍然存在，只是不产生抽取窗口——窗口数 + 转指节数 = 金标检验批数", () => {
    const windows = ledger.windows.filter((entry) =>
      !entry.ignored && entry.extractable_clause_ids.length > 0
    );
    const delegationSections = new Set(
      ledger.clauses
        .filter((clause) =>
          clause.kind === "non_item"
          && /^5\./.test(clause.clause_id)
          && /应符合本规范第[\d.\s]+节/.test(clause.text)
        )
        .map((clause) => clause.clause_id.split(".").slice(0, 2).join(".")),
    );
    expect(windows.length + delegationSections.size).toBe(gold.lot_count);
  });

  test("「应符合本规范第 X 节的规定」整条转指，验收项目落在被指向的那一节", () => {
    // 金标把 5.4.1 解成 4.4.1~4.4.6；留在必抽集里会让该检验批永远交不出账。
    for (const clause of ["5.2.1", "5.4.1", "5.5.1", "5.6.1", "5.7.1", "5.8.1", "5.10.1"]) {
      expect(ledger.clauses.find((entry) => entry.clause_id === clause)?.kind).toBe("non_item");
      expect(required.has(clause)).toBe(false);
    }
    for (const clause of ["4.4.1", "4.4.6", "4.5.1", "4.5.8"]) {
      expect(required.has(clause)).toBe(true);
    }
  });
});

describe("转指某张表的条款仍然是验收项目（GB 50576）", () => {
  const { markdown } = loadGold("GB_50576-2010");
  const required = new Set(extractableClauseIds(scanDocumentLedger(markdown, "GB_50576-2010.md")));

  test("「应符合本规范表 E.0.1 的规定」是判定值外置，不是范围转指", () => {
    for (const clause of ["10.3.8", "10.3.9", "10.3.10", "8.2.1"]) {
      expect(required.has(clause)).toBe(true);
    }
  });
});
