import { Type } from "typebox";
import { sha256Text } from "./canonical.js";
import { scanDocumentLedger } from "./document-ledger.js";
import type { ExternalReferenceContentScope, EvidenceRecord, ReferenceOccurrence } from "./contracts.js";
import type { ExternalStandardDocument } from "./external-source-workflow.js";
import type { DocumentReferenceTarget, DocumentReferenceTargetResolution } from "./document-reference.js";

export const ExternalReferenceContentScopeSchema = Type.Object({
  mode: Type.Union([Type.Literal("selected_targets"), Type.Literal("whole_standard")]),
  targets: Type.Optional(Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("clause"), Type.Literal("section"), Type.Literal("table"), Type.Literal("appendix")]),
    number: Type.String({ minLength: 1 }), paragraph: Type.Optional(Type.String({ minLength: 1 })),
    candidate_start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 })),
  reason: Type.String({ minLength: 1, description: "依据当前验收对象说明相关章节和共同要求的选择；不能用缩小范围隐藏已知问题。whole_standard 必须说明为何全文均需逐项处理。" }),
}, { additionalProperties: false, description: "整本标准引用必须先明确本目标的采用范围；选定条/节/表/附录内仍完整校验，原文不被裁改。" });

export function parseExternalReferenceScope(input: unknown): ExternalReferenceContentScope | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const s = input as Record<string, unknown>;
  if (Object.keys(s).some(k => !["mode", "targets", "reason"].includes(k)) || typeof s.reason !== "string" || !s.reason.trim()) return;
  if (s.mode === "whole_standard" && s.targets === undefined) return { mode: s.mode, reason: s.reason.trim() };
  if (s.mode !== "selected_targets" || !Array.isArray(s.targets) || !s.targets.length || s.targets.length > 32) return;
  const targets: NonNullable<ExternalReferenceContentScope["targets"]> = [];
  for (const entry of s.targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const t = entry as Record<string, unknown>;
    if (Object.keys(t).some(k => !["kind", "number", "paragraph", "candidate_start_line"].includes(k))
      || !["clause", "section", "table", "appendix"].includes(String(t.kind)) || typeof t.number !== "string" || !t.number.trim()
      || (t.paragraph !== undefined && (t.kind !== "clause" || typeof t.paragraph !== "string" || !t.paragraph.trim()))
      || (t.candidate_start_line !== undefined && (!Number.isInteger(t.candidate_start_line) || Number(t.candidate_start_line) < 1))) return;
    targets.push({ kind: t.kind as typeof targets[number]["kind"], number: t.number.normalize("NFKC").replace(/\s/gu, ""),
      ...(t.paragraph !== undefined ? { paragraph: String(t.paragraph).trim() } : {}),
      ...(t.candidate_start_line !== undefined ? { candidate_start_line: Number(t.candidate_start_line) } : {}) });
  }
  if (new Set(targets.map(t => JSON.stringify(t))).size !== targets.length) return;
  targets.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return { mode: "selected_targets", targets, reason: s.reason.trim() };
}

export function externalReferenceScopeFeedback(document: ExternalStandardDocument, input: unknown, cursor = 0) {
  const ledger = scanDocumentLedger(document.markdown, `${document.standard_no}.md`);
  const entries = ledger.headings.filter(h => h.number).map(h => ({
    kind: (/^(?:#{1,6}\s*)?附\s*录/u.test(h.text) ? "appendix" : "section"), number: h.number, title: h.title, start_line: h.line,
  }));
  document.markdown.split(/\r?\n/u).forEach((line, index) => {
    const appendix = /^\s*(?:#{1,6}\s*)?(?:附\s*录|Appendix)\s*([A-Z])(?:\s|$)(.*)$/iu.exec(line);
    if (appendix) entries.push({ kind: "appendix", number: appendix[1]!.toUpperCase(), title: appendix[2]!.trim(), start_line: index + 1 });
  });
  for (const table of ledger.tables ?? []) entries.push({ kind: "table", number: table.table_no, title: table.title, start_line: table.line });
  const catalog = [...new Map(entries.map(e => [`${e.kind}:${e.number}:${e.start_line}`, e])).values()].sort((a,b) => a.start_line-b.start_line);
  return { ok: false, error: input === undefined ? "external_reference_scope_required" : "external_reference_scope_invalid",
    source_available: true, occurrence_registered: false, actual: { content_scope: input ?? null },
    source: { standard_no: document.standard_no, markdown_sha256: document.markdown_sha256 },
    scope_catalog: catalog.slice(cursor, cursor + 24), scope_catalog_total: catalog.length, next_scope_catalog_cursor: cursor + 24 < catalog.length ? cursor + 24 : null,
    catalog_is_navigation_only: true, writable_paths: ["/content_scope", "/scope_catalog_cursor"],
    next_tool: "resolve_external_standard_reference", required_action: "choose_source_grounded_business_scope_then_retry",
    how_to_pass: "保留原调用的精确引用及字段。先核对目录与当前验收对象，content_scope 填 selected_targets、真实条/节/表/附录列表及 reason；包括实际适用的共同规则。编号不明确时继续读取目录，不能猜编号。若确需逐项处理全文，显式填 whole_standard 并说明依据。目录只是导航；登记后完整读取选定范围，判断业务采用并保存真实字段。原文明示的其他独立引用仍须分别处理，不能靠本范围排除。",
    instruction: "尚未登记整本标准的业务义务，也未把目录当作正文读取。无需增加预算或逐项排除整本标准；先明确当前目标需要的内容范围。",
    do_not_edit: ["source", "compiler", "sealed_artifacts"] };
}

export function resolveExternalReferenceScope(document: ExternalStandardDocument, scope: ExternalReferenceContentScope,
  resolveTarget: (markdown: string, source: string, target: DocumentReferenceTarget) => DocumentReferenceTargetResolution,
): DocumentReferenceTargetResolution | { ok: false; error: string; [key: string]: unknown } {
  const records = new Map<string, EvidenceRecord>(); const ids = new Set<string>();
  for (const target of scope.targets ?? []) {
    const resolved = resolveTarget(document.markdown, document.markdown_sha256, target);
    if (!resolved.ok) return { ok: false, error: "external_reference_scope_target_not_found", actual: { target, resolution_error: resolved.error },
      candidates: resolved.candidates, occurrence_registered: false, writable_paths: ["/content_scope/targets"],
      next_tool: "resolve_external_standard_reference", required_action: "correct_scope_target_using_actual_source",
      instruction: "此范围未登记，原引用保持原样。按实际目录修正失败的条/节/表/附录编号；若有多个候选，复制真实 candidate_start_line。不得扩大为其他来源或用空范围绕过校验。" };
    resolved.evidence.forEach(record => records.set(record.evidence_id, record));
    resolved.target_evidence_ids.forEach(id => ids.add(id));
  }
  return { ok: true, locator: `standard:${document.standard_no}/scope:${sha256Text(JSON.stringify(scope.targets)).slice(0, 24)}`,
    evidence: [...records.values()], target_evidence_ids: [...ids] };
}

/** Reading a directory subset does not amend an earlier whole-source adoption. */
export function wholeExternalReferenceScopeReview(occurrence: ReferenceOccurrence) {
  if (occurrence.status !== "resolved" || !occurrence.external_standard
    || occurrence.target_address?.locator_kind !== "standard" || occurrence.content_scope?.mode === "selected_targets") return;
  return {
    current_occurrence_id: occurrence.occurrence_id,
    current_content_scope: occurrence.content_scope ?? { mode: "whole_standard", legacy_registration: true },
    resolved_component_count: occurrence.target_evidence_ids.length,
    reader_skip_changes_business_scope: false,
    next_tool: "resolve_external_standard_reference",
    correction_arguments: { standard_no: occurrence.external_standard.standard_no, raw_reference: occurrence.raw_reference,
      replaces_occurrence_id: occurrence.occurrence_id,
      ...(occurrence.origin_span_ids?.length ? { origin_span_ids: occurrence.origin_span_ids }
        : occurrence.origin_span_id ? { origin_span_id: occurrence.origin_span_id } : {}),
      ...(occurrence.reference_literal_span_ids?.length ? { reference_literal_span_ids: occurrence.reference_literal_span_ids }
        : occurrence.reference_literal_span_id ? { reference_literal_span_id: occurrence.reference_literal_span_id } : {}),
      ...(occurrence.origin_fields.length === 1 ? { origin_field: occurrence.origin_fields[0] } : {}),
    },
    required_author_fields: ["content_scope.targets", "content_scope.reason", "correction_reason", "usage", "dependent_fields", "reason", "relation"],
    instruction: "whole_standard 登记的是当前目标要交代整本正文的业务范围，不是先通读目录、再挑相关内容。read_reference_facts 的 skip/skip_rest 只处置阅读目录，不能缩小已登记的业务清单。先依据真实章节核对适用范围；若仅采用部分内容，保留原调用身份字段，使用 resolve_external_standard_reference，填写 selected_targets 的完整真实条/节/表/附录范围（包括适用共同规则）、replaces_occurrence_id 和 correction_reason。需要目录时可在原调用中省略 content_scope 获取导航，此时不会修改原决定。原范围会归档，选定范围内的所有遗漏仍须处理；不能借更正取消原文明示的独立引用或已知真实验收要求。若确实采用全文，保持整本范围并完整交代全部组件。",
  };
}
