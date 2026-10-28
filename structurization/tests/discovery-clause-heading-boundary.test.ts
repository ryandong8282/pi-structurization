import { describe, expect, test } from "vitest";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { bindDiscoverySources } from "../src/discovery-source-bindings.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";

function fixture(source: string) {
  const evidence = buildDocumentEvidence(source, "source.md");
  const ledger = scanDocumentLedger(source, "source.md");
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint,
    evidence.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })));
  const opened = new Set(evidence.atoms.map(atom => atom.atom_id));
  return { evidence, ledger, registry, opened };
}

describe("physical clause boundaries at witnessed plain section headings", () => {
  test.each([
    ["4.2.4", "4.3", "砂和砂石地基", "1"],
    ["4.3.4", "4.4", "土工合成材料地基", "4"],
    ["4.7.4", "4.8", "预压地基", "1"],
    ["5.6.5", "5.7", "干作业成孔灌注桩", "1"],
    ["6.4.3", "6.5", "盐渍土", "1"],
  ])("%s retains its entire table but not the following unmarked %s heading", (clauseId, section, title, child) => {
    const lines = [
      `# ${clauseId!.split(".")[0]} 地基基础工程`,
      `${clauseId} 质量检验标准应符合表 ${clauseId} 的规定。`, "",
      `表 ${clauseId} 质量检验标准`, "",
      "<table>", "<tr><td>检查项目</td><td>允许值</td></tr>",
      "<tr><td>承载力</td><td>应符合设计要求</td></tr>", "</table>", "",
      `${section} ${title}`, "", `${section}.${child} 施工前应检查原材料质量。`, "",
    ];
    const source = lines.join("\n");
    const f = fixture(source);
    const headingLine = lines.indexOf(`${section} ${title}`) + 1;
    expect(f.ledger.headings).toContainEqual(expect.objectContaining({ line: headingLine, number: section, title }));
    const clause = f.ledger.clauses.find(entry => entry.clause_id === clauseId)!;
    expect(clause.end_exclusive_line).toBe(headingLine);
    const bound = bindDiscoverySources([{ key: "criterion", start_line: clause.line, extent: "clause" }],
      f.evidence, f.ledger, f.opened, f.registry);
    const text = bound.aliases.get("criterion")!.span_ids.map(id => {
      const span = bound.registry.spans.find(entry => entry.span_id === id)!;
      return f.evidence.atoms.find(atom => atom.atom_id === span.atom_id)!.text.slice(span.start, span.end);
    }).join("");
    expect(text).toBe(lines.slice(clause.line - 1, headingLine - 1).join("\n") + "\n");
    expect(text).toContain("<tr><td>承载力</td><td>应符合设计要求</td></tr>\n</table>");
    expect(text).not.toContain(`${section} ${title}`);
    try {
      bindDiscoverySources([{ key: "shortened", start_line: clause.line,
        end_exclusive_line: headingLine - 2, extent: "clause" }], f.evidence, f.ledger, f.opened, f.registry);
      expect.fail("A shortened physical clause must still be rejected");
    } catch (error) {
      expect(error).toMatchObject({ issues: [expect.objectContaining({ code: "discovery_clause_address_invalid" })] });
    }
  });

  test("numeric body lines and real clause content do not become section boundaries without a matching child", () => {
    const source = ["# 4 地基工程", "4.2.4 检查项目应符合下列要求。", "4.3 配合比的记录值。",
      "其余项目应同时满足设计要求。", "4.2.5 下一真实条文应完整保留。", "4.4 非匹配编号行",
      "4.2.6 仍属于同一节的条文。"].join("\n");
    const f = fixture(source);
    expect(f.ledger.headings.map(heading => heading.number)).toEqual(["4"]);
    expect(f.ledger.clauses.map(clause => [clause.clause_id, clause.line, clause.end_exclusive_line]))
      .toEqual([["4.2.4", 2, 5], ["4.2.5", 5, 7], ["4.2.6", 7, 8]]);
  });

  test("a section-and-child-shaped pair inside an HTML table never splits the owning clause", () => {
    const lines = ["# 4 地基工程", "4.2.4 检查项目应符合表4.2.4的规定。", "<table><tr><td>",
      "4.3 表格中的编号内容", "4.3.1 表格中的示例条号", "</td></tr></table>", "",
      "4.3 砂和砂石地基", "4.3.1 原材料应满足设计要求。"];
    const f = fixture(lines.join("\n"));
    expect(f.ledger.headings.filter(heading => heading.number === "4.3")).toEqual([
      expect.objectContaining({ line: 8, title: "砂和砂石地基" }),
    ]);
    expect(f.ledger.clauses.find(clause => clause.clause_id === "4.2.4")?.end_exclusive_line).toBe(8);
    expect(f.ledger.clauses.find(clause => clause.clause_id === "4.3.1")?.line).toBe(9);
  });

  test("blank-line and full-width punctuation noise keeps the witnessed physical boundary", () => {
    const f = fixture("# 4 地基工程\r\n4.2.4 地基应满足设计要求。\r\n\r\n \t4 ． 3\t砂和砂石地基 \r\n \t\r\n4.3.4 原材料应检验合格。\r\n");
    expect(f.ledger.headings).toContainEqual(expect.objectContaining({ line: 4, number: "4.3" }));
    expect(f.ledger.clauses.find(clause => clause.clause_id === "4.2.4")?.end_exclusive_line).toBe(4);
  });

  test("an intervening list item cannot witness a preceding numeric line as a section heading", () => {
    const f = fixture("# 4 地基工程\n4.2.4 检验应满足下列要求。\n4.3 数字记录行\n1 检查材料\n2 检查厚度\n4.3.1 下一条文。");
    expect(f.ledger.headings.map(heading => heading.number)).toEqual(["4"]);
    expect(f.ledger.clauses.find(clause => clause.clause_id === "4.2.4")?.end_exclusive_line).toBe(6);
  });
});
