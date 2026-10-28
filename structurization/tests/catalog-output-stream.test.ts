import { afterEach, expect, test, vi } from 'vitest';
import { createCatalogOutputStream } from '../src/catalog-output-stream.js';

afterEach(() => vi.useRealTimers());
test('coalesces text, thinking and tool argument deltas while preserving event order', () => {
  vi.useFakeTimers();
  const events: unknown[] = [];
  const stream = createCatalogOutputStream((event) => events.push(event));
  const update = (type: string, delta: string, contentIndex = 0) => ({ type: 'message_update', message: { role: 'assistant', timestamp: 123, content: [{ id: 't', name: 'write', arguments: { giant: 'not copied' } }] }, assistantMessageEvent: { type, delta, contentIndex, partial: { giant: 'not copied' } } });
  expect(stream.capture(update('thinking_delta', '先'))).toBe(true);
  stream.capture(update('thinking_delta', '搜索'));
  expect(events).toEqual([]);
  vi.advanceTimersByTime(180);
  expect(events[0]).toMatchObject({ assistantMessageEvent: { delta: '先搜索' } });
  stream.capture(update('text_delta', '正文', 1));
  stream.capture(update('toolcall_delta', '{"code":'));
  expect(events).toHaveLength(2);
  expect(stream.capture({ type: 'tool_execution_start' })).toBe(false);
  expect(events[2]).toMatchObject({ assistantMessageEvent: { toolCallId: 't', toolName: 'write', delta: '{"code":' } });
  expect(JSON.stringify(events)).not.toContain('not copied');
  vi.runAllTimers();
  expect(events).toHaveLength(3);
});

test('flush retains pending output on interruption, non-public updates are ignored', () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const stream = createCatalogOutputStream(emit);
  stream.capture({ type: 'message_update', message: { role: 'user' }, assistantMessageEvent: { type: 'text_delta', delta: 'private' } });
  stream.capture({ type: 'message_update', message: { role: 'assistant', timestamp: 1 }, assistantMessageEvent: { type: 'text_delta', delta: 'partial', contentIndex: 0 } });
  stream.flush();
  vi.runAllTimers();
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0]?.[0].assistantMessageEvent.delta).toBe('partial');
});
