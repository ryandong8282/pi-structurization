import { readFile, rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  PROMPT_SUITE_VERSION, TARGET_SELECTOR_PROTOCOLS, TARGET_SELECTOR_SYSTEM_PROMPT,
  targetSelectorStartupPrompt, targetLengthContinuationPrompt, targetCompletedContinuationPrompt,
  HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT,
} from '../src/acceptance-prompt-suite.js';
import { withFeedbackText } from '../src/acceptance-feedback-text.js';
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from '../src/acceptance-tool-text.js';
import { createPiTools, ToolController } from '../src/tools.js';
import { createDocumentDiscoveryTools, type DocumentDiscoveryController } from '../src/document-discovery.js';
import { createReferenceAnalysisTools, type ReferenceAnalysisController } from '../src/reference-analysis.js';
import { createEditorHierarchyTools, type EditorHierarchyController } from '../src/editor-hierarchy.js';
import { buildSelectorStageScenario } from './selector-stage-fixture.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ModelSourceHandles, SOURCE_HANDLE_BOUND_CONTRACT, SOURCE_HANDLE_SESSION_ENTRY } from '../src/model-source-handles.js';

describe('whole Acceptance prompt suite integration', () => {
  test('a protocol-only provider restart retains stagnation history, repair counts and budgets', async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    try {
      await workspace.transactState(state => {
        state.repair.non_converging_rounds = 3;
        state.repair.repair_session_restarts = 2;
        state.repair.selector_fingerprint = 'f'.repeat(64);
      });
      const before = await workspace.readState();
      await controller.beginFreshRepairSession('protocol_migration');
      const after = await workspace.readState();
      expect(after.repair).toEqual({ ...before.repair, fresh_session_required: false, session_epoch: before.repair.session_epoch + 1 });
      expect(after).toEqual({ ...before, repair: after.repair });
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('the session-bound tool declarations and complete author contract agree on source ownership', async () => {
    const { workspace, controller } = await buildSelectorStageScenario();
    try {
      const handles = await ModelSourceHandles.open(workspace.root), session = SessionManager.inMemory(workspace.root);
      session.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY, { scope: handles.scope, tool_contract: SOURCE_HANDLE_BOUND_CONTRACT });
      const originals = createPiTools(controller), tools = await handles.wrapSessionTools(originals, session);
      for (let i = 0; i < tools.length; i++) {
        const schema = tools[i]!.parameters as any, original = originals[i]!.parameters as any;
        expect(Object.keys(schema.properties), tools[i]!.name).toEqual(Object.keys(original.properties));
        expect(schema.required, tools[i]!.name).toEqual(original.required);
        expect(schema.additionalProperties, tools[i]!.name).toEqual(original.additionalProperties);
        expect(schema.properties).not.toHaveProperty('source_handle_scope');
        expect(JSON.stringify(schema)).not.toContain(handles.scope);
      }
      const contract = tools.find(t => t.name === 'get_target_selector_contract')!;
      const reply = await contract.execute('contract', {}, undefined as any, undefined as any, undefined as any);
      const content = reply.content.map(b => b.type === 'text' ? b.text : '').join('\n');
      const protocols = JSON.parse(content).authoring_protocols;
      expect(protocols.source_handles).toContain('模型不传 source_handle_scope');
      expect(protocols.patch).toContain('不传 source_handle_scope');
      expect(content).not.toMatch(/(?:携带|复制)[^。；\n]{0,25}source_handle_scope/u);
      expect(content).not.toContain(handles.scope);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('the real contract returns all on-demand protocols without changing author data or budgets', async () => {
    const { workspace } = await buildSelectorStageScenario([
      '# 2 虚构器件', '', '## 2.1 包装封口', '',
      '2.1.1 封口应平顺。检查方法：观察。检验数量：每批抽查7件。', '',
    ].join('\n'));
    try {
      const controller = await ToolController.create(workspace);
      const files = [workspace.sourceSpanRegistryPath, workspace.evidenceManifestPath, workspace.sourceMarkdownPath];
      const before = await Promise.all(files.map(file => readFile(file)));
      const { next_event_sequence: _before, ...stateBefore } = await workspace.readState();
      const response = await controller.dispatch('get_target_selector_contract', {});
      expect(response).toMatchObject({ ok: true, prompt_protocol_version: PROMPT_SUITE_VERSION,
        authoring_protocols: TARGET_SELECTOR_PROTOCOLS, json_schema: expect.any(Object),
        blank_plan: expect.any(Object), submission_protocol: expect.any(Object) });
      expect(Object.keys(response.authoring_protocols as object).sort()).toEqual([
        'source_handles', 'source_access', 'field_roles', 'fields', 'names_and_category',
        'references', 'reference_routes', 'tables', 'branches', 'sampling', 'patch', 'diagnostics', 'lifecycle',
      ].sort());
      for (const protocol of Object.values(response.authoring_protocols as object)) {
        expect(typeof protocol).toBe('string');
        expect(protocol.length).toBeGreaterThan(30);
      }
      expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before);
      const { next_event_sequence: _after, ...stateAfter } = await workspace.readState();
      expect(stateAfter).toEqual(stateBefore);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('every active tool description uses the centrally reviewed suite', () => {
    // Metadata only: these stubs cannot execute tools or mutate a workspace.
    const tools = [
      ...createPiTools({ usesSelectorCompiler: true } as ToolController),
      ...['candidate', 'review'].flatMap(phase => createDocumentDiscoveryTools({ phase } as DocumentDiscoveryController)),
      ...createReferenceAnalysisTools({} as ReferenceAnalysisController),
      ...['candidate', 'review'].flatMap(phase => createEditorHierarchyTools({ phase } as EditorHierarchyController)),
    ];
    expect(tools.length).toBeGreaterThan(60);
    for (const tool of tools) {
      expect(ACCEPTANCE_TOOL_DESCRIPTIONS[tool.name], tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBe(ACCEPTANCE_TOOL_DESCRIPTIONS[tool.name]);
    }
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain('get_target_selector_contract');
  });

  test('known current work takes precedence over bulky historical navigation without deleting history', () => {
    const historical = { rows: Array.from({ length: 29 }, (_, i) => ({ key: `old-unrelated-${i}` })) };
    const frozenHistory = JSON.stringify(historical);
    const focus = [{ code: 'selector_sampling_decision_pending', path: '/items/7/sampling',
      record_read: { tool: 'read_target_selectors', arguments: { collection: 'items', key: 'current-item' } } }];
    const prompt = targetSelectorStartupPrompt({ job_id: 'neutral-job', target_id: 'neutral-target',
      resume: true, recovering_coverage_failure: false, current_selector_state: 'nonblank',
      current_selector_checkpoint: 'author_draft', resume_focus: focus,
      selector_blocker_handoff: '先完成 current-item 的当前抽样决定。', historical_repair_navigation: historical });
    expect(prompt).toContain('current-item');
    expect(prompt).toContain('read_target_selectors');
    expect(prompt).not.toContain('old-unrelated-');
    expect(JSON.stringify(historical)).toBe(frozenHistory);
  });

  test('a validated candidate goes straight to seal while an unverifiable blank resume is rejected', () => {
    const options = { job_id: 'neutral-job', target_id: 'neutral-target', resume: true,
      recovering_coverage_failure: false, current_selector_state: 'nonblank' };
    const prompt = targetSelectorStartupPrompt({ ...options, current_selector_checkpoint: 'validated_candidate',
      resume_focus: [{ code: 'stale-unrelated', path: '/items' }],
      historical_repair_navigation: { old: 'old-unrelated' } });
    expect(prompt).toContain('seal_validated_plan');
    expect(prompt).not.toContain('stale-unrelated');
    expect(prompt).not.toContain('old-unrelated');
    expect(() => targetSelectorStartupPrompt({ ...options, current_selector_state: 'blank' }))
      .toThrow('target_selector_resume_checkpoint_missing');
  });

  test('a resumed late stage without an exact current record reads fresh field diagnostics before historical directories', () => {
    const prompt = targetSelectorStartupPrompt({ job_id: 'neutral', target_id: 'neutral', resume: true,
      recovering_coverage_failure: false, current_selector_state: 'current_existing',
      inherited_stage_retry: { stage: 'table', best_stage_rank: 1, best_issue_count: 3, consecutive_non_improvements: 2 } });
    expect(prompt).toContain('get_target_context({field_diagnostic_cursor:0})');
    expect(prompt).toContain('不自动追加stage_diagnostic_cursor');
    expect(prompt).toContain('不消耗完整检查次数');
  });

  test('continuation keeps the whole objective and current work instead of inventing a new sample limit', () => {
    const length = targetLengthContinuationPrompt();
    const completed = targetCompletedContinuationPrompt({ stage: 'sampling', current_work: 'neutral-item-17',
      preflight_note: '当前只读快照有效。', blocking_summary: 'quantity 尚待决定。' });
    expect(length).toContain('持久化');
    expect(length).not.toContain('下一到两条');
    expect(completed).toContain('neutral-item-17');
    expect(completed).toContain('quantity 尚待决定');
    expect(completed).toContain('封存');
    expect(HIERARCHY_CONFIRM_SYSTEM_PROMPT).toMatch(/必[需要]原文/u);
    expect(HIERARCHY_CONFIRM_SYSTEM_PROMPT).toContain('不重新通读全部原子');
    expect(HIERARCHY_REVIEW_SYSTEM_PROMPT).toContain('全部原子');
  });

  test('typed diagnostic prose leaves structured evidence, author text and exact recovery parameters intact', () => {
    const payload = { ok: false, code: 'selector_neutral_missing_field', path: '/items/0/sampling',
      actual: { status: 'pending' }, expected: { status: ['explicit', 'reference'] },
      writable_paths: ['/items/0/sampling'], source_text: '原文 instruction 必须保留。',
      author_record: { reason: '作者的 fix-request 理由不改写。' },
      next_tool: 'read_target_selectors', next_tool_arguments: { collection: 'items', key: 'neutral-item-17' },
      terminal: false, budget_consumed: false, failure_count: 9,
      instruction: 'old mixed instruction' };
    const before = structuredClone(payload);
    const revised = withFeedbackText(payload, { kind: 'current_diagnostic', path: payload.path,
      actual: payload.actual, expected: payload.expected, writable_paths: payload.writable_paths,
      read: { tool: payload.next_tool, arguments: payload.next_tool_arguments } });
    expect(revised).toEqual({ ...before, instruction: expect.any(String) });
    expect(payload).toEqual(before);
    expect(revised.instruction).toContain('neutral-item-17');
    expect(revised.instruction).toContain('pending');
    expect(revised.instruction).toContain('explicit');
    const fault = withFeedbackText({ ...payload, terminal: true, writable_paths: [] },
      { kind: 'program_fault', writable_paths: [] });
    expect(fault).toMatchObject({ terminal: true, writable_paths: [], failure_count: 9 });
    expect(fault.instruction).toContain('不修改selector');
    const terminal = withFeedbackText(payload, { kind: 'phase_failed', terminal: true,
      retry: { tool: 'commit_target_selector_draft', arguments: { fingerprint: 'stale' } } });
    expect(terminal.instruction).not.toContain('commit_target_selector_draft');
  });
});
