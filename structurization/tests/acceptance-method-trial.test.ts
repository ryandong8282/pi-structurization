import { afterEach, expect, it, vi } from 'vitest';
import { reviewExposures } from '../src/acceptance-autonomous/review.js';
import { freezeReviewMethods, reviewMethodExecutionEvidence } from '../src/acceptance-autonomous/review-methods.js';
import { freezeReviewContexts } from '../src/acceptance-autonomous/review-context.js';
import { reviewEvidenceId } from '../src/acceptance-autonomous/review-evidence.js';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptanceAutonomousController } from '../src/acceptance-autonomous/controller.js';
import { buildAcceptanceSourceLedger, sourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import { validateAcceptanceDelivery } from '../src/acceptance-autonomous/validation.js';
import { verifyAutonomousSealedDelivery } from '../src/acceptance-autonomous/sealed.js';
import type { AcceptanceDelivery, GroupReviewRequest } from '../src/acceptance-autonomous/contracts.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const limits = { max_tool_response_bytes: 524288, max_single_tool_response_bytes: 131072, max_observed_context_tokens: 230000, max_attempts: 12, concurrency: 8 };

// A fixture for ONE class of simple tables, authored outside the host implementation.
// No standard IDs, source IDs, expected counts, item names or requirement values occur in this program.
const method = String.raw`import {readFile,writeFile} from 'node:fs/promises';
const req=JSON.parse(await readFile(process.argv[2],'utf8'));
const source=JSON.parse(await readFile(req.source_ledger,'utf8'));
const d=JSON.parse(await readFile(req.input,'utf8')), group=d.groups.find(g=>g.id===req.group_id), outcomes=[];
const absent=()=>({value:'',evidence:[],reason:'当前表格没有此字段。'});
for(const match of req.matches){
 const block=source.blocks.find(b=>b.id===match.block_id);
 const heading=source.blocks[source.blocks.indexOf(block)-1];
 const q=(b,text,start=b.text.indexOf(text))=>({source_id:source.source_id,block_id:b.id,start,end:start+text.length,text});
 const bound=(b,text,start)=>({value:text,evidence:[q(b,text,start)]});
 const rows=[...block.text.matchAll(/<tr>(.*?)<\/tr>/gs)];
 const cells=row=>[...row[1].matchAll(/<t[dh]>(.*?)<\/t[dh]>/gs)].map(c=>({value:c[1],start:row.index+row[0].indexOf(row[1])+c.index+c[0].indexOf('>')+1}));
 const header=cells(rows[0]).map(c=>c.value), name=header.indexOf('项目'), requirement=header.indexOf('要求'), unit=header.indexOf('单位');
 if(name<0||requirement<0||unit<0) throw Error('Unsupported header; classify this as an exception instead of guessing.');
 let lot=d.lots.find(l=>l.scope.block_ids.includes(block.id));
 if(req.phase==='trial' && lot.items.length) throw Error('Trial leaked the old answer rows');
 if(!lot){lot={id:'generated-'+block.id,name:bound(heading,heading.text),ancestors:[],scope:{block_ids:[heading.id,block.id],reason:'相邻具名对象与表格。',evidence:[q(heading,heading.text),q(block,block.text)]},group_id:group.id,dependency_ids:['method'],items:[]};d.lots.push(lot);group.lot_ids.push(lot.id);}
 lot.items=rows.slice(1).map((row,index)=>{const c=cells(row), get=i=>bound(block,c[i].value,c[i].start);return {id:'item-'+index,name:get(name),category:absent(),requirement:get(requirement),method:absent(),quantity:absent(),unit:get(unit),condition:absent(),note:absent(),inspection_data_type:'mixed',inspection_data_type_reason:'列映射保留原文判据；语义类型仍由独立核对确定。',sampling:{status:'reference_unspecified_quantity',text:absent(),conditions:[]},reference_ids:[],rule_ids:['method']};});
 for(const id of lot.scope.block_ids){const b=source.blocks.find(x=>x.id===id);let disposition=d.dispositions.find(x=>x.block_id===id);if(!disposition){disposition={};d.dispositions.push(disposition);}Object.assign(disposition,{source_id:source.source_id,block_id:id,role:'lot',lot_ids:[lot.id],reason:'完整具名表格归属。',evidence:[q(b,b.text)]});}
 outcomes.push({block_id:block.id,status:'processed',lot_ids:[lot.id],reason:'从当前输入按列映射提取全部数据行。'});
}
await writeFile(req.output,JSON.stringify(d));await writeFile(req.outcomes,JSON.stringify(outcomes));`;

const datasets = [
  { name: 'neutral-length', headers: ['项目', '要求', '单位'], lots: [
    [['虚构甲长度', '17', 'mm'], ['虚构甲宽度', '23', 'mm']],
    [['虚构乙间距', '31', 'cm']], [['虚构丙尺寸', '43', 'm'], ['虚构丙厚度', '59', 'mm'], ['虚构丙高度', '61', 'cm']],
  ] },
  { name: 'neutral-force-permuted', headers: ['单位', '项目', '要求'], lots: [
    [['假想丁抗力', '≥73', 'N']], [['假想戊扭矩', '≤89', 'Nm'], ['假想戊压力', '97', 'Pa']],
    [['假想己荷载', '103', 'kN'], ['假想己频次', '109', '次']],
  ] },
];

async function setup(data = datasets[0]!) {
  const root = await mkdtemp(join(tmpdir(), 'method-trial-')); dirs.push(root);
  const markdown = data.lots.map((rows, i) => `# 虚构试验对象${i}\n\n<table><tr>${data.headers.map(h=>`<th>${h}</th>`).join('')}</tr>${rows.map(row=>`<tr>${data.headers.map(h=>`<td>${row[['项目','要求','单位'].indexOf(h)]}</td>`).join('')}</tr>`).join('')}</table>`).join('\n\n');
  const markdownPath = join(root, 'source.md'); await writeFile(markdownPath, markdown);
  const source = buildAcceptanceSourceLedger(markdown), tables = source.blocks.filter(b=>b.kind==='table');
  const checked = new Map(tables.map((table,i)=>[table.id,data.lots[i]!]));
  const reviewer = vi.fn(async (request: GroupReviewRequest) => {
    // Test oracle is the separately supplied neutral input data, not the extraction program.
    for (const lot of request.lots) {
      const table = tables.find(t=>lot.scope.block_ids.includes(t.id))!;
      expect(lot.items.map(item=>[item.name.value,item.requirement.value,item.unit.value])).toEqual(checked.get(table.id));
    }
    return {approved:true, reviewed_lot_ids:request.lots.map(l=>l.id), findings:[], reason:'逐字段与独立中性输入期望核对。'};
  });
  const options = { root:join(root,'run'), markdownPath, limits, reviewer, requireExecutableTableTrials:true };
  const controller = await AcceptanceAutonomousController.open(options);
  const heading = source.blocks[0]!, table = tables[0]!;
  const empty = {value:'',evidence:[],reason:'等待实验从输入生成。'};
  const delivery: AcceptanceDelivery = {schema_version:'acceptance-autonomous-delivery/v1',source_sha256:source.sha256,
    rules:[{id:'method',method_files:['method.mjs'],scope:'具名对象后的项目、要求、单位列；按表头识别列序。',exceptions:['其他列结构转交规划者处理。'],evidence:[sourceQuote(source,table)]}],
    groups:[{id:'class',structure:'项目/要求/单位表',rule_ids:['method'],lot_ids:['trial'],trial_lot_ids:['trial'],boundary_lot_ids:[],conditions:'完整三列表',exclusions:['其他版式']}],
    lots:[{id:'trial',name:{value:heading.text,evidence:[sourceQuote(source,heading)]},ancestors:[],scope:{block_ids:[heading.id,table.id],reason:'代表对象和表格。',evidence:[sourceQuote(source,heading),sourceQuote(source,table)]},group_id:'class',dependency_ids:['method'],items:[{id:'placeholder',name:empty,category:empty,requirement:empty,method:empty,quantity:empty,unit:empty,condition:empty,note:empty,inspection_data_type:'review',inspection_data_type_reason:'未实验。',sampling:{status:'reference_unspecified_quantity',text:empty,conditions:[]},reference_ids:[],rule_ids:['method']}]}],
    dispositions:source.blocks.map(b=>({source_id:source.source_id,block_id:b.id,role:[heading.id,table.id].includes(b.id)?'lot':'unresolved',lot_ids:[heading.id,table.id].includes(b.id)?['trial']:[],reason:'已定位小样，其余尚未程序处理。',evidence:[sourceQuote(source,b)]})),references:[],problems:[]};
  for (const [field, text] of [['name',data.lots[0]![0]![0]!],['requirement',data.lots[0]![0]![1]!]] as const) {
    const start=table.text.indexOf(text);delivery.lots[0]!.items[0]![field]={value:text,evidence:[sourceQuote(source,table,start,start+text.length)]};
  }
  const path=join(controller.workRoot,'DELIVERY.json');await writeFile(path,JSON.stringify(delivery));await writeFile(join(controller.workRoot,'method.mjs'),method);
  const params={path:'DELIVERY.json',group_id:'class',sample_block_id:table.id,header_row_index:0,program_file:'method.mjs',method_files:['method.mjs']};
  const read=async()=>JSON.parse(await readFile(path,'utf8')) as AcceptanceDelivery;
  await controller.accountTool(123); // Existing history must survive every experiment/reload.
  return {root,markdown,source,controller,options,reviewer,params,read,path};
}

it.each(datasets)('runs discovery → executable trial → batch → genuine holdout → class seal on $name', async data=>{
  const f=await setup(data), initial=f.controller.state().budget;
  expect(await f.controller.dispatch('sweep_acceptance_tables',{...f.params,program_file:undefined})).toMatchObject({plan_only:true,matching_tables:3});
  expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'})).toMatchObject({ok:false,error:'executable_method_trial_required',model_started:false});
  expect(f.reviewer).not.toHaveBeenCalled();
  expect(await f.controller.dispatch('experiment_acceptance_table_method',f.params)).toMatchObject({ok:true,phase:'trial',processed:1,semantic_approval:false});
  expect((await f.read()).lots).toHaveLength(1);
  expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'})).toMatchObject({ok:true,stage:'trial'});
  const execution=await reviewMethodExecutionEvidence(f.controller,f.reviewer.mock.calls[0]![0]);
  expect(execution.verified_trials).toHaveLength(1);
  expect(execution.verified_trials[0]).toMatchObject({sample_lot_ids:['trial'],request_shape:{phase:'trial',source_ledger:`source/${f.source.source_id}.json`,input:'DELIVERY.input.json',output:'DELIVERY.output.json',outcomes:'sweep.results.json'},semantic_approval:false});
  expect(execution.context).toContain('not the executable program input');
  expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class'})).toMatchObject({ok:false});
  expect(await f.controller.dispatch('sweep_acceptance_tables',f.params)).toMatchObject({ok:true,phase:'batch',processed:3,model_workers_started:0});
  const delivery=await f.read();expect(validateAcceptanceDelivery(delivery,{sources:[f.source],root_source_id:f.source.source_id}).issues).toEqual([]);
  const reopened=await AcceptanceAutonomousController.open(f.options);
  expect(reopened.state().budget).toEqual(initial);
  expect(await reopened.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({ok:true,review_mode:'holdout'});
  expect(f.reviewer.mock.calls.map(([r])=>r.phase)).toEqual(['trial','holdout']);
  expect(f.reviewer.mock.calls[1]![0].lots.every(l=>l.id!=='trial')).toBe(true);
  expect(reopened.state().approvals[0]!.training_lot_ids).toEqual(['trial']);
  expect(await reopened.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class'})).toMatchObject({ok:true,class_sealed:true,lot_count:3});
  const sealed=await reopened.dispatch('seal_acceptance_delivery',{path:'DELIVERY.json'});
  expect(sealed.ok).toBe(true);const verified=await verifyAutonomousSealedDelivery(String(sealed.path),f.source.sha256);expect(verified).toMatchObject({status:'complete'});
  if(process.env.ACCEPTANCE_CAPABILITY_REPORT_DIR){const out=join(process.env.ACCEPTANCE_CAPABILITY_REPORT_DIR,data.name);await mkdir(out,{recursive:true});await writeFile(join(out,'source.md'),f.markdown);await writeFile(join(out,'DELIVERY.json'),JSON.stringify(delivery,null,2));await writeFile(join(out,'sealed.json'),JSON.stringify(verified,null,2));await writeFile(join(out,'evidence.json'),JSON.stringify({method,source_sha256:f.source.sha256,review_phases:f.reviewer.mock.calls.map(([r])=>({phase:r.phase,lot_ids:r.lots.map(l=>l.id)})),checkpoint:reopened.state(),note:'Deterministic neutral integration test; reviewer uses an independent oracle. This is not live LLM generalization evidence.'},null,2));}
});

it('rejects copying old answers, preserves history, and requires a new experiment after manual output or method changes',async()=>{
 const f=await setup();const before=await readFile(f.path,'utf8'), budget=f.controller.state().budget;
 await writeFile(join(f.controller.workRoot,'method.mjs'),`import{readFile,writeFile}from'node:fs/promises';const r=JSON.parse(await readFile(process.argv[2],'utf8'));await writeFile(r.output,await readFile(r.input));await writeFile(r.outcomes,JSON.stringify(r.matches.map(m=>({block_id:m.block_id,status:'processed',lot_ids:['trial'],reason:'copy'}))));`);
 expect(await f.controller.dispatch('experiment_acceptance_table_method',f.params)).toMatchObject({ok:false,error:'sweep_output_contract_failed'});
 expect(await readFile(f.path,'utf8')).toBe(before);expect(f.controller.state().budget).toEqual(budget);
 await writeFile(join(f.controller.workRoot,'method.mjs'),method);expect((await f.controller.dispatch('experiment_acceptance_table_method',f.params)).ok).toBe(true);
 const modified=await f.read();modified.lots[0]!.items[0]!.note={value:'',evidence:[],reason:'Hand-edited after experiment'};await writeFile(f.path,JSON.stringify(modified));
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'})).toMatchObject({error:'executable_method_trial_required'});
 expect((await f.controller.dispatch('experiment_acceptance_table_method',f.params)).ok).toBe(true);
 await writeFile(join(f.controller.workRoot,'method.mjs'),method+'\n// changed implementation\n');
 expect(await f.controller.dispatch('sweep_acceptance_tables',f.params)).toMatchObject({error:'executable_method_trial_required'});
 expect(f.reviewer).not.toHaveBeenCalled();expect(f.controller.state().budget).toEqual(budget);
});

it('does not turn exposed batch members into a holdout after reload or renamed declarations',async()=>{
 const f=await setup();await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});await f.controller.dispatch('sweep_acceptance_tables',f.params);
 const ids=(await f.read()).lots.map(l=>l.id);await f.controller.dispatch('record_acceptance_exposure',{path:'DELIVERY.json',lot_ids:ids,reason:'All were read for method repair.'});
 const reopened=await AcceptanceAutonomousController.open(f.options);
 expect(await reopened.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({ok:false,error:'holdout_sample_unavailable',model_started:false});
 expect(f.reviewer).toHaveBeenCalledTimes(1);expect(reopened.state().training_declarations!.length).toBeGreaterThanOrEqual(3);
});

it.each(['experiment_acceptance_table_method','sweep_acceptance_tables'])('preserves approved semantic additions when %s regenerates different fields',async(tool)=>{
 const f=await setup(datasets[1]);
 // The batch variant reproduces a method whose trial and full-scan branches disagree.
 if(tool==='sweep_acceptance_tables') await writeFile(join(f.controller.workRoot,'method.mjs'),method.replace('outcomes.push(',"if(req.phase==='trial')lot.items[0].note=bound(heading,heading.text);outcomes.push("));
 expect((await f.controller.dispatch('experiment_acceptance_table_method',f.params)).ok).toBe(true);
 if(tool==='experiment_acceptance_table_method'){
  const d=await f.read(),heading=f.source.blocks[0]!;
  d.lots[0]!.items[0]!.note={value:heading.text,evidence:[sourceQuote(f.source,heading)]};
  await writeFile(f.path,JSON.stringify(d));
 }
 expect((await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'})).ok).toBe(true);
 const before=await readFile(f.path,'utf8'), state=f.controller.state();
 const result=await f.controller.dispatch(tool,f.params);
 expect(result).toMatchObject({ok:false,error:'sweep_output_conflicts_with_approved_candidates',merged:false,model_started:false,
  actual:{changed_approved_groups:[{group_id:'class',lot_ids:['trial']}]},next_tool:'read'});
 expect(await readFile(f.path,'utf8')).toBe(before);
 expect(f.controller.state().budget).toEqual(state.budget);
 expect(f.controller.state().requests).toEqual(state.requests);
 expect(f.controller.state().approvals).toEqual(state.approvals);
 expect(f.controller.state().table_sweeps).toEqual(state.table_sweeps);
 expect(f.reviewer).toHaveBeenCalledTimes(1);
 const proposed=JSON.parse(await readFile(join(f.controller.workRoot,String((result.next_tool_arguments as {path:string}).path)),'utf8'));
 expect(proposed.lots.find((l:{id:string})=>l.id==='trial').items[0].note.value).toBe('');
 const reopened=await AcceptanceAutonomousController.open(f.options);
 expect(reopened.state().budget).toEqual(state.budget);
 expect((await reopened.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'}))).toMatchObject({ok:true,cached:true});
 expect(f.reviewer).toHaveBeenCalledTimes(1);
 expect(await reopened.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class',mode:'semantic_exception',reason:'程序未覆盖模型补充的来源说明，保留完整当前批并按全成员复核结果作为例外封存。'})).toMatchObject({ok:true,mode:'semantic_exception'});
});

it('allows an identical experiment after full approval and reuses the valid review',async()=>{
 const f=await setup(datasets[1]);
 await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 expect((await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'})).ok).toBe(true);
 const before=await f.read(),state=f.controller.state();
 expect(await f.controller.dispatch('experiment_acceptance_table_method',f.params)).toMatchObject({ok:true,phase:'trial'});
 expect(await f.read()).toEqual(before);
 expect(f.controller.state().approvals).toEqual(state.approvals);
 expect((await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'}))).toMatchObject({ok:true,cached:true});
 expect(f.reviewer).toHaveBeenCalledTimes(1);
 expect(f.controller.state().budget).toEqual(state.budget);
 expect(await f.controller.dispatch('sweep_acceptance_tables',f.params)).toMatchObject({ok:true,processed:3});
 expect((await f.read()).lots.find(lot=>lot.id==='trial')).toEqual(before.lots[0]);
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({ok:true,review_mode:'holdout'});
 expect(f.reviewer.mock.calls.map(([request])=>request.phase)).toEqual(['full','holdout']);
});

it('keeps source discovery metadata separate from actual reading and persists read exposure',async()=>{
 const f=await setup(), tables=f.source.blocks.filter(b=>b.kind==='table');
 await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});
 await f.controller.dispatch('sweep_acceptance_tables',f.params);
 const previous=f.controller.state().training_declarations;
 await f.controller.observeAuthorRead('bash',{command:'node discover.mjs source/ledger.json'},{content:[{type:'text',text:JSON.stringify(tables.map(b=>({id:b.id,lines:b.end_line-b.start_line+1})))}]});
 expect(f.controller.state().training_declarations).toEqual(previous);
 for(const table of tables.slice(1)) await f.controller.observeAuthorRead('read',{path:`source/${f.source.source_id}.md`,offset:table.start_line,limit:table.end_line-table.start_line+1},{content:[{type:'text',text:table.text}]});
 const reopened=await AcceptanceAutonomousController.open(f.options);
 expect(await reopened.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({error:'holdout_sample_unavailable',model_started:false});
 expect(reopened.state().budget).toEqual(f.controller.state().budget);
});

it('counts model extraction scopes even when candidate exposure IDs were not yet available',async()=>{
 const request={id:'extract:test',kind:'extraction',extraction:{task_id:'model-exception',block_ids:['table-a']},exposed_lots:[]} as Parameters<typeof reviewExposures>[1];
 expect(await reviewExposures('unused',request)).toEqual([{lot_id:'model-exception',block_ids:['table-a']}]);
});

it('does not expose ledger bodies from a metadata-only read, and counts only the returned truncated body',async()=>{
 const f=await setup(), path=`source/${f.source.source_id}.json`;
 const ledger=await readFile(join(f.controller.workRoot,path),'utf8'), lines=ledger.split('\n');
 const previous=f.controller.state().training_declarations;
 await f.controller.observeAuthorRead('read',{path,limit:3},{content:[{type:'text',text:lines.slice(0,3).join('\n')+'\n\n[More lines in file]'}]});
 expect(f.controller.state().training_declarations).toEqual(previous);
 const table=f.source.blocks.find(b=>b.kind==='table')!, line=lines.findIndex(text=>text.includes(JSON.stringify(table.text)));
 expect(line).toBeGreaterThan(3);
 await f.controller.observeAuthorRead('read',{path,offset:line+1,limit:2000},{content:[{type:'text',text:lines[line]!.slice(0,60)+'\n[Truncated]'}]});
 expect(f.controller.state().training_declarations).toEqual([...(previous??[]),{lot_id:'author-source-read',block_ids:[table.id]}]);
 const reopened=await AcceptanceAutonomousController.open(f.options);
 expect(reopened.state().training_declarations).toEqual(f.controller.state().training_declarations);
 expect(reopened.state().budget).toEqual(f.controller.state().budget);
});

it('allows explicit full semantic review of a model-handled exception without inventing a reusable program',async()=>{
 const f=await setup(datasets[1]), delivery=await f.read(), table=f.source.blocks.find(b=>b.kind==='table')!;
 const unit=datasets[1]!.lots[0]![0]![2]!, start=table.text.indexOf(unit);
 delivery.lots[0]!.items[0]!.unit={value:unit,evidence:[sourceQuote(f.source,table,start,start+unit.length)]};
 await writeFile(f.path,JSON.stringify(delivery));
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'})).toMatchObject({ok:true,review_mode:'full',holdout_available:false});
 expect(f.reviewer.mock.calls.map(([request])=>request.phase)).toEqual(['full']);
 expect(f.controller.state().table_sweeps ?? []).toHaveLength(0);
 const before=f.controller.state();
 expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class'})).toMatchObject({error:'complete_table_sweep_required'});
 expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class',mode:'semantic_exception'})).toMatchObject({error:'semantic_exception_reason_required'});
 const sealed=await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class',mode:'semantic_exception',reason:'此局部由模型逐字段解释，尚无经过实验验证的批处理方法；全部成员已语义复核。'});
 expect(sealed).toMatchObject({ok:true,class_sealed:true,mode:'semantic_exception',published:false});
 const snapshot=JSON.parse(await readFile(String(sealed.path),'utf8'));
 expect(snapshot).toMatchObject({mode:'semantic_exception',approval:{review_mode:'full'},sweeps:[],published:false});
 expect(snapshot).not.toHaveProperty('sweep');
 const reopened=await AcceptanceAutonomousController.open(f.options);
 expect(reopened.state().budget).toEqual(before.budget);
 expect(reopened.state().training_declarations).toEqual(before.training_declarations);
 expect(reopened.state().requests).toEqual(before.requests);
 expect(reopened.state().group_seals).toHaveLength(1);
 expect(reopened.state().publications).toEqual([]);
});

it('does not relabel a holdout approval as full semantic exception review',async()=>{
 const f=await setup();
 await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});
 await f.controller.dispatch('sweep_acceptance_tables',f.params);
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({review_mode:'holdout'});
 expect(await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class',mode:'semantic_exception',reason:'A reason cannot replace full member review.'})).toMatchObject({error:'semantic_exception_full_review_required'});
 expect(f.controller.state().group_seals??[]).toEqual([]);
});

it('keeps the original scanned scope when switching from program processing to semantic exceptions',async()=>{
 const f=await setup();
 await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});
 await f.controller.dispatch('sweep_acceptance_tables',f.params);
 const d=await f.read(), originalSweeps=f.controller.state().table_sweeps;
 d.groups[0]!.lot_ids=['trial'];d.lots=d.lots.filter(l=>l.id==='trial');
 for(const disposition of d.dispositions)if(!d.lots[0]!.scope.block_ids.includes(disposition.block_id)){
  disposition.role='unresolved';disposition.lot_ids=[];
 }
 await writeFile(f.path,JSON.stringify(d));
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'full'})).toMatchObject({ok:true,review_mode:'full'});
 const sealed=await f.controller.dispatch('seal_acceptance_group',{path:'DELIVERY.json',group_id:'class',mode:'semantic_exception',reason:'This explanation must not erase the original scan scope.'});
 expect(sealed).toMatchObject({ok:false,error:'semantic_exception_scope_incomplete'});
 expect(f.controller.state().table_sweeps).toEqual(originalSweeps);
 expect(f.controller.state().group_seals??[]).toEqual([]);
});

it('makes actual method dependencies available to the reviewer without replacing an earlier snapshot',async()=>{
 const f=await setup(), request={rules:(await f.read()).rules}, directory=join(f.root,'review');
 const files=await freezeReviewMethods(f.controller,request,directory);
 expect(files.map(file=>file.author_path)).toEqual(['method.mjs']);
 expect(await readFile(files[0]!.path,'utf8')).toBe(method);
 expect(await freezeReviewMethods(f.controller,request,directory)).toEqual(files);
 await writeFile(join(f.controller.workRoot,'method.mjs'),method+'\n// modified dependency\n');
 await expect(freezeReviewMethods(f.controller,request,directory)).rejects.toThrow('snapshot differs');
 expect(await readFile(files[0]!.path,'utf8')).toBe(method);
});

it('offers a structural survey and scoped evidence reads without exposing every table',async()=>{
 const f=await setup(), before=f.controller.state(), table=f.source.blocks.find(b=>b.kind==='table')!;
 const overview=await f.controller.dispatch('survey_acceptance_source',{limit:80});
 expect(overview).toMatchObject({ok:true,counts:{heading:3,table:3},next_offset:null});
 expect(JSON.stringify(overview)).not.toContain('虚构甲长度');
 expect(f.controller.state().training_declarations).toEqual(before.training_declarations);
 expect(await f.controller.dispatch('read_acceptance_source_block',{block_id:table.id,start:10,length:35})).toMatchObject({ok:true,start:10,end:45,text:table.text.slice(10,45),exposure_recorded:true});
 expect(f.controller.state().training_declarations).toContainEqual({lot_id:'scoped-source-read',block_ids:[table.id]});
 expect(await f.controller.dispatch('read_acceptance_source_block',{block_id:table.id,start:table.text.length})).toMatchObject({error:'source_block_offset_out_of_range'});
 expect(f.controller.state().budget).toEqual(before.budget);
});

it('routes routine model expansion back to the unfinished class while allowing a concrete scoped exception',async()=>{
 const f=await setup(), extractor=vi.fn(async()=>{throw new Error('isolated model exception fixture');});
 const c=await AcceptanceAutonomousController.open({...f.options,extractor});
 const table=f.source.blocks.filter(b=>b.kind==='table')[1]!;
 const params={path:'DELIVERY.json',tasks:[{id:'next',block_ids:[table.id],method_files:[],instruction:'Handle this source.'}]};
 expect(await c.dispatch('parallel_acceptance_extract',params)).toMatchObject({error:'first_class_workflow_required',model_started:false});
 expect(extractor).not.toHaveBeenCalled();
 const delivery=await f.read();delivery.problems.push({id:'actual-exception',kind:'extraction',message:'Fixture: ambiguous column semantics need a model investigation.',block_ids:[table.id],affected_lot_ids:[],dependency_ids:[]});
 await writeFile(f.path,JSON.stringify(delivery));
 await c.dispatch('parallel_acceptance_extract',params);
 expect(extractor).toHaveBeenCalledTimes(1);
 expect(c.state().budget.max_tool_response_bytes).toBe(f.controller.state().budget.max_tool_response_bytes);
});

it('gives a reviewer exact scoped source blocks and keeps an unread member available for genuine holdout',async()=>{
 const f=await setup();await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});
 const request=f.reviewer.mock.calls[0]![0];
 const contexts=await freezeReviewContexts(request,join(f.root,'context-review'));
 const excerpt=JSON.parse(await readFile(contexts[0]!.path,'utf8'));
 expect(excerpt.blocks).toEqual(f.source.blocks.filter(b=>contexts[0]!.block_ids.includes(b.id)).map(block=>({evidence_id:reviewEvidenceId(f.source,block),...block})));
 expect(excerpt.blocks.some((b:{text:string})=>b.text.includes('虚构甲长度'))).toBe(true);
 expect(excerpt.blocks.some((b:{text:string})=>b.text.includes('虚构乙间距')||b.text.includes('虚构丙尺寸'))).toBe(false);
 await f.controller.recordReviewContextRead(request.id,contexts[0]!.block_ids);
 await f.controller.dispatch('sweep_acceptance_tables',f.params);
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({ok:true,review_mode:'holdout'});
 const whole=await freezeReviewContexts({...request,phase:'inventory'},join(f.root,'inventory-review'));
 expect(JSON.parse(await readFile(whole[0]!.path,'utf8')).blocks).toEqual(f.source.blocks.map(block=>({evidence_id:reviewEvidenceId(f.source,block),...block})));
});

it('records displayed JSON field evidence and reports unavailable holdout before asking for another experiment',async()=>{
 const f=await setup();await f.controller.dispatch('experiment_acceptance_table_method',f.params);
 await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'trial'});await f.controller.dispatch('sweep_acceptance_tables',f.params);
 const delivery=await f.read();
 for(const lot of delivery.lots.slice(1)) await f.controller.observeAuthorRead('bash',{command:'node inspect-fields.mjs'},{content:[{type:'text',text:JSON.stringify({field:lot.items[0]!.requirement})}]});
 await writeFile(join(f.controller.workRoot,'method.mjs'),method+'\n// changed dependency\n');
 expect(await f.controller.dispatch('review_acceptance_group',{path:'DELIVERY.json',group_id:'class',phase:'complete'})).toMatchObject({error:'holdout_sample_unavailable',model_started:false});
 expect(f.reviewer).toHaveBeenCalledTimes(1);
});
