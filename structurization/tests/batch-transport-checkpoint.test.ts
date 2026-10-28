import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { targetDurableCheckpoint } from "../src/batch.js";
import type { RevisionWorkspace } from "../src/workspace.js";

describe("batch transport checkpoint", () => {
  test("tracks durable coverage progress but ignores runtime-only coverage telemetry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-coverage-transport-checkpoint-"));
    const fingerprint = "a".repeat(64);
    const selectorPath = join(root, "working.target-selectors.json");
    const registryPath = join(root, "source-span-registry.json");
    const coverageRoot = join(root, "coverage-review");
    const coverageDirectory = join(coverageRoot, fingerprint);
    const workingPath = join(coverageDirectory, "working.coverage-review.json");
    const statePath = join(coverageDirectory, "state.json");
    await mkdir(coverageDirectory, { recursive: true });
    await Promise.all([
      writeFile(selectorPath, "{}", "utf8"),
      writeFile(registryPath, "{}", "utf8"),
      writeFile(workingPath, JSON.stringify({ records: [] }), "utf8"),
      writeFile(statePath, JSON.stringify({
        opened_evidence_ids: [],
        last_valid_review_fingerprint: "",
        agent_runtime: { session_id: "session-a" },
        next_event_sequence: 1,
      }), "utf8"),
    ]);
    const workspace = {
      workingSelectorPath: selectorPath,
      sourceSpanRegistryPath: registryPath,
      coverageReviewDirectory: coverageRoot,
      readState: async () => ({
        revision: 6,
        next_history_sequence: 44,
        selector_stage: "commit",
        selector_batch_requires_stage: false,
        opened_evidence_ids: [],
        opened_evidence_window_keys: [],
        opened_global_resource_ids: [],
        last_valid_fingerprint: fingerprint,
      }),
    } as unknown as RevisionWorkspace;

    const initial = await targetDurableCheckpoint(workspace);
    await writeFile(statePath, JSON.stringify({
      opened_evidence_ids: [],
      last_valid_review_fingerprint: "",
      agent_runtime: { session_id: "session-b" },
      next_event_sequence: 99,
    }), "utf8");
    expect(await targetDurableCheckpoint(workspace)).toBe(initial);

    await writeFile(workingPath, JSON.stringify({ records: Array.from({ length: 13 }, (_, index) => index) }), "utf8");
    const staged = await targetDurableCheckpoint(workspace);
    expect(staged).not.toBe(initial);

    await writeFile(statePath, JSON.stringify({
      opened_evidence_ids: ["atom:opened"],
      last_valid_review_fingerprint: "",
      agent_runtime: { session_id: "session-c" },
      next_event_sequence: 100,
    }), "utf8");
    expect(await targetDurableCheckpoint(workspace)).not.toBe(staged);
  });
});
