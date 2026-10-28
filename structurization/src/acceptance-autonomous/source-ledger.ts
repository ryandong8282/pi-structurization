import { sha256Text } from '../canonical.js';
import type { SourceBlock, SourceLedger, SourceQuote } from './contracts.js';

/** Enumerates physical source content before an author has produced any candidates. */
export function buildAcceptanceSourceLedger(text: string): SourceLedger {
  const sha256 = sha256Text(text);
  const blocks: SourceBlock[] = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0].length);
  let i = 0;
  while (i < lines.length) {
    const first = lines[i]!;
    if (!first[0].trim()) { i += 1; continue; }
    const begin = i;
    let kind: SourceBlock['kind'] = 'paragraph';
    if (/^\s*<table\b/i.test(first[0])) {
      kind = 'table';
      while (i + 1 < lines.length && !/<\/table>/i.test(lines[i]![0])) i += 1;
    } else if (/^\s*\|/.test(first[0]) && i + 1 < lines.length
      && /^\s*\|?[\s:|-]+\|[\s:|-]*\r?\n?$/.test(lines[i + 1]![0])) {
      kind = 'table';
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1]![0])) i += 1;
    } else if (/^\s*#{1,6}\s+/.test(first[0])) kind = 'heading';
    else if (/^\s*<!--\s*pages_\d+_\d+\s*-->\s*$/.test(first[0])) kind = 'page_marker';
    else {
      if (/^\s*(?:注(?:\s*\d+)?[：:.、]|Note\b|\[\^[^\]]+\]:)/iu.test(first[0])) kind = 'note';
      while (i + 1 < lines.length && lines[i + 1]![0].trim()
        && !/^\s*(?:#{1,6}\s|<table\b|\||<!--\s*pages_|注(?:\s*\d+)?[：:.、]|Note\b|\[\^)/iu.test(lines[i + 1]![0])) i += 1;
    }
    const start = first.index!;
    const end = lines[i]!.index! + lines[i]![0].replace(/\r?\n$/, '').length;
    const raw = text.slice(start, end);
    const features: string[] = [kind];
    if (/rowspan\s*=\s*["']?[2-9\d]/i.test(raw)) features.push('rowspan');
    if (/colspan\s*=\s*["']?[2-9\d]/i.test(raw)) features.push('colspan');
    if (/(?:续表|续页|continued)/iu.test(raw)) features.push('continuation');
    if (/<!--\s*pages_\d+_\d+/.test(raw)) features.push('page_boundary');
    if (kind === 'table' && /^\s*</.test(raw) && !/<\/table>/i.test(raw)) features.push('unclosed_table');
    blocks.push({ id: `block:${sha256Text(`${sha256}:${start}:${end}`).slice(0, 24)}`,
      kind, start, end, start_line: begin + 1, end_line: i + 1, text: raw, features });
    i += 1;
  }
  return { schema_version: 'acceptance-source-ledger/v1', source_id: sha256, sha256, blocks };
}

export function verifySourceQuote(sources: readonly SourceLedger[], quote: SourceQuote): boolean {
  const block = sources.find(source => source.source_id === quote.source_id)?.blocks.find(row => row.id === quote.block_id);
  return Boolean(block && Number.isInteger(quote.start) && Number.isInteger(quote.end)
    && quote.start >= 0 && quote.end > quote.start && quote.end <= block.text.length
    && block.text.slice(quote.start, quote.end) === quote.text);
}

export function sourceQuote(ledger: SourceLedger, block: SourceBlock, start = 0, end = block.text.length): SourceQuote {
  return { source_id: ledger.source_id, block_id: block.id, start, end, text: block.text.slice(start, end) };
}

export function sourceTextForDisplay(value: string): string {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

type FieldRole = 'allowable_deviation' | 'acceptance_basis' | 'unclassified' | 'ambiguous';
const fieldRole = (value: string): FieldRole => {
  const label = sourceTextForDisplay(value).replace(/\s+/gu, '');
  if (/^验收依据[：:]?$/u.test(label)) return 'acceptance_basis';
  if (/^(?:质量检验标准|设计要求及规范规定)[：:]?$/u.test(label)
    || (label.includes('允许偏差') && !/[《》；;。/]/u.test(label))) return 'allowable_deviation';
  return 'unclassified';
};

function proseField(text: string, start: number, end: number): FieldRole {
  const selected = text.slice(start, end);
  const own = selected.match(/^\s*(验收依据|允许偏差|质量检验标准|设计要求及规范规定)\s*[：:]/u);
  const prefix = text.slice(0, start).match(/(?:^|[。；;\n])\s*(验收依据|允许偏差|质量检验标准|设计要求及规范规定)\s*[：:][^。；;\n]*$/u);
  const initial = own ? fieldRole(own[1]!) : prefix ? fieldRole(prefix[1]!) : 'unclassified';
  const roles = [initial, ...[...selected.matchAll(/(?:^|[。；;\n])\s*(验收依据|允许偏差|质量检验标准|设计要求及规范规定)\s*[：:]/gu)]
    .map(label => fieldRole(label[1]!))];
  return roles.every(role => role === initial) ? initial : 'ambiguous';
}

/** Physical cells, including colspan/rowspan, determine policy; author labels cannot waive it. */
export function referenceSourceField(ledger: SourceLedger, quote: SourceQuote): FieldRole {
  if (!verifySourceQuote([ledger], quote)) return 'unclassified';
  const block = ledger.blocks.find(row => row.id === quote.block_id)!;
  if (block.kind !== 'table') return proseField(block.text, quote.start, quote.end);
  const rows: Array<Array<{ start: number; end: number; column: number; colspan: number; text: string }>> = [];
  const occupied = new Map<number, number>();
  for (const row of block.text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: typeof rows[number] = [];
    let column = 0;
    const base = row.index! + row[0].indexOf('>') + 1;
    for (const cell of row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while ((occupied.get(column) ?? 0) > rows.length) column += 1;
      const colspan = Math.max(1, Number(cell[1]!.match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1));
      const rowspan = Math.max(1, Number(cell[1]!.match(/\browspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1));
      const start = base + cell.index! + cell[0].indexOf('>') + 1;
      cells.push({ start, end: start + cell[2]!.length, column, colspan, text: cell[2]! });
      for (let c = column; c < column + colspan; c += 1) occupied.set(c, rows.length + rowspan);
      column += colspan;
    }
    rows.push(cells);
  }
  if (!rows.length) {
    let offset = 0;
    for (const line of block.text.split('\n')) {
      const cells: typeof rows[number] = [];
      const parts = [...line.matchAll(/\|([^|]*)/g)];
      parts.forEach((part, column) => cells.push({ start: offset + part.index! + 1,
        end: offset + part.index! + 1 + part[1]!.length, column, colspan: 1, text: part[1]! }));
      rows.push(cells); offset += line.length + 1;
    }
  }
  const selectedRoles: FieldRole[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const selected = rows[i]!.filter(cell => cell.start < quote.end && cell.end > quote.start);
    if (!selected.length) continue;
    const roles = selected.map(cell => {
      const labelRole = fieldRole(cell.text);
      if (labelRole !== 'unclassified') return labelRole;
      const own = proseField(cell.text, Math.max(0, quote.start - cell.start), Math.min(cell.text.length, quote.end - cell.start));
      if (own !== 'unclassified') return own;
      const preceding = rows[i]!.filter(other => other.column < cell.column).reverse();
      for (const label of preceding) { const role = fieldRole(label.text); if (role !== 'unclassified') return role; }
      const header = rows.slice(0, i).reverse().find(row => row.some(c => /^(?:验收|检验|检查)?项目$/u.test(sourceTextForDisplay(c.text).replace(/\s+/gu, ''))));
      const label = header?.find(c => c.column <= cell.column && c.column + c.colspan > cell.column);
      return label ? fieldRole(label.text) : 'unclassified';
    });
    selectedRoles.push(...roles);
  }
  if (selectedRoles.length && selectedRoles.every(role => role === 'acceptance_basis')) return 'acceptance_basis';
  if (selectedRoles.length && selectedRoles.every(role => role === 'allowable_deviation')) return 'allowable_deviation';
  if (selectedRoles.some(role => role !== 'unclassified')) return 'ambiguous';
  return 'unclassified';
}
