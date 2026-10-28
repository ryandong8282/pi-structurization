import { Type, type Static } from "typebox";

import { canonicalize, sha256Text } from "./canonical.js";
import type {
  DocumentAtom,
  DocumentEvidence,
  DocumentTargetPlan,
} from "./document-discovery.js";
import {
  resolveSourceSpan,
  sourceSpanCoveredBy,
  type ImmutableTextSource,
  type ResolvedSourceSpan,
  type SourceSpanIssue,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import { sourceLanguageMismatch } from "./source-language.js";
import type { LedgerClause } from "./document-ledger.js";
import { confirmedTargetScope, primaryTargetOverlaps, TargetScopeConflict, type TargetSourceFragment } from "./confirmed-target-scope.js";

export const DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION = "document-selector-plan/v2" as const;

const strictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const SpanIds = Type.Array(Type.String({ minLength: 1 }));
const SourceBlock = strictObject({
  kind: Type.Union([Type.Literal("heading_section"), Type.Literal("explicit_range")]),
  anchor_span_id: Type.String({ minLength: 1 }),
  start_span_id: Type.String({ minLength: 1 }),
  end_span_id: Type.Optional(Type.String({ minLength: 1 })),
  end_before_span_id: Type.Optional(Type.String({ minLength: 1 })),
  reason: Type.String({ minLength: 1 }),
});

export const DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA = strictObject({
  schema_version: Type.Literal(DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION),
  job_id: Type.String({ minLength: 1 }),
  no_target_reason: Type.Optional(Type.String({ minLength: 1, description: "全文审查后没有具体可验收对象时填写原因；仍须处置全部原子并接受独立复核。与非空 targets 互斥。" })),
  targets: Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    group_key: Type.String({ minLength: 1 }),
    group_name: Type.String(),
    group_reason: Type.String(),
    name: Type.String({ minLength: 1 }),
    lot_basis_summary: Type.String(),
    semantic_basis: Type.Optional(strictObject({
      subject: Type.String({ minLength: 1 }),
      subject_kind: Type.Union([
        Type.Literal("work"), Type.Literal("product"), Type.Literal("component"), Type.Literal("system"),
        Type.Literal("installation_activity"), Type.Literal("test_scope"),
        Type.Literal("generic_inspection_lot"), Type.Literal("aggregate_acceptance"), Type.Literal("governing_rule"),
      ]),
      acceptance_kind: Type.Union([Type.Literal("direct_criterion"), Type.Literal("referenced_criterion")]),
      acceptance_span_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      acceptance_reason: Type.String({ minLength: 1 }),
      boundary_reason: Type.String({ minLength: 1 }),
    })),
    scope_span_ids: Type.Array(Type.String({ minLength: 1 }), { description: "Agent 用于说明每个主资料块选择的最小精确原文 span；必须位于一个 source_block 内且不得整 atom 越界。完整连续 primary 由 source_blocks 的确定坐标物化，不要求把中间每段正文重复 locate。" }),
    source_blocks: Type.Array(SourceBlock, { minItems: 1, description: "Agent 对每个连续主资料块提交可审计边界。heading_section 表示确认的完整标题结构，explicit_range 用于无可靠标题、OCR 损坏或独立表格；每块必须有锚点、起点和且仅一个终点。" }),
    reference_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "共享规则或引用参考的精确来源；不改变任务主资料归属。" })),
    lot_basis_span_ids: SpanIds,
    reason: Type.String(),
  })),
  contexts: Type.Array(strictObject({
    key: Type.String({ minLength: 1 }),
    role: Type.Union([
      Type.Literal("governing_rule"),
      Type.Literal("aggregate_acceptance"),
      Type.Literal("definition"),
      Type.Literal("record_template"),
      Type.Literal("other_context"),
    ]),
    name: Type.String(),
    span_ids: SpanIds,
    reason: Type.String(),
  })),
  dispositions: Type.Array(strictObject({
    atom_span_id: Type.String({ minLength: 1 }),
    disposition: Type.Union([
      Type.Literal("target"),
      Type.Literal("context"),
      Type.Literal("irrelevant"),
      Type.Literal("pending"),
    ]),
    target_keys: Type.Array(Type.String({ minLength: 1 }), { description: "兼容字段；Harness 按已编译 primary evidence 确定性重算。Agent 对 target disposition 可提交空数组，不维护这份机械镜像。" }),
    reason: Type.String(),
  })),
  rationale: Type.Optional(Type.String()),
});

export type DocumentSelectorPlan = Static<typeof DOCUMENT_SELECTOR_PLAN_JSON_SCHEMA>;
export interface DocumentSelectorIssue extends SourceSpanIssue {}
export interface DiscoveryScopeCandidate {
  window_id: string;
  number: string;
  title: string;
  start_line: number;
  end_exclusive_line: number;
}

function discoveryCandidateRanges(evidence: DocumentEvidence, candidates: readonly DiscoveryScopeCandidate[]) {
  const offsetAtLine = (line: number): number | undefined => {
    if (line <= 1) return 0;
    for (const atom of evidence.atoms) {
      if (line < atom.start_line || line > atom.end_line + 1) continue;
      if (line === atom.end_line + 1) return atom.end_offset;
      let local = 0;
      for (let current = atom.start_line; current < line; current += 1) {
        const newline = atom.text.indexOf("\n", local);
        if (newline < 0) return undefined;
        local = newline + 1;
      }
      return atom.start_offset + local;
    }
    return line > Math.max(...evidence.atoms.map((atom) => atom.end_line)) ? evidence.source.char_count : undefined;
  };
  return candidates.map(candidate => ({ candidate, start: offsetAtLine(candidate.start_line), end: offsetAtLine(candidate.end_exclusive_line) }));
}

/** Heuristic window disagreements are evidence for the independent LLM review, not target admission rules. */
export function discoveryScopeReviewHints(
  plan: DocumentTargetPlan,
  selectors: DocumentSelectorPlan,
  evidence: DocumentEvidence,
  candidates: readonly DiscoveryScopeCandidate[],
  clauses: readonly LedgerClause[] = [],
) {
  const candidateRanges = discoveryCandidateRanges(evidence, candidates);
  const windowHints = plan.targets.flatMap((target, index) => {
    const primary = target.work_scope?.primary_fragments ?? [];
    const touched = candidateRanges.filter(({ start, end }) => start !== undefined && end !== undefined && end > start
      && primary.some(fragment => {
        const atom = evidence.atoms.find(entry => entry.atom_id === fragment.atom_id);
        return atom && Math.max(start, atom.start_offset + fragment.start) < Math.min(end, atom.start_offset + fragment.end);
      }));
    if (touched.length <= 1) return [];
    const selector = selectors.targets[index]!;
    return [{
      code: "target_crosses_candidate_windows",
      target: { key: selector.key, name: target.name },
      candidate_windows: touched.map(({ candidate }) => ({
        window_id: candidate.window_id, number: candidate.number, title: candidate.title,
        start_line: candidate.start_line, end_exclusive_line: candidate.end_exclusive_line,
      })),
      source_atom_ids: evidence.atoms.filter(atom => touched.some(({ candidate }) =>
        atom.start_line < candidate.end_exclusive_line && atom.end_line >= candidate.start_line)).map(atom => atom.atom_id),
      boundary_reason: selector.semantic_basis?.boundary_reason ?? "",
      writable_paths: [`/targets/${index}/source_blocks`, `/targets/${index}/semantic_basis`],
      next_tools: ["open_document_atom", "read_document_selectors", "edit_document_selectors"],
      instruction: "候选窗口可能重叠或受 OCR 标题缺失影响，不是业务边界。独立复核者须阅读列出的原文及相邻范围，依据对象、判据和语义判断现有拆并是否正确。正确时可保留；不正确时修订 source_blocks、原文依据和 boundary_reason。不得仅为匹配窗口而拆分、合并或删除目标，不要修改 ledger 或编译产物。最终通过当前计划的独立复核后封存。",
    }];
  });
  const source = evidence.atoms.map(atom => atom.text).join("");
  const clauseRanges = discoveryCandidateRanges(evidence, clauses.map(clause => ({
    window_id: clause.clause_id, number: clause.clause_id, title: "",
    start_line: clause.line, end_exclusive_line: clause.end_exclusive_line,
  })));
  const clauseHints = clauseRanges.flatMap(({ candidate, start, end: rawEnd }) => {
    if (start === undefined || rawEnd === undefined) return [];
    const end = start + source.slice(start, rawEnd).trimEnd().length;
    const owners = plan.targets.flatMap((target, index) => {
      const ranges = (target.work_scope?.primary_fragments ?? []).flatMap(fragment => {
        const atom = evidence.atoms.find(entry => entry.atom_id === fragment.atom_id);
        if (!atom) return [];
        const left = Math.max(start, atom.start_offset + fragment.start);
        const right = Math.min(end, atom.start_offset + fragment.end);
        return left < right ? [{ start: left, end: right }] : [];
      });
      const selector = selectors.targets[index]!;
      return ranges.length ? [{ index, key: selector.key, name: target.name, primary_ranges: ranges,
        boundary_reason: selector.semantic_basis?.boundary_reason ?? "" }] : [];
    });
    if (owners.length < 2) return [];
    return [{
      code: "candidate_clause_split_across_targets", clause_id: candidate.number,
      start_line: candidate.start_line, end_exclusive_line: candidate.end_exclusive_line,
      source_range: { start, end }, excerpt_start: source.slice(start, Math.min(end, start + 240)),
      excerpt_end: source.slice(Math.max(start, end - 240), end), targets: owners,
      source_atom_ids: evidence.atoms.filter(atom => atom.start_offset < end && atom.end_offset > start).map(atom => atom.atom_id),
      writable_paths: owners.flatMap(owner => [`/targets/${owner.index}/source_blocks`, `/targets/${owner.index}/semantic_basis`]),
      next_tools: ["open_document_atom", "read_document_selectors", "edit_document_selectors"],
      instruction: "底账物理条文由多个 target 的精确原文共同覆盖，不代表漏文或必须合并。OCR 可能把下一标题并入上一条，也可能一条包含多个对象。独立复核者须读完整原文和各目标的 source_blocks、semantic_basis，判断拆分是否保持各对象完整验收语义；正确则保留，错误则修订原文绑定与 boundary_reason。不要为匹配底账而吞入相邻对象、删除目标或修改 ledger/编译产物。",
    }];
  });
  const sharedWindowHints = candidateRanges.flatMap(({ candidate, start, end }) => {
    if (start === undefined || end === undefined) return [];
    const owners = plan.targets.flatMap((target, index) => {
      const ranges = (target.work_scope?.primary_fragments ?? []).flatMap(fragment => {
        const atom = evidence.atoms.find(entry => entry.atom_id === fragment.atom_id);
        if (!atom) return [];
        const left = Math.max(start, atom.start_offset + fragment.start);
        const right = Math.min(end, atom.start_offset + fragment.end);
        return left < right ? [{ start: left, end: right }] : [];
      });
      const selector = selectors.targets[index]!;
      return ranges.length ? [{ index, key: selector.key, name: target.name,
        semantic_basis: selector.semantic_basis, primary_ranges: ranges }] : [];
    });
    // Cross-window decisions already have a whole-source review route above.
    // This hint addresses the otherwise invisible split inside a single window.
    if (owners.length < 2 || owners.some(owner => windowHints.some(hint => hint.target.key === owner.key))) return [];
    return [{
      code: "candidate_window_shared_by_targets", candidate_window: candidate, targets: owners,
      clause_owners: clauseRanges.filter(range => range.start !== undefined && range.start >= start && range.start < end)
        .map(range => ({ clause_id: range.candidate.number, line: range.candidate.start_line,
          target_keys: owners.filter(owner => owner.primary_ranges.some(primary =>
            range.start! >= primary.start && range.start! < primary.end)).map(owner => owner.key) })),
      source_atom_ids: evidence.atoms.filter(atom => atom.start_offset < end && atom.end_offset > start).map(atom => atom.atom_id),
      writable_paths: owners.flatMap(owner => [`/targets/${owner.index}/source_blocks`, `/targets/${owner.index}/semantic_basis`]),
      next_tools: ["open_document_atom", "read_document_selectors", "edit_document_selectors"],
      instruction: "同一候选窗口由多个对象共享。读取整个窗口及各对象的语义依据，逐条核对来源是否属于当前列出的 owner；后文可能再次返回前一个对象，共享规定也可能同时约束多个对象。需要时用多个不连续 source_blocks 保留同一对象的全部主资料，共享来源用 reference_span_ids。物理行归属不证明语义归属，正确的连续或不连续划分都可保留。",
    }];
  });
  return [...windowHints, ...clauseHints, ...sharedWindowHints];
}

export class DocumentSelectorCompileError extends Error {
  constructor(public readonly issues: DocumentSelectorIssue[]) {
    const preview = issues.slice(0, 5).map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join("; ");
    super(`Document selector compilation failed with ${issues.length} issue(s)${preview ? `: ${preview}` : ""}`);
  }
}

export function initialDocumentSelectorPlan(
  jobId: string,
): DocumentSelectorPlan {
  return {
    schema_version: DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION,
    job_id: jobId,
    targets: [],
    contexts: [],
    dispositions: [],
  };
}

function stableId(prefix: string, jobId: string, key: string): string {
  return `${prefix}:${sha256Text(`${jobId}\0${key}`).slice(0, 24)}`;
}

function exactKeys(
  value: unknown,
  expected: string[],
  path: string,
  issues: DocumentSelectorIssue[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ code: "selector_schema", path, message: "Expected an object" });
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push({ code: "selector_schema", path, message: "Selector object keys must match the contract exactly", details: { expected: wanted, actual } });
    return false;
  }
  return true;
}

function validateShape(value: unknown): DocumentSelectorIssue[] {
  const issues: DocumentSelectorIssue[] = [];
  if (!exactKeys(value, [
    "schema_version", "job_id",
    "targets", "contexts", "dispositions", ...["rationale", "no_target_reason"].filter(key => value && typeof value === "object" && key in value),
  ], "/", issues)) return issues;
  const plan = value as Record<string, unknown>;
  for (const field of ["targets", "contexts", "dispositions"]) {
    if (!Array.isArray(plan[field])) issues.push({ code: "selector_schema", path: `/${field}`, message: `${field} must be an array` });
  }
  if (issues.length) return issues;
  (plan.targets as unknown[]).forEach((entry, index) => exactKeys(entry, [
    "key", "group_key", "group_name", "group_reason", "name", "lot_basis_summary",
    "scope_span_ids", "source_blocks", "lot_basis_span_ids", "reason", ...["reference_span_ids", "semantic_basis"].filter(key => entry && typeof entry === "object" && key in entry),
  ], `/targets/${index}`, issues));
  (plan.targets as Array<Record<string, unknown>>).forEach((entry, targetIndex) => {
    if (!Array.isArray(entry?.source_blocks) || entry.source_blocks.length === 0) {
      issues.push({ code: "selector_schema", path: `/targets/${targetIndex}/source_blocks`, message: "source_blocks must be a non-empty array" });
      return;
    }
    entry.source_blocks.forEach((block, blockIndex) => {
      const optional = block && typeof block === "object"
        ? ["end_span_id", "end_before_span_id"].filter((key) => key in block)
        : [];
      exactKeys(block, ["kind", "anchor_span_id", "start_span_id", "reason", ...optional], `/targets/${targetIndex}/source_blocks/${blockIndex}`, issues);
      if (!block || typeof block !== "object") return;
      const record = block as Record<string, unknown>;
      if (!["heading_section", "explicit_range"].includes(String(record.kind))) {
        issues.push({ code: "selector_schema", path: `/targets/${targetIndex}/source_blocks/${blockIndex}/kind`, message: "kind must be heading_section or explicit_range" });
      }
      for (const field of ["anchor_span_id", "start_span_id", "reason"]) {
        if (typeof record[field] !== "string" || !(record[field] as string).trim()) issues.push({ code: "selector_schema", path: `/targets/${targetIndex}/source_blocks/${blockIndex}/${field}`, message: `${field} must be a non-empty string` });
      }
      if ((typeof record.end_span_id === "string") === (typeof record.end_before_span_id === "string")) {
        issues.push({ code: "selector_schema", path: `/targets/${targetIndex}/source_blocks/${blockIndex}`, message: "Every source block must provide exactly one of end_span_id or end_before_span_id" });
      }
    });
  });
  (plan.contexts as unknown[]).forEach((entry, index) => exactKeys(entry, ["key", "role", "name", "span_ids", "reason"], `/contexts/${index}`, issues));
  (plan.dispositions as unknown[]).forEach((entry, index) => exactKeys(entry, ["atom_span_id", "disposition", "target_keys", "reason"], `/dispositions/${index}`, issues));
  return issues;
}

function sourcesFor(atoms: DocumentAtom[]): Map<string, ImmutableTextSource> {
  return new Map(atoms.map((atom) => [atom.atom_id, {
    source_id: atom.atom_id,
    evidence_id: atom.atom_id,
    atom_id: atom.atom_id,
    text: atom.text,
  }]));
}

function resolveMany(
  spanIds: readonly string[],
  registry: SourceSpanRegistry,
  sources: Map<string, ImmutableTextSource>,
  path: string,
  issues: DocumentSelectorIssue[],
): Array<{ atom_id: string; text: string }> {
  if (!Array.isArray(spanIds)) {
    issues.push({ code: "selector_schema", path, message: "span ids must be an array" });
    return [];
  }
  return spanIds.flatMap((spanId, index) => {
    const resolved = resolveSourceSpan(registry, spanId, sources, `${path}/${index}`, issues);
    // Cross-atom bindings can legitimately end in a whitespace-only slice.
    // Verify its provenance, but do not emit it as standalone semantic evidence.
    // Source-block endpoints and primary fragments retain the exact source bytes.
    return resolved && resolved.text.trim() ? [{ atom_id: resolved.atom_id, text: resolved.text }] : [];
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueFragments(
  fragments: Array<{ atom_id: string; text: string }>,
): Array<{ atom_id: string; text: string }> {
  const seen = new Set<string>();
  return fragments.filter((fragment) => {
    const key = `${fragment.atom_id}\0${fragment.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSourceFragments(fragments: TargetSourceFragment[]): TargetSourceFragment[] {
  const seen = new Set<string>();
  return fragments.filter((fragment) => {
    const key = `${fragment.atom_id}\0${fragment.start}\0${fragment.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface NumberedMarkdownHeading {
  atom_id: string;
  start: number;
  end: number;
  absolute_start: number;
  text: string;
  number: string;
  components: string[];
}

function numberedMarkdownHeadings(evidence: DocumentEvidence): NumberedMarkdownHeading[] {
  const headings: NumberedMarkdownHeading[] = [];
  let tableDepth = 0;
  for (const atom of evidence.atoms) {
    let offset = 0;
    for (const lineWithBreak of atom.text.match(/[^\n]*(?:\n|$)/g) ?? []) {
      if (!lineWithBreak) continue;
      const line = lineWithBreak.replace(/\n$/u, "").replace(/\r$/u, "");
      const opens = line.match(/<table\b/giu)?.length ?? 0;
      const closes = line.match(/<\/table>/giu)?.length ?? 0;
      const heading = tableDepth === 0
        ? /^\s*#{1,6}\s+(?:第\s*)?(\d+(?:\s*[.．]\s*\d+)*)(?:\s*[章节篇]?\s+|\s+)(\S.*)$/u.exec(line)
        : null;
      if (heading?.[1]) {
        const number = heading[1].normalize("NFKC").replaceAll("．", ".").replace(/\s+/gu, "");
        headings.push({
          atom_id: atom.atom_id,
          start: offset,
          end: offset + line.length,
          absolute_start: atom.start_offset + offset,
          text: line.trim(),
          number,
          components: number.split("."),
        });
      }
      tableDepth = Math.max(0, tableDepth + opens - closes);
      offset += lineWithBreak.length;
    }
  }
  return headings;
}

function headingBoundaryAfter(
  anchor: NumberedMarkdownHeading,
  start: number,
  end: number,
  headings: readonly NumberedMarkdownHeading[],
): NumberedMarkdownHeading | undefined {
  const anchorChapter = Number(anchor.components[0]);
  return headings.find((candidate) => {
    if (candidate.absolute_start <= start || candidate.absolute_start >= end) return false;
    if (candidate.number === anchor.number || candidate.number.startsWith(`${anchor.number}.`)) return false;
    const candidateChapter = Number(candidate.components[0]);
    if (!Number.isFinite(anchorChapter) || !Number.isFinite(candidateChapter)) return false;
    // MinerU may promote numbered list entries to headings. A chapter number that
    // moves backwards cannot be the closing boundary of the current section.
    if (candidateChapter < anchorChapter) return false;
    if (candidateChapter > anchorChapter) return candidate.components.length <= anchor.components.length;
    return candidate.components.length <= anchor.components.length;
  });
}

export function compileDocumentSelectors(
  selectors: DocumentSelectorPlan,
  registry: SourceSpanRegistry,
  evidence: DocumentEvidence,
  jobId: string,
  options: { requireSemanticBasis?: boolean; discoveryScopeCandidates?: readonly DiscoveryScopeCandidate[] } = {},
): DocumentTargetPlan {
  const issues = validateShape(selectors);
  if (issues.length) throw new DocumentSelectorCompileError(issues);
  if (selectors.schema_version !== DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION) issues.push({ code: "selector_schema", path: "/schema_version", message: `Expected ${DOCUMENT_SELECTOR_PLAN_SCHEMA_VERSION}` });
  if (selectors.job_id !== jobId) issues.push({ code: "selector_job_mismatch", path: "/job_id", message: "job_id does not match the discovery workspace" });

  const targetKeys = new Set<string>();
  selectors.targets.forEach((target, index) => {
    if (targetKeys.has(target.key)) issues.push({ code: "selector_duplicate_target_key", path: `/targets/${index}/key`, message: "target keys must be unique" });
    targetKeys.add(target.key);
  });
  const sources = sourcesFor(evidence.atoms);
  const acceptanceSpansByTarget = new Map<number, ResolvedSourceSpan[]>();
  // Legacy/offline selectors remain readable. Live authoring requires this
  // evidence contract before materialization or atom-closure diagnostics.
  selectors.targets.forEach((target, index) => {
    const basis = target.semantic_basis;
    if (!basis && !options.requireSemanticBasis) return;
    const path = `/targets/${index}/semantic_basis`;
    const repair = { writable_path: path, actual: basis ?? null, next_tool: "patch_document_selectors",
      required_action: "填写 subject（具体受检对象）、subject_kind（work/product/component/system/installation_activity/test_scope）、acceptance_kind（direct_criterion 或 referenced_criterion）、acceptance_span_ids、acceptance_reason（原文如何约束该对象）、boundary_reason（与相邻候选合并或拆分的依据）；泛指检验批、管理或汇总规则应删除该 target，改写 contexts 和 dispositions。用 locate_document_span 获取依据，不修改编译产物。" };
    if (!basis || !exactKeys(basis, ["subject", "subject_kind", "acceptance_kind", "acceptance_span_ids", "acceptance_reason", "boundary_reason"], path, issues)
      || [basis.subject, basis.acceptance_reason, basis.boundary_reason].some(value => typeof value !== "string" || !value.trim())
      || !["direct_criterion", "referenced_criterion"].includes(basis.acceptance_kind)
      || !Array.isArray(basis.acceptance_span_ids) || !basis.acceptance_span_ids.length) {
      issues.push({ code: "selector_target_semantic_basis_required", path, message: "先证明具体对象及其验收要求真实存在，再决定目标边界。", details: repair });
      return;
    }
    if (!["work", "product", "component", "system", "installation_activity", "test_scope"].includes(basis.subject_kind)) {
      issues.push({ code: "selector_non_concrete_target", path: `${path}/subject_kind`,
        message: "通用检验批定义、汇总验收层级及管理规则不能形成独立抽取目标。",
        details: { ...repair, actual: basis.subject_kind, allowed_target_kinds: ["work", "product", "component", "system", "installation_activity", "test_scope"],
          required_action: "阅读引用原文；只有泛指检验批或汇总/管理规则时，删除对应 targets 条目，新增有原文 span 的 contexts 并修正 dispositions。全文无具体对象时填写 no_target_reason；不要仅改枚举伪装为具体工程。" } });
    }
    const acceptanceSpans = basis.acceptance_span_ids.flatMap((spanId, spanIndex) => {
      const resolved = resolveSourceSpan(registry, spanId, sources, `${path}/acceptance_span_ids/${spanIndex}`, issues);
      return resolved ? [resolved] : [];
    });
    acceptanceSpansByTarget.set(index, acceptanceSpans);
  });
  if (selectors.no_target_reason !== undefined && (typeof selectors.no_target_reason !== "string" || !selectors.no_target_reason.trim() || selectors.targets.length > 0)) {
    issues.push({ code: "selector_no_target_reason_conflict", path: "/no_target_reason", message: "no_target_reason 必须为非空说明且只能与空 targets 一起提交。", details: { actual: selectors.no_target_reason, target_count: selectors.targets.length, writable_path: "/no_target_reason", next_tool: "patch_document_selectors", required_action: "有真实 target 时移除 no_target_reason；无目标时说明全文审查依据并处置全部原子。" } });
  }
  const semanticBasisPending = issues.length > 0;
  if (issues.some(issue => issue.code !== "selector_target_semantic_basis_required"
    || (issue.details as { actual?: unknown })?.actual !== null)) {
    throw new DocumentSelectorCompileError(issues);
  }
  // Missing proof is a draft-completion issue, not permission to skip local
  // provenance checks on the targets already authored beside those seeds.
  const documentHeadings = numberedMarkdownHeadings(evidence);
  const targetIds = new Map(selectors.targets.map((target) => [target.key, stableId("target", jobId, target.key)]));
  const targets = selectors.targets.map((target, index) => {
    const scopeFragments = resolveMany(target.scope_span_ids, registry, sources, `/targets/${index}/scope_span_ids`, issues);
    const lotBasisFragments = resolveMany(target.lot_basis_span_ids, registry, sources, `/targets/${index}/lot_basis_span_ids`, issues);
    const resolveFragments = (ids: string[], field: string): TargetSourceFragment[] => ids.flatMap((id, spanIndex) => {
      const span = resolveSourceSpan(registry, id, sources, `/targets/${index}/${field}/${spanIndex}`, issues);
      return span ? [{ atom_id: span.atom_id, start: span.start, end: span.end, text: span.text, text_sha256: sha256Text(span.text) }] : [];
    });
    const scopeSelections = resolveFragments(target.scope_span_ids, "scope_span_ids");
    const references = uniqueSourceFragments(resolveFragments(target.reference_span_ids ?? [], "reference_span_ids"));
    const sourceBlocks = target.source_blocks.map((block, blockIndex) => {
      const one = (spanId: string, field: string) => resolveFragments([spanId], `source_blocks/${blockIndex}/${field}`)[0];
      const anchor = one(block.anchor_span_id, "anchor_span_id");
      const start = one(block.start_span_id, "start_span_id");
      return {
        kind: block.kind,
        ...(anchor ? { anchor_fragment: anchor } : {}),
        ...(start ? { start_fragment: start } : {}),
        ...(block.end_span_id ? { end_fragment: one(block.end_span_id, "end_span_id") } : {}),
        ...(block.end_before_span_id ? { end_before_fragment: one(block.end_before_span_id, "end_before_span_id") } : {}),
        reason: block.reason,
      };
    });
    const absoluteStart = (fragment: TargetSourceFragment | undefined) => {
      if (!fragment) return undefined;
      const atom = evidence.atoms.find(candidate => candidate.atom_id === fragment.atom_id);
      return atom ? atom.start_offset + fragment.start : undefined;
    };
    const absoluteEnd = (fragment: TargetSourceFragment | undefined) => {
      if (!fragment) return undefined;
      const atom = evidence.atoms.find(candidate => candidate.atom_id === fragment.atom_id);
      return atom ? atom.start_offset + fragment.end : undefined;
    };
    sourceBlocks.forEach((block, blockIndex) => {
      if (block.kind !== "heading_section" || !block.anchor_fragment || !block.start_fragment) return;
      const start = absoluteStart(block.start_fragment);
      const end = block.end_before_fragment ? absoluteStart(block.end_before_fragment) : absoluteEnd(block.end_fragment);
      const anchorAtom = evidence.atoms.find(candidate => candidate.atom_id === block.anchor_fragment!.atom_id);
      if (start === undefined || end === undefined || !anchorAtom) return;
      const anchorAbsoluteStart = anchorAtom.start_offset + block.anchor_fragment.start;
      const anchor = documentHeadings.find(candidate =>
        candidate.atom_id === block.anchor_fragment!.atom_id
        && candidate.absolute_start <= anchorAbsoluteStart
        && candidate.absolute_start + candidate.text.length >= anchorAbsoluteStart);
      if (!anchor) return;
      const boundary = headingBoundaryAfter(anchor, start, end, documentHeadings);
      if (!boundary) return;
      const registeredBoundary = registry.spans.find(span =>
        span.atom_id === boundary.atom_id
        && span.start === boundary.start
        && span.end === boundary.end);
      issues.push({
        code: "selector_heading_section_crosses_structural_boundary",
        path: `/targets/${index}/source_blocks/${blockIndex}/${block.end_before_fragment ? "end_before_span_id" : "end_span_id"}`,
        message: "heading_section crosses the next sibling or parent-level numbered heading",
        details: {
          target: { key: target.key, name: target.name },
          anchor: { number: anchor.number, text: anchor.text, atom_id: anchor.atom_id },
          first_conflicting_heading: {
            number: boundary.number,
            text: boundary.text,
            atom_id: boundary.atom_id,
            start: boundary.start,
            end: boundary.end,
          },
          submitted_end_absolute_offset: end,
          writable_path: `/targets/${index}/source_blocks/${blockIndex}`,
          required_action: registeredBoundary
            ? "replace the submitted end with end_before_span_id using candidate_boundary_span_id"
            : "locate first_conflicting_heading.text in its atom, then replace the submitted end with that returned end_before_span_id",
          ...(registeredBoundary ? {
            candidate_boundary_span_id: registeredBoundary.span_id,
            patch_operations: [
              ...(block.end_fragment ? [{ op: "remove", path: `/targets/${index}/source_blocks/${blockIndex}/end_span_id` }] : []),
              { op: block.end_before_fragment ? "replace" : "add", path: `/targets/${index}/source_blocks/${blockIndex}/end_before_span_id`, value: registeredBoundary.span_id },
            ],
          } : {
            next_tool: "locate_document_span",
            next_tool_input: { atom_id: boundary.atom_id, quote: boundary.text },
          }),
          do_not_patch_until_boundary_is_fixed: "/dispositions",
        },
      });
    });
    // 区间倒挂的块不参与主资料计算，但必须显式报出来：静默跳过会让模型收到
    // 派生的「验收依据未绑定」，而真问题（选错 end 边界 span）被藏住——实测
    // GB 50210 run 20260928-230633-1e1a：window:14.3/14.4 的 end_before span
    // 落在起点之前，模型多轮原地打转。
    const invertedBlocks: Array<Record<string, unknown>> = [];
    const primary = sourceBlocks.flatMap((block) => {
      const start = absoluteStart(block.start_fragment);
      const end = block.end_before_fragment ? absoluteStart(block.end_before_fragment) : absoluteEnd(block.end_fragment);
      if (start === undefined || end === undefined || end <= start) {
        if (start !== undefined && end !== undefined) {
          const endFragment = block.end_before_fragment ?? block.end_fragment;
          invertedBlocks.push({
            block_index: sourceBlocks.indexOf(block),
            start_absolute_offset: start,
            end_absolute_offset: end,
            end_fragment: endFragment ?? null,
            end_span_kind: block.end_before_fragment ? "end_before_fragment" : "end_fragment",
          });
          issues.push({
            code: "selector_block_interval_inverted",
            path: `/targets/${index}/source_blocks/${sourceBlocks.indexOf(block)}`,
            message: "source block 区间倒挂：end 边界的绝对位置在 start 之前，本块不产生任何主资料。",
            details: {
              writable_path: `/targets/${index}/source_blocks/${sourceBlocks.indexOf(block)}`,
              target_key: target.key,
              actual: {
                start_absolute_offset: start,
                end_absolute_offset: end,
                end_fragment: endFragment ?? null,
                end_span_kind: block.end_before_fragment ? "end_before_fragment" : "end_fragment",
              },
              next_tools: ["locate_document_span", "edit_document_selectors"],
              required_action: "end 边界选错了 span（其绝对位置在块起点之前）。用 locate_document_span 定位本节真实的后继标题或末行原文，替换 end_before_fragment（或 end_fragment）对应的 end_span_id；替换后端点必须位于起点之后。不要改验收依据来迁就倒挂的块。",
            },
          });
        }
        return [];
      }
      return evidence.atoms.flatMap((atom): TargetSourceFragment[] => {
        const localStart = Math.max(0, start - atom.start_offset);
        const localEnd = Math.min(atom.text.length, end - atom.start_offset);
        if (localEnd <= localStart) return [];
        const text = atom.text.slice(localStart, localEnd);
        return [{ atom_id: atom.atom_id, start: localStart, end: localEnd, text, text_sha256: sha256Text(text) }];
      });
    });
    if (target.semantic_basis && !invertedBlocks.length) {
      const semanticCoverage = [
        ...primary.map((fragment) => ({ evidence_id: fragment.atom_id, start: fragment.start, end: fragment.end })),
        ...references.map((fragment) => ({ evidence_id: fragment.atom_id, start: fragment.start, end: fragment.end })),
      ];
      const unbound = (acceptanceSpansByTarget.get(index) ?? [])
        .filter((span) => !sourceSpanCoveredBy(span, semanticCoverage))
        .map((span) => span.span_id);
      if (unbound.length) {
        issues.push({
          code: "selector_semantic_evidence_unbound",
          path: `/targets/${index}/semantic_basis/acceptance_span_ids`,
          message: "验收依据必须完整落在本 target 的 primary source_blocks 或 reference_span_ids 内。",
          details: {
            writable_path: `/targets/${index}`,
            target_key: target.key,
            actual: target.semantic_basis,
            expected: "每个实际适用的验收依据 span 必须被本 target 的 primary source_blocks 或 reference_span_ids 完整覆盖；主资料与共享或引用来源的角色仍须依据原文判断，覆盖成立不代替语义正确。",
            writable_paths: [`/targets/${index}/source_blocks`, `/targets/${index}/reference_span_ids`, `/targets/${index}/semantic_basis/acceptance_span_ids`, `/targets/${index}/semantic_basis/acceptance_reason`],
            next_tool: "edit_document_selectors",
            unbound_span_ids: unbound,
            // Keep IDs in typed fields so the public source-handle codec can encode them.
            // Coverage facts alone cannot select primary ownership or reference applicability.
            unbound_reference_escape: {
              path: `/targets/${index}/reference_span_ids`,
              how: "先读取 target_key 的完整作者记录并核对 unbound_span_ids 对应原文。只有依据确属本 target 适用的共享或引用来源时，才用 edit_document_selectors 绑定其中适用的精确 span 到 reference_span_ids；引用可跨窗口共享，但不改变主资料归属。不得仅为消除此报错把主资料转成引用。",
            },
            next_tools: ["read_document_selectors", "open_document_atom", "locate_document_span", "edit_document_selectors"],
            required_action: "依据实际原文选择修复：本对象主资料范围遗漏时修订 source_blocks，并核对相邻目标主资料边界；确属本对象适用的共享或引用依据时修订 reference_span_ids；验收依据误选时重新定位真实依据并修正 semantic_basis.acceptance_span_ids 及对应理由。保留已有正确来源，不要仅为消错删除适用的验收依据、改变来源角色或扩入无关范围。事务返回 draft_id 时沿用该待提交草稿；不要复制 span ID 到无关字段、改写原文或修改编译产物。",
          },
        });
      }
    }
    const lines = primary.map(fragment => {
      const atom = evidence.atoms.find(atom => atom.atom_id === fragment.atom_id)!;
      const start = atom.start_line + (atom.text.slice(0, fragment.start).match(/\n/g)?.length ?? 0);
      return { start, end: start + (fragment.text.match(/\n/g)?.length ?? 0) + (fragment.text.endsWith("\n") ? 0 : 1) };
    });
    const targetFragments = uniqueFragments([
      ...primary
        .filter(fragment => /\S/u.test(fragment.text))
        .map(fragment => ({ atom_id: fragment.atom_id, text: fragment.text })),
      ...scopeFragments,
      ...lotBasisFragments,
    ]);
    for (const [field, fragments, code] of [
      ["scope_span_ids", scopeFragments, "selector_target_scope_missing"],
      ["lot_basis_span_ids", lotBasisFragments, "selector_lot_basis_missing"],
    ] as const) {
      if (fragments.length) continue;
      issues.push({
        code,
        path: `/targets/${index}/${field}`,
        message: "引用中没有有效正文；纯空白已自动忽略，不能单独作为目标范围或验收依据。",
        details: {
          target_key: target.key,
          target_name: target.name,
          writable_path: `/targets/${index}/${field}`,
          actual: target[field].map(spanId => {
            const span = registry.spans.find(candidate => candidate.span_id === spanId);
            return { span_id: spanId, atom_id: span?.atom_id ?? null,
              text: span ? sources.get(span.evidence_id)?.text.slice(span.start, span.end) ?? null : null };
          }),
          next_tool: "edit_document_selectors",
          required_action: `按 target_key 定位此目标，在 source_bindings 绑定已读且包含实际正文的行或条文，再更新 ${field} 为该引用。普通正文前后的空白无需修改；若原文根本不存在该目标，应删除该 target 并修正 dispositions。不要修改编译产物或为消错扩入相邻无关条文。`,
        },
      });
    }
    const languageEvidence = targetFragments.map((fragment) => fragment.text);
    ([
      ["group_name", target.group_name],
      ["group_reason", target.group_reason],
      ["name", target.name],
      ["lot_basis_summary", target.lot_basis_summary],
      ["reason", target.reason],
    ] as const).forEach(([field, value]) => {
      const mismatch = sourceLanguageMismatch(value, languageEvidence);
      if (!mismatch) return;
      issues.push({
        code: "selector_source_language_mismatch",
        path: `/targets/${index}/${field}`,
        message: "Model-authored target text must use the dominant language of its immutable source evidence",
        details: {
          ...mismatch,
          required_action: "rewrite_user_visible_text_in_source_language_without_translating_source_tokens",
        },
      });
    });
    const compiledTarget = {
      ...(target.semantic_basis ? { semantic_basis: structuredClone(target.semantic_basis) } : {}),
      target_id: targetIds.get(target.key)!,
      group_id: stableId("group", jobId, target.group_key),
      group_name: target.group_name,
      group_reason: target.group_reason,
      name: target.name,
      description: [target.name, target.lot_basis_summary].filter(Boolean).join("："),
      work_scope: {
        start_line: Math.min(...lines.map(line => line.start)),
        end_exclusive_line: Math.max(...lines.map(line => line.end)),
        source_sha256: evidence.source.sha256,
        primary_fragments: primary,
        selection_fragments: scopeSelections,
        reference_fragments: references,
        anchor_fragments: resolveFragments(target.lot_basis_span_ids, "lot_basis_span_ids"),
        source_blocks: sourceBlocks,
        reason: target.reason,
      },
      evidence_atom_ids: unique(targetFragments.map((fragment) => fragment.atom_id)),
      evidence_fragments: targetFragments,
      materialization: {
        kind: "inspection_scope" as const,
        lot_basis_summary: target.lot_basis_summary,
        lot_basis_fragments: lotBasisFragments,
        reason: target.reason,
      },
      reason: target.reason,
    };
    try { confirmedTargetScope(compiledTarget, evidence); }
    catch (error) {
      if (!(error instanceof TargetScopeConflict)) throw error;
      issues.push({ code: error.code, path: `/targets/${index}/scope_span_ids`, message: String(error.details.message), details: error.details });
    }
    return compiledTarget;
  });
  for (const { left_index: leftIndex, right_index: rightIndex, ...conflict } of primaryTargetOverlaps(targets, evidence)) {
    // Ledger seeds are unconfirmed proposals. Defer only overlaps involving
    // such a seed; proved targets, final plans and legacy reads remain strict.
    if (options.requireSemanticBasis && semanticBasisPending
      && (!selectors.targets[leftIndex]!.semantic_basis || !selectors.targets[rightIndex]!.semantic_basis)) continue;
    const left = targets[leftIndex]!;
    const right = targets[rightIndex]!;
    issues.push({
      code: "selector_target_primary_overlap",
      path: `/targets/${rightIndex}/source_blocks`,
      message: "两个 target 的 primary source block 包含相同非空原文；共享规则或引用必须放 reference_span_ids，不能靠重叠主范围复用。",
      details: {
        left_target: { index: leftIndex, key: selectors.targets[leftIndex]!.key, name: left.name },
        right_target: { index: rightIndex, key: selectors.targets[rightIndex]!.key, name: right.name },
        overlap: conflict,
        source_atom_ids: evidence.atoms.filter(atom => atom.start_offset < conflict.end && atom.end_offset > conflict.start).map(atom => atom.atom_id),
        writable_paths: [leftIndex, rightIndex].flatMap(index => [
          `/targets/${index}/source_blocks`, `/targets/${index}/scope_span_ids`, `/targets/${index}/reference_span_ids`,
        ]),
        next_tools: ["open_document_atom", "locate_document_span", "read_document_selectors", "edit_document_selectors"],
        required_action: "核对重叠原文和两个受检对象，决定目标归属；修订双方 source_blocks，使同一主资料只有一个所有者。共享规则通过 reference_span_ids 复用。用 read_document_selectors 读取相关记录，再用 edit_document_selectors 提交关联差异；回条带 draft_id 时，两步都继续该待提交草稿。新增或拆分目标时同步收窄旧范围；不得删除真实验收要求或修改编译产物来消错。",
      },
    });
  }

  const contexts = selectors.contexts.map((context, index) => {
    const fragments = resolveMany(context.span_ids, registry, sources, `/contexts/${index}/span_ids`, issues);
    ([
      ["name", context.name],
      ["reason", context.reason],
    ] as const).forEach(([field, value]) => {
      const mismatch = sourceLanguageMismatch(value, fragments.map((fragment) => fragment.text));
      if (!mismatch) return;
      issues.push({
        code: "selector_source_language_mismatch",
        path: `/contexts/${index}/${field}`,
        message: "Model-authored context text must use the dominant language of its immutable source evidence",
        details: {
          ...mismatch,
          required_action: "rewrite_user_visible_text_in_source_language_without_translating_source_tokens",
        },
      });
    });
    return {
      context_id: stableId("context", jobId, context.key),
      role: context.role,
      name: context.name,
      evidence_atom_ids: unique(fragments.map((fragment) => fragment.atom_id)),
      evidence_fragments: fragments,
      reason: context.reason,
    };
  });

  if (options.discoveryScopeCandidates?.length) {
    const candidateRanges = discoveryCandidateRanges(evidence, options.discoveryScopeCandidates).flatMap(({ candidate, start, end }) => {
      if (start === undefined || end === undefined || end <= start) issues.push({
        code: "selector_discovery_window_invalid",
        path: "/targets",
        message: "发现候选的来源范围无效，不能静默忽略该候选。",
        details: { actual: candidate, issue_owner: "harness", required_action: "保留发现草稿并报告底账范围故障；修复底账生成后重新准备发现工作区。不要修改不可变原文、编译产物或伪造 target 消除此错误。" },
      });
      return start !== undefined && end !== undefined && end > start
        ? [{ candidate, start, end }]
        : [];
    });
    const overlaps = (left: { start: number; end: number }, right: { start: number; end: number }) =>
      Math.max(left.start, right.start) < Math.min(left.end, right.end);
    const claimed = new Set<string>();
    targets.forEach((target) => {
      const ranges = target.work_scope.primary_fragments.flatMap(fragment => {
        const atom = evidence.atoms.find(candidate => candidate.atom_id === fragment.atom_id);
        return atom ? [{ start: atom.start_offset + fragment.start, end: atom.start_offset + fragment.end }] : [];
      });
      const touched = candidateRanges.filter(({ start, end }) => ranges.some((range) => overlaps(range, { start, end })));
      touched.forEach(({ candidate }) => claimed.add(candidate.window_id));
    });
    selectors.contexts.forEach((context) => {
      for (const spanId of context.span_ids) {
        const span = registry.spans.find((entry) => entry.span_id === spanId);
        const atom = span ? evidence.atoms.find((entry) => entry.atom_id === span.atom_id) : undefined;
        if (!span || !atom) continue;
        const range = { start: atom.start_offset + span.start, end: atom.start_offset + span.end };
        candidateRanges.filter(({ start, end }) => overlaps(range, { start, end }))
          .forEach(({ candidate }) => claimed.add(candidate.window_id));
      }
    });
    const classifiedWindowCount = candidateRanges.filter(({ candidate }) => claimed.has(candidate.window_id)).length;
    candidateRanges.forEach(({ candidate }) => {
      if (semanticBasisPending || claimed.has(candidate.window_id)) return;
      const coveringAtoms = evidence.atoms
        .filter((atom) => atom.start_line < candidate.end_exclusive_line && atom.end_line >= candidate.start_line)
        .map((atom) => ({
          atom_id: atom.atom_id,
          start_line: atom.start_line,
          end_line: atom.end_line,
          first_line: atom.text.split("\n", 1)[0]!.slice(0, 120),
        }));
      issues.push({
        code: "selector_discovery_window_unclassified",
        path: "/targets",
        message: "发现候选尚未被 target 或有证据的 context 明确归类，需阅读原文后判断，不能静默遗漏。",
        details: {
          window: candidate,
          covering_atoms: coveringAtoms,
          window_classification_progress: {
            classified_windows: classifiedWindowCount,
            total_windows: candidateRanges.length,
          },
          next_tool: "open_document_atom",
          required_action: "covering_atoms 已列出与该窗口行区间相交的全部原子，直接用 open_document_atom 逐个阅读（不需要再用 list_document_atoms 检索定位）。存在具体受检对象时新增一个或多个 target；只有管理、汇总或定义语义时，用 locate_document_span 取得精确依据并新增 context。不要仅靠 atom disposition 排除。",
          context_writable_path: `/contexts/${selectors.contexts.length}`,
        },
      });
    });
  }

  const expectedTargetKeysByAtom = new Map<string, string[]>();
  selectors.targets.forEach((target, targetIndex) => {
    for (const atomId of targets[targetIndex]?.evidence_atom_ids ?? []) {
      const keys = expectedTargetKeysByAtom.get(atomId) ?? [];
      keys.push(target.key);
      expectedTargetKeysByAtom.set(atomId, keys);
    }
  });
  const dispositionByAtom = new Map<string, DocumentTargetPlan["dispositions"][number]>();
  selectors.dispositions.forEach((disposition, index) => {
    if (!semanticBasisPending && disposition.disposition === "pending") issues.push({
      code: "selector_disposition_pending", path: `/dispositions/${index}`,
      message: "此原子仍有待处理的语义判断或目标，草稿可保存但不能提交或封存。",
      details: { actual: disposition, writable_path: `/dispositions/${index}`, next_tools: ["open_document_atom", "patch_document_selectors", "compile_document_selectors"], required_action: "阅读原文并完成目标或 context，再将 disposition 改为 target/context/irrelevant；不要把待办写入最终 context 理由。" },
    });
    const resolved = resolveSourceSpan(registry, disposition.atom_span_id, sources, `/dispositions/${index}/atom_span_id`, issues);
    if (!resolved) return;
    const atom = evidence.atoms.find((candidate) => candidate.atom_id === resolved.atom_id);
    if (!atom || resolved.start !== 0 || resolved.end !== atom.text.length) {
      issues.push({ code: "selector_atom_disposition_not_full_span", path: `/dispositions/${index}/atom_span_id`, message: "Atom disposition must use the registered full-atom span",
        details: { actual: disposition.atom_span_id, atom_id: resolved.atom_id,
          writable_path: `/dispositions/${index}/atom_span_id`, next_tool: "get_document_selector_contract",
          required_action: "Use this atom's registered span_id from full_atom_spans, then replace atom_span_id with patch_document_selectors. A clause or partial span cannot dispose a whole atom. Do not modify source evidence or compiled output." } });
      return;
    }
    if (dispositionByAtom.has(atom.atom_id)) {
      issues.push({ code: "selector_duplicate_atom_disposition", path: `/dispositions/${index}`, message: "Each document atom must have exactly one disposition",
        details: { actual: disposition, atom_id: atom.atom_id, writable_path: `/dispositions/${index}`,
          next_tool: "patch_document_selectors",
          required_action: "Reconcile the decisions for this atom, retain exactly one full-atom disposition, then remove this duplicate array entry. Do not invent another span ID or modify compiled output." } });
      return;
    }
    const expectedKeys = unique(expectedTargetKeysByAtom.get(atom.atom_id) ?? []).sort();
    const ids = expectedKeys.map((key) => targetIds.get(key)!).filter(Boolean);
    if (disposition.disposition === "target" && ids.length === 0) issues.push({
      code: "selector_target_disposition_unbound",
      path: `/dispositions/${index}/disposition`,
      message: "This atom no longer belongs to any target; its remaining context or irrelevant meaning requires an explicit semantic decision.",
      details: {
        atom_id: atom.atom_id,
        actual: disposition,
        writable_path: `/dispositions/${index}`,
        next_tools: ["open_document_atom", "edit_document_selectors"],
        required_action: "Read the atom after removing or narrowing the target, then set disposition=context or irrelevant with a source-grounded reason. target_keys are derived by the harness.",
      },
    });
    const effectiveDisposition = ids.length
      ? "target" as const
      : disposition.disposition === "pending" ? "unreviewed" as const : disposition.disposition;
    dispositionByAtom.set(atom.atom_id, {
      atom_id: atom.atom_id,
      disposition: effectiveDisposition,
      target_ids: ids,
      reason: disposition.reason,
    });
  });
  // Incomplete proof blocks global closure, never the local validation of
  // authored targets, contexts or dispositions alongside unfinished seeds.
  if (semanticBasisPending) throw new DocumentSelectorCompileError(issues);

  for (const atom of evidence.atoms) {
    if (dispositionByAtom.has(atom.atom_id)) continue;
    // Keep source identities in typed fields so the model-view codec can encode
    // them consistently; prose describes the repair without duplicating IDs.
    const fullSpan = registry.spans.find((span) =>
      span.atom_id === atom.atom_id && span.start === 0 && span.end === atom.text.length);
    issues.push({
      code: "selector_atom_unreviewed",
      path: "/dispositions",
      message: "Every document atom must have one final selector disposition",
      details: {
        atom_id: atom.atom_id,
        line_range: { start_line: atom.start_line, end_exclusive_line: atom.end_line },
        excerpt: atom.text.length > 240 ? { preview: atom.text.slice(0, 240), total_characters: atom.text.length, truncated: true } : atom.text,
        ...(fullSpan ? { atom_span_id: fullSpan.span_id } : {}),
        actual: { final_disposition_count: 0, full_atom_span_registered: Boolean(fullSpan) },
        expected: { final_disposition_count: 1, span_scope: "registered_complete_atom", allowed_final_dispositions: ["target", "context", "irrelevant"] },
        writable_paths: ["/dispositions"],
        writable_fields: ["atom_span_id", "disposition", "target_keys", "reason"],
        next_tool: "open_document_atom",
        next_tool_arguments: { atom_id: atom.atom_id },
        next_tools: ["open_document_atom", ...(fullSpan ? [] : ["locate_document_span"]), "edit_document_selectors"],
        required_action: "先用 next_tool_arguments 的 atom_id 调用 open_document_atom，按正文分页读完原文，excerpt 不代替完整阅读。" + (fullSpan
          ? "使用本回条结构化 atom_span_id 登记该完整原子，不要重造句柄。"
          : "当前登记表没有完整原子 span；读完原文后用 locate_document_span 登记整个原子文本，局部句子不能代替完整原子区间。")
          + "然后用 edit_document_selectors 在 dispositions 增量保存完整记录；disposition 由模型按原文选择 target/context/irrelevant，reason 写真实语义依据。target_keys 是由 harness 机械重算的兼容数组，可以提交 []，不要求维护机械镜像。真实 target 内容先在 targets.source_blocks 中保存适用范围；不要用 context/irrelevant 隐藏未完成判断，也不要仅为取得处置重复新增已有 target。回条不替模型决定来源的业务角色。",
        do_not_edit: "不可变原文、登记 span 的来源内容、编译计划及其他已正确的作者处置。",
      },
    });
  }
  if (!selectors.targets.length && !selectors.no_target_reason?.trim()) {
    issues.push({ code: "selector_zero_targets", path: "/no_target_reason", message: "零目标需明确说明全文为何没有可验收对象，不能用空草稿结束。", details: { actual: selectors.no_target_reason ?? null, writable_path: "/no_target_reason", next_tool: "patch_document_selectors", required_action: "阅读全部原子后填写 no_target_reason 并完成 contexts/dispositions；若发现具体对象则添加有证据的 target。" } });
  }
  if (issues.length) throw new DocumentSelectorCompileError(issues);
  return {
    schema_version: "document-target-plan/v4",
    job_id: jobId,
    document_fingerprint: evidence.evidence_fingerprint,
    ...(selectors.no_target_reason ? { no_target_reason: selectors.no_target_reason } : {}),
    targets,
    context_notes: contexts,
    dispositions: evidence.atoms.map((atom) => dispositionByAtom.get(atom.atom_id)!),
  };
}

/**
 * Canonicalize the selector's denormalized atom→target mirror from compiled
 * primary evidence. The model still decides target boundaries and whether an
 * unowned atom is context or irrelevant; it does not maintain a second copy of
 * relations that the compiler can derive exactly.
 */
export function reconcileDocumentSelectorRelations(
  selectors: DocumentSelectorPlan,
  compiled: DocumentTargetPlan,
  registry: SourceSpanRegistry,
): { selectors: DocumentSelectorPlan; changed_disposition_keys: string[] } {
  const targetKeysByAtom = new Map<string, string[]>();
  selectors.targets.forEach((target, index) => {
    for (const atomId of compiled.targets[index]?.evidence_atom_ids ?? []) {
      const keys = targetKeysByAtom.get(atomId) ?? [];
      keys.push(target.key);
      targetKeysByAtom.set(atomId, keys);
    }
  });
  const reconciled = structuredClone(selectors);
  const changed: string[] = [];
  reconciled.dispositions.forEach((disposition) => {
    const span = registry.spans.find((candidate) => candidate.span_id === disposition.atom_span_id);
    if (!span) return;
    const expected = unique(targetKeysByAtom.get(span.atom_id) ?? []).sort();
    const actual = unique(disposition.target_keys).sort();
    const nextDisposition = expected.length ? "target" as const : disposition.disposition;
    if (JSON.stringify(actual) === JSON.stringify(expected) && disposition.disposition === nextDisposition) return;
    disposition.target_keys = expected;
    disposition.disposition = nextDisposition;
    changed.push(disposition.atom_span_id);
  });
  return { selectors: reconciled, changed_disposition_keys: changed };
}

export function documentSelectorFingerprint(selectors: DocumentSelectorPlan): string {
  const { rationale: _rationale, ...facts } = selectors;
  return sha256Text(canonicalize(facts));
}
