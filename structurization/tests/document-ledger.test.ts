import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildDocumentEvidence, DocumentDiscoveryController, DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { compileDocumentSelectors, discoveryScopeReviewHints, DocumentSelectorCompileError } from "../src/document-selector-compiler.js";
import {
  coverageScopeFromLedgerGate,
  discoveryScopeWindows,
  evaluateDiscoveryLedgerAgreement,
  evaluateTargetLedgerCoverage,
  extractableClauseIds,
  ledgerTargetPrimaryScopes,
  ledgerWindowForLine,
  ledgerWithCurrentTableCaptions,
  ledgerWithCurrentClauseBoundaries,
  prefillDocumentSelectorsFromLedger,
  resolveLedgerWindowForTarget,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { sha256Text } from "../src/canonical.js";

const SAMPLE_50576 = `
# 铝合金结构工程施工质量验收规范 [PDF p.1]

# 1 总则 [PDF p.8]

1.0.1 为加强铝合金结构工程施工质量管理，制定本规范。

1.0.2 本规范适用于铝合金结构工程施工质量验收。

# 2 术语 [PDF p.9]

2.0.1 铝合金结构 aluminium alloy structure

以铝合金为主要承重材料的结构。

# 4 原材料及成品进场验收 [PDF p.12]

## 4.1 一般规定 [PDF p.12]

4.1.1 进场材料应具有质量证明文件。

## 4.2 铝合金材料 [PDF p.13]

### 主控项目 [PDF p.13]

4.2.1 铝合金材料的品种、规格、性能应符合设计文件要求。

检查数量：全数检查。

检验方法：检查质量证明文件。

4.2.2 铝合金材料规格尺寸允许偏差应符合现行国家标准的规定。

检查数量：每种规格抽查不少于1处。

检验方法：用钢尺测量。

### 一般项目 [PDF p.14]

4.2.3 铝合金材料外观不应有明显损伤。

检查数量：抽查10%，且不少于3件。

检验方法：观察检查。

## 4.3 焊接材料 [PDF p.15]

主控项目

4.3.1 焊接材料的品种、规格、性能应符合设计文件要求。

检查数量：全数检查。

检验方法：检查质量证明文件。

# 5 铝合金结构焊接工程 [PDF p.20]

## 5.2 焊接 [PDF p.21]

主 控 项 目

5.2.1 焊工资格应符合现行国家标准的规定。

检查数量：全数检查。

检验方法：检查资格证书。

附录 H 检验批质量验收记录

表H.0.10 铝合金焊接检验批质量验收记录

<table><tr><td>工程名称</td><td></td></tr><tr><td>主控项目</td><td></td></tr></table>

表H.0.11 铝合金材料进场检验批质量验收记录

铝合金材料进场

<table><tr><td>工程名称</td><td></td></tr></table>
`.trim();

describe("document ledger scan", () => {
  test.each(["7.3.2中性后项应符合要求。", "## 7.3.2中性后项应符合要求。", "7．3．2中性后项应符合要求。"])("joined clause prose closes the previous method/quantity scope: %s", second => {
    const markdown = ["7.3.1 中性前项应符合要求。", "检查数量：抽查2件。", "检验方法：观察。",
      second, "检查数量：全数检查。", "检验方法：核对记录。"].join("\n");
    const ledger = scanDocumentLedger(markdown, "neutral.md");
    expect(ledger.clauses.map(clause => clause.clause_id)).toEqual(["7.3.1", "7.3.2"]);
    expect(ledger.clauses[0]).toMatchObject({ end_exclusive_line: 4, quantity_line: 2, method_line: 3 });
    expect(ledger.clauses[1]).toMatchObject({ line: 4, quantity_line: 5, method_line: 6 });
  });

  test("joined boundary cache refresh is read-only, source-pinned and excludes Latin/numeric suffixes", () => {
    const markdown = ["7.3.1 中性前项。", "检验方法：观察。", "7.3.2中性后项。", "检验方法：核对。"].join("\n");
    const saved = scanDocumentLedger(markdown.replace("7.3.2中性后项。", "中性后项。"), "neutral.md");
    saved.source_sha256 = sha256Text(markdown);
    const before = JSON.stringify(saved);
    const current = ledgerWithCurrentClauseBoundaries(saved, markdown);
    expect(current.clauses.map(clause => clause.clause_id)).toEqual(["7.3.1", "7.3.2"]);
    expect(current.clauses[0]).toMatchObject({ end_exclusive_line: 3, method_line: 2 });
    expect(JSON.stringify(saved)).toBe(before);
    expect(ledgerWithCurrentClauseBoundaries(current, markdown)).toBe(current);
    expect(() => ledgerWithCurrentClauseBoundaries(saved, markdown + "\n额外原文")).toThrow("ledger_clause_boundary_source_mismatch");
    expect(scanDocumentLedger("7.3.2mm\n7.3.2abc\n7.3.2.4%\n7.3.2条的规定。\n7.3.2章。", "tokens.md").clauses).toEqual([]);
  });
  test.each([false, true])("table markup does not replace prose field lines (multiline=%s)", (multiline) => {
    const table = [
      "<table>",
      "<tr><td>项目</td><td>检查方法</td><td>检查数量</td></tr>",
      "<tr><td>长度</td><td>尺量</td><td>每组两件</td></tr>",
      "</table>",
    ].join(multiline ? "\n" : "");
    const lines = [
      "# 8 构件验收", "## 8.2 尺寸", "8.2.1 尺寸应符合设计要求。",
      "检查数量：逐件检查。", "检验方法：测量。", table,
      "8.2.2 外观应符合表内规定。", table,
      "8.2.3 接口应符合设计要求。", table, "检查方法：观察。", "检查数量：全数检查。",
    ].join("\n").split("\n");
    const ledger = scanDocumentLedger(lines.join("\n"), "multiple-tables.md");
    const [before, tableOnly, after] = ledger.clauses;
    expect(before).toMatchObject({ quantity_line: 4, method_line: 5 });
    expect(tableOnly?.method_line).toBeUndefined();
    expect(tableOnly?.quantity_line).toBeUndefined();
    // Tables remain discoverable coverage signals, but are not prose role lines.
    expect(tableOnly).toMatchObject({ has_method: true, has_quantity: true });
    expect(after).toMatchObject({ method_line: lines.length - 1, quantity_line: lines.length });
  });

  test("collects clauses, columns, quantity lines, and appendix record tables from a 50576-shaped sample", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "GB_50576-sample.md");
    expect(ledger.schema_version).toBe("document-ledger/v1");
    expect(ledger.clauses.length).toBeGreaterThan(0);
    expect(ledger.clauses.map((clause) => clause.clause_id)).toEqual(
      expect.arrayContaining(["1.0.1", "2.0.1", "4.2.1", "4.2.3", "4.3.1", "5.2.1"]),
    );

    const general = ledger.clauses.find((clause) => clause.clause_id === "1.0.1");
    const terms = ledger.clauses.find((clause) => clause.clause_id === "2.0.1");
    expect(general?.kind).toBe("non_item");
    expect(terms?.kind).toBe("non_item");

    const aluminium = ledger.clauses.find((clause) => clause.clause_id === "4.2.1");
    expect(aluminium?.column).toBe("主控项目");
    expect(aluminium?.has_quantity).toBe(true);
    expect(aluminium?.has_method).toBe(true);
    expect(aluminium?.kind).toBe("item_candidate");

    const appearance = ledger.clauses.find((clause) => clause.clause_id === "4.2.3");
    expect(appearance?.column).toBe("一般项目");
    expect(appearance?.has_quantity).toBe(true);

    const spaced = ledger.clauses.find((clause) => clause.clause_id === "5.2.1");
    expect(spaced?.column).toBe("主控项目");

    expect(extractableClauseIds(ledger)).toEqual(
      expect.arrayContaining(["4.2.1", "4.2.2", "4.2.3", "4.3.1", "5.2.1"]),
    );
    expect(extractableClauseIds(ledger)).not.toEqual(
      expect.arrayContaining(["1.0.1", "2.0.1"]),
    );

    expect(ledger.record_tables.length).toBeGreaterThanOrEqual(1);
    expect(ledger.record_tables.map((table) => table.table_no).join(" ")).toMatch(/H\.0\.10|表H/);
    expect(ledger.windows.some((window) => window.number === "4.2" && !window.ignored)).toBe(true);
    expect(ledger.windows.some((window) => /总则/.test(window.title) && window.ignored)).toBe(true);
  });

  test("does not assign a following column heading to the preceding clause", () => {
    const markdown = [
      "## 4.3 焊接材料 [PDF p.19]",
      "## I 主控项目 [PDF p.19]",
      "4.3.1 焊接材料应符合设计要求。",
      "检查数量：全数检查。",
      "检验方法：检查质量证明文件。",
      "4.3.2 重要结构采用的焊接材料应进行抽样复验。",
      "检查数量：全数检查。",
      "检验方法：检查复验报告。",
      "## Ⅱ 一般项目 [PDF p.19]",
      "4.3.3 焊条外观不应有缺陷。",
      "检查数量：抽查10%。",
      "检验方法：观察检查。",
    ].join("\n");

    const ledger = scanDocumentLedger(markdown, "GB_50576-column-boundary.md");
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.3.2")?.column)
      .toBe("主控项目");
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.3.3")?.column)
      .toBe("一般项目");
  });

  test("keeps plain numeric chapter ids extractable while still flagging OCR roman-numeral ids", () => {
    const markdown = [
      "# 11 铝合金空间网格结构安装工程 [PDF p.60]",
      "## 11.2 支承面 [PDF p.60]",
      "主控项目",
      "11.2.1 支座定位轴线的位置、支柱锚栓的规格应符合设计要求。",
      "检查数量：全数检查。",
      "检验方法：用钢尺现场实测。",
      "# 附录 H 检验批质量验收记录",
      "II.0.10 铝合金幕墙分项工程检验批质量验收记录",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "chapter11.md");
    const clause = ledger.clauses.find((entry) => entry.clause_id === "11.2.1");
    expect(clause?.kind).toBe("item_candidate");
    expect(clause?.column).toBe("主控项目");
    expect(extractableClauseIds(ledger)).toContain("11.2.1");
    expect(ledger.windows.some((window) => window.number === "11.2" && !window.ignored)).toBe(true);
    expect(ledger.clauses.find((entry) => entry.clause_id === "II.0.10")?.kind).toBe("anomaly");
  });

  test("collects table captions so clause table references can be resolved", () => {
    const markdown = [
      "## 10.3 总拼和安装",
      "主控项目",
      "10.3.9 安装偏差应符合表 E.0.1 的规定。",
      "检查数量：按检验批抽查。",
      "表 E.0.1 单层铝合金结构安装的允许偏差",
      "<table><tr><td>项目</td><td>允许偏差</td></tr></table>",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "captions.md");
    expect(ledger.tables?.map((table) => table.table_no)).toContain("E.0.1");
    expect(ledger.tables?.some((table) => table.table_no === "面")).toBe(false);
  });

  test("indexes exact continuation captions even when the first page's caption is damaged", () => {
    const markdown = [
      "表 B.0.X 允许偏差", "<table><tr><td>尺寸</td><td>允许值</td></tr></table>",
      "## 续表 B.0.7 [PDF p.12]", "<table><tr><td>位置</td><td>允许值</td></tr></table>",
      "续表 B.0.7", "表 B.0.8 其他检验", "检验应符合续表 B.0.9。",
    ].join("\r\n");
    const ledger = scanDocumentLedger(markdown, "continuation.md");
    expect(ledger.tables?.filter(table => table.table_no === "B.0.7")).toEqual([
      { table_no: "B.0.7", line: 3, title: "B.0.7" },
    ]);
    expect(ledger.tables?.map(table => table.table_no)).toContain("B.0.8");
    expect(ledger.tables?.map(table => table.table_no)).not.toContain("B.0.9");
    expect(ledger.tables?.map(table => table.table_no)).not.toContain("B.0");
  });

  test("refreshes only derived captions from identical frozen source and rejects a substituted source", () => {
    const markdown = "1.1.1 位置应符合设计要求。\n检查数量：全数检查。\n续表 C.0.4\n<table><tr><td>位置</td></tr></table>";
    const saved = { ...scanDocumentLedger(markdown, "frozen.md"), tables: [] };
    const before = JSON.stringify(saved);
    const current = ledgerWithCurrentTableCaptions(saved, markdown);
    expect(current.tables?.map(table => table.table_no)).toEqual(["C.0.4"]);
    expect(current.clauses).toBe(saved.clauses);
    expect(current.windows).toBe(saved.windows);
    expect(current.record_tables).toBe(saved.record_tables);
    expect(JSON.stringify(saved)).toBe(before);
    expect(() => ledgerWithCurrentTableCaptions(saved, `${markdown}\n表 C.0.5`)).toThrow("ledger_table_caption_source_mismatch");
    const legacy = { ...saved, tables: undefined };
    expect(ledgerWithCurrentTableCaptions(legacy, markdown)).toBe(legacy);
  });

  test("marks OCR-looking appendix ids as anomalies instead of inventing a book-specific map", () => {
    const markdown = [
      "# 附录 H 检验批质量验收记录",
      "II.0.10 铝合金焊接检验批质量验收记录",
      "4.2.1 铝合金材料应符合设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "ocr.md");
    expect(ledger.anomalies.length).toBeGreaterThan(0);
    expect(ledger.clauses.some((clause) => clause.clause_id === "4.2.1" && clause.has_quantity)).toBe(true);
  });

  test("scans GB 50310 fixture without asserting editor gold item counts", async () => {
    const markdownPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/real/GB_50310-2002.md",
    );
    const markdown = await readFile(markdownPath, "utf8");
    const ledger = scanDocumentLedger(markdown, "GB_50310-2002.md");
    expect(ledger.clauses.length).toBeGreaterThan(20);
    expect(ledger.clauses.some((clause) => clause.clause_id.startsWith("1.") && clause.kind === "non_item")).toBe(true);
    expect(ledger.clauses.some((clause) => clause.clause_id.startsWith("2.") && clause.kind === "non_item")).toBe(true);
    expect(ledger.clauses.some((clause) => /^\d+\.\d+\.\d+$/.test(clause.clause_id))).toBe(true);
    const quantityClauses = ledger.clauses.filter((clause) => clause.has_quantity);
    for (const clause of quantityClauses) {
      expect(clause.clause_id).toMatch(/^[0-9A-Za-z]/);
      expect(clause.line).toBeGreaterThan(0);
    }
    expect(ledger.record_tables.length).toBeGreaterThan(0);
  });

  test("groups 3-part clause headings into one section window and keeps 主控栏目 from cutting it", () => {
    const markdown = [
      "# 5 铝合金结构焊接工程 [PDF p.20]",
      "## 5.2 焊接 [PDF p.21]",
      "## 主控项目 [PDF p.21]",
      "### 5.2.2 焊缝外观经目视检查合格。",
      "检查数量：全数检查。",
      "5.2.8 铝合金焊缝内部质量应符合附录 A.0.1 的规定。",
      "检查数量：按检验批抽查。",
      "## 6.1 一般规定 [PDF p.30]",
      "6.1.1 施工现场应有焊接工艺。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "nested.md");
    const welding = ledger.windows.filter((window) => window.number === "5.2" && !window.ignored);
    expect(welding).toHaveLength(1);
    expect(welding[0]?.extractable_clause_ids).toEqual(expect.arrayContaining(["5.2.2", "5.2.8"]));
    expect(ledger.windows.some((window) => window.number === "5.2.2")).toBe(false);
    expect(ledger.windows.some((window) => window.number === "6.1" && !window.ignored)).toBe(false);
  });

  test("recognizes appendix clause ids when MinerU promotes the clause to a markdown heading", () => {
    const markdown = [
      "## 附录 B 预制构件结构性能检验 [PDF p.62]",
      "B.1.2 预制构件的挠度检验应符合下列规定。",
      "## B.1.3 挠度检验允许值应按下列公式计算。 [PDF p.63]",
      "### B． 1． 4 预制构件的抗裂检验应符合规定。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "appendix-heading.md");

    expect(ledger.clauses.map((clause) => clause.clause_id)).toEqual([
      "B.1.2",
      "B.1.3",
      "B.1.4",
    ]);
    expect(ledger.clauses.every((clause) => clause.kind === "non_item")).toBe(true);
    expect(ledger.clauses.find((clause) => clause.clause_id === "B.1.3")?.line).toBe(3);
  });

  test("appendix OCR anomalies do not block ledger skip when extractable clauses are covered", () => {
    const markdown = [
      "# 4 原材料",
      "## 4.2 铝合金材料",
      "4.2.1 铝合金材料应符合设计要求。",
      "检查数量：全数检查。",
      "II.0.10 铝合金焊接检验批质量验收记录",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "anomaly.md");
    expect(ledger.anomalies.length).toBeGreaterThan(0);
    const evidence = buildDocumentEvidence(markdown, "anomaly.md", 1_000);
    const covered = evaluateDiscoveryLedgerAgreement(
      { targets: [{ target_id: "t-all", name: "铝合金材料", evidence_atom_ids: evidence.atoms.map((atom) => atom.atom_id) }] },
      ledger,
      evidence.atoms,
    );
    expect(covered.uncovered_clause_ids).toEqual([]);
    expect(covered.skip_reviewer).toBe(true);
  });

  test("skips discovery reviewer only when extractable clauses are covered without overlap", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const evidence = buildDocumentEvidence(SAMPLE_50576, "sample.md", 1_000);
    const allAtomIds = evidence.atoms.map((atom) => atom.atom_id);
    const covered = evaluateDiscoveryLedgerAgreement(
      { targets: [{ target_id: "t-all", evidence_atom_ids: allAtomIds }] },
      ledger,
      evidence.atoms,
    );
    expect(covered.uncovered_clause_ids).toEqual([]);
    expect(covered.overlapping_clause_ids).toEqual([]);

    const empty = evaluateDiscoveryLedgerAgreement(
      { targets: [{ target_id: "t-empty", evidence_atom_ids: [] }] },
      ledger,
      evidence.atoms,
    );
    expect(empty.skip_reviewer).toBe(false);
    expect(empty.uncovered_clause_ids.length).toBeGreaterThan(0);
  });

  test("target coverage skip requires every extractable clause in the window", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const complete = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1", "4.2.2", "4.2.3"],
    });
    expect(complete.complete).toBe(true);
    expect(complete.gap_clause_ids).toEqual([]);

    const gapped = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1"],
      not_item_clause_ids: ["4.2.2"],
    });
    expect(gapped.complete).toBe(false);
    expect(gapped.gap_clause_ids).toContain("4.2.3");
  });

  test("refuses to claim coverage when the window holds no ledger clause at all", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const headingOnly = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.start_line + 1,
      source_clauses: [],
    });
    expect(headingOnly.required_clause_ids).toEqual([]);
    expect(headingOnly.vacuous).toBe(true);
    expect(headingOnly.complete).toBe(false);
  });

  test("treats items without a clause id and clause ids outside the ledger as unproven", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const unlabeled = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1", "4.2.2", "4.2.3", ""],
    });
    expect(unlabeled.gap_clause_ids).toEqual([]);
    expect(unlabeled.unlabeled_item_count).toBe(1);
    expect(unlabeled.complete).toBe(false);

    const hallucinated = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1", "4.2.2", "4.2.3", "9.9.9"],
    });
    expect(hallucinated.extra_clause_ids).toEqual(["9.9.9"]);
    expect(hallucinated.complete).toBe(false);
  });

  test("a section-level citation does not stand in for every clause under it", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const sectionOnly = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2"],
    });
    expect(sectionOnly.gap_clause_ids).toEqual(expect.arrayContaining(["4.2.1", "4.2.2", "4.2.3"]));
    expect(sectionOnly.complete).toBe(false);
  });

  test("resolveLedgerWindowForTarget uses section anchors, not shared chapter line spans", () => {
    const markdown = [
      "# 4 原材料及成品进场验收 [PDF p.12]",
      "## 4.2 铝合金材料 [PDF p.13]",
      "### 主控项目",
      "4.2.1 铝合金材料应符合设计要求。",
      "检查数量：全数检查。",
      "4.2.2 规格尺寸允许偏差应符合标准。",
      "检查数量：抽查。",
      "## 4.3 焊接材料 [PDF p.15]",
      "主控项目",
      "4.3.1 焊接材料应符合设计要求。",
      "检查数量：全数检查。",
      "## 4.4 紧固件 [PDF p.16]",
      "主控项目",
      "4.4.1 紧固件应符合设计要求。",
      "检查数量：全数检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "shared-span.md");
    const evidence = buildDocumentEvidence(markdown, "shared-span.md", 20_000);
    // 模拟坏行号：三个 target 都挂在章标题那一行（旧闸门会整章对账）
    const chapterLine = ledger.windows.find((window) => window.number === "4.2")!.start_line - 1;
    expect(ledgerWindowForLine(ledger, Math.max(1, chapterLine))?.number).not.toBe("4.3");

    const materials = resolveLedgerWindowForTarget(ledger, {
      name: "铝合金材料",
      materialization: {
        lot_basis_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 4.2 铝合金材料 [PDF p.13]" }],
      },
    }, evidence.atoms);
    const welding = resolveLedgerWindowForTarget(ledger, {
      name: "焊接材料",
      materialization: {
        lot_basis_fragments: [{ atom_id: evidence.atoms[0]!.atom_id, text: "## 4.3 焊接材料 [PDF p.15]" }],
      },
    }, evidence.atoms);
    const fasteners = resolveLedgerWindowForTarget(ledger, {
      name: "紧固件",
    }, evidence.atoms);

    expect(materials?.number).toBe("4.2");
    expect(welding?.number).toBe("4.3");
    expect(fasteners?.number).toBe("4.4");
    expect(materials?.extractable_clause_ids).toEqual(expect.arrayContaining(["4.2.1", "4.2.2"]));
    expect(welding?.extractable_clause_ids).toEqual(["4.3.1"]);
    // 显式 window_id 优先
    expect(resolveLedgerWindowForTarget(ledger, {
      name: "铝合金材料",
      ledger_window_id: welding!.window_id,
    })?.number).toBe("4.3");
  });

  test("incomplete gates always produce a ledger_gap coverage scope, never an empty full-review fallback", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const gapped = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1"],
      evidence: [
        { evidence_id: "ev:421", text: "4.2.1 铝合金材料的品种", locator: "line:41", clause_id: "4.2.1" },
        { evidence_id: "ev:422", text: "4.2.2 铝合金材料规格", locator: "line:47", clause_id: "4.2.2" },
      ],
    });
    expect(gapped.complete).toBe(false);
    expect(gapped.gap_evidence_ids).toEqual(expect.arrayContaining(["ev:422"]));
    const scope = coverageScopeFromLedgerGate({
      coverage: gapped,
      items: [
        { item_id: "item:a", source_clause: "4.2.1" },
        { item_id: "item:b", source_clause: "" },
      ],
    });
    expect(scope.mode).toBe("ledger_gap");
    expect(scope.gap_clause_ids).toEqual(expect.arrayContaining(["4.2.2", "4.2.3"]));
    expect(scope.affected_item_ids).toEqual(expect.arrayContaining(["item:b"]));

    const unlabeledOnly = evaluateTargetLedgerCoverage({
      ledger,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      source_clauses: ["4.2.1", "4.2.2", "4.2.3", ""],
    });
    const unlabeledScope = coverageScopeFromLedgerGate({
      coverage: unlabeledOnly,
      items: [
        { item_id: "item:ok", source_clause: "4.2.1" },
        { item_id: "item:blank", source_clause: "" },
      ],
      window_evidence_ids: ["ev:window"],
    });
    expect(unlabeledScope.mode).toBe("ledger_gap");
    expect(unlabeledScope.gap_clause_ids).toEqual([]);
    expect(unlabeledScope.affected_item_ids).toEqual(["item:blank"]);
    expect(unlabeledScope.affected_evidence_ids).toContain("ev:window");

    const contaminatedScope = coverageScopeFromLedgerGate({
      coverage: unlabeledOnly,
      items: [
        { item_id: "item:clean", source_clause: "4.2.1" },
        { item_id: "item:contaminated", source_clause: "4.2.2" },
      ],
      forced_item_ids: ["item:contaminated"],
    });
    expect(contaminatedScope.affected_item_ids).toEqual(["item:contaminated"]);
  });

  test("ledgerWindowForLine recovers the whole section window from a heading line", () => {
    const ledger = scanDocumentLedger(SAMPLE_50576, "sample.md");
    const window = ledger.windows.find((entry) => entry.number === "4.2")!;
    const resolved = ledgerWindowForLine(ledger, window.start_line);
    expect(resolved?.number).toBe("4.2");
    expect(resolved?.end_exclusive_line).toBe(window.end_exclusive_line);
    expect(resolved!.end_exclusive_line - resolved!.start_line).toBeGreaterThan(1);
    expect(ledgerWindowForLine(ledger, 1)).toBeUndefined();
  });

  test("duplicate section titles resolve by anchor line, not by name alone", () => {
    const markdown = [
      "# 4 设备进场 [PDF p.1]",
      "## 4.1 导轨 [PDF p.2]",
      "4.1.1 导轨品种应符合设计要求。",
      "检查数量：全数检查。",
      "检验方法：观察检查。",
      "# 5 设备安装 [PDF p.10]",
      "## 5.1 导轨 [PDF p.11]",
      "5.1.1 导轨安装应牢固。",
      "检查数量：全数检查。",
      "检验方法：观察检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "duplicate-title.md");
    const evidence = buildDocumentEvidence(markdown, "duplicate-title.md", 1_000);
    const registry = registryWithFullSourceSpans(
      evidence.evidence_fingerprint,
      evidence.atoms.map((atom) => ({
        source_id: atom.atom_id,
        evidence_id: atom.atom_id,
        atom_id: atom.atom_id,
        text: atom.text,
      })),
    );
    const prefilled = prefillDocumentSelectorsFromLedger("dup-title", evidence.atoms, ledger, registry);
    expect(prefilled.selectors.targets.filter((target) => target.name.includes("导轨"))).toHaveLength(2);
    expect(prefilled.selectors.dispositions).toEqual([]);
    expect(() => compileDocumentSelectors(prefilled.selectors, prefilled.registry, evidence, "dup-title")).toThrow(DocumentSelectorCompileError);
    // Explicit fixture review: both source sections are inspectable guide-rail targets.
    prefilled.selectors.dispositions = evidence.atoms.map(atom => ({
      atom_span_id: prefilled.registry.spans.find(span => span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length)!.span_id,
      disposition: "target", target_keys: prefilled.selectors.targets.map(target => target.key), reason: "人工确认本测试原文的两节导轨均为验收范围",
    }));
    const plan = compileDocumentSelectors(prefilled.selectors, prefilled.registry, evidence, "dup-title");
    const agreement = evaluateDiscoveryLedgerAgreement(plan, ledger, evidence.atoms);
    expect(agreement.overlapping_clause_ids).toEqual([]);
    expect(agreement.uncovered_clause_ids).toEqual([]);
    expect(agreement.skip_reviewer).toBe(true);
  });

  test("ledger completeness cannot compile or seal unreviewed discovery atoms", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../.tmp-tests", `ledger-skip-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const markdownPath = join(root, "source.md");
    await writeFile(markdownPath, SAMPLE_50576, "utf8");
    const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "ledger-job", markdownPath);
    const ledger = await workspace.readLedger();
    expect(ledger.windows.some((window) => window.number === "4.2")).toBe(true);
    const controller = await DocumentDiscoveryController.create(workspace, "candidate");
    const compiled = await controller.dispatch("compile_document_selectors", {});
    expect(compiled).toMatchObject({ ok: false });
    expect(JSON.stringify(compiled)).toContain("selector_atom_unreviewed");
    expect(await controller.sealCandidateWithoutReview()).toMatchObject({ ok: false });
  });

  // 平铺章（只有 8.0.x）里同章的几个检验批会拿到一模一样的取证窗口，
  // 各自的主证据装着别人的条文，覆盖复核挨个判 foreign clause，三方互相指责。
  // 形态取自 GB/T 50312 第 8 章：三个批分别举证 8.0.3 / 8.0.4 / 8.0.5，窗口同为 612-659。
  const FLAT_CHAPTER = [
    "# 8 系统测试",
    "",
    "8.0.1 综合布线工程电气测试应包括电缆布线系统电气性能测试及光纤布线系统性能测试。",
    "",
    "8.0.3 对绞电缆布线系统永久链路、CP 链路及信道测试应符合下列规定：",
    "",
    "1 综合布线工程应对每一个完工后的信息点进行永久链路测试。",
    "",
    "8.0.4 光纤布线系统性能测试应符合下列规定：",
    "",
    "1 光纤布线系统每条光纤链路均应测试。",
    "",
    "8.0.5 光纤到用户单元系统工程中，应检测用户接入点至用户单元信息配线箱之间的每一条光纤链路。",
    "",
    "8.0.7 布线系统各项测试结果应有详细记录，并应作为竣工资料的一部分。",
    "",
  ].join("\n");

  function flatChapterTargets(): {
    ledger: ReturnType<typeof scanDocumentLedger>;
    atoms: Array<{ atom_id: string; start_line: number; end_line: number; text: string }>;
    targets: Array<{
      name: string;
      evidence_fragments: Array<{ atom_id: string; text: string }>;
      start_line: number;
      end_exclusive_line: number;
    }>;
  } {
    const ledger = scanDocumentLedger(FLAT_CHAPTER, "GB_T_50312-flat.md");
    const lineCount = FLAT_CHAPTER.split("\n").length;
    // 一个原子装下整章，正是真实形态：范围只能取原子的行范围。
    const atoms = [{ atom_id: "atom:chapter8", start_line: 1, end_line: lineCount, text: FLAT_CHAPTER }];
    const quote = (needle: string): string =>
      FLAT_CHAPTER.split("\n").find((line) => line.startsWith(needle))!;
    const targets = [
      { name: "对绞电缆永久链路、CP链路及信道测试", clause: "8.0.3" },
      { name: "光纤布线系统性能测试", clause: "8.0.4" },
      { name: "光纤到用户单元光纤链路测试", clause: "8.0.5" },
    ].map((entry) => ({
      name: entry.name,
      evidence_fragments: [{ atom_id: "atom:chapter8", text: quote(entry.clause) }],
      start_line: 1,
      end_exclusive_line: lineCount + 1,
    }));
    return { ledger, atoms, targets };
  }

  test("partitions one shared flat-chapter window across the targets that anchor into it", () => {
    const { ledger, atoms, targets } = flatChapterTargets();
    const scopes = ledgerTargetPrimaryScopes(ledger, targets, atoms);
    expect(scopes.every((scope) => scope !== undefined)).toBe(true);

    // 互不重叠
    for (const [index, scope] of scopes.entries()) {
      for (const [otherIndex, other] of scopes.entries()) {
        if (index >= otherIndex || !scope || !other) continue;
        expect(scope.start_line >= other.end_exclusive_line || other.start_line >= scope.end_exclusive_line).toBe(true);
      }
    }

    // 每条条文恰好归一个目标，一条不漏
    for (const clause of ledger.clauses) {
      const owners = scopes.filter((scope) =>
        scope && clause.line >= scope.start_line && clause.line < scope.end_exclusive_line
      );
      expect(owners).toHaveLength(1);
    }

    // 各自的锚点条文落在自己名下
    const clauseLine = (clauseId: string): number =>
      ledger.clauses.find((clause) => clause.clause_id === clauseId)!.line;
    for (const [index, clauseId] of ["8.0.3", "8.0.4", "8.0.5"].entries()) {
      const scope = scopes[index]!;
      expect(clauseLine(clauseId)).toBeGreaterThanOrEqual(scope.start_line);
      expect(clauseLine(clauseId)).toBeLessThan(scope.end_exclusive_line);
    }
  });

  test("leaves a target whose fragments anchor nowhere for the caller to fall back", () => {
    const { ledger, atoms, targets } = flatChapterTargets();
    const stray = {
      name: "锚不到的目标",
      evidence_fragments: [{ atom_id: "atom:missing", text: "不存在的引文" }],
      start_line: 1,
      end_exclusive_line: 99,
    };
    const scopes = ledgerTargetPrimaryScopes(ledger, [...targets, stray], atoms);
    expect(scopes.at(-1)).toBeUndefined();
  });
});


test("ledger patterns never assign irrelevant or context to unmatched source", () => {
  const markdown = "# 1 总则\n材料到场时逐件核对牌号。\n# 4 主体\n## 4.1 安装\n4.1.1 连接应牢固。\n检查数量：全数检查。\n# 5 补充\n支座不得松动。";
  const evidence = buildDocumentEvidence(markdown,"unmatched.md");
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint,evidence.atoms.map(atom => ({source_id:atom.atom_id,evidence_id:atom.atom_id,atom_id:atom.atom_id,text:atom.text})));
  const seeded = prefillDocumentSelectorsFromLedger("pending",evidence.atoms,scanDocumentLedger(markdown,"unmatched.md"),registry);
  expect(seeded.selectors.targets.length).toBeGreaterThan(0);
  expect(seeded.selectors.dispositions).toEqual([]);
  expect(seeded.selectors.contexts).toEqual([]);
  expect(() => compileDocumentSelectors(seeded.selectors,seeded.registry,evidence,"pending")).toThrow(DocumentSelectorCompileError);
});

test("candidate window crossings need semantic review while silent omissions remain blocked", () => {
  const markdown = [
    "# 4 电梯安装工程",
    "## 4.1 设备进场验收",
    "4.1.1 设备应符合设计要求。",
    "检查数量：全数检查。",
    "## 4.2 土建交接检验",
    "4.2.1 土建交接检验应符合本规范第 3.2 节的规定。",
  ].join("\n");
  const evidence = buildDocumentEvidence(markdown, "split-boundary.md");
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map(atom => ({
    source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
  })));
  const ledger = scanDocumentLedger(markdown, "split-boundary.md");
  const windows = discoveryScopeWindows(ledger);
  expect(windows.map(window => window.number)).toEqual(["4.1", "4.2"]);
  const prefilled = prefillDocumentSelectorsFromLedger("split-boundary", evidence.atoms, ledger, registry);
  expect(prefilled.selectors.targets.map(target => target.name)).toEqual(["设备进场验收", "土建交接检验"]);

  const fullAtomSpan = prefilled.registry.spans.find(span =>
    span.atom_id === evidence.atoms[0]!.atom_id && span.start === 0 && span.end === evidence.atoms[0]!.text.length
  )!;
  const coarse = structuredClone(prefilled.selectors);
  coarse.targets = [{
    ...coarse.targets[0]!,
    key: "chapter:4",
    name: "电梯安装工程",
    source_blocks: [{
      kind: "heading_section",
      anchor_span_id: fullAtomSpan.span_id,
      start_span_id: fullAtomSpan.span_id,
      end_span_id: fullAtomSpan.span_id,
      reason: "错误地把同章全部内容合成一个目标",
    }],
  }];
  coarse.dispositions = [{ atom_span_id: fullAtomSpan.span_id, disposition: "target", target_keys: ["chapter:4"], reason: "测试" }];
  // The compiler cannot decide whether this chapter-sized scope is a semantic merge error.
  // Preserve the exact candidate windows for the mandatory independent LLM review.
  const coarsePlan = compileDocumentSelectors(coarse, prefilled.registry, evidence, "split-boundary", { discoveryScopeCandidates: windows });
  expect(discoveryScopeReviewHints(coarsePlan, coarse, evidence, windows)).toMatchObject([{
    target: { key: "chapter:4" },
    candidate_windows: [{ number: "4.1" }, { number: "4.2" }],
    next_tools: expect.arrayContaining(["open_document_atom", "edit_document_selectors"]),
  }]);

  const omitted = structuredClone(prefilled.selectors);
  omitted.targets = [omitted.targets[0]!];
  omitted.dispositions = [{ atom_span_id: fullAtomSpan.span_id, disposition: "target", target_keys: [omitted.targets[0]!.key], reason: "测试" }];
  try {
    compileDocumentSelectors(omitted, prefilled.registry, evidence, "split-boundary", { discoveryScopeCandidates: windows });
    throw new Error("expected compile failure");
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentSelectorCompileError);
    expect((error as DocumentSelectorCompileError).issues.map(issue => issue.code)).toContain("selector_discovery_window_unclassified");
  }

  omitted.contexts = [{
    key: "context:4.2",
    role: "governing_rule",
    name: "土建交接引用规则",
    span_ids: [...prefilled.selectors.targets[1]!.lot_basis_span_ids],
    reason: "测试中明确把该窗口归为引用规则",
  }];
  expect(() => compileDocumentSelectors(
    omitted,
    prefilled.registry,
    evidence,
    "split-boundary",
    { discoveryScopeCandidates: windows },
  )).not.toThrow();
});
