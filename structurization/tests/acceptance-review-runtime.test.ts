import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { liveGroupReview } from '../src/acceptance-autonomous/runtime.js';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { reviewEvidenceId } from '../src/acceptance-autonomous/review-evidence.js';
import { toolResponseBytes } from '../src/acceptance-autonomous/tool-accounting.js';
import type { AcceptanceDelivery } from '../src/acceptance-autonomous/contracts.js';

const mocked = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../src/pi-runtime.js', async original => ({ ...await original<typeof import('../src/pi-runtime.js')>(), runLiveConstrainedSession: mocked.session }));
const parent = resolve('.codex-tmp'), roots: string[] = [];
afterEach(async () => {
  mocked.session.mockReset();
  for (const root of roots.splice(0)) {
    const inside = relative(parent, resolve(root));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const text = '虚构温控器🌡：温差不得超过 2 K。' + Array.from({ length: 60 }, (_, i) => `\n\n无关合成泵 ${i}：流量不得超过 ${i + 1} L/s。`).join('');
  const source = buildAcceptanceSourceLedger(text), block = source.blocks[0]!, quote = sourceQuote(source, block);
  const bound = { value: block.text, evidence: [quote] }, absent = { value: '', evidence: [], reason: '合成原文未规定' };
  const delivery: AcceptanceDelivery = { schema_version: 'acceptance-autonomous-delivery/v1', source_sha256: source.sha256,
    rules: [{ id: 'semantic', method_files: [], scope: '合成温控正文', exceptions: [], evidence: [quote] }],
    groups: [{ id: 'sensors', structure: '合成温控正文', rule_ids: ['semantic'], lot_ids: ['sensor'], trial_lot_ids: ['sensor'], boundary_lot_ids: [], conditions: '合成温控器', exclusions: [] }],
    lots: [{ id: 'sensor', name: bound, ancestors: [], scope: { block_ids: [block.id], reason: '合成温控器单独成批', evidence: [quote] }, group_id: 'sensors', dependency_ids: [],
      items: [{ id: 'temperature', name: bound, category: absent, requirement: bound, method: absent, quantity: absent, unit: absent, condition: absent, note: absent,
        inspection_data_type: 'review', inspection_data_type_reason: '合成条款核对', sampling: { status: 'not_sampling', text: absent, conditions: [] }, reference_ids: [], rule_ids: ['semantic'] }] }],
    references: [], problems: [], dispositions: source.blocks.map(row => ({ source_id: source.source_id, block_id: row.id,
      role: row === block ? 'lot' : 'not_extractable', lot_ids: row === block ? ['sensor'] : [], reason: '合成测试的已知范围', evidence: [sourceQuote(source, row)] })) };
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'review-runtime-')); roots.push(root);
  const markdownPath = join(root, 'original.md'); await writeFile(markdownPath, text);
  let controller!: AcceptanceAutonomousController;
  controller = await AcceptanceAutonomousController.open({ root: join(root, 'run'), markdownPath,
    limits: { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 2 },
    subtaskToolResponseBytes: 524288, reviewer: (request, signal) => liveGroupReview(controller, request, undefined, signal) });
  await writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(delivery));
  return { controller, source };
}
const resultWith = (evidence: unknown[]) => ({ approved: false, reviewed_lot_ids: ['sensor'], reason: '发现合成候选的局部差异。',
  lot_decisions: [{ lot_id: 'sensor', approved: false, reason: '需修复合成温差。' }],
  findings: [{ lot_id: 'sensor', path: '/items/temperature/requirement', message: '合成温差需按原文核对。', evidence }] });

it('accepts ID-only review evidence through the actual tool and stores canonical receipts without resetting usage', async () => {
  const { controller, source } = await fixture(), replies: any[] = [];
  await controller.accountTool(123);
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const request = JSON.parse(await readFile(join(context.root, 'request.json'), 'utf8'));
    const frozen = JSON.parse(await readFile(request.sources[0].context_file, 'utf8'));
    const submit = options.customTools.find((tool: any) => tool.name === 'submit_acceptance_review');
    replies.push(await submit.execute('bad-id', resultWith([{ evidence_id: 'ev:invented' }]), undefined, undefined, {}));
    expect(replies[0].details).toMatchObject({ ok: false, error: 'review_submission_invalid', next_tool: 'submit_acceptance_review' });
    expect(await options.completed()).toBe(false);
    replies.push(await submit.execute('source-id', resultWith([{ evidence_id: frozen.blocks[0].evidence_id }]), undefined, undefined, {}));
    expect(replies[1].details).toEqual({ ok: true }); expect(await options.completed()).toBe(true);
    return {};
  });
  expect((await controller.dispatch('review_acceptance_group', { group_id: 'sensors', phase: 'full' })).ok).toBe(false);
  const state = controller.state(), request = state.requests.at(-1)!;
  expect(request).toMatchObject({ status: 'needs_work', attempts: 1, result: { approved: false } });
  expect(request.result!.findings[0]!.evidence).toEqual([sourceQuote(source, source.blocks[0]!)]);
  expect(request.tool_response_bytes).toBe(replies.reduce((n, reply) => n + toolResponseBytes(reply), 0));
  expect(state.budget.tool_response_bytes).toBe(123 + request.tool_response_bytes!);
  expect(state.budget.max_tool_response_bytes).toBe(524288);
  expect(state.approvals).toEqual([]); expect(state.publications).toEqual([]); await controller.assertSources();
});

it('expands by a short source reference and records only returned block text as exposure', async () => {
  const { controller, source } = await fixture(), target = source.blocks[50]!;
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const request = JSON.parse(await readFile(join(context.root, 'request.json'), 'utf8'));
    const submit = options.customTools.find((tool: any) => tool.name === 'submit_acceptance_review');
    const evidence = [{ evidence_id: reviewEvidenceId(source, target), excerpt: target.text }];
    const denied = await submit.execute('not-expanded', resultWith(evidence), undefined, undefined, {});
    expect(denied.details).toMatchObject({ ok: false, error: 'review_submission_invalid' });
    const expand = options.customTools.find((tool: any) => tool.name === 'expand_acceptance_review_source');
    const expanded = await expand.execute('expand', { source_id: request.sources[0].source_ref, reason: '合成关联位于原片段之外' }, undefined, undefined, {});
    expect(expanded.details.ok).toBe(true);
    const file = await readFile(expanded.details.context_file, 'utf8');
    const position = file.indexOf(`"text": ${JSON.stringify(target.text)}`);
    expect(position).toBeGreaterThan(0);
    const offset = file.slice(0, position).split('\n').length;
    const read = options.customTools.find((tool: any) => tool.name === 'read');
    await read.execute('read-one-block', { path: expanded.details.context_file, offset, limit: 1 }, undefined, undefined, {});
    expect((await submit.execute('expanded-id', resultWith(evidence), undefined, undefined, {})).details).toEqual({ ok: true });
    return {};
  });
  await controller.dispatch('review_acceptance_group', { group_id: 'sensors', phase: 'full' });
  const request = controller.state().requests.at(-1)!;
  const exposure = new Set(request.exposed_lots?.flatMap(row => row.block_ids));
  expect(exposure.has(target.id)).toBe(true);
  expect(exposure.has(source.blocks[49]!.id)).toBe(false);
  expect(exposure.has(source.blocks[51]!.id)).toBe(false);
  expect(request.result!.findings[0]!.evidence[0]).toEqual(sourceQuote(source, target));
});
