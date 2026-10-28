import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AgenticLotSplitController } from '../src/acceptance-autonomous/agentic-lot-split.js';
import { prepareLotSplitHandoff, installLotSplitHandoff, readLotSplitHandoff, mapSplitCandidates, validateLotSplitHandoff } from '../src/acceptance-autonomous/lot-split-handoff.js';
import { buildAcceptanceSourceLedger } from '../src/acceptance-autonomous/source-ledger.js';
import { sha256Text } from '../src/canonical.js';
import type { AcceptanceDelivery } from '../src/acceptance-autonomous/contracts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = await mkdtemp(resolve('.tmp-tests/split-handoff-')); roots.push(parent);
  const root = join(parent, 'split'), markdown = '设备甲\n\n<table><tr><td>甲检查</td></tr></table>\n\n![页标](a.png)\n\n设备乙\n\n<table><tr><td>乙检查</td></tr></table>';
  const pdf = { schema_version: 'lot-split-pdf-text/v1' as const, path: 'fiction.pdf', sha256: 'a'.repeat(64), pages: [] };
  const controller = await AgenticLotSplitController.open({ root, markdown, pdf });
  await controller.dispatch('scan_split_source', {});
  const decisions = [{ id: 'a', kind: 'lot', name: '设备甲', reason: '甲的正文', ranges: [{ from: 0, to: 1 }], evidence: [{ block: 0, start: 0, end: 3 }], related_lot_ids: [] },
    { id: 'b', kind: 'lot', name: '设备乙', reason: '乙的正文与待核边缘', ranges: [{ from: 2, to: 4 }], evidence: [{ block: 3, start: 0, end: 3 }], related_lot_ids: [] }];
  await controller.dispatch('update_split_decisions', { revision: 0, remove: [], upsert: decisions, reviews: decisions.map(row => ({ id: row.id, reason: '已核对各自正文与邻接边缘' })) });
  expect(await controller.dispatch('seal_lot_split', {})).toMatchObject({ sealed: true });
  return { parent, root, markdown, source: buildAcceptanceSourceLedger(markdown) };
}

test('adopts an exact sealed split without rerunning discovery or changing any old counters', async () => {
  const f = await fixture(), before = await readFile(join(f.root, 'checkpoint.json'), 'utf8');
  const handoff = await prepareLotSplitHandoff(f.root, f.markdown);
  const registered = await installLotSplitHandoff(join(f.parent, 'business'), handoff, f.source);
  expect(await readLotSplitHandoff(join(f.parent, 'business'), f.source)).toEqual(handoff);
  expect(await installLotSplitHandoff(join(f.parent, 'business'), handoff, f.source)).toEqual(registered);
  expect(await readFile(join(f.root, 'checkpoint.json'), 'utf8')).toBe(before);
  expect(handoff.history.tool_calls).toBe(JSON.parse(before).tool_calls);
  expect(handoff.history.tool_response_bytes).toBe(JSON.parse(before).tool_response_bytes);
});

test('a source-bound edge review derives corrected lot inputs and retains the original sealed manifest', async () => {
  const f = await fixture(), original = await readFile(join(f.root, 'manifest.json'), 'utf8');
  const block = f.source.blocks[2]!;
  const handoff = await prepareLotSplitHandoff(f.root, f.markdown, { schema_version: 'acceptance-split-boundary-review/v1',
    manifest_sha256: sha256Text(original), source_sha256: f.source.sha256, pdf_sha256: 'a'.repeat(64), reviewed_by: 'fictional reviewer', review_scope: 'one edge',
    entries: [{ block_id: block.id, start: 0, end: block.text.length, from_id: 'b', to_id: 'a', pdf_page: 1,
      page_image_sha256: 'b'.repeat(64), reason: '虚构页图证据表明页标在甲页底。' }] });
  expect(handoff.decisions[0]!.source.map(row => row.block_id)).toContain(block.id);
  expect(handoff.decisions[1]!.source.map(row => row.block_id)).not.toContain(block.id);
  expect(await readFile(join(f.root, 'manifest.json'), 'utf8')).toBe(original);
  expect(() => validateLotSplitHandoff(handoff, f.source)).not.toThrow();
});

test('rejects partial, forged raw slices, changed source, and modified registered handoffs', async () => {
  const f = await fixture();
  await expect(prepareLotSplitHandoff(f.root, f.markdown + '改')).rejects.toThrow(/source|persisted/i);
  const text = await readFile(join(f.root, 'manifest.json'), 'utf8'), m = JSON.parse(text);
  m.decisions[0].source[0].text = '篡改'; await writeFile(join(f.root, 'manifest.json'), JSON.stringify(m));
  await expect(prepareLotSplitHandoff(f.root, f.markdown)).rejects.toThrow(/raw source changed/);
  m.status = 'in_progress'; await writeFile(join(f.root, 'manifest.json'), JSON.stringify(m));
  await expect(prepareLotSplitHandoff(f.root, f.markdown)).rejects.toThrow(/complete/);
  await writeFile(join(f.root, 'manifest.json'), text);
  const handoff = await prepareLotSplitHandoff(f.root, f.markdown);
  const registration = await installLotSplitHandoff(join(f.parent, 'business'), handoff, f.source);
  handoff.decisions[0]!.name = '后改名称'; await writeFile(registration.path, JSON.stringify(handoff));
  await expect(readLotSplitHandoff(join(f.parent, 'business'), f.source)).rejects.toThrow(/changed/);
});

test('reuses existing candidates by their body source while keeping pending batches distinct from approvals', async () => {
  const f = await fixture(), handoff = await prepareLotSplitHandoff(f.root, f.markdown);
  const delivery = { lots: [{ id: 'old-a', scope: { block_ids: [f.source.blocks[1]!.id] } }] } as AcceptanceDelivery;
  expect(mapSplitCandidates(handoff, f.source, delivery).map(({ id, candidate_ids, status }) => ({ id, candidate_ids, status })))
    .toEqual([{ id: 'a', candidate_ids: ['old-a'], status: 'candidate' }, { id: 'b', candidate_ids: [], status: 'pending' }]);
  delivery.lots[0]!.scope.block_ids.push(f.source.blocks[4]!.id);
  expect(mapSplitCandidates(handoff, f.source, delivery).map(row => row.candidate_ids)).toEqual([['old-a'], ['old-a']]);
});

test('maps two independent objects inside one source block by their exact scope intervals', async () => {
  const f = await fixture(), handoff = await prepareLotSplitHandoff(f.root, f.markdown);
  const source = buildAcceptanceSourceLedger('甲对象。乙对象。'), block = source.blocks[0]!;
  handoff.source_sha256 = source.sha256;
  handoff.decisions = [0, 1].map(i => ({ id: `object-${i}`, kind: 'lot', name: `虚构对象${i}`, reason: '两项独立对象', related_lot_ids: [],
    source: [{ source_id: source.source_id, block_id: block.id, start: i * 4, end: (i + 1) * 4, text: block.text.slice(i * 4, (i + 1) * 4), block: 0, start_line: 1, end_line: 1 }] }));
  validateLotSplitHandoff(handoff, source);
  const delivery = { lots: handoff.decisions.map(row => ({ id: row.id, scope: { block_ids: [block.id], evidence: structuredClone(row.source) } })) } as AcceptanceDelivery;
  expect(mapSplitCandidates(handoff, source, delivery).map(row => [row.status, row.candidate_ids])).toEqual([
    ['candidate', ['object-0']], ['candidate', ['object-1']],
  ]);
  delivery.lots[0]!.scope.evidence[0]!.end = 8;
  expect(mapSplitCandidates(handoff, source, delivery).some(row => row.status === 'conflict')).toBe(true);
});
