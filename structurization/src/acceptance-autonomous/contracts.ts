/** Author files contain facts and proposed methods; approvals are controller-owned. */
export interface SourceQuote {
  source_id: string;
  block_id: string;
  start: number;
  end: number;
  text: string;
}

export interface BoundText {
  value: string;
  evidence: SourceQuote[];
  /** Summaries require semantic review and never substitute for a source quotation. */
  mode?: 'literal' | 'summary';
  reason?: string;
}

export interface SourceBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'table' | 'note' | 'page_marker';
  start: number;
  end: number;
  start_line: number;
  end_line: number;
  text: string;
  features: string[];
}

export interface SourceLedger {
  schema_version: 'acceptance-source-ledger/v1';
  source_id: string;
  sha256: string;
  blocks: SourceBlock[];
}

export interface AcceptanceRule {
  id: string;
  /** Paths are relative to work/, with content hashes calculated by the controller. */
  method_files: string[];
  scope: string;
  exceptions: string[];
  evidence: SourceQuote[];
  relationship?: {
    kind: 'membership' | 'shared_requirement' | 'inheritance' | 'sampling';
    objects: string[];
    conditions: BoundText[];
    exclusions: BoundText[];
  };
}

export interface AcceptanceItem {
  id: string;
  name: BoundText;
  category: BoundText;
  requirement: BoundText;
  method: BoundText;
  quantity: BoundText;
  unit: BoundText;
  condition: BoundText;
  note: BoundText;
  inspection_data_type: 'measurement' | 'counting' | 'mixed' | 'review';
  inspection_data_type_reason: string;
  sampling: {
    status: 'specified' | 'requires_conditions' | 'reference_unspecified_quantity' | 'not_sampling';
    text: BoundText;
    conditions: BoundText[];
    /** Formula is a symbolic relationship, never an invented fixed quantity. */
    formula?: { expression: string; variables: string[]; reason: string; evidence: SourceQuote[] };
  };
  reference_ids: string[];
  rule_ids: string[];
}

export interface AcceptanceLot {
  id: string;
  name: BoundText;
  /** Source-backed business ancestors; execution group ids are not business ancestors. */
  ancestors: Array<{ id: string; name: BoundText; kind: '分部' | '子分部' | '分项' }>;
  scope: { block_ids: string[]; reason: string; evidence: SourceQuote[] };
  group_id: string;
  dependency_ids: string[];
  items: AcceptanceItem[];
}

export interface AcceptanceGroup {
  id: string;
  structure: string;
  rule_ids: string[];
  lot_ids: string[];
  trial_lot_ids: string[];
  boundary_lot_ids: string[];
  conditions: string;
  exclusions: string[];
}

export interface SourceDisposition {
  source_id: string;
  block_id: string;
  role: 'lot' | 'shared' | 'not_extractable' | 'unresolved';
  lot_ids: string[];
  reason: string;
  evidence: SourceQuote[];
}

export interface AcceptanceReference {
  id: string;
  origin: SourceQuote;
  standard_no: string;
  version: string;
  clause: string;
  object: string;
  purpose: string;
  conditions: BoundText[];
  dependent_lot_ids: string[];
  /** The controller verifies this against origin coordinates and source ancestry. */
  disposition: 'literal' | 'applicable' | 'not_applicable' | 'unresolved';
  source_id?: string;
  evidence: SourceQuote[];
  reason: string;
}

export interface AcceptanceProblem {
  id: string;
  kind: 'scope' | 'structure' | 'conflict' | 'reference' | 'sampling' | 'extraction';
  message: string;
  /** Empty affected scope means unresolved global scope, and blocks all publication. */
  affected_lot_ids: string[];
  block_ids: string[];
  dependency_ids: string[];
}

export interface AcceptanceDelivery {
  schema_version: 'acceptance-autonomous-delivery/v1';
  source_sha256: string;
  rules: AcceptanceRule[];
  groups: AcceptanceGroup[];
  lots: AcceptanceLot[];
  dispositions: SourceDisposition[];
  references: AcceptanceReference[];
  problems: AcceptanceProblem[];
}

export interface AcceptanceIssue {
  code: string;
  path: string;
  actual: unknown;
  message: string;
  affected_lot_ids: string[];
}

export interface ReviewFailureCheck {
  id: string;
  request_id: string;
  finding_index: number;
  /** Current owner of the failed source scope; historical lot ids may have changed. */
  lot_id: string;
  path: string;
  message: string;
  evidence: SourceQuote[];
}

export interface GroupReviewRequest {
  id: string;
  phase: 'trial' | 'holdout' | 'full' | 'inventory' | 'exception';
  question?: string;
  fingerprint: string;
  group: AcceptanceGroup;
  rules: AcceptanceRule[];
  lots: AcceptanceLot[];
  /** Original blocks include adjacent context, not just author-selected quotations. */
  sources: SourceLedger[];
  dispositions: SourceDisposition[];
  references: AcceptanceReference[];
  /** Entry points for scoped reads; frozen source files remain independently accessible. */
  source_context?: Array<{ source_id: string; block_id: string; start_line: number; end_line: number }>;
  sample_fingerprints?: Record<string, string>;
  sample_fact_fingerprints?: Record<string, string>;
  failure_checks?: ReviewFailureCheck[];
  /** Host selects the sample; prose in the author group cannot expand or override the request. */
  review_scope?: { requested_lot_ids: string[]; total_group_lots: number; selection: 'controller' };
}

export interface GroupReviewResult {
  approved: boolean;
  reviewed_lot_ids: string[];
  findings: Array<{ lot_id: string; path: string; message: string; evidence: SourceQuote[] }>;
  reason: string;
  /** Explicit partial decisions; a group rejection alone never approves its other members. */
  lot_decisions?: Array<{ lot_id: string; approved: boolean; reason: string }>;
  failure_responses?: Array<{ check_id: string; disposition: 'fixed' | 'not_applicable' | 'unresolved'; reason: string; evidence: SourceQuote[] }>;
}

export interface SampleReviewReceipt { group_id: string; lot_id: string; fingerprint: string; request_id: string }

export type GroupReviewer = (request: GroupReviewRequest, signal?: AbortSignal) => Promise<GroupReviewResult>;

export interface AutonomousBudgetLimits {
  max_tool_response_bytes: number;
  max_single_tool_response_bytes: number;
  max_observed_context_tokens: number;
  max_attempts: number;
  concurrency: number;
}

/** Host-authorized additions; model tools cannot create or edit these receipts. */
export interface AutonomousBudgetExtension {
  id: string;
  request_id: string;
  from_bytes: number;
  to_bytes: number;
  reason: string;
  authorized_by: string;
  at: string;
  audit_sha256: string;
}

export interface AutonomousWorkRequest {
  id: string;
  kind: 'group_review' | 'exception' | 'extraction';
  fingerprint: string;
  source_ids: string[];
  lot_ids: string[];
  dependency_ids: string[];
  status: 'pending' | 'running' | 'passed' | 'needs_work' | 'failed';
  attempts: number;
  /** Actual returned content for this request, retained across retries. */
  tool_response_bytes?: number;
  result?: GroupReviewResult;
  error?: string;
  phase?: GroupReviewRequest['phase'];
  sample_fingerprints?: Record<string, string>;
  sample_fact_fingerprints?: Record<string, string>;
  failure_checks?: ReviewFailureCheck[];
  exposed_lots?: Array<{ lot_id: string; block_ids: string[] }>;
  extraction?: { task_id: string; block_ids: string[]; artifact_sha256?: string; merged?: boolean; merge_proposal_sha256?: string };
}

export interface ExtractionTask {
  id: string;
  block_ids: string[];
  instruction: string;
  method_files: string[];
  /** Set by the host from its frozen split, never accepted from model-supplied task arguments. */
  split_input?: { id: string; name: string; source: SourceQuote[]; shared: Array<{ id: string; source: SourceQuote[] }> };
}
export interface ExtractionTaskInput {
  request_id: string;
  directory: string;
  task: ExtractionTask;
  source_root: string;
  source_index: Array<{ source_id: string; markdown: string; ledger: string; images?: string }>;
  /** Host capability, never serialized into the worker's request.json. */
  validate_fragment: (fragment: AcceptanceDelivery) => void;
}
export type AcceptanceExtractor = (input: ExtractionTaskInput, signal?: AbortSignal) => Promise<void>;

export interface AcceptanceCheckpoint {
  schema_version: 'acceptance-autonomous-checkpoint/v1';
  review_failure_policy?: 'explicit/v1';
  source_sha256: string;
  lot_split?: { sha256: string; lots: number; history: import('./lot-split-handoff.js').LotSplitHandoff['history'] };
  generation: number;
  delivery_fingerprint: string;
  status: 'working' | 'partial' | 'complete' | 'blocked';
  budget: AutonomousBudgetLimits & { tool_response_bytes: number; observed_context_tokens: number; attempts: number };
  budget_extensions?: AutonomousBudgetExtension[];
  /** Host-authorized task starts are accounting only; budget.max_attempts still limits each request. */
  task_session_start_policy?: { id: string; request_id: string; scope: 'accounting_only';
    reason: string; authorized_by: string; at: string; audit_sha256: string };
  subtask_budget_policy?: { id: string; request_id: string; max_tool_response_bytes: number;
    reason: string; authorized_by: string; at: string; audit_sha256: string };
  /** The original counter remains monotonic; the immutable audit explains any legacy measurement difference. */
  tool_response_accounting?: { version: 1; historical_counter_bytes: number; historical_returned_bytes: number;
    adjustment_bytes: number; audit_sha256: string };
  /** Historical accounting is retained separately, never relabelled as new-engine work. */
  predecessor?: { job_id: string; fingerprint: string; accounting_path: string };
  requests: AutonomousWorkRequest[];
  sample_reviews?: SampleReviewReceipt[];
  /** Append-only declarations: deleting a trial/boundary label never makes its source unseen again. */
  training_declarations?: Array<{ lot_id: string; block_ids: string[] }>;
  /** Frozen companion-image manifests; Markdown and existing counters stay unchanged. */
  source_image_manifests?: Record<string, string>;
  training_declaration_initialization?: { audit_sha256: string };
  approvals: Array<{ group_id: string; fingerprint: string; trial_request_id: string; holdout_request_id: string;
    protocol_version?: 2 | 3 | 4; review_mode?: 'holdout' | 'full'; training_lot_ids?: string[]; sample_reviews?: SampleReviewReceipt[];
    /** v4 separates seen source scopes from the samples that actually require a passing decision. */
    required_lot_ids?: string[];
    /** Decision prefix and field-only passing proofs keep repaired historical cases out of future trials. */
    selection_history_count?: number;
    /** These requests were unfinished when samples were selected; a later retry cannot rewrite that decision's past. */
    selection_pending_request_ids?: string[];
    failure_resolutions?: Array<SampleReviewReceipt & { facts_fingerprint: string }>;
    training_declaration_count?: number }>;
  invalidations: Array<{ group_id: string; fingerprint: string; reason: string; at: string }>;
  table_sweeps?: Array<{ id: string; group_id: string; path: string; sha256: string; phase?: 'trial' | 'batch' }>;
  group_seals?: Array<{ group_id: string; fingerprint: string; group_fingerprint: string; path: string; sweep_id?: string;
    mode?: 'semantic_exception'; reason?: string }>;
  publications: Array<{ fingerprint: string; lot_ids: string[]; path: string; status: 'partial' | 'complete'; review_protocol_version?: 3 | 4;
    review_failure_policy?: 'explicit/v1';
    lot_split_sha256?: string;
    source_image_manifests?: Record<string, string>; source_edition_proofs?: Record<string, import('../external-source-edition.js').FrozenEditionProof> }>;
  waiting_for_sources?: string[];
}
