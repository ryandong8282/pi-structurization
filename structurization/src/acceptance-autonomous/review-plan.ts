import type { AcceptanceDelivery, AcceptanceGroup, AutonomousWorkRequest } from './contracts.js';
import { reviewExposures, sampleReviewMaterial } from './review.js';

/** Exposure removes holdout eligibility. Only selected samples and actual failures require review. */
export async function reviewObligations(root: string, delivery: AcceptanceDelivery, requests: AutonomousWorkRequest[], includeInventory = false) {
  const obligations: Array<{ request_id: string; request_index: number; lot_id: string; block_ids: string[]; missing_block_ids: string[]; current_lot_ids: string[] }> = [];
  for (const [request_index, request] of requests.entries()) {
    // Inventory failures block publication. They are not failed local sample decisions.
    // Actual changes to a shared requirement still invalidate its consumers by fingerprint.
    if (request.phase === 'inventory' && !includeInventory) continue;
    if (!request.result?.findings.length) continue;
    const exposed = await reviewExposures(root, request);
    const global = request.result.findings.some(row => !row.lot_id);
    const failed = new Set([...request.result.findings.map(row => row.lot_id),
      ...(request.result.lot_decisions?.filter(row => !row.approved).map(row => row.lot_id) ?? [])]);
    for (const row of exposed.filter(row => global || failed.has(row.lot_id))) {
      const located = request.result.findings.filter(finding => !finding.lot_id || finding.lot_id === row.lot_id).flatMap(finding => finding.evidence)
        .filter(quote => quote.source_id === delivery.source_sha256 && row.block_ids.includes(quote.block_id)).map(quote => quote.block_id);
      // Pin the failed body, not a retained title/context that could disguise removing it.
      const blocks = new Set(located.length ? located : row.block_ids);
      obligations.push({ request_id: request.id, request_index, lot_id: row.lot_id, block_ids: [...blocks],
        missing_block_ids: [...blocks].filter(id => !delivery.lots.some(lot => lot.scope.block_ids.includes(id))),
        current_lot_ids: delivery.lots.filter(lot => lot.scope.block_ids.some(id => blocks.has(id))).map(lot => lot.id) });
    }
  }
  return obligations;
}

export type ReviewObligation = Awaited<ReturnType<typeof reviewObligations>>[number];

export function requiredReviewLotIds(delivery: AcceptanceDelivery, group: AcceptanceGroup, obligations: ReviewObligation[]) {
  return sampleReviewMaterial(delivery, group, [...new Set([...group.trial_lot_ids, ...group.boundary_lot_ids,
    ...obligations.flatMap(row => row.current_lot_ids.filter(id => group.lot_ids.includes(id)))])]).lots.map(lot => lot.id);
}

export function receiptPostdatesFailures(requestId: string, lotId: string, requests: AutonomousWorkRequest[], obligations: ReviewObligation[]) {
  const index = requests.findIndex(row => row.id === requestId);
  return !obligations.some(row => row.current_lot_ids.includes(lotId) && row.request_index >= index);
}
