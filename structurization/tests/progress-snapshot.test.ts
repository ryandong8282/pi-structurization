import { describe, expect, test } from "vitest";

import {
  coverageRepairProgressSnapshot,
  recordProgressRound,
} from "../src/progress-snapshot.js";

describe("coverage repair progress is the red-pen list, not the internal numbering", () => {
  test("the first review never stops the target", () => {
    const snapshot = coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-a",
      judgment_ids: ["gap-1", "gap-2"],
      finding_ids: ["f-1", "f-2"],
    });
    const recorded = recordProgressRound(undefined, snapshot);
    expect(recorded.stop).toBe(false);
    expect(recorded.reason).toBe("first_round");
    expect(recorded.window.consecutive_unchanged).toBe(1);
  });

  test("the same homework and the same red pens on the next review stop immediately", () => {
    const snapshot = coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-a",
      judgment_ids: ["gap-1"],
      finding_ids: ["f-1"],
    });
    const first = recordProgressRound(undefined, snapshot);
    const second = recordProgressRound(first.window, snapshot);
    expect(second.stop).toBe(true);
    expect(second.reason).toBe("identical_snapshot");
  });

  test("changing only the draft numbering is not progress when the red pens stay put", () => {
    // This is the coverage-repair hole: each save mints a new plan fingerprint /
    // structure hash while the same gaps come back. Continuing the transaction
    // must not treat that as a new chance.
    const first = recordProgressRound(undefined, coverageRepairProgressSnapshot({
      structure_fingerprint: "after-save-1",
      judgment_ids: ["gap-wiring", "gap-termination"],
      finding_ids: ["f-a"],
    }));
    const second = recordProgressRound(first.window, coverageRepairProgressSnapshot({
      structure_fingerprint: "after-save-2",
      judgment_ids: ["gap-termination", "gap-wiring"],
      finding_ids: ["f-b", "f-c"],
    }));
    expect(second.stop).toBe(true);
    expect(second.reason).toBe("marks_unchanged");
  });

  test("knocking out a finding resets the stall counter", () => {
    const first = recordProgressRound(undefined, coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-1",
      judgment_ids: ["gap-1", "gap-2"],
      finding_ids: [],
    }));
    const second = recordProgressRound(first.window, coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-2",
      judgment_ids: ["gap-1"],
      finding_ids: [],
    }));
    expect(second.stop).toBe(false);
    expect(second.reason).toBe("marks_changed");
    expect(second.window.consecutive_unchanged).toBe(1);

    const third = recordProgressRound(second.window, coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-3",
      judgment_ids: ["gap-1"],
      finding_ids: [],
    }));
    expect(third.stop).toBe(true);
    expect(third.reason).toBe("marks_unchanged");
  });

  test("when judgment identities are missing, finding ids are the red-pen list", () => {
    const first = recordProgressRound(undefined, coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-1",
      judgment_ids: [],
      finding_ids: ["f-1", "f-2"],
    }));
    const second = recordProgressRound(first.window, coverageRepairProgressSnapshot({
      structure_fingerprint: "draft-2",
      judgment_ids: [],
      finding_ids: ["f-2", "f-1"],
    }));
    expect(second.stop).toBe(true);
    expect(second.reason).toBe("marks_unchanged");
  });
});
