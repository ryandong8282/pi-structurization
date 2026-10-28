import type { SourceLedger } from './contracts.js';

/** Native read is line-based, but its byte cap can stop within a source line. */
export function sourceReadExposure(source: SourceLedger, frozenFile: string, format: 'markdown' | 'ledger', offset: number, returned: string): string[] {
  const lines = frozenFile.split('\n');
  const start = lines.slice(0, Math.max(0, offset - 1)).reduce((n, line) => n + line.length + 1, 0);
  let length = 0;
  while (length < returned.length && start + length < frozenFile.length && returned[length] === frozenFile[start + length]) length++;
  const end = start + length;
  if (!length) return [];
  if (format === 'markdown') return source.blocks.filter(block => block.start < end && block.end > start).map(block => block.id);
  // Only returned block text counts. Ledger IDs, coordinates and file headers do not.
  let cursor = 0;
  return source.blocks.flatMap(block => {
    const property = `"text": ${JSON.stringify(block.text)}`;
    const position = frozenFile.indexOf(property, cursor);
    if (position < 0) throw new Error('Frozen source ledger text layout is unavailable.');
    cursor = position + property.length;
    const textStart = position + '"text": "'.length;
    return textStart < end && cursor - 1 > start ? [block.id] : [];
  });
}
