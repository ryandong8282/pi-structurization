import { expect, test } from 'vitest';
import { validateResult, applyReview, businessProjection, parseSubmission, type Result } from '../scripts/minimal-extraction-core.js';

const source = ['当采用甲做法时，间距不大于8mm。', '用尺量。', '每批抽查2件。'];
const draft = (): Result => ({ rows: [{ name: '间距', category: '一般', source_clause: '1',
  requirement: '采用甲做法时，间距≤8mm。', method: '尺量', quantity: '每批2件', note: '', unit: 'mm',
  citations: [
    { fields: ['requirement', 'unit'], start_line: 1, end_line: 1, quote: source[0]! },
    { fields: ['method'], start_line: 2, end_line: 2, quote: source[1]! },
    { fields: ['quantity'], start_line: 3, end_line: 3, quote: source[2]! },
  ],
}], uncertainties: [] });
const patch = () => ({ changes: [], additions: [], remove_indices: [], findings: [], uncertainties: [] });
test('accepts JSON or a sole JSON fence without guessing malformed values', () => {
  expect(parseSubmission(JSON.stringify(draft()))).toEqual(draft());
  expect(parseSubmission('```json\n' + JSON.stringify(draft()) + '\n```')).toEqual(draft());
  expect(() => parseSubmission('{"rows": [broken]}')).toThrow();
});

test('permits faithful synthesis while rejecting fabricated quote numbers and wrong line locations', () => {
  expect(validateResult(draft(), source)).toEqual([]);
  const d = draft(); d.rows[0]!.citations[0]!.quote = '间距不大于9mm';
  expect(validateResult(d, source).join(' ')).toContain('is absent');
  d.rows[0]!.citations[0] = { fields: ['requirement', 'unit'], start_line: 2, end_line: 2, quote: source[0]! };
  expect(validateResult(d, source).join(' ')).toContain('is absent');
});
test('requires populated field references but does not pretend literal grounding proves semantic correctness', () => {
  const d = draft(); d.rows[0]!.citations = d.rows[0]!.citations.filter(c => !c.fields.includes('unit'));
  expect(validateResult(d, source).join(' ')).toContain('unit has no citation');
  const incorrect = draft(); incorrect.rows[0]!.requirement = '所有做法间距≤80mm';
  expect(validateResult(incorrect, source)).toEqual([]); // Deliberate boundary: semantic review must detect this.
});
test('review is atomic, cannot apply conflicting indices, and retains same-name independent branches', () => {
  const before = draft(); before.rows.push({ ...structuredClone(before.rows[0]!), requirement: '另一分支' });
  const frozen = structuredClone(before);
  expect(applyReview(before, patch(), source).rows).toHaveLength(2);
  expect(() => applyReview(before, { ...patch(), remove_indices: [0, 0] }, source)).toThrow('unique');
  expect(() => applyReview(before, { ...patch(), changes: [{ index: 2, row: before.rows[0] }] }, source)).toThrow('0-1');
  const bad = structuredClone(before.rows[0]!); bad.citations[0]!.quote = '伪造原文';
  expect(() => applyReview(before, { ...patch(), changes: [{ index: 0, row: bad }] }, source)).toThrow('absent');
  expect(before).toEqual(frozen);
  expect(businessProjection(before).inspection_lots[0]!.items).toHaveLength(2);
});
