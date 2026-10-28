import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { verifySourceImages, sourceImageProofs, type OriginalPdfPageRenderer } from '../src/acceptance-autonomous/source-images.js';
import { createAcceptanceAutonomousTools } from '../src/acceptance-autonomous/runtime.js';
import { toolResponseBytes } from '../src/acceptance-autonomous/tool-accounting.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-original-page-')); roots.push(dir);
  const markdown = '# Synthetic [PDF p.2]\n\nDECODED BETA';
  const source = buildAcceptanceSourceLedger(markdown), block = source.blocks[1]!;
  const markdownPath = join(dir, 'source.md'), pdfPath = join(dir, 'original.pdf');
  const pdf = Buffer.from('%PDF-1.4\nSynthetic original ALPHA');
  await writeFile(markdownPath, markdown); await writeFile(pdfPath, pdf);
  const render = vi.fn<OriginalPdfPageRenderer>(async () => ({ ok: true, page_count: 2, image: Buffer.from('synthetic page raster') }));
  const options = { root: join(dir, 'run'), markdownPath,
    limits: { max_tool_response_bytes: 1048576, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 8 },
    subtaskToolResponseBytes: 524288, reviewer: async () => ({ approved: false, reviewed_lot_ids: [], findings: [], reason: 'not requested' }),
    originalPdf: { path: pdfPath, sha256: sha(pdf), kind: 'original_pdf' as const }, renderOriginalPdfPage: render };
  const controller = await AcceptanceAutonomousController.open(options);
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify({ schema_version: 'acceptance-autonomous-delivery/v1',
    source_sha256: source.sha256, lots: [], groups: [], rules: [], references: [], problems: [], dispositions: source.blocks.map(row => ({
      source_id: source.source_id, block_id: row.id, role: 'not_extractable', lot_ids: [], reason: 'fictional source', evidence: [sourceQuote(source, row)] })) }));
  return { dir, source, block, pdf, options, controller, render, markdownPath };
}

it('freezes a registered original page without changing decoded text, counters or approvals; resumes the exact immutable view', async () => {
  const f = await fixture(), before = f.controller.state();
  const result = await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id, path: 'not-a-registered-path.pdf' });
  expect(result).toMatchObject({ ok: true, source_id: f.source.source_id, block_id: f.block.id, page_number: 2,
    pdf_sha256: sha(f.pdf), pdf_kind: 'original_pdf', next_tool: 'read' });
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.render.mock.calls[0]![0]).toMatchObject({ page_number: 2 });
  expect(await readFile(f.render.mock.calls[0]![0].pdf_path)).toEqual(f.pdf);
  expect(f.render.mock.calls[0]![0].pdf_path).not.toBe(f.options.originalPdf.path);
  expect(await readFile(f.markdownPath, 'utf8')).toBe('# Synthetic [PDF p.2]\n\nDECODED BETA');
  expect(f.controller.state().budget).toEqual(before.budget);
  expect(f.controller.state().approvals).toEqual(before.approvals); expect(f.controller.state().publications).toEqual([]);
  const digests = f.controller.state().source_image_manifests!;
  const manifests = await verifySourceImages(f.controller.sourceRoot, digests);
  expect(sourceImageProofs(sourceQuote(f.source, f.block), manifests)).toBeDefined();
  expect(sourceImageProofs(sourceQuote(f.source, f.source.blocks[0]!), manifests)).toBeUndefined();
  const reopened = await AcceptanceAutonomousController.open(f.options);
  expect(reopened.state().source_image_manifests).toEqual(digests);
  expect(await reopened.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id })).toMatchObject({ ok: true, cached: true });
  expect(f.render).toHaveBeenCalledTimes(1);
  await writeFile(join(f.controller.sourceRoot, String(result.image_path).replace(/^source\//, '')), 'changed pixels');
  await expect(verifySourceImages(f.controller.sourceRoot, digests)).rejects.toThrow(/image changed/i);
});

it('rejects unknown source blocks and out-of-range physical pages without accepting arbitrary file paths', async () => {
  const f = await fixture(), beforeImages = f.controller.state().source_image_manifests;
  const unknown = await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: 'unknown', path: f.options.originalPdf.path });
  expect(unknown).toMatchObject({ ok: false, error: 'unknown_source_block', next_tool: 'acceptance_workspace' });
  expect(f.render).not.toHaveBeenCalled();
  expect(await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id, page_number: 3 })).toMatchObject({
    ok: false, error: 'physical_page_out_of_range', actual: { page_number: 3, page_count: 2 } });
  expect(f.controller.state().source_image_manifests).toEqual(beforeImages);
  expect(f.controller.state().requests).toEqual([]);
});

it('rejects a changed registered PDF before rendering it and never replaces its fingerprint', async () => {
  const f = await fixture(); await writeFile(f.options.originalPdf.path, '%PDF-1.4\nchanged original');
  await expect(f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id })).rejects.toThrow(/PDF.*(changed|fingerprint)/i);
  expect(f.render).not.toHaveBeenCalled(); expect(f.controller.state().publications).toEqual([]);
});

it('retains old page proofs after adding another view and detects tampering of the frozen PDF', async () => {
  const f = await fixture();
  await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id });
  const first = structuredClone(f.controller.state().source_image_manifests!);
  await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id, page_number: 1, box: [0, 0, 1, 0.5] });
  expect(f.controller.state().source_image_manifests).not.toEqual(first);
  expect((await verifySourceImages(f.controller.sourceRoot, first))[0]!.images).toHaveLength(1);
  const current = await verifySourceImages(f.controller.sourceRoot, f.controller.state().source_image_manifests);
  expect(current[0]!.images).toHaveLength(2);
  await writeFile(join(f.controller.sourceRoot, current[0]!.original_pdf!.path), '%PDF-1.4 altered frozen copy');
  await expect(f.controller.assertSources()).rejects.toThrow(/PDF fingerprint changed/);
});

it('keeps oversized renders out of the admitted image manifest instead of increasing the response allowance', async () => {
  const f = await fixture(), budget = structuredClone(f.controller.state().budget);
  f.render.mockImplementationOnce(async input => ({ ok: true, page_count: 2, image: Buffer.alloc(input.max_bytes + 1) }));
  const result = await f.controller.dispatch('open_acceptance_source_page', { source_id: f.source.source_id, block_id: f.block.id });
  expect(result).toMatchObject({ ok: false, error: 'original_page_image_too_large', recoverable_by_author: true,
    writable: expect.stringContaining('box'), next_tool: 'open_acceptance_source_page' });
  expect(f.controller.state().source_image_manifests).toBeUndefined();
  expect(f.controller.state().budget).toEqual(budget);
});

it('returns the actual original page image in the same tool result and charges it once', async () => {
  const f = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
  f.render.mockImplementationOnce(async () => ({ ok: true, page_count: 2, image: png }));
  const before = f.controller.state().budget.tool_response_bytes;
  const tool = createAcceptanceAutonomousTools(f.controller).find(row => row.name === 'open_acceptance_source_page')!;
  const result = await tool.execute('page-fixture', { source_id: f.source.source_id, block_id: f.block.id }, new AbortController().signal);
  expect(result.details).toMatchObject({ ok: true, image_attached: true });
  expect(result.content.filter(row => row.type === 'image')).toHaveLength(1);
  expect(result.details).not.toHaveProperty('next_tool', 'read');
  expect(f.controller.state().budget.tool_response_bytes - before).toBe(toolResponseBytes(result));
  expect(f.controller.state().approvals).toEqual([]);
  expect(await readFile(f.markdownPath, 'utf8')).toBe('# Synthetic [PDF p.2]\n\nDECODED BETA');
});
