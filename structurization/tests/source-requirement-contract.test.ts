import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { prettyJson } from '../src/canonical.js';
import { ACCEPTANCE_DELIVERY_CONTRACT, SELECTOR_PATCH_GUIDANCE } from '../src/acceptance-delivery-contract.js';
import { UNLABELED_ITEM_CATEGORY } from '../src/contracts.js';
import { ToolController } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, fullSpanFor, seedPlan } from './selector-stage-fixture.js';

test('the author contract distinguishes source requirements and record structure from engineering values and candidate completion', () => {
  expect(ACCEPTANCE_DELIVERY_CONTRACT).toContain('无需求出原文未提供的设计数值或现场结果');
  expect(SELECTOR_PATCH_GUIDANCE).toContain('完整记录，不是字段 patch');
  expect(ACCEPTANCE_DELIVERY_CONTRACT).toContain('仍有具体未决就继续针对性调查');
});

test('a source-bound design requirement without numeric limits can be staged and committed without inventing values', async () => {
  const markdown = ['# 2 设备技术验收', '', '## 2.1 设备验收', '',
    '2.1.1 设备额定参数应符合经批准的技术文件。', '',
    '检验方法：核查技术文件。', '', '检查数量：全数核查。', '',
    '2.1.3 验收记录应装订成册。', ''].join('\n');
  const { workspace, manifest } = await buildSelectorStageScenario(markdown);
  const registry = await workspace.readSourceSpanRegistry();
  const criterion = clauseRecord(manifest, '2.1.1'), other = clauseRecord(manifest, '2.1.3');
  const method = manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检验方法'))!;
  const quantity = manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检查数量'))!;
  expect(method).toBeDefined(); expect(quantity).toBeDefined();
  const span = (record: typeof criterion) => fullSpanFor(registry, record.evidence_id, record.text.length);
  const plan = seedPlan(manifest, span(other));
  plan.items[0]!.category = UNLABELED_ITEM_CATEGORY;
  plan.items[0]!.name = '验收记录装订';
  const item = { ...structuredClone(plan.items[0]!), key: 'equipment-parameters', name: '设备额定参数',
    criterion_span_ids: [span(criterion)], inspection_data_type_span_ids: [span(method)],
    inspection_data_type_reason: '原文规定核查技术文件。', reason: '保留原文明确参照，未填写源外参数值。' };
  const field = (ids: string[], reason: string) => ({ composition: 'verbatim' as const, span_ids: ids, separator: '', reason });
  item.fields.name = { composition: 'semantic_summary', span_ids: [span(criterion)], separator: '', reason: '概括原文受检对象。' };
  item.fields.requirement = field([span(criterion)], '原文明确参照经批准的技术文件，没有提供具体性能限值。');
  item.fields.method = field([span(method)], '原文明确核查方法。');
  item.fields.quantity = field([span(quantity)], '原文规定全数核查。');
  item.sampling = { ...item.sampling, status: 'explicit', quantity_span_ids: [span(quantity)],
    script_span_ids: [span(quantity)], reason: '保留原文全数核查义务。' };
  await workspace.writeWorkingSelectors(prettyJson(plan));
  await workspace.updateState(state => { state.selector_stage = 'table'; });
  const controller = await ToolController.create(workspace);
  await controller.dispatch('batch_open_evidence', { evidence_ids: [criterion.evidence_id, method.evidence_id, quantity.evidence_id, other.evidence_id] });
  await controller.dispatch('read_target_selectors', {});
  const before = await workspace.readState(), beforeRegistry = await workspace.readSourceSpanRegistry();
  const saved = await controller.dispatch('stage_target_selector_draft', { operation: 'upsert', draft: { items: [item] } });
  expect(saved).toMatchObject({ ok: true, local_validation: { ok: true }, budget_consumed: false, global_candidate_complete: false });
  const after = JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'));
  expect(after.items.find((i: any) => i.key === plan.items[0]!.key)).toEqual(plan.items[0]);
  expect(after.lots).toEqual(plan.lots);
  expect(await workspace.readSourceSpanRegistry()).toEqual(beforeRegistry);
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  const committed = await controller.dispatch('commit_target_selector_draft', { draft_fingerprint: await currentFingerprint(controller) });
  expect(committed).toMatchObject({ ok: true });
  const semantic = JSON.parse(await readFile(workspace.lastValidPlanPath, 'utf8'));
  expect(JSON.stringify(semantic)).toContain(criterion.text);
  expect(JSON.stringify(semantic)).not.toContain('允许偏差');
});
