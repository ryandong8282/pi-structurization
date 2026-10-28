import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Text } from '../src/canonical.js';
import { eventPrefixMatches } from '../src/acceptance-autonomous/event-history.js';

const observed = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), read = handle.read.bind(handle);
    handle.read = (async (...input: Parameters<typeof read>) => {
      const result = await read(...input); observed.bytes += result.bytesRead; return result;
    }) as typeof handle.read;
    return handle;
  } };
});

const dirs: string[] = [];
afterEach(async () => { observed.bytes = 0; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-history-')); dirs.push(dir);
  const path = join(dir, 'session.events.jsonl'); await writeFile(path, bytes); return path;
}

it('verifies the audited prefix without reading a large appended history', async () => {
  const prefix = Buffer.from('{"event":"虚构工具回条"}\n');
  const path = await fixture(Buffer.concat([prefix, Buffer.alloc(8 * 1024 * 1024, 120)]));
  expect(await eventPrefixMatches(path, prefix.length, sha256Text(prefix.toString('utf8')))).toBe(true);
  expect(observed.bytes).toBe(prefix.length);
  await appendFile(path, '\n新事件');
  expect(await eventPrefixMatches(path, prefix.length, sha256Text(prefix.toString('utf8')))).toBe(true);
  expect(observed.bytes).toBe(2 * prefix.length);
});

it('keeps the historical UTF-8 hash semantics across chunks and a partial final character', async () => {
  const prefix = Buffer.concat([Buffer.alloc(512 * 1024 - 1, 97), Buffer.from('甲乙'), Buffer.from([0xe4, 0xb8])]);
  const path = await fixture(Buffer.concat([prefix, Buffer.from('后续历史')]));
  expect(await eventPrefixMatches(path, prefix.length, sha256Text(prefix.toString('utf8')))).toBe(true);
  expect(observed.bytes).toBe(prefix.length);
});

it('rejects changed, truncated and invalid histories without granting new accounting', async () => {
  const path = await fixture(Buffer.from('old audit'));
  const hash = sha256Text('old audit');
  await writeFile(path, 'new audit and tail');
  expect(await eventPrefixMatches(path, 9, hash)).toBe(false);
  await writeFile(path, 'old');
  expect(await eventPrefixMatches(path, 9, hash)).toBe(false);
  for (const bytes of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(await eventPrefixMatches(path, bytes, hash)).toBe(false);
  }
});

it('only permits a missing empty history at callers that already allowed it', async () => {
  const path = await fixture(Buffer.alloc(0)); await rm(path);
  await expect(eventPrefixMatches(path, 0, sha256Text(''))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await eventPrefixMatches(path, 0, sha256Text(''), true)).toBe(true);
  expect(await eventPrefixMatches(path, 1, sha256Text('x'), true)).toBe(false);
});
