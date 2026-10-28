import { replaceAcceptanceToolText } from "./acceptance-tool-text.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "./acceptance-tool-text.js";
import { chmod, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  appendText,
  atomicWriteJson,
  atomicWriteNewText,
  atomicWriteText,
  makeReadOnly,
  pathExists,
  readJson,
} from "./atomic.js";
import { catchToolReject, fingerprintMismatchReject, toolReject } from "./actionable-error.js";
import { prettyJson, sha256Bytes, sha256Json, sha256Text } from "./canonical.js";
import { confirmedTargetScope, primaryTargetOverlaps, TargetScopeConflict } from "./confirmed-target-scope.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
  type EvidenceRecord,
  type SemanticReferenceCandidate,
} from "./contracts.js";
import { applyJsonPatch, type JsonPatchOperation } from "./json-patch.js";
import { discoveryObligations, type DiscoveryDecision } from "./discovery-obligations.js";
import { assertDiscoveryAliasReferences, bindDiscoverySources, discoveryAtomWithLines, DiscoverySourceBindingSchema, reconcileAdjacentSourceBlockAnchors, resolveDiscoveryAliases, type DiscoverySourceBinding } from "./discovery-source-bindings.js";
import { DiscoveryPendingDraftError, discoveryDraftOperations, discardDiscoveryDraft, findCurrentDiscoveryDraft, mergeDiscoveryDraftRegistry, readDiscoveryDraft, retainDiscoveryDraft, type DiscoveryPendingDraft } from "./discovery-pending-draft.js";
import { DISCOVERY_SCOPE_SEMANTICS_GUIDANCE } from "./discovery-semantic-guidance.js";
import { discoverySourceBlockPreview } from "./discovery-source-preview.js";
import { discoveryRecordSpanIds, discoveryReviewRecordFingerprint, discoveryReviewRows, discoveryReviewSummary,
  type DiscoveryReviewCollection, type DiscoveryReviewCheckpoint, type DiscoveryReviewReceipts } from "./discovery-review-progress.js";
import {
  buildGranularProseCoverageEvidence,
  buildStructuredTargetEvidence,
} from "./evidence.js";
import { strictJsonParse } from "./strict-json.js";
import { clipSourceToLineWindow } from "./source-window.js";
import { governingContextWindows } from "./governing-context.js";
import {
  compileDocumentSelectors,
  DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA,
  DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
  DocumentSelectorCompileError,
  documentSelectorFingerprint,
  discoveryScopeReviewHints,
  initialDocumentSelectorPlan,
  reconcileDocumentSelectorRelations,
  type DocumentSelectorPlan,
} from "./document-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  locateSourceQuote,
  registerSourceSpan,
  registryWithFullSourceSpans,
  SourceSpanRegistryError,
  type SourceSpanRecord,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import {
  documentNormativeEndLine,
  discoveryScopeWindows,
  evaluateDiscoveryLedgerAgreement,
  extractableClauseIds,
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
  ledgerWithCurrentClauseBoundaries,
  type DocumentLedger,
} from "./document-ledger.js";
import {
  pdfNativeEvidenceForMarkdownWindow,
  profilePromotedHeadings,
  type PdfLayoutProfile,
} from "./pdf-layout-profile.js";

export const DOCUMENT_EVIDENCE_SCHEMA_VERSION = "document-evidence/v1" as const;
export const DOCUMENT_TARGET_PLAN_SCHEMA_VERSION = "document-target-plan/v4" as const;
const LEGACY_DOCUMENT_TARGET_PLAN_SCHEMA_VERSION = "document-target-plan/v3" as const;
const DEFAULT_ATOM_CHARS = 6_000;
const ATOM_NEWLINE_SEARCH_CHARS = 500;
const DOCUMENT_ATOM_ID_VERSION = "document-newline-preferred-window/v2";
const REFERENCE_RETRIEVAL_CANDIDATE_RE = /(?:表\s*(?:[A-Za-z]?\s*\d|[一二三四五六七八九十百千万零〇甲乙丙丁戊己庚辛壬癸]|[“"'])|附表|上表|下表|前表|后表|本表|附录|第\s*[一二三四五六七八九十百千万零〇\d]+\s*(?:节|条|款|项)|(?:第\s*)?\d+(?:[.．]\d+)+(?:\s*(?:至|到|[-–—~～])\s*(?:第\s*)?\d+(?:[.．]\d+)+)?\s*(?:节|条|款|项)|前述|上述|下述|前款|下款)/i;

function referenceRetrievalCandidates(
  atoms: DocumentAtom[],
): SemanticReferenceCandidate[] {
  const candidates: SemanticReferenceCandidate[] = [];
  const seen = new Set<string>();
  for (const atom of atoms) {
    const fragments = atom.text.match(/[^。；！？\n]{1,240}[。；！？]?/g) ?? [];
    for (const raw of fragments) {
      const exactFragment = raw.trim();
      if (!exactFragment || !REFERENCE_RETRIEVAL_CANDIDATE_RE.test(exactFragment)) continue;
      const key = `${atom.atom_id}|${exactFragment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        candidate_id: `reference-candidate:${sha256Text(key)}`,
        evidence_id: atom.atom_id,
        exact_fragment: exactFragment,
        discovery_basis: "text-retrieval",
        reason: "High-recall retrieval hint only. The target Agent must decide from full semantic context whether a dependency exists and what it points to; ambiguity must remain unresolved.",
      });
    }
  }
  return candidates;
}

export interface DocumentAtom {
  atom_id: string;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
  text: string;
  text_sha256: string;
}

export interface DocumentEvidence {
  schema_version: typeof DOCUMENT_EVIDENCE_SCHEMA_VERSION;
  source: {
    file_name: string;
    sha256: string;
    char_count: number;
    atom_chars: number;
  };
  atoms: DocumentAtom[];
  evidence_fingerprint: string;
}

export interface DocumentTarget {
  semantic_basis?: DocumentSelectorPlan["targets"][number]["semantic_basis"];
  target_id: string;
  group_id: string;
  group_name: string;
  group_reason: string;
  name: string;
  description: string;
  work_scope?: import("./confirmed-target-scope.js").ConfirmedWorkScope;
  evidence_atom_ids: string[];
  evidence_fragments: Array<{ atom_id: string; text: string }>;
  materialization: {
    kind: "inspection_scope" | "work_scope";
    lot_basis_summary: string;
    lot_basis_fragments: Array<{ atom_id: string; text: string }>;
    reason: string;
  };
  reason: string;
}

export interface DocumentContextNote {
  context_id: string;
  role: "governing_rule" | "aggregate_acceptance" | "definition" | "record_template" | "other_context";
  name: string;
  evidence_atom_ids: string[];
  evidence_fragments: Array<{ atom_id: string; text: string }>;
  reason: string;
}

export interface DocumentAtomDisposition {
  atom_id: string;
  disposition: "target" | "context" | "irrelevant" | "unreviewed";
  target_ids: string[];
  reason: string;
}

export interface DocumentTargetPlan {
  schema_version: typeof DOCUMENT_TARGET_PLAN_SCHEMA_VERSION;
  job_id: string;
  document_fingerprint: string;
  no_target_reason?: string;
  targets: DocumentTarget[];
  context_notes: DocumentContextNote[];
  dispositions: DocumentAtomDisposition[];
}

export interface DocumentPlanIssue {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}

export interface DocumentPlanValidation {
  ok: boolean;
  issues: DocumentPlanIssue[];
  plan?: DocumentTargetPlan;
  plan_sha256?: string;
  fingerprint?: string;
}

interface DiscoveryState {
  schema_version: "document-discovery-state/v2";
  status: "working" | "candidate" | "sealed";
  next_event_sequence: number;
  next_history_sequence: number;
  next_validation_sequence: number;
  /** Candidate/author final-validation attempts retained under the legacy field name. */
  validation_attempts: number;
  /** Independent reviewer budget; optional so persisted v2 states upgrade lazily. */
  reviewer_validation_attempts?: number;
  last_valid_fingerprint: string;
  last_valid_plan_sha256: string;
  last_reviewed_fingerprint: string;
  last_reviewed_plan_sha256: string;
  last_selector_fingerprint: string;
  last_issue_fingerprint: string;
  opened_atom_ids: string[];
  reviewer_opened_atom_ids: string[];
  /** Full accepted records delivered in this independent review, not semantic approval. */
  reviewer_selector_read_receipts?: { targets: Record<string, string>; contexts: Record<string, string> };
  /** Explicit independent judgments; reads and global validation are separate. */
  reviewer_semantic_review_receipts?: DiscoveryReviewReceipts;
  selector_protocol?: {
    submissions: number;
    corrections: number;
    last_issue_fingerprint: string;
  };
  agent_runtime: {
    kind: "pi-sdk" | "offline-scripted" | "unassigned";
    session_id: string;
    session_file: string;
  };
  reviewer_runtime: {
    kind: "pi-sdk" | "offline-scripted" | "unassigned";
    session_id: string;
    session_file: string;
  };
  review_reason: string;
  /** Changes whenever an independent review starts; old pending edits cannot cross phases. */
  pending_draft_epoch?: string;
}

/**
 * Upgrade the previous discovery contract without losing useful Agent prose.
 *
 * v3 had no dedicated summary field, so Agents sometimes placed a semantic
 * paraphrase in lot_basis_fragments. Exact fragments remain exact citations;
 * non-exact text is moved into lot_basis_summary and must still be replaced by
 * a real citation before validation can pass. materialization.reason is never
 * used as a summary fallback because it retains its argument/justification role.
 */
export function migrateDocumentTargetPlan(
  input: unknown,
  evidence: DocumentEvidence,
): unknown {
  if (!isRecord(input) || input.schema_version !== LEGACY_DOCUMENT_TARGET_PLAN_SCHEMA_VERSION) {
    return input;
  }
  const migrated = structuredClone(input);
  migrated.schema_version = DOCUMENT_TARGET_PLAN_SCHEMA_VERSION;
  const atomById = new Map(evidence.atoms.map((atom) => [atom.atom_id, atom]));
  if (!Array.isArray(migrated.targets)) return migrated;
  for (const target of migrated.targets) {
    if (!isRecord(target) || !isRecord(target.materialization)) continue;
    const rawFragments = Array.isArray(target.materialization.lot_basis_fragments)
      ? target.materialization.lot_basis_fragments
      : [];
    const exactFragments: unknown[] = [];
    const legacySummaries: string[] = [];
    for (const fragment of rawFragments) {
      if (!isRecord(fragment) || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string") {
        exactFragments.push(fragment);
        continue;
      }
      const atom = atomById.get(fragment.atom_id);
      if (atom?.text.includes(fragment.text)) exactFragments.push(fragment);
      else if (fragment.text.trim()) legacySummaries.push(fragment.text.trim());
    }
    target.materialization.lot_basis_fragments = exactFragments;
    const summaryParts = legacySummaries.length > 0
      ? legacySummaries
      : exactFragments.flatMap((fragment) =>
          isRecord(fragment) && typeof fragment.text === "string" && fragment.text.trim()
            ? [fragment.text.trim()]
            : []);
    target.materialization.lot_basis_summary = [...new Set(summaryParts)].join("；");
  }
  return migrated;
}

interface NormalizedEvidenceView {
  text: string;
  startOffsets: number[];
  endOffsets: number[];
}

export interface DocumentPlanCanonicalizationChange {
  path: string;
  before: unknown;
  after: unknown;
  reason: "derived_description" | "unique_normalized_source_match";
}

export interface DocumentPlanCanonicalization {
  plan: unknown;
  changes: DocumentPlanCanonicalizationChange[];
}

// Keep operators, units, numeric punctuation, brackets, slashes, ranges, and table
// delimiters semantic. Only layout/Markdown marks and sentence punctuation may
// disappear while selecting a source range.
const FORMAT_ONLY_CHARACTER_RE = /[\p{White_Space}#*_`\\"'“”‘’，,。；;：:、！？!?]/u;
const MARKDOWN_PAGE_MARKER_RE = /<!--\s*pages?[^>]*-->/giu;

function normalizedEvidenceView(value: string): NormalizedEvidenceView {
  let text = "";
  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const endOffset = offset + sourceCharacter.length;
    for (const normalizedCharacter of sourceCharacter.normalize("NFKC")) {
      if (FORMAT_ONLY_CHARACTER_RE.test(normalizedCharacter)) continue;
      text += normalizedCharacter;
      startOffsets.push(offset);
      endOffsets.push(endOffset);
    }
    offset = endOffset;
  }
  return { text, startOffsets, endOffsets };
}

function normalizedText(value: string): string {
  return normalizedEvidenceView(value).text;
}

function exactSourceRange(
  source: string,
  view: NormalizedEvidenceView,
  normalizedStart: number,
  normalizedLength: number,
): string {
  const start = view.startOffsets[normalizedStart];
  const end = view.endOffsets[normalizedStart + normalizedLength - 1];
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

function uniqueNormalizedSourceMatch(source: string, requested: string): string | undefined {
  if (source.includes(requested)) return requested;
  const sourceView = normalizedEvidenceView(source);
  const needle = normalizedText(requested);
  if (!needle) return undefined;
  const first = sourceView.text.indexOf(needle);
  if (first < 0 || sourceView.text.indexOf(needle, first + 1) >= 0) return undefined;
  const exact = exactSourceRange(source, sourceView, first, needle.length);
  return exact && source.includes(exact) ? exact : undefined;
}

function pageBoundaryFragmentCandidates(
  atomId: string,
  source: string,
  requested: string,
): Array<{ reason: "markdown_page_boundary"; fragments: Array<{ atom_id: string; text: string }> }> {
  const needle = normalizedText(requested);
  if (needle.length < 8) return [];
  const markers = [...source.matchAll(MARKDOWN_PAGE_MARKER_RE)];
  const candidates: Array<{ reason: "markdown_page_boundary"; fragments: Array<{ atom_id: string; text: string }> }> = [];
  for (const marker of markers) {
    const markerStart = marker.index;
    if (markerStart === undefined) continue;
    const markerEnd = markerStart + marker[0].length;
    const leftSource = source.slice(0, markerStart);
    const rightSource = source.slice(markerEnd);
    const leftView = normalizedEvidenceView(leftSource);
    const rightView = normalizedEvidenceView(rightSource);
    for (let split = 4; split <= needle.length - 4; split += 1) {
      const leftNeedle = needle.slice(0, split);
      const rightNeedle = needle.slice(split);
      if (!leftView.text.endsWith(leftNeedle) || !rightView.text.startsWith(rightNeedle)) continue;
      const leftExact = exactSourceRange(
        leftSource,
        leftView,
        leftView.text.length - leftNeedle.length,
        leftNeedle.length,
      );
      const rightExact = exactSourceRange(rightSource, rightView, 0, rightNeedle.length);
      if (!leftExact || !rightExact) continue;
      candidates.push({
        reason: "markdown_page_boundary",
        fragments: [
          { atom_id: atomId, text: leftExact },
          { atom_id: atomId, text: rightExact },
        ],
      });
      break;
    }
  }
  return candidates.slice(0, 4);
}

/**
 * Repairs representation-only differences without making any semantic decision.
 * The returned plan still stores byte-exact substrings from immutable atoms.
 */
export function canonicalizeDocumentTargetPlan(
  input: unknown,
  evidence: DocumentEvidence,
): DocumentPlanCanonicalization {
  const plan = structuredClone(migrateDocumentTargetPlan(input, evidence));
  const changes: DocumentPlanCanonicalizationChange[] = [];
  if (!isRecord(plan)) return { plan, changes };
  const atomById = new Map(evidence.atoms.map((atom) => [atom.atom_id, atom]));

  const canonicalizeFragments = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) return;
    value.forEach((fragment, index) => {
      if (!isRecord(fragment) || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string") return;
      const atom = atomById.get(fragment.atom_id);
      if (!atom || atom.text.includes(fragment.text)) return;
      const exact = uniqueNormalizedSourceMatch(atom.text, fragment.text);
      if (!exact || exact === fragment.text) return;
      const before = fragment.text;
      fragment.text = exact;
      changes.push({
        path: `${path}/${index}/text`,
        before,
        after: exact,
        reason: "unique_normalized_source_match",
      });
    });
  };

  if (Array.isArray(plan.targets)) {
    plan.targets.forEach((target, index) => {
      if (!isRecord(target)) return;
      const path = `/targets/${index}`;
      if (typeof target.description !== "string" || !target.description.trim()) {
        const name = typeof target.name === "string" ? target.name.trim() : "";
        const materialization = isRecord(target.materialization) ? target.materialization : undefined;
        const summary = typeof materialization?.lot_basis_summary === "string"
          ? materialization.lot_basis_summary.trim()
          : "";
        if (name && summary) {
          const before = target.description;
          target.description = `${name}：${summary}`;
          changes.push({
            path: `${path}/description`,
            before,
            after: target.description,
            reason: "derived_description",
          });
        }
      }
      canonicalizeFragments(target.evidence_fragments, `${path}/evidence_fragments`);
      if (isRecord(target.materialization)) {
        canonicalizeFragments(
          target.materialization.lot_basis_fragments,
          `${path}/materialization/lot_basis_fragments`,
        );
      }
    });
  }
  if (Array.isArray(plan.context_notes)) {
    plan.context_notes.forEach((context, index) => {
      if (!isRecord(context)) return;
      canonicalizeFragments(context.evidence_fragments, `/context_notes/${index}/evidence_fragments`);
    });
  }
  return { plan, changes };
}

export type DocumentDiscoveryPhase = "candidate" | "review";

function countNewlines(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

/**
 * Full-atom spans pre-registered by the harness (start 0 .. end len).
 * These are the only spans valid for atom dispositions; exposing their IDs
 * lets the model reference them directly instead of quoting whole atoms.
 */
function fullAtomSpans(
  registry: SourceSpanRegistry,
  atoms: DocumentEvidence["atoms"],
): SourceSpanRecord[] {
  return atoms.map((atom) => {
    const span = registry.spans.find((candidate) =>
      candidate.atom_id === atom.atom_id
      && candidate.start === 0
      && candidate.end === atom.text.length);
    if (!span) {
      throw new Error(`Missing harness-registered full-atom span for ${atom.atom_id}`);
    }
    return span;
  });
}

const DISCOVERY_FINAL_VALIDATION_ATTEMPT_LIMIT = 6;

function preferredAtomEnd(
  markdown: string,
  start: number,
  target: number,
): number {
  if (target >= markdown.length) return markdown.length;

  const searchStart = Math.max(start + 1, target - ATOM_NEWLINE_SEARCH_CHARS);
  const searchEnd = Math.min(markdown.length, target + ATOM_NEWLINE_SEARCH_CHARS);
  let bestEnd = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let newline = markdown.indexOf("\n", searchStart - 1);
  while (newline >= 0) {
    const candidateEnd = newline + 1;
    if (candidateEnd > searchEnd) break;
    const distance = Math.abs(candidateEnd - target);
    if (distance < bestDistance || (distance === bestDistance && candidateEnd < bestEnd)) {
      bestEnd = candidateEnd;
      bestDistance = distance;
    }
    newline = markdown.indexOf("\n", newline + 1);
  }
  if (bestEnd >= 0) return bestEnd;

  // A hard boundary remains a UTF-16 offset, but must not bisect a CRLF or
  // a Unicode surrogate pair. Moving forward preserves progress and coverage.
  const before = markdown.charCodeAt(target - 1);
  const after = markdown.charCodeAt(target);
  const splitsCrLf = before === 0x0d && after === 0x0a;
  const splitsSurrogatePair = before >= 0xd800 && before <= 0xdbff
    && after >= 0xdc00 && after <= 0xdfff;
  return splitsCrLf || splitsSurrogatePair ? target + 1 : target;
}

export function buildDocumentEvidence(
  markdown: string,
  fileName: string,
  atomChars: number = DEFAULT_ATOM_CHARS,
): DocumentEvidence {
  if (!Number.isInteger(atomChars) || atomChars < 1_000 || atomChars > 20_000) {
    throw new Error("atomChars must be an integer between 1000 and 20000");
  }
  const sourceSha256 = sha256Text(markdown);
  const atoms: DocumentAtom[] = [];
  let line = 1;
  for (let start = 0; start < markdown.length;) {
    const target = Math.min(markdown.length, start + atomChars);
    const end = preferredAtomEnd(markdown, start, target);
    const text = markdown.slice(start, end);
    const startLine = line;
    line += countNewlines(text);
    const textSha256 = sha256Text(text);
    atoms.push({
      atom_id: `atom:${sha256Text(
        `${DOCUMENT_ATOM_ID_VERSION}|${sourceSha256}|${start}|${end}|${textSha256}`,
      )}`,
      start_offset: start,
      end_offset: end,
      start_line: startLine,
      end_line: line,
      text,
      text_sha256: textSha256,
    });
    start = end;
  }
  const payload = {
    schema_version: DOCUMENT_EVIDENCE_SCHEMA_VERSION,
    source: {
      file_name: fileName,
      sha256: sourceSha256,
      char_count: markdown.length,
      atom_chars: atomChars,
    },
    atoms,
  };
  return { ...payload, evidence_fingerprint: sha256Json(payload) };
}

export function initialDocumentTargetPlan(
  jobId: string,
  evidence: DocumentEvidence,
): DocumentTargetPlan {
  return {
    schema_version: DOCUMENT_TARGET_PLAN_SCHEMA_VERSION,
    job_id: jobId,
    document_fingerprint: evidence.evidence_fingerprint,
    targets: [],
    context_notes: [],
    dispositions: evidence.atoms.map((atom) => ({
      atom_id: atom.atom_id,
      disposition: "unreviewed",
      target_ids: [],
      reason: "尚未由领域 Agent 调查",
    })),
  };
}

/**
 * 文档没有可用的必抽窗口时，模型自由拆 target 会把“工作分片”和“检验批”混为一层：
 * 同一份文档实测曾切成 24、9、33 个 target。这里仅把非业务的调度边界固定为文档自身
 * 的章/节标题；真正的 inspection_lots 仍由每个 target Agent 从范围正文里语义生成。
 *
 * 有可靠 ledger window 的文档继续走原路径，不受这条兜底影响。
 */
export function stableHeadingWorkScopePlan(
  jobId: string,
  evidence: DocumentEvidence,
  ledger: DocumentLedger,
): DocumentTargetPlan | undefined {
  const hasActiveLedgerWindows = ledger.windows.some((window) =>
    !window.ignored && window.extractable_clause_ids.length > 0
  );
  if (hasActiveLedgerWindows) return undefined;

  const sourceLines = evidence.atoms.map((atom) => atom.text).join("")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const sourceLineCount = sourceLines.length;
  const normativeEndLine = documentNormativeEndLine(sourceLines) ?? sourceLineCount + 1;
  const chapters = ledger.headings
    .filter((heading) => /^\d+$/.test(heading.number) && heading.line < normativeEndLine)
    .sort((left, right) => left.line - right.line);
  const scopes: Array<{
    heading: DocumentLedger["headings"][number];
    chapter: DocumentLedger["headings"][number];
    start_line: number;
    end_exclusive_line: number;
  }> = [];
  chapters.forEach((chapter, chapterIndex) => {
    const nextChapterLine = chapters[chapterIndex + 1]?.line ?? sourceLineCount + 1;
    if (chapter.role === "ignored") return;
    const sections = ledger.headings
      .filter((heading) =>
        heading.line > chapter.line
        && heading.line < nextChapterLine
        && new RegExp(`^${chapter.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`).test(heading.number)
        && heading.role !== "ignored"
      )
      .sort((left, right) => left.line - right.line);
    if (sections.length === 0) {
      scopes.push({
        heading: chapter,
        chapter,
        start_line: chapter.line,
        end_exclusive_line: nextChapterLine,
      });
      return;
    }
    sections.forEach((section, sectionIndex) => {
      scopes.push({
        heading: section,
        chapter,
        start_line: section.line,
        end_exclusive_line: sections[sectionIndex + 1]?.line ?? nextChapterLine,
      });
    });
  });
  if (scopes.length === 0) return undefined;

  const targetIdsByAtom = new Map<string, string[]>();
  const targets = scopes.flatMap((scope) => {
    const atom = evidence.atoms.find((candidate) =>
      scope.heading.line >= candidate.start_line
      && scope.heading.line <= candidate.end_line
      && candidate.text.includes(scope.heading.text)
    );
    if (!atom) return [];
    const scopeIdentity = `${evidence.source.sha256}\0work-scope\0${scope.start_line}\0${scope.end_exclusive_line}`;
    const targetId = `target:${sha256Text(scopeIdentity).slice(0, 24)}`;
    targetIdsByAtom.set(atom.atom_id, [
      ...(targetIdsByAtom.get(atom.atom_id) ?? []),
      targetId,
    ]);
    const fragment = { atom_id: atom.atom_id, text: scope.heading.text };
    return [{
      target_id: targetId,
      group_id: `group:${sha256Text(`${evidence.source.sha256}\0work-group\0${scope.chapter.number}`).slice(0, 24)}`,
      group_name: scope.chapter.title,
      group_reason: "按文档自身章标题形成稳定工作分组，不作为编辑器层级权威。",
      name: scope.heading.title,
      description: `文档工作分片 ${scope.heading.number} ${scope.heading.title}`,
      work_scope: {
        start_line: scope.start_line,
        end_exclusive_line: scope.end_exclusive_line,
      },
      evidence_atom_ids: [atom.atom_id],
      evidence_fragments: [fragment],
      materialization: {
        kind: "work_scope" as const,
        lot_basis_summary: `稳定工作分片 ${scope.heading.number} ${scope.heading.title}；下游从范围正文生成一个或多个检验批。`,
        lot_basis_fragments: [fragment],
        reason: "标题树只决定可复现的读取边界，不预判最终检验批粒度。",
      },
      reason: "由文档自身标题树确定的稳定执行范围。",
    }];
  });
  if (targets.length !== scopes.length) return undefined;

  return {
    schema_version: DOCUMENT_TARGET_PLAN_SCHEMA_VERSION,
    job_id: jobId,
    document_fingerprint: evidence.evidence_fingerprint,
    targets,
    context_notes: [],
    dispositions: evidence.atoms.map((atom) => {
      const targetIds = targetIdsByAtom.get(atom.atom_id) ?? [];
      return targetIds.length > 0
        ? {
            atom_id: atom.atom_id,
            disposition: "target" as const,
            target_ids: targetIds,
            reason: "该原子包含一个或多个稳定工作分片标题。",
          }
        : {
            atom_id: atom.atom_id,
            disposition: "context" as const,
            target_ids: [],
            reason: "正文由工作分片行范围按需读取，不用原子边界决定业务归属。",
          };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function semanticRecordCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  return (Array.isArray(value.targets) ? value.targets.length : 0)
    + (Array.isArray(value.contexts)
      ? value.contexts.length
      : Array.isArray(value.context_notes) ? value.context_notes.length : 0);
}

function boundedDiscoveryMutation(
  before: unknown,
  after: unknown,
  operation: "replace" | "patch",
  patchOperations: JsonPatchOperation[] = [],
): DiscoveryToolResponse | undefined {
  const beforeCount = semanticRecordCount(before);
  const afterCount = semanticRecordCount(after);
  if (afterCount - beforeCount > 4) {
    return {
      ok: false,
      error: "incremental_discovery_checkpoint_required",
      before_semantic_records: beforeCount,
      after_semantic_records: afterCount,
      instruction: "Persist at most four new targets/context notes per bounded patch.",
    };
  }
  if (operation === "replace" && beforeCount > 0) {
    return {
      ok: false,
      error: "incremental_discovery_patch_required",
      semantic_records: beforeCount,
      instruction: "The discovery plan already has a durable checkpoint; continue with patch_discovery_plan instead of replacing the complete plan.",
    };
  }
  if (
    operation === "patch"
    && beforeCount > 0
    && patchOperations.some((entry) => entry.path === "/targets" || entry.path === "/contexts" || entry.path === "/context_notes")
  ) {
    return {
      ok: false,
      error: "incremental_discovery_item_patch_required",
      semantic_records: beforeCount,
      instruction: "Patch individual target/context entries; existing checkpoints may be revised by exact item path, but do not replace a complete semantic array.",
    };
  }
  return undefined;
}

export function validateDocumentTargetPlan(
  input: unknown,
  evidence: DocumentEvidence,
  jobId: string,
  openedAtomIds: ReadonlySet<string>,
): DocumentPlanValidation {
  input = canonicalizeDocumentTargetPlan(input, evidence).plan;
  const issues: DocumentPlanIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ code: "plan_root", path: "", message: "Plan must be a JSON object" }] };
  }
  const allowedRoot = new Set(["schema_version", "job_id", "document_fingerprint", "targets", "context_notes", "dispositions", "no_target_reason"]);
  const extraRoot = Object.keys(input).filter((key) => !allowedRoot.has(key));
  if (extraRoot.length) issues.push({ code: "unknown_root_fields", path: "", message: "Unknown plan fields", details: extraRoot });
  if (input.schema_version !== DOCUMENT_TARGET_PLAN_SCHEMA_VERSION) {
    issues.push({ code: "schema_version", path: "/schema_version", message: "Unsupported document target plan schema" });
  }
  if (input.job_id !== jobId) issues.push({ code: "job_mismatch", path: "/job_id", message: "job_id does not match this discovery workspace" });
  if (input.document_fingerprint !== evidence.evidence_fingerprint) {
    issues.push({ code: "document_fingerprint", path: "/document_fingerprint", message: "Plan is not bound to this exact immutable document evidence" });
  }
  if (!Array.isArray(input.targets)) issues.push({ code: "targets_type", path: "/targets", message: "targets must be an array" });
  if (!Array.isArray(input.context_notes)) issues.push({ code: "context_notes_type", path: "/context_notes", message: "context_notes must be an array" });
  if (!Array.isArray(input.dispositions)) issues.push({ code: "dispositions_type", path: "/dispositions", message: "dispositions must be an array" });
  if (issues.some((issue) => ["targets_type", "context_notes_type", "dispositions_type"].includes(issue.code))) {
    return { ok: false, issues };
  }

  const atomById = new Map(evidence.atoms.map((atom) => [atom.atom_id, atom]));
  const exactFragmentIssues = new Map<string, {
    issue: DocumentPlanIssue;
    affectedFields: string[];
    affectedPaths: string[];
  }>();
  const recordExactFragmentIssue = (
    rootKey: string,
    code: string,
    path: string,
    field: string,
    atomId: string,
    requestedText: string,
    message: string,
  ): void => {
    const existing = exactFragmentIssues.get(rootKey);
    if (existing) {
      if (!existing.affectedFields.includes(field)) existing.affectedFields.push(field);
      if (!existing.affectedPaths.includes(path)) existing.affectedPaths.push(path);
      return;
    }
    const atom = atomById.get(atomId);
    const splitCandidates = atom
      ? pageBoundaryFragmentCandidates(atomId, atom.text, requestedText)
      : [];
    const affectedFields = [field];
    const affectedPaths = [path];
    const details: Record<string, unknown> = {
      atom_id: atomId,
      requested_text: requestedText,
      affected_fields: affectedFields,
      affected_paths: affectedPaths,
    };
    if (splitCandidates.length) details.exact_fragment_candidates = splitCandidates;
    exactFragmentIssues.set(rootKey, {
      issue: { code, path, message, details },
      affectedFields,
      affectedPaths,
    });
  };
  const targets = input.targets as unknown[];
  const targetIds: string[] = [];
  const targetAtomRelations = new Map<string, Set<string>>();
  targets.forEach((raw, index) => {
    const path = `/targets/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "target_type", path, message: "Target must be an object" });
      return;
    }
    const allowed = new Set([
      "semantic_basis",
      "target_id",
      "group_id",
      "group_name",
      "group_reason",
      "name",
      "description",
      "work_scope",
      "evidence_atom_ids",
      "evidence_fragments",
      "materialization",
      "reason",
    ]);
    const extras = Object.keys(raw).filter((key) => !allowed.has(key));
    if (extras.length) issues.push({ code: "unknown_target_fields", path, message: "Unknown target fields", details: extras });
    const targetId = typeof raw.target_id === "string" ? raw.target_id.trim() : "";
    if (!targetId) issues.push({ code: "target_id", path: `${path}/target_id`, message: "target_id must be non-empty" });
    else targetIds.push(targetId);
    if (typeof raw.group_id !== "string" || !raw.group_id.trim()) issues.push({ code: "target_group_id", path: `${path}/group_id`, message: "Target group_id must be non-empty" });
    if (typeof raw.group_name !== "string" || !raw.group_name.trim()) issues.push({ code: "target_group_name", path: `${path}/group_name`, message: "Target group_name must be non-empty" });
    if (typeof raw.group_reason !== "string" || !raw.group_reason.trim()) issues.push({ code: "target_group_reason", path: `${path}/group_reason`, message: "Target group_reason must be non-empty" });
    if (typeof raw.name !== "string" || !raw.name.trim()) issues.push({ code: "target_name", path: `${path}/name`, message: "Target name must be non-empty" });
    if (typeof raw.description !== "string" || !raw.description.trim()) issues.push({ code: "target_description", path: `${path}/description`, message: "Target description must be non-empty" });
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "target_reason", path: `${path}/reason`, message: "Target reason must be non-empty" });
    if (!stringArray(raw.evidence_atom_ids) || raw.evidence_atom_ids.length === 0) {
      issues.push({ code: "target_evidence", path: `${path}/evidence_atom_ids`, message: "Every target must cite at least one document atom" });
      return;
    }
    const repeated = duplicateValues(raw.evidence_atom_ids);
    if (repeated.length) issues.push({ code: "duplicate_target_evidence", path: `${path}/evidence_atom_ids`, message: "Target evidence atoms must be unique", details: repeated });
    const targetAtoms = new Set<string>();
    for (const atomId of raw.evidence_atom_ids) {
      targetAtoms.add(atomId);
      if (!atomById.has(atomId)) issues.push({ code: "unknown_target_atom", path: `${path}/evidence_atom_ids`, message: "Target cites an unknown atom", details: atomId });
      if (!openedAtomIds.has(atomId)) issues.push({ code: "unopened_target_atom", path: `${path}/evidence_atom_ids`, message: "Target evidence must be opened before validation", details: { atom_id: atomId } });
    }
    if (targetId) targetAtomRelations.set(targetId, targetAtoms);
    if (!Array.isArray(raw.evidence_fragments) || raw.evidence_fragments.length === 0) {
      issues.push({ code: "target_fragments", path: `${path}/evidence_fragments`, message: "Every target must bind exact source fragments" });
      return;
    }
    const fragmentAtoms = new Set<string>();
    raw.evidence_fragments.forEach((fragment, fragmentIndex) => {
      const fragmentPath = `${path}/evidence_fragments/${fragmentIndex}`;
      if (!isRecord(fragment) || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string" || !fragment.text.trim()) {
        issues.push({ code: "target_fragment_type", path: fragmentPath, message: "Fragment requires atom_id and non-empty exact text" });
        return;
      }
      fragmentAtoms.add(fragment.atom_id);
      const atom = atomById.get(fragment.atom_id);
      if (!targetAtoms.has(fragment.atom_id)) issues.push({ code: "fragment_atom_relation", path: fragmentPath, message: "Fragment atom must be listed in evidence_atom_ids" });
      if (atom && !atom.text.includes(fragment.text)) recordExactFragmentIssue(
        `target:${index}|${fragment.atom_id}|${fragment.text}`,
        "fragment_not_exact",
        fragmentPath,
        "evidence_fragments",
        fragment.atom_id,
        fragment.text,
        "Source fragment does not resolve to one unique exact substring of its immutable atom",
      );
    });
    const atomsWithoutFragments = [...targetAtoms].filter((atomId) => !fragmentAtoms.has(atomId));
    if (atomsWithoutFragments.length) issues.push({ code: "target_atom_without_fragment", path: `${path}/evidence_fragments`, message: "Every target atom needs at least one exact source fragment", details: atomsWithoutFragments });
    if (!isRecord(raw.materialization)) {
      issues.push({
        code: "target_materialization",
        path: `${path}/materialization`,
        message: "Every target must prove that it is a real inspection scope rather than governing or aggregate context",
      });
      return;
    }
    const materializationAllowed = new Set(["kind", "lot_basis_summary", "lot_basis_fragments", "reason"]);
    const materializationExtras = Object.keys(raw.materialization).filter((key) => !materializationAllowed.has(key));
    if (materializationExtras.length) {
      issues.push({ code: "unknown_target_materialization_fields", path: `${path}/materialization`, message: "Unknown target materialization fields", details: materializationExtras });
    }
    if (!['inspection_scope', 'work_scope'].includes(String(raw.materialization.kind))) {
      issues.push({ code: "target_materialization_kind", path: `${path}/materialization/kind`, message: "A materialized target must be an inspection_scope or work_scope" });
    }
    if (raw.materialization.kind === "work_scope") {
      if (
        !isRecord(raw.work_scope)
        || !Number.isInteger(raw.work_scope.start_line)
        || !Number.isInteger(raw.work_scope.end_exclusive_line)
        || Number(raw.work_scope.start_line) < 1
        || Number(raw.work_scope.end_exclusive_line) <= Number(raw.work_scope.start_line)
      ) {
        issues.push({
          code: "target_work_scope",
          path: `${path}/work_scope`,
          message: "A work_scope target must carry one valid deterministic line range",
        });
      }
    } else if (raw.work_scope !== undefined && !(isRecord(raw.work_scope) && Array.isArray(raw.work_scope.primary_fragments))) {
      issues.push({
        code: "inspection_target_work_scope_forbidden",
        path: `${path}/work_scope`,
        message: "An inspection_scope target must derive its range from its inspection evidence",
      });
    }
    if (isRecord(raw.work_scope) && Array.isArray(raw.work_scope.primary_fragments)) {
      try { confirmedTargetScope(raw as unknown as DocumentTarget, evidence); }
      catch (error) {
        if (!(error instanceof TargetScopeConflict)) throw error;
        issues.push({ code: error.code, path: `${path}/work_scope`, message: String(error.details.message), details: error.details });
      }
    }
    if (typeof raw.materialization.lot_basis_summary !== "string" || !raw.materialization.lot_basis_summary.trim()) {
      issues.push({ code: "target_lot_basis_summary", path: `${path}/materialization/lot_basis_summary`, message: "Target materialization must preserve a non-empty semantic summary of the inspection-lot basis" });
    }
    if (typeof raw.materialization.reason !== "string" || !raw.materialization.reason.trim()) {
      issues.push({ code: "target_materialization_reason", path: `${path}/materialization/reason`, message: "Target materialization reason must explain the real inspection-lot basis" });
    }
    if (!Array.isArray(raw.materialization.lot_basis_fragments) || raw.materialization.lot_basis_fragments.length === 0) {
      issues.push({ code: "target_lot_basis", path: `${path}/materialization/lot_basis_fragments`, message: "Every target must cite exact source proving a real inspection-lot scope" });
    } else {
      raw.materialization.lot_basis_fragments.forEach((fragment, fragmentIndex) => {
        const fragmentPath = `${path}/materialization/lot_basis_fragments/${fragmentIndex}`;
        if (!isRecord(fragment) || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string" || !fragment.text.trim()) {
          issues.push({ code: "target_lot_basis_type", path: fragmentPath, message: "Lot basis requires atom_id and non-empty exact text" });
          return;
        }
        const atom = atomById.get(fragment.atom_id);
        if (!targetAtoms.has(fragment.atom_id)) {
          issues.push({ code: "target_lot_basis_relation", path: fragmentPath, message: "Lot basis atom must be listed in target evidence_atom_ids" });
        }
        if (atom && !atom.text.includes(fragment.text)) {
          recordExactFragmentIssue(
            `target:${index}|${fragment.atom_id}|${fragment.text}`,
            "target_lot_basis_not_exact",
            fragmentPath,
            "materialization.lot_basis_fragments",
            fragment.atom_id,
            fragment.text,
            "Lot basis does not resolve to one unique exact substring of immutable evidence",
          );
        }
      });
    }
  });
  const repeatedTargetIds = duplicateValues(targetIds);
  if (repeatedTargetIds.length) issues.push({ code: "duplicate_target_id", path: "/targets", message: "target_id values must be unique", details: repeatedTargetIds });
  if (issues.length === 0) for (const overlap of primaryTargetOverlaps(targets as DocumentTarget[], evidence)) {
    issues.push({
      code: "target_primary_overlap",
      path: `/targets/${overlap.right_index}/work_scope`,
      message: "两个 target 重复占用同一段主资料；请发现 Agent 核对归属并修订范围。",
      details: {
        actual: overlap,
        target_ids: [overlap.left_index, overlap.right_index].map(index => (targets[index] as DocumentTarget).target_id),
        source_atom_ids: evidence.atoms.filter(atom => atom.start_offset < overlap.end && atom.end_offset > overlap.start).map(atom => atom.atom_id),
        writable_paths: [overlap.left_index, overlap.right_index].map(index => `/targets/${index}/source_blocks`),
        next_tools: ["read_document_selectors", "open_document_atom", "locate_document_span", "patch_document_selectors", "compile_document_selectors"],
        required_action: "由原文决定保留、合并或拆分的 target；修订双方 source_blocks，使同一非空原文只有一个 primary 所有者。其他 target 适用的共享内容放 reference_span_ids。旧范围计划先恢复为可写 document selectors，不能直接修改已封存计划或下游 evidence。",
      },
    });
  }
  if (targets.length === 0 && (typeof input.no_target_reason !== "string" || !input.no_target_reason.trim())) issues.push({ code: "zero_targets", path: "/no_target_reason", message: "零目标必须说明全文为何没有可验收对象。", details: { actual: input.no_target_reason ?? null, writable_path: "/no_target_reason", next_tool: "patch_document_selectors", required_action: "阅读全部原子，填写 selector 的 no_target_reason 并完成 contexts/dispositions，再 compile_document_selectors；不要直接修改编译产物。" } });
  if (targets.length > 0 && input.no_target_reason !== undefined) issues.push({ code: "no_target_reason_conflict", path: "/no_target_reason", message: "非空 targets 不能声明没有目标。", details: { actual: input.no_target_reason, writable_path: "/no_target_reason", next_tool: "patch_document_selectors", required_action: "移除 selectors.no_target_reason 后重新 compile_document_selectors。" } });
  const contextNotes = input.context_notes as unknown[];
  const contextIds: string[] = [];
  contextNotes.forEach((raw, index) => {
    const path = `/context_notes/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "context_note_type", path, message: "Context note must be an object" });
      return;
    }
    const allowed = new Set(["context_id", "role", "name", "evidence_atom_ids", "evidence_fragments", "reason"]);
    const extras = Object.keys(raw).filter((key) => !allowed.has(key));
    if (extras.length) issues.push({ code: "unknown_context_note_fields", path, message: "Unknown context note fields", details: extras });
    const contextId = typeof raw.context_id === "string" ? raw.context_id.trim() : "";
    if (!contextId) issues.push({ code: "context_id", path: `${path}/context_id`, message: "context_id must be non-empty" });
    else contextIds.push(contextId);
    if (!["governing_rule", "aggregate_acceptance", "definition", "record_template", "other_context"].includes(String(raw.role))) {
      issues.push({ code: "context_role", path: `${path}/role`, message: "Context note role is unsupported" });
    }
    if (typeof raw.name !== "string" || !raw.name.trim()) issues.push({ code: "context_name", path: `${path}/name`, message: "Context note name must be non-empty" });
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "context_reason", path: `${path}/reason`, message: "Context note reason must be non-empty" });
    if (!stringArray(raw.evidence_atom_ids) || raw.evidence_atom_ids.length === 0) {
      issues.push({ code: "context_evidence", path: `${path}/evidence_atom_ids`, message: "Every context note must cite at least one document atom" });
      return;
    }
    const contextAtoms = new Set(raw.evidence_atom_ids);
    for (const atomId of contextAtoms) {
      if (!atomById.has(atomId)) issues.push({ code: "unknown_context_atom", path: `${path}/evidence_atom_ids`, message: "Context note cites an unknown atom", details: atomId });
      if (!openedAtomIds.has(atomId)) issues.push({ code: "unopened_context_atom", path: `${path}/evidence_atom_ids`, message: "Context evidence must be opened before validation", details: atomId });
    }
    if (!Array.isArray(raw.evidence_fragments) || raw.evidence_fragments.length === 0) {
      issues.push({ code: "context_fragments", path: `${path}/evidence_fragments`, message: "Every context note must bind exact source fragments" });
      return;
    }
    const fragmentAtoms = new Set<string>();
    raw.evidence_fragments.forEach((fragment, fragmentIndex) => {
      const fragmentPath = `${path}/evidence_fragments/${fragmentIndex}`;
      if (!isRecord(fragment) || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string" || !fragment.text.trim()) {
        issues.push({ code: "context_fragment_type", path: fragmentPath, message: "Context fragment requires atom_id and non-empty exact text" });
        return;
      }
      fragmentAtoms.add(fragment.atom_id);
      const atom = atomById.get(fragment.atom_id);
      if (!contextAtoms.has(fragment.atom_id)) issues.push({ code: "context_fragment_relation", path: fragmentPath, message: "Context fragment atom must be listed in evidence_atom_ids" });
      if (atom && !atom.text.includes(fragment.text)) recordExactFragmentIssue(
        `context:${index}|${fragment.atom_id}|${fragment.text}`,
        "context_fragment_not_exact",
        fragmentPath,
        "evidence_fragments",
        fragment.atom_id,
        fragment.text,
        "Context fragment does not resolve to one unique exact substring of immutable evidence",
      );
    });
    const atomsWithoutFragments = [...contextAtoms].filter((atomId) => !fragmentAtoms.has(atomId));
    if (atomsWithoutFragments.length) issues.push({ code: "context_atom_without_fragment", path: `${path}/evidence_fragments`, message: "Every context atom needs at least one exact source fragment", details: atomsWithoutFragments });
  });
  const repeatedContextIds = duplicateValues(contextIds);
  if (repeatedContextIds.length) issues.push({ code: "duplicate_context_id", path: "/context_notes", message: "context_id values must be unique", details: repeatedContextIds });
  issues.push(...[...exactFragmentIssues.values()].map((entry) => entry.issue));
  const groupNames = new Map<string, string>();
  targets.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.group_id !== "string" || typeof raw.group_name !== "string") return;
    const groupId = raw.group_id.trim();
    const groupName = raw.group_name.trim();
    if (!groupId || !groupName) return;
    const previous = groupNames.get(groupId);
    if (previous !== undefined && previous !== groupName) {
      issues.push({
        code: "inconsistent_target_group",
        path: `/targets/${index}/group_name`,
        message: "The same semantic group_id must use one consistent group_name",
        details: { group_id: groupId, expected: previous, actual: groupName },
      });
    } else groupNames.set(groupId, groupName);
  });

  const knownTargets = new Set(targetIds);
  const dispositions = input.dispositions as unknown[];
  const dispositionIds: string[] = [];
  const targetRelationsFromDispositions = new Map<string, Set<string>>();
  dispositions.forEach((raw, index) => {
    const path = `/dispositions/${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: "disposition_type", path, message: "Disposition must be an object" });
      return;
    }
    const allowed = new Set(["atom_id", "disposition", "target_ids", "reason"]);
    const extras = Object.keys(raw).filter((key) => !allowed.has(key));
    if (extras.length) issues.push({ code: "unknown_disposition_fields", path, message: "Unknown disposition fields", details: extras });
    const atomId = typeof raw.atom_id === "string" ? raw.atom_id : "";
    dispositionIds.push(atomId);
    if (!atomById.has(atomId)) issues.push({ code: "unknown_disposition_atom", path: `${path}/atom_id`, message: "Disposition cites an unknown atom" });
    if (!openedAtomIds.has(atomId)) issues.push({ code: "unopened_document_atom", path: `${path}/atom_id`, message: "Every document atom must be opened before sealing", details: { atom_id: atomId } });
    if (!["target", "context", "irrelevant"].includes(String(raw.disposition))) {
      issues.push({ code: "unreviewed_disposition", path: `${path}/disposition`, message: "Every atom must receive a final Agent disposition" });
    }
    if (!stringArray(raw.target_ids)) {
      issues.push({ code: "disposition_target_ids", path: `${path}/target_ids`, message: "target_ids must be an array" });
      return;
    }
    if (duplicateValues(raw.target_ids).length) issues.push({ code: "duplicate_disposition_target", path: `${path}/target_ids`, message: "Disposition target_ids must be unique" });
    if (raw.disposition === "target" && raw.target_ids.length === 0) issues.push({ code: "target_disposition_empty", path: `${path}/target_ids`, message: "A target disposition must name at least one target" });
    if (raw.disposition !== "target" && raw.target_ids.length !== 0) issues.push({ code: "non_target_disposition_links", path: `${path}/target_ids`, message: "Context/irrelevant atoms cannot name targets" });
    if (typeof raw.reason !== "string" || !raw.reason.trim()) issues.push({ code: "disposition_reason", path: `${path}/reason`, message: "Disposition reason must be non-empty" });
    for (const targetId of raw.target_ids) {
      if (!knownTargets.has(targetId)) issues.push({ code: "unknown_disposition_target", path: `${path}/target_ids`, message: "Disposition names an unknown target", details: targetId });
      const atomIds = targetRelationsFromDispositions.get(targetId) ?? new Set<string>();
      atomIds.add(atomId);
      targetRelationsFromDispositions.set(targetId, atomIds);
    }
  });
  const repeatedDispositionIds = duplicateValues(dispositionIds);
  if (repeatedDispositionIds.length) issues.push({ code: "duplicate_disposition", path: "/dispositions", message: "Every atom must be disposed exactly once", details: repeatedDispositionIds });
  const dispositionSet = new Set(dispositionIds);
  const missing = evidence.atoms.map((atom) => atom.atom_id).filter((atomId) => !dispositionSet.has(atomId));
  if (missing.length) issues.push({ code: "missing_dispositions", path: "/dispositions", message: "Every immutable document atom must be disposed", details: missing });
  for (const [targetId, atomIds] of targetAtomRelations) {
    const related = targetRelationsFromDispositions.get(targetId) ?? new Set<string>();
    const missingRelations = [...atomIds].filter((atomId) => !related.has(atomId));
    const extraRelations = [...related].filter((atomId) => !atomIds.has(atomId));
    if (missingRelations.length || extraRelations.length) issues.push({
      code: "target_disposition_relation",
      path: `/targets/${targetIds.indexOf(targetId)}/evidence_atom_ids`,
      message: "Target evidence and atom dispositions must describe the same exact relation",
      details: { missing_relations: missingRelations, extra_relations: extraRelations },
    });
  }

  if (issues.length) return { ok: false, issues };
  const plan = input as unknown as DocumentTargetPlan;
  const planSha256 = sha256Json(plan);
  return {
    ok: true,
    issues: [],
    plan,
    plan_sha256: planSha256,
    fingerprint: sha256Text(`${evidence.evidence_fingerprint}|${planSha256}`),
  };
}

function encodedSegment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Path segment must not be empty");
  return encodeURIComponent(normalized).replaceAll("%", "_");
}

export class DocumentDiscoveryWorkspace {
  readonly root: string;
  readonly evidencePath: string;
  readonly sourcePath: string;
  readonly workingPlanPath: string;
  readonly workingSelectorPath: string;
  readonly sealedSelectorPath: string;
  readonly sourceSpanRegistryPath: string;
  readonly lastValidPlanPath: string;
  readonly sealedPlanPath: string;
  readonly validationReceiptPath: string;
  readonly lastCompileIssuesPath: string;
  readonly sealReceiptPath: string;
  readonly manifestPath: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  readonly historyDirectory: string;
  readonly validationDirectory: string;
  readonly piSessionDirectory: string;
  readonly reviewerPiSessionDirectory: string;
  readonly ledgerPath: string;
  readonly decisionsPath: string;
  readonly pdfLayoutCatalogPath: string;
  readonly pdfLayoutProfilePath: string;
  readonly pdfLayoutPiSessionDirectory: string;
  private stateTail: Promise<void> = Promise.resolve();

  private constructor(
    public readonly artifactRoot: string,
    public readonly jobId: string,
  ) {
    this.root = join(artifactRoot, "jobs", encodedSegment(jobId), "discovery");
    this.evidencePath = join(this.root, "document-evidence.json");
    this.sourcePath = join(this.root, "source.md");
    this.workingPlanPath = join(this.root, "working.document-target-plan.json");
    this.workingSelectorPath = join(this.root, "working.document-selectors.json");
    this.sealedSelectorPath = join(this.root, "document-selectors.json");
    this.sourceSpanRegistryPath = join(this.root, "source-span-registry.json");
    this.lastValidPlanPath = join(this.root, "last-valid.document-target-plan.json");
    this.sealedPlanPath = join(this.root, "document-target-plan.json");
    this.validationReceiptPath = join(this.root, "validation-receipt.json");
    this.lastCompileIssuesPath = join(this.root, "last-compile-issues.json");
    this.sealReceiptPath = join(this.root, "seal-receipt.json");
    this.manifestPath = join(this.root, "manifest.json");
    this.transcriptPath = join(this.root, "session.events.jsonl");
    this.statePath = join(this.root, "state.json");
    this.historyDirectory = join(this.root, "history");
    this.validationDirectory = join(this.root, "validation");
    this.piSessionDirectory = join(this.root, "pi-session");
    this.reviewerPiSessionDirectory = join(this.root, "reviewer-pi-session");
    this.ledgerPath = join(this.root, "document-ledger.json");
    this.decisionsPath = join(this.root, "discovery-decisions.json");
    this.pdfLayoutCatalogPath = join(this.root, "pdf-layout-catalog.json");
    this.pdfLayoutProfilePath = join(this.root, "pdf-layout-profile.json");
    this.pdfLayoutPiSessionDirectory = join(this.root, "pdf-layout-pi-session");
  }

  private async reconcileTranscriptCheckpoint(): Promise<void> {
    const state = await readJson<DiscoveryState>(this.statePath);
    let lastTranscriptSequence = 0;
    if (await pathExists(this.transcriptPath)) {
      const lines = (await readFile(this.transcriptPath, "utf8")).split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error("Invalid document discovery event transcript");
        }
        const candidate = event as {
          schema_version?: string;
          sequence?: number;
        } | null;
        if (
          candidate === null
          || typeof candidate !== "object"
          || candidate.schema_version !== "document-discovery-event/v1"
          || !Number.isInteger(candidate.sequence)
          || Number(candidate.sequence) < 1
          || (lastTranscriptSequence === 0 && Number(candidate.sequence) !== 1)
          || (
            lastTranscriptSequence > 0
            && Number(candidate.sequence) !== lastTranscriptSequence
            && Number(candidate.sequence) !== lastTranscriptSequence + 1
          )
        ) {
          throw new Error("Invalid document discovery event transcript");
        }
        lastTranscriptSequence = Number(candidate.sequence);
      }
    }
    const transcriptNextEventSequence = lastTranscriptSequence + 1;
    if (
      state.status !== "sealed"
      && transcriptNextEventSequence > state.next_event_sequence
    ) {
      state.next_event_sequence = transcriptNextEventSequence;
      await atomicWriteJson(this.statePath, state);
    }
  }

  static async openOrCreate(
    artifactRoot: string,
    jobId: string,
    markdownPath: string,
  ): Promise<DocumentDiscoveryWorkspace> {
    const workspace = new DocumentDiscoveryWorkspace(artifactRoot, jobId);
    const markdown = await readFile(markdownPath, "utf8");
    const evidence = buildDocumentEvidence(markdown, basename(markdownPath));
    if (await pathExists(workspace.statePath)) {
      const existing = await workspace.readEvidence();
      if (existing.evidence_fingerprint !== evidence.evidence_fingerprint) {
        throw new Error("Persisted discovery evidence does not match the requested Markdown");
      }
      await workspace.reconcileTranscriptCheckpoint();
      await mkdir(workspace.reviewerPiSessionDirectory, { recursive: true });
      await mkdir(workspace.pdfLayoutPiSessionDirectory, { recursive: true });
      if (!(await pathExists(workspace.ledgerPath))) {
        await atomicWriteJson(
          workspace.ledgerPath,
          scanDocumentLedger(markdown, basename(markdownPath)),
        );
      }
      return workspace;
    }
    await mkdir(workspace.root, { recursive: true });
    await mkdir(workspace.historyDirectory);
    await mkdir(workspace.validationDirectory);
    await mkdir(workspace.piSessionDirectory);
    await mkdir(workspace.reviewerPiSessionDirectory);
    await mkdir(workspace.pdfLayoutPiSessionDirectory);
    await atomicWriteNewText(workspace.sourcePath, markdown);
    await atomicWriteNewText(workspace.evidencePath, prettyJson(evidence));
    await makeReadOnly(workspace.sourcePath);
    await makeReadOnly(workspace.evidencePath);
    await atomicWriteJson(workspace.workingPlanPath, initialDocumentTargetPlan(jobId, evidence));
    const registry = registryWithFullSourceSpans(
      evidence.evidence_fingerprint,
      evidence.atoms.map((atom) => ({ source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text })),
    );
    await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
    await atomicWriteJson(
      workspace.workingSelectorPath,
      initialDocumentSelectorPlan(jobId),
    );
    const ledger = scanDocumentLedger(markdown, basename(markdownPath));
    await atomicWriteJson(workspace.ledgerPath, ledger);
    try {
      const prefilled = prefillDocumentSelectorsFromLedger(
        jobId,
        evidence.atoms,
        ledger,
        registry,
      );
      if (prefilled.selectors.targets.length > 0) {
        await atomicWriteJson(workspace.sourceSpanRegistryPath, prefilled.registry);
        await atomicWriteJson(workspace.workingSelectorPath, prefilled.selectors);
      }
    } catch {
      // Prefill is a speed hint; an empty working selector plan remains valid.
    }
    const state: DiscoveryState = {
      schema_version: "document-discovery-state/v2",
      status: "working",
      next_event_sequence: 1,
      next_history_sequence: 1,
      next_validation_sequence: 1,
      validation_attempts: 0,
      reviewer_validation_attempts: 0,
      last_valid_fingerprint: "",
      last_valid_plan_sha256: "",
      last_reviewed_fingerprint: "",
      last_reviewed_plan_sha256: "",
      last_selector_fingerprint: "",
      last_issue_fingerprint: "",
      opened_atom_ids: [],
      reviewer_opened_atom_ids: [],
      reviewer_selector_read_receipts: { targets: {}, contexts: {} },
      selector_protocol: { submissions: 0, corrections: 0, last_issue_fingerprint: "" },
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
      reviewer_runtime: { kind: "unassigned", session_id: "", session_file: "" },
      review_reason: "",
    };
    await atomicWriteJson(workspace.statePath, state);
    return workspace;
  }

  async readLedger(): Promise<DocumentLedger> {
    if (await pathExists(this.ledgerPath)) return ledgerWithCurrentClauseBoundaries(
      await readJson<DocumentLedger>(this.ledgerPath), await readFile(this.sourcePath, "utf8"),
    );
    const markdown = await readFile(this.sourcePath, "utf8");
    const ledger = scanDocumentLedger(markdown, basename(this.sourcePath));
    await atomicWriteJson(this.ledgerPath, ledger);
    return ledger;
  }

  async readEvidence(): Promise<DocumentEvidence> {
    return readJson<DocumentEvidence>(this.evidencePath);
  }

  async readSourceSpanRegistry(): Promise<SourceSpanRegistry> {
    return readJson<SourceSpanRegistry>(this.sourceSpanRegistryPath);
  }

  private async withState<T>(operation: (state: DiscoveryState) => Promise<T> | T): Promise<T> {
    const previous = this.stateTail;
    let release!: () => void;
    this.stateTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await readJson<DiscoveryState>(this.statePath);
      const result = await operation(state);
      await atomicWriteJson(this.statePath, state);
      return result;
    } finally {
      release();
    }
  }

  async readState(): Promise<DiscoveryState> {
    return this.withState((state) => structuredClone(state));
  }

  async setRuntime(runtime: DiscoveryState["agent_runtime"]): Promise<void> {
    await this.withState((state) => { state.agent_runtime = runtime; });
  }

  async setReviewerRuntime(runtime: DiscoveryState["reviewer_runtime"]): Promise<void> {
    await this.withState((state) => { state.reviewer_runtime = runtime; });
  }

  async setSelectorProtocol(protocol: NonNullable<DiscoveryState["selector_protocol"]>): Promise<void> {
    await this.withState((state) => { state.selector_protocol = protocol; });
  }

  async markOpened(atomId: string): Promise<void> {
    await this.withState((state) => {
      if (!state.opened_atom_ids.includes(atomId)) state.opened_atom_ids.push(atomId);
    });
  }

  async markReviewerOpened(atomId: string): Promise<void> {
    await this.withState((state) => {
      state.reviewer_opened_atom_ids ??= [];
      if (!state.reviewer_opened_atom_ids.includes(atomId)) state.reviewer_opened_atom_ids.push(atomId);
    });
  }

  async recordReviewerSelectorReads(
    collection: "targets" | "contexts", rows: readonly unknown[], evidenceFingerprint: string,
  ): Promise<void> {
    if (!rows.length) return;
    await this.withState(state => {
      if (state.status !== "candidate" || state.reviewer_runtime.kind !== "pi-sdk") return;
      const receipts = state.reviewer_selector_read_receipts ??= { targets: {}, contexts: {} };
      for (const row of rows) {
        if (isRecord(row) && typeof row.key === "string") {
          Object.defineProperty(receipts[collection], row.key, {
            value: sha256Json({ evidenceFingerprint, collection, row }), enumerable: true, configurable: true, writable: true,
          });
        }
      }
    });
  }

  async recordReviewerJudgments(entries: Array<{ collection: DiscoveryReviewCollection; key: string; checkpoint: DiscoveryReviewCheckpoint }>): Promise<void> {
    await this.withState(state => {
      if (state.status !== "candidate" || state.reviewer_runtime.kind !== "pi-sdk") throw new Error("Independent reviewer checkpoint is unavailable");
      const receipts = state.reviewer_semantic_review_receipts ??= { targets: {}, contexts: {} };
      for (const entry of entries) Object.defineProperty(receipts[entry.collection], entry.key, {
        value: entry.checkpoint, enumerable: true, configurable: true, writable: true,
      });
    });
  }

  async appendEvent(eventType: string, payload: unknown): Promise<void> {
    await this.withState(async (state) => {
      await appendText(this.transcriptPath, `${JSON.stringify({
        schema_version: "document-discovery-event/v1",
        sequence: state.next_event_sequence,
        timestamp: new Date().toISOString(),
        runtime: state.status === "candidate" && state.reviewer_runtime?.kind !== "unassigned"
          ? state.reviewer_runtime
          : state.agent_runtime,
        event_type: eventType,
        payload,
      })}\n`);
      state.next_event_sequence += 1;
    });
  }

  async transcriptPrefix(): Promise<{ through_sequence: number; sha256: string; byte_length: number }> {
    const state = await this.readState();
    const bytes = await readFile(this.transcriptPath).catch(() => Buffer.alloc(0));
    return {
      through_sequence: state.next_event_sequence - 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_length: bytes.length,
    };
  }

  async writeWorkingPlan(content: string): Promise<void> {
    const state = await this.readState();
    if (state.status === "sealed" || await pathExists(this.manifestPath)) {
      throw new Error("Document discovery is already sealed");
    }
    await atomicWriteText(this.workingPlanPath, content);
  }

  async markOpenedMany(atomIds: string[]): Promise<void> {
    await this.withState((state) => {
      const target = state.status === "candidate" ? state.reviewer_opened_atom_ids : state.opened_atom_ids;
      for (const atomId of atomIds) if (!target.includes(atomId)) target.push(atomId);
    });
  }

  async writeWorkingSelectors(content: string): Promise<void> {
    const state = await this.readState();
    if (state.status === "sealed" || await pathExists(this.manifestPath)) {
      throw new Error("Document discovery is already sealed");
    }
    await atomicWriteText(this.workingSelectorPath, content);
  }

  async recordHistory(before: unknown, after: unknown, operation: unknown): Promise<void> {
    await this.withState(async (state) => {
      const sequence = state.next_history_sequence++;
      await atomicWriteJson(join(this.historyDirectory, `${String(sequence).padStart(6, "0")}.json`), {
        schema_version: "document-discovery-history/v1",
        before_sha256: sha256Json(before),
        after_sha256: sha256Json(after),
        operation,
      });
    });
  }

  async recordValidation(
    validation: DocumentPlanValidation,
    phase: DocumentDiscoveryPhase,
  ): Promise<void> {
    await this.withState(async (state) => {
      const sequence = state.next_validation_sequence++;
      if (phase === "review") {
        state.reviewer_validation_attempts = (state.reviewer_validation_attempts ?? 0) + 1;
      } else {
        state.validation_attempts += 1;
      }
      if (validation.ok) {
        if (phase === "review") {
          state.last_reviewed_fingerprint = validation.fingerprint!;
          state.last_reviewed_plan_sha256 = validation.plan_sha256!;
        } else {
          state.last_valid_fingerprint = validation.fingerprint!;
          state.last_valid_plan_sha256 = validation.plan_sha256!;
        }
      }
      await atomicWriteJson(join(this.validationDirectory, `${String(sequence).padStart(6, "0")}.json`), validation);
      await atomicWriteJson(this.validationReceiptPath, validation);
      if (validation.ok) await atomicWriteJson(this.lastValidPlanPath, validation.plan);
    });
  }

  async recordSelectorOutcome(selectorFingerprint: string, issueFingerprint: string): Promise<boolean> {
    return this.withState((state) => {
      const repeated = Boolean(issueFingerprint)
        && state.last_selector_fingerprint === selectorFingerprint
        && state.last_issue_fingerprint === issueFingerprint;
      state.last_selector_fingerprint = selectorFingerprint;
      state.last_issue_fingerprint = issueFingerprint;
      return repeated;
    });
  }

  async recordLastCompileIssues(ok: boolean, issues: DocumentPlanIssue[] = []): Promise<void> {
    await atomicWriteJson(this.lastCompileIssuesPath, {
      schema_version: "last-compile-issues/v1",
      ok,
      ...(ok ? {} : { issues }),
    });
  }

  async markSealed(): Promise<void> {
    await this.withState((state) => { state.status = "sealed"; });
  }

  async resumeAuthorDiscovery(): Promise<void> {
    const previous = await this.readState();
    if (previous.status !== "candidate") return;
    await this.withState(state => { state.status = "working"; });
    await this.appendEvent("discovery_author_resumed", {
      reason: "independent_discovery_review_removed", accepted_selectors_preserved: true,
      historical_review_checkpoints_preserved: true,
    });
  }

  async reopenForDiscoveryRepair(reason: string): Promise<string> {
    return this.reopenForIndependentReview(reason, "scope_repair", "author");
  }

  async markCandidate(): Promise<void> {
    await this.withState(async (state) => {
      // A new independent review must not inherit earlier semantic exclusions.
      await atomicWriteJson(this.decisionsPath, []);
      state.schema_version = "document-discovery-state/v2";
      state.status = "candidate";
      state.pending_draft_epoch = randomUUID();
      state.reviewer_opened_atom_ids = [];
      state.reviewer_selector_read_receipts = { targets: {}, contexts: {} };
      state.reviewer_semantic_review_receipts = { targets: {}, contexts: {} };
      state.reviewer_validation_attempts = 0;
      state.last_reviewed_fingerprint = "";
      state.last_reviewed_plan_sha256 = "";
      state.selector_protocol = { submissions: 0, corrections: 0, last_issue_fingerprint: "" };
      state.reviewer_runtime = { kind: "unassigned", session_id: "", session_file: "" };
    });
  }

  async reopenForIndependentReview(reason: string, mode: "scope_repair" | "semantic_reclassification" = "scope_repair", owner: "review" | "author" = "review"): Promise<string> {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("A review-reopen reason is required");
    const state = await this.readState();
    if (
      state.status !== "sealed"
      || !(await pathExists(this.sealedPlanPath))
      || !(await pathExists(this.manifestPath))
      || !(await pathExists(this.sealReceiptPath))
    ) {
      throw new Error("Only a completely sealed discovery may be reopened for independent review");
    }

    const archive = join(
      this.root,
      "review-history",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    await mkdir(archive, { recursive: true });
    const sealedPlan = await readJson<DocumentTargetPlan>(this.sealedPlanPath);
    const selectorBeforeRepair = await readJson<DocumentSelectorPlan>(this.workingSelectorPath);
    await atomicWriteJson(join(this.root, "scope-repair-guard.json"), {
      schema_version: "scope-repair-guard/v1",
      review_mode: mode,
      required_targets: mode === "scope_repair" ? selectorBeforeRepair.targets.map((target) => ({ key: target.key, name: target.name })) : [],
      instruction: mode === "scope_repair" ? "本轮只迁移和修订已存在目标的来源边界；不得通过删除或改 key 绕过范围冲突。" : "本轮核对目标成立性，允许按原文将伪目标归为 context、合并或拆分，并重新验证全部处置。",
    });
    for (const path of [
      this.statePath,
      this.workingPlanPath,
      this.workingSelectorPath,
      this.sourceSpanRegistryPath,
      this.lastValidPlanPath,
      this.validationReceiptPath,
      this.decisionsPath,
    ]) {
      if (await pathExists(path)) await copyFile(path, join(archive, basename(path)));
    }
    await chmod(this.workingPlanPath, 0o644);
    if (await pathExists(this.workingSelectorPath)) await chmod(this.workingSelectorPath, 0o644);
    if (await pathExists(this.sourceSpanRegistryPath)) await chmod(this.sourceSpanRegistryPath, 0o644);
    await atomicWriteJson(this.workingPlanPath, sealedPlan);
    for (const path of [this.sealedPlanPath, this.sealedSelectorPath, this.sealReceiptPath, this.manifestPath]) {
      await rename(path, join(archive, basename(path)));
    }
    if (owner === "review") await this.markCandidate();
    else await this.withState(current => { current.status = "working"; current.pending_draft_epoch = randomUUID(); });
    await this.withState((current) => {
      current.review_reason = normalizedReason;
    });
    await this.appendEvent(owner === "review" ? "discovery_review_reopened" : "discovery_author_reopened", {
      reason: normalizedReason,
      archived_seal: archive,
      prior_plan_sha256: sha256Json(sealedPlan),
    });
    return archive;
  }
}

interface DiscoveryToolResponse {
  ok: boolean;
  [key: string]: unknown;
}

export class DocumentDiscoveryController {
  private constructor(
    public readonly workspace: DocumentDiscoveryWorkspace,
    public readonly evidence: DocumentEvidence,
    public readonly phase: DocumentDiscoveryPhase,
  ) {}

  static async create(
    workspace: DocumentDiscoveryWorkspace,
    phase: DocumentDiscoveryPhase = "candidate",
  ): Promise<DocumentDiscoveryController> {
    return new DocumentDiscoveryController(workspace, await workspace.readEvidence(), phase);
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
    toolCallId: string = randomUUID(),
  ): Promise<DiscoveryToolResponse> {
    await this.workspace.appendEvent("tool_execution_start", { tool_call_id: toolCallId, tool: name, input });
    let output: DiscoveryToolResponse;
    try {
      const pendingGuard = ["submit_document_selectors", "correct_document_selectors", "replace_document_selectors",
        "patch_document_selectors", "compile_document_selectors", "submit_discovery_candidate", "seal_discovery_plan",
        "replace_discovery_plan", "patch_discovery_plan", "validate_discovery_plan"].includes(name)
        ? await this.pendingTransactionGuard() : undefined;
      if (pendingGuard) output = pendingGuard;
      else if (name === "get_document_selector_contract") output = await this.contract();
      else if (name === "read_scope_conflicts") {
        const file = join(this.workspace.root, "scope-conflicts.json");
        const packet = await pathExists(file) ? await readJson<{ conflicts: Record<string, unknown>[] }>(file) : { conflicts: [] };
        const cursor = Number(input.cursor ?? 0);
        if (!Number.isInteger(cursor) || cursor < 0) output = { ok: false, error: "invalid_scope_conflict_cursor", actual: input.cursor, writable_path: "cursor", next_tool: "read_scope_conflicts", instruction: "cursor 必须是非负整数，从 0 开始；不要修改已封存原文。" };
        else output = { ok: true, conflicts: packet.conflicts.slice(cursor, cursor + 1), next_cursor: cursor + 1 < packet.conflicts.length ? cursor + 1 : null, instruction: "逐项核对来源冲突。使用 patch_document_selectors 修订主范围、参考或锚点，然后 compile_document_selectors；不要改下游 evidence。" };
      }
      else if (name === "get_discovery_contract") output = await this.contract();
      else if (name === "list_document_atoms") output = await this.listAtoms(input);
      else if (name === "open_document_atom") output = await this.openAtom(String(input.atom_id ?? ""));
      else if (name === "batch_open_document_atoms") output = await this.batchOpenAtoms(input.atom_ids);
      else if (name === "search_document") output = this.search(String(input.query ?? ""));
      else if (name === "batch_search_document") output = this.batchSearch(input.queries);
      else if (name === "locate_document_span") output = await this.locateDocumentSpan(
        String(input.atom_id ?? ""),
        String(input.quote ?? ""),
        String(input.prefix ?? ""),
        String(input.suffix ?? ""),
      );
      else if (name === "batch_locate_document_spans") output = await this.batchLocateDocumentSpans(input.requests);
      else if (name === "read_document_selectors") output = await this.readSelectors(input);
      else if (name === "read_discovery_obligations") output = await this.readDiscoveryObligations(input);
      else if (name === "read_discovery_review_progress") output = await this.readReviewProgress(input);
      else if (name === "record_discovery_review") output = await this.recordReview(input.reviews);
      else if (name === "record_discovery_decisions") output = await this.recordDiscoveryDecisions(input.decisions);
      else if (name === "submit_document_selectors") output = await this.submitSelectorTransaction(String(input.content ?? ""), false);
      else if (name === "correct_document_selectors") output = await this.submitSelectorTransaction(String(input.content ?? ""), true);
      else if (name === "replace_document_selectors") output = await this.replaceSelectors(String(input.content ?? ""));
      else if (name === "patch_document_selectors") output = await this.patchSelectors(input.operations as JsonPatchOperation[]);
      else if (name === "edit_document_selectors") output = await this.editSelectors(input.edits, input);
      else if (name === "discard_document_selector_draft") output = await this.discardPendingTransaction(input.draft_id);
      else if (name === "compile_document_selectors") output = await this.validatePlan();
      // Internal scripted-test compatibility only. These operations are intentionally
      // absent from createDocumentDiscoveryTools and therefore unreachable by the Agent.
      else if (name === "replace_discovery_plan") output = await this.replaceLegacyPlan(String(input.content ?? ""));
      else if (name === "patch_discovery_plan") output = await this.patchLegacyPlan(input.operations as JsonPatchOperation[]);
      else if (name === "validate_discovery_plan") output = await this.validateLegacyPlan();
      else if (name === "submit_discovery_candidate") {
        output = this.phase === "candidate"
          ? await this.submitCandidate(String(input.fingerprint ?? ""))
          : toolReject({
            error: "discovery_phase_forbidden",
            instruction: "This independent review session can seal_discovery_plan, not submit_discovery_candidate.",
            actual_phase: this.phase,
          });
      }
      else if (name === "seal_discovery_plan") output = await this.sealPlan(String(input.fingerprint ?? ""));
      else output = toolReject({
        error: "unknown_discovery_tool",
        instruction: "Use a tool listed by get_document_selector_contract. Do not invent tool names.",
        actual_tool: name,
        candidate_read_tool: "get_document_selector_contract",
      });
    } catch (error) {
      const acceptedReadArguments = name === "read_document_selectors"
        ? Object.fromEntries(Object.entries(input).filter(([key, value]) =>
            ["collection", "key", "view", "cursor", "limit"].includes(key) && value !== ""))
        : {};
      output = error instanceof DiscoveryPendingDraftError
        ? toolReject({ error: error.code, actual: error.actual, saved: false,
            writable_path: "draft_id", next_tool: "read_document_selectors", next_tool_arguments: acceptedReadArguments,
            instruction: "This draft is unavailable for the current phase or accepted checkpoint. Omit draft_id entirely (do not send an empty string or 'accepted') and call read_document_selectors with next_tool_arguments to read accepted records. Rebase only the intended changes; do not edit pending files, source evidence or compiled output.",
            ...error.recovery })
        : name === "edit_document_selectors" && error instanceof SourceSpanRegistryError
        ? { ok: false, error: "discovery_source_binding_rejected", saved: false, issues: error.issues,
            ...(input.draft_id ? { draft_id: input.draft_id, draft_retained: true } : {}),
            instruction: input.draft_id
              ? "Repair source_bindings using the returned coordinates and read tools, then retry only this delta with the same draft_id. The prior pending draft, accepted selectors and registry were not changed."
              : "Repair source_bindings using the returned coordinates and read tools, then retry the complete transaction. Neither selectors nor registry were changed; no new pending draft could be resolved." }
        : catchToolReject(error, "discovery_tool_rejected");
    }
    await this.workspace.appendEvent("tool_execution_end", { tool_call_id: toolCallId, tool: name, output });
    return output;
  }

  private async contract(): Promise<DiscoveryToolResponse> {
    const registry = await this.workspace.readSourceSpanRegistry();
    const ledger = await this.workspace.readLedger();
    const reviewGuardPath = join(this.workspace.root, "scope-repair-guard.json");
    const reviewGuard = await pathExists(reviewGuardPath)
      ? await readJson<{ review_mode?: string }>(reviewGuardPath)
      : undefined;
    const workingPlan = await readJson<DocumentTargetPlan>(this.workspace.workingPlanPath).catch(() => undefined);
    const agreement = workingPlan
      ? evaluateDiscoveryLedgerAgreement(workingPlan, ledger, this.evidence.atoms)
      : undefined;
    return {
      ok: true,
      source_document: { markdown_file_name: this.evidence.source.file_name,
        instruction: "文件名仅供资料导航和区分；标准身份、版本与验收依据以原文为准。" },
      review_mode: reviewGuard ? reviewGuard.review_mode ?? "scope_repair" : "full_discovery",
      scope_revision: (await this.workspace.readState()).review_reason || null,
      authority: "不可变原文是引用依据。目标范围由发现 Agent 阅读 Markdown、PDF 版式及前后语义后明确提交；目录、编号、标题层级和底账只提供候选信号，程序不会据此猜业务边界。source_blocks 为每个连续主资料块提交锚点、起点和明确终点，Harness 按坐标物化其中完整 primary，无需逐段重复 locate：可靠标题结构用 heading_section，无标题、OCR 损坏或独立表格用 explicit_range。scope_span_ids 仅保留说明选择的最小精确来源且必须位于块内；reference_span_ids 只放共享或引用参考，不扩大 primary。每个不连续主资料块都要有自己的 source block。",
      selector_schema_version: DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
      json_schema: DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA,
      atom_count: this.evidence.atoms.length,
      blank_plan: initialDocumentSelectorPlan(this.workspace.jobId),
      document_ledger: {
        schema_version: ledger.schema_version,
        clause_count: ledger.clauses.length,
        extractable_clause_ids: extractableClauseIds(ledger),
        windows: discoveryScopeWindows(ledger).map((window) => ({
          window_id: window.window_id,
          number: window.number,
          title: window.title,
          start_line: window.start_line,
          end_exclusive_line: window.end_exclusive_line,
          ignored: window.ignored,
          extractable_clause_ids: window.extractable_clause_ids,
        })),
        anomalies: ledger.anomalies,
        record_tables: ledger.record_tables.map((table) => ({
          table_no: table.table_no,
          title: table.title,
          caption_line: table.caption_line,
        })),
      },
      ledger_agreement: agreement
        ? {
            structural_agreement: agreement.skip_reviewer,
            independent_review_scheduled: this.phase === "review",
            uncovered_clause_ids: agreement.uncovered_clause_ids,
            unclaimed_candidate_clause_ids: agreement.unclaimed_candidate_clause_ids,
            overlapping_clause_ids: agreement.overlapping_clause_ids,
            conflict_atom_ids: agreement.conflict_atom_ids,
          }
        : undefined,
      full_atom_spans: fullAtomSpans(registry, this.evidence.atoms).map((span) => ({
        atom_id: span.atom_id,
        span_id: span.span_id,
      })),
      rules: [
        "Working targets may be seeded from ledger patterns, but contexts and atom dispositions are deliberately unassigned. Review source semantics before confirming, adding, merging or splitting targets and assigning dispositions. A missing candidate never means irrelevant.",
        "Reconcile every clause that has 检查数量/检验数量 or 主控/一般栏目 with the candidate targets. These are priority hints, not the only content to review. Requirements without those patterns must also be considered before assigning any atom its final disposition.",
        "A target must be a concrete inspectable work, product, component, installation activity, or test scope whose acceptance meaning can form a real inspection lot and acceptance items.",
        "An inspectable scope remains a target when its own clauses delegate criteria to another clause or table. Bind the scope-defining, sampling, and reference-delegation statements as lot basis, then resolve the imported criteria downstream; do not demote the inspected subject to governing context merely because its criteria are referenced.",
        "Rules about organization, qualifications, records, self-inspection, generic process control, how other items are classified or sampled, aggregate division acceptance, rework/nonconformity handling, definitions, and blank record forms are context_notes, never synthetic targets or inspection lots.",
        "Keep a discovered potentially shared criterion, method, sampling rule, condition or exception as a governing_rule context with exact spans, a name and a reason, even if its atom is already owned by a target. These existing context records form downstream read-only candidate navigation, not predetermined applicability. Do not leave the only clue in an atom disposition summary. Explicit target references still use reference_span_ids; no extra full-document review is required.",
        "Format priors (clause numbers, 主控/一般, 检查数量, appendix record-table captions) are available through the ledger and may be used to propose windows. They are not a substitute for ledger reconciliation; if the ledger and source disagree, record an anomaly rather than guessing from keywords.",
        "Every target/context source fact uses registered span IDs. Prefer edit_document_selectors.source_bindings with explicitly read physical line ranges and $key aliases in span fields; extent=clause registers the complete physical clause at start_line. For finer excerpts use locate_document_span. The compiler generates IDs, exact fragments, atom IDs and description; neither coordinates nor clause membership decide business meaning.",
        "Pending transaction recovery: copy the returned short draft_id exactly. A bad handle returns the current recoverable handle only when workspace, document, phase and accepted checkpoint match. Do not restart or regenerate; read pending records and repair only deltas. A retained draft blocks new edits without draft_id, patch and finalization. To intentionally abandon ALL pending changes, call discard_document_selector_draft(draft_id); it never changes accepted records. Default reads explicitly distinguish accepted records from pending changes.",
        "Every target must submit source_blocks at creation time. Each block has anchor_span_id, start_span_id, exactly one of end_span_id/end_before_span_id, and a semantic reason. A $binding used as anchor_span_id resolves to its first non-empty physical line while start/end and span arrays keep the complete selected range. An adjacent selected anchor is mechanically included at the block start. heading_section is an Agent judgment, not a numbering regex; use explicit_range when heading structure is unreliable.",
        "Every atom already has a harness-registered full-atom span; use its span_id (exposed as full_atom_span_id by list_document_atoms and full_atom_spans here) for that atom's disposition. Never quote an entire atom to register a disposition span.",
        "Quotes passed to locate_document_span must be character-exact excerpts of the opened atom text. Whitespace/newlines and markdown syntax characters are ignored by the matcher, but every other character must match exactly; when a quote is rejected, reopen the atom and copy the exact sentence instead of rephrasing.",
        "Assign every target a semantic group key/name/reason only to partition extraction work; compiler IDs are not editor hierarchy authority.",
        "Do not create a common/general semantic group merely to hold context_notes. Context may share the same physical atom with real targets.",
        "Every atom must receive exactly one final target/context/irrelevant disposition. target_keys are a compatibility mirror that the Harness deterministically reconciles from compiled primary evidence; submit [] for new dispositions instead of manually maintaining target relations. If an atom loses its last target, the LLM must still read it and choose context or irrelevant.",
        "Prefer edit_document_selectors to upsert/update/remove by stable wrapper key (atom_span_id for dispositions). For upsert, do not duplicate key inside value; the Harness injects it. Up to 40 related changes and four new target/context records share one preflight and checkpoint. update shallow-merges only changed fields; root fields remain available through patch_document_selectors. dry_run and resolved preflight failures preserve accepted selectors, registry and final-validation budget, while retaining a separate canonical draft_id. Read pending records with read_document_selectors(draft_id, collection, key), repair only changed fields with edit_document_selectors(draft_id, edits), or use edits=[] after successful preflight to revalidate and commit. Never repeat the full payload, carry $aliases across calls, or treat pending spans as accepted. Limits apply to the whole retained transaction. Read current full records before editing and preserve unrelated decisions. read_document_selectors defaults to a compact directory; key or view=full reads the full records.",
        "When repairing existing target errors, a checkpoint may save one complete target repair while unrelated errors remain on unchanged targets, only if the blocking error set strictly shrinks without new errors. Such receipts return final_compile_ready=false with remaining selector_issues; they are draft progress, not permission to submit or seal. Fix related errors together and follow the next_tool/next_tool_arguments before final compilation.",
        ...(this.phase === "review" ? ["Independent reviewers save explicit source-based per-record judgments with record_discovery_review, and resume unfinished keys through read_discovery_review_progress. Reading is not confirmation. Current full record reads and cited original sources are required; unchanged judgments survive sessions, changed records or upstream contexts require reassessment. Confirmed records need no artificial selector edits. These checkpoints do not replace whole-document coverage or final compilation/sealing."] : []),
        "Use disposition=pending for unfinished draft work; checkpoints preserve it, but final compilation requires it to be resolved. read_discovery_obligations lists candidate clauses without complete primary ownership. A context overlap is only a navigation association, not a semantic exclusion. The discovery author must read each such clause and either repair targets or record_discovery_decisions with an evidenced context and reason. These are LLM judgments; ledger patterns do not require a target. Changed context evidence invalidates its earlier decisions. Seal requires no pending obligations.",
        "Every target selects scope and lot-basis spans; cross-atom quotes are split into exact registered spans automatically.",
        "Physical ledger clauses are heuristic navigation ranges too: OCR can attach a following heading to the previous clause, and one clause can contain multiple objects. Global source coverage is the union of exact target primary ranges, not whole-clause ownership by one target. scope_review_hints also reports candidate_clause_split_across_targets; the discovery author must inspect all listed owners and preserve each object's complete acceptance semantics, retaining valid splits. Real missing_ranges and primary overlaps still block sealing. Do not extend a target into its neighbour merely to match a physical clause.",
        "First prove each target using semantic_basis: subject names the concrete inspected object; acceptance_kind is direct_criterion or referenced_criterion; acceptance_span_ids bind exact criteria or this object's delegation statement and must be fully contained by the target's primary source_blocks or reference_span_ids; acceptance_reason explains that evidence; boundary_reason compares adjacent scopes and explains splitting or merging by object, stage or acceptance conditions. Discovery windows are heuristic navigation hints, never maximum execution boundaries. read_discovery_obligations returns scope_review_hints for targets touching multiple candidate windows, including overlapping OCR-derived windows. The discovery author must use the cited source to define its scope; retain a correct target or repair its source_blocks and semantic_basis. Window counts, chapter names and numbering alone never decide merging or splitting.",
        DISCOVERY_SCOPE_SEMANTICS_GUIDANCE,
        "semantic_basis.subject_kind classifies the source subject before target admission: work/product/component/system/installation_activity/test_scope may be targets. generic_inspection_lot/aggregate_acceptance/governing_rule are contexts and rejected as targets. 泛指检验批、分项/分部/单位工程等验收层级不是具体受检对象；不能把抽样定义、所含项目均应合格、资料完整或通用合格比例包装成对象判据。具体工程类别的材料/工序/系统性能及引用委托可成立，无须捏造原文没有的数量、方法或现场实体编号。",
        "Zero targets are valid only with no_target_reason and full source review/dispositions. Never manufacture a target to complete discovery. Unreviewed atoms, missing coverage, or stale fingerprints cannot seal. Independent semantic review is mandatory even when the ledger is complete; examine both target validity and omitted scopes. Selector evidence/registry fingerprints are harness-owned.",
        "Classify the actual obligation, not the chapter name. subject_kind=system includes inspectable software/hardware systems. 管理系统不等于管理规则，标识/记录载体的安装、材质、功能或数据一致性也可以是被检对象。A context block may mix organization or aggregate rules with concrete performance, connectivity, functional tests, or delegated specialist acceptance. Split these components: bind each concrete requirement to a target's primary/lot-basis evidence (or an evidenced existing owner) and retain only governing parts as context. A blanket context disposition over the whole chapter does not establish absence of targets. Review excluded source text for these mixed obligations before sealing.",
      ],
    };
  }

  private async listAtoms(input: Record<string, unknown>): Promise<DiscoveryToolResponse> {
    const cursor = Math.max(0, Number(input.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25) || 25));
    const registry = await this.workspace.readSourceSpanRegistry();
    const fullAtomSpanIds = new Map(
      fullAtomSpans(registry, this.evidence.atoms).map((span) => [span.atom_id, span.span_id]),
    );
    return {
      ok: true,
      atoms: this.evidence.atoms.slice(cursor, cursor + limit).map((atom) => ({
        atom_id: atom.atom_id,
        full_atom_span_id: fullAtomSpanIds.get(atom.atom_id) ?? "",
        start_offset: atom.start_offset,
        end_offset: atom.end_offset,
        start_line: atom.start_line,
        end_line: atom.end_line,
        char_count: atom.text.length,
        preview: atom.text.slice(0, 240).replace(/\s+/g, " "),
      })),
      next_cursor: cursor + limit >= this.evidence.atoms.length ? null : cursor + limit,
    };
  }

  private async openAtom(atomId: string): Promise<DiscoveryToolResponse> {
    const atom = this.evidence.atoms.find((candidate) => candidate.atom_id === atomId);
    if (!atom) {
      return toolReject({
        error: "unknown_document_atom",
        instruction: "Copy an atom_id from list_document_atoms. Do not invent atom ids.",
        actual_atom_id: atomId,
        candidate_read_tool: "list_document_atoms",
      });
    }
    const registry = await this.workspace.readSourceSpanRegistry();
    const response = {
      ok: true,
      atom,
      full_atom_span_id: fullAtomSpans(registry, [atom])[0]!.span_id,
    };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 128 * 1024) {
      return { ok: false, error: "document_atom_payload_exceeds_128kb", atom_id: atomId };
    }
    if (this.phase === "review") await this.workspace.markReviewerOpened(atomId);
    else await this.workspace.markOpened(atomId);
    return response;
  }

  private async batchOpenAtoms(value: unknown): Promise<DiscoveryToolResponse> {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((atomId) => typeof atomId !== "string" || !atomId)) {
      return { ok: false, error: "batch_open_document_atoms_requires_1_to_50_ids" };
    }
    const requested = value as string[];
    if (new Set(requested).size !== requested.length) return { ok: false, error: "batch_open_document_atoms_duplicate_ids" };
    const atoms = requested.map((atomId) => this.evidence.atoms.find((atom) => atom.atom_id === atomId));
    const unknown = requested.filter((_atomId, index) => !atoms[index]);
    if (unknown.length) return { ok: false, error: "unknown_document_atom_ids", atom_ids: unknown };
    const opened: DocumentAtom[] = [];
    let consumed = 0;
    for (const atom of atoms as DocumentAtom[]) {
      const candidate = { ok: true, atoms: [...opened, atom], remaining_atom_ids: requested.slice(consumed + 1) };
      if (Buffer.byteLength(JSON.stringify({ ...candidate, atoms: candidate.atoms.map(discoveryAtomWithLines) }), "utf8") > 128 * 1024) break;
      opened.push(atom);
      consumed += 1;
    }
    if (!opened.length) return { ok: false, error: "batch_open_document_atoms_payload_limit_internal" };
    await this.workspace.markOpenedMany(opened.map((atom) => atom.atom_id));
    return {
      ok: true,
      atoms: opened,
      remaining_atom_ids: requested.slice(consumed),
      truncated: consumed < requested.length,
    };
  }

  private search(query: string): DiscoveryToolResponse {
    const needle = query.trim();
    if (needle.length < 2) return { ok: false, error: "Search query must contain at least two characters" };
    const matches = this.evidence.atoms.flatMap((atom) => {
      const index = atom.text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
      return index < 0 ? [] : [{
        atom_id: atom.atom_id,
        offset_in_atom: index,
        preview: atom.text.slice(Math.max(0, index - 100), index + needle.length + 180),
      }];
    }).slice(0, 30);
    return { ok: true, matches, truncated: matches.length === 30 };
  }

  private batchSearch(value: unknown): DiscoveryToolResponse {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20 || value.some((query) => typeof query !== "string" || query.trim().length < 2)) {
      return { ok: false, error: "batch_search_document_requires_1_to_20_queries" };
    }
    const results: Array<{ query: string; ok: boolean; matches: unknown[]; truncated: boolean }> =
      (value as string[]).map((query) => {
        const searched = this.search(query);
        return {
          query,
          ok: searched.ok,
          matches: Array.isArray(searched.matches) ? searched.matches : [],
          truncated: searched.truncated === true,
        };
      });
    const response: DiscoveryToolResponse = { ok: true, results };
    while (Buffer.byteLength(JSON.stringify(response), "utf8") > 128 * 1024) {
      const largest = [...results].sort((left, right) => right.matches.length - left.matches.length)[0];
      const matches = largest?.matches;
      if (!matches?.length) return { ok: false, error: "batch_search_document_payload_limit_internal" };
      matches.pop();
      response.truncated = true;
    }
    return response;
  }

  private async locateDocumentSpan(
    atomId: string,
    quote: string,
    prefix: string = "",
    suffix: string = "",
  ): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    const opened = this.phase === "review" ? state.reviewer_opened_atom_ids : state.opened_atom_ids;
    let registry = await this.workspace.readSourceSpanRegistry();
    try {
      let spans;
      let normalized = false;
      if (atomId) {
        const atom = this.evidence.atoms.find((candidate) => candidate.atom_id === atomId);
        if (!atom) {
          return toolReject({
            error: "unknown_document_atom",
            instruction: "Copy an atom_id from list_document_atoms. Do not invent atom ids.",
            actual_atom_id: atomId,
            candidate_read_tool: "list_document_atoms",
          });
        }
        if (!opened.includes(atomId)) {
          return toolReject({
            error: "span_atom_not_opened",
            instruction: "Call open_document_atom on this atom_id, then retry locate_document_span with the same quote.",
            atom_id: atomId,
            candidate_read_tool: "open_document_atom",
          });
        }
        const located = locateAndRegisterSourceQuote(
          registry,
          { source_id: atomId, evidence_id: atomId, atom_id: atomId, text: atom.text },
          quote,
          { prefix, suffix },
        );
        registry = located.registry;
        spans = located.spans;
        normalized = located.normalized;
      } else {
        const fullText = this.evidence.atoms.map((atom) => atom.text).join("");
        const allMatches = locateSourceQuote(fullText, quote);
        const matches = prefix || suffix
          ? allMatches.filter((match) =>
              (!prefix || fullText.slice(0, match.start).endsWith(prefix))
              && (!suffix || fullText.slice(match.end).startsWith(suffix)))
          : allMatches;
        if (matches.length !== 1) throw new SourceSpanRegistryError([{
          code: matches.length ? "selector_span_not_unique" : "selector_span_not_found",
          path: "/quote",
          message: "Document quote must have one unique normalized match",
          details: {
            match_count: matches.length,
            quote_match_count: allMatches.length,
            prefix,
            suffix,
            disambiguation_candidates: allMatches.slice(0, 12).map((match) => ({
              start: match.start,
              end: match.end,
              prefix: fullText.slice(Math.max(0, match.start - 48), match.start),
              suffix: fullText.slice(match.end, Math.min(fullText.length, match.end + 48)),
            })),
          },
        }]);
        const match = matches[0]!;
        const selected = [];
        for (const atom of this.evidence.atoms) {
          if (match.end <= atom.start_offset || match.start >= atom.end_offset) continue;
          if (!opened.includes(atom.atom_id)) {
            return toolReject({
              error: "span_atom_not_opened",
              instruction: "Call open_document_atom on this atom_id, then retry locate_document_span with the same quote.",
              atom_id: atom.atom_id,
              candidate_read_tool: "open_document_atom",
            });
          }
          const start = Math.max(0, match.start - atom.start_offset);
          const end = Math.min(atom.text.length, match.end - atom.start_offset);
          const registered = registerSourceSpan(registry, { source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, start, end);
          registry = registered.registry;
          selected.push(registered.span);
        }
        spans = selected;
        normalized = match.normalized;
      }
      await atomicWriteJson(this.workspace.sourceSpanRegistryPath, registry);
      return { ok: true, spans, normalized_match: normalized };
    } catch (error) {
      if (error instanceof SourceSpanRegistryError) {
        const code = error.issues[0]?.code ?? "selector_span_error";
        const issues = error.issues.map((issue) => {
          if (!isRecord(issue.details)) return issue;
          return { ...issue, details: {
            ...issue.details,
            ...(issue.details.next_tool === "locate_evidence_span" ? { next_tool: "locate_document_span" } : {}),
            ...(issue.details.batch_next_tool === "batch_locate_evidence_spans" ? { batch_next_tool: "batch_locate_document_spans" } : {}),
            ...(atomId && isRecord(issue.details.context_read) ? {
              next_tool: "open_document_atom", next_tool_arguments: { atom_id: atomId },
              context_read: { tool: "open_document_atom", arguments: { atom_id: atomId },
                instruction: "重新读取该 atom 的完整原文，核对真实相邻上下文；不可修改原文或编造边界标记。" },
            } : {}),
          } };
        });
        const quoteMatchCount = isRecord(issues[0]?.details) ? Number(issues[0].details.quote_match_count ?? 0) : 0;
        return {
          ok: false,
          error: code,
          issues,
          instruction: isRecord(issues[0]?.details) && isRecord(issues[0].details.context_read)
            && typeof issues[0].details.required_action === "string" ? issues[0].details.required_action
            : code === "selector_span_not_unique"
            ? "The exact quote occurs more than once. Copy prefix/suffix from one returned disambiguation candidate and retry without changing the quote."
            : code === "selector_span_not_found"
              ? quoteMatchCount > 0
                ? "The quote exists in this atom, but the supplied prefix/suffix excludes every match. Keep the quote and copy adjacent prefix/suffix from a returned disambiguation candidate; if the quote has only one match, you may omit both optional context fields. Retry locate_document_span or batch_locate_document_spans."
                : "Quotes must be character-exact excerpts of the opened atom text; whitespace/newlines and markdown syntax characters are ignored, but every other character must match exactly. Reopen the atom and copy the exact sentence, then retry."
              : "Read issues and fix the quote, prefix, or suffix. Do not invent span text.",
        };
      }
      throw error;
    }
  }

  private async batchLocateDocumentSpans(value: unknown): Promise<DiscoveryToolResponse> {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      return { ok: false, error: "batch_locate_document_spans_requires_1_to_100_requests" };
    }
    const requests = value as Array<{ atom_id?: unknown; quote?: unknown; prefix?: unknown; suffix?: unknown }>;
    if (requests.some((request) =>
      !request
      || typeof request.atom_id !== "string"
      || !request.atom_id
      || typeof request.quote !== "string"
      || !request.quote.trim()
      || (request.prefix !== undefined && typeof request.prefix !== "string")
      || (request.suffix !== undefined && typeof request.suffix !== "string")
    )) return {
      ok: false,
      error: "invalid_batch_locate_document_span_request",
      required_shape: { atom_id: "non-empty string", quote: "non-empty exact excerpt", prefix: "optional string", suffix: "optional string" },
      instruction: "Remove malformed requests or replace their fields with the required typed values, then retry the batch.",
    };
    const results = [];
    for (const [index, request] of requests.entries()) {
      results.push({
        index,
        atom_id: request.atom_id,
        ...(await this.locateDocumentSpan(
          request.atom_id as string,
          request.quote as string,
          request.prefix as string | undefined,
          request.suffix as string | undefined,
        )),
      });
    }
    const response = { ok: results.every((result) => result.ok === true), results };
    return Buffer.byteLength(JSON.stringify(response), "utf8") <= 128 * 1024
      ? response
      : { ok: false, error: "batch_locate_document_spans_payload_limit_internal" };
  }

  private async pendingDraft(id: unknown, accepted: DocumentSelectorPlan): Promise<DiscoveryPendingDraft> {
    const state = await this.workspace.readState();
    const current = documentSelectorFingerprint(accepted);
    const pending = await readDiscoveryDraft(this.workspace.root, id,
      state.status === "sealed" || await pathExists(this.workspace.manifestPath) ? undefined : {
        job_id: this.workspace.jobId, evidence_fingerprint: this.evidence.evidence_fingerprint,
        phase: this.phase, phase_epoch: state.pending_draft_epoch ?? "initial", base_selector_fingerprint: current,
      });
    if (state.status === "sealed" || await pathExists(this.workspace.manifestPath)
      || pending.phase !== this.phase || pending.phase_epoch !== (state.pending_draft_epoch ?? "initial")
      || pending.job_id !== this.workspace.jobId || pending.evidence_fingerprint !== this.evidence.evidence_fingerprint) {
      throw new DiscoveryPendingDraftError("selector_draft_scope_mismatch", { phase: pending.phase, current_phase: this.phase, status: state.status });
    }
    if (pending.base_selector_fingerprint !== current) throw new DiscoveryPendingDraftError("selector_draft_base_stale", {
      base_selector_fingerprint: pending.base_selector_fingerprint, current_selector_fingerprint: current,
    });
    if (pending.operations.length > 40
      || Buffer.byteLength(JSON.stringify(pending.operations), "utf8") > 128 * 1024) {
      throw new DiscoveryPendingDraftError("selector_draft_limit_exceeded", { operations: pending.operations.length });
    }
    return pending;
  }

  private async currentPendingTransaction(accepted?: DocumentSelectorPlan) {
    const state = await this.workspace.readState();
    if (state.status === "sealed" || await pathExists(this.workspace.manifestPath)) return undefined;
    return findCurrentDiscoveryDraft(this.workspace.root, {
      job_id: this.workspace.jobId, evidence_fingerprint: this.evidence.evidence_fingerprint,
      phase: this.phase, phase_epoch: state.pending_draft_epoch ?? "initial",
      base_selector_fingerprint: documentSelectorFingerprint(accepted ?? await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath)),
    });
  }

  private async pendingTransactionGuard(accepted?: DocumentSelectorPlan): Promise<DiscoveryToolResponse | undefined> {
    const pending = await this.currentPendingTransaction(accepted);
    if (!pending) return undefined;
    return toolReject({ error: "selector_pending_draft_requires_action", saved: false, draft_retained: true,
      draft_id: pending.draft_id, pending_change_count: pending.draft.operations.length,
      writable_path: "draft_id", next_tool: "read_document_selectors",
      next_tool_arguments: { draft_id: pending.draft_id, collection: "targets" },
      instruction: "An unaccepted transaction is still retained. Nothing from this call was applied. Read the pending records with this draft_id, then use edit_document_selectors with the same draft_id and only repair deltas (edits=[] revalidates and commits). Do not regenerate the unchanged records or compile only the accepted baseline. Only if you intentionally abandon ALL pending changes, call discard_document_selector_draft with this draft_id before starting a new transaction. Accepted selectors and registry are unchanged; do not edit pending files or compiled output." });
  }

  private async discardPendingTransaction(id: unknown): Promise<DiscoveryToolResponse> {
    const accepted = await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const pending = await this.pendingDraft(id, accepted);
    await discardDiscoveryDraft(this.workspace.root);
    return { ok: true, saved: false, draft_retained: false, discarded_change_count: pending.operations.length,
      accepted_selector_fingerprint: documentSelectorFingerprint(accepted), next_tool: "read_document_selectors",
      instruction: "Only the explicitly selected unaccepted transaction was discarded. Accepted selectors, source registry and checkpoint history are unchanged. Read accepted records before starting a new related transaction." };
  }

  private async readSelectors(input: Record<string, unknown>): Promise<DiscoveryToolResponse> {
    const accepted = await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const pending = input.draft_id === undefined || input.draft_id === "" ? undefined : await this.pendingDraft(input.draft_id, accepted);
    const selectors = pending?.selectors ?? accepted;
    const collection = typeof input.collection === "string" ? input.collection : "";
    const key = typeof input.key === "string" ? input.key : "";
    const cursor = Math.max(0, Number(input.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 10) || 10));
    const selector_fingerprint = documentSelectorFingerprint(selectors);
    const retained = pending ? undefined : await this.currentPendingTransaction(accepted);
    const draftReceipt = pending ? { view_source: "pending", draft_id: input.draft_id, draft_retained: true, accepted_selector_fingerprint: pending.base_selector_fingerprint }
      : { view_source: "accepted", ...(retained ? { pending_draft: { draft_id: retained.draft_id, pending_change_count: retained.draft.operations.length },
        instruction: "These are accepted records, not the pending changes. Read the retained draft_id to repair its records; new edits without draft_id are blocked until it is committed or explicitly discarded." } : {}) };
    if (!collection) return { ok: true, selector_fingerprint, ...draftReceipt, summary: { schema_version: selectors.schema_version, no_target_reason: selectors.no_target_reason ?? null, counts: { targets: selectors.targets.length, contexts: selectors.contexts.length, dispositions: selectors.dispositions.length } } };
    const rows = (selectors as unknown as Record<string, unknown>)[collection];
    if (!Array.isArray(rows)) return {
      ok: false,
      error: "unknown_selector_collection",
      collection,
      allowed_collections: ["targets", "contexts", "dispositions"],
      instruction: "Remove the unsupported collection name and choose one allowed collection, or omit collection to read counts.",
    };
    let filtered = key ? rows.filter((row) => row && typeof row === "object"
      && (collection === "dispositions" ? (row as { atom_span_id?: unknown }).atom_span_id : (row as { key?: unknown }).key) === key) : rows.slice(cursor, cursor + limit);
    const full = Boolean(key) || input.view === "full";
    if (!full) filtered = filtered.map((row) => {
      const entry = row as Record<string, unknown>;
      const basis = entry.semantic_basis as Record<string, unknown> | undefined;
      return Object.fromEntries(Object.entries({ key: entry.key, atom_span_id: entry.atom_span_id, name: entry.name,
        group_key: entry.group_key, group_name: entry.group_name, role: entry.role, disposition: entry.disposition,
        target_keys: entry.target_keys, subject: basis?.subject, source_block_count: Array.isArray(entry.source_blocks) ? entry.source_blocks.length : undefined,
      }).filter(([, value]) => value !== undefined));
    });
    let sourceBlockPreviews: Array<ReturnType<typeof discoverySourceBlockPreview>> | undefined;
    if (collection === "targets" && full) {
      const [registry, state] = await Promise.all([this.workspace.readSourceSpanRegistry(), this.workspace.readState()]);
      const effectiveRegistry = pending ? mergeDiscoveryDraftRegistry(registry, pending.registry) : registry;
      const opened = this.phase === "review" ? state.reviewer_opened_atom_ids : state.opened_atom_ids;
      sourceBlockPreviews = (filtered as DocumentSelectorPlan["targets"]).map(target =>
        discoverySourceBlockPreview(target, this.evidence, effectiveRegistry, opened));
    }
    // Shrink pages by actual bytes instead of rejecting a large, otherwise valid read.
    while (filtered.length > 1 && Buffer.byteLength(JSON.stringify({ rows: filtered, source_block_previews: sourceBlockPreviews }), "utf8") > 32 * 1024) {
      filtered.pop(); sourceBlockPreviews?.pop();
    }
    const response = { ok: true, selector_fingerprint, ...draftReceipt, collection, view: full ? "full" : "summary", rows: filtered,
      ...(sourceBlockPreviews ? { source_block_previews: sourceBlockPreviews } : {}),
      next_cursor: key || cursor + filtered.length >= rows.length ? null : cursor + filtered.length };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 128 * 1024) {
      return { ok: false, error: "selector_read_exceeds_128kb", instruction: "Read by key or use a smaller page limit." };
    }
    // Only successful, actually returned full accepted rows count. Pending drafts,
    // directories, author reads and rows removed by the byte bound do not count.
    if (this.phase === "review" && !pending && full && (collection === "targets" || collection === "contexts")) {
      await this.workspace.recordReviewerSelectorReads(collection, filtered, this.evidence.evidence_fingerprint);
    }
    return response;
  }

  private async selectorReviewReadGuard(selectors: DocumentSelectorPlan, retryTool: string): Promise<DiscoveryToolResponse | undefined> {
    if (this.phase !== "review") return undefined;
    const state = await this.workspace.readState();
    // Legacy internal scripted callers do not receive the live reviewer contract.
    if (state.reviewer_runtime.kind !== "pi-sdk") return undefined;
    const receipts = state.reviewer_selector_read_receipts;
    const unread = (collection: "targets" | "contexts") => selectors[collection].filter(row =>
      receipts?.[collection]?.[row.key] !== sha256Json({ evidenceFingerprint: this.evidence.evidence_fingerprint, collection, row })).map(row => row.key);
    const unreadTargets = unread("targets"), unreadContexts = unread("contexts");
    if (!unreadTargets.length && !unreadContexts.length) return undefined;
    const collection = unreadTargets.length ? "targets" : "contexts";
    const key = (unreadTargets.length ? unreadTargets : unreadContexts)[0]!;
    return toolReject({
      error: "discovery_selector_review_reads_required",
      actual: { unread_target_keys: unreadTargets, unread_context_keys: unreadContexts },
      pass_condition: "The independent reviewer must receive every current target and context as a full accepted record, and independently inspect its source and meaning. Summary, author, pending and failed reads do not satisfy this existing review contract.",
      writable_paths: [], budget_consumed: false,
      next_tool: "read_document_selectors", next_tool_arguments: { collection, key, view: "full", limit: 1 },
      retry_tool: retryTool,
      instruction: "Read the listed current record keys with read_document_selectors(collection, key, view=full), or paginate full records using each returned next_cursor. Only records actually returned count. Unchanged full-record reads survive review recovery; edited records must be read again. Do not edit selectors to mark them read. Reading is not semantic approval: compare the full records with their original source, repair real issues, and retain the existing source, coverage and final-validation requirements before sealing.",
    });
  }

  private async readReviewProgress(input: Record<string, unknown>): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    if (this.phase !== "review" || state.status !== "candidate" || state.reviewer_runtime.kind !== "pi-sdk") return toolReject({
      error: "discovery_review_phase_required", actual: { phase: this.phase, status: state.status, runtime: state.reviewer_runtime.kind },
      pass_condition: "Only the live independent reviewer can read or save its semantic checkpoints.", writable_paths: [],
      next_tool: "get_document_selector_contract", instruction: "Candidate authors and scripted callers cannot create independent review authority.",
    });
    const cursor = Number(input.cursor ?? 0), limit = Number(input.limit ?? 20);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return toolReject({
      error: "invalid_discovery_review_cursor", actual: { cursor, limit }, pass_condition: "cursor >= 0; limit between 1 and 100, both integers",
      writable_paths: ["cursor", "limit"], next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0, limit: 20 },
      instruction: "Read this pending-only directory with integer cursor and limit; restart at cursor=0 after recording judgments or editing selectors.",
    });
    const selectors = await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const rows = discoveryReviewRows(selectors, this.evidence.evidence_fingerprint, state.reviewer_semantic_review_receipts);
    const pending = rows.filter(row => row.status !== "confirmed");
    const page = pending.slice(cursor, cursor + limit);
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page), "utf8") > 32 * 1024) page.pop();
    return { ok: true, semantic_approval: false, selector_fingerprint: documentSelectorFingerprint(selectors),
      summary: discoveryReviewSummary(rows), rows: page, remaining: pending.length,
      next_cursor: cursor + page.length < pending.length ? cursor + page.length : null, writable_paths: [],
      next_tool: pending.length ? "read_document_selectors" : "compile_document_selectors",
      ...(pending[cursor] ? { next_tool_arguments: { collection: pending[cursor]!.collection, key: pending[cursor]!.key, view: "full", limit: 1 } } : {}),
      instruction: "These are explicit record judgments, not global approval. Read each current full record and its original source; independently assess object, criterion, shared requirements and split/merge boundaries. Save an evidenced confirmed or needs_revision judgment using record_discovery_review. Repair actual findings through edit_document_selectors, reread the changed record, and reassess it. After saves or edits restart this pending-only directory at cursor=0. Unchanged judgments survive recovery; changed records or upstream contexts require reassessment. Only after all record judgments and whole-document coverage are complete run final compile and seal its returned fingerprint.",
    };
  }

  private async recordReview(input: unknown): Promise<DiscoveryToolResponse> {
    const phaseGuard = await this.readReviewProgress({ limit: 1 });
    if (!phaseGuard.ok) return phaseGuard;
    const reject = (error: string, actual: unknown, next: Record<string, unknown> = {}) => toolReject({
      error, actual, pass_condition: "Submit 1–20 unique current target/context keys, verdict=confirmed|needs_revision, a nonempty independent reason (<=4000 chars), and 1–100 current source_span_ids. Receive each full accepted record and read its cited original source first.",
      writable_paths: ["reviews"], next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0 },
      instruction: "No judgments in this batch were saved. Do not rewrite correct selectors for progress or edit source/state. Use the returned read tool, independently assess the source and current record, then retry the complete bounded judgment batch.", ...next,
    });
    if (!Array.isArray(input) || input.length < 1 || input.length > 20) return reject("invalid_discovery_review_batch", input);
    const [state, selectors, registry] = await Promise.all([this.workspace.readState(), readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath), this.workspace.readSourceSpanRegistry()]);
    const entries: Array<{ collection: DiscoveryReviewCollection; key: string; checkpoint: DiscoveryReviewCheckpoint }> = [];
    const seen = new Set<string>(), opened = new Set(state.reviewer_opened_atom_ids);
    const spans = new Map(registry.spans.map(span => [span.span_id, span])), atoms = new Map(this.evidence.atoms.map(atom => [atom.atom_id, atom]));
    for (const review of input) {
      if (!isRecord(review) || (review.collection !== "targets" && review.collection !== "contexts") || typeof review.key !== "string"
        || (review.verdict !== "confirmed" && review.verdict !== "needs_revision") || typeof review.reason !== "string" || !review.reason.trim() || review.reason.length > 4000
        || !Array.isArray(review.source_span_ids) || !review.source_span_ids.length || review.source_span_ids.length > 100 || review.source_span_ids.some(id => typeof id !== "string")) return reject("invalid_discovery_review_record", review);
      const collection = review.collection, key = review.key, identity = JSON.stringify([collection, key]);
      if (seen.has(identity)) return reject("duplicate_discovery_review_key", { collection, key });
      seen.add(identity);
      const row = selectors[collection].find(record => record.key === key);
      if (!row) return reject("unknown_discovery_review_key", { collection, key });
      if (state.reviewer_selector_read_receipts?.[collection]?.[key] !== sha256Json({ evidenceFingerprint: this.evidence.evidence_fingerprint, collection, row })) return reject("discovery_review_record_unread", { collection, key }, {
        next_tool: "read_document_selectors", next_tool_arguments: { collection, key, view: "full", limit: 1 }, writable_paths: [],
      });
      const rowSpans = discoveryRecordSpanIds(row), cited = [...new Set(review.source_span_ids as string[])];
      if (!cited.some(id => rowSpans.includes(id))) return reject("discovery_review_source_unrelated", { collection, key, source_span_ids: cited, record_span_ids: rowSpans });
      const required = review.verdict === "confirmed" ? [...new Set([...rowSpans, ...cited])] : cited;
      for (const id of required) {
        const span = spans.get(id), atom = span && atoms.get(span.atom_id);
        if (!span || !atom || registry.source_fingerprint !== this.evidence.evidence_fingerprint || !Number.isInteger(span.start) || !Number.isInteger(span.end)
          || span.start < 0 || span.end <= span.start || span.end > atom.text.length || sha256Text(atom.text.slice(span.start, span.end)) !== span.text_sha256) return reject("discovery_review_source_unavailable", { collection, key, span_id: id }, {
            next_tool: "read_document_selectors", next_tool_arguments: { collection, key, view: "full", limit: 1 },
          });
        if (!opened.has(atom.atom_id)) return reject("discovery_review_source_unread", { collection, key, span_id: id, atom_id: atom.atom_id }, {
          next_tool: "open_document_atom", next_tool_arguments: { atom_id: atom.atom_id }, writable_paths: [],
        });
      }
      if (collection === "targets" && review.verdict === "confirmed") {
        const target = row as DocumentSelectorPlan["targets"][number];
        for (const block of discoverySourceBlockPreview(target, this.evidence, registry, [...opened]).source_blocks) {
          const range = "materialized_range" in block ? block.materialized_range : undefined;
          if (!range?.ordered) return reject("discovery_review_boundary_unavailable", { collection, key, block_index: block.block_index }, {
            next_tool: "read_document_selectors", next_tool_arguments: { collection, key, view: "full", limit: 1 },
          });
          const unread = this.evidence.atoms.find(atom => atom.start_offset < range.end_exclusive_offset && atom.end_offset > range.start_offset && !opened.has(atom.atom_id));
          if (unread) return reject("discovery_review_source_unread", { collection, key, atom_id: unread.atom_id }, {
            next_tool: "open_document_atom", next_tool_arguments: { atom_id: unread.atom_id }, writable_paths: [],
          });
        }
      }
      entries.push({ collection, key, checkpoint: { record_fingerprint: discoveryReviewRecordFingerprint(selectors, this.evidence.evidence_fingerprint, collection, row),
        verdict: review.verdict, reason: review.reason.trim(), source_span_ids: cited } });
    }
    await this.workspace.recordReviewerJudgments(entries);
    const progress = await this.readReviewProgress({ limit: 20 });
    return { ...progress, saved_count: entries.length, mutation_status: "saved", next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0 } };
  }

  private async semanticReviewGuard(selectors: DocumentSelectorPlan, retryTool: string): Promise<DiscoveryToolResponse | undefined> {
    const state = await this.workspace.readState();
    if (this.phase !== "review" || state.reviewer_runtime.kind !== "pi-sdk") return undefined;
    const rows = discoveryReviewRows(selectors, this.evidence.evidence_fingerprint, state.reviewer_semantic_review_receipts);
    const unfinished = rows.filter(row => row.status !== "confirmed");
    if (!unfinished.length) return undefined;
    return toolReject({ error: "discovery_semantic_review_incomplete", actual: { summary: discoveryReviewSummary(rows), unfinished: unfinished.slice(0, 20).map(({ collection, key, status }) => ({ collection, key, status })), remaining: unfinished.length },
      pass_condition: "The independent reviewer must explicitly confirm every current target and context after source-based assessment; pending or needs_revision judgments cannot pass. These checkpoints do not replace whole-document coverage, exact source compilation or final validation.",
      writable_paths: [], budget_consumed: false, next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0 }, retry_tool: retryTool,
      instruction: "Resume unfinished keys using the progress directory. Receive current full records, inspect original sources, repair real findings and save per-record judgments through record_discovery_review. Do not infer confirmation from read counts, old public summaries or structural success. Unchanged confirmed records need no artificial selector edits; changed contexts invalidate target judgments. Final validation budget is unchanged and this prerequisite rejection consumes no attempt.",
    });
  }

  private async discoveryCoverage(plan?: DocumentTargetPlan, draft?: DocumentSelectorPlan, draftRegistry?: SourceSpanRegistry) {
    const selectors = draft ?? await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const registry = draftRegistry ?? await this.workspace.readSourceSpanRegistry();
    const ledger = await this.workspace.readLedger();
    const decisions = await pathExists(this.workspace.decisionsPath)
      ? await readJson<DiscoveryDecision[]>(this.workspace.decisionsPath) : [];
    let selectorIssues: import("./document-selector-compiler.js").DocumentSelectorIssue[] = [];
    if (!plan) {
      try {
        const state = await this.workspace.readState();
        plan = compileDocumentSelectors(selectors, registry, this.evidence, this.workspace.jobId, {
          requireSemanticBasis: state.agent_runtime.kind === "pi-sdk" || state.reviewer_runtime.kind === "pi-sdk",
          discoveryScopeCandidates: discoveryScopeWindows(ledger),
        });
      } catch (error) {
        if (!(error instanceof DocumentSelectorCompileError)) throw error;
        // Pending seed proofs must not hide actionable authored errors in the compact receipt.
        const pendingProof = (issue: typeof error.issues[number]) => issue.code === "selector_target_semantic_basis_required"
          && (issue.details as { actual?: unknown })?.actual === null;
        selectorIssues = [...error.issues.filter(issue => !pendingProof(issue)), ...error.issues.filter(pendingProof)];
        // Never credit an older compiled plan after the draft has changed.
        plan = initialDocumentTargetPlan(this.workspace.jobId, this.evidence);
      }
    }
    const obligations = discoveryObligations(plan, selectors, ledger, this.evidence, registry, decisions);
    const agreement = evaluateDiscoveryLedgerAgreement(plan, ledger, this.evidence.atoms,
      obligations.filter(entry => entry.status === "resolved_context").map(entry => entry.clause_id));
    const scopeReviewHints = discoveryScopeReviewHints(plan, selectors, this.evidence, discoveryScopeWindows(ledger), ledger.clauses);
    return { selectors, decisions, obligations, agreement, selector_issues: selectorIssues, scope_review_hints: scopeReviewHints };
  }

  private async readDiscoveryObligations(input: Record<string, unknown>): Promise<DiscoveryToolResponse> {
    const coverage = await this.discoveryCoverage();
    const cursor = Number(input.cursor ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) return toolReject({
      error: "invalid_discovery_obligation_cursor", actual: input.cursor,
      instruction: "Use a non-negative integer cursor, starting at 0, with read_discovery_obligations.",
    });
    return {
      ok: true,
      pending_count: coverage.obligations.filter((entry) => entry.status === "pending").length,
      obligations: coverage.obligations.slice(cursor, cursor + 10),
      scope_review_hint_count: coverage.scope_review_hints.length,
      scope_review_hints: coverage.scope_review_hints.slice(cursor, cursor + 10),
      selector_fingerprint: documentSelectorFingerprint(coverage.selectors),
      next_cursor: cursor + 10 < Math.max(coverage.obligations.length, coverage.scope_review_hints.length) ? cursor + 10 : null,
      selector_issues: coverage.selector_issues.slice(0, 10),
      ledger_agreement: { ...coverage.agreement, anomalies: coverage.agreement.anomalies.slice(0, 10) },
      instruction: "候选信号不决定业务分类。用 open_document_atom 阅读完整条文及上下文：有具体对象则修订 targets；确属 context 时由发现作者调用 record_discovery_decisions 并引用返回的 context key。没有上下文引用时先定位原文并保存 context。scope_review_hints 是来源范围调查线索，不是必须拆分的错误；即使 pending_count 为 0，也须分页阅读并核对这些目标的原文、source_blocks 和 semantic_basis，确认正确或修订后才封存。结构草稿未编译时不计入 target 覆盖；修好后刷新工作项。",
    };
  }

  private async recordDiscoveryDecisions(value: unknown): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    if ((this.phase === "candidate" && state.status !== "working") || (this.phase === "review" && state.status !== "candidate")) return toolReject({
      error: "discovery_decision_phase_forbidden", actual: { phase: this.phase, status: state.status },
      instruction: "Only an active discovery author or legacy reviewer may classify pending source obligations. Sealed source decisions cannot be edited; reopen through the workflow first.",
    });
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) return toolReject({
      error: "invalid_discovery_decisions", actual: value,
      instruction: "record_discovery_decisions accepts 1–20 decisions with clause_id, disposition=pending|context, reason and context_key for context. Read read_discovery_obligations first.",
    });
    const coverage = await this.discoveryCoverage();
    const updated = new Map(coverage.decisions.map((entry) => [entry.clause_id, entry]));
    for (const raw of value) {
      const obligation = isRecord(raw) ? coverage.obligations.find((entry) => entry.clause_id === raw.clause_id) : undefined;
      const context = obligation?.contexts.find((entry) => entry.key === raw.context_key);
      if (!isRecord(raw) || !obligation || !["pending", "context"].includes(String(raw.disposition))
        || typeof raw.reason !== "string" || !raw.reason.trim()
        || (raw.disposition === "context" && !context)) return toolReject({
        error: "invalid_discovery_decision", actual: raw, obligation: obligation ?? null,
        instruction: "Use a current clause_id from read_discovery_obligations, disposition=pending|context and a non-empty reason. A context decision must name one of that clause's context keys; repair selectors first if none exist. Do not edit compiled plans or the ledger.",
        next_tools: ["read_discovery_obligations", "patch_document_selectors", "record_discovery_decisions"],
      });
      const opened = this.phase === "review" ? state.reviewer_opened_atom_ids : state.opened_atom_ids;
      const unopened = obligation.atom_ids.filter((id) => !opened.includes(id));
      if (unopened.length) return toolReject({
        error: "discovery_decision_source_unread", clause_id: obligation.clause_id, unopened_atom_ids: unopened,
        instruction: "Open all listed atoms with open_document_atom or batch_open_document_atoms, read the complete clause and surrounding source, then record the semantic decision. A context reason alone is not source review.",
      });
      updated.set(obligation.clause_id, {
        clause_id: obligation.clause_id, disposition: raw.disposition as DiscoveryDecision["disposition"],
        ...(context ? { context_key: context.key } : {}), reason: raw.reason,
        binding_fingerprint: context?.binding_fingerprint ?? "",
      });
    }
    const decisions = [...updated.values()];
    await atomicWriteJson(this.workspace.decisionsPath, decisions);
    await this.workspace.recordHistory(coverage.decisions, decisions, { type: "discovery_semantic_decisions", decisions: value });
    return { ok: true, saved_count: value.length, next_tool: "read_discovery_obligations" };
  }

  private discoveryClosureReject(obligations: ReturnType<typeof discoveryObligations>, agreement: ReturnType<typeof evaluateDiscoveryLedgerAgreement>): DiscoveryToolResponse | undefined {
    const pending = obligations.filter((entry) => entry.status === "pending");
    if (!pending.length && agreement.complete && !agreement.unclaimed_candidate_clause_ids.length) return undefined;
    return toolReject({
      error: "discovery_coverage_unresolved", pending_count: pending.length,
      pending_clause_ids: pending.map((entry) => entry.clause_id),
      pending_obligations: pending.slice(0, 10),
      ledger_agreement: { ...agreement, anomalies: agreement.anomalies.slice(0, 10) },
      instruction: "最终计划的全局覆盖仍未闭合，不能封存或开始抽取。pending_obligations/missing_ranges 给出所有 target primary 合并后真正缺失的原文坐标和片段；用 read_discovery_obligations 继续分页并打开原文，修订 targets 的 source_blocks、semantic_basis，或由发现作者用 record_discovery_decisions 保存有证据的 context 处置。物理条文可按语义由多个 target 共同覆盖，不要求同一 target 吞入整条粗切范围；发现作者须判断拆分是否保留完整验收语义。真实 primary 重叠仍须消除。pending、仅有 context 标签及旧指纹不算解决；不要制造目标或修改 ledger/编译产物。",
      writable_collections: ["targets", "contexts", "dispositions"],
      next_tools: ["read_discovery_obligations", "open_document_atom", "patch_document_selectors", "record_discovery_decisions", "compile_document_selectors"],
    });
  }

  private async submitSelectorTransaction(content: string, correction: boolean): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    const protocol = state.selector_protocol ?? { submissions: 0, corrections: 0, last_issue_fingerprint: "" };
    if (!correction && protocol.submissions >= 1) {
      return { ok: false, terminal: true, error: "document_selector_initial_submission_already_used" };
    }
    if (correction && (protocol.submissions !== 1 || protocol.corrections >= 1 || !protocol.last_issue_fingerprint)) {
      return { ok: false, terminal: protocol.corrections >= 1, error: "document_selector_correction_not_available" };
    }
    const result = await this.replaceSelectors(content);
    const selectorIssues = Array.isArray(result.selector_issues) ? result.selector_issues : [];
    const nextProtocol = {
      submissions: protocol.submissions + (correction ? 0 : 1),
      corrections: protocol.corrections + (correction ? 1 : 0),
      last_issue_fingerprint: result.ok ? "" : sha256Json(selectorIssues.length ? selectorIssues : result),
    };
    await this.workspace.setSelectorProtocol(nextProtocol);
    return result.ok ? result : { ...result, issue_owner: "selector_input_error" };
  }

  private async replaceSelectors(content: string): Promise<DiscoveryToolResponse> {
    const before = await readJson<unknown>(this.workspace.workingSelectorPath);
    const after = strictJsonParse(content);
    if (Buffer.byteLength(content, "utf8") > 128 * 1024) return { ok: false, error: "selector_replace_exceeds_128kb" };
    await this.workspace.writeWorkingSelectors(prettyJson(after));
    await this.workspace.recordHistory(before, after, { type: "replace_selectors" });
    return { ...(await this.compileSelectors(false)), before_sha256: sha256Json(before), after_sha256: sha256Json(after) };
  }

  private async editSelectors(value: unknown, input: Record<string, unknown> = {}): Promise<DiscoveryToolResponse> {
    if (!Array.isArray(value) || (!value.length && input.draft_id === undefined) || value.length > 40) return toolReject({
      error: "invalid_selector_edits", actual: value,
      instruction: "Use 1–40 related edits within 128KB, at most four new target/context records. With a returned draft_id, send only repair deltas or edits=[] to revalidate and commit the retained transaction. Name collection=targets|contexts|dispositions, a stable wrapper key, op=upsert|update|remove; update supplies changed top-level fields. Limits apply to the entire pending transaction, not each delta.",
    });
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 128 * 1024) return toolReject({ error: "selector_edit_exceeds_128kb", instruction: "Split this transaction into smaller related groups below 128KB; preserve complete source blocks and their disposition relations." });
    const accepted = await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const state = await this.workspace.readState();
    if (state.status === "sealed" || await pathExists(this.workspace.manifestPath)) return toolReject({ error: "discovery_already_sealed", saved: false, instruction: "This discovery is immutable. Create a new job for new discovery; do not mutate sealed selectors, source registry or pending drafts." });
    if (input.draft_id === undefined) {
      const blocked = await this.pendingTransactionGuard(accepted);
      if (blocked) return blocked;
    }
    const pending = input.draft_id !== undefined ? await this.pendingDraft(input.draft_id, accepted) : undefined;
    let authoredDraft: unknown = pending ? applyJsonPatch(accepted, pending.operations) : accepted;
    let draft: unknown = pending?.selectors ?? accepted;
    const originalKeys = new Set(["targets", "contexts"].flatMap(collection =>
      ((accepted as unknown as Record<string, Array<{ key: string }>>)[collection] ?? []).map(row => `${collection}:${row.key}`)));
    const currentFingerprint = documentSelectorFingerprint(draft as DocumentSelectorPlan);
    if (input.expected_selector_fingerprint !== undefined && input.expected_selector_fingerprint !== currentFingerprint) return toolReject({
      error: "selector_edit_stale", actual: input.expected_selector_fingerprint, current: currentFingerprint, saved: false,
      instruction: "Read the current records with read_document_selectors, rebase only your intended changes and retry with the returned selector_fingerprint. Do not overwrite unrelated decisions.",
    });
    const currentRegistry = await this.workspace.readSourceSpanRegistry();
    const registry = pending ? mergeDiscoveryDraftRegistry(currentRegistry, pending.registry) : currentRegistry;
    const binding = bindDiscoverySources((input.source_bindings ?? []) as DiscoverySourceBinding[], this.evidence,
      await this.workspace.readLedger(), new Set(this.phase === "review" ? state.reviewer_opened_atom_ids : state.opened_atom_ids), registry);
    assertDiscoveryAliasReferences(value, binding.aliases);
    for (const [editIndex, raw] of value.entries()) {
      const edit = resolveDiscoveryAliases(raw, binding.aliases) as Record<string, unknown>;
      const collection = isRecord(edit) ? String(edit.collection) : "";
      const keyField = collection === "dispositions" ? "atom_span_id" : "key";
      const rows = isRecord(draft) ? draft[collection] : undefined;
      if (isRecord(edit) && isRecord(edit.value)) {
        const normalizedValue = { ...edit.value };
        // The stable wrapper key is authoritative. Do not make the model copy
        // it into a new record or preserve a generic `key` on dispositions.
        if (collection === "dispositions") delete normalizedValue.key;
        if (edit.op === "upsert" && typeof edit.key === "string" && !(keyField in normalizedValue)) {
          normalizedValue[keyField] = edit.key;
        }
        edit.value = normalizedValue;
      }
      if (!isRecord(edit) || !["targets", "contexts", "dispositions"].includes(collection) || !Array.isArray(rows)
        || typeof edit.key !== "string" || !edit.key.trim() || !["upsert", "update", "remove"].includes(String(edit.op))
        || (edit.op === "upsert" && (!isRecord(edit.value) || edit.value[keyField] !== edit.key))
        || (edit.op === "update" && (!isRecord(edit.value) || (keyField in edit.value && edit.value[keyField] !== edit.key)))) return toolReject({
        error: "invalid_selector_edit", actual: edit,
        instruction: "Use collection=targets|contexts|dispositions and op=upsert|update|remove. The outer wrapper key is authoritative and is injected into a new record (as atom_span_id for dispositions); if the value also supplies that field it must match. update shallow-merges changed fields into exactly one existing record; nested objects/arrays replace that field completely. Read the record before changing it. No edits or bindings were saved.",
      });
      const indexes = rows.flatMap((row, index) => isRecord(row) && row[keyField] === edit.key ? [index] : []);
      if (indexes.length > 1) return toolReject({
        error: "selector_edit_key_not_unique", actual: edit.key, collection, matching_indexes: indexes,
        instruction: "This selector key occurs more than once. Read the current collection and remove the duplicate by exact patch path before retrying. No edits or bindings in this call were saved.",
      });
      if (edit.op !== "upsert" && !indexes.length) return toolReject({
        error: "selector_edit_key_missing", actual: edit.key, collection, matching_indexes: [],
        selector_fingerprint: currentFingerprint, saved: false, durable_mutation: false, budget_consumed: false,
        edit_index: editIndex, matching_basis: "requested_transaction_after_prior_edits", record_count: rows.length,
        expected: "update/remove requires exactly one matching record at this edit, including the effects of earlier edits in the same rejected call",
        writable_paths: [`/edits/${editIndex}/key`, `/edits/${editIndex}/collection`, `/edits/${editIndex}/op`, `/edits/${editIndex}/value`],
        ...(pending ? { draft_id: input.draft_id, draft_retained: true } : {}),
        next_tool: "read_document_selectors",
        next_tool_arguments: { collection, cursor: 0, ...(pending ? { draft_id: input.draft_id } : {}) },
        instruction: "No edits or source bindings in this call were saved; a prior retained draft is unchanged. Read the saved collection directory with next_tool_arguments and follow next_cursor to null. That read shows the accepted or retained baseline before this rejected call, so also check earlier edits in this call for a removal or changed key. Copy the actual key only after identifying the intended record; do not guess keys. Use upsert with a complete record only if source-based semantic review confirms it should be created. Remove this edit only if that review confirms it is stale, preserving real obligations. Preserve the other unexecuted edits and retry the related transaction; with a returned draft_id continue that same draft. Do not edit source evidence, pending files or compiled output.",
      });
      const operation: JsonPatchOperation = edit.op === "remove"
        ? { op: "remove", path: `/${collection}/${indexes[0]}` }
        : { op: indexes.length ? "replace" : "add", path: `/${collection}/${indexes[0] ?? "-"}`,
            value: edit.op === "update" ? { ...(rows[indexes[0]!] as Record<string, unknown>), ...(edit.value as Record<string, unknown>) } : edit.value };
      // Normalization only repairs fields, never record keys or order. Apply the
      // same explicit delta to author intent without counting derived fields as edits.
      const authoredRows = (authoredDraft as Record<string, Array<Record<string, unknown>>>)[collection]!;
      const authoredOperation = edit.op === "update"
        ? { ...operation, value: { ...authoredRows[indexes[0]!], ...(edit.value as Record<string, unknown>) } }
        : operation;
      draft = applyJsonPatch(draft, [operation]);
      authoredDraft = applyJsonPatch(authoredDraft, [authoredOperation]);
    }
    const newRecords = ["targets", "contexts"].flatMap(collection =>
      ((draft as Record<string, Array<{ key: string }>>)[collection] ?? []).filter(row => !originalKeys.has(`${collection}:${row.key}`)));
    if (newRecords.length > 4) return toolReject({ error: "incremental_discovery_checkpoint_required", saved: false,
      new_semantic_records: newRecords.length, instruction: "Create at most four new target/context keys per checkpoint, even when deleting other records. Existing records and related dispositions may be revised together within the 40-edit/128KB transaction limit. No edits or bindings were saved." });
    const operations = discoveryDraftOperations(accepted, authoredDraft as DocumentSelectorPlan);
    const transactionBytes = Buffer.byteLength(JSON.stringify(operations), "utf8");
    if (operations.length > 40 || transactionBytes > 128 * 1024) return toolReject({
      error: "selector_draft_limit_exceeded", saved: false, actual: { operations: operations.length, transaction_bytes: transactionBytes },
      ...(pending ? { draft_id: input.draft_id, draft_retained: true } : {}),
      instruction: "The complete net transaction must fit 40 operations and 128KB. Replacing an already changed record counts once. No delta was retained or accepted. Continue with the returned draft_id and a smaller repair, or explicitly discard_document_selector_draft before starting a smaller transaction from accepted records. Do not split related ownership repairs across invalid checkpoints.",
    });
    const normalizedDraft: { selectors?: DocumentSelectorPlan } = {};
    const result = await this.patchSelectors(operations, { registry: binding.registry, dryRun: input.dry_run === true || operations.length === 0,
      expectedBaseFingerprint: documentSelectorFingerprint(accepted), normalizedDraft });
    if (result.error === "selector_edit_stale") return result;
    const normalizedOperations = discoveryDraftOperations(accepted, normalizedDraft.selectors ?? draft as DocumentSelectorPlan);
    if (normalizedOperations.length === 0) {
      await discardDiscoveryDraft(this.workspace.root);
      return { ...result, saved: false, changed: false, draft_retained: false, dry_run: input.dry_run === true,
        instruction: `No selector changes remain. Accepted selectors, registry and checkpoint history are unchanged; no pending transaction is needed. ${result.instruction ?? ""}`.trim() };
    }
    if (result.saved === true) {
      await discardDiscoveryDraft(this.workspace.root);
      return { ...result, draft_retained: false };
    }
    const draftId = await retainDiscoveryDraft(this.workspace.root, {
      job_id: this.workspace.jobId, evidence_fingerprint: this.evidence.evidence_fingerprint, phase: this.phase,
      phase_epoch: state.pending_draft_epoch ?? "initial", base_selector_fingerprint: documentSelectorFingerprint(accepted),
      operations, selectors: normalizedDraft.selectors ?? draft as DocumentSelectorPlan, registry: binding.registry,
    });
    const firstIssue = Array.isArray(result.selector_issues) && isRecord(result.selector_issues[0]) ? result.selector_issues[0] : undefined;
    const issuePath = firstIssue?.path ?? firstIssue?.writable_path ?? firstIssue?.instancePath;
    const issueLocation = typeof issuePath === "string" ? /^\/(targets|contexts|dispositions)\/(\d+)(?:\/|$)/u.exec(issuePath) : undefined;
    const retainedSelectors = normalizedDraft.selectors ?? draft as DocumentSelectorPlan;
    const issueCollection = issueLocation?.[1] as "targets" | "contexts" | "dispositions" | undefined;
    const issueRow = issueCollection ? retainedSelectors[issueCollection][Number(issueLocation![2])] : undefined;
    const repairArguments = result.next_tool === "read_document_selectors" && isRecord(result.next_tool_arguments)
      ? result.next_tool_arguments
      : issueCollection && issueRow ? { collection: issueCollection, key: issueCollection === "dispositions"
        ? (issueRow as DocumentSelectorPlan["dispositions"][number]).atom_span_id
        : (issueRow as DocumentSelectorPlan["targets"][number]).key }
        : { collection: "targets" };
    return { ...result, saved: false, draft_retained: true, draft_id: draftId,
      accepted_selector_fingerprint: documentSelectorFingerprint(accepted),
      next_tool: result.ok ? "edit_document_selectors" : "read_document_selectors",
      next_tool_arguments: result.ok ? { draft_id: draftId, edits: [] } : { ...repairArguments, draft_id: draftId },
      instruction: `${result.instruction ?? ""} Accepted selectors, registry and checkpoint history are unchanged. The complete transaction is retained in draft_id. Read pending records with read_document_selectors(draft_id, collection, key), then send only corrected fields with edit_document_selectors(draft_id, edits); do not repeat unchanged records or old source_bindings. If preflight succeeded, edits=[] revalidates and commits it. New edits without draft_id are blocked while this draft is pending. Only to abandon ALL pending changes, explicitly call discard_document_selector_draft(draft_id); otherwise continue this draft.`.trim(),
    };
  }

  private async patchSelectors(operations: JsonPatchOperation[], options: { registry?: SourceSpanRegistry; dryRun?: boolean; expectedBaseFingerprint?: string; normalizedDraft?: { selectors?: DocumentSelectorPlan } } = {}): Promise<DiscoveryToolResponse> {
    if (!Array.isArray(operations) || (operations.length === 0 && options.expectedBaseFingerprint === undefined) || operations.length > 40) {
      return { ok: false, error: "Patch must contain 1-40 operations" };
    }
    if (Buffer.byteLength(JSON.stringify(operations), "utf8") > 128 * 1024) return { ok: false, error: "selector_patch_exceeds_128kb" };
    const before = await readJson<unknown>(this.workspace.workingSelectorPath);
    if (options.expectedBaseFingerprint !== undefined && documentSelectorFingerprint(before as DocumentSelectorPlan) !== options.expectedBaseFingerprint) return toolReject({
      error: "selector_edit_stale", saved: false, actual: options.expectedBaseFingerprint, current: documentSelectorFingerprint(before as DocumentSelectorPlan),
      instruction: "Accepted selectors changed while preparing this edit. Nothing was saved. Read current records without draft_id and rebase only the intended changes; do not overwrite another checkpoint.",
    });
    let after: unknown = before;
    for (const [operationIndex, operation] of operations.entries()) {
      try {
        after = applyJsonPatch(after, [operation]);
      } catch (error) {
        const location = /^\/(targets|contexts|dispositions)\/(\d+)(?:\/|$)/u.exec(operation.path);
        const collection = location?.[1];
        const keyField = collection === "dispositions" ? "atom_span_id" : "key";
        const attemptedRows = collection && isRecord(after) ? after[collection] : undefined;
        const attemptedRow = Array.isArray(attemptedRows) ? attemptedRows[Number(location![2])] : undefined;
        const attemptedKey = isRecord(attemptedRow) ? attemptedRow[keyField] : undefined;
        const acceptedRows = collection && isRecord(before) ? before[collection] : undefined;
        const acceptedKeyExists = typeof attemptedKey === "string" && Array.isArray(acceptedRows)
          && acceptedRows.filter(row => isRecord(row) && row[keyField] === attemptedKey).length === 1;
        return catchToolReject(error, "discovery_tool_rejected", {
          saved: false, durable_mutation: false, budget_consumed: false, draft_retained: false,
          actual: { operation_index: operationIndex, op: operation.op, path: operation.path,
            preceding_operations_applied_in_memory: operationIndex, persisted_operations_applied: 0 },
          expected: { allowed_operations: ["add", "replace", "remove"], replace_remove_target_must_exist: true,
            add_parent_must_exist: true, added_fields_must_follow_author_schema: true },
          writable_paths: ["/operations"], ...(collection ? { writable_collection: collection } : {}),
          next_tool: "read_document_selectors", next_tool_arguments: acceptedKeyExists
            ? { collection, key: attemptedKey } : collection ? { collection } : { view: "summary" },
          schema_read: { tool: "get_document_selector_contract", arguments: {} }, retry_tool: "patch_document_selectors",
          required_action: "reread_current_author_records_and_rebase_original_patch",
          instruction: "整笔补丁未保存，前面的操作只作用于内存，没有任何部分落盘。按 next_tool_arguments 读取实际作者记录，再按 schema_read 核对可写字段。replace/remove 的目标必须在该操作执行时存在；确需新增允许字段时由作者选用 add，或用 edit_document_selectors 按稳定 key 更新。add 的父对象仍须存在，不能借此写未知字段。保留原业务 value 和同笔其他待执行操作，依据当前记录重新定位后重提完整意图；数组索引可能受前面增删影响，不能机械改一个数字或重放其他调用已成功的操作。是否保留独立 pending 草稿以最终回条的 draft_retained/draft_id 为准；若已保留则按其恢复入口修订，不把内存修改当作已保存检查点。失败不修改来源登记、不可变原文、编译产物或最终验证预算。",
        });
      }
    }
    if (!Check(DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA, after)) return toolReject({
      error: "document_selector_schema_rejected", saved: false,
      selector_issues: [...Errors(DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA, after)].slice(0, 20).map(issue => {
        const actual = issue.instancePath.split("/").slice(1).reduce<unknown>((value, part) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, after);
        const preview = JSON.stringify(actual ?? null);
        return { ...issue, writable_path: issue.instancePath,
          actual: preview.length <= 1000 ? actual ?? null : { preview: preview.slice(0, 1000), truncated: true } };
      }),
      instruction: "No edits were saved. Fix the returned selector fields using get_document_selector_contract; use edit_document_selectors by stable key to submit all related records together. Do not edit compiled plans.",
    });
    const registry = options.registry ?? await this.workspace.readSourceSpanRegistry();
    const sourceBlockReconciliation = reconcileAdjacentSourceBlockAnchors(after as DocumentSelectorPlan, this.evidence, registry);
    after = sourceBlockReconciliation.selectors;
    if (options.normalizedDraft) options.normalizedDraft.selectors = after as DocumentSelectorPlan;
    const guarded = await this.scopeRepairGuard(after);
    if (guarded) return guarded;
    const bounded = boundedDiscoveryMutation(before, after, "patch", operations);
    if (bounded) return bounded;
    const runtimeState = await this.workspace.readState();
    if (runtimeState.status === "sealed" || await pathExists(this.workspace.manifestPath)) return toolReject({ error: "discovery_already_sealed", saved: false, instruction: "This discovery is immutable. Create a new job for new discovery; do not mutate sealed selectors or source registry." });
    let reconciledDispositionKeys: string[] = [];
    let receipt = { before_sha256: sha256Json(before), after_sha256: sha256Json(after), selector_fingerprint: documentSelectorFingerprint(after as DocumentSelectorPlan), saved: false, dry_run: Boolean(options.dryRun) };
    const save = async (result: DiscoveryToolResponse): Promise<DiscoveryToolResponse> => {
      if (documentSelectorFingerprint(before as DocumentSelectorPlan) === documentSelectorFingerprint(after as DocumentSelectorPlan)) {
        return { ...result, ...receipt, saved: false, changed: false };
      }
      if (!options.dryRun) {
        // Append-only registry is published first: interruption can leave unused spans,
        // never a selector referring to a span that was not durably registered.
        if (options.registry) await atomicWriteJson(this.workspace.sourceSpanRegistryPath,
          mergeDiscoveryDraftRegistry(await this.workspace.readSourceSpanRegistry(), registry));
        await this.workspace.writeWorkingSelectors(prettyJson(after));
        await this.workspace.recordHistory(before, after, { type: "selector_json_patch", operations });
      }
      return { ...result, ...receipt, saved: !options.dryRun,
        changed_paths: [...new Set(operations.map(operation => operation.path))],
        ...(sourceBlockReconciliation.changed_target_keys.length ? { reconciled_source_block_keys: sourceBlockReconciliation.changed_target_keys } : {}),
        ...(reconciledDispositionKeys.length ? { reconciled_disposition_keys: reconciledDispositionKeys } : {}) };
    };
    const ledger = await this.workspace.readLedger();
    const scopeCandidates = discoveryScopeWindows(ledger);
    const compileOptions = {
      requireSemanticBasis: runtimeState.agent_runtime.kind === "pi-sdk" || runtimeState.reviewer_runtime.kind === "pi-sdk",
      discoveryScopeCandidates: scopeCandidates,
    };
    const blockingIssues = (issues: DocumentSelectorCompileError["issues"]) => issues.filter((issue) =>
      issue.code !== "selector_atom_unreviewed" && issue.code !== "selector_zero_targets"
      && issue.code !== "selector_disposition_pending" && issue.code !== "selector_discovery_window_unclassified"
      && !(issue.code === "selector_target_semantic_basis_required" && (issue.details as { actual?: unknown })?.actual === null));
    try {
      const compiled = compileDocumentSelectors(
        after as DocumentSelectorPlan,
        registry,
        this.evidence,
        this.workspace.jobId,
        compileOptions,
      );
      const reconciled = reconcileDocumentSelectorRelations(after as DocumentSelectorPlan, compiled, registry);
      after = reconciled.selectors;
      if (options.normalizedDraft) options.normalizedDraft.selectors = after as DocumentSelectorPlan;
      reconciledDispositionKeys = reconciled.changed_disposition_keys;
      receipt = {
        ...receipt,
        after_sha256: sha256Json(after),
        selector_fingerprint: documentSelectorFingerprint(after as DocumentSelectorPlan),
      };
      const coverage = this.phase === "review" ? await this.discoveryCoverage(compiled, after as DocumentSelectorPlan, registry) : undefined;
      const closure = coverage ? this.discoveryClosureReject(coverage.obligations, coverage.agreement) : undefined;
      return save({
        ok: true,
        stage: "document-selector-checkpoint",
        scope_review_hint_count: discoveryScopeReviewHints(compiled, after as DocumentSelectorPlan, this.evidence, scopeCandidates, ledger.clauses).length,
        final_compile_ready: !closure,
        ...(coverage ? { global_coverage_ready: !closure, pending_clause_count: coverage.obligations.filter(entry => entry.status === "pending").length,
          next_tool: closure ? "read_discovery_obligations" : "compile_document_selectors" } : {}),
        before_sha256: sha256Json(before),
        after_sha256: sha256Json(after),
      });
    } catch (error) {
      if (!(error instanceof DocumentSelectorCompileError)) throw error;
      const localIssues = blockingIssues(error.issues);
      if (localIssues.length) {
        // Whole-plan preflight also reports unrelated old errors. A checkpoint
        // may retain those only when this patch strictly reduces the error set.
        const beforeTargets = Array.isArray((before as { targets?: unknown }).targets)
          ? (before as { targets: Array<Record<string, unknown>> }).targets : [];
        const afterTargets = Array.isArray((after as { targets?: unknown }).targets)
          ? (after as { targets: Array<Record<string, unknown>> }).targets : [];
        const hashByKey = new Map(beforeTargets.map(target => [String(target?.key ?? ""), sha256Json(target)]));
        const unchangedKeys = new Set<string>();
        afterTargets.forEach((target, index) => {
          const key = String(target?.key ?? `#${index}`);
          if (hashByKey.get(key) === sha256Json(target)) unchangedKeys.add(key);
        });
        const targetKeyOfIssue = (issue: { path?: string; details?: { target_key?: unknown } | null }): string | undefined => {
          if (typeof issue.details?.target_key === "string") return issue.details.target_key;
          const match = /^\/targets\/(\d+)(?:\/|$)/u.exec(issue.path ?? "");
          const target = match ? afterTargets[Number(match[1])] : undefined;
          return target && typeof target.key === "string" ? target.key : undefined;
        };
        const annotatedIssues = localIssues.map((issue) => {
          const key = targetKeyOfIssue(issue as { path?: string; details?: { target_key?: unknown } | null });
          return { ...issue, in_this_patch: key === undefined || !unchangedKeys.has(key) };
        });
        const preExistingKeys = [...new Set(annotatedIssues
          .filter(issue => issue.in_this_patch === false)
          .map(issue => targetKeyOfIssue(issue as { path?: string; details?: { target_key?: unknown } | null }))
          .filter((key): key is string => Boolean(key)))];
        if (annotatedIssues.every(issue => issue.in_this_patch === false)) {
          let previousIssues: DocumentSelectorCompileError["issues"] = [];
          try {
            compileDocumentSelectors(before as DocumentSelectorPlan, registry, this.evidence, this.workspace.jobId, compileOptions);
          } catch (previousError) {
            if (!(previousError instanceof DocumentSelectorCompileError)) throw previousError;
            previousIssues = blockingIssues(previousError.issues);
          }
          const previousIssueHashes = new Set(previousIssues.map(issue => sha256Json(issue)));
          if (localIssues.length < previousIssues.length
            && localIssues.every(issue => previousIssueHashes.has(sha256Json(issue)))) {
            return save({
              ok: true,
              stage: "document-selector-checkpoint",
              final_compile_ready: false,
              global_coverage_ready: false,
              previous_issue_count: previousIssues.length,
              remaining_issue_count: localIssues.length,
              selector_issues: annotatedIssues,
              pre_existing_issue_count: localIssues.length,
              pre_existing_target_keys: preExistingKeys,
              next_tool: "read_document_selectors",
              next_tool_arguments: { collection: "targets", key: preExistingKeys[0] },
              instruction: `${options.dryRun ? "Dry-run only; this repair can be saved, but nothing was written." : "Repair progress saved as a draft checkpoint."} Final compilation and sealing are still blocked. Read target ${preExistingKeys[0]} with read_document_selectors, then use edit_document_selectors to fix its related errors together. Each incremental repair must reduce existing errors without adding new ones; remaining errors must belong to unchanged targets. Do not edit source evidence or compiled output.`,
            });
          }
        }
        const preExistingNote = preExistingKeys.length
          ? `本次回条中有未改动的 pre_existing targets: ${preExistingKeys.join("、")}。可先读取 ${preExistingKeys[0]}，在同一事务修复该 target 的全部相关错误；只有错误集合严格缩小、没有新错误且剩余错误全部属于未改动 target 时，分步修复才能保存为草稿。跨记录的关联错误须一起修复。`
          : "";
        const needsDispositionBindingRepair = localIssues.some((issue) =>
          /^\/dispositions\/\d+\/atom_span_id$/u.test(issue.path));
        const dispositionRepair = needsDispositionBindingRepair
          ? {
              allowed_full_atom_spans: fullAtomSpans(
                await this.workspace.readSourceSpanRegistry(),
                this.evidence.atoms,
              ).map((span) => ({ atom_id: span.atom_id, span_id: span.span_id })),
              required_action: "replace_invalid_atom_span_id",
              instruction: "Use the atom_id mapping to replace atom_span_id with its registered full-atom span_id; do not guess or derive span IDs.",
            }
          : {};
        return {
          ok: false,
          stage: "document-selector-checkpoint",
          issue_owner: "selector_input_error",
          selector_issues: annotatedIssues,
          ...dispositionRepair,
          ...receipt,
          ...(preExistingKeys.length ? { pre_existing_issue_count: annotatedIssues.length - annotatedIssues.filter(issue => issue.in_this_patch !== false).length, pre_existing_target_keys: preExistingKeys } : {}),
          instruction: `${dispositionRepair.instruction ?? ""} ${preExistingNote} Preflight rejected this transaction; accepted selectors and registry are unchanged. Repair the returned author-side paths; when draft_id is returned, read and repair that pending draft by key without repeating its unchanged records. Otherwise use read_document_selectors by key and submit the related edits. Do not edit compiled output.`.replace(/\s+/g, " ").trim(),
        };
      }
      return save({
        ok: true,
        stage: "document-selector-checkpoint",
        final_compile_ready: false,
        pending_atom_count: error.issues.filter((issue) => issue.code === "selector_atom_unreviewed").length,
        pending_semantic_target_count: error.issues.filter((issue) => issue.code === "selector_target_semantic_basis_required").length,
        pending_disposition_count: error.issues.filter((issue) => issue.code === "selector_disposition_pending").length,
        pending_window_count: error.issues.filter((issue) => issue.code === "selector_discovery_window_unclassified").length,
        next_tool: "read_discovery_obligations",
        before_sha256: sha256Json(before),
        after_sha256: sha256Json(after),
      });
    }
  }

  private async compileSelectors(finalValidation: boolean): Promise<DiscoveryToolResponse> {
    const stateBeforeValidation = await this.workspace.readState();
    const validationAttempts = this.phase === "review"
      ? stateBeforeValidation.reviewer_validation_attempts ?? 0
      : stateBeforeValidation.validation_attempts;
    if (finalValidation && validationAttempts >= DISCOVERY_FINAL_VALIDATION_ATTEMPT_LIMIT) {
      return toolReject({
        error: "final_validator_attempt_limit",
        instruction: "Stop compiling. The final validator attempt budget is exhausted. Preserve the current selectors and do not retry compile_document_selectors.",
        phase: this.phase,
        attempts_used: validationAttempts,
        max_attempts: DISCOVERY_FINAL_VALIDATION_ATTEMPT_LIMIT,
      });
    }
    let selectors: DocumentSelectorPlan;
    try {
      selectors = strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")) as DocumentSelectorPlan;
    } catch (error) {
      return catchToolReject(error, "invalid_json", {
        selector_issues: [{ code: "invalid_json", path: "", message: error instanceof Error ? error.message : String(error) }],
        instruction: "Fix working document selector JSON. Read actual_error. Empty arrays in the template are starting values, not permission to omit item shape.",
      });
    }
    const guarded = await this.scopeRepairGuard(selectors);
    if (guarded) return guarded;
    const ledger = await this.workspace.readLedger();
    const scopeCandidates = discoveryScopeWindows(ledger);
    let compiled: DocumentTargetPlan;
    try {
      compiled = compileDocumentSelectors(selectors, await this.workspace.readSourceSpanRegistry(), this.evidence, this.workspace.jobId, {
        requireSemanticBasis: stateBeforeValidation.agent_runtime.kind === "pi-sdk" || stateBeforeValidation.reviewer_runtime.kind === "pi-sdk",
        discoveryScopeCandidates: scopeCandidates,
      });
    } catch (error) {
      if (!(error instanceof DocumentSelectorCompileError)) throw error;
      await this.workspace.recordLastCompileIssues(false, error.issues);
      return toolReject({
        error: "document_selector_compile_failed",
        issue_owner: "selector_input_error",
        instruction: "Repair document selectors using selector_issues. Do not patch the compiled target plan.",
        stage: "document-selectors",
        selector_fingerprint: documentSelectorFingerprint(selectors),
        selector_issues: error.issues,
        required_action: "repair_using_returned_issues",
        candidate_read_tool: "read_document_selectors",
      });
    }
    if (finalValidation) {
      const readGuard = await this.selectorReviewReadGuard(selectors, "compile_document_selectors");
      if (readGuard) return readGuard;
      const semanticGuard = await this.semanticReviewGuard(selectors, "compile_document_selectors");
      if (semanticGuard) return semanticGuard;
    }
    await this.workspace.recordLastCompileIssues(true);
    await this.workspace.writeWorkingPlan(prettyJson(compiled));
    if (!finalValidation) return { ok: true, stage: "document-selector-slice", selector_fingerprint: documentSelectorFingerprint(selectors), final_validation: "not_run" };
    const state = await this.workspace.readState();
    const openedAtomIds = this.phase === "review"
      ? new Set(state.reviewer_opened_atom_ids ?? [])
      : new Set(state.opened_atom_ids);
    const validation = validateDocumentTargetPlan(compiled, this.evidence, this.workspace.jobId, openedAtomIds);
    if (validation.ok && (this.phase === "review" || state.agent_runtime.kind === "pi-sdk")) {
      const coverage = await this.discoveryCoverage(compiled);
      const rejection = this.discoveryClosureReject(coverage.obligations, coverage.agreement);
      if (rejection) return rejection;
    }
    await this.workspace.recordValidation(validation, this.phase);
    const selectorFingerprint = documentSelectorFingerprint(selectors);
    const issueFingerprint = validation.ok ? "" : sha256Json(validation.issues.map((issue) => ({ code: issue.code, path: issue.path, details: issue.details ?? null })));
    if (await this.workspace.recordSelectorOutcome(selectorFingerprint, issueFingerprint)) {
      return toolReject({
        error: "non_converging_selector_repeat",
        terminal: true,
        instruction: "The same selector fingerprint produced the same issue set twice. Stop this discovery session and preserve the current selectors.",
        selector_fingerprint: selectorFingerprint,
        issue_fingerprint: issueFingerprint,
      });
    }
    const unreadAtomIds = [...new Set(validation.issues.flatMap(issue =>
      ["unopened_target_atom", "unopened_document_atom"].includes(issue.code)
        && isRecord(issue.details) && typeof issue.details.atom_id === "string"
        ? [issue.details.atom_id] : []))];
    const { plan: _plan, ...validationReceipt } = validation;
    const scopeReviewHintCount = discoveryScopeReviewHints(compiled, selectors, this.evidence, scopeCandidates, ledger.clauses).length;
    return {
      ...validationReceipt,
      ...(validation.ok ? { target_count: compiled.targets.length, context_count: compiled.context_notes.length,
        scope_review_hint_count: scopeReviewHintCount,
        next_tool: "seal_discovery_plan",
        next_tool_arguments: { fingerprint: validation.fingerprint },
        instruction: this.phase === "review"
          ? "The current record judgments, source and whole-document coverage prerequisites passed final compilation. This is a mechanical validation receipt, not a substitute for independent semantic review. Seal exactly this returned fingerprint using next_tool_arguments. Do not restart an unchanged completed record review just to recreate approval; changes require their own reassessment and a new final compilation."
          : "The authored discovery passed source, structure and coverage validation. Seal the exact returned fingerprint using next_tool_arguments. No independent model review is scheduled. This mechanical validation does not claim independent semantic approval." } : {}),
      stage: "compiled-document-target-plan",
      selector_fingerprint: selectorFingerprint,
      ...(validation.ok ? {} : { validation_attempts_remaining: Math.max(0, DISCOVERY_FINAL_VALIDATION_ATTEMPT_LIMIT - validationAttempts - 1) }),
      ...(validation.ok ? {} : unreadAtomIds.length ? {
        actual: { unopened_atom_ids: unreadAtomIds },
        pass_condition: "All listed atoms must be opened in the current discovery phase before final validation can pass.",
        writable_paths: [],
        next_tool: "open_document_atom",
        next_tool_arguments: { atom_id: unreadAtomIds[0] },
        retry_tool: "compile_document_selectors",
        instruction: "Open each actual.unopened_atom_ids entry with open_document_atom and read its source, then retry compile_document_selectors. Reading is recorded by the tool; no selector edit is needed for these unopened-atom issues. Preserve correct selectors and repair any other returned issues separately.",
        required_action: "open_unread_document_atoms_then_recompile",
        candidate_read_tool: "open_document_atom",
      } : {
        instruction: `Repair document selectors using issues. Do not patch the compiled target plan. Final-validation budget remaining: ${Math.max(0, DISCOVERY_FINAL_VALIDATION_ATTEMPT_LIMIT - validationAttempts - 1)}. Verify each repair through checkpoint edits (edit_document_selectors compiles without consuming budget) and read_discovery_obligations first; reserve compile_document_selectors for the single final pass once every returned issue is fixed.`,
        required_action: "repair_using_returned_issues",
        candidate_read_tool: "read_document_selectors",
      }),
    };
  }

  private async validatePlan(): Promise<DiscoveryToolResponse> {
    return this.compileSelectors(true);
  }

  private async scopeRepairGuard(selectors: unknown): Promise<DiscoveryToolResponse | undefined> {
    const path = join(this.workspace.root, "scope-repair-guard.json");
    if (!(await pathExists(path))) return undefined;
    const state = await this.workspace.readState();
    if (!state.review_reason) return undefined;
    const guard = await readJson<{ required_targets?: Array<{ key: string; name: string }> }>(path);
    const actual = selectors && typeof selectors === "object" && Array.isArray((selectors as { targets?: unknown }).targets)
      ? (selectors as { targets: Array<{ key?: unknown }> }).targets
      : [];
    const keys = new Set(actual.map(target => typeof target?.key === "string" ? target.key : ""));
    const missing = (guard.required_targets ?? []).filter(target => !keys.has(target.key));
    if (!missing.length) return undefined;
    return toolReject({
      error: "scope_repair_target_deletion_forbidden",
      instruction: "当前是旧目标范围迁移，只能修订 scope_span_ids/source_blocks/reference_span_ids/lot_basis_span_ids 与理由；恢复被删除或改 key 的目标，再继续修边界。若业务上确需重做目标清单，应启动新的全文发现任务，不能在范围修复中绕过。",
      missing_targets: missing,
      writable_collection: "targets",
      required_action: "restore_required_targets_and_repair_their_source_blocks",
    });
  }

  private async replaceLegacyPlan(content: string): Promise<DiscoveryToolResponse> {
    const before = await readJson<unknown>(this.workspace.workingPlanPath);
    const after = strictJsonParse(content);
    const state = await this.workspace.readState();
    const bounded = this.phase === "candidate" && state.agent_runtime.kind === "offline-scripted"
      ? undefined
      : boundedDiscoveryMutation(before, after, "replace");
    if (bounded) return bounded;
    await this.workspace.writeWorkingPlan(prettyJson(after));
    await this.workspace.recordHistory(before, after, { type: "internal_scripted_plan_replace" });
    return { ok: true, before_sha256: sha256Json(before), after_sha256: sha256Json(after) };
  }

  private async patchLegacyPlan(operations: JsonPatchOperation[]): Promise<DiscoveryToolResponse> {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 40) return { ok: false, error: "Patch must contain 1-40 operations" };
    const before = await readJson<unknown>(this.workspace.workingPlanPath);
    const after = applyJsonPatch(before, operations);
    const state = await this.workspace.readState();
    const bounded = this.phase === "candidate" && state.agent_runtime.kind === "offline-scripted"
      ? undefined
      : boundedDiscoveryMutation(before, after, "patch", operations);
    if (bounded) return bounded;
    await this.workspace.writeWorkingPlan(prettyJson(after));
    await this.workspace.recordHistory(before, after, { type: "internal_scripted_plan_patch", operations });
    return { ok: true, before_sha256: sha256Json(before), after_sha256: sha256Json(after) };
  }

  private async validateLegacyPlan(): Promise<DiscoveryToolResponse> {
    let parsed = strictJsonParse(await readFile(this.workspace.workingPlanPath, "utf8"));
    const migrated = migrateDocumentTargetPlan(parsed, this.evidence);
    const canonicalized = canonicalizeDocumentTargetPlan(migrated, this.evidence);
    if (sha256Json(canonicalized.plan) !== sha256Json(parsed)) {
      await this.workspace.writeWorkingPlan(prettyJson(canonicalized.plan));
      await this.workspace.recordHistory(parsed, canonicalized.plan, { type: "internal_scripted_canonicalization", changes: canonicalized.changes });
      parsed = canonicalized.plan;
    }
    const state = await this.workspace.readState();
    const openedAtomIds = this.phase === "review" ? new Set(state.reviewer_opened_atom_ids ?? []) : new Set(state.opened_atom_ids);
    const validation = validateDocumentTargetPlan(parsed, this.evidence, this.workspace.jobId, openedAtomIds);
    await this.workspace.recordValidation(validation, this.phase);
    return { ...validation };
  }

  private async submitCandidate(fingerprint: string): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    const changed = await this.uncompiledSelectorChange(state);
    if (changed) return changed;
    const plan = await readJson<DocumentTargetPlan>(this.workspace.workingPlanPath);
    const validation = validateDocumentTargetPlan(plan, this.evidence, this.workspace.jobId, new Set(state.opened_atom_ids));
    if (!fingerprint || fingerprint !== state.last_valid_fingerprint) {
      return fingerprintMismatchReject({
        error: "Candidate fingerprint does not match the latest successful validation",
        submitted: fingerprint,
        expected: state.last_valid_fingerprint ?? "",
        validate_tool: "compile_document_selectors",
        ...(validation.ok && validation.fingerprint === state.last_valid_fingerprint
          ? { verified_retry: { tool: "submit_discovery_candidate", arguments: { fingerprint: state.last_valid_fingerprint! } } } : {}),
      });
    }
    if (!validation.ok || validation.fingerprint !== fingerprint) {
      return toolReject({
        error: "Working discovery plan changed after candidate validation",
        instruction: "Re-run compile_document_selectors. Repair using the returned issues, then submit the new fingerprint.",
        issues: validation.issues,
        candidate_read_tool: "compile_document_selectors",
        required_action: "repair_using_returned_issues",
      });
    }
    await this.workspace.markCandidate();
    return { ok: true, status: "candidate", fingerprint, target_count: validation.plan!.targets.length };
  }

  private async sealPlan(fingerprint: string): Promise<DiscoveryToolResponse> {
    const state = await this.workspace.readState();
    const changed = await this.uncompiledSelectorChange(state);
    if (changed) return changed;
    const validatedFingerprint = this.phase === "review" ? state.last_reviewed_fingerprint : state.last_valid_fingerprint;
    const plan = await readJson<DocumentTargetPlan>(this.workspace.workingPlanPath);
    const validation = validateDocumentTargetPlan(plan, this.evidence, this.workspace.jobId,
      new Set(this.phase === "review" ? state.reviewer_opened_atom_ids ?? [] : state.opened_atom_ids));
    if (!fingerprint || fingerprint !== validatedFingerprint) {
      return fingerprintMismatchReject({
        error: "Seal fingerprint does not match the latest successful validation",
        submitted: fingerprint,
        expected: validatedFingerprint ?? "",
        validate_tool: "compile_document_selectors",
        ...(validation.ok && validation.fingerprint === validatedFingerprint
          ? { verified_retry: { tool: "seal_discovery_plan", arguments: { fingerprint: validatedFingerprint! } } } : {}),
      });
    }
    const selectors = await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath);
    const readGuard = await this.selectorReviewReadGuard(selectors, "seal_discovery_plan");
    if (readGuard) return readGuard;
    const semanticGuard = await this.semanticReviewGuard(selectors, "seal_discovery_plan");
    if (semanticGuard) return semanticGuard;
    if (!validation.ok || validation.fingerprint !== fingerprint) {
      return toolReject({
        error: "Working discovery plan changed after validation",
        instruction: "Re-run compile_document_selectors. Repair using the returned issues, then seal the new fingerprint.",
        issues: validation.issues,
        candidate_read_tool: "compile_document_selectors",
        required_action: "repair_using_returned_issues",
      });
    }
    const sealedPlan = validation.plan!;
    const coverage = state.last_selector_fingerprint ? await this.discoveryCoverage(sealedPlan) : undefined;
    // Always recompute against the final plan, including legacy scripted callers.
    // A successful local validation or a candidate-era ledger check is insufficient.
    const agreement = coverage?.agreement ?? evaluateDiscoveryLedgerAgreement(sealedPlan, await this.workspace.readLedger(), this.evidence.atoms);
    const rejection = this.discoveryClosureReject(coverage?.obligations ?? [], agreement);
    if (rejection) return rejection;
    const planText = prettyJson(sealedPlan);
    const selectorText = await readFile(this.workspace.workingSelectorPath, "utf8");
    await atomicWriteNewText(this.workspace.sealedPlanPath, planText);
    await atomicWriteNewText(this.workspace.sealedSelectorPath, selectorText);
    const transcript = await this.workspace.transcriptPrefix();
    const sealReceipt = {
      schema_version: "document-target-plan-seal/v4",
      sealing_role: this.phase === "review" ? "independent_reviewer" : "discovery_author",
      independent_semantic_review_performed: this.phase === "review" && state.reviewer_runtime.kind === "pi-sdk",
      fingerprint,
      plan_sha256: validation.plan_sha256,
      document_fingerprint: this.evidence.evidence_fingerprint,
      ledger_agreement: agreement,
      ...(coverage ? { coverage_review: {
        excluded_clause_ids: coverage.obligations.map((entry) => entry.clause_id),
        decisions: coverage.obligations.map((entry) => entry.decision),
        scope_review_hints: coverage.scope_review_hints,
      } } : {}),
      transcript,
    };
    await atomicWriteNewText(this.workspace.sealReceiptPath, prettyJson(sealReceipt));
    const manifest = {
      schema_version: "document-discovery-manifest/v4",
      job_id: this.workspace.jobId,
      target_count: sealedPlan.targets.length,
      outcome: sealedPlan.targets.length ? "targets_found" : "no_extractable_acceptance_scope",
      files: {
        plan_sha256: sha256Text(planText),
        selector_sha256: sha256Text(selectorText),
        source_span_registry_sha256: sha256Text(await readFile(this.workspace.sourceSpanRegistryPath, "utf8")),
        seal_receipt_sha256: sha256Json(sealReceipt),
        evidence_sha256: sha256Json(this.evidence),
      },
    };
    await atomicWriteNewText(this.workspace.manifestPath, prettyJson(manifest));
    await makeReadOnly(this.workspace.sealedPlanPath);
    await makeReadOnly(this.workspace.workingSelectorPath);
    await makeReadOnly(this.workspace.sealedSelectorPath);
    await makeReadOnly(this.workspace.sourceSpanRegistryPath);
    await makeReadOnly(this.workspace.sealReceiptPath);
    await makeReadOnly(this.workspace.manifestPath);
    await this.workspace.markSealed();
    return { ok: true, fingerprint, target_count: sealedPlan.targets.length };
  }

  private async uncompiledSelectorChange(state: DiscoveryState): Promise<DiscoveryToolResponse | undefined> {
    if (!state.last_selector_fingerprint) return undefined; // Internal legacy scripted plans.
    const current = documentSelectorFingerprint(await readJson<DocumentSelectorPlan>(this.workspace.workingSelectorPath));
    if (current === state.last_selector_fingerprint) return undefined;
    return toolReject({
      error: "discovery_selectors_changed", actual: current, validated: state.last_selector_fingerprint,
      instruction: "The selector draft changed after validation. Run compile_document_selectors, resolve its issues, then submit or seal the newly returned fingerprint. Do not reuse an older compiled plan or edit it directly.",
      next_tool: "compile_document_selectors",
    });
  }

  /**
   * Offline/scripted compatibility only. Live ledger closure never skips review.
   * Deterministic validation still runs against every atom.
   */
  async sealCandidateWithoutReview(): Promise<DiscoveryToolResponse> {
    const runtimeState = await this.workspace.readState();
    if (runtimeState.agent_runtime.kind === "pi-sdk" || runtimeState.reviewer_runtime.kind === "pi-sdk") return toolReject({
      error: "discovery_semantic_review_required",
      instruction: "Ledger closure cannot establish target semantics. Run the independent discovery review, open the source atoms, check each semantic_basis and excluded scope, then compile_document_selectors and seal_discovery_plan from the review session.",
      required_action: "run_independent_discovery_review",
    });
    if (this.phase !== "candidate") {
      return toolReject({
        error: "discovery_phase_forbidden",
        instruction: "This independent review session can seal_discovery_plan, not skip review from the candidate controller.",
        actual_phase: this.phase,
      });
    }
    const state = await this.workspace.readState();
    if (state.status !== "candidate") {
      return toolReject({
        error: "discovery_no_candidate",
        instruction: "Submit a validated candidate first, then seal.",
        status: state.status,
        candidate_read_tool: "compile_document_selectors",
      });
    }
    const plan = await readJson<DocumentTargetPlan>(this.workspace.workingPlanPath);
    const validation = validateDocumentTargetPlan(
      plan,
      this.evidence,
      this.workspace.jobId,
      new Set(this.evidence.atoms.map((atom) => atom.atom_id)),
    );
    if (!validation.ok || !validation.fingerprint) {
      return toolReject({
        error: "discovery_candidate_invalid",
        instruction: "Repair document selectors using issues, then compile_document_selectors and submit the new fingerprint.",
        issues: validation.issues,
        required_action: "repair_using_returned_issues",
        candidate_read_tool: "compile_document_selectors",
      });
    }
    const ledger = await this.workspace.readLedger();
    const agreement = evaluateDiscoveryLedgerAgreement(validation.plan!, ledger, this.evidence.atoms);
    if (!agreement.skip_reviewer) {
      return {
        ok: false,
        error: "discovery_ledger_review_required",
        uncovered_clause_ids: agreement.uncovered_clause_ids,
        unclaimed_candidate_clause_ids: agreement.unclaimed_candidate_clause_ids,
        overlapping_clause_ids: agreement.overlapping_clause_ids,
        anomalies: agreement.anomalies,
      };
    }
    const sealedPlan = validation.plan!;
    const planText = prettyJson(sealedPlan);
    const selectorText = await readFile(this.workspace.workingSelectorPath, "utf8");
    await atomicWriteNewText(this.workspace.sealedPlanPath, planText);
    await atomicWriteNewText(this.workspace.sealedSelectorPath, selectorText);
    const transcript = await this.workspace.transcriptPrefix();
    const sealReceipt = {
      schema_version: "document-target-plan-seal/v4",
      fingerprint: validation.fingerprint,
      plan_sha256: validation.plan_sha256,
      document_fingerprint: this.evidence.evidence_fingerprint,
      independent_review: "skipped_ledger_complete",
      transcript,
    };
    await atomicWriteNewText(this.workspace.sealReceiptPath, prettyJson(sealReceipt));
    const manifest = {
      schema_version: "document-discovery-manifest/v4",
      job_id: this.workspace.jobId,
      target_count: sealedPlan.targets.length,
      independent_review: "skipped_ledger_complete",
      files: {
        plan_sha256: sha256Text(planText),
        selector_sha256: sha256Text(selectorText),
        source_span_registry_sha256: sha256Text(await readFile(this.workspace.sourceSpanRegistryPath, "utf8")),
        seal_receipt_sha256: sha256Json(sealReceipt),
        evidence_sha256: sha256Json(this.evidence),
        document_ledger_sha256: sha256Json(ledger),
      },
    };
    await atomicWriteNewText(this.workspace.manifestPath, prettyJson(manifest));
    await makeReadOnly(this.workspace.sealedPlanPath);
    await makeReadOnly(this.workspace.workingSelectorPath);
    await makeReadOnly(this.workspace.sealedSelectorPath);
    await makeReadOnly(this.workspace.sourceSpanRegistryPath);
    await makeReadOnly(this.workspace.sealReceiptPath);
    await makeReadOnly(this.workspace.manifestPath);
    await this.workspace.markSealed();
    return { ok: true, fingerprint: validation.fingerprint, target_count: sealedPlan.targets.length, independent_review: "skipped_ledger_complete" };
  }
}

function resultContent(value: DiscoveryToolResponse): { content: Array<{ type: "text"; text: string }>; details: DiscoveryToolResponse } {
  const visible = value.atom ? { ...value, atom: discoveryAtomWithLines(value.atom as DocumentAtom) }
    : Array.isArray(value.atoms) && value.atoms.some(atom => typeof atom.text === "string")
      ? { ...value, atoms: value.atoms.map(atom => discoveryAtomWithLines(atom as DocumentAtom)) } : value;
  return { content: [{ type: "text", text: JSON.stringify(visible) }], details: value };
}

export function createDocumentDiscoveryTools(controller: DocumentDiscoveryController): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    defineTool({ name: "edit_document_selectors", label: "事务修订发现记录", description: ACCEPTANCE_TOOL_DESCRIPTIONS["edit_document_selectors"]!, parameters: Type.Object({
      edits: Type.Array(Type.Object({ collection: Type.Union([Type.Literal("targets"), Type.Literal("contexts"), Type.Literal("dispositions")]), key: Type.String({ minLength: 1 }), op: Type.Union([Type.Literal("upsert"), Type.Literal("update"), Type.Literal("remove")]), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false }), { minItems: 0, maxItems: 40 }),
      source_bindings: Type.Optional(Type.Array(DiscoverySourceBindingSchema, { maxItems: 100 })),
      dry_run: Type.Optional(Type.Boolean()), expected_selector_fingerprint: Type.Optional(Type.String()), draft_id: Type.Optional(Type.String()),
    }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("edit_document_selectors", params, id)) }),
    defineTool({ name: "discard_document_selector_draft", label: "明确放弃待提交事务", description: ACCEPTANCE_TOOL_DESCRIPTIONS["discard_document_selector_draft"]!, parameters: Type.Object({ draft_id: Type.String() }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("discard_document_selector_draft", params, id)) }),
    defineTool({ name: "read_discovery_obligations", label: "读取发现待办", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_discovery_obligations"]!, parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("read_discovery_obligations", params, id)) }),
    defineTool({ name: "read_scope_conflicts", label: "读取范围冲突", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_scope_conflicts"]!, parameters: Type.Object({ cursor: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("read_scope_conflicts", params, id)) }),
    defineTool({ name: "get_document_selector_contract", label: "读取文档选择器契约", description: ACCEPTANCE_TOOL_DESCRIPTIONS["get_document_selector_contract"]!, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("get_document_selector_contract", params as Record<string, unknown>, id)) }),
    defineTool({ name: "list_document_atoms", label: "列出文档原子", description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_document_atoms"]!, parameters: Type.Object({ cursor: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("list_document_atoms", params as Record<string, unknown>, id)) }),
    defineTool({ name: "open_document_atom", label: "打开文档原子", description: ACCEPTANCE_TOOL_DESCRIPTIONS["open_document_atom"]!, parameters: Type.Object({ atom_id: Type.String() }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("open_document_atom", params, id)) }),
    defineTool({ name: "batch_open_document_atoms", label: "批量打开文档原子", description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_open_document_atoms"]!, parameters: Type.Object({ atom_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("batch_open_document_atoms", params, id)) }),
    defineTool({ name: "search_document", label: "检索文档", description: ACCEPTANCE_TOOL_DESCRIPTIONS["search_document"]!, parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("search_document", params, id)) }),
    defineTool({ name: "batch_search_document", label: "批量检索文档", description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_search_document"]!, parameters: Type.Object({ queries: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("batch_search_document", params, id)) }),
    defineTool({ name: "locate_document_span", label: "定位文档片段", description: ACCEPTANCE_TOOL_DESCRIPTIONS["locate_document_span"]!, parameters: Type.Object({ atom_id: Type.Optional(Type.String()), quote: Type.String(), prefix: Type.Optional(Type.String()), suffix: Type.Optional(Type.String()) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("locate_document_span", params, id)) }),
    defineTool({ name: "batch_locate_document_spans", label: "批量定位文档片段", description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_locate_document_spans"]!, parameters: Type.Object({ requests: Type.Array(Type.Object({ atom_id: Type.String(), quote: Type.String(), prefix: Type.Optional(Type.String()), suffix: Type.Optional(Type.String()) }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("batch_locate_document_spans", params, id)) }),
    defineTool({ name: "read_document_selectors", label: "读取文档选择器", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_document_selectors"]!, parameters: Type.Object({ collection: Type.Optional(Type.Union([Type.Literal("targets"), Type.Literal("contexts"), Type.Literal("dispositions")])), key: Type.Optional(Type.String()), view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")])), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), draft_id: Type.Optional(Type.String()) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("read_document_selectors", params as Record<string, unknown>, id)) }),
    defineTool({ name: "patch_document_selectors", label: "保存文档选择器检查点", description: ACCEPTANCE_TOOL_DESCRIPTIONS["patch_document_selectors"]!, parameters: Type.Object({ operations: Type.Array(Type.Object({ op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]), path: Type.String(), value: Type.Optional(Type.Unknown()) }, { additionalProperties: false }), { minItems: 1, maxItems: 40 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("patch_document_selectors", params, id)) }),
    defineTool({ name: "compile_document_selectors", label: "编译文档选择器", description: ACCEPTANCE_TOOL_DESCRIPTIONS["compile_document_selectors"]!, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("compile_document_selectors", params as Record<string, unknown>, id)) }),
  ];
  if (controller.phase === "review") definitions.push(
    defineTool({ name: "read_discovery_review_progress", label: "读取独立复核进度", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_discovery_review_progress"]!, parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("read_discovery_review_progress", params, id)) }),
    defineTool({ name: "record_discovery_review", label: "保存独立复核判断", description: ACCEPTANCE_TOOL_DESCRIPTIONS["record_discovery_review"]!, parameters: Type.Object({ reviews: Type.Array(Type.Object({ collection: Type.Union([Type.Literal("targets"), Type.Literal("contexts")]), key: Type.String({ minLength: 1 }), verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("needs_revision")]), reason: Type.String({ minLength: 1, maxLength: 4000 }), source_span_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("record_discovery_review", params, id)) }),
  );
  definitions.push(defineTool({
    name: "record_discovery_decisions", label: "保存发现语义处置",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["record_discovery_decisions"]!,
    parameters: Type.Object({ decisions: Type.Array(Type.Object({
      clause_id: Type.String({ minLength: 1 }),
      disposition: Type.Union([Type.Literal("pending"), Type.Literal("context")]),
      context_key: Type.Optional(Type.String({ minLength: 1 })), reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("record_discovery_decisions", params, id)),
  }));
  definitions.push(defineTool({ name: "seal_discovery_plan", label: "封存发现计划", description: ACCEPTANCE_TOOL_DESCRIPTIONS["seal_discovery_plan"]!, parameters: Type.Object({ fingerprint: Type.String() }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("seal_discovery_plan", params, id)) }));
  return definitions.map(replaceAcceptanceToolText);
}

export function targetEvidenceLineSpan(
  target: Pick<DocumentTarget, "target_id" | "evidence_fragments">,
  documentEvidence: { atoms: readonly Pick<DocumentAtom, "atom_id" | "start_line" | "text">[] },
  fragments = target.evidence_fragments,
): { start_line: number; end_exclusive_line: number } {
  const atomById = new Map(documentEvidence.atoms.map((atom) => [atom.atom_id, atom]));
  const spans = fragments.map((fragment) => {
    const atom = atomById.get(fragment.atom_id);
    if (!atom) throw new Error(`Discovery target ${target.target_id} cites unknown fragment atom ${fragment.atom_id}`);
    const offset = atom.text.indexOf(fragment.text);
    if (offset < 0) throw new Error(`Discovery target ${target.target_id} has a non-exact evidence fragment`);
    const startLine = atom.start_line + countNewlines(atom.text.slice(0, offset));
    return {
      start_line: startLine,
      end_exclusive_line: startLine + countNewlines(fragment.text) + 1,
    };
  });
  if (spans.length === 0) throw new Error(`Discovery target ${target.target_id} has no evidence fragments`);
  return {
    start_line: Math.min(...spans.map((span) => span.start_line)),
    end_exclusive_line: Math.max(...spans.map((span) => span.end_exclusive_line)),
  };
}

export async function buildAgentScopedEvidenceManifest(
  markdownPath: string,
  jobId: string,
  target: DocumentTarget,
  documentEvidence: DocumentEvidence,
  pdfPath?: string,
  /**
   * 主证据的行范围。给了就按它裁，不给则退回「目标引用的那几个原子的整段行范围」。
   *
   * 原子是纯按 6000 字符切的、不看章节结构：1662 行的书只切成 12 个原子，
   * 每个 140~260 行。目标引 3~6 个原子，主证据就覆盖大半本书连附录一起
   * ——GB/T 50312 实测一个只管 79 行的目标拿到 350 条证据、其中 314 条 primary，
   * 而 primary 每条都必须绑定或交代（逐条上限 8 条），于是模型必然卡死。
   *
   * 范围本身是确定性算出来的（底账窗口，或引文所在的那一节），比原子边界准得多。
   * 导航与引用解析仍走原子的宽范围，不受影响——那两条路本来就该看得远。
   */
  primaryScope?: { start_line: number; end_exclusive_line: number },
  layoutProfile?: PdfLayoutProfile,
  /** Only atoms nominated by a scope blocker backed by fully opened source spans. */
  scopeExtensionAtomIds: readonly string[] = [],
): Promise<{ manifest: EvidenceManifest; markdown: Uint8Array; pdf?: Uint8Array }> {
  const markdown = await readFile(markdownPath);
  const markdownText = markdown.toString("utf8");
  if (sha256Text(markdownText) !== documentEvidence.source.sha256) {
    throw new Error("Document discovery evidence does not match target Markdown");
  }
  const pdf = pdfPath ? await readFile(pdfPath) : undefined;
  const confirmed = target.work_scope?.primary_fragments
    ? confirmedTargetScope(target, documentEvidence, primaryScope) : undefined;
  if (confirmed) primaryScope = confirmed;
  const extensionAtoms = [...new Set(scopeExtensionAtomIds)].map(atomId => {
    const atom = documentEvidence.atoms.find(candidate => candidate.atom_id === atomId);
    if (!atom || markdownText.slice(atom.start_offset, atom.end_offset) !== atom.text
      || sha256Text(atom.text) !== atom.text_sha256) {
      throw new Error(`scope_extension_required: invalid source atom ${atomId}`);
    }
    return atom;
  });
  // 保留行坐标，未选择的同一行文字也不补入主资料。此视图只用于准备，不更改原文。
  const selectedIntervals = confirmed ? [...confirmed.fragments.map(fragment => {
    const atom = documentEvidence.atoms.find(atom => atom.atom_id === fragment.atom_id)!;
    if (markdownText.slice(atom.start_offset, atom.end_offset) !== atom.text) {
      throw new TargetScopeConflict({ owner: "document_discovery_agent", target_id: target.target_id, actual: { atom_id: atom.atom_id, start: atom.start_offset, end: atom.end_offset }, message: "原子坐标与原文版本不一致。", next_tools: ["open_document_atom", "locate_document_span", "patch_document_selectors"], instruction: "重建当前版本的文档证据后由发现 Agent 核对并重新提交来源范围，不能修改下游编译产物。" });
    }
    return { start: atom.start_offset + fragment.start, end: atom.start_offset + fragment.end };
  }), ...extensionAtoms.map(atom => ({ start: atom.start_offset, end: atom.end_offset }))]
    .sort((a, b) => a.start - b.start) : undefined;
  let scopedText = markdownText;
  if (selectedIntervals) {
    let cursor = 0;
    const parts: string[] = [];
    for (const interval of selectedIntervals) {
      if (interval.end <= cursor) continue;
      if (interval.start > cursor) parts.push(markdownText.slice(cursor, interval.start).replace(/[^\r\n]/g, " "));
      parts.push(markdownText.slice(Math.max(cursor, interval.start), interval.end));
      cursor = interval.end;
    }
    parts.push(markdownText.slice(cursor).replace(/[^\r\n]/g, " "));
    scopedText = parts.join("");
  }

  const atomById = new Map(documentEvidence.atoms.map((atom, index) => [atom.atom_id, { atom, index }]));
  const sourceAtomIdForEvidence = (record: EvidenceRecord): string | undefined => {
    if (record.atom_id && atomById.has(record.atom_id)) return record.atom_id;
    const lineMatch = /^line:(\d+)(?:\/|$)/u.exec(record.locator);
    if (lineMatch) {
      const line = Number(lineMatch[1]);
      const owners = documentEvidence.atoms.filter((atom) =>
        line >= atom.start_line && line <= atom.end_line
      );
      if (owners.length === 1) return owners[0]!.atom_id;
    }
    const charMatch = /^char:(\d+)-(\d+)$/u.exec(record.locator);
    if (charMatch) {
      const start = Number(charMatch[1]);
      const end = Number(charMatch[2]);
      const owners = documentEvidence.atoms.filter((atom) =>
        start >= atom.start_offset && end <= atom.end_offset
      );
      if (owners.length === 1) return owners[0]!.atom_id;
    }
    return undefined;
  };
  const primaryIndexes = target.evidence_atom_ids.map((atomId) => {
    const located = atomById.get(atomId);
    if (!located) throw new Error(`Discovered target cites unknown atom ${atomId}`);
    return located.index;
  });
  const primaryScopeIndexes = [...new Set(primaryIndexes)]
    .sort((left, right) => left - right);
  const primaryScopeAtoms = primaryScopeIndexes.map((index) =>
    documentEvidence.atoms[index]!
  );
  // Fixed windows are physical navigation addresses. Keep their immediate neighborhood for
  // reference/table discovery; exact primary evidence is materialized separately below.
  const targetScopeIndexes = [...new Set(primaryIndexes.flatMap((index) => [index - 1, index, index + 1]))]
    .filter((index) => index >= 0 && index < documentEvidence.atoms.length)
    .sort((left, right) => left - right);
  const targetScopeIndexSet = new Set(targetScopeIndexes);
  const targetScopeAtoms = targetScopeIndexes.map((index) => documentEvidence.atoms[index]!);
  const primaryAtomIds = new Set(target.evidence_atom_ids);
  const sourceLines = markdownText.split(/\r?\n/).length;
  if (primaryScope && (
    !Number.isInteger(primaryScope.start_line) || !Number.isInteger(primaryScope.end_exclusive_line)
    || primaryScope.start_line < 1 || primaryScope.end_exclusive_line > sourceLines + 1
    || primaryScope.start_line >= primaryScope.end_exclusive_line
  )) throw new Error(`invalid_target_primary_scope: ${target.target_id}`);
  const targetLineSpan = targetEvidenceLineSpan(target, documentEvidence);
  const materializationWindows = target.materialization.lot_basis_fragments.flatMap((fragment) => {
    const atom = atomById.get(fragment.atom_id)?.atom;
    const offset = atom?.text.indexOf(fragment.text) ?? -1;
    if (!atom || offset < 0) return [];
    const startLine = atom.start_line + countNewlines(atom.text.slice(0, offset));
    return [{
      start_line: startLine,
      end_exclusive_line: startLine + countNewlines(fragment.text) + 1,
    }];
  });
  const extendWindows = (windows: Array<{ start_line: number; end_exclusive_line: number }>) => {
    if (!extensionAtoms.length) return windows;
    const merged: typeof windows = [];
    for (const window of [...windows, ...extensionAtoms.map(atom => ({
      start_line: atom.start_line, end_exclusive_line: atom.end_line + 1,
    }))].sort((left, right) => left.start_line - right.start_line)) {
      const previous = merged.at(-1);
      if (previous && window.start_line <= previous.end_exclusive_line) {
        previous.end_exclusive_line = Math.max(previous.end_exclusive_line, window.end_exclusive_line);
      } else merged.push({ ...window });
    }
    return merged;
  };
  const targetScopeWindows = extendWindows(confirmed ? confirmed.ranges : targetScopeAtoms.map((atom) => ({
    start_line: atom.start_line,
    end_exclusive_line: atom.end_line + 1,
  })));
  const primaryScopeWindows = extendWindows(confirmed ? confirmed.ranges : primaryScope
    ? [primaryScope]
    : primaryScopeAtoms.map((atom) => ({
      start_line: atom.start_line,
      end_exclusive_line: atom.end_line + 1,
    })));
  const structuredWindows = extendWindows(confirmed ? confirmed.ranges : primaryScope
    ? [primaryScope]
    : [targetLineSpan, ...materializationWindows]);
  const structuralHeadingLines = new Set(layoutProfile?.structural_heading_lines ?? []);
  const formalStructured = buildStructuredTargetEvidence(
    scopedText,
    documentEvidence.source.sha256,
    structuredWindows,
    true,
    structuralHeadingLines,
  );
  // Some normative criteria tables have no 主控项目/一般项目 column. That
  // layout must suppress automatic item prefill, not the immutable row-level
  // evidence needed by the Target Agent and Coverage Reviewer. Preserve the
  // old formal-table route when available and fall back only when it returned
  // no table fragments for the exact target window.
  const structured = formalStructured.table_fragments.length > 0
    ? formalStructured
    : buildStructuredTargetEvidence(
        scopedText,
        documentEvidence.source.sha256,
        structuredWindows,
        false,
        structuralHeadingLines,
      );
  const navigationStructured = buildStructuredTargetEvidence(
    markdownText,
    documentEvidence.source.sha256,
    targetScopeWindows,
    true,
    structuralHeadingLines,
  );
  const primaryCoverageEvidence = buildGranularProseCoverageEvidence(
    scopedText,
    documentEvidence.source.sha256,
    primaryScopeWindows,
    {
      includeHtmlTables: Boolean(primaryScope) && structured.table_fragments.length === 0,
      promotedHeadings: profilePromotedHeadings(layoutProfile),
      structuralHeadingLines,
    },
  );
  // Exact primary scopes must not hide upstream provisions from the independent reviewer.
  // Carry nominated general sections as optional context, with their original source IDs.
  // Absence from this heading-based index never establishes that no shared rule exists.
  const governingEvidence = primaryScope
    ? buildGranularProseCoverageEvidence(markdownText, documentEvidence.source.sha256,
        primaryScopeWindows.flatMap(range => governingContextWindows(scanDocumentLedger(markdownText, markdownPath), range)))
      .map(({ evidence_scope: _scope, ...record }) => ({ ...record, requires_disposition: false }))
    : [];
  const pdfNativeEvidence = primaryScopeWindows.flatMap((window) =>
    pdfNativeEvidenceForMarkdownWindow(
      layoutProfile,
      markdownText,
      window.start_line,
      window.end_exclusive_line,
    )
  );
  const authoritativeClauseIds = [...new Set([
    ...structured.evidence.filter((record) => record.evidence_scope === "primary"),
    ...primaryCoverageEvidence,
  ].flatMap((record) => record.clause_id ? [record.clause_id] : []))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const authoritativeClauseInventory = ` 程序识别的条款定位候选：${authoritativeClauseIds.join(", ") || "暂无"}。此清单可能不完整，仅用于定位和检查可能遗漏；本次任务范围由已确认的目标计划确定，清单不能覆盖或扩大该范围。`;
  // Preserve the sealed Discovery decision, not just the earlier ledger seed.
  // Its span IDs belong to the Discovery registry, not the Target registry.
  const semanticBasis = target.semantic_basis;
  const semanticSelectionReason = semanticBasis ? `目标发现语义依据：${JSON.stringify({
    subject: semanticBasis.subject, subject_kind: semanticBasis.subject_kind,
    acceptance_kind: semanticBasis.acceptance_kind,
    acceptance_reason: semanticBasis.acceptance_reason, boundary_reason: semanticBasis.boundary_reason,
  })}。` : "";
  const baseScopeFragments = confirmed ? confirmed.fragments.map(({ atom_id, text }) => ({ atom_id, text })) : primaryScope
    ? documentEvidence.atoms.flatMap((atom) => {
        const range = clipSourceToLineWindow(atom, primaryScope);
        return range ? [{ atom_id: atom.atom_id, text: atom.text.slice(range.start, range.end) }] : [];
      })
    : target.evidence_fragments.map((fragment) => ({ ...fragment }));
  const scopeFragments = extensionAtoms.length
    ? [...baseScopeFragments.filter(fragment => !scopeExtensionAtomIds.includes(fragment.atom_id)),
        ...extensionAtoms.map(({ atom_id, text }) => ({ atom_id, text }))]
    : baseScopeFragments;
  const scope = {
    schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
    mode: "agent_discovered" as const,
    target_id: target.target_id,
    ...(confirmed ? { confirmed_scope_fingerprint: confirmed.fingerprint, primary_source_ranges: primaryScopeWindows } : {}),
    ...(extensionAtoms.length ? { scope_extension_atom_ids: extensionAtoms.map(atom => atom.atom_id) } : {}),
    source_line_count: sourceLines,
    selected_start_line: extensionAtoms.length ? Math.min(...primaryScopeWindows.map(window => window.start_line))
      : primaryScope?.start_line ?? targetLineSpan.start_line,
    selected_end_exclusive_line: extensionAtoms.length ? Math.max(...primaryScopeWindows.map(window => window.end_exclusive_line))
      : primaryScope?.end_exclusive_line ?? targetLineSpan.end_exclusive_line,
    selected_heading: target.name,
    selection_reason: target.materialization.kind === "work_scope"
      ? `已确认任务分片。请在该主资料范围内识别完整的检验批和验收项目。工作分组：${target.group_name}（${target.group_reason}）。任务：${target.name}。${semanticSelectionReason}定位摘要（非完整范围定义）：${target.materialization.lot_basis_summary}。依据：${target.materialization.reason}；${target.reason}${authoritativeClauseInventory}`
      : `已封存的目标发现计划。工作分组：${target.group_name}（${target.group_reason}）。任务：${target.name}。${semanticSelectionReason}定位摘要（非完整范围定义）：${target.materialization.lot_basis_summary}。选择依据：${target.materialization.reason}；${target.reason}${authoritativeClauseInventory}`,
    selected_atom_ids: [...new Set(scopeFragments.map((fragment) => fragment.atom_id))],
    target_evidence_fragments: scopeFragments,
    reference_candidates: referenceRetrievalCandidates(targetScopeAtoms),
    table_navigation_candidates: navigationStructured.table_fragments,
    governing_context_evidence_ids: governingEvidence.map(record => record.evidence_id),
    candidates: [],
  };
  // A 6000-character atom is an immutable physical address, not a business scope. When the
  // ledger provides an exact range, the granular primary records below are authoritative and raw
  // selected/neighbor atoms stay available through the global and adjacent-resource tools. Without
  // an exact range, retain the legacy selected-plus-neighbors package as the fail-safe.
  const carriedAtomIndexes = primaryScope ? [] : targetScopeIndexes;
  const atomEvidence = carriedAtomIndexes.map((index) => {
    const atom = documentEvidence.atoms[index]!;
    return {
    evidence_id: atom.atom_id,
    atom_id: atom.atom_id,
    kind: "paragraph" as const,
    role: "context" as const,
    locator: `char:${atom.start_offset}-${atom.end_offset}`,
    source_start_line: atom.start_line,
    text: atom.text,
    text_sha256: atom.text_sha256,
    requires_disposition: targetScopeIndexSet.has(index),
    ...(primaryAtomIds.has(atom.atom_id)
      ? { evidence_scope: "primary" as const }
      : !targetScopeIndexSet.has(index)
        ? { evidence_scope: "reference" as const }
        : {}),
    };
  });
  const atomEvidenceIds = new Set(atomEvidence.map((record) => record.evidence_id));
  const authoritativeEvidence = new Map<string, EvidenceRecord>();
  const addAuthoritativeEvidence = (record: EvidenceRecord): void => {
    if (atomEvidenceIds.has(record.evidence_id)) return;
    const existing = authoritativeEvidence.get(record.evidence_id);
    const authority = Number(record.evidence_scope === "primary") * 2
      + Number(record.requires_disposition);
    const existingAuthority = existing
      ? Number(existing.evidence_scope === "primary") * 2
        + Number(existing.requires_disposition)
      : -1;
    if (!existing) {
      authoritativeEvidence.set(record.evidence_id, record);
      return;
    }
    const preferred = authority > existingAuthority ? record : existing;
    const clauseIds = [...new Set(
      [existing.clause_id, record.clause_id]
        .filter((clauseId): clauseId is string => Boolean(clauseId)),
    )];
    const clauseId = clauseIds[0];
    if (clauseIds.length === 1 && clauseId) {
      authoritativeEvidence.set(record.evidence_id, { ...preferred, clause_id: clauseId });
    } else {
      const { clause_id: _ambiguousClauseId, ...withoutClause } = preferred;
      authoritativeEvidence.set(record.evidence_id, withoutClause);
    }
  };
  for (const record of structured.evidence) addAuthoritativeEvidence(record);
  for (const record of primaryCoverageEvidence) addAuthoritativeEvidence(record);
  const existingText = new Set([...authoritativeEvidence.values()].map((record) =>
    record.text.normalize("NFKC").replace(/[\s　]/g, "")
  ));
  for (const record of pdfNativeEvidence) {
    const normalized = record.text.normalize("NFKC").replace(/[\s　]/g, "");
    if ([...existingText].some((existing) =>
      existing === normalized || existing.includes(normalized) || normalized.includes(existing)
    )) continue;
    addAuthoritativeEvidence(record);
    existingText.add(normalized);
  }
  const structuredEvidence = [...authoritativeEvidence.values()];
  const authoritativeEvidenceIds = new Set([
    ...atomEvidenceIds,
    ...structuredEvidence.map((record) => record.evidence_id),
  ]);
  const navigationEvidence = navigationStructured.evidence.flatMap((record) => {
    if (authoritativeEvidenceIds.has(record.evidence_id)) return [];
    const { evidence_scope: _ignoredScope, ...navigationRecord } = record;
    return [{ ...navigationRecord, requires_disposition: false }];
  });
  const existingEvidenceIds = new Set([...authoritativeEvidenceIds, ...navigationEvidence.map(record => record.evidence_id)]);
  const selectedReferences: EvidenceRecord[] = (target.work_scope?.reference_fragments ?? []).map(fragment => {
    const atom = atomById.get(fragment.atom_id)!.atom;
    return { evidence_id: `evidence:${sha256Json({ source: documentEvidence.source.sha256, fragment })}`, atom_id: fragment.atom_id,
      kind: "paragraph", role: "context", locator: `char:${atom.start_offset + fragment.start}-${atom.start_offset + fragment.end}`,
      source_start_line: atom.start_line + (atom.text.slice(0, fragment.start).match(/\n/g)?.length ?? 0),
      text: fragment.text, text_sha256: fragment.text_sha256, evidence_scope: "reference", requires_disposition: false };
  });
  const evidence = [...atomEvidence, ...structuredEvidence, ...navigationEvidence,
    ...governingEvidence.filter(record => !existingEvidenceIds.has(record.evidence_id)), ...selectedReferences]
    .map((record) => {
      const atomId = sourceAtomIdForEvidence(record);
      return atomId ? { ...record, atom_id: atomId } : record;
    });
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: jobId,
    target_id: target.target_id,
    source: {
      adapter: "document-domain-agent/v1" as const,
      file_name: basename(markdownPath),
      sha256: documentEvidence.source.sha256,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
      ...(pdf && pdfPath ? { pdf_file_name: basename(pdfPath), pdf_sha256: sha256Bytes(pdf) } : {}),
    },
    scope,
    evidence,
    table_fragments: structured.table_fragments,
    // Agent-scoped live extraction registers semantic references only through
    // resolve_document_reference. Structured rows remain evidence, never an automatic citation decision.
    reference_occurrences: [],
  };
  const result = { manifest: { ...payload, evidence_fingerprint: sha256Json(payload) }, markdown };
  return pdf ? { ...result, pdf } : result;
}
