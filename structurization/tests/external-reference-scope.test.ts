import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { sha256Json, sha256Text } from '../src/canonical.js';
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, type EvidenceManifest } from '../src/contracts.js';
import { buildGranularProseCoverageEvidence } from '../src/evidence.js';
import { registerExternalStandardReference } from '../src/external-standard-reference.js';
import { resolveAndRegisterDocumentReference } from '../src/document-reference.js';
import { RevisionWorkspace } from '../src/workspace.js';
import { externalReferenceScopeFeedback } from '../src/external-reference-scope.js';
import { ToolController } from '../src/tools.js';
import { persistedManifestResumeMismatch } from '../src/batch.js';
import { resolvedReferenceComponentCoverageIssues } from '../src/reference-component-coverage.js';
import { initialTargetSelectorPlan, type TargetSelectorPlan } from '../src/target-selector-compiler.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const body = ['XQ 701-2099', '# 1 共用要求', '1.0.1 验收记录应完整。', '# 2 架体安装',
  '2.0.1 架体连接应牢固。检验方法：扳手检查。每批抽查4处。', '2.0.2 架体锚固应稳定。', '# 3 容器安装',
  '3.0.1 容器表面应完整。检验方法：观察。每批抽查7处。'].join('\n');
async function fixture() {
  const root = await mkdtemp(resolve('.tmp-tests-reference-scope-')); roots.push(root);
  const markdown = '9.1.1 架体应符合《示例部件验收标准》XQ 701-2099的规定。';
  const source = sha256Text(markdown);
  const records = buildGranularProseCoverageEvidence(markdown, source, [{ start_line: 1, end_exclusive_line: 2 }]);
  const base = { schema_version: EVIDENCE_SCHEMA_VERSION, job_id: 'neutral-reference', target_id: 'target:frame',
    source: { adapter: 'document-domain-agent/v1' as const, file_name: 'neutral.md', sha256: source },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: 'agent_discovered' as const, target_id: 'target:frame',
      source_line_count: 1, selected_start_line: 1, selected_end_exclusive_line: 2, selected_heading: '架体',
      selection_reason: '虚构目标', selected_atom_ids: records.map(r => r.evidence_id),
      target_evidence_fragments: records.map(r => ({atom_id:r.evidence_id,text:r.text})), candidates: [] },
    evidence: records.map(r => ({...r,requires_disposition:true})), table_fragments: [], reference_occurrences: [] };
  const manifest: EvidenceManifest = {...base,evidence_fingerprint:sha256Json(base)};
  const prepared = structuredClone(manifest);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {manifest,markdown:Buffer.from(markdown)});
  const document = {standard_no:'XQ 701-2099',markdown:body,markdown_sha256:sha256Text(body)};
  const workflow = {lookup:async()=>document,require:async()=>{throw new Error('Existing neutral source must not request a file');}};
  const input = {origin_span_id:(await workspace.readSourceSpanRegistry()).spans[0]!.span_id,origin_field:'requirement',
    raw_reference:'《示例部件验收标准》XQ 701-2099',standard_no:'XQ 701-2099',relation:'架体质量引用',
    usage:'content_required',dependent_fields:['requirement','method','sampling'],reason:'核对架体适用条款。'};
  const call = (patch:Record<string,unknown>={})=>registerExternalStandardReference(workspace,manifest,{...input,...patch},false,workflow);
  const legacy = ()=>resolveAndRegisterDocumentReference(workspace,manifest,{origin_span_id:input.origin_span_id,
    origin_field:'requirement',raw_reference:input.raw_reference,relation:input.relation,
    external_standard:{standard_no:document.standard_no,status:'resolved',usage:'content_required',markdown_sha256:document.markdown_sha256},
    target:{kind:'standard',number:document.standard_no,source_id:`external-standard:${document.standard_no}`}},false,document);
  return {root,workspace,manifest,prepared,input,call,legacy,document};
}

test('host-confirmed ignore retains an unresolved exact citation without reading or inventing external content',async()=>{
  const f=await fixture(); let lookups=0,requests=0;
  const decision={decision_id:'neutral-user-decision',standard_no:'XQ 701-2099',job_id:f.manifest.job_id,
    created_at:'2020-01-01T00:00:00.000Z',reason:'用户确认找不到原文，忽略正文获取'};
  const workflow={ignored:async()=>decision,lookup:async()=>{lookups++;return undefined;},require:async()=>{requests++;}};
  const beforeSource=await readFile(f.workspace.sourceMarkdownPath,'utf8');
  const out=await registerExternalStandardReference(f.workspace,f.manifest,f.input,false,workflow);
  expect(out).toMatchObject({ok:true,source_status:'ignored_by_user',content_available:false,
    external_standard:{status:'placeholder',usage:'content_required',expansion:'literal_only',expansion_reason:'user_ignored_source',user_ignore:decision}});
  expect(lookups).toBe(0);expect(requests).toBe(0);
  expect(f.manifest.reference_occurrences[0]).toMatchObject({raw_reference:f.input.raw_reference,target_evidence_ids:[],
    external_standard:{user_ignore:decision}});
  expect(await readFile(f.workspace.sourceMarkdownPath,'utf8')).toBe(beforeSource);
});

test('resumed whole-source context separates directory reading from actual business scope and offers exact correction identity',async()=>{
  const f=await fixture();const old=await f.legacy();
  const controller=await ToolController.create(f.workspace);
  controller.externalSourceWorkflow={lookup:async()=>f.document,require:async()=>{throw new Error('Already available')}};
  const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  expect(await controller.dispatch('get_target_context',{})).toMatchObject({external_reference_sources:[{
    source_status:'ready',resolved_component_count:f.manifest.reference_occurrences[0]!.target_evidence_ids.length,
    business_scope_review:{current_occurrence_id:old.occurrence_id,reader_skip_changes_business_scope:false,
      correction_arguments:{replaces_occurrence_id:old.occurrence_id,standard_no:f.document.standard_no}},
  }]});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('a later host ignore upgrades the same saved missing occurrence and cannot be requested through model arguments',async()=>{
  const f=await fixture();let decision:import('../src/external-source-workflow.js').ExternalSourceIgnoreDecision|undefined;
  const workflow={ignored:async()=>decision,lookup:async()=>undefined,require:async()=>{}};
  const missing=await registerExternalStandardReference(f.workspace,f.manifest,{...f.input,ignore:true},false,workflow);
  expect(missing).not.toHaveProperty('source_status','ignored_by_user');
  const original=f.manifest.reference_occurrences[0]!;
  const stateBefore=await readFile(f.workspace.statePath,'utf8');
  decision={decision_id:'neutral-durable-choice',standard_no:'XQ 701-2099',job_id:f.manifest.job_id,created_at:'2020-01-01T00:00:00.000Z',reason:'用户忽略'};
  const resumed=await registerExternalStandardReference(f.workspace,f.manifest,f.input,false,workflow);
  expect(resumed).toMatchObject({ok:true,occurrence_id:original.occurrence_id,source_status:'ignored_by_user'});
  expect((await f.workspace.readEvidenceManifest()).reference_occurrences).toHaveLength(1);
  expect((await f.workspace.readEvidenceManifest()).reference_occurrences[0]!.external_standard).toMatchObject({user_ignore:decision,expansion:'literal_only'});
  expect(await readFile(f.workspace.statePath,'utf8')).toBe(stateBefore);
  expect(persistedManifestResumeMismatch(await f.workspace.readEvidenceManifest(),f.prepared)).toBeNull();
  const controller=await ToolController.create(f.workspace);controller.externalSourceWorkflow=workflow;
  expect(await controller.dispatch('get_target_context',{})).toMatchObject({external_reference_sources:[
    {source_status:'ignored_by_user',next_tool:'read_target_selectors',user_ignore:decision},
  ]});
  expect(await controller.dispatch('report_target_blocker',{kind:'missing_external_source',
    evidence_span_ids:[f.input.origin_span_id],affected_selector_paths:['/references'],explanation:'示例标准原文仍不可获取'}))
    .toMatchObject({ok:false,terminal:false,error:'external_reference_expansion_limited',
      actual:{user_ignored_occurrence_ids:[original.occurrence_id]},next_tool:'read_target_selectors'});
  expect((await f.workspace.readState()).status).toBe('working');
});

test('an unbounded ready standard asks for an explicit scope before registering business obligations',async()=>{
  const f=await fixture(); const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  const out=await f.call();
  expect(out).toMatchObject({ok:false,error:'external_reference_scope_required',source_available:true,
    next_tool:'resolve_external_standard_reference',writable_paths:expect.arrayContaining(['/content_scope'])});
  expect(JSON.stringify(out)).toContain('架体安装');
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('selected sections retain all their facts and shared rules, without importing unrelated sections',async()=>{
  const f=await fixture(); const out=await f.call({content_scope:{mode:'selected_targets',
    targets:[{kind:'section',number:'1'},{kind:'section',number:'2'}],reason:'架体章节和全局记录规则适用；容器章节是另一验收对象。'}});
  expect(out,JSON.stringify(out)).toMatchObject({ok:true,content_available:true});
  const occurrence=f.manifest.reference_occurrences.find(r=>r.occurrence_id===out.occurrence_id)!;
  const texts=f.manifest.evidence.filter(e=>occurrence.target_evidence_ids.includes(e.evidence_id)).map(e=>e.text).join('\n');
  expect(texts).toContain('验收记录应完整'); expect(texts).toContain('每批抽查4处'); expect(texts).not.toContain('每批抽查7处');
  expect(occurrence.content_scope).toMatchObject({mode:'selected_targets',targets:[{kind:'section',number:'1'},{kind:'section',number:'2'}]});
  expect((await f.workspace.readState()).opened_evidence_ids).toEqual([]);
});

test('a missing scope target and an empty selection leave the original manifest unchanged',async()=>{
  const f=await fixture(); const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  expect(await f.call({content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'99'}],reason:'虚构的错误选择'}}))
    .toMatchObject({ok:false,error:'external_reference_scope_target_not_found'});
  expect(await f.call({content_scope:{mode:'selected_targets',targets:[],reason:'空范围'}}))
    .toMatchObject({ok:false,error:'external_reference_scope_invalid'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('an explicit correction replaces the active old scope, archives it, and does not rewrite author records or counters',async()=>{
  const f=await fixture();const old=await f.legacy();const oldOccurrence=structuredClone(f.manifest.reference_occurrences[0]!);
  const selectors=initialTargetSelectorPlan(f.manifest);
  selectors.lots=[{key:'keep-neutral-lot',name:'架体',scope_span_ids:[f.input.origin_span_id],reason:'保留已确认的验收对象。'}];
  await f.workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const authorBefore=await readFile(f.workspace.workingSelectorPath,'utf8');
  await f.workspace.updateState(state=>{state.next_history_sequence=23;state.validation_attempts=1;});
  const stateBefore=await readFile(f.workspace.statePath,'utf8'); const sourceBefore=await readFile(f.workspace.sourceMarkdownPath,'utf8');
  const out=await f.call({replaces_occurrence_id:old.occurrence_id,correction_reason:'原登记将整本标准作为接收范围，应限于架体章节。',
    content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'依据架体验收对象选择完整章节。'}});
  expect(out,JSON.stringify(out)).toMatchObject({ok:true,correction:{status:'applied',previous_occurrence_id:old.occurrence_id}});
  expect(f.manifest.reference_occurrences).toHaveLength(1);
  expect((await f.workspace.readReferenceCorrections())[0]).toMatchObject({previous_occurrence:oldOccurrence,replacement_occurrence_id:out.occurrence_id});
  expect(await readFile(f.workspace.statePath,'utf8')).toBe(stateBefore);
  expect(await readFile(f.workspace.sourceMarkdownPath,'utf8')).toBe(sourceBefore);
  expect(await readFile(f.workspace.workingSelectorPath,'utf8')).toBe(authorBefore);
  expect(persistedManifestResumeMismatch(await f.workspace.readEvidenceManifest(), f.prepared)).toBeNull();
});

test('citation-only correction retires the old body obligation without reporting the available source as missing',async()=>{
  const f=await fixture();const old=await f.legacy();
  const out=await f.call({usage:'citation_only',reason:'此处是标准出处，具体要求由另一明确引用负责。',
    replaces_occurrence_id:old.occurrence_id,correction_reason:'纠正同一原文的采用方式；保留旧登记及更正依据。'});
  expect(out,JSON.stringify(out)).toMatchObject({ok:true,correction:{status:'applied'},source_status:'not_requested_citation_only'});
  expect(String(out.instruction)).not.toContain('正文尚未接入');
  expect(f.manifest.reference_occurrences).toHaveLength(1);
  expect(f.manifest.reference_occurrences[0]).toMatchObject({external_standard:{usage:'citation_only'},target_evidence_ids:[]});
});

test('a new claim cannot silently coexist with a conflicting prior claim for the same literal',async()=>{
  const f=await fixture();await f.legacy();const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  expect(await f.call({usage:'citation_only',reason:'仅保留引文'})).toMatchObject({ok:false,error:'reference_correction_required'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('failed correction targets and changed source literals cannot retire the old decision',async()=>{
  const f=await fixture();const old=await f.legacy();const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  const correction={replaces_occurrence_id:old.occurrence_id,correction_reason:'按实际条文更正范围。'};
  expect(await f.call({...correction,content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'99'}],reason:'错误目标'}}))
    .toMatchObject({ok:false,error:'external_reference_scope_target_not_found'});
  expect(await f.call({...correction,raw_reference:'XQ 701-2099',usage:'citation_only'}))
    .toMatchObject({ok:false,error:'reference_correction_origin_mismatch'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
  expect(await f.workspace.readReferenceCorrections()).toEqual([]);
});

test('replaying an applied correction does not add a second history entry or change accounting',async()=>{
  const f=await fixture();const old=await f.legacy();const request={replaces_occurrence_id:old.occurrence_id,
    correction_reason:'只采用架体章节与真实共同规则。',content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'架体适用章节。'}};
  const first=await f.call(request);expect(first).toMatchObject({ok:true,correction:{status:'applied'}});
  const before=await readFile(f.workspace.evidenceManifestPath,'utf8');const state=await readFile(f.workspace.statePath,'utf8');
  expect(await f.call(request)).toMatchObject({ok:true,correction:{status:'already_applied'}});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
  expect(await readFile(f.workspace.statePath,'utf8')).toBe(state);
  expect(await f.workspace.readReferenceCorrections()).toHaveLength(1);
});

test('an already validated checkpoint refuses correction without modifying it',async()=>{
  const f=await fixture();const old=await f.legacy();const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  const {atomicWriteJson}=await import('../src/atomic.js');
  await atomicWriteJson(f.workspace.statePath,{...await f.workspace.readState(),last_valid_fingerprint:'validated-neutral'});
  const state=await readFile(f.workspace.statePath,'utf8');
  expect(await f.call({replaces_occurrence_id:old.occurrence_id,correction_reason:'不允许改写已验证候选。',usage:'citation_only'}))
    .toMatchObject({ok:false,error:'reference_correction_checkpoint_frozen',writable_paths:[]});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
  expect(await readFile(f.workspace.statePath,'utf8')).toBe(state);
});

test('a specified clause remains exhaustive and cannot be replaced by an optional scope',async()=>{
  const f=await fixture();const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  expect(await f.call({target:{kind:'clause',number:'2.0.1'},content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'1'}],reason:'不能掩盖明确目标'}}))
    .toMatchObject({ok:false,error:'external_reference_scope_invalid'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('selected scope does not let a caller hide an unaccounted fact inside that scope',async()=>{
  const f=await fixture();const out=await f.call({content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'架体整节均适用。'}});
  expect(out).toMatchObject({ok:true});
  const occurrence=f.manifest.reference_occurrences.find(o=>o.occurrence_id===out.occurrence_id)!;
  const registry=await f.workspace.readSourceSpanRegistry();
  const first=registry.spans.find(s=>f.manifest.evidence.find(e=>e.evidence_id===s.evidence_id)?.text.includes('2.0.1'))!;
  const reference={key:'bounded',occurrence_id:occurrence.occurrence_id,anchor_span_ids:[],target_span_ids:[first.span_id],
    action:'adopt',application_mode:'reference_only',destinations:[{item_key:'connection',target_field:'requirement'}],reason:'只完成其中一项。'} as TargetSelectorPlan['references'][number];
  const issues=resolvedReferenceComponentCoverageIssues({references:[reference],source_dispositions:[]},f.manifest,registry,new Map([['connection',[first]]]));
  expect(issues).toHaveLength(1);
  const missing=issues[0]!.details!.evidence_ids as string[];
  expect(f.manifest.evidence.filter(e=>missing.includes(e.evidence_id)).map(e=>e.text).join('\n')).toContain('锚固应稳定');
});

test('a stale correction cannot overwrite a later scope choice',async()=>{
  const f=await fixture();const old=await f.legacy();
  const first=await f.call({replaces_occurrence_id:old.occurrence_id,correction_reason:'从旧整本登记收口到架体。',
    content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'架体章节。'}});
  const second=await f.call({replaces_occurrence_id:first.occurrence_id,correction_reason:'补回实际适用的共同规则。',
    content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'1'},{kind:'section',number:'2'}],reason:'共用规则和架体章节。'}});
  expect(second).toMatchObject({ok:true,correction:{status:'applied'}});
  const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  expect(await f.call({replaces_occurrence_id:old.occurrence_id,correction_reason:'过期请求重放。',
    content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'旧范围。'}}))
    .toMatchObject({ok:false,error:'reference_correction_stale'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
  expect(await f.workspace.readReferenceCorrections()).toHaveLength(2);
});

test('reordering the same selected scope is an idempotent read, not a new correction',async()=>{
  const f=await fixture();const scope={mode:'selected_targets',targets:[{kind:'section',number:'2'},{kind:'section',number:'1'}],reason:'同一组适用范围。'};
  const first=await f.call({content_scope:scope});expect(first).toMatchObject({ok:true});
  const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  const second=await f.call({content_scope:{...scope,targets:[...scope.targets].reverse()}});
  expect(second).toMatchObject({ok:true,occurrence_id:first.occurrence_id,idempotent:true});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
});

test('an appendix remains an appendix in the scope navigation, including a Markdown heading',()=>{
  const markdown='XQ 755-2099\n# 1 范围\n1.0.1 示例正文。\n# 附录 B 独立试验\nB.0.1 另一个中性要求。';
  const out=externalReferenceScopeFeedback({standard_no:'XQ 755-2099',markdown,markdown_sha256:sha256Text(markdown)},undefined);
  expect(out.scope_catalog).toContainEqual(expect.objectContaining({kind:'appendix',number:'B',title:'独立试验'}));
});

test('a correction cannot silently replace the frozen external document with different text of the same number',async()=>{
  const f=await fixture();const old=await f.legacy();const before=await readFile(f.workspace.evidenceManifestPath,'utf8');
  f.document.markdown+='\n3.0.2 新文本不能混入旧来源。';f.document.markdown_sha256=sha256Text(f.document.markdown);
  expect(await f.call({replaces_occurrence_id:old.occurrence_id,correction_reason:'试图更换来源。',
    content_scope:{mode:'selected_targets',targets:[{kind:'section',number:'2'}],reason:'同一编号但正文已变化。'}}))
    .toMatchObject({ok:false,error:'reference_correction_source_changed'});
  expect(await readFile(f.workspace.evidenceManifestPath,'utf8')).toBe(before);
  expect(await f.workspace.readReferenceCorrections()).toEqual([]);
});
