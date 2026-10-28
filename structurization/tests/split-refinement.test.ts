import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgenticLotSplitController } from '../src/acceptance-autonomous/agentic-lot-split.js';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { prepareLotSplitHandoff, createUnresolvedSplitRefinement, installLotSplitHandoff, readLotSplitHandoff, assertSplitRefinement } from '../src/acceptance-autonomous/lot-split-handoff.js';
import { buildAcceptanceSourceLedger } from '../src/acceptance-autonomous/source-ledger.js';
import { sha256Json } from '../src/canonical.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const markdown = '虚构验收表\n\n虚构正文：每组三件抽一件。';
const decisions = [
  { id: 'table', kind: 'lot', name: '虚构表', reason: '记录表', ranges: [{ from: 0, to: 0 }], evidence: [{ block: 0, start: 0, end: 5 }], related_lot_ids: [] },
  { id: 'pending', kind: 'unresolved', name: '待分析正文', reason: '尚未充分分析', ranges: [{ from: 1, to: 1 }], evidence: [{ block: 1, start: 0, end: 4 }], related_lot_ids: [] },
];
async function setup(ruleAssisted: boolean) {
  const parent = await mkdtemp(join(tmpdir(), 'split-refinement-')); roots.push(parent);
  const root = join(parent, 'original');
  const c = await AgenticLotSplitController.open({ root, markdown, ...(ruleAssisted ? { strategy: 'rule-assisted' as const } : {}) });
  await c.startSession(); await c.dispatch('scan_split_source', {});
  expect(await c.dispatch('update_split_decisions', { revision: 0, remove: [], upsert: decisions,
    reviews: decisions.map(row => ({ id: row.id, reason: '按已见原文保留独立表与待调查正文。' })) })).toMatchObject({ ok: true });
  return { parent, root, c, source: buildAcceptanceSourceLedger(markdown) };
}

test('rule-assisted source assigned to unresolved remains pending, even when coverage passes', async () => {
  const { c, root } = await setup(true);
  expect(await c.dispatch('validate_lot_split', {})).toMatchObject({ passed: true });
  expect(await c.dispatch('seal_lot_split', {})).toMatchObject({ ok: false, sealed: false, next_tool: 'inspect_split_decision' });
  expect(JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')).sealed).toBe(false);
});

test('refinement preserves the old seal, exposure and budgets, resumes without reset and updates only an unapproved handoff', async () => {
  const f = await setup(false);
  expect(await f.c.dispatch('seal_lot_split', {})).toMatchObject({ sealed: true });
  // Reproduce the prior permissive rule-assisted checkpoint format with neutral material.
  const previousState = JSON.parse(await readFile(join(f.root, 'checkpoint.json'), 'utf8'));
  Object.assign(previousState, { strategy: 'rule-assisted', rule_experiments: [], program_surveyed: [] });
  await writeFile(join(f.root, 'checkpoint.json'), JSON.stringify(previousState));
  const original = await readFile(join(f.root, 'checkpoint.json'), 'utf8');
  const originalManifest = await readFile(join(f.root, 'manifest.json'), 'utf8');
  const previous = await prepareLotSplitHandoff(f.root, markdown);
  const business = join(f.parent, 'business'), markdownPath = join(f.parent, 'input.md');
  await writeFile(markdownPath, markdown);
  await installLotSplitHandoff(business, previous, f.source);
  const limits = { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072,
    max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 8 };
  const options = { root: business, markdownPath, limits, reviewer: async () => { throw new Error('No review required to adopt inputs'); } };
  const author = await AcceptanceAutonomousController.open(options);
  await author.dispatch('acceptance_workspace', {});
  const authorBefore = JSON.parse(await readFile(join(business, 'checkpoint.json'), 'utf8'));
  const nextRoot = join(f.parent, 'continuation');
  await createUnresolvedSplitRefinement(f.root, nextRoot, markdown, previous);
  const inherited = JSON.parse(await readFile(join(nextRoot, 'checkpoint.json'), 'utf8'));
  expect(inherited).toEqual({ ...previousState, sealed: false, refinement_of: sha256Json(previous) });
  const resumed = await AgenticLotSplitController.open({ root: nextRoot, markdown, resume: true });
  await resumed.startSession();
  const replacement = { ...decisions[1]!, kind: 'shared', reason: '正文是该验收对象的抽样要求', related_lot_ids: ['table'] };
  expect(await resumed.dispatch('update_split_decisions', { revision: 1, remove: ['pending'], upsert: [replacement],
    reviews: [{ id: 'pending', reason: '已核对正文抽样量属于该表对象，按共用条文关联，不再待办。' }] })).toMatchObject({ ok: true });
  await createUnresolvedSplitRefinement(f.root, nextRoot, markdown, previous);
  expect(JSON.parse(await readFile(join(nextRoot, 'checkpoint.json'), 'utf8')).sessions).toBe(previousState.sessions + 1);
  expect(await resumed.dispatch('seal_lot_split', {})).toMatchObject({ sealed: true });
  const next = await prepareLotSplitHandoff(nextRoot, markdown);
  expect(() => assertSplitRefinement(previous, { ...next, history: { ...next.history, tool_calls: 0 } })).toThrow(/Invalid split refinement/);
  await installLotSplitHandoff(business, next, f.source);
  await AcceptanceAutonomousController.open(options);
  const after = JSON.parse(await readFile(join(business, 'checkpoint.json'), 'utf8'));
  expect(after.budget).toEqual(authorBefore.budget);
  expect(after.requests).toEqual(authorBefore.requests);
  expect(after.lot_split.sha256).toBe(sha256Json(next));
  expect(await readFile(join(f.root, 'checkpoint.json'), 'utf8')).toBe(original);
  expect(await readFile(join(f.root, 'manifest.json'), 'utf8')).toBe(originalManifest);
  expect(JSON.parse(await readFile(join(business, 'lot-split', `${sha256Json(previous)}.json`), 'utf8'))).toEqual(previous);
  expect(await readLotSplitHandoff(business, f.source)).toEqual(next);

  const protectedRoot = join(f.parent, 'approved-business');
  await installLotSplitHandoff(protectedRoot, previous, f.source);
  await writeFile(join(protectedRoot, 'checkpoint.json'), JSON.stringify({ approvals: [{}] }));
  await expect(installLotSplitHandoff(protectedRoot, next, f.source)).rejects.toThrow(/approvals/);
  expect(await readLotSplitHandoff(protectedRoot, f.source)).toEqual(previous);
});
