import { afterEach, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { withToolExecutionTimeout } from '../src/pi-runtime.js';
import { ACCEPTANCE_TOOL_TIMEOUTS } from '../src/acceptance-autonomous/tool-timeouts.js';

afterEach(() => { vi.useRealTimers(); });

it.each(['resolve_acceptance_reference', 'parallel_acceptance_extract', 'extract_acceptance_lot_batch', 'experiment_acceptance_table_method'])('waits for durable %s work beyond a minute, while ordinary tools keep their limit', async (name) => {
  vi.useFakeTimers();
  let preparations = 0;
  const source = { name, execute: async () => {
    preparations++;
    await new Promise(resolve => setTimeout(resolve, 65_000));
    return { content: [{ type: 'text', text: 'original version ready' }], details: { semantic_approval: false } };
  } } as unknown as ToolDefinition;
  const ordinary = { name: 'ordinary', execute: async () => {
    await new Promise(resolve => setTimeout(resolve, 65_000)); return { content: [] };
  } } as unknown as ToolDefinition;
  const [reference, bounded] = withToolExecutionTimeout([source, ordinary], 60_000, new Set(), ACCEPTANCE_TOOL_TIMEOUTS);
  const prepared = reference!.execute('reference', {}, undefined, undefined, {} as never)
    .then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }));
  const limited = bounded!.execute('ordinary', {}, undefined, undefined, {} as never)
    .then(() => 'unexpected success', error => String(error));
  await vi.advanceTimersByTimeAsync(65_000);
  expect(await prepared).toMatchObject({ ok: true, value: { content: [{ text: 'original version ready' }], details: { semantic_approval: false } } });
  expect(await limited).toContain('ordinary exceeded 60000ms');
  expect(preparations).toBe(1);
});

it.each(['resolve_acceptance_reference', 'parallel_acceptance_extract', 'extract_acceptance_lot_batch', 'experiment_acceptance_table_method'])('still cancels in-flight %s work when its original job is paused', async (name) => {
  vi.useFakeTimers();
  const job = new AbortController(); const stopped = new Error('original job paused');
  let aborted = false;
  const tool = { name, execute: async (_id: string, _params: unknown, signal: AbortSignal) => {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    return { content: [] };
  } } as unknown as ToolDefinition;
  const [reference] = withToolExecutionTimeout([tool], 60_000, new Set(), ACCEPTANCE_TOOL_TIMEOUTS);
  const preparation = reference!.execute('reference', {}, job.signal, undefined, {} as never).catch(error => error);
  await vi.advanceTimersByTimeAsync(5000); job.abort(stopped);
  expect(await preparation).toBe(stopped); expect(aborted).toBe(true);
});
