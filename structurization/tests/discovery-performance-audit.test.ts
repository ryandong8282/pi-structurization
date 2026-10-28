import { describe, expect, test } from "vitest";
import { summarizeDiscoveryPerformance } from "../src/discovery-performance.js";

describe("read-only discovery audit", () => {
  test("counts SDK argument rejection once even when details are absent and excludes duplicate controller events", () => {
    const event = (event_type: string, payload: Record<string, unknown>, seconds: number) => ({ event_type, payload, timestamp: new Date(seconds * 1000).toISOString() });
    const result = { content: [{ text: JSON.stringify({ ok: false, stage: "sdk_argument_preparation", issues: [{ code: "tool_argument_array_length" }] }) }], details: {} };
    const report = summarizeDiscoveryPerformance([
      event("pi_system_prompt", { content: "independent reviewer" }, 0),
      event("pi_provider_request_observed", { actual_request_utf8_bytes: 4000, reasoning_effort: "high" }, 1),
      event("pi_sdk_event", { type: "message_start", message: { role: "assistant" } }, 2),
      event("pi_sdk_event", { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 60, cacheRead: 20, totalTokens: 180 } } }, 3),
      event("pi_sdk_event", { type: "tool_execution_end", toolName: "patch_document_selectors", isError: true, result }, 4),
      event("discovery_tool_result", { tool: "patch_document_selectors", result }, 4),
      event("pi_session_telemetry", { phase: "discovery_review", session_file: "review/session.jsonl" }, 5),
    ]);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({ phase: "discovery_review", provider_request_count: 1,
      tool_result_count: 1, tool_failure_count: 1, sdk_tool_attempt_count: 1, sdk_tool_failure_count: 1,
      observed_output_tokens_per_stream_second: 60, issue_counts: { tool_argument_array_length: 1 },
      tools: { patch_document_selectors: { calls: 1, failures: 1, argument_rejections: 1 } } });
  });
});
