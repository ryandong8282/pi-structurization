import { sha256Text } from '../canonical.js';
import type { SourceLedger } from './contracts.js';

/** A read-only preflight. It neither reads author candidates nor produces acceptance fields. */
export interface SplitLayoutChunk {
  start_page: number;
  end_page: number;
  path: string;
  sha256: string;
  entries: Array<{ type: string; page_idx: number; bbox?: number[]; text?: string; table_body?: string;
    img_path?: string; image_caption?: string[]; image_footnote?: string[]; table_caption?: string[]; table_footnote?: string[] }>;
}
export interface SplitLocation {
  page: number;
  /** MinerU's original 0..1000 coordinates; captions inherit their image/table container box. */
  bbox: number[] | null;
  layout_path: string;
  entry: number;
  kind: string;
  basis: 'exact_text' | 'image_reference' | 'caption_container' | 'original_pdf_text';
}
export interface SplitPdfEvidence {
  schema_version: 'lot-split-pdf-text/v1';
  path: string;
  sha256: string;
  pages: Array<{ page: number; width: number; height: number; lines: Array<{ text: string; bbox: number[] }> }>;
}
export interface SplitSpan {
  block_id: string;
  start: number;
  end: number;
  start_line: number;
  end_line: number;
  pages: SplitLocation[];
  page_range: [number, number] | null;
}
type Role = 'title' | 'metadata' | 'table' | 'note' | 'body' | 'image' | 'separator';
interface Atom extends SplitSpan { text: string; kind: string; chunk: number; order: number; layout_type: string[]; conflicting_locations: SplitLocation[] }
export interface SplitPart {
  title: string;
  form_codes: string[];
  variant: string;
  continuation: number | null;
  spans: Array<SplitSpan & { role: Role }>;
  evidence: string[];
  pdf_header?: { pdf_sha256: string; page: number; title: string; lines: Array<{ text: string; bbox: number[] }>; coordinate_unit: 'PDF_points' };
}
export interface SplitLot {
  id: string;
  original_name: string;
  form_codes: string[];
  variant: string;
  status: 'confirmed' | 'pending';
  reasons: string[];
  parts: SplitPart[];
  shared_ids: string[];
  related_ids: Array<{ id: string; reason: string }>;
}
export interface LotSplitManifest {
  schema_version: 'acceptance-lot-split/v1';
  source_id: string;
  source_sha256: string;
  layout_inputs: Array<Omit<SplitLayoutChunk, 'entries'>>;
  pdf_input?: { path: string; sha256: string; page_count: number };
  lots: SplitLot[];
  shared: Array<{ id: string; kind: 'page_furniture' | 'explicit_shared'; spans: SplitSpan[]; lot_ids: string[];
    uses: Array<{ lot_id: string; span_indexes: number[] }>; reason: string }>;
  accounting: Array<{ span: SplitSpan; disposition: 'lot' | 'shared' | 'non_lot' | 'pending'; owner_id: string | null; reason: string }>;
  anomalies: Array<{ code: string; lot_ids: string[]; spans: SplitSpan[]; detail: string; layout_locations?: SplitLocation[] }>;
  directory: Array<{ name: string; span: SplitSpan; matching_lot_ids: string[] }>;
  summary: { confirmed_lots: number; pending_lots: number; physical_parts: number; tables: number; source_blocks: number;
    accounted_blocks: number; source_characters: number; accounted_characters: number; unassigned_tables: number;
    physical_page_ranges: Array<[number, number]>; missing_layout_entries: number; directory_unmatched: number };
}

const clean = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[PDF p\.\d+(?:-\d+)?\]/g, '')
  .replace(/^\s*#{1,6}\s*/, '').replace(/<[^>]*>/g, '').trim();
const normalized = (s: string) => clean(s).normalize('NFKC').replace(/\s+/g, '');
const titlePattern = /检验批(?:质量)?验收记录/u;
const directoryPattern = /(?:\.{2,}|…+|·{3,})\s*\d+\s*$/u;
const sequence = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const ordinal = (s: string) => { const n = s.match(/[（(]([一二三四五六七八九十])[）)]\s*$/u)?.[1]; return n ? sequence.indexOf(n) + 1 : null; };
const variant = (s: string) => s.normalize('NFKC').match(/\(([IVXLCDM]+)\)\s*$/u)?.[1] ?? '';
const codes = (s: string) => [...new Set([...s.matchAll(/(?<!\d)\d{6,}(?:[□口]+)?/gu)].map(m => m[0]))];
const identity = (s: string) => normalized(s).replace(/\([一二三四五六七八九十]\)$/u, '').replace(/\([IVXLCDM]+\)$/u, '');
const spanOf = (a: SplitSpan): SplitSpan => ({ block_id: a.block_id, start: a.start, end: a.end,
  start_line: a.start_line, end_line: a.end_line, pages: a.pages, page_range: a.page_range });

/** Normalized matching retains exact offsets in the immutable Markdown, including mixed paragraphs. */
function mapped(text: string) {
  const skip = [...text.matchAll(/!\[[^\]]*\]\([^)]*\)|<[^>]*>|\[PDF p\.\d+(?:-\d+)?\]|^\s*#{1,6}\s+/gm)]
    .map(m => [m.index!, m.index! + m[0].length]);
  let value = ''; const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length;) {
    const excluded = skip.find(([start, end]) => start! <= i && i < end!);
    if (excluded) { i = excluded[1]!; continue; }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    for (const c of char.normalize('NFKC')) if (!/\s/u.test(c)) { value += c; starts.push(i); ends.push(i + char.length); }
    i += char.length;
  }
  return { value, starts, ends };
}

function sourceAtoms(source: SourceLedger, layouts: SplitLayoutChunk[], pdf?:SplitPdfEvidence) {
  const chunks: Array<{ start: number; end: number; indices: number[] }> = [];
  for (let i = 0; i < source.blocks.length; i++) {
    const b = source.blocks[i]!, marker = b.text.match(/^<!--\s*pages_(\d+)_(\d+)\s*-->$/u);
    if (marker) chunks.push({ start: Number(marker[1]), end: Number(marker[2]), indices: [] });
    if (!chunks.length) chunks.push({ start: 0, end: 0, indices: [] });
    chunks.at(-1)!.indices.push(i);
  }
  const matches = new Map<number, Array<{ start: number; end: number; location: SplitLocation; type: string }>>();
  const missing: Array<{ chunk: SplitLayoutChunk; entry: number; text: string; type: string }> = [];
  for (const chunk of chunks) {
    const layout = layouts.find(row => row.start_page === chunk.start && row.end_page === chunk.end);
    if (!layout) continue;
    let length=0;
    const maps = chunk.indices.map(index => {const result={index,offset:length,...mapped(source.blocks[index]!.text)};length+=result.value.length;return result;});
    const stream=maps.map(m=>m.value).join('');
    type Candidate={start:number;end:number};
    const fragments:Array<{entry:number;rank:number;text:string;type:string;location:SplitLocation;candidates:Candidate[];trusted:boolean}>=[];
    const bounds:Array<{rank:number;start:number;end:number}>=[];
    for (const [entry, raw] of layout.entries.entries()) {
      if (raw.type === 'page_number') continue;
      const location = (basis: SplitLocation['basis']): SplitLocation => ({ page: layout.start_page + raw.page_idx,
        bbox: raw.bbox ?? null, layout_path: layout.path, entry, kind: raw.type, basis });
      if (raw.img_path && raw.type === 'image') {
        const filename = raw.img_path.split('/').at(-1)!;
        const found = maps.find(m => source.blocks[m.index]!.text.includes(filename));
        if (found) {
          const b = source.blocks[found.index]!;
          const image = [...b.text.matchAll(/!\[[^\]]*\]\([^)]*\)/g)].find(m => m[0].includes(filename));
          if (image) { const rows = matches.get(found.index) ?? []; rows.push({ start: image.index!, end: image.index! + image[0].length,
            location: location('image_reference'), type: 'image' }); matches.set(found.index, rows);
            const pos=found.offset+found.starts.filter(s=>s<image.index!).length;bounds.push({rank:entry*100-1,start:pos,end:pos}); }
        } else missing.push({ chunk: layout, entry, text: raw.img_path, type: 'image' });
      }
      const texts = [raw.text, ...(raw.table_caption ?? []), raw.table_body, ...(raw.image_caption ?? []),
        ...(raw.table_footnote ?? []), ...(raw.image_footnote ?? [])].filter((x): x is string => Boolean(x));
      for (const [fi,fragment] of texts.entries()) {
        const target = mapped(fragment).value;
        if (!target) continue;
        const candidates:Candidate[]=[];
        for(let pos=stream.indexOf(target);pos>=0;pos=stream.indexOf(target,pos+1)) {
          const touched=maps.filter(m=>m.offset<pos+target.length&&m.offset+m.value.length>pos);
          if(touched.some(m=>source.blocks[m.index]!.kind==='table')!==Boolean(raw.table_body===fragment))continue;
          if(touched.some(m=>{const p=source.blocks[m.index]!.text.match(/\[PDF p\.(\d+)(?:-(\d+))?\]/u);
            return p&&(location('exact_text').page<Number(p[1])||location('exact_text').page>Number(p[2]??p[1]));}))continue;
          candidates.push({start:pos,end:pos+target.length});
        }
        const trusted=candidates.length===1&&(raw.table_body===fragment
          ||(target.length>=10&&!['footer','header'].includes(raw.type)&&(raw.bbox?.[1]??0)<850));
        const rank=entry*100+fi;
        if(trusted)bounds.push({rank,...candidates[0]!});
        fragments.push({entry,rank,text:fragment,type:raw.type,location:location(raw.type==='image'||(raw.type==='table'&&fragment!==raw.table_body)?'caption_container':'exact_text'),candidates,trusted});
      }
    }
    bounds.sort((a,b)=>a.rank-b.rank);
    for(const f of fragments) {
      const before=bounds.filter(b=>b.rank<f.rank).at(-1),after=bounds.find(b=>b.rank>f.rank);
      const possible=f.trusted?f.candidates:f.candidates.filter(c=>(!before||c.start>=before.end)&&(!after||c.end<=after.start));
      if(possible.length!==1){missing.push({chunk:layout,entry:f.entry,text:`${possible.length} 个唯一顺序内匹配：${f.text.slice(0,180)}`,type:f.type});continue;}
      const c=possible[0]!;
      for(const m of maps.filter(m=>m.offset<c.end&&m.offset+m.value.length>c.start)) {
        const b=source.blocks[m.index]!,rows=matches.get(m.index)??[],from=Math.max(0,c.start-m.offset),to=Math.min(m.value.length,c.end-m.offset);
        rows.push({start:b.kind==='table'?0:m.starts[from]!,end:b.kind==='table'?b.text.length:m.ends[to-1]!,location:f.location,type:f.type});matches.set(m.index,rows);
      }
    }
  }
  if(pdf)for(const b of source.blocks.filter(b=>b.kind!=='table'&&titlePattern.test(normalized(b.text))&&!b.text.split('\n').some(s=>directoryPattern.test(s)))) {
    const index=source.blocks.indexOf(b),map=mapped(b.text),existing=matches.get(index)??[];
    const annotated=b.text.match(/\[PDF p\.(\d+)(?:-(\d+))?\]/u);
    const knownPages=new Set(existing.filter(r=>titlePattern.test(normalized(b.text.slice(r.start,r.end)))).map(r=>r.location.page));
    const chunk=chunks.find(c=>c.indices.includes(index));
    const candidates:Array<{page:SplitPdfEvidence['pages'][number];rows:SplitPdfEvidence['pages'][number]['lines'];start:number;end:number}>=[];
    for(const page of pdf.pages) {
      if(chunk?.start&&(page.page<chunk.start||page.page>chunk.end))continue;
      if(annotated&&(page.page<Number(annotated[1])||page.page>Number(annotated[2]??annotated[1])))continue;
      const top=page.lines.filter(r=>r.bbox[1]!<page.height*.2&&!/^\s*\d+\s*$/u.test(r.text)).sort((a,b)=>a.bbox[1]!-b.bbox[1]!||a.bbox[0]!-b.bbox[0]!);
      const end=top.findIndex(r=>titlePattern.test(normalized(r.text)));if(end<0)continue;
      const rows=top.slice(0,end+1),target=mapped(rows.map(r=>r.text).join('')).value,pos=map.value.indexOf(target);
      if(pos>=0)candidates.push({page,rows,start:map.starts[pos]!,end:map.ends[pos+target.length-1]!});
    }
    const eligible=candidates.length>1&&knownPages.size?candidates.filter(c=>knownPages.has(c.page.page)):candidates;
    if(eligible.length===1) {
      const c=eligible[0]!,box=[Math.min(...c.rows.map(r=>r.bbox[0]!))/c.page.width*1000,Math.min(...c.rows.map(r=>r.bbox[1]!))/c.page.height*1000,
        Math.max(...c.rows.map(r=>r.bbox[2]!))/c.page.width*1000,Math.max(...c.rows.map(r=>r.bbox[3]!))/c.page.height*1000];
      existing.push({start:c.start,end:c.end,type:'original_pdf_text',location:{page:c.page.page,bbox:box,layout_path:pdf.path,
        entry:c.page.lines.indexOf(c.rows[0]!),kind:'original_pdf_text',basis:'original_pdf_text'}});matches.set(index,existing);
    }
  }
  const atoms: Atom[] = [];
  const physical = [...chunks].sort((a,b) => a.start - b.start);
  for (const chunk of physical) for (const index of chunk.indices) {
    const b = source.blocks[index]!, rows = matches.get(index) ?? [];
    const cuts = b.kind === 'table' ? [0, b.text.length] : [...new Set([0, b.text.length,
      ...rows.flatMap(r => [r.start, r.end]), ...[...b.text.matchAll(/\n/g)].map(m => m.index! + 1)])].sort((a,b) => a-b);
    for (let i = 1; i < cuts.length; i++) {
      const start = cuts[i-1]!, end = cuts[i]!, linked = rows.filter(r => r.start < end && r.end > start);
      const original=linked.filter(r=>r.location.basis==='original_pdf_text').map(r=>r.location);
      const pages = original.length?original:linked.map(r => r.location);
      const annotated = b.text.match(/\[PDF p\.(\d+)(?:-(\d+))?\]/u);
      atoms.push({ block_id: b.id, start, end, start_line: b.start_line + b.text.slice(0,start).split('\n').length-1,
        end_line: b.start_line + b.text.slice(0,Math.max(start,end-1)).split('\n').length-1, pages,
        page_range: pages.length ? [Math.min(...pages.map(p => p.page)),Math.max(...pages.map(p => p.page))]
          : annotated ? [Number(annotated[1]),Number(annotated[2] ?? annotated[1])] : chunk.start ? [chunk.start,chunk.end] : null,
        text: b.text.slice(start,end), kind:b.kind, chunk:chunk.start, order:atoms.length, layout_type:linked.map(r => r.type),
        conflicting_locations:original.length?linked.map(r=>r.location).filter(r=>!original.some(p=>p.page===r.page)):[] });
    }
  }
  return { atoms, chunks, missing };
}

/** No candidate count, document-specific names, expected totals, or gold answers enter this function. */
export function splitAcceptanceLots(source: SourceLedger, layouts: SplitLayoutChunk[] = [], pdf?: SplitPdfEvidence): LotSplitManifest {
  const { atoms, chunks, missing } = sourceAtoms(source, layouts,pdf);
  const manifest: LotSplitManifest = { schema_version:'acceptance-lot-split/v1',source_id:source.source_id,source_sha256:source.sha256,
    layout_inputs:layouts.map(({entries: _entries,...rest}) => rest), lots:[],shared:[],accounting:[],anomalies:[],directory:[],
    summary:{confirmed_lots:0,pending_lots:0,physical_parts:0,tables:0,source_blocks:source.blocks.length,accounted_blocks:0,
      source_characters:source.blocks.reduce((n,b) => n+b.text.length,0),accounted_characters:0,unassigned_tables:0,
      physical_page_ranges:chunks.filter(c=>c.start).map(c=>[c.start,c.end] as [number,number]).sort((a,b)=>a[0]-b[0]),missing_layout_entries:missing.length,directory_unmatched:0} };
  const anomaly = (code:string, detail:string, spans:SplitSpan[]=[], lot_ids:string[]=[]) => manifest.anomalies.push({code,detail,spans,lot_ids});
  if(pdf)manifest.pdf_input={path:pdf.path,sha256:pdf.sha256,page_count:pdf.pages.length};
  for(const a of atoms.filter(a=>a.conflicting_locations.length)) {
    anomaly('layout_page_conflict_resolved_by_original_pdf',`布局将这段文字放在 PDF ${a.conflicting_locations.map(p=>p.page).join(',')}；原 PDF 精确文本框确认在 ${a.pages.map(p=>p.page).join(',')}。源块未改动，以原 PDF 位置作为本清单坐标。`,[spanOf(a)]);
    manifest.anomalies.at(-1)!.layout_locations=a.conflicting_locations;
  }
  if (chunks.some((c,i)=>i>0 && c.start<chunks[i-1]!.start)) anomaly('source_chunks_out_of_physical_order',
    '冻结原文分块顺序与物理页顺序不同；仅拆分视图按分块物理页排序，全部源块及字符坐标保持原样。');
  for (const row of missing) {
    anomaly('layout_entry_not_in_frozen_text',`${row.chunk.path} entry ${row.entry}, ${row.type}: ${row.text}`);
    const raw=row.chunk.entries[row.entry]!;
    manifest.anomalies.at(-1)!.layout_locations=[{page:row.chunk.start_page+raw.page_idx,bbox:raw.bbox??null,layout_path:row.chunk.path,
      entry:row.entry,kind:row.type,basis:row.type==='image'?'caption_container':'exact_text'}];
  }
  const anchors: Array<{ index:number; title_index:number; title:string; original:string; incomplete?:boolean }> = [];
  const sections = new Set<number>(), directory = new Set<number>();
  const directoryBlocks=new Set(source.blocks.filter(b=>b.kind!=='table'&&b.text.split('\n').some(line=>directoryPattern.test(line))).map(b=>b.id));
  for (let i=0;i<atoms.length;i++) {
    const a=atoms[i]!, text=clean(a.text), norm=normalized(text);
    if (directoryBlocks.has(a.block_id)) { directory.add(i); if(directoryPattern.test(text)&&titlePattern.test(norm))manifest.directory.push({name:text.replace(directoryPattern,'').trim(),span:spanOf(a),matching_lot_ids:[]});continue; }
    if (/^(?:[一二三四五六七八九十]+[、.].+|目\s*录)$/u.test(text)) sections.add(i);
    if (!titlePattern.test(norm) || a.kind==='table') continue;
    if (!/检验批(?:质量)?验收记录(?:[（(][^）)]+[）)])*$/u.test(norm)) {
      anomaly('unresolved_title_mention','含检验批标题词，但还含有正文或引用，未自动作为批起点。',[spanOf(a)]);continue;
    }
    let begin=i, title=text;
    if (/^检验批(?:质量)?验收记录/u.test(norm)) {
      let prev=i-1; while(prev>=0&&!clean(atoms[prev]!.text))prev--;
      if(prev>=0 && atoms[prev]!.kind!=='table' && !sections.has(prev) && !codes(atoms[prev]!.text).length
        && !titlePattern.test(normalized(atoms[prev]!.text))) { begin=prev; title=clean(atoms[prev]!.text)+text; }
    }
    // An image in the same paragraph before its caption travels with that title.
    while(begin>0 && atoms[begin-1]!.block_id===a.block_id && (!clean(atoms[begin-1]!.text)||/!\[/.test(atoms[begin-1]!.text)))begin--;
    anchors.push({index:begin,title_index:i,title,original:title});
  }
  // A truncated heading can still open a new form; do not swallow it into the preceding batch.
  for(let i=0;i<atoms.length;i++) {
    const a=atoms[i]!;
    if(a.kind!=='heading'||!clean(a.text)||sections.has(i)||directory.has(i)||anchors.some(h=>h.index<=i&&h.title_index>=i))continue;
    let end=i+1;while(end<atoms.length&&atoms[end]!.kind!=='table'&&!anchors.some(h=>h.index===end)&&!sections.has(end))end++;
    if(atoms[end]?.kind==='table'&&codes(atoms.slice(i+1,end).map(a=>a.text).join('\n')).length
      && /单位[（(]?(?:子单位)?[）)]?工程名称/u.test(normalized(atoms[end]!.text))) {
      anchors.push({index:i,title_index:i,title:clean(a.text),original:clean(a.text),incomplete:true});
    }
  }
  anchors.sort((a,b)=>a.index-b.index);
  for(const anchor of anchors) {
    const firstTable=atoms.slice(anchor.index).find(a=>a.kind==='table');
    const pages=new Set([atoms[anchor.title_index]!,firstTable].filter((a):a is Atom=>Boolean(a)).flatMap(a=>a.pages.map(p=>p.page)));
    let begin=anchor.index;
    while(begin>0) {
      const a=atoms[begin-1]!,text=clean(a.text);
      const metadata=!text||/^\d{6,}[□口]*$/u.test(text)||ordinal(text)!==null||Boolean(variant(text))||/!\[/.test(a.text);
      if(!metadata||a.kind==='table'||a.kind==='page_marker'||(text&&!a.pages.some(p=>pages.has(p.page))))break;
      begin--;
    }
    anchor.index=begin;
  }
  const dispositions = new Map<number,{disposition:'lot'|'shared'|'non_lot'|'pending';owner_id:string|null;reason:string}>();
  const parts: Array<{ lot:SplitLot; atoms:Atom[]; start:number; end:number }> = [];
  for(let ai=0;ai<anchors.length;ai++) {
    const anchor=anchors[ai]!, next=anchors[ai+1]?.index??atoms.length;
    const section=[...sections].find(i=>i>anchor.index&&i<next), end=section??next;
    const scope=atoms.slice(anchor.index,end), firstTable=scope.findIndex(a=>a.kind==='table');
    const header=scope.slice(0,firstTable<0?scope.length:firstTable).map(a=>clean(a.text)).join('\n');
    let ownCodes=codes(header), ownVariant=variant(header.split('\n').find(x=>variant(x))??'');
    const markers=header.split('\n').map(ordinal).filter((x):x is number=>x!==null);
    let continuation=markers.at(-1)??null;
    let pdfHeader:SplitPart['pdf_header'];const conflicts:string[]=[];
    const firstLocation=scope[firstTable]?.pages[0],page=pdf?.pages.find(p=>p.page===firstLocation?.page);
    if(page&&pdf&&firstLocation?.bbox) {
      const limit=firstLocation.bbox[1]!/1000*page.height;
      const rows=page.lines.filter(r=>((r.bbox[1]!<limit&&r.bbox[3]!<=limit+3)
          ||(r.bbox[1]!<page.height*.3&&/^(?:\d{6,}[□口]+)+$/u.test(normalized(r.text))))&&!/^\s*\d+\s*$/u.test(r.text))
        .sort((a,b)=>a.bbox[1]!-b.bbox[1]!||a.bbox[0]!-b.bbox[0]!);
      const phrase=rows.findIndex(r=>titlePattern.test(normalized(r.text)));
      if(phrase>=0) {
        const titleRows=rows.slice(0,phrase+1),title=titleRows.map(r=>r.text.trim()).join('');
        const titleKey=identity(title),sourceKey=identity(anchor.title);
        if(titleKey===sourceKey||(anchor.incomplete&&titleKey.startsWith(sourceKey))) {
          pdfHeader={pdf_sha256:pdf.sha256,page:page.page,title,lines:rows,coordinate_unit:'PDF_points'};
          const values=rows.map(r=>r.text.trim()),pdfCodes=codes(values.join('\n')),pdfVariant=variant(values.find(x=>variant(x))??''),pdfOrdinal=values.map(ordinal).find(x=>x!==null)??null;
          if(ownCodes.length&&pdfCodes.length&&JSON.stringify([...ownCodes].sort())!==JSON.stringify([...pdfCodes].sort()))conflicts.push(`Markdown 表号 ${ownCodes.join('/')} 与原 PDF p.${page.page} 表号 ${pdfCodes.join('/')} 冲突。`);
          if(ownVariant&&pdfVariant&&ownVariant!==pdfVariant)conflicts.push(`Markdown 表式 ${ownVariant} 与原 PDF p.${page.page} 表式 ${pdfVariant} 冲突。`);
          if(continuation!==null&&pdfOrdinal!==null&&continuation!==pdfOrdinal)conflicts.push(`Markdown 续页 ${continuation} 与原 PDF p.${page.page} 续页 ${pdfOrdinal} 冲突。`);
          if(!ownCodes.length)ownCodes=pdfCodes;
          if(!ownVariant)ownVariant=pdfVariant;
          if(continuation===null)continuation=pdfOrdinal;
        }else conflicts.push(`原 PDF p.${page.page} 的表头名称与 Markdown 起点不一致：${title}。`);
      }
    }
    const id=`lot:${sha256Text(`${source.source_id}:${atoms[anchor.title_index]!.block_id}:${atoms[anchor.title_index]!.start}`).slice(0,24)}`;
    const reasons:string[]=[];
    if(anchor.incomplete&&!pdfHeader)reasons.push('原文独立标题未含完整“检验批质量验收记录”字样；以新表头和表号隔离范围，保留标题缺损待核。');
    reasons.push(...conflicts);
    if(firstTable<0) reasons.push('标题之后没有可定位的表格；范围保留待核对。');
    if(!ownCodes.length) reasons.push('标题与首表之间未定位到原文表号，不能用邻批表号代替。');
    if(continuation!==null&&continuation!==1) reasons.push(`续页从（${sequence[continuation-1]}）开始，前页关联尚未确认。`);
    if(scope.some(a=>a.kind==='table'&&a.layout_type.length===0)&&layouts.length) reasons.push('有表格未匹配到布局坐标；不得猜定物理页或跨页归属。');
    const part:SplitPart={title:anchor.original,form_codes:ownCodes,variant:ownVariant,continuation,
      spans:scope.map(a=>({...spanOf(a),role:a.kind==='table'?'table':titlePattern.test(normalized(a.text))?'title':a.kind==='note'?'note':
        /!\[/.test(a.text)?'image':!clean(a.text)?'separator':firstTable<0||a.order<scope[firstTable]!.order?'metadata':'body'})),
      evidence:[`起点：原文标题 ${atoms[anchor.index]!.block_id}，块内 ${atoms[anchor.index]!.start}。`,
        section!==undefined?`终点：下一章节 ${atoms[section]!.block_id} 之前。`:ai+1<anchors.length?`终点：下一检验批标题 ${atoms[next]!.block_id} 之前。`:'终点：全文结束。',
        ...(continuation!==null?[`原文明示续页序号（${sequence[continuation-1]}）。`]:[]),
        ...(scope.filter(a=>a.kind==='table').length>1?['本页段含多个物理表块；保留各表坐标及中间图片，不拼接或改写表格。']:[])]};
    if(pdfHeader){part.pdf_header=pdfHeader;part.evidence.push(`原 PDF p.${pdfHeader.page} 表头逐字核对，补足 Markdown 遗漏的表式、续页或表号；原文未改动，坐标及原句见 pdf_header。`);}
    const lot:SplitLot={id,original_name:pdfHeader?.title??anchor.original,form_codes:ownCodes,variant:ownVariant,status:reasons.length?'pending':'confirmed',reasons,parts:[part],shared_ids:[],related_ids:[]};
    parts.push({lot,atoms:scope,start:anchor.index,end});
  }
  // Only consecutive, explicitly numbered subpages of the same name/code/type merge.
  for(let i=0;i<parts.length;i++) {
    const current=parts[i]!, previous=manifest.lots.at(-1), p=previous?.parts.at(-1), c=current.lot.parts[0]!;
    if(previous&&p && identity(previous.original_name)===identity(current.lot.original_name)
      && previous.variant===current.lot.variant && previous.form_codes.length>0 && JSON.stringify(previous.form_codes)===JSON.stringify(current.lot.form_codes)
      && p.continuation!==null&&c.continuation===p.continuation+1 && parts[i-1]!.end===current.start) {
      previous.parts.push(c); c.evidence.push('与前页同名、同表号、同表式，原文续页序号连续。');
      previous.reasons.push(...current.lot.reasons.filter(r=>!r.startsWith('续页从')));current.lot=previous;
    } else {
      manifest.lots.push(current.lot);
      if(previous&&p&&previous.form_codes.length&&JSON.stringify(previous.form_codes)===JSON.stringify(current.lot.form_codes)
        &&previous.variant===current.lot.variant&&p.continuation!==null&&c.continuation===p.continuation+1) {
        const reason='同表号、同表式且续页序号连续，但原文名称不同；保留两侧候选范围，不能猜定同一批。';
        previous.reasons.push(reason);current.lot.reasons.push(reason);previous.related_ids.push({id:current.lot.id,reason});current.lot.related_ids.push({id:previous.id,reason});
        anomaly('continuation_title_mismatch',reason,[spanOf(current.atoms[0]!)],[previous.id,current.lot.id]);
      }
      if(previous && identity(previous.original_name)===identity(current.lot.original_name) && previous.variant===current.lot.variant
        && JSON.stringify(previous.form_codes)===JSON.stringify(current.lot.form_codes)) {
        const reason='相邻同名同码但缺少连续续页标记，保留为独立候选范围；可能是重复印刷或未标注续页。';
        previous.reasons.push(reason); current.lot.reasons.push(reason);
        previous.related_ids.push({id:current.lot.id,reason});current.lot.related_ids.push({id:previous.id,reason});
        anomaly('ambiguous_repetition_or_continuation',reason,[spanOf(current.atoms[0]!)],[previous.id,current.lot.id]);
      }
    }
    for(const a of current.atoms)dispositions.set(a.order,{disposition:'lot',owner_id:current.lot.id,reason:'原文标题、表号及下一边界围成的独立范围。'});
  }
  // Repeated source occurrences retain different IDs; matching names never silently deduplicate them.
  const keys=new Map<string,SplitLot[]>();
  for(const lot of manifest.lots) {const key=JSON.stringify([identity(lot.original_name),lot.form_codes,lot.variant]);keys.set(key,[...(keys.get(key)??[]),lot]);}
  for(const group of keys.values()) if(group.length>1) for(const lot of group) {
    lot.reasons.push('全文存在同名同码同表式的其他范围；未自动去重。');
    for(const other of group.filter(x=>x!==lot))if(!lot.related_ids.some(x=>x.id===other.id))lot.related_ids.push({id:other.id,reason:'全文同名同码重复范围，需核对是否为独立出现。'});
  }
  const repeated=new Map<string,Atom[]>();
  for(const a of atoms)if(clean(a.text)&&a.kind!=='table') {const key=normalized(a.text);repeated.set(key,[...(repeated.get(key)??[]),a]);}
  for(const [key,rows] of repeated) {
    if(rows.length<3 || titlePattern.test(key)||codes(key).length||key.length>100)continue;
    const furniture=rows.filter(a=>a.layout_type.some(t=>t==='header'||t==='footer')||a.pages.some(p=>(p.bbox?.[1]??0)>=850));
    if(furniture.length<3)continue;
    const ids=[...new Set(furniture.map(a=>dispositions.get(a.order)?.owner_id).filter((s):s is string=>Boolean(s)))];
    const id=`shared:${sha256Text(`${source.source_id}:furniture:${key}`).slice(0,20)}`;
    manifest.shared.push({id,kind:'page_furniture',spans:furniture.map(spanOf),lot_ids:ids,
      uses:ids.map(lot_id=>({lot_id,span_indexes:furniture.flatMap((a,i)=>dispositions.get(a.order)?.owner_id===lot_id?[i]:[])})),
      reason:'原文重复页眉/页脚，依据布局类型或页面底部坐标；只共享版式内容，不推断验收要求继承。'});
    for(const a of furniture)dispositions.set(a.order,{disposition:'shared',owner_id:id,reason:'重复页眉或页脚的实际源范围。'});
    for(const lot of manifest.lots.filter(l=>ids.includes(l.id)))lot.shared_ids.push(id);
  }
  for(const a of atoms.filter(a=>a.kind!=='table'&&/适用|共用|共同|共享/u.test(a.text))) {
    const text=normalized(a.text);
    const linked=manifest.lots.filter(l=>{
      const name=identity(l.original_name).replace(titlePattern,'');return name.length>1&&text.includes(name);
    });
    if(linked.length<2)continue;
    const id=`shared:${sha256Text(`${source.source_id}:${a.block_id}:${a.start}`).slice(0,20)}`;
    manifest.shared.push({id,kind:'explicit_shared',spans:[spanOf(a)],lot_ids:linked.map(l=>l.id),uses:linked.map(l=>({lot_id:l.id,span_indexes:[0]})),
      reason:'原文共同适用文字明确写出各批名称；只关联原文，不提取或推断共同字段。'});
    dispositions.set(a.order,{disposition:'shared',owner_id:id,reason:'原文明示适用于多个具名检验批。'});
    for(const lot of linked)lot.shared_ids.push(id);
  }
  for(const a of atoms) {
    let disposition=dispositions.get(a.order);
    if(!disposition) {
      const isPending=a.kind==='table'||(titlePattern.test(normalized(a.text))&&!directory.has(a.order));
      disposition={disposition:isPending?'pending':'non_lot',owner_id:null,reason:directory.has(a.order)?'目录仅用于交叉核对。':
        a.kind==='page_marker'?'原文分块页码标记。':sections.has(a.order)?'章节或目录标题。':isPending?'未归属表格或标题线索，保留原始范围。':'批范围外的原文。'};
      if(isPending)anomaly('unassigned_relevant_range',disposition.reason,[spanOf(a)]);
    }
    manifest.accounting.push({span:spanOf(a),...disposition});
  }
  for(const lot of manifest.lots) {
    // Shared spans are referenced through shared_ids, never duplicated into batch input.
    for(const part of lot.parts) part.spans=part.spans.filter(s=>!manifest.accounting.some(a=>a.span.block_id===s.block_id&&a.span.start===s.start&&a.span.end===s.end&&a.disposition==='shared'));
    if(lot.parts.length===1&&lot.parts[0]!.continuation===1)lot.reasons.push('仅见续页（一），尚未确认本批的续页终点。');
    lot.reasons=[...new Set(lot.reasons)];lot.status=lot.reasons.length?'pending':'confirmed';
    if(lot.status==='pending')anomaly('lot_boundary_pending',lot.reasons.join(' '),lot.parts.map(p=>p.spans[0]!).filter(Boolean),[lot.id]);
  }
  for(const row of manifest.directory)row.matching_lot_ids=manifest.lots.filter(l=>identity(l.original_name)===identity(row.name)
    && (!variant(row.name)||variant(row.name)===l.variant)).map(l=>l.id);
  manifest.summary.confirmed_lots=manifest.lots.filter(l=>l.status==='confirmed').length;
  manifest.summary.pending_lots=manifest.lots.filter(l=>l.status==='pending').length;
  manifest.summary.physical_parts=manifest.lots.reduce((n,l)=>n+l.parts.length,0);
  manifest.summary.tables=source.blocks.filter(b=>b.kind==='table').length;
  manifest.summary.accounted_blocks=new Set(manifest.accounting.map(a=>a.span.block_id)).size;
  manifest.summary.accounted_characters=manifest.accounting.reduce((n,a)=>n+a.span.end-a.span.start,0);
  manifest.summary.unassigned_tables=manifest.accounting.filter(a=>a.disposition==='pending'&&source.blocks.find(b=>b.id===a.span.block_id)?.kind==='table').length;
  manifest.summary.directory_unmatched=manifest.directory.filter(d=>!d.matching_lot_ids.length).length;
  return manifest;
}

/** Consumers get one batch's exact original slices; pending boundaries remain explicit. */
export function readSplitLot(source:SourceLedger, manifest:LotSplitManifest, id:string) {
  if(source.source_id!==manifest.source_id||source.sha256!==manifest.source_sha256)throw new Error('Split source fingerprint differs');
  const lot=manifest.lots.find(l=>l.id===id);if(!lot)throw new Error(`Unknown split lot: ${id}`);
  const read=(span:SplitSpan)=>{
    const block=source.blocks.find(b=>b.id===span.block_id);
    if(!block||span.start<0||span.end>block.text.length||span.end<=span.start)throw new Error('Invalid immutable source span');
    return {...span,text:block.text.slice(span.start,span.end)};
  };
  return {id:lot.id,original_name:lot.original_name,form_codes:lot.form_codes,variant:lot.variant,status:lot.status,reasons:lot.reasons,
    related_ids:lot.related_ids,parts:lot.parts.map(p=>({...p,spans:p.spans.map(s=>({...read(s),role:s.role}))})),
    shared:manifest.shared.filter(s=>lot.shared_ids.includes(s.id)).map(s=>({id:s.id,kind:s.kind,reason:s.reason,
      spans:(s.uses.find(u=>u.lot_id===lot.id)?.span_indexes??[]).map(i=>read(s.spans[i]!))}))};
}

/** Independent omissions/overlap checks: source partition, every table, and every physical PDF page. */
export function auditLotSplit(source:SourceLedger, manifest:LotSplitManifest, pdf?:SplitPdfEvidence) {
  const errors:Array<{code:string;detail:string}>=[];
  const key=(s:SplitSpan)=>`${s.block_id}:${s.start}:${s.end}`;
  const claims=new Map<string,string[]>();
  for(const lot of manifest.lots)for(const part of lot.parts)for(const span of part.spans)claims.set(key(span),[...(claims.get(key(span))??[]),lot.id]);
  for(const row of manifest.accounting) {
    const owners=claims.get(key(row.span))??[];
    if((row.disposition==='lot'&&(owners.length!==1||owners[0]!==row.owner_id))||(row.disposition!=='lot'&&owners.length))
      errors.push({code:'source_ownership_disagrees',detail:`${key(row.span)}: accounting=${row.owner_id}, input=${owners.join(',')}`});
  }
  for(const b of source.blocks) {
    const rows=manifest.accounting.filter(a=>a.span.block_id===b.id).map(a=>a.span).sort((a,b)=>a.start-b.start);
    let end=0;for(const row of rows){if(row.start!==end||row.end<=row.start)errors.push({code:'source_gap_or_overlap',detail:`${b.id}:${end}`});end=row.end;}
    if(end!==b.text.length)errors.push({code:'source_incomplete',detail:b.id});
    if(b.kind==='table'&&rows.length!==1)errors.push({code:'table_multiple_owners',detail:b.id});
  }
  for(const lot of manifest.lots) for(const part of lot.parts) {
    const tables=part.spans.filter(s=>s.role==='table');
    for(const table of tables.slice(1))if(/单位[（(]?(?:子单位)?[）)]?工程名称/u.test(normalized(source.blocks.find(b=>b.id===table.block_id)!.text))) {
      errors.push({code:'possible_cross_lot_table',detail:`${lot.id}: ${table.block_id} 再次出现独立工程名称表头，不能按上一批续表吞入。`});
    }
  }
  const furniture=manifest.shared.filter(s=>s.kind==='page_furniture').flatMap(s=>s.spans.map(span=>
    normalized(source.blocks.find(b=>b.id===span.block_id)!.text.slice(span.start,span.end)))).filter(Boolean);
  const lexicon=[...new Set(furniture)].sort((a,b)=>b.length-a.length);
  const isFurniture=(text:string)=>{
    const positions=new Set([0]);for(let i=0;i<text.length;i++)if(positions.has(i))for(const word of lexicon)if(text.startsWith(word,i))positions.add(i+word.length);
    return positions.has(text.length);
  };
  const pageAccounting=(pdf?.pages??[]).map(page=>{
    const sourceRows=manifest.accounting.filter(a=>a.span.pages.some(p=>p.page===page.page));
    const isDirectoryPage=page.lines.filter(r=>directoryPattern.test(r.text.trim())).length>=2;
    const titleLines=isDirectoryPage?[]:page.lines.filter(r=>r.bbox[1]!<page.height*.2&&titlePattern.test(normalized(r.text))&&!directoryPattern.test(r.text.trim()));
    const owners=manifest.lots.filter(l=>l.parts.some(p=>p.pdf_header?.page===page.page));
    if(titleLines.length&&owners.length!==1)errors.push({code:'pdf_title_ownership',detail:`PDF p.${page.page}: ${titleLines.map(r=>r.text).join(' / ')}，对应 ${owners.length} 个批范围。`});
    const text=page.lines.filter(r=>!/^\s*\d+\s*$/u.test(r.text)).map(r=>r.text).join('');
    const disposition=sourceRows.length?'source_mapped':!normalized(text)?'page_number_only':isFurniture(normalized(text))?'page_furniture_only':'pending_pdf_only_content';
    if(disposition==='pending_pdf_only_content')errors.push({code:'pdf_content_unmapped',detail:`PDF p.${page.page}: ${text.slice(0,120)}`});
    return {page:page.page,disposition,source_block_ids:[...new Set(sourceRows.map(a=>a.span.block_id))],title_lot_ids:owners.map(l=>l.id),
      pdf_only_lines:sourceRows.length?[]:page.lines};
  });
  const pending=new Set(manifest.lots.filter(l=>l.status==='pending').map(l=>l.id));let pendingBoundaryGroups=0;
  while(pending.size) {pendingBoundaryGroups++;const stack=[pending.values().next().value!];while(stack.length){const id=stack.pop()!;if(!pending.delete(id))continue;
    stack.push(...manifest.lots.find(l=>l.id===id)!.related_ids.filter(r=>pending.has(r.id)).map(r=>r.id));}}
  return {passed:errors.length===0,errors,pending_boundary_groups:pendingBoundaryGroups,page_accounting:pageAccounting,
    pdf_body_title_pages:pageAccounting.filter(p=>p.title_lot_ids.length).length,
    pdf_page_dispositions:pageAccounting.reduce<Record<string,number>>((a,p)=>(a[p.disposition]=(a[p.disposition]??0)+1,a),{})};
}
