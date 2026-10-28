import { describe, expect, test } from "vitest";

import type { EvidenceManifest, PersistedSemanticSourcePlan } from "../src/contracts.js";
import { evaluateTargetLedgerCoverage, scanDocumentLedger } from "../src/document-ledger.js";
import {
  accountedReferenceOriginEvidenceIds,
  evidenceLineIndex,
  ledgerClauseIdSet,
  resolveItemClauseId,
} from "../src/ledger-reconciliation.js";

const ledger = scanDocumentLedger([
  "# 2 材料验收",
  "## 2.1 材料检验",
  "2.1.1 材料质量标准应符合表 2.1.1 的规定。",
  "表 2.1.1 材料质量标准",
  "<table><tr><td>检查项目</td><td>允许值</td><td>检查方法</td></tr><tr><td>强度</td><td>设计值</td><td>试验</td></tr></table>",
  "2.1.2 施工结束后应检查外观。",
  "检验方法：目视检查。",
].join("\n"), "reference-coverage.md");
for (const clause of ledger.clauses) {
  if (clause.clause_id === "2.1.1" || clause.clause_id === "2.1.2") {
    clause.kind = "item_candidate";
    clause.has_method = true;
  }
}
const origin = ledger.clauses.find((clause) => clause.clause_id === "2.1.1");
if (!origin) throw new Error("Missing synthetic table pointer");
const evidence = [{ evidence_id: "pointer", locator: `line:${origin.line}` }] as EvidenceManifest["evidence"];
const occurrences = [{ occurrence_id: "table-reference", origin_evidence_id: "pointer" }] as unknown as EvidenceManifest["reference_occurrences"];

function plan(targetEvidenceIds = ["table-row"], destinationBindings = [{}]) {
  return {
    reference_resolutions: [{
      occurrence_id: "table-reference",
      origin_evidence_id: "pointer",
      application_mode: "reference_only",
      target_evidence_ids: targetEvidenceIds,
      destination_bindings: destinationBindings,
    }],
  } as unknown as Pick<PersistedSemanticSourcePlan, "reference_resolutions">;
}

function gapWith(planValue: Pick<PersistedSemanticSourcePlan, "reference_resolutions">, itemClauses: string[]) {
  const lineIndex = evidenceLineIndex(evidence);
  const referencedClauses = accountedReferenceOriginEvidenceIds(planValue, occurrences)
    .map((id) => resolveItemClauseId({ evidence_ids: [id] }, ledgerClauseIdSet(ledger), ledger, lineIndex));
  return evaluateTargetLedgerCoverage({
    ledger,
    start_line: 1,
    end_exclusive_line: 99,
    source_clauses: [...itemClauses, ...referencedClauses],
  }).gap_clause_ids;
}

describe("resolved reference coverage for a target ledger window", () => {
  test("a table pointer with real item receivers covers its parent clause without a duplicate item", () => {
    expect(gapWith(plan(), ["2.1.2"])).toEqual([]);
  });

  test("a reference without target evidence or receiver does not hide a missing clause", () => {
    expect(gapWith(plan([], [{}]), ["2.1.2"])).toEqual(["2.1.1"]);
    expect(gapWith(plan(["table-row"], []), ["2.1.2"])).toEqual(["2.1.1"]);
  });

  test("a valid table pointer does not hide another missing clause", () => {
    expect(gapWith(plan(), [])).toEqual(["2.1.2"]);
  });
});
