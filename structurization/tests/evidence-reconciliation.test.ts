import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { prettyJson } from "../src/canonical.js";
import type { SemanticSourcePlan } from "../src/contracts.js";
import { ToolController, validFixturePlan } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureMarkdown = resolve(packageRoot, "fixtures/stage1-like.md");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("evidence disposition reconciliation", () => {
  test("derives used dispositions and lets the Agent classify only opened unresolved evidence", async () => {
    const root = join(tmpdir(), `pi-evidence-reconciliation-${randomUUID()}`);
    roots.push(root);
    const revision = await RevisionWorkspace.create(
      root,
      "reconcile-job",
      "4.1",
      fixtureMarkdown,
    );
    const controller = await ToolController.create(revision);
    const manifest = controller.evidence;
    const working = structuredClone(validFixturePlan(manifest));
    const required = manifest.evidence.filter((record) => record.requires_disposition);
    expect(required.length).toBeGreaterThanOrEqual(2);
    const autoUsed = required[0]!;
    const unresolved = required[1]!;
    working.evidence_dispositions = working.evidence_dispositions.filter((row) =>
      row.evidence_id !== autoUsed.evidence_id
      && row.evidence_id !== unresolved.evidence_id
    );
    // A heading is still used while a lot cites it, even if every item drops it.
    for (const lot of working.inspection_lots) {
      lot.evidence_ids = lot.evidence_ids.filter((id) => id !== unresolved.evidence_id);
    }
    for (const item of working.acceptance_items) {
      item.evidence_ids = item.evidence_ids.filter((id) => id !== unresolved.evidence_id);
      item.reference_evidence_ids = item.reference_evidence_ids.filter((id) =>
        id !== unresolved.evidence_id
      );
      item.sampling.evidence_ids = item.sampling.evidence_ids.filter((id) =>
        id !== unresolved.evidence_id
      );
    }
    await controller.dispatch("replace_working_plan", { content: prettyJson(working) });

    const listed = await controller.dispatch("reconcile_evidence_dispositions", {
      decisions: [],
    });
    expect(listed).toMatchObject({
      ok: true,
      complete: false,
      auto_used_evidence_ids: expect.arrayContaining([autoUsed.evidence_id]),
      unhandled_evidence: expect.arrayContaining([
        expect.objectContaining({ evidence_id: unresolved.evidence_id }),
      ]),
    });
    const afterList = JSON.parse(
      await readFile(revision.workingPlanPath, "utf8"),
    ) as SemanticSourcePlan;
    expect(afterList.evidence_dispositions).toContainEqual(expect.objectContaining({
      evidence_id: autoUsed.evidence_id,
      disposition: "used",
      item_ids: [working.acceptance_items[0]!.item_id],
    }));
    expect(afterList.evidence_dispositions.some((row) =>
      row.evidence_id === unresolved.evidence_id
    )).toBe(false);

    expect(await controller.dispatch("reconcile_evidence_dispositions", {
      decisions: [{
        evidence_id: unresolved.evidence_id,
        disposition: "ignored",
        reason: "属于相邻目标，不在当前验收范围内",
      }],
    })).toMatchObject({
      ok: false,
      error: "evidence_must_be_opened_before_disposition",
    });

    await controller.dispatch("open_evidence", { evidence_id: unresolved.evidence_id });
    expect(await controller.dispatch("reconcile_evidence_dispositions", {
      decisions: [{
        evidence_id: unresolved.evidence_id,
        disposition: "ignored",
        reason: "属于相邻目标，不在当前验收范围内",
      }],
    })).toMatchObject({
      ok: true,
      complete: true,
      applied_decision_count: 1,
      unhandled_count: 0,
    });
    const reconciled = JSON.parse(
      await readFile(revision.workingPlanPath, "utf8"),
    ) as SemanticSourcePlan;
    expect(reconciled.evidence_dispositions).toContainEqual({
      evidence_id: unresolved.evidence_id,
      disposition: "ignored",
      item_ids: [],
      reason: "属于相邻目标，不在当前验收范围内",
    });
  });
});
