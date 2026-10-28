import { describe, expect, test } from "vitest";

import {
  compiledUnhandledEvidenceIds,
  evidenceEligibleForResidualDisposition,
  evidenceRequiresSelectorDisposition,
  selectorDispositionCoverage,
} from "../src/evidence-disposition-coverage.js";

const boundSpan = { span_id: "span:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", evidence_id: "ev-bound" };
const leftoverSpan = { span_id: "span:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", evidence_id: "ev-left" };
const headingSpan = { span_id: "span:cccccccccccccccccccccccccccccccc", evidence_id: "ev-heading" };

const evidence = [
  { evidence_id: "ev-bound", requires_disposition: true, evidence_scope: "primary" as const },
  { evidence_id: "ev-left", requires_disposition: true, evidence_scope: "primary" as const },
  { evidence_id: "ev-heading", requires_disposition: false, evidence_scope: "primary" as const },
  { evidence_id: "ev-ref", requires_disposition: false, evidence_scope: "reference" as const },
];

const selectors = {
  items: [{ criterion_span_ids: [boundSpan.span_id] }],
  source_dispositions: [] as Array<{ span_ids: string[]; disposition: "context"; reason: string }>,
  residual_source_dispositions: [] as Array<{ key: string; disposition: "context" | "ignored"; reason: string }>,
};

describe("selector disposition coverage", () => {
  test("nested typed-table paths count as business sources before residual context accounting", () => {
    const coverage = selectorDispositionCoverage({
      selectors: { items: [{ table: { properties: { row_path_span_ids: [[boundSpan.span_id]], column_path_span_ids: [[headingSpan.span_id]] } } }],
        source_dispositions: [], residual_source_dispositions: [{ key: "remaining", disposition: "context", reason: "只处置未采用来源" }] },
      evidence, spans: [boundSpan, leftoverSpan, headingSpan],
    });
    expect(coverage.bound_evidence_ids).toEqual(["ev-bound", "ev-heading"]);
    expect(coverage.residual_evidence_ids).toEqual(["ev-left"]);
    expect(coverage.uncovered_required_ids).toEqual([]);
  });

  test("required is requires_disposition; residual may also cover primary extras", () => {
    expect(evidence.filter(evidenceRequiresSelectorDisposition).map((row) => row.evidence_id))
      .toEqual(["ev-bound", "ev-left"]);
    expect(evidence.filter(evidenceEligibleForResidualDisposition).map((row) => row.evidence_id))
      .toEqual(["ev-bound", "ev-left", "ev-heading"]);
  });

  test("without residual, uncovered required matches compiled unhandled", () => {
    const coverage = selectorDispositionCoverage({
      selectors,
      evidence,
      spans: [boundSpan, leftoverSpan, headingSpan],
    });
    expect(coverage.bound_evidence_ids).toEqual(["ev-bound"]);
    expect(coverage.residual_evidence_ids).toEqual([]);
    expect(coverage.uncovered_required_ids).toEqual(["ev-left"]);
    expect(compiledUnhandledEvidenceIds({
      evidence_dispositions: coverage.bound_evidence_ids.map((evidence_id) => ({ evidence_id })),
    }, evidence)).toEqual(coverage.uncovered_required_ids);
  });

  test("residual covers leftover required and extra primary, not already-bound evidence", () => {
    const coverage = selectorDispositionCoverage({
      selectors: {
        ...selectors,
        residual_source_dispositions: [{ key: "rest", disposition: "context", reason: "剩余背景" }],
      },
      evidence,
      spans: [boundSpan, leftoverSpan, headingSpan],
    });
    expect(coverage.residual_evidence_ids).toEqual(["ev-left", "ev-heading"]);
    expect(coverage.uncovered_required_ids).toEqual([]);
    const compiledIds = [
      ...coverage.bound_evidence_ids,
      ...coverage.residual_evidence_ids,
    ].map((evidence_id) => ({ evidence_id }));
    expect(compiledUnhandledEvidenceIds({ evidence_dispositions: compiledIds }, evidence)).toEqual([]);
  });

  test("explicit source_dispositions count as bound; residual does not double-cover them", () => {
    const coverage = selectorDispositionCoverage({
      selectors: {
        ...selectors,
        source_dispositions: [{
          span_ids: [leftoverSpan.span_id],
          disposition: "ignored",
          reason: "逐条交代",
        }],
        residual_source_dispositions: [{ key: "rest", disposition: "context", reason: "剩余背景" }],
      },
      evidence,
      spans: [boundSpan, leftoverSpan, headingSpan],
    });
    expect(coverage.bound_evidence_ids).toEqual(["ev-bound", "ev-left"]);
    expect(coverage.residual_evidence_ids).toEqual(["ev-heading"]);
    expect(coverage.uncovered_required_ids).toEqual([]);
  });

  test("gate, compiler fill, and validator missing-ids agree on the same leftover set", () => {
    const draft = {
      ...selectors,
      residual_source_dispositions: [{ key: "rest", disposition: "ignored", reason: "一次交代" }],
    };
    const coverage = selectorDispositionCoverage({
      selectors: draft,
      evidence,
      spans: [boundSpan, leftoverSpan, headingSpan],
    });
    const compilerFilled = new Map<string, string>();
    for (const evidenceId of coverage.bound_evidence_ids) compilerFilled.set(evidenceId, "used");
    for (const evidenceId of coverage.residual_evidence_ids) {
      compilerFilled.set(evidenceId, coverage.residual!.disposition);
    }
    const validatorMissing = compiledUnhandledEvidenceIds({
      evidence_dispositions: [...compilerFilled.keys()].map((evidence_id) => ({ evidence_id })),
    }, evidence);
    expect(coverage.uncovered_required_ids).toEqual([]);
    expect(validatorMissing).toEqual(coverage.uncovered_required_ids);
    expect(compilerFilled.get("ev-left")).toBe("ignored");
    expect(compilerFilled.has("ev-bound")).toBe(true);
  });
});
