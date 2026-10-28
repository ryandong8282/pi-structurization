import { describe, expect, test } from "vitest";
import { observeSelectorBlockers, selectorBlockerObservations, selectorIssueProbes } from "../src/selector-blocker-progress.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import { runLengthContinuationLoop, type DurablePromptSnapshot } from "../src/pi-runtime.js";

const plan = () => ({ items: [
  { key: "blocked", fields: { method: { span_ids: ["span:a"], reason: "first" } } },
  { key: "other", fields: { method: { span_ids: ["span:b"], reason: "second" } } },
], references: [], sampling_rules: [], lots: [], source_dispositions: [] }) as unknown as TargetSelectorPlan;
const registry = { spans: [{ span_id: "span:a", evidence_id: "evidence:a", start: 0, end: 5, text_sha256: "a" }] } as SourceSpanRegistry;
const issue = { code: "field_binding_relation", path: "/items/0/fields/method/span_ids/0", next_tool: "locate_evidence_span",
  details: { actual: { evidence_id: "evidence:a" }, writable_paths: ["/items/0/fields/method", "/items"] } };

describe("selector blocker convergence", () => {
  test.each(["Response incomplete: max_messages", "Connection error.", "Request timed out."])(
    "%s observes the assigned blocker across fresh sessions without altering budgets", async error => {
      let history: ReturnType<typeof observeSelectorBlockers>["history"] | undefined;
      const blockers = [{ identity: "neutral-assigned-record", fingerprint: "same" }];
      const outcomes = [];
      let observed = 0;
      for (let session = 0; session < 3; session++) outcomes.push(await runLengthContinuationLoop({
        initialPrompt: "finish the assigned neutral record", continuationPrompt: "unused",
        promptRound: async () => ({ kind: "completed" }),
        lastAssistant: () => ({ stopReason: "error", errorMessage: error }),
        snapshot: async () => ({ checkpoint: "kept", working_plan_sha256: "kept", history_sequence: 19,
          last_valid_fingerprint: "", repair_work_issues: blockers }),
        observeBlockingProgress: async () => {
          observed++;
          const result = observeSelectorBlockers(history, blockers, blockers);
          history = result.history; return result;
        },
      }));
      expect(observed).toBe(3);
      expect(outcomes[0]!.error).toBe(error);
      expect(outcomes[2]!.error).toMatch(/^target_progress_stalled:/);
      expect(history!.blockers[0]!.unchanged_rounds).toBe(3);
    },
  );

  test.each(["failed", "throw", "cancel"])("%s records the exit exactly once", async exit => {
    let observed = 0;
    const abort = new AbortController();
    const failure = new Error("neutral interruption");
    const run = () => runLengthContinuationLoop({
      initialPrompt: "neutral", continuationPrompt: "unused", signal: abort.signal,
      promptRound: async () => {
        if (exit === "throw") throw failure;
        if (exit === "cancel") abort.abort(failure);
        return { kind: "failed", error: failure };
      },
      lastAssistant: () => undefined,
      snapshot: async () => ({ checkpoint: "same", working_plan_sha256: "same", history_sequence: 19, last_valid_fingerprint: "" }),
      observeBlockingProgress: async () => { observed++; return { progress: false, stalled: [] }; },
    });
    if (exit === "failed") expect((await run()).outcome).toMatchObject({ kind: "failed", error: failure });
    else await expect(run()).rejects.toBe(failure);
    expect(observed).toBe(1);
  });

  test("unrelated records, author reasons and confidence do not reset a blocking issue", () => {
    const original = plan(), probes = selectorIssueProbes([issue], original);
    const before = selectorBlockerObservations(probes, original, registry, new Set());
    const changed = structuredClone(original);
    changed.items[1]!.name = "changed elsewhere";
    changed.items[0]!.fields.method.reason = "rewritten explanation";
    const after = selectorBlockerObservations(probes, changed, registry, new Set());
    expect(after).toEqual(before);
    const first = observeSelectorBlockers(undefined, before, after);
    const resumed = observeSelectorBlockers(JSON.parse(JSON.stringify(first.history)), after, after);
    const third = observeSelectorBlockers(resumed.history, after, after);
    expect(first.progress).toBe(false);
    expect(third.stalled).toEqual([before[0]!.identity]);
  });

  test("necessary source reads and exact source locations are observable progress", () => {
    const selectors = plan(), probes = selectorIssueProbes([issue], selectors);
    const before = selectorBlockerObservations(probes, selectors, registry, new Set());
    const read = selectorBlockerObservations(probes, selectors, registry, new Set(["evidence:a"]));
    expect(observeSelectorBlockers(undefined, before, read).progress).toBe(true);
    const withSpan = { ...registry, spans: [...registry.spans, { ...registry.spans[0]!, span_id: "span:c", start: 1 }] };
    const located = selectorBlockerObservations(probes, selectors, withSpan, new Set(["evidence:a"]));
    expect(observeSelectorBlockers(undefined, read, located).progress).toBe(true);
    const unrelated = selectorBlockerObservations(probes, selectors, registry, new Set(["evidence:other"]));
    expect(unrelated).toEqual(before);
  });

  test("author keys survive reordering and an unvalidated repair cannot masquerade as convergence", () => {
    const selectors = plan(), probes = selectorIssueProbes([issue], selectors);
    const before = selectorBlockerObservations(probes, selectors, registry, new Set());
    const changed = structuredClone(selectors);
    changed.items.reverse();
    expect(selectorBlockerObservations(probes, changed, registry, new Set())).toEqual(before);
    changed.items[1]!.fields.method.span_ids = ["span:corrected"];
    const after = selectorBlockerObservations(probes, changed, registry, new Set());
    expect(after).toEqual(before);
    // The problem is resolved only when fresh validation removes it.
    expect(observeSelectorBlockers(undefined, before, [])).toMatchObject({ progress: true, stalled: [] });
  });

  test("newly disclosed issues do not hide a genuinely resolved existing issue", () => {
    const old = [{ identity: "old", fingerprint: "a" }];
    const result = observeSelectorBlockers(undefined, old, [{ identity: "new", fingerprint: "b" }]);
    expect(result.progress).toBe(true);
    expect(result.history.blockers[0]!.unchanged_rounds).toBe(0);
    expect(result.stalled).toEqual([]);
  });

  test("more failures in the same group cannot reset the unchanged counter; verified partial closure can", () => {
    const first = [{ identity: "group", fingerprint: "one", units: ["a"], source_work: [] }];
    const more = [{ identity: "group", fingerprint: "two", units: ["a", "b"], source_work: [] }];
    const growing = observeSelectorBlockers(undefined, first, more);
    expect(growing.progress).toBe(false);
    expect(growing.history.blockers[0]!.unchanged_rounds).toBe(1);
    const reduced = [{ identity: "group", fingerprint: "three", units: ["b"], source_work: [] }];
    expect(observeSelectorBlockers(growing.history, more, reduced)).toMatchObject({ progress: true, stalled: [] });
  });

  test("unassessed downstream obligations retain their counts without claiming progress or a new failed round", () => {
    const blocked = [{ identity: "old", fingerprint: "same", units: ["source:a"], source_work: [] }];
    const twice = observeSelectorBlockers(observeSelectorBlockers(undefined, blocked, blocked).history, blocked, blocked);
    const masked = [{ ...blocked[0]!, assessed: false }];
    const paused = observeSelectorBlockers(twice.history, blocked, masked);
    expect(paused).toMatchObject({ progress: false, stalled: [], history: { blockers: [{ unchanged_rounds: 2 }] } });
    const reconstructed = observeSelectorBlockers(JSON.parse(JSON.stringify(paused.history)), masked, masked);
    expect(reconstructed.history.blockers[0]?.unchanged_rounds).toBe(2);
    expect(observeSelectorBlockers(reconstructed.history, masked, blocked).stalled).toEqual(["old"]);
  });

  test("context-full restarts also persist and bound the same unresolved blocker", async () => {
    let history: ReturnType<typeof observeSelectorBlockers>["history"] | undefined;
    const blockers = [{ identity: "same", fingerprint: "same" }];
    const outcomes = [];
    for (let session = 0; session < 3; session++) {
      const current = { checkpoint: `${session}`, working_plan_sha256: `${session}`,
        history_sequence: session, last_valid_fingerprint: "", blocking_issues: blockers };
      outcomes.push(await runLengthContinuationLoop({
        initialPrompt: "resume", continuationPrompt: "unused",
        promptRound: async () => ({ kind: "repair_restart" }), lastAssistant: () => ({}), snapshot: async () => current,
        observeBlockingProgress: async (before, after) => {
          const observed = observeSelectorBlockers(history, before.blocking_issues!, after.blocking_issues!);
          history = observed.history; return observed;
        },
      }));
    }
    expect(outcomes[2]).toMatchObject({ outcome: { kind: "terminal_failure" }, error: expect.stringMatching(/^target_progress_stalled:/) });
  });

  test("fresh prompt loops retain blocker observations despite a changing whole-plan hash", async () => {
    let history: ReturnType<typeof observeSelectorBlockers>["history"] | undefined;
    let serial = 0;
    let current: DurablePromptSnapshot;
    const blockers = [{ identity: "same-blocker", fingerprint: "same-inputs" }];
    const snapshot = () => ({ checkpoint: `p${serial}`, working_plan_sha256: `p${serial}`,
      history_sequence: serial, last_valid_fingerprint: "", blocking_issues: blockers });
    const outcomes = [];
    for (let session = 0; session < 3; session++) {
      current = snapshot();
      let rounds = 0;
      const result = await runLengthContinuationLoop({
        initialPrompt: "resume", continuationPrompt: "continue",
        promptRound: async () => {
          if (rounds++) return { kind: "repair_restart" };
          serial++; current = snapshot(); return { kind: "completed" };
        },
        lastAssistant: () => ({ stopReason: "stop" }), snapshot: async () => current,
        shouldContinueAfterCompleted: async () => true,
        observeBlockingProgress: async (before, after) => {
          const observed = observeSelectorBlockers(history, before.blocking_issues!, after.blocking_issues!);
          history = JSON.parse(JSON.stringify(observed.history));
          return observed;
        },
      });
      outcomes.push(result);
    }
    expect(outcomes[0]!.error).toBe("");
    expect(outcomes[2]!.error).toMatch(/^target_progress_stalled:/);
    expect(history!.blockers[0]!.unchanged_rounds).toBe(3);
  });
});
