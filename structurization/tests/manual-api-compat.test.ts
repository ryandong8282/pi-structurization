import { describe, expect, it, vi } from 'vitest';
import { streamSimple, Type } from '@earendil-works/pi-ai/compat';
import type { Model } from '@earendil-works/pi-ai';

describe('manual API key script compatibility', () => {
  it.each(['openai-responses', 'openai-completions'] as const)('%s preserves legacy system prompts and tool declarations', async api => {
    const model: Model<typeof api> = {
      provider: 'manual-api', id: 'manual-model', name: 'Manual model', api,
      baseUrl: 'https://api.example/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    };
    let payload: any;
    const transport = vi.fn(async () => Response.json({ error: { message: 'test endpoint', type: 'invalid_request_error' } }, { status: 400 }));
    await streamSimple(model, {
      systemPrompt: 'Retain the complete system contract.',
      messages: [{ role: 'user', content: 'Read the evidence.', timestamp: Date.now() }],
      tools: [{ name: 'read_evidence', description: 'Read evidence', parameters: Type.Object({}, { additionalProperties: false }) }],
    }, { apiKey: 'test-api-key', fetch: transport, maxRetries: 0, timeoutMs: 2000, onPayload: value => { payload = value; } }).result();
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(payload)).toContain('Retain the complete system contract.');
    expect(JSON.stringify(payload.tools)).toContain('read_evidence');
  });
});
