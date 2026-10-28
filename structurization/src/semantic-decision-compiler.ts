import {
  COMPACT_PLAN_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  referenceOccurrenceOriginEvidenceIds,
  type AcceptanceItemField,
  type AcceptanceItemCategory,
  type AcceptanceItemFieldBindings,
  type CompactAcceptanceItemPlan,
  type CompactSharedSamplingCondition,
  type ConfirmedTableRowRole,
  type EvidenceManifest,
  type FieldSourceBinding,
  type ReferenceApplicationMode,
  type ReferenceImportScope,
  type ReferenceResolutionAction,
  type ReferenceTargetField,
  type SamplingDecisionStatus,
  type SemanticEvidenceRole,
  type SemanticSourcePlan,
  type SemanticSourcePlanV8,
  type SamplingComponentBinding,
  type SamplingComponentDisposition,
  type SamplingComponentRole,
  type SourceBindingComposition,
  type TableCellEvidenceRole,
  type TableCriterionSourceKind,
} from "./contracts.js";
import { canonicalize, sha256Text } from "./canonical.js";
import { reconcileDerivedEvidenceDispositions } from "./repair-convergence.js";
import { sourceSpanIdFor } from "./source-span-registry.js";
import { mergeSamplingComponents } from "./sampling-components.js";
import {
  composeSamplingScript,
  samplingConfidenceForStatus,
  samplingScriptForStatus,
  supportedSamplingScript,
  supportedSamplingScriptValue,
} from "./sampling-script.js";

export const SEMANTIC_DECISION_SCHEMA_VERSION = "semantic-decision-plan/v1" as const;

export interface EvidenceSpanDecision {
  evidence_id: string;
  start: number;
  end: number;
}

export interface SemanticFieldDecision {
  /** Used only when name.composition=semantic_summary; lossless fields are compiler-derived. */
  value: string;
  composition: SourceBindingComposition;
  spans: EvidenceSpanDecision[];
  separator?: "" | " " | "\n";
  reason: string;
}

export interface SemanticLotDecision {
  key: string;
  name: string;
  evidence_spans: EvidenceSpanDecision[];
  reason: string;
}

export interface SemanticNodeDecision {
  key: string;
  role: SemanticEvidenceRole;
  span: EvidenceSpanDecision;
  parent_key: string;
  item_key: string;
  reason: string;
}

export interface SemanticTableDecision {
  source_kind: TableCriterionSourceKind;
  table_key: string;
  table_no: string;
  table_title: string;
  applicability: string;
  row_path: string[];
  column_path: string[];
  unit: string;
  condition: string;
  allowed_value: string;
  acceptance_branches?: Array<{
    key: string;
    condition: string;
    requirement: string;
    allowed_value: string;
    condition_spans: EvidenceSpanDecision[];
    requirement_spans: EvidenceSpanDecision[];
    allowed_value_spans: EvidenceSpanDecision[];
  }>;
  inspection_method: string;
  cell_evidence: Array<{ role: TableCellEvidenceRole; span: EvidenceSpanDecision }>;
  reference_spans: EvidenceSpanDecision[];
}

export interface SemanticItemDecision {
  key: string;
  lot_key: string;
  name_path?: string[];
  category: AcceptanceItemCategory;
  fields: Record<AcceptanceItemField, SemanticFieldDecision>;
  primary_spans: EvidenceSpanDecision[];
  table: SemanticTableDecision | null;
  inspection_data_type: "measurement" | "counting" | "mixed" | "review";
  inspection_data_type_reason: string;
  inspection_data_type_spans: EvidenceSpanDecision[];
  sampling: {
    status: SamplingDecisionStatus;
    min_sampling: string;
    script: string;
    reason: string;
    confidence: number;
    evidence_spans: EvidenceSpanDecision[];
    rule_keys: string[];
    branch_keys: string[];
  };
}

export interface SemanticReferenceDecision {
  key: string;
  anchor_key: string;
  status: "resolved" | "not_applicable" | "review";
  import_scope: ReferenceImportScope;
  target_keys: string[];
  destinations: Array<{ item_key: string; fields: ReferenceTargetField[] }>;
  reason: string;
}

export interface SemanticSamplingRuleDecision {
  key: string;
  source_semantic_key: string;
  complete_span: EvidenceSpanDecision;
  /** Optional only while target-selector v4 artifacts are replayed. */
  components?: SemanticSamplingComponentDecision[];
  branches: Array<{
    key: string;
    applies_to_category: "主控项目" | "一般项目" | "all_items";
    min_sampling: string;
    script: string;
    span: EvidenceSpanDecision;
    /** Optional only while target-selector v4 artifacts are replayed. */
    components?: SemanticSamplingComponentDecision[];
    conditions: Array<{
      key: string;
      text: string;
      span: EvidenceSpanDecision;
    }>;
  }>;
  shared_conditions: Array<{
    key: string;
    text: string;
    span: EvidenceSpanDecision;
  }>;
  /** Compatibility-only input; compiler derives receivers from item branch selections. */
  receiver_item_keys?: string[];
  reason: string;
}

export interface SemanticSamplingComponentDecision {
  key: string;
  role: SamplingComponentRole;
  disposition: SamplingComponentDisposition;
  spans: EvidenceSpanDecision[];
  reason: string;
}

export interface SemanticOccurrenceResolutionDecision {
  key: string;
  occurrence_id: string;
  action: ReferenceResolutionAction;
  application_mode: ReferenceApplicationMode;
  import_scope: ReferenceImportScope;
  target_spans: EvidenceSpanDecision[];
  origin_binding?: { item_key: string; target_field: Exclude<ReferenceTargetField, "reference_only"> };
  destinations: Array<{ item_key: string; target_field: ReferenceTargetField }>;
  reason: string;
}

export interface SemanticTableAssemblyDecision {
  tables: Array<{
    key: string;
    canonical_title: string;
    title_spans: EvidenceSpanDecision[];
    evidence_spans: EvidenceSpanDecision[];
    fragment_ids: string[];
    row_roles?: ConfirmedTableRowRole[];
    reason: string;
    confidence: number;
  }>;
  fragment_dispositions: Array<{
    fragment_id: string;
    disposition: "assigned" | "context" | "review";
    table_key: string;
    reason: string;
  }>;
}

export interface SemanticDecisionPlan {
  schema_version: typeof SEMANTIC_DECISION_SCHEMA_VERSION;
  job_id: string;
  target_id: string;
  evidence_fingerprint: string;
  table_assembly: SemanticTableAssemblyDecision;
  lots: SemanticLotDecision[];
  items: SemanticItemDecision[];
  semantic_nodes: SemanticNodeDecision[];
  references: SemanticReferenceDecision[];
  sampling_rules: SemanticSamplingRuleDecision[];
  occurrence_resolutions: SemanticOccurrenceResolutionDecision[];
  evidence_dispositions: Array<{
    evidence_id: string;
    disposition: "context" | "ignored";
    reason: string;
  }>;
}

export interface SemanticDecisionIssue {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}

export class SemanticDecisionCompileError extends Error {
  constructor(public readonly issues: SemanticDecisionIssue[]) {
    super(`Semantic decision compilation failed with ${issues.length} issue(s)`);
  }
}

export function initialSemanticDecisionPlan(manifest: EvidenceManifest): SemanticDecisionPlan {
  return {
    schema_version: SEMANTIC_DECISION_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: { tables: [], fragment_dispositions: [] },
    lots: [],
    items: [],
    semantic_nodes: [],
    references: [],
    sampling_rules: [],
    occurrence_resolutions: [],
    evidence_dispositions: [],
  };
}

function stableId(prefix: string, targetId: string, key: string): string {
  return `${prefix}:${sha256Text(`${targetId}\0${key}`).slice(0, 20)}`;
}

export function semanticItemIdForSelectorKey(targetId: string, selectorKey: string): string {
  return stableId("item", targetId, selectorKey);
}

export function semanticLotIdForSelectorKey(targetId: string, selectorKey: string): string {
  return stableId("lot", targetId, selectorKey);
}

export function semanticResolutionIdForSelectorKey(targetId: string, selectorKey: string): string {
  return stableId("resolution", targetId, selectorKey);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

type SourceOrderPoint = readonly [number, number, number, number];

function compareSourceOrderPoint(left: SourceOrderPoint, right: SourceOrderPoint): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function sourceOrderPoint(
  span: EvidenceSpanDecision,
  manifest: EvidenceManifest,
  evidenceIndexById: ReadonlyMap<string, number>,
  fragmentOrderById: ReadonlyMap<string, number>,
): SourceOrderPoint {
  const record = manifest.evidence[evidenceIndexById.get(span.evidence_id) ?? -1];
  const charLocator = /^char:(\d+)-(\d+)$/.exec(record?.locator ?? "");

  // Table source_order is relative to other tables, NOT to document prose.
  // Compare the common document line coordinate before any table-only fallback.
  const lineLocator = /(?:^|[/#])line[:=-]?(\d+)/i.exec(record?.locator ?? "");
  const startLine = lineLocator ? Number(lineLocator[1]) : record?.source_start_line;
  if (startLine !== undefined) {
    const prefix = record!.text.slice(0, span.start);
    return [0, startLine + (prefix.match(/\n/g)?.length ?? 0), record?.row_index ?? 0, span.start - (prefix.lastIndexOf('\n') + 1)];
  }
  // Historical char-only manifests can still be ordered within their coordinate
  // space. The editor normalizes mixed historical anchors against full Markdown.
  if (charLocator) return [1, Number(charLocator[1]) + span.start, 0, 0];

  const fragmentOrder = record?.table_fragment_id
    ? fragmentOrderById.get(record.table_fragment_id)
    : undefined;
  if (fragmentOrder !== undefined) {
    return [2, fragmentOrder, record?.row_index ?? -1, span.start];
  }

  return [3, evidenceIndexById.get(span.evidence_id) ?? Number.MAX_SAFE_INTEGER, record?.row_index ?? -1, span.start];
}

function itemSourceOrderSignature(
  item: SemanticItemDecision,
  manifest: EvidenceManifest,
  evidenceIndexById: ReadonlyMap<string, number>,
  fragmentOrderById: ReadonlyMap<string, number>,
): SourceOrderPoint[] {
  const rowEntrySpans = item.table?.cell_evidence
    .filter((cell) => cell.role === "allowed_value")
    .map((cell) => cell.span) ?? [];
  const columnEntrySpans = item.table?.cell_evidence
    .filter((cell) => cell.role === "column_header")
    .map((cell) => cell.span) ?? [];
  const selected = item.table?.source_kind === "reference" && item.table.reference_spans.length
    ? item.table.reference_spans
    : rowEntrySpans.length
    ? rowEntrySpans
    : columnEntrySpans.length
      ? columnEntrySpans
      : item.fields.requirement.spans.length
        ? item.fields.requirement.spans
        : item.primary_spans;
  const points = selected.map((span) => sourceOrderPoint(
    span,
    manifest,
    evidenceIndexById,
    fragmentOrderById,
  ));
  return unique(points.map((point) => point.join("\0")))
    .map((value) => value.split("\0").map(Number) as unknown as SourceOrderPoint)
    .sort(compareSourceOrderPoint);
}

function compareSourceOrderSignatures(left: SourceOrderPoint[], right: SourceOrderPoint[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = compareSourceOrderPoint(left[index]!, right[index]!);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function duplicateKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function extractSpan(
  span: EvidenceSpanDecision | unknown,
  evidenceById: Map<string, { text: string }>,
  path: string,
  issues: SemanticDecisionIssue[],
): { evidence_id: string; text: string } | undefined {
  if (!span || typeof span !== "object" || Array.isArray(span)) {
    issues.push({ code: "decision_schema", path, message: "Evidence span must be an object" });
    return undefined;
  }
  const selected = span as EvidenceSpanDecision;
  const evidence = evidenceById.get(selected.evidence_id);
  if (!evidence) {
    issues.push({
      code: "decision_unknown_evidence",
      path,
      message: "The decision span names unknown immutable evidence",
      details: { evidence_id: selected.evidence_id },
    });
    return undefined;
  }
  if (
    !Number.isInteger(selected.start)
    || !Number.isInteger(selected.end)
    || selected.start < 0
    || selected.end <= selected.start
    || selected.end > evidence.text.length
  ) {
    issues.push({
      code: "decision_invalid_span",
      path,
      message: "Evidence spans must be non-empty UTF-16 offsets inside the named immutable atom",
      details: { start: selected.start, end: selected.end, text_length: evidence.text.length },
    });
    return undefined;
  }
  return {
    evidence_id: selected.evidence_id,
    text: evidence.text.slice(selected.start, selected.end),
  };
}

function extractSpans(
  spans: EvidenceSpanDecision[],
  evidenceById: Map<string, { text: string }>,
  path: string,
  issues: SemanticDecisionIssue[],
): Array<{ evidence_id: string; text: string }> {
  return spans.flatMap((span, index) => {
    const fragment = extractSpan(span, evidenceById, `${path}/${index}`, issues);
    return fragment ? [fragment] : [];
  });
}

export function safeJoinDisplayFragments(
  fragments: readonly { text: string }[],
  separator?: string,
): string {
  if (fragments.length === 0) return "";
  if (fragments.length === 1) return fragments[0]!.text;
  const sep = separator ?? (fragments.length > 1 ? "\n" : "");
  let result = fragments[0]!.text;
  for (let i = 1; i < fragments.length; i++) {
    const prev = result;
    const next = fragments[i]!.text;
    let currentSep = sep;
    if (!currentSep && /[\da-zA-Z.]$/u.test(prev) && /^[\da-zA-Z.]/u.test(next)) {
      currentSep = " ";
    }
    result += currentSep + next;
  }
  return result;
}

function compileBinding(
  field: AcceptanceItemField,
  decision: SemanticFieldDecision,
  evidenceById: Map<string, { text: string }>,
  path: string,
  issues: SemanticDecisionIssue[],
): { value: string; binding: FieldSourceBinding } {
  const fragments = extractSpans(decision.spans, evidenceById, `${path}/spans`, issues);
  const reason = decision.reason?.trim() ?? "";
  if (!reason) {
    issues.push({ code: "decision_reason_missing", path: `${path}/reason`, message: "Every semantic field decision requires a reason" });
  }
  if (decision.composition === "not_applicable") {
    if (decision.spans.length !== 0) {
      issues.push({
        code: "decision_empty_field_binding",
        path,
        message: "A not_applicable field must not cite source spans",
      });
    }
    return {
      value: "",
      binding: {
        status: "not_applicable",
        composition: "not_applicable",
        evidence_ids: [],
        source_fragments: [],
        value_sha256: sha256Text(""),
        reason,
      },
    };
  }
  if (fragments.length === 0) {
    issues.push({
      code: "decision_nonempty_field_unbound",
      path,
      message: "A bound semantic field must select at least one evidence span",
    });
  }
  if (field !== "name" && decision.composition === "semantic_summary") {
    issues.push({
      code: "decision_lossless_field_summary",
      path: `${path}/composition`,
      message: "semantic_summary is allowed only for the inspection-point name",
    });
  }
  const seenDisplayValues = new Set<string>();
  const displayFragments = fragments.filter((fragment) => {
    const key = fragment.text.trim().replace(/\s+/g, " ");
    if (!key || seenDisplayValues.has(key)) return false;
    seenDisplayValues.add(key);
    return true;
  });
  const value = field === "name" && decision.composition === "semantic_summary"
    ? decision.value
    : safeJoinDisplayFragments(displayFragments, decision.separator);
  if (field === "name" && decision.composition === "semantic_summary" && !value.trim()) {
    issues.push({
      code: "decision_name_summary_missing",
      path: `${path}/value`,
      message: "A semantic_summary name requires the Agent's concise business name",
    });
  }
  return {
    value,
    binding: {
      status: "bound",
      composition: decision.composition,
      evidence_ids: unique(fragments.map((fragment) => fragment.evidence_id)),
      source_fragments: fragments,
      value_sha256: sha256Text(value),
      reason,
    },
  };
}

function requireKey(
  key: string,
  known: Map<string, string>,
  path: string,
  kind: string,
  issues: SemanticDecisionIssue[],
): string {
  const value = known.get(key);
  if (!key || !value) {
    issues.push({
      code: `decision_unknown_${kind}`,
      path,
      message: `The semantic decision names an unknown ${kind} key`,
      details: { key },
    });
    return "";
  }
  return value;
}

function decisionShapeIssues(value: unknown): SemanticDecisionIssue[] {
  const issues: SemanticDecisionIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ code: "decision_schema", path: "/", message: "Semantic decisions must be one JSON object" }];
  }
  const plan = value as Record<string, unknown>;
  for (const field of [
    "lots",
    "items",
    "semantic_nodes",
    "references",
    "sampling_rules",
    "occurrence_resolutions",
    "evidence_dispositions",
  ]) {
    if (!Array.isArray(plan[field])) {
      issues.push({ code: "decision_schema", path: `/${field}`, message: `${field} must be an array` });
    }
  }
  const tableAssembly = plan.table_assembly;
  if (!tableAssembly || typeof tableAssembly !== "object" || Array.isArray(tableAssembly)) {
    issues.push({ code: "decision_schema", path: "/table_assembly", message: "table_assembly must be an object" });
  } else {
    const table = tableAssembly as Record<string, unknown>;
    if (!Array.isArray(table.tables)) issues.push({ code: "decision_schema", path: "/table_assembly/tables", message: "tables must be an array" });
    if (!Array.isArray(table.fragment_dispositions)) issues.push({ code: "decision_schema", path: "/table_assembly/fragment_dispositions", message: "fragment_dispositions must be an array" });
  }
  if (issues.length) return issues;
  const requireArray = (record: unknown, field: string, path: string) => {
    if (!record || typeof record !== "object" || Array.isArray(record) || !Array.isArray((record as Record<string, unknown>)[field])) {
      issues.push({ code: "decision_schema", path: `${path}/${field}`, message: `${field} must be an array` });
    }
  };
  const requireObject = (record: unknown, field: string, path: string) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      issues.push({ code: "decision_schema", path, message: `${field} must be an object` });
    }
  };
  (plan.lots as unknown[]).forEach((entry, index) => requireArray(entry, "evidence_spans", `/lots/${index}`));
  (plan.items as unknown[]).forEach((entry, index) => {
    const path = `/items/${index}`;
    requireArray(entry, "primary_spans", path);
    requireArray(entry, "inspection_data_type_spans", path);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const item = entry as Record<string, unknown>;
    if (!item.fields || typeof item.fields !== "object" || Array.isArray(item.fields)) {
      issues.push({ code: "decision_schema", path: `${path}/fields`, message: "fields must be an object" });
    } else {
      for (const field of ["name", "requirement", "method", "quantity", "note"]) {
        requireArray((item.fields as Record<string, unknown>)[field], "spans", `${path}/fields/${field}`);
      }
    }
    if (!item.sampling || typeof item.sampling !== "object" || Array.isArray(item.sampling)) {
      issues.push({ code: "decision_schema", path: `${path}/sampling`, message: "sampling must be an object" });
    } else {
      requireArray(item.sampling, "evidence_spans", `${path}/sampling`);
      requireArray(item.sampling, "rule_keys", `${path}/sampling`);
      requireArray(item.sampling, "branch_keys", `${path}/sampling`);
    }
    if (item.table !== null && item.table !== undefined) {
      requireArray(item.table, "cell_evidence", `${path}/table`);
      requireArray(item.table, "reference_spans", `${path}/table`);
      if ((item.table as Record<string, unknown>).acceptance_branches !== undefined) {
        requireArray(item.table, "acceptance_branches", `${path}/table`);
      }
    }
  });
  (plan.semantic_nodes as unknown[]).forEach((entry, index) => {
    const span = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).span
      : undefined;
    requireObject(span, "span", `/semantic_nodes/${index}/span`);
  });
  (plan.references as unknown[]).forEach((entry, index) => {
    requireArray(entry, "target_keys", `/references/${index}`);
    requireArray(entry, "destinations", `/references/${index}`);
    requireObject((entry as Record<string, unknown>).import_scope, "import_scope", `/references/${index}/import_scope`);
  });
  (plan.sampling_rules as unknown[]).forEach((entry, index) => {
    requireArray(entry, "branches", `/sampling_rules/${index}`);
    requireArray(entry, "shared_conditions", `/sampling_rules/${index}`);
    if (
      entry
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as Record<string, unknown>).receiver_item_keys !== undefined
    ) {
      requireArray(entry, "receiver_item_keys", `/sampling_rules/${index}`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const rule = entry as Record<string, unknown>;
    requireObject(rule.complete_span, "complete_span", `/sampling_rules/${index}/complete_span`);
    if (Array.isArray(rule.branches)) {
      rule.branches.forEach((branch, branchIndex) => {
        const branchRecord = branch && typeof branch === "object" && !Array.isArray(branch)
          ? branch as Record<string, unknown>
          : undefined;
        requireObject(branchRecord?.span, "span", `/sampling_rules/${index}/branches/${branchIndex}/span`);
        requireArray(branchRecord, "conditions", `/sampling_rules/${index}/branches/${branchIndex}`);
        if (Array.isArray(branchRecord?.conditions)) {
          branchRecord.conditions.forEach((condition, conditionIndex) => {
            const span = condition && typeof condition === "object" && !Array.isArray(condition)
              ? (condition as Record<string, unknown>).span
              : undefined;
            requireObject(span, "span", `/sampling_rules/${index}/branches/${branchIndex}/conditions/${conditionIndex}/span`);
          });
        }
      });
    }
    if (Array.isArray(rule.shared_conditions)) {
      rule.shared_conditions.forEach((condition, conditionIndex) => {
        const span = condition && typeof condition === "object" && !Array.isArray(condition)
          ? (condition as Record<string, unknown>).span
          : undefined;
        requireObject(span, "span", `/sampling_rules/${index}/shared_conditions/${conditionIndex}/span`);
      });
    }
  });
  (plan.occurrence_resolutions as unknown[]).forEach((entry, index) => {
    requireArray(entry, "target_spans", `/occurrence_resolutions/${index}`);
    requireArray(entry, "destinations", `/occurrence_resolutions/${index}`);
    requireObject((entry as Record<string, unknown>).import_scope, "import_scope", `/occurrence_resolutions/${index}/import_scope`);
  });
  return issues;
}

export function compileSemanticDecisions(
  decisions: SemanticDecisionPlan,
  manifest: EvidenceManifest,
): SemanticSourcePlan {
  const issues = decisionShapeIssues(decisions);
  if (issues.length) throw new SemanticDecisionCompileError(issues);
  if (decisions.schema_version !== SEMANTIC_DECISION_SCHEMA_VERSION) {
    issues.push({ code: "decision_schema", path: "/schema_version", message: `Expected ${SEMANTIC_DECISION_SCHEMA_VERSION}` });
  }
  if (decisions.job_id !== manifest.job_id) {
    issues.push({ code: "decision_job_mismatch", path: "/job_id", message: "job_id does not match immutable evidence" });
  }
  if (decisions.target_id !== manifest.target_id) {
    issues.push({ code: "decision_target_mismatch", path: "/target_id", message: "target_id does not match immutable evidence" });
  }
  if (decisions.evidence_fingerprint !== manifest.evidence_fingerprint) {
    issues.push({ code: "decision_evidence_mismatch", path: "/evidence_fingerprint", message: "Decision plan was not authored against this exact evidence package" });
  }

  const collections = [
    ["lot", decisions.lots.map((entry) => entry.key)],
    ["item", decisions.items.map((entry) => entry.key)],
    ["semantic", decisions.semantic_nodes.map((entry) => entry.key)],
    ["reference", decisions.references.map((entry) => entry.key)],
    ["sampling_rule", decisions.sampling_rules.map((entry) => entry.key)],
    ["occurrence_resolution", decisions.occurrence_resolutions.map((entry) => entry.key)],
    ["table", decisions.table_assembly.tables.map((entry) => entry.key)],
  ] as const;
  for (const [kind, keys] of collections) {
    const blank = keys.flatMap((key, index) => key?.trim() ? [] : [index]);
    if (blank.length) issues.push({ code: `decision_blank_${kind}_key`, path: `/${kind}`, message: `${kind} keys must be non-blank`, details: blank });
    const duplicates = duplicateKeys(keys);
    if (duplicates.length) issues.push({ code: `decision_duplicate_${kind}_key`, path: `/${kind}`, message: `${kind} keys must be unique`, details: duplicates });
  }

  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const evidenceIndexById = new Map(manifest.evidence.map((record, index) => [record.evidence_id, index]));
  const fragmentOrderById = new Map(manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment.source_order]));
  const orderedItemDecisions = decisions.items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      signature: itemSourceOrderSignature(item, manifest, evidenceIndexById, fragmentOrderById),
    }))
    .sort((left, right) =>
      compareSourceOrderSignatures(left.signature, right.signature)
      || left.originalIndex - right.originalIndex
    );
  const lotIds = new Map(decisions.lots.map((entry) => [
    entry.key,
    semanticLotIdForSelectorKey(manifest.target_id, entry.key),
  ]));
  const itemIds = new Map(decisions.items.map((entry) => [entry.key, semanticItemIdForSelectorKey(manifest.target_id, entry.key)]));
  const semanticIds = new Map(decisions.semantic_nodes.map((entry) => [entry.key, stableId("semantic", manifest.target_id, entry.key)]));
  const ruleIds = new Map(decisions.sampling_rules.map((entry) => [entry.key, stableId("sampling", manifest.target_id, entry.key)]));
  const branchIds = new Map<string, string>();
  for (const rule of decisions.sampling_rules) {
    for (const branch of rule.branches) {
      const composite = `${rule.key}\0${branch.key}`;
      if (branchIds.has(composite)) {
        issues.push({ code: "decision_duplicate_sampling_branch_key", path: "/sampling_rules", message: "Sampling branch keys must be unique within a rule", details: { rule_key: rule.key, branch_key: branch.key } });
      }
      branchIds.set(composite, stableId("branch", manifest.target_id, composite));
    }
  }
  const tableIds = new Map(decisions.table_assembly.tables.map((entry) => [entry.key, stableId("table", manifest.target_id, entry.key)]));

  const tableAssembly = {
    schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
    evidence_fingerprint: manifest.evidence_fingerprint,
    logical_tables: decisions.table_assembly.tables.map((table, index) => {
      const titleFragments = extractSpans(table.title_spans, evidenceById, `/table_assembly/tables/${index}/title_spans`, issues);
      const evidenceFragments = extractSpans(table.evidence_spans, evidenceById, `/table_assembly/tables/${index}/evidence_spans`, issues);
      return {
        logical_table_id: tableIds.get(table.key) ?? "",
        canonical_title: table.canonical_title,
        canonical_title_fragments: titleFragments,
        evidence_ids: unique([...titleFragments, ...evidenceFragments].map((fragment) => fragment.evidence_id)),
        fragment_ids: unique(table.fragment_ids),
        ...(table.row_roles ? { row_roles: table.row_roles.map(row => ({ ...row })) } : {}),
        reason: table.reason,
        confidence: table.confidence,
        ...(table.row_roles ? { row_roles: structuredClone(table.row_roles) } : {}),
      };
    }),
    fragment_dispositions: decisions.table_assembly.fragment_dispositions.map((row, index) => ({
      fragment_id: row.fragment_id,
      disposition: row.disposition,
      logical_table_id: row.table_key
        ? requireKey(row.table_key, tableIds, `/table_assembly/fragment_dispositions/${index}/table_key`, "table", issues)
        : "",
      reason: row.reason,
    })),
  };

  const semanticNodes = decisions.semantic_nodes.map((node, index) => {
    const fragment = extractSpan(node.span, evidenceById, `/semantic_nodes/${index}/span`, issues);
    const itemId = node.item_key
      ? requireKey(node.item_key, itemIds, `/semantic_nodes/${index}/item_key`, "item", issues)
      : "";
    const parentId = node.parent_key
      ? requireKey(node.parent_key, semanticIds, `/semantic_nodes/${index}/parent_key`, "semantic", issues)
      : "";
    if (["acceptance_item", "table_criterion", "continuation"].includes(node.role) && !itemId) {
      issues.push({ code: "decision_semantic_item_missing", path: `/semantic_nodes/${index}/item_key`, message: `${node.role} must name its receiving item decision` });
    }
    if (!["acceptance_item", "table_criterion", "continuation"].includes(node.role) && node.item_key) {
      issues.push({ code: "decision_semantic_context_materialized", path: `/semantic_nodes/${index}/item_key`, message: `${node.role} cannot name a materialized item` });
    }
    return {
      semantic_id: semanticIds.get(node.key) ?? "",
      role: node.role,
      evidence_id: fragment?.evidence_id ?? node.span.evidence_id,
      exact_fragment: fragment?.text ?? "",
      parent_semantic_id: parentId,
      materialized_item_id: itemId,
      reason: node.reason,
    };
  });

  const semanticNodeByKey = new Map(decisions.semantic_nodes.map((node, index) => [node.key, { decision: node, compiled: semanticNodes[index]! }]));
  const semanticReferences = decisions.references.map((reference, index) => ({
    expansion_id: stableId("semantic-reference", manifest.target_id, reference.key),
    anchor_semantic_id: requireKey(reference.anchor_key, semanticIds, `/references/${index}/anchor_key`, "semantic", issues),
    status: reference.status,
    import_scope: reference.import_scope,
    target_semantic_ids: reference.target_keys.map((key, targetIndex) =>
      requireKey(key, semanticIds, `/references/${index}/target_keys/${targetIndex}`, "semantic", issues)
    ),
    destination_bindings: reference.destinations.map((destination, destinationIndex) => ({
      item_id: requireKey(destination.item_key, itemIds, `/references/${index}/destinations/${destinationIndex}/item_key`, "item", issues),
      fields: unique(destination.fields),
    })),
    reason: reference.reason,
  }));

  const occurrenceById = new Map(manifest.reference_occurrences.map((entry) => [entry.occurrence_id, entry]));
  const referenceResolutions = decisions.occurrence_resolutions.map((resolution, index) => {
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    if (!occurrence) {
      issues.push({ code: "decision_unknown_reference_occurrence", path: `/occurrence_resolutions/${index}/occurrence_id`, message: "The occurrence resolution names an unknown immutable reference occurrence" });
    }
    const orderedTargetSpans = [...resolution.target_spans].sort((left, right) =>
      compareSourceOrderPoint(
        sourceOrderPoint(left, manifest, evidenceIndexById, fragmentOrderById),
        sourceOrderPoint(right, manifest, evidenceIndexById, fragmentOrderById),
      )
    );
    const targets = extractSpans(orderedTargetSpans, evidenceById, `/occurrence_resolutions/${index}/target_spans`, issues);
    return {
      resolution_id: semanticResolutionIdForSelectorKey(manifest.target_id, resolution.key),
      occurrence_id: resolution.occurrence_id,
      origin_evidence_id: occurrence?.origin_evidence_id ?? "",
      action: resolution.action,
      application_mode: resolution.application_mode,
      import_scope: resolution.import_scope,
      target_evidence_ids: unique(targets.map((fragment) => fragment.evidence_id)),
      ...(resolution.origin_binding ? { origin_binding: {
        item_id: requireKey(resolution.origin_binding.item_key, itemIds, `/occurrence_resolutions/${index}/origin_binding/item_key`, "item", issues),
        target_field: resolution.origin_binding.target_field,
      } } : {}),
      destination_bindings: resolution.destinations.map((destination, destinationIndex) => ({
        item_id: requireKey(destination.item_key, itemIds, `/occurrence_resolutions/${index}/destinations/${destinationIndex}/item_key`, "item", issues),
        target_field: destination.target_field,
      })),
      reason: resolution.reason,
    };
  });
  const legacyReferenceEvidenceByItem = new Map<string, string[]>();
  const localReferenceOriginsByItem = new Map<string, Set<string>>();
  for (const resolution of referenceResolutions) {
    const occurrence = occurrenceById.get(resolution.occurrence_id);
    if (occurrence && resolution.application_mode !== "reference_placeholder") {
      const receivers = unique([
        ...resolution.destination_bindings.map(destination => destination.item_id),
        ...(resolution.origin_binding ? [resolution.origin_binding.item_id] : []),
      ]);
      for (const itemId of receivers) {
        const origins = localReferenceOriginsByItem.get(itemId) ?? new Set<string>();
        referenceOccurrenceOriginEvidenceIds(occurrence).forEach(evidenceId => origins.add(evidenceId));
        localReferenceOriginsByItem.set(itemId, origins);
      }
    }
    for (const destination of resolution.destination_bindings) {
      legacyReferenceEvidenceByItem.set(destination.item_id, unique([
        ...(legacyReferenceEvidenceByItem.get(destination.item_id) ?? []),
        ...resolution.target_evidence_ids,
      ]));
    }
  }

  const items = orderedItemDecisions.map(({ item, originalIndex }) => {
    const itemPath = `/items/${originalIndex}`;
    const fields = ["name", "requirement", "method", "quantity", "note"] as const;
    const bindings = {} as AcceptanceItemFieldBindings;
    const values = {} as Record<AcceptanceItemField, string>;
    for (const field of fields) {
      const decision = item.fields?.[field];
      if (!decision) {
        issues.push({ code: "decision_field_missing", path: `${itemPath}/fields/${field}`, message: `Item decisions require an explicit ${field} decision` });
        bindings[field] = {
          status: "not_found_in_evidence",
          composition: "not_applicable",
          evidence_ids: [],
          source_fragments: [],
          value_sha256: sha256Text(""),
          reason: "missing decision",
        };
        values[field] = "";
      } else {
        const compiledField = compileBinding(field, decision, evidenceById, `${itemPath}/fields/${field}`, issues);
        bindings[field] = compiledField.binding;
        values[field] = compiledField.value;
      }
    }
    const primaryFragments = extractSpans(item.primary_spans, evidenceById, `${itemPath}/primary_spans`, issues);
    const semanticEvidenceIds = decisions.semantic_nodes
      .filter((node) => node.item_key === item.key)
      .map((node) => node.span.evidence_id);
    // A reference-composed field may mix local context with imported criteria.
    // Only explicitly selected local origins of this item's registered routes
    // are direct evidence; anchors alone and arbitrary imported spans are not.
    const localOrigins = localReferenceOriginsByItem.get(itemIds.get(item.key) ?? "");
    const directFieldEvidenceIds = fields.flatMap((field) =>
      bindings[field].composition === "reference"
        ? bindings[field].evidence_ids.filter(evidenceId => localOrigins?.has(evidenceId))
        : bindings[field].evidence_ids
    );
    const inspectionFragments = extractSpans(item.inspection_data_type_spans, evidenceById, `${itemPath}/inspection_data_type_spans`, issues);
    const samplingFragments = extractSpans(item.sampling.evidence_spans, evidenceById, `${itemPath}/sampling/evidence_spans`, issues);
    const selectedSamplingBranches = item.sampling.branch_keys.flatMap((branchKey, branchIndex) => {
      const matchingRule = item.sampling.rule_keys
        .map((ruleKey) => decisions.sampling_rules.find((rule) => rule.key === ruleKey))
        .find((rule) => rule?.branches.some((branch) => branch.key === branchKey));
      const branch = matchingRule?.branches.find((candidate) => candidate.key === branchKey);
      if (!matchingRule || !branch) {
        issues.push({ code: "decision_unknown_sampling_branch", path: `${itemPath}/sampling/branch_keys/${branchIndex}`, message: "The item selects a branch not present in one of its selected rules", details: { key: branchKey } });
        return [];
      }
      const fragment = extractSpan(branch.span, evidenceById, `${itemPath}/sampling/branch_keys/${branchIndex}`, issues);
      const conditions = branch.conditions.flatMap((condition, conditionIndex) => {
        const conditionFragment = extractSpan(
          condition.span,
          evidenceById,
          `${itemPath}/sampling/branch_keys/${branchIndex}/conditions/${conditionIndex}`,
          issues,
        );
        return conditionFragment ? [{
          condition_id: stableId("sampling-branch-condition", manifest.target_id, `${matchingRule.key}\0${branch.key}\0${condition.key}`),
          text: condition.text,
          evidence_id: conditionFragment.evidence_id,
          exact_fragment: conditionFragment.text,
        }] : [];
      });
      const componentEvidenceIds = unique([
        ...(matchingRule.components ?? []),
        ...(branch.components ?? []),
      ].flatMap((component) => component.disposition === "present"
        ? component.spans.map((span) => span.evidence_id)
        : []));
      return [{ rule: matchingRule, branch, fragment, conditions, componentEvidenceIds }];
    });
    const referencedSampling = (
      item.sampling.status === "reference"
      || item.sampling.status === "reference_unspecified_quantity"
    ) && selectedSamplingBranches.length > 0;
    const compiledItemId = itemIds.get(item.key) ?? "";
    const table = item.table
      ? {
          source_kind: item.table.source_kind,
          table_id: stableId("criterion-table", manifest.target_id, item.table.table_key),
          table_no: item.table.table_no,
          table_title: item.table.table_title,
          applicability: item.table.applicability,
          row_path: item.table.row_path,
          column_path: item.table.column_path,
          unit: item.table.unit,
          condition: item.table.condition,
          allowed_value: item.table.allowed_value,
          ...(item.table.acceptance_branches?.length ? {
            acceptance_branches: item.table.acceptance_branches.map((branch, branchIndex) => ({
              branch_id: stableId("acceptance-branch", manifest.target_id, `${item.key}\0${branch.key}`),
              condition: branch.condition,
              requirement: branch.requirement,
              allowed_value: branch.allowed_value,
              condition_fragments: extractSpans(branch.condition_spans, evidenceById, `${itemPath}/table/acceptance_branches/${branchIndex}/condition_spans`, issues),
              requirement_fragments: extractSpans(branch.requirement_spans, evidenceById, `${itemPath}/table/acceptance_branches/${branchIndex}/requirement_spans`, issues),
              allowed_value_fragments: extractSpans(branch.allowed_value_spans, evidenceById, `${itemPath}/table/acceptance_branches/${branchIndex}/allowed_value_spans`, issues),
            })),
          } : {}),
          inspection_method: item.table.inspection_method,
          cell_evidence: item.table.cell_evidence.flatMap((cell, cellIndex) => {
            const fragment = extractSpan(cell.span, evidenceById, `${itemPath}/table/cell_evidence/${cellIndex}/span`, issues);
            return fragment ? [{ role: cell.role, ...fragment }] : [];
          }),
          reference_fragments: extractSpans(item.table.reference_spans, evidenceById, `${itemPath}/table/reference_spans`, issues),
        }
      : null;
    const directTableEvidenceIds = table?.source_kind === "direct"
      ? unique([
            ...table.cell_evidence.map((fragment) => fragment.evidence_id),
            ...(table.acceptance_branches ?? []).flatMap((branch) => [
              ...branch.condition_fragments.map((fragment) => fragment.evidence_id),
              ...branch.requirement_fragments.map((fragment) => fragment.evidence_id),
              ...branch.allowed_value_fragments.map((fragment) => fragment.evidence_id),
            ]),
            ...table.reference_fragments.map((fragment) => fragment.evidence_id),
        ])
      : [];
    // The selector compiler projects the logical-table formal caption into
    // every member item's cell_evidence (role table_title), possibly sourced
    // from another physical block or the structure plan. On reference items
    // that caption has no route into the item's reachable evidence set, so its
    // provenance must travel with the compiled structure instead of forcing
    // the model to duplicate the caption into criterion.
    const tableTitleEvidenceIds = table
      ? unique(table.cell_evidence
          .filter((cell) => cell.role === "table_title")
          .map((cell) => cell.evidence_id))
      : [];
    return {
      item_id: compiledItemId,
      lot_id: requireKey(item.lot_key, lotIds, `${itemPath}/lot_key`, "lot", issues),
      name: values.name,
      ...(item.name_path ? { name_path: [...item.name_path] } : {}),
      category: item.category,
      requirement: values.requirement,
      method: values.method,
      quantity: values.quantity,
      note: values.note,
      evidence_ids: unique([
        ...primaryFragments.map((fragment) => fragment.evidence_id),
        ...semanticEvidenceIds,
        ...directFieldEvidenceIds,
        ...directTableEvidenceIds,
        ...tableTitleEvidenceIds,
      ]),
      reference_evidence_ids: legacyReferenceEvidenceByItem.get(compiledItemId) ?? [],
      table_semantics: table,
      inspection_data_type: item.inspection_data_type,
      inspection_data_type_reason: item.inspection_data_type_reason,
      inspection_data_type_evidence_ids: unique(inspectionFragments.map((fragment) => fragment.evidence_id)),
      field_bindings: bindings,
      sampling: {
        status: item.sampling.status,
        min_sampling: referencedSampling
          ? unique(selectedSamplingBranches.map(({ branch }) => branch.min_sampling)).join("；")
          : item.sampling.min_sampling,
        script: samplingScriptForStatus(item.sampling.status, referencedSampling
          ? composeSamplingScript(selectedSamplingBranches.map(({ branch, conditions }) => ({
              script: branch.script,
              conditions: conditions.map((condition) => condition.text),
            })))
          : supportedSamplingScriptValue(item.sampling.script)),
        reason: item.sampling.reason,
        confidence: samplingConfidenceForStatus(item.sampling.status, item.sampling.confidence),
        evidence_ids: unique([
          ...samplingFragments.map((fragment) => fragment.evidence_id),
          ...selectedSamplingBranches.flatMap(({ rule, fragment, conditions, componentEvidenceIds }) => [
            rule.complete_span.evidence_id,
            fragment?.evidence_id ?? "",
            ...conditions.map((condition) => condition.evidence_id),
            ...componentEvidenceIds,
          ]),
        ]).filter(Boolean),
        rule_ids: item.sampling.rule_keys.map((key, ruleIndex) =>
          requireKey(key, ruleIds, `${itemPath}/sampling/rule_keys/${ruleIndex}`, "sampling_rule", issues)
        ),
        branch_ids: selectedSamplingBranches.map(({ rule, branch }) =>
          branchIds.get(`${rule.key}\0${branch.key}`) ?? ""
        ),
        applied_branches: selectedSamplingBranches.map(({ rule, branch, fragment, conditions, componentEvidenceIds }) => ({
          rule_id: ruleIds.get(rule.key) ?? "",
          branch_id: branchIds.get(`${rule.key}\0${branch.key}`) ?? "",
          min_sampling: branch.min_sampling,
          script: supportedSamplingScript(branch.script),
          conditions,
          evidence_ids: unique([
            rule.complete_span.evidence_id,
            fragment?.evidence_id ?? "",
            ...conditions.map((condition) => condition.evidence_id),
            ...componentEvidenceIds,
          ]).filter(Boolean),
        })),
      },
    };
  });

  const lots = decisions.lots.map((lot, index) => {
    const fragments = extractSpans(lot.evidence_spans, evidenceById, `/lots/${index}/evidence_spans`, issues);
    const lotId = lotIds.get(lot.key) ?? "";
    return {
      lot_id: lotId,
      name: lot.name,
      evidence_ids: unique(fragments.map((fragment) => fragment.evidence_id)),
      item_ids: items.filter((item) => item.lot_id === lotId).map((item) => item.item_id),
    };
  });

  const sharedSamplingRules = decisions.sampling_rules.map((rule, index) => {
    const complete = extractSpan(rule.complete_span, evidenceById, `/sampling_rules/${index}/complete_span`, issues);
    return {
      rule_id: ruleIds.get(rule.key) ?? "",
      source_semantic_id: requireKey(rule.source_semantic_key, semanticIds, `/sampling_rules/${index}/source_semantic_key`, "semantic", issues),
      evidence_ids: unique([
        rule.complete_span.evidence_id,
        ...rule.branches.map((branch) => branch.span.evidence_id),
        ...rule.branches.flatMap((branch) => branch.conditions.map((condition) => condition.span.evidence_id)),
        ...rule.shared_conditions.map((condition) => condition.span.evidence_id),
        ...(rule.components ?? []).flatMap((component) => component.disposition === "present"
          ? component.spans.map((span) => span.evidence_id)
          : []),
        ...rule.branches.flatMap((branch) => (branch.components ?? []).flatMap((component) => (
          component.disposition === "present"
            ? component.spans.map((span) => span.evidence_id)
            : []
        ))),
      ]),
      complete_source_fragment: complete?.text ?? "",
      branches: rule.branches.map((branch, branchIndex) => {
        const fragment = extractSpan(branch.span, evidenceById, `/sampling_rules/${index}/branches/${branchIndex}/span`, issues);
        return {
          branch_id: branchIds.get(`${rule.key}\0${branch.key}`) ?? "",
          applies_to_category: branch.applies_to_category,
          min_sampling: branch.min_sampling,
          script: supportedSamplingScript(branch.script),
          evidence_id: fragment?.evidence_id ?? branch.span.evidence_id,
          exact_fragment: fragment?.text ?? "",
          conditions: branch.conditions.flatMap((condition, conditionIndex) => {
            const conditionFragment = extractSpan(
              condition.span,
              evidenceById,
              `/sampling_rules/${index}/branches/${branchIndex}/conditions/${conditionIndex}/span`,
              issues,
            );
            return conditionFragment ? [{
              condition_id: stableId("sampling-branch-condition", manifest.target_id, `${rule.key}\0${branch.key}\0${condition.key}`),
              text: condition.text,
              evidence_id: conditionFragment.evidence_id,
              exact_fragment: conditionFragment.text,
            }] : [];
          }),
        };
      }),
      shared_conditions: rule.shared_conditions.map((condition, conditionIndex) => {
        const fragment = extractSpan(condition.span, evidenceById, `/sampling_rules/${index}/shared_conditions/${conditionIndex}/span`, issues);
        return {
          condition_id: stableId("sampling-condition", manifest.target_id, `${rule.key}\0${condition.key}`),
          text: condition.text,
          evidence_id: fragment?.evidence_id ?? condition.span.evidence_id,
          exact_fragment: fragment?.text ?? "",
        };
      }),
      receiving_item_ids: decisions.items
        .filter((item) => item.sampling.rule_keys.includes(rule.key))
        .map((item) => itemIds.get(item.key) ?? "")
        .filter(Boolean),
      reason: rule.reason,
    };
  });

  let plan: SemanticSourcePlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: tableAssembly,
    inspection_lots: lots,
    acceptance_items: items,
    reference_resolutions: referenceResolutions,
    evidence_dispositions: decisions.evidence_dispositions.map((row) => ({
      evidence_id: row.evidence_id,
      disposition: row.disposition,
      item_ids: [],
      reason: row.reason,
    })),
    ...(manifest.source.semantic_workflow === SEMANTIC_EVIDENCE_SCHEMA_VERSION
      ? {
          semantic_evidence: semanticNodes,
          semantic_references: semanticReferences,
          shared_sampling_rules: sharedSamplingRules,
        }
      : {}),
  };
  plan = reconcileDerivedEvidenceDispositions(plan, manifest).plan;
  if (issues.length) throw new SemanticDecisionCompileError(issues);
  return plan;
}

/**
 * Compiles the same deterministic business plan as v7 while persisting source
 * provenance once in a plan-local span catalog. No v7 fragment text is searched
 * or reverse-mapped: every compact reference is built from the typed decision
 * offsets that produced it.
 */
export function compileSemanticDecisionsV8(
  decisions: SemanticDecisionPlan,
  manifest: EvidenceManifest,
): SemanticSourcePlanV8 {
  const expanded = compileSemanticDecisions(decisions, manifest);
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const issues: SemanticDecisionIssue[] = [];
  const catalog = new Map<string, SemanticSourcePlanV8["source_spans"][number]>();
  const fields = ["name", "requirement", "method", "quantity", "note"] as const;

  const intern = (span: EvidenceSpanDecision, path: string): string => {
    const evidence = evidenceById.get(span.evidence_id);
    if (
      !evidence
      || !Number.isInteger(span.start)
      || !Number.isInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > (evidence?.text.length ?? 0)
    ) {
      issues.push({
        code: evidence ? "decision_invalid_span" : "decision_unknown_evidence",
        path,
        message: evidence
          ? "Evidence spans must be non-empty UTF-16 offsets inside immutable evidence"
          : "The decision span names unknown immutable evidence",
        details: { evidence_id: span.evidence_id, start: span.start, end: span.end },
      });
      return "";
    }
    const textSha256 = sha256Text(evidence.text.slice(span.start, span.end));
    const spanId = sourceSpanIdFor(span.evidence_id, span.start, span.end, textSha256);
    catalog.set(spanId, {
      span_id: spanId,
      evidence_id: span.evidence_id,
      start: span.start,
      end: span.end,
      text_sha256: textSha256,
    });
    return spanId;
  };
  const internMany = (spans: readonly EvidenceSpanDecision[], path: string): string[] => unique(
    spans.map((span, index) => intern(span, `${path}/${index}`)).filter(Boolean),
  );
  const compactComponents = (
    components: readonly SemanticSamplingComponentDecision[] | undefined,
    path: string,
  ): SamplingComponentBinding[] => {
    const keys = (components ?? []).map((component) => component.key);
    for (const duplicate of duplicateKeys(keys)) {
      issues.push({
        code: "decision_sampling_component_key_duplicate",
        path,
        message: "Sampling component keys must be unique within their shared or branch-local scope",
        details: { key: duplicate },
      });
    }
    return (components ?? []).map((component, index) => {
      const componentPath = `${path}/${index}`;
      const sourceSpanIds = internMany(component.spans, `${componentPath}/spans`);
      if (component.disposition === "present" && sourceSpanIds.length === 0) {
        issues.push({
          code: "decision_sampling_component_present_unbound",
          path: `${componentPath}/spans`,
          message: "A present sampling component must bind at least one immutable source span",
        });
      }
      if (component.disposition !== "present" && component.spans.length > 0) {
        issues.push({
          code: "decision_sampling_component_absent_with_source",
          path: `${componentPath}/spans`,
          message: "An absent or not_applicable sampling component must not bind source spans",
        });
      }
      return {
        key: component.key,
        role: component.role,
        disposition: component.disposition,
        source_span_ids: sourceSpanIds,
        reason: component.reason,
      };
    });
  };

  const tableDecisionById = new Map(decisions.table_assembly.tables.map((table) => [
    stableId("table", manifest.target_id, table.key),
    table,
  ]));
  const itemDecisionById = new Map(decisions.items.map((item, originalIndex) => [
    semanticItemIdForSelectorKey(manifest.target_id, item.key),
    { decision: item, originalIndex },
  ]));
  const semanticDecisionById = new Map(decisions.semantic_nodes.map((node) => [
    stableId("semantic", manifest.target_id, node.key),
    node,
  ]));
  const samplingDecisionById = new Map(decisions.sampling_rules.map((rule) => [
    stableId("sampling", manifest.target_id, rule.key),
    rule,
  ]));

  const tableAssembly = {
    ...expanded.table_assembly,
    logical_tables: expanded.table_assembly.logical_tables.map((table, tableIndex) => {
      const decision = tableDecisionById.get(table.logical_table_id);
      if (!decision) {
        issues.push({ code: "decision_compact_table_missing", path: `/table_assembly/logical_tables/${tableIndex}`, message: "Compact compiler cannot recover the typed table decision" });
      }
      const { canonical_title_fragments: _fragments, ...rest } = table;
      return {
        ...rest,
        canonical_title_span_ids: internMany(
          decision?.title_spans ?? [],
          `/table_assembly/tables/${tableIndex}/title_spans`,
        ),
      };
    }),
  };

  const acceptanceItems: CompactAcceptanceItemPlan[] = expanded.acceptance_items.map((item, itemIndex) => {
    const authoredItem = itemDecisionById.get(item.item_id);
    const decision = authoredItem?.decision;
    const itemPath = `/items/${authoredItem?.originalIndex ?? itemIndex}`;
    if (!authoredItem) {
      issues.push({ code: "decision_compact_item_missing", path: `/acceptance_items/${itemIndex}`, message: "Compact compiler cannot recover the typed item decision" });
    }
    const fieldBindings = Object.fromEntries(fields.map((field) => {
      const binding = item.field_bindings[field];
      const { source_fragments: _fragments, ...rest } = binding;
      return [field, {
        ...rest,
        source_span_ids: internMany(
          decision?.fields[field].spans ?? [],
          `${itemPath}/fields/${field}/spans`,
        ),
      }];
    })) as CompactAcceptanceItemPlan["field_bindings"];

    const compactTable = item.table_semantics && decision?.table
      ? (() => {
          const {
            reference_fragments: _references,
            acceptance_branches: _acceptanceBranches,
            ...tableWithoutReferences
          } = item.table_semantics;
          return {
            ...tableWithoutReferences,
            cell_evidence: item.table_semantics.cell_evidence.map((cell, cellIndex) => ({
              role: cell.role,
              span_id: intern(
                decision.table!.cell_evidence[cellIndex]?.span ?? { evidence_id: "", start: 0, end: 0 },
                `${itemPath}/table/cell_evidence/${cellIndex}/span`,
              ),
            })),
            ...(item.table_semantics.acceptance_branches?.length ? {
              acceptance_branches: item.table_semantics.acceptance_branches.map((branch, branchIndex) => ({
                branch_id: branch.branch_id,
                condition: branch.condition,
                requirement: branch.requirement,
                allowed_value: branch.allowed_value,
                condition_span_ids: internMany(
                  decision.table!.acceptance_branches?.[branchIndex]?.condition_spans ?? [],
                  `${itemPath}/table/acceptance_branches/${branchIndex}/condition_spans`,
                ),
                requirement_span_ids: internMany(
                  decision.table!.acceptance_branches?.[branchIndex]?.requirement_spans ?? [],
                  `${itemPath}/table/acceptance_branches/${branchIndex}/requirement_spans`,
                ),
                allowed_value_span_ids: internMany(
                  decision.table!.acceptance_branches?.[branchIndex]?.allowed_value_spans ?? [],
                  `${itemPath}/table/acceptance_branches/${branchIndex}/allowed_value_spans`,
                ),
              })),
            } : {}),
            reference_span_ids: internMany(
              decision.table.reference_spans,
              `${itemPath}/table/reference_spans`,
            ),
          };
        })()
      : null;

    const compactAppliedBranches = item.sampling.applied_branches?.map((applied, appliedIndex) => {
      const rule = samplingDecisionById.get(applied.rule_id);
      const branch = rule?.branches.find((candidate) => (
        stableId("branch", manifest.target_id, `${rule.key}\0${candidate.key}`) === applied.branch_id
      ));
      if (!rule || !branch) {
        issues.push({ code: "decision_compact_sampling_branch_missing", path: `${itemPath}/sampling/applied_branches/${appliedIndex}`, message: "Compact compiler cannot recover the typed shared sampling branch" });
      }
      const sharedComponents = compactComponents(rule?.components, `/sampling_rules/${rule ? decisions.sampling_rules.indexOf(rule) : 0}/components`);
      const branchComponents = compactComponents(branch?.components, `/sampling_rules/${rule ? decisions.sampling_rules.indexOf(rule) : 0}/branches/${branch && rule ? rule.branches.indexOf(branch) : 0}/components`);
      const mergedComponents = mergeSamplingComponents(
        sharedComponents,
        branchComponents,
        `${itemPath}/sampling/applied_branches/${appliedIndex}/effective_components`,
      );
      issues.push(...mergedComponents.issues.map((issue) => ({
        ...issue,
        code: `decision_${issue.code}`,
      })));
      const compactConditions: CompactSharedSamplingCondition[] = applied.conditions.map((condition, conditionIndex) => ({
        condition_id: condition.condition_id,
        text: condition.text,
        source_span_ids: internMany(
          branch?.conditions[conditionIndex] ? [branch.conditions[conditionIndex]!.span] : [],
          `${itemPath}/sampling/applied_branches/${appliedIndex}/conditions/${conditionIndex}`,
        ),
      }));
      return {
        rule_id: applied.rule_id,
        branch_id: applied.branch_id,
        min_sampling: applied.min_sampling,
        script: applied.script,
        conditions: compactConditions,
        evidence_ids: applied.evidence_ids,
        effective_components: mergedComponents.components,
      };
    });

    const { applied_branches: _appliedBranches, ...samplingWithoutAppliedBranches } = item.sampling;
    return {
      ...item,
      table_semantics: compactTable,
      field_bindings: fieldBindings,
      sampling: {
        ...samplingWithoutAppliedBranches,
        applied_branches: compactAppliedBranches ?? [],
      },
    };
  });

  const semanticEvidence = expanded.semantic_evidence?.map((node, nodeIndex) => {
    const decision = semanticDecisionById.get(node.semantic_id);
    if (!decision) {
      issues.push({ code: "decision_compact_semantic_node_missing", path: `/semantic_evidence/${nodeIndex}`, message: "Compact compiler cannot recover the typed semantic node decision" });
    }
    const { evidence_id: _evidenceId, exact_fragment: _fragment, ...rest } = node;
    return {
      ...rest,
      span_id: decision ? intern(decision.span, `/semantic_nodes/${nodeIndex}/span`) : "",
    };
  });

  const sharedSamplingRules = expanded.shared_sampling_rules?.map((rule, ruleIndex) => {
    const decision = samplingDecisionById.get(rule.rule_id);
    if (!decision) {
      issues.push({ code: "decision_compact_sampling_rule_missing", path: `/shared_sampling_rules/${ruleIndex}`, message: "Compact compiler cannot recover the typed shared sampling rule" });
    }
    const components = compactComponents(decision?.components, `/sampling_rules/${ruleIndex}/components`);
    const branchComponents = (decision?.branches ?? []).flatMap((branch, branchIndex) =>
      compactComponents(branch.components, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`)
    );
    const registeredMembers = [...components, ...branchComponents]
      .filter((component) => component.disposition === "present")
      .flatMap((component) => component.source_span_ids);
    return {
      rule_id: rule.rule_id,
      source_semantic_id: rule.source_semantic_id,
      evidence_ids: rule.evidence_ids,
      complete_span_ids: unique(registeredMembers.length
        ? registeredMembers
        : decision ? [intern(decision.complete_span, `/sampling_rules/${ruleIndex}/complete_span`)] : []),
      branches: rule.branches.map((branch, branchIndex) => {
        const branchDecision = decision?.branches[branchIndex];
        const compactBranchComponents = compactComponents(
          branchDecision?.components,
          `/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`,
        );
        const { evidence_id: _evidenceId, exact_fragment: _fragment, conditions: _conditions, ...rest } = branch;
        return {
          ...rest,
          source_span_ids: unique([
            ...(branchDecision ? [intern(branchDecision.span, `/sampling_rules/${ruleIndex}/branches/${branchIndex}/span`)] : []),
            ...compactBranchComponents
              .filter((component) => component.disposition === "present")
              .flatMap((component) => component.source_span_ids),
          ]),
          conditions: (branch.conditions ?? []).map((condition, conditionIndex) => ({
            condition_id: condition.condition_id,
            text: condition.text,
            source_span_ids: internMany(
              branchDecision?.conditions[conditionIndex]
                ? [branchDecision.conditions[conditionIndex]!.span]
                : [],
              `/sampling_rules/${ruleIndex}/branches/${branchIndex}/conditions/${conditionIndex}`,
            ),
          })),
          components: compactBranchComponents,
        };
      }),
      shared_conditions: rule.shared_conditions.map((condition, conditionIndex) => ({
        condition_id: condition.condition_id,
        text: condition.text,
        source_span_ids: internMany(
          decision?.shared_conditions[conditionIndex]
            ? [decision.shared_conditions[conditionIndex]!.span]
            : [],
          `/sampling_rules/${ruleIndex}/shared_conditions/${conditionIndex}`,
        ),
      })),
      components,
      receiving_item_ids: rule.receiving_item_ids,
      reason: rule.reason,
    };
  });

  if (issues.length) throw new SemanticDecisionCompileError(issues);
  return {
    schema_version: COMPACT_PLAN_SCHEMA_VERSION,
    job_id: expanded.job_id,
    target_id: expanded.target_id,
    evidence_fingerprint: expanded.evidence_fingerprint,
    source_spans: [...catalog.values()].sort((left, right) => left.span_id.localeCompare(right.span_id)),
    table_assembly: tableAssembly,
    inspection_lots: expanded.inspection_lots,
    acceptance_items: acceptanceItems,
    reference_resolutions: expanded.reference_resolutions,
    evidence_dispositions: expanded.evidence_dispositions,
    ...(semanticEvidence ? { semantic_evidence: semanticEvidence } : {}),
    ...(expanded.semantic_references ? { semantic_references: expanded.semantic_references } : {}),
    ...(sharedSamplingRules ? { shared_sampling_rules: sharedSamplingRules } : {}),
  };
}

function exactSpan(
  evidenceId: string,
  text: string,
  evidenceById: Map<string, { text: string }>,
): EvidenceSpanDecision {
  const source = evidenceById.get(evidenceId)?.text ?? "";
  const start = source.indexOf(text);
  if (!text || start < 0) {
    throw new Error(`Cannot migrate non-exact fragment for ${evidenceId}`);
  }
  if (source.indexOf(text, start + 1) >= 0) {
    throw new Error(
      `Cannot migrate ambiguous repeated legacy fragment for ${evidenceId}; recompile from typed selectors and registered spans`,
    );
  }
  return { evidence_id: evidenceId, start, end: start + text.length };
}

function fullSpan(evidenceId: string, evidenceById: Map<string, { text: string }>): EvidenceSpanDecision {
  const text = evidenceById.get(evidenceId)?.text ?? "";
  if (!text) throw new Error(`Cannot migrate empty or unknown evidence ${evidenceId}`);
  return { evidence_id: evidenceId, start: 0, end: text.length };
}

/** Compatibility migration only. New Agent work authors decisions directly. */
export function semanticDecisionsFromPlan(
  plan: SemanticSourcePlan,
  manifest: EvidenceManifest,
): SemanticDecisionPlan {
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const lotKey = new Map(plan.inspection_lots.map((lot) => [lot.lot_id, lot.lot_id]));
  const itemKey = new Map(plan.acceptance_items.map((item) => [item.item_id, item.item_id]));
  const semanticKey = new Map((plan.semantic_evidence ?? []).map((node) => [node.semantic_id, node.semantic_id]));
  const ruleKey = new Map((plan.shared_sampling_rules ?? []).map((rule) => [rule.rule_id, rule.rule_id]));
  const branchKey = new Map((plan.shared_sampling_rules ?? []).flatMap((rule) =>
    rule.branches.map((branch) => [branch.branch_id, branch.branch_id] as const)
  ));
  const fields = ["name", "requirement", "method", "quantity", "note"] as const;
  return {
    schema_version: SEMANTIC_DECISION_SCHEMA_VERSION,
    job_id: plan.job_id,
    target_id: plan.target_id,
    evidence_fingerprint: plan.evidence_fingerprint,
    table_assembly: {
      tables: plan.table_assembly.logical_tables.map((table) => ({
        key: table.logical_table_id,
        canonical_title: table.canonical_title,
        title_spans: table.canonical_title_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
        evidence_spans: table.evidence_ids.map((id) => fullSpan(id, evidenceById)),
        fragment_ids: table.fragment_ids,
        ...(table.row_roles ? { row_roles: table.row_roles.map(row => ({ ...row })) } : {}),
        reason: table.reason,
        confidence: table.confidence,
        ...(table.row_roles ? { row_roles: structuredClone(table.row_roles) } : {}),
      })),
      fragment_dispositions: plan.table_assembly.fragment_dispositions.map((row) => ({
        fragment_id: row.fragment_id,
        disposition: row.disposition,
        table_key: row.logical_table_id,
        reason: row.reason,
      })),
    },
    lots: plan.inspection_lots.map((lot) => ({
      key: lot.lot_id,
      name: lot.name,
      evidence_spans: lot.evidence_ids.map((id) => fullSpan(id, evidenceById)),
      reason: "Migrated from a previously validated inspection-lot decision.",
    })),
    items: plan.acceptance_items.map((item) => ({
      key: item.item_id,
      lot_key: lotKey.get(item.lot_id) ?? item.lot_id,
      ...(item.name_path ? { name_path: [...item.name_path] } : {}),
      category: item.category,
      fields: Object.fromEntries(fields.map((field) => [field, {
        value: field === "name" && item.field_bindings[field].composition === "semantic_summary"
          ? item[field]
          : "",
        composition: item.field_bindings[field].composition,
        spans: item.field_bindings[field].source_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
        separator: item.field_bindings[field].source_fragments.length > 1 ? "\n" : "",
        reason: item.field_bindings[field].reason,
      }])) as Record<AcceptanceItemField, SemanticFieldDecision>,
      primary_spans: item.evidence_ids.map((id) => fullSpan(id, evidenceById)),
      table: item.table_semantics
        ? {
            source_kind: item.table_semantics.source_kind,
            table_key: item.table_semantics.table_id,
            table_no: item.table_semantics.table_no,
            table_title: item.table_semantics.table_title,
            applicability: item.table_semantics.applicability,
            row_path: item.table_semantics.row_path,
            column_path: item.table_semantics.column_path,
            unit: item.table_semantics.unit,
            condition: item.table_semantics.condition,
            allowed_value: item.table_semantics.allowed_value,
            ...(item.table_semantics.acceptance_branches?.length ? {
              acceptance_branches: item.table_semantics.acceptance_branches.map((branch) => ({
                key: branch.branch_id,
                condition: branch.condition,
                requirement: branch.requirement,
                allowed_value: branch.allowed_value,
                condition_spans: branch.condition_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
                requirement_spans: branch.requirement_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
                allowed_value_spans: branch.allowed_value_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
              })),
            } : {}),
            inspection_method: item.table_semantics.inspection_method,
            cell_evidence: item.table_semantics.cell_evidence.map((fragment) => ({
              role: fragment.role,
              span: exactSpan(fragment.evidence_id, fragment.text, evidenceById),
            })),
            reference_spans: item.table_semantics.reference_fragments.map((fragment) => exactSpan(fragment.evidence_id, fragment.text, evidenceById)),
          }
        : null,
      inspection_data_type: item.inspection_data_type,
      inspection_data_type_reason: item.inspection_data_type_reason,
      inspection_data_type_spans: item.inspection_data_type_evidence_ids.map((id) => fullSpan(id, evidenceById)),
      sampling: {
        status: item.sampling.status,
        min_sampling: item.sampling.min_sampling,
        script: item.sampling.script,
        reason: item.sampling.reason,
        confidence: item.sampling.confidence,
        evidence_spans: item.sampling.evidence_ids.map((id) => fullSpan(id, evidenceById)),
        rule_keys: (item.sampling.rule_ids ?? []).map((id) => ruleKey.get(id) ?? id),
        branch_keys: (item.sampling.branch_ids ?? []).map((id) => branchKey.get(id) ?? id),
      },
    })),
    semantic_nodes: (plan.semantic_evidence ?? []).map((node) => ({
      key: node.semantic_id,
      role: node.role,
      span: exactSpan(node.evidence_id, node.exact_fragment, evidenceById),
      parent_key: semanticKey.get(node.parent_semantic_id) ?? node.parent_semantic_id,
      item_key: itemKey.get(node.materialized_item_id) ?? node.materialized_item_id,
      reason: node.reason,
    })),
    references: (plan.semantic_references ?? []).map((reference) => ({
      key: reference.expansion_id,
      anchor_key: semanticKey.get(reference.anchor_semantic_id) ?? reference.anchor_semantic_id,
      status: reference.status,
      import_scope: reference.import_scope,
      target_keys: reference.target_semantic_ids.map((id) => semanticKey.get(id) ?? id),
      destinations: reference.destination_bindings.map((destination) => ({
        item_key: itemKey.get(destination.item_id) ?? destination.item_id,
        fields: destination.fields,
      })),
      reason: reference.reason,
    })),
    sampling_rules: (plan.shared_sampling_rules ?? []).map((rule) => ({
      key: rule.rule_id,
      source_semantic_key: semanticKey.get(rule.source_semantic_id) ?? rule.source_semantic_id,
      complete_span: exactSpan(rule.evidence_ids.find((id) => evidenceById.get(id)?.text.includes(rule.complete_source_fragment)) ?? rule.evidence_ids[0]!, rule.complete_source_fragment, evidenceById),
      branches: rule.branches.map((branch) => ({
        key: branch.branch_id,
        applies_to_category: branch.applies_to_category,
        min_sampling: branch.min_sampling,
        script: supportedSamplingScript(branch.script),
        span: exactSpan(branch.evidence_id, branch.exact_fragment, evidenceById),
        conditions: (branch.conditions ?? []).map((condition) => ({
          key: condition.condition_id,
          text: condition.text,
          span: exactSpan(condition.evidence_id, condition.exact_fragment, evidenceById),
        })),
      })),
      shared_conditions: rule.shared_conditions.map((condition) => ({
        key: condition.condition_id,
        text: condition.text,
        span: exactSpan(condition.evidence_id, condition.exact_fragment, evidenceById),
      })),
      receiver_item_keys: rule.receiving_item_ids.map((id) => itemKey.get(id) ?? id),
      reason: rule.reason,
    })),
    occurrence_resolutions: plan.reference_resolutions.map((resolution) => ({
      key: resolution.resolution_id,
      occurrence_id: resolution.occurrence_id,
      action: resolution.action,
      application_mode: resolution.application_mode,
      import_scope: resolution.import_scope,
      target_spans: resolution.target_evidence_ids.map((id) => fullSpan(id, evidenceById)),
      ...(resolution.origin_binding ? { origin_binding: {
        item_key: itemKey.get(resolution.origin_binding.item_id) ?? resolution.origin_binding.item_id,
        target_field: resolution.origin_binding.target_field,
      } } : {}),
      destinations: resolution.destination_bindings.map((destination) => ({
        item_key: itemKey.get(destination.item_id) ?? destination.item_id,
        target_field: destination.target_field,
      })),
      reason: resolution.reason,
    })),
    evidence_dispositions: plan.evidence_dispositions
      .filter((row) => row.disposition !== "used")
      .map((row) => ({
        evidence_id: row.evidence_id,
        disposition: row.disposition as "context" | "ignored",
        reason: row.reason,
      })),
  };
}

export function semanticDecisionFingerprint(decisions: SemanticDecisionPlan): string {
  return sha256Text(canonicalize(decisions));
}

function normalizedCharacters(value: string): Array<{ character: string; sourceIndex: number }> {
  const withoutMarkers = value.replace(/<!--\s*pages?[^>]*-->/gi, (marker) => " ".repeat(marker.length));
  const result: Array<{ character: string; sourceIndex: number }> = [];
  for (let index = 0; index < withoutMarkers.length; index += 1) {
    const normalized = withoutMarkers[index]!.normalize("NFKC");
    for (const character of normalized) {
      if (/\s|[*_`#]/u.test(character)) continue;
      result.push({ character, sourceIndex: index });
    }
  }
  return result;
}

export function locateEvidenceQuote(
  evidenceText: string,
  quote: string,
): Array<{ start: number; end: number; text: string; normalized: boolean }> {
  if (!quote) return [];
  const exact: Array<{ start: number; end: number; text: string; normalized: boolean }> = [];
  let offset = 0;
  while (offset <= evidenceText.length - quote.length) {
    const start = evidenceText.indexOf(quote, offset);
    if (start < 0) break;
    exact.push({ start, end: start + quote.length, text: quote, normalized: false });
    offset = start + 1;
  }
  if (exact.length) return exact;
  const source = normalizedCharacters(evidenceText);
  const needle = normalizedCharacters(quote).map((entry) => entry.character).join("");
  if (!needle) return [];
  const haystack = source.map((entry) => entry.character).join("");
  const matches: Array<{ start: number; end: number; text: string; normalized: boolean }> = [];
  let normalizedOffset = 0;
  while (normalizedOffset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, normalizedOffset);
    if (found < 0) break;
    const start = source[found]!.sourceIndex;
    const end = source[found + needle.length - 1]!.sourceIndex + 1;
    matches.push({ start, end, text: evidenceText.slice(start, end), normalized: true });
    normalizedOffset = found + 1;
  }
  return matches;
}
