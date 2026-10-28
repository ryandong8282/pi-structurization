import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as budget from "../src/attempt-budget.js";
import * as runtime from "../src/pi-runtime.js";
import { runFullDocumentDiscovery } from "../src/batch.js";
import { DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { discoveryTransportCheckpoint, discoveryTransportErrorKey, runDiscoveryWithTransportRetry } from "../src/discovery-transport.js";

let root: string;
let workspace: DocumentDiscoveryWorkspace;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-discovery-transport-"));
  await writeFile(join(root, "source.md"), "设备应安装牢固。\n");
  workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "test", join(root, "source.md"));
  vi.spyOn(budget, "targetTransportRetryDelayMs").mockReturnValue(1);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const e408 = '408: {"message":"stream error: stream disconnected before completion: stream closed before response.completed","type":"invalid_request_error"}';
const events = async () => (await readFile(workspace.transcriptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(e => e.event_type.startsWith("discovery_transport_retry_"));

describe("consecutive discovery network failures", () => {
  test.each([
    [e408, "http_408"], ["408 Request Timeout", "http_408"], ["500 TLS handshake EOF", "http_500"],
    ["503 unavailable", "http_503"], ["stream disconnected", "stream_disconnected"], ["read ECONNRESET", "ECONNRESET"],
    ["ETIMEDOUT", "ETIMEDOUT"], ["401 invalid api key", undefined], ["500 auth_unavailable", "http_500"],
    ["auth_unavailable: no auth available", undefined],
    ["discovery_coverage_unresolved", undefined], ["400 context_length_exceeded", undefined],
  ])("classifies %s", (error, key) => { expect(discoveryTransportErrorKey(error!)).toBe(key); });

  test.each(["candidate", "review"] as const)("%s does not add different errors together", async phase => {
    const errors = [e408, "500 EOF A", e408, "503 unavailable", e408, "500 EOF B"];
    const resumes: boolean[] = [];
    const run = vi.fn(async (resume: boolean) => { resumes.push(resume); return { error: errors.shift() }; });
    await expect(runDiscoveryWithTransportRetry(workspace, phase, false, run)).resolves.toEqual({ error: undefined });
    expect(run).toHaveBeenCalledTimes(7);
    expect(resumes).toEqual([false, true, true, true, true, true, true]);
    expect((await events()).map(e => e.payload.consecutive_failures)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test.each(["candidate", "review"] as const)("%s stops on the third identical status, not a fourth", async phase => {
    const before = await readFile(workspace.workingSelectorPath, "utf8");
    const state = await workspace.readState();
    const run = vi.fn(async () => ({ error: `500 TLS EOF request-${Math.random()}` }));
    await expect(runDiscoveryWithTransportRetry(workspace, phase, true, run)).rejects.toThrow(/http_500 连续 3 次/);
    expect(run).toHaveBeenCalledTimes(3);
    expect((await events()).map(e => [e.event_type, e.payload.consecutive_failures])).toEqual([
      ["discovery_transport_retry_scheduled", 1], ["discovery_transport_retry_scheduled", 2], ["discovery_transport_retry_exhausted", 3],
    ]);
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await workspace.readState()).toMatchObject({ validation_attempts: state.validation_attempts, reviewer_validation_attempts: state.reviewer_validation_attempts });
  });

  test.each(["selectors", "opened", "decisions"])("saved %s progress resets the same-error streak", async kind => {
    let calls = 0;
    const run = vi.fn(async () => {
      if (++calls === 3) {
        if (kind === "selectors") {
          const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
          saved.rationale = "已完成一项来源核验";
          await workspace.writeWorkingSelectors(JSON.stringify(saved));
        } else if (kind === "opened") await workspace.markReviewerOpened((await workspace.readEvidence()).atoms[0]!.atom_id);
        else await writeFile(workspace.decisionsPath, JSON.stringify([{ clause_id: "test", disposition: "context", reason: "已核对" }]));
      }
      return calls < 5 ? { error: e408 } : {};
    });
    await runDiscoveryWithTransportRetry(workspace, "review", true, run);
    expect((await events()).map(e => e.payload.consecutive_failures)).toEqual([1, 2, 1, 2]);
    expect((await events())[2].payload.durable_progress).toBe(true);
  });

  test("log activity, session metadata and equivalent JSON are not saved progress", async () => {
    const before = await discoveryTransportCheckpoint(workspace, "candidate");
    await workspace.appendEvent("test", { anything: "new log" });
    await workspace.setRuntime({ kind: "pi-sdk", session_id: "new", session_file: "new.jsonl" });
    const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
    await workspace.writeWorkingSelectors(JSON.stringify(selectors, null, 4));
    expect(await discoveryTransportCheckpoint(workspace, "candidate")).toBe(before);
  });

  test("thrown transport errors use the same policy", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error(e408)).mockResolvedValue({});
    await expect(runDiscoveryWithTransportRetry(workspace, "candidate", false, run)).resolves.toEqual({});
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("semantic or configuration failures are returned, not retried as transport", async () => {
    const result = { error: "discovery_coverage_unresolved" };
    const run = vi.fn().mockResolvedValue(result);
    expect(await runDiscoveryWithTransportRetry(workspace, "candidate", true, run)).toBe(result);
    expect(run).toHaveBeenCalledOnce();
    const bad = vi.fn().mockRejectedValue(new Error("401 invalid api key"));
    await expect(runDiscoveryWithTransportRetry(workspace, "candidate", true, bad)).rejects.toThrow("401");
    expect(bad).toHaveBeenCalledOnce();
  });

  test("abort interrupts backoff without a new model call", async () => {
    vi.mocked(budget.targetTransportRetryDelayMs).mockReturnValue(60_000);
    const abort = new AbortController();
    const append = workspace.appendEvent.bind(workspace);
    vi.spyOn(workspace, "appendEvent").mockImplementation(async (type, payload) => {
      await append(type, payload);
      if (type === "discovery_transport_retry_scheduled") abort.abort();
    });
    const run = vi.fn().mockResolvedValue({ error: e408 });
    await expect(runDiscoveryWithTransportRetry(workspace, "candidate", false, run, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });

  test("SDK retry override preserves saved settings and provider timeout", async () => {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const path = join(agentDir, "settings.json");
    const text = JSON.stringify({ retry: { enabled: true, maxRetries: 8, provider: { maxRetries: 4, timeoutMs: 42_000 } }, compaction: { enabled: false } });
    await writeFile(path, text);
    const settings = runtime.outerTransportSessionSettings(root, agentDir);
    expect(settings.getRetryEnabled()).toBe(false);
    expect(settings.getProviderRetrySettings()).toMatchObject({ maxRetries: 0, timeoutMs: 42_000 });
    expect(settings.getCompactionEnabled()).toBe(false);
    await settings.flush();
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("real batch recovers author transport without independent review or extra validation attempts", async () => {
    let candidateCalls = 0;
    const candidate = vi.spyOn(runtime, "runLiveDocumentDiscovery").mockImplementation(async (ws, controller) => {
      const base = { session_id: "test", session_file: "test.jsonl", model: "test", candidate_ready: false };
      if (++candidateCalls <= 4) return { ...base, error: candidateCalls % 2 ? e408 : "500 EOF" };
      const atom = controller.evidence.atoms[0]!;
      await controller.dispatch("open_document_atom", { atom_id: atom.atom_id });
      const span = (await ws.readSourceSpanRegistry()).spans.find(s => s.atom_id === atom.atom_id)!;
      expect(await controller.dispatch("edit_document_selectors", { edits: [
        { collection: "targets", key: "device", op: "upsert", value: {
          key: "device", group_key: "device", group_name: "设备", group_reason: "设备安装", name: "设备",
          lot_basis_summary: "设备安装检查", scope_span_ids: [span.span_id], lot_basis_span_ids: [span.span_id], reason: "设备安装要求",
          source_blocks: [{ kind: "explicit_range", anchor_span_id: span.span_id, start_span_id: span.span_id, end_span_id: span.span_id, reason: "完整要求" }],
          semantic_basis: { subject: "设备", subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span.span_id], acceptance_reason: "安装牢固", boundary_reason: "单一对象" },
        } },
        { collection: "dispositions", key: span.span_id, op: "upsert", value: { disposition: "target", target_keys: ["device"], reason: "质量要求" } },
      ] })).toMatchObject({ ok: true });
      const compiled = await controller.dispatch("compile_document_selectors", {});
      expect(compiled).toMatchObject({ ok: true });
      expect(await controller.dispatch("seal_discovery_plan", { fingerprint: compiled.fingerprint })).toMatchObject({ ok: true });
      return { ...base, candidate_ready: true };
    });
    const reviewer = vi.spyOn(runtime, "runLiveDocumentReview").mockRejectedValue(new Error("Independent review must not run"));
    const result = await runFullDocumentDiscovery({ artifactRoot: root, jobId: "test", markdownPath: join(root, "source.md"), concurrency: 1, maxAttempts: 1, live: true });
    expect(result.plan.targets).toHaveLength(1);
    expect(candidate).toHaveBeenCalledTimes(5);
    expect(reviewer).not.toHaveBeenCalled();
    expect(await workspace.readState()).toMatchObject({ status: "sealed", validation_attempts: 1 });
    expect((await workspace.readState()).reviewer_validation_attempts ?? 0).toBe(0);
  }, 30_000);
});
