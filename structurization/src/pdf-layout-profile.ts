import { readFile } from "node:fs/promises";

import { toolReject } from "./actionable-error.js";
import { sha256Bytes, sha256Text } from "./canonical.js";
import type { EvidenceRecord } from "./contracts.js";
import {
  extractPdfNativeDocument,
  type PdfNativeLine,
  type PdfPageRouteRecord,
  type PdfDocumentTextRoute,
} from "./pdf-native-source.js";

export const PDF_LAYOUT_PROFILE_SCHEMA_VERSION = "pdf-layout-profile/v5" as const;
export const PDF_LAYOUT_CATALOG_SCHEMA_VERSION = "pdf-layout-catalog/v5" as const;

export type PdfLearnedLayoutRole = "clause" | "clause_component" | "structural" | "page_furniture";

export interface PdfLayoutCandidate {
  candidate_id: string;
  markdown_line: number;
  pdf_page: number;
  markdown_heading: boolean;
  text: string;
  pdf_text: string;
  style_id: string;
  pdf_line_id: string;
}

export interface PdfLayoutStyleSummary {
  style_id: string;
  font_size: number;
  start_x_ratio: number;
  alignment: "left" | "center" | "right";
  dominant_font: string;
  plain_line_count: number;
  heading_line_count: number;
  examples: Array<{
    pdf_line_id: string;
    markdown_line: number;
    pdf_page: number;
    markdown_heading: boolean;
    text: string;
  }>;
}

export interface PdfLayoutSamplePage {
  pdf_page: number;
  lines: Array<{
    pdf_line_id: string;
    aligned_candidate_id?: string;
    markdown_line?: number;
    markdown_heading?: boolean;
    style_id: string;
    zone: PdfNativeLine["zone"];
    page_furniture: boolean;
    text: string;
  }>;
}

export interface PdfLayoutCatalog {
  schema_version: typeof PDF_LAYOUT_CATALOG_SCHEMA_VERSION;
  pdf_sha256: string;
  markdown_sha256: string;
  page_count: number;
  matched_candidate_count: number;
  unmatched_candidate_count: number;
  document_route: PdfDocumentTextRoute;
  page_routes: PdfPageRouteRecord[];
  styles: PdfLayoutStyleSummary[];
  sample_pages: PdfLayoutSamplePage[];
  pdf_lines: PdfNativeLine[];
  candidates: PdfLayoutCandidate[];
}

export interface PdfLayoutRule {
  rule_id: string;
  role: PdfLearnedLayoutRole;
  pattern: string;
  style_ids: string[];
  sample_line_ids: string[];
  reason: string;
}

/** Each raw representative line appears once, without duplicated style examples or derived profile data. */
export function pdfLayoutCatalogPage(catalog: PdfLayoutCatalog, cursor = 0) {
  const pages: PdfLayoutSamplePage[] = [];
  const response = () => {
    const styles = new Set(pages.flatMap(page => page.lines.map(line => line.style_id)));
    return { ok: true, schema_version: catalog.schema_version, page_count: catalog.page_count,
      document_route: catalog.document_route, matched_candidate_count: catalog.matched_candidate_count,
      unmatched_candidate_count: catalog.unmatched_candidate_count,
      styles: catalog.styles.filter(style => styles.has(style.style_id)).map(({ examples: _examples, ...style }) => style),
      sample_pages: pages, next_cursor: cursor + pages.length < catalog.sample_pages.length ? cursor + pages.length : null,
      instruction: "Read every representative page using next_cursor. These are raw PDF lines, not Markdown. Inspect individual lines only for uncertainty or rejected samples; derive source-supported rules without guessing unseen forms." };
  };
  for (const page of catalog.sample_pages.slice(cursor)) {
    pages.push(page);
    if (Buffer.byteLength(JSON.stringify(response()), "utf8") > 64 * 1024 && pages.length > 1) { pages.pop(); break; }
  }
  return response();
}

export interface PdfLayoutSealFailure {
  rule_id: string;
  pdf_line_id?: string;
  actual_text?: string;
  actual_style_id?: string;
  markdown_text?: string;
  expected_style_ids: string[];
  pattern: string;
  role?: PdfLearnedLayoutRole;
  mismatch: string;
  how_to_pass: string;
}

const PDF_LAYOUT_SEAL_INSTRUCTION = [
  "Matching uses catalog.pdf_lines[].text (raw PDF glyphs), not Markdown and not candidates[].text.",
  "MinerU often inserts a space after the last number (5.3.1 施工) and may collapse 6. 1.3 to 6.1.3;",
  "the raw line may be 5.3.1施工前, 6. 1.3地基, or A.0.1附录.",
  "For role=clause, the harness already accepts 3+ level numbers with optional spaces around dots;",
  "do not write a regex that requires a space after the last digit.",
  "Call inspect_pdf_layout_lines on failing pdf_line_ids.",
  "Drop those sample_line_ids or drop the failing rules. Keep passing_rule_ids unchanged.",
  "Do not resubmit the same failing samples. Do not seal with a catch-all ^.* rule.",
].join(" ");

export interface PdfPromotedHeading {
  markdown_line: number;
  role: "clause" | "clause_component";
  clause_id: string;
}

export interface PdfPromotedSourceLine {
  pdf_line_id: string;
  pdf_page: number;
  line_index: number;
  role: "clause" | "clause_component";
  clause_id: string;
  text: string;
}

export interface PdfLayoutProfile {
  schema_version: typeof PDF_LAYOUT_PROFILE_SCHEMA_VERSION;
  pdf_sha256: string;
  markdown_sha256: string;
  rules: PdfLayoutRule[];
  promoted_headings: PdfPromotedHeading[];
  /** LLM-learned structural headings; absent on previously saved profiles. */
  structural_heading_lines?: number[];
  promoted_pdf_lines: PdfPromotedSourceLine[];
  pdf_only_lines: PdfNativeLine[];
  markdown_alignments: Array<{
    markdown_line: number;
    pdf_line_id: string;
    pdf_page: number;
    pdf_line_index: number;
  }>;
  summary: string;
}

interface MarkdownLineCandidate {
  markdown_line: number;
  pdf_page: number;
  markdown_heading: boolean;
  text: string;
}

function displayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\s*\[PDF p\.\d+\]\s*$/, "")
    .trim();
}

function compactText(value: string): string {
  return displayText(value).replace(/[\s　]/g, "").replaceAll("．", ".");
}

function markdownLineCandidates(markdown: string): MarkdownLineCandidate[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const result: MarkdownLineCandidate[] = [];
  let currentPage = 1;
  for (const [index, raw] of lines.entries()) {
    const pageMatch = /\[PDF p\.(\d+)\]/.exec(raw);
    if (pageMatch) currentPage = Number(pageMatch[1]);
    const trimmed = raw.trim();
    if (
      !trimmed
      || /^<!--/.test(trimmed)
      || /^<\/?(?:table|tr|td)\b/i.test(trimmed)
      || /^\$\$$/.test(trimmed)
    ) continue;
    const text = displayText(trimmed);
    if (compactText(text).length < 2) continue;
    result.push({
      markdown_line: index + 1,
      pdf_page: currentPage,
      markdown_heading: /^#{1,6}\s+/.test(trimmed),
      text,
    });
  }
  return result;
}

function lineMatchScore(markdownText: string, pdfText: string): number {
  const left = compactText(markdownText);
  const right = compactText(pdfText);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.startsWith(right) || right.startsWith(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  if (left.includes(right) || right.includes(left)) {
    return 0.8 * Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  return prefix / Math.max(left.length, right.length);
}

function styleSummary(line: PdfNativeLine): Omit<PdfLayoutStyleSummary, "style_id" | "plain_line_count" | "heading_line_count" | "examples"> {
  const startRatio = line.page_width > 0 ? line.start_x / line.page_width : 0;
  const widthRatio = line.page_width > 0 ? line.width / line.page_width : 0;
  const midpoint = startRatio + widthRatio / 2;
  const alignment = startRatio <= 0.2
    ? "left"
    : startRatio > 0.5
      ? "right"
      : Math.abs(midpoint - 0.5) <= 0.06 && widthRatio < 0.8
        ? "center"
        : "left";
  return {
    font_size: Number(line.font_size.toFixed(1)),
    start_x_ratio: Number(startRatio.toFixed(2)),
    alignment,
    dominant_font: line.dominant_font,
  };
}

function styleId(summary: ReturnType<typeof styleSummary>): string {
  return `style:${sha256Text(JSON.stringify(summary)).slice(0, 16)}`;
}

function addStyleExample(style: PdfLayoutStyleSummary, candidate: PdfLayoutCandidate): void {
  const key = String(candidate.markdown_heading);
  const sameShapeCount = style.examples.filter((example) =>
    String(example.markdown_heading) === key
  ).length;
  if (sameShapeCount >= 8 || style.examples.length >= 16) return;
  style.examples.push({
    pdf_line_id: candidate.pdf_line_id,
    markdown_line: candidate.markdown_line,
    pdf_page: candidate.pdf_page,
    markdown_heading: candidate.markdown_heading,
    text: layoutCatalogExampleText(candidate),
  });
}

function representativePages(
  pdfLinesValue: PdfNativeLine[],
  candidates: PdfLayoutCandidate[],
): PdfLayoutSamplePage[] {
  const pages = new Map<number, PdfNativeLine[]>();
  for (const line of pdfLinesValue) {
    const rows = pages.get(line.pdf_page) ?? [];
    rows.push(line);
    pages.set(line.pdf_page, rows);
  }
  return [...pages.entries()]
    .map(([pdfPage, rows]) => ({
      pdfPage,
      rows,
      score: rows.filter((row) => candidates.some((candidate) =>
        candidate.pdf_line_id === row.pdf_line_id && candidate.markdown_heading
      )).length * 3 + new Set(rows.map((row) => styleId(styleSummary(row)))).size,
    }))
    .sort((left, right) => right.score - left.score || left.pdfPage - right.pdfPage)
    .slice(0, 8)
    .sort((left, right) => left.pdfPage - right.pdfPage)
    .map(({ pdfPage, rows }) => ({
      pdf_page: pdfPage,
      lines: rows.slice(0, 80).map((row) => ({
        pdf_line_id: row.pdf_line_id,
        ...(candidates.find((candidate) => candidate.pdf_line_id === row.pdf_line_id)
          ? {
              aligned_candidate_id: candidates.find((candidate) => candidate.pdf_line_id === row.pdf_line_id)!.candidate_id,
              markdown_line: candidates.find((candidate) => candidate.pdf_line_id === row.pdf_line_id)!.markdown_line,
              markdown_heading: candidates.find((candidate) => candidate.pdf_line_id === row.pdf_line_id)!.markdown_heading,
            }
          : {}),
        style_id: styleId(styleSummary(row)),
        zone: row.zone,
        page_furniture: row.page_furniture,
        text: row.text,
      })),
    }));
}

export async function buildPdfLayoutCatalog(
  pdfPath: string,
  markdownPath: string,
): Promise<PdfLayoutCatalog> {
  const [nativeDocument, markdownBytes] = await Promise.all([
    extractPdfNativeDocument(pdfPath),
    readFile(markdownPath),
  ]);
  const markdownCandidates = markdownLineCandidates(markdownBytes.toString("utf8"));
  const nativePageNumbers = new Set(nativeDocument.page_routes
    .filter((page) => page.route === "native")
    .map((page) => page.pdf_page));
  const pages = new Map<number, PdfNativeLine[]>();
  for (const line of nativeDocument.lines) {
    if (!nativePageNumbers.has(line.pdf_page)) continue;
    const rows = pages.get(line.pdf_page) ?? [];
    rows.push(line);
    pages.set(line.pdf_page, rows);
  }

  const matched: PdfLayoutCandidate[] = [];
  let unmatched = 0;
  const lastMatchedLineByPage = new Map<number, number>();
  for (const candidate of markdownCandidates) {
    const lastMatchedLine = lastMatchedLineByPage.get(candidate.pdf_page) ?? 0;
    const scored = (pages.get(candidate.pdf_page) ?? [])
      .map((line) => ({ line, score: lineMatchScore(candidate.text, line.text) }))
      .filter((row) => row.score >= 0.55);
    const best = (scored.filter((row) => row.line.line_index >= lastMatchedLine).length
      ? scored.filter((row) => row.line.line_index >= lastMatchedLine)
      : scored)
      .sort((left, right) => right.score - left.score || left.line.line_index - right.line.line_index)[0];
    if (!best || best.score < 0.55) {
      unmatched += 1;
      continue;
    }
    lastMatchedLineByPage.set(candidate.pdf_page, best.line.line_index);
    const summary = styleSummary(best.line);
    matched.push({
      candidate_id: `layout:${candidate.markdown_line}`,
      markdown_line: candidate.markdown_line,
      pdf_page: candidate.pdf_page,
      markdown_heading: candidate.markdown_heading,
      text: candidate.text,
      pdf_text: best.line.text,
      style_id: styleId(summary),
      pdf_line_id: best.line.pdf_line_id,
    });
  }

  const styleMap = new Map<string, PdfLayoutStyleSummary>();
  for (const line of nativeDocument.lines) {
    if (!nativePageNumbers.has(line.pdf_page)) continue;
    const summary = styleSummary(line);
    const id = styleId(summary);
    if (!styleMap.has(id)) {
      styleMap.set(id, {
        style_id: id,
        ...summary,
        plain_line_count: 0,
        heading_line_count: 0,
        examples: [],
      });
    }
  }
  for (const candidate of matched) {
    const line = (pages.get(candidate.pdf_page) ?? []).find((row) =>
      styleId(styleSummary(row)) === candidate.style_id
      && lineMatchScore(candidate.text, row.text) >= 0.55
    );
    if (!line) continue;
    const summary = styleSummary(line);
    const style = styleMap.get(candidate.style_id)!;
    if (candidate.markdown_heading) style.heading_line_count += 1;
    else style.plain_line_count += 1;
    addStyleExample(style, candidate);
    styleMap.set(candidate.style_id, style);
  }

  return {
    schema_version: PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
    pdf_sha256: nativeDocument.pdf_sha256,
    markdown_sha256: sha256Bytes(markdownBytes),
    page_count: nativeDocument.page_count,
    document_route: nativeDocument.document_route,
    page_routes: nativeDocument.page_routes,
    matched_candidate_count: matched.length,
    unmatched_candidate_count: unmatched,
    styles: [...styleMap.values()].sort((left, right) => left.style_id.localeCompare(right.style_id)),
    sample_pages: representativePages(
      nativeDocument.lines.filter((line) => nativePageNumbers.has(line.pdf_page)),
      matched,
    ),
    pdf_lines: nativeDocument.lines,
    candidates: matched,
  };
}

function learnedRegex(pattern: string): RegExp {
  if (!pattern.startsWith("^") || pattern.length > 256 || /\(\?<|\\[1-9]/.test(pattern)) {
    throw new Error(`Unsafe PDF layout rule pattern ${pattern}`);
  }
  return new RegExp(pattern, "u");
}

function isVacuousLayoutPattern(regex: RegExp): boolean {
  return ["x", "一般项目", "5.3.1施工前"].every((probe) => regex.test(probe));
}

function formalClauseId(text: string): string | undefined {
  const match = /^((?:[A-Za-z]|\d+)(?:\s*[.．]\s*\d+){2,})(?=\s|[^\d.．A-Za-z]|$)/.exec(displayText(text));
  return match?.[1]?.normalize("NFKC").replaceAll("．", ".").replace(/\s+/g, "");
}

export function layoutCatalogExampleText(candidate: Pick<PdfLayoutCandidate, "pdf_text">): string {
  return candidate.pdf_text;
}

export const PDF_LAYOUT_SEAL_MAX_ATTEMPTS = 5;

function resolvedLineStyleId(
  line: PdfNativeLine,
  alignedStyleByLine: Map<string, string>,
): string {
  return alignedStyleByLine.get(line.pdf_line_id) ?? styleId(styleSummary(line));
}

function ruleTextMatches(rule: PdfLayoutRule, text: string, regex: RegExp): boolean {
  if (rule.role === "clause") return Boolean(formalClauseId(text));
  return regex.test(text);
}

function ruleMatchesLine(
  rule: PdfLayoutRule,
  line: PdfNativeLine,
  lineStyleId: string,
  regex: RegExp,
): boolean {
  return rule.style_ids.includes(lineStyleId) && ruleTextMatches(rule, line.text, regex);
}

export class PdfLayoutSealError extends Error {
  readonly failures: PdfLayoutSealFailure[];
  readonly passing_rule_ids: string[];

  constructor(failures: PdfLayoutSealFailure[], passingRuleIds: string[]) {
    const first = failures[0];
    super(
      first
        ? `PDF layout rule samples rejected (${failures.length}). First: ${first.rule_id} ${first.pdf_line_id ?? ""} ${first.mismatch}`.trim()
        : "PDF layout rule samples rejected",
    );
    this.name = "PdfLayoutSealError";
    this.failures = failures;
    this.passing_rule_ids = passingRuleIds;
  }

  toToolReject() {
    return toolReject({
      error: "pdf_layout_rule_samples_rejected",
      instruction: PDF_LAYOUT_SEAL_INSTRUCTION,
      failures: this.failures,
      passing_rule_ids: this.passing_rule_ids,
      writable_collection: "seal_pdf_layout_profile.rules",
      required_action: "drop_failing_sample_line_ids_or_drop_the_failing_rules_then_resubmit",
      candidate_read_tool: "inspect_pdf_layout_lines",
      do_not: "Do not resubmit the same failing sample_line_ids. Do not invent a catch-all ^.* rule to force a seal.",
    });
  }
}

export function pdfLayoutSealToolReject(error: unknown, attempt: number) {
  const actual_error = error instanceof Error ? error.message : String(error);
  const base = error instanceof PdfLayoutSealError
    ? { ...error.toToolReject(), seal_attempt: attempt, max_seal_attempts: PDF_LAYOUT_SEAL_MAX_ATTEMPTS }
    : toolReject({
      error: "pdf_layout_profile_seal_rejected",
      instruction: `${actual_error} Matching uses catalog.pdf_lines[].text (raw PDF), not Markdown. inspect_pdf_layout_lines the cited samples. Drop failing samples or rules; do not resubmit the same payload or a catch-all ^.* rule.`,
      actual_error,
      writable_collection: "seal_pdf_layout_profile.rules",
      required_action: "drop_failing_sample_line_ids_or_drop_the_failing_rules_then_resubmit",
      candidate_read_tool: "inspect_pdf_layout_lines",
      seal_attempt: attempt,
      max_seal_attempts: PDF_LAYOUT_SEAL_MAX_ATTEMPTS,
    });
  if (attempt < PDF_LAYOUT_SEAL_MAX_ATTEMPTS) return base;
  return toolReject({
    ...base,
    error: "pdf_layout_profile_seal_attempt_budget_exhausted",
    instruction: `${base.instruction} Seal attempt ${attempt} of ${PDF_LAYOUT_SEAL_MAX_ATTEMPTS} is exhausted. Stop calling seal_pdf_layout_profile. Discovery will continue without a learned layout profile.`,
  });
}

export function inspectPdfLayoutLines(
  catalog: PdfLayoutCatalog,
  lineIds: readonly string[],
): {
  ok: true;
  matching_surface: "catalog.pdf_lines[].text";
  instruction: string;
  lines: Array<{
    pdf_line_id: string;
    missing?: true;
    actual_text?: string;
    actual_style_id?: string;
    aligned?: boolean;
    markdown_text?: string;
    pdf_page?: number;
    line_index?: number;
    formal_clause_id?: string | null;
  }>;
} {
  const pdfLinesById = new Map(catalog.pdf_lines.map((line) => [line.pdf_line_id, line]));
  const alignedByLine = new Map(catalog.candidates.map((candidate) => [candidate.pdf_line_id, candidate]));
  const alignedStyleByLine = new Map(catalog.candidates.map((candidate) => [candidate.pdf_line_id, candidate.style_id]));
  return {
    ok: true,
    matching_surface: "catalog.pdf_lines[].text",
    instruction: "Seal matching uses actual_text (raw PDF), not Markdown. role=clause ids may have spaces inside the number and no space before the body.",
    lines: lineIds.map((pdfLineId) => {
      const line = pdfLinesById.get(pdfLineId);
      if (!line) return { pdf_line_id: pdfLineId, missing: true as const };
      const candidate = alignedByLine.get(pdfLineId);
      return {
        pdf_line_id: pdfLineId,
        actual_text: line.text,
        actual_style_id: resolvedLineStyleId(line, alignedStyleByLine),
        aligned: Boolean(candidate),
        ...(candidate ? { markdown_text: candidate.text } : {}),
        pdf_page: line.pdf_page,
        line_index: line.line_index,
        formal_clause_id: formalClauseId(line.text) ?? null,
      };
    }),
  };
}

function diagnoseLayoutRule(
  rule: PdfLayoutRule,
  catalogStyles: Set<string>,
  pdfLinesById: Map<string, PdfNativeLine>,
  alignedStyleByLine: Map<string, string>,
  candidatesByLine: Map<string, PdfLayoutCandidate>,
  seenRuleIds: Set<string>,
): { normalized?: PdfLayoutRule; failures: PdfLayoutSealFailure[] } {
  const failures: PdfLayoutSealFailure[] = [];
  const base = {
    rule_id: rule.rule_id,
    expected_style_ids: rule.style_ids,
    pattern: rule.pattern,
    role: rule.role,
  };
  if (!rule.rule_id.trim() || seenRuleIds.has(rule.rule_id)) {
    failures.push({
      ...base,
      mismatch: "invalid_rule_id",
      how_to_pass: "Each rule_id must be unique and non-empty.",
    });
    return { failures };
  }
  seenRuleIds.add(rule.rule_id);

  let regex: RegExp;
  try {
    regex = learnedRegex(rule.pattern);
  } catch {
    failures.push({
      ...base,
      mismatch: "unsafe_pattern",
      how_to_pass: "Patterns must start with ^, be at most 256 characters, and must not use named groups or backreferences.",
    });
    return { failures };
  }
  if (isVacuousLayoutPattern(regex)) {
    failures.push({
      ...base,
      mismatch: "catch_all_pattern",
      how_to_pass: "Patterns must distinguish formal clauses from structural headings. Do not use ^.* or other catch-alls. For role=clause the harness already matches 3+ level numbers including A.0.1.",
    });
    return { failures };
  }

  const unknownStyles = rule.style_ids.filter((styleIdValue) => !catalogStyles.has(styleIdValue));
  if (!rule.style_ids.length || unknownStyles.length) {
    failures.push({
      ...base,
      actual_style_id: unknownStyles.join(",") || "(empty)",
      mismatch: "unknown_style",
      how_to_pass: `Copy style_ids from catalog.styles[].style_id. Unknown: ${unknownStyles.join(", ") || "(empty)"}`,
    });
  }
  if (!rule.sample_line_ids.length) {
    failures.push({
      ...base,
      mismatch: "empty_samples",
      how_to_pass: "Cite at least one pdf_line_id from catalog.pdf_lines or inspect_pdf_layout_lines.",
    });
  }
  for (const lineId of rule.sample_line_ids) {
    const line = pdfLinesById.get(lineId);
    if (!line) {
      failures.push({
        ...base,
        pdf_line_id: lineId,
        mismatch: "unknown_sample",
        how_to_pass: "Cite a pdf_line_id from catalog.pdf_lines or inspect_pdf_layout_lines. Do not invent ids.",
      });
      continue;
    }
    const actualStyleId = resolvedLineStyleId(line, alignedStyleByLine);
    const styleMatched = rule.style_ids.includes(actualStyleId);
    const textMatched = ruleTextMatches(rule, line.text, regex);
    if (styleMatched && textMatched) continue;
    const mismatchParts = [
      ...(!styleMatched ? ["style"] : []),
      ...(!textMatched ? [rule.role === "clause" ? "clause_id" : "regex"] : []),
    ];
    const candidate = candidatesByLine.get(lineId);
    failures.push({
      ...base,
      pdf_line_id: lineId,
      actual_text: line.text,
      actual_style_id: actualStyleId,
      ...(candidate ? { markdown_text: candidate.text } : {}),
      mismatch: mismatchParts.join("+"),
      how_to_pass: !styleMatched
        ? `This sample's actual_style_id is ${actualStyleId}; rule.style_ids is ${JSON.stringify(rule.style_ids)}. Drop this sample_line_id or set style_ids to the sample's actual_style_id.`
        : rule.role === "clause"
          ? "role=clause samples must start with a 3+ level number on the raw PDF line, e.g. 5.3.1施工前, 6. 1.3地基, or A.0.1附录. Matching ignores Markdown spacing. Drop this sample_line_id or this rule."
          : `pattern ${rule.pattern} did not match actual_text. inspect_pdf_layout_lines this id and rewrite the regex for the raw glyphs, or drop this sample.`,
    });
  }
  if (failures.length) return { failures };
  return {
    failures,
    normalized: {
      rule_id: rule.rule_id,
      role: rule.role,
      pattern: rule.pattern,
      style_ids: [...new Set(rule.style_ids)].sort(),
      sample_line_ids: [...new Set(rule.sample_line_ids)].sort(),
      reason: rule.reason.trim(),
    },
  };
}

export function sealPdfLayoutProfile(
  catalog: PdfLayoutCatalog,
  rulesValue: readonly PdfLayoutRule[],
  summary: string,
): PdfLayoutProfile {
  if (!rulesValue.length || rulesValue.length > 32) throw new Error("PDF layout profile requires 1-32 rules");
  const styles = new Set(catalog.styles.map((style) => style.style_id));
  const pdfLinesById = new Map(catalog.pdf_lines.map((line) => [line.pdf_line_id, line]));
  const alignedStyleByLine = new Map(catalog.candidates.map((candidate) => [candidate.pdf_line_id, candidate.style_id]));
  const candidatesByLine = new Map(catalog.candidates.map((candidate) => [candidate.pdf_line_id, candidate]));
  const seenRuleIds = new Set<string>();
  const failures: PdfLayoutSealFailure[] = [];
  const rules: PdfLayoutRule[] = [];
  for (const rule of rulesValue) {
    const diagnosed = diagnoseLayoutRule(
      rule,
      styles,
      pdfLinesById,
      alignedStyleByLine,
      candidatesByLine,
      seenRuleIds,
    );
    failures.push(...diagnosed.failures);
    if (diagnosed.normalized) rules.push(diagnosed.normalized);
  }
  if (failures.length) throw new PdfLayoutSealError(failures, rules.map((rule) => rule.rule_id));

  const compiled = rules.map((rule) => ({ rule, regex: learnedRegex(rule.pattern) }));
  let currentClauseId = "";
  const promotedPdfLines: PdfPromotedSourceLine[] = [];
  const structuralPdfLineIds = new Set<string>();
  const nativePages = new Set(catalog.page_routes.filter((page) => page.route === "native").map((page) => page.pdf_page));
  for (const line of [...catalog.pdf_lines].sort((left, right) =>
    left.pdf_page - right.pdf_page || left.line_index - right.line_index
  )) {
    if (!nativePages.has(line.pdf_page) || line.page_furniture) continue;
    const directClauseId = formalClauseId(line.text);
    const lineStyleId = resolvedLineStyleId(line, alignedStyleByLine);
    const rule = compiled.find((row) => ruleMatchesLine(row.rule, line, lineStyleId, row.regex))?.rule;
    if (rule?.role === "structural") {
      structuralPdfLineIds.add(line.pdf_line_id);
      currentClauseId = "";
      continue;
    }
    if (rule?.role === "clause" && directClauseId) currentClauseId = directClauseId;
    if (!rule || (rule.role !== "clause" && rule.role !== "clause_component")) continue;
    const clauseId = rule.role === "clause" ? directClauseId ?? "" : currentClauseId;
    if (!clauseId) continue;
    promotedPdfLines.push({
      pdf_line_id: line.pdf_line_id,
      pdf_page: line.pdf_page,
      line_index: line.line_index,
      role: rule.role,
      clause_id: clauseId,
      text: line.text,
    });
  }
  const promotedByPdfLine = new Map(promotedPdfLines.map((line) => [line.pdf_line_id, line]));
  const promotedHeadings = catalog.candidates.flatMap((candidate) => {
    if (!candidate.markdown_heading) return [];
    const promoted = promotedByPdfLine.get(candidate.pdf_line_id);
    return promoted ? [{
      markdown_line: candidate.markdown_line,
      role: promoted.role,
      clause_id: promoted.clause_id,
    }] : [];
  });
  const alignedPdfLineIds = new Set(catalog.candidates.map((candidate) => candidate.pdf_line_id));
  return {
    schema_version: PDF_LAYOUT_PROFILE_SCHEMA_VERSION,
    pdf_sha256: catalog.pdf_sha256,
    markdown_sha256: catalog.markdown_sha256,
    rules,
    promoted_headings: promotedHeadings,
    structural_heading_lines: catalog.candidates
      .filter(candidate => candidate.markdown_heading && structuralPdfLineIds.has(candidate.pdf_line_id))
      .map(candidate => candidate.markdown_line),
    promoted_pdf_lines: promotedPdfLines,
    pdf_only_lines: catalog.pdf_lines.filter((line) =>
      nativePages.has(line.pdf_page)
      && !line.page_furniture
      && !alignedPdfLineIds.has(line.pdf_line_id)
    ),
    markdown_alignments: catalog.candidates.map((candidate) => ({
      markdown_line: candidate.markdown_line,
      pdf_line_id: candidate.pdf_line_id,
      pdf_page: candidate.pdf_page,
      pdf_line_index: pdfLinesById.get(candidate.pdf_line_id)!.line_index,
    })),
    summary: summary.trim(),
  };
}

export function profilePromotedHeadings(
  profile: PdfLayoutProfile | undefined,
): ReadonlyMap<number, PdfPromotedHeading> {
  return new Map((profile?.promoted_headings ?? []).map((entry) => [entry.markdown_line, entry]));
}

function markdownPagesForWindow(
  markdown: string,
  startLine: number,
  endExclusiveLine: number,
): Set<number> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const pages = new Set<number>();
  let currentPage = 1;
  for (const [index, line] of lines.entries()) {
    const pageMatch = /\[PDF p\.(\d+)\]/.exec(line);
    if (pageMatch) currentPage = Number(pageMatch[1]);
    const lineNumber = index + 1;
    if (lineNumber >= startLine && lineNumber < endExclusiveLine) pages.add(currentPage);
  }
  return pages;
}

export function pdfNativeEvidenceForMarkdownWindow(
  profile: PdfLayoutProfile | undefined,
  markdown: string,
  startLine: number,
  endExclusiveLine: number,
): EvidenceRecord[] {
  if (!profile) return [];
  const pages = markdownPagesForWindow(markdown, startLine, endExclusiveLine);
  const promoted = new Map(profile.promoted_pdf_lines.map((line) => [line.pdf_line_id, line]));
  const bounds = new Map<number, { first: number; last: number }>();
  for (const alignment of profile.markdown_alignments) {
    if (alignment.markdown_line < startLine || alignment.markdown_line >= endExclusiveLine) continue;
    const current = bounds.get(alignment.pdf_page);
    bounds.set(alignment.pdf_page, current
      ? {
          first: Math.min(current.first, alignment.pdf_line_index),
          last: Math.max(current.last, alignment.pdf_line_index),
        }
      : { first: alignment.pdf_line_index, last: alignment.pdf_line_index });
  }
  return profile.pdf_only_lines
    .filter((line) => {
      if (!pages.has(line.pdf_page)) return false;
      const bound = bounds.get(line.pdf_page);
      return !bound || (line.line_index >= bound.first && line.line_index <= bound.last);
    })
    .map((line) => {
      const promotion = promoted.get(line.pdf_line_id);
      const textSha256 = sha256Text(line.text);
      return {
        evidence_id: `evidence:${sha256Text(`pdf-native/v1|${profile.pdf_sha256}|${line.pdf_line_id}|${textSha256}`)}`,
        kind: "paragraph" as const,
        role: promotion ? "supporting_clause" as const : "context" as const,
        locator: `pdf-page:${line.pdf_page}/line:${line.line_index}`,
        text: line.text,
        text_sha256: textSha256,
        requires_disposition: false,
        evidence_scope: promotion ? "primary" as const : "reference" as const,
        ...(promotion ? { clause_id: promotion.clause_id } : {}),
      };
    });
}
