import {it,expect,vi} from 'vitest';
import {repairCitationLinks,applyCitationLinks} from '../scripts/citation-link-repair.js';
const lines=['设计值','检查记录'];
const row={name:'项目',category:'',source_clause:'1',requirement:'设计值',method:'检查记录',quantity:'',note:'',unit:'',citations:[{fields:['method'],start_line:2,end_line:2,quote:'检查记录'}]};
const value={rows:[row]},link={index:0,field:'requirement',start_line:1,end_line:1};
it('adds only missing links preserving business content and existing citations',()=>{
 const after=applyCitationLinks(value,{links:[link],unresolved:[]},lines);expect(after.rows[0].requirement).toBe(row.requirement);expect(after.rows[0].citations[0]).toBe(row.citations[0]);expect(after.rows[0].citations[1].quote).toBe('设计值');expect(value.rows[0].citations).toHaveLength(1);expect(after).not.toHaveProperty('uncertainties');
});
it('rejects unflagged fields, row edits, invalid ranges and duplicates',()=>{
 for(const patch of [{links:[{...link,field:'method'}],unresolved:[]},{links:[link],unresolved:[],rows:[]},{links:[{...link,end_line:99}],unresolved:[]},{links:[link,link],unresolved:[]}])expect(()=>applyCitationLinks(value,patch,lines)).toThrow();
});
it('requires accounting and preserves unresolved facts',async()=>{
 expect(()=>applyCitationLinks(value,{links:[],unresolved:[]},lines)).toThrow('every');
 const ask=vi.fn().mockResolvedValue({links:[],unresolved:[{index:0,field:'requirement',reason:'无法证实'}]});const result=await repairCitationLinks(value,lines,ask);expect(result.value).toEqual(value);expect(ask).toHaveBeenCalledTimes(1);
});
it('skips healthy results and does not retry invalid patches',async()=>{
 const healthy=applyCitationLinks(value,{links:[link],unresolved:[]},lines);const ask=vi.fn();expect((await repairCitationLinks(healthy,lines,ask)).attempted).toBe(false);expect(ask).not.toHaveBeenCalled();
 const bad=vi.fn().mockResolvedValue({});await expect(repairCitationLinks(value,lines,bad)).rejects.toThrow();expect(bad).toHaveBeenCalledTimes(1);
});
it('does not misclassify other citation errors as missing links',async()=>{
 const ask=vi.fn();await expect(repairCitationLinks({rows:[{...row,citations:[{...row.citations[0],quote:'不存在'}]}]},lines,ask)).rejects.toThrow('other error');expect(ask).not.toHaveBeenCalled();
});
