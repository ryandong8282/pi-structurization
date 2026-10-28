import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runLiveAutonomousCatalog } from '../src/pi-runtime.js';
import { PI_AGENT_MODEL_STAGES, type PiAgentRuntimeModelConfig } from '../src/presets.js';

afterEach(() => vi.unstubAllEnvs());

test('catalog corrections send real image content through the Pi SDK to the provider', async () => {
  vi.stubEnv('LLM_PRESET', 'gpt5.6luna');
  const root = await mkdtemp(join(tmpdir(), 'catalog-image-'));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: '已核对截图。' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const settings = { apiType: 'openai' as const, endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-key', model: 'fixture-vision', effort: 'off' as const };
    const config: PiAgentRuntimeModelConfig = { stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, settings])) as PiAgentRuntimeModelConfig['stages'] };
    // Pi validates decoded pixels before sending images; this is a valid 1x1 PNG.
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    let sealed = false;
    const result = await runLiveAutonomousCatalog({
      runId: 'image-round', workspaceRoot: root, sourceKind: 'word-text', revisionMessage: '',
      revisionImages: [{ mimeType: 'image/png', data }],
      controller: {
        dispatch: async () => ({ ok: true }), result: () => ({ sealed }), setCoverageReviewer: () => {},
        snapshot: () => ({ checkpoint: 'fixture', working_plan_sha256: 'fixture', history_sequence: 0, last_valid_fingerprint: 'fixture' }),
      },
      onActivity: async activity => { if (activity.kind === 'message') sealed = true; },
    }, undefined, config);
    expect(result.error).toBeUndefined();
    expect(requests).toHaveLength(1);
    const user = requests[0]!.messages.find(message => message.role === 'user')!;
    expect(user.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('请查看本轮附图') }),
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
    ]));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
