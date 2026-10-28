import { describe, expect, test, vi } from 'vitest';
import {
  MAX_TOOL_PADDING_CHARACTERS, ModelStreamNoProgressError, ModelStreamArgumentShapeError, ModelStreamProgressGuard,
  createStreamRecoveryRunner,
  MAX_REPETITIVE_TEXT_TAIL_CHARACTERS, ModelStreamRepetitiveTextError,
} from '../src/model-stream-progress.js';

const delta = (value: string, contentIndex = 0, type = 'toolcall_delta') => ({
  type: 'message_update', message: { role: 'assistant', timestamp: 123, content: [{ id: 'call-1', name: 'edit' }] },
  assistantMessageEvent: { type, contentIndex, delta: value },
});

describe('semantic-free stream progress protection', () => {
  test.each(['\\', '~', '·'])('aborts an endless %s text tail across delta boundaries', symbol => {
    const guard = new ModelStreamProgressGuard();
    guard.observe(delta('已保存调查，继续读取。', 0, 'text_delta'));
    let caught: unknown;
    for (let index = 0; index < MAX_REPETITIVE_TEXT_TAIL_CHARACTERS; index++) {
      try { guard.observe(delta(`${symbol} `, 0, 'text_delta')); } catch (error) { caught = error; break; }
    }
    expect(caught).toBeInstanceOf(ModelStreamRepetitiveTextError);
    expect(caught).toMatchObject({ code: 'model_stream_repetitive_text', symbol,
      tailCharacters: MAX_REPETITIVE_TEXT_TAIL_CHARACTERS, toolName: '' });
    expect((caught as Error).message).toContain('不是工具回执');
  });

  test('does not limit substantive long text, tool string contents or short independent text blocks', () => {
    const guard = new ModelStreamProgressGuard();
    const text = '公式 x = \\alpha + y；来源与条件核查。 '.repeat(3000);
    for (let index = 0; index < text.length; index += 37) expect(() => guard.observe(delta(text.slice(index,index+37),0,'text_delta'))).not.toThrow();
    guard.observe(delta('~'.repeat(MAX_REPETITIVE_TEXT_TAIL_CHARACTERS-1),0,'text_delta'));
    expect(() => guard.observe(delta('~',1,'text_delta'))).not.toThrow();
    guard.observe({ type: 'message_start' });
    expect(() => guard.observe(delta('~',0,'text_delta'))).not.toThrow();
    guard.observe(delta('{"source":"'));
    expect(() => guard.observe(delta('~ '.repeat(MAX_REPETITIVE_TEXT_TAIL_CHARACTERS)))).not.toThrow();
  });
  test('uses the current tool schema to abort a non-object record before it repeats', () => {
    const guard = new ModelStreamProgressGuard([{ name: 'edit', parameters: {
      type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } },
    } }]);
    const event = delta('"unfinished');
    Object.assign(event.message.content[0]!, { arguments: { rows: [{ key: 'saved' }, 'unfinished'] } });
    expect(() => guard.observe(event)).toThrowError(expect.objectContaining({
      code: 'model_stream_argument_shape_invalid', toolName: 'edit', issue: { path: '/rows/1', actual: { json_type: 'string', length: 10 }, expected: { json_type: 'object' } },
    }));
    guard.observe({ type: 'message_start' });
    Object.assign(event.message.content[0]!, { arguments: { rows: [{ key: 'correct' }] } });
    expect(() => guard.observe(event)).not.toThrow();
  });
  test('ordinary empty/whitespace deltas are not progress', () => {
    const guard = new ModelStreamProgressGuard();
    expect(guard.observe(delta(''))).toBe(false);
    expect(guard.observe(delta(' \r\n'))).toBe(false);
    expect(guard.observe(delta(' ', 0, 'thinking_delta'))).toBe(false);
    expect(guard.observe(delta(' ', 0, 'text_delta'))).toBe(false);
    expect(guard.observe(delta('正在核查', 0, 'text_delta'))).toBe(true);
    expect(guard.observe({ type: 'tool_execution_start' })).toBe(true);
  });

  test('reproduces a malformed edit argument followed by endless raw whitespace across chunks', () => {
    const guard = new ModelStreamProgressGuard();
    // Sanitized protocol shape only: no document identity or original model prose.
    guard.observe(delta('{"invalid argument prefix\n'));
    let caught: unknown;
    for (let i = 0; i < MAX_TOOL_PADDING_CHARACTERS; i++) {
      try { guard.observe(delta(' \r\r\n')); } catch (error) { caught = error; break; }
    }
    expect(caught).toBeInstanceOf(ModelStreamNoProgressError);
    expect((caught as ModelStreamNoProgressError).paddingCharacters).toBe(MAX_TOOL_PADDING_CHARACTERS);
    expect((caught as ModelStreamNoProgressError).toolName).toBe('edit');
  });

  test('JSON formatting padding is bounded, but useful output is not size-limited', () => {
    const guard = new ModelStreamProgressGuard();
    guard.observe(delta('{'));
    expect(() => guard.observe(delta(' '.repeat(MAX_TOOL_PADDING_CHARACTERS)))).toThrow(ModelStreamNoProgressError);
    const good = new ModelStreamProgressGuard();
    const json = JSON.stringify({path:'draft.py',edits:[{oldText:'a',newText:'print("hello")\n'.repeat(30000)}]}, null, 2);
    for (let i = 0; i < json.length; i += 43) expect(good.observe(delta(json.slice(i, i + 43)))).toBeTypeOf('boolean');
  });

  test('literal spaces in a JSON string and escaped quotes/newlines are legitimate content', () => {
    const guard = new ModelStreamProgressGuard();
    guard.observe(delta('{"content":"'));
    expect(guard.observe(delta(' '.repeat(MAX_TOOL_PADDING_CHARACTERS * 2)))).toBe(true);
    for (const chunk of ['\\', '"', ' '.repeat(MAX_TOOL_PADDING_CHARACTERS), '\\', 'n', '"}']) guard.observe(delta(chunk));
  });

  test('progress is isolated per tool call, and new assistant messages reset parser state', () => {
    const guard = new ModelStreamProgressGuard();
    guard.observe(delta(' '.repeat(MAX_TOOL_PADDING_CHARACTERS - 1), 0));
    expect(guard.observe(delta(' ', 1))).toBe(false);
    expect(() => guard.observe(delta(' ', 0))).toThrow(ModelStreamNoProgressError);
    guard.observe({type:'message_start',message:{role:'assistant'}});
    expect(guard.observe(delta(' '))).toBe(false);
    guard.observe(delta('{"x":1,'));
    expect(() => guard.observe(delta(' '.repeat(MAX_TOOL_PADDING_CHARACTERS - 1)))).not.toThrow();
  });
});

describe('bounded recovery through Pi abort/prompt', () => {
  test('recovers repetitive text using the existing session-wide budget and retains no arbitrary prose', async () => {
    const events: unknown[] = [];
    const recover = createStreamRecoveryRunner({ onRecovery: async event => { events.push(event); } });
    const fault = new ModelStreamRepetitiveTextError('~',MAX_REPETITIVE_TEXT_TAIL_CHARACTERS);
    const run = vi.fn(async (prompt: string) => prompt === 'task' ? { kind: 'failed', error: fault } : { kind: 'completed' });
    expect(await recover('task',run)).toEqual({ kind: 'completed' });
    expect(events).toMatchObject([{ state:'retrying',attempt:1,maxAttempts:2,code:fault.code,
      paddingCharacters:0,textTail:{symbol:'~',characters:MAX_REPETITIVE_TEXT_TAIL_CHARACTERS} }]);
    expect(run.mock.calls[1]![0]).toContain('保留已完成的工具操作');
  });
  test('returns the exact shape path and next action to the author, without copying arbitrary output', async () => {
    const events: unknown[] = [];
    const recover = createStreamRecoveryRunner({ onRecovery: async event => { events.push(event); } });
    const fault = new ModelStreamArgumentShapeError('edit', { path: '/rows/1', actual: { json_type: 'string', length: 20 }, expected: { json_type: 'object' } });
    const run = vi.fn(async (prompt: string) => prompt === 'task' ? { kind: 'failed', error: fault } : { kind: 'completed' });
    expect(await recover('task', run)).toEqual({ kind: 'completed' });
    expect(run.mock.calls[1]![0]).toContain('/rows/1');
    expect(run.mock.calls[1]![0]).toContain('未执行');
    expect(run.mock.calls[1]![0]).toContain('契约要求对象');
    expect(events).toMatchObject([{ code: fault.code, toolName: 'edit', argumentIssue: { path: '/rows/1' } }]);
  });
  const fault = () => new ModelStreamNoProgressError(MAX_TOOL_PADDING_CHARACTERS, 'edit');
  test('retries only a settled stalled attempt and retains the existing task prompt', async () => {
    const events: unknown[] = [];
    const recover = createStreamRecoveryRunner({onRecovery:async event=>{events.push(event);}});
    let release!: () => void;
    const settled = new Promise<void>(resolve=>{release=resolve;});
    const run = vi.fn(async (prompt: string): Promise<{kind:string;error?:unknown}> => {
      if (prompt === '原任务') { await settled; return {kind:'failed',error:fault()}; }
      return {kind:'sealed'};
    });
    const pending = recover('原任务',run);
    await Promise.resolve();expect(run).toHaveBeenCalledTimes(1);expect(events).toEqual([]);
    release();
    expect(await pending).toEqual({kind:'sealed'});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toContain('原任务');
    expect(run.mock.calls[1]![0]).toContain('已完成的工具操作');
    expect(events).toMatchObject([{state:'retrying',attempt:1,maxAttempts:2}]);
  });

  test('at most two recoveries per session, including across length-continuation prompts', async () => {
    const events: unknown[] = [];
    const recover = createStreamRecoveryRunner({onRecovery:async event=>{events.push(event);}});
    const outcomes = [{kind:'failed',error:fault()},{kind:'completed'},{kind:'failed',error:fault()},{kind:'completed'}];
    const run = vi.fn(async()=>outcomes.shift()!);
    expect((await recover('round1',run)).kind).toBe('completed');
    expect((await recover('round2',run)).kind).toBe('completed');
    const failed = await recover('round3',async()=>({kind:'failed',error:fault()}));
    expect(failed.error).toBeInstanceOf(Error);
    expect(String(failed.error)).toContain('自动恢复上限');
    expect(events).toMatchObject([{attempt:1},{attempt:2},{state:'exhausted',attempt:2}]);
  });

  test('does not retry cancellation, business/validation failures or exhausted SDK transport retries', async () => {
    const onRecovery = vi.fn();
    const abort = new AbortController();
    const recover = createStreamRecoveryRunner({onRecovery,signal:abort.signal});
    for (const result of [{kind:'failed',error:new Error('invalid evidence')}, {kind:'failed',error:new Error('503')}, {kind:'completed'}, {kind:'sealed'}]) {
      const run = vi.fn(async()=>result);
      expect(await recover('task',run)).toBe(result);expect(run).toHaveBeenCalledTimes(1);
    }
    await expect(recover('task',async()=>{abort.abort(new Error('user cancelled'));return {kind:'failed',error:fault()};})).rejects.toThrow('user cancelled');
    expect(onRecovery).not.toHaveBeenCalled();
  });
});
