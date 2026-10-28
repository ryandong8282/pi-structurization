import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ToolController } from '../src/tools.js';
import { targetSelectorStartupPrompt, targetCompletedContinuationPrompt } from '../src/acceptance-prompt-suite.js';
import { buildSelectorStageScenario } from './selector-stage-fixture.js';

describe('formal target scope handoff', () => {
  test.each([
    ['密封条连续性', '光学匣（壳体和观察窗）', '观察窗清晰度', '运输罩只用于包装，不属于运行部件'],
    ['支架连接', '循环装置（支架、管路和阀体）', '阀体密封性', '检修旁路在停机条件下单独检查'],
  ])('provider restart preserves the whole scope behind %s', async (title, subject, sibling, exception) => {
    const f = await buildSelectorStageScenario([
      '# 2 虚构装置', '', `## 2.1 ${title}`, '',
      `2.1.1 ${title}应满足设计要求。检查数量：每批3件。`, '',
      `2.1.2 ${sibling}应符合本节要求。检查数量：每批2件。`, '',
      `2.1.3 ${exception}。`, '',
    ].join('\n'));
    const basis = { subject, boundary_reason: `本对象包含${title}和${sibling}；${exception}。` };
    await writeFile(join(dirname(f.workspace.documentLedgerPath), 'document-target-plan.json'), JSON.stringify({
      targets: [{ target_id: f.manifest.target_id, semantic_basis: basis }],
    }));
    await f.workspace.transactState(s => { s.repair.non_converging_rounds = 2; s.repair.repair_session_restarts = 3; });
    const before = await f.workspace.readState(), draft = await readFile(f.workspace.workingSelectorPath, 'utf8');
    const handoff = await f.controller.selectorScopeHandoff();
    expect(handoff).toMatchObject({ frozen_semantic_basis: basis, source_sha256: f.manifest.source.sha256,
      target_scope: { selected_heading: f.manifest.scope.selected_heading,
        selection_reason: f.manifest.scope.selection_reason, primary_source_ranges: f.manifest.scope.primary_source_ranges } });
    const resumed = await ToolController.create(f.workspace);
    const restored = await resumed.selectorScopeHandoff();
    expect(restored).toEqual(handoff);
    for (const resume of [false, true]) {
      const text = targetSelectorStartupPrompt({ job_id: f.manifest.job_id, target_id: f.manifest.target_id,
        current_selector_state: 'current_existing', resume, recovering_coverage_failure: false, scope_handoff: restored });
      expect(text).toContain(subject); expect(text).toContain(sibling); expect(text).toContain(exception);
      expect(text.indexOf('<confirmed_target_scope>')).toBeLessThan(text.indexOf('已有记录不等于完成'));
    }
    const continuation = targetCompletedContinuationPrompt({ stage: 'table', scope_handoff: restored,
      next_step: { execution_state: 'authoring' }, current_work: { code: 'neutral-unresolved' } });
    expect(continuation).toContain(subject); expect(continuation).toContain(exception);
    expect(continuation).toContain('neutral-unresolved');
    expect(await f.workspace.readState()).toEqual(before);
    expect(await readFile(f.workspace.workingSelectorPath, 'utf8')).toBe(draft);
  });

  test('missing discovery archive retains the frozen scope rather than inventing a subject from the title', async () => {
    const f = await buildSelectorStageScenario();
    const handoff = await f.controller.selectorScopeHandoff();
    expect(handoff.frozen_semantic_basis).toBeNull();
    expect(handoff.target_scope).toMatchObject({ selection_reason: f.manifest.scope.selection_reason,
      primary_source_ranges: f.manifest.scope.primary_source_ranges });
    expect(handoff).not.toHaveProperty('items');
    expect(handoff).not.toHaveProperty('component_dispositions');
  });
});
