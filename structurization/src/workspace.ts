import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canAnchorStaticTableReference,
  referenceOccurrenceLiteralSpanIds,
  referenceOccurrenceLiterals,
  referenceOccurrenceOriginEvidenceIds,
  sameLogicalReferenceOccurrence,
  type EvidenceManifest,
  type ReferenceOccurrence,
  type RevisionState,
  type SemanticSourcePlan,
  type TranscriptEvent,
} from "./contracts.js";
import {
  appendText,
  atomicWriteJson,
  atomicWriteNewBytes,
  atomicWriteNewText,
  atomicWriteText,
  makeReadOnly,
  pathExists,
  readJson,
} from "./atomic.js";
import { buildEvidenceManifest, buildStructuredTargetEvidence } from "./evidence.js";
import { buildReferenceScopeEvidence } from "./document-reference.js";
import { ledgerWithCurrentClauseBoundaries, type DocumentLedger } from "./document-ledger.js";
import { externalReferenceExpansionPolicy, externalReferenceFieldPolicy } from "./external-reference-policy.js";
import { normalizeStandardNo, standardIdentityMatches, type ExternalSourceWorkflow } from "./external-source-workflow.js";
import { ModelSourceHandles } from "./model-source-handles.js";
import { prettyJson, sha256Json, sha256Text } from "./canonical.js";
import { buildPlanContract } from "./source-plan-contract.js";
import { preparePersistedPlanForWorking } from "./plan-migration.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  migrateTargetSelectorPlanForAuthoring,
  SOURCE_SPAN_ID_PATTERN,
  targetSelectorFingerprint,
} from "./target-selector-compiler.js";
import { hydrateSemanticSourcePlan } from "./plan-hydration.js";
import { checkTargetCompilerInvariants } from "./target-compiler-invariants.js";
import { classifyCompilerInvariantIssues } from "./selector-issue-ownership.js";
import { selectorCompilerAcceptedReviews } from "./selector-compiler-context.js";
import { STRUCTURAL_VALIDATION_BOUNDARY } from "./validation-boundary.js";
import {
  pendingComplexTableStructureIssues,
  validateTableStructurePlan,
  type TableStructurePlan,
} from "./table-structure.js";
import {
  registryWithFullSourceSpans,
  registerSourceSpan,
  resolveSourceSpan,
  type SourceSpanRegistry,
} from "./source-span-registry.js";

function registryForManifest(manifest: EvidenceManifest): SourceSpanRegistry {
  const sources = manifest.evidence.map((record) => ({
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.evidence_id,
    text: record.text,
  }));
  return registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
}

export function coverageRepairAllowsExternalDependency(state: RevisionState): boolean {
  return state.status === "working"
    && state.selector_stage === "coverage_repair"
    && state.repair !== undefined
    && ["repair", "modeling"].includes(state.repair?.mode ?? "")
    && state.repair.repair_source === "coverage"
    && Boolean(state.repair.coverage_review_fingerprint)
    && (state.repair.coverage_finding_ids?.length ?? 0) > 0
    && state.last_valid_fingerprint === ""
    && state.last_valid_plan_sha256 === "";
}

const SOURCE_SPAN_ID = new RegExp(SOURCE_SPAN_ID_PATTERN, "u");

function selectorReferencedSpanIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (child: unknown, key = ""): void => {
    if (Array.isArray(child)) {
      if (key === "span_ids" || key.endsWith("_span_ids")) {
        for (const entry of child) {
          if (typeof entry === "string" && SOURCE_SPAN_ID.test(entry)) ids.add(entry);
        }
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

function mergeSelectorOpenedEvidenceIds(
  existingEvidenceIds: string[],
  selectors: unknown,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): string[] {
  const referencedSpanIds = new Set(selectorReferencedSpanIds(selectors));
  const manifestEvidenceIds = new Set(manifest.evidence.map((record) => record.evidence_id));
  const openedEvidenceIds = new Set(existingEvidenceIds.filter((evidenceId) =>
    manifestEvidenceIds.has(evidenceId)
  ));
  for (const span of registry.spans) {
    if (
      referencedSpanIds.has(span.span_id)
      && manifestEvidenceIds.has(span.evidence_id)
    ) {
      openedEvidenceIds.add(span.evidence_id);
    }
  }
  return [...openedEvidenceIds].sort();
}

const WRITABLE_ROOT_NAMES = new Set([
  "working.semantic-source-plan.json",
  "working.target-selectors.json",
  "selector-diagnostics.json",
  "selector-repair-work.json",
  "best.target-selectors.json",
  "source-span-registry.json",
  "last-valid.semantic-source-plan.json",
  "last-valid.target-selectors.json",
  "target-selectors.json",
  "selector-compiler-context.json",
  "state.json",
  "session.events.jsonl",
  "semantic-source-plan.json",
  "table-assembly-plan.json",
  "result.json",
  "provenance.json",
  "validation-receipt.json",
  "seal-receipt.json",
  "manifest.json",
]);
const WRITABLE_DIRECTORIES = new Set([
  "history",
  "validation",
  "pi-session",
  "coverage-review",
]);

function encodedSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return encodeURIComponent(normalized).replaceAll("%", "_");
}

export function assertDescendant(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (
    rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) {
    throw new Error(`Path escapes allowed root: ${candidate}`);
  }
  return resolvedCandidate;
}

function initialPlan(manifest: EvidenceManifest): SemanticSourcePlan {
  return buildPlanContract(manifest).plan_template;
}

function initialState(revision: number): RevisionState {
  return {
    schema_version: "revision-state/v1",
    revision,
    status: "working",
    next_event_sequence: 1,
    next_history_sequence: 1,
    next_validation_sequence: 1,
    validation_attempts: 0,
    last_valid_fingerprint: "",
    last_valid_plan_sha256: "",
    opened_evidence_ids: [],
    opened_evidence_window_keys: [],
    opened_global_resource_ids: [],
    document_reference_reads: {},
    selector_stage: "primary",
    selector_batch_requires_stage: false,
    selector_protocol: {
      submissions: 0,
      corrections: 0,
      coverage_repairs: 0,
      transport_failures: 0,
      protocol_failures: 0,
      last_transport_failure: "",
      last_protocol_failure: "",
      last_issue_owner: "",
      last_issue_fingerprint: "",
      best_draft_fingerprint: "",
      best_history_sequence: 0,
      best_preflight_stage_rank: 0,
      best_issue_count: null,
      best_issue_fingerprint: "",
      consecutive_non_improvements: 0,
    },
    repair: {
      mode: "modeling",
      repair_source: "validation",
      active_cluster: null,
      total_issue_count: 0,
      validation_fingerprint: "",
      coverage_review_fingerprint: "",
      coverage_finding_ids: [],
      coverage_evidence_ids: [],
      coverage_item_ids: [],
      non_converging_rounds: 0,
      fresh_session_required: false,
      session_epoch: 0,
      repair_session_restarts: 0,
    },
    agent_runtime: {
      kind: "unassigned",
      session_id: "",
      session_file: "",
    },
  };
}

function revisionsRoot(artifactRoot: string, jobId: string, targetId: string): string {
  return join(
    artifactRoot,
    "jobs",
    encodedSegment(jobId, "job"),
    "targets",
    encodedSegment(targetId, "target"),
    "revisions",
  );
}

async function nextRevisionNumber(root: string): Promise<number> {
  if (!(await pathExists(root))) {
    return 1;
  }
  const values = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
    .map((entry) => Number(entry.name));
  return values.length ? Math.max(...values) + 1 : 1;
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  if (!(await pathExists(source))) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: entry.isDirectory(),
      force: false,
      errorOnExist: true,
    });
  }
}

async function makeExistingWritableRootArtifacts(root: string): Promise<void> {
  for (const name of WRITABLE_ROOT_NAMES) {
    const path = join(root, name);
    if (await pathExists(path)) await chmod(path, 0o644);
  }
}

async function copySelectorRepairWork(sourceRoot: string, destinationRoot: string): Promise<void> {
  const source = join(sourceRoot, "selector-repair-work.json");
  if (!(await pathExists(source))) return;
  const destination = join(destinationRoot, "selector-repair-work.json");
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}

export class RevisionWorkspace {
  readonly evidenceDirectory: string;
  readonly evidenceManifestPath: string;
  readonly evidenceScopePath: string;
  readonly sourceMarkdownPath: string;
  readonly sourcePdfPath: string;
  readonly workingPlanPath: string;
  readonly workingSelectorPath: string;
  readonly bestSelectorPath: string;
  readonly sourceSpanRegistryPath: string;
  readonly lastValidPlanPath: string;
  readonly lastValidSelectorPath: string;
  readonly sealedSelectorPath: string;
  readonly selectorCompilerContextPath: string;
  readonly sealedPlanPath: string;
  readonly tableAssemblyPlanPath: string;
  readonly resultPath: string;
  readonly provenancePath: string;
  readonly validationReceiptPath: string;
  readonly sealReceiptPath: string;
  readonly manifestPath: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  readonly historyDirectory: string;
  readonly validationDirectory: string;
  readonly piSessionDirectory: string;
  readonly coverageReviewDirectory: string;
  readonly documentLedgerPath: string;
  readonly discoverySealReceiptPath: string;
  readonly batchTargetPath: string;
  private stateMutationTail: Promise<void> = Promise.resolve();

  private constructor(
    public readonly root: string,
    public readonly artifactRoot: string,
    public readonly jobId: string,
    public readonly targetId: string,
    public readonly revision: number,
  ) {
    this.evidenceDirectory = join(root, "evidence");
    this.evidenceManifestPath = join(this.evidenceDirectory, "evidence.json");
    this.evidenceScopePath = join(this.evidenceDirectory, "scope.json");
    this.sourceMarkdownPath = join(this.evidenceDirectory, "source.md");
    this.sourcePdfPath = join(this.evidenceDirectory, "source.pdf");
    this.workingPlanPath = join(root, "working.semantic-source-plan.json");
    this.workingSelectorPath = join(root, "working.target-selectors.json");
    this.bestSelectorPath = join(root, "best.target-selectors.json");
    this.sourceSpanRegistryPath = join(root, "source-span-registry.json");
    this.lastValidPlanPath = join(root, "last-valid.semantic-source-plan.json");
    this.lastValidSelectorPath = join(root, "last-valid.target-selectors.json");
    this.sealedSelectorPath = join(root, "target-selectors.json");
    this.selectorCompilerContextPath = join(root, "selector-compiler-context.json");
    this.sealedPlanPath = join(root, "semantic-source-plan.json");
    this.tableAssemblyPlanPath = join(root, "table-assembly-plan.json");
    this.resultPath = join(root, "result.json");
    this.provenancePath = join(root, "provenance.json");
    this.validationReceiptPath = join(root, "validation-receipt.json");
    this.sealReceiptPath = join(root, "seal-receipt.json");
    this.manifestPath = join(root, "manifest.json");
    this.transcriptPath = join(root, "session.events.jsonl");
    this.statePath = join(root, "state.json");
    this.historyDirectory = join(root, "history");
    this.validationDirectory = join(root, "validation");
    this.piSessionDirectory = join(root, "pi-session");
    this.coverageReviewDirectory = join(root, "coverage-review");
    this.documentLedgerPath = join(
      artifactRoot,
      "jobs",
      encodedSegment(jobId, "job"),
      "discovery",
      "document-ledger.json",
    );
    this.discoverySealReceiptPath = join(
      artifactRoot,
      "jobs",
      encodedSegment(jobId, "job"),
      "discovery",
      "seal-receipt.json",
    );
    this.batchTargetPath = join(
      artifactRoot,
      "jobs",
      encodedSegment(jobId, "job"),
      "batch.json",
    );
  }

  private static async selectorCheckpointPath(
    workspace: RevisionWorkspace,
  ): Promise<string | undefined> {
    if (await pathExists(workspace.sealedSelectorPath)) return workspace.sealedSelectorPath;
    if (await pathExists(workspace.lastValidSelectorPath)) return workspace.lastValidSelectorPath;
    if (await pathExists(workspace.workingSelectorPath)) return workspace.workingSelectorPath;
    return undefined;
  }

  private static async nearestSealedAncestor(
    workspace: RevisionWorkspace,
  ): Promise<RevisionWorkspace | undefined> {
    const rootParent = revisionsRoot(workspace.artifactRoot, workspace.jobId, workspace.targetId);
    const entries = (await readdir(rootParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((revision) => revision < workspace.revision)
      .sort((left, right) => right - left);
    for (const revision of entries) {
      const candidate = new RevisionWorkspace(
        join(rootParent, String(revision).padStart(6, "0")),
        workspace.artifactRoot,
        workspace.jobId,
        workspace.targetId,
        revision,
      );
      if ((await candidate.readState()).status !== "sealed") continue;
      const selectorCheckpoint = await RevisionWorkspace.selectorCheckpointPath(candidate);
      if (!selectorCheckpoint || await RevisionWorkspace.hasUsableSelectorCheckpoint(candidate, selectorCheckpoint)) {
        return candidate;
      }
    }
    return undefined;
  }

  private static async hasTrustedTerminalSelectorCheckpoint(
    workspace: RevisionWorkspace,
  ): Promise<boolean> {
    if (
      !(await pathExists(workspace.lastValidSelectorPath))
      || !(await pathExists(workspace.lastValidPlanPath))
      || !(await pathExists(workspace.validationReceiptPath))
      || !(await pathExists(workspace.sourceSpanRegistryPath))
    ) return false;
    try {
      const selector = await readJson<unknown>(workspace.lastValidSelectorPath);
      const receipt = await readJson<Record<string, unknown>>(workspace.validationReceiptPath);
      return receipt.ok === true
        && typeof receipt.selector_fingerprint === "string"
        && receipt.selector_fingerprint.length > 0
        && receipt.selector_fingerprint === sha256Json(selector)
        && await RevisionWorkspace.hasUsableSelectorCheckpoint(
          workspace,
          workspace.lastValidSelectorPath,
        );
    } catch {
      return false;
    }
  }

  private static async hasUsableSelectorCheckpoint(
    workspace: RevisionWorkspace,
    selectorPath: string,
  ): Promise<boolean> {
    if (
      !(await pathExists(selectorPath))
      || !(await pathExists(workspace.sourceSpanRegistryPath))
    ) return false;
    try {
      const selector = migrateTargetSelectorPlanForAuthoring(
        await readJson<unknown>(selectorPath),
      ).plan;
      const registry = await readJson<SourceSpanRegistry>(workspace.sourceSpanRegistryPath);
      const manifest = await workspace.readEvidenceManifest();
      if (
        selector.job_id !== workspace.jobId
        || selector.target_id !== workspace.targetId
        || selector.lots.length === 0
        || selector.items.length === 0
        || !Array.isArray(registry.spans)
        || registry.source_fingerprint !== manifest.evidence_fingerprint
      ) return false;
      const sources = new Map(manifest.evidence.map((record) => [record.evidence_id, {
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      }]));
      const issues: Parameters<typeof resolveSourceSpan>[4] = [];
      for (const spanId of selectorReferencedSpanIds(selector)) {
        resolveSourceSpan(registry, spanId, sources, "/checkpoint", issues);
      }
      return issues.length === 0;
    } catch {
      return false;
    }
  }

  /** A session can be interrupted while reading, before its first authored record. */
  async hasUnstartedSelectorCheckpoint(): Promise<boolean> {
    try {
      const state = await this.readState();
      if ((state.selector_stage ?? "primary") !== "primary"
        || state.next_history_sequence !== 1 || state.validation_attempts !== 0
        || state.last_valid_fingerprint || state.last_valid_plan_sha256
        || (state.selector_protocol?.submissions ?? 0) !== 0
        || (state.selector_protocol?.corrections ?? 0) !== 0
        || (state.selector_protocol?.coverage_repairs ?? 0) !== 0
        || (state.repair?.mode ?? "modeling") !== "modeling"
        || state.lineage && state.lineage.recovery_kind !== "terminal_checkpoint") return false;
      if ((await readdir(this.historyDirectory)).some((name) => /^\d{6}\.json$/u.test(name))) return false;
      const manifest = await this.readEvidenceManifest();
      const selectors = await readJson<unknown>(this.workingSelectorPath);
      return sha256Json(selectors) === sha256Json(initialTargetSelectorPlan(manifest));
    } catch { return false; }
  }

  private static async trustedTerminalSelectorCheckpoint(
    workspace: RevisionWorkspace,
    state: RevisionState,
    resumeModelingPhaseBudget = false,
  ): Promise<{ path: string; source: "validated" | "best" | "inherited_unedited" | "coverage_repair" | "modeling_phase" | "compiler_replay" | "scope_extension_draft" | "unstarted" } | undefined> {
    if (state.terminal_reason?.startsWith("target_selector_resume_checkpoint_missing: resume ")
      && await workspace.hasUnstartedSelectorCheckpoint()) {
      return { path: workspace.workingSelectorPath, source: "unstarted" };
    }
    // An authoring-budget stop is still terminal by default. An explicit bounded
    // resume may preserve its exact unvalidated draft, never a passing marker.
    const prefix = "target_modeling_phase_budget_exceeded: ";
    const stageRetryCheckpoint = state.terminal_reason === "selector_stage_incomplete"
      ? state.selector_protocol?.stage_retries?.checkpoint : undefined;
    if (resumeModelingPhaseBudget && (state.terminal_reason?.startsWith(prefix) || stageRetryCheckpoint)
      && !state.last_valid_fingerprint && !state.last_valid_plan_sha256
      && (state.selector_protocol?.submissions ?? 0) === 0
      && ["primary", "sampling", "table", "commit"].includes(state.selector_stage ?? "primary")) {
      try {
        const diagnostic = stageRetryCheckpoint
          ? { durable_checkpoint: stageRetryCheckpoint }
          : JSON.parse(state.terminal_reason!.slice(prefix.length));
        const text = await readFile(workspace.workingSelectorPath, "utf8");
        const expected = { working_selector_sha256: sha256Text(text), history_sequence: state.next_history_sequence, selector_stage: state.selector_stage ?? "primary" };
        const saved = diagnostic.durable_checkpoint;
        if (saved?.working_selector_sha256 === expected.working_selector_sha256
          && saved.history_sequence === expected.history_sequence && saved.selector_stage === expected.selector_stage
          && saved.checkpoint_fingerprint === sha256Text(JSON.stringify(expected))
          && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.workingSelectorPath)) {
          const selectors = migrateTargetSelectorPlanForAuthoring(JSON.parse(text)).plan;
          const registry = await workspace.readSourceSpanRegistry();
          const manifest = await workspace.readEvidenceManifest();
          const sources = new Map(manifest.evidence.map(e => [e.evidence_id, { source_id: e.evidence_id, evidence_id: e.evidence_id, atom_id: e.evidence_id, text: e.text }]));
          const issues: Parameters<typeof resolveSourceSpan>[4] = [];
          for (const id of selectorReferencedSpanIds(selectors)) resolveSourceSpan(registry, id, sources, "/resume", issues);
          if (!issues.length) return { path: workspace.workingSelectorPath, source: "modeling_phase" };
        }
      } catch { /* An invalid or changed checkpoint is not an authorized resume source. */ }
    }
    const repairSource = state.repair?.coverage_review_fingerprint;
    if (state.selector_stage === "coverage_repair" && state.repair?.repair_source === "coverage" && repairSource
      && ["repair", "modeling"].includes(state.repair.mode)
      && await pathExists(join(workspace.coverageReviewDirectory, repairSource, "candidate.plan.json"))
      && await pathExists(join(workspace.coverageReviewDirectory, repairSource, "candidate.evidence.json"))
      && await pathExists(join(workspace.coverageReviewDirectory, repairSource, "coverage-review.json"))
      && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.workingSelectorPath)) {
      // This is an explicit, unvalidated repair draft, not a stale validated
      // submission. Preserve its pending edits and counters; sealing still
      // requires compilation and review against the adopted evidence.
      return { path: workspace.workingSelectorPath, source: "coverage_repair" };
    }
    if (await RevisionWorkspace.hasTrustedTerminalSelectorCheckpoint(workspace)) {
      return { path: workspace.lastValidSelectorPath, source: "validated" };
    }
    if (
      state.terminal_reason === "compiler_invariant_violation"
      && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.workingSelectorPath)
    ) {
      try {
        const selectors = migrateTargetSelectorPlanForAuthoring(
          await readJson<unknown>(workspace.workingSelectorPath),
        ).plan;
        const registry = await workspace.readSourceSpanRegistry();
        const manifest = await workspace.readEvidenceManifest();
        const tableStructurePath = join(workspace.root, "table-structure.json");
        const tableStructurePlan = await pathExists(tableStructurePath)
          ? await readJson<TableStructurePlan>(tableStructurePath)
          : undefined;
        if (tableStructurePlan) {
          const tableIssues = [
            ...validateTableStructurePlan(tableStructurePlan, manifest, registry),
            ...pendingComplexTableStructureIssues(tableStructurePlan, manifest),
          ];
          if (tableIssues.length > 0) throw new Error("compiler replay table structure is not complete");
        }
        const compiled = compileTargetSelectors(selectors, registry, manifest, {
          // Recovery reopens the same authoring contract used by live preflight.
          // Business observations must not become hard errors only on resume.
          validationBoundary: STRUCTURAL_VALIDATION_BOUNDARY,
          acceptedSourceLanguageReviews: selectorCompilerAcceptedReviews(
            state.selector_protocol?.language_review_markers,
          ),
          acceptedVerdictNameReviews: selectorCompilerAcceptedReviews(
            state.selector_protocol?.name_review_markers,
          ),
          ...(tableStructurePlan ? { tableStructurePlan } : {}),
        });
        const hydrated = hydrateSemanticSourcePlan(compiled, manifest);
        const replayIssues = classifyCompilerInvariantIssues(selectors, registry,
          checkTargetCompilerInvariants(selectors, hydrated, manifest, compiled));
        // Recovery reopens authoring; it does not approve or seal the draft.
        // Use the same ownership as live preflight so a repaired compiler can
        // return remaining author diagnostics through the normal repair loop.
        if (replayIssues.every(issue => issue.owner === "selector_input_error")) {
          return { path: workspace.workingSelectorPath, source: "compiler_replay" };
        }
      } catch {
        // The original terminal state remains authoritative until the exact
        // durable draft passes the current compiler and its invariants.
      }
    }
    const selectorProtocol = state.selector_protocol;
    const bestFingerprint = selectorProtocol?.best_draft_fingerprint ?? "";
    const bestCompletedPreflight = selectorProtocol?.best_preflight_stage_rank === 4
      && selectorProtocol.best_issue_count === 0;
    if (
      bestFingerprint
      && bestCompletedPreflight
      && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.bestSelectorPath)
    ) {
      const best = migrateTargetSelectorPlanForAuthoring(
        await readJson<unknown>(workspace.bestSelectorPath),
      ).plan;
      if (targetSelectorFingerprint(best) === bestFingerprint) {
        return { path: workspace.bestSelectorPath, source: "best" };
      }
    }
    // scope_extension 终态在 report_target_blocker 处停笔，stage 阶梯来不及写
    // durable stage checkpoint，上面的 modeling_phase 分支接不住它。一次性配额
    // 只应约束「换证据的 fresh 重开」；草稿本身可用（span 全部可解析）时，
    // 带着它继续修订不消耗配额，不应终局。
    if (
      (state.terminal_failure_class === "scope_extension"
        || state.terminal_blocker_code === "scope_extension_required")
      && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.workingSelectorPath)
    ) {
      return { path: workspace.workingSelectorPath, source: "scope_extension_draft" };
    }
    if (!state.lineage) return undefined;
    const historyEntries = (await readdir(workspace.historyDirectory))
      .filter((name) => /^\d{6}\.json$/u.test(name));
    if (
      historyEntries.length === 0
      && await RevisionWorkspace.hasUsableSelectorCheckpoint(workspace, workspace.workingSelectorPath)
    ) {
      return { path: workspace.workingSelectorPath, source: "inherited_unedited" };
    }
    return undefined;
  }

  static async create(
    artifactRoot: string,
    jobId: string,
    targetId: string,
    markdownPath: string,
    pdfPath?: string,
  ): Promise<RevisionWorkspace> {
    return RevisionWorkspace.createFromEvidence(
      artifactRoot,
      jobId,
      targetId,
      await buildEvidenceManifest(markdownPath, jobId, targetId, pdfPath),
    );
  }

  static async createFromEvidence(
    artifactRoot: string,
    jobId: string,
    targetId: string,
    prepared: {
      manifest: EvidenceManifest;
      markdown: Uint8Array;
      pdf?: Uint8Array;
    },
  ): Promise<RevisionWorkspace> {
    const rootParent = revisionsRoot(artifactRoot, jobId, targetId);
    const revision = await nextRevisionNumber(rootParent);
    const root = join(rootParent, String(revision).padStart(6, "0"));
    await mkdir(rootParent, { recursive: true });
    await mkdir(root, { recursive: false });
    const workspace = new RevisionWorkspace(root, artifactRoot, jobId, targetId, revision);
    await mkdir(workspace.evidenceDirectory);
    await mkdir(workspace.historyDirectory);
    await mkdir(workspace.validationDirectory);
    await mkdir(workspace.piSessionDirectory);
    await mkdir(workspace.coverageReviewDirectory);
    const { manifest, markdown, pdf } = prepared;
    await atomicWriteNewText(workspace.sourceMarkdownPath, Buffer.from(markdown).toString("utf8"));
    await atomicWriteNewText(workspace.evidenceManifestPath, prettyJson(manifest));
    await atomicWriteNewText(workspace.evidenceScopePath, prettyJson(manifest.scope));
    if (pdf) {
      await atomicWriteNewBytes(workspace.sourcePdfPath, pdf);
    }
    await makeReadOnly(workspace.sourceMarkdownPath);
    await makeReadOnly(workspace.evidenceManifestPath);
    await makeReadOnly(workspace.evidenceScopePath);
    if (pdf) await makeReadOnly(workspace.sourcePdfPath);
    await atomicWriteJson(workspace.workingPlanPath, initialPlan(manifest));
    const registry = registryForManifest(manifest);
    await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
    await atomicWriteJson(
      workspace.workingSelectorPath,
      initialTargetSelectorPlan(manifest),
    );
    await atomicWriteJson(workspace.statePath, initialState(revision));
    return workspace;
  }

  static async reviseFromSealed(
    artifactRoot: string,
    jobId: string,
    targetId: string,
    sourceRevision?: number,
  ): Promise<RevisionWorkspace> {
    const previous = sourceRevision === undefined
      ? await RevisionWorkspace.openLatest(artifactRoot, jobId, targetId)
      : await RevisionWorkspace.openRevision(artifactRoot, jobId, targetId, sourceRevision);
    const previousState = await previous.readState();
    if (previousState.status !== "sealed") {
      throw new Error("Cannot create a revision from an unsealed source revision");
    }
    const rootParent = revisionsRoot(artifactRoot, jobId, targetId);
    const revision = await nextRevisionNumber(rootParent);
    const root = join(rootParent, String(revision).padStart(6, "0"));
    await mkdir(root, { recursive: false });
    const workspace = new RevisionWorkspace(root, artifactRoot, jobId, targetId, revision);
    await mkdir(workspace.evidenceDirectory);
    await mkdir(workspace.historyDirectory);
    await mkdir(workspace.validationDirectory);
    await mkdir(workspace.piSessionDirectory);
    await mkdir(workspace.coverageReviewDirectory);
    await copyFile(previous.sourceMarkdownPath, workspace.sourceMarkdownPath);
    await copyFile(previous.evidenceManifestPath, workspace.evidenceManifestPath);
    if (await pathExists(previous.evidenceScopePath)) {
      await copyFile(previous.evidenceScopePath, workspace.evidenceScopePath);
    }
    if (await pathExists(previous.sourcePdfPath)) {
      await copyFile(previous.sourcePdfPath, workspace.sourcePdfPath);
    }
    await makeReadOnly(workspace.sourceMarkdownPath);
    await makeReadOnly(workspace.evidenceManifestPath);
    if (await pathExists(workspace.evidenceScopePath)) {
      await makeReadOnly(workspace.evidenceScopePath);
    }
    if (await pathExists(workspace.sourcePdfPath)) {
      await makeReadOnly(workspace.sourcePdfPath);
    }
    const evidence = await workspace.readEvidenceManifest();
    const previousPlan = await readJson<unknown>(previous.sealedPlanPath);
    await atomicWriteJson(
      workspace.workingPlanPath,
      preparePersistedPlanForWorking(previousPlan, evidence),
    );
    const selectorCheckpointPath = await RevisionWorkspace.selectorCheckpointPath(previous);
    const selectorMigration = selectorCheckpointPath
      ? migrateTargetSelectorPlanForAuthoring(await readJson<unknown>(selectorCheckpointPath))
      : undefined;
    const workingSelectors = selectorMigration?.plan ?? initialTargetSelectorPlan(evidence);
    await atomicWriteJson(workspace.workingSelectorPath, workingSelectors);
    let registry: SourceSpanRegistry;
    if (await pathExists(previous.sourceSpanRegistryPath)) {
      await copyFile(previous.sourceSpanRegistryPath, workspace.sourceSpanRegistryPath);
      registry = await readJson<SourceSpanRegistry>(workspace.sourceSpanRegistryPath);
    } else {
      registry = registryForManifest(evidence);
      await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
    }
    const tableStructurePath = join(previous.root, "table-structure.json");
    if (await pathExists(tableStructurePath)) {
      await copyFile(tableStructurePath, join(workspace.root, "table-structure.json"));
    }
    await copySelectorRepairWork(previous.root, workspace.root);
    // The new revision is intentionally writable while the prior bytes remain sealed.
    await chmod(workspace.workingPlanPath, 0o644);
    const state = initialState(revision);
    state.lineage = {
      schema_version: "revision-lineage/v1",
      source_revision: previous.revision,
      selector_checkpoint_revision: previous.revision,
      registry_checkpoint_revision: previous.revision,
      evidence_checkpoint_revision: previous.revision,
      recovery_kind: "sealed_checkpoint",
    };
    state.opened_evidence_ids = mergeSelectorOpenedEvidenceIds(
      previousState.opened_evidence_ids ?? [],
      workingSelectors,
      registry,
      evidence,
    );
    state.opened_evidence_window_keys = [...new Set(previousState.opened_evidence_window_keys ?? [])].sort();
    state.opened_global_resource_ids = [...new Set(previousState.opened_global_resource_ids ?? [])].sort();
    state.document_reference_reads = structuredClone(previousState.document_reference_reads ?? {});
    await atomicWriteJson(workspace.statePath, state);
    if (selectorMigration) {
      await workspace.appendEvent("sealed_selector_checkpoint_carried_forward", {
        previous_revision: previous.revision,
        checkpoint_file: selectorCheckpointPath ? relative(previous.root, selectorCheckpointPath) : "",
        source_schema_version: selectorMigration.source_schema_version,
        migrated: selectorMigration.migrated,
        migration_issues: selectorMigration.issues,
      });
    }
    // copyFile preserves the Windows read-only attribute. Every mutable root
    // artifact in the new authoring revision must be writable before tools use
    // atomic rename, while the sealed ancestor remains untouched.
    await makeExistingWritableRootArtifacts(workspace.root);
    return workspace;
  }

  static async reviseFromInterruptedSeal(
    artifactRoot: string,
    jobId: string,
    targetId: string,
  ): Promise<RevisionWorkspace> {
    const previous = await RevisionWorkspace.openLatest(artifactRoot, jobId, targetId);
    const previousState = await previous.readState();
    if (await pathExists(previous.manifestPath)) {
      throw new Error("Cannot recover an interrupted seal from a completed manifest");
    }
    if (!(await pathExists(previous.sealedPlanPath))) {
      throw new Error("Interrupted seal recovery requires a partial immutable artifact");
    }
    const selectorCheckpointPath = await RevisionWorkspace.selectorCheckpointPath(previous);

    const rootParent = revisionsRoot(artifactRoot, jobId, targetId);
    const revision = await nextRevisionNumber(rootParent);
    const root = join(rootParent, String(revision).padStart(6, "0"));
    await mkdir(root, { recursive: false });
    const workspace = new RevisionWorkspace(root, artifactRoot, jobId, targetId, revision);
    await mkdir(workspace.evidenceDirectory);
    await mkdir(workspace.historyDirectory);
    await mkdir(workspace.validationDirectory);
    await mkdir(workspace.piSessionDirectory);
    await mkdir(workspace.coverageReviewDirectory);
    await copyFile(previous.sourceMarkdownPath, workspace.sourceMarkdownPath);
    await copyFile(previous.evidenceManifestPath, workspace.evidenceManifestPath);
    if (await pathExists(previous.evidenceScopePath)) {
      await copyFile(previous.evidenceScopePath, workspace.evidenceScopePath);
    }
    if (await pathExists(previous.sourcePdfPath)) {
      await copyFile(previous.sourcePdfPath, workspace.sourcePdfPath);
    }
    await makeReadOnly(workspace.sourceMarkdownPath);
    await makeReadOnly(workspace.evidenceManifestPath);
    if (await pathExists(workspace.evidenceScopePath)) await makeReadOnly(workspace.evidenceScopePath);
    if (await pathExists(workspace.sourcePdfPath)) await makeReadOnly(workspace.sourcePdfPath);

    const checkpointPath = previousState.last_valid_fingerprint
      && await pathExists(previous.lastValidPlanPath)
      ? previous.lastValidPlanPath
      : previous.workingPlanPath;
    const evidence = await workspace.readEvidenceManifest();
    const checkpoint = await readJson<unknown>(checkpointPath);
    await atomicWriteJson(
      workspace.workingPlanPath,
      preparePersistedPlanForWorking(checkpoint, evidence),
    );
    for (const [source, destination] of [
      [selectorCheckpointPath ?? previous.workingSelectorPath, workspace.workingSelectorPath],
      [previous.sourceSpanRegistryPath, workspace.sourceSpanRegistryPath],
      [join(previous.root, "table-structure.json"), join(workspace.root, "table-structure.json")],
      [previous.bestSelectorPath, workspace.bestSelectorPath],
      [previous.lastValidPlanPath, workspace.lastValidPlanPath],
      [previous.lastValidSelectorPath, workspace.lastValidSelectorPath],
      [previous.validationReceiptPath, workspace.validationReceiptPath],
    ] as const) {
      if (await pathExists(source)) await copyFile(source, destination);
    }
    if (!(await pathExists(workspace.workingSelectorPath))) {
      await atomicWriteJson(workspace.workingSelectorPath, initialTargetSelectorPlan(evidence));
    }
    await copySelectorRepairWork(previous.root, workspace.root);
    if (!(await pathExists(workspace.sourceSpanRegistryPath))) {
      await atomicWriteJson(workspace.sourceSpanRegistryPath, registryForManifest(evidence));
    }
    await copyDirectoryContents(previous.historyDirectory, workspace.historyDirectory);
    await copyDirectoryContents(previous.validationDirectory, workspace.validationDirectory);
    await copyDirectoryContents(previous.coverageReviewDirectory, workspace.coverageReviewDirectory);
    await chmod(workspace.workingPlanPath, 0o644);
    await chmod(workspace.workingSelectorPath, 0o644);
    await chmod(workspace.sourceSpanRegistryPath, 0o644);
    if (await pathExists(join(workspace.root, "table-structure.json"))) {
      await chmod(join(workspace.root, "table-structure.json"), 0o644);
    }
    if (await pathExists(workspace.bestSelectorPath)) await chmod(workspace.bestSelectorPath, 0o644);
    if (await pathExists(workspace.lastValidPlanPath)) await chmod(workspace.lastValidPlanPath, 0o644);
    if (await pathExists(workspace.lastValidSelectorPath)) await chmod(workspace.lastValidSelectorPath, 0o644);
    const defaults = initialState(revision);
    const nextState: RevisionState = {
      ...defaults,
      ...structuredClone(previousState),
      revision,
      lineage: {
        schema_version: "revision-lineage/v1",
        source_revision: previous.revision,
        selector_checkpoint_revision: previous.revision,
        registry_checkpoint_revision: previous.revision,
        evidence_checkpoint_revision: previous.revision,
        recovery_kind: "interrupted_checkpoint",
      },
      status: "working",
      next_event_sequence: 1,
      selector_protocol: {
        ...defaults.selector_protocol!,
        ...(previousState.selector_protocol ?? {}),
      },
      repair: {
        ...defaults.repair!,
        ...(previousState.repair ?? {}),
        fresh_session_required: false,
      },
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    };
    delete nextState.terminal_at;
    delete nextState.terminal_reason;
    delete nextState.terminal_blocker_code;
    delete nextState.terminal_failure_class;
    await atomicWriteJson(workspace.statePath, nextState);
    return workspace;
  }

  static async reviseFromTerminalFailure(
    artifactRoot: string,
    jobId: string,
    targetId: string,
    options: { resumeModelingPhaseBudget?: boolean; scopeExtensionManifest?: EvidenceManifest;
      tableStructureCheckpoint?: { revision: number; sha256: string } } = {},
  ): Promise<RevisionWorkspace> {
    const previous = await RevisionWorkspace.openLatest(artifactRoot, jobId, targetId);
    const previousState = await previous.readState();
    if (previousState.status !== "failed") {
      throw new Error("Terminal failure recovery requires a failed latest revision");
    }
    if (await pathExists(previous.manifestPath)) {
      throw new Error("Cannot recover a terminal failure from a completed manifest");
    }
    if (await pathExists(previous.sealedPlanPath)) {
      throw new Error("Use interrupted seal recovery when an immutable partial plan exists");
    }

    const trustedTerminalCheckpoint = await RevisionWorkspace.trustedTerminalSelectorCheckpoint(
      previous,
      previousState,
      options.resumeModelingPhaseBudget,
    );
    const sealedAncestor = trustedTerminalCheckpoint
      ? undefined
      : await RevisionWorkspace.nearestSealedAncestor(previous);
    if (!trustedTerminalCheckpoint && !sealedAncestor) {
      throw new Error("Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor");
    }
    const checkpointWorkspace = sealedAncestor ?? previous;
    let tableStructureCheckpointWorkspace = checkpointWorkspace;
    let restoredTableCheckpointFocus: RevisionState["selector_protocol"];
    if (options.tableStructureCheckpoint) {
      const proof = options.tableStructureCheckpoint;
      // Explicit repair of an omitted authoring artifact. It is safe only when
      // all other checkpoint inputs are unchanged from the recorded ancestor.
      if (sealedAncestor || options.scopeExtensionManifest || trustedTerminalCheckpoint?.source !== "modeling_phase"
        || !Number.isSafeInteger(proof.revision) || proof.revision < 1 || proof.revision >= previous.revision
        || previousState.lineage?.selector_checkpoint_revision !== proof.revision
        || previousState.lineage?.registry_checkpoint_revision !== proof.revision
        || previousState.lineage?.evidence_checkpoint_revision !== proof.revision) {
        throw new Error("table_structure_checkpoint_identity_mismatch");
      }
      const ancestor = await RevisionWorkspace.openRevision(artifactRoot, jobId, targetId, proof.revision);
      for (const [ancestorPath, currentPath] of [
        [ancestor.workingSelectorPath, trustedTerminalCheckpoint.path],
        [ancestor.sourceSpanRegistryPath, previous.sourceSpanRegistryPath],
        [ancestor.evidenceManifestPath, previous.evidenceManifestPath],
        [ancestor.sourceMarkdownPath, previous.sourceMarkdownPath],
      ] as const) {
        if (!(await readFile(ancestorPath)).equals(await readFile(currentPath))) {
          throw new Error("table_structure_checkpoint_inputs_changed");
        }
      }
      const [ancestorHasPdf, currentHasPdf] = await Promise.all([pathExists(ancestor.sourcePdfPath), pathExists(previous.sourcePdfPath)]);
      if (ancestorHasPdf !== currentHasPdf || ancestorHasPdf
        && !(await readFile(ancestor.sourcePdfPath)).equals(await readFile(previous.sourcePdfPath))) {
        throw new Error("table_structure_checkpoint_inputs_changed");
      }
      const tableText = await readFile(join(ancestor.root, "table-structure.json"), "utf8");
      if (sha256Text(tableText) !== proof.sha256) throw new Error("table_structure_checkpoint_hash_mismatch");
      if (validateTableStructurePlan(JSON.parse(tableText), await previous.readEvidenceManifest(), await previous.readSourceSpanRegistry()).length) {
        throw new Error("table_structure_checkpoint_invalid");
      }
      tableStructureCheckpointWorkspace = ancestor;
      restoredTableCheckpointFocus = (await ancestor.readState()).selector_protocol;
    }
    const terminalValidationBudgetReset = !sealedAncestor
      && previousState.terminal_reason === "final_validator_attempt_limit";
    const sealedAncestorSelectorCheckpointPath = sealedAncestor
      ? await RevisionWorkspace.selectorCheckpointPath(sealedAncestor)
      : undefined;

    const rootParent = revisionsRoot(artifactRoot, jobId, targetId);
    const revision = await nextRevisionNumber(rootParent);
    const root = join(rootParent, String(revision).padStart(6, "0"));
    await mkdir(root, { recursive: false });
    const workspace = new RevisionWorkspace(root, artifactRoot, jobId, targetId, revision);
    await mkdir(workspace.evidenceDirectory);
    await mkdir(workspace.historyDirectory);
    await mkdir(workspace.validationDirectory);
    await mkdir(workspace.piSessionDirectory);
    await mkdir(workspace.coverageReviewDirectory);

    const evidenceCheckpointWorkspace = options.scopeExtensionManifest ? previous : sealedAncestor ?? previous;
    await copyDirectoryContents(evidenceCheckpointWorkspace.evidenceDirectory, workspace.evidenceDirectory);
    await copyDirectoryContents(previous.coverageReviewDirectory, workspace.coverageReviewDirectory);
    let recoveredEvidence = await workspace.readEvidenceManifest();
    if (options.scopeExtensionManifest) {
      const expanded = options.scopeExtensionManifest;
      if (expanded.job_id !== recoveredEvidence.job_id || expanded.target_id !== recoveredEvidence.target_id
        || sha256Json(expanded.source) !== sha256Json(recoveredEvidence.source)) {
        throw new Error("Scope extension checkpoint must retain the original job, target and immutable source");
      }
      const records = new Map(expanded.evidence.map(record => [record.evidence_id, record]));
      for (const record of recoveredEvidence.evidence) {
        const next = records.get(record.evidence_id);
        if (next && (next.text !== record.text || next.text_sha256 !== record.text_sha256
          || next.locator !== record.locator || (record.evidence_scope === "primary" && next.evidence_scope !== "primary"))) {
          throw new Error(`Scope extension changed immutable checkpoint evidence ${record.evidence_id}`);
        }
        if (!next) records.set(record.evidence_id, record);
      }
      const { evidence_fingerprint: _fingerprint, ...base } = expanded;
      const fragments = new Map(expanded.table_fragments.map(fragment => [fragment.fragment_id, fragment]));
      for (const fragment of recoveredEvidence.table_fragments) {
        if (!fragments.has(fragment.fragment_id)) fragments.set(fragment.fragment_id, fragment);
      }
      const payload = { ...base, evidence: [...records.values()], table_fragments: [...fragments.values()],
        reference_occurrences: recoveredEvidence.reference_occurrences };
      recoveredEvidence = { ...payload, evidence_fingerprint: sha256Json(payload) };
      await chmod(workspace.evidenceManifestPath, 0o644);
      await chmod(workspace.evidenceScopePath, 0o644);
      await atomicWriteJson(workspace.evidenceManifestPath, recoveredEvidence);
      await atomicWriteJson(workspace.evidenceScopePath, recoveredEvidence.scope);
    }
    const validatedCheckpointReceipt = trustedTerminalCheckpoint?.source === "validated"
      ? await readJson<Record<string, unknown>>(previous.validationReceiptPath)
      : undefined;
    const staleValidatedCheckpoint = validatedCheckpointReceipt?.ok === true
      && validatedCheckpointReceipt.evidence_fingerprint !== recoveredEvidence.evidence_fingerprint;
    const resetValidationBudget = terminalValidationBudgetReset || staleValidatedCheckpoint || Boolean(options.scopeExtensionManifest);
    let selectorMigration: ReturnType<typeof migrateTargetSelectorPlanForAuthoring> | undefined;
    if (sealedAncestor) {
      const evidence = await workspace.readEvidenceManifest();
      await atomicWriteJson(
        workspace.workingPlanPath,
        preparePersistedPlanForWorking(
          await readJson<unknown>(sealedAncestor.sealedPlanPath),
          evidence,
        ),
      );
      // Coverage-repair state remains bound to the immutable source plan. Keep
      // that exact sealed artifact available under the normal last-valid path
      // so review/readiness tools can revalidate the durable review after the
      // writable selector checkpoint is restored from its ancestor.
      await copyFile(sealedAncestor.sealedPlanPath, workspace.lastValidPlanPath);
      selectorMigration = sealedAncestorSelectorCheckpointPath
        ? migrateTargetSelectorPlanForAuthoring(
            await readJson<unknown>(sealedAncestorSelectorCheckpointPath),
          )
        : undefined;
      await atomicWriteJson(
        workspace.workingSelectorPath,
        selectorMigration?.plan ?? initialTargetSelectorPlan(evidence),
      );
      if (await pathExists(sealedAncestor.sourceSpanRegistryPath)) {
        await copyFile(sealedAncestor.sourceSpanRegistryPath, workspace.sourceSpanRegistryPath);
      } else {
        await atomicWriteJson(workspace.sourceSpanRegistryPath, registryForManifest(evidence));
      }
    } else {
      await copyDirectoryContents(previous.historyDirectory, workspace.historyDirectory);
      if (!resetValidationBudget && trustedTerminalCheckpoint?.source !== "modeling_phase") {
        await copyDirectoryContents(previous.validationDirectory, workspace.validationDirectory);
      }
      for (const [source, destination] of [
        [trustedTerminalCheckpoint?.source === "validated"
          ? previous.lastValidPlanPath
          : previous.workingPlanPath, workspace.workingPlanPath],
        [trustedTerminalCheckpoint!.path, workspace.workingSelectorPath],
        [previous.sourceSpanRegistryPath, workspace.sourceSpanRegistryPath],
        [previous.bestSelectorPath, workspace.bestSelectorPath],
        ...(!resetValidationBudget && trustedTerminalCheckpoint?.source !== "modeling_phase" ? [
          [previous.lastValidPlanPath, workspace.lastValidPlanPath],
          [previous.lastValidSelectorPath, workspace.lastValidSelectorPath],
          [previous.validationReceiptPath, workspace.validationReceiptPath],
        ] as const : []),
      ] as const) {
        if (await pathExists(source)) await copyFile(source, destination);
      }
    }

    // Table decisions are authoring state, just like selectors and source spans.
    // Carry the exact checkpoint bytes, including pending/invalid decisions;
    // the normal tools must still validate them before compilation or sealing.
    const tableStructureCheckpointPath = join(tableStructureCheckpointWorkspace.root, "table-structure.json");
    await copySelectorRepairWork(checkpointWorkspace.root, workspace.root);
    const tableStructurePath = join(workspace.root, "table-structure.json");
    if (await pathExists(tableStructureCheckpointPath)) {
      await copyFile(tableStructureCheckpointPath, tableStructurePath);
      await chmod(tableStructurePath, 0o644);
    }

    await makeReadOnly(workspace.sourceMarkdownPath);
    await makeReadOnly(workspace.evidenceManifestPath);
    if (await pathExists(workspace.evidenceScopePath)) await makeReadOnly(workspace.evidenceScopePath);
    if (await pathExists(workspace.sourcePdfPath)) await makeReadOnly(workspace.sourcePdfPath);
    await chmod(workspace.workingPlanPath, 0o644);
    await chmod(workspace.workingSelectorPath, 0o644);
    await chmod(workspace.sourceSpanRegistryPath, 0o644);
    if (await pathExists(workspace.bestSelectorPath)) await chmod(workspace.bestSelectorPath, 0o644);
    if (await pathExists(workspace.lastValidPlanPath)) await chmod(workspace.lastValidPlanPath, 0o644);
    if (await pathExists(workspace.lastValidSelectorPath)) await chmod(workspace.lastValidSelectorPath, 0o644);

    const inheritedSelectors = await readJson<unknown>(workspace.workingSelectorPath);
    let inheritedRegistry = await readJson<SourceSpanRegistry>(workspace.sourceSpanRegistryPath);
    if (options.scopeExtensionManifest) {
      const added = registryForManifest(recoveredEvidence);
      const spans = new Map([...inheritedRegistry.spans, ...added.spans].map(span => [span.span_id, span]));
      inheritedRegistry = { ...inheritedRegistry, source_fingerprint: recoveredEvidence.evidence_fingerprint,
        spans: [...spans.values()] };
      await atomicWriteJson(workspace.sourceSpanRegistryPath, inheritedRegistry);
      await atomicWriteJson(workspace.workingPlanPath, initialPlan(recoveredEvidence));
    }
    const restoredOpenedEvidenceIds = mergeSelectorOpenedEvidenceIds(
      previousState.opened_evidence_ids ?? [],
      inheritedSelectors,
      inheritedRegistry,
      recoveredEvidence,
    );
    const defaults = initialState(revision);
    const selectorProtocol = staleValidatedCheckpoint || options.scopeExtensionManifest
      ? { ...defaults.selector_protocol! }
      : {
        ...defaults.selector_protocol!,
        ...(previousState.selector_protocol ?? {}),
        ...(sealedAncestor ? {
        best_draft_fingerprint: "",
        best_history_sequence: 0,
        best_preflight_stage_rank: 0,
        best_issue_count: null,
        best_issue_fingerprint: "",
        consecutive_non_improvements: 0,
        } : {}),
      };
    if (options.tableStructureCheckpoint) {
      // The latest table diagnostics describe the omitted artifact, not the
      // restored snapshot. Retain the matching ancestor's diagnostic hints;
      // they remain unvalidated hints and do not change any retry budget.
      if (restoredTableCheckpointFocus?.last_stage_issues) {
        selectorProtocol.last_stage_issues = structuredClone(restoredTableCheckpointFocus.last_stage_issues);
      } else delete selectorProtocol.last_stage_issues;
    }
    const repair = {
      ...defaults.repair!,
      ...(previousState.repair ?? {}),
      fresh_session_required: false,
    };
    const restoredValidatedFingerprint = validatedCheckpointReceipt?.ok === true
      && validatedCheckpointReceipt.evidence_fingerprint === recoveredEvidence.evidence_fingerprint
      && typeof validatedCheckpointReceipt.validation_fingerprint === "string"
      ? validatedCheckpointReceipt.validation_fingerprint
      : "";
    const restoredValidatedPlanSha256 = restoredValidatedFingerprint
      && typeof validatedCheckpointReceipt?.plan_sha256 === "string"
      ? validatedCheckpointReceipt.plan_sha256
      : "";
    if (!restoredValidatedFingerprint && repair.mode === "validated") {
      repair.mode = "modeling";
    }
    const nextState: RevisionState = {
      ...defaults,
      ...structuredClone(previousState),
      revision,
      lineage: {
        schema_version: "revision-lineage/v1",
        source_revision: previous.revision,
        selector_checkpoint_revision: checkpointWorkspace.revision,
        registry_checkpoint_revision: checkpointWorkspace.revision,
        evidence_checkpoint_revision: evidenceCheckpointWorkspace.revision,
        recovery_kind: sealedAncestor ? "terminal_sealed_ancestor" : "terminal_checkpoint",
      },
      status: "working",
      next_event_sequence: 1,
      ...(sealedAncestor ? {
        next_history_sequence: 1,
      } : {}),
      ...(sealedAncestor || resetValidationBudget ? {
        next_validation_sequence: 1,
        validation_attempts: 0,
        last_valid_fingerprint: "",
        last_valid_plan_sha256: "",
      } : {}),
      ...(restoredValidatedFingerprint ? {
        last_valid_fingerprint: restoredValidatedFingerprint,
        last_valid_plan_sha256: restoredValidatedPlanSha256,
      } : {}),
      opened_evidence_ids: restoredOpenedEvidenceIds,
      opened_evidence_window_keys: [...new Set(previousState.opened_evidence_window_keys ?? [])].sort(),
      opened_global_resource_ids: [...new Set(previousState.opened_global_resource_ids ?? [])].sort(),
      selector_protocol: selectorProtocol,
      ...(options.scopeExtensionManifest ? { selector_stage: "primary" as const } : {}),
      repair,
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    };
    delete nextState.terminal_at;
    delete nextState.terminal_reason;
    delete nextState.terminal_blocker_code;
    delete nextState.terminal_failure_class;
    await atomicWriteJson(workspace.statePath, nextState);
    await workspace.appendEvent("terminal_failure_revision_recovered", {
      previous_revision: previous.revision,
      previous_terminal_reason: previousState.terminal_reason ?? "",
      checkpoint: {
        selector_checkpoint_revision: checkpointWorkspace.revision,
        registry_checkpoint_revision: checkpointWorkspace.revision,
        evidence_checkpoint_revision: evidenceCheckpointWorkspace.revision,
        recovery_kind: sealedAncestor ? "terminal_sealed_ancestor" : "terminal_checkpoint",
        selector_stage: nextState.selector_stage,
        submissions: selectorProtocol.submissions,
        corrections: selectorProtocol.corrections,
        coverage_repairs: selectorProtocol.coverage_repairs,
        terminal_checkpoint_source: trustedTerminalCheckpoint?.source ?? "sealed_ancestor",
        table_structure_checkpoint_revision: tableStructureCheckpointWorkspace.revision,
        ...(options.tableStructureCheckpoint ? { table_structure_checkpoint_sha256: options.tableStructureCheckpoint.sha256 } : {}),
        validation_budget_reset: resetValidationBudget,
        stale_validated_checkpoint_reset: staleValidatedCheckpoint,
      },
      ...(selectorMigration ? {
        selector_migration: {
          source_schema_version: selectorMigration.source_schema_version,
          migrated: selectorMigration.migrated,
          issues: selectorMigration.issues,
        },
      } : {}),
    });
    return workspace;
  }

  /** Explicit, hash-checked continuation of saved initial modeling work. No provider history or pass artifacts are copied. */
  static async reviseFromModelingCheckpoint(
    artifactRoot: string,
    jobId: string,
    targetId: string,
    proof: { revision: number; selector_sha256: string; registry_sha256: string; evidence_sha256: string; markdown_sha256: string; pdf_sha256?: string; source_handle_map_sha256?: string; table_structure_sha256?: string },
  ): Promise<RevisionWorkspace> {
    if (!Number.isSafeInteger(proof.revision) || proof.revision < 1) throw new Error("modeling_checkpoint_revision_invalid");
    const parent = revisionsRoot(artifactRoot,jobId,targetId);
    const previous = new RevisionWorkspace(join(parent,String(proof.revision).padStart(6,"0")),artifactRoot,jobId,targetId,proof.revision);
    const state = await previous.readState();
    if (state.status === "sealed" || state.last_valid_fingerprint || state.last_valid_plan_sha256
      || (state.selector_protocol?.submissions ?? 0) !== 0 || (state.selector_protocol?.coverage_repairs ?? 0) !== 0
      || state.repair?.repair_source === "coverage") throw new Error("modeling_checkpoint_must_be_unvalidated_initial_work");
    const [selectorText,registryText,evidenceText,markdown] = await Promise.all([
      readFile(previous.workingSelectorPath,"utf8"),readFile(previous.sourceSpanRegistryPath,"utf8"),
      readFile(previous.evidenceManifestPath,"utf8"),readFile(previous.sourceMarkdownPath,"utf8"),
    ]);
    for (const [text,expected] of [[selectorText,proof.selector_sha256],[registryText,proof.registry_sha256],[evidenceText,proof.evidence_sha256],[markdown,proof.markdown_sha256]]) {
      if (sha256Text(text!) !== expected) throw new Error("modeling_checkpoint_hash_mismatch");
    }
    const migration = migrateTargetSelectorPlanForAuthoring(JSON.parse(selectorText));
    const selectors = migration.plan;
    const manifest = JSON.parse(evidenceText) as EvidenceManifest;
    if (selectors.job_id !== jobId || selectors.target_id !== targetId
      || manifest.job_id !== jobId || manifest.target_id !== targetId || manifest.source.sha256 !== proof.markdown_sha256) {
      throw new Error("modeling_checkpoint_identity_or_source_mismatch");
    }
    const historySequence = state.next_history_sequence - 1;
    if (historySequence < 1) throw new Error("modeling_checkpoint_saved_history_required");
    const history = await readJson<{ after_sha256: string }>(join(previous.historyDirectory,`${String(historySequence).padStart(6,"0")}.json`));
    if (history.after_sha256 !== proof.selector_sha256) throw new Error("modeling_checkpoint_history_mismatch");
    const registry = JSON.parse(registryText) as SourceSpanRegistry;
    const sources = new Map(manifest.evidence.map(e=>[e.evidence_id,{source_id:e.evidence_id,evidence_id:e.evidence_id,atom_id:e.evidence_id,text:e.text}]));
    const issues: Parameters<typeof resolveSourceSpan>[4] = [];
    for (const id of selectorReferencedSpanIds(selectors)) resolveSourceSpan(registry,id,sources,"/checkpoint",issues);
    if (issues.length) throw new Error(`modeling_checkpoint_source_spans_invalid: ${JSON.stringify(issues)}`);
    const tableStructurePath = join(previous.root,"table-structure.json");
    const tableStructureText = await pathExists(tableStructurePath) ? await readFile(tableStructurePath,"utf8") : undefined;
    if (tableStructureText !== undefined) {
      if (!proof.table_structure_sha256 || sha256Text(tableStructureText) !== proof.table_structure_sha256) {
        throw new Error("modeling_checkpoint_table_structure_hash_mismatch");
      }
      const tableIssues = validateTableStructurePlan(JSON.parse(tableStructureText) as TableStructurePlan,manifest,registry);
      if (tableIssues.length) throw new Error(`modeling_checkpoint_table_structure_invalid: ${JSON.stringify(tableIssues)}`);
    } else if (proof.table_structure_sha256) {
      throw new Error("modeling_checkpoint_table_structure_missing");
    }
    const handleMap = join(previous.root,".model-source-handles/map.json");
    if (await pathExists(handleMap)) {
      if (!proof.source_handle_map_sha256 || sha256Text(await readFile(handleMap,"utf8")) !== proof.source_handle_map_sha256) throw new Error("modeling_checkpoint_handle_map_mismatch");
      await ModelSourceHandles.open(previous.root);
    }
    const pdf = await pathExists(previous.sourcePdfPath) ? await readFile(previous.sourcePdfPath) : undefined;
    if (pdf && createHash("sha256").update(pdf).digest("hex") !== proof.pdf_sha256) throw new Error("modeling_checkpoint_pdf_mismatch");
    const next = await RevisionWorkspace.createFromEvidence(artifactRoot,jobId,targetId,{manifest,markdown:Buffer.from(markdown),...(pdf?{pdf}:{})});
    await atomicWriteText(next.workingSelectorPath,selectorText);
    await atomicWriteText(next.sourceSpanRegistryPath,registryText);
    if (tableStructureText !== undefined) await atomicWriteText(join(next.root,"table-structure.json"),tableStructureText);
    await copyDirectoryContents(previous.historyDirectory,next.historyDirectory);
    const defaults = initialState(next.revision);
    const restored: RevisionState = {
      ...structuredClone(state),revision:next.revision,status:"working",next_event_sequence:1,
      last_valid_fingerprint:"",last_valid_plan_sha256:"",agent_runtime:defaults.agent_runtime,
      lineage:{schema_version:"revision-lineage/v1",source_revision:previous.revision,selector_checkpoint_revision:previous.revision,registry_checkpoint_revision:previous.revision,evidence_checkpoint_revision:previous.revision,recovery_kind:"modeling_checkpoint"},
    };
    // The proof binds unchanged source and draft bytes, so continuation also
    // retains stage progress. An actual improving repair can clear stagnation.
    delete restored.terminal_at; delete restored.terminal_reason;
    delete restored.terminal_blocker_code; delete restored.terminal_failure_class;
    await atomicWriteJson(next.statePath,restored);
    const handoff = {
      schema_version:"target-modeling-handoff/v1",job_id:jobId,target_id:targetId,revision:next.revision,source_revision:previous.revision,
      checkpoint_verified:true,validation_status:"unvalidated_draft",selector_stage:restored.selector_stage,
      target_scope:manifest.scope,proof,
      artifacts:{selectors:next.workingSelectorPath,source_registry:next.sourceSpanRegistryPath,evidence:next.evidenceManifestPath,markdown:next.sourceMarkdownPath,
        ...(tableStructureText !== undefined ? {table_structure:join(next.root,"table-structure.json")} : {})},
      item_inventory:selectors.items.map(item=>({key:item.key,name:item.name,lot_key:item.lot_key})),
      lots:selectors.lots,shared_sampling_rules:selectors.sampling_rules,references:selectors.references,reference_occurrences:manifest.reference_occurrences,
      source_dispositions:selectors.source_dispositions,residual_source_dispositions:selectors.residual_source_dispositions,
      reference_analysis_modes:state.reference_analysis_modes ?? {},reference_catalog_dispositions:state.reference_catalog_dispositions ?? {},
      unresolved:{previous_terminal_reason:state.terminal_reason ?? "",active_cluster:state.repair?.active_cluster ?? null,last_issue_owner:state.selector_protocol?.last_issue_owner ?? "",migration_issues:migration.issues},
      readback:{items:"read_target_selectors collection=items key=<saved key>",rules:"read_target_selectors collection=sampling_rules",references:"list_reference_occurrences and read_target_selectors collection=references",sources:"open_evidence or read_reference_facts for isolated references"},
      instruction:"Continue the current stage from these complete canonical artifacts. Retain all saved fields, conditions, exceptions, exclusions and reference destinations. Read needed records by key; do not load the old provider conversation or rebuild the target. The full target scope is unchanged. No pass marker, review approval or old short-handle namespace was copied.",
    };
    await atomicWriteJson(join(next.root,"modeling-handoff.json"),handoff);
    await next.appendEvent("verified_modeling_checkpoint_restored",{source_revision:previous.revision,proof,items:selectors.items.length,stage:restored.selector_stage,provider_history_copied:false,pass_artifacts_copied:false,handle_namespace_rebuilt:true});
    return next;
  }

  static async openLatest(
    artifactRoot: string,
    jobId: string,
    targetId: string,
  ): Promise<RevisionWorkspace> {
    const rootParent = revisionsRoot(artifactRoot, jobId, targetId);
    const entries = (await readdir(rootParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name));
    const latest = entries[0];
    if (!latest) {
      throw new Error("No persisted revision exists");
    }
    const revision = Number(latest.name);
    const workspace = new RevisionWorkspace(
      join(rootParent, latest.name),
      artifactRoot,
      jobId,
      targetId,
      revision,
    );
    await workspace.reconcileTranscriptCheckpoint();
    return workspace;
  }

  static async openRevision(artifactRoot: string, jobId: string, targetId: string, revision: number): Promise<RevisionWorkspace> {
    if (!Number.isInteger(revision) || revision < 1 || revision > 999999) {
      throw new Error("Invalid persisted target revision");
    }
    const workspace = new RevisionWorkspace(join(revisionsRoot(artifactRoot, jobId, targetId), String(revision).padStart(6, "0")),
      artifactRoot, jobId, targetId, revision);
    const state = await workspace.readState();
    if (state.revision !== revision) throw new Error("Persisted target revision identity mismatch");
    return workspace;
  }

  private async reconcileTranscriptCheckpoint(): Promise<void> {
    await this.withStateLock(async () => {
      const state = await readJson<RevisionState>(this.statePath);
      let transcriptNextEventSequence = 1;
      if (await pathExists(this.transcriptPath)) {
        const lines = (await readFile(this.transcriptPath, "utf8")).split(/\r?\n/u);
        if (lines.at(-1) === "") lines.pop();
        for (const line of lines) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            throw new Error("Invalid revision event transcript");
          }
          const candidate = event as Partial<TranscriptEvent> | null;
          if (
            candidate === null
            || typeof candidate !== "object"
            || candidate.schema_version !== "agent-event/v1"
            || !Number.isInteger(candidate.sequence)
            || Number(candidate.sequence) < 1
          ) {
            throw new Error("Invalid revision event transcript");
          }
          transcriptNextEventSequence = Math.max(
            transcriptNextEventSequence,
            Number(candidate.sequence) + 1,
          );
        }
      }
      if (
        state.status === "working"
        && transcriptNextEventSequence > state.next_event_sequence
      ) {
        state.next_event_sequence = transcriptNextEventSequence;
        await atomicWriteJson(this.statePath, state);
      }
    });
  }

  resolveWritable(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error("Absolute paths are not writable");
    }
    const normalized = relativePath.replaceAll("\\", "/");
    const [head] = normalized.split("/");
    if (
      !(WRITABLE_ROOT_NAMES.has(normalized)
        || (head !== undefined && WRITABLE_DIRECTORIES.has(head)))
    ) {
      throw new Error(`Path is outside the writable artifact allowlist: ${relativePath}`);
    }
    return assertDescendant(this.root, join(this.root, relativePath));
  }

  async readDocumentLedger(): Promise<DocumentLedger | undefined> {
    if (!(await pathExists(this.documentLedgerPath))) return undefined;
    const ledger = await readJson<DocumentLedger>(this.documentLedgerPath);
    return ledgerWithCurrentClauseBoundaries(ledger, await readFile(this.sourceMarkdownPath, "utf8"));
  }

  async readEvidenceManifest(): Promise<EvidenceManifest> {
    return readJson<EvidenceManifest>(this.evidenceManifestPath);
  }

  async readReferenceObservations(planFingerprint: string): Promise<EvidenceManifest> {
    const path = join(this.coverageReviewDirectory, planFingerprint, "reference-observations.json");
    return await pathExists(path) ? readJson<EvidenceManifest>(path) : this.readEvidenceManifest();
  }

  /** Persist a source read beside the frozen candidate; only a finding-bound repair adopts it. */
  async observeReviewSource(planFingerprint: string, start: number, end: number): Promise<EvidenceManifest["evidence"][number]> {
    const state = await this.readState();
    const root = join(this.coverageReviewDirectory, planFingerprint);
    if (state.last_valid_fingerprint !== planFingerprint || await pathExists(join(root, "coverage-review.json"))) {
      throw new Error("Review candidate is stale or sealed; start coverage review for the current validated candidate.");
    }
    const current = await this.readReferenceObservations(planFingerprint);
    const source = await readFile(this.sourceMarkdownPath, "utf8");
    if (sha256Text(source) !== current.source.sha256) throw new Error("Review source hash changed; restore the original source and restart coverage review.");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length || end - start > 6500) {
      throw new Error(`Invalid review source range ${start}:${end}; use an atom_id returned by search_review_document.`);
    }
    const text = source.slice(start, end);
    const record: EvidenceManifest["evidence"][number] = {
      evidence_id: `review-source:${sha256Text(`${current.source.sha256}:${start}:${end}`)}`,
      kind: "paragraph", role: "context", locator: `char:${start}-${end}`,
      source_start_line: 1 + (source.slice(0, start).match(/\n/g)?.length ?? 0),
      text, text_sha256: sha256Text(text), requires_disposition: false,
      evidence_scope: "reference", registered_dependency: true,
    };
    const { evidence_fingerprint: _fingerprint, ...base } = current;
    const payload = { ...base, evidence: current.evidence.some(e => e.evidence_id === record.evidence_id)
      ? current.evidence : [...current.evidence, record] };
    await atomicWriteJson(join(root, "reference-observations.json"), { ...payload, evidence_fingerprint: sha256Json(payload) });
    const registry = await this.readSourceSpanRegistry();
    await atomicWriteJson(this.sourceSpanRegistryPath, registerSourceSpan(registry, {
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text,
    }, 0, text.length).registry);
    return record;
  }

  /** Explicit repair transition only; queries never publish candidate evidence. */
  async adoptReferenceObservations(): Promise<EvidenceManifest> {
    const state = await this.readState();
    if (!coverageRepairAllowsExternalDependency(state)) {
      throw new Error("Reference observation adoption requires an active, finding-bound coverage repair");
    }
    const sourceFingerprint = state.repair!.coverage_review_fingerprint!;
    const reviewRoot = join(this.coverageReviewDirectory, sourceFingerprint);
    const adoptionPath = join(reviewRoot, "reference-adoption.json");
    if (!(await pathExists(join(reviewRoot, "reference-observations.json"))) || await pathExists(adoptionPath)) {
      return this.readEvidenceManifest();
    }
    const observed = await this.readReferenceObservations(sourceFingerprint);
    const current = await this.readEvidenceManifest();
    const base = await readJson<EvidenceManifest>(join(reviewRoot, "candidate.evidence.json"));
    if (![base.evidence_fingerprint, observed.evidence_fingerprint].includes(current.evidence_fingerprint)) {
      throw new Error("Reference adoption candidate evidence changed");
    }
    const { evidence_fingerprint, ...payload } = observed;
    if (sha256Json(payload) !== evidence_fingerprint) throw new Error("Invalid reference observation fingerprint");
    if (observed.source.sha256 !== current.source.sha256) throw new Error("Reference observation source mismatch");
    // Publishing is replay-safe: interruption between the manifest and registry
    // writes resumes the same adoption without consuming any model budget.
    if (current.evidence_fingerprint !== evidence_fingerprint) {
      await chmod(this.evidenceManifestPath, 0o644);
      await atomicWriteJson(this.evidenceManifestPath, observed);
      await makeReadOnly(this.evidenceManifestPath);
      await this.appendEvent("coverage_reference_evidence_adopted", {
        source_plan_fingerprint: sourceFingerprint,
        previous_evidence_fingerprint: current.evidence_fingerprint,
        evidence_fingerprint,
        finding_ids: state.repair!.coverage_finding_ids,
        requires_recompile_and_review: true,
        budget_consumed: false,
      });
    }
    let registry = await this.readSourceSpanRegistry();
    for (const record of observed.evidence) {
      registry = registerSourceSpan(registry, { source_id: record.evidence_id,
        evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text }, 0, record.text.length).registry;
    }
    await atomicWriteJson(this.sourceSpanRegistryPath, { ...registry, source_fingerprint: evidence_fingerprint });
    await atomicWriteJson(adoptionPath, {
      source_plan_fingerprint: sourceFingerprint,
      evidence_fingerprint,
      finding_ids: state.repair!.coverage_finding_ids,
      requires_recompile_and_review: true,
    });
    return observed;
  }

  async extendEvidenceManifest(record: EvidenceManifest["evidence"][number]): Promise<EvidenceManifest> {
    const state = await this.readState();
    if (
      state.status !== "working"
      || (state.validation_attempts > 0 && !coverageRepairAllowsExternalDependency(state))
    ) {
      throw new Error("External dependencies must be registered before final validation");
    }
    const current = await this.readEvidenceManifest();
    if (current.evidence.some((candidate) => candidate.evidence_id === record.evidence_id)) return current;
    const { evidence_fingerprint: _fingerprint, ...base } = current;
    const payload = { ...base, evidence: [...current.evidence, record] };
    const updated: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
    await chmod(this.evidenceManifestPath, 0o644);
    await atomicWriteJson(this.evidenceManifestPath, updated);
    await makeReadOnly(this.evidenceManifestPath);
    return updated;
  }

  /** Restore only proven legacy whole-document reference flags before the unchanged resume gate. */
  async restoreExternalReferenceProvenance(
    prepared: EvidenceManifest,
    workflow: ExternalSourceWorkflow,
    validateResume: (candidate: EvidenceManifest) => boolean,
  ): Promise<EvidenceManifest> {
    const current = await this.readEvidenceManifest();
    const state = await this.readState();
    if (state.status !== "working" || state.validation_attempts > 0 || state.last_valid_fingerprint) return current;
    if (current.source.sha256 !== prepared.source.sha256) return current;
    const primaryIds = new Set(prepared.evidence.map(record => record.evidence_id));
    const currentById = new Map(current.evidence.map(record => [record.evidence_id, record]));
    const verifiedIds = new Set<string>();
    for (const occurrence of current.reference_occurrences) {
      const source = occurrence.external_standard;
      if (occurrence.status !== "resolved" || source?.status !== "resolved" || source.usage !== "content_required"
        || occurrence.target_address?.locator_kind !== "standard") continue;
      const document = await workflow.lookup(source.standard_no);
      if (!document || normalizeStandardNo(document.standard_no) !== normalizeStandardNo(source.standard_no)
        || document.markdown_sha256 !== source.markdown_sha256 || sha256Text(document.markdown) !== document.markdown_sha256
        || !standardIdentityMatches(document.markdown, source.standard_no)) continue;
      const records = buildStructuredTargetEvidence(document.markdown, document.markdown_sha256,
        [{ start_line: 1, end_exclusive_line: document.markdown.split(/\r?\n/u).length + 1 }], false).evidence;
      if (sha256Json(records.map(record => record.evidence_id)) !== sha256Json(occurrence.target_evidence_ids)) continue;
      if (records.some(record => {
        const saved = currentById.get(record.evidence_id);
        return primaryIds.has(record.evidence_id) || !saved || saved.text !== record.text || saved.text_sha256 !== record.text_sha256
          || saved.locator !== record.locator || saved.kind !== record.kind || saved.role !== record.role;
      })) continue;
      records.forEach(record => verifiedIds.add(record.evidence_id));
    }
    const repairedIds: string[] = [];
    const evidence = current.evidence.map(record => {
      if (!verifiedIds.has(record.evidence_id) || (record.registered_dependency === true && record.requires_disposition === false
        && record.evidence_scope === "reference")) return record;
      repairedIds.push(record.evidence_id);
      return { ...record, registered_dependency: true as const, requires_disposition: false, evidence_scope: "reference" as const };
    });
    if (!repairedIds.length) return current;
    const { evidence_fingerprint: previousFingerprint, ...base } = current;
    const payload = { ...base, evidence };
    const repaired = { ...payload, evidence_fingerprint: sha256Json(payload) };
    if (!validateResume(repaired)) return current;
    const registry = await this.readSourceSpanRegistry();
    if (![previousFingerprint, repaired.evidence_fingerprint].includes(registry.source_fingerprint)) return current;
    // Registry first: an interrupted write replays the same source-proven candidate.
    await atomicWriteJson(this.sourceSpanRegistryPath, { ...registry, source_fingerprint: repaired.evidence_fingerprint });
    await chmod(this.evidenceManifestPath, 0o644);
    await atomicWriteJson(this.evidenceManifestPath, repaired);
    await makeReadOnly(this.evidenceManifestPath);
    await this.appendEvent("external_reference_provenance_restored", {
      previous_evidence_fingerprint: previousFingerprint, evidence_fingerprint: repaired.evidence_fingerprint,
      record_count: repairedIds.length, source_text_changed: false, selector_changed: false,
      budget_consumed: false, independent_semantic_review_performed: false,
    });
    return repaired;
  }

  async readReferenceCorrections(): Promise<import("./contracts.js").ReferenceCorrectionRecord[]> {
    const path = join(this.root, "reference-corrections.json");
    return await pathExists(path) ? readJson(path) : [];
  }

  async registerDocumentReferenceDependency(
    records: EvidenceManifest["evidence"],
    occurrence: ReferenceOccurrence,
    allowAfterValidation = false,
    supersedeOccurrenceIds: readonly string[] = [],
    correction?: { previous_occurrence_id: string; reason: string },
  ): Promise<{ manifest: EvidenceManifest; registry: SourceSpanRegistry }> {
    const state = await this.readState();
    if (
      state.status !== "working"
      || (
        state.validation_attempts > 0
        && !coverageRepairAllowsExternalDependency(state)
        && !allowAfterValidation
        && !(correction && !state.last_valid_fingerprint && !state.last_valid_plan_sha256 && !state.repair?.coverage_review_fingerprint)
      )
    ) {
      throw new Error("Document references must be registered before final validation or by the active coverage reviewer");
    }
    const observationPlan = allowAfterValidation ? state.last_valid_fingerprint : "";
    if (allowAfterValidation && !observationPlan) throw new Error("Reference observation requires a validated candidate");
    const current = observationPlan
      ? await this.readReferenceObservations(observationPlan)
      : await this.readEvidenceManifest();
    const previousCorrection = correction ? current.reference_occurrences.find(row => row.occurrence_id === correction.previous_occurrence_id) : undefined;
    if (correction && (!previousCorrection || !correction.reason.trim() || allowAfterValidation || state.last_valid_fingerprint
      || state.last_valid_plan_sha256 || state.repair?.coverage_review_fingerprint || !supersedeOccurrenceIds.includes(correction.previous_occurrence_id))) {
      throw new Error("A reference correction requires an unvalidated working candidate and its exact active predecessor");
    }
    const evidenceById = new Map(current.evidence.map((record) => [record.evidence_id, record]));
    for (const record of records) {
      const existing = evidenceById.get(record.evidence_id);
      if (existing && sha256Json(existing) !== sha256Json(record)) {
        const sameImmutableSource = existing.locator === record.locator
          && existing.text === record.text
          && existing.text_sha256 === record.text_sha256;
        if (!sameImmutableSource) {
          throw new Error(`Document reference evidence collision for ${record.evidence_id}`);
        }
        const scopeRank = { reference: 0, sampling: 1, primary: 2 } as const;
        const existingScope = existing.evidence_scope ?? "reference";
        const incomingScope = record.evidence_scope ?? "reference";
        const evidenceScope = scopeRank[existingScope] >= scopeRank[incomingScope]
          ? existingScope
          : incomingScope;
        evidenceById.set(record.evidence_id, {
          ...existing,
          ...record,
          requires_disposition: existing.requires_disposition || record.requires_disposition,
          evidence_scope: evidenceScope,
          ...(existing.registered_dependency || record.registered_dependency
            ? { registered_dependency: true }
            : {}),
          ...((existing.table_alias_ids?.length ?? 0) > 0 || (record.table_alias_ids?.length ?? 0) > 0
            ? { table_alias_ids: [...new Set([...(existing.table_alias_ids ?? []), ...(record.table_alias_ids ?? [])])].sort() }
            : {}),
        });
        continue;
      }
      if (!existing) evidenceById.set(record.evidence_id, record);
    }
    if (supersedeOccurrenceIds.length && allowAfterValidation) {
      throw new Error("Validated reference observations cannot supersede immutable occurrences");
    }
    const superseded = new Set(supersedeOccurrenceIds);
    const occurrenceById = new Map(current.reference_occurrences
      .filter(entry => !superseded.has(entry.occurrence_id))
      .map((entry) => [entry.occurrence_id, entry]));
    const existingOccurrence = occurrenceById.get(occurrence.occurrence_id);
    // occurrence_id 只由「来源 + 目标」算出，但这里比的是整个对象逐字一致，
    // 其中 relation（引用关系的说明）与 reference_literal* （引用原文的跨度）是
    // 调用方自己措辞、自己定位的描述性字段：同一处引用被作者和复核先后解析时，
    // 这两处必然不同，于是同 id、不同内容 → 抛冲突 → 工具既不给结果也不给回执。
    //
    // 这一条专打「目标不在本文档里」的引用：GB 50311 这类外部标准永远是
    // target_not_found、永远处于「还没解析成」的状态，所以永远会被第二个人再解析一次，
    // 也就永远撞这个冲突。实测 保护措施 因此走 coverage_harness_defect 失败，
    // 复核的判词是对的：「occurrence collision 阻止独立审查取得所要求的解析回执」。
    //
    // 描述性字段不参与冲突判定；实质字段（状态、目标、种类、是否必办）仍然逐字守。
    // 先到先得：已登记的那份保持不变，第二次调用照常拿到回执。
    const substantive = (entry: ReferenceOccurrence): string => {
      const {
        relation: _relation,
        origin_span_id: _originSpan,
        origin_span_ids: _originSpans,
        reference_literal_span_id: _literalSpan,
        reference_literal_span_ids: _literalSpans,
        reference_literal: _literal,
        reference_literals: _literals,
        ...rest
      } = entry;
      return sha256Json(rest);
    };
    const resolvesMissing = existingOccurrence?.status === "target_not_found"
      && occurrence.status === "resolved"
      && sha256Json(referenceOccurrenceOriginEvidenceIds(existingOccurrence)) === sha256Json(referenceOccurrenceOriginEvidenceIds(occurrence))
      && sha256Json(referenceOccurrenceLiteralSpanIds(existingOccurrence)) === sha256Json(referenceOccurrenceLiteralSpanIds(occurrence))
      && sha256Json(existingOccurrence.target_address) === sha256Json(occurrence.target_address);
    const sameLogicalOccurrence = existingOccurrence
      ? sameLogicalReferenceOccurrence(existingOccurrence, occurrence)
      : false;
    const routeClaimChanged = Boolean(existingOccurrence && sameLogicalOccurrence
      && sha256Json(existingOccurrence.origin_fields) !== sha256Json(occurrence.origin_fields));
    // A route becomes authoritative only after a selector candidate has been
    // validated. During active coverage repair the source candidate is already
    // validated even though last_valid_* is intentionally cleared.
    const routeFrozen = Boolean(
      state.last_valid_fingerprint
      || state.last_valid_plan_sha256
      || state.repair?.coverage_review_fingerprint,
    );
    const correctsUnvalidatedRoute = routeClaimChanged && !routeFrozen;
    const anchorsStaticReference = Boolean(existingOccurrence && !routeFrozen && !allowAfterValidation
      && canAnchorStaticTableReference(existingOccurrence, occurrence, current)
      && current.reference_occurrences.filter(entry => canAnchorStaticTableReference(entry, occurrence, current)).length === 1);
    if (
      existingOccurrence
      && !resolvesMissing
      && !sameLogicalOccurrence
      && !anchorsStaticReference
      && substantive(existingOccurrence) !== substantive(occurrence)
    ) {
      throw new Error(`Document reference occurrence collision for ${occurrence.occurrence_id}`);
    }
    if (!existingOccurrence || resolvesMissing || correctsUnvalidatedRoute || anchorsStaticReference) {
      occurrenceById.set(occurrence.occurrence_id, occurrence);
    } else if (sameLogicalOccurrence && existingOccurrence.status === "target_not_found"
      && existingOccurrence.external_standard?.status === "placeholder"
      && occurrence.external_standard?.expansion === "literal_only"
      && ((occurrence.external_standard.expansion_reason === "allowable_deviation_reference"
        && externalReferenceFieldPolicy(current, referenceOccurrenceLiterals(existingOccurrence)).literal_only)
      || (occurrence.external_standard.expansion_reason === "user_ignored_source" && occurrence.external_standard.user_ignore)
      || (occurrence.external_standard.expansion_reason === "nested_source_unavailable"
      && externalReferenceExpansionPolicy(current, referenceOccurrenceOriginEvidenceIds(existingOccurrence), {
        standard_no: existingOccurrence.external_standard.standard_no,
        ...(existingOccurrence.target_address ? { source_sha256: existingOccurrence.target_address.source_id } : {}),
      }).nested_external))) {
      // Reprove source field/ancestry and retain every saved identity, field and usage claim.
      occurrenceById.set(occurrence.occurrence_id, { ...existingOccurrence, external_standard: {
        ...existingOccurrence.external_standard, expansion: "literal_only", expansion_reason: occurrence.external_standard.expansion_reason,
        ...(occurrence.external_standard.user_ignore ? { user_ignore: occurrence.external_standard.user_ignore } : {}),
      } });
    }
    const { evidence_fingerprint: _fingerprint, ...base } = current;
    const payload = {
      ...base,
      evidence: [...evidenceById.values()],
      reference_occurrences: [...occurrenceById.values()],
    };
    const updated = await this.withRegisteredTableFragments({ ...payload, evidence_fingerprint: sha256Json(payload) });
    // Archive the complete prior decision before changing active obligations.
    // A crash here leaves the old decision active; it never loses its provenance.
    if (correction && previousCorrection) {
      const history = await this.readReferenceCorrections();
      await atomicWriteJson(join(this.root, "reference-corrections.json"), [...history, {
        previous_occurrence: previousCorrection, replacement_occurrence_id: occurrence.occurrence_id,
        reason: correction.reason, timestamp: new Date().toISOString(),
      }]);
    }
    if (updated.evidence_fingerprint !== current.evidence_fingerprint) {
      if (observationPlan) {
        if (await pathExists(join(this.coverageReviewDirectory, observationPlan, "coverage-review.json"))) {
          throw new Error("A sealed review cannot acquire new reference observations");
        }
        await atomicWriteJson(join(this.coverageReviewDirectory, observationPlan, "reference-observations.json"), updated);
      } else {
        await chmod(this.evidenceManifestPath, 0o644);
        await atomicWriteJson(this.evidenceManifestPath, updated);
        await makeReadOnly(this.evidenceManifestPath);
      }
    }

    let registry = await this.readSourceSpanRegistry();
    registry = { ...registry, source_fingerprint: observationPlan
      ? (await this.readEvidenceManifest()).evidence_fingerprint : updated.evidence_fingerprint };
    for (const record of records) {
      registry = registerSourceSpan(
        registry,
        {
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        },
        0,
        record.text.length,
      ).registry;
    }
    await atomicWriteJson(this.sourceSpanRegistryPath, registry);
    return { manifest: updated, registry };
  }

  /** Reattach parser metadata only for complete, already registered source records. */
  private async withRegisteredTableFragments(current: EvidenceManifest): Promise<EvidenceManifest> {
    const known = new Set(current.table_fragments.map(fragment => fragment.fragment_id));
    const missing = new Set(current.evidence.flatMap(record =>
      record.table_fragment_id && !known.has(record.table_fragment_id) ? [record.table_fragment_id] : []));
    if (!missing.size) return current;
    const markdown = await readFile(this.sourceMarkdownPath, "utf8");
    if (sha256Text(markdown) !== current.source.sha256) {
      throw new Error("reference_table_metadata_source_mismatch: 原文哈希已变化，无法恢复引用表目录；请恢复该 job 的原始 source.md，不要改 selector 或编造 fragment ID。");
    }
    const parsed = buildStructuredTargetEvidence(markdown, current.source.sha256,
      [{ start_line: 1, end_exclusive_line: markdown.replace(/\r\n?/gu, "\n").split("\n").length + 1 }], false);
    const proseReferences = [...missing].some((id) => id.startsWith("reference-table-fragment:"))
      ? buildReferenceScopeEvidence(markdown, current.source.sha256,
          [{ start_line: 1, end_exclusive_line: markdown.replace(/\r\n?/gu, "\n").split("\n").length + 1 }])
      : { evidence: [], table_fragments: [] };
    const records = new Map(current.evidence.map(record => [record.evidence_id, record]));
    const parsedRecords = new Map([...parsed.evidence, ...proseReferences.evidence].map(record => [record.evidence_id, record]));
    const fragments = [...parsed.table_fragments, ...proseReferences.table_fragments].filter(fragment => missing.has(fragment.fragment_id)
      && [...fragment.row_evidence_ids, ...fragment.title_candidate_evidence_ids,
        ...(fragment.continuation_caption_evidence_ids ?? [])].every(id => {
        const existing = records.get(id), original = parsedRecords.get(id);
        return existing && original && existing.locator === original.locator
          && existing.text === original.text && existing.text_sha256 === original.text_sha256;
      }));
    if (!fragments.length) return current;
    const { evidence_fingerprint: _fingerprint, ...base } = current;
    const payload = { ...base, table_fragments: [...current.table_fragments, ...fragments] };
    return { ...payload, evidence_fingerprint: sha256Json(payload) };
  }

  /** Startup migration for unvalidated working drafts; sealed/validated artifacts stay frozen. */
  async restoreRegisteredTableFragments(): Promise<void> {
    const state = await this.readState();
    if (state.status !== "working" || state.validation_attempts > 0
      || state.last_valid_fingerprint || await pathExists(this.manifestPath)) return;
    const current = await this.readEvidenceManifest();
    const updated = await this.withRegisteredTableFragments(current);
    const registry = await this.readSourceSpanRegistry();
    const receiptPath = join(this.root, "table-metadata-restoration.json");
    if (updated === current) {
      // A crash may have occurred after the manifest rename but before the
      // registry rename. Replay only the exact write-ahead receipt, never an
      // arbitrary fingerprint mismatch or a changed span registry.
      if (registry.source_fingerprint !== current.evidence_fingerprint && await pathExists(receiptPath)) {
        const receipt = await readJson<{ evidence_fingerprint: string; registry_before_sha256: string }>(receiptPath);
        if (receipt.evidence_fingerprint === current.evidence_fingerprint
          && receipt.registry_before_sha256 === sha256Json(registry)) {
          await atomicWriteJson(this.sourceSpanRegistryPath, { ...registry, source_fingerprint: current.evidence_fingerprint });
        }
      }
      return;
    }
    await atomicWriteJson(receiptPath, {
      previous_evidence_fingerprint: current.evidence_fingerprint,
      evidence_fingerprint: updated.evidence_fingerprint,
      registry_before_sha256: sha256Json(registry),
    });
    await chmod(this.evidenceManifestPath, 0o644);
    await atomicWriteJson(this.evidenceManifestPath, updated);
    await makeReadOnly(this.evidenceManifestPath);
    await atomicWriteJson(this.sourceSpanRegistryPath, { ...registry, source_fingerprint: updated.evidence_fingerprint });
    await this.appendEvent("registered_table_metadata_restored", {
      fragment_ids: updated.table_fragments.filter(f => !current.table_fragments.some(old => old.fragment_id === f.fragment_id)).map(f => f.fragment_id),
      previous_evidence_fingerprint: current.evidence_fingerprint,
      evidence_fingerprint: updated.evidence_fingerprint,
      selector_changed: false, semantic_approval: false,
    });
  }

  async upgradeWorkingPlanToCurrent(): Promise<boolean> {
    const state = await this.readState();
    if (state.status !== "working") return false;
    const input = await readJson<unknown>(this.workingPlanPath);
    const prepared = preparePersistedPlanForWorking(
      input,
      await this.readEvidenceManifest(),
    );
    if (sha256Json(input) === sha256Json(prepared)) return false;
    await atomicWriteJson(
      this.workingPlanPath,
      prepared,
    );
    return true;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationTail;
    let release!: () => void;
    this.stateMutationTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async readState(): Promise<RevisionState> {
    return this.withStateLock(() => readJson<RevisionState>(this.statePath));
  }

  async writeState(state: RevisionState): Promise<void> {
    await this.withStateLock(() => atomicWriteJson(this.statePath, state));
  }

  async transactState<T>(
    mutator: (state: RevisionState) => Promise<T> | T,
  ): Promise<T> {
    return this.withStateLock(async () => {
      const state = await readJson<RevisionState>(this.statePath);
      const result = await mutator(state);
      await atomicWriteJson(this.statePath, state);
      return result;
    });
  }

  async updateState(mutator: (state: RevisionState) => void): Promise<RevisionState> {
    return this.transactState((state) => {
      mutator(state);
      return structuredClone(state);
    });
  }

  async recordDocumentReferenceReadProgress(
    occurrenceId: string,
    progress: NonNullable<RevisionState["document_reference_reads"]>[string],
  ): Promise<void> {
    await this.updateState((state) => {
      const reads = { ...(state.document_reference_reads ?? {}) };
      const phase = progress.phase ?? "target";
      if (progress.target_key) {
        for (const [registeredOccurrenceId, registered] of Object.entries(reads)) {
          if (
            registered.target_key === progress.target_key
            && (registered.phase ?? "target") === phase
          ) reads[registeredOccurrenceId] = progress;
        }
      }
      reads[phase === "coverage" ? `coverage:${occurrenceId}` : occurrenceId] = progress;
      state.document_reference_reads = reads;
    });
  }

  async setRuntime(runtime: RevisionState["agent_runtime"]): Promise<void> {
    await this.updateState((state) => {
      state.agent_runtime = runtime;
    });
  }

  async markTerminal(
    status: "failed" | "cancelled",
    reason: string,
    structured: {
      blocker_code?: string;
      failure_class?: RevisionState["terminal_failure_class"];
    } = {},
  ): Promise<void> {
    await this.updateState((state) => {
      if (state.status === "sealed") return;
      state.status = status;
      state.terminal_at = new Date().toISOString();
      state.terminal_reason = reason;
      if (structured.blocker_code) state.terminal_blocker_code = structured.blocker_code;
      else delete state.terminal_blocker_code;
      if (structured.failure_class) state.terminal_failure_class = structured.failure_class;
      else delete state.terminal_failure_class;
    });
  }

  async appendEvent(eventType: string, payload: unknown): Promise<TranscriptEvent> {
    return this.transactState(async (state) => {
      const event: TranscriptEvent = {
        schema_version: "agent-event/v1",
        sequence: state.next_event_sequence,
        timestamp: new Date().toISOString(),
        runtime: state.agent_runtime,
        event_type: eventType,
        payload,
      };
      await appendText(this.transcriptPath, `${JSON.stringify(event)}\n`);
      state.next_event_sequence += 1;
      return event;
    });
  }

  async transcriptPrefix(): Promise<{
    through_sequence: number;
    sha256: string;
    byte_length: number;
  }> {
    return this.withStateLock(async () => {
      const state = await readJson<RevisionState>(this.statePath);
      const hash = createHash("sha256");
      let byteLength = 0;
      if (await pathExists(this.transcriptPath)) {
        for await (const chunk of createReadStream(this.transcriptPath)) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(bytes);
          byteLength += bytes.length;
        }
      }
      return {
        through_sequence: state.next_event_sequence - 1,
        sha256: hash.digest("hex"),
        byte_length: byteLength,
      };
    });
  }

  async writeWorkingPlan(content: string): Promise<void> {
    const state = await this.readState();
    if (state.status !== "working" || (await pathExists(this.manifestPath))) {
      throw new Error("This revision is sealed; create a new revision before editing");
    }
    await atomicWriteText(this.workingPlanPath, content);
  }

  async readSourceSpanRegistry(): Promise<SourceSpanRegistry> {
    return readJson<SourceSpanRegistry>(this.sourceSpanRegistryPath);
  }

  async writeWorkingSelectors(content: string): Promise<void> {
    const state = await this.readState();
    if (state.status !== "working" || (await pathExists(this.manifestPath))) {
      throw new Error("This revision is sealed; create a new revision before editing");
    }
    await atomicWriteText(this.workingSelectorPath, content);
  }

  async writeBestSelectors(content: string): Promise<void> {
    const state = await this.readState();
    if (state.status !== "working" || (await pathExists(this.manifestPath))) {
      throw new Error("This revision is sealed; create a new revision before editing");
    }
    await atomicWriteText(this.bestSelectorPath, content);
  }
}
