import type {
  AcceptanceItemPlan,
  AcceptanceResult,
  EvidenceManifest,
  EvidenceRecord,
  MaterializedAcceptanceItem,
  ReferenceOccurrence,
  ReferenceResolution,
  SemanticSourcePlan,
  PersistedSemanticSourcePlan,
} from "./contracts.js";
import {
  samplingConfidenceForStatus,
  samplingScriptForStatus,
  supportedSamplingScript,
} from "./sampling-script.js";
import { hydrateSemanticSourcePlan, isCompactSemanticSourcePlan } from "./plan-hydration.js";
import {
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceLiterals,
  referenceOccurrenceOriginEvidenceIds,
  RESULT_SCHEMA_VERSION,
} from "./contracts.js";
import { sha256Json, sha256Text } from "./canonical.js";
import { createItemSourceAnchorReader } from "./item-source-order.js";
import { joinedFormalClauseId } from "./document-ledger.js";
import { semanticReferenceTargetNodesForDestination } from "./semantic-draft.js";
import {
  collapseHanTypesettingSpacing,
  normalizeMineruInlineMath,
} from "./text-normalization.js";

const MATERIALIZED_TEXT_FIELDS = [
  "name",
  "requirement",
  "method",
  "quantity",
  "note",
] as const;

const MAX_MATERIALIZATION_REFERENCE_DEPTH = 8;
const DOCUMENT_ANCHOR_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:(?:续\s*)?表\s*)?((?:(?:[A-Z]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ])\s*[.．]\s*)?\d+(?:\s*[.．]\s*\d+){1,3})(?=\s|[^\d.．]|$)/g;
const APPENDIX_ANCHOR_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?附录\s*([A-Z])(?=\s|[^A-Z]|$)/g;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueAdjacent(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    if (result.at(-1) !== value) result.push(value);
  }
  return result;
}

function normalizeDocumentNumber(value: string): string {
  return value.replaceAll("．", ".").replace(/\s+/g, "");
}

function comparableLocatorCharacter(value: string): string {
  return value === "．" ? "." : value;
}

export function stripRedundantSourceClausePrefix(
  value: string,
  sourceClause: string,
): string {
  const locator = [...sourceClause.trim()].filter((character) => !/\s/.test(character));
  if (!locator.length) return value;

  let valueIndex = 0;
  while (valueIndex < value.length && /\s/.test(value[valueIndex]!)) valueIndex += 1;
  for (const locatorCharacter of locator) {
    while (valueIndex < value.length && /\s/.test(value[valueIndex]!)) valueIndex += 1;
    if (
      valueIndex >= value.length
      || comparableLocatorCharacter(value[valueIndex]!)
        !== comparableLocatorCharacter(locatorCharacter)
    ) {
      return value;
    }
    valueIndex += 1;
  }
  if (/[\d.．]/.test(value[valueIndex] ?? "")) return value;

  let hasSeparator = false;
  while (valueIndex < value.length && /\s/.test(value[valueIndex]!)) {
    hasSeparator = true;
    valueIndex += 1;
  }
  if (/[:：、\-—]/.test(value[valueIndex] ?? "")) {
    hasSeparator = true;
    valueIndex += 1;
    while (valueIndex < value.length && /\s/.test(value[valueIndex]!)) valueIndex += 1;
  }
  if (!hasSeparator) return value;

  const title = value.slice(valueIndex).trim();
  return title || value;
}

function evidenceOffset(record: EvidenceRecord): number | undefined {
  const match = /^char:(\d+)-\d+$/.exec(record.locator);
  return match ? Number(match[1]) : undefined;
}

function evidenceLine(record: EvidenceRecord): number | undefined {
  const match = /^line:(\d+)(?:\/|$)/.exec(record.locator);
  return match ? Number(match[1]) : undefined;
}

function formalClauseAtLine(text: string): string {
  const normalized = text.trim().replace(/^#{1,6}\s+/, "");
  const match = /^((?:[A-Z]\s*[.．]\s*\d+(?:\s*[.．]\s*\d+){1,2})|(?:\d+(?:\s*[.．]\s*\d+){2,3}))(?=\s|[^\d.．]|$)/iu.exec(normalized);
  return normalizeDocumentNumber(match?.[1] ?? "");
}

function lineEndsFormalClauseOwnership(text: string): boolean {
  const heading = /^(#{1,6})\s+(.+)$/.exec(text.trim());
  if (!heading) return false;
  const depth = heading[1]!.length;
  const title = heading[2]!.replace(/\s*\[PDF p\.\d+\]\s*$/, "").trim();
  return /^\d+(?:\s*[.．]\s*\d+)\s+/.test(title)
    || (depth === 1 && /^\d+\s+/.test(title))
    || /^附录\s*[A-ZＡ-Ｚ]/iu.test(title)
    || /^(?:主\s*控|一\s*般)\s*项\s*目$/u.test(title);
}

function formalClauseOwnershipByLine(manifest: EvidenceManifest): ReadonlyMap<number, string> {
  const byLine = new Map<number, EvidenceRecord[]>();
  for (const record of manifest.evidence) {
    const line = evidenceLine(record);
    if (line === undefined) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), record]);
  }
  const ownership = new Map<number, string>();
  let activeClause = "";
  for (const [line, records] of [...byLine.entries()].sort((left, right) => left[0] - right[0])) {
    const candidates = unique(records.flatMap((record) => [
      normalizeDocumentNumber(record.clause_id ?? ""),
      formalClauseAtLine(record.text),
    ]));
    if (candidates.length === 1) activeClause = candidates[0]!;
    else if (candidates.length > 1 || records.some((record) => lineEndsFormalClauseOwnership(record.text))) {
      activeClause = "";
    }
    if (activeClause) ownership.set(line, activeClause);
  }
  return ownership;
}

interface DocumentAnchor {
  clause: string;
  offset: number;
}

function joinDistinctDisplay(values: string[], separator = " / "): string {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(separator);
}

interface DocumentLocator {
  locateCandidates: (evidenceId: string, exactFragment: string) => DocumentAnchor[];
  locateUnique: (evidenceId: string, exactFragment: string) => DocumentAnchor | undefined;
}

function buildDocumentLocator(
  manifest: EvidenceManifest,
): DocumentLocator {
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  const clauseOwnershipByLine = formalClauseOwnershipByLine(manifest);
  const anchors: DocumentAnchor[] = [];
  for (const record of manifest.evidence) {
    const start = evidenceOffset(record);
    if (start === undefined) continue;
    DOCUMENT_ANCHOR_RE.lastIndex = 0;
    for (const match of record.text.matchAll(DOCUMENT_ANCHOR_RE)) {
      anchors.push({
        clause: normalizeDocumentNumber(match[1]!),
        offset: start + match.index,
      });
    }
    APPENDIX_ANCHOR_RE.lastIndex = 0;
    for (const match of record.text.matchAll(APPENDIX_ANCHOR_RE)) {
      anchors.push({
        clause: `附录${match[1]}`,
        offset: start + match.index,
      });
    }
  }
  anchors.sort((left, right) => left.offset - right.offset);
  // 文档里真实出现过的条文号（行首形态），用来核验「片段自称的条文号」。
  // 不能复用上面的 anchors：那份只收了带 char: 偏移的证据，行级证据全被漏掉，
  // 拿它当白名单会把正当条文号误杀。
  const documentClauseIds = new Set<string>();
  for (const record of manifest.evidence) {
    DOCUMENT_ANCHOR_RE.lastIndex = 0;
    for (const match of record.text.matchAll(DOCUMENT_ANCHOR_RE)) {
      documentClauseIds.add(normalizeDocumentNumber(match[1]!));
    }
    APPENDIX_ANCHOR_RE.lastIndex = 0;
    for (const match of record.text.matchAll(APPENDIX_ANCHOR_RE)) {
      documentClauseIds.add(`附录${match[1]}`);
    }
  }

  const locateCandidates = (evidenceId: string, exactFragment: string): DocumentAnchor[] => {
    const record = evidenceById.get(evidenceId);
    if (!record) return [];
    const start = evidenceOffset(record);
    if (exactFragment && start !== undefined) {
      // A semantic fragment that carries its own clause number is more
      // authoritative than an earlier anchor in a wide evidence window. This
      // avoids a shared/background clause stealing the direct item's source.
      DOCUMENT_ANCHOR_RE.lastIndex = 0;
      const ownDocumentAnchors = [...exactFragment.matchAll(DOCUMENT_ANCHOR_RE)]
        .filter((match) => exactFragment.slice(0, match.index).trim() === "")
        .map((match) => ({
          clause: normalizeDocumentNumber(match[1]!),
          offset: start + match.index,
        }));
      APPENDIX_ANCHOR_RE.lastIndex = 0;
      const ownAppendixAnchors = [...exactFragment.matchAll(APPENDIX_ANCHOR_RE)]
        .filter((match) => exactFragment.slice(0, match.index).trim() === "")
        .map((match) => ({
          clause: `附录${match[1]}`,
          offset: start + match.index,
        }));
      // 片段开头长得像条文号，不等于它就是条文号：`2024.1 型设备性能` 的 `2024.1`
      // 是设备型号，`4.4.10mm厚板尺寸` 的 `4.4.10` 才是真条文号。两者形状完全一致，
      // 分辨不了形状就得核验来源——文档里以行首条文号形态出现过的才算数。
      // 不核验时 `2024.1` 会被当成 source_clause，进而被当作冗余前缀从名称里削掉，
      // 把设备型号从验收项目名里抹没。
      const ownAnchors = [...ownDocumentAnchors, ...ownAppendixAnchors]
        .filter((anchor) => documentClauseIds.has(anchor.clause));
      if (unique(ownAnchors.map((anchor) => anchor.clause)).length === 1) {
        return ownAnchors;
      }
      const located: DocumentAnchor[] = [];
      let searchFrom = 0;
      while (searchFrom <= record.text.length - exactFragment.length) {
        const fragmentOffset = record.text.indexOf(exactFragment, searchFrom);
        if (fragmentOffset < 0) break;
        const globalOffset = start + fragmentOffset;
        const preceding = anchors.findLast((anchor) => anchor.offset <= globalOffset);
        if (preceding) located.push(preceding);
        searchFrom = fragmentOffset + Math.max(1, exactFragment.length);
      }
      if (located.length) return located;
    }
    const line = evidenceLine(record);
    // Legacy preparation missed numbering joined to Han prose. Only that exact
    // source format overrides its stale derived metadata; other conflicts keep
    // the existing ownership policy.
    const clause = joinedFormalClauseId(record.text)
      || normalizeDocumentNumber(record.clause_id ?? "")
      || (line === undefined ? "" : clauseOwnershipByLine.get(line) ?? "");
    return clause ? [{ clause, offset: start ?? Number.MAX_SAFE_INTEGER }] : [];
  };
  const locateUnique = (evidenceId: string, exactFragment: string): DocumentAnchor | undefined => {
    const located = locateCandidates(evidenceId, exactFragment);
    const clauses = unique(located.map((anchor) => anchor.clause));
    if (clauses.length !== 1) return undefined;
    return located.find((anchor) => anchor.clause === clauses[0]);
  };
  return { locateCandidates, locateUnique };
}

function normalizeTableSemantics(
  table: AcceptanceItemPlan["table_semantics"],
): MaterializedAcceptanceItem["table_semantics"] {
  if (!table) return null;
  return {
    ...table,
    table_id: normalizeMineruInlineMath(table.table_id),
    table_no: normalizeMineruInlineMath(table.table_no),
    table_title: normalizeMineruInlineMath(table.table_title),
    applicability: normalizeMineruInlineMath(table.applicability),
    row_path: table.row_path.map(normalizeMineruInlineMath),
    column_path: table.column_path.map(normalizeMineruInlineMath),
    unit: normalizeMineruInlineMath(table.unit),
    condition: normalizeMineruInlineMath(table.condition),
    allowed_value: normalizeMineruInlineMath(table.allowed_value),
    ...(table.acceptance_branches?.length ? {
      acceptance_branches: table.acceptance_branches.map((branch) => ({
        ...branch,
        condition: normalizeMineruInlineMath(branch.condition),
        requirement: normalizeMineruInlineMath(branch.requirement),
        allowed_value: normalizeMineruInlineMath(branch.allowed_value),
        condition_fragments: branch.condition_fragments.map((fragment) => ({ ...fragment })),
        requirement_fragments: branch.requirement_fragments.map((fragment) => ({ ...fragment })),
        allowed_value_fragments: branch.allowed_value_fragments.map((fragment) => ({ ...fragment })),
      })),
    } : {}),
    inspection_method: normalizeMineruInlineMath(table.inspection_method),
    cell_evidence: table.cell_evidence.map((fragment) => ({ ...fragment })),
    reference_fragments: table.reference_fragments.map((fragment) => ({ ...fragment })),
  };
}

function referencedRowTableSemantics(
  record: EvidenceRecord,
  origin: EvidenceRecord,
  fields: ReturnType<typeof targetRowFields>,
  source: MaterializedAcceptanceItem,
): NonNullable<MaterializedAcceptanceItem["table_semantics"]> {
  const cells = record.cells ?? [];
  const columns = record.columns ?? [];
  const cellEvidence: NonNullable<MaterializedAcceptanceItem["table_semantics"]>["cell_evidence"] = [];
  const addFrom = (
    evidence: EvidenceRecord,
    role: NonNullable<MaterializedAcceptanceItem["table_semantics"]>["cell_evidence"][number]["role"],
    text: string,
  ): void => {
    const exact = text.trim();
    if (exact && evidence.text.includes(exact)) {
      cellEvidence.push({ role, evidence_id: evidence.evidence_id, text: exact });
    }
  };
  const add = (
    role: NonNullable<MaterializedAcceptanceItem["table_semantics"]>["cell_evidence"][number]["role"],
    text: string,
  ): void => addFrom(record, role, text);
  add("table_no", record.table_title ?? record.table_id ?? "");
  add("table_title", record.table_title ?? "");
  for (const cell of cells) {
    if (fields.name.includes(cell) && cell.trim()) add("row_header", cell);
    if (fields.requirement.includes(cell) && cell.trim()) add("allowed_value", cell);
  }
  for (const column of columns) {
    if (column.trim()) add("column_header", column);
  }
  add("inspection_method", fields.method);
  const unitMatch = /[（(]\s*([^（）()]*?(?:mm|cm|m|%|°|MPa|kN)[^（）()]*)\s*[）)]/i
    .exec(record.table_title ?? "");
  if (unitMatch?.[1]) add("unit", unitMatch[1]);
  if (!cellEvidence.some((fragment) => fragment.role === "row_header")) {
    add("row_header", record.text);
  }
  if (!cellEvidence.some((fragment) => fragment.role === "column_header")) {
    add("column_header", record.text);
  }
  if (!cellEvidence.some((fragment) => fragment.role === "allowed_value")) {
    add("allowed_value", record.text);
  }
  const applicability = record.text.includes(source.name)
    ? source.name
    : origin.text.includes(source.name)
      ? source.name
      : "";
  if (applicability) {
    addFrom(record.text.includes(applicability) ? record : origin, "applicability", applicability);
  }
  const semanticColumns = columns.filter((column, index) =>
    fields.requirement.includes(cells[index] ?? "") || /允许|限值|偏差|要求/.test(column)
  );
  return {
    source_kind: "reference",
    table_id: record.table_id || record.table_fragment_id || record.evidence_id,
    table_no: record.table_id ?? "",
    table_title: record.table_title ?? "",
    applicability,
    row_path: [fields.name],
    column_path: semanticColumns.length ? uniqueAdjacent(semanticColumns) : ["验收要求"],
    unit: unitMatch?.[1]?.trim() ?? "",
    condition: "",
    allowed_value: fields.requirement,
    inspection_method: fields.method,
    cell_evidence: cellEvidence,
    reference_fragments: [{ evidence_id: origin.evidence_id, text: origin.text }],
  };
}

interface ReferenceSourceSemantics {
  name: string;
  requirement: string;
  method: string;
}

function normalizedSemanticKey(value: string): string {
  return normalizeMineruInlineMath(value)
    .toLowerCase()
    .replace(/[（(][^）)]*(?:mm|cm|m|%)[^）)]*[）)]/gi, "")
    .replace(
      /允许值或允许偏差|允许值|允许偏差|检查项目|检验项目|检测项目|偏差|限值|要求|单位|数值/g,
      "",
    )
    .replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
}

function semanticKeyVariants(value: string): string[] {
  const key = normalizedSemanticKey(value);
  if (!key) return [];
  return unique([
    key,
    key.replaceAll("孔径", "桩径"),
    key.replaceAll("孔位", "桩位"),
    key.replace(/^桩垂直度/, "垂直度"),
  ]);
}

function semanticColumnScore(sourceName: string, column: string): number {
  const sourceKeys = semanticKeyVariants(sourceName);
  const columnKeys = semanticKeyVariants(column);
  let score = 0;
  for (const sourceKey of sourceKeys) {
    for (const columnKey of columnKeys) {
      if (sourceKey === columnKey) score = Math.max(score, 100 + sourceKey.length);
      else if (
        sourceKey.length >= 2 && columnKey.length >= 2
        && (sourceKey.includes(columnKey) || columnKey.includes(sourceKey))
      ) {
        score = Math.max(score, 50 + Math.min(sourceKey.length, columnKey.length));
      }
    }
  }
  return score;
}

function isStructuralReferenceColumn(column: string): boolean {
  const compact = column.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  return /检查方法|检验方法|检测方法/.test(column)
    || /^(项|序|序号|编号)$/.test(compact)
    || /单位|数值/.test(column);
}

function branchQualifiers(
  source: ReferenceSourceSemantics,
  branchName: string,
): string[] {
  const candidates: string[] = [];
  for (const match of source.requirement.matchAll(/（([^（）]+)）|\(([^()]+)\)/g)) {
    candidates.push((match[1] ?? match[2] ?? "").trim());
  }
  candidates.push(...source.method
    .split(/[，,；;。]/)
    .map((part) => part.trim())
    .filter((part) => /不包括|不含|除外|仅限|适用于/.test(part)));

  const branchKey = normalizedSemanticKey(branchName);
  return unique(candidates).filter((qualifier) => {
    const subject = qualifier.split(/不包括|不含|除外|仅限|适用于/, 1)[0] ?? "";
    const subjectKey = normalizedSemanticKey(subject);
    return subjectKey.length >= 2
      && (branchKey.includes(subjectKey) || subjectKey.includes(branchKey));
  });
}

function appendBranchQualifiers(
  requirement: string,
  source: ReferenceSourceSemantics,
  branchName: string,
): string {
  let result = requirement.trim();
  for (const qualifier of branchQualifiers(source, branchName)) {
    if (!result.includes(qualifier)) result += `（${qualifier}）`;
  }
  return result;
}

function legacyTargetRowFields(
  record: EvidenceRecord,
  category: "主控项目" | "一般项目" | undefined,
  methodIndex: number,
): {
  name: string;
  requirement: string;
  method: string;
  category?: "主控项目" | "一般项目";
} {
  const cells = record.cells ?? [];
  const columns = record.columns ?? [];
  const requirementStart = methodIndex >= 0
    ? Math.max(0, methodIndex - 2)
    : Math.max(0, cells.length - 1);
  const firstColumnIsSequence = /序|编号/.test(columns[0] ?? "");
  const nameStart = category ? 2 : firstColumnIsSequence ? 1 : 0;
  const name = uniqueAdjacent(cells.slice(nameStart, requirementStart)).join(" / ");
  const requirement = uniqueAdjacent(
    cells.slice(requirementStart, methodIndex >= 0 ? methodIndex : cells.length),
  ).join(" ");
  const method = methodIndex >= 0 ? cells[methodIndex]?.trim() ?? "" : "";
  if (!name) {
    throw new Error(`Referenced target row has no deterministic item name: ${record.evidence_id}`);
  }
  return { name, requirement, method, ...(category ? { category } : {}) };
}

function targetRowFields(
  record: EvidenceRecord,
  source: ReferenceSourceSemantics,
): {
  name: string;
  requirement: string;
  method: string;
  category?: "主控项目" | "一般项目";
} {
  const cells = record.cells ?? [];
  const columns = record.columns ?? [];
  if (!cells.length || record.table_row_kind !== "data") {
    throw new Error(`Referenced evidence is not a target-table data row: ${record.evidence_id}`);
  }
  const category = cells.find((cell) =>
    cell === "主控项目" || cell === "一般项目"
  ) as "主控项目" | "一般项目" | undefined;
  const methodIndex = columns.findLastIndex((column) =>
    /检查方法|检验方法|检测方法/.test(column)
  );
  const semanticColumn = columns
    .map((column, index) => ({ index, score: semanticColumnScore(source.name, column) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  if (!semanticColumn) {
    return legacyTargetRowFields(record, category, methodIndex);
  }

  const valueColumnIndexes = new Set(columns.flatMap((column, index) =>
    /允许值|允许偏差|偏差|限值/.test(column) ? [index] : []
  ));
  valueColumnIndexes.add(semanticColumn.index);
  const name = uniqueAdjacent(cells.filter((_cell, index) =>
    !valueColumnIndexes.has(index)
    && index !== methodIndex
    && !isStructuralReferenceColumn(columns[index] ?? "")
    && !/^(主控项目|一般项目)$/.test(cells[index] ?? "")
  )).join(" / ");
  if (!name) {
    return legacyTargetRowFields(record, category, methodIndex);
  }
  const requirement = appendBranchQualifiers(
    cells[semanticColumn.index]?.trim() ?? "",
    source,
    name,
  );
  const method = methodIndex >= 0 ? cells[methodIndex]?.trim() ?? "" : "";
  if (!requirement) {
    throw new Error(
      `Referenced target row has no value for ${source.name}: ${record.evidence_id}`,
    );
  }
  return { name, requirement, method, ...(category ? { category } : {}) };
}

function normalizeSampling(item: AcceptanceItemPlan): MaterializedAcceptanceItem["sampling"] {
  return {
    ...item.sampling,
    min_sampling: normalizeMineruInlineMath(item.sampling.min_sampling),
    script: samplingScriptForStatus(item.sampling.status, item.sampling.script),
    reason: normalizeMineruInlineMath(item.sampling.reason),
    confidence: samplingConfidenceForStatus(item.sampling.status, item.sampling.confidence),
    evidence_ids: [...item.sampling.evidence_ids],
    ...(item.sampling.rule_ids ? { rule_ids: [...item.sampling.rule_ids] } : {}),
    ...(item.sampling.branch_ids ? { branch_ids: [...item.sampling.branch_ids] } : {}),
    ...(item.sampling.applied_branches ? { applied_branches: item.sampling.applied_branches.map((branch) => ({
      ...branch,
      min_sampling: normalizeMineruInlineMath(branch.min_sampling),
      script: supportedSamplingScript(branch.script),
      conditions: branch.conditions.map((condition) => ({
        ...condition,
        text: normalizeMineruInlineMath(condition.text),
        exact_fragment: condition.exact_fragment,
      })),
      ...(branch.components ? { components: branch.components.map((component) => ({
        ...component,
        source_span_ids: [...component.source_span_ids],
        ...(component.source_fragments ? {
          source_fragments: component.source_fragments.map((fragment) => ({ ...fragment })),
        } : {}),
      })) } : {}),
      evidence_ids: [...branch.evidence_ids],
    })) } : {}),
  };
}

function baseItem(
  item: AcceptanceItemPlan,
  sourceClause: string,
): MaterializedAcceptanceItem {
  const normalizedName = normalizeMineruInlineMath(item.name);
  return {
    item_id: item.item_id,
    ...(item.name_path ? { name_path: [...item.name_path] } : {}),
    name: item.name_path ? item.name_path.join("\\") : collapseHanTypesettingSpacing(
      stripRedundantSourceClausePrefix(normalizedName, sourceClause),
    ),
    category: item.category,
    requirement: normalizeMineruInlineMath(item.requirement),
    method: normalizeMineruInlineMath(item.method),
    quantity: normalizeMineruInlineMath(item.quantity),
    note: normalizeMineruInlineMath(item.note),
    evidence_ids: [...item.evidence_ids],
    reference_evidence_ids: [...item.reference_evidence_ids],
    reference_resolution_ids: [],
    reference_origin_item_id: item.item_id,
    reference_path: [],
    source_clause: sourceClause,
    reference_source_clause: "",
    reference_from_clause: "",
    inline_references: [],
    table_semantics: normalizeTableSemantics(item.table_semantics),
    inspection_data_type: item.inspection_data_type ?? "review",
    inspection_data_type_reason: item.inspection_data_type_reason
      || "旧计划未包含检验数据类型的专业判断，物化时保留为待复核，不作推断。",
    inspection_data_type_evidence_ids: [
      ...(item.inspection_data_type_evidence_ids ?? item.evidence_ids),
    ],
    sampling: normalizeSampling(item),
  };
}

function resolutionForOccurrence(
  occurrence: ReferenceOccurrence,
  resolutions: Map<string, ReferenceResolution>,
): ReferenceResolution {
  const resolution = resolutions.get(occurrence.occurrence_id);
  if (!resolution) {
    throw new Error(`Validated plan unexpectedly lacks reference resolution ${occurrence.occurrence_id}`);
  }
  return resolution;
}

export function inlineReferenceEvidenceIdsForItem(
  item: AcceptanceItemPlan,
  occurrence: ReferenceOccurrence,
  evidenceById: ReadonlyMap<string, EvidenceRecord> = new Map(),
): string[] {
  const tableEvidenceIds = new Set([
    ...(item.table_semantics?.cell_evidence.map((entry) => entry.evidence_id) ?? []),
    ...(item.table_semantics?.reference_fragments.map((entry) => entry.evidence_id) ?? []),
  ]);
  const allowedValueEvidenceIds = item.table_semantics?.cell_evidence
    .filter((entry) => entry.role === "allowed_value")
    .map((entry) => entry.evidence_id) ?? [];
  const ownedTableTargets = occurrence.target_evidence_ids.filter((evidenceId) =>
    tableEvidenceIds.has(evidenceId)
  );
  if (ownedTableTargets.length > 0) return ownedTableTargets;

  const rowCoordinate = (evidenceId: string): string => {
    const locator = evidenceById.get(evidenceId)?.locator ?? "";
    const match = /^line:(\d+)\/(?:table-row:\d+|table:[^/]+\/row:\d+)$/u.exec(locator);
    if (!match) return "";
    const row = /(?:table-row:|\/row:)(\d+)$/u.exec(locator)?.[1] ?? "";
    return row ? `${match[1]}:${row}` : "";
  };
  const coordinateEvidenceIds = allowedValueEvidenceIds.length > 0
    ? allowedValueEvidenceIds
    : [...tableEvidenceIds];
  const ownedCoordinates = new Set(coordinateEvidenceIds
    .map(rowCoordinate)
    .filter(Boolean));
  const coordinateTargets = occurrence.target_evidence_ids.filter((evidenceId) =>
    ownedCoordinates.has(rowCoordinate(evidenceId))
  );
  return coordinateTargets.length > 0
    ? coordinateTargets
    : [...occurrence.target_evidence_ids];
}

export function materialize(
  persistedPlan: PersistedSemanticSourcePlan,
  manifest: EvidenceManifest,
  planFingerprint: string,
): { result: AcceptanceResult; provenance: unknown } {
  const plan: SemanticSourcePlan = hydrateSemanticSourcePlan(persistedPlan, manifest);
  const itemSourceAnchors = createItemSourceAnchorReader(persistedPlan, manifest);
  const itemById = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  let evidenceDisplayOffset = 0;
  const evidenceDisplayOffsets = new Map(manifest.evidence.map((record) => {
    const entry = [record.evidence_id, evidenceDisplayOffset] as const;
    evidenceDisplayOffset += record.text.length + 1;
    return entry;
  }));
  const semanticNodeById = new Map(
    (plan.semantic_evidence ?? []).map((node) => [node.semantic_id, node]),
  );
  const documentLocator = buildDocumentLocator(manifest);
  const locateFragment = documentLocator.locateUnique;
  const clauseCandidatesForSemanticIds = (semanticIds: string[]): string[] => unique(
    semanticIds.flatMap((semanticId) => {
      const node = semanticNodeById.get(semanticId);
      if (!node) return [];
      return documentLocator
        .locateCandidates(node.evidence_id, node.exact_fragment)
        .map((anchor) => anchor.clause);
    }),
  );
  const clauseResolutionForSemanticIds = (
    semanticIds: string[],
  ): { clause: string; conflict: boolean } => {
    const located = semanticIds.flatMap((semanticId) => {
      const node = semanticNodeById.get(semanticId);
      if (!node) return [];
      const anchor = locateFragment(node.evidence_id, node.exact_fragment);
      return anchor ? [anchor] : [];
    }).sort((left, right) => left.offset - right.offset);
    const clauses = unique(located.map((anchor) => anchor.clause));
    return {
      clause: clauses.length === 1 ? clauses[0]! : "",
      conflict: clauses.length > 1,
    };
  };
  const clauseForSemanticIds = (semanticIds: string[]): string =>
    clauseResolutionForSemanticIds(semanticIds).clause;
  const sourceClauseForItem = (item: AcceptanceItemPlan): string => {
    if (item.table_semantics?.source_kind === "direct") {
      const ownershipRoles = new Set([
        "table_no",
        "table_title",
        "row_header",
        "column_header",
        "allowed_value",
      ]);
      const tableClauses = unique(item.table_semantics.cell_evidence
        .filter((cell) => ownershipRoles.has(cell.role))
        .flatMap((cell) => documentLocator
          .locateCandidates(cell.evidence_id, cell.text)
          .map((anchor) => anchor.clause)));
      if (tableClauses.length === 1) return tableClauses[0]!;
      if (tableClauses.length > 1) return "";
    }
    const itemNodes = (plan.semantic_evidence ?? [])
      .filter((node) => node.materialized_item_id === item.item_id);
    const primaryNodes = itemNodes.filter((node) => node.role === "acceptance_item");
    // Selectors can bind shared qualifiers/notes alongside the criterion. Those
    // references must remain traceable without erasing an unambiguous direct
    // clause. Prefer explicitly primary source records, never the first number
    // found in the added context. Conflicting primary clauses remain unresolved.
    const judgmentNodes = primaryNodes.length ? primaryNodes : itemNodes;
    const scopedPrimaryNodes = judgmentNodes.filter(node =>
      evidenceById.get(node.evidence_id)?.evidence_scope === "primary");
    const semanticIds = (scopedPrimaryNodes.length ? scopedPrimaryNodes : judgmentNodes)
      .map((node) => node.semantic_id);
    const semanticClause = clauseResolutionForSemanticIds(semanticIds);
    if (semanticClause.conflict) return "";
    if (semanticClause.clause) return semanticClause.clause;
    const semanticCandidates = clauseCandidatesForSemanticIds(semanticIds);
    const bindingFragments = MATERIALIZED_TEXT_FIELDS.flatMap((field) =>
      item.field_bindings[field].source_fragments
    ).sort((left, right) => right.text.length - left.text.length);
    for (const fragment of bindingFragments) {
      const clauses = unique(documentLocator
        .locateCandidates(fragment.evidence_id, fragment.text)
        .map((anchor) => anchor.clause));
      if (
        clauses.length === 1
        && (!semanticCandidates.length || semanticCandidates.includes(clauses[0]!))
      ) {
        return clauses[0]!;
      }
    }
    return "";
  };
  const applySemanticReferenceTrace = (
    source: MaterializedAcceptanceItem,
  ): MaterializedAcceptanceItem => {
    const expansions = (plan.semantic_references ?? []).filter((entry) =>
      entry.status === "resolved"
      && entry.destination_bindings.some((destination) =>
        destination.item_id === source.item_id
      )
    );
    if (!expansions.length) return source;
    const targetNodes = expansions.flatMap((entry) =>
      semanticReferenceTargetNodesForDestination(
        entry.target_semantic_ids
          .map((semanticId) => semanticNodeById.get(semanticId))
          .filter((node) => node !== undefined),
        source.item_id,
      )
    );
    const itemTargetNodes = targetNodes.filter((node) =>
      (node.role === "acceptance_item" || node.role === "table_criterion")
      && node.materialized_item_id === source.item_id
    );
    const referencedTargetNodes = targetNodes.filter((node) =>
      node.role === "referenced_clause"
    );
    const targetEvidenceIdSet = new Set(targetNodes.map((node) => node.evidence_id));
    const sourcePlanItem = itemById.get(source.reference_origin_item_id);
    const bindingReferenceClauses = unique(MATERIALIZED_TEXT_FIELDS.flatMap((field) =>
      sourcePlanItem?.field_bindings[field].source_fragments
        .filter((fragment) => targetEvidenceIdSet.has(fragment.evidence_id))
        .flatMap((fragment) => documentLocator
          .locateCandidates(fragment.evidence_id, fragment.text)
          .map((anchor) => anchor.clause)) ?? []
    ));
    const bindingReferenceSourceClause = bindingReferenceClauses.length === 1
      ? bindingReferenceClauses[0]!
      : "";
    const referenceSourceClause = clauseForSemanticIds(
      itemTargetNodes.map((node) => node.semantic_id),
    ) || bindingReferenceSourceClause || clauseForSemanticIds(
      referencedTargetNodes.map((node) => node.semantic_id),
    ) || clauseForSemanticIds(
      targetNodes.map((node) => node.semantic_id),
    );
    const referenceFromClause = clauseForSemanticIds(
      expansions.map((entry) => entry.anchor_semantic_id),
    );
    const targetEvidenceIds = targetNodes.map((node) => node.evidence_id);
    return {
      ...source,
      reference_evidence_ids: unique([
        ...source.reference_evidence_ids,
        ...targetEvidenceIds,
      ]),
      reference_resolution_ids: unique([
        ...source.reference_resolution_ids,
        ...expansions.map((entry) => entry.expansion_id),
      ]),
      reference_path: unique([
        ...source.reference_path,
        ...expansions.map((entry) => entry.anchor_semantic_id),
      ]),
      source_clause: source.source_clause || referenceFromClause,
      reference_source_clause: referenceSourceClause,
      reference_from_clause: referenceFromClause || source.source_clause,
    };
  };
  const occurrenceByOrigin = new Map<string, ReferenceOccurrence[]>();
  for (const occurrence of manifest.reference_occurrences) {
    for (const originEvidenceId of referenceOccurrenceOriginEvidenceIds(occurrence)) {
      occurrenceByOrigin.set(originEvidenceId, [
        ...(occurrenceByOrigin.get(originEvidenceId) ?? []),
        occurrence,
      ]);
    }
  }
  const resolutionByOccurrence = new Map(
    plan.reference_resolutions.map((resolution) => [
      resolution.occurrence_id,
      resolution,
    ]),
  );

  const attachInlineReferences = (
    source: MaterializedAcceptanceItem,
    item: AcceptanceItemPlan,
  ): MaterializedAcceptanceItem => {
    const inlineReferences = plan.reference_resolutions.flatMap((resolution) => {
      if (resolution.application_mode !== "reference_only") return [];
      const occurrence = manifest.reference_occurrences.find((candidate) =>
        candidate.occurrence_id === resolution.occurrence_id
      );
      if (!occurrence) return [];
      const referenceLiteralSpanIds = referenceOccurrenceLiteralSpanIds(occurrence);
      const literals = referenceOccurrenceLiterals(occurrence);
      if (literals.length === 0 || literals.length !== referenceLiteralSpanIds.length) return [];
      const originRecords = literals.map((literal) => evidenceById.get(literal.evidence_id));
      if (originRecords.some((record) => !record)) return [];
      if (literals.some((literal, index) => {
        const record = originRecords[index]!;
        return literal.evidence_id !== record.evidence_id
          || literal.start < 0
          || literal.end <= literal.start
          || literal.end > record.text.length;
      })) return [];
      const literal = literals[0]!;
      const referenceLiteralSpanId = referenceLiteralSpanIds[0]!;
      const originRecord = originRecords[0]!;
      return resolution.destination_bindings.flatMap((destination) => {
        if (destination.item_id !== item.item_id || destination.target_field === "reference_only") return [];
        const selectedTargetEvidenceIds = new Set(resolution.target_evidence_ids);
        const records = inlineReferenceEvidenceIdsForItem(item, occurrence, evidenceById)
          .filter((evidenceId) => selectedTargetEvidenceIds.has(evidenceId))
          .flatMap((evidenceId) => {
          const record = evidenceById.get(evidenceId);
          return record ? [{
            evidence_id: record.evidence_id,
            kind: record.kind,
            role: record.role,
            locator: record.locator,
            text: record.text,
            ...(record.table_id ? { table_id: record.table_id } : {}),
            ...(record.table_title ? { table_title: record.table_title } : {}),
            ...(record.row_index !== undefined ? { row_index: record.row_index } : {}),
            ...(record.columns ? { columns: [...record.columns] } : {}),
            ...(record.cells ? { cells: [...record.cells] } : {}),
          }] : [];
        });
        const target = occurrence.reference_kind === "table"
          ? {
              source_id: occurrence.target_address?.source_id ?? manifest.source.sha256,
              kind: "table" as const,
              locator: occurrence.target_address?.locator ?? `table:${occurrence.target_table_id}`,
            }
          : {
              source_id: occurrence.target_address.source_id,
              kind: occurrence.target_address.locator_kind,
              locator: occurrence.target_address.locator,
            };
        return [{
          occurrence_id: occurrence.occurrence_id,
          resolution_id: resolution.resolution_id,
          field: destination.target_field,
          display_order: (evidenceDisplayOffsets.get(literal.evidence_id) ?? 0) + literal.start,
          raw_reference: occurrence.raw_reference,
          ...(occurrence.external_standard ? { external_standard: occurrence.external_standard } : {}),
          ...(occurrence.normalized_reference ? { normalized_reference: occurrence.normalized_reference } : {}),
          origin_evidence_id: occurrence.origin_evidence_id,
          ...(originRecords.length > 1 ? { origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence) } : {}),
          relation: occurrence.relation ?? resolution.action,
          import_scope: resolution.import_scope,
          reference_literal_span_id: referenceLiteralSpanId,
          ...(referenceLiteralSpanIds.length > 1 ? { reference_literal_span_ids: referenceLiteralSpanIds } : {}),
          reference_literal: { ...literal },
          ...(literals.length > 1 ? { reference_literals: literals.map((entry) => ({ ...entry })) } : {}),
          target,
          ...(originRecord.table_id || originRecord.row_index !== undefined
            || originRecord.columns || originRecord.cells
            ? { origin_structure: {
                ...(originRecord.table_id ? { table_id: originRecord.table_id } : {}),
                ...(originRecord.row_index !== undefined ? { row_index: originRecord.row_index } : {}),
                ...(originRecord.columns ? { columns: [...originRecord.columns] } : {}),
                ...(originRecord.cells ? { cells: [...originRecord.cells] } : {}),
              } }
            : {}),
          segments: literals.flatMap((entry, index) => {
            const record = originRecords[index]!;
            return [
              { kind: "source" as const, evidence_id: record.evidence_id, text: record.text.slice(0, entry.start), start: 0, end: entry.start },
              {
                kind: "reference" as const,
                evidence_id: record.evidence_id,
                raw_reference: record.text.slice(entry.start, entry.end),
                span_id: referenceLiteralSpanIds[index]!,
                occurrence_id: occurrence.occurrence_id,
              },
              { kind: "source" as const, evidence_id: record.evidence_id, text: record.text.slice(entry.end), start: entry.end, end: record.text.length },
            ];
          }),
          resolved_content: { records },
        }];
      });
    }).sort((left, right) =>
      String(left.field).localeCompare(String(right.field))
      || left.display_order - right.display_order
      || left.occurrence_id.localeCompare(right.occurrence_id)
    );
    if (!inlineReferences.length) return source;
    return {
      ...source,
      inline_references: [...(source.inline_references ?? []), ...inlineReferences],
      reference_evidence_ids: unique([
        ...source.reference_evidence_ids,
        ...inlineReferences.flatMap((reference) =>
          reference.resolved_content.records.map((record) => record.evidence_id)
        ),
      ]),
      reference_resolution_ids: unique([
        ...source.reference_resolution_ids,
        ...inlineReferences.map((reference) => reference.resolution_id),
      ]),
    };
  };

  const expandResolution = (
    source: MaterializedAcceptanceItem,
    resolution: ReferenceResolution,
    visited: Set<string>,
  ): MaterializedAcceptanceItem[] => {
    if (visited.size >= MAX_MATERIALIZATION_REFERENCE_DEPTH) {
      throw new Error("Reference materialization exceeded its deterministic depth limit");
    }
    if (visited.has(resolution.occurrence_id)) {
      throw new Error(`Reference materialization cycle at ${resolution.occurrence_id}`);
    }
    const occurrence = manifest.reference_occurrences.find((candidate) =>
      candidate.occurrence_id === resolution.occurrence_id
    );
    if (!occurrence || occurrence.status !== "resolved") {
      throw new Error(`Reference occurrence is not materializable: ${resolution.occurrence_id}`);
    }
    const originRecord = evidenceById.get(occurrence.origin_evidence_id);
    if (!originRecord) {
      throw new Error(`Reference occurrence lacks origin evidence: ${occurrence.origin_evidence_id}`);
    }
    const nextVisited = new Set(visited).add(resolution.occurrence_id);
    const rows = resolution.target_evidence_ids.map((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      if (!record) throw new Error(`Missing selected target evidence ${evidenceId}`);
      return record;
    });

    if (resolution.application_mode === "reference_only") {
      const targetClause = resolution.target_evidence_ids
        .map((evidenceId) => locateFragment(evidenceId, ""))
        .find(Boolean)?.clause ?? "";
      return [{
        ...source,
        reference_evidence_ids: unique([
          ...source.reference_evidence_ids,
          ...resolution.target_evidence_ids,
        ]),
        reference_resolution_ids: unique([
          ...source.reference_resolution_ids,
          resolution.resolution_id,
        ]),
        reference_path: [...source.reference_path, occurrence.reference_kind === "table"
          ? occurrence.target_table_id
          : occurrence.target_address.locator],
        reference_source_clause: targetClause,
        reference_from_clause: source.source_clause,
      }];
    }

    if (resolution.application_mode === "replace_field") {
      if (rows.length !== 1) {
        throw new Error("replace_field requires exactly one selected target data row");
      }
      const fields = targetRowFields(rows[0]!, source);
      const targetClause = locateFragment(rows[0]!.evidence_id, rows[0]!.text)?.clause ?? "";
      return [{
        ...source,
        ...(occurrence.origin_fields.includes("name") ? { name: fields.name } : {}),
        ...(occurrence.origin_fields.includes("requirement")
          ? { requirement: fields.requirement }
          : {}),
        ...(occurrence.origin_fields.includes("method") ? { method: fields.method } : {}),
        reference_evidence_ids: unique([
          ...source.reference_evidence_ids,
          rows[0]!.evidence_id,
        ]),
        reference_resolution_ids: unique([
          ...source.reference_resolution_ids,
          resolution.resolution_id,
        ]),
        reference_path: [...source.reference_path, occurrence.reference_kind === "table"
          ? occurrence.target_table_id
          : occurrence.target_address.locator],
        source_clause: targetClause || source.source_clause,
        reference_source_clause: targetClause,
        reference_from_clause: source.source_clause,
      }];
    }

    return rows.flatMap((record) => {
      const fields = targetRowFields(record, source);
      const targetClause = locateFragment(record.evidence_id, record.text)?.clause ?? "";
      const pathEvidence = [...source.reference_evidence_ids, record.evidence_id];
      const derived: MaterializedAcceptanceItem = {
        ...source,
        item_id: `item:${sha256Text(
          `${source.reference_origin_item_id}|${pathEvidence.join("|")}`,
        ).slice(0, 32)}`,
        name: normalizeMineruInlineMath(joinDistinctDisplay([source.name, fields.name])),
        category: source.category,
        ...(occurrence.origin_fields.includes("requirement")
          ? { requirement: normalizeMineruInlineMath(fields.requirement) }
          : {}),
        method: normalizeMineruInlineMath(fields.method || source.method),
        evidence_ids: unique([...source.evidence_ids, record.evidence_id]),
        reference_evidence_ids: unique(pathEvidence),
        reference_resolution_ids: unique([
          ...source.reference_resolution_ids,
          resolution.resolution_id,
        ]),
        reference_path: [...source.reference_path, occurrence.reference_kind === "table"
          ? occurrence.target_table_id
          : occurrence.target_address.locator],
        source_clause: targetClause || source.source_clause,
        reference_source_clause: targetClause,
        reference_from_clause: source.source_clause,
        table_semantics: referencedRowTableSemantics(
          record,
          originRecord,
          fields,
          source,
        ),
      };
      const nested = occurrenceByOrigin.get(record.evidence_id) ?? [];
      if (!nested.length) return [derived];
      let materialized = [derived];
      for (const nestedOccurrence of nested) {
        const nestedResolution = resolutionForOccurrence(
          nestedOccurrence,
          resolutionByOccurrence,
        );
        materialized = materialized.flatMap((candidate) =>
          expandResolution(candidate, nestedResolution, nextVisited)
        );
      }
      return materialized;
    });
  };

  const inspectionLots = plan.inspection_lots.map((lot) => ({
    lot_id: lot.lot_id,
    name: collapseHanTypesettingSpacing(normalizeMineruInlineMath(lot.name)),
    evidence_ids: [...lot.evidence_ids],
    items: lot.item_ids.flatMap((itemId) => {
      const item = itemById.get(itemId);
      if (!item) {
        throw new Error(`Validated plan unexpectedly lacks item ${itemId}`);
      }
      const source = attachInlineReferences(
        applySemanticReferenceTrace(baseItem(item, sourceClauseForItem(item))),
        item,
      );
      return [{ ...source, source_anchors: itemSourceAnchors(item) }];
    }),
  }));
  if (isCompactSemanticSourcePlan(persistedPlan)) {
    const compactItemById = new Map(persistedPlan.acceptance_items.map((item) => [item.item_id, item]));
    for (const lot of inspectionLots) {
      for (const item of lot.items) {
        const compactItem = compactItemById.get(item.reference_origin_item_id || item.item_id);
        const compactBranches = compactItem?.sampling.applied_branches ?? [];
        if (!item.sampling.applied_branches || compactBranches.length === 0) continue;
        item.sampling.applied_branches = item.sampling.applied_branches.map((branch) => {
          const compact = compactBranches.find((candidate) => (
            candidate.rule_id === branch.rule_id && candidate.branch_id === branch.branch_id
          ));
          return compact
            ? { ...branch, components: compact.effective_components.map((component) => {
                const hydrated = branch.components?.find((candidate) => (
                  candidate.key === component.key && candidate.role === component.role
                ));
                return {
                  ...component,
                  ...(hydrated?.source_fragments ? {
                    source_fragments: hydrated.source_fragments.map((fragment) => ({ ...fragment })),
                  } : {}),
                };
              }) }
            : branch;
        });
      }
    }
  }
  const result: AcceptanceResult = {
    schema_version: RESULT_SCHEMA_VERSION,
    job_id: plan.job_id,
    target_id: plan.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly_fingerprint: sha256Json(persistedPlan.table_assembly),
    plan_fingerprint: planFingerprint,
    reference_occurrences: manifest.reference_occurrences,
    inspection_lots: inspectionLots,
  };
  const materializedItems = inspectionLots.flatMap((lot) =>
    lot.items.map((item) => ({ lot_id: lot.lot_id, item }))
  );
  const deterministicTransform = (
    item: MaterializedAcceptanceItem,
    sourcePlanItem: AcceptanceItemPlan | undefined,
    field: typeof MATERIALIZED_TEXT_FIELDS[number],
  ): string => {
    if (!sourcePlanItem) {
      return item.reference_path.length
        ? "reference_expansion_and_mineru_inline_math_to_unicode"
        : "identity";
    }
    const transforms: string[] = [];
    if (item.reference_path.length) {
      transforms.push("reference_expansion", "mineru_inline_math_to_unicode");
    }
    const normalizedSource = normalizeMineruInlineMath(sourcePlanItem[field]);
    if (normalizedSource !== sourcePlanItem[field]) {
      transforms.push("mineru_inline_math_to_unicode");
    }
    if (field === "name") {
      const projectedSource = unique([
        item.reference_from_clause,
        item.source_clause,
      ]).reduce(
        (current, locator) => stripRedundantSourceClausePrefix(current, locator),
        normalizedSource,
      );
      if (collapseHanTypesettingSpacing(projectedSource) !== projectedSource) {
        transforms.push("han_typesetting_spacing_collapsed");
      }
      if (projectedSource !== normalizedSource) {
        transforms.push("source_clause_prefix_removed_from_name");
      }
    }
    if (!transforms.length && sourcePlanItem[field] !== item[field]) {
      transforms.push("mineru_inline_math_to_unicode");
    }
    return transforms.length ? unique(transforms).join("_and_") : "identity";
  };
  const provenance = {
    schema_version: "acceptance-provenance/v4",
    job_id: plan.job_id,
    target_id: plan.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly_fingerprint: sha256Json(persistedPlan.table_assembly),
    plan_fingerprint: planFingerprint,
    reference_occurrences: manifest.reference_occurrences,
    ...(isCompactSemanticSourcePlan(persistedPlan)
      ? { source_spans: persistedPlan.source_spans }
      : {}),
    semantic_draft: {
      schema_version: manifest.source.semantic_workflow ?? "not-required",
      semantic_evidence: plan.semantic_evidence ?? [],
      semantic_references: plan.semantic_references ?? [],
      shared_sampling_rules: plan.shared_sampling_rules ?? [],
    },
    lots: Object.fromEntries(
      plan.inspection_lots.map((lot) => [
        lot.lot_id,
        { source: "semantic-source-plan.json", evidence_ids: lot.evidence_ids },
      ]),
    ),
    items: Object.fromEntries(materializedItems.map(({ lot_id: lotId, item }) => {
      const sourcePlanItem = itemById.get(item.reference_origin_item_id);
      return [item.item_id, {
        source: "semantic-source-plan.json+deterministic-reference-materializer",
        source_plan_item_id: item.reference_origin_item_id,
        lot_id: lotId,
        evidence_ids: item.evidence_ids,
        reference_evidence_ids: item.reference_evidence_ids,
        reference_resolution_ids: item.reference_resolution_ids,
        reference_path: item.reference_path,
        inline_references: item.inline_references ?? [],
        table_semantics: item.table_semantics,
        inspection_data_type: item.inspection_data_type,
        inspection_data_type_reason: item.inspection_data_type_reason,
        inspection_data_type_evidence_ids: item.inspection_data_type_evidence_ids,
        field_bindings: sourcePlanItem?.field_bindings ?? {},
        materialized_fields: Object.fromEntries(
          MATERIALIZED_TEXT_FIELDS.map((field) => [
            field,
            {
              materialized_value_sha256: sha256Text(item[field]),
              deterministic_transform: deterministicTransform(
                item,
                sourcePlanItem,
                field,
              ),
            },
          ]),
        ),
        sampling_evidence_ids: item.sampling.evidence_ids,
        sampling_occurrence_ids: item.sampling.evidence_ids.flatMap(
          (evidenceId) => {
            const occurrence = evidenceById.get(evidenceId)?.sampling_occurrence;
            return occurrence ? [occurrence.occurrence_id] : [];
          },
        ),
      }];
    })),
  };
  return { result, provenance };
}
