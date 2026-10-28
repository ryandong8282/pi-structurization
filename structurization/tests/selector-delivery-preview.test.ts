import { expect, test } from 'vitest';
import type { EvidenceRecord } from '../src/contracts.js';
import type { SourceSpanRegistry } from '../src/source-span-registry.js';
import type { TargetSelectorPlan } from '../src/target-selector-compiler.js';
import { selectorDeliveryPreview } from '../src/selector-delivery-preview.js';
import { sourceBoundaryNeighbors } from '../src/source-boundary-review.js';
import { readFile } from 'node:fs/promises';
import { prettyJson } from '../src/canonical.js';
import { ToolController } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, seedPlan } from './selector-stage-fixture.js';

function fixture() {
  const records = [
    { evidence_id: 'evidence:a', locator: 'doc/line:10', text: '检验方式、抽查范围均按批准方案确定，并由见证人确认。' },
    { evidence_id: 'evidence:b', locator: 'doc/line:12', text: '观察接头是否符合专门施' },
    { evidence_id: 'evidence:page', locator: 'doc/line:14', text: '<!-- pages_21_40 -->' },
    { evidence_id: 'evidence:c', locator: 'doc/line:16', text: '工方案要求。' },
  ] as EvidenceRecord[];
  const registry = { spans: [
    { span_id: 'span:method', evidence_id: 'evidence:a', start: 0, end: 4 },
    { span_id: 'span:quantity', evidence_id: 'evidence:a', start: 5, end: 9 },
    { span_id: 'span:head', evidence_id: 'evidence:b', start: 0, end: records[1]!.text.length },
    { span_id: 'span:tail', evidence_id: 'evidence:c', start: 0, end: records[3]!.text.length },
  ] } as SourceSpanRegistry;
  const field = (ids: string[]) => ({ composition: 'verbatim', span_ids: ids, separator: '', reason: '作者判断需依据批准方案及见证条件' });
  const plan = { items: [{ key: 'neutral-item', name: '接头检查', table: null, fields: {
    method: field(['span:method']), quantity: field(['span:quantity']), requirement: field(['span:head']),
  } }] } as unknown as TargetSelectorPlan;
  const preview = (opened = records.map(r => r.evidence_id)) => selectorDeliveryPreview(plan, registry, records, new Set(['neutral-item']), new Set(opened));
  return { records, registry, plan, preview };
}

test('shows exact business values separately from author reasoning and qualifying source, without repairing facts', () => {
  const f = fixture(), before = JSON.stringify(f.plan);
  const result = f.preview();
  expect(result).toMatchObject({ advisory_only: true, items: [{ fields: {
    method: { actual_value: '检验方式', writable_path: '/items/0/fields/method' },
    quantity: { actual_value: '抽查范围' },
  } }] });
  expect(result.items[0]!.source_context[0]).toMatchObject({ text: f.records[0]!.text, text_complete: true });
  expect(result.items[0]!.fields.method!.actual_value).not.toContain('见证');
  expect(JSON.stringify(f.plan)).toBe(before);
});

test('page navigation exposes physical neighbors but does not silently join unrelated or unread text', () => {
  const f = fixture();
  expect(sourceBoundaryNeighbors(f.records, 'evidence:b')).toMatchObject([{ evidence_id: 'evidence:c', relation: 'after_page_boundary' }]);
  expect(sourceBoundaryNeighbors(f.records, 'evidence:c')).toMatchObject([{ evidence_id: 'evidence:b', relation: 'before_page_boundary' }]);
  expect(f.preview().items[0]!.fields.requirement!.actual_value).toBe(f.records[1]!.text);
  f.records[3]!.text = '另一对象的独立检验条款。';
  expect(sourceBoundaryNeighbors(f.records, 'evidence:b')).toHaveLength(1); // Physical navigation does not decide continuity.
  const hidden = f.preview(['evidence:a']);
  expect(hidden.items[0]!.fields.requirement).toMatchObject({ actual_value: '', actual_value_available: false });
  expect(hidden.items[0]!.source_context[1]).not.toHaveProperty('text');
  expect(JSON.stringify(hidden)).not.toContain(f.records[3]!.text);
});

test('authored continuation uses the compiler display projection, and large previews mark excerpts explicitly', () => {
  const f = fixture();
  f.plan.items[0]!.fields.requirement.span_ids.push('span:tail');
  expect(f.preview().items[0]!.fields.requirement!.actual_value).toBe('观察接头是否符合专门施工方案要求。');
  f.plan.items[0]!.fields.requirement.span_ids.push('span:tail'); // Compiler suppresses duplicate display fragments.
  expect(f.preview().items[0]!.fields.requirement!.actual_value).toBe('观察接头是否符合专门施工方案要求。');
  f.records[1]!.text = '完整限定内容。'.repeat(5000);
  f.registry.spans[2]!.end = f.records[1]!.text.length;
  const result = f.preview();
  expect(result.items[0]!.fields.requirement).toMatchObject({ actual_value_complete: false, actual_value_available: true });
  expect(result.items[0]!.source_context[1]).toMatchObject({ text_complete: false });
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(16 * 1024);
});

function samplingFixture() {
  const f = fixture();
  f.plan.sampling_rules = [{ key: 'neutral-rule', complete_span_ids: [], reason: '依据原文判断',
    components: [{ key: 'shared-quantity', role: 'quantity', disposition: 'present',
      span_ids: ['span:quantity'], reason: '作者说明包含批准方案及见证人，但选择的正文没有这些内容' }],
    branches: [{ key: 'branch-a', applies_to_category: 'all_items', reason: '仅供中性展示',
      components: [{ key: 'branch-method', role: 'method', disposition: 'present',
        span_ids: ['span:head'], reason: '本分支选择的检查方法' }] }],
  }];
  return f;
}

test('shared and branch sampling components expose selected text separately from reasons without changing source or ownership', () => {
  const f = samplingFixture(), before = JSON.stringify({ plan: f.plan, registry: f.registry });
  const result = selectorDeliveryPreview(f.plan, f.registry, f.records, new Set(),
    new Set(f.records.map(r => r.evidence_id)), new Set(['neutral-rule']));
  expect(result).toMatchObject({ sampling_rules: [{ rule_key: 'neutral-rule', components: [{
    key: 'shared-quantity', role: 'quantity', actual_value: '抽查范围', actual_value_available: true,
    writable_path: '/sampling_rules/0/components/0',
  }], branches: [{ branch_key: 'branch-a', components: [{
    actual_value: '观察接头是否符合专门施', writable_path: '/sampling_rules/0/branches/0/components/0',
  }] }] }] });
  const component = result.sampling_rules[0]!.components[0]!;
  expect(component.author_reason).toContain('批准方案');
  expect(component.actual_value).not.toContain('批准方案');
  expect(component.source_context[0]).toMatchObject({ evidence_id: 'evidence:a', text: f.records[0]!.text });
  expect(JSON.stringify({ plan: f.plan, registry: f.registry })).toBe(before);
});

test('sampling previews withhold unread text and share the existing total preview byte budget', () => {
  const f = samplingFixture();
  const hidden = selectorDeliveryPreview(f.plan, f.registry, f.records, new Set(), new Set(), new Set(['neutral-rule']));
  expect(hidden.sampling_rules[0]!.components[0]).toMatchObject({ actual_value: '', actual_value_available: false });
  expect(hidden.sampling_rules[0]!.components[0]!.source_context[0]).not.toHaveProperty('text');
  expect(JSON.stringify(hidden)).not.toContain(f.records[0]!.text);
  f.records[0]!.text = '有界原文片段。'.repeat(3000);
  f.registry.spans[1]!.end = f.records[0]!.text.length;
  const template = structuredClone(f.plan.sampling_rules[0]!);
  f.plan.sampling_rules = Array.from({ length: 40 }, (_, i) => ({ ...template, key: `neutral-rule-${i}` }));
  const result = selectorDeliveryPreview(f.plan, f.registry, f.records, new Set(['neutral-item']),
    new Set(f.records.map(r => r.evidence_id)), new Set(f.plan.sampling_rules.map(r => r.key)));
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  expect(result.sampling_rules.length).toBeLessThan(40);
  expect(result.remaining_sampling_rule_count).toBe(40 - result.sampling_rules.length);
  expect(result.remaining_sampling_rule_keys.length).toBeGreaterThan(0);
  f.plan.sampling_rules = f.plan.sampling_rules.map(rule => ({ ...rule, key: `${rule.key}-${'x'.repeat(5000)}` }));
  const largeKeys = selectorDeliveryPreview(f.plan, f.registry, f.records, new Set(),
    new Set(f.records.map(r => r.evidence_id)), new Set(f.plan.sampling_rules.map(r => r.key)));
  expect(Buffer.byteLength(JSON.stringify(largeKeys), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  expect(largeKeys.remaining_sampling_rule_keys_complete).toBe(false);
  expect(largeKeys.remaining_sampling_rule_count).toBe(40 - largeKeys.sampling_rules.length);
});

test('actual rule reads and rule-only stage receipts show values without granting source reads or changing other records and budgets', async () => {
  const { workspace, manifest } = await buildSelectorStageScenario();
  const source = clauseRecord(manifest, '2.1.1'), registry = await workspace.readSourceSpanRegistry();
  const span = fullSpanFor(registry, source.evidence_id, source.text.length), selectors = seedPlan(manifest, span);
  const absentRoles = ['applicability', 'branch_condition', 'method', 'acceptance_criterion', 'exception', 'note'] as const;
  selectors.sampling_rules = [{ key: 'neutral-rule', complete_span_ids: [], reason: '合成来源展示',
    components: [{ key: 'quantity', role: 'quantity', disposition: 'present', span_ids: [span], reason: '作者判断' },
      ...absentRoles.map(role => ({ key: role, role, disposition: 'absent' as const, span_ids: [], reason: '本中性记录无该组件' }))],
    branches: [{ key: 'default', applies_to_category: 'all_items', components: [], reason: '单分支' }],
  }];
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  await workspace.updateState(state => { state.selector_stage = 'sampling'; });
  const controller = await ToolController.create(workspace);
  const unread = await controller.dispatch('read_target_selectors', { collection: 'sampling_rules', key: 'neutral-rule' });
  expect(unread).toMatchObject({ delivery_preview: { sampling_rules: [{ components: expect.arrayContaining([
    expect.objectContaining({ key: 'quantity', actual_value_available: false }),
  ]) }] } });
  await controller.dispatch('open_evidence', { evidence_id: source.evidence_id, cursor: 0 });
  const beforeState = await workspace.readState(), beforeRegistry = await workspace.readSourceSpanRegistry();
  const beforeDraft = await readFile(workspace.workingSelectorPath, 'utf8');
  const read = await controller.dispatch('read_target_selectors', { collection: 'sampling_rules', key: 'neutral-rule' });
  expect(read).toMatchObject({ budget_consumed: false, delivery_preview: { sampling_rules: [{
    rule_key: 'neutral-rule', components: expect.arrayContaining([
      expect.objectContaining({ key: 'quantity', actual_value: source.text, actual_value_available: true }),
    ]),
  }] } });
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(beforeDraft);
  expect(await workspace.readState()).toEqual({ ...beforeState, next_event_sequence: beforeState.next_event_sequence + 2 });
  const revised = { ...selectors.sampling_rules[0]!, reason: '仅更新中性作者说明，不变更选择正文' };
  const staged = await controller.dispatch('stage_target_selector_draft', {
    operation: 'upsert', draft: { sampling_rules: [revised] },
  });
  expect(staged).toMatchObject({ ok: true, budget_consumed: false, global_candidate_complete: false,
    delivery_preview: { sampling_rules: [{ rule_key: 'neutral-rule', components: expect.arrayContaining([
      expect.objectContaining({ key: 'quantity', actual_value: source.text }),
    ]) }] } });
  expect((staged.delivery_preview as any).sampling_rules[0].components).toHaveLength(7);
  expect(JSON.parse(await readFile(workspace.workingSelectorPath, 'utf8'))).toEqual({ ...selectors, sampling_rules: [revised] });
  expect(await workspace.readSourceSpanRegistry()).toEqual(beforeRegistry);
  const afterState = await workspace.readState();
  expect(afterState.opened_evidence_ids).toEqual(beforeState.opened_evidence_ids);
  expect(afterState.selector_protocol).toEqual(beforeState.selector_protocol);
  expect(afterState.validation_attempts).toBe(beforeState.validation_attempts);
});
