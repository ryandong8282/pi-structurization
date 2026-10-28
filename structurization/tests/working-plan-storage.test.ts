import { expect, test } from "vitest";
import { prettyJson, sha256Json } from "../src/canonical.js";
import { terminalToolFailure } from "../src/pi-runtime.js";
import { compiledWorkingPlanCapacityFailure, serializeCompiledWorkingPlan, WORKING_PLAN_MAX_BYTES } from "../src/working-plan-storage.js";

test("generated plan keeps small formatting and falls back losslessly when indentation alone exceeds capacity", () => {
  const small = { facts: [{ requirement: "中性原文", sources: ["source:a"] }] };
  expect(serializeCompiledWorkingPlan(small)).toBe(prettyJson(small));
  const large = { facts: Array.from({ length: 24_000 }, () => small.facts[0]) };
  expect(Buffer.byteLength(prettyJson(large))).toBeGreaterThan(WORKING_PLAN_MAX_BYTES);
  const content = serializeCompiledWorkingPlan(large);
  expect(Buffer.byteLength(content)).toBeLessThan(WORKING_PLAN_MAX_BYTES);
  expect(JSON.parse(content)).toEqual(large);
  expect(sha256Json(JSON.parse(content))).toBe(sha256Json(large));
  expect(compiledWorkingPlanCapacityFailure(content)).toBeUndefined();
});

test("actual compact capacity failure belongs to the harness and terminates without a model repair path", () => {
  const content = serializeCompiledWorkingPlan({ requirement: "中".repeat(WORKING_PLAN_MAX_BYTES / 2) });
  const failure = compiledWorkingPlanCapacityFailure(content);
  expect(failure).toMatchObject({ ok: false, terminal: true, budget_consumed: false,
    error: "compiled_working_plan_capacity_exceeded", issue_owner: "compiler_invariant_violation",
    actual_bytes: Buffer.byteLength(content), maximum_bytes: WORKING_PLAN_MAX_BYTES,
    writable_paths: [], next_tool: null });
  expect(terminalToolFailure(failure)?.error).toBe("compiled_working_plan_capacity_exceeded");
  expect(compiledWorkingPlanCapacityFailure(" ".repeat(WORKING_PLAN_MAX_BYTES))).toBeUndefined();
});
