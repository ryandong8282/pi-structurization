export const EVIDENCE_SCHEMA_VERSION = "evidence-manifest/v6" as const;
export const EVIDENCE_SCOPE_SCHEMA_VERSION = "markdown-target-scope/v1" as const;
export const TABLE_ASSEMBLY_SCHEMA_VERSION = "table-assembly-plan/v1" as const;
export const PLAN_SCHEMA_VERSION = "semantic-source-plan/v7" as const;
export const COMPACT_PLAN_SCHEMA_VERSION = "semantic-source-plan/v8" as const;
export const RESULT_SCHEMA_VERSION = "acceptance-result/v9" as const;
export const SEMANTIC_EVIDENCE_SCHEMA_VERSION = "semantic-evidence-plan/v1" as const;

export type TargetFailureClass =
  | "transport"
  | "provider_configuration"
  | "candidate"
  | "scope_extension"
  | "coverage_repair"
  | "coverage_harness_defect";

// Visible marker for an acceptance-item name that kept a review-worthy shape
// after its one blocking correction round. Downstream surfaces it for manual
// review instead of letting validation loop forever.
export const ACCEPTANCE_NAME_REVIEW_PREFIX = "⚠ 待复核 · " as const;

/** An item can have a source-backed criterion without a source-backed class label. */
export const UNLABELED_ITEM_CATEGORY = "原文未标明类别" as const;
export type AcceptanceItemCategory = "主控项目" | "一般项目" | typeof UNLABELED_ITEM_CATEGORY;

export type EvidenceKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table_row";

export type EvidenceRole =
  | "section_heading"
  | "supporting_clause"
  | "formal_table_title"
  | "table_continuation_caption"
  | "formal_table_header"
  | "formal_table_row"
  | "sampling_rule"
  | "table_note"
  | "context";

export type SamplingOccurrenceKind =
  | "explicit_quantity"
  | "reference"
  | "fallback"
  | "not_sampling";

export type SamplingOccurrenceScope =
  | "general"
  | "chapter_general"
  | "target"
  | "referenced";

export interface SamplingOccurrence {
  occurrence_id: string;
  kind: SamplingOccurrenceKind;
  clause_id: string;
  objects: string[];
  condition: string;
  quantity: string;
  scope: SamplingOccurrenceScope;
  references: string[];
  source_order: number;
}

export interface EvidenceRecord {
  evidence_id: string;
  /** Immutable document atom this derived record came from. */
  atom_id?: string;
  kind: EvidenceKind;
  role: EvidenceRole;
  locator: string;
  /** Mechanical line coordinate for a char-addressed document slice. */
  source_start_line?: number;
  text: string;
  text_sha256: string;
  requires_disposition: boolean;
  evidence_scope?: "primary" | "reference" | "sampling";
  registered_dependency?: boolean;
  table_row_kind?: "header" | "data";
  /** Bindable table-row text contains cell values only; navigation stays typed. */
  table_text_format?: "cell_values_v1";
  table_fragment_id?: string;
  table_id?: string;
  /**
   * 题注被 OCR 拆行时 table_id 退化成 `line-N`（这是留给语义组装层的信号，不改）。
   * 别名记下从题注候选里认出的真实表号，仅供引用查表多认一个键——不进 locator，
   * 因此不影响 evidence_id。
   */
  table_alias_ids?: string[];
  table_title?: string;
  row_index?: number;
  columns?: string[];
  cells?: string[];
  cell_geometry?: Array<{
    cell_id: string;
    row: number;
    column: number;
    rowspan: number;
    colspan: number;
    text: string;
  }>;
  clause_id?: string;
  sampling_occurrence?: SamplingOccurrence;
}

export interface TableFragmentEvidence {
  fragment_id: string;
  source_order: number;
  locator: string;
  provisional_table_id: string;
  provisional_title: string;
  title_candidate_evidence_ids: string[];
  continuation_caption_evidence_ids?: string[];
  header_evidence_ids: string[];
  row_evidence_ids: string[];
  formal_row_evidence_ids: string[];
  columns: string[];
}

export type ReferenceOccurrenceStatus =
  | "resolved"
  | "target_not_found"
  | "ambiguous"
  | "cycle"
  | "depth_limit";

export interface ExternalStandardReferencePlaceholder {
  standard_no: string;
  standard_title?: string;
  status: "placeholder" | "resolved";
  usage?: "citation_only" | "content_required";
  expansion?: "literal_only";
  expansion_reason?: "nested_source_unavailable" | "allowable_deviation_reference" | "user_ignored_source";
  user_ignore?: import("./external-source-workflow.js").ExternalSourceIgnoreDecision;
  markdown_sha256?: string;
}

interface ReferenceOccurrenceBase {
  occurrence_id: string;
  origin_evidence_id: string;
  /** Ordered source records. Absent on legacy single-evidence occurrences. */
  origin_evidence_ids?: string[];
  origin_span_id?: string;
  /** Ordered origin spans. Absent on legacy single-span occurrences. */
  origin_span_ids?: string[];
  reference_literal_span_id?: string;
  /** Ordered literal spans. Absent on legacy single-span occurrences. */
  reference_literal_span_ids?: string[];
  reference_literal?: {
    evidence_id: string;
    start: number;
    end: number;
  };
  /** Ordered literal coordinates. Absent on legacy single-span occurrences. */
  reference_literals?: Array<{
    evidence_id: string;
    start: number;
    end: number;
  }>;
  origin_fields: Array<Exclude<ReferenceTargetField, "reference_only">>;
  raw_reference: string;
  /** Agent-normalized semantic label; literal fragments remain immutable provenance. */
  normalized_reference?: string;
  relation?: string;
  external_standard?: ExternalStandardReferencePlaceholder;
  target_evidence_ids: string[];
  required: boolean;
  status: ReferenceOccurrenceStatus;
  depth: number;
  path: string[];
  /** Author-selected business scope for a whole-standard citation; source text stays intact. */
  content_scope?: ExternalReferenceContentScope;
}

export interface ExternalReferenceContentScope {
  mode: "selected_targets" | "whole_standard";
  targets?: Array<{ kind: "clause" | "section" | "table" | "appendix"; number: string; paragraph?: string; candidate_start_line?: number }>;
  reason: string;
}

export interface TableReferenceOccurrence extends ReferenceOccurrenceBase {
  reference_kind: "table";
  target_table_id: string;
  target_address?: {
    source_id: string;
    locator_kind: "table";
    locator: string;
  };
}

export interface ClauseReferenceOccurrence extends ReferenceOccurrenceBase {
  reference_kind: "clause";
  target_address: {
    /** Stable document/catalog identity. Today this is the current Markdown SHA256. */
    source_id: string;
    locator_kind: "clause" | "section" | "appendix" | "standard";
    locator: string;
  };
}

export type ReferenceOccurrence = TableReferenceOccurrence | ClauseReferenceOccurrence;

export interface ReferenceCorrectionRecord {
  previous_occurrence: ReferenceOccurrence;
  replacement_occurrence_id: string;
  reason: string;
  timestamp: string;
}

export type ReferenceLiteralCoordinate = NonNullable<ReferenceOccurrence["reference_literal"]>;

/** Backward-compatible ordered view for persisted single- and multi-span occurrences. */
export function referenceOccurrenceOriginEvidenceIds(occurrence: ReferenceOccurrence): string[] {
  return occurrence.origin_evidence_ids?.length
    ? [...occurrence.origin_evidence_ids]
    : [occurrence.origin_evidence_id];
}

/** Backward-compatible ordered view for persisted single- and multi-span origins. */
export function referenceOccurrenceOriginSpanIds(occurrence: ReferenceOccurrence): string[] {
  return occurrence.origin_span_ids?.length
    ? [...occurrence.origin_span_ids]
    : occurrence.origin_span_id
      ? [occurrence.origin_span_id]
      : [];
}

/** Backward-compatible ordered view for persisted single- and multi-span occurrences. */
export function referenceOccurrenceLiteralSpanIds(occurrence: ReferenceOccurrence): string[] {
  return occurrence.reference_literal_span_ids?.length
    ? [...occurrence.reference_literal_span_ids]
    : occurrence.reference_literal_span_id
      ? [occurrence.reference_literal_span_id]
      : [];
}

/** Backward-compatible ordered view for persisted single- and multi-span occurrences. */
export function referenceOccurrenceLiterals(occurrence: ReferenceOccurrence): ReferenceLiteralCoordinate[] {
  return occurrence.reference_literals?.length
    ? occurrence.reference_literals.map((literal) => ({ ...literal }))
    : occurrence.reference_literal
      ? [{ ...occurrence.reference_literal }]
      : [];
}

export function referenceOccurrenceTargetLocator(occurrence: ReferenceOccurrence): string {
  if (occurrence.external_standard && occurrence.target_address) {
    return `${occurrence.target_address.source_id}:${occurrence.target_address.locator}`;
  }
  return occurrence.reference_kind === "table"
    ? `table:${occurrence.target_table_id}`
    : `${occurrence.target_address.source_id}:${occurrence.target_address.locator}`;
}

/**
 * One source literal pointing at one target is one logical occurrence. The
 * model's claimed business field is intentionally excluded: it remains
 * correctable until a selector candidate validates that route.
 */
export function sameLogicalReferenceOccurrence(
  left: ReferenceOccurrence,
  right: ReferenceOccurrence,
): boolean {
  const leftLiterals = referenceOccurrenceLiterals(left);
  const rightLiterals = referenceOccurrenceLiterals(right);
  if (
    referenceOccurrenceOriginEvidenceIds(left).join("\0") !== referenceOccurrenceOriginEvidenceIds(right).join("\0")
    || left.reference_kind !== right.reference_kind
    || left.status !== right.status
    || left.required !== right.required
    || referenceOccurrenceTargetLocator(left) !== referenceOccurrenceTargetLocator(right)
    || leftLiterals.length === 0
    || leftLiterals.length !== rightLiterals.length
    || leftLiterals.some((leftLiteral, index) => {
      const rightLiteral = rightLiterals[index]!;
      return leftLiteral.evidence_id !== rightLiteral.evidence_id
        || leftLiteral.start >= rightLiteral.end
        || rightLiteral.start >= leftLiteral.end;
    })
  ) return false;
  const rightTargets = new Set(right.target_evidence_ids);
  return left.target_evidence_ids.length === right.target_evidence_ids.length
    && left.target_evidence_ids.every((evidenceId) => rightTargets.has(evidenceId));
}

/** Prove that a parser table reference and an exact resolver literal are the same occurrence. */
export function canAnchorStaticTableReference(
  previous: ReferenceOccurrence,
  proposed: ReferenceOccurrence,
  manifest: Pick<EvidenceManifest, "source" | "evidence">,
): boolean {
  if (previous.reference_kind !== "table" || proposed.reference_kind !== "table"
    || previous.external_standard || proposed.external_standard
    || previous.status !== "resolved" || proposed.status !== "resolved"
    || previous.required !== proposed.required
    || previous.target_table_id !== proposed.target_table_id
    || referenceOccurrenceLiterals(previous).length
    || referenceOccurrenceLiteralSpanIds(previous).length
    || referenceOccurrenceOriginSpanIds(previous).length
    || proposed.target_address?.source_id !== manifest.source.sha256
    || (previous.target_address && previous.target_address.source_id !== manifest.source.sha256)
  ) return false;
  const origins = referenceOccurrenceOriginEvidenceIds(previous);
  const literals = referenceOccurrenceLiterals(proposed);
  if (origins.length !== 1 || literals.length !== 1
    || referenceOccurrenceOriginEvidenceIds(proposed).join("\0") !== origins.join("\0")
    || previous.target_evidence_ids.length !== proposed.target_evidence_ids.length
    || !previous.target_evidence_ids.every(id => proposed.target_evidence_ids.includes(id))
  ) return false;
  const source = manifest.evidence.find(record => record.evidence_id === origins[0]);
  const raw = previous.raw_reference.replace(/\s/gu, "");
  if (!source || !raw) return false;
  // Static discovery removes whitespace from table tokens. Retain a coordinate
  // map so that this normalization never changes the immutable literal span.
  const positions: number[] = [];
  const compact = source.text.split("").filter((character, index) => {
    if (/\s/u.test(character)) return false;
    positions.push(index);
    return true;
  }).join("");
  const start = compact.indexOf(raw);
  const literal = literals[0]!;
  return start >= 0 && compact.indexOf(raw, start + 1) === -1
    && literal.evidence_id === source.evidence_id
    && literal.start >= 0 && literal.end <= source.text.length
    && literal.start <= positions[start]! && literal.end > positions[start + raw.length - 1]!;
}

export interface EvidenceScopeCandidate {
  start_line: number;
  end_exclusive_line: number;
  heading: string;
  score: number;
  selected: boolean;
  reason: string;
}

export interface SemanticReferenceCandidate {
  candidate_id: string;
  evidence_id: string;
  exact_fragment: string;
  discovery_basis: "text-retrieval";
  reason: string;
}

export interface EvidenceScope {
  schema_version: typeof EVIDENCE_SCOPE_SCHEMA_VERSION;
  mode: "target_section" | "full_document" | "agent_discovered";
  target_id: string;
  source_line_count: number;
  selected_start_line: number;
  selected_end_exclusive_line: number;
  selected_heading: string;
  selection_reason: string;
  confirmed_scope_fingerprint?: string;
  primary_source_ranges?: Array<{ start_line: number; end_exclusive_line: number }>;
  /** Read-backed scope blocker nominations added by the harness in a fresh revision. */
  scope_extension_atom_ids?: string[];
  selected_atom_ids?: string[];
  target_evidence_fragments?: Array<{ atom_id: string; text: string }>;
  reference_candidates?: SemanticReferenceCandidate[];
  table_navigation_candidates?: TableFragmentEvidence[];
  /** Non-exhaustive upstream context hints; not automatically applicable sampling rules. */
  governing_context_evidence_ids?: string[];
  candidates: EvidenceScopeCandidate[];
}

export interface EvidenceManifest {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  job_id: string;
  target_id: string;
  source: {
    adapter: "markdown-target-scope/v3" | "document-domain-agent/v1";
    file_name: string;
    sha256: string;
    semantic_workflow?: typeof SEMANTIC_EVIDENCE_SCHEMA_VERSION;
    pdf_file_name?: string;
    pdf_sha256?: string;
  };
  scope: EvidenceScope;
  evidence: EvidenceRecord[];
  table_fragments: TableFragmentEvidence[];
  reference_occurrences: ReferenceOccurrence[];
  evidence_fingerprint: string;
}

export type EvidenceDispositionKind = "used" | "context" | "ignored";

export interface EvidenceDisposition {
  evidence_id: string;
  disposition: EvidenceDispositionKind;
  item_ids: string[];
  reason: string;
}

export interface InspectionLotPlan {
  lot_id: string;
  name: string;
  evidence_ids: string[];
  item_ids: string[];
}

export type InspectionDataType =
  | "measurement"
  | "counting"
  | "mixed"
  | "review";

export interface AcceptanceItemPlan {
  item_id: string;
  lot_id: string;
  name: string;
  /** Model-authored semantic name segments; never inferred from table geometry. */
  name_path?: string[];
  category: AcceptanceItemCategory;
  requirement: string;
  method: string;
  quantity: string;
  note: string;
  evidence_ids: string[];
  reference_evidence_ids: string[];
  table_semantics: TableCriterionSemantics | null;
  inspection_data_type: InspectionDataType;
  inspection_data_type_reason: string;
  inspection_data_type_evidence_ids: string[];
  field_bindings: AcceptanceItemFieldBindings;
  sampling: SamplingDecision;
}

export type AcceptanceItemField =
  | "name"
  | "requirement"
  | "method"
  | "quantity"
  | "note";

export type SourceBindingComposition =
  | "verbatim"
  | "semantic_summary"
  | "shared_inheritance"
  | "reference"
  | "not_applicable";

export type SourceBindingStatus =
  | "bound"
  | "not_found_in_evidence"
  | "not_applicable"
  | "review";

export interface SourceFragment {
  evidence_id: string;
  text: string;
}

export type TableCriterionSourceKind = "direct" | "reference";

export type TableCellEvidenceRole =
  | "table_no"
  | "table_title"
  | "applicability"
  | "row_header"
  | "column_header"
  | "unit"
  | "condition"
  | "allowed_value"
  | "inspection_method";

export interface TableCellEvidence extends SourceFragment {
  role: TableCellEvidenceRole;
}

export interface TableAcceptanceBranch {
  branch_id: string;
  condition: string;
  requirement: string;
  allowed_value: string;
  condition_fragments: SourceFragment[];
  requirement_fragments: SourceFragment[];
  allowed_value_fragments: SourceFragment[];
}

/**
 * Semantic table context for one independently judged acceptance criterion.
 *
 * row_path/column_path are semantic paths, not trusted physical coordinates.
 * At least one path is required; one-dimensional or flattened text evidence
 * must not be forced to invent a physical header axis that does not exist.
 * cell_evidence retains exact immutable source text separately from the Agent's
 * semantic summaries, so damaged HTML, flattened text, and OCR output use the
 * same contract.
 */
export interface TableCriterionSemantics {
  source_kind: TableCriterionSourceKind;
  table_id: string;
  table_no: string;
  table_title: string;
  applicability: string;
  row_path: string[];
  column_path: string[];
  unit: string;
  condition: string;
  allowed_value: string;
  /**
   * Authoritative condition -> requirement/allowed-value mapping for mutually
   * exclusive cases of this one acceptance dimension. Optional only for
   * backward compatibility and unbranched table criteria.
   */
  acceptance_branches?: TableAcceptanceBranch[];
  inspection_method: string;
  cell_evidence: TableCellEvidence[];
  reference_fragments: SourceFragment[];
}

export interface ConfirmedTableRowRole {
  evidence_id: string;
  role: "header" | "data" | "repeated_header" | "note" | "context";
  reason: string;
}

export interface LogicalTableAssembly {
  logical_table_id: string;
  canonical_title: string;
  canonical_title_fragments: SourceFragment[];
  evidence_ids: string[];
  fragment_ids: string[];
  /** Confirmed structure decisions retained for validation after the authoring session. */
  row_roles?: ConfirmedTableRowRole[];
  reason: string;
  confidence: number;
}

export interface TableFragmentDisposition {
  fragment_id: string;
  disposition: "assigned" | "context" | "review";
  logical_table_id: string;
  reason: string;
}

export interface TableAssemblyPlan {
  schema_version: typeof TABLE_ASSEMBLY_SCHEMA_VERSION;
  evidence_fingerprint: string;
  logical_tables: LogicalTableAssembly[];
  fragment_dispositions: TableFragmentDisposition[];
}

export interface FieldSourceBinding {
  status: SourceBindingStatus;
  composition: SourceBindingComposition;
  evidence_ids: string[];
  source_fragments: SourceFragment[];
  value_sha256: string;
  reason: string;
}

export type AcceptanceItemFieldBindings = Record<
  AcceptanceItemField,
  FieldSourceBinding
>;

export type ReferenceTargetField =
  | AcceptanceItemField
  | "sampling"
  | "reference_only";

export type ReferenceImportField = Exclude<ReferenceTargetField, "reference_only">;

export interface ReferenceImportScope {
  mode: "field_specific" | "full_acceptance_procedure";
  allowed_fields: ReferenceImportField[];
  reason: string;
}

export type ReferenceResolutionAction =
  | "adopt"
  | "conditional"
  | "compare"
  | "mention"
  | "keep_reference"
  | "review";

export type ReferenceApplicationMode =
  | "replace_field"
  | "reference_only"
  | "reference_placeholder";

export interface ReferenceDestinationBinding {
  item_id: string;
  target_field: ReferenceTargetField;
}

export interface ReferenceOriginBinding {
  item_id: string;
  target_field: Exclude<ReferenceTargetField, "reference_only">;
}

export interface ReferenceResolution {
  resolution_id: string;
  occurrence_id: string;
  origin_evidence_id: string;
  action: ReferenceResolutionAction;
  application_mode: ReferenceApplicationMode;
  import_scope: ReferenceImportScope;
  target_evidence_ids: string[];
  origin_binding?: ReferenceOriginBinding;
  destination_bindings: ReferenceDestinationBinding[];
  reason: string;
}

export interface MaterializedResolvedReferenceRecord {
  evidence_id: string;
  kind: EvidenceKind;
  role: EvidenceRole;
  locator: string;
  text: string;
  table_id?: string;
  table_title?: string;
  row_index?: number;
  columns?: string[];
  cells?: string[];
}

export interface MaterializedInlineReference {
  external_standard?: ExternalStandardReferencePlaceholder;
  occurrence_id: string;
  resolution_id: string;
  field: ReferenceTargetField;
  display_order: number;
  raw_reference: string;
  normalized_reference?: string;
  origin_evidence_id: string;
  origin_evidence_ids?: string[];
  relation: string;
  import_scope: ReferenceImportScope;
  reference_literal_span_id: string;
  reference_literal_span_ids?: string[];
  reference_literal: {
    evidence_id: string;
    start: number;
    end: number;
  };
  reference_literals?: ReferenceLiteralCoordinate[];
  target: {
    source_id: string;
    kind: "clause" | "section" | "table" | "appendix" | "standard";
    locator: string;
  };
  origin_structure?: {
    table_id?: string;
    row_index?: number;
    columns?: string[];
    cells?: string[];
  };
  segments: Array<
    | { kind: "source"; text: string; start: number; end: number; evidence_id?: string }
    | { kind: "reference"; raw_reference: string; span_id: string; occurrence_id: string; evidence_id?: string }
  >;
  resolved_content: {
    records: MaterializedResolvedReferenceRecord[];
  };
}

export type SamplingDecisionStatus =
  | "explicit"
  | "reference"
  | "reference_unspecified_quantity"
  | "fallback"
  | "not_sampling";

export interface SamplingDecision {
  status: SamplingDecisionStatus;
  min_sampling: string;
  /** Derived restricted expression; not_sampling/fallback normalize to 灰显 with high/low confidence. */
  script: string;
  reason: string;
  confidence: number;
  evidence_ids: string[];
  rule_ids?: string[];
  branch_ids?: string[];
  /** Added in target-selector v4; optional only for reading older sealed plans. */
  applied_branches?: AppliedSamplingBranch[];
}

export interface AppliedSamplingBranch {
  rule_id: string;
  branch_id: string;
  min_sampling: string;
  /** Derived restricted sampling expression; empty when unsupported. Legacy plans may contain prose. */
  script: string;
  conditions: SharedSamplingCondition[];
  evidence_ids: string[];
  /** Role-labelled registered members, present on compact v8 materialization. */
  components?: SamplingComponentBinding[];
}

export type SemanticEvidenceRole =
  | "reference_anchor"
  | "referenced_clause"
  | "continuation"
  | "acceptance_item"
  | "table_criterion"
  | "acceptance_condition"
  | "sampling_rule";

export interface SemanticEvidenceNode {
  semantic_id: string;
  role: SemanticEvidenceRole;
  evidence_id: string;
  exact_fragment: string;
  parent_semantic_id: string;
  materialized_item_id: string;
  reason: string;
}

export interface SemanticReferenceExpansion {
  expansion_id: string;
  anchor_semantic_id: string;
  status: "resolved" | "not_applicable" | "review";
  import_scope: ReferenceImportScope;
  target_semantic_ids: string[];
  destination_bindings: Array<{
    item_id: string;
    fields: ReferenceTargetField[];
  }>;
  reason: string;
}

export interface SharedSamplingBranch {
  branch_id: string;
  applies_to_category: "主控项目" | "一般项目" | "all_items";
  min_sampling: string;
  /** Derived restricted sampling expression; empty when unsupported. Legacy plans may contain prose. */
  script: string;
  evidence_id: string;
  exact_fragment: string;
  /** Added in target-selector v4; absent only on older sealed plans. */
  conditions?: SharedSamplingCondition[];
  /** Registered branch-local members; absent on legacy v7 plans. */
  components?: SamplingComponentBinding[];
}

export interface SharedSamplingCondition {
  condition_id: string;
  text: string;
  evidence_id: string;
  exact_fragment: string;
}

export interface SharedSamplingRule {
  rule_id: string;
  source_semantic_id: string;
  evidence_ids: string[];
  complete_source_fragment: string;
  branches: SharedSamplingBranch[];
  shared_conditions: SharedSamplingCondition[];
  /** Registered shared members; absent on legacy v7 plans. */
  components?: SamplingComponentBinding[];
  receiving_item_ids: string[];
  reason: string;
}

export interface SemanticSourcePlan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  job_id: string;
  target_id: string;
  evidence_fingerprint: string;
  table_assembly: TableAssemblyPlan;
  inspection_lots: InspectionLotPlan[];
  acceptance_items: AcceptanceItemPlan[];
  reference_resolutions: ReferenceResolution[];
  evidence_dispositions: EvidenceDisposition[];
  semantic_evidence?: SemanticEvidenceNode[];
  semantic_references?: SemanticReferenceExpansion[];
  shared_sampling_rules?: SharedSamplingRule[];
}

/**
 * Facts the rejecting `if` already knows. New/touched model-facing issues must
 * fill `required_action`. Optional fields are omitted only when they do not apply.
 */
export interface ActionableIssueDetails {
  required_action: string;
  writable_collection?: string;
  writable_path?: string;
  not_writable?: string;
  next_tool?: string;
  allowed?: unknown;
  actual?: unknown;
  [key: string]: unknown;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  details: ActionableIssueDetails;
}

/** Tool failure returned to the authoring model. `instruction` is required. */
export type ActionableToolReject = {
  ok: false;
  error: string;
  instruction: string;
} & Record<string, unknown>;

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Non-blocking observations; correctness is decided by the model. */
  model_review?: ValidationIssue[];
  /** Hydrated in-memory view for deterministic legacy consumers. */
  plan?: SemanticSourcePlan;
  /** Exact compact artifact to persist; absent for legacy v7 validation. */
  persisted_plan?: SemanticSourcePlanV8;
  plan_sha256?: string;
  fingerprint?: string;
}

/**
 * Immutable source coordinates used by the compact v8 persisted plan.
 * Source text is resolved from the evidence manifest and is never copied into
 * this catalog. The plan fingerprint covers this catalog and every reference
 * to it.
 */
export interface PlanSourceSpan {
  span_id: string;
  evidence_id: string;
  start: number;
  end: number;
  text_sha256: string;
}

export interface SourceSpanReference {
  span_id: string;
}

export interface TableCellEvidenceReference extends SourceSpanReference {
  role: TableCellEvidenceRole;
}

export interface CompactTableCriterionSemantics extends Omit<
  TableCriterionSemantics,
  "cell_evidence" | "reference_fragments" | "acceptance_branches"
> {
  cell_evidence: TableCellEvidenceReference[];
  acceptance_branches?: Array<Omit<
    TableAcceptanceBranch,
    "condition_fragments" | "requirement_fragments" | "allowed_value_fragments"
  > & {
    condition_span_ids: string[];
    requirement_span_ids: string[];
    allowed_value_span_ids: string[];
  }>;
  reference_span_ids: string[];
}

export interface CompactLogicalTableAssembly extends Omit<
  LogicalTableAssembly,
  "canonical_title_fragments"
> {
  canonical_title_span_ids: string[];
}

export interface CompactTableAssemblyPlan extends Omit<TableAssemblyPlan, "logical_tables"> {
  logical_tables: CompactLogicalTableAssembly[];
}

export interface CompactFieldSourceBinding extends Omit<FieldSourceBinding, "source_fragments"> {
  source_span_ids: string[];
}

export type CompactAcceptanceItemFieldBindings = Record<
  AcceptanceItemField,
  CompactFieldSourceBinding
>;

export type SamplingComponentRole =
  | "applicability"
  | "branch_condition"
  | "method"
  | "quantity"
  | "acceptance_criterion"
  | "exception"
  | "note";

export type SamplingComponentDisposition = "present" | "absent" | "not_applicable";

export interface SamplingComponentBinding {
  key: string;
  role: SamplingComponentRole;
  disposition: SamplingComponentDisposition;
  source_span_ids: string[];
  /** Hydrated runtime provenance; compact persisted plans keep only source_span_ids. */
  source_fragments?: SourceFragment[];
  reason: string;
}

export interface CompactSharedSamplingCondition extends Omit<
  SharedSamplingCondition,
  "evidence_id" | "exact_fragment"
> {
  source_span_ids: string[];
}

export interface CompactAppliedSamplingBranch extends Omit<
  AppliedSamplingBranch,
  "conditions"
> {
  conditions: CompactSharedSamplingCondition[];
  effective_components: SamplingComponentBinding[];
}

export interface CompactSamplingDecision extends Omit<SamplingDecision, "applied_branches"> {
  applied_branches?: CompactAppliedSamplingBranch[];
}

export interface CompactAcceptanceItemPlan extends Omit<
  AcceptanceItemPlan,
  "table_semantics" | "field_bindings" | "sampling"
> {
  table_semantics: CompactTableCriterionSemantics | null;
  field_bindings: CompactAcceptanceItemFieldBindings;
  sampling: CompactSamplingDecision;
}

export interface CompactSemanticEvidenceNode extends Omit<
  SemanticEvidenceNode,
  "evidence_id" | "exact_fragment"
> {
  span_id: string;
}

export interface CompactSharedSamplingBranch extends Omit<
  SharedSamplingBranch,
  "evidence_id" | "exact_fragment" | "conditions"
> {
  source_span_ids: string[];
  conditions?: CompactSharedSamplingCondition[];
  components: SamplingComponentBinding[];
}

export interface CompactSharedSamplingRule extends Omit<
  SharedSamplingRule,
  "complete_source_fragment" | "branches" | "shared_conditions"
> {
  complete_span_ids: string[];
  branches: CompactSharedSamplingBranch[];
  shared_conditions: CompactSharedSamplingCondition[];
  components: SamplingComponentBinding[];
}

/** New compiler output. Existing sealed v7 plans remain byte-for-byte replayable. */
export interface SemanticSourcePlanV8 extends Omit<
  SemanticSourcePlan,
  | "schema_version"
  | "table_assembly"
  | "acceptance_items"
  | "semantic_evidence"
  | "shared_sampling_rules"
> {
  schema_version: typeof COMPACT_PLAN_SCHEMA_VERSION;
  /** Versioned deterministic-validation policy; absent on historical artifacts. */
  validation_boundary?: "structure-and-references/v1";
  source_spans: PlanSourceSpan[];
  table_assembly: CompactTableAssemblyPlan;
  acceptance_items: CompactAcceptanceItemPlan[];
  semantic_evidence?: CompactSemanticEvidenceNode[];
  shared_sampling_rules?: CompactSharedSamplingRule[];
}

export type PersistedSemanticSourcePlan = SemanticSourcePlan | SemanticSourcePlanV8;

export interface RepairIssueClusterState {
  key: string;
  issue_count: number;
  issue_fingerprint: string;
  issue_codes: string[];
  item_ids: string[];
}

export interface RepairConvergenceState {
  mode: "modeling" | "repair" | "validated";
  repair_source?: "validation" | "coverage";
  active_cluster: RepairIssueClusterState | null;
  total_issue_count: number;
  validation_fingerprint: string;
  selector_fingerprint?: string;
  /** Local validator diagnostics must not overwrite the original coverage finding fingerprint. */
  selector_validation_issue_fingerprint?: string;
  coverage_review_fingerprint?: string;
  coverage_finding_ids?: string[];
  coverage_evidence_ids?: string[];
  coverage_item_ids?: string[];
  non_converging_rounds: number;
  fresh_session_required: boolean;
  session_epoch: number;
  /**
   * Fresh sessions started because validation repair demanded one
   * (`repair_session_restart_required`). Interrupted-session retirement and
   * source-handle scope changes start sessions mechanically and must not
   * consume this bounded budget.
   */
  repair_session_restarts: number;
}

export interface SourceOrderAnchor {
  /** Coordinates in the current Markdown, never a referenced external document. */
  line?: number;
  offset?: number;
  row: number;
  column: number;
}

export interface MaterializedAcceptanceItem {
  item_id: string;
  name: string;
  name_path?: string[];
  /** Mechanical source coordinates for display ordering, not semantic grouping. */
  source_anchors?: SourceOrderAnchor[];
  category: AcceptanceItemCategory;
  requirement: string;
  method: string;
  quantity: string;
  note: string;
  evidence_ids: string[];
  reference_evidence_ids: string[];
  reference_resolution_ids: string[];
  reference_origin_item_id: string;
  reference_path: string[];
  source_clause: string;
  reference_source_clause: string;
  reference_from_clause: string;
  inline_references?: MaterializedInlineReference[];
  table_semantics: TableCriterionSemantics | null;
  inspection_data_type: InspectionDataType;
  inspection_data_type_reason: string;
  inspection_data_type_evidence_ids: string[];
  sampling: SamplingDecision;
}

export interface MaterializedInspectionLot {
  lot_id: string;
  name: string;
  evidence_ids: string[];
  items: MaterializedAcceptanceItem[];
}

export interface AcceptanceResult {
  schema_version: typeof RESULT_SCHEMA_VERSION;
  job_id: string;
  target_id: string;
  evidence_fingerprint: string;
  table_assembly_fingerprint: string;
  plan_fingerprint: string;
  reference_occurrences?: ReferenceOccurrence[];
  inspection_lots: MaterializedInspectionLot[];
}

export interface RevisionState {
  schema_version: "revision-state/v1";
  revision: number;
  lineage?: {
    schema_version: "revision-lineage/v1";
    source_revision: number;
    selector_checkpoint_revision: number;
    registry_checkpoint_revision: number;
    /** Optional for legacy states; new recoveries always record the evidence side of the checkpoint bundle. */
    evidence_checkpoint_revision?: number;
    recovery_kind: "sealed_checkpoint" | "interrupted_checkpoint" | "terminal_checkpoint" | "terminal_sealed_ancestor" | "modeling_checkpoint";
  };
  status: "working" | "sealed" | "failed" | "cancelled";
  terminal_at?: string;
  terminal_reason?: string;
  terminal_blocker_code?: string;
  terminal_failure_class?: TargetFailureClass;
  source_fingerprint?: string;
  build_fingerprint?: string;
  next_event_sequence: number;
  next_history_sequence: number;
  next_validation_sequence: number;
  validation_attempts: number;
  last_valid_fingerprint: string;
  last_valid_plan_sha256: string;
  opened_evidence_ids?: string[];
  opened_evidence_window_keys?: string[];
  opened_global_resource_ids?: string[];
  document_reference_reads?: Record<string, {
    /** Legacy records omit phase and belong only to target authoring. */
    phase?: "target" | "coverage";
    read_policy: "exact" | "exhaustive";
    content_mode: "full_text";
    total_count: number;
    next_cursor: number | null;
    done: boolean;
    /** New records share one exhaustive cursor for every occurrence with this immutable target inventory. */
    target_key?: string;
    target_locator?: string;
    target_fingerprint?: string;
    target_evidence_count?: number;
  }>;
  reference_analysis_modes?: Record<string, {
    analysis_mode: "inline" | "isolated";
    target_text_utf8_bytes: number;
    estimated_compact_page_count: number;
    evidence_count: number;
    mode_reason: string;
  }>;
  reference_fact_reads?: Record<string, {
    fingerprint: string;
    total_count: number;
    next_cursor: number | null;
    done: boolean;
  }>;
  /**
   * 被引目标的目录表态。闸门从「读完全部正文」挪到「对每条目录条目表态」——
   * 一样拦得住静默漏读，代价从上百 KB 降到几 KB。key = `${phase}:${targetKey}`。
   */
  reference_catalog_dispositions?: Record<string, {
    /** 旧状态没有版本号；读取时会安全失效并由当前目录重新建立。 */
    fingerprint_version?: "reference-catalog-disposition-fingerprint/v2";
    fingerprint: string;
    rule_source: string;
    entry_ids: string[];
    used: string[];
    ignored: Array<{ entry_id: string; reason: string }>;
    opened_ranges?: Record<string, Record<string, Array<[number, number]>>>;
  }>;
  /** 规则发现 Agent 的产出缓存，按被引目标存；命中就不再叫模型。 */
  reference_catalog_rules?: Record<string, {
    table_title: string;
    table_continuation: string;
    clause: string;
    subitem: string;
  }>;
  /** Exhausted rule discovery; fingerprint includes evidence and fallback policy. Not a read/coverage receipt. */
  reference_catalog_fallbacks?: Record<string, string>;
  selector_stage?: "primary" | "sampling" | "table" | "commit" | "coverage_repair";
  /** Fresh live targets use one mandatory review turn in the primary Agent session. */
  target_review_protocol?: "direct-validation/v1" | "same-agent-self-review/v1" | "legacy-independent-coverage/v1";
  /** Exact program-prefilled draft; provenance only, never validation or coverage approval. */
  selector_prefill_fingerprint?: string;
  /** Legacy checkpoint field; ignored and removed on reopen. Reading never requires a draft save. */
  selector_batch_requires_stage?: boolean;
  selector_protocol?: {
    submissions: number;
    corrections: number;
    coverage_repairs: number;
    transport_failures: number;
    protocol_failures: number;
    last_transport_failure: string;
    last_protocol_failure: string;
    last_issue_owner: "" | "selector_input_error" | "compiler_invariant_violation" | "final_contract_violation";
    last_issue_fingerprint: string;
    stage_retries?: {
      stage: NonNullable<RevisionState["selector_stage"]>;
      best_stage_rank: number;
      best_issue_count: number;
      consecutive_non_improvements: number;
      checkpoint?: {
        working_selector_sha256: string;
        history_sequence: number;
        selector_stage: string;
        checkpoint_fingerprint: string;
      };
    };
    /** 最近一次阶段校验未过项的紧凑清单：续作会话据此定点处理，不再全量摸索。 */
    last_stage_issues?: Array<{
      code: string;
      path: string;
      evidence_ids?: string[];
      how_to_pass?: string;
      next_tool?: string;
      next_tool_arguments?: Record<string, unknown>;
      record_read?: { tool: "read_target_selectors"; arguments: { collection: string; key: string } };
    }>;
    /** 已执行检查的完整诊断；只读分页须核验检查输入指纹，不重新校验。 */
    last_stage_diagnostics?: { inputs_fingerprint: string; contract_version?: string; issues: unknown[] };
    best_draft_fingerprint: string;
    best_history_sequence: number;
    best_preflight_stage_rank: number;
    best_issue_count: number | null;
    best_issue_fingerprint: string;
    consecutive_non_improvements: number;
    self_review_requested_fingerprint?: string;
    self_review_completed?: boolean;
    self_review_fingerprint?: string;
    language_correction_attempts?: Record<string, string>;
    language_review_markers?: Array<{
      path: string;
      item_key?: string;
      original_name: string;
      marked_name: string;
    }>;
    name_correction_attempts?: Record<string, string>;
    name_review_markers?: Array<{
      path: string;
      item_key?: string;
      original_name: string;
      marked_name: string;
      signals: string[];
    }>;
    recent_reference_issue_states?: Array<{
      occurrence_id: string;
      issue_codes: string[];
      issue_fingerprint: string;
    }>;
    recent_table_expansion_issue_states?: Array<{
      item_key: string;
      issue_codes: string[];
      issue_fingerprint: string;
    }>;
  };
  coverage_recheck?: {
    schema_version: "coverage-recheck-scope/v1";
    plan_fingerprint: string;
    source_plan_fingerprint: string;
    review_fingerprint: string;
    finding_ids: string[];
    affected_item_ids: string[];
    affected_evidence_ids: string[];
  };
  repair?: RepairConvergenceState;
  agent_runtime: {
    kind: "offline-scripted" | "pi-sdk" | "unassigned";
    session_id: string;
    session_file: string;
  };
}

export interface TranscriptEvent {
  schema_version: "agent-event/v1";
  sequence: number;
  timestamp: string;
  runtime: RevisionState["agent_runtime"];
  event_type: string;
  payload: unknown;
}
