import type { EvidenceManifest } from "./contracts.js";
import { selectorHasContextReference } from "./context-reference.js";
import type { SourceSpanRecord, SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorIssue, TargetSelectorPlan } from "./target-selector-compiler.js";
import { wholeExternalReferenceScopeReview } from "./external-reference-scope.js";

/** Explicit non-item provenance, never a reason-only component exclusion or a
 * residual disposition. Keep exact ranges so partial context cannot hide facts. */
export function nonItemReferenceSpans(
  selectors: Pick<TargetSelectorPlan, "source_dispositions"> & Partial<Pick<TargetSelectorPlan, "lots">>,
  registry: SourceSpanRegistry,
): SourceSpanRecord[] {
  const ids = new Set([
    ...(selectors.lots ?? []).filter(lot => lot.reason.trim()).flatMap(lot => lot.scope_span_ids),
    ...selectors.source_dispositions.filter(row => row.reason.trim()).flatMap(row => row.span_ids),
  ]);
  return registry.spans.filter(span => ids.has(span.span_id) && span.end > span.start);
}

/** Inventory accounting, not a claim of semantic completeness within each
 * component. An author's chosen target_span_ids cannot shrink the inventory. */
export function resolvedReferenceComponentCoverageIssues(
  selectors: Pick<TargetSelectorPlan, "references" | "source_dispositions"> & Partial<Pick<TargetSelectorPlan, "lots" | "items" | "sampling_rules">>,
  manifest: Pick<EvidenceManifest, "reference_occurrences"> & Partial<Pick<EvidenceManifest, "evidence">>,
  registry: SourceSpanRegistry,
  appliedItemSpansByKey: ReadonlyMap<string, readonly SourceSpanRecord[]>,
): TargetSelectorIssue[] {
  const spanById = new Map(registry.spans.map(span => [span.span_id, span]));
  const evidenceIds = (ids: readonly string[]) => ids.flatMap(id => {
    const span = spanById.get(id);
    return span && span.end > span.start ? [span.evidence_id] : [];
  });
  const appliedIds = new Set([...appliedItemSpansByKey.values()].flat().filter(span => span.end > span.start).map(span => span.evidence_id));
  const explicitlyDisposedIds = new Set(nonItemReferenceSpans(selectors, registry).map(span => span.evidence_id));
  return selectors.references.flatMap((reference, referenceIndex) => {
    const occurrence = manifest.reference_occurrences.find(entry => entry.occurrence_id === reference.occurrence_id);
    if (occurrence?.status !== "resolved" || occurrence.reference_kind !== "clause") return [];
    // A verified contextual mention imports no target facts. Reuse the complete
    // origin and business-binding guards; an action or reason alone is insufficient.
    if (manifest.evidence && selectorHasContextReference({
      ...selectors, lots: selectors.lots ?? [], items: selectors.items ?? [], sampling_rules: selectors.sampling_rules ?? [],
    }, registry, { evidence: manifest.evidence }, reference, occurrence)) return [];
    const excludedIds = new Set((reference.component_dispositions ?? [])
      .filter(row => row.decision === "not_applicable" && row.item_keys.length === 0 && row.reason.trim())
      .flatMap(row => row.component_span_ids)
      .filter(id => reference.target_span_ids.includes(id))
      .flatMap(id => evidenceIds([id])));
    // reference_only can preserve resolved content as an inline attachment to
    // a real field without duplicating that text in the field's own span_ids.
    const hasReceiver = reference.application_mode === "reference_only" && reference.destinations.some(destination =>
      appliedItemSpansByKey.has(destination.item_key));
    const routedIds = new Set(hasReceiver ? evidenceIds(reference.target_span_ids) : []);
    const missingIds = occurrence.target_evidence_ids.filter(id => !appliedIds.has(id)
      && !excludedIds.has(id) && !explicitlyDisposedIds.has(id) && !routedIds.has(id));
    if (missingIds.length === 0) return [];
    const scopeReview = wholeExternalReferenceScopeReview(occurrence);
    return [{
      code: "selector_resolved_reference_components_unaccounted",
      path: `/references/${referenceIndex}/component_dispositions`,
      message: "已解析引用仍有原文组件未进入真实项目，也没有有依据的不适用处置；只登记部分 target_span_ids 不能代表整个引用已处理。",
      details: {
        reference_key: reference.key,
        occurrence_id: occurrence.occurrence_id,
        actual: { resolved_component_count: occurrence.target_evidence_ids.length, unaccounted_component_count: missingIds.length },
        evidence_ids: scopeReview ? missingIds.slice(0, 12) : missingIds,
        ...(scopeReview ? { evidence_ids_complete: missingIds.length <= 12, evidence_ids_total: missingIds.length,
          scope_review: scopeReview, required_action: "review_whole_standard_business_scope_then_account_for_every_selected_component" } : {}),
        writable_paths: [...(scopeReview ? ["/content_scope", "/replaces_occurrence_id", "/correction_reason"] : []), `/references/${referenceIndex}/target_span_ids`, `/references/${referenceIndex}/component_dispositions`, "/items", "/sampling_rules", "/lots", "/source_dispositions"],
        next_tool: scopeReview ? scopeReview.next_tool : "list_reference_occurrences",
        ...(!scopeReview ? { next_tool_arguments: { cursor: 0, limit: 100 } } : {}),
        next_tools: [...(scopeReview ? [scopeReview.next_tool] : []), "list_reference_occurrences", "read_target_selectors", "stage_target_selector_draft"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: scopeReview ? scopeReview.instruction
          : "按 occurrence_id 在目录中核对 target_key 和 analysis_mode；inline 用 read_document_reference_evidence，isolated 用 read_reference_facts 读取未交代组件。依据原文判断适用范围：适用内容绑定到真实 items、其实际选用的 sampling_rules 或真实字段的内联引用内容；不适用的字段或条件，取得对应 span 后在当前 reference 的 target_span_ids 和 component_dispositions 中显式登记 not_applicable、item_keys=[] 及具体依据。组织范围可绑定 lots[].scope_span_ids，其他非项目上下文可按现有 source_dispositions 契约逐项处置，不使用笼统 residual 排除未读引用。通过 stage_target_selector_draft 增量保存完整记录后重验。字段范围不同不要求把所有组件都变成项目，但必须交代未导入部分。",
        do_not_edit: "不可变引用清单、原文和编译产物；不要为消错复制全部原文到无关字段或删除已有正确项目。",
      },
    }];
  });
}
