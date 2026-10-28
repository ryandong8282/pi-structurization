import { describe, expect, test } from "vitest";

import { groupTableCandidatesByFragment } from "../src/target-selector-compiler.js";

describe("table candidate physical-fragment grouping", () => {
  test("coalesces row-level table keys that share one physical fragment", () => {
    const groups = groupTableCandidatesByFragment([
      { tableKey: "table-4-4-4-bearing", fragmentIds: ["table-fragment:line-452"] },
      { tableKey: "table-4-4-4-strength", fragmentIds: ["table-fragment:line-452"] },
      { tableKey: "table-4-4-4-elongation", fragmentIds: ["table-fragment:line-452"] },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((candidate) => candidate.tableKey)).toEqual([
      "table-4-4-4-bearing",
      "table-4-4-4-strength",
      "table-4-4-4-elongation",
    ]);
  });

  test("merges transitive fragment overlaps without joining unrelated tables", () => {
    const groups = groupTableCandidatesByFragment([
      { tableKey: "continued-a", fragmentIds: ["fragment-1"] },
      { tableKey: "other", fragmentIds: ["fragment-9"] },
      { tableKey: "continued-b", fragmentIds: ["fragment-1", "fragment-2"] },
      { tableKey: "continued-c", fragmentIds: ["fragment-2"] },
      { tableKey: "semantic-only", fragmentIds: [] },
    ]);

    expect(groups.map((group) => group.map((candidate) => candidate.tableKey))).toEqual([
      ["continued-a", "continued-b", "continued-c"],
      ["other"],
      ["semantic-only"],
    ]);
  });
});
