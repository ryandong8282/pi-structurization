import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import {
  COMPACT_PLAN_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  compileSemanticDecisionsV8,
  type SemanticDecisionPlan,
} from "../src/semantic-decision-compiler.js";
import { RevisionWorkspace } from "../src/workspace.js";

async function fixture(label: string): Promise<{
  root: string;
  workspace: RevisionWorkspace;
  compactText: string;
}> {
  const root = resolve(".tmp-tests", `workspace-plan-v8-${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const jobId = `job:${label}`;
  const targetId = `target:${label}`;
  const sourceText = "";
  const payload = {
    schema_version: "evidence-manifest/v6" as const,
    job_id: jobId,
    target_id: targetId,
    source: {
      adapter: "markdown-target-scope/v3" as const,
      file_name: "empty.md",
      sha256: sha256Text(sourceText),
      semantic_workflow: "semantic-evidence/v1" as const,
    },
    scope: {
      schema_version: "markdown-target-scope/v1" as const,
      mode: "target_section" as const,
      target_id: targetId,
      source_line_count: 0,
      selected_start_line: 0,
      selected_end_exclusive_line: 0,
      selected_heading: "",
      selection_reason: "workspace recovery fixture",
      candidates: [],
    },
    evidence: [],
    table_fragments: [],
    reference_occurrences: [],
  };
  const manifest: EvidenceManifest = {
    ...payload,
    evidence_fingerprint: sha256Json(payload),
  };
  const decisions: SemanticDecisionPlan = {
    schema_version: "semantic-decision-plan/v1",
    job_id: jobId,
    target_id: targetId,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: { tables: [], fragment_dispositions: [] },
    lots: [],
    items: [],
    semantic_nodes: [],
    references: [],
    sampling_rules: [],
    occurrence_resolutions: [],
    evidence_dispositions: [],
  };
  const compactText = prettyJson(compileSemanticDecisionsV8(decisions, manifest));
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    jobId,
    targetId,
    { manifest, markdown: Buffer.from(sourceText) },
  );
  return { root, workspace, compactText };
}

function expectSameArtifact(actual: string, expected: string): void {
  expect(actual).toBe(expected);
  expect(sha256Text(actual)).toBe(sha256Text(expected));
  expect(JSON.parse(actual)).toMatchObject({ schema_version: COMPACT_PLAN_SCHEMA_VERSION });
}

describe("workspace persisted semantic plan recovery", () => {
  it("treats a working compact v8 plan as current without rewriting it", async () => {
    const { root, workspace, compactText } = await fixture("upgrade");
    try {
      await writeFile(workspace.workingPlanPath, compactText, "utf8");

      expect(await workspace.upgradeWorkingPlanToCurrent()).toBe(false);
      expectSameArtifact(await readFile(workspace.workingPlanPath, "utf8"), compactText);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("carries a sealed compact v8 plan into a writable revision unchanged", async () => {
    const { root, workspace, compactText } = await fixture("sealed");
    try {
      await writeFile(workspace.sealedPlanPath, compactText, "utf8");
      await workspace.updateState((state) => { state.status = "sealed"; });

      const recovered = await RevisionWorkspace.reviseFromSealed(
        root,
        workspace.jobId,
        workspace.targetId,
      );

      expectSameArtifact(await readFile(recovered.workingPlanPath, "utf8"), compactText);
      expectSameArtifact(await readFile(workspace.sealedPlanPath, "utf8"), compactText);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("restores a last-valid compact v8 checkpoint after an interrupted seal unchanged", async () => {
    const { root, workspace, compactText } = await fixture("interrupted");
    try {
      await writeFile(workspace.workingPlanPath, compactText, "utf8");
      await writeFile(workspace.lastValidPlanPath, compactText, "utf8");
      await writeFile(workspace.sealedPlanPath, compactText, "utf8");
      await workspace.updateState((state) => {
        state.last_valid_fingerprint = "f".repeat(64);
        state.last_valid_plan_sha256 = sha256Text(compactText);
      });

      const recovered = await RevisionWorkspace.reviseFromInterruptedSeal(
        root,
        workspace.jobId,
        workspace.targetId,
      );

      expectSameArtifact(await readFile(recovered.workingPlanPath, "utf8"), compactText);
      expectSameArtifact(await readFile(recovered.lastValidPlanPath, "utf8"), compactText);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("continues to migrate a legacy v6 working plan to expanded v7", async () => {
    const { root, workspace } = await fixture("legacy-v6");
    try {
      const legacy = JSON.parse(await readFile(workspace.workingPlanPath, "utf8"));
      legacy.schema_version = "semantic-source-plan/v6";
      await writeFile(workspace.workingPlanPath, prettyJson(legacy), "utf8");

      expect(await workspace.upgradeWorkingPlanToCurrent()).toBe(true);
      expect(JSON.parse(await readFile(workspace.workingPlanPath, "utf8"))).toMatchObject({
        schema_version: PLAN_SCHEMA_VERSION,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
