import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/** Audit hashes cover a fixed UTF-8 prefix; later events must not amplify resume I/O. */
export async function eventPrefixMatches(path: string, bytes: number, expected: string, missingAsEmpty = false): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
  const file = await open(path, 'r').catch(error => {
    if (missingAsEmpty && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!file) return bytes === 0 && createHash('sha256').update('').digest('hex') === expected;
  try {
    if ((await file.stat()).size < bytes) return false;
    const hash = createHash('sha256'), decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(Math.min(bytes, 512 * 1024));
    let position = 0;
    while (position < bytes) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!bytesRead) return false;
      // Preserve the old Buffer.subarray(...).toString('utf8') hash, including invalid UTF-8.
      hash.update(decoder.write(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    hash.update(decoder.end());
    return hash.digest('hex') === expected;
  } finally { await file.close(); }
}
