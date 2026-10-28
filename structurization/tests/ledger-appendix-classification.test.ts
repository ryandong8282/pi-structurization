import { describe, expect, test } from "vitest";

import { buildDocumentEvidence } from "../src/document-discovery.js";
import {
  evaluateDiscoveryLedgerAgreement,
  evaluateLedgerConfidence,
  extractableClauseIds,
  resolveLedgerWindowForTarget,
  scanDocumentLedger,
} from "../src/document-ledger.js";

/**
 * GB 50576-2010 的尾部形状：正文章节 + 「分部(子分部)工程竣工验收」章 + 允许偏差附录 + 记录表附录。
 * 这三段都以 `X.0.N` 编号，且紧跟在正文的「主控项目」栏目之后。
 */
const SAMPLE_TAIL = `
# 铝合金结构工程施工质量验收规范 [PDF p.1]

# 1 总则 [PDF p.8]

1.0.1 为加强铝合金结构工程施工质量管理，制定本规范。

# 10 铝合金框架结构安装工程 [PDF p.41]

## 10.1 一般规定 [PDF p.41]

10.1.2 铝合金框架结构安装工程应按变形缝或施工段划分成一个或若干个检验批。

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

10.3.8 单层铝合金结构中铝合金柱安装的允许偏差应符合本规范表E.0.1的规定。

检查数量：按铝合金柱数抽查10%，且不应小于3件。

检验方法：见本规范表E.0.1。

## 15 铝合金结构分部(子分部)工程竣工验收 [PDF p.67]

15.0.1 铝合金结构作为主体结构之一应按子分部工程竣工验收。

检查数量：全数检查。

检验方法：检查竣工验收资料。

15.0.2 铝合金结构分部工程竣工验收资料应完整。

检查数量：全数检查。

检验方法：检查资料。

## 附录 A 焊缝外观质量标准及尺寸允许偏差 [PDF p.69]

A.0.1 焊缝外观质量标准应符合表A.0.1的规定。

检查数量：全数检查。

检验方法：观察检查。

A.0.2 焊缝尺寸允许偏差应符合表A.0.2的规定。

检查数量：全数检查。

检验方法：尺量检查。

## 附录 H 铝合金结构分项工程检验批质量验收记录表 [PDF p.86]

H.0.1 铝合金结构(铝合金构件焊接)分项工程检验批质量验收应按表H.0.1进行记录。

<table><tr><td>工程名称</td><td></td></tr></table>

H.0.2 铝合金结构(紧固件连接)分项工程检验批质量验收应按表H.0.2进行记录。

<table><tr><td>工程名称</td><td></td></tr></table>
`.trim();

describe("ledger clause classification for 竣工验收 chapters and appendices", () => {
  const ledger = scanDocumentLedger(SAMPLE_TAIL, "GB_50576-tail.md");

  test("必抽集只保留正文条款，竣工验收章和附录一概排除", () => {
    expect(extractableClauseIds(ledger).sort()).toEqual(
      ["10.2.1", "10.3.1", "10.3.8"],
    );
  });

  test("竣工验收章的 X.0.N 条文判为 non_item，不伪造抽取窗口", () => {
    for (const clauseId of ["15.0.1", "15.0.2"]) {
      expect(ledger.clauses.find((clause) => clause.clause_id === clauseId)?.kind).toBe("non_item");
    }
    // 修复前 sectionKeyFromClauseId("15.0.1") 会返回 "15.0"，找不到同名标题就拿条文正文当标题造窗口。
    expect(ledger.windows.filter((window) => !window.ignored).map((window) => window.window_id))
      .not.toContain("window:15.0");
    expect(ledger.windows.some((window) => window.window_id.startsWith("window:15"))).toBe(false);
  });

  test("附录条文判为 non_item，附录标题成为 ignored 上下文窗口", () => {
    for (const clauseId of ["A.0.1", "A.0.2", "H.0.1", "H.0.2"]) {
      expect(ledger.clauses.find((clause) => clause.clause_id === clauseId)?.kind).toBe("non_item");
    }
    for (const number of ["A", "H"]) {
      const heading = ledger.headings.find((entry) => entry.number === number);
      expect(heading?.role).toBe("ignored");
      expect(ledger.windows.some((window) => window.ignored && window.number === number)).toBe(true);
    }
    expect(ledger.windows.filter((window) => !window.ignored).map((window) => window.number).sort())
      .toEqual(["10.2", "10.3"]);
  });

  test("ignored 窗口的终点跳过自己的子条文标题，不被截成一行", () => {
    const appendixA = ledger.windows.find((window) => window.ignored && window.number === "A")!;
    const appendixH = ledger.windows.find((window) => window.ignored && window.number === "H")!;
    // 附录 A 必须一直延伸到附录 H 的标题，而不是停在 A.0.1 那一行。
    expect(appendixA.end_exclusive_line).toBe(appendixH.heading_line);
    expect(appendixA.end_exclusive_line - appendixA.start_line).toBeGreaterThan(5);
  });

  test("栏目状态在新章节标题处清空，附录条文不会继承正文的主控项目", () => {
    for (const clauseId of ["15.0.1", "A.0.1", "H.0.1"]) {
      expect(ledger.clauses.find((clause) => clause.clause_id === clauseId)?.column).toBeUndefined();
    }
    expect(ledger.clauses.find((clause) => clause.clause_id === "10.2.1")?.column).toBe("主控项目");
  });

  test("必抽条数等于带检查数量的正文条文数", () => {
    const quantityBodyClauses = ledger.clauses.filter((clause) =>
      clause.kind === "item_candidate" && clause.has_quantity
    );
    expect(extractableClauseIds(ledger).length).toBe(quantityBodyClauses.length);
  });
});

/** GB 50243-2016 的形态：节标题本身就是栏目名，会被当作栏目行吃掉，从不进 headings。 */
const SECTION_HEADING_IS_COLUMN = `
# 4 风管制作 [PDF p.16]

# 4.1 一般规定 [PDF p.16]

4.1.1 风管的材料品种、规格应符合设计要求。

# 4.2 主控项目 [PDF p.18]

4.2.1 风管加工质量应通过工艺性的检测或验证。

检查数量：按数量抽查10%，且不应少于3件。

检验方法：观察检查。

4.2.2 风管的强度和严密性应符合设计要求。

检查数量：按系统抽查10%。

检验方法：漏风量测试。
`.trim();

/** OCR 丢掉节标题：4.2 那一行没了，条文号还在。 */
const SECTION_HEADING_LOST = `
# 4 木结构 [PDF p.16]

## 4.1 一般规定 [PDF p.16]

4.1.1 木结构工程应按变形缝划分检验批。

4.2.1 结构用木材应符合设计文件的规定。

检查数量：全数检查。

检验方法：检查质量证明文件。

4.2.2 进场木材均应作弦向静曲强度见证检验。

检查数量：每批抽查3组。

检验方法：见证检验报告。
`.trim();

describe("clause ownership follows clause numbers, not inherited heading text", () => {
  test("节标题即栏目名时，本节条文不再继承上一节的「一般规定」", () => {
    const ledger = scanDocumentLedger(SECTION_HEADING_IS_COLUMN, "GB_50243-shape.md");
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.1.1")?.kind).toBe("non_item");
    for (const clauseId of ["4.2.1", "4.2.2"]) {
      const clause = ledger.clauses.find((entry) => entry.clause_id === clauseId);
      expect(clause?.kind).toBe("item_candidate");
      expect(clause?.column).toBe("主控项目");
      expect(clause?.has_quantity).toBe(true);
    }
    expect(extractableClauseIds(ledger).sort()).toEqual(["4.2.1", "4.2.2"]);
  });

  test("OCR 丢掉节标题时，条文按自己的编号归属，不被上一节的标题误杀", () => {
    const ledger = scanDocumentLedger(SECTION_HEADING_LOST, "GB_50206-shape.md");
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.1.1")?.kind).toBe("non_item");
    expect(extractableClauseIds(ledger).sort()).toEqual(["4.2.1", "4.2.2"]);
    // 节标题不存在，窗口仍要按条文重建出来，且标题是短语而不是整条条文正文。
    const window = ledger.windows.find((entry) => entry.number === "4.2");
    expect(window?.ignored).toBe(false);
    expect(window?.extractable_clause_ids).toEqual(["4.2.1", "4.2.2"]);
    expect(window!.title.length).toBeLessThanOrEqual(24);
  });

  test("被 ignored 的节里的条文仍然判为 non_item", () => {
    const ledger = scanDocumentLedger(SECTION_HEADING_LOST, "GB_50206-shape.md");
    expect(ledger.headings.find((heading) => heading.number === "4.1")?.role).toBe("ignored");
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.1.1")?.kind).toBe("non_item");
  });
});

/** 家族 B：老标准只写「检验方法」，从不单列「检查数量」。 */
const METHOD_ONLY_TEMPLATE = `
# 4 基层与保护工程 [PDF p.16]

## 4.1 一般规定 [PDF p.16]

4.1.1 基层与保护工程应按屋面面积划分检验批。

## 4.2 找平层 [PDF p.17]

### I 主控项目 [PDF p.17]

4.2.1 找平层的材料质量及配合比应符合设计要求。

检验方法：检查出厂合格证、质量检验报告和计量措施。

4.2.2 找平层的排水坡度应符合设计要求。

检验方法：坡度尺检查。

### Ⅱ 一般项目 [PDF p.17]

4.2.3 找平层表面应平整，不得有酥松、起砂、起皮现象。

检验方法：观察检查。
`.trim();

describe("必抽判据按文档使用的验收模板自适应", () => {
  test("家族 A：有检查数量时，检查数量或检验方法都算模板字段", () => {
    const ledger = scanDocumentLedger(SAMPLE_TAIL, "familyA.md");
    expect(extractableClauseIds(ledger).sort()).toEqual(["10.2.1", "10.3.1", "10.3.8"]);
    for (const clauseId of extractableClauseIds(ledger)) {
      const clause = ledger.clauses.find((entry) => entry.clause_id === clauseId)!;
      expect(clause.has_quantity || clause.has_method).toBe(true);
    }
  });

  test("家族 B：全文没有检查数量时，只写检验方法的条文照样是验收项目", () => {
    const ledger = scanDocumentLedger(METHOD_ONLY_TEMPLATE, "familyB.md");
    expect(ledger.clauses.filter((clause) => clause.has_quantity)).toEqual([]);
    // 只认「检查数量」会把整节验收项目漏光——GB 50202 就是这么只剩 8 条的。
    expect(extractableClauseIds(ledger).sort()).toEqual(["4.2.1", "4.2.2", "4.2.3"]);
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.1.1")?.kind).toBe("non_item");
  });

  test("家族 C：两个模板字段都没有时才退回主控/一般栏目", () => {
    const noTemplate = METHOD_ONLY_TEMPLATE
      .split("\n")
      .filter((line) => !line.startsWith("检验方法"))
      .join("\n");
    const ledger = scanDocumentLedger(noTemplate, "familyC.md");
    expect(ledger.clauses.filter((clause) => clause.has_quantity || clause.has_method)).toEqual([]);
    expect(extractableClauseIds(ledger).sort()).toEqual(["4.2.1", "4.2.2", "4.2.3"]);
  });

  test("有模板字段的文档不再靠栏目继承捞条文", () => {
    // 4.1.1 落在 ignored 的一般规定里且没有模板字段；家族 B 判据不得把它捞进来。
    const ledger = scanDocumentLedger(METHOD_ONLY_TEMPLATE, "familyB.md");
    expect(extractableClauseIds(ledger)).not.toContain("4.1.1");
  });
});

describe("ledger confidence gates the zero-LLM blind seal", () => {
  test("窗口全部有真标题、无异常、必抽集来自检查数量时才允许直封", () => {
    const confidence = evaluateLedgerConfidence(scanDocumentLedger(SAMPLE_TAIL, "clean.md"));
    expect(confidence.every_window_has_heading).toBe(true);
    expect(confidence.headless_window_numbers).toEqual([]);
    expect(confidence.anomaly_count).toBe(0);
    expect(confidence.column_only_clause_count).toBe(0);
    expect(confidence.safe_for_blind_seal).toBe(true);
  });

  test("节标题靠条文号反推重建时不允许直封", () => {
    const confidence = evaluateLedgerConfidence(
      scanDocumentLedger(SECTION_HEADING_LOST, "headless.md"),
    );
    expect(confidence.headless_window_numbers).toEqual(["4.2"]);
    expect(confidence.safe_for_blind_seal).toBe(false);
  });

  test("必抽集靠栏目推断时不允许直封", () => {
    const columnOnly = SAMPLE_TAIL
      .split("\n")
      .filter((line) => !line.startsWith("检查数量") && !line.startsWith("检验方法"))
      .join("\n");
    const confidence = evaluateLedgerConfidence(scanDocumentLedger(columnOnly, "column-only.md"));
    expect(confidence.column_only_clause_count).toBeGreaterThan(0);
    expect(confidence.safe_for_blind_seal).toBe(false);
  });

  test("只有检验方法（家族 B）也不允许直封——没有金标证过这类文档的检验批划分", () => {
    const confidence = evaluateLedgerConfidence(
      scanDocumentLedger(METHOD_ONLY_TEMPLATE, "familyB.md"),
    );
    expect(confidence.method_only_clause_count).toBeGreaterThan(0);
    expect(confidence.column_only_clause_count).toBe(0);
    expect(confidence.safe_for_blind_seal).toBe(false);
  });

  test("底账没扫到任何抽取窗口时不允许直封", () => {
    const confidence = evaluateLedgerConfidence(
      scanDocumentLedger("地基承载力应满足设计要求。".repeat(40), "plain.md"),
    );
    expect(confidence.target_window_count).toBe(0);
    expect(confidence.safe_for_blind_seal).toBe(false);
  });
});

describe("ledger window resolution anchors on both fragment sets", () => {
  const evidence = buildDocumentEvidence(SAMPLE_TAIL, "GB_50576-tail.md", 20_000);
  const ledger = scanDocumentLedger(SAMPLE_TAIL, "GB_50576-tail.md");

  test("lot_basis 落在 ignored 的一般规定里时，退到 evidence_fragments 的节标题锚点", () => {
    const target = {
      target_id: "t-10.3",
      // 名字带上章节修饰，撞不到唯一窗口标题——只能靠锚点定位。
      name: "铝合金框架结构总拼和安装",
      evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
      evidence_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 10.3 总拼和安装" }],
      materialization: {
        lot_basis_fragments: [{
          atom_id: evidence.atoms[0]!.atom_id,
          text: "10.1.2 铝合金框架结构安装工程应按变形缝或施工段划分成一个或若干个检验批。",
        }],
      },
    };
    expect(resolveLedgerWindowForTarget(ledger, target, evidence.atoms)?.window_id)
      .toBe("window:10.3");
  });

  test("lot_basis 能锚到抽取窗口时优先用它", () => {
    const target = {
      target_id: "t-10.2",
      name: "基础和支承面",
      evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
      evidence_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 10.3 总拼和安装" }],
      materialization: {
        lot_basis_fragments: [{
          atom_id: evidence.atoms[0]!.atom_id,
          text: "10.2.1 基础顶面直接作为柱的支承面时，其位置和标高应符合设计要求。",
        }],
      },
    };
    expect(resolveLedgerWindowForTarget(ledger, target, evidence.atoms)?.window_id)
      .toBe("window:10.2");
  });

  test("两个节各归一个 target 时，覆盖一致且可跳过独立复核", () => {
    const plan = {
      targets: [
        {
          target_id: "t-10.2",
          name: "基础和支承面",
          evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
          evidence_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 10.2 基础和支承面" }],
        },
        {
          target_id: "t-10.3",
          name: "铝合金框架结构总拼和安装",
          evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id),
          evidence_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 10.3 总拼和安装" }],
          materialization: {
            lot_basis_fragments: [{
              atom_id: evidence.atoms[0]!.atom_id,
              text: "10.1.2 铝合金框架结构安装工程应按变形缝或施工段划分成一个或若干个检验批。",
            }],
          },
        },
      ],
    };
    const agreement = evaluateDiscoveryLedgerAgreement(plan, ledger, evidence.atoms);
    expect(agreement.uncovered_clause_ids).toEqual([]);
    expect(agreement.overlapping_clause_ids).toEqual([]);
    expect(agreement.skip_reviewer).toBe(true);
  });
});
