import { expect, test } from 'vitest';
import { lotInputPage } from '../src/acceptance-autonomous/lot-input-pages.js';
import { buildAcceptanceSourceLedger, sourceQuote, verifySourceQuote } from '../src/acceptance-autonomous/source-ledger.js';
import type { SplitInputDecision } from '../src/acceptance-autonomous/lot-split-handoff.js';

test('pages a long source block and shared clauses without losing text, exact offsets, or ownership', () => {
  const source = buildAcceptanceSourceLedger('虚构表格条文😀。'.repeat(18000) + '\n\n共用抽样规定。');
  const decision = (index: number, kind: SplitInputDecision['kind']): SplitInputDecision => {
    const block = source.blocks[index]!;
    return { id: `part${index}`, kind, name: `虚构部分${index}`, reason: '中性测试', related_lot_ids: [],
      source: [{ ...sourceQuote(source, block), block: index, start_line: block.start_line, end_line: block.end_line }] };
  };
  const input = { ...decision(0, 'lot'), shared: [decision(1, 'shared')], unresolved: [] };
  const original = JSON.stringify(input), returned: typeof input.source = [];
  let offset: number | null = 0, pages = 0;
  while (offset !== null) {
    const result = lotInputPage(input, offset, 30);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48 * 1024);
    expect(result.pagination.returned_pieces).toBeGreaterThan(0);
    returned.push(...result.input.source, ...result.input.shared.flatMap(row => row.source));
    for (const quote of [...result.input.source, ...result.input.shared.flatMap(row => row.source)])
      expect(verifySourceQuote([source], quote)).toBe(true);
    offset = result.pagination.next_offset; pages++;
  }
  expect(pages).toBeGreaterThan(3);
  for (const block of source.blocks) {
    const pieces = returned.filter(row => row.block_id === block.id);
    expect(pieces.map(row => row.text).join('')).toBe(block.text);
    expect(pieces[0]!.start).toBe(0);
    pieces.slice(1).forEach((piece, i) => expect(piece.start).toBe(pieces[i]!.end));
    expect(pieces.at(-1)!.end).toBe(block.text.length);
  }
  expect(JSON.stringify(input)).toBe(original);
  expect(() => lotInputPage(input, -1)).toThrow(/offset/);
  expect(() => lotInputPage(input, 100000)).toThrow(/total_pieces/);
});
