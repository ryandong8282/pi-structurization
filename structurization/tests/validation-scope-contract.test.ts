import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { prettyJson } from '../src/canonical.js';
import { SOURCE_CONTEXT_INVESTIGATION } from '../src/acceptance-delivery-contract.js';
import { DIRECT_VALIDATION_PROTOCOL, ToolController } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, fullSpanFor, seedPlan } from './selector-stage-fixture.js';

test('direct validation reports its actual scope while explicitly authored nested conditions remain unchanged and sealable', async () => {
  const markdown = ['# 2 装配验收', '', '## 2.1 装配组件', '',
    '2.1.1 当委托文件未作约定时，组件应按以下要求核查：', '',
    '1 采用可拆形式时，应符合下列规定：', '',
    '1）接口连接应牢固。', '', '2）标识应清晰。', '',
    '检验方法：观察并核查记录。', '', '检查数量：全数核查。', '',
    '2.1.3 验收记录应归档。', ''].join('\n');
  const { workspace, manifest } = await buildSelectorStageScenario(markdown);
  const registry = await workspace.readSourceSpanRegistry();
  const root = clauseRecord(manifest, '2.1.1'), other = clauseRecord(manifest, '2.1.3');
  const find = (prefix: string) => manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith(prefix))!;
  const parent = find('1 采用'), leaves = [find('1）'), find('2）')], method = find('检验方法'), quantity = find('检查数量');
  const title = manifest.evidence.find(e => e.text === '## 2.1 装配组件')!;
  const span = (e: typeof root) => fullSpanFor(registry, e.evidence_id, e.text.length);
  const plan = seedPlan(manifest, span(other));
  plan.lots[0]!.name = '装配组件';
  plan.lots[0]!.scope_span_ids = [span(title)];
  plan.items[0]!.category = '原文未标明类别';
  plan.items[0]!.name = '验收记录';
  plan.residual_source_dispositions = [];
  for (const [index, leaf] of leaves.entries()) {
    const item = structuredClone(plan.items[0]!);
    item.key = `component-${index}`; item.name = index ? '标识' : '接口连接';
    item.criterion_span_ids = [span(root), span(parent), span(leaf)];
    item.fields.name = { composition: 'semantic_summary', span_ids: [span(leaf)], separator: '', reason: '原文对象属性。' };
    item.fields.requirement = { composition: 'verbatim', span_ids: item.criterion_span_ids, separator: '\n', reason: '作者核对原文后显式保留两层适用限定与本项判据。' };
    item.fields.method = { composition: 'verbatim', span_ids: [span(method)], separator: '', reason: '原文方法。' };
    item.fields.quantity = { composition: 'verbatim', span_ids: [span(quantity)], separator: '', reason: '原文数量。' };
    item.inspection_data_type_span_ids = [span(method)];
    item.sampling = { ...item.sampling, status: 'explicit', quantity_span_ids: [span(quantity)], script_span_ids: [span(quantity)] };
    plan.items.push(item);
  }
  await workspace.writeWorkingSelectors(prettyJson(plan));
  await workspace.updateState(s => { s.selector_stage = 'table'; s.target_review_protocol = DIRECT_VALIDATION_PROTOCOL; });
  const controller = await ToolController.create(workspace);
  await controller.dispatch('batch_open_evidence', { evidence_ids: [root, parent, ...leaves, method, quantity, other, title].map(e => e.evidence_id) });
  await controller.dispatch('read_target_selectors', {});
  const beforeDraft = await readFile(workspace.workingSelectorPath, 'utf8'), beforeRegistry = await workspace.readSourceSpanRegistry();
  const committed = await controller.dispatch('commit_target_selector_draft', { draft_fingerprint: await currentFingerprint(controller) });
  expect(committed, JSON.stringify((committed.selector_issues as any[] | undefined)?.map(i => ({ code: i.code,
    sources: i.details?.evidence_ids?.map((id: string) => manifest.evidence.find(e => e.evidence_id === id)?.text) })) ?? committed))
    .toMatchObject({ ok: true, validation_scope: 'compiler_and_strict_authored_contracts', independent_semantic_review_performed: false });
  expect(committed.instruction).toContain('直接seal');
  expect(SOURCE_CONTEXT_INVESTIGATION).toContain('完整提交前从原文检查遗漏');
  expect(SOURCE_CONTEXT_INVESTIGATION).toContain('所属节统领句、嵌套条件');
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(beforeDraft);
  expect(await workspace.readSourceSpanRegistry()).toEqual(beforeRegistry);
  expect(await controller.dispatch('seal_validated_plan', { fingerprint: committed.fingerprint })).toMatchObject({ ok: true });
  const result = JSON.parse(await readFile(workspace.resultPath, 'utf8'));
  for (const item of result.inspection_lots.flatMap((l: any) => l.items).filter((i: any) => ['标识', '接口连接'].includes(i.name))) {
    expect(item.requirement).toContain(root.text);
    expect(item.requirement).toContain(parent.text);
  }
});
