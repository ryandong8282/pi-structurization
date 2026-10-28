import { describe, expect, test } from "vitest";

import { scanDocumentLedger } from "../src/document-ledger.js";
import {
  formatLedgerReconciliation,
  reconcileLedgerCoverage,
} from "../src/ledger-reconciliation.js";
import { safeJoinDisplayFragments } from "../src/semantic-decision-compiler.js";

const MARKDOWN = [
  "# 4 原材料及成品进场验收",
  "## 4.2 铝合金材料",
  "主控项目",
  "4.2.1 铝合金材料的品种、规格、性能应符合设计文件要求。",
  "检查数量：全数检查。",
  "检验方法：检查质量证明文件。",
  "4.2.2 铝合金材料规格尺寸允许偏差应符合表 A.0.2 的规定。",
  "检查数量：每种规格抽查不少于1处。",
  "检验方法：用钢尺测量。",
  "# 附录 A 铝合金焊缝允许偏差",
  "表 A.0.2 焊缝尺寸允许偏差",
  "<table><tr><td>项目</td><td>允许偏差</td></tr></table>",
].join("\n");

const ledger = scanDocumentLedger(MARKDOWN, "reconcile.md");

function item(overrides: Record<string, unknown> = {}) {
  return {
    source_clause: "4.2.1",
    name: "铝合金材料品种、规格、性能",
    requirement: "铝合金材料的品种、规格、性能应符合设计文件要求。",
    method: "检查质量证明文件。",
    table_semantics: null,
    ...overrides,
  };
}

describe("ledger reconciliation", () => {
  test("passes every identity when both quantity clauses are represented", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [
        item(),
        item({
          source_clause: "4.2.2",
          requirement: "铝合金材料规格尺寸允许偏差应符合表 A.0.2 的规定。",
        }),
      ],
    });
    expect(report.required_clause_count).toBe(2);
    expect(report.item_count).toBe(2);
    expect(report.missing_clause_ids).toEqual([]);
    expect(report.extra_clause_ids).toEqual([]);
    expect(report.unresolved_table_refs).toEqual([]);
    expect(report.table_reference_count).toBe(1);
    expect(report.ok).toBe(true);
  });

  test("reports the clauses that never made it into the result", () => {
    const report = reconcileLedgerCoverage({ ledger, items: [item()] });
    expect(report.missing_clause_ids).toEqual(["4.2.2"]);
    expect(report.covered_required_clause_count).toBe(1);
    expect(report.clause_identity_ok).toBe(false);
    expect(report.item_count_ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("counts a non-item reference placeholder parent as accounted without inventing an item", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [item()],
      accounted_clause_ids: ["4.2.2"],
    });
    expect(report.item_count).toBe(1);
    expect(report.missing_clause_ids).toEqual([]);
    expect(report.covered_required_clause_count).toBe(2);
    expect(report.item_count_ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("reports clause ids that exist nowhere in the ledger", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [item(), item({ source_clause: "4.2.2" }), item({ source_clause: "9.9.9" })],
    });
    expect(report.extra_clause_ids).toEqual(["9.9.9"]);
    expect(report.hallucination_ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("backfills the clause id from the verbatim requirement text", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [
        item(),
        item({
          source_clause: "",
          requirement: "4.2.2 铝合金材料规格尺寸允许偏差应符合表 A.0.2 的规定。",
        }),
      ],
    });
    expect(report.derived_clause_count).toBe(1);
    expect(report.labeled_item_count).toBe(2);
    expect(report.missing_clause_ids).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("never backfills a clause id the ledger has never seen", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [item(), item({ source_clause: "4.2.2" }), item({
        source_clause: "",
        requirement: "9.9.9 这条条文号不在底账里。",
      })],
    });
    expect(report.derived_clause_count).toBe(0);
    expect(report.unlabeled_item_count).toBe(1);
    expect(report.extra_clause_ids).toEqual([]);
    expect(report.item_count_ok).toBe(false);
  });

  test("counts items that carry no clause id at all", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [item(), item({ source_clause: "4.2.2" }), item({ source_clause: "" })],
    });
    expect(report.unlabeled_item_count).toBe(1);
    expect(report.labeled_item_count).toBe(2);
    expect(report.item_count_ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("flags table references that resolve to no captioned table", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [
        item(),
        item({
          source_clause: "4.2.2",
          requirement: "允许偏差应符合表 H.0.10 的规定。",
          table_semantics: { table_no: "表 H.0.10" },
        }),
      ],
    });
    expect(report.unresolved_table_refs).toEqual(["H.0.10"]);
    expect(report.table_identity_ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("does not join a method's trailing 表 to a clause number on the next line", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [
        item(),
        item({
          source_clause: "4.2.2",
          requirement: "允许偏差应符合表 A.0.2 的规定。",
          method: "查看记录表\n4.2.1 材料进场时应检查证明文件。",
        }),
      ],
    });
    expect(report.table_reference_count).toBe(1);
    expect(report.unresolved_table_refs).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("explains exact table identity failures without guessing damaged source numbers", () => {
    const damaged = scanDocumentLedger([
      "1.1.1 检验应符合表 A.0.7 的规定。", "检查数量：全数检查。",
      "表 A.0.X 检验要求", "<table><tr><td>项目</td><td>要求</td></tr></table>",
      "表 A.0.7-1 分表要求", "<table><tr><td>项目</td></tr></table>",
    ].join("\n"), "damaged-captions.md");
    const items = Array.from({ length: 8 }, (_, index) => ({
      item_id: `item-${index}`, target_id: "target-sample", author_item_key: `author-${index}`, source_clause: "1.1.1",
      name: "检验属性", requirement: "应符合表 A.0.7 的规定。",
    }));
    const inputs = JSON.stringify({ damaged, items });
    const report = reconcileLedgerCoverage({ ledger: damaged, items });
    expect(report.unresolved_table_refs).toEqual(["A.0.7"]);
    expect(report.ok).toBe(false);
    const diagnostic = report.table_reference_diagnostics![0]!;
    expect(diagnostic.actual).toEqual({ matching_caption_count: 0, affected_item_count: 8, source_clause_occurrence_count: 1 });
    expect(diagnostic.expected.matching_caption_count).toBe("at_least_one_exact_identity");
    expect(diagnostic.affected_records).toHaveLength(6);
    expect(diagnostic.affected_records_complete).toBe(false);
    expect(diagnostic.affected_records[0]).toMatchObject({ item_id: "item-0", target_id: "target-sample",
      source_clause: "1.1.1", field: "requirement", raw_reference: "表 A.0.7" });
    expect(diagnostic.affected_records[0]!.record_read).toEqual({ tool: "read_target_selectors", arguments: { collection: "items", key: "author-0" } });
    expect(diagnostic.source_clauses).toEqual([{ clause_id: "1.1.1", ledger_line: 1, text: "1.1.1 检验应符合表 A.0.7 的规定。" }]);
    expect(JSON.stringify({ damaged, items })).toBe(inputs);
  });

  test("does not label an output-only table reference as a source occurrence", () => {
    const report = reconcileLedgerCoverage({ ledger, items: [item(), item({ source_clause: "4.2.2", requirement: "应符合表 Z.9.9 的规定。" })] });
    expect(report.unresolved_table_refs).toEqual(["Z.9.9"]);
    expect(report.table_reference_diagnostics![0]!.actual.source_clause_occurrence_count).toBe(0);
    expect(report.table_reference_diagnostics![0]!.source_clauses).toEqual([]);
    expect(report.ok).toBe(false);
  });

  test("reports the original structured table value without inventing a table marker", () => {
    const report = reconcileLedgerCoverage({ ledger, items: [item(), item({ source_clause: "4.2.2", table_semantics: { table_no: "Z.9.9 检验要求" } })] });
    expect(report.table_reference_diagnostics![0]!.affected_records[0]).toMatchObject({ field: "table_semantics.table_no", raw_reference: "Z.9.9" });
    expect(report.unresolved_table_refs).toEqual(["Z.9.9"]);
    expect(report.ok).toBe(false);
  });

  test("reports not-applicable instead of failure when the ledger found no clause", () => {
    const empty = scanDocumentLedger("# 某个不是验收规范的文档\n正文一句话。", "empty.md");
    const report = reconcileLedgerCoverage({
      ledger: empty,
      items: [item({ source_clause: "" })],
    });
    expect(report.applicable).toBe(false);
    expect(report.ok).toBe(true);
    expect(formatLedgerReconciliation(report)).toContain("不适用");
  });

  test("skips the table identity when the ledger predates the caption inventory", () => {
    const legacy = { ...ledger, tables: undefined };
    const report = reconcileLedgerCoverage({
      ledger: legacy,
      items: [
        item(),
        item({ source_clause: "4.2.2", requirement: "应符合表 Z.9.9 的规定。" }),
      ],
    });
    expect(report.unresolved_table_refs).toEqual([]);
    expect(report.table_identity_ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("strictly rejects non-existent table numbers even if they share a prefix with a known table", () => {
    const report = reconcileLedgerCoverage({
      ledger,
      items: [
        item({
          source_clause: "4.2.2",
          requirement: "应符合表 A.0.20 和表 A.0.299 的规定。",
        }),
      ],
    });
    expect(report.unresolved_table_refs).toEqual(["A.0.20", "A.0.299"]);
    expect(report.table_identity_ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("safeJoinDisplayFragments prevents boundary token fusion when separator is empty", () => {
    const joined = safeJoinDisplayFragments(
      [
        { text: "本标准表5.1.2" },
        { text: "5.10.4 钢桩施工质量检验标准应符合本标准表 5.1.2、表 5.10.4 的规定。" },
      ],
      "",
    );
    expect(joined).toBe(
      "本标准表5.1.2 5.10.4 钢桩施工质量检验标准应符合本标准表 5.1.2、表 5.10.4 的规定。",
    );
  });
});
