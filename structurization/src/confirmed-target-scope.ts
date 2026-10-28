import { sha256Text, sha256Json } from "./canonical.js";
import type { DocumentEvidence, DocumentTarget } from "./document-discovery.js";

export interface TargetSourceFragment {
  atom_id: string;
  start: number;
  end: number;
  text: string;
  text_sha256: string;
}

export interface ConfirmedWorkScope {
  start_line: number;
  end_exclusive_line: number;
  source_sha256?: string;
  primary_fragments?: TargetSourceFragment[];
  selection_fragments?: TargetSourceFragment[];
  reference_fragments?: TargetSourceFragment[];
  anchor_fragments?: TargetSourceFragment[];
  source_blocks?: TargetSourceBlock[];
  reason?: string;
}

export interface TargetSourceBlock {
  kind: "heading_section" | "explicit_range";
  anchor_fragment?: TargetSourceFragment;
  start_fragment?: TargetSourceFragment;
  end_fragment?: TargetSourceFragment;
  end_before_fragment?: TargetSourceFragment;
  reason: string;
}

export class TargetScopeConflict extends Error {
  readonly code = "target_scope_revision_required";
  constructor(public readonly details: Record<string, unknown>) {
    super(`target_scope_revision_required: ${JSON.stringify(details)}`);
  }
}

/** Compare source coordinates only. References may be shared; primary ownership may not. */
export function primaryTargetOverlaps(targets: readonly DocumentTarget[], document: DocumentEvidence) {
  const atoms = new Map(document.atoms.map(atom => [atom.atom_id, atom]));
  const text = [...document.atoms].sort((a, b) => a.start_offset - b.start_offset).map(atom => atom.text).join("");
  const lineOffsets = [0];
  for (const match of text.matchAll(/\n/g)) lineOffsets.push(match.index! + 1);
  lineOffsets.push(text.length);
  const ranges = targets.map(target => {
    const scope = target.work_scope;
    if (scope?.primary_fragments) return scope.primary_fragments.flatMap(fragment => {
      const atom = atoms.get(fragment.atom_id);
      return atom && atom.text.slice(fragment.start, fragment.end) === fragment.text
        ? [{ start: atom.start_offset + fragment.start, end: atom.start_offset + fragment.end }] : [];
    });
    // Older work-scope plans declare line ranges, not selector source blocks.
    const start = scope ? lineOffsets[scope.start_line - 1] : undefined;
    const end = scope ? lineOffsets[scope.end_exclusive_line - 1] : undefined;
    return start !== undefined && end !== undefined && end > start ? [{ start, end }] : [];
  });
  const overlaps: Array<{ left_index: number; right_index: number; start: number; end: number }> = [];
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      let found = false;
      for (const a of ranges[left]!) {
        for (const b of ranges[right]!) {
          const start = Math.max(a.start, b.start);
          const end = Math.min(a.end, b.end);
          if (end > start && /\S/u.test(text.slice(start, end))) {
            overlaps.push({ left_index: left, right_index: right, start, end });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
  }
  return overlaps;
}

function conflictPreview(value: unknown): unknown {
  if (typeof value === "string") return value.length > 768 ? { preview: value.slice(0, 768), total_characters: value.length, truncated: true } : value;
  if (Array.isArray(value)) return value.length > 8
    ? { entries: value.slice(0, 8).map(conflictPreview), total_count: value.length, truncated: true }
    : value.map(conflictPreview);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, conflictPreview(child)]));
  return value;
}

/** 只核验 Agent 提交的来源坐标；不从标题、编号或业务名称推断范围。 */
export function confirmedTargetScope(
  target: DocumentTarget,
  document: DocumentEvidence,
  proposed?: { start_line: number; end_exclusive_line: number },
) {
  const scope = target.work_scope;
  const fail = (reason: string, actual: unknown): never => {
    throw new TargetScopeConflict({
      owner: "document_discovery_agent",
      target_id: target.target_id,
      original_task: conflictPreview({ name: target.name, description: target.description, reason: target.reason }),
      anchors: conflictPreview(target.materialization.lot_basis_fragments),
      actual: conflictPreview(actual),
      proposed_range: proposed ?? null,
      message: reason,
      writable_paths: ["/targets/<index>/scope_span_ids", "/targets/<index>/source_blocks", "/targets/<index>/reference_span_ids", "/targets/<index>/lot_basis_span_ids", "/targets/<index>/reason"],
      next_tools: ["read_document_selectors", "open_document_atom", "locate_document_span", "patch_document_selectors", "compile_document_selectors"],
      instruction: "请目标发现或范围修订 Agent 核对原任务、锚点和冲突原文，明确选择全部主资料片段及参考片段，再提交修订并验证。程序不会猜测适用范围。旧封存计划须先建立可写的发现修订，不能修改下游 evidence 或已封存结果。",
    });
  };
  if (!scope || !Array.isArray(scope.primary_fragments) || !scope.primary_fragments.length
    || typeof scope.reason !== "string" || !scope.reason.trim()) {
    fail("目标缺少 Agent 明确提交的完整主资料范围；旧标题锚点不能自动扩成上一节，也不能当作完整抽取范围。", scope ?? null);
  }
  const blockFragments = Array.isArray(scope!.source_blocks) ? scope!.source_blocks.flatMap(block => [
    block.anchor_fragment,
    block.start_fragment,
    block.end_fragment,
    block.end_before_fragment,
  ].filter((fragment): fragment is TargetSourceFragment => Boolean(fragment))) : [];
  const fragments = [...scope!.primary_fragments!, ...(Array.isArray(scope!.selection_fragments) ? scope!.selection_fragments : []), ...(Array.isArray(scope!.reference_fragments) ? scope!.reference_fragments : []), ...(Array.isArray(scope!.anchor_fragments) ? scope!.anchor_fragments : []), ...blockFragments];
  if ((scope!.reference_fragments !== undefined && !Array.isArray(scope!.reference_fragments))
    || (scope!.selection_fragments !== undefined && !Array.isArray(scope!.selection_fragments))
    || (scope!.anchor_fragments !== undefined && !Array.isArray(scope!.anchor_fragments))
    || !Array.isArray(scope!.source_blocks) || scope!.source_blocks.length === 0
    || fragments.some(fragment => !fragment || typeof fragment.atom_id !== "string" || typeof fragment.text !== "string")
    || !Array.isArray(target.materialization.lot_basis_fragments)) {
    fail("来源范围记录形状不完整；每个主资料连续块都必须带 source_blocks 边界，主资料、参考、锚点和边界必须是精确原文坐标。", scope);
  }
  if (scope!.source_sha256 !== document.source.sha256) fail("目标范围与当前原文版本不一致。", scope!.source_sha256);
  const atoms = new Map(document.atoms.map(atom => [atom.atom_id, atom]));
  const orderedAtoms = [...document.atoms].sort((left, right) => left.start_offset - right.start_offset);
  let documentText = "";
  for (const atom of orderedAtoms) {
    if (atom.start_offset !== documentText.length || atom.end_offset !== atom.start_offset + atom.text.length) {
      fail("全文原子坐标不连续，无法核验目标结构范围。", {
        atom_id: atom.atom_id,
        expected_start_offset: documentText.length,
        actual_start_offset: atom.start_offset,
        actual_end_offset: atom.end_offset,
      });
    }
    documentText += atom.text;
  }
  const validateFragment = (fragment: TargetSourceFragment, role: string) => {
    const atom = atoms.get(fragment.atom_id);
    if (!atom || !Number.isInteger(fragment.start) || !Number.isInteger(fragment.end)
      || fragment.start < 0 || fragment.end <= fragment.start || fragment.end > atom.text.length
      || atom.text.slice(fragment.start, fragment.end) !== fragment.text
      || sha256Text(fragment.text) !== fragment.text_sha256) {
      return fail(`${role}片段的坐标、原文或摘要校验失败。`, fragment);
    }
    return atom;
  };
  const absoluteInterval = (fragment: TargetSourceFragment, role: string) => {
    const atom = validateFragment(fragment, role);
    return { start: atom.start_offset + fragment.start, end: atom.start_offset + fragment.end };
  };
  const ranges = scope!.primary_fragments!.map((fragment) => {
    const atom = validateFragment(fragment, "主资料");
    const before = atom.text.slice(0, fragment.start);
    const start = atom.start_line + (before.match(/\n/g)?.length ?? 0);
    const end = start + (fragment.text.match(/\n/g)?.length ?? 0) + (fragment.text.endsWith("\n") ? 0 : 1);
    return { start_line: start, end_exclusive_line: end };
  });
  for (const fragment of [...(scope!.reference_fragments ?? []), ...(scope!.anchor_fragments ?? []), ...blockFragments]) validateFragment(fragment, "参考或边界");
  const primaryIntervals = scope!.primary_fragments!.map(fragment => {
    const atom = atoms.get(fragment.atom_id)!;
    return { start: atom.start_offset + fragment.start, end: atom.start_offset + fragment.end };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < primaryIntervals.length; index += 1) {
    if (primaryIntervals[index]!.start < primaryIntervals[index - 1]!.end) {
      fail("主资料 span 重复或重叠；请删除重复范围，避免同一原文生成两份 evidence。", {
        previous: primaryIntervals[index - 1], current: primaryIntervals[index],
      });
    }
  }
  const uncoveredAgainst = (
    coverage: Array<{ start: number; end: number }>,
    start: number,
    end: number,
  ): { start: number; end: number; text: string } | undefined => {
    let cursor = start;
    for (const interval of coverage) {
      if (interval.end <= cursor || interval.start >= end) continue;
      const gapEnd = Math.min(interval.start, end);
      const gap = documentText.slice(cursor, gapEnd);
      const first = gap.search(/\S/u);
      if (first >= 0) {
        const missingStart = cursor + first;
        const missingEnd = Math.min(end, missingStart + 240);
        return { start: missingStart, end: missingEnd, text: documentText.slice(missingStart, missingEnd) };
      }
      cursor = Math.max(cursor, interval.end);
      if (cursor >= end) return undefined;
    }
    const tail = documentText.slice(cursor, end);
    const first = tail.search(/\S/u);
    return first < 0 ? undefined : {
      start: cursor + first,
      end: Math.min(end, cursor + first + 240),
      text: documentText.slice(cursor + first, Math.min(end, cursor + first + 240)),
    };
  };
  const allowedPrimaryIntervals: Array<{ start: number; end: number }> = [];
  for (const [blockIndex, block] of scope!.source_blocks!.entries()) {
    if (!block || !["heading_section", "explicit_range"].includes(block.kind)
      || typeof block.reason !== "string" || !block.reason.trim()
      || !block.anchor_fragment || !block.start_fragment
      || Boolean(block.end_fragment) === Boolean(block.end_before_fragment)) {
      fail("source block 必须声明类型、理由、锚点、起点，以及且仅一个 end_span/end_before_span。", { block_index: blockIndex, block });
    }
    const anchor = absoluteInterval(block.anchor_fragment!, "块锚点");
    const startBoundary = absoluteInterval(block.start_fragment!, "块起点");
    const endBoundary = block.end_before_fragment
      ? absoluteInterval(block.end_before_fragment, "块后继边界").start
      : absoluteInterval(block.end_fragment!, "块终点").end;
    const interval = { start: startBoundary.start, end: endBoundary };
    if (interval.end <= interval.start) fail("source block 的终点必须位于起点之后。", { block_index: blockIndex, interval });
    if (anchor.start < interval.start || anchor.end > interval.end) {
      fail("source block 的任务锚点必须落在该块边界内。", { block_index: blockIndex, anchor, interval });
    }
    const logicalBlocks = block.anchor_fragment!.text.split(/\r?\n\s*\r?\n/u).filter(value => value.trim());
    if (anchor.start === interval.start && anchor.end === interval.end && logicalBlocks.length > 1) {
      fail("任务锚点不能等同于整块多段原文；请定位标题、领起句、表题或判据句，块边界继续单独提交。", { block_index: blockIndex, logical_block_count: logicalBlocks.length });
    }
    allowedPrimaryIntervals.push(interval);
    const missing = uncoveredAgainst(primaryIntervals, interval.start, interval.end);
    if (missing) {
      fail("已声明 source block 内存在未提交的非空主资料；不能只选标题、部分条文或末行。", {
        block_index: blockIndex,
        source_block: interval,
        first_uncovered_source: missing,
        primary_fragments: scope!.primary_fragments,
      });
    }
  }
  allowedPrimaryIntervals.sort((left, right) => left.start - right.start);
  for (let index = 1; index < allowedPrimaryIntervals.length; index += 1) {
    if (allowedPrimaryIntervals[index]!.start < allowedPrimaryIntervals[index - 1]!.end) {
      fail("source_blocks 彼此重叠；每段主资料必须恰好属于一个边界块。", {
        previous: allowedPrimaryIntervals[index - 1], current: allowedPrimaryIntervals[index],
      });
    }
  }
  const offsetToLine = (offset: number): number => {
    for (const atom of orderedAtoms) {
      if (offset < atom.start_offset || offset > atom.end_offset) continue;
      return atom.start_line + (atom.text.slice(0, Math.min(offset - atom.start_offset, atom.text.length)).match(/\n/g)?.length ?? 0);
    }
    return 1;
  };
  const containmentDiagnosis = (interval: { start: number; end: number }) => {
    const perBlock = allowedPrimaryIntervals.map(block => {
      const overlapStart = Math.max(block.start, interval.start);
      const overlapEnd = Math.min(block.end, interval.end);
      return overlapEnd > overlapStart
        ? { block, overlap_chars: overlapEnd - overlapStart }
        : { block, gap_chars: interval.start >= block.end ? interval.start - block.end : block.start - interval.end };
    });
    const overlapCount = perBlock.filter(entry => entry.overlap_chars !== undefined).length;
    return {
      interval_lines: {
        start_line: offsetToLine(interval.start),
        end_exclusive_line: offsetToLine(interval.end),
      },
      interval_text: documentText.slice(interval.start, Math.min(interval.end, interval.start + 240)),
      verdict: overlapCount === 0 ? "outside_all_declared_blocks" : "crosses_block_boundary",
      per_block_overlap_or_gap: perBlock,
    };
  };
  for (const interval of primaryIntervals) {
    const owners = allowedPrimaryIntervals.filter(block => interval.start >= block.start && interval.end <= block.end);
    if (owners.length !== 1) {
      fail("主资料必须完整且只落入一个已声明 source block；不能用整 atom 带入块前后原文。", {
        primary_interval: interval,
        owner_count: owners.length,
        allowed_anchored_structures: allowedPrimaryIntervals,
        diagnosis: containmentDiagnosis(interval),
      });
    }
  }
  const selectionIntervals = (scope!.selection_fragments ?? []).map(fragment => absoluteInterval(fragment, "主资料选择")).sort((left, right) => left.start - right.start);
  for (let index = 1; index < selectionIntervals.length; index += 1) {
    if (selectionIntervals[index]!.start < selectionIntervals[index - 1]!.end) {
      fail("scope_span_ids 重复或重叠；只保留用于说明选择的最小精确 span。", {
        previous: selectionIntervals[index - 1], current: selectionIntervals[index],
      });
    }
  }
  for (const interval of selectionIntervals) {
    const owners = allowedPrimaryIntervals.filter(block => interval.start >= block.start && interval.end <= block.end);
    if (owners.length !== 1) {
      fail("scope_span_ids 必须位于且只位于一个 source block 内；不能提交越过块边界的整 atom。", {
        selection_interval: interval, owner_count: owners.length, source_blocks: allowedPrimaryIntervals,
        diagnosis: containmentDiagnosis(interval),
      });
    }
  }
  const envelope = { start_line: Math.min(...ranges.map(r => r.start_line)), end_exclusive_line: Math.max(...ranges.map(r => r.end_exclusive_line)) };
  if (scope!.start_line !== envelope.start_line || scope!.end_exclusive_line !== envelope.end_exclusive_line
    || (proposed && (proposed.start_line !== envelope.start_line || proposed.end_exclusive_line !== envelope.end_exclusive_line))) {
    fail("准备范围与 Agent 已提交的来源范围冲突。", { confirmed_ranges: ranges, scope, proposed });
  }
  return { ...envelope, ranges, fragments: scope!.primary_fragments!, fingerprint: sha256Json(scope) };
}
