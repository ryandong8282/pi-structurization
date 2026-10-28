import type { EvidenceRecord } from "./contracts.js";

/** Call with one resolved target's inventory, never combine unrelated documents.
 * Match parser coordinates and cell geometry, not text similarity or meaning. */
export function tableRowRepresentationIds(records: readonly EvidenceRecord[]): Map<string, string> {
  const normalized = new Map<string, EvidenceRecord[]>();
  for (const row of records) {
    const point = /^line:(\d+)\/table:.*\/row:(\d+)$/u.exec(row.locator);
    if (!point || row.table_text_format !== "cell_values_v1" || !row.table_id || !row.cell_geometry?.length
      || row.row_index !== Number(point[2])) continue;
    const key = `${point[1]}\0${row.table_id}\0${row.row_index}`;
    normalized.set(key, [...(normalized.get(key) ?? []), row]);
  }
  const result = new Map<string, string>();
  for (const raw of records) {
    const point = /^line:(\d+)\/table-row:(\d+)$/u.exec(raw.locator);
    if (!point || !raw.table_id || !raw.cells?.length || !raw.text.trim().startsWith("<tr")
      || raw.row_index !== Number(point[2])) continue;
    const matches = normalized.get(`${point[1]}\0${raw.table_id}\0${raw.row_index}`);
    if (matches?.length !== 1) continue;
    const row = matches[0]!;
    if (JSON.stringify(row.cells) !== JSON.stringify(row.cell_geometry!.map(cell => cell.text))) continue;
    const ownCells = [...new Map(row.cell_geometry!.filter(cell => cell.row === row.row_index! - 1)
      .map(cell => [cell.cell_id, cell])).values()].sort((a, b) => a.column - b.column).map(cell => cell.text);
    if (JSON.stringify(ownCells) !== JSON.stringify(raw.cells)) continue;
    result.set(raw.evidence_id, row.evidence_id);
  }
  return result;
}
