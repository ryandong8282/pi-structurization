/** Physical content ranges; frozen source coordinates and bytes are never rewritten. */
export function documentContentRanges(source: string, start: number, end: number): Array<{ start: number; end: number }> {
  const selected = source.slice(start, end);
  // This exact standalone delimiter is emitted by the Markdown chunk merger.
  // Other comments, inline text and content following a delimiter remain required.
  const markers = [...selected.matchAll(/^[\t ]*<!-- pages_[0-9]{3,}_[0-9]{3,} -->[\t ]*\r?(?:\n|$)/gm)];
  if (!markers.length) return [{ start, end }];
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  const append = (until: number) => {
    const text = selected.slice(cursor, until);
    const leftPadding = cursor === 0 ? 0 : text.length - text.trimStart().length;
    const right = text.trimEnd().length;
    if (right > leftPadding) ranges.push({ start: start + cursor + leftPadding, end: start + cursor + right });
  };
  for (const marker of markers) {
    append(marker.index!);
    cursor = marker.index! + marker[0].length;
  }
  append(selected.length);
  return ranges;
}
