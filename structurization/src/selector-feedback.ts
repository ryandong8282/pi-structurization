import { sha256Json } from "./canonical.js";

/** Group identical read routes only; evidence identity and access permissions stay intact. */
export function compactSourceReadRoutes<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compactSourceReadRoutes) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "source_access" || !Array.isArray(child)) { result[key] = compactSourceReadRoutes(child); continue; }
    const groups: any[] = [], indexes = new Map<string, number>();
    for (const route of child) {
      if (!route || typeof route !== "object" || typeof route.evidence_id !== "string") { groups.push(route); continue; }
      const { evidence_id, ...rest } = route;
      const identity = sha256Json(rest), index = indexes.get(identity);
      if (index === undefined) { indexes.set(identity, groups.length); groups.push({ ...rest, evidence_id }); }
      else {
        const group = groups[index];
        group.evidence_ids ??= [group.evidence_id]; delete group.evidence_id;
        if (!group.evidence_ids.includes(evidence_id)) group.evidence_ids.push(evidence_id);
      }
    }
    result[key] = groups;
  }
  return result as T;
}

/** The same primary action is delivered in startup handoffs and tool callbacks. */
export function selectorWorkAction(work: any) {
  if (!work?.model_step) return work?.advisory_only && work?.source_delivery?.current_execution_complete ? work.next_action : undefined;
  const replan = work.step_accounting?.current_missing_selection_is_outside_active_step === true;
  return { kind: replan ? "review_model_plan_against_current_todo" : "execute_model_authored_step", decision_owner: "model", step: work.model_step,
    ...(replan ? { step_accounting: work.step_accounting, plan_tool: "save_target_component_plan" } : {}),
    instruction: replan
      ? "当前诊断的缺口在已选步骤之外，核对step_accounting的来源身份与当前诊断。由模型更新计划、选择覆盖当前待办的步骤并保存真实决定；程序不自动标done、不选择新步骤，不把已声明当业务通过。已选步骤的其他业务工作保留，不以重做它来替代当前待办。"
      : "执行模型自己选中的步骤并保存已确认的真实作者决定；其他组件保持未决，不先重做整章判断。缺上下文才用record_read或来源路由补读，工具由模型选择。" };
}

/** Secondary comparison hints keep their data, but do not masquerade as the current next command. */
export function prioritizeWorkRoutes(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const work = value.current_work ?? value.selector_repair_work ?? value.selector_authoring_work;
  const result = { ...value };
  if (work?.model_step || (work?.advisory_only && work?.source_delivery?.current_execution_complete)) {
    result.next_action = selectorWorkAction(work);
    const read = work.record_read ?? work.diagnostic_read;
    if (value.ok === true && read?.tool === result.next_tool
      && sha256Json(read.arguments) === sha256Json(result.next_tool_arguments ?? {})) {
      delete result.next_tool; delete result.next_tool_arguments;
    }
  }
  if (work && !value.terminal && !result.next_tool) Object.assign(result, selectorWorkNextStep(work));
  if (!work || !value.model_review) return result;
  const rewrite = (text: unknown) => typeof text === "string"
    ? text.replace(/\bnext_tool_arguments\b/gu, "supporting_read.arguments").replace(/\bnext_tool\b/gu, "supporting_read.tool") : text;
  result.model_review = { ...value.model_review, priority: "secondary_candidates", blocking: false,
    instruction: "当前主待办见current_work/selector_repair_work；以下仅是可选比较线索。由模型判断是否与主线相关，选择使用时才按supporting_read读取；不作为并列下一步，不替模型判断适用性。",
    observations: (value.model_review.observations ?? []).map((observation: any) => {
      const { next_tool, next_tool_arguments, next_tools, ...rest } = observation;
      return { ...rest, priority: "secondary_candidates",
        ...(next_tool ? { supporting_read: { tool: next_tool, arguments: next_tool_arguments ?? {} } } : {}),
        ...(next_tools ? { candidate_tools: next_tools } : {}),
        ...(rest.how_to_pass ? { how_to_pass: rewrite(rest.how_to_pass) } : {}),
        ...(rest.instruction ? { instruction: rewrite(rest.instruction) } : {}),
      };
    }),
  };
  return result;
}

/** One current author-work route; diagnostic/source subroutes are supporting reads. */
export function selectorWorkNextStep(work: {
  record_read?: { tool: string; arguments: Record<string, unknown> } | undefined;
  diagnostic_read?: { tool: string; arguments: Record<string, unknown> };
  model_step?: unknown;
  advisory_only?: boolean;
  source_delivery?: { current_execution_complete?: boolean };
} | undefined) {
  if (work?.model_step || (work?.advisory_only && work?.source_delivery?.current_execution_complete)) return {};
  const read = work?.record_read ?? work?.diagnostic_read;
  return read ? { next_tool: read.tool, next_tool_arguments: read.arguments } : {};
}

/** Submission bookkeeping only: no business inference and no draft mutation. */
export function selectorPatchReceipt(args: unknown, status: "not_applied" | "saved") {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const draft = input.draft && typeof input.draft === "object" ? input.draft as Record<string, unknown> : {};
  const collections = ["lots", "items", "sampling_rules", "references", "source_dispositions", "residual_source_dispositions"]
    .filter(collection => Array.isArray(draft[collection]))
    .map(collection => {
      const submitted_keys: string[] = [], unkeyed_record_paths: string[] = [];
      (draft[collection] as unknown[]).forEach((row, index) => {
        const key = row && typeof row === "object" ? (row as { key?: unknown }).key : undefined;
        if (typeof key === "string") submitted_keys.push(key);
        else unkeyed_record_paths.push(`/draft/${collection}/${index}`);
      });
      return { collection, submitted_keys, unkeyed_record_paths };
    });
  return {
    status,
    operation: input.operation ?? "upsert",
    collections,
    ...(Array.isArray(input.remove_keys) ? { remove_keys: input.remove_keys, remove_collection: input.collection } : {}),
  };
}
