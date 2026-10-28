import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { boundLotScopeClauseIds, reconcileLedgerCoverage } from "../src/ledger-reconciliation.js";
import { registerSourceSpan, registryWithFullSourceSpans } from "../src/source-span-registry.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";

function fixture() {
  const ledger = scanDocumentLedger("## 8.2 装置检验\n8.2.1 装置性能应符合设计要求。\n检查数量：全数检查。\n8.2.2 装置安装完成后实施现场检验。\n8.2.3 检验应由专业人员实施。\n", "synthetic.md");
  const evidence: EvidenceManifest["evidence"] = ledger.clauses.map(clause => ({
    evidence_id: `evidence:${clause.clause_id}`, kind: "paragraph", role: "supporting_clause",
    locator: `line:${clause.line}`, text: clause.text, text_sha256: sha256Text(clause.text),
    requires_disposition: true, evidence_scope: "primary",
  }));
  const manifest = { evidence, evidence_fingerprint: "synthetic-source" };
  const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, evidence.map(record => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text })));
  const selectors: Pick<TargetSelectorPlan, "lots" | "items"> = { lots: [{ key: "lot", name: "装置", reason: "独立范围", scope_span_ids: [registry.spans[1]!.span_id] }],
    items: [{ key: "item", lot_key: "lot" }] as TargetSelectorPlan["items"] };
  return { ledger, manifest, registry, selectors };
}

describe("whole-clause retention in lot scope", () => {
  test("counts real non-item scope while preserving the truly unaccounted candidate", () => {
    const f = fixture();
    const scope = boundLotScopeClauseIds(f.selectors, f.registry, f.manifest, f.ledger);
    expect(scope).toEqual(["8.2.2"]);
    const report = reconcileLedgerCoverage({ ledger: f.ledger, items: [{ source_clause: "8.2.1" }], scope_covered_clause_ids: scope });
    expect(report).toMatchObject({ ok: true, scope_covered_candidate_clause_ids: ["8.2.2"], covered_candidate_clause_count: 2,
      unaccounted_candidate_clause_ids: ["8.2.3"] });
  });

  test("lot scope never exempts a required clause or the minimum item count", () => {
    const f = fixture();
    const report = reconcileLedgerCoverage({ ledger: f.ledger, items: [], scope_covered_clause_ids: ["8.2.1", "8.2.2"] });
    expect(report).toMatchObject({ ok: false, missing_clause_ids: ["8.2.1"], item_count_ok: false, scope_covered_candidate_clause_ids: ["8.2.2"] });
  });

  test.each(["partial", "forged_hash", "wrong_source", "empty_lot", "reference", "wrong_line"])("does not credit %s", mode => {
    const f = fixture();
    if (mode === "partial") {
      const record = f.manifest.evidence[1]!;
      const partial = registerSourceSpan(f.registry, { source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text }, 0, 8);
      f.registry = partial.registry;
      f.selectors.lots[0]!.scope_span_ids = [partial.span.span_id];
    }
    if (mode === "forged_hash") f.registry.spans[1]!.text_sha256 = "invalid";
    if (mode === "wrong_source") f.registry.source_fingerprint = "another-source";
    if (mode === "empty_lot") f.selectors.items = [];
    if (mode === "reference") f.manifest.evidence[1]!.evidence_scope = "reference";
    if (mode === "wrong_line") f.manifest.evidence[1]!.locator = "line:9999";
    expect(boundLotScopeClauseIds(f.selectors, f.registry, f.manifest, f.ledger)).toEqual([]);
  });
});
