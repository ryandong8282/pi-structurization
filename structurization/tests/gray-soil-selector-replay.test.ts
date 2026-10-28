import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize, sha256Text } from "../src/canonical.js";
import {
  migrateTargetSelectorPlanForAuthoring,
  targetSelectorFingerprint,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gray-soil-selector-failure-v1");

async function json<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, ...parts), "utf8")) as T;
}

describe("gray-soil selector failure replay fixture", () => {
  it("preserves the two archived v1 pre-validation selector fingerprints", async () => {
    const fixture = await json<{ attempts: Array<{ attempt: number; selector_fingerprint: string }> }>("fixture.json");
    for (const expected of fixture.attempts.filter((entry) => entry.attempt < 3)) {
      const selector = await json<TargetSelectorPlan>(`attempt-${expected.attempt}`, "selector.json");
      expect(targetSelectorFingerprint(selector)).toBe(expected.selector_fingerprint);
    }
  });

  it("surfaces an actionable v2 authoring migration without rewriting the archived fixture", async () => {
    const selector = await json<TargetSelectorPlan>("attempt-3", "selector.json");
    const originalSource = canonicalize(selector);
    const originalFingerprint = targetSelectorFingerprint(selector);
    const first = migrateTargetSelectorPlanForAuthoring(selector);
    const second = migrateTargetSelectorPlanForAuthoring(selector);

    expect(canonicalize(selector)).toBe(originalSource);
    expect(targetSelectorFingerprint(selector)).toBe(originalFingerprint);
    expect((selector as unknown as { schema_version: string }).schema_version).toBe("target-selector-plan/v2");
    expect(canonicalize(second)).toBe(canonicalize(first));
    expect(sha256Text(canonicalize(second))).toBe(sha256Text(canonicalize(first)));
    expect(first).toMatchObject({
      source_schema_version: "target-selector-plan/v2",
      migrated: true,
      plan: { schema_version: "target-selector-plan/v6" },
      issues: [expect.objectContaining({
        code: "selector_sampling_component_migration_required",
        path: "/sampling_rules/0/branches/0/components",
        details: expect.objectContaining({
          missing_roles: ["applicability", "acceptance_criterion", "exception", "note"],
          required_action: "stage_explicit_sampling_component_dispositions",
        }),
      })],
    });
  });
});
