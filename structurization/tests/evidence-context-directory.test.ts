import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { Check } from 'typebox/value';
import { createPiTools } from '../src/tools.js';
import { buildSelectorStageScenario, clauseRecord } from './selector-stage-fixture.js';

const markdown = ['# 2 设备验收', '', '## 2.1 设备核查', '',
  '2.1.1 设备应核查下列内容：', '', '1 接口状态；', '', '2 标识状态。', '',
  '检验方法：核查记录。', '', '检查数量：全数核查。', '',
  '2.1.3 资料应妥善归档。', ''].join('\n');

test('same-clause metadata gives an executable paged source route without reading or changing author records', async () => {
  const { controller, workspace, manifest } = await buildSelectorStageScenario(markdown);
  const source = manifest.evidence.find(e => e.clause_id === '2.1.1' && e.text.startsWith('1 接口'))!;
  expect(source).toBeDefined();
  const tool = createPiTools(controller).find(t => t.name === 'list_evidence_resources')!;
  const args = { context_for_evidence_id: source.evidence_id, cursor: 0, limit: 2 };
  expect(Check(tool.parameters, args)).toBe(true);
  const before = { state: await workspace.readState(), registry: await workspace.readSourceSpanRegistry(),
    draft: await readFile(workspace.workingSelectorPath, 'utf8') };
  const expected = manifest.evidence.filter(e => e.evidence_scope === 'primary' && e.clause_id === source.clause_id);
  const ids: string[] = []; let cursor: number | null = 0; let pageCount = 0;
  do {
    const page = await controller.dispatch('list_evidence_resources', { ...args, cursor });
    pageCount += 1;
    expect(page).toMatchObject({ ok: true, budget_consumed: false, metadata_only: true,
      context: { basis: 'exact_primary_clause_id', clause_id: source.clause_id, resource_count: expected.length } });
    const resources = page.resources as any[];
    ids.push(...resources.map(r => r.evidence_id));
    expect(page.page_read_arguments).toEqual({ evidence_ids: resources.map(r => r.evidence_id) });
    expect(resources.every(r => !('text' in r) && !('cells' in r))).toBe(true);
    expect(JSON.stringify(page)).not.toContain('接口状态');
    cursor = page.next_cursor as number | null;
  } while (cursor !== null);
  expect(ids).toEqual(expected.map(e => e.evidence_id));
  expect(ids).not.toContain(clauseRecord(manifest, '2.1.3').evidence_id);
  expect(await workspace.readState()).toEqual({ ...before.state, next_event_sequence: before.state.next_event_sequence + 2 * pageCount });
  expect(await workspace.readSourceSpanRegistry()).toEqual(before.registry);
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(before.draft);
  const read = await controller.dispatch('batch_open_evidence', { evidence_ids: ids });
  expect(read.ok).toBe(true);
  expect((await workspace.readState()).opened_evidence_ids).toEqual(expect.arrayContaining(ids));
});

test('source diagnostics offer the context directory without declaring its neighbors required or semantically accepted', async () => {
  const { controller, workspace, manifest } = await buildSelectorStageScenario(markdown);
  const source = clauseRecord(manifest, '2.1.1');
  const before = { state: await workspace.readState(), registry: await workspace.readSourceSpanRegistry(),
    draft: await readFile(workspace.workingSelectorPath, 'utf8') };
  const issue = (await (controller as any).routeSelectorCompilerEvidenceReads([
    { code: 'compiler_unhandled_evidence', path: '/source_dispositions', details: { evidence_ids: [source.evidence_id] } },
  ]))[0];
  const navigation = issue.details.source_access[0].context_directory;
  expect(navigation).toEqual({ tool: 'list_evidence_resources',
    tool_arguments: { context_for_evidence_id: source.evidence_id, cursor: 0, limit: 24 },
    basis: 'exact_primary_clause_id' });
  const result = await controller.dispatch(navigation.tool, navigation.tool_arguments);
  expect(result).toMatchObject({ ok: true, metadata_only: true });
  expect(await workspace.readState()).toEqual({ ...before.state, next_event_sequence: before.state.next_event_sequence + 2 });
  expect(await workspace.readSourceSpanRegistry()).toEqual(before.registry);
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(before.draft);
});

test('isolated, unknown and unlabelled origins do not authorize a primary context directory', async () => {
  const { controller, manifest } = await buildSelectorStageScenario(markdown);
  const source = clauseRecord(manifest, '2.1.1');
  const access = vi.spyOn(controller as any, 'evidenceAccessIndex').mockResolvedValue(new Map([
    [source.evidence_id, { access_mode: 'isolated_reference', read_tool: 'read_reference_facts',
      open_evidence_allowed: false, target_key: 'reference-target:neutral' }],
  ]));
  const isolated = await controller.dispatch('list_evidence_resources', { context_for_evidence_id: source.evidence_id });
  expect(isolated).toMatchObject({ ok: false, error: 'evidence_context_directory_unavailable',
    next_tool: 'read_reference_facts', next_tool_arguments: { target_key: 'reference-target:neutral' } });
  expect(JSON.stringify(isolated)).not.toContain('2.1.1');
  access.mockRestore();
  expect(await controller.dispatch('list_evidence_resources', { context_for_evidence_id: 'invented' }))
    .toMatchObject({ ok: false, error: 'evidence_context_directory_unavailable' });
  const record = (controller as any).evidence.evidence.find((e: any) => e.evidence_id === source.evidence_id);
  record.clause_id = undefined;
  expect(await controller.dispatch('list_evidence_resources', { context_for_evidence_id: source.evidence_id }))
    .toMatchObject({ ok: false, error: 'evidence_context_directory_unavailable' });
});
