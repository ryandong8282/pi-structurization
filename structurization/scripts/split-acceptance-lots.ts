import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceLedger } from '../src/acceptance-autonomous/contracts.js';
import { splitAcceptanceLots, readSplitLot, auditLotSplit, type SplitLayoutChunk, type SplitSpan, type SplitPdfEvidence } from '../src/acceptance-autonomous/lot-split.js';

const args = process.argv.slice(2);
const option = (key: string) => { const i=args.indexOf(key); return i<0?undefined:args[i+1]; };
const sourceArg=option('--source'),outArg=option('--out');
if(!sourceArg||!outArg)throw new Error('Usage: tsx scripts/split-acceptance-lots.ts --source <frozen-ledger.json> --out <new-directory> [--layout-root <MinerU chunks>] [--pdf-evidence <PDF text JSON>] [--prior-audit <anchor-audit.json>] [--reference-delivery <DELIVERY.json>]');
const sourcePath=resolve(sourceArg),out=resolve(outArg),sourceBytes=await readFile(sourcePath);
const source=JSON.parse(sourceBytes.toString('utf8')) as SourceLedger;
const markdownPath=sourcePath.replace(/\.json$/u,'.md'),markdown=await readFile(markdownPath,'utf8');
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
if(hash(markdown)!==source.sha256||source.source_id!==source.sha256)throw new Error('Frozen Markdown fingerprint differs');
for(const b of source.blocks)if(markdown.slice(b.start,b.end)!==b.text)throw new Error(`Frozen block coordinates differ: ${b.id}`);
const layouts:SplitLayoutChunk[]=[];
const layoutRoot=option('--layout-root');
if(layoutRoot)for(const name of await readdir(resolve(layoutRoot))) {
  const range=name.match(/^pages_(\d+)_(\d+)$/u);if(!range)continue;
  const path=join(resolve(layoutRoot),name,'input.json'),bytes=await readFile(path);
  const entries=JSON.parse(bytes.toString('utf8')) as SplitLayoutChunk['entries'];
  if(!Array.isArray(entries)||entries.some(e=>!Number.isInteger(e.page_idx)||e.page_idx<0||e.page_idx>Number(range[2])-Number(range[1])))throw new Error(`Invalid page layout: ${path}`);
  layouts.push({start_page:Number(range[1]),end_page:Number(range[2]),path,sha256:hash(bytes),entries});
}
let pdf:SplitPdfEvidence|undefined;
const pdfArg=option('--pdf-evidence');
if(pdfArg){pdf=JSON.parse(await readFile(resolve(pdfArg),'utf8')) as SplitPdfEvidence;
  if(pdf.schema_version!=='lot-split-pdf-text/v1'||hash(await readFile(pdf.path))!==pdf.sha256)throw new Error('Original PDF evidence fingerprint differs');}
const manifest=splitAcceptanceLots(source,layouts,pdf);
const audit=auditLotSplit(source,manifest,pdf);
const advisory:Record<string,unknown>={};
const priorPath=option('--prior-audit');
if(priorPath) {
  const bytes=await readFile(resolve(priorPath)),prior=JSON.parse(bytes.toString('utf8'));
  const rows=(prior.anchors??prior.heads??[]) as Array<{block_id:string}>;
  const titleIds=new Set(manifest.lots.flatMap(l=>l.parts.flatMap(p=>p.spans.filter(s=>s.role==='title').map(s=>s.block_id))));
  advisory.prior_audit={path:resolve(priorPath),sha256:hash(bytes),anchors:rows.length,
    covered_anchor_block_ids:rows.filter(r=>titleIds.has(r.block_id)).map(r=>r.block_id),
    unmatched_anchor_block_ids:rows.filter(r=>!titleIds.has(r.block_id)).map(r=>r.block_id),authority:'cross_check_only'};
}
const deliveryPath=option('--reference-delivery');
if(deliveryPath) {
  const bytes=await readFile(resolve(deliveryPath)),prior=JSON.parse(bytes.toString('utf8'));
  const rows=(prior.lots??[]) as Array<{id:string;scope?:{evidence?:Array<{block_id:string}>}}>;
  advisory.candidates={path:resolve(deliveryPath),sha256:hash(bytes),count:rows.length,authority:'source_mapping_only',
    mappings:rows.map(r=>({candidate_id:r.id,split_lot_ids:manifest.lots.filter(l=>l.parts.some(p=>p.spans.some(s=>r.scope?.evidence?.some(e=>e.block_id===s.block_id)))).map(l=>l.id)}))};
}
await mkdir(out); // Exclusive destination: never writes into a frozen source or live job.
const json=(name:string,data:unknown)=>writeFile(join(out,name),JSON.stringify(data,null,2)+'\n','utf8');
await json('manifest.json',manifest);
await json('provenance.json',{created_at:new Date().toISOString(),source_path:sourcePath,source_json_sha256:hash(sourceBytes),
  markdown_path:markdownPath,markdown_sha256:hash(markdown),layout_inputs:manifest.layout_inputs,
  pdf_evidence:pdfArg?{path:resolve(pdfArg),sha256:hash(await readFile(resolve(pdfArg)))}:null,
  implementation:{runner_sha256:hash(await readFile(new URL(import.meta.url))),
    module_sha256:hash(await readFile(new URL('../src/acceptance-autonomous/lot-split.ts',import.meta.url)))},advisory});
const page=(s:SplitSpan)=>s.pages.length?[...new Set(s.pages.map(p=>p.page))].join(','):s.page_range?`${s.page_range[0]}-${s.page_range[1]}（范围，非精确页）`:'未定位';
const location=(s:SplitSpan)=>`${s.block_id} [${s.start},${s.end}) · L${s.start_line}-${s.end_line} · PDF ${page(s)}`;
const summary=manifest.summary;
const intro=[`# 全文检验批拆分清单`,``,
  `来源：\`${source.source_id}\`。仅核对原文边界、续页、附注和共享关联；未进行字段识别、引用钻取或语义封存。`,
  ``, `已确认批：**${summary.confirmed_lots}**；待确认边界：**${audit.pending_boundary_groups} 组、${summary.pending_lots} 段候选范围**；原文表式页段：${summary.physical_parts}；物理表块：${summary.tables}。待确认范围未计入已确认批数，不能将标题数、候选数或表块数当作最终总量。`,
  ``, `覆盖 ${summary.accounted_blocks}/${summary.source_blocks} 源块、${summary.accounted_characters}/${summary.source_characters} 个源块字符；无归属表块 ${summary.unassigned_tables}。覆盖表示每个源块均有账目，不表示全部边界已经通过。`,
  ``, `原文分块页区间：${summary.physical_page_ranges.map(([s,e])=>`${s}-${e}`).join('、')}。块顺序可能不等于物理页顺序，本文按物理页分块排序；原文未改动。`,
  ``, `坐标：块内 UTF-16 [start,end)，行号从 1 开始；pages 中的 bbox 为 0..1000 坐标。MinerU 坐标保持原样，original_pdf_text 由原 PDF 文本框换算；caption_container 是所属图片/表格容器，不能当作标题文字的精确框；没有精确布局时只提供页区间。pdf_header 另保留原 PDF points 坐标。`,
  ``, `后续逐批输入：lot-inputs.jsonl 每行含一批全部原文切片及共享内容；manifest.json 保存机器清单、归属底账、目录交叉核对和异常。pending 批须先处理其 reasons，不得默认为已确认。`,``];
const lines=[...intro,'| 状态 | 稳定 ID | 原文名称 | 表号 | 表式 | 页段 |','|---|---|---|---|---|---|'];
for(const lot of manifest.lots)lines.push(`| ${lot.status==='confirmed'?'已确认':'待确认'} | ${lot.id} | ${lot.original_name.replace(/\|/g,'\\|')} | ${lot.form_codes.join(' / ')} | ${lot.variant} | ${lot.parts.map(p=>[...new Set(p.spans.flatMap(s=>s.pages.map(p=>p.page)))].join(',')).join('; ')} |`);
for(const lot of manifest.lots) {
  lines.push('',`## ${lot.id} · ${lot.original_name}`,'',`状态：${lot.status==='confirmed'?'已确认':'待确认'}。表号：${lot.form_codes.join(' / ')}；表式：${lot.variant||'原文未标表式'}。`,
    ...lot.reasons.map(r=>`- 待核：${r}`));
  for(const [i,part] of lot.parts.entries()) {
    lines.push('',`页段 ${i+1}：${part.title}${part.continuation?`（续页 ${part.continuation}）`:''}`, ...part.evidence.map(e=>`- 依据：${e}`));
    for(const span of part.spans.filter(s=>s.role!=='separator'))lines.push(`- ${span.role}：${location(span)}`);
  }
  if(lot.shared_ids.length)lines.push(`- 共享关联：${lot.shared_ids.join(', ')}`);
  for(const rel of lot.related_ids)lines.push(`- 相关范围：${rel.id}；${rel.reason}`);
}
await writeFile(join(out,'lots.md'),lines.join('\n')+'\n','utf8');
const report=[...intro.slice(0,9),'# 边界与覆盖异常','',`待确认 ${audit.pending_boundary_groups} 组边界，涉及 ${summary.pending_lots} 段候选范围。目录未匹配 ${summary.directory_unmatched} 项，仅提示核对，不生成正文检验批。`];
report.push('',`全页覆盖审计：${audit.passed?'通过':'存在待处理项'}；PDF 正文表头页 ${audit.pdf_body_title_pages}；页面账目 ${JSON.stringify(audit.pdf_page_dispositions)}。`,
  `布局匹配异常保留了被合并 Markdown 省略或无法唯一定位的页眉、页脚、代码等记录，${summary.missing_layout_entries} 条详情见 layout-diagnostics.json；它们不直接等于漏掉检验批。原 PDF 表头和全页底账另行交叉核对。`,
  ...audit.errors.map(e=>`- ${e.code}：${e.detail}`));
for(const lot of manifest.lots.filter(l=>l.status==='pending'))report.push('',`## ${lot.id} · ${lot.original_name}`,'',
  `表号 ${lot.form_codes.join('/')}，表式 ${lot.variant||'未标'}，PDF 页 ${lot.parts.map(p=>p.pdf_header?.page??p.spans.find(s=>s.role==='table')?.pages[0]?.page).join(',')}。`,
  ...lot.reasons.map(r=>`- ${r}`),...lot.related_ids.map(r=>`- 关联 ${r.id}：${r.reason}`));
report.push('','# 其他范围异常','');
for(const a of manifest.anomalies.filter(a=>!['layout_entry_not_in_frozen_text','lot_boundary_pending','continuation_title_mismatch'].includes(a.code)))report.push('',`- **${a.code}** ${a.lot_ids.join(', ')}`,`  ${a.detail}`,...a.spans.map(s=>`  ${location(s)}`),
  ...(a.layout_locations??[]).map(p=>`  PDF ${p.page} · bbox ${JSON.stringify(p.bbox)} · ${p.layout_path} entry ${p.entry}`));
report.push('','# 目录未匹配项','');
for(const d of manifest.directory.filter(d=>!d.matching_lot_ids.length))report.push(`- ${d.name} · ${location(d.span)}`);
await writeFile(join(out,'boundary-report.md'),report.join('\n')+'\n','utf8');
await json('layout-diagnostics.json',manifest.anomalies.filter(a=>a.code==='layout_entry_not_in_frozen_text'));
await writeFile(join(out,'lot-inputs.jsonl'),manifest.lots.map(l=>JSON.stringify(readSplitLot(source,manifest,l.id))).join('\n')+'\n','utf8');
await json('coverage-check.json',{...audit,partition:'each block checked for exact interval partition',tables:'each table has exactly one owner or explicit pending entry',summary});
await json('pdf-page-accounting.json',audit.page_accounting);
await writeFile(join(out,'README.md'),[
  '# 全文检验批拆分结果','',`已确认 **${summary.confirmed_lots} 批**；待确认 **${audit.pending_boundary_groups} 组边界、${summary.pending_lots} 段候选范围**。`,
  '',`原文覆盖 ${summary.accounted_blocks}/${summary.source_blocks} 源块、${summary.tables} 个表块；PDF 覆盖 ${audit.page_accounting.length} 页。遗漏/重复归属检查：${audit.passed?'通过':'存在待处理项'}。`,
  '',`[全文可读清单](lots.md) · [边界异常报告](boundary-report.md) · [机器清单](manifest.json) · [逐批原文输入](lot-inputs.jsonl) · [覆盖审计](coverage-check.json) · [PDF全页账目](pdf-page-accounting.json)`,
  '',`来源 SHA-256：\`${source.sha256}\`。${pdf?`原 PDF SHA-256：\`${pdf.sha256}\`。`:''}`,
  '',`这是独立的边界拆分结果。待确认范围不计入已确认批数；未进行验收字段识别、外部引用钻取、业务审查或发布。`,
].join('\n')+'\n','utf8');
console.log(JSON.stringify({output:out,...summary}));
