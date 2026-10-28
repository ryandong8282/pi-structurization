import { describe, expect, test } from "vitest";

import { autoRepairCoverageFragments } from "../src/coverage-review.js";

const EVIDENCE_LINE = "4.5.8 门扇与门扇、门扇与门套、门扇与门楣、门扇与门口处轿壁、门扇下端与地坎的间隙，乘客电梯不应大于 6mm，载货电梯不应大于 8mm。";
const TYPO_FRAGMENT = EVIDENCE_LINE.replace("门楣", "门楠");

function evidenceWith(text: string) {
  return {
    schema_version: "evidence-manifest/v1",
    evidence_fingerprint: "fp",
    evidence: [
      { evidence_id: "evidence:1", locator: "line:355", text },
    ],
  } as never;
}

function reviewWithFragment(fragment: string) {
  return {
    schema_version: "domain-coverage-review/v4",
    plan_fingerprint: "plan",
    evidence_fingerprint: "fp",
    status: "approved",
    summary: "s",
    semantic_coverage: [
      {
        coverage_id: "cov:1",
        disposition: "acceptance_item",
        judgment_id: "j",
        item_ids: ["item:1"],
        evidence_bindings: [{ evidence_id: "evidence:1", exact_fragment: fragment }],
        reason: "r",
      },
    ],
    findings: [],
  };
}

describe("autoRepairCoverageFragments", () => {
  test("heals a single-glyph slip against a unique evidence candidate", () => {
    const { value, repairs } = autoRepairCoverageFragments(
      reviewWithFragment(TYPO_FRAGMENT),
      evidenceWith(EVIDENCE_LINE),
    );
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      path: "/semantic_coverage/0/evidence_bindings/0/exact_fragment",
      evidence_id: "evidence:1",
      supplied_fragment: TYPO_FRAGMENT,
      applied_fragment: EVIDENCE_LINE,
    });
    const bindings = (value as ReturnType<typeof reviewWithFragment>)
      .semantic_coverage[0]!.evidence_bindings;
    expect(bindings[0]!.exact_fragment).toBe(EVIDENCE_LINE);
  });

  test("heals two-glyph slips but not three", () => {
    const twoDiff = EVIDENCE_LINE.replace("门楣", "门楠").replace("6mm", "7mm");
    const healed = autoRepairCoverageFragments(reviewWithFragment(twoDiff), evidenceWith(EVIDENCE_LINE));
    expect(healed.repairs).toHaveLength(1);

    const threeDiff = twoDiff.replace("8mm", "9mm");
    const refused = autoRepairCoverageFragments(reviewWithFragment(threeDiff), evidenceWith(EVIDENCE_LINE));
    expect(refused.repairs).toHaveLength(0);
    expect((refused.value as ReturnType<typeof reviewWithFragment>)
      .semantic_coverage[0]!.evidence_bindings[0]!.exact_fragment).toBe(threeDiff);
  });

  test("refuses length changes even with high similarity", () => {
    const shortened = TYPO_FRAGMENT.slice(0, -6);
    const { repairs, value } = autoRepairCoverageFragments(
      reviewWithFragment(shortened),
      evidenceWith(EVIDENCE_LINE),
    );
    expect(repairs).toHaveLength(0);
    expect((value as ReturnType<typeof reviewWithFragment>)
      .semantic_coverage[0]!.evidence_bindings[0]!.exact_fragment).toBe(shortened);
  });

  test("leaves already-exact fragments untouched", () => {
    const { repairs } = autoRepairCoverageFragments(
      reviewWithFragment(EVIDENCE_LINE),
      evidenceWith(EVIDENCE_LINE),
    );
    expect(repairs).toHaveLength(0);
  });

  test("repairs finding fragments the same way", () => {
    const review = reviewWithFragment(EVIDENCE_LINE) as Record<string, unknown>;
    review.findings = [
      {
        finding_id: "finding:1",
        finding_type: "semantic_coverage_gap",
        evidence_id: "evidence:1",
        exact_fragment: TYPO_FRAGMENT,
        affected_item_ids: ["item:1"],
        description: "d",
        reason: "r",
      },
    ];
    const { repairs, value } = autoRepairCoverageFragments(review, evidenceWith(EVIDENCE_LINE));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.path).toBe("/findings/0/exact_fragment");
    expect(((value as Record<string, unknown>).findings as Array<{ exact_fragment: string }>)[0]!
      .exact_fragment).toBe(EVIDENCE_LINE);
  });
});
