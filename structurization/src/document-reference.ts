import type { ExternalStandardDocument } from "./external-source-workflow.js";
import type { ExternalReferenceContentScope } from "./contracts.js";
import { resolveExternalReferenceScope } from "./external-reference-scope.js";
import { planReferenceCorrection, type ReferenceCorrectionRequest } from "./reference-correction.js";
import { readFile } from "node:fs/promises";

import { atomicWriteJson } from "./atomic.js";
import { sha256Json, sha256Text } from "./canonical.js";
import { sourceBoundaryNeighbors } from "./source-boundary-review.js";
import {
  canAnchorStaticTableReference,
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceLiterals,
  referenceOccurrenceOriginEvidenceIds,
  referenceOccurrenceOriginSpanIds,
  referenceOccurrenceTargetLocator,
  sameLogicalReferenceOccurrence,
  type EvidenceManifest,
  type EvidenceRecord,
  type ReferenceOccurrence,
  type ReferenceTargetField,
  type RevisionState,
  type TableFragmentEvidence,
} from "./contracts.js";
import {
  buildGranularProseCoverageEvidence,
  buildStructuredTargetEvidence,
  type EvidenceLineWindow,
} from "./evidence.js";
import { documentNormativeEndLine } from "./document-ledger.js";
import { NUMBERED_PROSE_BOUNDARY } from "./text-normalization.js";
import {
  registerSourceSpan,
  resolveSourceSpan,
  type ResolvedSourceSpan,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import type { RevisionWorkspace } from "./workspace.js";

export type DocumentReferenceKind = "clause" | "section" | "table" | "appendix" | "standard";

export interface DocumentReferenceTarget {
  source_id?: string;
  kind: DocumentReferenceKind;
  number: string;
  paragraph?: string;
  candidate_start_line?: number;
}

export interface DocumentReferenceRequest extends ReferenceCorrectionRequest {
  origin_span_id?: string;
  origin_span_ids?: string[];
  origin_field: Exclude<ReferenceTargetField, "reference_only">;
  reference_literal_span_id?: string;
  reference_literal_span_ids?: string[];
  raw_reference: string;
  normalized_reference?: string;
  target: DocumentReferenceTarget;
  relation: string;
  external_standard?: ReferenceOccurrence["external_standard"];
  content_scope?: ExternalReferenceContentScope;
}

const MAX_COMPOSITE_REFERENCE_SPANS = 3;

function referenceSpanIds(
  single: string | undefined,
  multiple: readonly string[] | undefined,
): string[] {
  return multiple?.length ? [...multiple] : single ? [single] : [];
}

function safeReferenceComparable(value: string): string {
  return value.normalize("NFKC")
    .replace(/<!--\s*pages?[^>]*-->/giu, "")
    .replace(/[\s*_`#]/gu, "")
    .toUpperCase();
}

function occurrenceLiteralIdentityParts(
  originEvidenceId: string,
  literals: readonly ResolvedSourceSpan[],
): string[] {
  if (literals.length === 1) {
    const literal = literals[0]!;
    return [originEvidenceId, literal.evidence_id, String(literal.start), String(literal.end)];
  }
  return [
    "composite-reference/v1",
    ...literals.flatMap((literal) => [
      literal.evidence_id,
      String(literal.start),
      String(literal.end),
    ]),
  ];
}

function occurrenceProvenance(
  originSpanIds: readonly string[],
  literals: readonly ResolvedSourceSpan[],
): Pick<ReferenceOccurrence,
  "origin_evidence_id" | "origin_evidence_ids" | "origin_span_id" | "origin_span_ids"
  | "reference_literal_span_id" | "reference_literal_span_ids" | "reference_literal" | "reference_literals"
> {
  const firstLiteral = literals[0]!;
  const originEvidenceIds = literals.map((literal) => literal.evidence_id);
  const literalCoordinates = literals.map((literal) => ({
    evidence_id: literal.evidence_id,
    start: literal.start,
    end: literal.end,
  }));
  return {
    origin_evidence_id: originEvidenceIds[0]!,
    ...(originEvidenceIds.length > 1 ? { origin_evidence_ids: originEvidenceIds } : {}),
    origin_span_id: originSpanIds[0]!,
    ...(originSpanIds.length > 1 ? { origin_span_ids: [...originSpanIds] } : {}),
    reference_literal_span_id: firstLiteral.span_id,
    ...(literals.length > 1 ? { reference_literal_span_ids: literals.map((literal) => literal.span_id) } : {}),
    reference_literal: literalCoordinates[0]!,
    ...(literalCoordinates.length > 1 ? { reference_literals: literalCoordinates } : {}),
  };
}

function evidenceLine(record: EvidenceRecord): number | undefined {
  const match = /(?:^|\/)line:(\d+)(?:\/|$)/u.exec(record.locator);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function compositeReferenceReviewWindow(
  evidence: EvidenceManifest,
  registry: SourceSpanRegistry,
  originEvidenceIds: readonly string[],
) {
  const indexed = evidence.evidence.map((record, index) => ({ record, index, line: evidenceLine(record) }))
    .filter((entry): entry is { record: EvidenceRecord; index: number; line: number } => entry.line !== undefined)
    .sort((left, right) => left.line - right.line || left.index - right.index);
  const originIndexes = indexed.flatMap((entry, index) => originEvidenceIds.includes(entry.record.evidence_id) ? [index] : []);
  if (!originIndexes.length) return [];
  const start = Math.max(0, Math.min(...originIndexes) - 2);
  const end = Math.min(indexed.length, Math.max(...originIndexes) + 3);
  return indexed.slice(start, end).map(({ record, line }) => ({
    evidence_id: record.evidence_id,
    locator: record.locator,
    line,
    atom_id: record.atom_id ?? null,
    clause_id: record.clause_id ?? null,
    role: record.role,
    text: record.text,
    full_span_id: registry.spans.find(span => span.evidence_id === record.evidence_id
      && span.start === 0 && span.end === record.text.length)?.span_id ?? null,
    relation_to_origin: originEvidenceIds.includes(record.evidence_id) ? "current" : "neighbor",
  }));
}

function shortReferenceNeedsCompositeReview(value: string): boolean {
  const compact = safeReferenceComparable(value);
  return compact.length <= 3
    || /^[A-Z]{1,2}(?:\.\d+)*$/u.test(compact)
    || /^\d+(?:\.\d+)+(?:条)?$/u.test(compact)
    || /^\d{2,}$/u.test(compact);
}

function hasCompositeReferenceLead(
  origins: readonly ResolvedSourceSpan[],
  window: ReturnType<typeof compositeReferenceReviewWindow>,
  rawReference: string,
): boolean {
  const lead = /(?:(?:本\s*(?:规范|标准)?\s*)?(?:附录|表|第)|GB\s*\/?\s*T|Appendix)\s*$/iu;
  const compact = safeReferenceComparable(rawReference);
  if (/^[A-Z]{1,2}$/u.test(compact) && origins.some(origin => {
    const index = origin.text.indexOf(rawReference);
    return index >= 0 && lead.test(origin.text.slice(Math.max(0, index - 32), index).trimEnd());
  })) return true;
  const firstCurrent = window.findIndex(entry => entry.relation_to_origin === "current");
  if (firstCurrent <= 0) return false;
  const previous = window.slice(Math.max(0, firstCurrent - 2), firstCurrent);
  const current = window[firstCurrent]!;
  return previous.some(entry => (
    (entry.clause_id && entry.clause_id === current.clause_id)
    || (entry.atom_id && entry.atom_id === current.atom_id)
  ) && lead.test(entry.text.trimEnd()));
}

export function compositeReferenceReviewCandidate(
  evidence: EvidenceManifest,
  registry: SourceSpanRegistry,
  occurrence: ReferenceOccurrence,
): Record<string, unknown> | undefined {
  if (!shortReferenceNeedsCompositeReview(occurrence.raw_reference)) return undefined;
  const records = new Map(evidence.evidence.map(record => [record.evidence_id, record]));
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const origins = referenceOccurrenceOriginSpanIds(occurrence).flatMap(spanId => {
    const span = spans.get(spanId);
    const record = span ? records.get(span.evidence_id) : undefined;
    return span && record ? [{ ...span, text: record.text.slice(span.start, span.end) }] : [];
  });
  const window = compositeReferenceReviewWindow(evidence, registry, referenceOccurrenceOriginEvidenceIds(occurrence));
  if (!origins.length || !hasCompositeReferenceLead(origins, window, occurrence.raw_reference)) return undefined;
  return {
    status: "review",
    reason: "existing_short_occurrence_may_be_one_fragment_of_a_composite_reference",
    adjacent_source_window: window,
    current_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
    required_action: "reresolve_with_ordered_literal_spans_and_normalized_reference_or_keep_unresolved",
    next_tools: ["open_evidence", "locate_evidence_span", "resolve_document_reference"],
  };
}

export function compositeReferenceReviewCandidates(
  evidence: EvidenceManifest,
  registry: SourceSpanRegistry,
): Array<Record<string, unknown>> {
  const ordered = evidence.evidence.map((record, index) => ({ record, index, line: evidenceLine(record) }))
    .filter((entry): entry is { record: EvidenceRecord; index: number; line: number } => entry.line !== undefined)
    .sort((left, right) => left.line - right.line || left.index - right.index);
  const result: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const leadPattern = /((?:本\s*(?:规范|标准)?\s*)?(?:附录|表|第)|GB\s*\/?\s*T|Appendix)\s*$/iu;
  const tokenPattern = /^\s*([A-Z]{1,2}(?:\.\d+)*|\d+(?:\.\d+)*(?:条)?|[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十])(?=$|[\s.。的款])/iu;
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index]!.record;
    const right = ordered[index + 1]!.record;
    const sameSourceUnit = (left.clause_id && left.clause_id === right.clause_id)
      || (left.atom_id && left.atom_id === right.atom_id
        && !["section_heading", "formal_table_row"].includes(left.role)
        && !["section_heading", "formal_table_row"].includes(right.role));
    if (!sameSourceUnit) continue;
    const lead = leadPattern.exec(left.text.trimEnd());
    const token = tokenPattern.exec(right.text);
    if (!lead || !token || /^\s*[^\s]*级/u.test(right.text)) continue;
    const key = `${left.evidence_id}\0${right.evidence_id}\0${lead[1]}\0${token[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      candidate_id: `composite-reference-candidate:${sha256Text(key)}`,
      status: "review",
      lead_fragment: { evidence_id: left.evidence_id, locator: left.locator, atom_id: left.atom_id ?? null, text: lead[1] },
      trailing_fragment: { evidence_id: right.evidence_id, locator: right.locator, atom_id: right.atom_id ?? null, text: token[1] },
      adjacent_source_window: compositeReferenceReviewWindow(evidence, registry, [left.evidence_id, right.evidence_id]),
      required_action: "review_then_locate_ordered_literal_spans_or_leave_unresolved",
      instruction: "这是高召回导航候选，不是程序拼接结论。结合完整相邻原文判断是否为同一引用；确认后定位各段并提交 normalized_reference。",
    });
  }
  return result;
}

export interface DocumentReferenceCandidate {
  locator: string;
  start_line: number;
  end_exclusive_line: number;
  preview: string;
}

export const DOCUMENT_REFERENCE_EVIDENCE_PAGE_SIZE = 24;
const DOCUMENT_REFERENCE_EVIDENCE_PAGE_MAX_BYTES = 48 * 1024;
export type DocumentReferenceReadPhase = "target" | "coverage";

function documentReferenceReadPolicy(occurrence: ReferenceOccurrence): "exact" | "exhaustive" {
  return occurrence.reference_kind === "clause"
      && ["appendix", "section"].includes(occurrence.target_address.locator_kind)
    ? "exhaustive"
    : "exact";
}

export function documentReferenceTargetReadIdentity(occurrence: ReferenceOccurrence): {
  target_key: string;
  target_locator: string;
  target_fingerprint: string;
  target_evidence_count: number;
} {
  const targetLocator = referenceOccurrenceTargetLocator(occurrence);
  const targetFingerprint = sha256Json(occurrence.target_evidence_ids);
  return {
    target_key: `reference-target:${sha256Text(`${targetLocator}\0${targetFingerprint}`)}`,
    target_locator: targetLocator,
    target_fingerprint: targetFingerprint,
    target_evidence_count: occurrence.target_evidence_ids.length,
  };
}

export function documentReferenceReadProgress(
  state: RevisionState,
  occurrence: ReferenceOccurrence,
  phase: DocumentReferenceReadPhase = "target",
): {
  occurrence_id: string;
  progress: NonNullable<RevisionState["document_reference_reads"]>[string];
} | undefined {
  const reads = state.document_reference_reads ?? {};
  const identity = documentReferenceTargetReadIdentity(occurrence);
  const candidates = Object.entries(reads).filter(([occurrenceId, progress]) =>
    progress.content_mode === "full_text"
    && (progress.phase ?? "target") === phase
    && (
      progress.target_key === identity.target_key
      || (occurrenceId === occurrence.occurrence_id && !progress.target_key)
    )
  );
  return candidates.sort((left, right) => {
    const leftProgress = left[1];
    const rightProgress = right[1];
    if (leftProgress.done !== rightProgress.done) return leftProgress.done ? -1 : 1;
    return (rightProgress.next_cursor ?? Number.MAX_SAFE_INTEGER)
      - (leftProgress.next_cursor ?? Number.MAX_SAFE_INTEGER);
  }).map(([occurrenceId, progress]) => ({
    occurrence_id: phase === "coverage" && occurrenceId.startsWith("coverage:")
      ? occurrenceId.slice("coverage:".length)
      : occurrenceId,
    progress,
  }))[0];
}

export function documentReferenceEvidencePage(
  manifest: EvidenceManifest,
  registry: SourceSpanRegistry,
  occurrenceId: string,
  cursorInput = 0,
  limitInput = DOCUMENT_REFERENCE_EVIDENCE_PAGE_SIZE,
): { ok: boolean; [key: string]: unknown } {
  const occurrence = manifest.reference_occurrences.find((entry) => entry.occurrence_id === occurrenceId);
  if (!occurrence) return { ok: false, error: "document_reference_occurrence_not_found", occurrence_id: occurrenceId };
  const cursor = Math.max(0, Math.trunc(cursorInput) || 0);
  const limit = Math.min(50, Math.max(1, Math.trunc(limitInput) || DOCUMENT_REFERENCE_EVIDENCE_PAGE_SIZE));
  const targetEvidenceIds = occurrence.target_evidence_ids;
  const pageIds = targetEvidenceIds.slice(cursor, cursor + limit);
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const evidence = pageIds.flatMap((evidenceId) => {
    const record = evidenceById.get(evidenceId);
    if (!record) return [];
    const span = registry.spans.find((candidate) =>
      candidate.evidence_id === evidenceId
      && candidate.start === 0
      && candidate.end === record.text.length
    );
    return [{
      ...documentReferenceDecompositionInventory(manifest, occurrence, [evidenceId])[0],
      span_id: span?.span_id ?? "",
      text: record.text,
      boundary_neighbors: sourceBoundaryNeighbors(manifest.evidence, evidenceId),
    }];
  });
  while (
    evidence.length > 1
    && Buffer.byteLength(JSON.stringify(evidence), "utf8") > DOCUMENT_REFERENCE_EVIDENCE_PAGE_MAX_BYTES
  ) {
    evidence.pop();
  }
  const nextCursor = cursor + evidence.length < targetEvidenceIds.length
    ? cursor + evidence.length
    : null;
  return {
    ok: true,
    occurrence_id: occurrenceId,
    cursor,
    limit: evidence.length,
    total_count: targetEvidenceIds.length,
    next_cursor: nextCursor,
    done: nextCursor === null,
    evidence,
    decomposition_review: {
      required: true,
      component_count: targetEvidenceIds.length,
      instruction: "逐组件决定映射到独立 item、显式同一判断、完整 acceptance branch，或不适用；不得只声明引用已闭合。",
    },
    instruction: nextCursor === null
      ? "引用证据正文已完整读取。"
      : "继续调用 read_document_reference_evidence，沿用同一 target_key 并精确传入本回执的 next_cursor；整段结构引用在 done=true 前不得继续推进或提交。",
  };
}

export async function readAndRecordDocumentReferenceEvidencePage(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  occurrenceId: string,
  cursorInput = 0,
  limitInput = DOCUMENT_REFERENCE_EVIDENCE_PAGE_SIZE,
  phase: DocumentReferenceReadPhase = "target",
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const occurrence = manifest.reference_occurrences.find((entry) => entry.occurrence_id === occurrenceId);
  if (!occurrence) return { ok: false, error: "document_reference_occurrence_not_found", occurrence_id: occurrenceId };
  const state = await workspace.readState();
  const matchedProgress = documentReferenceReadProgress(state, occurrence, phase);
  const progress = matchedProgress?.progress;
  const readPolicy = progress?.read_policy ?? documentReferenceReadPolicy(occurrence);
  const replayingCompletedRead = progress?.done === true;
  if (!replayingCompletedRead) {
    const expectedCursor = progress?.next_cursor ?? 0;
    const cursor = Math.max(0, Math.trunc(cursorInput) || 0);
    if (cursor !== expectedCursor) {
      return {
        ok: false,
        error: "document_reference_evidence_cursor_mismatch",
        occurrence_id: occurrenceId,
        read_policy: readPolicy,
        expected_cursor: expectedCursor,
        received_cursor: cursor,
        required_action: "read_the_next_reference_page_in_order",
      };
    }
  }
  const page = documentReferenceEvidencePage(
    manifest,
    await workspace.readSourceSpanRegistry(),
    occurrenceId,
    cursorInput,
    limitInput,
  );
  if (page.ok !== true) return page;
  const nextCursor = typeof page.next_cursor === "number" ? page.next_cursor : null;
  const totalCount = Number(page.total_count ?? occurrence.target_evidence_ids.length);
  const done = nextCursor === null;
  const identity = documentReferenceTargetReadIdentity(occurrence);
  if (!replayingCompletedRead) {
    await workspace.recordDocumentReferenceReadProgress(occurrenceId, {
      phase,
      read_policy: readPolicy,
      content_mode: "full_text",
      total_count: totalCount,
      next_cursor: nextCursor,
      done,
      ...identity,
    });
  }
  return {
    ...page,
    read_policy: readPolicy,
    done,
    target_read: identity,
    ...(matchedProgress?.occurrence_id !== occurrenceId
      ? { shared_from_occurrence_id: matchedProgress?.occurrence_id }
      : {}),
  };
}

export type DocumentReferenceTargetResolution =
  | {
      ok: true;
      locator: string;
      evidence: EvidenceRecord[];
      target_evidence_ids: string[];
      selected_candidate?: DocumentReferenceCandidate;
      other_candidates?: DocumentReferenceCandidate[];
    }
  | {
      ok: false;
      error: "not_found" | "candidate_not_found" | "source_not_available";
      locator: string;
      candidates: DocumentReferenceCandidate[];
    };

interface NumberedUnitLine {
  line: number;
  unit_id: string;
  component_count: number;
  heading: boolean;
}

function normalizedNumber(value: string): string {
  return value.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
}

function numberedUnitLines(lines: string[]): NumberedUnitLine[] {
  const units = lines.flatMap((raw, index) => {
    const text = raw.trim().replace(/\s*\[PDF p\.\d+\]\s*$/u, "");
    if (/[.．…·]{2,}\s*[(（]?\s*\d+\s*[)）]?\s*$/u.test(text)) return [];
    const heading = new RegExp(String.raw`^#{1,6}\s+((?:[A-Za-z]\s*[.．]\s*\d+|\d+)(?:\s*[.．]\s*\d+)*)(?:$|${NUMBERED_PROSE_BOUNDARY})`, "u").exec(text);
    const clause = new RegExp(String.raw`^((?:[A-Za-z]\s*[.．]\s*\d+|\d+)(?:\s*[.．]\s*\d+)+)(?:$|${NUMBERED_PROSE_BOUNDARY})`, "u").exec(raw.trim());
    const match = heading ?? clause;
    if (!match?.[1]) return [];
    const unitId = normalizedNumber(match[1]);
    if (heading && unitId.split(".").length < 3 && /\s+[(（]?\d+[)）]?\s*$/u.test(text)) return [];
    return [{
      line: index + 1,
      unit_id: unitId,
      component_count: unitId.split(".").length,
      heading: Boolean(heading),
    }];
  });
  // MinerU sometimes leaves a numbered section title as plain text. Promote it
  // only when subsequent numbered clauses prove that it is their parent.
  const withPlainSectionHeadings = units.map((unit, index) => {
    if (unit.heading || unit.component_count !== 2) return unit;
    const nextPeer = units.slice(index + 1).find((candidate) =>
      candidate.component_count <= unit.component_count
    );
    const hasOwnClause = units.some((candidate) =>
      candidate.line > unit.line
      && candidate.line < (nextPeer?.line ?? lines.length + 1)
      && candidate.component_count > unit.component_count
      && candidate.unit_id.startsWith(`${unit.unit_id}.`)
    );
    return hasOwnClause ? { ...unit, heading: true } : unit;
  });
  return withPlainSectionHeadings.filter((unit, _index, units) => {
    // A bare list number is never a chapter. OCR sometimes promotes list
    // entries to Markdown headings; use numbered descendants when available.
    if (unit.component_count !== 1) return true;
    const nextChapter = units.find((next) => next.line > unit.line && next.component_count === 1);
    if (units.some((child) => child.line > unit.line
      && child.line < (nextChapter?.line ?? lines.length + 1)
      && child.unit_id.startsWith(`${unit.unit_id}.`))) return true;
    // The next chapter may contain only unnumbered prose, or be truncated in
    // the source. It still closes the current chapter. A smaller list heading
    // inside an already numbered clause does not start a new chapter.
    const previousClause = units.filter((previous) => previous.line < unit.line && previous.component_count >= 3).at(-1);
    return !previousClause || Number(unit.unit_id) > Number(previousClause.unit_id.split(".")[0]);
  });
}

function referenceNormativeLines(lines: string[]): string[] {
  const masked = [...lines];
  let inContents = false;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.trim().replace(/\s*\[PDF p\.\d+\]\s*$/u, "");
    if (/^(?:#{1,6}\s*)?(?:目\s*[录次]|(?:table\s+of\s+)?contents)\s*$/iu.test(text)) inContents = true;
    if (!inContents) continue;
    const number = /^#{1,6}\s+(\d+(?:[.．]\d+)*)(?:\s|$)/u.exec(text)?.[1];
    // The first actual body heading has a formal clause below it. TOC
    // headings (including page-number-free OCR entries) do not.
    if (number) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next]!.trim();
        if (/^#{1,6}\s+\d+(?:\s|$)/u.test(line)) break;
        if (/^(?:#{1,6}\s+)?\d+(?:[.．]\d+){2,}\s+\S/u.test(line)
          && line.replace(/^#{1,6}\s+/u, "").startsWith(`${number}.`)
          && !/(?:[.．…·]{2,}|\s)\s*\d+\s*$/u.test(line)) {
          inContents = false;
          break;
        }
      }
    }
    if (inContents) masked[index] = "";
  }
  return masked.slice(0, (documentNormativeEndLine(masked) ?? masked.length + 1) - 1);
}

function lineCandidate(
  lines: string[],
  locator: string,
  window: EvidenceLineWindow,
): DocumentReferenceCandidate {
  return {
    locator,
    start_line: window.start_line,
    end_exclusive_line: window.end_exclusive_line,
    preview: lines
      .slice(window.start_line - 1, Math.min(window.end_exclusive_line - 1, window.start_line + 2))
      .join("\n")
      .slice(0, 360),
  };
}

function unitWindow(
  lines: string[],
  units: NumberedUnitLine[],
  unit: NumberedUnitLine,
  kind: "clause" | "section",
  paragraph: string,
): EvidenceLineWindow | undefined {
  const appendix = lines.findIndex((line, index) => index + 1 > unit.line && /^#{1,6}\s+附录\s*[A-Za-z0-9]/u.test(line.trim()));
  let endExclusiveLine = appendix < 0 ? lines.length + 1 : appendix + 1;
  if (kind === "section") {
    const next = units.find((candidate) =>
      candidate.line > unit.line
      && candidate.heading
      && candidate.component_count <= unit.component_count
    );
    return {
      start_line: unit.line,
      end_exclusive_line: Math.min(next?.line ?? endExclusiveLine, endExclusiveLine),
    };
  }
  const next = units.find((candidate) => candidate.line > unit.line
    && (!candidate.heading || candidate.component_count <= unit.component_count));
  endExclusiveLine = Math.min(next?.line ?? endExclusiveLine, endExclusiveLine);
  if (!paragraph) {
    return { start_line: unit.line, end_exclusive_line: endExclusiveLine };
  }
  const escaped = paragraph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paragraphPattern = new RegExp(`^\\s*${escaped}\\s+`, "u");
  let paragraphLine = -1;
  for (let line = unit.line + 1; line < endExclusiveLine; line += 1) {
    if (paragraphPattern.test(lines[line - 1] ?? "")) {
      paragraphLine = line;
      break;
    }
  }
  if (paragraphLine < 0) return undefined;
  for (let line = paragraphLine + 1; line < endExclusiveLine; line += 1) {
    if (/^\s*\d+\s+/u.test(lines[line - 1] ?? "")) {
      endExclusiveLine = line;
      break;
    }
  }
  return { start_line: paragraphLine, end_exclusive_line: endExclusiveLine };
}

function appendixWindows(lines: string[], number: string): EvidenceLineWindow[] {
  const requested = normalizedNumber(number).toLocaleUpperCase();
  const headings = lines.flatMap((raw, index) => {
    const match = /^#{1,6}\s+附录\s*([A-Za-z0-9]+)(?:\s|$)/u.exec(raw.trim());
    return match?.[1]
      ? [{ line: index + 1, number: normalizedNumber(match[1]).toLocaleUpperCase() }]
      : [];
  });
  return headings.flatMap((heading, index) => heading.number === requested
    ? [{
        start_line: heading.line,
        end_exclusive_line: headings[index + 1]?.line ?? lines.length + 1,
      }]
    : []);
}

function dependencyRecord(record: EvidenceRecord): EvidenceRecord {
  return {
    ...record,
    requires_disposition: false,
    evidence_scope: "reference",
    registered_dependency: true,
  };
}

function decodeHtmlCell(value: string): string {
  return value
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .trim();
}

function structuredReferenceRows(records: EvidenceRecord[]): EvidenceRecord[] {
  let tableId = "";
  let tableTitle = "";
  let captionedTableLine = "";
  const headersByLine = new Map<string, string[]>();
  return records.map((record, index) => {
    const caption = /^表\s*([0-9A-Za-z]+(?:\s*[.．]\s*[0-9]+)*(?:\s*-\s*\d+)?)/u
      .exec(record.text.trim());
    if (caption?.[1]) {
      tableId = normalizedNumber(caption[1]);
      tableTitle = record.text.trim();
      const following = /^(line:\d+)\/table-row:1$/u.exec(records[index + 1]?.locator ?? "");
      captionedTableLine = following?.[1] ?? "";
      // Keep the existing HTML source records and give a real adjacent caption
      // the same physical identity as its rows; a prose mention is not a title.
      return captionedTableLine
        ? { ...record, role: "formal_table_title", table_id: tableId, table_title: tableTitle,
            table_fragment_id: `reference-table-fragment:${captionedTableLine}` }
        : record;
    }
    const row = /^(line:\d+)\/table-row:(\d+)$/u.exec(record.locator);
    if (!row) return record;
    const cells = [...record.text.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)]
      .map((match) => decodeHtmlCell(match[1] ?? ""));
    const rowIndex = Number(row[2]);
    if (rowIndex === 1) headersByLine.set(row[1]!, cells);
    const columns = headersByLine.get(row[1]!) ?? cells.map((_cell, index) => `列${index + 1}`);
    return {
      ...record,
      kind: "table_row",
      role: rowIndex === 1 ? "formal_table_header" : "formal_table_row",
      table_row_kind: rowIndex === 1 ? "header" : "data",
      row_index: rowIndex,
      columns,
      cells,
      ...(tableId ? { table_id: tableId } : {}),
      ...(tableTitle ? { table_title: tableTitle } : {}),
      ...(captionedTableLine === row[1]
        ? { table_fragment_id: `reference-table-fragment:${captionedTableLine}` } : {}),
    };
  });
}

/** Physical metadata for the unchanged granular source records used by prose references. */
export function buildReferenceScopeEvidence(
  markdown: string,
  sourceId: string,
  windows: EvidenceLineWindow[],
): { evidence: EvidenceRecord[]; table_fragments: TableFragmentEvidence[] } {
  const evidence = structuredReferenceRows(buildGranularProseCoverageEvidence(
    markdown, sourceId, windows, { includeHtmlTables: true },
  ));
  const fragments = new Map<string, TableFragmentEvidence>();
  for (const record of evidence) {
    if (record.kind !== "table_row" || !record.table_fragment_id) continue;
    let fragment = fragments.get(record.table_fragment_id);
    if (!fragment) {
      fragment = {
        fragment_id: record.table_fragment_id, source_order: fragments.size + 1,
        locator: record.locator.replace(/\/table-row:\d+$/u, ""),
        provisional_table_id: record.table_id ?? "", provisional_title: record.table_title ?? "",
        title_candidate_evidence_ids: evidence.filter((candidate) =>
          candidate.table_fragment_id === record.table_fragment_id && candidate.role === "formal_table_title"
        ).map((candidate) => candidate.evidence_id),
        header_evidence_ids: [], row_evidence_ids: [], formal_row_evidence_ids: [], columns: record.columns ?? [],
      };
      fragments.set(record.table_fragment_id, fragment);
    }
    fragment.row_evidence_ids.push(record.evidence_id);
    if (record.table_row_kind === "header") fragment.header_evidence_ids.push(record.evidence_id);
    if (record.table_row_kind === "data") fragment.formal_row_evidence_ids.push(record.evidence_id);
  }
  return { evidence, table_fragments: [...fragments.values()] };
}

export function resolveDocumentReferenceTarget(
  markdown: string,
  currentSourceId: string,
  target: DocumentReferenceTarget,
): DocumentReferenceTargetResolution {
  const requestedSourceId = target.source_id?.trim() || currentSourceId;
  const number = normalizedNumber(target.number);
  const locator = `${target.kind}:${number}${target.paragraph ? `/paragraph:${target.paragraph}` : ""}`;
  if (requestedSourceId !== currentSourceId || target.kind === "standard") {
    return { ok: false, error: "source_not_available", locator, candidates: [] };
  }
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const normativeLines = referenceNormativeLines(lines);
  const normativeEndLine = normativeLines.length + 1;

  if (target.kind === "table") {
    // 按表号取行与这本书用不用「主控/一般」分栏无关，不能被那道分流闸门挡掉。
    const structured = buildStructuredTargetEvidence(
      normativeLines.join("\n"),
      currentSourceId,
      [{ start_line: 1, end_exclusive_line: normativeEndLine }],
      false,
    );
    const matching = structured.evidence.filter((record) =>
      record.table_id === number || record.table_alias_ids?.includes(number)
    );
    const targetRows = matching.filter((record) => record.table_row_kind === "data");
    if (targetRows.length === 0) {
      return { ok: false, error: "not_found", locator, candidates: [] };
    }
    return {
      ok: true,
      locator,
      evidence: matching.map(dependencyRecord),
      target_evidence_ids: targetRows.map((record) => record.evidence_id),
    };
  }

  let windows: EvidenceLineWindow[] = [];
  if (target.kind === "appendix") {
    windows = appendixWindows(normativeLines, number);
  } else {
    const units = numberedUnitLines(normativeLines);
    const heading = target.kind === "section";
    const matches = units.filter((unit) => unit.unit_id === number
      && (unit.heading === heading || (!heading && unit.component_count >= 3)));
    windows = matches.flatMap((unit) => {
      const window = unitWindow(
        normativeLines,
        units,
        unit,
        target.kind as "clause" | "section",
        target.paragraph?.trim() ?? "",
      );
      return window ? [window] : [];
    });
  }
  windows.sort((left, right) => left.start_line - right.start_line);
  const multiple = windows.length > 1;
  const candidates = windows.map((window) => lineCandidate(
    lines,
    multiple ? `${locator}/candidate-line:${window.start_line}` : locator,
    window,
  ));
  if (windows.length === 0) {
    return { ok: false, error: "not_found", locator, candidates: [] };
  }
  const selectedIndex = target.candidate_start_line === undefined
    ? 0
    : windows.findIndex((window) => window.start_line === target.candidate_start_line);
  if (selectedIndex < 0) {
    return { ok: false, error: "candidate_not_found", locator, candidates };
  }
  const selectedWindow = windows[selectedIndex]!;
  const selectedCandidate = candidates[selectedIndex]!;
  const otherCandidates = candidates.filter((_candidate, index) => index !== selectedIndex);
  const evidence = buildReferenceScopeEvidence(normalized, currentSourceId, [selectedWindow])
    .evidence.map(dependencyRecord);
  if (evidence.length === 0) {
    return { ok: false, error: "not_found", locator, candidates };
  }
  return {
    ok: true,
    locator: selectedCandidate.locator,
    evidence,
    target_evidence_ids: evidence.map((record) => record.evidence_id),
    selected_candidate: selectedCandidate,
    ...(multiple
      ? { other_candidates: otherCandidates }
      : {}),
  };
}

interface ReferenceLiteralMatch {
  start: number;
  end: number;
}

function referenceLiteralMatches(text: string, literal: string): ReferenceLiteralMatch[] {
  if (!literal) return [];
  const matches: ReferenceLiteralMatch[] = [];
  let offset = text.indexOf(literal);
  while (offset >= 0) {
    matches.push({ start: offset, end: offset + literal.length });
    offset = text.indexOf(literal, offset + literal.length);
  }
  return matches;
}

function resolvedReferenceLiteral(
  text: string,
  requested: string,
): { literal: string; matches: ReferenceLiteralMatch[]; prefix_fallback: boolean } {
  const exact = referenceLiteralMatches(text, requested);
  if (exact.length > 0) return { literal: requested, matches: exact, prefix_fallback: false };
  const withoutSharedPrefix = requested.replace(/^本\s*(?:规范|标准)\s*/u, "");
  if (!withoutSharedPrefix || withoutSharedPrefix === requested) {
    return { literal: requested, matches: [], prefix_fallback: false };
  }
  return {
    literal: withoutSharedPrefix,
    matches: referenceLiteralMatches(text, withoutSharedPrefix),
    prefix_fallback: true,
  };
}

function flexibleReferenceNumberPattern(value: string): string {
  return [...normalizedNumber(value)].map((character) => {
    if (character === ".") return "\\s*[.．]\\s*";
    if (character === "-") return "\\s*-\\s*";
    return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
}

function targetLiteralCandidates(
  text: string,
  target: DocumentReferenceTarget,
): ReferenceLiteralMatch[] {
  const number = flexibleReferenceNumberPattern(target.number);
  const sharedPrefix = "(?:本\\s*(?:规范|标准)\\s*)?";
  let body: string;
  if (target.kind === "appendix") {
    body = `${sharedPrefix}附录\\s*${number}`;
  } else if (target.kind === "table") {
    body = `表\\s*${number}`;
  } else {
    const unit = target.kind === "clause" ? "条" : "[章节]";
    body = `${sharedPrefix}(?:第\\s*)?${number}\\s*${unit}`;
    if (target.kind === "clause" && target.paragraph) {
      body += `(?:\\s*第?\\s*${flexibleReferenceNumberPattern(target.paragraph)}\\s*款)?`;
    }
  }
  return [...text.matchAll(new RegExp(body, "gu"))].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length }]
  );
}

function unambiguousLiteralTargetKind(
  literal: string,
  requested: DocumentReferenceTarget,
): DocumentReferenceKind | undefined {
  const trimmed = literal.trim();
  const exactlyMatches = (kind: DocumentReferenceKind): boolean =>
    targetLiteralCandidates(trimmed, { ...requested, kind }).some((match) =>
      match.start === 0 && match.end === trimmed.length
    );
  if (exactlyMatches(requested.kind)) return undefined;
  const alternatives = (["clause", "section", "table", "appendix"] as const)
    .filter((kind) => kind !== requested.kind && exactlyMatches(kind));
  return alternatives.length === 1 ? alternatives[0] : undefined;
}

export function documentReferenceOccurrence(
  sourceId: string,
  request: DocumentReferenceRequest,
  resolution: Extract<DocumentReferenceTargetResolution, { ok: true }>,
  originSpanIds: readonly string[],
  literals: readonly ResolvedSourceSpan[],
): ReferenceOccurrence {
  const originEvidenceId = literals[0]!.evidence_id;
  const occurrenceId = `reference:${sha256Text([
    ...occurrenceLiteralIdentityParts(originEvidenceId, literals),
    sourceId,
    resolution.locator,
  ].join("\0"))}`;
  const common = {
    occurrence_id: occurrenceId,
    ...occurrenceProvenance(originSpanIds, literals),
    origin_fields: [request.origin_field],
    raw_reference: request.raw_reference,
    ...(request.normalized_reference ? { normalized_reference: request.normalized_reference } : {}),
    relation: request.relation,
    ...(request.external_standard ? { external_standard: request.external_standard } : {}),
    target_evidence_ids: resolution.target_evidence_ids,
    required: true,
    status: "resolved" as const,
    depth: 1,
    path: [`${sourceId}:${resolution.locator}`],
    ...(request.content_scope ? { content_scope: request.content_scope } : {}),
  };
  return request.target.kind === "table"
    ? {
        ...common,
        reference_kind: "table",
        target_table_id: normalizedNumber(request.target.number),
        target_address: {
          source_id: sourceId,
          locator_kind: "table",
          locator: resolution.locator,
        },
      }
    : {
        ...common,
        reference_kind: "clause",
        target_address: {
          source_id: sourceId,
          locator_kind: request.target.kind,
          locator: resolution.locator,
        },
      };
}

function unresolvedDocumentReferenceOccurrence(
  sourceId: string,
  request: DocumentReferenceRequest,
  originSpanIds: readonly string[],
  literals: readonly ResolvedSourceSpan[],
  locator: string,
): ReferenceOccurrence {
  const originEvidenceId = literals[0]!.evidence_id;
  const occurrenceId = `reference:${sha256Text([
    ...occurrenceLiteralIdentityParts(originEvidenceId, literals),
    request.target.source_id ?? sourceId,
    locator,
  ].join("\0"))}`;
  const common = {
    occurrence_id: occurrenceId,
    ...occurrenceProvenance(originSpanIds, literals),
    origin_fields: [request.origin_field],
    raw_reference: request.raw_reference,
    ...(request.normalized_reference ? { normalized_reference: request.normalized_reference } : {}),
    relation: request.relation,
    ...(request.external_standard ? { external_standard: request.external_standard } : {}),
    target_evidence_ids: [],
    required: false,
    status: "target_not_found" as const,
    depth: 1,
    path: [`${request.target.source_id ?? sourceId}:${locator}`],
  };
  return request.target.kind === "table"
    ? {
        ...common,
        reference_kind: "table",
        target_table_id: normalizedNumber(request.target.number),
        target_address: {
          source_id: request.target.source_id ?? sourceId,
          locator_kind: "table",
          locator,
        },
      }
    : {
        ...common,
        reference_kind: "clause",
        target_address: {
          source_id: request.target.source_id ?? sourceId,
          locator_kind: request.target.kind,
          locator,
        },
      };
}

function existingDocumentReferenceOccurrence(
  occurrences: readonly ReferenceOccurrence[],
  proposed: ReferenceOccurrence,
  unvalidatedManifest?: EvidenceManifest,
): ReferenceOccurrence | undefined {
  const existing = occurrences.find((entry) =>
    (entry.occurrence_id === proposed.occurrence_id && entry.status === proposed.status)
    || sameLogicalReferenceOccurrence(entry, proposed)
  );
  if (existing || !unvalidatedManifest) return existing;
  const matches = occurrences.filter(entry => canAnchorStaticTableReference(entry, proposed, unvalidatedManifest));
  return matches.length === 1 ? matches[0] : undefined;
}

function supersededCompositeOccurrenceIds(
  occurrences: readonly ReferenceOccurrence[],
  proposed: ReferenceOccurrence,
): string[] {
  const proposedLiteralIds = new Set(referenceOccurrenceLiteralSpanIds(proposed));
  const proposedOrigins = new Set(referenceOccurrenceOriginEvidenceIds(proposed));
  if (proposedLiteralIds.size < 2) return [];
  return occurrences.filter(existing => {
    const existingLiteralIds = referenceOccurrenceLiteralSpanIds(existing);
    return existingLiteralIds.length === 1
      && shortReferenceNeedsCompositeReview(existing.raw_reference)
      && referenceOccurrenceTargetLocator(existing) === referenceOccurrenceTargetLocator(proposed)
      && existingLiteralIds.every(id => proposedLiteralIds.has(id))
      && referenceOccurrenceOriginEvidenceIds(existing).every(id => proposedOrigins.has(id));
  }).map(existing => existing.occurrence_id);
}

function occurrenceRouteUpdateMetadata(
  existing: ReferenceOccurrence | undefined,
  persisted: ReferenceOccurrence,
  requestedField: DocumentReferenceRequest["origin_field"],
): Record<string, unknown> {
  if (!existing || existing.origin_fields.includes(requestedField)) return {};
  if (persisted.origin_fields.length === 1 && persisted.origin_fields[0] === requestedField) {
    return {
      origin_field_corrected: true,
      previous_origin_fields: [...existing.origin_fields],
      route_frozen: false,
    };
  }
  return {
    origin_field_correction_rejected: true,
    requested_origin_field: requestedField,
    route_frozen: true,
  };
}

export function documentReferenceDecompositionInventory(
  manifest: EvidenceManifest,
  occurrence: ReferenceOccurrence,
  evidenceIds: readonly string[] = occurrence.target_evidence_ids,
): Array<{
  component_id: string;
  evidence_id: string;
  kind: EvidenceRecord["kind"];
  locator: string;
  text_sha256: string;
}> {
  const identity = documentReferenceTargetReadIdentity(occurrence);
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  return evidenceIds.flatMap((evidenceId) => {
    const record = evidenceById.get(evidenceId);
    return record ? [{
      component_id: `reference-component:${sha256Text(`${identity.target_key}\0${evidenceId}`)}`,
      evidence_id: evidenceId,
      kind: record.kind,
      locator: record.locator,
      text_sha256: record.text_sha256,
    }] : [];
  });
}

export function documentReferenceWouldCycle(
  occurrences: readonly ReferenceOccurrence[],
  originEvidenceId: string | readonly string[],
  targetEvidenceIds: readonly string[],
): { cycle: boolean; path: string[] } {
  const originEvidenceIds = new Set(Array.isArray(originEvidenceId) ? originEvidenceId : [originEvidenceId]);
  const outgoing = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    for (const originId of referenceOccurrenceOriginEvidenceIds(occurrence)) {
      outgoing.set(originId, [
        ...(outgoing.get(originId) ?? []),
        ...occurrence.target_evidence_ids,
      ]);
    }
  }
  const pending = targetEvidenceIds.map((evidenceId) => ({ evidenceId, path: [evidenceId] }));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (originEvidenceIds.has(current.evidenceId)) return { cycle: true, path: current.path };
    if (seen.has(current.evidenceId)) continue;
    seen.add(current.evidenceId);
    for (const next of outgoing.get(current.evidenceId) ?? []) {
      pending.push({ evidenceId: next, path: [...current.path, next] });
    }
  }
  return { cycle: false, path: [] };
}

export async function resolveAndRegisterDocumentReference(
  workspace: RevisionWorkspace,
  evidence: EvidenceManifest,
  request: DocumentReferenceRequest,
  allowAfterValidation = false,
  externalDocument?: ExternalStandardDocument,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const currentSourceId = externalDocument?.markdown_sha256 ?? evidence.source.sha256;
  if (request.replaces_occurrence_id) {
    const state = await workspace.readState();
    if (allowAfterValidation || state.status !== "working" || state.last_valid_fingerprint || state.last_valid_plan_sha256 || state.repair?.coverage_review_fingerprint) {
      return { ok: false, error: "reference_correction_checkpoint_frozen", actual: { status: state.status,
        validated_fingerprint: state.last_valid_fingerprint }, writable_paths: [], required_action: "create_new_writable_revision",
        instruction: "已验证或封存的引用决定不可原地更正。保留原检查点、历史计数和预算，在新的可写修订版处理；不能删除旧回执或强行封存。" };
    }
  }
  if (!request.raw_reference || !request.relation || !request.target.number) {
    return { ok: false, error: "invalid_document_reference_request" };
  }
  if (!["name", "requirement", "method", "quantity", "note", "sampling"].includes(request.origin_field)) {
    return {
      ok: false,
      error: "invalid_document_reference_origin_field",
      instruction: "origin_field 必须是引用字面量实际所在的 name/requirement/method/quantity/note/sampling 字段；完整读取被引条款不允许扩大这条字段路由。",
    };
  }
  if (request.target.paragraph && request.target.kind !== "clause") {
    return { ok: false, error: "paragraph_is_valid_only_for_clause_targets" };
  }
  if (!request.external_standard && /本\s*(?:标准|规范)/u.test(request.raw_reference)
    && request.target.source_id?.trim() && request.target.source_id.trim() !== currentSourceId) {
    return { ok: false, error: "internal_reference_source_mismatch",
      instruction: "原文明确引用本标准，不是外部资料缺失。省略 target.source_id 后在当前文档中查询。" };
  }
  const registry = await workspace.readSourceSpanRegistry();
  const markdown = await readFile(workspace.sourceMarkdownPath, "utf8");
  const markdownLines = markdown.split("\n");
  const originSpanIds = referenceSpanIds(request.origin_span_id, request.origin_span_ids);
  const requestedLiteralSpanIds = referenceSpanIds(
    request.reference_literal_span_id,
    request.reference_literal_span_ids,
  );
  if (
    (request.origin_span_id && request.origin_span_ids?.length)
    || (request.reference_literal_span_id && request.reference_literal_span_ids?.length)
    || (request.origin_span_ids !== undefined && request.origin_span_ids.length < 2)
    || (request.reference_literal_span_ids !== undefined && request.reference_literal_span_ids.length < 2)
    || originSpanIds.length > MAX_COMPOSITE_REFERENCE_SPANS
    || requestedLiteralSpanIds.length > MAX_COMPOSITE_REFERENCE_SPANS
    || new Set(originSpanIds).size !== originSpanIds.length
    || new Set(requestedLiteralSpanIds).size !== requestedLiteralSpanIds.length
  ) {
    return { ok: false, error: "invalid_reference_span_set", budget_consumed: false };
  }
  const composite = originSpanIds.length > 1 || requestedLiteralSpanIds.length > 1;
  if (
    composite
    && (
      requestedLiteralSpanIds.length < 2
      || requestedLiteralSpanIds.length > MAX_COMPOSITE_REFERENCE_SPANS
      || (originSpanIds.length > 0 && originSpanIds.length !== requestedLiteralSpanIds.length)
    )
  ) {
    return {
      ok: false,
      error: "invalid_composite_reference_span_count",
      budget_consumed: false,
      details: {
        path: "/origin_span_ids", writable_collection: "resolve_document_reference arguments",
        origin_span_ids: originSpanIds, reference_literal_span_ids: requestedLiteralSpanIds,
        allowed_span_count: [2, 3], required_action: "use_single_span_or_ordered_composite_literals",
        next_tool: "resolve_document_reference",
      },
      instruction: "普通单段引用用 origin_span_id（单数）和 raw_reference 重试 resolve_document_reference，原文唯一匹配时省略 reference_literal_span_id。只有跨行断裂引用才按来源顺序提供 2～3 个 reference_literal_span_ids；若同时提供 origin_span_ids，数量必须逐段一致。不要修改来源或编译产物。",
    };
  }
  const effectiveOriginSpanIds = originSpanIds.length > 0 ? originSpanIds : requestedLiteralSpanIds;
  if (effectiveOriginSpanIds.length === 0) {
    return { ok: false, error: "invalid_origin_span", issues: [] };
  }
  const sources = new Map(evidence.evidence.map((record) => [record.evidence_id, {
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }]));
  const issues: Array<{ code: string; path: string; message: string; details?: unknown }> = [];
  const origins = effectiveOriginSpanIds.flatMap((spanId, index) => {
    const origin = resolveSourceSpan(
      registry,
      spanId,
      sources,
      effectiveOriginSpanIds.length === 1 ? "/origin_span_id" : `/origin_span_ids/${index}`,
      issues,
    );
    return origin ? [origin] : [];
  });
  if (origins.length !== effectiveOriginSpanIds.length) {
    return { ok: false, error: "invalid_origin_span", issues };
  }
  const initialAdjacentWindow = compositeReferenceReviewWindow(
    evidence,
    registry,
    origins.map(entry => entry.evidence_id),
  );
  if (!composite && shortReferenceNeedsCompositeReview(request.raw_reference)
    && hasCompositeReferenceLead(origins, initialAdjacentWindow, request.raw_reference)) {
    return {
      ok: false,
      error: "composite_reference_review_required",
      status: "review",
      budget_consumed: false,
      raw_reference: request.raw_reference,
      target: request.target,
      adjacent_source_window: initialAdjacentWindow,
      required_action: "review_adjacent_exact_fragments_then_submit_ordered_composite_spans_or_keep_unresolved",
      writable_paths: [
        "/origin_span_ids",
        "/reference_literal_span_ids",
        "/normalized_reference",
        "/origin_field",
        "/target",
        "/relation",
      ],
      next_tools: ["open_evidence", "locate_evidence_span", "resolve_document_reference"],
      instruction: "该引用过短，程序不会自动与前后文字拼接。请阅读 adjacent_source_window：若多个相邻精确片段共同构成唯一引用，分别定位 literal span，按原文顺序提交 2～3 个 origin_span_ids/reference_literal_span_ids，并单独填写 normalized_reference；若像“B级”一样不能唯一构成引用，保持 review/unresolved，不要猜。标题、列表、表格或公式没有结束标点本身不构成拼接依据。",
    };
  }
  const origin = origins[0]!;
  const originRecord = evidence.evidence.find((record) => record.evidence_id === origin.evidence_id)!;
  const adjacentSourceWindow = compositeReferenceReviewWindow(
    evidence,
    registry,
    origins.map(entry => entry.evidence_id),
  );
  let literalSpans: ResolvedSourceSpan[] = [];
  let literalText = request.raw_reference;
  let literalPrefixFallback = false;
  if (composite) {
    const literalIssues: Array<{ code: string; path: string; message: string; details?: unknown }> = [];
    literalSpans = requestedLiteralSpanIds.flatMap((spanId, index) => {
      const literal = resolveSourceSpan(
        registry,
        spanId,
        sources,
        `/reference_literal_span_ids/${index}`,
        literalIssues,
      );
      return literal ? [literal] : [];
    });
    if (literalSpans.length !== requestedLiteralSpanIds.length) {
      return { ok: false, error: "invalid_reference_literal_span", issues: literalIssues };
    }
    const records = literalSpans.map((literal) => evidence.evidence.find((record) => record.evidence_id === literal.evidence_id));
    const clauseIds = records.map((record) => record?.clause_id ?? "");
    const atomIds = records.map((record) => record?.atom_id ?? "");
    const lines = records.map((record) => record ? evidenceLine(record) : undefined);
    const invalidContainment = literalSpans.some((literal, index) => {
      const containingOrigin = origins[index]!;
      return literal.evidence_id !== containingOrigin.evidence_id
        || literal.start < containingOrigin.start
        || literal.end > containingOrigin.end;
    });
    const strictlyOrdered = lines.every((line, index) => {
      if (line === undefined) return false;
      if (index === 0) return true;
      const previous = lines[index - 1]!;
      if (line <= previous) return false;
      return markdownLines.slice(previous, line - 1).every((between) => between.trim().length === 0);
    });
    if (
      invalidContainment
      || records.some((record) => !record)
      || !(
        clauseIds.every((clauseId) => Boolean(clauseId) && clauseId === clauseIds[0])
        || atomIds.every((atomId) => Boolean(atomId) && atomId === atomIds[0])
      )
      || new Set(literalSpans.map((literal) => literal.evidence_id)).size !== literalSpans.length
      || !strictlyOrdered
    ) {
      return {
        ok: false,
        error: "unsafe_composite_reference_span_set",
        budget_consumed: false,
        details: {
          origin_evidence_ids: literalSpans.map((literal) => literal.evidence_id),
          clause_ids: clauseIds,
          atom_ids: atomIds,
          source_lines: lines,
          invalid_containment: invalidContainment,
        },
        instruction: "组合引用只允许同一 clause_id 或同一来源 atom 内按唯一来源顺序排列的 2～3 个精确 span；行必须相邻或中间仅有空行。",
      };
    }
    if (!request.normalized_reference?.trim()) {
      return {
        ok: false,
        error: "composite_reference_normalized_reference_required",
        budget_consumed: false,
        instruction: "组合引用必须单独提交 normalized_reference；literal spans 保留逐字原文，normalized_reference 只规范空白和排版。",
      };
    }
    literalText = literalSpans.map((literal) => literal.text).join("");
    if (safeReferenceComparable(literalText) !== safeReferenceComparable(request.raw_reference)) {
      const reviewCandidates = compositeReferenceReviewCandidates(evidence, registry).filter(candidate => {
        const window = Array.isArray(candidate.adjacent_source_window)
          ? candidate.adjacent_source_window as Array<{ evidence_id?: unknown }>
          : [];
        return window.some(entry => literalSpans.some(span => entry.evidence_id === span.evidence_id));
      });
      return {
        ok: false,
        error: "composite_reference_literal_mismatch",
        budget_consumed: false,
        selected_literal: literalText,
        raw_reference: request.raw_reference,
        selected_spans: literalSpans.map(span => ({ span_id: span.span_id, evidence_id: span.evidence_id, text: span.text })),
        composite_review_candidates: reviewCandidates,
        candidate_literal_fragments: reviewCandidates.flatMap(candidate => [candidate.lead_fragment, candidate.trailing_fragment]),
        required_action: "locate_each_candidate_literal_fragment_then_resubmit_only_the_ordered_literal_spans",
        next_tool: "locate_evidence_span",
        instruction: "当前 reference_literal_span_ids 覆盖了整句或其他多余文字，不等于引用 literal。请对 candidate_literal_fragments 中每段 text 分别调用 locate_evidence_span，再按顺序提交返回的精确 span；origin_span_ids 可继续使用包含它们的完整字段来源 span。",
      };
    }
    if (request.target.kind !== "standard" && targetLiteralCandidates(literalText, request.target).length !== 1) {
      return {
        ok: false,
        error: "composite_reference_target_ambiguous",
        budget_consumed: false,
        target_candidate_count: targetLiteralCandidates(literalText, request.target).length,
      };
    }
    if (request.normalized_reference
      && safeReferenceComparable(request.normalized_reference) !== safeReferenceComparable(literalText)) {
      return {
        ok: false,
        error: "normalized_reference_literal_mismatch",
        budget_consumed: false,
        literal_fragments: literalSpans.map(span => span.text),
        normalized_reference: request.normalized_reference,
        instruction: "normalized_reference 只能规范空白和排版，不能改写精确 literal fragments 的字符或目标。",
      };
    }
  } else {
    const literalResolution = resolvedReferenceLiteral(origin.text, request.raw_reference);
    literalText = literalResolution.literal;
    literalPrefixFallback = literalResolution.prefix_fallback;
    if (literalResolution.matches.length === 0) {
      const rawReferenceCandidates = targetLiteralCandidates(origin.text, request.target).map((match) => ({
        evidence_id: origin.evidence_id,
        start: origin.start + match.start,
        end: origin.start + match.end,
        prefix: origin.text.slice(Math.max(0, match.start - 48), match.start),
        text: origin.text.slice(match.start, match.end),
        suffix: origin.text.slice(match.end, Math.min(origin.text.length, match.end + 48)),
      }));
      return {
        ok: false,
        error: "origin_span_does_not_contain_raw_reference",
        budget_consumed: false,
        dependency_registered: false,
        origin_span_id: effectiveOriginSpanIds[0],
        raw_reference: request.raw_reference,
        origin_text: origin.text,
        raw_reference_candidates: rawReferenceCandidates,
        adjacent_source_window: adjacentSourceWindow,
        review_state: rawReferenceCandidates.length ? "ambiguous" : "unresolved",
        actual: {
          raw_reference: request.raw_reference,
          origin_field: request.origin_field,
          target: request.target,
          origin_span: {
            span_id: origin.span_id, evidence_id: origin.evidence_id,
            start: origin.start, end: origin.end,
          },
          raw_reference_match_count: 0,
          raw_reference_candidate_count: rawReferenceCandidates.length,
        },
        expected: {
          raw_reference: "使用来源中当前目标实际存在的引用片段；共用前缀沿用既有匹配规则，不捏造文字或编号。",
          target: "kind、number 和可选 paragraph 必须与来源明确引用的目标一致；本条自身编号和章节归属不能代替转指文字。",
          origin_field: "引用字面量实际所在的唯一业务字段。",
        },
        writable_collection: "resolve_document_reference arguments",
        writable_paths: ["/origin_span_id", "/raw_reference", "/target", "/origin_field", "/reference_literal_span_id"],
        retry_tool: "resolve_document_reference",
        required_action: rawReferenceCandidates.length
          ? "review_actual_literal_candidates_then_correct_reference_arguments"
          : "read_source_then_confirm_explicit_reference_or_investigate_shared_context",
        instruction: rawReferenceCandidates.length > 0
          ? "本次未登记依赖。raw_reference 未匹配 origin span。阅读原文后，从 raw_reference_candidates 核对实际引用片段及目标；只修改本工具的 writable_paths 后重试，不改来源或编译产物，不捏造引用文字。候选只供定位，不证明业务适用。"
          : "本次未登记依赖。当前 origin span 没有匹配所提交的 raw_reference，也没有与 target 匹配的引用候选。先读原文；确有明确编号引用时才修正本工具的 writable_paths 后重试。没有明确引用编号时，不能靠换锚点、自身条号、章节归属或关系说明制造引用；共同规则须经现有文档调查入口核对原文和适用性。此回条不判定规则不存在，也不指定抽样值、业务字段内容或处置结果。来源和编译产物不可写。",
      };
    }
    const literalMatches = literalResolution.matches.map((match) => ({
      start: origin.start + match.start,
      end: origin.start + match.end,
    }));
    let literalSpan: ResolvedSourceSpan;
    if (request.reference_literal_span_id) {
      const literalIssues: Array<{ code: string; path: string; message: string; details?: unknown }> = [];
      const resolvedLiteral = resolveSourceSpan(
        registry,
        request.reference_literal_span_id,
        sources,
        "/reference_literal_span_id",
        literalIssues,
      );
      if (
        !resolvedLiteral
        || resolvedLiteral.evidence_id !== origin.evidence_id
        || resolvedLiteral.start < origin.start
        || resolvedLiteral.end > origin.end
        || resolvedLiteral.text !== literalText
      ) {
        return {
          ok: false, error: "invalid_reference_literal_span", issues: literalIssues,
          budget_consumed: false,
          details: {
            path: "/reference_literal_span_id",
            writable_collection: "resolve_document_reference arguments",
            received_span_id: request.reference_literal_span_id,
            received_text: resolvedLiteral?.text ?? null,
            expected_text: literalText,
            origin_span_id: effectiveOriginSpanIds[0],
            origin_evidence_id: origin.evidence_id,
            unique_literal_match: literalMatches.length === 1,
            required_action: literalMatches.length === 1 ? "omit_reference_literal_span_id_and_retry" : "locate_exact_literal_and_retry",
            next_tool: literalMatches.length === 1 ? "resolve_document_reference" : "locate_evidence_span",
          },
          instruction: literalMatches.length === 1
            ? "引用片段必须位于 origin_span_id 内，且全文等于 expected_text。当前原文唯一匹配：删除 reference_literal_span_id，保留 origin_span_id、raw_reference 和 target 后重试 resolve_document_reference，程序会自动登记精确片段。不要修改来源或编译产物。"
            : "引用片段必须位于 origin_span_id 内，且全文等于 expected_text。用 locate_evidence_span（Coverage 用 locate_review_span）对原证据定位 expected_text，以 prefix/suffix 区分重复项，再将返回的 span_id 填入 reference_literal_span_id 重试 resolve_document_reference。不要修改来源或编译产物。",
        };
      }
      literalSpan = resolvedLiteral;
    } else if (literalMatches.length !== 1) {
      return {
        ok: false,
        error: literalMatches.length === 0
          ? "reference_literal_not_found"
          : "reference_literal_ambiguous",
        candidates: literalMatches.map((match) => {
          const localStart = match.start - origin.start;
          const localEnd = match.end - origin.start;
          return {
            evidence_id: origin.evidence_id,
            start: match.start,
            end: match.end,
            prefix: origin.text.slice(Math.max(0, localStart - 48), localStart),
            text: origin.text.slice(localStart, localEnd),
            suffix: origin.text.slice(localEnd, Math.min(origin.text.length, localEnd + 48)),
          };
        }),
        adjacent_source_window: adjacentSourceWindow,
        review_state: literalMatches.length > 1 ? "ambiguous" : "unresolved",
        instruction: literalMatches.length > 1
          ? "同一 origin span 内引用文字出现多次。用 locate_evidence_span 加 prefix/suffix 精确定位其中一处，再携带 reference_literal_span_id 重试；不得猜位置。"
          : "已验证的 origin span 中没有逐字匹配的 raw_reference，请保留原文并检查引用文字。",
      };
    } else {
      const match = literalMatches[0]!;
      const registeredLiteral = registerSourceSpan(
        registry,
        {
          source_id: origin.evidence_id,
          evidence_id: origin.evidence_id,
          atom_id: origin.evidence_id,
          text: originRecord.text,
        },
        match.start,
        match.end,
      );
      literalSpan = { ...registeredLiteral.span, text: literalText };
      await atomicWriteJson(workspace.sourceSpanRegistryPath, registeredLiteral.registry);
    }
    literalSpans = [literalSpan];
  }
  const literalIsBareReferenceLead = /^(?:(?:本\s*(?:规范|标准)?\s*)?(?:附录|表|第)|GB\s*\/?\s*T|Appendix)\s*$/iu.test(literalText);
  if (!composite && !request.external_standard && request.target.kind !== "standard" && literalIsBareReferenceLead) {
    const targetMatches = targetLiteralCandidates(literalText, request.target);
    if (targetMatches.length !== 1) {
      const reviewCandidates = compositeReferenceReviewCandidates(evidence, registry).filter(candidate => {
        const window = Array.isArray(candidate.adjacent_source_window)
          ? candidate.adjacent_source_window as Array<{ evidence_id?: unknown }>
          : [];
        return window.some(entry => origins.some(originEntry => entry.evidence_id === originEntry.evidence_id));
      });
      return {
        ok: false,
        error: reviewCandidates.length ? "composite_reference_review_required" : "reference_literal_target_mismatch",
        status: "review",
        budget_consumed: false,
        raw_reference: literalText,
        target: request.target,
        adjacent_source_window: adjacentSourceWindow,
        composite_review_candidates: reviewCandidates,
        target_candidate_count: targetMatches.length,
        required_action: reviewCandidates.length
          ? "select_ordered_literal_spans_that_include_the_declared_target"
          : "correct_the_literal_or_target_without_guessing",
        writable_paths: ["/origin_span_ids", "/reference_literal_span_ids", "/normalized_reference", "/origin_field", "/target"],
        next_tools: ["open_evidence", "locate_evidence_span", "resolve_document_reference"],
        instruction: "单段引用 literal 没有唯一包含声明的目标编号，不能登记 occurrence。若 composite_review_candidates 非空，请按相邻原文顺序提交完整 literal fragments 和 normalized_reference；不得只提交“本规范附录/表/第”等前缀。",
      };
    }
  }
  const literalTargetKind = !request.external_standard && request.target.kind !== "standard"
    ? unambiguousLiteralTargetKind(literalText, request.target)
    : undefined;
  if (literalTargetKind) {
    const suggestedTarget = { ...request.target, kind: literalTargetKind };
    if (literalTargetKind !== "clause") delete suggestedTarget.paragraph;
    return {
      ok: false,
      error: "reference_target_kind_mismatch",
      budget_consumed: false,
      raw_reference: literalText,
      requested_target: request.target,
      suggested_target: suggestedTarget,
      required_action: "retry_with_literal_target_kind",
      next_tool: "resolve_document_reference",
      next_tool_arguments: {
        ...(effectiveOriginSpanIds.length > 1
          ? { origin_span_ids: effectiveOriginSpanIds }
          : { origin_span_id: effectiveOriginSpanIds[0] }),
        origin_field: request.origin_field,
        ...(request.reference_literal_span_id ? { reference_literal_span_id: request.reference_literal_span_id } : {}),
        ...(request.reference_literal_span_ids ? { reference_literal_span_ids: request.reference_literal_span_ids } : {}),
        raw_reference: literalText,
        ...(request.normalized_reference ? { normalized_reference: request.normalized_reference } : {}),
        target: suggestedTarget,
        relation: request.relation,
      },
      instruction: "当前 raw_reference 的逐字单位与 target.kind 不一致，尚未登记 target_not_found。核对原文后保留其他参数，只把 target 改为 suggested_target 重试；不得据此推定目标正文或编造来源。",
    };
  }
  // Clause/section lookup uses numbered units. Reject an author's placeholder
  // before it can become an immutable missing dependency on later validation.
  if (!request.external_standard
    && (!request.target.source_id?.trim() || request.target.source_id.trim() === evidence.source.sha256)
    && (request.target.kind === "clause" || request.target.kind === "section")
    && !/^(?:[A-Z]\.)?\d+(?:\.\d+)*$/iu.test(normalizedNumber(request.target.number))) {
    return {
      ok: false,
      error: "invalid_internal_reference_locator",
      budget_consumed: false,
      requested_target: request.target,
      raw_reference: literalText,
      expected: { number: "原文明示的条/章节编号，例如 2.1.1 或 A.0.1", occurrence_registered: false },
      writable_paths: ["/target", "/raw_reference", "/origin_span_id", "/reference_literal_span_id"],
      next_tool: "open_evidence",
      next_tool_arguments: { evidence_id: origin.evidence_id, cursor: 0 },
      required_action: "read_source_and_supply_an_actual_internal_number",
      instruction: "尚未登记 occurrence。先按 next_tool_arguments 核对原文；同文档条/章节引用用原文明示的编号修正 target 和对应 literal，再调用 resolve_document_reference。外部标准按任务提供的外部资料入口核对准确标准号和版本，不冒充内部缺失引用；原文没有具体内部编号时也不猜编号。",
    };
  }
  const resolvedRequest = literalText === request.raw_reference
    ? request
    : { ...request, raw_reference: literalText };
  // The external-standard stub never searches the current document or invents
  // external evidence. Reuse only the existing exact-anchor/unresolved ledger.
  const scopedTarget = externalDocument && request.content_scope?.mode === "selected_targets"
    ? resolveExternalReferenceScope(externalDocument, request.content_scope, resolveDocumentReferenceTarget) : undefined;
  if (scopedTarget && !scopedTarget.ok) return scopedTarget;
  const externalTarget = scopedTarget?.ok ? scopedTarget : externalDocument
    ? request.target.kind === "standard"
      ? (() => {
          const rows = buildStructuredTargetEvidence(externalDocument.markdown, externalDocument.markdown_sha256,
            [{ start_line: 1, end_exclusive_line: externalDocument.markdown.split(/\r?\n/u).length + 1 }], false);
          return { ok: true as const, locator: `standard:${request.external_standard!.standard_no}`,
            target_evidence_ids: rows.evidence.map(row => row.evidence_id), ...rows, evidence: rows.evidence.map(dependencyRecord) };
        })()
      : resolveDocumentReferenceTarget(externalDocument.markdown, externalDocument.markdown_sha256,
          { ...request.target, source_id: externalDocument.markdown_sha256 })
    : undefined;
  const target: DocumentReferenceTargetResolution = externalTarget ?? (request.external_standard
    ? {
        ok: false,
        error: "source_not_available",
        locator: `${request.target.kind}:${normalizedNumber(request.target.number)}${request.target.paragraph ? `/paragraph:${request.target.paragraph}` : ""}`,
        candidates: [],
      }
    : resolveDocumentReferenceTarget(
        markdown,
        evidence.source.sha256,
        request.target,
      ));
  if (!target.ok) {
    const proposedUnresolved = unresolvedDocumentReferenceOccurrence(
      evidence.source.sha256,
      resolvedRequest,
      effectiveOriginSpanIds,
      literalSpans,
      target.locator,
    );
    const existingUnresolved = existingDocumentReferenceOccurrence(
      evidence.reference_occurrences,
      proposedUnresolved,
    );
    const registrationCandidate = existingUnresolved
      ? { ...proposedUnresolved, occurrence_id: existingUnresolved.occurrence_id }
      : proposedUnresolved;
    const correction = planReferenceCorrection(evidence, registrationCandidate, request, await workspace.readReferenceCorrections());
    if (!correction.ok) return correction;
    if (request.replaces_occurrence_id && externalDocument) return { ok: false, error: "reference_correction_target_unresolved",
      actual: { target: request.target }, next_tool: request.external_standard ? "resolve_external_standard_reference" : "resolve_document_reference",
      writable_paths: ["/target"], instruction: "新目标尚未定位，原有效引用未被替换。先修正目标定位；不能用失败解析撤掉既有正文义务。" };
    const supersededOccurrenceIds = [...new Set([...supersededCompositeOccurrenceIds(evidence.reference_occurrences, registrationCandidate), ...correction.superseded_ids])];
    let unresolved = registrationCandidate;
    if (target.error === "not_found" || target.error === "source_not_available") {
      const registered = await workspace.registerDocumentReferenceDependency(
        [],
        registrationCandidate,
        allowAfterValidation,
        supersededOccurrenceIds,
        correction.archive,
      );
      evidence.reference_occurrences = registered.manifest.reference_occurrences;
      evidence.evidence_fingerprint = registered.manifest.evidence_fingerprint;
      unresolved = registered.manifest.reference_occurrences.find((entry) =>
        entry.occurrence_id === registrationCandidate.occurrence_id
      ) ?? registrationCandidate;
    }
    const missing = target.error === "not_found" || target.error === "source_not_available";
    return {
      ok: Boolean(request.external_standard && !externalDocument),
      ...(request.external_standard && !externalDocument
        ? {
            receipt: "external_reference_placeholder",
            status: "external_reference_placeholder",
            content_available: false,
            external_standard: unresolved.external_standard,
            target_evidence_ids: [],
            target_span_ids: [],
            required_action: "keep_reference_at_original_field_and_continue",
          }
        : { error: missing ? "target_not_found" : target.error, receipt: missing ? "target_not_found" : target.error }),
      ...(externalDocument ? {
        source_available: true,
        source_status: "ready",
        content_available: false,
        budget_consumed: false,
        actual: { standard_no: externalDocument.standard_no, markdown_sha256: externalDocument.markdown_sha256,
          target: request.target, target_evidence_ids: [] },
        how_to_pass: "资料已接入，但所请求的位置未找到；资料就绪不等于目标正文可用。核对原文指定的 target。原文仅引用整本标准时省略 target 重试；明确给出位置时保留原引用并核查版本或解析完整性，不猜编号、不拿同号其他来源代替。解析成功后完整读取被引正文，再由作者选择实际接收。",
        writable_paths: ["/target"],
        next_tool: request.external_standard ? "resolve_external_standard_reference" : "resolve_document_reference",
        do_not_edit: ["source", "compiler", "sealed_artifacts"],
      } : {}),
      occurrence_id: unresolved.occurrence_id,
      origin_field: unresolved.origin_fields[0],
      reference_literal_span_id: unresolved.reference_literal_span_id ?? literalSpans[0]!.span_id,
      reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(unresolved),
      origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(unresolved),
      origin_span_ids: referenceOccurrenceOriginSpanIds(unresolved),
      raw_reference: unresolved.raw_reference,
      normalized_reference: unresolved.normalized_reference ?? unresolved.raw_reference,
      ...(supersededOccurrenceIds.length ? { superseded_occurrence_ids: supersededOccurrenceIds } : {}),
      ...(correction.receipt ? { correction: correction.receipt, author_action: "read_target_selectors_then_replace_only_the_old_reference_occurrence_id_and_review_its_routes" } : {}),
      adjacent_source_window: adjacentSourceWindow,
      review_state: missing ? "unresolved" : "ambiguous",
      ...(existingUnresolved ? { idempotent: true, logical_occurrence_deduplicated: true } : {}),
      ...occurrenceRouteUpdateMetadata(existingUnresolved, unresolved, request.origin_field),
      ...(literalPrefixFallback
        ? { requested_raw_reference: request.raw_reference, raw_reference_prefix_fallback: true }
        : {}),
      locator: target.locator,
      candidates: target.candidates,
      ...(!request.external_standard && missing ? {
        lookup_scope: { source_id: currentSourceId, target: request.target },
        how_to_pass: "本次结果只说明所选文档中未定位到目标。先读引用原文和上位验收依据，判断引用所属文档；内部引用修正定位后重试，外部引用按任务提供的外部资料工具登记。不能把未定位等同于已证明内部引用或证明外部文件缺失。",
        writable_collection: "resolve_document_reference arguments",
        writable_paths: ["/origin_span_id", "/origin_span_ids", "/reference_literal_span_id", "/reference_literal_span_ids", "/raw_reference", "/target"],
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: origin.evidence_id, cursor: 0 },
        required_tools: ["open_evidence", "read_target_selectors", "resolve_document_reference"],
      } : {}),
      // 「这本书不在手上」必须能追回原文：谁在第几行、哪一条条文、上下文原句是什么。
      // 没有这些，产物里只剩一句「符合 GB 50311 的规定」，事后无从判断该去补哪一段。
      //
      // TODO(unresolved-external-reference): 目前只把线索放进这一次调用的回执里，
      // 单次可见、不汇总。应当把全批的 unresolved_reference 收集成一张清单随 job 产出
      // （建议落在 result.json 顶层，字段形如 unresolved_references[]，逐条带
      // origin_locator / origin_clause_id / origin_excerpt / raw_reference / target），
      // 让「本工程还欠哪几本外部标准、分别欠在哪几条」一眼可查，也便于日后补齐后重跑。
      ...(missing
        ? {
          unresolved_reference: {
            origin_locator: originRecord.locator,
            ...(originRecord.clause_id ? { origin_clause_id: originRecord.clause_id } : {}),
            origin_locators: referenceOccurrenceOriginEvidenceIds(unresolved).map((evidenceId) =>
              evidence.evidence.find((record) => record.evidence_id === evidenceId)?.locator ?? ""
            ),
            origin_excerpt: literalSpans.map((literal) => {
              const record = evidence.evidence.find((candidate) => candidate.evidence_id === literal.evidence_id)!;
              return record.text.slice(
                Math.max(0, literal.start - 80),
                Math.min(record.text.length, literal.end + 80),
              );
            }).join(" ")
              .replace(/\s+/g, " ")
              .trim(),
            target_kind: request.target.kind,
            target_number: request.target.number,
            ...(request.relation ? { relation: request.relation } : {}),
          },
        }
        : {}),
      instruction: externalDocument
        ? "外部资料已就绪，本次指定目标未定位，不能作为解析成功或正文已接收。按 actual 和 how_to_pass 修正 target 后重试；不得继续沿用外部正文未提供的旧交接，或用空目标回执完成业务。"
        : request.external_standard
        ? "外部标准引用已登记为占位：外部正文尚未接入，不代表已读取或核验。使用本回执的 occurrence_id 和全部 reference_literal_span_ids，按 keep_reference/reference_only 保留原业务字段中的引用，target_span_ids 留空，继续本地抽取；不要改用内部章节查询，不要反复重试，也不要编造外部条文、限值或抽样要求。"
        : missing
        ? target.error === "not_found"
          ? "当前所选文档中未定位到引用目标；这不能确定引用属于内部还是外部。保留原引用、字段位置和待核问题，先核对原文及上位验收依据，再按所属文档选择定位或外部资料路径；不得猜测标准号、版本或被引内容。"
          : "引用指向的来源尚未提供。保留原引用文字、字段位置和关系，不得猜测被引内容；unresolved_reference 已记下原文位置与上下文。"
        : "candidate_start_line 不在当前候选列表中。请从 candidates 选择准确的 start_line 后重试；不得猜位置。",
    };
  }
  const occurrenceRequest = externalDocument && !resolvedRequest.external_standard
    ? { ...resolvedRequest, external_standard: { standard_no: externalDocument.standard_no, status: "resolved" as const, usage: "content_required" as const, markdown_sha256: externalDocument.markdown_sha256 } }
    : resolvedRequest;
  const proposedOccurrence = documentReferenceOccurrence(
    currentSourceId,
    occurrenceRequest,
    target,
    effectiveOriginSpanIds,
    literalSpans,
  );
  const referenceState = await workspace.readState();
  const existing = existingDocumentReferenceOccurrence(
    evidence.reference_occurrences,
    proposedOccurrence,
    !allowAfterValidation && referenceState.status === "working"
      && !referenceState.last_valid_fingerprint && !referenceState.last_valid_plan_sha256
      && !referenceState.repair?.coverage_review_fingerprint ? evidence : undefined,
  );
  const registrationCandidate = existing
    ? { ...proposedOccurrence, occurrence_id: existing.occurrence_id }
    : proposedOccurrence;
  const correction = planReferenceCorrection(evidence, registrationCandidate, request, await workspace.readReferenceCorrections());
  if (!correction.ok) return correction;
  const supersededOccurrenceIds = [...new Set([
    ...correction.superseded_ids,
    ...supersededCompositeOccurrenceIds(evidence.reference_occurrences, registrationCandidate),
    ...evidence.reference_occurrences.filter(entry => externalDocument && entry.status === "target_not_found"
      && entry.external_standard?.standard_no === request.external_standard?.standard_no
      && (entry.external_standard?.status !== "placeholder" || (
        entry.external_standard.usage === request.external_standard?.usage
        && entry.target_address?.locator_kind === request.target.kind
        && entry.target_address.locator === `${request.target.kind}:${normalizedNumber(request.target.number)}${request.target.paragraph ? `/paragraph:${request.target.paragraph}` : ""}`
      ))
      && referenceOccurrenceLiteralSpanIds(entry).join("\0") === literalSpans.map(span => span.span_id).join("\0"))
      .map(entry => entry.occurrence_id),
  ])];
  let occurrence = registrationCandidate;
  if (!existing) {
    const cycle = documentReferenceWouldCycle(
      evidence.reference_occurrences.filter(entry => !supersededOccurrenceIds.includes(entry.occurrence_id)),
      literalSpans.map((literal) => literal.evidence_id),
      target.target_evidence_ids,
    );
    if (cycle.cycle) {
      const cycleReadTool = allowAfterValidation ? "list_coverage_reference_targets" : "list_reference_occurrences";
      return {
        ok: false,
        error: "cycle",
        origin_evidence_id: origin.evidence_id,
        target_evidence_ids: target.target_evidence_ids,
        cycle_path: cycle.path,
        terminal: false,
        budget_consumed: false,
        dependency_registered: false,
        actual: {
          origin_evidence_ids: literalSpans.map((literal) => literal.evidence_id),
          origin_span_ids: effectiveOriginSpanIds,
          reference_literal_span_ids: literalSpans.map((literal) => literal.span_id),
          raw_reference: literalText,
          requested_target: request.target,
          target_locator: target.locator,
          target_evidence_ids: target.target_evidence_ids,
          cycle_evidence_ids: cycle.path,
        },
        expected: { dependency_graph: "acyclic" },
        writable_paths: ["/origin_span_id", "/origin_span_ids", "/reference_literal_span_id", "/reference_literal_span_ids", "/raw_reference", "/target"],
        next_tool: cycleReadTool,
        next_tool_arguments: { cursor: 0, limit: 100 },
        next_tools: [cycleReadTool, "resolve_document_reference"],
        how_to_pass: "先读取已登记引用，按 actual.origin_evidence_ids、target_evidence_ids 和 cycle_evidence_ids 核对闭环及原引用。若来源或目标定位确有原文依据的错误，只修正 writable_paths 中对应的调用参数，再重试 resolve_document_reference；改 relation、理由或重复同一请求不会解除闭环。若原文和定位都正确，当前依赖图不能再登记这条循环边，保留原引用和已确认的本地业务内容，继续独立可完成的工作并记录该阻塞，不得宣称引用已解析。",
        do_not_edit: "不可变原文、已登记 occurrence、依赖图或编译产物；不得删除已有引用、缩减真实目标来源或虚构另一目标来绕过成环检查。",
        instruction: "本次未登记新 occurrence 或目标依赖；先前定位产生的 literal span 可以保留在来源登记表中，不代表引用登记成功。真实闭环在相同参数和依赖图下不可恢复；仅有原文支持的定位纠正才允许重试。",
      };
    }
  }
  const registered = await workspace.registerDocumentReferenceDependency(
    target.evidence,
    registrationCandidate,
    allowAfterValidation,
    supersededOccurrenceIds,
    correction.archive,
  );
  evidence.evidence = registered.manifest.evidence;
  evidence.table_fragments = registered.manifest.table_fragments;
  evidence.reference_occurrences = registered.manifest.reference_occurrences;
  evidence.evidence_fingerprint = registered.manifest.evidence_fingerprint;
  occurrence = registered.manifest.reference_occurrences.find((entry) =>
    entry.occurrence_id === registrationCandidate.occurrence_id
  ) ?? registrationCandidate;
  const targetRead = documentReferenceTargetReadIdentity(occurrence);
  const occurrenceOriginKey = referenceOccurrenceOriginEvidenceIds(occurrence).join("\0");
  const sameOriginOccurrences = evidence.reference_occurrences.filter((entry) => (
    entry.status === "resolved"
    && referenceOccurrenceOriginEvidenceIds(entry).join("\0") === occurrenceOriginKey
  ));
  return {
    ok: true,
    idempotent: Boolean(existing),
    ...(existing?.occurrence_id !== proposedOccurrence.occurrence_id
      ? { logical_occurrence_deduplicated: true }
      : {}),
    ...occurrenceRouteUpdateMetadata(existing, occurrence, request.origin_field),
    occurrence_id: occurrence.occurrence_id,
    origin_field: occurrence.origin_fields[0],
    reference_literal_span_id: occurrence.reference_literal_span_id ?? literalSpans[0]!.span_id,
    reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
    origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
    origin_span_ids: referenceOccurrenceOriginSpanIds(occurrence),
    raw_reference: occurrence.raw_reference,
    normalized_reference: occurrence.normalized_reference ?? occurrence.raw_reference,
    ...(supersededOccurrenceIds.length ? { superseded_occurrence_ids: supersededOccurrenceIds } : {}),
    ...(correction.receipt ? { correction: correction.receipt,
      author_action: "read_target_selectors_then_replace_only_the_old_reference_occurrence_id_and_review_its_routes" } : {}),
    receipt_compacted: true,
    target_key: targetRead.target_key,
    target_locator: targetRead.target_locator,
    reference_kind: occurrence.reference_kind,
    evidence_count: targetRead.target_evidence_count,
    analysis_status: "pending",
    target_fingerprint: targetRead.target_fingerprint,
    decomposition_review: {
      required: true,
      component_count: occurrence.target_evidence_ids.length,
      same_origin_occurrence_count: sameOriginOccurrences.length,
      same_origin_occurrence_ids: sameOriginOccurrences.map((entry) => entry.occurrence_id),
      same_origin_target_locators: sameOriginOccurrences.map((entry) => referenceOccurrenceTargetLocator(entry)),
      instruction: "读取全部组件后逐项写 component_dispositions；同一来源句的并列引用不得仅因已闭合就合成一个 item。",
    },
    instruction: "This receipt covers only this occurrence and target. Read every returned component, author component_dispositions, and resolve every other parallel reference in the same source sentence with its own Tool Call. Reference closure alone is not semantic decomposition.",
  };
}
