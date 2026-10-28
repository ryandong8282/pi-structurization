import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { atomicWriteJson } from "../src/atomic.js";
import { prettyJson, sha256Json } from "../src/canonical.js";
import { protocolTargetFailure, targetBlockerFailureClass } from "../src/attempt-budget.js";
import { buildSelectorStageScenario, clauseRecord, currentFingerprint, enterCommitStage, fullSpanFor, seedPlan } from "./selector-stage-fixture.js";

async function scenario(retainLegacyGap = true) {
  const f = await buildSelectorStageScenario();
  for (const id of ["2.1.1", "2.1.2", "2.1.3"]) {
    await f.controller.dispatch("open_evidence", { evidence_id: clauseRecord(f.manifest, id).evidence_id });
  }
  const registry = await f.workspace.readSourceSpanRegistry();
  const span = (id: string) => {
    const record = clauseRecord(f.manifest, id);
    return fullSpanFor(registry, record.evidence_id, record.text.length);
  };
  const selectors = seedPlan(f.manifest, span("2.1.3"));
  await f.workspace.writeWorkingSelectors(prettyJson(selectors));
  await atomicWriteJson(join(dirname(f.workspace.documentLedgerPath), "document-target-plan.json"), {
    targets: [{ target_id: f.manifest.target_id, semantic_basis: {
      subject: "试成桩工序", boundary_reason: "本对象仅处理试成桩，承载力和完整性为其他检测对象。",
    } }],
  });
  await enterCommitStage(f.workspace);
  const current = await (f.controller as any).evaluateTargetSelectorPreflight(selectors, false, false);
  expect(current).toMatchObject({ ok: true, response: { model_review: { blocking: false, decision_owner: "model" } } });
  const gaps = current.response.model_review.observations.filter((issue: any) => issue.code === "selector_ledger_required_clause_gap");
  expect(gaps.length).toBeGreaterThan(0);
  // Replay the historical blocking receipt explicitly. New plans expose the same
  // ledger facts as model observations, which cannot certify a mechanical gap.
  const preflight = retainLegacyGap ? { ...current, ok: false, issues: gaps, issue_count: gaps.length,
    issue_fingerprint: sha256Json(gaps) } : current;
  (f.controller as any).submittedPreflight = { draft_fingerprint: await currentFingerprint(f.controller),
    evidence_fingerprint: f.manifest.evidence_fingerprint, result: preflight };
  const input = { kind: "frozen_scope_conflict", preflight_issue_fingerprint: preflight.issue_fingerprint,
    evidence_span_ids: [span("2.1.1")], affected_selector_paths: ["/items"],
    explanation: "冻结对象为试成桩，当前缺口原文规定承载力检测；请核对发现阶段的对象归属。" };
  return { ...f, selectors, span, input };
}

describe("frozen scope conflict escalation", () => {
  test("a new model-only ledger observation does not certify a mechanical frozen-scope blocker", async () => {
    const f = await scenario(false);
    expect(await f.controller.dispatch("report_target_blocker", f.input)).toMatchObject({
      ok: false, terminal: false, error: "frozen_scope_conflict_unverified", budget_consumed: false,
    });
    expect(await readFile(f.workspace.transcriptPath, "utf8")).not.toContain('"event_type":"frozen_scope_conflict_reported"');
  });
  test("a direct-validation gap can be reported without a nonexistent coverage review", async () => {
    const f = await scenario();
    const before = await readFile(f.workspace.workingSelectorPath, "utf8");
    const reply = await f.controller.dispatch("report_target_blocker", f.input);
    expect(reply).toMatchObject({ ok: false, terminal: true, error: "target_scope_conflict_requires_review",
      blocker_code: "frozen_scope_conflict", coverage_satisfied: false, semantic_conflict_verified: false,
      report: { missing_clauses: expect.arrayContaining([expect.objectContaining({ clause_id: "2.1.1" })]),
        frozen_semantic_basis: { subject: "试成桩工序" } } });
    expect(await readFile(f.workspace.workingSelectorPath, "utf8")).toBe(before);
    expect(await readFile(f.workspace.transcriptPath, "utf8")).toContain("frozen_scope_conflict_reported");
    expect((await f.workspace.readState()).last_valid_fingerprint).toBeFalsy();
    expect(targetBlockerFailureClass(reply.blocker_code)).toBe("coverage_harness_defect");
    expect(protocolTargetFailure(String(reply.error))).toMatchObject({ retryable: false });
  });

  test.each(["stale_issue", "unrelated_evidence", "wrong_path", "changed_draft", "missing_frozen_basis"])("rejects %s without terminating or saving a report", async mode => {
    const f = await scenario();
    const input = { ...f.input };
    if (mode === "stale_issue") input.preflight_issue_fingerprint = "old-preflight";
    if (mode === "unrelated_evidence") input.evidence_span_ids = [f.span("2.1.3")];
    if (mode === "wrong_path") input.affected_selector_paths = ["/items/0"];
    if (mode === "changed_draft") {
      f.selectors.items[0]!.reason = "草稿已经更新，必须重新预检。";
      await f.workspace.writeWorkingSelectors(prettyJson(f.selectors));
    }
    if (mode === "missing_frozen_basis") await atomicWriteJson(join(dirname(f.workspace.documentLedgerPath), "document-target-plan.json"), { targets: [] });
    const reply = await f.controller.dispatch("report_target_blocker", input);
    expect(reply).toMatchObject({ ok: false, terminal: false, budget_consumed: false, error: "frozen_scope_conflict_unverified" });
    if (mode === "missing_frozen_basis") expect(reply).toMatchObject({ recovery_available: false, writable_paths: [], next_tool: null });
    else expect(reply).toMatchObject({ next_tool: expect.any(String) });
    expect(await readFile(f.workspace.transcriptPath, "utf8")).not.toContain('"event_type":"frozen_scope_conflict_reported"');
    if (mode === "changed_draft") expect(reply).toMatchObject({ next_tool: "commit_target_selector_draft", next_tool_arguments: { draft_fingerprint: await currentFingerprint(f.controller) } });
  });

  test("a legacy protocol cannot bypass verification through the new blocker kind", async () => {
    const f = await scenario();
    delete f.controller.evidence.source.semantic_workflow;
    expect(await f.controller.dispatch("report_target_blocker", f.input)).toMatchObject({
      ok: false, terminal: false, budget_consumed: false, error: "frozen_scope_conflict_unverified",
      recovery_available: false, writable_paths: [], next_tool: null,
    });
    expect(await readFile(f.workspace.transcriptPath, "utf8")).not.toContain('"event_type":"frozen_scope_conflict_reported"');
    expect(await readFile(f.workspace.transcriptPath, "utf8")).not.toContain('"event_type":"target_selector_blocker"');
  });
});
