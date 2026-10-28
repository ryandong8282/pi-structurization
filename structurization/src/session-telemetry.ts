import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value ?? null),
    "utf8",
  );
}

/** Bytes that the model actually sees from a Pi tool result. */
export function modelVisibleToolResultBytes(value: unknown): number {
  const record = object(value);
  const content = record?.content;
  if (!Array.isArray(content)) return utf8Bytes(value);
  return content.reduce((total, block) => {
    const row = object(block);
    return total + (typeof row?.text === "string" ? Buffer.byteLength(row.text, "utf8") : 0);
  }, 0);
}

export interface PiSessionTelemetrySnapshot {
  schema_version: "pi-session-telemetry/v1";
  phase: string;
  system_prompt_utf8_bytes: number;
  user_prompt_count: number;
  user_prompt_utf8_bytes: number;
  max_user_prompt_utf8_bytes: number;
  provider_request_count: number;
  provider_request_peak_utf8_bytes: number;
  provider_request_last_utf8_bytes: number;
  provider_request_cumulative_utf8_bytes: number;
  canonical_request_peak_utf8_bytes: number;
  source_handle_saved_request_bytes: number;
  assistant_message_end_count: number;
  observed_context_peak_tokens: number;
  observed_input_peak_tokens: number;
  observed_output_total_tokens: number;
  observed_cache_read_total_tokens: number;
  observed_cache_write_total_tokens: number;
  token_observation_available: boolean;
  tool_result_count: number;
  tool_failure_count: number;
  sdk_tool_attempt_count: number;
  sdk_tool_failure_count: number;
  assistant_stream_total_ms: number;
  observed_context_cumulative_tokens: number;
  observed_input_total_tokens: number;
  tool_response_peak_utf8_bytes: number;
  tool_response_cumulative_utf8_bytes: number;
  tool_response_by_name: Record<string, {
    count: number;
    bytes: number;
    peak_bytes: number;
    failed_count: number;
  }>;
}

export class PiSessionTelemetry {
  private userPromptCount = 0;
  private userPromptBytes = 0;
  private maxUserPromptBytes = 0;
  private providerRequestCount = 0;
  private providerRequestPeakBytes = 0;
  private providerRequestLastBytes = 0;
  private providerRequestCumulativeBytes = 0;
  private canonicalRequestPeakBytes = 0;
  private sourceHandleSavedRequestBytes = 0;
  private assistantMessageEndCount = 0;
  private observedContextPeakTokens = 0;
  private observedInputPeakTokens = 0;
  private observedOutputTotalTokens = 0;
  private observedCacheReadTotalTokens = 0;
  private observedCacheWriteTotalTokens = 0;
  private toolResultCount = 0;
  private toolFailureCount = 0;
  private sdkToolAttemptCount = 0;
  private sdkToolFailureCount = 0;
  private assistantStreamStart: number | undefined;
  private assistantStreamTotalMs = 0;
  private observedContextCumulativeTokens = 0;
  private observedInputTotalTokens = 0;
  private toolResponsePeakBytes = 0;
  private toolResponseCumulativeBytes = 0;
  private readonly toolResponseByName = new Map<string, { count: number; bytes: number; peak_bytes: number; failed_count: number }>();

  constructor(
    public readonly phase: string,
    public readonly systemPrompt: string,
  ) {}

  recordPrompt(prompt: string): void {
    const bytes = Buffer.byteLength(prompt, "utf8");
    this.userPromptCount += 1;
    this.userPromptBytes += bytes;
    this.maxUserPromptBytes = Math.max(this.maxUserPromptBytes, bytes);
  }

  observeProviderRequest(
    payload: unknown,
    measured: Record<string, unknown> = {},
  ): void {
    const actual = numberValue(measured.actual_request_utf8_bytes) || utf8Bytes(payload);
    const canonical = numberValue(measured.canonical_equivalent_request_utf8_bytes);
    const saved = numberValue(measured.source_handle_saved_request_bytes);
    this.providerRequestCount += 1;
    this.providerRequestLastBytes = actual;
    this.providerRequestPeakBytes = Math.max(this.providerRequestPeakBytes, actual);
    this.providerRequestCumulativeBytes += actual;
    this.canonicalRequestPeakBytes = Math.max(this.canonicalRequestPeakBytes, canonical);
    this.sourceHandleSavedRequestBytes += saved;
  }

  observeSdkEvent(value: unknown, now = Date.now()): void {
    const event = object(value);
    if (event?.type === "tool_execution_end") {
      this.sdkToolAttemptCount += 1;
      if (event.isError === true || object(object(event.result)?.details)?.ok === false) this.sdkToolFailureCount += 1;
    }
    if (event?.type === "message_start" && object(event.message)?.role === "assistant") this.assistantStreamStart = now;
    if (event?.type !== "message_end") return;
    const message = object(event.message);
    if (message?.role !== "assistant") return;
    if (this.assistantStreamStart !== undefined) this.assistantStreamTotalMs += Math.max(0, now - this.assistantStreamStart);
    this.assistantStreamStart = undefined;
    this.assistantMessageEndCount += 1;
    const usage = object(message.usage);
    if (!usage) return;
    const total = numberValue(usage.totalTokens ?? usage.total_tokens);
    // Pi SDK uses input/output/cacheRead/cacheWrite, without a Tokens suffix.
    const input = numberValue(
      usage.inputTokens
      ?? usage.input_tokens
      ?? usage.promptTokens
      ?? usage.prompt_tokens
      ?? usage.input,
    );
    const output = numberValue(
      usage.outputTokens
      ?? usage.output_tokens
      ?? usage.completionTokens
      ?? usage.completion_tokens
      ?? usage.output,
    );
    const cacheRead = numberValue(
      usage.cacheReadTokens
      ?? usage.cache_read_tokens
      ?? usage.cachedTokens
      ?? usage.cached_tokens
      ?? usage.cacheRead,
    );
    const cacheWrite = numberValue(
      usage.cacheWriteTokens
      ?? usage.cache_write_tokens
      ?? usage.cacheWrite,
    );
    this.observedContextPeakTokens = Math.max(this.observedContextPeakTokens, total);
    this.observedInputPeakTokens = Math.max(this.observedInputPeakTokens, input);
    this.observedInputTotalTokens += input;
    this.observedContextCumulativeTokens += total;
    this.observedOutputTotalTokens += output;
    this.observedCacheReadTotalTokens += cacheRead;
    this.observedCacheWriteTotalTokens += cacheWrite;
  }

  recordToolResult(toolName: string, value: unknown): void {
    const bytes = modelVisibleToolResultBytes(value);
    const record = object(value);
    const result = object(record?.details) ?? record;
    const failed = record?.isError === true || result?.ok === false;
    if (failed) this.toolFailureCount += 1;
    this.toolResultCount += 1;
    this.toolResponseCumulativeBytes += bytes;
    this.toolResponsePeakBytes = Math.max(this.toolResponsePeakBytes, bytes);
    const previous = this.toolResponseByName.get(toolName) ?? {
      count: 0,
      bytes: 0,
      peak_bytes: 0,
      failed_count: 0,
    };
    previous.count += 1;
    if (failed) previous.failed_count += 1;
    previous.bytes += bytes;
    previous.peak_bytes = Math.max(previous.peak_bytes, bytes);
    this.toolResponseByName.set(toolName, previous);
  }

  snapshot(): PiSessionTelemetrySnapshot {
    return {
      schema_version: "pi-session-telemetry/v1",
      phase: this.phase,
      system_prompt_utf8_bytes: Buffer.byteLength(this.systemPrompt, "utf8"),
      user_prompt_count: this.userPromptCount,
      user_prompt_utf8_bytes: this.userPromptBytes,
      max_user_prompt_utf8_bytes: this.maxUserPromptBytes,
      provider_request_count: this.providerRequestCount,
      provider_request_peak_utf8_bytes: this.providerRequestPeakBytes,
      provider_request_last_utf8_bytes: this.providerRequestLastBytes,
      provider_request_cumulative_utf8_bytes: this.providerRequestCumulativeBytes,
      canonical_request_peak_utf8_bytes: this.canonicalRequestPeakBytes,
      source_handle_saved_request_bytes: this.sourceHandleSavedRequestBytes,
      assistant_message_end_count: this.assistantMessageEndCount,
      observed_context_peak_tokens: this.observedContextPeakTokens,
      observed_input_peak_tokens: this.observedInputPeakTokens,
      observed_output_total_tokens: this.observedOutputTotalTokens,
      observed_cache_read_total_tokens: this.observedCacheReadTotalTokens,
      observed_cache_write_total_tokens: this.observedCacheWriteTotalTokens,
      token_observation_available: this.observedContextPeakTokens > 0 || this.observedInputPeakTokens > 0,
      tool_result_count: this.toolResultCount,
      tool_failure_count: this.toolFailureCount,
      sdk_tool_attempt_count: this.sdkToolAttemptCount,
      sdk_tool_failure_count: this.sdkToolFailureCount,
      assistant_stream_total_ms: this.assistantStreamTotalMs,
      observed_context_cumulative_tokens: this.observedContextCumulativeTokens,
      observed_input_total_tokens: this.observedInputTotalTokens,
      tool_response_peak_utf8_bytes: this.toolResponsePeakBytes,
      tool_response_cumulative_utf8_bytes: this.toolResponseCumulativeBytes,
      tool_response_by_name: Object.fromEntries(
        [...this.toolResponseByName.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }
}

export function withPiSessionTelemetry(
  tools: ToolDefinition[],
  telemetry: PiSessionTelemetry,
): ToolDefinition[] {
  return tools.map((tool) => {
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => {
        const result = await execute(...args);
        telemetry.recordToolResult(tool.name, result);
        return result;
      },
    } as ToolDefinition;
  });
}
