import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildAcceptanceSourceLedger } from '../src/acceptance-autonomous/source-ledger.js';
import { freezeReviewContexts } from '../src/acceptance-autonomous/review-context.js';
import type { GroupReviewRequest } from '../src/acceptance-autonomous/contracts.js';
import { resolveReviewEvidence, reviewEvidenceId, type ReviewSubmission } from '../src/acceptance-autonomous/review-evidence.js';
import { reviewSubmissionIssues } from '../src/acceptance-autonomous/review.js';
import { sourceQuote, verifySourceQuote } from '../src/acceptance-autonomous/source-ledger.js';

const parent = resolve('.codex-tmp'), roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const inside = relative(parent, resolve(root));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

const source = buildAcceptanceSourceLedger('虚构温控器🌡：温差不得超过 2 K；记录合格，再记录合格。');
const block = source.blocks[0]!, id = reviewEvidenceId(source, block);
const submission = (): ReviewSubmission => ({ approved: false, reviewed_lot_ids: ['sensor'], reason: '核对合成温控要求。',
  findings: [{ lot_id: 'sensor', path: '/items/0/requirement', message: '合成候选温差与原文不符。', evidence: [{ evidence_id: id }] }] });

it('materializes exact whole-block and UTF-16 excerpt evidence while preserving semantic decisions', () => {
  const input = submission(), before = JSON.stringify(input);
  input.failure_responses = [{ check_id: 'earlier', disposition: 'unresolved', reason: '同一温差错误仍在。',
    evidence: [{ evidence_id: id, excerpt: '温差不得超过 2 K' }] }];
  const normalized = resolveReviewEvidence(input, [source]);
  expect(normalized.issues).toEqual([]);
  expect(normalized.result!.findings[0]!.evidence).toEqual([sourceQuote(source, block)]);
  const quote = normalized.result!.failure_responses![0]!.evidence[0]!;
  expect(quote.start).toBe(block.text.indexOf('温差'));
  expect(verifySourceQuote([source], quote)).toBe(true);
  expect(normalized.result).toMatchObject({ approved: false, reason: input.reason,
    failure_responses: [{ disposition: 'unresolved', reason: '同一温差错误仍在。' }] });
  expect(JSON.stringify({ ...input, failure_responses: undefined })).toBe(before);
});

it('requires an explicit occurrence for repeated text and never guesses a fuzzy quote', () => {
  const input = submission();
  input.findings[0]!.evidence = [{ evidence_id: id, excerpt: '记录合格' }];
  expect(resolveReviewEvidence(input, [source])).toMatchObject({ issues: [{ expected: { matches: 2 } }] });
  expect(resolveReviewEvidence(input, [source]).result).toBeUndefined();
  input.findings[0]!.evidence = [{ evidence_id: id, excerpt: '记录合格', occurrence: 2 }];
  expect(resolveReviewEvidence(input, [source]).result!.findings[0]!.evidence[0]!.start).toBe(block.text.lastIndexOf('记录合格'));
  input.findings[0]!.evidence = [{ evidence_id: id, excerpt: '温差不得超过2K' }];
  expect(resolveReviewEvidence(input, [source])).toMatchObject({ issues: [{ expected: { matches: 0 } }] });
});

it('rejects foreign, changed-version and unexpanded evidence IDs without dropping any finding', () => {
  const input = submission();
  expect(resolveReviewEvidence(input, [source], new Set()).result).toBeUndefined();
  const changed = buildAcceptanceSourceLedger(block.text.replace('2 K', '9 K'));
  expect(resolveReviewEvidence(input, [changed]).result).toBeUndefined();
  input.findings[0]!.evidence.push({ evidence_id: 'ev:invented' });
  const resolved = resolveReviewEvidence(input, [source]);
  expect(resolved.issues).toHaveLength(1); expect(resolved.result).toBeUndefined();
  expect(input.findings[0]!.evidence).toHaveLength(2);
});

it('keeps strict legacy evidence validation and does not turn a rejection into an approval', () => {
  const input = submission();
  input.findings[0]!.evidence = [{ ...sourceQuote(source, block), source_id: 'mistyped-source' }];
  const result = resolveReviewEvidence(input, [source]).result!;
  expect(reviewSubmissionIssues(result, ['sensor'], [source])).toMatchObject([{ path: '/findings/0/evidence/0' }]);
  expect(result.approved).toBe(false);
});

it('attaches host-owned evidence IDs to exact frozen context without rewriting source blocks', async () => {
  const source = buildAcceptanceSourceLedger('虚构温控器🌡：温差不得超过 2 K。\n\n未选中的虚构泵：流量为 8 L/s。');
  const before = JSON.stringify(source);
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'review-evidence-')); roots.push(root);
  const request = { phase: 'trial', sources: [source], lots: [], rules: [], references: [],
    source_context: [{ source_id: source.source_id, block_id: source.blocks[0]!.id }] } as unknown as GroupReviewRequest;
  const contexts = await freezeReviewContexts(request, root);
  const data = JSON.parse(await readFile(contexts[0]!.path, 'utf8'));
  expect(data.blocks).toHaveLength(1);
  expect(data.blocks[0].evidence_id).toMatch(/^ev:[a-f0-9]{16}$/);
  const { evidence_id, ...block } = data.blocks[0];
  expect(block).toEqual(source.blocks[0]);
  expect(JSON.stringify(source)).toBe(before);
});
