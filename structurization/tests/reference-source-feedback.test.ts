import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { Check } from 'typebox/value';
import { createPiTools } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord } from './selector-stage-fixture.js';

test('reference composition feedback distinguishes registered target evidence from local evidence before any selector receipt exists', async () => {
  const markdown = ['# 2 构件验收', '', '## 2.1 构件甲核查', '',
    '2.1.1 构件甲的安装缝应符合附录 B 的规定。', '',
    '检验方法：观察检查。', '', '检查数量：全数检查。', '',
    '# 附录 B 安装要求', '', 'B.0.1 构件甲的安装缝应紧密。', ''].join('\n');
  const { controller, workspace, manifest } = await buildSelectorStageScenario(markdown);
  const origin = clauseRecord(manifest, '2.1.1');
  const initialRegistry = await workspace.readSourceSpanRegistry();
  const originSpan = fullSpanFor(initialRegistry, origin.evidence_id, origin.text.length);
  expect((await controller.dispatch('batch_open_evidence', { evidence_ids: manifest.evidence.map(e => e.evidence_id) })).ok).toBe(true);
  const resolved = await controller.dispatch('resolve_document_reference', {
    origin_span_id: originSpan, raw_reference: '附录 B',
    target: { kind: 'appendix', number: 'B' }, relation: 'shared_appendix_requirement',
  }) as any;
  expect(resolved).toMatchObject({ ok: true, analysis_mode: 'inline' });
  expect((await controller.dispatch('read_document_reference_evidence', { target_key: resolved.target_key })).ok).toBe(true);
  const evidence = await workspace.readEvidenceManifest();
  const target = evidence.evidence.find(e => e.evidence_scope === 'reference' && e.text.includes('安装缝应紧密'))!;
  expect(target).toBeDefined();
  const registry = await workspace.readSourceSpanRegistry();
  const targetSpan = fullSpanFor(registry, target.evidence_id, target.text.length);
  const method = evidence.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检验方法'))!;
  const quantity = evidence.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('检查数量'))!;
  const methodSpan = fullSpanFor(registry, method.evidence_id, method.text.length);
  const quantitySpan = fullSpanFor(registry, quantity.evidence_id, quantity.text.length);
  const item = itemRecord('joint', '构件甲安装缝', '主控项目', originSpan, '合成原文核查安装缝。');
  item.criterion_span_ids.push(targetSpan);
  item.fields.requirement = { composition: 'reference', span_ids: [originSpan, targetSpan], separator: ' ', reason: '保留本地引用及已读的被引要求。' };
  item.fields.method = { composition: 'verbatim', span_ids: [methodSpan], separator: '', reason: '本地检验方法。' };
  item.fields.quantity = { composition: 'verbatim', span_ids: [quantitySpan], separator: '', reason: '本地数量。' };
  item.sampling = { ...item.sampling, status: 'explicit', quantity_span_ids: [quantitySpan], script_span_ids: [quantitySpan], reason: '本地全数检查。' };
  const stateBefore = await workspace.readState();
  const manifestBefore = await readFile(workspace.evidenceManifestPath, 'utf8');
  const registryBefore = await workspace.readSourceSpanRegistry();
  const staged = await controller.dispatch('stage_target_selector_draft', { operation: 'upsert', draft: {
    lots: [{ key: 'lot:2.1', name: '构件甲核查', scope_span_ids: [originSpan], reason: '合成原文定义的对象范围。' }], items: [item],
  } }) as any;
  expect(staged.ok, JSON.stringify(staged)).toBe(true);
  const issue = staged.local_validation.issues.find((i: any) => i.code === 'selector_reference_composition_without_resolve_receipt' && i.path.includes('/fields/requirement/'));
  expect(issue).toBeDefined();
  const targetCheck = issue.details.source_checks.find((s: any) => s.span_id === targetSpan);
  const localCheck = issue.details.source_checks.find((s: any) => s.span_id === originSpan);
  expect(targetCheck.status).toBe('outside_reference_targets');
  expect(targetCheck).toMatchObject({ source_scope: 'reference', resolved_target_occurrences: [
    expect.objectContaining({ occurrence_id: resolved.occurrence_id, matching_reference_keys: [] }),
  ] });
  expect(localCheck).toMatchObject({ source_scope: 'primary', resolved_target_occurrences: [] });
  const route = targetCheck.resolved_target_occurrences[0].catalog_read;
  const tool = createPiTools(controller).find(t => t.name === route.tool)!;
  expect(Check(tool.parameters, route.arguments)).toBe(true);
  const catalog = await controller.dispatch(route.tool, route.arguments) as any;
  expect(catalog.occurrences).toHaveLength(1);
  expect(catalog.occurrences[0].occurrence_id).toBe(resolved.occurrence_id);
  expect(issue.how_to_pass ?? issue.details.how_to_pass).not.toContain('通常是本地来源');
  expect(issue.how_to_pass ?? issue.details.how_to_pass).toContain('仅说明');
  const saved = JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'));
  expect(saved.references).toEqual([]);
  expect(saved.items[0].fields.requirement).toEqual(item.fields.requirement);
  expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
  expect(await readFile(workspace.evidenceManifestPath, 'utf8')).toBe(manifestBefore);
  const stateAfter = await workspace.readState();
  expect(stateAfter.selector_protocol).toEqual(stateBefore.selector_protocol);
  expect(stateAfter.validation_attempts).toBe(stateBefore.validation_attempts);
  expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);

  const unowned = { ...item, criterion_span_ids: [originSpan] };
  const unownedSaved = await controller.dispatch('stage_target_selector_draft', { operation: 'upsert', draft: { items: [unowned] } }) as any;
  expect(unownedSaved.ok).toBe(true);
  const unownedIssue = unownedSaved.local_validation.issues.find((i: any) => i.code === 'selector_reference_composition_without_resolve_receipt' && i.path.includes('/fields/requirement/'));
  expect(unownedIssue.details.source_checks.find((s: any) => s.span_id === targetSpan)).toMatchObject({
    status: 'item_source_not_bound', source_scope: 'reference',
    resolved_target_occurrences: [expect.objectContaining({ occurrence_id: resolved.occurrence_id })],
  });
  expect(unownedSaved.local_validation.ok).toBe(false);
  expect(JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8')).references).toEqual([]);
});
