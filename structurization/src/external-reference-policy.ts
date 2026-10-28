import type { EvidenceManifest, ReferenceLiteralCoordinate } from "./contracts.js";
import { normalizeStandardNo } from "./external-source-workflow.js";
import { renderedTableCellSpans } from "./source-span-registry.js";

type ReferenceField = "allowable_deviation" | "acceptance_basis" | "unclassified";

/** Use the citation's actual cell and nearby field labels, not the author's claimed output field. */
export function externalReferenceFieldPolicy(
  manifest: Pick<EvidenceManifest, "evidence">,
  literals: readonly ReferenceLiteralCoordinate[],
): { field: ReferenceField; literal_only: boolean } {
  const labelRole = (text: string): ReferenceField => {
    const label = text.replace(/\s+/gu, "");
    if (/^验收依据[：:]?$/u.test(label)) return "acceptance_basis";
    // These are alternative labels for the form's requirement/deviation field.
    if (/^(?:设计要求及规范规定|质量检验标准)[：:]?$/u.test(label)) return "allowable_deviation";
    if (label.includes("允许偏差") && !/[《》；;。/]/u.test(label)) return "allowable_deviation";
    return "unclassified";
  };
  const roles = literals.map(literal => {
    const record = manifest.evidence.find(row => row.evidence_id === literal.evidence_id);
    if (!record || !Number.isInteger(literal.start) || !Number.isInteger(literal.end)
      || literal.start < 0 || literal.end <= literal.start || literal.end > record.text.length) return "unclassified";
    const cells = renderedTableCellSpans(record);
    const selected = cells.filter(cell => cell.start < literal.end && cell.end > literal.start);
    if (!selected.length) {
      // Only an explicit field prefix is meaningful in prose; a cited title is not a label.
      const prefix = record.text.slice(0, literal.start).match(/(?:^|[。；;\n])\s*(验收依据|允许偏差)\s*[：:][^。；;\n]*$/u);
      return prefix ? labelRole(prefix[1]!) : "unclassified";
    }
    const localHeaders = record.table_id || record.table_fragment_id ? manifest.evidence.filter(row =>
      row.table_id === record.table_id && row.table_fragment_id === record.table_fragment_id
      && row.evidence_scope === record.evidence_scope && row.row_index !== undefined
      && record.row_index !== undefined && row.row_index < record.row_index
      && renderedTableCellSpans(row).some(cell => /^(?:验收|检验|检查)?项目$/u.test(cell.text.replace(/\s+/gu, ""))))
      .sort((a, b) => b.row_index! - a.row_index!) : [];
    const cellRoles = selected.map(cell => {
      const inlineLabel = cell.text.match(/^\s*(验收依据|允许偏差)\s*[：:]/u);
      if (inlineLabel) return labelRole(inlineLabel[1]!);
      // A form's row label overrides unrelated inherited headers from earlier rows.
      for (const preceding of [...cells].reverse()) {
        if (preceding.column_index >= cell.column_index) continue;
        const role = labelRole(preceding.text);
        if (role !== "unclassified") return role;
      }
      // Canonical nearby header cells are more specific than the parser's merged
      // administrative headers. Never borrow labels from another table or scope.
      const header = localHeaders[0];
      if (header) {
        const label = renderedTableCellSpans(header).find(candidate => candidate.column_index === cell.column_index);
        if (label) return labelRole(label.text);
      }
      return labelRole(cell.label);
    });
    if (cellRoles.includes("acceptance_basis")) return "acceptance_basis";
    return cellRoles.every(role => role === "allowable_deviation") ? "allowable_deviation" : "unclassified";
  });
  const field = roles.includes("acceptance_basis") ? "acceptance_basis"
    : roles.length && roles.every(role => role === "allowable_deviation") ? "allowable_deviation" : "unclassified";
  return { field, literal_only: field === "allowable_deviation" };
}

export interface ExternalReferenceExpansionPolicy {
  nested_external: boolean;
  origin_status: "root" | "external" | "mixed" | "unverified";
  same_document: boolean;
  origin_source_sha256?: string;
  parent_occurrence_ids: string[];
}

/** Derive document ancestry from registered source membership, never model depth or reasons. */
export function externalReferenceExpansionPolicy(
  manifest: Pick<EvidenceManifest, "source" | "evidence" | "reference_occurrences">,
  originEvidenceIds: readonly string[],
  target?: { standard_no?: string; source_sha256?: string },
): ExternalReferenceExpansionPolicy {
  const known = new Set(manifest.evidence.map(record => record.evidence_id));
  const origins = [...new Set(originEvidenceIds)];
  const base = { nested_external: false, same_document: false, parent_occurrence_ids: [] as string[] };
  if (!origins.length || origins.some(id => !known.has(id))) return { ...base, origin_status: "unverified" };
  const parents = manifest.reference_occurrences.filter(occurrence => occurrence.status === "resolved"
    && occurrence.external_standard?.status === "resolved"
    && occurrence.external_standard.markdown_sha256
    && occurrence.external_standard.markdown_sha256 !== manifest.source.sha256
    && occurrence.target_address?.source_id === occurrence.external_standard.markdown_sha256
    && origins.some(id => occurrence.target_evidence_ids.includes(id)));
  if (!parents.length) return { ...base, origin_status: "root" };
  const hashes = new Set(parents.map(parent => parent.external_standard!.markdown_sha256!));
  if (hashes.size !== 1 || origins.some(id => !parents.some(parent => parent.target_evidence_ids.includes(id)))) {
    return { ...base, origin_status: "mixed" };
  }
  const sourceHash = [...hashes][0]!;
  const sameDocument = target?.source_sha256 === sourceHash || Boolean(target?.standard_no && parents.some(parent =>
    normalizeStandardNo(parent.external_standard!.standard_no) === normalizeStandardNo(target.standard_no!)));
  return {
    nested_external: !sameDocument,
    origin_status: "external",
    same_document: sameDocument,
    origin_source_sha256: sourceHash,
    parent_occurrence_ids: parents.map(parent => parent.occurrence_id),
  };
}
