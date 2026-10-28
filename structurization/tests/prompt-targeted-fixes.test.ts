import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { Check } from 'typebox/value';
import { selectorSessionContractContext } from '../src/selector-session-contract.js';
import { PROMPT_SUITE_VERSION, TARGET_SELECTOR_PROTOCOLS, HIERARCHY_ITEM_ASSIGNMENT_GUIDANCE,
  HIERARCHY_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT } from '../src/acceptance-prompt-suite.js';
import { TARGET_SELECTOR_ITEM_JSON_SCHEMA, TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA,
  migrateTargetSelectorPlanForAuthoring } from '../src/target-selector-compiler.js';
import { createPiTools, ToolController } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord, seedPlan } from './selector-stage-fixture.js';

describe('targeted prompt and contract fixes', () => {
  test('fresh and compacted contexts get the full current protocol once; old markers and summaries do not count', () => {
    const first = selectorSessionContractContext('修当前记录', []);
    expect(first.delivery).toBe('provided_in_user_message');
    for (const text of Object.values(TARGET_SELECTOR_PROTOCOLS)) expect(first.prompt).toContain(JSON.stringify(text).slice(1, -1));
    const messages = [{ role: 'user', content: [{ type: 'text', text: first.prompt }] }];
    expect(selectorSessionContractContext('继续下一项', messages)).toMatchObject({ delivery: 'retained_context', prompt: '继续下一项' });
    const old = first.prompt.replace(PROMPT_SUITE_VERSION, 'old-version');
    expect(selectorSessionContractContext('恢复', [{ role: 'user', content: old }]).delivery).toBe('provided_in_user_message');
    expect(selectorSessionContractContext('恢复', [{ role: 'custom', content: first.prompt }]).delivery).toBe('provided_in_user_message');
    expect(selectorSessionContractContext('恢复', [{ role: 'user', content: '摘要：已读协议 ' + PROMPT_SUITE_VERSION }]).delivery).toBe('provided_in_user_message');
    expect(selectorSessionContractContext('封存', [], true)).toMatchObject({ delivery: 'validated_seal_bypass', prompt: '封存' });
  });

  test('an actual same-version tool result is reusable; a different protocol body is not', () => {
    const result = { prompt_protocol_version: PROMPT_SUITE_VERSION, authoring_protocols: TARGET_SELECTOR_PROTOCOLS };
    expect(selectorSessionContractContext('继续', [{ role: 'toolResult', content: [{ type: 'text', text: JSON.stringify(result) }] }]).delivery).toBe('retained_context');
    expect(selectorSessionContractContext('继续', [{ role: 'toolResult', details: result,
      content: [{ type: 'text', text: '契约已读，正文被压缩。' }] }]).delivery).toBe('provided_in_user_message');
    expect(selectorSessionContractContext('继续', [{ role: 'toolResult', details: { ...result,
      authoring_protocols: { ...TARGET_SELECTOR_PROTOCOLS, patch: 'outdated' } } }]).delivery).toBe('provided_in_user_message');
  });

  test('new fact fields reject summaries before any draft or quote mutation, while old records remain readable', async () => {
    const { workspace, manifest } = await buildSelectorStageScenario();
    const record = clauseRecord(manifest, '2.1.1');
    const span = fullSpanFor(await workspace.readSourceSpanRegistry(), record.evidence_id, record.text.length);
    const plan = seedPlan(manifest, span);
    const item = itemRecord('neutral', '合成器件', '一般项目', span, '中性来源');
    item.fields.requirement.composition = 'semantic_summary';
    expect(Check(TARGET_SELECTOR_ITEM_JSON_SCHEMA, item)).toBe(true);
    expect(Check(TARGET_SELECTOR_AUTHOR_ITEM_JSON_SCHEMA, item)).toBe(false);
    plan.items = [item];
    await workspace.writeWorkingSelectors(JSON.stringify(plan));
    expect(migrateTargetSelectorPlanForAuthoring(plan).plan.items[0]!.fields.requirement.composition).toBe('semantic_summary');
    const controller = await ToolController.create(workspace);
    const paths = [workspace.workingSelectorPath, workspace.sourceSpanRegistryPath, workspace.statePath];
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    const rejected = await controller.dispatch('stage_target_selector_draft', { draft: { items: [item] } });
    expect(rejected.ok).toBe(false);
    // The failed protocol attempt is counted; author data and source bindings are not changed.
    expect(await readFile(paths[0]!, 'utf8')).toBe(before[0]);
    expect(await readFile(paths[1]!, 'utf8')).toBe(before[1]);
    const read = await controller.dispatch('read_target_selectors', { collection: 'items', key: item.key });
    expect(JSON.stringify(read)).toContain('semantic_summary');
    const contract = await controller.dispatch('get_target_selector_contract', {});
    const fields = (contract.json_schema as any).properties.items.items.properties.fields.properties;
    expect(Check(fields.name.properties.composition, 'semantic_summary')).toBe(true);
    for (const field of ['requirement', 'method', 'quantity', 'note']) {
      expect(Check(fields[field].properties.composition, 'semantic_summary')).toBe(false);
      expect(Check(fields[field].properties.composition, 'reference')).toBe(true);
    }
    const stage = createPiTools(controller).find(tool => tool.name === 'stage_target_selector_draft')!;
    expect(JSON.stringify(stage.parameters)).not.toContain(TARGET_SELECTOR_PROTOCOLS.reference_routes);
  });

  test('all hierarchy roles distinguish source defaults from exact business members', () => {
    for (const prompt of [HIERARCHY_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain(HIERARCHY_ITEM_ASSIGNMENT_GUIDANCE);
      expect(prompt).toContain('item_selections');
      expect(prompt).toContain('全体封存项目恰好覆盖一次');
    }
  });
});
