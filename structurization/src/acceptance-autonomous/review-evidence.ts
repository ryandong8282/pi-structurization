import { sha256Json } from '../canonical.js';
import type { GroupReviewResult, SourceBlock, SourceLedger, SourceQuote } from './contracts.js';
import { sourceQuote } from './source-ledger.js';

export interface ReviewEvidenceReference { evidence_id: string; excerpt?: string; occurrence?: number }
export type ReviewSubmission = Omit<GroupReviewResult, 'findings' | 'failure_responses'> & {
  findings: Array<Omit<GroupReviewResult['findings'][number], 'evidence'> & { evidence: Array<SourceQuote | ReviewEvidenceReference> }>;
  failure_responses?: Array<Omit<NonNullable<GroupReviewResult['failure_responses']>[number], 'evidence'> & { evidence: Array<SourceQuote | ReviewEvidenceReference> }>;
};

/** Content-bound IDs survive retries, but cannot point at another version or source occurrence. */
export function reviewEvidenceId(source: SourceLedger, block: SourceBlock): string {
  return `ev:${sha256Json([source.source_id, source.sha256, block.id, block.text]).slice(0, 16)}`;
}

export function reviewEvidenceCatalog(sources: SourceLedger[]) {
  const quotes = new Map<string, SourceQuote>();
  for (const source of sources) for (const block of source.blocks) {
    const id = reviewEvidenceId(source, block), quote = sourceQuote(source, block), previous = quotes.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(quote)) throw Error('Review evidence ID collision');
    quotes.set(id, quote);
  }
  return quotes;
}

/** Resolve mechanical fields only. Semantic findings, decisions and legacy quotes stay untouched. */
export function resolveReviewEvidence(input: ReviewSubmission, sources: SourceLedger[], allowedIds?: Set<string>) {
  const catalog = reviewEvidenceCatalog(sources);
  const issues: Array<{ path: string; actual: unknown; expected: unknown }> = [];
  const resolve = (values: Array<SourceQuote | ReviewEvidenceReference>, path: string): SourceQuote[] => values.map((value, i) => {
    if (!('evidence_id' in value)) return { ...value }; // The existing strict validator still checks these.
    const fail = (expected: unknown) => { issues.push({ path: `${path}/${i}`, actual: value, expected }); return undefined; };
    const block = catalog.get(value.evidence_id);
    if (!block || (allowedIds && !allowedIds.has(value.evidence_id))) return fail({
      instruction: '使用本次冻结 context_file 中的 evidence_id；其他范围先 expand_acceptance_review_source 并读取返回的 context_file。不得猜造编号。',
      next_tool: 'read',
    });
    if (value.excerpt === undefined) {
      if (value.occurrence !== undefined) return fail('occurrence 只用于消除非空 excerpt 的重复位置；整块证据仅提交 evidence_id。');
      return { ...block };
    }
    if (!value.excerpt.length) return fail('excerpt 必须是原文中非空、完全相等的短引文；整块证据省略 excerpt。');
    const positions: number[] = [];
    for (let at = block.text.indexOf(value.excerpt); at !== -1; at = block.text.indexOf(value.excerpt, at + 1)) positions.push(at);
    const occurrence = value.occurrence ?? (positions.length === 1 ? 1 : 0);
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > positions.length) return fail({
      matches: positions.length, occurrence: positions.length ? `1..${positions.length}` : null,
      instruction: 'excerpt 必须逐字匹配冻结原文；重复文字须选 occurrence（从1起）。也可省略 excerpt 引用整块，程序不会模糊修正或猜位置。',
      next_tool: 'submit_acceptance_review',
    });
    const start = positions[occurrence - 1]!;
    return { ...block, start, end: start + value.excerpt.length, text: value.excerpt };
  }).filter((quote): quote is SourceQuote => quote !== undefined);
  const { failure_responses, ...fields } = input;
  const result: GroupReviewResult = { ...fields,
    findings: input.findings.map((row, i) => ({ ...row, evidence: resolve(row.evidence, `/findings/${i}/evidence`) })),
    ...(failure_responses ? { failure_responses: failure_responses.map((row, i) => ({ ...row,
      evidence: resolve(row.evidence, `/failure_responses/${i}/evidence`) })) } : {}),
  };
  // Never accept a partial submission or drop a finding because one reference was invalid.
  return issues.length ? { issues } : { issues, result };
}
