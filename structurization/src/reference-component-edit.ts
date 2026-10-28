import { Type, type Static } from "typebox";
import type { EvidenceManifest } from "./contracts.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";
import { ReferenceComponentDispositionSchema, type TargetSelectorPlan } from "./target-selector-compiler.js";

export const REFERENCE_COMPONENT_EDIT_INPUT = Type.Object({
  draft_fingerprint: Type.String({ minLength: 1 }),
  reference_key: Type.String({ minLength: 1, description: "read_target_selectors返回的当前引用记录key；不猜occurrence或数组下标。" }),
  component_dispositions: Type.Array(ReferenceComponentDispositionSchema, { minItems: 1, maxItems: 48,
    description: "只提交模型本次确认的组件决定。按精确component_span_ids替换相同组件，未点名组件、接收关系和其他字段由程序保留；不替模型新增接收项目或决定适用性。" }),
}, { additionalProperties: false });

export type ReferenceComponentEditInput = Static<typeof REFERENCE_COMPONENT_EDIT_INPUT>;

/** Merge only explicit model decisions; never infer a receiver or applicability. */
export function editReferenceComponents(current: TargetSelectorPlan, manifest: EvidenceManifest,
  registry: SourceSpanRegistry, input: ReferenceComponentEditInput) {
  const fail = (error: string, actual: unknown, expected: unknown, writablePaths: string[]) => ({
    ok: false as const, error, actual, expected, writable_paths: writablePaths,
    durable_mutation: false, budget_consumed: false,
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: input.reference_key },
    instruction: "本次未保存。按actual/expected核对当前引用、登记来源和真实项目；只修点名参数后重试stage_reference_component_decisions。修改整体action、import_scope、接收关系或项目字段仍使用原完整记录/字段选择接口，不删除其他正确内容。",
  });
  const matches = current.references.filter(row => row.key === input.reference_key);
  if (matches.length !== 1) return fail("reference_component_record_unknown", { reference_key: input.reference_key, matches: matches.length },
    "当前references中唯一已有记录", ["/reference_key"]);
  const reference = matches[0]!;
  const occurrence = manifest.reference_occurrences.find(row => row.occurrence_id === reference.occurrence_id);
  if (!occurrence || occurrence.status !== "resolved") return fail("reference_component_occurrence_unresolved",
    { reference_key: reference.key, occurrence_id: reference.occurrence_id, status: occurrence?.status },
    "引用记录须点名已登记并解析的occurrence；本工具不创建或更正引用身份", ["/reference_key"]);
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const items = new Set(current.items.map(item => item.key));
  const touched = new Set<string>();
  for (const [index, component] of input.component_dispositions.entries()) {
    const path = `/component_dispositions/${index}`;
    for (const id of component.component_span_ids) {
      const span = spans.get(id);
      if (!span || !occurrence.target_evidence_ids.includes(span.evidence_id)) return fail("reference_component_source_invalid",
        { span_id: id, evidence_id: span?.evidence_id }, { registered_span: true, target_evidence_ids: occurrence.target_evidence_ids }, [`${path}/component_span_ids`]);
      if (touched.has(id)) return fail("reference_component_duplicate", { span_id: id }, "同次调用每个精确span只声明一次", [`${path}/component_span_ids`]);
      touched.add(id);
    }
    const unknown = component.item_keys.filter(key => !items.has(key));
    if (unknown.length || (component.decision === "not_applicable" ? component.item_keys.length !== 0 : component.item_keys.length === 0)) {
      return fail("reference_component_receivers_invalid", { decision: component.decision, item_keys: component.item_keys, unknown_item_keys: unknown },
        "not_applicable的item_keys=[]；其他决定点名至少一个已有真实项目；不自动创建接收关系", [`${path}/decision`, `${path}/item_keys`]);
    }
  }
  const next = structuredClone(reference);
  next.component_dispositions = [
    ...(next.component_dispositions ?? []).flatMap(component => {
      const remaining = component.component_span_ids.filter(id => !touched.has(id));
      return remaining.length ? [{ ...component, component_span_ids: remaining }] : [];
    }),
    ...structuredClone(input.component_dispositions),
  ];
  next.target_span_ids = [...new Set([...next.target_span_ids, ...touched])];
  return { ok: true as const, reference: next, touched_span_ids: [...touched] };
}
