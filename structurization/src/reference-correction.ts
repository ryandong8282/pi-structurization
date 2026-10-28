import { referenceOccurrenceLiterals, type EvidenceManifest, type ReferenceOccurrence, type ReferenceCorrectionRecord } from "./contracts.js";
import { normalizeStandardNo } from "./external-source-workflow.js";
import { Type } from "typebox";

export const REFERENCE_CORRECTION_FIELDS = {
  replaces_occurrence_id: Type.Optional(Type.String({ minLength: 1, description: "更正同一处原文的旧有效引用时填写其 occurrence_id。旧决定保留历史，不得替换其他原文。" })),
  correction_reason: Type.Optional(Type.String({ minLength: 1, description: "依据原文说明旧范围、定位或采用方式为何需要更正。" })),
};

export interface ReferenceCorrectionRequest { replaces_occurrence_id?: string; correction_reason?: string }
export interface ReferenceCorrectionPlan {
  ok: true; superseded_ids: string[];
  archive?: { previous_occurrence_id: string; reason: string };
  receipt?: { status: "applied" | "already_applied"; previous_occurrence_id: string; replacement_occurrence_id: string; reason: string };
}

function sameLiteral(left: ReferenceOccurrence, right: ReferenceOccurrence) {
  const a = referenceOccurrenceLiterals(left), b = referenceOccurrenceLiterals(right);
  return a.length > 0 && JSON.stringify(a) === JSON.stringify(b);
}
function sameStandard(left: ReferenceOccurrence, right: ReferenceOccurrence) {
  return Boolean(left.external_standard && right.external_standard
    && normalizeStandardNo(left.external_standard.standard_no) === normalizeStandardNo(right.external_standard.standard_no));
}

export function planReferenceCorrection(manifest: EvidenceManifest, candidate: ReferenceOccurrence,
  request: ReferenceCorrectionRequest, history: readonly ReferenceCorrectionRecord[] = []): ReferenceCorrectionPlan | { ok: false; error: string; [key: string]: unknown } {
  const tool = candidate.external_standard ? "resolve_external_standard_reference" : "resolve_document_reference";
  const reject = (error: string, actual: unknown, instruction: string) => ({ ok: false as const, error, actual,
    occurrence_registered: false, writable_paths: ["/replaces_occurrence_id", "/correction_reason", "/origin_span_id", "/reference_literal_span_id"],
    next_tool: tool, required_action: "correct_reference_request_with_exact_prior_identity",
    instruction, do_not_edit: ["source", "compiler", "sealed_artifacts", "historical_counters"] });
  const priorId = request.replaces_occurrence_id;
  if (!priorId) {
    const conflict = manifest.reference_occurrences.find(old => old.occurrence_id !== candidate.occurrence_id
      && sameLiteral(old, candidate) && sameStandard(old, candidate) && old.status === "resolved"
      && (old.external_standard?.usage !== candidate.external_standard?.usage
        || (old.target_address?.locator_kind === "standard" && (candidate.target_address?.locator_kind === "standard" || !old.content_scope))));
    if (conflict) return reject("reference_correction_required", { current_occurrence_id: conflict.occurrence_id,
      current_usage: conflict.external_standard?.usage, requested_usage: candidate.external_standard?.usage },
      "同一处原文已有不同的有效引用决定。本次没有新增或替换记录。若确需更正，复制 current_occurrence_id 到 replaces_occurrence_id，填写有原文依据的 correction_reason 后重试；另一独立引用必须使用其自己的精确来源。更正不会改写业务草稿或清零历史计数。" );
    return { ok: true, superseded_ids: [] };
  }
  if (!request.correction_reason?.trim()) return reject("reference_correction_reason_required", { replaces_occurrence_id: priorId },
    "保留 replaces_occurrence_id，补充依据原文更正采用方式或适用范围的 correction_reason；不是为消除报错而删除引用。" );
  const previous = manifest.reference_occurrences.find(old => old.occurrence_id === priorId);
  if (!previous) {
    const archived = [...history].reverse().find(row => row.previous_occurrence.occurrence_id === priorId);
    const active = manifest.reference_occurrences.find(row => row.occurrence_id === candidate.occurrence_id);
    if (archived && active && archived.replacement_occurrence_id === candidate.occurrence_id
      && JSON.stringify(active.target_evidence_ids) === JSON.stringify(candidate.target_evidence_ids)
      && active.external_standard?.usage === candidate.external_standard?.usage && sameLiteral(active, candidate)) {
      return { ok: true, superseded_ids: [], receipt: { status: "already_applied", previous_occurrence_id: priorId,
        replacement_occurrence_id: active.occurrence_id, reason: archived.reason } };
    }
    return reject("reference_correction_stale", { replaces_occurrence_id: priorId,
      replacement_occurrence_id: archived?.replacement_occurrence_id, active_occurrence_ids: manifest.reference_occurrences.map(row => row.occurrence_id) },
      "待更正记录不是当前有效引用。先用 list_reference_occurrences 核对 active_occurrence_ids，再读取现有作者记录；不要用过期决定覆盖后续更正。" );
  }
  if (!sameLiteral(previous, candidate) || (Boolean(previous.external_standard || candidate.external_standard) && !sameStandard(previous, candidate))) {
    return reject("reference_correction_origin_mismatch", { previous_occurrence_id: priorId,
      expected_literals: referenceOccurrenceLiterals(previous), actual_literals: referenceOccurrenceLiterals(candidate),
      expected_standard: previous.external_standard?.standard_no, actual_standard: candidate.external_standard?.standard_no },
      "更正只能作用于同一处精确原文及同一标准身份。修正引用 span 或 replaces_occurrence_id；不同原文或不同标准不得互相替换。" );
  }
  if (previous.external_standard?.markdown_sha256 && candidate.external_standard?.markdown_sha256
    && previous.external_standard.markdown_sha256 !== candidate.external_standard.markdown_sha256) {
    return reject("reference_correction_source_changed", { previous_source_sha256: previous.external_standard.markdown_sha256,
      requested_source_sha256: candidate.external_standard.markdown_sha256 },
      "同一检查点的已接入原文指纹发生变化，不能把换正文伪装成范围更正。恢复原版本及指纹，或创建独立可写修订版；原决定、已接入原文及历史计数保持原样。" );
  }
  if (previous.target_address?.locator_kind !== "standard" && candidate.content_scope) {
    return reject("reference_correction_explicit_target_required", { previous_target: previous.target_address },
      "原引用已明确到具体条、节、表或附录，不能把它改成整本标准的自选子集。保留原文明示位置，按真实来源更正该具体目标。" );
  }
  return { ok: true, superseded_ids: [priorId], archive: { previous_occurrence_id: priorId, reason: request.correction_reason.trim() },
    receipt: { status: "applied", previous_occurrence_id: priorId, replacement_occurrence_id: candidate.occurrence_id, reason: request.correction_reason.trim() } };
}
