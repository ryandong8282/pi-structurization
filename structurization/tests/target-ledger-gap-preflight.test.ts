import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { atomicWriteJson } from "../src/atomic.js";
import { prettyJson } from "../src/canonical.js";
import type { PersistedSemanticSourcePlan } from "../src/contracts.js";
import { compileTargetSelectors } from "../src/target-selector-compiler.js";
import {
  buildSelectorStageScenario,
  clauseRecord,
  currentFingerprint,
  enterCommitStage,
  fullSpanFor,
  itemRecord,
  seedPlan,
} from "./selector-stage-fixture.js";

const modelReviewIssues = (receipt: Record<string, unknown>): any[] =>
  (receipt.model_review as { observations?: any[] } | undefined)?.observations ?? [];

describe("model-owned ledger clause coverage observations", () => {
  test.each([
    { name: "spanning two windows", ranges: [{ start_line: 5, end_exclusive_line: 10 }], missing: ["2.1.1", "2.1.2"] },
    { name: "disjoint source ranges", ranges: [{ start_line: 5, end_exclusive_line: 6 }, { start_line: 9, end_exclusive_line: 10 }], missing: ["2.1.1"] },
    { name: "a primary range without required clauses", ranges: [{ start_line: 9, end_exclusive_line: 10 }], missing: [] },
  ])("confirmed scope controls required clauses when $name", async ({ ranges, missing }) => {
    const { workspace, controller, manifest, ledger, target } = await buildSelectorStageScenario();
    const window = ledger.windows.find(row => row.window_id === target.ledger_window_id) ?? ledger.windows[0]!;
    // The discovery anchor still identifies the first window after the author
    // confirms a broader or disjoint primary scope.
    ledger.windows.push({ ...window, window_id: "window:second", start_line: 7, end_exclusive_line: 10, extractable_clause_ids: ["2.1.2"] });
    window.end_exclusive_line = 7;
    window.extractable_clause_ids = ["2.1.1"];
    await atomicWriteJson(workspace.documentLedgerPath, ledger);
    controller.evidence.scope.primary_source_ranges = ranges;
    const c13 = clauseRecord(manifest, "2.1.3");
    const registry = await workspace.readSourceSpanRegistry();
    const compiled = compileTargetSelectors(seedPlan(manifest, fullSpanFor(registry, c13.evidence_id, c13.text.length)), registry, manifest);
    const issues = await (controller as unknown as {
      targetLedgerRequiredClauseIssues: (plan: PersistedSemanticSourcePlan, fingerprint: string) => Promise<Array<{ details: { missing_clause_ids: string[] } }>>;
    }).targetLedgerRequiredClauseIssues(compiled, "neutral-scope-check");
    expect(issues.flatMap(issue => issue.details.missing_clause_ids)).toEqual(missing);
  });

  test("commit keeps an actionable model observation when a quantity clause has no anchored item", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const receipt = JSON.stringify(commit);
    const issues = modelReviewIssues(commit);
    const gapIssue = issues.find((issue) => issue.code === "selector_ledger_required_clause_gap");
    expect(commit, receipt).toMatchObject({ ok: true, model_review: { blocking: false, decision_owner: "model" } });
    expect(gapIssue, receipt).toBeDefined();
    const missing = gapIssue?.details?.missing_clause_ids ?? [];
    expect(missing).toContain("2.1.1");
    expect(missing).toContain("2.1.2");
    // 回条必须携带可直接执行的修复配方，否则模型会停留在原地反复重交（实测 GB 50202
    // run 20260921-040934-6dd7 三个 target 收到缺口回条后空转 get_target_context 循环）。
    expect(gapIssue?.how_to_pass).toContain("criterion_span_ids");
    expect(gapIssue?.how_to_pass).toContain("2.1.1");
    expect(gapIssue?.next_tool).toBe("read_target_selectors");
  });

  test("anchoring one clause narrows the gap precisely instead of looping", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    const c11 = clauseRecord(manifest, "2.1.1");
    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c11.evidence_id })).toMatchObject({ ok: true });
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span11 = fullSpanFor(registry, c11.evidence_id, c11.text.length);
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    const selectors = seedPlan(manifest, span13);
    selectors.items.push(itemRecord(
      "item-2.1.1",
      "桩身承载力",
      "主控项目",
      span11,
      "数量条文以锚定条目承载归属。",
    ));
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const issues = modelReviewIssues(commit);
    const gapIssue = issues.find((issue) => issue.code === "selector_ledger_required_clause_gap");
    expect(gapIssue, JSON.stringify(commit)).toBeDefined();
    // 已锚定的 2.1.1 不再出现：回条精确指向仍缺失的条文，模型不需要重试已修复部分。
    expect(gapIssue?.details?.missing_clause_ids).toEqual(["2.1.2"]);
  });

  test("a resolved table pointer with real receivers covers its parent clause without inventing an item", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    const pointer = clauseRecord(manifest, "2.1.1");
    const item = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: item.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const compiled = compileTargetSelectors(
      seedPlan(manifest, fullSpanFor(registry, item.evidence_id, item.text.length)),
      registry,
      manifest,
    );
    controller.evidence.reference_occurrences.push({
      occurrence_id: "synthetic-table-reference",
      origin_evidence_id: pointer.evidence_id,
    } as typeof controller.evidence.reference_occurrences[number]);
    compiled.reference_resolutions.push({
      occurrence_id: "synthetic-table-reference",
      origin_evidence_id: pointer.evidence_id,
      application_mode: "reference_only",
      target_evidence_ids: [item.evidence_id],
      destination_bindings: [{ item_id: compiled.acceptance_items[0]!.item_id, target_field: "requirement" }],
    } as PersistedSemanticSourcePlan["reference_resolutions"][number]);
    const check = async () => (controller as unknown as {
      targetLedgerRequiredClauseIssues: (plan: PersistedSemanticSourcePlan, fingerprint: string) => Promise<Array<{
        code: string;
        details: { missing_clause_ids: string[] };
      }>>;
    }).targetLedgerRequiredClauseIssues(compiled, "synthetic-fingerprint");
    expect((await check())[0]?.details.missing_clause_ids).toEqual(["2.1.2"]);
    compiled.reference_resolutions[0]!.destination_bindings = [];
    expect((await check())[0]?.details.missing_clause_ids).toEqual(["2.1.1", "2.1.2"]);
  });

  test("anchoring every required clause clears the gate", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    const c11 = clauseRecord(manifest, "2.1.1");
    const c12 = clauseRecord(manifest, "2.1.2");
    const c13 = clauseRecord(manifest, "2.1.3");
    for (const record of [c11, c12, c13]) {
      expect(await controller.dispatch("open_evidence", { evidence_id: record.evidence_id })).toMatchObject({ ok: true });
    }
    const registry = await workspace.readSourceSpanRegistry();
    const span11 = fullSpanFor(registry, c11.evidence_id, c11.text.length);
    const span12 = fullSpanFor(registry, c12.evidence_id, c12.text.length);
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    const selectors = seedPlan(manifest, span13);
    selectors.items.push(
      itemRecord("item-2.1.1", "桩身承载力", "主控项目", span11, "数量条文以锚定条目承载归属。"),
      itemRecord("item-2.1.2", "桩身完整性", "主控项目", span12, "数量条文以锚定条目承载归属。"),
    );
    await workspace.writeWorkingSelectors(prettyJson(selectors));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const receipt = JSON.stringify(commit);
    expect(receipt).not.toContain("selector_ledger_required_clause_gap");
  });

  test("required clauses outside the target's own work scope belong to sibling targets", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    // 已确认的主资料范围只剩 2.1.3 一行：窗口内其余必抽条文
    // （2.1.1/2.1.2）属于拆分出的兄弟 target，本 target 的闸门不得对它们报警。
    const batchPath = workspace.batchTargetPath;
    const batch = JSON.parse(await readFile(batchPath, "utf8")) as { targets: Array<Record<string, unknown>> };
    batch.targets[0]!.start_line = 9;
    batch.targets[0]!.end_exclusive_line = 10;
    await atomicWriteJson(batchPath, batch);
    controller.evidence.scope.primary_source_ranges = [{ start_line: 9, end_exclusive_line: 10 }];

    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const receipt = JSON.stringify(commit);
    expect(receipt).not.toContain("selector_ledger_required_clause_gap");
  });

  test("a clause introducing sibling tables is charged to the target owning its opening line", async () => {
    const { workspace, controller, manifest, ledger } = await buildSelectorStageScenario();
    const leadingClause = ledger.clauses.find((clause) => clause.clause_id === "2.1.1");
    if (!leadingClause) throw new Error("Missing leading fixture clause");
    // The leading clause spans both siblings' table ranges, while this target's
    // confirmed primary range starts at the second table. Its opening line belongs
    // to the first sibling; 2.1.2 opens inside this target and remains actionable.
    leadingClause.end_exclusive_line = 10;
    await atomicWriteJson(workspace.documentLedgerPath, ledger);
    controller.evidence.scope.primary_source_ranges = [{ start_line: 7, end_exclusive_line: 10 }];

    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const issues = modelReviewIssues(commit);
    const gapIssue = issues.find((issue) => issue.code === "selector_ledger_required_clause_gap");
    expect(gapIssue, JSON.stringify(commit)).toBeDefined();
    expect(gapIssue?.details?.missing_clause_ids).toEqual(["2.1.2"]);
  });

  test("legacy line ranges also assign a spanning clause by its opening line", async () => {
    const { workspace, controller, manifest, ledger } = await buildSelectorStageScenario();
    const leadingClause = ledger.clauses.find((clause) => clause.clause_id === "2.1.1");
    if (!leadingClause) throw new Error("Missing leading fixture clause");
    leadingClause.end_exclusive_line = 10;
    await atomicWriteJson(workspace.documentLedgerPath, ledger);
    const batchPath = workspace.batchTargetPath;
    const batch = JSON.parse(await readFile(batchPath, "utf8")) as { targets: Array<Record<string, unknown>> };
    batch.targets[0]!.start_line = 7;
    batch.targets[0]!.end_exclusive_line = 10;
    await atomicWriteJson(batchPath, batch);
    delete controller.evidence.scope.primary_source_ranges;

    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const issues = modelReviewIssues(commit);
    const gapIssue = issues.find((issue) => issue.code === "selector_ledger_required_clause_gap");
    expect(gapIssue, JSON.stringify(commit)).toBeDefined();
    expect(gapIssue?.details?.missing_clause_ids).toEqual(["2.1.2"]);
  });

  test("confirmed primary ranges do not assign a clause in a gap between fragments", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    // The broad target envelope includes all three clauses; the confirmed
    // primary fragments deliberately exclude the middle clause's opening line.
    controller.evidence.scope.primary_source_ranges = [
      { start_line: 5, end_exclusive_line: 7 },
      { start_line: 9, end_exclusive_line: 10 },
    ];
    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    await enterCommitStage(workspace);
    const commit = await controller.dispatch("commit_target_selector_draft", {
      draft_fingerprint: await currentFingerprint(controller),
    });
    const issues = modelReviewIssues(commit);
    const gapIssue = issues.find((issue) => issue.code === "selector_ledger_required_clause_gap");
    expect(gapIssue, JSON.stringify(commit)).toBeDefined();
    expect(gapIssue?.details?.missing_clause_ids).toEqual(["2.1.1"]);
  });
});
