import { Ajv } from 'ajv';

// Experimental business output, deliberately independent of selector/coverage state.
const string = { type: 'string' };
const object = (properties: Record<string, any>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: any) => ({ type: 'array', items });
export const rowSchema = object({
  name: { ...string, minLength: 1 }, category: string, source_clause: string,
  requirement: { ...string, minLength: 1 }, method: string, quantity: string, note: string, unit: string,
  citations: array(object({
    fields: { type: 'array', minItems: 1, items: { enum: ['name', 'requirement', 'method', 'quantity', 'note', 'unit'] } },
    start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
    quote: { ...string, minLength: 1 },
  })),
});
export const resultSchema = object({ rows: { ...array(rowSchema), minItems: 1 }, uncertainties: array(string) });
export const reviewSchema = object({
  changes: array(object({ index: { type: 'integer', minimum: 0 }, row: rowSchema })),
  additions: array(rowSchema), remove_indices: array({ type: 'integer', minimum: 0 }),
  findings: array(string), uncertainties: array(string),
});
export interface Row {
  name: string; category: string; source_clause: string; requirement: string;
  method: string; quantity: string; note: string; unit: string;
  citations: Array<{ fields: string[]; start_line: number; end_line: number; quote: string }>;
}
export interface Result { rows: Row[]; uncertainties: string[] }
export interface ReviewPatch {
  changes: Array<{ index: number; row: Row }>; additions: Row[]; remove_indices: number[];
  findings: string[]; uncertainties: string[];
}
export function parseSubmission(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}
const ajv = new Ajv({ allErrors: true });
const checkResult = ajv.compile<Result>(resultSchema), checkReview = ajv.compile<ReviewPatch>(reviewSchema);
const compact = (s: string) => s.replace(/\s/gu, '');

/** Only structure and literal grounding, never semantic acceptance or automatic field routing. */
export function validateResult(value: unknown, lines: string[]): string[] {
  if (!checkResult(value)) return (checkResult.errors ?? []).map(e => `${e.instancePath}: ${e.message} ${JSON.stringify(e.params)}`);
  const errors: string[] = [];
  (value as Result).rows.forEach((row, i) => {
    row.citations.forEach((c, j) => {
      if (c.end_line < c.start_line || c.end_line > lines.length || c.end_line - c.start_line >= 200)
        errors.push(`/rows/${i}/citations/${j}: invalid range ${c.start_line}-${c.end_line}; use 1-${lines.length}, at most 200 lines.`);
      else if (!compact(c.quote) || !compact(lines.slice(c.start_line - 1, c.end_line).join('\n')).includes(compact(c.quote)))
        errors.push(`/rows/${i}/citations/${j}/quote: ${JSON.stringify(c.quote)} is absent in cited lines; read_source and copy an actual excerpt (only whitespace differences are accepted).`);
    });
    for (const field of ['requirement', 'method', 'quantity', 'note', 'unit'] as const)
      if (row[field].trim() && !row.citations.some(c => c.fields.includes(field)))
        errors.push(`/rows/${i}/citations: populated ${field} has no citation; add its exact source, or remove unsupported text and record uncertainty.`);
  });
  return errors;
}

export function applyReview(before: Result, patch: any, lines: string[]): Result {
  if (!checkReview(patch)) throw new Error(JSON.stringify(checkReview.errors));
  const indices = [...patch.changes.map((c: any) => c.index), ...patch.remove_indices];
  if (indices.some(i => i >= before.rows.length) || new Set(indices).size !== indices.length)
    throw new Error(`changes/index and remove_indices must be unique, disjoint indices in 0-${before.rows.length - 1}; received ${JSON.stringify(indices)}.`);
  const rows = before.rows.flatMap((row, i) => patch.remove_indices.includes(i) ? [] : [patch.changes.find((c: any) => c.index === i)?.row ?? row]);
  const after = { rows: [...rows, ...patch.additions], uncertainties: patch.uncertainties };
  const errors = validateResult(after, lines);
  if (errors.length) throw new Error(errors.join('\n'));
  return after;
}

export function businessProjection(result: Result) {
  // Evaluation adapter only: not an acceptance-result/v9 product and never published.
  return { inspection_lots: [{ name: 'experimental', items: result.rows.map((row, i) => ({
    ...row, item_id: `experimental:${i}`, table_semantics: row.unit ? { unit: row.unit } : null,
  })) }] };
}

/** Optional auxiliary metadata at the experimental ingestion boundary; never synthesize an empty model claim. */
export function inspectExtraction(value: unknown, lines: string[]) {
  const missing = !!value && typeof value === 'object' && !Array.isArray(value)
    && !Object.prototype.hasOwnProperty.call(value, 'uncertainties');
  // Validation-only placeholder allows all existing row/citation checks to run. It is never returned as model data.
  const errors = validateResult(missing ? { ...value, uncertainties: [] } : value, lines);
  return { errors, uncertainty_status: missing ? 'not_returned' : 'returned',
    notices: missing ? ['Model did not return uncertainty notes; this does not mean no uncertainty exists.'] : [] };
}
