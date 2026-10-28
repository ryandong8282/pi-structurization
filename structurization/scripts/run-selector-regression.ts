import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalize, sha256Json } from "../src/canonical.js";
import {
  buildAgentScopedEvidenceManifest,
  migrateDocumentTargetPlan,
  type DocumentEvidence,
  type DocumentTarget,
  type DocumentTargetPlan,
} from "../src/document-discovery.js";
import { runBoundedFailFast } from "../src/fail-fast-pool.js";
import { computeImplementationFingerprints } from "../src/implementation-fingerprint.js";
import { runLiveCoverageReview, runLivePi } from "../src/pi-runtime.js";
import { transcriptMetrics, type TranscriptMetrics } from "../src/run-metrics.js";
import { compileTargetSelectors } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

interface RegressionCase {
  standard: "GB50209" | "GB50202";
  targetId: string;
}

interface RegressionResult {
  standard: string;
  target_id: string;
  target_name: string;
  status: "sealed" | "failed" | "cancelled";
  workdir: string;
  source_fingerprint: string;
  build_fingerprint: string;
  model: string;
  coverage_reviews: number;
  coverage_repairs: number;
  transport_retries: number;
  selector_submissions: number;
  selector_corrections: number;
  selector_transport_failures: number;
  selector_protocol_failures: number;
  final_validation_attempts: number;
  metrics: TranscriptMetrics & { transcript_bytes: number };
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  performance_under_5m: boolean;
  compiler_replay_identical: boolean;
  direct_compiled_plan_mutation: boolean;
  error: string;
}

const ROOT = resolve(import.meta.dirname, "../../..");
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const RUN_ID = `selector-regression-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const RUN_ROOT = join(ROOT, "data", "selector-regression", RUN_ID);
const ARTIFACT_ROOT = join(RUN_ROOT, "artifacts");

const SOURCES = {
  GB50209: {
    markdown: join(ROOT, "data", "jobs", "20260810-090307-6b03", "output", "01_GB_50209-2010_建筑地面工程施工质量验收规范.md"),
    discoveryPlan: join(ROOT, "data", "jobs", "20260810-090307-6b03", "pi-agent", "jobs", "20260810-090307-6b03", "discovery", "document-target-plan.json"),
    documentEvidence: join(ROOT, "data", "jobs", "20260810-090307-6b03", "pi-agent", "jobs", "20260810-090307-6b03", "discovery", "document-evidence.json"),
  },
  GB50202: {
    markdown: join(ROOT, "data", "jobs", "20260810-090307-b700", "output", "GB_50202-2018.md"),
    discoveryPlan: join(ROOT, "data", "jobs", "20260810-090307-b700", "pi-agent", "jobs", "20260810-090307-b700", "discovery", "document-target-plan.json"),
    documentEvidence: join(ROOT, "data", "jobs", "20260810-090307-b700", "pi-agent", "jobs", "20260810-090307-b700", "discovery", "document-evidence.json"),
  },
} as const;

const CASES: RegressionCase[] = [
  { standard: "GB50209", targetId: "t-灰土垫层" },
  { standard: "GB50209", targetId: "t-硬化耐磨面层" },
  { standard: "GB50209", targetId: "t-地毯面层" },
  { standard: "GB50209", targetId: "t-三合土四合土垫层" },
  { standard: "GB50202", targetId: "t-f-5-5" },
  { standard: "GB50202", targetId: "t-sup-7-2" },
];

function selectedCases(): RegressionCase[] {
  const requested = new Set((process.env.SELECTOR_REGRESSION_TARGETS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  return requested.size === 0 ? CASES : CASES.filter((testCase) => requested.has(testCase.targetId));
}

async function loadTarget(testCase: RegressionCase): Promise<{ target: DocumentTarget; evidence: DocumentEvidence }> {
  const source = SOURCES[testCase.standard];
  const evidence = JSON.parse(await readFile(source.documentEvidence, "utf8")) as DocumentEvidence;
  const raw = JSON.parse(await readFile(source.discoveryPlan, "utf8")) as unknown;
  const plan = migrateDocumentTargetPlan(raw, evidence) as DocumentTargetPlan;
  const target = plan.targets.find((candidate) => candidate.target_id === testCase.targetId);
  if (!target) throw new Error(`Target ${testCase.targetId} is absent from cached discovery plan`);
  return { target, evidence };
}

async function replayCompiler(workspace: RevisionWorkspace): Promise<boolean> {
  const [selectorsText, sealedText, registry, evidence] = await Promise.all([
    readFile(workspace.sealedSelectorPath, "utf8"),
    readFile(workspace.sealedPlanPath, "utf8"),
    workspace.readSourceSpanRegistry(),
    workspace.readEvidenceManifest(),
  ]);
  const selectors = JSON.parse(selectorsText) as Parameters<typeof compileTargetSelectors>[0];
  const first = compileTargetSelectors(selectors, registry, evidence);
  const second = compileTargetSelectors(selectors, registry, evidence);
  return canonicalize(first) === canonicalize(second) && sha256Json(first) === sha256Json(JSON.parse(sealedText));
}

function isTransportFailure(error: unknown): boolean {
  return /ETIMEDOUT|ECONNRESET|fetch failed|broken model stream/iu.test(error instanceof Error ? error.message : String(error));
}

async function runCase(
  testCase: RegressionCase,
  signal: AbortSignal,
  fingerprints: Awaited<ReturnType<typeof computeImplementationFingerprints>>,
): Promise<RegressionResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let targetName = testCase.targetId;
  let workspace: RevisionWorkspace | undefined;
  let model = "";
  let coverageReviews = 0;
  let coverageRepairs = 0;
  let transportRetries = 0;
  let error = "";
  let sealed = false;
  let cancelled = false;
  let result!: RegressionResult;

  try {
    signal.throwIfAborted();
    const { target, evidence } = await loadTarget(testCase);
    targetName = target.name;
    const source = SOURCES[testCase.standard];
    const jobId = `${RUN_ID}-${testCase.standard.toLowerCase()}`;
    const prepared = await buildAgentScopedEvidenceManifest(source.markdown, jobId, target, evidence);
    workspace = await RevisionWorkspace.createFromEvidence(ARTIFACT_ROOT, jobId, target.target_id, prepared);
    await workspace.updateState((state) => {
      state.source_fingerprint = fingerprints.source_fingerprint;
      state.build_fingerprint = fingerprints.build_fingerprint;
    });
    const controller = await ToolController.create(workspace);
    console.log(`[selector-regression] START ${testCase.standard} ${target.target_id} ${target.name}`);

    const runCandidate = async (recovery = false) => runLivePi(workspace!, controller, false, signal, recovery, false);
    let candidate;
    try {
      candidate = await runCandidate(false);
    } catch (caught) {
      if (!isTransportFailure(caught)) throw caught;
      transportRetries = 1;
      candidate = await runCandidate(true);
    }
    if (!candidate.sealed && isTransportFailure(candidate.error ?? "") && transportRetries === 0) {
      transportRetries = 1;
      candidate = await runCandidate(true);
    }
    model = candidate.model;
    for (;;) {
      signal.throwIfAborted();
      if (candidate.sealed) { sealed = true; break; }
      if (!candidate.review_required || !candidate.review_plan_fingerprint) {
        error = candidate.error ?? "candidate stopped without validation or coverage handoff";
        break;
      }
      coverageReviews += 1;
      const review = await runLiveCoverageReview(workspace, candidate.review_plan_fingerprint, signal);
      model = `${model} + coverage-review:${review.model}`;
      if (!review.sealed || !review.review) {
        error = review.error ?? "coverage reviewer stopped without a sealed review";
        break;
      }
      if (review.review.status === "approved") {
        const seal = await controller.dispatch("seal_validated_plan", { fingerprint: candidate.review_plan_fingerprint });
        sealed = seal.ok === true;
        error = sealed ? "" : JSON.stringify(seal);
        break;
      }
      if (review.review.status === "harness_defect") {
        error = `coverage harness defect: ${review.review.summary}; findings=${JSON.stringify(review.review.findings)}`;
        break;
      }
      if (coverageRepairs >= 1) {
        error = `coverage finding remained after the only repair round: ${review.review.summary}`;
        break;
      }
      coverageRepairs += 1;
      await controller.beginCoverageRepair(candidate.review_plan_fingerprint);
      candidate = await runLivePi(workspace, controller, false, signal, false, true);
      model = `${model} + repair:${candidate.model}`;
    }
  } catch (caught) {
    cancelled = signal.aborted || (caught instanceof Error && caught.name === "AbortError");
    error = cancelled ? "cancelled_after_same_run_hard_gate_failure" : caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    if (workspace && !sealed) {
      const state = await workspace.readState();
      if (state.status === "working") await workspace.markTerminal(cancelled ? "cancelled" : "failed", error || "target_did_not_seal");
    }
    const state = workspace ? await workspace.readState() : undefined;
    const transcript = workspace ? await readFile(workspace.transcriptPath, "utf8").catch(() => "") : "";
    const metrics = transcriptMetrics(transcript);
    const directCompiledPlanMutation = /"toolName":"(?:replace|patch)_working_plan"/u.test(transcript)
      || /"tool_name":"(?:replace|patch)_working_plan"/u.test(transcript);
    const compilerReplayIdentical = sealed && workspace ? await replayCompiler(workspace).catch(() => false) : false;
    const elapsedMs = Date.now() - started;
    result = {
      standard: testCase.standard,
      target_id: testCase.targetId,
      target_name: targetName,
      status: sealed ? "sealed" : cancelled ? "cancelled" : "failed",
      workdir: workspace?.root ?? "",
      ...fingerprints,
      model,
      coverage_reviews: coverageReviews,
      coverage_repairs: coverageRepairs,
      transport_retries: transportRetries,
      selector_submissions: state?.selector_protocol?.submissions ?? 0,
      selector_corrections: state?.selector_protocol?.corrections ?? 0,
      selector_transport_failures: state?.selector_protocol?.transport_failures ?? 0,
      selector_protocol_failures: state?.selector_protocol?.protocol_failures ?? 0,
      final_validation_attempts: state?.validation_attempts ?? 0,
      metrics: { ...metrics, transcript_bytes: Buffer.byteLength(transcript, "utf8") },
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      elapsed_ms: elapsedMs,
      performance_under_5m: sealed && elapsedMs <= 300_000,
      compiler_replay_identical: compilerReplayIdentical,
      direct_compiled_plan_mutation: directCompiledPlanMutation,
      error,
    };
    await mkdir(RUN_ROOT, { recursive: true });
    await writeFile(join(RUN_ROOT, `${testCase.standard}-${encodeURIComponent(testCase.targetId)}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`[selector-regression] ${result.status.toUpperCase()} ${testCase.standard} ${testCase.targetId} validations=${result.final_validation_attempts} tools=${result.metrics.tool_call_count}`);
  }
  return result;
}

function cancelledResult(testCase: RegressionCase, fingerprints: Awaited<ReturnType<typeof computeImplementationFingerprints>>): RegressionResult {
  const now = new Date().toISOString();
  return {
    standard: testCase.standard,
    target_id: testCase.targetId,
    target_name: testCase.targetId,
    status: "cancelled",
    workdir: "",
    ...fingerprints,
    model: "",
    coverage_reviews: 0,
    coverage_repairs: 0,
    transport_retries: 0,
    selector_submissions: 0,
    selector_corrections: 0,
    selector_transport_failures: 0,
    selector_protocol_failures: 0,
    final_validation_attempts: 0,
    metrics: { ...transcriptMetrics(""), transcript_bytes: 0 },
    started_at: now,
    completed_at: now,
    elapsed_ms: 0,
    performance_under_5m: false,
    compiler_replay_identical: false,
    direct_compiled_plan_mutation: false,
    error: "cancelled_before_start_after_same_run_hard_gate_failure",
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  await mkdir(RUN_ROOT, { recursive: true });
  const fingerprints = await computeImplementationFingerprints(PACKAGE_ROOT);
  const cases = selectedCases();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("selector regression stop requested"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let results: RegressionResult[] = [];
  let topLevelError = "";
  try {
    if (cases.length === 0) throw new Error("SELECTOR_REGRESSION_TARGETS did not match a configured case");
    await writeFile(join(RUN_ROOT, "run.json"), `${JSON.stringify({ schema_version: "target-selector-regression-run/v2", run_id: RUN_ID, started_at: startedAt, concurrency: Number(process.env.SELECTOR_REGRESSION_CONCURRENCY ?? cases.length), continue_on_failure: process.env.SELECTOR_REGRESSION_CONTINUE_ON_FAILURE === "1", ...fingerprints }, null, 2)}\n`, "utf8");
    const pool = await runBoundedFailFast({
      inputs: cases,
      concurrency: Number(process.env.SELECTOR_REGRESSION_CONCURRENCY ?? cases.length),
      failFast: process.env.SELECTOR_REGRESSION_CONTINUE_ON_FAILURE !== "1",
      signal: controller.signal,
      worker: (testCase, signal) => runCase(testCase, signal, fingerprints),
      isHardFailure: (result) => result.status !== "sealed",
    });
    results = pool.map((entry, index) => entry.value ?? cancelledResult(cases[index]!, fingerprints));
  } catch (caught) {
    topLevelError = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    results = cases.map((testCase) => cancelledResult(testCase, fingerprints));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    const summary = {
      schema_version: "target-selector-regression/v2",
      run_id: RUN_ID,
      run_root: RUN_ROOT,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ...fingerprints,
      performance_gate_passed: results.length === cases.length && results.every((result) => result.performance_under_5m),
      hard_gate_passed: !topLevelError && results.length === cases.length && results.every((result) =>
        result.status === "sealed"
        && result.selector_submissions === 1
        && result.selector_corrections <= 1
        && result.final_validation_attempts <= 3
        && result.coverage_repairs <= 1
        && result.compiler_replay_identical
        && !result.direct_compiled_plan_mutation
      ),
      error: topLevelError,
      results,
    };
    await writeFile(join(RUN_ROOT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`[selector-regression] SUMMARY ${JSON.stringify({ run_root: RUN_ROOT, hard_gate_passed: summary.hard_gate_passed })}`);
    if (!summary.hard_gate_passed) process.exitCode = 1;
  }
}

await main();
