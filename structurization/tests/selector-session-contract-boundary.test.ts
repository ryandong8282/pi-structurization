import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { outerTransportSessionSettings } from '../src/pi-runtime.js';
import { installSelectorSessionContractBoundary, selectorSessionContractContext } from '../src/selector-session-contract.js';
import { TARGET_SELECTOR_PROTOCOLS } from '../src/acceptance-prompt-suite.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.each(['retained', 'before_prompt', 'overflow_continue'] as const)(
  'installed SDK request boundary supplies one current protocol after %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'selector-contract-boundary-')); roots.push(root);
    const agentDir = join(root, 'agent'); await mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const model: Model<'openai-completions'> = {
      id: 'neutral-boundary', name: 'neutral-boundary', provider: 'neutral-provider', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 32,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const assistant = (overflow = false): AssistantMessage => ({ role: 'assistant', content: [], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), usage,
      stopReason: overflow ? 'error' : 'stop', ...(overflow ? { errorMessage: 'context length exceeded' } : {}) });
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({ role: 'user', content: selectorSessionContractContext('开始', []).prompt, timestamp: Date.now() });
    manager.appendMessage(assistant());
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Exercise neutral context delivery only.' });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, noTools: 'all',
      settingsManager: outerTransportSessionSettings(root, agentDir), resourceLoader: loader, sessionManager: manager });
    const delivery: string[] = [];
    installSelectorSessionContractBoundary(session.agent, () => false, result => { delivery.push(result.delivery); });
    const seen: Message[][] = [];
    session.agent.streamFunction = (_model, context) => {
      seen.push(structuredClone(context.messages));
      const result = assistant(mode === 'overflow_continue' && seen.length === 1);
      const events = new AssistantMessageEventStream();
      if (result.stopReason === 'error') events.push({ type: 'error', reason: 'error', error: result });
      else events.push({ type: 'done', reason: 'stop', message: result });
      return events;
    };
    let compacted = false;
    // Keep the installed SDK's prompt/continue orchestration; replace only the
    // summarization operation with its context-removal effect (no network).
    vi.spyOn(session as any, '_checkCompaction').mockImplementation(async (...args: unknown[]) => {
      const afterRun = args[1] === true;
      if (!compacted && ((mode === 'before_prompt' && !afterRun)
        || (mode === 'overflow_continue' && afterRun && seen.length === 1))) {
        compacted = true;
        manager.appendCompaction('压缩摘要：继续当前保存的中性草稿。', null, 100_000);
        (session as any)._refreshFinalizedContext();
        return afterRun;
      }
      return false;
    });
    try {
      // Outer check sees the retained contract. A subsequent SDK compaction
      // must not make that pre-prompt answer authoritative for the actual call.
      const outer = selectorSessionContractContext('继续', session.messages);
      expect(outer.delivery).toBe('retained_context');
      await session.prompt(outer.prompt);
      expect(seen).toHaveLength(mode === 'overflow_continue' ? 2 : 1);
      for (const messages of seen) {
        const text = messages.map(message => typeof message.content === 'string' ? message.content
          : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
        expect(text.match(/<selector_session_contract fingerprint=/g)).toHaveLength(1);
        for (const protocol of Object.values(TARGET_SELECTOR_PROTOCOLS)) expect(text).toContain(JSON.stringify(protocol).slice(1, -1));
      }
      expect(delivery).toEqual(mode === 'retained' ? ['retained_context']
        : mode === 'before_prompt' ? ['provided_in_user_message'] : ['retained_context', 'provided_in_user_message']);
      if (compacted) expect(JSON.stringify(session.messages)).not.toContain('<selector_session_contract');
    } finally { session.dispose(); }
  },
);

test('request boundary preserves the validated seal bypass and converted context', async () => {
  const converted: Message[] = [{ role: 'user', content: '封存已有成功指纹', timestamp: 1 }];
  const agent = { convertToLlm: async () => converted };
  installSelectorSessionContractBoundary(agent, () => true);
  expect(await agent.convertToLlm()).toBe(converted);
});
