import { describe, expect, test } from "vitest";

import {
  evaluateDiscoveryLedgerAgreement,
  scanDocumentLedger,
  type LedgerAtomRef,
} from "../src/document-ledger.js";

describe("discovery ledger source ranges", () => {
  test("does not assign a required clause when primary evidence only reaches its opening line", () => {
    const markdown = [
      "# 4 原材料及成品进场验收",
      "## 4.2 构配件",
      "4.2.1 第一项应符合设计要求。",
      "检查数量：全数检查。",
      "检验方法：观察检查。",
      "4.2.2 第二项应符合设计要求。",
      "尚应核对完整的技术资料。",
      "检查数量：全数检查。",
      "检验方法：观察检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "partial-clause.md");
    const atom: LedgerAtomRef = {
      atom_id: "atom:fixture",
      start_line: 1,
      end_line: markdown.split("\n").length,
      text: markdown,
    };
    const secondOpening = "4.2.2 第二项应符合设计要求。";
    const partialEnd = atom.text.indexOf(secondOpening) + secondOpening.length;
    const target = (end: number) => ({
      target_id: "t-inspection",
      evidence_atom_ids: [atom.atom_id],
      work_scope: {
        start_line: atom.start_line,
        end_exclusive_line: atom.end_line + 1,
        primary_fragments: [{
          atom_id: atom.atom_id,
          start: 0,
          end,
          text: atom.text.slice(0, end),
          text_sha256: "fixture-only",
        }],
      },
    });

    const partial = evaluateDiscoveryLedgerAgreement({ targets: [target(partialEnd)] }, ledger, [atom]);
    expect(partial.uncovered_clause_ids).toEqual(["4.2.2"]);
    expect(partial.unclaimed_candidate_clause_ids).toContain("4.2.2");
    expect(partial.skip_reviewer).toBe(false);

    const complete = evaluateDiscoveryLedgerAgreement({ targets: [target(atom.text.length)] }, ledger, [atom]);
    expect(complete.uncovered_clause_ids).toEqual([]);
    expect(complete.unclaimed_candidate_clause_ids).not.toContain("4.2.2");
    expect(complete.skip_reviewer).toBe(true);
  });
});
