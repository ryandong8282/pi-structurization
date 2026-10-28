import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { atomicWriteJson, readJson } from "./atomic.js";

export const COMPONENT_PLAN_INPUT = Type.Object({
  occurrence_id: Type.String({ minLength: 1 }),
  active_step_key: Type.String(),
  steps: Type.Array(Type.Object({
    key: Type.String({ minLength: 1 }),
    span_ids: Type.Array(Type.String(), { maxItems: 48 }),
    question: Type.String({ minLength: 1, maxLength: 800 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked")]),
    next_step: Type.String({ maxLength: 1500 }),
    outcome: Type.String({ maxLength: 1500 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 24 }),
}, { additionalProperties: false });
export type ComponentPlanInput = Static<typeof COMPONENT_PLAN_INPUT>;
export interface ComponentWorkPlan {
  occurrence_id: string;
  active_step_key: string;
  revision: number;
  steps: ComponentPlanInput["steps"];
}

/** Exact author declarations, not applicability approval or proof that a field is valid. */
export function componentStepAccounting(step: ComponentWorkPlan["steps"][number], reference: {
  target_span_ids: string[]; component_dispositions?: Array<{ component_span_ids: string[] }>;
} | undefined) {
  const counts = new Map<string, number>();
  for (const row of reference?.component_dispositions ?? []) for (const id of row.component_span_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const selected = new Set(reference?.target_span_ids ?? []);
  const declared = step.span_ids.filter(id => selected.has(id) && counts.get(id) === 1);
  return { business_completion_proven: false, model_plan_status_unchanged: true,
    active_step_span_count: step.span_ids.length, declared_exact_span_ids: declared,
    undeclared_active_step_span_ids: step.span_ids.filter(id => !declared.includes(id)),
    missing_or_duplicate_selected_span_ids: (reference?.target_span_ids ?? []).filter(id => counts.get(id) !== 1),
    instruction: "这里只核对已存作者声明与精确span身份，不批准适用性或字段有效性。模型计划中的outcome是历史陈述；实际作者记录优先。",
  };
}
/** Compare registered source identities, without choosing applicability or
 * declaring a model step complete. Missing identities cannot imply mismatch. */
export function componentStepDiagnosticScope(step: ComponentWorkPlan['steps'][number], evidenceIds: readonly string[],
  spans: readonly { span_id: string; evidence_id: string }[]) {
  const byId = new Map(spans.map(span => [span.span_id, span.evidence_id]));
  const known = step.span_ids.length > 0 && step.span_ids.every(id => byId.has(id));
  const active = [...new Set(step.span_ids.flatMap(id => byId.get(id) ?? []))];
  const pending = [...new Set(evidenceIds)];
  return { active_step_evidence_ids: active, current_diagnostic_evidence_ids: pending,
    current_diagnostic_outside_active_step: known && pending.length > 0 && pending.every(id => !active.includes(id)) };
}

interface PlanStore {
  schema_version: "model-component-plans/v1";
  source_sha256: string;
  revision: number;
  plans: Record<string, ComponentWorkPlan>;
}

export async function readComponentPlans(root: string, sourceSha: string): Promise<PlanStore> {
  const stored = await readJson<PlanStore>(join(root, "component-work-plans.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return stored?.schema_version === "model-component-plans/v1" && stored.source_sha256 === sourceSha
    ? stored : { schema_version: "model-component-plans/v1", source_sha256: sourceSha, revision: stored?.revision ?? 0, plans: {} };
}

/** Store model-authored steps verbatim; no applicability or completion inference. */
export async function saveComponentPlan(root: string, sourceSha: string, input: ComponentPlanInput): Promise<
  { ok: true; plan: ComponentWorkPlan } |
  { ok: false; error: string; actual: unknown; expected: string; writable_paths: string[] }
> {
  const state = await readComponentPlans(root, sourceSha);
  const previous = state.plans[input.occurrence_id];
  const byKey = new Map((previous?.steps ?? []).map(step => [step.key, step]));
  for (const step of input.steps) byKey.set(step.key, step);
  const steps = [...byKey.values()];
  if (new Set(input.steps.map(step => step.key)).size !== input.steps.length) return {
    ok: false, error: "component_plan_duplicate_step_key", actual: input.steps.map(step => step.key),
    expected: "steps[].key 在本次更新中唯一", writable_paths: ["/steps"],
  };
  const active = steps.find(step => step.key === input.active_step_key);
  if (input.active_step_key && (!active || active.status === "done")) return {
    ok: false, error: "component_plan_active_step_invalid", actual: { active_step_key: input.active_step_key, status: active?.status ?? "missing" },
    expected: "active_step_key 指向本计划中尚未声明done的步骤，或显式为空", writable_paths: ["/active_step_key", "/steps"],
  };
  const revision = state.revision + 1;
  const plan: ComponentWorkPlan = { occurrence_id: input.occurrence_id, active_step_key: input.active_step_key, revision, steps };
  const next: PlanStore = { ...state, revision, plans: { ...state.plans, [input.occurrence_id]: plan } };
  await atomicWriteJson(join(root, "component-plan-history", `${String(revision).padStart(6, "0")}-${randomUUID()}.json`), next);
  await atomicWriteJson(join(root, "component-work-plans.json"), next);
  return { ok: true, plan };
}

/** Only the active step chosen by the model is resumed, never a program-selected business task. */
export function componentPlanView(plan: ComponentWorkPlan | undefined, occurrenceId: string, cursor = 0, limit = 12, fullSteps = false) {
  return {
    model_authored: true, applicability_decision_owner: "model", business_completion_proven: false,
    occurrence_id: occurrenceId, status: plan ? "saved" : "not_saved", save_tool: "save_target_component_plan",
    revision: plan?.revision ?? 0, active_step_key: plan?.active_step_key ?? "",
    active_step: plan?.steps.find(step => step.key === plan.active_step_key) ?? null,
    steps: (plan?.steps ?? []).slice(cursor, cursor + limit).map(step => fullSteps ? step : { key: step.key, status: step.status, question: step.question }),
    total_steps: plan?.steps.length ?? 0,
    read_full_plan: { tool: "get_target_context", arguments: { component_plan_occurrence_id: occurrenceId, component_plan_cursor: 0 } },
    next_page: plan && cursor + limit < plan.steps.length
      ? { tool: "get_target_context", arguments: { component_plan_occurrence_id: occurrenceId, component_plan_cursor: cursor + limit } } : null,
    instruction: "由模型选择组件分组、待判断问题、当前步骤和下一步；计划状态也是模型声明，不是程序批准。按active_step续接，执行必要工具并保存真实作者决定后自行更新步骤。计划保存或done均不关闭引用诊断、不计业务进展、不代替验收项目或封存；未确认适用性保持具体问题，不能只写整章待审。",
  };
}
