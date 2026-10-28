import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sha256Json } from './canonical.js';
import { normalizeStandardNo, standardIdentityMatches } from './external-source-workflow.js';

/** Registered by a trusted host after comparing a publisher's attachment bytes, never by the author model. */
export interface OfficialEditionRecord {
  schema_version: 'official-edition-proof/v1';
  standard_no: string;
  original_pdf_sha256: string;
  publication_url: string;
  attachment_url: string;
  publication_markdown: string;
  verified_by: string;
  verified_at: string;
}
export interface ExternalEditionProof {
  record: OfficialEditionRecord;
  record_sha256: string;
  /** Private archive path; never accepted from an author tool. */
  original_pdf_path: string;
}
export interface FrozenEditionProof {
  source_id: string;
  publication_source_id: string;
  record_sha256: string;
  original_pdf_sha256: string;
  standard_no: string;
}
export function validateOfficialEditionRecord(record: OfficialEditionRecord, standardNo: string): string {
  if (record?.schema_version !== 'official-edition-proof/v1'
    || typeof record.standard_no !== 'string' || normalizeStandardNo(record.standard_no) !== normalizeStandardNo(standardNo)
    || !/^[a-f0-9]{64}$/u.test(record.original_pdf_sha256)
    || typeof record.publication_markdown !== 'string' || !standardIdentityMatches(record.publication_markdown, standardNo)
    || typeof record.verified_by !== 'string' || !record.verified_by.trim()
    || typeof record.verified_at !== 'string' || !Number.isFinite(Date.parse(record.verified_at))) {
    throw new Error('Invalid official edition proof or publication version');
  }
  for (const value of [record.publication_url, record.attachment_url]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid official edition proof URL');
  }
  return sha256Json(record);
}
export async function verifyExternalEditionProof(proof: ExternalEditionProof, standardNo: string): Promise<void> {
  const actualRecord = validateOfficialEditionRecord(proof.record, standardNo);
  if (actualRecord !== proof.record_sha256) throw new Error(`Official edition proof record changed: actual_sha256=${actualRecord}, expected_sha256=${proof.record_sha256}; archived evidence is host-owned.`);
  const bytes = await readFile(proof.original_pdf_path);
  const actualPdf = createHash('sha256').update(bytes).digest('hex');
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    || actualPdf !== proof.record.original_pdf_sha256) throw new Error(`Official edition proof attachment changed: actual_sha256=${actualPdf}, expected_sha256=${proof.record.original_pdf_sha256}; restore the host-owned original, do not edit source/.`);
}
