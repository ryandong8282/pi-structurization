import { describe, expect, it } from 'vitest';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { reviewSubmissionIssues } from '../src/acceptance-autonomous/review.js';
import { reviewFailureChecks, requestResolvesFailures } from '../src/acceptance-autonomous/review-failures.js';
import type { AcceptanceDelivery, AutonomousWorkRequest, GroupReviewResult, ReviewFailureCheck } from '../src/acceptance-autonomous/contracts.js';
import { reviewObligations } from '../src/acceptance-autonomous/review-plan.js';

const source = buildAcceptanceSourceLedger('虚构温控器：温差不得大于 2 K。');
const quote = sourceQuote(source, source.blocks[0]!);
const check: ReviewFailureCheck = { id: 'failure:fixture', request_id: 'review:earlier', finding_index: 0,
  lot_id: 'sensor', path: '/items/0/requirement', message: '当前温差写成了3 K。', evidence: [quote] };
const pass = (): GroupReviewResult => ({ approved: true, reviewed_lot_ids: ['sensor'], reason: '独立核对温差与单位。', findings: [],
  failure_responses: [{ check_id: check.id, disposition: 'fixed', reason: '当前为2 K，与原文一致。', evidence: [quote] }] });

describe('explicit historical findings', () => {
  it('keeps global local-review failures blocking their lots while separating whole-source inventory findings', async () => {
    const request: AutonomousWorkRequest = { id: 'review:fixture', kind: 'group_review', phase: 'full', fingerprint: 'fixture',
      source_ids: [source.source_id], lot_ids: ['sensor'], dependency_ids: [], status: 'needs_work', attempts: 1,
      exposed_lots: [{ lot_id: 'sensor', block_ids: [quote.block_id] }],
      result: { approved: false, reviewed_lot_ids: ['sensor'], reason: '合成全局条件缺失',
        findings: [{ lot_id: '', path: '/condition', message: '合成温控条件尚未解决', evidence: [quote] }] } };
    const delivery = { source_sha256: source.sha256, lots: [{ id: 'sensor', scope: { block_ids: [quote.block_id] } }] } as AcceptanceDelivery;
    expect(await reviewObligations('', delivery, [request])).toMatchObject([{ current_lot_ids: ['sensor'] }]);
    const inventory = { ...request, phase: 'inventory' as const };
    const before = JSON.stringify(inventory);
    expect(await reviewObligations('', delivery, [inventory])).toEqual([]);
    expect(await reviewObligations('', delivery, [inventory], true)).toHaveLength(1);
    expect(JSON.stringify(inventory)).toBe(before);
  });

  it.each(['missing', 'unresolved', 'duplicate', 'unknown', 'empty_reason', 'false_quote'] as const)('refuses approval with %s responses', defect => {
    const result = pass(), answer = result.failure_responses![0]!;
    if (defect === 'missing') result.failure_responses = [];
    if (defect === 'unresolved') answer.disposition = 'unresolved';
    if (defect === 'duplicate') result.failure_responses!.push({ ...answer });
    if (defect === 'unknown') answer.check_id = 'failure:unrelated';
    if (defect === 'empty_reason') answer.reason = ' ';
    if (defect === 'false_quote') answer.evidence = [{ ...quote, text: '虚构的无来源内容' }];
    expect(reviewSubmissionIssues(result, ['sensor'], [source], [check]).length).toBeGreaterThan(0);
  });

  it('retains unresolved findings as a rejection, and permits source-backed correction or overturn', () => {
    const result = pass();
    expect(reviewSubmissionIssues(result, ['sensor'], [source], [check])).toEqual([]);
    result.failure_responses![0]!.disposition = 'not_applicable';
    expect(reviewSubmissionIssues(result, ['sensor'], [source], [check])).toEqual([]);
    result.approved = false; result.failure_responses![0]!.disposition = 'unresolved';
    result.findings = [{ lot_id: check.lot_id, path: check.path, message: check.message, evidence: [quote] }];
    expect(reviewSubmissionIssues(result, ['sensor'], [source], [check])).toEqual([]);
  });

  it('maps retained findings to current source owners and rejects a generic later receipt', () => {
    const previous: AutonomousWorkRequest = { id: check.request_id, kind: 'group_review', fingerprint: 'old', source_ids: [source.source_id],
      lot_ids: ['old-sensor'], dependency_ids: [], status: 'needs_work', attempts: 1,
      result: { approved: false, reviewed_lot_ids: ['old-sensor'], reason: '温差错误', findings: [{ lot_id: 'old-sensor', path: check.path, message: check.message, evidence: [quote] }] } };
    const checks = reviewFailureChecks([previous], [{ request_id: previous.id, request_index: 0, lot_id: 'old-sensor',
      block_ids: [quote.block_id], missing_block_ids: [], current_lot_ids: ['sensor', 'sensor-b'] }], ['sensor']);
    expect(checks).toHaveLength(1); expect(checks[0]).toMatchObject({ request_id: previous.id, finding_index: 0, lot_id: 'sensor' });
    const later: AutonomousWorkRequest = { ...previous, id: 'review:later', status: 'passed', result: pass() };
    expect(requestResolvesFailures(later, checks, 'sensor')).toBe(false);
    later.failure_checks = checks; later.result!.failure_responses![0]!.check_id = checks[0]!.id;
    expect(requestResolvesFailures(later, checks, 'sensor')).toBe(true);
  });

  it('points a mistyped source identity to the registered owner without rewriting evidence', () => {
    const evidence = { ...quote, source_id: 'mistyped-source-hash' };
    const result = { ...pass(), approved: false, failure_responses: [], findings: [{ lot_id: 'sensor', path: check.path, message: check.message, evidence: [evidence] }] };
    const issues = reviewSubmissionIssues(result, ['sensor'], [source], [check]);
    expect(issues).toMatchObject([{ expected: { source_block_exists: false, source_ids_owning_block: [source.source_id] } }]);
    expect(evidence.source_id).toBe('mistyped-source-hash');
  });
});
