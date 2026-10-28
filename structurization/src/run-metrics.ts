export interface TranscriptMetrics {
  tool_call_count: number;
  tool_calls_by_name: Record<string, number>;
  llm_turn_count: number;
  first_event_at: string;
  last_event_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  max_context_tokens: number;
  max_turn_output_tokens: number;
  thinking_turn_count: number;
  thinking_char_count: number;
  length_stop_count: number;
  thinking_effort: string;
  provider_max_tokens: number;
  provider_max_tokens_field: string;
  model_context_window: number;
  first_assistant_latency_ms: number;
  first_tool_call_latency_ms: number;
  provider_request_count: number;
  assistant_tool_call_messages: number;
  assistant_tool_call_reasoning_replay_count: number;
  assistant_tool_call_non_null_content_count: number;
  provider_tool_choice_request_count: number;
}

export function transcriptMetrics(jsonl: string): TranscriptMetrics {
  const metrics: TranscriptMetrics = {
    tool_call_count: 0,
    tool_calls_by_name: {},
    llm_turn_count: 0,
    first_event_at: "",
    last_event_at: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    max_context_tokens: 0,
    max_turn_output_tokens: 0,
    thinking_turn_count: 0,
    thinking_char_count: 0,
    length_stop_count: 0,
    thinking_effort: "",
    provider_max_tokens: 0,
    provider_max_tokens_field: "",
    model_context_window: 0,
    first_assistant_latency_ms: 0,
    first_tool_call_latency_ms: 0,
    provider_request_count: 0,
    assistant_tool_call_messages: 0,
    assistant_tool_call_reasoning_replay_count: 0,
    assistant_tool_call_non_null_content_count: 0,
    provider_tool_choice_request_count: 0,
  };
  let firstProviderRequestAt = 0;
  let firstToolCallCaptured = false;
  for (const line of jsonl.split(/\r?\n/u).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
    if (timestamp) {
      metrics.first_event_at ||= timestamp;
      metrics.last_event_at = timestamp;
    }
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.event_type === "pi_model_request_contract" && payload) {
      metrics.thinking_effort = typeof payload.thinking_effort === "string" ? payload.thinking_effort : "";
      metrics.provider_max_tokens = Number(payload.max_tokens ?? 0) || 0;
      metrics.provider_max_tokens_field = typeof payload.max_tokens_field === "string" ? payload.max_tokens_field : "";
      metrics.model_context_window = Number(payload.context_window ?? 0) || 0;
    }
    if (event.event_type === "pi_provider_request_observed" && payload) {
      if (!firstProviderRequestAt && timestamp) firstProviderRequestAt = Date.parse(timestamp);
      metrics.provider_request_count += 1;
      metrics.provider_max_tokens = Number(payload.max_tokens ?? payload.max_completion_tokens ?? 0) || 0;
      metrics.provider_max_tokens_field = Number(payload.max_tokens ?? 0) > 0
        ? "max_tokens"
        : Number(payload.max_completion_tokens ?? 0) > 0
        ? "max_completion_tokens"
        : metrics.provider_max_tokens_field;
      metrics.thinking_effort = typeof payload.reasoning_effort === "string"
        ? payload.reasoning_effort
        : metrics.thinking_effort;
      metrics.assistant_tool_call_messages += Number(payload.assistant_tool_call_messages ?? 0) || 0;
      metrics.assistant_tool_call_reasoning_replay_count += Number(payload.assistant_tool_call_reasoning_replay_count ?? 0) || 0;
      metrics.assistant_tool_call_non_null_content_count += Number(payload.assistant_tool_call_non_null_content_count ?? 0) || 0;
      if (payload.has_tool_choice === true) metrics.provider_tool_choice_request_count += 1;
    }
    if (event.event_type === "tool_execution_start") {
      if (!firstToolCallCaptured && firstProviderRequestAt && timestamp) {
        metrics.first_tool_call_latency_ms = Math.max(0, Date.parse(timestamp) - firstProviderRequestAt);
        firstToolCallCaptured = true;
      }
      const name = typeof payload?.tool_name === "string" ? payload.tool_name : "unknown";
      metrics.tool_call_count += 1;
      metrics.tool_calls_by_name[name] = (metrics.tool_calls_by_name[name] ?? 0) + 1;
    }
    if (event.event_type !== "pi_sdk_event" || !payload) continue;
    if (payload.type === "message_start") {
      const message = payload.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        metrics.llm_turn_count += 1;
        if (!metrics.first_assistant_latency_ms && metrics.first_event_at && timestamp) {
          metrics.first_assistant_latency_ms = Math.max(0, Date.parse(timestamp) - Date.parse(metrics.first_event_at));
        }
      }
    }
    if (payload.type === "message_end") {
      const message = payload.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      const input = Number(usage?.input ?? 0) || 0;
      const output = Number(usage?.output ?? 0) || 0;
      const cacheRead = Number(usage?.cacheRead ?? 0) || 0;
      metrics.input_tokens += input;
      metrics.output_tokens += output;
      metrics.cache_read_tokens += cacheRead;
      metrics.cache_write_tokens += Number(usage?.cacheWrite ?? 0) || 0;
      metrics.reasoning_tokens += Number(usage?.reasoning ?? 0) || 0;
      metrics.max_context_tokens = Math.max(metrics.max_context_tokens, input + cacheRead);
      metrics.max_turn_output_tokens = Math.max(metrics.max_turn_output_tokens, output);
      if (message?.stopReason === "length") metrics.length_stop_count += 1;
      const content = Array.isArray(message?.content) ? message.content : [];
      const thinkingBlocks = content.filter((block): block is Record<string, unknown> =>
        Boolean(block && typeof block === "object" && (block as Record<string, unknown>).type === "thinking")
      );
      if (thinkingBlocks.length) metrics.thinking_turn_count += 1;
      metrics.thinking_char_count += thinkingBlocks.reduce((total, block) =>
        total + (typeof block.thinking === "string" ? block.thinking.length : 0), 0);
    }
  }
  return metrics;
}
