import { Ajv } from 'ajv';
import { rowSchema, validateResult, type Result } from './minimal-extraction-core.js';
const obj=(properties:any)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string',minLength:1}, arr=(items:any)=>({type:'array',items});
export const mapSchema=obj({facts:arr(obj({id:str,kind:{enum:['requirement','method','sampling','lot','context']},object:str,text:str,condition:{type:'string'},applies_to:arr(str),start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1}})),uncertainties:arr(str)});
const fields=['requirement','method','quantity','note','unit'];
export const projectionSchema=obj({rows:arr(obj({...Object.fromEntries(Object.entries(rowSchema.properties).filter(([k])=>k!=='citations')),supports:arr(obj({field:{enum:fields},fact_ids:{...arr(str),minItems:1}}))})),excluded:arr(obj({fact_id:str,reason:str})),uncertainties:arr(str)});
const ajv=new Ajv({allErrors:true}), checkMap=ajv.compile<any>(mapSchema),checkProjection=ajv.compile<any>(projectionSchema);
export function validateMap(map:any,lines:string[]):string[]{
 if(!checkMap(map))return [JSON.stringify(checkMap.errors)];
 const errors:string[]=[], ids=new Set<string>();
 for(const f of map.facts){if(ids.has(f.id))errors.push(`Duplicate fact id ${f.id}; assign unique ids`);ids.add(f.id);if(f.end_line<f.start_line||f.end_line>lines.length||f.end_line-f.start_line>=200)errors.push(`Fact ${f.id}: source range must be ordered within1-${lines.length}, at most200lines`);}
 for(const f of map.facts)for(const id of f.applies_to)if(!ids.has(id))errors.push(`Fact ${f.id}: unknown applies_to ${id}; use an existing fact id`);
 if(!ids.size)errors.push('facts must not be empty');return errors;
}
/** Mapping completeness is bookkeeping, NOT semantic coverage or entailment. */
export function projectMap(map:any,p:any,lines:string[]):{result:Result;errors:string[];used:string[]}{
 const errors=validateMap(map,lines);if(errors.length)return {result:{rows:[],uncertainties:[]},errors,used:[]};
 if(!checkProjection(p))return {result:{rows:[],uncertainties:[]},errors:[JSON.stringify(checkProjection.errors)],used:[]};
 const facts=new Map<string,any>(map.facts.map((f:any)=>[f.id,f])),used=new Set<string>(),excluded=new Set<string>();
 const rows=p.rows.map((r:any,i:number)=>{const {supports,...row}=r;const citations:any[]=[];
  for(const s of supports)for(const id of s.fact_ids){const f=facts.get(id);if(!f){errors.push(`Row ${i}: unknown fact ${id}; reference an existing fact`);continue;}used.add(id);citations.push({fields:[s.field],start_line:f.start_line,end_line:f.end_line,quote:lines.slice(f.start_line-1,f.end_line).join('\n')});}
  return {...row,citations};});
 for(const x of p.excluded){if(!facts.has(x.fact_id)||excluded.has(x.fact_id)||used.has(x.fact_id))errors.push(`Invalid/duplicate/used exclusion ${x.fact_id}; each exclusion must name one unused existing fact`);excluded.add(x.fact_id);}
 for(const id of facts.keys())if(!used.has(id)&&!excluded.has(id))errors.push(`Unaccounted fact ${id}; map it to a row field or explicitly explain exclusion`);
 const result={rows,uncertainties:[...map.uncertainties,...p.uncertainties,...p.excluded.map((x:any)=>`Excluded ${x.fact_id}: ${x.reason}`)]};
 errors.push(...validateResult(result,lines));return {result,errors,used:[...used]};
}
export const projectionPatchSchema=obj({changes:arr(obj({index:{type:'integer',minimum:0},row:projectionSchema.properties.rows.items})),additions:projectionSchema.properties.rows,remove_indices:arr({type:'integer',minimum:0}),excluded:projectionSchema.properties.excluded,uncertainties:projectionSchema.properties.uncertainties,findings:arr(str)});
const checkPatch=ajv.compile<any>(projectionPatchSchema);
export function applyProjectionPatch(before:any,patch:any):any{
 if(!checkPatch(patch))throw new Error(`Invalid review patch: ${JSON.stringify(checkPatch.errors)}; provide changes/additions/remove_indices/excluded/uncertainties/findings`);
 const indices=[...patch.changes.map((x:any)=>x.index),...patch.remove_indices];
 if(indices.some((i:number)=>i>=before.rows.length)||new Set(indices).size!==indices.length)throw new Error(`Review indices must be distinct, disjoint and within0-${before.rows.length-1}; correct changes/remove_indices`);
 return {rows:[...before.rows.flatMap((r:any,i:number)=>patch.remove_indices.includes(i)?[]:[patch.changes.find((x:any)=>x.index===i)?.row??r]),...patch.additions],excluded:patch.excluded,uncertainties:patch.uncertainties};
}
