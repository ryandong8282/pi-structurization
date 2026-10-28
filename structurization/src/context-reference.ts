import { referenceOccurrenceOriginEvidenceIds, type EvidenceManifest, type ReferenceResolution, type SemanticSourcePlan, type ReferenceOccurrence } from "./contracts.js";
import { collectSelectorSpanIds } from "./evidence-disposition-coverage.js";
import { sourceSpanCoveredBy, type SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

type ContextReferenceSelectors = Pick<TargetSelectorPlan, "source_dispositions" | "references" | "lots" | "items" | "sampling_rules">;
type ContextReferenceManifest = Pick<EvidenceManifest, "evidence">;

/** An explicit mention acknowledges a resolved occurrence; it does not import facts. */
function contextualOrigins(occurrence: ReferenceOccurrence | undefined, context: ReadonlySet<string>, business: ReadonlySet<string>): boolean {
  return Boolean(occurrence?.status === "resolved" && !occurrence.external_standard
    && referenceOccurrenceOriginEvidenceIds(occurrence).length
    && referenceOccurrenceOriginEvidenceIds(occurrence).every(id => context.has(id) && !business.has(id)));
}

export function selectorContextReferenceFacts(
  selectors: ContextReferenceSelectors, registry: SourceSpanRegistry, manifest: ContextReferenceManifest,
  occurrence: ReferenceOccurrence | undefined,
) {
  const origins = occurrence ? referenceOccurrenceOriginEvidenceIds(occurrence) : [];
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const contextSpans = (selectors.source_dispositions ?? [])
    .filter(row => row.disposition === "context" && row.reason.trim())
    .flatMap(row => row.span_ids.flatMap(id => spans.get(id) ?? []));
  const context = new Set((manifest.evidence ?? []).filter(record => sourceSpanCoveredBy(
    { evidence_id: record.evidence_id, start: 0, end: record.text.length }, contextSpans,
  )).map(record => record.evidence_id));
  const selected = collectSelectorSpanIds({ lots: selectors.lots, items: selectors.items, sampling_rules: selectors.sampling_rules });
  for (const reference of selectors.references) {
    if (reference.action === "mention" && reference.destinations.length === 0) continue;
    for (const id of reference.target_span_ids) selected.add(id);
  }
  const business = new Set([...selected].flatMap(id => spans.get(id)?.evidence_id ?? []));
  const business_origin_bindings: Array<{ path: string; collection: string; key?: string; span_id: string; evidence_id: string }> = [];
  function visit(value: unknown, path: string, collection: string, key?: string): void {
    if (Array.isArray(value)) { value.forEach((child,index) => visit(child, `${path}/${index}`, collection, key)); return; }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([field,child]) => visit(child, `${path}/${field}`, collection, key)); return;
    }
    if (typeof value !== "string" || !selected.has(value)) return;
    const span = spans.get(value);
    if (span && origins.includes(span.evidence_id)) business_origin_bindings.push({ path, collection, ...(key ? { key } : {}), span_id: value, evidence_id: span.evidence_id });
  }
  for (const collection of ["lots", "items", "sampling_rules"] as const) {
    (selectors[collection] ?? []).forEach((record,index) => visit(record, `/${collection}/${index}`, collection, record.key));
  }
  selectors.references.forEach((reference,index) => {
    if (reference.action !== "mention" || reference.destinations.length > 0) visit(reference.target_span_ids, `/references/${index}/target_span_ids`, "references", reference.key);
  });
  return { origin_evidence_ids: origins, incomplete_context_evidence_ids: origins.filter(id => !context.has(id)), business_origin_bindings,
    context_receipt_available: contextualOrigins(occurrence, context, business) };
}

export function selectorContextReferenceOrigins(
  selectors: ContextReferenceSelectors, registry: SourceSpanRegistry, manifest: ContextReferenceManifest,
  occurrence: ReferenceOccurrence | undefined,
): boolean {
  return selectorContextReferenceFacts(selectors, registry, manifest, occurrence).context_receipt_available;
}

export function selectorHasContextReference(
  selectors: ContextReferenceSelectors, registry: SourceSpanRegistry, manifest: ContextReferenceManifest,
  reference: TargetSelectorPlan["references"][number], occurrence: ReferenceOccurrence | undefined,
): boolean {
  if (reference.action !== "mention" || reference.application_mode !== "reference_only"
    || reference.destinations.length > 0 || reference.origin_binding || !reference.reason.trim()
    || reference.target_span_ids.length === 0) return false;
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  return reference.target_span_ids.every(id => occurrence?.target_evidence_ids.includes(spans.get(id)?.evidence_id ?? ""))
    && (reference.component_dispositions ?? []).every(row => row.decision === "not_applicable" && row.item_keys.length === 0)
    && selectorContextReferenceOrigins(selectors, registry, manifest, occurrence);
}

export function planHasContextReference(plan: SemanticSourcePlan, manifest: EvidenceManifest, resolution: ReferenceResolution): boolean {
  if (resolution.action !== "mention" || resolution.application_mode !== "reference_only"
    || resolution.destination_bindings.length > 0 || resolution.origin_binding || !resolution.reason.trim()
    || resolution.target_evidence_ids.length === 0) return false;
  const occurrence = manifest.reference_occurrences.find(row => row.occurrence_id === resolution.occurrence_id);
  const context = new Set(plan.evidence_dispositions
    .filter(row => row.disposition === "context" && row.item_ids.length === 0 && row.reason.trim())
    .map(row => row.evidence_id));
  const business = new Set([
    ...plan.inspection_lots.flatMap(lot => lot.evidence_ids),
    ...plan.acceptance_items.flatMap(item => [...item.evidence_ids, ...item.reference_evidence_ids, ...item.sampling.evidence_ids,
      ...Object.values(item.field_bindings).flatMap(binding => binding.evidence_ids)]),
    ...(plan.shared_sampling_rules ?? []).flatMap(rule => rule.evidence_ids),
    ...plan.reference_resolutions.filter(row => row.action !== "mention" || row.destination_bindings.length > 0)
      .flatMap(row => row.target_evidence_ids),
  ]);
  return resolution.target_evidence_ids.every(id => occurrence?.target_evidence_ids.includes(id))
    && contextualOrigins(occurrence, context, business);
}
