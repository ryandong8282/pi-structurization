import { discoveryReviewRows, discoveryReviewSummary } from "./discovery-review-progress.js";
import { documentSelectorFingerprint, type DocumentSelectorPlan } from "./document-selector-compiler.js";
import { ExternalSourcePause, type ExternalSourceWorkflow, type ExternalSourceRequest } from "./external-source-workflow.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withBatchWriterLock } from "./batch-writer-lock.js";
import { runDiscoveryWithTransportRetry } from "./discovery-transport.js";

import {
  atomicWriteJson,
  pathExists,
  readJson,
} from "./atomic.js";
import { canonicalize, prettyJson, sha256Bytes, sha256Json, sha256Text } from "./canonical.js";
import { confirmedTargetScope, TargetScopeConflict } from "./confirmed-target-scope.js";
import {
  RESULT_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type AcceptanceResult,
  type EvidenceManifest,
  type MaterializedAcceptanceItem,
  type PersistedSemanticSourcePlan,
  type RevisionState,
  type SemanticSourcePlan,
} from "./contracts.js";
import {
  buildAgentScopedEvidenceManifest,
  DocumentDiscoveryController,
  DocumentDiscoveryWorkspace,
  migrateDocumentTargetPlan,
  targetEvidenceLineSpan,
  type DocumentEvidence,
  type DocumentTarget,
  type DocumentTargetPlan,
  validateDocumentTargetPlan,
} from "./document-discovery.js";
import {
  evaluateDiscoveryLedgerAgreement,
  evaluateTargetLedgerCoverage,
  ledgerRequiredClausePredicate,
  ledgerTargetPrimaryScopes,
  ledgerSectionRangeForLine,
  ledgerSectionsForClauses,
  requiredClauseIdsInSourceRanges,
  ledgerWindowForLine,
  ledgerWithCurrentTableCaptions,
  ledgerWithCurrentClauseBoundaries,
  resolveLedgerWindowForTarget,
  type DocumentLedger,
  type LedgerWindowTargetRef,
  type TargetLedgerCoverage,
} from "./document-ledger.js";
import {
  accountedReferenceOriginEvidenceIds,
  boundFieldClauseIds,
  boundLotScopeClauseIds,
  evidenceLineIndex,
  ledgerClauseIdSet,
  contaminatedItemIds,
  reconcileLedgerCoverage,
  resolveItemClauseId,
  type LedgerReconciliation,
  type LedgerTableReferenceDiagnostic,
} from "./ledger-reconciliation.js";
import {
  runLiveDocumentDiscovery,
  runLiveCoverageReview,
  coverageControllerRebuildRequired,
  runLivePdfLayoutProfile,
  runLivePi,
  isProviderContextTooLargeError,
  type LiveCoverageReviewResult,
} from "./pi-runtime.js";
import type { PiAgentRuntimeModelConfig } from "./presets.js";
import type { PiAgentEffort } from "./presets.js";
import { runOfflineFixture, ToolController } from "./tools.js";
import { validatePlanText, validateSemanticPlanViews } from "./validator.js";
import { RevisionWorkspace } from "./workspace.js";
import { strictJsonParse } from "./strict-json.js";
import { compileTargetSelectors, migrateTargetSelectorPlan, targetSelectorFingerprint } from "./target-selector-compiler.js";
import { semanticItemIdForSelectorKey } from "./semantic-decision-compiler.js";
import {
  compileTargetSelectorsWithContext,
  selectorCompilerAcceptedReviews,
  validatedSelectorCompilerContext,
} from "./selector-compiler-context.js";
import { prefillTargetSelectorsFromLedger } from "./ledger-target-selectors.js";
import { resolveSourceSpan, type SourceSpanRegistry } from "./source-span-registry.js";
import type { PdfLayoutProfile } from "./pdf-layout-profile.js";
import { materialize } from "./materializer.js";
import {
  CoverageReviewController,
  coverageFindingJudgmentIdentity,
  coverageReviewerMissIdentity,
  coverageReviewObligations,
  detectCoverageRepairContractNonConvergence,
  durableCoverageCandidateChangeReceipt,
  migrateCoverageReview,
  repairDurableCoverageCandidateCheckpoint,
  readSealedCoverageReview,
  sealDeterministicCleanCoverageReview,
  validateCoverageReview,
  type CoverageReviewScope,
  type CoverageReviewFinding,
  type CoverageRepairObservation,
  type DomainCoverageReview,
} from "./coverage-review.js";
import {
  deriveCoverageRiskGate,
  type CoverageRiskGateResult,
} from "./coverage-risk-gate.js";
import {
  classifyTargetFailure,
  canRetryTargetFailure,
  canTransitionToFreshSessionRestart,
  initialTargetAttemptCounters,
  isContinuingCoverageRepair,
  isRepairSessionRestartRequired,
  isScopeExtensionRequired,
  recordTransportFailure,
  resetLegacyMisclassifiedTransportCounters,
  targetBlockerFailureClass,
  targetAttemptLimits,
  targetTransportRetryDelayMs,
  type TargetAttemptCounters,
  type TargetFailureClass,
  type TargetAttemptLimits,
  type TransportRetryWindow,
} from "./attempt-budget.js";
import {
  coverageRepairProgressSnapshot,
  recordProgressRound,
  type ProgressWindow,
} from "./progress-snapshot.js";

type BatchTargetStatus = "pending" | "running" | "sealed" | "failed";

export function batchTargetSelected(
  targetId: string,
  targetIds?: readonly string[],
): boolean {
  return !targetIds?.length || targetIds.includes(targetId);
}

export function coverageRepairBudgetStatus(
  state: {
    selector_protocol?: { coverage_repairs: number };
    coverage_recheck?: {
      schema_version: string;
      plan_fingerprint: string;
      source_plan_fingerprint?: string;
    };
  },
  reviewPlanFingerprint: string,
  maxCommittedRepairs: number,
): {
  continuing_transaction: boolean;
  committed_repairs: number;
  available: boolean;
} {
  const committedRepairs = state.selector_protocol?.coverage_repairs ?? 0;
  const continuingTransaction = isContinuingCoverageRepair(state.coverage_recheck, reviewPlanFingerprint);
  return {
    continuing_transaction: continuingTransaction,
    committed_repairs: committedRepairs,
    available: continuingTransaction || committedRepairs < maxCommittedRepairs,
  };
}

/** Continuing a transaction may skip opening a new one; it never bypasses progress or round caps. */
export function coverageRepairShouldHalt(input: {
  continuingTransaction: boolean;
  budgetAvailable: boolean;
  roundsExhausted: boolean;
  progressStop: boolean;
}): { halt: false } | { halt: true; reason: "progress_stalled" | "rounds_exhausted" | "budget_exhausted" } {
  void input.continuingTransaction;
  if (input.progressStop) return { halt: true, reason: "progress_stalled" };
  if (input.roundsExhausted) return { halt: true, reason: "rounds_exhausted" };
  if (!input.budgetAvailable) return { halt: true, reason: "budget_exhausted" };
  return { halt: false };
}

export function coverageRepairObservation(
  plan: SemanticSourcePlan,
  evidence: EvidenceManifest,
  planFingerprint: string,
  review: DomainCoverageReview,
): CoverageRepairObservation {
  const affectedItemIds = new Set(review.findings.flatMap((finding) => finding.affected_item_ids));
  const findingEvidenceIds = new Set(review.findings.map((finding) => finding.evidence_id));
  const items = materialize(plan, evidence, planFingerprint).result.inspection_lots
    .flatMap((lot) => lot.items)
    .filter((item) => affectedItemIds.has(item.item_id)
      || item.evidence_ids.some((evidenceId) => findingEvidenceIds.has(evidenceId))
      || item.reference_evidence_ids.some((evidenceId) => findingEvidenceIds.has(evidenceId))
      || item.sampling.evidence_ids.some((evidenceId) => findingEvidenceIds.has(evidenceId)));
  return {
    plan_fingerprint: planFingerprint,
    structure_fingerprint: coverageRepairStructureFingerprint(items),
    judgment_ids: [...new Set(review.findings.map((finding) =>
      finding.judgment_id || coverageFindingJudgmentIdentity(finding, plan)
    ))].sort(),
    unresolved_judgment_ids: [...new Set(review.findings
      .filter((finding) => finding.finding_origin === "unresolved_prior")
      .map((finding) => finding.judgment_id || coverageFindingJudgmentIdentity(finding, plan)))].sort(),
    finding_ids: review.findings.map((finding) => finding.finding_id).sort(),
  };
}

export function recordCoverageReviewerMisses(
  previousCounts: Readonly<Record<string, number>> | undefined,
  findings: readonly CoverageReviewFinding[],
): {
  counts: Record<string, number>;
  current_miss_identities: string[];
  repeated_miss_identities: string[];
  max_count: number;
} {
  const counts = { ...(previousCounts ?? {}) };
  const currentMissIdentities = [...new Set(findings
    .filter((finding) => finding.finding_origin === "reviewer_missed_preexisting")
    .map(coverageReviewerMissIdentity))].sort();
  for (const identity of currentMissIdentities) counts[identity] = (counts[identity] ?? 0) + 1;
  return {
    counts,
    current_miss_identities: currentMissIdentities,
    repeated_miss_identities: currentMissIdentities.filter((identity) => counts[identity]! >= 2),
    max_count: Math.max(0, ...Object.values(counts)),
  };
}

/**
 * Detect real repair progress, not only leaf/branch counts. Stable generated
 * item IDs are excluded so key churn alone cannot evade non-convergence, while
 * exact field text, sampling scripts/components, reference routes and table
 * semantics all remain observable.
 */
export function coverageRepairStructureFingerprint(
  items: readonly MaterializedAcceptanceItem[],
): string {
  const projections = items.map((item) => {
    const {
      item_id: _itemId,
      reference_origin_item_id: _referenceOriginItemId,
      ...semanticProjection
    } = item;
    return semanticProjection;
  }).sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
  return sha256Json(projections);
}

export async function targetDurableCheckpoint(workspace: RevisionWorkspace): Promise<string> {
  const state = await workspace.readState();
  const digest = async (path: string): Promise<string> =>
    await pathExists(path) ? sha256Bytes(await readFile(path)) : "missing";
  const [selectorSha256, registrySha256] = await Promise.all([
    digest(workspace.workingSelectorPath),
    digest(workspace.sourceSpanRegistryPath),
  ]);
  const coveragePlanFingerprint = state.last_valid_fingerprint
    || state.coverage_recheck?.plan_fingerprint
    || "";
  const coverageDirectory = /^[a-f0-9]{64}$/.test(coveragePlanFingerprint)
    ? join(workspace.coverageReviewDirectory, coveragePlanFingerprint)
    : "";
  const coverageWorkingSha256 = coverageDirectory
    ? await digest(join(coverageDirectory, "working.coverage-review.json"))
    : "missing";
  const coverageState = coverageDirectory && await pathExists(join(coverageDirectory, "state.json"))
    ? await readJson<{
        opened_evidence_ids?: string[];
        last_valid_review_fingerprint?: string;
      }>(join(coverageDirectory, "state.json"))
    : undefined;
  return sha256Json({
    revision: state.revision,
    history_sequence: state.next_history_sequence,
    selector_stage: state.selector_stage ?? "",
    selector_batch_requires_stage: state.selector_batch_requires_stage ?? false,
    opened_evidence_ids: [...(state.opened_evidence_ids ?? [])].sort(),
    opened_evidence_window_keys: [...(state.opened_evidence_window_keys ?? [])].sort(),
    opened_global_resource_ids: [...(state.opened_global_resource_ids ?? [])].sort(),
    selector_sha256: selectorSha256,
    registry_sha256: registrySha256,
    coverage_plan_fingerprint: coveragePlanFingerprint,
    coverage_working_sha256: coverageWorkingSha256,
    coverage_opened_evidence_ids: [...(coverageState?.opened_evidence_ids ?? [])].sort(),
    coverage_last_valid_fingerprint: coverageState?.last_valid_review_fingerprint ?? "",
  });
}

interface BatchTarget {
  target_id: string;
  group_id?: string;
  group_name?: string;
  group_reason?: string;
  name?: string;
  description?: string;
  evidence_atom_ids?: string[];
  evidence_fragments?: DocumentTarget["evidence_fragments"];
  materialization?: DocumentTarget["materialization"];
  work_scope?: DocumentTarget["work_scope"];
  reason?: string;
  heading?: string;
  start_line?: number;
  end_exclusive_line?: number;
  /** 底账节窗口 ID；覆盖闸门只认这个，不拿整章行号瞎猜。 */
  ledger_window_id?: string;
  table_count: number;
  row_count: number;
  status: BatchTargetStatus;
  attempts: number;
  revision: number;
  workdir: string;
  model: string;
  error: string;
  last_blocker_code?: string;
  last_failure_class?: TargetFailureClass | undefined;
  attempt_counters?: TargetAttemptCounters;
  attempt_limits?: TargetAttemptLimits;
  transport_retry_window?: TransportRetryWindow;
  scope_extension_refresh_attempts?: number;
  scope_extension_atom_ids?: string[];
  coverage_repair_observations?: CoverageRepairObservation[];
  coverage_reviewer_miss_count?: number;
  coverage_reviewer_miss_counts?: Record<string, number>;
  coverage_controller_recovery?: CoverageControllerRecoveryState;
  progress_window?: ProgressWindow;
  coverage_control?: CoverageControllerPendingControl;
}

export interface FullBatchState {
  schema_version: "gb50202-full-batch/v1" | "acceptance-full-batch/v2" | "acceptance-full-batch/v3";
  job_id: string;
  source: {
    markdown_file: string;
    markdown_sha256: string;
    pdf_file?: string;
    pdf_sha256?: string;
  };
  mode: "live-pi" | "offline-scripted";
  status: "running" | "passed" | "failed" | "waiting_for_source";
  waiting_for_source?: ExternalSourceRequest;
  discovery?: {
    schema_version: "document-domain-discovery/v1";
    status: "sealed";
    no_target_reason?: string;
    workdir: string;
    model: string;
    target_count: number;
    manifest_sha256: string;
    plan_sha256?: string;
  };
  inventory_revision?: number;
  previous_inventory_archive?: string;
  /**
   * 全书条文对账没过：底账里带检查数量的条文没有被结果全覆盖，或结果引用了底账没有的条文。
   * 每个 target 自己封存成功不代表全书零遗漏——这是最后一道确定性闸门。
   */
  ledger_gap?: BatchLedgerGap;
  targets: BatchTarget[];
}

export interface BatchLedgerGap {
  missing_clause_ids: string[];
  extra_clause_ids: string[];
  unresolved_table_refs?: string[];
  table_reference_diagnostics?: LedgerTableReferenceDiagnostic[];
  unlabeled_item_count: number;
  required_clause_count: number;
  covered_required_clause_count: number;
  /** 缺口条文所属的抽取窗口 → 拥有它的 target，供靶向重跑用。 */
  owners: Array<{
    target_id: string;
    target_name: string;
    ledger_window_id: string;
    missing_clause_ids: string[];
  }>;
  /** 底账里有缺口条文、但没有任何 target 认领的窗口。 */
  unowned_clause_ids: string[];
}

export interface FullBatchOptions {
  artifactRoot: string;
  jobId: string;
  markdownPath: string;
  pdfPath?: string;
  pdfLayoutCacheRoot?: string;
  pdfLayoutEffort?: PiAgentEffort;
  concurrency: number;
  maxAttempts: number;
  transportRetries?: number;
  candidateValidationAttempts?: number;
  coverageRepairAttempts?: number;
  /** Resume only these existing target IDs; every other persisted target is left untouched. */
  targetIds?: string[];
  /** Start these selected targets from freshly generated discovery evidence in a new revision. */
  freshTargetIds?: string[];
  /** Explicit resume of a fingerprint-checked, unvalidated modeling-budget checkpoint. Never automatic rollover. */
  resumeModelingPhaseBudget?: boolean;
  live: boolean;
  discoveryPlanPath?: string;
  signal?: AbortSignal;
  onStateChange?: (state: FullBatchState) => void | Promise<void>;
  modelConfig?: PiAgentRuntimeModelConfig;
  externalSourceWorkflow?: ExternalSourceWorkflow;
  revisionFeedback?: string;
}

export async function retryBackoff(error: string, signal?: AbortSignal, delayMs?: number): Promise<void> {
  const milliseconds = delayMs ?? (/\b429\b|rate[_ ]limit|用量上限|速率限制/i.test(error)
    ? 20_000
    : 5_000);
  signal?.throwIfAborted();
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectDelay(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%", "_");
}

/**
 * target 的物理范围与转指后的 ledger 窗口是两回事。
 * 纯转指目标（如 5.10.1 → 4.10）保留自己的 5.10 范围；4.10 只作为
 * ledger_window_id 供覆盖闸门和后续 reference tool-call 使用。
 */
export function targetOwnLineScope(
  ledger: DocumentLedger | undefined,
  lineSpan: { start_line: number; end_exclusive_line: number },
  resolvedWindow: { start_line: number; end_exclusive_line: number } | undefined,
): { start_line: number; end_exclusive_line: number } {
  const anchorInsideResolvedWindow = Boolean(
    resolvedWindow
    && lineSpan.start_line >= resolvedWindow.start_line
    && lineSpan.start_line < resolvedWindow.end_exclusive_line
  );
  if (resolvedWindow && anchorInsideResolvedWindow) {
    return {
      start_line: resolvedWindow.start_line,
      end_exclusive_line: resolvedWindow.end_exclusive_line,
    };
  }
  return (ledger ? ledgerSectionRangeForLine(ledger, lineSpan.start_line) : undefined) ?? lineSpan;
}

export function targetUsesDelegatedLedgerWindow(
  target: { start_line?: number; end_exclusive_line?: number },
  window: { start_line: number; end_exclusive_line: number },
): boolean {
  if (target.start_line === undefined || target.end_exclusive_line === undefined) return false;
  return target.end_exclusive_line <= window.start_line || target.start_line >= window.end_exclusive_line;
}

/** 主证据裁到目标自己的行范围：原子按 6000 字符切、跨章跨附录，不能当主证据边界。 */
/**
 * 主证据范围。有底账时收到「目标自己举证的那几条条文」，否则退回目标的行范围。
 *
 * 退回的那条路是原来唯一的路，而目标行范围就是它所在那块 6000 字原子的行范围——
 * 平铺章里同章的几个检验批会拿到一模一样的窗口，各自的主证据里装着别人的条文，
 * 覆盖复核挨个判 foreign clause，三方互相指责谁也过不去（GB/T 50312 第 8 章实测）。
 * 详见 ledgerClauseScopeForTarget 的注释。
 */
export function targetOwnScopeForTarget(
  target: LedgerWindowTargetRef & { work_scope?: DocumentTarget["work_scope"] },
  ledger?: DocumentLedger,
  atoms: readonly { atom_id: string; start_line: number; end_line: number; text: string }[] = [],
): { start_line: number; end_exclusive_line: number } | undefined {
  if (target.work_scope) return {
    start_line: target.work_scope.start_line, end_exclusive_line: target.work_scope.end_exclusive_line,
  };
  const fragments = target.materialization?.lot_basis_fragments?.length
    ? target.materialization.lot_basis_fragments : target.evidence_fragments ?? [];
  if (fragments.length && atoms.length) {
    // The lot's own source basis locates the task. Broad transport fragments and
    // references to earlier chapters must not move its home to another section.
    const anchor = targetEvidenceLineSpan({
      target_id: target.name ?? "target-scope", evidence_fragments: fragments,
    }, { atoms });
    // 旧任务只有证据锚点时，不再让章节推断覆盖它。live 入口会要求发现 Agent 补交明确范围。
    return anchor;
  }
  return target.start_line !== undefined && target.end_exclusive_line !== undefined
    ? { start_line: target.start_line, end_exclusive_line: target.end_exclusive_line }
    : undefined;
}

export function targetPrimaryScope(
  target: BatchTarget | { start_line?: number; end_exclusive_line?: number },
  ledger?: DocumentLedger,
  atoms: readonly { atom_id: string; start_line: number; end_line: number; text: string }[] = [],
  siblings: readonly LedgerWindowTargetRef[] = [],
): { start_line: number; end_exclusive_line: number } | undefined {
  if ("work_scope" in target && target.work_scope) return target.work_scope as DocumentTarget["work_scope"];
  if (ledger && siblings.length) {
    const index = siblings.indexOf(target as LedgerWindowTargetRef);
    const normalized = siblings.map((sibling) => ({
      ...sibling, ...targetOwnScopeForTarget(sibling, ledger, atoms),
    }));
    const scopes = ledgerTargetPrimaryScopes(ledger, normalized, atoms);
    const byClause = index >= 0 ? scopes[index] : undefined;
    if (byClause) return byClause;
  }
  return targetOwnScopeForTarget(target, ledger, atoms);
}

/**
 * 覆盖闸门的节范围：只认底账窗口。
 * 解析不到就退回「仅标题一行」（vacuous，强制复核），绝不用 target 的整章 end_line。
 */
function targetLedgerLineWindow(
  ledger: DocumentLedger,
  target: BatchTarget,
  atoms: Array<{ atom_id: string; start_line: number; end_line: number; text: string }> = [],
): { start_line: number; end_exclusive_line: number; window_id?: string; resolved: boolean } {
  const window = resolveLedgerWindowForTarget(ledger, {
    ...(target.name ? { name: target.name } : {}),
    ...(target.ledger_window_id ? { ledger_window_id: target.ledger_window_id } : {}),
    ...(target.evidence_fragments ? { evidence_fragments: target.evidence_fragments } : {}),
    ...(target.materialization ? { materialization: target.materialization } : {}),
    ...(target.start_line !== undefined ? { start_line: target.start_line } : {}),
    ...(target.end_exclusive_line !== undefined
      ? { end_exclusive_line: target.end_exclusive_line }
      : {}),
  }, atoms);
  if (window) {
    return {
      start_line: window.start_line,
      end_exclusive_line: window.end_exclusive_line,
      window_id: window.window_id,
      resolved: true,
    };
  }
  // 最后再试 heading 行是否碰巧落在某节内（短标题行），仍不要用整章跨度。
  const headingLine = target.start_line ?? 1;
  const byHeading = ledgerWindowForLine(ledger, headingLine);
  if (byHeading) {
    return {
      start_line: byHeading.start_line,
      end_exclusive_line: byHeading.end_exclusive_line,
      window_id: byHeading.window_id,
      resolved: true,
    };
  }
  return {
    start_line: headingLine,
    end_exclusive_line: headingLine + 1,
    resolved: false,
  };
}

async function tryPrefillTargetSelectorsFromLedger(input: {
  workspace: RevisionWorkspace;
  ledgerPath: string;
  markdownPath: string;
  target: BatchTarget;
}): Promise<{ clause_item_count: number; table_item_count: number } | undefined> {
  if (!(await pathExists(input.workspace.workingSelectorPath))) return undefined;
  if (!(await pathExists(input.ledgerPath))) return undefined;
  const current = migrateTargetSelectorPlan(
    strictJsonParse(await readFile(input.workspace.workingSelectorPath, "utf8")),
  );
  if (current.lots.length || current.items.length) return undefined;
  const [ledger, markdown, manifest, registry] = await Promise.all([
    readJson<DocumentLedger>(input.ledgerPath),
    readFile(input.markdownPath, "utf8"),
    input.workspace.readEvidenceManifest(),
    input.workspace.readSourceSpanRegistry(),
  ]);
  const discoveryEvidencePath = join(
    dirname(input.ledgerPath),
    "document-evidence.json",
  );
  const discoveryAtoms = await pathExists(discoveryEvidencePath)
    ? (await readJson<DocumentEvidence>(discoveryEvidencePath)).atoms
    : [];
  const window = targetLedgerLineWindow(ledger, input.target, discoveryAtoms);
  if (!window.resolved) return undefined;
  if (targetUsesDelegatedLedgerWindow(input.target, window)) {
    await input.workspace.appendEvent("ledger_selector_prefill_deferred", {
      reason: "delegated_window_requires_reference_tool",
      ledger_window_id: window.window_id ?? "",
      target_start_line: input.target.start_line,
      target_end_exclusive_line: input.target.end_exclusive_line,
      window_start_line: window.start_line,
      window_end_exclusive_line: window.end_exclusive_line,
    });
    return undefined;
  }
  const prefilled = prefillTargetSelectorsFromLedger({
    ledger,
    markdown,
    manifest,
    registry,
    start_line: window.start_line,
    end_exclusive_line: window.end_exclusive_line,
  });
  if (!prefilled.selectors.items.length) return undefined;
  await input.workspace.writeWorkingSelectors(prettyJson(prefilled.selectors));
  await atomicWriteJson(input.workspace.sourceSpanRegistryPath, prefilled.registry);
  await input.workspace.updateState((state) => {
    state.selector_prefill_fingerprint = targetSelectorFingerprint(prefilled.selectors);
  });
  await input.workspace.appendEvent("ledger_selector_prefill", {
    clause_item_count: prefilled.clause_item_count,
    table_item_count: prefilled.table_item_count,
    item_count: prefilled.selectors.items.length,
    ledger_window_id: window.window_id ?? "",
    start_line: window.start_line,
    end_exclusive_line: window.end_exclusive_line,
  });
  return {
    clause_item_count: prefilled.clause_item_count,
    table_item_count: prefilled.table_item_count,
  };
}

/**
 * 底账预填只保存草稿，必须先交给 target 模型抽取，不能预编译成可复核的候选。
 * 函数名保留供已有调用方使用；底账诊断仍在模型提交后的复核入口执行。
 */
export async function trySealTargetFromLedgerPrefill(input: {
  workspace: RevisionWorkspace;
  controller: ToolController;
  target: BatchTarget;
  ledgerPath: string;
  artifactRoot: string;
  jobId: string;
  ledgerPrefill: { clause_item_count: number; table_item_count: number };
}): Promise<{ sealed: boolean; model: string }> {
  const modelTag =
    `ledger-prefill:clause=${input.ledgerPrefill.clause_item_count},table=${input.ledgerPrefill.table_item_count}`;
  // Precompiled skeletons are not model-completed candidates. Compilation sets
  // last_valid_fingerprint, which makes runLivePi hand off to review before it
  // creates the initial extraction session. Keep prefill strictly draft-only.
  // Do not auto-open evidence either: model reads must earn their own receipts.
  await input.workspace.appendEvent("ledger_prefill_seal_deferred", {
    reason: "initial_target_extraction_required",
    model: modelTag,
    clause_item_count: input.ledgerPrefill.clause_item_count,
    table_item_count: input.ledgerPrefill.table_item_count,
    prefill_is_unvalidated_draft: true,
  });
  return { sealed: false, model: modelTag };
}

/**
 * 闸门必抽集：窗口能定位就按窗口；定位不出来（整节转指）就看项目自报的条文号
 * 落在哪一节，由底账给出那一节应有的全部必抽条文。不认「第 4.2 节」那句中文。
 */
export function targetCoverageSourceClauses(
  items: ReadonlyArray<{
    source_clause: string;
    reference_source_clause?: string;
    reference_from_clause?: string;
  }>,
): string[] {
  return [...new Set(items.flatMap((item) => [
    item.source_clause,
    item.reference_source_clause ?? "",
    item.reference_from_clause ?? "",
  ]).filter(Boolean))];
}

export function targetLedgerCoverageWithFallback(input: {
  ledger: DocumentLedger;
  window: { start_line: number; end_exclusive_line: number };
  source_clauses: string[];
  /** 节推断只认 target 自己负责的条文；引用来的条文说明「从别处接收」，不代表归属那一节。 */
  inference_source_clauses?: string[];
  not_item_clause_ids?: string[];
  evidence?: Array<{ evidence_id: string; text: string }>;
  primary_source_ranges?: EvidenceManifest["scope"]["primary_source_ranges"];
}): { coverage: TargetLedgerCoverage; inferred_section_keys: string[] } {
  const confirmedRanges = input.primary_source_ranges?.filter(range => range.end_exclusive_line > range.start_line) ?? [];
  const base = evaluateTargetLedgerCoverage({
    ledger: input.ledger,
    start_line: input.window.start_line,
    end_exclusive_line: input.window.end_exclusive_line,
    source_clauses: input.source_clauses,
    not_item_clause_ids: input.not_item_clause_ids ?? [],
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(confirmedRanges.length ? { required_clause_ids: requiredClauseIdsInSourceRanges(input.ledger, confirmedRanges) } : {}),
  });
  if (!base.vacuous || confirmedRanges.length) return { coverage: base, inferred_section_keys: [] };
  const inferred = ledgerSectionsForClauses(
    input.ledger,
    input.inference_source_clauses ?? input.source_clauses,
  );
  if (!inferred.required_clause_ids.length) return { coverage: base, inferred_section_keys: [] };
  return {
    coverage: evaluateTargetLedgerCoverage({
      ledger: input.ledger,
      start_line: input.window.start_line,
      end_exclusive_line: input.window.end_exclusive_line,
      source_clauses: input.source_clauses,
      not_item_clause_ids: input.not_item_clause_ids ?? [],
      required_clause_ids: inferred.required_clause_ids,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    }),
    inferred_section_keys: inferred.section_keys,
  };
}

type BatchArtifactOptions = Pick<FullBatchOptions, "artifactRoot" | "jobId">;

function batchDirectory(options: BatchArtifactOptions): string {
  return join(options.artifactRoot, "jobs", encodedSegment(options.jobId));
}

function batchStatePath(options: BatchArtifactOptions): string {
  return join(batchDirectory(options), "batch.json");
}

async function openBatchTargetWorkspace(options: BatchArtifactOptions, target: BatchTarget): Promise<RevisionWorkspace> {
  const control = target.coverage_control;
  if (control?.kind === "coverage_controller_rebuild") {
    if (
      control.job_id !== options.jobId
      || control.target_id !== target.target_id
      || !Number.isInteger(control.revision)
      || control.revision < 1
    ) {
      throw new Error("coverage_controller_resume_identity_mismatch: persisted job, target, or revision is invalid");
    }
    const workspace = await RevisionWorkspace.openRevision(
      options.artifactRoot,
      options.jobId,
      target.target_id,
      control.revision,
    );
    if (resolve(workspace.root) !== resolve(control.workdir)) {
      throw new Error("coverage_controller_resume_identity_mismatch: persisted workspace does not match the exact revision");
    }
    return workspace;
  }
  // A later abandoned draft must not silently replace the batch's sealed result.
  if (target.status === "sealed" && target.revision > 0) {
    const workspace = await RevisionWorkspace.openRevision(options.artifactRoot, options.jobId, target.target_id, target.revision);
    if ((await workspace.readState()).status !== "sealed" || !(await pathExists(workspace.manifestPath))) {
      throw new Error(`batch_sealed_revision_missing: ${target.target_id} revision=${target.revision} 缺少封存工件；请核对封存回执，不能以最新 working 草稿代替。`);
    }
    return workspace;
  }
  return RevisionWorkspace.openLatest(options.artifactRoot, options.jobId, target.target_id);
}

function targetDefinition(target: BatchTarget | DocumentTarget): Record<string, unknown> {
  return {
    target_id: target.target_id,
    group_id: target.group_id,
    group_name: target.group_name,
    group_reason: target.group_reason,
    name: target.name,
    description: target.description,
    work_scope: target.work_scope,
    evidence_atom_ids: target.evidence_atom_ids,
    evidence_fragments: target.evidence_fragments,
    materialization: target.materialization,
    reason: target.reason,
  };
}

function inventorySha256(targets: Array<BatchTarget | DocumentTarget>): string {
  return sha256Json(
    targets
      .map(targetDefinition)
      .sort((left, right) => String(left.target_id).localeCompare(String(right.target_id))),
  );
}

async function archiveSupersededInventory(
  options: FullBatchOptions,
  previous: FullBatchState,
  nextTargets: DocumentTarget[],
): Promise<string> {
  const previousDefinitions = new Map(
    previous.targets.map((target) => [target.target_id, targetDefinition(target)]),
  );
  const nextDefinitions = new Map(
    nextTargets.map((target) => [target.target_id, targetDefinition(target)]),
  );
  const archive = join(
    batchDirectory(options),
    "batch-history",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
  );
  await mkdir(archive, { recursive: true });
  for (const name of ["batch.json", "result.json", "receipt.json"] as const) {
    const source = join(batchDirectory(options), name);
    if (await pathExists(source)) await rename(source, join(archive, name));
  }
  const targetsDirectory = join(batchDirectory(options), "targets");
  if (await pathExists(targetsDirectory)) {
    await rename(targetsDirectory, join(archive, "targets"));
  }
  await atomicWriteJson(join(archive, "inventory-transition.json"), {
    schema_version: "acceptance-batch-inventory-transition/v1",
    previous_inventory_revision: previous.inventory_revision ?? 1,
    next_inventory_revision: (previous.inventory_revision ?? 1) + 1,
    previous_plan_sha256: inventorySha256(previous.targets),
    next_plan_sha256: inventorySha256(nextTargets),
    retired_target_ids: previous.targets
      .filter((target) => !nextDefinitions.has(target.target_id))
      .map((target) => target.target_id),
    superseded_target_ids: previous.targets
      .filter((target) => {
        const next = nextDefinitions.get(target.target_id);
        return next !== undefined && canonicalize(targetDefinition(target)) !== canonicalize(next);
      })
      .map((target) => target.target_id),
    added_target_ids: nextTargets
      .filter((target) => !previousDefinitions.has(target.target_id))
      .map((target) => target.target_id),
    unchanged_target_ids: previous.targets
      .filter((target) => {
        const next = nextDefinitions.get(target.target_id);
        return next !== undefined && canonicalize(targetDefinition(target)) === canonicalize(next);
      })
      .map((target) => target.target_id),
  });
  return archive;
}

async function sourceIdentity(options: FullBatchOptions): Promise<FullBatchState["source"]> {
  const markdown = await readFile(options.markdownPath);
  const pdf = options.pdfPath ? await readFile(options.pdfPath) : undefined;
  return {
    markdown_file: basename(options.markdownPath),
    markdown_sha256: sha256Bytes(markdown),
    ...(pdf && options.pdfPath
      ? {
          pdf_file: basename(options.pdfPath),
          pdf_sha256: sha256Bytes(pdf),
        }
      : {}),
  };
}

/** Current accepted-record availability is a prerequisite, never semantic approval. */
async function reviewerReadPrerequisites(workspace: DocumentDiscoveryWorkspace) {
  const state = await workspace.readState();
  if (state.status !== "candidate" || state.reviewer_runtime.kind !== "pi-sdk") return undefined;
  const [selectors, evidence] = await Promise.all([
    readJson<DocumentSelectorPlan>(workspace.workingSelectorPath), workspace.readEvidence(),
  ]);
  const opened = new Set(state.reviewer_opened_atom_ids ?? []);
  const unreadAtoms = evidence.atoms.filter(atom => !opened.has(atom.atom_id));
  const records = (collection: "targets" | "contexts") => {
    const unread = selectors[collection].filter(row => state.reviewer_selector_read_receipts?.[collection]?.[row.key]
      !== sha256Json({ evidenceFingerprint: evidence.evidence_fingerprint, collection, row })).map(row => row.key);
    return { total: selectors[collection].length, read: selectors[collection].length - unread.length,
      unread: unread.length, unread_keys: unread.slice(0, 10), more_unread_keys: Math.max(0, unread.length - 10) };
  };
  const targets = records("targets"), contexts = records("contexts");
  const reviewRows = discoveryReviewRows(selectors, evidence.evidence_fingerprint, state.reviewer_semantic_review_receipts);
  const reviewPending = reviewRows.filter(row => row.status !== "confirmed");
  const semanticReview = { ...discoveryReviewSummary(reviewRows), unfinished: reviewPending.length,
    unfinished_records: reviewPending.slice(0, 10).map(({ collection, key, status }) => ({ collection, key, status })),
    more_unfinished_records: Math.max(0, reviewPending.length - 10) };
  const collection = targets.unread ? "targets" : "contexts";
  const next = unreadAtoms.length
    ? { next_tool: "list_document_atoms", next_tool_arguments: { cursor: evidence.atoms.indexOf(unreadAtoms[0]!), limit: 1 } }
    : targets.unread || contexts.unread
      ? { next_tool: "read_document_selectors", next_tool_arguments: { collection,
          key: (collection === "targets" ? targets : contexts).unread_keys[0]!, view: "full", limit: 1 } }
      : reviewPending.length
        ? { next_tool: "read_discovery_review_progress", next_tool_arguments: { cursor: 0, limit: 20 } }
        : { next_tool: "compile_document_selectors", next_tool_arguments: {} };
  return { selector_fingerprint: documentSelectorFingerprint(selectors), semantic_approval: false,
    sources: { total: evidence.atoms.length, read: evidence.atoms.length - unreadAtoms.length, unread: unreadAtoms.length,
      unread_atom_ids: unreadAtoms.slice(0, 10).map(atom => atom.atom_id), more_unread_atoms: Math.max(0, unreadAtoms.length - 10) },
    records: { targets, contexts }, semantic_review: semanticReview, reviewer_validation_attempts: state.reviewer_validation_attempts ?? 0,
    writable_paths: [], ...next };
}

/** New valid reads advance availability; repeated, stale and runtime-only reads do not. */
export async function discoveryReviewProgressKey(workspace: DocumentDiscoveryWorkspace): Promise<string> {
  const [selectors, issues, reads] = await Promise.all([
    readFile(workspace.workingSelectorPath).catch(() => Buffer.alloc(0)),
    readFile(workspace.lastCompileIssuesPath).catch(() => Buffer.alloc(0)), reviewerReadPrerequisites(workspace),
  ]);
  return [sha256Bytes(selectors), sha256Bytes(issues), sha256Json({ sources: reads?.sources ?? null, records: reads?.records ?? null, semantic_review: reads?.semantic_review ?? null })].join(":");
}

/**
 * Compiles a deterministic remaining-work summary from the workspace's
 * current read prerequisites and last-compile-issues record. Harness facts only:
 * it never adds semantic judgments about the document under review.
 */
export async function compileIssuesWorklist(workspace: DocumentDiscoveryWorkspace): Promise<string> {
  const record = await readJson<{
    ok?: boolean;
    issues?: Array<{ code: string; path: string; message: string; details?: Record<string, unknown> }>;
  }>(workspace.lastCompileIssuesPath).catch(() => null);
  const reads = await reviewerReadPrerequisites(workspace);
  const lines: string[] = reads ? [
    "当前独立复核读取前提与明确判断检查点（只读事实，读取不等于语义批准）：", JSON.stringify(reads),
    "未读原子先按 next_tool 的精确 cursor 取得当前句柄，再 open_document_atom 阅读；未读记录按 key 或 view=full 分页读取。完整记录改过后须重新核对。有效读取凭据已齐的记录无需只为补读凭据重读。用 read_discovery_review_progress 从 cursor=0 继续未确认记录，独立核对原文后用 record_discovery_review 保存有依据的明确判断；正确记录无需人为改写。保存或修订后重新读 pending 目录，已改记录和上游 context 变化须重核。",
    "selector_fingerprint 是当前已接受草稿身份，不能当作封存指纹。完成所有原文和记录的独立语义核验、修复真实问题后，再做最终 compile_document_selectors，并仅用该次成功返回的 fingerprint 调用 seal_discovery_plan。不得按读取计数批准，不得编辑 state、读取凭据、原文或编译产物。",
  ] : [];
  if (!record || record.ok || !record.issues?.length) return lines.join("\n");
  const counts = new Map<string, number>();
  for (const issue of record.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  for (const [code, count] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
    lines.push(`- ${code} ×${count}`);
  }
  const unclassified = record.issues.filter((issue) => issue.code === "selector_discovery_window_unclassified");
  if (unclassified.length) {
    const progress = (unclassified[0]!.details as {
      window_classification_progress?: { classified_windows?: number; total_windows?: number };
    } | undefined)?.window_classification_progress;
    if (progress) lines.push(`  窗口归类进度：${progress.classified_windows ?? "?"}/${progress.total_windows ?? "?"}（每处理一批窗口该数字应上升）`);
    for (const issue of unclassified.slice(0, 8)) {
      const window = (issue.details as {
        window?: { window_id?: string; start_line?: number; end_exclusive_line?: number; number?: string; title?: string };
      })?.window;
      if (!window) continue;
      const atoms = ((issue.details as { covering_atoms?: Array<{ atom_id: string }> }).covering_atoms ?? [])
        .map((atom) => atom.atom_id).join(",");
      const label = `${window.number ? `${window.number} ` : ""}${(window.title ?? "").slice(0, 30)}`.trim();
      lines.push(`  · ${window.window_id} [${window.start_line},${window.end_exclusive_line})${label ? ` ${label}` : ""}${atoms ? ` atoms:${atoms}` : ""}`);
    }
    if (unclassified.length > 8) lines.push(`  · ……其余 ${unclassified.length - 8} 个窗口在 compile_document_selectors 返回中都有同样的 covering_atoms`);
  }
  return lines.join("\n");
}

export async function runFullDocumentDiscovery(options: FullBatchOptions): Promise<{
  workspace: DocumentDiscoveryWorkspace;
  evidence: DocumentEvidence;
  plan: DocumentTargetPlan;
  model: string;
}> {
  options.signal?.throwIfAborted();
  if (options.live && options.discoveryPlanPath) {
    throw new Error("Live full-document discovery cannot receive a supplied plan or answer artifact");
  }
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(
    options.artifactRoot,
    options.jobId,
    options.markdownPath,
  );
  // The discovery snapshot owns the layout used to prepare its targets. A
  // continuation must not relearn that upstream input underneath sealed work.
  if (options.live && options.pdfPath && (await workspace.readState()).status !== "sealed") {
    try {
      await runLivePdfLayoutProfile(
        workspace,
        options.pdfPath,
        options.signal,
        options.modelConfig,
        { cacheRoot: options.pdfLayoutCacheRoot ?? join(options.artifactRoot, "cache", "pdf-layout"), ...(options.pdfLayoutEffort ? { effort: options.pdfLayoutEffort } : {}) },
      );
    } catch (error) {
      await workspace.appendEvent("pdf_layout_profile_unavailable", {
        error: error instanceof Error ? error.message : String(error),
        fallback: "existing_markdown_evidence_rules",
      });
    }
  }
  const candidateController = await DocumentDiscoveryController.create(workspace, "candidate");
  let state = await workspace.readState();
  let model = state.agent_runtime.kind === "pi-sdk" ? "persisted-pi-session" : "offline-scripted";
  if (options.live && state.status === "sealed") {
    const saved = await readJson<DocumentTargetPlan>(workspace.sealedPlanPath);
    const conflicts: Record<string, unknown>[] = [];
    for (const target of saved.targets) {
      try { confirmedTargetScope(target, candidateController.evidence); }
      catch (error) {
        if (!(error instanceof TargetScopeConflict)) throw error;
        conflicts.push(error.details);
      }
    }
    if (conflicts.length) {
      await atomicWriteJson(join(workspace.root, "scope-conflicts.json"), { owner: "document_discovery_agent", conflicts });
      await workspace.reopenForDiscoveryRepair(JSON.stringify({ instruction: "原任务范围需要来源核验；通过 get_document_selector_contract 读取 scope_conflicts 后修订。", conflict_count: conflicts.length }));
      state = await workspace.readState();
    }
  }
  // Ledger windows and heading partitions are navigation proposals, not reviewed
  // scope decisions. Never mark source opened or seal a plan merely because a
  // deterministic plan agrees with the same rules that generated it.
  if (state.status !== "sealed" && options.live) {
    const resumedLegacyCandidate = state.status === "candidate";
    if (resumedLegacyCandidate) {
      await workspace.resumeAuthorDiscovery();
      state = await workspace.readState();
    }
    let attempts = 0;
    let resume = !resumedLegacyCandidate && Boolean(state.agent_runtime.session_file);
    while (state.status !== "sealed" && attempts < options.maxAttempts) {
      attempts += 1;
      let result;
      try {
        result = await runDiscoveryWithTransportRetry(workspace, "candidate", resume,
          nextResume => runLiveDocumentDiscovery(workspace, candidateController, nextResume, options.signal, options.modelConfig), options.signal);
      } catch (error) {
        if (!isProviderContextTooLargeError(error)) throw error;
        resume = false;
        await workspace.appendEvent("discovery_candidate_context_handoff", {
          reason: "provider_context_too_large", fresh_session: true, durable_workfile_preserved: true,
        });
        continue;
      }
      model = result.model;
      resume = true;
      state = await workspace.readState();
      if (state.status === "sealed") break;
      if (result.terminal_failure) throw new Error(`Full-document domain discovery stopped: ${result.error}`);
      if (result.error && attempts < options.maxAttempts) { await retryBackoff(result.error, options.signal); continue; }
      throw new Error(`Full-document domain discovery did not seal: ${result.error ?? "unknown error"}`);
    }
    if (state.status !== "sealed") throw new Error(`Full-document domain discovery exhausted ${options.maxAttempts} attempts without sealing`);
  } else if (state.status !== "sealed") {
    if (!options.discoveryPlanPath) {
      throw new Error("Offline full-demo requires an explicit --discovery-plan; deterministic format discovery is forbidden");
    }
    if (state.status === "working") {
      await workspace.setRuntime({
        kind: "offline-scripted",
        session_id: `offline-discovery-${options.jobId}`,
        session_file: workspace.transcriptPath,
      });
      for (const atom of candidateController.evidence.atoms) {
        await candidateController.dispatch("open_document_atom", { atom_id: atom.atom_id });
      }
      const supplied = await readJson<DocumentTargetPlan>(options.discoveryPlanPath);
      const adapted = {
        ...supplied,
        job_id: options.jobId,
        document_fingerprint: candidateController.evidence.evidence_fingerprint,
      };
      const replaced = await candidateController.dispatch("replace_discovery_plan", {
        content: JSON.stringify(adapted),
      });
      if (!replaced.ok) throw new Error(`Offline discovery plan replacement failed: ${JSON.stringify(replaced)}`);
      const validation = await candidateController.dispatch("validate_discovery_plan", {});
      if (!validation.ok) throw new Error(`Offline discovery plan validation failed: ${JSON.stringify(validation)}`);
      const submitted = await candidateController.dispatch("submit_discovery_candidate", {
        fingerprint: validation.fingerprint,
      });
      if (!submitted.ok) throw new Error(`Offline discovery candidate submission failed: ${JSON.stringify(submitted)}`);
    }
    const reviewController = await DocumentDiscoveryController.create(workspace, "review");
    await workspace.setReviewerRuntime({
      kind: "offline-scripted",
      session_id: `offline-discovery-review-${options.jobId}`,
      session_file: workspace.transcriptPath,
    });
    for (const atom of reviewController.evidence.atoms) {
      await reviewController.dispatch("open_document_atom", { atom_id: atom.atom_id });
    }
    const validation = await reviewController.dispatch("validate_discovery_plan", {});
    if (!validation.ok) throw new Error(`Offline independent discovery review failed: ${JSON.stringify(validation)}`);
    const sealed = await reviewController.dispatch("seal_discovery_plan", {
      fingerprint: validation.fingerprint,
    });
    if (!sealed.ok) throw new Error(`Offline reviewed discovery plan seal failed: ${JSON.stringify(sealed)}`);
  }
  if (!(await pathExists(workspace.manifestPath))) {
    throw new Error("Full-document discovery has no sealed manifest");
  }
  const rawPlan = await readJson<unknown>(workspace.sealedPlanPath);
  const plan = migrateDocumentTargetPlan(rawPlan, candidateController.evidence) as DocumentTargetPlan;
  const sealedValidation = validateDocumentTargetPlan(
    plan,
    candidateController.evidence,
    options.jobId,
    new Set(candidateController.evidence.atoms.map((atom) => atom.atom_id)),
  );
  if (!sealedValidation.ok) {
    throw new Error(`Sealed discovery plan no longer satisfies the current contract: ${JSON.stringify(sealedValidation.issues.slice(0, 20))}`);
  }
  return { workspace, evidence: candidateController.evidence, plan, model };
}

async function initialState(
  options: FullBatchOptions,
  discovery: Awaited<ReturnType<typeof runFullDocumentDiscovery>>,
): Promise<FullBatchState> {
  const ledger = await discovery.workspace.readLedger().catch(() => undefined);
  return {
    schema_version: "acceptance-full-batch/v3",
    job_id: options.jobId,
    source: await sourceIdentity(options),
    mode: options.live ? "live-pi" : "offline-scripted",
    status: "running",
    discovery: {
      schema_version: "document-domain-discovery/v1",
      status: "sealed",
      workdir: discovery.workspace.root,
      model: discovery.model,
      target_count: discovery.plan.targets.length,
      ...(discovery.plan.no_target_reason ? { no_target_reason: discovery.plan.no_target_reason } : {}),
      manifest_sha256: sha256Bytes(await readFile(discovery.workspace.manifestPath)),
      plan_sha256: inventorySha256(discovery.plan.targets),
    },
    inventory_revision: 1,
    targets: discovery.plan.targets.map((target) => {
      const lineSpan = targetEvidenceLineSpan(target, discovery.evidence,
        target.materialization.lot_basis_fragments.length
          ? target.materialization.lot_basis_fragments : target.evidence_fragments);
      const window = ledger
        ? resolveLedgerWindowForTarget(ledger, {
          ...target,
          start_line: lineSpan.start_line,
          end_exclusive_line: lineSpan.end_exclusive_line,
        }, discovery.evidence.atoms)
        : undefined;
      // 解析不到底账窗口时，范围退到「引文所在的那一节」，而不是引文本身那几行。
      // evidence_fragments 是识别阶段用来**证明这个检验批存在**的举证，不是范围声明；
      // 把它当范围会让「只引了一句领起句」的目标只剩三四行可抽
      // （GB/T 50312 实测：45 条候选里 34 条落在所有目标范围之外）。
      // 只在没有窗口时才兜底——健康的书每个目标都有窗口，完全不受影响
      // （GB 50310 实测 25 个目标 0 个走这条路）。
      //
      // 兜底时**不**跟原始引用范围取并集：条款常常引到附录（`衰减应符合本规范附录 C
      // 的规定`），模型举证时就把附录原文一并引了，原始范围于是从第 8 章一直拖到附录 C
      // ——实测 612→1081 共 469 行，一个目标要啃三张附录测试表，工具调用两百多次、
      // 修复循环空转。附录是被引用的资源、不是抽取范围（附录条文本就判为非验收项），
      // 跨节引用走引用解析那条路，不该靠撑大范围来够。
      //
      // 普通目标解析到的窗口包含自身锚点，直接使用完整节范围，避免只剩一句举证。
      // 纯转指目标解析到的却是被引用节（如 5.10.1 → 4.10），它不包含自身锚点；
      // 这时 start/end 必须保留物理节范围，被引用节只写 ledger_window_id，交给
      // reference tool-call 和覆盖闸门处理，不能混进 primary scope。
      const scope = target.work_scope
        ? target.work_scope
        : lineSpan;
      return {
        ...target,
        start_line: scope.start_line,
        end_exclusive_line: scope.end_exclusive_line,
        ...(window ? { ledger_window_id: window.window_id } : {}),
        table_count: 0,
        row_count: 0,
        status: "pending" as const,
        attempts: 0,
        revision: 0,
        workdir: "",
        model: "",
        error: "",
        attempt_counters: initialTargetAttemptCounters(),
        attempt_limits: targetAttemptLimits(options),
      };
    }),
  };
}

async function loadOrCreateState(options: FullBatchOptions): Promise<FullBatchState> {
  const path = batchStatePath(options);
  if (!(await pathExists(path))) {
    const state = await initialState(options, await runFullDocumentDiscovery(options));
    await mkdir(batchDirectory(options), { recursive: true });
    await atomicWriteJson(path, state);
    return state;
  }
  const state = await readJson<FullBatchState>(path);
  if (options.live && state.schema_version === "gb50202-full-batch/v1") {
    throw new Error(
      "Legacy deterministic target inventory cannot resume in the live Pi pipeline; start a fresh job so full-document Agent discovery is the authority",
    );
  }
  const identity = await sourceIdentity(options);
  if (
    state.job_id !== options.jobId
    || canonicalize(state.source) !== canonicalize(identity)
    || state.mode !== (options.live ? "live-pi" : "offline-scripted")
  ) {
    throw new Error("Persisted batch identity does not match the requested source, job, or mode");
  }
  if (
    state.schema_version === "acceptance-full-batch/v2"
    || state.schema_version === "acceptance-full-batch/v3"
  ) {
    const discovery = await runFullDocumentDiscovery(options);
    if (inventorySha256(state.targets) !== inventorySha256(discovery.plan.targets)) {
      if (options.targetIds?.length || options.freshTargetIds?.length) {
        throw new Error(
          "Persisted discovery inventory changed; a partial or fresh-target run cannot archive the existing target set",
        );
      }
      const archive = await archiveSupersededInventory(options, state, discovery.plan.targets);
      const replacement = await initialState(options, discovery);
      replacement.inventory_revision = (state.inventory_revision ?? 1) + 1;
      replacement.previous_inventory_archive = archive;
      await atomicWriteJson(path, replacement);
      return replacement;
    }
    state.schema_version = "acceptance-full-batch/v3";
    state.inventory_revision ??= 1;
    state.discovery = {
      schema_version: "document-domain-discovery/v1",
      status: "sealed",
      workdir: discovery.workspace.root,
      model: discovery.model,
      target_count: discovery.plan.targets.length,
      ...(discovery.plan.no_target_reason ? { no_target_reason: discovery.plan.no_target_reason } : {}),
      manifest_sha256: sha256Bytes(await readFile(discovery.workspace.manifestPath)),
      plan_sha256: inventorySha256(discovery.plan.targets),
    };
  }
  state.status = "running";
  for (const target of state.targets) {
    const explicitlyFresh = options.freshTargetIds?.includes(target.target_id) === true;
    if (explicitlyFresh) {
      delete target.coverage_control;
      delete target.coverage_controller_recovery;
    } else {
      const normalizedCoverageControl = normalizePersistedCoverageControllerControl(options, target);
      if (normalizedCoverageControl) target.coverage_control = normalizedCoverageControl;
      const normalizedRecovery = normalizePersistedCoverageControllerRecovery(options, target);
      if (normalizedRecovery) target.coverage_controller_recovery = normalizedRecovery;
      else delete target.coverage_controller_recovery;
      if (target.coverage_control?.kind === "coverage_controller_rebuild") {
        delete target.coverage_controller_recovery;
      }
    }
    const interrupted = target.status === "running";
    if (interrupted) target.status = "pending";
    target.attempt_counters = {
      ...initialTargetAttemptCounters(),
      ...(target.attempt_counters ?? {}),
    };
    target.attempt_limits = {
      ...targetAttemptLimits(options),
      ...(target.attempt_limits ?? {}),
    };
    target.scope_extension_refresh_attempts ??= 0;
    if (target.coverage_control?.kind === "coverage_controller_rebuild") {
      target.status = "pending";
      target.last_failure_class = undefined;
    } else {
      target.last_failure_class = targetBlockerFailureClass(target.last_blocker_code)
        ?? (target.error ? classifyTargetFailure(target.error) : undefined)
        ?? (interrupted && target.attempt_counters.coverage_repair_attempts > 0
        ? "coverage_repair"
        : interrupted && target.attempt_counters.candidate_validation_attempts > 0
        ? "candidate"
        : interrupted && target.attempt_counters.transport_attempts > 0
        ? "transport"
        : undefined);
    }
    if (target.status === "failed") {
      target.attempt_counters = resetLegacyMisclassifiedTransportCounters(
        target.error,
        target.attempt_counters,
      );
    }
  }
  return state;
}

/** Scope refresh needs new source input, not reordered records or rewritten reference descriptions. */
export function scopeRefreshSourceFingerprint(manifest: EvidenceManifest): string {
  return sha256Json({
    source: manifest.source,
    scope: manifest.scope,
    evidence: [...manifest.evidence].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  });
}

async function scopeBlockerExtensionAtomIds(
  workspace: RevisionWorkspace,
  state: RevisionState,
  document: DocumentEvidence,
): Promise<string[]> {
  if (!(await pathExists(workspace.transcriptPath))) return [];
  const events = (await readFile(workspace.transcriptPath, "utf8")).trim().split(/\r?\n/u)
    .filter(Boolean).map(line => JSON.parse(line));
  const blocker = events.findLast(event => event.event_type === "target_selector_blocker"
    && event.payload?.kind === "scope_extension_required")?.payload;
  if (!Array.isArray(blocker?.evidence_span_ids)) return [];
  const manifest = await workspace.readEvidenceManifest();
  const registry = await workspace.readSourceSpanRegistry();
  const evidenceById = new Map(manifest.evidence.map(record => [record.evidence_id, record]));
  const sources = new Map(manifest.evidence.map(record => [record.evidence_id, {
    source_id: record.evidence_id, text: record.text,
  }]));
  const atomIds = new Set<string>();
  for (const [index, spanId] of blocker.evidence_span_ids.entries()) {
    const issues: Parameters<typeof resolveSourceSpan>[4] = [];
    const span = resolveSourceSpan(registry, spanId, sources, `/evidence_span_ids/${index}`, issues);
    const record = span && evidenceById.get(span.evidence_id);
    // 运行时行切片记录可能没有 atom_id（按 evidence_id 独立命名）；此时按
    // 逐字包含回退匹配 discovery atom——record 是 atom 内的行切片，
    // record.text ⊆ atom.text 且唯一命中才用于范围扩展提名。
    const atom = document.atoms.find(candidate => candidate.atom_id === record?.atom_id
      || candidate.atom_id === record?.evidence_id)
      ?? (record && (() => {
        const containing = document.atoms.filter(candidate =>
          record.text.length >= 8 && candidate.text.includes(record.text));
        return containing.length === 1 ? containing[0] : undefined;
      })());
    if (!span || !state.opened_evidence_ids?.includes(span.evidence_id) || !atom
      || manifest.source.sha256 !== document.source.sha256) {
      throw new Error(`scope_extension_required: blocker evidence cannot extend primary; span_id=${spanId}; `
        + `evidence_id=${span?.evidence_id ?? "unknown"}; opened=${Boolean(span && state.opened_evidence_ids?.includes(span.evidence_id))}; `
        + `source_atom=${atom?.atom_id ?? "missing"}; issues=${JSON.stringify(issues)}. `
        + "Only registered spans from fully opened current-source evidence may extend scope. "
        + "Use open_evidence, locate_evidence_span and report_target_blocker to supply evidence_span_ids; "
        + "do not edit the frozen evidence, read receipts or sealed artifacts.");
    }
    const line = record && /^line:(\d+)(?:\/|$)/u.exec(record.locator);
    const alreadyPrimary = record?.evidence_scope === "primary"
      || (line && manifest.scope?.primary_source_ranges?.some(range =>
        Number(line[1]) >= range.start_line && Number(line[1]) < range.end_exclusive_line)
        && manifest.scope.target_evidence_fragments?.some(fragment => fragment.atom_id === atom.atom_id
          && fragment.text.includes(span.text)))
      || manifest.scope?.target_evidence_fragments?.some(fragment => fragment.atom_id === atom.atom_id
        && fragment.text === atom.text);
    if (!alreadyPrimary) atomIds.add(atom.atom_id);
  }
  return [...atomIds].sort();
}

async function openOrCreateWorkspace(
  options: FullBatchOptions,
  target: BatchTarget,
  documentEvidence?: DocumentEvidence,
  fresh = false,
  ledger?: DocumentLedger,
  siblingTargets: readonly LedgerWindowTargetRef[] = [],
  layoutProfile?: PdfLayoutProfile,
): Promise<{
  workspace: RevisionWorkspace;
  resume: boolean;
  scopeExtensionRefreshed?: boolean;
  scopeExtensionCheckpointRecovered?: boolean;
}> {
  const confirmedScope = documentEvidence && (options.live || target.work_scope?.primary_fragments)
    ? confirmedTargetScope(target as unknown as DocumentTarget, documentEvidence,
        target.start_line !== undefined && target.end_exclusive_line !== undefined
          ? { start_line: target.start_line, end_exclusive_line: target.end_exclusive_line } : undefined)
    : undefined;
  if (fresh) {
    if (!target.evidence_atom_ids?.length || !documentEvidence) {
      throw new Error(
        `Fresh target revision requires sealed discovery evidence for ${target.target_id}`,
      );
    }
    Object.assign(target, targetOwnScopeForTarget(target, ledger, documentEvidence.atoms));
    return {
      workspace: await RevisionWorkspace.createFromEvidence(
        options.artifactRoot,
        options.jobId,
        target.target_id,
        await buildAgentScopedEvidenceManifest(
          options.markdownPath,
          options.jobId,
          target as unknown as DocumentTarget,
          documentEvidence,
          options.pdfPath,
          targetPrimaryScope(target, ledger, documentEvidence.atoms, siblingTargets),
          layoutProfile,
          target.scope_extension_atom_ids,
        ),
      ),
      resume: false,
    };
  }
  if (target.coverage_control?.kind === "coverage_controller_rebuild") {
    return {
      workspace: await openBatchTargetWorkspace(options, target),
      resume: false,
    };
  }
  try {
    // Explicit target continuation selects its latest working draft. Inventory
    // aggregation and unselected sealed targets still use the recorded seal.
    const workspace = options.targetIds?.includes(target.target_id)
      ? await RevisionWorkspace.openLatest(options.artifactRoot, options.jobId, target.target_id)
      : await openBatchTargetWorkspace(options, target);
    const state = await workspace.readState();
    if (state.status === "sealed" && confirmedScope) {
      // A sealed revision is a source-bound snapshot, not an unfinished draft
      // to reconcile with today's layout preparation. Check its immutable input
      // identity first, then run the same current-contract validation as before.
      try {
        const manifest = await workspace.readEvidenceManifest();
        const { evidence_fingerprint, ...payload } = manifest;
        const source = await sourceIdentity(options);
        const checks: Array<[string, unknown, unknown]> = [
          ["evidence_fingerprint", evidence_fingerprint, sha256Json(payload)],
          ["job_id", manifest.job_id, options.jobId],
          ["target_id", manifest.target_id, target.target_id],
          ["markdown_source", manifest.source.sha256, source.markdown_sha256],
          ["pdf_source", manifest.source.pdf_sha256, source.pdf_sha256],
          ["confirmed_scope", manifest.scope?.confirmed_scope_fingerprint, confirmedScope.fingerprint],
          ["scope_extension_atom_ids", manifest.scope?.scope_extension_atom_ids, target.scope_extension_atom_ids?.length
            ? target.scope_extension_atom_ids : undefined],
          ["primary_source_ranges", manifest.scope?.primary_source_ranges,
            target.scope_extension_atom_ids?.length
              ? (await buildAgentScopedEvidenceManifest(options.markdownPath, options.jobId,
                  target as unknown as DocumentTarget, documentEvidence!, options.pdfPath,
                  targetPrimaryScope(target, ledger, documentEvidence!.atoms, siblingTargets), layoutProfile,
                  target.scope_extension_atom_ids)).manifest.scope?.primary_source_ranges
              : confirmedScope.ranges],
          ["frozen_markdown", sha256Bytes(await readFile(workspace.sourceMarkdownPath)), source.markdown_sha256],
        ];
        if (source.pdf_sha256) checks.push(["frozen_pdf", sha256Bytes(await readFile(workspace.sourcePdfPath)), source.pdf_sha256]);
        const mismatches = checks.filter(([, actual, expected]) => canonicalize(actual) !== canonicalize(expected))
          .map(([field, actual, expected]) => ({ field, actual, expected }));
        if (mismatches.length) throw new Error(`source checks: ${JSON.stringify(mismatches)}`);
      } catch (error) {
        // Also fail closed for missing source files, rather than letting the
        // outer ENOENT recovery create a blank replacement revision.
        throw new Error(`sealed_target_source_identity_mismatch: target=${target.target_id} revision=${workspace.revision}; ${error instanceof Error ? error.message : String(error)}; 封存结果仅可用于相同原文及已确认范围。请恢复匹配的原始输入和封存工件；若确需更换原文或范围，请显式新建任务/修订，不能修改 evidence、封存结果或回执绕过检查。`);
      }
      if (await sealedWorkspaceSatisfiesCurrentContract(workspace)) {
        return { workspace, resume: false };
      }
    }
    const recoveringScopeExtension = state.status === "failed" && (
      state.terminal_failure_class === "scope_extension"
      || state.terminal_blocker_code === "scope_extension_required"
      || isScopeExtensionRequired(state.terminal_reason ?? "")
    );
    if (state.status === "working") {
      const approvedSource = await interruptedRematerializationSource(workspace);
      if (approvedSource) {
        return {
          workspace: await finishDeterministicRematerialization(workspace, approvedSource),
          resume: false,
        };
      }
    }
    if (target.evidence_atom_ids && documentEvidence) {
      let prepared: Awaited<ReturnType<typeof buildAgentScopedEvidenceManifest>>;
      let extensionAtomIds = target.scope_extension_atom_ids ?? [];
      try {
        if (recoveringScopeExtension && (target.scope_extension_refresh_attempts ?? 0) < 1) {
          extensionAtomIds = [...new Set([...extensionAtomIds,
            ...await scopeBlockerExtensionAtomIds(workspace, state, documentEvidence)])].sort();
        }
        prepared = await buildAgentScopedEvidenceManifest(
          options.markdownPath,
          options.jobId,
          target as unknown as DocumentTarget,
          documentEvidence,
          options.pdfPath,
          targetPrimaryScope(target, ledger, documentEvidence.atoms, siblingTargets),
          layoutProfile,
          extensionAtomIds,
        );
      } catch (error) {
        if (!recoveringScopeExtension) throw error;
        throw new Error(
          `scope_extension_required: fresh evidence preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (options.freshTargetIds?.includes(target.target_id)) {
        // 显式 fresh 重开：丢弃检查点链，从当前（已修正的）源全新构建。
        // 请求参数一次性消费（JobRunner 启动即清除 meta），不会反复触发。
        return {
          workspace: await RevisionWorkspace.createFromEvidence(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            prepared,
          ),
          resume: false,
        };
      }
      if (recoveringScopeExtension) {
        const extendingScope = canonicalize(extensionAtomIds) !== canonicalize(target.scope_extension_atom_ids ?? []);
        if (extendingScope && scopeRefreshSourceFingerprint(await workspace.readEvidenceManifest())
          === scopeRefreshSourceFingerprint(prepared.manifest)) {
          throw new Error(`scope_extension_required: scope_refresh_no_source_change; revision=${workspace.revision}; `
            + "the nominated opened spans added no new source scope. Continue authoring the current selectors; "
            + "do not edit evidence or sealed artifacts.");
        }
        try {
          const savedSelectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(workspace.workingSelectorPath, "utf8")));
          if (savedSelectors.items.length > 0) {
            // Failed revisions are immutable. Carry only a trusted checkpoint into
            // a writable revision. A source expansion still consumes the one-refresh allowance.
            const recovered = await RevisionWorkspace.reviseFromTerminalFailure(
              options.artifactRoot,
              options.jobId,
              target.target_id,
              { resumeModelingPhaseBudget: options.resumeModelingPhaseBudget ?? true,
                ...(extensionAtomIds.length
                  ? { scopeExtensionManifest: prepared.manifest } : {}),
              },
            );
            await recovered.appendEvent("scope_extension_checkpoint_recovery", {
              target_id: target.target_id,
              source_revision: workspace.revision,
              revision: recovered.revision,
              saved_item_count: savedSelectors.items.length,
              resume_session: false,
            });
            if (extendingScope) target.scope_extension_atom_ids = extensionAtomIds;
            return { workspace: recovered, resume: false, scopeExtensionCheckpointRecovered: true,
              scopeExtensionRefreshed: extendingScope };
          }
        } catch (error) {
          if (!(error instanceof Error)
            || error.message !== "Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor") {
            // Do not let the outer ENOENT handler silently replace saved work.
            throw new Error(`scope_extension_required: checkpoint recovery failed: ${error instanceof Error ? error.message : String(error)}; no blank refresh was attempted. Inspect and restore the original checkpoint artifacts before resuming this target; do not fabricate evidence or edit sealed output.`, { cause: error });
          }
        }
        // Only missing/untrusted checkpoints may fall back to one fresh revision.
        if ((target.scope_extension_refresh_attempts ?? 0) >= 1) {
          throw new Error(
            "scope_extension_required: one fresh evidence revision already completed without resolving the target scope",
          );
        }
        let previousSourceFingerprint: string;
        try {
          previousSourceFingerprint = scopeRefreshSourceFingerprint(await workspace.readEvidenceManifest());
        } catch (error) {
          // The outer ENOENT path creates an initial workspace; it must not
          // turn an unreadable existing scope into a successful blank refresh.
          throw new Error(`scope_extension_required: scope refresh comparison failed at ${workspace.evidenceManifestPath}: ${error instanceof Error ? error.message : String(error)}; no blank refresh was attempted. Restore the original frozen evidence before retrying; do not fabricate sources or edit sealed artifacts.`, { cause: error });
        }
        if (previousSourceFingerprint === scopeRefreshSourceFingerprint(prepared.manifest)) {
          throw new Error(
            `scope_extension_required: scope_refresh_no_source_change; revision=${workspace.revision}; `
            + `source_scope_fingerprint=${previousSourceFingerprint}. Fresh preparation contains the same source, scope and evidence records. `
            + `No blank revision was created; saved selectors remain at ${workspace.workingSelectorPath}. `
            + "Inspect the original scope blocker and obtain an explicitly revised Discovery scope or new source evidence before retrying; "
            + "do not edit evidence or sealed artifacts, and do not discard the saved draft to bypass this guard.",
          );
        }
        try {
          const refreshed = await RevisionWorkspace.createFromEvidence(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            prepared,
          );
          target.scope_extension_atom_ids = extensionAtomIds;
          return {
            workspace: refreshed,
            resume: false,
            scopeExtensionRefreshed: true,
          };
        } catch (error) {
          throw new Error(
            `scope_extension_required: fresh revision creation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const persistedManifest = options.externalSourceWorkflow
        ? await workspace.restoreExternalReferenceProvenance(prepared.manifest, options.externalSourceWorkflow,
            candidate => persistedManifestResumeMismatch(candidate, prepared.manifest, (candidate.scope?.primary_source_ranges ?? []).filter(range => range.end_exclusive_line > range.start_line)) === null)
        : await workspace.readEvidenceManifest();
      const ownPrimaryRanges = (persistedManifest.scope?.primary_source_ranges ?? [])
        .filter(range => range.end_exclusive_line > range.start_line);
      const resumeMismatch = persistedManifestResumeMismatch(persistedManifest, prepared.manifest, ownPrimaryRanges);
      if (resumeMismatch) {
        const selectorRecoveryRequired = options.live && (
          target.last_failure_class === "coverage_repair"
          || Boolean(state.agent_runtime.session_file)
          || (state.repair?.mode === "repair" && state.repair.repair_source === "coverage")
        );
        if (selectorRecoveryRequired) {
          throw new Error(
            `target_selector_resume_evidence_mismatch: revision ${workspace.revision}; ${resumeMismatch}. `
            + "恢复仅允许原始证据身份不变、范围不降级的引用扩展或表元数据补全。"
            + "此检查由 harness 管理，不能修改 evidence-manifest、指纹或编译产物绕过，也不能靠修改 selectors 修复。"
            + "请先核对上述实际值、预期值及源文件/准备逻辑；若确认源文件或目标范围确实改变，再显式申请 fresh target revision。",
          );
        }
        return {
          workspace: await RevisionWorkspace.createFromEvidence(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            prepared,
          ),
          resume: false,
        };
      }
      if (
        state.status === "sealed"
        && !(await sealedWorkspaceSatisfiesCurrentContract(workspace))
      ) {
        if (
          await sealedWorkspacePlanSatisfiesCurrentContract(workspace)
          && await sealedWorkspaceHasApprovedCoverageReview(workspace)
        ) {
          return {
            workspace: await rematerializeSealedWorkspace(options, workspace),
            resume: false,
          };
        }
        return {
          workspace: await RevisionWorkspace.reviseFromSealed(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            workspace.revision,
          ),
          resume: false,
        };
      }
      if (
        !(await pathExists(workspace.manifestPath))
        && await pathExists(workspace.sealedPlanPath)
      ) {
        // 中断封印恢复不看 state.status：seal 中途被打断的 revision 会停在
        // status=sealed 但 manifest 缺失的组合上（实测 GB 50202 run
        // 20260921-071001-4a9b target 22c485b3：写入全被 sealed 守卫拒绝、批次又不认领，
        // resume 反复空转）。只要 manifest 缺失而 sealed plan 在，就回滚成可写修订。
        const recovered = await RevisionWorkspace.reviseFromInterruptedSeal(
          options.artifactRoot,
          options.jobId,
          target.target_id,
        );
        const controller = await ToolController.create(recovered);
        for (const evidence of controller.evidence.evidence) {
          await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
        }
        const validation = await controller.dispatch("validate_working_plan", {});
        if (!validation.ok) {
          throw new Error(
            `Interrupted seal recovery validation failed for ${target.target_id}: ${JSON.stringify(validation)}`,
          );
        }
        return { workspace: recovered, resume: false };
      }
    } else if (
      state.status === "sealed"
      && !(await sealedWorkspaceSatisfiesCurrentContract(workspace))
    ) {
      if (
        await sealedWorkspacePlanSatisfiesCurrentContract(workspace)
        && await sealedWorkspaceHasApprovedCoverageReview(workspace)
      ) {
        return {
          workspace: await rematerializeSealedWorkspace(options, workspace),
          resume: false,
        };
      }
      return {
        workspace: await RevisionWorkspace.reviseFromSealed(
          options.artifactRoot,
          options.jobId,
          target.target_id,
          workspace.revision,
        ),
        resume: false,
      };
    }
    if (recoveringScopeExtension) {
      throw new Error(
        "scope_extension_required: sealed discovery evidence is unavailable for a fresh target revision",
      );
    }
    if (state.status === "failed") {
      try {
        return {
          workspace: await RevisionWorkspace.reviseFromTerminalFailure(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            { resumeModelingPhaseBudget: options.resumeModelingPhaseBudget ?? true },
          ),
          resume: false,
        };
      } catch (error) {
        if (
          error instanceof Error
          && error.message === "Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor"
          && target.evidence_atom_ids
          && documentEvidence
        ) {
          const workspace = await RevisionWorkspace.createFromEvidence(
            options.artifactRoot,
            options.jobId,
            target.target_id,
            await buildAgentScopedEvidenceManifest(
              options.markdownPath,
              options.jobId,
              target as unknown as DocumentTarget,
              documentEvidence,
              options.pdfPath,
              targetPrimaryScope(target, ledger, documentEvidence.atoms, siblingTargets),
              layoutProfile,
              target.scope_extension_atom_ids,
            ),
          );
          return { workspace, resume: false };
        }
        throw error;
      }
    }
    if (state.status !== "sealed") {
      await workspace.upgradeWorkingPlanToCurrent();
    }
    return {
      workspace,
      resume: state.status !== "sealed" && Boolean(state.agent_runtime.session_file),
    };
  } catch (error) {
    const code = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (
      code !== "ENOENT"
      && !(error instanceof Error && error.message === "No persisted revision exists")
    ) {
      throw error;
    }
    const workspace = target.evidence_atom_ids && documentEvidence
      ? await RevisionWorkspace.createFromEvidence(
          options.artifactRoot,
          options.jobId,
          target.target_id,
          await buildAgentScopedEvidenceManifest(
            options.markdownPath,
            options.jobId,
            target as unknown as DocumentTarget,
            documentEvidence,
            options.pdfPath,
            targetPrimaryScope(target, ledger, documentEvidence.atoms, siblingTargets),
            layoutProfile,
            target.scope_extension_atom_ids,
          ),
        )
      : await RevisionWorkspace.create(
          options.artifactRoot,
          options.jobId,
          target.target_id,
          options.markdownPath,
        );
    return { workspace, resume: false };
  }
}

export function persistedManifestExtendsPreparedBase(
  persisted: EvidenceManifest,
  prepared: EvidenceManifest,
): boolean {
  return persistedManifestResumeMismatch(persisted, prepared) === null;
}

/** A parser's locator summary is diagnostic text, not the sealed Discovery scope. */
function scopeWithoutGeneratedClauseSummary(scope: EvidenceManifest["scope"]): EvidenceManifest["scope"] {
  if (scope.mode !== "agent_discovered" || !scope.confirmed_scope_fingerprint
    || !scope.primary_source_ranges?.length) return scope;
  const summary = /^(.*) 程序识别的条款定位候选：(暂无|(?:[A-Z]|\d+)(?:\.\d+)+(?:, (?:[A-Z]|\d+)(?:\.\d+)+)*)。此清单可能不完整，仅用于定位和检查可能遗漏；本次任务范围由已确认的目标计划确定，清单不能覆盖或扩大该范围。$/su.exec(scope.selection_reason);
  return summary ? { ...scope, selection_reason: summary[1]! } : scope;
}

/** First failed resume contract, shared by the gate and its actionable error. */
export function persistedManifestResumeMismatch(
  persisted: EvidenceManifest,
  prepared: EvidenceManifest,
  /** target 自己计划范围内的主资料行区间：范围内的运行时行切片是合法打开，不是无声扩张。 */
  ownPrimaryRanges?: ReadonlyArray<{ start_line: number; end_exclusive_line: number }>,
): string | null {
  const display = (value: unknown): string => {
    const serialized = JSON.stringify(value) ?? "undefined";
    return serialized.length <= 1024 ? serialized : JSON.stringify({
      preview: serialized.slice(0, 512), sha256: sha256Json(value), characters: serialized.length, truncated: true,
    });
  };
  const mismatch = (code: string, path: string, actual: unknown, expected: unknown): string =>
    `${code} at ${path}: actual=${display(actual)}; expected=${display(expected)}`;
  const {
    evidence_fingerprint: persistedFingerprint,
    evidence: persistedEvidence,
    reference_occurrences: persistedOccurrences,
    table_fragments: persistedFragments,
    ...persistedBase
  } = persisted;
  const {
    evidence_fingerprint: _preparedFingerprint,
    evidence: preparedEvidence,
    reference_occurrences: preparedOccurrences,
    table_fragments: preparedFragments,
    ...preparedBase
  } = prepared;
  for (const key of new Set([...Object.keys(preparedBase), ...Object.keys(persistedBase)])) {
    const actual = persistedBase[key as keyof typeof persistedBase];
    const expected = preparedBase[key as keyof typeof preparedBase];
    const diagnosticScope = key === "scope" && persisted.source.adapter === "document-domain-agent/v1"
      && prepared.source.adapter === "document-domain-agent/v1";
    const actualScope = diagnosticScope ? scopeWithoutGeneratedClauseSummary(persisted.scope) : persisted.scope;
    const expectedScope = diagnosticScope ? scopeWithoutGeneratedClauseSummary(prepared.scope) : prepared.scope;
    const summariesPresent = diagnosticScope && actualScope !== persisted.scope && expectedScope !== prepared.scope;
    const comparedActual = summariesPresent ? actualScope : actual;
    const comparedExpected = summariesPresent ? expectedScope : expected;
    if (canonicalize(comparedActual) !== canonicalize(comparedExpected)) {
      return mismatch("prepared_base_changed", `/${key}`, actual, expected);
    }
  }
  if (persistedEvidence.length < preparedEvidence.length) {
    return mismatch("prepared_evidence_missing", "/evidence/length", persistedEvidence.length, `>= ${preparedEvidence.length}`);
  }
  const scopeRank = { reference: 0, sampling: 1, primary: 2 } as const;
  for (let index = 0; index < preparedEvidence.length; index += 1) {
    const current = persistedEvidence[index]!;
    const base = preparedEvidence[index]!;
    for (const field of ["evidence_id", "locator", "text", "text_sha256"] as const) {
      if (current[field] !== base[field]) {
        // Hash large source text; never flood a terminal error with the document.
        return mismatch("immutable_evidence_changed", `/evidence/${index}/${field}`,
          field === "text" ? sha256Text(current[field]) : current[field],
          field === "text" ? sha256Text(base[field]) : base[field]);
      }
    }
    const baseScope = base.evidence_scope ?? "reference";
    const currentScope = current.evidence_scope ?? "reference";
    if (scopeRank[currentScope] < scopeRank[baseScope]) {
      return mismatch("evidence_scope_downgraded", `/evidence/${index}/evidence_scope`, currentScope, `>= ${baseScope}`);
    }
    if (base.requires_disposition && !current.requires_disposition) {
      return mismatch("evidence_disposition_dropped", `/evidence/${index}/requires_disposition`, current.requires_disposition, true);
    }
    // Registration may promote an existing record, never remove its marker or
    // introduce an explicit opt-out. Metadata-only restoration leaves it alone.
    if (current.registered_dependency !== base.registered_dependency && current.registered_dependency !== true) {
      return mismatch("dependency_registration_changed", `/evidence/${index}/registered_dependency`,
        current.registered_dependency ?? "absent", base.registered_dependency ?? "absent or true");
    }
  }
  const extensions = persistedEvidence.slice(preparedEvidence.length);
  for (const [index, record] of extensions.entries()) {
    const actual = { registered_dependency: record.registered_dependency,
      requires_disposition: record.requires_disposition, evidence_scope: record.evidence_scope };
    const expected = { registered_dependency: true, requires_disposition: false, evidence_scope: "reference" };
    if (canonicalize(actual) !== canonicalize(expected)) {
      // target 自己计划范围内的运行时行切片（open_evidence 按行打开的主资料）
      // 是被授权的读取，不是无声范围扩张：locator 携带行号且落在自身范围内即放行。
      if (
        record.evidence_scope === "primary"
        && ownPrimaryRanges?.length
        && record.locator.startsWith("line:")
      ) {
        const lineNumber = Number.parseInt(record.locator.slice(5), 10);
        if (Number.isFinite(lineNumber) && ownPrimaryRanges.some(range =>
          lineNumber >= range.start_line && lineNumber < range.end_exclusive_line)) {
          continue;
        }
      }
      return mismatch("unregistered_evidence_extension", `/evidence/${preparedEvidence.length + index}`, actual, expected);
    }
  }
  const evidenceIds = persistedEvidence.map((record) => record.evidence_id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    return mismatch("duplicate_evidence_id", "/evidence", evidenceIds.find((id, index) => evidenceIds.indexOf(id) !== index), "unique evidence_id");
  }
  // Reference registration adds parser metadata with its dependency records.
  // fragments may point at registered dependencies or unchanged base evidence.
  // Registration can reuse immutable primary/sampling sources without downgrading their scope; those
  // base records have already passed the identity and scope checks above.
  const fragmentById = new Map(persistedFragments.map(fragment => [fragment.fragment_id, fragment]));
  if (fragmentById.size !== persistedFragments.length) {
    return mismatch("duplicate_table_fragment", "/table_fragments", persistedFragments.map(fragment => fragment.fragment_id), "unique fragment_id");
  }
  for (const fragment of preparedFragments) {
    const current = fragmentById.get(fragment.fragment_id);
    if (canonicalize(current) !== canonicalize(fragment)) {
      return mismatch("prepared_table_fragment_changed", `/table_fragments/${fragment.fragment_id}`, current ?? "missing", fragment);
    }
  }
  const preparedFragmentIds = new Set(preparedFragments.map(fragment => fragment.fragment_id));
  const preparedEvidenceIds = new Set(preparedEvidence.map(record => record.evidence_id));
  const evidenceById = new Map(persistedEvidence.map(record => [record.evidence_id, record]));
  // 与证据扩展同原则：target 自己冻结范围内的 primary 行切片是授权读取，
  // 表片段引用它们与引用 base evidence 一样合法。
  const sanctionedSliceIds = new Set(extensions
    .filter(record => record.evidence_scope === "primary")
    .filter(record => {
      if (!ownPrimaryRanges?.length || !record.locator.startsWith("line:")) return false;
      const lineNumber = Number.parseInt(record.locator.slice(5), 10);
      return Number.isFinite(lineNumber) && ownPrimaryRanges.some(range =>
        lineNumber >= range.start_line && lineNumber < range.end_exclusive_line);
    })
    .map(record => record.evidence_id));
  for (const fragment of persistedFragments.filter(fragment => !preparedFragmentIds.has(fragment.fragment_id))) {
    const ids = [...fragment.row_evidence_ids, ...fragment.formal_row_evidence_ids,
      ...fragment.header_evidence_ids, ...fragment.title_candidate_evidence_ids,
      ...(fragment.continuation_caption_evidence_ids ?? [])];
    if (!fragment.row_evidence_ids.length) {
      return mismatch("empty_table_fragment", `/table_fragments/${fragment.fragment_id}/row_evidence_ids`, [], "at least one row");
    }
    const invalidId = ids.find(id => {
      const record = evidenceById.get(id);
      if (record && sanctionedSliceIds.has(id)) return false;
      // A reference registration can discover table metadata for evidence
      // already frozen in the prepared base. Those records passed the
      // immutable identity check above; only genuinely added evidence must be
      // a reference-scoped registered dependency.
      return !record || (!preparedEvidenceIds.has(id) && (
        record.registered_dependency !== true || record.evidence_scope !== "reference"
      ));
    });
    if (invalidId !== undefined) {
      return mismatch("unregistered_table_evidence", `/table_fragments/${fragment.fragment_id}`, invalidId, "unchanged base evidence or registered reference dependency");
    }
    const foreignRow = fragment.row_evidence_ids.find(id => evidenceById.get(id)?.table_fragment_id !== fragment.fragment_id);
    if (foreignRow !== undefined) {
      return mismatch("table_row_fragment_mismatch", `/evidence/${foreignRow}/table_fragment_id`, evidenceById.get(foreignRow)?.table_fragment_id, fragment.fragment_id);
    }
    const nonMemberRow = [...fragment.formal_row_evidence_ids, ...fragment.header_evidence_ids]
      .find(id => !fragment.row_evidence_ids.includes(id));
    if (nonMemberRow !== undefined) {
      return mismatch("table_row_membership_mismatch", `/table_fragments/${fragment.fragment_id}`, nonMemberRow, "formal/header rows must belong to row_evidence_ids");
    }
  }
  const occurrenceById = new Map(persistedOccurrences.map((entry) => [entry.occurrence_id, entry]));
  if (occurrenceById.size !== persistedOccurrences.length) {
    return mismatch("duplicate_reference_occurrence", "/reference_occurrences", persistedOccurrences.map(entry => entry.occurrence_id), "unique occurrence_id");
  }
  for (const occurrence of preparedOccurrences) {
    const current = occurrenceById.get(occurrence.occurrence_id);
    if (canonicalize(current) !== canonicalize(occurrence)) {
      return mismatch("prepared_reference_occurrence_changed", `/reference_occurrences/${occurrence.occurrence_id}`, current ?? "missing", occurrence);
    }
  }
  const expectedFingerprint = sha256Json({
    ...persistedBase,
    evidence: persistedEvidence,
    reference_occurrences: persistedOccurrences,
    table_fragments: persistedFragments,
  });
  return expectedFingerprint === persistedFingerprint ? null
    : mismatch("evidence_fingerprint_mismatch", "/evidence_fingerprint", persistedFingerprint, expectedFingerprint);
}

async function sealedWorkspaceSelectorSatisfiesCurrentContract(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  state: RevisionState,
): Promise<boolean> {
  if (manifest.source.adapter !== "document-domain-agent/v1") return true;
  // The deterministic offline fixture intentionally exercises the legacy
  // direct-plan tools rather than selector authoring. A live/model-authored
  // selector must always pass the current compiler before its sealed plan or
  // coverage approval can be reused.
  if (state.agent_runtime.kind === "offline-scripted") return true;
  if (
    !(await pathExists(workspace.sealedSelectorPath))
    || !(await pathExists(workspace.sourceSpanRegistryPath))
  ) return false;
  try {
    const [selector, registry] = await Promise.all([
      readJson<unknown>(workspace.sealedSelectorPath),
      readJson<SourceSpanRegistry>(workspace.sourceSpanRegistryPath),
    ]);
    const migratedSelector = migrateTargetSelectorPlan(selector);
    let recompiled: PersistedSemanticSourcePlan;
    if (await pathExists(workspace.selectorCompilerContextPath)) {
      const context = validatedSelectorCompilerContext(
        await readJson<unknown>(workspace.selectorCompilerContextPath),
        {
          manifest,
          selectors: migratedSelector,
          acceptedSourceLanguageReviews: selectorCompilerAcceptedReviews(
            state.selector_protocol?.language_review_markers,
          ),
          acceptedVerdictNameReviews: selectorCompilerAcceptedReviews(
            state.selector_protocol?.name_review_markers,
          ),
        },
      );
      if (!context) return false;
      recompiled = compileTargetSelectorsWithContext(
        migratedSelector,
        registry,
        manifest,
        context,
      );
    } else {
      recompiled = compileTargetSelectors(migratedSelector, registry, manifest);
    }
    const currentViews = validateSemanticPlanViews(prettyJson(recompiled), manifest);
    // Some older selectors predate complete source dispositions even though
    // their persisted sealed plan remains strictly valid. Once the current selector does produce a fully
    // valid plan, however, its materialized business result is authoritative:
    // a differing sealed result must be revised and independently reviewed.
    if (!currentViews.ok) return true;
    if (!(await pathExists(workspace.resultPath))) return false;
    const sealedResult = strictJsonParse(
      await readFile(workspace.resultPath, "utf8"),
    ) as AcceptanceResult;
    const currentResult = materialize(
      currentViews.value.semantic_plan,
      manifest,
      currentViews.value.fingerprint,
    ).result;
    return comparableBusinessLots(currentResult) === comparableBusinessLots(sealedResult);
  } catch {
    return false;
  }
}

/** Presentation coordinates and sibling order do not invalidate sealed business facts. */
function comparableBusinessLots(result: AcceptanceResult): string {
  return canonicalize(result.inspection_lots.map(lot => ({
    ...lot,
    items: lot.items.map(({ source_anchors: _anchors, ...business }) => business)
      .sort((a, b) => a.item_id.localeCompare(b.item_id)),
  })).sort((a, b) => a.lot_id.localeCompare(b.lot_id)));
}

export function batchResultMatchesPlan(result: AcceptanceResult, plan: SemanticSourcePlan,
  manifest: EvidenceManifest, fingerprint: string): boolean {
  const current = materialize(plan, manifest, fingerprint).result;
  return comparableBusinessLots(current) === comparableBusinessLots(result);
}

export async function sealedWorkspaceSatisfiesCurrentContract(
  workspace: RevisionWorkspace,
): Promise<boolean> {
  const requiredPaths = [
    workspace.sealedPlanPath,
    workspace.resultPath,
    workspace.manifestPath,
    workspace.sealReceiptPath,
    workspace.validationReceiptPath,
  ];
  if (!(await Promise.all(requiredPaths.map(pathExists))).every(Boolean)) return false;
  try {
    const [planText, resultText, sealedManifestText, sealReceiptText, validationReceiptText, manifest, state] = await Promise.all([
      readFile(workspace.sealedPlanPath, "utf8"),
      readFile(workspace.resultPath, "utf8"),
      readFile(workspace.manifestPath, "utf8"),
      readFile(workspace.sealReceiptPath, "utf8"),
      readFile(workspace.validationReceiptPath, "utf8"),
      workspace.readEvidenceManifest(),
      workspace.readState(),
    ]);
    if (
      manifest.source.adapter === "document-domain-agent/v1"
      && manifest.source.semantic_workflow !== SEMANTIC_EVIDENCE_SCHEMA_VERSION
    ) {
      return false;
    }
    if (!(await sealedWorkspaceSelectorSatisfiesCurrentContract(workspace, manifest, state))) {
      return false;
    }
    const planViews = validateSemanticPlanViews(planText, manifest);
    if (!planViews.ok) return false;
    const { fingerprint, plan_sha256: planSha256, semantic_plan: semanticPlan, validator } = planViews.value;
    const result = strictJsonParse(resultText) as AcceptanceResult;
    const sealedManifest = strictJsonParse(sealedManifestText) as Record<string, unknown>;
    const sealReceipt = strictJsonParse(sealReceiptText) as Record<string, unknown>;
    const validationReceipt = strictJsonParse(validationReceiptText) as Record<string, unknown>;
    const fingerprints = sealedManifest.fingerprints;
    if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) return false;
    const fingerprintRecord = fingerprints as Record<string, unknown>;
    const files = fingerprintRecord.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return false;
    const fileFingerprints = files as Record<string, unknown>;
    const compilerContextExists = await pathExists(workspace.selectorCompilerContextPath);
    const compilerContextFingerprint = fileFingerprints["selector-compiler-context.json"];
    const compilerContextMustBeTracked = manifest.source.adapter === "document-domain-agent/v1"
      && state.agent_runtime.kind !== "offline-scripted";
    if (
      (typeof compilerContextFingerprint === "string" && !compilerContextExists)
      || (
        compilerContextMustBeTracked
        && compilerContextExists
        && typeof compilerContextFingerprint !== "string"
      )
      || (
        compilerContextExists
        && typeof compilerContextFingerprint === "string"
        && compilerContextFingerprint !== sha256Text(
          await readFile(workspace.selectorCompilerContextPath, "utf8"),
        )
      )
    ) {
      return false;
    }
    if (
      state.status !== "sealed"
      || state.last_valid_fingerprint !== fingerprint
      || state.last_valid_plan_sha256 !== planSha256
      || sealedManifest.status !== "passed"
      || sealedManifest.validated_submit !== true
      || fingerprintRecord.evidence !== manifest.evidence_fingerprint
      || fingerprintRecord.plan !== fingerprint
      || fileFingerprints["semantic-source-plan.json"] !== sha256Text(planText)
      || fileFingerprints["result.json"] !== sha256Text(resultText)
      || fileFingerprints["seal-receipt.json"] !== sha256Text(sealReceiptText)
      || sealReceipt.status !== "passed"
      || sealReceipt.validated_submit !== true
      || sealReceipt.evidence_fingerprint !== manifest.evidence_fingerprint
      || sealReceipt.plan_sha256 !== planSha256
      || sealReceipt.validation_fingerprint !== fingerprint
      || validationReceipt.ok !== true
      || validationReceipt.evidence_fingerprint !== manifest.evidence_fingerprint
      || validationReceipt.plan_sha256 !== planSha256
      || validationReceipt.validation_fingerprint !== fingerprint
      || validationReceipt.validator !== validator
      || result.schema_version !== RESULT_SCHEMA_VERSION
      || result.job_id !== manifest.job_id
      || result.target_id !== manifest.target_id
      || result.evidence_fingerprint !== manifest.evidence_fingerprint
      || result.plan_fingerprint !== fingerprint
      || result.table_assembly_fingerprint !== sha256Json(semanticPlan.table_assembly)
    ) {
      return false;
    }
    // Direct validation is an explicit, fingerprinted seal protocol. Do not
    // demand a retired reviewer receipt when reopening that same valid seal.
    const directValidation = (state.target_review_protocol === "direct-validation/v1"
      || state.target_review_protocol === "same-agent-self-review/v1")
      && sealReceipt.target_review_protocol === "direct-validation/v1";
    const coverageReview = manifest.source.adapter === "document-domain-agent/v1" && !directValidation
      ? await readSealedCoverageReview(workspace, fingerprint, manifest)
      : undefined;
    const coverageApproval = manifest.source.adapter === "document-domain-agent/v1" && !directValidation
      ? await approvedCoverageReviewForRematerialization(workspace)
      : undefined;
    const items = result.inspection_lots.flatMap((lot) => lot.items);
    const sealedDocumentLedger = await workspace.readDocumentLedger();
    const sourceClauseResolutionRequired = sealedDocumentLedger
      ? sealedDocumentLedger.clauses.some(ledgerRequiredClausePredicate(sealedDocumentLedger))
      : false;
    return Boolean(
      (manifest.source.adapter !== "document-domain-agent/v1"
        || directValidation
        || (coverageReview?.status === "approved" && coverageApproval?.review.status === "approved"))
      && (!sourceClauseResolutionRequired || items.every((item) => Boolean(item.source_clause)))
      // A direct clause and its shared citation may legitimately differ. Check
      // provenance against the actual materializer contract, not clause equality.
      && batchResultMatchesPlan(result, semanticPlan, manifest, fingerprint),
    );
  } catch {
    // A malformed or stale sealed artifact set is recoverable input, never a
    // trusted fast-path result and never something this check mutates in place.
    return false;
  }
}

async function sealedWorkspacePlanSatisfiesCurrentContract(
  workspace: RevisionWorkspace,
): Promise<boolean> {
  if (!(await pathExists(workspace.sealedPlanPath))) return false;
  const [planText, manifest, state] = await Promise.all([
    readFile(workspace.sealedPlanPath, "utf8"),
    workspace.readEvidenceManifest(),
    workspace.readState(),
  ]);
  if (
    manifest.source.adapter === "document-domain-agent/v1"
    && manifest.source.semantic_workflow !== SEMANTIC_EVIDENCE_SCHEMA_VERSION
  ) {
    return false;
  }
  if (!(await sealedWorkspaceSelectorSatisfiesCurrentContract(workspace, manifest, state))) {
    return false;
  }
  return Boolean(validatePlanText(planText, manifest).ok);
}

async function sealedWorkspaceHasApprovedCoverageReview(
  workspace: RevisionWorkspace,
): Promise<boolean> {
  if ((await workspace.readEvidenceManifest()).source.adapter !== "document-domain-agent/v1") {
    return true;
  }
  return Boolean(await approvedCoverageReviewForRematerialization(workspace));
}

interface ApprovedRematerializationCoverage {
  review: DomainCoverageReview;
  scope: CoverageReviewScope;
  source_revision: number;
  plan_fingerprint: string;
  plan_sha256: string;
  evidence_fingerprint: string;
  coverage_review_fingerprint: string;
}

interface RevisionArtifactPaths {
  root: string;
  revision: number;
  evidenceManifestPath: string;
  workingPlanPath: string;
  lastValidPlanPath: string;
  sealedPlanPath: string;
  workingSelectorPath: string;
  validationReceiptPath: string;
  sealReceiptPath: string;
  manifestPath: string;
  statePath: string;
  transcriptPath: string;
  historyDirectory: string;
  piSessionDirectory: string;
  coverageReviewDirectory: string;
}

interface DeterministicRematerializationLineage {
  schema_version: "deterministic-rematerialization-lineage/v1";
  source_revision: number;
  source_plan_fingerprint: string;
  source_coverage_review_fingerprint: string;
  evidence_fingerprint: string;
}

const REMATERIALIZATION_LINEAGE_FILE = "deterministic-rematerialization.json";

function revisionArtifactPaths(root: string, revision: number): RevisionArtifactPaths {
  return {
    root,
    revision,
    evidenceManifestPath: join(root, "evidence", "evidence.json"),
    workingPlanPath: join(root, "working.semantic-source-plan.json"),
    lastValidPlanPath: join(root, "last-valid.semantic-source-plan.json"),
    sealedPlanPath: join(root, "semantic-source-plan.json"),
    workingSelectorPath: join(root, "working.target-selectors.json"),
    validationReceiptPath: join(root, "validation-receipt.json"),
    sealReceiptPath: join(root, "seal-receipt.json"),
    manifestPath: join(root, "manifest.json"),
    statePath: join(root, "state.json"),
    transcriptPath: join(root, "session.events.jsonl"),
    historyDirectory: join(root, "history"),
    piSessionDirectory: join(root, "pi-session"),
    coverageReviewDirectory: join(root, "coverage-review"),
  };
}

function workspaceArtifactPaths(workspace: RevisionWorkspace): RevisionArtifactPaths {
  return revisionArtifactPaths(workspace.root, workspace.revision);
}

function coverageReviewScopeFromSealedState(
  state: RevisionState,
  planFingerprint: string,
): CoverageReviewScope {
  const recheck = state.coverage_recheck;
  return recheck?.schema_version === "coverage-recheck-scope/v1"
    && recheck.plan_fingerprint === planFingerprint
    ? {
        mode: "repair_delta",
        affected_item_ids: [...recheck.affected_item_ids],
        affected_evidence_ids: [...recheck.affected_evidence_ids],
        finding_ids: [...recheck.finding_ids],
      }
    : { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] };
}

export function coverageReviewScopeForRun(
  deterministicScope: CoverageReviewScope,
  persistedScope: CoverageReviewScope,
): CoverageReviewScope {
  return persistedScope.mode === "repair_delta"
    ? {
        ...persistedScope,
        ...(deterministicScope.gap_clause_ids
          ? { gap_clause_ids: [...deterministicScope.gap_clause_ids] }
          : {}),
      }
    : deterministicScope;
}

const MAX_COVERAGE_CONTROLLER_REBUILDS = 2;

export interface CoverageControllerPendingControl {
  schema_version: "coverage-controller-pending/v2";
  kind: "coverage_controller_rebuild";
  job_id: string;
  target_id: string;
  revision: number;
  workdir: string;
  plan_fingerprint: string;
  receipt: NonNullable<LiveCoverageReviewResult["control"]>;
}

export interface CoverageControllerRecoveryState {
  schema_version: "coverage-controller-recovery/v2";
  job_id: string;
  target_id: string;
  revision: number;
  workdir: string;
  phase: "fresh_author_reserved" | "fresh_author_transport_retry";
  attempts: number;
  last_plan_fingerprint: string;
}

function normalizePersistedCoverageControllerRecovery(
  options: BatchArtifactOptions,
  target: BatchTarget,
): CoverageControllerRecoveryState | undefined {
  const value = target.coverage_controller_recovery as unknown;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coverage_controller_recovery_identity_invalid: persisted recovery must be an object");
  }
  const recovery = value as Record<string, unknown>;
  const commonValid = Number.isInteger(recovery.revision)
    && Number(recovery.revision) > 0
    && Number.isInteger(recovery.attempts)
    && Number(recovery.attempts) >= 1
    && typeof recovery.last_plan_fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(recovery.last_plan_fingerprint);
  const targetIdentityReady = Number.isInteger(target.revision)
    && target.revision > 0
    && typeof target.workdir === "string"
    && target.workdir.length > 0;
  if (recovery.schema_version === "coverage-controller-recovery/v1") {
    if (!commonValid || !targetIdentityReady) {
      throw new Error(
        "coverage_controller_recovery_identity_invalid: legacy recovery cannot be bound to the recorded target revision",
      );
    }
    if (recovery.revision !== target.revision) return undefined;
    return {
      schema_version: "coverage-controller-recovery/v2",
      job_id: options.jobId,
      target_id: target.target_id,
      revision: target.revision,
      workdir: target.workdir,
      phase: "fresh_author_reserved",
      attempts: Number(recovery.attempts),
      last_plan_fingerprint: recovery.last_plan_fingerprint as string,
    };
  }
  if (
    recovery.schema_version !== "coverage-controller-recovery/v2"
    || !commonValid
    || typeof recovery.job_id !== "string"
    || typeof recovery.target_id !== "string"
    || typeof recovery.workdir !== "string"
    || (recovery.phase !== "fresh_author_reserved"
      && recovery.phase !== "fresh_author_transport_retry")
  ) {
    throw new Error("coverage_controller_recovery_identity_invalid: persisted v2 recovery structure is invalid");
  }
  if (recovery.job_id !== options.jobId || recovery.target_id !== target.target_id) {
    throw new Error("coverage_controller_recovery_identity_mismatch: persisted recovery belongs to another job or target");
  }
  if (recovery.revision !== target.revision) return undefined;
  if (!targetIdentityReady || resolve(recovery.workdir) !== resolve(target.workdir)) {
    throw new Error("coverage_controller_recovery_identity_mismatch: persisted recovery workspace is not the recorded revision");
  }
  return recovery as unknown as CoverageControllerRecoveryState;
}

function coverageControllerRecoveryForWorkspace(
  target: BatchTarget,
  workspace: RevisionWorkspace,
): CoverageControllerRecoveryState | undefined {
  const recovery = target.coverage_controller_recovery;
  return recovery?.schema_version === "coverage-controller-recovery/v2"
    && recovery.job_id === workspace.jobId
    && recovery.target_id === workspace.targetId
    && recovery.revision === workspace.revision
    && resolve(recovery.workdir) === resolve(workspace.root)
    ? recovery
    : undefined;
}

function markCoverageControllerRecoveryTransportRetry(
  target: BatchTarget,
  workspace: RevisionWorkspace,
): void {
  const recovery = coverageControllerRecoveryForWorkspace(target, workspace);
  if (recovery) recovery.phase = "fresh_author_transport_retry";
}

function normalizePersistedCoverageControllerControl(
  options: BatchArtifactOptions,
  target: BatchTarget,
): CoverageControllerPendingControl | undefined {
  const value = target.coverage_control as unknown;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coverage_controller_resume_identity_invalid: persisted control must be an object");
  }
  const control = value as Record<string, unknown>;
  if (
    control.kind !== "coverage_controller_rebuild"
    || typeof control.plan_fingerprint !== "string"
    || control.receipt === null
    || typeof control.receipt !== "object"
    || Array.isArray(control.receipt)
    || (control.receipt as Record<string, unknown>).kind !== "coverage_controller_rebuild"
  ) {
    throw new Error("coverage_controller_resume_identity_invalid: persisted control structure is invalid");
  }

  const targetIdentityReady = Number.isInteger(target.revision)
    && target.revision > 0
    && typeof target.workdir === "string"
    && target.workdir.length > 0;
  if (control.schema_version === "coverage-controller-pending/v1") {
    const legacyIdentityMatches = (
      (control.job_id === undefined || control.job_id === options.jobId)
      && (control.target_id === undefined || control.target_id === target.target_id)
      && (control.revision === undefined || control.revision === target.revision)
      && (
        control.workdir === undefined
        || (typeof control.workdir === "string" && resolve(control.workdir) === resolve(target.workdir))
      )
    );
    if (!targetIdentityReady || !legacyIdentityMatches) {
      throw new Error(
        "coverage_controller_resume_identity_invalid: legacy control cannot be bound to the recorded target revision",
      );
    }
    return {
      schema_version: "coverage-controller-pending/v2",
      kind: "coverage_controller_rebuild",
      job_id: options.jobId,
      target_id: target.target_id,
      revision: target.revision,
      workdir: target.workdir,
      plan_fingerprint: control.plan_fingerprint,
      receipt: control.receipt as NonNullable<LiveCoverageReviewResult["control"]>,
    };
  }
  if (
    control.schema_version !== "coverage-controller-pending/v2"
    || typeof control.job_id !== "string"
    || typeof control.target_id !== "string"
    || !Number.isInteger(control.revision)
    || (control.revision as number) < 1
    || typeof control.workdir !== "string"
    || control.workdir.length === 0
  ) {
    throw new Error("coverage_controller_resume_identity_invalid: persisted v2 control structure is invalid");
  }
  if (
    control.job_id !== options.jobId
    || control.target_id !== target.target_id
    || control.revision !== target.revision
    || !targetIdentityReady
    || resolve(control.workdir) !== resolve(target.workdir)
  ) {
    throw new Error(
      "coverage_controller_resume_identity_mismatch: persisted control does not belong to the recorded target revision",
    );
  }
  return control as unknown as CoverageControllerPendingControl;
}

export function coverageControllerPendingTargetPatch(
  coverage: LiveCoverageReviewResult,
  attemptedPlanFingerprint: string,
  workspace: Pick<RevisionWorkspace, "jobId" | "targetId" | "revision" | "root">,
): {
  status: "pending";
  error: string;
  coverage_control: CoverageControllerPendingControl;
} | undefined {
  if (!coverage.control || coverage.control.kind !== "coverage_controller_rebuild") return undefined;
  const currentFingerprint = coverage.control.current_plan_fingerprint;
  const resumeFingerprint = /^[a-f0-9]{64}$/u.test(currentFingerprint)
    ? currentFingerprint
    : attemptedPlanFingerprint;
  return {
    status: "pending",
    error: coverage.error ?? "coverage_review_candidate_changed",
    coverage_control: {
      schema_version: "coverage-controller-pending/v2",
      kind: "coverage_controller_rebuild",
      job_id: workspace.jobId,
      target_id: workspace.targetId,
      revision: workspace.revision,
      workdir: workspace.root,
      plan_fingerprint: resumeFingerprint,
      receipt: coverage.control,
    },
  };
}

export function coverageControllerResumeHandoff(
  control: CoverageControllerPendingControl,
  workspace: Pick<RevisionWorkspace, "jobId" | "targetId" | "revision" | "root">,
  currentPlanFingerprint: string,
): Awaited<ReturnType<typeof runLivePi>> {
  if (
    control.job_id !== workspace.jobId
    || control.target_id !== workspace.targetId
    || control.revision !== workspace.revision
    || resolve(control.workdir) !== resolve(workspace.root)
  ) {
    throw new Error("coverage_controller_resume_identity_mismatch: control does not belong to this exact workspace revision");
  }
  const planFingerprint = /^[a-f0-9]{64}$/u.test(currentPlanFingerprint)
    ? currentPlanFingerprint
    : control.plan_fingerprint;
  return {
    session_id: "coverage-controller-durable-resume",
    session_file: "",
    sealed: false,
    model: "coverage-controller-durable-resume",
    review_required: true,
    review_plan_fingerprint: planFingerprint,
  };
}

type CoverageReviewRunner = (
  workspace: RevisionWorkspace,
  planFingerprint: string,
  signal?: AbortSignal,
  extraScope?: CoverageReviewScope,
  runtimeConfig?: PiAgentRuntimeModelConfig,
) => Promise<LiveCoverageReviewResult>;

export async function runCoverageReviewWithBoundedControllerRebuild(
  workspace: RevisionWorkspace,
  initialPlanFingerprint: string,
  signal: AbortSignal | undefined,
  initialScope: CoverageReviewScope,
  runtimeConfig: PiAgentRuntimeModelConfig | undefined,
  runReview: CoverageReviewRunner = runLiveCoverageReview,
): Promise<{
  coverage: LiveCoverageReviewResult;
  plan_fingerprint: string;
  scope: CoverageReviewScope;
  controller_rebuilds: number;
  author_rebuild_required?: true;
}> {
  let planFingerprint = initialPlanFingerprint;
  let scope = initialScope;
  let controllerRebuilds = 0;
  for (;;) {
    signal?.throwIfAborted();
    const coverage = await runReview(workspace, planFingerprint, signal, scope, runtimeConfig);
    const controllerReportedStale = coverageControllerRebuildRequired(
      coverage as unknown as Record<string, unknown>,
    );
    let currentRevision: RevisionState | undefined;
    if (!controllerReportedStale && coverage.sealed) {
      currentRevision = await workspace.readState();
    }
    const candidateChangedAfterReview = Boolean(
      currentRevision
      && currentRevision.last_valid_fingerprint !== planFingerprint,
    );
    if (!controllerReportedStale && !candidateChangedAfterReview) {
      return {
        coverage,
        plan_fingerprint: planFingerprint,
        scope,
        controller_rebuilds: controllerRebuilds,
      };
    }

    currentRevision ??= await workspace.readState();
    const currentFingerprint = currentRevision.last_valid_fingerprint;
    const currentPlanSha256 = currentRevision.last_valid_plan_sha256;
    const reportedReason = coverage.control?.reason;
    if (reportedReason === "current_candidate_not_durably_valid") {
      const repaired = await repairDurableCoverageCandidateCheckpoint(
        workspace,
        currentFingerprint,
      );
      if (repaired && controllerRebuilds < MAX_COVERAGE_CONTROLLER_REBUILDS) {
        currentRevision = await workspace.readState();
        const persistedScope = coverageReviewScopeFromSealedState(
          currentRevision,
          currentFingerprint,
        );
        scope = persistedScope.mode === "repair_delta"
          ? coverageReviewScopeForRun(scope, persistedScope)
          : { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] };
        planFingerprint = currentFingerprint;
        controllerRebuilds += 1;
        await workspace.appendEvent("coverage_review_controller_rebuilt", {
          job_id: workspace.jobId,
          target_id: workspace.targetId,
          revision: workspace.revision,
          stale_plan_fingerprint: coverage.control?.stale_plan_fingerprint ?? "",
          current_plan_fingerprint: currentFingerprint,
          current_plan_sha256: currentRevision.last_valid_plan_sha256,
          controller_rebuild: controllerRebuilds,
          max_controller_rebuilds: MAX_COVERAGE_CONTROLLER_REBUILDS,
          scope_mode: scope.mode,
          same_workspace: true,
          checkpoint_repaired: true,
        });
        continue;
      }
      await workspace.updateState((state) => {
        if (state.last_valid_fingerprint !== currentFingerprint) {
          throw new Error("coverage_candidate_changed_before_author_rebuild");
        }
        state.last_valid_fingerprint = "";
        state.last_valid_plan_sha256 = "";
        if (state.repair?.mode === "validated") state.repair.mode = "modeling";
      });
      const authorHandoff: LiveCoverageReviewResult = {
        ...coverage,
        error: "coverage_candidate_author_rebuild_required",
        ...(coverage.control
          ? { control: {
              ...coverage.control,
              current_plan_fingerprint: currentFingerprint,
              current_plan_sha256: currentPlanSha256,
              reason: "current_candidate_author_rebuild_required",
              required_action: "resume_same_job_target_revision_with_fresh_author_session",
              instruction: "当前 revision 没有与验证回执一致的持久化候选副本，coverage controller 无法安全重建。保留同一 job、target、revision 和 selector 工件，启动 fresh author session 重新编译并验证候选；不要新建 revision，也不要把控制转换计入失败预算。",
            } }
          : {}),
      };
      await workspace.appendEvent("coverage_candidate_fresh_author_required", {
        job_id: workspace.jobId,
        target_id: workspace.targetId,
        revision: workspace.revision,
        stale_plan_fingerprint: planFingerprint,
        current_plan_fingerprint: currentFingerprint,
        author_model_called: false,
        failure_budget_consumed: false,
      });
      return {
        coverage: authorHandoff,
        plan_fingerprint: planFingerprint,
        scope,
        controller_rebuilds: controllerRebuilds,
        author_rebuild_required: true,
      };
    }
    const fingerprintReady = /^[a-f0-9]{64}$/u.test(currentFingerprint)
      && /^[a-f0-9]{64}$/u.test(currentPlanSha256);
    if (
      !fingerprintReady
      || currentFingerprint === planFingerprint
      || controllerRebuilds >= MAX_COVERAGE_CONTROLLER_REBUILDS
    ) {
      const reason = reportedReason ?? (!fingerprintReady
        ? "current_candidate_not_durably_valid"
        : currentFingerprint === planFingerprint
          ? "current_fingerprint_did_not_advance"
          : "bounded_controller_rebuild_limit_reached");
      const stopped: LiveCoverageReviewResult = {
        sealed: false,
        terminal: true,
        model: "coverage-controller-stale",
        error: reason === "bounded_controller_rebuild_limit_reached"
          ? "coverage_controller_rebuild_limit_reached"
          : "coverage_controller_rebuild_no_progress",
        control: {
          kind: "coverage_controller_rebuild",
          retryable: true,
          same_job_required: true,
          stale_plan_fingerprint: planFingerprint,
          current_plan_fingerprint: currentFingerprint,
          current_plan_sha256: currentPlanSha256,
          required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
          reason,
          instruction: "Coverage controller 有界重建本轮未取得可继续的持久化候选。把此回条保存为可恢复控制状态，保留同一 job、target、revision 与现有工件；下次只从 current_plan_fingerprint 和 controller 持久状态继续，不调用作者模型，不新建 job/target/revision，不盲目重启旧 controller，也不把该控制回条改写为业务覆盖失败。",
        },
      };
      await workspace.appendEvent("coverage_review_controller_rebuild_stopped", {
        job_id: workspace.jobId,
        target_id: workspace.targetId,
        revision: workspace.revision,
        attempted_plan_fingerprint: planFingerprint,
        current_plan_fingerprint: currentFingerprint,
        controller_rebuilds: controllerRebuilds,
        reason,
      });
      return {
        coverage: stopped,
        plan_fingerprint: planFingerprint,
        scope,
        controller_rebuilds: controllerRebuilds,
      };
    }

    const persistedScope = coverageReviewScopeFromSealedState(currentRevision, currentFingerprint);
    const nextScope = persistedScope.mode === "repair_delta"
      ? coverageReviewScopeForRun(scope, persistedScope)
      : { mode: "full" as const, affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] };
    controllerRebuilds += 1;
    await workspace.appendEvent("coverage_review_controller_rebuilt", {
      job_id: workspace.jobId,
      target_id: workspace.targetId,
      revision: workspace.revision,
      stale_plan_fingerprint: planFingerprint,
      current_plan_fingerprint: currentFingerprint,
      current_plan_sha256: currentPlanSha256,
      controller_rebuild: controllerRebuilds,
      max_controller_rebuilds: MAX_COVERAGE_CONTROLLER_REBUILDS,
      scope_mode: nextScope.mode,
      same_workspace: true,
    });
    planFingerprint = currentFingerprint;
    scope = nextScope;
  }
}

function persistedCoverageReviewScope(value: unknown): CoverageReviewScope | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.mode !== "full"
    && record.mode !== "repair_delta"
    && record.mode !== "ledger_gap"
    && record.mode !== "risk_delta"
  ) return undefined;
  if (
    !Array.isArray(record.affected_item_ids)
    || !record.affected_item_ids.every((entry) => typeof entry === "string")
    || !Array.isArray(record.affected_evidence_ids)
    || !record.affected_evidence_ids.every((entry) => typeof entry === "string")
    || !Array.isArray(record.finding_ids)
    || !record.finding_ids.every((entry) => typeof entry === "string")
  ) return undefined;
  const gapClauseIds = Array.isArray(record.gap_clause_ids)
    && record.gap_clause_ids.every((entry) => typeof entry === "string")
    ? record.gap_clause_ids as string[]
    : undefined;
  return {
    mode: record.mode,
    affected_item_ids: [...record.affected_item_ids] as string[],
    affected_evidence_ids: [...record.affected_evidence_ids] as string[],
    finding_ids: [...record.finding_ids] as string[],
    ...(gapClauseIds ? { gap_clause_ids: [...gapClauseIds] } : {}),
  };
}

async function coverageReviewScopeForSealedArtifact(
  artifact: RevisionArtifactPaths,
  state: RevisionState,
  planFingerprint: string,
): Promise<CoverageReviewScope> {
  const recheck = coverageReviewScopeFromSealedState(state, planFingerprint);
  if (recheck.mode === "repair_delta") return recheck;
  const path = join(artifact.coverageReviewDirectory, planFingerprint, "review-scope.json");
  if (!(await pathExists(path))) return recheck;
  const persisted = await readJson<unknown>(path).catch(() => undefined);
  return persistedCoverageReviewScope(persisted) ?? recheck;
}

async function approvedCoverageReviewForRematerialization(
  workspace: RevisionWorkspace,
): Promise<ApprovedRematerializationCoverage | undefined> {
  return approvedCoverageReviewAt(workspaceArtifactPaths(workspace));
}

async function approvedCoverageReviewAt(
  artifact: RevisionArtifactPaths,
): Promise<ApprovedRematerializationCoverage | undefined> {
  if (
    !(await pathExists(artifact.manifestPath))
    || !(await pathExists(artifact.sealReceiptPath))
    || !(await pathExists(artifact.sealedPlanPath))
    || !(await pathExists(artifact.validationReceiptPath))
  ) return undefined;
  const [evidence, state, planText, sealedManifestText, sealReceiptText, validationReceiptText] = await Promise.all([
    readJson<EvidenceManifest>(artifact.evidenceManifestPath),
    readJson<RevisionState>(artifact.statePath),
    readFile(artifact.sealedPlanPath, "utf8"),
    readFile(artifact.manifestPath, "utf8"),
    readFile(artifact.sealReceiptPath, "utf8"),
    readFile(artifact.validationReceiptPath, "utf8"),
  ]);
  if (evidence.source.adapter !== "document-domain-agent/v1") return undefined;
  const planViews = validateSemanticPlanViews(planText, evidence);
  if (!planViews.ok) return undefined;
  const sealedManifest = strictJsonParse(sealedManifestText) as Record<string, unknown>;
  const sealReceipt = strictJsonParse(sealReceiptText) as Record<string, unknown>;
  const validationReceipt = strictJsonParse(validationReceiptText) as Record<string, unknown>;
  const fingerprints = sealedManifest.fingerprints;
  if (fingerprints === null || typeof fingerprints !== "object" || Array.isArray(fingerprints)) return undefined;
  const fingerprintRecord = fingerprints as Record<string, unknown>;
  const files = fingerprintRecord.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return undefined;
  const fileFingerprints = files as Record<string, unknown>;
  const planFingerprint = (fingerprints as Record<string, unknown>).plan;
  const reviewFingerprint = (fingerprints as Record<string, unknown>).coverage_review;
  if (
    typeof planFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(planFingerprint)
    || typeof reviewFingerprint !== "string"
    || state.status !== "sealed"
    || state.last_valid_fingerprint !== planViews.value.fingerprint
    || state.last_valid_plan_sha256 !== planViews.value.plan_sha256
    || sealedManifest.status !== "passed"
    || sealedManifest.validated_submit !== true
    || fingerprintRecord.evidence !== evidence.evidence_fingerprint
    || planFingerprint !== planViews.value.fingerprint
    || fileFingerprints["semantic-source-plan.json"] !== sha256Text(planText)
    || fileFingerprints["seal-receipt.json"] !== sha256Text(sealReceiptText)
    || sealReceipt.status !== "passed"
    || sealReceipt.validated_submit !== true
    || sealReceipt.evidence_fingerprint !== evidence.evidence_fingerprint
    || sealReceipt.plan_sha256 !== planViews.value.plan_sha256
    || sealReceipt.validation_fingerprint !== planViews.value.fingerprint
    || validationReceipt.ok !== true
    || validationReceipt.evidence_fingerprint !== evidence.evidence_fingerprint
    || validationReceipt.plan_sha256 !== planViews.value.plan_sha256
    || validationReceipt.validation_fingerprint !== planViews.value.fingerprint
    || validationReceipt.validator !== planViews.value.validator
    || reviewFingerprint !== sealReceipt.coverage_review_fingerprint
  ) return undefined;
  const reviewPath = join(
    artifact.coverageReviewDirectory,
    planFingerprint,
    "coverage-review.json",
  );
  if (!(await pathExists(reviewPath))) return undefined;
  const review = await readJson<unknown>(reviewPath);
  if (sha256Json(review) !== reviewFingerprint) return undefined;
  const scope = await coverageReviewScopeForSealedArtifact(artifact, state, planFingerprint);
  const validation = validateCoverageReview(
    migrateCoverageReview(review),
    planFingerprint,
    evidence,
    undefined,
    planViews.value.semantic_plan,
    scope,
  );
  if (!validation.ok || validation.review?.status !== "approved") return undefined;
  return {
    review: validation.review,
    scope,
    source_revision: artifact.revision,
    plan_fingerprint: planViews.value.fingerprint,
    plan_sha256: planViews.value.plan_sha256,
    evidence_fingerprint: evidence.evidence_fingerprint,
    coverage_review_fingerprint: reviewFingerprint,
  };
}

async function directoryHasFiles(path: string): Promise<boolean> {
  return await pathExists(path) && (await readdir(path, { withFileTypes: true }))
    .some((entry) => entry.isFile());
}

function isDeterministicRematerializationToolEvent(
  value: unknown,
  explicitLineage: boolean,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.event_type === "sealed_selector_checkpoint_carried_forward") {
    return explicitLineage;
  }
  const allowedTargetTools = new Set(["open_evidence", "validate_working_plan"]);
  if (event.event_type === "tool_execution_start" || event.event_type === "tool_execution_end") {
    const payload = event.payload;
    return payload !== null
      && typeof payload === "object"
      && !Array.isArray(payload)
      && allowedTargetTools.has(String((payload as Record<string, unknown>).tool_name ?? ""));
  }
  if (event.event_type !== "coverage_review_event") return false;
  const nested = event.payload;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return false;
  const nestedRecord = nested as Record<string, unknown>;
  if (nestedRecord.event_type !== "tool_execution_start" && nestedRecord.event_type !== "tool_execution_end") {
    return false;
  }
  const nestedPayload = nestedRecord.payload;
  if (nestedPayload === null || typeof nestedPayload !== "object" || Array.isArray(nestedPayload)) return false;
  return new Set([
    "open_review_evidence",
    "batch_open_review_evidence",
    "stage_coverage_review_draft",
    "seal_coverage_review",
  ]).has(String((nestedPayload as Record<string, unknown>).tool_name ?? ""));
}

async function hasOnlyDeterministicRematerializationEvents(
  artifact: RevisionArtifactPaths,
  explicitLineage: boolean,
): Promise<boolean> {
  if (!(await pathExists(artifact.transcriptPath))) return true;
  const content = await readFile(artifact.transcriptPath, "utf8");
  for (const line of content.split(/\r?\n/u).filter(Boolean)) {
    let event: unknown;
    try {
      event = strictJsonParse(line);
    } catch {
      return false;
    }
    if (!isDeterministicRematerializationToolEvent(event, explicitLineage)) return false;
  }
  return true;
}

function isEmptyLegacySelector(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const selector = value as Record<string, unknown>;
  return ["lots", "items", "sampling_rules", "references", "source_dispositions"]
    .every((key) => Array.isArray(selector[key]) && (selector[key] as unknown[]).length === 0);
}

async function legacyInterruptedRematerializationMatches(
  artifact: RevisionArtifactPaths,
  state: RevisionState,
  evidence: EvidenceManifest,
  planFingerprint: string,
  planSha256: string,
): Promise<boolean> {
  if (
    state.lineage !== undefined
    || state.validation_attempts !== 1
    || state.last_valid_fingerprint !== planFingerprint
    || state.last_valid_plan_sha256 !== planSha256
    || state.agent_runtime.kind !== "unassigned"
    || state.agent_runtime.session_id !== ""
    || state.agent_runtime.session_file !== ""
    || state.selector_protocol?.submissions !== 0
    || state.selector_protocol?.corrections !== 0
    || state.selector_protocol?.coverage_repairs !== 0
    || await directoryHasFiles(artifact.historyDirectory)
    || await directoryHasFiles(artifact.piSessionDirectory)
    || !(await pathExists(artifact.validationReceiptPath))
    || !(await pathExists(artifact.lastValidPlanPath))
    || !(await pathExists(artifact.workingSelectorPath))
  ) return false;
  const [receipt, lastValidText, selector] = await Promise.all([
    readJson<Record<string, unknown>>(artifact.validationReceiptPath),
    readFile(artifact.lastValidPlanPath, "utf8"),
    readJson<unknown>(artifact.workingSelectorPath),
  ]);
  const lastValid = validatePlanText(lastValidText, evidence);
  return receipt.ok === true
    && receipt.trigger === "manual"
    && receipt.validated_submit === false
    && receipt.evidence_fingerprint === evidence.evidence_fingerprint
    && receipt.plan_sha256 === planSha256
    && receipt.validation_fingerprint === planFingerprint
    && lastValid.ok
    && lastValid.fingerprint === planFingerprint
    && isEmptyLegacySelector(selector)
    && evidence.evidence.every((entry) => state.opened_evidence_ids?.includes(entry.evidence_id))
    && await hasOnlyDeterministicRematerializationEvents(artifact, false);
}

async function nearestApprovedSealedAncestor(
  workspace: RevisionWorkspace,
): Promise<{ artifact: RevisionArtifactPaths; approved: ApprovedRematerializationCoverage } | undefined> {
  const revisionsDirectory = dirname(workspace.root);
  const revisions = (await readdir(revisionsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{6}$/u.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((revision) => revision < workspace.revision)
    .sort((left, right) => right - left);
  for (const revision of revisions) {
    const artifact = revisionArtifactPaths(
      join(revisionsDirectory, String(revision).padStart(6, "0")),
      revision,
    );
    const approved = await approvedCoverageReviewAt(artifact);
    if (approved) return { artifact, approved };
  }
  return undefined;
}

async function interruptedRematerializationSource(
  workspace: RevisionWorkspace,
): Promise<ApprovedRematerializationCoverage | undefined> {
  const artifact = workspaceArtifactPaths(workspace);
  const state = await workspace.readState();
  if (
    state.status !== "working"
    || await pathExists(artifact.manifestPath)
    || await pathExists(artifact.sealedPlanPath)
    || !(await pathExists(artifact.workingPlanPath))
    || state.agent_runtime.kind !== "unassigned"
    || state.agent_runtime.session_id !== ""
    || state.agent_runtime.session_file !== ""
    || await directoryHasFiles(artifact.piSessionDirectory)
  ) return undefined;
  const ancestor = await nearestApprovedSealedAncestor(workspace);
  if (!ancestor) return undefined;
  const [evidence, workingPlanText] = await Promise.all([
    workspace.readEvidenceManifest(),
    readFile(artifact.workingPlanPath, "utf8"),
  ]);
  const candidate = validatePlanText(workingPlanText, evidence);
  if (
    !candidate.ok
    || candidate.fingerprint !== ancestor.approved.plan_fingerprint
    || candidate.plan_sha256 !== ancestor.approved.plan_sha256
    || evidence.evidence_fingerprint !== ancestor.approved.evidence_fingerprint
  ) return undefined;
  const markerPath = join(workspace.root, REMATERIALIZATION_LINEAGE_FILE);
  if (await pathExists(markerPath)) {
    const marker = await readJson<DeterministicRematerializationLineage>(markerPath);
    if (
      marker.schema_version !== "deterministic-rematerialization-lineage/v1"
      || marker.source_revision !== ancestor.artifact.revision
      || marker.source_plan_fingerprint !== ancestor.approved.plan_fingerprint
      || marker.source_coverage_review_fingerprint !== ancestor.approved.coverage_review_fingerprint
      || marker.evidence_fingerprint !== ancestor.approved.evidence_fingerprint
      || (state.lineage !== undefined && state.lineage.source_revision !== marker.source_revision)
      || !(await hasOnlyDeterministicRematerializationEvents(artifact, true))
    ) return undefined;
    return ancestor.approved;
  }
  return await legacyInterruptedRematerializationMatches(
    artifact,
    state,
    evidence,
    candidate.fingerprint,
    candidate.plan_sha256,
  ) ? ancestor.approved : undefined;
}

function rematerializationLineage(
  approved: ApprovedRematerializationCoverage,
): DeterministicRematerializationLineage {
  return {
    schema_version: "deterministic-rematerialization-lineage/v1",
    source_revision: approved.source_revision,
    source_plan_fingerprint: approved.plan_fingerprint,
    source_coverage_review_fingerprint: approved.coverage_review_fingerprint,
    evidence_fingerprint: approved.evidence_fingerprint,
  };
}

async function rematerializeSealedWorkspace(
  options: FullBatchOptions,
  previous: RevisionWorkspace,
): Promise<RevisionWorkspace> {
  const previousEvidence = await previous.readEvidenceManifest();
  const approvedCoverage = previousEvidence.source.adapter === "document-domain-agent/v1"
    ? await approvedCoverageReviewForRematerialization(previous)
    : undefined;
  const workspace = await RevisionWorkspace.reviseFromSealed(
    options.artifactRoot,
    options.jobId,
    previous.targetId,
    previous.revision,
  );
  return finishDeterministicRematerialization(workspace, approvedCoverage);
}

async function finishDeterministicRematerialization(
  workspace: RevisionWorkspace,
  approvedCoverage: ApprovedRematerializationCoverage | undefined,
): Promise<RevisionWorkspace> {
  const targetId = workspace.targetId;
  const evidence = await workspace.readEvidenceManifest();
  if (approvedCoverage) {
    await atomicWriteJson(
      join(workspace.root, REMATERIALIZATION_LINEAGE_FILE),
      rematerializationLineage(approvedCoverage),
    );
  }
  const controller = await ToolController.create(workspace);
  for (const evidence of controller.evidence.evidence) {
    await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  }
  const state = await workspace.readState();
  const lastValidText = await pathExists(workspace.lastValidPlanPath)
    ? await readFile(workspace.lastValidPlanPath, "utf8")
    : "";
  const reusable = lastValidText ? validatePlanText(lastValidText, evidence) : undefined;
  const validation = approvedCoverage
    && reusable?.ok
    && reusable.fingerprint === approvedCoverage.plan_fingerprint
    && reusable.plan_sha256 === approvedCoverage.plan_sha256
    && state.last_valid_fingerprint === reusable.fingerprint
    && state.last_valid_plan_sha256 === reusable.plan_sha256
    ? {
        ok: true,
        fingerprint: reusable.fingerprint,
        plan_sha256: reusable.plan_sha256,
      }
    : await controller.dispatch("validate_working_plan", {});
  if (!validation.ok) {
    throw new Error(`Deterministic rematerialization validation failed for ${targetId}: ${JSON.stringify(validation)}`);
  }
  if (controller.evidence.source.adapter === "document-domain-agent/v1") {
    if (
      approvedCoverage?.review.status !== "approved"
      || approvedCoverage.plan_fingerprint !== validation.fingerprint
    ) {
      throw new Error(`Deterministic rematerialization lacks an approved unchanged coverage review for ${targetId}`);
    }
    if (approvedCoverage.scope.mode === "repair_delta") {
      await workspace.updateState((state) => {
        state.coverage_recheck = {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: String(validation.fingerprint),
          source_plan_fingerprint: "",
          review_fingerprint: "",
          finding_ids: [...approvedCoverage.scope.finding_ids],
          affected_item_ids: [...approvedCoverage.scope.affected_item_ids],
          affected_evidence_ids: [...approvedCoverage.scope.affected_evidence_ids],
        };
      });
    }
    const reviewController = await CoverageReviewController.create(
      workspace,
      String(validation.fingerprint),
      approvedCoverage.scope,
    );
    for (const evidence of controller.evidence.evidence) {
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: evidence.evidence_id,
      });
    }
    let stagedReview = await reviewController.dispatch("stage_coverage_review_draft", {
      status: "approved",
      summary: approvedCoverage.review.summary,
    });
    const findings = approvedCoverage.review.findings;
    for (let offset = 0; offset < findings.length; offset += 32) {
      stagedReview = await reviewController.dispatch("stage_coverage_review_draft", {
        finding_upserts: findings.slice(offset, offset + 32),
      });
    }
    const rows = approvedCoverage.review.semantic_coverage;
    for (let offset = 0; offset < rows.length; offset += 32) {
      stagedReview = await reviewController.dispatch("stage_coverage_review_draft", {
        semantic_coverage_upserts: rows.slice(offset, offset + 32),
      });
    }
    const reviewValidation = stagedReview.validation as Record<string, unknown> | undefined;
    if (!reviewValidation?.ok) {
      throw new Error(`Deterministic rematerialization coverage receipt failed for ${targetId}`);
    }
    const reviewSeal = await reviewController.dispatch("seal_coverage_review", {
      fingerprint: reviewValidation.fingerprint,
    });
    if (!reviewSeal.ok) {
      throw new Error(`Deterministic rematerialization coverage seal failed for ${targetId}: ${JSON.stringify(reviewSeal)}`);
    }
  }
  const sealed = await controller.dispatch("seal_validated_plan", {
    fingerprint: validation.fingerprint,
  });
  if (!sealed.ok) {
    throw new Error(`Deterministic rematerialization seal failed for ${targetId}: ${JSON.stringify(sealed)}`);
  }
  return workspace;
}

interface SealedTargetResult {
  target_id: string;
  target_definition: Record<string, unknown>;
  result: AcceptanceResult;
  revision: number;
  manifest_sha256: string;
}

function ledgerPathFor(options: FullBatchOptions): string {
  return join(
    options.artifactRoot,
    "jobs",
    encodedSegment(options.jobId),
    "discovery",
    "document-ledger.json",
  );
}

/**
 * 全书闸门（纯函数部分）：每个 target 各自封存成功，不等于底账里带「检查数量」的条文都被抽到。
 * 把缺口条文映射回拥有它的 target，让失败信息能直接指向要重跑的范围。
 */
export function batchLedgerGapFrom(input: {
  ledger: DocumentLedger;
  targets: ReadonlyArray<{ target_id: string; name?: string; ledger_window_id?: string;
    primary_source_ranges?: EvidenceManifest["scope"]["primary_source_ranges"] }>;
  items: ReadonlyArray<Parameters<typeof reconcileLedgerCoverage>[0]["items"][number]>;
  accounted_clause_ids?: readonly string[];
  /** Explicit source-bound exclusions made by the independent discovery LLM. */
  discovery_context_clause_ids?: readonly string[];
  field_covered_clause_ids?: readonly string[];
  scope_covered_clause_ids?: readonly string[];
  /** 各 target 的证据清单合集：按行号归属条文时用。 */
  evidence?: ReadonlyArray<{ evidence_id: string; locator?: string }>;
}): { reconciliation: LedgerReconciliation; gap?: BatchLedgerGap } {
  const reconciliation = reconcileLedgerCoverage({
    ledger: input.ledger,
    items: input.items,
    accounted_clause_ids: [...(input.accounted_clause_ids ?? []), ...(input.discovery_context_clause_ids ?? [])],
    ...(input.field_covered_clause_ids ? { field_covered_clause_ids: input.field_covered_clause_ids } : {}),
    ...(input.scope_covered_clause_ids ? { scope_covered_clause_ids: input.scope_covered_clause_ids } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  if (!reconciliation.applicable || reconciliation.ok) return { reconciliation };
  const missing = new Set(reconciliation.missing_clause_ids);
  const owners: BatchLedgerGap["owners"] = [];
  const claimed = new Set<string>();
  for (const target of input.targets) {
    const window = target.ledger_window_id
      ? input.ledger.windows.find((entry) => entry.window_id === target.ledger_window_id)
      : resolveLedgerWindowForTarget(input.ledger, target);
    const confirmedRanges = target.primary_source_ranges?.filter(range => range.end_exclusive_line > range.start_line) ?? [];
    const owned = (confirmedRanges.length
      ? requiredClauseIdsInSourceRanges(input.ledger, confirmedRanges)
      : window?.extractable_clause_ids ?? []).filter(clauseId => missing.has(clauseId));
    if (!owned.length) continue;
    for (const clauseId of owned) claimed.add(clauseId);
    owners.push({
      target_id: target.target_id,
      target_name: target.name ?? "",
      ledger_window_id: window?.window_id ?? "",
      missing_clause_ids: owned,
    });
  }
  return {
    reconciliation,
    gap: {
      missing_clause_ids: reconciliation.missing_clause_ids,
      extra_clause_ids: reconciliation.extra_clause_ids,
      unresolved_table_refs: reconciliation.unresolved_table_refs,
      ...(reconciliation.table_reference_diagnostics?.length
        ? { table_reference_diagnostics: reconciliation.table_reference_diagnostics } : {}),
      unlabeled_item_count: reconciliation.unlabeled_item_count,
      required_clause_count: reconciliation.required_clause_count,
      covered_required_clause_count: reconciliation.covered_required_clause_count,
      owners,
      unowned_clause_ids: reconciliation.missing_clause_ids.filter((clauseId) => !claimed.has(clauseId)),
    },
  };
}

async function readDiscoveryContextClauses(ledgerPath: string): Promise<string[]> {
  const receiptPath = join(dirname(ledgerPath), "seal-receipt.json");
  if (!(await pathExists(receiptPath))) return [];
  const receipt = await readJson<{ coverage_review?: { excluded_clause_ids: string[] } }>(receiptPath);
  return receipt.coverage_review?.excluded_clause_ids ?? [];
}

async function evaluateBatchLedgerGap(
  options: FullBatchOptions,
  state: FullBatchState,
  targets: readonly SealedTargetResult[],
): Promise<{ reconciliation?: LedgerReconciliation; gap?: BatchLedgerGap }> {
  const ledgerPath = ledgerPathFor(options);
  if (!(await pathExists(ledgerPath))) return {};
  const storedLedger = await readJson<DocumentLedger>(ledgerPath);
  const frozenSourcePath = join(dirname(ledgerPath), "source.md");
  const frozenMarkdown = await pathExists(frozenSourcePath) ? await readFile(frozenSourcePath, "utf8") : undefined;
  const ledger = frozenMarkdown === undefined ? storedLedger
    : ledgerWithCurrentTableCaptions(ledgerWithCurrentClauseBoundaries(storedLedger, frozenMarkdown), frozenMarkdown);
  const discoveryContextClauses = await readDiscoveryContextClauses(ledgerPath);
  const fieldCoveredClauseIds = new Set<string>();
  const scopeCoveredClauseIds = new Set<string>();
  const primaryRangesByTarget = new Map<string, EvidenceManifest["scope"]["primary_source_ranges"]>();
  // 各 target 的证据清单合起来才能按行号归属条文；读不到的 target 静默跳过，
  // 归属会退回文本回捞，不影响其余部分。
  const evidence: Array<{ evidence_id: string; locator?: string }> = [];
  const placeholderOriginEvidenceIds = new Set<string>();
  const authorKeysByTarget = new Map<string, Map<string, string>>();
  for (const sealed of targets) {
    try {
      const workspace = await RevisionWorkspace.openRevision(
        options.artifactRoot,
        options.jobId,
        sealed.target_id,
        sealed.revision,
      );
      const manifest = await workspace.readEvidenceManifest();
      primaryRangesByTarget.set(sealed.target_id, manifest.scope.primary_source_ranges);
      for (const record of manifest.evidence) {
        evidence.push({ evidence_id: record.evidence_id, locator: record.locator });
      }
      const plan = await readJson<PersistedSemanticSourcePlan>(workspace.sealedPlanPath);
      for (const clause of boundFieldClauseIds(plan, manifest.evidence, ledger)) {
        fieldCoveredClauseIds.add(clause);
      }
      for (const evidenceId of accountedReferenceOriginEvidenceIds(plan, manifest.reference_occurrences)) {
        placeholderOriginEvidenceIds.add(evidenceId);
      }
      // Diagnostic lookup follows coverage accounting so a missing historical
      // author file cannot discard already verified coverage facts.
      if (await pathExists(workspace.sealedSelectorPath)) {
        const selectors = migrateTargetSelectorPlan(strictJsonParse(await readFile(workspace.sealedSelectorPath, "utf8")));
        authorKeysByTarget.set(sealed.target_id, new Map(selectors.items.map(item =>
          [semanticItemIdForSelectorKey(sealed.target_id, item.key), item.key])));
        const registry = await workspace.readSourceSpanRegistry();
        for (const clause of boundLotScopeClauseIds(selectors, registry, manifest, ledger)) scopeCoveredClauseIds.add(clause);
      }
    } catch {
      // 该 target 的证据读不到就不参与行号归属
    }
  }
  const clauseIds = ledgerClauseIdSet(ledger);
  const lineIndex = evidenceLineIndex(evidence);
  const accountedClauseIds = [...placeholderOriginEvidenceIds].map((evidenceId) =>
    resolveItemClauseId({ evidence_ids: [evidenceId] }, clauseIds, ledger, lineIndex)
  ).filter(Boolean);
  return batchLedgerGapFrom({
    ledger,
    targets: state.targets.map(target => ({ ...target, primary_source_ranges: primaryRangesByTarget.get(target.target_id) })),
    items: targets.flatMap(({ result, target_id }) =>
      result.inspection_lots.flatMap((lot) => lot.items.map(item => ({ ...item, target_id,
        ...(authorKeysByTarget.get(target_id)?.has(item.item_id)
          ? { author_item_key: authorKeysByTarget.get(target_id)!.get(item.item_id)! } : {}),
      })))
    ),
    evidence,
    accounted_clause_ids: accountedClauseIds,
    discovery_context_clause_ids: discoveryContextClauses,
    field_covered_clause_ids: [...fieldCoveredClauseIds],
    scope_covered_clause_ids: [...scopeCoveredClauseIds],
  });
}

export function describeBatchLedgerGap(gap: BatchLedgerGap): string {
  const owned = gap.owners
    .map((owner) => `${owner.target_name || owner.target_id}(${owner.ledger_window_id}): ${owner.missing_clause_ids.join("、")}`)
    .join("；");
  return [
    `底账对账未通过：必抽条文覆盖 ${gap.covered_required_clause_count}/${gap.required_clause_count}`,
    gap.missing_clause_ids.length ? `缺少 ${gap.missing_clause_ids.join("、")}` : "",
    owned ? `归属 ${owned}` : "",
    gap.unowned_clause_ids.length ? `无 target 认领 ${gap.unowned_clause_ids.join("、")}` : "",
    gap.extra_clause_ids.length ? `底账不存在的条文引用 ${gap.extra_clause_ids.join("、")}` : "",
    gap.unresolved_table_refs?.length ? `未找到对应表题的表号 ${gap.unresolved_table_refs.join("、")}` : "",
    ...(gap.table_reference_diagnostics ?? []).slice(0, 3).map(diagnostic => {
      const example = diagnostic.affected_records[0];
      return `表号 ${diagnostic.table_no}：精确表题匹配 ${diagnostic.actual.matching_caption_count}（通过条件至少 1），`
        + `影响 ${diagnostic.actual.affected_item_count} 个项目`
        + (example ? `；核对 ${example.target_id ?? "当前 target"}/${example.item_id ?? `聚合项目 ${example.aggregate_item_index}`} 的 ${example.field}，实际引用 ${JSON.stringify(example.raw_reference)}` : "")
        + (example?.record_read ? `；作者读取 ${example.record_read.tool}(${JSON.stringify(example.record_read.arguments)})` : "")
        + `；原文条文中同号引用 ${diagnostic.actual.source_clause_occurrence_count} 处（仅为观察，不证明引用有效）`;
    }),
    gap.unresolved_table_refs?.length
      ? "详情及有界样例见 receipt.json 的 table_reference_diagnostics；完整失败表号以 unresolved_table_refs 为准。先核对原文、表题清册及关联作者记录；已封存记录在当前修订不可写，不能改冻结原文、底账或封存产物消错，也不能猜编号映射。若作者记录实际有误，走合法修订；若输入/准备事实有误，恢复可信输入或修正准备逻辑后按新输入建立修订。没有真实修复直接恢复会重复同一阻断。"
      : "",
    gap.unlabeled_item_count ? `未标注条文号的项目 ${gap.unlabeled_item_count} 个` : "",
  ].filter(Boolean).join("；");
}

async function collectSealedTargets(
  options: BatchArtifactOptions,
  state: FullBatchState,
): Promise<SealedTargetResult[]> {
  const targets: SealedTargetResult[] = [];
  for (const target of state.targets) {
    if (target.status !== "sealed") continue;
    const workspace = await openBatchTargetWorkspace(options, target);
    targets.push({
      target_id: target.target_id,
      target_definition: targetDefinition(target),
      result: await readJson<AcceptanceResult>(workspace.resultPath),
      revision: workspace.revision,
      manifest_sha256: sha256Bytes(await readFile(workspace.manifestPath)),
    });
  }
  return targets;
}

async function aggregate(
  options: BatchArtifactOptions,
  state: FullBatchState,
  targets: readonly SealedTargetResult[],
  reconciliation: LedgerReconciliation | undefined,
): Promise<void> {
  const businessResult = {
    schema_version: "gb50202-full-acceptance-result/v1",
    job_id: options.jobId,
    ...(state.discovery?.no_target_reason ? { outcome: "no_extractable_acceptance_scope", no_target_reason: state.discovery.no_target_reason } : {}),
    source_sha256: state.source.markdown_sha256,
    inventory_revision: state.inventory_revision ?? 1,
    discovery_plan_sha256: state.discovery?.plan_sha256 ?? "",
    targets: targets.map(({ target_id, target_definition, result }) => ({
      target_id,
      target_definition,
      inspection_lots: result.inspection_lots,
    })),
  };
  const receipt = {
    schema_version: "gb50202-full-receipt/v1",
    job_id: options.jobId,
    status: state.status,
    inventory_revision: state.inventory_revision ?? 1,
    ...(reconciliation ? { ledger_reconciliation: reconciliation } : {}),
    ...(state.ledger_gap ? { ledger_gap: state.ledger_gap } : {}),
    discovery_plan_sha256: state.discovery?.plan_sha256 ?? "",
    target_count: state.targets.length,
    sealed_target_count: targets.length,
    inspection_lot_count: targets.reduce(
      (count, target) => count + target.result.inspection_lots.length,
      0,
    ),
    acceptance_item_count: targets.reduce(
      (count, target) =>
        count + target.result.inspection_lots.reduce(
          (items, lot) => items + lot.items.length,
          0,
        ),
      0,
    ),
    business_result_sha256: sha256Json(businessResult),
    target_manifests: targets.map(({ target_id, revision, manifest_sha256 }) => ({
      target_id,
      revision,
      manifest_sha256,
    })),
  };
  await atomicWriteJson(join(batchDirectory(options), "result.json"), businessResult);
  await atomicWriteJson(join(batchDirectory(options), "receipt.json"), receipt);
}

async function updateTargetCounts(
  workspace: RevisionWorkspace,
  target: BatchTarget,
): Promise<void> {
  const result = await readJson<AcceptanceResult>(workspace.resultPath);
  target.table_count = result.inspection_lots.length;
  target.row_count = result.inspection_lots.reduce(
    (count, lot) => count + lot.items.length,
    0,
  );
}

export async function runFullBatch(options: FullBatchOptions): Promise<FullBatchState> {
  options.signal?.throwIfAborted();
  if (
    !Number.isInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > 50
  ) {
    throw new Error("Full-run concurrency must be an integer between 1 and 50");
  }
  if (
    !Number.isInteger(options.maxAttempts)
    || options.maxAttempts < 1
    || options.maxAttempts > 20
  ) {
    throw new Error("Full-run maxAttempts must be an integer between 1 and 20");
  }
  const unselectedFreshTargetIds = options.freshTargetIds?.filter(id => !options.targetIds?.includes(id)) ?? [];
  if (unselectedFreshTargetIds.length) {
    throw new Error(`freshTargetIds must also be included in targetIds: ${unselectedFreshTargetIds.join(", ")}`);
  }
  return withBatchWriterLock(batchDirectory(options), () => runFullBatchLocked(options));
}

async function runFullBatchLocked(options: FullBatchOptions): Promise<FullBatchState> {
  options.signal?.throwIfAborted();
  const sourcePause = new ExternalSourcePause(options.signal);
  options = { ...options, signal: sourcePause.signal };
  let sourceWaiting: ExternalSourceRequest | undefined;
  const limits = targetAttemptLimits(options);
  const targetAllowlist = options.targetIds?.length
    ? new Set(options.targetIds)
    : undefined;
  const freshTargetAllowlist = options.freshTargetIds?.length
    ? new Set(options.freshTargetIds)
    : undefined;
  const state = await loadOrCreateState(options);
  const coverageControlSealedTargetIds = new Set<string>();
  for (const target of state.targets.filter((candidate) =>
    candidate.coverage_control?.kind === "coverage_controller_rebuild"
    && !freshTargetAllowlist?.has(candidate.target_id)
  )) {
    const controlled = await openBatchTargetWorkspace(options, target);
    const controlledState = await controlled.readState();
    if (controlledState.status !== "sealed" || !(await pathExists(controlled.manifestPath))) continue;
    target.status = "sealed";
    target.revision = controlled.revision;
    target.workdir = controlled.root;
    target.error = "";
    delete target.coverage_control;
    delete target.coverage_controller_recovery;
    delete target.last_blocker_code;
    target.last_failure_class = undefined;
    await updateTargetCounts(controlled, target);
    coverageControlSealedTargetIds.add(target.target_id);
  }
  for (const target of state.targets.filter(target => target.status === "sealed")) {
    const sealed = await openBatchTargetWorkspace(options, target);
    target.workdir = sealed.root;
  }
  if (targetAllowlist) {
    const knownTargetIds = new Set(state.targets.map((target) => target.target_id));
    const unknownTargetIds = [...targetAllowlist].filter((targetId) => !knownTargetIds.has(targetId));
    if (unknownTargetIds.length) {
      throw new Error(`Unknown targetIds requested for batch resume: ${unknownTargetIds.join(", ")}`);
    }
  }
  if (freshTargetAllowlist) {
    const knownTargetIds = new Set(state.targets.map((target) => target.target_id));
    const unknownFreshTargetIds = [...freshTargetAllowlist]
      .filter((targetId) => !knownTargetIds.has(targetId));
    if (unknownFreshTargetIds.length) {
      throw new Error(
        `Unknown freshTargetIds requested for batch resume: ${unknownFreshTargetIds.join(", ")}`,
      );
    }
    for (const target of state.targets) {
      if (!freshTargetAllowlist.has(target.target_id)) continue;
      target.attempt_counters = initialTargetAttemptCounters();
      delete target.coverage_control;
      delete target.coverage_controller_recovery;
      target.scope_extension_refresh_attempts = 0;
      delete target.transport_retry_window;
      target.error = "";
      delete target.last_blocker_code;
      delete target.last_failure_class;
    }
  }
  const pendingFreshTargetIds = new Set(freshTargetAllowlist ?? []);
  // 主证据范围要按条文收窄，得先有底账。读不到就退回原来的「目标行范围」路径。
  const batchLedger = await readJson<DocumentLedger>(ledgerPathFor(options)).catch(() => undefined);
  const discoveryWorkspace = (
    state.schema_version === "acceptance-full-batch/v2"
    || state.schema_version === "acceptance-full-batch/v3"
  )
    ? await DocumentDiscoveryWorkspace.openOrCreate(
        options.artifactRoot,
        options.jobId,
        options.markdownPath,
      )
    : undefined;
  const documentEvidence = discoveryWorkspace ? await discoveryWorkspace.readEvidence() : undefined;
  const layoutProfile = discoveryWorkspace && await pathExists(discoveryWorkspace.pdfLayoutProfilePath)
    ? await readJson<PdfLayoutProfile>(discoveryWorkspace.pdfLayoutProfilePath)
    : undefined;
  let stateWriteTail = Promise.resolve();
  const persist = async (): Promise<void> => {
    const previous = stateWriteTail;
    let release!: () => void;
    stateWriteTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      await atomicWriteJson(batchStatePath(options), state);
      await options.onStateChange?.(state);
    } finally {
      release();
    }
  };
  await options.onStateChange?.(state);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      options.signal?.throwIfAborted();
      const target = state.targets[cursor++];
      if (!target) return;
      if (!batchTargetSelected(target.target_id, options.targetIds)) continue;
      if (coverageControlSealedTargetIds.has(target.target_id)) continue;
      target.attempt_counters ??= initialTargetAttemptCounters();
      target.attempt_limits = limits;
      let pendingCoverageRepair = false;
      let pendingFreshAuthorRebuild = false;
      let scopeExtensionRecoveryUsed = false;
      // 死循环兜底：coverageRepairBudgetStatus 在「延续同一笔事务」时 available 恒真，
      // 而每轮修复提交后 coverage_recheck 又指向新的 last_valid_fingerprint，
      // 下一轮照样算延续——豁免自我延续等于没有上限。
      // 红笔名单两轮不变会先停（progress_window）；轮次天花板只是宽保险丝。
      let coverageRepairRounds = 0;
      const maxCoverageRepairRounds = Math.max(4, limits.coverage_repair_attempts * 3);
      while (true) {
        let transitionToCoverageRepair = false;
        let transitionToRepairSession = false;
        let transitionToCoverageControlPending = false;
        let transitionToFreshAuthorRebuild = false;
        let failureCounterRecorded = false;
        let attemptWorkspace: RevisionWorkspace | undefined;
        try {
          const fresh = pendingFreshTargetIds.has(target.target_id);
          if (fresh) {
            delete target.coverage_repair_observations;
            delete target.coverage_reviewer_miss_count;
            delete target.coverage_reviewer_miss_counts;
            delete target.progress_window;
          }
          const { workspace, resume, scopeExtensionRefreshed, scopeExtensionCheckpointRecovered } = await openOrCreateWorkspace(
            options,
            target,
            documentEvidence,
            fresh,
            batchLedger,
            state.targets as unknown as LedgerWindowTargetRef[],
            layoutProfile,
          );
          if (scopeExtensionRefreshed || scopeExtensionCheckpointRecovered) scopeExtensionRecoveryUsed = true;
          if (fresh) pendingFreshTargetIds.delete(target.target_id);
          if (scopeExtensionRefreshed) {
            target.scope_extension_refresh_attempts = (target.scope_extension_refresh_attempts ?? 0) + 1;
            target.attempt_counters.candidate_validation_attempts = 0;
            delete target.coverage_repair_observations;
            delete target.coverage_reviewer_miss_count;
            delete target.coverage_reviewer_miss_counts;
          }
          attemptWorkspace = workspace;
          target.revision = workspace.revision;
          target.workdir = workspace.root;
          const revisionState = await workspace.readState();
          const coverageControlResume = target.coverage_control?.kind === "coverage_controller_rebuild"
            ? target.coverage_control
            : undefined;
          if (
            revisionState.status === "sealed"
            && await pathExists(workspace.manifestPath)
          ) {
            target.status = "sealed";
            target.error = "";
            delete target.coverage_control;
            delete target.coverage_controller_recovery;
            target.last_failure_class = undefined;
            await updateTargetCounts(workspace, target);
            await persist();
            break;
          }
          const previousError = target.error;
          const previousFailureClass = coverageControlResume
            ? undefined
            : target.last_failure_class
            ?? (previousError ? classifyTargetFailure(previousError) : undefined);
          const recoveringLengthFailure = previousFailureClass === "transport"
            && /finish_reason=length/i.test(previousError);
          const recoveringTransportFailure = previousFailureClass === "transport"
            && !recoveringLengthFailure;
          const recoveringCoverageFailure = pendingCoverageRepair
            || previousFailureClass === "coverage_repair";
          pendingCoverageRepair = false;
          const freshAuthorRebuild = pendingFreshAuthorRebuild;
          pendingFreshAuthorRebuild = false;
          const recoveryReservation = coverageControllerRecoveryForWorkspace(target, workspace);
          let recoveryCoverageHandoff: Awaited<ReturnType<typeof runLivePi>> | undefined;
          if (recoveryReservation) {
            const recoveryFingerprint = revisionState.last_valid_fingerprint;
            const durableCandidate = /^[a-f0-9]{64}$/.test(recoveryFingerprint)
              && !(await durableCoverageCandidateChangeReceipt(workspace, recoveryFingerprint));
            if (durableCandidate) {
              recoveryCoverageHandoff = {
                session_id: "coverage-recovery-durable-candidate",
                session_file: "",
                sealed: false,
                model: "coverage-recovery-durable-candidate",
                review_required: true,
                review_plan_fingerprint: recoveryFingerprint,
              };
            } else if (!freshAuthorRebuild) {
              if (recoveringTransportFailure) {
                const durableCheckpoint = await targetDurableCheckpoint(workspace);
                const retryWindow = target.transport_retry_window;
                const trustedTransportRetry = recoveryReservation.phase === "fresh_author_transport_retry"
                  && target.last_failure_class === "transport"
                  && classifyTargetFailure(previousError) === "transport"
                  && retryWindow?.checkpoint === durableCheckpoint
                  && canRetryTargetFailure(
                    previousError,
                    target.attempt_counters,
                    limits,
                    retryWindow,
                    "transport",
                  );
                if (!trustedTransportRetry) {
                  target.status = "failed";
                  target.last_failure_class = "transport";
                  await workspace.appendEvent("coverage_candidate_rebuild_transport_stopped", {
                    job_id: workspace.jobId,
                    target_id: workspace.targetId,
                    revision: workspace.revision,
                    recovery_attempts: recoveryReservation.attempts,
                    checkpoint_matches: retryWindow?.checkpoint === durableCheckpoint,
                    transport_retry_available: false,
                    author_model_called: false,
                  });
                  break;
                }
              } else {
                target.status = "failed";
                target.last_failure_class = "coverage_harness_defect";
                target.error = "coverage_candidate_rebuild_stalled: persisted fresh-author reservation has no durable candidate or trusted transport continuation";
                await workspace.appendEvent("coverage_candidate_rebuild_stalled", {
                  job_id: workspace.jobId,
                  target_id: workspace.targetId,
                  revision: workspace.revision,
                  recovery_attempts: recoveryReservation.attempts,
                  author_model_called: false,
                  failure_budget_consumed: false,
                  required_action: "request_explicit_fresh_target_or_create_a_new_revision",
                });
                break;
              }
            }
          }
          const freshSessionRequired = recoveringTransportFailure
            || recoveringCoverageFailure
            || freshAuthorRebuild
            || /domain-content contract/i.test(previousError);
          target.status = "running";
          target.error = "";
          delete target.last_blocker_code;
          target.attempts += 1;
          await persist();
          const ledgerPath = join(
            options.artifactRoot,
            "jobs",
            encodedSegment(options.jobId),
            "discovery",
            "document-ledger.json",
          );
          let ledgerPrefill: { clause_item_count: number; table_item_count: number } | undefined;
          if (
            options.live
            && !recoveringCoverageFailure
            && !coverageControlResume
            && !freshAuthorRebuild
            && !recoveryCoverageHandoff
          ) {
            ledgerPrefill = await tryPrefillTargetSelectorsFromLedger({
              workspace,
              ledgerPath,
              markdownPath: options.markdownPath,
              target,
            });
          }
          const controller = await ToolController.create(workspace);
          if (options.externalSourceWorkflow) controller.externalSourceWorkflow = options.externalSourceWorkflow;
          if (options.revisionFeedback) controller.userFeedback = options.revisionFeedback;
          if (options.live) {
            if (ledgerPrefill) {
              const sealedPrefill = await trySealTargetFromLedgerPrefill({
                workspace,
                controller,
                target,
                ledgerPath,
                artifactRoot: options.artifactRoot,
                jobId: options.jobId,
                ledgerPrefill,
              });
              target.model = sealedPrefill.model;
              if (sealedPrefill.sealed) {
                target.status = "sealed";
                target.error = "";
              }
            }
            if (target.status !== "sealed") {
            const coverageResumeHandoff = coverageControlResume
              ? coverageControllerResumeHandoff(
                  coverageControlResume,
                  workspace,
                  revisionState.last_valid_fingerprint,
                )
              : undefined;
            if (coverageControlResume) {
              await workspace.appendEvent("coverage_review_controller_resume", {
                job_id: workspace.jobId,
                target_id: workspace.targetId,
                revision: workspace.revision,
                plan_fingerprint: coverageResumeHandoff?.review_plan_fingerprint ?? "",
                author_model_called: false,
                controlled_revision: coverageControlResume.revision,
                controlled_workdir: coverageControlResume.workdir,
                opened_workdir: workspace.root,
                same_workspace: resolve(coverageControlResume.workdir) === resolve(workspace.root),
                identity_verified: true,
              });
            }
            const result: Awaited<ReturnType<typeof runLivePi>> = coverageResumeHandoff
              ?? recoveryCoverageHandoff
              ?? await runLivePi(
                  workspace,
                  controller,
                  resume && !freshSessionRequired,
                  options.signal,
                  recoveringTransportFailure,
                  recoveringCoverageFailure,
                  options.modelConfig,
                );
            if (recoveryCoverageHandoff) {
              delete target.coverage_controller_recovery;
              await workspace.appendEvent("coverage_candidate_recovery_resumed_from_durable_candidate", {
                job_id: workspace.jobId,
                target_id: workspace.targetId,
                revision: workspace.revision,
                plan_fingerprint: recoveryCoverageHandoff.review_plan_fingerprint,
                author_model_called: false,
              });
            } else if (
              target.coverage_controller_recovery
              && result.review_required
              && result.review_plan_fingerprint
              && !(await durableCoverageCandidateChangeReceipt(
                workspace,
                result.review_plan_fingerprint,
              ))
            ) {
              delete target.coverage_controller_recovery;
              await workspace.appendEvent("coverage_candidate_recovery_committed", {
                job_id: workspace.jobId,
                target_id: workspace.targetId,
                revision: workspace.revision,
                plan_fingerprint: result.review_plan_fingerprint,
                author_model_called: true,
              });
            }
            target.model = result.model;
            if (result.waiting_for_source) {
              sourceWaiting = result.waiting_for_source;
              target.status = "pending";
              await persist();
              sourcePause.pause(sourceWaiting);
              break;
            }
            if (result.blocker_code) target.last_blocker_code = result.blocker_code;
            const postRunState = await workspace.readState();
            if (
              !coverageControlResume
              && result.review_required
              && (postRunState.target_review_protocol === "direct-validation/v1"
                || postRunState.target_review_protocol === "same-agent-self-review/v1")
            ) {
              target.status = "failed";
              target.last_failure_class = "coverage_harness_defect";
              target.error = "direct_validation_protocol_requested_legacy_coverage_handoff";
            } else if (result.review_required && result.review_plan_fingerprint) {
              let evidenceManifest = await workspace.readEvidenceManifest();
              let planViews = validateSemanticPlanViews(
                await readFile(workspace.lastValidPlanPath, "utf8"),
                evidenceManifest,
                { expected_fingerprint: result.review_plan_fingerprint },
              );
              const ledgerPath = join(
                options.artifactRoot,
                "jobs",
                encodedSegment(options.jobId),
                "discovery",
                "document-ledger.json",
              );
              // Initial semantic review is narrowed by a deterministic risk gate.
              // Clean leaves are reconciled mechanically from the immutable ledger/evidence
              // and never enter the model context; only suspicious leaves/evidence are reviewed.
              let coverageScope: CoverageReviewScope = {
                mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [],
              };
              let coverageRiskGate: CoverageRiskGateResult | undefined;
              let ledgerGapClauseIds: string[] = [];
              if (planViews.ok) {
                const materialized = materialize(
                  planViews.value.semantic_plan,
                  evidenceManifest,
                  result.review_plan_fingerprint,
                ).result;
                const materializedItems = materialized.inspection_lots.flatMap((lot) => lot.items);
                const fullObligations = coverageReviewObligations(
                  evidenceManifest,
                  planViews.value.semantic_plan,
                  { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
                );
                if (await pathExists(ledgerPath)) {
                  const ledger = await readJson<DocumentLedger>(ledgerPath);
                  const discoveryEvidencePath = join(
                    options.artifactRoot,
                    "jobs",
                    encodedSegment(options.jobId),
                    "discovery",
                    "document-evidence.json",
                  );
                  const discoveryAtoms = await pathExists(discoveryEvidencePath)
                    ? (await readJson<DocumentEvidence>(discoveryEvidencePath)).atoms
                    : [];
                  const gateWindow = targetLedgerLineWindow(ledger, target, discoveryAtoms);
                  if (gateWindow.window_id && !target.ledger_window_id) {
                    target.ledger_window_id = gateWindow.window_id;
                  }
                  const clauseIds = ledgerClauseIdSet(ledger);
                  const gateLineIndex = evidenceLineIndex(evidenceManifest.evidence);
                  const gateItems = materializedItems.map((item) => ({
                    item_id: item.item_id,
                    source_clause: resolveItemClauseId(item, clauseIds, ledger, gateLineIndex),
                    reference_source_clause: item.reference_source_clause,
                    reference_from_clause: item.reference_from_clause,
                  }));
                  const gateResult = targetLedgerCoverageWithFallback({
                    ledger,
                    window: gateWindow,
                    source_clauses: targetCoverageSourceClauses(gateItems),
                    inference_source_clauses: [...new Set(gateItems
                      .map((item) => item.source_clause)
                      .filter((value): value is string => Boolean(value)))],
                    not_item_clause_ids: await readDiscoveryContextClauses(ledgerPath),
                    evidence: evidenceManifest.evidence,
                    primary_source_ranges: evidenceManifest.scope.primary_source_ranges,
                  });
                  const ledgerCoverage = gateResult.coverage;
                  ledgerGapClauseIds = [...ledgerCoverage.gap_clause_ids];
                  const contaminatedItems = contaminatedItemIds({
                    ledger,
                    items: materializedItems,
                    lineIndex: gateLineIndex,
                  });
                  const unlabeledItemIds = gateItems
                    .filter((item) => !item.source_clause)
                    .map((item) => item.item_id);
                  const extraClauseIds = new Set(ledgerCoverage.extra_clause_ids);
                  const extraItemIds = gateItems
                    .filter((item) => item.source_clause && extraClauseIds.has(item.source_clause))
                    .map((item) => item.item_id);
                  if (contaminatedItems.length) {
                    await workspace.appendEvent("ledger_item_contamination", {
                      contaminated_item_ids: contaminatedItems,
                    });
                  }
                  await workspace.appendEvent("ledger_coverage_gate", {
                    ledger_window_id: gateWindow.window_id ?? "",
                    window_resolved: gateWindow.resolved,
                    start_line: gateWindow.start_line,
                    end_exclusive_line: gateWindow.end_exclusive_line,
                    required_clause_count: ledgerCoverage.required_clause_ids.length,
                    gap_clause_ids: ledgerCoverage.gap_clause_ids,
                    extra_clause_ids: ledgerCoverage.extra_clause_ids,
                    unlabeled_item_count: ledgerCoverage.unlabeled_item_count,
                    vacuous: ledgerCoverage.vacuous,
                    inferred_section_keys: gateResult.inferred_section_keys,
                    candidate_clause_count: ledgerCoverage.candidate_clause_ids.length,
                    unaccounted_candidate_clause_ids: ledgerCoverage.unaccounted_candidate_clause_ids,
                    skipped_review: false,
                    reason: "deterministic_reconciliation_precedes_semantic_risk_review",
                  });
                  coverageRiskGate = deriveCoverageRiskGate({
                    evidence: evidenceManifest,
                    items: materializedItems,
                    ledger_available: true,
                    ledger_scope_resolved: gateWindow.resolved,
                    ledger_vacuous: ledgerCoverage.vacuous,
                    ledger_scope_has_anomalies: ledger.anomalies.some((anomaly) =>
                      anomaly.line >= gateWindow.start_line && anomaly.line < gateWindow.end_exclusive_line
                    ),
                    unaccounted_candidate_clause_ids: ledgerCoverage.unaccounted_candidate_clause_ids,
                    gap_clause_ids: ledgerCoverage.gap_clause_ids,
                    gap_evidence_ids: ledgerCoverage.gap_evidence_ids,
                    extra_item_ids: extraItemIds,
                    unlabeled_item_ids: unlabeledItemIds,
                    contaminated_item_ids: contaminatedItems,
                    uncovered_primary_evidence_ids: fullObligations.uncovered_primary_evidence_ids,
                  });
                } else {
                  coverageRiskGate = deriveCoverageRiskGate({
                    evidence: evidenceManifest,
                    items: materializedItems,
                    ledger_available: false,
                    ledger_scope_resolved: false,
                    ledger_vacuous: false,
                    uncovered_primary_evidence_ids: fullObligations.uncovered_primary_evidence_ids,
                  });
                }
                coverageScope = {
                  ...coverageRiskGate.scope,
                  ...(ledgerGapClauseIds.length
                    ? { gap_clause_ids: ledgerGapClauseIds }
                    : {}),
                };
                await workspace.appendEvent("coverage_risk_gate", {
                  schema_version: coverageRiskGate.schema_version,
                  clean: coverageRiskGate.clean,
                  counts: coverageRiskGate.counts,
                  reason_codes: [...new Set(coverageRiskGate.reasons.map((reason) => reason.code))],
                  affected_item_ids: coverageRiskGate.scope.affected_item_ids,
                  affected_evidence_ids: coverageRiskGate.scope.affected_evidence_ids,
                });
                const persistedScope = coverageReviewScopeFromSealedState(
                  await workspace.readState(), result.review_plan_fingerprint,
                );
                const effectiveScope = coverageReviewScopeForRun(
                  coverageScope,
                  persistedScope,
                );
                coverageScope = effectiveScope;
                await workspace.appendEvent("ledger_coverage_scope", {
                  mode: effectiveScope.mode,
                  reason: effectiveScope.mode === "repair_delta"
                    ? "persisted_repair_delta"
                    : coverageRiskGate.clean
                      ? "deterministic_clean_auto_approval"
                      : "deterministic_risk_delta",
                  affected_item_ids: effectiveScope.affected_item_ids,
                  affected_evidence_count: effectiveScope.affected_evidence_ids.length,
                });
              }
              {
                const persistedScope = coverageReviewScopeFromSealedState(
                  await workspace.readState(), result.review_plan_fingerprint,
                );
                const deterministicClean = coverageRiskGate?.clean === true
                  && persistedScope.mode !== "repair_delta";
                let coverage: LiveCoverageReviewResult;
                let coveragePlanFingerprint = result.review_plan_fingerprint;
                let coverageAuthorRebuildRequired = false;
                if (deterministicClean) {
                  const deterministicCoverage = await sealDeterministicCleanCoverageReview(
                    workspace,
                    result.review_plan_fingerprint,
                    coverageScope,
                  );
                  if (deterministicCoverage.sealed && deterministicCoverage.review) {
                    coverage = deterministicCoverage;
                  } else {
                    await workspace.appendEvent("coverage_risk_gate_auto_approval_fallback", {
                      error: deterministicCoverage.error ?? "deterministic_clean_coverage_not_sealed",
                      fallback_scope: "full",
                    });
                    const coverageRun = await runCoverageReviewWithBoundedControllerRebuild(
                      workspace,
                      result.review_plan_fingerprint,
                      options.signal,
                      { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
                      options.modelConfig,
                    );
                    coverage = coverageRun.coverage;
                    coveragePlanFingerprint = coverageRun.plan_fingerprint;
                    coverageScope = coverageRun.scope;
                    coverageAuthorRebuildRequired = coverageRun.author_rebuild_required === true;
                  }
                } else {
                  const coverageRun = await runCoverageReviewWithBoundedControllerRebuild(
                    workspace,
                    result.review_plan_fingerprint,
                    options.signal,
                    coverageScope,
                    options.modelConfig,
                  );
                  coverage = coverageRun.coverage;
                  coveragePlanFingerprint = coverageRun.plan_fingerprint;
                  coverageScope = coverageRun.scope;
                  coverageAuthorRebuildRequired = coverageRun.author_rebuild_required === true;
                }
                if (!coverage.control && coveragePlanFingerprint !== result.review_plan_fingerprint) {
                  evidenceManifest = await workspace.readEvidenceManifest();
                  planViews = validateSemanticPlanViews(
                    await readFile(workspace.lastValidPlanPath, "utf8"),
                    evidenceManifest,
                    { expected_fingerprint: coveragePlanFingerprint },
                  );
                  if (!planViews.ok) {
                    throw new Error("coverage_controller_rebuild_current_candidate_unreadable");
                  }
                  await workspace.appendEvent("coverage_review_current_candidate_loaded", {
                    job_id: workspace.jobId,
                    target_id: workspace.targetId,
                    revision: workspace.revision,
                    previous_plan_fingerprint: result.review_plan_fingerprint,
                    current_plan_fingerprint: coveragePlanFingerprint,
                  });
                }
                target.model = `${result.model} + coverage-review:${coverage.model}`;
                const pendingControl = coverageAuthorRebuildRequired
                  ? undefined
                  : coverageControllerPendingTargetPatch(
                  coverage,
                  coveragePlanFingerprint,
                  workspace,
                );
                if (coverageAuthorRebuildRequired) {
                  delete target.coverage_control;
                  const currentRecovery = coverageControllerRecoveryForWorkspace(target, workspace);
                  const recoveryAttempts = currentRecovery?.attempts ?? 0;
                  if (recoveryAttempts >= 1) {
                    target.status = "failed";
                    target.last_failure_class = "coverage_harness_defect";
                    target.error = "coverage_candidate_rebuild_stalled: fresh author rebuilt the same revision without producing a durable candidate";
                    failureCounterRecorded = true;
                    await workspace.appendEvent("coverage_candidate_rebuild_stalled", {
                      job_id: workspace.jobId,
                      target_id: workspace.targetId,
                      revision: workspace.revision,
                      recovery_attempts: recoveryAttempts,
                      author_model_called: false,
                      failure_budget_consumed: false,
                      required_action: "inspect_validation_receipt_and_candidate_commit_transaction",
                    });
                  } else {
                    target.coverage_controller_recovery = {
                      schema_version: "coverage-controller-recovery/v2",
                      job_id: workspace.jobId,
                      target_id: workspace.targetId,
                      revision: workspace.revision,
                      workdir: workspace.root,
                      phase: "fresh_author_reserved",
                      attempts: recoveryAttempts + 1,
                      last_plan_fingerprint: coveragePlanFingerprint,
                    };
                    target.status = "running";
                    target.error = "";
                    target.last_failure_class = undefined;
                    transitionToFreshAuthorRebuild = true;
                    await workspace.appendEvent("coverage_candidate_fresh_author_handoff", {
                      job_id: workspace.jobId,
                      target_id: workspace.targetId,
                      revision: workspace.revision,
                      recovery_attempts: recoveryAttempts + 1,
                      author_model_called: false,
                      fresh_author_session_required: true,
                      failure_budget_consumed: false,
                    });
                  }
                } else if (pendingControl) {
                  Object.assign(target, pendingControl);
                  target.last_failure_class = undefined;
                  transitionToCoverageControlPending = true;
                  await workspace.appendEvent("coverage_review_controller_pending", {
                    job_id: workspace.jobId,
                    target_id: workspace.targetId,
                    revision: workspace.revision,
                    plan_fingerprint: pendingControl.coverage_control.plan_fingerprint,
                    error: pendingControl.error,
                    failure_class: "control",
                    retryable_same_job: true,
                    author_model_called: false,
                  });
                } else if (!coverage.sealed || !coverage.review) {
                  delete target.coverage_control;
                  target.status = "failed";
                  target.error = coverage.error ?? "independent coverage reviewer ended without sealing";
                } else if (coverage.review.status === "harness_defect") {
                  delete target.coverage_control;
                  target.status = "failed";
                  target.last_failure_class = "coverage_harness_defect";
                  target.error = `coverage_harness_defect: ${coverage.review.summary}; findings=${JSON.stringify(coverage.review.findings)}`;
                } else if (coverage.review.status === "repair") {
                  delete target.coverage_control;
                  if (!planViews.ok) {
                    throw new Error("Coverage repair observation requires the validated semantic plan view");
                  }
                  const observations = target.coverage_repair_observations ?? [];
                  const observation = coverageRepairObservation(
                    planViews.value.semantic_plan,
                    evidenceManifest,
                    coveragePlanFingerprint,
                    coverage.review,
                  );
                  if (!observations.some((entry) => entry.plan_fingerprint === observation.plan_fingerprint)) {
                    observations.push(observation);
                  }
                  target.coverage_repair_observations = observations.slice(-8);
                  const nonConvergence = detectCoverageRepairContractNonConvergence(
                    target.coverage_repair_observations,
                  );
                  const reviewerMissedFindings = coverage.review.findings.filter((finding) =>
                    finding.finding_origin === "reviewer_missed_preexisting"
                  );
                  const reviewerMissTracking = recordCoverageReviewerMisses(
                    target.coverage_reviewer_miss_counts,
                    coverage.review.findings,
                  );
                  if (Object.keys(reviewerMissTracking.counts).length > 0) {
                    target.coverage_reviewer_miss_counts = reviewerMissTracking.counts;
                    target.coverage_reviewer_miss_count = reviewerMissTracking.max_count;
                  }
                  if (reviewerMissedFindings.length > 0) {
                    await workspace.appendEvent("coverage_reviewer_missed_preexisting", {
                      miss_count: target.coverage_reviewer_miss_count,
                      miss_identities: reviewerMissTracking.current_miss_identities,
                      judgment_ids: [...new Set(reviewerMissedFindings.map((finding) => finding.judgment_id ?? ""))]
                        .filter(Boolean),
                      finding_ids: reviewerMissedFindings.map((finding) => finding.finding_id),
                      target_repair_round_consumed: false,
                    });
                  }
                  const repeatedMissIdentitySet = new Set(reviewerMissTracking.repeated_miss_identities);
                  const repeatedMissedFindings = reviewerMissedFindings.filter((finding) =>
                    repeatedMissIdentitySet.has(coverageReviewerMissIdentity(finding))
                  );
                  const reviewerIncomplete = repeatedMissedFindings.length > 0;
                  if (nonConvergence || reviewerIncomplete) {
                    target.status = "failed";
                    target.last_failure_class = "coverage_harness_defect";
                    target.error = nonConvergence
                      ? `coverage_repair_contract_nonconvergence: ${nonConvergence.kind}; judgments=${JSON.stringify(nonConvergence.judgment_ids)}; findings=${JSON.stringify(coverage.review.findings)}`
                      : `coverage_reviewer_incomplete_worklist: repeated reviewer_missed_preexisting; findings=${JSON.stringify(coverage.review.findings)}`;
                    await workspace.appendEvent(nonConvergence
                      ? "coverage_repair_contract_nonconvergence"
                      : "coverage_reviewer_incomplete_worklist", {
                      kind: nonConvergence?.kind ?? "repeated_reviewer_miss",
                      judgment_ids: nonConvergence?.judgment_ids
                        ?? [...new Set(repeatedMissedFindings.map((finding) => finding.judgment_id ?? ""))].filter(Boolean),
                      reviewer_miss_identities: reviewerMissTracking.repeated_miss_identities,
                      observations: target.coverage_repair_observations,
                      action: "stop_new_reviewer_sessions_and_report_contract_expression_failure",
                    });
                    if ((await workspace.readState()).status === "working") {
                      await workspace.markTerminal("failed", target.error);
                    }
                  } else {
                    const currentRevisionState = await workspace.readState();
                    const repairBudget = coverageRepairBudgetStatus(
                      currentRevisionState,
                      coveragePlanFingerprint,
                      limits.coverage_repair_attempts,
                    );
                    const progress = recordProgressRound(
                      target.progress_window,
                      coverageRepairProgressSnapshot(observation),
                    );
                    target.progress_window = progress.window;
                    const countedRound = reviewerMissedFindings.length === 0
                      ? coverageRepairRounds + 1
                      : coverageRepairRounds;
                    const halt = coverageRepairShouldHalt({
                      continuingTransaction: repairBudget.continuing_transaction,
                      budgetAvailable: repairBudget.available,
                      roundsExhausted: countedRound >= maxCoverageRepairRounds,
                      progressStop: progress.stop,
                    });
                    if (!halt.halt) {
                      if (reviewerMissedFindings.length === 0) coverageRepairRounds = countedRound;
                      if (!repairBudget.continuing_transaction && reviewerMissedFindings.length === 0) {
                        target.attempt_counters.coverage_repair_attempts += 1;
                        failureCounterRecorded = true;
                      }
                      if (!repairBudget.continuing_transaction) {
                        await controller.beginCoverageRepair(coveragePlanFingerprint);
                      }
                      target.status = "running";
                      target.error = "";
                      target.last_failure_class = undefined;
                      transitionToCoverageRepair = true;
                    } else if (halt.reason === "progress_stalled") {
                      target.status = "failed";
                      target.last_failure_class = "coverage_harness_defect";
                      target.error = `target_progress_stalled: ${progress.reason}; consecutive_unchanged=${progress.window.consecutive_unchanged}; findings=${JSON.stringify(coverage.review.findings)}`;
                      await workspace.appendEvent("target_progress_stalled", {
                        reason: progress.reason,
                        consecutive_unchanged: progress.window.consecutive_unchanged,
                        observation,
                        action: "stop_coverage_repair_without_new_revision",
                      });
                      if ((await workspace.readState()).status === "working") {
                        await workspace.markTerminal("failed", target.error);
                      }
                    } else {
                      if (reviewerMissedFindings.length === 0) coverageRepairRounds = countedRound;
                      if (!repairBudget.continuing_transaction && reviewerMissedFindings.length === 0) {
                        target.attempt_counters.coverage_repair_attempts += 1;
                        failureCounterRecorded = true;
                      }
                      target.status = "failed";
                      target.last_failure_class = "coverage_repair";
                      target.error = `domain_coverage_repair_required: current revision exhausted coverage repair budget (committed ${repairBudget.committed_repairs}/${limits.coverage_repair_attempts}, rounds ${coverageRepairRounds}/${maxCoverageRepairRounds}); ${coverage.review.summary}; findings=${JSON.stringify(coverage.review.findings)}`;
                    }
                  }
                } else {
                  delete target.coverage_control;
                  const sealed = await controller.dispatch("seal_validated_plan", {
                    fingerprint: coveragePlanFingerprint,
                  });
                  target.status = sealed.ok ? "sealed" : "failed";
                  target.error = sealed.ok ? "" : JSON.stringify(sealed);
                }
              }
            } else {
              target.error = result.sealed ? "" : result.error ?? "";
              target.status = result.sealed ? "sealed" : "failed";
              if (!result.sealed && isRepairSessionRestartRequired(target.error)) {
                const repair = await controller.repairStatus();
                if (canTransitionToFreshSessionRestart(
                  repair,
                  target.error,
                  limits.candidate_validation_attempts,
                )) {
                  target.status = "running";
                  target.error = "";
                  target.last_failure_class = undefined;
                  transitionToRepairSession = true;
                } else {
                  target.error = `repair_session_restart_exhausted: validation repair still requires a fresh session after ${repair.repair_session_restarts} bounded repair restarts (session_epoch=${repair.session_epoch})`;
                }
              }
            }
            if (
              !transitionToCoverageRepair
              && !transitionToRepairSession
              && !transitionToCoverageControlPending
              && !transitionToFreshAuthorRebuild
              && !failureCounterRecorded
              && target.status !== "sealed"
            ) {
              const failureClass = classifyTargetFailure(target.error, result.failure_class);
              target.last_failure_class = failureClass;
              if (failureClass === "transport") {
                markCoverageControllerRecoveryTransportRetry(target, workspace);
                target.attempt_counters.transport_attempts += 1;
                target.transport_retry_window = recordTransportFailure(
                  target.transport_retry_window,
                  await targetDurableCheckpoint(workspace),
                  target.error,
                );
              }
              else if (failureClass === "coverage_repair") target.attempt_counters.coverage_repair_attempts += 1;
              else if (failureClass === "candidate") target.attempt_counters.candidate_validation_attempts += 1;
            }
            }
          } else {
            const result = await runOfflineFixture(workspace, controller);
            target.status = result.ok ? "sealed" : "failed";
            target.model = "offline-scripted";
            target.error = result.ok ? "" : JSON.stringify(result);
            if (!result.ok) {
              target.last_failure_class = "candidate";
              target.attempt_counters.candidate_validation_attempts += 1;
            }
          }
          if (target.status === "sealed") {
            delete target.last_blocker_code;
            delete target.coverage_control;
            delete target.coverage_controller_recovery;
            target.last_failure_class = undefined;
            await updateTargetCounts(workspace, target);
          }
        } catch (error) {
          if (
            options.signal?.aborted
            || (error !== null && typeof error === "object" && (error as { name?: unknown }).name === "AbortError")
          ) {
            throw error;
          }
          target.status = "failed";
          delete target.coverage_control;
          target.error = error instanceof Error ? error.message : String(error);
          const failureClass = classifyTargetFailure(target.error);
          target.last_failure_class = failureClass;
          if (
            attemptWorkspace
            && /\btarget_selector_resume_(?:checkpoint_missing|evidence_mismatch)\b/iu.test(target.error)
            && (await attemptWorkspace.readState()).status === "working"
          ) {
            await attemptWorkspace.markTerminal("failed", target.error);
          }
          if (failureClass === "transport") {
            if (attemptWorkspace) markCoverageControllerRecoveryTransportRetry(target, attemptWorkspace);
            target.attempt_counters.transport_attempts += 1;
            target.transport_retry_window = recordTransportFailure(
              target.transport_retry_window,
              attemptWorkspace
                ? await targetDurableCheckpoint(attemptWorkspace)
                : `workspace-unavailable:${target.revision}`,
              target.error,
            );
          }
          else if (failureClass === "coverage_repair") target.attempt_counters.coverage_repair_attempts += 1;
          else if (failureClass === "candidate") target.attempt_counters.candidate_validation_attempts += 1;
        }
        if (transitionToCoverageControlPending) {
          await persist();
          break;
        }
        if (transitionToCoverageRepair || transitionToRepairSession || transitionToFreshAuthorRebuild) {
          pendingCoverageRepair = transitionToCoverageRepair;
          pendingFreshAuthorRebuild = transitionToFreshAuthorRebuild;
          await persist();
          continue;
        }
        await persist();
        if (target.status === "sealed") break;
        if (
          (target.last_failure_class ?? classifyTargetFailure(target.error)) === "scope_extension"
          // A workspace-open failure cannot be fixed by immediately reopening it;
          // a restored checkpoint also must not grant an unbounded revision loop.
          && attemptWorkspace && !scopeExtensionRecoveryUsed
          && (target.scope_extension_refresh_attempts ?? 0) < 1
          && Boolean(target.evidence_atom_ids?.length)
          && documentEvidence
        ) {
          continue;
        }
        const canRetry = canRetryTargetFailure(
          target.error,
          target.attempt_counters,
          limits,
          target.transport_retry_window,
          target.last_failure_class,
        );
        const transportFailure = target.last_failure_class === "transport";
        const consecutiveFailures = target.transport_retry_window?.consecutive_failures
          ?? target.attempt_counters.transport_attempts;
        const delayMs = transportFailure && canRetry
          ? targetTransportRetryDelayMs(target.error, consecutiveFailures) : undefined;
        if (transportFailure && attemptWorkspace) {
          await attemptWorkspace.appendEvent(canRetry
            ? "target_transport_retry_scheduled" : "target_transport_retry_exhausted", {
            error: target.error,
            failure_class: "transport",
            consecutive_failures: consecutiveFailures,
            error_key: target.transport_retry_window?.error_key,
            transport_retries: limits.transport_retries,
            lifetime_transport_failures: target.attempt_counters.transport_attempts,
            checkpoint: target.transport_retry_window?.checkpoint,
            ...(canRetry ? { retry_number: consecutiveFailures, delay_ms: delayMs } : {}),
            instruction: canRetry
              ? "网络请求失败，等待后从当前持久化草稿续跑；不消耗语义修复预算，不修改证据或已封存结果。"
              : "同类网络错误在同一持久化进度连续发生，续跑额度已耗尽；停止自动重试并保留草稿。请先检查接口连通性，恢复后显式续跑该 target，不要修改 selector 或证据来绕过网络错误。",
          });
        }
        if (!canRetry) break;
        await retryBackoff(target.error, options.signal, delayMs);
      }
      if (target.status !== "sealed" && !target.coverage_control) target.status = "failed";
      await persist();
    }
  };
  // Keep the job lock until every worker has stopped, even when one aborts.
  sourceWaiting = await sourcePause.finish(Array.from({ length: options.concurrency }, () => worker()));
  if (sourceWaiting) {
    for (const target of state.targets) if (target.status === "running") target.status = "pending";
    state.status = "waiting_for_source";
    state.waiting_for_source = sourceWaiting;
    await persist();
    return state;
  }
  delete state.waiting_for_source;
  const allSealed = state.targets.every((target) => target.status === "sealed");
  const sealedTargets = await collectSealedTargets(options, state);
  const { reconciliation, gap } = state.targets.length === 0 && state.discovery?.no_target_reason
    ? { reconciliation: undefined, gap: undefined }
    : await evaluateBatchLedgerGap(options, state, sealedTargets);
  delete state.ledger_gap;
  // 有 target 没封存时失败原因已经在 target 上，缺口是它的后果而不是独立结论——只记录不加判。
  if (gap && allSealed) state.ledger_gap = gap;
  const coverageControlPending = state.targets.some((target) =>
    target.status === "pending" && target.coverage_control?.kind === "coverage_controller_rebuild"
  );
  state.status = allSealed && !gap ? "passed" : coverageControlPending ? "running" : "failed";
  await persist();
  await aggregate(options, state, sealedTargets, reconciliation);
  return state;
}

export async function readFullBatch(
  artifactRoot: string,
  jobId: string,
): Promise<FullBatchState> {
  return readJson<FullBatchState>(
    join(artifactRoot, "jobs", encodedSegment(jobId), "batch.json"),
  );
}

/** Refresh a partial snapshot without entering discovery, revision recovery or an Agent. */
export async function refreshFullBatchSummary(artifactRoot: string, jobId: string): Promise<void> {
  const options = { artifactRoot, jobId };
  await withBatchWriterLock(batchDirectory(options), async () => {
    const state = await readFullBatch(artifactRoot, jobId);
    const targets = await collectSealedTargets(options, state);
    await aggregate(options, state, targets, undefined);
  });
}
