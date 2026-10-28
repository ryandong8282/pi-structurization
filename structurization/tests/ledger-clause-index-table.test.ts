import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ledgerRequiredClausePredicate,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { prefillTargetSelectorsFromLedger } from "../src/ledger-target-selectors.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";

// Optional local standard documents belong to the consuming application.
const repoRoot = resolve(process.env.PDF_EX_CODEX_ROOT ?? process.cwd());
const gb50339 = resolve(repoRoot, "markdown/13_GB_50339-2013_智能建筑工程质量验收规范.md");

/**
 * 有些规范在附录里给出逐子分部的记录表，表中一列直接写着每个验收项目对应的条文号
 * （GB 50339 附录 C：`主控项目 | 接口功能 | 4.0.4`）。那是文档自己给出的
 * 「哪些条文是验收项目」的权威答案。
 *
 * 不认表头措辞，只认内容：某一列里至少两个格子是本文档真实存在的条文号。
 * 认表头是踩过三次的坑——「本标准表 X」漏掉「本规范表」、「检查数量」漏掉
 * 「各接口均应检测」、「验收记录」漏掉「检测记录」。
 */
describe("文档自身索引表点名的条文", () => {
  test.skipIf(!existsSync(gb50339))("GB 50339 的必抽集由附录记录表补齐，且与逐条人工判定一致", async () => {
    const markdown = (await readFile(gb50339, "utf8")).replace(/\r\n?/g, "\n");
    const ledger = scanDocumentLedger(markdown, "GB_50339-2013.md");

    // 这本书全书只有 3 条写了「检查数量」这类词样，其余把同一件事写成
    // 「各接口均应检测」「应逐项检测」，措辞判据一概认不出。
    const withoutIndex = ledger.clauses.filter(
      ledgerRequiredClausePredicate({ ...ledger, indexed_clauses: [] }),
    );
    expect(withoutIndex).toHaveLength(3);

    const required = ledger.clauses
      .filter(ledgerRequiredClausePredicate(ledger))
      .map((clause) => clause.clause_id);
    expect(required.length).toBeGreaterThan(80);

    // 第 4 章：附录表列的是 4.0.4~4.0.12，恰好排除范围规定(4.0.1)、时序规定(4.0.2)、
    // 检测方法(4.0.3)和资料要求(4.0.13)。
    expect(required.filter((clauseId) => clauseId.startsWith("4."))).toEqual([
      "4.0.4",
      "4.0.5",
      "4.0.6",
      "4.0.7",
      "4.0.8",
      "4.0.9",
      "4.0.10",
      "4.0.11",
      "4.0.12",
    ]);

    // 附录条文本身仍然不是验收项目——索引表只用来点名它指向的正文条文。
    expect(required.some((clauseId) => /^[A-Za-z]\./.test(clauseId))).toBe(false);
  });

  test("表里的数值不会被当成条文号", () => {
    // 允许偏差表里满是 `2.0`、`1.5` 这种数字，形状与条文号无异；
    // 判据要求「必须是本文档真实存在的条文号」，它们自然落选。
    const markdown = [
      "# 5.2 找平层",
      "",
      "5.2.1 找平层表面平整度应符合要求。",
      "",
      "检查数量：全数检查。",
      "",
      "表 5.2.1 允许偏差",
      "",
      "<table><tr><td>项目</td><td>允许偏差</td><td>检验方法</td></tr>"
        + "<tr><td>表面平整度</td><td>5.0</td><td>靠尺检查</td></tr>"
        + "<tr><td>标高</td><td>2.0</td><td>水准仪</td></tr>"
        + "<tr><td>厚度</td><td>3.0</td><td>钢尺量</td></tr></table>",
      "",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "values.md");
    expect(ledger.indexed_clauses ?? []).toEqual([]);
  });

  test("一列里只出现一次条文号不算索引表", () => {
    // 单次命中可能是正文表格顺带提了一句，不足以判定这一列是条文索引。
    const markdown = [
      "# 6.3 管道安装",
      "",
      "6.3.1 管道安装应符合要求。",
      "",
      "检查数量：全数检查。",
      "",
      "6.3.2 支架间距应符合要求。",
      "",
      "检查数量：全数检查。",
      "",
      "<table><tr><td>说明</td><td>依据</td></tr>"
        + "<tr><td>本表引自</td><td>6.3.1</td></tr></table>",
      "",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "single.md");
    expect(ledger.indexed_clauses ?? []).toEqual([]);
  });

  test("索引表点名的条文进必抽集，同章没点名的不进", () => {
    const markdown = [
      "# 4 智能化集成系统",
      "",
      "4.0.1 检测和验收范围应根据设计要求确定。",
      "4.0.2 接口功能应符合接口技术文件的要求，各接口均应检测。",
      "4.0.3 权限管理功能检测应符合设计要求。",
      "",
      "# 附录 C 检测记录",
      "",
      "表 C.0.2 智能化集成系统子分部工程检测记录",
      "",
      "<table><tr><td>项</td><td>检测内容</td><td>规范条款</td></tr>"
        + "<tr><td>主控项目</td><td>接口功能</td><td>4.0.2</td></tr>"
        + "<tr><td>一般项目</td><td>权限管理功能</td><td>4.0.3</td></tr></table>",
      "",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "index.md");
    // 表里同一行印着的主控/一般与项目名一并带回——这两样在这类书的正文里拿不到。
    expect(ledger.indexed_clauses).toEqual([
      { clause_id: "4.0.2", item_name: "接口功能", column: "主控项目" },
      { clause_id: "4.0.3", item_name: "权限管理功能", column: "一般项目" },
    ]);
    expect(ledger.clauses.find((clause) => clause.clause_id === "4.0.2")?.column)
      .toBe("主控项目");

    const required = ledger.clauses
      .filter(ledgerRequiredClausePredicate(ledger))
      .map((clause) => clause.clause_id);
    expect(required).toEqual(["4.0.2", "4.0.3"]);
  });
  test.skipIf(!existsSync(gb50339))("索引表的项目名与主控/一般进入 prefill 草稿——抽取端的起点", async () => {
    const markdown = (await readFile(gb50339, "utf8")).replace(/\r\n?/g, "\n");
    const ledger = scanDocumentLedger(markdown, "GB_50339-2013.md");
    const window = ledger.windows.find((entry) => entry.window_id === "window:4")!;
    const lines = markdown.split("\n");
    const text = lines.slice(window.start_line - 1, window.end_exclusive_line - 1).join("\n");
    const evidenceId = "atom:window-4";
    const manifest: EvidenceManifest = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      job_id: "job:index-table",
      target_id: "target:index-table",
      source: {
        adapter: "document-domain-agent/v1",
        file_name: "GB_50339-2013.md",
        sha256: sha256Text(markdown),
        semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
      },
      scope: {
        schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
        mode: "agent_discovered",
        target_id: "target:index-table",
        source_line_count: lines.length,
        selected_start_line: window.start_line,
        selected_end_exclusive_line: window.end_exclusive_line,
        selected_heading: window.title,
        selection_reason: "index table fixture",
        selected_atom_ids: [evidenceId],
        target_evidence_fragments: [{ atom_id: evidenceId, text }],
        candidates: [],
      },
      evidence: [{
        evidence_id: evidenceId,
        kind: "paragraph",
        role: "supporting_clause",
        locator: `line:${window.start_line}`,
        text,
        text_sha256: sha256Text(text),
        requires_disposition: true,
        evidence_scope: "primary",
      }],
      table_fragments: [],
      reference_occurrences: [],
      evidence_fingerprint: sha256Text(text),
    };
    const registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const prefill = prefillTargetSelectorsFromLedger({
      ledger,
      markdown,
      manifest,
      registry,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
    });

    // 名字取自索引表（标准自己整理好的短名），不是从条文正文里截短；
    // 主控/一般来自回填到 clause.column 的索引表栏目，不再全默认成主控项目。
    expect(prefill.selectors.items.map((item) => [item.category, item.name])).toEqual([
      ["主控项目", "接口功能"],
      ["主控项目", "集中监视、储存和统计功能"],
      ["主控项目", "报警监视及处理功能"],
      ["主控项目", "控制和调节功能"],
      ["主控项目", "联动配置及管理功能"],
      ["主控项目", "权限管理功能"],
      ["主控项目", "冗余功能"],
      ["一般项目", "文件报表生成和打印功能"],
      ["一般项目", "数据分析功能"],
    ]);

    // 没有索引表时的旧形态：只认出 2 条，名字是截断的条文残句，栏目全默认主控。
    const bare = prefillTargetSelectorsFromLedger({
      ledger: {
        ...ledger,
        indexed_clauses: [],
        clauses: ledger.clauses.map((clause) => ({ ...clause, column: undefined })),
      },
      markdown,
      manifest,
      registry,
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
    });
    expect(bare.selectors.items).toHaveLength(2);
    expect(bare.selectors.items[0]!.name).not.toBe("接口功能");
  });
});
