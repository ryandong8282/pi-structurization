import { afterEach, expect, test, vi } from 'vitest';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ProgressIdleDeadline, UniqueSuccessfulToolCalls, isExpectedTerminalAbortMessage,
  withToolExecutionTimeout } from '../src/pi-runtime.js';

afterEach(() => vi.useRealTimers());

test('active review can exceed the old wall deadline and stalls still time out', async () => {
  vi.useFakeTimers();
  const deadline = new ProgressIdleDeadline(8 * 60_000);
  try {
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(deadline.signal.aborted).toBe(false);
    deadline.progress();
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deadline.signal.aborted).toBe(true);
    expect(String(deadline.signal.reason)).toContain('review_idle_timeout');
  } finally {
    deadline.dispose();
  }
});

test('only a new successful read advances review progress', () => {
  const activity = new UniqueSuccessfulToolCalls();
  const call = (id: string, offset: number, ok: boolean) => {
    expect(activity.observe({ type: 'tool_execution_start', toolCallId: id,
      toolName: 'read_catalog_review_source', args: { path: 'source/example.md', offset } })).toBe(false);
    return activity.observe({ type: 'tool_execution_end', toolCallId: id, result: { details: { ok } } });
  };
  expect(call('first', 0, true)).toBe(true);
  expect(call('repeat', 0, true)).toBe(false);
  expect(call('failed', 500, false)).toBe(false);
  expect(call('next', 500, true)).toBe(true);
});

test('only an expected post-terminal abort is hidden from the conversation', () => {
  expect(isExpectedTerminalAbortMessage({ role: 'assistant', errorMessage: 'This operation was aborted' })).toBe(true);
  expect(isExpectedTerminalAbortMessage({ role: 'assistant', errorMessage: 'Request was aborted' })).toBe(true);
  expect(isExpectedTerminalAbortMessage({ role: 'assistant', errorMessage: '408: stream disconnected' })).toBe(false);
});

test('a long-running seal tool is governed by its review progress instead of a wall timer', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const tool = defineTool({ name: 'seal_delivery', label: 'Seal', description: 'Seal after review',
    parameters: Type.Object({}),
    execute: async () => { await work; return { content: [{ type: 'text' as const, text: 'done' }] }; },
  });
  const [bounded] = withToolExecutionTimeout([tool], 60_000, new Set(), { seal_delivery: Number.POSITIVE_INFINITY });
  const result = bounded!.execute('call', {}, undefined as never, undefined as never, undefined as never);
  await vi.advanceTimersByTimeAsync(70 * 60_000);
  finish();
  await expect(result).resolves.toMatchObject({ content: [{ text: 'done' }] });
});
