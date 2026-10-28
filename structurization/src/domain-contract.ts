import {
  type AcceptanceItemField,
  type AcceptanceItemFieldBindings,
  type EvidenceManifest,
  type EvidenceRecord,
  type FieldSourceBinding,
  type SamplingOccurrence,
  type SamplingOccurrenceScope,
} from "./contracts.js";
import { sha256Text } from "./canonical.js";

const EXPLICIT_QUANTITY_PATTERN =
  /(?:不[应得宜可]少于|不得少于|至少|不低于|不小于|应为|每[^。；，,]{0,24}(?:点|处|根|组|件|批|个|幅|口|套|断面)|\d+(?:\.\d+)?\s*%|全数)/;
const SAMPLING_ACTION_PATTERN =
  /(?:检查数量|检验数量|检测数量|抽样数量|抽检数量|抽查数量|抽检|抽查|取芯数量|试验数量|检验桩数|检测桩数)/;
const REFERENCE_PATTERN =
  /(?:按|按照|执行|规定).{0,80}(?:第\s*\d+(?:\.\d+){1,2}\s*条|GB\s*\d+|JGJ\s*\d+|标准|规范)|(?:第\s*\d+(?:\.\d+){1,2}\s*条|GB\s*\d+|JGJ\s*\d+|标准|规范).{0,80}(?:按|按照|执行|规定)/i;
const NOT_SAMPLING_PATTERN =
  /(?:无需|不需|不进行|不适用).{0,12}(?:抽样|抽检|抽查|数量检验)/;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function referencedSources(text: string): string[] {
  return unique([
    ...[...text.matchAll(/(?:第\s*)?(\d+\.\d+(?:\.\d+)?)\s*(?:条|节)?/g)]
      .map((match) => match[1]!),
    ...[...text.matchAll(/\b(?:GB|JGJ)\s*\d+(?:\.\d+)?\b/gi)]
      .map((match) => match[0]!.replace(/\s+/g, " ").toUpperCase()),
  ]);
}

function extractCondition(text: string): string {
  return [
    /((?:当|在)[^。；;]{1,80}?时)/,
    /((?:设计等级|地质条件|总数|总桩数)[^。；;]{1,80}?(?:时|情况下))/,
  ].map((pattern) => pattern.exec(text)?.[1] ?? "").find(Boolean) ?? "";
}

function extractQuantity(text: string): string {
  const sentences = text
    .split(/[。；;]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      SAMPLING_ACTION_PATTERN.test(sentence)
      && EXPLICIT_QUANTITY_PATTERN.test(sentence)
    );
  return sentences.join("；");
}

function extractObjects(text: string): string[] {
  const objects: string[] = [];
  for (const match of text.matchAll(
    /([^。；，,]{2,40}?)(?:的)?(?:检查数量|检验数量|检测数量|抽样数量|抽检数量|抽查数量|取芯数量|试验数量|检验桩数|检测桩数)/g,
  )) {
    const value = match[1]!
      .replace(/^\d+(?:\.\d+){2}\s*/, "")
      .replace(/^(?:且|并|同时|其中|对|当|在)\s*/, "")
      .trim();
    if (value) objects.push(value);
  }
  return unique(objects);
}

export function classifySamplingOccurrence(
  clauseId: string,
  text: string,
  sourceOrder: number,
  scope: SamplingOccurrenceScope,
): SamplingOccurrence | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  let kind: SamplingOccurrence["kind"] | undefined;
  if (NOT_SAMPLING_PATTERN.test(normalized)) {
    kind = "not_sampling";
  } else if (
    SAMPLING_ACTION_PATTERN.test(normalized)
    && EXPLICIT_QUANTITY_PATTERN.test(normalized)
  ) {
    kind = "explicit_quantity";
  } else if (
    SAMPLING_ACTION_PATTERN.test(normalized)
    && REFERENCE_PATTERN.test(normalized)
  ) {
    kind = "reference";
  }
  if (!kind) return undefined;

  return {
    occurrence_id: `sampling:${sha256Text(
      `${clauseId}|${sourceOrder}|${kind}|${normalized}`,
    )}`,
    kind,
    clause_id: clauseId,
    objects: extractObjects(normalized),
    condition: extractCondition(normalized),
    quantity: kind === "explicit_quantity" ? extractQuantity(normalized) : "",
    scope,
    references: referencedSources(normalized),
    source_order: sourceOrder,
  };
}

function evidenceFragments(
  value: string,
  evidenceIds: string[],
  evidenceById: Map<string, EvidenceRecord>,
): { evidence_id: string; text: string }[] {
  if (!value) return [];
  const exact = evidenceIds.find((evidenceId) =>
    evidenceById.get(evidenceId)?.text.includes(value)
  );
  if (exact) return [{ evidence_id: exact, text: value }];

  const parts = unique(value.split(/\s*\/\s*|\s+/))
    .filter((part) => part.length > 0);
  const fragments: { evidence_id: string; text: string }[] = [];
  for (const part of parts) {
    const evidenceId = evidenceIds.find((candidate) =>
      evidenceById.get(candidate)?.text.includes(part)
    );
    if (evidenceId) fragments.push({ evidence_id: evidenceId, text: part });
  }
  if (fragments.length) return fragments;

  const fallbackId = evidenceIds[0];
  const fallbackText = fallbackId ? evidenceById.get(fallbackId)?.text : undefined;
  return fallbackId && fallbackText
    ? [{ evidence_id: fallbackId, text: fallbackText }]
    : [];
}

export function buildFieldBinding(
  value: string,
  evidenceIds: string[],
  manifest: EvidenceManifest,
  reason: string,
): FieldSourceBinding {
  if (!value) {
    return {
      status: "not_applicable",
      composition: "not_applicable",
      evidence_ids: [],
      source_fragments: [],
      value_sha256: sha256Text(""),
      reason,
    };
  }
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  const fragments = evidenceFragments(value, evidenceIds, evidenceById);
  return {
    status: fragments.length ? "bound" : "not_found_in_evidence",
    composition: "verbatim",
    evidence_ids: unique(fragments.map((fragment) => fragment.evidence_id)),
    source_fragments: fragments,
    value_sha256: sha256Text(value),
    reason,
  };
}

export function buildItemFieldBindings(
  fields: Record<AcceptanceItemField, string>,
  evidenceIds: string[],
  manifest: EvidenceManifest,
): AcceptanceItemFieldBindings {
  return {
    name: buildFieldBinding(fields.name, evidenceIds, manifest, "项目名称来自正式表数据行"),
    requirement: buildFieldBinding(
      fields.requirement,
      evidenceIds,
      manifest,
      "验收要求来自正式表数据行",
    ),
    method: buildFieldBinding(fields.method, evidenceIds, manifest, "检查方法来自正式表数据行"),
    quantity: buildFieldBinding(fields.quantity, evidenceIds, manifest, "数量字段按证据显式绑定"),
    note: buildFieldBinding(fields.note, evidenceIds, manifest, "备注字段按证据显式绑定"),
  };
}
