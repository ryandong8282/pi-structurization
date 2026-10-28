import { canonicalize, sha256Json } from "./canonical.js";
import type {
  EvidenceDisposition,
  EvidenceManifest,
  RepairConvergenceState,
  RepairIssueClusterState,
  SemanticSourcePlan,
  ValidationIssue,
} from "./contracts.js";
import { buildPlanContract } from "./source-plan-contract.js";

export const DEFAULT_REPAIR_STATE: RepairConvergenceState = {
  mode: "modeling",
  repair_source: "validation",
  active_cluster: null,
  total_issue_count: 0,
  validation_fingerprint: "",
  selector_fingerprint: "",
  coverage_review_fingerprint: "",
  coverage_finding_ids: [],
  coverage_evidence_ids: [],
  coverage_item_ids: [],
  non_converging_rounds: 0,
  fresh_session_required: false,
  session_epoch: 0,
  repair_session_restarts: 0,
};

export function repairStateOrDefault(
  state: RepairConvergenceState | undefined,
): RepairConvergenceState {
  return state
    ? {
        ...DEFAULT_REPAIR_STATE,
        ...state,
        active_cluster: state.active_cluster ?? null,
      }
    : structuredClone(DEFAULT_REPAIR_STATE);
}

export function normalizeOptionalSemanticSentinels(plan: unknown): {
  plan: unknown;
  changed_semantic_ids: string[];
} {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { plan, changed_semantic_ids: [] };
  }
  const normalized = structuredClone(plan) as {
    semantic_evidence?: Array<Record<string, unknown>>;
  };
  const changed = new Set<string>();
  for (const [index, node] of (normalized.semantic_evidence ?? []).entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    let nodeChanged = false;
    if (node.parent_semantic_id === null) {
      node.parent_semantic_id = "";
      nodeChanged = true;
    }
    if (node.materialized_item_id === null) {
      node.materialized_item_id = "";
      nodeChanged = true;
    }
    if (nodeChanged) {
      changed.add(typeof node.semantic_id === "string" ? node.semantic_id : `index:${index}`);
    }
  }
  return { plan: normalized, changed_semantic_ids: [...changed].sort() };
}

interface NormalizedSourceView {
  text: string;
  startOffsets: number[];
  endOffsets: number[];
}

const FORMAT_ONLY_CHARACTER_RE = /[\p{White_Space}#*_`"'“”‘’，,。；;：:、！？!?]/u;
const PAGE_MARKER_AT_START_RE = /^<!--\s*pages?[^>]*-->/iu;

function normalizedSourceView(value: string): NormalizedSourceView {
  let text = "";
  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const marker = PAGE_MARKER_AT_START_RE.exec(value.slice(offset));
    if (marker) {
      offset += marker[0].length;
      continue;
    }
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

function uniqueNormalizedSourceMatch(source: string, requested: string): string | undefined {
  if (source.includes(requested)) return requested;
  const sourceView = normalizedSourceView(source);
  const needle = normalizedSourceView(requested).text;
  if (!needle) return undefined;
  const first = sourceView.text.indexOf(needle);
  if (first < 0 || sourceView.text.indexOf(needle, first + 1) >= 0) return undefined;
  const start = sourceView.startOffsets[first];
  const end = sourceView.endOffsets[first + needle.length - 1];
  if (start === undefined || end === undefined) return undefined;
  const exact = source.slice(start, end);
  return exact && source.includes(exact) ? exact : undefined;
}

export function canonicalizeSharedSamplingSourceFragments(
  plan: unknown,
  manifest: EvidenceManifest,
): {
  plan: unknown;
  changes: Array<{ rule_id: string; before: string; after: string }>;
} {
  const canonical = structuredClone(plan) as { shared_sampling_rules?: unknown };
  const changes: Array<{ rule_id: string; before: string; after: string }> = [];
  if (!canonical || !Array.isArray(canonical.shared_sampling_rules)) {
    return { plan: canonical, changes };
  }
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  canonical.shared_sampling_rules.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const rule = raw as Record<string, unknown>;
    const requested = typeof rule.complete_source_fragment === "string"
      ? rule.complete_source_fragment
      : "";
    const evidenceIds = Array.isArray(rule.evidence_ids)
      ? rule.evidence_ids.filter((id): id is string => typeof id === "string")
      : [];
    if (!requested || evidenceIds.some((id) => evidenceById.get(id)?.text.includes(requested))) {
      return;
    }
    const matches = evidenceIds.flatMap((id) => {
      const source = evidenceById.get(id)?.text;
      if (!source) return [];
      const exact = uniqueNormalizedSourceMatch(source, requested);
      return exact ? [exact] : [];
    });
    const exact = matches.length === 1 ? matches[0] : undefined;
    if (!exact || exact === requested) return;
    rule.complete_source_fragment = exact;
    changes.push({
      rule_id: typeof rule.rule_id === "string" ? rule.rule_id : `index:${index}`,
      before: requested,
      after: exact,
    });
  });
  return { plan: canonical, changes };
}

export function reconcileDerivedEvidenceDispositions(
  plan: SemanticSourcePlan,
  manifest: EvidenceManifest,
): { plan: SemanticSourcePlan; changed_evidence_ids: string[] } {
  if (!Array.isArray(plan.acceptance_items) || !Array.isArray(plan.evidence_dispositions)) {
    return { plan, changed_evidence_ids: [] };
  }
  const normalized = structuredClone(plan);
  const knownEvidence = new Set(manifest.evidence.map((record) => record.evidence_id));
  const receivers = new Map<string, Set<string>>();
  const formalRowOwners = new Map<string, string>();
  try {
    for (const row of buildPlanContract(manifest, normalized.table_assembly).formal_rows) {
      formalRowOwners.set(row.evidence_id, row.item_id);
      receivers.set(row.evidence_id, new Set([row.item_id]));
    }
  } catch {
    // Invalid or incomplete table assembly remains a validator concern. Do not
    // infer formal-row ownership when the deterministic contract cannot build it.
  }
  for (const table of normalized.table_assembly?.logical_tables ?? []) {
    const confirmedRows = new Set((table.row_roles ?? []).map(row => row.evidence_id));
    const receiverItemIds = normalized.acceptance_items
      .filter((item) => item.table_semantics && (
        item.table_semantics.table_id === table.logical_table_id
        // Criterion-table and logical-table ids have different namespaces.
        // Confirmed physical row ownership connects their source provenance.
        || item.table_semantics.cell_evidence.some(cell => confirmedRows.has(cell.evidence_id))
      ))
      .map((item) => item.item_id);
    if (receiverItemIds.length === 0) continue;
    const structuralEvidenceIds = table.fragment_ids.flatMap((fragmentId) => {
      const fragment = manifest.table_fragments.find((candidate) => candidate.fragment_id === fragmentId);
      return fragment ? [
        ...(fragment.continuation_caption_evidence_ids ?? []),
        ...fragment.header_evidence_ids,
        ...(table.row_roles ?? []).filter(row =>
          (row.role === "header" || row.role === "repeated_header")
          && fragment.row_evidence_ids.includes(row.evidence_id)
          && table.evidence_ids.includes(row.evidence_id)
        ).map(row => row.evidence_id),
      ] : [];
    });
    for (const evidenceId of structuralEvidenceIds) {
      if (!knownEvidence.has(evidenceId)) continue;
      const itemIds = receivers.get(evidenceId) ?? new Set<string>();
      receiverItemIds.forEach((itemId) => itemIds.add(itemId));
      receivers.set(evidenceId, itemIds);
    }
  }
  for (const lot of normalized.inspection_lots ?? []) {
    for (const evidenceId of lot.evidence_ids ?? []) {
      if (!knownEvidence.has(evidenceId)) continue;
      const itemIds = receivers.get(evidenceId) ?? new Set<string>();
      for (const itemId of lot.item_ids ?? []) itemIds.add(itemId);
      receivers.set(evidenceId, itemIds);
    }
  }
  for (const item of normalized.acceptance_items) {
    const primaryEvidenceIds = Array.isArray(item.evidence_ids) ? item.evidence_ids : [];
    const samplingEvidenceIds = Array.isArray(item.sampling?.evidence_ids)
      ? item.sampling.evidence_ids
      : [];
    const referenceEvidenceIds = Array.isArray(item.reference_evidence_ids)
      ? item.reference_evidence_ids.filter((evidenceId) =>
          !formalRowOwners.has(evidenceId)
          || formalRowOwners.get(evidenceId) === item.item_id
        )
      : [];
    for (const evidenceId of new Set([
      ...primaryEvidenceIds,
      ...referenceEvidenceIds,
      ...samplingEvidenceIds,
    ])) {
      if (!knownEvidence.has(evidenceId)) continue;
      const itemIds = receivers.get(evidenceId) ?? new Set<string>();
      itemIds.add(item.item_id);
      receivers.set(evidenceId, itemIds);
    }
  }

  const changed = new Set<string>();
  const dispositionByEvidence = new Map(
    normalized.evidence_dispositions.map((row) => [row.evidence_id, row]),
  );
  for (const [evidenceId, itemIds] of receivers) {
    const exactItemIds = [...itemIds].sort();
    const current = dispositionByEvidence.get(evidenceId);
    if (!current) {
      const created: EvidenceDisposition = {
        evidence_id: evidenceId,
        disposition: "used",
        item_ids: exactItemIds,
        reason: "系统根据当前工作计划中的项目证据、引用证据或抽样证据自动登记",
      };
      normalized.evidence_dispositions.push(created);
      dispositionByEvidence.set(evidenceId, created);
      changed.add(evidenceId);
      continue;
    }
    if (
      current.disposition !== "used"
      || canonicalize(current.item_ids) !== canonicalize(exactItemIds)
    ) {
      current.disposition = "used";
      current.item_ids = exactItemIds;
      current.reason = "系统根据当前工作计划中的项目证据、引用证据或抽样证据自动刷新";
      changed.add(evidenceId);
    }
  }
  return { plan: normalized, changed_evidence_ids: [...changed].sort() };
}

const TRACKED_COLLECTIONS = [
  ["inspection_lots", "lot_id"],
  ["acceptance_items", "item_id"],
  ["semantic_evidence", "semantic_id"],
  ["semantic_references", "expansion_id"],
  ["shared_sampling_rules", "rule_id"],
  ["reference_resolutions", "resolution_id"],
  ["evidence_dispositions", "evidence_id"],
] as const;

function recordFingerprints(
  plan: unknown,
  collection: string,
  idField: string,
): Map<string, string> {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return new Map();
  const rows = (plan as Record<string, unknown>)[collection];
  if (!Array.isArray(rows)) return new Map();
  return new Map(rows.map((row, index) => {
    const id = row && typeof row === "object" && !Array.isArray(row)
      && typeof (row as Record<string, unknown>)[idField] === "string"
      ? String((row as Record<string, unknown>)[idField])
      : `index:${index}`;
    return [id, sha256Json(row)] as const;
  }));
}

export function changedSemanticRecords(before: unknown, after: unknown): Record<string, {
  added: string[];
  modified: string[];
  removed: string[];
}> {
  return Object.fromEntries(TRACKED_COLLECTIONS.flatMap(([collection, idField]) => {
    const left = recordFingerprints(before, collection, idField);
    const right = recordFingerprints(after, collection, idField);
    const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
    const value = {
      added: ids.filter((id) => !left.has(id) && right.has(id)),
      modified: ids.filter((id) => left.has(id) && right.has(id) && left.get(id) !== right.get(id)),
      removed: ids.filter((id) => left.has(id) && !right.has(id)),
    };
    return value.added.length || value.modified.length || value.removed.length
      ? [[collection, value] as const]
      : [];
  }));
}

function stringsFromDetails(value: unknown, keyPattern: RegExp, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromDetails(entry, keyPattern, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      if (typeof entry === "string" && entry) output.add(entry);
      if (Array.isArray(entry)) {
        for (const candidate of entry) if (typeof candidate === "string" && candidate) output.add(candidate);
      }
    }
    stringsFromDetails(entry, keyPattern, output);
  }
}

function itemIdsForIssue(plan: SemanticSourcePlan, issue: ValidationIssue): string[] {
  const itemIds = new Set<string>();
  stringsFromDetails(
    issue.details,
    /^(?:item_id|item_ids|expected_item_id|receiving_item_ids|destination_item_ids)$/,
    itemIds,
  );
  const itemMatch = issue.path.match(/^\/acceptance_items\/(\d+)/);
  if (itemMatch) {
    const item = plan.acceptance_items[Number(itemMatch[1])];
    if (item?.item_id) itemIds.add(item.item_id);
  }
  const semanticMatch = issue.path.match(/^\/semantic_evidence\/(\d+)/);
  if (semanticMatch) {
    const node = plan.semantic_evidence?.[Number(semanticMatch[1])];
    if (node?.materialized_item_id) itemIds.add(node.materialized_item_id);
  }
  const referenceMatch = issue.path.match(/^\/semantic_references\/(\d+)/);
  if (referenceMatch) {
    const reference = plan.semantic_references?.[Number(referenceMatch[1])];
    for (const binding of reference?.destination_bindings ?? []) itemIds.add(binding.item_id);
  }
  const samplingMatch = issue.path.match(/^\/shared_sampling_rules\/(\d+)/);
  if (samplingMatch) {
    const rule = plan.shared_sampling_rules?.[Number(samplingMatch[1])];
    for (const itemId of rule?.receiving_item_ids ?? []) itemIds.add(itemId);
  }
  const dispositionMatch = issue.path.match(/^\/evidence_dispositions\/(\d+)/);
  if (dispositionMatch) {
    const row = plan.evidence_dispositions[Number(dispositionMatch[1])];
    for (const itemId of row?.item_ids ?? []) itemIds.add(itemId);
  }
  return [...itemIds].filter((itemId) => plan.acceptance_items.some((item) => item.item_id === itemId)).sort();
}

export function validationIssueClusters(
  plan: SemanticSourcePlan,
  issues: ValidationIssue[],
): RepairIssueClusterState[] {
  const grouped = new Map<string, { issues: ValidationIssue[]; item_ids: string[] }>();
  for (const issue of issues) {
    const itemIds = itemIdsForIssue(plan, issue);
    const key = itemIds.length ? `items:${itemIds.join("|")}` : `global:${issue.code}`;
    const cluster = grouped.get(key) ?? { issues: [], item_ids: itemIds };
    cluster.issues.push(issue);
    grouped.set(key, cluster);
  }
  return [...grouped.entries()].map(([key, cluster]) => ({
    key,
    issue_count: cluster.issues.length,
    issue_fingerprint: sha256Json(cluster.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      details: issue.details ?? null,
    }))),
    issue_codes: [...new Set(cluster.issues.map((issue) => issue.code))].sort(),
    item_ids: cluster.item_ids,
  })).sort((left, right) => left.key.localeCompare(right.key));
}

export function selectActiveIssueCluster(
  clusters: RepairIssueClusterState[],
  preferredKey = "",
): RepairIssueClusterState | null {
  return clusters.find((cluster) => cluster.key === preferredKey) ?? clusters[0] ?? null;
}
