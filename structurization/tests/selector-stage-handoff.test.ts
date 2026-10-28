import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { prettyJson } from "../src/canonical.js";
import { UNLABELED_ITEM_CATEGORY } from "../src/contracts.js";
import { targetContinuationPatchPolicy, targetSelectorStagePrompt, targetSelectorStartupPrompt } from "../src/pi-runtime.js";
import { ToolController } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, seedPlan } from "./selector-stage-fixture.js";

describe("selector stage handoff contract", () => {
  test("resume names the whole target objective and audits the applicable tool limit", () => {
    const prompt = targetSelectorStartupPrompt({ job_id: "neutral", target_id: "target:neutral",
      resume: true, recovering_coverage_failure: false, current_selector_state: "current_existing" });
    expect(prompt).toContain("继续整个 target");
    expect(prompt).toContain("完整 commit 通过后直接 seal");
    expect(targetContinuationPatchPolicy(true)).toEqual({ patch_limit_source: "stage_target_selector_draft_tool_contract" });
    expect(targetContinuationPatchPolicy(true)).not.toHaveProperty("max_changed_items_per_patch");
    expect(targetContinuationPatchPolicy(false)).toEqual({ max_changed_items_per_patch: 4 });
  });

  test("a table checkpoint still accepts a source-grounded item revision without changing other records or budgets", async () => {
    const { workspace, manifest } = await buildSelectorStageScenario();
    const evidence = clauseRecord(manifest, "2.1.3");
    const registry = await workspace.readSourceSpanRegistry();
    const span = fullSpanFor(registry, evidence.evidence_id, evidence.text.length);
    const selectors = seedPlan(manifest, span);
    selectors.items[0]!.category = UNLABELED_ITEM_CATEGORY;
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await workspace.updateState(state => { state.selector_stage = "table"; });
    const controller = await ToolController.create(workspace);
    const stage = controller.selectorProviderPolicy().stage;
    expect(stage).toBe("table");
    expect(targetSelectorStagePrompt(stage)).toContain("不限制原合同允许的先前遗漏修订");
    expect(targetSelectorStagePrompt(stage)).toContain("完整验证及封存");
    await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id, cursor: 0 });
    await controller.dispatch("read_target_selectors", { collection: "items", key: selectors.items[0]!.key });
    const before = await workspace.readState();
    const revised = { ...selectors.items[0]!, name: "桩基试成桩", reason: "依据原文明确本项受检对象，保留其他字段。" };
    const saved = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert", collection: "items", draft: { items: [revised] },
    });
    expect(saved).toMatchObject({ ok: true, budget_consumed: false, global_candidate_complete: false,
      local_validation: { ok: true } });
    const after = await workspace.readState();
    expect(after.selector_stage).toBe("table");
    expect(after.selector_protocol).toEqual(before.selector_protocol);
    expect(after.validation_attempts).toBe(before.validation_attempts);
    expect(after.opened_evidence_ids).toEqual(before.opened_evidence_ids);
    expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")))
      .toEqual({ ...selectors, items: [revised] });
  });
});
