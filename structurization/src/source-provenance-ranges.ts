import type { EvidenceRecord, ReferenceOccurrence } from "./contracts.js";
import { sha256Text } from "./canonical.js";
import type { DocumentEvidence } from "./document-discovery.js";
import { scanDocumentLedger } from "./document-ledger.js";

export interface SourceProvenanceRange {
  start: number;
  end: number;
}

interface SourceLineRange extends SourceProvenanceRange {
  number: number;
  text: string;
}

export interface DocumentSourceRange extends SourceProvenanceRange {
  resource_id: string;
  parent_atom_id: string;
  start_line: number;
  end_line: number;
}

export interface SourceLineWindow {
  start_line: number;
  end_exclusive_line: number;
}

function sourceLines(source: string): SourceLineRange[] {
  const lines: SourceLineRange[] = [];
  let start = 0;
  let number = 1;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const contentEnd = newline < 0
      ? source.length
      : newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ number, start, end, text: source.slice(start, contentEnd) });
    start = end;
    number += 1;
  }
  return lines;
}

/** Physical title navigation only. A clipped or protected title is never reconstructed. */
export function createDocumentHeadingNavigation(document: DocumentEvidence) {
  const source = document.atoms.map(atom => atom.text).join("");
  const lines = sourceLines(source);
  const headings = scanDocumentLedger(source, document.source.file_name).headings
    .map(heading => lines[heading.line - 1])
    .filter((line): line is SourceLineRange => Boolean(line));
  return (range: SourceProvenanceRange) => {
    const visible = headings.filter(line => line.start >= range.start && line.start + line.text.length <= range.end);
    return {
      navigation_only: true,
      heading_count: visible.length,
      headings_complete: visible.length <= 8,
      headings: visible.slice(0, 8).map(line => {
        const text = line.text.trim();
        return { line: line.number, preview: text.slice(0, 80), preview_truncated: text.length > 80 };
      }),
    };
  };
}

function charLocatorRange(locator: string, sourceLength: number): SourceProvenanceRange | null {
  const match = /^char:(\d+)-(\d+)$/u.exec(locator);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(end)
    && start >= 0
    && start < end
    && end <= sourceLength
    ? { start, end }
    : null;
}

export function sourceRangesOverlap(
  left: SourceProvenanceRange,
  right: SourceProvenanceRange,
): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Removes every physical line touched by a protected character range. */
export function excludeProtectedSourceLineWindows(
  source: string,
  windows: readonly SourceLineWindow[],
  protectedRanges: readonly SourceProvenanceRange[],
): SourceLineWindow[] {
  const lines = sourceLines(source);
  return windows.flatMap((window) => {
    const safeLineNumbers = lines
      .filter((line) => line.number >= window.start_line && line.number < window.end_exclusive_line)
      .filter((line) => !protectedRanges.some((range) => sourceRangesOverlap(line, range)))
      .map((line) => line.number);
    const groups: SourceLineWindow[] = [];
    for (const lineNumber of safeLineNumbers) {
      const current = groups.at(-1);
      if (current?.end_exclusive_line === lineNumber) {
        current.end_exclusive_line = lineNumber + 1;
      } else {
        groups.push({ start_line: lineNumber, end_exclusive_line: lineNumber + 1 });
      }
    }
    return groups;
  });
}

/** Splits immutable raw-document atoms only at physical protection boundaries. */
export function partitionDocumentSourceRanges(
  document: DocumentEvidence,
  protectedRanges: readonly SourceProvenanceRange[],
): DocumentSourceRange[] {
  const source = document.atoms.map((atom) => atom.text).join("");
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const lineNumberAtOffset = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
  return document.atoms.flatMap((atom) => {
    const atomRange = { start: atom.start_offset, end: atom.end_offset };
    const boundaries = new Set([atomRange.start, atomRange.end]);
    for (const range of protectedRanges) {
      if (!sourceRangesOverlap(atomRange, range)) continue;
      boundaries.add(Math.max(atomRange.start, range.start));
      boundaries.add(Math.min(atomRange.end, range.end));
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    return ordered.slice(0, -1).flatMap((start, index) => {
      const end = ordered[index + 1]!;
      if (start >= end) return [];
      const wholeAtom = start === atom.start_offset && end === atom.end_offset;
      return [{
        resource_id: wholeAtom
          ? atom.atom_id
          : `source-range:${sha256Text(`${document.source.sha256}\0${start}\0${end}`)}`,
        parent_atom_id: atom.atom_id,
        start,
        end,
        start_line: lineNumberAtOffset(start),
        end_line: lineNumberAtOffset(end),
      }];
    });
  });
}

export function referenceOccurrenceTargetsDocument(
  occurrence: ReferenceOccurrence,
  sourceSha256: string,
): boolean {
  if (occurrence.target_address) {
    return occurrence.target_address.source_id === sourceSha256;
  }
  return !occurrence.external_standard;
}

/** Resolves evidence back to raw Markdown by immutable provenance only. */
export function createEvidenceSourceRangeResolver(
  source: string,
  document: DocumentEvidence,
): (record: EvidenceRecord) => SourceProvenanceRange[] {
  const lines = sourceLines(source);
  const lineByNumber = new Map(lines.map((line) => [line.number, line]));
  const atomById = new Map(document.atoms.map((atom) => [atom.atom_id, atom]));

  return (record) => {
    const ranges: SourceProvenanceRange[] = [];
    const charRange = charLocatorRange(record.locator, source.length);
    if (charRange) ranges.push(charRange);

    if (!charRange) {
      const locatorLine = /^line:(\d+)/u.exec(record.locator)?.[1];
      const fragmentLine = /^table-fragment:line-(\d+)$/u.exec(record.table_fragment_id ?? "")?.[1];
      const lineNumber = Number(locatorLine ?? fragmentLine);
      const line = Number.isSafeInteger(lineNumber) ? lineByNumber.get(lineNumber) : undefined;
      if (line) {
        if (/^line:\d+\/table:/u.test(record.locator)) {
          const tableStartOffset = source.slice(line.start).search(/<table\b/iu);
          const tableStart = tableStartOffset >= 0 ? line.start + tableStartOffset : line.start;
          const tableSource = source.slice(tableStart);
          const tableClose = /<\/table>/iu.exec(tableSource);
          const tableEnd = tableClose?.index === undefined
            ? source.length
            : tableStart + tableClose.index + tableClose[0].length;
          const rowNumber = Number(
            /(?:\/table-row:|\/table:[^/]+\/row:)(\d+)$/u.exec(record.locator)?.[1],
          );
          const rawRows = [...source.slice(tableStart, tableEnd).matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)];
          const rawRow = Number.isSafeInteger(rowNumber) && rowNumber > 0
            ? rawRows[rowNumber - 1]
            : undefined;
          ranges.push(rawRow?.index === undefined
            ? { start: tableStart, end: tableEnd }
            : {
                start: tableStart + rawRow.index,
                end: tableStart + rawRow.index + rawRow[0].length,
              });
        } else {
          ranges.push({ start: line.start, end: line.end });
        }
      }
    }

    const lineageAtom = atomById.get(record.atom_id ?? record.evidence_id);
    if (ranges.length === 0 && lineageAtom) {
      ranges.push({ start: lineageAtom.start_offset, end: lineageAtom.end_offset });
    }

    if (ranges.length === 0 && record.text) {
      for (
        let start = source.indexOf(record.text);
        start >= 0;
        start = source.indexOf(record.text, start + 1)
      ) {
        ranges.push({ start, end: start + record.text.length });
      }
    }

    const seen = new Set<string>();
    return ranges.filter((range) => {
      if (range.start >= range.end) return false;
      const key = `${range.start}:${range.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
}
