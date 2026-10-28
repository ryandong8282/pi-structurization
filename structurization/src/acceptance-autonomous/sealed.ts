import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { sha256Json, sha256Text } from '../canonical.js';
import { strictJsonParse } from '../strict-json.js';
import type { AcceptanceCheckpoint, AcceptanceDelivery, AcceptanceIssue, SourceLedger } from './contracts.js';
import { eligibleLotIds, validateAcceptanceDelivery, type ValidationContext } from './validation.js';
import { buildAcceptanceSourceLedger } from './source-ledger.js';
import { groupReviewFingerprint, reviewExposures, reviewSubmissionIssues, sampleReceiptAccepted, sampleReviewFingerprint, sampleReviewMaterial, trialReviewGroup } from './review.js';
import { trainingLotIds, verifyTrainingDeclarationHistory } from './training-history.js';
import { reviewObligations, requiredReviewLotIds, receiptPostdatesFailures } from './review-plan.js';
import { failureReviewPlan } from './review-facts.js';
import { inventoryFailureChecks, reviewFailureChecks, requestResolvesFailures } from './review-failures.js';
import { readLotSplitHandoff, splitDeliveryIssues } from './lot-split-handoff.js';
import { verifySourceImages, sourceImageProofs } from './source-images.js';

import type { FrozenEditionProof } from '../external-source-edition.js';
import { editionCatalog, assertEditionProofPresent, referencedSourceIds, verifyFrozenEditionProofs, inventoryEvidenceFingerprint } from './source-editions.js';

export interface AutonomousSealedDelivery {
  schema_version: 'acceptance-autonomous-sealed/v1';
  fingerprint: string;
  status: 'partial' | 'complete';
  source_sha256: string;
  lot_ids: string[];
  delivery: AcceptanceDelivery;
  issues: AcceptanceIssue[];
  reviews: AcceptanceCheckpoint['requests'];
  approvals: AcceptanceCheckpoint['approvals'];
  inventory_request_id: string;
  review_protocol_version?: 2 | 3 | 4;
  review_failure_policy?: 'explicit/v1';
  training_declarations?: AcceptanceCheckpoint['training_declarations'];
  source_image_manifests?: Record<string, string>;
  source_edition_proofs?: Record<string, FrozenEditionProof>;
  lot_split_sha256?: string;
}

/** Re-validate controller-owned provenance before ProductStore can accept any materialized bytes. */
export async function verifyAutonomousSealedDelivery(path: string, expectedSourceHash: string): Promise<AutonomousSealedDelivery> {
  const sealed = strictJsonParse(await readFile(path, 'utf8')) as AutonomousSealedDelivery;
  if (sealed.schema_version !== 'acceptance-autonomous-sealed/v1' || sealed.source_sha256 !== expectedSourceHash) throw new Error('Autonomous seal source/version mismatch');
  if (sealed.review_protocol_version !== undefined && ![2, 3, 4].includes(sealed.review_protocol_version)) throw new Error('Unsupported autonomous review protocol');
  const root = dirname(dirname(path));
  const state = strictJsonParse(await readFile(join(root, 'checkpoint.json'), 'utf8')) as AcceptanceCheckpoint;
  const publication = state.publications.find(row => row.fingerprint === sealed.fingerprint && sha256Json(row.lot_ids) === sha256Json(sealed.lot_ids) && row.status === sealed.status);
  if (!publication) throw new Error('Delivery is not a controller checkpoint publication');
  if (publication.review_failure_policy !== sealed.review_failure_policy
    || (sealed.review_failure_policy && sealed.review_failure_policy !== 'explicit/v1')) throw new Error('Historical failure policy cannot be downgraded');
  if (publication.lot_split_sha256 !== sealed.lot_split_sha256) throw new Error('Split publication provenance changed');
  if (sha256Json(publication.source_image_manifests ?? {}) !== sha256Json(sealed.source_image_manifests ?? {})) throw new Error('Source image provenance changed');
  if (sha256Json(publication.source_edition_proofs ?? {}) !== sha256Json(sealed.source_edition_proofs ?? {})) throw new Error('Source edition provenance changed');
  const images = await verifySourceImages(join(root, 'work', 'source'), sealed.source_image_manifests);
  if (publication.review_protocol_version && publication.review_protocol_version >= 3 && sealed.review_protocol_version !== publication.review_protocol_version) throw new Error('Training declaration provenance cannot be downgraded');
  const fingerprint = sha256Json({ delivery: sha256Json(sealed.delivery), approvals: sealed.approvals, ids: sealed.lot_ids, inventory: sealed.inventory_request_id,
    ...(sealed.review_failure_policy ? { review_failure_policy: sealed.review_failure_policy } : {}),
    ...(sealed.review_protocol_version ? { review_protocol_version: sealed.review_protocol_version, reviews: sealed.reviews,
      ...(sealed.review_protocol_version >= 3 ? { training_declarations: sealed.training_declarations } : {}) } : {}),
    ...(sealed.source_image_manifests ? { source_image_manifests: sealed.source_image_manifests } : {}),
    ...(sealed.source_edition_proofs ? { source_edition_proofs: sealed.source_edition_proofs } : {}),
    ...(sealed.lot_split_sha256 ? { lot_split_sha256: sealed.lot_split_sha256 } : {}) });
  if (fingerprint !== sealed.fingerprint) throw new Error('Autonomous seal fingerprint mismatch');
  if (!sealed.review_protocol_version && sealed.approvals.some(approval => approval.protocol_version)) throw new Error('Sample review provenance cannot be downgraded');
  if ((sealed.review_protocol_version ?? 0) < 3 && (sealed.training_declarations || sealed.approvals.some(approval => (approval.protocol_version ?? 0) >= 3))) throw new Error('Training declaration provenance cannot be downgraded');
  const frozen = strictJsonParse(await readFile(join(root, 'sources.json'), 'utf8')) as { sources: SourceLedger[]; receipts: NonNullable<ValidationContext['resolved_references']> & Record<string, { edition_proof?: FrozenEditionProof }>; editions?: Record<string, FrozenEditionProof> };
  const registeredEditions = editionCatalog([...Object.values(frozen.editions ?? {}), ...Object.values(frozen.receipts).map(receipt => receipt.edition_proof)]);
  const sealedEditions = editionCatalog(Object.values(sealed.source_edition_proofs ?? {}));
  for (const id of Object.keys(sealedEditions)) if (!registeredEditions[id]) throw new Error('Source edition provenance changed');
  const consumedSources = referencedSourceIds(sealed.delivery);
  for (const source of frozen.sources) {
    const markdown = await readFile(join(root, 'work', 'source', `${source.source_id}.md`), 'utf8');
    if (consumedSources.has(source.source_id)) assertEditionProofPresent(source.source_id, markdown, expectedSourceHash, sealedEditions);
    if (sha256Text(markdown) !== source.sha256 || sha256Json(buildAcceptanceSourceLedger(markdown)) !== sha256Json(source)) throw new Error('Frozen source or independent ledger changed');
  }
  await verifyFrozenEditionProofs(join(root, 'work', 'source'), sealedEditions, frozen.sources);
  if ((sealed.review_protocol_version ?? 0) >= 3) {
    const source = frozen.sources.find(row => row.source_id === expectedSourceHash)!;
    if (!source) throw new Error('Frozen root source is missing from declaration provenance');
    await verifyTrainingDeclarationHistory(root, state, source);
    if (!Array.isArray(sealed.training_declarations) || sha256Json(sealed.training_declarations) !== sha256Json(state.training_declarations)) throw new Error('Training declaration history does not match checkpoint');
  }
  const checked = validateAcceptanceDelivery(sealed.delivery, { sources: frozen.sources, resolved_references: frozen.receipts, root_source_id: expectedSourceHash });
  if (sealed.lot_split_sha256) {
    const source = frozen.sources.find(row => row.source_id === expectedSourceHash)!;
    const split = await readLotSplitHandoff(root, source);
    if (!split || sha256Json(split) !== sealed.lot_split_sha256 || state.lot_split?.sha256 !== sealed.lot_split_sha256
      || splitDeliveryIssues(split, source, sealed.delivery).length) throw new Error('Split publication inventory no longer matches');
  }
  if (!checked.delivery || sha256Json(checked.issues) !== sha256Json(sealed.issues)) throw new Error('Sealed delivery validation no longer matches');
  const inventory = sealed.reviews.find(review => review.id === sealed.inventory_request_id);
  if ((sealed.source_image_manifests || sealed.source_edition_proofs) && inventory?.fingerprint !== inventoryEvidenceFingerprint(sha256Json(sealed.delivery), sealed.source_image_manifests, sealed.source_edition_proofs)) throw new Error('Inventory source evidence changed');
  if (inventory?.status !== 'passed' || !inventory.result?.approved || !sealed.delivery.lots.every(lot => inventory.result!.reviewed_lot_ids.includes(lot.id))) throw new Error('Independent source inventory approval is missing');
  const legacyInventory = inventory.failure_checks === undefined;
  const registeredInventory = state.requests.find(row => row.id === inventory.id);
  if (sha256Json(registeredInventory?.failure_checks ?? null) !== sha256Json(inventory.failure_checks ?? null)) throw new Error('Inventory failure protocol provenance changed');
  if (sealed.review_failure_policy && !legacyInventory) {
    const checks = inventoryFailureChecks(sealed.reviews.filter(row => row.id !== inventory.id));
    if (!requestResolvesFailures(inventory, checks, '')
      || reviewSubmissionIssues(inventory.result, sealed.delivery.lots.map(lot => lot.id), frozen.sources, checks).length) throw new Error('A concrete inventory finding has no explicit source-backed resolution');
  }
  for (const approval of sealed.approvals) {
    const group = sealed.delivery.groups.find(group => group.id === approval.group_id);
    if (!group) throw new Error('Approval has no rule group');
    const work = await realpath(join(root, 'work'));
    const fingerprintFor = async (view: typeof group) => {
      const files: Record<string, string> = {};
      for (const rule of sealed.delivery.rules.filter(rule => view.rule_ids.includes(rule.id))) for (const name of rule.method_files) {
        const file = await realpath(join(work, name));
        const rel = relative(work, file);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Method escaped the frozen author workspace');
        files[name] = sha256Text(await readFile(file, 'utf8'));
      }
      return groupReviewFingerprint(sealed.delivery, view, files, sourceImageProofs(sampleReviewMaterial(sealed.delivery, view, view.lot_ids), images));
    };
    const groupFingerprint = await fingerprintFor(group);
    const registered = state.approvals.find(row => row.group_id === approval.group_id && row.fingerprint === approval.fingerprint);
    if (sha256Json(registered?.failure_resolutions ?? null) !== sha256Json(approval.failure_resolutions ?? null)
      || sha256Json(registered?.selection_pending_request_ids ?? []) !== sha256Json(approval.selection_pending_request_ids ?? [])
      || registered?.selection_history_count !== approval.selection_history_count) throw new Error('Historical failure resolution provenance changed');
    if (approval.protocol_version === 4 && (!registered
      || sha256Json(registered.required_lot_ids) !== sha256Json(approval.required_lot_ids)
      || sha256Json(registered.training_lot_ids) !== sha256Json(approval.training_lot_ids))) throw new Error('Training declaration / required review approval provenance changed');
    if ((registered?.protocol_version ?? 0) >= 3 && (approval.protocol_version !== registered!.protocol_version
      || registered!.training_declaration_count !== approval.training_declaration_count)) throw new Error('Training declaration approval provenance changed');
    if (approval.protocol_version === 2 || approval.protocol_version === 3 || approval.protocol_version === 4) {
      if (groupFingerprint !== approval.fingerprint || !approval.sample_reviews?.length || !approval.training_lot_ids
        || !['holdout', 'full'].includes(approval.review_mode ?? '')) throw new Error('Invalid sample review approval');
      const required = new Set(approval.protocol_version === 4 ? approval.required_lot_ids : approval.training_lot_ids);
      if ((approval.protocol_version ?? 0) >= 3 && ((sealed.review_protocol_version ?? 0) < 3
        || !Number.isSafeInteger(approval.training_declaration_count) || approval.training_declaration_count! < 0
        || approval.training_declaration_count! > sealed.training_declarations!.length)) throw new Error('Invalid training declaration approval');
      const heldRequest = sealed.reviews.find(row => row.id === approval.holdout_request_id);
      if (!heldRequest) throw new Error('Sample review request is missing');
      let selectionFailures;
      if (approval.selection_history_count !== undefined) {
        if (!Number.isSafeInteger(approval.selection_history_count) || approval.selection_history_count < 0
          || approval.selection_history_count > sealed.reviews.length) throw new Error('Invalid review selection history prefix');
        const prefix = sealed.reviews.slice(0, approval.selection_history_count);
        if (approval.selection_pending_request_ids?.some(id => !prefix.some(row => row.id === id))) throw new Error('Invalid unfinished selection history');
        const pending = new Set(approval.selection_pending_request_ids ?? []);
        const prior = prefix.map(row => {
          if (!pending.has(row.id)) return row;
          const { result: _laterResult, ...atSelection } = row;
          return atSelection;
        });
        selectionFailures = await failureReviewPlan(root, sealed.delivery, prior,
          (state.sample_reviews ?? []).filter(row => prior.some(request => request.id === row.request_id)), images, undefined, Boolean(sealed.review_failure_policy), legacyInventory);
        const expected = selectionFailures.resolutions.filter(row => group.lot_ids.includes(row.lot_id));
        if (sha256Json(expected) !== sha256Json(approval.failure_resolutions)) throw new Error('Historical passing facts no longer match');
      }
      if (approval.review_mode === 'holdout') {
        if (heldRequest.phase !== 'holdout' || !heldRequest.exposed_lots?.length) throw new Error('A holdout needs genuinely unseen source scopes');
        const prior = sealed.reviews.slice(0, sealed.reviews.indexOf(heldRequest));
        const seen = (await Promise.all(prior.map(request => reviewExposures(root, request)))).flat();
        const declaredHistory = (approval.protocol_version ?? 0) >= 3 ? sealed.training_declarations!.slice(0, approval.training_declaration_count) : [];
        const training = new Set(trainingLotIds(sealed.delivery, group, [...seen, ...declaredHistory]));
        if (sha256Json([...training].sort()) !== sha256Json([...approval.training_lot_ids].sort())) throw new Error('Training exposure history does not match approval');
        if (approval.protocol_version === 4) {
          const expected = requiredReviewLotIds(sealed.delivery, group, selectionFailures?.unresolved ?? await reviewObligations(root, sealed.delivery, prior, legacyInventory));
          if (sha256Json([...expected].sort()) !== sha256Json([...required].sort())) throw new Error('Required review samples do not match approval');
        }
        const held = heldRequest.lot_ids.filter(id => group.lot_ids.includes(id));
        if (!held.length || held.some(id => training.has(id))) throw new Error('A seen sample cannot be relabelled as holdout');
        held.forEach(id => required.add(id));
      } else {
        if (sha256Json([...required].sort()) !== sha256Json([...group.lot_ids].sort())) throw new Error('Full review must cover every group member');
      }
      for (const id of required) {
        const proof = approval.sample_reviews.find(row => row.lot_id === id);
        if (!proof || proof.group_id !== group.id || !sampleReceiptAccepted(proof, sealed.reviews)) throw new Error('Sample decision is missing or rejected');
        const request = sealed.reviews.find(row => row.id === proof.request_id)!;
        if (reviewSubmissionIssues(request.result!, Object.keys(request.sample_fingerprints ?? {}), frozen.sources, request.failure_checks).length) throw new Error('Invalid per-lot review decisions');
        const files: Record<string, string> = {};
        for (const rule of sampleReviewMaterial(sealed.delivery, group, [id]).rules) for (const name of rule.method_files) {
          const file = await realpath(join(work, name)), rel = relative(work, file);
          if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Sample method escaped workspace');
          files[name] = sha256Text(await readFile(file, 'utf8'));
        }
        if (sampleReviewFingerprint(sealed.delivery, group, id, files, sourceImageProofs(sampleReviewMaterial(sealed.delivery, group, [id]), images)) !== proof.fingerprint) throw new Error('Sample approval does not match current method and fields');
      }
      if (approval.protocol_version === 4 && sha256Json(registered!.sample_reviews) !== sha256Json(approval.sample_reviews)) throw new Error('Sample decision provenance changed');
      continue;
    }
    const trialFingerprint = await fingerprintFor(trialReviewGroup(sealed.delivery, group));
    if (groupFingerprint !== approval.fingerprint || ![
      { id: approval.trial_request_id, fingerprints: [trialFingerprint, groupFingerprint] },
      { id: approval.holdout_request_id, fingerprints: [groupFingerprint] },
    ].every(({ id, fingerprints }) => sealed.reviews.some(review => review.id === id && fingerprints.includes(review.fingerprint)
      && review.status === 'passed' && review.result?.approved && !review.result.findings.length))) throw new Error('Rule-group approval does not match the frozen method and outputs');
  }
  if (sealed.review_protocol_version === 4) {
    const obligations = await reviewObligations(root, sealed.delivery, sealed.reviews, legacyInventory);
    const checks = sealed.review_failure_policy ? reviewFailureChecks(sealed.reviews, obligations, sealed.lot_ids) : [];
    for (const row of obligations) {
      if (row.missing_block_ids.length || !row.current_lot_ids.length) throw new Error('A failed source scope was removed instead of repaired');
      for (const id of row.current_lot_ids.filter(id => sealed.lot_ids.includes(id))) {
        const approval = sealed.approvals.find(approval => [...(approval.sample_reviews ?? []), ...(approval.failure_resolutions ?? [])].some(proof => {
          const request = sealed.reviews.find(request => request.id === proof.request_id);
          return proof.lot_id === id && sampleReceiptAccepted(proof, sealed.reviews)
            && receiptPostdatesFailures(proof.request_id, id, sealed.reviews, obligations)
            && requestResolvesFailures(request!, checks, id)
            && !reviewSubmissionIssues(request!.result!, Object.keys(request!.sample_fingerprints ?? {}), frozen.sources, request!.failure_checks).length;
        }));
        if (!approval) throw new Error('A concrete review failure has no subsequent current passing decision');
      }
    }
  }
  const ids = eligibleLotIds(sealed.delivery, checked.issues, new Set(sealed.approvals.map(approval => approval.group_id)));
  if (!ids.length || sha256Json(ids) !== sha256Json(sealed.lot_ids)) throw new Error('Publication dependencies are not closed');
  if ((ids.length === sealed.delivery.lots.length && checked.issues.length === 0 ? 'complete' : 'partial') !== sealed.status) throw new Error('Incorrect autonomous completion status');
  return sealed;
}
