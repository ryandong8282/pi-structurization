import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { RevisionState, TranscriptEvent } from "../src/contracts.js";
import { atomicWriteJson, readJson } from "../src/atomic.js";
import { RevisionWorkspace } from "../src/workspace.js";

const fixtureMarkdown = resolve("fixtures/stage1-like.md");
const temporaryRoots: string[] = [];

async function temporaryArtifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-transcript-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe("RevisionWorkspace transcript recovery", () => {
  test("advances past the transcript maximum while tolerating a legacy duplicate", async () => {
    const root = await temporaryArtifactRoot();
    const workspace = await RevisionWorkspace.create(root, "recovery-job", "target", fixtureMarkdown);
    expect((await workspace.appendEvent("commit", { phase: "start" })).sequence).toBe(1);
    const legacyEvent = (await readFile(workspace.transcriptPath, "utf8")).trim();
    await appendFile(workspace.transcriptPath, `${legacyEvent}\n`, "utf8");

    const lagging = await readJson<RevisionState>(workspace.statePath);
    lagging.next_event_sequence = 1;
    await atomicWriteJson(workspace.statePath, lagging);

    const reopened = await RevisionWorkspace.openLatest(root, "recovery-job", "target");
    expect((await reopened.readState()).next_event_sequence).toBe(2);
    expect((await reopened.appendEvent("commit", { phase: "end" })).sequence).toBe(2);

    const events = (await readFile(reopened.transcriptPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TranscriptEvent);
    expect(events.map((event) => event.sequence)).toEqual([1, 1, 2]);

    const sealedLag = await reopened.readState();
    sealedLag.status = "sealed";
    sealedLag.next_event_sequence = 1;
    await atomicWriteJson(reopened.statePath, sealedLag);
    const reopenedSealed = await RevisionWorkspace.openLatest(root, "recovery-job", "target");
    expect((await reopenedSealed.readState()).next_event_sequence).toBe(1);
  });

  test("rejects a malformed transcript tail without changing state", async () => {
    const root = await temporaryArtifactRoot();
    const workspace = await RevisionWorkspace.create(root, "bad-tail-job", "target", fixtureMarkdown);
    await workspace.appendEvent("commit", { phase: "start" });
    const stateBefore = await readFile(workspace.statePath, "utf8");
    await appendFile(workspace.transcriptPath, "{\"schema_version\":", "utf8");

    await expect(
      RevisionWorkspace.openLatest(root, "bad-tail-job", "target"),
    ).rejects.toThrow("Invalid revision event transcript");
    expect(await readFile(workspace.statePath, "utf8")).toBe(stateBefore);
  });
});
