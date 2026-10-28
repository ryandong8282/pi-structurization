import { describe, expect, it, vi } from 'vitest';
import { constrainedContextSettings, prepareConstrainedContext } from '../src/constrained-context.js';

describe('constrained session context windows', () => {
  it('starts compaction before the host limit and keeps the configured model unchanged', () => {
    const model = { id: 'fictional-model', contextWindow: 1000000, maxTokens: 32768 };
    const policy = constrainedContextSettings(model, 230000);
    expect(policy.model).toEqual({ ...model, contextWindow: 230000 });
    expect(model.contextWindow).toBe(1000000);
    expect(policy.compaction).toEqual({ enabled: true, reserveTokens: 65536, keepRecentTokens: 20000 });
    expect(policy.threshold).toBe(164464);
    expect(constrainedContextSettings({ contextWindow: 128000 }, 230000).model.contextWindow).toBe(128000);
  });

  it('compacts persisted oversized history before author tools can resume', async () => {
    const calls: string[] = [];
    const compact = vi.fn(async () => { calls.push('compact'); return { estimatedTokensAfter: 12000 }; });
    const events: string[] = [];
    await prepareConstrainedContext({ getContextUsage: () => ({ tokens: 230246 }), compact }, 164464,
      tokens => { calls.push(`ready:${tokens}`); }, async type => { events.push(type); });
    expect(calls).toEqual(['compact', 'ready:12000']);
    expect(events).toEqual(['pi_context_compaction_started', 'pi_context_compaction_completed']);
    expect(compact.mock.calls[0]![0]).toContain('不清空或重建检查点');
  });

  it('uses a small current window without paying for another compaction', async () => {
    const compact = vi.fn(), ready = vi.fn();
    await prepareConstrainedContext({ getContextUsage: () => ({ tokens: 12000 }), compact }, 164464, ready, vi.fn());
    expect(compact).not.toHaveBeenCalled(); expect(ready).toHaveBeenCalledWith(12000);
  });

  it.each([undefined, Number.NaN, 164464, 230246])('does not grant a new window when compression remains invalid: %s', async after => {
    const ready = vi.fn();
    await expect(prepareConstrainedContext({ getContextUsage: () => ({ tokens: 230246 }),
      compact: async () => ({ estimatedTokensAfter: after }) }, 164464, ready, vi.fn())).rejects.toThrow('context_compaction_insufficient');
    expect(ready).not.toHaveBeenCalled();
  });

  it('preserves failure when the SDK cannot produce a summary', async () => {
    const ready = vi.fn();
    await expect(prepareConstrainedContext({ getContextUsage: () => ({ tokens: 230246 }),
      compact: async () => { throw new Error('synthetic compaction failure'); } }, 164464, ready, vi.fn())).rejects.toThrow('synthetic compaction failure');
    expect(ready).not.toHaveBeenCalled();
  });
});
