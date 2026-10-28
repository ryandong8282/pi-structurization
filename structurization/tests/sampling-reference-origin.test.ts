import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { prettyJson } from '../src/canonical.js';
import { compileTargetSelectors } from '../src/target-selector-compiler.js';
import { materialize } from '../src/materializer.js';
import { validatePlanText } from '../src/validator.js';
import { classifyStrictSelectorIssues } from '../src/selector-issue-ownership.js';
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord } from './selector-stage-fixture.js';

test('selected sampling delivery retains its own reference origin independently of the ordinary quantity field', async () => {
  const markdown = ['# 2 构件验收', '', '## 2.1 构件甲核查', '',
    '2.1.1 构件甲安装缝应紧密。', '', '检验方法：观察检查。', '',
    '检查数量：每区检查三件。', '', '抽样方式：构件甲应分区随机选取，具体方式按附录 B 的规定实施。', '',
    '# 附录 B 抽样方式', '', 'B.0.1 各区应采用随机编号选取构件。', ''].join('\n');
  const { controller, workspace, manifest } = await buildSelectorStageScenario(markdown);
  expect((await controller.dispatch('batch_open_evidence', { evidence_ids: manifest.evidence.map(e => e.evidence_id) })).ok).toBe(true);
  const origin = manifest.evidence.find(e => e.text.startsWith('抽样方式：'))!;
  expect(origin).toBeDefined();
  let registry = await workspace.readSourceSpanRegistry();
  const originSpan = fullSpanFor(registry, origin.evidence_id, origin.text.length);
  const receipt = await controller.dispatch('resolve_document_reference', {
    origin_span_id: originSpan, origin_field: 'sampling', raw_reference: '附录 B',
    target: { kind: 'appendix', number: 'B' }, relation: 'sampling_method',
  }) as any;
  expect(receipt).toMatchObject({ ok: true, analysis_mode: 'inline' });
  expect((await controller.dispatch('read_document_reference_evidence', { target_key: receipt.target_key })).ok).toBe(true);
  const evidence = await workspace.readEvidenceManifest();
  registry = await workspace.readSourceSpanRegistry();
  const target = evidence.evidence.find(e => e.evidence_scope === 'reference' && e.text.includes('随机编号'))!;
  const targetSpan = fullSpanFor(registry, target.evidence_id, target.text.length);
  const heading = evidence.evidence.find(e => e.evidence_scope === 'reference' && e.text.startsWith('# 附录 B'))!;
  const headingSpan = fullSpanFor(registry, heading.evidence_id, heading.text.length);
  const section = evidence.evidence.find(e => e.text === '## 2.1 构件甲核查')!;
  const sectionSpan = fullSpanFor(registry, section.evidence_id, section.text.length);
  const requirement = clauseRecord(evidence, '2.1.1');
  const requirementSpan = fullSpanFor(registry, requirement.evidence_id, requirement.text.length);
  const method = evidence.evidence.find(e => e.text.startsWith('检验方法：'))!;
  const quantity = evidence.evidence.find(e => e.text.startsWith('检查数量：'))!;
  const quantitySpan = fullSpanFor(registry, quantity.evidence_id, quantity.text.length);
  const item = itemRecord('joint', '构件甲安装缝', '主控项目', requirementSpan, '合成安装缝判据及独立抽样方式。');
  item.fields.method = { composition: 'verbatim', span_ids: [fullSpanFor(registry, method.evidence_id, method.text.length)], separator: '', reason: '原文观察检查。' };
  item.fields.quantity = { composition: 'verbatim', span_ids: [quantitySpan], separator: '', reason: '独立数量原文完整保留。' };
  item.sampling = { ...item.sampling, status: 'reference', rule_key: 'zone-sampling', branch_keys: ['zone'], reason: '每区三件并保留抽样方式原文。' };
  const absentRoles = ['applicability', 'branch_condition', 'acceptance_criterion', 'exception', 'note'] as const;
  const rule = { key: 'zone-sampling', complete_span_ids: [], reason: '合成分区抽样数量及方式。', components: [
    { key: 'quantity', role: 'quantity' as const, disposition: 'present' as const, span_ids: [quantitySpan], reason: '本地完整数量。' },
    ...absentRoles.map(role => ({ key: role, role, disposition: 'absent' as const, span_ids: [], reason: '合成来源无本角色。' })),
  ], branches: [{ key: 'zone', applies_to_category: 'all_items' as const, reason: '本合成对象分区抽样。', components: [
    { key: 'method', role: 'method' as const, disposition: 'present' as const, span_ids: [originSpan, targetSpan], reason: '原本地抽样上下文与已读附录方式。' },
  ] }] };
  const reference = { key: 'sampling-method', occurrence_id: receipt.occurrence_id,
    anchor_span_ids: receipt.reference_literal_span_ids ?? [receipt.reference_literal_span_id], target_span_ids: [targetSpan],
    action: 'adopt' as const, application_mode: 'reference_only' as const,
    import_scope: { mode: 'field_specific' as const, allowed_fields: ['sampling' as const], reason: '仅抽样方式导入。' },
    origin_binding: { item_key: item.key, target_field: 'sampling' as const },
    destinations: [{ item_key: item.key, target_field: 'sampling' as const }],
    component_dispositions: [{ component_span_ids: [targetSpan], decision: 'same_judgment' as const, item_keys: [item.key], reason: '同一对象的抽样方式。' }],
    reason: '本地抽样引用及上下文由真实选中组件交付，被引方式属于同一抽样义务。',
  };
  const staged = await controller.dispatch('stage_target_selector_draft', { operation: 'upsert', draft: {
    lots: [{ key: 'lot:2.1', name: '构件甲核查', scope_span_ids: [requirementSpan, headingSpan, sectionSpan], reason: '合成条文的对象分组。' }],
    items: [item], sampling_rules: [rule], references: [reference],
  } }) as any;
  expect(staged.ok, JSON.stringify(staged)).toBe(true);
  expect(staged.local_validation.ok, JSON.stringify(staged.local_validation)).toBe(true);
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'));
  const compiled = compileTargetSelectors(selectors, await workspace.readSourceSpanRegistry(), evidence);
  const delivered = materialize(compiled, evidence, 'neutral-sampling-origin').result.inspection_lots[0]!.items[0]!;
  expect(delivered.quantity).toBe(quantity.text);
  const visibleComponents = delivered.sampling.applied_branches!.flatMap(branch => branch.components ?? []);
  expect(visibleComponents.find(component => component.key === 'method')!.source_fragments!.map(fragment => fragment.text)).toContain(origin.text);
  expect(delivered.sampling.applied_branches![0]!.branch_id).toBe(compiled.acceptance_items[0]!.sampling.branch_ids![0]);
  expect(Object.values(compiled.acceptance_items[0]!.field_bindings).flatMap(binding => binding.source_span_ids)).not.toContain(originSpan);
  const strict = validatePlanText(prettyJson(compiled), evidence, new Set((await workspace.readState()).opened_evidence_ids));
  expect(strict.issues, JSON.stringify(strict)).toEqual([]);

  const draftBefore = await readFile(workspace.workingSelectorPath, 'utf8');
  const stateBefore = await workspace.readState();
  const registryBefore = await workspace.readSourceSpanRegistry();
  const check = (candidate: typeof selectors, opened = new Set(stateBefore.opened_evidence_ids)) => {
    const plan = compileTargetSelectors(candidate, registry, evidence);
    return { plan, validation: validatePlanText(prettyJson(plan), evidence, opened) };
  };
  const literalOnly = structuredClone(selectors);
  literalOnly.sampling_rules[0].branches[0].components[0].span_ids = [receipt.reference_literal_span_id, targetSpan];
  const invalid = check(literalOnly);
  const relation = invalid.validation.issues.filter(issue => issue.code === 'reference_origin_relation');
  expect(relation.length).toBe(1);
  const feedback = classifyStrictSelectorIssues(literalOnly, invalid.plan, registry, relation)[0]!;
  expect((feedback.details as any).writable_paths).toContain('/sampling_rules/0/branches/0/components');
  expect((feedback.details as any).current_origin_sampling_spans[0].span_id).toBe(receipt.reference_literal_span_id);
  expect((feedback.details as any).tool_argument_hints.read_target_selectors[1]).toMatchObject({ collection: 'sampling_rules', key: rule.key });

  const overridden = structuredClone(literalOnly);
  overridden.sampling_rules[0].components.push(structuredClone(rule.branches[0]!.components[0]!));
  const overriddenCheck = check(overridden);
  const overriddenRelation = overriddenCheck.validation.issues.filter(issue => issue.code === 'reference_origin_relation');
  expect(overriddenRelation.length).toBe(1);
  const overriddenFeedback = classifyStrictSelectorIssues(overridden, overriddenCheck.plan, registry, overriddenRelation)[0]!;
  expect((overriddenFeedback.details as any).current_origin_sampling_spans.map((span: any) => span.span_id)).not.toContain(originSpan);

  const envelopeOnly = structuredClone(literalOnly);
  envelopeOnly.sampling_rules[0].complete_span_ids = [originSpan];
  envelopeOnly.sampling_rules[0].reason = origin.text;
  expect(check(envelopeOnly).validation.issues.some(issue => issue.code === 'reference_origin_relation')).toBe(true);

  const unselected = structuredClone(envelopeOnly);
  unselected.sampling_rules[0].branches.push({ ...structuredClone(rule.branches[0]!), key: 'other-zone' });
  expect(check(unselected).validation.issues.some(issue => issue.code === 'reference_origin_relation')).toBe(true);

  const otherReceiver = structuredClone(unselected);
  otherReceiver.items.push({ ...structuredClone(item), key: 'other-receiver', sampling: { ...item.sampling, branch_keys: ['other-zone'] } });
  expect(check(otherReceiver).validation.issues.some(issue => issue.code === 'reference_origin_relation')).toBe(true);

  const absent = structuredClone(literalOnly);
  absent.sampling_rules[0].components.find((component: any) => component.role === 'note').span_ids = [originSpan];
  expect(() => check(absent)).toThrow();

  const unread = new Set(stateBefore.opened_evidence_ids.filter(id => id !== origin.evidence_id));
  expect(check(selectors, unread).validation.ok).toBe(false);
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(draftBefore);
  expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
  expect(await workspace.readState()).toEqual(stateBefore);
});
