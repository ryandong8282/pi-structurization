import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256Json } from '../canonical.js';
import type { AcceptanceDelivery, AcceptanceGroup, AutonomousWorkRequest, GroupReviewRequest, SampleReviewReceipt } from './contracts.js';
import { focusedReviewRules, sampleReceiptAccepted, sampleReviewMaterial } from './review.js';
import { sourceImageManifestName, sourceImageProofs, verifySourceImages, type SourceImageManifest } from './source-images.js';
import { receiptPostdatesFailures, reviewObligations } from './review-plan.js';
import { reviewFailureChecks, requestResolvesFailures } from './review-failures.js';

/** Actual reviewed business facts are separate from the program that produced them. */
export function reviewedFacts(delivery: AcceptanceDelivery, group: AcceptanceGroup, id: string) {
  const material = sampleReviewMaterial(delivery, group, [id]);
  const parserRules = new Set(delivery.rules.filter(rule => !rule.relationship).map(rule => rule.id));
  const lots = material.lots.map(({ group_id: _group, scope, dependency_ids, items, ...lot }) => ({ ...lot,
    scope: { block_ids: scope.block_ids, evidence: scope.evidence }, dependency_ids: dependency_ids.filter(id => !parserRules.has(id)),
    items: items.map(item => ({ ...item, rule_ids: item.rule_ids.filter(id => !parserRules.has(id)) })) }));
  const selected = new Set(material.lots.map(lot => lot.id));
  const rules = focusedReviewRules(delivery, material.lots, material.references, material.rules, [])
    .filter(rule => rule.relationship).map(({ method_files: _methods, relationship, ...rule }) => ({ ...rule,
      relationship: { ...relationship!, objects: relationship!.objects.filter(id => selected.has(id)) } }));
  return { source_sha256: delivery.source_sha256, lots, rules, references: material.references,
    dispositions: material.dispositions.map(({ reason: _reason, ...row }) => row) };
}

export function reviewedFactsFingerprint(delivery: AcceptanceDelivery, group: AcceptanceGroup, id: string, images: SourceImageManifest[]) {
  const facts = reviewedFacts(delivery, group, id);
  return sha256Json({ protocol: 'acceptance-reviewed-facts/v1', ...facts, images: sourceImageProofs(facts, images) });
}

/** Old inputs and immutable image versions stay untouched; unavailable provenance never grants reuse. */
export async function readReviewFactFingerprints(root: string, request: AutonomousWorkRequest, sourceHash: string): Promise<Record<string, string> | undefined> {
  if (request.sample_fact_fingerprints) return request.sample_fact_fingerprints;
  if (!/^review:[a-f0-9]{24}$/u.test(request.id) || !request.sample_fingerprints) return undefined;
  const name = request.id.replace(':', '_');
  let input: GroupReviewRequest, view: { sources: Array<{ source_id: string; images?: string }> };
  try {
    input = JSON.parse(await readFile(join(root, 'reviews', `${name}.input.json`), 'utf8'));
    view = JSON.parse(await readFile(join(root, 'review-sessions', name, 'request.json'), 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (input.id !== request.id || input.fingerprint !== request.fingerprint || !input.sample_fingerprints || !input.sources.some(source => source.sha256 === sourceHash)
    || sha256Json(input.sample_fingerprints) !== sha256Json(request.sample_fingerprints) || !Array.isArray(view.sources)) return undefined;
  const sourceRoot = await realpath(join(root, 'work', 'source')), digests: Record<string, string> = {};
  for (const row of view.sources.filter(row => row.images)) {
    const digest = basename(row.images!).match(/\.images\.([a-f0-9]{64})\.json$/u)?.[1];
    if (!digest || await realpath(row.images!) !== await realpath(join(sourceRoot, sourceImageManifestName(row.source_id, digest)))) return undefined;
    digests[row.source_id] = digest;
  }
  const images = await verifySourceImages(sourceRoot, digests);
  const delivery: AcceptanceDelivery = { schema_version: 'acceptance-autonomous-delivery/v1', source_sha256: sourceHash,
    lots: input.lots, groups: [input.group], rules: input.rules, references: input.references, dispositions: input.dispositions, problems: [] };
  return Object.fromEntries(input.lots.map(lot => [lot.id, reviewedFactsFingerprint(delivery, input.group, lot.id, images)]));
}

export type FactReviewReceipt = SampleReviewReceipt & { facts_fingerprint: string };

/** Resolving a failure needs a later explicit pass on identical current facts, never just an old group approval. */
export async function failureReviewPlan(root: string, delivery: AcceptanceDelivery, requests: AutonomousWorkRequest[], receipts: SampleReviewReceipt[],
  images: SourceImageManifest[], cache = new Map<string, Record<string, string> | undefined>(), explicit = false, includeInventory = false) {
  const obligations = await reviewObligations(root, delivery, requests, includeInventory), resolutions: FactReviewReceipt[] = [];
  const checks = explicit ? reviewFailureChecks(requests, obligations, delivery.lots.map(lot => lot.id)) : [];
  for (const lotId of new Set(obligations.flatMap(row => row.current_lot_ids))) {
    const group = delivery.groups.find(group => group.lot_ids.includes(lotId));
    if (!group) continue;
    const fingerprint = reviewedFactsFingerprint(delivery, group, lotId, images);
    for (const receipt of [...receipts].reverse().filter(row => row.lot_id === lotId)) {
      if (!sampleReceiptAccepted(receipt, requests) || !receiptPostdatesFailures(receipt.request_id, lotId, requests, obligations)) continue;
      if (explicit && !requestResolvesFailures(requests.find(row => row.id === receipt.request_id)!, checks, lotId)) continue;
      if (!cache.has(receipt.request_id)) cache.set(receipt.request_id, await readReviewFactFingerprints(root, requests.find(row => row.id === receipt.request_id)!, delivery.source_sha256));
      if (cache.get(receipt.request_id)?.[lotId] === fingerprint) {
        resolutions.push({ ...receipt, facts_fingerprint: fingerprint }); break;
      }
    }
  }
  const resolved = new Set(resolutions.map(row => row.lot_id));
  return { obligations, resolutions,
    unresolved: obligations.filter(row => row.missing_block_ids.length || !row.current_lot_ids.length || row.current_lot_ids.some(id => !resolved.has(id))) };
}
