export interface SourceLineWindow {
  start_line: number;
  end_exclusive_line: number;
}

/** Exact, non-whitespace intersection; offsets remain relative to immutable text. */
export function clipSourceToLineWindow(
  source: { start_line: number; text: string },
  window: SourceLineWindow,
): { start: number; end: number } | undefined {
  const lineStarts = [0];
  for (let index = 0; index < source.text.length; index += 1) {
    if (source.text[index] === "\n") lineStarts.push(index + 1);
  }
  const offset = (line: number): number => line <= source.start_line
    ? 0 : lineStarts[line - source.start_line] ?? source.text.length;
  const from = offset(window.start_line);
  const to = offset(window.end_exclusive_line);
  if (from >= to) return undefined;
  const text = source.text.slice(from, to);
  if (!text.trim()) return undefined;
  return {
    start: from + text.length - text.trimStart().length,
    end: to - (text.length - text.trimEnd().length),
  };
}
