import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  batchTargetSelected,
  coverageControllerPendingTargetPatch,
  coverageControllerResumeHandoff,
  coverageRepairBudgetStatus,
  coverageRepairStructureFingerprint,
  runCoverageReviewWithBoundedControllerRebuild,
  runFullBatch,
  refreshFullBatchSummary,
  scopeRefreshSourceFingerprint,
  runFullDocumentDiscovery,
  targetDurableCheckpoint,
  type FullBatchOptions,
  type FullBatchState,
} from "../src/batch.js";
import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
  DocumentDiscoveryController,
  DocumentDiscoveryWorkspace,
  targetEvidenceLineSpan,
  type DocumentTargetPlan,
} from "../src/document-discovery.js";
import * as piRuntime from "../src/pi-runtime.js";
import * as coverageRisk from "../src/coverage-risk-gate.js";
import * as attemptBudget from "../src/attempt-budget.js";
import * as targetTools from "../src/tools.js";
import {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  CoverageReviewController,
  sealDeterministicCleanCoverageReview,
} from "../src/coverage-review.js";
import type { SemanticSourcePlan } from "../src/contracts.js";
import { runOfflineFixture, ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
} from "../src/target-selector-compiler.js";
import { registerSourceSpan } from "../src/source-span-registry.js";
import { validatePlanText } from "../src/validator.js";

const TARGET_IDS = ["target-valid", "target-revise-a", "target-revise-b"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileTreeSnapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await fileTreeSnapshot(path, relative));
    } else if (entry.isFile()) {
      snapshot[relative] = (await readFile(path)).toString("base64");
    }
  }
  return snapshot;
}

describe("coverage repair budget authority", () => {
  const fingerprint = "a".repeat(64);

  test("uses the current revision committed count instead of batch lifetime telemetry", () => {
    expect(coverageRepairBudgetStatus({
      selector_protocol: { coverage_repairs: 0 },
    }, fingerprint, 1)).toEqual({
      continuing_transaction: false,
      committed_repairs: 0,
      available: true,
    });
  });

  test("allows repeated staging within the same durable coverage transaction", () => {
    expect(coverageRepairBudgetStatus({
      selector_protocol: { coverage_repairs: 1 },
      coverage_recheck: {
        schema_version: "coverage-recheck-scope/v1",
        plan_fingerprint: fingerprint,
      },
    }, fingerprint, 1)).toEqual({
      continuing_transaction: true,
      committed_repairs: 1,
      available: true,
    });
  });

  test("keeps a rolled-back repair source inside the same durable coverage transaction", () => {
    expect(coverageRepairBudgetStatus({
      selector_protocol: { coverage_repairs: 1 },
      coverage_recheck: {
        schema_version: "coverage-recheck-scope/v1",
        plan_fingerprint: "b".repeat(64),
        source_plan_fingerprint: fingerprint,
      },
    }, fingerprint, 1)).toEqual({
      continuing_transaction: true,
      committed_repairs: 1,
      available: true,
    });
  });

  test("rejects a new transaction after the current revision committed budget is exhausted", () => {
    expect(coverageRepairBudgetStatus({
      selector_protocol: { coverage_repairs: 1 },
      coverage_recheck: {
        schema_version: "coverage-recheck-scope/v1",
        plan_fingerprint: "b".repeat(64),
      },
    }, fingerprint, 1)).toEqual({
      continuing_transaction: false,
      committed_repairs: 1,
      available: false,
    });
  });
});

describe("coverage controller rebuild control", () => {
  test("rebuilds once from current durable state in the same job and target", async () => {
    const staleFingerprint = "a".repeat(64);
    const currentFingerprint = "b".repeat(64);
    const workspace = {
      jobId: "same-job",
      targetId: "same-target",
      revision: 3,
      root: "same-workspace",
      readState: vi.fn(async () => ({
        last_valid_fingerprint: currentFingerprint,
        last_valid_plan_sha256: "c".repeat(64),
      })),
      appendEvent: vi.fn(async () => undefined),
    } as unknown as RevisionWorkspace;
    const sealedReview = { status: "approved" } as any;
    const runReview = vi.fn()
      .mockResolvedValueOnce({
        sealed: false,
        terminal: true,
        model: "coverage-controller-stale",
        error: "coverage_review_candidate_changed",
        control: {
          kind: "coverage_controller_rebuild",
          stale_plan_fingerprint: staleFingerprint,
          current_plan_fingerprint: currentFingerprint,
        },
      })
      .mockResolvedValueOnce({ sealed: true, model: "review-model", review: sealedReview });
    const scope = {
      mode: "full" as const,
      affected_item_ids: [],
      affected_evidence_ids: [],
      finding_ids: [],
    };

    const result = await runCoverageReviewWithBoundedControllerRebuild(
      workspace,
      staleFingerprint,
      undefined,
      scope,
      undefined,
      runReview,
    );

    expect(result).toMatchObject({
      plan_fingerprint: currentFingerprint,
      controller_rebuilds: 1,
      coverage: { sealed: true, review: sealedReview },
    });
    expect(runReview.mock.calls.map((call) => call[0])).toEqual([workspace, workspace]);
    expect(runReview.mock.calls.map((call) => call[1])).toEqual([staleFingerprint, currentFingerprint]);
    expect(workspace.readState).toHaveBeenCalledTimes(2);
    expect(workspace.appendEvent).toHaveBeenCalledWith(
      "coverage_review_controller_rebuilt",
      expect.objectContaining({
        job_id: "same-job",
        target_id: "same-target",
        revision: 3,
        stale_plan_fingerprint: staleFingerprint,
        current_plan_fingerprint: currentFingerprint,
      }),
    );
  });

  test("stops bounded rebuilding when durable state cannot advance the fingerprint", async () => {
    const fingerprint = "a".repeat(64);
    const workspace = {
      jobId: "same-job",
      targetId: "same-target",
      revision: 3,
      root: "same-workspace",
      readState: vi.fn(async () => ({
        last_valid_fingerprint: fingerprint,
        last_valid_plan_sha256: "c".repeat(64),
      })),
      appendEvent: vi.fn(async () => undefined),
    } as unknown as RevisionWorkspace;
    const stale = {
      sealed: false,
      terminal: true,
      model: "coverage-controller-stale",
      error: "coverage_review_candidate_changed",
      control: { kind: "coverage_controller_rebuild" },
    };
    const runReview = vi.fn(async () => stale);

    const result = await runCoverageReviewWithBoundedControllerRebuild(
      workspace,
      fingerprint,
      undefined,
      { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
      undefined,
      runReview,
    );

    expect(runReview).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      plan_fingerprint: fingerprint,
      controller_rebuilds: 0,
      coverage: {
        sealed: false,
        terminal: true,
        error: "coverage_controller_rebuild_no_progress",
        control: { kind: "coverage_controller_rebuild", retryable: true },
      },
    });

    const pending = coverageControllerPendingTargetPatch(
      result.coverage,
      result.plan_fingerprint,
      workspace,
    );
    expect(pending).toMatchObject({
      status: "pending",
      error: "coverage_controller_rebuild_no_progress",
      coverage_control: {
        schema_version: "coverage-controller-pending/v2",
        kind: "coverage_controller_rebuild",
        job_id: "same-job",
        target_id: "same-target",
        revision: 3,
        workdir: "same-workspace",
        plan_fingerprint: fingerprint,
        receipt: { retryable: true, same_job_required: true },
      },
    });
    expect(pending).not.toHaveProperty("last_failure_class");

    const currentFingerprint = "b".repeat(64);
    const handoff = coverageControllerResumeHandoff(
      pending!.coverage_control,
      workspace,
      currentFingerprint,
    );
    expect(handoff).toMatchObject({
      session_id: "coverage-controller-durable-resume",
      sealed: false,
      review_required: true,
      review_plan_fingerprint: currentFingerprint,
    });
    const currentWorkspace = workspace.readState as ReturnType<typeof vi.fn>;
    currentWorkspace.mockResolvedValue({
      last_valid_fingerprint: currentFingerprint,
      last_valid_plan_sha256: "d".repeat(64),
    });
    const resumedReview = vi.fn(async () => ({
      sealed: true,
      model: "review-model",
      review: { status: "approved" } as any,
    }));
    const resumed = await runCoverageReviewWithBoundedControllerRebuild(
      workspace,
      handoff.review_plan_fingerprint!,
      undefined,
      { mode: "full", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
      undefined,
      resumedReview,
    );
    expect(resumed.coverage.sealed).toBe(true);
    expect(resumed.plan_fingerprint).toBe(currentFingerprint);
    expect(resumedReview).toHaveBeenCalledWith(
      workspace,
      currentFingerprint,
      undefined,
      expect.any(Object),
      undefined,
    );
    expect(workspace.revision).toBe(3);
    expect(() => coverageControllerResumeHandoff(
      pending!.coverage_control,
      { ...workspace, revision: 4 },
      currentFingerprint,
    )).toThrow("coverage_controller_resume_identity_mismatch");
  });
});

describe("coverage repair progress fingerprint", () => {
  test("tracks exact sampling and reference progress while ignoring generated item-id churn", () => {
    const item = {
      item_id: "item:first",
      name: "混凝土含气量检验",
      category: "一般项目",
      requirement: "含气量应符合规定。",
      method: "检查试验报告。",
      quantity: "同一配合比取样不应少于一次。",
      note: "",
      evidence_ids: ["evidence:criterion"],
      reference_evidence_ids: [],
      reference_resolution_ids: [],
      reference_origin_item_id: "item:first",
      reference_path: [],
      source_clause: "7.3.7",
      reference_source_clause: "",
      reference_from_clause: "",
      inline_references: [],
      table_semantics: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "核验试验报告。",
      inspection_data_type_evidence_ids: ["evidence:criterion"],
      sampling: {
        status: "reference",
        min_sampling: "同一配合比取样不应少于一次。",
        script: "试验方法标",
        reason: "跨行取样规则",
        confidence: 1,
        evidence_ids: ["evidence:sampling-prefix"],
        rule_ids: ["rule:7.3.7"],
        branch_ids: ["branch:same-mix"],
        applied_branches: [],
      },
    } as any;
    const initial = coverageRepairStructureFingerprint([item]);
    const idOnly = coverageRepairStructureFingerprint([{
      ...item,
      item_id: "item:renamed",
      reference_origin_item_id: "item:renamed",
    }]);
    const completedScript = coverageRepairStructureFingerprint([{
      ...item,
      sampling: {
        ...item.sampling,
        script: "试验方法标准》GB/T 50080 的规定。",
        evidence_ids: ["evidence:sampling-prefix", "evidence:sampling-continuation"],
      },
    }]);
    const routedReference = coverageRepairStructureFingerprint([{
      ...item,
      reference_resolution_ids: ["resolution:gbt50080"],
      reference_path: ["external-standard:GB/T50080"],
    }]);

    expect(idOnly).toBe(initial);
    expect(completedScript).not.toBe(initial);
    expect(routedReference).not.toBe(initial);
  });
});

test("a resume target allowlist selects only explicit target IDs", () => {
  expect(batchTargetSelected("target:a", undefined)).toBe(true);
  expect(batchTargetSelected("target:a", [])).toBe(true);
  expect(batchTargetSelected("target:a", ["target:a", "target:b"])).toBe(true);
  expect(batchTargetSelected("target:c", ["target:a", "target:b"])).toBe(false);
});

test("fresh targets must also be explicitly selected", async () => {
  await expect(runFullBatch({
    artifactRoot: "unused",
    jobId: "unused",
    markdownPath: "unused.md",
    concurrency: 1,
    maxAttempts: 1,
    targetIds: ["target:selected"],
    freshTargetIds: ["target:not-selected"],
    live: false,
  })).rejects.toThrow(/freshTargetIds must also be included in targetIds/);
});

function discoveryPlan(jobId: string, markdown: string): DocumentTargetPlan {
  const evidence = buildDocumentEvidence(markdown, "source.md");
  const atom = evidence.atoms[0]!;
  return {
    schema_version: "document-target-plan/v4",
    job_id: jobId,
    document_fingerprint: evidence.evidence_fingerprint,
    targets: TARGET_IDS.map((targetId) => ({
      target_id: targetId,
      group_id: "group-foundation",
      group_name: "地基工程",
      group_reason: "同属地基工程验收语义组",
      name: targetId,
      description: `${targetId} 的验收项目`,
      evidence_atom_ids: [atom.atom_id],
      evidence_fragments: [{ atom_id: atom.atom_id, text: "地基承载力应满足设计要求" }],
      materialization: {
        kind: "inspection_scope" as const,
        lot_basis_summary: "以地基承载力是否满足设计要求作为检验批划分依据",
        lot_basis_fragments: [{ atom_id: atom.atom_id, text: "地基承载力应满足设计要求" }],
        reason: "原文直接规定可形成检验批的地基实体质量要求",
      },
      reason: "原文包含独立验收要求",
    })),
    context_notes: [],
    dispositions: [{
      atom_id: atom.atom_id,
      disposition: "target",
      target_ids: [...TARGET_IDS],
      reason: "该原子包含三个测试目标",
    }],
  };
}

function confirmedDiscoveryPlan(jobId: string, markdown: string): DocumentTargetPlan {
  const plan = discoveryPlan(jobId, markdown);
  // These continuation tests exercise one controlled target. A confirmed
  // primary range cannot be assigned wholesale to three different owners.
  plan.targets = [plan.targets[0]!];
  plan.dispositions[0]!.target_ids = [TARGET_IDS[0]];
  const documentEvidence = buildDocumentEvidence(markdown, "source.md");
  const atom = documentEvidence.atoms[0]!;
  const wholeAtom = {
    atom_id: atom.atom_id,
    start: 0,
    end: atom.text.length,
    text: atom.text,
    text_sha256: sha256Text(atom.text),
  };
  for (const target of plan.targets) {
    target.work_scope = {
      start_line: atom.start_line,
      end_exclusive_line: atom.start_line + (atom.text.match(/\n/gu)?.length ?? 0) + 1,
      source_sha256: documentEvidence.source.sha256,
      primary_fragments: [wholeAtom],
      source_blocks: [{
        kind: "explicit_range",
        anchor_fragment: wholeAtom,
        start_fragment: wholeAtom,
        end_fragment: wholeAtom,
        reason: "单一连续测试原文构成完整目标范围。",
      }],
      reason: "测试发现计划显式提交完整主资料范围。",
    };
  }
  return plan;
}

describe("full batch target scheduling", () => {
  test("source pause keeps a scheduled transport retry pending and resumes the same checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-source-transport-"));
    const retryDelay = vi.spyOn(attemptBudget, "targetTransportRetryDelayMs").mockReturnValue(5_000);
    let releaseScheduled!: () => void;
    const scheduled = new Promise<void>(resolve => { releaseScheduled = resolve; });
    const append = RevisionWorkspace.prototype.appendEvent;
    const eventSpy = vi.spyOn(RevisionWorkspace.prototype, "appendEvent").mockImplementation(async function(type, payload) {
      await append.call(this, type, payload);
      if (type === "target_transport_retry_scheduled") releaseScheduled();
    });
    let ready = false, savedSelectors = "", networkCalls = 0;
    const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (workspace, controller, _resume, _signal, transportRecovery) => {
      if (ready) {
        if (workspace.targetId === TARGET_IDS[0]) {
          networkCalls++;
          expect(transportRecovery).toBe(true);
          expect(workspace.revision).toBe(1);
          expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(savedSelectors);
        }
        expect(await runOfflineFixture(workspace, controller)).toMatchObject({ ok: true });
        return { sealed: true, model: "neutral", session_id: "neutral", session_file: "" };
      }
      if (workspace.targetId === TARGET_IDS[0]) {
        networkCalls++;
        savedSelectors = await readFile(workspace.workingSelectorPath, "utf8");
        return { sealed: false, model: "neutral", session_id: "neutral", session_file: "", error: "HTTP 503 temporarily unavailable" };
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([scheduled, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Network retry was never scheduled")), 5_000); })]);
      } finally { clearTimeout(deadline); }
      return { sealed: false, model: "neutral", session_id: "neutral", session_file: "", waiting_for_source: {
        standard_no: "XQ 955-2001", target_id: workspace.targetId, occurrence_id: "reference:neutral",
        origin_excerpt: "按虚构规程检查", origin_locator: "line:1", dependent_fields: ["method"], reason: "中性资料等待",
      } };
    });
    try {
      const paragraphs = ["地基承载力应满足设计要求。".repeat(20), "地基承载力应满足设计要求。另一独立范围。".repeat(20)];
      const markdown = paragraphs.join("\n\n");
      const markdownPath = join(root, "source.md"), discoveryPlanPath = join(root, "plan.json");
      const plan = discoveryPlan("pause-retry", markdown);
      const document = buildDocumentEvidence(markdown, "source.md");
      expect(document.atoms).toHaveLength(1);
      plan.targets = plan.targets.slice(0, 2);
      plan.dispositions[0]!.target_ids = [...TARGET_IDS.slice(0, 2)];
      plan.targets.forEach((target, index) => {
        const atom = document.atoms[0]!, start = index ? paragraphs[0]!.length + 2 : 0, text = paragraphs[index]!;
        const fragment = { atom_id: atom.atom_id, start, end: start + text.length, text, text_sha256: sha256Text(text) };
        target.evidence_atom_ids = [atom.atom_id]; target.evidence_fragments = [{ atom_id: atom.atom_id, text }];
        target.materialization!.lot_basis_fragments = [{ atom_id: atom.atom_id, text }];
        target.work_scope = { start_line: atom.start_line + 2 * index, end_exclusive_line: atom.start_line + 2 * index + 1,
          source_sha256: document.source.sha256, primary_fragments: [fragment], reason: "独立原文范围",
          source_blocks: [{ kind: "explicit_range", anchor_fragment: fragment, start_fragment: fragment, end_fragment: fragment, reason: "独立原文范围" }] };
      });
      await writeFile(markdownPath, markdown); await writeFile(discoveryPlanPath, prettyJson(plan));
      const options: FullBatchOptions = { artifactRoot: join(root, "artifacts"), jobId: "pause-retry", markdownPath,
        concurrency: 2, maxAttempts: 3, live: true };
      await runFullDocumentDiscovery({ ...options, live: false, discoveryPlanPath });
      const paused = await runFullBatch(options);
      expect(paused.status).toBe("waiting_for_source");
      expect(paused.targets[0]).toMatchObject({ status: "pending", revision: 1,
        attempt_counters: { transport_attempts: 1, candidate_validation_attempts: 0, coverage_repair_attempts: 0 } });
      expect(networkCalls).toBe(1);
      ready = true;
      // Source reconciliation also releases its own failed/empty-error target.
      const resumed = await runFullBatch({ ...options, targetIds: paused.targets.filter(t => t.status === "pending"
        || (t.target_id === TARGET_IDS[1] && t.status === "failed" && !t.error)).map(t => t.target_id) });
      expect(resumed.targets.every(t => t.status === "sealed"), prettyJson(resumed.targets.map(t => ({ id: t.target_id, status: t.status, error: t.error })))).toBe(true);
      expect(resumed.targets[0]!.attempt_counters).toEqual(paused.targets[0]!.attempt_counters);
      expect(networkCalls).toBe(2);
    } finally {
      author.mockRestore(); eventSpy.mockRestore(); retryDelay.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test.each(["recover", "exhaust", "configuration", "alternating"] as const)("transport recovery preserves checkpoint and reports %s", async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-transport-recovery-"));
    const delay = vi.spyOn(attemptBudget, "targetTransportRetryDelayMs").mockReturnValue(1);
    let calls = 0;
    let initialSelectors = "";
    let initialEvidence = "";
    const tlsError = '500: {"message":"upstream: utls: TLS handshake: EOF"}';
    const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (workspace, controller, _resume, _signal, transportRecovery) => {
      calls += 1;
      expect(workspace.revision).toBe(1);
      expect(Boolean(transportRecovery)).toBe(calls > 1);
      if (calls === 1) {
        const draft = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
        const span = (await workspace.readSourceSpanRegistry()).spans[0]!;
        draft.lots = [{ key: "saved-lot", name: "已保存的检验批", scope_span_ids: [span.span_id], reason: "断流前已完成的草稿" }];
        await writeFile(workspace.workingSelectorPath, prettyJson(draft), "utf8");
      }
      const selectors = await readFile(workspace.workingSelectorPath, "utf8");
      const evidence = await readFile(workspace.evidenceManifestPath, "utf8");
      if (calls === 1) { initialSelectors = selectors; initialEvidence = evidence; }
      else { expect(selectors).toBe(initialSelectors); expect(evidence).toBe(initialEvidence); }
      if (outcome === "recover" && calls === 4 || outcome === "alternating" && calls === 7) {
        expect(await runOfflineFixture(workspace, controller)).toMatchObject({ ok: true });
        return { sealed: true, model: "recovered", session_id: "recovered", session_file: "" };
      }
      // Persist session identity just as the live runtime does before a drop.
      await workspace.updateState(state => {
        state.agent_runtime = { kind: "pi-sdk", session_id: "interrupted", session_file: join(workspace.piSessionDirectory, "interrupted.jsonl") };
      });
      return { sealed: false, model: "test", session_id: "interrupted", session_file: "",
        error: outcome === "configuration" ? "HTTP 401 invalid api key"
          : outcome === "alternating" ? `HTTP ${calls % 2 ? 408 : 500}` : tlsError };
    });
    try {
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "transport-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      const plan = confirmedDiscoveryPlan(jobId, markdown);
      plan.targets = [plan.targets[0]!];
      plan.dispositions[0]!.target_ids = [TARGET_IDS[0]];
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(plan), "utf8");
      const options: FullBatchOptions = { artifactRoot: join(root, "artifacts"), jobId,
        markdownPath, concurrency: 1, maxAttempts: 1, live: true };
      await runFullDocumentDiscovery({ ...options, live: false, discoveryPlanPath });
      const result = await runFullBatch(options);
      const target = result.targets[0]!;
      expect(calls).toBe(outcome === "configuration" ? 1 : outcome === "alternating" ? 7 : 4);
      expect(target.attempt_counters).toEqual({ transport_attempts: outcome === "recover" ? 3 : outcome === "exhaust" ? 4 : outcome === "alternating" ? 6 : 0,
        candidate_validation_attempts: 0, coverage_repair_attempts: 0 });
      expect(target.status).toBe(outcome === "recover" || outcome === "alternating" ? "sealed" : "failed");
      expect(target.revision).toBe(1);
      const workspace = await RevisionWorkspace.openLatest(options.artifactRoot, jobId, target.target_id);
      const eventPath = join(workspace.root, "session.events.jsonl");
      const events = await pathExists(eventPath)
        ? (await readFile(eventPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
      const scheduled = events.filter(event => event.event_type === "target_transport_retry_scheduled");
      expect(scheduled.map(event => event.payload.retry_number)).toEqual(outcome === "configuration" ? [] : outcome === "alternating" ? [1, 1, 1, 1, 1, 1] : [1, 2, 3]);
      if (outcome === "alternating") expect(scheduled.map(event => event.payload.error_key)).toEqual(["http_408", "http_500", "http_408", "http_500", "http_408", "http_500"]);
      expect(delay).toHaveBeenCalledTimes(scheduled.length);
      expect(new Set(scheduled.map(event => event.payload.checkpoint)).size).toBe(outcome === "configuration" ? 0 : 1);
      const exhausted = events.filter(event => event.event_type === "target_transport_retry_exhausted");
      expect(exhausted).toHaveLength(outcome === "exhaust" ? 1 : 0);
      if (outcome === "exhaust") {
        expect(exhausted[0].payload).toMatchObject({ consecutive_failures: 4, transport_retries: 3, error: tlsError });
        expect(exhausted[0].payload.instruction).toContain("显式续跑");
        expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(initialSelectors);
        expect(await pathExists(workspace.manifestPath)).toBe(false);
      }
    } finally {
      author.mockRestore();
      delay.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("a real resume mismatch identifies the failed contract without discarding the saved revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-resume-mismatch-"));
    const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (workspace) => {
      await workspace.updateState(state => {
        state.agent_runtime = { kind: "pi-sdk", session_id: "interrupted", session_file: join(workspace.piSessionDirectory, "interrupted.jsonl") };
      });
      return { sealed: false, model: "fixture", session_id: "interrupted", session_file: "", error: "HTTP 401 invalid api key" };
    });
    try {
      const jobId = "resume-mismatch-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      await writeFile(markdownPath, markdown);
      await writeFile(discoveryPlanPath, prettyJson(confirmedDiscoveryPlan(jobId, markdown)));
      const options: FullBatchOptions = { artifactRoot: join(root, "artifacts"), jobId,
        markdownPath, concurrency: 1, maxAttempts: 1, live: true, targetIds: [TARGET_IDS[0]] };
      await runFullDocumentDiscovery({ ...options, live: false, discoveryPlanPath });
      expect((await runFullBatch(options)).targets[0]!.status).toBe("failed");
      const workspace = await RevisionWorkspace.openLatest(options.artifactRoot, jobId, TARGET_IDS[0]);
      const selectors = await readFile(workspace.workingSelectorPath, "utf8");
      const { evidence_fingerprint: _fingerprint, ...payload } = await workspace.readEvidenceManifest();
      const originalLocator = payload.evidence[0]!.locator;
      payload.evidence[0]!.locator = "line:999";
      await chmod(workspace.evidenceManifestPath, 0o644);
      await writeFile(workspace.evidenceManifestPath, prettyJson({ ...payload, evidence_fingerprint: sha256Json(payload) }));

      const resumed = await runFullBatch(options);
      const target = resumed.targets[0]!;
      expect(target.status).toBe("failed");
      expect(target.error).toContain("target_selector_resume_evidence_mismatch");
      expect(target.error).toContain("immutable_evidence_changed at /evidence/0/locator");
      expect(target.error).toContain('actual="line:999"');
      expect(target.error).toContain(`expected=${JSON.stringify(originalLocator)}`);
      expect(target.error).toContain("不能修改 evidence-manifest");
      expect(author).toHaveBeenCalledTimes(1);
      expect((await RevisionWorkspace.openLatest(options.artifactRoot, jobId, TARGET_IDS[0])).revision).toBe(workspace.revision);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectors);
    } finally {
      author.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test.each([false, true])("requires semantic discovery before sealing ledger/heading seeds (active=%s)", async (active) => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-heading-work-scopes-"));
    try {
      const markdownPath = join(root, "source.md");
      const markdown = [
        "# 1 总则",
        "1.0.1 本规范规定适用范围。",
        "# 2 缩略语",
        "ABC 表示测试缩写。",
        "# 3 环境检查",
        "3.0.1 建筑环境应符合设计要求。",
        "# 4 缆线工程",
        "# 4.1 缆线敷设",
        "4.1.1 缆线应自然平直。",
        "# 4.2 保护措施",
        "4.2.1 缆线应采取保护措施。",
        "# 5 工程验收",
        "5.0.1 工程验收资料应完整。",
      ].join("\n");
      await writeFile(markdownPath, markdown, "utf8");

      if (active) await writeFile(markdownPath, markdown.replace("3.0.1 建筑环境应符合设计要求。", "3.1.1 建筑环境应符合设计要求。\n检查数量：全数检查。"), "utf8");
      const candidate = vi.spyOn(piRuntime, "runLiveDocumentDiscovery").mockRejectedValue(new Error("semantic-discovery-required"));
      try {
        await expect(runFullDocumentDiscovery({
          artifactRoot: join(root, "artifacts"), jobId: "heading-work-scope-job",
          markdownPath, concurrency: 1, maxAttempts: 1, live: true,
        })).rejects.toThrow("semantic-discovery-required");
        expect(candidate).toHaveBeenCalledOnce();
        const workspace = candidate.mock.calls[0]![0];
        expect((await workspace.readState()).status).toBe("working");
      } finally { candidate.mockRestore(); }

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("forbids supplied answer plans in a live full-document run", async () => {
    await expect(runFullDocumentDiscovery({
      artifactRoot: "unused",
      jobId: "blind-live-job",
      markdownPath: "unused.md",
      concurrency: 1,
      maxAttempts: 1,
      live: true,
      discoveryPlanPath: "old-answer.json",
    })).rejects.toThrow(/cannot receive a supplied plan or answer artifact/);
  });

  test("aggregates the recorded sealed revision while preserving a newer abandoned draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-sealed-pointer-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "sealed-pointer-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = { artifactRoot, jobId, markdownPath,
        concurrency: 1, maxAttempts: 3, live: false, discoveryPlanPath };
      const first = await runFullBatch(options);
      expect(first.status, prettyJson(first)).toBe("passed");
      const sealed = await RevisionWorkspace.openRevision(artifactRoot, jobId, TARGET_IDS[0], 1);
      const draft = await RevisionWorkspace.reviseFromSealed(artifactRoot, jobId, TARGET_IDS[0]);
      const beforeSealed = await fileTreeSnapshot(sealed.root);
      const beforeDraft = await fileTreeSnapshot(draft.root);
      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      batch.targets.find(t => t.target_id === TARGET_IDS[0])!.workdir = draft.root;
      await writeFile(batchPath, prettyJson(batch), "utf8");
      await refreshFullBatchSummary(artifactRoot, jobId);
      expect(JSON.parse(await readFile(join(artifactRoot, "jobs", jobId, "receipt.json"), "utf8")))
        .toMatchObject({ sealed_target_count: 3, target_manifests: expect.arrayContaining([
          expect.objectContaining({ target_id: TARGET_IDS[0], revision: 1 }),
        ]) });
      expect(await fileTreeSnapshot(sealed.root)).toEqual(beforeSealed);
      expect(await fileTreeSnapshot(draft.root)).toEqual(beforeDraft);
      const resumed = await runFullBatch({ ...options, targetIds: [TARGET_IDS[1]] });
      expect(resumed.status).toBe("passed");
      expect(resumed.targets.find(t => t.target_id === TARGET_IDS[0])).toMatchObject({
        status: "sealed", revision: 1, workdir: sealed.root,
      });
      expect(await fileTreeSnapshot(sealed.root)).toEqual(beforeSealed);
      expect(await fileTreeSnapshot(draft.root)).toEqual(beforeDraft);
      // Explicit sealed-source rematerialization must also avoid the newer draft.
      const inherited = await RevisionWorkspace.reviseFromSealed(artifactRoot, jobId, TARGET_IDS[0], 1);
      expect(inherited.revision).toBe(3);
      expect((await inherited.readState()).lineage?.source_revision).toBe(1);
      expect(await fileTreeSnapshot(draft.root)).toEqual(beforeDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("reloads coverage-only control on its exact revision and clears it after seal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-coverage-control-reload-"));
    const author = vi.spyOn(piRuntime, "runLivePi").mockRejectedValue(
      new Error("author model must not run while coverage control is pending"),
    );
    const coverageCalls: Array<{ revision: number; root: string; fingerprint: string }> = [];
    const coverage = vi.spyOn(piRuntime, "runLiveCoverageReview").mockImplementation(
      async (workspace, fingerprint) => {
        coverageCalls.push({ revision: workspace.revision, root: workspace.root, fingerprint });
        if (coverageCalls.length === 1) {
          const state = await workspace.readState();
          return {
            sealed: false,
            terminal: true,
            model: "coverage-controller-stale",
            error: "coverage_review_candidate_changed",
            control: {
              kind: "coverage_controller_rebuild",
              retryable: true,
              same_job_required: true,
              stale_plan_fingerprint: fingerprint,
              current_plan_fingerprint: state.last_valid_fingerprint,
              current_plan_sha256: state.last_valid_plan_sha256,
              required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
              reason: "current_fingerprint_did_not_advance",
              instruction: "test control receipt",
            },
          };
        }
        return sealDeterministicCleanCoverageReview(
          workspace,
          fingerprint,
          { mode: "risk_delta", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
        );
      },
    );
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "coverage-control-reload-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(confirmedDiscoveryPlan(jobId, markdown)),
        "utf8",
      );
      expect((await runFullBatch({
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      })).status).toBe("passed");

      const controlled = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const sealedSource = await RevisionWorkspace.openRevision(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const restoredPlanText = await readFile(sealedSource.sealedPlanPath, "utf8");
      await writeFile(controlled.lastValidPlanPath, restoredPlanText, "utf8");
      await writeFile(controlled.workingPlanPath, restoredPlanText, "utf8");
      await writeFile(
        controlled.validationReceiptPath,
        await readFile(sealedSource.validationReceiptPath, "utf8"),
        "utf8",
      );
      const controlledEvidence = await controlled.readEvidenceManifest();
      const restoredCandidate = validatePlanText(
        restoredPlanText,
        controlledEvidence,
      );
      expect(restoredCandidate.ok).toBe(true);
      const controlledState = await controlled.updateState((state) => {
        state.last_valid_fingerprint = restoredCandidate.fingerprint!;
        state.last_valid_plan_sha256 = restoredCandidate.plan_sha256!;
        state.coverage_recheck = {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: state.last_valid_fingerprint,
          source_plan_fingerprint: state.last_valid_fingerprint,
          review_fingerprint: "outer-reload-test",
          finding_ids: [],
          affected_item_ids: [],
          affected_evidence_ids: [],
        };
      });
      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      persisted.mode = "live-pi";
      persisted.status = "running";
      const controlledTarget = persisted.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      controlledTarget.status = "pending";
      controlledTarget.revision = controlled.revision;
      controlledTarget.workdir = controlled.root;
      controlledTarget.error = "coverage_controller_rebuild_no_progress";
      controlledTarget.last_failure_class = undefined;
      const countersBefore = structuredClone(controlledTarget.attempt_counters);
      controlledTarget.coverage_control = {
        schema_version: "coverage-controller-pending/v2",
        kind: "coverage_controller_rebuild",
        job_id: jobId,
        target_id: TARGET_IDS[0],
        revision: controlled.revision,
        workdir: controlled.root,
        plan_fingerprint: controlledState.last_valid_fingerprint,
        receipt: {
          kind: "coverage_controller_rebuild",
          retryable: true,
          same_job_required: true,
          stale_plan_fingerprint: controlledState.last_valid_fingerprint,
          current_plan_fingerprint: controlledState.last_valid_fingerprint,
          current_plan_sha256: controlledState.last_valid_plan_sha256,
          required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
          reason: "current_fingerprint_did_not_advance",
          instruction: "test persisted control",
        },
      };
      await writeFile(batchPath, prettyJson(persisted), "utf8");
      const liveOptions: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 1,
        live: true,
        targetIds: [TARGET_IDS[0]],
      };

      const pending = await runFullBatch(liveOptions);
      const pendingTarget = pending.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(pending.status, JSON.stringify(pendingTarget)).toBe("running");
      expect(pendingTarget).toMatchObject({
        status: "pending",
        revision: controlled.revision,
        workdir: controlled.root,
        coverage_control: {
          schema_version: "coverage-controller-pending/v2",
          job_id: jobId,
          target_id: TARGET_IDS[0],
          revision: controlled.revision,
          workdir: controlled.root,
        },
      });
      expect(pendingTarget.attempt_counters).toEqual(countersBefore);
      expect(author).toHaveBeenCalledTimes(0);
      expect(coverageCalls).toEqual([{
        revision: controlled.revision,
        root: controlled.root,
        fingerprint: controlledState.last_valid_fingerprint,
      }]);

      const newerDraft = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      expect(newerDraft.revision).toBe(controlled.revision + 1);
      const resumed = await runFullBatch(liveOptions);
      const resumedTarget = resumed.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(resumed.status).toBe("passed");
      expect(resumedTarget).toMatchObject({
        status: "sealed",
        revision: controlled.revision,
        workdir: controlled.root,
        error: "",
      });
      expect(resumedTarget.coverage_control).toBeUndefined();
      expect(resumedTarget.attempt_counters).toEqual(countersBefore);
      expect(author).toHaveBeenCalledTimes(0);
      expect(coverageCalls.at(-1)).toEqual({
        revision: controlled.revision,
        root: controlled.root,
        fingerprint: controlledState.last_valid_fingerprint,
      });

      const crashSnapshot = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const crashTarget = crashSnapshot.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      crashSnapshot.status = "running";
      crashTarget.status = "running";
      crashTarget.error = "simulated crash after workspace seal";
      crashTarget.coverage_control = {
        schema_version: "coverage-controller-pending/v2",
        kind: "coverage_controller_rebuild",
        job_id: jobId,
        target_id: TARGET_IDS[0],
        revision: controlled.revision,
        workdir: controlled.root,
        plan_fingerprint: controlledState.last_valid_fingerprint,
        receipt: controlledTarget.coverage_control!.receipt,
      };
      await writeFile(batchPath, prettyJson(crashSnapshot), "utf8");
      const callsBeforeReload = coverageCalls.length;
      const afterCrashReload = await runFullBatch(liveOptions);
      const reloadedTarget = afterCrashReload.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(afterCrashReload.status, JSON.stringify(afterCrashReload.targets)).toBe("passed");
      expect(reloadedTarget).toMatchObject({
        status: "sealed",
        revision: controlled.revision,
        workdir: controlled.root,
      });
      expect(reloadedTarget.coverage_control).toBeUndefined();
      expect(coverageCalls).toHaveLength(callsBeforeReload);
      expect(author).toHaveBeenCalledTimes(0);
    } finally {
      coverage.mockRestore();
      author.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("fresh target discards pending coverage control before using a new revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-coverage-control-fresh-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "coverage-control-fresh-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(confirmedDiscoveryPlan(jobId, markdown)),
        "utf8",
      );
      expect((await runFullBatch({
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      })).status).toBe("passed");

      const controlled = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const sealedSource = await RevisionWorkspace.openRevision(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const restoredPlanText = await readFile(sealedSource.sealedPlanPath, "utf8");
      await writeFile(controlled.lastValidPlanPath, restoredPlanText, "utf8");
      await writeFile(controlled.workingPlanPath, restoredPlanText, "utf8");
      await writeFile(
        controlled.validationReceiptPath,
        await readFile(sealedSource.validationReceiptPath, "utf8"),
        "utf8",
      );
      const candidate = validatePlanText(restoredPlanText, await controlled.readEvidenceManifest());
      expect(candidate.ok).toBe(true);
      const controlledState = await controlled.updateState((state) => {
        state.last_valid_fingerprint = candidate.fingerprint!;
        state.last_valid_plan_sha256 = candidate.plan_sha256!;
        state.coverage_recheck = {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: candidate.fingerprint!,
          source_plan_fingerprint: candidate.fingerprint!,
          review_fingerprint: "fresh-control-test",
          finding_ids: [],
          affected_item_ids: [],
          affected_evidence_ids: [],
        };
      });

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      persisted.mode = "live-pi";
      persisted.status = "running";
      const target = persisted.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
      target.status = "pending";
      target.revision = controlled.revision;
      target.workdir = controlled.root;
      target.error = "";
      target.last_failure_class = undefined;
      target.attempt_counters = {
        transport_attempts: 7,
        candidate_validation_attempts: 6,
        coverage_repair_attempts: 5,
      };
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      let authorPhase = 0;
      const authorWorkspaces: Array<{ revision: number; root: string }> = [];
      const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (workspace) => {
        authorPhase += 1;
        authorWorkspaces.push({ revision: workspace.revision, root: workspace.root });
        if (authorPhase === 1) {
          return {
            session_id: "synthetic-control-author",
            session_file: "",
            sealed: false,
            model: "synthetic-control-author",
            review_required: true,
            review_plan_fingerprint: candidate.fingerprint!,
          };
        }
        return {
          session_id: "synthetic-fresh-author",
          session_file: "",
          sealed: false,
          model: "synthetic-fresh-author",
          error: "invalid api key: synthetic fresh target stop",
          failure_class: "provider_configuration",
        };
      });
      const coverage = vi.spyOn(piRuntime, "runLiveCoverageReview").mockImplementation(
        async (_workspace, fingerprint) => ({
          sealed: false,
          terminal: true,
          model: "coverage-controller-stale",
          error: "coverage_review_candidate_changed",
          control: {
            kind: "coverage_controller_rebuild",
            retryable: true,
            same_job_required: true,
            stale_plan_fingerprint: fingerprint,
            current_plan_fingerprint: fingerprint,
            current_plan_sha256: controlledState.last_valid_plan_sha256,
            required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
            reason: "current_fingerprint_did_not_advance",
            instruction: "test fresh target control discard",
          },
        }),
      );
      try {
        const liveOptions: FullBatchOptions = {
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        };
        const pending = await runFullBatch(liveOptions);
        const pendingTarget = pending.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
        expect(pending.status).toBe("running");
        expect(pendingTarget).toMatchObject({
          status: "pending",
          revision: controlled.revision,
          workdir: controlled.root,
          coverage_control: {
            schema_version: "coverage-controller-pending/v2",
            revision: controlled.revision,
            workdir: controlled.root,
          },
        });

        const crashCoverage = await sealDeterministicCleanCoverageReview(
          controlled,
          candidate.fingerprint!,
          { mode: "risk_delta", affected_item_ids: [], affected_evidence_ids: [], finding_ids: [] },
        );
        expect(crashCoverage.sealed, crashCoverage.error).toBe(true);
        const crashController = await ToolController.create(controlled);
        const crashSeal = await crashController.dispatch("seal_validated_plan", {
          fingerprint: candidate.fingerprint!,
        });
        expect(crashSeal.ok).toBe(true);

        author.mockClear();
        coverage.mockClear();
        authorWorkspaces.length = 0;
        const fresh = await runFullBatch({
          ...liveOptions,
          freshTargetIds: [TARGET_IDS[0]],
        });
        const freshTarget = fresh.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
        expect(freshTarget).toMatchObject({
          status: "failed",
          revision: controlled.revision + 1,
          attempt_counters: {
            transport_attempts: 0,
            candidate_validation_attempts: 0,
            coverage_repair_attempts: 0,
          },
          error: expect.stringContaining("synthetic fresh target stop"),
        });
        expect(freshTarget.workdir).not.toBe(controlled.root);
        expect(freshTarget.coverage_control).toBeUndefined();
        expect(author).toHaveBeenCalledTimes(1);
        expect(authorWorkspaces).toEqual([{
          revision: controlled.revision + 1,
          root: freshTarget.workdir,
        }]);
        expect(coverage).toHaveBeenCalledTimes(0);
      } finally {
        coverage.mockRestore();
        author.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("bounds deterministic fallback when a fresh author repeats an invalid checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-coverage-invalid-bound-"));
    const gate = vi.spyOn(coverageRisk, "deriveCoverageRiskGate").mockReturnValue({
      schema_version: "coverage-risk-gate/v1",
      clean: true,
      scope: {
        mode: "risk_delta",
        affected_item_ids: [],
        affected_evidence_ids: [],
        finding_ids: [],
      },
      reasons: [],
      counts: {
        total_item_count: 1,
        affected_item_count: 0,
        affected_evidence_count: 0,
        reason_count: 0,
      },
    });
    const coverage = vi.spyOn(piRuntime, "runLiveCoverageReview");
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "coverage-invalid-bound-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(confirmedDiscoveryPlan(jobId, markdown)),
        "utf8",
      );
      expect((await runFullBatch({
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      })).status).toBe("passed");

      const controlled = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const sealedSource = await RevisionWorkspace.openRevision(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
        1,
      );
      const restoredPlanText = await readFile(sealedSource.sealedPlanPath, "utf8");
      await writeFile(controlled.lastValidPlanPath, restoredPlanText, "utf8");
      await writeFile(controlled.workingPlanPath, restoredPlanText, "utf8");
      const invalidReceipt = JSON.parse(
        await readFile(sealedSource.validationReceiptPath, "utf8"),
      ) as Record<string, unknown>;
      invalidReceipt.plan_sha256 = "e".repeat(64);
      await writeFile(controlled.validationReceiptPath, prettyJson(invalidReceipt), "utf8");
      const evidence = await controlled.readEvidenceManifest();
      const candidate = validatePlanText(restoredPlanText, evidence);
      expect(candidate.ok).toBe(true);
      const invalidPlanSha = "f".repeat(64);
      await controlled.updateState((state) => {
        state.last_valid_fingerprint = candidate.fingerprint!;
        state.last_valid_plan_sha256 = invalidPlanSha;
        delete state.coverage_recheck;
      });

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      persisted.mode = "live-pi";
      persisted.status = "running";
      const target = persisted.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
      target.status = "pending";
      target.revision = controlled.revision;
      target.workdir = controlled.root;
      target.error = "coverage_review_candidate_changed";
      target.last_failure_class = undefined;
      const countersBefore = structuredClone(target.attempt_counters);
      target.coverage_control = {
        schema_version: "coverage-controller-pending/v2",
        kind: "coverage_controller_rebuild",
        job_id: jobId,
        target_id: TARGET_IDS[0],
        revision: controlled.revision,
        workdir: controlled.root,
        plan_fingerprint: candidate.fingerprint!,
        receipt: {
          kind: "coverage_controller_rebuild",
          retryable: true,
          same_job_required: true,
          stale_plan_fingerprint: candidate.fingerprint!,
          current_plan_fingerprint: candidate.fingerprint!,
          current_plan_sha256: invalidPlanSha,
          required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
          reason: "current_candidate_not_durably_valid",
          instruction: "test invalid checkpoint",
        },
      };
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      let transportOnlyRevision: number | undefined;
      const authorCalls: Array<{
        revision: number;
        root: string;
        resume: boolean;
        provider_recovery: boolean;
      }> = [];
      const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (
        workspace,
        _controller,
        resume,
        _signal,
        providerRecovery,
      ) => {
        authorCalls.push({
          revision: workspace.revision,
          root: workspace.root,
          resume,
          provider_recovery: providerRecovery,
        });
        if (workspace.revision === transportOnlyRevision) {
          return {
            session_id: "synthetic-fresh-author-transport",
            session_file: "",
            sealed: false,
            model: "synthetic-fresh-author",
            error: "ETIMEDOUT synthetic fresh author transport",
            failure_class: "transport",
          };
        }
        await workspace.updateState((state) => {
          state.last_valid_fingerprint = candidate.fingerprint!;
          state.last_valid_plan_sha256 = invalidPlanSha;
        });
        return {
          session_id: "synthetic-fresh-author",
          session_file: "",
          sealed: false,
          model: "synthetic-fresh-author",
          review_required: true,
          review_plan_fingerprint: candidate.fingerprint!,
        };
      });
      try {
        const result = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const stopped = result.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
        expect(result.status).toBe("failed");
        expect(stopped).toMatchObject({
          status: "failed",
          revision: controlled.revision,
          workdir: controlled.root,
          last_failure_class: "coverage_harness_defect",
          coverage_controller_recovery: {
            schema_version: "coverage-controller-recovery/v2",
            job_id: jobId,
            target_id: TARGET_IDS[0],
            revision: controlled.revision,
            workdir: controlled.root,
            phase: "fresh_author_reserved",
            attempts: 1,
            last_plan_fingerprint: candidate.fingerprint!,
          },
          error: expect.stringContaining("coverage_candidate_rebuild_stalled"),
        });
        expect(stopped.coverage_control).toBeUndefined();
        expect(stopped.attempt_counters).toEqual(countersBefore);
        expect(author).toHaveBeenCalledTimes(1);
        expect(gate).toHaveBeenCalled();
        expect(await readFile(controlled.transcriptPath, "utf8")).toContain(
          "coverage_risk_gate_auto_approval_fallback",
        );

        const authorCallsAfterStall = author.mock.calls.length;
        const coverageCallsAfterStall = coverage.mock.calls.length;
        const crashAfterHandoff = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
        crashAfterHandoff.status = "running";
        const reservedTarget = crashAfterHandoff.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        reservedTarget.status = "running";
        reservedTarget.error = "";
        reservedTarget.last_failure_class = undefined;
        reservedTarget.coverage_controller_recovery = {
          schema_version: "coverage-controller-recovery/v1",
          revision: controlled.revision,
          attempts: 1,
          last_plan_fingerprint: candidate.fingerprint!,
        } as unknown as NonNullable<typeof reservedTarget.coverage_controller_recovery>;
        await writeFile(batchPath, prettyJson(crashAfterHandoff), "utf8");
        const sameRevisionResult = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const sameRevisionStopped = sameRevisionResult.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        expect(sameRevisionResult.status).toBe("failed");
        expect(sameRevisionStopped).toMatchObject({
          status: "failed",
          revision: controlled.revision,
          workdir: controlled.root,
          last_failure_class: "coverage_harness_defect",
          coverage_controller_recovery: {
            schema_version: "coverage-controller-recovery/v2",
            job_id: jobId,
            target_id: TARGET_IDS[0],
            revision: controlled.revision,
            workdir: controlled.root,
            phase: "fresh_author_reserved",
            attempts: 1,
            last_plan_fingerprint: candidate.fingerprint!,
          },
          error: expect.stringContaining("coverage_candidate_rebuild_stalled"),
        });
        expect(sameRevisionStopped.attempt_counters).toEqual(countersBefore);
        expect(author).toHaveBeenCalledTimes(authorCallsAfterStall);
        expect(coverage).toHaveBeenCalledTimes(coverageCallsAfterStall);

        const staleTransportCrash = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
        staleTransportCrash.status = "running";
        const staleTransportTarget = staleTransportCrash.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        staleTransportTarget.status = "running";
        staleTransportTarget.error = "ETIMEDOUT stale transport metadata from before reservation";
        staleTransportTarget.last_failure_class = "transport";
        staleTransportTarget.attempt_counters = {
          ...staleTransportTarget.attempt_counters!,
          transport_attempts: staleTransportTarget.attempt_counters!.transport_attempts + 1,
        };
        staleTransportTarget.transport_retry_window = {
          checkpoint: await targetDurableCheckpoint(controlled),
          consecutive_failures: 1,
        };
        const staleTransportCounters = structuredClone(staleTransportTarget.attempt_counters);
        await writeFile(batchPath, prettyJson(staleTransportCrash), "utf8");
        const authorCallsBeforeStaleTransport = author.mock.calls.length;
        const coverageCallsBeforeStaleTransport = coverage.mock.calls.length;
        const staleTransportResult = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const staleTransportStopped = staleTransportResult.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        expect(staleTransportStopped).toMatchObject({
          status: "failed",
          revision: controlled.revision,
          workdir: controlled.root,
          coverage_controller_recovery: {
            schema_version: "coverage-controller-recovery/v2",
            phase: "fresh_author_reserved",
          },
        });
        expect(staleTransportStopped.attempt_counters).toEqual(staleTransportCounters);
        expect(author).toHaveBeenCalledTimes(authorCallsBeforeStaleTransport);
        expect(coverage).toHaveBeenCalledTimes(coverageCallsBeforeStaleTransport);

        const nextRevision = await RevisionWorkspace.reviseFromSealed(
          artifactRoot,
          jobId,
          TARGET_IDS[0],
          1,
        );
        expect(nextRevision.revision).toBe(controlled.revision + 1);
        await writeFile(nextRevision.lastValidPlanPath, restoredPlanText, "utf8");
        await writeFile(nextRevision.workingPlanPath, restoredPlanText, "utf8");
        await writeFile(
          nextRevision.validationReceiptPath,
          prettyJson(invalidReceipt),
          "utf8",
        );
        await nextRevision.updateState((state) => {
          state.last_valid_fingerprint = candidate.fingerprint!;
          state.last_valid_plan_sha256 = invalidPlanSha;
          delete state.coverage_recheck;
        });
        const nextBatch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
        nextBatch.status = "running";
        const nextTarget = nextBatch.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
        nextTarget.status = "pending";
        nextTarget.revision = nextRevision.revision;
        nextTarget.workdir = nextRevision.root;
        nextTarget.error = "coverage_review_candidate_changed";
        nextTarget.last_failure_class = undefined;
        nextTarget.coverage_controller_recovery = {
          schema_version: "coverage-controller-recovery/v1",
          revision: controlled.revision,
          attempts: 1,
          last_plan_fingerprint: candidate.fingerprint!,
        } as unknown as NonNullable<typeof nextTarget.coverage_controller_recovery>;
        nextTarget.coverage_control = {
          schema_version: "coverage-controller-pending/v2",
          kind: "coverage_controller_rebuild",
          job_id: jobId,
          target_id: TARGET_IDS[0],
          revision: nextRevision.revision,
          workdir: nextRevision.root,
          plan_fingerprint: candidate.fingerprint!,
          receipt: {
            kind: "coverage_controller_rebuild",
            retryable: true,
            same_job_required: true,
            stale_plan_fingerprint: candidate.fingerprint!,
            current_plan_fingerprint: candidate.fingerprint!,
            current_plan_sha256: invalidPlanSha,
            required_action: "persist_control_and_resume_same_job_target_revision_from_current_candidate",
            reason: "current_candidate_not_durably_valid",
            instruction: "test invalid checkpoint on next revision",
          },
        };
        await writeFile(batchPath, prettyJson(nextBatch), "utf8");
        transportOnlyRevision = nextRevision.revision;
        const authorCallsBeforeTransport = authorCalls.length;
        const nextResult = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          transportRetries: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const nextStopped = nextResult.targets.find((entry) => entry.target_id === TARGET_IDS[0])!;
        expect(nextStopped).toMatchObject({
          status: "failed",
          revision: nextRevision.revision,
          workdir: nextRevision.root,
          last_failure_class: "transport",
          coverage_controller_recovery: {
            schema_version: "coverage-controller-recovery/v2",
            job_id: jobId,
            target_id: TARGET_IDS[0],
            revision: nextRevision.revision,
            workdir: nextRevision.root,
            phase: "fresh_author_transport_retry",
            attempts: 1,
          },
          error: expect.stringContaining("ETIMEDOUT synthetic fresh author transport"),
        });
        expect(nextStopped.attempt_counters).toEqual({
          ...staleTransportCounters,
          transport_attempts: (staleTransportCounters?.transport_attempts ?? 0) + 2,
        });
        expect(authorCalls.slice(authorCallsBeforeTransport)).toEqual([
          {
            revision: nextRevision.revision,
            root: nextRevision.root,
            resume: false,
            provider_recovery: false,
          },
          {
            revision: nextRevision.revision,
            root: nextRevision.root,
            resume: false,
            provider_recovery: true,
          },
        ]);

        const authorCallsAfterTransportExhaustion = author.mock.calls.length;
        const coverageCallsAfterTransportExhaustion = coverage.mock.calls.length;
        const exhaustedAgain = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          transportRetries: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const exhaustedTarget = exhaustedAgain.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        expect(exhaustedTarget).toMatchObject({
          status: "failed",
          revision: nextRevision.revision,
          workdir: nextRevision.root,
          last_failure_class: "transport",
          error: expect.stringContaining("ETIMEDOUT synthetic fresh author transport"),
        });
        expect(exhaustedTarget.attempt_counters).toEqual(nextStopped.attempt_counters);
        expect(author).toHaveBeenCalledTimes(authorCallsAfterTransportExhaustion);
        expect(coverage).toHaveBeenCalledTimes(coverageCallsAfterTransportExhaustion);

        await writeFile(nextRevision.lastValidPlanPath, restoredPlanText, "utf8");
        await nextRevision.updateState((state) => {
          state.last_valid_fingerprint = candidate.fingerprint!;
          state.last_valid_plan_sha256 = candidate.plan_sha256!;
        });
        const authorCallsBeforeDurableResume = author.mock.calls.length;
        const durableResume = await runFullBatch({
          artifactRoot,
          jobId,
          markdownPath,
          concurrency: 1,
          maxAttempts: 1,
          live: true,
          targetIds: [TARGET_IDS[0]],
        });
        const durableTarget = durableResume.targets.find(
          (entry) => entry.target_id === TARGET_IDS[0],
        )!;
        expect(durableResume.status).toBe("passed");
        expect(durableTarget).toMatchObject({
          status: "sealed",
          revision: nextRevision.revision,
          workdir: nextRevision.root,
          error: "",
        });
        expect(durableTarget.coverage_controller_recovery).toBeUndefined();
        expect(author).toHaveBeenCalledTimes(authorCallsBeforeDurableResume);
      } finally {
        author.mockRestore();
      }
    } finally {
      coverage.mockRestore();
      gate.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("retries a terminal failed workspace in a new writable revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-terminal-revision-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(discoveryPlan("terminal-revision-job", markdown)),
        "utf8",
      );
      const options: FullBatchOptions = {
        artifactRoot,
        jobId: "terminal-revision-job",
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const failed = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        options.jobId,
        TARGET_IDS[0]!,
      );
      // The offline plan-only seed has no usable selector checkpoint. Model a
      // real submitted revision before simulating a later terminal failure.
      const evidence = await failed.readEvidenceManifest();
      const registry = await failed.readSourceSpanRegistry();
      const span = registry.spans.find((candidate) =>
        candidate.evidence_id === evidence.evidence[0]!.evidence_id
      )!;
      const selectors = initialTargetSelectorPlan(evidence);
      selectors.lots.push({ key: "lot", name: "地基检验批", scope_span_ids: [span.span_id], reason: "目标范围" });
      const absent = { composition: "not_applicable" as const, span_ids: [], separator: "", reason: "原文未给出" };
      selectors.items.push({
        key: "bearing", lot_key: "lot", name: "地基承载力", category: "主控项目",
        criterion_span_ids: [span.span_id], continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [span.span_id], separator: "", reason: "验收对象" },
          requirement: { composition: "verbatim", span_ids: [span.span_id], separator: "", reason: "承载力要求" },
          method: absent, quantity: absent, note: absent,
        },
        table: null, inspection_data_type: "review", inspection_data_type_reason: "核对设计要求",
        inspection_data_type_span_ids: [span.span_id],
        sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "未给抽样规则", confidence: 1 },
        reason: "地基承载力验收",
      });
      selectors.residual_source_dispositions = [{ key: "duplicate-context", disposition: "context", reason: "同一承载力原文的其他导航和逐行证据，不新增项目。" }];
      const controller = await ToolController.create(failed);
      for (const record of evidence.evidence) {
        expect(await controller.dispatch("open_evidence", { evidence_id: record.evidence_id })).toMatchObject({ ok: true });
      }
      const submitted = await controller.dispatch("submit_target_selectors", { content: prettyJson(selectors) });
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
      const validation = await controller.dispatch("compile_target_selectors", {});
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      expect(await pathExists(failed.lastValidSelectorPath)).toBe(true);
      await failed.updateState((state) => {
        state.selector_stage = "commit";
        state.selector_protocol.submissions = 1;
      });
      await failed.markTerminal("failed", "compiler_invariant_violation");
      const failedSelectors = await readFile(failed.workingSelectorPath, "utf8");
      const batchPath = join(artifactRoot, "jobs", options.jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const failedTarget = persisted.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      failedTarget.status = "failed";
      failedTarget.error = "compiler_invariant_violation";
      failedTarget.last_failure_class = "candidate";
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      // Resume through selector compilation and review, not the legacy offline
      // script that mutates plan JSON behind the selector compiler's back.
      const resume = vi.spyOn(targetTools, "runOfflineFixture").mockImplementation(async (workspace, resumedController) => {
        expect(workspace.revision).toBe(3);
        expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(failedSelectors);
        const compiled = await resumedController.dispatch("compile_target_selectors", {});
        expect(compiled, JSON.stringify(compiled)).toMatchObject({ ok: true });
        const plan = JSON.parse(await readFile(workspace.lastValidPlanPath, "utf8")) as SemanticSourcePlan;
        const fingerprint = (await workspace.readState()).last_valid_fingerprint;
        const review = await CoverageReviewController.create(workspace, fingerprint);
        for (const record of evidence.evidence) {
          await review.dispatch("open_review_evidence", { evidence_id: record.evidence_id });
        }
        const staged = await review.dispatch("replace_working_coverage_review", { content: prettyJson({
          schema_version: COVERAGE_REVIEW_SCHEMA_VERSION, plan_fingerprint: fingerprint,
          evidence_fingerprint: evidence.evidence_fingerprint, status: "approved", findings: [],
          summary: "离线回归：同一承载力要求已由一个项目完整承接。",
          semantic_coverage: [{ coverage_id: "bearing", disposition: "acceptance_item", judgment_id: "bearing",
            item_ids: [plan.acceptance_items[0]!.item_id],
            evidence_bindings: evidence.evidence.map(record => ({ evidence_id: record.evidence_id, exact_fragment: record.text })),
            reason: "所有证据均为同一承载力要求的导航或逐行表示。" }],
        }) });
        expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
        const reviewed = await review.dispatch("validate_coverage_review", {});
        expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
        expect(await review.dispatch("seal_coverage_review", { fingerprint: reviewed.fingerprint })).toMatchObject({ ok: true });
        return resumedController.dispatch("seal_validated_plan", { fingerprint });
      });
      let retried: FullBatchState;
      try {
        retried = await runFullBatch(options);
        expect(resume).toHaveBeenCalledOnce();
      } finally { resume.mockRestore(); }
      const target = retried.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
      expect(target).toMatchObject({ status: "sealed", revision: 3, error: "" });
      const recovered = await RevisionWorkspace.openLatest(
        artifactRoot,
        options.jobId,
        TARGET_IDS[0]!,
      );
      expect(recovered.revision).toBe(3);
      expect(await pathExists(recovered.manifestPath)).toBe(true);
      expect((await recovered.readState()).lineage).toMatchObject({ selector_checkpoint_revision: 2 });
      expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(failedSelectors);
      expect(await failed.readState()).toMatchObject({
        status: "failed",
        terminal_reason: "compiler_invariant_violation",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.each<{ label: string; hasSavedItems: boolean; refreshAttempts: number; recoveryError?: Error; repeatScopeBlocker?: boolean; evidenceReadError?: boolean; extension?: "opened" | "unopened" | "primary"; runtimeSlice?: "unique" | "ambiguous" | "short" }>([
    { label: "expands primary to an opened outside atom and its table rows", hasSavedItems: false, refreshAttempts: 0, extension: "opened" },
    { label: "expands primary from a unique runtime slice without atom identity", hasSavedItems: false, refreshAttempts: 0, extension: "opened", runtimeSlice: "unique" },
    { label: "rejects a runtime slice contained in multiple atoms", hasSavedItems: false, refreshAttempts: 0, extension: "opened", runtimeSlice: "ambiguous" },
    { label: "rejects a short runtime slice without atom identity", hasSavedItems: false, refreshAttempts: 0, extension: "opened", runtimeSlice: "short" },
    { label: "expands primary while preserving saved work", hasSavedItems: true, refreshAttempts: 0, extension: "opened" },
    { label: "rejects an unopened outside span", hasSavedItems: false, refreshAttempts: 0, extension: "unopened" },
    { label: "does not expand for a span already in primary", hasSavedItems: false, refreshAttempts: 0, extension: "primary" },
    { label: "does not expand an opened outside span after the one-refresh limit", hasSavedItems: false, refreshAttempts: 1, extension: "opened" },
    { label: "blocks a no-op refresh with no saved items", hasSavedItems: false, refreshAttempts: 0 },
    { label: "preserves the failed revision when frozen evidence cannot be read", hasSavedItems: false, refreshAttempts: 0, evidenceReadError: true },
    { label: "preserves saved work", hasSavedItems: true, refreshAttempts: 0 },
    { label: "preserves saved work after the blank-refresh budget is spent", hasSavedItems: true, refreshAttempts: 1 },
    { label: "blocks a no-op refresh when the saved checkpoint is untrusted", hasSavedItems: true, refreshAttempts: 0,
      recoveryError: new Error("Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor") },
    { label: "preserves saved work when checkpoint copying fails with ENOENT", hasSavedItems: true, refreshAttempts: 0,
      recoveryError: Object.assign(new Error("checkpoint copy missing"), { code: "ENOENT" }) },
    { label: "stops repeated scope blockers after checkpoint recovery", hasSavedItems: true, refreshAttempts: 0, repeatScopeBlocker: true },
    { label: "enforces the one-refresh limit", hasSavedItems: false, refreshAttempts: 1 },
  ])("scope refresh $label", async ({ hasSavedItems, refreshAttempts, recoveryError, repeatScopeBlocker, evidenceReadError, extension, runtimeSlice }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-scope-extension-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "scope-extension-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40)
        + (extension ? `\n${"无关导航文字。".repeat(1000)}\n\n# 窗外检验表\n\n<table><tr><td>项目</td><td>允许偏差</td></tr><tr><td>防水厚度</td><td>2mm</td></tr></table>\n` : "")
        + (runtimeSlice === "ambiguous" ? `\n${"其他导航文字。".repeat(1000)}\n\n# 另一检验表\n\n<table><tr><td>项目</td><td>允许偏差</td></tr><tr><td>防水厚度</td><td>2mm</td></tr></table>\n` : "");
      await writeFile(markdownPath, markdown, "utf8");
      const plan = discoveryPlan(jobId, markdown);
      if (extension) {
        const evidence = buildDocumentEvidence(markdown, "source.md");
        const atom = evidence.atoms[0]!;
        const text = markdown.split("\n")[0]!;
        const fragment = { atom_id: atom.atom_id, start: 0, end: text.length, text, text_sha256: sha256Text(text) };
        plan.targets[0]!.work_scope = { start_line: 1, end_exclusive_line: 2,
          source_sha256: evidence.source.sha256, primary_fragments: [fragment], reason: "原先确认的首行范围。",
          source_blocks: [{ kind: "explicit_range", anchor_fragment: fragment, start_fragment: fragment,
            end_fragment: fragment, reason: "首行包含完整目标要求。" }] };
      }
      for (const atom of buildDocumentEvidence(markdown, "source.md").atoms.slice(1)) {
        plan.dispositions.push({ atom_id: atom.atom_id, disposition: "context", target_ids: [], reason: "供目标按需调查的窗外原文。" });
      }
      await writeFile(discoveryPlanPath, prettyJson(plan), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const failed = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      if (hasSavedItems) {
        const draft=JSON.parse(await readFile(failed.workingSelectorPath,"utf8"));
        const span=(await failed.readSourceSpanRegistry()).spans[0]!.span_id;
        const none={composition:"not_applicable",span_ids:[],separator:"",reason:"未单列"};
        draft.lots=[{key:"saved-lot",name:"已有检验批",scope_span_ids:[span],reason:"原文范围"}];
        draft.items=[{key:"saved-item",lot_key:"saved-lot",name:"已有质量检查",category:"一般项目",criterion_span_ids:[span],continuation_span_ids:[],fields:{name:{composition:"semantic_summary",span_ids:[span],separator:"",reason:"原文对象"},requirement:{composition:"verbatim",span_ids:[span],separator:"",reason:"原文要求"},method:none,quantity:none,note:none},table:null,inspection_data_type:"review",inspection_data_type_reason:"核查原文",inspection_data_type_span_ids:[span],sampling:{status:"fallback",rule_key:"",branch_keys:[],quantity_span_ids:[],script_span_ids:[],condition_span_ids:[],reason:"未单列抽样",confidence:1},reason:"已经保存的有效工作"}];
        await failed.writeWorkingSelectors(prettyJson(draft));
      }
      const savedBytes=await readFile(failed.workingSelectorPath,"utf8");
      const originalManifest = await failed.readEvidenceManifest();
      const documentEvidence = buildDocumentEvidence(markdown, "source.md");
      const outsideAtom = documentEvidence.atoms.at(-1)!;
      if (extension) {
        const record = extension === "primary"
          ? originalManifest.evidence.find(record => record.evidence_scope === "primary")!
          : runtimeSlice
            ? { evidence_id: "runtime:outside-line", kind: "paragraph" as const,
                role: "context" as const, locator: `line:${markdown.trimEnd().split("\n").length}`,
                text: runtimeSlice === "short" ? "2mm" : "<td>防水厚度</td><td>2mm</td>",
                text_sha256: sha256Text(runtimeSlice === "short" ? "2mm" : "<td>防水厚度</td><td>2mm</td>"),
                evidence_scope: "reference" as const, requires_disposition: false, registered_dependency: true }
            : { evidence_id: outsideAtom.atom_id, atom_id: outsideAtom.atom_id, kind: "paragraph" as const,
              role: "context" as const, locator: `char:${outsideAtom.start_offset}-${outsideAtom.end_offset}`,
              text: outsideAtom.text, text_sha256: outsideAtom.text_sha256,
              evidence_scope: "reference" as const, requires_disposition: false, registered_dependency: true };
        const manifest = await failed.extendEvidenceManifest(record);
        const registered = registerSourceSpan(await failed.readSourceSpanRegistry(), {
          source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
        }, 0, record.text.length);
        await writeFile(failed.sourceSpanRegistryPath, prettyJson({ ...registered.registry,
          source_fingerprint: manifest.evidence_fingerprint }), "utf8");
        if (extension !== "unopened") await failed.updateState(state => {
          state.opened_evidence_ids = [...new Set([...(state.opened_evidence_ids ?? []), record.evidence_id])];
        });
        await failed.appendEvent("target_selector_blocker", { kind: "scope_extension_required",
          evidence_span_ids: [registered.span.span_id], affected_selector_paths: ["/items"], explanation: "窗外检验表属于目标主资料。" });
      }
      const failedManifest = await failed.readEvidenceManifest();
      await failed.markTerminal("failed", "target_blocked_with_evidence", {
        blocker_code: "scope_extension_required",
        failure_class: "scope_extension",
      });
      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const failedTarget = persisted.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      failedTarget.status = "failed";
      failedTarget.error = "target_blocked_with_evidence";
      failedTarget.last_blocker_code = "scope_extension_required";
      failedTarget.last_failure_class = "scope_extension";
      failedTarget.scope_extension_refresh_attempts = refreshAttempts;
      failedTarget.attempt_counters = {
        transport_attempts: 0,
        candidate_validation_attempts: 3,
        coverage_repair_attempts: 0,
      };
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      const recovery = recoveryError
        ? vi.spyOn(RevisionWorkspace, "reviseFromTerminalFailure").mockRejectedValue(recoveryError)
        : undefined;
      const readEvidenceManifest = RevisionWorkspace.prototype.readEvidenceManifest;
      const unreadableEvidence = evidenceReadError
        ? vi.spyOn(RevisionWorkspace.prototype, "readEvidenceManifest").mockImplementation(function (this: RevisionWorkspace) {
          if (this.root === failed.root) throw Object.assign(new Error("frozen evidence missing"), { code: "ENOENT" });
          return readEvidenceManifest.call(this);
        }) : undefined;
      const rejectedRuntimeSlice = runtimeSlice === "ambiguous" || runtimeSlice === "short";
      const repeatedBlocker = repeatScopeBlocker || (extension === "opened" && refreshAttempts === 0 && !rejectedRuntimeSlice)
        ? vi.spyOn(targetTools, "runOfflineFixture").mockImplementation(async (workspace) => {
          await workspace.markTerminal("failed", "scope_extension_required", { failure_class: "scope_extension" });
          throw new Error("scope_extension_required: source scope still insufficient after recovery");
        }) : undefined;
      let rerun: FullBatchState;
      try {
        rerun = await runFullBatch({ ...options, targetIds: [TARGET_IDS[0]] });
        if (recovery) expect(recovery).toHaveBeenCalledOnce();
        if (repeatedBlocker) expect(repeatedBlocker).toHaveBeenCalledOnce();
      } finally {
        recovery?.mockRestore();
        unreadableEvidence?.mockRestore();
        repeatedBlocker?.mockRestore();
      }
      const refreshed = rerun.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      if (rejectedRuntimeSlice) {
        expect(refreshed.status).toBe("failed");
        expect(refreshed.error).toContain("source_atom=missing");
        expect(refreshed.scope_extension_refresh_attempts).toBe(0);
        expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!)).revision).toBe(failed.revision);
        expect(await failed.readEvidenceManifest()).toEqual(failedManifest);
        expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
        return;
      }
      if (extension === "unopened") {
        expect(refreshed.status).toBe("failed");
        expect(refreshed.error).toContain("opened=false");
        expect(refreshed.scope_extension_refresh_attempts).toBe(0);
        expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!)).revision).toBe(failed.revision);
        expect(await failed.readEvidenceManifest()).toEqual(failedManifest);
        return;
      }
      if (extension === "opened" && refreshAttempts === 0) {
        const fresh = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
        const manifest = await fresh.readEvidenceManifest();
        expect(fresh.revision).toBe(failed.revision + 1);
        expect(refreshed.scope_extension_refresh_attempts).toBe(1);
        expect(refreshed.scope_extension_atom_ids).toEqual([outsideAtom.atom_id]);
        expect(manifest.scope?.confirmed_scope_fingerprint).toBe(originalManifest.scope?.confirmed_scope_fingerprint);
        for (const original of originalManifest.scope!.primary_source_ranges!) {
          expect(manifest.scope?.primary_source_ranges?.some(range => range.start_line <= original.start_line
            && range.end_exclusive_line >= original.end_exclusive_line)).toBe(true);
        }
        expect(manifest.scope?.selected_end_exclusive_line).toBeGreaterThan(originalManifest.scope!.selected_end_exclusive_line);
        expect(scopeRefreshSourceFingerprint(manifest)).not.toBe(scopeRefreshSourceFingerprint(failedManifest));
        expect(manifest.evidence.some(record => record.evidence_scope === "primary" && record.text.includes("防水厚度"))).toBe(true);
        expect(manifest.table_fragments.some(fragment => fragment.row_evidence_ids.length > 0)).toBe(true);
        for (const record of originalManifest.evidence.filter(record => record.evidence_scope === "primary")) {
          expect(manifest.evidence).toContainEqual(record);
        }
        expect(await failed.readEvidenceManifest()).toEqual(failedManifest);
        if (hasSavedItems) expect(await readFile(fresh.workingSelectorPath, "utf8")).toBe(savedBytes);
        const freshRevision = fresh.revision;
        const stopAfterOpen = vi.spyOn(targetTools, "runOfflineFixture").mockImplementation(async workspace => {
          await workspace.markTerminal("failed", "scope_extension_required", { failure_class: "scope_extension" });
          throw new Error("scope_extension_required: source scope still insufficient after recovery");
        });
        let resumed: FullBatchState;
        try {
          resumed = await runFullBatch({ ...options, targetIds: [TARGET_IDS[0]] });
        } finally {
          stopAfterOpen.mockRestore();
        }
        expect(resumed.targets[0]!.scope_extension_refresh_attempts).toBe(1);
        const reopened = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
        expect(reopened.revision).toBe(hasSavedItems ? freshRevision + 1 : freshRevision);
        expect((await reopened.readEvidenceManifest()).scope?.primary_source_ranges).toEqual(manifest.scope?.primary_source_ranges);
        expect((await reopened.readEvidenceManifest()).scope?.scope_extension_atom_ids).toEqual([outsideAtom.atom_id]);
        return;
      }
      if (evidenceReadError) {
        expect(refreshed.status).toBe("failed");
        expect(refreshed.error).toContain("scope refresh comparison failed");
        expect(refreshed.error).toContain("no blank refresh was attempted");
        expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!)).revision).toBe(failed.revision);
        expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
        return;
      }
      if (recoveryError?.message === "checkpoint copy missing") {
        expect(refreshed.status).toBe("failed");
        expect(refreshed.error).toContain("checkpoint recovery failed: checkpoint copy missing");
        expect(refreshed.error).toContain("no blank refresh was attempted");
        expect(refreshed.scope_extension_refresh_attempts).toBe(0);
        expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!)).revision).toBe(failed.revision);
        expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
        return;
      }
      if (hasSavedItems && !recoveryError) {
        if (repeatScopeBlocker) {
          expect(refreshed.status).toBe("failed");
          expect(refreshed.error).toContain("source scope still insufficient after recovery");
        }
        // 真正继承完整 selector，而不只是换成不再报旧错误的空白 revision。
        expect(refreshed.error ?? "").not.toContain("automatic blank scope refresh is forbidden");
        expect(refreshed.scope_extension_refresh_attempts ?? 0).toBe(refreshAttempts);
        const recovered = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
        expect(recovered.revision).toBe(failed.revision + 1);
        expect(await readFile(recovered.workingSelectorPath, "utf8")).toBe(savedBytes);
        expect(await recovered.readState()).toMatchObject({ lineage: {
          source_revision: failed.revision,
          selector_checkpoint_revision: failed.revision,
          recovery_kind: "terminal_checkpoint",
        } });
        expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
        expect(await failed.readState()).toMatchObject({ status: "failed", terminal_failure_class: "scope_extension" });
        return;
      }
      if (refreshAttempts > 0) {
        expect(refreshed.status).toBe("failed");
        expect(refreshed.error).toContain("one fresh evidence revision already completed");
        expect(refreshed.scope_extension_refresh_attempts).toBe(1);
        expect((await RevisionWorkspace.openLatest(artifactRoot,jobId,TARGET_IDS[0]!)).revision).toBe(failed.revision);
        return;
      }
      expect(refreshed).toMatchObject({
        status: "failed",
        scope_extension_refresh_attempts: 0,
      });
      expect(refreshed.error).toContain("scope_refresh_no_source_change");
      expect(refreshed.error).toContain("do not edit evidence or sealed artifacts");
      expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
      expect(await failed.readState()).toMatchObject({
        status: "failed",
        terminal_reason: "target_blocked_with_evidence",
        terminal_blocker_code: "scope_extension_required",
        terminal_failure_class: "scope_extension",
      });
      const fresh = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      expect(fresh.revision).toBe(failed.revision);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  test("scope-extension terminal recovers the usable working draft after the one-refresh limit (GB 50210 金属幕墙实测回归)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-scope-blocker-draft-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "scope-blocker-draft-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 3,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const failed = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      // 金属幕墙的形状：草稿有累计工作、历史非空、best/last-valid 信任都不可用。
      const draft = JSON.parse(await readFile(failed.workingSelectorPath, "utf8"));
      const span = (await failed.readSourceSpanRegistry()).spans[0]!.span_id;
      const none = { composition: "not_applicable", span_ids: [], separator: "", reason: "未单列" };
      draft.lots = [{ key: "saved-lot", name: "已有检验批", scope_span_ids: [span], reason: "原文范围" }];
      draft.items = [{ key: "saved-item", lot_key: "saved-lot", name: "已有质量检查", category: "一般项目", criterion_span_ids: [span], continuation_span_ids: [], fields: { name: { composition: "semantic_summary", span_ids: [span], separator: "", reason: "原文对象" }, requirement: { composition: "verbatim", span_ids: [span], separator: "", reason: "原文要求" }, method: none, quantity: none, note: none }, table: null, inspection_data_type: "review", inspection_data_type_reason: "核查原文", inspection_data_type_span_ids: [span], sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "未单列抽样", confidence: 1 }, reason: "已经保存的有效工作" }];
      await failed.writeWorkingSelectors(prettyJson(draft));
      const savedBytes = await readFile(failed.workingSelectorPath, "utf8");
      await failed.updateState(state => {
        state.selector_protocol = {
          ...state.selector_protocol!,
          best_draft_fingerprint: "",
          best_preflight_stage_rank: 0,
          best_issue_count: null,
        };
      });
      await failed.appendEvent("target_selector_blocker", { kind: "scope_extension_required",
        evidence_span_ids: [], affected_selector_paths: ["/items"], explanation: "底账必抽条文核对未通过。" });
      await failed.markTerminal("failed", "target_blocked_with_evidence", {
        blocker_code: "scope_extension_required",
        failure_class: "scope_extension",
      });
      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const failedTarget = persisted.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      failedTarget.status = "failed";
      failedTarget.error = "target_blocked_with_evidence";
      failedTarget.last_blocker_code = "scope_extension_required";
      failedTarget.last_failure_class = "scope_extension";
      failedTarget.scope_extension_refresh_attempts = 1;
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      const rerun = await runFullBatch({ ...options, targetIds: [TARGET_IDS[0]] });
      const resumed = rerun.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      // 检查点恢复不消耗一次性 fresh 配额：attempts 保持 1，草稿逐字继承。
      expect(resumed.scope_extension_refresh_attempts).toBe(1);
      const recovered = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      expect(recovered.revision).toBe(failed.revision + 1);
      expect(await readFile(recovered.workingSelectorPath, "utf8")).toBe(savedBytes);
      expect(await recovered.readState()).toMatchObject({ lineage: {
        source_revision: failed.revision,
        selector_checkpoint_revision: failed.revision,
        recovery_kind: "terminal_checkpoint",
      } });
      expect(await readFile(failed.workingSelectorPath, "utf8")).toBe(savedBytes);
      expect(await failed.readState()).toMatchObject({ status: "failed", terminal_failure_class: "scope_extension" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  test("scope refresh identity ignores record order but detects new source or scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-scope-refresh-identity-"));
    try {
      const markdownPath = join(root, "source.md");
      const markdown = "# 9.1 器件\n9.1.1 连接应牢固。\n9.1.2 尺寸应符合设计要求。";
      await writeFile(markdownPath, markdown, "utf8");
      const plan = discoveryPlan("scope-identity", markdown);
      const evidence = buildDocumentEvidence(markdown, "source.md");
      const target = plan.targets[0]!;
      target.evidence_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: markdown }];
      target.materialization.lot_basis_fragments = [{ atom_id: evidence.atoms[0]!.atom_id, text: "# 9.1 器件" }];
      const prepared = await buildAgentScopedEvidenceManifest(markdownPath, "scope-identity", target, evidence);
      const reordered = structuredClone(prepared.manifest);
      reordered.evidence.reverse();
      reordered.evidence_fingerprint = "different-order-fingerprint";
      expect(scopeRefreshSourceFingerprint(reordered)).toBe(scopeRefreshSourceFingerprint(prepared.manifest));
      const narrower = await buildAgentScopedEvidenceManifest(markdownPath, "scope-identity", target, evidence,
        undefined, { start_line: 1, end_exclusive_line: 3 });
      expect(scopeRefreshSourceFingerprint(narrower.manifest)).not.toBe(scopeRefreshSourceFingerprint(prepared.manifest));
      const differentSource = structuredClone(prepared.manifest);
      differentSource.source.sha256 = sha256Text("another source version");
      expect(scopeRefreshSourceFingerprint(differentSource)).not.toBe(scopeRefreshSourceFingerprint(prepared.manifest));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("starts one selected target from sealed discovery evidence without copying dirty revision state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-fresh-target-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const pdfPath = join(root, "source.pdf");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "fresh-target-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      const plan = discoveryPlan(jobId, markdown);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(pdfPath, "fresh-target-pdf", "utf8");
      await writeFile(discoveryPlanPath, prettyJson(plan), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        pdfPath,
        concurrency: 3,
        maxAttempts: 2,
        live: false,
        discoveryPlanPath,
      };
      const first = await runFullBatch(options);
      expect(first.status).toBe("passed");

      await expect(runFullBatch({
        ...options,
        targetIds: ["target:missing"],
        freshTargetIds: ["target:missing"],
      })).rejects.toThrow(/Unknown targetIds requested/);

      const untouchedSnapshots = new Map<string, Record<string, string>>();
      for (const targetId of TARGET_IDS.slice(1)) {
        const target = first.targets.find((candidate) => candidate.target_id === targetId)!;
        untouchedSnapshots.set(
          targetId,
          await fileTreeSnapshot(join(target.workdir, "..", "..")),
        );
      }

      const dirty = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
      );
      const dependencyText = "旧会话登记的依赖不得进入全新 revision";
      await dirty.extendEvidenceManifest({
        evidence_id: `atom:${sha256Text(dependencyText)}`,
        kind: "paragraph",
        role: "context",
        locator: "char:9000-9020",
        text: dependencyText,
        text_sha256: sha256Text(dependencyText),
        requires_disposition: false,
        evidence_scope: "reference",
        registered_dependency: true,
      });
      await writeFile(dirty.bestSelectorPath, `${dependencyText}\n`, "utf8");
      await writeFile(dirty.lastValidPlanPath, `${dependencyText}\n`, "utf8");
      await writeFile(dirty.lastValidSelectorPath, `${dependencyText}\n`, "utf8");
      await writeFile(join(dirty.historyDirectory, "old-history.json"), dependencyText, "utf8");
      await writeFile(join(dirty.validationDirectory, "old-validation.json"), dependencyText, "utf8");
      await writeFile(join(dirty.coverageReviewDirectory, "old-coverage.json"), dependencyText, "utf8");
      await writeFile(join(dirty.piSessionDirectory, "old-session.jsonl"), dependencyText, "utf8");
      await dirty.updateState((state) => {
        state.opened_evidence_ids = ["evidence:old"];
        state.opened_global_resource_ids = ["atom:old"];
        state.selector_protocol.submissions = 9;
        state.agent_runtime = {
          kind: "pi-sdk",
          session_id: "old-session",
          session_file: join(dirty.piSessionDirectory, "old-session.jsonl"),
        };
      });

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const failedTarget = persisted.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      failedTarget.status = "failed";
      failedTarget.error = "ETIMEDOUT from old session";
      failedTarget.last_failure_class = "transport";
      failedTarget.attempt_counters = {
        transport_attempts: 7,
        candidate_validation_attempts: 6,
        coverage_repair_attempts: 5,
      };
      failedTarget.transport_retry_window = {
        checkpoint: "old-checkpoint",
        consecutive_failures: 4,
      };
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      const documentEvidence = buildDocumentEvidence(markdown, "source.md");
      const prepared = await buildAgentScopedEvidenceManifest(
        markdownPath,
        jobId,
        plan.targets[0]!,
        documentEvidence,
        pdfPath,
        targetEvidenceLineSpan(plan.targets[0]!, documentEvidence),
      );
      const rerun = await runFullBatch({
        ...options,
        targetIds: [TARGET_IDS[0]],
        freshTargetIds: [TARGET_IDS[0]],
      });
      const refreshed = rerun.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(refreshed).toMatchObject({
        status: "sealed",
        revision: 3,
        error: "",
        attempt_counters: {
          transport_attempts: 0,
          candidate_validation_attempts: 0,
          coverage_repair_attempts: 0,
        },
      });
      expect(refreshed.transport_retry_window).toBeUndefined();
      expect(refreshed.last_failure_class).toBeUndefined();

      const fresh = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]);
      expect(fresh.revision).toBe(3);
      expect(await fresh.readEvidenceManifest()).toEqual(prepared.manifest);
      expect(await readFile(fresh.sourceMarkdownPath, "utf8")).toBe(markdown);
      expect(await readdir(fresh.piSessionDirectory)).not.toContain("old-session.jsonl");
      expect(await readdir(fresh.coverageReviewDirectory)).not.toContain("old-coverage.json");
      expect(await readdir(fresh.historyDirectory)).not.toContain("old-history.json");
      expect(await readdir(fresh.validationDirectory)).not.toContain("old-validation.json");
      if (await pathExists(fresh.bestSelectorPath)) {
        expect(await readFile(fresh.bestSelectorPath, "utf8")).not.toContain(dependencyText);
      }
      expect(await readFile(fresh.lastValidPlanPath, "utf8")).not.toContain(dependencyText);

      const resumable = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0],
      );
      expect(resumable.revision).toBe(4);
      const resumed = await runFullBatch({
        ...options,
        targetIds: [TARGET_IDS[0]],
      });
      expect(resumed.targets.find((target) => target.target_id === TARGET_IDS[0])?.revision).toBe(4);
      expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0])).revision).toBe(4);

      for (const targetId of TARGET_IDS.slice(1)) {
        const target = rerun.targets.find((candidate) => candidate.target_id === targetId)!;
        expect(target.revision).toBe(1);
        expect(await fileTreeSnapshot(join(target.workdir, "..", "..")))
          .toEqual(untouchedSnapshots.get(targetId));
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("does not rerun the Agent when a sealed manifest only adds registered dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-manifest-extension-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "manifest-extension-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      const plan = discoveryPlan(jobId, markdown);
      await writeFile(discoveryPlanPath, prettyJson(plan), "utf8");
      const documentEvidence = buildDocumentEvidence(markdown, "source.md");
      const prepared = await buildAgentScopedEvidenceManifest(
        markdownPath,
        jobId,
        plan.targets[0]!,
        documentEvidence,
        undefined,
        targetEvidenceLineSpan(plan.targets[0]!, documentEvidence),
      );
      const workspace = await RevisionWorkspace.createFromEvidence(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
        prepared,
      );
      const dependencyText = "独立登记的共享引用原文";
      await workspace.extendEvidenceManifest({
        evidence_id: `atom:${sha256Text(dependencyText)}`,
        kind: "paragraph",
        role: "context",
        locator: "char:9000-9012",
        text: dependencyText,
        text_sha256: sha256Text(dependencyText),
        requires_disposition: false,
        evidence_scope: "reference",
        registered_dependency: true,
      });
      await runOfflineFixture(workspace, await ToolController.create(workspace));

      const result = await runFullBatch({
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      });

      const reused = result.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(reused).toMatchObject({ status: "sealed", attempts: 0, error: "" });
      expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!)).revision)
        .toBe(reused.revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test.each(["unchanged", "evidence", "scope", "markdown", "pdf", "missing_pdf", "missing_evidence"] as const)(
    "resumes a sealed source snapshot despite layout drift, with %s integrity",
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), "pi-batch-sealed-snapshot-"));
      const layout = vi.spyOn(piRuntime, "runLivePdfLayoutProfile").mockResolvedValue({ model: "fixture" });
      const author = vi.spyOn(piRuntime, "runLivePi").mockImplementation(async (workspace, controller) => {
        expect(await runOfflineFixture(workspace, controller)).toMatchObject({ ok: true });
        return { sealed: true, model: "fixture", session_id: "fixture", session_file: "" };
      });
      try {
        const jobId = "sealed-snapshot-job";
        const markdownPath = join(root, "source.md");
        const pdfPath = join(root, "source.pdf");
        const discoveryPlanPath = join(root, "discovery-plan.json");
        const markdown = "地基承载力应满足设计要求。\n## 检查说明\n检查方法应符合设计要求。";
        const plan = confirmedDiscoveryPlan(jobId, markdown);
        plan.targets = [plan.targets[0]!];
        plan.dispositions[0]!.target_ids = [TARGET_IDS[0]];
        await writeFile(markdownPath, markdown);
        await writeFile(pdfPath, "immutable PDF fixture");
        await writeFile(discoveryPlanPath, prettyJson(plan));
        const options: FullBatchOptions = { artifactRoot: join(root, "artifacts"), jobId,
          markdownPath, pdfPath, concurrency: 1, maxAttempts: 1, live: true };
        await runFullDocumentDiscovery({ ...options, live: false, discoveryPlanPath });
        const initial = await runFullBatch(options);
        expect(initial.status).toBe("passed");
        expect(author).toHaveBeenCalledTimes(1);
        const workspace = await RevisionWorkspace.openLatest(options.artifactRoot, jobId, TARGET_IDS[0]);
        const discovery = await DocumentDiscoveryWorkspace.openOrCreate(options.artifactRoot, jobId, markdownPath);
        const original = await fileTreeSnapshot(workspace.root);
        // Simulate a profile written by a prior buggy resume. Reclassification
        // must not rewrite or invalidate the independently validated sealed set.
        await writeFile(discovery.pdfLayoutProfilePath, prettyJson({ structural_heading_lines: [2],
          promoted_headings: [], promoted_pdf_lines: [], pdf_only_lines: [], markdown_alignments: [] }));
        if (change === "missing_pdf" || change === "missing_evidence") {
          const path = change === "missing_pdf" ? workspace.sourcePdfPath : workspace.evidenceManifestPath;
          await chmod(path, 0o644);
          await rm(path);
        } else if (change === "evidence" || change === "scope") {
          const evidence = await workspace.readEvidenceManifest();
          if (change === "evidence") evidence.evidence[0]!.text += " tampered";
          else evidence.scope!.confirmed_scope_fingerprint = "f".repeat(64);
          const { evidence_fingerprint: _fingerprint, ...payload } = evidence;
          // A scope mismatch remains forbidden even with a consistent local hash.
          if (change === "scope") evidence.evidence_fingerprint = sha256Json(payload);
          await chmod(workspace.evidenceManifestPath, 0o644);
          await writeFile(workspace.evidenceManifestPath, prettyJson(evidence));
        } else if (change !== "unchanged") {
          const path = change === "pdf" ? workspace.sourcePdfPath : workspace.sourceMarkdownPath;
          await chmod(path, 0o644);
          await writeFile(path, "tampered frozen source");
        }
        initial.targets[0]!.status = "failed";
        initial.targets[0]!.error = "target_selector_resume_evidence_mismatch";
        await writeFile(join(options.artifactRoot, "jobs", jobId, "batch.json"), prettyJson(initial));
        const resumed = await runFullBatch(options);
        expect(layout).not.toHaveBeenCalled(); // Discovery was already sealed before both runs.
        expect(author).toHaveBeenCalledTimes(1);
        if (change === "unchanged") {
          expect(resumed.status).toBe("passed");
          expect(resumed.targets[0]).toMatchObject({ status: "sealed", revision: 1, error: "" });
          expect(await fileTreeSnapshot(workspace.root)).toEqual(original);
        } else {
          expect(resumed.status).toBe("failed");
          expect(resumed.targets[0]!.error).toContain("sealed_target_source_identity_mismatch");
          expect(resumed.targets[0]!.error).toContain("不能修改");
        }
      } finally {
        layout.mockRestore(); author.mockRestore();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 30_000,
  );

  test("opens an editable inherited revision when a sealed selector fails the current compiler contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-sealed-selector-contract-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "sealed-selector-contract-job";
      const clause = "地基承载力应满足设计要求。";
      const markdown = clause.repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const sealed = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      const manifest = await sealed.readEvidenceManifest();
      const evidence = manifest.evidence[0]!;
      const immutableSource = {
        source_id: evidence.evidence_id,
        evidence_id: evidence.evidence_id,
        atom_id: evidence.evidence_id,
        text: evidence.text,
      };
      let registry = await sealed.readSourceSpanRegistry();
      const fullSourceSpan = registry.spans.find((span) => (
        span.evidence_id === evidence.evidence_id
        && span.start === 0
        && span.end === evidence.text.length
      ))!;
      const firstCriterion = registerSourceSpan(
        registry,
        immutableSource,
        0,
        clause.length,
      );
      registry = firstCriterion.registry;
      const secondCriterion = registerSourceSpan(
        registry,
        immutableSource,
        clause.length,
        clause.length * 2,
      );
      registry = secondCriterion.registry;

      const selectors = initialTargetSelectorPlan(manifest);
      selectors.lots.push({
        key: "lot",
        name: "检验批 lot",
        scope_span_ids: [fullSourceSpan.span_id],
        reason: "目标证据范围",
      });
      const item = (
        key: string,
        criterionSpanId: string,
        contaminated: boolean,
      ): typeof selectors.items[number] => ({
        key,
        lot_key: "lot",
        name: key,
        category: "一般项目",
        criterion_span_ids: [criterionSpanId],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [criterionSpanId], separator: "", reason: "验收对象" },
          requirement: { composition: "verbatim", span_ids: [criterionSpanId], separator: "", reason: "验收要求" },
          method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未单列方法" },
          quantity: contaminated
            ? { composition: "verbatim", span_ids: [fullSourceSpan.span_id], separator: "", reason: "故意注入跨项整窗" }
            : { composition: "not_applicable", span_ids: [], separator: "", reason: "未给数量" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "形成验收复核结论",
        inspection_data_type_span_ids: [criterionSpanId],
        sampling: contaminated
          ? {
              status: "explicit",
              rule_key: "",
              branch_keys: [],
              quantity_span_ids: [fullSourceSpan.span_id],
              script_span_ids: [fullSourceSpan.span_id],
              condition_span_ids: [],
              reason: "故意注入跨项整窗",
              confidence: 1,
            }
          : {
              status: "fallback",
              rule_key: "",
              branch_keys: [],
              quantity_span_ids: [],
              script_span_ids: [],
              condition_span_ids: [],
              reason: "未形成抽样",
              confidence: 1,
            },
        reason: "独立验收判断",
      });
      selectors.items.push(
        item("first", firstCriterion.span.span_id, true),
        item("second", secondCriterion.span.span_id, false),
      );
      try {
        compileTargetSelectors(selectors, registry, manifest);
        throw new Error("expected a current selector compiler issue");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "selector_scalar_span_crosses_item_boundaries" }),
        ]));
      }

      const contaminatedSelectorText = prettyJson(selectors);
      const contaminatedRegistryText = prettyJson(registry);
      await chmod(sealed.sealedSelectorPath, 0o644);
      await writeFile(sealed.sealedSelectorPath, contaminatedSelectorText, "utf8");
      await chmod(sealed.sourceSpanRegistryPath, 0o644);
      await writeFile(sealed.sourceSpanRegistryPath, contaminatedRegistryText, "utf8");
      await sealed.updateState((state) => {
        state.agent_runtime = {
          kind: "pi-sdk",
          session_id: "sealed-live-selector-session",
          session_file: join(sealed.piSessionDirectory, "sealed-live-selector-session.jsonl"),
        };
      });
      const sealedCoverageSnapshot = await fileTreeSnapshot(sealed.coverageReviewDirectory);

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const target = batch.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
      target.status = "running";
      target.error = "resume must recheck the sealed selector compiler contract";
      await writeFile(batchPath, prettyJson(batch), "utf8");

      const abortController = new AbortController();
      let enteredEditableRevision = false;
      await expect(runFullBatch({
        ...options,
        targetIds: [TARGET_IDS[0]],
        signal: abortController.signal,
        onStateChange: (state) => {
          const current = state.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
          if (
            !enteredEditableRevision
            && current.revision === sealed.revision + 1
            && current.status === "running"
          ) {
            enteredEditableRevision = true;
            abortController.abort();
            abortController.signal.throwIfAborted();
          }
        },
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(enteredEditableRevision).toBe(true);

      const editable = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      expect(editable.revision).toBe(sealed.revision + 1);
      expect(await editable.readState()).toMatchObject({
        status: "working",
        agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
        lineage: {
          source_revision: sealed.revision,
          selector_checkpoint_revision: sealed.revision,
          registry_checkpoint_revision: sealed.revision,
          recovery_kind: "sealed_checkpoint",
        },
      });
      expect(await readFile(editable.workingSelectorPath, "utf8")).toBe(contaminatedSelectorText);
      expect(await readFile(editable.sourceSpanRegistryPath, "utf8")).toBe(contaminatedRegistryText);
      expect(await readdir(editable.coverageReviewDirectory)).toEqual([]);
      expect(await pathExists(join(editable.root, "deterministic-rematerialization.json"))).toBe(false);
      expect(await pathExists(editable.manifestPath)).toBe(false);
      expect(await readdir(editable.piSessionDirectory)).toEqual([]);
      expect(await sealed.readState()).toMatchObject({ status: "sealed" });
      expect(await fileTreeSnapshot(sealed.coverageReviewDirectory)).toEqual(sealedCoverageSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("opens an editable revision when the current selector replay differs from the sealed result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-sealed-selector-replay-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "sealed-selector-replay-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 1,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const sealed = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      const manifest = await sealed.readEvidenceManifest();
      const evidence = manifest.evidence[0]!;
      const registry = await sealed.readSourceSpanRegistry();
      const fullSourceSpan = registry.spans.find((span) => (
        span.evidence_id === evidence.evidence_id
        && span.start === 0
        && span.end === evidence.text.length
      ))!;
      const selectors = initialTargetSelectorPlan(manifest);
      selectors.lots.push({
        key: "current-lot",
        name: "当前选择器检验批",
        scope_span_ids: [fullSourceSpan.span_id],
        reason: "完整目标范围",
      });
      selectors.items.push({
        key: "current-item",
        lot_key: "current-lot",
        name: "当前选择器验收项目",
        category: "主控项目",
        criterion_span_ids: [fullSourceSpan.span_id],
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: [fullSourceSpan.span_id], separator: "", reason: "验收对象" },
          requirement: { composition: "verbatim", span_ids: [fullSourceSpan.span_id], separator: "", reason: "验收要求" },
          method: { composition: "not_applicable", span_ids: [], separator: "", reason: "未单列方法" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "未给数量" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "形成验收复核结论",
        inspection_data_type_span_ids: [fullSourceSpan.span_id],
        sampling: {
          status: "fallback",
          rule_key: "",
          branch_keys: [],
          quantity_span_ids: [],
          script_span_ids: [],
          condition_span_ids: [],
          reason: "未形成抽样",
          confidence: 1,
        },
        reason: "当前选择器的独立验收判断",
      });
      const replay = compileTargetSelectors(selectors, registry, manifest);
      expect(validatePlanText(prettyJson(replay), manifest)).toMatchObject({ ok: true });

      const selectorText = prettyJson(selectors);
      await chmod(sealed.sealedSelectorPath, 0o644);
      await writeFile(sealed.sealedSelectorPath, selectorText, "utf8");
      await sealed.updateState((state) => {
        state.agent_runtime = {
          kind: "pi-sdk",
          session_id: "sealed-live-selector-session",
          session_file: join(sealed.piSessionDirectory, "sealed-live-selector-session.jsonl"),
        };
      });
      const sealedCoverageSnapshot = await fileTreeSnapshot(sealed.coverageReviewDirectory);
      const sealedResultText = await readFile(sealed.resultPath, "utf8");

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const target = batch.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
      target.status = "running";
      target.error = "resume must compare the current selector replay";
      await writeFile(batchPath, prettyJson(batch), "utf8");

      const abortController = new AbortController();
      let enteredEditableRevision = false;
      await expect(runFullBatch({
        ...options,
        targetIds: [TARGET_IDS[0]],
        signal: abortController.signal,
        onStateChange: (state) => {
          const current = state.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
          if (!enteredEditableRevision && current.revision === sealed.revision + 1 && current.status === "running") {
            enteredEditableRevision = true;
            abortController.abort();
            abortController.signal.throwIfAborted();
          }
        },
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(enteredEditableRevision).toBe(true);

      const editable = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      expect(editable.revision).toBe(sealed.revision + 1);
      expect(await readFile(editable.workingSelectorPath, "utf8")).toBe(selectorText);
      expect(await readdir(editable.coverageReviewDirectory)).toEqual([]);
      expect(await pathExists(join(editable.root, "deterministic-rematerialization.json"))).toBe(false);
      expect(await readFile(sealed.resultPath, "utf8")).toBe(sealedResultText);
      expect(await fileTreeSnapshot(sealed.coverageReviewDirectory)).toEqual(sealedCoverageSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("rejects sealed fast-path reuse when result, seal, or validation receipts are stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-sealed-integrity-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "sealed-integrity-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 3,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const workspaces = await Promise.all(TARGET_IDS.map((targetId) =>
        RevisionWorkspace.openLatest(artifactRoot, jobId, targetId)
      ));
      const rewriteJson = async (
        path: string,
        mutate: (value: Record<string, unknown>) => void,
      ): Promise<string> => {
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        mutate(value);
        const content = prettyJson(value);
        await chmod(path, 0o644);
        await writeFile(path, content, "utf8");
        return content;
      };
      const refreshManifestFileHash = async (
        workspace: RevisionWorkspace,
        name: string,
        content: string,
      ): Promise<void> => {
        await rewriteJson(workspace.manifestPath, (manifest) => {
          const fingerprints = manifest.fingerprints as Record<string, unknown>;
          const files = fingerprints.files as Record<string, unknown>;
          files[name] = sha256Text(content);
        });
      };

      const staleResultContent = await rewriteJson(workspaces[0]!.resultPath, (result) => {
        result.plan_fingerprint = "a".repeat(64);
      });
      await refreshManifestFileHash(workspaces[0]!, "result.json", staleResultContent);

      const staleSealContent = await rewriteJson(workspaces[1]!.sealReceiptPath, (receipt) => {
        receipt.validation_fingerprint = "b".repeat(64);
      });
      await refreshManifestFileHash(workspaces[1]!, "seal-receipt.json", staleSealContent);

      await rewriteJson(workspaces[2]!.validationReceiptPath, (receipt) => {
        receipt.plan_sha256 = "c".repeat(64);
      });

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const persisted = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      for (const target of persisted.targets) {
        target.status = "running";
        target.error = "resume sealed integrity check";
      }
      await writeFile(batchPath, prettyJson(persisted), "utf8");

      const resumed = await runFullBatch(options);
      expect(resumed.status).toBe("passed");
      for (const targetId of TARGET_IDS) {
        const target = resumed.targets.find((candidate) => candidate.target_id === targetId)!;
        expect(target).toMatchObject({ status: "sealed", revision: 2, error: "" });
        expect((await RevisionWorkspace.openLatest(artifactRoot, jobId, targetId)).revision).toBe(2);
      }
      expect(JSON.parse(await readFile(workspaces[0]!.resultPath, "utf8"))).toMatchObject({
        plan_fingerprint: "a".repeat(64),
      });
      expect(JSON.parse(await readFile(workspaces[1]!.sealReceiptPath, "utf8"))).toMatchObject({
        validation_fingerprint: "b".repeat(64),
      });
      expect(JSON.parse(await readFile(workspaces[2]!.validationReceiptPath, "utf8"))).toMatchObject({
        plan_sha256: "c".repeat(64),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("keeps real slots and rematerializes a stale result without another Agent attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-slots-"));
    const executeOffline = targetTools.runOfflineFixture;
    let offlineSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(discoveryPlan("slot-job", markdown)),
        "utf8",
      );
      const baseOptions: FullBatchOptions = {
        artifactRoot,
        jobId: "slot-job",
        markdownPath,
        concurrency: 10,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      const first = await runFullBatch(baseOptions);
      expect(first.status).toBe("passed");

      const staleResultWorkspace = await RevisionWorkspace.openLatest(
        artifactRoot,
        "slot-job",
        TARGET_IDS[0]!,
      );
      const staleResult = JSON.parse(
        await readFile(staleResultWorkspace.resultPath, "utf8"),
      ) as {
        inspection_lots: Array<{
          items: Array<{
            requirement: string;
            source_clause: string;
            reference_source_clause: string;
            reference_from_clause: string;
          }>;
        }>;
      };
      const staleItem = staleResult.inspection_lots[0]!.items[0]!;
      staleItem.requirement = "$d \\leqslant 120\\text{mm}$";
      staleItem.reference_from_clause = "4.4.2";
      staleItem.reference_source_clause = "15.0.8";
      staleItem.source_clause = "15.0.8";
      await chmod(staleResultWorkspace.resultPath, 0o644);
      await writeFile(staleResultWorkspace.resultPath, prettyJson(staleResult), "utf8");
      const staleResultState = await staleResultWorkspace.readState();
      await rm(join(
        staleResultWorkspace.coverageReviewDirectory,
        staleResultState.last_valid_fingerprint,
        "materialized-result.sha256",
      ));

      for (const targetId of TARGET_IDS.slice(1)) {
        const workspace = await RevisionWorkspace.openLatest(artifactRoot, "slot-job", targetId);
        const manifest = JSON.parse(await readFile(workspace.evidenceManifestPath, "utf8")) as {
          source: { semantic_workflow?: string };
        };
        delete manifest.source.semantic_workflow;
        await chmod(workspace.evidenceManifestPath, 0o644);
        await writeFile(workspace.evidenceManifestPath, prettyJson(manifest), "utf8");
      }

      const batchPath = join(artifactRoot, "jobs", "slot-job", "batch.json");
      const stale = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      for (const target of stale.targets) {
        target.status = "running";
        target.error = "stale persisted running state";
      }
      await writeFile(batchPath, prettyJson(stale), "utf8");

      // Rematerialization occupies a worker without a running Agent. A fast
      // offline target may finish before that worker reaches the third target.
      // Hold the two real attempts at an explicit barrier, not an I/O timing bet.
      const startedTargets = new Set<string>();
      let releaseAttempts!: () => void;
      const bothStarted = new Promise<void>(resolve => { releaseAttempts = resolve; });
      offlineSpy = vi.spyOn(targetTools, "runOfflineFixture").mockImplementation(async (workspace, controller) => {
        startedTargets.add(workspace.targetId);
        if (startedTargets.size === 2) releaseAttempts();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            bothStarted,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error("Both offline target slots must start concurrently")), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
        return executeOffline(workspace, controller);
      });
      const snapshots: FullBatchState[] = [];
      const second = await runFullBatch({
        ...baseOptions,
        concurrency: 2,
        onStateChange: async (state) => {
          const snapshot = structuredClone(state);
          snapshots.push(snapshot);
          for (const target of snapshot.targets.filter((candidate) => candidate.status === "running")) {
            expect(target.target_id).not.toBe(TARGET_IDS[0]);
            expect(target.error).toBe("");
            const workspace = await RevisionWorkspace.openLatest(
              artifactRoot,
              "slot-job",
              target.target_id,
            );
            expect(target.revision).toBe(2);
            expect(target.revision).toBe(workspace.revision);
            expect(target.workdir).toBe(workspace.root);
            expect(["working", "sealed"]).toContain((await workspace.readState()).status);
          }
        },
      });

      expect(snapshots.some((snapshot) => (
        snapshot.targets.filter((target) => target.status === "running").length === 2
      ))).toBe(true);
      expect([...startedTargets].sort()).toEqual([...TARGET_IDS.slice(1)].sort());
      const valid = second.targets.find((target) => target.target_id === TARGET_IDS[0])!;
      expect(valid).toMatchObject({ status: "sealed", revision: 2, attempts: 1, error: "" });
      const rematerialized = JSON.parse(await readFile(
        (await RevisionWorkspace.openLatest(artifactRoot, "slot-job", TARGET_IDS[0]!)).resultPath,
        "utf8",
      )) as { inspection_lots: Array<{ items: Array<{ requirement: string; reference_from_clause: string }> }> };
      expect(rematerialized.inspection_lots[0]!.items[0]!.reference_from_clause).toBe("");
      expect(rematerialized.inspection_lots[0]!.items[0]!.requirement)
        .not.toContain("\\leqslant");
      for (const targetId of TARGET_IDS.slice(1)) {
        expect(second.targets.find((target) => target.target_id === targetId)).toMatchObject({
          status: "sealed",
          revision: 2,
          attempts: 2,
          error: "",
        });
      }
      expect(JSON.parse(await readFile(batchPath, "utf8"))).toEqual(second);
      const aggregate = JSON.parse(await readFile(
        join(artifactRoot, "jobs", "slot-job", "result.json"),
        "utf8",
      ));
      expect(aggregate.targets[0].target_definition.materialization).toMatchObject({
        lot_basis_summary: "以地基承载力是否满足设计要求作为检验批划分依据",
        lot_basis_fragments: [{
          atom_id: expect.any(String),
          text: "地基承载力应满足设计要求",
        }],
        reason: "原文直接规定可形成检验批的地基实体质量要求",
      });
    } finally {
      offlineSpy?.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("preserves a sealed repair-delta coverage scope while writing a current rematerialization receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-rematerialize-delta-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "rematerialize-delta-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 3,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const workspace = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      const state = await workspace.readState();
      const result = JSON.parse(await readFile(workspace.resultPath, "utf8")) as {
        inspection_lots: Array<{ items: Array<{ item_id: string; evidence_ids: string[] }> }>;
      };
      const item = result.inspection_lots[0]!.items[0]!;
      const reviewDirectory = join(workspace.coverageReviewDirectory, state.last_valid_fingerprint);
      const reviewPath = join(reviewDirectory, "coverage-review.json");
      const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
        status: string;
        semantic_coverage: Array<{ disposition: string }>;
      };
      review.semantic_coverage = review.semantic_coverage.filter((row) => row.disposition === "acceptance_item");
      const reviewContent = prettyJson(review);
      await chmod(reviewPath, 0o644);
      await writeFile(reviewPath, reviewContent, "utf8");
      await workspace.updateState((current) => {
        current.coverage_recheck = {
          schema_version: "coverage-recheck-scope/v1",
          plan_fingerprint: current.last_valid_fingerprint,
          source_plan_fingerprint: "f".repeat(64),
          review_fingerprint: "e".repeat(64),
          finding_ids: ["finding:resolved"],
          affected_item_ids: [item.item_id],
          affected_evidence_ids: [...item.evidence_ids],
        };
      });
      const sealReceipt = JSON.parse(await readFile(workspace.sealReceiptPath, "utf8")) as Record<string, unknown>;
      sealReceipt.coverage_review_fingerprint = sha256Json(review);
      const sealReceiptContent = prettyJson(sealReceipt);
      await chmod(workspace.sealReceiptPath, 0o644);
      await writeFile(workspace.sealReceiptPath, sealReceiptContent, "utf8");
      const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as {
        fingerprints: { coverage_review: string; files: Record<string, string> };
      };
      manifest.fingerprints.coverage_review = sha256Json(review);
      manifest.fingerprints.files["seal-receipt.json"] = sha256Text(sealReceiptContent);
      await chmod(workspace.manifestPath, 0o644);
      await writeFile(workspace.manifestPath, prettyJson(manifest), "utf8");
      const staleResult = JSON.parse(await readFile(workspace.resultPath, "utf8")) as Record<string, unknown>;
      staleResult.plan_fingerprint = "a".repeat(64);
      await chmod(workspace.resultPath, 0o644);
      await writeFile(workspace.resultPath, prettyJson(staleResult), "utf8");

      const brokenChainWorkspace = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[1]!,
      );
      const brokenChainState = await brokenChainWorkspace.readState();
      const brokenChainReviewPath = join(
        brokenChainWorkspace.coverageReviewDirectory,
        brokenChainState.last_valid_fingerprint,
        "coverage-review.json",
      );
      const brokenChainReview = JSON.parse(
        await readFile(brokenChainReviewPath, "utf8"),
      ) as { summary: string };
      brokenChainReview.summary = "Tampered after sealing without updating the manifest/receipt hash chain.";
      await chmod(brokenChainReviewPath, 0o644);
      await writeFile(brokenChainReviewPath, prettyJson(brokenChainReview), "utf8");
      const brokenChainResult = JSON.parse(
        await readFile(brokenChainWorkspace.resultPath, "utf8"),
      ) as Record<string, unknown>;
      brokenChainResult.plan_fingerprint = "b".repeat(64);
      await chmod(brokenChainWorkspace.resultPath, 0o644);
      await writeFile(brokenChainWorkspace.resultPath, prettyJson(brokenChainResult), "utf8");

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const target = batch.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
      target.status = "running";
      target.error = "stale deterministic result";
      const brokenChainTarget = batch.targets.find((candidate) => candidate.target_id === TARGET_IDS[1])!;
      brokenChainTarget.status = "running";
      brokenChainTarget.error = "tampered coverage review hash chain";
      await writeFile(batchPath, prettyJson(batch), "utf8");

      const resumed = await runFullBatch(options);
      expect(resumed.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])).toMatchObject({
        status: "sealed",
        revision: 2,
        error: "",
      });
      const rematerialized = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      const rematerializedState = await rematerialized.readState();
      expect(rematerializedState.coverage_recheck).toMatchObject({
        plan_fingerprint: rematerializedState.last_valid_fingerprint,
        affected_item_ids: [item.item_id],
      });
      expect(rematerializedState.agent_runtime.kind).toBe("unassigned");
      expect(await readFile(join(
        rematerialized.coverageReviewDirectory,
        rematerializedState.last_valid_fingerprint,
        "materialized-result.sha256",
      ), "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
      expect(resumed.targets.find((candidate) => candidate.target_id === TARGET_IDS[1])).toMatchObject({
        status: "sealed",
        revision: 2,
        error: "",
      });
      const brokenChainRerun = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[1]!);
      expect((await brokenChainRerun.readState()).agent_runtime.kind).toBe("offline-scripted");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("does not carry an approved label when the current strict coverage validator rejects the sealed review", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-rematerialize-invalid-review-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "rematerialize-invalid-review-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 3,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      expect((await runFullBatch(options)).status).toBe("passed");

      const workspace = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      const state = await workspace.readState();
      const reviewPath = join(
        workspace.coverageReviewDirectory,
        state.last_valid_fingerprint,
        "coverage-review.json",
      );
      const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
        status: string;
        semantic_coverage: Array<{ disposition: string }>;
      };
      review.semantic_coverage = review.semantic_coverage.filter((row) => row.disposition !== "acceptance_item");
      const reviewContent = prettyJson(review);
      await chmod(reviewPath, 0o644);
      await writeFile(reviewPath, reviewContent, "utf8");
      const sealReceipt = JSON.parse(await readFile(workspace.sealReceiptPath, "utf8")) as Record<string, unknown>;
      sealReceipt.coverage_review_fingerprint = sha256Json(review);
      const sealReceiptContent = prettyJson(sealReceipt);
      await chmod(workspace.sealReceiptPath, 0o644);
      await writeFile(workspace.sealReceiptPath, sealReceiptContent, "utf8");
      const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as {
        fingerprints: { coverage_review: string; files: Record<string, string> };
      };
      manifest.fingerprints.coverage_review = sha256Json(review);
      manifest.fingerprints.files["seal-receipt.json"] = sha256Text(sealReceiptContent);
      await chmod(workspace.manifestPath, 0o644);
      await writeFile(workspace.manifestPath, prettyJson(manifest), "utf8");
      const staleResult = JSON.parse(await readFile(workspace.resultPath, "utf8")) as Record<string, unknown>;
      staleResult.plan_fingerprint = "a".repeat(64);
      await chmod(workspace.resultPath, 0o644);
      await writeFile(workspace.resultPath, prettyJson(staleResult), "utf8");

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const target = batch.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])!;
      target.status = "running";
      target.error = "stale deterministic result";
      await writeFile(batchPath, prettyJson(batch), "utf8");

      const resumed = await runFullBatch(options);
      expect(resumed.targets.find((candidate) => candidate.target_id === TARGET_IDS[0])).toMatchObject({
        status: "sealed",
        revision: 2,
        error: "",
      });
      const rerun = await RevisionWorkspace.openLatest(artifactRoot, jobId, TARGET_IDS[0]!);
      expect((await rerun.readState()).agent_runtime.kind).toBe("offline-scripted");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  test("finishes only proven interrupted deterministic rematerializations without starting an Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-interrupted-rematerialization-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "interrupted-rematerialization-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = {
        artifactRoot,
        jobId,
        markdownPath,
        concurrency: 3,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      const first = await runFullBatch(options);
      expect(first.status).toBe("passed");

      const legacy = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      await writeFile(legacy.workingSelectorPath, prettyJson({
        schema_version: "target-selector-plan/v6",
        job_id: jobId,
        target_id: TARGET_IDS[0],
        lots: [],
        items: [],
        sampling_rules: [],
        references: [],
        source_dispositions: [],
      }), "utf8");
      await writeFile(legacy.transcriptPath, "", "utf8");
      await legacy.updateState((state) => {
        delete state.lineage;
        state.next_event_sequence = 1;
      });
      const legacyController = await ToolController.create(legacy);
      for (const evidence of legacyController.evidence.evidence) {
        await legacyController.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
      }
      expect((await legacyController.dispatch("validate_working_plan", {})).ok).toBe(true);

      const explicitSource = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[1]!,
      );
      const explicitSourceState = await explicitSource.readState();
      const explicitSourceManifest = JSON.parse(
        await readFile(explicitSource.manifestPath, "utf8"),
      ) as { fingerprints: { coverage_review: string } };
      const explicit = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[1]!,
      );
      await writeFile(join(explicit.root, "deterministic-rematerialization.json"), prettyJson({
        schema_version: "deterministic-rematerialization-lineage/v1",
        source_revision: explicitSource.revision,
        source_plan_fingerprint: explicitSourceState.last_valid_fingerprint,
        source_coverage_review_fingerprint: explicitSourceManifest.fingerprints.coverage_review,
        evidence_fingerprint: (await explicitSource.readEvidenceManifest()).evidence_fingerprint,
      }), "utf8");

      const ordinary = await RevisionWorkspace.reviseFromSealed(
        artifactRoot,
        jobId,
        TARGET_IDS[2]!,
      );
      const ordinaryController = await ToolController.create(ordinary);
      for (const evidence of ordinaryController.evidence.evidence) {
        await ordinaryController.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
      }
      expect((await ordinaryController.dispatch("validate_working_plan", {})).ok).toBe(true);
      await ordinary.updateState((state) => {
        state.agent_runtime = {
          kind: "offline-scripted",
          session_id: "ordinary-validated-session",
          session_file: ordinary.transcriptPath,
        };
      });

      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      for (const target of batch.targets) {
        target.status = "running";
        target.error = "interrupted before deterministic rematerialization seal";
      }
      await writeFile(batchPath, prettyJson(batch), "utf8");

      const resumed = await runFullBatch(options);
      expect(resumed.status).toBe("failed");
      const recoveredLegacy = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[0]!,
      );
      const recoveredExplicit = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[1]!,
      );
      const rerunOrdinary = await RevisionWorkspace.openLatest(
        artifactRoot,
        jobId,
        TARGET_IDS[2]!,
      );
      expect(recoveredLegacy.revision).toBe(2);
      expect(recoveredExplicit.revision).toBe(2);
      expect(rerunOrdinary.revision).toBe(2);
      expect(resumed.targets.find((target) => target.target_id === TARGET_IDS[0])).toMatchObject({
        status: "sealed",
        revision: 2,
      });
      expect(resumed.targets.find((target) => target.target_id === TARGET_IDS[1])).toMatchObject({
        status: "sealed",
        revision: 2,
      });
      expect(resumed.targets.find((target) => target.target_id === TARGET_IDS[2])).toMatchObject({
        status: "failed",
        revision: 2,
      });
      expect((await recoveredLegacy.readState()).agent_runtime.kind).toBe("unassigned");
      expect((await recoveredExplicit.readState()).agent_runtime.kind).toBe("unassigned");
      expect((await rerunOrdinary.readState()).agent_runtime.kind).toBe("offline-scripted");
      expect(JSON.parse(await readFile(
        join(recoveredLegacy.root, "deterministic-rematerialization.json"),
        "utf8",
      ))).toMatchObject({
        schema_version: "deterministic-rematerialization-lineage/v1",
        source_revision: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 45_000);

  test("rejects target concurrency above fifty", async () => {
    await expect(runFullBatch({
      artifactRoot: "unused",
      jobId: "unused",
      markdownPath: "unused",
      concurrency: 51,
      maxAttempts: 1,
      live: false,
    })).rejects.toThrow("Full-run concurrency must be an integer between 1 and 50");
  });

  test("targeted resume reseals only the selected failed target and preserves the others' scenes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-targeted-resume-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const jobId = "targeted-resume-job";
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan(jobId, markdown)), "utf8");
      const options: FullBatchOptions = { artifactRoot, jobId, markdownPath,
        concurrency: 1, maxAttempts: 3, live: false, discoveryPlanPath };
      expect((await runFullBatch(options)).status).toBe("passed");

      // 模拟整批失败后仅个别目标有修复依据的现场：两个目标标 failed（各自带
      // 失败理由与修订号），第三个保持封存。批次文件编辑是既有测试夹具惯用手段。
      const batchPath = join(artifactRoot, "jobs", jobId, "batch.json");
      const batch = JSON.parse(await readFile(batchPath, "utf8")) as FullBatchState;
      const selected = batch.targets.find(t => t.target_id === TARGET_IDS[0])!;
      const unselected = batch.targets.find(t => t.target_id === TARGET_IDS[1])!;
      selected.status = "failed";
      selected.error = "metal-style failure with a new verified fix";
      selected.revision = 2;
      unselected.status = "failed";
      unselected.error = "glass-style failure without a new recovery basis";
      unselected.revision = 7;
      await writeFile(batchPath, prettyJson(batch), "utf8");

      // 与 workspace.encodedSegment 同构：encodeURIComponent 后把 % 替换为 _。
      const targetRootOf = (targetId: string): string =>
        join(artifactRoot, "jobs", jobId, "targets",
          encodeURIComponent(targetId).replaceAll("%", "_"));
      const unselectedDir = targetRootOf(TARGET_IDS[1]);
      const beforeUnselectedTree = await fileTreeSnapshot(unselectedDir);
      const sealedDir = targetRootOf(TARGET_IDS[2]);
      const beforeSealedTree = await fileTreeSnapshot(sealedDir);

      const resumed = await runFullBatch({ ...options, targetIds: [TARGET_IDS[0]], sourcePdfDisplayName: "GB50203-2011.pdf" });
      expect(resumed.source).toEqual(batch.source);
      // 未选中的失败目标仍在，整批保持 failed（待复核）；但这不妨碍选中目标完成恢复。
      expect(resumed.status).toBe("failed");
      // 选中的目标恢复并封存。
      expect(resumed.targets.find(t => t.target_id === TARGET_IDS[0])!).toMatchObject({
        status: "sealed", error: "",
      });
      // 未选中的失败目标：状态、失败理由、修订号与磁盘现场全部保持原样。
      expect(resumed.targets.find(t => t.target_id === TARGET_IDS[1])!).toMatchObject({
        status: "failed", error: "glass-style failure without a new recovery basis", revision: 7,
      });
      expect(await fileTreeSnapshot(unselectedDir)).toEqual(beforeUnselectedTree);
      // 未选中的封存目标同样不动。
      expect(resumed.targets.find(t => t.target_id === TARGET_IDS[2])!).toMatchObject({
        status: "sealed",
      });
      expect(await fileTreeSnapshot(sealedDir)).toEqual(beforeSealedTree);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 45_000);

  test("does not convert an operator pause into a target failure or budget attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-pause-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(discoveryPlanPath, prettyJson(discoveryPlan("pause-job", markdown)), "utf8");
      const abort = new AbortController();
      const options: FullBatchOptions = {
        artifactRoot,
        jobId: "pause-job",
        markdownPath,
        concurrency: 1,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
        signal: abort.signal,
        onStateChange: (state) => {
          if (!state.targets.some((target) => target.status === "running")) return;
          abort.abort(new DOMException("operator pause", "AbortError"));
          throw abort.signal.reason;
        },
      };

      await expect(runFullBatch(options)).rejects.toThrow(/operator pause/);
      const persisted = JSON.parse(await readFile(
        join(artifactRoot, "jobs", "pause-job", "batch.json"),
        "utf8",
      )) as FullBatchState;
      expect(persisted.targets[0]).toMatchObject({
        status: "running",
        error: "",
        attempt_counters: {
          transport_attempts: 0,
          candidate_validation_attempts: 0,
          coverage_repair_attempts: 0,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("retires old target artifacts and starts a clean inventory after independent review", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-batch-inventory-review-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const markdownPath = join(root, "source.md");
      const discoveryPlanPath = join(root, "discovery-plan.json");
      const markdown = "地基承载力应满足设计要求。".repeat(40);
      await writeFile(markdownPath, markdown, "utf8");
      await writeFile(
        discoveryPlanPath,
        prettyJson(discoveryPlan("reviewed-job", markdown)),
        "utf8",
      );
      const options: FullBatchOptions = {
        artifactRoot,
        jobId: "reviewed-job",
        markdownPath,
        concurrency: 3,
        maxAttempts: 1,
        live: false,
        discoveryPlanPath,
      };
      const first = await runFullBatch(options);
      expect(first.targets.map((target) => target.target_id)).toEqual([...TARGET_IDS]);

      const discoveryWorkspace = await DocumentDiscoveryWorkspace.openOrCreate(
        artifactRoot,
        options.jobId,
        markdownPath,
      );
      await discoveryWorkspace.reopenForIndependentReview(
        "The independent reviewer merged two scopes and reclassified one surviving target",
      );
      const reviewer = await DocumentDiscoveryController.create(discoveryWorkspace, "review");
      for (const atom of reviewer.evidence.atoms) {
        await reviewer.dispatch("open_document_atom", { atom_id: atom.atom_id });
      }
      const revised = discoveryPlan(options.jobId, markdown);
      const surviving = {
        ...revised.targets[0]!,
        description: "复核后重新界定证据范围的地基承载力验收项目",
        reason: "独立复核后保留并重新分类",
      };
      const merged = {
        ...revised.targets[1]!,
        target_id: "target-merged",
        name: "merged-foundation-scope",
        description: "由原两个验收范围合并形成的新目标",
        reason: "独立复核合并形成",
      };
      revised.targets = [surviving, merged];
      revised.dispositions[0]!.target_ids = [surviving.target_id, merged.target_id];
      const replacement = await reviewer.dispatch("patch_discovery_plan", {
        operations: [
          { op: "replace", path: "/targets/0", value: surviving },
          { op: "replace", path: "/targets/1", value: merged },
          { op: "remove", path: "/targets/2" },
          {
            op: "replace",
            path: "/dispositions/0/target_ids",
            value: [surviving.target_id, merged.target_id],
          },
        ],
      });
      expect(replacement, JSON.stringify(replacement)).toMatchObject({ ok: true });
      const reviewed = await reviewer.dispatch("validate_discovery_plan", {});
      expect(reviewed).toMatchObject({ ok: true });
      expect(await reviewer.dispatch("seal_discovery_plan", {
        fingerprint: reviewed.fingerprint,
      })).toMatchObject({ ok: true, target_count: 2 });

      const targetsRoot = join(artifactRoot, "jobs", options.jobId, "targets");
      const targetsBeforePartialRun = await fileTreeSnapshot(targetsRoot);
      await expect(runFullBatch({
        ...options,
        targetIds: [TARGET_IDS[0]],
      })).rejects.toThrow(/partial or fresh-target run cannot archive/);
      expect(await fileTreeSnapshot(targetsRoot)).toEqual(targetsBeforePartialRun);
      expect(JSON.parse(await readFile(
        join(artifactRoot, "jobs", options.jobId, "batch.json"),
        "utf8",
      ))).toEqual(first);

      const second = await runFullBatch(options);
      expect(second).toMatchObject({
        schema_version: "acceptance-full-batch/v3",
        status: "passed",
        inventory_revision: 2,
      });
      expect(second.targets.map((target) => target.target_id)).toEqual([
        "target-valid",
        "target-merged",
      ]);
      expect(second.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ target_id: "target-valid", revision: 1, attempts: 1 }),
        expect.objectContaining({ target_id: "target-merged", revision: 1, attempts: 1 }),
      ]));

      const archive = second.previous_inventory_archive!;
      const transition = JSON.parse(
        await readFile(join(archive, "inventory-transition.json"), "utf8"),
      );
      expect(transition).toMatchObject({
        previous_inventory_revision: 1,
        next_inventory_revision: 2,
        retired_target_ids: ["target-revise-a", "target-revise-b"],
        superseded_target_ids: ["target-valid"],
        added_target_ids: ["target-merged"],
      });
      const currentResult = JSON.parse(
        await readFile(join(artifactRoot, "jobs", options.jobId, "result.json"), "utf8"),
      );
      expect(currentResult.targets.map((target: { target_id: string }) => target.target_id)).toEqual([
        "target-valid",
        "target-merged",
      ]);
      expect(JSON.parse(await readFile(join(archive, "batch.json"), "utf8"))).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
