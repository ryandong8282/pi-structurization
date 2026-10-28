import { sha256Json } from "./canonical.js";
import type { SourceSpanRecord, SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

type Item = TargetSelectorPlan["items"][number];
type Reference = TargetSelectorPlan["references"][number];
type Field = "requirement" | "method" | "quantity" | "note";
const FIELDS: readonly Field[] = ["requirement", "method", "quantity", "note"];

export interface CoverageReferenceRepairOption {
  reference_key: string;
  occurrence_id: string;
  source_item_key: string;
  target_field: Field;
  eligible_receiver_keys: string[];
  allowed_origin_span_ids: string[];
}

export interface AppliedCoverageReferenceRebindings {
  selectors: TargetSelectorPlan;
  receiver_item_keys: string[];
}

function contains(outer: SourceSpanRecord | undefined, inner: SourceSpanRecord | undefined): boolean {
  return Boolean(outer && inner && outer.evidence_id === inner.evidence_id
    && outer.start <= inner.start && outer.end >= inner.end && inner.end > inner.start);
}

/** Navigation and permission derive only from existing reference/span bindings, never source wording. */
export function coverageReferenceRepairOptions(
  source: TargetSelectorPlan,
  affectedKeys: ReadonlySet<string>,
  registry: SourceSpanRegistry,
): CoverageReferenceRepairOption[] {
  const spans = new Map(registry.spans.map((span) => [span.span_id, span]));
  const options: CoverageReferenceRepairOption[] = [];
  for (const reference of source.references) {
    // The validated receipt requires its exact literal anchor. Do not extend this exception to
    // multi-anchor/broad-context references, where the migration boundary is ambiguous.
    if (reference.application_mode !== "reference_only" || !reference.occurrence_id
      || reference.anchor_span_ids.length !== 1) continue;
    for (const destination of reference.destinations) {
      if (!affectedKeys.has(destination.item_key) || !FIELDS.includes(destination.target_field as Field)) continue;
      const owner = source.items.find((item) => item.key === destination.item_key);
      if (!owner) continue;
      const field = destination.target_field as Field;
      const originSpanIds = new Set(reference.anchor_span_ids);
      for (const anchorId of reference.anchor_span_ids) {
        const anchor = spans.get(anchorId);
        if (!anchor) continue;
        const fieldSpans = owner.fields[field].span_ids
          .map((id) => spans.get(id))
          .filter((span): span is SourceSpanRecord => Boolean(span));
        const enclosing = fieldSpans
          .filter((span) => contains(span, anchor) && span.end - span.start > anchor.end - anchor.start)
          .sort((left, right) => (left.end - left.start) - (right.end - right.start));
        // Only the narrowest already-authored citation context, not an entire evidence resource.
        if (enclosing[0]) originSpanIds.add(enclosing[0].span_id);
        else {
          // A field may store "applies according to" and the citation as adjacent exact spans.
          const adjacent = fieldSpans.filter((span) => span.evidence_id === anchor.evidence_id
            && span.end > span.start && span.end === anchor.start)
            .sort((left, right) => (left.end - left.start) - (right.end - right.start));
          if (adjacent[0]) originSpanIds.add(adjacent[0].span_id);
        }
      }
      const receivers = source.items.filter((item) => {
        if (affectedKeys.has(item.key)) return false;
        if (reference.destinations.some((binding) => binding.item_key === item.key)) return true;
        return reference.anchor_span_ids.some((anchorId) => {
          const anchor = spans.get(anchorId);
          if (item.table?.reference_span_ids.some((id) => contains(spans.get(id), anchor))) return true;
          // A broad source/name span containing the same text is not an explicit reference relationship.
          return Object.values(item.fields).some((binding) => binding.span_ids.some((id) =>
            contains(spans.get(id), anchor) && contains(anchor, spans.get(id))));
        });
      }).map((item) => item.key);
      if (receivers.length) options.push({
        reference_key: reference.key,
        occurrence_id: reference.occurrence_id,
        source_item_key: owner.key,
        target_field: field,
        eligible_receiver_keys: receivers,
        allowed_origin_span_ids: [...originSpanIds]
          .filter((id) => ![...originSpanIds].some((other) => other !== id
            && contains(spans.get(other), spans.get(id))))
          .sort((left, right) => spans.get(left)!.start - spans.get(right)!.start),
      });
    }
  }
  return options;
}

function referenceIdentity(reference: Reference): string {
  const { destinations: _destinations, reason: _reason, ...identity } = reference;
  return sha256Json(identity);
}

/**
 * The model chooses only the eligible receiver and original target field.
 * Deterministic code appends the already-authorized citation spans without
 * asking the model to reproduce the otherwise unchanged receiver item.
 */
export function applyCoverageReferenceRebindings(
  source: TargetSelectorPlan,
  candidate: TargetSelectorPlan,
  options: readonly CoverageReferenceRepairOption[],
): AppliedCoverageReferenceRebindings {
  const selectors = structuredClone(candidate);
  const sourceItemByKey = new Map(source.items.map((item) => [item.key, item]));
  const candidateItemByKey = new Map(selectors.items.map((item) => [item.key, item]));
  const additions = new Map<string, Map<Field, Set<string>>>();

  for (const option of options) {
    if (candidateItemByKey.has(option.source_item_key)) continue;
    const originalReference = source.references.find((reference) => reference.key === option.reference_key);
    const candidateReference = selectors.references.find((reference) => reference.key === option.reference_key);
    if (!originalReference || !candidateReference
      || referenceIdentity(originalReference) !== referenceIdentity(candidateReference)) continue;
    const preservedDestinations = originalReference.destinations.filter((destination) =>
      candidateItemByKey.has(destination.item_key)
    );
    if (!preservedDestinations.every((destination) => candidateReference.destinations.some((entry) =>
      sha256Json(entry) === sha256Json(destination)
    ))) continue;

    for (const destination of candidateReference.destinations) {
      if (destination.target_field !== option.target_field
        || !option.eligible_receiver_keys.includes(destination.item_key)) continue;
      const originalItem = sourceItemByKey.get(destination.item_key);
      const candidateItem = candidateItemByKey.get(destination.item_key);
      if (!originalItem || !candidateItem || sha256Json(originalItem) !== sha256Json(candidateItem)) continue;
      const byField = additions.get(destination.item_key) ?? new Map<Field, Set<string>>();
      const spanIds = byField.get(option.target_field) ?? new Set<string>();
      option.allowed_origin_span_ids.forEach((spanId) => spanIds.add(spanId));
      byField.set(option.target_field, spanIds);
      additions.set(destination.item_key, byField);
    }
  }

  for (const [itemKey, byField] of additions) {
    const item = candidateItemByKey.get(itemKey)!;
    for (const [field, spanIds] of byField) {
      item.fields[field].span_ids = [
        ...item.fields[field].span_ids,
        ...[...spanIds].filter((spanId) => !item.fields[field].span_ids.includes(spanId)),
      ];
    }
  }
  return { selectors, receiver_item_keys: [...additions.keys()].sort() };
}

/** The sole collateral-edit exception: append an existing citation when its affected owner is removed. */
export function isCoverageReferenceRebinding(
  original: Item,
  candidate: Item | undefined,
  source: TargetSelectorPlan,
  repaired: TargetSelectorPlan,
  options: readonly CoverageReferenceRepairOption[],
  registry: SourceSpanRegistry,
): boolean {
  if (!candidate) return false;
  // Identity, table criteria, sampling, classification and every other non-field property stay fixed.
  if (sha256Json({ ...candidate, fields: original.fields, reason: original.reason }) !== sha256Json(original)) return false;
  const spans = new Map(registry.spans.map((span) => [span.span_id, span]));
  const allowedByField = new Map<Field, Set<string>>();
  for (const option of options) {
    if (!option.eligible_receiver_keys.includes(original.key)
      || repaired.items.some((item) => item.key === option.source_item_key)) continue;
    const oldReference = source.references.find((reference) => reference.key === option.reference_key);
    const nextReference = repaired.references.find((reference) => reference.key === option.reference_key);
    if (!oldReference || !nextReference || referenceIdentity(oldReference) !== referenceIdentity(nextReference)) continue;
    if (!nextReference.destinations.some((destination) =>
      destination.item_key === original.key && destination.target_field === option.target_field)) continue;
    if (!oldReference.destinations.filter((destination) =>
      repaired.items.some((item) => item.key === destination.item_key)
    ).every((destination) => nextReference.destinations.some((next) => sha256Json(next) === sha256Json(destination)))) continue;
    const allowed = allowedByField.get(option.target_field) ?? new Set<string>();
    option.allowed_origin_span_ids.forEach((id) => allowed.add(id));
    allowedByField.set(option.target_field, allowed);
  }
  let appended = false;
  for (const field of Object.keys(original.fields) as Array<keyof Item["fields"]>) {
    const before = original.fields[field];
    const after = candidate.fields[field];
    if (sha256Json(before) === sha256Json(after)) continue;
    const allowed = allowedByField.get(field as Field);
    if (!allowed) return false;
    if (after.span_ids.length <= before.span_ids.length
      || !before.span_ids.every((id, index) => after.span_ids[index] === id)) return false;
    if (before.span_ids.length > 1 && after.separator !== before.separator) return false;
    if (before.span_ids.length && after.composition !== before.composition) return false;
    if (!before.span_ids.length && !["verbatim", "shared_inheritance", "reference"].includes(after.composition)) return false;
    if (new Set(after.span_ids).size !== after.span_ids.length) return false;
    const added = after.span_ids.slice(before.span_ids.length);
    if (!added.every((id) => [...allowed].some((originId) => contains(spans.get(originId), spans.get(id))))) return false;
    appended = true;
  }
  return appended;
}
