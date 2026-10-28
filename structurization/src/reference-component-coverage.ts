import type { EvidenceManifest } from "./contracts.js";
import { selectorHasContextReference } from "./context-reference.js";
import type { SourceSpanRecord, SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorIssue, TargetSelectorPlan } from "./target-selector-compiler.js";
import { wholeExternalReferenceScopeReview } from "./external-reference-scope.js";
import { tableRowRepresentationIds } from "./table-row-representations.js";

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
    const inventory = new Set(occurrence.target_evidence_ids);
    const aliases = tableRowRepresentationIds((manifest.evidence ?? []).filter(row => inventory.has(row.evidence_id)));
    const identity = (id: string) => aliases.get(id) ?? id;
    const identities = (ids: ReadonlySet<string>) => new Set([...ids].map(identity));
    const declaredUnselected = (reference.component_dispositions ?? []).filter(row => row.decision === "not_applicable"
      && row.item_keys.length === 0 && row.reason.trim()).flatMap(row => {
      const ids = row.component_span_ids.filter(id => !reference.target_span_ids.includes(id)
        && evidenceIds([id]).some(evidenceId => inventory.has(evidenceId)));
      return ids.length ? [{ ...row, component_span_ids: ids }] : [];
    });
    const declaredUnselectedIds = new Set(evidenceIds(declaredUnselected.flatMap(row => row.component_span_ids)));
    const synchronizationIssues: TargetSelectorIssue[] = declaredUnselected.length ? [{
      code: "selector_reference_exclusion_not_selected", path: `/references/${referenceIndex}/target_span_ids`,
      message: "作者已有明确的不适用处置，但目标片段选择尚未同步；这不是缺少业务判断。",
      details: { reference_key: reference.key, occurrence_id: occurrence.occurrence_id,
        actual: { declared_but_unselected_span_ids: declaredUnselected.flatMap(row => row.component_span_ids) },
        declared_component_dispositions: declaredUnselected,
        expected: "已明确处置的组件同步进入当前引用target_span_ids；保留其他作者记录和原判断。",
        evidence_ids: [...declaredUnselectedIds], writable_paths: [`/references/${referenceIndex}/target_span_ids`, `/references/${referenceIndex}/component_dispositions`],
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
        save_tool: "stage_reference_component_decisions",
        how_to_pass: "读取当前引用及draft_fingerprint。若已有作者判断仍正确，用stage_reference_component_decisions重存这里列出的原组件处置，程序同步目标片段并保留其他关系；无须重判整章或重交整条引用。若原判断确需修正，则按原文正常编辑，不把本诊断当作批准不适用。",
      },
    }] : [];
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
    const accounted = identities(new Set([...appliedIds, ...excludedIds, ...explicitlyDisposedIds, ...routedIds]));
    const missingIds = occurrence.target_evidence_ids.filter(id => !accounted.has(identity(id)) && !declaredUnselectedIds.has(id));
    if (missingIds.length === 0) return synchronizationIssues;
    const scopeReview = wholeExternalReferenceScopeReview(occurrence);
    return [...synchronizationIssues, {
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
