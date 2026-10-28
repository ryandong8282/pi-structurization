import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  validateCoverageReview,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import type { EvidenceManifest } from "../src/contracts.js";
import { validatePlanText } from "../src/validator.js";

interface ReplayCase {
  targetId: string;
  fingerprint: string;
  findingId: string;
}

const cases: ReplayCase[] = [
  {
    targetId: "056505dae2e7e713c865f3fe",
    fingerprint: "21c104e0a1b1a3d4c3f2e21181b5d63f90a1decc28f678c2e8ae2c79ba407390",
    findingId: "finding:thread_requirement_duplicate",
  },
  {
    targetId: "10e47131ae64394bf79f6a03",
    fingerprint: "6f6427401b7030c7ab6556dd8b54134d320be4f0c766f114794e23ad43f243c0",
    findingId: "finding:gap-10.2.4-merged-dimensions-and-thread-protection",
  },
];

describe("official coverage owner replays", () => {
  for (const replay of cases) {
    const revisionRoot = resolve(
      `data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A${replay.targetId}/revisions/000002`,
    );
    const reviewPath = resolve(
      revisionRoot,
      "coverage-review",
      replay.fingerprint,
      "coverage-review.json",
    );
    test.runIf(existsSync(reviewPath))(
      `routes ${replay.targetId} plan-authorized or un-authored content to semantic repair`,
      () => {
        const evidence = JSON.parse(readFileSync(
          resolve(revisionRoot, "evidence/evidence.json"),
          "utf8",
        )) as EvidenceManifest;
        const planText = readFileSync(
          resolve(revisionRoot, "last-valid.semantic-source-plan.json"),
          "utf8",
        );
        const planValidation = validatePlanText(planText, evidence);
        expect(planValidation.ok).toBe(true);
        const review = JSON.parse(readFileSync(reviewPath, "utf8")) as DomainCoverageReview;
        const normalized = validateCoverageReview(
          review,
          replay.fingerprint,
          evidence,
          undefined,
          planValidation.plan,
        );

        expect(normalized.ok).toBe(true);
        expect(normalized.review?.findings.find((finding) =>
          finding.finding_id === replay.findingId
        )?.finding_type).toBe("semantic_coverage_gap");
        expect(normalized.review?.status).toBe("repair");
      },
    );
  }
});
