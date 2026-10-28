import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { rowSchema, validateResult, type Row, type Result } from './minimal-extraction-core.js';

export const businessDraftTools = [
 {name:'save_rows',description:'原子保存一批完整业务行。key是你自定的稳定短标识；同key替换，不同key新增。失败整批不保存，按返回路径修改这一批。',parameters:{type:'object',additionalProperties:false,required:['entries'],properties:{entries:{type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['key','row'],properties:{key:{type:'string',minLength:1},row:rowSchema}}}}}},
 {name:'finish_rows',description:'确认全部目标要求已交付，程序组装最终JSON。只检查格式/引用，不证明语义完整。',parameters:{type:'object',additionalProperties:false,required:['uncertainties'],properties:{uncertainties:{type:'array',items:{type:'string'}}}}},
];
export const batchSubmissionInstruction='通过save_rows分批提交业务字段，每批最多16行，稳定key用于局部替换。程序持久保存成功批次；失败只重交该批，不重复创建已保存项目。不要在最终文字中输出整张表。确认目标及适用引用全部处理后调用finish_rows并提交uncertainties。这些工具只检查格式和字面引用，不判断内容完整性。';

export class BusinessRowDraft {
 private rows = new Map<string,Row>();
 result: Result | undefined;
 constructor(private directory:string,private lines:string[]) {}
 async dispatch(name:string,args:any) {
  if(this.result) return {ok:false,instruction:'Already finished; do not submit more rows.'};
  if(name==='save_rows') {
   if(!args || Object.keys(args).some(k=>k!=='entries') || !Array.isArray(args.entries) || args.entries.length<1 || args.entries.length>16)
    return {ok:false,instruction:'Correct /entries: provide 1–16 objects {key,row} to save_rows. Nothing saved.'};
   const keys=new Set<string>();const errors:string[]=[];
   for(const [i,e] of args.entries.entries()) {
    if(!e || Object.keys(e).some(k=>!['key','row'].includes(k)) || typeof e.key!=='string' || !e.key.trim() || keys.has(e.key)) {errors.push(`/entries/${i}/key: use a nonempty unique key in this batch`);continue;}
    keys.add(e.key);
    errors.push(...validateResult({rows:[e.row],uncertainties:[]},this.lines).map(x=>x.replace('/rows/0',`/entries/${i}/row`)));
   }
   if(errors.length) return {ok:false,errors,instruction:'Nothing in this batch saved. Correct these writable row paths, copy exact quotes from the numbered source, then retry save_rows with the corrected batch. Earlier batches remain saved.'};
   const next=new Map(this.rows);for(const e of args.entries) next.set(e.key,e.row);
   await writeFile(join(this.directory,'draft.tmp'),JSON.stringify({entries:[...next].map(([key,row])=>({key,row}))},null,2));
   await rename(join(this.directory,'draft.tmp'),join(this.directory,'draft.json'));
   this.rows=next;return {ok:true,saved_keys:[...keys],total_rows:next.size,instruction:'Batch persisted. Continue remaining requirements; use the same key to replace a saved row. Call finish_rows when complete.'};
  }
  if(name==='finish_rows') {
   if(!args || Object.keys(args).some(k=>k!=='uncertainties') || !Array.isArray(args.uncertainties) || args.uncertainties.some((x:any)=>typeof x!=='string')) return {ok:false,instruction:'Correct /uncertainties to an array of strings and call finish_rows again.'};
   const persisted=JSON.parse(await readFile(join(this.directory,'draft.json'),'utf8').catch(()=>'{"entries":[]}'));
   const result={rows:persisted.entries.map((e:any)=>e.row),uncertainties:args.uncertainties};
   const errors=validateResult(result,this.lines);if(errors.length) return {ok:false,errors,instruction:'Save valid rows using save_rows before finish_rows.'};
   this.result=result;return {ok:true,total_rows:result.rows.length};
  }
  return {ok:false,instruction:'Use save_rows or finish_rows.'};
 }
}
