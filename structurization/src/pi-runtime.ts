import { preflightContinuationPrompt } from "./acceptance-prompt-suite.js";
import { installSelectorSessionContractBoundary, selectorSessionContractContext } from "./selector-session-contract.js";
import { targetLengthContinuationPrompt, targetCompletedContinuationPrompt, discoveryStartupPrompt, hierarchyStartupPrompt, referenceStartupPrompt, LEGACY_PLAN_PROTOCOL } from "./acceptance-prompt-suite.js";
import { LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE as prompt_LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE, LOSSLESS_BRANCH_ALTERNATIVES as prompt_LOSSLESS_BRANCH_ALTERNATIVES, SYSTEM_PROMPT as prompt_SYSTEM_PROMPT, TARGET_SELECTOR_SYSTEM_PROMPT as prompt_TARGET_SELECTOR_SYSTEM_PROMPT, targetRepairPrompt as prompt_targetRepairPrompt, targetSelectorStagePrompt as prompt_targetSelectorStagePrompt, targetSelectorStartupPrompt as prompt_targetSelectorStartupPrompt, DISCOVERY_SELECTOR_TRANSACTION_GUIDANCE as prompt_DISCOVERY_SELECTOR_TRANSACTION_GUIDANCE, DISCOVERY_SYSTEM_PROMPT as prompt_DISCOVERY_SYSTEM_PROMPT, DISCOVERY_REVIEW_SYSTEM_PROMPT as prompt_DISCOVERY_REVIEW_SYSTEM_PROMPT, COVERAGE_REVIEW_SYSTEM_PROMPT as prompt_COVERAGE_REVIEW_SYSTEM_PROMPT, COVERAGE_FINALIZATION_SYSTEM_PROMPT as prompt_COVERAGE_FINALIZATION_SYSTEM_PROMPT, HIERARCHY_CONFIRM_SYSTEM_PROMPT as prompt_HIERARCHY_CONFIRM_SYSTEM_PROMPT, HIERARCHY_SYSTEM_PROMPT as prompt_HIERARCHY_SYSTEM_PROMPT, HIERARCHY_REVIEW_SYSTEM_PROMPT as prompt_HIERARCHY_REVIEW_SYSTEM_PROMPT, DISCOVERY_CONTINUATION_PROMPT as prompt_DISCOVERY_CONTINUATION_PROMPT } from "./acceptance-prompt-suite.js";
import { appendFile } from "node:fs/promises";
import type { ExternalSourceRequest } from "./external-source-workflow.js";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCatalogOutputStream } from "./catalog-output-stream.js";
import { constrainedContextSettings, prepareConstrainedContext } from './constrained-context.js';
import { isModelStreamProtectionError, ModelStreamProgressGuard, createStreamRecoveryRunner, type StreamToolContract } from "./model-stream-progress.js";
import { ModelSourceHandles, SOURCE_HANDLE_INSTRUCTION, SOURCE_HANDLE_SESSION_ENTRY, sourceHandleSessionFileMatches, sourceHandleSessionMatches } from "./model-source-handles.js";
import { PiSessionTelemetry, withPiSessionTelemetry } from "./session-telemetry.js";
import { readPdfLayoutCache, verifiedPdfLayoutProfile, writePdfLayoutCache } from "./pdf-layout-cache.js";
import { DISCOVERY_SCOPE_SEMANTICS_GUIDANCE } from "./discovery-semantic-guidance.js";
import { migrateTargetSelectorPlan, targetSelectorFingerprint } from "./target-selector-compiler.js";
import { strictJsonParse } from "./strict-json.js";
import { documentSelectorFingerprint, type DocumentSelectorPlan } from "./document-selector-compiler.js";
import { findCurrentDiscoveryDraft } from "./discovery-pending-draft.js";

import { atomicWriteJson, pathExists, readJson } from "./atomic.js";
import { sha256Json, sha256Text } from "./canonical.js";
import { ACCEPTANCE_DELIVERY_CONTRACT, ACCEPTANCE_ORGANIZATION_GUIDANCE, INSPECTION_UNIT_GUIDANCE, ITEM_CATEGORY_GUIDANCE, ITEM_NAME_PATH_GUIDANCE, LOT_NAMING_GUIDANCE, MODEL_OUTPUT_LANGUAGE_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE, SELECTOR_PATCH_GUIDANCE, SELECTOR_SAMPLING_GUIDANCE } from "./acceptance-delivery-contract.js";
import {
  resolvePdfExCodePreset,
  resolvePdfExCodeProtocolPreset,
  deepseekModelCompatibility,
  museModelCompatibility,
  museToolParameters,
  type PiAgentModelSettings,
  type PiAgentEffort,
  type PiAgentModelStage,
  type PiAgentRuntimeModelConfig,
} from "./presets.js";
import {
  createPiTools,
  DIRECT_VALIDATION_PROTOCOL,
  type TargetSelectorCheckpointStatus,
  type TargetSelectorCurrentState,
  type ToolController,
} from "./tools.js";
import type { RevisionWorkspace } from "./workspace.js";
import {
  createDocumentDiscoveryTools,
  type DocumentDiscoveryController,
  type DocumentDiscoveryWorkspace,
} from "./document-discovery.js";
import {
  createEditorHierarchyTools,
  type EditorHierarchyController,
  type EditorHierarchyWorkspace,
  type HierarchyConfirmContext,
} from "./editor-hierarchy.js";
import {
  CoverageReviewController,
  createCoverageReviewTools,
  durableCoverageCandidateChangeReceipt,
  readSealedCoverageReview,
  type CoverageControllerRebuildReceipt,
  type CoverageReviewScope,
  type DomainCoverageReview,
} from "./coverage-review.js";
import {
  classifyTargetFailure,
  targetBlockerFailureClass,
  targetFailureClass,
  type TargetFailureClass,
} from "./attempt-budget.js";
import { repairStateOrDefault } from "./repair-convergence.js";
import {
  REFERENCE_ACTION_GUIDANCE_ZH,
} from "./reference-guidance.js";
import {
  createReferenceAnalysisTools,
  ReferenceAnalysisController,
  REFERENCE_ANALYSIS_SYSTEM_PROMPT,
  type ReferenceAnalysisSummary,
} from "./reference-analysis.js";
import {
  CATALOG_RULE_DISCOVERY_PROMPT_ZH,
  catalogRuleDiscoveryUserPrompt,
  catalogRulesProposalResult,
  createLocalToolTimeoutReason,
  isLocalToolTimeoutReason,
  type CatalogRuleAsk,
  type CatalogRuleRequest,
} from "./reference-catalog-discovery.js";
import type { ReferenceCatalogRules } from "./reference-catalog.js";
import type { EvidenceManifest, RevisionState } from "./contracts.js";
import {
  CatalogReviewRuntimeController,
  createCatalogReviewRuntimeTools,
  type CatalogReviewRuntimeDecision,
  type CatalogReviewRuntimeInput,
} from "./catalog-review-runtime.js";
import {
  CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT,
  createCatalogLeafExpansionTools,
  type CatalogLeafExpansionRuntimeInput,
} from "./catalog-leaf-expansion-runtime.js";
import {
  CATALOG_STRUCTURE_DISCOVERY_PROMPT,
  createCatalogStructureDiscoveryTools,
  type CatalogStructureDiscoveryRuntimeInput,
} from "./catalog-structure-discovery-runtime.js";
import { catalogAutonomousPromptFor, catalogAutonomousRepairPromptFor, catalogAutonomousRevisionPromptFor, createCatalogAutonomousTools, type CatalogAutonomousRuntimeInput } from "./catalog-autonomous-runtime.js";
import { CATALOG_DOCUMENT_SKILL_PATHS } from "./catalog-document-skills.js";
import { CatalogCoverageReview, CATALOG_COVERAGE_REVIEW_PROMPT, createCatalogCoverageReviewTools } from "./catalog-coverage-review.js";
import {
  buildPdfLayoutCatalog,
  pdfLayoutCatalogPage,
  inspectPdfLayoutLines,
  pdfLayoutSealToolReject,
  sealPdfLayoutProfile,
  type PdfLayoutProfile,
  type PdfLayoutRule,
} from "./pdf-layout-profile.js";

interface AbortableSession {
  abort(): Promise<void>;
}

export function sessionMessagesHaveUnresolvedToolCalls(messages: readonly unknown[]): boolean {
  const unresolved = new Set<string>();
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block
          && typeof block === "object"
          && !Array.isArray(block)
          && (block as { type?: unknown }).type === "toolCall"
          && typeof (block as { id?: unknown }).id === "string"
        ) {
          unresolved.add((block as { id: string }).id);
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      unresolved.delete(message.toolCallId);
    }
  }
  return unresolved.size > 0;
}

export function piSessionRequiresFreshStart(sessionFile: string): boolean {
  if (!sessionFile.trim()) return false;
  if (!existsSync(sessionFile)) return true;
  try {
    return sessionMessagesHaveUnresolvedToolCalls(
      SessionManager.open(sessionFile).buildSessionContext().messages,
    );
  } catch {
    // A persisted session that cannot be reconstructed is not a safe provider
    // checkpoint. The durable workspace files remain the recovery authority.
    return true;
  }
}

function bindAbortSignal(
  signal: AbortSignal | undefined,
  session: AbortableSession,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}

function mergeAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal | undefined; dispose: () => void } {
  const available = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined);
  if (available.length === 0) return { signal: undefined, dispose: () => undefined };
  if (available.length === 1) return { signal: available[0], dispose: () => undefined };

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of available) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const abort = () => controller.abort(source.reason);
    listeners.set(source, abort);
    source.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, abort] of listeners) source.removeEventListener("abort", abort);
      listeners.clear();
    },
  };
}

/** Bounds a stalled operation without charging time spent on successful work. */
export class ProgressIdleDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly idleMs: number) { this.progress(); }
  get signal(): AbortSignal { return this.controller.signal; }

  progress(): void {
    if (this.controller.signal.aborted) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new Error(`review_idle_timeout: no successful review tool for ${this.idleMs}ms`)), this.idleMs);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Repeating the same successful read is not new review progress. */
export class UniqueSuccessfulToolCalls {
  private readonly argumentsByCall = new Map<string, string>();
  private readonly successful = new Set<string>();

  observe(value: unknown): boolean {
    const event = eventRecord(value);
    if (event?.type === 'tool_execution_start') {
      this.argumentsByCall.set(String(event.toolCallId), `${String(event.toolName)}:${JSON.stringify(event.args)}`);
      return false;
    }
    if (event?.type !== 'tool_execution_end') return false;
    const callId = String(event.toolCallId);
    const key = this.argumentsByCall.get(callId);
    this.argumentsByCall.delete(callId);
    if (!key || (event.result as { details?: { ok?: unknown } } | undefined)?.details?.ok !== true
      || this.successful.has(key)) return false;
    this.successful.add(key);
    return true;
  }
}

function isDeterministicToolTimeoutFallback(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const details = (result as { details?: unknown }).details;
  return details !== null && typeof details === "object" && !Array.isArray(details)
    && (details as Record<string, unknown>).ok === true
    && (details as Record<string, unknown>).rule_source === "fallback";
}

function throwAbortReason(signal: AbortSignal): never {
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

export const LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE = prompt_LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE;
// Compatibility sentence retained for external prompt-contract checks.
export const LOSSLESS_BRANCH_ALTERNATIVES = prompt_LOSSLESS_BRANCH_ALTERNATIVES;

export const SYSTEM_PROMPT = prompt_SYSTEM_PROMPT;

export const TARGET_SELECTOR_SYSTEM_PROMPT = prompt_TARGET_SELECTOR_SYSTEM_PROMPT;

export const targetRepairPrompt = prompt_targetRepairPrompt;

export const targetSelectorStagePrompt = prompt_targetSelectorStagePrompt;

export function targetContinuationPatchPolicy(decisionMode: boolean): Record<string, string | number> {
  return decisionMode
    ? { patch_limit_source: "stage_target_selector_draft_tool_contract" }
    : { max_changed_items_per_patch: 4 };
}

export const targetSelectorStartupPrompt = prompt_targetSelectorStartupPrompt;

const DISCOVERY_SELECTOR_TRANSACTION_GUIDANCE = prompt_DISCOVERY_SELECTOR_TRANSACTION_GUIDANCE;

const DISCOVERY_SYSTEM_PROMPT = prompt_DISCOVERY_SYSTEM_PROMPT;

const DISCOVERY_REVIEW_SYSTEM_PROMPT = prompt_DISCOVERY_REVIEW_SYSTEM_PROMPT;

export const COVERAGE_REVIEW_SYSTEM_PROMPT = prompt_COVERAGE_REVIEW_SYSTEM_PROMPT;

export const COVERAGE_FINALIZATION_TOOL_NAMES = [
  "read_working_coverage_review", "stage_coverage_review_draft", "seal_coverage_review",
  "read_candidate_related_context",
  "search_review_document", "open_review_document", "search_review_evidence", "open_review_evidence", "batch_open_review_evidence", "locate_review_span",
  "list_coverage_reference_targets", "read_reference_facts", "read_document_reference_evidence",
] as const;

export function coverageFinalizationBlockerPrompt(result: Record<string, unknown>): string {
  if (
    result.ok === true
    || result.error === "coverage_review_not_mechanically_ready"
    || coverageControllerRebuildRequired(result)
  ) return "";
  const issues = Array.isArray(result.issues) ? result.issues : [];
  return JSON.stringify({
    error: result.error ?? "coverage_review_finalization_blocked",
    required_action: result.required_action,
    issue_count: issues.length,
    issues: issues.slice(0, 8),
  });
}

export function coverageControllerRebuildRequired(result: Record<string, unknown>): boolean {
  return result.error === "coverage_review_candidate_changed";
}

export interface LiveCoverageReviewResult {
  sealed: boolean;
  model: string;
  review?: DomainCoverageReview;
  error?: string;
  terminal?: true;
  control?: {
    kind: "coverage_controller_rebuild";
    retryable: boolean;
    same_job_required: true;
    stale_plan_fingerprint: string;
    current_plan_fingerprint: string;
    current_plan_sha256: string;
    required_action: string;
    instruction: string;
    reason?: string;
  };
}

function staleCoverageControllerResult(
  receipt: CoverageControllerRebuildReceipt,
): LiveCoverageReviewResult {
  return {
    sealed: false,
    model: "coverage-controller-stale",
    error: receipt.error,
    terminal: true,
    control: {
      kind: receipt.control_kind,
      retryable: receipt.retryable_control,
      same_job_required: receipt.same_job_required,
      stale_plan_fingerprint: receipt.stale_plan_fingerprint,
      current_plan_fingerprint: receipt.current_plan_fingerprint,
      current_plan_sha256: receipt.current_plan_sha256,
      required_action: receipt.required_action,
      instruction: receipt.instruction,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
    },
  };
}

export const COVERAGE_FINALIZATION_SYSTEM_PROMPT = prompt_COVERAGE_FINALIZATION_SYSTEM_PROMPT;

export const HIERARCHY_CONFIRM_SYSTEM_PROMPT = prompt_HIERARCHY_CONFIRM_SYSTEM_PROMPT;

export const HIERARCHY_SYSTEM_PROMPT = prompt_HIERARCHY_SYSTEM_PROMPT;

export const HIERARCHY_REVIEW_SYSTEM_PROMPT = prompt_HIERARCHY_REVIEW_SYSTEM_PROMPT;

function serializable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { serialization_error: "Pi SDK event was not JSON-serializable" };
  }
}

export function capturePiSdkEvent(value: unknown): unknown | undefined {
  const captured = serializable(value);
  if (
    captured !== null
    && typeof captured === "object"
    && (captured as { type?: unknown }).type === "message_update"
  ) {
    return undefined;
  }
  return captured;
}

export function assistantTerminalError(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const message = value as { errorMessage?: unknown; stopReason?: unknown };
  if (typeof message.errorMessage === "string" && message.errorMessage) {
    return message.errorMessage;
  }
  if (message.stopReason === "error") {
    // The provider stream died mid-generation (observed round-11: a
    // half-generated tool call with stopReason "error" and no error payload).
    // "terminated" keeps the wording inside classifyUnstructuredTargetFailure's
    // transport patterns so the bounded fresh-session retry continues from the
    // durable checkpoint.
    return "provider stream error: stream terminated before response completed (stopReason=error)";
  }
  return message.stopReason === "length" ? "finish_reason=length" : "";
}

export function isExpectedTerminalAbortMessage(value: unknown): boolean {
  const message = eventRecord(value);
  return message?.role === 'assistant'
    && typeof message.errorMessage === 'string'
    && /^(?:This operation was aborted|Request(?: was)? aborted)$/iu.test(message.errorMessage);
}

function assistantText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => block && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text.trim()]
      : [])
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

export function isProviderContextTooLargeError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /\b400\b[\s\S]*(?:context[_ ]too[_ ]large|input exceeds the context window)|(?:context[_ ]too[_ ]large|input exceeds the context window)[\s\S]*\b400\b/i.test(message);
}

function providerContextErrorFromEvent(value: unknown): string {
  const event = eventRecord(value);
  if (event?.type !== "message_end") return "";
  const message = event.message;
  const error = assistantTerminalError(message);
  return isProviderContextTooLargeError(error) ? error : "";
}

export interface DurablePromptSnapshot {
  checkpoint: string;
  working_plan_sha256: string;
  history_sequence: number;
  last_valid_fingerprint: string;
  issue_fingerprint?: string;
  selector_stage?: string;
  blocking_issues?: Array<{ identity: string; fingerprint: string }> | undefined;
  repair_work_issues?: Array<{ identity: string; fingerprint: string }> | undefined;
}

type SelectorPreflightHandoff = {
  draft_fingerprint: string;
  validation_tool: string;
  failed_tool?: string;
  first_issue: {
    code: string;
    path: string;
    identity?: Record<string, string>;
    next_tool: string;
    next_tool_arguments?: Record<string, unknown>;
    save_tool?: string;
    writable_paths?: string[];
    repair_instruction?: string;
    next_tool_completed?: boolean;
    write_mode?: string;
    record_reads?: Array<{ tool: string; arguments: Record<string, unknown>; completed?: boolean }>;
  };
};

export function selectorDraftFingerprintFromSource(source: string): string {
  return targetSelectorFingerprint(migrateTargetSelectorPlan(strictJsonParse(source)));
}

const SELECTOR_PREFLIGHT_TOOLS = new Set([
  "advance_target_selector_stage", "commit_target_selector_draft", "seal_validated_plan",
]);
const SELECTOR_AUTHOR_WRITE_TOOLS = new Set(["stage_target_selector_draft", "stage_table_structure"]);
const SELECTOR_HANDOFF_INVALIDATING_TOOLS = new Set([
  "stage_table_structure", "replace_target_selectors", "patch_target_selectors", "resolve_document_reference",
]);
const HANDOFF_IDENTITY_FIELDS = [
  "collection", "key", "item_key", "reference_key", "occurrence_id", "evidence_id", "table_key", "clause_id", "lot_key",
] as const;
const HANDOFF_ARGUMENT_FIELDS = new Set([
  "collection", "key", "cursor", "limit", "evidence_id", "evidence_ids", "occurrence_id", "target_key",
  "table_key", "entry_ids", "draft_fingerprint", "next_stage", "page", "line",
]);

function shortHandoffToken(value: unknown, maxLength = 120): string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n]/u.test(value)
    ? value : "";
}

function exactShortToolArguments(value: unknown): Record<string, unknown> | undefined {
  const argumentsRecord = eventRecord(value);
  if (!argumentsRecord || Array.isArray(value)) return undefined;
  if (Object.keys(argumentsRecord).some(key => !HANDOFF_ARGUMENT_FIELDS.has(key))) return undefined;
  const valuesAreShort = (entry: unknown): boolean => {
    if (typeof entry === "string") return entry.length <= 128;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "boolean" || entry === null) return true;
    return Array.isArray(entry) && entry.length <= 12 && entry.every(valuesAreShort);
  };
  if (!Object.values(argumentsRecord).every(valuesAreShort)) return undefined;
  const json = JSON.stringify(argumentsRecord);
  return json.length <= 900 ? JSON.parse(json) as Record<string, unknown> : undefined;
}

/** Carries an actionable author-write or preflight failure across a normal model stop. */
export class SelectorCompletedPreflightHandoff {
  private currentDraftFingerprint = "";
  private latest: SelectorPreflightHandoff | undefined;
  private recoveredRouteIsHistorical = false;
  private oversizedRepairNeedsValidation = false;
  private fullReceiptVisibleInCurrentSession = false;
  private readonly startedToolArguments = new Map<string, unknown>();

  setDraftFingerprint(fingerprint: string): void {
    this.currentDraftFingerprint = fingerprint;
    if (this.latest?.draft_fingerprint !== fingerprint) {
      this.latest = undefined;
      this.recoveredRouteIsHistorical = false;
      this.oversizedRepairNeedsValidation = false;
      this.fullReceiptVisibleInCurrentSession = false;
    }
  }

  forgetCompletedRead(): void {
    if (this.latest) delete this.latest.first_issue.next_tool_completed;
    for (const read of this.latest?.first_issue.record_reads ?? []) delete read.completed;
  }

  hasCurrentWriteFailure(): boolean {
    return !this.recoveredRouteIsHistorical && SELECTOR_AUTHOR_WRITE_TOOLS.has(this.latest?.failed_tool ?? "");
  }

  markRecoveredPreflightAsHistorical(): void {
    // A transcript receipt may have been produced by an older compiler build.
    // Keep only its identity. Read current author contracts before repair;
    // a mandatory recheck here can consume the last inherited retry unchanged.
    this.recoveredRouteIsHistorical = Boolean(this.latest);
    this.fullReceiptVisibleInCurrentSession = false;
  }

  observe(value: unknown): void {
    const event = eventRecord(value);
    if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      const readRoute = this.latest?.first_issue.record_reads?.find(read => read.tool === event.toolName
        && Object.entries(read.arguments).every(([key, entry]) =>
          JSON.stringify(eventRecord(event.args)?.[key]) === JSON.stringify(entry)));
      if (event.toolName === this.latest?.first_issue.next_tool || readRoute) {
        const calledArguments = eventRecord(event.args);
        const expectedArguments = readRoute?.arguments ?? this.latest?.first_issue.next_tool_arguments;
        const argumentsRecord = exactShortToolArguments(calledArguments && expectedArguments
          ? Object.fromEntries(Object.keys(expectedArguments).map((key) => [key, calledArguments[key]]))
          : event.args);
        if (argumentsRecord) {
          if (this.startedToolArguments.size >= 8) this.startedToolArguments.clear();
          this.startedToolArguments.set(event.toolCallId, argumentsRecord);
        }
      }
      return;
    }
    if (event?.type !== "tool_execution_end") return;
    const toolName = shortHandoffToken(event.toolName);
    const result = eventRecord(event.result);
    const details = eventRecord(result?.details);
    const calledWith = typeof event.toolCallId === "string"
      ? this.startedToolArguments.get(event.toolCallId) : undefined;
    if (typeof event.toolCallId === "string") this.startedToolArguments.delete(event.toolCallId);
    if (!details) return;
    const receiptFingerprint = shortHandoffToken(details.current_draft_fingerprint)
      || shortHandoffToken(details.selector_fingerprint)
      || shortHandoffToken(details.draft_fingerprint)
      || shortHandoffToken(eventRecord(details.checkpoint)?.draft_fingerprint);
    if (details.ok === true) {
      for (const read of this.latest?.first_issue.record_reads ?? []) {
        if (toolName === read.tool && calledWith && Object.entries(read.arguments).every(([key, entry]) =>
          JSON.stringify(eventRecord(calledWith)?.[key]) === JSON.stringify(entry))) read.completed = true;
      }
      if (this.latest && toolName === this.latest.first_issue.next_tool) {
        const expected = this.latest.first_issue.next_tool_arguments;
        const actual = eventRecord(calledWith);
        if (!expected || (actual && Object.entries(expected).every(([key, entry]) =>
          JSON.stringify(actual[key]) === JSON.stringify(entry)))) {
          this.latest.first_issue.next_tool_completed = true;
        }
      }
      if (toolName === "stage_target_selector_draft") {
        this.latest = undefined;
        this.recoveredRouteIsHistorical = false;
        this.oversizedRepairNeedsValidation = false;
        this.fullReceiptVisibleInCurrentSession = false;
        this.startedToolArguments.clear();
        if (receiptFingerprint) this.setDraftFingerprint(receiptFingerprint);
      } else if (SELECTOR_HANDOFF_INVALIDATING_TOOLS.has(toolName) || SELECTOR_PREFLIGHT_TOOLS.has(toolName)) {
        this.latest = undefined;
        this.recoveredRouteIsHistorical = false;
        this.oversizedRepairNeedsValidation = false;
        this.fullReceiptVisibleInCurrentSession = false;
        if (receiptFingerprint) this.currentDraftFingerprint = receiptFingerprint;
      }
      return;
    }
    if (!SELECTOR_PREFLIGHT_TOOLS.has(toolName) && !SELECTOR_AUTHOR_WRITE_TOOLS.has(toolName)) return;
    this.latest = undefined;
    this.recoveredRouteIsHistorical = false;
    this.oversizedRepairNeedsValidation = false;
    this.fullReceiptVisibleInCurrentSession = false;
    if (details.terminal === true) return;
    // Tool details retain canonical source IDs; the model sees the encoded text
    // content. Carry its short handles into the next prompt so they can be used
    // with the same source_handle_scope as subsequent tool receipts.
    const visibleReceipt = Array.isArray(result?.content)
      ? result.content.map((block) => {
        const text = eventRecord(block)?.text;
        if (typeof text !== "string") return undefined;
        try { return eventRecord(JSON.parse(text)); } catch { return undefined; }
      }).find((receipt) => receipt?.ok === false && Array.isArray(receipt.selector_issues))
      : undefined;
    const canonicalIssues = Array.isArray(details.selector_issues) ? details.selector_issues
      : Array.isArray(details.issues) ? details.issues : [];
    const visibleIssues = Array.isArray(visibleReceipt?.selector_issues) ? visibleReceipt.selector_issues : [];
    const receipt = eventRecord(visibleIssues[0])?.code === eventRecord(canonicalIssues[0])?.code
      ? visibleReceipt ?? details : details;
    this.fullReceiptVisibleInCurrentSession = receipt === visibleReceipt;
    const issues = receipt === visibleReceipt ? visibleIssues : canonicalIssues;
    const first = eventRecord(issues[0]);
    if (!first) return;
    const code = shortHandoffToken(first.code);
    const path = shortHandoffToken(first.path, 200);
    const issueDetails = eventRecord(first.details);
    const nextTool = shortHandoffToken(first.next_tool) || shortHandoffToken(issueDetails?.next_tool)
      || shortHandoffToken(receipt.next_tool);
    const fingerprint = receiptFingerprint || this.currentDraftFingerprint;
    if (!code || !path || !nextTool || !fingerprint) return;
    const identity: Record<string, string> = {};
    for (const source of [eventRecord(first.record_identity), first, eventRecord(first.details)]) {
      if (!source) continue;
      for (const field of HANDOFF_IDENTITY_FIELDS) {
        const token = shortHandoffToken(source[field], 96);
        if (token && Object.keys(identity).length < 3 && !identity[field]) identity[field] = token;
      }
    }
    const recordRead = eventRecord(first.record_read);
    const firstArgs = first.next_tool_arguments ?? first.tool_arguments
      ?? issueDetails?.next_tool_arguments
      ?? (recordRead?.tool === nextTool ? recordRead.arguments : undefined);
    const matchingTopLevelArgs = nextTool === receipt.next_tool ? receipt.next_tool_arguments : undefined;
    const nextToolArguments = exactShortToolArguments(firstArgs ?? matchingTopLevelArgs);
    const candidateWritablePaths = first.writable_paths ?? issueDetails?.writable_paths
      ?? (first.writable_path ? [first.writable_path] : issueDetails?.writable_path ? [issueDetails.writable_path] : []);
    const writablePaths = Array.isArray(candidateWritablePaths)
      ? candidateWritablePaths.slice(0, 8).map((value) => shortHandoffToken(value, 200))
        .filter((value) => value.startsWith("/"))
      : [];
    const fullRepairInstruction = typeof first.how_to_pass === "string" && first.how_to_pass.length
      ? first.how_to_pass : issueDetails?.how_to_pass;
    this.oversizedRepairNeedsValidation = typeof fullRepairInstruction === "string"
      && fullRepairInstruction.length > 420;
    const repairInstruction = shortHandoffToken(fullRepairInstruction, 420)
      || shortHandoffToken(first.required_action, 220)
      || shortHandoffToken(issueDetails?.required_action, 220);
    const recordReads = (Array.isArray(first.record_reads) ? first.record_reads
      : Array.isArray(issueDetails?.record_reads) ? issueDetails.record_reads : []).slice(0, 8).flatMap(value => {
      const read = eventRecord(value), tool = shortHandoffToken(read?.tool);
      const args = exactShortToolArguments(read?.arguments);
      return tool === "read_target_selectors" && args ? [{ tool, arguments: args }] : [];
    });
    const writeFailure = SELECTOR_AUTHOR_WRITE_TOOLS.has(toolName);
    this.latest = {
      draft_fingerprint: fingerprint,
      validation_tool: toolName === "seal_validated_plan" || writeFailure ? "commit_target_selector_draft" : toolName,
      ...(toolName === "seal_validated_plan" || writeFailure ? { failed_tool: toolName } : {}),
      first_issue: {
        code, path,
        ...(Object.keys(identity).length ? { identity } : {}),
        next_tool: nextTool,
        ...(nextToolArguments ? { next_tool_arguments: nextToolArguments } : {}),
        ...(shortHandoffToken(first.save_tool) ? { save_tool: shortHandoffToken(first.save_tool) } : {}),
        ...(writablePaths.length ? { writable_paths: writablePaths } : {}),
        ...(repairInstruction ? { repair_instruction: repairInstruction } : {}),
        ...(shortHandoffToken(first.write_mode ?? issueDetails?.write_mode)
          ? { write_mode: shortHandoffToken(first.write_mode ?? issueDetails?.write_mode) } : {}),
        ...(recordReads.length ? { record_reads: recordReads } : {}),
      },
    };
  }

  continuationNote(
    currentDraftFingerprint: string,
    receiptVisibleInCurrentSession = false,
  ): string {
    if (!this.latest) return "";
    if (this.latest.draft_fingerprint !== currentDraftFingerprint) {
      this.latest = undefined;
      this.recoveredRouteIsHistorical = false;
      this.oversizedRepairNeedsValidation = false;
      this.fullReceiptVisibleInCurrentSession = false;
      return "";
    }
    if (this.recoveredRouteIsHistorical) {
      return preflightContinuationPrompt({ state: "historical", navigation: {
        validation_tool: this.latest.validation_tool,
        code: this.latest.first_issue.code,
        path: this.latest.first_issue.path,
        ...(this.latest.first_issue.identity ? { identity: this.latest.first_issue.identity } : {}),
        next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 },
      }, next_tool_completed: this.latest.first_issue.next_tool_completed === true, seal_failed: this.latest.failed_tool === "seal_validated_plan" });
    }
    if (this.oversizedRepairNeedsValidation
      && (!receiptVisibleInCurrentSession || !this.fullReceiptVisibleInCurrentSession)) {
      return preflightContinuationPrompt({ state: "oversized_unread", navigation: {
        validation_tool: this.latest.validation_tool,
        code: this.latest.first_issue.code,
        path: this.latest.first_issue.path,
        ...(this.latest.first_issue.identity ? { identity: this.latest.first_issue.identity } : {}),
      }, next_tool_completed: this.latest.first_issue.next_tool_completed === true, seal_failed: this.latest.failed_tool === "seal_validated_plan" });
    }
    if (this.oversizedRepairNeedsValidation) {
      return preflightContinuationPrompt({ state: "oversized_visible", navigation: {
        validation_tool: this.latest.validation_tool,
        code: this.latest.first_issue.code,
        path: this.latest.first_issue.path,
      }, next_tool_completed: this.latest.first_issue.next_tool_completed === true, seal_failed: this.latest.failed_tool === "seal_validated_plan" });
    }
    const pendingRead = this.latest.first_issue.record_reads?.find(read => !read.completed);
    return preflightContinuationPrompt({ state: "current", navigation: {
      ...(this.latest.failed_tool ? { failed_tool: this.latest.failed_tool } : {}),
      validation_tool: this.latest.validation_tool,
      ...this.latest.first_issue,
      ...(pendingRead ? { next_tool: pendingRead.tool, next_tool_arguments: pendingRead.arguments, next_tool_completed: false } : {}),
    }, next_tool_completed: !pendingRead && this.latest.first_issue.next_tool_completed === true, seal_failed: this.latest.failed_tool === "seal_validated_plan" });
  }
}

/** Rebuilds only a compact handoff from this revision's durable SDK events. */
export async function restoreSelectorCompletedPreflightHandoff(
  transcriptPath: string,
  currentDraftFingerprint: string,
): Promise<SelectorCompletedPreflightHandoff> {
  const handoff = new SelectorCompletedPreflightHandoff();
  handoff.setDraftFingerprint(currentDraftFingerprint);
  if (!existsSync(transcriptPath)) return handoff;
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"event_type":"pi_sdk_event"')) continue;
      try {
        const event = JSON.parse(line) as { event_type?: unknown; payload?: unknown };
        if (event.event_type === "pi_sdk_event") handoff.observe(event.payload);
      } catch {
        // A partially written final JSONL line is not a trustworthy receipt.
      }
    }
  } catch {
    // A failed transcript read must not turn a resumable target into a failure.
    const empty = new SelectorCompletedPreflightHandoff();
    empty.setDraftFingerprint(currentDraftFingerprint);
    return empty;
  } finally {
    lines.close();
    stream.destroy();
  }
  // A fresh provider session may not retain the previous read's source content.
  handoff.forgetCompletedRead();
  handoff.markRecoveredPreflightAsHistorical();
  handoff.continuationNote(currentDraftFingerprint);
  return handoff;
}

function observedContextTokenLimitFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(environment.PI_AGENT_MODELING_MAX_CONTEXT_TOKENS ?? "");
  return Number.isFinite(parsed) && parsed >= 96_000 && parsed <= 480_000
    ? Math.floor(parsed)
    : 192_000;
}

function toolResponseByteLimitFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(environment.PI_AGENT_MODELING_MAX_TOOL_RESPONSE_BYTES ?? "");
  return Number.isFinite(parsed) && parsed >= 192 * 1024 && parsed <= 1024 * 1024
    ? Math.floor(parsed)
    : 384 * 1024;
}

export const TARGET_MODELING_PHASE_LIMITS = {
  // 192K is calibrated against gpt-5.6 investigation profiles. Heavier models
  // measured against the same target (grok-4.6: 194.7K on a 28-item table
  // target) need explicit headroom; override via PI_AGENT_MODELING_MAX_CONTEXT_TOKENS.
  get max_observed_context_tokens(): number {
    return observedContextTokenLimitFromEnvironment();
  },
  max_single_tool_response_bytes: 128 * 1024,
  // Complex table targets can legitimately consume several bounded reads before
  // the final commit. Keep the per-response and observed-context hard stops, but
  // leave enough cumulative room for that last deterministic transition.
  get max_tool_response_bytes(): number {
    return toolResponseByteLimitFromEnvironment();
  },
} as const;

export interface TargetModelingPhaseBudgetDecision {
  exceeded: boolean;
  tool_name: string;
  selector_stage: string;
  reason: "observed_context_tokens" | "single_tool_response_bytes" | "cumulative_tool_response_bytes" | "";
  observed_context_tokens: number;
  tool_response_bytes: number;
  cumulative_tool_response_bytes: number;
  tool_result_count: number;
  limit_name: "max_observed_context_tokens" | "max_single_tool_response_bytes" | "max_tool_response_bytes" | "";
  limit: number;
}

const DURABLE_SELECTOR_WRITE_TOOLS = new Set([
  "stage_target_selector_draft",
  "advance_target_selector_stage",
  "commit_target_selector_draft",
]);

function toolResultOk(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = (value as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details) || !("ok" in details)) return false;
  return (details as { ok?: unknown }).ok === true;
}

function targetModelingToolResponseBytes(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return Buffer.byteLength(JSON.stringify(value), "utf8");
  return content.reduce((total, block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return total;
    const text = (block as { text?: unknown }).text;
    return total + (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0);
  }, 0);
}

export class TargetModelingPhaseBudget {
  private observedContextTokens = 0;
  private cumulativeToolResponseBytes = 0;
  private toolResultCount = 0;

  observeSdkEvent(value: unknown): void {
    const event = eventRecord(value);
    if (event?.type !== "message_end") return;
    const message = eventRecord(event.message);
    if (message?.role !== "assistant") return;
    const usage = eventRecord(message.usage);
    const totalTokens = Number(usage?.totalTokens ?? 0);
    if (Number.isFinite(totalTokens) && totalTokens > 0) {
      this.observedContextTokens = Math.max(this.observedContextTokens, totalTokens);
    }
  }

  resetCumulativeSlice(): void {
    this.cumulativeToolResponseBytes = 0;
    this.toolResultCount = 0;
  }

  observedContextAtCap(): boolean {
    return this.observedContextTokens >= TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens;
  }

  recordToolResult(toolName: string, value: unknown, stage: string): TargetModelingPhaseBudgetDecision {
    const responseBytes = targetModelingToolResponseBytes(value);
    this.cumulativeToolResponseBytes += responseBytes;
    this.toolResultCount += 1;
    const reason = responseBytes > TARGET_MODELING_PHASE_LIMITS.max_single_tool_response_bytes
      ? "single_tool_response_bytes"
      : this.cumulativeToolResponseBytes > TARGET_MODELING_PHASE_LIMITS.max_tool_response_bytes
      ? "cumulative_tool_response_bytes"
      : this.observedContextTokens >= TARGET_MODELING_PHASE_LIMITS.max_observed_context_tokens
      ? "observed_context_tokens"
      : "";
    const limitName = reason === "single_tool_response_bytes"
      ? "max_single_tool_response_bytes"
      : reason === "cumulative_tool_response_bytes"
      ? "max_tool_response_bytes"
      : reason === "observed_context_tokens"
      ? "max_observed_context_tokens"
      : "";
    return {
      exceeded: Boolean(reason),
      tool_name: toolName,
      selector_stage: stage,
      reason,
      observed_context_tokens: this.observedContextTokens,
      tool_response_bytes: responseBytes,
      cumulative_tool_response_bytes: this.cumulativeToolResponseBytes,
      tool_result_count: this.toolResultCount,
      limit_name: limitName,
      limit: limitName ? TARGET_MODELING_PHASE_LIMITS[limitName] : 0,
    };
  }
}

export interface TargetModelingCheckpointSnapshot {
  checkpoint_fingerprint: string;
  working_selector_sha256: string;
  history_sequence: number;
  selector_stage: string;
}

export async function targetModelingCheckpointSnapshot(
  workspace: Pick<RevisionWorkspace, "readState" | "workingSelectorPath">,
): Promise<TargetModelingCheckpointSnapshot> {
  const [state, selectorContent] = await Promise.all([
    workspace.readState(),
    readFile(workspace.workingSelectorPath, "utf8"),
  ]);
  const workingSelectorSha256 = sha256Text(selectorContent);
  const value = {
    working_selector_sha256: workingSelectorSha256,
    history_sequence: state.next_history_sequence,
    selector_stage: state.selector_stage ?? "primary",
  };
  return {
    checkpoint_fingerprint: sha256Text(JSON.stringify(value)),
    ...value,
  };
}

export async function persistTargetModelingPhaseBudgetOutcome(
  workspace: Pick<RevisionWorkspace, "readState" | "workingSelectorPath" | "updateState" | "appendEvent">,
  decision: TargetModelingPhaseBudgetDecision,
): Promise<TargetModelingCheckpointSnapshot> {
  const checkpoint = await targetModelingCheckpointSnapshot(workspace);
  if (decision.reason === "observed_context_tokens") {
    await workspace.updateState((state) => {
      const repair = repairStateOrDefault(state.repair);
      repair.fresh_session_required = true;
      state.repair = repair;
    });
    await workspace.appendEvent("repair_session_restart_required", {
      error_code: "repair_session_restart_required",
      ...decision,
      durable_checkpoint: checkpoint,
      terminal: false,
      automatic_rollover: false,
      fresh_session_required: true,
    });
    return checkpoint;
  }
  await workspace.appendEvent("target_modeling_phase_budget_exceeded", {
    error_code: "target_modeling_phase_budget_exceeded",
    ...decision,
    durable_checkpoint: checkpoint,
    terminal: true,
    automatic_rollover: false,
    budget_consumed: false,
  });
  return checkpoint;
}

function modelingContextRestartGuidance(
  decision: TargetModelingPhaseBudgetDecision,
  durable: TargetModelingCheckpointSnapshot,
  saved: boolean,
): Record<string, unknown> {
  return {
    fresh_session_required: true,
    automatic_rollover: false,
    current_session_stopped: true,
    phase_budget: decision,
    durable_checkpoint: durable,
    required_action: "stop_current_session_and_preserve_checkpoint",
    next_tool: null,
    next_tools: [],
    next_tool_scope: "none",
    writable_paths: [],
    diagnostic_action_scope: "fresh_provider_session_only",
    recovery_guidance: {
      tool_scope: "fresh_provider_session_only",
      budget_policy: "preserve_existing_counters",
      candidate_read_tool: "read_target_selectors",
      instruction: "仅在现有恢复规则允许的新会话中，先核对持久化来源、作者记录和输入身份，再按真实 key 读取当前记录及取得当前 scope 句柄；旧路径和句柄不能直接复用，预算不能清零。",
    },
    instruction: (saved ? "本次选择器检查点已保存。" : "模型服务报告上下文已满。")
      + "停止本会话，不再读写或重试工具；保存结果不代表业务校验通过。后续仅按 recovery_guidance 和现有恢复规则从持久化检查点继续。",
  };
}

function modelingContextRestartPayload(
  decision: TargetModelingPhaseBudgetDecision,
  durable: TargetModelingCheckpointSnapshot,
  toolWithheld = false,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const details = {
    ok: false,
    terminal: false,
    error: `repair_session_restart_required: observed modeling context is full (${decision.observed_context_tokens}/${decision.limit}); continue from the durable selector checkpoint in a fresh provider session`,
    error_code: "repair_session_restart_required",
    budget_consumed: false,
    ...(toolWithheld ? { original_tool_executed: false, author_draft_mutation: false } : {}),
    ...modelingContextRestartGuidance(decision, durable, false),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

export function withTargetModelingPhaseBudget(
  tools: ToolDefinition[],
  budget: TargetModelingPhaseBudget,
  stage: () => string,
  checkpoint: (decision: TargetModelingPhaseBudgetDecision) => Promise<TargetModelingCheckpointSnapshot>,
): ToolDefinition[] {
  let terminalFailure: {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  } | undefined;
  let latchedRestart: {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  } | undefined;
  return tools.map((tool) => {
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => {
        if (terminalFailure) return terminalFailure;
        if (latchedRestart) return latchedRestart;
        const durableWrite = DURABLE_SELECTOR_WRITE_TOOLS.has(tool.name);
        if (budget.observedContextAtCap() && !durableWrite) {
          const decision = budget.recordToolResult(tool.name, {
            content: [{ type: "text", text: "" }],
          }, stage());
          const durable = await checkpoint(decision);
          latchedRestart = modelingContextRestartPayload(decision, durable, true);
          return latchedRestart;
        }
        const result = await execute(...args);
        const decision = budget.recordToolResult(tool.name, result, stage());
        if (!decision.exceeded) {
          if (durableWrite && toolResultOk(result)) {
            budget.resetCumulativeSlice();
          }
          return result;
        }
        if (decision.reason === "observed_context_tokens") {
          const durable = await checkpoint(decision);
          latchedRestart = modelingContextRestartPayload(decision, durable);
          if (durableWrite) {
            if (toolResultOk(result)) budget.resetCumulativeSlice();
            const guidance = modelingContextRestartGuidance(decision, durable, toolResultOk(result));
            const decorate = (body: Record<string, unknown>): Record<string, unknown> => {
              const retained = { ...body };
              const previousRecovery: Record<string, unknown> = {};
              for (const key of ["next_tool", "next_tools", "next_tool_arguments", "next_diagnostic_page",
                "writable_paths", "writable_collection", "candidate_read_tool", "required_action", "instruction", "recovery_guidance"]) {
                if (!Object.hasOwn(retained, key)) continue;
                previousRecovery[key] = retained[key];
                delete retained[key];
              }
              return { ...retained, ...guidance,
                recovery_guidance: { ...(guidance.recovery_guidance as Record<string, unknown>),
                  ...(Object.keys(previousRecovery).length ? { previous_tool_recovery: previousRecovery } : {}) } };
            };
            const existingDetails = result && typeof result === "object" && !Array.isArray(result)
              && (result as { details?: unknown }).details
              && typeof (result as { details?: unknown }).details === "object"
              && !Array.isArray((result as { details?: unknown }).details)
              ? (result as { details: Record<string, unknown> }).details
              : {};
            // This wrapper runs outside source-handle encoding. Decorate the
            // public body independently; internal details may contain canonical
            // IDs that must never be copied into the model-facing content.
            let decoratedPublicBody = false;
            const content = result.content.map(block => {
              if (block.type !== "text") return block;
              let body: unknown;
              try { body = JSON.parse(block.text); } catch { return block; }
              if (!body || typeof body !== "object" || Array.isArray(body)) return block;
              decoratedPublicBody = true;
              return { ...block, text: JSON.stringify(decorate(body as Record<string, unknown>)) };
            });
            if (!decoratedPublicBody) content.push({ type: "text", text: JSON.stringify(guidance) });
            return {
              ...result,
              content,
              details: decorate(existingDetails),
            };
          }
          return latchedRestart;
        }
        const durable = await checkpoint(decision);
        const diagnostic = {
          tool_name: decision.tool_name,
          selector_stage: decision.selector_stage,
          reason: decision.reason,
          observed_context_tokens: decision.observed_context_tokens,
          tool_response_bytes: decision.tool_response_bytes,
          cumulative_tool_response_bytes: decision.cumulative_tool_response_bytes,
          limit_name: decision.limit_name,
          limit: decision.limit,
          durable_checkpoint: durable,
        };
        const error = `target_modeling_phase_budget_exceeded: ${JSON.stringify(diagnostic)}`;
        const details = {
          ok: false,
          terminal: true,
          error,
          error_code: "target_modeling_phase_budget_exceeded",
          automatic_rollover: false,
          budget_consumed: false,
          phase_budget: decision,
          durable_checkpoint: durable,
          instruction: "目标建模因本地阶段预算耗尽而失败。原样上报此错误，不得换新会话重试。",
        };
        terminalFailure = {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
        return terminalFailure;
      },
    } as ToolDefinition;
  });
}

interface DurableContinuationEvent {
  continuation: number;
  durable_progress: boolean;
  consecutive_without_progress: number;
  before: DurablePromptSnapshot;
  after: DurablePromptSnapshot;
}

type PromptRoundOutcome =
  | { kind: "completed" }
  | { kind: "sealed" }
  | { kind: "review_required" }
  | { kind: "repair_restart" }
  | { kind: "terminal_failure"; error: string }
  | { kind: "failed"; error: unknown };

export const MODEL_FIRST_EVENT_TIMEOUT_MS = 60_000;
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const LOCAL_TOOL_TIMEOUT_MS = 60_000;
// Catalog agents legitimately run heavy local scripts (whole-document indexes and
// evidence lookups over thousands of pages); the generic 60s watchdog kills them
// mid-run even though the model asked for a longer bash timeout.
export const CATALOG_BASH_TOOL_TIMEOUT_MS = 15 * 60_000;

type ModelStreamTimeoutKind = "first_event" | "idle";

export interface ModelStreamTimeouts {
  firstEventMs: number;
  idleMs: number;
}

function positiveModelStreamTimeout(
  environment: NodeJS.ProcessEnv,
  name: "PI_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS" | "PI_AGENT_MODEL_IDLE_TIMEOUT_MS",
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

export function modelStreamTimeoutsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelStreamTimeouts {
  return {
    firstEventMs: positiveModelStreamTimeout(
      environment,
      "PI_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS",
      MODEL_FIRST_EVENT_TIMEOUT_MS,
    ),
    idleMs: positiveModelStreamTimeout(
      environment,
      "PI_AGENT_MODEL_IDLE_TIMEOUT_MS",
      MODEL_STREAM_IDLE_TIMEOUT_MS,
    ),
  };
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

export function isValidRemoteModelEvent(value: unknown): boolean {
  const event = eventRecord(value);
  if (!event) return false;
  const type = event.type;
  if (type === "message_update") {
    const message = eventRecord(event.message);
    return message?.role === "assistant" || event.assistantMessageEvent !== undefined;
  }
  if (type === "message_start" || type === "message_end") {
    return eventRecord(event.message)?.role === "assistant";
  }
  return type === "tool_call_start"
    || type === "tool_call_update"
    || type === "tool_call_end";
}

export interface TerminalToolFailure {
  error: string;
  blocker_code?: string;
  failure_class?: TargetFailureClass;
}

export function terminalToolFailure(details: unknown): TerminalToolFailure | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  const error = typeof record.error === "string" ? record.error : "";
  if (record.terminal !== true && error !== "final_validator_attempt_limit") return undefined;
  const blocker = eventRecord(record.blocker);
  const blockerCode = typeof record.blocker_code === "string"
    ? record.blocker_code
    : typeof blocker?.kind === "string"
      ? blocker.kind
      : undefined;
  const failureClass = targetFailureClass(record.failure_class)
    ?? targetBlockerFailureClass(blockerCode);
  return {
    error: error || "terminal_tool_failure",
    ...(blockerCode ? { blocker_code: blockerCode } : {}),
    ...(failureClass ? { failure_class: failureClass } : {}),
  };
}

export function freshSessionRestartFromTool(details: unknown): boolean {
  const record = eventRecord(details);
  if (!record) return false;
  return record.fresh_session_required === true
    || record.fresh_repair_session_required === true
    || record.error === "fresh_repair_session_required"
    || record.error === "repair_session_restart_required";
}

export function requiresFreshProviderSession(repair: {
  mode: string;
  fresh_session_required: boolean;
  repair_source?: string;
}): boolean {
  return repair.fresh_session_required
    || (repair.mode === "repair" && repair.repair_source === "coverage");
}

export function sealCoverageHandoffFingerprint(details: unknown): string {
  const record = eventRecord(details);
  if (
    record?.error !== "domain_coverage_review_required"
    && record?.error !== "domain_coverage_repair_required"
  ) {
    return "";
  }
  return typeof record.current_fingerprint === "string"
    ? record.current_fingerprint
    : "";
}

export function coverageRepairSessionRoute(options: {
  recovering_coverage_failure: boolean;
  coverage_recheck_plan_fingerprint?: string;
  sealed_repair_review_fingerprint?: string;
  repair: {
    mode: string;
    repair_source?: string;
  };
}): "normal" | "restore_coverage_repair" | "continue_coverage_repair" {
  if (["repair", "modeling"].includes(options.repair.mode) && options.repair.repair_source === "coverage") {
    return "continue_coverage_repair";
  }
  return options.recovering_coverage_failure
    && Boolean(options.coverage_recheck_plan_fingerprint)
    && options.sealed_repair_review_fingerprint === options.coverage_recheck_plan_fingerprint
    ? "restore_coverage_repair"
    : "normal";
}

export function coverageRepairRecoveryFingerprint(options: {
  last_valid_fingerprint?: string;
  coverage_recheck_plan_fingerprint?: string;
  coverage_recheck_source_plan_fingerprint?: string;
}): string {
  const lastValid = options.last_valid_fingerprint ?? "";
  const source = options.coverage_recheck_source_plan_fingerprint ?? "";
  return lastValid && source === lastValid
    ? source
    : options.coverage_recheck_plan_fingerprint ?? "";
}

export function coverageReviewInvocationPolicy(sessionFile: string | undefined): {
  resume: false;
  abandoned_legacy_session: boolean;
} {
  return {
    resume: false,
    abandoned_legacy_session: Boolean(sessionFile?.trim()),
  };
}

export type CoverageReviewStageHandoff = "none" | "investigation" | "finalization" | "ready";

export function coverageReviewStageHandoff(value: unknown): CoverageReviewStageHandoff {
  const event = eventRecord(value);
  if (event?.type !== "tool_execution_end" || event.toolName !== "stage_coverage_review_draft") {
    return "none";
  }
  const result = eventRecord(event.result);
  const details = eventRecord(result?.details);
  if (details?.ok !== true) return "none";
  const validation = eventRecord(details.validation);
  if (details.ready_for_seal === true || validation?.ok === true) return "ready";
  if (details.error === "coverage_review_local_validation") {
    return details.budget_consumed === false ? "finalization" : "none";
  }
  const checkpoint = eventRecord(details.coverage_checkpoint);
  if (checkpoint?.ready_for_validation === false) {
    if (details.budget_consumed !== false) return "none";
    if (details.mechanical_finalization_required === true) return "finalization";
    return details.semantic_progress_changed === true ? "investigation" : "none";
  }
  if (checkpoint?.ready_for_validation === true || validation !== undefined) return "finalization";
  return "none";
}

export function isCoverageFinalizationHandoff(value: unknown): boolean {
  return coverageReviewStageHandoff(value) === "finalization";
}

/** Reference gates have their own durable receipts; reading new entries is progress, rewriting reasons is not. */
export function coverageCheckpointWithReferenceReads(
  reviewProgress: string,
  state: Pick<RevisionState, "reference_catalog_dispositions" | "document_reference_reads">,
): string {
  return sha256Json({
    review: reviewProgress,
    catalogs: Object.entries(state.reference_catalog_dispositions ?? {})
      .filter(([key]) => key.startsWith("coverage:"))
      .map(([key, value]) => ({ key, fingerprint: value.fingerprint,
        entry_ids: [...new Set(value.entry_ids)].sort(), used: [...new Set(value.used)].sort(),
        ignored: [...new Set(value.ignored.map((entry) => entry.entry_id))].sort(),
        opened_ranges: Object.entries(value.opened_ranges ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([entry_id, rows]) => ({
            entry_id,
            rows: Object.entries(rows)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([row_index, ranges]) => ({
                row_index,
                ranges: ranges
                  .map(([start, end]) => [start, end] as [number, number])
                  .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
                    leftStart - rightStart || leftEnd - rightEnd
                  ),
              })),
          })),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    inline_reads: Object.entries(state.document_reference_reads ?? {})
      .filter(([, value]) => value.phase === "coverage")
      .map(([key, value]) => ({ key, target: value.target_key, next: value.next_cursor, done: value.done,
        fingerprint: value.target_fingerprint, total: value.total_count }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  });
}

export function coverageFreshPhaseProgress(options: {
  previous_progress_fingerprint: string;
  previous_last_valid_fingerprint: string;
  current_progress_fingerprint: string;
  current_last_valid_fingerprint: string;
  consecutive_without_progress: number;
  count_stagnation?: boolean;
  current_progress_previously_seen?: boolean;
}): {
  durable_progress: boolean;
  consecutive_without_progress: number;
  stalled: boolean;
} {
  const durableProgress = options.previous_last_valid_fingerprint !== options.current_last_valid_fingerprint
    || (
      options.previous_progress_fingerprint !== options.current_progress_fingerprint
      && options.current_progress_previously_seen !== true
    );
  const consecutiveWithoutProgress = durableProgress
    ? 0
    : options.consecutive_without_progress + (options.count_stagnation === false ? 0 : 1);
  return {
    durable_progress: durableProgress,
    consecutive_without_progress: consecutiveWithoutProgress,
    stalled: consecutiveWithoutProgress >= 2,
  };
}

export function constrainedSessionResultError(options: {
  current_error: string;
  prompt_loop_error: string;
  assistant_error: string;
  terminal_requested: boolean;
  handoff_requested: boolean;
  completed?: boolean;
  assistant_text?: string;
}): string {
  if (options.current_error) return options.current_error;
  if (options.terminal_requested || options.handoff_requested) return "";
  const terminalError = options.prompt_loop_error || options.assistant_error;
  if (terminalError) return terminalError;
  if (options.completed === false) {
    return `agent_stopped_before_terminal_tool: ${options.assistant_text?.trim() || "assistant ended normally without completing or calling the terminal tool"}`;
  }
  return "";
}

export function coverageFreshPhaseTerminalError(options: {
  completed: boolean;
  exhausted_phase_limit: boolean;
  terminal_error: string;
  max_fresh_phases: number;
}): string {
  if (options.completed) return "";
  if (options.exhausted_phase_limit) {
    return `coverage_fresh_phase_limit: ${options.max_fresh_phases} fresh bounded phases did not reach a mechanically valid review`;
  }
  return options.terminal_error;
}

export function coverageFreshPhaseFailureClass(
  error: string,
  handoff: CoverageReviewStageHandoff,
): TargetFailureClass | undefined {
  if (!error || handoff !== "none" || isProviderContextTooLargeError(error)) return undefined;
  return classifyTargetFailure(error);
}

export class ModelStreamWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sawRemoteEvent = false;
  private toolDepth = 0;
  private disposed = false;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;

  constructor(
    private readonly onTimeout: (kind: ModelStreamTimeoutKind) => void,
    private readonly timeouts: ModelStreamTimeouts = modelStreamTimeoutsFromEnvironment(),
  ) {}

  start(signal?: AbortSignal): void {
    if (this.disposed) return;
    this.abortSignal = signal;
    this.abortListener = () => this.dispose();
    signal?.addEventListener("abort", this.abortListener, { once: true });
    if (signal?.aborted) {
      this.dispose();
      return;
    }
    this.arm("first_event");
  }

  observe(value: unknown): void {
    if (this.disposed) return;
    const event = eventRecord(value);
    if (!event) return;
    if (event.type === "tool_execution_start") {
      this.toolDepth += 1;
      this.clearTimer();
      return;
    }
    if (event.type === "tool_execution_end") {
      this.toolDepth = Math.max(0, this.toolDepth - 1);
      if (this.toolDepth === 0) this.arm(this.sawRemoteEvent ? "idle" : "first_event");
      return;
    }
    if (!isValidRemoteModelEvent(event)) return;
    this.sawRemoteEvent = true;
    if (this.toolDepth === 0) this.arm("idle");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
  }

  private arm(kind: ModelStreamTimeoutKind): void {
    this.clearTimer();
    const timeoutMs = kind === "first_event"
      ? this.timeouts.firstEventMs
      : this.timeouts.idleMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.toolDepth > 0) return;
      this.disposed = true;
      this.onTimeout(kind);
    }, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

type StreamWatchdogSession = AbortableSession & {
  prompt(prompt: string, options?: Pick<PromptOptions, 'images'>): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
};

export async function promptWithStreamWatchdog(
  session: StreamWatchdogSession,
  prompt: string,
  signal?: AbortSignal,
  tools: readonly StreamToolContract[] = [],
  images?: PromptOptions['images'],
): Promise<PromptRoundOutcome> {
  type PromptRaceResult = {
    source: "prompt" | "provider_error" | "watchdog";
    outcome: PromptRoundOutcome;
  };
  const streamTimeouts = modelStreamTimeoutsFromEnvironment();
  let resolveTimeout!: (result: PromptRaceResult) => void;
  const timeoutTask = new Promise<PromptRaceResult>((resolve) => { resolveTimeout = resolve; });
  let resolveProviderError!: (result: PromptRaceResult) => void;
  const providerErrorTask = new Promise<PromptRaceResult>((resolve) => { resolveProviderError = resolve; });
  const progressGuard = new ModelStreamProgressGuard(tools);
  let stalled = false;
  const watchdog = new ModelStreamWatchdog((kind) => {
    const timeoutMs = kind === "first_event"
      ? streamTimeouts.firstEventMs
      : streamTimeouts.idleMs;
    const timeoutSeconds = timeoutMs / 1_000;
    const detail = kind === "first_event"
      ? `first model event was not received within ${timeoutSeconds} seconds`
      : `model stream was idle for ${timeoutSeconds} seconds`;
    resolveTimeout({
      source: "watchdog",
      outcome: { kind: "failed", error: progressGuard.idleFailure(timeoutMs) ?? new Error(`ETIMEDOUT: ${detail}`) },
    });
  }, streamTimeouts);
  const unsubscribe = session.subscribe((event) => {
    if (stalled) return;
    try {
      // Empty chunks and structural JSON padding are not model progress. Real string
      // contents (including literal spaces) and normal long tool calls remain unrestricted.
      if (progressGuard.observe(event)) watchdog.observe(event);
    } catch (error) {
      if (!isModelStreamProtectionError(error)) throw error;
      stalled = true;
      resolveTimeout({ source: "watchdog", outcome: { kind: "failed", error } });
      // Abort synchronously at detection, before the SDK can execute the pending call.
      // The race below still waits for both the prompt and abort cleanup to settle.
      void session.abort().catch(() => undefined);
      return;
    }
    const providerError = providerContextErrorFromEvent(event);
    if (!providerError) return;
    resolveProviderError({
      source: "provider_error",
      outcome: { kind: "failed", error: new Error(providerError) },
    });
  });
  watchdog.start(signal);
  const promptTask = (images?.length ? session.prompt(prompt, { images }) : session.prompt(prompt)).then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const promptRaceTask = promptTask.then((outcome): PromptRaceResult => ({
    source: "prompt",
    outcome,
  }));
  try {
    const winner = await Promise.race([promptRaceTask, providerErrorTask, timeoutTask]);
    if (winner.source !== "prompt" || signal?.aborted) {
      await Promise.allSettled([
        Promise.resolve().then(() => session.abort()),
        promptTask,
      ]);
    }
    signal?.throwIfAborted();
    return winner.outcome;
  } finally {
    watchdog.dispose();
    unsubscribe();
  }
}

const COOPERATIVE_LOCAL_TOOL_TIMEOUT_NAMES: ReadonlySet<string> = new Set(["read_reference_facts"]);

export function withToolExecutionTimeout(
  tools: ToolDefinition[],
  timeoutMs = LOCAL_TOOL_TIMEOUT_MS,
  cooperativeToolNames: ReadonlySet<string> = COOPERATIVE_LOCAL_TOOL_TIMEOUT_NAMES,
  toolTimeouts: Readonly<Record<string, number>> = {},
): ToolDefinition[] {
  return tools.map((tool) => {
    const effectiveTimeoutMs = toolTimeouts[tool.name] ?? timeoutMs;
    // A tool that owns its own progress/idle guard may run for as long as it
    // keeps making progress. Its caller's abort signal still reaches execute.
    if (effectiveTimeoutMs === Number.POSITIVE_INFINITY) return tool;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const timeoutController = new AbortController();
        const callerSignal = args[2] as AbortSignal | undefined;
        if (callerSignal?.aborted) throwAbortReason(callerSignal);
        const merged = mergeAbortSignals([callerSignal, timeoutController.signal]);
        const timeoutMessage = `ETIMEDOUT: local tool ${tool.name} exceeded ${effectiveTimeoutMs}ms`;
        const timeoutReason = createLocalToolTimeoutReason(timeoutMessage);
        let rejectTimeout!: (reason: Error) => void;
        const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
        const execution = Promise.resolve().then(() => execute(args[0], args[1], merged.signal, args[3], args[4]));
        timer = setTimeout(() => {
          timedOut = true;
          timeoutController.abort(timeoutReason);
          if (!cooperativeToolNames.has(tool.name)) rejectTimeout(timeoutReason);
        }, effectiveTimeoutMs);
        try {
          // read_reference_facts can launch a writable catalog-discovery session and
          // therefore must settle its abort cleanup before a retry is visible. Other
          // tools have not opted into that contract and keep the previous hard bound.
          const result = cooperativeToolNames.has(tool.name)
            ? await execution
            : await Promise.race([execution, timeout]);
          if (callerSignal?.aborted) throwAbortReason(callerSignal);
          if (timedOut && !isDeterministicToolTimeoutFallback(result)) {
            throw createLocalToolTimeoutReason(timeoutMessage);
          }
          return result;
        } catch (error) {
          if (callerSignal?.aborted) throwAbortReason(callerSignal);
          if (!timedOut) throw error;
          throw createLocalToolTimeoutReason(timeoutMessage, error);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          merged.dispose();
        }
      },
    } as ToolDefinition;
  });
}

export async function runLengthContinuationLoop(options: {
  initialPrompt: string;
  continuationPrompt: string | (() => Promise<string>);
  completedContinuationPrompt?: string | (() => Promise<string>);
  promptRound(prompt: string): Promise<PromptRoundOutcome>;
  lastAssistant(): unknown;
  snapshot(): Promise<DurablePromptSnapshot>;
  shouldContinueAfterCompleted?(event: {
    before: DurablePromptSnapshot;
    after: DurablePromptSnapshot;
  }): Promise<boolean>;
  onLength?(event: DurableContinuationEvent): Promise<void>;
  onCompletedContinuation?(event: DurableContinuationEvent): Promise<void>;
  signal?: AbortSignal;
  maxConsecutiveWithoutProgress?: number;
  maxRepeatedWorkingPlanHash?: number;
  maxLengthContinuations?: number;
  observeBlockingProgress?(before: DurablePromptSnapshot, after: DurablePromptSnapshot): Promise<{
    progress: boolean; stalled: string[];
  } | undefined>;
}): Promise<{
  outcome: PromptRoundOutcome;
  error: string;
  length_continuations: number;
  completion_continuations: number;
}> {
  const noProgressLimit = options.maxConsecutiveWithoutProgress ?? 3;
  const repeatedHashLimit = options.maxRepeatedWorkingPlanHash ?? 3;
  const lengthContinuationLimit = options.maxLengthContinuations ?? Number.POSITIVE_INFINITY;
  let prompt = options.initialPrompt;
  let lengthContinuations = 0;
  let completionContinuations = 0;
  let consecutiveWithoutProgress = 0;
  let repeatedCompletedIssueRounds = 0;
  let lastBlockingObservation = "";
  const workingHashVisits = new Map<string, number>();
  const planStateKey = (snapshot: DurablePromptSnapshot) =>
    `${snapshot.working_plan_sha256}|${snapshot.selector_stage ?? ""}|${snapshot.last_valid_fingerprint}`;

  while (true) {
    options.signal?.throwIfAborted();
    const before = await options.snapshot();
    workingHashVisits.set(
      planStateKey(before),
      Math.max(workingHashVisits.get(planStateKey(before)) ?? 0, 1),
    );
    const observeExit = async () => {
      if (!options.observeBlockingProgress) return undefined;
      const after = await options.snapshot();
      const key = JSON.stringify({ checkpoint: after.checkpoint, blockers: after.blocking_issues, repair_work: after.repair_work_issues });
      if (key === lastBlockingObservation) return undefined;
      const observed = await options.observeBlockingProgress(before, after);
      if (observed) lastBlockingObservation = key;
      return observed;
    };
    let outcome: PromptRoundOutcome;
    try {
      outcome = await options.promptRound(prompt);
    } catch (error) {
      await observeExit();
      throw error;
    }
    if (options.signal?.aborted) {
      await observeExit();
      options.signal.throwIfAborted();
    }
    if (outcome.kind !== "completed") {
      if (["repair_restart", "failed", "terminal_failure"].includes(outcome.kind)) {
        const observed = await observeExit();
        if (observed?.stalled.length && outcome.kind !== "terminal_failure") {
          const error = `target_progress_stalled: unchanged selector blockers across provider sessions: ${observed.stalled.join(",")}; preserve the checkpoint and diagnose the source/tool contract before another run`;
          return { outcome: { kind: "terminal_failure", error }, error,
            length_continuations: lengthContinuations, completion_continuations: completionContinuations };
        }
      }
      return {
        outcome,
        error: "",
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    const terminalError = assistantTerminalError(options.lastAssistant());
    const lengthLimited = terminalError === "finish_reason=length";
    if (terminalError && !lengthLimited) {
      const observed = await observeExit();
      if (observed?.stalled.length) {
        const error = `target_progress_stalled: unchanged selector blockers across provider sessions: ${observed.stalled.join(",")}; provider_exit=${terminalError}; preserve the checkpoint and diagnose before another run`;
        return { outcome: { kind: "terminal_failure", error }, error,
          length_continuations: lengthContinuations, completion_continuations: completionContinuations };
      }
      return {
        outcome,
        error: terminalError,
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }

    const after = await options.snapshot();
    if (
      !lengthLimited
      && !(await options.shouldContinueAfterCompleted?.({ before, after }))
    ) {
      return {
        outcome,
        error: "",
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    const blockingProgress = await options.observeBlockingProgress?.(before, after);
    if (blockingProgress) lastBlockingObservation = JSON.stringify({ checkpoint: after.checkpoint, blockers: after.blocking_issues, repair_work: after.repair_work_issues });
    const durableProgress = blockingProgress?.progress ?? after.checkpoint !== before.checkpoint;
    const repeatedIssue = !blockingProgress && !lengthLimited && Boolean(after.issue_fingerprint)
      && after.issue_fingerprint === before.issue_fingerprint
      && after.working_plan_sha256 === before.working_plan_sha256
      && after.selector_stage === before.selector_stage
      && after.last_valid_fingerprint === before.last_valid_fingerprint;
    repeatedCompletedIssueRounds = repeatedIssue ? repeatedCompletedIssueRounds + 1 : 0;
    consecutiveWithoutProgress = durableProgress ? 0 : consecutiveWithoutProgress + 1;
    if (lengthLimited) lengthContinuations += 1;
    else completionContinuations += 1;
    const hashVisits = (workingHashVisits.get(planStateKey(after)) ?? 0) + 1;
    workingHashVisits.set(planStateKey(after), hashVisits);
    const continuationEvent = {
      continuation: lengthLimited ? lengthContinuations : completionContinuations,
      durable_progress: durableProgress,
      consecutive_without_progress: consecutiveWithoutProgress,
      before,
      after,
    };
    if (lengthLimited) await options.onLength?.(continuationEvent);
    else await options.onCompletedContinuation?.(continuationEvent);
    if (blockingProgress?.stalled.length) {
      const error = `target_progress_stalled: unchanged selector blockers across provider sessions: ${blockingProgress.stalled.join(",")}; preserve the checkpoint and diagnose the source/tool contract before another run`;
      return { outcome: { kind: "terminal_failure", error }, error,
        length_continuations: lengthContinuations, completion_continuations: completionContinuations };
    }
    if (repeatedCompletedIssueRounds >= 2) {
      return {
        outcome,
        error: `target_progress_stalled: 2 completed rounds repeated issue ${after.issue_fingerprint} on unchanged plan ${after.working_plan_sha256}; automatic retries of this checkpoint are stopped. Inspect its persisted selector validation and source evidence before starting a corrected run; do not edit compiled output or immutable evidence`,
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    if (lengthLimited && lengthContinuations >= lengthContinuationLimit) {
      return {
        outcome,
        error: `length_continuation_limit: ${lengthContinuations} truncated rounds reached the transport repair limit`,
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    if (consecutiveWithoutProgress >= noProgressLimit) {
      return {
        outcome,
        error: lengthLimited
          ? `length_without_durable_progress: ${consecutiveWithoutProgress} consecutive truncated rounds made no persisted plan progress`
          : `incomplete_repair_without_durable_progress: ${consecutiveWithoutProgress} consecutive completed rounds left the persisted target incomplete without plan progress`,
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    if (!blockingProgress && durableProgress && hashVisits >= repeatedHashLimit) {
      return {
        outcome,
        error: lengthLimited
          ? `length_durable_progress_cycle: working plan hash repeated ${hashVisits} times across truncated rounds`
          : `incomplete_repair_durable_progress_cycle: working plan hash repeated ${hashVisits} times while repair remained active`,
        length_continuations: lengthContinuations,
        completion_continuations: completionContinuations,
      };
    }
    const nextPrompt = lengthLimited
      ? options.continuationPrompt
      : options.completedContinuationPrompt ?? options.continuationPrompt;
    prompt = typeof nextPrompt === "function" ? await nextPrompt() : nextPrompt;
  }
}

function environmentSnapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function parseModelSpec(specification: string): { provider: string; modelId: string } {
  const slash = specification.indexOf("/");
  if (slash <= 0 || slash === specification.length - 1) {
    throw new Error("PI_AGENT_PDF_MODEL must use provider/model-id syntax");
  }
  return {
    provider: specification.slice(0, slash),
    modelId: specification.slice(slash + 1),
  };
}

/** MiMo uses the thinking object and requires reasoning replay across tool turns,
 * including when settings come from the persisted UI config instead of a preset. */
export function mimoModelCompatibility(model: string) {
  return /^mimo-/i.test(model) ? {
    thinkingFormat: "deepseek" as const,
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: "max_tokens" as const,
  } : {};
}

/** GLM Coding Plan uses the Z.ai thinking object on its OpenAI Chat endpoint,
 * including when the model comes from the persisted Pi UI configuration. */
export function glmModelCompatibility(model: string) {
  return /^glm-/i.test(model) ? {
    thinkingFormat: "zai" as const,
    maxTokensField: "max_tokens" as const,
  } : {};
}

export async function configuredModel(
  workspaceRoot: string,
  stage: PiAgentModelStage,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  effortOverride?: PiAgentEffort,
  imageInput = false,
): Promise<{
  localAgentDir: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  preset: ReturnType<typeof resolvePdfExCodePreset>;
  configured: PiAgentModelSettings | undefined;
  selected: { provider: string; modelId: string };
}> {
  const modelSpec = process.env.PI_AGENT_PDF_MODEL?.trim();
  const explicit = runtimeConfig?.stages[stage];
  const subscription = explicit?.authMode === "chatgpt";
  const protocolProfile = subscription ? undefined : resolvePdfExCodeProtocolPreset(process.env.LLM_PRESET);
  const preset = explicit || modelSpec ? undefined : resolvePdfExCodePreset(process.env);
  if (!explicit && !modelSpec && !preset) {
    throw new Error(
      "Live smoke skipped: neither PI_AGENT_PDF_MODEL nor LLM_PRESET is configured.",
    );
  }
  const selected = explicit
    ? { provider: subscription ? "openai" : `acceptance-pi-${stage}`, modelId: explicit.model }
    : modelSpec
    ? parseModelSpec(modelSpec)
    : { provider: preset!.providerId, modelId: preset!.modelId };
  const localAgentDir = join(workspaceRoot, "pi-agent-home");
  await mkdir(localAgentDir, { recursive: true });
  if (subscription && !runtimeConfig?.subscriptionAuthPath) {
    throw new Error("ChatGPT 订阅登录凭据目录未配置；请从模型配置页面登录 ChatGPT。");
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: subscription ? runtimeConfig!.subscriptionAuthPath! : join(localAgentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  if (subscription) {
    const provider = modelRuntime.getProvider("openai")!;
    // Keep subscription requests OAuth-only even if a key is present in the process
    // environment or the user signs out while an existing session is running.
    modelRuntime.registerNativeProvider({ ...provider, auth: { oauth: provider.auth.oauth! } });
  }
  const baseSettings = explicit ?? (preset ? presetModelSettings(preset) : undefined);
  const configured = baseSettings && effortOverride ? { ...baseSettings, effort: effortOverride } : baseSettings;
  if (configured && !subscription) {
    const providerId = selected.provider;
    const isAnthropic = configured.apiType === "anthropic";
    // GPT-6 Luna needs Responses for high-effort tool use, but Muse's schema
    // projection and developer-role restrictions must not leak into this model.
    const isGpt6Luna = !isAnthropic && /^gpt-6-luna(?:-|$)/i.test(configured.model);
    const muse = !isAnthropic && !isGpt6Luna
      ? museModelCompatibility(configured.model, protocolProfile?.definition.api)
      : undefined;
    const providerApi = isAnthropic ? "anthropic-messages" : isGpt6Luna ? "openai-responses" : muse?.api ?? preset?.api ?? "openai-completions";
    const glm = !isAnthropic ? glmModelCompatibility(configured.model) : {};
    const effort = configured.effort;
    const supportsReasoningEffort = effort !== "off";
    const thinkingLevelMap = preset?.thinkingFormat === "deepseek"
      ? { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" }
      : supportsReasoningEffort
      ? { xhigh: "xhigh", max: "max" }
      : undefined;
    const compat = {
      // Responses defaults to strict when the field is absent. Let the SDK
      // send its explicit strict:false so optional authoring arguments remain optional.
      ...(providerApi === "openai-responses" ? { supportsStrictMode: true } : {}),
      ...(preset?.thinkingFormat ? { thinkingFormat: preset.thinkingFormat } : {}),
      ...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
      ...(isAnthropic ? { forceAdaptiveThinking: true } : {}),
      ...(preset && !preset.supportsDeveloperRole ? { supportsDeveloperRole: false } : {}),
      ...(preset?.maxTokensField ? { maxTokensField: preset.maxTokensField } : {}),
      ...(preset?.thinkingFormat === "deepseek"
        ? { requiresReasoningContentOnAssistantMessages: true }
        : {}),
      ...mimoModelCompatibility(configured.model),
      ...glm,
      ...deepseekModelCompatibility(configured.model),
    };
    modelRuntime.registerProvider(providerId, {
      name: explicit ? `Acceptance Pi ${stage}` : `pdf_ex_code ${preset!.preset}`,
      baseUrl: configured.endpoint,
      apiKey: configured.apiKey,
      api: providerApi,
      ...(new URL(configured.endpoint).hostname === "opencode.ai" ? { headers: { "User-Agent": "PdfEx-AcceptancePi/0.1", "x-opencode-session": sha256Text(workspaceRoot) } } : {}),
      authHeader: !isAnthropic,
      models: [{
        id: configured.model,
        name: configured.model,
        reasoning: supportsReasoningEffort || Boolean(preset?.thinkingFormat) || Boolean(mimoModelCompatibility(configured.model).thinkingFormat),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 32_768,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        ...(muse ? { compat: { supportsDeveloperRole: false, supportsStrictMode: false, supportsLongCacheRetention: false } } : Object.keys(compat).length ? { compat } : {}),
      }],
    });
  }
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (!model) {
    throw new Error(`Configured Pi model is unavailable: ${selected.provider}/${selected.modelId}`);
  }
  if (subscription && !(await modelRuntime.listCredentials()).some(
    credential => credential.providerId === "openai" && credential.type === "oauth",
  )) {
    throw new Error("尚未登录 ChatGPT 订阅；请在模型配置页面完成登录后再启动任务。");
  }
  const auth = await modelRuntime.getAuth(model, { env: environmentSnapshot() });
  if (!auth) {
    throw new Error(`Live smoke skipped: no usable credential exists for provider ${selected.provider}.`);
  }
  return { localAgentDir, modelRuntime, model, preset, configured, selected };
}

function presetModelSettings(preset: NonNullable<ReturnType<typeof resolvePdfExCodePreset>>): PiAgentModelSettings {
  return {
    apiType: preset.api === "anthropic-messages" ? "anthropic" : "openai",
    endpoint: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.modelId,
    effort: preset.reasoningEffort || "off",
  };
}

async function recordPiModelRequestContract(
  workspace: { appendEvent(eventType: string, payload: unknown): Promise<unknown> },
  preset: ReturnType<typeof resolvePdfExCodePreset>,
  configured?: PiAgentModelSettings,
): Promise<void> {
  await workspace.appendEvent("pi_model_request_contract", {
    api_type: configured?.apiType ?? "built-in",
    model: configured?.model ?? "",
    provider_api: museModelCompatibility(configured?.model ?? "")?.api ?? "model-default",
    thinking_enabled: configured ? configured.effort !== "off" : Boolean(preset?.reasoningEffort),
    thinking_effort: configured?.effort ?? preset?.reasoningEffort ?? "off",
    thinking_format: mimoModelCompatibility(configured?.model ?? "").thinkingFormat ?? glmModelCompatibility(configured?.model ?? "").thinkingFormat ?? deepseekModelCompatibility(configured?.model ?? "")?.thinkingFormat ?? preset?.thinkingFormat ?? "",
    reasoning_content_replay: Boolean(mimoModelCompatibility(configured?.model ?? "").requiresReasoningContentOnAssistantMessages) || Boolean(deepseekModelCompatibility(configured?.model ?? "")) || preset?.thinkingFormat === "deepseek",
    max_tokens: 32_768,
    max_tokens_field: mimoModelCompatibility(configured?.model ?? "").maxTokensField ?? glmModelCompatibility(configured?.model ?? "").maxTokensField ?? (preset?.maxTokensField || "model-default"),
    context_window: 1_000_000,
  });
}

export function applyModelPayloadCompatibility(payload: unknown, model: string): unknown {
  const muse = museModelCompatibility(model);
  if (!muse || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const request = { ...payload as Record<string, unknown> };
  // Muse only accepts auto; the controller still enforces allowed tools and completion.
  if (Array.isArray(request.tools) && request.tools.length) {
    request.tool_choice = muse.toolChoice;
    request.tools = request.tools.map(tool => tool && typeof tool === "object" && "parameters" in tool
      ? { ...tool, parameters: museToolParameters(tool.parameters) } : tool);
  }
  else delete request.tool_choice;
  return request;
}

export function constrainSelectorProviderPayload(
  payload: unknown,
  policy: { stage: string; allowed_tools: string[] },
): Record<string, unknown> {
  const request = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const allowed = new Set(policy.allowed_tools);
  const tools = Array.isArray(request.tools) ? request.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const record = tool as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? record.function as Record<string, unknown>
      : record;
    return typeof fn.name === "string" && allowed.has(fn.name);
  }) : [];
  const constrained: Record<string, unknown> = {
    ...request,
    tools,
  };
  // Let the model finish a response; the controller still decides completion.
  // Forcing another tool after a handoff can loop until upstream max_messages.
  if (tools.length > 0) constrained.tool_choice = "auto";
  else delete constrained.tool_choice;
  return constrained;
}

function installProviderPayloadObserver(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  workspace: { appendEvent(eventType: string, payload: unknown): Promise<unknown> },
  selectorPolicy?: () => ReturnType<ToolController["selectorProviderPolicy"]>,
  sourceHandles?: ModelSourceHandles,
  telemetry?: PiSessionTelemetry,
): void {
  const previous = session.agent.onPayload;
  session.agent.onPayload = async (payload, model) => {
    const replacement = previous ? await previous(payload, model) : undefined;
    const effective = replacement === undefined ? payload : replacement;
    const stageConstrained = selectorPolicy ? constrainSelectorProviderPayload(effective, selectorPolicy()) : effective;
    const constrained = applyModelPayloadCompatibility(stageConstrained, model.id);
    const request = constrained && typeof constrained === "object" && !Array.isArray(constrained)
      ? constrained as Record<string, unknown>
      : {};
    const messages = Array.isArray(request.messages)
      ? request.messages.filter((message): message is Record<string, unknown> =>
          Boolean(message && typeof message === "object" && !Array.isArray(message)))
      : [];
    const toolCallMessages = messages.filter((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    );
    const thinking = request.thinking && typeof request.thinking === "object" && !Array.isArray(request.thinking)
      ? request.thinking as Record<string, unknown>
      : {};
    const payloadMeasurement = sourceHandles
      ? sourceHandles.measureProviderPayload(request)
      : { actual_request_utf8_bytes: Buffer.byteLength(JSON.stringify(request), "utf8") };
    telemetry?.observeProviderRequest(request, payloadMeasurement);
    await workspace.appendEvent("pi_provider_request_observed", {
      ...payloadMeasurement,
      model: typeof request.model === "string" ? request.model : "",
      max_tokens: Number(request.max_tokens ?? 0) || 0,
      max_completion_tokens: Number(request.max_completion_tokens ?? 0) || 0,
      thinking_type: typeof thinking.type === "string" ? thinking.type : "",
      reasoning_effort: typeof request.reasoning_effort === "string" ? request.reasoning_effort : String((request.reasoning as Record<string, unknown> | undefined)?.effort ?? ""),
      max_output_tokens: Number(request.max_output_tokens ?? 0) || 0,
      provider_api: model.api,
      tool_choice: request.tool_choice ?? "",
      has_tool_choice: Object.hasOwn(request, "tool_choice"),
      selector_stage: selectorPolicy?.().stage ?? "",
      provider_tool_count: Array.isArray(request.tools) ? request.tools.length : 0,
      assistant_tool_call_messages: toolCallMessages.length,
      assistant_tool_call_reasoning_replay_count: toolCallMessages.filter((message) =>
        typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
      ).length,
      assistant_tool_call_non_null_content_count: toolCallMessages.filter((message) =>
        message.content !== null && message.content !== undefined
      ).length,
    });
    return constrained;
  };
}

export async function runLivePi(
  workspace: RevisionWorkspace,
  controller: ToolController,
  resume: boolean,
  signal?: AbortSignal,
  recoveringTransportFailure = false,
  recoveringCoverageFailure = false,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{
  session_id: string;
  session_file: string;
  sealed: boolean;
  model: string;
  review_required?: boolean;
  review_plan_fingerprint?: string;
  error?: string;
  blocker_code?: string;
  failure_class?: TargetFailureClass;
  waiting_for_source?: ExternalSourceRequest;
}> {
  signal?.throwIfAborted();
  const { localAgentDir, modelRuntime, model, preset, configured, selected } = await configuredModel(
    workspace.root,
    "target_extraction",
    runtimeConfig,
  );
  // 兜底规则过闸门时这个入口不会被调用；只有文档形态陌生才拉起规则发现会话。
  controller.referenceCatalogRuleAsk = createCatalogRuleAsk(workspace, signal, runtimeConfig);
  const decisionMode = controller.usesSelectorCompiler;

  let persistedState = await workspace.readState();
  let currentRepair = await controller.repairStatus();
  if (
    decisionMode
    && (persistedState.target_review_protocol === undefined
      || persistedState.target_review_protocol === "same-agent-self-review/v1")
    && !persistedState.coverage_recheck
    && currentRepair.repair_source !== "coverage"
  ) {
    persistedState = await workspace.updateState((state) => {
      state.target_review_protocol = DIRECT_VALIDATION_PROTOCOL;
    });
    await workspace.appendEvent("target_review_protocol_selected", {
      protocol: DIRECT_VALIDATION_PROTOCOL,
      reason: "live target commits with compiler/strict validation and seals directly",
    });
  }
  const persistedCoverageFingerprint = persistedState.coverage_recheck?.plan_fingerprint ?? "";
  const persistedCoverageSourceFingerprint = persistedState.coverage_recheck?.source_plan_fingerprint ?? "";
  const coverageRecoveryFingerprint = coverageRepairRecoveryFingerprint({
    last_valid_fingerprint: persistedState.last_valid_fingerprint,
    coverage_recheck_plan_fingerprint: persistedCoverageFingerprint,
    coverage_recheck_source_plan_fingerprint: persistedCoverageSourceFingerprint,
  });
  const sealedCoverageReview = recoveringCoverageFailure && persistedCoverageFingerprint
    ? await readSealedCoverageReview(
        workspace,
        coverageRecoveryFingerprint,
        controller.evidence,
      )
    : undefined;
  const sealedRepairReviewFingerprint = sealedCoverageReview?.status === "repair"
    && sealedCoverageReview.findings.some((finding) => finding.finding_type === "semantic_coverage_gap")
    ? coverageRecoveryFingerprint
    : "";
  const coverageRepairRoute = coverageRepairSessionRoute({
    recovering_coverage_failure: recoveringCoverageFailure,
    ...(persistedCoverageFingerprint
      ? { coverage_recheck_plan_fingerprint: coverageRecoveryFingerprint }
      : {}),
    ...(sealedRepairReviewFingerprint
      ? { sealed_repair_review_fingerprint: sealedRepairReviewFingerprint }
      : {}),
    repair: currentRepair,
  });
  if (coverageRepairRoute === "restore_coverage_repair") {
    currentRepair = await controller.beginCoverageRepair(
      coverageRecoveryFingerprint,
    );
    await workspace.appendEvent("coverage_repair_checkpoint_resumed", {
      plan_fingerprint: coverageRecoveryFingerprint,
      finding_ids: currentRepair.coverage_finding_ids ?? [],
      evidence_ids: currentRepair.coverage_evidence_ids ?? [],
      reason: "durable coverage transaction outranks legacy validated-checkpoint sealing",
    });
  }
  if (
    coverageRepairRoute === "normal"
    &&
    persistedState.last_valid_fingerprint
    && !(await pathExists(workspace.manifestPath))
  ) {
    const terminal = await controller.dispatch("seal_validated_plan", {
      fingerprint: persistedState.last_valid_fingerprint,
    });
    const reviewPlanFingerprint = sealCoverageHandoffFingerprint(terminal);
    if (terminal.ok || reviewPlanFingerprint) {
      return {
        session_id: persistedState.agent_runtime.kind === "pi-sdk"
          ? persistedState.agent_runtime.session_id
          : "persisted-valid-checkpoint",
        session_file: persistedState.agent_runtime.kind === "pi-sdk"
          ? persistedState.agent_runtime.session_file
          : "",
        sealed: terminal.ok && await pathExists(workspace.manifestPath),
        model: `${selected.provider}/${selected.modelId}`,
        ...(reviewPlanFingerprint
          ? { review_required: true, review_plan_fingerprint: reviewPlanFingerprint }
          : {}),
      };
    } else if (terminal.error === "coverage_harness_defect") {
      return {
        session_id: persistedState.agent_runtime.kind === "pi-sdk"
          ? persistedState.agent_runtime.session_id
          : "persisted-valid-checkpoint",
        session_file: persistedState.agent_runtime.kind === "pi-sdk"
          ? persistedState.agent_runtime.session_file
          : "",
        sealed: false,
        model: `${selected.provider}/${selected.modelId}`,
        error: `coverage_harness_defect: ${String(terminal.summary ?? "")}; findings=${JSON.stringify(terminal.findings ?? [])}`,
      };
    }
  }

  if (
    currentRepair.mode === "repair"
    && currentRepair.repair_source !== "coverage"
  ) {
    const preflight = await controller.dispatch("validate_working_plan", {});
    if (preflight.ok && typeof preflight.fingerprint === "string") {
      const terminal = await controller.dispatch("seal_validated_plan", {
        fingerprint: preflight.fingerprint,
      });
      const reviewPlanFingerprint = sealCoverageHandoffFingerprint(terminal);
      if (terminal.ok || reviewPlanFingerprint) {
        return {
          session_id: persistedState.agent_runtime.kind === "pi-sdk"
            ? persistedState.agent_runtime.session_id
            : "deterministic-repair-preflight",
          session_file: persistedState.agent_runtime.kind === "pi-sdk"
            ? persistedState.agent_runtime.session_file
            : "",
          sealed: terminal.ok && await pathExists(workspace.manifestPath),
          model: `${selected.provider}/${selected.modelId}`,
          ...(reviewPlanFingerprint
            ? { review_required: true, review_plan_fingerprint: reviewPlanFingerprint }
            : {}),
        };
      }
    }
    currentRepair = await controller.repairStatus();
  }
  const sourceHandles = await ModelSourceHandles.open(workspace.root);
  const sourceHandleSessionMismatch = persistedState.agent_runtime.kind === "pi-sdk"
    && !await sourceHandleSessionFileMatches(persistedState.agent_runtime.session_file,sourceHandles.scope);
  const forceFreshRepairSession = requiresFreshProviderSession(currentRepair);
  const interruptedToolCallSession = resume
    && persistedState.agent_runtime.kind === "pi-sdk"
    && piSessionRequiresFreshStart(persistedState.agent_runtime.session_file);
  const forceFreshSession = forceFreshRepairSession || interruptedToolCallSession || sourceHandleSessionMismatch;
  currentRepair = forceFreshSession
    ? await controller.beginFreshRepairSession(forceFreshRepairSession ? "repair_restart" : "mechanical")
    : currentRepair;
  if (interruptedToolCallSession) {
    await workspace.appendEvent("pi_interrupted_tool_call_session_retired", {
      prior_session_id: persistedState.agent_runtime.kind === "pi-sdk"
        ? persistedState.agent_runtime.session_id
        : "",
      reason: "active session branch ended with a tool call that has no durable tool result",
      recovery_authority: decisionMode ? "working.target-selectors.json" : "working.semantic-source-plan.json",
    });
  }
  if (sourceHandleSessionMismatch) await workspace.appendEvent("pi_source_handle_session_restarted", {
    reason: "A different or legacy source-handle scope cannot share provider history; resume canonical artifacts in a fresh session.",
    source_handle_scope: sourceHandles.scope, prior_session_id: persistedState.agent_runtime.session_id,
  });

  const targetModelingBudget = decisionMode ? new TargetModelingPhaseBudget() : undefined;


  const systemPrompt = `${decisionMode ? TARGET_SELECTOR_SYSTEM_PROMPT : SYSTEM_PROMPT}\n\n${SOURCE_HANDLE_INSTRUCTION}\n当前 source_handle_scope： ${sourceHandles.scope}.`;
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.root,
    agentDir: localAgentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();
  const sessionManager = resume && !forceFreshSession
    ? SessionManager.continueRecent(workspace.root, workspace.piSessionDirectory)
    : SessionManager.create(workspace.root, workspace.piSessionDirectory);
  if (!sourceHandleSessionMatches(sessionManager.getEntries(),sourceHandles.scope)) sessionManager.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY,{scope:sourceHandles.scope});
  const sourceHandleTools = sourceHandles.wrapTools(createPiTools(controller));
  const targetTools = decisionMode && targetModelingBudget
    ? withTargetModelingPhaseBudget(
         sourceHandleTools,
        targetModelingBudget,
        () => controller.selectorProviderPolicy().stage,
        (decision) => persistTargetModelingPhaseBudgetOutcome(workspace, decision),
      )
    : sourceHandleTools;
  const customTools = withToolExecutionTimeout(targetTools);
  const { session } = await createAgentSession({
    cwd: workspace.root,
    agentDir: localAgentDir,
    modelRuntime,
    model,
    thinkingLevel: configured?.effort ?? "medium",
    noTools: "builtin",
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager: outerTransportSessionSettings(workspace.root, localAgentDir),
  });
  const unbindAbort = bindAbortSignal(signal, session);
  if (decisionMode) installSelectorSessionContractBoundary(session.agent,
    async () => Boolean((await workspace.readState()).last_valid_fingerprint),
    delivery => workspace.appendEvent("pi_selector_contract_request_context", delivery).then(() => undefined));
  await workspace.setRuntime({
    kind: "pi-sdk",
    session_id: session.sessionId,
    session_file: session.sessionFile ?? "",
  });
  await workspace.appendEvent("pi_system_prompt", {
    role: "system",
    content: systemPrompt,
  });
  await recordPiModelRequestContract(workspace, preset, configured);
  installProviderPayloadObserver(session, workspace, decisionMode ? () => controller.selectorProviderPolicy() : undefined, sourceHandles);
  await workspace.appendEvent("pi_sdk_capture_policy", {
    omitted_event_types: ["message_update"],
    reason: "Streaming deltas repeat cumulative messages; message_start/message_end and the Pi session JSONL remain authoritative.",
    session_file: session.sessionFile ?? "",
  });

  let eventQueue = Promise.resolve();
  let runError = "";
  let sourceWaiting: ExternalSourceRequest | undefined;
  let runBlockerCode = "";
  let runFailureClass: TargetFailureClass | undefined;
  let abortAfterTerminalToolRequested = false;
  let reviewPlanFingerprint = "";
  let resolveSealCompleted!: () => void;
  const sealCompleted = new Promise<void>((resolveSeal) => {
    resolveSealCompleted = resolveSeal;
  });
  let resolveReviewRequired!: () => void;
  const reviewRequired = new Promise<void>((resolveReview) => {
    resolveReviewRequired = resolveReview;
  });
  let resolveRepairRestart!: () => void;
  const repairRestartRequired = new Promise<void>((resolveRestart) => {
    resolveRepairRestart = resolveRestart;
  });
  let resolveTerminalFailure!: (outcome: PromptRoundOutcome) => void;
  const terminalFailure = new Promise<PromptRoundOutcome>((resolveFailure) => {
    resolveTerminalFailure = resolveFailure;
  });
  const selectorDraftFingerprint = decisionMode
    ? selectorDraftFingerprintFromSource(await readFile(workspace.workingSelectorPath, "utf8"))
    : "";
  const selectorPreflightHandoff = decisionMode && resume
    ? await restoreSelectorCompletedPreflightHandoff(workspace.transcriptPath, selectorDraftFingerprint)
    : new SelectorCompletedPreflightHandoff();
  if (decisionMode && !resume) selectorPreflightHandoff.setDraftFingerprint(selectorDraftFingerprint);
  const unsubscribe = session.subscribe((event) => {
    const captured = capturePiSdkEvent(event);
    if (captured === undefined) return;
    targetModelingBudget?.observeSdkEvent(captured);
    if (decisionMode) selectorPreflightHandoff.observe(captured);
    eventQueue = eventQueue.then(() =>
      workspace.appendEvent("pi_sdk_event", captured).then(() => undefined),
    );
    if (
      !abortAfterTerminalToolRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && (captured as { toolName?: unknown }).toolName === "seal_validated_plan"
      && (captured as { result?: { details?: { ok?: unknown } } }).result?.details?.ok === true
    ) {
      abortAfterTerminalToolRequested = true;
      resolveSealCompleted();
      void session.abort().catch(() => undefined);
    } else if (
      !abortAfterTerminalToolRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && (captured as { toolName?: unknown }).toolName === "seal_validated_plan"
      && sealCoverageHandoffFingerprint(
        (captured as { result?: { details?: unknown } }).result?.details,
      )
    ) {
      reviewPlanFingerprint = sealCoverageHandoffFingerprint(
        (captured as { result?: { details?: unknown } }).result?.details,
      );
      abortAfterTerminalToolRequested = true;
      resolveReviewRequired();
      void session.abort().catch(() => undefined);
    } else if (
      !abortAfterTerminalToolRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && freshSessionRestartFromTool(
        (captured as { result?: { details?: unknown } }).result?.details,
      )
    ) {
      abortAfterTerminalToolRequested = true;
      resolveRepairRestart();
      void session.abort().catch(() => undefined);
    } else if (
      !abortAfterTerminalToolRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
    ) {
      const details = (captured as { result?: { details?: Record<string, unknown> } }).result?.details;
      const terminalFailure = terminalToolFailure(details);
      if (details?.status === "waiting_for_source" && details.waiting_for_source) {
        sourceWaiting = details.waiting_for_source as unknown as ExternalSourceRequest;
        abortAfterTerminalToolRequested = true;
        resolveTerminalFailure({ kind: "terminal_failure", error: "waiting_for_external_source" });
        void session.abort().catch(() => undefined);
      } else if (terminalFailure) {
        abortAfterTerminalToolRequested = true;
        runError = terminalFailure.error;
        runBlockerCode = terminalFailure.blocker_code ?? "";
        runFailureClass = terminalFailure.failure_class;
        eventQueue = eventQueue.then(() => workspace.markTerminal("failed", terminalFailure.error, {
          ...(terminalFailure.blocker_code ? { blocker_code: terminalFailure.blocker_code } : {}),
          ...(terminalFailure.failure_class ? { failure_class: terminalFailure.failure_class } : {}),
        }));
        resolveTerminalFailure({ kind: "terminal_failure", error: terminalFailure.error });
        void session.abort().catch(() => undefined);
      }
    }
  });
  try {
    const repairPrompt = (repair: typeof currentRepair) => targetRepairPrompt(repair, decisionMode);
    const selectorStartup = await sourceHandles.encode(controller.selectorStartupContext()) as ReturnType<ToolController["selectorStartupContext"]>;
    const repairWork = decisionMode ? await sourceHandles.encode(await controller.selectorRepairWork()) as Awaited<ReturnType<ToolController["selectorRepairWork"]>> : undefined;
    const initialPromptBase = decisionMode
        ? targetSelectorStartupPrompt({
          job_id: workspace.jobId,
          target_id: workspace.targetId,
          recovering_coverage_failure: recoveringCoverageFailure
            || (currentRepair.mode === "repair" && currentRepair.repair_source === "coverage"),
          resume,
          current_selector_state: selectorStartup.current_selector_state,
          current_selector_checkpoint: selectorStartup.current_selector_checkpoint,
          ...(selectorStartup.inherited_stage_retry
            ? { inherited_stage_retry: selectorStartup.inherited_stage_retry }
            : {}),
          ...(repairWork ? { resume_focus: [{ code: repairWork.code, path: repairWork.path,
            next_tool: repairWork.diagnostic_read.tool, next_tool_arguments: repairWork.diagnostic_read.arguments,
            ...(repairWork.record_read ? { record_read: repairWork.record_read } : {}),
            how_to_pass: repairWork.instruction }] }
            : selectorStartup.resume_focus ? { resume_focus: selectorStartup.resume_focus }
            : {}),
          ...(selectorStartup.historical_repair_navigation
            ? { historical_repair_navigation: selectorStartup.historical_repair_navigation }
            : {}),
          selector_blocker_handoff: repairWork
            ? `当前持久化待办：${JSON.stringify(repairWork)}。历史诊断、检查点和计数保留；先完成这项及直接依赖，不为恢复旧页重新通读目录或保存全局调查笔记。`
            : await controller.selectorBlockingSummary(),
          unstarted_selector_verified: selectorStartup.current_selector_state === "blank"
            && await workspace.hasUnstartedSelectorCheckpoint(),
        })
        : recoveringTransportFailure
        ? "模型流中断后开启恢复会话。当前工作计划是唯一持久化检查点，保留每个已存检验批和项目，立即补写下一小组完整遗漏（最多四项）。不在聊天中重述全计划，不重建已完成部分，继续至验证和封存成功。"
        : recoveringCoverageFailure
        ? "基于已持久化目标开启覆盖修复会话。读取当前工作计划、计划契约和独立覆盖复核，修复最终检验批及叶子中的每项精确意见，包括正式行模板未列出的独立可执行条款/引用表分支。不能仅因 formal_rows 没有就保留遗漏。验证后以成功指纹调用一次 seal_validated_plan，交给独立复核；复核尚不存在时不要轮询 read_coverage_review，批编排器会运行复核，仅有剩余意见时再恢复你。"
        : resume
        ? "恢复存量作者计划，先读 get_plan_contract 和持久化工作文件，按当前实际验证/修复状态继续；仅在已有协议要求时交接独立覆盖复核。"
        : `为 job ${workspace.jobId}、target ${workspace.targetId} 建立并封存语义来源计划。`;
    const stagePrompt = decisionMode
      ? targetSelectorStagePrompt(controller.selectorProviderPolicy().stage)
      : "";
    const recoveredPreflightNote = decisionMode
      ? selectorPreflightHandoff.continuationNote(selectorDraftFingerprint)
      : "";
    const externalSourceNote = controller.externalSourceWorkflow ? "外部引用按 get_target_selector_contract.authoring_protocols.references 的字段与登记层级政策执行；当前实际资料状态优先于历史交接。" : "";
    const feedbackNote = controller.userFeedback
      ? `本轮人工反馈（修改意图，不能替代规范原文）：\n${controller.userFeedback}\n按真实来源定向修订本目标涉及项目及共享引用，保留其他正确 keyed 记录；完成整目标严格验证。`
      : "";
    const discoveryContext = decisionMode ? await controller.discoveryContextPage() : undefined;
    const discoveryContextNote = discoveryContext?.status === "available" && Number(discoveryContext.total) > 0
      ? `<discovery_context_candidates>\n${JSON.stringify(await sourceHandles.encode({ ...discoveryContext, source_handle_scope: sourceHandles.scope }))}\n</discovery_context_candidates>` : "";
    const initialPrompt = [initialPromptBase, stagePrompt, externalSourceNote, feedbackNote, repairPrompt(currentRepair), recoveredPreflightNote, discoveryContextNote]
      .filter(Boolean)
      .join("\n\n");
    const continuationPrompt = async () => {
      const repair = await controller.repairStatus();
      const activeRepairPrompt = repairPrompt(repair);
      return activeRepairPrompt || (decisionMode
        ? targetLengthContinuationPrompt()
        : "上一轮仅因输出长度上限结束。不得拼接、重建或重复截断的文字、JSON 或工具调用。重新读取持久化计划作为唯一检查点，仅补下一组完整遗漏：最多四个新增/修改验收项及少量相关字段、语义证据。不得替换或重述全计划，也不重建已完成部分；持久化计划完整后验证并封存。");
    };
    const completedContinuationPrompt = async () => {
      const repair = await controller.repairStatus();
      const work = decisionMode ? await controller.selectorRepairWork() : undefined;
      if (!decisionMode) return ["继续存量工作计划至当前协议的终态；保留已保存记录及计数。", repairPrompt(repair)].filter(Boolean).join("\n\n");
      const note = work && !selectorPreflightHandoff.hasCurrentWriteFailure() ? ""
        : selectorPreflightHandoff.continuationNote(selectorDraftFingerprintFromSource(await readFile(workspace.workingSelectorPath, "utf8")), true);
      return targetCompletedContinuationPrompt({ stage: controller.selectorProviderPolicy().stage,
        ...(work && !note ? { current_work: await sourceHandles.encode(work) } : {}),
        ...(note ? { preflight_note: note } : {}),
        ...(!work ? { blocking_summary: await controller.selectorBlockingSummary() } : {}),
      });
    };
    const recoverStream = createStreamRecoveryRunner({
      ...(signal ? { signal } : {}),
      onRecovery: event => workspace.appendEvent("pi_stream_recovery", event).then(() => undefined),
    });
    const promptLoop = await runLengthContinuationLoop({
      initialPrompt,
      continuationPrompt,
      completedContinuationPrompt,
      ...(signal ? { signal } : {}),
      ...(decisionMode ? { maxLengthContinuations: 3 } : {}),
      ...(decisionMode ? { observeBlockingProgress: (before: DurablePromptSnapshot, after: DurablePromptSnapshot) =>
        before.repair_work_issues?.length || after.repair_work_issues?.length
          ? controller.recordSelectorRepairProgress(before.repair_work_issues ?? [], after.repair_work_issues ?? [])
          : controller.recordSelectorBlockingProgress(before.blocking_issues, after.blocking_issues) } : {}),
      promptRound: (originalPrompt) => recoverStream(originalPrompt, async (prompt) => {
        const contractContext = decisionMode ? selectorSessionContractContext(prompt, session.messages,
          Boolean((await workspace.readState()).last_valid_fingerprint)) : undefined;
        if (contractContext) {
          const { prompt: _content, ...delivery } = contractContext;
          await workspace.appendEvent("pi_selector_contract_context", delivery);
        }
        const promptTask = promptWithStreamWatchdog(session, contractContext?.prompt ?? prompt, signal, customTools);
        const outcome = await Promise.race([
          promptTask,
          sealCompleted.then(() => ({ kind: "sealed" as const })),
          reviewRequired.then(() => ({ kind: "review_required" as const })),
          repairRestartRequired.then(() => ({ kind: "repair_restart" as const })),
          terminalFailure,
        ]);
        await eventQueue;
        return outcome;
      }),
      lastAssistant: () => [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant"),
      snapshot: async () => {
        const [state, workingPlan] = await Promise.all([
          workspace.readState(),
          readFile(decisionMode ? workspace.workingSelectorPath : workspace.workingPlanPath, "utf8"),
        ]);
        const workingPlanSha256 = sha256Text(workingPlan);
        const issueFingerprint = state.repair?.active_cluster?.issue_fingerprint
          || state.selector_protocol?.last_issue_fingerprint || "";
        const checkpoint = sha256Text(JSON.stringify({
          working_plan_sha256: workingPlanSha256,
          selector_stage: state.selector_stage,
          last_valid_fingerprint: state.last_valid_fingerprint,
          issue_fingerprint: issueFingerprint,
        }));
        return {
          checkpoint,
          working_plan_sha256: workingPlanSha256,
          history_sequence: state.next_history_sequence,
          last_valid_fingerprint: state.last_valid_fingerprint,
          issue_fingerprint: issueFingerprint,
          ...(state.selector_stage ? { selector_stage: state.selector_stage } : {}),
          ...(decisionMode ? { blocking_issues: await controller.selectorBlockingIssues(),
            repair_work_issues: await controller.selectorRepairWorkSnapshot() } : {}),
        };
      },
      shouldContinueAfterCompleted: async () => {
        if (await pathExists(workspace.manifestPath)) return false;
        const repair = await controller.repairStatus();
        if (decisionMode) return !repair.fresh_session_required;
        return repair.mode === "repair"
          && repair.active_cluster !== null
          && !repair.fresh_session_required;
      },
      onLength: async (event) => {
        if (decisionMode) await controller.recordSelectorTransportFailure("provider_output_length");
        await workspace.appendEvent("pi_length_continuation", {
          ...event,
          policy: {
            same_session: true,
            truncated_output_discarded: true,
            ...targetContinuationPatchPolicy(decisionMode),
          },
        });
      },
      onCompletedContinuation: async (event) => {
        await workspace.appendEvent("pi_incomplete_repair_continuation", {
          ...event,
          repair: await controller.repairStatus(),
          policy: {
            same_session: true,
            local_completion_is_not_target_completion: true,
            ...targetContinuationPatchPolicy(decisionMode),
          },
        });
      },
    });
    const outcome = promptLoop.outcome;
    if (
      outcome.kind === "sealed"
      || outcome.kind === "review_required"
      || outcome.kind === "repair_restart"
      || outcome.kind === "terminal_failure"
    ) {
      await session.abort().catch(() => undefined);
      if (outcome.kind === "repair_restart") {
        const repair = await controller.repairStatus();
        runError = repair.mode === "modeling"
          ? "repair_session_restart_required: observed modeling context is full; continue from the durable selector checkpoint in a fresh provider session"
          : "repair_session_restart_required: two consecutive repair rounds failed to reduce the active validation issue cluster";
      } else if (outcome.kind === "terminal_failure") {
        runError = outcome.error;
      }
    } else if (outcome.kind === "failed") {
      const failure = outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
      if (decisionMode && isProviderContextTooLargeError(failure)) {
        const checkpoint = await targetModelingCheckpointSnapshot(workspace);
        runError = `target_modeling_provider_context_exceeded: ${JSON.stringify({
          selector_stage: controller.selectorProviderPolicy().stage,
          provider_error: failure,
          durable_checkpoint: checkpoint,
        })}`;
        await workspace.appendEvent("target_modeling_provider_context_exceeded", {
          error: runError,
          provider_error: failure,
          selector_stage: controller.selectorProviderPolicy().stage,
          durable_checkpoint: checkpoint,
          terminal: true,
          automatic_rollover: false,
        });
        await workspace.markTerminal("failed", runError);
      } else {
        if (!(await pathExists(workspace.manifestPath))) throw outcome.error;
        if (!abortAfterTerminalToolRequested) runError = failure;
      }
    }
    await eventQueue;
    const terminalAssistantError = promptLoop.error;
    if (/provider stream error: stream closed before response completed/u.test(terminalAssistantError)) {
      // The provider stream died mid-generation; record the retirement for the
      // transcript audit before the transport retry reopens a fresh session.
      await workspace.appendEvent("pi_provider_stream_error", {
        error: terminalAssistantError,
        session_id: session.sessionId,
        session_file: session.sessionFile ?? "",
      });
    }
    if (
      outcome.kind === "completed"
      && !abortAfterTerminalToolRequested
      && !terminalAssistantError
      && !(await pathExists(workspace.manifestPath))
    ) {
      const state = await workspace.readState();
      if (state.last_valid_fingerprint) {
        // Some models finish their response immediately after a successful validation
        // and omit the final deterministic seal request. Advance that persisted valid
        // checkpoint through the normal gate instead of rerunning the whole candidate.
        // The seal tool enforces the selected review protocol: fresh targets require the
        // direct validation, while legacy coverage revisions retain their existing handoff.
        const terminal = await controller.dispatch("seal_validated_plan", {
          fingerprint: state.last_valid_fingerprint,
        });
        if (terminal.ok) {
          abortAfterTerminalToolRequested = true;
        } else if (sealCoverageHandoffFingerprint(terminal)) {
          reviewPlanFingerprint = sealCoverageHandoffFingerprint(terminal);
          abortAfterTerminalToolRequested = Boolean(reviewPlanFingerprint);
        } else if (terminal.error === "coverage_harness_defect") {
          runError = `coverage_harness_defect: ${String(terminal.summary ?? "")}; findings=${JSON.stringify(terminal.findings ?? [])}`;
        } else {
          runError = JSON.stringify(terminal);
        }
      } else {
        const repair = await controller.repairStatus();
        if (repair.mode === "repair" && repair.fresh_session_required) {
          runError = "repair_session_restart_required: repair convergence policy requires a fresh session";
        } else if (repair.mode === "repair") {
          runError = `incomplete_repair_state: assistant stopped with remaining cluster ${JSON.stringify(repair.active_cluster)}`;
        } else if (decisionMode) {
          runError = `incomplete_target_selector_state: assistant stopped before compiler validation and sealing; mode=${repair.mode}`;
        }
      }
    }
    if (!abortAfterTerminalToolRequested) {
      runError ||= terminalAssistantError;
    }
  } finally {
    unbindAbort();
    unsubscribe();
    session.dispose();
  }
  signal?.throwIfAborted();
  return {
    session_id: session.sessionId,
    session_file: session.sessionFile ?? "",
    sealed: await pathExists(workspace.manifestPath),
    model: `${selected.provider}/${selected.modelId}`,
    ...(reviewPlanFingerprint
      ? { review_required: true, review_plan_fingerprint: reviewPlanFingerprint }
      : {}),
    ...(runError ? { error: runError } : {}),
    ...(runBlockerCode ? { blocker_code: runBlockerCode } : {}),
    ...(runFailureClass ? { failure_class: runFailureClass } : {}),
    ...(sourceWaiting ? { waiting_for_source: sourceWaiting } : {}),
  };
}

export function outerTransportSessionSettings(cwd: string, agentDir: string): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir);
  // In-memory overrides only: the batch/discovery transport controller owns
  // retries and the progress-aware streak. SDK/provider loops multiply it.
  settings.applyOverrides({ retry: { enabled: false, provider: { maxRetries: 0 } } });
  return settings;
}

export async function runLiveConstrainedSession(
  workspace: {
    root: string;
    appendEvent(eventType: string, payload: unknown): Promise<void>;
  },
  options: {
    resume: boolean;
    signal?: AbortSignal;
    systemPrompt: string;
    sessionDirectory: string;
    terminalTool: string;
    prompt: string;
    images?: PromptOptions['images'];
    /** Native read tools may return image attachments after the initial prompt. */
    imageTools?: boolean;
    customTools: ToolDefinition[];
    setRuntime: (runtime: { kind: "pi-sdk"; session_id: string; session_file: string }) => Promise<void>;
    completed: () => Promise<boolean>;
    durableSnapshot?: () => Promise<DurablePromptSnapshot>;
    lengthContinuationPrompt?: string;
    maxLengthContinuations?: number;
    handoffWhen?: (capturedEvent: unknown) => boolean;
    modelStage: PiAgentModelStage;
    modelConfig?: PiAgentRuntimeModelConfig;
    effortOverride?: PiAgentEffort;
    telemetryPhase?: string;
    captureCatalogOutput?: boolean;
    skillPaths?: string[];
    toolTimeouts?: Readonly<Record<string, number>>;
    recoverInvalidOutput?: boolean;
    sourceHandles?: boolean;
    continueUntilTerminal?: boolean;
    completedContinuationPrompt?: string | (() => Promise<string>);
    observeEvent?: (event: unknown) => void;
    maxContextTokens?: number;
    contextReady?: (tokens: number) => void;
  },
): Promise<{
  session_id: string;
  session_file: string;
  completed: boolean;
  model: string;
  error?: string;
  terminal_failure?: boolean;
  handoff_requested?: boolean;
}> {
  const { resume, signal } = options;
  signal?.throwIfAborted();
  const { localAgentDir, modelRuntime, model, preset, configured, selected } = await configuredModel(
    workspace.root,
    options.modelStage,
    options.modelConfig,
    options.effortOverride,
    Boolean(options.images?.length || options.imageTools),
  );
  const sourceHandles = options.sourceHandles === false ? undefined : await ModelSourceHandles.open(workspace.root);
  const systemPrompt = sourceHandles
    ? `${options.systemPrompt}\n\n${SOURCE_HANDLE_INSTRUCTION}\n当前 source_handle_scope： ${sourceHandles.scope}.`
    : options.systemPrompt;
  const telemetry = new PiSessionTelemetry(options.telemetryPhase ?? options.modelStage, systemPrompt);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.root,
    agentDir: localAgentDir,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: options.skillPaths ?? [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();
  let sessionManager = resume
    ? SessionManager.continueRecent(workspace.root, options.sessionDirectory)
    : SessionManager.create(workspace.root, options.sessionDirectory);
  if (resume && sourceHandles && !sourceHandleSessionMatches(sessionManager.getEntries(),sourceHandles.scope)) {
    sessionManager = SessionManager.create(workspace.root, options.sessionDirectory);
    await workspace.appendEvent("pi_source_handle_session_restarted",{source_handle_scope:sourceHandles.scope,reason:"Provider history belongs to a different or legacy source-handle scope; canonical workfiles remain authoritative."});
  }
  if (sourceHandles && !sourceHandleSessionMatches(sessionManager.getEntries(),sourceHandles.scope)) sessionManager.appendCustomEntry(SOURCE_HANDLE_SESSION_ENTRY,{scope:sourceHandles.scope});
  const customTools = withToolExecutionTimeout(
    withPiSessionTelemetry(sourceHandles ? sourceHandles.wrapTools(options.customTools) : options.customTools, telemetry),
    LOCAL_TOOL_TIMEOUT_MS, COOPERATIVE_LOCAL_TOOL_TIMEOUT_NAMES, options.toolTimeouts,
  );
  const contextPolicy = options.maxContextTokens === undefined ? undefined : constrainedContextSettings(model, options.maxContextTokens);
  const contextSettings = contextPolicy ? SettingsManager.create(workspace.root, localAgentDir) : undefined;
  contextSettings?.applyOverrides({ compaction: contextPolicy!.compaction });
  const { session } = await createAgentSession({
    cwd: workspace.root,
    agentDir: localAgentDir,
    modelRuntime,
    model: contextPolicy?.model ?? model,
    thinkingLevel: configured?.effort ?? options.effortOverride ?? "medium",
    noTools: "builtin",
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    sessionManager,
    ...(contextSettings ? { settingsManager: contextSettings } : ["discovery", "discovery_review"].includes(options.modelStage)
      ? { settingsManager: outerTransportSessionSettings(workspace.root, localAgentDir) } : {}),
  });
  const unbindAbort = bindAbortSignal(signal, session);
  await options.setRuntime({
    kind: "pi-sdk",
    session_id: session.sessionId,
    session_file: session.sessionFile ?? "",
  });
  await workspace.appendEvent("pi_system_prompt", {
    role: "system",
    content: systemPrompt,
  });
  await recordPiModelRequestContract(workspace, preset, configured);
  installProviderPayloadObserver(session, workspace, undefined, sourceHandles, telemetry);
  await workspace.appendEvent("pi_sdk_capture_policy", {
    omitted_event_types: options.captureCatalogOutput ? [] : ["message_update"],
    ...(options.captureCatalogOutput ? { message_updates: 'coalesced_public_deltas' } : {}),
    session_file: session.sessionFile ?? "",
  });

  let eventQueue = Promise.resolve();
  let runError = "";
  let terminalRequested = false;
  let handoffRequested = false;
  let terminalFailure = false;
  let resolveSeal!: () => void;
  const sealed = new Promise<void>((resolve) => { resolveSeal = resolve; });
  const outputStream = options.captureCatalogOutput ? createCatalogOutputStream((event) => {
    eventQueue = eventQueue.then(() => workspace.appendEvent('pi_sdk_event', event));
  }) : undefined;
  const unsubscribe = session.subscribe((event) => {
    if (outputStream?.capture(event)) return;
    const captured = capturePiSdkEvent(event);
    if (captured === undefined) return;
    telemetry.observeSdkEvent(captured);
    options.observeEvent?.(captured);
    if (terminalRequested && eventRecord(captured)?.type === 'message_end'
      && isExpectedTerminalAbortMessage(eventRecord(captured)?.message)) return;
    eventQueue = eventQueue.then(() => workspace.appendEvent("pi_sdk_event", captured));
    if (
      !terminalRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && (captured as { toolName?: unknown }).toolName === options.terminalTool
      && (captured as { result?: { details?: { ok?: unknown } } }).result?.details?.ok === true
    ) {
      terminalRequested = true;
      resolveSeal();
      void session.abort().catch(() => undefined);
    } else if (
      !terminalRequested
      && !handoffRequested
      && captured !== null
      && typeof captured === "object"
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && terminalToolFailure(
        (captured as { result?: { details?: unknown } }).result?.details,
      ) !== undefined
    ) {
      const failure = terminalToolFailure(
        (captured as { result?: { details?: unknown } }).result?.details,
      );
      if (failure) {
        runError = failure.error;
        terminalFailure = true;
        resolveSeal();
        void session.abort().catch(() => undefined);
      }
    } else if (
      !terminalRequested
      && !handoffRequested
      && options.handoffWhen?.(captured) === true
    ) {
      handoffRequested = true;
      resolveSeal();
      void session.abort().catch(() => undefined);
    }
  });
  try {
    if (contextPolicy) {
      signal?.throwIfAborted();
      await workspace.appendEvent('pi_context_window_policy', { max_tokens: contextPolicy.model.contextWindow,
        compaction_threshold: contextPolicy.threshold, ...contextPolicy.compaction, counters_reset: false });
      await prepareConstrainedContext(session, contextPolicy.threshold, tokens => options.contextReady?.(tokens),
        (type, payload) => workspace.appendEvent(type, payload));
      signal?.throwIfAborted();
    }
    const recoverStream = options.recoverInvalidOutput ? createStreamRecoveryRunner({
      ...(signal ? { signal } : {}),
      onRecovery: async (event) => {
        await workspace.appendEvent('pi_stream_recovery', event);
      },
    }) : undefined;
    let promptImages = options.images;
    const attemptPrompt = async (prompt: string): Promise<PromptRoundOutcome> => {
      telemetry.recordPrompt(prompt);
      const images = promptImages;
      promptImages = undefined;
      const promptTask = promptWithStreamWatchdog(session, prompt, signal, [], images);
      const outcome = await Promise.race([
        promptTask,
        sealed.then(() => ({ kind: "sealed" as const })),
      ]);
      outputStream?.flush();
      await eventQueue;
      return outcome;
    };
    const promptRound = (prompt: string) => recoverStream ? recoverStream(prompt, attemptPrompt) : attemptPrompt(prompt);
    const promptLoop = options.durableSnapshot
      ? await runLengthContinuationLoop({
          initialPrompt: options.prompt,
          continuationPrompt: options.lengthContinuationPrompt
            ?? "上一轮受限 Agent 达到输出长度上限。丢弃截断文字和工具调用，重新读取持久化工作文件，只补下一小组完整内容，完成后验证并封存。",
          promptRound,
          lastAssistant: () => [...session.messages]
            .reverse()
            .find((message) => message.role === "assistant"),
          snapshot: options.durableSnapshot,
          ...(options.continueUntilTerminal ? {
            shouldContinueAfterCompleted: async () => !(await options.completed()),
            completedContinuationPrompt: options.completedContinuationPrompt ?? options.lengthContinuationPrompt
              ?? "继续当前任务。先核对已保存的工作状态，完成尚未执行的终结工具；不要仅在对话中声称完成。",
          } : {}),
          ...(options.maxLengthContinuations !== undefined
            ? { maxLengthContinuations: options.maxLengthContinuations }
            : {}),
          ...(signal ? { signal } : {}),
          onLength: async (event) => {
            await workspace.appendEvent("pi_length_continuation", {
              type: "pi_length_continuation",
              ...event,
              policy: {
                same_session: true,
                truncated_output_discarded: true,
              },
            });
          },
          onCompletedContinuation: async (event) => {
            await workspace.appendEvent("pi_completed_continuation", {
              ...event,
              terminal_tool: options.terminalTool,
              policy: { same_session: true, durable_workfile_preserved: true },
            });
          },
        })
      : {
          outcome: await promptRound(options.prompt),
          error: "",
          length_continuations: 0,
        };
    const outcome = promptLoop.outcome;
    if (outcome.kind === "sealed") {
      await session.abort().catch(() => undefined);
    }
    else if (outcome.kind === "failed") {
      if (!(await options.completed())) throw outcome.error;
      runError = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    }
    await eventQueue;
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    runError = constrainedSessionResultError({
      current_error: runError,
      prompt_loop_error: promptLoop.error,
      assistant_error: assistantTerminalError(lastAssistant),
      terminal_requested: terminalRequested,
      handoff_requested: handoffRequested,
      completed: await options.completed(),
      assistant_text: assistantText(lastAssistant),
    });
  } finally {
    unbindAbort();
    unsubscribe();
    outputStream?.flush();
    await eventQueue.catch(() => undefined);
    await workspace.appendEvent("pi_session_telemetry", {
      type: "pi_session_telemetry",
      session_id: session.sessionId,
      session_file: session.sessionFile ?? "",
      ...telemetry.snapshot(),
    }).catch(() => undefined);
    session.dispose();
  }
  signal?.throwIfAborted();
  return {
    session_id: session.sessionId,
    session_file: session.sessionFile ?? "",
    completed: await options.completed(),
    model: `${selected.provider}/${selected.modelId}`,
    ...(runError ? { error: runError } : {}),
    ...(terminalFailure ? { terminal_failure: true } : {}),
    ...(handoffRequested ? { handoff_requested: true } : {}),
  };
}

export const CATALOG_SELF_REVIEW_SYSTEM_PROMPT = `你是独立的 PDF 目录语义自查 Agent。确定性抽取器已经生成记录和异常，但异常提示只是调查线索，不是结论。

必须先读取自查契约，再分页列出所有异常。针对每项异常，打开涉及记录，并打开足够的来源页核对主目录行、实际表单页首和相邻记录。目录项没有提取到页码时，要根据坐标核对同一基线的相邻文本块：原文确实无页码则接受，标题或页码被 PDF 拆块则按完整视觉行修正标题。相同编号不自动证明标题正确：判断它是同一资料的标题别名、标题范围抽错，还是来源本身冲突。不同表单标识却得到相同标题时，必须逐页核对完整标题块；若原文标题确实相同则接受，否则按页面证据修正当前记录标题。无编号短行要结合分页和相邻行判断续接；无编号标题及主分类编号要结合后续记录判断父子关系；注释不能冒充目录文档。

只能使用 record_catalog_decision 支持的有界动作，不得发明编号、标题、记录或页码。不得仅凭常见标题把一个表单挂到多个目录项。每个决定的 evidence_pages 必须包含该异常 sourceRefs 中的全部来源页，且每页均已用 open_catalog_page 打开；不得引用该异常以外的页，并说明可执行理由。处理全部异常后调用 validate_catalog_review，只有零遗漏才能 seal_catalog_review。
${MODEL_OUTPUT_LANGUAGE_GUIDANCE}`;

async function runLiveCatalogReviewBatch(
  input: CatalogReviewRuntimeInput,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{
  sealed: boolean;
  decisions: CatalogReviewRuntimeDecision[];
  model: string;
  error?: string;
}> {
  const controller = await CatalogReviewRuntimeController.create(input);
  const result = await runLiveConstrainedSession({
    root: input.workspaceRoot,
    appendEvent: input.appendEvent ?? (async () => {}),
  }, {
    modelStage: "discovery_review",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    resume: false,
    ...(signal ? { signal } : {}),
    systemPrompt: CATALOG_SELF_REVIEW_SYSTEM_PROMPT,
    sessionDirectory: join(input.workspaceRoot, "pi-session"),
    terminalTool: "seal_catalog_review",
    customTools: createCatalogReviewRuntimeTools(controller),
    prompt: `复核目录任务 ${input.runId}。共有 ${input.anomalies.length} 个由通用规则发现的可疑点。逐项读取证据、记录决定、验证并封存；不要重抄整本 PDF。`,
    setRuntime: async () => {},
    completed: async () => controller.result().sealed,
    durableSnapshot: async () => controller.snapshot(),
    lengthContinuationPrompt: "从持久化目录自查工作文件继续。只处理尚未决定的异常，打开对应证据页，记录决定后验证并封存。",
  });
  const review = controller.result();
  return {
    sealed: review.sealed,
    decisions: review.decisions,
    model: result.model,
    ...(result.error && !review.sealed ? { error: result.error } : {}),
  };
}

export async function runLiveCatalogReview(
  input: CatalogReviewRuntimeInput,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{
  sealed: boolean;
  decisions: CatalogReviewRuntimeDecision[];
  model: string;
  error?: string;
}> {
  if (input.anomalies.length === 0) {
    return { sealed: true, decisions: [], model: "deterministic-no-anomalies" };
  }
  const batchSize = 12;
  const batches = Array.from(
    { length: Math.ceil(input.anomalies.length / batchSize) },
    (_, index) => input.anomalies.slice(index * batchSize, (index + 1) * batchSize),
  );
  const decisions: CatalogReviewRuntimeDecision[] = [];
  const models = new Set<string>();
  for (let index = 0; index < batches.length; index += 1) {
    signal?.throwIfAborted();
    const batchNumber = index + 1;
    const batchInput: CatalogReviewRuntimeInput = {
      ...input,
      workspaceRoot: join(input.workspaceRoot, `batch-${String(batchNumber).padStart(3, "0")}`),
      anomalies: batches[index]!,
      ...(input.appendEvent ? {
        appendEvent: (eventType, payload) => input.appendEvent!(eventType, {
          batch: batchNumber,
          batch_count: batches.length,
          payload,
        }),
      } : {}),
    };
    const result = await runLiveCatalogReviewBatch(batchInput, signal, runtimeConfig);
    decisions.push(...result.decisions);
    models.add(result.model);
    if (!result.sealed) {
      return {
        sealed: false,
        decisions,
        model: [...models].join(" + "),
        error: `Catalog review batch ${batchNumber}/${batches.length} was not sealed: ${result.error ?? "unknown error"}`,
      };
    }
  }
  return {
    sealed: true,
    decisions,
    model: [...models].join(" + "),
  };
}

export async function runLiveCatalogLeafExpansion(
  input: CatalogLeafExpansionRuntimeInput,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{ model: string; error?: string }> {
  const result = await runLiveConstrainedSession({
    root: input.workspaceRoot,
    appendEvent: input.appendEvent ?? (async () => {}),
  }, {
    modelStage: "hierarchy",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    ...(signal ? { signal } : {}),
    resume: false,
    systemPrompt: CATALOG_LEAF_EXPANSION_SYSTEM_PROMPT,
    sessionDirectory: join(input.workspaceRoot, "pi-session"),
    terminalTool: "seal_catalog_leaf_expansion",
    customTools: createCatalogLeafExpansionTools(input.controller),
    prompt: `调查目录任务 ${input.runId} 的叶子。对分部分项递归搜索当前文档并展开，直到检验批或证据穷尽。处理全部动态工作队列后校验和封存。`,
    setRuntime: async () => {},
    completed: async () => input.controller.result().sealed,
    durableSnapshot: async () => input.controller.snapshot(),
    lengthContinuationPrompt: "继续目录叶子调查。先 list_catalog_leaves，从 offset 0 读取剩余及新增叶子，依据来源继续搜索、展开或记录停止原因，直到校验并封存。",
  });
  return { model: result.model, ...(result.error ? { error: result.error } : {}) };
}

export type CatalogAutonomousResumeCheckpoint = {
  resumeSession: boolean;
  reason: 'session_clean' | 'session_missing' | 'session_unreadable'
    | 'session_unresolved_tool_calls' | 'source_handle_scope_mismatch' | 'source_handle_map_missing';
};

/** A durable delivery/source checkpoint can be recovered without replaying unsafe provider history. */
export async function assertCatalogAutonomousResumeCheckpoint(workspaceRoot: string): Promise<CatalogAutonomousResumeCheckpoint> {
  let draft: { structures?: unknown[] };
  let pages: unknown;
  let index: { complete?: unknown; sources?: Array<{ markdown?: unknown }> };
  try {
    [draft, pages, index] = await Promise.all([
      readFile(join(workspaceRoot, 'DELIVERY.json'), 'utf8').then(value => JSON.parse(value)),
      readFile(join(workspaceRoot, 'source', 'pages.json'), 'utf8').then(value => JSON.parse(value)),
      readFile(join(workspaceRoot, 'source', 'markdown', 'index.json'), 'utf8').then(value => JSON.parse(value)),
    ]);
  } catch {
    throw new Error('目录检查点缺少可读取的交付草稿或原文材料；不会重建已有草稿。');
  }
  if (!draft || !Array.isArray(draft.structures) || draft.structures.length === 0) {
    throw new Error('目录检查点没有可继续的 DELIVERY.json 结构草稿。');
  }
  if (!Array.isArray(pages) || pages.length === 0 || !index || index.complete !== true || !Array.isArray(index.sources)) {
    throw new Error('目录检查点的原文分段或 Markdown 索引不完整；不会重建已有草稿。');
  }
  const markdownRoot = resolve(workspaceRoot, 'source', 'markdown');
  const markdownFiles = index.sources.map(source => {
    if (typeof source.markdown !== 'string') return '';
    const path = resolve(workspaceRoot, source.markdown);
    const inside = relative(markdownRoot, path);
    return inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? path : '';
  }).filter(Boolean);
  if (markdownFiles.length === 0 || !(await Promise.all(markdownFiles.map(async path => {
    try { const file = await stat(path); return file.isFile() && file.size > 0; }
    catch { return false; }
  }))).every(Boolean)) {
    throw new Error('目录检查点的完整 Markdown 缺失；不会从头抽取或重建草稿。');
  }

  const mapPath = join(workspaceRoot, '.model-source-handles', 'map.json');
  const ownerPath = join(workspaceRoot, '.model-source-handles', 'owner.json');
  const [hasMap, hasOwner] = await Promise.all([pathExists(mapPath), pathExists(ownerPath)]);
  if (hasMap !== hasOwner) throw new Error('目录检查点的来源句柄映射不完整；请保留现场排查。');
  const map = hasMap ? JSON.parse(await readFile(mapPath, 'utf8')) as { scope?: unknown } : null;
  if (map && (typeof map.scope !== 'string' || !map.scope)) {
    throw new Error('目录检查点的来源句柄作用域无效；请保留现场排查。');
  }
  if (!map) return { resumeSession: false, reason: 'source_handle_map_missing' };

  const sessionDirectory = join(workspaceRoot, 'pi-session');
  let sessionNames: string[];
  try { sessionNames = await readdir(sessionDirectory); }
  catch { return { resumeSession: false, reason: 'session_missing' }; }
  if (!sessionNames.some(name => name.endsWith('.jsonl'))) return { resumeSession: false, reason: 'session_missing' };
  let sessionFile: string | null | undefined;
  try { sessionFile = SessionManager.continueRecent(workspaceRoot, sessionDirectory).getSessionFile(); }
  catch { return { resumeSession: false, reason: 'session_unreadable' }; }
  if (!sessionFile) return { resumeSession: false, reason: 'session_missing' };
  try {
    if (sessionMessagesHaveUnresolvedToolCalls(SessionManager.open(sessionFile).buildSessionContext().messages)) {
      return { resumeSession: false, reason: 'session_unresolved_tool_calls' };
    }
  } catch { return { resumeSession: false, reason: 'session_unreadable' }; }
  if (!await sourceHandleSessionFileMatches(sessionFile, map.scope as string)) {
    return { resumeSession: false, reason: 'source_handle_scope_mismatch' };
  }
  return { resumeSession: true, reason: 'session_clean' };
}

export async function runLiveAutonomousCatalog(
  input: CatalogAutonomousRuntimeInput,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{ model: string; error?: string }> {
  const checkpoint = input.resume
    ? await assertCatalogAutonomousResumeCheckpoint(input.workspaceRoot)
    : undefined;
  if (checkpoint) {
    await input.appendEvent?.('pi_catalog_resume_checkpoint', checkpoint);
    if (!checkpoint.resumeSession) await input.onActivity?.({ kind: 'message', message:
      checkpoint.reason === 'session_unresolved_tool_calls'
        ? '旧 Pi 会话存在未完成工具调用；已保留 DELIVERY 草稿，在同一工作目录启动新会话接力审查。'
        : '旧 Pi 会话无法安全续接；已保留 DELIVERY 草稿，在同一工作目录启动新会话接力审查。' });
  }
  if (!input.controller.setCoverageReviewer) throw new Error('目录控制器未接入覆盖审查，不能启动无防漏门禁的识别。');
  input.controller.setCoverageReviewer(async (request, reviewSignal) => {
    const review = new CatalogCoverageReview({ workspaceRoot: input.workspaceRoot, request,
      openPage: (params, signal) => input.controller.dispatch('open_catalog_page', params, signal) });
    const reviewRoot = join(input.workspaceRoot, 'coverage-review', request.sha256);
    let resume = false;
    let priorSessionFile = '';
    let idleRetriesWithoutProgress = 0;
    const successfulReviewCalls = new UniqueSuccessfulToolCalls();
    while (true) {
      // Provider idle and individual calls have their own watchdogs. This one
      // only expires when the review makes no successful tool call for a while.
      const idle = new ProgressIdleDeadline(8 * 60_000);
      const merged = mergeAbortSignals([signal, reviewSignal, idle.signal]);
      let successfulCalls = 0;
      try {
        const result = await runLiveConstrainedSession({ root: input.workspaceRoot,
          appendEvent: async (type, payload) => {
            if (type === 'pi_sdk_event' && successfulReviewCalls.observe(payload)) {
              successfulCalls += 1;
              idle.progress();
            }
            await input.appendEvent?.(type, payload);
          } }, {
          modelStage: 'target_extraction', ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
          ...(merged.signal ? { signal: merged.signal } : {}),
          resume, sourceHandles: false, systemPrompt: CATALOG_COVERAGE_REVIEW_PROMPT,
          sessionDirectory: reviewRoot, terminalTool: 'submit_catalog_coverage_review',
          customTools: createCatalogCoverageReviewTools(review), captureCatalogOutput: true, recoverInvalidOutput: true,
          telemetryPhase: 'catalog_coverage_review', continueUntilTerminal: true,
          prompt: resume
            ? `继续目录交付 ${request.sha256} 的只读覆盖审查。接着当前会话的来源核对记录调查未决范围，提交结论；不要重读已核对的全部内容。`
            : `独立审查目录交付 ${request.sha256}。从 source/markdown/index.json 和 catalog_review_outline 入手，只读原文反查是否漏项；提交小型审查结论。`,
          setRuntime: async (runtime) => { priorSessionFile = runtime.session_file; },
          completed: async () => Boolean(review.result()),
          durableSnapshot: async () => review.snapshot(), maxLengthContinuations: 2,
          lengthContinuationPrompt: '继续当前只读覆盖审查。保持原文→树方向，发现明确问题即可退回；未审完不能批准，不重写目录。',
        });
        const report = review.result();
        if (!report) throw new Error(`独立覆盖审查未完成，不能封存：${result.error || '未提交审查结论'}。保留草稿后重试。`);
        return report;
      } catch (error) {
        if (signal?.aborted || reviewSignal?.aborted || !idle.signal.aborted) throw error;
        idleRetriesWithoutProgress = successfulCalls > 0 ? 0 : idleRetriesWithoutProgress + 1;
        if (idleRetriesWithoutProgress >= 2 || !priorSessionFile || piSessionRequiresFreshStart(priorSessionFile)) {
          throw new Error('独立覆盖审查长时间无有效进展，或会话检查点不可安全恢复；草稿和审查会话已保留。请检查审查日志后继续，不能跳过审查封存。', { cause: error });
        }
        resume = true;
        await input.appendEvent?.('pi_catalog_review_resumed', { delivery_hash: request.sha256,
          reason: 'idle_timeout', successful_calls: successfulCalls });
      } finally {
        merged.dispose();
        idle.dispose();
      }
    }
  });
  const appendEvent = async (type: string, payload: unknown) => {
    await input.appendEvent?.(type, payload);
    const event = eventRecord(payload);
    if (type === 'pi_stream_recovery' && event) {
      await input.onActivity?.({ kind: 'message', message: event.state === 'retrying'
        ? `检测到模型持续输出无效空白，已中止异常调用；保留草稿，正在进行第 ${event.attempt}/${event.maxAttempts} 次自动恢复。`
        : `模型异常输出已达 ${event.maxAttempts} 次自动恢复上限，停止空转；草稿和日志已保留。` });
    }
    if (type !== 'pi_sdk_event' || !event) return;
    if (event.type === 'tool_execution_end' && event.isError !== true) input.controller.recordToolActivity?.();
    if (event.type === 'tool_execution_start') {
      await input.onActivity?.({ kind: 'tool', message: `Pi 调用 ${String(event.toolName)}。` });
    } else if (event.type === 'message_end') {
      const message = eventRecord(event.message);
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n');
        if (text.trim()) await input.onActivity?.({ kind: 'message', message: text.slice(0, 4000) });
      }
    }
  };
  const result = await runLiveConstrainedSession({ root: input.workspaceRoot, appendEvent }, {
    modelStage: 'target_extraction', ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}), ...(signal ? { signal } : {}),
    captureCatalogOutput: true,
    recoverInvalidOutput: true,
    toolTimeouts: { bash: CATALOG_BASH_TOOL_TIMEOUT_MS, seal_catalog_delivery: Number.POSITIVE_INFINITY },
    ...(input.documentTools ? {
      skillPaths: CATALOG_DOCUMENT_SKILL_PATHS,
    } : {}),
    resume: checkpoint?.resumeSession ?? false, systemPrompt: catalogAutonomousPromptFor(input.sourceKind), sessionDirectory: join(input.workspaceRoot, 'pi-session'),
    terminalTool: 'seal_catalog_delivery', customTools: createCatalogAutonomousTools(input),
    images: input.revisionImages?.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
    prompt: input.revisionMessage?.trim() || input.revisionImages?.length
      ? catalogAutonomousRevisionPromptFor(input.runId, input.revisionMessage ?? '', input.previousMessages)
      : input.repairGoal?.trim()
      ? catalogAutonomousRepairPromptFor(input.runId, input.repairGoal)
      : input.resume
      ? `${checkpoint?.resumeSession ? '继续此前 Pi 会话' : '你是接手旧任务的新 Pi 会话，旧会话历史不安全，不能假定自己已读过它'}。任务 ${input.runId} 的工作目录中保留了 DELIVERY.json、已有脚本、原文材料和审查记录。先检查这些持久化成果及最近的校验/覆盖审查反馈，厘清未决问题。保留已经有证据支持的结构，不要从头抽取或重建。依据原文修正后再 validate_catalog_delivery 和 seal_catalog_delivery；独立审查未通过不能封存。`
      : `完成目录识别任务 ${input.runId}。材料已就绪；请自主选择策略、调查和构建各套结构，按 DELIVERY.md 验收交付。`,
    setRuntime: async () => {}, completed: async () => input.controller.result().sealed,
    durableSnapshot: async () => input.controller.snapshot(),
    continueUntilTerminal: true,
    completedContinuationPrompt: '目录交付尚未封存。读取当前验证和审查反馈，继续修正或调用 seal_catalog_delivery；聊天总结不能代替封存。',
    lengthContinuationPrompt: '继续此目录任务。你的工作目录、脚本、草稿与已读证据仍在；自行检查当前进展并选择下一步，避免重做已完成工作。完成后校验并 seal_catalog_delivery。',
  });
  return { model: result.model, ...(result.error ? { error: result.error } : {}) };
}

export async function runLiveCatalogStructureDiscovery(
  input: CatalogStructureDiscoveryRuntimeInput,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{ model: string; error?: string }> {
  const result = await runLiveConstrainedSession({ root: input.workspaceRoot, appendEvent: input.appendEvent ?? (async () => {}) }, {
    modelStage: "discovery", ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}), ...(signal ? { signal } : {}),
    resume: false, systemPrompt: CATALOG_STRUCTURE_DISCOVERY_PROMPT,
    sessionDirectory: join(input.workspaceRoot, "pi-session"), terminalTool: "seal_catalog_structures",
    customTools: createCatalogStructureDiscoveryTools(input.controller),
    prompt: `调查目录任务 ${input.runId} 中所有独立结构，按原文归属标题分别规划产物。先调查全文启发式地标，再使用全文搜索和精确开页依据证据分组、核对来源、封存。`,
    setRuntime: async () => {}, completed: async () => input.controller.result().sealed,
    durableSnapshot: async () => input.controller.snapshot(),
    lengthContinuationPrompt: "继续多结构调查。读取 get_catalog_structure_state，从 next_survey_offset 继续启发式地标调查，必要时全文搜索并打开精确原页，复核结构边界与候选去向，然后修订并封存 manifest。",
  });
  return { model: result.model, ...(result.error ? { error: result.error } : {}) };
}

export const PDF_LAYOUT_PROFILE_SYSTEM_PROMPT = `你根据与 MinerU Markdown 对齐的代表性原始 PDF 行，学习当前 PDF 特有的版式规则。输入是代表页面上的每一条对齐行，不是预先筛选或标注的业务候选。推导有界规则，区分正式条款、条款内嵌套组成、结构标题及重复页眉页脚。结合原始 PDF 的样式 ID 和从原始样本学到的正则表达式。

封存匹配针对 catalog.pdf_lines[].text（PDF 原始字形文本），不是 Markdown，也不是 candidates[].text。MinerU 常在末尾编号后补空格（5.3.1 施工），也可能把 6. 1.3 合成 6.1.3；原始行可能是 5.3.1施工前 或 6. 1.3地基。role=clause 时，harness 已支持三级及以上编号和点号两侧可选空格；不要要求末位数字后必须有空格。样本失败时，用 inspect_pdf_layout_lines 读取对应 ID，再移除失败的 sample_line_ids 或该规则。保留 passing_rule_ids 中的规则，禁止用包揽一切的 ^.* 规则强行封存。

按 next_cursor 读完代表页，每页只需读一次。目录已经给出真实 PDF 原文和 style_id，不必重复 inspect 已清晰的样本；有疑问或校验拒绝时再检查。每条规则必须引用真实原始 PDF 样本行 ID 和已存在的样式 ID。表达式必须以 ^ 锚定并概括实际观测形式，不得编码某条具体正文。条款组成归属最近的前一个正式条款，不得与章号、表格行号、目录条目或页码混淆。可用结构和页眉页脚规则记录反例。只封存代表页面支持的规则；未知或未见形式保持未提升状态，供后续例外抽查，不得猜测。
${MODEL_OUTPUT_LANGUAGE_GUIDANCE}`;

export async function runLivePdfLayoutProfile(
  workspace: DocumentDiscoveryWorkspace,
  pdfPath: string,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  options: { cacheRoot?: string; effort?: PiAgentEffort; runSession?: typeof runLiveConstrainedSession; buildCatalog?: typeof buildPdfLayoutCatalog } = {},
): Promise<{ profile?: PdfLayoutProfile; model: string; error?: string }> {
  const started = performance.now();
  signal?.throwIfAborted();
  const catalog = await (options.buildCatalog ?? buildPdfLayoutCatalog)(pdfPath, workspace.sourcePath);
  await atomicWriteJson(workspace.pdfLayoutCatalogPath, catalog);
  await workspace.appendEvent("pdf_text_route_decided", {
    document_route: catalog.document_route,
    page_count: catalog.page_count,
    native_page_count: catalog.page_routes.filter((page) => page.route === "native").length,
    ocr_page_count: catalog.page_routes.filter((page) => page.route === "ocr").length,
    page_routes: catalog.page_routes,
  });
  const currentProfile = async (): Promise<PdfLayoutProfile | undefined> => {
    if (!(await pathExists(workspace.pdfLayoutProfilePath))) return undefined;
    const persisted = await readJson<PdfLayoutProfile>(workspace.pdfLayoutProfilePath).catch(() => undefined);
    return persisted ? verifiedPdfLayoutProfile(catalog, persisted) : undefined;
  };
  const publishCache = async (profile: PdfLayoutProfile) => {
    if (!options.cacheRoot) return;
    try { await writePdfLayoutCache(options.cacheRoot, catalog, profile); }
    catch (error) { await workspace.appendEvent("pdf_layout_cache_write_failed", { error: error instanceof Error ? error.message : String(error), usable_local_profile: true }); }
  };
  const persisted = await currentProfile();
  if (persisted) {
    await publishCache(persisted);
    return { profile: persisted, model: "persisted-pdf-layout-profile" };
  }
  if (options.cacheRoot) {
    const cached = await readPdfLayoutCache(options.cacheRoot, catalog);
    signal?.throwIfAborted();
    await workspace.appendEvent("pdf_layout_cache_lookup", { status: cached.status, key: cached.key, provider_requests: 0,
      preparation_elapsed_ms: performance.now() - started });
    if (cached.profile) {
      await atomicWriteJson(workspace.pdfLayoutProfilePath, cached.profile);
      return { profile: cached.profile, model: "cached-pdf-layout-profile" };
    }
  }
  if (catalog.matched_candidate_count === 0 || catalog.sample_pages.length === 0) {
    const error = "pdf_layout_profile_no_aligned_page_samples";
    await workspace.appendEvent("pdf_layout_profile_unavailable", {
      error,
      matched_candidate_count: catalog.matched_candidate_count,
      unmatched_candidate_count: catalog.unmatched_candidate_count,
    });
    return { model: "deterministic-pdf-layout-probe", error };
  }

  const toolResult = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  });
  let sealAttempts = 0;
  const readSamplePages = new Set<number>();
  const readCatalogTool = defineTool({
    name: "read_pdf_layout_catalog",
    label: "读取 PDF 版式样式目录",
    description: "读取有界的原始 PDF 样式分组和代表性对齐条款示例。",
    parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const page = pdfLayoutCatalogPage(catalog, params.cursor ?? 0);
      page.sample_pages.forEach(sample => readSamplePages.add(sample.pdf_page));
      return toolResult(page);
    },
  });
  const inspectLinesTool = defineTool({
    name: "inspect_pdf_layout_lines",
    label: "检查 PDF 版式行",
    description: "读取 seal_pdf_layout_profile 实际用于匹配的原始 PDF 文本和 style_id。",
    parameters: Type.Object({
      line_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16, uniqueItems: true }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId: string, params: unknown) => {
      const value = params as { line_ids: string[] };
      return toolResult(inspectPdfLayoutLines(catalog, value.line_ids));
    },
  });
  const sealProfileTool = defineTool({
    name: "seal_pdf_layout_profile",
    label: "封存 PDF 版式规则",
    description: "封存有样本依据的文档版式规则，并确定性应用到每个已对齐的 Markdown 标题行。",
    parameters: Type.Object({
      rules: Type.Array(Type.Object({
        rule_id: Type.String({ minLength: 1 }),
        role: Type.Union([
          Type.Literal("clause"),
          Type.Literal("clause_component"),
          Type.Literal("structural"),
          Type.Literal("page_furniture"),
        ]),
        pattern: Type.String({ minLength: 1, maxLength: 256 }),
        style_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32, uniqueItems: true }),
        sample_line_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32, uniqueItems: true }),
        reason: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
      summary: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const unread = catalog.sample_pages.filter(page => !readSamplePages.has(page.pdf_page));
        if (unread.length) return toolResult({ ok: false, error: "pdf_layout_samples_unread", unread_pages: unread.map(page => page.pdf_page),
          next_cursor: catalog.sample_pages.indexOf(unread[0]!), instruction: "Call read_pdf_layout_catalog with next_cursor and read all representative samples before sealing. No profile was saved." });
        const value = params as { rules: PdfLayoutRule[]; summary: string };
        const profile = sealPdfLayoutProfile(catalog, value.rules, value.summary);
        await atomicWriteJson(workspace.pdfLayoutProfilePath, profile);
        await workspace.appendEvent("pdf_layout_profile_sealed", {
          rule_count: profile.rules.length,
          promoted_heading_count: profile.promoted_headings.length,
        });
        await publishCache(profile);
        return toolResult({ ok: true, rule_count: profile.rules.length, promoted_heading_count: profile.promoted_headings.length,
          profile_fingerprint: sha256Json(profile), saved: true });
      } catch (error) {
        sealAttempts += 1;
        return toolResult(pdfLayoutSealToolReject(error, sealAttempts));
      }
    },
  });
  const result = await (options.runSession ?? runLiveConstrainedSession)(workspace, {
    resume: false,
    ...(signal ? { signal } : {}),
    systemPrompt: PDF_LAYOUT_PROFILE_SYSTEM_PROMPT,
    sessionDirectory: workspace.pdfLayoutPiSessionDirectory,
    terminalTool: "seal_pdf_layout_profile",
    prompt: "分页读完目录的代表页。用返回的原始 PDF 行学习规则，仅有疑问或失败样本再 inspect；封存有界且有来源支持的规则。匹配使用 pdf_lines 文本，不是 Markdown。",
    customTools: [readCatalogTool, inspectLinesTool, sealProfileTool],
    setRuntime: async (runtime) => {
      await workspace.appendEvent("pdf_layout_profile_runtime", runtime);
    },
    completed: async () => Boolean(await currentProfile()),
    modelStage: "discovery",
    effortOverride: options.effort ?? "low",
    telemetryPhase: "pdf_layout",
    handoffWhen: (captured) => Boolean(
      captured
      && typeof captured === "object"
      && !Array.isArray(captured)
      && (captured as { type?: unknown }).type === "tool_execution_end"
      && (captured as { toolName?: unknown }).toolName === "seal_pdf_layout_profile"
      && (captured as { result?: { details?: { error?: unknown } } }).result?.details?.error === "pdf_layout_profile_seal_attempt_budget_exhausted"
    ),
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
  });
  const profile = await currentProfile();
  return {
    ...(profile ? { profile } : {}),
    model: result.model,
    ...(result.error && !profile ? { error: result.error } : {}),
  };
}

/**
 * 规则发现会话：让模型产出「怎么切目录」的规则，而不是产出目录本身。
 *
 * 只送几 KB 样本（疑似标题行 + 每种 role 的头几条），绝不送全文——送全文就退回
 * 原来那个把附录整本塞进会话的问题了。产出的规则由 verifyReferenceCatalog 在全量
 * 证据上机械验证，不过就带着拒绝理由再问一轮，两轮不成退到确定性分段。
 *
 * 兜底规则能过闸门时这个会话根本不会被拉起——目录本身从来不需要模型。
 */
export function createCatalogRuleAsk(
  workspace: RevisionWorkspace,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  options: { runSession?: typeof runLiveConstrainedSession } = {},
): CatalogRuleAsk {
  return async (
    request: CatalogRuleRequest,
    toolSignal?: AbortSignal,
  ): Promise<ReferenceCatalogRules | undefined> => {
    const merged = mergeAbortSignals([signal, toolSignal]);
    let proposal: ReferenceCatalogRules | undefined;
    const proposeTool = defineTool({
      name: "propose_catalog_rules",
      label: "提出引用目录规则",
      description: "提出四个正则表达式，将当前引用目标分为可选择的目录。仅判断标题形式，不得编码具体表名或条款正文。",
      parameters: Type.Object({
        table_title: Type.String({ minLength: 1, description: "表题行：捕获组 1 为表号，捕获组 2 为表名。" }),
        table_continuation: Type.String({ minLength: 1, description: "续表标记行：捕获组 1 为表号，合并回同一目录条目。" }),
        clause: Type.String({ minLength: 1, description: "条款行：捕获组 1 为条款编号，捕获组 2 为首句。" }),
        subitem: Type.String({ minLength: 1, description: "归属于当前条款的款项行。" }),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: unknown) => {
        const result = catalogRulesProposalResult(params);
        if (result.ok) proposal = result.rules;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
    });

    try {
      merged.signal?.throwIfAborted();
      const directory = join(workspace.root, "catalog-rule-discovery");
      await mkdir(directory, { recursive: true });
      const prompt = catalogRuleDiscoveryUserPrompt(request);
      await (options.runSession ?? runLiveConstrainedSession)({
        root: directory,
        appendEvent: async () => {},
      }, {
        modelStage: "coverage_review",
        ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
        resume: false,
        ...(merged.signal ? { signal: merged.signal } : {}),
        systemPrompt: CATALOG_RULE_DISCOVERY_PROMPT_ZH,
        sessionDirectory: join(directory, "pi-session"),
        terminalTool: "propose_catalog_rules",
        customTools: [proposeTool],
        prompt,
        setRuntime: async () => {},
        completed: async () => proposal !== undefined,
      });
    } catch {
      if (signal?.aborted) throwAbortReason(signal);
      if (toolSignal?.aborted && !isLocalToolTimeoutReason(toolSignal.reason)) throwAbortReason(toolSignal);
      // 规则发现是可选优化，拿不到就退到确定性分段，绝不因此让目标失败。
      return undefined;
    } finally {
      merged.dispose();
    }
    return proposal;
  };
}

export async function runLiveReferenceAnalysis(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  options: {
    transportRetries?: number;
    runSession?: typeof runLiveConstrainedSession;
  } = {},
): Promise<ReferenceAnalysisSummary & { model: string; error?: string }> {
  const controller = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
  const transportRetries = options.transportRetries ?? 1;
  const runSession = options.runSession ?? runLiveConstrainedSession;
  let initial = await controller.readState();
  if (initial.status === "sealed") {
    return { ...await controller.summary(), model: "persisted-reference-analysis" };
  }
  if (initial.status === "failed") {
    if (initial.terminal_blocker?.code === "page_gap") {
      const recovery = await controller.recoverVerifiedPageGapBlocker();
      if (recovery.ok === true) initial = await controller.readState();
      else return { ...await controller.summary(), model: initial.agent_runtime.kind };
    } else if (classifyTargetFailure(initial.terminal_reason) !== "transport") {
      return { ...await controller.summary(), model: initial.agent_runtime.kind };
    } else {
      initial = await controller.recoverRetryableFailure();
    }
  } else if (initial.status === "running") {
    initial = await controller.prepareFreshSession();
  }
  const exhaustedTransportError = (state: Awaited<ReturnType<typeof controller.readState>>): Error =>
    new Error(`reference_analysis_transport_retry_exhausted: ${state.last_transport_failure || "transport failure"}`);
  if ((initial.transport_failures ?? 0) > transportRetries) throw exhaustedTransportError(initial);

  const completed = async () => ["sealed", "failed"].includes((await controller.readState()).status);
  for (;;) {
    let result: Awaited<ReturnType<typeof runLiveConstrainedSession>>;
    try {
      result = await runSession({
        root: controller.root,
        appendEvent: (eventType, payload) => controller.appendEvent(eventType, payload),
      }, {
        modelStage: "coverage_review",
        ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
        resume: false,
        ...(signal ? { signal } : {}),
        systemPrompt: REFERENCE_ANALYSIS_SYSTEM_PROMPT,
        sessionDirectory: controller.piSessionDirectory,
        terminalTool: "seal_reference_analysis",
        customTools: createReferenceAnalysisTools(controller),
        prompt: `${referenceStartupPrompt(false)}\n当前唯一target_key=${targetKey}`,
        setRuntime: (runtime) => controller.setRuntime(runtime),
        completed,
        handoffWhen: (event) => Boolean(
          event
          && typeof event === "object"
          && !Array.isArray(event)
          && (event as { type?: unknown }).type === "tool_execution_end"
          && (event as { toolName?: unknown }).toolName === "report_reference_analysis_blocker"
          && (event as { result?: { details?: { analysis_status?: unknown } } }).result?.details?.analysis_status === "failed"
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (classifyTargetFailure(message) === "transport") {
        const state = await controller.recordTransportFailure(message);
        if ((state.transport_failures ?? 0) <= transportRetries) continue;
        throw exhaustedTransportError(state);
      }
      const reason = isProviderContextTooLargeError(error)
        ? `reference_analysis_budget_exceeded: ${message}`
        : `reference_analysis_failed: ${message}`;
      await controller.dispatch("report_reference_analysis_blocker", { reason, code: "provider_failure" });
      return { ...await controller.summary(), model: "reference-analysis-provider-failed", error: reason };
    }

    const state = await controller.readState();
    if (state.status === "sealed" || state.status === "failed") {
      const summary = await controller.summary();
      return {
        ...summary,
        model: result.model,
        ...(result.error || summary.analysis_status !== "sealed"
          ? { error: result.error || state.terminal_reason }
          : {}),
      };
    }
    const error = result.error || "reference_analysis_incomplete_without_seal";
    if (classifyTargetFailure(error) === "transport") {
      const retryState = await controller.recordTransportFailure(error);
      if ((retryState.transport_failures ?? 0) <= transportRetries) continue;
      throw exhaustedTransportError(retryState);
    }
    await controller.dispatch("report_reference_analysis_blocker", { reason: error, code: "other" });
    return { ...await controller.summary(), model: result.model, error };
  }
}

export async function runLiveCoverageReview(
  workspace: RevisionWorkspace,
  planFingerprint: string,
  signal?: AbortSignal,
  extraScope?: CoverageReviewScope,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  options: { runSession?: typeof runLiveConstrainedSession } = {},
): Promise<LiveCoverageReviewResult> {
  signal?.throwIfAborted();
  const staleBeforeCreate = await durableCoverageCandidateChangeReceipt(workspace, planFingerprint);
  if (staleBeforeCreate) return staleCoverageControllerResult(staleBeforeCreate);
  let controller: CoverageReviewController;
  try {
    controller = await CoverageReviewController.create(workspace, planFingerprint, extraScope);
  } catch (error) {
    const staleDuringCreate = await durableCoverageCandidateChangeReceipt(workspace, planFingerprint);
    if (staleDuringCreate) return staleCoverageControllerResult(staleDuringCreate);
    throw error;
  }
  const changedAfterCreate = await controller.currentCandidateChangeReceipt();
  if (changedAfterCreate) return staleCoverageControllerResult(changedAfterCreate);
  const runSession = options.runSession ?? runLiveConstrainedSession;
  controller.referenceCatalogRuleAsk = createCatalogRuleAsk(workspace, signal, runtimeConfig);
  const readSealed = () => readSealedCoverageReview(
    workspace,
    planFingerprint,
    controller.evidence,
    extraScope ?? controller.reviewScope,
  );
  const existing = await readSealed();
  if (existing) {
    const state = await controller.readState();
    return {
      sealed: true,
      model: state.agent_runtime.kind === "pi-sdk" ? "persisted-pi-session" : state.agent_runtime.kind,
      review: existing,
    };
  }
  const state = await controller.readState();
  const invocationPolicy = coverageReviewInvocationPolicy(state.agent_runtime.session_file);
  if (invocationPolicy.abandoned_legacy_session) {
    const legacySessionFile = state.agent_runtime.session_file;
    const legacySessionBytes = await stat(legacySessionFile)
      .then((entry) => entry.size)
      .catch(() => undefined);
    await workspace.appendEvent("abandoned_legacy_session", {
      phase: "coverage_review",
      plan_fingerprint: planFingerprint,
      session_id: state.agent_runtime.session_id,
      session_file_sha256: sha256Text(legacySessionFile),
      ...(legacySessionBytes !== undefined ? { session_file_bytes: legacySessionBytes } : {}),
      durable_checkpoint_authority: true,
      resume_old_session: false,
      reason: "coverage review invocations restart from the durable working review and checkpoint",
    });
  }
  const allTools = createCoverageReviewTools(controller);
  const finalizationToolNames = new Set<string>(COVERAGE_FINALIZATION_TOOL_NAMES);
  const completed = async () => Boolean(await readSealed());
  const durableSnapshot = async () => {
    const current = await controller.readDurableProgressSnapshot();
    return {
      checkpoint: coverageCheckpointWithReferenceReads(current.progress_fingerprint, await workspace.readState()),
      working_plan_sha256: current.working_plan_sha256,
      history_sequence: current.history_sequence,
      last_valid_fingerprint: current.last_valid_fingerprint,
    };
  };
  const sessionWorkspace = {
    root: controller.root,
    appendEvent: async (_eventType: string, payload: unknown) => controller.appendPiEvent(payload),
  };
  let lastFinalizationBlocker = "";
  let coverageControllerChanged: CoverageControllerRebuildReceipt | undefined;
  const recordCoverageControllerChanged = async (
    receipt: CoverageControllerRebuildReceipt,
  ): Promise<void> => {
    coverageControllerChanged = receipt;
    lastFinalizationBlocker = "";
    await workspace.appendEvent("coverage_review_controller_rebuild_required", {
      plan_fingerprint: planFingerprint,
      ...receipt,
    });
  };
  const sealMechanicallyReadyReview = async (): Promise<boolean> => {
    if (await completed()) return true;
    const sealed = await controller.finalizeMechanicallyReady();
    if (sealed.ok === true) {
      lastFinalizationBlocker = "";
      await workspace.appendEvent("coverage_review_mechanical_finalization", {
        plan_fingerprint: planFingerprint,
        review_fingerprint: sealed.review_fingerprint ?? "",
        review_status: sealed.status ?? "",
        reason: "typed draft was mechanically ready with zero local preflight issues",
      });
      return true;
    }
    if (coverageControllerRebuildRequired(sealed)) {
      await recordCoverageControllerChanged(sealed as CoverageControllerRebuildReceipt);
      return false;
    }
    const blocker = coverageFinalizationBlockerPrompt(sealed);
    if (blocker && blocker !== lastFinalizationBlocker) {
      await workspace.appendEvent("coverage_review_mechanical_finalization_blocked", {
        plan_fingerprint: planFingerprint,
        ...sealed,
      });
    }
    lastFinalizationBlocker = blocker;
    return false;
  };
  if (await sealMechanicallyReadyReview()) {
    const review = await readSealed();
    return {
      sealed: Boolean(review),
      model: "deterministic-coverage-finalization",
      ...(review ? { review } : {}),
      ...(!review ? { error: "coverage_review_sealed_but_unreadable_with_scope" } : {}),
    };
  }
  if (coverageControllerChanged) {
    return staleCoverageControllerResult(coverageControllerChanged);
  }
  type CoveragePhase = "investigation" | "finalization";
  type CoverageSessionResult = Awaited<ReturnType<typeof runLiveConstrainedSession>>;
  const maxFreshPhases = 32;
  let phaseMode: CoveragePhase = "investigation";
  let phaseHandoff: CoverageReviewStageHandoff = "none";
  let consecutiveWithoutProgress = 0;
  let result: CoverageSessionResult | undefined;
  let terminalError = "";
  let exhaustedFreshPhaseLimit = false;
  const seenProgressFingerprints = new Set<string>();
  const models: string[] = [];
  for (let phase = 1; phase <= maxFreshPhases && !(await completed()); phase += 1) {
    signal?.throwIfAborted();
    const changedBeforeProvider = await controller.currentCandidateChangeReceipt();
    if (changedBeforeProvider) {
      await recordCoverageControllerChanged(changedBeforeProvider);
      terminalError = changedBeforeProvider.error;
      break;
    }
    controller.beginFreshCoveragePhase();
    const before = await durableSnapshot();
    seenProgressFingerprints.add(before.checkpoint);
    phaseHandoff = "none";
    await workspace.appendEvent("coverage_fresh_phase_started", {
      plan_fingerprint: planFingerprint,
      phase,
      max_phases: maxFreshPhases,
      phase_mode: phaseMode,
      fresh_session: true,
      resume_old_session: false,
      configured_thinking_effort: runtimeConfig?.stages.coverage_review.effort ?? "preset-default",
      durable_checkpoint: before.checkpoint,
    });
    try {
      result = await runSession(sessionWorkspace, {
        modelStage: "coverage_review",
        ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
        resume: false,
        ...(signal ? { signal } : {}),
        systemPrompt: phaseMode === "investigation"
          ? COVERAGE_REVIEW_SYSTEM_PROMPT
          : COVERAGE_FINALIZATION_SYSTEM_PROMPT,
        sessionDirectory: controller.piSessionDirectory,
        terminalTool: "seal_coverage_review",
        customTools: phaseMode === "investigation"
          ? allTools
          : allTools.filter((tool) => finalizationToolNames.has(tool.name)),
        prompt: (phaseMode === "investigation"
          ? (phase === 1 && !invocationPolicy.abandoned_legacy_session && !lastFinalizationBlocker
              ? `独立复核目标 ${workspace.targetId}、候选 ${planFingerprint} 的无损语义覆盖。先用 view="business" 读叶子详情，只有具体来源问题才展开 view="full"。`
              : "从持久化复核稿及精简检查点开启新独立覆盖阶段，仅复核剩余义务，持久化下一批有界结构化记录，不重建或重放之前的对话。")
          : "完成持久化结构化覆盖复核的收尾。读取精简检查点及 local_preflight，仅修正其中的机械问题，再封存精确有效指纹。")
          + (lastFinalizationBlocker ? `\n上次确定性封存阻塞（首批有界问题）：${lastFinalizationBlocker}` : ""),
        setRuntime: (runtime) => controller.setRuntime(runtime),
        completed,
        durableSnapshot,
        maxLengthContinuations: 1,
        handoffWhen: (event) => {
          const handoff = coverageReviewStageHandoff(event);
          if (handoff === "none") return false;
          phaseHandoff = handoff;
          return true;
        },
        lengthContinuationPrompt: phaseMode === "investigation"
          ? "上一轮独立覆盖复核达到模型输出长度上限。丢弃所有截断句子、JSON 片段和工具调用，重新读取持久化复核稿及 coverage_checkpoint，以一次有界 stage_coverage_review_draft 保存下一批最多 32 条结构化最终叶子记录或意见。"
          : "本轮有界收尾达到输出上限。仅读取持久化工作复核检查点/local_preflight，修正一批有界问题，并封存返回的指纹。",
      });
      models.push(result.model);
      terminalError = result.error ?? "";
    } catch (error) {
      if (!isProviderContextTooLargeError(error)) throw error;
      terminalError = error instanceof Error ? error.message : String(error);
      await workspace.appendEvent("coverage_context_handoff_started", {
        plan_fingerprint: planFingerprint,
        phase,
        phase_mode: phaseMode,
        reason: "provider_context_too_large",
        fresh_session: true,
        resume_old_session: false,
      });
    }
    const after = await durableSnapshot();
    const revisitedCheckpoint = seenProgressFingerprints.has(after.checkpoint);
    const phaseFailureClass = coverageFreshPhaseFailureClass(terminalError, phaseHandoff);
    const progress = coverageFreshPhaseProgress({
      previous_progress_fingerprint: before.checkpoint,
      previous_last_valid_fingerprint: before.last_valid_fingerprint,
      current_progress_fingerprint: after.checkpoint,
      current_last_valid_fingerprint: after.last_valid_fingerprint,
      current_progress_previously_seen: revisitedCheckpoint,
      consecutive_without_progress: consecutiveWithoutProgress,
      count_stagnation: phaseFailureClass === undefined,
    });
    seenProgressFingerprints.add(after.checkpoint);
    consecutiveWithoutProgress = progress.consecutive_without_progress;
    await workspace.appendEvent("coverage_fresh_phase_completed", {
      plan_fingerprint: planFingerprint,
      phase,
      phase_mode: phaseMode,
      handoff: phaseHandoff,
      durable_progress: progress.durable_progress,
      consecutive_without_progress: progress.consecutive_without_progress,
      before_checkpoint: before.checkpoint,
      after_checkpoint: after.checkpoint,
      revisited_checkpoint: revisitedCheckpoint,
      ...(terminalError ? { error: terminalError } : {}),
      ...(phaseFailureClass ? { failure_class: phaseFailureClass } : {}),
    });
    if (await sealMechanicallyReadyReview()) break;
    if (coverageControllerChanged) {
      terminalError = "coverage_review_candidate_changed";
      break;
    }
    if (phaseFailureClass) break;
    if (progress.stalled) {
      terminalError = "coverage_fresh_phase_without_durable_progress: 2 consecutive fresh phases left the same working review checkpoint";
      break;
    }
    const completedHandoff = phaseHandoff as CoverageReviewStageHandoff;
    phaseMode = completedHandoff === "finalization" || completedHandoff === "ready"
      ? "finalization"
      : "investigation";
    if (phase === maxFreshPhases) exhaustedFreshPhaseLimit = true;
  }
  if (coverageControllerChanged) {
    return staleCoverageControllerResult(coverageControllerChanged);
  }
  terminalError = coverageFreshPhaseTerminalError({
    completed: await completed(),
    exhausted_phase_limit: exhaustedFreshPhaseLimit,
    terminal_error: terminalError,
    max_fresh_phases: maxFreshPhases,
  });
  const review = await readSealed();
  return {
    sealed: Boolean(review),
    model: models.join(" + coverage-phase:") || "coverage-session-unavailable",
    ...(review ? { review } : {}),
    ...(terminalError && !review ? { error: terminalError } : {}),
  };
}

/** Count saved work and source reads, never transcript growth or new draft handles. */
export async function discoveryPromptSnapshot(
  workspace: DocumentDiscoveryWorkspace,
  phase: "candidate" | "review",
): Promise<DurablePromptSnapshot> {
  const state = await workspace.readState();
  const selectors = await readJson<DocumentSelectorPlan>(workspace.workingSelectorPath);
  const evidence = await workspace.readEvidence();
  const pending = await findCurrentDiscoveryDraft(workspace.root, {
    job_id: workspace.jobId, evidence_fingerprint: evidence.evidence_fingerprint,
    phase, phase_epoch: state.pending_draft_epoch ?? "initial",
    base_selector_fingerprint: documentSelectorFingerprint(selectors),
  });
  const checkpoint = sha256Json({
    status: state.status, selectors,
    opened_atom_ids: [...(phase === "candidate" ? state.opened_atom_ids : state.reviewer_opened_atom_ids ?? [])].sort(),
    decisions: await pathExists(workspace.decisionsPath) ? await readJson(workspace.decisionsPath) : [],
    registry: await workspace.readSourceSpanRegistry(),
    pending: pending ? { selectors: pending.draft.selectors, registry: pending.draft.registry } : null,
  });
  return {
    checkpoint, working_plan_sha256: checkpoint,
    history_sequence: state.next_history_sequence - 1,
    last_valid_fingerprint: phase === "candidate" ? state.last_valid_fingerprint : state.last_reviewed_fingerprint,
    issue_fingerprint: state.last_issue_fingerprint,
  };
}

export const DISCOVERY_CONTINUATION_PROMPT = prompt_DISCOVERY_CONTINUATION_PROMPT;

function discoveryProgressStopped(error: string | undefined): boolean {
  return /^(?:target_progress_stalled|incomplete_repair_(?:without_durable_progress|durable_progress_cycle)|length_(?:without_durable_progress|durable_progress_cycle)):/u.test(error ?? "");
}

export async function runLiveDocumentDiscovery(
  workspace: DocumentDiscoveryWorkspace,
  controller: DocumentDiscoveryController,
  resume: boolean,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{
  session_id: string;
  session_file: string;
  candidate_ready: boolean;
  model: string;
  error?: string;
  terminal_failure?: boolean;
}> {
  const result = await runLiveConstrainedSession(workspace, {
    modelStage: "discovery",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    resume,
    ...(signal ? { signal } : {}),
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    sessionDirectory: workspace.piSessionDirectory,
    terminalTool: "seal_discovery_plan",
    customTools: createDocumentDiscoveryTools(controller),
    durableSnapshot: () => discoveryPromptSnapshot(workspace, "candidate"),
    continueUntilTerminal: true,
    completedContinuationPrompt: DISCOVERY_CONTINUATION_PROMPT,
    lengthContinuationPrompt: `上一轮输出被截断，未执行的工具参数不可重放。${DISCOVERY_CONTINUATION_PROMPT}`,
    prompt: discoveryStartupPrompt(workspace.jobId, resume),
    setRuntime: (runtime) => workspace.setRuntime(runtime),
    completed: async () => (await workspace.readState()).status === "sealed",
  });
  return {
    session_id: result.session_id,
    session_file: result.session_file,
    candidate_ready: result.completed,
    model: result.model,
    ...(result.error ? { error: result.error } : {}),
    ...(result.terminal_failure || discoveryProgressStopped(result.error) ? { terminal_failure: true } : {}),
  };
}

export async function runLiveDocumentReview(
  workspace: DocumentDiscoveryWorkspace,
  controller: DocumentDiscoveryController,
  resume: boolean,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  resumeContext?: string,
): Promise<{
  session_id: string;
  session_file: string;
  sealed: boolean;
  model: string;
  error?: string;
  terminal_failure?: boolean;
}> {
  const state = await workspace.readState();
  const reviewReason = state.review_reason?.trim();
  const auditFocus = reviewReason
    ? ` 先前基于证据的审查报告了具体语义缺陷：${reviewReason}。重新打开完整文档，用不可变证据核对，证实后修复；不能原样返回旧计划。`
    : "";
  const deterministicWorklist = resumeContext?.trim()
    ? `\n\n上一次复核尝试未封存。以下是当前读取前提和最近一次结构编译的工作清单（程序生成，非语义结论）：\n${resumeContext.trim()}\n先按精确下一步补齐读取前提，再按 read_discovery_review_progress 的剩余 key 继续独立核验原文和当前记录，用 record_discovery_review 保存真实明确判断；只修订有原文依据的差异。有效读取不等于语义批准，结构预检通过不等于最终校验。完整语义核验和真实修复完成后才进行最终编译及封存，不要重建或反复补读未改变的正确记录。`
    : "";
  const result = await runLiveConstrainedSession(workspace, {
    modelStage: "discovery_review",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    resume,
    ...(signal ? { signal } : {}),
    systemPrompt: DISCOVERY_REVIEW_SYSTEM_PROMPT,
    sessionDirectory: workspace.reviewerPiSessionDirectory,
    terminalTool: "seal_discovery_plan",
    customTools: createDocumentDiscoveryTools(controller),
    durableSnapshot: () => discoveryPromptSnapshot(workspace, "review"),
    continueUntilTerminal: true,
    completedContinuationPrompt: "独立复核尚未封存。读取已保存计划和 read_discovery_obligations，继续核对未读原子、未决处置及语义边界；单次事务大小不限制本轮完成范围。保存一批后继续，完整复核并编译通过后调用 seal_discovery_plan。不能把检查点或聊天总结当作完成，不能跳过真实原文和复核门禁。",
    prompt: resume
      ? `恢复独立语义复核。重新打开未复核原子，修复并验证计划，仅封存已复核指纹。${auditFocus}${deterministicWorklist}`
      : `独立复核 job ${workspace.jobId} 的每个来源原子。逐目标读取 semantic_basis 和所引证据，对照相邻范围核验具体对象、实际判据或委托及拆并边界。仅聚合/管理性候选降为 contexts。检查被排除原子是否遗漏，包括无抽样关键词的要求。完整底账不证明语义完整；完整复核后零目标并提供 no_target_reason 也合法。修复选择器、编译并封存复核后的计划。${auditFocus}`,
    setRuntime: (runtime) => workspace.setReviewerRuntime(runtime),
    completed: async () => (await workspace.readState()).status === "sealed",
  });
  return {
    session_id: result.session_id,
    session_file: result.session_file,
    sealed: result.completed,
    model: result.model,
    ...(result.error ? { error: result.error } : {}),
    ...(result.terminal_failure || discoveryProgressStopped(result.error) ? { terminal_failure: true } : {}),
  };
}

export async function runLiveEditorHierarchyCandidate(
  workspace: EditorHierarchyWorkspace,
  controller: EditorHierarchyController,
  resume: boolean,
  signal?: AbortSignal,
  confirmContext?: HierarchyConfirmContext,
  runtimeConfig?: PiAgentRuntimeModelConfig,
  userFeedback?: string,
): Promise<{ session_id: string; session_file: string; candidate_ready: boolean; model: string; error?: string }> {
  const confirm = Boolean(confirmContext);
  const unmatchedLots = confirmContext?.uncertain_lot_keys ?? [];
  const result = await runLiveConstrainedSession(workspace, {
    modelStage: "hierarchy",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    resume,
    ...(signal ? { signal } : {}),
    systemPrompt: confirm ? HIERARCHY_CONFIRM_SYSTEM_PROMPT : HIERARCHY_SYSTEM_PROMPT,
    sessionDirectory: workspace.piSessionDirectory,
    terminalTool: "submit_hierarchy_candidate",
    customTools: createEditorHierarchyTools(controller),
    prompt: hierarchyStartupPrompt({ job_id: workspace.jobId, resume, confirm, unmatched_lots: unmatchedLots, ...(userFeedback ? { user_feedback: userFeedback } : {}) }),
    setRuntime: (runtime) => workspace.setRuntime(runtime),
    completed: async () => (await workspace.readState()).status === "candidate",
  });
  return {
    session_id: result.session_id,
    session_file: result.session_file,
    candidate_ready: result.completed,
    model: result.model,
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function runLiveEditorHierarchyReview(
  workspace: EditorHierarchyWorkspace,
  controller: EditorHierarchyController,
  resume: boolean,
  signal?: AbortSignal,
  runtimeConfig?: PiAgentRuntimeModelConfig,
): Promise<{ session_id: string; session_file: string; sealed: boolean; model: string; error?: string }> {
  const result = await runLiveConstrainedSession(workspace, {
    modelStage: "hierarchy",
    ...(runtimeConfig ? { modelConfig: runtimeConfig } : {}),
    resume,
    ...(signal ? { signal } : {}),
    systemPrompt: HIERARCHY_REVIEW_SYSTEM_PROMPT,
    sessionDirectory: workspace.reviewerPiSessionDirectory,
    terminalTool: "seal_hierarchy_plan",
    customTools: createEditorHierarchyTools(controller),
    prompt: hierarchyStartupPrompt({ job_id: workspace.jobId, resume, review: true }),
    setRuntime: (runtime) => workspace.setReviewerRuntime(runtime),
    completed: async () => (await workspace.readState()).status === "sealed",
  });
  return {
    session_id: result.session_id,
    session_file: result.session_file,
    sealed: result.completed,
    model: result.model,
    ...(result.error ? { error: result.error } : {}),
  };
}

export interface AcceptanceFeedbackCandidate {
  target_id: string;
  name: string;
  item_names: string[];
  shared_reference_keys: string[];
}

export async function runAcceptanceFeedbackScope(input: {
  root: string;
  feedback: string;
  candidates: AcceptanceFeedbackCandidate[];
  contextualTargetIds?: string[];
  modelConfig?: PiAgentRuntimeModelConfig;
  signal?: AbortSignal;
}, options: { runSession?: typeof runLiveConstrainedSession } = {}): Promise<{
  target_ids: string[]; shared_reference_keys: string[]; reason: string;
}> {
  let scope: { target_ids: string[]; shared_reference_keys: string[]; reason: string } | undefined;
  const knownTargets = new Set(input.candidates.map(row => row.target_id));
  const knownReferences = new Set(input.candidates.flatMap(row => row.shared_reference_keys));
  const listTool = defineTool({ name: "list_feedback_candidates", label: "查找反馈涉及的项目",
    description: "按名称搜索或分页读取当前目标与项目名称；只用于确定修订范围，不提供业务答案。",
    parameters: Type.Object({ query: Type.Optional(Type.String()), cursor: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const query = params.query?.trim().toLowerCase();
      const rows = input.candidates.filter(row => !query || [row.name, ...row.item_names].some(name => name.toLowerCase().includes(query)));
      const cursor = Math.trunc(params.cursor ?? 0);
      const page = rows.slice(cursor, cursor + 16).map(row => ({ ...row, item_names: row.item_names.slice(0, 80), item_names_complete: row.item_names.length <= 80 }));
      const result = { ok: true, candidates: page, total: rows.length, next_cursor: cursor + page.length < rows.length ? cursor + page.length : null };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
  const saveTool = defineTool({ name: "save_feedback_scope", label: "确定定向修订范围",
    description: "只选择反馈实际涉及的目标和共享引用；程序随后展开共享引用的相关目标并全局校验。不能以整份重跑代替定向选择。",
    parameters: Type.Object({ target_ids: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
      shared_reference_keys: Type.Array(Type.String(), { uniqueItems: true }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const invalidTargets = params.target_ids.filter(id => !knownTargets.has(id));
      const invalidReferences = params.shared_reference_keys.filter(id => !knownReferences.has(id));
      const result = invalidTargets.length || invalidReferences.length
        ? { ok: false, actual: { invalidTargets, invalidReferences }, how_to_pass: "从 list_feedback_candidates 读取真实身份后定向选择", writable_paths: ["/target_ids", "/shared_reference_keys"], next_tool: "list_feedback_candidates" }
        : { ok: true };
      if (result.ok) scope = { target_ids: params.target_ids, shared_reference_keys: params.shared_reference_keys, reason: params.reason };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
  await mkdir(input.root, { recursive: true });
  const result = await (options.runSession ?? runLiveConstrainedSession)({ root: input.root,
    appendEvent: async (eventType, payload) => {
      await appendFile(join(input.root, "session.events.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), event_type: eventType, payload }) + "\n", "utf8");
    },
  }, { resume: false, ...(input.signal ? { signal: input.signal } : {}),
    ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}), modelStage: "discovery",
    systemPrompt: "根据用户对话确定验收项目的定向修订范围。用户文字是修改意图，不能替代规范原文或生成业务判据。只选择对话实际涉及的现有目标和需要修改的共享引用，保留其他正确内容；先用目录工具定位真实身份。上下文目标只帮助定位，不代表必须修改。不得随意选择全部目标。",
    prompt: JSON.stringify({ feedback: input.feedback, contextual_target_ids: input.contextualTargetIds ?? [], target_count: input.candidates.length }),
    sessionDirectory: join(input.root, "pi-session"), terminalTool: "save_feedback_scope", customTools: [listTool, saveTool],
    setRuntime: async () => {}, completed: async () => scope !== undefined,
  });
  if (!scope || !result.completed) throw new Error(result.error ?? "未能确定反馈涉及的项目，请补充项目名称");
  const shared = new Set(scope.shared_reference_keys);
  const affected = input.candidates.filter(row => row.shared_reference_keys.some(key => shared.has(key))).map(row => row.target_id);
  return { ...scope, target_ids: [...new Set([...scope.target_ids, ...affected])] };
}
