import { sha256Text } from "./canonical.js";
import type { EvidenceManifest, EvidenceRecord, PersistedSemanticSourcePlan, SourceFragment } from "./contracts.js";
import { buildReferenceScopeEvidence } from "./document-reference.js";
import { scanDocumentLedger, type DocumentLedger } from "./document-ledger.js";
import { buildStructuredTargetEvidence } from "./evidence.js";
import { normalizeStandardNo, standardIdentityMatches, type ExternalSourceWorkflow } from "./external-source-workflow.js";
import { hydrateSemanticSourcePlan } from "./plan-hydration.js";
import { evidenceLineIndex, ledgerClauseIdSet, resolveItemClauseId, tableReferenceOccurrences,
  type LedgerItemSourceContext, type LedgerReconciliationItem } from "./ledger-reconciliation.js";

interface SourceDocument {
  id: string;
  label: string;
  ledger: DocumentLedger;
  records: Map<string, EvidenceRecord>;
}
export type LedgerSourceCache = Map<string, Promise<SourceDocument | undefined>>;

function sourceDocument(markdown: string, id: string, label: string, ledger = scanDocumentLedger(markdown, label)): SourceDocument {
  const windows = [{ start_line: 1, end_exclusive_line: markdown.split(/\r?\n/u).length + 1 }];
  // Both canonical typed rows and the unchanged HTML/prose reference records
  // occur in sealed plans. Rebuild their immutable identities from this source.
  const records = [...buildStructuredTargetEvidence(markdown, id, windows, false).evidence,
    ...buildReferenceScopeEvidence(markdown, id, windows).evidence];
  return { id, label, ledger, records: new Map(records.map(record => [record.evidence_id, record])) };
}

function ownerClause(record: EvidenceRecord, document: SourceDocument): string {
  const line = Number(/^line:(\d+)(?:\/|$)/u.exec(record.locator)?.[1]);
  const exact = record.clause_id && document.ledger.clauses.find(clause => clause.clause_id === record.clause_id
    && line >= clause.line && line < clause.end_exclusive_line);
  const owner = exact || document.ledger.clauses.filter(clause => line >= clause.line && line < clause.end_exclusive_line)
    .sort((a, b) => (a.end_exclusive_line - a.line) - (b.end_exclusive_line - b.line))[0];
  return owner?.clause_id ?? "";
}

/** Read-only publication accounting. No selector, evidence or sealed result is rewritten. */
export async function reconcileTargetDocumentSources(input: {
  ledger: DocumentLedger;
  markdown: string;
  manifest: EvidenceManifest;
  plan: PersistedSemanticSourcePlan;
  items: readonly LedgerReconciliationItem[];
  workflow?: ExternalSourceWorkflow;
  cache?: LedgerSourceCache;
}): Promise<{ contexts: Map<string, LedgerItemSourceContext>; main_evidence: EvidenceRecord[] }> {
  const { manifest } = input, cache = input.cache ?? new Map();
  const mainId = manifest.source.sha256;
  if (!cache.has(mainId)) cache.set(mainId, Promise.resolve(sha256Text(input.markdown) === mainId
    && input.ledger.source_sha256 === mainId ? sourceDocument(input.markdown, mainId, manifest.source.file_name, input.ledger) : undefined));
  const documents = new Map<string, SourceDocument>();
  const main = await cache.get(mainId)!;
  if (main) documents.set(mainId, main);
  const sourceLabels = new Map([[mainId, manifest.source.file_name]]);
  for (const occurrence of manifest.reference_occurrences) {
    const external = occurrence.external_standard;
    if (occurrence.status !== "resolved" || external?.status !== "resolved" || !external.markdown_sha256
      || occurrence.target_address?.source_id !== external.markdown_sha256) continue;
    const id = external.markdown_sha256;
    sourceLabels.set(id, external.standard_no);
    const cacheKey = `${id}:${normalizeStandardNo(external.standard_no)}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, (async () => {
      const document = await input.workflow?.lookup(external.standard_no);
      if (!document || document.markdown_sha256 !== id || sha256Text(document.markdown) !== id
        || normalizeStandardNo(document.standard_no) !== normalizeStandardNo(external.standard_no)
        || !standardIdentityMatches(document.markdown, external.standard_no)) return undefined;
      return sourceDocument(document.markdown, id, external.standard_no);
    })());
    const document = await cache.get(cacheKey)!;
    if (document) documents.set(id, document);
  }
  const owners = new Map<string, SourceDocument>();
  for (const record of manifest.evidence) {
    const matches = [...documents.values()].filter(document => {
      const rebuilt = document.records.get(record.evidence_id);
      return rebuilt?.locator === record.locator && rebuilt.text === record.text
        && rebuilt.text_sha256 === record.text_sha256 && sha256Text(record.text) === record.text_sha256;
    });
    if (matches.length === 1) owners.set(record.evidence_id, matches[0]!);
  }
  const records = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  const plan = hydrateSemanticSourcePlan(input.plan, manifest);
  const contexts = new Map<string, LedgerItemSourceContext>();
  const validFragments = (fragments: readonly SourceFragment[]) => fragments.filter(fragment => {
    const record = records.get(fragment.evidence_id);
    return fragment.text.trim() && record?.text.includes(fragment.text) && owners.has(fragment.evidence_id);
  });
  for (const result of input.items) {
    const item = plan.acceptance_items.find(candidate => candidate.item_id === result.item_id);
    const context: LedgerItemSourceContext = { clause_id: "", clause_valid: false, main_clause_ids: [], clause_sources: [], table_checks: [], diagnostics: [] };
    contexts.set(result.item_id ?? "", context);
    const diagnose = (field: string, code: string, reference: string, actual: string, document?: SourceDocument) => {
      context.diagnostics.push({ item_id: result.item_id ?? "", target_id: manifest.target_id, field, code, reference,
        ...(document ? { source_sha256: document.id, source_label: document.label } : {}), actual,
        expected: "实际字段来源须绑定到已登记版本的原文；条文/表题须存在于该来源文档。封存记录不可直接修改，恢复缺失或变更的原资料；作者绑定有误须走合法修订。" });
    };
    if (!item) { diagnose("item_id", "ledger_source_item_missing", "", "封存计划中不存在该项目"); continue; }
    const fieldFragments = new Map<string, SourceFragment[]>();
    for (const field of ["name", "requirement", "method", "quantity", "note"] as const) {
      const binding = item.field_bindings[field];
      if (binding.status === "bound" && binding.value_sha256 === sha256Text(item[field])) {
        fieldFragments.set(field, validFragments(binding.source_fragments.filter(fragment => binding.evidence_ids.includes(fragment.evidence_id))));
      }
    }
    const tableFragments = validFragments([...(item.table_semantics?.cell_evidence ?? []), ...(item.table_semantics?.reference_fragments ?? [])]);
    const usedIds = new Set([...item.evidence_ids, ...[...fieldFragments.values()].flat().map(fragment => fragment.evidence_id),
      ...tableFragments.map(fragment => fragment.evidence_id)]);
    // Missing or changed admitted documents must fail explicitly, including
    // when their numeric identifiers happen to exist in the main document.
    const claimedIds = new Set([...item.evidence_ids, ...Object.values(item.field_bindings).flatMap(binding => binding.source_fragments.map(fragment => fragment.evidence_id)),
      ...(item.table_semantics?.cell_evidence ?? []).map(fragment => fragment.evidence_id)]);
    for (const id of claimedIds) if (!owners.has(id)) {
      const claims = manifest.reference_occurrences.filter(occurrence => occurrence.target_evidence_ids.includes(id))
        .map(occurrence => occurrence.target_address?.source_id).filter(Boolean);
      diagnose("evidence_ids", "ledger_source_unverified", id, `来源无法按原文身份和哈希复现：${claims.map(id => sourceLabels.get(id!) ?? id).join("、") || "未确定来源"}`);
    }
    const mainRecords = manifest.evidence.filter(record => owners.get(record.evidence_id)?.id === mainId);
    context.clause_id = resolveItemClauseId(result, ledgerClauseIdSet(input.ledger), input.ledger, evidenceLineIndex(mainRecords));
    const clauseSources = new Map<string, SourceDocument>();
    for (const id of usedIds) {
      const document = owners.get(id), record = document?.records.get(id);
      if (record && document && ownerClause(record, document) === context.clause_id) clauseSources.set(document.id, document);
    }
    context.clause_valid = Boolean(context.clause_id && clauseSources.size);
    context.clause_sources = [...clauseSources.values()].map(document => ({ source_sha256: document.id, source_label: document.label }));
    if (clauseSources.has(mainId)) context.main_clause_ids = [context.clause_id];
    if (!context.clause_valid) diagnose("source_clause", "ledger_clause_source_mismatch", context.clause_id,
      "条文号未落到项目实际绑定的来源条文中");

    for (const reference of tableReferenceOccurrences(result)) {
      const fragments = fieldFragments.get(reference.field) ?? [];
      let selected = fragments.filter(fragment => tableReferenceOccurrences({ requirement: fragment.text }).some(row => row.table_no === reference.table_no));
      if (reference.field === "table_semantics.table_no" || !selected.length) {
        // Generated table labels/coordinates use the real typed table's rows,
        // never a same-number table found elsewhere in the admitted documents.
        const typed = tableFragments.filter(fragment => owners.get(fragment.evidence_id)?.records.get(fragment.evidence_id)?.table_id === reference.table_no);
        if (reference.field === "table_semantics.table_no" || tableReferenceOccurrences({ table_semantics: result.table_semantics ?? null }).some(row => row.table_no === reference.table_no)) selected = typed;
      }
      const sources = new Map(selected.flatMap(fragment => {
        const document = owners.get(fragment.evidence_id); return document ? [[document.id, document] as const] : [];
      }));
      if (!sources.size) {
        context.table_checks.push({ field: reference.field, table_no: reference.table_no, ok: false });
        diagnose(reference.field, "ledger_table_source_missing", reference.table_no, "未找到该表号在实际字段或表格来源中的绑定");
      }
      for (const document of sources.values()) {
        const known = new Set([...(document.ledger.tables ?? []).map(table => table.table_no),
          ...document.ledger.record_tables.map(table => table.table_no.replace(/^表\s*/u, ""))]);
        const ok = known.has(reference.table_no);
        context.table_checks.push({ field: reference.field, table_no: reference.table_no, source_sha256: document.id, source_label: document.label, ok });
        if (!ok) diagnose(reference.field, "ledger_table_source_mismatch", reference.table_no, "该来源文档没有匹配表题", document);
      }
    }
  }
  return { contexts, main_evidence: manifest.evidence.filter(record => owners.get(record.evidence_id)?.id === mainId) };
}
