import { describe, expect, test } from "vitest";

import {
  actionableIssue,
  catchToolReject,
  fingerprintMismatchReject,
  toolReject,
} from "../src/actionable-error.js";

describe("actionable error contract", () => {
  test("toolReject keeps the instruction the model must follow", () => {
    const reject = toolReject({
      error: "selector_correction_not_available",
      terminal: true,
      instruction: "This revision already used its selector correction. Do not retry the commit. Seal a validated draft or open a new revision.",
    });
    expect(reject).toMatchObject({
      ok: false,
      error: "selector_correction_not_available",
      instruction: expect.stringContaining("Do not retry"),
    });
  });

  test("toolReject rejects an empty instruction at runtime", () => {
    expect(() => toolReject({ error: "x", instruction: "   " })).toThrow(/instruction/);
  });

  test("actionableIssue keeps the writable path and next action", () => {
    const issue = actionableIssue({
      code: "reference_resolution_missing",
      path: "/reference_resolutions",
      message: "Author the occurrence on selectors.references; reference_resolutions is compiler-derived.",
      details: {
        required_action: "Add a selectors.references entry for this occurrence_id",
        writable_collection: "references",
        not_writable: "/reference_resolutions",
        next_tool: "read_reference_facts",
      },
    });
    expect(issue.details.writable_collection).toBe("references");
    expect(issue.details.not_writable).toBe("/reference_resolutions");
    expect(issue.details.required_action).toContain("selectors.references");
  });

  test("catchToolReject keeps the thrown message for repair", () => {
    const reject = catchToolReject(new Error("Unexpected token } in JSON at position 1"), "target_tool_rejected");
    expect(reject).toMatchObject({
      ok: false,
      error: "target_tool_rejected",
      actual_error: "Unexpected token } in JSON at position 1",
      required_action: "inspect_actual_error_and_owner_before_recovery",
    });
    expect(reject.instruction).toMatch(/actual_error/);
  });

  test("fingerprintMismatchReject sends submitted and expected values", () => {
    const reject = fingerprintMismatchReject({
      error: "Candidate fingerprint does not match the latest successful validation",
      submitted: "abc",
      expected: "def",
      validate_tool: "compile_target_selectors",
    });
    expect(reject).toMatchObject({
      ok: false,
      actual_fingerprint: "abc",
      expected_fingerprint: "def",
      candidate_read_tool: "compile_target_selectors",
    });
    expect(reject.instruction).toMatch(/abc/);
    expect(reject.instruction).toMatch(/def/);
    expect(reject.instruction).toMatch(/compile_target_selectors/);
  });

  test("actionableIssue rejects an empty required_action at runtime", () => {
    expect(() => actionableIssue({
      code: "x",
      path: "/y",
      message: "z",
      details: { required_action: "" },
    })).toThrow(/required_action/);
  });
});
