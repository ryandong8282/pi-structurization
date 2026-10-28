import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { parallelMap, mergeExtractionFragment, assertFragmentEvidence, FragmentEvidenceError, fragmentEvidenceFeedback, FragmentStructureError, fragmentAdmissionFeedback } from '../src/acceptance-autonomous/parallel-extraction.js';
import { readAutonomousAcceptanceProgress } from '../src/acceptance-autonomous/progress.js';
import { verifyAutonomousSealedDelivery } from '../src/acceptance-autonomous/sealed.js';
import { installLotSplitHandoff, type LotSplitHandoff } from '../src/acceptance-autonomous/lot-split-handoff.js';
import type { AcceptanceDelivery, AcceptanceExtractor, ExtractionTask, GroupReviewer } from '../src/acceptance-autonomous/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const source = '甲构件长度允许偏差5mm。\n\n乙构件长度允许偏差7mm。\n\n丙构件长度允许偏差8mm。\n\n丁构件长度允许偏差9mm。';
const ledger = buildAcceptanceSourceLedger(source);
const limits = { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 2 };
const task = (index: number): ExtractionTask => ({ id: `unit${index}`, block_ids: [ledger.blocks[index]!.id], instruction: '识别本例具名构件，保留原文。', method_files: ['extract.mjs'] });
const empty = (): AcceptanceDelivery => ({ schema_version: 'acceptance-autonomous-delivery/v1', source_sha256: ledger.sha256,
  rules: [], groups: [], lots: [], dispositions: ledger.blocks.map(block => ({ source_id: ledger.source_id, block_id: block.id, role: 'unresolved', lot_ids: [], reason: '尚未处理', evidence: [sourceQuote(ledger, block)] })), references: [], problems: [] });
function fragment(index: number): AcceptanceDelivery {
  const block = ledger.blocks[index]!, prefix = `unit${index}`, quote = sourceQuote(ledger, block);
  const bound = { value: block.text, evidence: [quote] }, absent = { value: '', evidence: [], reason: '原文未给出' };
  return { ...empty(), rules: [{ id: `${prefix}-rule`, method_files: ['extract.mjs'], scope: '具名构件正文', exceptions: [], evidence: [quote] }],
    groups: [{ id: `${prefix}-group`, structure: '具名正文', rule_ids: [`${prefix}-rule`], lot_ids: [`${prefix}-lot`], trial_lot_ids: [`${prefix}-lot`], boundary_lot_ids: [], conditions: '当前具名正文', exclusions: [] }],
    lots: [{ id: `${prefix}-lot`, name: bound, ancestors: [], scope: { block_ids: [block.id], reason: '原文具名构件', evidence: [quote] },
      group_id: `${prefix}-group`, dependency_ids: [], items: [{ id: 'item', name: bound, category: absent, requirement: bound,
        method: absent, quantity: absent, unit: absent, condition: absent, note: absent, inspection_data_type: 'measurement', inspection_data_type_reason: '原文长度偏差',
        sampling: { status: 'reference_unspecified_quantity', text: absent, conditions: [] }, reference_ids: [], rule_ids: [`${prefix}-rule`] }] }],
    dispositions: [{ source_id: ledger.source_id, block_id: block.id, role: 'lot', lot_ids: [`${prefix}-lot`], reason: '具名构件', evidence: [quote] }] };
}
const reviewer: GroupReviewer = async input => ({ approved: true, reason: '已核对本次虚构原文', findings: [], reviewed_lot_ids: input.lots.map(lot => lot.id), lot_decisions: input.lots.map(lot => ({ lot_id: lot.id, approved: true, reason: '原文一致' })) });
async function fixture(extractor: AcceptanceExtractor, review = reviewer) {
  const root = await mkdtemp(join(tmpdir(), 'parallel-acceptance-')); roots.push(root);
  const markdownPath = join(root, 'original.md'); await writeFile(markdownPath, source);
  const options = { root: join(root, 'run'), markdownPath, limits, subtaskToolResponseBytes: 524288, reviewer: review, extractor };
  const controller = await AcceptanceAutonomousController.open(options);
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(empty()));
  await writeFile(join(controller.workRoot, 'extract.mjs'), '// fictional reusable method\n');
  return { controller, options };
}
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

it('reuses an accepted split, replaces unowned metadata dispositions, and retains counters across bounded batches', async () => {
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async input => {
    expect(input.task.split_input?.source).toHaveLength(1);
    active++; peak = Math.max(peak, active); if (active === 2) release(); await gate;
    const index = Number(input.task.split_input!.id.slice(4));
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(index))); active--;
  });
  const handoff: LotSplitHandoff = { schema_version: 'acceptance-lot-split-handoff/v1', source_sha256: ledger.sha256,
    manifest_sha256: 'a'.repeat(64), pdf_sha256: null, history: { checkpoint_sha256: 'b'.repeat(64), sessions: 2, tool_calls: 8, tool_response_bytes: 512, limits: { max_sessions: 12 } },
    decisions: ledger.blocks.map((block, i) => ({ id: `part${i}`, kind: 'lot', name: `虚构构件${i}`, reason: '明确的独立对象', related_lot_ids: [],
      source: [{ ...sourceQuote(ledger, block), block: i, start_line: block.start_line, end_line: block.end_line }] })) };
  await installLotSplitHandoff(f.controller.root, handoff, ledger);
  const old = empty(); old.dispositions.forEach(row => { row.role = 'not_extractable'; });
  await writeFile(join(f.controller.workRoot, 'DELIVERY.json'), JSON.stringify(old));
  await f.controller.accountTool(77); const budget = f.controller.state().budget;
  const resumed = await AcceptanceAutonomousController.open(f.options);
  expect(resumed.state().budget).toEqual(budget);
  expect(resumed.state().lot_split?.history).toEqual(handoff.history);
  expect(await resumed.dispatch('extract_acceptance_lot_batch', { method_files: ['extract.mjs'] })).toMatchObject({ ok: true });
  expect(peak).toBe(2);
  expect(await resumed.dispatch('list_acceptance_lot_inputs', {})).toMatchObject({ total: 4, candidates: 2, pending: 2 });
  expect(await resumed.dispatch('read_acceptance_lot_input', { lot_id: 'unit0-lot' })).toMatchObject({ ok: true, input: { id: 'part0' } });
  expect(await resumed.dispatch('list_acceptance_lot_inputs', { query: 'unit0-lot' })).toMatchObject({ rows: [{ id: 'part0' }], next_offset: null });
  expect(await resumed.dispatch('read_acceptance_lot_input', { lot_id: 'missing' })).toMatchObject({ ok: false, actual: { lot_id: 'missing' }, next_tool_arguments: { query: 'missing' } });
  expect(await resumed.dispatch('seal_acceptance_delivery', {})).toMatchObject({ ok: false, error: 'split_inventory_incomplete' });
  expect((await readAutonomousAcceptanceProgress(resumed.root, false))?.split).toMatchObject({ total: 4, candidates: 2, pending: 2 });
  expect(resumed.state().budget).toEqual(budget);
  await resumed.assertSources();
});

it('only host-bound exact lot input may supersede old unowned metadata; generic tasks and changed ranges remain rejected', () => {
  const base = empty(), t = task(0); base.dispositions[0]!.role = 'not_extractable';
  expect(() => mergeExtractionFragment(base, fragment(0), t, [ledger])).toThrow(/already/);
  t.split_input = { id: 'lot-input', name: '虚构构件', source: [sourceQuote(ledger, ledger.blocks[0]!)], shared: [] };
  expect(mergeExtractionFragment(base, fragment(0), t, [ledger]).lots).toHaveLength(1);
  t.split_input.source[0]!.text = '伪造';
  expect(() => mergeExtractionFragment(base, fragment(0), t, [ledger])).toThrow(/exact/);
});

it('overlaps isolated extraction workers, bounds concurrency and merges without losing checkpoint or budgets', async () => {
  let active = 0, peak = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  let controller!: AcceptanceAutonomousController;
  const extractor = vi.fn<AcceptanceExtractor>(async input => {
    active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await controller.accountTool(25, 1000, input.request_id);
    await bothStarted;
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(Number(input.task.id.slice(4)))));
    active--;
  });
  const fixtureValue = await fixture(extractor); controller = fixtureValue.controller;
  await controller.beginSession();
  const before = controller.state();
  const result = await controller.dispatch('parallel_acceptance_extract', { path: 'DELIVERY.json', tasks: [task(0), task(1), task(2), task(3)] });
  expect(result.ok).toBe(true); expect(peak).toBe(2);
  const draft = JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8'));
  expect(draft.lots.map((lot: { id: string }) => lot.id)).toEqual(['unit0-lot', 'unit1-lot', 'unit2-lot', 'unit3-lot']);
  expect(controller.state().approvals).toEqual(before.approvals);
  expect(controller.state().budget).toEqual({ ...before.budget, observed_context_tokens: 1000, tool_response_bytes: before.budget.tool_response_bytes + 100 });
  expect(controller.state().requests.every(row => row.attempts === 1 && row.tool_response_bytes === 25 && row.extraction?.merged)).toBe(true);
  await controller.assertSources();
  const reopened = await AcceptanceAutonomousController.open(fixtureValue.options);
  expect((await reopened.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).ok).toBe(true);
  expect(extractor).toHaveBeenCalledTimes(4);
  expect(reopened.state().budget).toEqual(controller.state().budget);
  const progress = await readAutonomousAcceptanceProgress(controller.root, false);
  expect(progress?.source).toMatchObject({ processed: 4, pending: 0, total: 4 });
  expect(progress?.extraction).toMatchObject({ lots: 4, items: 4, running: 0, completed: 4 });
  expect(progress?.review).toMatchObject({ approved_groups: 0, pending_groups: 4 });
  expect(progress?.publication.state).toBe('unpublished');
});

it('keeps serial admission strict when two valid isolated submissions collide on a new group id', async () => {
  let controller!: AcceptanceAutonomousController, collide = true, calls = 0;
  const f = await fixture(async input => {
    calls++; await controller.accountTool(30, 0, input.request_id);
    const proposal = fragment(Number(input.task.id.slice(4)));
    if (collide) { proposal.groups[0]!.id = 'collision-group'; proposal.lots[0]!.group_id = 'collision-group'; }
    input.validate_fragment(proposal);
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(proposal));
  });
  controller = f.controller;
  const result = await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] });
  expect(result).toMatchObject({ ok: false, results: [{ ok: true }, { ok: false, error: 'fragment_structure_invalid',
    issues: [expect.objectContaining({ path: '/groups/0/id' })], next_tool: 'parallel_acceptance_extract',
    next_tool_arguments: { path: 'DELIVERY.json', tasks: [task(1)] } }] });
  expect(JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).lots.map((lot: { id: string }) => lot.id)).toEqual(['unit0-lot']);
  collide = false;
  expect((await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).ok).toBe(true);
  expect(calls).toBe(3);
  expect(controller.state().requests.map(request => [request.attempts, request.tool_response_bytes])).toEqual([[1,30], [2,60]]);
  expect(JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).lots.map((lot: { id: string }) => lot.id)).toEqual(['unit0-lot', 'unit1-lot']);
  expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
});

it('keeps failed worker usage while a sibling succeeds; retry reuses the completed sibling', async () => {
  let controller!: AcceptanceAutonomousController, fail = true;
  const extractor = vi.fn<AcceptanceExtractor>(async input => {
    await controller.accountTool(40, 0, input.request_id);
    if (input.task.id === 'unit1' && fail) throw new Error('neutral worker failure');
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(Number(input.task.id.slice(4)))));
  });
  const f = await fixture(extractor); controller = f.controller;
  expect((await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).ok).toBe(false);
  expect(controller.state().requests.map(row => row.status)).toEqual(['passed', 'failed']);
  fail = false;
  expect((await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).ok).toBe(true);
  expect(controller.state().requests.map(row => [row.attempts, row.tool_response_bytes])).toEqual([[1, 40], [2, 80]]);
  expect(extractor).toHaveBeenCalledTimes(3);
});

it('shares the existing byte allowance across renamed retries of the identical source scope without rewriting history', async () => {
  let controller!: AcceptanceAutonomousController;
  const f = await fixture(async input => {
    for (let index = 0; index < 3; index++) await controller.accountTool(100000, 0, input.request_id);
    throw new Error('neutral incomplete extraction');
  }); controller = f.controller;
  const before = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8');
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0)] });
  const original = structuredClone(controller.state().requests[0]!);
  const retry = { ...task(0), id: 'renamed', instruction: '重试同一虚构原文，指令不同' };
  expect(await controller.dispatch('parallel_acceptance_extract', { tasks: [retry] })).toMatchObject({ ok: false,
    results: [expect.objectContaining({ error: expect.stringContaining('autonomous_subtask_budget_exceeded') })] });
  expect(controller.state().requests[0]).toEqual(original);
  expect(controller.state().requests.map(row => [row.attempts, row.tool_response_bytes])).toEqual([[1, 300000], [1, 200000]]);
  const retryId = controller.state().requests[1]!.id;
  expect(controller.toolResponseUsage(retryId)).toMatchObject({ subtask_returned_bytes: 500000, remaining_bytes: 24288,
    subtask_limit_bytes: 524288, scope_request_ids: controller.state().requests.map(row => row.id) });
  const reopened = await AcceptanceAutonomousController.open(f.options);
  expect(reopened.toolResponseUsage(retryId)).toEqual(controller.toolResponseUsage(retryId));
  expect(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(before);
  expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
  await controller.assertSources();
});

it('keeps the attempt cap for renamed retries and treats reordered block sets as the same scope', async () => {
  const extractor = vi.fn<AcceptanceExtractor>(async () => { throw new Error('neutral unresolved extraction'); });
  const { controller } = await fixture(extractor);
  const scope = [ledger.blocks[0]!.id, ledger.blocks[1]!.id];
  for (let index = 0; index < 13; index++) {
    await controller.dispatch('parallel_acceptance_extract', { tasks: [{ ...task(0), id: `retry${index}`,
      block_ids: index % 2 ? [...scope].reverse() : scope }] });
  }
  expect(extractor).toHaveBeenCalledTimes(12);
  expect(controller.state().requests.reduce((sum, row) => sum + row.attempts, 0)).toBe(12);
  expect(controller.state().requests.at(-1)!.error).toContain('attempt limit');
});

it('retains independent allowances for different extraction source scopes without a job total cap', async () => {
  let controller!: AcceptanceAutonomousController;
  const f = await fixture(async input => {
    for (let index = 0; index < 3; index++) await controller.accountTool(100000, 0, input.request_id);
    throw new Error('neutral unresolved extraction');
  }); controller = f.controller;
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] });
  expect(controller.state().budget.tool_response_bytes).toBe(600000);
  for (const request of controller.state().requests) expect(controller.toolResponseUsage(request.id)).toMatchObject({
    subtask_returned_bytes: 300000, remaining_bytes: 224288, total_limit_bytes: null });
});

it('rejects overlapping tasks before calling any worker and rejects out-of-scope or forged proposals', async () => {
  const extractor = vi.fn<AcceptanceExtractor>();
  const { controller } = await fixture(extractor);
  await expect(controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), { ...task(1), block_ids: task(0).block_ids }] })).rejects.toThrow(/non-overlapping/);
  expect(extractor).not.toHaveBeenCalled();
  expect(() => mergeExtractionFragment(empty(), fragment(1), task(0), [ledger])).toThrow(/exactly/);
  const forged = fragment(0); forged.lots[0]!.items[0]!.requirement.evidence[0]!.text = '伪造正文';
  expect(() => mergeExtractionFragment(empty(), forged, task(0), [ledger])).toThrow(/evidence/);
});

it('rejects duplicate item identities within a worker lot with the exact writable field', () => {
  const proposal = fragment(0), second = structuredClone(proposal.lots[0]!.items[0]!);
  second.note = { value: '', evidence: [], reason: '第二个虚构条目没有单独附注' };
  proposal.lots[0]!.items.push(second);
  expect(() => mergeExtractionFragment(empty(), proposal, task(0), [ledger])).toThrowError(expect.objectContaining({
    code: 'fragment_structure_invalid', issues: [expect.objectContaining({ path: '/lots/0/items/1/id',
      actual: expect.objectContaining({ preview: JSON.stringify('item'), full_value_path: 'fragment.json#/lots/0/items/1/id' }),
      expected: expect.stringContaining('同一检验批'),
    })],
  }));
  expect(proposal.lots[0]!.items.map(item => item.id)).toEqual(['item', 'item']);
});

it('keeps duplicate-item repair inside the worker while retaining sibling results and historical usage', async () => {
  let controller!: AcceptanceAutonomousController, duplicate = true, calls = 0;
  const f = await fixture(async input => {
    calls++; await controller.accountTool(40, 0, input.request_id);
    const proposal = fragment(Number(input.task.id.slice(4)));
    if (input.task.id === 'unit0') {
      const second = structuredClone(proposal.lots[0]!.items[0]!);
      second.note = { value: '', evidence: [], reason: '第二个虚构条目没有单独附注' };
      if (!duplicate) second.id = 'item-2';
      proposal.lots[0]!.items.push(second);
    }
    input.validate_fragment(proposal);
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(proposal));
  }); controller = f.controller;
  expect(await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).toMatchObject({ ok: false,
    results: [{ ok: false, error: 'fragment_structure_invalid', issues: [expect.objectContaining({ path: '/lots/0/items/1/id' })],
      next_tool: 'parallel_acceptance_extract', next_tool_arguments: { path: 'DELIVERY.json', tasks: [task(0)] } }, { ok: true }] });
  expect(JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).lots.map((lot: { id: string }) => lot.id)).toEqual(['unit1-lot']);
  expect(controller.state().requests.map(row => [row.status, row.attempts, row.tool_response_bytes])).toEqual([['failed', 1, 40], ['passed', 1, 40]]);
  duplicate = false;
  expect((await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1)] })).ok).toBe(true);
  expect(calls).toBe(3);
  expect(controller.state().requests.map(row => [row.attempts, row.tool_response_bytes])).toEqual([[2, 80], [1, 40]]);
  const merged = JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8'));
  expect(merged.lots.find((lot: { id: string }) => lot.id === 'unit0-lot').items.map((item: { id: string }) => item.id)).toEqual(['item', 'item-2']);
  expect(merged.lots.find((lot: { id: string }) => lot.id === 'unit1-lot').items[0].id).toBe('item');
  expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
  await controller.assertSources();
});

it('identifies an undeclared worker group without misreporting an in-scope lot as crossing ownership', () => {
  const base = mergeExtractionFragment(empty(), fragment(0), task(0), [ledger]);
  const proposal = fragment(1);
  proposal.lots[0]!.group_id = base.groups[0]!.id;
  proposal.groups = [];
  expect(() => mergeExtractionFragment(base, proposal, task(1), [ledger])).toThrowError(expect.objectContaining({
    code: 'fragment_structure_invalid', issues: [expect.objectContaining({ path: '/lots/0/group_id',
      actual: expect.objectContaining({ preview: JSON.stringify(base.groups[0]!.id), full_value_path: 'fragment.json#/lots/0/group_id' }),
      expected: expect.stringContaining('fragment.groups'),
    })],
  }));
  expect(proposal.groups).toEqual([]);
  expect(base.groups[0]!.lot_ids).toEqual(['unit0-lot']);
});

it('bounds structural feedback for oversized actual identifiers and retains the exact author-file pointer', () => {
  const proposal = fragment(0), hugeId = 'unit0-'.padEnd(200000, 'x');
  proposal.rules[0]!.id = hugeId; proposal.rules.push(structuredClone(proposal.rules[0]!));
  let failure: unknown;
  try { mergeExtractionFragment(empty(), proposal, task(0), [ledger]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(FragmentStructureError);
  const feedback = fragmentAdmissionFeedback(failure as FragmentStructureError);
  expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThan(32768);
  expect(feedback.issues[0]).toMatchObject({ path: '/rules/1/id', actual: { full_value_path: 'fragment.json#/rules/1/id' } });
  expect(proposal.rules[0]!.id).toBe(hugeId);
});

it.each([
  ['source version', '/source_sha256', (draft: AcceptanceDelivery) => { draft.source_sha256 = '0'.repeat(64); }],
  ['duplicate id', '/rules/1/id', (draft: AcceptanceDelivery) => { draft.rules.push(structuredClone(draft.rules[0]!)); }],
  ['missing dispositions', '/dispositions', (draft: AcceptanceDelivery) => { draft.dispositions = []; }],
  ['outside scope', '/lots/0/scope/block_ids', (draft: AcceptanceDelivery) => { draft.lots[0]!.scope.block_ids = [ledger.blocks[1]!.id]; }],
  ['missing group member', '/groups/0/lot_ids', (draft: AcceptanceDelivery) => { draft.groups[0]!.lot_ids = []; }],
  ['foreign group member', '/groups/0/lot_ids', (draft: AcceptanceDelivery) => { draft.groups[0]!.lot_ids.push('foreign-lot'); }],
] as const)('keeps the %s guard strict and reports the actual writable path', (_label, path, mutate) => {
  const proposal = fragment(0); mutate(proposal); const before = JSON.stringify(proposal);
  expect(() => mergeExtractionFragment(empty(), proposal, task(0), [ledger])).toThrowError(expect.objectContaining({
    code: 'fragment_structure_invalid', issues: [expect.objectContaining({ path,
      actual: expect.objectContaining({ preview: expect.any(String), sha256: expect.any(String), full_value_path: `fragment.json#${path}` }),
      expected: expect.any(String),
    })],
  }));
  expect(JSON.stringify(proposal)).toBe(before);
});

it('returns actionable block-local quote feedback without accepting document offsets or rewriting the fragment', () => {
  const block = ledger.blocks[1]!;
  expect(block.start).toBeGreaterThan(0);
  const bad = structuredClone(fragment(1));
  bad.rules[0]!.evidence[0] = { ...sourceQuote(ledger, block), start: block.start, end: block.end };
  const before = JSON.stringify(bad);
  let failure: unknown;
  try { mergeExtractionFragment(empty(), bad, task(1), [ledger]); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'fragment_evidence_invalid', issues: expect.arrayContaining([
    expect.objectContaining({ path: '/rules/0/evidence/0',
      actual: expect.objectContaining({ source_id: ledger.source_id, block_id: block.id, start: block.start, end: block.end }),
      expected: expect.objectContaining({ offset_basis: 'block.text', offset_unit: 'UTF-16', start_min: 0, end_max: block.text.length }),
    }),
  ]) });
  expect(JSON.stringify(bad)).toBe(before);
  expect(mergeExtractionFragment(empty(), fragment(1), task(1), [ledger]).lots).toHaveLength(1);
});

it('bounds quote diagnostics while retaining an exact pointer to oversized actual values', () => {
  const bad = structuredClone(fragment(1));
  bad.rules[0]!.evidence[0]!.source_id = 'unknown-source'.repeat(20_000);
  let failure: unknown;
  try { mergeExtractionFragment(empty(), bad, task(1), [ledger]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(FragmentEvidenceError);
  const feedback = fragmentEvidenceFeedback(failure as FragmentEvidenceError);
  expect(Buffer.byteLength(JSON.stringify(feedback), 'utf8')).toBeLessThan(32_768);
  expect(feedback.issues[0]!.actual).toMatchObject({ source_id_length: 280_000, full_quote_path: 'fragment.json#/rules/0/evidence/0' });
  expect(bad.rules[0]!.evidence[0]!.source_id).toHaveLength(280_000);
});

it('shows a bounded exact frozen slice for HTML-entity mismatches without rewriting or accepting rendered text', () => {
  const original = '<table><tr><td>虚构构件 A&gt;B</td></tr></table>';
  const frozen = buildAcceptanceSourceLedger(original), block = frozen.blocks[0]!;
  const quote = sourceQuote(frozen, block); quote.text = quote.text.replace('&gt;', '>');
  const proposal = fragment(0); proposal.rules[0]!.evidence = [quote];
  const before = JSON.stringify(proposal);
  let failure: unknown;
  try { assertFragmentEvidence(proposal, [frozen, ledger]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(FragmentEvidenceError);
  const feedback = fragmentEvidenceFeedback(failure as FragmentEvidenceError);
  expect(feedback.issues[0]!.expected).toMatchObject({ frozen_slice: { text_preview: original, text_length: original.length } });
  expect(feedback.issues[0]!.actual.text_preview).toContain('A>B');
  expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThan(32768);
  expect(JSON.stringify(proposal)).toBe(before); expect(block.text).toBe(original);
});

it('reports the exact classified context blocking a dispatch without changing drafts, checkpoint or worker usage', async () => {
  const extractor = vi.fn<AcceptanceExtractor>();
  const { controller } = await fixture(extractor);
  const draft = empty(); draft.dispositions[1]!.role = 'not_extractable'; draft.dispositions[1]!.reason = '虚构的辅助说明';
  const text = JSON.stringify(draft); await writeFile(join(controller.workRoot, 'DELIVERY.json'), text);
  const before = controller.state();
  const result = await controller.dispatch('parallel_acceptance_extract', { tasks: [{ ...task(0), block_ids: [ledger.blocks[0]!.id, ledger.blocks[1]!.id] }] });
  expect(result).toMatchObject({ ok: false, results: [{ task_id: 'unit0', error: 'extraction_scope_already_processed', actual: { blocked_count: 1, blocked_blocks: [{ block_id: ledger.blocks[1]!.id, roles: ['not_extractable'], owner_lot_ids: [] }] }, next_tool: 'parallel_acceptance_extract', worker_started: false, checkpoint_preserved: true }] });
  expect(extractor).not.toHaveBeenCalled(); expect(controller.state()).toEqual(before);
  expect(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(text);
});

it('recovers a crash after draft replacement and before the merge flag, without running or charging twice', async () => {
  const extractor = vi.fn<AcceptanceExtractor>(async input => { await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(0))); });
  const { controller, options } = await fixture(extractor);
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0)] });
  const checkpoint = controller.state();
  delete checkpoint.requests[0]!.extraction!.merged; checkpoint.requests[0]!.status = 'pending';
  await writeFile(join(controller.root, 'checkpoint.json'), JSON.stringify(checkpoint));
  const reopened = await AcceptanceAutonomousController.open(options);
  expect((await reopened.dispatch('parallel_acceptance_extract', { tasks: [task(0)] })).ok).toBe(true);
  expect(extractor).toHaveBeenCalledTimes(1);
  expect(reopened.state().budget).toEqual(checkpoint.budget);
  expect(reopened.state().requests[0]?.attempts).toBe(1);
  expect(reopened.state().requests[0]?.extraction?.merged).toBe(true);
});

it('keeps a concurrently changed author draft and retains the isolated fragment for recovery', async () => {
  let controller!: AcceptanceAutonomousController;
  const f = await fixture(async input => {
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(0)));
    await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify({ ...empty(), problems: [{ id: 'author-new', kind: 'scope', message: '新的范围疑点', affected_lot_ids: [], block_ids: [], dependency_ids: [] }] }));
  }); controller = f.controller;
  await expect(controller.dispatch('parallel_acceptance_extract', { tasks: [task(0)] })).rejects.toThrow(/changed while workers ran/);
  expect(JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).problems[0].id).toBe('author-new');
  expect(controller.state().requests[0]?.extraction?.artifact_sha256).toBeTruthy();
});

it('counts duplicated, invalid and missing dispositions as pending and suppresses stale running workers while paused', async () => {
  const { controller } = await fixture(async () => {});
  let draft = mergeExtractionFragment(empty(), fragment(0), task(0), [ledger]);
  draft.dispositions.push(structuredClone(draft.dispositions.find(row => row.block_id === task(0).block_ids[0])!));
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(draft));
  expect((await readAutonomousAcceptanceProgress(controller.root, false))?.source).toMatchObject({ processed: 0, pending: 4 });
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), '{');
  expect(await readAutonomousAcceptanceProgress(controller.root, false)).toMatchObject({ draft_state: 'invalid', source: { processed: 0, pending: 4 }, extraction: { running: 0 }, publication: { state: 'unpublished' } });
});

it('enforces each worker cap and keeps an exhausted request exhausted on retry', async () => {
  let controller!: AcceptanceAutonomousController;
  const extractor = vi.fn<AcceptanceExtractor>(async input => {
    await controller.accountTool(131072, 0, input.request_id);
    await controller.accountTool(131072, 0, input.request_id);
    await controller.accountTool(131072, 0, input.request_id);
    await controller.accountTool(131072, 0, input.request_id);
    await controller.accountTool(1, 0, input.request_id);
  });
  const f = await fixture(extractor); controller = f.controller;
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0)] });
  const before = controller.state();
  expect(before.requests[0]?.tool_response_bytes).toBe(524288);
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0)] });
  expect(controller.state().requests[0]?.tool_response_bytes).toBe(524288);
  expect(extractor).toHaveBeenCalledTimes(1);
  expect(controller.state().budget.tool_response_bytes).toBe(before.budget.tool_response_bytes);
});

it('truly overlaps independent review groups and reuses unchanged approvals', async () => {
  let active = 0, peak = 0;
  let release!: () => void;
  const overlap = new Promise<void>(resolve => { release = resolve; });
  const review = vi.fn<GroupReviewer>(async input => { active++; peak = Math.max(peak, active); if (active === 2) release(); await overlap; const result = await reviewer(input); active--; return result; });
  const { controller } = await fixture(async () => {}, review);
  let draft = empty();
  for (const index of [0, 1]) draft = mergeExtractionFragment(draft, fragment(index), task(index), [ledger]);
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(draft));
  const groups = draft.groups.map(group => ({ group_id: group.id, phase: 'full' }));
  const result = await controller.dispatch('review_acceptance_groups', { groups });
  expect(result.ok).toBe(true); expect(peak).toBe(2); expect(review).toHaveBeenCalledTimes(2);
  expect((await controller.dispatch('review_acceptance_groups', { groups })).ok).toBe(true);
  expect(review).toHaveBeenCalledTimes(2);
  const progress = await readAutonomousAcceptanceProgress(controller.root);
  expect(progress?.review.approved_groups).toBe(2);
  await writeFile(join(controller.workRoot, 'extract.mjs'), '// changed method');
  expect((await readAutonomousAcceptanceProgress(controller.root))?.review.approved_groups).toBe(0);
});

it('aborts admission and drains active callbacks before returning', async () => {
  const abort = new AbortController(); let active = 0, started = 0;
  const results = await parallelMap([0, 1, 2, 3], 2, async () => {
    started++; active++; if (started === 2) abort.abort(); await pause(); active--; return true;
  }, abort.signal);
  expect(started).toBe(2); expect(active).toBe(0); expect(results.filter(row => row.status === 'rejected')).toHaveLength(2);
});

it('seals and verifies the complete neutral delivery only after merged workers pass normal group and inventory review', async () => {
  const { controller } = await fixture(async input => {
    await writeFile(join(input.directory, 'fragment.json'), JSON.stringify(fragment(Number(input.task.id.slice(4)))));
  });
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task(0), task(1), task(2), task(3)] });
  const early = await controller.dispatch('seal_acceptance_delivery', {});
  expect(early.ok).toBe(false);
  const groups = [0, 1, 2, 3].map(index => ({ group_id: `unit${index}-group`, phase: 'full' }));
  expect((await controller.dispatch('review_acceptance_groups', { groups })).ok).toBe(true);
  const sealed = await controller.dispatch('seal_acceptance_delivery', {});
  expect(sealed).toMatchObject({ ok: true, status: 'complete', verified_lots: 4, published: false });
  await expect(verifyAutonomousSealedDelivery(sealed.path as string, ledger.sha256)).resolves.toMatchObject({ status: 'complete', lot_ids: ['unit0-lot', 'unit1-lot', 'unit2-lot', 'unit3-lot'] });
});
