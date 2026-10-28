import { sha256Text } from '../canonical.js';
import type { AutonomousWorkRequest } from './contracts.js';

/** Renaming an extraction over the same frozen root blocks cannot create a fresh allowance. */
export function subtaskBudgetRequests(requests: readonly AutonomousWorkRequest[], request: AutonomousWorkRequest): readonly AutonomousWorkRequest[] {
  if (request.kind !== 'extraction' || !request.extraction) return [request];
  const scope = JSON.stringify([...new Set(request.extraction.block_ids)].sort());
  return requests.filter(row => row.kind === 'extraction' && row.extraction
    && JSON.stringify([...new Set(row.extraction.block_ids)].sort()) === scope);
}

/** Count the content returned by a tool, excluding model-authored inputs and UI-only details. */
export const toolResponseBytes = (result: { content: unknown }): number => Buffer.byteLength(JSON.stringify(result.content));

/** Historical request costs stay attached to their request, including interrupted reviews. */
export function subtaskToolResponses(text: string): Record<string, number> {
  const totals: Record<string, number> = {};
  const seen = new Set<string>();
  for (const line of text.split('\n').filter(line => line.trim())) {
    const row = JSON.parse(line);
    if (row.event_type !== 'review_pi_sdk_event') continue;
    const event = row.payload?.payload, id = row.payload?.request_id;
    if (event?.type !== 'tool_execution_end') continue;
    if (typeof id !== 'string' || typeof event.toolCallId !== 'string' || !Array.isArray(event.result?.content)) throw new Error('Incomplete subtask response history; preserve the checkpoint.');
    const key = `${id}:${event.toolCallId}`;
    if (seen.has(key)) throw new Error('Duplicate subtask response history; preserve the checkpoint.');
    seen.add(key);
    totals[id] = (totals[id] ?? 0) + toolResponseBytes(event.result);
  }
  return totals;
}

/** Only a complete, paired SDK ledger can support a correction to legacy attempted-output accounting. */
export function reconcileToolResponses(text: string) {
  const started = new Map<string, string>();
  const returned = new Map<string, { key: string; tool: string; bytes: number; content_sha256: string }>();
  for (const line of text.split('\n').filter(line => line.trim())) {
    const row = JSON.parse(line);
    const review = row.event_type === 'review_pi_sdk_event';
    if (row.event_type !== 'pi_sdk_event' && !review) continue;
    const event = review ? row.payload.payload : row.payload;
    if (!['tool_execution_start', 'tool_execution_end'].includes(event?.type)) continue;
    if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return undefined;
    const key = `${review ? row.payload.request_id : 'author'}:${event.toolCallId}`;
    if (event.type === 'tool_execution_start') {
      if (started.has(key)) return undefined;
      started.set(key, event.toolName);
    } else {
      if (returned.has(key) || !Array.isArray(event.result?.content)) return undefined;
      returned.set(key, { key, tool: event.toolName, bytes: toolResponseBytes(event.result), content_sha256: sha256Text(JSON.stringify(event.result.content)) });
    }
  }
  if (!started.size || started.size !== returned.size || [...started].some(([key, tool]) => returned.get(key)?.tool !== tool)) return undefined;
  const entries = [...returned.values()];
  return { returned_bytes: entries.reduce((sum, row) => sum + row.bytes, 0), tool_calls: entries.length,
    event_prefix_bytes: Buffer.byteLength(text), event_prefix_sha256: sha256Text(text), entries };
}
