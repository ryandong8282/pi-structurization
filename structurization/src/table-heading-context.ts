import type { EvidenceRecord } from "./contracts.js";

/** Physical source context only; no category vocabulary or category inference. */
export function createTableHeadingLookup(source: string) {
  const lines = source.split(/\r\n|\r|\n/u);
  const headings = lines.flatMap((text, index) => /^\s*#{1,6}\s+\S/u.test(text)
    ? [{ line: index + 1, text }] : []);
  return (record: EvidenceRecord, evidence: readonly EvidenceRecord[]) => {
    const match = /^line:(\d+)(?:\/|$)/u.exec(record.locator);
    if (record.kind !== "table_row" || !match) return [];
    const line = Number(match[1]);
    // Only explicit local table-line coordinates qualify, never external locators.
    if (!lines[line - 1] || !/<table\b|\|/iu.test(lines[line - 1]!)) return [];
    return headings.filter(heading => heading.line < line).slice(-4).flatMap(heading => {
      const registered = evidence.find(candidate => candidate.kind === "heading"
        && candidate.locator === `line:${heading.line}` && candidate.text === heading.text);
      return registered ? [registered] : [];
    });
  };
}
