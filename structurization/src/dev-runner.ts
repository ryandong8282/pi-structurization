import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFullBatch, type FullBatchOptions, type FullBatchState } from "./batch.js";
import { runEditorHierarchy } from "./editor-hierarchy-runner.js";
import { computeImplementationFingerprints } from "./implementation-fingerprint.js";
import { sha256Bytes } from "./canonical.js";
import { copyDevDiscovery, devJobDirectory, physicalPath, within } from "./dev-checkpoint.js";
import { loadDevModelConfig, redactDevMessage } from "./dev-config.js";
import type { PiAgentRuntimeModelConfig } from "./presets.js";

export const DEV_HELP = `Source-based acceptance development runner (no OCR or publication)
  npm run dev:acceptance -- full --markdown input.md [--pdf input.pdf] --out data/runs/run-1 --job job-1
  npm run dev:acceptance -- targets --from data/runs/run-1 --markdown input.md [--pdf input.pdf] --out data/runs/retry-1 --job job-1 --target TARGET_ID [--target TARGET_ID]
Options: --config runtime.json, --concurrency 1 (1..50), --attempts 3 (1..20)
Output must not exist. targets preserves job/source identity, copies only sealed discovery,
and creates new target evidence and sessions. It does not resume target checkpoints.
Ctrl+C/SIGTERM cancels. summaries distinguish selected-target success from full completion.
Model settings: STRUCTURIZATION_{API_TYPE,ENDPOINT,API_KEY,MODEL,EFFORT,AUTH_MODE},
optional STRUCTURIZATION_<STAGE>_<SETTING> overrides; see README.md.
`;

export interface DevArguments {
  command: "full" | "targets";
  markdown: string;
  pdf?: string;
  out: string;
  job: string;
  from?: string;
  config?: string;
  targets: string[];
  concurrency: number;
  attempts: number;
}

export function parseDevArguments(argv: string[]): DevArguments | undefined {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return undefined;
  const command = argv[0];
  if (command !== "full" && command !== "targets") throw new Error("Expected full or targets; use --help");
  const values = new Map<string, string>();
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--markdown", "--pdf", "--out", "--job", "--from", "--config", "--target", "--concurrency", "--attempts"].includes(key)) throw new Error("Unknown CLI option; use --help");
    if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (key === "--target") targets.push(value);
    else {
      if (values.has(key)) throw new Error(`Duplicate option ${key}`);
      values.set(key, value);
    }
  }
  for (const key of ["--markdown", "--out", "--job"]) if (!values.has(key)) throw new Error(`Required: ${key}`);
  const job = values.get("--job")!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(job)) throw new Error("Job must be 1..128 ASCII letters/digits/._-, beginning with a letter/digit");
  const concurrency = Number(values.get("--concurrency") ?? "1"), attempts = Number(values.get("--attempts") ?? "3");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error("concurrency must be 1..50");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error("attempts must be 1..20");
  if (command === "targets" && (!values.has("--from") || !targets.length)) throw new Error("targets requires --from and at least one --target");
  if (command === "full" && (values.has("--from") || targets.length)) throw new Error("--from/--target only apply to targets");
  const pdf = values.get("--pdf"), from = values.get("--from"), config = values.get("--config");
  return { command, markdown: resolve(values.get("--markdown")!), out: resolve(values.get("--out")!), job, targets: [...new Set(targets)], concurrency, attempts,
    ...(pdf ? { pdf: resolve(pdf) } : {}), ...(from ? { from: resolve(from) } : {}), ...(config ? { config: resolve(config) } : {}) };
}

export interface DevDependencies {
  batch: typeof runFullBatch;
  hierarchy: typeof runEditorHierarchy;
  fingerprint: typeof computeImplementationFingerprints;
}
const production: DevDependencies = { batch: runFullBatch, hierarchy: runEditorHierarchy, fingerprint: computeImplementationFingerprints };

async function artifactPaths(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await artifactPaths(path));
    else if (entry.isFile() && (/^(?:session\.events\.jsonl|state\.json|batch\.json|result\.json|receipt\.json|manifest\.json|seal-receipt\.json)$/u.test(entry.name) || /selector|plan|session.*\.jsonl/u.test(entry.name))) files.push(path);
  }
  return files.sort();
}

/** Injectable production calls keep orchestration tests entirely offline. */
export async function runDevAcceptance(args: DevArguments, options: {
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; log?: (message: string) => void; dependencies?: DevDependencies;
} = {}): Promise<number> {
  const env = options.env ?? process.env, log = options.log ?? console.log, deps = options.dependencies ?? production;
  const started = Date.now();
  const targetTiming = new Map<string, { started_at: string; duration_ms: number; started_ms: number; finished: boolean }>();
  let config: PiAgentRuntimeModelConfig | undefined, claimed = false, batch: FullBatchState | undefined;
  let phase = "preflight", outcome = "failed", errorMessage = "", exitCode = 1, documentComplete = false;
  const summary: Record<string, unknown> = { schema_version: "acceptance-dev-run/v1", scope: args.command === "full" ? "document" : "selected_targets", job_id: args.job,
    started_at: new Date(started).toISOString(), output_root: args.out, parameters: { concurrency: args.concurrency, max_attempts: args.attempts, target_ids: args.targets, live: true },
    interpretation: "Contract validation and sealing do not prove semantic correctness or completeness. This is a development run, not a published product." };
  const say = (text: string) => log(redactDevMessage(text, config));
  let monitor: ReturnType<typeof setInterval> | undefined;
  let observing = false;
  try {
    options.signal?.throwIfAborted();
    const out = await physicalPath(args.out);
    const inputRecords = [];
    for (const [kind, inputPath] of [["markdown", args.markdown], ["pdf", args.pdf]] as const) {
      if (!inputPath) continue;
      const actual = await realpath(inputPath);
      if (within(out, actual)) throw new Error("Input must be outside the new output directory");
      const bytes = await readFile(actual);
      if (!bytes.length) throw new Error(`Empty ${kind} input`);
      if (kind === "pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF input must be a PDF file");
      inputRecords.push({ kind, path: actual, sha256: sha256Bytes(bytes), bytes: bytes.length });
    }
    summary.inputs = inputRecords;
    if (args.from) {
      const from = await realpath(args.from);
      if (within(from, out) || within(out, from)) throw new Error("Output and checkpoint roots must be disjoint");
      summary.discovery_origin = from;
    }
    // Atomic claim; existing directories are never reused, even if empty.
    await mkdir(dirname(args.out), { recursive: true });
    await mkdir(args.out);
    claimed = true;
    summary.implementation = await deps.fingerprint(fileURLToPath(new URL("..", import.meta.url)));
    summary.runtime = { node: process.version, entry: "local src/dev-runner.ts" };
    config = await loadDevModelConfig(args.config ?? env.STRUCTURIZATION_CONFIG, env);
    const inputDir = join(args.out, "inputs");
    await mkdir(inputDir);
    // Keep basenames: they are part of document evidence identity.
    const markdown = join(inputDir, "markdown", basename(args.markdown));
    await mkdir(dirname(markdown));
    await writeFile(markdown, await readFile(args.markdown), { flag: "wx" });
    let pdf: string | undefined;
    if (args.pdf) {
      pdf = join(inputDir, "pdf", basename(args.pdf));
      await mkdir(dirname(pdf));
      await writeFile(pdf, await readFile(args.pdf), { flag: "wx" });
    }
    // Refuse input changes between recording provenance and freezing the source.
    for (const record of inputRecords) {
      const frozen = record.kind === "markdown" ? markdown : pdf!;
      if (sha256Bytes(await readFile(frozen)) !== record.sha256) throw new Error("Input changed while snapshotting");
      Object.assign(record, { snapshot: frozen });
    }
    if (args.command === "targets") {
      phase = "discovery-checkpoint"; say(`[phase] ${phase}`);
      summary.discovery_checkpoint = await copyDevDiscovery({ from: args.from!, out: args.out, job: args.job, markdown, targets: args.targets, ...(pdf ? { pdf } : {}) });
    }
    const jobDir = devJobDirectory(args.out, args.job);
    summary.job_directory = jobDir;
    phase = args.command === "full" ? "discovery" : "extraction"; say(`[phase] ${phase}`);
    await writeFile(join(args.out, "summary.json"), JSON.stringify({ ...summary, outcome: "running", phase, document_pipeline_completed: false, semantic_correctness_verified: false }, null, 2) + "\n");
    let lastDiscovery = "";
    monitor = setInterval(() => {
      if (observing) return;
      observing = true;
      void readFile(join(jobDir, "discovery", "state.json"), "utf8").then(text => {
        const state = JSON.parse(text) as { status: string };
        if (lastDiscovery !== state.status) { lastDiscovery = state.status; say(`[discovery] ${state.status}`); }
      }).catch(() => {}).finally(() => { observing = false; });
    }, 1000);
    const targetStates = new Map<string, string>();
    const batchOptions: FullBatchOptions = { artifactRoot: args.out, jobId: args.job, markdownPath: markdown, ...(pdf ? { pdfPath: pdf } : {}), concurrency: args.concurrency,
      maxAttempts: args.attempts, live: true, modelConfig: config, ...(options.signal ? { signal: options.signal } : {}),
      ...(args.command === "targets" ? { targetIds: args.targets, freshTargetIds: args.targets } : {}),
      onStateChange: state => {
        batch = state;
        if (phase !== "extraction") say("[phase] extraction");
        phase = "extraction";
        for (const target of state.targets) {
          if (target.status !== "pending") {
            const timing = targetTiming.get(target.target_id) ?? { started_at: new Date().toISOString(), started_ms: Date.now(), duration_ms: 0, finished: false };
            if (!timing.finished || target.status === "running") timing.duration_ms = Date.now() - timing.started_ms;
            timing.finished = target.status === "sealed" || target.status === "failed";
            targetTiming.set(target.target_id, timing);
          }
          const message = `${target.status} attempt=${target.attempts} ${target.error}`;
          if (targetStates.get(target.target_id) !== message) { say(`[target] ${target.target_id} ${message}`); targetStates.set(target.target_id, message); }
        }
      } };
    batch = await deps.batch(batchOptions);
    options.signal?.throwIfAborted();
    if (args.command === "targets") {
      const selected = batch.targets.filter(t => args.targets.includes(t.target_id));
      if (selected.length !== args.targets.length || !selected.every(t => t.status === "sealed") || batch.status === "waiting_for_source") throw new Error("Selected targets did not all seal; inspect batch target failures/source requests");
      outcome = "selected_targets_sealed";
      say("[scope] Selected targets sealed; whole-document completion was not requested or established. Hierarchy skipped.");
    } else {
      if (batch.status !== "passed" || !batch.targets.every(t => t.status === "sealed")) throw new Error(`Extraction did not pass: ${batch.status}; inspect batch.json/receipt.json for target failures and ledger gaps`);
      if (batch.targets.length > 0) {
        phase = "hierarchy"; say(`[phase] ${phase}`);
        const hierarchy = await deps.hierarchy({ artifactRoot: args.out, jobId: args.job, markdownPath: markdown, aggregatePath: join(jobDir, "result.json"),
          batch: batch as unknown as Record<string, unknown>, maxAttempts: args.attempts, modelConfig: config, ...(options.signal ? { signal: options.signal } : {}),
          onProgress: progress => { say(`[hierarchy] ${JSON.stringify(progress)}`); } });
        summary.hierarchy = { workspace: hierarchy.workspace.root, reviewed: hierarchy.reviewed };
      } else if (!batch.discovery?.no_target_reason) throw new Error("No targets without a sealed no-target reason");
      outcome = batch.targets.length ? "document_pipeline_passed" : "no_extractable_acceptance_scope";
      documentComplete = true;
    }
    options.signal?.throwIfAborted();
    exitCode = 0;
  } catch (error) {
    outcome = options.signal?.aborted ? "cancelled" : "failed";
    exitCode = outcome === "cancelled" ? 130 : 1;
    errorMessage = redactDevMessage(error instanceof Error ? error.message : String(error), config);
    say(`[${outcome}] ${errorMessage}`);
  } finally {
    if (monitor) clearInterval(monitor);
    if (claimed) {
      const paths = await artifactPaths(args.out);
      Object.assign(summary, { outcome, phase, document_pipeline_completed: documentComplete, semantic_correctness_verified: false, exit_code: exitCode,
        duration_ms: Date.now() - started, finished_at: new Date().toISOString(), error: errorMessage,
        batch_status: batch?.status ?? null, ledger_gap: batch?.ledger_gap ?? null,
        targets: batch?.targets.map(t => ({ target_id: t.target_id, status: t.status, attempts: t.attempts, revision: t.revision, workdir: t.workdir, error: redactDevMessage(t.error, config),
          observed_started_at: targetTiming.get(t.target_id)?.started_at ?? null, observed_duration_ms: targetTiming.get(t.target_id)?.duration_ms ?? null })) ?? [], artifacts: paths });
      await writeFile(join(args.out, "summary.json"), redactDevMessage(JSON.stringify(summary, null, 2), config) + "\n");
      say(`[report] ${join(args.out, "summary.json")}`);
    }
  }
  return exitCode;
}

export async function devMain(argv: string[], options: Parameters<typeof runDevAcceptance>[1] = {}): Promise<number> {
  try {
    const args = parseDevArguments(argv);
    if (!args) { (options.log ?? console.log)(DEV_HELP); return 0; }
    return await runDevAcceptance(args, options);
  } catch (error) {
    (options.log ?? console.error)(`[failed] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
