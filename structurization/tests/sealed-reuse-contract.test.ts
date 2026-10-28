import { chmod, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { sealedWorkspaceSatisfiesCurrentContract } from "../src/batch.js";
import { sha256Text } from "../src/canonical.js";
import { targetSelectorFingerprint } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, enterCommitStage, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

test("reuse honors a valid direct seal with unresolved clause ownership and still rejects altered business output", async () => {
  const { workspace, manifest } = await buildSelectorStageScenario([
    "# 2 虚构标定盒", "", "## 2.1 主控项目", "",
    "2.1.1 室内型标定盒接缝应牢固。检验方法：观察检查。", "",
    "2.1.2 室外型标定盒接缝应牢固。检验方法：观察检查。", "",
  ].join("\n"));
  const registry = await workspace.readSourceSpanRegistry();
  const spans = ["2.1.1", "2.1.2"].map(id => {
    const source = clauseRecord(manifest, id);
    return fullSpanFor(registry, source.evidence_id, source.text.length);
  });
  const draft = seedPlan(manifest, spans[0]!);
  draft.items = [itemRecord("joint", "接缝牢固性", "主控项目", spans[0]!, "同一虚构属性的两种条件。")];
  draft.items[0]!.criterion_span_ids = spans;
  draft.items[0]!.fields.requirement = { composition: "verbatim", span_ids: spans, separator: "\n", reason: "保留两种条件，不由程序选择单一条文归属。" };
  await workspace.writeWorkingSelectors(JSON.stringify(draft));
  await enterCommitStage(workspace);
  const controller = await ToolController.create(workspace);
  for (const source of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: source.evidence_id });
  const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: targetSelectorFingerprint(draft) });
  expect(committed).toMatchObject({ ok: true, model_review: { observations: expect.arrayContaining([
    expect.objectContaining({ code: "selector_source_clause_unresolved" }),
  ]) } });
  expect(await controller.dispatch("seal_validated_plan", { fingerprint: (await workspace.readState()).last_valid_fingerprint })).toMatchObject({ ok: true });
  const resultText = await readFile(workspace.resultPath, "utf8"), manifestText = await readFile(workspace.manifestPath, "utf8");
  const result = JSON.parse(resultText), stateBefore = await workspace.readState();
  expect(result.inspection_lots[0].items[0]).toMatchObject({ source_clause: "", source_anchors: expect.arrayContaining([
    expect.objectContaining({ line: 5 }), expect.objectContaining({ line: 7 }),
  ]) });
  expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(true);
  expect(await workspace.readState()).toEqual(stateBefore);
  expect(await readFile(workspace.resultPath, "utf8")).toBe(resultText);
  expect(await readFile(workspace.manifestPath, "utf8")).toBe(manifestText);

  // Choosing a clause in the materialized output is not an author decision.
  // Updating the file hash alone must not make that fabricated choice reusable.
  const altered = structuredClone(result);
  altered.inspection_lots[0].items[0].source_clause = "2.1.1";
  const alteredText = JSON.stringify(altered), alteredManifest = JSON.parse(manifestText);
  alteredManifest.fingerprints.files["result.json"] = sha256Text(alteredText);
  await chmod(workspace.resultPath, 0o644);
  await chmod(workspace.manifestPath, 0o644);
  await writeFile(workspace.resultPath, alteredText, "utf8");
  await writeFile(workspace.manifestPath, JSON.stringify(alteredManifest), "utf8");
  expect(await sealedWorkspaceSatisfiesCurrentContract(workspace)).toBe(false);
});
