import { createHash } from 'node:crypto';

/** Small, source-anchored regression probes, not a complete semantic gold tree. */
export interface TargetGold {
  schema_version: 'target-gold/v1';
  cases: Array<{
    id: string;
    source_file: string;
    source_sha256: string;
    target_name: string;
    assertions: Array<{
      id: string;
      source_quotes: string[];
      rationale: string;
      match: { clause?: string; name_includes?: string };
      fields: Record<string, string[][]>;
    }>;
  }>;
}

export function compactGoldText(value: unknown): string {
  return String(value ?? '').normalize('NFKC')
    .replace(/\\(?:mathrm|text)\{([^}]+)\}/gu, '$1')
    .replace(/\\(?:leqslant|leq)/gu, '≤').replace(/\\(?:geqslant|geq)/gu, '≥')
    .replace(/\\pm/gu, '±').replace(/[～~–—]/gu, '-')
    .replace(/[\s${}\\^,，。;；:：]/gu, '').toLowerCase();
}

function fieldText(item: Record<string, any>, field: string): string {
  if (field === 'judgment') return [item.name, item.requirement].join(' ');
  if (field === 'sampling') {
    // Reasons, notes, source quotes and debug provenance cannot satisfy a business field.
    return [item.quantity, item.sampling?.min_sampling,
      ...(item.sampling?.applied_branches ?? []).map((b: any) => b.quantity ?? b.min_sampling ?? '')].join(' ');
  }
  return String(item[field] ?? '');
}

export function evaluateTargetGold(gold: TargetGold['cases'][number], source: string, result: any) {
  const sourceValid = createHash('sha256').update(source).digest('hex') === gold.source_sha256;
  const items: Record<string, any>[] = (result.inspection_lots ?? []).flatMap((lot: any) => lot.items ?? []);
  const assertions = gold.assertions.map(a => {
    const anchorsValid = a.source_quotes.length > 0 && a.source_quotes.every(q => q.length > 0 && source.includes(q));
    if (!sourceValid || !anchorsValid) return { id: a.id, status: 'invalid_gold', reason: 'Source fingerprint or verbatim anchor changed; review gold before scoring.' };
    const matches = items.filter(item =>
      (!a.match.clause || [item.source_clause, item.reference_source_clause].some(c =>
        String(c ?? '').split(/[\s,，、;；]+/u).includes(a.match.clause!)))
      && (!a.match.name_includes || compactGoldText(item.name).includes(compactGoldText(a.match.name_includes))));
    // All required fields must belong to one matching judgment. Never combine values from unrelated leaves.
    const candidates = matches.map(item => ({
      item_id: item.item_id, name: item.name,
      missing_fields: Object.entries(a.fields).filter(([field, alternatives]) =>
        !alternatives.some(tokens => tokens.length > 0 && tokens.every(token =>
          compactGoldText(fieldText(item, field)).includes(compactGoldText(token))))).map(([field]) => field),
    }));
    return { id: a.id, status: candidates.some(c => c.missing_fields.length === 0) ? 'pass' : 'fail', candidates, rationale: a.rationale };
  });
  return { case_id: gold.id, scope: 'selected source-anchored assertions; not whole-document accuracy',
    assertions, passed: assertions.filter(a => a.status === 'pass').length, total: assertions.length,
    ok: assertions.length > 0 && assertions.every(a => a.status === 'pass') };
}
