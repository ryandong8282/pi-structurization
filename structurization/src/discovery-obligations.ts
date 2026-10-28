import { sha256Json } from "./canonical.js";
import type { DocumentEvidence, DocumentTargetPlan } from "./document-discovery.js";
import { extractableClauseIds, type DocumentLedger } from "./document-ledger.js";
import type { DocumentSelectorPlan } from "./document-selector-compiler.js";
import { sourceSpanGaps, type SourceSpanRegistry } from "./source-span-registry.js";
import { documentContentRanges } from "./document-content-ranges.js";

export interface DiscoveryDecision {
  clause_id: string;
  disposition: "pending" | "context";
  context_key?: string;
  reason: string;
  binding_fingerprint: string;
}

/** Candidate signals create reading obligations, never a semantic target verdict. */
export function discoveryObligations(
  plan: DocumentTargetPlan,
  selectors: DocumentSelectorPlan,
  ledger: DocumentLedger,
  evidence: DocumentEvidence,
  registry: SourceSpanRegistry,
  decisions: readonly DiscoveryDecision[] = [],
) {
  const source = evidence.atoms.map((atom) => atom.text).join("");
  const lineOffsets = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") lineOffsets.push(index + 1);
  const atoms = new Map(evidence.atoms.map((atom) => [atom.atom_id, atom]));
  const spanRange = (span: { atom_id: string; start: number; end: number }) => {
    const atom = atoms.get(span.atom_id);
    return atom ? { evidence_id: "document", start: atom.start_offset + span.start, end: atom.start_offset + span.end } : undefined;
  };
  const primary = plan.targets.flatMap((target) => (target.work_scope?.primary_fragments ?? []).flatMap((fragment) => {
    const range = spanRange(fragment);
    const atom = atoms.get(fragment.atom_id);
    return range && atom?.text.slice(fragment.start, fragment.end) === fragment.text ? [range] : [];
  }));
  const required = new Set(extractableClauseIds(ledger));
  return ledger.clauses.filter((clause) => clause.kind === "item_candidate" || required.has(clause.clause_id) || clause.delegates_to_section).flatMap((clause) => {
    const start = lineOffsets[clause.line - 1] ?? source.length;
    const rawEnd = lineOffsets[clause.end_exclusive_line - 1] ?? source.length;
    const text = source.slice(start, rawEnd).trimEnd();
    const end = start + text.length;
    const missing = documentContentRanges(source, start, end).flatMap(range =>
      sourceSpanGaps({ evidence_id: "document", ...range }, primary));
    if (!missing.length) return [];
    const contexts = selectors.contexts.flatMap((context) => {
      const overlaps = context.span_ids.some((spanId) => {
        const span = registry.spans.find((entry) => entry.span_id === spanId);
        const range = span ? spanRange(span) : undefined;
        return range && Math.max(range.start, start) < Math.min(range.end, end);
      });
      return overlaps ? [{
        key: context.key,
        binding_fingerprint: sha256Json({ document: evidence.evidence_fingerprint, clause, text, context }),
      }] : [];
    });
    const decision = decisions.find((entry) => entry.clause_id === clause.clause_id);
    const resolved = decision?.disposition === "context" && Boolean(decision.reason.trim())
      && contexts.some((context) => context.key === decision.context_key && context.binding_fingerprint === decision.binding_fingerprint);
    return [{
      clause_id: clause.clause_id,
      start_line: clause.line,
      end_exclusive_line: clause.end_exclusive_line,
      atom_ids: evidence.atoms.filter((atom) => atom.start_offset < end && atom.end_offset > start).map((atom) => atom.atom_id),
      excerpt: text.slice(0, 800),
      missing_range_count: missing.length,
      missing_ranges: missing.slice(0, 8).map(range => ({
        ...range,
        start_line: lineOffsets.findLastIndex(offset => offset <= range.start) + 1,
        end_line: lineOffsets.findLastIndex(offset => offset < range.end) + 1,
        excerpt: source.slice(range.start, Math.min(range.end, range.start + 400)),
      })),
      contexts,
      status: resolved ? "resolved_context" as const : "pending" as const,
      decision: decision ?? null,
    }];
  });
}
