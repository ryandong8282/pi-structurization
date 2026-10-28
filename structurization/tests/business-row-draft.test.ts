import {it,expect} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BusinessRowDraft} from '../scripts/business-row-draft.js';
const row={name:'检查',category:'',source_clause:'1',requirement:'要求',method:'',quantity:'',note:'',unit:'',citations:[{fields:['requirement'],start_line:1,end_line:1,quote:'要求'}]};
it('persists batches atomically, replaces stable keys and assembles valid JSON without model closing brackets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'row-draft-'));try{
 const d=new BusinessRowDraft(dir,['要求']);
 expect((await d.dispatch('finish_rows',{uncertainties:[]})).ok).toBe(false);
 expect((await d.dispatch('save_rows',{entries:[{key:'a',row}]})).ok).toBe(true);
 const before=await readFile(join(dir,'draft.json'),'utf8');
 expect((await d.dispatch('save_rows',{entries:[{key:'b',row},{key:'a',row:{...row,method:undefined}}]})).ok).toBe(false);
 expect(await readFile(join(dir,'draft.json'),'utf8')).toBe(before);
 expect((await d.dispatch('save_rows',{entries:[{key:'a',row:{...row,name:'改名'}}]})).ok).toBe(true);
 expect((await d.dispatch('finish_rows',{uncertainties:['未写方法']})).ok).toBe(true);
 expect(d.result?.rows).toHaveLength(1);expect(d.result?.rows[0]?.name).toBe('改名');
 expect(d.result?.uncertainties).toEqual(['未写方法']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('rejects damaged arguments, duplicate keys, oversized batches and ungrounded quotes without saving',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'row-draft-'));try{
 const d=new BusinessRowDraft(dir,['要求']);
 for(const args of [null,{entries:'broken'},{entries:[{key:'a',row},{key:'a',row}]},{entries:Array.from({length:17},(_,i)=>({key:String(i),row}))},{entries:[{key:'a',row:{...row,citations:[{...row.citations[0],quote:'不存在'}]}}]}]) expect((await d.dispatch('save_rows',args)).ok).toBe(false);
 expect((await d.dispatch('finish_rows',{uncertainties:null})).ok).toBe(false);
 await expect(readFile(join(dir,'draft.json'))).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
