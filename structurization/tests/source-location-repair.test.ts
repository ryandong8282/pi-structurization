import { it, expect, vi } from 'vitest';
import { sourceLocationErrors, applySourceRepair, repairSourceLocations } from '../scripts/source-location-repair.js';
const lines=['强度符合设计要求。','','偏差不大于1mm。'];
const map={facts:[{id:'a',text:'强度符合设计要求。',start_line:2,end_line:2},{id:'b',text:'偏差不大于1mm。',start_line:3,end_line:3}],uncertainties:[]};
it('detects blank and out-of-range references but does not pretend to check entailment',()=>{
 expect(sourceLocationErrors(map,lines).map(e=>e.fact_id)).toEqual(['a']);
 expect(sourceLocationErrors({facts:[{id:'a',start_line:4,end_line:4}]},lines)[0]?.reason).toBe('invalid_range');
 expect(sourceLocationErrors({facts:[{id:'a',text:'unsupported',start_line:1,end_line:1}]},lines)).toEqual([]);
});
it('repairs only flagged source coordinates and preserves facts',()=>{
 const next=applySourceRepair(map,{repairs:[{fact_id:'a',start_line:1,end_line:1}],unresolved:[]},lines);
 expect(next.facts[0]).toEqual({...map.facts[0],start_line:1,end_line:1});
 expect(next.facts[1]).toBe(map.facts[1]);expect(map.facts[0]?.start_line).toBe(2);
 expect(()=>applySourceRepair(map,{repairs:[{fact_id:'b',start_line:1,end_line:1}],unresolved:[]},lines)).toThrow('flagged');
});
it('rejects repeated, missing or still invalid repairs',()=>{
 const r={fact_id:'a',start_line:1,end_line:1};
 expect(()=>applySourceRepair(map,{repairs:[r,r],unresolved:[]},lines)).toThrow();
 expect(()=>applySourceRepair(map,{repairs:[],unresolved:[]},lines)).toThrow();
 expect(()=>applySourceRepair(map,{repairs:[{...r,start_line:2,end_line:2}],unresolved:[]},lines)).toThrow('no further retry');
});
it('skips healthy maps without a model call',async()=>{
 const ask=vi.fn();const healthy={facts:[map.facts[1]]};
 expect((await repairSourceLocations(healthy,lines,ask)).attempted).toBe(false);expect(ask).not.toHaveBeenCalled();
});
it('retains unresolved facts and makes at most one attempt',async()=>{
 const ask=vi.fn().mockResolvedValue({repairs:[],unresolved:[{fact_id:'a',reason:'找不到'}]});
 const r=await repairSourceLocations(map,lines,ask);expect(r.map.facts).toEqual(map.facts);expect(ask).toHaveBeenCalledTimes(1);
 const bad=vi.fn().mockResolvedValue({repairs:[],unresolved:[]});
 await expect(repairSourceLocations(map,lines,bad)).rejects.toThrow();expect(bad).toHaveBeenCalledTimes(1);
});
