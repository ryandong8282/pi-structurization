import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runBoundedFailFast } from "../src/fail-fast-pool.js";
import { computeImplementationFingerprints } from "../src/implementation-fingerprint.js";
import { isProcessAlive, terminateProcessTree } from "../src/process-tree.js";
import { transcriptMetrics } from "../src/run-metrics.js";
import { constrainSelectorProviderPayload } from "../src/pi-runtime.js";

describe("selector regression runtime closure", () => {
  it("uses auto while exposing only the current selector stage tools", () => {
    const payload = {
      model: "deepseek-v4-flash",
      tool_choice: "required",
      tools: ["get_target_context", "commit_target_selector_draft", "open_evidence"].map((name) => ({ type: "function", function: { name } })),
    };
    const constrained = constrainSelectorProviderPayload(payload, {
      stage: "primary",
      allowed_tools: ["get_target_context", "open_evidence"],
    });
    expect(constrained.tool_choice).toBe("auto");
    expect((constrained.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual([
      "get_target_context", "open_evidence",
    ]);
  });

  it("uses auto for Responses tools and removes stale choices when no tool is allowed", () => {
    const payload = {
      model: "gpt-6-luna",
      tool_choice: { type: "function", name: "seal_validated_plan" },
      tools: ["get_target_context", "seal_validated_plan"].map(name => ({ type: "function", name })),
    };
    const constrained = constrainSelectorProviderPayload(payload, {
      stage: "primary", allowed_tools: ["get_target_context"],
    });
    expect(constrained).toEqual({ ...payload, tool_choice: "auto", tools: [payload.tools[0]] });
    const noTools = constrainSelectorProviderPayload(payload, { stage: "primary", allowed_tools: [] });
    expect(noTools.tools).toEqual([]);
    expect(noTools).not.toHaveProperty("tool_choice");
    expect(payload.tool_choice).toEqual({ type: "function", name: "seal_validated_plan" });
  });

  it("computes stable source/build fingerprints", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(await computeImplementationFingerprints(packageRoot))
      .toEqual(await computeImplementationFingerprints(packageRoot));
  });

  it("aborts unstarted and in-flight concurrent work after the first hard failure", async () => {
    const started: number[] = [];
    const results = await runBoundedFailFast({
      inputs: [0, 1, 2, 3, 4, 5],
      concurrency: 3,
      worker: async (value, signal) => {
        started.push(value);
        if (value === 1) return { value, failed: true };
        await new Promise<void>((resolveWait, reject) => {
          const timer = setTimeout(resolveWait, 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        return { value, failed: false };
      },
      isHardFailure: (value) => value.failed,
    });
    expect(results[1]!.status).toBe("failed");
    expect(started.length).toBeLessThanOrEqual(3);
    expect(results.slice(3).every((result) => result.status === "cancelled")).toBe(true);
  });

  it("continues bounded exploration after independent hard failures", async () => {
    const started: number[] = [];
    const results = await runBoundedFailFast({
      inputs: [0, 1, 2, 3],
      concurrency: 4,
      failFast: false,
      worker: async (value) => {
        started.push(value);
        if (value === 1) return { value, failed: true };
        if (value === 2) throw new Error("independent failure");
        return { value, failed: false };
      },
      isHardFailure: (value) => value.failed,
    });
    expect(started.sort()).toEqual([0, 1, 2, 3]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "failed", "failed", "fulfilled"]);
  });

  it("records tool, turn, token, and event timing metrics", () => {
    const events = [
      { timestamp: "2026-08-10T00:00:00Z", event_type: "pi_model_request_contract", payload: { thinking_effort: "high", max_tokens: 32768, max_tokens_field: "max_tokens", context_window: 1000000 } },
      { timestamp: "2026-08-10T00:00:00Z", event_type: "pi_provider_request_observed", payload: { max_tokens: 32768, max_completion_tokens: 0, thinking_type: "enabled", reasoning_effort: "high", has_tool_choice: false, assistant_tool_call_messages: 2, assistant_tool_call_reasoning_replay_count: 2, assistant_tool_call_non_null_content_count: 2 } },
      { timestamp: "2026-08-10T00:00:00.750Z", event_type: "tool_execution_start", payload: { tool_name: "get_target_context" } },
      { timestamp: "2026-08-10T00:00:01Z", event_type: "pi_sdk_event", payload: { type: "message_start", message: { role: "assistant" } } },
      { timestamp: "2026-08-10T00:00:02Z", event_type: "pi_sdk_event", payload: { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "inspect evidence" }, { type: "toolCall" }], usage: { input: 12, output: 3, cacheRead: 20, cacheWrite: 2, reasoning: 2, totalTokens: 37 } } } },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(transcriptMetrics(events)).toMatchObject({
      tool_call_count: 1,
      tool_calls_by_name: { get_target_context: 1 },
      llm_turn_count: 1,
      input_tokens: 12,
      output_tokens: 3,
      cache_read_tokens: 20,
      cache_write_tokens: 2,
      reasoning_tokens: 2,
      max_context_tokens: 32,
      thinking_turn_count: 1,
      thinking_char_count: 16,
      length_stop_count: 0,
      thinking_effort: "high",
      provider_max_tokens: 32768,
      provider_max_tokens_field: "max_tokens",
      model_context_window: 1000000,
      first_assistant_latency_ms: 1000,
      first_tool_call_latency_ms: 750,
      provider_request_count: 1,
      assistant_tool_call_messages: 2,
      assistant_tool_call_reasoning_replay_count: 2,
      assistant_tool_call_non_null_content_count: 2,
      provider_tool_choice_request_count: 0,
      first_event_at: "2026-08-10T00:00:00Z",
      last_event_at: "2026-08-10T00:00:02Z",
    });
  });

  it.skipIf(process.platform !== "win32")("stops a real node to tsx runner process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "selector-process-tree-"));
    const pidFile = join(root, "runner.pid");
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "process-tree");
    const parent = spawn(process.execPath, [
      join(fixtureRoot, "process-tree-parent.cjs"),
      resolve("node_modules", "tsx", "dist", "cli.mjs"),
      join(fixtureRoot, "process-tree-runner.ts"),
      pidFile,
    ], { stdio: "ignore", windowsHide: true });
    try {
      const deadline = Date.now() + 5_000;
      let runnerPid = 0;
      while (!runnerPid && Date.now() < deadline) {
        runnerPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (!runnerPid) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(runnerPid).toBeGreaterThan(0);
      expect(isProcessAlive(parent.pid!)).toBe(true);
      expect(isProcessAlive(runnerPid)).toBe(true);
      await terminateProcessTree(parent.pid!);
      expect(isProcessAlive(parent.pid!)).toBe(false);
      expect(isProcessAlive(runnerPid)).toBe(false);
    } finally {
      if (parent.pid && isProcessAlive(parent.pid)) await terminateProcessTree(parent.pid).catch(() => undefined);
      await writeFile(join(root, "finished"), "true", "utf8").catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});
