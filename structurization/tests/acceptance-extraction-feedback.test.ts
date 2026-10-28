import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AcceptanceAutonomousController, type AcceptanceControllerOptions } from '../src/acceptance-autonomous/controller.js';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { liveExtraction } from '../src/acceptance-autonomous/runtime.js';
import { toolResponseBytes } from '../src/acceptance-autonomous/tool-accounting.js';
import type { AcceptanceDelivery, SourceQuote } from '../src/acceptance-autonomous/contracts.js';

const mocked = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../src/pi-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/pi-runtime.js')>(), runLiveConstrainedSession: mocked.session,
}));
const parent = resolve('.codex-tmp');
const roots: string[] = [];
afterEach(async () => {
  mocked.session.mockReset();
  for (const root of roots.splice(0)) {
    const inside = relative(parent, resolve(root));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Refuse cleanup outside this test directory');
    await rm(root, { recursive: true, force: true });
  }
});
const source = '虚构资料说明。\n\n合成乙构件长度允许偏差4mm。';
const ledger = buildAcceptanceSourceLedger(source), block = ledger.blocks[1]!;
const task = { id: 'fiction', block_ids: [block.id], instruction: '只处理合成构件原文', method_files: ['extract.mjs'] };
const empty = (): AcceptanceDelivery => ({ schema_version: 'acceptance-autonomous-delivery/v1', source_sha256: ledger.sha256,
  rules: [], groups: [], lots: [], references: [], problems: [], dispositions: ledger.blocks.map(row => ({
    source_id: ledger.source_id, block_id: row.id, role: 'unresolved', lot_ids: [], reason: '虚构待办', evidence: [sourceQuote(ledger,row)],
  })) });
function fragment(quote: SourceQuote): AcceptanceDelivery {
  const bound = { value: block.text, evidence: [quote] }, absent = { value: '', evidence: [], reason: '虚构原文未说明' };
  return { ...empty(), rules: [{ id: 'fiction-rule', method_files: ['extract.mjs'], scope: '合成构件', exceptions: [], evidence: [quote] }],
    groups: [{ id: 'fiction-group', structure: '合成正文', rule_ids: ['fiction-rule'], lot_ids: ['fiction-lot'], trial_lot_ids: ['fiction-lot'], boundary_lot_ids: [], conditions: '当前合成构件', exclusions: [] }],
    lots: [{ id: 'fiction-lot', name: bound, ancestors: [], scope: { block_ids: [block.id], reason: '合成具名正文', evidence: [quote] }, group_id: 'fiction-group', dependency_ids: [],
      items: [{ id: 'item', name: bound, category: absent, requirement: bound, method: absent, quantity: absent, unit: absent, condition: absent, note: absent,
        inspection_data_type: 'measurement', inspection_data_type_reason: '合成尺寸', sampling: { status: 'reference_unspecified_quantity', text: absent, conditions: [] }, reference_ids: [], rule_ids: ['fiction-rule'] }] }],
    dispositions: [{ source_id: ledger.source_id, block_id: block.id, role: 'lot', lot_ids: ['fiction-lot'], reason: '合成构件', evidence: [quote] }] };
}
async function fixture(extra: Partial<Pick<AcceptanceControllerOptions, 'originalPdf' | 'renderOriginalPdfPage'>> = {}) {
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'extraction-feedback-')); roots.push(root);
  const markdownPath = join(root, 'original.md'); await writeFile(markdownPath, source);
  let controller!: AcceptanceAutonomousController;
  controller = await AcceptanceAutonomousController.open({ root: join(root,'run'), markdownPath,
    limits: { max_tool_response_bytes: 1048576, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 2 },
    subtaskToolResponseBytes: 524288, ...extra, extractor: (input, signal) => liveExtraction(controller, input, undefined, signal) });
  await writeFile(join(controller.workRoot,'DELIVERY.json'), JSON.stringify(empty()));
  await writeFile(join(controller.workRoot,'extract.mjs'), '// neutral method\n');
  await controller.beginSession(); return controller;
}
const call = (tool: any) => tool.execute('neutral-test', {}, undefined, undefined, {});

it('charges a worker original-page reply once and exposes only its frozen source path', async () => {
  await mkdir(parent, { recursive: true }); const archive = await mkdtemp(join(parent, 'original-page-accounting-')); roots.push(archive);
  const pdf = Buffer.from('%PDF-1.4 Synthetic original'), originalPath = join(archive, 'registered.pdf'); await writeFile(originalPath, pdf);
  const pixels = Buffer.from('neutral raster'), replies: any[] = [];
  const controller = await fixture({ originalPdf: { path: originalPath, sha256: createHash('sha256').update(pdf).digest('hex') },
    renderOriginalPdfPage: async () => ({ ok: true, page_count: 1, image: pixels }) });
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const tool = options.customTools.find((row: any) => row.name === 'open_acceptance_source_page');
    const reply = await tool.execute('neutral-page', { source_id: ledger.source_id, block_id: block.id, page_number: 1 }, undefined, undefined, {});
    replies.push(reply);
    expect(reply.details).toMatchObject({ ok: true, next_tool: 'read' });
    expect(await readFile(join(context.root, reply.details.image_path))).toEqual(pixels);
    expect(JSON.stringify(reply)).not.toContain(originalPath);
    return { error: 'neutral interruption after reading page metadata' };
  });
  await controller.dispatch('parallel_acceptance_extract', { tasks: [task] });
  expect(controller.state().requests[0]).toMatchObject({ attempts: 1, tool_response_bytes: toolResponseBytes(replies[0]) });
  expect(controller.state().budget.max_single_tool_response_bytes).toBe(131072);
  expect(controller.state().publications).toEqual([]); await controller.assertSources();
});

it.each(['evidence', 'group'] as const)('preserves the unresolved %s diagnosis when the worker stops before terminal acceptance', async field => {
  const controller = await fixture();
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const invalid = fragment(sourceQuote(ledger, block));
    if (field === 'evidence') invalid.rules[0]!.evidence[0]!.text = '不存在的合成引文';
    else invalid.groups = [];
    await writeFile(join(context.root, 'fragment.json'), JSON.stringify(invalid));
    await call(options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment'));
    return { error: 'agent_stopped_before_terminal_tool: neutral incomplete result' };
  });
  expect(await controller.dispatch('parallel_acceptance_extract', { tasks: [task] })).toMatchObject({ ok: false, results: [
    expect.objectContaining({ error: `fragment_${field === 'evidence' ? 'evidence' : 'structure'}_invalid`,
      issues: expect.arrayContaining([expect.objectContaining({ actual: expect.any(Object), expected: expect.anything() })]),
      writable: expect.any(String), next_tool: 'parallel_acceptance_extract', next_tool_arguments: { path: 'DELIVERY.json', tasks: [task] } }),
  ] });
  expect(controller.state().requests[0]).toMatchObject({ status: 'failed', attempts: 1 });
  expect(controller.state().requests[0]!.tool_response_bytes).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).lots).toEqual([]);
  expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
});

it('does not replace a provider termination with an earlier admission rejection', async () => {
  const controller = await fixture();
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const invalid = fragment(sourceQuote(ledger, block)); invalid.groups = [];
    await writeFile(join(context.root, 'fragment.json'), JSON.stringify(invalid));
    await call(options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment'));
    return { error: 'provider unavailable' };
  });
  expect(await controller.dispatch('parallel_acceptance_extract', { tasks: [task] })).toMatchObject({ ok: false,
    results: [expect.objectContaining({ error: expect.stringContaining('provider unavailable') })] });
});

it('repairs invalid evidence within the isolated SDK session and preserves usage across its retry', async () => {
  const controller = await fixture(), responses: unknown[] = [], observed: any[] = [];
  const bad = fragment({ ...sourceQuote(ledger, block), start: block.start, end: block.end });
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    await writeFile(join(context.root,'fragment.json'), JSON.stringify(bad));
    const submit = options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment');
    const first = await call(submit); responses.push(first);
    const second = await call(submit); responses.push(second);
    observed.push({ first: first.details, second: second.details, completed: await options.completed(),
      fragment: await readFile(join(context.root,'fragment.json'),'utf8'),
      diagnostics: JSON.parse(await readFile(join(context.root,first.details.diagnostics),'utf8')) });
    return { error: 'neutral interruption after feedback' };
  });
  const interrupted = await controller.dispatch('parallel_acceptance_extract', { tasks: [task] });
  expect(interrupted.ok).toBe(false);
  expect(observed[0].first).toMatchObject({ ok: false, error: 'fragment_evidence_invalid', next_tool: 'submit_acceptance_fragment' });
  expect(observed[0].first.issues.length).toBeLessThan(observed[0].first.total_issues);
  expect(observed[0].diagnostics.issues).toHaveLength(observed[0].first.total_issues);
  expect(observed[0].second).toMatchObject({ ok: false, unchanged: true });
  expect(toolResponseBytes(responses[1])).toBeLessThan(toolResponseBytes(responses[0]));
  expect(observed[0].completed).toBe(false);
  expect(observed[0].fragment).toBe(JSON.stringify(bad));
  const previous = controller.state().requests[0]!;
  expect(previous.attempts).toBe(1);
  const priorBytes = previous.tool_response_bytes;
  expect(priorBytes).toBe(responses.reduce<number>((sum,row) => sum + toolResponseBytes(row),0));
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const request = JSON.parse(await readFile(join(context.root,'request.json'),'utf8'));
    observed.push({ request, completedBefore: await options.completed(), prompt: options.prompt });
    const submit = options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment');
    const rejected = await call(submit); responses.push(rejected);
    await writeFile(join(context.root,'fragment.json'),JSON.stringify(fragment(sourceQuote(ledger,block))));
    const accepted = await call(submit); responses.push(accepted);
    observed.push({ rejected: rejected.details, accepted: accepted.details, completed: await options.completed() });
    return {};
  });
  expect((await controller.dispatch('parallel_acceptance_extract',{tasks:[task]})).ok).toBe(true);
  expect(observed[1].request).not.toHaveProperty('validate_fragment');
  expect(observed[1].completedBefore).toBe(false);
  expect(observed[1].prompt).toContain('若已有 fragment.json');
  expect(observed[2]).toMatchObject({ rejected: { ok: false, error: 'fragment_evidence_invalid' }, accepted: { ok: true, semantic_approval: false }, completed: true });
  const after = controller.state();
  expect(after.requests).toHaveLength(1); expect(after.requests[0]!.attempts).toBe(2);
  expect(after.requests[0]!.tool_response_bytes).toBe(responses.reduce<number>((sum,row) => sum + toolResponseBytes(row),0));
  expect(after.requests[0]!.tool_response_bytes).toBeGreaterThan(priorBytes);
  expect(after.budget).toMatchObject({ attempts: 1, max_attempts: 12, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000 });
  expect(after.approvals).toEqual([]); expect(after.publications).toEqual([]);
  await controller.assertSources();
});

it.each(['evidence', 'group'] as const)('still rejects %s changed after a successful worker submission at host admission', async field => {
  const controller = await fixture(); let accepted: any;
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const valid = fragment(sourceQuote(ledger,block));
    await writeFile(join(context.root,'fragment.json'),JSON.stringify(valid));
    accepted = await call(options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment'));
    const tampered = structuredClone(valid);
    if (field === 'evidence') tampered.rules[0]!.evidence[0]!.text = '虚构但并不存在的证据';
    else tampered.groups = [];
    await writeFile(join(context.root,'fragment.json'),JSON.stringify(tampered));
    return {};
  });
  const result = await controller.dispatch('parallel_acceptance_extract',{tasks:[task]});
  expect(accepted.details).toMatchObject({ ok: true, semantic_approval: false });
  expect(result).toMatchObject({ ok: false, results: [expect.objectContaining({ error: field === 'evidence' ? 'fragment_evidence_invalid' : 'fragment_structure_invalid', next_tool: 'parallel_acceptance_extract',
    next_tool_arguments: { path: 'DELIVERY.json', tasks: [task] } })] });
  expect(controller.state().requests[0]!.extraction?.merged).not.toBe(true);
  expect(JSON.parse(await readFile(join(controller.workRoot,'DELIVERY.json'),'utf8')).lots).toEqual([]);
  expect(controller.state().publications).toEqual([]);
});

it('returns missing-group feedback inside the same SDK session without approving or resetting its request', async () => {
  const controller = await fixture(), replies: any[] = [], completed: boolean[] = [];
  mocked.session.mockImplementationOnce(async (context: any, options: any) => {
    const valid = fragment(sourceQuote(ledger, block)), missing = structuredClone(valid);
    missing.groups = []; missing.lots[0]!.group_id = 'fiction-existing-main-group';
    await writeFile(join(context.root, 'fragment.json'), JSON.stringify(missing));
    const submit = options.customTools.find((tool: any) => tool.name === 'submit_acceptance_fragment');
    replies.push(await call(submit)); completed.push(await options.completed());
    replies.push(await call(submit)); completed.push(await options.completed());
    await writeFile(join(context.root, 'fragment.json'), JSON.stringify(valid));
    replies.push(await call(submit)); completed.push(await options.completed());
    return {};
  });
  const result = await controller.dispatch('parallel_acceptance_extract', { tasks: [task] });
  expect(result.ok).toBe(true);
  expect(replies[0].details).toMatchObject({ ok: false, error: 'fragment_structure_invalid', next_tool: 'submit_acceptance_fragment',
    issues: [expect.objectContaining({ path: '/lots/0/group_id', actual: expect.objectContaining({ preview: '"fiction-existing-main-group"' }),
      expected: expect.stringContaining('fragment.groups') })] });
  expect(replies[1].details).toMatchObject({ ok: false, unchanged: true });
  expect(toolResponseBytes(replies[1])).toBeLessThan(toolResponseBytes(replies[0]));
  expect(replies[2].details).toEqual({ ok: true, semantic_approval: false });
  expect(completed).toEqual([false, false, true]);
  expect(controller.state().requests).toHaveLength(1);
  expect(controller.state().requests[0]).toMatchObject({ status: 'passed', attempts: 1, tool_response_bytes: replies.reduce((sum, reply) => sum + toolResponseBytes(reply), 0) });
  expect(controller.state().budget).toMatchObject({ max_attempts: 12, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000 });
  expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
  await controller.assertSources();
});
