import { describe, expect, test, vi } from "vitest";

import { CoverageReviewController, createCoverageReviewTools } from "../src/coverage-review.js";
import { createPiTools, ToolController } from "../src/tools.js";

const targetKey = `reference-target:${"a".repeat(64)}`;

describe("reference catalog tool abort signal", () => {
  test("target controller propagates caller abort instead of wrapping it as tool_rejected", async () => {
    const caller = new AbortController();
    const reason = new Error("target job stopped");
    const appendEvent = vi.fn(async () => {
      if (!caller.signal.aborted) caller.abort(reason);
    });
    const receiver = { workspace: { appendEvent } };

    await expect(ToolController.prototype.dispatch.call(
      receiver as never,
      "unknown_test_tool",
      {},
      "target-abort",
      caller.signal,
    )).rejects.toBe(reason);
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  test("coverage controller propagates caller abort instead of wrapping it as tool_rejected", async () => {
    const caller = new AbortController();
    const reason = new Error("coverage job stopped");
    const appendEvent = vi.fn(async () => {
      if (!caller.signal.aborted) caller.abort(reason);
    });
    const receiver = { appendEvent };

    await expect(CoverageReviewController.prototype.dispatch.call(
      receiver as never,
      "unknown_test_tool",
      {},
      caller.signal,
    )).rejects.toBe(reason);
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  test("passes the SDK signal through the target read_reference_facts tool", async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "reference_analysis_not_sealed" })
      .mockResolvedValueOnce({ ok: true });
    const ensureReferenceFacts = vi.fn(async () => ({ ok: true }));
    const controller = { usesSelectorCompiler: true, dispatch } as unknown as ToolController;
    const tool = createPiTools(controller, { ensureReferenceFacts }).find((candidate) => candidate.name === "read_reference_facts")!;
    const caller = new AbortController();

    await tool.execute("target-call", { target_key: targetKey }, caller.signal, undefined, undefined as never);

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "read_reference_facts",
      { target_key: targetKey },
      "target-call",
      caller.signal,
    );
    expect(ensureReferenceFacts).toHaveBeenCalledWith(targetKey, caller.signal);
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "read_reference_facts",
      { target_key: targetKey },
      "target-call",
      caller.signal,
    );
  });

  test("passes the SDK signal through the coverage read_reference_facts tool", async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "reference_analysis_not_sealed" })
      .mockResolvedValueOnce({ ok: true });
    const ensureReferenceFacts = vi.fn(async () => ({ ok: true }));
    const controller = { dispatch } as unknown as CoverageReviewController;
    const tool = createCoverageReviewTools(controller, { ensureReferenceFacts }).find((candidate) => candidate.name === "read_reference_facts")!;
    const caller = new AbortController();

    await tool.execute("coverage-call", { target_key: targetKey }, caller.signal, undefined, undefined as never);

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "read_reference_facts",
      { target_key: targetKey },
      caller.signal,
    );
    expect(ensureReferenceFacts).toHaveBeenCalledWith(targetKey, caller.signal);
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "read_reference_facts",
      { target_key: targetKey },
      caller.signal,
    );
  });
});
