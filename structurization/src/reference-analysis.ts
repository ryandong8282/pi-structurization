import { replaceAcceptanceToolText } from "./acceptance-tool-text.js";
import { ACCEPTANCE_TOOL_DESCRIPTIONS } from "./acceptance-tool-text.js";
import { REFERENCE_ANALYSIS_SYSTEM_PROMPT as prompt_REFERENCE_ANALYSIS_SYSTEM_PROMPT } from "./acceptance-prompt-suite.js";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MODEL_OUTPUT_LANGUAGE_GUIDANCE, SOURCE_READING_GUIDANCE } from "./acceptance-delivery-contract.js";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { catchToolReject, toolReject } from "./actionable-error.js";
import { appendText, atomicWriteJson, pathExists, readJson } from "./atomic.js";
import { sha256Json } from "./canonical.js";
import { tableRowRepresentationIds } from "./table-row-representations.js";
import type { EvidenceManifest, ReferenceOccurrence, RevisionState } from "./contracts.js";
import {
  renderReferenceCatalog,
  type CatalogEvidenceRecord,
  type ReferenceCatalogEntry,
  type ReferenceCatalogRules,
} from "./reference-catalog.js";
import {
  resolveReferenceCatalog,
  type CatalogRuleAsk,
  type CatalogRuleCache,
  type ResolvedCatalog,
} from "./reference-catalog-discovery.js";
import {
  documentReferenceReadProgress,
  documentReferenceTargetReadIdentity,
  readAndRecordDocumentReferenceEvidencePage,
} from "./document-reference.js";
import { buildDocumentEvidence } from "./document-discovery.js";
import {
  createEvidenceSourceRangeResolver,
  referenceOccurrenceTargetsDocument,
  sourceRangesOverlap,
} from "./source-provenance-ranges.js";
import type { RevisionWorkspace } from "./workspace.js";
import { resolveSourceSpan, type SourceSpanIssue } from "./source-span-registry.js";

export const REFERENCE_ANALYSIS_SYSTEM_PROMPT = prompt_REFERENCE_ANALYSIS_SYSTEM_PROMPT;

export type ReferenceFactRole =
  | "scope"
  | "object"
  | "requirement"
  | "method"
  | "quantity"
  | "condition"
  | "allowed_value"
  | "exception"
  | "note"
  | "table_row";

export interface ReferenceFact {
  fact_key: string;
  role: ReferenceFactRole;
  span_ids: string[];
  target_key: string;
  reason: string;
}

export type ReferenceAnalysisBlockerCode =
  | "page_gap"
  | "source_unavailable"
  | "semantic_ambiguity"
  | "provider_failure"
  | "other";

interface ReferenceAnalysisBlocker {
  code: ReferenceAnalysisBlockerCode;
  reason: string;
  reported_cursor?: number;
  reported_next_cursor?: number | null;
}

interface ReferenceAnalysisPage {
  cursor: number;
  evidence_ids: string[];
  span_ids: string[];
  next_cursor: number | null;
  // Old persisted states lack this marker. Their facts are used as the
  // compatibility fallback when a resumed analysis checks page progress.
  staged?: boolean;
}

export interface ReferenceAnalysisState {
  schema_version: "reference-analysis-state/v1";
  status: "pending" | "running" | "sealed" | "failed";
  target_key: string;
  target_locator: string;
  target_fingerprint: string;
  evidence_count: number;
  next_cursor: number | null;
  next_event_sequence: number;
  pages: Record<string, ReferenceAnalysisPage>;
  fact_count: number;
  seal_fingerprint: string;
  terminal_reason: string;
  terminal_blocker?: ReferenceAnalysisBlocker | undefined;
  transport_failures?: number;
  last_transport_failure?: string;
  agent_runtime: RevisionState["agent_runtime"];
}

interface ReferenceFactsArtifact {
  schema_version: "reference-facts/v1";
  target_key: string;
  target_fingerprint: string;
  facts: ReferenceFact[];
}

export interface ReferenceAnalysisSummary {
  target_key: string;
  target_locator: string;
  evidence_count: number;
  analysis_status: ReferenceAnalysisState["status"];
  fingerprint: string;
  fact_count: number;
  next_cursor: number | null;
  terminal_reason: string;
  terminal_blocker_code?: ReferenceAnalysisBlockerCode;
  recovery_action: string;
}

const PAGE_SIZE = 16;
export const INLINE_REFERENCE_PAGE_SIZE = 24;
export const REFERENCE_ISOLATED_EVIDENCE_COUNT_THRESHOLD = 24;
export const REFERENCE_ISOLATED_TEXT_BYTES_THRESHOLD = 24 * 1024;
export const REFERENCE_INLINE_PHASE_BYTES_BUDGET = 48 * 1024;
const FACT_PATCH_LIMIT = 32;

export interface ReferenceAnalysisPolicy {
  analysis_mode: "inline" | "isolated";
  target_text_utf8_bytes: number;
  estimated_compact_page_count: number;
  evidence_count: number;
  mode_reason: string;
}
export type ReferenceAnalysisPhase = "target" | "coverage";

type ReferenceTargetRetryTool = "read_reference_facts" | "read_document_reference_evidence";

function referenceTargetNotFoundFeedback(
  receivedValue: string,
  phase: ReferenceAnalysisPhase,
  retryTool: ReferenceTargetRetryTool,
): { ok: false; [key: string]: unknown } {
  const discoveryTools = phase === "coverage"
    ? ["list_coverage_reference_targets"]
    : ["list_reference_occurrences"];
  return {
    ok: false,
    error: "reference_target_not_found",
    parameter: "target_key",
    received_value: receivedValue,
    retry_tool: retryTool,
    next_tool: discoveryTools[0],
    next_tool_arguments: { cursor: 0, limit: 100 },
    next_tools: [...discoveryTools, retryTool],
    writable_parameters: ["target_key"],
    required_action: phase === "coverage"
      ? "list_coverage_reference_targets_then_retry_with_returned_target_key"
      : "list_reference_occurrences_then_retry_with_returned_target_key",
    do_not_edit: "除重试时替换 target_key 外，不要修改其余工具参数、不可变引用原文、候选计划或已保存结果",
    instruction: phase === "coverage"
      ? `收到的 target_key 不属于当前可读取的引用目标，本次 ${retryTool} 未执行。调用 list_coverage_reference_targets({cursor:0,limit:100})，按 next_cursor 逐页读取已登记 occurrence；只依据回条的 raw_reference、normalized_reference 和 target_locator 核对原调用意图，原样复制对应 target_key，替换这一参数后重试 ${retryTool}。不要猜测 target_key，也不要把目录、判断或答案当作本错误回条已经给出。`
      : `收到的 target_key 不属于当前引用目标，本次 ${retryTool} 未执行。先调用 list_reference_occurrences，再只从其回条复制与原调用意图相符的 target_key，替换这一参数后重试 ${retryTool}。不要猜测 target_key，也不要修改其他参数或业务内容。`,
  };
}

function referenceModeStateKey(targetKey: string, phase: ReferenceAnalysisPhase): string {
  return `${phase}:${targetKey}`;
}

export function referenceAnalysisPolicy(
  manifest: EvidenceManifest,
  occurrence: ReferenceOccurrence,
  inlineBytesAlreadyAssigned = 0,
): ReferenceAnalysisPolicy {
  const recordById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const targetTextBytes = occurrence.target_evidence_ids.reduce((total, evidenceId) =>
    total + Buffer.byteLength(recordById.get(evidenceId)?.text ?? "", "utf8"), 0);
  const evidenceCount = occurrence.target_evidence_ids.length;
  const pageCount = Math.max(1, Math.ceil(evidenceCount / INLINE_REFERENCE_PAGE_SIZE));
  const reasons: string[] = [];
  if (evidenceCount > REFERENCE_ISOLATED_EVIDENCE_COUNT_THRESHOLD) reasons.push("evidence_count_threshold");
  if (targetTextBytes > REFERENCE_ISOLATED_TEXT_BYTES_THRESHOLD) reasons.push("target_text_bytes_threshold");
  if (pageCount > 1) reasons.push("compact_page_count_threshold");
  if (reasons.length === 0 && inlineBytesAlreadyAssigned + targetTextBytes > REFERENCE_INLINE_PHASE_BYTES_BUDGET) {
    reasons.push("inline_phase_bytes_budget");
  }
  return {
    analysis_mode: reasons.length > 0 ? "isolated" : "inline",
    target_text_utf8_bytes: targetTextBytes,
    estimated_compact_page_count: pageCount,
    evidence_count: evidenceCount,
    mode_reason: reasons.join("+") || "within_inline_limits",
  };
}

export function projectReferenceAnalysisPolicies(
  manifest: EvidenceManifest,
  persistedModes: RevisionState["reference_analysis_modes"],
  phase: ReferenceAnalysisPhase = "target",
): Map<string, ReferenceAnalysisPolicy> {
  const targets = new Map<string, ReferenceOccurrence>();
  for (const occurrence of manifest.reference_occurrences) {
    if (occurrence.status !== "resolved") continue;
    const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
    if (!targets.has(targetKey)) targets.set(targetKey, occurrence);
  }
  const modes = persistedModes ?? {};
  let projectedInlineBytes = Object.entries(modes)
    .filter(([key, policy]) => key.startsWith(`${phase}:`) && policy.analysis_mode === "inline")
    .reduce((total, [, policy]) => total + policy.target_text_utf8_bytes, 0);
  const policies = new Map<string, ReferenceAnalysisPolicy>();
  for (const [targetKey, occurrence] of targets) {
    const persisted = modes[referenceModeStateKey(targetKey, phase)];
    const policy = persisted
      ?? referenceAnalysisPolicy(manifest, occurrence, projectedInlineBytes);
    policies.set(targetKey, policy);
    if (!persisted && policy.analysis_mode === "inline") {
      projectedInlineBytes += policy.target_text_utf8_bytes;
    }
  }
  return policies;
}

export async function assignReferenceAnalysisPolicy(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  occurrence: ReferenceOccurrence,
  phase: ReferenceAnalysisPhase = "target",
  signal?: AbortSignal,
): Promise<ReferenceAnalysisPolicy> {
  throwIfAborted(signal);
  const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
  const stateKey = referenceModeStateKey(targetKey, phase);
  const state = await workspace.readState();
  throwIfAborted(signal);
  const existing = state.reference_analysis_modes?.[stateKey];
  if (existing) return existing;
  let policy: ReferenceAnalysisPolicy | undefined;
  let inserted = false;
  await workspace.updateState((current) => {
    throwIfAborted(signal);
    const currentPolicy = current.reference_analysis_modes?.[stateKey];
    if (currentPolicy) {
      policy = currentPolicy;
      return;
    }
    const projected = projectReferenceAnalysisPolicies(
      manifest,
      current.reference_analysis_modes,
      phase,
    ).get(targetKey);
    if (!projected) throw new Error(`Reference analysis policy target is not resolved: ${targetKey}`);
    policy = projected;
    inserted = true;
    current.reference_analysis_modes = {
      ...(current.reference_analysis_modes ?? {}),
      [stateKey]: projected,
    };
  });
  if (!policy) throw new Error(`Reference analysis policy was not assigned: ${targetKey}`);
  if (signal?.aborted) {
    if (inserted) {
      await workspace.updateState((current) => {
        const currentPolicy = current.reference_analysis_modes?.[stateKey];
        if (!currentPolicy || sha256Json(currentPolicy) !== sha256Json(policy)) return;
        const modes = { ...(current.reference_analysis_modes ?? {}) };
        delete modes[stateKey];
        current.reference_analysis_modes = modes;
      });
    }
    throwIfAborted(signal);
  }
  return policy;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function resultContent(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function analysisRoot(workspace: RevisionWorkspace, targetKey: string): string {
  const hash = targetKey.replace(/^reference-target:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid reference target key");
  return resolve(workspace.root, "..", "..", "reference-analysis", hash);
}

function occurrenceForTarget(manifest: EvidenceManifest, targetKey: string): ReferenceOccurrence | undefined {
  return manifest.reference_occurrences.find((occurrence) =>
    occurrence.status === "resolved"
    && documentReferenceTargetReadIdentity(occurrence).target_key === targetKey
  );
}

export class ReferenceAnalysisController {
  readonly root: string;
  readonly statePath: string;
  readonly workingFactsPath: string;
  readonly sealedFactsPath: string;
  readonly sealReceiptPath: string;
  readonly transcriptPath: string;
  readonly piSessionDirectory: string;
  private readonly occurrence: ReferenceOccurrence;
  private stateMutationTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly workspace: RevisionWorkspace,
    readonly manifest: EvidenceManifest,
    readonly targetKey: string,
  ) {
    const occurrence = occurrenceForTarget(manifest, targetKey);
    if (!occurrence) throw new Error(`Reference target is not registered: ${targetKey}`);
    this.occurrence = occurrence;
    this.root = analysisRoot(workspace, targetKey);
    this.statePath = join(this.root, "state.json");
    this.workingFactsPath = join(this.root, "working.reference-facts.json");
    this.sealedFactsPath = join(this.root, "reference-facts.json");
    this.sealReceiptPath = join(this.root, "seal-receipt.json");
    this.transcriptPath = join(this.root, "session.events.jsonl");
    this.piSessionDirectory = join(this.root, "pi-session");
  }

  static async openOrCreate(
    workspace: RevisionWorkspace,
    manifest: EvidenceManifest,
    targetKey: string,
  ): Promise<ReferenceAnalysisController> {
    const controller = new ReferenceAnalysisController(workspace, manifest, targetKey);
    if (!(await pathExists(controller.statePath))) {
      const identity = documentReferenceTargetReadIdentity(controller.occurrence);
      await mkdir(controller.piSessionDirectory, { recursive: true });
      await atomicWriteJson(controller.workingFactsPath, {
        schema_version: "reference-facts/v1",
        target_key: targetKey,
        target_fingerprint: identity.target_fingerprint,
        facts: [],
      } satisfies ReferenceFactsArtifact);
      await atomicWriteJson(controller.statePath, {
        schema_version: "reference-analysis-state/v1",
        status: "pending",
        target_key: targetKey,
        target_locator: identity.target_locator,
        target_fingerprint: identity.target_fingerprint,
        evidence_count: identity.target_evidence_count,
        next_cursor: 0,
        next_event_sequence: 1,
        pages: {},
        fact_count: 0,
        seal_fingerprint: "",
        terminal_reason: "",
        transport_failures: 0,
        last_transport_failure: "",
        agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
      } satisfies ReferenceAnalysisState);
    }
    return controller;
  }

  async readState(): Promise<ReferenceAnalysisState> {
    return readJson<ReferenceAnalysisState>(this.statePath);
  }

  private async updateState(
    mutate: (state: ReferenceAnalysisState) => ReferenceAnalysisState | Promise<ReferenceAnalysisState>,
  ): Promise<ReferenceAnalysisState> {
    let result!: ReferenceAnalysisState;
    const transaction = this.stateMutationTail.then(async () => {
      result = await mutate(await this.readState());
      await atomicWriteJson(this.statePath, result);
    });
    this.stateMutationTail = transaction.catch(() => undefined);
    await transaction;
    return result;
  }

  async setRuntime(runtime: RevisionState["agent_runtime"]): Promise<void> {
    await this.updateState((state) => ({ ...state, status: "running", agent_runtime: runtime }));
  }

  async prepareFreshSession(): Promise<ReferenceAnalysisState> {
    return this.updateState((state) => ({
      ...state,
      status: "pending",
      terminal_reason: "",
      terminal_blocker: undefined,
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    }));
  }

  async recoverRetryableFailure(): Promise<ReferenceAnalysisState> {
    return this.updateState((state) => ({
      ...state,
      status: "pending",
      terminal_reason: "",
      terminal_blocker: undefined,
      transport_failures: Math.max(state.transport_failures ?? 0, 1),
      last_transport_failure: state.last_transport_failure || state.terminal_reason,
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    }));
  }

  async recordTransportFailure(reason: string): Promise<ReferenceAnalysisState> {
    return this.updateState((state) => ({
      ...state,
      status: "pending",
      terminal_reason: "",
      terminal_blocker: undefined,
      transport_failures: (state.transport_failures ?? 0) + 1,
      last_transport_failure: reason,
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    }));
  }

  async appendEvent(eventType: string, payload: unknown): Promise<void> {
    await this.updateState(async (state) => {
      await appendText(this.transcriptPath, `${JSON.stringify({
        schema_version: "reference-analysis-event/v1",
        sequence: state.next_event_sequence,
        timestamp: new Date().toISOString(),
        runtime: state.agent_runtime,
        event_type: eventType,
        payload,
      })}\n`);
      return { ...state, next_event_sequence: state.next_event_sequence + 1 };
    });
  }

  async summary(): Promise<ReferenceAnalysisSummary> {
    const state = await this.readState();
    return {
      target_key: state.target_key,
      target_locator: state.target_locator,
      evidence_count: state.evidence_count,
      analysis_status: state.status,
      fingerprint: state.seal_fingerprint,
      fact_count: state.fact_count,
      next_cursor: state.next_cursor,
      terminal_reason: state.terminal_reason,
      ...(state.terminal_blocker ? { terminal_blocker_code: state.terminal_blocker.code } : {}),
      recovery_action: state.status === "failed"
        ? "stop_current_target_and_inspect_reference_analysis_blocker_before_any_manual_recovery"
        : state.next_cursor === null
          ? "review_staged_facts_and_seal_reference_analysis"
          : "read_reference_target_page_and_stage_that_page_before_continuing",
    };
  }

  /**
   * A structured page-gap blocker may have been persisted by an interrupted
   * older harness. Resume it only when its durable page chain now proves the
   * reported page exists; never infer that from a free-text legacy reason.
   */
  async recoverVerifiedPageGapBlocker(): Promise<{ ok: boolean; [key: string]: unknown }> {
    const [state, artifact] = await Promise.all([
      this.readState(),
      readJson<ReferenceFactsArtifact>(this.workingFactsPath),
    ]);
    if (state.status !== "failed" || state.terminal_blocker?.code !== "page_gap") {
      return { ok: false, error: "reference_analysis_page_gap_recovery_not_applicable" };
    }
    const continuity = this.pageContinuity(state, artifact);
    const reportedCursor = state.terminal_blocker.reported_cursor;
    const reportedNextCursor = state.terminal_blocker.reported_next_cursor;
    const claimedPage = continuity.pages.find((page) =>
      page.cursor === reportedCursor && page.next_cursor === reportedNextCursor
    );
    if (!continuity.continuous || !claimedPage) {
      return {
        ok: false,
        error: "reference_analysis_page_gap_recovery_unverified",
        persisted_continuity: continuity,
      };
    }
    await this.updateState((current) => ({
      ...current,
      status: "pending",
      terminal_reason: "",
      terminal_blocker: undefined,
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    }));
    await this.appendEvent("reference_analysis_page_gap_recovered", {
      target_key: this.targetKey,
      persisted_continuity: continuity,
      next_action: state.next_cursor === null
        ? "review_staged_facts_and_seal_reference_analysis"
        : "read_reference_target_page",
    });
    return {
      ok: true,
      target_key: this.targetKey,
      next_cursor: state.next_cursor,
      fact_count: artifact.facts.length,
      persisted_continuity: continuity,
      required_action: state.next_cursor === null
        ? "review_staged_facts_and_seal_reference_analysis"
        : "read_reference_target_page_to_resume_the_persisted_cursor",
    };
  }

  private pageHasStagedFact(
    page: ReferenceAnalysisPage,
    factSpanIds: ReadonlySet<string>,
  ): boolean {
    return page.staged === true || page.span_ids.some((spanId) => factSpanIds.has(spanId));
  }

  private pageContinuity(
    state: ReferenceAnalysisState,
    artifact: ReferenceFactsArtifact,
  ): {
    continuous: boolean;
    expected_next_cursor: number | null;
    persisted_next_cursor: number | null;
    total_count: number;
    pages: Array<{ cursor: number; next_cursor: number | null; row_count: number; fact_count: number; staged: boolean }>;
  } {
    const factSpanIds = new Set(artifact.facts.flatMap((fact) => fact.span_ids));
    const pages = Object.values(state.pages).sort((left, right) => left.cursor - right.cursor);
    let expectedCursor = 0;
    let continuous = true;
    const persistedPages = pages.map((page) => {
      const expectedIds = this.occurrence.target_evidence_ids.slice(
        expectedCursor,
        expectedCursor + page.evidence_ids.length,
      );
      const expectedNextCursor = expectedCursor + page.evidence_ids.length < this.occurrence.target_evidence_ids.length
        ? expectedCursor + page.evidence_ids.length
        : null;
      if (
        page.cursor !== expectedCursor
        || page.evidence_ids.length === 0
        || page.evidence_ids.some((evidenceId, index) => evidenceId !== expectedIds[index])
        || page.next_cursor !== expectedNextCursor
      ) {
        continuous = false;
      }
      expectedCursor += page.evidence_ids.length;
      return {
        cursor: page.cursor,
        next_cursor: page.next_cursor,
        row_count: page.evidence_ids.length,
        fact_count: page.span_ids.filter((spanId) => factSpanIds.has(spanId)).length,
        staged: this.pageHasStagedFact(page, factSpanIds),
      };
    });
    const expectedNextCursor = expectedCursor < this.occurrence.target_evidence_ids.length ? expectedCursor : null;
    if (state.next_cursor !== expectedNextCursor) continuous = false;
    return {
      continuous,
      expected_next_cursor: expectedNextCursor,
      persisted_next_cursor: state.next_cursor,
      total_count: this.occurrence.target_evidence_ids.length,
      pages: persistedPages,
    };
  }

  private async renderPage(
    pageHandle: string,
    page: ReferenceAnalysisPage,
    resumedUnstagedPage = false,
  ): Promise<Record<string, unknown>> {
    const records = new Map(this.manifest.evidence.map((record) => [record.evidence_id, record]));
    const rows = page.evidence_ids.map((evidenceId, rowIndex) => {
      const record = records.get(evidenceId);
      if (!record) throw new Error(`Reference evidence is missing: ${evidenceId}`);
      return { row_index: rowIndex, text: record.text };
    });
    const endCursor = page.cursor + page.evidence_ids.length - 1;
    return {
      ok: true,
      target_key: this.targetKey,
      page_handle: pageHandle,
      cursor: page.cursor,
      next_cursor: page.next_cursor,
      done: page.next_cursor === null,
      rows,
      page_range: [page.cursor, endCursor],
      ...(resumedUnstagedPage ? { resumed_unstaged_page: true } : {}),
      instruction: `cursor=${page.cursor} 是本页第一行的绝对行号，next_cursor=${page.next_cursor === null ? "null" : page.next_cursor} 是下一页第一行。读取后续页之前，先提交本 page_handle 中的事实；cursor=48、next_cursor=64 表示已经返回第 48–63 行。`,
    };
  }

  private async readTargetPage(): Promise<Record<string, unknown>> {
    const state = await this.readState();
    if (state.status === "sealed") return { ok: true, ...await this.summary(), done: true, already_sealed: true };
    if (state.status === "failed") return {
      ok: false,
      terminal: true,
      error: "reference_analysis_failed",
      ...await this.summary(),
      required_action: "stop_current_target_and_inspect_reference_analysis_blocker",
    };
    const artifact = await readJson<ReferenceFactsArtifact>(this.workingFactsPath);
    const factSpanIds = new Set(artifact.facts.flatMap((fact) => fact.span_ids));
    const unstaged = Object.entries(state.pages)
      .sort(([, left], [, right]) => left.cursor - right.cursor)
      .find(([, page]) => !this.pageHasStagedFact(page, factSpanIds));
    if (unstaged) return this.renderPage(unstaged[0], unstaged[1], true);
    const cursor = state.next_cursor;
    if (cursor === null) return { ok: true, target_key: this.targetKey, done: true, next_cursor: null, instruction: "目标所有页面已读完。核对已暂存事实并封存。" };
    const ids = this.occurrence.target_evidence_ids.slice(cursor, cursor + PAGE_SIZE);
    const records = new Map(this.manifest.evidence.map((record) => [record.evidence_id, record]));
    const registry = await this.workspace.readSourceSpanRegistry();
    const spans = ids.map((evidenceId) => {
      const record = records.get(evidenceId);
      if (!record) throw new Error(`Reference evidence is missing: ${evidenceId}`);
      const span = registry.spans.find((candidate) =>
        candidate.evidence_id === evidenceId && candidate.start === 0 && candidate.end === record.text.length
      );
      if (!span) throw new Error(`Reference evidence has no registered full span: ${evidenceId}`);
      return { record, span };
    });
    const nextCursor = cursor + ids.length < this.occurrence.target_evidence_ids.length ? cursor + ids.length : null;
    const pageHandle = `reference-page:${sha256Json({ target_key: this.targetKey, cursor, ids, next_cursor: nextCursor })}`;
    await this.updateState((current) => ({
      ...current,
      status: "running",
      next_cursor: nextCursor,
      pages: {
        ...current.pages,
        [pageHandle]: { cursor, evidence_ids: ids, span_ids: spans.map(({ span }) => span.span_id), next_cursor: nextCursor },
      },
    }));
    return this.renderPage(pageHandle, {
      cursor,
      evidence_ids: ids,
      span_ids: spans.map(({ span }) => span.span_id),
      next_cursor: nextCursor,
    });
  }

  private async stageFacts(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const upserts = Array.isArray(input.upserts) ? input.upserts : [];
    if (upserts.length < 1 || upserts.length > FACT_PATCH_LIMIT) {
      return { ok: false, error: "reference_fact_patch_size", max_upserts: FACT_PATCH_LIMIT };
    }
    const state = await this.readState();
    if (state.status === "sealed" || state.status === "failed") return {
      ok: false,
      ...(state.status === "failed" ? { terminal: true } : {}),
      error: `reference_analysis_${state.status}`,
      ...(state.status === "failed" ? await this.summary() : {}),
    };
    const artifact = await readJson<ReferenceFactsArtifact>(this.workingFactsPath);
    const facts = new Map(artifact.facts.map((fact) => [fact.fact_key, fact]));
    const stagedPageHandles = new Set<string>();
    for (const raw of upserts) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "reference_fact_invalid" };
      const fact = raw as Record<string, unknown>;
      const factKey = String(fact.fact_key ?? "");
      const role = String(fact.role ?? "") as ReferenceFactRole;
      const pageHandle = String(fact.page_handle ?? "");
      const page = state.pages[pageHandle];
      const rowIndices = Array.isArray(fact.row_indices)
        ? [...new Set(fact.row_indices.map((value) => Number(value)))].sort((a, b) => a - b)
        : [];
      if (!factKey || !page || rowIndices.length === 0 || rowIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= page.span_ids.length)) {
        return { ok: false, error: "reference_fact_page_binding_invalid", fact_key: factKey, required_action: "use_a_returned_page_handle_and_valid_local_row_indexes" };
      }
      facts.set(factKey, {
        fact_key: factKey,
        role,
        span_ids: rowIndices.map((index) => page.span_ids[index]!),
        target_key: this.targetKey,
        reason: String(fact.reason ?? ""),
      });
      stagedPageHandles.add(pageHandle);
    }
    const nextFacts = [...facts.values()].sort((left, right) => left.fact_key.localeCompare(right.fact_key));
    await atomicWriteJson(this.workingFactsPath, { ...artifact, facts: nextFacts });
    await this.updateState((current) => ({
      ...current,
      status: "running",
      fact_count: nextFacts.length,
      pages: Object.fromEntries(Object.entries(current.pages).map(([handle, page]) => [
        handle,
        stagedPageHandles.has(handle) ? { ...page, staged: true } : page,
      ])),
    }));
    return { ok: true, target_key: this.targetKey, fact_count: nextFacts.length, staged_count: upserts.length };
  }

  private async readStagedFacts(): Promise<Record<string, unknown>> {
    const artifact = await readJson<ReferenceFactsArtifact>(this.workingFactsPath);
    const state = await this.readState();
    return { ok: true, target_key: this.targetKey, status: state.status, next_cursor: state.next_cursor, facts: artifact.facts };
  }

  private async seal(): Promise<Record<string, unknown>> {
    const state = await this.readState();
    if (state.status === "sealed") return { ok: true, idempotent: true, ...await this.summary() };
    const artifact = await readJson<ReferenceFactsArtifact>(this.workingFactsPath);
    const factSpanIds = new Set(artifact.facts.flatMap((fact) => fact.span_ids));
    const unstaged = Object.entries(state.pages)
      .sort(([, left], [, right]) => left.cursor - right.cursor)
      .find(([, page]) => !this.pageHasStagedFact(page, factSpanIds));
    if (unstaged) return {
      ok: false,
      error: "reference_analysis_page_stage_required",
      target_key: this.targetKey,
      page_handle: unstaged[0],
      cursor: unstaged[1].cursor,
      next_cursor: unstaged[1].next_cursor,
      required_action: "call_read_reference_target_page_to_resume_the_unstaged_page_then_stage_reference_facts",
    };
    if (state.next_cursor !== null) return { ok: false, error: "reference_analysis_exhaustive_read_incomplete", target_key: this.targetKey, next_cursor: state.next_cursor, required_action: "read_reference_target_page_until_done" };
    if (artifact.facts.length === 0) return { ok: false, error: "reference_analysis_facts_missing", target_key: this.targetKey, required_action: "stage_at_least_one_exact_reference_fact" };
    const registry = await this.workspace.readSourceSpanRegistry();
    const allowedEvidence = new Set(this.occurrence.target_evidence_ids);
    const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
    const invalid = artifact.facts.flatMap((fact) => fact.span_ids.filter((spanId) => {
      const span = spanById.get(spanId);
      return !span || !allowedEvidence.has(span.evidence_id);
    }).map((spanId) => ({ fact_key: fact.fact_key, span_id: spanId })));
    if (invalid.length > 0) return { ok: false, error: "reference_analysis_fact_span_invalid", invalid: invalid.slice(0, 8), invalid_count: invalid.length };
    const fingerprint = sha256Json(artifact);
    await atomicWriteJson(this.sealedFactsPath, artifact);
    await atomicWriteJson(this.sealReceiptPath, { schema_version: "reference-analysis-seal/v1", target_key: this.targetKey, fingerprint, fact_count: artifact.facts.length });
    await this.updateState((current) => ({ ...current, status: "sealed", fact_count: artifact.facts.length, seal_fingerprint: fingerprint, terminal_reason: "", terminal_blocker: undefined }));
    return { ok: true, target_key: this.targetKey, analysis_status: "sealed", fingerprint, fact_count: artifact.facts.length };
  }

  private async reportBlocker(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reason = String(input.reason ?? "").trim();
    const code = String(input.code ?? "") as ReferenceAnalysisBlockerCode;
    if (!reason) return { ok: false, error: "reference_analysis_blocker_reason_required" };
    if (![
      "page_gap", "source_unavailable", "semantic_ambiguity", "provider_failure", "other",
    ].includes(code)) {
      return {
        ok: false,
        error: "reference_analysis_blocker_code_required",
        required_action: "report_a_structured_blocker_code; use_page_gap_with_reported_cursor_and_reported_next_cursor_for_a_claimed_page_gap",
      };
    }
    const blocker: ReferenceAnalysisBlocker = { code, reason };
    if (code === "page_gap") {
      const reportedCursor = Number(input.reported_cursor);
      const reportedNextCursor = input.reported_next_cursor === null
        ? null
        : Number(input.reported_next_cursor);
      if (
        !Number.isInteger(reportedCursor)
        || reportedCursor < 0
        || (reportedNextCursor !== null && (!Number.isInteger(reportedNextCursor) || reportedNextCursor < 0))
      ) {
        return {
          ok: false,
          error: "reference_analysis_page_gap_coordinates_required",
          required_action: "provide_nonnegative_reported_cursor_and_reported_next_cursor; next_cursor_may_be_null_only_for_the_final_page",
        };
      }
      blocker.reported_cursor = reportedCursor;
      blocker.reported_next_cursor = reportedNextCursor;
      const [state, artifact] = await Promise.all([
        this.readState(),
        readJson<ReferenceFactsArtifact>(this.workingFactsPath),
      ]);
      const continuity = this.pageContinuity(state, artifact);
      const claimedPage = continuity.pages.find((page) =>
        page.cursor === reportedCursor && page.next_cursor === reportedNextCursor
      );
      if (continuity.continuous && claimedPage) {
        return {
          ok: false,
          error: "reference_analysis_blocker_rejected",
          blocker_code: "page_gap",
          target_key: this.targetKey,
          persisted_continuity: continuity,
          required_action: state.next_cursor === null
            ? "review_staged_facts_and_seal_reference_analysis"
            : "continue_with_read_reference_target_page; next_cursor_is_the_start_of_the_next_page_not_a_missing_page",
        };
      }
    }
    await this.updateState((current) => ({
      ...current,
      status: "failed",
      terminal_reason: reason,
      terminal_blocker: blocker,
    }));
    return { ok: true, target_key: this.targetKey, analysis_status: "failed", reason, blocker_code: code };
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.appendEvent("tool_execution_start", { tool_name: name, input });
    let output: Record<string, unknown>;
    try {
      output = name === "read_reference_target_page" ? await this.readTargetPage()
        : name === "stage_reference_facts" ? await this.stageFacts(input)
        : name === "read_staged_reference_facts" ? await this.readStagedFacts()
        : name === "seal_reference_analysis" ? await this.seal()
        : name === "report_reference_analysis_blocker" ? await this.reportBlocker(input)
        : toolReject({
          error: "unknown_reference_analysis_tool",
          instruction: "请使用 read_reference_target_page、stage_reference_facts、read_staged_reference_facts、seal_reference_analysis 或 report_reference_analysis_blocker，不得编造工具名。",
          actual_tool: name,
        });
    } catch (error) {
      output = catchToolReject(error, "reference_analysis_tool_rejected");
    }
    await this.appendEvent("tool_execution_end", { tool_name: name, output });
    return output;
  }
}

const ReferenceFactUpsertSchema = Type.Object({
  fact_key: Type.String({ minLength: 1 }),
  role: Type.Union([
    Type.Literal("scope"), Type.Literal("object"), Type.Literal("requirement"),
    Type.Literal("method"), Type.Literal("quantity"), Type.Literal("condition"),
    Type.Literal("allowed_value"), Type.Literal("exception"), Type.Literal("note"), Type.Literal("table_row"),
  ]),
  page_handle: Type.String({ minLength: 1 }),
  row_indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, uniqueItems: true }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function createReferenceAnalysisTools(controller: ReferenceAnalysisController): ToolDefinition[] {
  return [
    defineTool({ name: "read_reference_target_page", label: "读取引用目标页", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_reference_target_page"]!, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, input) => resultContent(await controller.dispatch("read_reference_target_page", input as Record<string, unknown>)) }),
    defineTool({ name: "stage_reference_facts", label: "暂存引用事实", description: ACCEPTANCE_TOOL_DESCRIPTIONS["stage_reference_facts"]!, parameters: Type.Object({ upserts: Type.Array(ReferenceFactUpsertSchema, { minItems: 1, maxItems: FACT_PATCH_LIMIT }) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, input) => resultContent(await controller.dispatch("stage_reference_facts", input as Record<string, unknown>)) }),
    defineTool({ name: "read_staged_reference_facts", label: "读取已暂存引用事实", description: ACCEPTANCE_TOOL_DESCRIPTIONS["read_staged_reference_facts"]!, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, input) => resultContent(await controller.dispatch("read_staged_reference_facts", input as Record<string, unknown>)) }),
    defineTool({ name: "seal_reference_analysis", label: "封存引用分析", description: ACCEPTANCE_TOOL_DESCRIPTIONS["seal_reference_analysis"]!, parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, input) => resultContent(await controller.dispatch("seal_reference_analysis", input as Record<string, unknown>)) }),
    defineTool({ name: "report_reference_analysis_blocker", label: "报告引用分析阻塞", description: ACCEPTANCE_TOOL_DESCRIPTIONS["report_reference_analysis_blocker"]!, parameters: Type.Object({ reason: Type.String({ minLength: 1 }), code: Type.Optional(Type.Union([Type.Literal("page_gap"), Type.Literal("source_unavailable"), Type.Literal("semantic_ambiguity"), Type.Literal("provider_failure"), Type.Literal("other")])), reported_cursor: Type.Optional(Type.Integer({ minimum: 0 })), reported_next_cursor: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])) }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, input) => resultContent(await controller.dispatch("report_reference_analysis_blocker", input as Record<string, unknown>)) }),
  ].map(replaceAcceptanceToolText);
}

export async function referenceAnalysisSummary(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
): Promise<ReferenceAnalysisSummary> {
  return (await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey)).summary();
}

export async function readSealedReferenceFacts(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  cursorInput = 0,
  limitInput = 32,
  phase: ReferenceAnalysisPhase = "target",
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const occurrence = occurrenceForTarget(manifest, targetKey);
  if (!occurrence) return referenceTargetNotFoundFeedback(targetKey, phase, "read_reference_facts");
  const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrence, phase);
  if (policy.analysis_mode !== "isolated") {
    return { ok: false, error: "inline_reference_facts_not_available", target_key: targetKey, analysis_mode: "inline", required_action: "read_document_reference_evidence_until_done" };
  }
  const controller = await ReferenceAnalysisController.openOrCreate(workspace, manifest, targetKey);
  const state = await controller.readState();
  if (state.status === "failed") {
    return {
      ok: false,
      terminal: true,
      error: "reference_analysis_failed",
      ...await controller.summary(),
      required_action: "stop_current_target_and_inspect_reference_analysis_blocker_before_any_manual_recovery",
    };
  }
  if (state.status !== "sealed") return { ok: false, error: "reference_analysis_not_sealed", ...await controller.summary(), required_action: "complete_reference_analysis" };
  const artifact = await readJson<ReferenceFactsArtifact>(controller.sealedFactsPath);
  const revisionState = await workspace.readState();
  const readKey = `${phase}:${targetKey}`;
  const progress = revisionState.reference_fact_reads?.[readKey];
  if (progress?.done) {
    return { ok: true, target_key: targetKey, fingerprint: state.seal_fingerprint, cursor: progress.total_count, next_cursor: null, total_count: progress.total_count, facts: [], already_done: true };
  }
  const expectedCursor = progress?.next_cursor ?? 0;
  if (cursorInput !== expectedCursor) {
    return { ok: false, error: "reference_facts_cursor_mismatch", target_key: targetKey, expected_cursor: expectedCursor, received_cursor: cursorInput, required_action: "read_reference_facts_with_exact_expected_cursor" };
  }
  const registry = await workspace.readSourceSpanRegistry();
  const records = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const spanById = new Map(registry.spans.map((span) => [span.span_id, span]));
  const cursor = Math.max(0, Math.trunc(cursorInput) || 0);
  const limit = Math.max(1, Math.min(64, Math.trunc(limitInput) || 32));
  const facts = artifact.facts.slice(cursor, cursor + limit).map((fact) => ({
    fact_key: fact.fact_key,
    role: fact.role,
    reason: fact.reason,
    spans: fact.span_ids.map((spanId) => {
      const span = spanById.get(spanId)!;
      const record = records.get(span.evidence_id)!;
      return { span_id: spanId, text: record.text.slice(span.start, span.end) };
    }),
  }));
  const nextCursor = cursor + facts.length < artifact.facts.length ? cursor + facts.length : null;
  await workspace.updateState((current) => {
    current.reference_fact_reads = {
      ...(current.reference_fact_reads ?? {}),
      [readKey]: {
        fingerprint: state.seal_fingerprint,
        total_count: artifact.facts.length,
        next_cursor: nextCursor,
        done: nextCursor === null,
      },
    };
  });
  return {
    ok: true,
    target_key: targetKey,
    fingerprint: state.seal_fingerprint,
    cursor,
    next_cursor: nextCursor,
    total_count: artifact.facts.length,
    facts,
    decomposition_review: {
      required: true,
      component_count: artifact.facts.length,
      instruction: "逐 fact/component 映射到独立 item、显式同一判断、完整 acceptance branch，或不适用；引用分析已封存不等于语义分解完成。",
    },
  };
}

export async function readInlineReferenceEvidencePage(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  cursorInput = 0,
  limitInput = INLINE_REFERENCE_PAGE_SIZE,
  phase: ReferenceAnalysisPhase = "target",
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const occurrence = occurrenceForTarget(manifest, targetKey);
  if (!occurrence) return referenceTargetNotFoundFeedback(targetKey, phase, "read_document_reference_evidence");
  const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrence, phase);
  if (policy.analysis_mode !== "inline") {
    return {
      ok: false,
      error: "isolated_reference_body_read_forbidden",
      instruction: "先用 read_reference_facts 的 target_key 取得目录，再按 entry_ids 及分页参数完整读取所选行。resolved_rows 返回已读行的 evidence_id 和整行 span_id；resolve_rows 只用于重新取得已读行句柄。不能用 open_evidence、read_document_reference_evidence 或定位工具读取尚未交付的隔离正文。目标作者读完一行后，可按该行 quote_locator 用 locate_evidence_span 定位自己选择的连续原文；读后定位不绕过隔离读取。",
      target_key: targetKey,
      analysis_mode: "isolated",
      required_action: "call_read_reference_facts_with_target_key_then_open_selected_entry_ids",
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: targetKey },
      writable_parameters: ["target_key"],
      do_not_edit: "不可变引用原文、已正确的 selector 或编译产物",
    };
  }
  const page = await readAndRecordDocumentReferenceEvidencePage(
    workspace,
    manifest,
    occurrence.occurrence_id,
    cursorInput,
    Math.min(INLINE_REFERENCE_PAGE_SIZE, Math.max(1, Math.trunc(limitInput) || INLINE_REFERENCE_PAGE_SIZE)),
    phase,
  );
  if (page.ok !== true) return { ...page, target_key: targetKey };
  const evidence = Array.isArray(page.evidence) ? page.evidence : [];
  return {
    ok: true,
    target_key: targetKey,
    analysis_mode: "inline",
    cursor: page.cursor,
    next_cursor: page.next_cursor,
    done: page.done,
    total_count: page.total_count,
    rows: evidence.map((entry, rowIndex) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      return {
        row_index: rowIndex,
        component_id: record.component_id ?? "",
        evidence_id: record.evidence_id ?? "",
        kind: record.kind ?? "",
        locator: record.locator ?? "",
        span_id: record.span_id ?? "",
        text: record.text ?? "",
      };
    }),
    decomposition_review: page.decomposition_review,
    instruction: SOURCE_READING_GUIDANCE,
  };
}

/** 目录只吃证据的这几个字段，转换一次，别把整条 EvidenceRecord 拖进纯函数层。 */
function targetCatalogEvidence(
  manifest: EvidenceManifest,
  occurrence: ReferenceOccurrence,
): CatalogEvidenceRecord[] {
  const byId = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const records: CatalogEvidenceRecord[] = [];
  for (const evidenceId of occurrence.target_evidence_ids) {
    const record = byId.get(evidenceId);
    if (!record) continue;
    records.push({
      evidence_id: record.evidence_id,
      role: record.role,
      locator: record.locator,
      text: record.text,
    });
  }
  return records;
}

const CATALOG_DISPOSITION_FINGERPRINT_VERSION = "reference-catalog-disposition-fingerprint/v2" as const;

/** 当前目标的证据或目录结构变了才重新表态；其他目标变化不能清空本目标进度。 */
function catalogFingerprint(
  targetKey: string,
  evidence: readonly CatalogEvidenceRecord[],
  entries: readonly ReferenceCatalogEntry[],
): string {
  return sha256Json({
    fingerprint_version: CATALOG_DISPOSITION_FINGERPRINT_VERSION,
    target_key: targetKey,
    target_evidence: evidence.map((record) => ({
      evidence_id: record.evidence_id,
      role: record.role,
      locator: record.locator,
      text: record.text,
    })),
    catalog_entries: entries.map((entry) => ({
      entry_id: entry.entry_id,
      source_label: entry.source_label,
      kind: entry.kind,
      title: entry.title,
      rows: entry.rows,
      notes: entry.notes,
      segments: entry.segments,
      start_line: entry.start_line,
      end_line: entry.end_line,
      evidence_ids: entry.evidence_ids,
    })),
  });
}

async function resolveCatalogForTarget(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  occurrence: ReferenceOccurrence,
  ask?: CatalogRuleAsk | undefined,
  signal?: AbortSignal | undefined,
): Promise<{ evidence: CatalogEvidenceRecord[]; resolved: ResolvedCatalog }> {
  throwIfAborted(signal);
  const evidence = targetCatalogEvidence(manifest, occurrence);
  const cache: CatalogRuleCache = {
    getFallback: async key => {
      throwIfAborted(signal);
      const state = await workspace.readState();
      throwIfAborted(signal);
      return state.reference_catalog_fallbacks?.[key];
    },
    setFallback: async (key, fingerprint, writeSignal) => {
      const activeSignal = writeSignal ?? signal;
      throwIfAborted(activeSignal);
      let previous: string | undefined;
      await workspace.updateState(current => {
        throwIfAborted(activeSignal);
        previous = current.reference_catalog_fallbacks?.[key];
        current.reference_catalog_fallbacks = { ...(current.reference_catalog_fallbacks ?? {}), [key]: fingerprint };
      });
      if (activeSignal?.aborted) {
        await workspace.updateState(current => {
          if (current.reference_catalog_fallbacks?.[key] !== fingerprint) return;
          const fallbacks = { ...(current.reference_catalog_fallbacks ?? {}) };
          if (previous) fallbacks[key] = previous;
          else delete fallbacks[key];
          current.reference_catalog_fallbacks = fallbacks;
        });
        throwIfAborted(activeSignal);
      }
    },
    get: async (key) => {
      throwIfAborted(signal);
      const state = await workspace.readState();
      throwIfAborted(signal);
      return state.reference_catalog_rules?.[key];
    },
    set: async (key, rules, writeSignal) => {
      const activeSignal = writeSignal ?? signal;
      throwIfAborted(activeSignal);
      let previous: ReferenceCatalogRules | undefined;
      await workspace.updateState((current) => {
        throwIfAborted(activeSignal);
        previous = current.reference_catalog_rules?.[key];
        current.reference_catalog_rules = { ...(current.reference_catalog_rules ?? {}), [key]: rules };
      });
      if (activeSignal?.aborted) {
        await workspace.updateState((current) => {
          const currentRules = current.reference_catalog_rules?.[key];
          if (!currentRules || sha256Json(currentRules) !== sha256Json(rules)) return;
          const catalogRules = { ...(current.reference_catalog_rules ?? {}) };
          if (previous) catalogRules[key] = previous;
          else delete catalogRules[key];
          current.reference_catalog_rules = catalogRules;
        });
        throwIfAborted(activeSignal);
      }
    },
  };
  const resolved = await resolveReferenceCatalog({
    targetKey,
    evidence,
    cache,
    ...(ask ? {
      ask,
      flightKey: `${resolve(workspace.root)}\0${targetKey}\0${sha256Json(evidence)}`,
    } : {}),
    ...(signal ? { signal } : {}),
  });
  throwIfAborted(signal);
  return { evidence, resolved };
}

interface CatalogDispositionState {
  fingerprint_version: typeof CATALOG_DISPOSITION_FINGERPRINT_VERSION;
  fingerprint: string;
  rule_source: string;
  entry_ids: string[];
  used: string[];
  ignored: Array<{ entry_id: string; reason: string }>;
  opened_ranges?: Record<string, Record<string, Array<[number, number]>>>;
  pending_delivery?: Array<{ entry_id: string; row_cursor: number; row_offset: number }>;
}

/** Mechanical continuation of explicitly requested text, never an applicability verdict. */
export function referenceCatalogDeliveryWork(state: RevisionState, phase: ReferenceAnalysisPhase = "target"): {
  identity: string; code: "reference_source_delivery_pending"; path: "/references";
  advisory_only: true; budget_consumed: false; full_stage_check_performed: false;
  target_key: string; pending_delivery_count: number;
  diagnostic_read: { tool: "read_reference_facts"; arguments: {
    target_key: string; entry_ids: string[]; row_cursor: number; row_offset: number;
  } };
  record_read?: { tool: string; arguments: Record<string, unknown> };
  instruction: string;
} | undefined {
  const entry = Object.entries(state.reference_catalog_dispositions ?? {})
    .find(([key, value]) => key.startsWith(`${phase}:`) && value.pending_delivery?.length);
  if (!entry) return undefined;
  const [key, value] = entry;
  const target_key = key.slice(phase.length + 1);
  const pending = value.pending_delivery!;
  const first = pending[0]!;
  return {
    identity: sha256Json({ target_key, fingerprint: value.fingerprint, pending }),
    code: "reference_source_delivery_pending", path: "/references",
    advisory_only: true, budget_consumed: false, full_stage_check_performed: false,
    target_key, pending_delivery_count: pending.length,
    diagnostic_read: { tool: "read_reference_facts", arguments: {
      target_key, entry_ids: [first.entry_id], row_cursor: first.row_cursor, row_offset: first.row_offset,
    } },
    instruction: "这是先前明确请求但尚未交付的正文。先按 diagnostic_read 补读，跟随每次回条的下一次调用直到交付完成，再继续对应作者待办。历史已读不代表本轮已拿到正文；交付完成也不代表适用性或业务完整性已通过。",
  };
}

async function readCatalogDisposition(
  workspace: RevisionWorkspace,
  readKey: string,
  fingerprint: string,
): Promise<CatalogDispositionState | undefined> {
  const state = await workspace.readState();
  const persisted = state.reference_catalog_dispositions?.[readKey];
  if (
    !persisted
    || persisted.fingerprint_version !== CATALOG_DISPOSITION_FINGERPRINT_VERSION
    || persisted.fingerprint !== fingerprint
  ) return undefined;
  return persisted as CatalogDispositionState;
}

async function writeCatalogDisposition(
  workspace: RevisionWorkspace,
  readKey: string,
  next: CatalogDispositionState,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let previous: NonNullable<RevisionState["reference_catalog_dispositions"]>[string] | undefined;
  await workspace.updateState((current) => {
    throwIfAborted(signal);
    previous = current.reference_catalog_dispositions?.[readKey];
    current.reference_catalog_dispositions = {
      ...(current.reference_catalog_dispositions ?? {}),
      [readKey]: next,
    };
  });
  if (signal?.aborted) {
    await workspace.updateState((current) => {
      const currentDisposition = current.reference_catalog_dispositions?.[readKey];
      if (!currentDisposition || sha256Json(currentDisposition) !== sha256Json(next)) return;
      const dispositions = { ...(current.reference_catalog_dispositions ?? {}) };
      if (previous) dispositions[readKey] = previous;
      else delete dispositions[readKey];
      current.reference_catalog_dispositions = dispositions;
    });
    throwIfAborted(signal);
  }
}

function openedRangesCoverText(
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
  textLength: number,
): boolean {
  if (!ranges || ranges.length === 0) return false;
  if (ranges.some(([start, end]) =>
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || end > textLength
  )) return false;
  let coveredUntil = 0;
  for (const [start, end] of ranges) {
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= textLength) return true;
  }
  return false;
}

function catalogEntryFullyOpened(
  disposition: CatalogDispositionState,
  entry: ReferenceCatalogEntry,
  recordsById: ReadonlyMap<string, CatalogEvidenceRecord>,
): boolean {
  const openedRows = disposition.opened_ranges?.[entry.entry_id];
  if (!openedRows || entry.evidence_ids.length === 0) return false;
  return entry.evidence_ids.every((evidenceId, rowIndex) => {
    const record = recordsById.get(evidenceId);
    return record !== undefined
      && openedRangesCoverText(openedRows[String(rowIndex)], record.text.length);
  });
}

function pendingEntryIds(
  disposition: CatalogDispositionState,
  entries: readonly ReferenceCatalogEntry[],
  recordsById: ReadonlyMap<string, CatalogEvidenceRecord>,
): string[] {
  const ignored = new Set(disposition.ignored.map((entry) => entry.entry_id));
  return entries
    .filter((entry) => !ignored.has(entry.entry_id) && !catalogEntryFullyOpened(disposition, entry, recordsById))
    .map((entry) => entry.entry_id);
}

export interface ReferenceCatalogRequest {
  /** 定位诊断点名的证据到目录条目和行；只返回导航，不登记正文已读或业务处置。 */
  evidence_ids?: readonly string[] | undefined;
  row_cursor?: number | undefined;
  row_offset?: number | undefined;
  catalog_cursor?: number | undefined;
  /** 取这些条目的原文；条目同时记为 used（表示已选择或开始读取，不表示已完整读完）。 */
  entry_ids?: readonly string[] | undefined;
  /** 明确不要这些条目，必须给理由；记为 ignored。 */
  skip?: readonly { entry_id: string; reason: string }[] | undefined;
  /** 点名先前已打开的行，重新返回 evidence_id + 已登记的整行 span_id；本次完整打开的行会自动返回。 */
  resolve_rows?: readonly { entry_id: string; row_index: number }[] | undefined;
  /**
   * 一句话处理掉所有没点名的条目。
   *
   * 没有这条时，「挑着开」要为每个不要的条目单写一个 {entry_id, reason}——34 条目录里
   * 挑 4 条得写 30 条理由，比直接全开贵一个数量级。于是模型一律全开：现场实测它拿到
   * 目录后零推理直接把 34 条全列进 entry_ids。激励设反了，光靠提示词纠不回来。
   */
  skip_rest?: { reason: string } | undefined;
}

/** 一次最多取得多少行的引用凭证，不需要整份换回来。 */
const MAX_RESOLVED_ROWS = 24;
/** 单次展开的正文字节上限。超出的条目原样退回，让模型分批取或改成 skip。 */
const MAX_OPENED_BYTES_PER_CALL = 32 * 1024;

/**
 * 被引目标的目录接口。不带参数返回目录本身（几 KB）；带 entry_ids 才展开原文。
 *
 * 这替代了「一股脑把全部要点推给主 Agent」——附录 B 那一版单次回执 49 KB、
 * 三个附录合计 138 KB，直接把 256 KiB 的累计预算撞爆。
 */
export async function readReferenceCatalog(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  request: ReferenceCatalogRequest = {},
  phase: ReferenceAnalysisPhase = "target",
  ask?: CatalogRuleAsk | undefined,
  signal?: AbortSignal | undefined,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  throwIfAborted(signal);
  if ((request.resolve_rows?.length ?? 0) > MAX_RESOLVED_ROWS) {
    return { ok: false, error: "reference_catalog_row_batch_limit", max_rows: MAX_RESOLVED_ROWS };
  }
  const occurrence = occurrenceForTarget(manifest, targetKey);
  if (!occurrence) return referenceTargetNotFoundFeedback(targetKey, phase, "read_reference_facts");

  if (request.evidence_ids !== undefined) {
    const conflicting = Object.entries(request).filter(([key, value]) => key !== "evidence_ids" && value !== undefined).map(([key]) => key);
    const invalid = request.evidence_ids.length === 0 || request.evidence_ids.length > 24;
    if (conflicting.length || invalid) return {
      ok: false, error: "reference_catalog_navigation_arguments_conflict", target_key: targetKey,
      actual: { evidence_count: request.evidence_ids.length, conflicting_parameters: conflicting },
      expected: "证据定位只传 target_key 和 1～24 个 evidence_ids；正文读取、游标和 skip 另行调用。",
      writable_paths: ["/evidence_ids", ...conflicting.map(key => `/${key}`)],
      next_tool: "read_reference_facts", next_tool_arguments: { target_key: targetKey },
      instruction: "按实际参数修正导航调用；若不确定证据编号，先取目录。此次没有打开正文或修改处置。",
    };
    const unknown = request.evidence_ids.filter(id => !occurrence.target_evidence_ids.includes(id));
    if (unknown.length) return {
      ok: false, error: "reference_catalog_evidence_not_found", target_key: targetKey,
      actual: { unknown_evidence_ids: unknown }, expected: "evidence_ids 必须属于当前登记引用目标。",
      writable_paths: ["/evidence_ids"], next_tool: "read_reference_facts", next_tool_arguments: { target_key: targetKey },
      instruction: "从当前诊断或来源目录复制属于此 target_key 的证据编号，不猜造或跨目标借用；此次没有打开正文或修改处置。",
    };
  }

  // inline 小目标一次就能读完，走目录反而多一趟往返，也绕过 inline 的字节预算记账。
  const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrence, phase, signal);
  throwIfAborted(signal);
  if (policy.analysis_mode !== "isolated") {
    return {
      ok: false,
      error: "inline_reference_catalog_not_available",
      target_key: targetKey,
      analysis_mode: "inline",
      evidence_count: policy.evidence_count,
      required_action: "page_inline_reference_with_read_document_reference_evidence",
      next_tool: "read_document_reference_evidence",
      tool_arguments: { target_key: targetKey, cursor: 0 },
      next_tool_arguments: { target_key: targetKey, cursor: 0 },
      writable_parameters: ["target_key", "cursor", "limit"],
      do_not_edit: "不可变引用原文、已正确的 selector 或编译产物",
      instruction: "此目标采用 inline 读取，不提供 read_reference_facts 目录。按 next_tool_arguments 调用 read_document_reference_evidence，首次传入返回的 target_key 和 cursor=0；后续把每次回条的 next_cursor 原样作为下一次 cursor，直到 done=true。cursor 必须是非负整数，limit 可省略或填写 1～24。领域读取参数仅为 target_key、cursor、limit，不沿用目录接口的 entry_ids 或 catalog_cursor；直接使用当前回条中的短句柄，来源所属目标由程序绑定。",
    };
  }

  const { evidence, resolved: resolvedCatalog } = await resolveCatalogForTarget(workspace, manifest, targetKey, occurrence, ask, signal);
  const activeSignal = resolvedCatalog.local_timeout_fallback ? undefined : signal;
  throwIfAborted(activeSignal);
  if (request.evidence_ids !== undefined) {
    const routes = [...new Set(request.evidence_ids)].flatMap(evidenceId => {
      const entry = resolvedCatalog.entries.find(candidate => candidate.evidence_ids.includes(evidenceId));
      if (!entry) return [];
      const row = entry.evidence_ids.indexOf(evidenceId);
      return [{ evidence_id: evidenceId, entry_id: entry.entry_id, row_index: row,
        next_tool: "read_reference_facts", next_tool_arguments: {
          target_key: targetKey, entry_ids: [entry.entry_id], row_cursor: row, row_offset: 0,
        } }];
    });
    if (routes.length !== new Set(request.evidence_ids).size) return {
      ok: false, terminal: true, error: "reference_catalog_source_route_unavailable", target_key: targetKey,
      actual: { unrouted_evidence_ids: request.evidence_ids.filter(id => !routes.some(route => route.evidence_id === id)) },
      expected: "当前引用库存中的每个证据必须能映射到目录行。", writable_paths: [],
      instruction: "这是目录映射缺失，作者不能修改来源库存或猜造行号；保留检查点供 harness 排查。",
    };
    return { ok: true, metadata_only: true, target_key: targetKey, source_routes: routes,
      next_tool: routes[0]!.next_tool, next_tool_arguments: routes[0]!.next_tool_arguments,
      instruction: "这里只定位诊断点名的真实来源，没有交付正文、授予 span 或判断适用性。按 source_routes 的调用读取对应行；同一次正文返回已覆盖的其他点名行可复用，不重复读取。正文及分页仍用原读取预算，依据实际原文保存业务决定。",
    };
  }
  const fingerprint = catalogFingerprint(targetKey, evidence, resolvedCatalog.entries);
  const readKey = `${phase}:${targetKey}`;
  const disposition: CatalogDispositionState = await readCatalogDisposition(workspace, readKey, fingerprint)
    ?? {
      fingerprint_version: CATALOG_DISPOSITION_FINGERPRINT_VERSION,
      fingerprint,
      rule_source: resolvedCatalog.rule_source,
      entry_ids: resolvedCatalog.entries.map((entry) => entry.entry_id),
      used: [],
      ignored: [],
    };
  throwIfAborted(activeSignal);

  const byEntryId = new Map(resolvedCatalog.entries.map((entry) => [entry.entry_id, entry]));
  const recordsById = new Map(evidence.map((record) => [record.evidence_id, record]));
  const unknown: Array<{
    entry_id: string;
    parameter: "entry_ids" | "skip" | "resolve_rows";
    index: number;
    path: string;
  }> = [];

  for (const [index, skipped] of (request.skip ?? []).entries()) {
    if (!byEntryId.has(skipped.entry_id)) {
      unknown.push({ entry_id: skipped.entry_id, parameter: "skip", index, path: `/skip/${index}/entry_id` });
      continue;
    }
    if (disposition.ignored.some((entry) => entry.entry_id === skipped.entry_id)) continue;
    disposition.used = disposition.used.filter((entryId) => entryId !== skipped.entry_id);
    disposition.ignored.push({ entry_id: skipped.entry_id, reason: skipped.reason });
  }

  const entryBytes = (entry: ReferenceCatalogEntry): number => entry.evidence_ids.reduce(
    (total, evidenceId) => total + Buffer.byteLength(recordsById.get(evidenceId)?.text ?? "", "utf8"),
    0,
  );

  const rowCursor = request.row_cursor ?? 0, rowOffset = request.row_offset ?? 0;
  const catalogCursor = request.catalog_cursor ?? 0;
  const cursorFields = [
    { field: "row_cursor", value: rowCursor },
    { field: "row_offset", value: rowOffset },
    { field: "catalog_cursor", value: catalogCursor },
  ] as const;
  const invalidCursorFields = cursorFields.filter(({ value }) => !Number.isInteger(value) || value < 0);
  const entryIds = [...(request.entry_ids ?? [])];
  const sourceContinuationCombinationInvalid = Boolean(rowCursor || rowOffset) && entryIds.length !== 1;
  if (invalidCursorFields.length > 0 || sourceContinuationCombinationInvalid) {
    const actual = {
      entry_ids: entryIds,
      entry_id_count: entryIds.length,
      row_cursor: rowCursor,
      row_offset: rowOffset,
      catalog_cursor: catalogCursor,
    };
    if (invalidCursorFields.length > 0) {
      const invalidSourceCursorFields = invalidCursorFields.filter(({ field }) => field !== "catalog_cursor");
      const catalogCursorIsInvalid = invalidCursorFields.some(({ field }) => field === "catalog_cursor");
      const allowedActions: string[] = [];
      if (invalidSourceCursorFields.length > 0) {
        allowedActions.push("继续当前单一条目正文：若掌握同一上一回条配套返回的 next_row_cursor 与 next_row_offset，则同时原样替换 row_cursor 和 row_offset；否则同时省略 row_cursor 和 row_offset，从该条目开头重读。");
      }
      if (catalogCursorIsInvalid) {
        allowedActions.push("继续目录翻页：catalog_cursor 改为上一回条的 next_catalog_cursor；若改为从目录第一页读取，则省略 catalog_cursor。目录游标与正文游标相互独立。");
      }
      return {
        ok: false,
        error: "reference_catalog_cursor_invalid",
        reason: "回条列出的游标字段不是非负整数。",
        actual: {
          ...actual,
          invalid_cursor_fields: invalidCursorFields.map(({ field, value }) => ({
            field,
            value,
            displayed_value: String(value),
          })),
        },
        expected: {
          invalid_cursor_fields: Object.fromEntries(invalidCursorFields.map(({ field }) => [field, `${field} 必须是非负整数。`])),
          ...(invalidSourceCursorFields.length > 0
            ? { source_pagination: "继续单一条目正文时，使用上一回条配套返回的 next_row_cursor、next_row_offset；从条目开头读取时省略 row_cursor、row_offset。" }
            : {}),
          ...(catalogCursorIsInvalid
            ? { catalog_pagination: "继续目录时原样使用上一回条的 next_catalog_cursor；从目录第一页读取时省略 catalog_cursor。catalog_cursor 与正文游标相互独立。" }
            : {}),
        },
        allowed_actions: allowedActions,
        next_tool: "read_reference_facts",
        next_tool_arguments: {
          target_key: targetKey,
          ...(entryIds.length > 0 ? { entry_ids: entryIds } : {}),
          ...(invalidSourceCursorFields.length === 0 && request.row_cursor !== undefined ? { row_cursor: rowCursor } : {}),
          ...(invalidSourceCursorFields.length === 0 && request.row_offset !== undefined ? { row_offset: rowOffset } : {}),
          ...(!catalogCursorIsInvalid && request.catalog_cursor !== undefined ? { catalog_cursor: catalogCursor } : {}),
        },
        how_to_pass: allowedActions.join(" "),
        instruction: "只修正 actual.invalid_cursor_fields 点名的游标，或按 allowed_actions 省略相应游标从起点读取。本次没有修改只读原文，也没有写入目录处置状态。",
      };
    }
    return {
      ok: false,
      error: "reference_catalog_cursor_invalid",
      reason: "正文续页游标只能与恰好一个 entry_id 组合。",
      actual,
      expected: {
        cursor_values: "row_cursor、row_offset、catalog_cursor 必须都是非负整数。",
        source_continuation: "row_cursor 或 row_offset 非零时，entry_ids 必须恰好包含一个目录 entry_id。",
        multiple_entries: "同时打开多个 entry_id 时省略 row_cursor 和 row_offset，使每个条目都从开头读取。",
        catalog_pagination: "catalog_cursor 只用于目录翻页，与正文续页的 row_cursor、row_offset 相互独立。",
      },
      allowed_actions: [
        "继续单一条目：entry_ids 只保留一个条目，并把该条目上一回条的 next_row_cursor、next_row_offset 原样传为 row_cursor、row_offset。",
        "打开多个条目：保留多个 entry_ids，同时省略 row_cursor 和 row_offset，从各条目开头读取。",
      ],
      next_tool: "read_reference_facts",
      next_tool_arguments: {
        target_key: targetKey,
        ...(entryIds.length > 0 ? { entry_ids: entryIds } : {}),
      },
      how_to_pass: "二选一修正：若继续单一条目，只保留一个 entry_id，并原样使用该条目上一回条返回的 next_row_cursor、next_row_offset；若打开多个条目，省略 row_cursor、row_offset，从每个条目开头读取。catalog_cursor 仅按 next_catalog_cursor 原样用于目录翻页，不代替或约束正文续页游标。",
      instruction: "三个游标值本身都是非负整数；失败原因是正文续页游标与 entry_ids 的组合不符合读取契约。本次没有修改只读原文，也没有写入目录处置状态；请按 allowed_actions 选择一种方式重新调用。",
    };
  }
  const explicitlyRequestedEntryIds = new Set(entryIds.filter((entryId) => byEntryId.has(entryId)));
  const deliveryPending = new Map((disposition.pending_delivery ?? []).map(row => [row.entry_id, row]));
  for (const entryId of explicitlyRequestedEntryIds) {
    deliveryPending.set(entryId, { entry_id: entryId, row_cursor: rowCursor, row_offset: rowOffset });
  }
  disposition.ignored = disposition.ignored.filter((ignored) =>
    !explicitlyRequestedEntryIds.has(ignored.entry_id)
  );
  const opened: Array<Record<string, unknown>> = [];
  const openedRowsToResolve: Array<{ entry_id: string; row_index: number }> = [];
  let openedBytes = 0, openedRows = 0;
  const deferred: string[] = [];
  for (const [index, entryId] of (request.entry_ids ?? []).entries()) {
    const entry = byEntryId.get(entryId);
    if (!entry) {
      unknown.push({ entry_id: entryId, parameter: "entry_ids", index, path: `/entry_ids/${index}` });
      continue;
    }
    if (rowCursor >= entry.evidence_ids.length) return {ok:false,error:"reference_catalog_cursor_out_of_bounds",entry_id:entryId,row_count:entry.evidence_ids.length,
      instruction:"把 row_cursor 改为当前条目内存在的从 0 开始的行号，再重试 read_reference_facts；不要修改来源原文。"};
    if (openedRows >= 24 || openedBytes >= MAX_OPENED_BYTES_PER_CALL) { deferred.push(entryId); continue; }
    const rows: Array<[number,string]> = [];
    let cursor=rowCursor, offset=rowOffset;
    disposition.opened_ranges ??= {};
    // Old persisted dispositions predate pagination and represented whole-entry reads.
    if (!disposition.opened_ranges[entryId]) disposition.opened_ranges[entryId] = disposition.used.includes(entryId)
      ? Object.fromEntries(entry.evidence_ids.map((id,i)=>[String(i),[[0,(recordsById.get(id)?.text ?? "").length]]])) : {};
    while (cursor < entry.evidence_ids.length && openedRows < 24 && openedBytes < MAX_OPENED_BYTES_PER_CALL) {
      const currentRow = cursor;
      const text = recordsById.get(entry.evidence_ids[cursor]!)?.text ?? "";
      if (offset > text.length) {
        return {
          ok: false, error: "reference_catalog_row_offset_invalid", entry_id: entryId,
          row_cursor: cursor, row_offset: offset, row_length: text.length,
          instruction: "使用返回的 next_row_offset 继续本行，或用 read_reference_facts 从 row_offset=0 重新读取。原文只读。",
        };
      }
      const remaining = MAX_OPENED_BYTES_PER_CALL - openedBytes;
      let end = offset, chunkBytes = 0;
      // Count bytes once per code point; preserve Unicode across page boundaries.
      for (const ch of text.slice(offset)) {
        const bytes = Buffer.byteLength(ch, "utf8");
        if (chunkBytes + bytes > remaining) break;
        end += ch.length;
        chunkBytes += bytes;
      }
      if (end === offset && offset < text.length) break;
      rows.push([cursor, text.slice(offset, end)]);
      openedBytes += chunkBytes;
      openedRows++;
      const ranges = disposition.opened_ranges[entryId]![String(cursor)] ?? [];
      ranges.push([offset, end]);
      ranges.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      disposition.opened_ranges[entryId]![String(cursor)] = merged;
      if (merged.some(([start, finish]) => start === 0 && finish >= text.length)) {
        openedRowsToResolve.push({ entry_id: entry.entry_id, row_index: currentRow });
      }
      if (end < text.length) { offset = end; break; }
      cursor++;
      offset = 0;
    }
    if(!rows.length) {deferred.push(entryId);continue;}
    if (!disposition.used.includes(entryId)) disposition.used.push(entryId);
    disposition.ignored = disposition.ignored.filter(ignored => ignored.entry_id !== entryId);
    opened.push({entry_id:entry.entry_id,source_label:entry.source_label,kind:entry.kind,title:entry.title.slice(0,200),lines:`${entry.start_line}-${entry.end_line}`,
      rows,row_cursor:rowCursor,row_offset:rowOffset,total_rows:entry.evidence_ids.length,
      next_row_cursor:cursor<entry.evidence_ids.length?cursor:null,next_row_offset:cursor<entry.evidence_ids.length?offset:null});
    if (cursor < entry.evidence_ids.length) deliveryPending.set(entryId, { entry_id: entryId, row_cursor: cursor, row_offset: offset });
    else deliveryPending.delete(entryId);
  }

  const rowsToResolve = [...new Map([
    ...openedRowsToResolve,
    ...(request.resolve_rows ?? []),
  ].map((row) => [`${row.entry_id}\0${row.row_index}`, row])).values()];
  const resolved: Array<Record<string, unknown>> = [];
  const registry = rowsToResolve.length ? await workspace.readSourceSpanRegistry() : undefined;
  throwIfAborted(activeSignal);
  for (const [index, requestedRow] of (request.resolve_rows ?? []).entries()) {
    if (!byEntryId.has(requestedRow.entry_id)) {
      unknown.push({
        entry_id: requestedRow.entry_id,
        parameter: "resolve_rows",
        index,
        path: `/resolve_rows/${index}/entry_id`,
      });
    }
  }
  for (const request_ of rowsToResolve) {
    const entry = byEntryId.get(request_.entry_id);
    if (!entry) continue;
    if (!Number.isInteger(request_.row_index) || request_.row_index < 0 || request_.row_index >= entry.evidence_ids.length) {
      return { ok: false, error: "reference_catalog_row_out_of_bounds", entry_id: entry.entry_id, row_index: request_.row_index, row_count: entry.evidence_ids.length };
    }
    const ranges=disposition.opened_ranges?.[entry.entry_id]?.[String(request_.row_index)];
    const rowText=recordsById.get(entry.evidence_ids[request_.row_index]!)?.text ?? "";
    if (!disposition.used.includes(entry.entry_id) || (disposition.opened_ranges?.[entry.entry_id] && !(ranges?.some(([a,b])=>a===0 && b>=rowText.length)))) {
      return { ok: false, error: "reference_catalog_entry_not_opened", entry_id: entry.entry_id,
        required_action: "open_entry_with_entry_ids_before_resolving_rows", instruction: "先用 read_reference_facts 的 entry_ids、row_cursor 和 next_row_offset 完整读取本行，再请求整行 span。未读行不能引用。" };
    }
    const evidenceId = entry.evidence_ids[request_.row_index];
    const record = evidenceId === undefined ? undefined : recordsById.get(evidenceId);
    const span = record && registry?.spans.find((candidate) =>
      candidate.evidence_id === record.evidence_id && candidate.start === 0 && candidate.end === record.text.length
    );
    const issues: SourceSpanIssue[] = [];
    const verified = record && span && registry && resolveSourceSpan(registry, span.span_id,
      new Map([[record.evidence_id, { source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text }]]),
      "/resolve_rows/span_id", issues);
    if (!verified) {
      return { ok: false, terminal: true, error: "reference_catalog_row_span_unavailable", entry_id: entry.entry_id,
        row_index: request_.row_index, evidence_id: evidenceId, issues,
        instruction: "已登记引用行缺少有效整行 span。请报告登记表缺陷，不要猜测 span 或反复重试已阻塞的定位请求。" };
    }
    resolved.push({ entry_id: entry.entry_id, row_index: request_.row_index, evidence_id: evidenceId, span_id: verified.span_id,
      ...(phase === "target" ? { quote_locator: {
        tool: "locate_evidence_span", fixed_arguments: { evidence_id: evidenceId },
        author_required_parameters: ["quote"], optional_parameters: ["prefix", "suffix"],
      } } : {}),
    });
  }

  if (request.skip_rest && request.skip_rest.reason) {
    for (const entry of resolvedCatalog.entries) {
      if (explicitlyRequestedEntryIds.has(entry.entry_id)) continue;
      if (disposition.used.includes(entry.entry_id)) continue;
      if (disposition.ignored.some((ignored) => ignored.entry_id === entry.entry_id)) continue;
      disposition.ignored.push({ entry_id: entry.entry_id, reason: request.skip_rest.reason });
    }
  }

  if (unknown.length > 0) {
    const unknownParameters = new Set(unknown.map((entry) => entry.parameter));
    const repairInstructions = [
      unknownParameters.has("entry_ids")
        ? "从返回目录逐字复制所需的机器 entry_id，用 target_key 和 entry_ids 再次调用 read_reference_facts；只替换 unknown_entry_parameters 指向的 entry_ids 元素，保留其他正确 entry_ids。"
        : "",
      unknownParameters.has("skip")
        ? "只把 unknown_entry_parameters 指向的 skip[].entry_id 替换为目录返回的机器 entry_id，保留同一 skip 记录的 reason 和其他正确参数。"
        : "",
      unknownParameters.has("resolve_rows")
        ? "只把 unknown_entry_parameters 指向的 resolve_rows[].entry_id 替换为目录返回的机器 entry_id，保留同一 resolve_rows 记录的 row_index 和其他正确参数。"
        : "",
    ].filter(Boolean);
    return {
      ok: false,
      error: "reference_catalog_entry_not_found",
      target_key: targetKey,
      unknown_entry_ids: unknown.map((entry) => entry.entry_id).slice(0, 8),
      unknown_entry_parameters: unknown.slice(0, 8),
      required_action: "read_reference_catalog_then_use_listed_entry_ids",
      next_tool: "read_reference_facts",
      tool_arguments: { target_key: targetKey },
      writable_parameters: [
        ...(["entry_ids", "skip", "resolve_rows"] as const)
          .filter((parameter) => unknownParameters.has(parameter)),
      ],
      do_not_edit: "不可变引用原文、已正确的 selector 或编译产物",
      instruction: `先只传本回条的 target_key 调用 read_reference_facts，取得当前目录；${repairInstructions.join("")}不要猜测、改写或沿用目录中不存在的 entry_id。`,
    };
  }

  throwIfAborted(activeSignal);
  for (const ignored of disposition.ignored) deliveryPending.delete(ignored.entry_id);
  disposition.pending_delivery = [...deliveryPending.values()];
  await writeCatalogDisposition(workspace, readKey, disposition, activeSignal);
  throwIfAborted(activeSignal);
  const pending = pendingEntryIds(disposition, resolvedCatalog.entries, recordsById);
  const deliveryWork = referenceCatalogDeliveryWork({ reference_catalog_dispositions: { [readKey]: disposition } } as RevisionState, phase);
  const inventory = new Set(occurrence.target_evidence_ids);
  const representations = [...tableRowRepresentationIds(manifest.evidence.filter(row => inventory.has(row.evidence_id)))];
  return {
    ok: true,
    target_key: targetKey,
    rule_source: resolvedCatalog.rule_source,
    total_entries: resolvedCatalog.entries.length,
    evidence_count: evidence.length,
    ...(representations.length ? { same_physical_row_representations: {
      pairs: representations.slice(0, 24).map(([representation_evidence_id, canonical_evidence_id]) => ({ representation_evidence_id, canonical_evidence_id })),
      total: representations.length, complete: representations.length <= 24,
      instruction: "这些是程序按同一来源坐标和单元格几何核验的同一物理表行表示，原始ID和原文保留；不是两个业务要求。库存盘点使用同一来源身份，适用性及字段/条件仍由模型判断。不同位置的同文不会据此合并。",
    } } : {}),
    catalog: renderReferenceCatalog(resolvedCatalog.entries).slice(catalogCursor,catalogCursor+24).map((row,index)=>({...row,title:String(row.title).slice(0,200),bytes:entryBytes(resolvedCatalog.entries[catalogCursor+index]!)})),
    next_catalog_cursor: catalogCursor+24<resolvedCatalog.entries.length ? catalogCursor+24 : null,
    pagination_instruction: "目录每页最多 24 个条目，原文每页最多 24 行、32KB 文本。继续某条目时使用 entry_ids:[id]、row_cursor:next_row_cursor、row_offset:next_row_offset。分块行必须读完所有片段才算完整；打开条目不代表已提取全部要求。",
    ...(opened.length > 0 ? { entries: opened, row_format: "[row_index, text]" } : {}),
    ...(resolved.length > 0 ? {
      resolved_rows: resolved,
      citation_scope: "full_row",
      instruction: "resolved_rows 只返回已完整读取并核验的行及其整行 span；此前已读行可用 resolve_rows 重新取得句柄。整行 span 不能代替独立的名称、单位、数值或方法片段。"
        + (phase === "target" ? "需要精确片段时，复制该行 quote_locator.fixed_arguments，由你补入逐字连续 quote 调用 locate_evidence_span；重复文字可用 prefix/suffix 消歧。此入口允许定位已读隔离行，不要求先用 open_evidence 重读，不重新登记引用，也不自动判断单元格业务角色。未完整读取的行仍不可定位。" : "本回条不替模型选择业务字段或判断适用性。"),
    } : {}),
    ...(deferred.length > 0
      ? {
          deferred_entry_ids: deferred.slice(0, 24),
          deferred_reason: openedRows >= 24 ? "per_call_row_limit_24" : `per_call_source_byte_limit_${MAX_OPENED_BYTES_PER_CALL}`,
        }
      : {}),
    disposition: { used: disposition.used.length, ignored: disposition.ignored.length, pending: pending.length },
    disposition_scope: "cumulative_read_history_not_current_delivery",
    delivery: {
      requested_entry_ids: [...explicitlyRequestedEntryIds],
      returned_entry_ids: opened.map(entry => entry.entry_id), returned_rows: openedRows, returned_utf8_bytes: openedBytes,
      pending_count: deliveryPending.size, pending: [...deliveryPending.values()].slice(0, 24),
      complete: deliveryPending.size === 0,
    },
    disposition_instruction: "used 只表示条目已选择或开始读取；条目全部证据行（含分页行的全部片段）完整读完后才不再 pending。ignored 表示已给理由跳过；skip 可将部分读取的 used 条目转为 ignored，显式把同一 entry_id 放回 entry_ids 会撤销 ignored，并可沿此前回条游标继续已保留的读取进度。同一次调用同时 skip 和 entry_ids 同一条目时，以 entry_ids 重新打开为准。",
    ...(pending.length > 0
      ? {
          pending_entry_ids: pending.slice(0, 24),
          required_action: "read_every_entry_to_completion_or_skip_with_reason",
        }
      : {}),
    ...(deliveryWork ? {
      required_action: "complete_requested_reference_delivery",
      current_work: deliveryWork,
      next_tool: deliveryWork.diagnostic_read.tool,
      next_tool_arguments: deliveryWork.diagnostic_read.arguments,
    } : {}),
  };
}

/** Production reference entry: bounded catalog reads require no separate analysis session. */
export async function readAnalyzedReferenceCatalog(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  request: ReferenceCatalogRequest = {},
  phase: ReferenceAnalysisPhase = "target",
  ask?: CatalogRuleAsk,
  signal?: AbortSignal,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return readReferenceCatalog(workspace, manifest, targetKey, request, phase, ask, signal);
}

/**
 * 提交闸门的判据：每条目录条目都必须有交代——完整读完全部证据行，或者明说不要并给理由。
 * 这和 evidence_dispositions 是同一条规矩：漏（没看见）和挑（看见了并明说不要）
 * 的区别就在于有没有留下交代。used 只表示已选择或开始读取；分页或分块未读完时
 * 仍然 pending，不能独自放行。
 */
export async function referenceCatalogPending(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  targetKey: string,
  occurrence: ReferenceOccurrence,
  phase: ReferenceAnalysisPhase = "target",
  ask?: CatalogRuleAsk | undefined,
): Promise<{ pending: string[]; total: number; rule_source: string }> {
  const { evidence, resolved } = await resolveCatalogForTarget(workspace, manifest, targetKey, occurrence, ask);
  const fingerprint = catalogFingerprint(targetKey, evidence, resolved.entries);
  const disposition = await readCatalogDisposition(workspace, `${phase}:${targetKey}`, fingerprint);
  const recordsById = new Map(evidence.map((record) => [record.evidence_id, record]));
  return {
    pending: disposition
      ? pendingEntryIds(disposition, resolved.entries, recordsById)
      : resolved.entries.map((entry) => entry.entry_id),
    total: resolved.entries.length,
    rule_source: resolved.rule_source,
  };
}

export async function referenceAnalysisIssues(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  phase: ReferenceAnalysisPhase = "target",
): Promise<Array<{ code: string; path: string; message: string; details: Record<string, unknown> }>> {
  const grouped = new Map<string, ReferenceOccurrence[]>();
  for (const occurrence of manifest.reference_occurrences) {
    if (occurrence.status !== "resolved") continue;
    const key = documentReferenceTargetReadIdentity(occurrence).target_key;
    grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
  }
  const issues = [];
  for (const [targetKey, occurrences] of grouped) {
    const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrences[0]!, phase);
    if (policy.analysis_mode !== "isolated") continue;
    const catalog = await referenceCatalogPending(
      workspace, manifest, targetKey, occurrences[0]!, phase,
    );
    if (catalog.pending.length === 0) continue;
    issues.push({
      code: "reference_catalog_entries_undisposed",
      path: `/reference_catalog_dispositions/${phase}:${targetKey}`,
      message: "提交或封存前，隔离引用目标的每个目录条目都必须完整读完全部证据行（含分页行的全部片段），或明确说明理由后跳过。",
      details: {
        target_key: targetKey,
        total_entries: catalog.total,
        pending_count: catalog.pending.length,
        pending_entry_ids: catalog.pending.slice(0, 12),
        rule_source: catalog.rule_source,
        required_action: "read_every_entry_to_completion_or_skip_with_reason",
      },
    });

  }
  return issues;
}

export async function inlineReferenceReadIssues(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  phase: ReferenceAnalysisPhase = "target",
): Promise<Array<{ code: string; path: string; message: string; details: Record<string, unknown> }>> {
  const state = await workspace.readState();
  const grouped = new Map<string, ReferenceOccurrence[]>();
  for (const occurrence of manifest.reference_occurrences) {
    if (occurrence.status !== "resolved") continue;
    const key = documentReferenceTargetReadIdentity(occurrence).target_key;
    grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
  }
  const issues = [];
  for (const [targetKey, occurrences] of grouped) {
    const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrences[0]!, phase);
    if (policy.analysis_mode !== "inline") continue;
    const progress = documentReferenceReadProgress(state, occurrences[0]!, phase)?.progress;
    if (progress?.done === true) continue;
    issues.push({
      code: "inline_reference_read_incomplete",
      path: `/document_reference_reads/${targetKey}`,
      message: "提交前，必须在主模型阶段完整读取内联引用目标的所有页面。",
      details: {
        target_key: targetKey,
        occurrence_ids: occurrences.map((occurrence) => occurrence.occurrence_id),
        candidate_count: policy.evidence_count,
        candidate_fingerprint: documentReferenceTargetReadIdentity(occurrences[0]!).target_fingerprint,
        next_cursor: progress?.next_cursor ?? 0,
        required_action: "call_read_document_reference_evidence_with_target_key_until_done_true",
      },
    });
  }
  return issues;
}

export async function isolatedReferenceTargetForEvidence(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  evidenceId: string,
  phase: ReferenceAnalysisPhase = "target",
): Promise<ReferenceAnalysisPolicy & { target_key: string } | undefined> {
  const requested = manifest.evidence.find((record) => record.evidence_id === evidenceId);
  const source = requested ? await readFile(workspace.sourceMarkdownPath, "utf8") : "";
  const sourceRangesFor = requested
    ? createEvidenceSourceRangeResolver(
        source,
        buildDocumentEvidence(source, manifest.source.file_name),
      )
    : undefined;
  const requestedRanges = requested && sourceRangesFor ? sourceRangesFor(requested) : [];
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  for (const occurrence of manifest.reference_occurrences) {
    if (occurrence.status !== "resolved") continue;
    const overlaps = requestedRanges.length > 0
      && referenceOccurrenceTargetsDocument(occurrence, manifest.source.sha256)
      && occurrence.target_evidence_ids.some((id) => {
        const target = evidenceById.get(id);
        return target && sourceRangesFor
          ? sourceRangesFor(target).some((targetRange) =>
              requestedRanges.some((requestedRange) => sourceRangesOverlap(targetRange, requestedRange))
            )
          : false;
      });
    if (!occurrence.target_evidence_ids.includes(evidenceId) && !overlaps) continue;
    const policy = await assignReferenceAnalysisPolicy(workspace, manifest, occurrence, phase);
    if (policy.analysis_mode !== "isolated") continue;
    return { ...policy, target_key: documentReferenceTargetReadIdentity(occurrence).target_key };
  }
  return undefined;
}
