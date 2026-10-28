import { canonicalize } from "./canonical.js";
import {
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceOriginEvidenceIds,
  type AcceptanceItemField,
  type EvidenceManifest,
} from "./contracts.js";
import { resolveSourceSpan, sourceSpanCoveredBy, type SourceSpanRecord, type SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorDraft, TargetSelectorIssue, TargetSelectorPlan } from "./target-selector-compiler.js";

export interface ReferenceFieldSelectionBinding {
  item_key: string;
  target_field: AcceptanceItemField;
  target_span_ids: string[];
  component_decision: "independent_item" | "same_judgment" | "acceptance_branch";
  local_context_fields: Array<{ field: AcceptanceItemField; span_ids: string[]; reason: string }>;
  reason: string;
}

export interface ReferenceFieldSelection {
  occurrence_id: string;
  action: "adopt" | "conditional" | "compare";
  reason: string;
  bindings: ReferenceFieldSelectionBinding[];
  origin_binding?: { item_key: string; target_field: AcceptanceItemField };
}

export interface ReferenceFieldSelectionResult {
  /** Full touched records for the existing atomic draft upsert, never a persisted new format. */
  draft: TargetSelectorDraft;
  changed_paths: string[];
  derived_relations: Array<{
    reference_key: string;
    occurrence_id: string;
    item_key: string;
    target_field: AcceptanceItemField;
    target_span_ids: string[];
    anchor_span_ids: string[];
  }>;
  issues: TargetSelectorIssue[];
}

const FIELDS: AcceptanceItemField[] = ["name", "requirement", "method", "quantity", "note"];
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const routeKey = (item: string, field: string) => `${item}\0${field}`;
const overlaps = (a: SourceSpanRecord, b: SourceSpanRecord) =>
  a.evidence_id === b.evidence_id && a.start < b.end && b.start < a.end;

/**
 * Expand explicit business choices into the existing selector representation.
 * Nothing here decides applicability, invents absent roles, edits immutable
 * occurrences, or replaces an entire field. Failure is an all-or-nothing result.
 */
export function projectReferenceFieldSelections(
  current: TargetSelectorPlan,
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
  selections: readonly ReferenceFieldSelection[],
): ReferenceFieldSelectionResult {
  const result: ReferenceFieldSelectionResult = { draft: {}, changed_paths: [], derived_relations: [], issues: [] };
  const plan = structuredClone(current);
  const touchedItemKeys = new Set<string>();
  const touchedReferenceKeys = new Set<string>();
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const sources = new Map(manifest.evidence.map(record => [record.evidence_id, {
    source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
  }]));
  const fail = (code: string, path: string, message: string, actual: unknown, expected: unknown,
    nextTool = "stage_target_selector_draft", nextToolArguments?: Record<string, unknown>) => result.issues.push({
    code: `reference_field_selection_${code}`, path, message,
    details: { actual, expected, writable_path: path, next_tool: nextTool,
      ...(nextToolArguments ? { next_tool_arguments: nextToolArguments } : {}),
      transaction_applied: false, do_not_edit: "不可变 occurrence、原文、编译产物和未点名的正确记录。" },
  });
  const resolve = (ids: readonly string[], path: string, allowedEvidence?: readonly string[]) => {
    const resolved = ids.flatMap((id, index) => {
      const problems: TargetSelectorIssue[] = [];
      const span = resolveSourceSpan(registry, id, sources, `${path}/${index}`, problems);
      if (!span || (allowedEvidence && !allowedEvidence.includes(span.evidence_id))) {
        fail("source_invalid", `${path}/${index}`, "必须使用本次引用指定来源中已经登记的精确片段。",
          { span_id: id, evidence_id: span?.evidence_id, problems }, { allowed_evidence_ids: allowedEvidence ?? "当前证据包", registered_exact_span: true }, "locate_evidence_span");
        return [];
      }
      return [span];
    });
    return resolved;
  };
  const seenOccurrences = new Set<string>();
  if (!selections.length) fail("empty", "/reference_selections", "请提交至少一个明确引用字段选择。", [], { min_items: 1 });
  for (const [selectionIndex, selection] of selections.entries()) {
    const base = `/reference_selections/${selectionIndex}`;
    const failFullRecord = (code: string, path: string, message: string, actual: unknown, expected: unknown) => {
      const references = current.references.filter(reference => reference.occurrence_id === selection.occurrence_id
        || reference.anchor_span_ids.some(id => anchors.includes(id)));
      const itemKeys = unique([...selection.bindings.map(binding => binding.item_key),
        ...references.flatMap(reference => reference.destinations.map(destination => destination.item_key))]);
      const records = [
        ...references.map(reference => ({ collection: "references", key: reference.key })),
        ...current.items.filter(item => itemKeys.includes(item.key)).map(item => ({ collection: "items", key: item.key })),
      ];
      const paths = records.map(record => `/${record.collection}/${record.collection === "references"
        ? current.references.findIndex(reference => reference.key === record.key)
        : current.items.findIndex(item => item.key === record.key)}`);
      result.issues.push({ code: `reference_field_selection_${code}`, path, message,
        details: { actual, expected, writable_paths: paths, write_mode: "full_records",
          next_tool: "read_target_selectors", next_tool_arguments: records[0],
          record_reads: records.map(arguments_ => ({ tool: "read_target_selectors", arguments: arguments_ })),
          save_tool: "stage_target_selector_draft", transaction_applied: false,
          how_to_pass: "按 record_reads 读取已有完整记录，由模型核对原文后，用 stage_target_selector_draft({operation:'upsert',draft:{items:[完整项目],references:[完整引用]}}) 只提交实际修改的完整记录；不再用 reference_selections 重试此修法，保留未修改字段、其他记录和抽样决定。",
          do_not_edit: "不可变 occurrence、原文、编译产物和未点名的正确记录。" },
      });
    };
    if (seenOccurrences.has(selection.occurrence_id)) {
      fail("duplicate_occurrence", `${base}/occurrence_id`, "同一次事务中每个 occurrence 只出现一次，将其字段选择放在同一 bindings 中。", selection.occurrence_id, "unique occurrence_id");
      continue;
    }
    seenOccurrences.add(selection.occurrence_id);
    const occurrences = manifest.reference_occurrences.filter(entry => entry.occurrence_id === selection.occurrence_id);
    if (occurrences.length !== 1) {
      fail("occurrence_unknown", `${base}/occurrence_id`, "逐字使用已登记的唯一 occurrence_id。", selection.occurrence_id, "one registered occurrence", "list_reference_occurrences");
      continue;
    }
    const occurrence = occurrences[0]!;
    const originEvidence = referenceOccurrenceOriginEvidenceIds(occurrence);
    const anchors = referenceOccurrenceLiteralSpanIds(occurrence);
    if (!anchors.length) {
      // A located span is not registration of this occurrence's literal. The
      // resolver must establish that immutable relation before projection.
      const originSpans = registry.spans.filter(span => originEvidence.includes(span.evidence_id)
        && sources.get(span.evidence_id)?.text.slice(span.start, span.end).includes(occurrence.raw_reference));
      fail("literal_required", `${base}/occurrence_id`,
        "该 occurrence 尚未登记精确引用原话；仅 locate 得到 span 不能替代登记。请用包含原引文的 origin_span_id、raw_reference、模型确认的 origin_field/target/relation 调用 resolve_document_reference，取得含 reference_literal_span_id 的 occurrence 后再提交本次选择；无来源 span 时先 locate_evidence_span。不要手改 occurrence 或换成其他接收字段消错。",
        { occurrence_id: occurrence.occurrence_id, reference_literal_span_ids: [], origin_span_candidates: originSpans.map(span => span.span_id) },
        { exact_quote: occurrence.raw_reference, origin_evidence_ids: originEvidence, registered_occurrence_literal: true,
          required_resolve_fields: ["origin_span_id", "raw_reference", "origin_field", "target", "relation"],
          model_selected_resolve_fields: ["origin_field", "target", "relation", ...(originSpans.length !== 1 ? ["origin_span_id"] : [])] },
        originSpans.length ? "resolve_document_reference" : "locate_evidence_span",
        originSpans.length
          ? { raw_reference: occurrence.raw_reference, ...(originSpans.length === 1 ? { origin_span_id: originSpans[0]!.span_id } : {}) }
          : { quote: occurrence.raw_reference, ...(originEvidence.length === 1 ? { evidence_id: originEvidence[0] } : {}) });
      continue;
    }
    const anchorSpans = resolve(anchors, `${base}/occurrence_id`, originEvidence);
    const references = plan.references.filter(reference => reference.occurrence_id === occurrence.occurrence_id);
    if (references.length > 1 || plan.references.some(reference => !reference.occurrence_id
      && reference.anchor_span_ids.some(id => anchors.includes(id)))) {
      failFullRecord("reference_ambiguous", `${base}/occurrence_id`, "现有引用记录不能唯一对应此 occurrence；先完整编辑 references，明确各记录的 occurrence_id。",
        { reference_keys: references.map(reference => reference.key) }, "one explicitly identified reference");
      continue;
    }
    const previous = references[0];
    if (previous && (previous.application_mode !== "reference_only"
      || previous.destinations.some(destination => destination.target_field === "sampling")
      || previous.import_scope.allowed_fields.includes("sampling")
      || previous.component_dispositions?.some(component => component.decision === "not_applicable"))) {
      failFullRecord("complex_reference", `${base}/occurrence_id`, "此引用包含占位、抽样或排除处置，无法安全进行局部字段投影；请保留现有内容并完整编辑该 reference。",
        { reference_key: previous.key, application_mode: previous.application_mode, destinations: previous.destinations }, "reference_only with explicit field receivers and adopted components only");
      continue;
    }
    const referenceKey = previous?.key ?? `field-selection:${occurrence.occurrence_id}`;
    if (!previous && plan.references.some(reference => reference.key === referenceKey)) {
      fail("key_conflict", `${base}/occurrence_id`, "派生引用键与另一条记录冲突，请先消除该键冲突。", referenceKey, "unused derived reference key");
      continue;
    }
    const nextReference = previous ? structuredClone(previous) : {
      key: referenceKey, occurrence_id: occurrence.occurrence_id,
      anchor_span_ids: anchors, target_span_ids: [], action: selection.action,
      application_mode: "reference_only" as const,
      import_scope: { mode: "field_specific" as const, allowed_fields: [], reason: selection.reason },
      destinations: [], reason: selection.reason,
    } as TargetSelectorPlan["references"][number];
    const beforeItems = new Map(plan.items.map(item => [item.key, structuredClone(item)]));
    // A binding can retain local context in its own receiving field. Separate
    // bindings must not overwrite one another's explicitly chosen context.
    const fieldWriters = new Map<string, number>();
    let conflictingWrites = false;
    selection.bindings.forEach((binding, bindingIndex) => {
      for (const field of unique([binding.target_field, ...binding.local_context_fields.map(context => context.field)])) {
        const key = routeKey(binding.item_key, field);
        const prior = fieldWriters.get(key);
        if (prior !== undefined && prior !== bindingIndex) {
          conflictingWrites = true;
          fail("field_write_conflict", `${base}/bindings/${bindingIndex}`, "同一事务的两个 binding 同时修改同一字段；请把该字段及其本地语境放在一个明确选择中，不能按调用顺序覆盖。",
            { item_key: binding.item_key, field, binding_indexes: [prior, bindingIndex] }, "one binding owns each modified item field");
        } else fieldWriters.set(key, bindingIndex);
      }
    });
    if (conflictingWrites) continue;
    if (previous && previous.action !== selection.action
      && previous.destinations.some(destination => !selection.bindings.some(binding =>
        routeKey(binding.item_key, binding.target_field) === routeKey(destination.item_key, destination.target_field)))) {
      fail("unselected_action_conflict", `${base}/action`, "引用 action 作用于全部接收者；本次修改会改变未点名接收者的采用或条件状态，请保留原 action，或完整编辑该引用。",
        { previous_action: previous.action, requested_action: selection.action, destinations: previous.destinations },
        { action: previous.action, scope: "untouched receivers retain their authored decision" });
      continue;
    }
    const selectedRoutes = new Set<string>();
    const newComponents = new Map<string, { decision: ReferenceFieldSelectionBinding["component_decision"]; item_keys: string[]; reason: string }>();
    const removedCandidates = new Set<string>();
    if (!selection.bindings.length) fail("bindings_empty", `${base}/bindings`, "请指定至少一个项目接收字段。", [], { min_items: 1 });
    for (const [bindingIndex, binding] of selection.bindings.entries()) {
      const path = `${base}/bindings/${bindingIndex}`;
      const items = plan.items.filter(item => item.key === binding.item_key);
      const key = routeKey(binding.item_key, binding.target_field);
      if (items.length !== 1 || !FIELDS.includes(binding.target_field) || selectedRoutes.has(key)) {
        fail("receiver_invalid", path, "使用唯一既有 item_key 与有效字段；同一引用本次每个接收字段只声明一次。", { item_key: binding.item_key, target_field: binding.target_field }, "unique existing item and unique field binding");
        continue;
      }
      selectedRoutes.add(key);
      const item = items[0]!;
      touchedItemKeys.add(item.key);
      const before = beforeItems.get(item.key)!;
      const targets = unique(binding.target_span_ids);
      if (!targets.length) fail("targets_empty", `${path}/target_span_ids`, "明确选择至少一个被引精确片段；未规定或不适用须用正常草稿编辑明确判断。", [], { min_items: 1 });
      resolve(targets, `${path}/target_span_ids`, occurrence.target_evidence_ids);
      const oldRoute = previous?.destinations.some(destination => routeKey(destination.item_key, destination.target_field) === key);
      const oldTargets = oldRoute ? before.fields[binding.target_field].span_ids.filter(id => previous!.target_span_ids.includes(id)) : [];
      if (oldRoute && !oldTargets.length) {
        failFullRecord("old_contribution_ambiguous", path, "旧接收关系没有可按精确 span 分离的字段贡献；请完整编辑该 item 与 reference，不能猜测要删哪段。", { reference_key: previous!.key, field_span_ids: before.fields[binding.target_field].span_ids, old_target_span_ids: previous!.target_span_ids }, "exact existing field contribution");
        continue;
      }
      for (const id of oldTargets) removedCandidates.add(id);
      const retained = before.fields[binding.target_field].span_ids.filter(id => {
        if (!oldTargets.includes(id)) return true;
        return plan.references.some(reference => reference !== previous && reference.target_span_ids.includes(id)
          && reference.destinations.some(destination => routeKey(destination.item_key, destination.target_field) === key));
      });
      // A larger/overlapping legacy field span cannot be subtracted by handle:
      // doing so would silently discard local conditions or another route.
      for (const id of retained) {
        const span = spans.get(id);
        if (span && oldTargets.some(old => old !== id && spans.has(old) && overlaps(span, spans.get(old)!))) {
          failFullRecord("old_contribution_overlap", path, "旧字段中有交叠来源，无法证明只替换本次引用贡献；请用正常草稿编辑明确划分。", { retained_span_id: id, old_target_span_ids: oldTargets }, "separable exact source spans");
        }
      }
      item.fields[binding.target_field] = { ...before.fields[binding.target_field],
        composition: binding.target_field === "name" && before.fields.name.composition === "semantic_summary" ? "semantic_summary" : "reference",
        span_ids: unique([...retained, ...targets]), separator: before.fields[binding.target_field].separator || (retained.length + targets.length > 1 ? "\n" : ""), reason: binding.reason };
      const contextFields = new Set<string>();
      for (const [contextIndex, context] of binding.local_context_fields.entries()) {
        const contextPath = `${path}/local_context_fields/${contextIndex}`;
        if (!FIELDS.includes(context.field) || contextFields.has(context.field) || !context.span_ids.length) {
          fail("context_invalid", contextPath, "每个本地上下文字段只声明一次并提供非空精确来源；[] 表示整体保留已有上下文字段。", context, "unique field with nonempty origin spans");
          continue;
        }
        contextFields.add(context.field);
        const additions = resolve(unique(context.span_ids), `${contextPath}/span_ids`, originEvidence);
        const field = item.fields[context.field];
        const kept = field.span_ids.filter(id => !additions.some(added => {
          const old = spans.get(id);
          return old && old.span_id !== added.span_id && sourceSpanCoveredBy(old, [added]);
        }));
        for (const added of additions) {
          if (kept.some(id => spans.has(id) && sourceSpanCoveredBy(added, [spans.get(id)!]))) continue;
          if (kept.some(id => spans.has(id) && overlaps(added, spans.get(id)!))) {
            fail("context_overlap", contextPath, "所选上下文与字段现有片段部分重叠；请明确选择不重复的完整语境。", { span_id: added.span_id, existing_span_ids: kept }, "nonoverlapping or containing exact spans");
          } else kept.push(added.span_id);
        }
        item.fields[context.field] = { ...field, span_ids: kept,
          composition: field.composition === "not_applicable" ? "verbatim" : field.composition,
          separator: field.separator || (kept.length > 1 ? "\n" : ""), reason: context.reason };
      }
      if (!nextReference.destinations.some(destination => routeKey(destination.item_key, destination.target_field) === key)) {
        nextReference.destinations.push({ item_key: item.key, target_field: binding.target_field });
      }
      for (const id of targets) {
        const component = newComponents.get(id);
        if (component && component.decision !== binding.component_decision) {
          fail("component_conflict", `${path}/component_decision`, "同一精确组件本次被赋予不同处置，须由模型统一明确。", { span_id: id, decisions: [component.decision, binding.component_decision] }, "one explicit component decision");
        } else newComponents.set(id, { decision: binding.component_decision, item_keys: unique([...(component?.item_keys ?? []), item.key]), reason: binding.reason });
      }
      result.derived_relations.push({ reference_key: referenceKey, occurrence_id: occurrence.occurrence_id,
        item_key: item.key, target_field: binding.target_field, target_span_ids: targets, anchor_span_ids: anchors });
    }
    const routeUsesTarget = (destination: typeof nextReference.destinations[number], id: string) => {
      if (!FIELDS.includes(destination.target_field as AcceptanceItemField)) return true;
      const selected = selection.bindings.find(binding => routeKey(binding.item_key, binding.target_field)
        === routeKey(destination.item_key, destination.target_field));
      if (selected) return selected.target_span_ids.includes(id);
      const field = plan.items.find(item => item.key === destination.item_key)?.fields[destination.target_field as AcceptanceItemField];
      return field?.span_ids.includes(id) ?? false;
    };
    const untouchedComponentOwner = (itemKey: string, id: string) =>
      previous?.component_dispositions?.some(component => component.component_span_ids.includes(id) && component.item_keys.includes(itemKey))
      && nextReference.destinations.some(destination => destination.item_key === itemKey
        && !selectedRoutes.has(routeKey(destination.item_key, destination.target_field)));
    const targetStillUsed = (id: string) => nextReference.destinations.some(destination => routeUsesTarget(destination, id)
      || untouchedComponentOwner(destination.item_key, id));
    const remainingTargets = (previous?.target_span_ids ?? []).filter(id => !removedCandidates.has(id) || targetStillUsed(id));
    nextReference.target_span_ids = unique([...remainingTargets, ...newComponents.keys()]);
    const components: NonNullable<typeof nextReference.component_dispositions> = [];
    const unchangedComponents = new Set<object>();
    for (const id of nextReference.target_span_ids) {
      const previousComponents = (previous?.component_dispositions ?? []).filter(component => component.component_span_ids.includes(id));
      const newComponent = newComponents.get(id);
      const oldComponent = previousComponents[0];
      if (previousComponents.length > 1 || (!oldComponent && !newComponent)) {
        failFullRecord("component_ownership_ambiguous", `${base}/bindings`, "现有目标组件缺少唯一的作者处置，无法安全保留并局部更正；请完整编辑该 reference 的组件处置。", { span_id: id, previous_components: previousComponents }, "one explicit component disposition per target span");
        continue;
      }
      if (oldComponent && oldComponent.component_span_ids.every(spanId => !removedCandidates.has(spanId) && !newComponents.has(spanId))) {
        if (!unchangedComponents.has(oldComponent)) components.push(structuredClone(oldComponent));
        unchangedComponents.add(oldComponent);
        continue;
      }
      const retainedItemKeys = (oldComponent?.item_keys ?? []).filter(itemKey => nextReference.destinations.some(destination =>
        destination.item_key === itemKey && routeUsesTarget(destination, id)) || untouchedComponentOwner(itemKey, id));
      if (newComponent && oldComponent && nextReference.destinations.some(destination =>
        !selectedRoutes.has(routeKey(destination.item_key, destination.target_field))
        && (routeUsesTarget(destination, id) || untouchedComponentOwner(destination.item_key, id)))
        && oldComponent.decision !== newComponent.decision) {
        failFullRecord("unselected_component_conflict", `${base}/bindings`, "本次组件处置会改变未点名接收者的判断；请保留该判断或完整编辑。", { span_id: id, retained_item_keys: retainedItemKeys, old_decision: oldComponent.decision, new_decision: newComponent.decision }, "preserved decisions for untouched receivers");
      }
      components.push({ component_span_ids: [id], decision: newComponent?.decision ?? oldComponent!.decision,
        item_keys: unique([...retainedItemKeys, ...(newComponent?.item_keys ?? [])]), reason: newComponent?.reason ?? oldComponent!.reason });
    }
    nextReference.component_dispositions = components;
    nextReference.anchor_span_ids = unique([...(previous?.anchor_span_ids ?? []), ...anchors]);
    nextReference.action = selection.action;
    nextReference.reason = selection.reason;
    nextReference.import_scope = { mode: previous?.import_scope.mode ?? "field_specific",
      allowed_fields: unique([...(previous?.import_scope.allowed_fields ?? []), ...selection.bindings.map(binding => binding.target_field)]), reason: selection.reason };
    const originCandidates = plan.items.flatMap(item => FIELDS.flatMap(field =>
      anchorSpans.length === anchors.length && anchorSpans.every(anchor => sourceSpanCoveredBy(anchor,
        item.fields[field].span_ids.flatMap(id => spans.get(id) ?? [])))
        ? [{ item_key: item.key, target_field: field }] : []));
    const compatibleCandidates = occurrence.origin_fields.length === 1
      ? originCandidates.filter(candidate => occurrence.origin_fields.includes(candidate.target_field)) : originCandidates;
    const origin = selection.origin_binding ?? previous?.origin_binding
      ?? (compatibleCandidates.length === 1 ? compatibleCandidates[0] : undefined);
    if (!origin || !compatibleCandidates.some(candidate => candidate.item_key === origin.item_key && candidate.target_field === origin.target_field)) {
      fail("origin_binding_required", `${base}/origin_binding`, "未能唯一确定实际保留引用原话的本地字段；明确选择已有候选，或先通过 local_context_fields 选择真实语境。",
        { declared_origin_binding: origin ?? null, candidates: compatibleCandidates }, { explicit_origin_binding: true, literal_span_ids: anchors });
    } else nextReference.origin_binding = origin;
    if (previous) plan.references[plan.references.indexOf(previous)] = nextReference;
    else plan.references.push(nextReference);
    touchedReferenceKeys.add(nextReference.key);
  }
  if (result.issues.length) return { ...result, draft: {}, changed_paths: [], derived_relations: [] };
  const changedItems = plan.items.filter((item, index) => canonicalize(item) !== canonicalize(current.items[index]));
  const changedReferences = plan.references.filter((reference, index) => canonicalize(reference) !== canonicalize(current.references[index] ?? null));
  const touchedItems = plan.items.filter(item => touchedItemKeys.has(item.key));
  const touchedReferences = plan.references.filter(reference => touchedReferenceKeys.has(reference.key));
  if (touchedItems.length) result.draft.items = touchedItems as NonNullable<TargetSelectorDraft["items"]>;
  if (touchedReferences.length) result.draft.references = touchedReferences;
  result.changed_paths = [
    ...changedItems.flatMap(item => FIELDS.filter(field => canonicalize(item.fields[field]) !== canonicalize(current.items.find(entry => entry.key === item.key)!.fields[field]))
      .map(field => `/items/${plan.items.indexOf(item)}/fields/${field}`)),
    ...changedReferences.map(reference => `/references/${plan.references.indexOf(reference)}`),
  ];
  return result;
}
