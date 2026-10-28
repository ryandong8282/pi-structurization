import { sha256Json } from "./canonical.js";
import type { DocumentSelectorPlan } from "./document-selector-compiler.js";

export type DiscoveryReviewCollection = "targets" | "contexts";
export interface DiscoveryReviewCheckpoint {
  record_fingerprint: string;
  verdict: "confirmed" | "needs_revision";
  reason: string;
  source_span_ids: string[];
}
export type DiscoveryReviewReceipts = Record<DiscoveryReviewCollection, Record<string, DiscoveryReviewCheckpoint>>;

/** An explicit reviewer judgment is tied to the current record and immutable source.
 * Context applicability is authored, so conservatively invalidate target judgments
 * when any upstream context changes rather than infer dependencies from keywords. */
export function discoveryReviewRecordFingerprint(
  selectors: DocumentSelectorPlan, evidenceFingerprint: string,
  collection: DiscoveryReviewCollection, row: unknown,
): string {
  return sha256Json({ evidenceFingerprint, collection, row,
    ...(collection === "targets" ? { contexts: selectors.contexts } : {}) });
}

export function discoveryReviewRows(
  selectors: DocumentSelectorPlan, evidenceFingerprint: string, receipts?: DiscoveryReviewReceipts,
) {
  return (["targets", "contexts"] as const).flatMap(collection => selectors[collection].map(row => {
    const fingerprint = discoveryReviewRecordFingerprint(selectors, evidenceFingerprint, collection, row);
    const stored = receipts?.[collection]?.[row.key];
    const current = stored?.record_fingerprint === fingerprint ? stored : undefined;
    return { collection, key: row.key, name: row.name, record_fingerprint: fingerprint,
      status: current?.verdict ?? "pending" as const,
      ...(current ? { reason: current.reason, source_span_ids: current.source_span_ids } : {}) };
  }));
}

export function discoveryReviewSummary(rows: ReturnType<typeof discoveryReviewRows>) {
  const counts = (collection: DiscoveryReviewCollection) => {
    const entries = rows.filter(row => row.collection === collection);
    return { total: entries.length, confirmed: entries.filter(row => row.status === "confirmed").length,
      needs_revision: entries.filter(row => row.status === "needs_revision").length,
      pending: entries.filter(row => row.status === "pending").length };
  };
  return { targets: counts("targets"), contexts: counts("contexts") };
}

/** Structural source references only; no text heuristics or semantic classifications. */
export function discoveryRecordSpanIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== "object") return;
    if (Array.isArray(input)) { input.forEach(visit); return; }
    for (const [key, child] of Object.entries(input)) {
      if (key.endsWith("_span_id") && typeof child === "string") result.add(child);
      else if (key.endsWith("_span_ids") || key === "span_ids") {
        if (Array.isArray(child)) for (const id of child) if (typeof id === "string") result.add(id);
      } else visit(child);
    }
  };
  visit(value); return [...result];
}
