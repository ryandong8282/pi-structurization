import { describe,it,expect } from 'vitest';
import {validateMap,projectMap} from '../scripts/requirement-map-core.js';
const lines=['厚度符合设计要求','防水时不少于4间'];
const map={facts:[{id:'a',kind:'requirement',object:'面层',text:lines[0],condition:'',applies_to:[],start_line:1,end_line:1},{id:'b',kind:'sampling',object:'面层',text:lines[1],condition:'防水',applies_to:['a'],start_line:2,end_line:2}],uncertainties:[]};
const row={name:'厚度',category:'',source_clause:'1',requirement:lines[0],method:'',quantity:lines[1],note:'',unit:'',supports:[{field:'requirement',fact_ids:['a']},{field:'quantity',fact_ids:['b']}]};
describe('requirement-map prototype accounting',()=>{
 it('takes source text from immutable lines and preserves missing method',()=>{const r=projectMap(map,{rows:[row],excluded:[],uncertainties:[]},lines);expect(r.errors).toEqual([]);expect(r.result.rows[0]?.method).toBe('');expect(r.result.rows[0]?.citations[1]?.quote).toBe(lines[1]);});
 it('rejects a silently dropped fact',()=>{expect(projectMap(map,{rows:[{...row,quantity:'',supports:[row.supports[0]]}],excluded:[],uncertainties:[]},lines).errors.join()).toContain('Unaccounted fact b');});
 it('rejects dangling relationships and invalid source spans',()=>{expect(validateMap({...map,facts:[{...map.facts[0],applies_to:['missing'],end_line:99}]},lines).length).toBe(2);});
 it('does not allow a used fact also to be excluded',()=>{expect(projectMap(map,{rows:[row],excluded:[{fact_id:'a',reason:'no method'}],uncertainties:[]},lines).errors.join()).toContain('Invalid/duplicate/used exclusion');});
});
import {applyProjectionPatch} from '../scripts/requirement-map-core.js';
it('applies only explicitly changed rows without mutating the candidate',()=>{const before={rows:[row,{...row,name:'other'}],excluded:[],uncertainties:[]};const patch={changes:[{index:0,row:{...row,quantity:'corrected'}}],additions:[],remove_indices:[],excluded:[],uncertainties:[],findings:[]};const after=applyProjectionPatch(before,patch);expect(after.rows[1]).toBe(before.rows[1]);expect(before.rows[0]?.quantity).toBe(lines[1]);expect(after.rows[0].quantity).toBe('corrected');expect(()=>applyProjectionPatch(before,{...patch,remove_indices:[0]})).toThrow('disjoint');});
