import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { prettyJson, sha256Json, sha256Text } from '../src/canonical.js';
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from '../src/contracts.js';
import { buildGranularProseCoverageEvidence } from '../src/evidence.js';
import { resolveAndRegisterDocumentReference } from '../src/document-reference.js';
import { externalReferenceExpansionPolicy } from '../src/external-reference-policy.js';
import { registerSourceSpan } from '../src/source-span-registry.js';
import { compileTargetSelectors, initialTargetSelectorPlan } from '../src/target-selector-compiler.js';
import { hydrateSemanticSourcePlan } from '../src/plan-hydration.js';
import { materialize } from '../src/materializer.js';
import { validatePlanText } from '../src/validator.js';
import { ExternalSourcePause, normalizeStandardNo, standardIdentityMatches, standardNumberTokens } from '../src/external-source-workflow.js';
import { createPiTools, ToolController } from '../src/tools.js';
import { RevisionWorkspace } from '../src/workspace.js';

const roots: string[] = [];
const parent = resolve('.tmp-tests');
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(parent, 'external-source-workflow-'))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function scenario(fieldLabel?: string) {
  const citation = '应按《测试标准》XQ 902-2001第2.1.1条执行。';
  const cells = ['一般项目', '1', fieldLabel ?? '', citation];
  const origin = fieldLabel ? cells.join(' | ') : `3.1.1 验收判据${citation}`;
  const markdown = ['# 示例项目', '2.1.1 内部同号条款不能替代外部正文。', origin].join('\n');
  const records = buildGranularProseCoverageEvidence(markdown, sha256Text(markdown), [{ start_line: 3, end_exclusive_line: 4 }]);
  if (fieldLabel) Object.assign(records[0]!, { kind: 'table_row', role: 'formal_table_row', table_text_format: 'cell_values_v1',
    table_row_kind: 'data', row_index: 1, cells, columns: ['类别', '序号', '项目', '要求'] });
  const payload = { schema_version: EVIDENCE_SCHEMA_VERSION, job_id: 'external-workflow-test', target_id: 'target:example',
    source: { adapter: 'document-domain-agent/v1' as const, file_name: 'example.md', sha256: sha256Text(markdown), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: 'agent_discovered' as const, target_id: 'target:example',
      source_line_count: 3, selected_start_line: 3, selected_end_exclusive_line: 4, selected_heading: '示例项目',
      selection_reason: 'synthetic fixture', selected_atom_ids: records.map(row => row.evidence_id),
      target_evidence_fragments: records.map(row => ({ atom_id: row.evidence_id, text: row.text })), candidates: [] },
    evidence: records.map(row => ({ ...row, requires_disposition: true })), table_fragments: [], reference_occurrences: [],
  };
  const manifest: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'external-source-workflow-'));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  const controller = await ToolController.create(workspace);
  let originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  if (fieldLabel) {
    const record = records[0]!;
    const located = registerSourceSpan(await workspace.readSourceSpanRegistry(), { source_id: record.evidence_id,
      evidence_id: record.evidence_id, atom_id: record.atom_id ?? record.evidence_id, text: record.text }, origin.indexOf(citation), origin.length);
    await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(located.registry));
    originSpanId = located.span.span_id;
  }
  const request = { origin_span_id: originSpanId,
    origin_field: 'requirement', raw_reference: '《测试标准》XQ 902-2001第2.1.1条', standard_no: 'XQ 902-2001',
    target: { kind: 'clause', number: '2.1.1' }, relation: '真实外部判据引用',
    usage: 'content_required', dependent_fields: ['requirement'], reason: '本地条文明示判据由外部指定条款给出' };
  return { workspace, controller, request, manifest };
}

test('matches the specified edition from the document identity and normalizes OCR dashes', () => {
  expect(normalizeStandardNo('XQ 902—2001')).toBe('XQ902-2001');
  expect(standardIdentityMatches('# 测试标准\nXQ 902—2001\n# 正文', 'XQ902-2001')).toBe(true);
  expect(standardIdentityMatches('# 测试标准\nXQ902-2002\n# 正文', 'XQ902-2001')).toBe(false);
  expect(standardIdentityMatches('# 测试标准\nXQ902-20010\n# 正文', 'XQ902-2001')).toBe(false);
});

test('spaced alphabetic prefixes retain their complete standard identity', () => {
  const document = '# 通用测试标准\nXQ R34—2002\n# 正文';
  expect(standardNumberTokens('XQ R34—2002')).toEqual(['XQR34-2002']);
  expect(standardIdentityMatches(document, 'XQR34')).toBe(true);
  expect(standardIdentityMatches(document, 'XQR34-2002')).toBe(true);
  expect(standardIdentityMatches(document, 'XQR34-2001')).toBe(false);
  expect(standardIdentityMatches(document, 'XQR35')).toBe(false);
  expect(standardIdentityMatches('# 通用测试标准\nXQ R34—2001\n引用 XQ R34—2002。', 'XQR34-2002')).toBe(false);
  expect(standardNumberTokens('ZZ / T 902—2001')).toEqual(['ZZ/T902-2001']);
  expect(standardNumberTokens('Refer to XQ R34—2002')).toEqual(['XQR34-2002']);
});

test('ordinary compliance citation continues without demanding a document', async () => {
  const { controller, request } = await scenario();
  const lookup = vi.fn(), require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  const output = await controller.dispatch('resolve_external_standard_reference', { ...request, usage: 'citation_only' });
  expect(output).toMatchObject({ ok: true, status: 'external_reference_placeholder', content_available: false });
  expect(lookup).not.toHaveBeenCalled();
  expect(require).not.toHaveBeenCalled();
});

test.each(['构件尺寸允许偏差', '设计要求及规范规定', '质量检验标准'].flatMap(label => [false, true].map(available => ({ label, available }))))('requirement references never look up or request a document: $label, locally available=$available', async ({ label, available }) => {
  const { workspace, controller, request } = await scenario(label);
  const markdown = '# 测试标准\nXQ 902-2001\n2.1.1 这里的数值不能代替允许偏差原引用。';
  const lookup = vi.fn(async () => available ? { standard_no: request.standard_no, markdown, markdown_sha256: sha256Text(markdown) } : undefined);
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  const before = await workspace.readState();
  const result = await controller.dispatch('resolve_external_standard_reference', request);
  expect(result).toMatchObject({ ok: true, content_available: false, required_action: 'retain_allowable_deviation_reference_literal',
    external_standard: { usage: 'content_required', expansion: 'literal_only', expansion_reason: 'allowable_deviation_reference' } });
  const occurrence = (await workspace.readEvidenceManifest()).reference_occurrences.find(o => o.occurrence_id === result.occurrence_id)!;
  expect(occurrence).toMatchObject({ required: false, target_evidence_ids: [], external_standard: { expansion_reason: 'allowable_deviation_reference' } });
  await controller.dispatch('get_target_context', {});
  expect(lookup).not.toHaveBeenCalled();
  expect(require).not.toHaveBeenCalled();
  expect((await workspace.readState()).repair).toEqual(before.repair);
  const blocker = await controller.dispatch('report_target_blocker', { kind: 'missing_external_source', evidence_span_ids: [request.origin_span_id],
    affected_selector_paths: ['/items/0/fields/requirement'], explanation: '虚构允许偏差引用没有展开。' });
  expect(blocker).toMatchObject({ ok: false, terminal: false, budget_consumed: false, error: 'external_reference_expansion_limited' });
});

test('a whole-row origin still applies the policy to its unique exact citation', async () => {
  const { workspace, controller, request } = await scenario('允许偏差');
  const full = (await workspace.readSourceSpanRegistry()).spans.find(s => s.start === 0)!.span_id;
  const lookup = vi.fn(), require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  expect(await controller.dispatch('resolve_external_standard_reference', { ...request, origin_span_id: full }))
    .toMatchObject({ ok: true, required_action: 'retain_allowable_deviation_reference_literal' });
  expect(lookup).not.toHaveBeenCalled();
  expect(require).not.toHaveBeenCalled();
});

test.each([false, true])('acceptance-basis field still requires the exact original despite an allowance claim: available=%s', async available => {
  const { workspace, controller, request } = await scenario('验收依据');
  const markdown = '# 测试标准\nXQ 902-2001\n2.1.1 合成验收依据应核对记录。';
  const lookup = vi.fn(async () => available ? { standard_no: request.standard_no, markdown, markdown_sha256: sha256Text(markdown) } : undefined), require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  const result = await controller.dispatch('resolve_external_standard_reference', { ...request, reason: '允许偏差，无需钻取' });
  expect(result).toMatchObject(available ? { ok: true, content_available: true } : { ok: true, status: 'waiting_for_source' });
  expect(lookup).toHaveBeenCalledExactlyOnceWith(request.standard_no);
  expect(require).toHaveBeenCalledTimes(available ? 0 : 1);
  expect((await workspace.readEvidenceManifest()).reference_occurrences[0]!.external_standard).not.toHaveProperty('expansion');
});

test('an allowance reference delivers the literal in its original field without verified external content', async () => {
  const { workspace, controller, request } = await scenario('允许偏差');
  controller.externalSourceWorkflow = { lookup: vi.fn(), require: vi.fn() };
  const receipt = await controller.dispatch('resolve_external_standard_reference', request);
  const evidence = await workspace.readEvidenceManifest();
  const record = evidence.evidence[0]!;
  const nameStart = record.text.indexOf('允许偏差');
  const named = registerSourceSpan(await workspace.readSourceSpanRegistry(), { source_id: record.evidence_id,
    evidence_id: record.evidence_id, atom_id: record.atom_id ?? record.evidence_id, text: record.text }, nameStart, nameStart + '允许偏差'.length);
  const registry = named.registry;
  const selectors = initialTargetSelectorPlan(evidence);
  const full = registry.spans.find(s => s.start === 0 && s.end === evidence.evidence[0]!.text.length)!.span_id;
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? 'verbatim' as const : 'not_applicable' as const, span_ids, separator: '', reason: '虚构原文字段。' });
  selectors.lots.push({ key: 'lot', name: '示例构件', scope_span_ids: [full], reason: '合成测试范围。' });
  selectors.items.push({ key: 'dimension', lot_key: 'lot', name: '构件偏差', category: '一般项目', criterion_span_ids: [full], continuation_span_ids: [],
    fields: { name: { ...field([named.span.span_id]), composition: 'semantic_summary' }, requirement: { ...field([request.origin_span_id]), composition: 'reference' }, method: field([]), quantity: field([]), note: field([]) },
    table: { source_kind: 'direct', table_key: 'synthetic-table', reference_span_ids: [], reason: '虚构原表行。',
      properties: { table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [], row_path_span_ids: [[named.span.span_id]],
        column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [request.origin_span_id], inspection_method_span_ids: [] } },
    inspection_data_type: 'review', inspection_data_type_reason: '合成引用项目。', inspection_data_type_span_ids: [request.origin_span_id],
    sampling: { status: 'fallback', rule_key: '', branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: '没有抽样数量。', confidence: 1 }, reason: '保留原文允许偏差引用。' });
  selectors.references.push({ key: 'ref', occurrence_id: receipt.occurrence_id as string,
    anchor_span_ids: receipt.reference_literal_span_ids as string[], target_span_ids: [], action: 'keep_reference', application_mode: 'reference_only',
    origin_binding: { item_key: 'dimension', target_field: 'requirement' }, import_scope: { mode: 'field_specific', allowed_fields: ['requirement'], reason: '保留实际原字段。' },
    destinations: [{ item_key: 'dimension', target_field: 'requirement' }], reason: '允许偏差引用只保留原文。' });
  const plan = hydrateSemanticSourcePlan(compileTargetSelectors(selectors, registry, evidence), evidence);
  expect(validatePlanText(prettyJson(plan), evidence)).toMatchObject({ ok: true, issues: [] });
  const item = materialize(plan, evidence, 'fictional-field-policy').result.inspection_lots[0]!.items[0]!;
  expect(item.requirement).toBe('应按《测试标准》XQ 902-2001第2.1.1条执行。');
  expect(item.inline_references?.[0]).toMatchObject({ field: 'requirement', resolved_content: { records: [] },
    external_standard: { usage: 'content_required', status: 'placeholder', expansion: 'literal_only', expansion_reason: 'allowable_deviation_reference' } });
});

test('a legacy allowance placeholder gains policy metadata without changing its literal, usage or identity', async () => {
  const { workspace, controller, request } = await scenario('允许偏差');
  await resolveAndRegisterDocumentReference(workspace, await workspace.readEvidenceManifest(), { ...request,
    origin_field: 'requirement', target: { source_id: 'external-standard:XQ902-2001', kind: 'clause', number: '2.1.1' },
    external_standard: { standard_no: request.standard_no, status: 'placeholder', usage: 'content_required' } });
  const old = (await workspace.readEvidenceManifest()).reference_occurrences[0]!;
  controller.externalSourceWorkflow = { lookup: vi.fn(), require: vi.fn() };
  const result = await controller.dispatch('resolve_external_standard_reference', request);
  expect(result).toMatchObject({ ok: true, required_action: 'retain_allowable_deviation_reference_literal' });
  const current = (await workspace.readEvidenceManifest()).reference_occurrences.find(o => o.occurrence_id === old.occurrence_id)!;
  expect(current).toEqual({ ...old, external_standard: { ...old.external_standard, expansion: 'literal_only', expansion_reason: 'allowable_deviation_reference' } });
});

test('a real content dependency persists a file request and retains the working checkpoint', async () => {
  const { controller, workspace, request } = await scenario();
  const before = await workspace.readState();
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup: async () => undefined, require };
  const output = await controller.dispatch('resolve_external_standard_reference', request);
  expect(output).toMatchObject({ ok: true, status: 'waiting_for_source', terminal: false, budget_consumed: false,
    waiting_for_source: { standard_no: 'XQ 902-2001', target_id: 'target:example', dependent_fields: ['requirement'] } });
  expect(require).toHaveBeenCalledWith(expect.objectContaining({ occurrence_id: output.occurrence_id, origin_excerpt: expect.stringContaining('XQ 902-2001') }));
  const after = await workspace.readState();
  expect(after.status).toBe(before.status);
  expect(after.repair).toEqual(before.repair);
  expect(after.next_history_sequence).toBe(before.next_history_sequence);
});

test('supplying correct source resolves actual external evidence and retires the missing placeholder', async () => {
  const { controller, workspace, request, manifest } = await scenario();
  controller.externalSourceWorkflow = { lookup: async () => undefined, require: async () => {} };
  const missing = await controller.dispatch('resolve_external_standard_reference', request);
  const markdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 示例项应符合设计要求。\n检验方法：核查设计文件。';
  controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: request.standard_no, markdown, markdown_sha256: sha256Text(markdown) }), require: async () => { throw new Error('source exists'); } };
  const receipt = await controller.dispatch('resolve_external_standard_reference', request);
  expect(receipt).toMatchObject({ ok: true, content_available: true, external_standard: { status: 'resolved', markdown_sha256: sha256Text(markdown) } });
  const current = await workspace.readEvidenceManifest();
  expect(current.source).toEqual(manifest.source);
  expect(current.reference_occurrences.some(row => row.occurrence_id === missing.occurrence_id)).toBe(false);
  const occurrence = current.reference_occurrences.find(row => row.occurrence_id === receipt.occurrence_id)!;
  const texts = current.evidence.filter(row => occurrence.target_evidence_ids.includes(row.evidence_id)).map(row => row.text).join('\n');
  expect(texts).toContain('示例项应符合设计要求');
  expect(texts).not.toContain('内部同号');
  expect(occurrence.external_standard?.status).toBe('resolved');
  expect(occurrence.target_evidence_ids.length).toBeGreaterThan(0);
});

test.each([
  { name: 'a different target with the same usage', firstTarget: { kind: 'clause', number: '2.1.2' }, firstUsage: 'content_required' },
  { name: 'the same target with a different usage', firstTarget: { kind: 'clause', number: '2.1.1' }, firstUsage: 'citation_only' },
  { name: 'a whole-standard citation beside a precise content dependency', firstTarget: undefined, firstUsage: 'citation_only' },
])('resolving external content preserves $name', async ({ firstTarget, firstUsage }) => {
  const { controller, workspace, request } = await scenario();
  controller.externalSourceWorkflow = { lookup: async () => undefined, require: async () => {} };
  const earlier = await controller.dispatch('resolve_external_standard_reference', {
    ...request, target: firstTarget, usage: firstUsage,
  });
  expect(earlier.ok).toBe(true);
  const before = await workspace.readEvidenceManifest();
  const earlierOccurrence = before.reference_occurrences.find(row => row.occurrence_id === earlier.occurrence_id)!;
  expect(earlierOccurrence).toMatchObject({ status: 'target_not_found', external_standard: { usage: firstUsage } });
  const markdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 示例项应符合设计要求。\n2.1.2 另一项应核查标识。';
  controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: request.standard_no, markdown, markdown_sha256: sha256Text(markdown) }), require: async () => { throw new Error('source exists'); } };
  const receipt = await controller.dispatch('resolve_external_standard_reference', request);
  expect(receipt).toMatchObject({ ok: true, content_available: true });
  expect(receipt.superseded_occurrence_ids ?? []).not.toContain(earlier.occurrence_id);
  const current = await workspace.readEvidenceManifest();
  expect(current.reference_occurrences.find(row => row.occurrence_id === earlier.occurrence_id)).toEqual(earlierOccurrence);
  expect(current.reference_occurrences.find(row => row.occurrence_id === receipt.occurrence_id)).toMatchObject({
    status: 'resolved', external_standard: { usage: 'content_required' },
    target_address: { locator_kind: 'clause', locator: 'clause:2.1.1' },
  });
});

test.each(['missing', 'ready', 'wrong_edition', 'tampered'])('a nested reference checks local sources and retains only the literal when unusable (local=%s)', async local => {
  const { controller, workspace, request } = await scenario();
  const firstMarkdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 验收应按《下级标准》XQ 903-2001第4.1.1条执行。';
  const secondMarkdown = '# 下级标准\n' + (local === 'wrong_edition' ? 'XQ 903-2002' : 'XQ 903-2001') + '\n# 4 示例章节\n## 4.1 示例条款\n4.1.1 示例条文需按相关性判断采用。';
  const lookup = vi.fn(async (standardNo: string) => standardNo === request.standard_no
    ? { standard_no: standardNo, markdown: firstMarkdown, markdown_sha256: sha256Text(firstMarkdown) }
    : local !== 'missing' ? { standard_no: standardNo, markdown: secondMarkdown, markdown_sha256: local === 'tampered' ? '0'.repeat(64) : sha256Text(secondMarkdown) } : undefined);
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  const first = await controller.dispatch('resolve_external_standard_reference', request);
  expect(first).toMatchObject({ ok: true, content_available: true });
  const before = await workspace.readEvidenceManifest();
  const nestedOrigin = before.evidence.find(row => row.text.includes('《下级标准》'))!;
  const originSpan = (await workspace.readSourceSpanRegistry()).spans.find(span => span.evidence_id === nestedOrigin.evidence_id)!;
  const policy = externalReferenceExpansionPolicy(before, [nestedOrigin.evidence_id], { standard_no: 'XQ 903-2001' });
  expect(policy).toMatchObject({ nested_external: true, origin_status: 'external' });
  expect(externalReferenceExpansionPolicy(before, [nestedOrigin.evidence_id], { standard_no: request.standard_no })).toMatchObject({ nested_external: false, same_document: true });
  expect(externalReferenceExpansionPolicy(before, [nestedOrigin.evidence_id], { source_sha256: sha256Text(firstMarkdown) })).toMatchObject({ nested_external: false, same_document: true });
  const rootOrigin = before.reference_occurrences.find(row => row.occurrence_id === first.occurrence_id)!.origin_evidence_id;
  expect(externalReferenceExpansionPolicy(before, [rootOrigin], { standard_no: 'XQ 903-2001' })).toMatchObject({ nested_external: false, origin_status: 'root' });
  expect(externalReferenceExpansionPolicy(before, [rootOrigin, nestedOrigin.evidence_id])).toMatchObject({ nested_external: false, origin_status: 'mixed' });
  expect(externalReferenceExpansionPolicy(before, ['invented'])).toMatchObject({ nested_external: false, origin_status: 'unverified' });
  const stateBefore = await workspace.readState();
  lookup.mockClear();
  const retained = await controller.dispatch('resolve_external_standard_reference', {
    origin_span_id: originSpan.span_id, origin_field: 'requirement', raw_reference: '《下级标准》XQ 903-2001第4.1.1条',
    standard_no: 'XQ 903-2001', target: { kind: 'clause', number: '4.1.1' }, relation: '已接入外部正文中的后续引用',
    usage: 'content_required', dependent_fields: ['requirement'], reason: '保留外部原句指向的后续规范原话',
  });
  expect(lookup).toHaveBeenCalledExactlyOnceWith('XQ 903-2001');
  expect(require).not.toHaveBeenCalled();
  if (local === 'ready') {
    expect(retained).toMatchObject({ ok: true, content_available: true, external_standard: { usage: 'content_required', status: 'resolved' } });
    const resolved = (await workspace.readEvidenceManifest()).reference_occurrences.find(row => row.occurrence_id === retained.occurrence_id)!;
    expect(resolved.target_evidence_ids.length).toBeGreaterThan(0);
    expect(resolved.external_standard?.expansion).toBeUndefined();
    return;
  }
  expect(retained).toMatchObject({ ok: true, status: 'external_reference_placeholder', content_available: false,
    external_standard: { usage: 'content_required', status: 'placeholder', expansion: 'literal_only', expansion_reason: 'nested_source_unavailable' },
    expansion_policy: { nested_external: true, literal_only: true, local_source_available: false, origin_source_sha256: sha256Text(firstMarkdown), parent_occurrence_ids: [first.occurrence_id] },
    target_evidence_ids: [], target_span_ids: [] });
  const after = await workspace.readEvidenceManifest();
  expect(after.evidence).toEqual(before.evidence);
  expect(after.reference_occurrences.find(row => row.occurrence_id === retained.occurrence_id)).toMatchObject({
    status: 'target_not_found', required: false, target_evidence_ids: [], raw_reference: '《下级标准》XQ 903-2001第4.1.1条',
    external_standard: { usage: 'content_required', expansion: 'literal_only' },
  });
  const stateAfter = await workspace.readState();
  expect(stateAfter.repair).toEqual(stateBefore.repair);
  expect(stateAfter.opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
});

test('wrong edition or changed bytes never resolve as available evidence', async () => {
  const { controller, request } = await scenario();
  const markdown = '# 测试标准\nXQ 902-2002\n# 2 示例章节\n2.1.1 其他版本内容。';
  controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: request.standard_no, markdown, markdown_sha256: sha256Text(markdown) }), require: async () => {} };
  expect(await controller.dispatch('resolve_external_standard_reference', request)).toMatchObject({ ok: false, error: 'external_document_identity_mismatch' });
  const right = markdown.replace('2002', '2001');
  controller.externalSourceWorkflow = { lookup: async () => ({ standard_no: request.standard_no, markdown: right, markdown_sha256: sha256Text(markdown) }), require: async () => {} };
  expect(await controller.dispatch('resolve_external_standard_reference', request)).toMatchObject({ ok: false, error: 'external_document_identity_mismatch' });
});

test('real model tools expose the source workflow in every selector stage only when configured', async () => {
  const { controller } = await scenario();
  expect(createPiTools(controller).map(tool => tool.name)).not.toContain('resolve_external_standard_reference');
  controller.externalSourceWorkflow = { lookup: async () => undefined, require: async () => {} };
  expect(createPiTools(controller).map(tool => tool.name)).toContain('resolve_external_standard_reference');
  expect(controller.selectorProviderPolicy().allowed_tools).toContain('resolve_external_standard_reference');
});


test('whole-batch waiting drains in-flight writes before reporting the paused state', async () => {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'external-source-workflow-'));
  roots.push(root);
  const checkpoint = join(root, 'checkpoint.txt');
  await writeFile(checkpoint, 'before', 'utf8');
  const pause = new ExternalSourcePause();
  let release!: () => void;
  const writeAllowed = new Promise<void>(done => { release = done; });
  const worker = (async () => {
    await new Promise<void>(done => pause.signal.addEventListener('abort', () => done(), { once: true }));
    await writeAllowed;
    await writeFile(checkpoint, 'last atomic save', 'utf8');
    throw pause.signal.reason;
  })();
  const request = { standard_no: 'XQ 1-2001', target_id: 'target:one', occurrence_id: 'reference:one',
    origin_excerpt: 'synthetic source dependency', origin_locator: 'line:1', dependent_fields: ['method' as const], reason: 'synthetic method dependency' };
  pause.pause(request);
  let finished = false;
  const result = pause.finish([worker, Promise.reject(pause.signal.reason)]).then(value => { finished = true; return value; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(await readFile(checkpoint, 'utf8')).toBe('before');
  release();
  expect(await result).toEqual(request);
  expect(await readFile(checkpoint, 'utf8')).toBe('last atomic save');
});

test('explicit cancellation wins over a concurrent source pause', async () => {
  const parent = new AbortController();
  const pause = new ExternalSourcePause(parent.signal);
  pause.pause({ standard_no: 'XQ 1-2001', target_id: 'target:one', occurrence_id: 'reference:one',
    origin_excerpt: 'synthetic', origin_locator: 'line:1', dependent_fields: ['method'], reason: 'synthetic' });
  parent.abort(new Error('explicit cancellation'));
  await expect(pause.finish([])).rejects.toThrow('explicit cancellation');
});

test('a different standard in the opening identity cannot be replaced by a later citation', () => {
  expect(standardIdentityMatches('# 示例标准\nXQ900-2002\n引用 XQ900-2001。', 'XQ900-2001')).toBe(false);
  expect(standardIdentityMatches('# 示例标准\nXQ1-2001\n# 2 正文', 'XQ1-2001')).toBe(true);
});


test.each(['ZZ12/T-345-2001', 'ZZ12 / T — 345 — 2001'])('regional-series code is not truncated: %s', text => {
  expect(standardNumberTokens(text)).toEqual(['ZZ12/T-345-2001']);
  expect(standardIdentityMatches('# 合成标准\n' + text, 'ZZ12/T-345-2001')).toBe(true);
  expect(standardIdentityMatches('# 合成标准\n' + text, 'ZZ13/T-345-2001')).toBe(false);
  expect(standardIdentityMatches('# 合成标准\n' + text, 'ZZ12/T-346-2001')).toBe(false);
  expect(standardIdentityMatches('# 合成标准\n' + text, 'ZZ12/T-345-2002')).toBe(false);
});

test('a later numeric bullet is not part of the declared standard code', () => {
  expect(standardNumberTokens('ZZ12/T-345-2001\n- 2 合成说明')).toEqual(['ZZ12/T-345-2001']);
});


test('a legacy nested placeholder gains only policy metadata and upgrades when a local source later appears', async () => {
  const { workspace, controller, request } = await scenario();
  const firstMarkdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 应按《下级标准》XQ 903-2001第4.1.1条执行。';
  const secondMarkdown = '# 下级标准\nXQ 903-2001\n# 4 示例章节\n## 4.1 示例条款\n4.1.1 示例项应核查记录。';
  let nextReady = false;
  const lookup = vi.fn(async (standardNo: string) => standardNo === request.standard_no
    ? { standard_no: standardNo, markdown: firstMarkdown, markdown_sha256: sha256Text(firstMarkdown) }
    : nextReady ? { standard_no: standardNo, markdown: secondMarkdown, markdown_sha256: sha256Text(secondMarkdown) } : undefined);
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  await controller.dispatch('resolve_external_standard_reference', request);
  const manifest = await workspace.readEvidenceManifest();
  const origin = manifest.evidence.find(row => row.text.includes('《下级标准》'))!;
  const originSpan = (await workspace.readSourceSpanRegistry()).spans.find(span => span.evidence_id === origin.evidence_id)!;
  const nested = { origin_span_id: originSpan.span_id, origin_field: 'requirement' as const,
    raw_reference: '《下级标准》XQ 903-2001第4.1.1条', standard_no: 'XQ 903-2001',
    target: { kind: 'clause' as const, number: '4.1.1' }, relation: '合成后续引用',
    usage: 'content_required', dependent_fields: ['requirement'], reason: '保留真实后续引用原句' };
  const legacy = await resolveAndRegisterDocumentReference(workspace, manifest, { ...nested,
    target: { ...nested.target, source_id: 'external-standard:XQ903-2001' },
    external_standard: { standard_no: nested.standard_no, status: 'placeholder', usage: 'content_required' },
  });
  const restored = await ToolController.create(workspace);
  restored.externalSourceWorkflow = { lookup, require };
  const before = await workspace.readEvidenceManifest();
  const original = before.reference_occurrences.find(row => row.occurrence_id === legacy.occurrence_id)!;
  expect(original.external_standard?.expansion).toBeUndefined();
  const selectorBefore = await readFile(workspace.workingSelectorPath, 'utf8');
  lookup.mockClear();
  const legacyContext = await restored.dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(legacyContext.external_reference_sources).toEqual(expect.arrayContaining([expect.objectContaining({
    occurrence_id: legacy.occurrence_id, source_status: 'policy_limited', next_tool: 'resolve_external_standard_reference',
  })]));
  expect(lookup).toHaveBeenCalledWith(nested.standard_no);
  const retained = await restored.dispatch('resolve_external_standard_reference', nested);
  expect(retained).toMatchObject({ ok: true, occurrence_id: legacy.occurrence_id,
    external_standard: { expansion: 'literal_only', expansion_reason: 'nested_source_unavailable' } });
  const saved = (await workspace.readEvidenceManifest()).reference_occurrences.find(row => row.occurrence_id === legacy.occurrence_id)!;
  expect(saved).toEqual({ ...original, external_standard: { ...original.external_standard,
    expansion: 'literal_only', expansion_reason: 'nested_source_unavailable' } });
  const markedContext = await restored.dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(markedContext.external_reference_sources).toEqual(expect.arrayContaining([expect.objectContaining({
    occurrence_id: legacy.occurrence_id, source_status: 'policy_limited', next_tool: 'read_target_selectors',
  })]));
  nextReady = true;
  const readyContext = await restored.dispatch('get_target_context', { cursor: 0, limit: 1 });
  expect(readyContext.external_reference_sources).toEqual(expect.arrayContaining([expect.objectContaining({
    occurrence_id: legacy.occurrence_id, source_status: 'ready', next_tool: 'resolve_external_standard_reference',
  })]));
  const resolved = await restored.dispatch('resolve_external_standard_reference', nested);
  expect(resolved).toMatchObject({ ok: true, content_available: true, superseded_occurrence_ids: [legacy.occurrence_id] });
  const after = await workspace.readEvidenceManifest();
  expect(after.reference_occurrences.some(row => row.occurrence_id === legacy.occurrence_id)).toBe(false);
  expect(after.reference_occurrences.find(row => row.occurrence_id === resolved.occurrence_id)?.external_standard?.expansion).toBeUndefined();
  expect(require).not.toHaveBeenCalled();
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(selectorBefore);
});

test('an explicit reference within the same external document remains a normal source read', async () => {
  const { workspace, controller, request } = await scenario();
  const markdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 应按《测试标准》XQ 902-2001第2.1.2条执行。\n2.1.2 示例项应核查记录。';
  const lookup = vi.fn(async (standardNo: string) => ({ standard_no: standardNo, markdown, markdown_sha256: sha256Text(markdown) }));
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  await controller.dispatch('resolve_external_standard_reference', request);
  const manifest = await workspace.readEvidenceManifest();
  const origin = manifest.evidence.find(row => row.text.includes('第2.1.2条'))!;
  const span = (await workspace.readSourceSpanRegistry()).spans.find(row => row.evidence_id === origin.evidence_id)!;
  lookup.mockClear();
  const receipt = await controller.dispatch('resolve_external_standard_reference', { ...request,
    origin_span_id: span.span_id, raw_reference: '《测试标准》XQ 902-2001第2.1.2条', target: { kind: 'clause', number: '2.1.2' },
  });
  expect(receipt).toMatchObject({ ok: true, content_available: true, external_standard: { status: 'resolved' } });
  expect(lookup).toHaveBeenCalledExactlyOnceWith(request.standard_no);
  expect(require).not.toHaveBeenCalled();
  const current = await workspace.readEvidenceManifest();
  const occurrence = current.reference_occurrences.find(row => row.occurrence_id === receipt.occurrence_id)!;
  expect(externalReferenceExpansionPolicy(current, [occurrence.origin_evidence_id], {
    standard_no: occurrence.external_standard!.standard_no, source_sha256: occurrence.target_address?.source_id,
  })).toMatchObject({ nested_external: false, same_document: true });
});

test('mixed root and external origins are rejected before lookup or a file request', async () => {
  const { workspace, controller, request } = await scenario();
  const markdown = '# 测试标准\nXQ 902-2001\n# 2 示例章节\n## 2.1 示例条款\n2.1.1 应按《下级标准》XQ 903-2001执行。';
  const lookup = vi.fn(async (standardNo: string) => ({ standard_no: standardNo, markdown, markdown_sha256: sha256Text(markdown) }));
  const require = vi.fn();
  controller.externalSourceWorkflow = { lookup, require };
  await controller.dispatch('resolve_external_standard_reference', request);
  const manifest = await workspace.readEvidenceManifest();
  const origin = manifest.evidence.find(row => row.text.includes('《下级标准》'))!;
  const span = (await workspace.readSourceSpanRegistry()).spans.find(row => row.evidence_id === origin.evidence_id)!;
  lookup.mockClear();
  const receipt = await controller.dispatch('resolve_external_standard_reference', { ...request,
    origin_span_id: undefined, origin_span_ids: [request.origin_span_id, span.span_id],
    raw_reference: '《下级标准》XQ 903-2001', standard_no: 'XQ 903-2001', target: undefined,
  });
  expect(receipt).toMatchObject({ ok: false, error: 'reference_origin_crosses_documents', budget_consumed: false });
  expect(lookup).not.toHaveBeenCalled();
  expect(require).not.toHaveBeenCalled();
  expect(await workspace.readEvidenceManifest()).toEqual(manifest);
});
