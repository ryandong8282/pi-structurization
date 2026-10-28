import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSweepArtifacts } from '../src/acceptance-autonomous/sweep-artifacts.js';
import { sha256Text } from '../src/canonical.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry = (text: string) => ({ text, sha256: sha256Text(text) });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sweep-artifact-fixture-')); roots.push(root);
  const work = join(root, 'work'); await mkdir(work); return { root, work };
}

it('preflights every path and never overwrites a different existing author file', async () => {
  const { work } = await fixture(); await writeFile(join(work, 'keep.json'), 'existing');
  await expect(installSweepArtifacts(work, { 'new.json': entry('new'), 'keep.json': entry('replacement') })).rejects.toThrow(/collision/);
  expect(await readFile(join(work, 'keep.json'), 'utf8')).toBe('existing');
  await expect(readFile(join(work, 'new.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await installSweepArtifacts(work, { 'keep.json': entry('existing'), 'new.json': entry('new') })).toEqual(['new.json']);
  expect(await installSweepArtifacts(work, { 'new.json': entry('new') })).toEqual([]);
});

it('rejects source writes, traversal and symlink escapes before creating generated files', async () => {
  const { root, work } = await fixture(); const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(work, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['source/config.json', '../outside/config.json', 'alias/config.json'])
    await expect(installSweepArtifacts(work, { [name]: entry('synthetic') })).rejects.toThrow(/author work/);
  await expect(readFile(join(outside, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
