import { PiSessionTelemetry, utf8Bytes } from "./session-telemetry.js";

interface Event { timestamp: string; event_type: string; payload: Record<string, any> }

/** Read-only audit of observed requests, not a prediction of a different model trajectory. */
export function summarizeDiscoveryPerformance(events: readonly Event[]) {
  const sessions: Array<{
    phase: string; start: string; end: string; telemetry: PiSessionTelemetry;
    tools: Record<string, { calls: number; failures: number; argument_rejections: number; result_bytes: number }>;
    issue_counts: Record<string, number>; provider_efforts: string[];
    retry_events: number; context_handoffs: number; candidate_target_count?: number;
  }> = [];
  let current: typeof sessions[number] | undefined;
  for (const event of events) {
    const payload = event.payload;
    if (event.event_type === "pi_system_prompt") {
      current = { phase: `session-${sessions.length + 1}`, start: event.timestamp, end: event.timestamp,
        telemetry: new PiSessionTelemetry("discovery", String(payload.content ?? "")), tools: {}, issue_counts: {}, provider_efforts: [], retry_events: 0, context_handoffs: 0 };
      sessions.push(current);
    }
    if (!current) continue;
    if (event.event_type === "pi_provider_request_observed") {
      current.telemetry.observeProviderRequest({}, payload);
      const effort = String(payload.reasoning_effort ?? "unknown");
      if (!current.provider_efforts.includes(effort)) current.provider_efforts.push(effort);
    }
    if (/retry|transport_failure/.test(event.event_type)) current.retry_events++;
    if (/context_handoff/.test(event.event_type)) current.context_handoffs++;
    if (event.event_type === "pi_sdk_event") {
      current.telemetry.observeSdkEvent(payload, Date.parse(event.timestamp));
      if (payload.type === "tool_execution_end") {
        current.telemetry.recordToolResult(payload.toolName, { ...payload.result, isError: payload.isError });
        let output = payload.result?.details ?? {};
        if (payload.isError && !Object.keys(output).length) {
          try { output = JSON.parse(payload.result.content.find((block: { text?: string }) => block.text)?.text ?? "{}"); }
          catch { /* Some SDK failures contain plain text rather than a tool receipt. */ }
        }
        const row = current.tools[payload.toolName] ??= { calls: 0, failures: 0, argument_rejections: 0, result_bytes: 0 };
        row.calls++;
        if (payload.isError || output.ok === false) row.failures++;
        if (output.stage === "sdk_argument_preparation") row.argument_rejections++;
        row.result_bytes += Array.isArray(payload.result?.content)
          ? payload.result.content.reduce((sum: number, block: { text?: string }) => sum + (block.text ? utf8Bytes(block.text) : 0), 0) : 0;
        const issues = [...(output.selector_issues ?? []), ...(output.issues ?? []), ...(output.results ?? []).flatMap((result: any) => result.issues ?? [])];
        for (const issue of issues) if (issue.code) current.issue_counts[issue.code] = (current.issue_counts[issue.code] ?? 0) + 1;
      }
    }
    if (event.event_type === "pi_session_telemetry") {
      current.end = event.timestamp;
      current.phase = /pdf-layout-pi-session/.test(String(payload.session_file)) ? "pdf_layout" : String(payload.phase);
    }
    if (event.event_type === "discovery_semantic_review_required") current.candidate_target_count = payload.target_count;
  }
  return { schema_version: "discovery-performance-audit/v1", sessions: sessions.map(session => {
    const telemetry = session.telemetry.snapshot();
    return { start: session.start, end: session.end,
      elapsed_ms: Date.parse(session.end) - Date.parse(session.start),
      ...telemetry, phase: session.phase, tools: session.tools, issue_counts: session.issue_counts,
      provider_efforts: session.provider_efforts, retry_events: session.retry_events, context_handoffs: session.context_handoffs,
      candidate_target_count: session.candidate_target_count,
      observed_output_tokens_per_stream_second: telemetry.assistant_stream_total_ms > 0
        ? telemetry.observed_output_total_tokens / (telemetry.assistant_stream_total_ms / 1000) : null,
    };
  }), measurement: "Observed UTF-8 request bytes and SDK token usage; stream duration excludes first-token wait. Tool failures count whole failed calls; issue counts may repeat inside one call. No live model or job mutation." };
}
