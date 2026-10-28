import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  type AcceptanceItemField,
  type EvidenceKind,
  type EvidenceManifest,
  type EvidenceRecord,
  type EvidenceRole,
  type EvidenceScope,
  type EvidenceScopeCandidate,
  type ReferenceOccurrence,
  type SamplingOccurrence,
  type SamplingOccurrenceScope,
  type TableFragmentEvidence,
} from "./contracts.js";
import { referenceOccurrenceTargetLocator } from "./contracts.js";
import { sha256Bytes, sha256Json, sha256Text } from "./canonical.js";
import { classifySamplingOccurrence } from "./domain-contract.js";
import type { PdfPromotedHeading } from "./pdf-layout-profile.js";

interface MarkdownBlock {
  kind: EvidenceKind;
  role: EvidenceRole;
  locator: string;
  text: string;
  table_fragment_id?: string;
  table_id?: string;
  table_title?: string;
  row_index?: number;
  table_row_kind?: "header" | "data";
  table_text_format?: "cell_values_v1";
  columns?: string[];
  cells?: string[];
  cell_geometry?: Array<{
    cell_id: string;
    row: number;
    column: number;
    rowspan: number;
    colspan: number;
    text: string;
  }>;
  clause_id?: string;
  sampling_occurrence?: SamplingOccurrence;
  title_candidate_locators?: string[];
  table_alias_ids?: string[];
}

interface NumberedHeading {
  line: number;
  level: number;
  number: string;
  text: string;
}

interface CandidateSignals {
  clauseCount: number;
  tableCount: number;
  chars: number;
  tocLike: boolean;
  commentaryLike: boolean;
}

interface MarkdownClause {
  clause_id: string;
  line: number;
  text: string;
}

function normalizeSectionNumber(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replaceAll("．", ".")
    .replace(/\s+/g, "");
  return /^\d+(?:\.\d+)*$/.test(normalized) ? normalized : "";
}

function tableDelta(line: string): number {
  return (line.match(/<table\b/gi)?.length ?? 0)
    - (line.match(/<\/table>/gi)?.length ?? 0);
}

function decodeHtmlText(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return entities[entity.toLocaleLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function positiveSpan(attributes: string, name: "rowspan" | "colspan"): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attributes);
  const value = match ? Number(match[1]) : 1;
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : 1;
}

interface ParsedTable {
  grid: string[][];
  cellGeometryRows: NonNullable<MarkdownBlock["cell_geometry"]>[];
  headerRows: number;
  columns: string[];
}

function parseHtmlTable(source: string): ParsedTable {
  const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  type ParsedCell = NonNullable<MarkdownBlock["cell_geometry"]>[number];
  const cellGrid: Array<Array<ParsedCell | undefined>> = rows.map(() => []);
  let nextCellId = 1;
  rows.forEach((row, rowIndex) => {
    const cells = [...row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)];
    let columnIndex = 0;
    for (const cell of cells) {
      while (cellGrid[rowIndex]![columnIndex] !== undefined) columnIndex += 1;
      const attributes = cell[1] ?? "";
      const text = decodeHtmlText(cell[2] ?? "");
      const rowSpan = positiveSpan(attributes, "rowspan");
      const columnSpan = positiveSpan(attributes, "colspan");
      const parsedCell: ParsedCell = {
        cell_id: `cell:${nextCellId}`,
        row: rowIndex,
        column: columnIndex,
        rowspan: rowSpan,
        colspan: columnSpan,
        text,
      };
      nextCellId += 1;
      for (
        let targetRow = rowIndex;
        targetRow < Math.min(cellGrid.length, rowIndex + rowSpan);
        targetRow += 1
      ) {
        for (
          let targetColumn = columnIndex;
          targetColumn < columnIndex + columnSpan;
          targetColumn += 1
        ) {
          cellGrid[targetRow]![targetColumn] = parsedCell;
        }
      }
      columnIndex += columnSpan;
    }
  });
  const grid = cellGrid.map((row) => row.map((cell) => cell?.text ?? ""));
  const width = Math.max(0, ...grid.map((row) => row.length));
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    while (grid[rowIndex]!.length < width) grid[rowIndex]!.push("");
    while (cellGrid[rowIndex]!.length < width) cellGrid[rowIndex]!.push(undefined);
  }
  const firstDataRow = grid.findIndex((row) =>
    row.some((cell) => cell === "主控项目" || cell === "一般项目")
  );
  const headerRows = firstDataRow < 0 ? Math.min(1, grid.length) : firstDataRow;
  const columns = Array.from({ length: width }, (_, columnIndex) => {
    const parts: string[] = [];
    for (let rowIndex = 0; rowIndex < headerRows; rowIndex += 1) {
      const value = grid[rowIndex]![columnIndex] ?? "";
      if (value && parts.at(-1) !== value) parts.push(value);
    }
    return parts.join(" / ") || `列${columnIndex + 1}`;
  });
  const cellGeometryRows = cellGrid.map((row) => row.map((cell, column) => cell ?? {
    cell_id: `empty:${column}`,
    row: -1,
    column,
    rowspan: 1,
    colspan: 1,
    text: "",
  }));
  return { grid, cellGeometryRows, headerRows, columns };
}

/**
 * 表号可以是字母开头的附录号（表 A.0.1、表 H.0.10），不只是数字。
 * 原来只认 [0-9]，附录表一律拿不到真实表号、退化成行号兜底 id，
 * 于是「应符合本规范表 A.0.1 的规定」永远解析不到目标——GB 50576 的
 * 附录 A/B/C/E/H 全部中招，条文引用只能落成 target_not_found。
 */
function tableIdentity(title: string, fallback: string): string {
  const match = /^(?:续表|表|[Tt]able)\s*([0-9A-Za-z]+(?:\s*[.．]\s*[0-9]+)*(?:\s*-\s*\d+)?)/
    .exec(title.trim());
  const identity = match?.[1]?.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
  return identity || fallback;
}

function tableRowText(cells: string[]): string {
  return cells.join(" | ");
}

function numberedHeadings(lines: string[]): NumberedHeading[] {
  const headings: NumberedHeading[] = [];
  let tableDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (tableDepth === 0) {
      const match = /^\s*(#{1,6})\s+(\d+(?:\s*[.．]\s*\d+)*)(?:\s+|$)(.*)$/.exec(line);
      if (match) {
        headings.push({
          line: index + 1,
          level: match[1]!.length,
          number: normalizeSectionNumber(match[2]!),
          text: line.trim(),
        });
      }
    }
    tableDepth = Math.max(0, tableDepth + tableDelta(line));
  }
  return headings;
}

function markdownClauses(lines: string[]): MarkdownClause[] {
  const clauses: MarkdownClause[] = [];
  const seen = new Set<string>();
  let current: MarkdownClause | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    const match = /^(?:#{1,6}\s*)?(\d+\.\d+\.\d+)\s+(.+)$/.exec(trimmed);
    if (match) {
      if (seen.has(match[1]!)) {
        current = undefined;
        continue;
      }
      seen.add(match[1]!);
      current = {
        clause_id: match[1]!,
        line: index + 1,
        text: `${match[1]} ${match[2]!.replace(/\s+\[PDF p\.\d+\]\s*$/, "")}`,
      };
      clauses.push(current);
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^<table\b/i.test(trimmed)) {
      current = undefined;
      continue;
    }
    if (
      current
      && trimmed
      && !/^<(?:table|\/table|tr|td)\b/i.test(trimmed)
    ) {
      current.text += ` ${trimmed.replace(/\s{2,}$/g, "")}`;
    }
  }
  return clauses;
}

function referencedSections(text: string, ownClauseId: string): string[] {
  return [...new Set(
    [...text.matchAll(/(?:第\s*)?(\d+\.\d+(?:\.\d+)?)\s*(?:条|节)?/g)]
      .map((match) => match[1]!)
      .filter((value) =>
        value.split(".").length >= 2
        && value !== ownClauseId
      ),
  )];
}

function samplingRuleBlocks(markdown: string, targetId: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const clauses = markdownClauses(lines);
  const target = normalizeSectionNumber(targetId);
  if (!target || target.split(".").length < 2) return [];
  const chapter = target.split(".")[0]!;
  const selected = new Map<string, MarkdownClause>();
  const addPrefix = (prefix: string): void => {
    for (const clause of clauses) {
      if (clause.clause_id === prefix || clause.clause_id.startsWith(`${prefix}.`)) {
        selected.set(clause.clause_id, clause);
      }
    }
  };
  addPrefix(`${chapter}.1`);
  addPrefix(target);
  for (let round = 0; round < 3; round += 1) {
    for (const clause of [...selected.values()]) {
      for (const reference of referencedSections(clause.text, clause.clause_id)) {
        addPrefix(reference);
        const referencedChapter = reference.split(".")[0];
        if (referencedChapter) addPrefix(`${referencedChapter}.1`);
      }
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.line - right.line)
    .flatMap((clause) => {
      const scope: SamplingOccurrenceScope = clause.clause_id === target
          || clause.clause_id.startsWith(`${target}.`)
          ? "target"
          : clause.clause_id === `${chapter}.1`
            || clause.clause_id.startsWith(`${chapter}.1.`)
            ? "chapter_general"
            : "referenced";
      const occurrence = classifySamplingOccurrence(
        clause.clause_id,
        clause.text,
        clause.line,
        scope,
      );
      return occurrence
        ? [{
            kind: "paragraph" as const,
            role: "sampling_rule" as const,
            locator: `sampling:line:${clause.line}/clause:${clause.clause_id}`,
            text: clause.text,
            clause_id: clause.clause_id,
            sampling_occurrence: occurrence,
          }]
        : [];
    });
}

function isBoundary(
  heading: NumberedHeading,
  candidate: NumberedHeading,
): boolean {
  if (heading.number === candidate.number) {
    return true;
  }
  return !heading.number.startsWith(`${candidate.number}.`);
}

function candidateSignals(
  lines: string[],
  target: string,
  startLine: number,
  endExclusiveLine: number,
): CandidateSignals {
  const text = lines.slice(startLine - 1, endExclusiveLine - 1).join("\n");
  const escaped = target.replaceAll(".", "\\.");
  const clauseCount = (
    text.match(new RegExp(`^\\s*#{0,6}\\s*${escaped}\\.\\d+(?:\\s|\\.|$)`, "gm")) ?? []
  ).length;
  const tableCount = text.match(/<table\b/gi)?.length ?? 0;
  const tocLike = /(?:…{2,}|\.{4,})\s*\(?\d+\)?/.test(text.slice(0, 500));
  const precedingTopHeading = [...lines.slice(0, startLine - 1)]
    .reverse()
    .find((line) => /^#\s+/.test(line.trim()));
  const commentaryLike = /条文说明/.test(precedingTopHeading ?? "");
  return {
    clauseCount,
    tableCount,
    chars: text.length,
    tocLike,
    commentaryLike,
  };
}

function scoreCandidate(signals: CandidateSignals): number {
  return Math.min(signals.chars, 10_000)
    + signals.clauseCount * 2_000
    + signals.tableCount * 5_000
    - (signals.tocLike ? 20_000 : 0)
    - (signals.commentaryLike ? 10_000 : 0);
}

function signalReason(signals: CandidateSignals): string {
  return [
    `clauses=${signals.clauseCount}`,
    `tables=${signals.tableCount}`,
    `chars=${signals.chars}`,
    `toc_like=${signals.tocLike}`,
    `commentary_like=${signals.commentaryLike}`,
  ].join(", ");
}

export function selectTargetScope(markdown: string, targetId: string): EvidenceScope {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const target = normalizeSectionNumber(targetId);
  if (!target) {
    return {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "full_document",
      target_id: targetId,
      source_line_count: lines.length,
      selected_start_line: 1,
      selected_end_exclusive_line: lines.length + 1,
      selected_heading: "",
      selection_reason: "The target ID is not a numeric section; input is treated as an already scoped Stage-1-like document.",
      candidates: [],
    };
  }

  const headings = numberedHeadings(lines);
  const exact = headings.filter((heading) => heading.number === target);
  if (!exact.length) {
    throw new Error(`Target section ${targetId} was not found in Markdown headings`);
  }
  const ranked = exact.map((heading) => {
    const nextBoundary = headings.find(
      (row) => row.line > heading.line && isBoundary(row, heading),
    );
    const endExclusiveLine = nextBoundary?.line ?? lines.length + 1;
    const signals = candidateSignals(lines, target, heading.line, endExclusiveLine);
    return {
      heading,
      endExclusiveLine,
      signals,
      score: scoreCandidate(signals),
    };
  }).sort((left, right) =>
    right.score - left.score || left.heading.line - right.heading.line
  );
  const selected = ranked[0]!;
  const candidates: EvidenceScopeCandidate[] = ranked
    .map((row) => ({
      start_line: row.heading.line,
      end_exclusive_line: row.endExclusiveLine,
      heading: row.heading.text,
      score: row.score,
      selected: row === selected,
      reason: `${row === selected ? "selected" : "alternate exact target heading"}; ${signalReason(row.signals)}`,
    }))
    .sort((left, right) => left.start_line - right.start_line);
  return {
    schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
    mode: "target_section",
    target_id: targetId,
    source_line_count: lines.length,
    selected_start_line: selected.heading.line,
    selected_end_exclusive_line: selected.endExclusiveLine,
    selected_heading: selected.heading.text,
    selection_reason: "Selected the exact target heading with the highest deterministic evidence score; ties prefer the earliest source occurrence.",
    candidates,
  };
}

function markdownBlocks(
  markdown: string,
  startLine: number,
  endExclusiveLine: number,
  structuralHeadingLines: ReadonlySet<number> = new Set(),
): MarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let lastTableId = "";
  let lastTableTitle = "";
  let index = startLine - 1;
  const endIndex = endExclusiveLine - 1;
  while (index < endIndex) {
    const raw = lines[index]!;
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (/^<table\b/i.test(trimmed)) {
      const tableLines = [raw];
      index += 1;
      while (
        index < endIndex
        && !/<\/table>/i.test(tableLines.at(-1)!)
      ) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      if (!/<\/table>/i.test(tableLines.at(-1)!)) {
        throw new Error(`Target scope cuts or contains an unclosed HTML table at line ${lineNumber}`);
      }
      const previous = blocks.at(-1);
      const tableFragmentId = `table-fragment:line-${lineNumber}`;
      const titleCandidateLocators: string[] = [];
      for (let candidateIndex = blocks.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = blocks[candidateIndex]!;
        if (
          candidate.kind === "table_row"
          || candidate.kind === "heading"
          || candidate.role === "supporting_clause"
        ) {
          break;
        }
        if (
          (candidate.kind === "paragraph" || candidate.kind === "list_item")
          && candidate.role !== "table_note"
        ) {
          titleCandidateLocators.unshift(candidate.locator);
          if (titleCandidateLocators.length >= 4) break;
        }
      }
      const title = previous?.kind === "paragraph"
        && /^(?:续表|表|[Tt]able)\s*[0-9A-Za-z]/.test(previous.text.trim())
        ? previous.text
        : `表@line:${lineNumber}`;
      if (title !== `表@line:${lineNumber}` && previous) {
        titleCandidateLocators.splice(0, titleCandidateLocators.length, previous.locator);
      }
      const tableId = tableIdentity(title, `line-${lineNumber}`);
      // 题注常被 OCR 拆成两行（`表 3.3.10` / `铜管管道支架的最大间距`），紧邻 <table>
      // 的是表名那一行，表号落在更前面一块。这种情况**故意**不在机械层认表号：
      // provisional_table_id 保持 `line-N`、题注候选保持多行，正是语义组装层
      // （logical_tables）赖以把碎片拼成一张表并给出真实表号的信号。
      //
      // 但引用查表是另一件事：`应符合表 3.3.10 的规定` 指的就是这张表，查不到它
      // 只能落成 target_not_found（GB 50242 实测 19 处）。所以这里只额外登记一个
      // **别名**——别名不进 locator（证据 id 不变）、不进 provisional_table_id
      // （组装层看不见），仅供 referenceBundle 建索引时多认一个键。
      const aliasIds = tableId.startsWith("line-")
        ? [...new Set(
          [...titleCandidateLocators].reverse()
            .map((locator) => blocks.find((candidate) => candidate.locator === locator))
            .map((candidate) => candidate ? tableIdentity(candidate.text, "") : "")
            .filter((identity) => identity !== ""),
        )]
        : [];
      if (previous?.kind === "paragraph" && previous.text === title) {
        previous.role = /^续表/u.test(previous.text.trim())
          ? "table_continuation_caption"
          : "formal_table_title";
        previous.table_fragment_id = tableFragmentId;
        previous.table_id = tableId;
        previous.table_title = title;
      }
      const parsed = parseHtmlTable(tableLines.join("\n"));
      parsed.grid.forEach((cells, rowIndex) => {
        const role: EvidenceRole = rowIndex < parsed.headerRows
          ? "formal_table_header"
          : cells.some((cell) => cell === "主控项目" || cell === "一般项目")
            ? "formal_table_row"
            : "context";
        blocks.push({
          kind: "table_row",
          role,
          locator: `line:${lineNumber}/table:${tableId}/row:${rowIndex + 1}`,
          text: tableRowText(cells),
          table_fragment_id: tableFragmentId,
          table_id: tableId,
          table_title: title,
          row_index: rowIndex + 1,
          table_row_kind: rowIndex < parsed.headerRows ? "header" : "data",
          table_text_format: "cell_values_v1",
          columns: parsed.columns,
          cells,
          cell_geometry: parsed.cellGeometryRows[rowIndex]!,
          title_candidate_locators: titleCandidateLocators,
          ...(aliasIds.length ? { table_alias_ids: aliasIds } : {}),
        });
      });
      lastTableId = tableId;
      lastTableTitle = title;
      continue;
    }
    const kind: EvidenceKind = /^#{1,6}\s+/.test(trimmed)
      ? "heading"
      : /^[-*+]\s+/.test(trimmed)
        ? "list_item"
        : "paragraph";
    // Markdown heading syntax is typography, not a semantic source role.
    // Only the document's learned structural classification can forbid a field binding.
    const role: EvidenceRole = kind === "heading" && structuralHeadingLines.has(lineNumber)
      ? "section_heading"
      : /^注\s*[:：]/.test(trimmed)
        ? "table_note"
        : /^\d+(?:\.\d+)+/.test(trimmed)
          ? "supporting_clause"
          : "context";
    blocks.push({
      kind,
      role,
      locator: `line:${lineNumber}`,
      text: trimmed,
      ...(role === "table_note" && lastTableId
        ? { table_id: lastTableId, table_title: lastTableTitle }
        : {}),
    });
    if (role !== "table_note") {
      lastTableId = "";
      lastTableTitle = "";
    }
    index += 1;
  }
  return blocks;
}

/**
 * 表引用检测：只锚定「表 / Table」这个标记本身，不锚定它前面的措辞。
 *
 * 原来写死「本标准表 X」，等于把措辞当判据：GB 50576 全书用「本规范表 A.0.1」、
 * 别的书写「参考表 X」「见表 X」「按表 X」，一个都认不出来——实测 6 本规范里
 * 有 4 本是零检出，130 余处引用全被漏掉，附录里的判定表根本没进证据包。
 *
 * 措辞是无穷的，标记是有限的。检出后由调用方拿真实表册核验（recordsByTable 是白名单），
 * 对不上的自动落成 target_not_found —— 那正是交给 LLM 去捞的信号，而不是悄悄丢掉。
 * 全角数字/空格由 normalize 抹平，OCR 把编号污染掉的自然查不到，也就自然退给 LLM。
 */
const TABLE_REFERENCE_PATTERN = /(?:表|[Tt]able)\s*([0-9A-Za-z]+(?:\s*[.．]\s*[0-9]+)*(?:\s*-\s*\d+)?)/g;
const MAX_REFERENCE_DEPTH = 4;

function uniqueValues(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    if (result.at(-1) !== value) result.push(value);
  }
  return result;
}

function formalReferenceFields(record: EvidenceRecord): Array<{
  field: AcceptanceItemField;
  value: string;
}> {
  // 条文正文同样要扫引用。原来只扫 formal_table_row，等于只处理「表→表」的链，
  // 而「条文→表」这条最常见的路（`10.3.8 …应符合本规范表 E.0.1 的规定`）
  // 从来没被机械检测过：不生成 occurrence，LLM 那边连一个 target_not_found
  // 的信号都收不到，只能自己通读去撞。实测 6 本规范 130 余处引用全走了这条黑路。
  if (
    record.role === "supporting_clause"
    || record.role === "section_heading"
    || record.role === "table_note"
  ) {
    return record.text.trim() ? [{ field: "requirement", value: record.text }] : [];
  }
  if (record.role !== "formal_table_row") return [];
  const cells = record.cells ?? [];
  if (cells.length < 5) return [];
  return [
    {
      field: "requirement",
      value: uniqueValues(cells.slice(-3, -1)).join(" "),
    },
    { field: "method", value: cells.at(-1)?.trim() ?? "" },
  ];
}

function tableReferences(value: string): Array<{
  raw_reference: string;
  target_table_id: string;
}> {
  const seen = new Set<string>();
  const references: Array<{ raw_reference: string; target_table_id: string }> = [];
  for (const match of value.matchAll(TABLE_REFERENCE_PATTERN)) {
    const targetTableId = match[1]!.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
    if (!targetTableId || seen.has(targetTableId)) continue;
    seen.add(targetTableId);
    references.push({
      raw_reference: match[0]!.replace(/\s+/g, ""),
      target_table_id: targetTableId,
    });
  }
  return references;
}

function recordFromBlock(
  block: MarkdownBlock,
  sourceSha256: string,
  evidenceScope: "primary" | "reference" | "sampling",
): EvidenceRecord {
  const textSha256 = sha256Text(block.text);
  return {
    evidence_id: `evidence:${sha256Text(
      `markdown-target-scope/v3|${sourceSha256}|${block.locator}|${textSha256}`,
    )}`,
    kind: block.kind,
    role: block.role,
    locator: block.locator,
    text: block.text,
    text_sha256: textSha256,
    requires_disposition: evidenceScope === "primary"
      && block.role !== "formal_table_header"
      && block.role !== "formal_table_title"
      && block.role !== "table_continuation_caption"
      // Tables do not make adjacent primary prose optional. The Agent must
      // bind it or explicitly classify it; this does not assign business meaning.
      && block.role !== "section_heading",
    evidence_scope: evidenceScope,
    ...(block.table_row_kind ? { table_row_kind: block.table_row_kind } : {}),
    ...(block.table_text_format ? { table_text_format: block.table_text_format } : {}),
    ...(block.table_fragment_id ? { table_fragment_id: block.table_fragment_id } : {}),
    ...(block.table_id ? { table_id: block.table_id } : {}),
    ...(block.table_alias_ids?.length ? { table_alias_ids: block.table_alias_ids } : {}),
    ...(block.table_title ? { table_title: block.table_title } : {}),
    ...(block.row_index !== undefined ? { row_index: block.row_index } : {}),
    ...(block.columns ? { columns: block.columns } : {}),
    ...(block.cells ? { cells: block.cells } : {}),
    ...(block.cell_geometry ? { cell_geometry: block.cell_geometry } : {}),
    ...(block.clause_id ? { clause_id: block.clause_id } : {}),
    ...(block.sampling_occurrence
      ? { sampling_occurrence: block.sampling_occurrence }
      : {}),
  };
}

function referenceBundle(
  primaryEvidence: EvidenceRecord[],
  fullDocumentEvidence: EvidenceRecord[],
): { evidence: EvidenceRecord[]; occurrences: ReferenceOccurrence[] } {
  const recordsByTable = new Map<string, EvidenceRecord[]>();
  for (const record of fullDocumentEvidence) {
    if (!record.table_id) continue;
    // 别名与本名一并入索引：题注被 OCR 拆行的表本名是 `line-N`，只有别名认得出
    // `表 3.3.10`，指向它的条文引用否则一律 target_not_found。
    for (const key of [record.table_id, ...(record.table_alias_ids ?? [])]) {
      recordsByTable.set(key, [...(recordsByTable.get(key) ?? []), record]);
    }
  }
  const selectedEvidence = new Map(
    primaryEvidence.map((record) => [record.evidence_id, record]),
  );
  const primaryEvidenceIds = new Set(
    primaryEvidence
      .filter((record) => record.evidence_scope === "primary")
      .map((record) => record.evidence_id),
  );
  // 条文级引用指向的表，行本来就在本包主证据里时，这条引用不构成待办。
  // 典型形态是条文指向它自己那几张表（`5.5.4 …应符合表 5.5.4-1、表 5.5.4-2 的规定`），
  // 那些行已经是主证据、已经物化成验收项目了：“把被引表拉进来”这件事完成了，
  // 再要求一条显式解析只是空转，而且没有任何一方供得出——条文常常不被任何 item 认领。
  //
  // 只对条文豁免，表格单元格不豁免：单元格里的 `本标准表 5.5.4-1` 是取值指针
  // （这一格的数值要落到那张表对应行上），即使目标表已在包里，行级绑定仍然必须做。
  // 两者形态相同、语义不同，判据是来源是谁，不是目标在不在包里。
  //
  // 豁免掉的 occurrence 仍然进 manifest，LLM 依旧能从 list_reference_occurrences 看到，
  // 只是不再拦封存。
  const primaryTableIds = new Set(
    primaryEvidence
      .filter((record) => record.evidence_scope === "primary" && record.table_id)
      .map((record) => record.table_id!),
  );
  const occurrences = new Map<string, ReferenceOccurrence>();
  const scannedDepth = new Map<string, number>();
  const pending: Array<{ table_id: string; depth: number; path: string[] }> = [];

  const scan = (records: EvidenceRecord[], depth: number, path: string[]): void => {
    for (const record of records) {
      const originPath = record.table_id && path.at(-1) !== record.table_id
        ? [...path, record.table_id]
        : path;
      for (const source of formalReferenceFields(record)) {
        for (const reference of tableReferences(source.value)) {
          const targetRecords = recordsByTable.get(reference.target_table_id) ?? [];
          const targetRows = targetRecords.filter((candidate) =>
            candidate.table_row_kind === "data"
          );
          const cycle = originPath.includes(reference.target_table_id);
          const status: ReferenceOccurrence["status"] = cycle
            ? "cycle"
            : !targetRows.length
              ? "target_not_found"
              : depth >= MAX_REFERENCE_DEPTH
                ? "depth_limit"
                : "resolved";
          const occurrenceId = `reference:${sha256Text(
            `${record.evidence_id}|table|${reference.target_table_id}`,
          )}`;
          const existing = occurrences.get(occurrenceId);
          const originFields = [...new Set([
            ...(existing?.origin_fields ?? []),
            source.field,
          ])] as AcceptanceItemField[];
          const priority = {
            resolved: 0,
            target_not_found: 1,
            ambiguous: 2,
            depth_limit: 3,
            cycle: 4,
          } as const;
          const effectiveStatus = existing
            && priority[existing.status] > priority[status]
            ? existing.status
            : status;
          occurrences.set(occurrenceId, {
            occurrence_id: occurrenceId,
            reference_kind: "table",
            origin_evidence_id: record.evidence_id,
            origin_fields: originFields,
            raw_reference: reference.raw_reference,
            target_table_id: reference.target_table_id,
            target_evidence_ids: targetRows.map((candidate) => candidate.evidence_id),
            required: Boolean(existing?.required)
              || (
                primaryEvidenceIds.has(record.evidence_id)
                && !(
                  record.role !== "formal_table_row"
                  && primaryTableIds.has(reference.target_table_id)
                )
              ),
            status: effectiveStatus,
            depth: Math.min(existing?.depth ?? Number.MAX_SAFE_INTEGER, depth + 1),
            path: existing?.path && existing.path.length <= originPath.length + 1
              ? existing.path
              : [...originPath, reference.target_table_id],
          });
          for (const targetRecord of targetRecords) {
            if (!selectedEvidence.has(targetRecord.evidence_id)) {
              selectedEvidence.set(targetRecord.evidence_id, targetRecord);
            }
          }
          if (status === "resolved") {
            const nextDepth = depth + 1;
            const previousDepth = scannedDepth.get(reference.target_table_id);
            if (previousDepth === undefined || nextDepth < previousDepth) {
              scannedDepth.set(reference.target_table_id, nextDepth);
              pending.push({
                table_id: reference.target_table_id,
                depth: nextDepth,
                path: [...originPath, reference.target_table_id],
              });
            }
          }
        }
      }
    }
  };

  // 种子必须包含条文正文，不能只有表格行。只扫 formal_table_row 时整套机制
  // 只做「表→表」的链，而最常见的「条文→表」（`10.3.8 …应符合本规范表 E.0.1 的规定`）
  // 一次都没被检测过：不生成 occurrence，LLM 侧连 target_not_found 都收不到，
  // 只能自己通读去撞。GB 50576 全文有 360 条正文含表引用，机械检出为 0。
  scan(
    primaryEvidence.filter((record) =>
      record.role === "formal_table_row"
      || record.role === "supporting_clause"
      || record.role === "section_heading"
      || record.role === "table_note"
    ),
    0,
    [],
  );
  while (pending.length) {
    const next = pending.shift()!;
    scan(
      (recordsByTable.get(next.table_id) ?? []).filter((record) =>
        record.role === "formal_table_row"
      ),
      next.depth,
      next.path,
    );
  }
  return {
    evidence: [...selectedEvidence.values()],
    occurrences: [...occurrences.values()].sort((left, right) =>
      left.origin_evidence_id.localeCompare(right.origin_evidence_id)
      || referenceOccurrenceTargetLocator(left).localeCompare(referenceOccurrenceTargetLocator(right), undefined, {
        numeric: true,
      })
    ),
  };
}

function tableFragments(
  blocks: MarkdownBlock[],
  records: EvidenceRecord[],
): TableFragmentEvidence[] {
  const recordByLocator = new Map(
    records.map((record) => [record.locator, record]),
  );
  const fragments = new Map<string, TableFragmentEvidence>();
  for (const block of blocks) {
    if (block.kind !== "table_row" || !block.table_fragment_id) continue;
    const record = recordByLocator.get(block.locator);
    if (!record) {
      throw new Error(`Table fragment row lacks evidence: ${block.locator}`);
    }
    let fragment = fragments.get(block.table_fragment_id);
    if (!fragment) {
      const captionRecords = (block.title_candidate_locators ?? [])
        .map((locator) => recordByLocator.get(locator))
        .filter((record): record is EvidenceRecord => record !== undefined);
      const titleCandidateEvidenceIds = captionRecords
        .filter((record) => record.role === "formal_table_title")
        .map((record) => record.evidence_id);
      const continuationCaptionEvidenceIds = captionRecords
        .filter((record) => record.role === "table_continuation_caption")
        .map((record) => record.evidence_id);
      fragment = {
        fragment_id: block.table_fragment_id,
        source_order: fragments.size + 1,
        locator: block.locator.replace(/\/table:.*$/, ""),
        provisional_table_id: block.table_id ?? "",
        provisional_title: block.table_title ?? "",
        title_candidate_evidence_ids: titleCandidateEvidenceIds,
        ...(continuationCaptionEvidenceIds.length
          ? { continuation_caption_evidence_ids: continuationCaptionEvidenceIds }
          : {}),
        header_evidence_ids: [],
        row_evidence_ids: [],
        formal_row_evidence_ids: [],
        columns: [...(block.columns ?? [])],
      };
      fragments.set(block.table_fragment_id, fragment);
    }
    fragment.row_evidence_ids.push(record.evidence_id);
    if (block.role === "formal_table_header") {
      fragment.header_evidence_ids.push(record.evidence_id);
    }
    if (block.role === "formal_table_row") {
      fragment.formal_row_evidence_ids.push(record.evidence_id);
    }
  }
  return [...fragments.values()];
}

export interface EvidenceLineWindow {
  start_line: number;
  end_exclusive_line: number;
}

export interface StructuredTargetEvidence {
  evidence: EvidenceRecord[];
  table_fragments: TableFragmentEvidence[];
  reference_occurrences: ReferenceOccurrence[];
}

function mergeEvidenceWindows(
  windows: EvidenceLineWindow[],
  sourceLineCount: number,
): EvidenceLineWindow[] {
  const bounded = windows
    .map((window) => ({
      start_line: Math.max(1, window.start_line),
      end_exclusive_line: Math.min(sourceLineCount + 1, window.end_exclusive_line),
    }))
    .filter((window) => window.start_line < window.end_exclusive_line)
    .sort((left, right) => left.start_line - right.start_line);
  const merged: EvidenceLineWindow[] = [];
  for (const window of bounded) {
    const previous = merged.at(-1);
    if (previous && window.start_line <= previous.end_exclusive_line) {
      previous.end_exclusive_line = Math.max(
        previous.end_exclusive_line,
        window.end_exclusive_line,
      );
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * 正文路的引用解析。
 *
 * 表格路（buildStructuredTargetEvidence）只为 5 列以上的正式表格建立冻结的 table fragment。
 * 家族 B 的规范（GB 50207/50209/50210/50242，占语料四分之一）主要走正文路，
 * 因此这里仍需检测它们的正文表引用并把解析结果交给 LLM。
 * 这里用同一套 referenceBundle 给正文证据补上检测与解析：解析得到的把目标表原文
 * 拉进证据包，解析不到的落成 target_not_found 交给 LLM 去捞。
 *
 * 整份文档解析失败时（例如 HTML 表被窗口截断）静默降级为「没有引用」——
 * 引用是增益，不能因为它让整个作业起不来。
 */
export function resolveProseReferences(
  markdown: string,
  sourceSha256: string,
  proseEvidence: EvidenceRecord[],
): { evidence: EvidenceRecord[]; occurrences: ReferenceOccurrence[] } {
  if (!proseEvidence.length) return { evidence: [], occurrences: [] };
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const sourceLineCount = normalized.split("\n").length;
  let fullDocumentEvidence: EvidenceRecord[];
  try {
    fullDocumentEvidence = markdownBlocks(normalized, 1, sourceLineCount + 1)
      .map((block) => recordFromBlock(block, sourceSha256, "reference"));
  } catch {
    return { evidence: [], occurrences: [] };
  }
  const bundle = referenceBundle(proseEvidence, fullDocumentEvidence);
  const proseIds = new Set(proseEvidence.map((record) => record.evidence_id));
  return {
    // 只回传「因引用而拉进来的」记录；正文证据本身由调用方原样保留。
    evidence: bundle.evidence.filter((record) => !proseIds.has(record.evidence_id)),
    occurrences: bundle.occurrences,
  };
}

/**
 * Builds line-granular prose obligations for Agent-selected transport atoms.
 * HTML tables are normally skipped because the structured table pipeline owns row expansion.
 * When that pipeline has no formal fragment, callers may retain each selected raw table line as
 * one compact primary context record so narrow-table values do not disappear.
 */
export function buildGranularProseCoverageEvidence(
  markdown: string,
  sourceSha256: string,
  windows: EvidenceLineWindow[],
  options: {
    includeHtmlTables?: boolean;
    promotedHeadings?: ReadonlyMap<number, PdfPromotedHeading>;
    structuralHeadingLines?: ReadonlySet<number>;
  } = {},
): EvidenceRecord[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const selected = windows
    .map((window) => ({
      start_line: Math.max(1, window.start_line),
      end_exclusive_line: Math.min(lines.length + 1, window.end_exclusive_line),
    }))
    .filter((window) => window.start_line < window.end_exclusive_line);
  const lineSelected = (line: number): boolean => selected.some((window) =>
    line >= window.start_line && line < window.end_exclusive_line
  );
  const evidence: EvidenceRecord[] = [];
  let tableDepth = 0;
  let owningClauseId = "";
  const ownershipStartLine = selected.length
    ? Math.min(...selected.map((window) => window.start_line))
    : 1;
  const ownershipEndExclusiveLine = selected.length
    ? Math.max(...selected.map((window) => window.end_exclusive_line))
    : 1;
  for (const [index, raw] of lines.entries()) {
    const lineNumber = index + 1;
    const containsTable = /<\/?table\b/i.test(raw);
    const insideTable = tableDepth > 0 || containsTable;
    tableDepth = Math.max(0, tableDepth + tableDelta(raw));
    if (lineNumber < ownershipStartLine || lineNumber >= ownershipEndExclusiveLine) continue;
    const rawText = raw.trim();
    const markdownHeading = /^#{1,6}\s+/.test(rawText);
    const structuralHeading = markdownHeading && options.structuralHeadingLines?.has(lineNumber);
    const headingDepth = markdownHeading ? /^#{1,6}/.exec(rawText)![0].length : 0;
    const promotion = structuralHeading ? undefined : options.promotedHeadings?.get(lineNumber);
    const headingText = markdownHeading
      ? rawText.replace(/^#{1,6}\s+/, "").replace(/\s*\[PDF p\.\d+\]\s*$/, "").trim()
      : rawText;
    const clauseMatch = structuralHeading ? null : new RegExp(String.raw`^(\d+(?:\s*[.．]\s*\d+){2,})${NUMBERED_PROSE_BOUNDARY}`, "u").exec(headingText);
    const markdownClauseId = clauseMatch?.[1]
      ?.normalize("NFKC")
      .replaceAll("．", ".")
      .replace(/\s+/g, "");
    const explicitClauseId = markdownClauseId ?? promotion?.clause_id;
    if (explicitClauseId) {
      owningClauseId = explicitClauseId;
    } else if (
      markdownHeading
      && (
        structuralHeading
        || /^\d+(?:\s*[.．]\s*\d+)\s+/.test(headingText)
        || (headingDepth === 1 && /^\d+\s+/.test(headingText))
        || /^附录\s*[A-ZＡ-Ｚ]/iu.test(headingText)
        || /^(?:主\s*控|一\s*般)\s*项\s*目$/u.test(headingText)
      )
    ) {
      // A chapter/section/appendix heading ends the preceding formal clause.
      // Nested headings such as "1 技术资料" remain children of that clause.
      owningClauseId = "";
    }
    if (!lineSelected(lineNumber)) continue;
    if (insideTable) {
      if (!options.includeHtmlTables) continue;
      const rows = [...raw.matchAll(/<tr\b[^>]*>.*?<\/tr>/giu)]
        .map((match) => match[0].trim())
        .filter(Boolean);
      const fragments = rows.length ? rows : [raw.trim()].filter(Boolean);
      fragments.forEach((text, rowIndex) => {
        const locator = rows.length
          ? `line:${lineNumber}/table-row:${rowIndex + 1}`
          : `line:${lineNumber}/table-fragment`;
        const textSha256 = sha256Text(text);
        evidence.push({
          evidence_id: `evidence:${sha256Text(
            `markdown-target-scope/v3|${sourceSha256}|${locator}|${textSha256}`,
          )}`,
          kind: "paragraph",
          role: "context",
          locator,
          text,
          text_sha256: textSha256,
          requires_disposition: false,
          evidence_scope: "primary",
          ...(owningClauseId ? { clause_id: owningClauseId } : {}),
        });
      });
      continue;
    }
    if (!rawText) continue;
    const clauseHeading = markdownHeading && Boolean(promotion || clauseMatch);
    const text = clauseHeading ? headingText : rawText;
    const kind: EvidenceKind = markdownHeading && !clauseHeading
      ? "heading"
      : /^[-*+]\s+/.test(text)
        ? "list_item"
        : "paragraph";
    const role: EvidenceRole = promotion || clauseMatch
      ? "supporting_clause"
      : kind === "heading"
        ? structuralHeading ? "section_heading" : "context"
        : /^注\s*[:：]/.test(text)
          ? "table_note"
          : /^\d+(?:\.\d+)+/.test(text)
            ? "supporting_clause"
            : "context";
    const locator = `line:${lineNumber}`;
    const textSha256 = sha256Text(text);
    evidence.push({
      evidence_id: `evidence:${sha256Text(
        `markdown-target-scope/v3|${sourceSha256}|${locator}|${textSha256}`,
      )}`,
      kind,
      role,
      locator,
      text,
      text_sha256: textSha256,
      requires_disposition: false,
      evidence_scope: "primary",
      ...(owningClauseId ? { clause_id: owningClauseId } : {}),
    });
  }
  return evidence;
}

/**
 * Adds lossless row-level evidence for tables that physically overlap an Agent-selected
 * target fragment. The rows are coverage obligations only: target discovery and semantic
 * ownership remain Agent decisions, and raw immutable document atoms stay available.
 */
export function buildStructuredTargetEvidence(
  markdown: string,
  sourceSha256: string,
  windows: EvidenceLineWindow[],
  /**
   * 认不出 formal_table_row 时是否整体返回空（表格路/正文路的分流）。
   * 默认 true 保持原语义；只有「按表号取行」这类与分栏无关的用途才传 false。
   */
  requireFormalTableRows = true,
  structuralHeadingLines: ReadonlySet<number> = new Set(),
): StructuredTargetEvidence {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const sourceLineCount = normalized.split("\n").length;
  const fullDocumentBlocks = markdownBlocks(
    normalized,
    1,
    sourceLineCount + 1,
    structuralHeadingLines,
  );
  const fullDocumentBlockByLocator = new Map(
    fullDocumentBlocks.map((block, index) => [block.locator, { block, index }]),
  );
  // A requested line may be inside a multiline HTML table. Complete only that
  // intersecting physical table, never an arbitrary +/- line neighborhood.
  const sourceLines = normalized.split("\n");
  const tableStartLines = new Set(fullDocumentBlocks.flatMap((block) => {
    const match = block.kind === "table_row" ? /^line:(\d+)\/table:/.exec(block.locator) : null;
    return match ? [Number(match[1])] : [];
  }));
  const physicalTables = [...tableStartLines].map((start) => {
    let end = start;
    while (end <= sourceLines.length && !/<\/table>/i.test(sourceLines[end - 1]!)) end += 1;
    return { start_line: start, end_exclusive_line: end + 1 };
  });
  const selectedWindows = mergeEvidenceWindows(windows, sourceLineCount).map((window) => {
    const intersecting = physicalTables.filter((table) =>
      table.start_line < window.end_exclusive_line && table.end_exclusive_line > window.start_line
    );
    return {
      start_line: Math.min(window.start_line, ...intersecting.map((table) => table.start_line)),
      end_exclusive_line: Math.max(window.end_exclusive_line, ...intersecting.map((table) => table.end_exclusive_line)),
    };
  });
  const primaryBlocksByLocator = new Map<string, MarkdownBlock>();
  for (const window of mergeEvidenceWindows(selectedWindows, sourceLineCount)) {
    for (const block of markdownBlocks(
      normalized,
      window.start_line,
      window.end_exclusive_line,
      structuralHeadingLines,
    )) {
      primaryBlocksByLocator.set(block.locator, block);
    }
  }
  const coreLocators = new Set(primaryBlocksByLocator.keys());

  // An explicitly selected, parsed table caption is also a table address. This
  // preserves caption-only selection and continued tables without promoting a
  // neighboring table merely because it is a few lines away.
  const selectedCaptionTableIds = new Set([...primaryBlocksByLocator.keys()].flatMap((locator) => {
    const block = fullDocumentBlockByLocator.get(locator)?.block;
    return (block?.role === "formal_table_title" || block?.role === "table_continuation_caption")
      && block.table_id ? [block.table_id] : [];
  }));
  for (const block of fullDocumentBlocks) {
    if (block.kind === "table_row" && block.table_id && selectedCaptionTableIds.has(block.table_id)) {
      primaryBlocksByLocator.set(block.locator, block);
    }
  }

  // A narrow physical window can start at the table itself and omit the title just
  // above it. In that case the scoped parser necessarily assigns a line-based fallback
  // table id, even though the full-document parser has the canonical title and id. Use
  // the immutable table start line to reconnect those rows to their full-document
  // counterparts before expanding the logical table.
  const selectedTableStartLines = new Set(
    [...primaryBlocksByLocator.values()]
      .filter((block) => block.kind === "table_row")
      .map((block) => /^line:(\d+)\/table:/.exec(block.locator)?.[1])
      .filter((line): line is string => Boolean(line)),
  );
  for (const [locator, block] of [...primaryBlocksByLocator.entries()]) {
    const startLine = block.kind === "table_row"
      ? /^line:(\d+)\/table:/.exec(block.locator)?.[1]
      : undefined;
    if (startLine && selectedTableStartLines.has(startLine)) {
      primaryBlocksByLocator.delete(locator);
    }
  }
  for (const block of fullDocumentBlocks) {
    const startLine = block.kind === "table_row"
      ? /^line:(\d+)\/table:/.exec(block.locator)?.[1]
      : undefined;
    if (startLine && selectedTableStartLines.has(startLine)) {
      primaryBlocksByLocator.set(block.locator, block);
    }
  }

  // A selected physical fragment is only an address into a logical table. Once any
  // fragment is selected, every physical fragment carrying the same parsed table id
  // becomes a row-level coverage obligation. This keeps split/continued tables lossless
  // without using their titles, numbering, or layout to decide business ownership.
  const selectedTableIds = new Set(
    [...primaryBlocksByLocator.values()]
      .filter((block) => block.kind === "table_row" && block.table_id)
      .map((block) => block.table_id!),
  );
  for (const block of fullDocumentBlocks) {
    if (
      block.kind !== "table_row"
      || !block.table_id
      || !selectedTableIds.has(block.table_id)
    ) continue;
    primaryBlocksByLocator.set(block.locator, block);
    for (const locator of block.title_candidate_locators ?? []) {
      const title = fullDocumentBlockByLocator.get(locator)?.block;
      if (title) primaryBlocksByLocator.set(title.locator, title);
    }
  }

  const primaryBlocks = [...primaryBlocksByLocator.values()]
    .sort((left, right) =>
      (fullDocumentBlockByLocator.get(left.locator)?.index ?? Number.MAX_SAFE_INTEGER)
      - (fullDocumentBlockByLocator.get(right.locator)?.index ?? Number.MAX_SAFE_INTEGER)
    )
    .map((block) =>
    block.role === "formal_table_row" && (block.cells?.length ?? 0) < 5
      ? { ...block, role: "context" as const }
      : block
    );
  const hasFormalTableRows = primaryBlocks.some((block) =>
    block.role === "formal_table_row"
  );
  // 这道闸门是「表格路 vs 正文路」的分流：认不出 formal_table_row 的书整体返回空，
  // 由调用方改走正文路。formal_table_row 的判据是单元格里有「主控项目」或「一般项目」。
  //
  // 但按表号查一张表是另一回事，跟这本书用不用分栏毫无关系。
  // resolve_document_reference 的表分支复用了这个函数，于是在不分栏的书上一张表都查不到：
  // GB/T 50312 全书零处「主控项目/一般项目」，全文扫描返回 0 条证据，
  // `表6.1.1-2` 明明印在第 399 行却恒返回 target_not_found，
  // 继而 reference_target_not_found 禁止封存——实测 保护措施 因此报
  // harness_contract_defect 退出，而模型的申辩是对的：
  // 「表在已解析的证据里含表题、表头和全部数值行，但对该表调用解析仍返回找不到」。
  //
  // 所以只在「按表号取行」这一种用途上放行；分流语义不变，默认仍然要求 formal_table_row。
  if (!hasFormalTableRows && requireFormalTableRows) {
    return { evidence: [], table_fragments: [], reference_occurrences: [] };
  }

  const primaryEvidence = primaryBlocks.map((block) => recordFromBlock(
    block, sourceSha256,
    // Unconfirmed caption candidates outside the actual window remain readable
    // support. Only table fragments and their confirmed captions extend ownership.
    !coreLocators.has(block.locator) && block.kind !== "table_row" && block.role !== "formal_table_title"
      ? "reference" : "primary",
  ));
  const fullDocumentEvidence = fullDocumentBlocks.map((block) =>
    recordFromBlock(block, sourceSha256, "reference")
  );
  const reference = referenceBundle(primaryEvidence, fullDocumentEvidence);
  return {
    evidence: reference.evidence,
    table_fragments: tableFragments(primaryBlocks, primaryEvidence),
    reference_occurrences: reference.occurrences,
  };
}

export interface FormalTarget {
  target_id: string;
  heading: string;
  start_line: number;
  end_exclusive_line: number;
  table_count: number;
  row_count: number;
}

export function discoverFormalTargets(markdown: string): FormalTarget[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const headings = numberedHeadings(normalized.split("\n"));
  const ids = [...new Set(
    headings
      .map((heading) => heading.number)
      .filter((number) => number.split(".").length === 2 && Number(number.split(".")[0]) >= 4),
  )];
  const targets: FormalTarget[] = [];
  for (const targetId of ids) {
    const scope = selectTargetScope(normalized, targetId);
    const blocks = markdownBlocks(
      normalized,
      scope.selected_start_line,
      scope.selected_end_exclusive_line,
    );
    const rows = blocks.filter((block) => block.role === "formal_table_row");
    if (!rows.length) continue;
    targets.push({
      target_id: targetId,
      heading: scope.selected_heading,
      start_line: scope.selected_start_line,
      end_exclusive_line: scope.selected_end_exclusive_line,
      table_count: new Set(rows.map((row) => row.table_fragment_id)).size,
      row_count: rows.length,
    });
  }
  return targets.sort((left, right) =>
    left.target_id.localeCompare(right.target_id, undefined, { numeric: true })
  );
}

export async function buildEvidenceManifest(
  markdownPath: string,
  jobId: string,
  targetId: string,
  pdfPath?: string,
): Promise<{ manifest: EvidenceManifest; markdown: Uint8Array; pdf?: Uint8Array }> {
  const markdown = await readFile(markdownPath);
  const pdf = pdfPath ? await readFile(pdfPath) : undefined;
  const sourceSha256 = sha256Bytes(markdown);
  const markdownText = markdown.toString("utf8");
  const scope = selectTargetScope(markdownText, targetId);
  const targetBlocks = markdownBlocks(
    markdownText,
    scope.selected_start_line,
    scope.selected_end_exclusive_line,
  );
  const samplingBlocks = samplingRuleBlocks(markdownText, targetId);
  const targetEvidence = targetBlocks.map((block) =>
    recordFromBlock(block, sourceSha256, "primary")
  );
  const primaryEvidence = [
    ...targetEvidence,
    ...samplingBlocks.map((block) =>
      recordFromBlock(block, sourceSha256, "sampling")
    ),
  ];
  const fullDocumentEvidence = markdownBlocks(
    markdownText,
    1,
    markdownText.replace(/\r\n?/g, "\n").split("\n").length + 1,
  ).map((block) =>
    recordFromBlock(block, sourceSha256, "reference")
  );
  const reference = referenceBundle(primaryEvidence, fullDocumentEvidence);
  const physicalTableFragments = tableFragments(targetBlocks, targetEvidence);
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: jobId,
    target_id: targetId,
    source: {
      adapter: "markdown-target-scope/v3" as const,
      file_name: basename(markdownPath),
      sha256: sourceSha256,
      ...(pdf && pdfPath
        ? {
            pdf_file_name: basename(pdfPath),
            pdf_sha256: sha256Bytes(pdf),
          }
        : {}),
    },
    scope,
    evidence: reference.evidence,
    table_fragments: physicalTableFragments,
    reference_occurrences: reference.occurrences,
  };
  const result = {
    manifest: {
      ...payload,
      evidence_fingerprint: sha256Json(payload),
    },
    markdown,
  };
  return pdf ? { ...result, pdf } : result;
}
import { NUMBERED_PROSE_BOUNDARY } from "./text-normalization.js";
