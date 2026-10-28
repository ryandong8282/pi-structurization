import type { DocumentLedger } from './document-ledger.js';
import type { SourceLineWindow } from './source-window.js';

/** Navigation only: title recognition nominates context, never decides applicability or drops source. */
export function governingContextWindows(ledger: DocumentLedger, target: SourceLineWindow): SourceLineWindow[] {
  // Recover only the existing context titles for navigation. Do not reinterpret
  // numeric prose, change the frozen ledger, or create a primary target window.
  const navigationHeadings = ledger.headings.map(h => {
    const compact = !h.number && /^(\d+(?:[.．]\d+)*)(一般规定|基本规定|总则)$/u.exec(h.title.replace(/\s/gu, ''));
    return compact ? { ...h, number: compact[1]!.replaceAll('．', '.'), title: compact[2]! } : h;
  });
  const headings = navigationHeadings.filter(h => h.line <= target.start_line && /^\d+(?:\.\d+)*$/u.test(h.number));
  const owner = [...headings].reverse().find(h => h.role === 'target_window');
  if (!owner) return [];
  return headings.filter(h => {
    if (!/^(?:一般规定|基本规定|总则)$/u.test(h.title.replace(/\s/gu, ''))) return false;
    const parent = h.number.split('.').slice(0, -1).join('.');
    return !parent || owner.number.startsWith(parent + '.');
  }).map(h => {
    const depth = h.number.split('.').length;
    const next = navigationHeadings.find(n => n.line > h.line && /^\d+(?:\.\d+)*$/u.test(n.number) && n.number.split('.').length <= depth);
    return { start_line: h.line, end_exclusive_line: Math.min(next?.line ?? target.start_line, target.start_line) };
  }).filter(w => w.end_exclusive_line > w.start_line);
}

/** Space-separated search terms are alternatives, with exact phrases/all-term hits ranked first. */
export function documentSearchMatch(text: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const terms = [...new Set(needle.split(/\s+/u).filter(Boolean))];
  const lower = text.toLocaleLowerCase();
  const offsets = terms.map(term => lower.indexOf(term));
  const matched = terms.filter((_, i) => offsets[i]! >= 0);
  const exact = lower.indexOf(needle);
  if (!needle || matched.length === 0) return null;
  return { offset: exact >= 0 ? exact : Math.min(...offsets.filter(i => i >= 0)),
    matched_terms: matched, score: (exact >= 0 ? terms.length + 1 : 0) + matched.length };
}
