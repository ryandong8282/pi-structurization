import { Ajv } from 'ajv';
import { inspectExtraction } from './minimal-extraction-core.js';
const object=(properties:any)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string={type:'string',minLength:1};
export const citationLinkSchema=object({
 links:{type:'array',items:object({index:{type:'integer',minimum:0},field:{enum:['requirement','method','quantity','note','unit']},start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1}})},
 unresolved:{type:'array',items:object({index:{type:'integer',minimum:0},field:string,reason:string})},
});
const check=new Ajv({allErrors:true}).compile<any>(citationLinkSchema);
export function missingCitationLinks(value:any,lines:string[]){
 const errors=inspectExtraction(value,lines).errors;
 const missing:Array<{index:number;field:string}>=[];
 for(const error of errors){
  const m=/^\/rows\/(\d+)\/citations: populated (requirement|method|quantity|note|unit) has no citation;/u.exec(error);
  if(!m)throw new Error(`Citation-link repair only accepts missing field links; retain other error: ${error}`);
  missing.push({index:Number(m[1]),field:m[2]!});
 }
 return missing;
}
export function applyCitationLinks(value:any,patch:any,lines:string[]){
 if(!check(patch))throw new Error(`Invalid citation patch: ${JSON.stringify(check.errors)}. Return only links and unresolved; no row edits.`);
 const missing=missingCitationLinks(value,lines),key=(x:any)=>`${x.index}:${x.field}`;
 const allowed=new Set(missing.map(key)),seen=new Set<string>(),unresolved=new Set<string>();
 for(const link of patch.links){
  if(!allowed.has(key(link)))throw new Error('Link targets an unflagged field; only repair listed index/field pairs');
  if(link.end_line<link.start_line||link.end_line>lines.length||link.end_line-link.start_line>=200||!lines.slice(link.start_line-1,link.end_line).join('\n').trim())throw new Error('Link source must be nonblank, ordered, within document and at most 200 lines');
  const id=JSON.stringify(link);if(seen.has(id))throw new Error('Duplicate citation link');seen.add(id);
 }
 for(const u of patch.unresolved){if(!allowed.has(key(u))||unresolved.has(key(u))||patch.links.some((l:any)=>key(l)===key(u)))throw new Error('Unresolved entries must be unique, flagged and disjoint from repaired fields');unresolved.add(key(u));}
 for(const m of missing)if(!unresolved.has(key(m))&&!patch.links.some((l:any)=>key(l)===key(m)))throw new Error('Account for every flagged field with links or unresolved; do not silently drop a field');
 return {...value,rows:value.rows.map((row:any,index:number)=>{
  const links=patch.links.filter((l:any)=>l.index===index);
  return links.length?{...row,citations:[...row.citations,...links.map((l:any)=>({fields:[l.field],start_line:l.start_line,end_line:l.end_line,quote:lines.slice(l.start_line-1,l.end_line).join('\n')}))]}:row;
 })};
}
export async function repairCitationLinks(value:any,lines:string[],ask:(missing:any[],schema:any)=>Promise<any>){
 const missing=missingCitationLinks(value,lines);
 if(!missing.length)return {value,attempted:false,patch:null,missing};
 const patch=await ask(missing,citationLinkSchema);
 return {value:applyCitationLinks(value,patch,lines),attempted:true,patch,missing};
}
