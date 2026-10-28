import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Json, sha256Text } from '../canonical.js';
import type { AcceptanceCheckpoint, AcceptanceDelivery, AcceptanceGroup, SourceLedger } from './contracts.js';
import { sampleReviewMaterial } from './review.js';

export type TrainingDeclaration = NonNullable<AcceptanceCheckpoint['training_declarations']>[number];
export const TRAINING_INITIALIZATION_FILE = 'training-declaration-initialization.json';

export function sourceExposures(delivery: AcceptanceDelivery, source: SourceLedger, ids?: string[]): TrainingDeclaration[] {
  const blocks = new Set(source.blocks.map(block => block.id));
  return delivery.lots.filter(lot => !ids || ids.includes(lot.id)).map(lot => ({ lot_id: lot.id,
    block_ids: [...new Set(lot.scope.block_ids.filter(id => blocks.has(id)))].sort() }));
}

export function declaredTraining(delivery: AcceptanceDelivery, source: SourceLedger): TrainingDeclaration[] {
  if (delivery.source_sha256 !== source.sha256) return [];
  const ids = [...new Set(delivery.groups.flatMap(group => sampleReviewMaterial(delivery, group,
    [...group.trial_lot_ids, ...group.boundary_lot_ids]).lots.map(lot => lot.id)))];
  return sourceExposures(delivery, source, ids);
}

export function appendTrainingDeclarations(history: TrainingDeclaration[], additions: TrainingDeclaration[]): boolean {
  const before = history.length;
  const keys = new Set(history.map(row => sha256Json(row)));
  for (const row of additions) if (!keys.has(sha256Json(row))) { keys.add(sha256Json(row)); history.push(row); }
  return history.length > before;
}

export function trainingLotIds(delivery: AcceptanceDelivery, group: AcceptanceGroup, seen: TrainingDeclaration[]): string[] {
  const ids = new Set(seen.map(row => row.lot_id)), blocks = new Set(seen.flatMap(row => row.block_ids));
  const declared = sampleReviewMaterial(delivery, group, [...group.trial_lot_ids, ...group.boundary_lot_ids]).lots.map(lot => lot.id);
  return [...new Set([...declared, ...delivery.lots.filter(lot => group.lot_ids.includes(lot.id)
    && (ids.has(lot.id) || lot.scope.block_ids.some(id => blocks.has(id)))).map(lot => lot.id)])];
}

/** The legacy barrier is audited separately; original requests, approvals and counters stay intact. */
export async function verifyTrainingDeclarationHistory(root: string, state: AcceptanceCheckpoint, source: SourceLedger): Promise<void> {
  const history = state.training_declarations;
  const known = new Set(source.blocks.map(block => block.id));
  if (!Array.isArray(history) || history.some(row => !row || typeof row.lot_id !== 'string' || !Array.isArray(row.block_ids)
    || row.block_ids.some(id => !known.has(id))) || new Set(history.map(row => sha256Json(row))).size !== history.length) {
    throw new Error('training_declaration_history_changed: restore host-owned declaration history; author files cannot repair it.');
  }
  if (!state.training_declaration_initialization) return;
  const text = await readFile(join(root, TRAINING_INITIALIZATION_FILE), 'utf8');
  if (sha256Text(text) !== state.training_declaration_initialization.audit_sha256) throw new Error('training_declaration_history_changed: initialization audit hash differs; host-owned history cannot be rewritten.');
  const audit = JSON.parse(text);
  if (audit.version !== 1 || typeof audit.original_checkpoint_text !== 'string' || typeof audit.original_delivery_text !== 'string'
    || !Array.isArray(audit.initial_declarations)) throw new Error('training_declaration_history_changed: invalid initialization audit.');
  const original = JSON.parse(audit.original_checkpoint_text) as AcceptanceCheckpoint;
  const delivery = JSON.parse(audit.original_delivery_text) as AcceptanceDelivery;
  if (sha256Text(text) !== state.training_declaration_initialization.audit_sha256 || audit.version !== 1
    || sha256Text(audit.original_checkpoint_text) !== audit.original_checkpoint_sha256
    || sha256Text(audit.original_delivery_text) !== audit.original_delivery_sha256
    || original.source_sha256 !== source.sha256 || delivery.source_sha256 !== source.sha256
    || original.training_declarations !== undefined
    || sha256Json(audit.initial_declarations) !== sha256Json(sourceExposures(delivery, source))
    || sha256Json(history.slice(0, audit.initial_declarations.length)) !== sha256Json(audit.initial_declarations)
    || ['tool_response_bytes', 'observed_context_tokens', 'attempts'].some(key => state.budget[key as keyof typeof state.budget] < original.budget[key as keyof typeof state.budget])
    || original.requests.some((request, index) => state.requests[index]?.id !== request.id
      || state.requests[index]!.attempts < request.attempts
      || (state.requests[index]!.tool_response_bytes ?? 0) < (request.tool_response_bytes ?? 0))) {
    throw new Error('training_declaration_history_changed: initialization audit or original accounting no longer matches; preserve and restore the original history.');
  }
}
