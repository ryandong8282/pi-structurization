import { it, expect, vi } from 'vitest';
import { repairJsonFormat, contentTokens } from '../scripts/json-format-repair.js';
it('repairs punctuation without changing keys, conditions or numbers', async () => {
 const bad='{"rows":[{"requirement":"条件不小于50mm","n":50}],"uncertainties":[';
 const ask=vi.fn().mockResolvedValue(bad+']}');
 const r=await repairJsonFormat(bad,ask);expect(r.value.rows[0].n).toBe(50);expect(ask).toHaveBeenCalledTimes(1);
});
it('skips valid JSON even if a downstream schema would reject it',async()=>{
 const ask=vi.fn();expect((await repairJsonFormat('{}',ask)).attempted).toBe(false);expect(ask).not.toHaveBeenCalled();
});
it('rejects content changes and row deletion',async()=>{
 for(const answer of ['{"a":"49mm"}','{}'])await expect(repairJsonFormat('{"a":"50mm",}',vi.fn().mockResolvedValue(answer))).rejects.toThrow('changed content');
});
it('does not loop when repair is invalid',async()=>{
 const ask=vi.fn().mockResolvedValue('{');await expect(repairJsonFormat('{',ask)).rejects.toThrow();expect(ask).toHaveBeenCalledTimes(1);
});
it('refuses unverifiable strings before spending a request',async()=>{
 const ask=vi.fn();await expect(repairJsonFormat('{"a":"unfinished',ask)).rejects.toThrow('Unclosed');expect(ask).not.toHaveBeenCalled();
});
it('handles escaped quotes and punctuation inside strings',()=>{
 expect(contentTokens('{"a":"x,}\\\"y"}')).toEqual(contentTokens('{ "a" : "x,}\\\"y", }'));
});
