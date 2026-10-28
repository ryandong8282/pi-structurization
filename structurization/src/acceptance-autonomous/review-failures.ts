import { sha256Json } from '../canonical.js';
import type { AutonomousWorkRequest, ReviewFailureCheck } from './contracts.js';
import type { ReviewObligation } from './review-plan.js';

/** A whole-source finding is answered by the next inventory, not re-issued to every local reviewer. */
export function inventoryFailureChecks(requests: AutonomousWorkRequest[]): ReviewFailureCheck[] {
  return requests.filter(request => request.phase === 'inventory').flatMap(request => (request.result?.findings ?? []).map((finding, finding_index) => {
    const identity = { request_id: request.id, finding_index, lot_id: '' };
    return { id: `failure:${sha256Json(identity).slice(0, 24)}`, ...identity,
      path: finding.path, message: finding.message, evidence: finding.evidence };
  }));
}

/** Derive the checklist from retained findings and source ownership, never from author assertions. */
export function reviewFailureChecks(requests: AutonomousWorkRequest[], obligations: ReviewObligation[], ids: string[]): ReviewFailureCheck[] {
  const checks = new Map<string, ReviewFailureCheck>();
  for (const obligation of obligations) {
    const request = requests.find(row => row.id === obligation.request_id)!;
    request.result!.findings.forEach((finding, finding_index) => {
      if (finding.lot_id && finding.lot_id !== obligation.lot_id) return;
      for (const lot_id of obligation.current_lot_ids.filter(id => ids.includes(id))) {
        const identity = { request_id: request.id, finding_index, lot_id };
        const id = `failure:${sha256Json(identity).slice(0, 24)}`;
        checks.set(id, { id, ...identity, path: finding.path, message: finding.message, evidence: finding.evidence });
      }
    });
  }
  return [...checks.values()];
}

/** A later generic pass cannot erase a specific earlier finding. Evidence validity is checked at submission and publication. */
export function requestResolvesFailures(request: AutonomousWorkRequest, checks: ReviewFailureCheck[], lotId: string): boolean {
  return checks.filter(check => check.lot_id === lotId).every(check => {
    if (!request.failure_checks?.some(row => row.id === check.id && sha256Json(row) === sha256Json(check))) return false;
    const answers = request.result?.failure_responses?.filter(row => row.check_id === check.id) ?? [];
    return answers.length === 1 && ['fixed', 'not_applicable'].includes(answers[0]!.disposition)
      && Boolean(answers[0]!.reason?.trim()) && Boolean(answers[0]!.evidence?.length);
  });
}
