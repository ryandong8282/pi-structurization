import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { buildAcceptanceSourceLedger, referenceSourceField, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { eligibleLotIds, groupReviewBlockers, validateAcceptanceDelivery } from '../src/acceptance-autonomous/validation.js';
import { acceptanceReviewView, createAcceptanceAutonomousTools, formatAcceptanceReviewJson } from '../src/acceptance-autonomous/runtime.js';
import { reviewSubmissionIssues } from '../src/acceptance-autonomous/review.js';
import { verifyAutonomousSealedDelivery } from '../src/acceptance-autonomous/sealed.js';
import { toolResponseBytes, reconcileToolResponses } from '../src/acceptance-autonomous/tool-accounting.js';
import { sha256Json, sha256Text } from '../src/canonical.js';
import { installLotSplitHandoff, type LotSplitHandoff } from '../src/acceptance-autonomous/lot-split-handoff.js';
import { runLengthContinuationLoop } from '../src/pi-runtime.js';
import type { AcceptanceDelivery, AcceptanceLot, BoundText, GroupReviewer, GroupReviewRequest, SourceBlock, SourceLedger } from '../src/acceptance-autonomous/contracts.js';

const dirs: string[] = [];
const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const limits = { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072,
  max_observed_context_tokens: 192000, max_attempts: 3, concurrency: 8 };
const original = '# 虚构构件验收\n\n'
  + '<table><tr><td>验收项目</td><td>允许偏差</td><td>单位</td></tr><tr><td>甲构件长度</td><td>5</td><td>mm</td></tr></table>\n\n'
  + '<!-- pages_002_003 -->\n\n'
  + '<table><tr><td>验收项目</td><td>允许偏差</td><td>单位</td></tr><tr><td>乙构件长度</td><td>7</td><td>mm</td></tr></table>\n\n'
  + '注：本例用于说明版式。\n\n'
  + '丙构件外观应完整。\n';

function bind(ledger: SourceLedger, block: SourceBlock, text: string): BoundText {
  const start = block.text.indexOf(text);
  if (start < 0) throw new Error('Fixture quote missing');
  return { value: text, evidence: [sourceQuote(ledger, block, start, start + text.length)] };
}
const absent = (): BoundText => ({ value: '', evidence: [], reason: '虚构原文没有该字段。' });

function candidate(ledger: SourceLedger): AcceptanceDelivery {
  const tables = ledger.blocks.filter(block => block.kind === 'table');
  const prose = ledger.blocks.find(block => block.text === '丙构件外观应完整。')!;
  const used = [...tables.slice(0, 2), prose];
  const lots: AcceptanceLot[] = used.map((block, i) => {
    const name = ['甲构件长度', '乙构件长度', '丙构件'][i]!;
    return { id: `lot-${i}`, name: bind(ledger, block, name), ancestors: [],
      scope: { block_ids: [block.id], reason: '原文具名的独立验收对象。', evidence: [sourceQuote(ledger, block)] },
      group_id: i < 2 ? 'tables' : 'prose', dependency_ids: [], items: [{ id: 'item', name: bind(ledger, block, name),
        category: { value: '原文未标明类别', mode: 'summary', evidence: [sourceQuote(ledger, block)], reason: '核对当前范围未标主控/一般。' },
        requirement: bind(ledger, block, ['5', '7', '外观应完整'][i]!), method: absent(), quantity: absent(),
        unit: i < 2 ? bind(ledger, block, 'mm') : absent(), condition: absent(), note: absent(), inspection_data_type: i < 2 ? 'measurement' : 'review',
        inspection_data_type_reason: '依原文数值长度或外观判据判断。', sampling: { status: 'reference_unspecified_quantity', text: absent(), conditions: [] },
        reference_ids: [], rule_ids: [i < 2 ? 'table-rule' : 'prose-rule'] }] };
  });
  return { schema_version: 'acceptance-autonomous-delivery/v1', source_sha256: ledger.sha256,
    rules: [{ id: 'table-rule', method_files: ['extract.mjs'], scope: '两列长度表', exceptions: ['其他表式'], evidence: [sourceQuote(ledger, tables[0]!)] },
      { id: 'prose-rule', method_files: [], scope: '具名外观条款', exceptions: ['长度表'], evidence: [sourceQuote(ledger, prose)] }],
    groups: [{ id: 'tables', structure: '项目、偏差、单位三列', rule_ids: ['table-rule'], lot_ids: ['lot-0', 'lot-1'], trial_lot_ids: ['lot-0'], boundary_lot_ids: [], conditions: '长度', exclusions: ['正文'] },
      { id: 'prose', structure: '正文式判据', rule_ids: ['prose-rule'], lot_ids: ['lot-2'], trial_lot_ids: ['lot-2'], boundary_lot_ids: [], conditions: '外观', exclusions: ['表格'] }],
    lots, dispositions: ledger.blocks.map(block => ({ source_id: ledger.source_id, block_id: block.id,
      role: used.includes(block) ? 'lot' : 'not_extractable', lot_ids: lots.filter(lot => lot.scope.block_ids.includes(block.id)).map(lot => lot.id),
      reason: used.includes(block) ? '归入具名对象。' : '标题、分页或一般说明；保留原文供范围复核。', evidence: [sourceQuote(ledger, block)] })), references: [], problems: [] };
}

const approved: GroupReviewer = async request => ({ approved: true, reviewed_lot_ids: request.lots.map(lot => lot.id), findings: [], reason: '已独立核对本次要求的来源、字段和范围。' });

async function registerFictionalSplit(f: Awaited<ReturnType<typeof setup>>, footer = false) {
  const groups = new Map<string, typeof f.ledger.blocks>();
  f.ledger.blocks.forEach((block, i) => {
    const owner = i === 0 ? 'lot-0' : footer && block.text.startsWith('注：') ? 'lot-1'
      : f.delivery.lots.find(lot => lot.scope.block_ids.includes(block.id))?.id ?? `non-${i}`;
    groups.set(owner, [...(groups.get(owner) ?? []), block]);
  });
  const handoff: LotSplitHandoff = { schema_version: 'acceptance-lot-split-handoff/v1', source_sha256: f.ledger.sha256,
    manifest_sha256: 'a'.repeat(64), pdf_sha256: null, history: { checkpoint_sha256: 'b'.repeat(64), tool_calls: 4, tool_response_bytes: 42, sessions: 1, limits: {} },
    decisions: [...groups].map(([id, blocks]) => ({ id, name: id, kind: id.startsWith('lot-') ? 'lot' : 'non_lot', reason: 'Synthetic complete boundaries', related_lot_ids: [],
      source: blocks.map(block => ({ ...sourceQuote(f.ledger, block), block: f.ledger.blocks.indexOf(block), start_line: block.start_line, end_line: block.end_line })) })) };
  await installLotSplitHandoff(f.options.root, handoff, f.ledger);
}

async function setup(reviewer: GroupReviewer = approved, source = original, subtaskToolResponseBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-autonomous-')); dirs.push(dir);
  const markdownPath = join(dir, 'original.md'); await writeFile(markdownPath, source);
  const root = join(dir, 'run');
  const options = { root, markdownPath, limits, reviewer, ...(subtaskToolResponseBytes === undefined ? {} : { subtaskToolResponseBytes }) };
  const controller = await AcceptanceAutonomousController.open(options);
  const ledger = buildAcceptanceSourceLedger(source);
  const delivery = candidate(ledger);
  await writeFile(join(controller.workRoot, 'extract.mjs'), '// document-learned extraction method\n');
  const save = () => writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(delivery));
  await save();
  return { controller, options, ledger, delivery, save, dir };
}

it('keeps unchanged local receipts through a rejected inventory and requires explicit inventory resolution before publication', async () => {
  let inventoryMode: 'reject' | 'generic' | 'answer' = 'reject', localCalls = 0, inventoryCalls = 0;
  let c!: AcceptanceAutonomousController;
  const reviewer: GroupReviewer = async request => {
    await c.accountTool(31, 0, request.id);
    if (request.phase !== 'inventory') { localCalls++; return approved(request); }
    inventoryCalls++;
    if (inventoryMode === 'reject') return { approved: false, reviewed_lot_ids: request.group.lot_ids,
      reason: '合成标题的非抽取范围需明确说明。', findings: [{ lot_id: '', path: '/inventory/title',
        message: '需核对合成标题的去向。', evidence: [sourceQuote(request.sources[0]!, request.sources[0]!.blocks[0]!)] }] };
    return { approved: true, reviewed_lot_ids: request.group.lot_ids, reason: '已按原文核对标题与所有业务范围。', findings: [],
      ...(inventoryMode === 'answer' ? { failure_responses: (request.failure_checks ?? []).map(check => ({ check_id: check.id,
        disposition: 'not_applicable' as const, reason: '标题无独立验收判据，现有非抽取范围说明与原文一致。', evidence: check.evidence })) } : {}) };
  };
  const f = await setup(reviewer, original, 524288);
  c = await AcceptanceAutonomousController.open({ ...f.options, requireExplicitFailureResolution: true });
  for (const group_id of ['tables', 'prose']) expect((await c.dispatch('review_acceptance_group', { group_id, phase: 'full' })).ok).toBe(true);
  const before = c.state(); expect(before.approvals).toHaveLength(2);
  const rejected = await c.dispatch('seal_acceptance_delivery', {});
  expect(rejected.ok).toBe(false);
  await c.dispatch('validate_acceptance_delivery', {});
  await c.dispatch('acceptance_workspace', {});
  expect(c.state().approvals).toHaveLength(2);
  expect(localCalls).toBe(2);
  expect(c.state().publications).toEqual([]);
  expect(JSON.parse(await readFile(join(c.workRoot, rejected.findings_file as string), 'utf8')).result.findings).toHaveLength(1);
  await c.dispatch('seal_acceptance_delivery', {});
  expect(inventoryCalls).toBe(1); // A concrete unchanged rejection is not another paid retry.

  f.delivery.dispositions[0]!.reason = '合成文档标题，无独立验收判据；保留在全文非抽取范围。';
  await f.save(); inventoryMode = 'generic';
  expect((await c.dispatch('seal_acceptance_delivery', {})).ok).toBe(false);
  expect(c.state().approvals).toHaveLength(2);
  const incomplete = c.state().requests.at(-1)!;
  expect(incomplete.failure_checks).toMatchObject([{ lot_id: '', path: '/inventory/title' }]);
  const usage = c.state().budget.tool_response_bytes;
  inventoryMode = 'answer';
  const sealed = await c.dispatch('seal_acceptance_delivery', {});
  expect(sealed).toMatchObject({ ok: true, status: 'complete', verified_lots: 3 });
  expect(localCalls).toBe(2); expect(inventoryCalls).toBe(3);
  expect(c.state().requests.at(-1)).toMatchObject({ id: incomplete.id, attempts: 2, tool_response_bytes: 62, status: 'passed' });
  expect(c.state().budget.tool_response_bytes).toBe(usage + 31);
  expect(c.state().budget.max_tool_response_bytes).toBe(before.budget.max_tool_response_bytes);
  expect(c.state().requests.some(row => row.phase === 'inventory' && row.result?.findings.length)).toBe(true);
  await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
});

it('requires an evidence-bound answer to each historical finding before resolving it or publishing', async () => {
  let reject = true, answerFailures = false;
  const reviewer = vi.fn(async (request: GroupReviewRequest) => {
    if (reject) return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '中性样本把原文的5误写为6。',
      findings: [{ lot_id: 'lot-0', path: '/lots/lot-0/items/item/requirement', message: '应按原文长度判据保留5，不得变成6。', evidence: request.lots[0]!.items[0]!.requirement.evidence }] };
    return { ...await approved(request), ...(answerFailures ? { failure_responses: request.failure_checks?.map(check => ({
      check_id: check.id, disposition: 'fixed' as const, reason: '已将当前长度判据改回来源中的5，并核对对应单位及适用对象。', evidence: request.lots.find(lot => lot.id === check.lot_id)!.items[0]!.requirement.evidence,
    })) ?? [] } : {}) };
  });
  const f = await setup(reviewer, original, 524288), c = await AcceptanceAutonomousController.open({ ...f.options, requireExplicitFailureResolution: true });
  f.delivery.lots[0]!.items[0]!.requirement = { ...f.delivery.lots[0]!.items[0]!.requirement, value: '6', mode: 'summary', reason: '用于回归的错误归纳。' };
  await f.save(); await c.accountTool(123);
  const args = { path: 'DELIVERY.json', group_id: 'tables', phase: 'full' };
  expect((await c.dispatch('review_acceptance_group', args)).ok).toBe(false);
  const first = c.state().requests[0]!;
  f.delivery.lots[0]!.items[0]!.requirement = bind(f.ledger, f.ledger.blocks.find(block => block.kind === 'table')!, '5');
  await f.save(); reject = false;
  expect((await c.dispatch('review_acceptance_group', args)).ok).toBe(false);
  expect(reviewer.mock.calls[1]![0].failure_checks).toMatchObject([{ request_id: first.id, lot_id: 'lot-0', finding_index: 0 }]);
  expect(c.state().approvals).toHaveLength(0);
  const retry = c.state().requests.at(-1)!;
  await c.accountTool(79, 0, retry.id); const before = c.state().budget;
  answerFailures = true;
  expect((await c.dispatch('review_acceptance_group', args)).ok).toBe(true);
  expect(c.state().requests).toHaveLength(2);
  expect(c.state().requests[0]).toEqual(first);
  expect(c.state().requests[1]).toMatchObject({ id: retry.id, attempts: 2, tool_response_bytes: 79 });
  expect(c.state().budget).toEqual(before);
  expect(await c.dispatch('seal_acceptance_group', { ...args, mode: 'semantic_exception', reason: '中性例子按完整成员语义复核，明确核销已修复的错误。' })).toMatchObject({ ok: true });
  expect((await c.dispatch('review_acceptance_group', { ...args, group_id: 'prose' })).ok).toBe(true);
  const sealed = await c.dispatch('seal_acceptance_delivery', { path: 'DELIVERY.json' });
  expect(sealed.ok).toBe(true);
  expect(await verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).toMatchObject({ status: 'complete', review_failure_policy: 'explicit/v1' });
});

it('upgrades old generic passes without resetting history, accepts evidence-based overturns and reuses the resolved receipt', async () => {
  let reject = true;
  const reviewer: GroupReviewer = async request => reject ? { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id),
    findings: [{ lot_id: 'lot-0', path: '/lots/lot-0/items/item/unit', message: '单位应改为 cm。', evidence: request.lots[0]!.items[0]!.unit.evidence }], reason: '故意设置的错误审查意见。' }
    : { ...await approved(request), failure_responses: request.failure_checks?.map(check => ({ check_id: check.id, disposition: 'not_applicable',
      reason: '原文单位为 mm，当前字段也是 mm；旧意见要求 cm 没有原文依据。', evidence: request.lots.find(lot => lot.id === check.lot_id)!.items[0]!.unit.evidence })) };
  const f = await setup(reviewer, original, 524288), args = { path: 'DELIVERY.json', group_id: 'tables', phase: 'full' };
  expect((await f.controller.dispatch('review_acceptance_group', args)).ok).toBe(false);
  f.delivery.groups[0]!.conditions = '原文指定长度及单位'; await f.save(); reject = false;
  expect((await f.controller.dispatch('review_acceptance_group', args)).ok).toBe(true);
  await f.controller.accountTool(57, 0, f.controller.state().requests.at(-1)!.id);
  const before = f.controller.state();
  const c = await AcceptanceAutonomousController.open({ ...f.options, requireExplicitFailureResolution: true });
  expect(c.state().budget).toEqual(before.budget);
  expect(c.state().requests).toEqual(before.requests);
  await c.dispatch('validate_acceptance_delivery', { path: 'DELIVERY.json' });
  expect(c.state().approvals).toHaveLength(0);
  expect((await c.dispatch('review_acceptance_group', args)).ok).toBe(true);
  expect(c.state().requests).toHaveLength(3);
  expect(c.state().requests.slice(0, 2)).toEqual(before.requests);
  expect(c.state().requests.at(-1)!.result!.failure_responses).toMatchObject([{ disposition: 'not_applicable' }]);
  expect((await c.dispatch('review_acceptance_group', args)).cached).toBe(true);
  expect(c.state().requests).toHaveLength(3);
  expect(c.state().budget).toEqual(before.budget);
});

async function registerSharedPlanningFixture(f: Awaited<ReturnType<typeof setup>>) {
  const handoff: LotSplitHandoff = { schema_version: 'acceptance-lot-split-handoff/v1', source_sha256: f.ledger.sha256,
    manifest_sha256: 'a'.repeat(64), pdf_sha256: null, history: { checkpoint_sha256: 'b'.repeat(64), tool_calls: 4, tool_response_bytes: 42, sessions: 1, limits: {} },
    decisions: f.ledger.blocks.map((block, index) => {
      const lot = f.delivery.lots.find(row => row.scope.block_ids.includes(block.id));
      const shared = block.text === '共同条件：甲、乙构件检测前应断电。';
      return { id: lot ? `input-${lot.id}` : `context-${index}`, kind: lot ? 'lot' : shared ? 'shared' : 'non_lot',
        name: lot?.name.value ?? `合成上下文${index}`, reason: '中性样本的规划结果', related_lot_ids: shared ? ['input-lot-0', 'input-lot-1'] : [],
        source: [{ ...sourceQuote(f.ledger, block), block: index, start_line: block.start_line, end_line: block.end_line }] };
    }) };
  await installLotSplitHandoff(f.options.root, handoff, f.ledger);
  return handoff;
}

it('settles known shared context before a sample review while unrelated unfinished lots remain independent', async () => {
  const reviewer = vi.fn(approved), f = await setup(reviewer, original + '\n\n共同条件：甲、乙构件检测前应断电。');
  await registerSharedPlanningFixture(f);
  const shared = f.ledger.blocks.at(-1)!, future = f.delivery.lots[1]!;
  f.delivery.lots = f.delivery.lots.filter(lot => lot.id !== future.id);
  f.delivery.groups[0]!.lot_ids = ['lot-0'];
  f.delivery.dispositions = f.delivery.dispositions.filter(row => row.block_id !== shared.id);
  Object.assign(f.delivery.dispositions.find(row => row.block_id === future.scope.block_ids[0])!, { role: 'unresolved', lot_ids: [], evidence: [] });
  await f.save();
  const controller = await AcceptanceAutonomousController.open(f.options);
  await controller.beginSession(); await controller.accountTool(1234, 2400);
  const budget = structuredClone(controller.state().budget);
  const blocked = await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
  expect(blocked).toMatchObject({ ok: false, model_started: false,
    issues: expect.arrayContaining([expect.objectContaining({ code: 'split_shared_context_pending' })]) });
  expect(reviewer).not.toHaveBeenCalled(); expect(controller.state().requests).toEqual([]);
  expect(controller.state().budget).toEqual(budget);
  expect((await controller.dispatch('review_acceptance_group', { group_id: 'prose', phase: 'full' })).ok).toBe(true);
  expect(reviewer.mock.calls.map(([request]) => request.lots.map(lot => lot.id))).toEqual([['lot-2']]);
  f.delivery.dispositions.push({ source_id: f.ledger.source_id, block_id: shared.id, role: 'shared', lot_ids: ['lot-0'],
    reason: '已确认当前已生成甲构件的共同条件，乙构件尚待生成。', evidence: [sourceQuote(f.ledger, shared)] });
  await f.save();
  const resumed = await AcceptanceAutonomousController.open(f.options);
  expect(await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: true,
    next_tool_arguments: { group_id: 'tables', phase: 'full' } });
  expect(reviewer.mock.calls.at(-1)![0].dispositions.some(row => row.block_id === shared.id)).toBe(true);
  const count = reviewer.mock.calls.length;
  expect((await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(true);
  expect(reviewer).toHaveBeenCalledTimes(count);
  expect(resumed.state().budget).toEqual(budget);
});

it.each(['missing', 'unresolved'] as const)('settles %s source planning before re-review after every split lot has a candidate', async state => {
  const reviewer = vi.fn(approved), f = await setup(reviewer, original + '\n\n共同条件：甲、乙构件检测前应断电。\n\n合成资料的背景说明。');
  await registerSharedPlanningFixture(f);
  const shared = f.ledger.blocks.at(-2)!, pending = f.ledger.blocks.at(-1)!;
  Object.assign(f.delivery.dispositions.find(row => row.block_id === shared.id)!, { role: 'shared', lot_ids: ['lot-0', 'lot-1'] });
  const settled = structuredClone(f.delivery.dispositions.find(row => row.block_id === pending.id)!);
  if (state === 'missing') f.delivery.dispositions = f.delivery.dispositions.filter(row => row.block_id !== pending.id);
  else Object.assign(f.delivery.dispositions.find(row => row.block_id === pending.id)!, { role: 'unresolved', evidence: [] });
  await f.save();
  const controller = await AcceptanceAutonomousController.open(f.options);
  await controller.beginSession(); await controller.accountTool(1234, 2400);
  const budget = structuredClone(controller.state().budget);
  const text = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8');
  const result: any = await controller.dispatch('review_acceptance_groups', { groups: [{ group_id: 'tables', phase: 'full' }, { group_id: 'prose', phase: 'full' }] });
  expect(result.ok).toBe(false);
  expect(result.results).toHaveLength(2);
  for (const blocked of result.results) {
    expect(blocked).toMatchObject({ ok: false, model_started: false, total_issues: 1 });
    if (!blocked.issues.length) expect(blocked.unchanged).toBe(true);
  }
  expect(result.results.flatMap((row: any) => row.issues)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'split_source_plan_pending' })]));
  expect(reviewer).not.toHaveBeenCalled(); expect(controller.state().requests).toEqual([]);
  expect(controller.state().budget).toEqual(budget);
  expect(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(text);
  f.delivery.dispositions = [...f.delivery.dispositions.filter(row => row.block_id !== pending.id), settled]; await f.save();
  const resumed = await AcceptanceAutonomousController.open(f.options);
  const ready = await resumed.dispatch('review_acceptance_groups', { groups: [{ group_id: 'tables', phase: 'full' }, { group_id: 'prose', phase: 'full' }] });
  expect(ready.ok).toBe(true); expect(reviewer).toHaveBeenCalledTimes(2);
  expect(resumed.state().budget).toEqual(budget);
});

it.each([false, true])('new companion pixels re-review only the lots actually consuming that image: %s', async consumed => {
  const reviewer = vi.fn(approved);
  const { controller, options, delivery, ledger, save, dir } = await setup(reviewer, original + '\n![](images/later.png)\n');
  const image = ledger.blocks.at(-1)!;
  if (consumed) {
    delivery.lots[0]!.scope.block_ids.push(image.id);
    delivery.lots[0]!.scope.evidence.push(sourceQuote(ledger, image));
    Object.assign(delivery.dispositions.find(row => row.block_id === image.id)!, { role: 'lot', lot_ids: ['lot-0'] });
    await save();
  }
  await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'full' });
  await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'prose', phase: 'full' });
  const before = reviewer.mock.calls.length;
  await mkdir(join(dir, 'images')); await writeFile(join(dir, 'images/later.png'), imageFixture);
  const resumed = await AcceptanceAutonomousController.open(options);
  const result = await resumed.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'full' });
  expect(result.ok).toBe(true);
  expect(reviewer.mock.calls.length - before).toBe(consumed ? 1 : 0);
  if (consumed) expect(reviewer.mock.calls.at(-1)![0].lots.map(lot => lot.id)).toEqual(['lot-0']);
  expect(resumed.state().approvals.some(row => row.group_id === 'prose')).toBe(true);
});

it('binds frozen image integrity to a publication and checks it before accepting a seal', async () => {
  const { options, ledger, dir } = await setup(approved, original + '\n![](images/later.png)\n');
  await mkdir(join(dir, 'images')); await writeFile(join(dir, 'images/later.png'), imageFixture);
  const controller = await AcceptanceAutonomousController.open(options);
  for (const group_id of ['tables', 'prose']) expect((await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id, phase: 'full' })).ok).toBe(true);
  const sealed = await controller.dispatch('seal_acceptance_delivery', { path: 'DELIVERY.json' });
  expect(sealed.ok).toBe(true);
  await expect(verifyAutonomousSealedDelivery(sealed.path as string, ledger.sha256)).resolves.toHaveProperty('source_image_manifests');
  const index = (await controller.dispatch('acceptance_workspace', {})).source_index as Array<{ images: string }>;
  const manifest = JSON.parse(await readFile(join(controller.workRoot, index[0]!.images), 'utf8'));
  await writeFile(join(controller.sourceRoot, manifest.images[0].path), 'changed frozen pixels');
  await expect(verifyAutonomousSealedDelivery(sealed.path as string, ledger.sha256)).rejects.toThrow(/image.*changed/i);
});

describe('separate seen history, mandatory samples and deterministic class sweep', () => {
  it('keeps historical exposure without sending every seen lot to trial or relabelling it as holdout', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    expect(await f.controller.dispatch('record_acceptance_exposure', { lot_ids: ['lot-1'], reason: '虚构旧版式探索已读过。' })).toMatchObject({ ok: true, required_review_samples_unchanged: true });
    const before = f.controller.state().budget;
    const trial = await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(trial).toMatchObject({ ok: true, sampling_plan: { historical_seen_lot_count: 2, required_review_lot_ids: ['lot-0'], unseen_lot_count: 0 } });
    expect(reviewer.mock.calls.map(([request]) => request.lots.map(lot => lot.id))).toEqual([['lot-0']]);
    const resumed = await AcceptanceAutonomousController.open(f.options);
    expect(await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).toMatchObject({ ok: false, error: 'holdout_sample_unavailable' });
    expect(resumed.state().training_declarations?.map(row => row.lot_id)).toEqual(expect.arrayContaining(['lot-0', 'lot-1']));
    expect(resumed.state().budget).toEqual(before);
  });

  it('pins a concrete failure after boundary labels are removed and reuses the independent passing instance', async () => {
    const sent: string[][] = [], f = await setup(async request => {
      sent.push(request.lots.map(lot => lot.id));
      if (sent.length > 1) return approved(request);
      return { approved: false, reviewed_lot_ids: ['lot-0', 'lot-1'], reason: '虚构乙实例配置错误。',
        findings: [{ lot_id: 'lot-1', path: '/items/0/unit', message: '虚构乙实例配置错误。', evidence: request.lots[1]!.scope.evidence }],
        lot_decisions: [{ lot_id: 'lot-0', approved: true, reason: '甲已核对。' }, { lot_id: 'lot-1', approved: false, reason: '乙须修正。' }] };
    });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1'];
    f.delivery.rules.push({ ...structuredClone(f.delivery.rules[0]!), id: 'instance-b', method_files: ['instance-b.json'] });
    f.delivery.groups[0]!.rule_ids.push('instance-b'); f.delivery.lots[1]!.dependency_ids.push('instance-b');
    await writeFile(join(f.controller.workRoot, 'instance-b.json'), '{"column":0}'); await f.save();
    expect((await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    f.delivery.groups[0]!.boundary_lot_ids = []; await f.save();
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: false, unchanged_rejection: true });
    expect(sent).toHaveLength(1);
    await writeFile(join(f.controller.workRoot, 'instance-b.json'), '{"column":1}');
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect(await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: true,
      reused_lot_ids: ['lot-0'], reviewed_lot_ids: ['lot-1'], sampling_plan: { required_review_lot_ids: ['lot-0', 'lot-1'] } });
    expect(sent).toEqual([['lot-0', 'lot-1'], ['lot-1']]);
    expect(restored.state().requests[0]!.result!.findings).toHaveLength(1);
  });

  it('does not seal after a failed source scope is removed', async () => {
    const f = await setup(async request => ({ approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '虚构具体缺陷。',
      findings: [{ lot_id: 'lot-1', path: '/items/0', message: '虚构具体缺陷。', evidence: request.lots[1]!.scope.evidence }] }));
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.lots.splice(1, 1); f.delivery.groups[0]!.lot_ids = ['lot-0']; f.delivery.groups[0]!.boundary_lot_ids = [];
    const disposition = f.delivery.dispositions.find(row => row.lot_ids.includes('lot-1'))!;
    disposition.role = 'not_extractable'; disposition.lot_ids = []; await f.save();
    expect(await f.controller.dispatch('seal_acceptance_delivery', {})).toMatchObject({ ok: false, error: 'review_failures_unresolved' });
  });

  it('does not permanently promote a repaired historical failure into every later method trial', async () => {
    const sent: string[][] = [], f = await setup(async request => {
      sent.push(request.lots.map(lot => lot.id));
      if (sent.length > 1) return approved(request);
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '乙的虚构字段待修正。',
        lot_decisions: request.lots.map(lot => ({ lot_id: lot.id, approved: lot.id !== 'lot-1', reason: '已逐项核对。' })),
        findings: [{ lot_id: 'lot-1', path: '/items/0/note', message: '虚构字段缺陷。', evidence: request.lots[1]!.scope.evidence }] };
    });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.lots[1]!.items[0]!.note.reason = '已按虚构原文核对并修复缺省说明。'; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.groups[0]!.boundary_lot_ids = []; await f.save();
    await f.controller.accountTool(64);
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// unrelated shared-parser branch updated; these reviewed facts are unchanged');
    const resumed = await AcceptanceAutonomousController.open(f.options);
    const result = await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(result).toMatchObject({ ok: true, sampling_plan: { historical_seen_lot_count: 2, required_review_lot_ids: ['lot-0'] } });
    expect(sent).toEqual([['lot-0', 'lot-1'], ['lot-1'], ['lot-0']]);
    expect(resumed.state().budget.tool_response_bytes).toBe(64);
    f.delivery.lots[1]!.items[0]!.note.reason = '乙的事实材料再次变化，旧回执不得覆盖。'; await f.save();
    await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(sent.at(-1)).toEqual(['lot-1']);
  });

  it('seals repaired historical facts with a genuine unseen member after an unrelated method change', async () => {
    let calls = 0;
    const f = await setup(async request => {
      if (++calls !== 1) return approved(request);
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '乙待修',
        lot_decisions: request.lots.map(lot => ({ lot_id: lot.id, approved: lot.id !== 'lot-1', reason: '虚构核对' })),
        findings: [{ lot_id: 'lot-1', path: '/items/0/note', message: '虚构缺陷', evidence: request.lots[1]!.scope.evidence }] };
    });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; f.delivery.groups[1]!.trial_lot_ids = []; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.lots[1]!.items[0]!.note.reason = '已修'; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.groups[0]!.boundary_lot_ids = []; f.delivery.groups[0]!.lot_ids.push('lot-2');
    f.delivery.groups.splice(1, 1); f.delivery.lots[2]!.group_id = 'tables';
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// unrelated branch change'); await f.save();
    const result = await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' });
    expect(result).toMatchObject({ ok: true, approval: { required_lot_ids: ['lot-0'], failure_resolutions: [expect.objectContaining({ lot_id: 'lot-1' })] }, reviewed_lot_ids: ['lot-2'] });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    expect(sealed.ok).toBe(true);
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
  });

  const fictionalSweep = `import {readFile,writeFile} from 'node:fs/promises';
const req=JSON.parse(await readFile(process.argv[2],'utf8')), d=JSON.parse(await readFile(req.input,'utf8'));
const src=JSON.parse(await readFile(req.source_ledger,'utf8'));
const results=[]; for(const match of req.matches){
 const block=src.blocks.find(b=>b.id===match.block_id), owners=d.lots.filter(l=>l.scope.block_ids.includes(block.id));
 if(!owners.length){
  const cells=[...block.text.matchAll(/<td>(.*?)<\\/td>/g)].map(m=>m[1]);
  const q=t=>{const start=block.text.indexOf(t);return {source_id:src.source_id,block_id:block.id,start,end:start+t.length,text:t}};
  const bound=t=>({value:t,evidence:[q(t)]}), lot=structuredClone(d.lots[0]);
  lot.id='generated-'+block.id;lot.name=bound(cells[3]);lot.scope={block_ids:[block.id],reason:'原文独立表。',evidence:[q(block.text)]};
  const item=lot.items[0];item.name=bound(cells[3]);item.requirement=bound(cells[4]);item.unit=bound(cells[5]);item.category.evidence=[q(block.text)];
  d.lots.push(lot);d.groups.find(g=>g.id===req.group_id).lot_ids.push(lot.id);owners.push(lot);
  Object.assign(d.dispositions.find(row=>row.block_id===block.id),{role:'lot',lot_ids:[lot.id]});
 }
 results.push({block_id:block.id,status:'processed',lot_ids:owners.map(l=>l.id),reason:'同一表头和解析方法逐表完成。'});
}
await writeFile(req.output,JSON.stringify(d));await writeFile(req.outcomes,JSON.stringify(results));`;

  it('scans every table, batches using a program with zero model workers, then reviews a genuinely unseen holdout and seals', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    const table = f.ledger.blocks.find(block => block.kind === 'table')!;
    f.delivery.lots.splice(1, 1); f.delivery.groups[0]!.lot_ids = ['lot-0'];
    Object.assign(f.delivery.dispositions.find(row => row.lot_ids.includes('lot-1'))!, { role: 'unresolved', lot_ids: [] });
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), fictionalSweep); await f.save();
    const params = { group_id: 'tables', sample_block_id: table.id, header_row_index: 0, program_file: 'extract.mjs', method_files: ['extract.mjs'] };
    expect(await f.controller.dispatch('sweep_acceptance_tables', { ...params, program_file: undefined })).toMatchObject({ ok: true, plan_only: true, scanned_tables: 2, matching_tables: 2 });
    expect(await f.controller.dispatch('sweep_acceptance_tables', params)).toMatchObject({ ok: false, error: 'sweep_trial_required' });
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(await f.controller.dispatch('sweep_acceptance_tables', params)).toMatchObject({ ok: true, matching_tables: 2, processed: 2, exceptions: 0, model_workers_started: 0 });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).toMatchObject({ ok: true, review_mode: 'holdout' });
    expect(reviewer.mock.calls.map(([request]) => request.phase)).toEqual(['trial', 'holdout']);
    expect(f.controller.state().approvals[0]).toMatchObject({ protocol_version: 4, training_lot_ids: ['lot-0'], required_lot_ids: ['lot-0'] });
    expect(await f.controller.dispatch('seal_acceptance_group', { group_id: 'tables' })).toMatchObject({ ok: true, class_sealed: true, lot_count: 2, published: false });
    expect(f.controller.state().group_seals).toHaveLength(1);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'prose' });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    expect(sealed.ok).toBe(true);
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete', review_protocol_version: 4 });
  });

  it('refuses a program that omits a matched table or deletes an existing failed candidate', async () => {
    const { planTableSweep, admitTableSweep } = await import('../src/acceptance-autonomous/table-sweep.js');
    const f = await setup(); const table = f.ledger.blocks.find(block => block.kind === 'table')!;
    const plan = planTableSweep(f.ledger, table.id, 0, f.delivery);
    const outcomes = plan.matches.map(match => ({ block_id: match.block_id, status: 'processed' as const, lot_ids: match.existing_lot_ids, reason: '虚构完整结果。' }));
    expect(() => admitTableSweep(f.delivery, f.delivery, plan, outcomes.slice(0, 1), 'tables')).toThrow(/every matched/);
    const shrunk = structuredClone(f.delivery); shrunk.lots.splice(1, 1);
    expect(() => admitTableSweep(f.delivery, shrunk, plan, outcomes, 'tables')).toThrow(/remove existing/);
    outcomes[1]!.status = 'exception' as 'processed';
    expect(() => admitTableSweep(f.delivery, f.delivery, plan, outcomes, 'tables')).toThrow(/concrete problem/);
  });

  it('explains the sweep wire contract and exposes malformed isolated results through readable diagnostics', async () => {
    const f = await setup();
    const table = f.ledger.blocks.find(block => block.kind === 'table')!;
    const malformed = fictionalSweep.replace('JSON.stringify(results)', 'JSON.stringify({ matches: results })');
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), malformed); await f.save();
    const params = { group_id: 'tables', sample_block_id: table.id, header_row_index: 0, program_file: 'extract.mjs', method_files: ['extract.mjs'] };
    const plan = await f.controller.dispatch('sweep_acceptance_tables', { ...params, program_file: undefined });
    expect(plan).toMatchObject({ program_contract: { outcomes: { type: 'array', fields: ['block_id', 'status', 'lot_ids', 'reason'] } } });
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const draftPath = join(f.controller.workRoot, 'DELIVERY.json');
    const before = await readFile(draftPath, 'utf8');
    const result = await f.controller.dispatch('sweep_acceptance_tables', params);
    expect(result).toMatchObject({ ok: false, error: 'sweep_output_contract_failed', actual: { outcomes: { type: 'object', keys: ['matches'] } },
      expected: { outcomes: { type: 'array' } }, writable: expect.stringContaining('extract.mjs'), next_tool: 'read', next_tool_arguments: { path: expect.stringMatching(/^diagnostics\//) } });
    const diagnostic = JSON.parse(await readFile(join(f.controller.workRoot, String((result.next_tool_arguments as { path: string }).path)), 'utf8'));
    expect(diagnostic).toMatchObject({ actual: { outcomes: { type: 'object' } }, output_files: { outcomes: expect.stringMatching(/^diagnostics\//) } });
    expect(JSON.parse(await readFile(join(f.controller.workRoot, diagnostic.output_files.outcomes), 'utf8'))).toHaveProperty('matches');
    expect(await readFile(draftPath, 'utf8')).toBe(before);
    expect(f.controller.state().table_sweeps ?? []).toHaveLength(0);
  });

  it.each([false, true])('transfers generated instance dependencies and recovers missing files without resetting history (legacy=%s)', async legacy => {
    const f = await setup();
    const table = f.ledger.blocks.find(block => block.kind === 'table')!;
    const program = fictionalSweep.replace('await writeFile(req.output,JSON.stringify(d));', `
await writeFile('instance.json',JSON.stringify({column:1}));
d.rules.push({id:'instance-rule',method_files:['instance.json'],scope:'Synthetic instance mapping',exceptions:[],evidence:d.rules[0].evidence});
d.groups.find(g=>g.id===req.group_id).rule_ids.push('instance-rule');
d.lots.find(l=>l.id==='lot-1').dependency_ids.push('instance-rule');
await writeFile(req.output,JSON.stringify(d));`);
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), program); await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const result = await f.controller.dispatch('sweep_acceptance_tables', { group_id: 'tables', sample_block_id: table.id,
      header_row_index: 0, program_file: 'extract.mjs', method_files: ['extract.mjs'] });
    expect(result.ok).toBe(true);
    const artifactPath = join(f.controller.workRoot, 'instance.json');
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toEqual({ column: 1 });
    const draft = await readFile(join(f.controller.workRoot, 'DELIVERY.json'), 'utf8');
    const sweep = f.controller.state().table_sweeps![0]!;
    let receipt = await readFile(sweep.path, 'utf8');
    if (legacy) {
      const prior = JSON.parse(receipt); delete prior.generated_methods;
      receipt = JSON.stringify(prior); await writeFile(sweep.path, receipt);
      const state = JSON.parse(await readFile(join(f.options.root, 'checkpoint.json'), 'utf8'));
      state.table_sweeps[0].sha256 = sha256Text(receipt);
      await writeFile(join(f.options.root, 'checkpoint.json'), JSON.stringify(state));
    }
    const checkpoint = await readFile(join(f.options.root, 'checkpoint.json'), 'utf8');
    await rm(artifactPath);
    const resumed = await AcceptanceAutonomousController.open(f.options);
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toEqual({ column: 1 });
    expect(await readFile(join(f.options.root, 'checkpoint.json'), 'utf8')).toBe(checkpoint);
    expect(await readFile(join(resumed.workRoot, 'DELIVERY.json'), 'utf8')).toBe(draft);
    expect(await readFile(sweep.path, 'utf8')).toBe(receipt);
    expect((await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).ok).toBe(true);
  });

  it('blocks incomplete accepted lot boundaries before paid review and passes complete frozen inputs into a sweep', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    await registerFictionalSplit(f);
    const controller = await AcceptanceAutonomousController.open(f.options);
    expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
    const heading = f.ledger.blocks[0]!;
    f.delivery.lots[0]!.scope.block_ids.push(heading.id);
    Object.assign(f.delivery.dispositions[0]!, { role: 'lot', lot_ids: ['lot-0'] });
    await writeFile(join(controller.workRoot, 'extract.mjs'), fictionalSweep); await f.save();
    expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(true);
    const table = f.ledger.blocks.find(block => block.kind === 'table')!;
    expect((await controller.dispatch('sweep_acceptance_tables', { group_id: 'tables', sample_block_id: table.id, header_row_index: 0,
      program_file: 'extract.mjs', method_files: ['extract.mjs'] })).ok).toBe(true);
    const sweep = controller.state().table_sweeps![0]!;
    const request = JSON.parse(await readFile(join(sweep.path, '..', 'work', 'request.json'), 'utf8'));
    expect(request.lot_inputs.find((row: { id: string }) => row.id === 'lot-0').source.map((row: { block_id: string }) => row.block_id)).toContain(heading.id);
  });

  it('does not merge a new table-only candidate that omits its accepted lot footer', async () => {
    const f = await setup(); await registerFictionalSplit(f, true);
    const heading = f.ledger.blocks[0]!;
    f.delivery.lots[0]!.scope.block_ids.push(heading.id); Object.assign(f.delivery.dispositions[0]!, { role: 'lot', lot_ids: ['lot-0'] });
    f.delivery.lots.splice(1, 1); f.delivery.groups[0]!.lot_ids = ['lot-0'];
    Object.assign(f.delivery.dispositions.find(row => row.lot_ids.includes('lot-1'))!, { role: 'unresolved', lot_ids: [] });
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), fictionalSweep); await f.save();
    const controller = await AcceptanceAutonomousController.open(f.options), table = f.ledger.blocks.find(block => block.kind === 'table')!;
    await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const path = join(controller.workRoot, 'DELIVERY.json'), before = await readFile(path, 'utf8');
    expect(await controller.dispatch('sweep_acceptance_tables', { group_id: 'tables', sample_block_id: table.id, header_row_index: 0,
      program_file: 'extract.mjs', method_files: ['extract.mjs'] })).toMatchObject({ ok: false, error: 'sweep_output_validation_failed' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('keeps the same column structure when the body row count changes a merged label height', async () => {
    const { planTableSweep } = await import('../src/acceptance-autonomous/table-sweep.js');
    const table = (height: number, label = '要求', width = 1) => `<table><tr><td rowspan="${height}">类别</td><td>项目</td><td colspan="${width}">${label}</td></tr><tr><td>虚构项目</td><td>5</td></tr></table>`;
    const source = buildAcceptanceSourceLedger([table(3), table(8), table(3, '方法'), table(3, '要求', 2)].join('\n\n'));
    const plan = planTableSweep(source, source.blocks[0]!.id, 0, { lots: [] } as unknown as AcceptanceDelivery);
    expect(plan.matches.map(row => row.block_id)).toEqual(source.blocks.slice(0, 2).map(row => row.id));
  });

  it('refuses a class seal until sweep receipts cover every existing member table', async () => {
    const source = original.replace('<!-- pages_002_003 -->\n\n<table><tr><td>验收项目</td><td>允许偏差', '<!-- pages_002_003 -->\n\n<table><tr><td>验收项目</td><td>限差');
    const f = await setup(approved, source), tables = f.ledger.blocks.filter(block => block.kind === 'table');
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), fictionalSweep); await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' });
    const params = { group_id: 'tables', header_row_index: 0, program_file: 'extract.mjs', method_files: ['extract.mjs'] };
    expect(await f.controller.dispatch('sweep_acceptance_tables', { ...params, sample_block_id: tables[0]!.id })).toMatchObject({ ok: true, processed: 1 });
    expect(await f.controller.dispatch('seal_acceptance_group', { group_id: 'tables' })).toMatchObject({ ok: false, error: 'complete_table_sweep_required', actual: { missing_group_table_count: 1 } });
    expect(await f.controller.dispatch('sweep_acceptance_tables', { ...params, sample_block_id: tables[1]!.id })).toMatchObject({ ok: true, processed: 1 });
    expect(await f.controller.dispatch('seal_acceptance_group', { group_id: 'tables' })).toMatchObject({ ok: true, class_sealed: true });
  });

  it('matches structural headers across different bodies and exposes unparsed tables instead of dropping them', async () => {
    const { planTableSweep } = await import('../src/acceptance-autonomous/table-sweep.js');
    const text = '| 项目 | 要求 |\n| --- | --- |\n| 甲 | 5 |\n\n'
      + '| 项目 | 要求 |\n| --- | --- |\n| 乙 | 8 |\n| 丙 | 9 |\n\n'
      + '<table><tr><td>未闭合的虚构表';
    const source = buildAcceptanceSourceLedger(text);
    const delivery = { lots: [] } as unknown as AcceptanceDelivery;
    const plan = planTableSweep(source, source.blocks[0]!.id, 0, delivery);
    expect(plan).toMatchObject({ scanned_table_count: 3, unparsed_block_ids: [source.blocks[2]!.id] });
    expect(plan.matches.map(row => row.block_id)).toEqual(source.blocks.slice(0, 2).map(row => row.id));
  });

  it('keeps the original failed source mandatory even if its old lot id is reassigned elsewhere', async () => {
    const { reviewObligations } = await import('../src/acceptance-autonomous/review-plan.js');
    const f = await setup();
    const oldBlock = f.delivery.lots[1]!.scope.block_ids[0]!;
    const retainedHeading = f.ledger.blocks[0]!.id;
    f.delivery.lots[1]!.scope.block_ids = [retainedHeading];
    const obligations = await reviewObligations(f.controller.root, f.delivery, [{ id: 'review:fictional', kind: 'group_review', fingerprint: 'fictional',
      source_ids: [f.ledger.source_id], lot_ids: ['lot-1'], dependency_ids: [], status: 'needs_work', attempts: 1,
      exposed_lots: [{ lot_id: 'lot-1', block_ids: [retainedHeading, oldBlock] }], result: { approved: false, reviewed_lot_ids: ['lot-1'], reason: '虚构实际缺陷。',
        findings: [{ lot_id: 'lot-1', path: '/items/0', message: '虚构实际缺陷。', evidence: [sourceQuote(f.ledger, f.ledger.blocks.find(block => block.id === oldBlock)!)] }] } }]);
    expect(obligations).toMatchObject([{ lot_id: 'lot-1', block_ids: [oldBlock], missing_block_ids: [oldBlock], current_lot_ids: [] }]);
  });
});

describe('autonomous physical source ledger and policy', () => {
  it('enumerates prose, whole tables, notes, headings and page markers independently of any candidate', () => {
    const ledger = buildAcceptanceSourceLedger(original);
    expect(ledger.blocks.map(block => block.kind)).toEqual(['heading', 'table', 'page_marker', 'table', 'note', 'paragraph']);
    for (const block of ledger.blocks) expect(original.slice(block.start, block.end)).toBe(block.text);
    expect(ledger.blocks.map(block => block.id)).toEqual(buildAcceptanceSourceLedger(original).blocks.map(block => block.id));
    expect(buildAcceptanceSourceLedger(original + '\n末尾另有条款。').blocks).toHaveLength(7);
  });

  it.each(['允许偏差', '设计要求及规范规定', '质量检验标准'])('uses actual %s cells despite merged administrative headers', label => {
    const text = `<table><tr><td colspan="3">单位工程名称</td><td></td></tr><tr><td>验收依据</td><td colspan="3">《虚构规范》XY123-2020</td></tr><tr><td>验收项目</td><td colspan="2">${label}</td><td>结果</td></tr><tr><td rowspan="2">尺寸</td><td colspan="2">按XY456-2021执行</td><td></td></tr><tr><td colspan="2">同XY456-2021</td><td></td></tr></table>`;
    const ledger = buildAcceptanceSourceLedger(text), block = ledger.blocks[0]!;
    const q = (s: string) => sourceQuote(ledger, block, text.indexOf(s), text.indexOf(s) + s.length);
    expect(referenceSourceField(ledger, q('XY123-2020'))).toBe('acceptance_basis');
    expect(referenceSourceField(ledger, q('按XY456-2021'))).toBe('allowable_deviation');
    expect(referenceSourceField(ledger, q('同XY456-2021'))).toBe('allowable_deviation');
  });

  it('does not borrow a header from another table and keeps malformed source visible', () => {
    const ledger = buildAcceptanceSourceLedger('<table><tr><td>项目</td><td>允许偏差</td></tr></table>\n\n<table><tr><td>未知</td><td>XY999-2020</td></tr></table>\n\n<table><tr><td>未结束');
    const block = ledger.blocks[1]!, offset = block.text.indexOf('XY999');
    expect(referenceSourceField(ledger, sourceQuote(ledger, block, offset, offset + 10))).toBe('unclassified');
    expect(ledger.blocks[2]!.features).toContain('unclosed_table');
  });

  it.each([
    '<table><tr><td>验收依据</td><td>GB/T 99000-2050</td></tr><tr><td>项目</td><td>允许偏差</td></tr><tr><td>构件</td><td>按GB/T 99001-2050</td></tr></table>',
    '验收依据：GB/T 99000-2050；允许偏差：按GB/T 99001-2050。',
    '<table><tr><td>验收依据：GB/T 99000-2050；允许偏差：按GB/T 99001-2050。</td></tr></table>',
  ])('requires narrowing mixed-field origins instead of waiving or expanding the whole range', text => {
    const ledger = buildAcceptanceSourceLedger(text), block = ledger.blocks[0]!;
    const q = (s: string) => sourceQuote(ledger, block, text.indexOf(s), text.indexOf(s) + s.length);
    expect(referenceSourceField(ledger, sourceQuote(ledger, block))).toBe('ambiguous');
    expect(referenceSourceField(ledger, sourceQuote(ledger, block, text.indexOf('GB/T 99000'), text.indexOf('GB/T 99001') + 15))).toBe('ambiguous');
    expect(referenceSourceField(ledger, q('GB/T 99000-2050'))).toBe('acceptance_basis');
    expect(referenceSourceField(ledger, q('GB/T 99001-2050'))).toBe('allowable_deviation');
  });
});

describe('autonomous validation and semantic batch acceptance', () => {
  it.each([false, true])('keeps a validated boundary declaration seen before any reviewer call, including a source rename (renamed=%s)', async renamed => {
    const sent: GroupReviewRequest[] = [];
    const f = await setup(async request => { sent.push(request); return approved(request); });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    expect((await f.controller.dispatch('validate_acceptance_delivery', {})).ok).toBe(true);
    await f.controller.beginSession(); await f.controller.accountTool(123, 1000);
    f.delivery.groups[0]!.boundary_lot_ids = [];
    if (renamed) {
      f.delivery.lots[1]!.id = 'renamed-boundary';
      f.delivery.groups[0]!.lot_ids[1] = 'renamed-boundary';
      f.delivery.dispositions.find(row => row.lot_ids.includes('lot-1'))!.lot_ids = ['renamed-boundary'];
    }
    await f.save();
    const restored = await AcceptanceAutonomousController.open(f.options);
    await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' }))
      .toMatchObject({ ok: false, error: 'holdout_sample_unavailable', model_started: false });
    expect(sent.some(request => request.phase === 'holdout')).toBe(false);
    expect(restored.state().budget).toMatchObject({ attempts: 1, tool_response_bytes: 123, observed_context_tokens: 1000 });
  });

  it('audits a conservative legacy candidate barrier while retaining old approvals and every counter', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    await f.controller.beginSession(); await f.controller.accountTool(123, 1000);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables' });
    const old = f.controller.state();
    delete old.training_declarations;
    for (const row of old.approvals) { row.protocol_version = 2; delete row.training_declaration_count; }
    const originalCheckpoint = JSON.stringify(old);
    await writeFile(join(f.controller.root, 'checkpoint.json'), originalCheckpoint);
    const calls = reviewer.mock.calls.length;
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect(restored.state().training_declarations?.map(row => row.lot_id)).toEqual(f.delivery.lots.map(lot => lot.id));
    expect(restored.state().budget).toEqual(old.budget);
    expect(restored.state().requests).toEqual(old.requests);
    expect(restored.state().approvals).toEqual(old.approvals);
    const audit = JSON.parse(await readFile(join(f.controller.root, 'training-declaration-initialization.json'), 'utf8'));
    expect(audit.original_checkpoint_text).toBe(originalCheckpoint);
    expect(await restored.dispatch('review_acceptance_group', { group_id: 'tables' })).toMatchObject({ ok: true, cached: true });
    expect(reviewer).toHaveBeenCalledTimes(calls);
    const again = await AcceptanceAutonomousController.open(f.options);
    expect(again.state().training_declarations).toEqual(restored.state().training_declarations);
    expect(again.state().budget).toEqual(old.budget);
  });

  it.each(['audit', 'declarations'])('rejects legacy declaration history tampering (%s)', async target => {
    const f = await setup();
    const old = f.controller.state(); delete old.training_declarations;
    await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(old));
    const restored = await AcceptanceAutonomousController.open(f.options);
    if (target === 'audit') {
      const path = join(f.controller.root, 'training-declaration-initialization.json');
      await writeFile(path, (await readFile(path, 'utf8')) + ' ');
    } else {
      const changed = restored.state(); changed.training_declarations!.pop();
      await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(changed));
    }
    await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow('training_declaration_history_changed');
  });

  it('fails closed when tracked declaration history disappears after a new approval', async () => {
    const f = await setup(); await f.controller.dispatch('review_acceptance_group', { group_id: 'tables' });
    const changed = f.controller.state(); delete changed.training_declarations;
    await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(changed));
    await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow('training_declaration_history_changed');
  });

  it.each(['history', 'downgrade', 'approval-count'])('binds declaration history into publication and refuses a forged seal (%s)', async target => {
    const f = await setup();
    for (const group of f.delivery.groups) await f.controller.dispatch('review_acceptance_group', { group_id: group.id });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    const artifact = JSON.parse(await readFile(String(sealed.path), 'utf8'));
    expect(artifact.review_protocol_version).toBe(4);
    if (target === 'history') artifact.training_declarations = [];
    if (target === 'approval-count') artifact.approvals[0].training_declaration_count = 0;
    if (target === 'downgrade') {
      artifact.review_protocol_version = 2; delete artifact.training_declarations;
      for (const approval of artifact.approvals) { approval.protocol_version = 2; delete approval.training_declaration_count; }
    }
    artifact.fingerprint = sha256Json({ delivery: sha256Json(artifact.delivery), approvals: artifact.approvals, ids: artifact.lot_ids,
      inventory: artifact.inventory_request_id, review_protocol_version: artifact.review_protocol_version, reviews: artifact.reviews,
      ...(artifact.review_protocol_version >= 3 ? { training_declarations: artifact.training_declarations } : {}) });
    const state = f.controller.state(); state.publications[0]!.fingerprint = artifact.fingerprint;
    await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(state));
    await writeFile(String(sealed.path), JSON.stringify(artifact));
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).rejects.toThrow(/[Tt]raining declaration/);
  });

  it.each([2, 3] as const)('still reads a historical protocol-%s publication without rewriting its old approval', async protocol => {
    const f = await setup();
    for (const group of f.delivery.groups) await f.controller.dispatch('review_acceptance_group', { group_id: group.id });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    const artifact = JSON.parse(await readFile(String(sealed.path), 'utf8'));
    artifact.review_protocol_version = protocol;
    if (protocol === 2) delete artifact.training_declarations;
    for (const approval of artifact.approvals) { approval.protocol_version = protocol; delete approval.required_lot_ids; if (protocol === 2) delete approval.training_declaration_count; }
    artifact.fingerprint = sha256Json({ delivery: sha256Json(artifact.delivery), approvals: artifact.approvals, ids: artifact.lot_ids,
      inventory: artifact.inventory_request_id, review_protocol_version: protocol, reviews: artifact.reviews,
      ...(protocol === 3 ? { training_declarations: artifact.training_declarations } : {}) });
    const state = f.controller.state(); state.approvals = structuredClone(artifact.approvals);
    state.publications[0]!.fingerprint = artifact.fingerprint; delete state.publications[0]!.review_protocol_version;
    await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(state));
    await writeFile(String(sealed.path), JSON.stringify(artifact));
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete', review_protocol_version: protocol });
  });

  it('does not list superseded negative reviews as pending work after the current group passes', async () => {
    let calls = 0;
    const f = await setup(async request => {
      if (++calls !== 1) return approved(request);
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '虚构方法待修正',
        findings: [{ lot_id: 'lot-0', path: '/items/0', message: '虚构方法问题', evidence: request.lots[0]!.scope.evidence }] };
    });
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// corrected fictional shared method\n');
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' });
    const history = f.controller.state();
    expect(history.requests.some(row => row.status === 'needs_work')).toBe(true);
    expect(await f.controller.dispatch('acceptance_workspace', {})).toMatchObject({ pending_requests: [], pending_request_count: 0,
      continuation: { approved_candidate_lots: 2, pending_candidate_lots: 1 } });
    expect(f.controller.state().requests).toEqual(history.requests);
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// subsequently changed shared method\n');
    expect(await f.controller.dispatch('acceptance_workspace', {})).toMatchObject({ pending_request_count: 1,
      continuation: { approved_candidate_lots: 0, pending_candidate_lots: 3 } });
  });

  it('reviews a reusable four-object layout with one trial and a true holdout instead of one full review per title', async () => {
    const extra = (name: string, value: string) => `\n\n<table><tr><td>验收项目</td><td>允许偏差</td><td>单位</td></tr><tr><td>${name}</td><td>${value}</td><td>mm</td></tr></table>`;
    const sent: GroupReviewRequest[] = [];
    const f = await setup(async request => { sent.push(request); return approved(request); },
      original + extra('丁构件长度', '9') + extra('戊构件长度', '11'));
    const blocks = f.ledger.blocks.filter(block => block.kind === 'table').slice(2);
    blocks.forEach((block, index) => {
      const lot = structuredClone(f.delivery.lots[0]!);
      lot.id = `additional-${index}`; lot.name = bind(f.ledger, block, ['丁构件长度', '戊构件长度'][index]!);
      lot.scope = { block_ids: [block.id], reason: '虚构同列结构的独立业务对象。', evidence: [sourceQuote(f.ledger, block)] };
      lot.items[0]!.name = lot.name;
      lot.items[0]!.requirement = bind(f.ledger, block, ['9', '11'][index]!);
      lot.items[0]!.unit = bind(f.ledger, block, 'mm');
      lot.items[0]!.category.evidence = [sourceQuote(f.ledger, block)];
      f.delivery.lots.push(lot); f.delivery.groups[0]!.lot_ids.push(lot.id);
      const disposition = f.delivery.dispositions.find(row => row.block_id === block.id)!;
      disposition.role = 'lot'; disposition.lot_ids = [lot.id];
    });
    await f.save();
    expect((await f.controller.dispatch('validate_acceptance_delivery', {})).ok).toBe(true);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).toMatchObject({ ok: true, review_mode: 'holdout' });
    expect(sent.map(row => row.phase)).toEqual(['trial', 'holdout']);
    expect(sent[0]!.lots.map(lot => lot.id)).toEqual(['lot-0']);
    expect(sent[1]!.lots.every(lot => lot.id !== 'lot-0')).toBe(true);
    expect(sent[1]!.lots.length).toBeLessThan(4);
    expect(f.controller.state().approvals[0]!.review_mode).toBe('holdout');
    expect(f.delivery.groups[0]!.lot_ids).toHaveLength(4);
    expect(f.delivery.lots.filter(lot => lot.group_id === 'tables').map(lot => lot.items[0]!.requirement.value)).toEqual(['5', '7', '9', '11']);
  });

  it('does not count accounting, context observations or session attempts as durable work', async () => {
    const f = await setup();
    await f.controller.dispatch('validate_acceptance_delivery', {});
    const before = await f.controller.snapshot();
    await f.controller.beginSession();
    await f.controller.accountTool(2500, 1000);
    expect(await f.controller.snapshot()).toEqual(before);
    expect(f.controller.state().budget).toMatchObject({ tool_response_bytes: 2500, observed_context_tokens: 1000, attempts: 1 });
  });

  it('still stops completed rounds that only read status and consume response bytes', async () => {
    const f = await setup();
    let rounds = 0;
    const result = await runLengthContinuationLoop({ initialPrompt: 'continue fictional work', continuationPrompt: 'continue',
      promptRound: async () => { rounds += 1; await f.controller.dispatch('acceptance_workspace', {}); await f.controller.accountTool(48); return { kind: 'completed' }; },
      lastAssistant: () => ({ stopReason: 'stop' }), snapshot: () => f.controller.snapshot(),
      shouldContinueAfterCompleted: async () => true, maxConsecutiveWithoutProgress: 2 });
    expect(result.error).toMatch(/^incomplete_repair_without_durable_progress:/);
    expect(rounds).toBe(2);
    expect(f.controller.state().budget.tool_response_bytes).toBe(96);
  });

  it('recognizes separate review decisions on unchanged author work without a false hash cycle', async () => {
    const f = await setup();
    await f.controller.dispatch('validate_acceptance_delivery', {});
    const initial = await f.controller.snapshot();
    const phases = [['tables', 'trial'], ['tables', 'complete'], ['prose', 'trial']];
    let round = 0;
    const result = await runLengthContinuationLoop({ initialPrompt: 'review fictional groups', continuationPrompt: 'continue',
      promptRound: async () => {
        const phase = phases[round++];
        if (!phase) return { kind: 'sealed' };
        await f.controller.dispatch('review_acceptance_group', { group_id: phase[0], phase: phase[1] });
        return { kind: 'completed' };
      }, lastAssistant: () => ({ stopReason: 'stop' }), snapshot: () => f.controller.snapshot(), shouldContinueAfterCompleted: async () => true });
    expect(result.error).toBe('');
    expect(result.outcome.kind).toBe('sealed');
    expect((await f.controller.snapshot()).working_plan_sha256).toBe(initial.working_plan_sha256);
    expect((await f.controller.snapshot()).last_valid_fingerprint).not.toBe(initial.last_valid_fingerprint);
  });

  it('observes actual draft and method changes before validation without treating restored work as new', async () => {
    const f = await setup();
    const before = await f.controller.snapshot();
    f.delivery.lots[0]!.items[0]!.note = absent();
    f.delivery.lots[0]!.items[0]!.note.reason = '虚构条款未标注附注。';
    await f.save();
    const changed = await f.controller.snapshot();
    expect(changed.working_plan_sha256).not.toBe(before.working_plan_sha256);
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// revised fictional method\n');
    expect((await f.controller.snapshot()).working_plan_sha256).not.toBe(changed.working_plan_sha256);
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// document-learned extraction method\n');
    expect(await f.controller.snapshot()).toEqual(changed);
  });

  it('locates unfinished frozen source for continuation without supplying business answers or granting approval', async () => {
    const f = await setup();
    const block = f.ledger.blocks.find(row => row.kind === 'table')!;
    const row = f.delivery.dispositions.find(row => row.block_id === block.id)!;
    row.role = 'unresolved'; row.lot_ids = [];
    await f.save();
    const workspace = await f.controller.dispatch('acceptance_workspace', {});
    expect(workspace.continuation).toMatchObject({ candidate_path: 'DELIVERY.json', candidate_lots: 3,
      unresolved_source_blocks: 1, next_source_blocks: [{ source_id: f.ledger.source_id, block_id: block.id,
        start_line: block.start_line, end_line: block.end_line }] });
    const prompt = await f.controller.continuationPrompt();
    expect(prompt).toContain(block.id);
    expect(prompt).toContain('继续读取');
    expect(prompt).not.toContain('甲构件长度');
    expect(f.controller.state().approvals).toEqual([]);
    expect(f.controller.state().publications).toEqual([]);
    row.role = 'lot'; row.lot_ids = ['lot-0'];
    const next = f.ledger.blocks.filter(row => row.kind === 'table')[1]!;
    const nextRow = f.delivery.dispositions.find(row => row.block_id === next.id)!;
    nextRow.role = 'unresolved'; nextRow.lot_ids = []; await f.save();
    const updated = await f.controller.continuationPrompt();
    expect(updated).toContain(next.id);
    expect(updated).not.toContain(block.id);
  });

  it('preserves every review field while reducing whitespace and retaining usable line pages', async () => {
    const f = await setup();
    const value = { quotes: f.delivery.dispositions, lots: Array.from({ length: 4 }, (_, i) => ({ ...f.delivery.lots[0]!, id: `fiction-${i}`,
      items: Array.from({ length: 20 }, (_, index) => ({ ...f.delivery.lots[0]!.items[0]!, id: `item-${index}` })) })) };
    const pretty = JSON.stringify(value, null, 2), compactPages = formatAcceptanceReviewJson(value);
    expect(JSON.parse(compactPages)).toEqual(value);
    expect(Buffer.byteLength(compactPages)).toBeLessThan(Buffer.byteLength(pretty) * 0.75);
    expect(Math.max(...compactPages.split('\n').map(line => Buffer.byteLength(line)))).toBeLessThan(2100);
    expect(compactPages.split('\n').length).toBeGreaterThan(20);
  });

  it('reports when all current members have already participated in trial or boundary review', async () => {
    const f = await setup(); f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: true,
      semantic_approval: false, sampling_plan: { training_lot_count: 2, unseen_lot_count: 0, holdout_available: false } });
    expect(f.controller.state().approvals).toEqual([]);
  });

  it('does not resend an unchanged accepted sample when a separate member, rule and boundary are added', async () => {
    const sent: string[][] = [];
    const f = await setup(async request => { sent.push(request.lots.map(lot => lot.id)); return approved(request); });
    f.delivery.groups[0]!.lot_ids = ['lot-0'];
    const second = f.delivery.lots.splice(1, 1)[0]!;
    const secondDisposition = f.delivery.dispositions.find(row => row.lot_ids.includes(second.id))!;
    secondDisposition.role = 'unresolved'; secondDisposition.lot_ids = []; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    f.delivery.lots.push(second);
    second.items[0]!.rule_ids = ['second-rule'];
    f.delivery.rules.push({ ...structuredClone(f.delivery.rules[0]!), id: 'second-rule', method_files: ['second.mjs'], evidence: second.scope.evidence });
    await writeFile(join(f.controller.workRoot, 'second.mjs'), '// independent fictional method');
    Object.assign(secondDisposition, { role: 'lot', lot_ids: [second.id] });
    Object.assign(f.delivery.groups[0]!, { structure: '新增一种虚构边界布局', lot_ids: ['lot-0', second.id], rule_ids: ['table-rule', 'second-rule'], boundary_lot_ids: [second.id] }); await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(sent).toEqual([['lot-0'], ['lot-1']]);
  });

  it('refuses a fake holdout before another model call when all members were already exposed, including after renaming', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const calls = reviewer.mock.calls.length;
    f.delivery.groups[0]!.boundary_lot_ids = [];
    f.delivery.groups[0]!.lot_ids[1] = 'renamed'; f.delivery.lots[1]!.id = 'renamed';
    f.delivery.dispositions.find(row => row.lot_ids.includes('lot-1'))!.lot_ids = ['renamed']; await f.save();
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).toMatchObject({ ok: false, error: 'holdout_sample_unavailable' });
    expect(reviewer).toHaveBeenCalledTimes(calls);
    expect(f.controller.state().approvals).toEqual([]);
  });

  it('reuses only explicit passing per-lot decisions after a group rejection and reviews just the separately repaired method', async () => {
    const sent: string[][] = [];
    const f = await setup(async request => {
      sent.push(request.lots.map(lot => lot.id));
      if (sent.length !== 1) return approved(request);
      return { approved: false, reviewed_lot_ids: ['lot-0', 'lot-1'], reason: '第二批有虚构局部问题；第一批已逐项核对',
        lot_decisions: [{ lot_id: 'lot-0', approved: true, reason: '第一批通过' }, { lot_id: 'lot-1', approved: false, reason: '第二批待修复' }],
        findings: [{ lot_id: 'lot-1', path: '/items/0', message: '虚构局部提取问题', evidence: request.lots.find(lot => lot.id === 'lot-1')!.scope.evidence }] };
    });
    f.delivery.lots[1]!.items[0]!.rule_ids = ['second-rule'];
    f.delivery.rules.push({ ...structuredClone(f.delivery.rules[0]!), id: 'second-rule', method_files: ['second.mjs'] });
    f.delivery.groups[0]!.rule_ids.push('second-rule'); f.delivery.groups[0]!.boundary_lot_ids = ['lot-1'];
    await writeFile(join(f.controller.workRoot, 'second.mjs'), '// first independent method'); await f.save();
    expect((await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    expect(f.controller.state().sample_reviews?.map(row => row.lot_id)).toEqual(['lot-0']);
    expect(f.controller.state().approvals).toEqual([]);
    await writeFile(join(f.controller.workRoot, 'second.mjs'), '// corrected independent method');
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect((await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(true);
    expect(sent).toEqual([['lot-0', 'lot-1'], ['lot-1']]);
    await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(sent).toHaveLength(2);
  });

  it.each(['shared-method', 'shared-rule', 'field'])('invalidates the appropriate accepted samples when %s really changes', async change => {
    const sent: string[][] = [], f = await setup(async request => { sent.push(request.lots.map(lot => lot.id)); return approved(request); });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    if (change === 'shared-method') await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// shared method changed');
    if (change === 'shared-rule') f.delivery.rules[0]!.scope = '修正共享适用条件';
    if (change === 'field') f.delivery.lots[0]!.items[0]!.condition.reason = '经核对原文确无另列条件';
    await f.save(); await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(sent).toEqual([['lot-0', 'lot-1'], change === 'field' ? ['lot-0'] : ['lot-0', 'lot-1']]);
  });

  it('does not infer acceptance of unmentioned lots from a rejected review', async () => {
    const sent: string[][] = [], f = await setup(async request => {
      sent.push(request.lots.map(lot => lot.id));
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '仍有一个局部问题',
        findings: [{ lot_id: 'lot-1', path: '/items/0', message: '虚构问题', evidence: request.lots.find(lot => lot.id === 'lot-1')!.scope.evidence }] };
    });
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(f.controller.state().sample_reviews ?? []).toEqual([]);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(sent).toHaveLength(1); // identical rejected input is returned from its receipt, not sent again
  });

  it('labels an explicit full-member review honestly and never reads the same passed samples twice', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    f.delivery.groups[0]!.boundary_lot_ids = ['lot-1']; await f.save();
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const result = await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' });
    expect(result).toMatchObject({ ok: true, review_mode: 'full', holdout_available: false });
    expect(reviewer).toHaveBeenCalledTimes(1);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'prose' });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
  });

  it.each([false, true])('resumes an interrupted holdout only with unchanged frozen inputs (changed=%s)', async changed => {
    const abort = new AbortController(), sent: string[] = [];
    const f = await setup(async request => {
      sent.push(request.phase);
      if (request.phase === 'holdout') { abort.abort(); throw new Error('normal pause'); }
      return approved(request);
    });
    await expect(f.controller.dispatch('review_acceptance_group', { group_id: 'tables' }, abort.signal)).rejects.toThrow('normal pause');
    const pending = f.controller.state().requests.at(-1)!;
    expect(pending).toMatchObject({ phase: 'holdout', status: 'pending', attempts: 1 });
    if (changed) { f.delivery.lots[1]!.items[0]!.condition.reason = '原文未给条件，修正说明'; await f.save(); }
    const reviewer = vi.fn(approved), restored = await AcceptanceAutonomousController.open({ ...f.options, reviewer });
    const result = await restored.dispatch('review_acceptance_group', { group_id: 'tables' });
    if (changed) {
      expect(result).toMatchObject({ ok: false, error: 'holdout_sample_unavailable' });
      expect(reviewer).not.toHaveBeenCalled();
    } else {
      expect(result.ok).toBe(true); expect(reviewer.mock.calls.map(([request]) => request.phase)).toEqual(['holdout']);
      expect(restored.state().requests.find(row => row.id === pending.id)).toMatchObject({ attempts: 2, status: 'passed' });
      await restored.dispatch('review_acceptance_group', { group_id: 'prose' });
      const sealed = await restored.dispatch('seal_acceptance_delivery', {});
      await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
    }
  });

  it('binds per-sample decisions into the seal and rejects missing sample coverage', async () => {
    const f = await setup();
    for (const group of f.delivery.groups) await f.controller.dispatch('review_acceptance_group', { group_id: group.id });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    const artifact = JSON.parse(await readFile(String(sealed.path), 'utf8'));
    artifact.reviews[0].result.approved = false;
    await writeFile(String(sealed.path), JSON.stringify(artifact));
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).rejects.toThrow('fingerprint');
    artifact.reviews[0].result.approved = true;
    artifact.approvals[0].sample_reviews.pop();
    artifact.fingerprint = sha256Json({ delivery: sha256Json(artifact.delivery), approvals: artifact.approvals, ids: artifact.lot_ids,
      inventory: artifact.inventory_request_id, review_protocol_version: artifact.review_protocol_version, reviews: artifact.reviews,
      training_declarations: artifact.training_declarations });
    const checkpoint = f.controller.state(); checkpoint.publications[0]!.fingerprint = artifact.fingerprint;
    await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(checkpoint));
    await writeFile(String(sealed.path), JSON.stringify(artifact));
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).rejects.toThrow('Sample decision');
  });

  it.each(['lot', 'block', 'rule', 'transitive-lot'] as const)('filters each mixed problem by its own %s scope and retains full publication blockers', async scope => {
    const f = await setup();
    if (scope === 'transitive-lot') f.delivery.lots[0]!.dependency_ids.push('lot-2');
    f.delivery.problems = [
      { id: 'whole-document-backlog', kind: 'structure', message: '其他范围尚待处理。', affected_lot_ids: [], block_ids: [], dependency_ids: [] },
      { id: 'other-candidate', kind: 'conflict', message: '乙构件的独立问题。', affected_lot_ids: ['lot-1'], block_ids: [], dependency_ids: [] },
      { id: 'current-candidate', kind: 'conflict', message: '当前小样或其依赖尚有问题。',
        affected_lot_ids: scope === 'lot' ? ['lot-0'] : scope === 'transitive-lot' ? ['lot-2'] : [],
        block_ids: scope === 'block' ? f.delivery.lots[0]!.scope.block_ids : [],
        dependency_ids: scope === 'rule' ? ['table-rule'] : [] },
    ];
    const checked = validateAcceptanceDelivery(f.delivery, { sources: [f.ledger], root_source_id: f.ledger.source_id, resolved_references: {} });
    expect(checked.issues).toHaveLength(3);
    const group = { ...f.delivery.groups[0]!, lot_ids: ['lot-0'] };
    const blockers = groupReviewBlockers(f.delivery, group, checked.issues);
    expect(blockers.map(issue => (issue.actual as { id: string }).id)).toEqual(['current-candidate']);
    expect(blockers[0]!.path).toBe('/problems/2');
    expect(eligibleLotIds(f.delivery, checked.issues, new Set(f.delivery.groups.map(row => row.id)))).toEqual([]);
  });

  it('allows an independent trial after its own issue is resolved while other problems still prevent publication', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    f.delivery.problems = [
      { id: 'remaining-book', kind: 'structure', message: '全书其他部分尚未完成。', affected_lot_ids: [], block_ids: [], dependency_ids: [] },
      { id: 'prose-conflict', kind: 'conflict', message: '丙构件需要另行核实。', affected_lot_ids: ['lot-2'], block_ids: [], dependency_ids: [] },
      { id: 'sample-conflict', kind: 'conflict', message: '甲构件仍有一个真实问题。', affected_lot_ids: ['lot-0'], block_ids: [], dependency_ids: [] },
    ];
    await f.save(); await f.controller.beginSession(); await f.controller.accountTool(1234, 2400);
    const blocked = await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(blocked).toMatchObject({ ok: false, total_issues: 1, issues: [{ code: 'pending_conflict', count: 1, path: '/problems/2' }] });
    expect(reviewer).not.toHaveBeenCalled();
    f.delivery.problems = f.delivery.problems.filter(problem => problem.id !== 'sample-conflict'); await f.save();
    const resumed = await AcceptanceAutonomousController.open(f.options);
    expect(await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: true, batch_ready: true, semantic_approval: false });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0]![0].lots.map(lot => lot.id)).toEqual(['lot-0']);
    expect((await resumed.dispatch('seal_acceptance_delivery', {})).ok).toBe(false);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(resumed.state().budget).toMatchObject({ ...limits, attempts: 1, tool_response_bytes: 1234, observed_context_tokens: 2400 });
    expect(resumed.state().publications).toEqual([]);
    expect(f.delivery.problems.map(problem => problem.id)).toEqual(['remaining-book', 'prose-conflict']);
  });

  it('keeps an unresolvable problem scope fail-closed before any reviewer starts', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    f.delivery.problems.push({ id: 'bad-scope', kind: 'conflict', message: '影响范围不能指向不存在的对象。', affected_lot_ids: ['unknown-lot'], block_ids: [], dependency_ids: [] });
    await f.save();
    expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown_problem_scope' })]) });
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('reviews a first sample amid global backlog, reuses that trial after batching/resume, and still blocks premature publication', async () => {
    const requests: GroupReviewRequest[] = [];
    const f = await setup(async request => { requests.push(request); return approved(request); },
      original + Array.from({ length: 2000 }, (_, i) => `\n\n其他尚待提取的虚构条款 ${i}。`).join(''));
    const second = f.delivery.lots[1]!;
    f.delivery.lots = [f.delivery.lots[0]!];
    f.delivery.groups = [{ ...f.delivery.groups[0]!, lot_ids: ['lot-0'] }];
    for (const row of f.delivery.dispositions) if (!row.lot_ids.includes('lot-0')) {
      row.role = 'unresolved'; row.lot_ids = []; row.reason = '主体尚待批量处理。'; row.evidence = [];
    }
    f.delivery.problems.push({ id: 'remaining', kind: 'scope', message: '全局范围尚未确认。', affected_lot_ids: [], block_ids: [], dependency_ids: [] });
    await f.save(); await f.controller.beginSession(); await f.controller.accountTool(1234, 2400);
    expect((await f.controller.dispatch('validate_acceptance_delivery', {})).ok).toBe(false);
    const trial = await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    expect(trial).toMatchObject({ ok: true, stage: 'trial', batch_ready: true, semantic_approval: false });
    expect(requests.map(r => r.phase)).toEqual(['trial']);
    expect(f.controller.state().approvals).toEqual([]);
    expect((await f.controller.dispatch('seal_acceptance_delivery', {})).ok).toBe(false);
    expect(requests.map(r => r.phase)).toEqual(['trial']); // no costly inventory for known unfinished work
    f.delivery.lots.push(second); f.delivery.groups[0]!.lot_ids.push(second.id);
    const row = f.delivery.dispositions.find(row => row.block_id === second.scope.block_ids[0])!;
    Object.assign(row, { role: 'lot', lot_ids: [second.id], evidence: second.scope.evidence }); await f.save();
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect((await restored.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' })).ok).toBe(true);
    expect(requests.map(r => [r.phase, r.lots.map(lot => lot.id)])).toEqual([['trial', ['lot-0']], ['holdout', ['lot-1']]]);
    expect(restored.state().budget).toMatchObject({ ...limits, attempts: 1, tool_response_bytes: 1234, observed_context_tokens: 2400 });
    expect(restored.state().approvals).toHaveLength(1);
    expect((await restored.dispatch('seal_acceptance_delivery', {})).ok).toBe(false);
    expect(restored.state().publications).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it.each(['review_acceptance_group', 'review_acceptance_groups'])('explains the exact problem scope blocking %s without clearing it or starting a review', async tool => {
    const reviewer = vi.fn<GroupReviewer>(async request => ({ ...await approved(request),
      lot_decisions: request.lots.map(lot => ({ lot_id: lot.id, approved: true, reason: '合成原文一致' })) }));
    const f = await setup(reviewer, original + '\n\n尚未识别的合成页。');
    const unknown = f.ledger.blocks.at(-1)!;
    f.delivery.dispositions.find(row => row.block_id === unknown.id)!.role = 'unresolved';
    f.delivery.problems.push({ id: 'unfinished', kind: 'structure', message: '虚构进度：等待复核。'.repeat(10000),
      affected_lot_ids: [], block_ids: f.ledger.blocks.map(block => block.id), dependency_ids: [] }); await f.save();
    const params = tool === 'review_acceptance_groups' ? { groups: [{ group_id: 'tables', phase: 'trial' }] } : { group_id: 'tables', phase: 'trial' };
    const budget = structuredClone(f.controller.state().budget), before = await readFile(join(f.controller.workRoot, 'DELIVERY.json'), 'utf8');
    const result = await f.controller.dispatch(tool, params);
    const blocked: any = tool === 'review_acceptance_groups' ? (result.results as any[])[0] : result;
    expect(blocked).toMatchObject({ ok: false, model_started: false, next_tool: 'validate_acceptance_delivery',
      blocked_problem_scopes: [expect.objectContaining({ path: '/problems/0',
        actual: expect.objectContaining({ declared_block_count: f.ledger.blocks.length, matching_block_count: 1,
          matching_blocks: [{ block_id: f.delivery.lots[0]!.scope.block_ids[0], roles: ['lot'], consumer_lot_ids: ['lot-0'] }] }),
        writable_paths: expect.arrayContaining(['/problems/0/block_ids', '/problems/0/affected_lot_ids']) })] });
    expect(blocked.how_to_pass).toContain('report_acceptance_progress');
    expect(Buffer.byteLength(JSON.stringify(blocked))).toBeLessThan(16384);
    expect(reviewer).not.toHaveBeenCalled(); expect(f.controller.state().requests).toEqual([]);
    expect(f.controller.state().budget).toEqual(budget);
    expect(await readFile(join(f.controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(before);
    // The fictional author corrects its stale declaration; the real global unknown remains a publication blocker.
    f.delivery.problems[0]!.block_ids = [unknown.id]; await f.save();
    expect((await f.controller.dispatch(tool, params)).ok).toBe(true);
    expect(reviewer).toHaveBeenCalledTimes(1);
    const checked = validateAcceptanceDelivery(f.delivery, { sources: [f.ledger], root_source_id: f.ledger.source_id, resolved_references: {} });
    expect(eligibleLotIds(f.delivery, checked.issues, new Set(['tables', 'prose']))).toEqual([]);
    expect(f.controller.state().approvals).toEqual([]); expect(f.controller.state().publications).toEqual([]);
  });

  it.each(['local-evidence', 'shared-rule', 'source-version', 'local-problem', 'dependency', 'empty-group'])('still blocks a trial for %s defects', async defect => {
    const reviewer = vi.fn(approved);
    const f = await setup(reviewer);
    if (defect === 'local-evidence') f.delivery.lots[0]!.items[0]!.requirement.value = '999';
    if (defect === 'shared-rule') f.delivery.rules[0]!.evidence[0]!.text = 'wrong';
    if (defect === 'source-version') f.delivery.source_sha256 = 'wrong';
    if (defect === 'local-problem') f.delivery.problems.push({ id: 'ambiguous', kind: 'scope', message: '该样本边界未确认', affected_lot_ids: [], block_ids: f.delivery.lots[0]!.scope.block_ids, dependency_ids: [] });
    if (defect === 'dependency') { f.delivery.lots[0]!.dependency_ids = ['lot-2']; f.delivery.lots[2]!.items[0]!.requirement.value = 'wrong'; }
    if (defect === 'empty-group') { f.delivery.groups[0]!.lot_ids = []; f.delivery.groups[0]!.trial_lot_ids = []; }
    await f.save();
    expect((await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('invalidates a cached trial when its method changes and never skips independent holdout approval', async () => {
    const requests: string[] = [];
    const f = await setup(async request => { requests.push(request.phase); return approved(request); });
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// corrected reusable method');
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'complete' });
    expect(requests).toEqual(['trial', 'trial', 'holdout']);
    for (const group of f.delivery.groups) await f.controller.dispatch('review_acceptance_group', { group_id: group.id });
    const sealed = await f.controller.dispatch('seal_acceptance_delivery', {});
    expect(sealed.ok).toBe(true);
    await expect(verifyAutonomousSealedDelivery(String(sealed.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
  });

  it('keeps source paths discoverable before large context and candidate pages', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' });
    const request = reviewer.mock.calls[0]![0];
    const large: GroupReviewRequest = { ...request,
      source_context: Array.from({ length: 250 }, () => request.source_context![0]!),
      lots: Array.from({ length: 17 }, (_, index) => ({ ...structuredClone(request.lots[0]!), id: `fictional-${index}`,
        items: request.lots[0]!.items.map(item => ({ ...structuredClone(item), note: { value: '虚构待核验附注'.repeat(3000), evidence: [], reason: '传输测试数据' } })) })),
    };
    const sources = request.sources.map(source => ({ source_id: source.source_id,
      ledger: join(f.controller.sourceRoot, `${source.source_id}.json`), markdown: join(f.controller.sourceRoot, `${source.source_id}.md`), block_count: source.blocks.length }));
    const text = formatAcceptanceReviewJson({ ...acceptanceReviewView(large), sources });
    const firstRead = text.split('\n').slice(0, 200).join('\n');
    expect(Buffer.byteLength(text)).toBeGreaterThan(131072);
    expect(firstRead).toContain(JSON.stringify(sources[0]!.markdown));
    expect(firstRead).toContain(JSON.stringify(sources[0]!.ledger));
    expect(Buffer.byteLength(firstRead)).toBeLessThan(131072);
    expect(text.slice(0, 2048)).toContain('"source_context"');
    expect(JSON.parse(text).source_context).toEqual(large.source_context);
    expect(JSON.parse(text).lots).toHaveLength(17);
    expect(await readFile(sources[0]!.markdown, 'utf8')).toBe(original);
  });

  it('retries an incomplete rejection in the original request with all usage and the prior result retained', async () => {
    let controller!: AcceptanceAutonomousController, calls = 0;
    const f = await setup(async request => {
      calls++; await controller.accountTool(35, 0, request.id);
      const decision = await approved(request);
      return calls === 1 ? { ...decision, approved: false, reason: '虚构复核尚未完成，未判断内容错误' } : decision;
    }, original, 524288); controller = f.controller;
    const before = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8');
    expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    const first = structuredClone(controller.state().requests[0]!);
    expect(first).toMatchObject({ status: 'needs_work', attempts: 1, tool_response_bytes: 35 });
    expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(true);
    expect(calls).toBe(2); expect(controller.state().requests).toHaveLength(1);
    expect(controller.state().requests[0]).toMatchObject({ id: first.id, status: 'passed', attempts: 2, tool_response_bytes: 70 });
    const events = (await readFile(join(controller.root, 'session.events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.find(event => event.event_type === 'incomplete_review_retried')?.payload).toMatchObject({ request_id: first.id,
      previous_result: first.result, attempts: 1, tool_response_bytes: 35, counters_reset: false });
    expect(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(before);
    expect(controller.state().approvals).toEqual([]); expect(controller.state().publications).toEqual([]);
    await controller.assertSources();
  });

  it('caches an evidence-backed rejection while the reviewed inputs are unchanged', async () => {
    let controller!: AcceptanceAutonomousController;
    const reviewer = vi.fn<GroupReviewer>(async request => {
      await controller.accountTool(25, 0, request.id);
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '虚构字段需要修正', findings: [{
        lot_id: request.lots[0]!.id, path: 'items[0].requirement', message: '本例保留一条有原文证据的修改意见', evidence: request.lots[0]!.scope.evidence }] };
    });
    const f = await setup(reviewer, original, 524288); controller = f.controller;
    for (let index = 0; index < 2; index++) expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(controller.state().requests[0]).toMatchObject({ status: 'needs_work', attempts: 1, tool_response_bytes: 25 });
    expect(controller.state().requests[0]!.result?.findings).toHaveLength(1);
  });

  it('keeps the original attempt limit for incomplete retries without clearing accumulated bytes', async () => {
    let controller!: AcceptanceAutonomousController, calls = 0;
    const f = await setup(async request => {
      calls++; await controller.accountTool(25, 0, request.id);
      return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '虚构复核尚未完成', findings: [] };
    }, original, 524288); controller = f.controller;
    for (let index = 0; index < 4; index++) expect((await controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'trial' })).ok).toBe(false);
    expect(calls).toBe(3); expect(controller.state().requests).toHaveLength(1);
    expect(controller.state().requests[0]).toMatchObject({ status: 'failed', attempts: 3, tool_response_bytes: 75, error: 'Review attempt limit reached.' });
    expect(controller.state().budget.tool_response_bytes).toBe(75);
  });

  it('keeps ordinary pending work with the author and sends only relevant evidence to an exception investigation', async () => {
    const requests: GroupReviewRequest[] = [];
    const f = await setup(async request => { requests.push(request); return approved(request); },
      original + Array.from({ length: 1000 }, (_, i) => `\n\n无关原文，不应传入局部调查 ${i}。`).join(''));
    f.delivery.problems.push({ id: 'backlog', kind: 'structure', message: '全文尚未处理完。', affected_lot_ids: [], block_ids: [], dependency_ids: [] });
    await f.save();
    expect(await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'backlog' })).toMatchObject({ ok: false, error: 'exception_scope_required' });
    expect(requests).toEqual([]);
    f.delivery.problems.push({ id: 'local', kind: 'conflict', message: '甲构件判据与单位的局部歧义', affected_lot_ids: ['lot-0'], block_ids: [], dependency_ids: ['table-rule'] });
    await f.save();
    expect(await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'local' })).toMatchObject({ ok: true, semantic_approval: false });
    const request = requests[0]!;
    expect(request.lots.map(lot => lot.id)).toEqual(['lot-0']);
    expect(request.dispositions.map(row => row.block_id)).toEqual(f.ledger.blocks.slice(0, 3).map(block => block.id));
    const view = JSON.stringify(acceptanceReviewView(request));
    expect(view).not.toContain('无关原文');
    expect(view).not.toContain('乙构件');
    expect(view).toContain('甲构件长度');
    expect(view).not.toContain('<table>'); // source quotations stay at their coordinates
    expect(Buffer.byteLength(view)).toBeLessThan(10000);
    expect(request.source_context?.find(row => row.block_id === f.delivery.lots[0]!.scope.block_ids[0])).toMatchObject({ source_id: f.ledger.source_id, start_line: 3, end_line: 3 });
    expect(f.controller.state().approvals).toEqual([]);
    expect(f.delivery.problems[0]!.affected_lot_ids).toEqual([]);
  });

  it('can investigate a specific unassigned block without expanding to every existing lot', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    const block = f.ledger.blocks[4]!;
    f.delivery.problems.push({ id: 'note', kind: 'conflict', message: '附注指向对象不明', affected_lot_ids: [], block_ids: [block.id], dependency_ids: [] }); await f.save();
    expect((await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'note' })).ok).toBe(true);
    expect(reviewer.mock.calls[0]![0].lots).toEqual([]);
    expect(reviewer.mock.calls[0]![0].source_context?.some(row => row.block_id === block.id)).toBe(true);
  });

  it('keeps other consumers of a shared rule out of a local investigation while retaining unowned common definitions', async () => {
    const siblingTable = buildAcceptanceSourceLedger(original).blocks.filter(block => block.kind === 'table')[1]!.text;
    const reviewer = vi.fn(approved), f = await setup(reviewer,
      original + Array.from({ length: 20 }, (_, index) => `\n\n虚构附页${index}\n\n${siblingTable}`).join('') + '\n\n虚构共用定义：长度为指定测点间距离。');
    const otherBlocks = f.ledger.blocks.filter(block => block.kind === 'table').slice(2);
    const oldBlock = f.delivery.lots[1]!.scope.block_ids[0]!;
    for (const [index, block] of otherBlocks.entries()) {
      const lot = JSON.parse(JSON.stringify(f.delivery.lots[1]).replaceAll(oldBlock, block.id)) as AcceptanceLot;
      lot.id = `other-${index}`; f.delivery.lots.push(lot); f.delivery.groups[0]!.lot_ids.push(lot.id);
      const disposition = f.delivery.dispositions.find(row => row.block_id === block.id)!;
      disposition.role = 'lot'; disposition.lot_ids = [lot.id];
      f.delivery.rules[0]!.evidence.push(sourceQuote(f.ledger, block));
    }
    const definition = f.ledger.blocks.at(-1)!;
    f.delivery.rules[0]!.evidence.push(sourceQuote(f.ledger, definition));
    f.delivery.problems.push({ id: 'shared-local', kind: 'conflict', message: '甲构件局部读数有歧义',
      affected_lot_ids: ['lot-0'], block_ids: [], dependency_ids: ['table-rule'] }); await f.save();
    const before = await readFile(join(f.controller.workRoot, 'DELIVERY.json'), 'utf8');
    const result = await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'shared-local' });
    expect(result).toMatchObject({ ok: true, semantic_approval: false });
    const request = reviewer.mock.calls[0]![0];
    expect(request.lots.map(lot => lot.id)).toEqual(['lot-0']);
    expect(request.rules[0]!.evidence.some(quote => otherBlocks.some(block => block.id === quote.block_id))).toBe(false);
    expect(request.rules[0]!.evidence.some(quote => quote.block_id === definition.id)).toBe(true);
    expect(request.source_context?.some(row => row.block_id === otherBlocks[5]!.id)).toBe(false);
    expect(request.source_context?.some(row => row.block_id === definition.id)).toBe(true);
    expect(request.source_context!.length).toBeLessThan(10);
    expect(formatAcceptanceReviewJson(acceptanceReviewView(request)).slice(0, 2048)).toContain('"source_context"');
    expect(await readFile(join(f.controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(before);
    expect(f.controller.state().approvals).toEqual([]); expect(f.controller.state().publications).toEqual([]);
  });

  it('retains explicitly consumed evidence even when its source block also belongs to another lot', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    const quote = f.delivery.lots[2]!.scope.evidence[0]!;
    f.delivery.rules[0]!.evidence.push(quote);
    f.delivery.lots[0]!.items[0]!.note = { value: quote.text, evidence: [quote] };
    f.delivery.problems.push({ id: 'cross-source-note', kind: 'conflict', message: '当前项目明确引用的附注有歧义',
      affected_lot_ids: ['lot-0'], block_ids: [], dependency_ids: ['table-rule'] }); await f.save();
    await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'cross-source-note' });
    const request = reviewer.mock.calls[0]![0];
    expect(request.lots.map(lot => lot.id)).toEqual(['lot-0']);
    expect(request.rules[0]!.evidence).toContainEqual(quote);
    expect(request.source_context?.some(row => row.block_id === quote.block_id && row.source_id === quote.source_id)).toBe(true);
  });

  it('includes explicitly named dependencies when investigating an unassigned source ambiguity', async () => {
    const reviewer = vi.fn(approved), f = await setup(reviewer);
    const block = f.ledger.blocks[4]!;
    f.delivery.problems.push({ id: 'note', kind: 'conflict', message: '附注与正文规则关系不明', affected_lot_ids: [], block_ids: [block.id], dependency_ids: ['prose-rule'] }); await f.save();
    expect((await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'note' })).ok).toBe(true);
    expect(reviewer.mock.calls[0]![0].rules.map(rule => rule.id)).toEqual(['prose-rule']);
  });

  it('identifies the exact invalid reviewer evidence and preserves all correctly evidenced findings on resubmission', async () => {
    const f = await setup();
    const evidence = f.delivery.lots[0]!.scope.evidence;
    const validFinding = { lot_id: 'lot-0', path: '/items/0/requirement', message: '虚构局部字段问题', evidence };
    const result = { approved: false, reviewed_lot_ids: ['lot-0'], reason: '有可定位问题',
      findings: [validFinding, { ...validFinding, evidence: [{ ...evidence[0]!, text: 'wrong' }] }] };
    expect(reviewSubmissionIssues(result, ['lot-0'], [f.ledger])).toMatchObject([
      { path: '/findings/1/evidence/0', actual: { text: 'wrong' }, expected: { source_block_exists: true, text_at_range: evidence[0]!.text } },
    ]);
    result.findings[1]!.evidence = evidence;
    expect(reviewSubmissionIssues(result, ['lot-0'], [f.ledger])).toEqual([]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toBe(validFinding);
  });

  it('rejects an unassigned finding instead of allowing all per-lot passes to bypass a group rejection', async () => {
    const f = await setup();
    const result = { approved: false, reviewed_lot_ids: ['lot-0'], reason: '仍有未归属问题',
      lot_decisions: [{ lot_id: 'lot-0', approved: true, reason: '声称通过' }],
      findings: [{ lot_id: 'unknown', path: '/items', message: '未归属的虚构问题', evidence: f.delivery.lots[0]!.scope.evidence }] };
    expect(reviewSubmissionIssues(result, ['lot-0'], [f.ledger])).toMatchObject([{ path: '/findings/0/lot_id', actual: 'unknown' }]);
    result.findings[0]!.lot_id = '';
    expect(reviewSubmissionIssues(result, ['lot-0'], [f.ledger])).toMatchObject([{ path: '/lot_decisions/0/approved', expected: false }]);
  });

  it('distinguishes an exact code miss from a globally clean delivery', async () => {
    const f = await setup(); f.delivery.lots[0]!.items[0]!.requirement.value = 'wrong'; await f.save();
    expect(await f.controller.dispatch('read_acceptance_issues', { code: 'literal' })).toMatchObject({ ok: true, total_issues: 0,
      matched_issue_count: 0, global_issue_count: 1, code_match: 'exact', available_codes: ['literal_field_mismatch'] });
  });

  it('rejects omissions in the independent inventory, invented literal values and broken sampling conditions', async () => {
    const { delivery, ledger } = await setup();
    const context = { sources: [ledger], root_source_id: ledger.source_id, resolved_references: {} };
    expect(validateAcceptanceDelivery(delivery, context).issues).toEqual([]);
    delivery.dispositions.pop();
    delivery.lots[0]!.items[0]!.requirement.value = '999';
    delivery.lots[1]!.items[0]!.sampling.status = 'requires_conditions';
    const codes = validateAcceptanceDelivery(delivery, context).issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['source_ledger_ownership', 'literal_field_mismatch', 'sampling_conditions_required']));
  });

  it('freezes methods, uses an unseen holdout, and invalidates the whole group when the method changes', async () => {
    const requests: Array<{ phase: string; ids: string[] }> = [];
    const fixture = await setup(async request => { requests.push({ phase: request.phase, ids: request.lots.map(lot => lot.id) }); return approved(request); });
    const { controller } = fixture;
    const result = await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables' });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([{ phase: 'trial', ids: ['lot-0'] }, { phase: 'holdout', ids: ['lot-1'] }]);
    await writeFile(join(controller.workRoot, 'extract.mjs'), '// revised method\n');
    await controller.dispatch('validate_acceptance_delivery', { path: 'DELIVERY.json' });
    expect(controller.state().approvals).toEqual([]);
    expect(controller.state().invalidations[0]?.group_id).toBe('tables');
  });

  it('catches mechanically valid systematic column swaps in holdout and permits only the independent group', async () => {
    const fixture = await setup(async request => {
      if (request.phase !== 'inventory') {
        const wrong = request.lots.filter(lot => lot.items[0]!.requirement.value === 'mm');
        if (wrong.length) return { approved: false, reviewed_lot_ids: request.lots.map(lot => lot.id), reason: '要求列与单位列整组错配。',
          findings: wrong.map(lot => ({ lot_id: lot.id, path: '/items/0/requirement', message: '单位不是允许偏差值。', evidence: lot.scope.evidence })) };
      }
      return approved(request);
    });
    const { controller, delivery, ledger, save } = fixture;
    const block = ledger.blocks.find(block => block.id === delivery.lots[1]!.scope.block_ids[0])!;
    delivery.lots[1]!.items[0]!.requirement = bind(ledger, block, 'mm'); await save();
    expect((await controller.dispatch('validate_acceptance_delivery', { path: 'DELIVERY.json' })).ok).toBe(true);
    const rejected = await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables' });
    expect(rejected.ok).toBe(false); expect(rejected.affected_lot_ids).toEqual(['lot-0', 'lot-1']);
    expect((await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'prose' })).ok).toBe(true);
    const sealed = await controller.dispatch('seal_acceptance_delivery', { path: 'DELIVERY.json' });
    expect(sealed).toMatchObject({ ok: true, status: 'partial', verified_lots: 1, remaining_lots: 2, published: false });
    const artifact = JSON.parse(await readFile(String(sealed.path), 'utf8'));
    expect(artifact.lot_ids).toEqual(['lot-2']); expect(artifact.reviews.some((row: { status: string }) => row.status === 'needs_work')).toBe(true);
  });

  it('propagates unresolved dependencies and blocks unknown global scope', async () => {
    const { delivery } = await setup();
    delivery.lots[2]!.dependency_ids = ['lot-0'];
    const approvedGroups = new Set(['tables', 'prose']);
    expect(eligibleLotIds(delivery, [{ code: 'conflict', path: '/lots/0', actual: '', message: '缺依据', affected_lot_ids: ['lot-0'] }], approvedGroups)).toEqual(['lot-1']);
    expect(eligibleLotIds(delivery, [{ code: 'scope', path: '/', actual: '', message: '范围未知', affected_lot_ids: [] }], approvedGroups)).toEqual([]);
    delivery.references.push({ id: 'shared-reference', origin: delivery.lots[0]!.name.evidence[0]!, standard_no: 'GB/T 99000-2050', version: '2050',
      clause: '2', object: '虚构构件', purpose: '共享条件', conditions: [], dependent_lot_ids: ['lot-0'], disposition: 'unresolved', evidence: [], reason: '缺少共享正文' });
    delivery.lots[2]!.dependency_ids = ['shared-reference'];
    expect(eligibleLotIds(delivery, [], approvedGroups)).toEqual(['lot-1']);
  });

  it('preserves review checkpoints, private approvals and budget totals across resume', async () => {
    const { controller, options } = await setup();
    await controller.beginSession(); await controller.accountTool(1234, 2400);
    await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables' });
    const restored = await AcceptanceAutonomousController.open(options);
    expect(restored.state().budget).toMatchObject({ attempts: 1, tool_response_bytes: 1234, observed_context_tokens: 2400 });
    expect(restored.state().approvals).toEqual(controller.state().approvals);
    await expect(AcceptanceAutonomousController.open({ ...options, limits: { ...limits, max_attempts: 4 } })).rejects.toThrow('budget configuration changed');
    while (restored.toolResponseUsage().remaining_bytes > 0) await restored.accountTool(Math.min(limits.max_single_tool_response_bytes, restored.toolResponseUsage().remaining_bytes));
    const exhausted = await AcceptanceAutonomousController.open(options);
    await expect(exhausted.beginSession()).rejects.toThrow('budget_exceeded');
    expect(exhausted.state().budget.attempts).toBe(1);
  });

  it('audits a host-authorized byte-cap addition, preserves all historical counters and resumes with the same base configuration', async () => {
    const f = await setup();
    await f.controller.beginSession(); await f.controller.accountTool(1234, 2400);
    await f.controller.appendEvent('fixture_history', { preserved: true });
    const beforeText = await readFile(join(f.controller.root, 'checkpoint.json'), 'utf8');
    const before = f.controller.state();
    const request = { request_id: 'fictional-user-addition-1', total_bytes: 1048576,
      reason: '先核对一类虚构表式的小样、批量输出和留出样本', authorized_by: 'fixture user' };
    const result = await f.controller.extendToolResponseBudget(request);
    expect(result).toMatchObject({ already_applied: false, tool_response_usage: { returned_content_bytes: 1234, remaining_bytes: 1048576 - 1234 } });
    expect(f.controller.state().budget).toEqual({ ...before.budget, max_tool_response_bytes: 1048576 });
    const audit = JSON.parse(await readFile(join(f.controller.root, 'budget-extensions', `${result.extension.id}.json`), 'utf8'));
    expect(audit.previous_checkpoint_text).toBe(beforeText);
    expect(audit.extension).toMatchObject({ from_bytes: 524288, to_bytes: 1048576, authorized_by: 'fixture user' });
    expect(f.controller.state().generation).toBe(before.generation);
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect(restored.state()).toEqual(f.controller.state());
    const events = await readFile(join(f.controller.root, 'session.events.jsonl'), 'utf8');
    expect(await restored.extendToolResponseBudget(request)).toMatchObject({ already_applied: true });
    expect(await readFile(join(f.controller.root, 'session.events.jsonl'), 'utf8')).toBe(events);
    await restored.beginSession(); await restored.accountTool(100);
    expect(restored.state().budget).toMatchObject({ attempts: 2, tool_response_bytes: 1334, observed_context_tokens: 2400 });
    expect(createAcceptanceAutonomousTools(restored).some(tool => /extend|budget_add/i.test(tool.name))).toBe(false);
    await expect(restored.extendToolResponseBudget({ ...request, total_bytes: 2097152 })).rejects.toThrow('different terms');
    await expect(restored.extendToolResponseBudget({ ...request, request_id: 'new', total_bytes: 524288 })).rejects.toThrow('Only an increase');
  });

  it.each(['audit', 'counter', 'history', 'cap'])('rejects %s tampering after an authorized addition', async kind => {
    const f = await setup(); await f.controller.accountTool(1234, 2400); await f.controller.appendEvent('fixture_history', { keep: true });
    const result = await f.controller.extendToolResponseBudget({ request_id: 'fictional-addition', total_bytes: 1048576, reason: '独立虚构试跑', authorized_by: 'fixture user' });
    if (kind === 'audit') await writeFile(join(f.controller.root, 'budget-extensions', `${result.extension.id}.json`), '{}');
    if (kind === 'history') await writeFile(join(f.controller.root, 'session.events.jsonl'), '{}\n');
    if (kind === 'counter' || kind === 'cap') {
      const checkpoint = f.controller.state();
      if (kind === 'counter') checkpoint.budget.tool_response_bytes = 0;
      else checkpoint.budget.max_tool_response_bytes = 2097152;
      await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(checkpoint));
    }
    await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow(/Budget extension|Budget cap/);
  });

  it('audits accounting-only task totals while preserving the checkpoint, old cap and all counters', async () => {
    const f = await setup();
    await f.controller.beginSession(); await f.controller.accountTool(1234, 2400);
    const before = f.controller.state(), beforeText = await readFile(join(f.controller.root, 'checkpoint.json'), 'utf8');
    const input = { request_id: 'fixture-per-subtask', max_tool_response_bytes: 524288, reason: '虚构全文按独立工作限额', authorized_by: 'fixture user' };
    const applied = await f.controller.useSubtaskBudgets(input);
    expect(f.controller.state()).toMatchObject({ ...before, subtask_budget_policy: applied.policy });
    const audit = JSON.parse(await readFile(join(f.controller.root, 'budget-policies', `${applied.policy.id}.json`), 'utf8'));
    expect(audit.previous_checkpoint_text).toBe(beforeText);
    expect(f.controller.toolResponseUsage()).toMatchObject({ scope: 'accounting_only', remaining_bytes: null, total_limit_bytes: null });
    for (let i = 0; i < 5; i++) await f.controller.accountTool(131072);
    const restored = await AcceptanceAutonomousController.open(f.options);
    expect(restored.state().budget).toEqual({ ...before.budget, tool_response_bytes: 1234 + 5 * 131072 });
    expect(await restored.useSubtaskBudgets(input)).toMatchObject({ already_applied: true });
    expect(createAcceptanceAutonomousTools(restored).some(tool => /budget/i.test(tool.name))).toBe(false);
    await expect(restored.accountTool(131073)).rejects.toThrow('response_too_large');
    await expect(restored.accountTool(0, limits.max_observed_context_tokens)).rejects.toThrow('context_window_exceeded');
  });

  it('keeps a historical context peak without permanently blocking a smaller current window', async () => {
    const f = await setup();
    await expect(f.controller.accountTool(0, limits.max_observed_context_tokens + 246)).rejects.toThrow();
    f.controller.observeContext(12000);
    await expect(f.controller.accountTool(71)).resolves.toBeUndefined();
    expect(f.controller.state().budget).toMatchObject({ tool_response_bytes: 71,
      observed_context_tokens: limits.max_observed_context_tokens + 246 });
  });

  it('requires the actual resumed SDK window to become ready while retaining the historical peak', async () => {
    const f = await setup();
    await expect(f.controller.accountTool(0, limits.max_observed_context_tokens + 246)).rejects.toThrow('context_window_exceeded');
    const restored = await AcceptanceAutonomousController.open(f.options);
    await restored.beginSession();
    await expect(restored.accountTool(1)).rejects.toThrow('context_window_exceeded');
    expect(() => restored.contextReady(limits.max_observed_context_tokens)).toThrow('context_window_not_ready');
    restored.contextReady(12000);
    await restored.accountTool(71);
    expect(restored.state().budget).toMatchObject({ attempts: 1, tool_response_bytes: 71,
      observed_context_tokens: limits.max_observed_context_tokens + 246 });
  });

  it('keeps review context pressure independent from the author and other review windows', async () => {
    let controller: AcceptanceAutonomousController;
    const f = await setup(async request => {
      controller.observeContext(request.group.id === 'tables' ? limits.max_observed_context_tokens + 1 : 12000, request.id);
      await controller.accountTool(1, 0, request.id);
      return approved(request);
    });
    controller = f.controller;
    controller.contextReady(12000);
    const first = await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'trial' });
    expect(JSON.stringify(first)).toContain('context_window_exceeded');
    expect(controller.state().status).toBe('working');
    await expect(controller.accountTool(1)).resolves.toBeUndefined();
    expect((await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'prose', phase: 'trial' })).ok).toBe(true);
    expect(controller.state().budget.observed_context_tokens).toBe(limits.max_observed_context_tokens + 1);
  });

  it('initializes newly created production tasks with independent request budgets and no total stop', async () => {
    const f = await setup();
    const options = { ...f.options, root: join(f.dir, 'new-run'), subtaskToolResponseBytes: 524288 };
    const controller = await AcceptanceAutonomousController.open(options);
    expect(controller.state().subtask_budget_policy).toMatchObject({ max_tool_response_bytes: 524288, authorized_by: 'application-default' });
    expect(controller.toolResponseUsage()).toMatchObject({ remaining_bytes: null, total_limit_bytes: null });
    expect((await AcceptanceAutonomousController.open(options)).state()).toEqual(controller.state());
  });

  it('stops only an exhausted review and never refills it on retry or resume', async () => {
    let controller: AcceptanceAutonomousController;
    let calls = 0;
    const f = await setup(async request => {
      calls++;
      await controller.accountTool(6, 0, request.id);
      if (request.group.id === 'tables') { await controller.accountTool(6, 0, request.id); await controller.accountTool(1, 0, request.id); }
      return approved(request);
    });
    controller = f.controller;
    await controller.useSubtaskBudgets({ request_id: 'fixture-isolation', max_tool_response_bytes: 12, reason: '虚构独立限额', authorized_by: 'fixture user' });
    const failed = await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'trial' });
    expect(JSON.stringify(failed)).toContain('autonomous_subtask_budget_exceeded');
    expect(controller.state()).toMatchObject({ status: 'working', requests: [{ status: 'failed', tool_response_bytes: 12 }] });
    controller = await AcceptanceAutonomousController.open(f.options);
    const before = calls;
    await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'trial' });
    expect(calls).toBe(before);
    expect((await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'prose', phase: 'trial' })).ok).toBe(true);
    expect(controller.state().requests.map(request => request.tool_response_bytes)).toEqual([12, 6]);
    expect(controller.state().budget.tool_response_bytes).toBe(18);
  });

  it('carries historical interrupted-request usage into the new policy without changing total accounting', async () => {
    let controller: AcceptanceAutonomousController;
    const f = await setup(async request => {
      const response = { content: [{ type: 'text', text: '虚构历史材料' }] };
      await controller.accountTool(toolResponseBytes(response));
      await controller.appendEvent('review_pi_sdk_event', { request_id: request.id,
        payload: { type: 'tool_execution_end', toolName: 'read', toolCallId: 'fixture-read', result: response } });
      throw new Error('fixture interrupted');
    });
    controller = f.controller;
    await controller.dispatch('review_acceptance_group', { path: 'DELIVERY.json', group_id: 'tables', phase: 'trial' });
    const before = controller.state();
    await controller.useSubtaskBudgets({ request_id: 'fixture-migration', max_tool_response_bytes: 524288, reason: '保留虚构旧用量', authorized_by: 'fixture user' });
    expect(controller.state().budget).toEqual(before.budget);
    expect(controller.state().requests[0]!.tool_response_bytes).toBe(before.budget.tool_response_bytes);
    expect((await AcceptanceAutonomousController.open(f.options)).state()).toEqual(controller.state());
  });

  it.each(['audit', 'counter', 'history', 'policy'])('rejects %s tampering after a per-subtask policy change', async kind => {
    const f = await setup(); await f.controller.accountTool(1234);
    await f.controller.appendEvent('fixture_history', { preserved: true });
    const { policy } = await f.controller.useSubtaskBudgets({ request_id: 'fixture-policy-integrity', max_tool_response_bytes: 524288,
      reason: '虚构政策审计', authorized_by: 'fixture user' });
    if (kind === 'audit') await writeFile(join(f.controller.root, 'budget-policies', `${policy.id}.json`), '{}');
    if (kind === 'history') await writeFile(join(f.controller.root, 'session.events.jsonl'), '{}\n');
    if (kind === 'counter' || kind === 'policy') {
      const state = f.controller.state();
      if (kind === 'counter') state.budget.tool_response_bytes = 0;
      else state.subtask_budget_policy!.max_tool_response_bytes = 1048576;
      await writeFile(join(f.controller.root, 'checkpoint.json'), JSON.stringify(state));
    }
    await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow();
  });

  it('returns one summary for repeated issue codes without hiding their complete validation scope', async () => {
    const f = await setup(approved, original + Array.from({ length: 2000 }, (_, i) => `\n\n虚构待分类段落 ${i}。`).join(''));
    for (const row of f.delivery.dispositions.slice(-2000)) { row.role = 'unresolved'; row.reason = '尚未核对归属。'; }
    await f.save();
    const first = await f.controller.dispatch('validate_acceptance_delivery', { path: 'DELIVERY.json' });
    expect(first).toMatchObject({ ok: false, total_issues: 2000, next_cursor: null,
      issues: [{ code: 'unresolved_source', count: 2000 }] });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(3000);
    const again = await f.controller.dispatch('validate_acceptance_delivery', { path: 'DELIVERY.json' });
    expect(again).toMatchObject({ ok: false, unchanged: true, total_issues: 2000, issues: [], issues_file: first.issues_file });
    const last = await f.controller.dispatch('read_acceptance_issues', { path: 'DELIVERY.json', code: 'unresolved_source', cursor: 1990 });
    expect(last).toMatchObject({ ok: true, total_issues: 2000, next_cursor: null });
    expect(last.issues).toHaveLength(10);
    const full = JSON.parse(await readFile(await f.controller.authorPath(String(first.issues_file)), 'utf8'));
    expect(full.issues).toHaveLength(2000);
    expect(eligibleLotIds(f.delivery, full.issues, new Set(['tables', 'prose']))).toEqual([]);
  });

  it('charges the returned error once when a native response is withheld, then accepts a smaller read', async () => {
    const f = await setup();
    const controller = await AcceptanceAutonomousController.open({ ...f.options, root: join(f.dir, 'small-response'), limits: { ...limits, max_single_tool_response_bytes: 2048 } });
    await writeFile(join(controller.workRoot, 'many-lines.txt'), Array.from({ length: 20 }, () => 'x'.repeat(500)).join('\n'));
    const read = createAcceptanceAutonomousTools(controller).find(tool => tool.name === 'read')!;
    const rejected = await read.execute('large-read', { path: 'many-lines.txt' }, undefined, undefined, {} as never);
    expect(rejected.details).toMatchObject({ ok: false, terminal: false, next_tool: 'read' });
    expect(String((rejected.details as { error: string }).error)).toContain('autonomous_response_too_large');
    expect(controller.state().budget.tool_response_bytes).toBe(toolResponseBytes(rejected));
    const accepted = await read.execute('small-read', { path: 'many-lines.txt', offset: 1, limit: 1 }, undefined, undefined, {} as never);
    expect(JSON.stringify(accepted.content)).toContain('x'.repeat(500));
    expect(controller.state().budget.tool_response_bytes).toBe(toolResponseBytes(rejected) + toolResponseBytes(accepted));
    expect(controller.state().status).not.toBe('blocked');
  });

  it('retains the legacy counter and checkpoint while adding a ledger-backed measurement correction exactly once', async () => {
    const f = await setup();
    await f.controller.beginSession();
    const checkpointPath = join(f.controller.root, 'checkpoint.json');
    const baseline = JSON.parse(await readFile(checkpointPath, 'utf8'));
    delete baseline.tool_response_accounting;
    const result = { content: [{ type: 'text', text: '虚构的实际回条。' }], details: { ui_only: 'x'.repeat(3000) } };
    const events = [
      { event_type: 'pi_sdk_event', payload: { type: 'tool_execution_start', toolCallId: 'test-call', toolName: 'read', args: { ignored_input: 'y'.repeat(2000) } } },
      { event_type: 'pi_sdk_event', payload: { type: 'tool_execution_end', toolCallId: 'test-call', toolName: 'read', result } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    baseline.budget.tool_response_bytes = toolResponseBytes(result) + 12000;
    baseline.status = 'blocked';
    await writeFile(checkpointPath, JSON.stringify(baseline));
    await writeFile(join(f.controller.root, 'session.events.jsonl'), events);
    const resumed = await AcceptanceAutonomousController.open(f.options);
    expect(resumed.state().budget).toEqual(baseline.budget);
    expect(resumed.toolResponseUsage()).toMatchObject({ returned_content_bytes: toolResponseBytes(result), historical_adjustment_bytes: 12000 });
    const audit = JSON.parse(await readFile(join(f.controller.root, 'tool-response-accounting-v1.json'), 'utf8'));
    expect(audit.original_checkpoint).toEqual(baseline);
    expect(audit.entries).toHaveLength(1);
    const again = await AcceptanceAutonomousController.open(f.options);
    expect(again.state().tool_response_accounting).toEqual(resumed.state().tool_response_accounting);
    await again.accountTool(17);
    expect(again.state().budget.tool_response_bytes).toBe(baseline.budget.tool_response_bytes + 17);
    expect(again.toolResponseUsage().returned_content_bytes).toBe(toolResponseBytes(result) + 17);
    expect(reconcileToolResponses(events.split('\n').slice(0, 1).join('\n'))).toBeUndefined();
    await writeFile(join(f.controller.root, 'tool-response-accounting-v1.json'), '{}');
    await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow('accounting audit changed');
  });

  it('bounds diagnostic pages by bytes while keeping complete large issue details readable', async () => {
    const { controller, delivery, ledger, save } = await setup(approved, original + Array.from({ length: 6000 }, (_, i) => `\n\n虚构说明段 ${i}。`).join(''));
    delivery.problems.push({ id: 'large-scope', kind: 'structure', message: '虚构大范围仍需核对。', affected_lot_ids: [],
      block_ids: ledger.blocks.map(block => block.id), dependency_ids: [] });
    await save();
    const rawIssues = validateAcceptanceDelivery(delivery, { sources: [ledger], root_source_id: ledger.source_id, resolved_references: {} }).issues;
    expect(rawIssues).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify({ issues: rawIssues }) }]))).toBeGreaterThan(limits.max_single_tool_response_bytes);
    const tools = createAcceptanceAutonomousTools(controller);
    const validation = await tools.find(tool => tool.name === 'validate_acceptance_delivery')!.execute('validate-large', { path: 'DELIVERY.json' }, undefined, undefined, {} as never);
    expect(validation.details).not.toHaveProperty('terminal');
    expect(Buffer.byteLength(JSON.stringify(validation.content))).toBeLessThan(limits.max_single_tool_response_bytes);
    const page = await tools.find(tool => tool.name === 'read_acceptance_issues')!.execute('issues-large', { path: 'DELIVERY.json', cursor: 0 }, undefined, undefined, {} as never);
    expect(page.details).toMatchObject({ ok: true, total_issues: 1, next_cursor: null });
    expect(Buffer.byteLength(JSON.stringify(page.content))).toBeLessThan(limits.max_single_tool_response_bytes);
    const details = page.details as { issues_file: string; issues: Array<{ code: string; path: string; actual: unknown; full_issue: { path: string; json_pointer: string } }> };
    expect(details.issues[0]).toMatchObject({ code: 'pending_structure', full_issue: { path: details.issues_file, json_pointer: '/issues/0' } });
    const full = JSON.parse(await readFile(await controller.authorPath(details.issues_file), 'utf8'));
    expect(full.issues[0].actual.block_ids).toEqual(delivery.problems[0]!.block_ids);
    expect(controller.state().status).not.toBe('blocked');
    for (let i = 0; i < 40; i += 1) delivery.problems.push({ id: `long-explanation-${i}`, kind: 'scope', message: '虚构范围说明。'.repeat(180),
      affected_lot_ids: [], block_ids: [ledger.blocks[i]!.id], dependency_ids: [] });
    await save();
    let cursor: number | null = 0;
    let seen = 0;
    while (cursor !== null) {
      const result = await controller.dispatch('read_acceptance_issues', { path: 'DELIVERY.json', cursor });
      const items = result.issues as Array<{ full_issue: { json_pointer: string } }>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThan(24);
      expect(Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(result) }]))).toBeLessThan(limits.max_single_tool_response_bytes);
      expect(items.map(item => item.full_issue.json_pointer)).toEqual(items.map((_, i) => `/issues/${seen + i}`));
      seen += items.length;
      cursor = result.next_cursor as number | null;
    }
    expect(seen).toBe(41);
  });

  it('rejects source edits, path escapes, symlink aliases and source hash changes', async () => {
    const { controller, options, dir } = await setup();
    await expect(controller.authorPath('../checkpoint.json', true)).rejects.toThrow('stay in this task');
    await expect(controller.authorPath(`source/${controller.state().source_sha256}.md`, true)).rejects.toThrow('read-only');
    await symlink(join(controller.workRoot, 'source'), join(controller.workRoot, 'alias'), 'junction');
    await expect(controller.authorPath(`alias/${controller.state().source_sha256}.md`, true)).rejects.toThrow('read-only');
    const tool = createAcceptanceAutonomousTools(controller).find(tool => tool.name === 'write')!;
    const result = await tool.execute('write-1', { path: '../checkpoint.json', content: '{}' }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ ok: false });
    await writeFile(join(dir, 'original.md'), original + '篡改');
    await expect(AcceptanceAutonomousController.open(options)).rejects.toThrow('source/version mismatch');
  });

  it('honors literal-only fields without looking up an available local document', async () => {
    const { controller, options, delivery, ledger, save } = await setup();
    const text = '<table><tr><td>验收项目</td><td>允许偏差</td></tr><tr><td>测试</td><td>按XY100-2020</td></tr></table>';
    const nextLedger = buildAcceptanceSourceLedger(text), block = nextLedger.blocks[0]!;
    const start = text.indexOf('XY100');
    const lookup = vi.fn(); const require = vi.fn();
    const nextPath = join(options.root, 'new-source.md'); await writeFile(nextPath, text);
    const next = await AcceptanceAutonomousController.open({ ...options, root: join(options.root, 'new'), markdownPath: nextPath, externalSourceWorkflow: { lookup, require } });
    const minimal = { ...delivery, source_sha256: nextLedger.sha256, rules: [], groups: [], lots: [], dispositions: [], references: [{ id: 'ref', origin: sourceQuote(nextLedger, block, start, start + 'XY100-2020'.length),
      standard_no: 'XY100-2020', version: '2020', clause: '', object: '测试对象', purpose: '允许偏差', conditions: [], dependent_lot_ids: [], disposition: 'literal', evidence: [], reason: '原文要求栏引用。' }], problems: [] };
    await writeFile(join(next.workRoot, 'DELIVERY.json'), JSON.stringify(minimal));
    expect(await next.dispatch('resolve_acceptance_reference', { path: 'DELIVERY.json', reference_id: 'ref' })).toMatchObject({ ok: true, action: 'retain_reference_literal', source_requested: false });
    expect(lookup).not.toHaveBeenCalled(); expect(require).not.toHaveBeenCalled();
  });

  it('rejects ambiguous origins before lookup and validates narrowed basis and allowance independently', async () => {
    const f = await setup();
    const text = '<table><tr><td>验收依据</td><td>GB/T 99000-2050</td></tr><tr><td>项目</td><td>允许偏差</td></tr><tr><td>构件</td><td>按GB/T 99001-2050</td></tr></table>';
    const ledger = buildAcceptanceSourceLedger(text), block = ledger.blocks[0]!;
    const external = '# GB/T 99000-2050 虚构构件标准\n\n构件表面应平整。';
    const externalLedger = buildAcceptanceSourceLedger(external);
    const lookup = vi.fn(async () => ({ standard_no: 'GB/T 99000-2050', markdown: external, markdown_sha256: externalLedger.sha256 }));
    const require = vi.fn();
    const markdownPath = join(f.dir, 'mixed.md'); await writeFile(markdownPath, text);
    const controller = await AcceptanceAutonomousController.open({ ...f.options, root: join(f.dir, 'mixed'), markdownPath, externalSourceWorkflow: { lookup, require } });
    const reference = { id: 'ref', origin: sourceQuote(ledger, block), standard_no: 'GB/T 99000-2050', version: '2050',
      clause: '', object: '虚构构件', purpose: '验收依据', conditions: [], dependent_lot_ids: [], disposition: 'unresolved' as const, evidence: [], reason: '核对实际依据。' };
    const delivery = { ...f.delivery, source_sha256: ledger.sha256, rules: [], groups: [], lots: [], dispositions: [], references: [reference], problems: [] };
    const save = () => writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(delivery)); await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'ref' })).toMatchObject({ ok: false, error: 'reference_origin_ambiguous', writable: 'references[id=ref].origin', next_tool: 'resolve_acceptance_reference' });
    expect(lookup).not.toHaveBeenCalled(); expect(require).not.toHaveBeenCalled();
    expect(validateAcceptanceDelivery(delivery, { sources: [ledger], root_source_id: ledger.source_id, resolved_references: {} }).issues.map(issue => issue.code))
      .toContain('reference_origin_ambiguous');
    const q = (s: string) => sourceQuote(ledger, block, text.indexOf(s), text.indexOf(s) + s.length);
    reference.origin = q('GB/T 99000-2050'); await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'ref' })).toMatchObject({ ok: true, source_id: externalLedger.source_id, action: 'assess_relevance' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('GB/T 99000-2050');
    reference.origin = q('GB/T 99001-2050'); reference.standard_no = 'GB/T 99001-2050'; await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'ref' })).toMatchObject({ ok: true, action: 'retain_reference_literal', source_requested: false });
    expect(lookup).toHaveBeenCalledTimes(1); expect(require).not.toHaveBeenCalled();
  });

  it('keeps same-document navigation local and expands nested references only when a local exact version exists', async () => {
    const f = await setup();
    const text = '验收依据：按本规程第3条。\n\n验收依据：GB/T 99000-2050《虚构甲规范》。';
    const external = '# GB/T 99000-2050 虚构甲规范\n\n验收依据：GB/T 99001-2050《虚构乙规范》。';
    const externalLedger = buildAcceptanceSourceLedger(external);
    const lookup = vi.fn(async no => no === 'GB/T 99000-2050' ? { standard_no: no, markdown: external, markdown_sha256: externalLedger.sha256 } : undefined);
    const require = vi.fn();
    const path = join(f.dir, 'navigation.md'); await writeFile(path, text);
    const controller = await AcceptanceAutonomousController.open({ ...f.options, root: join(f.dir, 'navigation'), markdownPath: path, externalSourceWorkflow: { lookup, require } });
    const ledger = buildAcceptanceSourceLedger(text);
    const reference = (id: string, source: SourceLedger, block: SourceBlock, standard: string, clause = '') => ({ id, origin: sourceQuote(source, block), standard_no: standard,
      version: standard ? '2050' : '', clause, object: '虚构构件', purpose: '验收依据', conditions: [], dependent_lot_ids: [], disposition: 'unresolved' as const, evidence: [], reason: '核对判据相关性' });
    const delivery = { ...f.delivery, source_sha256: ledger.sha256, rules: [], groups: [], lots: [], dispositions: [], problems: [],
      references: [reference('internal', ledger, ledger.blocks[0]!, '', '第3条'), reference('external', ledger, ledger.blocks[1]!, 'GB/T 99000-2050')] };
    const save = () => writeFile(join(controller.workRoot, 'DELIVERY.json'), JSON.stringify(delivery)); await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'internal' })).toMatchObject({ ok: true, internal_navigation: true, source_id: ledger.source_id });
    expect(lookup).not.toHaveBeenCalled();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'external' })).toMatchObject({ ok: true, source_id: externalLedger.source_id, semantic_approval: false });
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'external' })).toMatchObject({ ok: true, source_cache_hit: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    delivery.references.push(reference('nested', externalLedger, externalLedger.blocks[1]!, 'GB/T 99001-2050')); await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'nested' })).toMatchObject({ ok: true, action: 'retain_nested_reference_literal', source_requested: false });
    expect(require).not.toHaveBeenCalled();
    delivery.references[1]!.standard_no = 'GB/T 99000-2051'; delivery.references[1]!.version = '2051'; await save();
    expect(await controller.dispatch('resolve_acceptance_reference', { reference_id: 'external' })).toMatchObject({ ok: false });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('persists on-demand exception handoffs without granting approval and resumes an interrupted review without clearing attempts', async () => {
    const abort = new AbortController();
    const f = await setup(async request => { if (request.phase === 'exception') return approved(request); abort.abort(); throw new Error('normal pause'); });
    f.delivery.problems.push({ id: 'conflict', kind: 'conflict', message: '虚构局部方法冲突', affected_lot_ids: ['lot-2'], block_ids: [], dependency_ids: ['prose-rule'] }); await f.save();
    const investigated = await f.controller.dispatch('investigate_acceptance_exception', { problem_id: 'conflict' });
    expect(investigated).toMatchObject({ ok: true, semantic_approval: false });
    expect(f.controller.state().requests[0]).toMatchObject({ kind: 'exception', lot_ids: ['lot-2'] });
    expect(f.controller.state().approvals).toEqual([]);
    await expect(f.controller.dispatch('review_acceptance_group', { group_id: 'tables' }, abort.signal)).rejects.toThrow('normal pause');
    const state = f.controller.state(); expect(state.requests.at(-1)).toMatchObject({ status: 'pending', attempts: 1 });
    const restored = await AcceptanceAutonomousController.open({ ...f.options, reviewer: approved });
    expect((await restored.dispatch('review_acceptance_group', { group_id: 'tables' })).ok).toBe(true);
    expect(restored.state().requests.find(request => request.id === state.requests.at(-1)!.id)?.attempts).toBe(2);
  });

  it('fails closed if a sealed group method changes before publication', async () => {
    const f = await setup();
    for (const group of f.delivery.groups) await f.controller.dispatch('review_acceptance_group', { group_id: group.id });
    const seal = await f.controller.dispatch('seal_acceptance_delivery', {});
    expect(seal.ok).toBe(true);
    await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
    await writeFile(join(f.controller.workRoot, 'extract.mjs'), '// modified after approval');
    await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).rejects.toThrow('approval');
  });
});

it('session-start accounting removes only the task start ceiling and preserves all historical limits', async () => {
  const { controller, options } = await setup();
  await controller.accountTool(1234, 700);
  for (let n = 0; n < limits.max_attempts; n++) await controller.beginSession();
  await expect(controller.beginSession()).rejects.toThrow('attempt budget exhausted');
  const before = structuredClone(controller.state());
  const work = await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8');
  const input = { request_id: 'fictional-host-start-policy', reason: 'Continue fictional work with per-request limits intact.', authorized_by: 'fictional human approval' };
  await expect(controller.useTaskSessionAccounting({ ...input, authorized_by: '' })).rejects.toThrow(/authorization/i);
  expect(controller.state().budget).toEqual(before.budget);
  const applied = await controller.useTaskSessionAccounting(input);
  expect(applied.already_applied).toBe(false);
  expect(controller.state().budget).toEqual(before.budget);
  expect(controller.state().requests).toEqual(before.requests);
  expect((await controller.useTaskSessionAccounting(input)).already_applied).toBe(true);
  await expect(controller.useTaskSessionAccounting({ ...input, request_id: 'different-authority' })).rejects.toThrow(/different terms/i);
  const reopened = await AcceptanceAutonomousController.open(options);
  await reopened.beginSession();
  await reopened.accountTool(321, 800);
  expect(reopened.state().budget).toEqual({ ...before.budget, attempts: limits.max_attempts + 1, tool_response_bytes: 1555, observed_context_tokens: 800 });
  const workspace = await reopened.dispatch('acceptance_workspace', {});
  expect(workspace.session_start_usage).toMatchObject({ scope: 'accounting_only', total_limit: null, attempts: limits.max_attempts + 1, per_request_attempt_limit: limits.max_attempts });
  expect(await readFile(join(controller.workRoot, 'DELIVERY.json'), 'utf8')).toBe(work);
})

it.each(['audit', 'counter', 'request-limit'] as const)('session-start accounting rejects changed %s provenance without resetting the checkpoint', async tamper => {
  const { controller, options } = await setup();
  for (let n = 0; n < limits.max_attempts; n++) await controller.beginSession();
  await controller.useTaskSessionAccounting({ request_id: 'fictional-audit-policy', reason: 'Preserve fictional history.', authorized_by: 'fictional human approval' });
  const checkpointPath = join(controller.root, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  if (tamper === 'audit') {
    const path = join(controller.root, 'task-session-policies', checkpoint.task_session_start_policy.id + '.json');
    await writeFile(path, (await readFile(path, 'utf8')) + '\n');
  } else {
    if (tamper === 'counter') checkpoint.budget.attempts -= 1;
    else checkpoint.budget.max_attempts += 1;
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
  }
  const retained = await readFile(checkpointPath, 'utf8');
  await expect(AcceptanceAutonomousController.open(options)).rejects.toThrow(/policy|configuration/i);
  expect(await readFile(checkpointPath, 'utf8')).toBe(retained);
})

async function officialEditionControllerFixture(body = '# Fictional annex\nThis body applies only to fictional pipelines, not panels.', extraRoot = '') {
  const f = await setup(approved, original + '\n验收依据：XQ900-2001《虚构规范》。\n' + extraRoot);
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('%PDF-1.4 fictional official original');
  const originalPath = join(f.dir, 'official.pdf'); await writeFile(originalPath, bytes);
  const record = { schema_version: 'official-edition-proof/v1' as const, standard_no: 'XQ900-2001',
    original_pdf_sha256: createHash('sha256').update(bytes).digest('hex'),
    publication_url: 'https://standards.example/publication', attachment_url: 'https://standards.example/original.pdf',
    publication_markdown: '# Fictional publication\nXQ900-2001\nThe linked PDF is the official fictional annex.',
    verified_by: 'fictional trusted host matched exact attachment bytes', verified_at: '2020-01-01T00:00:00.000Z' };
  const proof = { record, record_sha256: sha256Json(record), original_pdf_path: originalPath };
  const external = buildAcceptanceSourceLedger(body);
  const lookup = vi.fn(async () => ({ standard_no: 'XQ900-2001', markdown: body, markdown_sha256: external.sha256, edition_proof: proof }));
  f.delivery.references.push({ id: 'official', origin: sourceQuote(f.ledger, f.ledger.blocks.find(block => block.text.includes('XQ900-2001'))!), standard_no: 'XQ900-2001', version: '2001',
    clause: '', object: '虚构构件', purpose: '验收依据', conditions: [], dependent_lot_ids: ['lot-0'], disposition: 'unresolved', evidence: [], reason: '核对相关性。' });
  f.delivery.lots[0]!.items[0]!.reference_ids.push('official'); await f.save();
  const options = { ...f.options, externalSourceWorkflow: { lookup, require: vi.fn() } };
  const controller = await AcceptanceAutonomousController.open(options);
  return { ...f, controller, options, bytes, originalPath, proof, external, lookup, body };
}

it('freezes official edition identity separately, requires relevance review, and binds it through seal verification', async () => {
  const f = await officialEditionControllerFixture();
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).toMatchObject({ ok: true, source_id: f.external.source_id, semantic_approval: false });
  expect(f.controller.state().approvals).toEqual([]);
  expect(await readFile(join(f.controller.sourceRoot, f.external.source_id + '.md'), 'utf8')).toBe(f.body);
  expect(await f.controller.dispatch('seal_acceptance_delivery', {})).toMatchObject({ ok: false });
  Object.assign(f.delivery.references[0]!, { disposition: 'not_applicable', source_id: f.external.source_id, evidence: [sourceQuote(f.external, f.external.blocks.at(-1)!)], reason: '虚构原文仅适用于管道，本对象为构件。' }); await f.save();
  expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' })).toMatchObject({ ok: true });
  expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'prose', phase: 'full' })).toMatchObject({ ok: true });
  const seal = await f.controller.dispatch('seal_acceptance_delivery', {}); expect(seal).toMatchObject({ ok: true, status: 'complete' });
  const verified = await verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256);
  expect(Object.values(verified.source_edition_proofs ?? {})).toContainEqual(expect.objectContaining({ record_sha256: f.proof.record_sha256 }));
  const frozenPdf = join(f.controller.sourceRoot, 'edition-proofs', f.proof.record.original_pdf_sha256 + '.pdf');
  await writeFile(frozenPdf, '%PDF-1.4 changed');
  await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).rejects.toThrow(/edition proof attachment changed/i);
  await expect(AcceptanceAutonomousController.open(f.options)).rejects.toThrow(/edition proof attachment changed/i);
  await writeFile(frozenPdf, f.bytes);
  const sealed = JSON.parse(await readFile(String(seal.path), 'utf8')); delete sealed.source_edition_proofs;
  await writeFile(String(seal.path), JSON.stringify(sealed));
  await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).rejects.toThrow(/edition provenance changed/i);
});

it('does not let an official publication proof override an explicit contradictory body edition', async () => {
  const f = await officialEditionControllerFixture('# Fictional standard\nXQ900-2002\nA different edition.');
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).toMatchObject({ ok: false, host_repair_required: true,
    actual: { cited_standard_no: 'XQ900-2001', declared_standard_no: 'XQ900-2002' }, expected: expect.any(String), writable: expect.stringContaining('references'), next_tool: 'acceptance_workspace' });
  expect(f.controller.state().approvals).toEqual([]);
});

it.each(['record', 'attachment'])('rejects a changed official edition %s before freezing a source', async changed => {
  const f = await officialEditionControllerFixture();
  if (changed === 'record') f.proof.record.verified_by = 'changed';
  else await writeFile(f.originalPath, '%PDF-1.4 different original');
  await expect(f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).resolves.toMatchObject({ ok: false, host_repair_required: true,
    actual: { reason: expect.stringMatching(/edition proof.*changed/i) }, expected: expect.any(String), writable: expect.stringContaining('source/'), next_tool: 'acceptance_workspace' });
  expect(f.controller.state().approvals).toEqual([]);
});

it.each([false, true])('internal navigation keeps edition provenance after changing the original reference (overwrite=%s)', async overwrite => {
  const f = await officialEditionControllerFixture('# Fictional annex\n\nUse the fictional ruler for panels.\n\n验收依据：按本文件第1条。');
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).toMatchObject({ ok: true });
  const id = overwrite ? 'official' : 'internal';
  const method = f.external.blocks.find(block => block.text === 'Use the fictional ruler for panels.')!;
  f.delivery.references = [{ id, origin: sourceQuote(f.external, f.external.blocks.at(-1)!), standard_no: '', version: '', clause: '本文件第1条',
    object: '虚构构件', purpose: '检查方法', conditions: [], dependent_lot_ids: ['lot-0'], disposition: 'applicable',
    source_id: f.external.source_id, evidence: [sourceQuote(f.external, method)], reason: '虚构原文说明本条的检查方法。' }];
  f.delivery.lots[0]!.items[0]!.reference_ids = [id];
  f.delivery.lots[0]!.items[0]!.method = { value: method.text, evidence: [sourceQuote(f.external, method)] }; await f.save();
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: id })).toMatchObject({ ok: true, internal_navigation: true });
  const resumed = await AcceptanceAutonomousController.open(f.options);
  expect(await resumed.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' })).toMatchObject({ ok: true });
  expect(await resumed.dispatch('review_acceptance_group', { group_id: 'prose', phase: 'full' })).toMatchObject({ ok: true });
  const seal = await resumed.dispatch('seal_acceptance_delivery', {}); expect(seal).toMatchObject({ ok: true, status: 'complete' });
  await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'complete' });
  const frozenPdf = join(resumed.sourceRoot, 'edition-proofs', f.proof.record.original_pdf_sha256 + '.pdf');
  await writeFile(frozenPdf, '%PDF-1.4 changed fictional attachment');
  await expect(verifyAutonomousSealedDelivery(String(seal.path), f.ledger.sha256)).rejects.toThrow(/edition proof.*changed/i);
});

it('reports actual source hashes and host-owned recovery when an external document digest disagrees', async () => {
  const f = await officialEditionControllerFixture();
  const document = await f.lookup();
  f.lookup.mockResolvedValueOnce({ ...document, markdown_sha256: 'f'.repeat(64) });
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).toMatchObject({ ok: false, host_repair_required: true,
    actual: { supplied_markdown_sha256: 'f'.repeat(64), actual_markdown_sha256: f.external.sha256, reason: 'markdown_hash_mismatch' },
    expected: expect.any(String), writable: expect.stringContaining('references'), next_tool: 'acceptance_workspace' });
  expect(f.controller.state().approvals).toEqual([]);
});

it('keeps a prior sealed edition snapshot verifiable when later work adds another publisher proof', async () => {
  const f = await officialEditionControllerFixture(undefined, '\n验收依据：XQ901-2001《虚构第二规范》。\n');
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'official' })).toMatchObject({ ok: true });
  Object.assign(f.delivery.references[0]!, { disposition: 'not_applicable', source_id: f.external.source_id,
    evidence: [sourceQuote(f.external, f.external.blocks.at(-1)!)], reason: '虚构正文仅适用于管道，本对象为构件。' }); await f.save();
  expect(await f.controller.dispatch('review_acceptance_group', { group_id: 'tables', phase: 'full' })).toMatchObject({ ok: true });
  const previous = await f.controller.dispatch('seal_acceptance_delivery', {}); expect(previous).toMatchObject({ ok: true, status: 'partial' });
  const bytes = Buffer.from('%PDF-1.4 fictional second official edition');
  const { createHash } = await import('node:crypto');
  const path = join(f.dir, 'second.pdf'); await writeFile(path, bytes);
  const record = { ...f.proof.record, standard_no: 'XQ901-2001', original_pdf_sha256: createHash('sha256').update(bytes).digest('hex'),
    publication_markdown: '# Fictional second publication\nXQ901-2001\nThe linked PDF is the second original.' };
  const body = '# Fictional second annex\nA distinct fictional body.'; const source = buildAcceptanceSourceLedger(body);
  f.lookup.mockResolvedValue({ standard_no: 'XQ901-2001', markdown: body, markdown_sha256: source.sha256,
    edition_proof: { record, record_sha256: sha256Json(record), original_pdf_path: path } });
  f.delivery.references.push({ id: 'second', origin: sourceQuote(f.ledger, f.ledger.blocks.find(block => block.text.includes('XQ901-2001'))!),
    standard_no: 'XQ901-2001', version: '2001', clause: '', object: '虚构构件', purpose: '验收依据', conditions: [], dependent_lot_ids: ['lot-2'],
    disposition: 'unresolved', evidence: [], reason: '另一个虚构版本待独立核对。' }); await f.save();
  expect(await f.controller.dispatch('resolve_acceptance_reference', { reference_id: 'second' })).toMatchObject({ ok: true });
  await expect(verifyAutonomousSealedDelivery(String(previous.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'partial' });
  await writeFile(join(f.controller.sourceRoot, 'edition-proofs', record.original_pdf_sha256 + '.pdf'), '%PDF-1.4 changed later fixture');
  await expect(verifyAutonomousSealedDelivery(String(previous.path), f.ledger.sha256)).resolves.toMatchObject({ status: 'partial' });
});
