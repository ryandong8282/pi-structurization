import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { createAcceptanceAutonomousTools } from '../src/acceptance-autonomous/runtime.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const limits = { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072,
  max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 8 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
async function fixture(text = '# Fictional form\n\n![](images/example.png)\n') {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-source-images-')); dirs.push(dir);
  await mkdir(join(dir, 'images'));
  await writeFile(join(dir, 'images/example.png'), png);
  const markdownPath = join(dir, 'original.md'); await writeFile(markdownPath, text);
  const options = { root: join(dir, 'run'), markdownPath, limits, reviewer: async () => { throw new Error('No model in neutral fixture'); } };
  const controller = await AcceptanceAutonomousController.open(options);
  return { controller, options, dir, text };
}

it('makes original image attachments readable without rewriting frozen Markdown', async () => {
  const { controller, options, text } = await fixture();
  const workspace = await controller.dispatch('acceptance_workspace', {});
  const source = (workspace.source_index as Array<{ markdown: string; images: string }>)[0]!;
  expect(source.images).toBeTruthy();
  const index = JSON.parse(await readFile(join(controller.workRoot, source.images), 'utf8'));
  expect(index.images).toHaveLength(1);
  expect(index.images[0]).toMatchObject({ reference: 'images/example.png', status: 'available' });
  expect(await readFile(join(controller.sourceRoot, `${index.source_id}.md`), 'utf8')).toBe(text);
  expect(await readFile(options.markdownPath, 'utf8')).toBe(text);
  const read = createAcceptanceAutonomousTools(controller).find(tool => tool.name === 'read')!;
  const result = await read.execute('image-read', { path: `source/${index.images[0].path}` }, new AbortController().signal);
  expect(result.content.some(block => block.type === 'image')).toBe(true);
});

it('preserves checkpoint accounting on resume and detects frozen image changes', async () => {
  const { controller, options } = await fixture();
  await controller.accountTool(123, 1000); await controller.beginSession();
  const before = controller.state().budget;
  const resumed = await AcceptanceAutonomousController.open(options);
  expect(resumed.state().budget).toEqual(before);
  const source = (await resumed.dispatch('acceptance_workspace', {})).source_index as Array<{ images: string }>;
  const manifest = JSON.parse(await readFile(join(resumed.workRoot, source[0]!.images), 'utf8'));
  await writeFile(join(resumed.sourceRoot, manifest.images[0].path), 'changed fictional pixels');
  await expect(resumed.assertSources()).rejects.toThrow(/image.*changed/i);
});

it('lists unavailable and external image references without reading outside the original document directory', async () => {
  const { controller } = await fixture('# Fictional form\n\n![](images/missing.png)\n\n![](../private.png)\n\n![](https://example.invalid/image.png)\n');
  const source = (await controller.dispatch('acceptance_workspace', {})).source_index as Array<{ images: string }>;
  const manifest = JSON.parse(await readFile(join(controller.workRoot, source[0]!.images), 'utf8'));
  expect(manifest.images.map((row: { status: string }) => row.status)).toEqual(['missing', 'unsupported', 'unsupported']);
  expect(manifest.images.every((row: { path?: string }) => !row.path)).toBe(true);
});

it('records newly available companions without changing counters or earlier immutable manifests', async () => {
  const { controller, options, dir } = await fixture('# Fictional form\n\n![](images/later.png)\n');
  await controller.accountTool(123, 1000); await controller.beginSession();
  const before = controller.state();
  const index = (await controller.dispatch('acceptance_workspace', {})).source_index as Array<{ images: string }>;
  const oldManifest = await readFile(join(controller.workRoot, index[0]!.images), 'utf8');
  await writeFile(join(dir, 'images/later.png'), png);
  const resumed = await AcceptanceAutonomousController.open(options);
  expect(resumed.state().budget).toEqual(before.budget);
  expect(resumed.state().source_image_manifests).not.toEqual(before.source_image_manifests);
  expect(await readFile(join(controller.workRoot, index[0]!.images), 'utf8')).toBe(oldManifest);
});

it('refuses replacement pixels under an unchanged original Markdown version', async () => {
  const { controller, options, dir } = await fixture();
  const before = controller.state().budget;
  await writeFile(join(dir, 'images/example.png'), 'different original image');
  await expect(AcceptanceAutonomousController.open(options)).rejects.toThrow(/source image changed/i);
  expect(JSON.parse(await readFile(join(controller.root, 'checkpoint.json'), 'utf8')).budget).toEqual(before);
});
