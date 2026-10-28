import { access, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { prettyJson } from '../src/canonical.js';
import { DIRECT_VALIDATION_PROTOCOL, ToolController } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, fullSpanFor, seedPlan } from './selector-stage-fixture.js';

async function committedScenario() {
  const markdown = ['# 2 装配验收', '', '## 2.1 装配组件', '',
    '2.1.1 接口连接应牢固。', '', '检验方法：观察并核查记录。', '',
    '检查数量：全数核查。', '', '2.1.3 验收记录应归档。', ''].join('\n');
  const { workspace, manifest } = await buildSelectorStageScenario(markdown);
  const registry = await workspace.readSourceSpanRegistry();
  const root = clauseRecord(manifest, '2.1.1'), other = clauseRecord(manifest, '2.1.3');
  const title = manifest.evidence.find(e => e.text === '## 2.1 装配组件')!;
  const method = manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检验方法'))!;
  const quantity = manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检查数量'))!;
  const span = (e: typeof root) => fullSpanFor(registry, e.evidence_id, e.text.length);
  const plan = seedPlan(manifest, span(other));
  plan.lots[0]!.name = '装配组件'; plan.lots[0]!.scope_span_ids = [span(title)];
  plan.items[0]!.name = '验收记录'; plan.items[0]!.category = '原文未标明类别';
  plan.residual_source_dispositions = [];
  const item = structuredClone(plan.items[0]!);
  item.key = 'interface'; item.name = '接口连接'; item.criterion_span_ids = [span(root)];
  item.fields.name = { composition: 'semantic_summary', span_ids: [span(root)], separator: '', reason: '原文对象。' };
  item.fields.requirement = { composition: 'verbatim', span_ids: [span(root)], separator: '', reason: '原文要求。' };
  item.fields.method = { composition: 'verbatim', span_ids: [span(method)], separator: '', reason: '原文方法。' };
  item.fields.quantity = { composition: 'verbatim', span_ids: [span(quantity)], separator: '', reason: '原文数量。' };
  item.inspection_data_type_span_ids = [span(method)];
  item.sampling = { ...item.sampling, status: 'explicit', quantity_span_ids: [span(quantity)], script_span_ids: [span(quantity)] };
  plan.items.push(item);
  await workspace.writeWorkingSelectors(prettyJson(plan));
  await workspace.updateState(s => {
    s.selector_stage = 'table'; s.target_review_protocol = DIRECT_VALIDATION_PROTOCOL;
    s.agent_runtime.kind = 'pi-sdk';
  });
  const controller = await ToolController.create(workspace);
  await controller.dispatch('batch_open_evidence', { evidence_ids: [root, other, title, method, quantity].map(e => e.evidence_id) });
  await controller.dispatch('read_target_selectors', {});
  const committed = await controller.dispatch('commit_target_selector_draft', { draft_fingerprint: await currentFingerprint(controller) });
  expect(committed).toMatchObject({ ok: true, fingerprint: expect.any(String) });
  const receipt = JSON.parse(await readFile(workspace.validationReceiptPath, 'utf8'));
  expect(receipt).toMatchObject({ trigger: 'decision-compile', ok: true, selector_compiler_context_fingerprint: expect.any(String) });
  expect((await workspace.readState()).agent_runtime.kind).toBe('pi-sdk');
  return { workspace, controller, committed, receipt };
}

test('an incorrect seal request preserves a fully current committed checkpoint and supports exact retry after reopening', async () => {
  const { workspace, controller, committed } = await committedScenario();
  const beforeState = await workspace.readState();
  const paths = [workspace.workingSelectorPath, workspace.workingPlanPath, workspace.sourceSpanRegistryPath,
    workspace.selectorCompilerContextPath, workspace.validationReceiptPath, workspace.lastValidPlanPath];
  const before = await Promise.all(paths.map(p => readFile(p, 'utf8')));
  expect(committed.plan_sha256).not.toBe(committed.fingerprint);
  const wrong = await controller.dispatch('seal_validated_plan', { fingerprint: committed.plan_sha256 });
  expect(wrong).toMatchObject({ ok: false, error: 'fingerprint_mismatch_or_unverified', mismatch: 'submitted_fingerprint',
    checkpoint_preserved: true, current_checkpoint_verified: true, actual_fingerprint: committed.plan_sha256,
    current_fingerprint: committed.fingerprint, last_valid_fingerprint: committed.fingerprint,
    writable_paths: ['/fingerprint'], next_tool: 'seal_validated_plan', next_tool_arguments: { fingerprint: committed.fingerprint }, budget_consumed: false });
  const after = await workspace.readState();
  expect(after.last_valid_fingerprint).toBe(beforeState.last_valid_fingerprint);
  expect(after.last_valid_plan_sha256).toBe(beforeState.last_valid_plan_sha256);
  expect(after.repair).toEqual(beforeState.repair);
  expect(after.validation_attempts).toBe(beforeState.validation_attempts);
  expect(after.selector_protocol).toEqual(beforeState.selector_protocol);
  expect(await Promise.all(paths.map(p => readFile(p, 'utf8')))).toEqual(before);
  await expect(access(workspace.manifestPath)).rejects.toThrow();
  const reopened = await ToolController.create(workspace);
  expect(await reopened.dispatch('seal_validated_plan', { fingerprint: '' })).toMatchObject({ ok: false, checkpoint_preserved: true });
  expect(await reopened.dispatch(String(wrong.next_tool), wrong.next_tool_arguments as Record<string, unknown>)).toMatchObject({ ok: true, status: 'passed' });
  expect((await workspace.readState()).validation_attempts).toBe(beforeState.validation_attempts);
});

test.each(['plan', 'last-valid', 'selectors', 'registry', 'compiler-context', 'receipt'] as const)(
  'an incorrect request cannot preserve or seal a checkpoint after %s authority changes', async change => {
    const { workspace, committed } = await committedScenario();
    if (change === 'plan') await writeFile(workspace.workingPlanPath, '{}', 'utf8');
    if (change === 'last-valid') await workspace.updateState(s => { s.last_valid_plan_sha256 = ''; });
    if (change === 'selectors') {
      const plan = JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'));
      plan.items[0].reason += ' 作者修改。';
      await writeFile(workspace.workingSelectorPath, prettyJson(plan), 'utf8');
    }
    if (change === 'registry') {
      const registry = await workspace.readSourceSpanRegistry();
      registry.spans[0]!.text_sha256 = '0'.repeat(64);
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), 'utf8');
    }
    if (change === 'compiler-context') await writeFile(workspace.selectorCompilerContextPath,
      `${await readFile(workspace.selectorCompilerContextPath, 'utf8')}\n`, 'utf8');
    if (change === 'receipt') {
      const receipt = JSON.parse(await readFile(workspace.validationReceiptPath, 'utf8'));
      receipt.selector_compiler_context_fingerprint = '0'.repeat(64);
      await writeFile(workspace.validationReceiptPath, prettyJson(receipt), 'utf8');
    }
    const controller = await ToolController.create(workspace);
    const rejected = await controller.dispatch('seal_validated_plan', { fingerprint: committed.plan_sha256 });
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected.checkpoint_preserved).not.toBe(true);
    expect((await workspace.readState()).last_valid_fingerprint).toBe('');
    await expect(access(workspace.manifestPath)).rejects.toThrow();
    expect(await controller.dispatch('seal_validated_plan', { fingerprint: committed.fingerprint })).toMatchObject({ ok: false });
  },
);


test('a request typo does not bypass the existing independent coverage gate', async () => {
  const { workspace, committed } = await committedScenario();
  await workspace.updateState(s => { s.target_review_protocol = 'legacy-independent-coverage/v1'; });
  const controller = await ToolController.create(workspace);
  const rejected = await controller.dispatch('seal_validated_plan', { fingerprint: committed.plan_sha256 });
  expect(rejected).toMatchObject({ ok: false, error: 'domain_coverage_review_required' });
  expect(rejected.checkpoint_preserved).not.toBe(true);
  expect(rejected.next_tool).not.toBe('seal_validated_plan');
  expect((await workspace.readState()).last_valid_fingerprint).toBe(committed.fingerprint);
  await expect(access(workspace.manifestPath)).rejects.toThrow();
});
