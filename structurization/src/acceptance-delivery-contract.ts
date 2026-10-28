import { SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE as prompt_SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE, ITEM_NAME_PATH_GUIDANCE as prompt_ITEM_NAME_PATH_GUIDANCE, MODEL_OUTPUT_LANGUAGE_GUIDANCE as prompt_MODEL_OUTPUT_LANGUAGE_GUIDANCE, INVESTIGATION_KEY_SOURCE_GUIDANCE as prompt_INVESTIGATION_KEY_SOURCE_GUIDANCE, ITEM_CATEGORY_GUIDANCE as prompt_ITEM_CATEGORY_GUIDANCE, LOT_NAMING_GUIDANCE as prompt_LOT_NAMING_GUIDANCE, ACCEPTANCE_ORGANIZATION_GUIDANCE as prompt_ACCEPTANCE_ORGANIZATION_GUIDANCE, INSPECTION_UNIT_GUIDANCE as prompt_INSPECTION_UNIT_GUIDANCE, SOURCE_READING_GUIDANCE as prompt_SOURCE_READING_GUIDANCE, ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE as prompt_ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE, TABLE_SOURCE_OWNERSHIP_GUIDANCE as prompt_TABLE_SOURCE_OWNERSHIP_GUIDANCE, MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE as prompt_MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE as prompt_SELECTOR_FIELD_ROLE_GUIDANCE, SAMPLING_COMPLETE_SPAN_GUIDANCE as prompt_SAMPLING_COMPLETE_SPAN_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE as prompt_SELECTOR_SAMPLING_GUIDANCE, SELECTOR_PATCH_GUIDANCE as prompt_SELECTOR_PATCH_GUIDANCE, FIELD_SOURCE_BINDING_GUIDANCE as prompt_FIELD_SOURCE_BINDING_GUIDANCE, SOURCE_CONTEXT_INVESTIGATION as prompt_SOURCE_CONTEXT_INVESTIGATION, ACCEPTANCE_DELIVERY_CONTRACT as prompt_ACCEPTANCE_DELIVERY_CONTRACT } from "./acceptance-prompt-suite.js";
import type { EvidenceRecord, MaterializedAcceptanceItem } from './contracts.js';
import { sourceSpanCoveredBy, sourceSpanGaps, type SourceSpanRegistry } from './source-span-registry.js';
import type { TargetSelectorPlan } from './target-selector-compiler.js';

/** Current authoring contract, also available when old diagnostic facts expire. */
export const SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE = prompt_SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE;

export const ITEM_NAME_PATH_GUIDANCE = prompt_ITEM_NAME_PATH_GUIDANCE;

export const MODEL_OUTPUT_LANGUAGE_GUIDANCE = prompt_MODEL_OUTPUT_LANGUAGE_GUIDANCE;

export const INVESTIGATION_KEY_SOURCE_GUIDANCE = prompt_INVESTIGATION_KEY_SOURCE_GUIDANCE;

export const ITEM_CATEGORY_GUIDANCE = prompt_ITEM_CATEGORY_GUIDANCE;

/** Naming policy only: correspondence and scope are semantic decisions, not heading heuristics. */
export const LOT_NAMING_GUIDANCE = prompt_LOT_NAMING_GUIDANCE;

export const ACCEPTANCE_ORGANIZATION_GUIDANCE = prompt_ACCEPTANCE_ORGANIZATION_GUIDANCE;

export const INSPECTION_UNIT_GUIDANCE = prompt_INSPECTION_UNIT_GUIDANCE;

/** Recognizes only an already-authored quantity field, never classifies prose or item boundaries. */
export function isDirectFullInspectionQuantity(value: string): boolean {
  return /^(?:(?:检查|检验|检测|抽样|抽检|抽查)数量[:：]?)?(?:全验|全数(?:检查|检验|验收)|全部(?:检查|检验|验收))[。．.;；]?$/u.test(value.replace(/\s+/gu, ""));
}

/** Reading guidance only; property boundaries remain the Agent's semantic decision. */
export const SOURCE_READING_GUIDANCE = prompt_SOURCE_READING_GUIDANCE;

export const ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE = prompt_ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE;

export const TABLE_SOURCE_OWNERSHIP_GUIDANCE = prompt_TABLE_SOURCE_OWNERSHIP_GUIDANCE;

export const MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE = prompt_MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE;

/** Selector-only constraints: keep the prompt, tool contract and schema in sync. */
export const SELECTOR_FIELD_ROLE_GUIDANCE = prompt_SELECTOR_FIELD_ROLE_GUIDANCE;

export const SAMPLING_COMPLETE_SPAN_GUIDANCE = prompt_SAMPLING_COMPLETE_SPAN_GUIDANCE;

export const SELECTOR_SAMPLING_GUIDANCE = prompt_SELECTOR_SAMPLING_GUIDANCE;

export const SELECTOR_PATCH_GUIDANCE = prompt_SELECTOR_PATCH_GUIDANCE;

/** Field-authoring rules shared by the model prompt and the staging tool. */
export const FIELD_SOURCE_BINDING_GUIDANCE = prompt_FIELD_SOURCE_BINDING_GUIDANCE;

/** A reading procedure, not a keyword classifier or a document-specific answer key. */
export const SOURCE_CONTEXT_INVESTIGATION = prompt_SOURCE_CONTEXT_INVESTIGATION;

export const ACCEPTANCE_DELIVERY_CONTRACT = prompt_ACCEPTANCE_DELIVERY_CONTRACT;

type InspectableItem = Pick<MaterializedAcceptanceItem,
  'item_id' | 'name' | 'requirement' | 'method' | 'evidence_ids' | 'source_clause' | 'table_semantics'>;

export interface DeliveryInvestigationHint {
  code: 'requirement_method_identical' | 'table_value_method_source_overlap' | 'sibling_requirement_repeated' | 'sibling_requirement_contains' | 'heading_source_role_unconfirmed' | 'table_unit_unresolved' | 'prose_source_split';
  item_ids: string[];
  evidence_ids: string[];
  fields: string[];
  instruction: string;
}

const normalized = (text: string) => text.normalize('NFKC').replace(/\s/gu, '');

/** Observable overlaps only. They nominate review, never decide semantic validity or mutate a result. */
export function deliveryInvestigationHints(item: InspectableItem, peers: readonly InspectableItem[] = [], evidence: readonly EvidenceRecord[] = []): DeliveryInvestigationHint[] {
  const hints: DeliveryInvestigationHint[] = [];
  if (normalized(item.requirement) && normalized(item.requirement) === normalized(item.method)) {
    hints.push({ code: 'requirement_method_identical', item_ids: [item.item_id], evidence_ids: [...item.evidence_ids],
      fields: ['requirement', 'method'], instruction: 'The two final fields contain identical text. Compare each with its source role: does one describe a verdict and the other an inspection procedure? Identical wording alone is not proof of error.' });
  }
  if (item.table_semantics?.allowed_value && !item.table_semantics.unit?.trim()) {
    hints.push({ code: 'table_unit_unresolved', item_ids: [item.item_id], evidence_ids: [...item.evidence_ids],
      fields: ['table_semantics.unit', 'requirement'],
      instruction: 'A table value has no structured unit. Inspect its actual column/row headings, table caption and notes: an inherited unit may be missing. A blank unit can be correct for dimensionless or qualitative criteria, so decide from source meaning; do not add a default unit. Bind an applicable unit explicitly, including its source ownership. A value-only cell does not prove the table has no unit.' });
  }
  const cells = item.table_semantics?.cell_evidence ?? [];
  const overlaps = cells.filter(value => value.role === 'allowed_value' && normalized(value.text)
    && cells.some(method => method.role === 'inspection_method' && method.evidence_id === value.evidence_id
      && normalized(method.text) === normalized(value.text)));
  if (overlaps.length) hints.push({ code: 'table_value_method_source_overlap', item_ids: [item.item_id],
    evidence_ids: [...new Set(overlaps.map(cell => cell.evidence_id))], fields: ['requirement', 'method'],
    instruction: 'Allowed value and inspection method cite the same text in the same source resource. Open the actual table row and headers to verify field roles. Repeated text can occur in different cells; this is not a proven cell identity or defect. For isolated references use read_reference_facts.' });
  // Table fields commonly share a valid scalar criterion (e.g. a design value) across
  // independent rows. Whole-prose copying is a separate signal from scalar repetition.
  const repeated = !item.table_semantics && normalized(item.requirement) ? peers.filter(peer => !peer.table_semantics && peer.item_id !== item.item_id
    && normalized(peer.name) !== normalized(item.name)
    && peer.source_clause === item.source_clause
    && peer.evidence_ids.some(id => item.evidence_ids.includes(id))
    && normalized(peer.requirement) === normalized(item.requirement)) : [];
  if (repeated.length) hints.push({ code: 'sibling_requirement_repeated', item_ids: [item.item_id, ...repeated.map(peer => peer.item_id)],
    evidence_ids: [...new Set(repeated.flatMap(peer => peer.evidence_ids.filter(id => item.evidence_ids.includes(id))))],
    fields: ['name', 'requirement'], instruction: 'Differently named judgments sharing source have identical requirements. Use read_candidate_related_context to compare their allocations. Distinguish legitimate shared requirements from copying all sibling criteria into every split item. Out-of-scope peers remain read-only; do not infer duplication solely from this hint.' });
  const contained = !item.table_semantics && normalized(item.requirement) ? peers.filter(peer => !peer.table_semantics
    && peer.item_id !== item.item_id && peer.source_clause === item.source_clause
    && peer.evidence_ids.some(id => item.evidence_ids.includes(id))
    && normalized(peer.requirement) && normalized(peer.requirement) !== normalized(item.requirement)
    && normalized(item.requirement).includes(normalized(peer.requirement))) : [];
  if (contained.length) hints.push({ code: 'sibling_requirement_contains', item_ids: [item.item_id, ...contained.map(peer => peer.item_id)],
    evidence_ids: [...new Set(contained.flatMap(peer => peer.evidence_ids.filter(id => item.evidence_ids.includes(id))))],
    fields: ['name', 'requirement'], instruction: 'This requirement contains requirements delivered by related leaves. Use read_candidate_related_context and exact source to decide whether any independent acceptance judgment remains in the enclosing item after accounting for those leaves. Shared conditions or legitimate separate objects may justify reuse. If nothing remains, remove the redundant parent; otherwise preserve only its independent residual judgment. Text containment alone is not a defect, and out-of-scope peers remain read-only.' });
  const headings = evidence.filter(record => item.evidence_ids.includes(record.evidence_id)
    && record.kind === 'heading' && record.role === 'context');
  if (headings.length) hints.push({ code: 'heading_source_role_unconfirmed', item_ids: [item.item_id],
    evidence_ids: headings.map(record => record.evidence_id), fields: ['requirement', 'method', 'quantity'],
    instruction: 'A bound source has Markdown heading typography but no confirmed structural role. Open its source and surrounding clause, then check whether the selected text actually states the delivered field or only names a section. Preserve real content even when OCR marked it as a heading; a navigation title cannot establish a method or quantity. Decide by meaning, not the Markdown marker. Do not edit immutable evidence.' });
  return hints;
}

/** Advisory feedback on the author's saved prose draft; no compile, mutation or extra review round. */
export function selectorDeliveryInvestigationHints(
  selectors: TargetSelectorPlan, registry: SourceSpanRegistry, evidence: readonly EvidenceRecord[], touchedKeys: ReadonlySet<string>,
  previousItems: readonly TargetSelectorPlan['items'][number][] = [],
) {
  if (touchedKeys.size === 0) return [];
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const records = new Map(evidence.map(record => [record.evidence_id, record]));
  const sourceRecords = (ids: readonly string[]) => [...new Set(ids.flatMap(id => {
    const span = spans.get(id);
    return span ? [span.evidence_id] : [];
  }))];
  const text = (ids: readonly string[], separator: string) => ids.map(id => {
    const span = spans.get(id);
    return span ? records.get(span.evidence_id)?.text.slice(span.start, span.end) ?? '' : '';
  }).join(separator);
  const items: InspectableItem[] = selectors.items.filter(item => !item.table).map(item => {
    const clauses = [...new Set(sourceRecords(item.criterion_span_ids).flatMap(id => records.get(id)?.clause_id ?? []))];
    return {
      item_id: item.key, name: item.name, table_semantics: null,
      source_clause: clauses.length === 1 ? clauses[0]! : '',
      requirement: text(item.fields.requirement.span_ids, item.fields.requirement.separator),
      method: text(item.fields.method.span_ids, item.fields.method.separator),
      evidence_ids: sourceRecords([...item.criterion_span_ids, ...Object.values(item.fields).flatMap(field => field.span_ids),
        ...item.sampling.quantity_span_ids, ...item.sampling.script_span_ids]),
    };
  });
  const textHints = items.flatMap(item => deliveryInvestigationHints(item, items, evidence));
  const textContainedPairs = new Set(textHints.filter(hint => hint.code === 'sibling_requirement_contains')
    .flatMap(hint => hint.item_ids.slice(1).map(key => JSON.stringify([hint.item_ids[0], key]))));
  const requirementSpans = new Map(selectors.items.filter(item => !item.table).map(item => {
    const ids = item.fields.requirement.span_ids;
    const resolved = ids.flatMap(id => spans.get(id) ?? []);
    const eligible = item.fields.requirement.composition !== 'not_applicable' && resolved.length === ids.length
      && resolved.every(span => records.has(span.evidence_id) && records.get(span.evidence_id)!.kind !== 'table_row');
    return [item.key, eligible ? resolved : []] as const;
  }));
  // Display separators can interrupt a literal substring while the exact source
  // intervals are still contained. This remains a comparison, never a verdict.
  const sourceHints = items.flatMap(item => {
    const containing = requirementSpans.get(item.item_id) ?? [];
    if (!containing.length) return [];
    const contained = items.filter(peer => {
      const selected = requirementSpans.get(peer.item_id) ?? [];
      return peer.item_id !== item.item_id && peer.source_clause === item.source_clause && selected.length > 0
        && !textContainedPairs.has(JSON.stringify([item.item_id, peer.item_id]))
        && selected.every(span => sourceSpanCoveredBy(span, containing))
        && !containing.every(span => sourceSpanCoveredBy(span, selected));
    });
    if (!contained.length) return [];
    const visible = [...contained.filter(peer => touchedKeys.has(peer.item_id)),
      ...contained.filter(peer => !touchedKeys.has(peer.item_id))].slice(0, 8);
    return [{
      code: 'sibling_requirement_contains' as const, item_ids: [item.item_id, ...visible.map(peer => peer.item_id)],
      evidence_ids: [...new Set(visible.flatMap(peer => requirementSpans.get(peer.item_id)!.map(span => span.evidence_id)))],
      fields: ['requirement'],
      actual: { comparison_basis: 'strict_requirement_source_containment', containing_item_key: item.item_id,
        contained_item_count: contained.length, contained_items_complete: contained.length <= 8 },
      instruction: '本项 requirement 的精确来源区间包含这些相关项 requirement 的全部来源，显示拼接符或省略标点可能使文字包含比较未命中。这只比较来源分配，不认定缺陷或重复判断。按 key 读取相关记录和完整原文，核对相关项已交付的判断后，本项是否仍有独立剩余要求；有则精确保留，没有才按合法工具删除冗余项。共同条件或不同适用对象可合法复用，不能仅按区间包含关系删除。先读取完整来源并核对适用关系，再以 stage_target_selector_draft 保存有依据的修改，保留其他正确字段和项目，不自动裁剪或复制条件。',
    }];
  });
  const hints = [...textHints, ...sourceHints]
    .filter(hint => hint.item_ids.some(key => touchedKeys.has(key)));
  const comparisons = [...new Map(hints.map(hint => [`${hint.code}:${[...hint.item_ids].sort().join('|')}`, hint])).values()]
    .map(({ item_ids, instruction, ...hint }) => ({
      ...hint, item_keys: item_ids,
      next_tool: 'read_target_selectors',
      read_arguments: item_ids.map(key => ({ collection: 'items', key })),
      writable_collection: 'items',
      instruction: instruction.replaceAll('read_candidate_related_context', 'read_target_selectors')
        + ' This is an advisory comparison, not a validation error. Read the named item keys and source, decide semantically, and use stage_target_selector_draft only if a correction is needed.',
    }));
  // A source can be collectively covered while one split leaf loses a shared
  // condition. Nominate the source allocation, without classifying any text as
  // a condition or treating a valid independent split as a validation failure.
  const requirementOwners = new Map<string, string[]>();
  for (const item of selectors.items.filter(item => !item.table)) {
    if (item.fields.requirement.composition === 'not_applicable') continue;
    for (const id of sourceRecords(item.fields.requirement.span_ids)) {
      if (records.get(id)?.kind === 'table_row') continue;
      requirementOwners.set(id, [...(requirementOwners.get(id) ?? []), item.key]);
    }
  }
  const splitComparisons = [];
  for (const [evidenceId, itemKeys] of requirementOwners) {
    if (itemKeys.length < 2 || !itemKeys.some(key => touchedKeys.has(key))) continue;
    const record = records.get(evidenceId);
    if (!record) continue;
    const owners = new Set(itemKeys);
    const requirementCoverage = selectors.items.filter(item => owners.has(item.key))
      .flatMap(item => item.fields.requirement.span_ids.flatMap(id => spans.get(id) ?? []));
    const unassigned = sourceSpanGaps({ evidence_id: evidenceId, start: 0, end: record.text.length }, requirementCoverage)
      .filter(gap => record.text.slice(gap.start, gap.end).trim())
      .map(gap => ({ evidence_id: evidenceId, ...gap }));
    splitComparisons.push({
      code: 'prose_source_split' as const, item_keys: itemKeys, evidence_ids: [evidenceId], fields: ['requirement'],
      actual: { source_text_length: record.text.length,
        unassigned_requirement_interval_count: unassigned.length,
        unassigned_requirement_intervals: unassigned.slice(0, 8), intervals_complete: unassigned.length <= 8 },
      next_tool: 'read_target_selectors', read_arguments: itemKeys.map(key => ({ collection: 'items', key })),
      writable_collection: 'items', save_tool: 'stage_target_selector_draft',
      instruction: '同一正文来源被多个项目采用。actual.unassigned_requirement_intervals 是该来源中未被这组 requirement 联合承载的非空白区间，只返回坐标，不判定其业务角色；条号、标点、标题或其他字段内容可以合法位于 requirement 之外，不能为清空区间而回填整条。先按来源读取入口核对这些区间，再按 key 核对各项真实 requirement 和原文完整上下文，逐项判断哪些共同对象、适用条件、例外限定该项。区间为零也不证明逐项适用关系完整；兄弟项已保留条件不代表当前项也已交付。适用的限定须与本项判据一起绑定 fields.requirement.span_ids，不能只留在 name、reason、note 或另一项。只复用真正适用的条件，不复制无关兄弟判据；父检验批可继承的组织范围仍由 lot 承载。原文访问遵守 open_evidence 或已解析引用的 read_reference_facts/read_document_reference_evidence 策略，需要不连续片段时分别精确定位后保存完整 item。本提示仅为调查线索，不认定缺陷、不自动复制条件、不新增复核轮次，也不表示局部通过已完成语义验收。',
    });
  }
  const currentByKey = new Map(selectors.items.map(item => [item.key, item]));
  const changes = previousItems.flatMap(previous => {
    const current = currentByKey.get(previous.key);
    if (!touchedKeys.has(previous.key) || previous.table || !current || current.table
      || previous.fields.requirement.composition === 'not_applicable') return [];
    const coverage = current.fields.requirement.span_ids.flatMap(id => spans.get(id) ?? []);
    const gaps = previous.fields.requirement.span_ids.flatMap(id => {
      const span = spans.get(id), record = span && records.get(span.evidence_id);
      return span && record ? sourceSpanGaps(span, coverage)
        .map(gap => ({ evidence_id: span.evidence_id, ...gap })) : [];
    }).sort((a, b) => a.evidence_id.localeCompare(b.evidence_id) || a.start - b.start || a.end - b.end);
    const merged: typeof gaps = [];
    for (const gap of gaps) {
      const last = merged.at(-1);
      if (last?.evidence_id === gap.evidence_id && gap.start <= last.end) last.end = Math.max(last.end, gap.end);
      else merged.push({ ...gap });
    }
    const uncarried = merged.filter(gap => records.get(gap.evidence_id)?.text.slice(gap.start, gap.end).trim());
    if (!uncarried.length) return [];
    return [{
      code: 'requirement_source_removed' as const, item_keys: [current.key], fields: ['requirement'],
      evidence_ids: [...new Set(uncarried.map(gap => gap.evidence_id))],
      actual: { previous_requirement_span_ids: previous.fields.requirement.span_ids.slice(0, 24),
        previous_requirement_span_count: previous.fields.requirement.span_ids.length, previous_span_ids_complete: previous.fields.requirement.span_ids.length <= 24,
        current_requirement_span_ids: current.fields.requirement.span_ids.slice(0, 24),
        current_requirement_span_count: current.fields.requirement.span_ids.length, current_span_ids_complete: current.fields.requirement.span_ids.length <= 24,
        uncarried_interval_count: uncarried.length,
        uncarried_intervals: uncarried.slice(0, 8), intervals_complete: uncarried.length <= 8 },
      next_tool: 'read_target_selectors', read_arguments: [{ collection: 'items', key: current.key }],
      writable_collection: 'items', save_tool: 'stage_target_selector_draft',
      instruction: '本次已保存，原 requirement 的部分精确原文区间未再由本项 requirement 承载。按 actual 区间和当前 key 核对完整原文、当前项及同源分配；本提示不认定这些区间仍适用。裁剪无关兄弟判据、修复旧错误或调整正确字段角色可以合法减少区间，不要只为消提示回填整条原文。仍适用的对象、共同条件和例外必须与本项判据一起保留，不能只因兄弟项、name、note 或 reason 已引用就豁免。若替换时丢了独立验收判断，保存有依据的真实接收项，不把条件或方法制造成验收叶。按原访问策略读取 open_evidence 或已解析引用正文，必要时精确定位，再用 stage_target_selector_draft 增量保存完整记录；不自动恢复旧内容、不扩大范围、不新增复核轮次，也不重检未改草稿。',
    }];
  });
  return [...comparisons, ...splitComparisons, ...changes];
}
