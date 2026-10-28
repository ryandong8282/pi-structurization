import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  EditorHierarchyController,
  EditorHierarchyWorkspace,
  validateEditorHierarchyPlan,
  type EditorHierarchyProgress,
  type EditorHierarchyPlan,
  type HierarchyConfirmContext,
} from "./editor-hierarchy.js";
import { pathExists, readJson } from "./atomic.js";
import { prettyJson } from "./canonical.js";
import { runLiveEditorHierarchyCandidate } from "./pi-runtime.js";
import type { PiAgentRuntimeModelConfig } from "./presets.js";
import { scanDocumentLedger, type DocumentLedger } from "./document-ledger.js";
import {
  assembleEditorHierarchyFromLedger,
  hierarchyConfirmContextFromLedger,
  loadAutoSpecKeep,
  loadStandaloneSpecTree,
  standardHintFromFilename,
} from "./editor-hierarchy-assemble.js";
import {
  classifyTargetFailure,
  DEFAULT_TARGET_TRANSPORT_RETRIES,
  recordTransportFailure,
  targetTransportRetryDelayMs,
  type TransportRetryWindow,
} from "./attempt-budget.js";

export interface EditorHierarchyRunOptions {
  artifactRoot: string;
  jobId: string;
  markdownPath: string;
  aggregatePath: string;
  batch: Record<string, unknown>;
  maxAttempts: number;
  signal?: AbortSignal;
  onProgress?: (progress: EditorHierarchyProgress & {
    total_atoms: number;
    total_lots: number;
  }) => void | Promise<void>;
  modelConfig?: PiAgentRuntimeModelConfig;
  userFeedback?: string;
}

export interface EditorHierarchyRunResult {
  workspace: EditorHierarchyWorkspace;
  plan: EditorHierarchyPlan;
  model: string;
  /** 独立复核已撤：候选通过全套确定性校验后直接封印。历史复核封印的 manifest 带 independent_review 标记。 */
  reviewed: boolean;
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%", "_");
}

async function readDiscoveryLedger(artifactRoot: string, jobId: string, markdown: string, fileName: string): Promise<DocumentLedger> {
  const path = join(artifactRoot, "jobs", encodedSegment(jobId), "discovery", "document-ledger.json");
  if (await pathExists(path)) return readJson<DocumentLedger>(path);
  return scanDocumentLedger(markdown, fileName);
}

/**
 * 层级阶段：确定性装配提供草稿；由一次 LLM 会话确认组织映射、名称与归属。
 */
export async function runEditorHierarchy(
  options: EditorHierarchyRunOptions,
): Promise<EditorHierarchyRunResult> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 20) {
    throw new Error("Hierarchy maxAttempts must be an integer between 1 and 20");
  }
  options.signal?.throwIfAborted();
  const aggregate = JSON.parse(await readFile(options.aggregatePath, "utf8")) as Record<string, unknown>;
  const markdown = await readFile(options.markdownPath, "utf8");
  const workspace = await EditorHierarchyWorkspace.openOrCreate(
    options.artifactRoot,
    options.jobId,
    options.markdownPath,
    aggregate,
    options.batch,
  );
  const evidence = await workspace.readEvidence();
  if (options.onProgress) {
    workspace.setProgressListener((progress) => options.onProgress!({
      ...progress,
      total_atoms: evidence.document.atoms.length,
      total_lots: evidence.lots.length,
    }));
  }
  let state = await workspace.readState();
  if (state.status === 'working' && options.userFeedback) {
    const baselinePath = join(options.artifactRoot, 'jobs', encodedSegment(options.jobId), 'dialogue-hierarchy-baseline.json');
    const current = await readJson<EditorHierarchyPlan>(workspace.workingPlanPath);
    if (!current.nodes.length && await pathExists(baselinePath)) {
      const baseline = await readJson<EditorHierarchyPlan>(baselinePath);
      await workspace.writePlan(prettyJson({ ...baseline, job_id: evidence.job_id,
        evidence_fingerprint: evidence.evidence_fingerprint, business_result_sha256: evidence.business_result_sha256 }));
    }
  }
  let model = "ledger-assembly";
  if (state.status === "working") {
    const ledger = await readDiscoveryLedger(
      options.artifactRoot,
      options.jobId,
      markdown,
      basename(options.markdownPath),
    );
    const specTree = await loadStandaloneSpecTree();
    const keepNames = await loadAutoSpecKeep(standardHintFromFilename(basename(options.markdownPath)));
    const assembled = assembleEditorHierarchyFromLedger({
      evidence,
      ledger,
      specTree,
      keepNames,
    });
    // Scheduling boundaries are not business units; never seal the unconfirmed assembly.
    const needsConfirm = assembled.plan.nodes.some((node) => node.node_type === "分项")
      || assembled.uncertain_lot_keys.length > 0;
    if (needsConfirm) {
      const working = await readJson<EditorHierarchyPlan>(workspace.workingPlanPath);
      if (!working.nodes.length || working.inspection_units === undefined) {
        await workspace.writePlan(prettyJson(assembled.plan));
      }
      for (const atom of evidence.document.atoms) await workspace.markAtomOpened(atom.atom_id, false);
      for (const lot of evidence.lots) await workspace.markLotOpened(lot.lot_key, false);
      const confirmContext: HierarchyConfirmContext = hierarchyConfirmContextFromLedger(ledger, assembled);
      const controller = await EditorHierarchyController.create(workspace, "candidate", confirmContext);
      let candidateAttempts = 0;
      let resumeCandidate = Boolean(state.agent_runtime?.session_file);
      let transportWindow: TransportRetryWindow | undefined;
      let lastFailureMessage: string | undefined;

      while (state.status === "working") {
        options.signal?.throwIfAborted();
        const checkpoint = state.agent_runtime?.session_file ?? state.status;
        let sessionError: string | undefined;
        try {
          const result = await runLiveEditorHierarchyCandidate(
            workspace,
            controller,
            resumeCandidate,
            options.signal,
            confirmContext,
            options.modelConfig,
            options.userFeedback,
          );
          model = `${model} + confirm:${result.model}`;
          if (result.error) {
            sessionError = result.error;
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          sessionError = error instanceof Error ? error.message : String(error);
        }

        resumeCandidate = true;
        state = await workspace.readState();
        if (state.status === "candidate") break;

        if (sessionError) {
          lastFailureMessage = sessionError;
          const failureClass = classifyTargetFailure(sessionError);
          if (failureClass === "provider_configuration") {
            throw new Error(`Editor hierarchy semantic confirmation failed with provider configuration error; sealed extraction and hierarchy draft are retained. Cause: ${sessionError}`);
          }
          if (failureClass === "transport") {
            transportWindow = recordTransportFailure(transportWindow, checkpoint, sessionError);
            if (transportWindow.consecutive_failures > DEFAULT_TARGET_TRANSPORT_RETRIES) {
              const key = transportWindow.error_key ?? "transport";
              throw new Error(`Editor hierarchy semantic confirmation failed with consecutive transport errors (${key}); sealed extraction and hierarchy draft are retained. Resume the hierarchy stage after resolving network/provider connectivity. Cause: ${sessionError}`);
            }
            const delayMs = targetTransportRetryDelayMs(sessionError, transportWindow.consecutive_failures);
            if (delayMs > 0 && !options.signal?.aborted) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)));
            }
            continue;
          }
        }

        transportWindow = undefined;
        candidateAttempts += 1;
        if (candidateAttempts >= options.maxAttempts) {
          if (lastFailureMessage) {
            throw new Error(`Editor hierarchy semantic confirmation failed after ${candidateAttempts} attempts; sealed extraction and hierarchy draft are retained. Cause: ${lastFailureMessage}`);
          }
          throw new Error("Editor hierarchy has no submitted semantic candidate. Resume the hierarchy session, complete inspection_units and lot_bindings with patch_hierarchy_plan, validate_hierarchy_plan, then submit_hierarchy_candidate. Sealed extraction is unchanged.");
        }
      }
    } else {
      throw new Error("Editor hierarchy has no division candidate for its sealed lots; inspect the current source and hierarchy draft before retrying. No unconfirmed hierarchy was published.");
    }
  }
  let reviewed = false;
  if (state.status === "sealed") {
    reviewed = await readJson<{ independent_review?: unknown }>(workspace.manifestPath)
      .then((manifest) => manifest.independent_review !== "skipped")
      .catch(() => true);
  }
  if (state.status === "candidate") {
    const controller = await EditorHierarchyController.create(workspace, "candidate");
    const directSeal = await controller.sealCandidateWithoutReview();
    if (!directSeal.ok) {
      throw new Error(`Editor hierarchy candidate failed deterministic validation for direct seal: ${JSON.stringify(directSeal.issues ?? directSeal.error)}`);
    }
    state = await workspace.readState();
    reviewed = false;
  }
  if (state.status !== "sealed" || !(await pathExists(workspace.manifestPath))) {
    throw new Error("Editor hierarchy has no sealed manifest");
  }
  const plan = await readJson<EditorHierarchyPlan>(workspace.sealedPlanPath);
  const validation = validateEditorHierarchyPlan(
    plan,
    evidence,
    new Set(evidence.document.atoms.map((atom) => atom.atom_id)),
    new Set(evidence.lots.map((lot) => lot.lot_key)),
  );
  if (!validation.ok) throw new Error(`Sealed editor hierarchy no longer satisfies the current contract: ${JSON.stringify(validation.issues.slice(0, 20))}`);
  return { workspace, plan, model, reviewed };
}
