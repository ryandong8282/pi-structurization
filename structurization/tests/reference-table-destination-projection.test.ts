import { describe, expect, test } from "vitest";

import { projectReferencedTableDestinations } from "../src/reference-table-destination-projection.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";

const ANCHOR = `span:${"a".repeat(32)}`;
const OTHER_ANCHOR = `span:${"b".repeat(32)}`;
const TARGET = `span:${"c".repeat(32)}`;
const OTHER_TARGET = `span:${"d".repeat(32)}`;

function plan(overrides: {
  children?: Array<{
    key: string;
    reference_span_ids?: string[];
    property_span_ids?: string[];
    source_kind?: "reference" | "direct";
  }>;
  references?: Array<{
    key: string;
    application_mode?: "reference_only" | "reference_placeholder";
    anchor_span_ids?: string[];
    target_span_ids?: string[];
    destinations?: Array<{ item_key: string; target_field: "requirement" | "method" }>;
  }>;
} = {}): TargetSelectorPlan {
  return {
    items: (overrides.children ?? [{
      key: "weld-undercut",
      reference_span_ids: [ANCHOR],
      property_span_ids: [TARGET],
    }]).map((child) => ({
      key: child.key,
      table: {
        source_kind: child.source_kind ?? "reference",
        properties: { allowed_value_span_ids: child.property_span_ids ?? [TARGET] },
        reference_span_ids: child.reference_span_ids ?? [ANCHOR],
      },
    })),
    references: (overrides.references ?? [{
      key: "ref-weld",
      destinations: [{ item_key: "weld-quality", target_field: "requirement" as const }],
    }]).map((reference) => ({
      key: reference.key,
      application_mode: reference.application_mode ?? "reference_only",
      anchor_span_ids: reference.anchor_span_ids ?? [ANCHOR],
      target_span_ids: reference.target_span_ids ?? [TARGET],
      destinations: reference.destinations ?? [{ item_key: "weld-quality", target_field: "requirement" as const }],
    })),
  } as unknown as TargetSelectorPlan;
}

describe("projectReferencedTableDestinations", () => {
  test("copies the parent destination onto a uniquely matched referenced-table child", () => {
    const { plan: projected, added } = projectReferencedTableDestinations(plan());
    expect(added).toEqual([{
      reference_key: "ref-weld",
      reference_index: 0,
      item_key: "weld-undercut",
      target_field: "requirement",
    }]);
    expect(projected.references[0]!.destinations).toEqual([
      { item_key: "weld-quality", target_field: "requirement" },
      { item_key: "weld-undercut", target_field: "requirement" },
    ]);
  });

  test("is idempotent and does not invent a second destination", () => {
    const first = projectReferencedTableDestinations(plan());
    expect(projectReferencedTableDestinations(first.plan).added).toEqual([]);
  });

  test("skips placeholders and does not add destinations to them", () => {
    expect(projectReferencedTableDestinations(plan({
      references: [{
        key: "ref-placeholder",
        application_mode: "reference_placeholder",
        destinations: [],
      }],
    })).added).toEqual([]);
  });

  test("skips when two non-placeholder references share the same child anchors", () => {
    expect(projectReferencedTableDestinations(plan({
      references: [
        { key: "ref-hammer", destinations: [{ item_key: "hammer-weld-quality", target_field: "requirement" }] },
        { key: "ref-static", destinations: [{ item_key: "static-weld-quality", target_field: "requirement" }] },
      ],
    })).added).toEqual([]);
  });

  test("skips when the child's table cells do not overlap the reference targets", () => {
    expect(projectReferencedTableDestinations(plan({
      children: [{ key: "weld-undercut", property_span_ids: [OTHER_TARGET] }],
      references: [{
        key: "ref-other-table",
        anchor_span_ids: [ANCHOR],
        target_span_ids: [TARGET],
        destinations: [{ item_key: "weld-quality", target_field: "method" }],
      }],
    })).added).toEqual([]);
  });

  test("does not attach the wrong citation when only the parent row overlaps", () => {
    expect(projectReferencedTableDestinations(plan({
      children: [{
        key: "weld-undercut",
        reference_span_ids: [OTHER_ANCHOR],
        property_span_ids: [OTHER_TARGET],
      }],
    })).added).toEqual([]);
  });
});
