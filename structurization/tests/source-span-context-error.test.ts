import {expect,it} from 'vitest';
import {initialSourceSpanRegistry,locateAndRegisterSourceQuote,SourceSpanRegistryError} from '../src/source-span-registry.js';
it('reports a mismatched context instead of claiming an existing quote is missing',()=>{
 const registry=initialSourceSpanRegistry('source');const source={source_id:'e30',text:'采用三轴搅拌桩,取芯数量不宜少于1%'};
 try{locateAndRegisterSourceQuote(registry,source,'采用三轴搅拌桩',{suffix:'，'});throw new Error('expected rejection');}
 catch(e){expect(e).toBeInstanceOf(SourceSpanRegistryError);const issue=(e as SourceSpanRegistryError).issues[0]!;expect(issue.path).toBe('/suffix');expect(issue.message).toContain('quote 存在');expect(issue.details).toMatchObject({quote_match_count:1,match_count:0,next_tool:'locate_evidence_span',actual:{suffix:'，'},writable_paths:['/prefix','/suffix']});}
 expect(registry.spans).toEqual([]);
 expect(locateAndRegisterSourceQuote(registry,source,'采用三轴搅拌桩',{suffix:','}).spans).toHaveLength(1);
 expect(locateAndRegisterSourceQuote(registry,source,'采用三轴搅拌桩').spans).toHaveLength(1);
});
it('continues rejecting missing and ambiguous quotes',()=>{
 const r=initialSourceSpanRegistry('s'),s={source_id:'e',text:'甲，甲。'};
 for(const q of ['不存在','甲'])expect(()=>locateAndRegisterSourceQuote(r,s,q)).toThrow(SourceSpanRegistryError);
 expect(locateAndRegisterSourceQuote(r,s,'甲',{suffix:'。'}).spans).toHaveLength(1);
});


function quoteIssue(text: string, quote: string, context: { prefix?: string; suffix?: string } = {}) {
 const registry = initialSourceSpanRegistry('fictional-source');
 const source = { source_id: 'fictional-evidence', text };
 try { locateAndRegisterSourceQuote(registry, source, quote, context); }
 catch (error) {
  expect(error).toBeInstanceOf(SourceSpanRegistryError);
  expect(registry.spans).toEqual([]);
  return { registry, source, issue: (error as SourceSpanRegistryError).issues[0]!, details: (error as SourceSpanRegistryError).issues[0]!.details as any };
 }
 throw new Error('expected ambiguous or mismatched quote');
}

it('returns verified contexts for long repeated fictional table cells', () => {
 const quote = '按虚构表 XQ.2 执行';
 const padding = '相同文字'.repeat(20);
 const text = ['甲', '乙', '丙'].map(label => label + padding + quote + padding + label).join(' | ');
 const { registry, source, details } = quoteIssue(text, quote);
 expect(details.quote_match_count).toBe(3);
 expect(details.disambiguation_candidates).toHaveLength(3);
 for (const candidate of details.disambiguation_candidates) {
  expect(candidate).toMatchObject({ context_unique: true, context_match_count: 1 });
  expect(candidate.prefix.length).toBeGreaterThan(48);
  const located = locateAndRegisterSourceQuote(registry, source, quote, candidate);
  expect(located.spans[0]).toMatchObject({ start: candidate.start, end: candidate.end });
 }
 expect(registry.spans).toEqual([]);
});

it('bounds ambiguous context receipts and gives a routed read path instead of promising success', () => {
 const quote = '虚构检查文字';
 const padding = '重复'.repeat(600);
 const text = ['甲', '乙', '丙'].map(label => label + padding + quote + padding + label).join(' | ');
 const { registry, source, details } = quoteIssue(text, quote);
 expect(details.context_character_limit).toBe(384);
 expect(details.context_read).toMatchObject({ tool: 'list_evidence_resources', arguments: { cursor: 0, limit: 24 }, evidence_id: source.source_id });
 expect(details.required_action).toContain('context_unique=true');
 expect(details.required_action).toContain('仍有歧义');
 for (const candidate of details.disambiguation_candidates) {
  expect(candidate).toMatchObject({ context_unique: false, context_match_count: 3, context_window_truncated: true });
  expect(candidate.prefix.length).toBeLessThanOrEqual(384);
  expect(candidate.suffix.length).toBeLessThanOrEqual(384);
  expect(() => locateAndRegisterSourceQuote(registry, source, quote, candidate)).toThrow(SourceSpanRegistryError);
 }
 expect(locateAndRegisterSourceQuote(registry, source, quote, { prefix: '乙' + padding }).spans).toHaveLength(1);
});

it('checks candidate uniqueness against matches beyond the twelve returned candidates', () => {
 const quote = '虚构指针';
 const padding = '共同'.repeat(250);
 const repeated = padding + quote + padding;
 const text = [repeated, ...Array.from({ length: 11 }, (_, index) => '序号' + index + quote + '尾号' + index), repeated].join(' | ');
 const { details } = quoteIssue(text, quote);
 expect(details.quote_match_count).toBe(13);
 expect(details.disambiguation_candidates).toHaveLength(12);
 expect(details.disambiguation_candidates[0]).toMatchObject({ context_unique: false, context_match_count: 2 });
});

it('verifies boundary contexts without inventing source boundary markers', () => {
 const quote = '虚构值';
 const { registry, source, details } = quoteIssue(quote.repeat(3), quote);
 for (const candidate of details.disambiguation_candidates) {
  expect(candidate).toMatchObject({ context_unique: true, context_match_count: 1, context_window_truncated: false });
  expect(source.text.slice(0, candidate.start).endsWith(candidate.prefix)).toBe(true);
  expect(source.text.slice(candidate.end).startsWith(candidate.suffix)).toBe(true);
  expect(locateAndRegisterSourceQuote(registry, source, quote, candidate).spans[0]).toMatchObject({ start: candidate.start, end: candidate.end });
 }
});

it('does not claim full-source contexts can distinguish coincident normalized matches', () => {
 const { registry, source, details } = quoteIssue('ﬃ', 'f');
 expect(details.quote_match_count).toBe(2);
 for (const candidate of details.disambiguation_candidates) {
  expect(candidate).toMatchObject({ start: 0, end: 1, prefix: '', suffix: '', context_unique: false, context_match_count: 2, context_window_truncated: false });
  expect(() => locateAndRegisterSourceQuote(registry, source, 'f', candidate)).toThrow(SourceSpanRegistryError);
 }
 expect(details.required_action).toContain('无法区分');
});

it('repairs mismatched contexts without changing the quote and preserves normalized source spans', () => {
 const quote = '宽度';
 const padding = '共同上下文'.repeat(12);
 const text = ['甲', '乙'].map(label => label + padding + '**宽　度**' + padding + label).join(' | ');
 const { registry, source, issue, details } = quoteIssue(text, quote, { prefix: '不存在的前文' });
 expect(issue.path).toBe('/prefix');
 expect(details).toMatchObject({ match_count: 0, quote_match_count: 2, writable_paths: ['/prefix', '/suffix'] });
 for (const candidate of details.disambiguation_candidates) {
  expect(candidate.context_unique).toBe(true);
  const located = locateAndRegisterSourceQuote(registry, source, quote, candidate);
  expect(located.normalized).toBe(true);
  expect(source.text.slice(located.spans[0]!.start, located.spans[0]!.end)).toBe('宽　度');
 }
});
