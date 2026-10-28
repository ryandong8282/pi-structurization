import {readFile} from 'node:fs/promises';
import {expect,test} from 'vitest';
import {Check} from 'typebox/value';
import {createPiTools} from '../src/tools.js';
import {buildSelectorStageScenario,clauseRecord,fullSpanFor} from './selector-stage-fixture.js';

async function mixedFixture(){
 const s=await buildSelectorStageScenario(['# 2 虚构滤光匣验收','','## 2.1 验收','','2.1.1 匣盖应完整，检查数量为每批4件。','','# 3 共同规定','','3.1.1 型号应记录。','','3.1.2 所有匣盖按批抽查6件。',''].join('\n'));
 const catalog=await s.controller.dispatch('list_global_document_resources',{});
 const atom=(catalog.resources as any[])[0]!;
 expect(await s.controller.dispatch('open_global_document_resource',atom.tool_arguments)).toMatchObject({ok:true});
 const registered=await s.controller.dispatch('register_external_dependency',{atom_id:atom.atom_id,mode:'dependency',reason:'中性样本登记共同规定来源，适用性仍由模型判断。'});
 expect(registered.ok,JSON.stringify(registered)).toBe(true);
 const resource=(registered.resource??(registered.existing_evidence as any[])?.[0]) as any;
 expect(resource?.evidence_id).toBeDefined();
 const record=s.controller.evidence.evidence.find(e=>e.evidence_id===resource.evidence_id)!;
 expect(record.evidence_scope).toBe('reference');
 expect(record.clause_id).toBeUndefined();
 expect(record.text).toContain('3.1.2');
 return {...s,record};
}
function executable(controller:any,tool:string,args:unknown){
 expect(Check(createPiTools(controller).find(t=>t.name===tool)!.parameters,args)).toBe(true);
}
test('a legal mixed global source advertises its real capability and returns its exact read instead of directory page zero',async()=>{
 const {controller,record,workspace}=await mixedFixture();
 const before=await workspace.readState(),draft=await readFile(workspace.workingSelectorPath,'utf8');
 const directory=await controller.dispatch('list_evidence_resources',{limit:30});
 const row=(directory.resources as any[]).find(r=>r.evidence_id===record.evidence_id);
 expect(row).toMatchObject({access_mode:'direct',context_directory:{available:false,unavailable_reasons:['outside_primary_index','no_registered_clause_id']}});
 const rules=await controller.dispatch('list_sampling_rules',{});
 const candidate=[...rules.candidates as any[],...rules.navigation_candidates as any[]].find(r=>r.evidence_id===record.evidence_id);
 expect(candidate).toMatchObject({context_directory:row.context_directory});
 const rejected=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:record.evidence_id});
 expect(rejected).toMatchObject({ok:false,error:'evidence_context_directory_unavailable',
   actual:{registered_in_current_evidence:true,evidence_scope:'reference'},
   context_directory:row.context_directory,next_tool:'open_evidence',next_tool_arguments:{evidence_id:record.evidence_id,cursor:0}});
 executable(controller,String(rejected.next_tool),rejected.next_tool_arguments);
 const opened=await controller.dispatch(String(rejected.next_tool),rejected.next_tool_arguments as any);
 expect(opened).toMatchObject({ok:true});
 const afterRead=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:record.evidence_id});
 expect(afterRead).toMatchObject({ok:false,next_action:{kind:'choose_source_fragment',decision_owner:'model'},
   quote_locator:{tool:'locate_evidence_span',fixed_arguments:{evidence_id:record.evidence_id},author_required_parameters:['quote']}});
 expect(afterRead).not.toHaveProperty('next_tool');
 const locate={evidence_id:record.evidence_id,quote:'所有匣盖按批抽查6件。'};
 executable(controller,'locate_evidence_span',locate);
 expect(await controller.dispatch('locate_evidence_span',locate)).toMatchObject({ok:true});
 expect(await readFile(workspace.workingSelectorPath,'utf8')).toBe(draft);
 expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
});

test('unknown identity remains an identity recovery, not a guessed source read',async()=>{
 const {controller}=await buildSelectorStageScenario();
 const result=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:'unknown-source'});
 expect(result).toMatchObject({ok:false,context_directory:{available:false,unavailable_reasons:['unknown_source_identity']},
   actual:{registered_in_current_evidence:false},next_tool:'list_evidence_resources'});
 expect(result).not.toHaveProperty('quote_locator');
 executable(controller,String(result.next_tool),result.next_tool_arguments);
 expect(await controller.dispatch(String(result.next_tool),result.next_tool_arguments as any)).toMatchObject({ok:true});
});

test('a known global atom without target registration uses its own global read route',async()=>{
 const {controller,workspace}=await buildSelectorStageScenario();
 const catalog=await controller.dispatch('list_global_document_resources',{}),resource=(catalog.resources as any[])[0]!;
 expect(controller.evidence.evidence.find(e=>e.evidence_id===resource.atom_id)).toBeUndefined();
 const draft=await readFile(workspace.workingSelectorPath,'utf8'),before=await workspace.readState();
 const result=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:resource.atom_id});
 expect(result).toMatchObject({ok:false,actual:{known_global_resource:true,registered_in_current_evidence:false},
   context_directory:{available:false,unavailable_reasons:['not_registered_in_target']},
   next_tool:'open_global_document_resource',next_tool_arguments:{atom_id:resource.atom_id}});
 expect(result).not.toHaveProperty('quote_locator');
 executable(controller,String(result.next_tool),result.next_tool_arguments);
 expect(await controller.dispatch(String(result.next_tool),result.next_tool_arguments as any)).toMatchObject({ok:true});
 expect(await readFile(workspace.workingSelectorPath,'utf8')).toBe(draft);
 expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
});

test('missing registered clause identity and being outside primary are independent capability reasons',async()=>{
 const {controller,manifest}=await buildSelectorStageScenario();
 const id=clauseRecord(manifest,'2.1.1').evidence_id;
 const source=controller.evidence.evidence.find(e=>e.evidence_id===id)!,originalClause=source.clause_id;
 delete source.clause_id;
 expect(await controller.dispatch('list_evidence_resources',{context_for_evidence_id:source.evidence_id}))
  .toMatchObject({context_directory:{available:false,unavailable_reasons:['no_registered_clause_id']},
    next_tool:'open_evidence',next_tool_arguments:{evidence_id:source.evidence_id,cursor:0}});
 source.clause_id=originalClause!;
 source.evidence_scope='reference';
 expect(await controller.dispatch('list_evidence_resources',{context_for_evidence_id:source.evidence_id}))
  .toMatchObject({context_directory:{available:false,unavailable_reasons:['outside_primary_index']},
    next_tool:'open_evidence',next_tool_arguments:{evidence_id:source.evidence_id,cursor:0}});
});

test('isolated reference context errors preserve the real catalog route without leaking body metadata',async()=>{
 const {controller,manifest,workspace}=await buildSelectorStageScenario(['# 2 虚构检测匣','','## 2.1 验收','','2.1.1 检测匣应符合附录 B 的规定。检验数量：每批3件。','','# 附录 B','','B.0.1 密闭探头不得松脱。','','B.0.2 备用探头另行包装。','',...Array.from({length:64},(_,i)=>[`B.1.${i+1} 虚构支路${i+1}应记录检测状态。`,'']).flat()].join('\n'));
 const origin=clauseRecord(manifest,'2.1.1'),span=fullSpanFor(await workspace.readSourceSpanRegistry(),origin.evidence_id,origin.text.length);
 const resolved=await controller.dispatch('resolve_document_reference',{origin_span_id:span,raw_reference:'附录 B',target:{kind:'appendix',number:'B'},relation:'shared_appendix_requirement'});
 expect(resolved).toMatchObject({ok:true,analysis_mode:'isolated'});
 const occurrence=controller.evidence.reference_occurrences.find(o=>o.occurrence_id===resolved.occurrence_id)!;
 const id=occurrence.target_evidence_ids[0]!;
 const result=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:id});
 expect(result).toMatchObject({ok:false,context_directory:{available:false,unavailable_reasons:['reference_access_required']},
   next_tool:'read_reference_facts',next_tool_arguments:{target_key:resolved.target_key}});
 expect(JSON.stringify(result)).not.toContain('密闭探头');
 expect(result).not.toHaveProperty('quote_locator');
 executable(controller,String(result.next_tool),result.next_tool_arguments);
 expect(await controller.dispatch(String(result.next_tool),result.next_tool_arguments as any)).toMatchObject({ok:true});
 expect(await controller.dispatch('open_evidence',{evidence_id:id})).toMatchObject({ok:false,error:'isolated_reference_body_access_forbidden'});
 const global=await controller.dispatch('list_global_document_resources',{}),parent=(global.resources as any[])[0]!.parent_atom_id;
 expect(parent).toBeDefined();
 const globalRejected=await controller.dispatch('list_evidence_resources',{context_for_evidence_id:parent});
 expect(globalRejected).toMatchObject({ok:false,context_directory:{available:false,unavailable_reasons:['reference_access_required']},
   next_tool:'read_reference_facts',next_tool_arguments:{target_key:resolved.target_key}});
 executable(controller,String(globalRejected.next_tool),globalRejected.next_tool_arguments);
 expect(await controller.dispatch(String(globalRejected.next_tool),globalRejected.next_tool_arguments as any)).toMatchObject({ok:true});
});
