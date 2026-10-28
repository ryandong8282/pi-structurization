import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, join, posix } from 'node:path';
import { sha256Json, sha256Text } from '../canonical.js';
import type { SourceLedger } from './contracts.js';

export interface SourceImageManifest {
  source_id: string;
  images: Array<{ block_id: string; reference: string; status: 'available' | 'missing' | 'unsupported'; path?: string; sha256?: string;
    pdf_page?: number; pdf_box?: PdfPageBox }>;
  original_pdf?: { path: string; sha256: string; kind: 'original_pdf' | 'converted_pdf'; page_count: number };
}
export type PdfPageBox = [number, number, number, number];
export interface OriginalPdfSource { path: string; sha256: string; kind?: 'original_pdf' | 'converted_pdf' }
export type OriginalPdfPageRenderer = (input: { pdf_path: string; page_number: number; box: PdfPageBox; max_bytes: number; signal?: AbortSignal }) => Promise<
  { ok: true; page_count: number; image: Uint8Array } | { ok: false; error: string; page_count?: number; actual?: Record<string, unknown> }>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const sourceImageManifestName = (id: string, digest: string) => `${id}.images.${digest}.json`;
const pdfPageReference = (sha: string, page: number, box: PdfPageBox) => `pdf-pages/${sha}/p${String(page).padStart(6, '0')}-${sha256Json(box).slice(0, 16)}.jpg`;
export const validPdfPageBox = (box: unknown): box is PdfPageBox => Array.isArray(box) && box.length === 4
  && box.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) && box[0] < box[2] && box[1] < box[3];
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..\\`) && !r.startsWith('../') && !isAbsolute(r); };
export function sourceImageReferences(source: SourceLedger) {
  return source.blocks.flatMap(block => [...block.text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match => ({ block_id: block.id, reference: (match[1] ?? match[2]!).replace(/^<|>$/g, '') })));
}
function localReference(reference: string): string | undefined {
  let name: string; try { name = decodeURIComponent(reference); } catch { return undefined; }
  if (/[\\\0?#]/u.test(name) || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(name)) return undefined;
  return name;
}
async function originalImage(markdownPath: string | undefined, reference: string) {
  const name = localReference(reference);
  if (!name) return { status: 'unsupported' as const };
  if (!markdownPath) return { status: 'missing' as const };
  const base = await realpath(dirname(markdownPath));
  try {
    const path = await realpath(resolve(base, name));
    if (!inside(base, path)) return { status: 'unsupported' as const };
    return { status: 'available' as const, name, bytes: await readFile(path) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' as const }; throw error; }
}
async function immutableCopy(path: string, bytes: Uint8Array): Promise<void> {
  const existingPath = await realpath(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existingPath && !inside(await realpath(dirname(path)), existingPath)) throw new Error('Source image destination symlink escapes archive directory');
  const old = await readFile(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (old && hash(old) !== hash(bytes)) throw new Error('Frozen source image changed; preserve the existing image and original version.');
  if (!old) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }); }
}

/** Copy accompanying original pixels when archiving/cloning Markdown, keeping its exact bytes and links. */
export async function copyReferencedSourceImages(source: SourceLedger, originalMarkdownPath: string, archivedMarkdownPath: string): Promise<void> {
  const target = await realpath(dirname(archivedMarkdownPath));
  for (const reference of new Set(sourceImageReferences(source).map(row => row.reference))) {
    const image = await originalImage(originalMarkdownPath, reference);
    if (image.status === 'available') {
      const destination = resolve(target, image.name);
      if (!inside(target, destination)) throw new Error('Source image archive path escapes document directory');
      // Existing parent symlinks must not redirect a copy outside the archive.
      await mkdir(dirname(destination), { recursive: true });
      if (!inside(target, await realpath(dirname(destination)))) throw new Error('Source image archive symlink escapes document directory');
      await immutableCopy(destination, image.bytes);
    }
  }
}

export async function verifySourceImages(sourceRoot: string, digests: Record<string, string> = {}): Promise<SourceImageManifest[]> {
  const manifests: SourceImageManifest[] = [];
  const base = await realpath(sourceRoot);
  for (const [id, digest] of Object.entries(digests)) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Source image manifest identity changed');
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Source image manifest fingerprint changed');
    const text = await readFile(join(base, sourceImageManifestName(id, digest)), 'utf8');
    if (sha256Text(text) !== digest) throw new Error('Source image manifest changed');
    const manifest = JSON.parse(text) as SourceImageManifest;
    if (manifest.source_id !== id || !Array.isArray(manifest.images)) throw new Error('Source image manifest changed');
    if (manifest.original_pdf) {
      const pdf = manifest.original_pdf;
      if (!/^[a-f0-9]{64}$/u.test(pdf.sha256) || pdf.path !== posix.join('assets', id, 'original-pdf', `${pdf.sha256}.pdf`)
        || !['original_pdf', 'converted_pdf'].includes(pdf.kind) || !Number.isSafeInteger(pdf.page_count) || pdf.page_count < 1) throw new Error('Original PDF manifest changed');
      const pdfPath = await realpath(resolve(base, pdf.path));
      if (!inside(base, pdfPath)) throw new Error('Frozen original PDF path escapes source; host must restore the admitted source; checkpoint and usage retained');
      const actual = hash(await readFile(pdfPath));
      if (actual !== pdf.sha256) throw new Error(`Frozen original PDF fingerprint changed: actual=${actual}, expected=${pdf.sha256}; host must restore the admitted original; author cannot edit frozen evidence; checkpoint and usage retained`);
    }
    for (const row of manifest.images.filter(row => row.status === 'available')) {
      if (row.pdf_page !== undefined && (!manifest.original_pdf || !Number.isSafeInteger(row.pdf_page) || row.pdf_page < 1
        || row.pdf_page > manifest.original_pdf.page_count || !validPdfPageBox(row.pdf_box)
        || row.reference !== pdfPageReference(manifest.original_pdf.sha256, row.pdf_page, row.pdf_box))) throw new Error('Original PDF page manifest changed');
      const name = localReference(row.reference);
      if (!name || row.path !== posix.join('assets', id, name)) throw new Error('Source image path changed');
      const path = await realpath(resolve(base, row.path));
      if (!inside(base, path) || hash(await readFile(path)) !== row.sha256) throw new Error('Frozen source image changed');
    }
    manifests.push(manifest);
  }
  return manifests;
}

/** Existing images are immutable; a previously missing local companion may become available on resume. */
export async function freezeSourceImages(sourceRoot: string, source: SourceLedger, markdownPath?: string,
  expectedDigest?: string): Promise<{ manifest: SourceImageManifest; digest: string } | undefined> {
  const references = sourceImageReferences(source);
  const old = expectedDigest ? (await verifySourceImages(sourceRoot, { [source.source_id]: expectedDigest }))[0] : undefined;
  if (!references.length && !old?.original_pdf) return undefined;
  if (markdownPath && sha256Text(await readFile(markdownPath, 'utf8')) !== source.sha256) throw new Error('Source image origin Markdown changed');
  const oldImages = old?.images.filter(row => row.pdf_page === undefined);
  if (oldImages && sha256Json(oldImages.map(({ block_id, reference }) => ({ block_id, reference }))) !== sha256Json(references)) throw new Error('Source image references changed');
  const manifest: SourceImageManifest = { source_id: source.source_id, images: [], ...(old?.original_pdf ? { original_pdf: old.original_pdf } : {}) };
  for (const [index, row] of references.entries()) {
    const image = await originalImage(markdownPath, row.reference);
    if (image.status === 'available') {
      const path = posix.join('assets', source.source_id, image.name);
      const base = await realpath(sourceRoot), destination = join(base, path);
      await mkdir(dirname(destination), { recursive: true });
      if (!inside(base, await realpath(dirname(destination)))) throw new Error('Source image destination escapes frozen directory');
      await immutableCopy(join(sourceRoot, path), image.bytes);
      manifest.images.push({ ...row, status: 'available', path, sha256: hash(image.bytes) });
    } else manifest.images.push(oldImages?.[index]?.status === 'available' ? oldImages[index]! : { ...row, status: image.status });
  }
  for (const row of old?.images.filter(row => row.pdf_page !== undefined) ?? []) {
    if (!source.blocks.some(block => block.id === row.block_id)) throw new Error('Original PDF page source block changed');
    manifest.images.push(row);
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`, digest = sha256Text(text);
  await immutableCopy(join(sourceRoot, sourceImageManifestName(source.source_id, digest)), Buffer.from(text));
  return { manifest, digest };
}

/** Freeze original pixels as a versioned companion; decoded Markdown and old manifests remain untouched. */
export async function freezeOriginalPdfPage(input: { sourceRoot: string; source: SourceLedger; block_id: string;
  original: OriginalPdfSource; page_number: number; box: PdfPageBox; max_bytes: number; renderer: OriginalPdfPageRenderer;
  expectedDigest?: string; signal?: AbortSignal }) {
  const { source, original, page_number, box } = input;
  const base = await realpath(input.sourceRoot);
  const old = input.expectedDigest ? (await verifySourceImages(base, { [source.source_id]: input.expectedDigest }))[0] : undefined;
  if (!source.blocks.some(block => block.id === input.block_id) || !validPdfPageBox(box) || !Number.isSafeInteger(page_number) || page_number < 1) throw new Error('Invalid original PDF page scope');
  if (!/^[a-f0-9]{64}$/u.test(original.sha256)) throw new Error('Original PDF fingerprint must be a SHA-256');
  if (old?.original_pdf && old.original_pdf.sha256 !== original.sha256) throw new Error(`Frozen original PDF fingerprint changed: actual=${original.sha256}, expected=${old.original_pdf.sha256}; host must restore the admitted original, never reset its proof or usage`);
  const reference = pdfPageReference(original.sha256, page_number, box);
  const cached = old?.images.find(row => row.block_id === input.block_id && row.reference === reference && row.status === 'available');
  if (cached) return { ok: true as const, manifest: old!, digest: input.expectedDigest!, image: cached, cached: true };
  const pdfBytes = await readFile(original.path);
  const actual = hash(pdfBytes);
  if (actual !== original.sha256) throw new Error(`Original PDF fingerprint changed before admission: actual=${actual}, expected=${original.sha256}; host must restore the registered original; author cannot change its fingerprint; checkpoint and usage retained`);
  if (pdfBytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Registered original is not a PDF; a converted PDF must be registered separately');
  const copy = async (path: string, bytes: Uint8Array) => {
    const destination = resolve(base, path); await mkdir(dirname(destination), { recursive: true });
    if (!inside(base, await realpath(dirname(destination)))) throw new Error('Original PDF page destination escapes frozen source');
    await immutableCopy(destination, bytes);
  };
  const pdfPath = posix.join('assets', source.source_id, 'original-pdf', `${original.sha256}.pdf`);
  await copy(pdfPath, pdfBytes); input.signal?.throwIfAborted();
  const rendered = await input.renderer({ pdf_path: resolve(base, pdfPath), page_number, box, max_bytes: input.max_bytes,
    ...(input.signal ? { signal: input.signal } : {}) });
  input.signal?.throwIfAborted();
  if (!rendered.ok) return { ok: false as const, error: rendered.error, actual: { page_number, page_count: rendered.page_count, ...rendered.actual } };
  if (!Number.isSafeInteger(rendered.page_count) || rendered.page_count < 1) throw new Error('Original PDF renderer returned an invalid page count');
  if (page_number > rendered.page_count) return { ok: false as const, error: 'physical_page_out_of_range', actual: { page_number, page_count: rendered.page_count } };
  if (old?.original_pdf && old.original_pdf.page_count !== rendered.page_count) throw new Error('Frozen original PDF page count changed');
  if (rendered.image.byteLength > input.max_bytes) return { ok: false as const, error: 'original_page_image_too_large',
    actual: { image_bytes: rendered.image.byteLength, max_image_bytes: input.max_bytes } };
  const image: SourceImageManifest['images'][number] = { block_id: input.block_id, reference, status: 'available',
    path: posix.join('assets', source.source_id, reference), sha256: hash(rendered.image), pdf_page: page_number, pdf_box: box };
  await copy(image.path!, rendered.image);
  const manifest: SourceImageManifest = { source_id: source.source_id, images: [...(old?.images ?? []), image],
    original_pdf: { path: pdfPath, sha256: original.sha256, kind: original.kind ?? 'original_pdf', page_count: rendered.page_count } };
  const text = `${JSON.stringify(manifest, null, 2)}\n`, digest = sha256Text(text);
  await immutableCopy(join(base, sourceImageManifestName(source.source_id, digest)), Buffer.from(text));
  return { ok: true as const, manifest, digest, image, cached: false };
}

/** Bind only image evidence actually consumed by this material; unrelated images cannot invalidate other lots. */
export function sourceImageProofs(material: unknown, manifests: SourceImageManifest[]): Record<string, string> | undefined {
  const blocks = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, unknown>;
    if (typeof row.source_id === 'string' && typeof row.block_id === 'string') blocks.add(`${row.source_id}:${row.block_id}`);
    Object.values(row).forEach(visit);
  };
  visit(material);
  const result = Object.fromEntries(manifests.flatMap(manifest => manifest.images.filter(row => blocks.has(`${manifest.source_id}:${row.block_id}`))
    .map(row => [`${manifest.source_id}:${row.block_id}:${row.reference}`, row.sha256 ?? row.status])));
  return Object.keys(result).length ? result : undefined;
}
