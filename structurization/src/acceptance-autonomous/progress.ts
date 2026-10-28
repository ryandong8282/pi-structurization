import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { sha256Text } from '../canonical.js';
import type { AcceptanceCheckpoint, AcceptanceDelivery, SourceLedger } from './contracts.js';
import { parseAcceptanceDelivery } from './schema.js';
import { verifySourceQuote } from './source-ledger.js';
import { groupReviewFingerprint, sampleReviewMaterial } from './review.js';
import { sourceImageManifestName, sourceImageProofs, type SourceImageManifest } from './source-images.js';
import { readLotSplitHandoff, mapSplitCandidates } from './lot-split-handoff.js';

export interface AutonomousAcceptanceProgress {
  draft_state: 'readable' | 'missing' | 'invalid';
  split?: { total: number; candidates: number; pending: number; conflicts: number; source_blocks: number };
  source: { total: number; processed: number; pending: number; lot: number; shared: number; not_extractable: number };
  extraction: { lots: number; items: number; running: number; queued: number; completed: number; failed: number; concurrency: number };
  review: { groups: number; approved_groups: number; pending_groups: number; approved_lots: number; running: number; queued: number; historical_requests: number; historical_failed: number };
  publication: { state: 'unpublished' | 'sealed' | 'materialized' | 'published' | 'mismatch'; fingerprint?: string; completion?: 'partial' | 'complete'; lots: number; remaining_lots: number };
  history: { session_starts: number; tool_response_bytes: number };
}

/** Read-only projection. Processed source dispositions are draft coverage, never semantic approval. */
export async function readAutonomousAcceptanceProgress(root: string, active = true): Promise<AutonomousAcceptanceProgress | null> {
  let checkpoint: AcceptanceCheckpoint;
  try { checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const sources = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8')).sources as SourceLedger[];
  const source = sources.find(row => row.source_id === checkpoint.source_sha256)!;
  let draft_state: AutonomousAcceptanceProgress['draft_state'] = 'missing';
  const text = await readFile(join(root, 'work', 'DELIVERY.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  let delivery: AcceptanceDelivery | undefined;
  if (text !== undefined) {
    try { delivery = parseAcceptanceDelivery(JSON.parse(text)).delivery; } catch { /* Partial author save. */ }
    draft_state = delivery?.source_sha256 === source.sha256 ? 'readable' : 'invalid';
  }
  if (draft_state !== 'readable') delivery = undefined;
  const count = { total: source.blocks.length, processed: 0, pending: source.blocks.length, lot: 0, shared: 0, not_extractable: 0 };
  const dispositions = new Map<string, NonNullable<typeof delivery>['dispositions']>();
  for (const row of delivery?.dispositions ?? []) if (row.source_id === source.source_id) dispositions.set(row.block_id, [...(dispositions.get(row.block_id) ?? []), row]);
  for (const block of source.blocks) {
    const rows = dispositions.get(block.id), row = rows?.[0];
    if (rows?.length !== 1 || !row || row.role === 'unresolved' || !row.reason.trim() || !row.evidence.length
      || row.evidence.some(quote => !verifySourceQuote(sources, quote))
      || (row.role === 'lot' && (!row.lot_ids.length || row.lot_ids.some(id => !delivery?.lots.some(lot => lot.id === id && lot.scope.block_ids.includes(block.id)))))) continue;
    count[row.role]++; count.processed++; count.pending--;
  }
  const workRoot = join(root, 'work'), manifests: SourceImageManifest[] = [];
  for (const [id, hash] of Object.entries(checkpoint.source_image_manifests ?? {})) {
    manifests.push(JSON.parse(await readFile(join(workRoot, 'source', sourceImageManifestName(id, hash)), 'utf8')));
  }
  const files = new Map<string, string>();
  for (const name of new Set(delivery?.rules.flatMap(rule => rule.method_files) ?? [])) {
    try {
      const path = await realpath(resolve(workRoot, name)), rel = relative(await realpath(workRoot), path);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Method path escapes job');
      files.set(name, sha256Text(await readFile(path, 'utf8')));
    } catch { files.set(name, 'unreadable'); }
  }
  const candidate = delivery;
  const approved = candidate?.groups.filter(group => {
    const methods = Object.fromEntries(candidate.rules.filter(rule => group.rule_ids.includes(rule.id)).flatMap(rule => rule.method_files).map(name => [name, files.get(name)!]));
    const images = sourceImageProofs(sampleReviewMaterial(candidate, group, group.lot_ids), manifests);
    const fingerprint = groupReviewFingerprint(candidate, group, methods, images);
    return checkpoint.approvals.some(receipt => receipt.group_id === group.id && receipt.fingerprint === fingerprint);
  }) ?? [];
  const extraction = checkpoint.requests.filter(row => row.kind === 'extraction'), reviews = checkpoint.requests.filter(row => row.kind !== 'extraction');
  const activity = JSON.parse(await readFile(join(root, 'parallel-activity.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const last = checkpoint.publications.at(-1);
  const handoff = await readLotSplitHandoff(root, source);
  const split = handoff ? mapSplitCandidates(handoff, source, delivery) : undefined;
  return { draft_state, source: count,
    ...(split ? { split: { total: split.length, candidates: split.filter(row => row.status === 'candidate').length,
      pending: split.filter(row => row.status === 'pending').length, conflicts: split.filter(row => row.status === 'conflict').length, source_blocks: source.blocks.length } } : {}),
    extraction: { lots: delivery?.lots.length ?? 0, items: delivery?.lots.reduce((sum, lot) => sum + lot.items.length, 0) ?? 0,
      running: active ? extraction.filter(row => row.status === 'running').length : 0, queued: active ? activity.extraction?.queued ?? 0 : 0,
      completed: extraction.filter(row => row.extraction?.merged).length, failed: extraction.filter(row => row.status === 'failed').length, concurrency: checkpoint.budget.concurrency },
    review: { groups: delivery?.groups.length ?? 0, approved_groups: approved.length, pending_groups: (delivery?.groups.length ?? 0) - approved.length,
      approved_lots: delivery?.lots.filter(lot => approved.some(group => group.id === lot.group_id)).length ?? 0,
      running: active ? reviews.filter(row => row.status === 'running').length : 0, queued: active ? activity.review?.queued ?? 0 : 0,
      historical_requests: reviews.length, historical_failed: reviews.filter(row => row.status === 'failed').length },
    publication: { state: last ? 'sealed' : 'unpublished', ...(last ? { completion: last.status, fingerprint: last.fingerprint } : {}), lots: last?.lot_ids.length ?? 0,
      remaining_lots: Math.max(0, (delivery?.lots.length ?? 0) - (last?.lot_ids.length ?? 0)) },
    history: { session_starts: checkpoint.budget.attempts, tool_response_bytes: checkpoint.budget.tool_response_bytes } };
}
