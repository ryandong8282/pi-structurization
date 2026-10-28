import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const session = vi.hoisted(() => vi.fn());
vi.mock('../src/pi-runtime.js', () => ({ runLiveConstrainedSession: session }));
import { AgenticLotSplitController, DEFAULT_AGENTIC_SPLIT_LIMITS, type AgenticSplitDecision } from '../src/acceptance-autonomous/agentic-lot-split.js';
import { runAgenticLotSplit } from '../src/acceptance-autonomous/agentic-lot-split-runtime.js';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); session.mockReset(); });
async function setup(markdown: string, overrides = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'agentic-split-')); roots.push(parent);
  const root = join(parent, 'run');
  const controller = await AgenticLotSplitController.open({ root, markdown, limits: { ...DEFAULT_AGENTIC_SPLIT_LIMITS, ...overrides } });
  return { controller, root, markdown };
}
const decision = (id: string, from: number, to = from, kind: AgenticSplitDecision['kind'] = 'lot'): AgenticSplitDecision => ({
  id, kind, name: id, reason: '依据正文对象及邻接范围决定；不按工具预设标题归类。', ranges: [{ from, to }],
  evidence: [{ block: from, start: 0, end: 1 }], related_lot_ids: [],
});
const update = (c: AgenticLotSplitController, revision: number, upsert: AgenticSplitDecision[], remove: string[] = []) =>
  c.dispatch('update_split_decisions', { revision, upsert, remove });
const scan = (c: AgenticLotSplitController) => c.dispatch('scan_split_source', { limit: 50 });
async function reviewAll(call: (name: string, params: any) => Promise<any>) {
  const decisions = (await call('list_split_decisions', { limit: 50 })).rows;
  for (const decision of decisions) {
    let cursor: number | null = 0;
    while (cursor !== null) cursor = (await call('inspect_split_decision', { id: decision.id, cursor, limit: 50 })).next_cursor;
    expect((await call('record_split_boundary_review', { id: decision.id, reason: '已逐段核对同一对象的内部结构与上下级关系，相关共享内容对应当前对象，无并列对象被合并。' })).ok).toBe(true);
  }
}
const seal = async (c: AgenticLotSplitController) => { await reviewAll(c.dispatch.bind(c)); return c.dispatch('seal_lot_split', {}); };

test('runtime model discovers boundaries with no conventional titles, revises them, then seals raw lot inputs', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentic-split-runtime-')); roots.push(parent);
  const root = join(parent, 'run');
  const markdown = '设备交接\n\n核查外观和配件。\n\n运行试验\n\n核查噪声。';
  session.mockImplementation(async (_workspace, options) => {
    expect(options.modelStage).toBe('discovery'); expect(options.terminalTool).toBe('seal_lot_split');
    expect(options.customTools.map((tool: any) => tool.name)).not.toContain('splitAcceptanceLots');
    const call = async (name: string, params: unknown) => (await options.customTools.find((tool: any) => tool.name === name).execute('call', params)).details;
    const before = await call('split_workspace', {}); expect(before.decisions).toBe(0);
    await call('scan_split_source', { limit: 50 });
    expect((await call('update_split_decisions', { revision: 0, upsert: [decision('candidate', 0, 3)], remove: [] })).ok).toBe(true);
    expect((await call('update_split_decisions', { revision: 1, upsert: [decision('handover', 0, 1), decision('running', 2, 3)], remove: ['candidate'] })).ok).toBe(true);
    await reviewAll(call);
    expect((await call('seal_lot_split', {})).sealed).toBe(true);
    expect(await options.completed()).toBe(true);
    return { completed: true, model: 'test-agent', session_id: 's', session_file: 'test' };
  });
  const result = await runAgenticLotSplit({ root, markdown }); expect(result.completed).toBe(true); expect(session).toHaveBeenCalledOnce();
  const lots = (await readFile(join(root, 'lot-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lots.map(lot => lot.id)).toEqual(['handover', 'running']);
  expect(lots[0].source.map((row: any) => row.text)).toEqual(['设备交接', '核查外观和配件。']);
  expect(lots[1].source.map((row: any) => row.text)).toEqual(['运行试验', '核查噪声。']);
});

test('no source is preclassified; uncovered prose, tables and images prevent sealing', async () => {
  const { controller: c } = await setup('引言\n\n<table><tr><td>无常规标题</td></tr></table>\n\n![图](missing.png)');
  expect(await c.dispatch('split_workspace', {})).toMatchObject({ decisions: 0, source_blocks: 3 });
  await scan(c); await update(c, 0, [decision('intro', 0, 0, 'non_lot')]);
  const result = await c.dispatch('seal_lot_split', {});
  expect(result.ok).toBe(false); expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'gap' })]));
});

test('agent can split two objects glued into one source block without a title or form-code rule', async () => {
  const { controller: c, root } = await setup('对象甲：要求甲。对象乙：要求乙。');
  await scan(c);
  const a = decision('a', 0), b = decision('b', 0); a.ranges[0]!.end = 8; b.ranges[0]!.start = 8;
  b.evidence = [{ block: 0, start: 8, end: 11 }];
  expect((await update(c, 0, [a, b])).ok).toBe(true);
  expect((await seal(c)).sealed).toBe(true);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.decisions.map((row: any) => row.source[0].text).join('')).toBe('对象甲：要求甲。对象乙：要求乙。');
});

test('overlapping merge is atomic; an agent must replace all affected owners in one call', async () => {
  const { controller: c } = await setup('甲首页\n\n甲续页'); await scan(c);
  await update(c, 0, [decision('a', 0), decision('b', 1)]);
  expect(await update(c, 1, [decision('a', 0, 1)])).toMatchObject({ ok: false, error: expect.stringContaining('Overlapping ownership') });
  expect((await c.dispatch('split_workspace', {})).revision).toBe(1);
  expect((await update(c, 1, [decision('a', 0, 1)], ['b'])).ok).toBe(true);
  expect(await seal(c)).toMatchObject({ sealed: true, lots: 1 });
});

test('unread middle evidence and unread cut endpoints require actual local investigation', async () => {
  const { controller: c } = await setup('前'.repeat(600) + '对象边界' + '后'.repeat(600)); await scan(c);
  const a = decision('a', 0); a.ranges[0]!.end = 604;
  expect(await update(c, 0, [a])).toMatchObject({ ok: false, error: expect.stringContaining('Boundary not read') });
  await c.dispatch('read_split_source', { block: 0, start: 570, length: 80 });
  a.evidence = [{ block: 0, start: 600, end: 604 }];
  expect((await update(c, 0, [a])).ok).toBe(true);
});

test('shared occurrences remain unique and only enter their declared consumer inputs', async () => {
  const { controller: c, root } = await setup('甲\n\n乙\n\n甲乙共用的说明\n\n只有乙的说明'); await scan(c);
  const common = decision('common', 2, 2, 'shared'); common.related_lot_ids = ['a', 'b'];
  const only = decision('only', 3, 3, 'shared'); only.related_lot_ids = ['b'];
  await update(c, 0, [decision('a', 0), decision('b', 1), common, only]); await seal(c);
  const lots = (await readFile(join(root, 'lot-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lots[0].shared.map((row: any) => row.id)).toEqual(['common']);
  expect(lots[1].shared.map((row: any) => row.id)).toEqual(['common', 'only']);
});

test('unresolved groups are exported separately; dangling shared links prevent sealing', async () => {
  const { controller: c, root } = await setup('正常对象\n\n标题残缺，续页关系冲突\n\n共用说明'); await scan(c);
  const uncertain = decision('uncertain', 1, 1, 'unresolved'); uncertain.related_lot_ids = ['a'];
  const shared = decision('shared', 2, 2, 'shared'); shared.related_lot_ids = ['absent'];
  await update(c, 0, [decision('a', 0), uncertain, shared]);
  expect((await c.dispatch('seal_lot_split', {})).ok).toBe(false);
  shared.related_lot_ids = ['a']; await update(c, 1, [shared]);
  expect(await seal(c)).toMatchObject({ sealed: true, lots: 1, unresolved_groups: 1 });
  const input = JSON.parse((await readFile(join(root, 'lot-inputs.jsonl'), 'utf8')).trim());
  expect(input.unresolved).toHaveLength(1);
});

test('resume retains model decisions, tool/session usage and limits; changed source is rejected', async () => {
  const { controller: c, root, markdown } = await setup('首次资料\n\n后续资料'); await c.startSession(); await scan(c); await update(c, 0, [decision('a', 0)]);
  const resumed = await AgenticLotSplitController.open({ root, markdown, resume: true });
  const state = await resumed.dispatch('split_workspace', {});
  expect(state).toMatchObject({ decisions: 1, revision: 1, usage: { sessions: 1, tool_calls: 3 } });
  await expect(AgenticLotSplitController.open({ root, markdown: markdown + '变化', resume: true })).rejects.toThrow('source');
  await expect(AgenticLotSplitController.open({ root, markdown, resume: true, limits: { ...DEFAULT_AGENTIC_SPLIT_LIMITS, max_sessions: 99 } })).rejects.toThrow('limits');
});

test('tool budgets stop execution without marking unread/truncated source as surveyed', async () => {
  const { controller: c, root } = await setup('长'.repeat(500), { max_single_response_bytes: 100, max_tool_calls: 2 });
  expect((await scan(c)).ok).toBe(false);
  const state = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(state.surveyed).toEqual([]); expect(state.observed).toEqual({});
  await c.dispatch('split_workspace', {});
  expect(await c.dispatch('split_workspace', {})).toMatchObject({ ok: false, terminal: true });
});

test('physical page ordering preserves source block IDs/offsets and protects frozen input', async () => {
  const { controller: c, root } = await setup('<!-- pages_101_120 -->\n\n后页\n\n<!-- pages_021_040 -->\n\n前页');
  const rows = (await scan(c)).rows as any[];
  expect(rows.map(row => row[3])).toEqual(['<!-- pages_021_040 -->', '前页', '<!-- pages_101_120 -->', '后页']);
  expect(c.blocks[1]!.id).toBe(c.source.blocks[3]!.id);
  await writeFile(join(root, 'source.md'), '意外改写', 'utf8');
  expect(await c.dispatch('read_split_source', { block: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('Frozen source changed') });
});

test('coverage alone cannot seal; semantic self-review is bound to the exact decision and must inspect every piece', async () => {
  const { controller: c } = await setup('对象甲\n\n对象乙'); await scan(c);
  const merged = decision('merged', 0, 1); await update(c, 0, [merged]);
  expect((await c.dispatch('seal_lot_split', {})).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'boundary_review_required' })]));
  await c.dispatch('inspect_split_decision', { id: 'merged', limit: 1 });
  expect((await c.dispatch('record_split_boundary_review', { id: 'merged', reason: '只看一段不能通过' })).ok).toBe(false);
  await reviewAll(c.dispatch.bind(c));
  merged.reason = '重新判断归属'; await update(c, 1, [merged]);
  expect((await c.dispatch('seal_lot_split', {})).ok).toBe(false);
  await update(c, 2, [decision('a', 0), decision('b', 1)], ['merged']);
  expect(await seal(c)).toMatchObject({ sealed: true, lots: 2 });
  expect((await c.dispatch('record_split_boundary_review', { id: 'a', reason: '不能改旧封存' })).ok).toBe(false);
});

test('interrupted runtime releases ownership and resume preserves the accepted decisions and session count', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentic-split-abort-')); roots.push(parent);
  const root = join(parent, 'run'), markdown = '对象甲';
  session.mockImplementationOnce(async (_workspace, options) => {
    const call = async (name: string, params: unknown) => (await options.customTools.find((tool: any) => tool.name === name).execute('call', params)).details;
    await call('scan_split_source', {});
    await call('update_split_decisions', { revision: 0, upsert: [decision('a', 0)], remove: [] });
    throw new Error('interrupted');
  });
  await expect(runAgenticLotSplit({ root, markdown })).rejects.toThrow('interrupted');
  await expect(readFile(join(root, 'running.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  session.mockImplementationOnce(async (_workspace, options) => {
    const call = async (name: string, params: unknown) => (await options.customTools.find((tool: any) => tool.name === name).execute('call', params)).details;
    expect(options.resume).toBe(true);
    expect(await call('split_workspace', {})).toMatchObject({ decisions: 1, usage: { sessions: 2 } });
    await reviewAll(call); await call('seal_lot_split', {});
    return { completed: true, model: 'test-agent' };
  });
  expect((await runAgenticLotSplit({ root, markdown, resume: true })).completed).toBe(true);
});


test('discovery cannot scan/read ahead until the current window has durable reviewed ownership', async () => {
  const { controller: c, root } = await setup(Array.from({ length: 55 }, (_, i) => `材料${i}的正文`).join('\n\n'));
  expect(await scan(c)).toMatchObject({ next_cursor: 50, progress: { committed_blocks: 0, readable_to: 49 } });
  expect(await c.dispatch('scan_split_source', { cursor: 50 })).toMatchObject({ ok: false, error: expect.stringContaining('Commit current window') });
  expect(await c.dispatch('read_split_source', { block: 54 })).toMatchObject({ ok: false });
  expect(await c.dispatch('search_split_source', { query: '材料54' })).toMatchObject({ rows: [{ block: 54, match_start: 0 }] });
  const first = decision('continuous', 0, 49); first.open_end = true;
  await update(c, 0, [first]);
  expect((await c.dispatch('scan_split_source', { cursor: 50 })).ok).toBe(false);
  expect(await c.dispatch('update_split_decisions', { revision: 1, remove: [], upsert: [],
    reviews: [{ id: 'continuous', reason: '这段为同一材料的连续正文，窗口右边尚未见到实际结尾，下一段继续核对。' }] }))
    .toMatchObject({ ok: true, progress: { committed_blocks: 50, open_decisions: ['continuous'] } });
  const manifest = JSON.parse(await readFile(join(root, 'partial/manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema_version: 'agentic-lot-split/v3', status: 'in_progress', revision: 2 });
  expect(manifest.decisions[0].source).toHaveLength(50);
  expect(JSON.parse((await readFile(join(root, 'partial/lot-inputs.jsonl'), 'utf8')).trim())).toMatchObject({ provisional: true, open_end: true, boundary_reviewed: true });
  await expect(readFile(join(root, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await c.dispatch('scan_split_source', { cursor: 50 })).toMatchObject({ ok: true, next_cursor: null });
});

test('a cross-window object survives interruption, extends the SAME id, and cannot seal with an open edge', async () => {
  const { controller: c, root, markdown } = await setup(Array.from({ length: 53 }, (_, i) => `连续资料${i}`).join('\n\n'));
  await scan(c);
  const lot = decision('one-object', 0, 49); lot.open_end = true;
  await c.dispatch('update_split_decisions', { revision: 0, remove: [], upsert: [lot], reviews: [{ id: lot.id, reason: '同一对象的连续材料，右侧待续。' }] });
  const before = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  await rm(join(root, 'partial'), { recursive: true }); // Simulate lost derived outputs, not checkpoint loss.
  const resumed = await AgenticLotSplitController.open({ root, markdown, resume: true });
  expect(await resumed.dispatch('split_workspace', {})).toMatchObject({ revision: 1, progress: { committed_blocks: 50 },
    usage: { tool_calls: before.tool_calls + 1, tool_response_bytes: before.tool_response_bytes } });
  expect(JSON.parse(await readFile(join(root, 'partial/manifest.json'), 'utf8')).revision).toBe(1);
  await resumed.dispatch('scan_split_source', { cursor: 50 });
  lot.ranges = [{ from: 0, to: 52 }];
  expect((await resumed.dispatch('update_split_decisions', { revision: 1, remove: [], upsert: [lot], reviews: [{ id: lot.id, reason: '后续三段属于原对象，无新独立对象。' }] })).ok).toBe(true);
  expect((await resumed.dispatch('seal_lot_split', {})).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'open_boundary' })]));
  lot.open_end = false;
  await resumed.dispatch('update_split_decisions', { revision: 2, remove: [], upsert: [lot], reviews: [{ id: lot.id, reason: '全文至此结束，连续资料未出现并列独立验收对象。' }] });
  expect(await resumed.dispatch('seal_lot_split', {})).toMatchObject({ sealed: true, lots: 1 });
  const inputs = (await readFile(join(root, 'lot-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(inputs).toHaveLength(1); expect(inputs[0].id).toBe('one-object'); expect(inputs[0].source).toHaveLength(53);
  expect(inputs[0].source.map((row: any) => row.text).join('\n\n')).toBe(markdown);
});

test('unseen interior and invalid batch self-review cannot be used to advance the window', async () => {
  const { controller: c, root } = await setup('甲\n\n中间对象\n\n乙');
  await c.dispatch('scan_split_source', { cursor: 0, limit: 1 });
  await c.dispatch('scan_split_source', { cursor: 2, limit: 1 });
  expect(await update(c, 0, [decision('all', 0, 2)])).toMatchObject({ ok: false, error: expect.stringContaining('not surveyed') });
  await c.dispatch('scan_split_source', { cursor: 1, limit: 1 });
  expect(await c.dispatch('update_split_decisions', { revision: 0, remove: [], upsert: [decision('all', 0, 2)],
    reviews: [{ id: 'missing', reason: '错误引用' }] })).toMatchObject({ ok: false });
  expect(JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')).decisions).toEqual([]);
});


test('batched local reads expose exact intervals in one budgeted call and validate all requests before marking read', async () => {
  const { controller: c, root } = await setup('甲'.repeat(500) + '\n\n' + '乙'.repeat(500));
  await scan(c);
  const before = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(await c.dispatch('read_split_sources', { requests: [{ block: 0, start: 200, length: 50 }, { block: 99 }] })).toMatchObject({ ok: false });
  expect(JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')).observed).toEqual(before.observed);
  const result = await c.dispatch('read_split_sources', { requests: [{ block: 0, start: 200, length: 50 }, { block: 1, start: 240, length: 60 }] });
  expect(result).toMatchObject({ ok: true, rows: [{ block: 0, start: 200, end: 250, text: '甲'.repeat(50) }, { block: 1, start: 240, end: 300, text: '乙'.repeat(60) }] });
  const after = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(after.tool_calls).toBe(before.tool_calls + 2);
  expect(after.observed[0]).toContainEqual([200, 250]); expect(after.observed[1]).toContainEqual([240, 300]);
});

test('oversized batch read rolls back all observation receipts', async () => {
  const { controller: c, root } = await setup('长'.repeat(5000), { max_single_response_bytes: 300 });
  expect(await c.dispatch('read_split_sources', { requests: [{ block: 0, start: 500, length: 4000 }] })).toMatchObject({ ok: false });
  expect(JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')).observed).toEqual({});
});
