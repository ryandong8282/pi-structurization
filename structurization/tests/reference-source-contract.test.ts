import { describe, expect, test } from "vitest";
import type { EvidenceManifest } from "../src/contracts.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import { registeredDocumentReferenceReceiptIssues, type TargetSelectorPlan } from "../src/target-selector-compiler.js";

describe("reference literal display intervals", () => {
  const registry = { spans: [
    { span_id: "whole", evidence_id: "source", start: 0, end: 40 },
    { span_id: "literal", evidence_id: "source", start: 10, end: 20 },
    { span_id: "other-occurrence", evidence_id: "source", start: 60, end: 70 },
  ] } as SourceSpanRegistry;
  const manifest = { reference_occurrences: [{ occurrence_id: "ref", reference_literal_span_id: "literal", status: "resolved", target_evidence_ids: [] }], table_fragments: [], evidence: [], scope: { reference_candidates: [] } } as unknown as EvidenceManifest;
  const issuesFor = (fields: Record<string, { composition: string; span_ids: string[] }>) => {
    const completeFields = { ...Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, { composition: "not_applicable", span_ids: [] }])), ...fields };
    const selectors = { items: [{ key: "leaf", criterion_span_ids: [], continuation_span_ids: [], fields: completeFields }], references: [] } as unknown as TargetSelectorPlan;
    return registeredDocumentReferenceReceiptIssues(selectors, manifest, registry).filter(issue => issue.code === "selector_reference_literal_display_duplicate");
  };
  test("reports the two actual intervals, without altering either provenance or content", () => {
    const fields = { requirement: { composition: "verbatim", span_ids: ["whole", "literal"] } };
    const before = structuredClone(fields);
    expect(issuesFor(fields)).toMatchObject([{ details: { actual: { duplicates: [{ literal: { start: 10, end: 20 }, bindings: [
      { span_id: "whole", path: "/items/0/fields/requirement/span_ids/0" },
      { span_id: "literal", path: "/items/0/fields/requirement/span_ids/1" },
    ] }] } } }]);
    expect(fields).toEqual(before);
  });
  test("does not equate separate source occurrences or different visible fields", () => {
    expect(issuesFor({ requirement: { composition: "verbatim", span_ids: ["whole", "other-occurrence"] } })).toEqual([]);
    expect(issuesFor({ requirement: { composition: "verbatim", span_ids: ["whole"] }, note: { composition: "verbatim", span_ids: ["literal"] } })).toEqual([]);
  });
  test("does not treat name-summary provenance as concatenated display text", () => {
    expect(issuesFor({ name: { composition: "semantic_summary", span_ids: ["whole", "literal"] } })).toEqual([]);
  });
});
