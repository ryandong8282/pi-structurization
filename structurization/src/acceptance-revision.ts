import { randomUUID } from 'node:crypto';
import { sha256Json, sha256Text } from './canonical.js';
import { chmod, cp, readFile, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { atomicWriteJson, pathExists } from './atomic.js';
import { referenceOccurrenceTargetLocator, type EvidenceManifest } from './contracts.js';
import type { FullBatchState } from './batch.js';
import { RevisionWorkspace } from './workspace.js';
import { migrateTargetSelectorPlan } from './target-selector-compiler.js';
import { selectorDeliveryPreview } from './selector-delivery-preview.js';
import type { SourceSpanRegistry } from './source-span-registry.js';
import type { AcceptanceFeedbackCandidate } from './pi-runtime.js';

const encodedSegment = (value: string): string => encodeURIComponent(value).replace(/%/gu, '_');

export async function acceptanceFeedbackCandidates(artifactRoot: string, jobId: string): Promise<AcceptanceFeedbackCandidate[]> {
  const batch = JSON.parse(await readFile(join(artifactRoot, 'jobs', encodedSegment(jobId), 'batch.json'), 'utf8')) as FullBatchState;
  return Promise.all(batch.targets.map(async target => {
    const workspace = await RevisionWorkspace.openRevision(artifactRoot, jobId, target.target_id, target.revision);
    const selectors = migrateTargetSelectorPlan(JSON.parse(await readFile(workspace.sealedSelectorPath, 'utf8')));
    const evidence = await workspace.readEvidenceManifest();
    return { target_id: target.target_id, name: target.name ?? target.heading ?? target.target_id,
      item_names: selectors.items.map(item => item.name_path?.join(' / ') ?? item.name),
      shared_reference_keys: [...new Set(evidence.reference_occurrences.map(occurrence => referenceOccurrenceTargetLocator(occurrence)))],
    };
  }));
}

/** A dialogue round gets an independent artifact root; prior sealed bytes remain untouched. */
export async function cloneAcceptanceRevision(sourceRoot: string, destinationRoot: string, jobId: string, targetIds: string[]): Promise<void> {
  const from = resolve(sourceRoot), to = resolve(destinationRoot);
  if (from === to || !relative(from, to).startsWith('..') || !relative(to, from).startsWith('..')) throw new Error('Invalid revision artifact roots');
  const batchFolder = () => join(stage, 'jobs', encodedSegment(jobId));
  const oldBatchFolder = join(from, 'jobs', encodedSegment(jobId));
  const before = JSON.parse(await readFile(join(oldBatchFolder, 'batch.json'), 'utf8')) as FullBatchState;
  if (before.status !== 'passed') throw new Error('Dialogue revision requires a completed batch');
  const known = new Set(before.targets.map(target => target.target_id));
  if (!targetIds.length || targetIds.some(id => !known.has(id))) throw new Error('Invalid revision target IDs');
  const parent = dirname(to);
  const fingerprint = sha256Json({ source_batch_sha256: sha256Text(await readFile(join(oldBatchFolder, 'batch.json'), 'utf8')), jobId, target_ids: [...targetIds].sort() });
  const marker = async (root: string) => {
    try { return (JSON.parse(await readFile(join(root, 'dialogue-revision.json'), 'utf8')) as { fingerprint: string }).fingerprint === fingerprint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (await marker(to)) return;
  const transactionPath = join(parent, 'acceptance-revision-transaction.json');
  const safeTransactionPath = (name: string, prefix: string): string => {
    if (basename(name) !== name || !name.startsWith(prefix)) throw new Error('Invalid revision transaction path');
    const path = resolve(parent, name);
    if (relative(parent, path).startsWith('..') || dirname(path) !== parent) throw new Error('Revision transaction escapes destination job');
    return path;
  };
  const handoff = async (stage: string, backup: string) => {
    if (await pathExists(to)) {
      const names = await readdir(to);
      if (names.some(name => name !== 'input.json')) throw new Error('Destination already has unrelated Pi artifacts');
      await rename(to, backup);
    }
    await rename(stage, to);
  };
  if (await pathExists(transactionPath)) {
    const transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as { fingerprint: string; staging: string; backup: string };
    if (transaction.fingerprint !== fingerprint) throw new Error('Revision transaction scope changed');
    const oldStage = safeTransactionPath(transaction.staging, 'pi-agent-revision-');
    const oldBackup = safeTransactionPath(transaction.backup, 'pi-agent-preparation-');
    if (await marker(oldStage)) { await handoff(oldStage, oldBackup); return; }
    if (!await pathExists(to) && await pathExists(oldBackup)) await rename(oldBackup, to);
  }
  const stage = safeTransactionPath('pi-agent-revision-' + randomUUID(), 'pi-agent-revision-');
  const backup = safeTransactionPath('pi-agent-preparation-' + randomUUID(), 'pi-agent-preparation-');
  await atomicWriteJson(transactionPath, { fingerprint, staging: basename(stage), backup: basename(backup) });
  await cp(from, stage, { recursive: true, force: false, errorOnExist: true,
    filter: source => basename(source) !== 'batch-writer.sqlite'
      && basename(source) !== 'batch-writer.sqlite-journal'
      && resolve(source) !== resolve(oldBatchFolder, 'hierarchy')
      && resolve(source) !== resolve(from, 'dialogue-revision.json')
      && resolve(source) !== resolve(from, 'input.json'),
  });
  const mappedPath = (path: string): string => {
    const suffix = relative(from, path);
    if (suffix.startsWith('..')) throw new Error('Revision workspace escapes its source root');
    return resolve(to, suffix);
  };
  const selected = new Set(targetIds);
  for (const target of before.targets) {
    if (target.workdir) target.workdir = mappedPath(target.workdir);
    if (!selected.has(target.target_id)) continue;
    const previous = await RevisionWorkspace.openRevision(stage, jobId, target.target_id, target.revision);
    const protocol = (await previous.readState()).target_review_protocol;
    const revision = await RevisionWorkspace.reviseFromSealed(stage, jobId, target.target_id, target.revision);
    await revision.updateState(state => {
      if (protocol) state.target_review_protocol = protocol;
      state.selector_stage = 'primary';
    });
    target.revision = revision.revision;
    target.workdir = resolve(to, relative(stage, revision.root));
    target.status = 'pending';
    target.error = '';
    delete target.last_failure_class;
    delete target.last_blocker_code;
    if (target.attempt_counters) {
      for (const key of Object.keys(target.attempt_counters) as Array<keyof typeof target.attempt_counters>) target.attempt_counters[key] = 0;
    }
  }
  if (before.discovery) before.discovery.workdir = mappedPath(before.discovery.workdir);
  before.status = 'running';
  delete before.waiting_for_source;
  for (const file of ['batch.json', 'result.json', 'receipt.json']) {
    const path = join(batchFolder(), file);
    if (await pathExists(path)) await chmod(path, 0o644);
  }
  await atomicWriteJson(join(batchFolder(), 'batch.json'), before);
  const previousHierarchy = join(oldBatchFolder, 'hierarchy', 'editor-hierarchy-plan.json');
  if (await pathExists(previousHierarchy)) await cp(previousHierarchy, join(batchFolder(), 'dialogue-hierarchy-baseline.json'));
  if (await pathExists(join(to, 'input.json'))) await cp(join(to, 'input.json'), join(stage, 'input.json'));
  await atomicWriteJson(join(stage, 'dialogue-revision.json'), { fingerprint });
  await handoff(stage, backup);
}

export async function acceptanceCandidatePreview(artifactRoot: string, jobId: string, selectedTargetId?: string, cursor = 0) {
  const batchPath = join(artifactRoot, 'jobs', encodedSegment(jobId), 'batch.json');
  if (!(await pathExists(batchPath))) return { targets: [], items: [], next_cursor: null, status: 'pending' };
  const batch = JSON.parse(await readFile(batchPath, 'utf8')) as FullBatchState;
  const targets = batch.targets.map(target => ({ target_id: target.target_id, name: target.name ?? target.heading ?? target.target_id,
    status: target.status, item_count: target.row_count }));
  const target = batch.targets.find(row => row.target_id === selectedTargetId)
    ?? batch.targets.find(row => row.status === 'sealed' || row.status === 'running') ?? batch.targets[0];
  if (!target?.revision) return { targets, items: [], next_cursor: null, status: batch.status };
  const workspace = await RevisionWorkspace.openRevision(artifactRoot, jobId, target.target_id, target.revision);
  const references = (await workspace.readEvidenceManifest()).reference_occurrences.filter(reference => reference.external_standard)
    .map(reference => ({ occurrence_id: reference.occurrence_id, raw_reference: reference.raw_reference, external_standard: reference.external_standard }));
  if (target.status === 'sealed') {
    const result = JSON.parse(await readFile(workspace.resultPath, 'utf8')) as { inspection_lots: Array<{ items: Array<Record<string, unknown>> }> };
    const all = result.inspection_lots.flatMap(lot => lot.items);
    const items = all.slice(cursor, cursor + 40).map(item => ({ item_id: String(item.item_id), item_key: String(item.item_id),
      name: String(item.name ?? ''), fields: Object.fromEntries(['name', 'requirement', 'method', 'quantity', 'note']
        .map(field => [field, { actual_value: String(item[field] ?? ''), actual_value_complete: true, actual_value_available: true }])),
      table_semantics: item.table_semantics ?? null, inline_references: item.inline_references ?? [],
    }));
    return { targets, target_id: target.target_id, items, external_references: references, total: all.length,
      next_cursor: cursor + items.length < all.length ? cursor + items.length : null, status: 'sealed_candidate' };
  }
  if (!(await pathExists(workspace.workingSelectorPath))) return { targets, target_id: target.target_id, items: [], next_cursor: null, status: 'pending' };
  const selectors = migrateTargetSelectorPlan(JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8')));
  const [registry, evidence, state] = await Promise.all([
    workspace.readSourceSpanRegistry(), workspace.readEvidenceManifest(), workspace.readState(),
  ]) as [SourceSpanRegistry, EvidenceManifest, Awaited<ReturnType<typeof workspace.readState>>];
  const page = selectors.items.slice(cursor, cursor + 40);
  const preview = selectorDeliveryPreview(selectors, registry, evidence.evidence, new Set(page.map(item => item.key)), new Set(state.opened_evidence_ids));
  const byKey = new Map(preview.items.map(item => [item.item_key, item]));
  return { targets, target_id: target.target_id, external_references: references,
    items: page.map(item => ({ name: item.name_path?.join(' / ') ?? item.name,
      ...(byKey.get(item.key) ?? { item_key: item.key, fields: {}, table_pending: true }), table_semantics: null })),
    total: selectors.items.length, next_cursor: cursor + page.length < selectors.items.length ? cursor + page.length : null,
    status: 'working_candidate' };
}
