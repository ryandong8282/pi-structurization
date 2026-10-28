import { describe, expect, it } from 'vitest';
import { buildAcceptanceSourceLedger } from '../src/acceptance-autonomous/source-ledger.js';
import { readSplitLot, splitAcceptanceLots, auditLotSplit, type SplitLayoutChunk, type SplitPdfEvidence } from '../src/acceptance-autonomous/lot-split.js';

const table=(value:string)=>`<table><tr><td>单位工程名称</td><td>主控项目</td></tr><tr><td>${value}</td><td>原文记录</td></tr></table>`;
const form=(name:string,code:string,marker='',value=name)=>[name,marker,code,table(value)].filter(Boolean).join('\n\n');
const split=(text:string)=>{const source=buildAcceptanceSourceLedger(text);return {source,result:splitAcceptanceLots(source)};};

describe('independent full-source lot splitting',()=>{
  it('finds plain and image-mixed titles, keeps notes, and excludes directory lines',()=>{
    const {source,result}=split(['<!-- pages_001_020 -->','# 目录','甲材料检验批质量验收记录....3',
      form('甲材料检验批质量验收记录','910101□□□'), '注：此项附注仅用于甲材料。',
      '![](images/logo.jpg)\n乙材料检验批质量验收记录\n910102□□□',table('乙材料')].join('\n\n'));
    expect(result.summary).toMatchObject({confirmed_lots:2,pending_lots:0,tables:2,unassigned_tables:0});
    expect(result.lots[0]!.parts[0]!.spans.some(s=>s.role==='note')).toBe(true);
    expect(readSplitLot(source,result,result.lots[1]!.id).parts[0]!.spans.map(s=>s.text).join('')).toContain('images/logo.jpg');
    expect(result.directory).toHaveLength(1);
    expect(result.directory[0]!.matching_lot_ids).toEqual([result.lots[0]!.id]);
  });

  it('merges explicitly numbered subpages across misordered physical chunks without modifying source coordinates',()=>{
    const text=['<!-- pages_001_020 -->',form('甲材料检验批质量验收记录','910101□□□','（一）'),
      '<!-- pages_101_120 -->',form('乙材料检验批质量验收记录','910102□□□'),
      '<!-- pages_021_040 -->',form('甲材料检验批质量验收记录','910101□□□','（二）')].join('\n\n');
    const {source,result}=split(text);
    expect(result.lots).toHaveLength(2);
    expect(result.lots[0]!.parts.map(p=>p.continuation)).toEqual([1,2]);
    expect(result.lots[0]!.status).toBe('confirmed');
    expect(result.anomalies.some(a=>a.code==='source_chunks_out_of_physical_order')).toBe(true);
    const input=readSplitLot(source,result,result.lots[0]!.id);
    expect(input.parts[1]!.spans[0]!.text).toContain('甲材料');
    expect(input.parts[1]!.spans[0]!.block_id).toBe(source.blocks.find(b=>b.start>text.indexOf('pages_021_040')&&b.text.includes('甲材料'))!.id);
    expect(result.summary.accounted_characters).toBe(result.summary.source_characters);
  });

  it('keeps Roman form types separate from Chinese subpage numbers',()=>{
    const {result}=split([form('甲材料检验批质量验收记录','910101□□□','（Ⅰ）\n\n（一）'),
      form('甲材料检验批质量验收记录','910101□□□','（Ⅰ）\n\n（二）'),
      form('甲材料检验批质量验收记录','910101□□□','（Ⅱ）')].join('\n\n'));
    expect(result.lots.map(l=>[l.variant,l.parts.length])).toEqual([['I',2],['II',1]]);
    expect(result.summary.confirmed_lots).toBe(2);
  });

  it('retains same-name/code repeats and missing subpages as specific unresolved ranges',()=>{
    const {result}=split([form('甲材料检验批质量验收记录','910101□□□'),
      form('甲材料检验批质量验收记录','910101□□□'),form('乙材料检验批质量验收记录','910102□□□','（三）')].join('\n\n'));
    expect(result.summary).toMatchObject({confirmed_lots:0,pending_lots:3,physical_parts:3});
    expect(new Set(result.lots.map(l=>l.id)).size).toBe(3);
    expect(result.lots[0]!.related_ids[0]!.id).toBe(result.lots[1]!.id);
    expect(result.lots[2]!.reasons.join('')).toContain('（三）');
  });

  it('does not borrow codes from a neighboring lot, and accounts for orphan tables',()=>{
    const {result}=split([table('无标题的原文表'),form('甲材料检验批质量验收记录','910101□□□'),
      form('乙材料检验批质量验收记录','')].join('\n\n'));
    expect(result.summary).toMatchObject({confirmed_lots:1,pending_lots:1,unassigned_tables:1});
    expect(result.lots[1]!.form_codes).toEqual([]);
    expect(result.accounting.filter(a=>a.disposition==='pending')).toHaveLength(1);
  });

  it('splits a footer concatenated with the next title using exact layout fragments',()=>{
    const text=['<!-- pages_001_020 -->',form('甲材料检验批质量验收记录','910101□□□'),
      '虚构资料管理室乙材料检验批质量验收记录','910102□□□',table('乙材料')].join('\n\n');
    const source=buildAcceptanceSourceLedger(text);
    const entries:SplitLayoutChunk['entries']=[
      {type:'text',text:'甲材料检验批质量验收记录',page_idx:0,bbox:[100,60,900,90]},
      {type:'text',text:'910101□□□',page_idx:0}, {type:'table',table_body:table('甲材料检验批质量验收记录'),page_idx:0},
      {type:'footer',text:'虚构资料管理室',page_idx:0,bbox:[100,900,500,950]},
      {type:'text',text:'乙材料检验批质量验收记录',page_idx:1,bbox:[100,60,900,90]},
      {type:'text',text:'910102□□□',page_idx:1},{type:'table',table_body:table('乙材料'),page_idx:1,bbox:[100,120,900,900]}];
    const result=splitAcceptanceLots(source,[{start_page:1,end_page:20,path:'fictional/input.json',sha256:'fictional',entries}]);
    expect(result.lots.map(l=>l.original_name)).toEqual(['甲材料检验批质量验收记录','乙材料检验批质量验收记录']);
    const input=readSplitLot(source,result,result.lots[1]!.id);
    expect(input.parts[0]!.spans.map(s=>s.text).join('')).not.toContain('虚构资料管理室');
    expect(input.parts[0]!.spans.find(s=>s.role==='title')!.pages[0]).toMatchObject({page:2,bbox:[100,60,900,90],entry:4});
    expect(result.summary.missing_layout_entries).toBe(0);
  });

  it('links explicitly shared prose without assigning it twice',()=>{
    const {source,result}=split([form('甲材料检验批质量验收记录','910101□□□'),
      '注：甲材料和乙材料共同适用本页附注。',form('乙材料检验批质量验收记录','910102□□□')].join('\n\n'));
    expect(result.shared).toHaveLength(1);
    expect(result.shared[0]!.lot_ids).toHaveLength(2);
    for(const lot of result.lots){const input=readSplitLot(source,result,lot.id);expect(input.shared).toHaveLength(1);expect(input.parts.flatMap(p=>p.spans).some(s=>s.text.includes('共同适用'))).toBe(false);}
    expect(result.summary.accounted_characters).toBe(result.summary.source_characters);
  });

  it('round-trips every original slice exactly and rejects another source fingerprint',()=>{
    const {source,result}=split(form('甲材料检验批质量验收记录','910101□□□'));
    for(const block of source.blocks){const slices=result.accounting.filter(a=>a.span.block_id===block.id).sort((a,b)=>a.span.start-b.span.start);expect(slices.map(a=>block.text.slice(a.span.start,a.span.end)).join('')).toBe(block.text);}
    expect(()=>readSplitLot({...source,sha256:'changed'},result,result.lots[0]!.id)).toThrow('fingerprint');
  });

  it('keeps both sides pending when consecutive subpages change their original names',()=>{
    const {source,result}=split([form('甲材料安装检验批质量验收记录','910101□□□','（一）'),
      form('甲材料构造检验批质量验收记录','910101□□□','（二）')].join('\n\n'));
    expect(result.lots.map(l=>l.status)).toEqual(['pending','pending']);
    expect(result.lots[0]!.related_ids[0]!.id).toBe(result.lots[1]!.id);
    expect(auditLotSplit(source,result).pending_boundary_groups).toBe(1);
  });

  it('does not promote a wrapped title in the directory into a body batch',()=>{
    const {result}=split(['# 目录','虚构很长的甲材料名称\n检验批质量验收记录\n（Ⅰ）....1\n乙材料检验批质量验收记录....2',
      form('甲材料检验批质量验收记录','910101□□□')].join('\n\n'));
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]!.original_name).toBe('甲材料检验批质量验收记录');
  });

  it('isolates an independent form whose heading lost the record-title phrase',()=>{
    const {result}=split([form('甲材料检验批质量验收记录','910101□□□'),
      '# 乙材料安装','910102□□□',table('乙材料')].join('\n\n'));
    expect(result.lots).toHaveLength(2);
    expect(result.lots[1]!.status).toBe('pending');
    expect(result.lots[1]!.form_codes).toEqual(['910102□□□']);
    expect(result.lots[0]!.parts[0]!.spans.filter(s=>s.role==='table')).toHaveLength(1);
  });

  it('exports only this batch’s footer occurrences, keeping other batches out of its input',()=>{
    const text=['<!-- pages_001_020 -->',...['甲材料','乙材料','丙材料'].map((name,i)=>
      `${form(`${name}检验批质量验收记录`,`${910101+i}□□□`)}\n\n虚构页脚`)].join('\n\n');
    const source=buildAcceptanceSourceLedger(text);
    const entries=['甲材料','乙材料','丙材料'].flatMap((name,i)=>[
      {type:'text',text:`${name}检验批质量验收记录`,page_idx:i,bbox:[100,70,900,95]},
      {type:'text',text:`${910101+i}□□□`,page_idx:i},
      {type:'table',table_body:table(`${name}检验批质量验收记录`),page_idx:i},
      {type:'footer',text:'虚构页脚',page_idx:i,bbox:[100,900,900,950]}]);
    const result=splitAcceptanceLots(source,[{start_page:1,end_page:20,path:'fictional/input.json',sha256:'fictional',entries}]);
    expect(result.shared).toHaveLength(1);
    const input=readSplitLot(source,result,result.lots[1]!.id);
    expect(input.shared[0]!.spans).toHaveLength(1);
    expect(input.shared[0]!.spans[0]!.pages.map(p=>p.page)).toEqual([2]);
  });

  const pdfFixture=(secondCode='910101□□□')=>{
    const name='甲材料检验批质量验收记录';
    const source=buildAcceptanceSourceLedger(['<!-- pages_001_020 -->',form(name,'910101□□□','','甲页'),form(name,'','','乙页')].join('\n\n'));
    const layouts:SplitLayoutChunk[]=[{start_page:1,end_page:20,path:'fictional/input.json',sha256:'fictional',entries:[
      {type:'text',text:name,page_idx:0},{type:'text',text:'910101□□□',page_idx:0},{type:'table',table_body:table('甲页'),page_idx:0,bbox:[100,120,900,900]},
      {type:'text',text:name,page_idx:1},{type:'table',table_body:table('乙页'),page_idx:1,bbox:[100,120,900,900]}]}];
    const pdf:SplitPdfEvidence={schema_version:'lot-split-pdf-text/v1',path:'fictional.pdf',sha256:'fictional-pdf',pages:[1,2].map((page,i)=>({
      page,width:100,height:100,lines:[{text:name,bbox:[10,5,90,8]},{text:i?'（二）':'（一）',bbox:[40,9,60,11]},
        {text:i?secondCode:'910101□□□',bbox:[75,11,95,15]}]}))};
    return {source,layouts,pdf};
  };

  it('uses exact original PDF markers and a code below the table’s top to resolve omitted Markdown metadata',()=>{
    const f=pdfFixture(),result=splitAcceptanceLots(f.source,f.layouts,f.pdf);
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]!.status).toBe('confirmed');
    expect(result.lots[0]!.parts.map(p=>p.continuation)).toEqual([1,2]);
    expect(result.lots[0]!.parts[1]!.pdf_header).toMatchObject({pdf_sha256:'fictional-pdf',page:2,coordinate_unit:'PDF_points'});
    expect(auditLotSplit(f.source,result,f.pdf).passed).toBe(true);
  });

  it('keeps incompatible original PDF codes unresolved instead of merging a different form',()=>{
    const f=pdfFixture('910102□□□'),result=splitAcceptanceLots(f.source,f.layouts,f.pdf);
    expect(result.lots).toHaveLength(2);
    expect(result.lots.every(l=>l.status==='pending')).toBe(true);
  });

  it('reports a missing source interval and a new independent table swallowed by the previous title',()=>{
    const {source,result}=split([form('甲材料检验批质量验收记录','910101□□□'),table('另一个无标题独立表')].join('\n\n'));
    expect(auditLotSplit(source,result).errors.some(e=>e.code==='possible_cross_lot_table')).toBe(true);
    result.accounting.shift();
    expect(auditLotSplit(source,result).errors.some(e=>e.code==='source_incomplete')).toBe(true);
  });

  it('retains a layout page conflict as evidence and uses the original PDF’s exact title coordinate',()=>{
    const name='甲材料检验批质量验收记录';
    const source=buildAcceptanceSourceLedger(['<!-- pages_001_020 -->',form(`虚构页脚${name}`,'910101□□□')].join('\n\n'));
    const layouts:SplitLayoutChunk[]=[{start_page:1,end_page:20,path:'fictional/input.json',sha256:'fictional',entries:[
      {type:'text',text:`虚构页脚${name}`,page_idx:0,bbox:[100,900,900,950]},
      {type:'table',table_body:table(`虚构页脚${name}`),page_idx:1,bbox:[100,120,900,900]}]}];
    const pdf:SplitPdfEvidence={schema_version:'lot-split-pdf-text/v1',path:'fictional.pdf',sha256:'fictional',pages:[
      {page:2,width:100,height:100,lines:[{text:name,bbox:[10,5,90,8]},{text:'910101□□□',bbox:[75,9,95,11]}]}]};
    const result=splitAcceptanceLots(source,layouts,pdf),title=result.lots[0]!.parts[0]!.spans.find(s=>s.role==='title')!;
    expect(result.lots[0]!.original_name).toBe(name);
    expect(title.pages.map(p=>p.page)).toEqual([2]);
    expect(result.anomalies.find(a=>a.code==='layout_page_conflict_resolved_by_original_pdf')!.layout_locations![0]!.page).toBe(1);
  });
});
