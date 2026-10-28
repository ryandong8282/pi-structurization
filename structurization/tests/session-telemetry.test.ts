import { describe, expect, test } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  PiSessionTelemetry,
  modelVisibleToolResultBytes,
  withPiSessionTelemetry,
} from "../src/session-telemetry.js";

describe("Pi session telemetry", () => {
  test("reads actual Pi SDK usage names, stream duration and failed transactions", () => {
    const telemetry = new PiSessionTelemetry("pdf_layout", "system");
    telemetry.observeSdkEvent({ type: "message_start", message: { role: "assistant" } }, 100);
    telemetry.observeSdkEvent({ type: "message_end", message: { role: "assistant", usage: { input: 200, output: 60, cacheRead: 800, cacheWrite: 40, totalTokens: 1100 } } }, 1100);
    telemetry.recordToolResult("edit_document_selectors", { content: [{ type: "text", text: "rejected" }], details: { ok: false, saved: false } });
    telemetry.observeSdkEvent({ type: "tool_execution_end", isError: true, result: { details: {} } });
    telemetry.observeSdkEvent({ type: "tool_execution_end", isError: false, result: { details: { ok: false } } });
    expect(telemetry.snapshot()).toMatchObject({ phase: "pdf_layout", observed_input_peak_tokens: 200,
      observed_input_total_tokens: 200, observed_output_total_tokens: 60, observed_cache_read_total_tokens: 800,
      observed_cache_write_total_tokens: 40, observed_context_cumulative_tokens: 1100, assistant_stream_total_ms: 1000,
      tool_failure_count: 1, sdk_tool_attempt_count: 2, sdk_tool_failure_count: 2,
      tool_response_by_name: { edit_document_selectors: { failed_count: 1 } } });
  });
  test("captures prompt, provider request, SDK usage, and model-visible tool-result bytes", async () => {
    const telemetry = new PiSessionTelemetry("coverage_review", "system 中文");
    telemetry.recordPrompt("review target 7.2");
    telemetry.observeProviderRequest(
      { messages: [{ role: "user", content: "x" }] },
      {
        actual_request_utf8_bytes: 12_345,
        canonical_equivalent_request_utf8_bytes: 13_000,
        source_handle_saved_request_bytes: 655,
      },
    );
    telemetry.observeProviderRequest(
      { messages: [{ role: "user", content: "xx" }] },
      {
        actual_request_utf8_bytes: 18_765,
        canonical_equivalent_request_utf8_bytes: 20_000,
        source_handle_saved_request_bytes: 1_235,
      },
    );
    telemetry.observeSdkEvent({
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          inputTokens: 4_200,
          outputTokens: 300,
          cacheReadTokens: 1_500,
          cacheWriteTokens: 200,
          totalTokens: 4_500,
        },
      },
    });

    const tool = {
      name: "read_candidate_leaf_details",
      execute: async () => ({
        content: [{ type: "text", text: "真实工具结果" }],
        details: { internal: "not sent to model" },
      }),
    } as unknown as ToolDefinition;
    const [wrapped] = withPiSessionTelemetry([tool], telemetry);
    const result = await wrapped!.execute("call-1", {}, undefined as never, undefined as never);
    expect(modelVisibleToolResultBytes(result)).toBe(Buffer.byteLength("真实工具结果", "utf8"));

    expect(telemetry.snapshot()).toMatchObject({
      schema_version: "pi-session-telemetry/v1",
      phase: "coverage_review",
      user_prompt_count: 1,
      provider_request_count: 2,
      provider_request_peak_utf8_bytes: 18_765,
      provider_request_last_utf8_bytes: 18_765,
      provider_request_cumulative_utf8_bytes: 31_110,
      canonical_request_peak_utf8_bytes: 20_000,
      source_handle_saved_request_bytes: 1_890,
      assistant_message_end_count: 1,
      observed_context_peak_tokens: 4_500,
      observed_input_peak_tokens: 4_200,
      observed_output_total_tokens: 300,
      observed_cache_read_total_tokens: 1_500,
      observed_cache_write_total_tokens: 200,
      token_observation_available: true,
      tool_result_count: 1,
      tool_response_by_name: {
        read_candidate_leaf_details: {
          count: 1,
          bytes: Buffer.byteLength("真实工具结果", "utf8"),
          peak_bytes: Buffer.byteLength("真实工具结果", "utf8"),
        },
      },
    });
  });

  test("keeps byte telemetry useful when provider token usage is unavailable", () => {
    const telemetry = new PiSessionTelemetry("coverage_review", "system");
    telemetry.recordPrompt("prompt");
    telemetry.observeProviderRequest({ messages: [] });
    const snapshot = telemetry.snapshot();
    expect(snapshot.provider_request_peak_utf8_bytes).toBeGreaterThan(0);
    expect(snapshot.observed_context_peak_tokens).toBe(0);
    expect(snapshot.token_observation_available).toBe(false);
  });
});
