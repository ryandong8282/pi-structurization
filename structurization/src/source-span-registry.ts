import { canonicalize, sha256Text } from "./canonical.js";

export const SOURCE_SPAN_REGISTRY_SCHEMA_VERSION = "source-span-registry/v1" as const;

export interface SourceSpanRecord {
  span_id: string;
  evidence_id: string;
  atom_id: string;
  start: number;
  end: number;
  text_sha256: string;
}

export interface SourceSpanRegistry {
  schema_version: typeof SOURCE_SPAN_REGISTRY_SCHEMA_VERSION;
  source_fingerprint: string;
  spans: SourceSpanRecord[];
}

export interface ImmutableTextSource {
  source_id: string;
  text: string;
  evidence_id?: string;
  atom_id?: string;
}

export interface ResolvedSourceSpan extends SourceSpanRecord {
  text: string;
}

/** Source coordinates only; shared by authored and compiled coverage checks. */
export function sourceSpanCoveredBy(
  target: Pick<SourceSpanRecord, "evidence_id" | "start" | "end">,
  coverageSpans: readonly Pick<SourceSpanRecord, "evidence_id" | "start" | "end">[],
): boolean {
  return sourceSpanGaps(target, coverageSpans).length === 0;
}

/** Exact missing intervals, shared with the diagnostic returned to the model. */
export function sourceSpanGaps(
  target: Pick<SourceSpanRecord, "evidence_id" | "start" | "end">,
  coverageSpans: readonly Pick<SourceSpanRecord, "evidence_id" | "start" | "end">[],
): Array<{ start: number; end: number }> {
  const intervals = coverageSpans
    .filter((span) => span.evidence_id === target.evidence_id && span.end > target.start && span.start < target.end)
    .map((span) => [Math.max(span.start, target.start), Math.min(span.end, target.end)] as const)
    .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let cursor = target.start;
  const gaps: Array<{ start: number; end: number }> = [];
  for (const [start, end] of intervals) {
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
    if (cursor >= target.end) break;
  }
  if (cursor < target.end) gaps.push({ start: cursor, end: target.end });
  return gaps;
}

export interface HtmlTableCellSpan {
  table_index: number;
  row_index: number;
  column_index: number;
  row_span: number;
  column_span: number;
  start: number;
  end: number;
  table_start: number;
  table_end: number;
  text: string;
  inherited_cell_indices: number[];
}

export interface SourceSpanIssue {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}

export class SourceSpanRegistryError extends Error {
  constructor(public readonly issues: SourceSpanIssue[]) {
    super(`Source span registry failed with ${issues.length} issue(s)`);
  }
}

export function initialSourceSpanRegistry(sourceFingerprint: string): SourceSpanRegistry {
  return {
    schema_version: SOURCE_SPAN_REGISTRY_SCHEMA_VERSION,
    source_fingerprint: sourceFingerprint,
    spans: [],
  };
}

export function registryWithFullSourceSpans(
  sourceFingerprint: string,
  sources: ImmutableTextSource[],
): SourceSpanRegistry {
  let registry = initialSourceSpanRegistry(sourceFingerprint);
  for (const source of sources) {
    if (!source.text) continue;
    registry = registerSourceSpan(registry, source, 0, source.text.length).registry;
  }
  return registry;
}

function htmlPositiveSpan(attributes: string, name: "rowspan" | "colspan"): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attributes);
  const value = match ? Number(match[1]) : 1;
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : 1;
}

/**
 * Parses only mechanical HTML table geometry. It never assigns business roles.
 * Offsets select the immutable bytes inside each td/th so the returned spans can
 * be used as exact provenance. Spanning ancestors are exposed as candidates for
 * a caller/model to bind explicitly; no header text is inferred from wording.
 */
export function htmlTableCellSpans(source: string): HtmlTableCellSpan[] {
  const result: HtmlTableCellSpan[] = [];
  const tables = [...source.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  tables.forEach((tableMatch, tableIndex) => {
    const tableSource = tableMatch[0];
    const tableStart = tableMatch.index ?? 0;
    const tableEnd = tableStart + tableSource.length;
    const rows = [...tableSource.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const occupied = new Map<string, number>();
    const tableCellIndices: number[] = [];
    rows.forEach((rowMatch, rowIndex) => {
      const rowSource = rowMatch[1] ?? "";
      const rowContentStart = tableStart + (rowMatch.index ?? 0) + rowMatch[0].indexOf(">") + 1;
      const cells = [...rowSource.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)];
      let columnIndex = 0;
      for (const cellMatch of cells) {
        while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
        const attributes = cellMatch[1] ?? "";
        const content = cellMatch[2] ?? "";
        const cellStart = rowContentStart + (cellMatch.index ?? 0) + cellMatch[0].indexOf(">") + 1;
        const rowSpan = htmlPositiveSpan(attributes, "rowspan");
        const columnSpan = htmlPositiveSpan(attributes, "colspan");
        const resultIndex = result.length;
        const directParents = tableCellIndices.filter((candidateIndex) => {
          const candidate = result[candidateIndex]!;
          if (candidate.row_index >= rowIndex) return false;
          const activeRowParent = candidate.row_span > 1
            && candidate.row_index + candidate.row_span > rowIndex
            && candidate.column_index <= columnIndex;
          const spanningColumnParent = candidate.column_span > 1
            && candidate.row_index + 1 === rowIndex
            && candidate.column_index <= columnIndex
            && candidate.column_index + candidate.column_span > columnIndex
            && !tableCellIndices.some((blockerIndex) => {
              const blocker = result[blockerIndex]!;
              return blocker.row_index > candidate.row_index
                && blocker.row_index < rowIndex
                && blocker.column_index <= columnIndex
                && blocker.column_index + blocker.column_span > columnIndex;
            });
          return activeRowParent || spanningColumnParent;
        });
        const inherited = [...new Set(directParents.flatMap((parentIndex) => [
          ...result[parentIndex]!.inherited_cell_indices.filter((ancestorIndex) =>
            result[ancestorIndex]!.row_span > 1
          ),
          parentIndex,
        ]))];
        result.push({
          table_index: tableIndex,
          row_index: rowIndex,
          column_index: columnIndex,
          row_span: rowSpan,
          column_span: columnSpan,
          start: cellStart,
          end: cellStart + content.length,
          table_start: tableStart,
          table_end: tableEnd,
          text: content.replace(/<[^>]+>/g, "").trim(),
          inherited_cell_indices: inherited,
        });
        tableCellIndices.push(resultIndex);
        for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
          for (let column = columnIndex; column < columnIndex + columnSpan; column += 1) {
            occupied.set(`${row}:${column}`, resultIndex);
          }
        }
        columnIndex += columnSpan;
      }
    });
  });
  return result;
}

export function registerHtmlTableCellSpans(
  registry: SourceSpanRegistry,
  sources: ImmutableTextSource[],
): { registry: SourceSpanRegistry; registered_span_ids: string[] } {
  let current = registry;
  const registeredSpanIds: string[] = [];
  for (const source of sources) {
    for (const cell of htmlTableCellSpans(source.text)) {
      if (cell.end <= cell.start) continue;
      const registered = registerSourceSpan(current, source, cell.start, cell.end);
      current = registered.registry;
      registeredSpanIds.push(registered.span.span_id);
    }
  }
  return { registry: current, registered_span_ids: [...new Set(registeredSpanIds)].sort() };
}

export function sourceSpanIdFor(sourceId: string, start: number, end: number, textSha256: string): string {
  return `span:${sha256Text(`${sourceId}\0${start}\0${end}\0${textSha256}`).slice(0, 32)}`;
}

export function registerSourceSpan(
  registry: SourceSpanRegistry,
  source: ImmutableTextSource,
  start: number,
  end: number,
): { registry: SourceSpanRegistry; span: SourceSpanRecord } {
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end <= start
    || end > source.text.length
  ) {
    throw new SourceSpanRegistryError([{
      code: "selector_span_out_of_bounds",
      path: "/span",
      message: "Span offsets must select non-empty text inside the immutable source",
      details: { source_id: source.source_id, start, end, text_length: source.text.length },
    }]);
  }
  const text = source.text.slice(start, end);
  const textSha256 = sha256Text(text);
  const span: SourceSpanRecord = {
    span_id: sourceSpanIdFor(source.source_id, start, end, textSha256),
    evidence_id: source.evidence_id ?? source.source_id,
    atom_id: source.atom_id ?? source.source_id,
    start,
    end,
    text_sha256: textSha256,
  };
  const existing = registry.spans.find((candidate) => candidate.span_id === span.span_id);
  if (existing) return { registry, span: existing };
  return {
    registry: {
      ...registry,
      spans: [...registry.spans, span].sort((left, right) => left.span_id.localeCompare(right.span_id)),
    },
    span,
  };
}

interface NormalizedSourceView {
  text: string;
  startOffsets: number[];
  endOffsets: number[];
}

const PAGE_MARKER_AT_START_RE = /^<!--\s*pages?[^>]*-->/iu;

function normalizedSourceView(value: string): NormalizedSourceView {
  let text = "";
  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const marker = PAGE_MARKER_AT_START_RE.exec(value.slice(offset));
    if (marker) {
      offset += marker[0].length;
      continue;
    }
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const endOffset = offset + sourceCharacter.length;
    for (const normalizedCharacter of sourceCharacter.normalize("NFKC")) {
      if (/\s|[*_`#]/u.test(normalizedCharacter)) continue;
      text += normalizedCharacter;
      startOffsets.push(offset);
      endOffsets.push(endOffset);
    }
    offset = endOffset;
  }
  return { text, startOffsets, endOffsets };
}

export function locateSourceQuote(
  sourceText: string,
  quote: string,
): Array<{ start: number; end: number; text: string; normalized: boolean }> {
  if (!quote) return [];
  const exact: Array<{ start: number; end: number; text: string; normalized: boolean }> = [];
  for (let offset = 0; offset <= sourceText.length - quote.length;) {
    const start = sourceText.indexOf(quote, offset);
    if (start < 0) break;
    exact.push({ start, end: start + quote.length, text: quote, normalized: false });
    offset = start + 1;
  }
  if (exact.length) return exact;
  const source = normalizedSourceView(sourceText);
  const needle = normalizedSourceView(quote).text;
  if (!needle) return [];
  const matches: Array<{ start: number; end: number; text: string; normalized: boolean }> = [];
  for (let offset = 0; offset <= source.text.length - needle.length;) {
    const found = source.text.indexOf(needle, offset);
    if (found < 0) break;
    const start = source.startOffsets[found]!;
    const end = source.endOffsets[found + needle.length - 1]!;
    matches.push({ start, end, text: sourceText.slice(start, end), normalized: true });
    offset = found + 1;
  }
  return matches;
}

export function locateAndRegisterSourceQuote(
  registry: SourceSpanRegistry,
  source: ImmutableTextSource,
  quote: string,
  context: { prefix?: string; suffix?: string } = {},
): { registry: SourceSpanRegistry; spans: SourceSpanRecord[]; normalized: boolean; disambiguated: boolean } {
  const allMatches = locateSourceQuote(source.text, quote);
  const prefix = context.prefix ?? "";
  const suffix = context.suffix ?? "";
  const matches = prefix || suffix
    ? allMatches.filter((match) =>
        (!prefix || source.text.slice(0, match.start).endsWith(prefix))
        && (!suffix || source.text.slice(match.end).startsWith(suffix)))
    : allMatches;
  if (matches.length !== 1) {
    const contextMismatch = allMatches.length > 0 && matches.length === 0;
    const badPrefix = !!prefix && allMatches.every(match => !source.text.slice(0, match.start).endsWith(prefix));
    const badSuffix = !!suffix && allMatches.every(match => !source.text.slice(match.end).startsWith(suffix));
    const contextCharacterLimit = 384;
    const candidates = allMatches.slice(0, 12).map((match) => {
      let contextLength = 48;
      while (true) {
        const candidatePrefix = source.text.slice(Math.max(0, match.start - contextLength), match.start);
        const candidateSuffix = source.text.slice(match.end, Math.min(source.text.length, match.end + contextLength));
        // Validate against every quote match, including those omitted from this bounded receipt.
        const contextMatchCount = allMatches.filter((other) =>
          (!candidatePrefix || source.text.slice(0, other.start).endsWith(candidatePrefix))
          && (!candidateSuffix || source.text.slice(other.end).startsWith(candidateSuffix))).length;
        const contextWindowTruncated = match.start > contextLength || source.text.length - match.end > contextLength;
        if (contextMatchCount === 1 || !contextWindowTruncated || contextLength === contextCharacterLimit) {
          return { start: match.start, end: match.end, prefix: candidatePrefix, suffix: candidateSuffix,
            context_unique: contextMatchCount === 1, context_match_count: contextMatchCount,
            context_window_truncated: contextWindowTruncated };
        }
        contextLength = Math.min(contextLength * 2, contextCharacterLimit);
      }
    });
    const ambiguousCandidates = candidates.some(candidate => !candidate.context_unique);
    throw new SourceSpanRegistryError([{
      code: matches.length === 0 ? "selector_span_not_found" : "selector_span_not_unique",
      path: contextMismatch ? (badSuffix && !badPrefix ? "/suffix" : badPrefix && !badSuffix ? "/prefix" : "/") : "/quote",
      message: contextMismatch
        ? "quote 存在，但给定的 prefix/suffix 排除了全部匹配；应修正前后文，不是改写 quote。"
        : matches.length === 0
        ? "本次选择的不可变来源中没有找到 quote；应核对来源选择和逐字摘录，添加前后文不能补出不存在的匹配。"
        : "quote 在不可变来源中有多个匹配；请用精确前后文选择实际出现位置。",
       details: {
         source_id: source.source_id,
         actual: { quote, prefix, suffix },
         writable_paths: contextMismatch ? ["/prefix", "/suffix"] : ["/quote", "/prefix", "/suffix"],
         required_action: allMatches.length === 0
           ? "先核对本次选择的来源标识和 quote，必要时重新读取原文；没有候选可供消歧，不要反复添加 prefix/suffix 或改写原文。"
           : contextMismatch && allMatches.length === 1
             ? "保留 quote；从唯一候选复制精确相邻 prefix/suffix，或清空可选的 prefix/suffix 后重试。"
             : ambiguousCandidates
               ? "保留 quote；只有 context_unique=true 的候选可复制 prefix/suffix 后直接重试。其余候选在返回的有限上下文内仍有歧义，不要照抄后反复重试。先按 context_read 的工具与参数读取更长原文，再补充真实相邻上下文；若完整来源的上下文仍一致，现有 prefix/suffix 无法区分这些匹配，不得编造边界标记或改写原文。"
               : "保留 quote；从 context_unique=true 的 disambiguation_candidates 中选择实际出现的位置，复制其精确相邻 prefix/suffix 后重试；这些候选已对全部 quote 匹配验证唯一。",
         do_not_edit: "不可变原文和已登记的 span ID 不可修改。",
         next_tool: "locate_evidence_span",
         batch_next_tool: "batch_locate_evidence_spans",
         match_count: matches.length,
         quote_match_count: allMatches.length,
         prefix,
         suffix,
         disambiguation_candidates: candidates,
         ...(ambiguousCandidates ? {
           context_character_limit: contextCharacterLimit,
           context_read: { tool: "list_evidence_resources", arguments: { cursor: 0, limit: 24 },
             evidence_id: source.evidence_id ?? source.source_id,
             instruction: "按 next_cursor 找到对应来源；direct 用该项 read_tool 并传 evidence_id，inline_reference/isolated_reference 用该项 read_tool 并传 target_key，再按读取回条继续。isolated_reference 不得用 open_evidence 绕过读取路由。" },
         } : {}),
       },
    }]);
  }
  const match = matches[0]!;
  const registered = registerSourceSpan(registry, source, match.start, match.end);
  return {
    registry: registered.registry,
    spans: [registered.span],
    normalized: match.normalized,
    disambiguated: allMatches.length > 1,
  };
}

export function resolveSourceSpan(
  registry: SourceSpanRegistry,
  spanId: string,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: SourceSpanIssue[],
): ResolvedSourceSpan | undefined {
  if (!/^span:[a-f0-9]{32}$/u.test(spanId)) {
    issues.push({
      code: "selector_span_id_format",
      path,
      message: "Selector span handles must match ^span:[a-f0-9]{32}$",
      details: { span_id: spanId },
    });
    return undefined;
  }
  const span = registry.spans.find((candidate) => candidate.span_id === spanId);
  if (!span) {
    issues.push({
      code: "selector_unknown_span",
      path,
      message: "Selector names an unknown registered span",
      details: { span_id: spanId },
    });
    return undefined;
  }
  const source = sources.get(span.evidence_id) ?? sources.get(span.atom_id);
  if (!source) {
    issues.push({
      code: "selector_wrong_source",
      path,
      message: "Registered span source is not part of this immutable evidence package",
      details: { span_id: spanId, evidence_id: span.evidence_id, atom_id: span.atom_id },
    });
    return undefined;
  }
  if (span.start < 0 || span.end <= span.start || span.end > source.text.length) {
    issues.push({
      code: "selector_span_out_of_bounds",
      path,
      message: "Registered span offsets are outside the immutable source",
      details: { span_id: spanId, start: span.start, end: span.end, text_length: source.text.length },
    });
    return undefined;
  }
  const text = source.text.slice(span.start, span.end);
  const actualHash = sha256Text(text);
  if (actualHash !== span.text_sha256) {
    issues.push({
      code: "selector_span_hash_mismatch",
      path,
      message: "Registered span no longer matches the immutable source bytes",
      details: { span_id: spanId, expected: span.text_sha256, actual: actualHash },
    });
    return undefined;
  }
  return { ...span, text };
}

export function sourceSpanRegistryFingerprint(registry: SourceSpanRegistry): string {
  return sha256Text(canonicalize(registry));
}

/** Coordinates in the canonical rendered table row; no column is assigned a business role. */
export function renderedTableCellSpans(record: {
  kind: string; text: string; table_title?: string; row_index?: number; columns?: string[]; cells?: string[];
  table_text_format?: "cell_values_v1";
}): Array<{ column_index: number; label: string; text: string; start: number; end: number; label_start: number; label_end: number; label_fragments: Array<{ text: string; start: number; end: number }> }> {
  if (record.kind !== "table_row" || !record.columns || !record.cells || record.row_index === undefined) return [];
  const legacyPrefix = `${record.table_title ?? ""} | 数据行 ${record.row_index} | `;
  const legacySegments = record.columns.map((label, i) => `${label}=${record.cells![i] ?? ""}`);
  const valueSegments = record.cells.map((cell) => cell ?? "");
  const isCellValues = record.table_text_format === "cell_values_v1"
    && valueSegments.join(" | ") === record.text;
  const isLegacyMixed = legacyPrefix + legacySegments.join(" | ") === record.text;
  // Unknown/noncanonical rows are left untouched; never guess offsets by splitting cell text.
  if (!isCellValues && !isLegacyMixed) return [];
  let offset = isCellValues ? 0 : legacyPrefix.length;
  return record.columns.map((label, i) => {
    const text = record.cells![i] ?? "";
    const label_start = offset;
    const start = isCellValues ? offset : offset + label.length + 1;
    const label_fragments = isCellValues ? [] : [...label.matchAll(/[(（]([^()（）]+)[)）]/gu)].map(match => ({
      text: match[1]!,
      start: label_start + match.index! + 1,
      end: label_start + match.index! + 1 + match[1]!.length,
    }));
    offset += (isCellValues ? valueSegments[i]!.length : legacySegments[i]!.length) + 3;
    return { column_index: i, label, text, start, end: start + text.length,
      label_start, label_end: isCellValues ? label_start : label_start + label.length, label_fragments };
  }).filter(cell => cell.end > cell.start);
}

/** One geometry view for immutable full tables, detached HTML rows and rendered rows. */
export function tableEvidenceCellSpans(record: Parameters<typeof renderedTableCellSpans>[0]): HtmlTableCellSpan[] {
  const html = htmlTableCellSpans(record.text);
  if (html.length) return html;
  if (record.kind !== "table_row") return [];
  if (/^\s*<tr\b/iu.test(record.text) && /<\/tr>\s*$/iu.test(record.text)) {
    // The wrapper exists only in the parser; returned offsets still select the
    // original immutable row, never the synthetic table tags.
    const prefix = "<table>";
    return htmlTableCellSpans(`${prefix}${record.text}</table>`).map(cell => ({
      ...cell, start: cell.start - prefix.length, end: cell.end - prefix.length,
      table_start: 0, table_end: record.text.length,
    }));
  }
  const rendered = renderedTableCellSpans(record);
  const first = rendered[0];
  if (!first) return [];
  // Legacy rendered rows expose source-backed labels as separate selectable
  // intervals as well. Do not infer business roles from their text.
  return rendered.flatMap(cell => [
    ...(cell.label_end > cell.label_start ? [{ start: cell.label_start, end: cell.label_end }] : []),
    { start: cell.start, end: cell.end },
  ]).map((cell, index) => ({
    ...cell, text: record.text.slice(cell.start, cell.end), table_index: 0,
    row_index: 0, column_index: index, row_span: 1, column_span: 1,
    table_start: first.label_start, table_end: record.text.length,
    inherited_cell_indices: [],
  }));
}

export function tableEvidenceTextFormat(record: {
  kind: string;
  text: string;
  table_title?: string;
  row_index?: number;
  columns?: string[];
  cells?: string[];
  table_text_format?: "cell_values_v1";
}): "cell_values_v1" | "legacy_navigation_mixed_v0" | "not_table_row" {
  if (record.kind !== "table_row") return "not_table_row";
  if (record.table_text_format === "cell_values_v1") return "cell_values_v1";
  if (record.columns && record.cells && record.row_index !== undefined) {
    const prefix = `${record.table_title ?? ""} | 数据行 ${record.row_index} | `;
    const segments = record.columns.map((label, index) => `${label}=${record.cells![index] ?? ""}`);
    if (prefix + segments.join(" | ") === record.text) return "legacy_navigation_mixed_v0";
  }
  return "not_table_row";
}
