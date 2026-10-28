import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { atomicWriteJson, readJson } from "../src/atomic.js";
import { DocumentDiscoveryWorkspace } from "../src/document-discovery.js";

interface PersistedDiscoveryState {
  status: "working" | "candidate" | "sealed";
  next_event_sequence: number;
  [key: string]: unknown;
}

interface DiscoveryTranscriptEvent {
  schema_version: "document-discovery-event/v1";
  sequence: number;
}

function transcriptEvent(sequence: number): string {
  return JSON.stringify({
    schema_version: "document-discovery-event/v1",
    sequence,
  });
}

const temporaryRoots: string[] = [];

async function createWorkspace(jobId: string): Promise<DocumentDiscoveryWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "pi-discovery-transcript-"));
  temporaryRoots.push(root);
  const markdownPath = join(root, "source.md");
  await writeFile(markdownPath, "# 1 验收范围\n1.0.1 工程质量应符合设计要求。", "utf8");
  return DocumentDiscoveryWorkspace.openOrCreate(root, jobId, markdownPath);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe("DocumentDiscoveryWorkspace transcript recovery", () => {
  test("advances past an adjacent replay and appends with a fresh sequence", async () => {
    const workspace = await createWorkspace("lagging-discovery-job");
    await workspace.appendEvent("tool_result", { ok: true });
    const firstEvent = (await readFile(workspace.transcriptPath, "utf8")).trim();
    await appendFile(workspace.transcriptPath, `${firstEvent}\n`, "utf8");
    const transcriptBefore = await readFile(workspace.transcriptPath, "utf8");
    const lagging = await readJson<PersistedDiscoveryState>(workspace.statePath);
    lagging.next_event_sequence = 1;
    await atomicWriteJson(workspace.statePath, lagging);

    const reopened = await DocumentDiscoveryWorkspace.openOrCreate(
      workspace.artifactRoot,
      workspace.jobId,
      workspace.sourcePath,
    );
    expect((await reopened.readState()).next_event_sequence).toBe(2);
    expect(await readFile(reopened.transcriptPath, "utf8")).toBe(transcriptBefore);

    await reopened.appendEvent("tool_result", { ok: true });
    const events = (await readFile(reopened.transcriptPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as DiscoveryTranscriptEvent);
    expect(events.map((event) => event.sequence)).toEqual([1, 1, 2]);
  });

  test("does not move an ahead state cursor backwards", async () => {
    const workspace = await createWorkspace("ahead-discovery-job");
    await workspace.appendEvent("tool_result", { ok: true });
    const ahead = await readJson<PersistedDiscoveryState>(workspace.statePath);
    ahead.next_event_sequence = 9;
    await atomicWriteJson(workspace.statePath, ahead);
    const transcriptBefore = await readFile(workspace.transcriptPath, "utf8");

    const reopened = await DocumentDiscoveryWorkspace.openOrCreate(
      workspace.artifactRoot,
      workspace.jobId,
      workspace.sourcePath,
    );
    expect((await reopened.readState()).next_event_sequence).toBe(9);
    expect(await readFile(reopened.transcriptPath, "utf8")).toBe(transcriptBefore);
  });

  test("does not rewrite a sealed state even when its cursor lags", async () => {
    const workspace = await createWorkspace("sealed-discovery-job");
    await workspace.appendEvent("tool_result", { ok: true });
    const sealed = await readJson<PersistedDiscoveryState>(workspace.statePath);
    sealed.status = "sealed";
    sealed.next_event_sequence = 1;
    const sealedBytes = JSON.stringify(sealed);
    await writeFile(workspace.statePath, sealedBytes, "utf8");

    const reopened = await DocumentDiscoveryWorkspace.openOrCreate(
      workspace.artifactRoot,
      workspace.jobId,
      workspace.sourcePath,
    );
    expect(await readFile(reopened.statePath, "utf8")).toBe(sealedBytes);
  });

  test.each([
    ["truncated JSON", "{\"schema_version\":"],
    ["wrong event schema", "{\"schema_version\":\"agent-event/v1\",\"sequence\":2}\n"],
    ["sequence gap", `${transcriptEvent(3)}\n`],
    ["backward sequence", `${transcriptEvent(2)}\n${transcriptEvent(1)}\n`],
    ["non-positive sequence", `${transcriptEvent(0)}\n`],
  ])("fails closed for a %s transcript tail without changing state", async (_label, tail) => {
    const workspace = await createWorkspace(`bad-discovery-tail-${temporaryRoots.length}`);
    await workspace.appendEvent("tool_result", { ok: true });
    const stateBefore = await readFile(workspace.statePath, "utf8");
    await appendFile(workspace.transcriptPath, tail, "utf8");
    const transcriptBefore = await readFile(workspace.transcriptPath, "utf8");

    await expect(DocumentDiscoveryWorkspace.openOrCreate(
      workspace.artifactRoot,
      workspace.jobId,
      workspace.sourcePath,
    )).rejects.toThrow("Invalid document discovery event transcript");
    expect(await readFile(workspace.statePath, "utf8")).toBe(stateBefore);
    expect(await readFile(workspace.transcriptPath, "utf8")).toBe(transcriptBefore);
  });
});
