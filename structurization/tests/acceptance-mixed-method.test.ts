import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcceptanceAutonomousController} from '../src/acceptance-autonomous/controller.js';
import {buildAcceptanceSourceLedger,sourceQuote} from '../src/acceptance-autonomous/source-ledger.js';
import {reviewMethodExecutionEvidence} from '../src/acceptance-autonomous/review-methods.js';
import type {AcceptanceDelivery,GroupReviewRequest} from '../src/acceptance-autonomous/contracts.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const program=String.raw`import{readFile,writeFile}from'node:fs/promises';
const req=JSON.parse(await readFile(process.argv[2],'utf8')),d=JSON.parse(await readFile(req.input,'utf8')),s=JSON.parse(await readFile(req.source_ledger,'utf8')),outcomes=[];
const empty=()=>({value:'',evidence:[],reason:'本局部未给出此字段。'});
for(const match of req.matches){
 const block=s.blocks.find(b=>b.id===match.block_id),lot=d.lots.find(l=>l.scope.block_ids.includes(block.id));
 const touches=i=>JSON.stringify(i).includes(JSON.stringify(block.id));
 if(req.phase==='trial'&&lot.items.some(touches))throw Error('Matched answer rows leaked into the experiment');
 const kept=lot.items.filter(i=>!touches(i));
 if(kept.length!==2)throw Error('The host discarded separately authored parts of this mixed business lot');
 const row=[...block.text.matchAll(/<tr>(.*?)<\/tr>/gs)][1],cells=[...row[1].matchAll(/<td>(.*?)<\/td>/gs)];
 const bound=i=>{const text=cells[i][1],start=row.index+row[0].indexOf(row[1])+cells[i].index+4;return{value:text,evidence:[{source_id:s.source_id,block_id:block.id,start,end:start+text.length,text}]};};
 lot.items=[...kept,{id:'generated-'+block.id,name:bound(0),requirement:bound(1),category:empty(),method:empty(),quantity:empty(),unit:empty(),condition:empty(),note:empty(),inspection_data_type:'review',inspection_data_type_reason:'按原文保留要求，语义由复核者核对。',sampling:{status:'not_sampling',text:empty(),conditions:[]},reference_ids:[],rule_ids:['parser']}];
 outcomes.push({block_id:block.id,status:'processed',lot_ids:[lot.id],reason:'仅重建本表；同批其他内容保留。'});
}
await writeFile(req.output,JSON.stringify(d));await writeFile(req.outcomes,JSON.stringify(outcomes));`;

async function setup(name='假想端面',value='31',note='核对原始记录的签章。'){
 const root=await mkdtemp(join(tmpdir(),'mixed-method-'));dirs.push(root);
 const markdown=`# 虚构混合业务批\n\n${note}\n\n<table><tr><td>项目</td><td>要求</td></tr><tr><td>${name}</td><td>${value}</td></tr></table>\n\n<table><tr><td>另型记录</td><td>描述</td></tr><tr><td>虚构标签</td><td>颜色按记录留存</td></tr></table>`;
 const markdownPath=join(root,'source.md');await writeFile(markdownPath,markdown);
 const source=buildAcceptanceSourceLedger(markdown),heading=source.blocks[0]!,prose=source.blocks.find(b=>b.text===note)!,tables=source.blocks.filter(b=>b.kind==='table'),target=tables[0]!,other=tables[1]!;
 const bound=(b:typeof heading,text:string)=>({value:text,evidence:[sourceQuote(source,b,b.text.indexOf(text),b.text.indexOf(text)+text.length)]});
 const empty=()=>({value:'',evidence:[],reason:'此字段在当前材料中未规定。'});
 const item=(id:string,b:typeof heading,label:string,requirement:string,rule:string)=>({id,name:bound(b,label),requirement:bound(b,requirement),category:empty(),method:empty(),quantity:empty(),unit:empty(),condition:empty(),note:empty(),inspection_data_type:'review' as const,inspection_data_type_reason:'中性语义记录。',sampling:{status:'not_sampling' as const,text:empty(),conditions:[]},reference_ids:[],rule_ids:[rule]});
 const delivery:AcceptanceDelivery={schema_version:'acceptance-autonomous-delivery/v1',source_sha256:source.sha256,
  rules:[{id:'parser',method_files:['parser.mjs'],scope:'仅处理项目和要求两列表。',exceptions:['同批正文与其他表型由模型处理。'],evidence:[sourceQuote(source,target)]},{id:'semantic',method_files:['semantic.md'],scope:'正文与另型表的语义记录。',exceptions:[],evidence:[sourceQuote(source,prose),sourceQuote(source,other)]}],
  groups:[{id:'mixed',structure:'同一业务批内的程序局部和模型局部',rule_ids:['parser','semantic'],lot_ids:['business-lot'],trial_lot_ids:['business-lot'],boundary_lot_ids:[],conditions:'保留完整业务批。',exclusions:[]}],
  lots:[{id:'business-lot',name:bound(heading,heading.text),ancestors:[],scope:{block_ids:source.blocks.map(b=>b.id),reason:'同一完整业务批的全部来源。',evidence:[sourceQuote(source,heading)]},group_id:'mixed',dependency_ids:['parser','semantic'],items:[item('prose',prose,note,note,'semantic'),item('table',target,name,value,'parser'),item('other-table',other,'虚构标签','颜色按记录留存','semantic')]}],
  dispositions:source.blocks.map(b=>({source_id:source.source_id,block_id:b.id,role:'lot',lot_ids:['business-lot'],reason:'完整混合业务批。',evidence:[sourceQuote(source,b)]})),references:[],problems:[]};
 const reviewer=vi.fn(async(request:GroupReviewRequest)=>{
  expect(request.lots).toHaveLength(1);expect(request.lots[0]!.scope.block_ids).toEqual(source.blocks.map(b=>b.id));
  expect(request.lots[0]!.items.map(i=>[i.name.value,i.requirement.value]).sort()).toEqual([[note,note],['虚构标签','颜色按记录留存'],[name,value]].sort());
  return{approved:true,reviewed_lot_ids:['business-lot'],findings:[],reason:'独立核对整个混合业务批，程序仅负责匹配表。'};
 });
 const options={root:join(root,'run'),markdownPath,limits:{max_tool_response_bytes:524288,max_single_tool_response_bytes:131072,max_observed_context_tokens:230000,max_attempts:12,concurrency:8},reviewer,requireExecutableTableTrials:true};
 const controller=await AcceptanceAutonomousController.open(options),path=join(controller.workRoot,'DELIVERY.json');
 await writeFile(path,JSON.stringify(delivery));await writeFile(join(controller.workRoot,'parser.mjs'),program);await writeFile(join(controller.workRoot,'semantic.md'),'独立语义处理正文和另一表型，保留来源。');await controller.accountTool(247);
 return{root,source,delivery,controller,options,path,reviewer,target,params:{path:'DELIVERY.json',group_id:'mixed',sample_block_id:target.id,header_row_index:0,program_file:'parser.mjs',method_files:['parser.mjs']}};
}

it.each([['假想端面','31','核对原始记录的签章。'],['虚构沟槽','≥57','记录封签与交接说明。']])('experiments on a local table while preserving the complete mixed lot: %s',async(name,value,note)=>{
 const f=await setup(name,value,note),budget=f.controller.state().budget;
 const experiment=await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 expect(experiment).toMatchObject({ok:true,phase:'trial',processed:1,semantic_approval:false});
 const d=JSON.parse(await readFile(f.path,'utf8')) as AcceptanceDelivery;
 expect(d.lots).toHaveLength(1);expect(d.lots[0]!.scope).toEqual(f.delivery.lots[0]!.scope);
 for(const id of ['prose','other-table'])expect(d.lots[0]!.items.find(i=>i.id===id)).toEqual(f.delivery.lots[0]!.items.find(i=>i.id===id));
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'mixed',phase:'trial'})).toMatchObject({ok:true});
 const evidence=await reviewMethodExecutionEvidence(f.controller,f.reviewer.mock.calls[0]![0]);
 expect(evidence.verified_trials[0]).toMatchObject({execution_scope:'matched_table_items/v1',preserved_item_count:2,semantic_approval:false});
 expect(await f.controller.dispatch('sweep_acceptance_tables',f.params)).toMatchObject({ok:true,processed:1});
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'mixed',phase:'full'})).toMatchObject({ok:true,review_mode:'full'});
 expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'mixed'})).toMatchObject({error:'complete_table_sweep_required'});
 expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'mixed',mode:'semantic_exception',reason:'已验证局部程序；其余正文和另型表由模型处理并完成整批语义核对。'})).toMatchObject({ok:true,mode:'semantic_exception'});
 expect(f.controller.state().budget).toEqual(budget);
 expect((await AcceptanceAutonomousController.open(f.options)).state().budget).toEqual(budget);
});

it.each(['copy','change-other','shrink-scope'])('rejects %s instead of mistaking protected content for table reconstruction',async(mode)=>{
 const f=await setup(),before=await readFile(f.path,'utf8'),budget=f.controller.state().budget;
 const bad=mode==='copy'?String.raw`import{readFile,writeFile}from'node:fs/promises';const r=JSON.parse(await readFile(process.argv[2],'utf8'));await writeFile(r.output,await readFile(r.input));await writeFile(r.outcomes,JSON.stringify(r.matches.map(m=>({block_id:m.block_id,status:'processed',lot_ids:['business-lot'],reason:'copy'}))));`
  :mode==='change-other'?program.replace('lot.items=[...kept,',"kept[0].requirement.value='changed';lot.items=[...kept,")
  :program.replace('outcomes.push(',"lot.scope.block_ids=[block.id];outcomes.push(");
 await writeFile(join(f.controller.workRoot,'parser.mjs'),bad);
 const result=await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 expect(result).toMatchObject({ok:false,error:'sweep_output_contract_failed'});
 expect(await readFile(f.path,'utf8')).toBe(before);expect(f.controller.state().budget).toEqual(budget);
 expect(f.controller.state().table_sweeps??[]).toEqual([]);expect(f.reviewer).not.toHaveBeenCalled();
});
