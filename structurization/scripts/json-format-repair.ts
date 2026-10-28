/** Preserve every JSON key and primitive value in order, allowing only punctuation/whitespace edits. */
export function contentTokens(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[\s{}\[\],:]/u.test(text[i]!)) { i++; continue; }
    if (text[i] === '"') {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('Unclosed string: cannot verify original content; retain failure');
      tokens.push('string:' + JSON.stringify(JSON.parse(text.slice(start, i))));
      continue;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i))?.[0];
    if (!token) throw new Error(`Unrecognized content at offset ${i}: cannot guarantee format-only repair`);
    tokens.push('literal:' + token); i += token.length;
  }
  return tokens;
}
export async function repairJsonFormat(original: string, ask: (feedback: string) => Promise<string>) {
  try { return { value: JSON.parse(original), attempted: false, repaired: original }; }
  catch (e) {
    // Refuse to send an unverifiable response for a purported format-only repair.
    const before = contentTokens(original);
    const repaired = await ask(`JSON.parse failed: ${String(e)}. Return only corrected JSON. Preserve every key, string, number, boolean and null in its original order. Change only structural punctuation or whitespace. Do not add/delete/rewrite content. Exactly one attempt.`);
    const value = JSON.parse(repaired);
    if (JSON.stringify(before) !== JSON.stringify(contentTokens(repaired))) {
      throw new Error('Repair changed content tokens; rejected, retain original response');
    }
    return { value, attempted: true, repaired };
  }
}
