import type { EvidenceManifest } from "./contracts.js";

/** Navigation only: different text representations remain different evidence. */
export function referenceRowRepairCandidates(
  manifest: EvidenceManifest,
  outsideIds: readonly string[],
  allowedIds: readonly string[],
): Array<{ outside_evidence_id: string; allowed_evidence_id: string; locator: string }> {
  const byId = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  const identity = (id: string): string | undefined => {
    const record = byId.get(id);
    if (!record || record.kind !== "table_row" || !record.table_id || !Number.isInteger(record.row_index)) return undefined;
    const location = /^line:(\d+)\/(?:table:[^/]+\/row:|table-row:)(\d+)$/u.exec(record.locator);
    if (!location || Number(location[2]) !== record.row_index) return undefined;
    return JSON.stringify([Number(location[1]), record.table_id, record.row_index]);
  };
  return [...new Set(outsideIds)].flatMap(outsideId => {
    const key = identity(outsideId);
    if (!key) return [];
    const matches = [...new Set(allowedIds)].filter(id => identity(id) === key);
    // Ambiguity must remain visible; do not guess an identity from similar text.
    if (matches.length !== 1) return [];
    return [{outside_evidence_id: outsideId, allowed_evidence_id: matches[0]!, locator: byId.get(matches[0]!)!.locator}];
  });
}
