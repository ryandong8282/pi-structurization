import type { lotSplitInputs, SplitSourceSlice } from './lot-split-handoff.js';

type LotInput = ReturnType<typeof lotSplitInputs>[number];
/** Transport pagination only: retain exact UTF-16 source offsets, including within a long table. */
export function lotInputPage(input: LotInput, offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30)
    throw new Error(`Invalid lot input pagination: offset=${offset}, limit=${limit}; use integer offset>=0 and limit=1..30.`);
  const pieces: Array<{ section: 'source' | 'shared' | 'unresolved'; owner: string; piece: SplitSourceSlice }> = [];
  const add = (section: 'source' | 'shared' | 'unresolved', owner: string, source: SplitSourceSlice[]) => {
    for (const piece of source) for (let start = 0; start < piece.text.length;) {
      let end = Math.min(start + 2000, piece.text.length);
      if (end < piece.text.length && /[\uD800-\uDBFF]/u.test(piece.text[end - 1]!)) end--;
      pieces.push({ section, owner, piece: { ...piece, start: piece.start + start, end: piece.start + end,
        text: piece.text.slice(start, end), start_line: piece.start_line + piece.text.slice(0, start).split('\n').length - 1,
        end_line: piece.start_line + piece.text.slice(0, end).split('\n').length - 1 } });
      start = end;
    }
  };
  add('source', input.id, input.source);
  for (const row of input.shared) add('shared', row.id, row.source);
  for (const row of input.unresolved) add('unresolved', row.id, row.source);
  if (offset > pieces.length) throw new Error(`offset=${offset} exceeds total_pieces=${pieces.length}; start from 0 or use the returned next_offset.`);
  const page: LotInput = { ...input, source: [], shared: [], unresolved: [] };
  let count = 0, bytes = 0;
  for (const row of pieces.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (count && bytes + size > 32 * 1024) break;
    if (row.section === 'source') page.source.push(row.piece);
    else {
      let owner = page[row.section].find(item => item.id === row.owner);
      if (!owner) { owner = { ...input[row.section].find(item => item.id === row.owner)!, source: [] }; page[row.section].push(owner); }
      owner.source.push(row.piece);
    }
    count++; bytes += size;
  }
  return { input: page, pagination: { offset, returned_pieces: count, total_pieces: pieces.length,
    next_offset: offset + count < pieces.length ? offset + count : null,
    complete: offset === 0 && count === pieces.length,
    instruction: 'This is one page of exact body/shared source slices. Continue with next_offset; missing slices on this page are not missing original material. Programs may read the complete frozen input file without printing it.' } };
}
