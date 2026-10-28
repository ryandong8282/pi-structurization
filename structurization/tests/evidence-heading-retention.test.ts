import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import { buildGranularProseCoverageEvidence, buildStructuredTargetEvidence } from "../src/evidence.js";
import { compiledUnhandledEvidenceIds } from "../src/evidence-disposition-coverage.js";

describe("granular prose evidence heading retention", () => {
  test.each([
    "12.2.1 接口安装后应检验密封性。",
    "12.2.1 Inspect the seal after assembly.",
    "The supplier's instructions apply during installation.",
  ])("a formal table does not silently waive accounting for adjacent prose: %s", (prose) => {
    const table = "表 12.2.2 尺寸检验\n<table><tr><td>项</td><td>序</td><td>检查项目</td><td>允许值</td><td>检查方法</td></tr><tr><td>主控项目</td><td>1</td><td>长度</td><td>设计值</td><td>尺量</td></tr></table>";
    for (const withTable of [false, true]) {
      const markdown = ["# Assembly", "", prose, "", ...(withTable ? [table] : [])].join("\n");
      const { evidence } = buildStructuredTargetEvidence(markdown, sha256Text(markdown),
        [{ start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 }], false, new Set([1]));
      const body = evidence.find((record) => record.text === prose)!;
      expect(body).toMatchObject({ evidence_scope: "primary", requires_disposition: true });
      expect(evidence.find((record) => record.text === "# Assembly")?.requires_disposition).toBe(false);
      const accounted = evidence.filter((record) => record.evidence_id !== body.evidence_id)
        .map((record) => ({ evidence_id: record.evidence_id }));
      expect(compiledUnhandledEvidenceIds({ evidence_dispositions: accounted }, evidence)).toEqual([body.evidence_id]);
      // No predetermined business meaning: an explicit semantic disposition is
      // sufficient accounting; the source need not become an acceptance item.
      expect(compiledUnhandledEvidenceIds({ evidence_dispositions: [...accounted, { evidence_id: body.evidence_id }] }, evidence)).toEqual([]);
    }
  });

  test("keeps navigation and clause-like Markdown headings as citable context", () => {
    const markdown = [
      "# 3 Fabrication",
      "## 3.2 Assembly",
      "### Project requirements",
      "## 3.2.7 Finished nodes shall be free from visible defects.",
      "Inspection sample: five units per batch.",
      "Inspection method: visual examination.",
    ].join("\n");

    const evidence = buildGranularProseCoverageEvidence(
      markdown,
      sha256Text(markdown),
      [{ start_line: 1, end_exclusive_line: 7 }],
    );

    expect(evidence.map((record) => ({
      locator: record.locator,
      kind: record.kind,
      role: record.role,
      text: record.text,
      requires_disposition: record.requires_disposition,
    }))).toEqual([
      {
        locator: "line:1",
        kind: "heading",
        role: "context",
        text: "# 3 Fabrication",
        requires_disposition: false,
      },
      {
        locator: "line:2",
        kind: "heading",
        role: "context",
        text: "## 3.2 Assembly",
        requires_disposition: false,
      },
      {
        locator: "line:3",
        kind: "heading",
        role: "context",
        text: "### Project requirements",
        requires_disposition: false,
      },
      {
        locator: "line:4",
        kind: "paragraph",
        role: "supporting_clause",
        text: "3.2.7 Finished nodes shall be free from visible defects.",
        requires_disposition: false,
      },
      {
        locator: "line:5",
        kind: "paragraph",
        role: "context",
        text: "Inspection sample: five units per batch.",
        requires_disposition: false,
      },
      {
        locator: "line:6",
        kind: "paragraph",
        role: "context",
        text: "Inspection method: visual examination.",
        requires_disposition: false,
      },
    ]);
  });

  test("unlearned heading typography stays neutral across languages and parser routes", () => {
    const markdown = [
      "7.8.9 The housing shall remain sealed.",
      "## Sampling: two units from each delivery. [PDF p.12]",
      "### 验证操作：浸水后观察。",
      "## Prüfverfahren: Sichtprüfung.",
      "## Supporting documentation",
    ].join("\n");
    const windows = [{ start_line: 1, end_exclusive_line: 6 }];
    const hash = sha256Text(markdown);
    const granular = buildGranularProseCoverageEvidence(markdown, hash, windows);
    const structured = buildStructuredTargetEvidence(markdown, hash, windows, false);
    for (const records of [granular, structured.evidence]) {
      for (const line of [2, 3, 4, 5]) {
        expect(records.find(record => record.locator === `line:${line}`)).toMatchObject({ kind: "heading", role: "context" });
      }
    }
    expect(structured.evidence.find(record => record.locator === "line:2")?.requires_disposition).toBe(true);
    expect(granular.find(record => record.locator === "line:2")).toMatchObject({
      clause_id: "7.8.9", text: markdown.split("\n")[1],
    });
    // Semantic classification comes from the learned profile, not vocabulary.
    for (const records of [
      buildGranularProseCoverageEvidence(markdown, hash, windows, { structuralHeadingLines: new Set([5]) }),
      buildStructuredTargetEvidence(markdown, hash, windows, false, new Set([5])).evidence,
    ]) expect(records.find(record => record.locator === "line:5")).toMatchObject({ kind: "heading", role: "section_heading" });
    expect(buildStructuredTargetEvidence(markdown, hash, windows, false, new Set([5])).evidence
      .find(record => record.locator === "line:5")?.requires_disposition).toBe(false);
  });
});
