import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test } from 'vitest';
import { assertCatalogAutonomousResumeCheckpoint } from '../src/pi-runtime.js';

describe('catalog Pi resume checkpoint', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  async function checkpoint(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'catalog-resume-')); roots.push(root);
    await mkdir(join(root, '.model-source-handles'));
    await mkdir(join(root, 'source', 'markdown', 'provided'), { recursive: true });
    await writeFile(join(root, 'DELIVERY.json'), JSON.stringify({ structures: [{ id: 'a' }] }));
    await writeFile(join(root, 'source', 'pages.json'), JSON.stringify(['source paragraph']));
    await writeFile(join(root, 'source', 'markdown', 'provided', 'full.md'), '# source');
    await writeFile(join(root, 'source', 'markdown', 'index.json'), JSON.stringify({ complete: true,
      sources: [{ markdown: 'source/markdown/provided/full.md' }] }));
    await writeFile(join(root, '.model-source-handles', 'map.json'), JSON.stringify({ scope: 'scope-a' }));
    await writeFile(join(root, '.model-source-handles', 'owner.json'), JSON.stringify({ scope: 'scope-a' }));
    return root;
  }

  function persistedScopedSession(root: string): SessionManager {
    const session = SessionManager.create(root, join(root, 'pi-session'));
    session.appendCustomEntry('model-source-handles/v1', { scope: 'scope-a' });
    // Pi defers writing a new session until it contains an assistant message.
    session.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'Checkpoint saved.' }],
      api: 'openai-responses', provider: 'fixture', model: 'fixture',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    return session;
  }

  test('uses matching safe session with the preserved draft', async () => {
    const root = await checkpoint();
    const session = persistedScopedSession(root);
    expect((await readFile(session.getSessionFile()!, 'utf8'))).toContain('scope-a');
    await expect(assertCatalogAutonomousResumeCheckpoint(root)).resolves.toEqual({
      resumeSession: true, reason: 'session_clean',
    });
  });

  test('starts a new session in the same workspace when the old scope differs', async () => {
    const root = await checkpoint();
    persistedScopedSession(root);
    await writeFile(join(root, '.model-source-handles', 'map.json'), JSON.stringify({ scope: 'scope-b' }));
    await expect(assertCatalogAutonomousResumeCheckpoint(root)).resolves.toEqual({
      resumeSession: false, reason: 'source_handle_scope_mismatch',
    });
  });

  test('uses durable draft, not an interrupted provider tool call, as recovery authority', async () => {
    const root = await checkpoint();
    const session = persistedScopedSession(root);
    await writeFile(session.getSessionFile()!, `${await readFile(session.getSessionFile()!, 'utf8')}${JSON.stringify({
      type: 'message', id: 'unfinished-tool', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'seal_catalog_delivery', arguments: {} }],
        provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now() },
    })}\n`);
    await expect(assertCatalogAutonomousResumeCheckpoint(root)).resolves.toEqual({
      resumeSession: false, reason: 'session_unresolved_tool_calls',
    });
    expect(JSON.parse(await readFile(join(root, 'DELIVERY.json'), 'utf8')).structures).toHaveLength(1);
  });

  test('refuses a missing source document rather than silently extracting again', async () => {
    const root = await checkpoint();
    await rm(join(root, 'source', 'markdown', 'provided', 'full.md'));
    await expect(assertCatalogAutonomousResumeCheckpoint(root)).rejects.toThrow(/Markdown 缺失/);
  });
});
