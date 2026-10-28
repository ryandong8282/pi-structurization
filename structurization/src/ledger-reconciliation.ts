import { ledgerRequiredClausePredicate, type DocumentLedger } from "./document-ledger.js";

import { sha256Text } from "./canonical.js";
import { sourceSpanGaps, type SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";
import {
  referenceOccurrenceOriginEvidenceIds,
  type EvidenceManifest,
  type PersistedSemanticSourcePlan,
} from "./contracts.js";

export const LEDGER_RECONCILIATION_SCHEMA_VERSION = "ledger-reconciliation/v3" as const;

/** A resolved reference accounts for its origin only when it has a real receiver,
 * or when it is an explicit non-item placeholder. The origin is coverage, not an item. */
export function accountedReferenceOriginEvidenceIds(
  plan: Pick<PersistedSemanticSourcePlan, "reference_resolutions">,
  occurrences: EvidenceManifest["reference_occurrences"],
): string[] {
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const origins = new Set<string>();
  for (const resolution of plan.reference_resolutions ?? []) {
    if (
      resolution.application_mode !== "reference_placeholder"
      && !(resolution.target_evidence_ids.length > 0 && resolution.destination_bindings.length > 0)
    ) continue;
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    for (const evidenceId of occurrence
      ? referenceOccurrenceOriginEvidenceIds(occurrence)
      : [resolution.origin_evidence_id]) origins.add(evidenceId);
  }
  return [...origins];
}

/** Coverage only: never substitute these clauses for an item's primary ownership. */
export function boundFieldClauseIds(
  plan: PersistedSemanticSourcePlan,
  evidence: EvidenceManifest["evidence"],
  ledger: DocumentLedger,
): string[] {
  // Legacy plans without a span registry retain their existing reconciliation behavior.
  if (!("source_spans" in plan)) return [];
  const records = new Map(evidence.map((record) => [record.evidence_id, record]));
  const spans = new Map(plan.source_spans.map((span) => [span.span_id, span]));
  const lines = evidenceLineIndex(evidence);
  const clauseIds = ledgerClauseIdSet(ledger);
  const covered = new Set<string>();
  const coverSpans = (spanIds: readonly string[], evidenceIds: readonly string[]) => {
    for (const spanId of spanIds) {
      const span = spans.get(spanId);
      const record = span && records.get(span.evidence_id);
      if (!span || !record || !evidenceIds.includes(span.evidence_id)
        || !Number.isInteger(span.start) || !Number.isInteger(span.end)
        || span.start < 0 || span.end <= span.start || span.end > record.text.length
        || sha256Text(record.text.slice(span.start, span.end)) !== span.text_sha256) continue;
      const clause = resolveItemClauseId({ evidence_ids: [span.evidence_id] }, clauseIds, ledger, lines);
      if (clause) covered.add(clause);
    }
  };
  for (const item of plan.acceptance_items) {
    for (const field of ["requirement", "method", "quantity", "note"] as const) {
      const value = item[field];
      const binding = item.field_bindings?.[field];
      if (!value?.trim() || binding?.status !== "bound"
        || binding.value_sha256 !== sha256Text(value)) continue;
      coverSpans(binding.source_span_ids ?? [], binding.evidence_ids);
    }
    const sampling = item.sampling;
    if (!sampling || !["reference", "reference_unspecified_quantity"].includes(sampling.status)) continue;
    for (const applied of sampling.applied_branches ?? []) {
      const rule = plan.shared_sampling_rules?.find(rule => rule.rule_id === applied.rule_id);
      const branch = rule?.branches.find(branch => branch.branch_id === applied.branch_id);
      if (!rule || !branch || !rule.receiving_item_ids.includes(item.item_id)
        || !sampling.rule_ids?.includes(rule.rule_id) || !sampling.branch_ids?.includes(branch.branch_id)
        || applied.min_sampling !== branch.min_sampling || applied.script !== branch.script) continue;
      const selectedMembers = new Set([...rule.components, ...branch.components]
        .filter(component => component.disposition === "present")
        .flatMap(component => component.source_span_ids));
      // complete_span_ids can contain unselected sibling branches. Credit only
      // the selected branch and registered components actually applied to it.
      const memberSpans = applied.effective_components
        .filter(component => component.disposition === "present")
        .flatMap(component => component.source_span_ids)
        .filter(spanId => selectedMembers.has(spanId));
      coverSpans([...branch.source_span_ids, ...memberSpans], rule.evidence_ids.filter(id =>
        sampling.evidence_ids.includes(id) && applied.evidence_ids.includes(id)
      ));
    }
  }
  return [...covered];
}

/** Diagnostic retention, not an item or mandatory-coverage exemption. Require
 * the complete clause to be retained in the scope of a lot with real items. */
export function boundLotScopeClauseIds(
  selectors: Pick<TargetSelectorPlan, "lots" | "items">,
  registry: SourceSpanRegistry,
  manifest: Pick<EvidenceManifest, "evidence" | "evidence_fingerprint">,
  ledger: DocumentLedger,
): string[] {
  if (registry.source_fingerprint !== manifest.evidence_fingerprint) return [];
  const ids = new Set(selectors.lots.filter(lot => selectors.items.some(item => item.lot_key === lot.key))
    .flatMap(lot => lot.scope_span_ids));
  const records = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  const spans = registry.spans.filter(span => {
    const record = records.get(span.evidence_id);
    return ids.has(span.span_id) && record && Number.isInteger(span.start) && Number.isInteger(span.end)
      && span.start >= 0 && span.end > span.start && span.end <= record.text.length
      && sha256Text(record.text.slice(span.start, span.end)) === span.text_sha256;
  });
  const lines = evidenceLineIndex(manifest.evidence);
  return ledger.clauses.filter(clause => manifest.evidence.some(record =>
    record.evidence_scope === "primary" && lines.get(record.evidence_id) === clause.line
    && record.text.trim() === clause.text.trim()
    && sourceSpanGaps({ evidence_id: record.evidence_id, start: 0, end: record.text.length }, spans)
      .every(gap => !record.text.slice(gap.start, gap.end).trim())
  )).map(clause => clause.clause_id);
}

export interface LedgerReconciliationItem {
  item_id?: string;
  /** Read-only aggregate ownership, supplied by the batch for diagnostics. */
  target_id?: string;
  /** Exact saved author key; never derived by matching business text. */
  author_item_key?: string;
  source_clause?: string;
  name?: string;
  requirement?: string;
  method?: string;
  table_semantics?: { table_no?: string } | null;
  /** 项目绑定的证据记录 id；配合 evidence locator 可按行号定位到底账条文。 */
  evidence_ids?: readonly string[];
  /** Host-derived from sealed source bindings and admitted document bytes; never model-authored. */
  source_context?: LedgerItemSourceContext;
}

export interface LedgerSourceDiagnostic {
  item_id: string;
  target_id?: string;
  field: string;
  code: string;
  reference: string;
  source_sha256?: string;
  source_label?: string;
  actual: string;
  expected: string;
}

export interface LedgerItemSourceContext {
  clause_id: string;
  clause_valid: boolean;
  main_clause_ids: string[];
  clause_sources: Array<{ source_sha256: string; source_label: string }>;
  table_checks: Array<{ field: string; table_no: string; source_sha256?: string; source_label?: string; ok: boolean }>;
  diagnostics: LedgerSourceDiagnostic[];
}

export interface LedgerTableReferenceDiagnostic {
  table_no: string;
  actual: { matching_caption_count: number; affected_item_count: number; source_clause_occurrence_count: number };
  expected: { matching_caption_count: "at_least_one_exact_identity" };
  affected_records: Array<{ aggregate_item_index: number; item_id?: string; target_id?: string;
    source_clause: string; field: string; raw_reference: string;
    record_read?: { tool: "read_target_selectors"; arguments: { collection: "items"; key: string } } }>;
  affected_records_complete: boolean;
  source_clauses: Array<{ clause_id: string; ledger_line: number; text: string }>;
  source_clauses_complete: boolean;
}

/** 证据 id → 源文档行号。`line:N` 形态的 locator 才有，`char:` 整原子没有行号。 */
export type EvidenceLineIndex = ReadonlyMap<string, number>;

/** 从证据清单建行号索引：locator 形如 `line:512`。 */
export function evidenceLineIndex(
  evidence: ReadonlyArray<{ evidence_id: string; locator?: string }>,
): EvidenceLineIndex {
  const index = new Map<string, number>();
  for (const record of evidence) {
    const match = /^line:(\d+)$/.exec(record.locator ?? "");
    if (match) index.set(record.evidence_id, Number(match[1]));
  }
  return index;
}

export interface LedgerReconciliation {
  schema_version: typeof LEDGER_RECONCILIATION_SCHEMA_VERSION;
  /**
   * 全书必抽条文数——验收项目的底数。判据随文档自适应
   * （见 ledgerRequiredClausePredicate）：文档用「检查数量/检验方法」就按它算，
   * 两者全书都没有时（GB 50242、GB 50310 这类）才退回「主控/一般栏目」。
   */
  required_clause_count: number;
  /**
   * 候选条文数——底账认为「长得像验收条文」的全部条文（已排除附录、一般规定、
   * 整节转指、异常编号）。这是按条文编号数出来的，与措辞无关。
   *
   * 与 required_clause_count 的差距就是「规则看不见的部分」：必抽集靠 8 个固定词样
   * （检查数量/检验方法等）识别，而 GB 50339 全书 150 条候选里只有 3 条用了这些词，
   * 其余 147 条把同一件事写成「各接口均应检测」「应逐项检测」，规则一概认不出，
   * 于是既不进清单、漏了也不报警。
   */
  candidate_clause_count: number;
  /** 候选条文里被结果覆盖到的条数。 */
  covered_candidate_clause_count: number;
  /**
   * 既不在必抽集、结果里也没有的候选条文——当前的静默缺口。
   * **纯诊断，不参与 ok 判定**：这些条文里有相当一部分本来就不是验收项目
   * （范围规定、时序规定、资料要求），机械层分辨不了，先如实记数供人评估。
   */
  unaccounted_candidate_clause_ids: string[];
  /** Complete clauses retained in non-item lot scope; diagnostic credit only. */
  scope_covered_candidate_clause_ids?: string[];
  item_count: number;
  labeled_item_count: number;
  unlabeled_item_count: number;
  covered_required_clause_count: number;
  /** 模型漏填 source_clause、由正文开头条文号按底账校验后回填的项目数。 */
  derived_clause_count: number;
  missing_clause_ids: string[];
  extra_clause_ids: string[];
  table_reference_count: number;
  unresolved_table_refs: string[];
  /** Bounded observations only; never infer a replacement table identity. */
  table_reference_diagnostics?: LedgerTableReferenceDiagnostic[];
  source_diagnostics?: LedgerSourceDiagnostic[];
  source_identity_ok?: boolean;
  /** 零遗漏：底账每条必抽条文都在结果里。 */
  clause_identity_ok: boolean;
  /** 零幻觉：结果引用的条文号都在底账里。 */
  hallucination_ok: boolean;
  /** 计数：项目数不少于条文底数，且没有不带条文号的项目。 */
  item_count_ok: boolean;
  /** 表引用都能落到实体表；底账没有表清册时按不可判处理（true + 空清单）。 */
  table_identity_ok: boolean;
  /** 底账一条条文都没扫到（离线夹具、非规范文档）——恒等式无从判定，不报假警。 */
  applicable: boolean;
  ok: boolean;
}

// A table marker and its number must share a line. A method ending in “记录表”
// followed by the next numbered clause is not a reference to that table number.
const TABLE_REFERENCE_RE = /表[^\S\r\n]*([0-9A-Za-z]{1,3}(?:\s*[.．]\s*\d+){1,3}(?:\s*-\s*\d+)?)/g;

function normalizeId(value: string): string {
  return value.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
}

function normalizeClause(value: string): string {
  return normalizeId(value.replace(/^第/, "").replace(/条$/, ""));
}

const LEADING_CLAUSE_RE = /^\s*(?:#{1,6}\s*)?(\d+(?:\s*[.．]\s*\d+){2,})/;

export function ledgerClauseIdSet(ledger: DocumentLedger): Set<string> {
  return new Set(ledger.clauses.map((clause) => clause.clause_id));
}

/**
 * 判定一个验收项目出自哪一条条文，三条路依次尝试：
 *
 * 1. 抽取端自己写的 source_clause；
 * 2. 正文开头的条文号（条文正文是逐字引用，通常自带编号）；
 * 3. **项目所绑证据的行号落在底账哪条条文的行范围内**。
 *
 * 第 3 条是必需的，不是锦上添花：物化层的位置归属只认 `char:` 整原子，
 * 而模型实际绑定的是 `line:N` 细行证据，于是 source_clause 恒为空；
 * 条文正文又常常是「5.11.2 …应符合下列规定:」加一串不带编号的子条，
 * 项目抽自子条时第 2 条也失效。GB 50310 整章卡死、GB 50576 那次
 * 138 个项目里 58 个没有条文号，都是这两条同时落空造成的。
 * 底账本来就记着每条条文的起止行，按行归属是确定性的。
 */
export function resolveItemClauseId(
  item: LedgerReconciliationItem,
  ledgerClauseIds: ReadonlySet<string>,
  ledger?: DocumentLedger,
  lineIndex?: EvidenceLineIndex,
): string {
  const declared = normalizeClause(item.source_clause ?? "");
  if (declared) return declared;
  for (const text of [item.requirement, item.name]) {
    const candidate = normalizeId(LEADING_CLAUSE_RE.exec(text ?? "")?.[1] ?? "");
    if (candidate && ledgerClauseIds.has(candidate)) return candidate;
  }
  if (!ledger || !lineIndex) return "";
  const lines = (item.evidence_ids ?? [])
    .map((evidenceId) => lineIndex.get(evidenceId))
    .filter((line): line is number => line !== undefined);
  if (!lines.length) return "";
  // 取最靠前的证据行：项目通常从它所属条文的第一行子条开始绑。
  const anchor = Math.min(...lines);
  const owning = ledger.clauses
    .filter((clause) => anchor >= clause.line && anchor < clause.end_exclusive_line)
    // 条文范围可能嵌套（章条 vs 子条），取最窄的那个。
    .sort((left, right) =>
      (left.end_exclusive_line - left.line) - (right.end_exclusive_line - right.line)
    )[0];
  return owning && ledgerClauseIds.has(owning.clause_id) ? owning.clause_id : "";
}

/**
 * 「串条文」检测：项目的**直接**证据必须落在它自己那条条文的行范围内。
 *
 * 跨条文引用走 reference_evidence_ids，不在这里；所以直接证据越界只有一个解释——
 * 把别的条文的原文抄进了本项目（实测形态：归属 4.7.1 的项目绑了 230 行之外的证据）。
 * 这件事有客观对错，不该交给复核 agent 讨论，机械拦住即可。
 * 对已人工核对过的 GB 50576 作业实测 0 误报。
 */
export function contaminatedItemIds(input: {
  ledger: DocumentLedger;
  items: ReadonlyArray<LedgerReconciliationItem & { item_id?: string }>;
  lineIndex: EvidenceLineIndex;
}): string[] {
  const ledgerClauseIds = ledgerClauseIdSet(input.ledger);
  const byClauseId = new Map(input.ledger.clauses.map((clause) => [clause.clause_id, clause]));
  const clauseRanges = input.ledger.clauses.map((clause) => ({
    start: clause.line,
    end: clause.end_exclusive_line,
  }));
  const contaminated: string[] = [];
  for (const item of input.items) {
    const clauseId = resolveItemClauseId(item, ledgerClauseIds, input.ledger, input.lineIndex);
    const clause = clauseId ? byClauseId.get(clauseId) : undefined;
    if (!clause) continue;
    const strayed = (item.evidence_ids ?? []).some((evidenceId) => {
      const line = input.lineIndex.get(evidenceId);
      if (line === undefined) return false;
      if (line >= clause.line && line < clause.end_exclusive_line) return false;
      // 只有「这一行确实落在另一条条文的段内」才算串条文——那是引了别人条文的确凿证据。
      // 落在任何条文段之外（章节抬头、覆盖整个窗口的粗证据原子）说明行归属这条判据
      // 在这里根本说不出话，不能把「说不出」当成「串了」：那样每个用整窗原子作证据的
      // 目标都会被误判，直封快路直接全灭。
      return clauseRanges.some((range) => line >= range.start && line < range.end);
    });
    if (strayed) contaminated.push(item.item_id ?? clauseId);
  }
  return contaminated;
}

export function tableReferenceOccurrences(item: LedgerReconciliationItem): Array<{ table_no: string; field: string; raw_reference: string }> {
  const refs: Array<{ table_no: string; field: string; raw_reference: string }> = [];
  // table_semantics.table_no 常带题名（「表7.2.2切割的允许偏差」），只认前面的表号本体。
  const declared = item.table_semantics?.table_no?.trim();
  const declaredReference = declared
    ? [...(declared.startsWith("表") ? declared : `表${declared}`).matchAll(TABLE_REFERENCE_RE)]
      .map((match) => normalizeId(match[1]!))[0]
    : undefined;
  const texts: Array<[string, string | undefined]> = [
    ["table_semantics.table_no", declared ? (declared.startsWith("表") ? declared : `表${declared}`) : undefined],
    ["requirement", item.requirement], ["method", item.method], ["name", item.name],
  ];
  for (const [field, text] of texts) {
    if (!text) continue;
    for (const match of text.matchAll(TABLE_REFERENCE_RE)) {
      let reference = normalizeId(match[1]!);
      const afterReference = text.slice((match.index ?? 0) + match[0].length);
      // A structured table binding already supplies the authoritative table
      // number. When that source text is joined directly to a rendered row
      // coordinate ("表5.1.4" + "3 | ..."), the display-only join looks like
      // the unrelated table number "5.1.43". Keep the bound table identity
      // and do not turn this deterministic formatting boundary into a false
      // hallucinated-reference failure.
      const fusedDeclaredRowCoordinate = Boolean(
        declaredReference
        && reference.startsWith(declaredReference)
        && /^\d+$/u.test(reference.slice(declaredReference.length))
        && /^\s*\|/u.test(afterReference),
      );
      if (fusedDeclaredRowCoordinate) continue;

      refs.push({ table_no: reference, field,
        raw_reference: field === "table_semantics.table_no" && !declared!.startsWith("表") ? match[0].slice(1) : match[0] });
    }
  }
  return refs;
}

function tableReferences(item: LedgerReconciliationItem): string[] {
  return [...new Set(tableReferenceOccurrences(item).map(reference => reference.table_no))];
}

export function reconcileLedgerCoverage(input: {
  ledger: DocumentLedger;
  items: readonly LedgerReconciliationItem[];
  /** 已由非计数 placeholder 或有真实接收 item 的已解析引用明确交代的父条文。 */
  accounted_clause_ids?: readonly string[];
  /** Verified business-field bindings; affect coverage only, never item-count exemptions. */
  field_covered_clause_ids?: readonly string[];
  /** Verified whole-clause lot scope. Never affects mandatory coverage or item counts. */
  scope_covered_clause_ids?: readonly string[];
  /** 证据清单：用于按行号把项目归属到底账条文，缺省时退回文本回捞。 */
  evidence?: ReadonlyArray<{ evidence_id: string; locator?: string }>;
}): LedgerReconciliation {
  const { ledger, items } = input;
  const lineIndex = input.evidence ? evidenceLineIndex(input.evidence) : undefined;
  // 必抽集用与 per-target 闸门同一个自适应判据，不再写死「带检查数量的条文」。
  //
  // 写死 has_quantity 时，全文这道闸门在整个语料上基本是装饰品：
  // GB 50242 / GB 50310 全书 0 条带「检查数量」（用主控/一般栏目组织），
  // 必抽集算出来是空的，missing 恒为空、ok 恒为真——**一条都没查过**；
  // GB 50210 是 7 条 vs 真实必抽 306 条，GB 50207 是 5 vs 177，GB 50208 是 21 vs 191。
  // 反过来在几本 A 类书上自适应集略小（50204 96→95、50303 227→225），
  // 差的那几条是附录/一般规定/整节转指——本就不该必抽，剔掉是纠正而非放松。
  const requiredClauseIds = ledger.clauses
    .filter(ledgerRequiredClausePredicate(ledger))
    .map((clause) => clause.clause_id);

  const ledgerClauseIds = ledgerClauseIdSet(ledger);
  const cited = items.map((item) => item.source_context?.clause_id ?? resolveItemClauseId(item, ledgerClauseIds, ledger, lineIndex));
  const derived_clause_count = items.filter((item, index) =>
    cited[index] !== "" && !normalizeClause(item.source_clause ?? "")
  ).length;
  const labeled = cited.filter(Boolean);
  const accountedClauseIds = [...new Set((input.accounted_clause_ids ?? [])
    .map(normalizeClause)
    .filter((clauseId) => ledgerClauseIds.has(clauseId)))];
  const fieldCoveredClauseIds = (input.field_covered_clause_ids ?? [])
    .map(normalizeClause).filter((id) => ledgerClauseIds.has(id));
  const citedSet = new Set([...items.flatMap((item, index) => item.source_context?.main_clause_ids ?? [cited[index]!]), ...accountedClauseIds, ...fieldCoveredClauseIds]);
  const covers = (clauseId: string): boolean =>
    citedSet.has(clauseId) || [...citedSet].some((value) => value.startsWith(`${clauseId}.`));
  const missing_clause_ids = requiredClauseIds.filter((clauseId) => !covers(clauseId));

  // 候选口径：按编号数出来的全部像验收条文的条文，与措辞无关。只报数、不参与 ok，
  // 用来把「规则看不见因而连问都不问」的那部分显形（见字段注释）。
  const candidateClauseIds = ledger.clauses
    .filter((clause) => clause.kind === "item_candidate")
    .map((clause) => clause.clause_id);
  const requiredClauseIdSet = new Set(requiredClauseIds);
  const scopeCovered = new Set(input.scope_covered_clause_ids ?? []);
  const scope_covered_candidate_clause_ids = candidateClauseIds.filter(id => scopeCovered.has(id) && !requiredClauseIdSet.has(id));
  const scopeCovers = (id: string) => scope_covered_candidate_clause_ids.includes(id);
  const coveredCandidates = candidateClauseIds.filter((clauseId) => covers(clauseId) || scopeCovers(clauseId));
  const unaccounted_candidate_clause_ids = candidateClauseIds.filter((clauseId) =>
    !covers(clauseId) && !scopeCovers(clauseId) && !requiredClauseIdSet.has(clauseId)
  );

  const extra_clause_ids = [...new Set(cited.filter((value, index) => value && (items[index]!.source_context
    ? !items[index]!.source_context!.clause_valid : !ledgerClauseIds.has(value))))];

  const captions = ledger.tables;
  const knownTables = new Set([
    ...(captions ?? []).map((table) => table.table_no),
    ...ledger.record_tables.map((table) => normalizeId(table.table_no.replace(/^表\s*/, ""))),
  ]);
  const referenced = [...new Set(items.flatMap(tableReferences))];
  const failedTableReferences = items.flatMap(item => item.source_context
    ? item.source_context.table_checks.filter(check => !check.ok).map(check => check.table_no)
    : captions === undefined ? [] : tableReferences(item).filter(ref => !knownTables.has(ref)));
  const unresolved_table_refs = [...new Set(failedTableReferences)];
  const table_reference_diagnostics = unresolved_table_refs.map(table_no => {
    const records = items.flatMap((item, aggregate_item_index) => tableReferenceOccurrences(item)
      .filter(reference => reference.table_no === table_no && (!item.source_context || item.source_context.table_checks.some(check =>
        check.table_no === table_no && check.field === reference.field && !check.ok))).map(reference => ({
        aggregate_item_index, ...(item.item_id ? { item_id: item.item_id } : {}),
        ...(item.target_id ? { target_id: item.target_id } : {}),
        ...(item.author_item_key ? { record_read: { tool: "read_target_selectors" as const,
          arguments: { collection: "items" as const, key: item.author_item_key } } } : {}),
        source_clause: resolveItemClauseId(item, ledgerClauseIds, ledger, lineIndex),
        field: reference.field, raw_reference: reference.raw_reference,
      })));
    const sourceClauses = ledger.clauses.filter(clause => tableReferences({ requirement: clause.text }).includes(table_no))
      .map(clause => ({ clause_id: clause.clause_id, ledger_line: clause.line, text: clause.text }));
    return { table_no,
      actual: { matching_caption_count: 0, affected_item_count: new Set(records.map(record => record.aggregate_item_index)).size,
        source_clause_occurrence_count: sourceClauses.length },
      expected: { matching_caption_count: "at_least_one_exact_identity" as const },
      affected_records: records.slice(0, 6), affected_records_complete: records.length <= 6,
      source_clauses: sourceClauses.slice(0, 6), source_clauses_complete: sourceClauses.length <= 6,
    };
  });

  const applicable = ledger.clauses.length > 0;
  const clause_identity_ok = !applicable || missing_clause_ids.length === 0;
  const hallucination_ok = !applicable || extra_clause_ids.length === 0;
  const unlabeled_item_count = cited.length - labeled.length;
  const item_count_ok = !applicable
    || (items.length >= requiredClauseIds.length - accountedClauseIds.length && unlabeled_item_count === 0);
  const table_identity_ok = unresolved_table_refs.length === 0;
  const source_diagnostics = items.flatMap(item => item.source_context?.diagnostics ?? []);
  const source_identity_ok = source_diagnostics.length === 0;

  return {
    schema_version: LEDGER_RECONCILIATION_SCHEMA_VERSION,
    required_clause_count: requiredClauseIds.length,
    candidate_clause_count: candidateClauseIds.length,
    covered_candidate_clause_count: coveredCandidates.length,
    unaccounted_candidate_clause_ids,
    scope_covered_candidate_clause_ids,
    item_count: items.length,
    labeled_item_count: labeled.length,
    unlabeled_item_count,
    covered_required_clause_count: requiredClauseIds.length - missing_clause_ids.length,
    derived_clause_count,
    missing_clause_ids,
    extra_clause_ids,
    table_reference_count: referenced.length,
    unresolved_table_refs,
    ...(table_reference_diagnostics.length ? { table_reference_diagnostics } : {}),
    ...(source_diagnostics.length ? { source_diagnostics } : {}),
    source_identity_ok,
    clause_identity_ok,
    hallucination_ok,
    item_count_ok,
    table_identity_ok,
    applicable,
    ok: clause_identity_ok && hallucination_ok && item_count_ok && table_identity_ok && source_identity_ok,
  };
}

export function formatLedgerReconciliation(report: LedgerReconciliation): string {
  if (!report.applicable) return `底账无条文，恒等式不适用：项目 ${report.item_count}`;
  const parts = [
    `条文对账 ${report.covered_required_clause_count}/${report.required_clause_count}`,
    `候选覆盖 ${report.covered_candidate_clause_count}/${report.candidate_clause_count}` + (report.unaccounted_candidate_clause_ids.length
      ? `（未交代 ${report.unaccounted_candidate_clause_ids.length} 条，仅诊断）`
      : ""),
    `项目 ${report.item_count}`,
  ];
  if (report.derived_clause_count) parts.push(`条文号回填 ${report.derived_clause_count}`);
  if (report.unlabeled_item_count) parts.push(`缺条文号 ${report.unlabeled_item_count}`);
  if (report.missing_clause_ids.length) {
    parts.push(`漏 ${report.missing_clause_ids.slice(0, 8).join("、")}${report.missing_clause_ids.length > 8 ? "…" : ""}`);
  }
  if (report.extra_clause_ids.length) {
    parts.push(`底账外条文 ${report.extra_clause_ids.slice(0, 5).join("、")}`);
  }
  if (report.unresolved_table_refs.length) {
    parts.push(`表引用未解析 ${report.unresolved_table_refs.slice(0, 5).join("、")}`);
  }
  return `${report.ok ? "恒等式通过" : "恒等式未通过"}：${parts.join("；")}`;
}
