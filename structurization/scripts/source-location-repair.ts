import { Ajv } from 'ajv';

/** Detect only mechanically invalid locations, not semantic entailment. */
export function sourceLocationErrors(map: any, lines: string[]) {
  return map.facts.flatMap((f: any) => {
    const valid = Number.isInteger(f.start_line) && Number.isInteger(f.end_line)
      && f.start_line >= 1 && f.end_line >= f.start_line
      && f.end_line <= lines.length && f.end_line - f.start_line < 200;
    const reason = !valid ? 'invalid_range' : !lines.slice(f.start_line - 1, f.end_line).join('\n').trim() ? 'empty_source' : null;
    return reason ? [{ fact_id: f.id, reason, start_line: f.start_line, end_line: f.end_line,
      instruction: `Write repairs[].start_line/end_line for fact ${f.id}: locate supporting original text within lines 1-${lines.length}, ordered, nonblank, at most 200 lines. Return unresolved with a reason if no support is found. Do not change the fact text or other facts.` }] : [];
  });
}
export const sourceRepairSchema = {
  type: 'object', additionalProperties: false, required: ['repairs', 'unresolved'], properties: {
    repairs: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['fact_id', 'start_line', 'end_line'], properties: {
        fact_id: { type: 'string', minLength: 1 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
      } } },
    unresolved: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['fact_id', 'reason'], properties: { fact_id: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } } },
  },
};
const check = new Ajv({ allErrors: true }).compile<any>(sourceRepairSchema);
export function applySourceRepair(map: any, patch: any, lines: string[]) {
  if (!check(patch)) throw new Error(`Invalid source repair: ${JSON.stringify(check.errors)}; use repairs and unresolved arrays`);
  const allowed = new Set(sourceLocationErrors(map, lines).map((e: any) => e.fact_id));
  const submitted = [...patch.repairs, ...patch.unresolved].map((r: any) => r.fact_id);
  if (new Set(submitted).size !== submitted.length || submitted.length !== allowed.size || submitted.some((id: string) => !allowed.has(id))) {
    throw new Error('Source repair must account for each flagged fact exactly once in repairs or unresolved; do not modify unflagged facts');
  }
  const after = { ...map, facts: map.facts.map((f: any) => {
    const r = patch.repairs.find((p: any) => p.fact_id === f.id);
    return r ? { ...f, start_line: r.start_line, end_line: r.end_line } : f;
  }) };
  const repairedIds = new Set(patch.repairs.map((r: any) => r.fact_id));
  if (sourceLocationErrors(after, lines).some((e: any) => repairedIds.has(e.fact_id))) {
    throw new Error('Repair still points to empty/invalid source; no further retry allowed, retain original map');
  }
  return after;
}
export async function repairSourceLocations(map: any, lines: string[], ask: (errors: any[], schema: any) => Promise<any>) {
  const errors = sourceLocationErrors(map, lines);
  if (!errors.length) return { map, errors, patch: null, attempted: false };
  const patch = await ask(errors, sourceRepairSchema); // Exactly one attempt; never loop.
  return { map: applySourceRepair(map, patch, lines), errors, patch, attempted: true };
}
