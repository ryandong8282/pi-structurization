import { it, expect } from 'vitest';
import { inspectExtraction, validateResult } from '../scripts/minimal-extraction-core.js';
const lines=['要求'];const row={name:'检查',category:'',source_clause:'1',requirement:'要求',method:'',quantity:'',note:'',unit:'',citations:[{fields:['requirement'],start_line:1,end_line:1,quote:'要求'}]};
it('accepts intact rows without claiming missing uncertainty notes are empty',()=>{
 const value={rows:[row]};const r=inspectExtraction(value,lines);expect(r.errors).toEqual([]);expect(r.uncertainty_status).toBe('not_returned');expect(r.notices).toHaveLength(1);expect(value).not.toHaveProperty('uncertainties');
});
it('distinguishes explicit empty notes and rejects malformed notes',()=>{
 expect(inspectExtraction({rows:[row],uncertainties:[]},lines).uncertainty_status).toBe('returned');expect(inspectExtraction({rows:[row],uncertainties:null},lines).errors.length).toBeGreaterThan(0);
});
it('still rejects missing business fields and false citations',()=>{
 expect(inspectExtraction({rows:[{...row,requirement:undefined}]},lines).errors.length).toBeGreaterThan(0);
 expect(inspectExtraction({rows:[{...row,citations:[{...row.citations[0],quote:'无依据'}]}]},lines).errors.length).toBeGreaterThan(0);
});

it('retains an explicit preconstruction inspection with no stated method and grounded minimum quantity',()=>{
 const source='施工前应进行试成孔，数量根据工程规模和地层特点确定，且不宜少于2个。';
 const inspection={...row,name:'试成孔',source_clause:'7.2.2',requirement:'施工前应进行试成孔',method:'',quantity:'根据工程规模和地层特点确定，且不宜少于2个',citations:[{fields:['requirement','quantity'],start_line:1,end_line:1,quote:source}]};
 expect(validateResult({rows:[inspection],uncertainties:['原文未单列检验方法']},[source])).toEqual([]);
 expect(validateResult({rows:[{...inspection,method:undefined}],uncertainties:[]},[source]).length).toBeGreaterThan(0);
 expect(validateResult({rows:[{...inspection,citations:[{...inspection.citations[0],fields:['requirement']}]}],uncertainties:[]},[source]).some(e=>e.includes('populated quantity has no citation'))).toBe(true);
});
