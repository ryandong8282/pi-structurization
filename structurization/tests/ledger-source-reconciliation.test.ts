import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest, EvidenceRecord, SemanticSourcePlan } from "../src/contracts.js";
import { buildReferenceScopeEvidence } from "../src/document-reference.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import type { ExternalSourceWorkflow } from "../src/external-source-workflow.js";
import { reconcileLedgerCoverage, type LedgerReconciliationItem } from "../src/ledger-reconciliation.js";
import { reconcileTargetDocumentSources, type LedgerSourceCache } from "../src/ledger-source-reconciliation.js";
import { batchLedgerGapFrom, describeBatchLedgerGap } from "../src/batch.js";

const main = "# ZX 101-2020 中性装配标准\n## 2 主控项目\n2.1.1 接头应平整。检查数量：全数检查。\n表2.1.2 接头尺寸\n<table><tr><td>项目</td><td>限值</td></tr><tr><td>间隙</td><td>3</td></tr></table>";
const external = "# ZX 102-2021 中性涂层标准\n## 7 一般规定\n7.1.1 涂层应满足表7.1.2。\n表7.1.2 涂层尺寸\n<table><tr><td>项目</td><td>限值</td></tr><tr><td>厚度</td><td>8</td></tr></table>";
function records(markdown: string) {
  const windows = [{ start_line: 1, end_exclusive_line: markdown.split('\n').length + 1 }];
  const hash = sha256Text(markdown);
  return [...new Map([...buildStructuredTargetEvidence(markdown, hash, windows, false).evidence,
    ...buildReferenceScopeEvidence(markdown, hash, windows).evidence].map(record => [record.evidence_id, record])).values()];
}
function fixture(foreign = external) {
  const mainRecords = records(main), otherRecords = records(foreign);
  const mainRecord = mainRecords.find(record => record.text.includes("2.1.1 接头"))!;
  const otherRecord = otherRecords.find(record => /^\d+\.\d+\.\d+ /u.test(record.text))!;
  const item = (id: string, record: EvidenceRecord): LedgerReconciliationItem => ({ item_id: id,
    source_clause: record.text.split(' ')[0]!, requirement: record.text, evidence_ids: [record.evidence_id] });
  const items = [item("local", mainRecord), item("foreign", otherRecord)];
  const author = (result: LedgerReconciliationItem, record: EvidenceRecord) => ({ ...result,
    name: "", method: "", quantity: "", note: "", reference_evidence_ids: otherRecords.map(row => row.evidence_id),
    field_bindings: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field,
      field === "requirement" ? { status: "bound", value_sha256: sha256Text(record.text), evidence_ids: [record.evidence_id], source_fragments: [{ evidence_id: record.evidence_id, text: record.text }] }
        : { status: "unbound", value_sha256: sha256Text(""), evidence_ids: [], source_fragments: [] }])) });
  const plan = { acceptance_items: [author(items[0]!, mainRecord), author(items[1]!, otherRecord)] } as unknown as SemanticSourcePlan;
  const manifest = { target_id: "neutral", source: { sha256: sha256Text(main), file_name: "neutral.md" },
    evidence: [...mainRecords, ...otherRecords], reference_occurrences: [{ status: "resolved", target_evidence_ids: otherRecords.map(row => row.evidence_id),
      target_address: { source_id: sha256Text(foreign) }, external_standard: { standard_no: "ZX 102-2021", status: "resolved", markdown_sha256: sha256Text(foreign) } }] } as unknown as EvidenceManifest;
  const workflow: ExternalSourceWorkflow = { lookup: async () => ({ standard_no: "ZX 102-2021", markdown: foreign, markdown_sha256: sha256Text(foreign) }), require: async () => { throw new Error("read-only reconciliation"); } };
  const ledger = scanDocumentLedger(main, "neutral.md");
  const run = async (cache?: LedgerSourceCache) => {
    const accounting = await reconcileTargetDocumentSources({ ledger, markdown: main, manifest, plan, items, workflow, ...(cache ? { cache } : {}) });
    const reconciliation = reconcileLedgerCoverage({ ledger, items: items.map(row => ({ ...row, source_context: accounting.contexts.get(row.item_id!)! })) });
    return { ...accounting, reconciliation };
  };
  return { ledger, manifest, plan, items, workflow, run, otherRecords, mainRecord, otherRecord };
}

describe("source-qualified publication ledger", () => {
  test("accepts clauses and table references in their actual bound source", async () => {
    const f = fixture(), r = await f.run();
    expect(r.reconciliation.ok).toBe(true);
    expect(r.contexts.get("foreign")?.clause_sources).toEqual([{ source_sha256: sha256Text(external), source_label: "ZX 102-2021" }]);
    expect(r.contexts.get("foreign")?.main_clause_ids).toEqual([]);
    expect(r.main_evidence.some(record => record.evidence_id === f.otherRecord.evidence_id)).toBe(false);
  });
  test("identical external clause and line numbers do not cover the main document", async () => {
    const f = fixture(external.replaceAll("7.1.1", "2.1.1"));
    f.items.splice(0, 1);
    const r = await f.run();
    expect(r.contexts.get("foreign")?.clause_valid).toBe(true);
    expect(r.reconciliation.missing_clause_ids).toContain("2.1.1");
  });
  test("a table in the main document cannot satisfy the foreign source's missing table", async () => {
    const f = fixture(external.replace("满足表7.1.2", "满足表2.1.2"));
    const r = await f.run();
    expect(r.reconciliation.ok).toBe(false);
    expect(r.reconciliation.unresolved_table_refs).toContain("2.1.2");
    expect(r.contexts.get("foreign")?.diagnostics).toContainEqual(expect.objectContaining({ code: "ledger_table_source_mismatch", source_label: "ZX 102-2021" }));
  });
  test("an admitted but unbound document does not authorize a clause", async () => {
    const f = fixture();
    f.items[0]!.source_clause = "7.1.1";
    expect((await f.run()).contexts.get("local")?.clause_valid).toBe(false);
  });
  test.each(["missing", "changed", "wrong-edition"])("fails closed for %s source", async mode => {
    const f = fixture();
    f.workflow.lookup = async () => mode === "missing" ? undefined : ({ standard_no: "ZX 102-2021",
      markdown: mode === "changed" ? external + " changed" : external.replace("102-2021", "102-2022"), markdown_sha256: sha256Text(external) });
    const r = await f.run();
    expect(r.reconciliation.ok).toBe(false);
    expect(r.contexts.get("foreign")?.diagnostics.some(row => row.code === "ledger_source_unverified")).toBe(true);
  });
  test("canonical typed table rows resolve without occurrence membership", async () => {
    const f = fixture(), record = f.otherRecords.find(row => row.table_id === "7.1.2")!;
    expect(record).toBeDefined();
    f.manifest.reference_occurrences[0]!.target_evidence_ids = [];
    f.plan.acceptance_items[1]!.table_semantics = { cell_evidence: [{ evidence_id: record.evidence_id, text: record.text }], reference_fragments: [] } as never;
    f.items[1]!.table_semantics = { table_no: "7.1.2" };
    expect((await f.run()).reconciliation.ok).toBe(true);
  });
  test("forged typed table metadata cannot borrow a table number", async () => {
    const f = fixture(), record = f.otherRecords.find(row => row.table_id === "7.1.2")!;
    record.table_id = "2.1.2";
    f.plan.acceptance_items[1]!.table_semantics = { cell_evidence: [{ evidence_id: record.evidence_id, text: record.text }], reference_fragments: [] } as never;
    f.items[1]!.table_semantics = { table_no: "2.1.2" };
    expect((await f.run()).reconciliation.unresolved_table_refs).toContain("2.1.2");
  });
  test.each(["text", "locator", "id"])("rejects changed evidence %s", async mode => {
    const f = fixture();
    if (mode === "text") { f.otherRecord.text += "changed"; f.otherRecord.text_sha256 = sha256Text(f.otherRecord.text); }
    if (mode === "locator") f.otherRecord.locator = "line:99";
    if (mode === "id") f.otherRecord.evidence_id = "invented";
    expect((await f.run()).reconciliation.source_identity_ok).toBe(false);
  });
  test("cache reuse still checks the claimed standard identity", async () => {
    const cache: LedgerSourceCache = new Map(), f = fixture();
    expect((await f.run(cache)).reconciliation.ok).toBe(true);
    f.manifest.reference_occurrences[0]!.external_standard!.standard_no = "ZX 999-2021";
    expect((await f.run(cache)).reconciliation.ok).toBe(false);
  });
  test("a failed source check is not bypassed when the main ledger has no clauses", async () => {
    const f = fixture();
    f.workflow.lookup = async () => undefined;
    const r = await f.run();
    const report = batchLedgerGapFrom({ ledger: scanDocumentLedger("# 中性附录", "empty.md"), targets: [],
      items: [{ ...f.items[1]!, source_context: r.contexts.get("foreign")! }] });
    expect(report.gap?.source_diagnostics?.some(row => row.code === "ledger_source_unverified")).toBe(true);
    expect(describeBatchLedgerGap(report.gap!)).toContain("来源");
  });
});
