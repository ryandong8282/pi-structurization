import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Text } from '../canonical.js';
import type { GroupReviewRequest } from './contracts.js';
import { reviewQuoteBlocks } from './review.js';
import { reviewEvidenceId } from './review-evidence.js';

/** Exact frozen blocks for the selected review, never an author's rewritten summary. */
export async function freezeReviewContexts(request: GroupReviewRequest, directory: string) {
  const coordinates = reviewQuoteBlocks([request.rules, request.lots, request.references, request.failure_checks]);
  const selected = new Set(request.lots.flatMap(lot => lot.scope.block_ids));
  const context = new Set((request.source_context ?? []).map(row => `${row.source_id}:${row.block_id}`));
  await mkdir(join(directory, 'source-context'), { recursive: true });
  return Promise.all(request.sources.map(async source => {
    const blocks = source.blocks.filter(block => request.phase === 'inventory' || selected.has(block.id)
      || coordinates.has(`${source.source_id}:${block.id}`) || context.has(`${source.source_id}:${block.id}`));
    const text = JSON.stringify({ schema_version: 'acceptance-review-source-context/v2', source_id: source.source_id,
      source_sha256: source.sha256, selection: request.phase === 'inventory' ? 'whole_source' : 'selected_review_and_context',
      total_source_blocks: source.blocks.length, blocks: blocks.map(block => ({ evidence_id: reviewEvidenceId(source, block), ...block })) }, null, 2) + '\n';
    const hash = sha256Text(text), path = join(directory, 'source-context', `${source.source_id}-${hash}.json`);
    const previous = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (previous !== undefined && previous !== text) throw new Error('Frozen review source context changed; preserve the original evidence.');
    if (previous === undefined) await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    return { source_id: source.source_id, path: await realpath(path), sha256: hash, block_ids: blocks.map(block => block.id) };
  }));
}
