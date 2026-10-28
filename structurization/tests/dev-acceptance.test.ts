import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { devMain, parseDevArguments, runDevAcceptance, type DevArguments, type DevDependencies } from "../src/dev-runner.js";
import { loadDevModelConfig, redactDevMessage } from "../src/dev-config.js";
import { copyDevDiscovery, devJobDirectory } from "../src/dev-checkpoint.js";
import { DocumentDiscoveryController, DocumentDiscoveryWorkspace, type DocumentTargetPlan } from "../src/document-discovery.js";
import { prefillDocumentSelectorsFromLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import type { FullBatchOptions, FullBatchState } from "../src/batch.js";
import { runFullDocumentDiscovery } from "../src/batch.js";
import { sha256Bytes } from "../src/canonical.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const env = { STRUCTURIZATION_API_TYPE: "openai", STRUCTURIZATION_ENDPOINT: "https://example.com/v1", STRUCTURIZATION_API_KEY: "private-test-key", STRUCTURIZATION_MODEL: "test-model" };
async function setup(): Promise<{ root: string; args: DevArguments }> {
  const root = await mkdtemp(join(tmpdir(), "acceptance-dev-")); roots.push(root);
  const markdown = join(root, "source.md");
  await writeFile(markdown, "# 2 工程\n\n## 2.1 桩基验收\n\n2.1.1 桩身承载力应符合设计要求。检查数量：每批3根。\n\n## 2.2 连接验收\n\n2.2.1 连接应牢固。检查数量：每批2件。\n");
  return { root, args: { command: "full", markdown, out: join(root, "run"), job: "job-1", targets: [], concurrency: 1, attempts: 3 } };
}
function state(options: FullBatchOptions, status: FullBatchState["status"] = "passed"): FullBatchState {
  return { schema_version: "acceptance-full-batch/v3", job_id: options.jobId, source: { markdown_file: "source.md", markdown_sha256: "test" }, mode: "live-pi", status,
    targets: ["target-1", "target-2"].map(id => ({ target_id: id, status: !options.targetIds || options.targetIds.includes(id) ? "sealed" : "pending", table_count: 1, row_count: 1, attempts: 1, revision: 1, workdir: join(options.artifactRoot, id), model: "test", error: "" })) };
}
function runners(): DevDependencies {
  return { batch: vi.fn(async options => {
    const result = state(options); await options.onStateChange?.(result); return result;
  }), hierarchy: vi.fn(async () => ({ workspace: { root: "hierarchy" }, reviewed: false })) as unknown as DevDependencies["hierarchy"],
    fingerprint: vi.fn(async () => ({ source_fingerprint: "source", build_fingerprint: "build" })) };
}
async function summary(out: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(join(out, "summary.json"), "utf8")) as Record<string, unknown>; }
async function sealedDiscovery(root: string, markdown: string): Promise<{ directory: string; plan: DocumentTargetPlan }> {
  const directory = join(root, "original");
  const workspace = await DocumentDiscoveryWorkspace.openOrCreate(directory, "job-1", markdown);
  const evidence = await workspace.readEvidence(), ledger = await workspace.readLedger();
  const prefill = prefillDocumentSelectorsFromLedger("job-1", evidence.atoms, ledger, await workspace.readSourceSpanRegistry());
  const plan = compileDocumentSelectors(approveScopeFixture(prefill.selectors, prefill.registry, evidence), prefill.registry, evidence, "job-1");
  await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(prefill.registry));
  const controller = await DocumentDiscoveryController.create(workspace, "candidate");
  for (const atom of evidence.atoms) await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
  expect(await controller.dispatch("replace_discovery_plan", { content: JSON.stringify(plan) })).toMatchObject({ ok: true });
  const validation = await controller.dispatch("validate_discovery_plan", {});
  expect(validation).toMatchObject({ ok: true });
  expect(await controller.dispatch("seal_discovery_plan", { fingerprint: validation.fingerprint })).toMatchObject({ ok: true });
  return { directory, plan };
}

describe("development CLI arguments", () => {
  test("defaults, repeatable targets and help", () => {
    const args = parseDevArguments(["full", "--markdown", "x.md", "--out", "data/run", "--job", "demo"]);
    expect(args).toMatchObject({ concurrency: 1, attempts: 3, targets: [] });
    expect(parseDevArguments(["--help"])).toBeUndefined();
    expect(parseDevArguments(["targets", "--markdown", "x.md", "--out", "next", "--job", "demo", "--from", "prior", "--target", "a", "--target", "b", "--target", "a"])?.targets).toEqual(["a", "b"]);
  });
  test.each([
    [], ["resume"], ["full"],
    ["full", "--markdown", "x", "--out", "out", "--job", "../escape"],
    ["full", "--markdown", "x", "--out", "out", "--job", "job", "--concurrency", "0"],
    ["full", "--markdown", "x", "--out", "out", "--job", "job", "--attempts", "21"],
    ["full", "--markdown", "x", "--out", "out", "--job", "job", "--target", "a"],
    ["targets", "--markdown", "x", "--out", "out", "--job", "job", "--from", "old"],
    ["full", "--markdown", "x", "--out", "out", "--job", "job", "--out", "other"],
    ["full", "--markdown", "x", "--out", "out", "--job", "job", "--unknown", "x"],
  ].map(argv => ({ argv })))("rejects invalid arguments: $argv", ({ argv }) => { expect(() => parseDevArguments(argv)).toThrow(); });
});

describe("runtime config (not saved web config)", () => {
  test("environment defaults and stage overrides", async () => {
    const config = await loadDevModelConfig(undefined, { ...env, STRUCTURIZATION_TARGET_EXTRACTION_MODEL: "override", STRUCTURIZATION_EFFORT: "low" });
    expect(config.stages.discovery).toMatchObject({ model: "test-model", effort: "low", authMode: "api_key" });
    expect(config.stages.target_extraction.model).toBe("override");
    expect(redactDevMessage("Bearer abc private-test-key", config)).toBe("Bearer [REDACTED] [REDACTED]");
  });
  test("stage environment > common environment > runtime file; OAuth path stays external", async () => {
    const { root } = await setup(), path = join(root, "runtime.json");
    const original = await loadDevModelConfig(undefined, env);
    original.subscriptionAuthPath = "auth.json";
    await writeFile(path, JSON.stringify(original));
    const config = await loadDevModelConfig(path, { STRUCTURIZATION_MODEL: "common", STRUCTURIZATION_HIERARCHY_MODEL: "hierarchy" });
    expect(config.stages.discovery.model).toBe("common"); expect(config.stages.hierarchy.model).toBe("hierarchy");
    expect(config.subscriptionAuthPath).toBe(join(root, "auth.json"));
    expect(await loadDevModelConfig(path, {})).toMatchObject({ stages: original.stages });
  });
  test.each([
    {}, { ...env, STRUCTURIZATION_API_TYPE: "invalid" }, { ...env, STRUCTURIZATION_EFFORT: "extreme" },
    { ...env, STRUCTURIZATION_AUTH_MODE: "chatgpt" }, { ...env, STRUCTURIZATION_ENDPOINT: "https://user:secret@example.com" },
  ])("rejects missing/invalid environment without leaking values", async values => { await expect(loadDevModelConfig(undefined, values)).rejects.toThrow(); });
  test("rejects malformed and saved UI JSON without echoing secrets", async () => {
    const { root } = await setup(), path = join(root, "config.json");
    await writeFile(path, '{"secret":"private-test-key",');
    await expect(loadDevModelConfig(path, {})).rejects.toThrow("Cannot read runtime config JSON");
    await writeFile(path, JSON.stringify({ models: [], apiKey: "private-test-key" }));
    await expect(loadDevModelConfig(path, {})).rejects.toThrow("saved web configuration is not supported");
  });
  test("parses an existing OAuth configuration without creating credentials", async () => {
    const { root } = await setup();
    const config = await loadDevModelConfig(undefined, { ...env, STRUCTURIZATION_AUTH_MODE: "chatgpt", STRUCTURIZATION_SUBSCRIPTION_AUTH_PATH: join(root, "external-auth.json") });
    expect(config.stages.discovery.authMode).toBe("chatgpt");
    await expect(readFile(config.subscriptionAuthPath!)).rejects.toThrow();
  });
});

describe("offline orchestration using production call boundaries", () => {
  test("full batch gates hierarchy, freezes inputs, records fingerprints without credentials", async () => {
    const { args } = await setup(), dependencies = runners();
    expect(await runDevAcceptance(args, { env, dependencies, log: () => {} })).toBe(0);
    expect(dependencies.batch).toHaveBeenCalledWith(expect.objectContaining({ live: true, concurrency: 1, maxAttempts: 3, markdownPath: join(args.out, "inputs", "markdown", "source.md") }));
    expect(dependencies.hierarchy).toHaveBeenCalledOnce();
    expect(await summary(args.out)).toMatchObject({ outcome: "document_pipeline_passed", document_pipeline_completed: true, semantic_correctness_verified: false, implementation: { source_fingerprint: "source" } });
    expect(await readFile(join(args.out, "summary.json"), "utf8")).not.toContain("private-test-key");
    expect(await readdir(args.out)).not.toContain("config.json");
  });
  test.each(["failed", "running", "waiting_for_source"] as const)("does not run hierarchy for %s extraction", async status => {
    const { args } = await setup(), dependencies = runners(); dependencies.batch = vi.fn(async options => state(options, status));
    expect(await runDevAcceptance(args, { env, dependencies, log: () => {} })).toBe(1);
    expect(dependencies.hierarchy).not.toHaveBeenCalled();
    expect(await summary(args.out)).toMatchObject({ outcome: "failed", document_pipeline_completed: false });
  });
  test("hierarchy failure retains extraction status and nonzero exit; errors redact keys", async () => {
    const { args } = await setup(), dependencies = runners(), logs: string[] = [];
    dependencies.hierarchy = vi.fn(async () => { throw new Error("provider private-test-key"); });
    expect(await runDevAcceptance(args, { env, dependencies, log: s => logs.push(s) })).toBe(1);
    expect(await summary(args.out)).toMatchObject({ batch_status: "passed", phase: "hierarchy", error: "provider [REDACTED]", document_pipeline_completed: false });
    expect(logs.join()).not.toContain("private-test-key");
  });
  test("cancellation propagates AbortSignal and returns 130 with report", async () => {
    const { args } = await setup(), dependencies = runners(), controller = new AbortController();
    dependencies.batch = vi.fn(async options => { controller.abort(); options.signal?.throwIfAborted(); return state(options); });
    expect(await runDevAcceptance(args, { env, dependencies, signal: controller.signal, log: () => {} })).toBe(130);
    expect(dependencies.hierarchy).not.toHaveBeenCalled(); expect(await summary(args.out)).toMatchObject({ outcome: "cancelled", exit_code: 130 });
  });
  test("existing output is never overwritten; missing config fails with summary", async () => {
    const { args } = await setup(), dependencies = runners(); await mkdir(args.out); await writeFile(join(args.out, "keep"), "untouched");
    expect(await runDevAcceptance(args, { env, dependencies, log: () => {} })).toBe(1); expect(await readdir(args.out)).toEqual(["keep"]);
    args.out += "-new";
    expect(await runDevAcceptance(args, { env: {}, dependencies, log: () => {} })).toBe(1); expect(dependencies.batch).not.toHaveBeenCalled();
    expect(await summary(args.out)).toMatchObject({ phase: "preflight", outcome: "failed" });
  });
  test("CLI returns nonzero for invalid args; actual source process works without built output", async () => {
    expect(await devMain(["full"], { log: () => {} })).toBe(1);
    const cli = resolve("src/acceptance-dev.ts");
    const help = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain("Source-based acceptance");
    const bad = spawnSync(process.execPath, ["--import", "tsx", cli, "full"], { encoding: "utf8" });
    expect(bad.status).toBe(1);
  });
  test("zero-target success requires a sealed no-target reason and skips hierarchy", async () => {
    const { args } = await setup(), dependencies = runners();
    dependencies.batch = vi.fn(async options => {
      const result = state(options); result.targets = [];
      result.discovery = { schema_version: "document-domain-discovery/v1", status: "sealed", no_target_reason: "合成非验收资料", workdir: "discovery", model: "test", target_count: 0, manifest_sha256: "test" };
      return result;
    });
    expect(await runDevAcceptance(args, { env, dependencies, log: () => {} })).toBe(0);
    expect(dependencies.hierarchy).not.toHaveBeenCalled();
    expect(await summary(args.out)).toMatchObject({ outcome: "no_extractable_acceptance_scope", document_pipeline_completed: true });
  });
});

describe("fresh isolated target runs", () => {
  test("copies only sealed discovery byte-for-byte, uses targetIds/freshTargetIds and skips hierarchy", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown), dependencies = runners();
    const sourceJob = devJobDirectory(original.directory, args.job), sourceDiscovery = join(sourceJob, "discovery");
    await mkdir(join(sourceJob, "targets", "old"), { recursive: true }); await writeFile(join(sourceJob, "targets", "old", "answer.json"), "OLD ANSWER");
    await mkdir(join(sourceDiscovery, "pi-session"), { recursive: true }); await writeFile(join(sourceDiscovery, "pi-session", "old.jsonl"), "OLD SESSION");
    const statePath = join(sourceDiscovery, "state.json");
    const discoveryState = JSON.parse(await readFile(statePath, "utf8")) as { agent_runtime: { kind: string; session_id: string; session_file: string } };
    discoveryState.agent_runtime = { kind: "pi-sdk", session_id: "old-session", session_file: join(sourceDiscovery, "pi-session", "old.jsonl") };
    await writeFile(statePath, JSON.stringify(discoveryState));
    const before = await readFile(join(sourceDiscovery, "state.json")), target = original.plan.targets[0]!.target_id;
    dependencies.batch = vi.fn(async options => {
      expect(options.targetIds).toEqual([target]); expect(options.freshTargetIds).toEqual([target]);
      expect(await readFile(join(devJobDirectory(options.artifactRoot, args.job), "discovery", "state.json"))).toEqual(before);
      const discovery = await runFullDocumentDiscovery(options); expect(discovery.plan.targets).toEqual(original.plan.targets);
      const result = state(options, "failed"); result.targets[0]!.target_id = target; result.targets[0]!.status = "sealed"; return result;
    });
    const code = await runDevAcceptance({ ...args, command: "targets", from: original.directory, targets: [target] }, { env, dependencies, log: () => {} });
    expect(code, JSON.stringify(await summary(args.out))).toBe(0); expect(dependencies.hierarchy).not.toHaveBeenCalled();
    expect(await summary(args.out)).toMatchObject({ scope: "selected_targets", outcome: "selected_targets_sealed", document_pipeline_completed: false, batch_status: "failed" });
    const dest = join(devJobDirectory(args.out, args.job), "discovery");
    // Existing readState() rewrites JSON formatting in the relocated workspace.
    expect(JSON.parse(await readFile(join(dest, "state.json"), "utf8"))).toEqual(JSON.parse(before.toString()));
    expect(await readFile(join(sourceDiscovery, "state.json"))).toEqual(before);
    expect(await readdir(devJobDirectory(args.out, args.job))).toEqual(["discovery"]);
    expect(await readdir(dest)).not.toContain("pi-session"); expect(await readdir(dest)).not.toContain("pi-agent-home");
  });
  test("unknown target, changed source filename/bytes and overlapping output fail closed", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown), target = original.plan.targets[0]!.target_id;
    const base = { from: original.directory, out: args.out, job: args.job, markdown: args.markdown, targets: [target] };
    await expect(copyDevDiscovery({ ...base, targets: ["unknown"] })).rejects.toThrow("target IDs");
    await expect(copyDevDiscovery({ ...base, out: join(original.directory, "nested") })).rejects.toThrow("disjoint");
    await expect(copyDevDiscovery({ ...base, out: root })).rejects.toThrow("disjoint");
    const renamed = join(root, "renamed.md"); await writeFile(renamed, await readFile(args.markdown));
    await expect(copyDevDiscovery({ ...base, markdown: renamed })).rejects.toThrow("identity mismatch");
    await writeFile(args.markdown, "changed"); await expect(copyDevDiscovery(base)).rejects.toThrow("identity mismatch");
  });
  test("detects corrupt seals before copying and leaves original unchanged", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown), target = original.plan.targets[0]!.target_id;
    const path = join(devJobDirectory(original.directory, args.job), "discovery", "manifest.json"); await chmod(path, 0o600);
    const manifest = JSON.parse(await readFile(path, "utf8")) as { files: { plan_sha256: string } }; manifest.files.plan_sha256 = "corrupt"; await writeFile(path, JSON.stringify(manifest));
    await expect(copyDevDiscovery({ from: original.directory, out: args.out, job: args.job, markdown: args.markdown, targets: [target] })).rejects.toThrow("manifest mismatch");
    await expect(readdir(args.out)).rejects.toThrow();
  });
  test("failed selected target is not a successful partial run", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown), dependencies = runners(), target = original.plan.targets[0]!.target_id;
    dependencies.batch = vi.fn(async options => { const result = state(options, "failed"); result.targets[0]!.target_id = target; result.targets[0]!.status = "failed"; result.targets[0]!.error = "failed validation"; return result; });
    expect(await runDevAcceptance({ ...args, command: "targets", from: original.directory, targets: [target] }, { env, dependencies, log: () => {} })).toBe(1);
    expect(dependencies.hierarchy).not.toHaveBeenCalled();
  });
  test("multiple targets are selected explicitly in a new run", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown), dependencies = runners();
    const targets = original.plan.targets.map(target => target.target_id);
    expect(targets.length).toBeGreaterThan(1);
    dependencies.batch = vi.fn(async options => {
      expect(options.targetIds).toEqual(targets); expect(options.freshTargetIds).toEqual(targets);
      const result = state(options);
      result.targets.forEach((target, index) => { target.target_id = targets[index]!; target.status = "sealed"; });
      return result;
    });
    expect(await runDevAcceptance({ ...args, command: "targets", from: original.directory, targets }, { env, dependencies, log: () => {} })).toBe(0);
    expect(await summary(args.out)).toMatchObject({ document_pipeline_completed: false });
  });
  test("rejects unsealed state and a corrupted event prefix", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown);
    const directory = join(devJobDirectory(original.directory, args.job), "discovery"), statePath = join(directory, "state.json");
    const saved = await readFile(statePath);
    const state = JSON.parse(saved.toString()) as { status: string }; state.status = "working";
    await writeFile(statePath, JSON.stringify(state));
    const input = { from: original.directory, out: args.out, job: args.job, markdown: args.markdown, targets: [original.plan.targets[0]!.target_id] };
    await expect(copyDevDiscovery(input)).rejects.toThrow("sealed current discovery");
    await writeFile(statePath, saved);
    await writeFile(join(directory, "session.events.jsonl"), "corrupt");
    await expect(copyDevDiscovery(input)).rejects.toThrow("transcript prefix mismatch");
  });
  test("original PDF identity is mandatory and must match; no target artifacts are imported", async () => {
    const { root, args } = await setup(), original = await sealedDiscovery(root, args.markdown);
    const pdf = join(root, "source.pdf"); await writeFile(pdf, "%PDF-1.7 synthetic fixture");
    const job = devJobDirectory(original.directory, args.job);
    await writeFile(join(job, "batch.json"), JSON.stringify({ source: { markdown_sha256: sha256Bytes(await readFile(args.markdown)), pdf_file: "source.pdf", pdf_sha256: sha256Bytes(await readFile(pdf)) } }));
    const input = { from: original.directory, out: args.out, job: args.job, markdown: args.markdown, targets: [original.plan.targets[0]!.target_id] };
    await expect(copyDevDiscovery(input)).rejects.toThrow("PDF identity mismatch");
    const wrong = join(root, "wrong.pdf"); await writeFile(wrong, "%PDF-wrong");
    await expect(copyDevDiscovery({ ...input, pdf: wrong })).rejects.toThrow("PDF identity mismatch");
    await copyDevDiscovery({ ...input, pdf });
    expect(await readdir(devJobDirectory(args.out, args.job))).toEqual(["discovery"]);
  });
});
