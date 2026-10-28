import {it,expect} from 'vitest';
import {sharedSourcePrompt} from '../scripts/shared-source-prompt.js';
it('keeps source, instructions and schema identical before the variable target',()=>{
 const a=sharedSourcePrompt('甲\n乙','规则',{a:1},'7.2'),b=sharedSourcePrompt('甲\n乙','规则',{a:1},'7.3');
 expect(a.prefix).toBe(b.prefix);expect(a.content.startsWith(a.prefix)).toBe(true);expect(b.content.startsWith(a.prefix)).toBe(true);expect(a.prefix).toContain('1: 甲\n2: 乙');expect(a.content.slice(a.prefix.length)).toContain('7.2');
});
