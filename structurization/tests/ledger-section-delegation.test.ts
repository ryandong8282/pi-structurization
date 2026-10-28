import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  targetOwnLineScope,
  targetUsesDelegatedLedgerWindow,
} from "../src/batch.js";
import {
  evaluateDiscoveryLedgerAgreement,
  resolveLedgerWindowForTarget,
  scanDocumentLedger,
} from "../src/document-ledger.js";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const gb50310 = resolve(packageRoot, "fixtures/real/GB_50310-2002.md");

/**
 * 整节转指：`5.2.1 土建交接检验应符合本规范第 4.2 节的规定。` 是一整节的全部内容，
 * 这一节本身是真实检验批，验收项目却全落在被指向的那一节里。
 *
 * 此前没有任何一层去读这句话里的节号，窗口解析只能靠模型碰巧引对那一节、锚点恰好落进去。
 * GB 50310 第 5 章有 7 节同构，实测有的成有的败；`土建交接检验` 这个名字还在
 * 4.2/5.2/6.2 三处重名，名称兜底撞不唯一，于是它连续四轮 window=None、修复循环空转。
 */
describe("整节转指的窗口解析", () => {
  test("GB 50310 第 5 章七节转指全部解析到被指向的节，且不靠模型锚点", async () => {
    const markdown = (await readFile(gb50310, "utf8")).replace(/\r\n?/g, "\n");
    const ledger = scanDocumentLedger(markdown, "GB_50310-2002.md");
    const delegations = ledger.clauses.filter((clause) => clause.delegates_to_section);

    expect(delegations.map((clause) => [clause.clause_id, clause.delegates_to_section]))
      .toEqual([
        ["5.2.1", "4.2"],
        ["5.4.1", "4.4"],
        ["5.5.1", "4.5"],
        ["5.6.1", "4.6"],
        ["5.7.1", "4.7"],
        ["5.8.1", "4.8"],
        ["5.10.1", "4.10"],
      ]);

    for (const clause of delegations) {
      // 最坏情形：不给 ledger_window_id、不给任何证据锚点，范围只有节标题那一行——
      // 转指条文本身都不在范围内。实测这正是七节里失手那两节的形态
      // （模型只挑了标题原子），所以判据必须取「目标落在底账哪一节」，
      // 而不是「范围里有哪些条文」。
      const section = clause.clause_id.replace(/\.\d+$/, "");
      const heading = ledger.headings.find((entry) => entry.number === section)!;
      const window = resolveLedgerWindowForTarget(ledger, {
        name: "土建交接检验",
        start_line: heading.line,
        end_exclusive_line: heading.line + 1,
      });
      expect(window?.window_id).toBe(`window:${clause.delegates_to_section}`);
      expect(window!.extractable_clause_ids.length).toBeGreaterThan(0);
    }
  });

  test("转指条文不算必抽项，但被指向的那一节仍然要抽", async () => {
    const markdown = (await readFile(gb50310, "utf8")).replace(/\r\n?/g, "\n");
    const ledger = scanDocumentLedger(markdown, "GB_50310-2002.md");

    const delegation = ledger.clauses.find((clause) => clause.clause_id === "5.2.1")!;
    expect(delegation.kind).toBe("non_item");

    const target = ledger.windows.find((window) => window.window_id === "window:4.2")!;
    expect(target.extractable_clause_ids).toContain("4.2.1");
  });

  test("Discovery must retain a pure delegation source without double-owning its destination", () => {
    const markdown = [
      "## 4.10 电气装置",
      "主控项目",
      "4.10.1 电气设备必须可靠接地。",
      "## 5.10 电气装置",
      "5.10.1 电气装置安装应符合本规范第 4.10 节的规定。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "delegation-discovery.md");
    const atoms = [
      { atom_id: "atom:410", start_line: 1, end_line: 3, text: markdown.split("\n").slice(0, 3).join("\n") },
      { atom_id: "atom:510", start_line: 4, end_line: 5, text: markdown.split("\n").slice(3).join("\n") },
    ];
    const destination = {
      target_id: "target:410",
      name: "电气装置",
      evidence_atom_ids: ["atom:410"],
      evidence_fragments: [{ atom_id: "atom:410", text: "## 4.10 电气装置" }],
    };
    const missingSource = evaluateDiscoveryLedgerAgreement(
      { targets: [destination] }, ledger, atoms,
    );
    expect(missingSource.uncovered_clause_ids).toContain("5.10.1");

    const withSource = evaluateDiscoveryLedgerAgreement({
      targets: [destination, {
        target_id: "target:510",
        name: "电气装置安装",
        evidence_atom_ids: ["atom:510"],
        evidence_fragments: [{ atom_id: "atom:510", text: atoms[1]!.text }],
      }],
    }, ledger, atoms);
    expect(withSource.uncovered_clause_ids).toEqual([]);
    expect(withSource.overlapping_clause_ids).toEqual([]);
    expect(withSource.skip_reviewer).toBe(true);
  });

  test("转指目标保留自己的物理范围，被指向的节只作为 ledger 窗口", async () => {
    const markdown = (await readFile(gb50310, "utf8")).replace(/\r\n?/g, "\n");
    const ledger = scanDocumentLedger(markdown, "GB_50310-2002.md");
    const heading = ledger.headings.find((entry) => entry.number === "5.10")!;
    const lineSpan = { start_line: heading.line, end_exclusive_line: heading.line + 1 };
    const resolved = resolveLedgerWindowForTarget(ledger, {
      name: "电气装置安装",
      ...lineSpan,
    });

    expect(resolved?.window_id).toBe("window:4.10");
    const scope = targetOwnLineScope(ledger, lineSpan, resolved);
    const localClause = ledger.clauses.find((clause) => clause.clause_id === "5.10.1")!;
    const referencedClause = ledger.clauses.find((clause) => clause.clause_id === "4.10.1")!;
    expect(localClause.line).toBeGreaterThanOrEqual(scope.start_line);
    expect(localClause.line).toBeLessThan(scope.end_exclusive_line);
    expect(referencedClause.line < scope.start_line || referencedClause.line >= scope.end_exclusive_line)
      .toBe(true);
    expect(targetUsesDelegatedLedgerWindow(scope, resolved!)).toBe(true);

    const directHeading = ledger.headings.find((entry) => entry.number === "4.10")!;
    const directLineSpan = {
      start_line: directHeading.line,
      end_exclusive_line: directHeading.line + 1,
    };
    const directWindow = ledger.windows.find((window) => window.window_id === "window:4.10")!;
    expect(targetOwnLineScope(ledger, directLineSpan, directWindow)).toEqual({
      start_line: directWindow.start_line,
      end_exclusive_line: directWindow.end_exclusive_line,
    });
    expect(targetUsesDelegatedLedgerWindow(directWindow, directWindow)).toBe(false);
  });

  test("节里除转指外还有别的条文时，不整体改指别处", () => {
    // 半转指：一句转指 + 一条自己的验收要求。整节改指会把 5.2.2 丢掉。
    const markdown = [
      "## 4.2 土建交接检验",
      "",
      "4.2.1 机房内部必须符合电梯土建布置图的要求。",
      "",
      "检查数量：全数检查。",
      "",
      "检验方法：观察检查。",
      "",
      "## 5.2 土建交接检验",
      "",
      "5.2.1 土建交接检验应符合本规范第 4.2 节的规定。",
      "",
      "5.2.2 液压缸基座必须安装牢固。",
      "",
      "检查数量：全数检查。",
      "",
      "检验方法：观察检查。",
      "",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "half-delegation.md");
    const delegation = ledger.clauses.find((clause) => clause.clause_id === "5.2.1")!;
    expect(delegation.delegates_to_section).toBe("4.2");

    const section = ledger.windows.find((window) => window.window_id === "window:5.2")!;
    const resolved = resolveLedgerWindowForTarget(ledger, {
      name: "土建交接检验",
      start_line: section.start_line,
      end_exclusive_line: section.end_exclusive_line,
    });
    // 关键是不能被整体改指到 4.2——那会把 5.2.2 从必抽集里抹掉。
    // （这里最终解析不到任何窗口，是因为「土建交接检验」在 4.2/5.2 重名、
    //   名称兜底撞不唯一；那是既有行为，与本条无关。）
    expect(resolved?.window_id).not.toBe("window:4.2");
    expect(section.extractable_clause_ids).toContain("5.2.2");
  });

  test("转指某张表不是整节转指——那仍然是一个验收项目", () => {
    const markdown = [
      "## 10.3 阳极氧化膜",
      "",
      "10.3.8 阳极氧化膜厚度应符合本规范表 E.0.1 的规定。",
      "",
      "检查数量：全数检查。",
      "",
      "检验方法：膜厚仪检查。",
      "",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "table-delegation.md");
    const clause = ledger.clauses.find((entry) => entry.clause_id === "10.3.8")!;
    expect(clause.delegates_to_section).toBeUndefined();
    expect(clause.kind).toBe("item_candidate");
  });
});
