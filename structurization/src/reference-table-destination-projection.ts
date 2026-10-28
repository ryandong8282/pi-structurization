import type { TargetSelectorPlan } from "./target-selector-compiler.js";

const AUTHORABLE_DESTINATION_FIELDS = new Set([
  "name",
  "requirement",
  "method",
  "quantity",
  "note",
  "sampling",
]);

export interface ProjectedReferenceDestination {
  reference_key: string;
  reference_index: number;
  item_key: string;
  target_field: "name" | "requirement" | "method" | "quantity" | "note" | "sampling";
}

export interface ProjectReferencedTableDestinationsResult {
  plan: TargetSelectorPlan;
  added: ProjectedReferenceDestination[];
}

function tablePropertySpanIds(item: TargetSelectorPlan["items"][number]): string[] {
  const properties = item.table?.properties;
  if (!properties) return [];
  return Object.values(properties)
    .flat(2)
    .filter((value): value is string => typeof value === "string");
}

function existingDestinationField(
  reference: TargetSelectorPlan["references"][number],
): ProjectedReferenceDestination["target_field"] {
  const field = reference.destinations.find((destination) =>
    AUTHORABLE_DESTINATION_FIELDS.has(destination.target_field)
  )?.target_field;
  return field ?? "requirement";
}

/**
 * Copy an already-authored citation destination onto referenced-table children
 * that already carry that same citation. Do not invent a route, and do not
 * guess when more than one non-placeholder reference matches the child.
 */
export function projectReferencedTableDestinations(
  selectors: TargetSelectorPlan,
): ProjectReferencedTableDestinationsResult {
  const plan = structuredClone(selectors);
  const added: ProjectedReferenceDestination[] = [];
  if (!Array.isArray(plan.items) || !Array.isArray(plan.references)) {
    return { plan, added };
  }
  for (const item of plan.items) {
    if (item.table?.source_kind !== "reference") continue;
    const citationSpanIds = new Set(item.table.reference_span_ids);
    if (citationSpanIds.size === 0) continue;
    const childTableSpans = new Set(tablePropertySpanIds(item));
    const matches = plan.references.flatMap((reference, referenceIndex) => {
      if (reference.application_mode === "reference_placeholder") return [];
      if (!reference.anchor_span_ids.some((spanId) => citationSpanIds.has(spanId))) return [];
      if (
        reference.target_span_ids.length === 0
        || !reference.target_span_ids.some((spanId) => childTableSpans.has(spanId))
      ) return [];
      return [{ reference, referenceIndex }];
    });
    if (matches.length !== 1) continue;
    const { reference, referenceIndex } = matches[0]!;
    reference.destinations ??= [];
    if (reference.destinations.some((destination) => destination.item_key === item.key)) continue;
    const targetField = existingDestinationField(reference);
    reference.destinations.push({ item_key: item.key, target_field: targetField });
    added.push({
      reference_key: reference.key,
      reference_index: referenceIndex,
      item_key: item.key,
      target_field: targetField,
    });
  }
  return { plan, added };
}
