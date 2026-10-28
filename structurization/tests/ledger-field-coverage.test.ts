import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { boundFieldClauseIds, reconcileLedgerCoverage, resolveItemClauseId, ledgerClauseIdSet, evidenceLineIndex, contaminatedItemIds } from "../src/ledger-reconciliation.js";
import type { EvidenceManifest, SemanticSourcePlanV8 } from "../src/contracts.js";
import { batchLedgerGapFrom } from "../src/batch.js";

const text = "4.2.2 检查数量：不少于3处。";
const ledger = scanDocumentLedger("# 4 验收\n## 4.2 材料\n4.2.1 检查数量：全数。\n" + text, "fixture.md");
function fixture() {
  const evidence = [{ evidence_id: "e", locator: "line:4", text }] as EvidenceManifest["evidence"];
  const binding = { status: "bound", value_sha256: sha256Text(text), evidence_ids: ["e"], source_span_ids: ["s"] };
  const plan = { source_spans: [{ span_id: "s", evidence_id: "e", start: 0, end: text.length, text_sha256: sha256Text(text) }], acceptance_items: [{ quantity: text, field_bindings: { quantity: binding } }] } as unknown as SemanticSourcePlanV8;
  return { evidence, plan };
}
describe("business field clause coverage stays separate from ownership", () => {
  test("counts a bound sampling clause without changing the primary owner or contamination checks", () => {
    const { plan, evidence } = fixture();
    const item = { item_id: "i", source_clause: "4.2.1", evidence_ids: ["e"] };
    const index = evidenceLineIndex(evidence);
    expect(resolveItemClauseId(item, ledgerClauseIdSet(ledger), ledger, index)).toBe("4.2.1");
    expect(contaminatedItemIds({ ledger, items: [item], lineIndex: index })).toEqual(["i"]);
    const covered = boundFieldClauseIds(plan, evidence, ledger);
    expect(covered).toEqual(["4.2.2"]);
    expect(reconcileLedgerCoverage({ ledger, items: [item, item], field_covered_clause_ids: covered }).missing_clause_ids).toEqual([]);
    expect(reconcileLedgerCoverage({ ledger, items: [item] }).missing_clause_ids).toContain("4.2.2");
    expect(reconcileLedgerCoverage({ ledger, items: [item], field_covered_clause_ids: covered }).item_count_ok).toBe(false);
    expect(batchLedgerGapFrom({ ledger, targets: [], items: [item, item], field_covered_clause_ids: covered }).gap).toBeUndefined();
  });
  test("a context prefix does not hide another clause bound to a business field", () => {
    const { plan, evidence } = fixture();
    const item = { requirement: "4.2.1 共同条件", evidence_ids: ["e"] };
    expect(resolveItemClauseId(item, ledgerClauseIdSet(ledger), ledger, evidenceLineIndex(evidence))).toBe("4.2.1");
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual(["4.2.2"]);
  });
  test.each(["empty", "unbound", "stale-value", "missing-span", "wrong-source", "stale-source", "name-only"])("does not credit %s bindings", (mode) => {
    const { plan, evidence } = fixture();
    const item = plan.acceptance_items[0]!;
    if (mode === "empty") item.quantity = "";
    if (mode === "unbound") item.field_bindings.quantity.status = "unbound" as typeof item.field_bindings.quantity.status;
    if (mode === "stale-value") item.quantity += " changed";
    if (mode === "missing-span") plan.source_spans = [];
    if (mode === "wrong-source") item.field_bindings.quantity.evidence_ids = ["other"];
    if (mode === "stale-source") plan.source_spans[0]!.text_sha256 = "invalid";
    if (mode === "name-only") { item.name = item.quantity; item.field_bindings.name = item.field_bindings.quantity; item.quantity = ""; }
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual([]);
  });
  test("bare evidence and an opened whole-document atom do not create coverage", () => {
    const { plan, evidence } = fixture();
    plan.acceptance_items[0]!.field_bindings.quantity.source_span_ids = [];
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual([]);
    const fresh = fixture(); fresh.evidence[0]!.locator = "char:0-100";
    expect(boundFieldClauseIds(fresh.plan, fresh.evidence, ledger)).toEqual([]);
  });
  test("legacy plans without a registry retain existing behavior", () => {
    const { plan, evidence } = fixture();
    const { source_spans: _spans, ...legacy } = plan;
    expect(boundFieldClauseIds(legacy as unknown as SemanticSourcePlanV8, evidence, ledger)).toEqual([]);
  });
});

function samplingFixture() {
  const { plan, evidence } = fixture();
  const item = plan.acceptance_items[0]!;
  item.item_id = "receiver";
  item.quantity = "";
  const component = { key: "quantity", role: "quantity" as const, disposition: "present" as const, source_span_ids: ["s"], reason: "source" };
  const branch = { branch_id: "branch", applies_to_category: "all_items" as const, min_sampling: text, script: "", source_span_ids: ["s"], conditions: [], components: [component] };
  plan.shared_sampling_rules = [{ rule_id: "rule", source_semantic_id: "semantic", evidence_ids: ["e"], complete_span_ids: ["s"], branches: [branch], shared_conditions: [], components: [], receiving_item_ids: [item.item_id], reason: "shared sampling" }];
  item.sampling = { status: "reference", min_sampling: text, script: "", reason: "applied", confidence: 1, evidence_ids: ["e"], rule_ids: ["rule"], branch_ids: ["branch"], applied_branches: [{ rule_id: "rule", branch_id: "branch", min_sampling: text, script: "", conditions: [], evidence_ids: ["e"], effective_components: [component] }] };
  return { plan, evidence };
}

describe("applied sampling provenance contributes clause coverage", () => {
  test("counts selected shared sampling without requiring a duplicated quantity field", () => {
    const { plan, evidence } = samplingFixture();
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual(["4.2.2"]);
    expect(plan.acceptance_items[0]!.quantity).toBe("");
  });
  test.each(["unused-rule", "unselected-branch", "wrong-receiver", "unapplied", "wrong-evidence", "stale-source", "stale-value"])("does not credit %s", mode => {
    const { plan, evidence } = samplingFixture();
    const sampling = plan.acceptance_items[0]!.sampling;
    if (mode === "unused-rule") sampling.rule_ids = [];
    if (mode === "unselected-branch") sampling.branch_ids = [];
    if (mode === "wrong-receiver") plan.shared_sampling_rules![0]!.receiving_item_ids = ["other"];
    if (mode === "unapplied") sampling.applied_branches = [];
    if (mode === "wrong-evidence") sampling.evidence_ids = ["other"];
    if (mode === "stale-source") plan.source_spans[0]!.text_sha256 = "invalid";
    if (mode === "stale-value") sampling.applied_branches![0]!.min_sampling = "changed";
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual([]);
  });
  test("does not credit the complete span of an unselected sibling branch", () => {
    const { plan, evidence } = samplingFixture();
    const rule = plan.shared_sampling_rules![0]!;
    rule.branches.push({ ...rule.branches[0]!, branch_id: "unused" });
    rule.branches[0]!.source_span_ids = [];
    rule.branches[0]!.components = [];
    plan.acceptance_items[0]!.sampling.applied_branches![0]!.effective_components = [];
    expect(boundFieldClauseIds(plan, evidence, ledger)).toEqual([]);
  });
});
