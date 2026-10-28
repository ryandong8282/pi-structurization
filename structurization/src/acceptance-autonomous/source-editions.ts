import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { sha256Json } from '../canonical.js';
import { validateOfficialEditionRecord, verifyExternalEditionProof, type ExternalEditionProof, type FrozenEditionProof, type OfficialEditionRecord } from '../external-source-edition.js';
import { declaredStandardNo } from '../external-source-workflow.js';
import type { SourceLedger } from './contracts.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function assetsRoot(sourceRoot: string): Promise<string> {
  const base = await realpath(sourceRoot), folder = join(base, 'edition-proofs');
  await mkdir(folder, { recursive: true });
  const path = await realpath(folder), rel = relative(base, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Edition proof path escapes frozen sources');
  return path;
}
async function immutable(folder: string, name: string, bytes: Uint8Array): Promise<void> {
  const path = join(folder, name);
  const old = await readFile(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (old && hash(old) !== hash(bytes)) throw new Error('Frozen edition proof changed');
  if (!old) await writeFile(path, bytes, { flag: 'wx' });
}
export async function freezeEditionProof(sourceRoot: string, proof: ExternalEditionProof, sourceId: string, publicationSourceId: string): Promise<FrozenEditionProof> {
  await verifyExternalEditionProof(proof, proof.record.standard_no);
  const folder = await assetsRoot(sourceRoot);
  await immutable(folder, proof.record_sha256 + '.json', Buffer.from(JSON.stringify(proof.record, null, 2)));
  await immutable(folder, proof.record.original_pdf_sha256 + '.pdf', await readFile(proof.original_pdf_path));
  return { source_id: sourceId, publication_source_id: publicationSourceId, record_sha256: proof.record_sha256,
    original_pdf_sha256: proof.record.original_pdf_sha256, standard_no: proof.record.standard_no };
}
/** Source provenance survives reference deletion, renaming and same-document navigation. */
export function editionCatalog(proofs: Iterable<FrozenEditionProof | undefined>): Record<string, FrozenEditionProof> {
  const result: Record<string, FrozenEditionProof> = {};
  for (const proof of proofs) if (proof) result[sha256Json(proof)] = proof;
  return result;
}
export function assertEditionProofPresent(sourceId: string, markdown: string, rootSourceId: string, proofs: Record<string, FrozenEditionProof>): void {
  if (sourceId !== rootSourceId && !declaredStandardNo(markdown) && !Object.values(proofs).some(proof => proof.source_id === sourceId)) {
    throw new Error('Source edition provenance missing; restore the original host-owned edition proof, not the frozen source text.');
  }
}
export function referencedSourceIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'source_id' && typeof child === 'string') ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return ids;
}
export async function verifyFrozenEditionProofs(sourceRoot: string, proofs: Record<string, FrozenEditionProof> = {}, sources: SourceLedger[]): Promise<void> {
  if (!Object.keys(proofs).length) return;
  const folder = await assetsRoot(sourceRoot);
  for (const proof of Object.values(proofs)) {
    if (![proof.record_sha256, proof.original_pdf_sha256, proof.source_id, proof.publication_source_id].every(value => /^[a-f0-9]{64}$/u.test(value))) throw new Error('Frozen edition proof fingerprint changed');
    for (const name of [proof.record_sha256 + '.json', proof.original_pdf_sha256 + '.pdf']) {
      const rel = relative(folder, await realpath(join(folder, name)));
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Frozen edition proof path changed');
    }
    const record = JSON.parse(await readFile(join(folder, proof.record_sha256 + '.json'), 'utf8')) as OfficialEditionRecord;
    const publication = sources.find(source => source.source_id === proof.publication_source_id);
    if (validateOfficialEditionRecord(record, proof.standard_no) !== proof.record_sha256
      || record.original_pdf_sha256 !== proof.original_pdf_sha256
      || !sources.some(source => source.source_id === proof.source_id)
      || !publication || hash(Buffer.from(record.publication_markdown)) !== publication.sha256) throw new Error('Frozen edition proof record changed');
    await verifyExternalEditionProof({ record, record_sha256: proof.record_sha256, original_pdf_path: join(folder, proof.original_pdf_sha256 + '.pdf') }, proof.standard_no);
  }
}

export function inventoryEvidenceFingerprint(delivery: string, images?: Record<string, string>, editions?: Record<string, FrozenEditionProof>): string {
  return images || editions ? sha256Json({ delivery, ...(images ? { images } : {}), ...(editions ? { editions } : {}) }) : delivery;
}
