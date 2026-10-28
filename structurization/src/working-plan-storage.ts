import { prettyJson } from "./canonical.js";

export const WORKING_PLAN_MAX_BYTES = 2_000_000;

// Compiler output is trusted structured data. Formatting alone must not make
// an otherwise storable plan fail; authored raw text keeps its separate guard.
export function serializeCompiledWorkingPlan(plan: unknown): string {
  const pretty = prettyJson(plan);
  return Buffer.byteLength(pretty, "utf8") <= WORKING_PLAN_MAX_BYTES
    ? pretty
    : `${JSON.stringify(plan)}\n`;
}

export function compiledWorkingPlanCapacityFailure(content: string) {
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (actualBytes <= WORKING_PLAN_MAX_BYTES) return undefined;
  return {
    ok: false as const,
    terminal: true,
    error: "compiled_working_plan_capacity_exceeded",
    issue_owner: "compiler_invariant_violation" as const,
    budget_consumed: false,
    actual_bytes: actualBytes,
    maximum_bytes: WORKING_PLAN_MAX_BYTES,
    writable_paths: [],
    next_tool: null,
    required_action: "maintainer_repair_compiled_plan_storage_capacity",
    instruction: "编译生成的计划已使用紧凑 JSON，仍超过程序存储容量。保留 selector 检查点并停止当前目标，由维护者修复容量问题后恢复；模型没有可修复该容量的业务字段，不应删除、缩写或重新分配真实事实来降低字节数。",
    do_not_edit: "已保存的业务 selector、不可变原文和编译产物",
  };
}
