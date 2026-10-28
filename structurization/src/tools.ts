import { replaceAcceptanceToolText } from "./acceptance-tool-text.js";
import { modelSourceDocumentContext } from "./source-document-context.js";
import { renderFeedback } from "./acceptance-feedback-text.js";
import { readDiscoveryContextNotes } from "./discovery-context.js";
import { PROMPT_SUITE_VERSION, TARGET_SELECTOR_PROTOCOLS, LEGACY_PLAN_PROTOCOL } from "./acceptance-prompt-suite.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "./acceptance-tool-text.js";
﻿import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { selectorDiagnosticToolResponse } from "./selector-diagnostics.js";
import { isModelReviewIssue, STRUCTURAL_VALIDATION_BOUNDARY } from "./validation-boundary.js";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } from "diff";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { catchToolReject, toolReject } from "./actionable-error.js";
import { REFERENCE_CORRECTION_FIELDS } from "./reference-correction.js";
import { wholeExternalReferenceScopeReview } from "./external-reference-scope.js";
import { compactSourceReadRoutes, prioritizeWorkRoutes, selectorPatchReceipt, selectorWorkAction, selectorWorkNextStep } from "./selector-feedback.js";
import { COMPONENT_PLAN_INPUT, componentPlanView, componentStepAccounting, componentStepDiagnosticScope, readComponentPlans, saveComponentPlan, type ComponentPlanInput } from "./component-work-plan.js";
import { projectReferenceFieldSelections, referenceFieldSelectionCapability, type ReferenceFieldSelectionResult } from "./reference-field-selection.js";
import { REFERENCE_COMPONENT_EDIT_INPUT, editReferenceComponents, type ReferenceComponentEditInput } from "./reference-component-edit.js";
import { FIELD_SOURCE_BINDING_GUIDANCE, INVESTIGATION_KEY_SOURCE_GUIDANCE, ITEM_NAME_PATH_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE, SELECTOR_PATCH_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE, SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE, SOURCE_READING_GUIDANCE, selectorDeliveryInvestigationHints } from "./acceptance-delivery-contract.js";
import { selectorDeliveryPreview } from "./selector-delivery-preview.js";
import { pageDiagnosticResponse, readDiagnosticArrayPage } from "./selector-diagnostic-array-pages.js";
import { selectorIssueProbes, selectorAuthorFactsFingerprint, selectorBlockerObservations, selectorBlockerImproved, observeSelectorBlockers,
  type SelectorIssueProbe, type SelectorBlockerObservation, type SelectorBlockerHistory } from "./selector-blocker-progress.js";
import { selectSelectorRepairFocus, type SelectorRepairFocus } from "./selector-repair-work.js";
import { sourceBoundaryNeighbors } from "./source-boundary-review.js";
import { atomicWriteJson, atomicWriteNewText, makeReadOnly, pathExists, readJson } from "./atomic.js";
import { auditAndPersist } from "./audit.js";
import { isContinuingCoverageRepair, PROTOCOL_TARGET_FAILURES } from "./attempt-budget.js";
import { canonicalize, prettyJson, sha256Json, sha256Text } from "./canonical.js";
import { compiledWorkingPlanCapacityFailure, serializeCompiledWorkingPlan, WORKING_PLAN_MAX_BYTES } from "./working-plan-storage.js";
import type {
  ActionableToolReject,
  EvidenceDisposition,
  EvidenceManifest,
  PersistedSemanticSourcePlan,
  RevisionState,
  SemanticSourcePlan,
  SemanticSourcePlanV8,
  ValidationResult,
} from "./contracts.js";
import {
  PLAN_SCHEMA_VERSION,
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceTargetLocator,
  referenceOccurrenceLiterals,
  referenceOccurrenceOriginEvidenceIds,
  referenceOccurrenceOriginSpanIds,
} from "./contracts.js";
import { buildItemFieldBindings } from "./domain-contract.js";
import { documentSearchMatch } from "./governing-context.js";
import { sourceSearchNavigation } from "./source-search.js";
import { createTableHeadingLookup } from "./table-heading-context.js";
import {
  joinedFormalClauseId,
  evaluateTargetLedgerCoverage,
  ledgerRequiredClausePredicate,
  ledgerSectionsForClauses,
  requiredClauseIdsInSourceRanges,
  resolveLedgerWindowForTarget,
  type DocumentLedger,
  type LedgerWindowTargetRef,
} from "./document-ledger.js";
import {
  accountedReferenceOriginEvidenceIds,
  boundFieldClauseIds,
  evidenceLineIndex,
  ledgerClauseIdSet,
  resolveItemClauseId,
} from "./ledger-reconciliation.js";
import {
  compiledUnhandledEvidenceIds,
  evidenceRequiresSelectorDisposition,
  selectorDispositionCoverage,
} from "./evidence-disposition-coverage.js";
import {
  compositeReferenceReviewCandidate,
  compositeReferenceReviewCandidates,
  documentReferenceTargetReadIdentity,
  resolveAndRegisterDocumentReference,
  type DocumentReferenceKind,
} from "./document-reference.js";
import { createExternalStandardReferenceTool, registerExternalStandardReference } from "./external-standard-reference.js";
import type { ExternalSourceWorkflow } from "./external-source-workflow.js";
import { materialize } from "./materializer.js";
import { hydrateSemanticSourcePlan, isCompactSemanticSourcePlan } from "./plan-hydration.js";
import { semanticItemIdForSelectorKey } from "./semantic-decision-compiler.js";
import { strictJsonParse } from "./strict-json.js";
import {
  buildInitialTableAssembly,
  buildPlanContract,
} from "./source-plan-contract.js";
import { confirmProvisionalTableAssembly } from "./table-assembly.js";
import {
  semanticSourcePlanJsonSchemaFor,
  validatePlanText,
} from "./validator.js";
import { validateTableAssembly } from "./table-assembly.js";
import {
  coverageRepairAllowsExternalDependency,
  RevisionWorkspace,
} from "./workspace.js";
import {
  applyJsonPatchOperation,
  type JsonPatchOperation,
} from "./json-patch.js";
import {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  CoverageReviewController,
  coverageFieldScopedReferenceRoutesForItem,
  coverageReviewObligations,
  deriveCoverageRepairRecheckScope,
  readSealedCoverageReview,
  type SemanticCoverageDisposition,
} from "./coverage-review.js";
import {
  coverageBlockerOwnerDecision,
  type CoverageBlockerOwnerDecision,
} from "./coverage-blocker-routing.js";
import {
  coverageReferenceRepairOptions,
} from "./coverage-reference-repair.js";
import {
  changedSemanticRecords,
  canonicalizeSharedSamplingSourceFragments,
  normalizeOptionalSemanticSentinels,
  reconcileDerivedEvidenceDispositions,
  repairStateOrDefault,
  selectActiveIssueCluster,
  validationIssueClusters,
} from "./repair-convergence.js";
import {
  authoredReplaceFieldSelectorIssues,
  compileTargetSelectors,
  initialTargetSelectorPlan,
  migrateTargetSelectorPlan,
  migrateTargetSelectorPlanForAuthoring,
  registeredDocumentReferenceReceiptIssues,
  unresolvedReferenceDestinationIssues,
  resolvedReferenceDestinationIssues,
  requiredReferenceAnchorOnlyEvidenceIds,
  requiredReferenceFieldOnlyEvidenceIds,
  REFERENCE_APPLICATION_MODE_SEMANTICS,
  SOURCE_SPAN_ID_PATTERN,
  SELECTOR_TABLE_KEY_GUIDANCE,
  SAMPLING_COMPONENT_ROLES,
  TARGET_SELECTOR_DRAFT_JSON_SCHEMA,
  TARGET_SELECTOR_DRAFT_PATCH_JSON_SCHEMA,
  TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA,
  TARGET_SELECTOR_PLAN_JSON_SCHEMA,
  TARGET_SELECTOR_AUTHOR_PLAN_JSON_SCHEMA,
  TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
  TargetSelectorCompileError,
  tableExpansionState,
  targetSelectorFingerprint,
  targetSelectorSchemaIssues,
  type TargetSelectorPlan,
  type TargetSelectorDraft,
  type TargetSelectorDraftPatch,
} from "./target-selector-compiler.js";
import {
  compileTargetSelectorsWithContext,
  createSelectorCompilerContext,
  selectorCompilerAcceptedReviews,
  selectorCompilerContextFingerprint,
  type SelectorCompilerContext,
} from "./selector-compiler-context.js";
import {
  locateAndRegisterSourceQuote,
  locateSourceQuote,
  registerHtmlTableCellSpans,
  registerSourceSpan,
  renderedTableCellSpans,
  tableEvidenceTextFormat,
  resolveSourceSpan,
  sourceSpanRegistryFingerprint,
  SourceSpanRegistryError,
  type SourceSpanRegistry,
} from "./source-span-registry.js";
import {
  applyRepeatedSourceLanguageNamePolicy,
  applyRepeatedVerdictNamePolicy,
  classifyCompilerInvariantIssues,
  isSourceDispositionRepairIssueCode,
  classifySelectorIssues,
  classifyStrictSelectorIssues,
  decideStrictSelectorPreflight,
  REFERENCE_ORIGIN_CONTEXT_SCOPE_GUIDANCE,
  REFERENCE_IMPORT_SCOPE_REPAIR_GUIDANCE,
  INSPECTION_DATA_TYPE_SOURCE_REPAIR_GUIDANCE,
} from "./selector-issue-ownership.js";
import {
  coalesceFieldBindingDiagnostics,
  coalesceReferencePlaceholderResolutionDiagnostics,
  coalesceReferenceToolDiagnostics,
  coalesceUnhandledEvidenceDiagnostics,
  coalesceSelectorIssueDiagnostics,
} from "./selector-issue-diagnostics.js";
import { projectReferencedTableDestinations } from "./reference-table-destination-projection.js";
import { checkTargetCompilerInvariants } from "./target-compiler-invariants.js";
import {
  TABLE_STRUCTURE_SCHEMA_VERSION,
  initialTableStructurePlan,
  pendingComplexTableStructureIssues,
  tableStructureFingerprint,
  tableStructureProgress,
  validateTableStructurePlan,
  type TableStructureDecision,
  type TableStructurePlan,
} from "./table-structure.js";
import {
  buildDocumentEvidence,
  type DocumentAtom,
  type DocumentEvidence,
} from "./document-discovery.js";
import {
  createEvidenceSourceRangeResolver,
  createDocumentHeadingNavigation,
  excludeProtectedSourceLineWindows,
  partitionDocumentSourceRanges,
  referenceOccurrenceTargetsDocument,
  sourceRangesOverlap,
} from "./source-provenance-ranges.js";
import {
  REFERENCE_ACTION_GUIDANCE_ZH,
} from "./reference-guidance.js";
import { externalReferenceExpansionPolicy, externalReferenceFieldPolicy } from "./external-reference-policy.js";
import {
  assignReferenceAnalysisPolicy,
  inlineReferenceReadIssues,
  isolatedReferenceTargetForEvidence,
  projectReferenceAnalysisPolicies,
  readInlineReferenceEvidencePage,
  readAnalyzedReferenceCatalog,
  referenceAnalysisIssues,
  referenceCatalogDeliveryWork,
  referenceAnalysisPolicy,
} from "./reference-analysis.js";
import type { CatalogRuleAsk } from "./reference-catalog-discovery.js";

type ToolResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: boolean; error?: undefined; [key: string]: unknown }
  | ActionableToolReject;

interface TargetSelectorPreflight {
  ok: boolean;
  stage_rank: number;
  stage_name: "selector-local" | "compiler-invariant" | "strict-validator" | "complete";
  issue_owner: "" | "selector_input_error" | "compiler_invariant_violation" | "final_contract_violation";
  issues: unknown[];
  issue_count: number;
  issue_fingerprint: string;
  response: ToolResponse;
  selectors: TargetSelectorPlan;
  compiler_context?: SelectorCompilerContext;
  compiled?: PersistedSemanticSourcePlan;
  compiled_content?: string;
}

// Source coverage returns before compilation. Keep its persisted rank 1 and
// the existing invariant/strict ranks 2/3; newly exposed compilation findings
// belong between them and must not be compared with a smaller source count.
const SELECTOR_COMPILATION_CHECKPOINT_RANK = 1.5;

interface SelectorValidationCandidate {
  selector_fingerprint: string;
  compiled_plan_sha256: string;
  selector_compiler_context_fingerprint: string;
}

interface PersistedValidationReceipt {
  schema_version?: unknown;
  sequence?: unknown;
  attempt?: unknown;
  ok?: unknown;
  issues?: unknown;
  evidence_fingerprint?: unknown;
  plan_sha256?: unknown;
  validation_fingerprint?: unknown;
  validator?: unknown;
  trigger?: unknown;
  repair?: unknown;
  previous_total_issue_count?: unknown;
  selector_fingerprint?: unknown;
  compiled_plan_sha256?: unknown;
  selector_compiler_context_fingerprint?: unknown;
}

type SemanticPlanValidatorVersion =
  | "semantic-source-plan-validator/v4"
  | "semantic-source-plan-validator/v5";

export function semanticPlanValidatorVersion(
  plan: PersistedSemanticSourcePlan | unknown,
): SemanticPlanValidatorVersion {
  return isCompactSemanticSourcePlan(plan)
    ? "semantic-source-plan-validator/v5"
    : "semantic-source-plan-validator/v4";
}

export function validationReceiptMatchesPlanVersion(
  receipt: { validator?: unknown },
  plan: PersistedSemanticSourcePlan | unknown,
): boolean {
  return receipt.validator === semanticPlanValidatorVersion(plan);
}

export function compareTargetSelectorPreflightScore(
  candidate: Pick<TargetSelectorPreflight, "stage_rank" | "issue_count">,
  best: { stage_rank: number; issue_count: number | null },
): "improved" | "stagnation" | "regression" {
  if (best.issue_count === null || candidate.stage_rank > best.stage_rank) return "improved";
  if (candidate.stage_rank < best.stage_rank) return "regression";
  if (candidate.issue_count < best.issue_count) return "improved";
  if (candidate.issue_count === best.issue_count) return "stagnation";
  return "regression";
}

function withoutSelectorExplanations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSelectorExplanations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "reason" && !key.endsWith("_reason"))
    .map(([key, child]) => [key, withoutSelectorExplanations(child)]));
}

function selectorSpanIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (child: unknown, key = ""): void => {
    if (Array.isArray(child)) {
      if (key === "span_ids" || key.endsWith("_span_ids")) {
        for (const entry of child) if (typeof entry === "string") ids.add(entry);
      } else {
        for (const entry of child) visit(entry);
      }
      return;
    }
    if (!child || typeof child !== "object") return;
    for (const [childKey, grandchild] of Object.entries(child as Record<string, unknown>)) {
      visit(grandchild, childKey);
    }
  };
  visit(value);
  return [...ids].sort();
}

export type TargetSelectorStage = NonNullable<RevisionState["selector_stage"]>;
export type TargetSelectorCurrentState = "blank" | "current_existing" | "inherited_existing";
export type TargetSelectorCheckpointStatus = "blank" | "program_prefill" | "unvalidated_draft" | "validated_candidate";

interface TargetSelectorCounts {
  lots: number;
  items: number;
  sampling_rules: number;
  references: number;
  source_dispositions: number;
}

export interface TargetSelectorStartupContext {
  current_selector_state: TargetSelectorCurrentState;
  current_selector_checkpoint: TargetSelectorCheckpointStatus;
  read_target_selectors_required: boolean;
  current_selector_summary: {
    draft_fingerprint: string;
    counts: TargetSelectorCounts;
    lineage?: RevisionState["lineage"];
  };
  /** 继承的阶段停滞检查点：存在时启动提示必须提前告知，否则恢复会话可能在
   *  未保存任何修复的情况下重试阶段转换并立即终止（实测金属 rev12：继承
   *  count 3/3，首个未修复 ADV 当场判死，模型零工作机会）。 */
  inherited_stage_retry?: {
    stage: NonNullable<RevisionState["selector_stage"]>;
    best_stage_rank: number;
    best_issue_count: number;
    consecutive_non_improvements: number;
  };
  /** 上次阶段校验未过项：有完整快照时仅在输入和契约仍匹配时提供定点修法。 */
  resume_focus?: Array<{ code: string; path: string; evidence_ids?: string[]; how_to_pass?: string;
    next_tool?: string; next_tool_arguments?: Record<string, unknown>;
    record_read?: { tool: "read_target_selectors"; arguments: { collection: string; key: string } } }>;
  historical_repair_navigation?: ReturnType<typeof historicalSelectorRepairNavigation>;
}

const SELECTOR_STAGE_ORDER: TargetSelectorStage[] = ["primary", "sampling", "table", "commit"];
const SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT = 32;
const SELECTOR_TOOL_ISSUE_PAGE_MAX_BYTES = 48 * 1024;
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Display-only deduplication; every removed detail remains on the issue itself. */
export function selectorRepairIssueWithoutRepeatedDetails(issue: unknown): unknown {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
  const record = issue as Record<string, unknown>;
  if (!record.details || typeof record.details !== "object" || Array.isArray(record.details)) return issue;
  const details = { ...record.details as Record<string, unknown> };
  const atIssueLevel = Object.keys(details).filter(key => Object.hasOwn(record, key)
    && JSON.stringify(details[key]) === JSON.stringify(record[key]));
  if (!atIssueLevel.length) return issue;
  for (const key of atIssueLevel) delete details[key];
  return { ...record, details, detail_fields_at_issue_level: atIssueLevel };
}
const SELECTOR_TOOL_OMITTED_DETAIL_ARRAYS = new Set([
  "registered_subspan_candidates",
  "contained_item_bindings",
]);
const SELECTOR_NAVIGATION_TOOLS = new Set([
  "read_target_selector_issues",
  "save_target_investigation",
  "save_target_component_plan",
  "list_evidence_resources", "list_global_document_resources", "search_global_document_resources", "open_global_document_resource",
  "open_adjacent_document_resource", "register_external_dependency", "resolve_document_reference",
  "read_document_reference_evidence", "read_reference_facts", "open_evidence", "search_evidence",
  "batch_open_evidence", "batch_search_evidence", "locate_evidence_span", "batch_locate_evidence_spans",
  "list_table_fragments", "read_table_summary", "read_table_rows", "read_adjacent_source", "read_saved_table_structure",
]);
const INHERITED_SELECTOR_READ_GATED_TOOLS = new Set([
  "locate_evidence_span",
  "batch_locate_evidence_spans",
  "stage_target_selector_draft",
  "stage_reference_component_decisions",
  "stage_table_structure",
  "advance_target_selector_stage",
]);

const SELECTOR_DRAFT_COLLECTIONS = [
  "lots",
  "items",
  "sampling_rules",
  "references",
  "source_dispositions",
  "residual_source_dispositions",
] as const;
type SelectorDraftCollection = typeof SELECTOR_DRAFT_COLLECTIONS[number];

/** Current authored bindings only: no compilation, validation or inferred business receiver. */
function currentReferenceAuthorBindingFacts(selectors: TargetSelectorPlan, registry: SourceSpanRegistry, key: string) {
  const references = selectors.references.filter(reference => reference.key === key);
  if (references.length !== 1) return undefined;
  const reference = references[0]!;
  const spans = new Map(registry.spans.map(span => [span.span_id, span]));
  const selectedEvidenceIds = new Set(reference.target_span_ids.flatMap(id => {
    const span = spans.get(id); return span ? [span.evidence_id] : [];
  }));
  const receiverKeys = unique(reference.destinations.map(destination => destination.item_key));
  const receivers = receiverKeys.flatMap(itemKey => {
    const items = selectors.items.filter(item => item.key === itemKey);
    return items.length === 1 ? items : [];
  });
  const bindings: Array<{ item_key: string; author_binding_path: string; span_id: string; evidence_id: string }> = [];
  const walkSpanIds = (value: unknown, path: string, itemKey: string) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walkSpanIds(child, `${path}/${index}`, itemKey));
      return;
    }
    const span = typeof value === "string" ? spans.get(value) : undefined;
    if (span && selectedEvidenceIds.has(span.evidence_id)) bindings.push({ item_key: itemKey,
      author_binding_path: path, span_id: span.span_id, evidence_id: span.evidence_id });
  };
  const walk = (value: unknown, path: string, itemKey: string) => {
    if (!value || typeof value !== "object") return;
    for (const [field, child] of Object.entries(value)) {
      const childPath = `${path}/${field}`;
      if (Array.isArray(child) && (field === "span_ids" || field.endsWith("_span_ids"))) {
        walkSpanIds(child, childPath, itemKey);
      } else if (Array.isArray(child)) child.forEach((row, index) => walk(row, `${childPath}/${index}`, itemKey));
      else walk(child, childPath, itemKey);
    }
  };
  receivers.forEach(item => walk(item, "", item.key));
  const otherReferenceKeys = unique(selectors.references.filter(other => other.key !== key
    && other.destinations.some(destination => receivers.some(item => item.key === destination.item_key)))
    .map(other => other.key)).filter(otherKey => selectors.references.filter(other => other.key === otherKey).length === 1);
  const listedBindings: typeof bindings = [];
  for (const binding of bindings) {
    if (listedBindings.length === 64 || Buffer.byteLength(JSON.stringify([...listedBindings, binding]), "utf8") > 8192) break;
    listedBindings.push(binding);
  }
  const selectedIds = [...selectedEvidenceIds];
  const unavailableReceiverKeys = receiverKeys.filter(itemKey => !receivers.some(item => item.key === itemKey));
  const samplingRuleKeys = unique(receivers.flatMap(item => item.sampling?.rule_key ? [item.sampling.rule_key] : []))
    .filter(ruleKey => selectors.sampling_rules.filter(rule => rule.key === ruleKey).length === 1);
  return { validation_scope: "current_author_reference_bindings" as const, current_validation_performed: false as const,
    reference_key: key, matching_basis: "same_registered_evidence_as_selected_target",
    import_scope_contract: REFERENCE_IMPORT_SCOPE_REPAIR_GUIDANCE,
    target_span_registration_complete: reference.target_span_ids.every(id => spans.has(id)),
    selected_target_evidence_ids: selectedIds.slice(0, 64), selected_target_evidence_count: selectedIds.length,
    selected_target_evidence_ids_complete: selectedIds.length <= 64,
    author_bindings: listedBindings, total_binding_count: bindings.length, listed_binding_count: listedBindings.length,
    binding_facts_complete: listedBindings.length === bindings.length,
    unavailable_receiver_keys: unavailableReceiverKeys.slice(0, 16), unavailable_receiver_count: unavailableReceiverKeys.length,
    unavailable_receiver_keys_complete: unavailableReceiverKeys.length <= 16,
    record_reads: [...receivers.slice(0, 16).map(item => ({ tool: "read_target_selectors", arguments: { collection: "items", key: item.key } })),
      ...otherReferenceKeys.slice(0, 16).map(otherKey => ({ tool: "read_target_selectors", arguments: { collection: "references", key: otherKey } })),
      ...samplingRuleKeys.slice(0, 16).map(ruleKey => ({ tool: "read_target_selectors", arguments: { collection: "sampling_rules", key: ruleKey } }))],
    total_related_record_count: receivers.length + otherReferenceKeys.length + samplingRuleKeys.length,
    record_reads_complete: receivers.length <= 16 && otherReferenceKeys.length <= 16 && samplingRuleKeys.length <= 16,
    instruction: "这些是当前已写入草稿的来源绑定事实，按当前 reference 选中目标所属 evidence 匹配；同一 evidence 中不同 span 也会列出，不能当成原文区间相同。author_binding_path 相对于该 item，按 item_key 读取完整记录。它不是 imported_fields、错误清单或严格通过结论，未编译也未完整校验。共享 sampling 规则中的绑定须另按实际 rule_key 读取。其他读取地址只指向作者已经填写的同接收项引用，不证明重复或语义正确。按原文核对字段、sampling、typed table 和引用目标，及时保存真实修复；不替作者选择目标子集或接收项。截断标记不表示未列出的绑定不存在。",
  };
}

function targetSelectorCounts(selectors: TargetSelectorPlan): TargetSelectorCounts {
  return {
    lots: selectors.lots.length,
    items: selectors.items.length,
    sampling_rules: selectors.sampling_rules.length,
    references: selectors.references.length,
    source_dispositions: selectors.source_dispositions.length,
  };
}

function hasNonEmptySpanIds(value: unknown): boolean {
  return Array.isArray(value) && value.some((id) => typeof id === "string" && id.length > 0);
}

function fieldHasSpans(fields: unknown, name: string): boolean {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const slot = (fields as Record<string, unknown>)[name];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
  return hasNonEmptySpanIds((slot as Record<string, unknown>).span_ids);
}

// An unkeyed persisted disposition is addressed by its exact current content.
// This read/delete address never becomes part of the authored selector schema.
function selectorRecordReadKey(collection: string, row: unknown): string {
  if (collection === "source_dispositions") return `disposition:${sha256Json(row)}`;
  return row && typeof row === "object" && typeof (row as { key?: unknown }).key === "string"
    ? (row as { key: string }).key : "";
}

/**
 * Stage 成功回条附带本次真正落盘的完整记录，让模型能在回条上继续修正，
 * 不必为拿到落盘后状态而逐 key 重读（上一版实测 read_target_selectors 占 target 会话
 * 工具调用的大头，且 46/47 次都发生在成功结果之后，是设计性读放大而非修错）。
 * 超过字节预算时退回只回传读取键目录。
 */
function savedTouchedSelectorRecords(
  allCollections: readonly SelectorDraftCollection[],
  operation: "upsert" | "replace_collection",
  current: TargetSelectorPlan,
  draft: TargetSelectorDraft | undefined,
  removeKeys: readonly string[] | undefined,
  recordKeyOf: (record: unknown) => string,
): { records: Record<string, Array<Record<string, unknown>>>; keys: Record<string, string[]> } {
  const records: Record<string, Array<Record<string, unknown>>> = {};
  const keys: Record<string, string[]> = {};
  for (const collection of allCollections) {
    const staged = current[collection] as unknown[];
    const keep = new Set((draft?.[collection] ?? []).map(recordKeyOf));
    const selected = operation === "replace_collection"
      ? [...staged]
      : staged.filter(row => keep.has(recordKeyOf(row)));
    keys[collection] = selected.map(row => selectorRecordReadKey(collection, row)).filter(Boolean);
    records[collection] = selected.map(row => {
      const record = (row && typeof row === "object" && !Array.isArray(row)
        ? { ...(row as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      const readKey = selectorRecordReadKey(collection, row);
      if (readKey && record.key !== readKey) record.read_key = readKey;
      return record;
    });
  }
  return { records, keys };
}

const SAVED_RECORDS_MAX_BYTES = 96 * 1024;

function selectorRecordIndexRow(row: unknown, readKey: string): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const record = row as Record<string, unknown>;
  const index: Record<string, unknown> = { key: readKey };
  if (typeof record.name === "string") index.name = record.name;
  if (typeof record.lot_key === "string") index.lot_key = record.lot_key;
  if (typeof record.category === "string") index.category = record.category;
  const filled: Record<string, boolean> = {};
  if (record.fields && typeof record.fields === "object") {
    filled.name = fieldHasSpans(record.fields, "name");
    filled.requirement = fieldHasSpans(record.fields, "requirement");
    filled.method = fieldHasSpans(record.fields, "method");
    filled.quantity = fieldHasSpans(record.fields, "quantity");
    filled.note = fieldHasSpans(record.fields, "note");
  }
  if ("criterion_span_ids" in record) filled.criterion = hasNonEmptySpanIds(record.criterion_span_ids);
  if ("scope_span_ids" in record) filled.scope = hasNonEmptySpanIds(record.scope_span_ids);
  if (record.sampling && typeof record.sampling === "object" && !Array.isArray(record.sampling)) {
    const sampling = record.sampling as Record<string, unknown>;
    if (typeof sampling.status === "string") index.sampling_status = sampling.status;
    filled.sampling = hasNonEmptySpanIds(sampling.quantity_span_ids)
      || (typeof sampling.rule_key === "string" && sampling.rule_key.length > 0);
  }
  if ("table" in record) filled.table = record.table !== null && record.table !== undefined;
  if (Array.isArray(record.destinations)) filled.destinations = record.destinations.length > 0;
  if ("occurrence_id" in record) {
    filled.occurrence_id = typeof record.occurrence_id === "string" && record.occurrence_id.length > 0;
  }
  if (Array.isArray(record.branches)) filled.branches = record.branches.length > 0;
  if (typeof record.disposition === "string") filled.disposition = record.disposition.length > 0;
  index.filled = filled;
  return index;
}

function compactSelectorIssueDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSelectorIssueDetail);
  if (!value || typeof value !== "object") return value;
  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SELECTOR_TOOL_OMITTED_DETAIL_ARRAYS.has(key) && Array.isArray(child)) {
      compact[`${key}_count`] = child.length;
      continue;
    }
    compact[key] = compactSelectorIssueDetail(child);
  }
  return compact;
}

export function selectorIssueToolDiagnostics(issues: readonly unknown[]): unknown[] {
  return coalesceUnhandledEvidenceDiagnostics(coalesceReferenceToolDiagnostics(
    coalesceReferencePlaceholderResolutionDiagnostics(
      coalesceFieldBindingDiagnostics(coalesceSelectorIssueDiagnostics(issues)),
    ),
  ));
}

export function selectorIssueToolPage(issues: readonly unknown[], maxIssueCount = SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, cursor?: number,
  navigation?: { tool: string; arguments: Record<string, unknown>; cursor_field: string }): {
  issues: unknown[];
  summaries: unknown[];
  page: {
    raw_issue_count: number;
    diagnostic_group_count: number;
    count_unit: string;
    count_note: string;
    reported_issue_count: number;
    total_issue_count: number;
    remaining_issue_count: number;
    reported_issue_utf8_bytes: number;
    max_issue_utf8_bytes: number;
    max_issue_count: number;
    issue_index: unknown[];
    indexed_issue_count: number;
    index_complete: boolean;
    index_instruction: string;
    required_action: string;
    cursor: number;
    next_cursor: number | null;
  };
} {
  const pageMaxCount = Math.min(SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, Math.max(1, maxIssueCount));
  const pageCursor = Math.max(0, Math.floor(cursor ?? 0));
  const diagnostics = selectorIssueToolDiagnostics(issues);
  const compacted = diagnostics.map((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
    const record = issue as Record<string, unknown>;
    return selectorRepairIssueWithoutRepeatedDetails({
      ...record,
      ...(record.details === undefined ? {} : { details: compactSelectorIssueDetail(record.details) }),
    });
  });
  const visible: unknown[] = [];
  let visibleBytes = 0;
  const start = Math.max(0, Math.min(compacted.length, pageCursor));
  for (const issue of compacted.slice(start)) {
    const issueBytes = Buffer.byteLength(JSON.stringify(issue ?? null), "utf8");
    if (
      visible.length > 0
      && (
        visible.length >= pageMaxCount
        || visibleBytes + issueBytes > SELECTOR_TOOL_ISSUE_PAGE_MAX_BYTES
      )
    ) break;
    visible.push(issue);
    visibleBytes += issueBytes;
  }
  const summaries = visible.map((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
    const record = issue as Record<string, unknown>;
    return {
      code: record.code ?? "",
      path: record.path ?? "",
      message: record.message ?? "",
      ...(record.owner === undefined ? {} : { owner: record.owner }),
    };
  });
  // A bounded index includes issues beyond the verbose page. It is navigation,
  // not approval: keep raw validation counts and blocking behavior unchanged.
  const issueIndex: unknown[] = [];
  let indexBytes = 0;
  for (const [index, issue] of compacted.entries()) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
    const record = issue as Record<string, unknown>;
    const details = record.details as Record<string, unknown> | undefined;
    const sourceEvidenceIds = typeof record.code === "string" && isSourceDispositionRepairIssueCode(record.code)
      ? details?.required_affected_evidence_ids ?? details?.evidence_ids ?? record.evidence_ids : undefined;
    const hasSourceIdentity = Array.isArray(sourceEvidenceIds) && sourceEvidenceIds.length > 0
      && sourceEvidenceIds.every(id => typeof id === "string");
    const entry = { index, code: record.code, path: record.path,
      ...(hasSourceIdentity ? { evidence_ids: sourceEvidenceIds }
        : { message: typeof record.message === "string" ? record.message.slice(0, 180) : "" }),
      ...(details?.affected_item_keys ? { affected_item_keys: details.affected_item_keys } : {}),
      ...(details?.affected_paths ? { affected_paths: details.affected_paths } : {}),
      ...(navigation ? { detail_read: { tool: navigation.tool,
        arguments: { ...navigation.arguments, [navigation.cursor_field]: index } } }
        : { issue_key: `issue:${sha256Json({ code: record.code, path: record.path,
          identity: record.record_identity, details: record.details }).slice(0, 24)}` }),
      detail_in_page: index >= start && index < start + visible.length };
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (issueIndex.length >= 256 || indexBytes + bytes > 16 * 1024) break;
    issueIndex.push(entry);
    indexBytes += bytes;
  }
  return {
    issues: visible,
    summaries,
    page: {
      raw_issue_count: issues.reduce<number>((sum, issue) => {
        const count = (issue as { details?: { original_issue_count?: number } } | null)?.details?.original_issue_count;
        return sum + (Number.isInteger(count) && count! > 0 ? count! : 1);
      }, 0),
      diagnostic_group_count: diagnostics.length,
      count_unit: "diagnostic_group",
      count_note: "raw_issue_count 是归并前检查结果数；diagnostic_group_count 及本页 reported/total/remaining_issue_count 均按反馈组计数，不是独立业务错误数。actual.issue_count 保留所在检查阶段的原计数；不应用展示组数判断修复进展或预算。",
      reported_issue_count: visible.length,
      total_issue_count: diagnostics.length,
      remaining_issue_count: Math.max(0, diagnostics.length - start - visible.length),
      reported_issue_utf8_bytes: visibleBytes,
      max_issue_utf8_bytes: SELECTOR_TOOL_ISSUE_PAGE_MAX_BYTES,
      max_issue_count: pageMaxCount,
      issue_index: issueIndex,
      indexed_issue_count: issueIndex.length,
      index_complete: issueIndex.length === compacted.length,
      index_instruction: navigation
        ? `只按 issue_index.detail_read 或 next_diagnostic_page 读取本通道诊断，工具为 ${navigation.tool}，游标字段为 ${navigation.cursor_field}。不要把诊断指纹当作草稿指纹，不调用其他诊断通道。草稿或来源改变后从本通道游标 0 只读刷新，不为翻页重新校验。已读且判断明确的独立问题可先保存，不必读完后页；索引不证明业务正确或阶段通过。`
        : "对本页已读且判断明确的独立问题，可在字节预算内先保存完整记录，不必先读完全部后页。需更多详情时，查看 issue_index，用当前预检指纹调用 read_target_selector_issues 按 cursor 或 issue_key 读取，不为翻页重复预检。保存改变草稿或来源后，先取得新完整预检快照，再读取剩余问题。索引不代替原文或详细修复依据；index_complete=false 表示索引尚未完整展示。",
      cursor: start,
      next_cursor: start + visible.length < compacted.length ? start + visible.length : null,
      required_action: start + visible.length < diagnostics.length
        ? "repair_source_grounded_displayed_issues_or_read_needed_current_details"
        : navigation ? "save_source_grounded_author_decisions_then_refresh_this_channel" : "repair_reported_issues_then_rerun_preflight",
    },
  };
}

function evidenceLocatorLine(locator: string): number | undefined {
  const match = /^line:(\d+)(?:\/|$)/u.exec(locator);
  return match ? Number(match[1]) : undefined;
}

function selectorIssuePath(issue: unknown): string {
  return issue && typeof issue === "object" && !Array.isArray(issue)
    && typeof (issue as { path?: unknown }).path === "string"
    ? (issue as { path: string }).path
    : "/";
}

function selectorIssueCode(issue: unknown): string {
  return issue && typeof issue === "object" && !Array.isArray(issue)
    && typeof (issue as { code?: unknown }).code === "string"
    ? (issue as { code: string }).code
    : "selector_issue";
}

export function actionableSelectorIssue(issue: unknown, selectors?: TargetSelectorPlan): unknown {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
  const record = issue as Record<string, unknown>;
  if (record.owner === "compiler_invariant_violation") return issue;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const path = selectorIssuePath(issue);
  // Resolve authoring records against the exact draft that was checked. A stable
  // key wins over a stale array index; compiled output paths are never editable.
  const authoredPath = String(record.writable_path ?? details.writable_path ?? path);
  const match = /^\/(lots|items|sampling_rules|references|source_dispositions)(?:\/(\d+)(\/.*)?)?$/u.exec(authoredPath);
  const collection = match?.[1] as "lots" | "items" | "sampling_rules" | "references" | "source_dispositions" | undefined;
  const rows = collection && selectors ? selectors[collection] as unknown[] : undefined;
  const identityField = collection === "items" ? "item_key" : collection === "lots" ? "lot_key"
    : collection === "sampling_rules" ? "rule_key" : collection === "references" ? "reference_key" : "record_key";
  const suppliedKey = collection === "sampling_rules"
    ? record.sampling_rule_key ?? details.sampling_rule_key ?? record.rule_key ?? details.rule_key
    : record[identityField] ?? details[identityField];
  const keyedIndexes = rows && typeof suppliedKey === "string"
    ? rows.flatMap((row, index) => selectorRecordReadKey(collection!, row) === suppliedKey ? [index] : []) : [];
  const index = rows && typeof suppliedKey === "string"
    ? keyedIndexes.length === 1 ? keyedIndexes[0]! : -1
    : match?.[2] === undefined ? -1 : Number(match[2]);
  const row = rows?.[index];
  const readKey = row === undefined ? undefined : selectorRecordReadKey(collection!, row);
  const identity = readKey && rows?.filter(row => selectorRecordReadKey(collection!, row) === readKey).length === 1
    ? { collection, key: readKey } : undefined;
  const resolvedPath = collection && match && (match[2] === undefined || row !== undefined)
    ? match[2] === undefined ? `/${collection}` : `/${collection}/${index}${match[3] ?? ""}`
    : undefined;
  const actualAtPath = resolvedPath && selectors ? resolvedPath.split("/").slice(1)
    .reduce<unknown>((value, key) => value && typeof value === "object"
      ? (value as Record<string, unknown>)[key.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined, selectors) : undefined;
  // A collection diagnostic needs its actual size, not every saved business
  // record. Full records remain available through the existing read tool.
  const fallbackActual = collection && resolvedPath === `/${collection}` && Array.isArray(actualAtPath)
    ? { collection, record_count: actualAtPath.length, records_read_tool: "read_target_selectors" }
    : actualAtPath;
  const actual = Object.hasOwn(record, "actual") ? record.actual
    : Object.hasOwn(details, "actual") ? details.actual : fallbackActual;
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const repairOptions = Array.isArray(details.repair_options) ? details.repair_options : [];
  const repairOptionText = repairOptions.filter((entry): entry is string => typeof entry === "string");
  const repairOptionRecords = repairOptions.filter((entry): entry is Record<string, unknown> => (
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  ));
  const optionWritablePaths = unique(repairOptionRecords.flatMap(option => [
    ...(typeof option.writable_path === "string" ? [option.writable_path] : []),
    ...stringList(option.writable_paths),
  ]));
  const authoredCollectionNames = new Set(["lots", "items", "sampling_rules", "references", "source_dispositions"]);
  const optionWritableCollections = unique(repairOptionRecords.flatMap(option => [
    ...(typeof option.writable_collection === "string" ? [option.writable_collection] : []),
    ...stringList(option.writable_collections),
  ]));
  const pathCollections = optionWritablePaths.flatMap(optionPath => {
    const root = /^\/([^/]+)/u.exec(optionPath)?.[1];
    return root && authoredCollectionNames.has(root) ? [root] : [];
  });
  const writableCollections = unique([
    ...stringList(record.writable_collections),
    ...stringList(details.writable_collections),
    ...optionWritableCollections,
    ...pathCollections,
    ...(typeof record.writable_collection === "string" ? [record.writable_collection] : []),
    ...(typeof details.writable_collection === "string" ? [details.writable_collection] : []),
  ]);
  const templatedWritableRoots = unique(optionWritablePaths.flatMap(optionPath => {
    if (!optionPath.includes("<")) return [];
    const root = /^\/([^/]+)/u.exec(optionPath)?.[1];
    return root && authoredCollectionNames.has(root) ? [`/${root}`] : [];
  }));
  const writablePaths = unique([
    ...stringList(record.writable_paths),
    ...stringList(details.writable_paths),
    ...templatedWritableRoots,
    ...optionWritablePaths,
  ]);
  const allowedActions = unique([
    ...stringList(record.allowed_actions),
    ...stringList(details.allowed_actions),
    ...repairOptionRecords.flatMap(option => typeof option.kind === "string"
      ? [option.kind]
      : typeof option.action === "string" ? [option.action] : []),
  ]);
  const hasEmptyOriginCandidates = Array.isArray(details.candidate_origin_bindings)
    && details.candidate_origin_bindings.length === 0
    && allowedActions.includes("bind_local_field_spans");
  const offersImmutableOccurrenceRepair = repairOptionRecords.some(option => (
    option.kind === "fix_immutable_occurrence"
  ));
  const candidateReadTools = unique([
    ...stringList(record.candidate_read_tools),
    ...stringList(details.candidate_read_tools),
    ...(typeof record.candidate_read_tool === "string" ? [record.candidate_read_tool] : []),
    ...(typeof details.candidate_read_tool === "string" ? [details.candidate_read_tool] : []),
    ...(writableCollections.some(collection => authoredCollectionNames.has(collection)) ? ["read_target_selectors"] : []),
    ...(hasEmptyOriginCandidates && offersImmutableOccurrenceRepair
      ? ["list_reference_occurrences", "open_evidence", "locate_evidence_span"]
      : []),
  ]);
  const saveTool = typeof record.save_tool === "string"
    ? record.save_tool
    : typeof details.save_tool === "string"
      ? details.save_tool
      : writableCollections.some(collection => authoredCollectionNames.has(collection))
        ? "stage_target_selector_draft"
        : undefined;
  const explicitNextTool = typeof record.next_tool === "string"
    ? record.next_tool
    : typeof details.next_tool === "string" ? details.next_tool : undefined;
  const providedToolArguments = record.next_tool_arguments !== undefined
    ? record.next_tool_arguments
    : details.next_tool_arguments;
  const toolArgumentHints = record.tool_argument_hints !== undefined
    ? record.tool_argument_hints
    : details.tool_argument_hints;
  const optionNextTools = unique(repairOptionRecords.flatMap(option => [
    ...(typeof option.next_tool === "string" ? [option.next_tool] : []),
    ...stringList(option.next_tools),
  ]));
  const nextTool = explicitNextTool ?? candidateReadTools[0] ?? saveTool
    ?? (resolvedPath ? "stage_target_selector_draft" : "get_target_selector_contract");
  const nextToolArguments = providedToolArguments ?? (nextTool === "read_target_selectors" && collection
    ? identity ?? { collection }
    : nextTool === "get_target_selector_contract" ? {} : undefined);
  const nextTools = unique([
    ...stringList(record.next_tools),
    ...stringList(details.next_tools),
    ...candidateReadTools,
    ...optionNextTools,
    ...(saveTool ? [saveTool] : []),
    nextTool,
  ]);
  const fallbackHowToPass = "具体拒绝条件见 message 和 details；当前诊断没有额外的自动修正结论，不要猜测业务答案。只修改已确认的作者端字段；" + (saveTool
    ? nextTool === saveTool
      ? `next_tool 与 save_tool 均为 ${nextTool}；只调用该工具完成修改和保存，然后重新执行原验证。`
      : `先调用 next_tool（${nextTool}）读取或执行所需依据，再用 save_tool（${saveTool}）保存修改，然后重新执行原验证。`
    : `当前回条没有 save_tool；按 next_tool（${nextTool}）完成当前修复或读取步骤，然后重新执行原验证。`);
  const structuredRepairHowToPass = hasEmptyOriginCandidates
    ? "candidate_origin_bindings 为空时，仅修改 origin_binding 或 reason 不会产生可选来源，无法通过。先用 candidate_read_tools 核对当前 items、reference occurrence、引用 literal 与相邻原文，再由模型依据原文从 allowed_actions 中选择：为语义适合的真实 item 字段绑定完整引用文字来源，或在 occurrence、destinations、component_dispositions、import_scope 确实错误时走对应修复路线；不得由 harness 指定接收 item 或字段。最后用 save_tool 保存；只有不可变 occurrence 确实解析错误时才使用 resolve_document_reference。"
    : undefined;
  return {
    ...record,
    ...(actual === undefined ? { actual_unavailable: true } : { actual }),
    ...(identity ? { record_identity: identity } : {}),
    ...(identity ? { record_read: { tool: "read_target_selectors", arguments: identity } } : {}),
    how_to_pass: record.how_to_pass ?? details.how_to_pass ?? structuredRepairHowToPass
      ?? (repairOptionText.length ? repairOptionText.join("\n") : undefined) ?? fallbackHowToPass,
    ...(resolvedPath || record.writable_path || details.writable_path || writablePaths[0]
      ? { writable_path: record.writable_path || details.writable_path
        ? resolvedPath ?? record.writable_path ?? details.writable_path
        : writablePaths[0] ?? resolvedPath } : {}),
    ...(writablePaths.length ? { writable_paths: writablePaths } : {}),
    ...(writableCollections.length ? { writable_collections: writableCollections } : {}),
    ...(allowedActions.length ? { allowed_actions: allowedActions } : {}),
    ...(candidateReadTools.length ? { candidate_read_tools: candidateReadTools } : {}),
    ...(saveTool ? { save_tool: saveTool } : {}),
    do_not_edit: record.do_not_edit ?? details.do_not_edit ?? "编译生成的语义计划或不可变原文",
    next_tool: nextTool,
    ...(nextToolArguments === undefined ? {} : { next_tool_arguments: nextToolArguments }),
    ...(toolArgumentHints === undefined ? {} : { tool_argument_hints: toolArgumentHints }),
    next_tools: nextTools,
  };
}

function selectorRepairRoute(issues: readonly unknown[]): {
  writable_paths: string[]; next_tool: string | null; next_tools: string[];
  next_tool_arguments?: Record<string, unknown>;
} {
  const records = issues.filter((issue): issue is Record<string, unknown> => (
    Boolean(issue) && typeof issue === "object" && !Array.isArray(issue)
  ));
  const nextTools = unique(records.flatMap(record => [
    ...(typeof record.next_tool === "string" ? [record.next_tool] : []),
    ...(Array.isArray(record.next_tools)
      ? record.next_tools.filter((value): value is string => typeof value === "string")
      : []),
  ]));
  const nextTool = nextTools[0] ?? null;
  const selectedIssue = records.find(record => record.next_tool === nextTool);
  const nextToolArguments = selectedIssue?.next_tool_arguments;
  return {
    writable_paths: unique(records.flatMap(record => [
      ...(typeof record.writable_path === "string" ? [record.writable_path] : []),
      ...(Array.isArray(record.writable_paths) ? record.writable_paths.filter((value): value is string => typeof value === "string") : []),
    ])),
    next_tool: nextTool,
    ...(nextToolArguments && typeof nextToolArguments === "object" && !Array.isArray(nextToolArguments)
      ? { next_tool_arguments: nextToolArguments as Record<string, unknown> } : {}),
    next_tools: nextTools,
  };
}

function terminalSelectorPreflightResponse(preflight: TargetSelectorPreflight | undefined): ToolResponse | undefined {
  if (!preflight || preflight.ok
    || (preflight.response.terminal !== true && preflight.issue_owner !== "compiler_invariant_violation"
      && preflight.issue_owner !== "final_contract_violation")) return undefined;
  // Keep the actual terminal cause visible even when accompanied by many repairable issues.
  const terminalFirst = [...preflight.issues].sort((left, right) => {
    const isTerminalOwner = (issue: unknown): boolean => Boolean(issue && typeof issue === "object"
      && ["compiler_invariant_violation", "final_contract_violation"].includes(String((issue as { owner?: unknown }).owner)));
    return Number(isTerminalOwner(right)) - Number(isTerminalOwner(left));
  });
  const page = selectorIssueToolPage(terminalFirst);
  const response = { ...preflight.response };
  if (Array.isArray(response.issues)) response.issues = page.issues;
  if (Array.isArray(response.selector_issues)) response.selector_issues = page.issues;
  return {
    ...response,
    selector_issue_page: {
      ...page.page,
      required_action: "停止当前目标，保留可信检查点与公开回条供维护者排查；剩余诊断数量不表示应继续修改草稿或重试。",
    },
    ok: false,
    terminal: true,
    issue_owner: preflight.issue_owner,
    budget_consumed: false,
    next_tool: null,
    next_tools: [],
    writable_paths: [],
    instruction: typeof preflight.response.instruction === "string"
      ? preflight.response.instruction
      : "停止当前目标，保留检查点与错误回条。此程序故障不能通过模型修改草稿解决。",
  };
}

function issueTouchesSelectorRoots(issue: unknown, roots: readonly string[]): boolean {
  const path = selectorIssuePath(issue);
  const aliases = path === "/lot" ? ["/lots"]
    : path === "/item" ? ["/items"]
    : path === "/sampling_rule" ? ["/sampling_rules"]
    : path === "/reference" ? ["/references"]
    : [path];
  const issuePaths = [...aliases];
  if (issue && typeof issue === "object" && !Array.isArray(issue)) {
    const details = (issue as { details?: unknown }).details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const affected = (details as { affected_paths?: unknown }).affected_paths;
      if (Array.isArray(affected)) {
        for (const value of affected) if (typeof value === "string") issuePaths.push(value);
      }
    }
  }
  return issuePaths.some((issuePath) => roots.some((root) => (
    issuePath === root
    || issuePath.startsWith(`${root}/`)
    || root.startsWith(`${issuePath}/`)
  )));
}

function issueBelongsToSelectorStage(issue: unknown, stage: TargetSelectorStage): boolean {
  if (stage === "table" || stage === "commit" || stage === "coverage_repair") return true;
  const path = selectorIssuePath(issue);
  const code = selectorIssueCode(issue);
  const samplingIssue = path.startsWith("/sampling_rules")
    || /^\/items\/\d+\/sampling(?:\/|$)/u.test(path)
    || code.startsWith("selector_sampling_")
    || code.startsWith("selector_explicit_sampling_")
    || code.startsWith("selector_nonexplicit_sampling_");
  const tableIssue = /^\/items\/\d+\/table(?:\/|$)/u.test(path)
    || path.startsWith("/table_structure")
    || code.startsWith("table_structure_")
    || code.startsWith("selector_table_")
    || code.startsWith("selector_reference_table_");
  const referenceIssue = path.startsWith("/references") || code.startsWith("selector_reference_");
  if (stage === "primary") return !samplingIssue && !tableIssue && !referenceIssue;
  return !tableIssue && !referenceIssue;
}

function targetSelectorCurrentState(
  selectors: TargetSelectorPlan,
  state: RevisionState,
): TargetSelectorCurrentState {
  const counts = targetSelectorCounts(selectors);
  const hasRecords = Object.values(counts).some((count) => count > 0);
  if (!hasRecords) return "blank";
  return state.lineage ? "inherited_existing" : "current_existing";
}

function currentReferenceOriginScopeIssue<T>(issue: T): T {
  const record = issue as { code?: string; how_to_pass?: string; details?: { how_to_pass?: string } };
  if (record?.code !== "reference_origin_relation") return issue;
  const how = record.how_to_pass ?? record.details?.how_to_pass ?? "";
  return { ...issue, how_to_pass: how.includes(REFERENCE_ORIGIN_CONTEXT_SCOPE_GUIDANCE)
    ? how : `${how} ${REFERENCE_ORIGIN_CONTEXT_SCOPE_GUIDANCE}`.trim() };
}

const SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION = "selector-stage-diagnostics/v27";

function canRegisterReferenceLiteral(state: RevisionState): boolean {
  return state.status === "working" && state.validation_attempts === 0
    && !state.last_valid_fingerprint && !state.last_valid_plan_sha256
    && !state.repair?.coverage_review_fingerprint;
}

function stageFocusUsesCurrentContract(state: RevisionState): boolean {
  const checkpoint = state.selector_protocol?.last_stage_diagnostics;
  return !checkpoint || checkpoint.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION;
}

function stageFocusUsesCurrentInputs(state: RevisionState, inputsFingerprint: string | undefined): boolean {
  const checkpoint = state.selector_protocol?.last_stage_diagnostics;
  return stageFocusUsesCurrentContract(state) && (!checkpoint || checkpoint.inputs_fingerprint === inputsFingerprint);
}

async function selectorStageDiagnosticInputsFingerprint(workspace: RevisionWorkspace): Promise<string> {
  const tablePath = join(workspace.root, "table-structure.json");
  const [selectorText, registry, state, tableText, manifest, ledger] = await Promise.all([
    readFile(workspace.workingSelectorPath, "utf8"), workspace.readSourceSpanRegistry(), workspace.readState(),
    pathExists(tablePath).then(exists => exists ? readFile(tablePath, "utf8") : undefined),
    workspace.readEvidenceManifest(), workspace.readDocumentLedger(),
  ]);
  return sha256Json({ diagnostic_contract: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION,
    selector_sha256: sha256Text(selectorText), registry: sourceSpanRegistryFingerprint(registry),
    evidence: sha256Json(manifest), ledger: ledger === undefined ? null : sha256Json(ledger), stage: state.selector_stage,
    reference_literal_registration_allowed: canRegisterReferenceLiteral(state),
    table_sha256: tableText === undefined ? null : sha256Text(tableText), reference_analysis_modes: state.reference_analysis_modes ?? {} });
}

/** Old checks may locate still-existing author keys; they cannot supply current facts or paths. */
function historicalSelectorRepairNavigation(selectors: TargetSelectorPlan, state: RevisionState) {
  const records = new Map<string, { tool: "read_target_selectors";
    arguments: { collection: SelectorDraftCollection; key: string }; historical_issue_codes: string[] }>();
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  let inspectionClassificationContractRelevant = false;
  for (const value of state.selector_protocol?.last_stage_diagnostics?.issues ?? state.selector_protocol?.last_stage_issues ?? []) {
    const issue = object(value); if (!issue) continue;
    const details = object(issue.details);
    const code = typeof issue.code === "string" && issue.code.length <= 128 ? issue.code : "unknown";
    let currentAuthorRecordFound = false;
    const add = (collection: unknown, key: unknown) => {
      if (!SELECTOR_DRAFT_COLLECTIONS.includes(collection as SelectorDraftCollection) || typeof key !== "string") return;
      const rows = selectors[collection as SelectorDraftCollection];
      if (!Array.isArray(rows) || rows.filter(row => selectorRecordReadKey(String(collection), row) === key).length !== 1) return;
      currentAuthorRecordFound = true;
      const id = JSON.stringify([collection, key]);
      const existing = records.get(id);
      if (existing) { if (!existing.historical_issue_codes.includes(code)) existing.historical_issue_codes.push(code); return; }
      records.set(id, { tool: "read_target_selectors", arguments: { collection: collection as SelectorDraftCollection, key },
        historical_issue_codes: [code] });
    };
    const addRead = (value: unknown) => { const args = object(value); if (args) add(args.collection, args.key); };
    for (const record of [issue, details]) {
      if (!record) continue;
      if (record.next_tool === "read_target_selectors") addRead(record.next_tool_arguments);
      const read = object(record.record_read);
      if (read?.tool === "read_target_selectors") addRead(read.arguments);
      add("items", record.affected_item_key);
      add("items", record.item_key);
      add("references", record.reference_key);
      const actual = object(record.actual);
      add("items", actual?.item_key);
      add("references", actual?.reference_key);
      for (const key of Array.isArray(record.matching_reference_keys) ? record.matching_reference_keys : []) add("references", key);
      for (const route of Array.isArray(record.conflicting_reference_routes) ? record.conflicting_reference_routes : []) {
        add("references", object(route)?.reference_key);
      }
      const hints = object(record.tool_argument_hints)?.read_target_selectors;
      for (const read of Array.isArray(hints) ? hints : []) addRead(read);
      for (const read of Array.isArray(record.affected_item_reads) ? record.affected_item_reads : []) {
        const route = object(read); if (route?.tool === "read_target_selectors") addRead(route.arguments);
      }
    }
    if (currentAuthorRecordFound && code === "schema" && issue.owner !== "compiler_invariant_violation"
      && [issue.path, details?.compiled_path].some(path => typeof path === "string"
        && /^\/(?:acceptance_items|items)\/\d+\/inspection_data_type_(?:evidence|span)_ids$/u.test(path))) {
      inspectionClassificationContractRelevant = true;
    }
  }
  if (!records.size) return undefined;
  const recordReads: Array<(typeof records extends Map<string, infer T> ? T : never)> = [];
  for (const row of records.values()) {
    if (recordReads.length === 32 || Buffer.byteLength(JSON.stringify([...recordReads, row]), "utf8") > 8192) break;
    recordReads.push(row);
  }
  return { validation_scope: "historical_author_record_navigation" as const, current_validation_performed: false as const,
    record_reads: recordReads, total_records: records.size, listed_records: recordReads.length,
    ...([...records.values()].some(row => row.historical_issue_codes.some(code => ["reference_import_scope_exceeded", "selector_sampling_unspecified_quantity_is_full_inspection", "selector_sampling_decision_pending"].includes(code))) || inspectionClassificationContractRelevant ? {
      current_repair_contracts: [
        ...([...records.values()].some(row => row.historical_issue_codes.includes("selector_sampling_decision_pending"))
          ? [{ issue_code: "selector_sampling_decision_pending", instruction: "历史问题代码不证明当前记录仍待定，不提供旧实际值或数字路径。按当前唯一作者 key 读取记录，只有当前仍待定且原文支持时才修订；保留原检查计数，不为刷新旧回条重检未修改草稿。" + SELECTOR_PENDING_SAMPLING_REPAIR_GUIDANCE }] : []),
        ...([...records.values()].some(row => row.historical_issue_codes.includes("reference_import_scope_exceeded"))
          ? [{ issue_code: "reference_import_scope_exceeded", instruction: REFERENCE_IMPORT_SCOPE_REPAIR_GUIDANCE }] : []),
        ...(inspectionClassificationContractRelevant
          ? [{ issue_code: "schema", author_field: "inspection_data_type_span_ids", instruction: INSPECTION_DATA_TYPE_SOURCE_REPAIR_GUIDANCE }] : []),
        ...([...records.values()].some(row => row.historical_issue_codes.includes("selector_sampling_unspecified_quantity_is_full_inspection"))
          ? [{ issue_code: "selector_sampling_unspecified_quantity_is_full_inspection", instruction: "历史代码只导航。读取当前共享规则及所选branch/item，用原文判断present quantity是否真实全验或误含相邻条件。仅修实际过宽绑定，保留正确数量未规定状态、absent quantity及相邻分支；不重存同状态/reason消错，不改原计数。" }] : []),
      ],
    } : {}),
    directory_reads: [...new Set([...records.values()].map(row => row.arguments.collection))].map(collection => ({
      tool: "read_target_selectors" as const, arguments: { collection, cursor: 0 },
    })),
    instruction: renderFeedback({ kind: "historical_navigation", constraint: "record_reads只列仍唯一存在的稳定key；current_repair_contracts说明当前合法表达，不证明这些key仍违反。只读当前记录，先保存有据实质修复；有限诊断空不授予完整通过。" }),
  };
}

function targetSelectorStartupSnapshot(
  selectors: TargetSelectorPlan,
  state: RevisionState,
  readTargetSelectorsRequired: boolean,
  diagnosticInputsFingerprint: string | undefined,
): TargetSelectorStartupContext {
  const currentState = targetSelectorCurrentState(selectors, state);
  const fingerprint = targetSelectorFingerprint(selectors);
  const stageRetries = state.selector_protocol?.stage_retries;
  return {
    current_selector_state: currentState,
    current_selector_checkpoint: currentState === "blank" ? "blank"
      : state.last_valid_fingerprint && state.last_valid_plan_sha256 ? "validated_candidate"
      : state.selector_prefill_fingerprint === fingerprint ? "program_prefill" : "unvalidated_draft",
    read_target_selectors_required: readTargetSelectorsRequired,
    current_selector_summary: {
      draft_fingerprint: fingerprint,
      counts: targetSelectorCounts(selectors),
      ...(state.lineage ? { lineage: structuredClone(state.lineage) } : {}),
    },
    ...(stageRetries ? {
      inherited_stage_retry: {
        stage: stageRetries.stage,
        best_stage_rank: stageRetries.best_stage_rank,
        best_issue_count: stageRetries.best_issue_count,
        consecutive_non_improvements: stageRetries.consecutive_non_improvements,
      },
    } : {}),
    historical_repair_navigation: historicalSelectorRepairNavigation(selectors, state),
    ...(state.selector_protocol?.last_stage_issues?.length && stageFocusUsesCurrentInputs(state, diagnosticInputsFingerprint) ? {
      resume_focus: state.selector_protocol.last_stage_issues.map(currentReferenceOriginScopeIssue).map(issue => {
        if (issue.record_read || issue.code !== "reference_origin_relation") return issue;
        // Legacy focus retained a destination path but dropped its receiver key.
        // Recover only the exact current address, never infer a semantic receiver.
        const match = /^\/references\/(\d+)\/destinations\/(\d+)\/item_key$/u.exec(issue.path);
        const key = match ? selectors.references[Number(match[1])]?.destinations[Number(match[2])]?.item_key : undefined;
        return key && selectors.items.filter(item => item.key === key).length === 1
          ? { ...issue, record_read: { tool: "read_target_selectors" as const, arguments: { collection: "items", key } } }
          : issue;
      }),
    } : {}),
  };
}

function decisionPathForCompiledPath(path: string): string {
  return path
    .replace(/^\/inspection_lots\/(\d+)/, "/lots/$1")
    .replace(/^\/acceptance_items\/(\d+)/, "/items/$1")
    .replace(/^\/semantic_evidence\/(\d+)/, "/semantic_nodes/$1")
    .replace(/^\/semantic_references\/(\d+)/, "/references/$1")
    .replace(/^\/shared_sampling_rules\/(\d+)/, "/sampling_rules/$1")
    .replace(/^\/reference_resolutions\/(\d+)/, "/occurrence_resolutions/$1");
}

const MAX_PATCH_OPERATION_COUNT = 40;
const MAX_PATCH_SERIALIZED_BYTES = 128 * 1024;
// 整份草稿一次性全量读取的体积上限：低于它恢复会话一次读完全部记录，
// 高于它退回目录分页（保护上下文）。
const SELECTOR_BULK_READ_LIMIT = 96 * 1024;
const MAX_PATCH_CHANGED_ACCEPTANCE_ITEMS = 4;
const MAX_BATCH_LOCATE_REQUESTS = 100;
const EVIDENCE_OPEN_WINDOW_BYTES = 24 * 1024;
const MAX_SELECTOR_TRANSPORT_FAILURES = 3;
const MAX_SELECTOR_PROTOCOL_FAILURES = 3;

export function referenceBindingOscillation(
  history: readonly { occurrence_id: string; issue_codes: string[]; issue_fingerprint: string }[],
): { occurrence_id: string; states: string[][] } | undefined {
  const occurrenceIds = [...new Set(history.map(entry => entry.occurrence_id))];
  for (const occurrenceId of occurrenceIds) {
    const rows = history.filter(entry => entry.occurrence_id === occurrenceId).slice(-3);
    if (rows.length !== 3) continue;
    const [first, middle, last] = rows;
    if (first!.issue_fingerprint === last!.issue_fingerprint
      && first!.issue_fingerprint !== middle!.issue_fingerprint) {
      return { occurrence_id: occurrenceId, states: rows.map(row => [...row.issue_codes]) };
    }
  }
  return undefined;
}

export function tableExpansionOscillation(
  history: readonly { item_key: string; issue_codes: string[]; issue_fingerprint: string }[],
): { item_key: string; states: string[][] } | undefined {
  for (const itemKey of [...new Set(history.map(entry => entry.item_key))]) {
    const rows = history.filter(entry => entry.item_key === itemKey).slice(-3);
    if (rows.length === 3 && rows[0]!.issue_fingerprint === rows[2]!.issue_fingerprint
      && rows[0]!.issue_fingerprint !== rows[1]!.issue_fingerprint) {
      return { item_key: itemKey, states: rows.map(row => [...row.issue_codes]) };
    }
  }
  return undefined;
}

export const DIRECT_VALIDATION_PROTOCOL = "direct-validation/v1" as const;
export const SAME_AGENT_SELF_REVIEW_PROTOCOL = "same-agent-self-review/v1" as const;

function selectorProtocolOrDefault(value: RevisionState["selector_protocol"]): NonNullable<RevisionState["selector_protocol"]> {
  return {
    submissions: value?.submissions ?? 0,
    corrections: value?.corrections ?? 0,
    coverage_repairs: value?.coverage_repairs ?? 0,
    transport_failures: value?.transport_failures ?? 0,
    protocol_failures: value?.protocol_failures ?? 0,
    last_transport_failure: value?.last_transport_failure ?? "",
    last_protocol_failure: value?.last_protocol_failure ?? "",
    last_issue_owner: value?.last_issue_owner ?? "",
    last_issue_fingerprint: value?.last_issue_fingerprint ?? "",
    ...(value?.stage_retries ? { stage_retries: { ...value.stage_retries } } : {}),
    ...(value?.last_stage_issues ? { last_stage_issues: structuredClone(value.last_stage_issues) } : {}),
    ...(value?.last_stage_diagnostics ? { last_stage_diagnostics: structuredClone(value.last_stage_diagnostics) } : {}),
    best_draft_fingerprint: value?.best_draft_fingerprint ?? "",
    best_history_sequence: value?.best_history_sequence ?? 0,
    best_preflight_stage_rank: value?.best_preflight_stage_rank ?? 0,
    best_issue_count: value?.best_issue_count ?? null,
    best_issue_fingerprint: value?.best_issue_fingerprint ?? "",
    consecutive_non_improvements: value?.consecutive_non_improvements
      ?? (value as { consecutive_regressions?: number } | undefined)?.consecutive_regressions
      ?? 0,
    self_review_requested_fingerprint: value?.self_review_requested_fingerprint ?? "",
    self_review_completed: value?.self_review_completed ?? false,
    self_review_fingerprint: value?.self_review_fingerprint ?? "",
    language_correction_attempts: { ...(value?.language_correction_attempts ?? {}) },
    language_review_markers: [...(value?.language_review_markers ?? [])],
    name_correction_attempts: { ...(value?.name_correction_attempts ?? {}) },
    name_review_markers: [...(value?.name_review_markers ?? [])],
    recent_reference_issue_states: [...(value?.recent_reference_issue_states ?? [])],
    recent_table_expansion_issue_states: [...(value?.recent_table_expansion_issue_states ?? [])],
  };
}

function publicSelectorProtocol(value: RevisionState["selector_protocol"], currentInputsFingerprint?: string): Record<string, unknown> {
  const protocol = selectorProtocolOrDefault(value);
  const snapshot = protocol.last_stage_diagnostics;
  const currentSnapshot = snapshot?.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
    && snapshot.inputs_fingerprint === currentInputsFingerprint;
  const staleSnapshot = Boolean(snapshot) && !currentSnapshot;
  return {
    submissions: protocol.submissions,
    corrections: protocol.corrections,
    coverage_repairs: protocol.coverage_repairs,
    transport_failures: protocol.transport_failures,
    protocol_failures: protocol.protocol_failures,
    last_transport_failure: protocol.last_transport_failure,
    last_protocol_failure: protocol.last_protocol_failure,
    last_issue_owner: protocol.last_issue_owner,
    last_issue_fingerprint: protocol.last_issue_fingerprint,
    stage_retries: protocol.stage_retries ?? null,
    last_stage_diagnostic_read: protocol.last_stage_issues?.length || protocol.last_stage_diagnostics ? {
      ...(staleSnapshot
        ? { next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } }
        : { next_tool: "get_target_context", next_tool_arguments: { stage_diagnostic_cursor: 0 } }),
      snapshot_status: staleSnapshot ? "stale" : snapshot ? "current" : "legacy_partial",
      historical_snapshot_present: Boolean(snapshot),
      complete_diagnostics_available: Boolean(currentSnapshot),
      ...(staleSnapshot ? { instruction: renderFeedback({ kind: "stale_diagnostic", constraint: "仅保留当前准确作者key与可用只读入口；不再使用旧完整页。" }) } : {}),
    } : null,
    language_review_warning_count: protocol.language_review_markers?.length ?? 0,
    name_review_warning_count: protocol.name_review_markers?.length ?? 0,
    self_review_completed: protocol.self_review_completed ?? false,
    self_review_fingerprint: protocol.self_review_fingerprint ?? "",
  };
}

function selectorDraftSpanIssues(
  value: unknown,
  registeredSpanIds: ReadonlySet<string>,
  path = "/draft",
): Array<{ code: string; path: string; message: string; details: { span_id: string } }> {
  const issues: Array<{ code: string; path: string; message: string; details: { span_id: string } }> = [];
  const visitSpanArray = (entry: unknown, entryPath: string): void => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visitSpanArray(child, `${entryPath}/${index}`));
      return;
    }
    if (typeof entry !== "string" || !new RegExp(SOURCE_SPAN_ID_PATTERN, "u").test(entry)) {
      issues.push({
        code: "selector_span_id_format",
        path: entryPath,
        message: `选择器 span 句柄必须符合 ${SOURCE_SPAN_ID_PATTERN}`,
        details: { span_id: String(entry) },
      });
    } else if (!registeredSpanIds.has(entry)) {
      issues.push({
        code: "selector_unknown_span",
        path: entryPath,
        message: "选择器引用的 span 不在当前不可变登记表中",
        details: { span_id: entry },
      });
    }
  };
  const visit = (entry: unknown, entryPath: string): void => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${entryPath}/${index}`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    Object.entries(entry as Record<string, unknown>).forEach(([key, child]) => {
      const childPath = `${entryPath}/${key}`;
      if (key === "span_ids" || key.endsWith("_span_ids")) visitSpanArray(child, childPath);
      else visit(child, childPath);
    });
  };
  visit(value, path);
  return issues;
}









function referenceAnalysisGate(issues: Awaited<ReturnType<typeof referenceAnalysisIssues>>): ToolResponse | undefined {
  if (issues.length === 0) return undefined;
  const failed = issues.find((issue) => issue.code === "reference_analysis_failed");
  if (failed) {
    return {
      ok: false,
      terminal: true,
      error: "reference_analysis_failed",
      instruction: "引用事实分析未完成。先核对analysis的真实失败、owner和当前阻塞；只有明确可修参数时才修请求，程序/来源故障保留现场按既有路线交接，不盲改selector或重复同参。",
      blocker_code: String(failed.details.terminal_blocker_code ?? "reference_analysis_failed"),
      issue_owner: "selector_input_error",
      budget_consumed: false,
      selector_issues: [failed],
      terminal_reason: failed.details.terminal_reason,
      required_action: "stop_current_target_and_inspect_reference_analysis_blocker_before_any_manual_recovery",
    };
  }
  return {
    ok: false,
    error: issues.some((issue) => issue.code === "reference_analysis_not_sealed")
      ? "reference_analysis_not_sealed"
      : "inline_reference_read_incomplete",
    issue_owner: "selector_input_error",
    budget_consumed: false,
    selector_issues: issues,
    required_action: "complete_each_reference_according_to_analysis_mode",
    instruction: "内联目标用 target_key 调用 read_document_reference_evidence 直到 done；隔离目标用 entry_ids 和分页游标调用 read_reference_facts，不得在主会话直接读取隔离目标正文。",
  };
}

function splitTextWindows(text: string, maxBytes = EVIDENCE_OPEN_WINDOW_BYTES): Array<{ start: number; end: number; text: string }> {
  if (!text) return [];
  const windows: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  let offset = 0;
  let bytes = 0;
  for (const character of text) {
    const width = character.length;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes > 0 && bytes + characterBytes > maxBytes) {
      windows.push({ start, end: offset, text: text.slice(start, offset) });
      start = offset;
      bytes = 0;
    }
    offset += width;
    bytes += characterBytes;
  }
  if (offset > start) windows.push({ start, end: offset, text: text.slice(start, offset) });
  return windows;
}

type EvidenceRecord = EvidenceManifest["evidence"][number];

type EvidenceAccessMetadata =
  | {
      access_mode: "direct";
      read_tool: "open_evidence";
      open_evidence_allowed: true;
    }
  | {
      access_mode: "inline_reference";
      read_tool: "read_document_reference_evidence";
      open_evidence_allowed: true;
      target_key: string;
    }
  | {
      access_mode: "isolated_reference";
      read_tool: "read_reference_facts";
      open_evidence_allowed: false;
      target_key: string;
    };

const RESOURCE_ACCESS_INSTRUCTION = "读取资源时，把该行 tool_arguments 原样作为参数调用 read_tool；直接使用当前回条的短句柄，来源所属目标由程序绑定。evidence_id、target_key、表号和行号不能互换，不自行构造 ID。direct 打开当前来源；inline_reference 按引用目标分页读取；isolated_reference 先取得隔离目录，再按目录返回的条目读取。目录只提供导航，不代表已读或业务适用。";

/** Directory capability follows registered identity and access, never clause-like text. */
function evidenceContextDirectory(record: EvidenceRecord, access: EvidenceAccessMetadata) {
  if (access.access_mode !== "direct") return { available: false, unavailable_reasons: ["reference_access_required"] };
  const reasons = [record.evidence_scope !== "primary" ? "outside_primary_index" : "",
    !record.clause_id ? "no_registered_clause_id" : ""].filter(Boolean);
  return reasons.length ? { available: false, unavailable_reasons: reasons }
    : { available: true, unavailable_reasons: [], basis: "exact_primary_clause_id",
      tool: "list_evidence_resources", tool_arguments: { context_for_evidence_id: record.evidence_id, cursor: 0, limit: 24 } };
}

function evidenceResource(
  record: EvidenceRecord,
  access?: EvidenceAccessMetadata,
): Record<string, unknown> {
  const toolArguments = access?.access_mode === "direct"
    ? { evidence_id: record.evidence_id, cursor: 0 }
    : access?.access_mode === "inline_reference"
      ? { target_key: access.target_key, cursor: 0 }
      : access ? { target_key: access.target_key } : undefined;
  if (access?.access_mode === "isolated_reference") {
    return {
      evidence_id: record.evidence_id,
      ...access,
      tool_arguments: toolArguments,
      context_directory: evidenceContextDirectory(record, access),
    };
  }
  const textFormat = tableEvidenceTextFormat(record);
  const clauseId = joinedFormalClauseId(record.text) || record.clause_id;
  const bindableRoles = record.role === "formal_table_title"
    ? ["table_no", "table_title"]
    : record.role === "table_continuation_caption"
      ? ["table_continuity"]
      : record.role === "formal_table_header"
        ? ["column_header", "table_header_semantics"]
        : record.kind === "table_row" && record.table_row_kind === "data"
          ? ["row_path", "applicability", "condition", "allowed_value", "inspection_method"]
          : [];
  return {
    evidence_id: record.evidence_id,
    ...(record.atom_id ? { atom_id: record.atom_id } : {}),
    kind: record.kind,
    role: record.role,
    locator: record.locator,
    text_sha256: record.text_sha256,
    text_length: record.text.length,
    utf8_bytes: Buffer.byteLength(record.text, "utf8"),
    requires_disposition: record.requires_disposition,
    evidence_scope: record.evidence_scope,
    ...(record.registered_dependency ? { registered_dependency: true } : {}),
    ...(record.table_fragment_id ? { table_fragment_id: record.table_fragment_id } : {}),
    ...(record.table_id ? { table_id: record.table_id } : {}),
    ...(record.table_title ? { table_title: record.table_title } : {}),
    ...(record.table_row_kind ? { table_row_kind: record.table_row_kind } : {}),
    ...(record.row_index !== undefined ? { row_index: record.row_index } : {}),
    ...(record.columns ? { columns: record.columns } : {}),
    ...(record.cells ? { cells: record.cells } : {}),
    ...(record.cell_geometry ? { cell_geometry: record.cell_geometry } : {}),
    ...(record.kind === "table_row" ? {
      table_text_format: textFormat,
      bindable_roles: bindableRoles,
      whole_chunk_role_restriction: textFormat === "legacy_navigation_mixed_v0"
        ? "legacy mixed navigation text; use typed cell handles only"
        : "whole row is not a table title; use typed roles",
    } : bindableRoles.length ? { bindable_roles: bindableRoles } : {}),
    ...(clauseId ? { clause_id: clauseId } : {}),
    ...(access ?? {}),
    ...(toolArguments ? { tool_arguments: toolArguments } : {}),
    ...(access ? { context_directory: evidenceContextDirectory(record, access) } : {}),
  };
}

export const COVERAGE_REPAIR_DELTA_KINDS = [
  "add_new_item",
  "split_existing_item",
  "update_existing_item",
  "bind_reference",
  "bind_sampling",
  "remove_contamination",
  "context_only",
] as const;

export function buildCoverageRepairWorklist(
  review: {
    findings: Array<{
      finding_id: string;
      finding_type: string;
      evidence_id: string;
      exact_fragment: string;
      affected_item_ids: string[];
      description: string;
      reason: string;
      judgment_id?: string;
      finding_origin?: string;
      first_seen_plan_fingerprint?: string;
      prior_finding_id?: string;
    }>;
  },
  evidence: EvidenceManifest,
  affectedSelectorBindings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const evidenceById = new Map(evidence.evidence.map((record) => [record.evidence_id, record]));
  return review.findings
    .filter((finding) => finding.finding_type === "semantic_coverage_gap")
    .map((finding) => {
      const selectorBindings = affectedSelectorBindings.filter((binding) =>
        Array.isArray(binding.finding_ids)
        && binding.finding_ids.some((findingId) => findingId === finding.finding_id)
      );
      const source = evidenceById.get(finding.evidence_id);
      return {
        finding_id: finding.finding_id,
        finding_type: finding.finding_type,
        evidence_id: finding.evidence_id,
        exact_fragment: finding.exact_fragment,
        description: finding.description,
        reason: finding.reason,
        judgment_id: finding.judgment_id ?? "",
        finding_origin: finding.finding_origin ?? "",
        first_seen_plan_fingerprint: finding.first_seen_plan_fingerprint ?? "",
        prior_finding_id: finding.prior_finding_id ?? "",
        affected_item_ids: [...finding.affected_item_ids],
        selector_bindings: selectorBindings,
        source_resource: source ? evidenceResource(source) : null,
        new_item_allowed: finding.affected_item_ids.length === 0 || selectorBindings.length === 0,
        required_decision: "compile_to_minimal_selector_delta",
        allowed_delta_kinds: [...COVERAGE_REPAIR_DELTA_KINDS],
        instruction: finding.affected_item_ids.length === 0 || selectorBindings.length === 0
          ? "No existing final leaf/selector mapping is required for this gap. Open the cited immutable evidence, determine the source item boundary and semantics, and create the smallest new typed selector item(s) or context disposition justified by that evidence."
          : "Use the mapped selector records as the repair starting point, but decide the semantic delta from opened immutable evidence rather than from the existing path alone.",
      };
    });
}

function samplingNavigationCandidates(manifest: EvidenceManifest): Array<Record<string, unknown>> {
  const pattern = /(?:(?:检查|检验|检测)数量|抽查|全数(?:检查|检验|检测)|每(?:批|处|件|组)|检验批|取样|抽样)/gu;
  const seen = new Set<string>();
  return manifest.evidence.flatMap((record) => {
    const matches = [...record.text.matchAll(pattern)].slice(0, 8);
    return matches.flatMap((match) => {
      const offset = match.index ?? 0;
      const start = Math.max(0, offset - 100);
      const end = Math.min(record.text.length, offset + match[0].length + 180);
      const preview = record.text.slice(start, end);
      const key = `${record.evidence_id}\0${start}\0${end}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        candidate_id: `sampling-navigation:${sha256Text(key)}`,
        evidence_id: record.evidence_id,
        preview,
        locator: record.locator,
        discovery_basis: "text-retrieval",
        instruction: "High-recall navigation hint only; open the source and decide applicability semantically. This candidate never creates or filters a sampling rule.",
      }];
    });
  }).slice(0, 100);
}

function evidenceWindowKey(evidenceId: string, window: { start: number; end: number }): string {
  return `${evidenceId}:${window.start}:${window.end}`;
}

function documentAtomResource(atom: DocumentAtom): Record<string, unknown> {
  return {
    atom_id: atom.atom_id,
    locator: `char:${atom.start_offset}-${atom.end_offset}`,
    start_line: atom.start_line,
    end_line: atom.end_line,
    text_sha256: atom.text_sha256,
    text_length: atom.text.length,
    utf8_bytes: Buffer.byteLength(atom.text, "utf8"),
  };
}

function charLocatorRange(locator: string): { start: number; end: number } | null {
  const match = /^char:(\d+)-(\d+)$/u.exec(locator);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end
    ? { start, end }
    : null;
}

function boundedPage<T>(values: T[], input: Record<string, unknown>): { rows: T[]; next_cursor: number | null } {
  const cursor = Math.max(0, Number(input.cursor ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25) || 25));
  const rows = values.slice(cursor, cursor + limit);
  while (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_PATCH_SERIALIZED_BYTES) rows.pop();
  return { rows, next_cursor: cursor + rows.length >= values.length ? null : cursor + rows.length };
}

function acceptanceItemFingerprints(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object") return new Map();
  const items = (value as { acceptance_items?: unknown }).acceptance_items;
  if (!Array.isArray(items)) return new Map();
  return new Map(items.map((item, index) => {
    const itemId = item && typeof item === "object"
      && typeof (item as { item_id?: unknown }).item_id === "string"
      ? (item as { item_id: string }).item_id
      : `index:${index}`;
    return [itemId, sha256Json(item)] as const;
  }));
}

function changedAcceptanceItemIds(before: unknown, after: unknown): string[] {
  const left = acceptanceItemFingerprints(before);
  const right = acceptanceItemFingerprints(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((itemId) => left.get(itemId) !== right.get(itemId));
}

function addedAcceptanceItemIds(before: unknown, after: unknown): string[] {
  const left = acceptanceItemFingerprints(before);
  const right = acceptanceItemFingerprints(after);
  return [...right.keys()].filter((itemId) => !left.has(itemId)).sort();
}

async function publishImmutable(path: string, content: string): Promise<void> {
  if (await pathExists(path)) {
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Immutable artifact collision at ${path}`);
    }
    return;
  }
  await atomicWriteNewText(path, content);
}

async function recoverOpenedEvidenceIds(
  workspace: RevisionWorkspace,
  evidence: EvidenceManifest,
): Promise<string[]> {
  const state = await workspace.readState();
  if (Array.isArray(state.opened_evidence_ids) && state.opened_evidence_ids.length > 0) {
    return state.opened_evidence_ids;
  }

  const knownEvidenceIds = new Set(evidence.evidence.map((record) => record.evidence_id));
  const recovered = new Set<string>();
  if (await pathExists(workspace.transcriptPath)) {
    const lines = createInterface({
      input: createReadStream(workspace.transcriptPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          event_type?: string;
          payload?: { tool_name?: string; input?: { evidence_id?: unknown } };
        };
        const evidenceId = event.payload?.input?.evidence_id;
        if (
          event.event_type === "tool_execution_start"
          && event.payload?.tool_name === "open_evidence"
          && typeof evidenceId === "string"
          && knownEvidenceIds.has(evidenceId)
        ) {
          recovered.add(evidenceId);
        }
      } catch {
        // An append-only transcript can end in one truncated line after interruption.
      }
    }
  }
  if (
    recovered.size === 0
    && (state.selector_protocol?.submissions ?? 0) > 0
    && await pathExists(workspace.workingSelectorPath)
    && await pathExists(workspace.sourceSpanRegistryPath)
  ) {
    const selectors = migrateTargetSelectorPlan(strictJsonParse(
      await readFile(workspace.workingSelectorPath, "utf8"),
    ));
    const registry = await workspace.readSourceSpanRegistry();
    const selectedSpanIds = new Set<string>();
    const visit = (value: unknown, key = ""): void => {
      if (Array.isArray(value)) {
        if (key === "span_ids" || key.endsWith("_span_ids")) {
          for (const entry of value) if (typeof entry === "string") selectedSpanIds.add(entry);
        } else {
          for (const entry of value) visit(entry);
        }
      } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
      }
    };
    visit(selectors);
    for (const span of registry.spans) {
      if (selectedSpanIds.has(span.span_id) && knownEvidenceIds.has(span.evidence_id)) {
        recovered.add(span.evidence_id);
      }
    }
  }
  const openedEvidenceIds = [...recovered];
  // A sealed revision is immutable and its state participates in the seal audit.
  // Rehydrate legacy provenance in memory only; never mutate a sealed artifact just
  // to add a newly introduced runtime cache field.
  if (state.status !== "sealed") {
    await workspace.updateState((current) => {
      if (!Array.isArray(current.opened_evidence_ids) || current.opened_evidence_ids.length === 0) {
        current.opened_evidence_ids = openedEvidenceIds;
      }
    });
  }
  return openedEvidenceIds;
}

async function recoverRepairState(
  workspace: RevisionWorkspace,
  evidence: EvidenceManifest,
): Promise<void> {
  const state = await workspace.readState();
  if (state.repair || state.status === "sealed") return;
  let recovered = repairStateOrDefault(undefined);
  if (await pathExists(workspace.validationReceiptPath)) {
    const receipt = await readJson<{
      ok?: unknown;
      issues?: unknown;
      validation_fingerprint?: unknown;
    }>(workspace.validationReceiptPath);
    if (receipt.ok === true && state.last_valid_fingerprint) {
      recovered.mode = "validated";
    } else if (receipt.ok === false && Array.isArray(receipt.issues)) {
      const issues = receipt.issues.filter((issue): issue is ValidationResult["issues"][number] =>
        Boolean(
          issue
          && typeof issue === "object"
          && typeof (issue as { code?: unknown }).code === "string"
          && typeof (issue as { path?: unknown }).path === "string"
          && typeof (issue as { message?: unknown }).message === "string",
        )
      );
      let activeCluster = null;
      try {
        const persistedPlan = strictJsonParse(
          await readFile(workspace.workingPlanPath, "utf8"),
        ) as PersistedSemanticSourcePlan;
        const plan = isCompactSemanticSourcePlan(persistedPlan)
          ? hydrateSemanticSourcePlan(persistedPlan, evidence)
          : persistedPlan;
        activeCluster = selectActiveIssueCluster(validationIssueClusters(plan, issues));
      } catch {
        // The validator will report malformed JSON/schema again. Recovery must
        // still enter repair-only mode instead of silently reopening modeling.
      }
      recovered = {
        ...recovered,
        mode: "repair",
        active_cluster: activeCluster,
        total_issue_count: issues.length,
        validation_fingerprint: typeof receipt.validation_fingerprint === "string"
          && receipt.validation_fingerprint
          ? receipt.validation_fingerprint
          : sha256Json(issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              details: issue.details ?? null,
            }))),
      };
    }
  }
  await workspace.updateState((current) => {
    if (!current.repair) current.repair = recovered;
  });
}

async function recoverLegacyValidatedSelectorCheckpoint(
  workspace: RevisionWorkspace,
  evidence: EvidenceManifest,
): Promise<void> {
  const state = await workspace.readState();
  if (
    state.status === "sealed"
    || state.last_valid_fingerprint
    || !state.coverage_recheck
    || !(await pathExists(workspace.validationReceiptPath))
    || !(await pathExists(workspace.lastValidPlanPath))
  ) return;
  // An explicitly opened repair is not a legacy post-commit mutation. Restoring
  // the last valid candidate here would discard its new findings and draft.
  if (state.selector_stage === "coverage_repair"
    && state.repair?.repair_source === "coverage"
    && state.repair.coverage_review_fingerprint
    && ["repair", "modeling"].includes(state.repair.mode)) return;
  const receipt = await readJson<{
    ok?: unknown;
    timestamp?: unknown;
    validation_fingerprint?: unknown;
    plan_sha256?: unknown;
  }>(workspace.validationReceiptPath);
  if (
    receipt.ok !== true
    || typeof receipt.timestamp !== "string"
    || typeof receipt.validation_fingerprint !== "string"
    || typeof receipt.plan_sha256 !== "string"
    || receipt.validation_fingerprint !== state.coverage_recheck.plan_fingerprint
  ) return;
  const planSource = await readFile(workspace.lastValidPlanPath, "utf8");
  const validation = validatePlanText(planSource, evidence);
  if (
    !validation.ok
    || validation.fingerprint !== receipt.validation_fingerprint
    || validation.plan_sha256 !== receipt.plan_sha256
  ) return;

  if (!(await pathExists(workspace.lastValidSelectorPath))) {
    let selectorSource = await readFile(workspace.workingSelectorPath, "utf8");
    const historyNames = (await readdir(workspace.historyDirectory))
      .filter((name) => /^\d{6}\.json$/u.test(name))
      .sort()
      .reverse();
    for (const name of historyNames) {
      const history = await readJson<{
        timestamp?: unknown;
        unified_patch?: unknown;
        before_sha256?: unknown;
        after_sha256?: unknown;
      }>(join(workspace.historyDirectory, name));
      if (typeof history.timestamp !== "string" || history.timestamp <= receipt.timestamp) break;
      if (
        typeof history.unified_patch !== "string"
        || typeof history.before_sha256 !== "string"
        || typeof history.after_sha256 !== "string"
        || sha256Text(selectorSource) !== history.after_sha256
      ) continue;
      const parsedPatch = parsePatch(history.unified_patch);
      if (parsedPatch.length !== 1) return;
      const restored = applyPatch(selectorSource, reversePatch(parsedPatch[0]!));
      if (restored === false || sha256Text(restored) !== history.before_sha256) return;
      selectorSource = restored;
    }
    const selectors = migrateTargetSelectorPlan(strictJsonParse(selectorSource));
    await atomicWriteJson(workspace.lastValidSelectorPath, selectors);
  }
  await atomicWriteJson(
    workspace.workingSelectorPath,
    migrateTargetSelectorPlan(strictJsonParse(await readFile(workspace.lastValidSelectorPath, "utf8"))),
  );
  await atomicWriteJson(
    workspace.workingPlanPath,
    validation.persisted_plan ?? validation.plan,
  );
  await workspace.updateState((current) => {
    current.last_valid_fingerprint = receipt.validation_fingerprint as string;
    current.last_valid_plan_sha256 = receipt.plan_sha256 as string;
    current.selector_stage = "commit";
    current.repair = {
      ...repairStateOrDefault(undefined),
      mode: "validated",
      session_epoch: repairStateOrDefault(current.repair).session_epoch,
    };
  });
  await workspace.appendEvent("legacy_validated_selector_checkpoint_recovered", {
    plan_fingerprint: receipt.validation_fingerprint,
    coverage_recheck: state.coverage_recheck,
  });
}

let referenceToolFingerprintPromise: Promise<string> | undefined;
function referenceToolImplementationFingerprint(): Promise<string> {
  referenceToolFingerprintPromise ??= (async () => {
    const modulePath = fileURLToPath(import.meta.url);
    const extension = extname(modulePath);
    const hashes = await Promise.all(["tools", "document-reference", "external-standard-reference", "external-source-workflow", "external-reference-scope", "reference-correction"].map(async name =>
      [name, sha256Text(await readFile(join(dirname(modulePath), name + extension), "utf8"))]
    ));
    return sha256Json(hashes);
  })();
  return referenceToolFingerprintPromise;
}

export class ToolController {
  externalSourceWorkflow?: ExternalSourceWorkflow;
  userFeedback?: string;
  /** Host display label only; never persisted into frozen evidence. */
  sourcePdfDisplayName?: string;
  private modelReviewObservations = new Map<string, unknown>();
  private submittedPreflight: { draft_fingerprint: string; evidence_fingerprint: string; result: TargetSelectorPreflight } | undefined;
  /**
   * 规则发现 Agent 的入口，由 pi-runtime 注入。不注入就只走确定性规则 +
   * 兜底分段，全程零模型调用——目录本身从来不需要模型。
   */
  referenceCatalogRuleAsk?: CatalogRuleAsk;
  private readonly openedEvidenceIds: Set<string>;
  private readonly currentDeliveryWindows = new Set<string>();
  private globalDocumentEvidence?: DocumentEvidence;
  private globalDocumentHeadingNavigation?: ReturnType<typeof createDocumentHeadingNavigation>;
  private tableHeadingLookup?: ReturnType<typeof createTableHeadingLookup>;
  private preparedBindingsSinceCheckpoint = 0;
  private selectorStage: TargetSelectorStage;
  private selectorBlockerRepairRequired = false;
  // Delivery-only cache; a new controller must deliver the full handoff again.
  private deliveredSelectorBlockerHandoffSha = "";
  private inheritedReferenceLedgerRead = false;
  private readonly returnedTargetContextPages = new Set<string>();
  private readonly initialSelectorStartupContext: TargetSelectorStartupContext;
  private inheritedSelectorReadRequired: boolean;

  private constructor(
    public readonly workspace: RevisionWorkspace,
    public readonly evidence: EvidenceManifest,
    openedEvidenceIds: Iterable<string>,
    selectorStage: TargetSelectorStage,
    selectorStartupContext: TargetSelectorStartupContext,
  ) {
    const knownEvidenceIds = new Set(evidence.evidence.map((record) => record.evidence_id));
    this.openedEvidenceIds = new Set(
      [...openedEvidenceIds].filter((evidenceId) => knownEvidenceIds.has(evidenceId)),
    );
    this.selectorStage = selectorStage;
    this.initialSelectorStartupContext = selectorStartupContext;
    this.inheritedSelectorReadRequired = selectorStartupContext.read_target_selectors_required;
  }

  static async create(
    workspace: RevisionWorkspace,
  ): Promise<ToolController> {
    if (coverageRepairAllowsExternalDependency(await workspace.readState())) {
      await workspace.adoptReferenceObservations();
    }
    await workspace.restoreRegisteredTableFragments();
    const evidence = await workspace.readEvidenceManifest();
    if (
      evidence.source.semantic_workflow
      && !(await pathExists(workspace.workingSelectorPath))
    ) {
      await atomicWriteJson(
        workspace.workingSelectorPath,
        initialTargetSelectorPlan(evidence),
      );
    }
    if (await pathExists(workspace.manifestPath)) {
      await workspace.updateState((state) => {
        state.status = "sealed";
      });
    }
    if (!(await pathExists(workspace.manifestPath))) {
      const registry = await workspace.readSourceSpanRegistry();
      const registered = registerHtmlTableCellSpans(
        registry,
        evidence.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      if (sourceSpanRegistryFingerprint(registered.registry) !== sourceSpanRegistryFingerprint(registry)) {
        await atomicWriteJson(workspace.sourceSpanRegistryPath, registered.registry);
      }
      const tableStructurePath = join(workspace.root, "table-structure.json");
      const complexTableIds = new Set(evidence.evidence.filter((record) =>
        record.table_row_kind === "data" && record.table_id
      ).map((record) => record.table_id!));
      const hasComplexTable = [...complexTableIds].some((tableId) =>
        evidence.evidence.filter((record) => record.table_row_kind === "data" && record.table_id === tableId).length > 1
      );
      if (hasComplexTable && !(await pathExists(tableStructurePath))) {
        await atomicWriteJson(
          tableStructurePath,
          initialTableStructurePlan(evidence, registered.registry),
        );
      }
    }
    await recoverRepairState(workspace, evidence);
    await recoverLegacyValidatedSelectorCheckpoint(workspace, evidence);
    const openedEvidenceIds = await recoverOpenedEvidenceIds(workspace, evidence);
    const state = await workspace.readState();
    // Legacy checkpoints must not restore the retired locate -> stage gate.
    if (state.selector_batch_requires_stage !== undefined) {
      await workspace.updateState((current) => { delete current.selector_batch_requires_stage; });
    }
    const repair = repairStateOrDefault(state.repair);
    const selectorStage: TargetSelectorStage = repair.mode === "repair" && repair.repair_source === "coverage"
      ? "coverage_repair"
      : state.selector_stage ?? "primary";
    if (state.selector_stage !== selectorStage) {
      await workspace.updateState((current) => { current.selector_stage = selectorStage; });
    }
    const selectors = await pathExists(workspace.workingSelectorPath)
      ? migrateTargetSelectorPlanForAuthoring(strictJsonParse(
          await readFile(workspace.workingSelectorPath, "utf8"),
        )).plan
      : initialTargetSelectorPlan(evidence);
    const currentSelectorState = targetSelectorCurrentState(selectors, state);
    const diagnosticInputsFingerprint = state.selector_protocol?.last_stage_diagnostics
      ? await selectorStageDiagnosticInputsFingerprint(workspace) : undefined;
    const selectorStartupContext = targetSelectorStartupSnapshot(
      selectors,
      state,
      // The persisted repair focus replaces the blanket orientation read.
      // Keep the provider tools and dispatch gate consistent with that prompt;
      // keyed saves still preserve untouched records and all validation budgets.
      currentSelectorState === "inherited_existing"
        && !(state.selector_protocol?.last_stage_issues?.length && stageFocusUsesCurrentInputs(state, diagnosticInputsFingerprint)),
      diagnosticInputsFingerprint,
    );
    const controller = new ToolController(
      workspace,
      evidence,
      openedEvidenceIds,
      selectorStage,
      selectorStartupContext,
    );
    const access = await controller.evidenceAccessSnapshot(false);
    const tableStructurePlan = await controller.projectAccessibleTableStructurePlan(
      await controller.readTableStructurePlan(),
    );
    await atomicWriteJson(
      join(workspace.root, "table-expansion-obligations.json"),
      {
        schema_version: "table-expansion-obligations/v1",
        ...tableExpansionState(
          evidence,
          await workspace.readSourceSpanRegistry(),
          selectors,
          tableStructurePlan,
          controller.eligibleTableEvidenceIds(access.accessByEvidenceId),
        ),
      },
    );
    return controller;
  }

  selectorStartupContext(): TargetSelectorStartupContext {
    return {
      ...structuredClone(this.initialSelectorStartupContext),
      read_target_selectors_required: this.inheritedSelectorReadRequired,
    };
  }

  selectorProviderPolicy(): { stage: TargetSelectorStage; allowed_tools: string[] } {
    const common = ["get_target_context", "get_target_selector_contract", "list_sampling_rules", "stage_reference_component_decisions", ...SELECTOR_NAVIGATION_TOOLS];
    const byStage: Record<TargetSelectorStage, string[]> = {
      primary: ["commit_target_selector_draft", "list_sampling_rules", "list_table_fragments", "list_reference_occurrences", "get_target_context", "get_target_selector_contract", "read_target_selectors", "stage_target_selector_draft", "stage_table_structure", "advance_target_selector_stage", "report_target_blocker", ...common],
      sampling: ["commit_target_selector_draft", "list_sampling_rules", "list_table_fragments", "list_reference_occurrences", "get_target_context", "read_target_selectors", "stage_target_selector_draft", "stage_table_structure", "advance_target_selector_stage", "report_target_blocker", ...common],
      table: ["commit_target_selector_draft", "list_sampling_rules", "list_table_fragments", "list_reference_occurrences", "get_target_context", "read_target_selectors", "stage_target_selector_draft", "stage_table_structure", "advance_target_selector_stage", "report_target_blocker", ...common],
      commit: [
        "save_target_investigation",
        "read_target_selectors",
        "list_evidence_resources", "list_reference_occurrences", "resolve_document_reference", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "search_evidence",
        "locate_evidence_span", "batch_locate_evidence_spans",
        "stage_target_selector_draft", "stage_table_structure", "commit_target_selector_draft", "report_target_blocker", "seal_validated_plan",
        ...common,
      ],
      coverage_repair: ["get_target_context", "read_coverage_review", "read_target_selectors", "list_reference_occurrences", "list_sampling_rules", "list_table_fragments", "stage_target_selector_draft", "stage_table_structure", "commit_target_selector_draft", "report_target_blocker", "seal_validated_plan", ...common],
    };
    const allowedTools = [...new Set([...byStage[this.selectorStage], ...(this.externalSourceWorkflow ? ["resolve_external_standard_reference"] : [])])];
    const readableTools = this.inheritedSelectorReadRequired
      ? allowedTools.filter((name) => !INHERITED_SELECTOR_READ_GATED_TOOLS.has(name))
      : allowedTools;
    return {
      stage: this.selectorStage,
      allowed_tools: this.selectorBlockerRepairRequired
        ? readableTools.filter((name) => name !== "report_target_blocker")
        : readableTools,
    };
  }

  private selectorCoreSpanIds(item: TargetSelectorPlan["items"][number]): string[] {
    if (item.table?.source_kind === "reference") {
      return [...new Set(item.table.reference_span_ids)];
    }
    if (item.table) {
      return [...new Set([
        ...item.table.properties.table_no_span_ids,
        ...item.table.properties.table_title_span_ids,
        ...item.table.properties.row_path_span_ids.flat(),
        ...item.table.properties.column_path_span_ids.flat(),
        ...item.table.properties.allowed_value_span_ids,
      ])];
    }
    return [...new Set(item.fields.requirement.span_ids.length
      ? item.fields.requirement.span_ids
      : item.criterion_span_ids)];
  }

  private ledgerClauseIdsForSpans(
    spanIds: readonly string[],
    registry: SourceSpanRegistry,
    ledger: DocumentLedger,
  ): string[] {
    const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
    const evidenceById = new Map(this.evidence.evidence.map((record) => [record.evidence_id, record]));
    return [...new Set(spanIds.flatMap((spanId) => {
      const span = spanById.get(spanId);
      const record = span ? evidenceById.get(span.evidence_id) : undefined;
      const line = record ? evidenceLocatorLine(record.locator) : undefined;
      if (line === undefined) return [];
      const owner = ledger.clauses
        .filter((clause) => line >= clause.line && line < clause.end_exclusive_line)
        .sort((left, right) =>
          (left.end_exclusive_line - left.line) - (right.end_exclusive_line - right.line)
        )[0];
      return owner ? [owner.clause_id] : [];
    }))].sort();
  }

  private async targetFieldRoleIssues(
    selectors: TargetSelectorPlan,
    suppliedRegistry?: SourceSpanRegistry,
  ): Promise<unknown[]> {
    const registry = suppliedRegistry ?? await this.workspace.readSourceSpanRegistry();
    const ledger = await this.workspace.readDocumentLedger();
    const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
    const evidenceById = new Map(this.evidence.evidence.map((record) => [record.evidence_id, record]));
    const fragmentIdsByEvidenceId = new Map<string, Set<string>>();
    for (const fragment of this.evidence.table_fragments) {
      for (const evidenceId of [
        ...fragment.title_candidate_evidence_ids,
        ...fragment.header_evidence_ids,
        ...fragment.row_evidence_ids,
        ...fragment.formal_row_evidence_ids,
      ]) {
        const fragmentIds = fragmentIdsByEvidenceId.get(evidenceId) ?? new Set<string>();
        fragmentIds.add(fragment.fragment_id);
        fragmentIdsByEvidenceId.set(evidenceId, fragmentIds);
      }
    }
    const issues: unknown[] = [];
    const expectedCandidates = (ranges: Array<{ start_line: number; end_exclusive_line: number }>): Array<Record<string, unknown>> => {
      return this.evidence.evidence
        .filter((record) => {
          const line = evidenceLocatorLine(record.locator);
          return line !== undefined && ranges.some(range => range.start_line <= line && line < range.end_exclusive_line);
        })
        .slice(0, 8)
        .map((record) => ({
          evidence_id: record.evidence_id,
          locator: record.locator,
          text: record.text,
          span_ids: registry.spans
            .filter((span) => span.evidence_id === record.evidence_id
              && span.start === 0 && span.end === record.text.length)
            .map((span) => span.span_id),
        }));
    };

    selectors.items.forEach((item, itemIndex) => {
      const coreEvidenceIds = new Set(this.selectorCoreSpanIds(item).flatMap((spanId) => {
        const span = spanById.get(spanId);
        return span ? [span.evidence_id] : [];
      }));
      const coreFragmentIds = new Set([...coreEvidenceIds].flatMap((evidenceId) => {
        const record = evidenceById.get(evidenceId);
        return [
          ...(record?.table_fragment_id ? [record.table_fragment_id] : []),
          ...[...(fragmentIdsByEvidenceId.get(evidenceId) ?? [])],
        ];
      }));
      const coreTableIds = new Set([...coreEvidenceIds].flatMap((evidenceId) => {
        const tableId = evidenceById.get(evidenceId)?.table_id?.trim();
        return tableId ? [tableId] : [];
      }));
      // Physical-table membership must reflect the table the item actually
      // imports from, not only its citation/leaf core. A referenced-table item
      // names its imported row and column headers in table.properties; those
      // spans belong to the same logical table as the imported cells. The
      // inspected method span itself is deliberately excluded: it is the role
      // under validation, and membership must never be self-satisfying.
      const structureEvidenceIds = new Set(item.table
        ? unique([
            ...item.table.properties.table_no_span_ids,
            ...item.table.properties.table_title_span_ids,
            ...item.table.properties.applicability_span_ids,
            ...item.table.properties.row_path_span_ids.flat(),
            ...item.table.properties.column_path_span_ids.flat(),
            ...item.table.properties.unit_span_ids,
            ...item.table.properties.condition_span_ids,
            ...item.table.properties.allowed_value_span_ids,
          ]).flatMap((spanId) => {
            const span = spanById.get(spanId);
            return span ? [span.evidence_id] : [];
          })
        : []);
      const membershipEvidenceIds = new Set([...coreEvidenceIds, ...structureEvidenceIds]);
      const membershipFragmentIds = new Set([...membershipEvidenceIds].flatMap((evidenceId) => {
        const record = evidenceById.get(evidenceId);
        return [
          ...(record?.table_fragment_id ? [record.table_fragment_id] : []),
          ...[...(fragmentIdsByEvidenceId.get(evidenceId) ?? [])],
        ];
      }));
      const membershipTableIds = new Set([...membershipEvidenceIds].flatMap((evidenceId) => {
        const tableId = evidenceById.get(evidenceId)?.table_id?.trim();
        return tableId ? [tableId] : [];
      }));
      const ownerClauseIds = ledger
        ? this.ledgerClauseIdsForSpans(this.selectorCoreSpanIds(item), registry, ledger)
        : [];
      const ownerClause = ownerClauseIds.length === 1
        ? ledger?.clauses.find((clause) => clause.clause_id === ownerClauseIds[0])
        : undefined;
      const checkBindings = (
        role: "method" | "quantity" | "sampling_quantity" | "sampling_script" | "table_inspection_method",
        spanIds: readonly string[],
        path: string,
        composition: string,
      ): void => {
        const expectedLine = role === "method" || role === "table_inspection_method"
          ? ownerClause?.method_line
          : ownerClause?.quantity_line;
        const expectedRole = role.includes("method") ? "method" : "quantity";
        const expectedRanges = ownerClause?.field_role_ranges?.filter(range => range.role === expectedRole)
          ?? (expectedLine === undefined ? [] : [{ start_line: expectedLine, end_exclusive_line: expectedLine + 1 }]);
        for (const [spanIndex, spanId] of spanIds.entries()) {
          const span = spanById.get(spanId);
          const record = span ? evidenceById.get(span.evidence_id) : undefined;
          if (!span || !record) continue;
          const text = record.text.slice(span.start, span.end);
          const issuePath = `${path}/${spanIndex}`;
          const actual = {
            span_id: spanId,
            evidence_id: record.evidence_id,
            locator: record.locator,
            evidence_kind: record.kind,
            evidence_role: record.role,
            text,
          };
          // kind=heading only records Markdown typography. Unknown heading text
          // stays context: the Agent decides its meaning using the source.
          const heading = record.role === "section_heading";
          if (heading) {
            issues.push({
              code: "selector_field_heading_evidence_forbidden",
              path: issuePath,
              message: "章节/分类标题不能充当检验方法、检查数量或抽样脚本的来源",
              details: {
                item_key: item.key,
                role,
                actual,
                owner_clause_id: ownerClause?.clause_id ?? "",
                expected_candidates: expectedCandidates(expectedRanges),
                writable_collection: "items",
                writable_item_key: item.key,
                writable_path: issuePath.replace(/^\/items\/\d+/u, "/draft/items/0"),
                patch_instruction: "错误路径的索引指向已保存集合；请将此 item_key 对应的完整记录放入 draft.items[0] 提交，保留其余字段。",
                required_action: role.startsWith("sampling_")
                  ? "绑定真实的数量/抽样原句，同一句可同时支持 quantity 和 script；本地没有时检查适用共享规则。sampling 不支持字段组合方式 not_applicable。"
                  : "绑定真实的方法/数量来源。只有不存在适用来源的 fields 字段才能用 composition=not_applicable 且 span_ids=[]；表格属性使用 []，不能填写 composition 对象。",
                do_not: "禁止保留标题来源、只改 reason 来重新解释；禁止删除已有真实方法或数量；禁止修改不可变原文或编译结果",
                next_tool: "stage_target_selector_draft",
              },
            });
            continue;
          }
          const line = evidenceLocatorLine(record.locator);
          const explicitlyRouted = composition === "reference" || record.evidence_scope === "reference";
          const recordFragmentIds = new Set([
            ...(record.table_fragment_id ? [record.table_fragment_id] : []),
            ...[...(fragmentIdsByEvidenceId.get(record.evidence_id) ?? [])],
          ]);
          const samePhysicalTable = membershipEvidenceIds.has(record.evidence_id)
            || [...recordFragmentIds].some((fragmentId) => membershipFragmentIds.has(fragmentId))
            || Boolean(record.table_id?.trim() && membershipTableIds.has(record.table_id.trim()));
          const cell = renderedTableCellSpans(record).find((candidate) =>
            // A cell may combine method, quantity and conditions. An exact
            // source substring is still in that cell; it need not select the
            // unrelated facts too. Never extend across a cell boundary.
            candidate.start <= span.start && span.end <= candidate.end && span.start < span.end
          );
          const expectedCellLabel = role === "method" || role === "table_inspection_method"
            ? /(?:检验|检查)方法/u
            : /(?:检查|检验|检测|抽样|抽检|抽查)数量/u;
          const typedTableCell = samePhysicalTable
            && Boolean(cell && expectedCellLabel.test(cell.label));
          if (
            expectedRanges.length > 0
            && line !== undefined
            && !expectedRanges.some(range => range.start_line <= line && line < range.end_exclusive_line)
            && !explicitlyRouted
            && !typedTableCell
          ) {
            issues.push({
              code: "selector_field_clause_line_mismatch",
              path: issuePath,
              message: "本地字段选择的来源行不在所属条款的方法/数量段落内；所选行可能仍在同一条款内，但承担其他角色",
              details: {
                item_key: item.key,
                role,
                actual,
                actual_line: line,
                actual_clause_id: ledger ? this.ledgerClauseIdsForSpans([spanId], registry, ledger)[0] ?? "" : "",
                owner_clause_id: ownerClause?.clause_id ?? "",
                expected_line: expectedLine,
                expected_line_ranges: expectedRanges,
                expected_role: role.includes("method") ? "method" : "sampling_quantity",
                expected_candidates: expectedCandidates(expectedRanges),
                writable_collection: "items",
                writable_item_key: item.key,
                writable_path: issuePath.replace(/^\/items\/\d+/u, "/draft/items/0"),
                patch_instruction: "错误路径的索引指向已保存集合；请将此 item_key 对应的完整记录放入 draft.items[0] 提交，保留其余字段。",
                required_action: role === "sampling_script"
                  ? "内联 explicit 抽样应选择所属条款完整的数量/抽样原句（可复用 quantity_span_ids），不能选择单独的检验方法行。真实检验方法保留在 fields.method。若抽样程序确实组合不同 evidence 记录，则声明 sampling_rules 组件，使用 reference 抽样，并清空内联数组。"
                  : `根据返回的候选，将此 span 替换为条款 ${ownerClause?.clause_id ?? "所属条款"} 中精确的 ${role.includes("method") ? "method" : "quantity"} 证据；保留其他正确字段`,
                preserve_fields: role === "sampling_script"
                  ? ["fields.method", "fields.requirement", "fields.quantity", "criterion_span_ids"]
                  : ["其他已正确绑定的字段", "适用条件与判据"],
                do_not: "禁止删除真实方法/数量事实、修改不可变证据或编译结果，或仅用 composition/reason 重新标注无关来源来绕过来源约束",
                next_tool: "stage_target_selector_draft",
              },
            });
          }
        }
      };

      checkBindings("method", item.fields.method.span_ids, `/items/${itemIndex}/fields/method/span_ids`, item.fields.method.composition);
      checkBindings("quantity", item.fields.quantity.span_ids, `/items/${itemIndex}/fields/quantity/span_ids`, item.fields.quantity.composition);
      if (item.table) {
        checkBindings(
          "table_inspection_method",
          item.table.properties.inspection_method_span_ids,
          `/items/${itemIndex}/table/properties/inspection_method_span_ids`,
          "verbatim",
        );
      }
      if (item.sampling.status === "explicit") {
        checkBindings("sampling_quantity", item.sampling.quantity_span_ids, `/items/${itemIndex}/sampling/quantity_span_ids`, "verbatim");
        checkBindings("sampling_script", item.sampling.script_span_ids, `/items/${itemIndex}/sampling/script_span_ids`, "verbatim");
      }
    });
    return issues;
  }

  private structuralIssues<T>(issues: readonly T[]): T[] {
    return issues.filter(issue => {
      if (!issue || typeof issue !== "object" || !isModelReviewIssue(issue)) return true;
      const record = issue as Record<string, unknown>;
      if (typeof record.code !== "string" || typeof record.path !== "string" || typeof record.message !== "string") return true;
      const [diagnostic] = classifySelectorIssues("selector-local", [{ ...record,
        code: record.code, path: record.path, message: record.message }]);
      const observation = selectorRepairIssueWithoutRepeatedDetails(
        actionableSelectorIssue({ ...record, ...diagnostic, owner: "model_review" }),
      );
      // Compiler collection and cached delivery must share the same identity.
      this.modelReviewObservations.set(sha256Json(observation), observation);
      return false;
    });
  }

  private async collectCompilerModelReview(issues: TargetSelectorCompileError["issues"]): Promise<void> {
    if (!issues.length) return;
    // Advisory status does not relax source isolation or the executable read route.
    const routed = await this.routeSelectorCompilerEvidenceReads(classifySelectorIssues("selector-local", issues));
    this.structuralIssues(coalesceSelectorIssueDiagnostics(routed));
  }

  private async selectorCompilerIssues(selectors: TargetSelectorPlan, includeFieldRoleReview = true, includeStrictBindings = false): Promise<unknown[]> {
    const [registry, state] = await Promise.all([
      this.workspace.readSourceSpanRegistry(),
      this.workspace.readState(),
    ]);
    const protocol = selectorProtocolOrDefault(state.selector_protocol);
    const tableStructurePath = join(this.workspace.root, "table-structure.json");
    const rawTableStructurePlan = await pathExists(tableStructurePath)
      ? await readJson<TableStructurePlan>(tableStructurePath)
      : undefined;
    const tableStructurePlan = rawTableStructurePlan
      ? await this.projectAccessibleTableStructurePlan(rawTableStructurePlan)
      : undefined;
    const access = await this.evidenceAccessSnapshot(false);
    const eligibleTableEvidenceIds = this.eligibleTableEvidenceIds(access.accessByEvidenceId);
    let compilerIssues: unknown[] = [];
    let compilerReviewIssues: TargetSelectorCompileError["issues"] = [];
    let compiled: PersistedSemanticSourcePlan | undefined;
    try {
      compiled = compileTargetSelectors(selectors, registry, this.evidence, {
        acceptedSourceLanguageReviews: (protocol.language_review_markers ?? []).flatMap((marker) => (
          marker.item_key ? [{ item_key: marker.item_key, name: marker.original_name }] : []
        )),
        acceptedVerdictNameReviews: (protocol.name_review_markers ?? []).flatMap((marker) => (
          marker.item_key ? [{ item_key: marker.item_key, name: marker.original_name }] : []
        )),
        ...(tableStructurePlan ? { tableStructurePlan } : {}),
        eligibleTableEvidenceIds,
        onModelReview: issues => { compilerReviewIssues = [...compilerReviewIssues, ...issues]; },
        validationBoundary: STRUCTURAL_VALIDATION_BOUNDARY,
      });
    } catch (error) {
      if (!(error instanceof TargetSelectorCompileError)) throw error;
      compilerIssues = await this.routeSelectorCompilerEvidenceReads(
        classifySelectorIssues("selector-local", error.issues),
      );
    }
    await this.collectCompilerModelReview(compilerReviewIssues);
    // Recheck declared relationships against the current draft. A successful
    // local save must not hide strict binding errors from an earlier check.
    // This is a readonly diagnostic projection: no preflight, counters, source
    // projection or validation receipt is produced here.
    if (includeStrictBindings && compiled) {
      const strict = validatePlanText(serializeCompiledWorkingPlan(compiled), this.evidence);
      const referenceIssues = strict.issues.filter(issue => /^\/(reference_resolutions|semantic_references)(\/|$)/u.test(issue.path ?? ""));
      compilerIssues.push(...await this.routeSelectorCompilerEvidenceReads(classifyStrictSelectorIssues(
        selectors, compiled, registry, referenceIssues, this.evidence,
        { canRegisterDocumentReferences: canRegisterReferenceLiteral(state) },
      )));
    }
    const fieldRoleIssues = (includeFieldRoleReview ? await this.targetFieldRoleIssues(selectors, registry) : [])
      .map((issue) => ({ ...(issue as Record<string, unknown>), owner: "selector_input_error" }));
    return coalesceSelectorIssueDiagnostics(this.structuralIssues([...compilerIssues, ...fieldRoleIssues]));
  }

  private async routeSelectorCompilerEvidenceReads(issues: readonly unknown[]): Promise<unknown[]> {
    const routeIssue = async (issue: unknown): Promise<unknown> => {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
      const record = issue as Record<string, unknown>;
      const sourceUnhandled = typeof record.code === "string" && isSourceDispositionRepairIssueCode(record.code);
      const compilerUnhandled = record.code === "compiler_unhandled_evidence";
      const referenceUnaccounted = record.code === "selector_resolved_reference_components_unaccounted";
      const originRelation = record.code === "reference_origin_relation";
      if (record.code === "selector_reference_component_item_mismatch" || sourceUnhandled || compilerUnhandled || originRelation || referenceUnaccounted) {
        const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
          ? record.details as Record<string, unknown>
          : {};
        const actual = details.actual && typeof details.actual === "object" && !Array.isArray(details.actual)
          ? details.actual as Record<string, unknown>
          : {};
        const spanIds = unique([
          ...(Array.isArray(details.uncovered_span_ids)
            ? details.uncovered_span_ids.filter((id): id is string => typeof id === "string")
            : []),
          ...(Array.isArray(actual.component_span_ids)
            ? actual.component_span_ids.filter((id): id is string => typeof id === "string")
            : []),
        ]);
        const registry = originRelation || sourceUnhandled || referenceUnaccounted
          ? undefined
          : await this.workspace.readSourceSpanRegistry();
        const evidenceIds = originRelation
          ? unique(Array.isArray(details.origin_evidence_ids) && details.origin_evidence_ids.length > 0
            ? details.origin_evidence_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
            : typeof details.origin_evidence_id === "string" && details.origin_evidence_id.length > 0
              ? [details.origin_evidence_id]
              : [])
          : sourceUnhandled || referenceUnaccounted
            ? unique(Array.isArray(details.evidence_ids)
              ? details.evidence_ids.filter((id): id is string => typeof id === "string") : [])
          : unique(spanIds.flatMap((spanId) => {
              const span = registry?.spans.find((candidate) => candidate.span_id === spanId);
              return span ? [span.evidence_id] : [];
            }));
        const evidenceById = new Map(this.evidence.evidence.map((entry) => [entry.evidence_id, entry]));
        const accessByEvidenceId = await this.evidenceAccessIndex(true);
        const sourceAccess = evidenceIds.flatMap((evidenceId) => {
          const evidence = evidenceById.get(evidenceId);
          if (!evidence) return [];
          const access = this.evidenceAccess(evidence, accessByEvidenceId);
          const toolArguments = access.access_mode === "direct"
            ? { evidence_id: evidenceId, cursor: 0 }
            : access.access_mode === "inline_reference"
              ? { target_key: access.target_key, cursor: 0, limit: 24 }
              : { target_key: access.target_key, ...(referenceUnaccounted ? { evidence_ids: [evidenceId] } : {}) };
          return [{
            evidence_id: evidenceId,
            ...access,
            next_tool: access.read_tool,
            tool_arguments: toolArguments,
            context_directory: evidenceContextDirectory(evidence, access),
          }];
        });
        if (sourceAccess.length === 0) return issue;
        if (originRelation && sourceAccess.length !== evidenceIds.length) return issue;
        const currentState = sourceUnhandled ? await this.workspace.readState() : undefined;
        const openedEvidenceIds = new Set(currentState?.opened_evidence_ids ?? []);
        const unreadSourceAccess = sourceUnhandled
          ? sourceAccess.filter((source) => !openedEvidenceIds.has(source.evidence_id))
          : sourceAccess;
        const alreadyReadEvidenceIds = sourceUnhandled
          ? evidenceIds.filter((evidenceId) => openedEvidenceIds.has(evidenceId))
          : [];
        const unreadEvidenceIds = sourceUnhandled
          ? evidenceIds.filter((evidenceId) => !openedEvidenceIds.has(evidenceId))
          : [];
        const nextSourceRead = unreadSourceAccess[0];
        const allSourcesRead = sourceUnhandled && !nextSourceRead;
        const currentSelectors = sourceUnhandled
          ? await readJson<TargetSelectorPlan>(this.workspace.workingSelectorPath)
          : undefined;
        const registeredReferenceRoutes = sourceUnhandled
          ? this.evidence.reference_occurrences
            .filter((occurrence) => occurrence.status === "resolved"
              && referenceOccurrenceOriginEvidenceIds(occurrence).some((id) => evidenceIds.includes(id)))
            .map((occurrence) => {
              const target = documentReferenceTargetReadIdentity(occurrence);
              const policy = currentState?.reference_analysis_modes?.[`target:${target.target_key}`]
                ?? referenceAnalysisPolicy(this.evidence, occurrence);
              const savedReferenceKeys = currentSelectors?.references
                .filter((reference) => reference.occurrence_id === occurrence.occurrence_id)
                .map((reference) => reference.key) ?? [];
              return {
                occurrence_id: occurrence.occurrence_id,
                origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
                origin_fields: occurrence.origin_fields,
                analysis_mode: policy.analysis_mode,
                target_fully_read: occurrence.target_evidence_ids.length > 0
                  && occurrence.target_evidence_ids.every((id) => openedEvidenceIds.has(id)),
                saved_reference_keys: savedReferenceKeys,
                ...(policy.analysis_mode === "inline" ? {
                  raw_reference: occurrence.raw_reference,
                  target_key: target.target_key,
                  target_locator: target.target_locator,
                  target_evidence_count: target.target_evidence_count,
                } : {}),
              };
            })
          : [];
        const missingResolvedReferenceRoutes = registeredReferenceRoutes.filter((route) =>
          route.saved_reference_keys.length === 0
        );
        const needsReferenceRoute = allSourcesRead && missingResolvedReferenceRoutes.length > 0;
        const needsReferenceTargetRead = needsReferenceRoute && missingResolvedReferenceRoutes.some((route) =>
          !route.target_fully_read
        );
        const actualFieldBindings = (details.actual as { author_field_bindings?: Array<{ item_key?: string }> } | undefined)?.author_field_bindings ?? [];
        const actualFieldKey = actualFieldBindings.find(binding => currentSelectors?.items.some(item => item.key === binding.item_key))?.item_key;
        const authorReadArguments = actualFieldKey ? { collection: "items", key: actualFieldKey }
          : { collection: "source_dispositions", evidence_ids: evidenceIds };
        const routedReadToolNames = new Set([
          "list_evidence_resources",
          "open_evidence",
          "read_document_reference_evidence",
          "read_reference_facts",
        ]);
        const candidateReadTools = Array.isArray(details.candidate_read_tools)
          ? details.candidate_read_tools.filter((tool): tool is string =>
              typeof tool === "string" && !routedReadToolNames.has(tool)
            )
          : [];
        const nextTools = Array.isArray(details.next_tools)
          ? details.next_tools.filter((tool): tool is string =>
              typeof tool === "string" && !routedReadToolNames.has(tool)
            )
          : [];
        const toolArgumentHints = details.tool_argument_hints
          && typeof details.tool_argument_hints === "object"
          && !Array.isArray(details.tool_argument_hints)
          ? details.tool_argument_hints as Record<string, unknown>
          : {};
        const {
          list_evidence_resources: _genericDirectory,
          open_evidence: _genericOpen,
          read_document_reference_evidence: _genericInline,
          read_reference_facts: _genericIsolated,
          locate_evidence_span: _genericLocate,
          ...nonRouteToolArgumentHints
        } = toolArgumentHints;
        const exactRouteToolArgumentHints: Record<string, unknown> = {};
        for (const readTool of unique(sourceAccess.map((access) => access.read_tool))) {
          const argumentsForTool = [...new Map(sourceAccess
            .filter((access) => access.read_tool === readTool)
            .map((access) => [canonicalize(access.tool_arguments), access.tool_arguments] as const))
            .values()];
          exactRouteToolArgumentHints[readTool] = argumentsForTool.length === 1
            ? argumentsForTool[0]
            : argumentsForTool;
        }
        const requiredReadTools = unique(sourceAccess.map((access) => access.read_tool));
        const openableEvidenceIds = unique(sourceAccess
          .filter((access) => access.open_evidence_allowed)
          .map((access) => access.evidence_id));
        const originHowToPass = typeof details.how_to_pass === "string"
          ? details.how_to_pass.replace("先用 open_evidence 核对 origin_evidence_ids 的原文，", "")
          : "再用 read_target_selectors 读取接收 item，并依据已读原文修复真实的字段来源或接收路由。";
        return {
          ...record,
          details: {
            ...details,
            ...(sourceUnhandled || originRelation || (referenceUnaccounted && !details.scope_review) ? {
              next_tool: nextSourceRead?.read_tool ?? (needsReferenceRoute ? "list_reference_occurrences" : "read_target_selectors"),
              next_tool_arguments: nextSourceRead?.tool_arguments ?? (needsReferenceRoute
                ? { cursor: 0, limit: 100 } : sourceUnhandled && allSourcesRead
                  ? authorReadArguments : { collection: "items" }),
              candidate_read_tool: nextSourceRead?.read_tool ?? (needsReferenceRoute ? "list_reference_occurrences" : "read_target_selectors"),
            } : {}),
            ...(sourceUnhandled ? {
              already_read_evidence_ids: alreadyReadEvidenceIds,
              unread_evidence_ids: unreadEvidenceIds,
              registered_reference_routes: registeredReferenceRoutes,
              missing_resolved_reference_routes: missingResolvedReferenceRoutes,
              ...(allSourcesRead && !needsReferenceRoute ? {
                repair_options: [
                  ...(Array.isArray(details.repair_options) ? details.repair_options : []),
                  { kind: "source_disposition", condition: "模型依据原文确认这些来源只作上下文或不适用",
                    writable_collection: "source_dispositions", writable_path: "/source_dispositions",
                    next_tool: "read_target_selectors", next_tool_arguments: { collection: "source_dispositions", evidence_ids: evidenceIds },
                    save_tool: "stage_target_selector_draft",
                    save_fields: ["draft.source_dispositions[].span_ids", "draft.source_dispositions[].disposition", "draft.source_dispositions[].reason"] },
                  { kind: "bind_source", condition: "模型依据原文确认这些来源含真实业务内容",
                    writable_collections: ["items", "sampling_rules", "references"],
                    writable_paths: ["/items", "/sampling_rules", "/references"],
                    next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" },
                    save_tool: "stage_target_selector_draft" },
                ],
                required_affected_evidence_ids: evidenceIds,
                save_tool_instruction: "由模型选择 repair_options 中符合原文的路线，读取现有完整记录后增量保存。修改必须实际承载或显式处置 required_affected_evidence_ids；修改无关 item 或仅改 reason 不会处理这些来源。save_target_investigation 只保存调查交接，不写入 selector 处置。",
              } : {}),
            } : {}),
            source_access: sourceAccess,
            openable_evidence_ids: openableEvidenceIds,
            candidate_read_tools: unique([...candidateReadTools, ...requiredReadTools,
              ...(needsReferenceRoute ? ["list_reference_occurrences"] : [])]),
            next_tools: unique([...nextTools, ...requiredReadTools,
              ...(needsReferenceRoute ? ["list_reference_occurrences"] : [])]),
            tool_argument_hints: {
              ...nonRouteToolArgumentHints,
              ...exactRouteToolArgumentHints,
            },
            how_to_pass: needsReferenceTargetRead
              ? "这些直接来源已有阅读回执，但 missing_resolved_reference_routes 中至少一个被引目标尚未完整读取。先用 next_tool_arguments 调用 list_reference_occurrences，按 occurrence_id 核对 target_key 与 analysis_mode；inline 用 read_document_reference_evidence 分页读完，isolated 用 read_reference_facts 按目录读取所需条目。读到原文后再判断本目标适用条件及真实验收字段，用 stage_target_selector_draft 保存有依据的 items/references；不得把另一 target 的 lot 或全部项目机械复制过来，也不得只读来源后重复提交未修改的草稿。"
              : needsReferenceRoute
              ? "这些来源已有完整阅读回执，且 missing_resolved_reference_routes 给出尚未暂存的已解析引用。先用 next_tool_arguments 调用 list_reference_occurrences，按 occurrence_id、原引用、target_key 和 analysis_mode 核对当前目标中的引用。依据已读原文逐项判断被引组件对当前目标是否适用：已有真实 item 可接收时补精确路由；缺少独立判断时，先用 stage_target_selector_draft 增量暂存完整、真实的 item，保留本地工法等适用条件，以已确认记录为暂存单位；完整输入结构不要求同一 occurrence 的全部组件同批确定。可先保存一条真实接收 item 和已确认组件的 reference 路由，其余组件继续调查，不补假处置。该保存不表示整个引用完成，未处理组件仍须后续全量校验；引用所属的另一 target 的 lot 或全部项目不可机械复制到当前目标，亦不可因现场工法尚未选定而抹去规范中有条件适用的分支。只有原文证明非业务或不适用时才能作对应处置；不能用空占位、只补锚点或重复提交未修改的草稿消错。"
              : sourceUnhandled && allSourcesRead
              ? `${actualFieldKey ? "这些来源已有完整阅读回执及 actual.author_field_bindings 中的已保存字段，但该绑定尚未兑现编译来源。先按 next_tool_arguments 读取该真实作者记录，按 saved_field_binding_instruction 核对已有 composition、item 来源和引用路由；不是要求再猜接收项或重存相同字段。" : "这些来源已有完整阅读回执，但仍未被实际承载或显式处置。先按 next_tool_arguments 核对现有 source_dispositions；这次读取不决定来源的业务角色。"}由模型依据原文选择 repair_options：确为当前目标上下文或不适用时，用 stage_target_selector_draft 增量保存 draft.source_dispositions 完整记录（span_ids、context/ignored disposition、原文理由）；仅组织范围可按 key 读取完整 lot 并保存精确 scope_span_ids，不能代替叶项条件、共同义务或判据；真实业务来源则读取可能接收的 items、sampling_rules 或 references 完整记录，补其实际适用字段绑定，或保存独立、完整且真实的记录。不得把真实判据降为上下文来消错。实际修改必须涉及 required_affected_evidence_ids；只改无关 item、重读原文或保存调查交接都不会处理这些来源。回条不指定项目、字段或处置值。可先完成一条并立即保存，不必等所有来源都处理完才保存；保留其他 keyed records，继续处理当前诊断组的其余待办。逐条保存不等于逐条重检：已知修复保存后，table/commit 可用 get_target_context({source_repair_cursor:0}) 只读刷新当前有限诊断；不为刷新列表执行完整阶段检查，有限诊断为空也不表示完整通过。完成已知修复后再重试原验证。若当前会话无法确认原文可按 source_access 复读，但不要仅重读后重复提交未修改的草稿。`
              : sourceUnhandled && alreadyReadEvidenceIds.length > 0 && typeof details.how_to_pass === "string"
                ? details.how_to_pass.replace(
                    "若有 source_access，严格按 source_access 中每项的 read_tool 和 tool_arguments 读取对应来源，",
                    "仅 unread_evidence_ids 需按 source_access 中对应项的 read_tool 和 tool_arguments 读取；already_read_evidence_ids 可按需复读，",
                  )
              : referenceUnaccounted ? details.scope_review ? details.how_to_pass
                : "先读取当前 reference，再按 source_access 的精确工具参数读取点名来源。isolated 的 evidence_ids 只定位目录行，跟随其 next_tool_arguments 取正文和 span；同次已返回的点名行可复用，无须返回整份目录开头。由模型判断实际适用性：适用内容绑定到真实 items、其实际选用的 sampling_rules 或真实字段的内联引用；不适用组件用已读 span 显式登记 not_applicable、item_keys=[] 和原文依据。组织范围可绑定 lots[].scope_span_ids，其他非项目上下文可按 source_dispositions 契约处置。用现有作者工具只保存相关可写记录，保留其他决定；不得猜造 span、笼统排除未读内容或删除正确项目来消错。"
              : sourceUnhandled ? details.how_to_pass
              : originRelation
                ? `先逐项按 source_access 的 read_tool 和 tool_arguments 核对 origin_evidence_ids 的原文；isolated_reference 必须通过 read_reference_facts 读取目录及选定条目，不得调用 open_evidence。${originHowToPass}`
                : "先用 read_target_selectors 读取当前 reference 和 actual.item_keys 中存在的 items，再按 occurrence_id 核对引用。然后严格按 source_access 逐项读取：每项只调用其 read_tool，并原样使用 tool_arguments；direct 使用 open_evidence，inline_reference 使用 read_document_reference_evidence，isolated_reference 不要调用 open_evidence，只能使用 read_reference_facts。由模型依据已读原文判断：item_keys 点名错误时只改接收者；点名正确时才补足该真实 item 的 provenance。最后只保存 writable_paths 中列出的 references/items 路径并重试验证；不得虚构 item、span 或业务归属。",
          },
        };
      }
      if (record.code !== "selector_display_field_span_role_conflict") return issue;
      const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : {};
      const actual = details.actual && typeof details.actual === "object" && !Array.isArray(details.actual)
        ? details.actual as Record<string, unknown>
        : {};
      const offending = actual.offending_binding && typeof actual.offending_binding === "object" && !Array.isArray(actual.offending_binding)
        ? actual.offending_binding as Record<string, unknown>
        : {};
      const evidenceId = typeof offending.evidence_id === "string" ? offending.evidence_id : "";
      if (!evidenceId) return issue;
      const isolated = await isolatedReferenceTargetForEvidence(
        this.workspace,
        this.evidence,
        evidenceId,
        "target",
      );
      if (!isolated) {
        const evidence = this.evidence.evidence.find((entry) => entry.evidence_id === evidenceId);
        const accessByEvidenceId = await this.evidenceAccessIndex(true);
        const access = evidence
          ? this.evidenceAccess(evidence, accessByEvidenceId)
          : { access_mode: "direct", read_tool: "open_evidence", open_evidence_allowed: true } as const;
        const inline = access.access_mode === "inline_reference";
        return {
          ...record,
          details: {
            ...details,
            source_access: {
              analysis_mode: inline ? "inline" : "normal",
              evidence_id: evidenceId,
              next_tool: "open_evidence",
              tool_arguments: { evidence_id: evidenceId, cursor: 0 },
              ...access,
            },
          },
        };
      }
      const candidateReadTools = Array.isArray(details.candidate_read_tools)
        ? details.candidate_read_tools.filter((tool): tool is string => typeof tool === "string" && tool !== "open_evidence")
        : [];
      const toolArgumentHints = details.tool_argument_hints && typeof details.tool_argument_hints === "object" && !Array.isArray(details.tool_argument_hints)
        ? details.tool_argument_hints as Record<string, unknown>
        : {};
      return {
        ...record,
        details: {
          ...details,
          source_access: {
            analysis_mode: "isolated",
            evidence_id: evidenceId,
            target_key: isolated.target_key,
            next_tool: "read_reference_facts",
            tool_arguments: { target_key: isolated.target_key },
            required_action: "read_catalog_then_open_selected_entries_before_locating_exact_spans",
            access_mode: "isolated_reference",
            read_tool: "read_reference_facts",
            open_evidence_allowed: false,
          },
          candidate_read_tools: unique([
            ...candidateReadTools,
            "read_reference_facts",
            "locate_evidence_span",
          ]),
          tool_argument_hints: {
            ...toolArgumentHints,
            read_reference_facts: { target_key: isolated.target_key },
          },
          how_to_pass: "先用 read_target_selectors 读取当前 item。当前 offending_binding 来自 isolated 引用；不得调用 open_evidence 绕过未读闸门。先只按 source_access.tool_arguments 传 target_key 调用 read_reference_facts 取得目录，再从目录复制模型确认需要的 entry_id 打开条目；只能对已读条目返回的 evidence_id 使用 locate_evidence_span。由模型依实际原文选择 method 和 quantity 的精确、不重合 span，只替换 affected_paths，用 stage_target_selector_draft 保存并重试验证；不要编造文本或猜测角色。",
        },
      };
    };
    const routed: unknown[] = [];
    for (const issue of issues) routed.push(await routeIssue(issue));
    return routed;
  }

  private async validateStagedSelectorRecords(
    selectors: TargetSelectorPlan,
    touchedRoots: readonly string[],
    previous?: TargetSelectorPlan,
  ): Promise<Record<string, unknown>> {
    const compilerIssues = await this.selectorCompilerIssues(selectors);
    const localCompilerIssues = compilerIssues
      .filter((issue) => issueTouchesSelectorRoots(issue, touchedRoots))
      .filter((issue) => {
        const entry = issue as { code?: string; path?: string };
        // Receiver linkage is a stage/commit obligation, not a malformed rule
        // record while the model is still authoring the receiving items.
        if (entry.code === "selector_sampling_rule_unreferenced"
          || entry.code === "selector_table_expansion_obligations_pending") return false;
        if (entry.code === "selector_sampling_decision_pending" && this.selectorStage === "primary") return false;
        if (entry.code === "selector_sampling_branch_quantity_missing") {
          const match = /^\/sampling_rules\/(\d+)\/branches\/(\d+)/.exec(entry.path ?? "");
          const rule = match ? selectors.sampling_rules[Number(match[1])] : undefined;
          const branch = rule && match ? rule.branches[Number(match[2])] : undefined;
          if (rule && branch && !selectors.items.some(item =>
            ["reference", "reference_unspecified_quantity"].includes(item.sampling.status)
            && item.sampling.rule_key === rule.key && item.sampling.branch_keys.includes(branch.key))) return false;
        }
        return true;
      });
    const localIssues = localCompilerIssues.map(issue => actionableSelectorIssue(issue, selectors));
    const deferredIssues = compilerIssues.filter(issue => !localCompilerIssues.includes(issue))
      .map(issue => actionableSelectorIssue(issue, selectors));
    const blockerAssessment = await this.saveLocalSelectorBlockerAssessment(localIssues, selectors);
    const recordFacts = (plan: TargetSelectorPlan, collection: string, key: string) => selectorAuthorFactsFingerprint({
      [collection]: ((plan as any)[collection] ?? []).filter((row: any) => row.key === key),
    } as TargetSelectorPlan);
    const priorityIds = previous ? selectorIssueProbes(selectorIssueToolDiagnostics(localIssues), selectors)
      .filter(probe => probe.bindings.some(binding => recordFacts(previous, binding.collection, binding.key)
        !== recordFacts(selectors, binding.collection, binding.key))).map(probe => probe.identity) : undefined;
    const navigation = (scope: string) => ({ tool: "get_target_context",
      arguments: { saved_diagnostic_scope: scope }, cursor_field: "saved_diagnostic_cursor" });
    await atomicWriteJson(join(this.workspace.root, "saved-selector-diagnostics.json"), {
      schema_version: "saved-selector-diagnostics/v1", job_id: this.workspace.jobId,
      target_id: this.workspace.targetId, revision: this.workspace.revision,
      contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION,
      inputs_fingerprint: await this.stageDiagnosticInputsFingerprint(),
      touched_paths: touchedRoots, local_issues: localIssues, deferred_issues: deferredIssues,
      ...(priorityIds ? { priority_issue_identities: priorityIds } : {}),
    });
    let page = selectorIssueToolPage(localIssues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, 0, navigation("local"));
    let deferredPage = selectorIssueToolPage(deferredIssues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, 0, navigation("deferred"));
    let savedDiagnosticPage: Record<string, unknown> | undefined;
    // Two individually bounded pages can still double a save's response. Keep
    // one complete repair in the receipt and page the exact remaining snapshot.
    if (Buffer.byteLength(JSON.stringify({ issues: page.issues, issue_page: page.page,
      deferred_issues: deferredPage.issues, deferred_issue_page: deferredPage.page }), "utf8") > SELECTOR_TOOL_ISSUE_PAGE_MAX_BYTES) {
      page = selectorIssueToolPage(localIssues, 1, 0, navigation("local"));
      deferredPage = selectorIssueToolPage(deferredIssues, 1, 0, navigation("deferred"));
      if (localIssues.length) deferredPage = { ...deferredPage, issues: [], summaries: [], page: {
        ...deferredPage.page, reported_issue_count: 0, remaining_issue_count: deferredPage.page.total_issue_count,
        reported_issue_utf8_bytes: 0, next_cursor: deferredIssues.length ? 0 : null,
        issue_index: deferredPage.page.issue_index.map(issue => ({ ...(issue as Record<string, unknown>), detail_in_page: false })),
      } };
      for (const diagnosticPage of [page, deferredPage]) {
        diagnosticPage.issues = diagnosticPage.issues.map(selectorRepairIssueWithoutRepeatedDetails);
        diagnosticPage.page.reported_issue_utf8_bytes = diagnosticPage.issues.reduce<number>((sum, issue) => sum + Buffer.byteLength(JSON.stringify(issue), "utf8"), 0);
      }
      const scope = page.page.next_cursor !== null ? "local" : "deferred";
      const cursor = scope === "local" ? page.page.next_cursor ?? 0 : deferredPage.page.next_cursor ?? 0;
      savedDiagnosticPage = { next_tool: "get_target_context", next_tool_arguments: {
        saved_diagnostic_scope: scope, saved_diagnostic_cursor: cursor,
      }, instruction: "本回条保留一条完整修法和有界索引，其余详情按此参数读取同一次保存的准确快照。detail_fields_at_issue_level 列出的重复详情完整保留在诊断顶层，可据此还原。读取不执行编译或阶段校验，不消耗校验次数；只读后仍须依据原文增量保存真实修复。输入改变后该快照失效，不要为翻页执行 advance 或重复未修改保存。" };
      for (const diagnosticPage of [page, deferredPage]) diagnosticPage.page.required_action = "使用 saved_diagnostic_page 的 get_target_context 参数读取剩余完整保存诊断，不使用 stage_diagnostic_cursor，不为翻页重新校验。";
    }
    return {
      ok: localIssues.length === 0,
      validation_scope: "touched_records",
      global_completeness_checked: false,
      checks_performed: ["selector_compilation", "field_source_roles"],
      strict_plan_validation_performed: false,
      count_note: "issue_count 和 deferred_nonlocal_issue_count 只统计本次编译与字段来源角色诊断，不是完整严格 plan 校验的剩余问题数；即使两者为 0，也没有检查严格引用导入授权、重复接收路由等约束。继续完成当前已知修复组，再按正常阶段或提交入口完整校验，不为刷新详情重检未改草稿。",
      touched_paths: touchedRoots,
      issue_count: localIssues.length,
      deferred_nonlocal_issue_count: Math.max(0, compilerIssues.length - localIssues.length),
      deferred_issues: deferredPage.issues,
      deferred_issue_page: deferredPage.page,
      ...(savedDiagnosticPage ? { saved_diagnostic_page: savedDiagnosticPage } : {}),
      issues: page.issues,
      issue_page: page.page,
      ...(blockerAssessment ? { blocker_assessment: blockerAssessment } : {}),
    };
  }

  private async validateSelectorStageCompleteness(
    selectors: TargetSelectorPlan,
    stage: TargetSelectorStage,
  ): Promise<{ ok: boolean; issues: unknown[]; globalCandidateComplete: boolean; preflight?: TargetSelectorPreflight }> {
    if (stage === "table" || stage === "commit") {
      const preflight = await this.evaluateTargetSelectorPreflight(selectors, false, false);
      return {
        ok: preflight.ok,
        issues: preflight.issues.map(issue => actionableSelectorIssue(issue, preflight.selectors)),
        globalCandidateComplete: preflight.ok,
        preflight,
      };
    }

    const issues: unknown[] = [];
    if (selectors.lots.length === 0) {
      issues.push(actionableSelectorIssue({
        code: "selector_primary_lot_required",
        path: "/lots",
        message: "primary 阶段至少需要一个检验批才能进入下一阶段。",
        details: { actual: 0, required_action: "stage_at_least_one_evidence_bound_lot" },
      }, selectors));
    }
    if (selectors.items.length === 0) {
      issues.push(actionableSelectorIssue({
        code: "selector_primary_item_required",
        path: "/items",
        message: "primary 阶段至少需要一个完整验收项才能进入下一阶段。",
        details: { actual: 0, required_action: "stage_at_least_one_complete_evidence_bound_item" },
      }, selectors));
    }
    const compilerIssues = await this.selectorCompilerIssues(selectors);
    issues.push(...compilerIssues.filter((issue) => issueBelongsToSelectorStage(issue, stage)).map(issue => actionableSelectorIssue(issue, selectors)));
    return { ok: issues.length === 0, issues, globalCandidateComplete: false };
  }

  private async advanceTargetSelectorStage(nextStage: string): Promise<ToolResponse> {
    const pending = await this.pendingSelectorRepairResponse();
    if (pending) return { ...pending, requested_next_stage: nextStage };
    const currentIndex = SELECTOR_STAGE_ORDER.indexOf(this.selectorStage);
    const expected = currentIndex >= 0 ? SELECTOR_STAGE_ORDER[currentIndex + 1] : undefined;
    if (!expected || nextStage !== expected) {
      return {
        ok: false,
        error: "invalid_selector_stage_transition",
        actual: { current_stage: this.selectorStage, requested_next_stage: nextStage },
        how_to_pass: expected
          ? `将工具参数 next_stage 精确填写为 ${expected}，然后重试同一工具。`
          : "当前已无合法的下一阶段；不要再次调用阶段推进工具。",
        writable_path: "next_stage",
        next_tool_arguments: expected ? { next_stage: expected } : undefined,
        do_not_edit: "已保存的选择器记录、编译生成的语义计划或不可变原文",
        next_tool: expected ? "advance_target_selector_stage" : null,
        instruction: "调用 advance_target_selector_stage 时只填写返回的 expected_next_stage；合法转换会先检查当前阶段完整性，再更新状态。",
        current_stage: this.selectorStage,
        expected_next_stage: expected ?? "none",
      };
    }
    const migration = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ));
    let selectors = migration.plan;
    const stageValidation = await this.validateSelectorStageCompleteness(selectors, this.selectorStage);
    if (!stageValidation.ok) {
      const terminal = terminalSelectorPreflightResponse(stageValidation.preflight);
      if (terminal) return terminal;
      if (!stageValidation.preflight) await this.saveSelectorDiagnostics(stageValidation.issues, selectors,
        { scope: `selector-stage:${this.selectorStage}`, completed_scopes: [] });
      const page = selectorIssueToolPage(stageValidation.issues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, 0,
        { tool: "get_target_context", arguments: {}, cursor_field: "stage_diagnostic_cursor" });
      const budget = await this.recordSelectorStageRetry(stageValidation);
      const nextDiagnosticCursor = page.page.reported_issue_count < page.page.total_issue_count ? page.page.reported_issue_count : null;
      const repairRoute = selectorRepairRoute(page.issues);
      const diagnosticNavigation = nextDiagnosticCursor === null ? null : {
        next_tool: "get_target_context", next_tool_arguments: { stage_diagnostic_cursor: nextDiagnosticCursor },
        tool_scope: budget.exhausted ? "recovered_revision_only" : "current_revision",
      };
      return {
        ok: false,
        terminal: budget.exhausted,
        failure_class: budget.exhausted ? PROTOCOL_TARGET_FAILURES.selector_stage_incomplete_retry?.failure_class : undefined,
        error: "selector_stage_incomplete",
        draft_status: "saved_stage_incomplete",
        stage_status: "incomplete",
        content_validation_performed: true,
        validation_scope: this.selectorStage === "table" ? "global_candidate" : "current_stage",
        global_candidate_complete: false,
        budget_consumed: false,
        budget_scope: "candidate_validation",
        full_stage_check_performed: true,
        stage_retry_accounting: {
          scope: "consecutive_non_improvements",
          consumed: !["initial", "improved"].includes(budget.progress),
          count: budget.count,
          limit: MAX_SELECTOR_PROTOCOL_FAILURES,
        },
        protocol_failure: budget.exhausted ? budget : undefined,
        stage_retry: budget,
        current_stage: this.selectorStage,
        requested_next_stage: expected,
        actual: { counts: targetSelectorCounts(selectors), issue_count: stageValidation.issues.length },
        how_to_pass: budget.exhausted
          ? `本阶段连续 ${budget.count} 次检查未优于最佳校验结果，本 revision 已终止。保留检查点，由后续恢复会话继续；不要在终止后的会话继续调用工具。`
          : `本阶段连续未改善检查计 ${budget.count}/${MAX_SELECTOR_PROTOCOL_FAILURES} 次；首次反馈、问题数减少或预检层级前进不计无进展重试。按每条问题的 next_tool 读取依据，通过 stage_target_selector_draft / stage_table_structure 保存修复，再重试本工具。局部保存成功或仅修改说明不代表阶段完整；以本工具重新校验的问题数和预检层级为准。`,
        ...(budget.exhausted ? {
          next_tool: null, next_tools: [], writable_paths: [],
          recovery_guidance: { ...repairRoute, next_diagnostic_page: diagnosticNavigation,
            tool_scope: "recovered_revision_only", budget_policy: "preserve_existing_counters",
            instruction: "这里只保存本次诊断的恢复线索，不授权当前会话继续调用工具。后续合法恢复必须先核对当前来源目录、作者记录和检查输入；旧句柄、路径和诊断不能直接当成当前状态。恢复不重置既有校验计数。",
          },
        } : repairRoute),
        do_not_edit: "编译生成的语义计划或不可变原文",
        selector_issues: page.issues,
        selector_issue_page: { ...page.page,
          required_action: budget.exhausted ? "stop_current_session_and_preserve_checkpoint"
            : "read_saved_stage_diagnostics_then_save_evidence_based_repairs_before_stage_check",
          index_instruction: budget.exhausted
            ? "本会话已终止，索引和剩余数量不授权继续读取。后续合法恢复先核对当前检查输入，再按 recovery_guidance.next_diagnostic_page 的历史诊断线索核对；不为翻页重检，也不能把旧诊断当作当前状态。"
            : "索引不代替原文或详细修复依据。用 next_diagnostic_page 只读翻页取得本次已执行检查的后续详情，不为翻页重新执行阶段检查；修改检查输入后原诊断会明确失效，不表示修复通过。",
        },
        next_diagnostic_page: budget.exhausted ? null : diagnosticNavigation,
        next_tool_scope: budget.exhausted ? "none" : "current_revision",
        diagnostic_action_scope: budget.exhausted ? "recovered_revision_only" : "current_revision",
        instruction: renderFeedback({ kind: budget.exhausted ? "terminal" : "phase_failed", terminal: budget.exhausted,
    constraint: "stage_retry_accounting给出原有计数与评分。budget_consumed=false仅指最终候选validation次数；聚合子行减少、保存调查或局部通过不保证优于完整最佳结果。" }),
      };
    }
    if (stageValidation.preflight) selectors = stageValidation.preflight.selectors;
    else await this.saveSelectorDiagnostics([], selectors,
      { scope: `selector-stage:${this.selectorStage}`, completed_scopes: [`selector-stage:${this.selectorStage}`] });
    this.selectorStage = expected;
    await this.workspace.updateState(state => {
      state.selector_stage = expected;
      if (state.selector_protocol) delete state.selector_protocol.stage_retries;
    });
    return {
      ok: true, stage: expected, draft_status: "stage_complete",
      stage_status: "complete",
      completed_stage: SELECTOR_STAGE_ORDER[currentIndex],
      content_validation_performed: true,
      validation_scope: SELECTOR_STAGE_ORDER[currentIndex] === "table" ? "global_candidate" : "current_stage",
      global_candidate_complete: stageValidation.globalCandidateComplete,
      budget_consumed: false,
      migration_issues: migration.issues,
      checkpoint: {
        draft_fingerprint: targetSelectorFingerprint(selectors),
        counts: { lots: selectors.lots.length, items: selectors.items.length, sampling_rules: selectors.sampling_rules.length, references: selectors.references.length, source_dispositions: selectors.source_dispositions.length },
      },
      instruction: renderFeedback({ kind: "phase_passed", constraint: expected === "commit"
    ? "table阶段完整预检已通过，使用本回条draft_fingerprint执行commit_target_selector_draft；正式验证通过后立即seal其返回的fingerprint。"
    : "仅刚完成阶段通过；从保存草稿继续下一实际阶段，不认定后续或完整候选已经通过。" }),
    };
  }

  get usesSelectorCompiler(): boolean {
    return Boolean(this.evidence.source.semantic_workflow);
  }

  async repairStatus(): Promise<ReturnType<typeof repairStateOrDefault>> {
    return repairStateOrDefault((await this.workspace.readState()).repair);
  }

  private async saveSelectorDiagnostics(issues: readonly unknown[], selectors: TargetSelectorPlan,
    assessment: { scope: string; completed_scopes: string[]; complete?: boolean }
      = { scope: "selector-diagnostics", completed_scopes: [] }): Promise<void> {
    const file = join(this.workspace.root, "selector-diagnostics.json");
    const previous = await pathExists(file) ? await readJson<any>(file) : undefined;
    const table = await this.readTableStructurePlan();
    const actionable = issues.map(issue => actionableSelectorIssue(issue, selectors));
    const visible = selectorIssueProbes(selectorIssueToolPage(actionable).issues, selectors);
    const observedIds = new Set([...visible.map(row => row.identity),
      ...(previous?.probes ?? []).map((row: SelectorIssueProbe) => row.identity)]);
    const current = selectorIssueProbes(selectorIssueToolDiagnostics(actionable), selectors)
      .filter(row => observedIds.has(row.identity))
      .map(row => ({ ...row, check_scope: assessment.scope }));
    const currentIds = new Set(current.map(row => row.identity));
    const covered = new Set(assessment.completed_scopes);
    // A short-circuiting prerequisite does not prove downstream obligations
    // resolved. Keep their observations dormant until that check runs again.
    const unassessed = previous?.source_sha256 === this.evidence.source.sha256 && !assessment.complete
      ? (previous.probes as SelectorIssueProbe[]).filter(row => !currentIds.has(row.identity)
        && (!row.check_scope || !covered.has(row.check_scope))).map(row => ({ ...row, assessed: false }))
      : [];
    await atomicWriteJson(file, {
      schema_version: "selector-diagnostics/v1", source_sha256: this.evidence.source.sha256,
      contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      table_fingerprint: sha256Json(table), draft_fingerprint: targetSelectorFingerprint(selectors),
      author_inputs_fingerprint: await this.currentAuthorDiagnosticInputs(),
      registry_fingerprint: sha256Json(await this.workspace.readSourceSpanRegistry()),
      issues: actionable,
      assessment_scope: assessment.scope, completed_scopes: assessment.completed_scopes,
      probes: [...current, ...unassessed],
      ...(previous?.source_sha256 === this.evidence.source.sha256 ? { convergence: previous.convergence } : {}),
    });
  }

  private async saveLocalSelectorBlockerAssessment(issues: readonly unknown[], selectors: TargetSelectorPlan) {
    const file = join(this.workspace.root, "selector-diagnostics.json");
    if (!(await pathExists(file))) return undefined;
    const saved = await readJson<any>(file);
    if (saved.source_sha256 !== this.evidence.source.sha256) return undefined;
    const fingerprint = targetSelectorFingerprint(selectors);
    const registryFingerprint = sha256Json(await this.workspace.readSourceSpanRegistry());
    const snapshotCurrent = saved.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
      && saved.draft_fingerprint === fingerprint
      && saved.registry_fingerprint === registryFingerprint
      && saved.evidence_fingerprint === this.evidence.evidence_fingerprint
      && saved.table_fingerprint === sha256Json(await this.readTableStructurePlan());
    const local = new Map(selectorIssueProbes(selectorIssueToolDiagnostics(issues), selectors)
      .map(probe => [probe.identity, probe]));
    let matched = 0;
    const probes = (saved.probes as SelectorIssueProbe[]).map(previous => {
      const current = local.get(previous.identity);
      if (current) {
        matched++;
        return { ...current, check_scope: previous.check_scope };
      }
      // Local validation may stop before a downstream check or omit untouched
      // records. Absence cannot prove closure or another unchanged failure.
      return snapshotCurrent ? previous : { ...previous, assessed: false };
    });
    const assessment = { validation_scope: "touched_records", draft_fingerprint: fingerprint,
      registry_fingerprint: registryFingerprint, evidence_fingerprint: this.evidence.evidence_fingerprint,
      matched_blocker_count: matched, unassessed_blocker_count: probes.filter(probe => probe.assessed === false).length };
    // Keep the global issue page and its freshness tokens intact. Only the
    // same diagnosed obligation's compiler-proven remaining units are updated.
    await atomicWriteJson(file, { ...saved, probes, local_blocker_assessment: assessment });
    return assessment;
  }

  async selectorBlockingIssues(): Promise<SelectorBlockerObservation[] | undefined> {
    const file = join(this.workspace.root, "selector-diagnostics.json");
    if (!(await pathExists(file))) return undefined;
    const saved = await readJson<any>(file);
    if (saved.source_sha256 !== this.evidence.source.sha256) return undefined;
    const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")));
    const [registry, state] = await Promise.all([this.workspace.readSourceSpanRegistry(), this.workspace.readState()]);
    const probes = (saved.probes as SelectorIssueProbe[]).map(probe =>
      saved.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION ? probe : { ...probe, assessed: false });
    return selectorBlockerObservations(probes, selectors, registry,
      new Set(state.opened_evidence_ids ?? []), state.opened_evidence_window_keys ?? []);
  }

  async recordSelectorBlockingProgress(before: readonly SelectorBlockerObservation[] | undefined,
    after: readonly SelectorBlockerObservation[] | undefined) {
    if (!before || !after) return undefined;
    const file = join(this.workspace.root, "selector-diagnostics.json");
    const saved = await readJson<any>(file);
    if (saved.contract_version !== SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION) return undefined;
    const result = observeSelectorBlockers(saved.convergence as SelectorBlockerHistory | undefined, before, after);
    await atomicWriteJson(file, { ...saved, convergence: result.history });
    await this.workspace.appendEvent("selector_blocker_convergence", {
      relevant_progress: result.progress, unchanged_blockers: result.history.blockers
        .filter(row => row.assessed !== false && row.unchanged_rounds > 0).map(row => ({ code: (saved.probes as SelectorIssueProbe[])
          .find(probe => probe.identity === row.identity)?.code, unchanged_rounds: row.unchanged_rounds })),
      stalled: result.stalled,
      unassessed_blocker_count: result.history.blockers.filter(row => row.assessed === false).length,
    });
    return result;
  }

  private selectorDiagnosticDependencyChanges(saved: Record<string, unknown>, current: Record<string, string>) {
    const descriptions: Record<string, string> = {
      source_sha256: "原文版本",
      draft_fingerprint: "作者草稿",
      evidence_fingerprint: "证据清单",
      registry_fingerprint: "来源片段登记",
      table_fingerprint: "表结构",
      contract_version: "诊断契约",
    };
    return Object.entries({ ...current, contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION })
      .filter(([dependency, value]) => saved[dependency] !== value)
      .map(([dependency, current_value]) => ({ dependency, description: descriptions[dependency] ?? dependency,
        snapshot_value: saved[dependency] ?? null, current_value }));
  }

  async selectorBlockingSummary(): Promise<string> {
    const file = join(this.workspace.root, "selector-diagnostics.json");
    if (!(await pathExists(file))) return "";
    const saved = await readJson<any>(file);
    const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")));
    const fingerprint = targetSelectorFingerprint(selectors);
    const [registry, table, state] = await Promise.all([
      this.workspace.readSourceSpanRegistry(), this.readTableStructurePlan(), this.workspace.readState(),
    ]);
    const staleDependencies = this.selectorDiagnosticDependencyChanges(saved, {
      source_sha256: this.evidence.source.sha256, draft_fingerprint: fingerprint,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      registry_fingerprint: sha256Json(registry), table_fingerprint: sha256Json(table),
    });
    const current = staleDependencies.length === 0;
    const diagnostics = current ? selectorIssueToolDiagnostics(saved.issues) : [];
    const diagnosticProbes = selectorIssueProbes(diagnostics, selectors);
    const index = current ? selectorIssueToolPage(saved.issues).page.issue_index as Array<{ index: number; issue_key: string }> : [];
    const probes = (saved.probes as SelectorIssueProbe[]).map(probe =>
      saved.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION ? probe : { ...probe, assessed: false });
    const observations = new Map(selectorBlockerObservations(probes, selectors, registry,
      new Set(state.opened_evidence_ids ?? []), state.opened_evidence_window_keys ?? []).map(row => [row.identity, row]));
    const unchanged = (saved.convergence?.blockers ?? []).filter((row: any) => {
      const observation = observations.get(row.identity);
      return row.unchanged_rounds > 0 && observation && observation.assessed !== false
        && (current || row.assessed !== false) && !selectorBlockerImproved(row, observation);
    }).sort((left: any, right: any) => right.unchanged_rounds - left.unchanged_rounds)
      .slice(0, 12).map((row: any) => {
        const probe = (saved.probes as SelectorIssueProbe[]).find(entry => entry.identity === row.identity);
        const cursor = diagnosticProbes.findIndex(entry => entry.identity === row.identity);
        const issueKey = index.find(entry => entry.index === cursor)?.issue_key;
        return { code: probe?.code, author_path: probe?.path, author_records: probe?.bindings,
          evidence_ids: probe?.evidence_ids.slice(0, 8), evidence_id_count: probe?.evidence_ids.length,
          remaining_unit_count: observations.get(row.identity)?.units?.length,
          unchanged_rounds: row.unchanged_rounds, history_only: true,
          ...(current && cursor >= 0 ? {
            next_tool: "read_target_selector_issues",
            next_tool_arguments: { draft_fingerprint: fingerprint, cursor, ...(issueKey ? { issue_key: issueKey } : {}) },
          } : { next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } }) };
      });
    const unassessed = probes.filter(row => row.assessed === false).length;
    return [unchanged.length ? `以下当前阻塞保留先前未收敛观察，尚未见单位减少或必要新来源工作：${JSON.stringify(unchanged)}。unchanged_rounds 是此前完成/换会话时的历史计数，本只读回条不新增轮次或判定停机；优先核对这些反复出现的问题的原因，而不是仅按新目录首条推进。使用精确工具参数读取完整回条，依据原文独立判断；来源 ID 和作者 key 不授权自动归属或替换。其他记录或理由的修改不等于这些问题已修复，不能为清计数强制保存。已读且判断明确的独立问题可在字节预算内同批保存，再作必要的完整验证。` : "",
      !current ? `问题快照已过期：${staleDependencies.map(row => row.description).join("、")}与快照不一致。草稿指纹相同也不表示诊断契约、来源或表结构依赖相同。actual=${JSON.stringify({ current_draft_fingerprint: fingerprint, snapshot_draft_fingerprint: saved.draft_fingerprint, stale_dependencies: staleDependencies })}。先调用 get_target_context({field_diagnostic_cursor:0}) 读取当前字段诊断，不复用旧 issue_key，不为刷新回条重交未改草稿；实质修复保存后再完整提交，历史计数保留。` : "",
      unassessed ? `${unassessed} 个先前阻塞尚未重新核验其闭合状态，本次预检没有覆盖该判断，原计数保留；它们暂未展示不等于已修复。先处理当前回条的前置问题，再作完整验证，不使用过期详情。` : ""].filter(Boolean).join("\n");
  }

  private async readTargetSelectorIssues(input: Record<string, unknown>): Promise<ToolResponse> {
    const file = join(this.workspace.root, "selector-diagnostics.json");
    const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")));
    const fingerprint = targetSelectorFingerprint(selectors);
    const saved = await pathExists(file) ? await readJson<any>(file) : undefined;
    const staleDependencies = saved ? this.selectorDiagnosticDependencyChanges(saved, {
      source_sha256: this.evidence.source.sha256, draft_fingerprint: fingerprint,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      registry_fingerprint: sha256Json(await this.workspace.readSourceSpanRegistry()),
      table_fingerprint: sha256Json(await this.readTableStructurePlan()),
    }) : [];
    if (!saved || staleDependencies.length) {
      return { ok: false, error: "selector_issue_snapshot_stale", validation_performed: false, budget_consumed: false,
        instruction: saved
          ? `问题快照已过期：${staleDependencies.map(row => row.description).join("、")}与快照不一致。草稿指纹相同也不能复用旧问题快照；先只读刷新当前字段诊断。`
          : "问题快照尚未创建；先按 next_tool_arguments 只读查看当前字段诊断。",
        actual: { requested_fingerprint: input.draft_fingerprint, current_draft_fingerprint: fingerprint,
          snapshot_fingerprint: saved?.draft_fingerprint ?? null,
          snapshot_status: saved ? "stale" : "missing", stale_dependencies: staleDependencies },
        how_to_pass: "按 next_tool_arguments 只读刷新当前字段诊断，依据新诊断读取并保存有根据的修复；不要为读取过期问题而提交未改草稿。完整提交时输入未变将复用预检。旧 issue_key 不能作为当前错误证据。",
        writable_paths: [], next_tool: "get_target_context",
        next_tool_arguments: { field_diagnostic_cursor: 0 },
        do_not_edit: "不可直接编辑问题快照、伪造草稿指纹或修改编译产物；不得为匹配旧快照撤销正确的来源绑定或表结构修订。" };
    }
    const all = selectorIssueToolPage(saved.issues).page.issue_index as Array<{ issue_key: string; index: number }>;
    const selected = typeof input.issue_key === "string" ? all.find(row => row.issue_key === input.issue_key) : undefined;
    if (input.draft_fingerprint !== fingerprint) return {
      ok: false, error: "selector_issue_request_fingerprint_mismatch", validation_performed: false, budget_consumed: false,
      instruction: renderFeedback({ kind: "fingerprint_request", constraint: "本次只读详情请求的draft_fingerprint与有效快照不符；使用返回的当前draft指纹重新读取，不重复预检。" }),
      actual: { requested_fingerprint: input.draft_fingerprint, current_draft_fingerprint: fingerprint,
        snapshot_fingerprint: saved.draft_fingerprint, snapshot_status: "current" },
      how_to_pass: "复制当前 draft_fingerprint 调用 read_target_selector_issues，无须重复预检。issue_key 已核对为当前快照的键时可直接重读；否则从当前目录重新选择。",
      writable_path: "/draft_fingerprint", next_tool: "read_target_selector_issues",
      next_tool_arguments: { draft_fingerprint: fingerprint,
        ...(selected ? { issue_key: selected.issue_key } : { cursor: 0 }) },
    };
    if (input.issue_key && !selected) return { ok: false, error: "selector_issue_key_unknown",
      instruction: "按当前问题目录的键或游标读取，不能复用其他快照的问题键。",
      actual: input.issue_key, writable_path: "/issue_key", next_tool: "read_target_selector_issues",
      next_tool_arguments: { draft_fingerprint: fingerprint, cursor: 0 },
      how_to_pass: "从当前 issue_index 复制 issue_key，或按 cursor 分页；不能用其他快照的问题键。" };
    const page = selectorIssueToolPage(saved.issues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, selected?.index ?? Number(input.cursor ?? 0));
    if (selected) {
      // Keyed reads deliver exactly one detail; their metadata must describe it.
      page.issues = page.issues.slice(0, 1);
      page.summaries = page.summaries.slice(0, 1);
      const nextCursor = selected.index + page.issues.length;
      page.page.reported_issue_count = page.issues.length;
      page.page.reported_issue_utf8_bytes = page.issues.reduce<number>((sum, issue) =>
        sum + Buffer.byteLength(JSON.stringify(issue ?? null), "utf8"), 0);
      page.page.remaining_issue_count = Math.max(0, page.page.total_issue_count - nextCursor);
      page.page.next_cursor = nextCursor < page.page.total_issue_count ? nextCursor : null;
      page.page.issue_index = page.page.issue_index.filter(entry =>
        (entry as { index: number }).index === selected.index);
      page.page.indexed_issue_count = page.page.issue_index.length;
      page.page.index_complete = page.page.indexed_issue_count === page.page.total_issue_count;
      page.page.index_instruction = "本次按 issue_key 只返回所选问题的完整详情和目录条目；其他问题未在本页展示。需要当前完整问题目录时，使用 selector_issue_index_read 的只读工具参数重取；需要后续详情时按 next_cursor 读取。保存改变草稿或来源后，先取得新完整预检快照。目录和详情读取不表示问题已修复。";
    }
    const revealed = selectorIssueProbes(page.issues, selectors)
      .map(row => ({ ...row, check_scope: saved.assessment_scope }));
    if ((await this.workspace.readState()).status === "working") {
      await atomicWriteJson(file, { ...saved, probes: [...new Map([
        ...(saved.probes as SelectorIssueProbe[]), ...revealed ].map(row => [row.identity, row])).values()] });
    }
    return { ok: true, draft_fingerprint: fingerprint, validation_performed: false, budget_consumed: false,
      selector_issues: page.issues, selector_issue_page: page.page,
      ...(input.detail_mode === "full" ? { diagnostic_detail_mode: "full" } : {}),
      ...(selected ? { selector_issue_index_read: { tool: "read_target_selector_issues",
        arguments: { draft_fingerprint: fingerprint, cursor: 0 }, readonly: true } } : {}),
      instruction: renderFeedback({ kind: "readonly_page", constraint: "按本页准确作者key与实际来源保存真实修复。输入改变后取得当前诊断；完成必要同组修复后再完整验证。" }) };
  }

  /**
   * `repair_restart` sessions consume the bounded repair restart budget;
   * `mechanical` sessions (interrupted tool-call retirement, source-handle
   * scope mismatch) only advance the session serial.
   */
  async beginFreshRepairSession(
    reason: "repair_restart" | "mechanical" | "protocol_migration",
  ): Promise<ReturnType<typeof repairStateOrDefault>> {
    return this.workspace.transactState((state) => {
      const repair = repairStateOrDefault(state.repair);
      repair.fresh_session_required = false;
      if (reason !== "protocol_migration") repair.non_converging_rounds = 0;
      repair.session_epoch += 1;
      if (reason === "repair_restart") repair.repair_session_restarts += 1;
      state.repair = repair;
      return structuredClone(repair);
    });
  }

  async beginCoverageRepair(
    planFingerprint: string,
  ): Promise<ReturnType<typeof repairStateOrDefault>> {
    const state = await this.workspace.readState();
    if (
      !planFingerprint
      || state.last_valid_fingerprint !== planFingerprint
      || state.last_valid_plan_sha256 === ""
    ) {
      throw new Error("Coverage repair must bind the current last-valid plan fingerprint");
    }
    const review = await readSealedCoverageReview(
      this.workspace,
      planFingerprint,
      this.evidence,
    );
    if (!review || review.status !== "repair" || review.findings.length === 0) {
      throw new Error("Coverage repair requires a sealed repair review with exact findings");
    }
    const semanticFindings = review.findings.filter((finding) => finding.finding_type === "semantic_coverage_gap");
    if (semanticFindings.length === 0) {
      throw new Error("Coverage repair requires at least one semantic_coverage_gap finding");
    }
    const findingEvidenceIds = [...new Set(semanticFindings.map((finding) => finding.evidence_id))]
      .sort();
    const affectedFinalItemIds = [...new Set(
      semanticFindings.flatMap((finding) => finding.affected_item_ids),
    )]
      .sort();
    const candidateValidation = validatePlanText(
      await readFile(this.workspace.lastValidPlanPath, "utf8"),
      this.evidence,
    );
    if (
      !candidateValidation.ok
      || !candidateValidation.plan
      || candidateValidation.fingerprint !== planFingerprint
    ) {
      throw new Error("Coverage repair last-valid plan no longer matches the sealed review fingerprint");
    }
    const candidatePlan = candidateValidation.plan;
    const finalOriginById = new Map(materialize(candidatePlan, this.evidence, planFingerprint).result.inspection_lots
      .flatMap((lot) => lot.items)
      .map((item) => [item.item_id, item.reference_origin_item_id || item.item_id]));
    const affectedItemIds = [...new Set(affectedFinalItemIds.map((itemId) => finalOriginById.get(itemId) ?? itemId))].sort();
    const repair = await this.workspace.transactState((current) => {
      if (current.last_valid_fingerprint !== planFingerprint) {
        throw new Error("Coverage repair fingerprint became stale before transition");
      }
      const previous = repairStateOrDefault(current.repair);
      const next = {
        ...repairStateOrDefault(undefined),
        mode: "repair" as const,
        repair_source: "coverage" as const,
        active_cluster: {
          key: `coverage:${planFingerprint}`,
          issue_count: semanticFindings.length,
          issue_fingerprint: sha256Json(semanticFindings),
          issue_codes: ["domain_coverage_repair_required"],
          item_ids: affectedItemIds,
        },
        total_issue_count: semanticFindings.length,
        validation_fingerprint: sha256Json(semanticFindings),
        coverage_review_fingerprint: planFingerprint,
        coverage_finding_ids: semanticFindings.map((finding) => finding.finding_id).sort(),
        coverage_evidence_ids: findingEvidenceIds,
        coverage_item_ids: affectedItemIds,
        session_epoch: previous.session_epoch + 1,
      };
      current.repair = next;
      current.selector_stage = "coverage_repair";
      current.last_valid_fingerprint = "";
      current.last_valid_plan_sha256 = "";
      return structuredClone(next);
    });
    this.selectorStage = "coverage_repair";
    Object.assign(this.evidence, await this.workspace.adoptReferenceObservations());
    await this.workspace.appendEvent("coverage_repair_started", {
      plan_fingerprint: planFingerprint,
      finding_ids: repair.coverage_finding_ids,
      evidence_ids: repair.coverage_evidence_ids,
      active_cluster: repair.active_cluster,
    });
    return repair;
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
    toolCallId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<ToolResponse> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    await this.workspace.appendEvent("tool_execution_start", {
      tool_call_id: toolCallId,
      tool_name: name,
      input,
    });
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    // Observations belong to this check; an already-aborted call changes no state.
    this.modelReviewObservations.clear();
    try {
      if (
        this.inheritedSelectorReadRequired
        && INHERITED_SELECTOR_READ_GATED_TOOLS.has(name)
      ) {
        const output: ToolResponse = {
          ok: false,
          error: "inherited_selector_read_required",
          current_selector_state: "inherited_existing",
          required_tool: "read_target_selectors",
          budget_consumed: false,
          instruction: "此 revision 已继承按 key 保存的选择器。在定位或暂存之前先调用 read_target_selectors，保留或增量修正已有记录，不要从空白重建。",
        };
        await this.workspace.appendEvent("tool_execution_end", {
          tool_call_id: toolCallId,
          tool_name: name,
          is_error: false,
          output,
        });
        return output;
      }
      let output: ToolResponse;
      switch (name) {
        case "get_plan_contract":
          output = {
            ok: true,
            target_scope: this.evidence.scope,
            contract: buildPlanContract(this.evidence),
            prompt_protocol_version: PROMPT_SUITE_VERSION,
            plan_authoring_protocol: LEGACY_PLAN_PROTOCOL,
            plan_json_schema: semanticSourcePlanJsonSchemaFor(this.evidence),
            schema_instruction: "plan_json_schema is authoritative for every object property, required field, enum, and array element shape. Empty arrays in contract.plan_template are starting values, not permission to guess or omit their item structure.",
          };
          break;
        case "list_table_fragments":
          output = await this.listTableFragments(input);
          break;
        case "read_table_summary":
          output = await this.readTableSummary(String(input.table_key ?? input.fragment_id ?? ""));
          break;
        case "read_table_rows":
          output = await this.readTableRows(
            String(input.table_key ?? input.fragment_id ?? ""),
            Number(input.cursor ?? 0),
            Number(input.limit ?? 24),
          );
          break;
        case "read_adjacent_source":
          output = await this.readAdjacentTableSource(
            String(input.fragment_id ?? ""),
            Number(input.before ?? 2),
            Number(input.after ?? 2),
          );
          break;
        case "read_saved_table_structure":
          output = await this.readSavedTableStructure();
          break;
        case "stage_table_structure":
          output = await this.stageTableStructure(input.table, input.remove_table_keys);
          break;
        case "list_sampling_rules":
          {
          const accessByEvidenceId = await this.evidenceAccessIndex(true);
          const page = boundedPage(
            this.evidence.evidence
              .filter((record) => record.role === "sampling_rule")
              .map((record) => evidenceResource(record, this.evidenceAccess(record, accessByEvidenceId))),
            input,
          );
          const navigationCandidates = samplingNavigationCandidates(this.evidence).map((candidate) => {
            const record = this.evidence.evidence.find((entry) => entry.evidence_id === candidate.evidence_id);
            if (!record) return candidate;
            const access = this.evidenceAccess(record, accessByEvidenceId);
            if (access.access_mode !== "isolated_reference") return { ...candidate, ...access,
              evidence_scope: record.evidence_scope, registered_dependency: Boolean(record.registered_dependency),
              registered_clause_id: record.clause_id ?? null,
              tool_arguments: access.access_mode === "direct" ? { evidence_id: record.evidence_id, cursor: 0 }
                : { target_key: access.target_key, cursor: 0 }, context_directory: evidenceContextDirectory(record, access) };
            return evidenceResource(record, access);
          });
          output = {
            ok: true,
            candidates: page.rows,
            navigation_candidates: navigationCandidates,
            governing_context_evidence_ids: this.evidence.scope.governing_context_evidence_ids ?? [],
            navigation_is_exhaustive: false,
            navigation_limit: 100,
            next_cursor: page.next_cursor,
            instruction: renderFeedback({ kind: "source_directory", constraint: "本页最多100条仅为抽样定位线索；已有明确适用且已读共同规则可复用。fallback前仍须完成本项及相关共同规定的有据判断；缺具体事实时按实际路由补读，不因空列表认定无规则，不逐叶重复已完成调查。" }),
          };
          }
          break;
        case "list_reference_occurrences":
          {
          const referenceState = await this.workspace.readState();
          const projectedPolicies = projectReferenceAnalysisPolicies(
            this.evidence,
            referenceState.reference_analysis_modes,
            "target",
          );
          const occurrenceRegistry = await this.workspace.readSourceSpanRegistry();
          const compositeCandidates = compositeReferenceReviewCandidates(this.evidence, occurrenceRegistry);
          const page = boundedPage(this.evidence.reference_occurrences.map((occurrence) => {
            const target = documentReferenceTargetReadIdentity(occurrence);
            const originKey = referenceOccurrenceOriginEvidenceIds(occurrence).join("\0");
            const sameOriginOccurrences = this.evidence.reference_occurrences.filter((entry) => (
              entry.status === "resolved"
              && referenceOccurrenceOriginEvidenceIds(entry).join("\0") === originKey
            ));
            const policy = referenceState.reference_analysis_modes?.[`target:${target.target_key}`]
              ?? projectedPolicies.get(target.target_key)
              ?? referenceAnalysisPolicy(this.evidence, occurrence);
            return {
              occurrence_id: occurrence.occurrence_id,
              raw_reference: occurrence.raw_reference,
              normalized_reference: occurrence.normalized_reference ?? occurrence.raw_reference,
              origin_evidence_id: occurrence.origin_evidence_id,
              origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
              origin_span_ids: referenceOccurrenceOriginSpanIds(occurrence),
              reference_literal_span_id: occurrence.reference_literal_span_id ?? "",
              reference_literal_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
              origin_fields: occurrence.origin_fields,
              target_key: target.target_key,
              analysis_mode: policy.analysis_mode,
              target_text_utf8_bytes: policy.target_text_utf8_bytes,
              estimated_compact_page_count: policy.estimated_compact_page_count,
              mode_reason: policy.mode_reason,
              target_locator: target.target_locator,
              target_evidence_count: target.target_evidence_count,
              target_fingerprint: target.target_fingerprint,
              required: occurrence.required,
              status: occurrence.status,
              depth: occurrence.depth,
              composite_review_candidate: compositeReferenceReviewCandidate(this.evidence, occurrenceRegistry, occurrence) ?? null,
              decomposition_review: {
                required: occurrence.status === "resolved",
                component_count: occurrence.target_evidence_ids.length,
                same_origin_occurrence_count: sameOriginOccurrences.length,
                same_origin_occurrence_ids: sameOriginOccurrences.map((entry) => entry.occurrence_id),
                same_origin_target_locators: sameOriginOccurrences.map((entry) => (
                  documentReferenceTargetReadIdentity(entry).target_locator
                )),
              },
            };
          }), input);
          const navigationPage = boundedPage(
            this.evidence.scope.reference_candidates ?? [],
            {
              cursor: input.candidate_cursor,
              limit: input.candidate_limit ?? 8,
            },
          );
          output = {
            ok: true,
            occurrences: page.rows,
            composite_review_candidates: compositeCandidates.slice(0, 20),
            composite_review_candidate_count: compositeCandidates.length,
            navigation_candidates: navigationPage.rows,
            navigation_candidate_count: this.evidence.scope.reference_candidates?.length ?? 0,
            next_navigation_candidate_cursor: navigationPage.next_cursor,
            next_cursor: page.next_cursor,
            instruction: "这是已登记引用 occurrence 的紧凑、不可变清单。先按 raw_reference、origin_evidence_id/origin_span_ids 与 origin_fields 核对原引用文字、位置和字段，匹配同一 occurrence 后复用其 occurrence_id 和 target_key，不为取得读取编号重复解析同一引用。对 status=resolved 且有实际目标来源的行，analysis_mode=inline 时调用 read_document_reference_evidence，analysis_mode=isolated 时调用 read_reference_facts；首读只传该行实际 target_key，直接使用当前回条的短句柄，所属目标由程序绑定，后续按读取回条分页或选择隔离目录条目。未解析或已按 literal_only 处理的引用，不因存在 target_key 就获得正文读取权限，继续其现有解析或仅保留原引文流程。读到来源后，再路由到保留该来源证据的业务字段；同一 origin 的多个目标还必须逐组件填写 component_dispositions，引用闭合不等于语义分解完成。target_fingerprint 相同表示共享同一目标 inventory，只读一次，分别保留各 occurrence 的来源与接收决定。",
          };
          if (page.next_cursor === null) this.inheritedReferenceLedgerRead = true;
          }
          break;
        case "open_evidence":
          output = await this.openEvidence(
            String(input.evidence_id ?? ""),
            Number(input.cursor ?? 0),
          );
          break;
        case "get_target_context":
          output = await this.targetContext(input);
          {
            const delivery = referenceCatalogDeliveryWork(await this.workspace.readState());
            if (delivery) output = { ...output, current_work: delivery, ...selectorWorkNextStep(delivery),
              instruction: delivery.instruction };
          }
          break;
        case "save_target_investigation": {
          const ids = Array.isArray(input.evidence_ids) ? input.evidence_ids : [];
          const knownIds = new Set(this.evidence.evidence.map(record => record.evidence_id));
          const unknownIds = unique(ids.filter((id): id is string => typeof id === "string" && !knownIds.has(id)));
          const unopenedIds = unique(ids.filter((id): id is string => typeof id === "string" && knownIds.has(id) && !this.openedEvidenceIds.has(id)));
          const shapeIssues = [
            ...(typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 3000 ? [{ path: "/summary", expected: "非空字符串，最多 3000 字" }] : []),
            ...(!Array.isArray(input.evidence_ids) || ids.length > 24 || ids.some(id => typeof id !== "string") ? [{ path: "/evidence_ids", expected: INVESTIGATION_KEY_SOURCE_GUIDANCE }] : []),
            ...(typeof input.next_steps !== "string" || input.next_steps.length > 1500 ? [{ path: "/next_steps", expected: "字符串，最多 1500 字" }] : []),
          ];
          if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 3000
            || !Array.isArray(input.evidence_ids) || ids.length > 24
            || ids.some(id => typeof id !== "string" || !this.openedEvidenceIds.has(id))
            || typeof input.next_steps !== "string" || input.next_steps.length > 1500) {
            output = {
              ok: false, error: "invalid_investigation_checkpoint", durable_mutation: false,
              actual: { evidence_ids: ids, evidence_id_count: ids.length, summary_length: String(input.summary ?? "").length, next_steps_length: String(input.next_steps ?? "").length },
              shape_issues: shapeIssues, unknown_evidence_ids: unknownIds, unopened_evidence_ids: unopenedIds,
              writable_path: shapeIssues[0]?.path ?? (unknownIds.length ? "/evidence_ids" : null),
              next_tool: shapeIssues.length ? "save_target_investigation" : unknownIds.length ? "list_evidence_resources" : "batch_open_evidence",
              ...(!shapeIssues.length && !unknownIds.length ? { tool_arguments: { evidence_ids: unopenedIds } } : {}),
              instruction: shapeIssues.length
                ? `按 shape_issues 修正对应参数；未保存，旧交接不变。${INVESTIGATION_KEY_SOURCE_GUIDANCE}完整调查结论和待办仍保留在 summary、next_steps。`
                : unknownIds.length
                ? "unknown_evidence_ids 不属于当前证据目录；先 list_evidence_resources 核对真实 ID，不得猜测。保留原调查内容，用真实来源替换后重试保存。"
                : "仅 unopened_evidence_ids 缺少完整阅读回执。保留原调查内容，先按 tool_arguments 调用 batch_open_evidence；继续处理 remaining_evidence_ids，并按各证据的 next_cursor 用 open_evidence 读完剩余窗口，然后重试相同 save_target_investigation 参数。不需要修改 selector；调查交接不代表语义批准。",
              do_not_edit: "不可变原文、编译产物及与本次阅读无关的正确 selector",
            };
            break;
          }
          await atomicWriteJson(join(this.workspace.root, "investigation-checkpoint.json"), {
            evidence_fingerprint: this.evidence.evidence_fingerprint,
            reference_tool_contract_fingerprint: await referenceToolImplementationFingerprint(),
            summary: input.summary, evidence_ids: ids, next_steps: input.next_steps,
          });
          output = { ok: true, terminal: false, selector_mutation: false, full_stage_check_performed: false,
            instruction: renderFeedback({ kind: "investigation_saved", constraint: "恢复时get_target_context可取交接；继续按next_steps处理具体缺事实并保存真实selector。" }) };
          break;
        }
        case "list_evidence_resources":
          output = await this.listEvidenceResources(input);
          break;
        case "save_target_component_plan":
          output = await this.saveTargetComponentPlan(input);
          break;
        case "search_global_document_resources":
          output = await this.searchGlobalDocumentResources(String(input.query ?? ""));
          break;
        case "list_global_document_resources":
          output = await this.listGlobalDocumentResources(input);
          break;
        case "open_global_document_resource":
          output = await this.openGlobalDocumentResource(String(input.atom_id ?? ""));
          break;
        case "open_adjacent_document_resource":
          output = await this.openAdjacentDocumentResource(
            String(input.atom_id ?? ""),
            String(input.direction ?? ""),
          );
          break;
        case "register_external_dependency":
          output = await this.registerExternalDependency(
            String(input.atom_id ?? ""),
            String(input.mode ?? ""),
            String(input.reason ?? ""),
          );
          break;
        case "read_document_reference_evidence":
          output = await readInlineReferenceEvidencePage(
            this.workspace,
            this.evidence,
            String(input.target_key ?? ""),
            Number(input.cursor ?? 0),
            Number(input.limit ?? 24),
          ) as ToolResponse;
          if (output.ok === true && Array.isArray(output.rows)) {
            // Inline pages expose complete records, not catalog previews. Only
            // the returned page earns receipts; unread pages remain unopened.
            const openedUnits = output.rows.flatMap((row) => {
              if (!row || typeof row !== "object" || Array.isArray(row)) return [];
              const entry = row as Record<string, unknown>;
              const record = this.evidence.evidence.find(candidate => candidate.evidence_id === entry.evidence_id);
              return record && entry.text === record.text
                ? splitTextWindows(record.text).map(window => ({ record, window })) : [];
            });
            if (openedUnits.length) await this.markEvidenceWindowsOpened(openedUnits);
          }
          break;
        case "read_reference_facts":
          output = await readAnalyzedReferenceCatalog(
            this.workspace,
            this.evidence,
            String(input.target_key ?? ""),
            {
              evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids.map(String) : undefined,
              entry_ids: Array.isArray(input.entry_ids) ? input.entry_ids.map(String) : undefined,
            row_cursor: input.row_cursor as number | undefined, row_offset: input.row_offset as number | undefined, catalog_cursor: input.catalog_cursor as number | undefined,
              skip: Array.isArray(input.skip)
                ? input.skip.flatMap((entry) => {
                    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
                    const record = entry as Record<string, unknown>;
                    return [{ entry_id: String(record.entry_id ?? ""), reason: String(record.reason ?? "") }];
                  })
                : undefined,
              skip_rest: input.skip_rest !== null && typeof input.skip_rest === "object" && !Array.isArray(input.skip_rest)
                ? { reason: String((input.skip_rest as Record<string, unknown>).reason ?? "") }
                : undefined,
              resolve_rows: Array.isArray(input.resolve_rows)
                ? input.resolve_rows.flatMap((entry) => {
                    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
                    const record = entry as Record<string, unknown>;
                    return [{ entry_id: String(record.entry_id ?? ""), row_index: Number(record.row_index ?? 0) }];
                  })
                : undefined,
            },
            "target",
            this.referenceCatalogRuleAsk,
            signal,
          ) as ToolResponse;
          if (output.ok === true && Array.isArray(output.resolved_rows)) {
            // Only explicitly selected rows from already opened catalog entries
            // earn read receipts. A catalog listing or skipped entry earns none.
            const ids = output.resolved_rows.flatMap((row) => {
              if (!row || typeof row !== "object" || Array.isArray(row)) return [];
              const record = row as Record<string, unknown>;
              return typeof record.evidence_id === "string" && typeof record.span_id === "string"
                ? [record.evidence_id] : [];
            });
            if (ids.length) await this.markEvidenceWindowsOpened(
              this.evidence.evidence.filter(record => ids.includes(record.evidence_id))
                .flatMap(record => splitTextWindows(record.text).map(window => ({ record, window }))),
              signal,
            );
          }
          break;
        case "resolve_external_standard_reference":
          output = await registerExternalStandardReference(this.workspace, this.evidence, input, false, this.externalSourceWorkflow) as ToolResponse;
          break;
        case "resolve_document_reference":
          {
            const target = input.target && typeof input.target === "object" && !Array.isArray(input.target)
              ? input.target as Record<string, unknown>
              : {};
            const originSpanIds = Array.isArray(input.origin_span_ids) ? input.origin_span_ids.map(String) : [String(input.origin_span_id ?? "")];
            const registry = await this.workspace.readSourceSpanRegistry();
            const originIds = new Set(registry.spans.filter(span => originSpanIds.includes(span.span_id)).map(span => span.evidence_id));
            const parents = this.evidence.reference_occurrences.filter(occurrence => occurrence.status === "resolved"
              && occurrence.external_standard?.markdown_sha256 && occurrence.target_evidence_ids.some(id => originIds.has(id)));
            const hashes = new Set(parents.map(parent => parent.external_standard!.markdown_sha256));
            if (hashes.size > 1 || (parents.length && [...originIds].some(id => !parents.some(parent => parent.target_evidence_ids.includes(id))))) {
              output = { ok: false, error: "reference_origin_crosses_documents", instruction: "重新选择同一份资料中的准确引用来源，不得跨文档拼接一个引用。", actual: { origin_span_ids: originSpanIds },
                how_to_pass: "同一个引用的有序 origin spans 必须来自同一份资料；按当前真实原文重新选择。", writable_paths: ["/origin_span_ids"], next_tool: "locate_evidence_span", budget_consumed: false };
              break;
            }
            const parentSource = parents[0]?.external_standard;
            const externalDocument = parentSource && this.externalSourceWorkflow ? await this.externalSourceWorkflow.lookup(parentSource.standard_no) : undefined;
            if (parentSource && (!externalDocument || externalDocument.markdown_sha256 !== parentSource.markdown_sha256)) {
              output = { ok: false, error: "reference_origin_document_unavailable", instruction: "引用属于已登记的外部文档；恢复该文档的正确版本和指纹，不得用主文档同号条款代替。", actual: { source: parentSource },
                how_to_pass: "恢复引用来源所属文档的正确版本和指纹，不能在主文档中寻找同号条款代替。", writable_paths: [], next_action: "add_external_source_file", budget_consumed: false };
              break;
            }
            output = await resolveAndRegisterDocumentReference(
              this.workspace,
              this.evidence,
              {
                ...(typeof input.origin_span_id === "string" ? { origin_span_id: input.origin_span_id } : {}),
                ...(Array.isArray(input.origin_span_ids) ? { origin_span_ids: input.origin_span_ids.map(String) } : {}),
                origin_field: (typeof input.origin_field === "string"
                  ? input.origin_field
                  : "requirement") as "name" | "requirement" | "method" | "quantity" | "note" | "sampling",
                ...(typeof input.reference_literal_span_id === "string"
                  ? { reference_literal_span_id: input.reference_literal_span_id }
                  : {}),
                ...(Array.isArray(input.reference_literal_span_ids)
                  ? { reference_literal_span_ids: input.reference_literal_span_ids.map(String) }
                  : {}),
                raw_reference: String(input.raw_reference ?? ""),
                ...(typeof input.normalized_reference === "string" ? { normalized_reference: input.normalized_reference } : {}),
                target: {
                  ...(typeof target.source_id === "string" ? { source_id: target.source_id } : {}),
                  kind: String(target.kind ?? "") as DocumentReferenceKind,
                  number: String(target.number ?? ""),
                  ...(typeof target.paragraph === "string" ? { paragraph: target.paragraph } : {}),
                  ...(typeof target.candidate_start_line === "number"
                    ? { candidate_start_line: target.candidate_start_line }
                    : {}),
                },
                relation: String(input.relation ?? ""),
                ...(typeof input.replaces_occurrence_id === "string" ? { replaces_occurrence_id: input.replaces_occurrence_id } : {}),
                ...(typeof input.correction_reason === "string" ? { correction_reason: input.correction_reason } : {}),
              },
              false,
              externalDocument,
            ) as ToolResponse;
            if (output.error === "origin_span_does_not_contain_raw_reference") {
              const actual = output.actual as { origin_span: { evidence_id: string } };
              const evidenceId = actual.origin_span.evidence_id;
              const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, evidenceId, "target");
              const readTool = isolated ? "read_reference_facts" : "open_evidence";
              output = {
                ...output,
                next_tool: readTool,
                next_tool_arguments: isolated ? { target_key: isolated.target_key } : { evidence_id: evidenceId, cursor: 0 },
                next_tools: [readTool, "locate_evidence_span", "resolve_document_reference", "list_global_document_resources"],
                context_investigation_tools: [{ name: "list_global_document_resources", arguments: { cursor: 0, limit: 20 } }],
                instruction: `${output.instruction} 用 next_tool_arguments 按来源访问策略复读；确有引用片段时用 locate_evidence_span 登记精确 span。调查无编号的共同规则时，先用 list_global_document_resources 分页目录，再按目录返回的读取工具打开原文；确需同文档范围外依赖时按 register_external_dependency 既有流程登记，再精确定位和绑定。不以目录、邻接或编号搜索本身证明适用，不重试相同的无匹配调用。`,
              };
            }
            if (output.error === "target_not_found" && this.externalSourceWorkflow) {
              output = { ...output,
                required_tools: [...new Set([...(Array.isArray(output.required_tools) ? output.required_tools.map(String) : []), "resolve_external_standard_reference"])],
                instruction: String(output.instruction ?? "") + " 若原文明示的上位依据确认来自外部标准，用 resolve_external_standard_reference 按真实标准号和精确来源登记；正文依赖缺失会等待补充文件。已有资料时重新解析并读取正文，不能仅用旧占位或旧调查交接判断其仍缺失。",
              };
            }
            if (output.ok === true) {
              const occurrence = this.evidence.reference_occurrences.find((entry) => entry.occurrence_id === output.occurrence_id);
              if (occurrence) {
                const policy = await assignReferenceAnalysisPolicy(this.workspace, this.evidence, occurrence);
                output = { ...output, ...policy, analysis_status: "not_required" };
              }
            }
          }
          break;
        case "batch_open_evidence":
          output = await this.batchOpenEvidence(input.evidence_ids);
          break;
        case "search_evidence":
          output = await this.searchEvidence(String(input.query ?? ""));
          break;
        case "batch_search_evidence":
          output = await this.batchSearchEvidence(input.queries);
          break;
        case "read_working_plan":
          output = await this.readWorkingPlan();
          break;
        case "get_target_selector_contract":
          output = await this.targetSelectorContract();
          break;
        case "locate_evidence_span":
          output = await this.locateEvidenceSpan(
            String(input.evidence_id ?? ""),
            String(input.quote ?? ""),
            String(input.prefix ?? ""),
            String(input.suffix ?? ""),
          );
          break;
        case "batch_locate_evidence_spans":
          output = await this.batchLocateEvidenceSpans(input.requests);
          break;
        case "read_target_selectors":
          output = await this.readTargetSelectors(input);
          break;
        case "read_target_selector_issues":
          output = await this.readTargetSelectorIssues(input);
          break;
        case "replace_target_selectors":
          output = await this.replaceTargetSelectors(String(input.content ?? ""));
          break;
        case "submit_target_selectors":
          output = await this.submitTargetSelectorTransaction(String(input.content ?? ""), false);
          break;
        case "correct_target_selectors":
          output = await this.submitTargetSelectorTransaction(String(input.content ?? ""), true);
          break;
        case "patch_target_selectors":
          output = await this.patchTargetSelectors(input.operations as JsonPatchOperation[]);
          break;
        case "compile_target_selectors":
          output = await this.compileWorkingSelectors();
          break;
        case "stage_target_selector_draft":
          output = await this.stageTargetSelectorDraft(input as TargetSelectorDraftPatch);
          output = { ...output, mutation_receipt: output.mutation_receipt ?? selectorPatchReceipt(input, output.ok === true ? "saved" : "not_applied") };
          if (output.ok === true) this.selectorBlockerRepairRequired = false;
          break;
        case "stage_reference_component_decisions":
          output = await this.stageReferenceComponentDecisions(input);
          if (output.ok === true) this.selectorBlockerRepairRequired = false;
          break;
        case "advance_target_selector_stage":
          output = await this.advanceTargetSelectorStage(String(input.next_stage ?? ""));
          break;
        case "commit_target_selector_draft":
          output = await this.commitTargetSelectorDraft(String(input.draft_fingerprint ?? ""));
          break;
        case "report_target_blocker":
          output = await this.reportTargetBlocker(input);
          break;
        case "read_coverage_review":
          output = await this.readCoverageReview();
          break;
        case "prepare_field_bindings":
          if (this.preparedBindingsSinceCheckpoint >= 4) {
            output = {
              ok: false,
              error: "incremental_checkpoint_required",
              prepared_bindings_since_checkpoint: this.preparedBindingsSinceCheckpoint,
              instruction: "继续准备其他绑定前，先用有界的 patch_working_plan 调用保存已准备项目。",
            };
          } else {
            output = this.prepareFieldBindings(input.fields);
            if (output.ok) {
              this.preparedBindingsSinceCheckpoint += 1;
              output = {
                ...output,
                prepared_bindings_since_checkpoint: this.preparedBindingsSinceCheckpoint,
                checkpoint_required: this.preparedBindingsSinceCheckpoint >= 4,
              };
            }
          }
          break;
        case "replace_working_plan":
          output = this.preparedBindingsSinceCheckpoint > 0
            ? {
                ok: false,
                error: "incremental_checkpoint_required_before_replace",
                prepared_bindings_since_checkpoint: this.preparedBindingsSinceCheckpoint,
                instruction: "用 patch_working_plan 保存已准备项目，不得替换整个计划。",
              }
            : await this.replaceWorkingPlan(String(input.content ?? ""));
          break;
        case "patch_working_plan":
          output = await this.patchWorkingPlan(input.operations as JsonPatchOperation[]);
          if (output.ok) this.preparedBindingsSinceCheckpoint = 0;
          break;
        case "reconcile_evidence_dispositions":
          output = await this.reconcileEvidenceDispositions(input.decisions);
          break;
        case "apply_table_assembly":
          output = await this.applyTableAssembly();
          break;
        case "validate_working_plan":
          output = await this.validateWorkingPlan();
          break;
        case "seal_validated_plan":
          output = await this.sealValidatedPlan(String(input.fingerprint ?? ""));
          break;
        default:
          output = toolReject({
            error: "unknown_target_tool",
            instruction: "请使用 get_plan_contract 或 get_target_selector_contract 列出的工具，不得编造工具名。",
            actual_tool: name,
            candidate_read_tool: "get_plan_contract",
          });
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      output = await this.withTableHeadingContext(name, output);
      if (this.usesSelectorCompiler && output.ok && !output.terminal
        && ["open_evidence", "batch_open_evidence", "read_table_rows"].includes(name)) {
        const work = await this.selectorExecutionWork();
        if (work && "advisory_only" in work && work.advisory_only
          && "source_delivery" in work && work.source_delivery?.current_execution_complete) {
          output = { ...output, current_work: work };
          // Paging the rest of a table remains available, but the source just
          // requested is now ready for an author's decision, not another read.
          if (output.next_tool) {
            output.supporting_read = { tool: output.next_tool, arguments: output.next_tool_arguments ?? {} };
            delete output.next_tool; delete output.next_tool_arguments;
          }
        }
      }
      if (["commit_target_selector_draft", "advance_target_selector_stage"].includes(name)
        && Array.isArray(output.selector_issues)) {
        const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")));
        const cursor = (output.selector_issue_page as { next_cursor?: number } | undefined)?.next_cursor ?? 0;
        output = { ...output, issue_details_read: output.error === "selector_repair_required"
          ? (output.selector_repair_work as { diagnostic_read: unknown }).diagnostic_read
          : name === "advance_target_selector_stage"
          ? { tool: "get_target_context", arguments: { stage_diagnostic_cursor: cursor } }
          : { tool: "read_target_selector_issues", arguments: { draft_fingerprint: targetSelectorFingerprint(selectors), cursor } } };
      }
      if (!output.terminal && output.error !== "selector_repair_required" && Array.isArray(output.selector_issues)
        && ["commit_target_selector_draft", "advance_target_selector_stage", "read_target_selector_issues"].includes(name)) {
        const handoff = await this.selectorBlockingSummary();
        const handoffSha = sha256Text(handoff);
        const repeated = name === "read_target_selector_issues" && input.include_blocker_handoff !== true
          && handoffSha === this.deliveredSelectorBlockerHandoffSha;
        const withHandoff = repeated ? { ...output, selector_blocker_handoff_ref: {
          sha256: handoffSha,
          full_read: { tool: "read_target_selector_issues", arguments: {
            draft_fingerprint: output.draft_fingerprint, cursor: 0, include_blocker_handoff: true,
          } },
          instruction: "完整历史交接与本控制器先前已返回的同 SHA 内容相同；当前问题详情仍完整保留。需要全文时按 full_read 重取，不重新预检、不新增失败轮次，也不表示任何问题已闭合。",
        } } : { ...output, selector_blocker_handoff: handoff };
        if (handoff && Buffer.byteLength(JSON.stringify(withHandoff), "utf8") <= MAX_PATCH_SERIALIZED_BYTES) {
          output = withHandoff;
          if (!repeated) this.deliveredSelectorBlockerHandoffSha = handoffSha;
        }
      }
      if (this.usesSelectorCompiler && this.modelReviewObservations.size && !output.model_review) {
        output = { ...output, model_review: { blocking: false, decision_owner: "model",
          observations: [...this.modelReviewObservations.values()],
          instruction: renderFeedback({ kind: "model_review" }) } };
      }
      output = await pageDiagnosticResponse(compactSourceReadRoutes(output), async () => ({
        root: this.workspace.root, job_id: this.workspace.jobId, target_id: this.workspace.targetId,
        revision: this.workspace.revision, inputs_fingerprint: await this.stageDiagnosticInputsFingerprint(),
      }));
      output = prioritizeWorkRoutes(output) as ToolResponse;
      await this.workspace.appendEvent("tool_execution_end", {
        tool_call_id: toolCallId,
        tool_name: name,
        is_error: false,
        output,
      });
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      return output;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const output = catchToolReject(error, "target_tool_rejected");
      await this.workspace.appendEvent("tool_execution_end", {
        tool_call_id: toolCallId,
        tool_name: name,
        is_error: false,
        output,
      });
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      return output;
    }
  }

  private async readTableStructurePlan(): Promise<TableStructurePlan> {
    const path = join(this.workspace.root, "table-structure.json");
    const initial = initialTableStructurePlan(this.evidence, await this.workspace.readSourceSpanRegistry());
    if (!(await pathExists(path))) return initial;
    const saved = await readJson<TableStructurePlan>(path);
    // Newly registered reference tables must be readable in this session too.
    // Never overwrite an author's existing grouping or confirmation.
    const owned = new Set(saved.tables.flatMap(table => table.fragment_ids));
    const keys = new Set(saved.tables.map(table => table.table_key));
    const added = initial.tables.filter(table => !keys.has(table.table_key)
      && table.fragment_ids.every(id => !owned.has(id)));
    return added.length ? { ...saved, tables: [...saved.tables, ...added] } : saved;
  }

  private tableFragmentEvidenceIds(
    fragment: EvidenceManifest["table_fragments"][number],
  ): string[] {
    return unique([
      ...fragment.title_candidate_evidence_ids,
      ...(fragment.continuation_caption_evidence_ids ?? []),
      ...fragment.header_evidence_ids,
      ...fragment.row_evidence_ids,
      ...fragment.formal_row_evidence_ids,
    ]);
  }

  private tableEvidenceIdsForFragments(fragmentIds: readonly string[]): string[] {
    const selected = new Set(fragmentIds);
    const fragments = [
      ...this.evidence.table_fragments,
      ...(this.evidence.scope.table_navigation_candidates ?? []),
    ].filter((fragment) => selected.has(fragment.fragment_id));
    return unique(fragments.flatMap((fragment) => this.tableFragmentEvidenceIds(fragment)));
  }

  private isolatedTargetKeysForEvidenceIds(
    evidenceIds: readonly string[],
    isolatedTargetKeysByEvidenceId: ReadonlyMap<string, ReadonlySet<string>>,
  ): string[] {
    return unique(evidenceIds.flatMap((evidenceId) => [
      ...(isolatedTargetKeysByEvidenceId.get(evidenceId) ?? []),
    ])).sort();
  }

  private selectorTableAuthoring() {
    return {
      writable_paths: ["/items/*/table"],
      navigation_key_required: false,
      read_tool: "read_reference_facts",
      save_tool: "stage_target_selector_draft",
      instruction: SELECTOR_TABLE_KEY_GUIDANCE,
    };
  }

  private async authorizeTableEvidenceIds(evidenceIds: readonly string[]): Promise<{
    accessByEvidenceId: Map<string, EvidenceAccessMetadata>;
    blocked?: ToolResponse;
  }> {
    const access = await this.evidenceAccessSnapshot(false);
    const targetKeys = this.isolatedTargetKeysForEvidenceIds(
      evidenceIds,
      access.isolatedTargetKeysByEvidenceId,
    );
    if (targetKeys.length === 0) return { accessByEvidenceId: access.accessByEvidenceId };
    return {
      accessByEvidenceId: access.accessByEvidenceId,
      blocked: {
        ok: false,
        error: "table_fragment_isolated_reference",
        selector_table_authoring: this.selectorTableAuthoring(),
        analysis_mode: "isolated",
        target_keys: targetKeys,
        read_tool: "read_reference_facts",
        next_tool: "read_reference_facts",
        next_tools: ["read_reference_facts", "read_target_selectors", "stage_target_selector_draft"],
        tool_arguments: targetKeys.map((target_key) => ({ target_key })),
        save_tool: "stage_target_selector_draft",
        durable_mutation: false,
        budget_consumed: false,
        instruction: "该表格读取会把同一 fragment 的成员关系、结构或正文作为一个整体返回，无法在不泄漏受隔离成员数量与位置的前提下安全裁剪。请逐个使用 target_keys 调用 read_reference_facts；读取完成也不会开放隐藏 table-structure 的写权限。如需把已读引用事实绑定到真实 item，随后用 read_target_selectors 读取当前 item，再用 stage_target_selector_draft 保存作者选择器；同 fragment 中未受保护的 evidence 仍可按自身 access_mode 单独读取。",
      },
    };
  }

  private async projectAccessibleTableStructurePlan(
    plan: TableStructurePlan,
  ): Promise<TableStructurePlan> {
    const access = await this.evidenceAccessSnapshot(false);
    const registry = await this.workspace.readSourceSpanRegistry();
    const evidenceIdBySpanId = new Map(registry.spans.map((span) => [span.span_id, span.evidence_id]));
    const isAccessibleEvidence = (evidenceId: string | undefined) => !evidenceId
      || this.isolatedTargetKeysForEvidenceIds(
        [evidenceId],
        access.isolatedTargetKeysByEvidenceId,
      ).length === 0;
    const isAccessibleFragment = (fragmentId: string) => this.isolatedTargetKeysForEvidenceIds(
      this.tableEvidenceIdsForFragments([fragmentId]),
      access.isolatedTargetKeysByEvidenceId,
    ).length === 0;
    let changed = false;
    const tables = plan.tables.flatMap((table) => {
      const fragmentIds = table.fragment_ids.filter(isAccessibleFragment);
      if (fragmentIds.length === 0) {
        changed = true;
        return [];
      }
      const accessibleMemberEvidenceIds = new Set(this.tableEvidenceIdsForFragments(fragmentIds));
      const removedMemberEvidenceIds = new Set(this.tableEvidenceIdsForFragments(
        table.fragment_ids.filter((fragmentId) => !fragmentIds.includes(fragmentId)),
      ));
      const isAccessibleMemberEvidence = (evidenceId: string | undefined) => !!evidenceId
        && isAccessibleEvidence(evidenceId)
        && (
          accessibleMemberEvidenceIds.has(evidenceId)
          || !removedMemberEvidenceIds.has(evidenceId)
        );
      const filterMemberEvidenceIds = (ids: readonly string[]) => ids.filter((id) =>
        isAccessibleMemberEvidence(id)
      );
      const filterMemberSpanIds = (ids: readonly string[]) => ids.filter((id) =>
        isAccessibleMemberEvidence(evidenceIdBySpanId.get(id))
      );
      const accessProjected: TableStructureDecision = {
        ...table,
        fragment_ids: fragmentIds,
        formal_title_span_ids: filterMemberSpanIds(table.formal_title_span_ids),
        header_rows: filterMemberEvidenceIds(table.header_rows),
        data_rows: filterMemberEvidenceIds(table.data_rows),
        repeated_header_rows: filterMemberEvidenceIds(table.repeated_header_rows),
        note_rows: filterMemberEvidenceIds(table.note_rows),
        context_rows: filterMemberEvidenceIds(table.context_rows),
        review_rows: filterMemberEvidenceIds(table.review_rows),
        row_role_overrides: table.row_role_overrides.filter((override) =>
          isAccessibleMemberEvidence(override.row_id)
        ),
        continuation_caption_span_ids: filterMemberSpanIds(table.continuation_caption_span_ids),
        note_span_ids: filterMemberSpanIds(table.note_span_ids),
      };
      const projectionChanged = JSON.stringify(accessProjected) !== JSON.stringify(table);
      const projected = projectionChanged
        ? {
            ...accessProjected,
            reason: "",
            row_role_overrides: accessProjected.row_role_overrides.map((override) => ({
              ...override,
              reason: "",
            })),
          }
        : accessProjected;
      if (projectionChanged) changed = true;
      return [projected];
    });
    return changed ? { ...plan, tables } : plan;
  }

  private async listTableFragments(input: Record<string, unknown>): Promise<ToolResponse> {
    const authoritativeFragmentIds = new Set(this.evidence.table_fragments.map((fragment) => fragment.fragment_id));
    const fragments = [...new Map([
      ...this.evidence.table_fragments,
      ...(this.evidence.scope.table_navigation_candidates ?? []),
    ].map((fragment) => [fragment.fragment_id, fragment])).values()];
    const access = await this.evidenceAccessSnapshot(false);
    const isolatedTargetKeys = new Set<string>();
    const visibleFragments = fragments.flatMap((fragment) => {
      const targetKeys = this.isolatedTargetKeysForEvidenceIds(
        this.tableFragmentEvidenceIds(fragment),
        access.isolatedTargetKeysByEvidenceId,
      );
      if (targetKeys.length > 0) {
        targetKeys.forEach((targetKey) => isolatedTargetKeys.add(targetKey));
        return [];
      }
      return [{
        fragment_id: fragment.fragment_id,
        source_order: fragment.source_order,
        locator: fragment.locator,
        provisional_table_id: fragment.provisional_table_id,
        provisional_title: fragment.provisional_title,
        title_candidate_evidence_ids: fragment.title_candidate_evidence_ids,
        continuation_caption_evidence_ids: fragment.continuation_caption_evidence_ids ?? [],
        header_evidence_ids: fragment.header_evidence_ids,
        row_evidence_ids: fragment.row_evidence_ids,
        formal_row_evidence_ids: fragment.formal_row_evidence_ids,
        navigation_only: !authoritativeFragmentIds.has(fragment.fragment_id),
        title_candidates: fragment.title_candidate_evidence_ids.flatMap((evidenceId) => {
          const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
          return record ? [{ evidence_id: evidenceId, text: record.text, role: record.role }] : [];
        }),
        headers: fragment.header_evidence_ids.flatMap((evidenceId) => {
          const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
          return record ? [evidenceResource(
            record,
            this.evidenceAccess(record, access.accessByEvidenceId),
          )] : [];
        }),
      }];
    });
    const sortedTargetKeys = [...isolatedTargetKeys].sort();
    const page = boundedPage([
      ...visibleFragments,
      ...(sortedTargetKeys.length > 0 ? [{
        access_mode: "isolated_reference",
        read_tool: "read_reference_facts",
        open_table_fragment_allowed: false,
        target_keys: sortedTargetKeys,
      }] : []),
    ], input);
    const obligationRegistry = await this.workspace.readSourceSpanRegistry();
    const obligationSelectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    )).plan;
    const expansion = tableExpansionState(
      this.evidence,
      obligationRegistry,
      obligationSelectors,
      await this.projectAccessibleTableStructurePlan(await this.readTableStructurePlan()),
      this.eligibleTableEvidenceIds(access.accessByEvidenceId),
    );
    return {
      ok: true,
      fragments: page.rows,
      selector_table_authoring: this.selectorTableAuthoring(),
      table_expansion_work_packages: expansion.work_packages,
      table_expansion_issue_count: expansion.issues.length,
      next_cursor: page.next_cursor,
      instruction: sortedTargetKeys.length > 0
        ? "安全 fragment 仍按目录读取；isolated_reference 项只给出不含成员、数量、位置或正文的路由。逐个使用 target_keys 调用 read_reference_facts。隔离表的 expansion 结构已隐藏。"
        : "物理边界和临时 ID 仅是导航元数据，不能绑定为标题原文。每个逻辑表只继承一次唯一正式标题候选；续表题注只保留为连续性来源记录。 table_expansion_work_packages 是硬义务：每个数据语义行必须映射到 item、同一核心属性的 branch，或有证据理由的 context；不同 core property 不能合并成一个大 item。",
    };
  }

  private async readSavedTableStructure(): Promise<ToolResponse> {
    const plan = await this.projectAccessibleTableStructurePlan(await this.readTableStructurePlan());
    const authorization = await this.authorizeTableEvidenceIds(
      this.tableEvidenceIdsForFragments(plan.tables.flatMap((table) => table.fragment_ids)),
    );
    if (authorization.blocked) return authorization.blocked;
    const registry = await this.workspace.readSourceSpanRegistry();
    const issues = validateTableStructurePlan(plan, this.evidence, registry);
    const { evidence_fingerprint: _privateEvidenceFingerprint, ...publicStructure } = plan;
    return {
      ok: true,
      structure: publicStructure,
      issues,
      pending_complex_tables: pendingComplexTableStructureIssues(plan, this.evidence),
      instruction: renderFeedback({ kind: "table_structure", constraint: "已确认fragment与行角色可复用，只核对review_rows、新冲突及必要来源。" }),
    };
  }

  private async readTableSummary(tableKeyOrFragmentId: string): Promise<ToolResponse> {
    const rawPlan = await this.readTableStructurePlan();
    const plan = await this.projectAccessibleTableStructurePlan(rawPlan);
    const table = plan.tables.find((candidate) =>
      candidate.table_key === tableKeyOrFragmentId
      || candidate.fragment_ids.includes(tableKeyOrFragmentId)
    );
    if (!table) {
      const inaccessibleTable = rawPlan.tables.find((candidate) =>
        candidate.table_key === tableKeyOrFragmentId
        || candidate.fragment_ids.includes(tableKeyOrFragmentId)
      );
      if (inaccessibleTable) {
        const authorization = await this.authorizeTableEvidenceIds(
          this.tableEvidenceIdsForFragments(inaccessibleTable.fragment_ids),
        );
        if (authorization.blocked) return authorization.blocked;
      }
      return {
        ok: false,
        error: "unknown_table_key_or_fragment",
        selector_table_authoring: this.selectorTableAuthoring(),
        actual: tableKeyOrFragmentId,
        how_to_pass: "从 list_table_fragments 或 read_saved_table_structure 复制 table_key/fragment_id。",
        writable_path: "table_key",
        next_tool: "list_table_fragments",
        instruction: "未知逻辑表；先读取当前表格目录并复制稳定键。",
      };
    }
    const authorization = await this.authorizeTableEvidenceIds(
      this.tableEvidenceIdsForFragments(table.fragment_ids),
    );
    if (authorization.blocked) return authorization.blocked;
    const registry = await this.workspace.readSourceSpanRegistry();
    const allCaptionIds = unique(table.fragment_ids.flatMap((fragmentId) => {
      const fragment = this.evidence.table_fragments.find((candidate) => candidate.fragment_id === fragmentId);
      return fragment ? [...fragment.title_candidate_evidence_ids, ...(fragment.continuation_caption_evidence_ids ?? [])] : [];
    }));
    const titleCandidateIds = allCaptionIds.filter((evidenceId) => {
      const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      return record?.role === "formal_table_title" && !/^\s*续表/u.test(record.text);
    });
    const continuationCaptionIds = allCaptionIds.filter((evidenceId) =>
      /^\s*续表/u.test(this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId)?.text ?? "")
    );
    const titleCandidates = titleCandidateIds.flatMap((evidenceId) => {
      const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      if (!record) return [];
      const span = registry.spans.find((candidate) =>
        candidate.evidence_id === evidenceId && candidate.start === 0 && candidate.end === record.text.length
      );
      return [{ evidence_id: evidenceId, role: record.role, text: record.text, span_id: span?.span_id ?? "" }];
    });
    const titleSourceStatus = titleCandidates.length ? "registered_candidates" : "no_registered_candidate";
    const rows = unique(table.fragment_ids.flatMap((fragmentId) =>
      this.evidence.table_fragments.find((fragment) => fragment.fragment_id === fragmentId)?.row_evidence_ids ?? []
    )).flatMap((evidenceId) => {
      const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      return record ? [record] : [];
    });
    // These captions are returned in full below. Directory-only row IDs and
    // inferred structural roles must not become evidence-reading receipts.
    await this.markEvidenceWindowsOpened(unique([...titleCandidateIds, ...continuationCaptionIds]).flatMap(evidenceId => {
      const record = this.evidence.evidence.find(candidate => candidate.evidence_id === evidenceId);
      return record ? splitTextWindows(record.text).map(window => ({ record, window })) : [];
    }));
    return {
      ok: true,
      table_key: table.table_key,
      source_version: plan.source_version,
      fragment_ids: table.fragment_ids,
      title_candidates: titleCandidates,
      title_source_status: titleSourceStatus,
      title_source_guidance: titleCandidates.length
        ? "从登记候选中选择正式表题的完整 span；不得改写或拼造。"
        : "解析器没有登记题注候选。这不代表表格必然无标题：请读取相邻来源，由你判断是否存在表题；若存在，只能选择同一不可变来源原子中完整非表格段落的精确 span；若确实无题名则保持为空，禁止臆造。",
      title_next_tool: titleCandidates.length ? "stage_table_structure" : "read_adjacent_source",
      title_next_tool_arguments: titleCandidates.length ? { table_key: table.table_key } : { fragment_id: table.fragment_ids[0] ?? "" },
      continuation_captions: continuationCaptionIds.flatMap((evidenceId) => {
        const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
        const span = record ? registry.spans.find((candidate) => candidate.evidence_id === evidenceId && candidate.start === 0 && candidate.end === record.text.length) : undefined;
        return record ? [{ evidence_id: evidenceId, text: record.text, role: record.role, span_id: span?.span_id ?? "" }] : [];
      }),
      row_count: rows.length,
      row_kind_hints: rows.reduce<Record<string, number>>((counts, row) => {
        const hint = row.role === "formal_table_header" ? "header_candidate"
          : row.table_row_kind === "data" ? "data_candidate" : "context_candidate";
        counts[hint] = (counts[hint] ?? 0) + 1;
        return counts;
      }, {}),
      saved_decision: table,
      program_hint_warning: "program_hint/title_candidate/header_candidate 仅用于导航，不是最终语义。禁止仅凭第一行、粗体、列数或关键词确认；续表题注只证明连续性，不是第二正式表名。",
      next_tool: table.review_rows.length ? "read_table_rows" : "read_saved_table_structure",
    };
  }

  private async withTableHeadingContext(name: string, output: ToolResponse): Promise<ToolResponse> {
    if (!output.ok || !["open_evidence", "batch_open_evidence", "read_table_rows",
      "read_document_reference_evidence", "read_reference_facts"].includes(name)) return output;
    const entries = [output.resource, ...((output.rows ?? []) as unknown[]),
      ...((output.resolved_rows ?? []) as unknown[]), ...((output.opened ?? []) as unknown[])]
      .filter((row): row is Record<string, any> => Boolean(row) && typeof row === "object");
    const ids = new Set(entries.map(row => row.evidence_id ?? row.row_id ?? row.resource?.evidence_id));
    const records = this.evidence.evidence.filter(record => record.kind === "table_row" && ids.has(record.evidence_id));
    if (!records.length) return output;
    this.tableHeadingLookup ??= createTableHeadingLookup(await readFile(this.workspace.sourceMarkdownPath, "utf8"));
    const access = await this.evidenceAccessIndex(false);
    const headings = new Map<string, EvidenceRecord>();
    const rows: Array<{ evidence_id: string; heading_evidence_ids: string[] }> = [];
    let result = output;
    for (const record of records) {
      const candidates = this.tableHeadingLookup(record, this.evidence.evidence)
        .filter(heading => heading.text.length <= 400 && this.evidenceAccess(heading, access).access_mode !== "isolated_reference");
      if (!candidates.length) continue;
      const next = new Map(headings);
      candidates.forEach(heading => next.set(heading.evidence_id, heading));
      const nextRows = [...rows, { evidence_id: record.evidence_id, heading_evidence_ids: candidates.map(heading => heading.evidence_id) }];
      const candidate = { ...output, table_heading_context: {
        relationship: "preceding_source_headings", bounded_context: true, decision_owner: "model", category_assigned: false,
        headings: [...next.values()].map(heading => ({ evidence_id: heading.evidence_id, locator: heading.locator,
          text: heading.text, text_sha256: heading.text_sha256 })),
        rows: nextRows,
        instruction: "这些是各表格行原文位置之前最近四个标题中可公开的已登记原文，按行号关联；不自动判定层级、类别或适用性。由模型结合表题、正文与上位分组确定类别。缺少标题不代表原文未标明类别；需要时按来源路由继续调查。",
      } };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_PATCH_SERIALIZED_BYTES) break;
      candidates.forEach(heading => headings.set(heading.evidence_id, heading));
      rows.push(nextRows.at(-1)!);
      result = candidate;
    }
    if (headings.size) await this.markEvidenceWindowsOpened([...headings.values()].map(record =>
      ({ record, window: { start: 0, end: record.text.length } })));
    return result;
  }

  private async readTableRows(tableKeyOrFragmentId: string, cursor: number, requestedLimit: number): Promise<ToolResponse> {
    const rawPlan = await this.readTableStructurePlan();
    const plan = await this.projectAccessibleTableStructurePlan(rawPlan);
    const table = plan.tables.find((candidate) =>
      candidate.table_key === tableKeyOrFragmentId
      || candidate.fragment_ids.includes(tableKeyOrFragmentId)
    );
    if (!table) {
      const inaccessibleTable = rawPlan.tables.find((candidate) =>
        candidate.table_key === tableKeyOrFragmentId
        || candidate.fragment_ids.includes(tableKeyOrFragmentId)
      );
      if (inaccessibleTable) {
        const authorization = await this.authorizeTableEvidenceIds(
          this.tableEvidenceIdsForFragments(inaccessibleTable.fragment_ids),
        );
        if (authorization.blocked) return authorization.blocked;
      }
      return {
        ok: false,
        error: "unknown_table_key_or_fragment",
        selector_table_authoring: this.selectorTableAuthoring(),
        actual: tableKeyOrFragmentId,
        how_to_pass: "导航读取请从 list_table_fragments 或 read_saved_table_structure 复制可访问的 table_key；隔离引用按 selector_table_authoring 继续编写 item。",
        writable_path: "table_key",
        next_tool: "list_table_fragments",
        instruction: "未知导航键；先读取目录。作者分组键不能用来打开隐藏表格。",
      };
    }
    const authorization = await this.authorizeTableEvidenceIds(
      this.tableEvidenceIdsForFragments(table.fragment_ids),
    );
    if (authorization.blocked) return authorization.blocked;
    const rowIds = unique(table.fragment_ids.flatMap((fragmentId) =>
      this.evidence.table_fragments.find((fragment) => fragment.fragment_id === fragmentId)?.row_evidence_ids ?? []
    ));
    const start = Math.max(0, Number.isInteger(cursor) ? cursor : 0);
    const limit = Math.min(50, Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 24));
    const selectedIds = rowIds.slice(start, start + limit);
    const rows: Array<Record<string, unknown>> = [];
    const openedUnits: Array<{ record: EvidenceRecord; window: { start: number; end: number } }> = [];
    for (const evidenceId of selectedIds) {
      const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      if (!record) continue;
      const window = { start: 0, end: record.text.length, text: record.text };
      const handles = await this.tableCellHandles(record, window);
      const cells = handles.map((handle) => {
        const geometry = record.cell_geometry?.[handle.column_index];
        return {
          cell_id: geometry?.cell_id ?? `${record.evidence_id}:column:${handle.column_index}`,
          span_id: handle.span_id,
          text: handle.text,
          column_index: handle.column_index,
          source_row: geometry?.row ?? ((record.row_index ?? 1) - 1),
          source_column: geometry?.column ?? handle.column_index,
          rowspan: geometry?.rowspan ?? 1,
          colspan: geometry?.colspan ?? 1,
          column_label: handle.label,
        };
      });
      rows.push({
        row_id: record.evidence_id,
        row_kind_hint: record.role === "formal_table_header" ? "header_candidate"
          : record.table_row_kind === "data" ? "data_candidate" : "context_candidate",
        bindable_text: record.text,
        table_title: record.table_title ?? "",
        table_id: record.table_id ?? "",
        fragment_id: record.table_fragment_id ?? "",
        row_index: record.row_index ?? 0,
        cells,
      });
      openedUnits.push({ record, window });
    }
    if (openedUnits.length) await this.markEvidenceWindowsOpened(openedUnits);
    return {
      ok: true,
      table_key: table.table_key,
      source_version: plan.source_version,
      rows,
      next_cursor: start + selectedIds.length < rowIds.length ? start + selectedIds.length : null,
      saved_roles: {
        header_rows: table.header_rows,
        data_rows: table.data_rows,
        repeated_header_rows: table.repeated_header_rows,
        note_rows: table.note_rows,
        context_rows: table.context_rows,
        review_rows: table.review_rows,
      },
      instruction: "单元格文字和 span 才是可绑定来源；table_title/row_index/fragment_id 是导航元数据。根据实际合并关系、相邻题注、续表和表注确认角色；无法唯一判断保留 review。",
    };
  }

  private async readAdjacentTableSource(fragmentId: string, before: number, after: number): Promise<ToolResponse> {
    const fragment = this.evidence.table_fragments.find((candidate) => candidate.fragment_id === fragmentId)
      ?? this.evidence.scope.table_navigation_candidates?.find((candidate) => candidate.fragment_id === fragmentId);
    if (!fragment) return {
      ok: false,
      error: "unknown_table_fragment",
      actual: fragmentId,
      how_to_pass: "从 list_table_fragments 复制 fragment_id。",
      writable_path: "fragment_id",
      next_tool: "list_table_fragments",
      instruction: "未知物理 fragment；先读取表格目录。",
    };
    const ownedIds = new Set([
      ...fragment.title_candidate_evidence_ids,
      ...(fragment.continuation_caption_evidence_ids ?? []),
      ...fragment.row_evidence_ids,
    ]);
    const indexes = this.evidence.evidence.flatMap((record, index) => ownedIds.has(record.evidence_id) ? [index] : []);
    const records = indexes.length
      ? this.evidence.evidence.slice(
          Math.max(0, Math.min(...indexes) - Math.min(8, Math.max(0, before))),
          Math.min(this.evidence.evidence.length, Math.max(...indexes) + 1 + Math.min(8, Math.max(0, after))),
        )
      : [];
    const authorization = await this.authorizeTableEvidenceIds(unique([
      ...ownedIds,
      ...records.map((record) => record.evidence_id),
    ]));
    if (authorization.blocked) return authorization.blocked;
    if (!indexes.length) return { ok: true, fragment_id: fragmentId, sources: [], instruction: "该导航 fragment 没有进入当前权威 evidence；读取全局相邻原子。" };
    const openedUnits = records.map((record) => ({ record, window: { start: 0, end: record.text.length } }));
    if (openedUnits.length) await this.markEvidenceWindowsOpened(openedUnits);
    return {
      ok: true,
      fragment_id: fragmentId,
      sources: records.map((record) => ({
        resource: evidenceResource(record, this.evidenceAccess(record, authorization.accessByEvidenceId)),
        text: record.text,
      })),
      instruction: "相邻位置只用于判断题注、续表和表注关系，不自动证明业务适用或最终结构角色。",
    };
  }

  private async stageTableStructure(rawTable: unknown, rawRemoveTableKeys: unknown): Promise<ToolResponse> {
    if (!rawTable || typeof rawTable !== "object" || Array.isArray(rawTable)) return {
      ok: false,
      error: "invalid_table_structure_decision",
      actual: rawTable,
      how_to_pass: "按 stage_table_structure 的 typed schema 提交一个 table 决定。",
      writable_path: "table",
      next_tool: "read_saved_table_structure",
      instruction: "提交值必须符合 typed 表结构决定 schema。",
    };
    const table = rawTable as TableStructureDecision;
    const rawPlan = await this.readTableStructurePlan();
    const plan = await this.projectAccessibleTableStructurePlan(rawPlan);
    const removeTableKeys = Array.isArray(rawRemoveTableKeys)
      ? rawRemoveTableKeys.filter((value): value is string => typeof value === "string")
      : [];
    const unknownRemoveKeys = removeTableKeys.filter((key) => !plan.tables.some((candidate) => candidate.table_key === key));
    if (unknownRemoveKeys.length) return {
      ok: false,
      error: "unknown_table_structure_remove_key",
      actual: unknownRemoveKeys,
      durable_mutation: false,
      how_to_pass: "只删除 read_saved_table_structure 返回的 table_key。",
      writable_path: "remove_table_keys",
      next_tool: "read_saved_table_structure",
      instruction: "存在未知结构决定键，未写入。",
    };
    if (removeTableKeys.includes(table.table_key)) return {
      ok: false,
      error: "table_structure_upsert_remove_conflict",
      actual: table.table_key,
      how_to_pass: "同一个 table_key 只能 upsert 或 remove，不能同时执行。",
      writable_path: "remove_table_keys",
      next_tool: "stage_table_structure",
      instruction: "合并物理 fragments 时保留新 table_key，只删除被合并的旧 review table keys。",
    };
    const registry = await this.workspace.readSourceSpanRegistry();
    const evidenceIdBySpanId = new Map(registry.spans.map((span) => [span.span_id, span.evidence_id]));
    const submittedEvidenceIds = unique([
      ...this.tableEvidenceIdsForFragments(Array.isArray(table.fragment_ids) ? table.fragment_ids : []),
      ...([table.header_rows, table.data_rows, table.repeated_header_rows, table.note_rows,
        table.context_rows, table.review_rows]
        .filter(Array.isArray)
        .flatMap((ids) => ids.filter((id): id is string => typeof id === "string"))),
      ...(Array.isArray(table.row_role_overrides)
        ? table.row_role_overrides.flatMap((override) => typeof override?.row_id === "string" ? [override.row_id] : [])
        : []),
      ...([table.formal_title_span_ids, table.continuation_caption_span_ids, table.note_span_ids]
        .filter(Array.isArray)
        .flatMap((ids) => ids.flatMap((spanId) => {
          if (typeof spanId !== "string") return [];
          const evidenceId = evidenceIdBySpanId.get(spanId);
          return evidenceId ? [evidenceId] : [];
        }))),
    ]);
    const authorization = await this.authorizeTableEvidenceIds(submittedEvidenceIds);
    if (authorization.blocked) return authorization.blocked;
    const accessibleFragmentIds = new Set(plan.tables.flatMap((candidate) => candidate.fragment_ids));
    const hiddenDecision = (candidate: TableStructureDecision): TableStructureDecision | undefined => {
      const fragmentIds = candidate.fragment_ids.filter((fragmentId) => !accessibleFragmentIds.has(fragmentId));
      if (fragmentIds.length === 0) return undefined;
      const hiddenMemberEvidenceIds = new Set(this.tableEvidenceIdsForFragments(fragmentIds));
      const isHiddenEvidence = (evidenceId: string) => hiddenMemberEvidenceIds.has(evidenceId)
        || this.evidence.evidence.some((record) =>
          record.evidence_id === evidenceId
          && this.evidenceAccess(record, authorization.accessByEvidenceId).access_mode === "isolated_reference"
        );
      const hiddenEvidenceIds = (ids: readonly string[]) => ids.filter(isHiddenEvidence);
      const hiddenSpanIds = (ids: readonly string[]) => ids.filter((spanId) => {
        const evidenceId = evidenceIdBySpanId.get(spanId);
        return !evidenceId || isHiddenEvidence(evidenceId);
      });
      return {
        ...candidate,
        fragment_ids: fragmentIds,
        formal_title_span_ids: hiddenSpanIds(candidate.formal_title_span_ids),
        header_rows: hiddenEvidenceIds(candidate.header_rows),
        data_rows: hiddenEvidenceIds(candidate.data_rows),
        repeated_header_rows: hiddenEvidenceIds(candidate.repeated_header_rows),
        note_rows: hiddenEvidenceIds(candidate.note_rows),
        context_rows: hiddenEvidenceIds(candidate.context_rows),
        review_rows: hiddenEvidenceIds(candidate.review_rows),
        row_role_overrides: candidate.row_role_overrides.filter((override) =>
          isHiddenEvidence(override.row_id)
        ),
        continuation_caption_span_ids: hiddenSpanIds(candidate.continuation_caption_span_ids),
        note_span_ids: hiddenSpanIds(candidate.note_span_ids),
      };
    };
    const tables: TableStructureDecision[] = [];
    let staged = false;
    for (const candidate of rawPlan.tables) {
      const ownsAccessibleFragment = candidate.fragment_ids.some((fragmentId) =>
        accessibleFragmentIds.has(fragmentId)
      );
      const replacesVisibleDecision = !staged
        && ownsAccessibleFragment
        && candidate.table_key === table.table_key;
      const removesVisibleDecision = ownsAccessibleFragment
        && removeTableKeys.includes(candidate.table_key);
      if (!replacesVisibleDecision && !removesVisibleDecision) {
        tables.push(candidate);
        continue;
      }
      const hidden = hiddenDecision(candidate);
      if (hidden) tables.push(hidden);
      if (replacesVisibleDecision) {
        tables.push(table);
        staged = true;
      }
    }
    if (!staged) tables.push(table);
    const nextPlan: TableStructurePlan = { ...rawPlan, tables };
    const publicNextPlan = await this.projectAccessibleTableStructurePlan(nextPlan);
    const savedIndexByFragment = publicNextPlan.tables.findIndex((candidate) =>
      candidate.table_key === table.table_key
      && candidate.fragment_ids.some((fragmentId) => table.fragment_ids.includes(fragmentId))
    );
    const savedIndex = savedIndexByFragment >= 0
      ? savedIndexByFragment
      : publicNextPlan.tables.findIndex((candidate) => candidate.table_key === table.table_key);
    const issues = validateTableStructurePlan(publicNextPlan, this.evidence, registry);
    const path = join(this.workspace.root, "table-structure.json");
    await atomicWriteJson(path, nextPlan);
    if (await pathExists(this.workspace.workingSelectorPath)) {
      const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
        await readFile(this.workspace.workingSelectorPath, "utf8"),
      )).plan;
      await atomicWriteJson(join(this.workspace.root, "table-expansion-obligations.json"), {
        schema_version: "table-expansion-obligations/v1",
        ...tableExpansionState(
          this.evidence,
          registry,
          selectors,
          publicNextPlan,
          this.eligibleTableEvidenceIds(authorization.accessByEvidenceId),
        ),
      });
    }
    await atomicWriteJson(join(this.workspace.root, "table-structure-checkpoint.json"), {
      schema_version: TABLE_STRUCTURE_SCHEMA_VERSION,
      source_version: nextPlan.source_version,
      evidence_fingerprint: nextPlan.evidence_fingerprint,
      structure_fingerprint: tableStructureFingerprint(nextPlan),
      saved_at: new Date().toISOString(),
      confirmed_fragment_ids: unique(nextPlan.tables.filter((entry) => entry.status === "confirmed").flatMap((entry) => entry.fragment_ids)),
      pending_tables: nextPlan.tables.filter((entry) => entry.status !== "confirmed").map((entry) => ({ table_key: entry.table_key, review_rows: entry.review_rows })),
    });
    const affected = issues.filter((issue) => issue.path === `/tables/${savedIndex}`
      || issue.path.startsWith(`/tables/${savedIndex}/`));
    const nextWork = affected.length ? undefined : await this.selectorExecutionWork();
    return {
      ok: true,
      draft_status: affected.length ? "saved_structure_validation_failed" : "saved_structure_validation_passed",
      table_key: table.table_key,
      removed_table_keys: removeTableKeys,
      validation: { ok: affected.length === 0, issues: affected },
      pending_complex_tables: pendingComplexTableStructureIssues(publicNextPlan, this.evidence),
      ...(nextWork ? { current_work: nextWork, ...selectorWorkNextStep(nextWork) } : {}),
      budget_consumed: false,
      instruction: affected.length
        ? "结构决定已保存但未通过。按 actual/how_to_pass 修正；无法唯一判断就保持 review，不得静默 seal。"
        : "结构决定已保存。继续处理未决表；业务 item 只读取 confirmed 结构并通过 table_key 继承题注。",
    };
  }

  private async tableCellHandles(record: EvidenceRecord, window: { start: number; end: number }) {
    const cells = renderedTableCellSpans(record).filter(cell => cell.start >= window.start && cell.end <= window.end);
    if (!cells.length) return [];
    let registry = await this.workspace.readSourceSpanRegistry();
    const register = (start: number, end: number) => {
      const registered = registerSourceSpan(registry, {
        source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
      }, start, end);
      registry = registered.registry;
      return registered.span.span_id;
    };
    const handles = cells.map(cell => ({
      ...cell, span_id: register(cell.start, cell.end),
      ...(cell.label_end > cell.label_start && cell.label_start >= window.start ? { label_span_id: register(cell.label_start, cell.label_end) } : {}),
      label_fragments: cell.label_fragments.filter(fragment => fragment.start >= window.start).map(fragment => ({
        ...fragment, span_id: register(fragment.start, fragment.end),
      })),
    }));
    await atomicWriteJson(this.workspace.sourceSpanRegistryPath, registry);
    return handles;
  }

  private async evidenceAccessSnapshot(
    persistPolicies: boolean,
  ): Promise<{
    accessByEvidenceId: Map<string, EvidenceAccessMetadata>;
    isolatedTargetKeysByEvidenceId: Map<string, Set<string>>;
  }> {
    const targets = new Map<string, EvidenceManifest["reference_occurrences"][number]>();
    for (const occurrence of this.evidence.reference_occurrences) {
      if (occurrence.status !== "resolved") continue;
      const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
      if (!targets.has(targetKey)) targets.set(targetKey, occurrence);
    }
    let policies: Map<string, ReturnType<typeof referenceAnalysisPolicy>>;
    if (persistPolicies) {
      policies = new Map();
      for (const [targetKey, occurrence] of targets) {
        policies.set(
          targetKey,
          await assignReferenceAnalysisPolicy(this.workspace, this.evidence, occurrence, "target"),
        );
      }
    } else {
      const state = await this.workspace.readState();
      policies = projectReferenceAnalysisPolicies(
        this.evidence,
        state.reference_analysis_modes,
        "target",
      );
    }
    const accessByEvidenceId = new Map<string, EvidenceAccessMetadata>();
    const isolatedTargetKeysByEvidenceId = new Map<string, Set<string>>();
    const markIsolatedTarget = (evidenceId: string, targetKey: string) => {
      const keys = isolatedTargetKeysByEvidenceId.get(evidenceId) ?? new Set<string>();
      keys.add(targetKey);
      isolatedTargetKeysByEvidenceId.set(evidenceId, keys);
    };
    const isolatedDocumentOccurrences: Array<{
      occurrence: EvidenceManifest["reference_occurrences"][number];
      access: Extract<EvidenceAccessMetadata, { access_mode: "isolated_reference" }>;
    }> = [];
    for (const occurrence of this.evidence.reference_occurrences) {
      if (occurrence.status !== "resolved") continue;
      const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
      const policy = policies.get(targetKey);
      if (!policy) continue;
      const access: EvidenceAccessMetadata = policy.analysis_mode === "isolated"
        ? {
            access_mode: "isolated_reference",
            read_tool: "read_reference_facts",
            open_evidence_allowed: false,
            target_key: targetKey,
          }
        : {
            access_mode: "inline_reference",
            read_tool: "read_document_reference_evidence",
            open_evidence_allowed: true,
            target_key: targetKey,
      };
      for (const evidenceId of occurrence.target_evidence_ids) {
        if (access.access_mode === "isolated_reference") {
          markIsolatedTarget(evidenceId, targetKey);
        }
        const existing = accessByEvidenceId.get(evidenceId);
        // Match isolatedReferenceTargetForEvidence: the first isolated route wins.
        if (
          !existing
          || (
            existing.access_mode !== "isolated_reference"
            && access.access_mode === "isolated_reference"
          )
        ) {
          accessByEvidenceId.set(evidenceId, access);
        }
      }
      if (access.access_mode === "isolated_reference"
        && referenceOccurrenceTargetsDocument(occurrence, this.evidence.source.sha256)) {
        isolatedDocumentOccurrences.push({ occurrence, access });
      }
    }
    if (isolatedDocumentOccurrences.length === 0) {
      return { accessByEvidenceId, isolatedTargetKeysByEvidenceId };
    }
    const document = await this.readGlobalDocumentEvidence();
    const source = document.atoms.map((atom) => atom.text).join("");
    const sourceRangesFor = createEvidenceSourceRangeResolver(source, document);
    const rangesByEvidenceId = new Map(
      this.evidence.evidence.map((record) => [record.evidence_id, sourceRangesFor(record)]),
    );
    for (const { occurrence, access } of isolatedDocumentOccurrences) {
      const targetRanges = occurrence.target_evidence_ids.flatMap((evidenceId) => {
        return rangesByEvidenceId.get(evidenceId) ?? [];
      });
      for (const record of this.evidence.evidence) {
        const recordRanges = rangesByEvidenceId.get(record.evidence_id) ?? [];
        if (targetRanges.some((targetRange) =>
          recordRanges.some((recordRange) => sourceRangesOverlap(targetRange, recordRange))
        )) {
          markIsolatedTarget(record.evidence_id, access.target_key);
          if (accessByEvidenceId.get(record.evidence_id)?.access_mode !== "isolated_reference") {
            accessByEvidenceId.set(record.evidence_id, access);
          }
        }
      }
    }
    return { accessByEvidenceId, isolatedTargetKeysByEvidenceId };
  }

  private async evidenceAccessIndex(
    persistPolicies: boolean,
  ): Promise<Map<string, EvidenceAccessMetadata>> {
    return (await this.evidenceAccessSnapshot(persistPolicies)).accessByEvidenceId;
  }

  private evidenceAccess(
    record: EvidenceRecord,
    accessByEvidenceId: ReadonlyMap<string, EvidenceAccessMetadata>,
  ): EvidenceAccessMetadata {
    return accessByEvidenceId.get(record.evidence_id) ?? {
      access_mode: "direct",
      read_tool: "open_evidence",
      open_evidence_allowed: true,
    };
  }

  private inaccessibleTableFragmentEvidenceIds(
    accessByEvidenceId: ReadonlyMap<string, EvidenceAccessMetadata>,
  ): Set<string> {
    const hidden = new Set<string>();
    const fragments = [...new Map([
      ...this.evidence.table_fragments,
      ...(this.evidence.scope.table_navigation_candidates ?? []),
    ].map((fragment) => [fragment.fragment_id, fragment])).values()];
    for (const fragment of fragments) {
      const memberIds = this.tableFragmentEvidenceIds(fragment);
      if (!memberIds.some((evidenceId) =>
        this.evidence.evidence.find((record) => record.evidence_id === evidenceId)
        && this.evidenceAccess(
          this.evidence.evidence.find((record) => record.evidence_id === evidenceId)!,
          accessByEvidenceId,
        ).access_mode === "isolated_reference"
      )) continue;
      memberIds.forEach((evidenceId) => hidden.add(evidenceId));
    }
    return hidden;
  }

  private eligibleTableEvidenceIds(
    accessByEvidenceId: ReadonlyMap<string, EvidenceAccessMetadata>,
  ): Set<string> {
    const inaccessibleTableEvidenceIds = this.inaccessibleTableFragmentEvidenceIds(accessByEvidenceId);
    return new Set(this.evidence.evidence.flatMap((record) =>
      !inaccessibleTableEvidenceIds.has(record.evidence_id)
      && this.evidenceAccess(record, accessByEvidenceId).access_mode !== "isolated_reference"
        ? [record.evidence_id]
        : []
    ));
  }

  /** Rebuilt from this workspace on every provider start, never from a prior
   * model summary or a test runner's userFeedback. Does not mark sources read. */
  async selectorScopeHandoff(): Promise<Record<string, unknown>> {
    const { accessByEvidenceId } = await this.evidenceAccessSnapshot(false);
    return {
      source_sha256: this.evidence.source.sha256,
      target_scope: await this.publicTargetScope(accessByEvidenceId,
        this.inaccessibleTableFragmentEvidenceIds(accessByEvidenceId)),
      frozen_semantic_basis: await this.readFrozenTargetSemanticBasis() ?? null,
      instruction: "这是当前target已确认的完整执行范围。业务对象和边界按冻结范围依据理解，selected_heading及已有lot/item名称只作定位，不能据此缩小范围。primary_source_ranges包含全部直接正文范围，end_exclusive_line不包含；范围外已登记引用按原读取权限调查，是否适用、条件、例外及接收项目仍由模型判断。此交接不表示正文已读或业务已完成，不改变范围、已存决定、计数或预算。缺少正文时沿当前来源工具补读。",
    };
  }

  private async publicTargetScope(
    accessByEvidenceId: ReadonlyMap<string, EvidenceAccessMetadata>,
    inaccessibleTableEvidenceIds: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> {
    const excludedEvidenceIds = new Set(this.evidence.evidence.flatMap((record) =>
      inaccessibleTableEvidenceIds.has(record.evidence_id)
      || this.evidenceAccess(record, accessByEvidenceId).access_mode === "isolated_reference"
        ? [record.evidence_id]
        : []
    ));
    const document = await this.readGlobalDocumentEvidence();
    const source = document.atoms.map((atom) => atom.text).join("");
    const sourceRangesFor = createEvidenceSourceRangeResolver(source, document);
    const protectedRanges = this.evidence.evidence
      .filter((record) => excludedEvidenceIds.has(record.evidence_id))
      .flatMap((record) => sourceRangesFor(record));
    const excludedLineageIds = new Set(this.evidence.evidence
      .filter((record) => excludedEvidenceIds.has(record.evidence_id))
      .flatMap((record) => [record.evidence_id, record.atom_id ?? record.evidence_id]));
    const protectedAtomIds = new Set(document.atoms
      .filter((atom) => protectedRanges.some((range) => sourceRangesOverlap(
        { start: atom.start_offset, end: atom.end_offset },
        range,
      )))
      .map((atom) => atom.atom_id));
    const selectedAtomIds = (this.evidence.scope.selected_atom_ids ?? []).filter((atomId) =>
      !excludedEvidenceIds.has(atomId)
      && !excludedLineageIds.has(atomId)
      && !protectedAtomIds.has(atomId)
    );
    const primarySourceRanges = this.evidence.scope.primary_source_ranges
      ? excludeProtectedSourceLineWindows(
          source,
          this.evidence.scope.primary_source_ranges,
          protectedRanges,
        )
      : undefined;
    const excludesPrimaryEvidence = this.evidence.evidence.some((record) =>
      record.evidence_scope === "primary" && excludedEvidenceIds.has(record.evidence_id)
    );
    return {
      mode: this.evidence.scope.mode,
      target_id: this.evidence.scope.target_id,
      selected_heading: this.evidence.scope.selected_heading,
      selection_reason: this.evidence.scope.selection_reason,
      ...(!excludesPrimaryEvidence && this.evidence.scope.confirmed_scope_fingerprint
        ? { confirmed_scope_fingerprint: this.evidence.scope.confirmed_scope_fingerprint }
        : {}),
      ...(primarySourceRanges ? { primary_source_ranges: primarySourceRanges } : {}),
      ...(primarySourceRanges ? { scope_authority: {
        primary_source_ranges: "confirmed_scope_coordinates",
        end_exclusive_line: "not_included",
        selection_reason_clause_lists: "navigation_only_not_exhaustive",
        instruction: "确认范围按 primary_source_ranges 的行坐标判断：start_line 包含、end_exclusive_line 不包含。selection_reason 内的程序条款清单及定位摘要可能漏掉原文编号，不能以清单的最后编号截断范围；范围内原文仍须独立判断和完整抽取。clause_id、role、标题只作导航，不是范围或业务归属批准。",
      } } : {}),
      selected_atom_ids: selectedAtomIds,
    };
  }

  private isolatedReferenceBodyAccessFeedback(targetKey: string) {
    return {
      instruction: "先用 read_reference_facts 的 target_key 取得目录，再按 entry_ids 及分页参数完整读取所选行。resolved_rows 返回已读行的 evidence_id 和整行 span_id；resolve_rows 只用于重新取得已读行句柄。未读隔离正文不能通过 open_evidence 或定位工具访问；完整读取后，可按该行 quote_locator 用 locate_evidence_span 定位模型选择的连续原文，无须先 open_evidence 重读。",
      target_key: targetKey,
      analysis_mode: "isolated",
      required_action: "call_read_reference_facts_with_target_key_then_open_selected_entry_ids",
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: targetKey },
      writable_parameters: ["target_key"],
      do_not_edit: "不可变引用原文、已正确的 selector 或编译产物",
    };
  }

  private async openEvidence(evidenceId: string, cursor = 0): Promise<ToolResponse> {
    const record = this.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (!record) return { ok: false, error: "unknown_evidence_id", instruction: "先打开或列举证据，从返回目录复制 evidence_id，不得编造证据 ID。", evidence_id: evidenceId };
    const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, evidenceId, "target");
    if (isolated) return { ok: false, error: "isolated_reference_body_access_forbidden", ...this.isolatedReferenceBodyAccessFeedback(isolated.target_key) };
    const windows = splitTextWindows(record.text);
    const windowIndex = Number.isInteger(cursor) ? cursor : -1;
    const window = windows[windowIndex];
    if (!window) {
      return {
        ok: false,
        terminal: false,
        error: "invalid_evidence_cursor",
        actual: { evidence_id: evidenceId, cursor, window_count: windows.length },
        expected: { cursor_unit: "zero_based_text_window_index", integer: true, minimum: 0,
          maximum: windows.length ? windows.length - 1 : null, cursor_available: windows.length > 0 },
        writable_paths: windows.length ? ["/cursor"] : [],
        next_tool: windows.length ? "open_evidence" : "list_evidence_resources",
        next_tool_arguments: windows.length ? { evidence_id: evidenceId, cursor: 0 } : { cursor: 0 },
        budget_consumed: false, full_stage_check_performed: false, author_draft_mutation: false,
        instruction: windows.length
          ? "cursor 是本资源从 0 开始的整数正文窗口编号，须位于 expected 的范围；不是字符偏移或行号。按返回参数从同一来源的首个窗口读取，再仅使用成功回条的 next_cursor 继续。此次未返回正文或登记已读窗口；不要用相同无效参数重试。"
          : "本资源正文为空，没有任何合法 cursor；改成 0 仍不能读取。按返回参数核对当前资源目录，保留真实空来源及异常；不得编造正文、猜替代来源或改写不可变证据。此次未登记已读窗口。",
        do_not_edit: "不可变证据正文、来源登记、selector 或编译产物；有效窗口存在时仅修改读取请求的 cursor。",
        evidence_id: evidenceId,
        cursor,
        window_count: windows.length,
      };
    }
    const fullyOpened = await this.markEvidenceWindowsOpened([{ record, window }]);
    const registry = await this.workspace.readSourceSpanRegistry();
    const chunkSpan = fullyOpened.has(evidenceId)
      && tableEvidenceTextFormat(record) !== "legacy_navigation_mixed_v0"
      ? registry.spans.find((span) =>
          span.evidence_id === evidenceId
          && span.start === 0
          && span.end === record.text.length
        )
      : undefined;
    const response = {
      ok: true,
      resource: evidenceResource(record, this.evidenceAccess(record, await this.evidenceAccessIndex(false))),
      cursor: windowIndex,
      text_window: window,
      next_cursor: windowIndex + 1 < windows.length ? windowIndex + 1 : null,
      ...(chunkSpan ? { chunk_span: chunkSpan } : {}),
      cells: await this.tableCellHandles(record, window),
      boundary_neighbors: sourceBoundaryNeighbors(this.evidence.evidence, evidenceId),
      instruction: `仅本次明确打开的来源窗口进入上下文；需要继续调查此资源时再用 next_cursor。${SOURCE_READING_GUIDANCE}`,
    };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      return { ok: false, error: "open_evidence_payload_limit_internal", instruction: "减少本次打开的证据 ID 或缩小窗口，不要重试相同的超大请求。", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
    }
    return response;
  }

  private async markEvidenceWindowsOpened(
    units: Array<{ record: EvidenceRecord; window: { start: number; end: number } }>,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    let previousWindowKeys: string[] | undefined;
    let previousEvidenceIds: string[] | undefined;
    const updated = await this.workspace.updateState((state) => {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      previousWindowKeys = state.opened_evidence_window_keys;
      previousEvidenceIds = state.opened_evidence_ids;
      state.opened_evidence_window_keys = [...new Set([
        ...(state.opened_evidence_window_keys ?? []),
        ...units.map(({ record, window }) => evidenceWindowKey(record.evidence_id, window)),
      ])].sort();
      const openedWindows = new Set(state.opened_evidence_window_keys);
      const fullyOpened = this.evidence.evidence.filter((record) =>
        splitTextWindows(record.text).every((window) =>
          openedWindows.has(evidenceWindowKey(record.evidence_id, window))
        )
      ).map((record) => record.evidence_id);
      state.opened_evidence_ids = [...new Set([...(state.opened_evidence_ids ?? []), ...fullyOpened])].sort();
    });
    if (signal?.aborted) {
      await this.workspace.updateState((state) => {
        if (sha256Json(state.opened_evidence_window_keys ?? []) !== sha256Json(updated.opened_evidence_window_keys ?? [])
          || sha256Json(state.opened_evidence_ids ?? []) !== sha256Json(updated.opened_evidence_ids ?? [])) return;
        if (previousWindowKeys) state.opened_evidence_window_keys = previousWindowKeys;
        else delete state.opened_evidence_window_keys;
        if (previousEvidenceIds) state.opened_evidence_ids = previousEvidenceIds;
        else delete state.opened_evidence_ids;
      });
      throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    const fullyOpened = new Set(updated.opened_evidence_ids ?? []);
    fullyOpened.forEach((evidenceId) => this.openedEvidenceIds.add(evidenceId));
    for (const { record, window } of units) this.currentDeliveryWindows.add(evidenceWindowKey(record.evidence_id, window));
    return fullyOpened;
  }

  private async stageDiagnosticInputsFingerprint(): Promise<string> {
    return selectorStageDiagnosticInputsFingerprint(this.workspace);
  }

  private async currentSelectorProtocol(state: RevisionState): Promise<Record<string, unknown>> {
    return publicSelectorProtocol(state.selector_protocol, state.selector_protocol?.last_stage_diagnostics
      ? await this.stageDiagnosticInputsFingerprint() : undefined);
  }

  private async currentAuthorDiagnosticInputs() {
    const state = await this.workspace.readState();
    return sha256Json({ schema: "selector-author-diagnostic-inputs/v1",
      inputs: await this.stageDiagnosticInputsFingerprint(),
      opened: state.opened_evidence_ids, windows: state.opened_evidence_window_keys,
      document_reference_reads: state.document_reference_reads,
      reference_catalog_dispositions: state.reference_catalog_dispositions,
      language: state.selector_protocol?.language_review_markers, names: state.selector_protocol?.name_review_markers });
  }

  private async currentFieldDiagnosticInputs() {
    const snapshotPath = join(this.workspace.root, "selector-diagnostics.json");
    const snapshot = await pathExists(snapshotPath) ? await readJson<any>(snapshotPath) : undefined;
    // Feedback migration only: refresh readonly field diagnostics, not a formal
    // validation checkpoint, author counters, or the compiled acceptance result.
    return sha256Json({ schema: "selector-field-diagnostics/v5",
      inputs: await this.currentAuthorDiagnosticInputs(),
      preflight: snapshot ? { contract_version: snapshot.contract_version,
        author_inputs_fingerprint: snapshot.author_inputs_fingerprint, issues: snapshot.issues } : undefined });
  }

  private async currentFieldDiagnostics(inputs?: string) {
    inputs ??= await this.currentFieldDiagnosticInputs();
    const file = join(this.workspace.root, "selector-field-diagnostics.json");
    type Cache = { inputs: string; issues: unknown[]; observations: unknown[] };
    let cached = await pathExists(file) ? await readJson<Cache>(file) : undefined;
    const reused = cached?.inputs === inputs;
    if (!reused) {
      const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
      // Compiler routing enforces source visibility. Field-role heuristics remain
      // in the dedicated source-review path, which applies its own access filter.
      const snapshotPath = join(this.workspace.root, "selector-diagnostics.json");
      const snapshot = await pathExists(snapshotPath) ? await readJson<any>(snapshotPath) : undefined;
      const checkedIssues = snapshot?.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
        && snapshot.author_inputs_fingerprint === await this.currentAuthorDiagnosticInputs()
        && Array.isArray(snapshot.issues) ? snapshot.issues : [];
      // Reuse only a check bound to these exact inputs; do not run another
      // preflight or replay stale actuals after an edit/read/scope change.
      const issues = coalesceSelectorIssueDiagnostics([
        ...await this.selectorCompilerIssues(selectors, false, true), ...checkedIssues,
      ]).map(issue => actionableSelectorIssue(issue, selectors));
      cached = { inputs, issues, observations: [...this.modelReviewObservations.values()] };
      await atomicWriteJson(file, cached);
    }
    for (const observation of cached!.observations) this.modelReviewObservations.set(sha256Json(observation), observation);
    return { inputs, reused, cached: cached! };
  }

  /** A durable scheduling checkpoint, separate from author content and budgets. */
  async selectorTableProgress() {
    return tableStructureProgress(await this.projectAccessibleTableStructurePlan(await this.readTableStructurePlan()),
      this.evidence, await this.workspace.readSourceSpanRegistry());
  }

  /** Navigation for unfinished content, not a verdict that a new item exists. */
  private async pendingSelectorAuthoringWork() {
    if (this.selectorStage === "coverage_repair" || (await this.workspace.readState()).last_valid_fingerprint) return undefined;
    const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
    const access = await this.evidenceAccessIndex(false);
    const hidden = this.inaccessibleTableFragmentEvidenceIds(access);
    const evidence = this.evidence.evidence.filter(record => !hidden.has(record.evidence_id)
      && this.evidenceAccess(record, access).access_mode === "direct");
    const eligible = new Set(evidence.map(record => record.evidence_id));
    const registry = await this.workspace.readSourceSpanRegistry();
    const structure = await this.projectAccessibleTableStructurePlan(await this.readTableStructurePlan());
    const expansion = tableExpansionState(this.evidence, registry, selectors, structure, eligible);
    const primaryIds = new Set(evidence.filter(record => record.evidence_scope === "primary").map(record => record.evidence_id));
    const pendingTable = structure.tables.find(table => table.status !== "confirmed"
      && table.fragment_ids.some(id => this.evidence.table_fragments.find(fragment => fragment.fragment_id === id)
        ?.row_evidence_ids.some(evidenceId => primaryIds.has(evidenceId))));
    const pendingRow = expansion.work_packages.flatMap(work => work.rows).find(row => row.disposition === "pending");
    const table = pendingTable ?? (pendingRow && structure.tables.find(table => table.fragment_ids.some(id =>
      this.evidence.table_fragments.find(fragment => fragment.fragment_id === id)?.row_evidence_ids.includes(pendingRow.evidence_id))));
    if (table) {
      const rowIds = unique(table.fragment_ids.flatMap(id => this.evidence.table_fragments.find(fragment => fragment.fragment_id === id)?.row_evidence_ids ?? []));
      const read = pendingTable
        ? { tool: "read_table_summary", arguments: { table_key: table.table_key } }
        : { tool: "read_table_rows", arguments: { table_key: table.table_key,
          cursor: Math.max(0, rowIds.indexOf(pendingRow!.evidence_id)), limit: 4 } };
      const record = pendingRow && this.evidence.evidence.find(record => record.evidence_id === pendingRow.evidence_id);
      const delivery = record && this.sourceDecisionDelivery(record);
      return { identity: sha256Json({ source: this.evidence.source.sha256, table: table.table_key,
        work: pendingTable ? "structure" : pendingRow!.evidence_id }),
        code: pendingTable ? "author_table_structure_pending" : "author_table_rows_pending", path: pendingTable ? "/table" : "/items",
        writable_paths: pendingTable ? ["stage_table_structure.table"] : ["/items", "/sampling_rules", "/source_dispositions"],
        advisory_only: true, budget_consumed: false, full_stage_check_performed: false,
        ...(!pendingTable ? delivery : {}),
        table_key: table.table_key, ...(pendingTable ? {} : { evidence_ids: [pendingRow!.evidence_id], row_ids: [pendingRow!.row_id] }),
        diagnostic_read: read, record_read: undefined, save_tool: pendingTable ? "stage_table_structure" : "stage_target_selector_draft",
        instruction: pendingTable
          ? "当前表结构尚未确认。读取已保存结构和对应原文行，按实际表头、数据、注及续表关系保存结构决定；保存结构不等于保存验收项目。"
          : "当前原文表行尚无作者处置。按指定分页读取该行及上位条件；已实际交付时继续模型判断和保存，仅有具体缺口才补读。可补齐既有项、同属性分支、独立项、实际选用的共享抽样规则或有据的上下文/不适用处置；新增真实记录不要求先读取不存在的key，不机械一行一项。这里只安排待判断来源，不决定业务答案，也不构成新的阶段门槛。" };
    }
    const coverage = selectorDispositionCoverage({ selectors, evidence, spans: registry.spans.filter(span => eligible.has(span.evidence_id)) });
    const source = evidence.find(record => record.evidence_scope === "primary" && coverage.uncovered_required_ids.includes(record.evidence_id));
    if (!source) return undefined;
    return { identity: sha256Json({ source: this.evidence.source.sha256, evidence_id: source.evidence_id }),
      code: "author_source_review_pending", path: "/source_dispositions", advisory_only: true,
      budget_consumed: false, full_stage_check_performed: false, evidence_ids: [source.evidence_id],
      ...this.sourceDecisionDelivery(source),
      diagnostic_read: { tool: "open_evidence", arguments: { evidence_id: source.evidence_id, cursor: 0 } },
      record_read: { tool: "read_target_selectors", arguments: { collection: "source_dispositions", evidence_ids: [source.evidence_id] } },
      save_tool: "stage_target_selector_draft",
      instruction: "该来源尚未被作者绑定或显式处置，不等于缺少一个验收项目。核对现有处置和原文，再自行判断补齐既有项、分支/抽样/引用接收、新建真实项，或保存有据的上下文/不适用处置。已有足够依据的决定及时保存；不以重读或待办总结代替保存，不把真实判据降为背景来消错。此导航不新增业务门槛，也不证明语义完整。" };
  }

  private sourceDecisionDelivery(record: EvidenceRecord) {
    const delivered = splitTextWindows(record.text).every(window => this.currentDeliveryWindows.has(evidenceWindowKey(record.evidence_id, window)));
    return { source_delivery: { current_execution_complete: delivered, historical_read_alone_is_not_delivery: true },
      ...(delivered ? { next_action: { kind: "author_source_decision_and_save", decision_owner: "model",
        save_tool: "stage_target_selector_draft", writable_collections: ["items", "sampling_rules", "source_dispositions", "residual_source_dispositions"],
        instruction: "当前点名正文已在本次执行实际返回。由模型确认用途并保存已经有据的决定；可新建真实记录，不先读取不存在的key。若具体上下文仍缺才按支持入口补读，不以再次读取或待办总结代替保存。" } } : {}) };
  }

  async selectorExecutionWork() {
    return referenceCatalogDeliveryWork(await this.workspace.readState())
      ?? await this.selectorRepairWork() ?? await this.pendingSelectorAuthoringWork();
  }

  /** One current action for save receipts and normal-response continuation.
   * Reading diagnostics here neither approves business decisions nor performs
   * a formal stage check. The author and its existing budgets remain in charge. */
  async selectorExecutionStep() {
    const state = await this.workspace.readState();
    if (state.last_valid_fingerprint) return {
      state: "validated" as const, work: undefined,
      next_tool: "seal_validated_plan", next_tool_arguments: { fingerprint: state.last_valid_fingerprint },
    };
    const work = await this.selectorExecutionWork();
    if (work) return { state: "authoring" as const, work,
      ...selectorWorkNextStep(work), next_action: selectorWorkAction(work) };
    const stageIndex = SELECTOR_STAGE_ORDER.indexOf(this.selectorStage);
    const nextStage = stageIndex < 0 ? undefined : SELECTOR_STAGE_ORDER[stageIndex + 1];
    const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8")));
    return { state: "ready_for_check" as const, work: undefined,
      ...(nextStage
        ? { next_tool: "advance_target_selector_stage", next_tool_arguments: { next_stage: nextStage }, expected_next_stage: nextStage }
        : { next_tool: "commit_target_selector_draft", next_tool_arguments: { draft_fingerprint: targetSelectorFingerprint(selectors) } }),
    };
  }

  private async saveTargetComponentPlan(input: Record<string, unknown>): Promise<ToolResponse> {
    if (!Check(COMPONENT_PLAN_INPUT, input)) return {
      ok: false, error: "component_plan_shape_invalid", actual: input,
      expected: "按save_target_component_plan当前参数Schema提交步骤；只检查格式，不选择业务答案。",
      writable_paths: ["/occurrence_id", "/active_step_key", "/steps"],
      instruction: "未保存，旧计划不变。每个步骤保留key、span_ids、question、status、next_step和outcome；部分更新按key合并，不删除其他步骤。",
    };
    const plan = input as ComponentPlanInput;
    const unknownOccurrence = !this.evidence.reference_occurrences.some(row => row.occurrence_id === plan.occurrence_id);
    const registry = await this.workspace.readSourceSpanRegistry();
    const knownSpans = new Set(registry.spans.map(span => span.span_id));
    const unknownSpans = unique(plan.steps.flatMap(step => step.span_ids).filter(id => !knownSpans.has(id)));
    if (unknownOccurrence || unknownSpans.length) return {
      ok: false, error: "component_plan_source_unknown", actual: { occurrence_id: plan.occurrence_id, unknown_span_ids: unknownSpans },
      expected: "引用发生处和已点名span必须属于当前目标的登记表；未读组件可先用span_ids=[]计划针对性读取，不猜ID。",
      writable_paths: ["/occurrence_id", "/steps"], next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 20 },
      instruction: "未保存。按当前目录及正文读取回条取得真实身份，不需要为保存计划把所有未读正文先打开；程序不判断这些来源的适用性。",
    };
    const saved = await saveComponentPlan(this.workspace.root, this.evidence.source.sha256, plan);
    const receipt = saved.ok ? { ok: true } : saved;
    return { ...receipt, updated_step_keys: plan.steps.map(step => step.key), selector_mutation: false, budget_consumed: false, business_completion_proven: false,
      ...(saved.ok ? { component_plan: componentPlanView(saved.plan, plan.occurrence_id), selector_repair_work: await this.selectorRepairWork() } : {}),
      instruction: saved.ok
        ? "模型计划已保存，未修改验收项目、引用接收、原文或校验计数。由你从active_step.next_step选择必要工具，执行并保存真实作者决定后更新计划；不要仅保存计划或重复目录就收尾。计划的done是模型声明，不能代替来源接收或封存。"
        : "未保存，旧计划不变。按actual/expected修正计划的结构；问题与下一步仍由模型选择。",
    };
  }

  private async stageReferenceComponentDecisions(input: Record<string, unknown>): Promise<ToolResponse> {
    if (!Check(REFERENCE_COMPONENT_EDIT_INPUT, input)) return {
      ok: false, error: "reference_component_edit_shape_invalid", actual: input,
      expected: "按当前Schema提供draft_fingerprint、reference_key和非空component_dispositions；每项保留component_span_ids、decision、item_keys、reason。",
      writable_paths: ["/draft_fingerprint", "/reference_key", "/component_dispositions"],
      durable_mutation: false, budget_consumed: false, next_tool: "stage_reference_component_decisions",
      instruction: "本次未保存。只修结构参数，不必重交整条引用；本工具保留未点名组件、接收关系及其他字段。",
    };
    const edit = input as ReferenceComponentEditInput;
    const current = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
    const fingerprint = targetSelectorFingerprint(current);
    if (edit.draft_fingerprint !== fingerprint) return {
      ok: false, error: "selector_draft_fingerprint_mismatch", durable_mutation: false, budget_consumed: false,
      actual: { supplied: edit.draft_fingerprint, current: fingerprint }, expected: { draft_fingerprint: fingerprint },
      writable_paths: ["/draft_fingerprint"], next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "references", key: edit.reference_key },
      instruction: "本次未保存。读取当前引用并核对本次组件选择，携带当前draft_fingerprint重试；不让旧决定覆盖后续修改。",
    };
    const projected = editReferenceComponents(current, this.evidence, await this.workspace.readSourceSpanRegistry(), edit);
    if (!projected.ok) return projected;
    const patch = { draft_fingerprint: fingerprint, draft: { references: [projected.reference] } };
    const saved = await this.stageTargetSelectorDraft(patch);
    return { ...saved, mutation_receipt: selectorPatchReceipt(patch, saved.ok === true ? "saved" : "not_applied"),
      component_update: { reference_key: edit.reference_key, touched_span_ids: projected.touched_span_ids,
        other_components_preserved: true, destinations_preserved: true, model_selects_business_values: true } };
  }

  async selectorRepairWork() {
    const state = await this.workspace.readState();
    if (state.last_valid_fingerprint) return undefined;
    const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
    if (!selectors.items.length && !selectors.references.length && !selectors.sampling_rules.length && !selectors.lots.length) return undefined;
    const { inputs, cached } = await this.currentFieldDiagnostics();
    const file = join(this.workspace.root, "selector-repair-work.json");
    const saved = await readJson<{ source_sha256: string; focus?: SelectorRepairFocus; convergence?: SelectorBlockerHistory }>(file).catch(() => undefined);
    const previous = saved?.source_sha256 === this.evidence.source.sha256 ? saved.focus : undefined;
    const eligible = (issue: unknown) => this.selectorStage !== "primary" || selectorIssueCode(issue) !== "selector_sampling_decision_pending";
    const diagnostics = selectorIssueToolDiagnostics(cached.issues);
    const local = await readJson<any>(join(this.workspace.root, "saved-selector-diagnostics.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // A failed write is the immediate dependency of the parent work. Prioritize
    // its still-current field errors without deleting the parent's observations
    // or resetting their stagnation history. Old receipts supply no current facts.
    const localCurrent = local?.schema_version === "saved-selector-diagnostics/v1"
      && local.job_id === this.workspace.jobId && local.target_id === this.workspace.targetId
      && local.revision === this.workspace.revision && local.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
      && local.inputs_fingerprint === await this.stageDiagnosticInputsFingerprint();
    const localIds = new Set(localCurrent ? local.priority_issue_identities
      ?? selectorIssueProbes(selectorIssueToolDiagnostics(local.local_issues ?? []), selectors).map(row => row.identity) : []);
    const selection = selectSelectorRepairFocus(diagnostics, selectors, previous,
      issue => eligible(issue) && selectorIssueProbes([issue], selectors).some(probe => localIds.has(probe.identity)))
      ?? selectSelectorRepairFocus(diagnostics, selectors, previous, eligible);
    const checkpoint = { schema_version: "selector-repair-work/v1", source_sha256: this.evidence.source.sha256,
      focus: selection?.focus,
      ...(saved?.source_sha256 === this.evidence.source.sha256 && saved.convergence ? { convergence: saved.convergence } : {}) };
    if (JSON.stringify(saved) !== JSON.stringify(checkpoint)) await atomicWriteJson(file, checkpoint);
    if (!selection) return undefined;
    const record = selection.diagnostic.record;
    const occurrenceId = record?.occurrence_id ?? (record?.collection === "references"
      ? selectors.references.find(reference => reference.key === record.key)?.occurrence_id : undefined);
    const occurrence = this.evidence.reference_occurrences.find(row => row.occurrence_id === occurrenceId);
    const referencePermission = occurrence?.status === "resolved" && occurrence.target_evidence_ids.length ? {
      occurrence_id: occurrence.occurrence_id, source_role: "registered_reference", primary_range_expansion_required: false,
      target_evidence_count: occurrence.target_evidence_ids.length, applicability_decision_owner: "model",
      instruction: "primary_source_ranges只限定直接正文；这个已解析引用的登记正文可按现有来源访问、字段及接收合同用于本target，不需要将外章改成primary。来源许可不证明适用性、全部采用或已完成；具体接收、条件与例外仍由模型判断。",
    } : undefined;
    const componentPlan = typeof occurrenceId === "string" ? componentPlanView(
      (await readComponentPlans(this.workspace.root, this.evidence.source.sha256)).plans[occurrenceId], occurrenceId) : undefined;
    // The model's component investigation must not override a precise field
    // diagnostic such as import authorization or origin linkage.
    const missingReceipt = selection.diagnostic.code === "selector_registered_reference_receipt_missing";
    const componentWork = missingReceipt
      || /^\/(component_dispositions|target_span_ids)(\/|$)/u.test(selection.diagnostic.record?.field ?? "");
    const activeStep = componentWork ? componentPlan?.active_step : undefined;
    const authorReference = selectors.references.find(reference => reference.occurrence_id === occurrenceId);
    const accounting = activeStep ? componentStepAccounting(activeStep, authorReference) : undefined;
    const diagnosticScope = activeStep ? componentStepDiagnosticScope(activeStep,
      selection.diagnostic.related_information?.evidence_ids ?? [], (await this.workspace.readSourceSpanRegistry()).spans) : undefined;
    const outsideStep = selection.diagnostic.code === "selector_reference_component_dispositions_required"
      && accounting && accounting.active_step_span_count > 0 && !accounting.undeclared_active_step_span_ids.length
      && accounting.missing_or_duplicate_selected_span_ids.length > 0
      && accounting.missing_or_duplicate_selected_span_ids.every(id => !activeStep!.span_ids.includes(id));
    const capability = referenceFieldSelectionCapability(authorReference);
    const work = compactSourceReadRoutes({ ...(activeStep ? { model_step: activeStep,
      step_accounting: { ...accounting, ...diagnosticScope,
        current_missing_selection_is_outside_active_step: Boolean(outsideStep || diagnosticScope?.current_diagnostic_outside_active_step) },
      partial_save: { author_record: selection.focus.record_read?.arguments ?? record,
        ...capability,
        ...(missingReceipt && occurrence ? { reference_receipt_creation: {
          collection: "references", operation: "upsert", occurrence_id: occurrence.occurrence_id,
          anchor_span_ids: referenceOccurrenceLiteralSpanIds(occurrence), key_owner: "model", stageable_action: "review",
          completion_proven: false,
          instruction: "此 occurrence 尚无作者记录，不存在可回读的 reference key。模型选择自己的新 key，按完整记录合同保存已确认的组件及真实接收项；未决部分可先保持 action=review，不必先判断整章。此中间态仍会阻止完整验证和封存；不能把未决组件猜成不适用。",
        } } : {}),
        ...(authorReference ? { component_decisions: { tool: "stage_reference_component_decisions",
          arguments: { reference_key: authorReference.key, draft_fingerprint: targetSelectorFingerprint(selectors) },
          model_fills: ["component_dispositions"], preserves: ["unselected_components", "destinations", "other_reference_fields"] } } : {}),
        save_tool: "stage_target_selector_draft", model_selects_business_values: true,
        instruction: missingReceipt
          ? "按reference_receipt_creation提供的身份，以stage_target_selector_draft保存模型命名的完整references记录及已经确认的真实items。当前没有reference key可回读，也没有组件局部更新入口；action=review可保留中间进度，保存后继续处理新回条，未决内容不因此通过。"
          : "仅补改已确认的component_dispositions时，使用component_decisions中的局部保存入口，无须重交其他组件或接收关系。"
          + (capability.write_mode === "full_records" ? "其他字段或接收关系仍要求完整记录模式：operation=upsert，draft.references及必要的draft.items；不要用reference_selections重试。" : "其他字段可依实际合同选择字段选择模式或完整记录模式。")
          + "可以只保存当前步骤中已经判断清楚的组件，不要求先完成整章或把全部组件统一判为不适用。完整记录upsert仍须保留其他已存正确决定；未判断的组件保持未决。组件决定、适用条件及接收者均由模型填写，保存计划不代替该作者保存。" } } : {}),
      ...(referencePermission ? { reference_source_permission: referencePermission } : {}),
      ...selection.focus, diagnostic: selection.diagnostic,
      ...(componentPlan ? { component_plan: activeStep ? componentPlan : { ...componentPlan, execution_priority: "supporting_navigation",
        instruction: "模型计划原样保留。当前主待办是明确字段诊断，先按其actual、expected、可写路径及读取入口修复；不以执行旧组件步骤代替字段修复，也不自动标记计划完成。" } } : {}),
      diagnostic_read: { tool: "get_target_context", arguments: { field_diagnostic_cursor: selection.focus.diagnostic_cursor,
        field_diagnostic_fingerprint: inputs, field_diagnostic_detail_mode: "full" } },
      remaining_diagnostic_count: selection.remaining_diagnostic_count,
      instruction: renderFeedback({ kind: "current_diagnostic", constraint: "先处理本待办及直接依赖，保存真实作者决定；仅调查、重读或改理由不关闭义务。当前诊断闭合后跟随最新回条中的下一待办；当前作者错误清空后才执行阶段检查或完整提交。" })
        + (activeStep ? "\n整组来源尚未判断时，由你分组提出具体问题并用save_target_component_plan保存；已有模型计划从active_step续接，自行选择工具和适用决定，不因恢复而重复整章目录。计划不计业务完成。" : "") });
    const action = selectorWorkAction(work);
    return { ...(action ? { next_action: action } : {}), ...work };
  }

  private async pendingReferenceDeliveryResponse(): Promise<ToolResponse | undefined> {
    const delivery = referenceCatalogDeliveryWork(await this.workspace.readState());
    if (!delivery) return undefined;
    return {
      ok: false, terminal: false, error: delivery.code, issue_owner: "source_delivery",
      budget_consumed: false, full_stage_check_performed: false, author_draft_mutation: false,
      actual: { target_key: delivery.target_key, pending_delivery_count: delivery.pending_delivery_count },
      expected: "deliver_explicitly_requested_source_before_stage_check",
      current_work: delivery, ...selectorWorkNextStep(delivery),
      writable_parameters: ["target_key", "entry_ids", "row_cursor", "row_offset"],
      do_not_edit: "不可变原文、历史已读记录、检查点和预算；本回条不要求修改作者记录。",
      instruction: delivery.instruction,
    };
  }

  /** Navigation refusal only: do not spend a formal check on known author errors. */
  private async pendingSelectorRepairResponse(): Promise<ToolResponse | undefined> {
    const delivery = await this.pendingReferenceDeliveryResponse();
    if (delivery) return delivery;
    // Historical coverage transactions keep their own saved-review protocol.
    if (this.selectorStage === "coverage_repair") return undefined;
    const work = await this.selectorRepairWork();
    if (!work) return undefined;
    const state = await this.workspace.readState();
    const { cached } = await this.currentFieldDiagnostics();
    const issue = selectorIssueToolDiagnostics(cached.issues)[work.diagnostic_cursor] as Record<string, unknown>;
    const { diagnostic: _diagnostic, ...navigation } = work;
    return {
      ok: false, terminal: false, error: "selector_repair_required", issue_owner: "selector_input_error",
      current_stage: this.selectorStage,
      full_stage_check_performed: false, content_validation_performed: false,
      global_candidate_complete: false, budget_consumed: false, budget_scope: "candidate_validation",
      stage_retry_accounting: { scope: "consecutive_non_improvements", consumed: false,
        count: state.selector_protocol?.stage_retries?.consecutive_non_improvements ?? 0,
        limit: MAX_SELECTOR_PROTOCOL_FAILURES },
      actual: { remaining_diagnostic_count: work.remaining_diagnostic_count, pending_code: work.code },
      expected: "complete_current_author_diagnostics_before_stage_check_or_commit",
      selector_repair_work: { ...navigation, diagnostic_ref: "/selector_issues/0" },
      selector_issues: [selectorRepairIssueWithoutRepeatedDetails(issue)],
      ...selectorWorkNextStep(work),
      next_tools: issue.next_tools ?? ["read_target_selectors", "get_target_context", "stage_target_selector_draft"],
      writable_paths: work.diagnostic.writable_paths,
      do_not_edit: "不可变原文、编译产物、历史计数和预算",
      instruction: "当前仍有作者待办，本次未执行阶段或完整检查，原计数不变。先按顶层 next_tool 和 next_tool_arguments 读取点名记录，核对必要原文并保存真实修复；保存后跟随最新待办。不要仅改推进参数重试，也不要为刷新问题而检查未修改草稿。",
    };
  }

  async selectorRepairWorkSnapshot(): Promise<SelectorBlockerObservation[]> {
    const work = await this.selectorRepairWork();
    if (!work) return [];
    const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
    const { cached } = await this.currentFieldDiagnostics();
    const selection = selectSelectorRepairFocus(selectorIssueToolDiagnostics(cached.issues), selectors, work);
    if (!selection) return [];
    const [registry, state] = await Promise.all([this.workspace.readSourceSpanRegistry(), this.workspace.readState()]);
    const read = work.record_read?.arguments;
    const row = read ? (selectors as any)[read.collection]?.find((row: any) => selectorRecordReadKey(read.collection as any, row) === read.key) : undefined;
    const spanIds = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("span:")) spanIds.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(row);
    selection.probe.evidence_ids = unique([...selection.probe.evidence_ids,
      ...registry.spans.filter(span => spanIds.has(span.span_id)).map(span => span.evidence_id)]);
    return selectorBlockerObservations([selection.probe], selectors, registry,
      new Set(state.opened_evidence_ids), state.opened_evidence_window_keys);
  }

  async recordSelectorRepairProgress(before: readonly SelectorBlockerObservation[] | undefined,
    after: readonly SelectorBlockerObservation[] | undefined) {
    if (!before || !after || !before.length && !after.length) return undefined;
    const file = join(this.workspace.root, "selector-repair-work.json");
    const saved = await readJson<any>(file);
    // Observe only the assigned obligation: untouched later work must not stall
    // merely because another record is being completed. Prior histories stay saved.
    const result = observeSelectorBlockers(saved.convergence, before, after);
    const currentIds = new Set(result.history.blockers.map(row => row.identity));
    const history = { blockers: [...result.history.blockers, ...(saved.convergence?.blockers ?? [])
      .filter((row: SelectorBlockerHistory["blockers"][number]) => !currentIds.has(row.identity))] };
    await atomicWriteJson(file, { ...saved, convergence: history });
    await this.workspace.appendEvent("selector_repair_work_progress", {
      focus: saved.focus, relevant_progress: result.progress, stalled: result.stalled,
      before, after, historical_counts_preserved: true,
    });
    return { ...result, history };
  }

  /** Current author diagnostics, independent of full-stage checks and their historical snapshots. */
  private async currentFieldDiagnosticPage(input: Record<string, unknown>): Promise<ToolResponse> {
    const inputs = await this.currentFieldDiagnosticInputs();
    const common = { full_stage_check_performed: false, budget_consumed: false, author_draft_mutation: false,
      validation_scope: "selector_structure_and_reference_consistency", global_completeness_checked: false };
    if (input.field_diagnostic_fingerprint !== undefined && input.field_diagnostic_fingerprint !== inputs) return {
      ...common, ok: false, error: "selector_field_diagnostic_page_stale",
      actual: { requested_fingerprint: input.field_diagnostic_fingerprint, current_fingerprint: inputs },
      expected: { field_diagnostic_fingerprint: inputs }, writable_paths: [],
      next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 },
      instruction: renderFeedback({ kind: "stale_diagnostic", constraint: "本频道旧游标已不能指向当前字段；原样使用next_tool及其完整参数。" }),
    };
    const { reused, cached } = await this.currentFieldDiagnostics(inputs);
    const full = input.field_diagnostic_detail_mode === "full";
    const page = selectorIssueToolPage(cached.issues, full ? 1 : SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT,
      Math.max(0, Math.floor(Number(input.field_diagnostic_cursor ?? 0) || 0)),
      { tool: "get_target_context", arguments: { field_diagnostic_fingerprint: inputs,
        ...(full ? { field_diagnostic_detail_mode: "full" } : {}) }, cursor_field: "field_diagnostic_cursor" });
    return { ...common, ok: true, diagnostics_reused: reused, field_diagnostic_fingerprint: inputs,
      selector_repair_work: await this.selectorRepairWork(),
      selector_issues: page.issues, selector_issue_page: page.page,
      ...(full ? { diagnostic_detail_mode: "full" } : {}),
      field_diagnostic_read: { tool: "get_target_context", arguments: { field_diagnostic_fingerprint: inputs } },
      next_diagnostic_page: page.page.next_cursor === null ? null : { next_tool: "get_target_context",
        next_tool_arguments: { field_diagnostic_cursor: page.page.next_cursor, field_diagnostic_fingerprint: inputs } },
      instruction: renderFeedback({ kind: "current_diagnostic", constraint: "字段频道只检查当前结构、必填、格式及声明引用一致性，相同输入复用缓存，不改读取登记或计数。空列表不表示业务或完整阶段通过。" }),
    };
  }

  private async savedSelectorDiagnosticPage(input: Record<string, unknown>): Promise<ToolResponse> {
    const path = join(this.workspace.root, "saved-selector-diagnostics.json");
    const scope = input.saved_diagnostic_scope ?? "local";
    if (!["local", "deferred"].includes(String(scope))) return { ok: false, terminal: false,
      error: "saved_selector_diagnostic_scope_invalid", actual: scope, expected: ["local", "deferred"],
      writable_path: "saved_diagnostic_scope", next_tool: "get_target_context",
      next_tool_arguments: { saved_diagnostic_scope: "local", saved_diagnostic_cursor: 0 },
      instruction: "只将 saved_diagnostic_scope 改为 local 或 deferred，使用返回的分页参数读取，不触发阶段检查。",
      budget_consumed: false, full_stage_check_performed: false };
    const snapshot = await pathExists(path) ? await readJson<{
      schema_version: string; job_id: string; target_id: string; revision: number;
      contract_version: string; inputs_fingerprint: string; touched_paths: string[];
      local_issues: unknown[]; deferred_issues: unknown[];
    }>(path) : undefined;
    const currentFingerprint = await this.stageDiagnosticInputsFingerprint();
    if (!snapshot || snapshot.schema_version !== "saved-selector-diagnostics/v1"
      || snapshot.job_id !== this.workspace.jobId || snapshot.target_id !== this.workspace.targetId
      || snapshot.revision !== this.workspace.revision || snapshot.contract_version !== SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
      || !Array.isArray(snapshot.local_issues) || !Array.isArray(snapshot.deferred_issues) || !Array.isArray(snapshot.touched_paths)
      || snapshot.inputs_fingerprint !== currentFingerprint) return {
      ok: false, terminal: false, error: "saved_selector_diagnostic_checkpoint_stale",
      budget_consumed: false, full_stage_check_performed: false,
      actual: { snapshot_present: Boolean(snapshot), matches_current_inputs: snapshot?.inputs_fingerprint === currentFingerprint,
        diagnostic_contract_version: snapshot?.contract_version ?? "missing" },
      expected: { diagnostic_contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION, snapshot: "same_revision_and_current_inputs" },
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", cursor: 0 },
      instruction: renderFeedback({ kind: "stale_diagnostic", constraint: "该保存快照不存在、身份不符或依赖已变。按当前key核对实际作者记录；下一次真实保存返回当前局部诊断，不重放未修改保存来恢复旧详情。" }),
    };
    const issues = scope === "local" ? snapshot.local_issues : snapshot.deferred_issues;
    const page = selectorIssueToolPage(issues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT,
      Math.max(0, Math.floor(Number(input.saved_diagnostic_cursor ?? 0) || 0)),
      { tool: "get_target_context", arguments: { saved_diagnostic_scope: scope }, cursor_field: "saved_diagnostic_cursor" });
    const nextScope = page.page.next_cursor !== null ? scope : scope === "local" && snapshot.deferred_issues.length ? "deferred" : null;
    return { ok: true, validation_scope: "staged_selector_records", diagnostic_scope: scope,
      snapshot_matches_current_inputs: true, touched_paths: snapshot.touched_paths,
      full_stage_check_performed: false, budget_consumed: false, global_completeness_checked: false,
      actual: { local_issue_count: snapshot.local_issues.length, deferred_nonlocal_issue_count: snapshot.deferred_issues.length },
      selector_issues: page.issues, issue_page: { ...page.page,
        required_action: "按 next_diagnostic_page 读取同次保存的下一页，不运行完整校验。" },
      next_diagnostic_page: nextScope ? { next_tool: "get_target_context", next_tool_arguments: {
        saved_diagnostic_scope: nextScope, saved_diagnostic_cursor: page.page.next_cursor ?? 0,
      } } : null,
      instruction: renderFeedback({ kind: "readonly_page", constraint: "本页是一次真实保存的local/deferred诊断快照；归组数不替代原issue_count，不执行编译或完整阶段检查。" }),
    };
  }

  private async stageDiagnosticPage(input: Record<string, unknown>): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    const checkpoint = state.selector_protocol?.last_stage_diagnostics;
    const matchesCurrentInputs = checkpoint ? checkpoint.inputs_fingerprint === await this.stageDiagnosticInputsFingerprint() : true;
    const matchesCurrentContract = stageFocusUsesCurrentContract(state);
    if (checkpoint && (!matchesCurrentInputs || !matchesCurrentContract)) {
      const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
      return {
      ok: false, terminal: false, error: "selector_stage_diagnostic_checkpoint_stale", budget_consumed: false, full_stage_check_performed: false,
      actual: { checked_inputs_fingerprint: checkpoint.inputs_fingerprint, matches_current_inputs: matchesCurrentInputs,
        diagnostic_contract_version: checkpoint.contract_version ?? "legacy_unknown", matches_current_contract: matchesCurrentContract },
      expected: { diagnostic_contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION },
      historical_repair_navigation: historicalSelectorRepairNavigation(selectors, state),
      next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 },
      instruction: renderFeedback({ kind: "stale_diagnostic", constraint: "旧阶段actual、修法及数字路径均不返回；按next_tool取得当前字段诊断，不为翻页重新完整检查。" }),
      };
    }
    const issues = (checkpoint?.issues ?? state.selector_protocol?.last_stage_issues ?? []).map(currentReferenceOriginScopeIssue);
    const cursor = Math.max(0, Math.floor(Number(input.stage_diagnostic_cursor ?? 0) || 0));
    const page = selectorIssueToolPage(issues, SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, cursor,
      { tool: "get_target_context", arguments: {}, cursor_field: "stage_diagnostic_cursor" });
    return {
      ok: true, terminal: false, budget_consumed: false, full_stage_check_performed: false,
      validation_scope: checkpoint ? "saved_stage_diagnostics" : "legacy_stage_focus_only",
      complete_diagnostics_available: Boolean(checkpoint), selector_issues: page.issues,
      selector_issue_page: { ...page.page,
        required_action: "read_saved_diagnostics_without_rechecking_then_save_evidence_based_repairs",
        index_instruction: "这些详情来自已经执行的检查，读取不重新验证，也不消耗阶段次数。先读取需要的诊断页；草稿、登记、证据、表结构或访问策略改变后旧完整诊断失效，不能把它当作当前 actual 或修复通过。",
      },
      next_diagnostic_page: page.page.next_cursor === null ? null : {
        next_tool: "get_target_context", next_tool_arguments: { stage_diagnostic_cursor: page.page.next_cursor },
      },
      instruction: checkpoint
        ? "按诊断实际条件、原文及准确作者 key 保存修复。翻页仅返回本次已执行检查的详情，不重检、不改草稿或计数，也不授予完整候选通过。"
        : "历史检查点只有部分定点摘要，没有保存完整诊断，未列出的问题不代表通过，也不能把摘要当成新的 actual。按摘要中的准确作者读取地址及已保存 references 的完整 destinations 核对相关接收项；不要为取得缺失页单独重检，先保存有原文依据的真实修复。",
    };
  }

  private async targetContext(input: Record<string, unknown>): Promise<ToolResponse> {
    if (input.component_plan_occurrence_id !== undefined) {
      const id = String(input.component_plan_occurrence_id), cursor = Number(input.component_plan_cursor ?? 0);
      if (!Number.isInteger(cursor) || cursor < 0) return { ok: false, error: "component_plan_cursor_invalid", actual: cursor,
        expected: "非负整数", writable_paths: ["/component_plan_cursor"], next_tool: "get_target_context",
        next_tool_arguments: { component_plan_occurrence_id: id, component_plan_cursor: 0 },
        instruction: "按返回游标读取已保存计划，不需要重新扫描正文或重做业务判断。" };
      const store = await readComponentPlans(this.workspace.root, this.evidence.source.sha256);
      return { ok: true, component_plan: componentPlanView(store.plans[id], id, cursor, 4, true), budget_consumed: false };
    }
    if (input.discovery_context_cursor !== undefined) return this.discoveryContextPage(input);
    if (input.field_diagnostic_cursor !== undefined) return this.currentFieldDiagnosticPage(input);
    if (input.diagnostic_detail_key !== undefined || input.diagnostic_detail_path !== undefined || input.diagnostic_detail_cursor !== undefined) {
      return await readDiagnosticArrayPage(input, {
        root: this.workspace.root, job_id: this.workspace.jobId, target_id: this.workspace.targetId,
        revision: this.workspace.revision, inputs_fingerprint: await this.stageDiagnosticInputsFingerprint(),
      }) as ToolResponse;
    }
    if (input.saved_diagnostic_scope !== undefined && input.saved_diagnostic_cursor === undefined) return {
      ok: false, terminal: false, error: "saved_selector_diagnostic_cursor_required",
      actual: { saved_diagnostic_scope: input.saved_diagnostic_scope, saved_diagnostic_cursor: "missing" },
      expected: { saved_diagnostic_cursor: "nonnegative_integer" }, writable_path: "saved_diagnostic_cursor",
      next_tool: "get_target_context", next_tool_arguments: { saved_diagnostic_scope: input.saved_diagnostic_scope, saved_diagnostic_cursor: 0 },
      instruction: "保存诊断 scope 必须与 saved_diagnostic_cursor 同传；按返回参数补游标，不能改用阶段检查取得详情。",
      full_stage_check_performed: false, budget_consumed: false,
    };
    if (input.saved_diagnostic_cursor !== undefined) return this.savedSelectorDiagnosticPage(input);
    if (input.stage_diagnostic_cursor !== undefined) return this.stageDiagnosticPage(input);
    const accessByEvidenceId = await this.evidenceAccessIndex(true);
    const inaccessibleTableEvidenceIds = this.inaccessibleTableFragmentEvidenceIds(accessByEvidenceId);
    const accessibleEvidence = this.evidence.evidence.filter((record) =>
      !inaccessibleTableEvidenceIds.has(record.evidence_id)
      && this.evidenceAccess(record, accessByEvidenceId).access_mode !== "isolated_reference"
    );
    const accessibleEvidenceIds = new Set(accessibleEvidence.map((record) => record.evidence_id));
    const page = boundedPage(
      this.evidence.evidence
        .filter((record) => !inaccessibleTableEvidenceIds.has(record.evidence_id))
        .map((record) =>
        evidenceResource(record, this.evidenceAccess(record, accessByEvidenceId))
      ),
      input,
    );
    const cursor = Math.max(0, Number(input.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25) || 25));
    const contextPageKey = `${cursor}:${limit}`;
    const investigationCheckpoint = await readJson<Record<string, unknown>>(join(this.workspace.root, "investigation-checkpoint.json"))
      .then(note => note.evidence_fingerprint === this.evidence.evidence_fingerprint ? note : { stale: true, instruction: "原文版本已变；请重新核验调查结论。" }).catch(() => null);
    const referenceToolFingerprint = investigationCheckpoint ? await referenceToolImplementationFingerprint() : undefined;
    const recordedToolFingerprint = investigationCheckpoint?.reference_tool_contract_fingerprint;
    const referenceToolRecovery = investigationCheckpoint && !investigationCheckpoint.stale ? {
      reference_tool_recovery: {
        current_fingerprint: referenceToolFingerprint,
        recorded_fingerprint: recordedToolFingerprint ?? null,
        status: recordedToolFingerprint === referenceToolFingerprint ? "same_implementation" : recordedToolFingerprint ? "implementation_changed" : "implementation_unknown",
        instruction: recordedToolFingerprint === referenceToolFingerprint
          ? "摘要中的来源/引用工具错误仅为历史观察；资料和路由状态以当前调用为准，不能用旧工具失败代替实际接收判断。"
          : "来源/引用工具实现已变化或调查交接未记录其指纹。摘要中的工具失败仅属历史；再次认定来源或工具阻塞前，应重新调用对应失败工具取得当前回条，再依据原文自主修正和保存。此标记不计来源阅读、不改变阶段或预算，也不批准业务内容。",
      },
    } : {};
    const state = await this.workspace.readState();
    const selectorSource = await readFile(this.workspace.workingSelectorPath, "utf8");
    const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(selectorSource)).plan;
    const diagnosticInputsFingerprint = state.selector_protocol?.last_stage_diagnostics
      ? await this.stageDiagnosticInputsFingerprint() : undefined;
    const selectorStartup = targetSelectorStartupSnapshot(
      selectors,
      state,
      this.inheritedSelectorReadRequired,
      diagnosticInputsFingerprint,
    );
    const selectorProtocol = publicSelectorProtocol(state.selector_protocol, diagnosticInputsFingerprint);
    const handoffPath = join(this.workspace.root,"modeling-handoff.json");
    const handoff = await pathExists(handoffPath) ? await readJson<Record<string,unknown>>(handoffPath) : undefined;
    if (handoff && (handoff.job_id !== this.workspace.jobId || handoff.target_id !== this.workspace.targetId || handoff.revision !== this.workspace.revision)) {
      throw new Error("modeling_handoff_identity_mismatch");
    }
    const inheritedInstruction = selectorStartup.current_selector_state === "inherited_existing"
      ? selectorStartup.read_target_selectors_required
        ? "当前 revision 有继承的 selector checkpoint。定位和暂存前先 read_target_selectors，保留有效 keyed records，依据原文增量修改或删除，不从空模板重建。"
        : "本会话已经读取继承的 selector checkpoint。保留有效 keyed records，依据原文增量修改。"
      : selectorStartup.current_selector_state === "current_existing"
        ? "当前 revision 已有 selector，先读取再增量修改。文件存在不代表抽取完成；预填只是未验证骨架，草稿仍可能缺项。请核对独立原文判断、保留有效成果并补缺，再完成全量预检、正式提交和封存。"
        : "当前 selector 为空，请从已打开的原文开始建立记录。";
    const externalReferenceSources = this.externalSourceWorkflow
      ? await Promise.all(this.evidence.reference_occurrences.filter(occurrence => occurrence.external_standard).map(async occurrence => {
          const standardNo = occurrence.external_standard!.standard_no;
          const fieldPolicy = externalReferenceFieldPolicy(this.evidence, referenceOccurrenceLiterals(occurrence));
          const userIgnore = await this.externalSourceWorkflow!.ignored?.(standardNo);
          const document = fieldPolicy.literal_only || userIgnore ? undefined : await this.externalSourceWorkflow!.lookup(standardNo);
          const policy = externalReferenceExpansionPolicy(this.evidence, referenceOccurrenceOriginEvidenceIds(occurrence), {
            standard_no: standardNo, ...(occurrence.target_address ? { source_sha256: occurrence.target_address.source_id } : {}),
          });
          const literalOnly = Boolean(userIgnore) || fieldPolicy.literal_only || (policy.nested_external && !document);
          return {
            occurrence_id: occurrence.occurrence_id,
            standard_no: standardNo,
            occurrence_status: occurrence.status,
            ...(occurrence.content_scope ? { content_scope: occurrence.content_scope } : {}),
            resolved_component_count: occurrence.target_evidence_ids.length,
            ...(state.status === "working" && !state.last_valid_fingerprint && !state.last_valid_plan_sha256
              && wholeExternalReferenceScopeReview(occurrence) ? { business_scope_review: wholeExternalReferenceScopeReview(occurrence) } : {}),
            source_status: userIgnore ? "ignored_by_user" : document ? "ready" : literalOnly ? "policy_limited" : "unavailable",
            ...(literalOnly ? { expansion: "literal_only", expansion_reason: userIgnore ? "user_ignored_source" : fieldPolicy.literal_only ? "allowable_deviation_reference" : "nested_source_unavailable" } : {}),
            ...(userIgnore ? { user_ignore: userIgnore, instruction: "用户只忽略当前任务的外部正文获取，正文未核验。先 resolve_external_standard_reference 登记此状态，再完整保留原引用和原字段；不得补造外部条文、删项目或再次请求同一资料。" } : {}),
            ...(document ? { markdown_sha256: document.markdown_sha256 } : {}),
            next_tool: literalOnly && occurrence.external_standard?.expansion === "literal_only"
              ? "read_target_selectors"
              : occurrence.status === "resolved" ? "read_document_reference_evidence" : "resolve_external_standard_reference",
          };
        }))
      : undefined;
    const externalSourceContext = externalReferenceSources?.length ? {
      external_reference_sources: externalReferenceSources,
      external_reference_source_instruction: "这是当前本地资料状态，不是正文读取或业务采用证明。字段策略优先：允许偏差中的外部引用只保留完整引用原文、原字段、数值单位和条件，不查找或解析外部文件，即使本地已有正文也不钻取；只有验收依据中要求的引用进入正文核对，再判断与任务产出的相关性。同一规范在不同字段出现时逐处判断，不得把允许偏差的豁免套到验收依据。ready 时按真实来源解析并读取相关内容，由作者判断与验收对象及产出字段的关系，记录采用位置或不适用理由。policy_limited 表示允许偏差引用不展开，或后续层级本地没有可用原文；未带 literal_only 标记的旧 occurrence 先重新调用 resolve_external_standard_reference 登记策略，随后用 keep_reference/reference_only 保留完整原引用和原字段，target_span_ids 留空，不请求补文件。验收依据中的一级 unavailable 正文依赖仍走补充资料流程。旧调查交接不代替当前状态，不得猜测未展开正文。",
    } : {};
    const resourceTools = [
      ...(this.externalSourceWorkflow ? ["resolve_external_standard_reference"] : []),
      "list_evidence_resources", "search_evidence", "open_evidence",
      "read_document_reference_evidence", "read_reference_facts",
      "batch_search_evidence", "batch_open_evidence", "locate_evidence_span",
      "batch_locate_evidence_spans", "list_global_document_resources", "search_global_document_resources",
      "open_global_document_resource", "open_adjacent_document_resource",
      "register_external_dependency", "resolve_document_reference",
    ].filter((name) => !this.inheritedSelectorReadRequired || !INHERITED_SELECTOR_READ_GATED_TOOLS.has(name));
    const authoringWork = input.source_repair_cursor === undefined && !(await this.selectorRepairWork())
      ? await this.pendingSelectorAuthoringWork() : undefined;
    if (this.returnedTargetContextPages.has(contextPageKey) && input.source_repair_cursor === undefined) {
      return {
        ok: true,
        schema_version: TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
        ...selectorStartup,
        selector_stage: this.selectorStage,
        selector_protocol: selectorProtocol,
        context_page_already_returned: true,
        ...(authoringWork ? { selector_authoring_work: authoringWork, ...selectorWorkNextStep(authoringWork) } : {}),
        target_scope: await this.publicTargetScope(accessByEvidenceId, inaccessibleTableEvidenceIds),
        ...referenceToolRecovery,
        ...externalSourceContext,
        next_resource_cursor: page.next_cursor,
        resource_tools: resourceTools,
        instruction: "本会话已返回这页无正文目录。selector_stage 与 selector_protocol 是当前状态，读取不会重新校验或消耗预算；按当前阶段和最新校验回条继续修复、保存，再重新校验。已有记录用 read_target_selectors，表结构用 read_saved_table_structure/read_table_summary；更多资源元数据用 list_evidence_resources 的其他 cursor。",
      };
    }
    let dispositionCoverage: ReturnType<typeof selectorDispositionCoverage> | undefined;
    try {
      const registry = await this.workspace.readSourceSpanRegistry();
      dispositionCoverage = selectorDispositionCoverage({
        selectors,
        evidence: accessibleEvidence,
        spans: registry.spans.filter((span) => accessibleEvidenceIds.has(span.evidence_id)),
      });
    } catch {
      dispositionCoverage = undefined;
    }
    let currentSourceRepair: Record<string, unknown> | undefined;
    // An explicit read is independent of stage-check history. Recovery may need
    // source/receipt diagnostics while still in primary or sampling; returning
    // null there otherwise sends the author back to an unchanged full check.
    if (input.source_repair_cursor !== undefined || ((handoff || state.lineage?.recovery_kind === "terminal_checkpoint")
      && state.selector_protocol?.stage_retries && ["table", "commit"].includes(this.selectorStage))) {
      const registry = await this.workspace.readSourceSpanRegistry();
      const referenceReceiptIssues = [
        ...registeredDocumentReferenceReceiptIssues(selectors, this.evidence, registry),
        ...unresolvedReferenceDestinationIssues(selectors, this.evidence, registry),
        ...resolvedReferenceDestinationIssues(selectors, this.evidence, registry),
      ]
        .filter(issue => ["selector_registered_reference_receipt_missing", "selector_registered_reference_receipt_duplicate", "selector_reference_destination_required"].includes(issue.code))
        .filter(issue => {
          const occurrence = this.evidence.reference_occurrences.find(row => row.occurrence_id === (issue.details as { occurrence_id?: string })?.occurrence_id);
          return occurrence && referenceOccurrenceOriginEvidenceIds(occurrence).every(id => accessibleEvidenceIds.has(id));
        });
      const uncoveredRequiredIds = [...new Set([
        ...(dispositionCoverage?.uncovered_required_ids ?? []),
        ...requiredReferenceAnchorOnlyEvidenceIds(selectors, this.evidence, registry).filter(id => accessibleEvidenceIds.has(id)),
        ...requiredReferenceFieldOnlyEvidenceIds(selectors, this.evidence, registry).filter(id => accessibleEvidenceIds.has(id)),
      ])];
      const sourceIssues = classifyCompilerInvariantIssues(
        selectors,
        registry,
        uncoveredRequiredIds.map(evidenceId => ({
          code: "compiler_unhandled_evidence", path: "/evidence_dispositions",
          message: "Compiler must materialize every required source disposition",
          details: { evidence_ids: [evidenceId] },
        })),
      );
      // Apply source visibility before collecting either hard diagnostics or
      // model observations; an advisory must not reveal an inaccessible source.
      const readableFieldRoleIssues = (await this.targetFieldRoleIssues(selectors, registry)).filter(issue => {
        const details = (issue as { details?: { actual?: { evidence_id?: string }; expected_candidates?: Array<{ evidence_id?: string }> } }).details;
        return details?.actual?.evidence_id && accessibleEvidenceIds.has(details.actual.evidence_id)
          && (details.expected_candidates ?? []).every(candidate => candidate.evidence_id && accessibleEvidenceIds.has(candidate.evidence_id));
      }).map(issue => {
        const record = issue as { code: string; path: string; message: string; details?: { item_key?: string } };
        const key = record.details?.item_key;
        const argumentsForRead = key && selectors.items.filter(item => item.key === key).length === 1
          ? { collection: "items", key } : { collection: "items", cursor: 0 };
        return { ...record, next_tool: "read_target_selectors", next_tool_arguments: argumentsForRead,
          save_tool: "stage_target_selector_draft",
          ...("key" in argumentsForRead ? { record_read: { tool: "read_target_selectors", arguments: argumentsForRead } } : {}) };
      });
      const fieldRoleIssues = this.structuralIssues(readableFieldRoleIssues);
      const issues = (await this.routeSelectorCompilerEvidenceReads([
        ...fieldRoleIssues.map(issue => ({ ...issue, owner: "selector_input_error" })), ...sourceIssues, ...classifySelectorIssues("selector-local", referenceReceiptIssues),
      ])).map(issue => actionableSelectorIssue(issue, selectors));
      const repairCursor = Math.max(0, Math.floor(Number(input.source_repair_cursor ?? 0) || 0));
      const repairLimit = Math.min(SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT, Math.max(1, Number(input.source_repair_limit ?? 1) || 1));
      const issuePage = selectorIssueToolPage(issues, repairLimit, repairCursor);
      const visibleIssues = issuePage.issues.map(selectorRepairIssueWithoutRepeatedDetails);
      if (issues.length) currentSourceRepair = {
        validation_scope: fieldRoleIssues.length ? "field_ownership_and_source_reference_receipt_coverage"
          : referenceReceiptIssues.length ? "source_and_reference_receipt_coverage" : "source_disposition_coverage", budget_consumed: false, full_stage_check_performed: false,
        actual: { counts: targetSelectorCounts(selectors), issue_count: issues.length },
        stage_retry: state.selector_protocol?.stage_retries,
        selector_issues: visibleIssues, issue_page: {
          ...issuePage.page,
          reported_issue_utf8_bytes: visibleIssues.reduce<number>((bytes, issue) => bytes + Buffer.byteLength(JSON.stringify(issue ?? null), "utf8"), 0),
          required_action: "read_source_repair_details_then_save_evidence_based_repairs_before_stage_check",
          index_instruction: "索引不代替原文或详细修复依据。用 next_diagnostic_page 的参数读取后续详情；诊断游标与资源 cursor 分开，翻页不需要重新校验或修改草稿。草稿修改后用 source_repair_cursor=0 重新读取当前列表，旧游标不代表固定来源身份。",
        },
        next_diagnostic_page: issuePage.page.next_cursor === null ? null : {
          next_tool: "get_target_context",
          next_tool_arguments: { source_repair_cursor: issuePage.page.next_cursor, source_repair_limit: repairLimit },
        },
        ...selectorRepairRoute(issuePage.issues),
        instruction: "这些是当前草稿的字段来源归属错误、尚未承载或显式处置的可访问来源及缺失、重复或未闭合的引用作者回执，按当前规则重新生成，不沿用历史截断修法。按每条诊断的实际读取参数核对原文及作者记录；需要更多详情时用 next_diagnostic_page，只读翻页不触发阶段检查。先保存真实修复，再重试阶段检查。stage_retry 给出保留的最佳结果和停滞次数；修好一条不保证完整检查优于最佳结果，未改善仍按既有上限终止。只有完整阶段校验的实际改善才能清除停滞，不要把业务来源降为 context/ignored 来消错。未解析引用补回执不代表目标定位或完整校验通过。",
      };
    }
    if (input.source_repair_cursor !== undefined) {
      const { resume_focus: _savedFocus, ...currentStartup } = selectorStartup;
      return {
        ok: true, schema_version: TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
        ...currentStartup, selector_protocol: selectorProtocol,
        target_scope: await this.publicTargetScope(accessByEvidenceId, inaccessibleTableEvidenceIds),
        current_source_repair: currentSourceRepair ?? null,
        ...(currentSourceRepair ? {} : { next_repair_record_read: selectorStartup.historical_repair_navigation?.record_reads[0] ?? null }),
        instruction: "本次只返回当前可访问字段归属、来源处置和引用作者回执的修复详情，不重复返回旧 resume_focus，不检查完整阶段或修改草稿、阅读登记及配额。detail_fields_at_issue_level 指明哪些重复详情已完整保留在该诊断顶层；未截断修法或实际值。来源索引只给精确身份，不决定来源分类，详细修法仍按诊断页读取。current_source_repair=null 表示当前没有可展示的这些有限诊断，不表示业务完整或校验通过。",
      };
    }
    const tableStructure = await this.projectAccessibleTableStructurePlan(
      await this.readTableStructurePlan(),
    );
    const tableExpansion = tableExpansionState(
      this.evidence,
      await this.workspace.readSourceSpanRegistry(),
      selectors,
      tableStructure,
      accessibleEvidenceIds,
    );
    const accessibleTableFragmentIds = new Set([
      ...this.evidence.table_fragments,
      ...(this.evidence.scope.table_navigation_candidates ?? []),
    ].filter((fragment) => this.tableFragmentEvidenceIds(fragment).every((evidenceId) =>
      accessibleEvidenceIds.has(evidenceId)
    )).map((fragment) => fragment.fragment_id));
    const publicTableWorkPackages = tableExpansion.work_packages.flatMap((workPackage) => {
      const rows = workPackage.rows.filter((row) => accessibleEvidenceIds.has(row.evidence_id));
      if (rows.length === 0) return [];
      return [{
        obligation_id: `table-expansion:${sha256Json({
          table_id: workPackage.table_id,
          row_ids: rows.map((row) => row.row_id),
        })}`,
        table_id: workPackage.table_id,
        row_count: rows.length,
        pending_row_ids: rows.filter((row) => row.disposition === "pending").map((row) => row.row_id),
        core_properties: unique(rows.map((row) => row.parent_property)),
      }];
    });
    const targetScope = await this.publicTargetScope(
      accessByEvidenceId,
      inaccessibleTableEvidenceIds,
    );
    const output = {
      ok: true,
      schema_version: TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
      source_document: modelSourceDocumentContext(this.evidence.source, this.sourcePdfDisplayName),
      ...selectorStartup,
      selector_stage: this.selectorStage,
      ...(await pathExists(join(this.workspace.root, "selector-repair-work.json"))
        ? { selector_repair_work: await this.selectorRepairWork() } : {}),
      investigation_checkpoint: investigationCheckpoint,
      ...referenceToolRecovery,
      ...(investigationCheckpoint ? {
        investigation_checkpoint_advisory_only: true,
        investigation_checkpoint_instruction: "调查交接包含模型观察及未验证推断，不是程序约束、验证结论或终止授权。笔记中写需要上游修正不证明作者路径不可修复；按当前工具的实际条件核对，不能让历史推断覆盖当前回条，也不能忽略真实的不可写或不可恢复条件。",
      } : {}),
      ...(currentSourceRepair ? { current_source_repair: currentSourceRepair } : {}),
      table_structure_checkpoint: {
        confirmed_tables: tableStructure.tables.filter((table) => table.status === "confirmed").map((table) => ({ table_key: table.table_key, fragment_ids: table.fragment_ids })),
        pending_tables: tableStructure.tables.filter((table) => table.status !== "confirmed").map((table) => ({ table_key: table.table_key, fragment_ids: table.fragment_ids, review_rows: table.review_rows })),
        instruction: tableStructure.tables.some((table) => table.status === "confirmed")
          ? "已有已确认的表结构；需要完整决定时调用 read_saved_table_structure。复用已确认 fragment，继续处理 pending/review 行。"
          : tableStructure.tables.length
            ? "当前登记的表结构尚待确认；按 pending_tables 选择表格读取和判断，需要完整现状时调用 read_saved_table_structure。"
            : "当前没有登记的表结构。",
      },
      current_table_work_packages: publicTableWorkPackages,
      ...(authoringWork ? { selector_authoring_work: authoringWork, ...selectorWorkNextStep(authoringWork) } : {}),
      ...(handoff ? {checkpoint_handoff:{
        ...handoff,
        snapshot_status: sha256Text(selectorSource) === (handoff.proof as {selector_sha256?:string})?.selector_sha256
          ? "restored_checkpoint_unchanged" : "updated_since_restore",
        proof_applies_to: "original_restoration_only",
        selector_stage: state.selector_stage,
        item_inventory: selectors.items.map(item => ({key:item.key,name:item.name,lot_key:item.lot_key})),
        lots: selectors.lots,
        shared_sampling_rules: selectors.sampling_rules,
        references: selectors.references,
        source_dispositions: selectors.source_dispositions,
        residual_source_dispositions: selectors.residual_source_dispositions,
        current_issue_state: {active_cluster:state.repair?.active_cluster ?? null,last_issue_owner:state.selector_protocol?.last_issue_owner ?? ""},
        issue_instruction: "unresolved 描述历史恢复点。若有 current_source_repair，先按其读取参数核对并保存真实修复，再重跑预检；恢复证明不代表验证通过。",
      }} : {}),
      target_scope: targetScope,
      ...(selectorStartup.current_selector_state === "blank"
        ? { blank_selector: initialTargetSelectorPlan(this.evidence) }
        : {}),
      resource_inventory: page.rows,
      ...externalSourceContext,
      governing_context: {
        evidence_ids: (this.evidence.scope.governing_context_evidence_ids ?? [])
          .filter((evidenceId) => accessibleEvidenceIds.has(evidenceId)),
        exhaustive: false,
        instruction: "这些上游共同规定只是导航候选。选择 sampling fallback 前，打开原文判断是否适用；未找到时可用不同关键词检索全文，本列表缺少某规则不能证明它不存在。",
      },
      discovery_context: await this.discoveryContextPage({ discovery_context_limit: 5 }),
      next_resource_cursor: page.next_cursor,
      navigation_candidate_counts: {
        sampling: accessibleEvidence.filter((record) => record.role === "sampling_rule").length
          + samplingNavigationCandidates(this.evidence)
            .filter((candidate) => typeof candidate.evidence_id === "string"
              && accessibleEvidenceIds.has(candidate.evidence_id)).length,
        references: this.evidence.reference_occurrences.length
          + (this.evidence.scope.reference_candidates?.length ?? 0),
        tables: accessibleTableFragmentIds.size,
      },
      selector_protocol: selectorProtocol,
      resource_tools: resourceTools,
      // Content obligations belong to explicit submission,
      // not to intermediate draft saves or stage transitions.
      primary_disposition_requirement: {
        coverage_unit: "evidence_record",
        bound_record_is_semantic_coverage_approval: false,
        evidence_requiring_disposition: (dispositionCoverage?.required_evidence_ids
          ?? accessibleEvidence.filter(evidenceRequiresSelectorDisposition).map((record) => record.evidence_id)
        ).length,
        uncovered_required_count: dispositionCoverage?.uncovered_required_ids.length,
        residual_covers_unbound: Boolean(dispositionCoverage?.residual),
        enforced_at: "explicit_submission",
        draft_stage_gate: false,
        rule: "A bound evidence record means at least one span was selected; it does not prove that all requirements in the record were extracted. Each save checks only touched records, each stage transition checks that stage, and neither proves global completion. Full compiler/strict validation must pass at final commit before sealing.",
        bulk_escape: "source_dispositions 与其他集合按实际序列化字节限制分批，没有固定 8 条上限。residual_source_dispositions 可登记真正的非验收背景，但不能证明语义覆盖或取消 target_scope 内的内容。不能因为对象或方法需要另一个检验批就排除它；提交前按完整 target_scope 核对处置。",
        residual_disposition_is_coverage_approval: false,
      },
      scope_contract: {
        target_is_single_inspection_lot: false,
        preserve_in_scope_objects_and_conditions: true,
        exclusion_requires_source_based_reason: true,
        separately_listed_items_must_remain_separate: true,
        further_splitting_allowed: true,
        instruction: "以 target_scope 为任务范围，不能用第一个检验批的名称缩小任务。范围内其他要求可另建 lot/item；适用性未知应保持条件或未解决状态，不能静默排除。提交时核对 residual 背景声明。",
      },
      instruction: `${inheritedInstruction} ${RESOURCE_ACCESS_INSTRUCTION} 自主选择调查路径，按需局部读取；暂存后立即检查本次记录，切阶段检查当前阶段完整性。局部通过不代表全局候选完整，仍需全量预检、正式提交验证与封存。格式、kind 和 locator 只用于导航。`,
    };
    const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    if (outputBytes > MAX_PATCH_SERIALIZED_BYTES) {
      const fixedBytes = Buffer.byteLength(JSON.stringify({ ...output, resource_inventory: [] }), "utf8");
      let smallerLimit = Math.max(1, Math.floor(Math.min(limit, page.rows.length) / 2));
      while (smallerLimit > 1 && Buffer.byteLength(JSON.stringify({ ...output, resource_inventory: page.rows.slice(0, smallerLimit) }), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
        smallerLimit = Math.max(1, Math.floor(smallerLimit / 2));
      }
      const resourcePageCanFit = Buffer.byteLength(JSON.stringify({ ...output, resource_inventory: page.rows.slice(0, smallerLimit) }), "utf8") <= MAX_PATCH_SERIALIZED_BYTES;
      return { ok: false, terminal: false, error: "target_context_payload_limit_internal",
        full_stage_check_performed: false, budget_consumed: false,
        actual: { serialized_bytes: outputBytes, fixed_context_bytes: fixedBytes, resource_inventory_bytes: Buffer.byteLength(JSON.stringify(page.rows), "utf8"),
          cursor, requested_limit: limit, returned_resource_count: page.rows.length },
        expected: { max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES }, max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES,
        ...(resourcePageCanFit
          ? { next_tool: "get_target_context", next_tool_arguments: { cursor, limit: smallerLimit }, writable_paths: ["cursor", "limit"],
            instruction: "本页资源目录与固定上下文合计超过实际字节上限。按 next_tool_arguments 保留原 cursor、缩小 limit 重读本页，不跳到后续 cursor 丢失这些资源；本次未重新验证或登记阅读，不消耗阶段次数。" }
          : { next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", cursor: 0 },
            additional_read: { tool: "get_target_context", arguments: { source_repair_cursor: 0, source_repair_limit: 1 } },
            instruction: "固定上下文与最小资源页合计仍超过上限；降低资源 limit 不能保证恢复。先按 next_tool_arguments 读取当前作者目录，按 additional_read 单独读取有限修复诊断，再用 list_evidence_resources 分页读取完整资源元数据；这些读取不替代完整阶段校验。" }),
      };
    }
    this.returnedTargetContextPages.add(contextPageKey);
    return output;
  }

  private async listEvidenceResources(input: Record<string, unknown>): Promise<ToolResponse> {
    const accessByEvidenceId = await this.evidenceAccessIndex(true);
    if (typeof input.context_for_evidence_id === "string" && input.context_for_evidence_id) {
      const source = this.evidence.evidence.find(record => record.evidence_id === input.context_for_evidence_id);
      if (!source) {
        const document = await this.readGlobalDocumentEvidence();
        const resources = this.globalDocumentSourceResources(document, await this.isolatedGlobalDocumentRanges(document));
        const resource = resources.find(row => row.atom_id === input.context_for_evidence_id);
        const targetKeys = resource?.target_keys ?? [...new Set(resources.filter(row => row.parent_atom_id === input.context_for_evidence_id).flatMap(row => row.target_keys))];
        if (targetKeys.length) return { ok: false, error: "evidence_context_directory_unavailable", budget_consumed: false,
          context_directory: { available: false, unavailable_reasons: ["reference_access_required"] },
          ...this.globalDocumentIsolationRoute(targetKeys),
          ...(targetKeys.length === 1 ? { next_tool: "read_reference_facts", next_tool_arguments: { target_key: targetKeys[0] } }
            : { next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 24 } }),
          instruction: "该全文来源与隔离引用范围重叠，不提供同条目录或开放正文。按routed_references进入对应隔离目录，不从条号外观猜归属。" };
        if (resource) return { ok: false, error: "evidence_context_directory_unavailable", budget_consumed: false,
          actual: { evidence_id: input.context_for_evidence_id, registered_in_current_evidence: false, known_global_resource: true },
          context_directory: { available: false, unavailable_reasons: ["not_registered_in_target"] },
          source_access: { atom_id: resource.atom_id, access_mode: "direct", read_tool: "open_global_document_resource", tool_arguments: { atom_id: resource.atom_id } },
          next_tool: "open_global_document_resource", next_tool_arguments: { atom_id: resource.atom_id },
          instruction: "这是合法全文导航来源，尚未登记成当前target的evidence，不能列同条目录或直接定位业务span。需要正文时按精确入口读取；已有正文则可按原有登记流程自行判断用途，不要求为取得同条目录重读。不自动登记、不扩展范围、不猜条文。" };
        return { ...this.unknownLocatorEvidence(input.context_for_evidence_id, "list_evidence_resources", "/context_for_evidence_id"),
          ok: false, error: "evidence_context_directory_unavailable", context_directory: { available: false, unavailable_reasons: ["unknown_source_identity"] } };
      }
      const access = this.evidenceAccess(source, accessByEvidenceId);
      const directory = evidenceContextDirectory(source, access);
      if (!directory.available) {
        const toolArguments = access.access_mode === "direct" ? { evidence_id: source.evidence_id, cursor: 0 }
          : access.access_mode === "inline_reference" ? { target_key: access.target_key, cursor: 0 } : { target_key: access.target_key };
        const delivered = access.access_mode === "direct" && this.sourceDecisionDelivery(source).source_delivery.current_execution_complete;
        return {
          ok: false, error: "evidence_context_directory_unavailable", budget_consumed: false,
          actual: { evidence_id: source.evidence_id, registered_in_current_evidence: true,
            ...(access.access_mode === "direct" ? { evidence_scope: source.evidence_scope, registered_clause_id: source.clause_id ?? null } : {}) },
          expected: "同条目录仅按直接主资料中已登记的唯一clause_id分组；来源合法性与这个目录能力分开。",
          context_directory: directory, source_access: { evidence_id: source.evidence_id, ...access, tool_arguments: toolArguments },
          writable_paths: ["/context_for_evidence_id"],
          ...(access.access_mode === "direct" ? { quote_locator: { tool: "locate_evidence_span", fixed_arguments: { evidence_id: source.evidence_id },
            author_required_parameters: ["quote"], instruction: "已有正文或精确片段时，直接定位模型自己选择的原文；不需要先列同条目录。定位仍检查已读窗口及原文一致性。" } } : {}),
          ...(delivered ? { next_action: { kind: "choose_source_fragment", decision_owner: "model", instruction: "本次已交付该来源正文。自行选择需要的片段并按quote_locator定位；具体缺口才补读source_access，不强制重读。" } }
            : { next_tool: access.read_tool, next_tool_arguments: toolArguments }),
          instruction: access.access_mode === "direct"
            ? "来源合法但不具备同条目录条件，具体原因见context_directory；非primary与缺唯一登记条号是不同原因，不代表无适用内容。已有正文可直接选择并定位精确片段，需要正文才按source_access读取当前同一来源，不退回全局第一页、不猜相邻归属。"
            : "来源受引用读取政策约束，按source_access的精确入口取得目录或正文；不能用同条目录、open_evidence或定位工具读取未交付的隔离正文。完整读取后可按resolved_rows.quote_locator定位模型选择的精确片段，不需要同条目录。",
        };
      }
      const resources = this.evidence.evidence
        .filter(record => record.evidence_scope === "primary" && record.clause_id === source.clause_id
          && this.evidenceAccess(record, accessByEvidenceId).access_mode === "direct")
        .map(record => ({
          evidence_id: record.evidence_id, clause_id: record.clause_id, locator: record.locator,
          read_tool: "open_evidence", tool_arguments: { evidence_id: record.evidence_id, cursor: 0 },
          context_directory: evidenceContextDirectory(record, access),
        }));
      const page = boundedPage(resources, input);
      const response = {
        ok: true, metadata_only: true, budget_consumed: false,
        context_directory: directory,
        context: { basis: "exact_primary_clause_id", evidence_id: source.evidence_id,
          clause_id: source.clause_id, resource_count: resources.length },
        resources: page.rows, next_cursor: page.next_cursor,
        page_read_tool: "batch_open_evidence",
        page_read_arguments: { evidence_ids: page.rows.map(record => record.evidence_id) },
        instruction: "仅列当前主资料中 clause_id 完全相同的来源元数据，保持原目录顺序；没有读取正文或判定统领、字段、适用性。需要上下文时，由作者选择本页来源按 tool_arguments 或 page_read_arguments 读取，沿 next_cursor 查看后页。目录不赚阅读回执，不要求全部来源都接收，不能据邻接关系猜业务归属。",
      };
      return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_PATCH_SERIALIZED_BYTES
        ? response
        : { ok: false, error: "evidence_resource_page_limit_internal", instruction: "请求更小的资源页，不要重试相同的超大页面。", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
    }
    const page = boundedPage(
      this.evidence.evidence.map((record) =>
        evidenceResource(record, this.evidenceAccess(record, accessByEvidenceId))
      ),
      input,
    );
    const response = {
      ok: true,
      resources: page.rows,
      next_cursor: page.next_cursor,
      instruction: `返回资源元数据。${RESOURCE_ACCESS_INSTRUCTION} 不会因格式、角色或关键词而排除资源。`,
    };
    return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_PATCH_SERIALIZED_BYTES
      ? response
      : { ok: false, error: "evidence_resource_page_limit_internal", instruction: "请求更小的资源页，不要重试相同的超大页面。", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
  }

  async discoveryContextPage(input: Record<string, unknown> = {}): Promise<ToolResponse> {
    const cursor = input.discovery_context_cursor ?? 0, limit = input.discovery_context_limit ?? 5;
    if (!Number.isInteger(cursor) || (cursor as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) {
      return { ok: false, error: "discovery_context_cursor_invalid", actual: { cursor, limit },
        expected: { cursor: "nonnegative_integer", limit: "integer_1_to_20" },
        next_tool: "get_target_context", next_tool_arguments: { discovery_context_cursor: 0, discovery_context_limit: 5 },
        instruction: "按返回参数读取发现线索目录；本次没有读取正文、修改草稿或消耗验证次数。" };
    }
    const document = await this.readGlobalDocumentEvidence();
    const catalog = await readDiscoveryContextNotes(join(this.workspace.artifactRoot, "jobs", this.workspace.jobId, "discovery"),
      this.workspace.jobId, document.source.sha256);
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const resources = this.globalDocumentSourceResources(document, protectedRanges);
    const protectedNotes = new Set(catalog.entries.filter(entry => protectedRanges.some(range => sourceRangesOverlap(entry, range)))
      .map(entry => entry.note.context_id));
    const source = document.atoms.map(atom => atom.text).join("");
    const rangesFor = createEvidenceSourceRangeResolver(source, document);
    const notes = catalog.entries.slice(cursor as number, (cursor as number) + (limit as number)).map(entry => {
      const targetKeys = [...new Set(protectedRanges.filter(range => sourceRangesOverlap(entry, range)).map(range => range.target_key))];
      const resource = resources.find(range => range.source_range.start <= entry.start && range.source_range.end >= entry.end);
      const owner = document.atoms.find(atom => atom.start_offset <= entry.start && atom.end_offset >= entry.end);
      const registered = this.evidence.evidence.find(record => owner !== undefined && record.atom_id === owner.atom_id && record.text === source.slice(entry.start, entry.end)
        && rangesFor(record).some(range => range.start === entry.start && range.end === entry.end));
      return {
        context_id: entry.note.context_id,
        ...(!protectedNotes.has(entry.note.context_id) ? {
          role: entry.note.role, name: entry.note.name.slice(0, 100), name_truncated: entry.note.name.length > 100,
          reason: entry.note.reason.slice(0, 240), reason_truncated: entry.note.reason.length > 240,
        } : {}),
        ...(targetKeys.length ? this.globalDocumentIsolationRoute(targetKeys)
          : registered ? { evidence_id: registered.evidence_id, read_tool: "open_evidence", tool_arguments: { evidence_id: registered.evidence_id, cursor: 0 } }
          : resource ? { atom_id: resource.atom_id, read_tool: "open_global_document_resource", tool_arguments: { atom_id: resource.atom_id } }
          : { read_tool: "list_global_document_resources", tool_arguments: { cursor: 0, limit: 20 } }),
        source_range: { source_sha256: document.source.sha256, start: entry.start, end: entry.end },
      };
    });
    const next = (cursor as number) + (limit as number);
    return { ok: true, status: catalog.status, metadata_only: true, budget_consumed: false,
      plan_sha256: catalog.plan_sha256, source_sha256: document.source.sha256,
      applicability_checked: false, exhaustive: false, total: catalog.entries.length, cursor, limit, notes,
      next_context_page: next < catalog.entries.length
        ? { tool: "get_target_context", arguments: { discovery_context_cursor: next, discovery_context_limit: limit } } : null,
      instruction: "这是发现阶段已保存的候选线索，名称和理由是模型笔记，不是原文结论或待办清单。按当前对象选择相关线索，复制 read_tool/tool_arguments 读原文后判断适用性；采用时沿用既有来源登记和字段绑定。已完成的同一适用判断可在本 target 内复用；无需逐项目重复调查或逐条审完全部笔记。目录不记正文阅读回执、不改变 primary 范围。空目录、缺失或版本失配都不证明共同规定不存在；此时可用现有全文目录/搜索补查。" };
  }

  private async readGlobalDocumentEvidence(): Promise<DocumentEvidence> {
    if (this.globalDocumentEvidence) return this.globalDocumentEvidence;
    const markdown = await readFile(this.workspace.sourceMarkdownPath, "utf8");
    this.globalDocumentEvidence = buildDocumentEvidence(markdown, this.evidence.source.file_name);
    return this.globalDocumentEvidence;
  }

  private async isolatedGlobalDocumentRanges(
    document: DocumentEvidence,
  ): Promise<Array<{ start: number; end: number; target_key: string }>> {
    const state = await this.workspace.readState();
    const policies = projectReferenceAnalysisPolicies(
      this.evidence,
      state.reference_analysis_modes,
      "target",
    );
    const source = document.atoms.map((atom) => atom.text).join("");
    const sourceRangesFor = createEvidenceSourceRangeResolver(source, document);
    const evidenceById = new Map(
      this.evidence.evidence.map((record) => [record.evidence_id, record]),
    );
    const ranges: Array<{ start: number; end: number; target_key: string }> = [];
    for (const occurrence of this.evidence.reference_occurrences) {
      if (
        occurrence.status !== "resolved"
        || !referenceOccurrenceTargetsDocument(occurrence, this.evidence.source.sha256)
      ) continue;
      const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
      if (policies.get(targetKey)?.analysis_mode !== "isolated") continue;
      const targetRanges = occurrence.target_evidence_ids.flatMap((evidenceId) => {
        const record = evidenceById.get(evidenceId);
        return record ? sourceRangesFor(record) : [];
      });
      ranges.push(...targetRanges.map((range) => ({ ...range, target_key: targetKey })));
    }
    return ranges;
  }

  private globalDocumentSourceResources(
    document: DocumentEvidence,
    protectedRanges: ReadonlyArray<{ start: number; end: number; target_key: string }>,
  ) {
    const source = document.atoms.map((atom) => atom.text).join("");
    return partitionDocumentSourceRanges(document, protectedRanges).map((range) => {
      const text = source.slice(range.start, range.end);
      return {
        atom_id: range.resource_id,
        parent_atom_id: range.parent_atom_id,
        start_line: range.start_line,
        end_line: range.end_line,
        text_sha256: sha256Text(text),
        source_range: {
          source_sha256: document.source.sha256,
          start: range.start,
          end: range.end,
        },
        text,
        target_keys: [...new Set(protectedRanges
          .filter((protectedRange) => sourceRangesOverlap(protectedRange, range))
          .map((protectedRange) => protectedRange.target_key))].sort(),
      };
    });
  }

  private globalDocumentIsolationRoute(targetKeys: readonly string[]): Record<string, unknown> {
    const routedReferences = targetKeys.map((targetKey) => ({
      target_key: targetKey,
      access_mode: "isolated_reference",
      read_tool: "read_reference_facts",
      tool_arguments: { target_key: targetKey },
    }));
    return {
      access_mode: "isolated_reference",
      read_tool: "read_reference_facts",
      open_global_document_resource_allowed: false,
      target_keys: [...targetKeys],
      routed_references: routedReferences,
      next_tool: "read_reference_facts",
      ...(targetKeys.length === 1
        ? {
            target_key: targetKeys[0],
            tool_arguments: { target_key: targetKeys[0] },
          }
        : {}),
    };
  }

  private async listGlobalDocumentResources(input: Record<string, unknown>): Promise<ToolResponse> {
    const document = await this.readGlobalDocumentEvidence();
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const resources = this.globalDocumentSourceResources(document, protectedRanges)
      .filter(resource => resource.target_keys.length === 0);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 20;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0 || cursor > resources.length
      || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 30) return {
      ok: false, error: "global_document_catalog_cursor_invalid", actual: { cursor, limit },
      expected: { cursor: { integer: true, minimum: 0, maximum: resources.length }, limit: { integer: true, minimum: 1, maximum: 30 } },
      next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0,
        limit: typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 30 ? limit : 20 },
      budget_consumed: false,
      instruction: "cursor 是目录偏移，limit 是每页数量；按合法范围重读目录。本次没有打开正文、登记依赖或修改草稿。",
    };
    const headingNavigation = this.globalDocumentHeadingNavigation ??= createDocumentHeadingNavigation(document);
    return {
      ok: true, inventory_scope: "directly_readable_global_resources", applicability_checked: false,
      cursor, limit, readable_resource_count: resources.length,
      next_cursor: cursor + limit < resources.length ? cursor + limit : null,
      resources: resources.slice(cursor, cursor + limit).map(resource => ({
        atom_id: resource.atom_id, parent_atom_id: resource.parent_atom_id,
        start_line: resource.start_line, end_line: resource.end_line,
        source_range: resource.source_range,
        preview: resource.text.slice(0, 180),
        heading_navigation: headingNavigation(resource.source_range),
        read_tool: "open_global_document_resource", tool_arguments: { atom_id: resource.atom_id },
      })),
      instruction: renderFeedback({ kind: "source_directory", constraint: "heading_navigation最多8条、每条80字符，只定位窗口；截断和数量标记按原值理解。选择与当前对象、字段及未决事实有关的原文，已核对共同规则可复用。按source_access访问隔离引用。不能把尚未完成决定换成fallback。" }),
    };
  }

  private async searchGlobalDocumentResources(query: string): Promise<ToolResponse> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length < 2) return { ok: false, error: "global_search_query_requires_two_characters", actual_query: query, instruction: "调用 search_global_document_resources 时，query 至少包含两个字符；备选关键词用空格分隔。此读取操作不会修改选择器或编译结果。", details: { path: "query", required_action: "supply_at_least_two_characters", next_tool: "search_global_document_resources" } };
    const document = await this.readGlobalDocumentEvidence();
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const matches = this.globalDocumentSourceResources(document, protectedRanges).flatMap((resource) => {
      if (resource.target_keys.length > 0) return [];
      const match = documentSearchMatch(resource.text, query);
      if (!match) return [];
      return [{
        atom_id: resource.atom_id,
        parent_atom_id: resource.parent_atom_id,
        start_line: resource.start_line,
        end_line: resource.end_line,
        text_sha256: resource.text_sha256,
        source_range: resource.source_range,
        read_tool: "open_global_document_resource",
        tool_arguments: { atom_id: resource.atom_id },
        offset_in_atom: match.offset,
        matched_terms: match.matched_terms,
        preview: resource.text.slice(Math.max(0, match.offset - 100), match.offset + query.length + 180),
        score: match.score,
        already_in_target: this.evidence.evidence.some((record) =>
          record.evidence_id === resource.atom_id || record.atom_id === resource.atom_id
        ),
      }];
    }).sort((a, b) => b.score - a.score);
    const response = {
      ok: true,
      ...sourceSearchNavigation(query, "directly_readable_full_document", matches.length),
      matches: matches.slice(0, 30),
      truncated: matches.length > 30,
      directory_tool: "list_global_document_resources",
      directory_tool_arguments: { cursor: 0, limit: 20 },
      ...(matches.length ? { next_tool: "open_global_document_resource" } : {}),
      instruction: matches.length
        ? "结果是按词面匹配排序的非穷尽来源导航，preview 不是完整正文，排名不决定业务适用性；按模型所选候选的 read_tool/tool_arguments 读取，不能只打开首项就声称共同规定已查全。already_in_target 仅表示来源已登记，不证明已阅读或已承载规则。使用 fallback 前仍须依据原文核查适用上级/一般规定；候选没有数量、仅阅读部分候选或关键词未命中都不能证明没有适用抽样规则。direct 资源仅在提供引用/共享规则时登记 dependency，直接目标正文使用 scope_extension。isolated_reference 原始范围不参与搜索，须从 list_reference_occurrences 的无正文目录取得 target_key 后调用 read_reference_facts。"
        : "可直接调查的全文范围内没有当前查询的词面匹配，不能证明没有适用规则或支持 fallback。按顶层 next_tool/next_tool_arguments 浏览无关键词目录，再选择实际相关来源；也可换原文措辞重搜。搜索不包含 isolated_reference 正文，已登记引用按引用目录的专用路由读取。",
    };
    return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_PATCH_SERIALIZED_BYTES
      ? response
      : { ok: false, error: "global_search_payload_limit_internal", instruction: "缩小 query 范围后调用 search_global_document_resources；不得为修复读取请求而修改选择器或编译结果。", details: { path: "query", actual_query: query, required_action: "narrow_query", next_tool: "search_global_document_resources" } };
  }

  private async openGlobalDocumentResource(atomId: string): Promise<ToolResponse> {
    const document = await this.readGlobalDocumentEvidence();
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const resources = this.globalDocumentSourceResources(document, protectedRanges);
    const resource = resources
      .find((candidate) => candidate.atom_id === atomId);
    if (!resource) {
      const parentTargetKeys = [...new Set(resources
        .filter((candidate) => candidate.parent_atom_id === atomId)
        .flatMap((candidate) => candidate.target_keys))].sort();
      if (parentTargetKeys.length) return {
        ok: false,
        error: "global_document_resource_isolated_reference",
        atom_id: atomId,
        ...this.globalDocumentIsolationRoute(parentTargetKeys),
        durable_mutation: false,
        budget_consumed: false,
        instruction: "该全文 atom 与 isolated_reference 原始范围重叠，不能返回正文或登记 opened checkpoint。原样复制 routed_references 中的 target_key 调用 read_reference_facts。",
      };
      return { ok: false, error: "unknown_global_document_resource", instruction: "先列举全局文档资源，从返回目录复制 atom_id。", atom_id: atomId,
        next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 }, budget_consumed: false };
    }
    if (resource.target_keys.length) {
      return {
        ok: false,
        error: "global_document_resource_isolated_reference",
        atom_id: atomId,
        source_range: resource.source_range,
        ...this.globalDocumentIsolationRoute(resource.target_keys),
        durable_mutation: false,
        budget_consumed: false,
        instruction: "该全文 atom 与 isolated_reference 原始范围重叠，不能返回正文或登记 opened checkpoint。原样复制 routed_references 中的 target_key 调用 read_reference_facts。",
      };
    }
    const response = {
      ok: true,
      resource: {
        atom_id: resource.atom_id,
        parent_atom_id: resource.parent_atom_id,
        start_line: resource.start_line,
        end_line: resource.end_line,
        text_sha256: resource.text_sha256,
        source_range: resource.source_range,
      },
      text: resource.text,
      instruction: "本次打开供调查；引用前请登记适用依赖。若涉及主任务范围冲突，应提交上游范围修订。",
    };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      return { ok: false, error: "global_document_resource_payload_exceeds_128kb", instruction: "缩小此资源的读取窗口，不要重试相同的超大读取。", atom_id: atomId };
    }
    await this.workspace.updateState((state) => {
      state.opened_global_resource_ids = [...new Set([...(state.opened_global_resource_ids ?? []), atomId])].sort();
    });
    return response;
  }

  private async openAdjacentDocumentResource(atomId: string, direction: string): Promise<ToolResponse> {
    if (direction !== "previous" && direction !== "next") {
      return { ok: false, error: "adjacent_direction_must_be_previous_or_next", instruction: "direction 只能填写 previous 或 next。" };
    }
    const document = await this.readGlobalDocumentEvidence();
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const resources = this.globalDocumentSourceResources(document, protectedRanges);
    const index = resources.findIndex((resource) => resource.atom_id === atomId);
    if (index < 0) return { ok: false, error: "unknown_global_document_resource",
      instruction: "先调用 list_global_document_resources，再从目录复制 atom_id；本次没有打开正文或登记依赖。", atom_id: atomId,
      next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 }, budget_consumed: false };
    const adjacent = resources[index + (direction === "previous" ? -1 : 1)];
    if (!adjacent) return {
      ok: false, error: "adjacent_document_resource_missing", atom_id: atomId, direction,
      actual: { atom_id: atomId, direction, adjacent_available: false },
      expected: { allowed_directions: ["previous", "next"], adjacent_resource_required: true },
      writable_tool_arguments: ["atom_id", "direction"],
      next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 },
      durable_mutation: false, budget_consumed: false,
      instruction: "当前资源在所选方向没有相邻资源，相同参数重试仍不会产生正文。该边界不证明规则不存在或业务调查完成。调用 list_global_document_resources，从目录选择可读资源并按返回工具打开，或核对后改用另一个相邻方向；不修改作者稿、来源登记或验证预算。",
    };
    return this.openGlobalDocumentResource(adjacent.atom_id);
  }

  private async registerExternalDependency(atomId: string, mode: string, reason: string): Promise<ToolResponse> {
    if (mode !== "dependency" && mode !== "scope_extension") {
      return { ok: false, error: "external_resource_mode_must_be_dependency_or_scope_extension", instruction: "外部资源 mode 只能是 dependency 或 scope_extension，请修正参数后重试。" };
    }
    if (!reason.trim()) return { ok: false, error: "external_resource_reason_required", instruction: "登记外部资源必须填写 reason，请补充理由后重试。" };
    const document = await this.readGlobalDocumentEvidence();
    const protectedRanges = await this.isolatedGlobalDocumentRanges(document);
    const sourceResources = this.globalDocumentSourceResources(document, protectedRanges);
    const documentResource = sourceResources.find((candidate) => candidate.atom_id === atomId);
    const protectedTargetKeys = documentResource?.target_keys.length
      ? documentResource.target_keys
      : [...new Set(sourceResources
          .filter((candidate) => candidate.parent_atom_id === atomId)
          .flatMap((candidate) => candidate.target_keys))].sort();
    if (protectedTargetKeys.length > 0) {
      return {
        ok: false,
        error: "global_document_resource_isolated_reference",
        atom_id: atomId,
        ...this.globalDocumentIsolationRoute(protectedTargetKeys),
        durable_mutation: false,
        budget_consumed: false,
        instruction: "该全文资源与 isolated_reference 原始范围重叠，不能登记 dependency 或 scope_extension。原样复制 routed_references 中的 target_key 调用 read_reference_facts。",
      };
    }
    const accessByEvidenceId = await this.evidenceAccessIndex(false);
    const exactExisting = this.evidence.evidence.find((record) => record.evidence_id === atomId);
    if (exactExisting) {
      return {
        ok: true,
        already_available: true,
        registration_required: false,
        match: "exact_evidence_id",
        atom_id: atomId,
        existing_evidence_count: 1,
        existing_evidence: [evidenceResource(exactExisting, this.evidenceAccess(exactExisting, accessByEvidenceId))],
        existing_evidence_truncated: false,
        resource: evidenceResource(exactExisting, this.evidenceAccess(exactExisting, accessByEvidenceId)),
        instruction: "该 atom 已在当前 target scope/evidence manifest 中；拆分后的 evidence 保留相同 atom_id。直接 open/search 这些 evidence，不要注册或扩展 scope。",
      };
    }
    if (!documentResource) return { ok: false, error: "unknown_global_document_resource", instruction: "先列举全局文档资源，从返回目录复制 atom_id。", atom_id: atomId };
    const lineageExisting = this.evidence.evidence.filter((record) => record.atom_id === atomId);
    const resourceMetadata = {
      atom_id: documentResource.atom_id,
      parent_atom_id: documentResource.parent_atom_id,
      locator: `char:${documentResource.source_range.start}-${documentResource.source_range.end}`,
      start_line: documentResource.start_line,
      end_line: documentResource.end_line,
      text_sha256: documentResource.text_sha256,
      text_length: documentResource.text.length,
      utf8_bytes: Buffer.byteLength(documentResource.text, "utf8"),
      source_range: documentResource.source_range,
    };
    const scopeStart = this.evidence.scope.selected_start_line;
    const scopeEnd = this.evidence.scope.selected_end_exclusive_line;
    const selectedAtomFullyInsideScope = (this.evidence.scope.selected_atom_ids ?? []).includes(atomId)
      && typeof scopeStart === "number"
      && typeof scopeEnd === "number"
      && (this.evidence.scope.primary_source_ranges ?? [{ start_line: scopeStart, end_exclusive_line: scopeEnd }])
        .some(range => documentResource.start_line >= range.start_line && documentResource.end_line < range.end_exclusive_line);
    if (selectedAtomFullyInsideScope) {
      const available = lineageExisting.length ? lineageExisting : this.evidence.evidence.filter((record) => {
        const line = evidenceLocatorLine(record.locator);
        return line !== undefined && line >= documentResource.start_line && line <= documentResource.end_line;
      });
      if (available.length === 0) {
        return {
          ok: false,
          terminal: true,
          error: "selected_atom_evidence_lineage_missing",
          actual: { atom_id: atomId, selected_start_line: scopeStart, selected_end_exclusive_line: scopeEnd },
          how_to_pass: "Rebuild this target evidence manifest so records derived from the selected atom retain atom_id lineage.",
          do_not_edit: "target selectors or compiled semantic plan",
          next_tool: null,
          instruction: "The document scope says this whole atom is selected, but the target evidence manifest exposes none of its records. This is a harness evidence-construction defect, not a scope extension.",
        };
      }
      return {
        ok: true,
        already_available: true,
        registration_required: false,
        match: lineageExisting.length ? "selected_atom_lineage" : "selected_atom_line_range",
        atom_id: atomId,
        existing_evidence_count: available.length,
        existing_evidence: available.slice(0, 32).map((entry) => evidenceResource(entry, this.evidenceAccess(entry, accessByEvidenceId))),
        existing_evidence_truncated: available.length > 32,
        instruction: lineageExisting.length
          ? "该 atom 已完整落在当前 target 行范围内，拆分 evidence 的 atom_id lineage 已确认。直接 open/search，不能消耗 scope refresh。"
          : "该 atom 已完整落在当前 target 行范围内。当前是旧 manifest，按行号找到了现有 evidence；直接 open/search，不能消耗 scope refresh。",
      };
    }
    const containingRecord = this.evidence.evidence.find((record) => {
      if (this.evidenceAccess(record, accessByEvidenceId).access_mode === "isolated_reference") return false;
      const range = charLocatorRange(record.locator);
      return range !== null
        && range.start <= documentResource.source_range.start
        && range.end >= documentResource.source_range.end
        && record.text.includes(documentResource.text);
    });
    if (containingRecord) {
      return {
        ok: true,
        already_available: true,
        registration_required: false,
        match: "contained_physical_window",
        requested_resource: resourceMetadata,
        resource: evidenceResource(containingRecord, this.evidenceAccess(containingRecord, accessByEvidenceId)),
        instruction: "该全局 atom 已被当前 target scope/evidence manifest 的物理窗口完整包含，无需注册或扩展 scope；可直接从现有 evidence open/locate 后引用。",
      };
    }
    const state = await this.workspace.readState();
    if (!(state.opened_global_resource_ids ?? []).includes(atomId)) {
      const retryArguments = { atom_id: atomId, mode, reason };
      return {
        ok: false,
        error: "global_document_resource_not_opened",
        terminal: false,
        durable_mutation: false,
        budget_consumed: false,
        actual: { atom_id: atomId, opened_global_resource: false },
        atom_id: atomId,
        candidate_read_tool: "open_global_document_resource",
        next_tool: "open_global_document_resource",
        next_tool_arguments: { atom_id: atomId },
        retry_tool: "register_external_dependency",
        retry_arguments: retryArguments,
        instruction: "本次登记未执行，未写入 evidence manifest、来源 span 或选择器。先用 next_tool_arguments 调用 open_global_document_resource 打开该 atom；打开成功后，保留原 mode 和 reason，按 retry_arguments 重试 register_external_dependency。短 atom 句柄直接使用当前回条中的值，所属目标由程序绑定；不添加 source_handle_scope。",
        do_not_edit: "不可变原文、当前 target scope、已保存 selector、编译产物及本次调用中其他正确参数；不要改 atom_id、mode 或 reason 来绕过打开门禁。",
      };
    }
    if (mode === "scope_extension") {
      const resource = resourceMetadata;
      const start = Number(resource.start_line), end = Number(resource.end_line);
      const primarySourceRanges = excludeProtectedSourceLineWindows(
        document.atoms.map(atom => atom.text).join(""),
        this.evidence.scope.primary_source_ranges
          ?? (typeof scopeStart === "number" && typeof scopeEnd === "number"
            ? [{ start_line: scopeStart, end_exclusive_line: scopeEnd }] : []),
        protectedRanges,
      );
      if (Number.isFinite(start) && Number.isFinite(end) && typeof scopeStart === "number" && typeof scopeEnd === "number"
        && start < scopeEnd && end >= scopeStart && (start < scopeStart || end >= scopeEnd)) {
        const available = this.evidence.evidence.filter(record => {
          if (this.evidenceAccess(record, accessByEvidenceId).access_mode === "isolated_reference") return false;
          const line = Number(/^line:(\d+)/u.exec(record.locator)?.[1]);
          return Number.isFinite(line) && line >= start && line <= end;
        }).sort((a,b)=>Number(a.evidence_scope==="primary")-Number(b.evidence_scope==="primary"));
        return { ok: false, terminal: false, budget_consumed: false, error: "scope_extension_mixed_resource", issue_owner: "selector_input_error",
          resource, current_scope: {start_line:scopeStart,end_exclusive_line:scopeEnd}, existing_evidence: available.slice(0,8).map((entry) => evidenceResource(
            entry,
            this.evidenceAccess(entry, accessByEvidenceId),
          )),
          next_tool: available.length ? "open_evidence" : "list_evidence_resources",
          next_tool_arguments: available.length ? { evidence_id: available[0]!.evidence_id, cursor: 0 } : { cursor: 0 },
          required_tools: ["open_evidence", "search_evidence", "locate_evidence_span", "report_target_blocker"],
          writable_path: "report_target_blocker.evidence_span_ids",
          do_not_edit: "当前 primary 范围、不可变原文、读取回执和编译产物",
          instruction: "这个较大 atom 混合了当前目标与其他章节正文，发生重叠不能证明目标范围不完整。本次未登记或扩大范围，保留已保存草稿。先打开已有精确 evidence_id；引用依赖继续按既有 primary/reference 契约处理。若根据已读原文确认某个窗外片段必须进入 primary，先用 open_evidence 完整读取其 evidence，再用 locate_evidence_span 登记模型选择的精确片段，以 report_target_blocker(kind=scope_extension_required, evidence_span_ids=[这些 span], affected_selector_paths=实际受影响路径, explanation=原文依据) 上报。阻塞回执由 harness 在唯一一次 fresh revision 中处理，不要重复把整个混合 atom 交给本工具；不得用盲选 span、改读取回执或丢弃草稿绕过门禁。" };
      }
      return {
        ok: false,
        terminal: false,
        budget_consumed: false,
        durable_mutation: false,
        error: "scope_extension_requires_precise_blocker",
        issue_owner: "selector_input_error",
        resource: resourceMetadata,
        reason,
        actual: {
          requested_atom_id: atomId,
          requested_source_range: { start_line: start, end_exclusive_line: end + 1 },
          current_primary_source_ranges: primarySourceRanges,
          overlaps_current_primary: primarySourceRanges.some(range => start < range.end_exclusive_line && end >= range.start_line),
          nominated_evidence_span_ids: [],
          opened_global_resource: true,
          registered_target_evidence: false,
        },
        next_tool: "get_target_context",
        next_tool_arguments: { limit: 100 },
        required_tools: ["get_target_context", "search_evidence", "open_evidence", "locate_evidence_span", "report_target_blocker"],
        writable_paths: ["report_target_blocker.evidence_span_ids", "report_target_blocker.affected_selector_paths", "report_target_blocker.explanation"],
        how_to_pass: "先核对当前 primary 的实际行范围和已提供原文，由模型确认这个范围外资源的角色及必要性。若当前 evidence 中已有足够依据，继续增量修复 selector；若确有遗漏的直接正文，必须取得已完整读取的 target evidence、登记模型选择的精确 span，再用 report_target_blocker(kind=scope_extension_required) 上报实际受影响路径和依据。该工具会执行既有已读证据、primary/reference 及可修复草稿检查；本次整块 atom 请求不能代替它。",
        do_not_edit: "不可变原文、primary 范围、读取回执、编译产物及未受影响的 selector",
        instruction: "本次未登记依赖、未扩大范围，也未接受 terminal blocker。actual 列出请求资源与当前 primary 的物理范围；同编号条款、标题或相邻关系不能证明同一正文范围或业务归属，角色由模型依据原文判断。先按 next_tool 核对当前范围和现有草稿，完成已有可操作修复。若确认是引用或共同依赖，只能按真实用途登记 dependency；不得为获得访问而把直接正文伪装成依赖。真正的范围阻塞必须通过 report_target_blocker 上报已完整读取并登记的精确 evidence_span_ids；仅打开 global atom 的回执不等于 target evidence 的已读 span，若尚无合法 span 就保留此证据缺口，不能用 atom_id、目录标题或盲选片段代替。沿用一次 fresh refresh 上限及 no_source_change 检查，接受 blocker 也不保证能刷新。",
      };
    }
    const coverageRepairDependency = coverageRepairAllowsExternalDependency(state);
    if (
      (state.validation_attempts > 0 || Boolean(state.last_valid_fingerprint) || Boolean(state.last_valid_plan_sha256))
      && !coverageRepairDependency
    ) {
      return {
        ok: false,
        terminal: false,
        budget_consumed: false,
        error: "external_dependency_after_validation",
        actual: { atom_id: atomId, validation_attempts: state.validation_attempts, validated_fingerprint: state.last_valid_fingerprint },
        writable_path: "working.target-selectors.json",
        next_tool: state.last_valid_fingerprint ? "seal_validated_plan" : "report_target_blocker",
        instruction: "This revision has entered final validation. Preserve its candidate and evidence manifest; do not edit compiled output or register this dependency again. If the current candidate is validated, seal the exact fingerprint. If no valid candidate can be sealed, report_target_blocker with the atom_id and missing requirement.",
      };
    }
    const record: EvidenceRecord = {
      evidence_id: documentResource.atom_id,
      atom_id: documentResource.atom_id,
      kind: "paragraph",
      role: "context",
      locator: `char:${documentResource.source_range.start}-${documentResource.source_range.end}`,
      text: documentResource.text,
      source_start_line: documentResource.start_line,
      text_sha256: documentResource.text_sha256,
      requires_disposition: false,
      evidence_scope: "reference",
      registered_dependency: true,
    };
    const updated = await this.workspace.extendEvidenceManifest(record);
    this.evidence.evidence = updated.evidence;
    this.evidence.evidence_fingerprint = updated.evidence_fingerprint;
    const previousRegistry = await this.workspace.readSourceSpanRegistry();
    await atomicWriteJson(this.workspace.sourceSpanRegistryPath, {
      ...previousRegistry,
      source_fingerprint: updated.evidence_fingerprint,
    });
    this.openedEvidenceIds.add(atomId);
    await this.workspace.updateState((current) => {
      current.opened_evidence_ids = [...new Set([...(current.opened_evidence_ids ?? []), atomId])].sort();
    });
    return {
      ok: true,
      dependency_registered: true,
      registration_phase: coverageRepairDependency ? "coverage_repair" : (state.selector_protocol?.submissions ?? 0) > 0 ? "selector_correction" : "pre_submission",
      requires_revalidation: true,
      budget_consumed: false,
      resource: evidenceResource(record, this.evidenceAccess(record, accessByEvidenceId)),
      business_span_available: false,
      next_tool: "locate_evidence_span",
      tool_argument_hints: {
        locate_evidence_span: {
          evidence_id: atomId,
          quote: "从本次已打开的原文中逐字复制模型判断实际承载业务字段的完整、精确连续片段，并保留必要的适用条件和限定",
        },
      },
      instruction: "依赖已登记，但登记只建立可读取的来源容器，不生成可绑定业务字段的 span_id。请从已打开原文中逐字选择实际承载目标字段的精确原文，再调用 locate_evidence_span；不要把整份 atom 复制进 quantity、method、condition、criterion、note 或抽样组件。",
      evidence_fingerprint: updated.evidence_fingerprint,
      reason,
    };
  }

  private async batchOpenEvidence(value: unknown): Promise<ToolResponse> {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((id) => typeof id !== "string")) {
      return { ok: false, error: "batch_open_requires_1_to_50_evidence_ids", instruction: "evidence_ids 必须包含 1～50 个证据 ID。" };
    }
    const requested = value as string[];
    if (new Set(requested).size !== requested.length) {
      return { ok: false, error: "batch_open_duplicate_evidence_ids", instruction: "请将 evidence_ids 去重后重试。" };
    }
    const records = requested.map((id) => this.evidence.evidence.find((record) => record.evidence_id === id));
    const unknown = requested.filter((_id, index) => !records[index]);
    if (unknown.length) return { ok: false, error: "unknown_evidence_ids", instruction: "移除未知 ID，从当前目录复制真实 evidence_id。", evidence_ids: unknown };
    const accessByEvidenceId = await this.evidenceAccessIndex(false);
    const routed = (records as EvidenceRecord[]).map((record) => ({
      record,
      access: this.evidenceAccess(record, accessByEvidenceId),
    }));
    const isolatedGroups = new Map<string, string[]>();
    for (const { record, access } of routed) {
      if (access.access_mode !== "isolated_reference") continue;
      isolatedGroups.set(
        access.target_key,
        [...(isolatedGroups.get(access.target_key) ?? []), record.evidence_id],
      );
    }
    if (isolatedGroups.size > 0) {
      const openableEvidenceIds = routed
        .filter(({ access }) => access.open_evidence_allowed)
        .map(({ record }) => record.evidence_id);
      const routedReferences = [...isolatedGroups].map(([targetKey, evidenceIds]) => ({
        target_key: targetKey,
        evidence_ids: evidenceIds,
        access_mode: "isolated_reference",
        read_tool: "read_reference_facts",
        open_evidence_allowed: false,
        tool_arguments: { target_key: targetKey },
      }));
      return {
        ok: false,
        error: "batch_open_contains_isolated_reference_evidence",
        terminal: false,
        durable_mutation: false,
        budget_consumed: false,
        openable_evidence_ids: openableEvidenceIds,
        routed_references: routedReferences,
        retry_tool: openableEvidenceIds.length > 0 ? "batch_open_evidence" : "read_reference_facts",
        retry_arguments: openableEvidenceIds.length > 0
          ? { evidence_ids: openableEvidenceIds }
          : routedReferences[0]!.tool_arguments,
        next_tools: unique([
          ...(openableEvidenceIds.length > 0 ? ["batch_open_evidence"] : []),
          "read_reference_facts",
        ]),
        instruction: "本次批量请求已在打开任何正文、登记 span 或写入 opened checkpoint 前原子拒绝。openable_evidence_ids 可作为一次新的 batch_open_evidence 请求；每个 isolated 引用目标只需按 routed_references 中的 target_key 调用一次 read_reference_facts 取得目录，再打开模型选择的条目。不得逐个重试这些 evidence_id，也不会自动读取隔离正文。",
      };
    }
    const opened: Array<Record<string, unknown>> = [];
    const openedUnits: Array<{ record: EvidenceRecord; window: { start: number; end: number } }> = [];
    let consumed = 0;
    for (const record of records as EvidenceRecord[]) {
      const window = splitTextWindows(record.text)[0]!;
      const item = {
        resource: {
          evidence_id: record.evidence_id,
        },
        cursor: 0,
        text_window: window,
        cells: await this.tableCellHandles(record, window),
        next_cursor: splitTextWindows(record.text).length > 1 ? 1 : null,
      };
      const candidate = {
        ok: true,
        opened: [...opened, item],
        remaining_evidence_ids: requested.slice(consumed + 1),
      };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_PATCH_SERIALIZED_BYTES) break;
      opened.push(item);
      openedUnits.push({ record, window });
      consumed += 1;
    }
    if (!opened.length) return { ok: false, error: "batch_open_payload_limit_internal", instruction: "减少每批打开的 ID，不要重试相同的超大批次。", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
    const fullyOpened = await this.markEvidenceWindowsOpened(openedUnits);
    const registry = await this.workspace.readSourceSpanRegistry();
    const enriched = opened.map((item, index) => {
      const record = openedUnits[index]!.record;
      const chunkSpan = fullyOpened.has(record.evidence_id)
        && tableEvidenceTextFormat(record) !== "legacy_navigation_mixed_v0"
        ? registry.spans.find((span) => span.evidence_id === record.evidence_id && span.start === 0 && span.end === record.text.length)
        : undefined;
      return chunkSpan ? { ...item, chunk_span: { span_id: chunkSpan.span_id } } : item;
    });
    const response = {
      ok: true,
      opened: enriched,
      remaining_evidence_ids: requested.slice(consumed),
      truncated: consumed < requested.length,
      instruction: `打开结果保持请求顺序；只有超长资源尚有未读正文时，才用 open_evidence 按 next_cursor 继续。 ${SOURCE_READING_GUIDANCE}`,
    };
    return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_PATCH_SERIALIZED_BYTES
      ? response
      : { ok: false, error: "batch_open_payload_limit_internal", instruction: "减少每批打开的 ID，不要重试相同的超大批次。", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
  }

  private async searchEvidence(query: string): Promise<ToolResponse> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return { ok: false, error: "search_query_required", instruction: "请填写非空搜索 query。" };
    const accessByEvidenceId = await this.evidenceAccessIndex(true);
    const records = this.evidence.evidence
      .filter((record) => this.evidenceAccess(record, accessByEvidenceId).access_mode !== "isolated_reference")
      .flatMap(record => { const match = documentSearchMatch(record.text, query); return match ? [{ record, match }] : []; })
      .sort((left, right) => right.match.score - left.match.score);
    const matches = records.slice(0, 50).map(({ record, match }) => {
      const access = this.evidenceAccess(record, accessByEvidenceId);
      return {
        evidence_id: record.evidence_id,
        kind: record.kind,
        locator: record.locator,
        matched_terms: match.matched_terms,
        score: match.score,
        ...(access.access_mode === "isolated_reference"
          ? {}
          : { preview: record.text.slice(0, 240) }),
        ...access,
      };
    });
    return {
      ok: true,
      ...sourceSearchNavigation(query, "registered_target_evidence", records.length),
      matches,
      truncated: records.length > matches.length,
      instruction: "这里只检索当前已登记目标证据，不是全文。空格分隔备选词，任一词命中即入选，完整短语及多词命中优先；结果仅供定位，不作业务结论。未命中时按顶层 next_tool/next_tool_arguments 继续全文检索，不据空结果选择 fallback。命中按各项 read_tool/tool_arguments 读原文；隔离引用正文不参与搜索，按引用目录进入专用事实工具。",
    };
  }

  private async batchSearchEvidence(value: unknown): Promise<ToolResponse> {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20 || value.some((query) => typeof query !== "string" || !query.trim())) {
      return { ok: false, error: "batch_search_requires_1_to_20_queries", instruction: "queries 必须包含 1～20 个查询。" };
    }
    const accessByEvidenceId = await this.evidenceAccessIndex(true);
    const output: ToolResponse = {
      ok: true,
      results: (value as string[]).map((query) => {
        const found = this.evidence.evidence
          .filter(record => this.evidenceAccess(record, accessByEvidenceId).access_mode !== "isolated_reference")
          .flatMap(record => { const match = documentSearchMatch(record.text, query); return match ? [{ record, match }] : []; })
          .sort((left, right) => right.match.score - left.match.score);
        return {
          ...sourceSearchNavigation(query, "registered_target_evidence", found.length),
          truncated: found.length > 20,
          matches: found.slice(0, 20).map(({ record, match }) => {
              const access = this.evidenceAccess(record, accessByEvidenceId);
              return {
                evidence_id: record.evidence_id,
                kind: record.kind,
                locator: record.locator,
                matched_terms: match.matched_terms,
                score: match.score,
                ...(access.access_mode === "isolated_reference"
                  ? {}
                  : { preview: record.text.slice(0, 240) }),
                ...access,
              };
            }),
        };
      }),
      instruction: "每条查询只检索已登记目标证据，空格分隔备选词、任一词命中并排序，与全文检索相同。每个空结果有自己的全文检索 next_tool/next_tool_arguments；按该查询继续，不把空结果当作无规则。命中按各项 access_mode/read_tool 打开，隔离引用从引用目录走专用事实工具；截断不代表未命中。",
    };
    while (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      const results = output.results as Array<{ matches: unknown[]; truncated: boolean }>;
      const largest = [...results].sort((left, right) => right.matches.length - left.matches.length)[0];
      if (!largest?.matches.length) return { ok: false, error: "batch_search_payload_limit_internal", instruction: "减少查询数量或缩小关键词范围，不要重试相同的超大批次。" };
      largest.matches.pop();
      largest.truncated = true;
      output.truncated = true;
    }
    return output;
  }

  private async readWorkingPlan(): Promise<ToolResponse> {
    return {
      ok: true,
      content: await readFile(this.workspace.workingPlanPath, "utf8"),
    };
  }

  private prepareFieldBindings(input: unknown): ToolResponse {
    const fields = ["name", "requirement", "method", "quantity", "note"] as const;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: "field_binding_input_must_be_object", instruction: "Pass a field-binding object that matches the contract schema." };
    }
    const records = input as Record<string, unknown>;
    const evidenceById = new Map(
      this.evidence.evidence.map((record) => [record.evidence_id, record]),
    );
    const values: Record<string, string> = {};
    const bindings: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = records[field];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "missing_field_binding_input", instruction: "Include the missing field in the binding object.", field };
      }
      const entry = raw as Record<string, unknown>;
      const value = typeof entry.value === "string" ? entry.value : undefined;
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      const composition = entry.composition;
      const fragments = Array.isArray(entry.source_fragments)
        ? entry.source_fragments
        : undefined;
      if (value === undefined || !reason || !fragments) {
        return { ok: false, error: "invalid_field_binding_input", instruction: "Fix this request (invalid field binding input). Do not retry the same arguments.", field };
      }
      if (field !== "name" && composition === "semantic_summary") {
        return {
          ok: false,
          error: "semantic_summary_name_only",
          field,
          instruction: "semantic_summary 仅能用于 name。requirement、method、quantity、note 必须用 verbatim、shared_inheritance 或 reference 及精确原文片段无损保留。",
        };
      }
      if (value === "") {
        if (composition !== "not_applicable" || fragments.length !== 0) {
          return {
            ok: false,
            error: "empty_field_must_be_not_applicable_without_fragments",
            instruction: "Fix this request (empty field must be not applicable without fragments). Do not retry the same arguments.",
            field,
          };
        }
        values[field] = value;
        bindings[field] = {
          status: "not_applicable",
          composition: "not_applicable",
          evidence_ids: [],
          source_fragments: [],
          value_sha256: sha256Text(value),
          reason,
        };
        continue;
      }
      if (
        !["verbatim", "semantic_summary", "shared_inheritance", "reference"].includes(String(composition))
        || fragments.length === 0
      ) {
        return { ok: false, error: "nonempty_field_requires_composition_and_fragments", instruction: "Set composition and exact source fragments for this non-empty field.", field };
      }
      const normalized: Array<{ evidence_id: string; text: string }> = [];
      for (const fragment of fragments) {
        if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) {
          return { ok: false, error: "invalid_source_fragment", instruction: "Use an exact substring of the opened evidence text as the fragment.", field };
        }
        const candidate = fragment as Record<string, unknown>;
        const evidenceId = typeof candidate.evidence_id === "string"
          ? candidate.evidence_id
          : "";
        const text = typeof candidate.text === "string" ? candidate.text : "";
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          return { ok: false, error: "unknown_evidence_id", instruction: "先打开或列举证据，从返回目录复制 evidence_id，不得编造证据 ID。", field, evidence_id: evidenceId };
        }
        if (!this.openedEvidenceIds.has(evidenceId)) {
          return { ok: false, error: "field_binding_evidence_not_opened", instruction: "Call open_evidence on this evidence_id before binding it.", field, evidence_id: evidenceId };
        }
        if (!text || !evidence.text.includes(text)) {
          return { ok: false, error: "field_binding_fragment_not_exact", instruction: "Copy the fragment as an exact substring of the opened evidence.", field, evidence_id: evidenceId, text };
        }
        normalized.push({ evidence_id: evidenceId, text });
      }
      values[field] = value;
      bindings[field] = {
        status: "bound",
        composition,
        evidence_ids: [...new Set(normalized.map((fragment) => fragment.evidence_id))],
        source_fragments: normalized,
        value_sha256: sha256Text(value),
        reason,
      };
    }
    return { ok: true, fields: values, field_bindings: bindings };
  }

  private async writePlanWithHistory(
    content: string,
    operation: string,
  ): Promise<ToolResponse> {
    if (Buffer.byteLength(content, "utf8") > WORKING_PLAN_MAX_BYTES) {
      throw new Error("Working plan exceeds the 2 MB safety limit");
    }
    const before = await readFile(this.workspace.workingPlanPath, "utf8");
    await this.workspace.writeWorkingPlan(content);
    const history = await this.workspace.transactState(async (state) => {
      const sequence = state.next_history_sequence;
      const value = {
        schema_version: "plan-history/v1",
        sequence,
        timestamp: new Date().toISOString(),
        operation,
        repair_finding_ids: repairStateOrDefault(state.repair).repair_source === "coverage"
          ? repairStateOrDefault(state.repair).coverage_finding_ids ?? []
          : [],
        before_sha256: sha256Text(before),
        after_sha256: sha256Text(content),
        unified_patch: createTwoFilesPatch(
          "working.semantic-source-plan.json",
          "working.semantic-source-plan.json",
          before,
          content,
          "before",
          "after",
        ),
      };
      await atomicWriteJson(
        join(this.workspace.historyDirectory, `${String(sequence).padStart(6, "0")}.json`),
        value,
      );
      state.next_history_sequence += 1;
      state.last_valid_fingerprint = "";
      state.last_valid_plan_sha256 = "";
      return value;
    });
    return {
      ok: true,
      history_sequence: history.sequence,
      before_sha256: history.before_sha256,
      after_sha256: history.after_sha256,
    };
  }

  private async replaceWorkingPlan(content: string): Promise<ToolResponse> {
    if ((await this.workspace.readState()).status !== "working" || await pathExists(this.workspace.manifestPath)) {
      throw new Error("This revision is sealed; create a new revision before editing");
    }
    const repair = await this.repairStatus();
    if (repair.mode !== "modeling") {
      return {
        ok: false,
        error: repair.mode === "validated"
          ? "validated_plan_requires_seal"
          : "repair_only_replacement_forbidden",
        active_cluster: repair.active_cluster,
        instruction: "Validation has started. Use one bounded patch_working_plan transaction for the active issue cluster; do not replace or expand the complete plan.",
      };
    }
    return this.writePlanWithHistory(content, "replace");
  }

  private async targetSelectorContract(): Promise<ToolResponse> {
    const state = await this.workspace.readState();
    const registry = await this.workspace.readSourceSpanRegistry();
    const exampleSpanId = registry.spans[0]?.span_id ?? "";
    const submissionGuidance = this.selectorStage === "coverage_repair"
      ? "当前是历史覆盖修复事务，只处理已绑定的 findings；普通预检可重试不表示可以另开覆盖修复事务。局部暂存不消耗正式提交预算，完整提交遵守回条中的 coverage 修复计数与事务状态。"
      : state.target_review_protocol === DIRECT_VALIDATION_PROTOCOL || state.target_review_protocol === SAME_AGENT_SELF_REVIEW_PROTOCOL
        ? "当前直接校验路径：局部暂存、阶段检查及 commit 前的完整预检失败不消耗正式提交或语义修正预算。按回条修正后重试，不是只准改一次；正式提交通过后直接 seal。"
        : "当前历史提交协议：局部暂存与阶段检查不消耗正式提交预算；正式提交返回聚合 selector_input_error 后，才进入一次语义修正。以具体回条的 budget_consumed 和 selector_transaction 为准。";
    return {
      ok: true,
      submission_protocol: { review_protocol: state.target_review_protocol ?? "legacy", selector_stage: this.selectorStage },
      prompt_protocol_version: PROMPT_SUITE_VERSION,
      authoring_protocols: TARGET_SELECTOR_PROTOCOLS,
      schema_version: TARGET_SELECTOR_PLAN_SCHEMA_VERSION,
      json_schema: TARGET_SELECTOR_AUTHOR_PLAN_JSON_SCHEMA,
      write_modes: {
        tool: "stage_target_selector_draft", parameter_schema: "使用该工具当前实际参数声明，临时事务参数不写入持久 json_schema",
        complete_records: "draft 中按 key 提交完整记录",
        reference_field_selection: "reference_selections + 当前 draft_fingerprint；一次明确选择已有项目的引用字段，原子同步确定关系。与 draft/remove_keys/replace_collection 独立使用",
      },
      authority: "模型依据原文声明业务对象、字段角色、适用来源、抽样分支和真实引用接收关系；程序核验结构、来源身份与范围、声明间一致性并生成派生ID、哈希、绑定及SemanticSourcePlan，不替模型作业务选择。",
      reference_application_mode_semantics: REFERENCE_APPLICATION_MODE_SEMANTICS,
      reference_action_guidance: REFERENCE_ACTION_GUIDANCE_ZH,
      blank_plan: initialTargetSelectorPlan(this.evidence),
      worked_example: exampleSpanId ? {
        tool: "stage_target_selector_draft",
        arguments: {
          draft: {
            lots: [{
              key: "lot-example",
              name: this.evidence.scope.selected_heading || "当前 target 检验批",
              scope_span_ids: [exampleSpanId],
              reason: "最小结构示例；真实提交必须由已打开原文的业务语义决定。",
            }],
          },
        },
        instruction: "此示例仅演示使用已登记句柄的合法提交结构，不是业务答案，也不能作为覆盖完成的捷径。",
      } : null,
      sampling_component_worked_example: exampleSpanId ? {
        shared_components: [{
          key: "criterion-example",
          role: "acceptance_criterion",
          disposition: "present",
          span_ids: [exampleSpanId],
          reason: "示例：共享验收判据已在原文登记。",
        }],
        branch_components: [
          { key: "applicability-example", role: "applicability", disposition: "absent", span_ids: [], reason: "示例：该分支未登记独立适用条件。" },
          { key: "condition-example", role: "branch_condition", disposition: "absent", span_ids: [], reason: "示例：该分支未登记独立条件。" },
          { key: "method-example", role: "method", disposition: "present", span_ids: [exampleSpanId], reason: "示例：方法证据已登记。" },
          { key: "quantity-example", role: "quantity", disposition: "present", span_ids: [exampleSpanId], reason: "示例：数量证据已登记。" },
          { key: "exception-example", role: "exception", disposition: "absent", span_ids: [], reason: "示例：未登记例外。" },
          { key: "note-example", role: "note", disposition: "not_applicable", span_ids: [], reason: "示例：注释不适用于该分支。" },
        ],
        instruction: "此示例仅演示完整的类型化 role/disposition 结构。每个角色和 span 都必须根据证据重新选择，不能照抄为业务答案。",
      } : null,
      rules: [submissionGuidance, "完整作者协议见 authoring_protocols；当前Schema和回条决定合法输入及状态。"],
    };
  }

  private targetQuoteIssues(
    error: SourceSpanRegistryError,
    pathPrefix: string,
    nextTool: string,
    readTool: string,
    readFirstOnMissing = false,
    readToolArguments?: Record<string, unknown>,
  ) {
    return error.issues.map(issue => {
      const details: Record<string, unknown> = issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
        ? issue.details as Record<string, unknown> : {};
      const missing = details.quote_match_count === 0;
      const writablePaths = missing ? ["/evidence_id", "/quote"]
        : Array.isArray(details.writable_paths) ? details.writable_paths.filter((path): path is string => typeof path === "string") : [];
      return { ...issue, path: `${pathPrefix}${issue.path === "/" ? "" : issue.path}` || "/", details: {
        ...details,
        ...(writablePaths ? { writable_paths: writablePaths.map(path => `${pathPrefix}${path}`) } : {}),
        next_tool: missing && readFirstOnMissing ? readTool : nextTool,
        ...(missing ? {
          candidate_read_tool: readTool,
          ...(readFirstOnMissing && readToolArguments ? { next_tool_arguments: readToolArguments } : {}),
          expected: { quote_is_one_contiguous_source_fragment: true, discontiguous_fragments_require_separate_spans: true },
          fragment_binding_tools: ["locate_evidence_span", "batch_locate_evidence_spans", "stage_target_selector_draft"],
          required_action: `先核对此请求的 evidence_id 与逐字 quote 是否来自同一已读来源；必要时用 ${readTool} 重读对应原文，再重试 ${nextTool}。本来源没有候选可供消歧，添加 prefix/suffix 不能补出匹配。拆项不允许把不同位置的原文片段拼成不存在的 quote：每次定位只摘录一个真实连续片段；需要多个片段时分别用 locate_evidence_span 或 batch_locate_evidence_spans 定位，再由模型依据原文在当前 item 的真实字段 span_ids 中绑定多个返回 span，用 stage_target_selector_draft 保存完整记录。也可在同次 stage 的 quote_bindings 中分别定位真实片段。保留完整适用条件和判据，不得为消错删事实、改写原文、虚构连接句或编造来源 ID。`,
        } : {}),
      } };
    });
  }

  private unknownLocatorEvidence(evidenceId: string, retryTool: string, writablePath: string): ToolResponse & { ok: false; error: string; instruction: string } {
    return {
      ok: false, error: "unknown_evidence_id", evidence_id: evidenceId,
      actual: { evidence_id: evidenceId, registered_in_current_evidence: false },
      expected: "evidence_id 必须属于当前不可变证据目录；全文 atom 的导航句柄不自动成为可定位 evidence",
      writable_paths: [writablePath], next_tool: "list_evidence_resources", next_tool_arguments: { cursor: 0 },
      retry_tool: retryTool, durable_mutation: false, budget_consumed: false,
      do_not_edit: "不可变来源、已登记 span、当前作者草稿和其他成功定位条目不可修改；本条没有登记 span",
      instruction: "按 next_tool_arguments 分页读取当前证据目录，沿 next_cursor 核对来源身份和访问方式；目录不替你选来源。仅调查全文 atom 不会把它登记为当前 evidence，确需外部依赖时须先依据原文确认适用并走允许的登记流程。取得当前真实 evidence_id，并按访问策略读取对应正文后，只修正本条 evidence_id 再重试 retry_tool；保留 quote/prefix/suffix 和其他请求，后续若摘录不匹配再按定位回条处理。不得猜 ID、自动借用其他来源或绕过隔离引用读取策略。",
    };
  }

  private async locateEvidenceSpan(evidenceId: string, quote: string, prefix = "", suffix = ""): Promise<ToolResponse> {
    const evidence = this.evidence.evidence.find((record) => record.evidence_id === evidenceId);
    if (!evidence) return this.unknownLocatorEvidence(evidenceId, "locate_evidence_span", "/evidence_id");
    const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, evidenceId, "target");
    const wasOpened = await this.evidenceQuoteWasOpened(evidence, quote);
    if (isolated && !this.openedEvidenceIds.has(evidenceId)) return { ok: false, error: "isolated_reference_body_access_forbidden", ...this.isolatedReferenceBodyAccessFeedback(isolated.target_key) };
    if (!wasOpened) {
      return {
        ok: false,
        error: "span_evidence_not_opened",
        evidence_id: evidenceId,
        instruction: "定位语义 span 前，先打开包含该 quote 的不可变证据窗口。",
      };
    }
    try {
      const registry = await this.workspace.readSourceSpanRegistry();
      const located = locateAndRegisterSourceQuote(registry, {
        source_id: evidenceId,
        evidence_id: evidenceId,
        atom_id: evidenceId,
        text: evidence.text,
      }, quote, { prefix, suffix });
      const nextFingerprint = sourceSpanRegistryFingerprint(located.registry);
      if (nextFingerprint !== sourceSpanRegistryFingerprint(registry)) {
        await atomicWriteJson(this.workspace.sourceSpanRegistryPath, located.registry);
      }
      return {
        ok: true,
        span: located.spans[0],
        normalized_match: located.normalized,
        disambiguated_by_context: located.disambiguated,
      };
    } catch (error) {
      if (!(error instanceof SourceSpanRegistryError)) throw error;
      const issues = this.targetQuoteIssues(error, "", "locate_evidence_span", isolated ? "read_reference_facts" : "open_evidence",
        true, isolated ? { target_key: isolated.target_key } : { evidence_id: evidenceId, cursor: 0 });
      return {
          ok: false,
          error: error.issues[0]?.code ?? "evidence_span_not_found",
          evidence_id: evidenceId,
          issues,
          ...(isolated ? { target_key: isolated.target_key } : {}),
          next_tool: issues[0]?.details.next_tool,
          ...(issues[0]?.details.next_tool_arguments ? { next_tool_arguments: issues[0].details.next_tool_arguments } : {}),
          retry_tool: "locate_evidence_span",
          instruction: issues[0]?.details.required_action ?? "按 issues 修正来源定位请求，不得修改不可变原文。",
        };
    }
  }

  private async evidenceQuoteWasOpened(evidence: EvidenceRecord, quote: string): Promise<boolean> {
    if (this.openedEvidenceIds.has(evidence.evidence_id)) return true;
    const matches = locateSourceQuote(evidence.text, quote);
    if (matches.length !== 1) return true;
    const state = await this.workspace.readState();
    const openedWindowKeys = new Set(state.opened_evidence_window_keys ?? []);
    return splitTextWindows(evidence.text).some((window) =>
      openedWindowKeys.has(evidenceWindowKey(evidence.evidence_id, window))
      && matches[0]!.start >= window.start
      && matches[0]!.end <= window.end
    );
  }

  private async batchLocateEvidenceSpans(value: unknown): Promise<ToolResponse> {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_LOCATE_REQUESTS) {
      return { ok: false, error: "batch_locate_requires_1_to_100_requests", instruction: "每批必须包含 1～100 个定位请求。" };
    }
    const requests = value as Array<{ evidence_id?: unknown; quote?: unknown; prefix?: unknown; suffix?: unknown }>;
    if (requests.some((request) =>
      !request
      || typeof request.evidence_id !== "string"
      || !request.evidence_id
      || typeof request.quote !== "string"
      || !request.quote.trim()
    )) {
      return { ok: false, error: "invalid_batch_locate_request", instruction: "每个定位请求必须有 evidence_id 和 quote，请修正无效条目。" };
    }
    let registry = await this.workspace.readSourceSpanRegistry();
    const results: Array<Record<string, unknown>> = [];
    for (const [index, request] of requests.entries()) {
      const evidenceId = request.evidence_id as string;
      const evidence = this.evidence.evidence.find((record) => record.evidence_id === evidenceId);
      if (!evidence) {
        results.push({ ...this.unknownLocatorEvidence(evidenceId, "batch_locate_evidence_spans", `/requests/${index}/evidence_id`), index });
        continue;
      }
      const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, evidenceId, "target");
      if (isolated && !this.openedEvidenceIds.has(evidenceId)) {
        results.push({ ok: false, index, evidence_id: evidenceId, error: "isolated_reference_body_access_forbidden", ...this.isolatedReferenceBodyAccessFeedback(isolated.target_key) });
        continue;
      }
      if (!(await this.evidenceQuoteWasOpened(evidence, request.quote as string))) {
        results.push({ ok: false, index, evidence_id: evidenceId, error: "span_evidence_not_opened", instruction: "尚未打开 span 对应证据，先打开原文再定位；不要直接重试相同请求。" });
        continue;
      }
      try {
        const located = locateAndRegisterSourceQuote(registry, {
          source_id: evidenceId,
          evidence_id: evidenceId,
          atom_id: evidence.evidence_id,
          text: evidence.text,
        }, request.quote as string, {
          prefix: typeof request.prefix === "string" ? request.prefix : "",
          suffix: typeof request.suffix === "string" ? request.suffix : "",
        });
        registry = located.registry;
        results.push({ ok: true, index, evidence_id: evidenceId, span: located.spans[0], normalized_match: located.normalized, disambiguated_by_context: located.disambiguated });
      } catch (error) {
        if (!(error instanceof SourceSpanRegistryError)) throw error;
        const issues = this.targetQuoteIssues(
          error, `/requests/${index}`, "batch_locate_evidence_spans",
          isolated ? "read_reference_facts" : "open_evidence",
          true,
          isolated ? { target_key: isolated.target_key } : { evidence_id: evidenceId },
        );
        results.push({
          ok: false,
          index,
          evidence_id: evidenceId,
          error: error.issues[0]?.code ?? "evidence_span_not_found",
          issues,
          ...(isolated ? { target_key: isolated.target_key } : {}),
          instruction: issues[0]?.details.required_action ?? "按 issues 修正当前定位请求，其他成功条目不必重做。",
        });
      }
    }
    const succeededIndexes = results.filter((result) => result.ok === true).map((result) => result.index);
    const failedIndexes = results.filter((result) => result.ok !== true).map((result) => result.index);
    const response = failedIndexes.length === 0
      ? { ok: true as const, results }
      : {
        ok: false as const,
        error: succeededIndexes.length > 0 ? "batch_locate_partial_failure" : "batch_locate_failed",
        instruction: succeededIndexes.length > 0
          ? "succeeded_indexes 对应的 span 已登记并保留，可直接使用；只根据 failed_indexes 对应 results 的 instruction 或 issues 修正并重试失败请求，不要重做成功项。quote 在来源中不存在时，先按该项 next_tool 和 next_tool_arguments 重读原文。"
          : "本批没有成功定位的 span；只根据 failed_indexes 对应 results 的 instruction 或 issues 修正请求。quote 在来源中不存在时，先按该项 next_tool 和 next_tool_arguments 重读原文。",
        succeeded_indexes: succeededIndexes,
        failed_indexes: failedIndexes,
        results,
      };
    const serializedBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
    if (serializedBytes > MAX_PATCH_SERIALIZED_BYTES) {
      return {
        ok: false,
        error: "batch_locate_payload_limit_internal",
        saved: false,
        durable_mutation: false,
        budget_consumed: false,
        max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES,
        actual: {
          serialized_bytes: serializedBytes,
          request_count: requests.length,
          located_in_memory_count: succeededIndexes.length,
          failed_in_memory_count: failedIndexes.length,
          persisted_request_count: 0,
        },
        expected: {
          max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES,
          request_count: { minimum: 1, maximum: MAX_BATCH_LOCATE_REQUESTS },
        },
        writable_paths: ["/requests"],
        next_tool: "batch_locate_evidence_spans",
        retry_tool: "batch_locate_evidence_spans",
        how_to_pass: "按原顺序把每个原始请求分配到更小批次，各批仍须有 1～100 项且返回值不超过 max_serialized_bytes；保持各请求的 evidence_id、quote、prefix 和 suffix，不静默截断或丢弃失败请求。逐批调用 batch_locate_evidence_spans，成功保存的 span 才可使用；收到普通部分失败回条时仅修正该批失败请求，保留其已保存的成功项。若单个请求仍超限，先记录此阻塞，不修改原文或放宽上限。",
        instruction: "本次整批定位结果未保存，内存中的成功项也未登记到持久来源表，未返回可用 span；此前已保存的来源和草稿不变。按 how_to_pass 拆分原始请求后重试，不重复发送同一超大批次。",
      };
    }
    const nextFingerprint = sourceSpanRegistryFingerprint(registry);
    const previous = await this.workspace.readSourceSpanRegistry();
    if (nextFingerprint !== sourceSpanRegistryFingerprint(previous)) {
      await atomicWriteJson(this.workspace.sourceSpanRegistryPath, registry);
    }
    return response;
  }

  private async readTargetSelectors(input: Record<string, unknown>): Promise<ToolResponse> {
    const migration = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ));
    const selectors = migration.plan;
    const collection = typeof input.collection === "string" ? input.collection : "";
    const key = typeof input.key === "string" ? input.key : "";
    const cursor = Math.max(0, Number(input.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25) || 25));
    const evidenceIds = Array.isArray(input.evidence_ids)
      ? unique(input.evidence_ids.filter((id): id is string => typeof id === "string" && id.length > 0)) : [];
    if (input.evidence_ids !== undefined && (collection !== "source_dispositions" || evidenceIds.length === 0)) {
      const selectedCollectionExists = Array.isArray((selectors as unknown as Record<string, unknown>)[collection]);
      const selectedRead = {
        collection: selectedCollectionExists ? collection : "source_dispositions",
        ...(selectedCollectionExists && key ? { key } : {}),
        ...(input.cursor !== undefined ? { cursor } : {}),
        ...(input.limit !== undefined ? { limit } : {}),
      };
      const sourceRead = { collection: "source_dispositions", ...(evidenceIds.length ? { evidence_ids: evidenceIds } : {}),
        ...(input.cursor !== undefined ? { cursor } : {}), ...(input.limit !== undefined ? { limit } : {}) };
      const retryArguments = selectedCollectionExists ? selectedRead : sourceRead;
      return { ok: false, error: "selector_source_lookup_arguments_invalid", terminal: false, budget_consumed: false,
        actual: { ...input, collection }, writable_paths: ["/collection", "/evidence_ids"],
        next_tool: "read_target_selectors", next_tool_arguments: retryArguments, retry_arguments: retryArguments,
        repair_options: [
          ...(selectedCollectionExists ? [{ kind: "read_selected_collection", condition: "继续读取本次已经选择的作者集合和记录",
            next_tool: "read_target_selectors", next_tool_arguments: selectedRead }] : []),
          ...(evidenceIds.length ? [{ kind: "lookup_source_dispositions", condition: "改为核对这些来源的已保存处置",
            next_tool: "read_target_selectors", next_tool_arguments: sourceRead }] : []),
        ],
        instruction: "本次未读取或修改草稿。用 next_tool_arguments 完整替换本次参数后重试；不要合并回被删除的 evidence_ids。两条读取路线都不决定来源的业务角色。",
        how_to_pass: "evidence_ids 过滤只用于 source_dispositions，且必须为非空数组。读取已选的其他作者集合时删除 evidence_ids，保留原 collection/key/cursor/limit；retry_arguments 已给出该完整调用。若要按来源核对处置，使用 lookup_source_dispositions 的参数；该路线保留来源 id，并移除其他集合的 key。" };
    }
    if (!collection) {
      this.inheritedSelectorReadRequired = false;
      // 整份草稿在体积预算内时一次性全量返回：恢复会话不再为重新定位支付
      // 逐集合分页税（实测一个 15 项目标恢复期要 16-19 次分页读，是会话
      // 被 max_messages 掐断前的主要开销）。超预算仍走目录分页。
      const fullPlanText = prettyJson(selectors);
      if (Buffer.byteLength(fullPlanText, "utf8") <= SELECTOR_BULK_READ_LIMIT) {
        return { ok: true, summary: {
          schema_version: selectors.schema_version,
          job_id: selectors.job_id,
          target_id: selectors.target_id,
          draft_fingerprint: targetSelectorFingerprint(selectors),
          counts: targetSelectorCounts(selectors),
          selector_protocol: await this.currentSelectorProtocol(await this.workspace.readState()),
          migration_issues: migration.issues,
          budget_consumed: false,
        }, full_plan: selectors };
      }
      const state = await this.workspace.readState();
      return { ok: true, summary: {
        schema_version: selectors.schema_version,
        job_id: selectors.job_id,
        target_id: selectors.target_id,
        draft_fingerprint: targetSelectorFingerprint(selectors),
        validated_fingerprint: state.last_valid_fingerprint ?? '',
        checkpoint_instruction: 'commit 使用当前 draft_fingerprint；seal 使用最近成功校验的 validated_fingerprint。两者不是同一检查点；validated_fingerprint 为空时须先 commit 校验，不能用草稿检查点代替。',
        counts: targetSelectorCounts(selectors),
        selector_protocol: await this.currentSelectorProtocol(await this.workspace.readState()),
        migration_issues: migration.issues,
        budget_consumed: false,
        bulk_read_available_bytes: Buffer.byteLength(fullPlanText, "utf8"),
      } };
    }
    const rows = (selectors as unknown as Record<string, unknown>)[collection];
    if (!Array.isArray(rows)) {
      const allowedCollections = Object.entries(selectors).filter(([, value]) => Array.isArray(value)).map(([name]) => name);
      const tableStructureRead = collection === "table_structure";
      const howToPass = tableStructureRead
        ? "table_structure 是独立的表结构草稿，不是 selector 集合。先用 read_saved_table_structure({}) 取得当前 tables 和真实 table_key，再用 read_table_summary({table_key}) 读取完整 saved_decision、read_table_rows 核对未决行；按原文判断后用 stage_table_structure({table: 完整决定}) 保存。不能把表结构写入 stage_target_selector_draft，也不能只为过关把 status 改成 confirmed；行角色和业务适用性仍由模型依据原文确认。"
        : "collection 必须是 allowed_collections 中的作者集合；先用 get_target_selector_contract 核对合同，再按原读取意图选择集合，并保留适用的 key/cursor/limit 重试。程序不替模型选择业务集合。";
      return {
        ok: false, error: "unknown_selector_collection", terminal: false, durable_mutation: false, budget_consumed: false,
        collection, actual: { collection, key }, allowed_collections: allowedCollections,
        next_tool: tableStructureRead ? "read_saved_table_structure" : "get_target_selector_contract",
        next_tool_arguments: {},
        ...(tableStructureRead ? { save_tool: "stage_table_structure" } : {}),
        writable_paths: tableStructureRead ? ["stage_table_structure.table"] : ["/collection"],
        how_to_pass: howToPass,
        instruction: `本次没有读取或修改草稿。${howToPass} 不可直接修改不可变来源、编译产物或封存文件。`,
      };
    }
    const unkeyed = collection === "source_dispositions";
    const sourceLookup = evidenceIds.length > 0;
    let matchingRows = rows;
    if (sourceLookup) {
      const requestedIds = new Set(evidenceIds);
      const registry = await this.workspace.readSourceSpanRegistry();
      const matchingSpanIds = new Set(registry.spans.filter(span => requestedIds.has(span.evidence_id)).map(span => span.span_id));
      matchingRows = rows.filter(row => Array.isArray(row.span_ids) && row.span_ids.some((id: string) => matchingSpanIds.has(id)));
    }
    const selected = key
      ? matchingRows.filter(row => selectorRecordReadKey(collection, row) === key)
      : sourceLookup ? matchingRows.slice(cursor, cursor + limit)
        : rows.slice(cursor, cursor + limit).map(row => selectorRecordIndexRow(row, selectorRecordReadKey(collection, row)));
    if (unkeyed && key && !selected.length) return {
      ok: false, error: "selector_read_key_stale_or_unknown", terminal: false, budget_consumed: false,
      actual: { collection, key }, writable_path: "/key", next_tool: "read_target_selectors",
      retry_arguments: { collection },
      instruction: "读取键已过期或不存在。先不带 key 分页读取当前集合目录，再按返回的新 key 读取完整记录；不得把数组位置或旧 key 当作当前地址。草稿没有改变。",
    };
    if (key && !selected.length) {
      const occurrenceKeys = collection === "references"
        ? rows.filter(row => row.occurrence_id === key).map(row => row.key) : [];
      const retryArguments = occurrenceKeys.length === 1
        ? { collection, key: occurrenceKeys[0] } : { collection, cursor: 0 };
      return {
        ok: false, error: "selector_record_key_not_found", terminal: false, budget_consumed: false,
        actual: { collection, key, record_count: rows.length },
        ...(occurrenceKeys.length ? { matching_occurrence_record_keys: occurrenceKeys } : {}),
        writable_path: "/key", next_tool: "read_target_selectors", next_tool_arguments: retryArguments,
        instruction: "本次 key 没有匹配作者记录。按 next_tool_arguments 读取真实 key 或集合目录，不把空匹配当作引用不存在；本次未修改草稿或预算。",
        how_to_pass: "key 必须是作者记录的真实 key，不是 occurrence_id、表号或推测的行号。若 matching_occurrence_record_keys 给出唯一精确匹配，按 next_tool_arguments 读取该完整记录；否则不带 key 从 cursor=0 读取集合目录，再复制真实 row.key。未找到本次 key 不证明对应来源或引用没有作者记录；没有语义或模糊匹配，原草稿和预算未改变。",
      };
    }
    const referenceBindingFacts = collection === "references" && key
      ? currentReferenceAuthorBindingFacts(selectors, await this.workspace.readSourceSpanRegistry(), key) : undefined;
    const response = {
      ok: true,
      collection,
      draft_fingerprint: targetSelectorFingerprint(selectors),
      view: key ? "record" : sourceLookup ? "records" : "index",
      rows: selected,
      ...(["items", "sampling_rules"].includes(collection) && key ? { delivery_preview: selectorDeliveryPreview(selectors,
        await this.workspace.readSourceSpanRegistry(), this.evidence.evidence, new Set(collection === "items" ? [key] : []),
        new Set((await this.workspace.readState()).opened_evidence_ids), new Set(collection === "sampling_rules" ? [key] : [])) } : {}),
      next_cursor: key || cursor + limit >= matchingRows.length ? null : cursor + limit,
      migration_issues: migration.issues,
      budget_consumed: false,
      ...(sourceLookup ? {
        evidence_ids: evidenceIds, matching_record_count: matchingRows.length,
        read_keys: selected.map(row => selectorRecordReadKey(collection, row)),
        instruction: "本页只读取当前草稿中 span_ids 经登记表关联到 evidence_ids 的完整来源处置记录。read_keys 与 rows 顺序一致，可用于读取或 remove_keys，不是草稿字段。没有匹配只表示该查询未找到已保存的来源处置，不证明原文缺失、没有其他业务字段或应当 ignored。依据原文自行选择真实业务绑定或有据的来源处置，再用 stage_target_selector_draft 增量保存；读取不修改草稿、阅读回执或校验预算。",
      } : unkeyed ? {
        ...(key ? { read_key: key } : {}),
        required_action: key ? "edit_or_remove_exact_record" : "read_full_record_by_key",
        instruction: "source_dispositions 的目录 key 是工具生成的当前内容读取键，不是持久化字段。不带 key 分页读取目录，再按返回 key 读取完整 rows 记录。删除时用 stage_target_selector_draft 的 collection=source_dispositions、remove_keys=[读取键]；局部修改 span_ids 时同次删除旧读取键并在 draft.source_dispositions 提交剩余完整记录。不要把目录 key 写进草稿；保留其他记录。读取键在记录内容变化后失效，重试前重新读取。",
      } : key ? {} : selected.length === 0 ? {
        collection_empty: rows.length === 0,
        required_action: rows.length === 0 ? "create_source_grounded_records" : "read_collection_from_start",
        ...(rows.length === 0 ? {
          writable_paths: [`/${collection}`], save_tool: "stage_target_selector_draft",
          instruction: "当前集合尚无已保存记录，因此没有可读取的 key；这不表示原文缺失或引用未定位。依据已读原文和当前契约，用 stage_target_selector_draft 的 draft 在此集合增量创建完整真实记录；不要编造读取 key。若接收项或正文尚未准备，先完成对应依赖，不创建空记录来通过检查。",
        } : {
          next_tool: "read_target_selectors", next_tool_arguments: { collection, cursor: 0, limit },
          instruction: "当前页为空，但集合有已保存记录。按 next_tool_arguments 返回目录起点，再复制实际 row.key 读取全文。",
        }),
      } : {
        required_action: "read_full_record_by_key",
        instruction: "本页只列出 key、name 和字段填写标记。用相同 collection 和 key=<row.key> 调用 read_target_selectors 读取单条完整记录；不带 key 重读集合不会返回正文。",
      }),
    };
    if (referenceBindingFacts && Buffer.byteLength(JSON.stringify({ ...response, current_reference_binding_facts: referenceBindingFacts }), "utf8") <= MAX_PATCH_SERIALIZED_BYTES) {
      Object.assign(response, { current_reference_binding_facts: referenceBindingFacts });
    }
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      return { ok: false, error: "selector_read_exceeds_128kb", instruction: "请按 key 读取；不带 key 的集合页只返回目录。", collection, required_action: "read_full_record_by_key" };
    }
    this.inheritedSelectorReadRequired = false;
    return response;
  }

  private async writeSelectorsWithHistory(
    content: string,
    operation: string,
  ): Promise<ToolResponse> {
    if (Buffer.byteLength(content, "utf8") > 1_000_000) {
      throw new Error("Target selector workfile exceeds the 1 MB safety limit");
    }
    const before = await readFile(this.workspace.workingSelectorPath, "utf8");
    await this.workspace.writeWorkingSelectors(content);
    const history = await this.workspace.transactState(async (state) => {
      const sequence = state.next_history_sequence;
      const previousRepair = repairStateOrDefault(state.repair);
      const value = {
        schema_version: "selector-history/v1",
        sequence,
        timestamp: new Date().toISOString(),
        operation,
        repair_finding_ids: previousRepair.repair_source === "coverage"
          ? previousRepair.coverage_finding_ids ?? []
          : [],
        before_sha256: sha256Text(before),
        after_sha256: sha256Text(content),
        unified_patch: createTwoFilesPatch(
          "working.target-selectors.json",
          "working.target-selectors.json",
          before,
          content,
          "before",
          "after",
        ),
      };
      await atomicWriteJson(
        join(this.workspace.historyDirectory, `${String(sequence).padStart(6, "0")}.json`),
        value,
      );
      state.next_history_sequence += 1;
      state.last_valid_fingerprint = "";
      state.last_valid_plan_sha256 = "";
      const modelingRepair: ReturnType<typeof repairStateOrDefault> = {
        ...repairStateOrDefault(undefined),
        mode: "modeling" as const,
        session_epoch: previousRepair.session_epoch,
      };
      state.repair = previousRepair.repair_source === "coverage"
        ? {
            ...modelingRepair,
            repair_source: "coverage",
            active_cluster: previousRepair.active_cluster,
            total_issue_count: previousRepair.total_issue_count,
            validation_fingerprint: previousRepair.validation_fingerprint,
            coverage_review_fingerprint: previousRepair.coverage_review_fingerprint ?? "",
            coverage_finding_ids: previousRepair.coverage_finding_ids ?? [],
            coverage_evidence_ids: previousRepair.coverage_evidence_ids ?? [],
            coverage_item_ids: previousRepair.coverage_item_ids ?? [],
          }
        : modelingRepair;
      return value;
    });
    return {
      ok: true,
      history_sequence: history.sequence,
      before_sha256: history.before_sha256,
      after_sha256: history.after_sha256,
    };
  }

  public async recordSelectorTransportFailure(reason: string): Promise<{ count: number; exhausted: boolean }> {
    const state = await this.workspace.updateState((state) => {
      const protocol = selectorProtocolOrDefault(state.selector_protocol);
      protocol.transport_failures += 1;
      protocol.last_transport_failure = reason;
      state.selector_protocol = protocol;
    });
    const count = selectorProtocolOrDefault(state.selector_protocol).transport_failures;
    return { count, exhausted: count >= MAX_SELECTOR_TRANSPORT_FAILURES };
  }

  private async recordSelectorProtocolFailure(reason: string): Promise<{ count: number; exhausted: boolean }> {
    const state = await this.workspace.updateState((state) => {
      const protocol = selectorProtocolOrDefault(state.selector_protocol);
      protocol.protocol_failures += 1;
      protocol.last_protocol_failure = reason;
      state.selector_protocol = protocol;
    });
    const count = selectorProtocolOrDefault(state.selector_protocol).protocol_failures;
    return { count, exhausted: count >= MAX_SELECTOR_PROTOCOL_FAILURES };
  }

  private async retainedFieldGateBestScore(state: RevisionState): Promise<{ stage_rank: number; issue_count: number; revision: number; sequence: number } | undefined> {
    const previous = state.selector_protocol?.stage_retries;
    if (!previous || previous.best_stage_rank !== 1) return undefined;
    const workspaces = [this.workspace];
    const checkpointRevision = state.lineage?.selector_checkpoint_revision;
    if (checkpointRevision && Number.isInteger(checkpointRevision) && checkpointRevision > 0 && checkpointRevision < this.workspace.revision
      && ["terminal_checkpoint", "interrupted_checkpoint", "modeling_checkpoint"].includes(state.lineage!.recovery_kind)) {
      const checkpoint = await RevisionWorkspace.openRevision(this.workspace.artifactRoot,
        this.evidence.job_id, this.evidence.target_id, checkpointRevision);
      const checkpointState = await checkpoint.readState();
      const checkpointRetry = checkpointState.selector_protocol?.stage_retries;
      const checkpointEvidence = await checkpoint.readEvidenceManifest();
      if (canonicalize(checkpointRetry) === canonicalize(previous)
        && checkpointEvidence.source.sha256 === this.evidence.source.sha256
        && checkpointEvidence.scope.confirmed_scope_fingerprint === this.evidence.scope.confirmed_scope_fingerprint
        && (checkpointEvidence.scope.confirmed_scope_fingerprint
          || checkpointEvidence.evidence_fingerprint === this.evidence.evidence_fingerprint)) workspaces.push(checkpoint);
    }
    for (const workspace of workspaces) {
      if (!(await pathExists(workspace.transcriptPath))) continue;
      let retained: { stage_rank: number; issue_count: number; revision: number; sequence: number } | undefined;
      let bestGateKnown = false;
      const stream = createReadStream(workspace.transcriptPath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes('"tool_execution_end"') || !line.includes('"advance_target_selector_stage"')) continue;
          let event: { event_type?: string; sequence?: number; payload?: { tool_name?: string; output?: {
            current_stage?: string; stage_retry?: { progress?: string; best_stage_rank?: number; best_issue_count?: number;
              evaluation_basis?: { stage_rank?: number } }; actual?: { issue_count?: number }; selector_issues?: unknown[];
          } } };
          try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== "object" || !Number.isInteger(event.sequence) || event.sequence! < 1) continue;
          const output = event.payload?.output;
          const retry = output?.stage_retry;
          if (!output || typeof output !== "object" || !retry || event.event_type !== "tool_execution_end"
            || event.payload?.tool_name !== "advance_target_selector_stage"
            || output.current_stage !== previous.stage
            || !["initial", "improved"].includes(retry?.progress ?? "")
            || retry.best_stage_rank !== 1 || retry.best_issue_count !== previous.best_issue_count
            || retry.evaluation_basis?.stage_rank !== 1
            || output.actual?.issue_count !== previous.best_issue_count
            || !Array.isArray(output.selector_issues)
            || output.selector_issues.length !== previous.best_issue_count) continue;
          bestGateKnown = true;
          if (output.selector_issues.length && output.selector_issues.every((issue) => issue !== null && typeof issue === "object"
            && ["selector_field_heading_evidence_forbidden", "selector_field_clause_line_mismatch"].includes(String((issue as { code?: unknown }).code)))) {
            retained = { stage_rank: 0.5, issue_count: previous.best_issue_count,
              revision: workspace.revision, sequence: event.sequence! };
          } else retained = undefined;
        }
      } finally { lines.close(); stream.destroy(); }
      if (bestGateKnown) return retained;
    }
    return undefined;
  }

  private async recordSelectorStageRetry(validation: {
    issues: unknown[];
    preflight?: TargetSelectorPreflight;
  }): Promise<{ count: number; exhausted: boolean; progress: string; best_issue_count: number; best_stage_rank: number;
    evaluation_basis: { stage_rank: number; issue_count: number; count_unit: "validation_issue" } }> {
    // Structure, field ownership, source coverage and compilation run in order;
    // fixing an earlier gate can expose a larger later list.
    const score = {
      stage_rank: validation.preflight?.response.stage === "table-structure" ? 0 : validation.preflight?.stage_rank ?? 1,
      issue_count: validation.issues.length,
    };
    const selectorText = await readFile(this.workspace.workingSelectorPath, "utf8");
    const selectors = migrateTargetSelectorPlanForAuthoring(strictJsonParse(selectorText)).plan;
    const diagnosticInputsFingerprint = await this.stageDiagnosticInputsFingerprint();
    const retainedState = await this.workspace.readState();
    const previousCheck = retainedState.selector_protocol?.last_stage_diagnostics;
    const previousRetry = retainedState.selector_protocol?.stage_retries;
    if (previousCheck?.inputs_fingerprint === diagnosticInputsFingerprint && previousRetry
      && previousCheck.contract_version === SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION
      && canonicalize(previousCheck.issues) === canonicalize(validation.issues)) {
      return { count: previousRetry.consecutive_non_improvements,
        exhausted: previousRetry.consecutive_non_improvements >= MAX_SELECTOR_PROTOCOL_FAILURES,
        progress: "unchanged_inputs_reused", best_issue_count: previousRetry.best_issue_count,
        best_stage_rank: previousRetry.best_stage_rank,
        evaluation_basis: { ...score, count_unit: "validation_issue" } };
    }
    const retainedFieldScore = await this.retainedFieldGateBestScore(retainedState);
    let progress = "initial";
    let retainedScoreApplied = false;
    const state = await this.workspace.updateState(current => {
      const protocol = selectorProtocolOrDefault(current.selector_protocol);
      const previous = protocol.stage_retries;
      if (!previous || previous.stage !== this.selectorStage) {
        protocol.stage_retries = {
          stage: this.selectorStage, best_stage_rank: score.stage_rank,
          best_issue_count: score.issue_count, consecutive_non_improvements: 0,
        };
      } else {
        const bestScore = retainedFieldScore && canonicalize(previous) === canonicalize(retainedState.selector_protocol?.stage_retries)
          ? retainedFieldScore : {
          stage_rank: previous.best_stage_rank, issue_count: previous.best_issue_count,
        };
        retainedScoreApplied = bestScore === retainedFieldScore;
        progress = compareTargetSelectorPreflightScore(score, bestScore);
        protocol.stage_retries = progress === "improved"
          ? { stage: this.selectorStage, best_stage_rank: score.stage_rank, best_issue_count: score.issue_count, consecutive_non_improvements: 0 }
          : { ...previous, best_stage_rank: bestScore.stage_rank,
            consecutive_non_improvements: previous.consecutive_non_improvements + 1 };
      }
      if (protocol.stage_retries.consecutive_non_improvements >= MAX_SELECTOR_PROTOCOL_FAILURES) {
        const checkpoint = {
          working_selector_sha256: sha256Text(selectorText), history_sequence: current.next_history_sequence,
          selector_stage: this.selectorStage,
        };
        protocol.stage_retries.checkpoint = { ...checkpoint, checkpoint_fingerprint: sha256Text(JSON.stringify(checkpoint)) };
      }
      // 续作定向：把本次校验未过项的紧凑清单带进状态，启动上下文直接告诉
      // 下一会话该定点处理什么，免去每段会话 10+ 次全量摸索读。
      // 完整修法及作者记录地址随行：max_messages 掐断的会话不会再触发校验，
      // 不把修法带进 focus，下段会话只能凭摘要重新猜。
      protocol.last_stage_issues = coalesceReferenceToolDiagnostics(validation.issues)
        .slice(0, 8).map(issue => actionableSelectorIssue(issue, selectors)).map((issue) => {
        const record = issue as { code?: unknown; path?: unknown; details?: unknown; how_to_pass?: unknown;
          next_tool?: unknown; next_tool_arguments?: unknown; record_read?: unknown };
        const details = record.details as { evidence_ids?: unknown; actual?: { evidence_ids?: unknown } } | undefined;
        const evidenceIds = details?.evidence_ids ?? details?.actual?.evidence_ids ?? [];
        return {
          code: typeof record.code === "string" ? record.code : "unknown",
          path: typeof record.path === "string" ? record.path : "",
          ...(Array.isArray(evidenceIds) && evidenceIds.length
            ? { evidence_ids: evidenceIds.slice(0, 4).map(String) } : {}),
          ...(typeof record.how_to_pass === "string" && record.how_to_pass.trim()
            ? { how_to_pass: record.how_to_pass } : {}),
          ...(record.record_read && typeof record.record_read === "object" && !Array.isArray(record.record_read)
            && (record.record_read as { tool?: unknown }).tool === "read_target_selectors"
            && Buffer.byteLength(JSON.stringify(record.record_read), "utf8") <= 4096
            ? { record_read: structuredClone(record.record_read as NonNullable<NonNullable<NonNullable<RevisionState["selector_protocol"]>["last_stage_issues"]>[number]["record_read"]>) } : {}),
          ...(typeof record.next_tool === "string" && record.next_tool_arguments
            && typeof record.next_tool_arguments === "object" && !Array.isArray(record.next_tool_arguments)
            && Buffer.byteLength(JSON.stringify(record.next_tool_arguments), "utf8") <= 4096
            ? { next_tool: record.next_tool, next_tool_arguments: structuredClone(record.next_tool_arguments as Record<string, unknown>) } : {}),
        };
      });
      protocol.last_stage_diagnostics = { inputs_fingerprint: diagnosticInputsFingerprint,
        contract_version: SELECTOR_STAGE_DIAGNOSTIC_CONTRACT_VERSION, issues: structuredClone(validation.issues) };
      current.selector_protocol = protocol;
    });
    const retry = state.selector_protocol!.stage_retries!;
    return {
      count: retry.consecutive_non_improvements,
      exhausted: retry.consecutive_non_improvements >= MAX_SELECTOR_PROTOCOL_FAILURES,
      progress, best_issue_count: retry.best_issue_count, best_stage_rank: retry.best_stage_rank,
      evaluation_basis: { stage_rank: score.stage_rank, issue_count: score.issue_count, count_unit: "validation_issue" },
      ...(retainedScoreApplied && retainedFieldScore ? { retained_best_score: { original_stage_rank: 1, stage_rank: retainedFieldScore.stage_rank,
        issue_count: retainedFieldScore.issue_count, receipt_revision: retainedFieldScore.revision,
        receipt_sequence: retainedFieldScore.sequence,
        counter_before_check: retainedState.selector_protocol!.stage_retries!.consecutive_non_improvements } } : {}),
    };
  }

  private async targetSourceClauseIssues(
    selectors: TargetSelectorPlan,
    compiled: PersistedSemanticSourcePlan,
    selectorFingerprint: string,
  ): Promise<unknown[]> {
    const ledger = await this.workspace.readDocumentLedger();
    if (!ledger) return [];
    if (!ledger.clauses.some(ledgerRequiredClausePredicate(ledger))) return [];
    const registry = await this.workspace.readSourceSpanRegistry();
    const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
    const result = materialize(compiled, this.evidence, selectorFingerprint).result;
    return result.inspection_lots.flatMap((lot) => lot.items).flatMap((item) => {
      if (item.source_clause.trim()) return [];
      const selectorIndex = selectors.items.findIndex((selector) =>
        semanticItemIdForSelectorKey(this.evidence.target_id, selector.key) === item.item_id
      );
      const selector = selectorIndex >= 0 ? selectors.items[selectorIndex] : undefined;
      const coreSpanIds = selector ? this.selectorCoreSpanIds(selector) : [];
      const evidenceIdsFor = (spanIds: readonly string[]) => [...new Set(spanIds.flatMap((spanId) => {
        const span = spanById.get(spanId);
        return span ? [span.evidence_id] : [];
      }))];
      const clauseIdsFor = (spanIds: readonly string[]) =>
        this.ledgerClauseIdsForSpans(spanIds, registry, ledger);
      const directTableOwnershipPaths = selectorIndex >= 0 && selector?.table?.source_kind === "direct"
        ? [`/items/${selectorIndex}/table/properties`]
        : [];
      const directTableOwnershipBindings = selector?.table?.source_kind === "direct"
        ? selector.table.properties
        : null;
      const directTableOwnershipSpanIds = directTableOwnershipBindings ? coreSpanIds : [];
      const fieldBindingSpanIds = selector
        ? Object.fromEntries(Object.entries(selector.fields).map(([field, binding]) => [field, binding.span_ids]))
        : {};
      const fieldBindingPaths = selectorIndex >= 0 && selector
        ? Object.keys(selector.fields).map((field) => `/items/${selectorIndex}/fields/${field}/span_ids`)
        : ["/items"];
      const bindingSpanIds = {
        criterion: selector?.criterion_span_ids ?? [],
        continuation: selector?.continuation_span_ids ?? [],
        fields: fieldBindingSpanIds,
        direct_table_ownership: directTableOwnershipSpanIds,
      };
      const bindingLedgerCandidateClauseIds = {
        criterion: clauseIdsFor(bindingSpanIds.criterion),
        continuation: clauseIdsFor(bindingSpanIds.continuation),
        fields: Object.fromEntries(Object.entries(bindingSpanIds.fields)
          .map(([field, spanIds]) => [field, clauseIdsFor(spanIds)])),
        direct_table_ownership: clauseIdsFor(bindingSpanIds.direct_table_ownership),
      };
      const bindingEvidenceIds = {
        criterion: evidenceIdsFor(bindingSpanIds.criterion),
        continuation: evidenceIdsFor(bindingSpanIds.continuation),
        fields: Object.fromEntries(Object.entries(bindingSpanIds.fields)
          .map(([field, spanIds]) => [field, evidenceIdsFor(spanIds)])),
        direct_table_ownership: evidenceIdsFor(bindingSpanIds.direct_table_ownership),
      };
      const candidateClauseIds = this.ledgerClauseIdsForSpans(coreSpanIds, registry, ledger);
      const candidateEvidenceIds = unique([
        ...evidenceIdsFor(coreSpanIds),
        ...bindingEvidenceIds.criterion,
        ...bindingEvidenceIds.continuation,
        ...Object.values(bindingEvidenceIds.fields).flat(),
        ...bindingEvidenceIds.direct_table_ownership,
      ]).slice(0, 16);
      const requirementAlreadyBindsCandidate = candidateClauseIds.length === 1
        && bindingLedgerCandidateClauseIds.fields.requirement?.includes(candidateClauseIds[0]!) === true;
      const path = directTableOwnershipPaths[0] ?? (selectorIndex >= 0
        ? `/items/${selectorIndex}/criterion_span_ids`
        : "/items");
      const writablePaths = selectorIndex >= 0
        ? [
            ...directTableOwnershipPaths,
            `/items/${selectorIndex}/criterion_span_ids`,
            `/items/${selectorIndex}/continuation_span_ids`,
            ...fieldBindingPaths,
          ]
        : ["/items"];
      return [{
        code: "selector_source_clause_unresolved",
        path,
        message: "当前最终验收项按既有来源归属优先级仍无法唯一推导所属父条款；高优先级来源冲突时不会退回字段来源覆盖结果，source_clause 是编译派生字段，不能直接填写。",
        details: {
          item_id: item.item_id,
          item_name: item.name,
          actual: {
            item_id: item.item_id,
            item_name: item.name,
            source_clause: item.source_clause,
            derived_source_clause: item.source_clause,
            candidate_clause_ids: candidateClauseIds,
            candidate_evidence_ids: candidateEvidenceIds,
            current_bindings: {
              criterion_span_ids: bindingSpanIds.criterion,
              continuation_span_ids: bindingSpanIds.continuation,
              field_span_ids: bindingSpanIds.fields,
              direct_table_properties: directTableOwnershipBindings,
            },
            ledger_clause_candidates_by_binding: bindingLedgerCandidateClauseIds,
            ledger_clause_candidate_note: "这些 clause ids 仅由 ledger 对当前 span 的位置映射得到，用于诊断候选；不表示 materializer 已采用该归属。",
            binding_evidence_ids: bindingEvidenceIds,
            requirement_already_binds_candidate_clause: requirementAlreadyBindsCandidate,
          },
          candidate_clause_ids: candidateClauseIds,
          evidence_ids: candidateEvidenceIds,
          writable_paths: writablePaths,
          derivation_priority: [
            {
              rank: 1,
              source: "direct_table_cell_ownership",
              applies: directTableOwnershipPaths.length > 0,
              writable_paths: directTableOwnershipPaths,
              conflict_blocks_lower_priority: true,
            },
            {
              rank: 2,
              source: "semantic_item_ownership",
              applies: Boolean(selector),
              writable_paths: selectorIndex >= 0
                ? [`/items/${selectorIndex}/criterion_span_ids`, `/items/${selectorIndex}/continuation_span_ids`]
                : ["/items"],
              priority: "acceptance_item 来源优先于其他 semantic 来源；选中的来源中 primary evidence 优先",
              conflict_blocks_lower_priority: true,
            },
            {
              rank: 3,
              source: "field_binding_fallback",
              applies: Boolean(selector),
              writable_paths: fieldBindingPaths,
              conditional: true,
              available_when: "更高优先级未发生条款冲突且尚未唯一解析父条款；汇总全部文本字段来源片段并按文字长度降序检查时，某个片段只映射到一个 ledger 条款，且 semantic candidates 非空时该条款也属于其中",
            },
          ],
          repair_options: [
            ...(directTableOwnershipPaths.length ? [{
              kind: "repair_direct_table_ownership",
              writable_paths: directTableOwnershipPaths,
              how_to_pass: "直接表格 item 先消费由 table.properties 编译出的既有 cell_evidence 归属角色；只核对并修正原文实际承担这些角色的 span，不把 criterion 当成覆盖表格冲突的捷径。",
            }] : []),
            {
              kind: "repair_semantic_item_ownership",
              writable_path: selectorIndex >= 0 ? `/items/${selectorIndex}/criterion_span_ids` : "/items",
              writable_paths: selectorIndex >= 0
                ? [`/items/${selectorIndex}/criterion_span_ids`, `/items/${selectorIndex}/continuation_span_ids`]
                : ["/items"],
              how_to_pass: "按原文核对真正承担当前 item 归属的 criterion/continuation；acceptance_item 与 primary 来源的既有优先级仍适用，不得机械追加所有候选。",
            },
            {
              kind: "use_text_field_fallback",
              writable_path: fieldBindingPaths[0],
              writable_paths: fieldBindingPaths,
              conditional: true,
              available_when: "直接表格及 semantic item 归属均未冲突且未唯一解析；字段片段只映射到一个 ledger 条款，并在 semantic candidates 非空时属于该候选集合",
              already_binds_candidate_clause: requirementAlreadyBindsCandidate,
              how_to_pass: "仅满足 available_when 时，name、requirement、method、quantity、note 的现有精确来源片段才汇总后按文字长度降序参与合法 fallback；不要假定任一字段必然覆盖高优先级结果。",
            },
            {
              kind: "split_cross_clause_judgments",
              writable_path: "/items",
              conditional: true,
              how_to_pass: "只有原文确实包含可独立判定的跨条款业务判断时才拆成真实 item，并分别保留各自判据与上下文。",
            },
          ],
          required_action: requirementAlreadyBindsCandidate
            ? `当前 requirement 已绑定 ledger 候选条款 ${candidateClauseIds[0]}；重复提交相同绑定不会增加修复依据。先按 derivation_priority 核对 table/semantic 来源与 ledger 定位条件，再依据原文修正对应作者路径；只有原文确有独立判断时才拆项。`
            : candidateClauseIds.length === 1
              ? `ledger 位置映射给出候选条款 ${candidateClauseIds[0]}，但不表示 materializer 已采用。先按 derivation_priority 核对 table/semantic 来源与定位条件，再依据原文修正对应作者路径。`
              : "先按 derivation_priority 核对 table/semantic 来源、ledger 定位候选和字段 fallback 条件，再依据原文修正对应作者路径；若原文确有跨条款独立判断，才拆成分别可判定的 item。",
          do_not: "write source_clause directly; it is compiler-derived metadata",
          allowed_actions: [
            ...(directTableOwnershipPaths.length
              ? ["直接表格来源时，先在 table.properties 中修正实际编译为 cell_evidence 归属角色的 span；该层冲突不会由 criterion 或字段来源覆盖。"]
              : []),
            "按原文修正当前 item 的高优先级 semantic 归属来源；criterion/continuation 是否生效取决于既有节点优先级，不是三条路径任意选一。",
            "仅在更高优先级没有条款冲突且未唯一解析、字段候选唯一并满足 semantic candidates 约束时，保留或修正现有文本字段的精确来源作为 fallback。",
            "原文确有多个可独立判断时拆成真实 item，分别保留完整判据和必要上下文。",
          ],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: selector ? { collection: "items", key: selector.key } : { collection: "items" },
          save_tool: "stage_target_selector_draft",
          how_to_pass: "先用 read_target_selectors 读取当前 item 和 actual.current_bindings，再用 open_evidence 核对 binding_evidence_ids，必要时用 locate_evidence_span 登记精确片段。严格按 derivation_priority 检查：direct table 先消费 table.properties 编译出的既有 cell_evidence 归属角色；随后是 semantic item 归属，其中 acceptance_item 先于其他节点、primary 来源优先；这些高优先级来源一旦产生条款冲突，任何文本字段 fallback 都不会执行。若 actual.requirement_already_binds_candidate_clause=true，只重新绑定相同 requirement 不能修复；应先核对 table/semantic 来源与 ledger 定位条件，再由原文决定修正哪个作者路径或是否确需拆项。只有更高优先级没有冲突且仍无唯一父条款、汇总的字段片段按文字长度降序检查时只映射一个 ledger 条款，并在 semantic candidates 非空时属于该集合，现有文本字段来源才是合法 fallback。actual.ledger_clause_candidates_by_binding 仅是诊断候选，不表示 materializer 已采用。不得直接写 source_clause，也不要调用 read_reference_facts 猜父条款；用 stage_target_selector_draft 保存后重新验证。",
          do_not_edit: "compiler-derived source_clause、不可变原文、编译产物、其他已正确 item，以及当前 item 中不属于 writable_paths 的字段。",
        },
      }];
    });
  }

  /**
   * 封存前的底账必抽条文核对：与 batch 终门（reconcileLedgerCoverage /
   * targetLedgerCoverageWithFallback）同一判据，只是前移到 target 预检。
   * direct-validation 路径此前不做该核对，缺口要到全体封存后的整批对账才暴露，
   * 模型没有任何机会按回条修复（实测 GB 50202 job 20260921-004057-9c1a：
   * 52/52 封存后终门报缺 7.5.3，而该 target 的检查点里从未出现过相关回条）。
   */
  private async targetLedgerRequiredClauseIssues(
    compiled: PersistedSemanticSourcePlan,
    selectorFingerprint: string,
  ): Promise<unknown[]> {
    const ledger = await this.workspace.readDocumentLedger();
    if (!ledger) return [];
    if (!ledger.clauses.some(ledgerRequiredClausePredicate(ledger))) return [];
    const targetRecord = await this.readBatchTargetRecord();
    if (!targetRecord) return [];
    const discoveryDir = dirname(this.workspace.documentLedgerPath);
    let atoms: Array<{ atom_id: string; start_line: number; end_line: number; text: string }> = [];
    try {
      atoms = (await readJson<DocumentEvidence>(join(discoveryDir, "document-evidence.json"))).atoms;
    } catch {
      atoms = [];
    }
    let excludedClauseIds: string[] = [];
    try {
      const receipt = await readJson<{ coverage_review?: { excluded_clause_ids?: string[] } }>(
        this.workspace.discoverySealReceiptPath,
      );
      excludedClauseIds = receipt.coverage_review?.excluded_clause_ids ?? [];
    } catch {
      excludedClauseIds = [];
    }
    const record = targetRecord as {
      name?: unknown;
      ledger_window_id?: unknown;
      evidence_fragments?: unknown;
      materialization?: unknown;
      start_line?: unknown;
      end_exclusive_line?: unknown;
      work_scope?: { start_line?: unknown; end_exclusive_line?: unknown } | null;
    };
    const lineOf = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const refStart = lineOf(record.start_line) ?? lineOf(record.work_scope?.start_line);
    const refEnd = lineOf(record.end_exclusive_line) ?? lineOf(record.work_scope?.end_exclusive_line);
    const targetRef: LedgerWindowTargetRef = {
      ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
      ...(typeof record.ledger_window_id === "string" && record.ledger_window_id
        ? { ledger_window_id: record.ledger_window_id }
        : {}),
      ...(Array.isArray(record.evidence_fragments)
        ? { evidence_fragments: record.evidence_fragments as Array<{ atom_id: string; text: string }> }
        : {}),
      ...(record.materialization && typeof record.materialization === "object"
        ? { materialization: record.materialization as { lot_basis_fragments?: Array<{ atom_id: string; text: string }> } }
        : {}),
      ...(refStart !== undefined ? { start_line: refStart } : {}),
      ...(refEnd !== undefined ? { end_exclusive_line: refEnd } : {}),
    };
    const resolvedWindow = resolveLedgerWindowForTarget(ledger, targetRef, atoms);
    const confirmedPrimaryRanges = this.evidence.scope.primary_source_ranges?.filter(range =>
      range.end_exclusive_line > range.start_line
    ) ?? [];
    const headingLine = targetRef.start_line ?? 1;
    const windowStart = confirmedPrimaryRanges.length
      ? Math.min(...confirmedPrimaryRanges.map(range => range.start_line))
      : resolvedWindow?.start_line ?? headingLine;
    const windowEnd = confirmedPrimaryRanges.length
      ? Math.max(...confirmedPrimaryRanges.map(range => range.end_exclusive_line))
      : resolvedWindow?.end_exclusive_line ?? headingLine + 1;
    const windowId = resolvedWindow?.window_id
      ?? (typeof record.ledger_window_id === "string" ? record.ledger_window_id : "");
    const materialized = materialize(compiled, this.evidence, selectorFingerprint).result;
    const materializedItems = materialized.inspection_lots.flatMap((lot) => lot.items);
    const clauseIds = ledgerClauseIdSet(ledger);
    const lineIndex = evidenceLineIndex(this.evidence.evidence);
    // 与全书终门使用相同的覆盖来源：item 主归属、已验证的字段绑定，以及
    // 真正被接收的已解析引用原点。引用原点只用于覆盖，不改 item 的主归属。
    const sourceClauses = [...new Set(materializedItems.map((item) =>
      resolveItemClauseId(item, clauseIds, ledger, lineIndex),
    ).filter(Boolean))];
    const referencedClauses = accountedReferenceOriginEvidenceIds(
      compiled,
      this.evidence.reference_occurrences,
    ).map((evidenceId) => resolveItemClauseId(
      { evidence_ids: [evidenceId] }, clauseIds, ledger, lineIndex,
    )).filter(Boolean);
    const coveredClauses = [...new Set([
      ...sourceClauses,
      ...boundFieldClauseIds(compiled, this.evidence.evidence, ledger),
      ...referencedClauses,
    ])];
    const evaluate = (required_clause_ids?: readonly string[]) => evaluateTargetLedgerCoverage({
      ledger,
      start_line: windowStart,
      end_exclusive_line: windowEnd,
      source_clauses: coveredClauses,
      not_item_clause_ids: excludedClauseIds,
      evidence: this.evidence.evidence,
      ...(required_clause_ids ? { required_clause_ids } : {}),
    });
    let coverage = evaluate(confirmedPrimaryRanges.length
      ? requiredClauseIdsInSourceRanges(ledger, confirmedPrimaryRanges) : undefined);
    let inferredSectionKeys: string[] = [];
    if (coverage.vacuous && !confirmedPrimaryRanges.length) {
      // 节推断只认 item 主归属条文：引用原点/字段绑定证明「从别处接收内容」，
      // 不能反过来把外部章节的全部必抽条文摊给本 target（否则跨章引用必然误报缺口）。
      const inferred = ledgerSectionsForClauses(ledger, sourceClauses);
      if (inferred.required_clause_ids.length) {
        coverage = evaluate(inferred.required_clause_ids);
        inferredSectionKeys = inferred.section_keys;
      }
    }
    if (coverage.vacuous || !coverage.gap_clause_ids.length) return [];
    const clauseById = new Map(ledger.clauses.map((clause) => [clause.clause_id, clause]));
    // 一个条文可领起多个兄弟 target 的表格：整条文范围与后续表格相交，
    // 不等于该 target 负责条文开头。以已确认的主资料范围判定条文归属；
    // 旧数据退回 target 行范围。无人认领的缺口仍由全书对账兜底。
    const ownRanges = confirmedPrimaryRanges.length
      ? confirmedPrimaryRanges
      : targetRef.start_line !== undefined && targetRef.end_exclusive_line !== undefined
        ? [{ start_line: targetRef.start_line, end_exclusive_line: targetRef.end_exclusive_line }]
        : [];
    const missingClauseIds = coverage.gap_clause_ids.filter((clauseId) => {
      const clause = clauseById.get(clauseId);
      if (!clause || !ownRanges.length) return true;
      return ownRanges.some((range) =>
        clause.line >= range.start_line && clause.line < range.end_exclusive_line
      );
    });
    if (!missingClauseIds.length) return [];
    const firstMissing = missingClauseIds[0]!;
    const firstClause = clauseById.get(firstMissing);
    return [{
      code: "selector_ledger_required_clause_gap",
      path: "/items",
      message: "底账必抽条文核对未通过：窗口内仍有条文未由真实验收项、已应用抽样规则或已解析引用承载。",
      details: {
        ledger_window_id: windowId,
        window: { start_line: windowStart, end_exclusive_line: windowEnd },
        primary_source_ranges: confirmedPrimaryRanges,
        frozen_semantic_basis: await this.readFrozenTargetSemanticBasis() ?? null,
        inferred_section_keys: inferredSectionKeys,
        required_clause_count: coverage.required_clause_ids.length,
        missing_clause_ids: missingClauseIds,
        missing_clauses: missingClauseIds.map((clauseId) => {
          const clause = clauseById.get(clauseId);
          return {
            clause_id: clauseId,
            line: clause?.line,
            end_exclusive_line: clause?.end_exclusive_line,
            excerpt: clause?.text.slice(0, 240),
            references_table: clause?.references_table,
          };
        }),
        writable_paths: ["/items", "/references", "/sampling_rules"],
        next_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
        required_action: "account_for_missing_clause_with_source_supported_item_or_resolved_reference",
        scope_conflict_route: {
          kind: "frozen_scope_conflict",
          next_tool: "report_target_blocker",
          required_parameters: ["preflight_issue_fingerprint", "evidence_span_ids", "affected_selector_paths", "explanation"],
          instruction: "若缺失条文的实际对象与发现阶段冻结的 subject/boundary_reason 冲突，打开原文并登记精确 span，以本次预检 issue_fingerprint 和 affected_selector_paths=[\"/items\"] 报告冲突。报告保留检查点并停止等待维护者复核，不认定覆盖通过；不能编辑冻结范围或为填缺口造无关条目。",
        },
      },
      owner: "selector_input_error",
      how_to_pass: [
        `先核对缺失条文 ${firstMissing} 的原文（行范围 ${firstClause?.line ?? "?"}-${firstClause?.end_exclusive_line ?? "?"}）以及现有 items/references。`,
        "若条文本身规定独立验收属性，取得原文 span 后向 draft.items 增加真实条目，以 criterion_span_ids 和对应 fields 绑定原文；不要把已有表格行重复造项。",
        "若条文只是指向表格或其他条文，使用 list_reference_occurrences 找到该处引用；在 draft.references 中绑定真实被引成分、接收 item 和业务字段。只有已解析且有目标证据及真实接收绑定的引用（或合法的非计数 placeholder）才计入覆盖。不要为引语另造验收项，也不要仅为通过预检把引语塞进无关 item。",
        "若条文规定共享抽样，在 sampling_rules 中按原文绑定组件和分支，并由真实 item.sampling 选用适用分支。只有实际应用的已验证来源计入覆盖，未选分支或孤立规则不计；无需把已应用规则重复写入 quantity 字段。",
        "保存后重试 advance/commit；不要伪造证据或直接填写 compiler-derived source_clause。",
      ].join(""),
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: firstClause?.references_table ? "references" : "items" },
      save_tool: "stage_target_selector_draft",
    }];
  }

  private async readBatchTargetRecord(): Promise<Record<string, unknown> | undefined> {
    try {
      const batch = await readJson<{ targets?: Array<Record<string, unknown>> }>(this.workspace.batchTargetPath);
      return (batch.targets ?? []).find((target) => target.target_id === this.evidence.target_id);
    } catch {
      return undefined;
    }
  }

  private async readFrozenTargetSemanticBasis(): Promise<{ subject: string; boundary_reason: string } | undefined> {
    try {
      const plan = await readJson<{ targets: Array<{ target_id: string;
        semantic_basis?: { subject: string; boundary_reason: string } }> }>(
        join(dirname(this.workspace.documentLedgerPath), "document-target-plan.json"),
      );
      return plan.targets.find(target => target.target_id === this.evidence.target_id)?.semantic_basis;
    } catch {
      return undefined;
    }
  }

  private async evaluateTargetSelectorPreflight(
    selectors: TargetSelectorPlan,
    applyLanguageReviewPolicy = true,
    applyNameReviewPolicy = true,
  ): Promise<TargetSelectorPreflight> {
    const cachePath = join(this.workspace.root, "selector-preflight-cache.json");
    const inputs = async (candidate: TargetSelectorPlan) => {
      const state = await this.workspace.readState();
      return sha256Json({ inputs: await this.stageDiagnosticInputsFingerprint(), selector: targetSelectorFingerprint(candidate),
        opened: state.opened_evidence_ids, windows: state.opened_evidence_window_keys,
        language: state.selector_protocol?.language_review_markers,
        names: state.selector_protocol?.name_review_markers });
    };
    const key = await inputs(selectors);
    if (await pathExists(cachePath)) {
      const cached = await readJson<{ inputs: string; result: TargetSelectorPreflight }>(cachePath);
      if (cached.inputs === key) {
        const review = cached.result.response.model_review as { observations?: unknown[] } | undefined;
        this.modelReviewObservations.clear();
        for (const observation of review?.observations ?? []) this.modelReviewObservations.set(sha256Json(observation), observation);
        return { ...cached.result,
          response: { ...cached.result.response, preflight_reused: true, full_stage_check_performed: false } };
      }
    }
    this.modelReviewObservations.clear();
    const result = await this.computeTargetSelectorPreflight(selectors, applyLanguageReviewPolicy, applyNameReviewPolicy);
    result.response = { ...result.response, validation_boundary: STRUCTURAL_VALIDATION_BOUNDARY,
      model_review: { blocking: false, decision_owner: "model", observations: [...this.modelReviewObservations.values()],
        instruction: "这些是业务审阅线索，不是程序认定的错误。依据原文判断，必要时修订；结构通过不证明内容正确。" } };
    await atomicWriteJson(cachePath, { inputs: await inputs(result.selectors), result });
    return result;
  }

  private async computeTargetSelectorPreflight(
    selectors: TargetSelectorPlan,
    applyLanguageReviewPolicy = true,
    applyNameReviewPolicy = true,
  ): Promise<TargetSelectorPreflight> {
    let workingSelectors = selectors;
    const projected = projectReferencedTableDestinations(workingSelectors);
    if (projected.added.length > 0) {
      workingSelectors = projected.plan;
      await atomicWriteJson(this.workspace.workingSelectorPath, workingSelectors);
      await this.workspace.appendEvent("referenced_table_destinations_projected", {
        added: projected.added,
        selector_fingerprint: targetSelectorFingerprint(workingSelectors),
      });
    }
    let selectorFingerprint = targetSelectorFingerprint(workingSelectors);
    let compilerContext: SelectorCompilerContext | undefined;
    let assessmentScope = "table-structure";
    const completedScopes: string[] = [];
    const beginAssessment = (scope: string) => { completedScopes.push(assessmentScope); assessmentScope = scope; };
    const result = async (
      response: ToolResponse,
      issues: unknown[],
      issueOwner: TargetSelectorPreflight["issue_owner"],
      stageRank: number,
      stageName: TargetSelectorPreflight["stage_name"],
      compiled?: PersistedSemanticSourcePlan,
      compiledContent?: string,
    ): Promise<TargetSelectorPreflight> => {
      const diagnostics = coalesceSelectorIssueDiagnostics(issues);
      await this.saveSelectorDiagnostics(diagnostics, workingSelectors,
        { scope: assessmentScope, completed_scopes: completedScopes, complete: stageName === "complete" && response.ok });
      return {
        ok: response.ok,
        stage_rank: stageRank,
        stage_name: stageName,
        issue_owner: issueOwner,
        issues: diagnostics,
        issue_count: diagnostics.length,
        issue_fingerprint: sha256Json(diagnostics),
        response,
        selectors: workingSelectors,
        ...(compilerContext ? { compiler_context: compilerContext } : {}),
        ...(compiled ? { compiled } : {}),
        ...(compiledContent ? { compiled_content: compiledContent } : {}),
      };
    };

    const sourceSpanRegistry = await this.workspace.readSourceSpanRegistry();
    const access = await this.evidenceAccessSnapshot(false);
    const eligibleTableEvidenceIds = this.eligibleTableEvidenceIds(access.accessByEvidenceId);
    const tableStructurePlan = await this.projectAccessibleTableStructurePlan(
      await this.readTableStructurePlan(),
    );
    const tableExpansion = tableExpansionState(
      this.evidence,
      sourceSpanRegistry,
      workingSelectors,
      tableStructurePlan,
      eligibleTableEvidenceIds,
    );
    await atomicWriteJson(join(this.workspace.root, "table-expansion-obligations.json"), {
      schema_version: "table-expansion-obligations/v1",
      ...tableExpansion,
    });
    const preflightState = await this.workspace.readState();
    const preflightProtocol = selectorProtocolOrDefault(preflightState.selector_protocol);
    const acceptedSourceLanguageReviews = selectorCompilerAcceptedReviews(
      preflightProtocol.language_review_markers,
    );
    const acceptedVerdictNameReviews = selectorCompilerAcceptedReviews(
      preflightProtocol.name_review_markers,
    );
    compilerContext = createSelectorCompilerContext({
      manifest: this.evidence,
      selectors: workingSelectors,
      tableStructurePlan,
      eligibleTableEvidenceIds,
      acceptedSourceLanguageReviews,
      acceptedVerdictNameReviews,
    });
    const tableStructureIssues = [
      ...validateTableStructurePlan(tableStructurePlan, this.evidence, sourceSpanRegistry),
      ...pendingComplexTableStructureIssues(tableStructurePlan, this.evidence),
    ].map((issue) => ({ ...issue, owner: "selector_input_error" }));
    if (tableStructureIssues.length) {
      return result({
        ok: false,
        terminal: false,
        stage: "table-structure",
        selector_fingerprint: selectorFingerprint,
        error: "selector_input_error",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        selector_issues: tableStructureIssues,
        instruction: "先读取已保存结构和未决行，用 stage_table_structure 完成复杂表的题注、表头、数据行、重复表头、续表与表注决定；status=review 时不得进入 commit。",
      }, tableStructureIssues, "selector_input_error", 1, "selector-local");
    }
    beginAssessment("field-roles");
    const fieldRoleIssues = this.structuralIssues(await this.targetFieldRoleIssues(workingSelectors, sourceSpanRegistry))
      .map((issue) => ({ ...(issue as Record<string, unknown>), owner: "selector_input_error" }));
    if (fieldRoleIssues.length) {
      return result({
        ok: false,
        terminal: false,
        stage: "target-selectors",
        selector_fingerprint: selectorFingerprint,
        error: "selector_input_error",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        selector_issues: fieldRoleIssues,
        instruction: "用返回的当前条款候选替换报错的 method/quantity/sampling span。回条已包含实际绑定原文，仅修改 reason 不能使错误 span 合法。",
      }, fieldRoleIssues, "selector_input_error", 0.5, "selector-local");
    }
    beginAssessment("source-dispositions");
    const dispositionEvidence = this.evidence.evidence.filter((record) =>
      this.evidenceAccess(record, access.accessByEvidenceId).access_mode !== "isolated_reference"
    );
    const dispositionEvidenceIds = new Set(dispositionEvidence.map((record) => record.evidence_id));
    const dispositionCoverage = selectorDispositionCoverage({
      selectors: workingSelectors,
      evidence: dispositionEvidence,
      spans: sourceSpanRegistry.spans.filter((span) => dispositionEvidenceIds.has(span.evidence_id)),
    });
    if (dispositionCoverage.uncovered_required_ids.length) {
      const selectorIssues = await this.routeSelectorCompilerEvidenceReads(classifyCompilerInvariantIssues(
        workingSelectors,
        sourceSpanRegistry,
        dispositionCoverage.uncovered_required_ids.map((evidenceId) => ({
          code: "compiler_unhandled_evidence",
          path: "/evidence_dispositions",
          message: "Compiler must materialize every required source disposition",
          details: { evidence_ids: [evidenceId] },
        })),
      )) as ReturnType<typeof classifyCompilerInvariantIssues>;
      const actionable = await this.actionableEvidenceBindings(selectorIssues);
      return result({
        ok: false,
        terminal: false,
        stage: "target-selectors",
        selector_fingerprint: selectorFingerprint,
        error: "selector_input_error",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        selector_issues: selectorIssues,
        instruction: "提交前仍有已公开且必须处置的来源未进入作者选择器。依据原文绑定到真实语义字段，或显式登记 source_dispositions；该检查不替模型决定语义。",
        ...actionable,
      }, selectorIssues, "selector_input_error", 1, "selector-local");
    }
    beginAssessment("selector-compiler");
    let compiled: PersistedSemanticSourcePlan;
    let compilerReviewIssues: TargetSelectorCompileError["issues"] = [];
    try {
      compiled = compileTargetSelectorsWithContext(
        workingSelectors,
        sourceSpanRegistry,
        this.evidence,
        compilerContext,
        issues => { compilerReviewIssues = [...compilerReviewIssues, ...issues]; },
      );
    } catch (error) {
      if (!(error instanceof TargetSelectorCompileError)) throw error;
      const selectorIssues = await this.routeSelectorCompilerEvidenceReads(
        classifySelectorIssues("selector-local", error.issues),
      ) as ReturnType<typeof classifySelectorIssues>;
      if (applyLanguageReviewPolicy) {
        const state = await this.workspace.readState();
        const protocol = selectorProtocolOrDefault(state.selector_protocol);
        const policy = applyRepeatedSourceLanguageNamePolicy(
          selectors,
          selectorIssues,
          protocol.language_correction_attempts ?? {},
          selectorFingerprint,
        );
        const attemptsChanged = sha256Json(policy.correction_attempts)
          !== sha256Json(protocol.language_correction_attempts ?? {});
        if (attemptsChanged || policy.markers.length > 0) {
          await this.workspace.updateState((current) => {
            const currentProtocol = selectorProtocolOrDefault(current.selector_protocol);
            currentProtocol.language_correction_attempts = policy.correction_attempts;
            for (const marker of policy.markers) {
              const existing = currentProtocol.language_review_markers?.findIndex((entry) =>
                entry.path === marker.path
              ) ?? -1;
              if (existing >= 0) currentProtocol.language_review_markers![existing] = marker;
              else currentProtocol.language_review_markers!.push(marker);
            }
            current.selector_protocol = currentProtocol;
          });
        }
        if (policy.markers.length > 0) {
          await this.workspace.appendEvent("selector_source_language_warning_accepted", {
            first_selector_fingerprints: Object.fromEntries(policy.markers.map((marker) => [
              marker.path,
              protocol.language_correction_attempts?.[marker.path] ?? "",
            ])),
            current_selector_fingerprint: selectorFingerprint,
            markers: policy.markers,
            blocking: false,
          });
          return this.evaluateTargetSelectorPreflight(selectors, false);
        }
      }
      if (applyNameReviewPolicy) {
        const state = await this.workspace.readState();
        const protocol = selectorProtocolOrDefault(state.selector_protocol);
        const policy = applyRepeatedVerdictNamePolicy(
          selectors,
          selectorIssues,
          protocol.name_correction_attempts ?? {},
          selectorFingerprint,
        );
        const attemptsChanged = sha256Json(policy.correction_attempts)
          !== sha256Json(protocol.name_correction_attempts ?? {});
        if (attemptsChanged || policy.markers.length > 0) {
          await this.workspace.updateState((current) => {
            const currentProtocol = selectorProtocolOrDefault(current.selector_protocol);
            currentProtocol.name_correction_attempts = policy.correction_attempts;
            for (const marker of policy.markers) {
              const existing = currentProtocol.name_review_markers?.findIndex((entry) =>
                entry.path === marker.path
              ) ?? -1;
              if (existing >= 0) currentProtocol.name_review_markers![existing] = marker;
              else currentProtocol.name_review_markers!.push(marker);
            }
            current.selector_protocol = currentProtocol;
          });
        }
        if (policy.markers.length > 0) {
          await this.workspace.appendEvent("selector_verdict_name_warning_accepted", {
            first_selector_fingerprints: Object.fromEntries(policy.markers.map((marker) => [
              marker.path,
              protocol.name_correction_attempts?.[marker.path] ?? "",
            ])),
            current_selector_fingerprint: selectorFingerprint,
            markers: policy.markers,
            blocking: false,
          });
          return this.evaluateTargetSelectorPreflight(selectors, applyLanguageReviewPolicy, false);
        }
      }
      const compilerOwned = selectorIssues.some((issue) => issue.owner === "compiler_invariant_violation");
      const issueOwner = compilerOwned ? "compiler_invariant_violation" : "selector_input_error";
      const oscillation = await this.recordReferenceIssueProgress(selectorIssues);
      if (oscillation) return result(oscillation, selectorIssues, "compiler_invariant_violation", SELECTOR_COMPILATION_CHECKPOINT_RANK, "selector-local");
      const tableOscillation = await this.recordTableExpansionIssueProgress(selectorIssues);
      if (tableOscillation) return result(tableOscillation, selectorIssues, "compiler_invariant_violation", SELECTOR_COMPILATION_CHECKPOINT_RANK, "selector-local");
      return result({
        ok: false,
        terminal: compilerOwned,
        stage: "target-selectors",
        selector_fingerprint: selectorFingerprint,
        error: issueOwner,
        issue_owner: issueOwner,
        selector_issues: selectorIssues,
        instruction: compilerOwned
          ? "Stop this target. The selector compiler did not preserve its own evidence/registry invariant; this is not a semantic correction."
          : "Continue staging typed selector repairs; compiler preflight issues do not consume the semantic correction budget.",
      }, selectorIssues, issueOwner, SELECTOR_COMPILATION_CHECKPOINT_RANK, "selector-local");
    } finally {
      await this.collectCompilerModelReview(compilerReviewIssues);
    }

    beginAssessment("compiled-capacity");
    const compiledContent = serializeCompiledWorkingPlan(compiled);
    const capacityFailure = compiledWorkingPlanCapacityFailure(compiledContent);
    if (capacityFailure) {
      return result(capacityFailure, [{
        code: capacityFailure.error,
        owner: capacityFailure.issue_owner,
        details: capacityFailure,
      }], capacityFailure.issue_owner, 2, "compiler-invariant");
    }
    beginAssessment("compiler-invariants");
    const hydratedCompiled = hydrateSemanticSourcePlan(compiled, this.evidence);
    const rawInvariantIssues = checkTargetCompilerInvariants(
      workingSelectors,
      hydratedCompiled,
      this.evidence,
      compiled,
    );
    if (rawInvariantIssues.length) {
      const invariantIssues = await this.routeSelectorCompilerEvidenceReads(classifyCompilerInvariantIssues(
        workingSelectors,
        sourceSpanRegistry,
        rawInvariantIssues,
      )) as ReturnType<typeof classifyCompilerInvariantIssues>;
      const actionable = await this.actionableEvidenceBindings(invariantIssues);
      const compilerOwned = invariantIssues.some((issue) => issue.owner === "compiler_invariant_violation");
      const issueOwner = compilerOwned ? "compiler_invariant_violation" : "selector_input_error";
      return result({
        ok: false,
        terminal: compilerOwned,
        stage: "compiler-invariant",
        error: compilerOwned ? "compiler_invariant_violation" : "selector_input_error",
        issue_owner: issueOwner,
        selector_fingerprint: selectorFingerprint,
        compiled_plan_sha256: sha256Text(compiledContent),
        issues: invariantIssues,
        instruction: compilerOwned
          ? "Stop this target. This is a harness/compiler defect and must not consume a model correction or final-validator attempt."
          : "Repair the returned typed selector bindings and re-run no-budget preflight; do not edit the compiled plan.",
        ...actionable,
      }, invariantIssues, issueOwner, 2, "compiler-invariant", compiled, compiledContent);
    }

    beginAssessment("strict-validator");
    const strictPreflight = validatePlanText(compiledContent, this.evidence);
    this.structuralIssues(strictPreflight.model_review ?? []);
    if (!strictPreflight.ok) {
      const ownedIssues = await this.routeSelectorCompilerEvidenceReads(classifyStrictSelectorIssues(
        workingSelectors,
        compiled,
        sourceSpanRegistry,
        strictPreflight.issues,
        this.evidence,
        { canRegisterDocumentReferences: canRegisterReferenceLiteral(await this.workspace.readState()) },
      )) as ReturnType<typeof classifyStrictSelectorIssues>;
      const oscillation = await this.recordReferenceIssueProgress(ownedIssues);
      if (oscillation) return result(oscillation, ownedIssues, "compiler_invariant_violation", 3, "strict-validator", compiled, compiledContent);
      const tableOscillation = await this.recordTableExpansionIssueProgress(ownedIssues);
      if (tableOscillation) return result(tableOscillation, ownedIssues, "compiler_invariant_violation", 3, "strict-validator", compiled, compiledContent);
      const decision = decideStrictSelectorPreflight(ownedIssues);
      return result({
        ok: false,
        terminal: !decision.selectorOwned,
        stage: "strict-validator-preflight",
        error: decision.issueOwner,
        issue_owner: decision.issueOwner,
        selector_fingerprint: selectorFingerprint,
        compiled_plan_sha256: sha256Text(compiledContent),
        issues: decision.reportedIssues,
        instruction: decision.selectorOwned
          ? "Repair the exact authored selector paths returned by the faithful projection check; this deterministic preflight does not consume a semantic or final-validator budget."
          : "Stop this target. Strict contract failures after local compilation are not selector repair work and do not consume the final-validator budget.",
      }, decision.reportedIssues, decision.issueOwner, 3, "strict-validator", compiled, compiledContent);
    }

    beginAssessment("source-clauses");
    const sourceClauseIssues = this.structuralIssues(await this.targetSourceClauseIssues(
      workingSelectors,
      compiled,
      selectorFingerprint,
    ));
    if (sourceClauseIssues.length) {
      return result({
        ok: false,
        terminal: false,
        stage: "strict-validator-preflight",
        error: "selector_input_error",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        selector_fingerprint: selectorFingerprint,
        compiled_plan_sha256: sha256Text(compiledContent),
        issues: sourceClauseIssues,
        instruction: "按返回的作者端 span 路径修复，使每个最终 item 能从真实来源唯一推导出父条款。不得直接填写 compiler-derived source_clause；先读取 item 与候选证据，再保存修改。",
      }, sourceClauseIssues, "selector_input_error", 3, "strict-validator", compiled, compiledContent);
    }

    beginAssessment("ledger");
    const ledgerGapIssues = this.structuralIssues(await this.targetLedgerRequiredClauseIssues(compiled, selectorFingerprint));
    if (ledgerGapIssues.length) {
      return result({
        ok: false,
        terminal: false,
        stage: "strict-validator-preflight",
        error: "selector_ledger_required_clause_gap",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        selector_fingerprint: selectorFingerprint,
        compiled_plan_sha256: sha256Text(compiledContent),
        issues: ledgerGapIssues,
        instruction: "底账列出的条文尚未形成合法来源承接，见 issues 的实际行号与原文。先由模型核对其对象和字段作用：真实独立判据补完整 item；共享抽样用实际采用规则；转指用真实引用路由。criterion/requirement 等绑定须忠实，source_clause 由现有位置规则推导。只挂数量不自动覆盖独立判据；也不因候选条文而造无关项目。若与冻结对象边界真实冲突，按当前 frozen_scope_conflict 合同留证报告。保留正确记录，不改编译产物，保存有据决定后重交。",
      }, ledgerGapIssues, "selector_input_error", 3, "strict-validator", compiled, compiledContent);
    }

    beginAssessment("complete");
    return result({
      ok: true,
      stage: "target-selector-preflight",
      selector_fingerprint: selectorFingerprint,
      compiled_plan_sha256: sha256Text(compiledContent),
    }, [], "", 4, "complete", compiled, compiledContent);
  }

  private async recordTableExpansionIssueProgress(issues: unknown[]): Promise<ToolResponse | undefined> {
    const relevantCodes = new Set([
      "selector_table_expansion_obligations_pending",
      "selector_table_distinct_core_properties_merged",
      "selector_acceptance_branches_required",
      "selector_acceptance_branch_condition_coverage",
      "selector_acceptance_branch_condition_duplicate",
    ]);
    const grouped = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const record = issue as { code?: unknown; details?: unknown };
      if (typeof record.code !== "string" || !relevantCodes.has(record.code)) continue;
      const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : {};
      const itemKey = typeof details.item_key === "string" ? details.item_key : `table:${String(details.table_id ?? "unknown")}`;
      grouped.set(itemKey, [...(grouped.get(itemKey) ?? []), record.code]);
    }
    if (!grouped.size) return undefined;
    const updated = await this.workspace.updateState(current => {
      const protocol = selectorProtocolOrDefault(current.selector_protocol);
      const history = [...(protocol.recent_table_expansion_issue_states ?? [])];
      for (const [itemKey, codes] of grouped) {
        const issueCodes = [...new Set(codes)].sort();
        history.push({ item_key: itemKey, issue_codes: issueCodes, issue_fingerprint: sha256Json(issueCodes) });
      }
      protocol.recent_table_expansion_issue_states = history.slice(-12);
      current.selector_protocol = protocol;
    });
    const detected = tableExpansionOscillation(
      selectorProtocolOrDefault(updated.selector_protocol).recent_table_expansion_issue_states ?? [],
    );
    return detected ? {
      ok: false,
      terminal: true,
      error: "table_expansion_representation_oscillation",
      issue_owner: "compiler_invariant_violation",
      budget_consumed: false,
      item_key: detected.item_key,
      oscillating_states: detected.states,
      required_action: "stop_target_and_preserve_table_expansion_diagnostics",
      instruction: "同一表格 item 在 branches 全加/全删等价状态间形成 A-B-A 往返。当前目标已终止，保留检查点和 table_expansion_work_packages，不再读取、修改或重交。后续排障应核查不同 core property 是否被合并，以及同一属性的互斥 branches 是否完整；这不是当前会话的继续修复指令。",
    } : undefined;
  }

  private async recordReferenceIssueProgress(issues: unknown[]): Promise<ToolResponse | undefined> {
    const relevantCodes = new Set([
      "selector_reference_origin_field_mismatch",
      "selector_reference_origin_field_ambiguous",
      "selector_reference_origin_binding_missing",
      "selector_reference_occurrence_origin_conflict",
      "reference_destination_field_mismatch",
      "reference_origin_binding_mismatch",
    ]);
    const grouped = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const record = issue as { code?: unknown; details?: unknown };
      if (typeof record.code !== "string" || !relevantCodes.has(record.code)) continue;
      const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : {};
      const occurrenceId = typeof details.occurrence_id === "string" ? details.occurrence_id : "";
      if (!occurrenceId) continue;
      grouped.set(occurrenceId, [...(grouped.get(occurrenceId) ?? []), record.code]);
    }
    if (!grouped.size) return undefined;
    const updated = await this.workspace.updateState((current) => {
      const protocol = selectorProtocolOrDefault(current.selector_protocol);
      const history = [...(protocol.recent_reference_issue_states ?? [])];
      for (const [occurrenceId, codes] of grouped) {
        const issueCodes = [...new Set(codes)].sort();
        history.push({ occurrence_id: occurrenceId, issue_codes: issueCodes, issue_fingerprint: sha256Json(issueCodes) });
      }
      protocol.recent_reference_issue_states = history.slice(-12);
      current.selector_protocol = protocol;
    });
    const detected = referenceBindingOscillation(
      selectorProtocolOrDefault(updated.selector_protocol).recent_reference_issue_states ?? [],
    );
    if (!detected) return undefined;
    return {
      ok: false,
      terminal: true,
      error: "reference_origin_destination_oscillation",
      issue_owner: "compiler_invariant_violation",
      budget_consumed: false,
      occurrence_id: detected.occurrence_id,
      oscillating_states: detected.states,
      required_action: "stop_target_and_preserve_reference_occurrence_diagnostics",
      instruction: "同一 occurrence 在 origin 与 destination 错误之间形成 A-B-A 往返。当前目标已终止，保留检查点和 occurrence 回条，不再读取、修改或重交。后续排障应核对相邻原文、ordered literal spans、normalized_reference 和 origin_field；immutable occurrence 没有可写路径时应修 Harness，不在当前会话继续尝试 selector 修复。",
    };
  }

  private async actionableEvidenceBindings(issues: unknown[]): Promise<Record<string, unknown>> {
    const evidenceIds = new Set<string>();
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const details = (issue as { details?: unknown }).details;
      if (!details || typeof details !== "object" || Array.isArray(details)) continue;
      const evidenceId = (details as { evidence_id?: unknown }).evidence_id;
      if (typeof evidenceId === "string") evidenceIds.add(evidenceId);
      const listed = (details as { evidence_ids?: unknown }).evidence_ids;
      if (Array.isArray(listed)) {
        for (const entry of listed) if (typeof entry === "string") evidenceIds.add(entry);
      }
    }
    if (evidenceIds.size === 0) return {};
    const registry = await this.workspace.readSourceSpanRegistry();
    const recordById = new Map(this.evidence.evidence.map((record) => [record.evidence_id, record]));
    const allowedBindings = [...evidenceIds].sort().flatMap((evidenceId) => {
      const record = recordById.get(evidenceId);
      if (!record) return [];
      const span = registry.spans.find((candidate) => (
        candidate.evidence_id === evidenceId
        && candidate.start === 0
        && candidate.end === record.text.length
      ));
      return span ? [{ evidence_id: evidenceId, span_id: span.span_id }] : [];
    });
    return {
      allowed_bindings: allowedBindings,
      required_action: "bind_semantically_or_stage_source_disposition",
      instruction: "仅使用返回的、由登记表支持的完整 span 绑定：绑定到真实语义选择器，或明确登记为 context/ignored。不得编造 span ID 或修改编译结果。",
    };
  }

  private preflightResponseFields(preflight: TargetSelectorPreflight): Record<string, unknown> {
    const response = preflight.response;
    const toolPage = selectorIssueToolPage(preflight.issues);
    return {
      preflight_ok: preflight.ok,
      preflight_stage: preflight.stage_name,
      preflight_issue_owner: preflight.issue_owner,
      preflight_issue_count: preflight.issue_count,
      preflight_issue_fingerprint: preflight.issue_fingerprint,
      preflight_issues: toolPage.summaries,
      preflight_issue_page: toolPage.page,
      budget_consumed: false,
      ...(Array.isArray(response.allowed_bindings)
        ? { allowed_bindings: response.allowed_bindings }
        : {}),
      ...(typeof response.required_action === "string"
        ? { required_action: response.required_action }
        : {}),
      ...(typeof response.instruction === "string"
        ? { preflight_instruction: response.instruction }
        : {}),
    };
  }

  private async persistBestSelectorDraft(
    content: string,
    draftFingerprint: string,
    historySequence: number,
    stageRank: number,
    issueCount: number,
    issueFingerprint: string,
  ): Promise<NonNullable<RevisionState["selector_protocol"]>> {
    await this.workspace.writeBestSelectors(content);
    const state = await this.workspace.updateState((current) => {
      const protocol = selectorProtocolOrDefault(current.selector_protocol);
      protocol.best_draft_fingerprint = draftFingerprint;
      protocol.best_history_sequence = historySequence;
      protocol.best_preflight_stage_rank = stageRank;
      protocol.best_issue_count = issueCount;
      protocol.best_issue_fingerprint = issueFingerprint;
      protocol.consecutive_non_improvements = 0;
      current.selector_protocol = protocol;
    });
    return selectorProtocolOrDefault(state.selector_protocol);
  }



  private async stageTargetSelectorDraft(
    patch: TargetSelectorDraftPatch,
  ): Promise<ToolResponse> {
    const persistedState = await this.workspace.readState();
    const quietRepairDraft = this.selectorStage === "coverage_repair";
    if (repairStateOrDefault(persistedState.repair).mode === "validated") {
      return {
        ok: false,
        terminal: false,
        error: "validated_selectors_require_seal",
        budget_consumed: false,
        draft_fingerprint: persistedState.last_valid_fingerprint,
        instruction: "当前选择器提交已通过验证，请封存该精确验证指纹。",
      };
    }
    let registry = await this.workspace.readSourceSpanRegistry();
    const originalRegistryFingerprint = sourceSpanRegistryFingerprint(registry);
    const resolvedBindings: Record<string, string> = {};
    const placementError = selectorDraftPlacementError(patch);
    if (placementError) return placementError;
    const shapeError = selectorShapeError(patch, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    if (shapeError) return shapeError;
    const selectionRequest = patch.reference_selections !== undefined;
    let selectionProjection: ReferenceFieldSelectionResult | undefined;
    const selectionFailure = (error: string, actual: unknown, writablePath: string, instruction: string): ToolResponse => ({
      ok: false, terminal: false, durable_mutation: false, budget_consumed: false,
      issue_owner: "selector_input_error", error, actual, writable_path: writablePath,
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" }, instruction,
    });
    if (selectionRequest && (patch.draft !== undefined || patch.remove_keys !== undefined || patch.collection !== undefined || patch.operation === "replace_collection")) {
      return selectionFailure("reference_selection_mixed_write", { submitted_keys: Object.keys(patch) }, "/reference_selections",
        "本次未保存。引用字段事务使用 reference_selections、draft_fingerprint 和可选 quote_bindings 独立调用；先用普通 draft 保存新项目，随后对已有项目作引用字段选择。不能同时完整覆盖或删除同一事务的派生记录。保留真实业务选择及其他正确字段，不以清空集合消错。");
    }
    if (selectionRequest || patch.draft_fingerprint !== undefined) {
      const current = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
      const fingerprint = targetSelectorFingerprint(current);
      if (patch.draft_fingerprint !== fingerprint) return {
        ...selectionFailure("selector_draft_fingerprint_mismatch", { supplied: patch.draft_fingerprint ?? null, current: fingerprint }, "/draft_fingerprint",
          "本次未保存草稿或来源登记。先读取当前 items/references，核对稳定 key 和当前字段后，携带当前 draft_fingerprint 重新提交原选择；不得用旧选择覆盖其他更新。"),
        expected: { draft_fingerprint: fingerprint }, draft_fingerprint: fingerprint,
      };
    }
    const roleIssues = (patch.draft?.sampling_rules ?? []).flatMap((rule, ruleIndex) => [
      { path: `/draft/sampling_rules/${ruleIndex}/components`, components: rule.components },
      ...rule.branches.map((branch, branchIndex) => ({ path: `/draft/sampling_rules/${ruleIndex}/branches/${branchIndex}/components`, components: branch.components })),
    ].flatMap(scope => scope.components.flatMap((component, componentIndex) =>
      SAMPLING_COMPONENT_ROLES.includes(component.role) ? [] : [{
        code: "selector_sampling_component_role_invalid", actual: component.role,
        writable_path: `${scope.path}/${componentIndex}/role`, allowed_values: [...SAMPLING_COMPONENT_ROLES],
        next_tool: "stage_target_selector_draft",
        how_to_pass: "role 说明组件是什么，disposition 说明原文是否存在；数量未规定时用 role=quantity、disposition=absent、span_ids=[]。其他角色按原文选择，不改变正确的组件和原文。",
      }])));
    if (roleIssues.length) return {
      ok: false, error: "selector_sampling_component_role_invalid", terminal: false,
      durable_mutation: false, budget_consumed: false, selector_issues: roleIssues,
      next_tool: "stage_target_selector_draft", do_not_edit: "编译产物、来源登记及其他正确字段；本次未保存",
      instruction: "本次未保存。按 allowed_values 修正报错 role；absent/not_applicable 是 disposition，不是 role。保留原操作、删除意图、其他组件及完整记录后重试 stage_target_selector_draft。",
    };
    const bindingIssues: Array<Record<string, unknown>> = [];
    const reservedAliases = (patch.quote_bindings ?? []).flatMap((binding, index) =>
      /^\$[seart][0-9]+$/i.test(binding.key) ? [{ binding, index }] : []);
    if (reservedAliases.length) return {
      ok: false, error: "quote_binding_reserved_source_handle_alias",
      budget_consumed: false, durable_mutation: false,
      selector_issues: reservedAliases.map(({ binding, index }) => ({
        path: `/quote_bindings/${index}/key`, actual: binding.key,
        how_to_pass: "使用 $seal_requirement 这类描述性别名；$s<number>、$e<number>、$a<number>、$r<number>、$t<number> 及大写形式为保留句柄。同时重命名此 key 和 draft span 字段中精确对应的 $alias；不得删除 $ 或改动已有系统句柄。",
        writable_path: `/quote_bindings/${index}/key`,
        next_tool: "stage_target_selector_draft",
      })),
      instruction: "本次未保存草稿或来源登记。只重命名被拒绝的 quote 别名及其对应 draft span 引用，保留其他字段、原始 quote、证据 ID 和系统句柄后重试 stage_target_selector_draft。不得修改编译工件或来源句柄映射。",
    };
    for (const [index, binding] of (patch.quote_bindings ?? []).entries()) {
      const path = `/quote_bindings/${index}`;
      if (Object.hasOwn(resolvedBindings, binding.key)) {
        bindingIssues.push({ path, error: "quote_binding_key_duplicate", key: binding.key });
        continue;
      }
      const evidence = this.evidence.evidence.find(record => record.evidence_id === binding.evidence_id);
      if (!evidence) {
        bindingIssues.push({ path, error: "unknown_evidence_id", evidence_id: binding.evidence_id });
        continue;
      }
      const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, binding.evidence_id, "target");
      if (isolated && !this.openedEvidenceIds.has(binding.evidence_id)) {
        bindingIssues.push({ path, error: "isolated_reference_body_access_forbidden", ...this.isolatedReferenceBodyAccessFeedback(isolated.target_key) });
        continue;
      }
      if (!(await this.evidenceQuoteWasOpened(evidence, binding.quote))) {
        bindingIssues.push({ path, error: "span_evidence_not_opened", evidence_id: binding.evidence_id });
        continue;
      }
      try {
        const located = locateAndRegisterSourceQuote(registry, {
          source_id: binding.evidence_id, evidence_id: binding.evidence_id,
          atom_id: binding.evidence_id, text: evidence.text,
        }, binding.quote, { prefix: binding.prefix ?? "", suffix: binding.suffix ?? "" });
        registry = located.registry;
        resolvedBindings[binding.key] = located.spans[0]!.span_id;
      } catch (error) {
        if (!(error instanceof SourceSpanRegistryError)) throw error;
        bindingIssues.push({ path, key: binding.key, ...(isolated ? { target_key: isolated.target_key } : {}),
          issues: this.targetQuoteIssues(error, path, "stage_target_selector_draft", isolated ? "read_reference_facts" : "open_evidence") });
      }
    }
    // Only source-handle fields are substituted. User-authored prose/keys stay verbatim.
    const bind = (value: unknown, path = "/draft", sourceField = false): unknown => {
      if (typeof value === "string" && sourceField && value.startsWith("$")) {
        if (!resolvedBindings[value]) {
          const definitionIndex = (patch.quote_bindings ?? []).findIndex(binding => binding.key === value);
          const definitionPath = definitionIndex < 0 ? "/quote_bindings" : `/quote_bindings/${definitionIndex}`;
          bindingIssues.push({
            path, error: "quote_binding_unknown", key: value,
            actual: { alias: value, binding_status: definitionIndex < 0 ? "missing" : "unresolved", definition_path: definitionPath },
            writable_paths: [definitionPath, path], next_tool: "stage_target_selector_draft",
            how_to_pass: definitionIndex < 0
              ? "本次 quote_bindings 未定义此别名。在当前请求的 quote_bindings 添加同 key 的已读 evidence_id 和逐字 quote，或把此 span 字段改为已登记的来源句柄；保留完整草稿与原操作后重试。先前调用的 $别名不能跨调用复用。"
              : "本次已有此别名定义，但来源定位未通过。按该 quote_bindings 位置的定位回条修复 evidence_id/quote/prefix/suffix，再携带本次使用的全部别名定义及完整草稿重试；不要仅重发 draft 或把失败定位当成已保存来源。",
          });
        }
        return resolvedBindings[value] ?? value;
      }
      if (Array.isArray(value)) return value.map((entry, index) => bind(entry, `${path}/${index}`, sourceField));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        bind(child, `${path}/${key}`, /(?:^|_)span_ids?$/.test(key))]));
    };
    patch = { ...patch, ...(patch.draft ? { draft: bind(patch.draft) as TargetSelectorDraft } : {}),
      ...(patch.reference_selections ? { reference_selections: bind(patch.reference_selections, "/reference_selections") as NonNullable<TargetSelectorDraftPatch["reference_selections"]> } : {}) };
    if (bindingIssues.length) return {
      ok: false, error: "selector_draft_quote_bindings_invalid", selector_issues: bindingIssues,
      budget_consumed: false, durable_mutation: false,
      quote_binding_scope: "current_request",
      quote_binding_summary: { defined_keys: (patch.quote_bindings ?? []).map(binding => binding.key), resolved_keys: Object.keys(resolvedBindings) },
      next_tool: "stage_target_selector_draft",
      instruction: "本次草稿及来源登记均未保存，成功定位的临时绑定也未保存。$key 只在当前请求生效：missing 要在本次 quote_bindings 补定义或改用已登记来源句柄；unresolved 要先修复同次定义的定位错误。按可写路径和读取工具核对逐字 quote，存在但被 prefix/suffix 排除时修正可选前后文。携带本次使用的全部别名定义、完整草稿和原增删意图重试；不得改写原文或编译产物。",
    };
    if (patch.reference_selections) {
      const current = migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))).plan;
      selectionProjection = projectReferenceFieldSelections(current, this.evidence, registry, patch.reference_selections);
      if (selectionProjection.issues.length) {
        const missingLiteral = selectionProjection.issues.some(issue => issue.code === "reference_field_selection_literal_required");
        const registrationState = missingLiteral ? await this.workspace.readState() : undefined;
        if (registrationState && !canRegisterReferenceLiteral(registrationState)) return {
          ok: false, terminal: true, durable_mutation: false, budget_consumed: false,
          error: "reference_registration_checkpoint_frozen", issue_owner: "compiler_invariant_violation",
          actual: { status: registrationState.status, validation_attempts: registrationState.validation_attempts,
            has_validated_plan: Boolean(registrationState.last_valid_fingerprint || registrationState.last_valid_plan_sha256),
            has_coverage_review: Boolean(registrationState.repair?.coverage_review_fingerprint) },
          expected: "引用 literal 须在未冻结的可写检查点经正常工具登记；当前不能原地恢复", writable_paths: [],
          selector_issues: selectionProjection.issues.map(issue => {
            if (issue.code !== "reference_field_selection_literal_required") return issue;
            const details = issue.details as Record<string, unknown> | undefined;
            return { ...issue, details: { actual: details?.actual, expected: details?.expected,
              transaction_applied: false, writable_paths: [], required_action: "maintainer_writable_revision_required" } };
          }),
          instruction: "本检查点的引用登记已冻结，缺少的 occurrence literal 不能原地补登记。本次草稿和临时来源均未保存；保留检查点、历史计数和预算，交由维护者处理可写修订版。不要反复调用 resolve、手改 occurrence 或改接收字段绕过。",
        };
        const firstDetails = selectionProjection.issues[0]!.details as Record<string, unknown> | undefined;
        const writablePaths = [...new Set(selectionProjection.issues.flatMap(issue => {
          const details = issue.details as Record<string, unknown>;
          return Array.isArray(details.writable_paths) ? details.writable_paths as string[] : [String(details.writable_path)];
        }))];
        return {
          ...selectionFailure("reference_selection_invalid", { issue_count: selectionProjection.issues.length }, "/reference_selections",
            "本次引用选择及临时来源均未保存。按每条问题的 write_mode、writable_paths 和读取参数修复。write_mode=full_records 时按 record_reads 读取已有记录，用 operation=upsert 和 draft.items/draft.references 保存实际修改的完整记录，不再用 reference_selections 重试该问题；其他输入问题按其指定参数修正。业务判断由模型依据原文决定，不扩大来源或删除未修改内容。"),
          current_draft_fingerprint: targetSelectorFingerprint(current),
          writable_path: undefined, writable_paths: writablePaths,
          ...(typeof firstDetails?.next_tool === "string" ? { next_tool: firstDetails.next_tool,
            next_tool_arguments: firstDetails.next_tool_arguments } : {}),
          selector_issues: selectionProjection.issues,
        };
      }
      patch = { ...patch, draft: selectionProjection.draft };
    }
    const operation = patch.operation === "replace_collection" ? "replace_collection" : "upsert";
    const draft = patch.draft;
    const removeKeys = patch.remove_keys;
    const removalCollection = typeof patch.collection === "string" ? patch.collection : "";
    if ((!draft || typeof draft !== "object" || Array.isArray(draft)) && removeKeys === undefined) {
      const budget = await this.recordSelectorProtocolFailure("selector_draft_must_be_object");
      return {
        ok: false, error_class: "protocol", error: "selector_draft_must_be_object",
        actual: { received_keys: Object.keys(patch), draft_type: Array.isArray(draft) ? "array" : typeof draft },
        writable_path: "draft", next_tool: budget.exhausted ? null : "stage_target_selector_draft", schema_tool: "get_target_selector_contract",
        instruction: budget.exhausted
          ? "The protocol error budget is exhausted and this revision will stop. No draft was saved. Inspect the saved checkpoint and the received_keys: this request omitted the draft object. Do not retry tools in this terminated revision."
          : "No selector draft was saved. Supply draft as an object containing a nonempty typed collection, e.g. put item records under draft.items. collection and quote_bindings alone do not submit records. Read get_target_selector_contract for record fields, then retry stage_target_selector_draft with the complete patch. Do not edit compiled output or immutable source files.",
        terminal: budget.exhausted, protocol_failure: budget,
      };
    }
    const collections = draft && typeof draft === "object" && !Array.isArray(draft)
      ? Object.keys(draft).filter((key) => (draft as Record<string, unknown>)[key] !== undefined)
      : [];
    const allowed = [...SELECTOR_DRAFT_COLLECTIONS];
    const patchCollections = new Set(collections);
    if (removeKeys !== undefined) patchCollections.add(removalCollection);
    if (patchCollections.size === 0 || [...patchCollections].some(key => !allowed.some((allowedKey) => allowedKey === key))
      || (removeKeys !== undefined && collections.some(key => key !== removalCollection))) {
      const budget = await this.recordSelectorProtocolFailure("selector_draft_collection_patch_invalid");
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_collection_patch_invalid",
        allowed_collections: allowed,
        draft_collections: collections,
        removal_collection: removalCollection || null,
        terminal: budget.exhausted,
        protocol_failure: budget,
        instruction: "Stage one or more collections from allowed_collections in draft. When using remove_keys, restrict this patch to its explicit collection. Compiler-derived fields such as reference_resolutions are not writable; use draft.references instead.",
      };
    }
    const collection = [...patchCollections][0]! as SelectorDraftCollection;
    const repairBefore = repairStateOrDefault(persistedState.repair);
    if (
      quietRepairDraft
      && repairBefore.repair_source === "coverage"
      && operation === "replace_collection"
    ) {
      return {
        ok: false,
        error: "coverage_repair_replace_collection_forbidden",
        issue_owner: "selector_input_error",
        budget_consumed: false,
        collection,
        affected_item_ids: repairBefore.coverage_item_ids ?? [],
        next_tool: "read_target_selectors", writable_path: "/remove_keys",
        instruction: "修复模式继承 durable selector checkpoint，不能整集合替换。先 read_target_selectors 读取当前记录，再用 upsert/remove_keys 只修改明确受影响的记录；source_dispositions 使用目录返回的读取键删除，不向草稿添加 key。保留其他正确记录，本次未保存。",
      };
    }
    const allCollections = [...patchCollections] as SelectorDraftCollection[];
    const entries = allCollections.flatMap<unknown>(key => draft?.[key] ?? []);
    if (!Array.isArray(entries) || (entries.length === 0 && removeKeys === undefined && operation !== "replace_collection")) {
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_batch_empty",
        min_records: 1,
        terminal: false,
        budget_consumed: false,
        actual: { operation, collections: allCollections, record_count: entries.length },
        writable_path: "/draft", next_tool: "stage_target_selector_draft",
        do_not_edit: "本次未保存；保留其他集合和编译产物",
        instruction: "空 upsert 不会清空集合。新增或替换请提交完整记录；按 key 删除用 remove_keys。明确清空一个集合时使用 replace_collection 并只提交该集合的 []，不能附带清空其他正确集合。",
      };
    }
    if (removeKeys !== undefined && (!Array.isArray(removeKeys) || removeKeys.length === 0)) {
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_remove_keys_empty",
        min_remove_keys: 1,
        terminal: false,
        budget_consumed: false,
        instruction: "Omit remove_keys when nothing is removed; otherwise provide at least one explicit key.",
      };
    }
    if (removeKeys !== undefined && operation !== "upsert") {
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_remove_requires_upsert",
        budget_consumed: false,
        instruction: "Use operation=upsert for an atomic remove-only or remove-plus-upsert patch; replace_collection already defines the entire replacement collection.",
      };
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify({ operation, draft, collection, remove_keys: removeKeys, quote_bindings: patch.quote_bindings,
      reference_selections: patch.reference_selections, draft_fingerprint: patch.draft_fingerprint }), "utf8");
    if (serializedBytes > MAX_PATCH_SERIALIZED_BYTES) {
      const requestedRecordCount = entries.length + (Array.isArray(removeKeys) ? removeKeys.length : 0);
      const bytesPerRecord = serializedBytes / Math.max(1, requestedRecordCount);
      const recommendedRecordCount = Math.max(
        1,
        Math.floor((MAX_PATCH_SERIALIZED_BYTES * 0.9) / Math.max(1, bytesPerRecord)),
      );
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_size_limit",
        requested_record_count: requestedRecordCount,
        serialized_bytes: serializedBytes,
        max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES,
        recommended_record_count: recommendedRecordCount,
        instruction: `Stage about ${recommendedRecordCount} records per call for records of this measured size. The byte limit is dynamic and this rejected call did not mutate the durable working selector.`,
        terminal: false,
        budget_consumed: false,
      };
    }
    const spanIssues = selectorDraftSpanIssues(draft, new Set(registry.spans.map((span) => span.span_id)), "/draft");
    if (spanIssues.length) {
      return {
        ok: false,
        issue_owner: "selector_input_error",
        error: "selector_draft_span_validation",
        instruction: "Read selector_issues. Each fragment must be an exact substring of an opened evidence span_id. Copy the quote from open_evidence; do not normalize or retype it.",
        selector_issues: spanIssues,
        budget_consumed: false,
      };
    }
    const currentMigration = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ));
    const current = currentMigration.plan;
    const previousSelectors = structuredClone(current);
    if (patch.draft_fingerprint !== undefined && patch.draft_fingerprint !== targetSelectorFingerprint(current)) {
      return { ...selectionFailure("selector_draft_fingerprint_mismatch", { supplied: patch.draft_fingerprint, current: targetSelectorFingerprint(current) }, "/draft_fingerprint",
        "本次处理期间草稿已变，所有选择和临时来源均未保存。读取当前记录并核对业务选择后，用当前指纹重试；不覆盖并发更新。"),
        expected: { draft_fingerprint: targetSelectorFingerprint(current) }, draft_fingerprint: targetSelectorFingerprint(current) };
    }
    const previousItems = allCollections.includes("items") ? structuredClone(current.items) : [];
    const lostReferenceIdentities = (draft?.references ?? []).flatMap((reference, index) => {
      const existing = current.references.find(row => row.key === reference.key);
      if (reference.occurrence_id?.trim() || !existing?.occurrence_id
        || !this.evidence.reference_occurrences.some(row => row.occurrence_id === existing.occurrence_id)) return [];
      return [{ code: "selector_existing_reference_occurrence_id_required", path: `/draft/references/${index}/occurrence_id`,
        actual: { reference_key: reference.key, submitted_occurrence_id: reference.occurrence_id ?? null,
          saved_occurrence_id: existing.occurrence_id },
        writable_path: `/draft/references/${index}/occurrence_id`,
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
        how_to_pass: "当前 keyed reference 已绑定不可变 occurrence。完整 upsert 不能省略 occurrence_id；按 next_tool_arguments 读取现有完整记录。同一引用时复制 saved_occurrence_id 并保留其他正确字段，修好完整补丁后重新暂存；确实改为另处引用时须先核对或解析真实 occurrence，再显式提交对应 ID 和来源。不得用空 ID、改 key 或删除记录绕过回执检查。",
      }];
    });
    if (lostReferenceIdentities.length) return {
      ok: false, error: "selector_existing_reference_occurrence_id_required", terminal: false,
      durable_mutation: false, budget_consumed: false, selector_issues: lostReferenceIdentities,
      next_tool: lostReferenceIdentities[0]!.next_tool, next_tool_arguments: lostReferenceIdentities[0]!.next_tool_arguments,
      instruction: "本次完整补丁未保存，来源登记和预算未变。已有 reference 的 occurrence_id 被省略；按 selector_issues 读取准确作者记录并补齐明确的引用身份，保留本次其他有效修改后重试原补丁。",
    };

    const recordKey = (record: unknown): string => {
      if (record && typeof record === "object" && !Array.isArray(record) && typeof (record as { key?: unknown }).key === "string") {
        return `key:${(record as { key: string }).key}`;
      }
      const spans = record && typeof record === "object" && !Array.isArray(record)
        ? (record as { span_ids?: unknown }).span_ids
        : undefined;
      return `spans:${sha256Json(Array.isArray(spans) ? spans : record)}`;
    };
    for (const collection of allCollections) {
      const keyedRecordKey = (record: unknown) => selectorRecordReadKey(collection, record);
      const entries = draft?.[collection] ?? [];
      const existing = current[collection] as unknown[];
      if (removeKeys !== undefined) {
        const duplicateKeys = [...new Set(removeKeys.filter((key, index) => removeKeys.indexOf(key) !== index))].sort();
        if (duplicateKeys.length > 0) {
          return {
            ok: false,
            error_class: "protocol",
            error: "selector_draft_remove_keys_duplicate",
            duplicate_keys: duplicateKeys,
            budget_consumed: false,
            instruction: "Remove each existing selector key at most once, then retry the same atomic patch.",
          };
        }
        const existingKeys = existing.map(keyedRecordKey).filter(Boolean).sort();
        const unknownKeys = removeKeys.filter((key) => !existingKeys.includes(key)).sort();
        if (unknownKeys.length > 0) {
          return {
            ok: false,
            error_class: "protocol",
            error: "selector_draft_remove_key_unknown",
            unknown_keys: unknownKeys,
            allowed_existing_keys: existingKeys,
            budget_consumed: false,
            terminal: false, durable_mutation: false,
            actual: { collection, remove_keys: removeKeys, record_count: existing.length }, writable_path: "/remove_keys",
            expected: { remove_key_registered_in_current_collection: true },
            next_tool: "read_target_selectors", next_tool_arguments: { collection, cursor: 0 },
            retry_tool: "stage_target_selector_draft", do_not_edit: "本次完整补丁均未保存；保留原操作、collection、其他删除意图和未冲突的 upsert；不得修改正确记录或编译产物",
            instruction: "删除键不存在或已过期。先 read_target_selectors 分页读取当前集合，按真实返回的 key 读取完整记录后，仅删除确定需要移除的记录。source_dispositions 的读取键随内容变化而失效；不得伪造键、重放已成功的删除，或为绕过错误清空其他记录。",
          };
        }
        const upsertKeys = entries.map(keyedRecordKey).filter(Boolean);
        const conflictingKeys = removeKeys.filter((key) => upsertKeys.includes(key)).sort();
        if (conflictingKeys.length > 0) {
          const conflicts = conflictingKeys.map(key => ({
            key, saved_record_count: existing.filter(row => keyedRecordKey(row) === key).length,
            remove_paths: removeKeys.flatMap((candidate, index) => candidate === key ? [`/remove_keys/${index}`] : []),
            upsert_paths: entries.flatMap((entry, index) => keyedRecordKey(entry) === key ? [`/draft/${collection}/${index}`] : []),
          }));
          return {
            ok: false,
            error_class: "protocol",
            error: "selector_draft_upsert_remove_conflict",
            conflicting_keys: conflictingKeys,
            budget_consumed: false,
            terminal: false, durable_mutation: false,
            actual: { collection, conflicts }, expected: { actions_per_conflicting_key: 1, remove_keys_min_items_if_present: 1 },
            writable_paths: [...conflicts.flatMap(conflict => [...conflict.remove_paths, ...conflict.upsert_paths]), "/remove_keys"],
            next_tool: "read_target_selectors",
            next_tool_arguments: conflicts[0]!.saved_record_count === 1
              ? { collection, key: conflicts[0]!.key } : { collection, cursor: 0 },
            retry_tool: "stage_target_selector_draft",
            instruction: "本次完整原子补丁未保存，同一 key 同时出现在删除和 upsert 中。按 next_tool_arguments 核对现存完整作者记录，再为每个 conflicts.key 自行确认一个动作：保留删除时移除对应 draft 记录；保留 upsert 时移除对应 remove_keys 元素。remove_keys 如提供必须至少一项，移除最后一项后省略该可选字段，不能提交空数组；仅删除且没有待提交记录时可省略 draft，保留 collection 和实际删除键。按返回的精确路径修正后完整重试原工具，保留原操作、其余删除意图和未冲突的 upsert；不得清空集合或猜测来源来绕过冲突。",
          };
        }
      }
      const staged = operation === "replace_collection" ? [] : [...existing];
      if (removeKeys !== undefined) {
        const removeSet = new Set(removeKeys);
        for (let index = staged.length - 1; index >= 0; index -= 1) {
          if (removeSet.has(keyedRecordKey(staged[index]))) staged.splice(index, 1);
        }
      }
      for (const entry of entries) {
        const key = recordKey(entry);
        const index = staged.findIndex((candidate) => recordKey(candidate) === key);
        if (index >= 0) staged[index] = entry;
        else staged.push(entry);
      }
      (current as unknown as Record<string, unknown>)[collection] = staged;
    }
    const stagedMigrationIssues = migrateTargetSelectorPlanForAuthoring(current).issues;
    const content = prettyJson(current);
    const before = await readFile(this.workspace.workingSelectorPath, "utf8");
    const unchanged = sha256Text(before) === sha256Text(content);
    let written: ToolResponse = { ok: true, unchanged: true };
    if (sourceSpanRegistryFingerprint(registry) !== originalRegistryFingerprint) {
      await atomicWriteJson(this.workspace.sourceSpanRegistryPath, registry);
    }
    if (!unchanged) {
      written = await this.writeSelectorsWithHistory(content, `stage-target-selector-${allCollections.join("+")}`);
    }
    const touchedRoots = allCollections.flatMap((touchedCollection) => {
      if (operation === "replace_collection") return [`/${touchedCollection}`];
      const stagedRecords = current[touchedCollection] as unknown[];
      const recordRoots = (draft?.[touchedCollection] ?? []).flatMap((entry) => {
        const index = stagedRecords.findIndex((candidate) => recordKey(candidate) === recordKey(entry));
        return index >= 0 ? [`/${touchedCollection}/${index}`] : [];
      });
      return removeKeys !== undefined
        ? [...recordRoots, `/${touchedCollection}`]
        : recordRoots;
    });
    const localValidation = await this.validateStagedSelectorRecords(current, touchedRoots, previousSelectors);
    const localValidationPassed = localValidation.ok === true;
    let referenceLocatorSourceRepair: Record<string, unknown> | undefined;
    if (["table", "commit"].includes(this.selectorStage)) {
      const accessByEvidenceId = await this.evidenceAccessIndex(false);
      const accessibleEvidenceIds = this.eligibleTableEvidenceIds(accessByEvidenceId);
      const fieldOnlyIds = requiredReferenceFieldOnlyEvidenceIds(current, this.evidence, registry);
      const evidenceIds = [...new Set([
        ...requiredReferenceAnchorOnlyEvidenceIds(current, this.evidence, registry), ...fieldOnlyIds,
      ])].filter(id => accessibleEvidenceIds.has(id));
      if (evidenceIds.length) {
        const sourceIssues = await this.routeSelectorCompilerEvidenceReads(classifyCompilerInvariantIssues(
          current, registry, evidenceIds.map(id => ({ code: "compiler_unhandled_evidence",
            path: "/evidence_dispositions", message: "Compiler must materialize every required source disposition",
            details: { evidence_ids: [id] } })),
        ));
        const page = selectorIssueToolPage(sourceIssues.map(issue => actionableSelectorIssue(issue, current)), 1);
        referenceLocatorSourceRepair = {
          validation_scope: evidenceIds.some(id => fieldOnlyIds.includes(id))
            ? "required_reference_field_and_locator_sources" : "required_reference_locator_sources", full_stage_check_performed: false, budget_consumed: false,
          actual: { evidence_count: evidenceIds.length }, selector_issues: page.issues, issue_page: page.page,
          ...selectorRepairRoute(page.issues),
          instruction: "这些必处置来源仅保存在引用定位或尚未兑现来源归属的 reference 字段。局部记录通过不代表来源已修复；只改 anchor、origin_binding、重复显示 span 或 reason 不能补来源归属。按诊断中的 actual.author_field_bindings 和 saved_field_binding_instruction 核对真实已保存字段及当前作者记录，再由作者依据原文保存真实来源绑定或有依据的显式处置；不能降为背景来消错。此有限检查不表示其他来源或完整候选通过。",
        };
      }
    }
    const touchedItemKeys = new Set(current.items.filter((_item, index) =>
      touchedRoots.some(root => root === "/items" || root === `/items/${index}`)).map(item => item.key));
    const touchedSamplingRuleKeys = new Set(current.sampling_rules.filter((_rule, index) =>
      touchedRoots.some(root => root === "/sampling_rules" || root === `/sampling_rules/${index}`)).map(rule => rule.key));
    const deliveryComparisons = selectorDeliveryInvestigationHints(current, registry, this.evidence.evidence, touchedItemKeys, previousItems);
    const deliverySourceReads = new Map(await Promise.all(unique(deliveryComparisons.slice(0, 24).flatMap(hint => hint.evidence_ids))
      .map(async evidenceId => {
        const isolated = await isolatedReferenceTargetForEvidence(this.workspace, this.evidence, evidenceId, "target");
        return [evidenceId, isolated
          ? { name: "read_reference_facts", arguments: { target_key: isolated.target_key } }
          : { name: "open_evidence", arguments: { evidence_id: evidenceId, cursor: 0 } }] as const;
      })));
    const deliveryHints = deliveryComparisons.map(hint => ({ ...hint,
      source_read_tools: hint.evidence_ids.flatMap(evidenceId => deliverySourceReads.get(evidenceId) ?? []),
    }));
    const savedRecords = savedTouchedSelectorRecords(
      allCollections,
      operation === "replace_collection" ? "replace_collection" : "upsert",
      current,
      draft,
      removeKeys,
      recordKey,
    );
    const savedRecordsBytes = Buffer.byteLength(JSON.stringify(savedRecords.records), "utf8");
    const savedRecordsEcho = savedRecordsBytes <= SAVED_RECORDS_MAX_BYTES
      ? { saved_records: savedRecords.records }
      : { saved_record_keys: savedRecords.keys };
    const execution = await this.selectorExecutionStep();
    const { work: nextWork, state: executionState, ...nextStep } = execution;
    const advisory = nextWork && "advisory_only" in nextWork && nextWork.advisory_only;
    const repairWork = advisory ? undefined : nextWork;
    const authoringWork = advisory ? nextWork : undefined;
    return {
      ...written,
      ok: true,
      ...(selectionProjection ? {
        reference_selection_projection: { changed_paths: selectionProjection.changed_paths, derived_relations: selectionProjection.derived_relations },
        mutation_receipt: selectorPatchReceipt({ operation, draft }, "saved"),
      } : {}),
      ...savedRecordsEcho,
      draft_status: localValidationPassed ? "saved_local_validation_passed" : "saved_local_validation_failed",
      terminal: false,
      full_stage_check_performed: false,
      content_validation_performed: true,
      local_validation: localValidation,
      selector_repair_work: repairWork,
      ...(authoringWork ? { selector_authoring_work: authoringWork } : {}),
      current_stage: this.selectorStage,
      execution_state: executionState,
      ...nextStep,
      ...(referenceLocatorSourceRepair ? { reference_locator_source_repair: referenceLocatorSourceRepair } : {}),
      delivery_preview: selectorDeliveryPreview(current, registry, this.evidence.evidence, touchedItemKeys,
        new Set((await this.workspace.readState()).opened_evidence_ids), touchedSamplingRuleKeys),
      delivery_investigation: {
        advisory_only: true,
        hint_count: deliveryHints.length,
        hints: deliveryHints.slice(0, 24),
        remaining_item_keys: unique(deliveryHints.slice(24).flatMap(hint => hint.item_keys)),
      },
      global_candidate_complete: false,
      budget_consumed: false,
      collection: allCollections.length === 1 ? collection : null, collections: allCollections, operation, staged_record_count: entries.length,
      removed_record_count: removeKeys?.length ?? 0,
      draft_fingerprint: targetSelectorFingerprint(current),
      migration_issues: stagedMigrationIssues,
      resolved_quote_bindings: resolvedBindings,
      counts: { lots: current.lots.length, items: current.items.length, sampling_rules: current.sampling_rules.length, references: current.references.length, source_dispositions: current.source_dispositions.length },
      ...(quietRepairDraft ? {repair_progress: await this.coverageRepairDraftProgress(current,repairBefore)} : {}),
      instruction: renderFeedback({ kind: localValidationPassed ? "saved_local_ok" : "saved_local_failed",
    constraint: "本次全部增删已落盘，不重放已执行操作。当前唯一下一步入口由next_action或next_tool/next_tool_arguments给出；selector_repair_work给出当前合同错误，selector_authoring_work给出待判断来源，支持读取仅在缺上下文时使用。deferred详情按分页入口读取，原计数与上限不变。delivery_preview与delivery_investigation只供比较，不新增审核轮次。" }),
    };
  }

  private async coverageRepairDraftProgress(
    selectors: TargetSelectorPlan,
    repair: ReturnType<typeof repairStateOrDefault>,
  ): Promise<Record<string, unknown>> {
    const findingIds = repair.coverage_finding_ids ?? [];
    const affectedIds = new Set(repair.coverage_item_ids ?? []);
    if (!(await pathExists(this.workspace.lastValidSelectorPath))) {
      return { comparison_available: false, finding_ids: findingIds, review_required: true };
    }
    const baseline = migrateTargetSelectorPlanForAuthoring(strictJsonParse(
      await readFile(this.workspace.lastValidSelectorPath, "utf8"),
    )).plan;
    const affected = baseline.items.filter((item) =>
      affectedIds.has(semanticItemIdForSelectorKey(this.evidence.target_id, item.key))
    );
    const currentByKey = new Map(selectors.items.map((item) => [item.key, item]));
    const changed = affected.filter((item) => sha256Json(withoutSelectorExplanations(item))
      !== sha256Json(withoutSelectorExplanations(currentByKey.get(item.key) ?? null)));
    const changedKeys = new Set(changed.map((item) => item.key));
    const mappedIds = new Set(affected.map((item) => semanticItemIdForSelectorKey(this.evidence.target_id, item.key)));
    return {
      comparison_available: true,
      finding_ids: findingIds,
      affected_item_count: affectedIds.size,
      changed_item_count: changed.length,
      changed_item_keys: [...changedKeys].sort(),
      unchanged_item_keys: affected.filter((item) => !changedKeys.has(item.key)).map((item) => item.key).sort(),
      unmapped_affected_item_ids: [...affectedIds].filter((id) => !mappedIds.has(id)).sort(),
      review_required: true,
    };
  }

  private async commitTargetSelectorDraft(draftFingerprint: string): Promise<ToolResponse> {
    const pending = await this.pendingSelectorRepairResponse();
    if (pending) return pending;
    let selectors = migrateTargetSelectorPlan(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ));
    if (
      this.initialSelectorStartupContext.current_selector_state === "inherited_existing"
      && selectors.references.length > 0
      && !this.inheritedReferenceLedgerRead
    ) {
      return {
        ok: false,
        error_class: "protocol",
        error: "inherited_reference_occurrence_ledger_read_required",
        budget_consumed: false,
        required_action: "call_list_reference_occurrences_until_next_cursor_is_null_then_audit_destinations",
        instruction: "This inherited revision already has reference routes. Read the compact occurrence ledger before commit so occurrence_id, raw_reference, origin and target locator are visible; do not infer them from selector keys or ordering.",
      };
    }
    const referenceReadGate = referenceAnalysisGate([
      ...await inlineReferenceReadIssues(this.workspace, this.evidence),
      ...await referenceAnalysisIssues(this.workspace, this.evidence),
    ]);
    if (referenceReadGate) return referenceReadGate;
    let currentFingerprint = targetSelectorFingerprint(selectors);
    if (!/^[a-f0-9]{64}$/u.test(draftFingerprint) || draftFingerprint !== currentFingerprint) {
      const budget = await this.recordSelectorProtocolFailure("selector_draft_fingerprint_mismatch");
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_draft_fingerprint_mismatch",
        instruction: budget.exhausted
          ? "The protocol error budget is exhausted and this revision will stop. This commit did not change the saved draft. Inspect actual_draft_fingerprint and current_draft_fingerprint in the run record; do not retry tools in this terminated revision."
          : "This commit did not validate or change the saved draft. If no further edits are intended, retry commit_target_selector_draft with retry_arguments exactly. If your preceding stage call failed, use read_target_selectors to inspect the saved records and stage the missing edits first; use the new fingerprint returned by that successful stage. Do not edit the compiled plan or invent a fingerprint.",
        actual_draft_fingerprint: draftFingerprint,
        writable_path: "draft_fingerprint (tool argument)",
        next_tool: budget.exhausted ? null : "commit_target_selector_draft",
        ...(!budget.exhausted ? { retry_arguments: { draft_fingerprint: currentFingerprint } } : {}),
        current_draft_fingerprint: currentFingerprint,
        terminal: budget.exhausted,
        protocol_failure: budget,
      };
    }
    const state = await this.workspace.readState();
    if (repairStateOrDefault(state.repair).mode === "validated") {
      return {
        ok: false,
        terminal: false,
        error: "validated_selectors_require_seal",
        budget_consumed: false,
        draft_fingerprint: state.last_valid_fingerprint,
        instruction: "当前 selector 已通过验证。直接 seal 精确的已验证 fingerprint。",
      };
    }
    const protocol = selectorProtocolOrDefault(state.selector_protocol);
    const coverageRepair = this.selectorStage === "coverage_repair";
    if (
      (state.target_review_protocol === DIRECT_VALIDATION_PROTOCOL
        || state.target_review_protocol === SAME_AGENT_SELF_REVIEW_PROTOCOL)
      && !coverageRepair
    ) {
      const preflight = await this.evaluateTargetSelectorPreflight(selectors, false, false);
      selectors = preflight.selectors;
      currentFingerprint = targetSelectorFingerprint(selectors);
      this.submittedPreflight = { draft_fingerprint: currentFingerprint,
        evidence_fingerprint: this.evidence.evidence_fingerprint, result: preflight };
      if (!preflight.ok) {
        const terminal = terminalSelectorPreflightResponse(preflight);
        if (terminal) return { ...terminal, current_draft_fingerprint: currentFingerprint };
        const actionableIssues = preflight.issues.map(issue => actionableSelectorIssue(issue, selectors));
        const page = selectorIssueToolPage(actionableIssues);
        return {
          ok: false,
          terminal: false,
          error: "selector_global_preflight_failed",
          preflight_reused: preflight.response.preflight_reused === true,
          full_stage_check_performed: preflight.response.preflight_reused !== true,
          issue_owner: preflight.issue_owner,
          draft_status: "saved_global_preflight_failed",
          content_validation_performed: true,
          validation_scope: "global_candidate",
          global_candidate_complete: false,
          budget_consumed: false,
          current_draft_fingerprint: currentFingerprint,
          preflight_issue_fingerprint: preflight.issue_fingerprint,
          actual: {
            preflight_stage: preflight.stage_name,
            issue_count: preflight.issue_count,
            counts: targetSelectorCounts(selectors),
          },
          how_to_pass: "按每条问题的 next_tool、writable_path 和 how_to_pass 修复，直到全量 compiler/strict 预检通过，再 commit 当前 fingerprint。不同问题可能需要不同工具。",
          ...selectorRepairRoute(page.issues),
          do_not_edit: "编译生成的语义计划或不可变原文",
          selector_issues: page.issues,
          selector_issue_page: page.page,
          issue_details_read: { tool: "read_target_selector_issues", arguments: {
            draft_fingerprint: currentFingerprint, cursor: page.page.next_cursor ?? 0 } },
          instruction: "全量 compiler/strict 预检未通过。逐条使用问题指定的工具和可写路径修复；表结构通过 stage_table_structure 保存，selector 通过 stage_target_selector_draft 保存。完成后提交当前 fingerprint；未消耗语义提交或修复预算。",
        };
      }
    }
    const correction = !coverageRepair && protocol.submissions === 1 && protocol.corrections === 0;
    const continuingCoverageTransaction = coverageRepair
      && isContinuingCoverageRepair(state.coverage_recheck, state.repair?.coverage_review_fingerprint ?? "");
    if (coverageRepair && protocol.coverage_repairs >= 1 && !continuingCoverageTransaction) {
      // 裸错误 + terminal 是死路：模型先调 read_coverage_review 被告知「先验证计划」，
      // 转去提交就被判死刑，全程没人告诉它正确顺序（实测两个目标各重试 13、14 次后终止）。
      return {
        ok: false,
        terminal: true,
        error: "selector_coverage_repair_not_available",
        failure_class: PROTOCOL_TARGET_FAILURES.selector_coverage_repair_not_available?.failure_class,
        instruction: "This revision already consumed its single coverage repair and no recheck transaction is open. Do not retry the commit: validate the working plan first, then read_coverage_review against that exact fingerprint. A further repair requires a fresh coverage recheck scope, which this revision cannot open.",
      };
    }
    if (!coverageRepair && (protocol.submissions > 1 || protocol.corrections > 0)) {
      return {
        ok: false,
        terminal: protocol.corrections >= 1,
        error: "selector_correction_not_available",
        instruction: "This revision already used its selector correction. Do not retry this commit. Seal a validated draft or start a new revision.",
        failure_class: PROTOCOL_TARGET_FAILURES.selector_correction_not_available?.failure_class,
      };
    }
    if (coverageRepair) {
      const preflight = await this.evaluateTargetSelectorPreflight(selectors);
      if (preflight.ok && preflight.compiled) {
        const blockedCandidate = await this.coverageRepairCandidateGuard(
          state,
          preflight.compiled,
        );
        if (blockedCandidate) {
          return {
            ...blockedCandidate,
            draft_fingerprint: currentFingerprint,
            selector_transaction: "coverage_repair",
          };
        }
      }
    }
    const compiled = await this.compileWorkingSelectors(true);
    currentFingerprint = targetSelectorFingerprint(migrateTargetSelectorPlan(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    )));
    const owner = typeof compiled.issue_owner === "string" ? compiled.issue_owner : "";
    const initial = !coverageRepair && !correction;
    const faithfulStrictSelectorRepair = owner === "selector_input_error"
      && compiled.stage === "strict-validator-preflight";
    const consumesSemanticBudget = compiled.ok === true
      || (initial && owner === "selector_input_error" && !faithfulStrictSelectorRepair);
    const issues = Array.isArray(compiled.selector_issues)
      ? compiled.selector_issues
      : Array.isArray(compiled.issues)
      ? compiled.issues
      : [];
    if (consumesSemanticBudget) {
      await this.workspace.updateState((current) => {
        const currentProtocol = selectorProtocolOrDefault(current.selector_protocol);
        if (coverageRepair) {
          if (!continuingCoverageTransaction) currentProtocol.coverage_repairs += 1;
        } else if (correction) currentProtocol.corrections += 1;
        else currentProtocol.submissions += 1;
        currentProtocol.last_issue_owner = owner === "selector_input_error" ? "selector_input_error" : "";
        currentProtocol.last_issue_fingerprint = currentProtocol.last_issue_owner ? sha256Json(issues) : "";
        current.selector_protocol = currentProtocol;
      });
      if (initial) {
        const currentState = await this.workspace.readState();
        const content = await readFile(this.workspace.workingSelectorPath, "utf8");
        await this.persistBestSelectorDraft(
          content,
          currentFingerprint,
          Math.max(0, currentState.next_history_sequence - 1),
          compiled.ok === true ? 4 : 1,
          issues.length,
          sha256Json(issues),
        );
      }
    }
    if (compiled.ok === true) {
      this.selectorStage = "commit";
      await this.workspace.updateState((current) => { current.selector_stage = "commit"; });
    }
    return {
      ...compiled,
      draft_fingerprint: currentFingerprint,
      selector_transaction: coverageRepair ? "coverage_repair" : correction ? "correction" : "initial",
      budget_consumed: consumesSemanticBudget,
      error_class: owner === "selector_input_error" ? "semantic" : compiled.ok === true ? undefined : "compiler",
    };
  }

  private async reportFrozenScopeConflict(
    input: Record<string, unknown>, selectors: TargetSelectorPlan, preflight: TargetSelectorPreflight | undefined,
    spanIds: string[], evidenceIds: string[], paths: string[], explanation: string,
  ): Promise<ToolResponse> {
    const basis = await this.readFrozenTargetSemanticBasis();
    const gaps = (preflight?.issues ?? []).filter((issue): issue is { code: string; details?: unknown } =>
      Boolean(issue) && typeof issue === "object" && !Array.isArray(issue)
      && (issue as { code?: unknown }).code === "selector_ledger_required_clause_gap");
    const missingClauses = gaps.flatMap(issue => {
      const details = issue.details as { missing_clauses?: Array<{ clause_id: string; line: number; end_exclusive_line: number }> } | undefined;
      return details?.missing_clauses ?? [];
    });
    const primaryIds = [...new Set(evidenceIds)].filter(id => {
      const record = this.evidence.evidence.find(entry => entry.evidence_id === id);
      const line = record && evidenceLocatorLine(record.locator);
      return record?.evidence_scope === "primary" && line !== undefined
        && missingClauses.some(clause => line >= clause.line && line < clause.end_exclusive_line);
    });
    if (!basis?.subject || !basis.boundary_reason) {
      return {
        ok: false, terminal: false, budget_consumed: false, error: "frozen_scope_conflict_unverified",
        actual: { frozen_semantic_basis: basis ?? null },
        recovery_available: false, writable_paths: [], next_tool: null,
        instruction: "冻结发现计划缺少当前 target 的 subject/boundary_reason，无法核验范围冲突。模型工具不能补写这份不可变依据；需维护者恢复匹配的发现检查点或完整重跑，不能重复提交本报告或据此跳过覆盖。",
      };
    }
    if (!preflight || !gaps.length
      || gaps.length !== preflight.issues.length || primaryIds.length !== new Set(evidenceIds).size
      || paths.length !== 1 || paths[0] !== "/items"
      || input.preflight_issue_fingerprint !== preflight.issue_fingerprint) {
      const work = await this.selectorExecutionWork();
      const sourceIds = new Set(evidenceIds);
      const registered = this.evidence.reference_occurrences.filter(row => row.status === "resolved"
        && (sourceIds.has(row.origin_evidence_id) || row.target_evidence_ids.some(id => sourceIds.has(id))))
        .map(row => ({ occurrence_id: row.occurrence_id, target_locator: referenceOccurrenceTargetLocator(row),
          target_evidence_count: row.target_evidence_ids.length, source_role: "registered_reference",
          primary_range_expansion_required: false, applicability_decision_owner: "model" }));
      return {
        ok: false, terminal: false, budget_consumed: false, error: "frozen_scope_conflict_unverified",
        actual: { frozen_semantic_basis: basis ?? null, preflight_issue_fingerprint: preflight?.issue_fingerprint ?? null,
          missing_clauses: missingClauses, matching_primary_evidence_ids: primaryIds,
          registered_references_for_supplied_source: registered },
        expected: { scope_conflict: "current_preflight_only_has_primary_ledger_gaps_with_matching_evidence_and_fingerprint",
          reference_scope: "registered_reference_sources_do_not_require_expanding_primary_source_ranges" },
        writable_paths: ["/kind", "/preflight_issue_fingerprint", "/evidence_span_ids", "/affected_selector_paths", "/explanation"],
        ...(work ? { current_work: work, ...selectorWorkNextStep(work) } : preflight
          ? { next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" } }
          : { next_tool: "commit_target_selector_draft", next_tool_arguments: { draft_fingerprint: targetSelectorFingerprint(selectors) } }),
        instruction: "本报告未停止任务。通过条件：存在冻结的subject/boundary_reason，当前草稿仅有底账必抽缺口，报告span均是缺失条文的primary原文，affected_selector_paths=[\"/items\"]，并提供当前commit的preflight_issue_fingerprint。primary仅界定直接正文，不排除通过已登记引用接收范围外来源；按原引用、实际字段及业务适用性判断，不修改冻结primary范围。"
          + (work ? "当前仍有作者待办，先执行current_work/next_action，不能为取得报告指纹提前commit。" : "按next_tool取得当前状态，再以真实缺口及准确指纹报告。")
          + "来源获准使用不证明其业务适用，也不要求把整个引用全部判为不适用；保留真实条件和例外，不编造接收关系。",
      };
    }
    const report = {
      target_id: this.evidence.target_id, draft_fingerprint: targetSelectorFingerprint(selectors),
      evidence_fingerprint: this.evidence.evidence_fingerprint, preflight_issue_fingerprint: preflight.issue_fingerprint,
      frozen_semantic_basis: basis, primary_source_ranges: this.evidence.scope.primary_source_ranges,
      missing_clauses: missingClauses, evidence_span_ids: spanIds, evidence_ids: primaryIds,
      affected_selector_paths: paths, explanation,
    };
    await this.workspace.appendEvent("frozen_scope_conflict_reported", report);
    return {
      ok: false, terminal: true, budget_consumed: false, error: "target_scope_conflict_requires_review",
      blocker_code: "frozen_scope_conflict", failure_class: "coverage_harness_defect",
      coverage_satisfied: false, semantic_conflict_verified: false, report, writable_paths: [], next_tool: null,
      instruction: "已保存范围冲突报告及当前检查点，等待维护者核对发现阶段的 source_blocks、subject 和原文；报告不证明语义冲突成立，也不计为覆盖或封存。当前目标的冻结范围不可编辑。若确认范围划分错误，修订发现沟通后完整重跑；不得续交无关条目或改写 ledger/编译产物。",
    };
  }

  private async reportTargetBlocker(input: Record<string, unknown>): Promise<ToolResponse> {
    if (input.kind === "ambiguous_source") {
      const delivery = await this.pendingReferenceDeliveryResponse();
      if (delivery) return delivery;
    }
    const kind = String(input.kind ?? "");
    const spanIds = Array.isArray(input.evidence_span_ids) ? input.evidence_span_ids.map(String) : [];
    const paths = Array.isArray(input.affected_selector_paths) ? input.affected_selector_paths.map(String) : [];
    const findingIds = input.finding_ids === undefined
      ? []
      : Array.isArray(input.finding_ids)
        ? input.finding_ids.map(String)
        : undefined;
    const explanation = String(input.explanation ?? "").trim();
    if (kind === "frozen_scope_conflict" && !this.usesSelectorCompiler) {
      return {
        ok: false, terminal: false, budget_consumed: false, error: "frozen_scope_conflict_unverified",
        actual: { semantic_workflow: this.evidence.source.semantic_workflow ?? null },
        recovery_available: false, writable_paths: [], next_tool: null,
        instruction: "此历史目标没有 selector 预检协议，无法绑定当前必抽缺口指纹。模型工具不能升级冻结协议；需维护者按当前协议完整重跑，不能用本报告替代历史校验或确认覆盖。",
      };
    }
    if (
      !spanIds.length
      || !paths.length
      || paths.some((path) => !path.startsWith("/"))
      || findingIds === undefined
      || !explanation
    ) {
      return { ok: false, error: "invalid_typed_blocker", instruction: "调用 report_target_blocker 时，kind 必须使用工具契约列出的类型化 blocker code，并同时提供非空 evidence_span_ids、affected_selector_paths 和 explanation。" };
    }
    const registry = await this.workspace.readSourceSpanRegistry();
    const sources = new Map(this.evidence.evidence.map((record) => [record.evidence_id, {
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    }]));
    const blockerEvidenceIssues: Array<{ code: string; path: string; message: string; details?: unknown }> = [];
    const blockerEvidenceIds: string[] = [];
    for (const [index, spanId] of spanIds.entries()) {
      const resolved = resolveSourceSpan(
        registry,
        spanId,
        sources,
        `/evidence_span_ids/${index}`,
        blockerEvidenceIssues,
      );
      if (resolved) blockerEvidenceIds.push(resolved.evidence_id);
    }
    if (blockerEvidenceIssues.length) {
      return { ok: false, error: "blocker_evidence_invalid", instruction: "先打开并登记与阻塞相符的精确证据 span，按 issues 修正 evidence_span_ids 后再报告；不能使用未登记或无法解析的 ID。", issues: blockerEvidenceIssues };
    }
    const blockerEvidenceIdSet = new Set(blockerEvidenceIds);
    const userIgnoredOccurrenceIds = new Set<string>();
    if (this.externalSourceWorkflow?.ignored) {
      for (const occurrence of this.evidence.reference_occurrences) {
        if (occurrence.external_standard && await this.externalSourceWorkflow.ignored(occurrence.external_standard.standard_no)) {
          userIgnoredOccurrenceIds.add(occurrence.occurrence_id);
        }
      }
    }
    const nestedExternalReferences = this.evidence.reference_occurrences.filter(occurrence =>
      occurrence.status === "target_not_found" && occurrence.external_standard?.status === "placeholder"
      && referenceOccurrenceOriginEvidenceIds(occurrence).some(id => blockerEvidenceIdSet.has(id))
      && (userIgnoredOccurrenceIds.has(occurrence.occurrence_id)
      || externalReferenceFieldPolicy(this.evidence, referenceOccurrenceLiterals(occurrence)).literal_only
      || externalReferenceExpansionPolicy(this.evidence, referenceOccurrenceOriginEvidenceIds(occurrence), {
        standard_no: occurrence.external_standard.standard_no, ...(occurrence.target_address ? { source_sha256: occurrence.target_address.source_id } : {}),
      }).nested_external)
    );
    if ((kind === "missing_external_source" || kind === "ambiguous_source") && blockerEvidenceIds.length > 0
      && blockerEvidenceIds.every(id => nestedExternalReferences.some(occurrence => referenceOccurrenceOriginEvidenceIds(occurrence).includes(id)))) {
      const needsPolicyRegistration = nestedExternalReferences.some(occurrence => occurrence.external_standard?.expansion !== "literal_only");
      return {
        ok: false, terminal: false, ready: false, budget_consumed: false,
        error: "external_reference_expansion_limited", issue_owner: "selector_input_error",
        actual: { references: nestedExternalReferences.map(occurrence => ({ occurrence_id: occurrence.occurrence_id,
          raw_reference: occurrence.raw_reference, external_standard: occurrence.external_standard })),
          user_ignored_occurrence_ids: nestedExternalReferences.filter(occurrence => userIgnoredOccurrenceIds.has(occurrence.occurrence_id)).map(occurrence => occurrence.occurrence_id) },
        evidence_span_ids: spanIds, affected_selector_paths: paths,
        writable_paths: ["/references", ...paths],
        next_tool: needsPolicyRegistration ? "resolve_external_standard_reference" : "read_target_selectors",
        required_tools: ["read_target_selectors", "stage_target_selector_draft", "commit_target_selector_draft"],
        how_to_pass: userIgnoredOccurrenceIds.size
          ? "用户已通过当前任务界面忽略 actual.user_ignored_occurrence_ids 的缺失正文。尚未登记 literal_only 时先 resolve_external_standard_reference；随后用 keep_reference/reference_only、target_span_ids=[] 保留完整引文、原字段和 origin_binding。正文保持未核验，不再报告这些资料缺失。其他独立引用仍须按真实来源处理。"
          : "允许偏差字段引用须按 literal_only 保留完整原引用及原字段，即使有正文也不钻取。其他所引来源属于外部资料的后续跨标准引用时，先用 resolve_external_standard_reference 查本地已有原文；有则读取并判断与当前产出字段的相关性，没有则按 literal_only 使用 keep_reference/reference_only，target_span_ids 留空，并在真实原字段完整保留引用文字和 origin_binding。后续层级缺资料不构成等待用户补文件的终态阻塞。",
        do_not_edit: ["source", "compiler", "sealed_artifacts"],
        instruction: "修正作者引用记录后继续正常校验；本回条不代表正文已核验或原字段已完整，不能删除原引用、伪造目标 span 或自动补值。",
      };
    }
    const matchingUnresolvedExternalReferences = this.evidence.reference_occurrences.filter((occurrence) =>
      occurrence.status === "target_not_found"
      && occurrence.external_standard?.status === "placeholder"
      && !nestedExternalReferences.includes(occurrence)
      && referenceOccurrenceOriginEvidenceIds(occurrence).some((evidenceId) => blockerEvidenceIdSet.has(evidenceId))
    );
    if (kind === "ambiguous_source" && blockerEvidenceIds.every(evidenceId =>
      matchingUnresolvedExternalReferences.some(occurrence => referenceOccurrenceOriginEvidenceIds(occurrence).includes(evidenceId))
    )) {
      return {
        ok: false, terminal: false, ready: false, budget_consumed: false,
        error: "ambiguous_source_external_reference_unresolved",
        issue_owner: "selector_input_error",
        actual: { references: matchingUnresolvedExternalReferences.map(occurrence => ({
          occurrence_id: occurrence.occurrence_id, raw_reference: occurrence.raw_reference,
          status: occurrence.status, external_standard_status: occurrence.external_standard?.status,
          origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
        })) },
        evidence_span_ids: spanIds, affected_selector_paths: paths,
        writable_path: "/kind", allowed_values: ["missing_external_source"],
        next_tool: "report_target_blocker",
        next_tool_arguments: {
          kind: "missing_external_source", evidence_span_ids: spanIds,
          affected_selector_paths: paths, explanation,
        },
        how_to_pass: "所引证据对应的已登记外部引用实际为 target_not_found/placeholder，精确定位或重复 resolve 不能提供缺失的外部正文。若这正是阻塞原因，保留证据、受影响路径和说明，用 missing_external_source 重报，继续接受该类型既有的证据及 selector 校验。若报告的并非该引用缺失，先核对原文，再另选能证明所述歧义的精确 span。",
        do_not_edit: "不可变原文、resolver 状态和编译产物；不得猜测外部判据或通过删除真实项目解除阻塞。",
        instruction: "这是 blocker 类型与已有解析状态的校对，尚未接受终态阻塞。按 next_tool 重报后，由既有校验判定；不要把缺失来源伪装为 not_sampling。",
      };
    }
    if (kind === "missing_external_source") {
      if (matchingUnresolvedExternalReferences.length === 0) {
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "missing_external_source_unverified",
          issue_owner: "selector_input_error",
          evidence_span_ids: spanIds,
          affected_selector_paths: paths,
          actual: { matching_unresolved_external_reference_count: 0,
            references: this.evidence.reference_occurrences.filter(occurrence => referenceOccurrenceOriginEvidenceIds(occurrence)
              .some(id => blockerEvidenceIdSet.has(id))).map(occurrence => ({
                occurrence_id: occurrence.occurrence_id, raw_reference: occurrence.raw_reference,
                status: occurrence.status, external_standard_status: occurrence.external_standard?.status ?? "not_registered",
              })) },
          next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 100 },
          required_tools: [
            "list_reference_occurrences",
            "read_target_selectors",
            "stage_target_selector_draft",
            "commit_target_selector_draft",
          ],
          instruction: "当前没有与所引 span 对应的旧外部 placeholder 及 target_not_found 证明，此 blocker 尚未接受。先按 next_tool 核对现有引用：内部定位未命中不能冒充外部 placeholder；外部标准使用本任务提供的外部资料入口核对准确版本；真实正文依赖须等待资料，不可忽略或猜测。继续依据本地及适用共同原文完成 selector，原文没有的信息不得猜测。若核对后原文确实要求抽验但未给比例、数量或范围，沿用既有 reference_unspecified_quantity 契约；全数检查仍保留实际 quantity。此回条不替模型认定哪种 sampling 状态成立。",
        };
      }
    }
    if (kind === "scope_extension_required") {
      const evidenceById = new Map(this.evidence.evidence.map((record) => [record.evidence_id, record]));
      const primaryEvidenceIds = [...new Set(blockerEvidenceIds)];
      const outsidePrimary = primaryEvidenceIds.filter((evidenceId) =>
        evidenceById.get(evidenceId)?.evidence_scope !== "primary"
      );
      if (outsidePrimary.length === 0) {
        return {
          ok: false,
          terminal: false,
          budget_consumed: false,
          error: "scope_extension_not_required",
          issue_owner: "selector_input_error",
          primary_evidence_ids: primaryEvidenceIds,
          instruction: "所引 blocker span 已全部位于权威 primary target 范围内。继续在当前 selector 中表达这些条款和表格；不能仅凭模型自己编写且尚不完整的摘要申请扩展范围。",
        };
      }
    }
    let mechanicalPreflightDrift: TargetSelectorPreflight | undefined;
    let blockerSelectors: TargetSelectorPlan | undefined;
    if (this.usesSelectorCompiler) {
      let selectors: TargetSelectorPlan;
      try {
        selectors = migrateTargetSelectorPlan(strictJsonParse(
          await readFile(this.workspace.workingSelectorPath, "utf8"),
        ));
      } catch (error) {
        this.selectorBlockerRepairRequired = true;
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "target_blocker_rejected_actionable_selector_issues",
          issue_owner: "selector_input_error",
          actionable_issues: [{
            code: "invalid_target_selector_json",
            path: "/",
            actions: ["read_and_stage_valid_target_selectors"],
            message: error instanceof Error ? error.message : String(error),
          }],
          required_tools: ["read_target_selectors", "stage_target_selector_draft", "commit_target_selector_draft"],
          instruction: "当前 selector 草稿可按结构修复。先恢复合法的 typed selector JSON，再重新提交；target blocker 不能替代可执行的 selector 输入修复。",
        };
      }
      blockerSelectors = selectors;
      const preflight = this.submittedPreflight?.draft_fingerprint === targetSelectorFingerprint(selectors)
        && this.submittedPreflight.evidence_fingerprint === this.evidence.evidence_fingerprint
        ? this.submittedPreflight.result : undefined;
      if (kind === "frozen_scope_conflict") {
        return this.reportFrozenScopeConflict(input, selectors, preflight, spanIds, blockerEvidenceIds, paths, explanation);
      }
      if (preflight && !preflight.ok && preflight.issue_owner === "selector_input_error") {
        this.selectorBlockerRepairRequired = true;
        const issuePage = selectorIssueToolPage(preflight.issues.map(issue => actionableSelectorIssue(issue, preflight.selectors)));
        const repairRoute = selectorRepairRoute(issuePage.issues);
        const actionableIssues = issuePage.issues.map((issue) => {
          const record = issue && typeof issue === "object" && !Array.isArray(issue)
            ? issue as Record<string, unknown>
            : {};
          const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
            ? record.details as Record<string, unknown>
            : {};
          const mutuallyExclusiveActions = details.resolution_mode === "choose_exactly_one"
            && Array.isArray(details.required_actions)
            ? details.required_actions
            : [];
          const actions = mutuallyExclusiveActions.length > 0
            ? mutuallyExclusiveActions
            : [
                ...(typeof details.required_action === "string" ? [details.required_action] : []),
                ...(Array.isArray(details.required_actions) ? details.required_actions : []),
              ];
          return {
            ...record,
            code: typeof record.code === "string" ? record.code : "selector_input_error",
            path: typeof record.path === "string" ? record.path : "/",
            actions,
          };
        });
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "target_blocker_rejected_actionable_selector_issues",
          issue_owner: "selector_input_error",
          preflight_stage: preflight.stage_name,
          preflight_issue_fingerprint: preflight.issue_fingerprint,
          selector_issues: issuePage.issues,
          selector_issue_page: issuePage.page,
          actionable_issues: actionableIssues,
          ...repairRoute,
          required_tools: [
            "read_target_selectors",
            "open_evidence",
            "locate_evidence_span",
            ...repairRoute.next_tools,
            "commit_target_selector_draft",
          ],
          instruction: "当前确定性预检存在作者可修问题。按每条问题的 next_tool、writable_path 和 how_to_pass 读取依据并修复，再提交；表结构使用 stage_table_structure，selector 使用 stage_target_selector_draft。不能用 harness blocker 代替可执行的输入修复。",
        };
      }
      if (preflight && !preflight.ok && preflight.issue_owner === "compiler_invariant_violation") {
        mechanicalPreflightDrift = preflight;
      }
    }
    if (blockerSelectors) {
      const indexedPaths = paths.flatMap((path) => {
        const match = /^\/items\/(\d+)(?:\/|$)/u.exec(path);
        if (!match) return [];
        const itemIndex = Number(match[1]);
        const item = blockerSelectors!.items[itemIndex];
        const clause = item?.key.match(/^ledger-clause:(.+)$/u)?.[1];
        return [{ path, item_index: itemIndex, item_key: item?.key ?? "", clause_id: clause ?? "" }];
      });
      const blockerClauseIds = [...new Set(blockerEvidenceIds.flatMap((evidenceId) => {
        const clauseId = this.evidence.evidence.find((record) => record.evidence_id === evidenceId)?.clause_id;
        return clauseId ? [clauseId] : [];
      }))].sort();
      const selectorClauseIds = [...new Set(indexedPaths.map((entry) => entry.clause_id).filter(Boolean))].sort();
      const indexedPathInvalid = indexedPaths.some((entry) => !entry.item_key);
      if (
        indexedPathInvalid
        || (blockerClauseIds.length > 0 && selectorClauseIds.length > 0
          && (blockerClauseIds.length !== 1
            || selectorClauseIds.length !== 1
            || canonicalize(blockerClauseIds) !== canonicalize(selectorClauseIds)))
      ) {
        return {
          ok: false,
          terminal: false,
          budget_consumed: false,
          error: "blocker_selector_path_clause_mismatch",
          issue_owner: "selector_input_error",
          evidence_clause_ids: blockerClauseIds,
          affected_selector_items: indexedPaths,
          instruction: "affected_selector_paths 必须指向与 evidence spans 的 clause_id 机械一致的 selector item；重新读取 selector 并提交正确路径，不得把一个条款的证据归到其他 ledger-clause。",
        };
      }
    }
    if (kind === "ambiguous_source") {
      const resolvedReferencePath = /^\/references\/(\d+)\/(?:target_span_ids|application_mode|destinations|component_dispositions)(?:\/|$)/u;
      const resolvedReferencesByPath = new Map<string, { occurrence_id: string; reference_key?: string }>();
      for (const path of paths) {
        const indexed = resolvedReferencePath.exec(path);
        if (indexed) {
          const reference = blockerSelectors?.references[Number(indexed[1])];
          const occurrence = this.evidence.reference_occurrences.find((entry) => entry.occurrence_id === reference?.occurrence_id);
          if (reference && occurrence?.status === "resolved") {
            resolvedReferencesByPath.set(path, { reference_key: reference.key, occurrence_id: occurrence.occurrence_id });
          }
          continue;
        }
        const occurrenceId = /^\/references\/([^/]+)$/u.exec(path)?.[1];
        const occurrence = this.evidence.reference_occurrences.find((entry) => entry.occurrence_id === occurrenceId);
        if (occurrence?.status !== "resolved") continue;
        const sourceSpanIds = [
          ...referenceOccurrenceOriginSpanIds(occurrence),
          ...referenceOccurrenceLiteralSpanIds(occurrence),
        ];
        if (!sourceSpanIds.some((spanId) => spanIds.includes(spanId))) continue;
        const reference = blockerSelectors?.references.find((entry) => entry.occurrence_id === occurrence.occurrence_id);
        resolvedReferencesByPath.set(path, {
          ...(reference ? { reference_key: reference.key } : {}),
          occurrence_id: occurrence.occurrence_id,
        });
      }
      const referencePaths = paths.filter((path) => path !== "/items");
      if (referencePaths.length > 0 && referencePaths.every((path) => resolvedReferencesByPath.has(path))) {
        const resolvedReferences = [...new Map(referencePaths.map((path) => {
          const reference = resolvedReferencesByPath.get(path)!;
          return [reference.occurrence_id, reference] as const;
        })).values()];
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "resolved_reference_requires_source_grounded_selector_decision",
          issue_owner: "selector_input_error",
          resolved_references: resolvedReferences,
          evidence_span_ids: spanIds,
          affected_selector_paths: paths,
          writable_paths: [...new Set([
            ...paths.filter((path) => resolvedReferencePath.test(path)),
            "/items",
            "/references",
          ])],
          required_tools: [
            "read_target_selectors",
            "list_reference_occurrences",
            "read_document_reference_evidence",
            "read_reference_facts",
            "open_evidence",
            "stage_target_selector_draft",
            "advance_target_selector_stage",
          ],
          next_tool: "list_reference_occurrences",
          next_tool_arguments: { cursor: 0 },
          save_tool: "stage_target_selector_draft",
          how_to_pass: "该引用目标已解析；先按 occurrence 的 target_key/analysis_mode 读取被引原文，再读取当前 reference 和 items。缺少该 occurrence 的 selector 回执时，按其 occurrence_id 和全部有序 literal spans 新建 draft.references。由模型按来源判断适用性：已有真实接收项则补精确路由；独立判据缺项则在已确认范围内新增保留来源条件的 item，并逐组件填写 target_span_ids、component_dispositions 和真实 destinations。只有原文证实不适用才作不适用处置。暂存完整记录后重试预检；未知工程实例工况不能单独证明来源歧义。",
          instruction: "被引目标已解析，重复 resolve 或修改引用字面 span 不能解决适用条件和接收项判断。按 next_tool 与 how_to_pass 读取来源并保存有依据的 selector；不替模型选择工法、项目或业务结论。",
        };
      }
      const authoringState = await this.workspace.readState();
      const authoringCollections = Object.keys(TARGET_SELECTOR_DRAFT_JSON_SCHEMA.properties);
      const affectedCollections = [...new Set(paths.map(path => path.split("/")[1]!)
        .filter(collection => authoringCollections.includes(collection)))];
      const nextCollection = affectedCollections[0] ?? "items";
      return {
        ok: false,
        terminal: false,
        ready: false,
        budget_consumed: false,
        error: "ambiguous_source_requires_selector_disambiguation",
        issue_owner: "selector_input_error",
        fresh_session_retry_eligible: true,
        fresh_session_started: false,
        actual: {
          selector_stage: authoringState.selector_stage,
          selector_counts: blockerSelectors ? Object.fromEntries(authoringCollections.map(collection => [
            collection, (blockerSelectors as unknown as Record<string, unknown[]>)[collection]?.length ?? 0,
          ])) : null,
          stage_retries: authoringState.selector_protocol?.stage_retries,
          evidence_ids: [...new Set(blockerEvidenceIds)],
          related_reference_occurrences: this.evidence.reference_occurrences
            .filter(occurrence => referenceOccurrenceOriginEvidenceIds(occurrence).some(id => blockerEvidenceIdSet.has(id)))
            .map(occurrence => ({ occurrence_id: occurrence.occurrence_id, status: occurrence.status,
              external_standard_status: occurrence.external_standard?.status, target_evidence_count: occurrence.target_evidence_ids.length })),

          unresolved_references: this.evidence.reference_occurrences.filter(occurrence =>
          occurrence.status === "target_not_found"
          && referenceOccurrenceOriginEvidenceIds(occurrence).some(id => blockerEvidenceIds.includes(id))
        ).map(occurrence => ({ occurrence_id: occurrence.occurrence_id, raw_reference: occurrence.raw_reference,
          status: occurrence.status, origin_evidence_ids: referenceOccurrenceOriginEvidenceIds(occurrence),
          origin_span_ids: referenceOccurrenceOriginSpanIds(occurrence), external_standard: occurrence.external_standard })),
        },
        evidence_span_ids: spanIds,
        affected_selector_paths: paths,
        writable_paths: affectedCollections.map(collection => `/${collection}`),
        writable_collections: affectedCollections,
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: nextCollection },
        save_tool: "stage_target_selector_draft",
        required_tools: [
          "read_target_selectors",
          "get_target_selector_contract",
          "list_reference_occurrences",
          "open_evidence",
          "locate_evidence_span",
          "resolve_document_reference",
          ...(this.externalSourceWorkflow ? ["resolve_external_standard_reference"] : []),
          "stage_target_selector_draft",
          "commit_target_selector_draft",
        ],
        how_to_pass: "先按 next_tool_arguments 读取受影响的作者集合，再用 get_target_selector_contract 核对可写字段，依据已读原文选择精确 span 或完整引用字面 spans，保存有据的字段绑定或来源处置后重试实际预检。已定位的 span 只证明文字范围，未证明存在足够判据；若原文没有可执行依据，保留真实缺口及调查，不能靠新增空项、改说明或猜测外部内容通过。",
        do_not_edit: "不可变原文、引用解析状态、编译产物及读取或重试预算。",
        instruction: "当前文档未命中不能证明引用只属于内部；若上位依据明确来自外部标准，使用当前任务提供的外部资料工具核对准确版本，不能猜测正文。本次没有接受终态 blocker、启动 fresh session 或重置任何额度。actual 给出当前作者状态和关联引用的实际解析状态；空集合或未命中本身不证明来源角色。先完成有据的作者修复，只有真实可解析的依据才能消歧；无法补足时保留失败，由既有有界校验和外层调度结束或处理，不能把 fresh_session_retry_eligible 当作自动续跑承诺，也不能直接升级为 coverage_harness_defect。",
      };
    }
    let coverageOwner: CoverageBlockerOwnerDecision | undefined;
    let unresolvedSemanticFindingIds: string[] = [];
    const state = await this.workspace.readState();
    const repair = repairStateOrDefault(state.repair);
    const boundCoverageRepair = repair.repair_source === "coverage"
      && Boolean(repair.coverage_review_fingerprint)
      && state.selector_stage === "coverage_repair";
    if (boundCoverageRepair) {
      const planFingerprint = repair.coverage_review_fingerprint ?? "";
      const review = planFingerprint
        ? await readSealedCoverageReview(this.workspace, planFingerprint, this.evidence)
        : undefined;
      const reviewPlan = review
        ? await this.validatedPlanForFingerprint(planFingerprint)
        : undefined;
      if (!review || !reviewPlan) {
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "coverage_blocker_owner_unverified",
          issue_owner: "harness_contract",
          plan_fingerprint: planFingerprint,
          instruction: "当前 durable coverage review 或其已验证 source plan 不可用。不要猜测 blocker 归属；先恢复对应 review checkpoint，再重试。",
        };
      }
      const activeFindingIds = new Set(repair.coverage_finding_ids ?? []);
      const durableFindingIds = new Set(review.findings.map((finding) => finding.finding_id));
      const unknownActiveFindingIds = [...activeFindingIds]
        .filter((findingId) => !durableFindingIds.has(findingId))
        .sort();
      if (activeFindingIds.size === 0 || unknownActiveFindingIds.length > 0) {
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "coverage_blocker_owner_unverified",
          issue_owner: "harness_contract",
          plan_fingerprint: planFingerprint,
          active_finding_ids: [...activeFindingIds].sort(),
          unknown_active_finding_ids: unknownActiveFindingIds,
          instruction: "活跃 coverage-repair finding 集合必须非空，并且全部绑定到 durable review。先恢复 coverage repair checkpoint 再重试；不能从空集合或过期 finding 推断 blocker 归属。",
        };
      }
      const activeFindings = review.findings.filter((finding) => activeFindingIds.has(finding.finding_id));
      const activeReview = { findings: activeFindings };
      coverageOwner = coverageBlockerOwnerDecision(activeReview, findingIds);
      unresolvedSemanticFindingIds = coverageOwner.semantic_finding_ids;
      if (!coverageOwner.allowed) {
        const actionableReview = { findings: activeFindings.map((finding) => ({
          finding_id: finding.finding_id,
          affected_item_ids: finding.affected_item_ids,
        })) };
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: coverageOwner.error,
          issue_owner: coverageOwner.harness_finding_ids.length > 0
            ? "mixed_coverage_ownership"
            : "semantic_coverage_gap",
          finding_ids: coverageOwner.semantic_finding_ids,
          harness_finding_ids: coverageOwner.harness_finding_ids,
          nonblocking_finding_ids: coverageOwner.nonblocking_finding_ids,
          unknown_finding_ids: coverageOwner.unknown_finding_ids,
          affected_selector_bindings: await this.affectedSelectorBindings(actionableReview, reviewPlan),
          instruction: coverageOwner.error === "coverage_blocker_mixed_findings_require_explicit_ids"
            ? "当前 finding 集合同时包含 harness 归属和语义归属。只能用明确的 harness finding_ids 报告 harness blocker；其余语义 finding 继续走 typed selector 修复，不能用一个 blocker 吞并两条路线。"
            : "durable normalized review 已将这些 finding 路由为 typed 语义修复。读取列出的 selector bindings，增量暂存修复，不要报告 harness blocker。",
        };
      }
      if (kind !== "harness_contract_defect") {
        return {
          ok: false,
          terminal: false,
          ready: false,
          budget_consumed: false,
          error: "coverage_blocker_kind_owner_mismatch",
          issue_owner: "compiler_materialization_defect",
          finding_ids: coverageOwner.selected_harness_finding_ids,
          unresolved_semantic_finding_ids: coverageOwner.semantic_finding_ids,
          instruction: "durable normalized review 已确认 harness 归属缺陷。只把返回的明确 finding_ids 作为 harness_contract_defect 报告；调用方提交的 blocker kind 本身不能证明归属。",
        };
      }
    }
    if (
      kind === "harness_contract_defect"
      && coverageOwner === undefined
      && mechanicalPreflightDrift === undefined
    ) {
      return {
        ok: false,
        terminal: false,
        ready: false,
        budget_consumed: false,
        error: "coverage_blocker_owner_unverified",
        issue_owner: "harness_contract",
        actionable: true,
        evidence_span_ids: spanIds,
        affected_selector_paths: paths,
        submitted_finding_ids: findingIds,
        durable_finding_ids: [],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items" },
        next_tools: [
          "read_target_selectors",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
          "report_target_blocker",
        ],
        required_tools: [
          "read_target_selectors",
          "open_evidence",
          "locate_evidence_span",
          "stage_target_selector_draft",
          "commit_target_selector_draft",
        ],
        save_tool: "stage_target_selector_draft",
        how_to_pass: "先用 read_target_selectors 读取 items 目录，再按 affected_selector_paths 对应的 item key 逐条读取完整记录；若已有 selector/preflight finding，按其 next_tool、writable_paths 和 how_to_pass 继续 typed selector 修复并重新 commit。JSON Schema 中可选字段的内部 minItems 只约束实际提交该字段时的形状，不证明该字段适用于当前业务；是否提交由原文语义决定。只有来源本身确实缺失或歧义时，才分别使用满足各自证据门槛的 missing_external_source 或 ambiguous_source；只有 durable coverage review 明确判为 harness 归属的 finding，才能用其精确 finding_ids 报告 harness_contract_defect。",
        instruction: "仅靠调用方自报不能证明 harness defect。先读取受影响 selector 和现有确定性 finding，继续可执行的 typed selector 路线；来源缺失或歧义时走匹配的 source blocker，harness blocker 必须引用 durable coverage finding。本次未消耗 candidate 或语义预算。",
      };
    }
    await this.workspace.appendEvent("target_selector_blocker", {
      kind,
      finding_ids: coverageOwner?.selected_harness_finding_ids ?? findingIds,
      unresolved_semantic_finding_ids: unresolvedSemanticFindingIds,
      evidence_span_ids: spanIds,
      affected_selector_paths: paths,
      explanation,
      coverage_satisfied: false,
    });
    return {
      ok: false,
      terminal: true,
      budget_consumed: false,
      error: "target_blocked_with_evidence",
      blocker_code: kind,
      failure_class: kind === "scope_extension_required"
        ? "scope_extension"
        : "coverage_harness_defect",
      blocker: {
        kind,
        finding_ids: coverageOwner?.selected_harness_finding_ids ?? findingIds,
        evidence_span_ids: spanIds,
        affected_selector_paths: paths,
        explanation,
      },
      unresolved_semantic_finding_ids: unresolvedSemanticFindingIds,
      unselected_harness_finding_ids: coverageOwner
        ? coverageOwner.harness_finding_ids.filter((findingId) =>
            !coverageOwner!.selected_harness_finding_ids.includes(findingId)
          )
        : [],
      coverage_satisfied: false,
      instruction: "目标仍未封存。blocker 只保留阻塞证据，不能替代 selector 覆盖或最终批准。",
    };
  }

  private async replaceTargetSelectors(content: string): Promise<ToolResponse> {
    if (!this.usesSelectorCompiler) {
      return { ok: false, error: "target_selector_compiler_not_required", instruction: "This target is not in selector-compiler mode. Do not call this tool." };
    }
    const state = await this.workspace.readState();
    if (repairStateOrDefault(state.repair).mode === "validated") {
      return { ok: false, error: "validated_selectors_require_seal", instruction: "当前 selector 已通过验证。直接 seal 精确的已验证 fingerprint。" };
    }
    const current = strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ) as Partial<TargetSelectorPlan>;
    const alreadyAuthored = [
      current.lots,
      current.items,
      current.references,
      current.sampling_rules,
      current.source_dispositions,
    ].some((rows) => Array.isArray(rows) && rows.length > 0);
    if (alreadyAuthored) {
      return {
        ok: false,
        error: "initial_selector_replacement_forbidden",
        instruction: "Preserve existing selectors and use a bounded patch_target_selectors transaction.",
      };
    }
    let parsed: TargetSelectorPlan;
    try {
      parsed = strictJsonParse(content) as TargetSelectorPlan;
    } catch (error) {
      return { ok: false, error: "invalid_target_selector_json", instruction: "Fix the JSON against plan_json_schema. Empty arrays in the template are starting values, not permission to omit item shape.", message: error instanceof Error ? error.message : String(error) };
    }
    const invalid = await this.draftStorageIssue(parsed);
    if (invalid) return invalid;
    const written = await this.writeSelectorsWithHistory(prettyJson(parsed), "replace-target-selectors");
    return { ...written, draft_status:"saved_not_validated",content_validation_performed:false,draft_fingerprint:targetSelectorFingerprint(parsed) };
  }

  private async submitTargetSelectorTransaction(
    content: string,
    correction: boolean,
  ): Promise<ToolResponse> {
    if (!this.usesSelectorCompiler) return { ok: false, error: "target_selector_compiler_not_required", instruction: "Fix this request (target selector compiler not required). Do not retry the same arguments." };
    if (Buffer.byteLength(content, "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      return { ok: false, error: "selector_transaction_exceeds_128kb", instruction: "Fix this request (selector transaction exceeds 128kb). Do not retry the same arguments.", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
    }
    const state = await this.workspace.readState();
    if (state.status !== "working") {
      return {
        ok: false,
        terminal: true,
        error: "revision_is_terminal",
        status: state.status,
        instruction: "This revision is no longer editable. Stop issuing patches; a new revision must be opened by the batch runner before any further selector work.",
      };
    }
    const protocol = selectorProtocolOrDefault(state.selector_protocol);
    if (!correction && protocol.submissions !== 0) {
      return { ok: false, error: "selector_initial_submission_already_used", instruction: "This revision already used its initial submission. Use the correction path if still available, otherwise stop." };
    }
    if (correction && (
      protocol.submissions !== 1
      || protocol.corrections !== 0
    )) {
      return { ok: false, terminal: protocol.corrections >= 1, error: "selector_correction_not_available", instruction: "This revision already used its selector correction. Do not retry this commit. Seal a validated draft or start a new revision." };
    }
    let parsed: TargetSelectorPlan;
    try {
      parsed = strictJsonParse(content) as TargetSelectorPlan;
    } catch (error) {
      const budget = await this.recordSelectorProtocolFailure("selector_invalid_json");
      return {
        ok: false,
        error_class: "protocol",
        error: "selector_invalid_json",
        instruction: "Fix this request (selector invalid json). Do not retry the same arguments.",
        message: error instanceof Error ? error.message : String(error),
        budget_consumed: false,
        terminal: budget.exhausted,
        protocol_failure: budget,
      };
    }
    const written = await this.writeSelectorsWithHistory(
      prettyJson(parsed),
      correction ? "correct-target-selectors" : "submit-target-selectors",
    );
    const compiled = await this.compileWorkingSelectors(false);
    await this.workspace.updateState((current) => {
      const currentProtocol = selectorProtocolOrDefault(current.selector_protocol);
      if (correction) currentProtocol.corrections += 1;
      else currentProtocol.submissions += 1;
      const owner = typeof compiled.issue_owner === "string" ? compiled.issue_owner : "";
      currentProtocol.last_issue_owner = owner === "selector_input_error"
        || owner === "compiler_invariant_violation"
        || owner === "final_contract_violation"
        ? owner
        : "";
      const issues = compiled.selector_issues ?? compiled.issues ?? [];
      currentProtocol.last_issue_fingerprint = currentProtocol.last_issue_owner ? sha256Json(issues) : "";
      current.selector_protocol = currentProtocol;
    });
    return {
      ...written,
      ...compiled,
      selector_transaction: correction ? "correction" : "initial",
    } as ToolResponse;
  }

  private async patchTargetSelectors(operations: JsonPatchOperation[]): Promise<ToolResponse> {
    if (!this.usesSelectorCompiler) {
      return { ok: false, error: "target_selector_compiler_not_required", instruction: "This target is not in selector-compiler mode. Do not call this tool." };
    }
    if (repairStateOrDefault((await this.workspace.readState()).repair).mode === "validated") {
      return { ok: false, error: "validated_selectors_require_seal", instruction: "当前 selector 已通过验证。直接 seal 精确的已验证 fingerprint。" };
    }
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_PATCH_OPERATION_COUNT) {
      return { ok: false, error: "bounded_selector_patch_operation_limit", instruction: "Split the patch into fewer operations.", max_operations: MAX_PATCH_OPERATION_COUNT };
    }
    if (Buffer.byteLength(JSON.stringify(operations), "utf8") > MAX_PATCH_SERIALIZED_BYTES) {
      return { ok: false, error: "bounded_selector_patch_size_limit", instruction: "Shrink the patch payload. Do not retry the same oversized patch.", max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES };
    }
    if (operations.some((operation) => operation.path === "")) {
      return { ok: false, error: "bounded_selector_root_replacement_forbidden", instruction: "Patch individual collections. Do not replace the selector root." };
    }
    const before = await readFile(this.workspace.workingSelectorPath, "utf8");
    let document = strictJsonParse(before);
    for (const operation of operations) {
      if (!operation || !["add", "replace", "remove"].includes(operation.op)) {
        return { ok: false, error: "unsupported_selector_patch_operation", instruction: "Use add, remove, or replace on a writable selector path." };
      }
      document = applyJsonPatchOperation(document, operation);
    }
    const invalid = await this.draftStorageIssue(document);
    if (invalid) return invalid;
    const content = prettyJson(document);
    if (sha256Text(before) === sha256Text(content)) {
      return { ok: false, error: "selector_patch_made_no_durable_change", instruction: "Change at least one persisted selector field before patching again." };
    }
    const written = await this.writeSelectorsWithHistory(content, "patch-target-selectors");
    return { ...written, draft_status:"saved_not_validated",content_validation_performed:false,draft_fingerprint:targetSelectorFingerprint(document as TargetSelectorPlan) };
  }

  private async draftStorageIssue(document: unknown): Promise<ToolResponse | undefined> {
    const replaceFieldIssues = authoredReplaceFieldSelectorIssues(document);
    if (replaceFieldIssues.length) {
      return {
        ok: false,
        error: "selector_input_error",
        instruction: replaceFieldIssues[0]!.message,
        selector_issues: replaceFieldIssues,
        budget_consumed: false,
      };
    }
    const shapeError = selectorShapeError(document, TARGET_SELECTOR_PLAN_JSON_SCHEMA);
    if (shapeError) return shapeError;
    const draft = document as TargetSelectorPlan;
    if (draft.job_id !== this.workspace.jobId || draft.target_id !== this.workspace.targetId) return {ok:false,error:"selector_draft_identity_mismatch", instruction: "Fix this request (selector draft identity mismatch). Do not retry the same arguments.",budget_consumed:false};
    const registry = await this.workspace.readSourceSpanRegistry();
    const issues = selectorDraftSpanIssues(draft,new Set(registry.spans.map(span=>span.span_id)));
    return issues.length ? {ok:false,error:"selector_draft_span_validation", instruction: "Read selector_issues. Each fragment must be an exact substring of an opened evidence span_id. Copy the quote from open_evidence; do not normalize or retype it.",selector_issues:issues,budget_consumed:false} : undefined;
  }

  private async compileWorkingSelectors(runStrictValidation = true): Promise<ToolResponse> {
    if (!this.usesSelectorCompiler) {
      return { ok: false, error: "target_selector_compiler_not_required", instruction: "This target is not in selector-compiler mode. Do not call this tool." };
    }
    let selectors: TargetSelectorPlan;
    try {
      selectors = migrateTargetSelectorPlan(strictJsonParse(
        await readFile(this.workspace.workingSelectorPath, "utf8"),
      ));
    } catch (error) {
      return { ok: false, error: "invalid_target_selector_json", instruction: "Fix the JSON against plan_json_schema. Empty arrays in the template are starting values, not permission to omit item shape.", message: error instanceof Error ? error.message : String(error) };
    }
    const preflight = await this.evaluateTargetSelectorPreflight(selectors);
    selectors = preflight.selectors;
    this.submittedPreflight = {draft_fingerprint:targetSelectorFingerprint(selectors),evidence_fingerprint:this.evidence.evidence_fingerprint,result:preflight};
    if (!preflight.ok) {
      const visiblePreflightIssues = preflight.issues.map(issue => actionableSelectorIssue(issue, selectors));
      const toolPage = selectorIssueToolPage(visiblePreflightIssues);
      const response = { ...preflight.response };
      if (Array.isArray(response.selector_issues)) response.selector_issues = toolPage.issues;
      if (Array.isArray(response.issues)) response.issues = toolPage.issues;
      return {
        ...response,
        selector_issue_page: toolPage.page,
      };
    }
    const compiled = preflight.compiled!;
    const compiledContent = preflight.compiled_content!;
    const compilerContext = preflight.compiler_context!;
    const compilerContextFingerprint = selectorCompilerContextFingerprint(compilerContext);
    await atomicWriteJson(this.workspace.selectorCompilerContextPath, compilerContext);
    const current = await readFile(this.workspace.workingPlanPath, "utf8");
    if (sha256Text(current) !== sha256Text(compiledContent)) {
      await this.writePlanWithHistory(compiledContent, "compile-target-selectors");
    }
    if (!runStrictValidation) {
      return {
        ok: true,
        stage: "target-selector-slice",
        selector_fingerprint: targetSelectorFingerprint(selectors),
        compiled_plan_sha256: sha256Text(compiledContent),
        selector_compiler_context_fingerprint: compilerContextFingerprint,
        final_validation: "not_run",
        instruction: "This selector slice compiled without local dependency errors. Continue with the next slice; call compile_target_selectors only after the candidate is complete.",
      };
    }
    const selectorFingerprint = targetSelectorFingerprint(selectors);
    const stateBeforeValidation = await this.workspace.readState();
    const beforeRepair = repairStateOrDefault(stateBeforeValidation.repair);
    const directValidation = stateBeforeValidation.target_review_protocol === DIRECT_VALIDATION_PROTOCOL;
    const validation = await this.validateWorkingPlan("decision-compile", {
      selector_fingerprint: selectorFingerprint,
      compiled_plan_sha256: sha256Text(compiledContent),
      selector_compiler_context_fingerprint: compilerContextFingerprint,
    });
    const issueFingerprint = sha256Json(Array.isArray(validation.issues)
      ? validation.issues.map((issue) => issue && typeof issue === "object" ? {
          code: (issue as { code?: unknown }).code ?? "",
          path: (issue as { path?: unknown }).path ?? "",
          details: (issue as { details?: unknown }).details ?? null,
        } : issue)
      : []);
    const repeatedFailure = validation.ok !== true
      && validation.terminal !== true
      && beforeRepair.selector_fingerprint === selectorFingerprint
      && (beforeRepair.selector_validation_issue_fingerprint ?? beforeRepair.validation_fingerprint) === issueFingerprint;
    await this.workspace.updateState((state) => {
      const repair = repairStateOrDefault(state.repair);
      repair.selector_fingerprint = selectorFingerprint;
      repair.selector_validation_issue_fingerprint = issueFingerprint;
      if (repeatedFailure) repair.fresh_session_required = true;
      state.repair = repair;
    });
    if (repeatedFailure) {
      return {
        ok: false,
        error: "non_converging_selector_repeat",
        selector_fingerprint: selectorFingerprint,
        issue_fingerprint: issueFingerprint,
        instruction: "The same selector fingerprint produced the same issue set twice; stop this target and preserve the minimal selector/evidence package.",
      };
    }
    const localizedIssues = Array.isArray(validation.issues)
      ? validation.issues.map((issue) => {
          if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
          const record = issue as Record<string, unknown>;
          const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
          if (record.code === "semantic_evidence_not_opened" && typeof details.evidence_id === "string") {
            return {
              ...record,
              message: "此来源缺少完整阅读回执；这是补读要求，不是 selector 内容错误。",
              actual: { evidence_id: details.evidence_id, fully_opened: false },
              next_tool: "open_evidence", tool_arguments: { evidence_id: details.evidence_id }, writable_path: null,
              how_to_pass: "打开该 evidence_id 并沿 next_cursor 读完，再用同一 draft_fingerprint 重试 commit_target_selector_draft。不需要修改 selector 或编译产物。",
              do_not_edit: "不可变原文、编译产物；不要删除正确来源来绕过阅读要求",
            };
          }
          const path = typeof (issue as { path?: unknown }).path === "string"
            ? (issue as { path: string }).path
            : "/";
          return { ...issue, decision_path: decisionPathForCompiledPath(path) };
        })
      : [];
    const missingReadIds = unique(localizedIssues.flatMap(issue => {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
      const record = issue as Record<string, unknown>;
      const details = record.details as Record<string, unknown> | undefined;
      return record.code === "semantic_evidence_not_opened" && typeof details?.evidence_id === "string" ? [details.evidence_id] : [];
    }));
    const readOnlyFailure = missingReadIds.length > 0 && localizedIssues.every(issue => (issue as { code?: string })?.code === "semantic_evidence_not_opened");
    return {
      ...validation,
      issues: localizedIssues,
      ...(missingReadIds.length && validation.terminal !== true ? {
        next_tool: "batch_open_evidence", tool_arguments: { evidence_ids: missingReadIds.slice(0, 50) },
        unopened_evidence_ids: missingReadIds,
        ...(readOnlyFailure ? { writable_paths: [], required_action: "open_missing_evidence_then_retry_same_commit" } : {}),
      } : {}),
      stage: "compiled-source-plan",
      selector_fingerprint: selectorFingerprint,
      compiled_plan_sha256: sha256Text(compiledContent),
      selector_compiler_context_fingerprint: compilerContextFingerprint,
      ...(validation.ok && directValidation ? {
        validation_scope: "compiler_and_strict_authored_contracts",
        independent_semantic_review_performed: false,
      } : {}),
      instruction: renderFeedback({ kind: validation.ok ? "validated" : validation.terminal === true ? "terminal" : missingReadIds.length ? "current_diagnostic" : "current_diagnostic",
    terminal: validation.terminal === true, constraint: validation.ok ? "当前完整候选通过，直接seal返回精确fingerprint；本路径的业务核对已在作者提交前完成，不新开审核。"
      : missingReadIds.length ? "先按tool_arguments批量补缺阅读，并沿remaining_evidence_ids及各next_cursor读完；只有阅读前提缺口时保留同一draft_fingerprint重试commit，无需改selector。若另有作者问题按各自诊断处理。"
      : "只修当前可写作者路径并完整保存，不编辑编译产物；保存后跟随最新待办，当前作者错误清空且业务判断完成后再完整commit。" }),
    };
  }

  private async readCoverageReview(): Promise<ToolResponse> {
    if (this.evidence.source.adapter !== "document-domain-agent/v1") {
      return { ok: true, required: false, status: "not_required" };
    }
    const state = await this.workspace.readState();
    const repair = repairStateOrDefault(state.repair);
    const planFingerprint = state.last_valid_fingerprint
      || (repair.repair_source === "coverage"
        ? repair.coverage_review_fingerprint ?? ""
        : "");
    if (!planFingerprint) {
      return {
        ok: false,
        error: "coverage_review_requires_validated_plan",
        instruction: "Validate the current working plan first, then read the review bound to that exact fingerprint.",
      };
    }
    const review = await readSealedCoverageReview(
      this.workspace,
      planFingerprint,
      this.evidence,
    );
    const reviewPlan = review
      ? await this.validatedPlanForFingerprint(planFingerprint)
      : undefined;
    const affectedSelectorBindings = review && reviewPlan
      ? await this.affectedSelectorBindings(review, reviewPlan)
      : [];
    const affectedReferenceRoutes = review && reviewPlan
      ? coverageFieldScopedReferenceRoutesForItem(
          reviewPlan,
          this.evidence,
          new Set(review.findings.flatMap((finding) => finding.affected_item_ids)),
        )
      : [];
    const repairWorklist = review
      ? buildCoverageRepairWorklist(review, this.evidence, affectedSelectorBindings)
      : [];
    const sourceSelectors = reviewPlan && await pathExists(this.workspace.lastValidSelectorPath)
      ? migrateTargetSelectorPlanForAuthoring(strictJsonParse(await readFile(this.workspace.lastValidSelectorPath, "utf8"))).plan
      : undefined;
    const affectedOrigins = new Set(affectedSelectorBindings.map((binding) => String(binding.reference_origin_item_id)));
    const referenceRepairOptions = sourceSelectors && reviewPlan
      ? coverageReferenceRepairOptions(sourceSelectors, new Set(sourceSelectors.items
          .filter((item) => affectedOrigins.has(semanticItemIdForSelectorKey(reviewPlan.target_id, item.key)))
          .map((item) => item.key)), await this.workspace.readSourceSpanRegistry())
      : [];
    return review
      ? {
          ok: true,
          required: true,
          review,
          affected_selector_bindings: affectedSelectorBindings,
          affected_reference_routes: affectedReferenceRoutes,
          repair_worklist: repairWorklist,
          reference_repair_options: referenceRepairOptions,
          repair_delta_contract: {
            semantic_owner: "model",
            validator_owner: "deterministic_harness",
            allowed_delta_kinds: [...COVERAGE_REPAIR_DELTA_KINDS],
            missing_item_requires_existing_mapping: false,
            evidence_must_be_opened_before_edit: true,
            smallest_evidence_backed_delta_only: true,
            authoritative_reference_routes: "affected_reference_routes are immutable constraints for this repair. Preserve each occurrence literal in authoritative_target_field and never apply a finding by importing content outside the Agent-authored import_scope.allowed_fields. A route mismatch is a contract defect, not permission to choose another field.",
            reference_rebinding: "After removing a listed source_item_key, choose one eligible_receiver_key by changing only the unchanged reference destination in the same target_field. Deterministic commit appends the authorized citation/context spans and preserves the receiver byte-for-byte. Do not edit the receiver or recreate a generic leaf to keep its citation alive.",
          },
          instruction: repairWorklist.length
            ? "Compile every repair_worklist finding from its opened immutable evidence into the smallest typed selector delta. A missing judgment with no affected item or selector mapping may create new selector item(s); do not wait for an existing path. Re-read only the evidence needed for the finding, preserve unaffected selectors, commit the repaired draft, then seal for repair-delta review."
            : "The sealed coverage review contains no model-owned semantic gap worklist. Preserve the current selectors and follow the review status without inventing a repair.",
        }
      : {
          ok: false,
          required: true,
          error: "domain_coverage_review_required",
          plan_fingerprint: planFingerprint,
          instruction: "Do not poll read_coverage_review. Call seal_validated_plan once with plan_fingerprint to hand this exact validated plan to the independent reviewer; the batch orchestrator will run the review and resume repairs only if it returns findings.",
        };
  }

  private async validatedPlanForFingerprint(planFingerprint: string): Promise<SemanticSourcePlan | undefined> {
    for (const path of [this.workspace.lastValidPlanPath, this.workspace.workingPlanPath]) {
      if (!(await pathExists(path))) continue;
      const validation = validatePlanText(await readFile(path, "utf8"), this.evidence);
      if (validation.ok && validation.plan && validation.fingerprint === planFingerprint) {
        return validation.plan;
      }
    }
    const reviewRoot = join(this.workspace.coverageReviewDirectory, planFingerprint);
    if (await pathExists(join(reviewRoot, "candidate.plan.json")) && await pathExists(join(reviewRoot, "candidate.evidence.json"))) {
      const validation = validatePlanText(await readFile(join(reviewRoot, "candidate.plan.json"), "utf8"),
        await readJson<EvidenceManifest>(join(reviewRoot, "candidate.evidence.json")));
      if (validation.ok && validation.plan && validation.fingerprint === planFingerprint) return validation.plan;
    }
    return undefined;
  }

  private async affectedSelectorBindings(
    review: { findings: Array<{ finding_id: string; affected_item_ids: string[] }> },
    plan: SemanticSourcePlan,
  ): Promise<Array<Record<string, unknown>>> {
    if (!(await pathExists(this.workspace.workingSelectorPath))) return [];
    const selectors = migrateTargetSelectorPlan(strictJsonParse(
      await readFile(this.workspace.workingSelectorPath, "utf8"),
    ));
    const selectorByItemId = new Map(selectors.items.map((item, index) => [
      semanticItemIdForSelectorKey(plan.target_id, item.key),
      { item, index },
    ]));
    const materializedById = new Map(materialize(plan, this.evidence, sha256Json(plan)).result.inspection_lots
      .flatMap((lot) => lot.items)
      .map((item) => [item.item_id, item]));
    const findingIdsByFinalItemId = new Map<string, Set<string>>();
    for (const finding of review.findings) {
      for (const itemId of finding.affected_item_ids) {
        const ids = findingIdsByFinalItemId.get(itemId) ?? new Set<string>();
        ids.add(finding.finding_id);
        findingIdsByFinalItemId.set(itemId, ids);
      }
    }
    return [...findingIdsByFinalItemId.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([finalItemId, findingIds]) => {
        const finalItem = materializedById.get(finalItemId);
        const originItemId = finalItem?.reference_origin_item_id || finalItemId;
        const selector = selectorByItemId.get(originItemId);
        return {
          finding_ids: [...findingIds].sort(),
          final_item_id: finalItemId,
          reference_origin_item_id: originItemId,
          selector_key: selector?.item.key ?? "",
          selector_path: selector ? `/items/${selector.index}` : "",
          current_span_ids: selector ? selectorSpanIds(selector.item) : [],
          mapping_status: selector ? "mapped" : "unmapped",
        };
      });
  }

  private async coverageRepairCandidateGuard(
    state: RevisionState,
    candidatePersistedPlan: PersistedSemanticSourcePlan,
  ): Promise<ToolResponse | undefined> {
    const candidateValidation = validatePlanText(prettyJson(candidatePersistedPlan), this.evidence);
    if (!candidateValidation.ok || !candidateValidation.fingerprint || !candidateValidation.plan) return undefined;
    const candidatePlan = candidateValidation.plan;
    const repair = repairStateOrDefault(state.repair);
    const sourceFingerprint = repair.coverage_review_fingerprint ?? "";
    const checkpointFindingIds = repair.coverage_finding_ids ?? [];
    const checkpointItemIds = repair.coverage_item_ids ?? [];
    const checkpointReview = {
      findings: checkpointFindingIds.map((findingId) => ({
        finding_id: findingId,
        affected_item_ids: checkpointItemIds,
      })),
    };
    if (
      sourceFingerprint
      && candidateValidation.fingerprint === sourceFingerprint
      && checkpointFindingIds.length > 0
    ) {
      return {
        ok: false,
        terminal: false,
        error: "coverage_repair_candidate_already_rejected",
        issue_owner: "semantic_coverage_gap",
        budget_consumed: false,
        candidate_fingerprint: candidateValidation.fingerprint,
        finding_ids: checkpointFindingIds,
        affected_selector_bindings: await this.affectedSelectorBindings(checkpointReview, candidatePlan),
        instruction: "This exact deterministic candidate already has a sealed blocking review. Change the affected selector bindings before committing again.",
      };
    }
    const priorCandidateReview = await readSealedCoverageReview(
      this.workspace,
      candidateValidation.fingerprint,
      this.evidence,
    );
    if (priorCandidateReview?.status === "repair" || priorCandidateReview?.status === "harness_defect") {
      return {
        ok: false,
        terminal: false,
        error: priorCandidateReview.status === "repair"
          ? "coverage_repair_candidate_already_rejected"
          : "coverage_harness_candidate_already_rejected",
        issue_owner: priorCandidateReview.status === "repair"
          ? "semantic_coverage_gap"
          : "compiler_materialization_defect",
        budget_consumed: false,
        candidate_fingerprint: candidateValidation.fingerprint,
        findings: priorCandidateReview.findings,
        affected_selector_bindings: await this.affectedSelectorBindings(priorCandidateReview, candidatePlan),
        instruction: "This exact deterministic candidate already has a sealed blocking review. Change the affected selector bindings before committing again.",
      };
    }

    // Coverage repair is Agent-authored: deterministic code only blocks an exact candidate
    // that an independent reviewer already rejected. deriveCoverageRepairRecheckScope adds
    // every changed, added, or removed materialized item to the next review.
    return undefined;
  }

  private async patchWorkingPlan(
    operations: JsonPatchOperation[],
  ): Promise<ToolResponse> {
    if ((await this.workspace.readState()).status !== "working" || await pathExists(this.workspace.manifestPath)) {
      throw new Error("This revision is sealed; create a new revision before editing");
    }
    const repairBefore = await this.repairStatus();
    if (repairBefore.mode === "validated") {
      return {
        ok: false,
        error: "validated_plan_requires_seal",
        instruction: "The current durable plan is valid. Seal its exact fingerprint; do not mutate or expand it.",
      };
    }
    if (repairBefore.fresh_session_required) {
      return {
        ok: false,
        error: "fresh_repair_session_required",
        active_cluster: repairBefore.active_cluster,
        non_converging_rounds: repairBefore.non_converging_rounds,
        instruction: "Stop this session. A fresh repair session must read the durable plan and current validation receipt before attempting this cluster again.",
      };
    }
    if (
      !Array.isArray(operations)
      || operations.length === 0
      || operations.length > MAX_PATCH_OPERATION_COUNT
    ) {
      return {
        ok: false,
        error: "bounded_patch_operation_limit", instruction: "Fix this request (bounded patch operation limit). Do not retry the same arguments.",
        max_operations: MAX_PATCH_OPERATION_COUNT,
      };
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(operations), "utf8");
    if (serializedBytes > MAX_PATCH_SERIALIZED_BYTES) {
      return {
        ok: false,
        error: "bounded_patch_size_limit",
        serialized_bytes: serializedBytes,
        max_serialized_bytes: MAX_PATCH_SERIALIZED_BYTES,
        instruction: "Read the durable working plan and patch one smaller coherent slice; never replace the complete plan.",
      };
    }
    if (operations.some((operation) => operation?.path === "")) {
      return {
        ok: false,
        error: "bounded_patch_root_replacement_forbidden",
        instruction: "Patch explicit plan fields or array entries; never replace the complete plan through patch_working_plan.",
      };
    }
    const before = await readFile(this.workspace.workingPlanPath, "utf8");
    const beforeDocument = strictJsonParse(before);
    let document = beforeDocument;
    for (const operation of operations) {
      if (
        !operation
        || !["add", "replace", "remove"].includes(operation.op)
        || typeof operation.path !== "string"
      ) {
        return toolReject({
          error: "unsupported_json_patch_operation",
          instruction: "Use add, remove, or replace on a writable plan path. Do not retry this operation.",
          actual_op: operation?.op,
          actual_path: operation?.path,
        });
      }
      document = applyJsonPatchOperation(document, operation);
    }
    const normalized = normalizeOptionalSemanticSentinels(document);
    document = normalized.plan;
    const reconciled = reconcileDerivedEvidenceDispositions(
      document as SemanticSourcePlan,
      this.evidence,
    );
    document = reconciled.plan;
    const addedItemIds = addedAcceptanceItemIds(beforeDocument, document);
    if (
      repairBefore.mode === "repair"
      && repairBefore.repair_source !== "coverage"
      && addedItemIds.length
    ) {
      return {
        ok: false,
        error: "repair_only_item_expansion_forbidden",
        added_item_ids: addedItemIds,
        active_cluster: repairBefore.active_cluster,
        instruction: "Repair only the current validation issue cluster. New acceptance items require returning to modeling before validation, not widening a repair transaction.",
      };
    }
    const changedItemIds = changedAcceptanceItemIds(beforeDocument, document);
    const activeItemIds = new Set(repairBefore.active_cluster?.item_ids ?? []);
    const outOfClusterItemIds = repairBefore.mode === "repair"
      && repairBefore.repair_source !== "coverage"
      && activeItemIds.size > 0
      ? changedItemIds.filter((itemId) => !activeItemIds.has(itemId))
      : [];
    if (outOfClusterItemIds.length) {
      return {
        ok: false,
        error: "repair_only_outside_active_cluster",
        changed_item_ids: changedItemIds,
        outside_cluster_item_ids: outOfClusterItemIds,
        active_cluster: repairBefore.active_cluster,
        instruction: "Patch only acceptance items in the active validation issue cluster, while including all required related semantic/reference/table/sampling/disposition records in the same transaction.",
      };
    }
    if (changedItemIds.length > MAX_PATCH_CHANGED_ACCEPTANCE_ITEMS) {
      return {
        ok: false,
        error: "bounded_patch_item_limit",
        changed_item_count: changedItemIds.length,
        max_changed_item_count: MAX_PATCH_CHANGED_ACCEPTANCE_ITEMS,
        changed_item_ids: changedItemIds,
        instruction: "Patch at most four new, removed, or modified acceptance items in one durable checkpoint.",
      };
    }
    const content = prettyJson(document);
    if (sha256Text(before) === sha256Text(content)) {
      let status = repairBefore;
      if (repairBefore.mode === "repair") {
        status = await this.workspace.transactState((state) => {
          const repair = repairStateOrDefault(state.repair);
          repair.non_converging_rounds += 1;
          repair.fresh_session_required = repair.non_converging_rounds >= 2;
          state.repair = repair;
          return structuredClone(repair);
        });
      }
      return {
        ok: false,
        error: status.fresh_session_required
          ? "fresh_repair_session_required"
          : "patch_made_no_durable_change",
        instruction: status.fresh_session_required
          ? "This patch made no durable change. Start a fresh repair session; do not retry the same patch."
          : "Change at least one persisted field before patching again.",
        durable_hash: sha256Text(before),
        repair: status,
      };
    }
    const semanticChanges = changedSemanticRecords(beforeDocument, document);
    const history = await this.writePlanWithHistory(content, "json-patch");
    const validation = repairBefore.mode === "repair"
      ? await this.validateWorkingPlan("repair-patch")
      : undefined;
    return {
      ...history,
      changed_item_count: changedItemIds.length,
      changed_item_ids: changedItemIds,
      changed_semantic_records: semanticChanges,
      normalized_optional_semantic_ids: normalized.changed_semantic_ids,
      reconciled_evidence_ids: reconciled.changed_evidence_ids,
      durable_hash: sha256Text(content),
      serialized_patch_bytes: serializedBytes,
      ...(validation
        ? {
            repair_validation: validation,
            validation_issue_delta: validation.issue_delta,
            remaining_cluster:
              (validation.repair as { active_cluster?: unknown } | undefined)?.active_cluster
              ?? null,
            fresh_repair_session_required:
              (validation.repair as { fresh_session_required?: boolean } | undefined)
                ?.fresh_session_required === true,
          }
        : {}),
    };
  }

  private async reconcileEvidenceDispositions(input: unknown): Promise<ToolResponse> {
    const repair = await this.repairStatus();
    if (repair.mode !== "modeling") {
      return {
        ok: false,
        error: repair.mode === "validated"
          ? "validated_plan_requires_seal"
          : "repair_only_requires_coherent_patch",
        active_cluster: repair.active_cluster,
        instruction: repair.mode === "validated"
          ? "Seal the exact validated fingerprint; do not mutate evidence dispositions."
          : "Include semantic changes and their derived disposition consequences in one patch_working_plan transaction. The patch tool reconciles and revalidates atomically.",
      };
    }
    const decisions = input === undefined ? [] : input;
    if (!Array.isArray(decisions) || decisions.length > 100) {
      return { ok: false, error: "decisions_must_be_an_array_with_at_most_100_entries", instruction: "Pass a decisions array of at most 100 entries." };
    }
    const original = strictJsonParse(
      await readFile(this.workspace.workingPlanPath, "utf8"),
    ) as SemanticSourcePlan;
    if (!Array.isArray(original.acceptance_items) || !Array.isArray(original.evidence_dispositions)) {
      return { ok: false, error: "working_plan_requires_items_and_evidence_dispositions", instruction: "The working plan must already contain acceptance_items and evidence_dispositions." };
    }

    const duplicateExisting = original.evidence_dispositions
      .map((row) => row.evidence_id)
      .filter((evidenceId, index, all) => all.indexOf(evidenceId) !== index);
    if (duplicateExisting.length) {
      return {
        ok: false,
        error: "duplicate_evidence_disposition",
        instruction: "Fix this request (duplicate evidence disposition). Do not retry the same arguments.",
        evidence_ids: [...new Set(duplicateExisting)].sort(),
      };
    }

    const reconciled = reconcileDerivedEvidenceDispositions(original, this.evidence);
    const plan = reconciled.plan;
    const dispositions = plan.evidence_dispositions;
    const dispositionByEvidence = new Map(
      dispositions.map((row) => [row.evidence_id, row]),
    );

    const unhandledIds = new Set(
      compiledUnhandledEvidenceIds(plan, this.evidence.evidence),
    );
    const seenDecisions = new Set<string>();
    const normalizedDecisions: EvidenceDisposition[] = [];
    for (const raw of decisions) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "invalid_evidence_disposition_decision", instruction: "Pass disposition, evidence_id, and required fields from the disposition contract." };
      }
      const decision = raw as Record<string, unknown>;
      const evidenceId = typeof decision.evidence_id === "string"
        ? decision.evidence_id
        : "";
      const disposition = decision.disposition;
      const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
      if (seenDecisions.has(evidenceId)) {
        return { ok: false, error: "duplicate_evidence_disposition_decision", instruction: "Fix this request (duplicate evidence disposition decision). Do not retry the same arguments.", evidence_id: evidenceId };
      }
      seenDecisions.add(evidenceId);
      if (!unhandledIds.has(evidenceId)) {
        return { ok: false, error: "evidence_is_not_currently_unhandled", instruction: "Fix this request (evidence is not currently unhandled). Do not retry the same arguments.", evidence_id: evidenceId };
      }
      if (disposition !== "context" && disposition !== "ignored") {
        return {
          ok: false,
          error: "unhandled_evidence_decision_must_be_context_or_ignored",
          evidence_id: evidenceId,
          instruction: "To use this evidence, cite it from the appropriate item or sampling decision and call this tool again.",
        };
      }
      if (!reason) {
        return { ok: false, error: "evidence_disposition_reason_required", instruction: "Provide a non-empty reason for this unused/context/ignored disposition.", evidence_id: evidenceId };
      }
      if (!this.openedEvidenceIds.has(evidenceId)) {
        return { ok: false, error: "evidence_must_be_opened_before_disposition", instruction: "Call open_evidence on this evidence_id before disposing it.", evidence_id: evidenceId };
      }
      normalizedDecisions.push({
        evidence_id: evidenceId,
        disposition,
        item_ids: [],
        reason,
      });
    }

    for (const decision of normalizedDecisions) {
      dispositions.push(decision);
      dispositionByEvidence.set(decision.evidence_id, decision);
    }
    const changed = reconciled.changed_evidence_ids.length > 0 || normalizedDecisions.length > 0;
    let history: ToolResponse | undefined;
    if (changed) {
      history = await this.writePlanWithHistory(
        prettyJson(plan),
        "reconcile-evidence-dispositions",
      );
    }

    const remainingUnhandled = new Set(compiledUnhandledEvidenceIds(plan, this.evidence.evidence));
    const unhandledEvidence = this.evidence.evidence
      .filter((record) => remainingUnhandled.has(record.evidence_id))
      .map((record) => ({
        evidence_id: record.evidence_id,
        kind: record.kind,
        role: record.role,
        locator: record.locator,
        preview: record.text.slice(0, 240),
        opened: this.openedEvidenceIds.has(record.evidence_id),
      }));
    return {
      ok: true,
      complete: unhandledEvidence.length === 0,
      auto_used_evidence_ids: reconciled.changed_evidence_ids,
      applied_decision_count: normalizedDecisions.length,
      unhandled_count: unhandledEvidence.length,
      unhandled_evidence: unhandledEvidence,
      ...(history ? { history_sequence: history.history_sequence } : {}),
      instruction: unhandledEvidence.length
        ? "Open every remaining evidence atom. If it belongs in the result, cite it from the appropriate item or sampling decision and call this tool again; otherwise submit a context/ignored decision with a semantic reason."
        : "Evidence coverage is reconciled. Run validate_working_plan next.",
    };
  }

  private async applyTableAssembly(): Promise<ToolResponse> {
    const repair = await this.repairStatus();
    if (repair.mode !== "modeling") {
      return {
        ok: false,
        error: repair.mode === "validated"
          ? "validated_plan_requires_seal"
          : "repair_only_requires_coherent_patch",
        active_cluster: repair.active_cluster,
        instruction: "After validation starts, table repairs must be part of the active cluster's one coherent patch_working_plan transaction.",
      };
    }
    const source = await readFile(this.workspace.workingPlanPath, "utf8");
    const parsed = strictJsonParse(source) as SemanticSourcePlan;
    if (!parsed?.table_assembly) {
      return { ok: false, error: "working_plan_has_no_table_assembly", instruction: "Confirm or build table_assembly before this call." };
    }
    const issues = validateTableAssembly(parsed.table_assembly, this.evidence);
    if (issues.length) {
      return { ok: false, error: "table_assembly_invalid", instruction: "Fix this request (table assembly invalid). Do not retry the same arguments.", issues };
    }
    const baseline = buildPlanContract(this.evidence).plan_template;
    const currentWithoutAssembly = structuredClone(parsed) as unknown as Record<string, unknown>;
    const baselineWithoutAssembly = structuredClone(baseline) as unknown as Record<string, unknown>;
    delete currentWithoutAssembly.table_assembly;
    delete baselineWithoutAssembly.table_assembly;
    if (canonicalize(currentWithoutAssembly) !== canonicalize(baselineWithoutAssembly)) {
      return {
        ok: false,
        error: "table_assembly_must_precede_semantic_field_edits",
        instruction: "Restore non-table_assembly fields to the pre-seeded plan, apply table assembly first, then edit item semantics.",
      };
    }
    const rebuilt = buildPlanContract(
      this.evidence,
      parsed.table_assembly,
    ).plan_template;
    const written = await this.writePlanWithHistory(
      prettyJson(rebuilt),
      "apply-table-assembly",
    );
    return {
      ...written,
      logical_table_count: rebuilt.inspection_lots.length,
      formal_row_count: rebuilt.acceptance_items.length,
      instruction: "Table-derived lot/item structure is synchronized. Continue with references, sampling, and semantic field edits.",
    };
  }

  private async persistValidation(
    result: ValidationResult,
    planForClustering?: SemanticSourcePlan,
    source: "manual" | "repair-patch" | "decision-compile" = "manual",
    selectorCandidate?: SelectorValidationCandidate,
    validator: SemanticPlanValidatorVersion = "semantic-source-plan-validator/v4",
  ): Promise<ToolResponse> {
    const receipt = await this.workspace.transactState(async (state) => {
      const previousRepair = repairStateOrDefault(state.repair);
      const coverageRecheckScope = result.ok
        && result.plan
        && previousRepair.repair_source === "coverage"
        ? deriveCoverageRepairRecheckScope(
            this.evidence,
            hydrateSemanticSourcePlan(
              strictJsonParse(
                await readFile(this.workspace.lastValidPlanPath, "utf8"),
              ) as PersistedSemanticSourcePlan,
              this.evidence,
            ),
            result.plan,
            {
              mode: "repair_delta",
              affected_item_ids: previousRepair.coverage_item_ids ?? [],
              affected_evidence_ids: previousRepair.coverage_evidence_ids ?? [],
              finding_ids: previousRepair.coverage_finding_ids ?? [],
            },
          )
        : undefined;
      const clusters = !result.ok && planForClustering
        ? validationIssueClusters(planForClustering, result.issues)
        : [];
      const activeCluster = selectActiveIssueCluster(
        clusters,
        previousRepair.active_cluster?.key,
      );
      let nonConvergingRounds = previousRepair.non_converging_rounds;
      if (result.ok) {
        nonConvergingRounds = 0;
      } else if (source === "repair-patch" && previousRepair.mode === "repair") {
        const previousCluster = previousRepair.active_cluster;
        const sameCluster = previousCluster && activeCluster?.key === previousCluster.key;
        const totalIncreased = result.issues.length > previousRepair.total_issue_count;
        const sameClusterNotReduced = Boolean(
          sameCluster && activeCluster!.issue_count >= previousCluster!.issue_count,
        );
        nonConvergingRounds = totalIncreased || sameClusterNotReduced
          ? nonConvergingRounds + 1
          : 0;
      }
      const repair = result.ok
        ? {
            ...repairStateOrDefault(undefined),
            mode: "validated" as const,
            session_epoch: previousRepair.session_epoch,
          }
        : source === "decision-compile"
        ? previousRepair.repair_source === "coverage"
          ? { ...previousRepair, mode: "modeling" as const }
          : {
            ...repairStateOrDefault(undefined),
            mode: "modeling" as const,
            total_issue_count: result.issues.length,
            validation_fingerprint: sha256Json(result.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              details: issue.details ?? null,
            }))),
            session_epoch: previousRepair.session_epoch,
          }
        : {
            mode: "repair" as const,
            repair_source: previousRepair.repair_source ?? "validation",
            active_cluster: activeCluster,
            total_issue_count: result.issues.length,
            validation_fingerprint: sha256Json(result.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              details: issue.details ?? null,
            }))),
            non_converging_rounds: nonConvergingRounds,
            fresh_session_required: nonConvergingRounds >= 2,
            session_epoch: previousRepair.session_epoch,
            repair_session_restarts: previousRepair.repair_session_restarts,
            coverage_review_fingerprint: previousRepair.coverage_review_fingerprint ?? "",
            coverage_finding_ids: previousRepair.coverage_finding_ids ?? [],
            coverage_evidence_ids: previousRepair.coverage_evidence_ids ?? [],
            coverage_item_ids: previousRepair.coverage_item_ids ?? [],
          };
      const sequence = state.next_validation_sequence;
      const value = {
        schema_version: "validation-receipt/v1",
        sequence,
        attempt: state.validation_attempts + 1,
        timestamp: new Date().toISOString(),
        ok: result.ok,
        issues: result.issues,
        evidence_fingerprint: this.evidence.evidence_fingerprint,
        plan_sha256: result.plan_sha256 ?? "",
        validation_fingerprint: result.fingerprint ?? "",
        validated_submit: false,
        validator,
        trigger: source,
        ...(source === "decision-compile" && selectorCandidate
          ? selectorCandidate
          : {}),
        previous_total_issue_count: previousRepair.total_issue_count,
        repair,
      };
      await atomicWriteJson(
        join(this.workspace.validationDirectory, `${String(sequence).padStart(6, "0")}.json`),
        value,
      );
      await atomicWriteJson(this.workspace.validationReceiptPath, value);
      state.next_validation_sequence += 1;
      state.validation_attempts += 1;
      state.repair = repair;
      if (result.ok && result.plan && result.fingerprint && result.plan_sha256) {
        await atomicWriteJson(
          this.workspace.lastValidPlanPath,
          result.persisted_plan ?? result.plan,
        );
        if (this.usesSelectorCompiler && await pathExists(this.workspace.workingSelectorPath)) {
          await atomicWriteJson(
            this.workspace.lastValidSelectorPath,
            migrateTargetSelectorPlan(strictJsonParse(await readFile(this.workspace.workingSelectorPath, "utf8"))),
          );
        }
        state.last_valid_fingerprint = result.fingerprint;
        state.last_valid_plan_sha256 = result.plan_sha256;
        if (previousRepair.repair_source === "coverage") {
          if (!coverageRecheckScope) throw new Error("Coverage repair validation lacks a deterministic recheck scope");
          state.coverage_recheck = {
              schema_version: "coverage-recheck-scope/v1",
              plan_fingerprint: result.fingerprint,
              source_plan_fingerprint: previousRepair.coverage_review_fingerprint ?? "",
              review_fingerprint: previousRepair.validation_fingerprint,
              finding_ids: coverageRecheckScope.finding_ids,
              affected_item_ids: coverageRecheckScope.affected_item_ids,
              affected_evidence_ids: coverageRecheckScope.affected_evidence_ids,
          };
        } else {
          delete state.coverage_recheck;
        }
      } else {
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
      }
      return value;
    });
    return {
      ok: result.ok,
      issues: result.issues,
      fingerprint: result.fingerprint ?? "",
      plan_sha256: result.plan_sha256 ?? "",
      validation_sequence: receipt.sequence,
      repair: receipt.repair,
      issue_delta: result.issues.length - receipt.previous_total_issue_count,
      ...(result.ok ? {} : {
        instruction: "Repair the authoring selectors or working plan using issues. Do not patch compiled output.",
        required_action: "repair_using_returned_issues",
      }),
    };
  }

  private async persistedValidationReceipts(): Promise<PersistedValidationReceipt[]> {
    const names = (await readdir(this.workspace.validationDirectory))
      .filter((name) => /^\d{6}\.json$/u.test(name))
      .sort();
    return Promise.all(names.map((name) =>
      readJson<PersistedValidationReceipt>(join(this.workspace.validationDirectory, name))
    ));
  }

  private async reuseSuccessfulSelectorValidation(
    receipts: PersistedValidationReceipt[],
    candidate: SelectorValidationCandidate,
    candidatePersistedPlan: PersistedSemanticSourcePlan,
    candidatePlan: SemanticSourcePlan,
    candidatePlanSha256: string,
  ): Promise<ToolResponse | undefined> {
    const validator = semanticPlanValidatorVersion(candidatePersistedPlan);
    const expectedFingerprint = sha256Text(canonicalize({
      validator,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      plan_sha256: candidatePlanSha256,
    }));
    const receipt = [...receipts].reverse().find((entry) => (
      entry.ok === true
      && entry.trigger === "decision-compile"
      && validationReceiptMatchesPlanVersion(entry, candidatePersistedPlan)
      && entry.evidence_fingerprint === this.evidence.evidence_fingerprint
      && entry.selector_fingerprint === candidate.selector_fingerprint
      && entry.compiled_plan_sha256 === candidate.compiled_plan_sha256
      && entry.selector_compiler_context_fingerprint
        === candidate.selector_compiler_context_fingerprint
      && entry.plan_sha256 === candidatePlanSha256
      && entry.validation_fingerprint === expectedFingerprint
      && typeof entry.sequence === "number"
    ));
    if (!receipt) return undefined;

    const stateBeforeReuse = await this.workspace.readState();
    const previousRepair = repairStateOrDefault(stateBeforeReuse.repair);
    let resolvedCoverageRecheckScope: {
      finding_ids: string[];
      affected_item_ids: string[];
      affected_evidence_ids: string[];
    } | undefined;
    if (
      previousRepair.repair_source === "coverage"
      && stateBeforeReuse.coverage_recheck?.schema_version === "coverage-recheck-scope/v1"
      && stateBeforeReuse.coverage_recheck.plan_fingerprint === expectedFingerprint
    ) {
      resolvedCoverageRecheckScope = {
        finding_ids: stateBeforeReuse.coverage_recheck.finding_ids,
        affected_item_ids: stateBeforeReuse.coverage_recheck.affected_item_ids,
        affected_evidence_ids: stateBeforeReuse.coverage_recheck.affected_evidence_ids,
      };
    } else if (previousRepair.repair_source === "coverage" && previousRepair.coverage_review_fingerprint) {
      const sourcePlan = await this.validatedPlanForFingerprint(previousRepair.coverage_review_fingerprint);
      if (sourcePlan) {
        resolvedCoverageRecheckScope = deriveCoverageRepairRecheckScope(
          this.evidence,
          sourcePlan,
          candidatePlan,
          {
            mode: "repair_delta",
            affected_item_ids: previousRepair.coverage_item_ids ?? [],
            affected_evidence_ids: previousRepair.coverage_evidence_ids ?? [],
            finding_ids: previousRepair.coverage_finding_ids ?? [],
          },
        );
      } else {
        resolvedCoverageRecheckScope = {
          finding_ids: previousRepair.coverage_finding_ids ?? [],
          affected_item_ids: previousRepair.coverage_item_ids ?? [],
          affected_evidence_ids: previousRepair.coverage_evidence_ids ?? [],
        };
      }
    }

    await atomicWriteJson(this.workspace.lastValidPlanPath, candidatePersistedPlan);
    await atomicWriteJson(
      this.workspace.lastValidSelectorPath,
      migrateTargetSelectorPlan(strictJsonParse(
        await readFile(this.workspace.workingSelectorPath, "utf8"),
      )),
    );
    const state = await this.workspace.updateState((current) => {
      current.last_valid_fingerprint = expectedFingerprint;
      current.last_valid_plan_sha256 = candidatePlanSha256;
      current.repair = {
        ...repairStateOrDefault(undefined),
        mode: "validated",
        session_epoch: repairStateOrDefault(current.repair).session_epoch,
      };
      if (previousRepair.repair_source === "coverage") {
        if (!resolvedCoverageRecheckScope) {
          throw new Error("Coverage repair validation reuse lacks a deterministic recheck scope");
        }
        current.coverage_recheck = {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: expectedFingerprint,
          source_plan_fingerprint: previousRepair.coverage_review_fingerprint ?? "",
          review_fingerprint: previousRepair.validation_fingerprint,
          finding_ids: resolvedCoverageRecheckScope.finding_ids,
          affected_item_ids: resolvedCoverageRecheckScope.affected_item_ids,
          affected_evidence_ids: resolvedCoverageRecheckScope.affected_evidence_ids,
        };
      } else {
        delete current.coverage_recheck;
      }
    });
    return {
      ok: true,
      issues: [],
      fingerprint: expectedFingerprint,
      plan_sha256: candidatePlanSha256,
      validation_sequence: receipt.sequence,
      validation_reused: true,
      repair: state.repair,
      issue_delta: 0,
    };
  }

  private async validateWorkingPlan(
    trigger: "manual" | "repair-patch" | "decision-compile" = "manual",
    selectorCandidate?: SelectorValidationCandidate,
  ): Promise<ToolResponse> {
    const originalSource = await readFile(this.workspace.workingPlanPath, "utf8");
    let parsed: unknown;
    try {
      parsed = strictJsonParse(originalSource);
    } catch {
      const result = validatePlanText(originalSource, this.evidence, this.openedEvidenceIds);
      return this.persistValidation(result, undefined, trigger);
    }
    const compact = isCompactSemanticSourcePlan(parsed);
    let normalizedSource: string;
    let candidatePersistedPlan: PersistedSemanticSourcePlan;
    let candidatePlan: SemanticSourcePlan | undefined;
    if (compact) {
      // Compact plans are compiler artifacts. Hydration is a read-only runtime
      // view; legacy normalization must never expand that view back to disk.
      normalizedSource = originalSource;
      candidatePersistedPlan = parsed as SemanticSourcePlanV8;
      try {
        candidatePlan = hydrateSemanticSourcePlan(candidatePersistedPlan, this.evidence);
      } catch {
        // The strict validator below owns typed resolver diagnostics.
      }
    } else {
      const normalized = normalizeOptionalSemanticSentinels(parsed);
      const sourceCanonicalized = canonicalizeSharedSamplingSourceFragments(
        normalized.plan,
        this.evidence,
      );
      const reconciled = reconcileDerivedEvidenceDispositions(
        sourceCanonicalized.plan as SemanticSourcePlan,
        this.evidence,
      );
      normalizedSource = prettyJson(reconciled.plan);
      candidatePersistedPlan = reconciled.plan as SemanticSourcePlan;
      candidatePlan = reconciled.plan as SemanticSourcePlan;
      if (sha256Text(originalSource) !== sha256Text(normalizedSource)) {
        await this.writePlanWithHistory(
          normalizedSource,
          sourceCanonicalized.changes.length > 0
            ? "pre-validation-source-canonicalization"
            : "pre-validation-normalization",
        );
      }
    }
    const validator = semanticPlanValidatorVersion(candidatePersistedPlan);
    if (trigger === "decision-compile" && selectorCandidate) {
      const receipts = await this.persistedValidationReceipts();
      const candidatePlanSha256 = sha256Text(canonicalize(candidatePersistedPlan));
      const reused = candidatePlan
        ? await this.reuseSuccessfulSelectorValidation(
            receipts,
            selectorCandidate,
            candidatePersistedPlan,
            candidatePlan,
            candidatePlanSha256,
          )
        : undefined;
      if (reused) return reused;

      const failedAttempts = receipts.filter((receipt) => (
        receipt.ok === false
        && receipt.trigger === "decision-compile"
        && validationReceiptMatchesPlanVersion(receipt, candidatePersistedPlan)
        && receipt.evidence_fingerprint === this.evidence.evidence_fingerprint
      )).length;
      if (failedAttempts >= 3) {
        return {
          ok: false,
          terminal: true,
          error: "final_validator_attempt_limit",
          issue_owner: "final_contract_violation",
          failed_attempts: failedAttempts,
          max_failed_attempts: 3,
          instruction: "Three decision-compile validations already failed against this exact evidence fingerprint. Do not submit a fourth: the remaining issues are a contract violation this revision cannot repair. Report a blocker with the failing issues so the batch runner can open a fresh revision.",
        };
      }
    }
    const result = validatePlanText(
      normalizedSource,
      this.evidence,
      this.openedEvidenceIds,
    );
    if (result.ok && result.plan) {
      const citedAssemblyEvidence = [...new Set([
        ...result.plan.table_assembly.logical_tables.flatMap((table) =>
          table.evidence_ids
        ),
        ...result.plan.table_assembly.logical_tables.flatMap((table) =>
          table.canonical_title_fragments.map((fragment) => fragment.evidence_id)
        ),
      ])];
      const unopened = citedAssemblyEvidence.filter((evidenceId) =>
        !this.openedEvidenceIds.has(evidenceId)
      );
      if (unopened.length) {
        return this.persistValidation({
          ok: false,
          issues: [{
            code: "table_assembly_evidence_not_opened",
            path: "/table_assembly",
            message: "Open every evidence atom cited by the semantic table assembly before validation",
            details: {
              required_action: "Open every evidence atom cited by the semantic table assembly before validation",
              evidence_ids: unopened,
            },
          }],
        }, result.plan, trigger, selectorCandidate, validator);
      }
    }
    return this.persistValidation(
      result,
      result.plan ?? candidatePlan,
      trigger,
      selectorCandidate,
      validator,
    );
  }

  private async sealValidatedPlan(fingerprint: string): Promise<ToolResponse> {
    if (await pathExists(this.workspace.manifestPath)) {
      return { ok: false, error: "revision_already_sealed", instruction: "This revision is sealed. Do not mutate it; start a new revision if repair is required." };
    }
    const source = await readFile(this.workspace.workingPlanPath, "utf8");
    const state = await this.workspace.readState();
    let selectorCompilerContextContent = "";
    // Evidence-opening obligations are enforced when validate_working_plan persists the
    // last-valid checkpoint. They are intentionally not an in-memory prerequisite for
    // sealing that exact unchanged checkpoint after a process/session restart.
    const validation = validatePlanText(source, this.evidence);
    const currentFingerprint = validation.fingerprint ?? "";
    const lastValidFingerprint = state.last_valid_fingerprint ?? "";
    const lastValidPlanSha256 = state.last_valid_plan_sha256 ?? "";
    if (
      !validation.ok
      || !validation.plan
      || !validation.fingerprint
      || !validation.plan_sha256
      || validation.fingerprint !== lastValidFingerprint
      || validation.plan_sha256 !== lastValidPlanSha256
    ) {
      const mismatch = !validation.ok || !validation.plan || !validation.fingerprint || !validation.plan_sha256
        ? "plan_invalid"
        : "stale_last_valid_checkpoint";
      const instruction = mismatch === "plan_invalid"
        ? "Working plan failed validation. Repair using issues, then validate_working_plan or compile_target_selectors before sealing."
        : "The last-valid checkpoint is missing or stale. Re-run validate_working_plan or compile_target_selectors, then seal that fingerprint.";
      const sealErrorFingerprint = sha256Json({
        requested_fingerprint: fingerprint,
        current_fingerprint: currentFingerprint,
        issues: validation.issues,
      });
      const sealErrorPath = join(this.workspace.root, "seal-error-receipt.json");
      const previousSealError = await pathExists(sealErrorPath)
        ? await readJson<{ fingerprint?: string }>(sealErrorPath)
        : undefined;
      await this.workspace.updateState((current) => {
        current.last_valid_fingerprint = "";
        current.last_valid_plan_sha256 = "";
        const repair = repairStateOrDefault(current.repair);
        if (repair.mode === "validated") {
          current.repair = {
            ...repairStateOrDefault(undefined),
            mode: "modeling",
            session_epoch: repair.session_epoch,
          };
        }
      });
      if (previousSealError?.fingerprint === sealErrorFingerprint) {
        return {
          ok: false,
          error: "fingerprint_mismatch_or_unverified",
          mismatch,
          instruction,
          idempotent: true,
          issue_count: validation.issues.length,
          issue_fingerprint: sealErrorFingerprint,
          actual_fingerprint: fingerprint,
          expected_fingerprint: currentFingerprint,
          last_valid_fingerprint: lastValidFingerprint,
          current_fingerprint: currentFingerprint,
          required_action: "repair_the_previously_returned_mechanical_issues_before_retrying_seal",
        };
      }
      await atomicWriteJson(sealErrorPath, {
        schema_version: "seal-error-receipt/v1",
        fingerprint: sealErrorFingerprint,
        issue_count: validation.issues.length,
      });
      return {
        ok: false,
        error: "fingerprint_mismatch_or_unverified",
        mismatch,
        instruction,
        issues: validation.issues,
        issue_fingerprint: sealErrorFingerprint,
        actual_fingerprint: fingerprint,
        expected_fingerprint: currentFingerprint,
        last_valid_fingerprint: lastValidFingerprint,
        current_fingerprint: currentFingerprint,
        required_action: mismatch === "plan_invalid"
          ? "repair_using_returned_issues"
          : "resubmit_latest_validation_fingerprint",
      };
    }

    if (this.usesSelectorCompiler) {
      const selectors = migrateTargetSelectorPlan(strictJsonParse(
        await readFile(this.workspace.workingSelectorPath, "utf8"),
      ));
      const currentBoundary = (validation.persisted_plan ?? validation.plan) as { validation_boundary?: string };
      const roleObservations = await this.targetFieldRoleIssues(selectors);
      const fieldRoleIssues = currentBoundary.validation_boundary === STRUCTURAL_VALIDATION_BOUNDARY
        ? this.structuralIssues(roleObservations) : roleObservations;
      if (fieldRoleIssues.length) {
        await this.workspace.updateState((current) => {
          current.last_valid_fingerprint = "";
          current.last_valid_plan_sha256 = "";
          const repair = repairStateOrDefault(current.repair);
          current.repair = {
            ...repairStateOrDefault(undefined),
            mode: "modeling",
            session_epoch: repair.session_epoch,
          };
        });
        const page = selectorIssueToolPage(fieldRoleIssues.map(issue => actionableSelectorIssue(issue, selectors)));
        return {
          ok: false,
          terminal: false,
          error: "selector_field_role_invalid",
          issue_owner: "selector_input_error",
          actual: { invalid_binding_count: fieldRoleIssues.length },
          how_to_pass: "Replace every reported span with the returned current-clause or same-physical-table candidate, then commit and seal the new fingerprint.",
          do_not_edit: "编译生成的语义计划或不可变原文",
          next_tool: "stage_target_selector_draft",
          selector_issues: page.issues,
          selector_issue_page: page.page,
          budget_consumed: false,
          instruction: "封存已在写入不可变工件前被阻止。回条包含实际绑定原文和合法替换候选，仅修改 reason 不能使错误 span 合法。",
        };
      }
      const sourceClauseObservations = await this.targetSourceClauseIssues(
        selectors,
        validation.plan,
        targetSelectorFingerprint(selectors),
      );
      const sourceClauseIssues = currentBoundary.validation_boundary === STRUCTURAL_VALIDATION_BOUNDARY
        ? this.structuralIssues(sourceClauseObservations) : sourceClauseObservations;
      if (sourceClauseIssues.length) {
        await this.workspace.updateState((current) => {
          current.last_valid_fingerprint = "";
          current.last_valid_plan_sha256 = "";
          const repair = repairStateOrDefault(current.repair);
          current.repair = {
            ...repairStateOrDefault(undefined),
            mode: "modeling",
            session_epoch: repair.session_epoch,
          };
        });
        const page = selectorIssueToolPage(sourceClauseIssues.map(issue => actionableSelectorIssue(issue, selectors)));
        const repairRoute = selectorRepairRoute(page.issues);
        return {
          ok: false,
          terminal: false,
          error: "selector_source_clause_unresolved",
          issue_owner: "selector_input_error",
          actual: { unresolved_item_count: sourceClauseIssues.length },
          how_to_pass: "先按每条 selector_issue 的 next_tool 读取 item 与候选证据，再只修改返回的 writable_paths：绑定真正父条款的精确 span，并移除无关条款来源（若有）。用 save_tool 保存、重新 commit，最后以新 fingerprint 封存。",
          do_not_edit: "compiler-derived source_clause、编译语义计划或不可变原文",
          ...repairRoute,
          selector_issues: page.issues,
          selector_issue_page: page.page,
          budget_consumed: false,
          instruction: "封存已在写入不可变工件前被阻止。请修正返回的选择器 span 路径；source_clause 由证据推导，不可直接填写。",
        };
      }
      const latestSelectorValidationReceipt = await pathExists(this.workspace.validationReceiptPath)
        ? await readJson<PersistedValidationReceipt>(this.workspace.validationReceiptPath)
        : undefined;
      const selectorCompilerContextRequired = state.agent_runtime.kind !== "offline-scripted"
        && latestSelectorValidationReceipt?.trigger === "decision-compile";
      if (selectorCompilerContextRequired) {
      const preflight = await this.evaluateTargetSelectorPreflight(selectors, false, false);
      if (!preflight.ok) {
        await this.workspace.updateState((current) => {
          current.last_valid_fingerprint = "";
          current.last_valid_plan_sha256 = "";
          const repair = repairStateOrDefault(current.repair);
          current.repair = {
            ...repairStateOrDefault(undefined),
            mode: "modeling",
            session_epoch: repair.session_epoch,
          };
        });
        const page = selectorIssueToolPage(preflight.issues.map(issue => actionableSelectorIssue(issue, preflight.selectors)));
        const response = { ...preflight.response };
        if (Array.isArray(response.selector_issues)) response.selector_issues = page.issues;
        if (Array.isArray(response.issues)) response.issues = page.issues;
        return {
          ...response,
          ok: false,
          selector_issue_page: page.page,
          budget_consumed: false,
          instruction: renderFeedback({ kind: "seal_revalidation_failed", constraint: "本次使用与commit相同的完整compiler context复验未过。按真实owner处理作者可修路径或程序故障，不能把本次ok=false理解为此前保存被撤销。" }),
        };
      }
      const currentCompilerContext = preflight.compiler_context!;
      const currentCompilerContextContent = prettyJson(currentCompilerContext);
      const currentCompilerContextFingerprint = selectorCompilerContextFingerprint(
        currentCompilerContext,
      );
      const [persistedCompilerContextContent, validationReceipt] = await Promise.all([
        (await pathExists(this.workspace.selectorCompilerContextPath))
          ? readFile(this.workspace.selectorCompilerContextPath, "utf8")
          : Promise.resolve(""),
        (await pathExists(this.workspace.validationReceiptPath))
          ? readJson<PersistedValidationReceipt>(this.workspace.validationReceiptPath)
          : Promise.resolve({} as PersistedValidationReceipt),
      ]);
      const selectorFingerprint = targetSelectorFingerprint(preflight.selectors);
      const compiledPlanSha256 = sha256Text(preflight.compiled_content!);
      if (
        sha256Text(persistedCompilerContextContent) !== sha256Text(currentCompilerContextContent)
        || validationReceipt.ok !== true
        || validationReceipt.trigger !== "decision-compile"
        || validationReceipt.selector_fingerprint !== selectorFingerprint
        || validationReceipt.compiled_plan_sha256 !== compiledPlanSha256
        || validationReceipt.selector_compiler_context_fingerprint
          !== currentCompilerContextFingerprint
        || sha256Text(source) !== compiledPlanSha256
      ) {
        await this.workspace.updateState((current) => {
          current.last_valid_fingerprint = "";
          current.last_valid_plan_sha256 = "";
          const repair = repairStateOrDefault(current.repair);
          current.repair = {
            ...repairStateOrDefault(undefined),
            mode: "modeling",
            session_epoch: repair.session_epoch,
          };
        });
        return {
          ok: false,
          terminal: false,
          error: "selector_compiler_context_stale",
          issue_owner: "selector_input_error",
          actual: {
            selector_fingerprint: selectorFingerprint,
            selector_compiler_context_fingerprint: currentCompilerContextFingerprint,
          },
          how_to_pass: "保留当前 selector 与表结构决定，使用 commit_target_selector_draft 提交当前 draft_fingerprint；成功后只封存该回条返回的新 fingerprint。",
          writable_paths: [],
          next_tool: "commit_target_selector_draft",
          next_tool_arguments: { draft_fingerprint: selectorFingerprint },
          budget_consumed: false,
          instruction: renderFeedback({ kind: "seal_revalidation_failed", constraint: "selector、表结构/可见来源上下文、编译计划及最近成功receipt未绑定同一候选。保留作者记录，用当前draft_fingerprint重新commit；成功后seal该新指纹。" }),
        };
      }
      selectorCompilerContextContent = persistedCompilerContextContent;
      }
    }

    const directValidation = state.target_review_protocol === DIRECT_VALIDATION_PROTOCOL
      || state.target_review_protocol === SAME_AGENT_SELF_REVIEW_PROTOCOL;
    const coverageReview = this.evidence.source.adapter === "document-domain-agent/v1" && !directValidation
      ? await readSealedCoverageReview(this.workspace, validation.fingerprint, this.evidence)
      : undefined;
    if (this.evidence.source.adapter === "document-domain-agent/v1" && !directValidation && !coverageReview) {
      return {
        ok: false,
        error: "domain_coverage_review_required",
        current_fingerprint: validation.fingerprint,
        instruction: "A separate Agent session must exhaustively compare every target evidence atom and every independently executable condition/value branch with this exact candidate plan before it can seal.",
      };
    }
    if (coverageReview?.status === "repair") {
      return {
        ok: false,
        error: "domain_coverage_repair_required",
        current_fingerprint: validation.fingerprint,
        summary: coverageReview.summary,
        findings: coverageReview.findings,
        affected_selector_bindings: await this.affectedSelectorBindings(coverageReview, validation.plan),
        instruction: "Read the coverage review, repair every omission or semantic merge, then validate again. The changed fingerprint requires a fresh independent review.",
      };
    }
    if (coverageReview?.status === "harness_defect") {
      return {
        ok: false,
        error: "coverage_harness_defect",
        current_fingerprint: validation.fingerprint,
        summary: coverageReview.summary,
        findings: coverageReview.findings,
        affected_selector_bindings: await this.affectedSelectorBindings(coverageReview, validation.plan),
        instruction: "Stop this target. A deterministic compiler or materializer defect must be fixed before this exact candidate can be sealed; the selector Agent must not edit compiler output.",
      };
    }
    if (
      this.evidence.source.adapter === "document-domain-agent/v1"
      && !directValidation
      && coverageReview?.status !== "approved"
    ) {
      return {
        ok: false,
        error: "domain_coverage_review_status_invalid",
        instruction: "Fix this request (domain coverage review status invalid). Do not retry the same arguments.",
        current_fingerprint: validation.fingerprint,
        actual_status: coverageReview?.status ?? "missing",
      };
    }

    // A request typo does not invalidate a checkpoint. Only offer a retry after
    // every existing plan, selector/context and coverage check has succeeded.
    if (fingerprint !== currentFingerprint) {
      return {
        ok: false,
        error: "fingerprint_mismatch_or_unverified",
        mismatch: "submitted_fingerprint",
        actual_fingerprint: fingerprint,
        expected_fingerprint: currentFingerprint,
        current_fingerprint: currentFingerprint,
        last_valid_fingerprint: lastValidFingerprint,
        checkpoint_preserved: true,
        current_checkpoint_verified: true,
        idempotent: true,
        budget_consumed: false,
        writable_paths: ["/fingerprint"],
        next_tool: "seal_validated_plan",
        next_tool_arguments: { fingerprint: currentFingerprint },
        required_action: "resubmit_latest_validation_fingerprint",
        how_to_pass: "Use the exact fingerprint in next_tool_arguments to retry seal_validated_plan. The rejected request has not sealed or changed this candidate.",
        do_not_edit: "Do not edit the validated selectors, source registry, compiler context or compiled plan to repair a request fingerprint.",
        instruction: renderFeedback({ kind: "fingerprint_request", constraint: "当前已核实last-valid checkpoint有效。只复制next_tool_arguments重试seal；此次请求没封存或改候选，不以plan SHA/draft指纹代替validation fingerprint。" }),
      };
    }

    const transcriptPrefix = await this.workspace.transcriptPrefix();
    const selectorContent = this.usesSelectorCompiler
      && await pathExists(this.workspace.workingSelectorPath)
      ? await readFile(this.workspace.workingSelectorPath, "utf8")
      : "";
    const persistedPlan = validation.persisted_plan ?? validation.plan;
    const { result, provenance } = materialize(
      validation.plan,
      this.evidence,
      validation.fingerprint,
    );
    const sealedAt = new Date().toISOString();
    const sealedPlanContent = prettyJson(persistedPlan);
    const tableAssemblyContent = prettyJson(validation.plan.table_assembly);
    const resultContent = prettyJson(result);
    const provenanceContent = prettyJson(provenance);
    const sealReceipt = {
      schema_version: "seal-receipt/v1",
      status: "passed",
      validated_submit: true,
      sealed_at: sealedAt,
      revision: this.workspace.revision,
      evidence_fingerprint: this.evidence.evidence_fingerprint,
      plan_sha256: validation.plan_sha256,
      validation_fingerprint: validation.fingerprint,
      validation_attempts: state.validation_attempts,
      ...(directValidation
        ? {
            target_review_protocol: DIRECT_VALIDATION_PROTOCOL,
          }
        : {}),
      ...(coverageReview
        ? { coverage_review_fingerprint: sha256Json(coverageReview) }
        : {}),
      transcript_prefix: transcriptPrefix,
    };
    const sealReceiptContent = prettyJson(sealReceipt);
    const manifest = {
      schema_version: "sealed-manifest/v1",
      status: "passed",
      validated_submit: true,
      sealed_at: sealedAt,
      revision: this.workspace.revision,
      job_id: this.evidence.job_id,
      target_id: this.evidence.target_id,
      runtime: state.agent_runtime,
      pi_sdk: {
        package: "@earendil-works/pi-coding-agent",
        version: "0.83.0",
      },
      fingerprints: {
        evidence: this.evidence.evidence_fingerprint,
        plan: validation.fingerprint,
        ...(coverageReview
          ? { coverage_review: sha256Json(coverageReview) }
          : {}),
        files: {
          "table-assembly-plan.json": sha256Text(tableAssemblyContent),
          "semantic-source-plan.json": sha256Text(sealedPlanContent),
          ...(selectorContent
            ? { "target-selectors.json": sha256Text(selectorContent) }
            : {}),
          ...(selectorCompilerContextContent
            ? { "selector-compiler-context.json": sha256Text(selectorCompilerContextContent) }
            : {}),
          "result.json": sha256Text(resultContent),
          "provenance.json": sha256Text(provenanceContent),
          "seal-receipt.json": sha256Text(sealReceiptContent),
        },
      },
      transcript_prefix: transcriptPrefix,
    };
    const manifestContent = prettyJson(manifest);

    // Manifest is the commit marker and is published last. A retry can safely
    // finish an interrupted seal when all prior bytes are identical.
    await publishImmutable(this.workspace.tableAssemblyPlanPath, tableAssemblyContent);
    if (selectorContent) {
      await publishImmutable(this.workspace.sealedSelectorPath, selectorContent);
    }
    await publishImmutable(this.workspace.sealedPlanPath, sealedPlanContent);
    await publishImmutable(this.workspace.resultPath, resultContent);
    await publishImmutable(this.workspace.provenancePath, provenanceContent);
    await publishImmutable(this.workspace.sealReceiptPath, sealReceiptContent);
    await publishImmutable(this.workspace.manifestPath, manifestContent);
    for (const path of [
      this.workspace.tableAssemblyPlanPath,
      this.workspace.workingSelectorPath,
      this.workspace.sealedSelectorPath,
      this.workspace.selectorCompilerContextPath,
      this.workspace.sourceSpanRegistryPath,
      this.workspace.sealedPlanPath,
      this.workspace.resultPath,
      this.workspace.provenancePath,
      this.workspace.sealReceiptPath,
      this.workspace.manifestPath,
      this.workspace.workingPlanPath,
      this.workspace.lastValidPlanPath,
      this.workspace.lastValidSelectorPath,
      this.workspace.validationReceiptPath,
    ]) {
      if (await pathExists(path)) await makeReadOnly(path);
    }
    await this.workspace.updateState((current) => {
      current.status = "sealed";
    });
    const audit = await auditAndPersist(this.workspace);
    return {
      ok: true,
      status: "passed",
      revision: this.workspace.revision,
      fingerprint: validation.fingerprint,
      result_sha256: sha256Text(resultContent),
      transcript_through_sequence: transcriptPrefix.through_sequence,
      audit_status: audit.audit.status,
      audit_fingerprint: audit.audit.audit_fingerprint,
      audit_path: audit.paths.audit_path,
      repair_plan_path: audit.paths.repair_plan_path,
    };
  }
}

function resultContent(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  const delivered = selectorDiagnosticToolResponse(value);
  return {
    content: [{ type: "text", text: JSON.stringify(delivered) }],
    details: delivered,
  };
}

export interface PiToolHooks {
  ensureReferenceAnalysis?: (receipt: { ok: boolean; [key: string]: unknown }) => Promise<{ ok: boolean; [key: string]: unknown }>;
  ensureReferenceFacts?: (targetKey: string, signal?: AbortSignal) => Promise<{ ok: boolean; [key: string]: unknown }>;
}

/** Direct callers use the same schema as SDK admission and persisted compilation. */
function selectorShapeError(value: unknown, schema: TSchema): ToolResponse | undefined {
  if (Check(schema, value)) return undefined;
  const issues = targetSelectorSchemaIssues(value, schema);
  return {
    ok: false, terminal: false, error: "selector_draft_shape_invalid",
    issue_owner: "selector_input_error", durable_mutation: false, budget_consumed: false,
    issue_count: issues.length, selector_issues: issues.slice(0, 8),
    next_tool: "stage_target_selector_draft",
    instruction: "本次未保存草稿或来源登记。按返回的 actual、expected、constraint 和作者端可写路径修正；完整契约见 get_target_selector_contract。保留其他正确记录、原操作及删除意图后重试完整补丁，不要修改编译产物。只展示前八条诊断，但会检查全部字段。",
  };
}

function selectorDraftPlacementError(raw: unknown): ToolResponse | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const patch = raw as Record<string, any>;
  const common = { ok: false, terminal: false, durable_mutation: false, budget_consumed: false,
    next_tool: "stage_target_selector_draft" } as const;
  const misplacedCollections = Object.keys(TARGET_SELECTOR_DRAFT_JSON_SCHEMA.properties)
    .filter(collection => Object.hasOwn(patch, collection));
  if (misplacedCollections.length) return {
    ...common, error: "selector_draft_collection_misplaced",
    selector_issues: misplacedCollections.map(collection => ({
      code: "selector_draft_collection_misplaced", path: `/${collection}`,
      message: `${collection} 是草稿集合，不能位于工具参数顶层；应写入 draft.${collection}。`,
      details: {
        actual_path: `/${collection}`, writable_path: `/draft/${collection}`,
        required_action: "将集合移入 draft；若两处均有记录，按 key 核对并显式合并，保留两处原本要提交的有效记录",
        do_not_edit: "不可变原文、编译产物及其他已正确的集合；本次未保存任何草稿或来源登记",
        next_tool: "stage_target_selector_draft",
      },
    })),
    instruction: "本工具的参数嵌套固定：lots、items、sampling_rules、references、source_dispositions、residual_source_dispositions 都只能放在 draft 内；业务参数顶层只允许 operation、draft_fingerprint、reference_selections、draft、quote_bindings、collection、remove_keys。引用字段选择使用 reference_selections 与当前 draft_fingerprint 独立调用，不与 draft/remove_keys/replace_collection 混用。来源所属目标由程序绑定当前工具会话；直接使用当前回条中的短句柄，不传 source_handle_scope，也不放进 draft。本次未保存草稿或来源登记。将报错集合移入 draft，重新提交完整记录。保留 operation、collection、remove_keys、quote_bindings 和其他正确字段：本次被拒绝调用的任何修改都未生效。若有 remove_keys，本次只提交它声明的集合，其他集合另次提交。不得丢弃原删除意图，也不得删除正确记录来消除报错。",
  };
  const items: unknown[] = Array.isArray(patch.draft?.items) ? patch.draft.items : [];
  const misplaced = items.flatMap((item, index) => item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "reference_span_ids")
    ? [{ index, value: (item as any).reference_span_ids, hasTable: Boolean((item as any).table) }] : []);
  if (misplaced.length) return {
    ...common, error: "selector_item_reference_spans_misplaced",
    selector_issues: misplaced.map(({ index, value, hasTable }) => ({
      code: "selector_item_reference_spans_misplaced", path: `/draft/items/${index}/reference_span_ids`,
      message: "reference_span_ids 不属于 item 顶层；它只属于该 item 的 typed table。",
      details: {
        actual: value,
        how_to_pass: hasTable
          ? `删除 /draft/items/${index}/reference_span_ids；表格引用锚点放到 /draft/items/${index}/table/reference_span_ids，并确保 table.reason 非空。`
          : `删除 /draft/items/${index}/reference_span_ids。非表格正文引用保留 table=null，在 /draft/references 按契约填写锚点、目标来源、原字段和接收字段；不要虚构表格或把整个引用内容塞入第一个项目。`,
        writable_path: hasTable ? `/draft/items/${index}/table/reference_span_ids` : "/draft/references",
        remove_path: `/draft/items/${index}/reference_span_ids`, next_tool: "stage_target_selector_draft",
      },
    })),
    instruction: "草稿未保存。删除 item 顶层 reference_span_ids。表格来源的引用 span 放入 item.table.reference_span_ids；非表格正文引用保留 table=null，用 draft.references 的 anchor_span_ids、target_span_ids、origin_binding 和 destinations 按引用契约绑定，不得为容纳该字段虚构 table。保留其他正确字段，不要留下顶层重复字段。",
  };
}

export function createPiTools(controller: ToolController, hooks: PiToolHooks = {}): ToolDefinition[] {
  const getTargetContext = defineTool({
    name: "get_target_context",
    label: "读取精简目标上下文",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["get_target_context"]!,
    parameters: Type.Object({
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      discovery_context_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "发现阶段共同线索目录的独立游标；按 next_context_page 翻页，不读取正文或重检。" })),
      discovery_context_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      component_plan_occurrence_id: Type.Optional(Type.String({ minLength: 1, description: "读取模型自己保存的该引用组件计划；不替模型选择适用关系。" })),
      component_plan_cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      field_diagnostic_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "当前字段诊断游标。旧快照失效或尚无诊断时从 0 开始；不提交、不消耗完整检查次数。" })),
      field_diagnostic_fingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "翻页或详情时复制返回的输入指纹，防止旧游标误指当前字段。" })),
      field_diagnostic_detail_mode: Type.Optional(Type.Literal("full", { description: "与字段游标、输入指纹同用，只读该条完整诊断。" })),
      source_repair_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "恢复来源诊断的独立游标。按 next_diagnostic_page 读取；0 重新读取当前列表，不是资源 cursor，不消耗阶段检查次数。" })),
      source_repair_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SELECTOR_TOOL_ISSUE_PAGE_MAX_COUNT })),
      stage_diagnostic_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "已执行阶段检查的独立诊断游标。按 next_diagnostic_page 翻页，不重新校验；检查输入改变后旧完整诊断明确失效。历史无完整快照时只返回部分摘要并标明。" })),
      saved_diagnostic_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "大型保存回条的完整诊断游标；从 local_validation.saved_diagnostic_page 或 next_diagnostic_page 原样复制参数，不作完整阶段检查。" })),
      saved_diagnostic_scope: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("deferred")], { description: "与 saved_diagnostic_cursor 同用；local 为触及记录诊断，deferred 为同次保存的非局部诊断。" })),
      diagnostic_detail_key: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "长诊断数组快照键；只从 diagnostic_array_pages.next_page 原样复制，与 path/cursor 同用。" })),
      diagnostic_detail_path: Type.Optional(Type.String({ minLength: 1, description: "同一诊断长数组的路径；只从 next_page 复制，不是文件路径。" })),
      diagnostic_detail_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "长数组的独立游标；只读完整后续条目，不读取原文、不校验、不清除问题。" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("get_target_context", params as Record<string, unknown>, toolCallId)),
  });
  const listEvidenceResources = defineTool({
    name: "list_evidence_resources",
    label: "列出证据资源",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_evidence_resources"]!,
    parameters: Type.Object({
      context_for_evidence_id: Type.Optional(Type.String({ minLength: 1 })),
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("list_evidence_resources", params as Record<string, unknown>, toolCallId)),
  });
  const listGlobalDocumentResources = defineTool({
    name: "list_global_document_resources", label: "读取全文资源目录",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_global_document_resources"]!,
    parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) => resultContent(await controller.dispatch("list_global_document_resources", params as Record<string, unknown>, toolCallId)),
  });
  const searchGlobalDocumentResources = defineTool({
    name: "search_global_document_resources",
    label: "检索全文资源",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["search_global_document_resources"]!,
    parameters: Type.Object({ query: Type.String({ minLength: 2 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("search_global_document_resources", params as Record<string, unknown>, toolCallId)),
  });
  const openGlobalDocumentResource = defineTool({
    name: "open_global_document_resource",
    label: "打开全文资源",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["open_global_document_resource"]!,
    parameters: Type.Object({ atom_id: Type.String() }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("open_global_document_resource", params as Record<string, unknown>, toolCallId)),
  });
  const openAdjacentDocumentResource = defineTool({
    name: "open_adjacent_document_resource",
    label: "打开相邻全文资源",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["open_adjacent_document_resource"]!,
    parameters: Type.Object({
      atom_id: Type.String(),
      direction: Type.Union([Type.Literal("previous"), Type.Literal("next")]),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("open_adjacent_document_resource", params as Record<string, unknown>, toolCallId)),
  });
  const registerExternalDependency = defineTool({
    name: "register_external_dependency",
    label: "登记范围外依赖",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["register_external_dependency"]!,
    parameters: Type.Object({
      atom_id: Type.String(),
      mode: Type.Union([Type.Literal("dependency"), Type.Literal("scope_extension")]),
      reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("register_external_dependency", params as Record<string, unknown>, toolCallId)),
  });
  const resolveDocumentReference = defineTool({
    name: "resolve_document_reference",
    label: "解析文档引用",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["resolve_document_reference"]!,
    parameters: Type.Object({
      ...REFERENCE_CORRECTION_FIELDS,
      origin_span_id: Type.Optional(Type.String({ minLength: 1, description: "旧单 span 输入：包含当前引用成员的已登记来源 span_id。" })),
      origin_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 3, uniqueItems: true, description: "组合引用各段的来源 span，必须按原文顺序排列。" })),
      origin_field: Type.Union([
        Type.Literal("name"),
        Type.Literal("requirement"),
        Type.Literal("method"),
        Type.Literal("quantity"),
        Type.Literal("note"),
        Type.Literal("sampling"),
      ], { description: "本次引用字面量实际所在的唯一业务字段。该字段是后续编译和 Coverage 的权威路由；不得因为被引条款还含其他字段而扩大。" }),
      reference_literal_span_id: Type.Optional(Type.String({ minLength: 1, description: "只覆盖当前单个引用成员的精确 literal span_id；不得覆盖并列引用列表或猜测位置。" })),
      reference_literal_span_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 3, uniqueItems: true, description: "同一引用被换行拆开时，按来源顺序提供 2～3 个精确 literal span；同 clause、邻接与唯一匹配由程序校验。" })),
      raw_reference: Type.String({ minLength: 1, description: "只填写当前单个 target 对应的最小逐字引用片段；不得填写包含其他并列成员的完整列表。" }),
      normalized_reference: Type.Optional(Type.String({ minLength: 1, description: "组合引用的规范化显示值；与有序 literal fragments 分离，只能规范空白/排版，不能改写字符或目标。" })),
      target: Type.Object({
        kind: Type.Union([Type.Literal("clause"), Type.Literal("section"), Type.Literal("table"), Type.Literal("appendix")]),
        number: Type.String({ minLength: 1, description: "当前文档中的条、节、表或附录编号。" }),
        paragraph: Type.Optional(Type.String({ minLength: 1 })),
        candidate_start_line: Type.Optional(Type.Integer({ minimum: 1 })),
      }, { additionalProperties: false, description: "单数对象，只描述当前文档中的一个精确目标；并列成员必须分别调用。" }),
      relation: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      const receipt = await controller.dispatch("resolve_document_reference", params as Record<string, unknown>, toolCallId);
      const output = receipt.ok === true && hooks.ensureReferenceAnalysis
        ? await hooks.ensureReferenceAnalysis(receipt)
        : receipt;
      return resultContent(output);
    },
  });
  const getTargetSelectorContract = defineTool({
    name: "get_target_selector_contract",
    label: "读取目标选择器契约",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["get_target_selector_contract"]!,
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("get_target_selector_contract", params as Record<string, unknown>, toolCallId)),
  });
  const getPlanContract = defineTool({
    name: "get_plan_contract",
    label: "读取计划契约",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["get_plan_contract"]!,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("get_plan_contract", params as Record<string, unknown>, toolCallId)),
  });
  const listTableFragments = defineTool({
    name: "list_table_fragments",
    label: "列出物理表格片段",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_table_fragments"]!,
    parameters: Type.Object({ cursor: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("list_table_fragments", params as Record<string, unknown>, toolCallId)),
  });
  const readTableSummary = defineTool({
    name: "read_table_summary",
    label: "读取逻辑表摘要",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_table_summary"]!,
    parameters: Type.Object({ table_key: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_table_summary", params as Record<string, unknown>, toolCallId)),
  });
  const readTableRows = defineTool({
    name: "read_table_rows",
    label: "分页读取表格行",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_table_rows"]!,
    parameters: Type.Object({
      table_key: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_table_rows", params as Record<string, unknown>, toolCallId)),
  });
  const readAdjacentSource = defineTool({
    name: "read_adjacent_source",
    label: "读取表格相邻来源",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_adjacent_source"]!,
    parameters: Type.Object({
      fragment_id: Type.String({ minLength: 1 }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_adjacent_source", params as Record<string, unknown>, toolCallId)),
  });
  const readSavedTableStructure = defineTool({
    name: "read_saved_table_structure",
    label: "读取已保存表结构",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_saved_table_structure"]!,
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_saved_table_structure", params as Record<string, unknown>, toolCallId)),
  });
  const stageTableStructure = defineTool({
    name: "stage_table_structure",
    label: "暂存表结构决定",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["stage_table_structure"]!,
    parameters: Type.Object({
      table: Type.Object({
        table_key: Type.String({ minLength: 1 }),
        status: Type.Union([Type.Literal("review"), Type.Literal("confirmed")]),
        source_version: Type.String({ minLength: 1 }),
        formal_title_span_ids: Type.Array(Type.String(), { uniqueItems: true }),
        fragment_ids: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
        header_rows: Type.Array(Type.String(), { uniqueItems: true }),
        data_rows: Type.Array(Type.String(), { uniqueItems: true }),
        repeated_header_rows: Type.Array(Type.String(), { uniqueItems: true }),
        note_rows: Type.Array(Type.String(), { uniqueItems: true, description: "表注所在的原文行，填写 evidence handle（eN）；不要填写 span handle。" }),
        context_rows: Type.Array(Type.String(), { uniqueItems: true }),
        review_rows: Type.Array(Type.String(), { uniqueItems: true }),
        row_role_overrides: Type.Array(Type.Object({
          row_id: Type.String({ minLength: 1 }),
          program_hint: Type.Union([Type.Literal("header_candidate"), Type.Literal("data_candidate"), Type.Literal("context_candidate")]),
          selected_role: Type.Union([Type.Literal("header"), Type.Literal("data"), Type.Literal("repeated_header"), Type.Literal("note"), Type.Literal("context")]),
          reason: Type.String({ minLength: 1 }),
        }, { additionalProperties: false }), { uniqueItems: true }),
        continuation_caption_span_ids: Type.Array(Type.String(), { uniqueItems: true }),
        note_span_ids: Type.Array(Type.String(), { uniqueItems: true, description: "表注的精确文字范围，填写 span handle（sN）；不要填写 evidence handle。" }),
        reason: Type.String(),
      }, { additionalProperties: false }),
      remove_table_keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, uniqueItems: true })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("stage_table_structure", params as Record<string, unknown>, toolCallId)),
  });
  const listSamplingRules = defineTool({
    name: "list_sampling_rules",
    label: "列出抽样规则",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_sampling_rules"]!,
    parameters: Type.Object({ cursor: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("list_sampling_rules", params as Record<string, unknown>, toolCallId)),
  });
  const listReferenceOccurrences = defineTool({
    name: "list_reference_occurrences",
    label: "列出引用出现位置",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["list_reference_occurrences"]!,
    parameters: Type.Object({
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      candidate_cursor: Type.Optional(Type.Number({ minimum: 0 })),
      candidate_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("list_reference_occurrences", params as Record<string, unknown>, toolCallId)),
  });
  const openEvidence = defineTool({
    name: "open_evidence",
    label: "打开证据",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["open_evidence"]!,
    parameters: Type.Object({
      evidence_id: Type.String(),
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("open_evidence", params, toolCallId)),
  });
  const readDocumentReferenceEvidence = defineTool({
    name: "read_document_reference_evidence",
    label: "读取文档引用证据目录",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_document_reference_evidence"]!,
    parameters: Type.Object({
      target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description: "从本会话公开工具回条中已登记并明确返回的 target_key 原样复制；不得填写 target_fingerprint。" }),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_document_reference_evidence", params as Record<string, unknown>, toolCallId)),
  });
  const readReferenceFacts = defineTool({
    name: "read_reference_facts",
    label: "读取引用目录",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_reference_facts"]!,
    parameters: Type.Object({
      target_key: Type.String({ pattern: "^reference-target:[a-f0-9]{64}$", description: "从本会话公开工具回条中已登记并明确返回的 target_key 原样复制；不得填写 target_fingerprint。" }),
      evidence_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 24,
        description: "诊断已点名证据时，定位它们所在的目录条目和行。只与 target_key 同传；返回导航后按 next_tool_arguments 读正文，不代表已读或已判断适用性。" })),
      row_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "仅用于继续单一条目正文；传入非零值时 entry_ids 必须恰好一项，并原样使用上一回条的 next_row_cursor。" })),
      row_offset: Type.Optional(Type.Integer({ minimum: 0, description: "仅用于继续单一条目当前行；传入非零值时 entry_ids 必须恰好一项，并原样使用上一回条的 next_row_offset。" })),
      catalog_cursor: Type.Optional(Type.Integer({ minimum: 0, description: "仅用于目录翻页，与正文 row_cursor、row_offset 独立；原样使用上一回条的 next_catalog_cursor。" })),
      entry_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 32,
        description: "要打开的目录 entry_id；仅选择当前目标验收项目实际需要的条目。继续正文分页时只能保留一个 entry_id；同时打开多项时省略 row_cursor、row_offset，从各项开头读取。",
      })),
      skip: Type.Optional(Type.Array(Type.Object({
        entry_id: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1, description: "说明此条目为何与当前目标无关。" }),
      }, { additionalProperties: false }), { maxItems: 64 })),
      skip_rest: Type.Optional(Type.Object({
        reason: Type.String({ minLength: 1, description: "用一个共同理由说明所有未打开条目为何不适用，优先采用此方式而不是逐条列出。" }),
      }, {
        additionalProperties: false,
        description: "用一个共同理由处置 entry_ids 未列出的所有条目；仅少数条目适用时可减少调用。",
      })),
      resolve_rows: Type.Optional(Type.Array(Type.Object({
        entry_id: Type.String({ minLength: 1 }),
        row_index: Type.Integer({ minimum: 0 }),
      }, { additionalProperties: false }), {
        maxItems: 24,
        description: "再次取得此前已打开行的 evidence_id 和已核验整行 span_id。新打开的完整行会自动返回这对句柄；引用整行不需再次定位，但不能把整行作为单独的单位、数值或方法字段。",
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const targetKey = String((params as Record<string, unknown>).target_key ?? "");
      let output = await controller.dispatch("read_reference_facts", params as Record<string, unknown>, toolCallId, signal);
      if (output.error === "reference_analysis_not_sealed" && hooks.ensureReferenceFacts) {
        const analysis = await hooks.ensureReferenceFacts(targetKey, signal);
        output = await controller.dispatch("read_reference_facts", params as Record<string, unknown>, toolCallId, signal);
        if (output.ok !== true) output = { ...output, analysis };
      }
      return resultContent(output);
    },
  });
  const searchEvidence = defineTool({
    name: "search_evidence",
    label: "检索证据",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["search_evidence"]!,
    parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("search_evidence", params, toolCallId)),
  });
  const readPlan = defineTool({
    name: "read_working_plan",
    label: "读取工作计划",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_working_plan"]!,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_working_plan", params as Record<string, unknown>, toolCallId)),
  });
  const sourceFragmentsInput = Type.Array(Type.Object({
    evidence_id: Type.String(),
    text: Type.String(),
  }));
  const nameFieldInput = Type.Object({
    value: Type.String(),
    composition: Type.Union([
      Type.Literal("verbatim"),
      Type.Literal("semantic_summary"),
      Type.Literal("shared_inheritance"),
      Type.Literal("reference"),
      Type.Literal("not_applicable"),
    ]),
    source_fragments: sourceFragmentsInput,
    reason: Type.String(),
  });
  const batchOpenEvidence = defineTool({
    name: "batch_open_evidence",
    label: "批量打开证据",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_open_evidence"]!,
    parameters: Type.Object({ evidence_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("batch_open_evidence", params as Record<string, unknown>, toolCallId)),
  });
  const batchSearchEvidence = defineTool({
    name: "batch_search_evidence",
    label: "批量检索证据",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_search_evidence"]!,
    parameters: Type.Object({ queries: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("batch_search_evidence", params as Record<string, unknown>, toolCallId)),
  });
  const locateEvidenceSpan = defineTool({
    name: "locate_evidence_span",
    label: "定位精确证据片段",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["locate_evidence_span"]!,
    parameters: Type.Object({
      evidence_id: Type.String(),
      quote: Type.String({ minLength: 1 }),
      prefix: Type.Optional(Type.String()),
      suffix: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("locate_evidence_span", params, toolCallId)),
  });
  const batchLocateEvidenceSpans = defineTool({
    name: "batch_locate_evidence_spans",
    label: "批量定位精确证据片段",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["batch_locate_evidence_spans"]!,
    parameters: Type.Object({
      requests: Type.Array(Type.Object({
        evidence_id: Type.String(),
        quote: Type.String({ minLength: 1 }),
        prefix: Type.Optional(Type.String()),
        suffix: Type.Optional(Type.String()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_LOCATE_REQUESTS }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("batch_locate_evidence_spans", params as Record<string, unknown>, toolCallId)),
  });
  const readSelectors = defineTool({
    name: "read_target_selectors",
    label: "读取目标选择器",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_target_selectors"]!,
    parameters: Type.Object({
      collection: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      evidence_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100,
        description: "仅在 collection=source_dispositions 时填写；读取 items、sampling_rules、references、lots 等其他集合时省略此参数。" })),
      cursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_target_selectors", params as Record<string, unknown>, toolCallId)),
  });
  const readSelectorIssues = defineTool({
    name: "read_target_selector_issues", label: "读取选择器问题详情",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_target_selector_issues"]!,
    parameters: Type.Object({ draft_fingerprint: Type.String(),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })), issue_key: Type.Optional(Type.String()),
      detail_mode: Type.Optional(Type.Union([Type.Literal("fields"), Type.Literal("full")])),
      include_blocker_handoff: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (id, params) => resultContent(await controller.dispatch("read_target_selector_issues", params, id)),
  });
  const replaceSelectors = defineTool({
    name: "replace_target_selectors",
    label: "替换初始目标选择器",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["replace_target_selectors"]!,
    parameters: Type.Object({ content: Type.String() }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("replace_target_selectors", params, toolCallId)),
  });
  const patchSelectors = defineTool({
    name: "patch_target_selectors",
    label: "修订目标选择器",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["patch_target_selectors"]!,
    parameters: Type.Object({
      operations: Type.Array(Type.Object({
        op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
        path: Type.String(),
        value: Type.Optional(Type.Unknown()),
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("patch_target_selectors", params, toolCallId)),
  });
  const stageSelectorDraft = defineTool({
    name: "stage_target_selector_draft",
    label: "暂存结构化选择器草稿",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["stage_target_selector_draft"]!,
    parameters: TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA,
    prepareArguments(args) {
      const error = selectorDraftPlacementError(args);
      if (error) throw new Error(JSON.stringify({ ...error, mutation_receipt: selectorPatchReceipt(args, "not_applied") }));
      return args as Static<typeof TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA>;
    },
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("stage_target_selector_draft", params as Record<string, unknown>, toolCallId)),
  });
  const advanceSelectorStage = defineTool({
    name: "advance_target_selector_stage",
    label: "推进选择器阶段",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["advance_target_selector_stage"]!,
    parameters: Type.Object({
      next_stage: Type.Union([Type.Literal("sampling"), Type.Literal("table"), Type.Literal("commit")]),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("advance_target_selector_stage", params as Record<string, unknown>, toolCallId)),
  });
  const commitSelectorDraft = defineTool({
    name: "commit_target_selector_draft",
    label: "提交选择器草稿指纹",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["commit_target_selector_draft"]!,
    parameters: Type.Object({
      draft_fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("commit_target_selector_draft", params as Record<string, unknown>, toolCallId)),
  });
  const reportTargetBlocker = defineTool({
    name: "report_target_blocker",
    label: "报告有证据的目标阻塞",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["report_target_blocker"]!,
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("missing_external_source"),
        Type.Literal("ambiguous_source"),
        Type.Literal("scope_extension_required"),
        Type.Literal("harness_contract_defect"),
        Type.Literal("frozen_scope_conflict"),
      ]),
      evidence_span_ids: Type.Array(Type.String({ pattern: SOURCE_SPAN_ID_PATTERN }), { minItems: 1, maxItems: 8 }),
      affected_selector_paths: Type.Array(Type.String({ pattern: "^/" }), { minItems: 1, maxItems: 8 }),
      finding_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8, uniqueItems: true })),
      preflight_issue_fingerprint: Type.Optional(Type.String({ minLength: 1 })),
      explanation: Type.String({ minLength: 8 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("report_target_blocker", params as Record<string, unknown>, toolCallId)),
  });
  const losslessFieldInput = Type.Object({
    value: Type.String(),
    composition: Type.Union([
      Type.Literal("verbatim"),
      Type.Literal("shared_inheritance"),
      Type.Literal("reference"),
      Type.Literal("not_applicable"),
    ]),
    source_fragments: sourceFragmentsInput,
    reason: Type.String(),
  });
  const prepareFieldBindings = defineTool({
    name: "prepare_field_bindings",
    label: "准备精确字段绑定",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["prepare_field_bindings"]!,
    parameters: Type.Object({
      fields: Type.Object({
        name: nameFieldInput,
        requirement: losslessFieldInput,
        method: losslessFieldInput,
        quantity: losslessFieldInput,
        note: losslessFieldInput,
      }),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("prepare_field_bindings", params, toolCallId)),
  });
  const replacePlan = defineTool({
    name: "replace_working_plan",
    label: "替换工作计划",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["replace_working_plan"]!,
    parameters: Type.Object({ content: Type.String() }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("replace_working_plan", params, toolCallId)),
  });
  const patchPlan = defineTool({
    name: "patch_working_plan",
    label: "修订工作计划",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["patch_working_plan"]!,
    parameters: Type.Object({
      operations: Type.Array(Type.Object({
        op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
        path: Type.String(),
        value: Type.Optional(Type.Unknown()),
      })),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("patch_working_plan", params, toolCallId)),
  });
  const readCoverageReview = defineTool({
    name: "read_coverage_review",
    label: "读取独立覆盖复核",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_coverage_review"]!,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("read_coverage_review", params as Record<string, unknown>, toolCallId)),
  });
  const reconcileEvidenceDispositions = defineTool({
    name: "reconcile_evidence_dispositions",
    label: "核对证据覆盖",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["reconcile_evidence_dispositions"]!,
    parameters: Type.Object({
      decisions: Type.Optional(Type.Array(Type.Object({
        evidence_id: Type.String(),
        disposition: Type.Union([Type.Literal("context"), Type.Literal("ignored")]),
        reason: Type.String(),
      }))),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("reconcile_evidence_dispositions", params, toolCallId)),
  });
  const applyTableAssembly = defineTool({
    name: "apply_table_assembly",
    label: "应用语义表格组装",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["apply_table_assembly"]!,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("apply_table_assembly", params as Record<string, unknown>, toolCallId)),
  });
  const validatePlan = defineTool({
    name: "validate_working_plan",
    label: "验证工作计划",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["validate_working_plan"]!,
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("validate_working_plan", params as Record<string, unknown>, toolCallId)),
  });
  const sealPlan = defineTool({
    name: "seal_validated_plan",
    label: "封存已验证计划",
    description: ACCEPTANCE_TOOL_DESCRIPTIONS["seal_validated_plan"]!,
    parameters: Type.Object({ fingerprint: Type.String() }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, params) =>
      resultContent(await controller.dispatch("seal_validated_plan", params, toolCallId)),
  });
  if (controller.usesSelectorCompiler) {
    return [
      defineTool({ name: "stage_reference_component_decisions", label: "保存引用组件处置", description: ACCEPTANCE_TOOL_DESCRIPTIONS["stage_reference_component_decisions"]!,
        parameters: REFERENCE_COMPONENT_EDIT_INPUT, executionMode: "sequential",
        execute: async (id, params) => resultContent(await controller.dispatch("stage_reference_component_decisions", params, id)) }),
      defineTool({ name: "save_target_component_plan", label: "保存模型组件处理计划", description: ACCEPTANCE_TOOL_DESCRIPTIONS["save_target_component_plan"]!,
        parameters: COMPONENT_PLAN_INPUT, executionMode: "sequential",
        execute: async (id, params) => resultContent(await controller.dispatch("save_target_component_plan", params, id)) }),
      defineTool({ name: "save_target_investigation", label: "保存调查交接", description: ACCEPTANCE_TOOL_DESCRIPTIONS["save_target_investigation"]!, parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 3000 }), evidence_ids: Type.Array(Type.String(), { maxItems: 24, description: INVESTIGATION_KEY_SOURCE_GUIDANCE }), next_steps: Type.String({ maxLength: 1500 }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (id, params) => resultContent(await controller.dispatch("save_target_investigation", params, id)) }),
      getTargetContext,
      getTargetSelectorContract,
      listEvidenceResources,
      listGlobalDocumentResources,
      searchGlobalDocumentResources,
      openGlobalDocumentResource,
      openAdjacentDocumentResource,
      registerExternalDependency,
      resolveDocumentReference,
      ...(controller.externalSourceWorkflow ? [createExternalStandardReferenceTool((input, id) => controller.dispatch("resolve_external_standard_reference", input, id))] : []),
      listTableFragments,
      readTableSummary,
      readTableRows,
      readAdjacentSource,
      readSavedTableStructure,
      stageTableStructure,
      listSamplingRules,
      listReferenceOccurrences,
      readDocumentReferenceEvidence,
      readReferenceFacts,
      openEvidence,
      searchEvidence,
      batchOpenEvidence,
      batchSearchEvidence,
      locateEvidenceSpan,
      batchLocateEvidenceSpans,
      readSelectors,
      readSelectorIssues,
      readCoverageReview,
      stageSelectorDraft,
      advanceSelectorStage,
      commitSelectorDraft,
      reportTargetBlocker,
      sealPlan,
    ].map(replaceAcceptanceToolText);
  }
  return [
    getPlanContract,
    resolveDocumentReference,
    ...(controller.externalSourceWorkflow ? [createExternalStandardReferenceTool((input, id) => controller.dispatch("resolve_external_standard_reference", input, id))] : []),
    listTableFragments,
    readTableSummary,
    readTableRows,
    readAdjacentSource,
    readSavedTableStructure,
    stageTableStructure,
    listSamplingRules,
    listReferenceOccurrences,
    readDocumentReferenceEvidence,
    readReferenceFacts,
    openEvidence,
    searchEvidence,
    readPlan,
    readCoverageReview,
    prepareFieldBindings,
    replacePlan,
    patchPlan,
    reconcileEvidenceDispositions,
    applyTableAssembly,
    validatePlan,
    sealPlan,
  ].map(replaceAcceptanceToolText);
}

export function validFixturePlan(manifest: EvidenceManifest): SemanticSourcePlan {
  const formalContract = buildPlanContract(
    manifest,
    confirmProvisionalTableAssembly(manifest),
  );
  if (formalContract.formal_rows.length) {
    return formalContract.plan_template;
  }
  const dispositionRequired = manifest.evidence.filter(evidenceRequiresSelectorDisposition);
  const required = dispositionRequired.length
    ? dispositionRequired
    : manifest.evidence.filter((record) => record.evidence_scope === "primary");
  const headings = manifest.evidence.filter((record) => record.kind === "heading");
  const texts = required.map((record) =>
    record.text.replace(/^[-*+]\s+/, "").trim(),
  );
  const itemId = "item-1";
  const plan: SemanticSourcePlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: buildInitialTableAssembly(manifest),
    inspection_lots: [{
      lot_id: "lot-1",
      name: `验收批 ${manifest.target_id}`,
      evidence_ids: headings.map((record) => record.evidence_id),
      item_ids: [itemId],
    }],
    acceptance_items: [{
      item_id: itemId,
      lot_id: "lot-1",
      name: texts[0]?.replace(/[。；].*$/, "") || "验收项目",
      category: "主控项目",
      requirement: texts[0] ?? "",
      method: texts[1] ?? "",
      quantity: texts[2] ?? "",
      note: "",
      evidence_ids: required.map((record) => record.evidence_id),
      reference_evidence_ids: [],
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "离线 fixture 不执行专业领域分类，保留为待复核。",
      inspection_data_type_evidence_ids: required.map((record) => record.evidence_id),
      field_bindings: buildItemFieldBindings(
        {
          name: texts[0]?.replace(/[。；].*$/, "") || "验收项目",
          requirement: texts[0] ?? "",
          method: texts[1] ?? "",
          quantity: texts[2] ?? "",
          note: "",
        },
        required.map((record) => record.evidence_id),
        manifest,
      ),
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "离线 Stage-1-like fixture 未提供抽样规则。",
        reason: "该 fixture 仅验证受限编辑、校验与封存流程。",
        confidence: 1,
        evidence_ids: [],
      },
    }],
    reference_resolutions: [],
    evidence_dispositions: required.map((record) => ({
      evidence_id: record.evidence_id,
      disposition: "used",
      item_ids: [itemId],
      reason: "用于验收项目字段物化",
    })),
  };
  if (manifest.source.semantic_workflow) {
    const selectedIds = manifest.scope.selected_atom_ids?.length
      ? manifest.scope.selected_atom_ids
      : required.slice(0, 1).map((record) => record.evidence_id);
    const selectedRecords = selectedIds.flatMap((evidenceId) => {
      const record = manifest.evidence.find((candidate) =>
        candidate.evidence_id === evidenceId
      );
      return record ? [record] : [];
    });
    const semanticRecords = selectedRecords.length
      ? selectedRecords
      : manifest.evidence.filter((record) =>
          record.evidence_scope === "primary" || record.requires_disposition
        );
    const rootSemanticId = "semantic:fixture-item";
    plan.semantic_evidence = semanticRecords.map((record, index) => ({
      semantic_id: index === 0 ? rootSemanticId : `semantic:fixture-continuation:${index}`,
      role: index === 0 ? "acceptance_item" as const : "continuation" as const,
      evidence_id: record.evidence_id,
      exact_fragment: record.text,
      parent_semantic_id: index === 0 ? "" : rootSemanticId,
      materialized_item_id: itemId,
      reason: index === 0
        ? "离线 fixture 的验收项目语义"
        : "离线 fixture 中并入同一项目的后续语义",
    }));
    plan.semantic_references = [];
    plan.shared_sampling_rules = [];
  }
  return plan;
}

export async function runOfflineFixture(
  workspace: RevisionWorkspace,
  controller: ToolController,
): Promise<ToolResponse> {
  await workspace.setRuntime({
    kind: "offline-scripted",
    session_id: `offline-revision-${workspace.revision}`,
    session_file: workspace.transcriptPath,
  });
  await workspace.appendEvent("agent_run_start", {
    mode: "offline-scripted",
    truthful_runtime: "Deterministic scripted agent exercising the same constrained tools; not an LLM transcript.",
  });
  let call = 1;
  for (const evidence of controller.evidence.evidence) {
    await controller.dispatch(
      "open_evidence",
      { evidence_id: evidence.evidence_id },
      `offline-${String(call++).padStart(4, "0")}`,
    );
  }
  const valid = validFixturePlan(controller.evidence);
  const invalid = structuredClone(valid);
  invalid.acceptance_items[0]!.name = "故意制造字段与来源绑定不一致";
  await controller.dispatch(
    "replace_working_plan",
    { content: prettyJson(invalid) },
    `offline-${String(call++).padStart(4, "0")}`,
  );
  const failed = await controller.dispatch(
    "validate_working_plan",
    {},
    `offline-${String(call++).padStart(4, "0")}`,
  );
  if (failed.ok) throw new Error("Offline fixture expected its first validation to fail");
  const repaired = await controller.dispatch(
    "patch_working_plan",
    {
      operations: [{
        op: "replace",
        path: "/acceptance_items/0/name",
        value: valid.acceptance_items[0]!.name,
      }],
    },
    `offline-${String(call++).padStart(4, "0")}`,
  );
  const passed = repaired.repair_validation as ToolResponse | undefined;
  if (!passed?.ok || typeof passed.fingerprint !== "string") {
    throw new Error("Offline fixture failed to produce a validated plan");
  }
  if (controller.evidence.source.adapter === "document-domain-agent/v1") {
    const reviewController = await CoverageReviewController.create(
      workspace,
      passed.fingerprint,
    );
    for (const evidence of controller.evidence.evidence) {
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: evidence.evidence_id,
      });
    }
    await reviewController.dispatch("replace_working_coverage_review", {
      content: prettyJson({
        schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
        plan_fingerprint: passed.fingerprint,
        evidence_fingerprint: controller.evidence.evidence_fingerprint,
        status: "approved",
        semantic_coverage: scriptedSemanticCoverage(valid, controller.evidence),
        findings: [],
        summary: "Deterministic offline fixture approval; live runs require an independent Agent review.",
      }),
    });
    const reviewValidation = await reviewController.dispatch("validate_coverage_review", {});
    if (!reviewValidation.ok || typeof reviewValidation.fingerprint !== "string") {
      throw new Error("Offline fixture failed to validate its scripted coverage review");
    }
    const reviewSeal = await reviewController.dispatch("seal_coverage_review", {
      fingerprint: reviewValidation.fingerprint,
    });
    if (!reviewSeal.ok) throw new Error("Offline fixture failed to seal its scripted coverage review");
  }
  const sealed = await controller.dispatch(
    "seal_validated_plan",
    { fingerprint: passed.fingerprint },
    `offline-${String(call++).padStart(4, "0")}`,
  );
  await workspace.appendEvent("agent_run_end", {
    mode: "offline-scripted",
    sealed,
  });
  return sealed;
}

function scriptedSemanticCoverage(
  plan: SemanticSourcePlan,
  evidence: EvidenceManifest,
): SemanticCoverageDisposition[] {
  const finalItems = materialize(plan, evidence, sha256Json(plan)).result.inspection_lots.flatMap((lot) => lot.items);
  const rows: SemanticCoverageDisposition[] = finalItems.map((item, index) => {
    const sourceId = item.reference_origin_item_id || item.item_id;
    const nodes = (plan.semantic_evidence ?? []).filter((node) =>
      node.materialized_item_id === sourceId || node.materialized_item_id === item.item_id
    );
    const bindings = nodes.map((node) => ({ evidence_id: node.evidence_id, exact_fragment: node.exact_fragment }));
    if (bindings.length === 0) {
      const evidenceId = item.evidence_ids[0] ?? item.reference_evidence_ids[0];
      const record = evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      if (record) bindings.push({ evidence_id: record.evidence_id, exact_fragment: record.text });
    }
    return {
      coverage_id: `offline-leaf:${index + 1}`,
      disposition: "acceptance_item",
      judgment_id: `judgment:${item.item_id}`,
      item_ids: [item.item_id],
      evidence_bindings: bindings,
      reason: "Offline fixture binds all exact semantic fragments to this final leaf.",
    };
  });
  const obligations = coverageReviewObligations(evidence, plan);
  for (const evidenceId of obligations.uncovered_primary_evidence_ids) {
    const record = evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (!record) continue;
    rows.push({
      coverage_id: `offline-irrelevant:${rows.length + 1}`,
      disposition: "irrelevant",
      judgment_id: "",
      item_ids: [],
      evidence_bindings: [{ evidence_id: record.evidence_id, exact_fragment: record.text }],
      reason: "Offline fixture explicitly disposes non-business boundary evidence.",
    });
  }
  return rows;
}
