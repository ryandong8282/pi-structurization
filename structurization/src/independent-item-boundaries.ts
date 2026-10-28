import type { EvidenceManifest, EvidenceRecord } from "./contracts.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorIssue, TargetSelectorPlan } from "./target-selector-compiler.js";

interface SourceItemBoundary {
  key: string;
  label: string;
  record: EvidenceRecord;
  identity_ranges: Array<{ start: number; end: number }>;
  value_ranges: Array<{ start: number; end: number }>;
}

/**
 * Only consume explicit check-item columns in already classified formal rows.
 * Physical rows, arbitrary prose, headings and neutral table candidates are NOT
 * promoted to acceptance items here. Ambiguous sources remain reviewer-owned.
 */
function sourceItemBoundary(record: EvidenceRecord): SourceItemBoundary | undefined {
  if (record.role !== "formal_table_row" || record.table_row_kind !== "data"
    || !record.table_id || !record.columns || !record.cells) return;
  const identityColumns = record.columns.flatMap((column, index) => (
    /^(?:检查项目|检验项目|验收项目|项目名称)$/u.test(column.trim()) ? [index] : []
  ));
  if (!identityColumns.length) return;
  const labels = identityColumns.map((index) => record.cells![index]?.trim() ?? "");
  if (labels.some((label) => !label)) return;
  // Repeated merged cells are one label, not multiple source items. A separately
  // labelled condition/range column is deliberately excluded from identity.
  const labelPath = labels.filter((label, index) => label !== labels[index - 1]);
  const category = record.cells.find((cell) => cell === "主控项目" || cell === "一般项目") ?? "";
  const sequenceIndex = record.columns.findIndex((column) => /^(?:序|序号)$/u.test(column.trim()));
  const sequence = sequenceIndex < 0 ? "" : record.cells[sequenceIndex]?.trim() ?? "";
  const identityRanges: SourceItemBoundary["identity_ranges"] = [];
  const valueRanges: SourceItemBoundary["value_ranges"] = [];
  let offset = 0;
  for (const [index, column] of record.columns.entries()) {
    const value = record.cells[index] ?? "";
    const token = ` | ${column}=${value}`;
    const tokenStart = record.text.indexOf(token, offset);
    // Do not guess offsets in a differently serialized/legacy source.
    if (tokenStart < 0) return;
    const start = tokenStart + token.length - value.length;
    const end = start + value.length;
    if (identityColumns.includes(index)) identityRanges.push({ start, end });
    if (/^(?:允许值或允许偏差|允许值|允许偏差|质量标准|质量要求|验收标准)(?:\s*\/\s*数值)?$/u.test(column.trim())) {
      valueRanges.push({ start, end });
    }
    offset = tokenStart + token.length;
  }
  return {
    key: JSON.stringify([record.table_id, category, sequence, labelPath]),
    label: labelPath.join(" / "),
    record,
    identity_ranges: identityRanges,
    value_ranges: valueRanges,
  };
}

export function independentItemMergeIssues(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): TargetSelectorIssue[] {
  const boundaries = new Map(manifest.evidence.flatMap((record) => {
    const boundary = sourceItemBoundary(record);
    return boundary ? [[record.evidence_id, boundary] as const] : [];
  }));
  const spans = new Map(registry.spans.map((span) => [span.span_id, span]));
  return selectors.items.flatMap((item, itemIndex) => {
    const explicitTableValues = new Set(item.table?.properties.allowed_value_span_ids ?? []);
    // Do not count method, sampling, note or reference-only supporting evidence
    // as new item origins. Do inspect requirement/table values so moving sibling
    // rows out of criterion_span_ids cannot hide an aggregate.
    const selectedIds = new Set([
      ...item.criterion_span_ids,
      ...item.continuation_span_ids,
      ...item.fields.requirement.span_ids,
      ...explicitTableValues,
    ]);
    const origins = new Map<string, { boundary: SourceItemBoundary; span_ids: string[] }>();
    for (const spanId of selectedIds) {
      const span = spans.get(spanId);
      const boundary = span && boundaries.get(span.evidence_id);
      if (!span || !boundary) continue;
      const intersectsCriterion = [...boundary.identity_ranges, ...boundary.value_ranges].some((range) =>
        span.start < range.end && span.end > range.start
      );
      if (!intersectsCriterion && !explicitTableValues.has(spanId)) continue;
      const origin = origins.get(boundary.key) ?? { boundary, span_ids: [] };
      origin.span_ids.push(spanId);
      origins.set(boundary.key, origin);
    }
    if (origins.size < 2) return [];
    const sourceItems = [...origins.values()].map(({ boundary, span_ids }) => ({
      table_id: boundary.record.table_id,
      item_label: boundary.label,
      evidence_id: boundary.record.evidence_id,
      locator: boundary.record.locator,
      span_ids,
    }));
    const originSpanIds = new Set(sourceItems.flatMap((source) => source.span_ids));
    const tableIds = new Set(sourceItems.map((source) => source.table_id).filter(Boolean));
    const needsDestinationRetarget = tableIds.size > 1 || item.table?.source_kind === "reference";
    const candidateReferences = selectors.references.flatMap((reference, referenceIndex) => {
      if (reference.application_mode === "reference_placeholder") return [];
      const destinesCurrentItem = reference.destinations.some((destination) => destination.item_key === item.key);
      const sharesOriginAnchor = reference.anchor_span_ids.some((spanId) => originSpanIds.has(spanId));
      if (!destinesCurrentItem && !sharesOriginAnchor) return [];
      return [{
        reference_key: reference.key,
        path: `/references/${referenceIndex}/destinations`,
        current_destination_item_keys: reference.destinations.map((destination) => destination.item_key),
      }];
    });
    return [{
      code: "selector_independent_items_merged",
      path: `/items/${itemIndex}`,
      message: needsDestinationRetarget
        ? "原文分别列出的检查项目不能合并为一个验收项目；请分别建项，并且把「本标准表…」这类引用的 destinations 改到每一个新拆出的被引表子项上，不能只留在拆前的父项。"
        : "原文分别列出的检查项目不能合并为一个验收项目；请分别建项，可以继续拆细，但不要删除原要求来消除错误。",
      details: {
        item_key: item.key,
        required_action: needsDestinationRetarget
          ? "split_into_separate_items_then_retarget_resolved_reference_destinations_onto_each_referenced_table_child"
          : "split_into_separate_items_preserving_each_source_requirement",
        source_items: sourceItems,
        supporting_evidence_may_be_shared: true,
        ...(needsDestinationRetarget ? {
          writable_collection: "references",
          candidate_read_tool: "list_reference_occurrences",
          next_tool: "list_reference_occurrences",
          candidate_references: candidateReferences,
          how_to_pass: "先按原文检查项目分别建项。拆完后，凡写着「本标准表 X」的引用必须在 references[].destinations 里点到每一个新的 source_kind=reference 子项，不能只点原来的父项。supporting evidence 可以共用。",
        } : {}),
      },
    }];
  });
}
