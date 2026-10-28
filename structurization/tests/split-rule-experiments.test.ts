import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgenticLotSplitController } from '../src/acceptance-autonomous/agentic-lot-split.js';
import { prepareLotSplitHandoff } from '../src/acceptance-autonomous/lot-split-handoff.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const markdown = ['前言', ...Array.from({ length: 7 }, (_, i) => `## 对象${i}\n\n核查对象${i}的外观。\n\n本对象附注。`), '# 附录', '共用说明。'].join('\n\n');
async function setup(limits = {}, source = markdown) {
  const parent = await mkdtemp(join(tmpdir(), 'split-rules-')); roots.push(parent);
  const root = join(parent, 'run');
  const c = await AgenticLotSplitController.open({ root, markdown: source, strategy: 'rule-assisted', limits: {
    max_context_tokens: 230000, max_sessions: 12, max_tool_calls: 1000, max_tool_response_bytes: 1048576, max_single_response_bytes: 131072, ...limits,
  } });
  return { c, root };
}
async function propose(c: AgenticLotSplitController, extra = {}) {
  return c.dispatch('propose_split_rule', { rule: { from: 0, to: c.blocks.length - 1,
    start_pattern: '^## 对象', stop_pattern: '^# ', reason: '每个对象标题到下一同级对象或附录之前为候选，具体边界通过小样检查。', ...extra } }) as Promise<any>;
}
async function inspect(c: AgenticLotSplitController, id: string, phase: string) {
  let cursor: number | null = 0, result: any;
  do { result = await c.dispatch('inspect_split_rule_sample', { experiment_id: id, phase, cursor, limit: 2 });
    expect(result.ok).toBe(true); cursor = result.next_cursor;
  } while (cursor !== null);
  return result;
}
async function verdict(c: AgenticLotSplitController, id: string, phase: string, samples: string[], passed = true) {
  return c.dispatch('record_split_rule_sample', { experiment_id: id, phase,
    findings: samples.map(id => ({ id, passed, reason: passed ? '本对象主文及附注齐全，无并列对象混入，边界停在下一个独立标题前。' : '样本边界误含其他对象，必须修正规则。' })) });
}

test('new rule mode experiments before batch adoption, preserves unmatched material, then hands off unchanged output format', async () => {
  const { c, root } = await setup(), rule = await propose(c);
  expect(rule).toMatchObject({ ok: true, matched_candidates: 7, matched_blocks: 21, holdout_mode: 'unseen' });
  expect(await c.dispatch('split_workspace', {})).toMatchObject({ decisions: 0, surveyed_blocks: 0 });
  expect(await c.dispatch('apply_split_rule', { experiment_id: rule.id, revision: 0 })).toMatchObject({ ok: false });
  expect(await verdict(c, rule.id, 'trial', rule.samples.trial)).toMatchObject({ ok: false });
  await inspect(c, rule.id, 'trial'); expect((await verdict(c, rule.id, 'trial', rule.samples.trial)).ok).toBe(true);
  expect(await c.dispatch('apply_split_rule', { experiment_id: rule.id, revision: 0 })).toMatchObject({ ok: false });
  await inspect(c, rule.id, 'holdout'); await verdict(c, rule.id, 'holdout', rule.samples.holdout);
  expect(await c.dispatch('apply_split_rule', { experiment_id: rule.id, revision: 0 })).toMatchObject({ ok: true, revision: 1, matched_candidates: 7 });
  expect(await c.dispatch('apply_split_rule', { experiment_id: rule.id, revision: 0 })).toMatchObject({ ok: true, unchanged: true, revision: 1 });
  expect(await c.dispatch('seal_lot_split', {})).toMatchObject({ ok: false });
  const remaining = await c.dispatch('scan_split_source', { cursor: 0, unassigned_only: true, limit: 50 }) as any;
  expect(remaining.rows.map((row: any[]) => row[0])).toEqual([0, 22, 23]);
  const decisions = (await c.dispatch('list_split_decisions', { limit: 50 })).rows as any[];
  const upsert = [
    { id: 'intro', kind: 'non_lot', name: '前言', reason: '前言不含独立验收对象', ranges: [{ from: 0, to: 0 }], evidence: [{ block: 0, start: 0, end: 2 }], related_lot_ids: [] },
    { id: 'common', kind: 'shared', name: '共用说明', reason: '附录给出共同适用说明', ranges: [{ from: 22, to: 23 }], evidence: [{ block: 23, start: 0, end: 5 }], related_lot_ids: decisions.map(row => row.id) },
  ];
  expect((await c.dispatch('update_split_decisions', { revision: 1, remove: [], upsert,
    reviews: upsert.map(row => ({ id: row.id, reason: row.reason })) })).ok).toBe(true);
  expect(await c.dispatch('seal_lot_split', {})).toMatchObject({ sealed: true, lots: 7 });
  const handoff = await prepareLotSplitHandoff(root, markdown);
  expect(handoff.decisions.filter(row => row.kind === 'lot')).toHaveLength(7);
  const checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(checkpoint.program_surveyed).toHaveLength(21);
  expect(checkpoint.surveyed.length).toBeLessThan(c.blocks.length); // Program scanning is not falsely labelled model exposure.
});

test('failed findings persist, cannot be flipped or resampled, and overlapping new rules must regress failed samples', async () => {
  const { c } = await setup(), first = await propose(c);
  await inspect(c, first.id, 'trial'); expect((await verdict(c, first.id, 'trial', first.samples.trial, false)).ok).toBe(true);
  expect((await verdict(c, first.id, 'trial', first.samples.trial, true)).ok).toBe(false);
  const repeated = await propose(c, { reason: '只修改说明文字' });
  expect(repeated.id).toBe(first.id); expect(repeated.findings.every((row: any) => row.passed === false)).toBe(true);
  expect((await c.dispatch('apply_split_rule', { experiment_id: first.id, revision: 0 })).ok).toBe(false);
  const revised = await propose(c, { start_pattern: '^(?:## )对象' });
  const checkpoint = await c.dispatch('split_workspace', {}) as any;
  expect(checkpoint.rule_experiments).toHaveLength(2);
  expect(revised.samples.trial.map((id: string) => id.split('-').at(-1))).toEqual(expect.arrayContaining(first.samples.trial.map((id: string) => id.split('-').at(-1))));
  expect((await verdict(c, revised.id, 'trial', [revised.samples.trial[0]])).ok).toBe(false);
  await inspect(c, revised.id, 'trial'); await verdict(c, revised.id, 'trial', revised.samples.trial);
  const held = await inspect(c, revised.id, 'holdout'); await verdict(c, revised.id, 'holdout', held.sample_ids);
  expect(await c.dispatch('apply_split_rule', { experiment_id: revised.id, revision: 0 }))
    .toMatchObject({ ok: false, error: expect.stringContaining('failed boundaries are unchanged') });
});

test('exposing a reserved holdout switches to honest full remaining review without erasing exposure', async () => {
  const { c } = await setup(), rule = await propose(c);
  await inspect(c, rule.id, 'trial'); await verdict(c, rule.id, 'trial', rule.samples.trial);
  const block = Number(rule.samples.holdout[0].split('-').at(-1));
  await c.dispatch('read_split_source', { block, length: 10 });
  const result = await inspect(c, rule.id, 'holdout');
  expect(result.holdout_mode).toBe('remaining_full_review');
  expect(result.sample_ids).toHaveLength(5);
});

test('oversized sample response does not mark sample or source read; resume retains exact budgets, trials and usage', async () => {
  const source = markdown.replaceAll('本对象附注。', '很长的虚构附注。'.repeat(100));
  const { c, root } = await setup({ max_single_response_bytes: 1000 }, source);
  const rule = await propose(c);
  expect(rule.ok).toBe(true);
  expect(await c.dispatch('inspect_split_rule_sample', { experiment_id: rule.id, phase: 'trial', limit: 50 })).toMatchObject({ ok: false });
  const before = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(before.rule_experiments[0].inspected.trial).toEqual([]);
  expect(before.observed).toEqual({});
  const resumed = await AgenticLotSplitController.open({ root, markdown: source, resume: true });
  expect(resumed.ruleAssisted()).toBe(true);
  const after = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(after).toEqual(before);
});

test('old checkpoints retain windowed discovery and reject rule mutation; invalid expressions save no proposal', async () => {
  const { c, root } = await setup();
  expect((await propose(c, { start_pattern: '^(bad' })).ok).toBe(false);
  const state = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
  expect(state.rule_experiments).toEqual([]);
  const parent = await mkdtemp(join(tmpdir(), 'split-legacy-')); roots.push(parent);
  const old = await AgenticLotSplitController.open({ root: join(parent, 'run'), markdown });
  expect((await propose(old)).ok).toBe(false);
  const resume = await AgenticLotSplitController.open({ root: join(parent, 'run'), markdown, resume: true, strategy: 'rule-assisted' });
  expect(resume.ruleAssisted()).toBe(false);
});
