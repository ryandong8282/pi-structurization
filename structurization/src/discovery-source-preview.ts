import { sha256Text } from "./canonical.js";
import type { DocumentEvidence } from "./document-discovery.js";
import type { DocumentSelectorPlan } from "./document-selector-compiler.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";

/** Read-only coordinate projection of the submitted blocks; semantic ownership remains authored. */
export function discoverySourceBlockPreview(
  target: DocumentSelectorPlan["targets"][number],
  evidence: DocumentEvidence,
  registry: SourceSpanRegistry,
  openedAtomIds: readonly string[],
) {
  const atoms = new Map(evidence.atoms.map(atom => [atom.atom_id, atom]));
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const opened = new Set(openedAtomIds);
  const blocks = Array.isArray(target?.source_blocks) ? target.source_blocks : [];
  const boundary = (spanId: string) => {
    const span = spans.get(spanId), atom = span && atoms.get(span.atom_id);
    if (!span || !atom || registry.source_fingerprint !== evidence.evidence_fingerprint
      || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > atom.text.length
      || sha256Text(atom.text.slice(span.start, span.end)) !== span.text_sha256) {
      return { span_id: spanId, status: "unavailable" as const };
    }
    const text = atom.text.slice(span.start, span.end);
    return {
      span_id: spanId, atom_id: atom.atom_id, status: "resolved" as const,
      start: span.start, end: span.end,
      start_offset: atom.start_offset + span.start, end_offset: atom.start_offset + span.end,
      start_line: atom.start_line + (atom.text.slice(0, span.start).match(/\n/g)?.length ?? 0),
      end_exclusive_line: atom.start_line + (atom.text.slice(0, span.end).match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1),
      source_read: opened.has(atom.atom_id),
      ...(opened.has(atom.atom_id) ? { source_preview: {
        first_text: text.slice(0, 128), last_text: text.slice(-128),
        total_characters: text.length, truncated: text.length > 256,
      } } : {}),
      read_tool: "open_document_atom", tool_arguments: { atom_id: atom.atom_id },
    };
  };
  return {
    target_key: target?.key,
    ...(!Array.isArray(target?.source_blocks) ? { source_blocks_status: "unavailable", writable_path: "/source_blocks" } : {}),
    source_blocks: blocks.map((block, blockIndex) => {
      if (!block || typeof block !== "object") return { block_index: blockIndex, status: "unavailable", writable_path: `/source_blocks/${blockIndex}` };
      const anchor = boundary(block.anchor_span_id), start = boundary(block.start_span_id);
      const end = boundary(block.end_before_span_id ?? block.end_span_id ?? "");
      const startOffset = start.status === "resolved" ? start.start_offset : undefined;
      const endOffset = end.status === "resolved"
        ? block.end_before_span_id ? end.start_offset : end.end_offset : undefined;
      return {
        block_index: blockIndex, kind: block.kind, reason: block.reason,
        anchor, start, end, end_mode: block.end_before_span_id ? "before_span" : "after_span",
        ...(start.status === "resolved" && end.status === "resolved" && startOffset !== undefined && endOffset !== undefined ? { materialized_range: {
          start_offset: startOffset, end_exclusive_offset: endOffset,
          start_line: start.start_line,
          end_exclusive_line: block.end_before_span_id ? end.start_line : end.end_exclusive_line,
          ordered: endOffset > startOffset,
          ...(anchor.status === "resolved" ? { characters_before_anchor: Math.max(0, anchor.start_offset - startOffset) } : {}),
        } } : {}),
      };
    }),
    instruction: "这是当前 source_blocks 实际选中的物理边界；start 取起点 span 的开头，end 取终点 span 的末尾，end_before 取其开头。原文片段只展示本会话已打开的 atom。用 open_document_atom 阅读完整原文，对照 semantic_basis 和边界理由，自主确认或通过 edit_document_selectors 修订来源范围；锚点之前的文字也会进入 primary。",
  };
}
