import { describe, expect, test } from "vitest";

import {
  materializeCoverageSpanBindings,
  validateCoverageReview,
} from "../src/coverage-review.js";
import {
  initialSourceSpanRegistry,
  registerSourceSpan,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import type { EvidenceManifest } from "../src/contracts.js";

const TEXT = "4.5.8 门扇与门扇、门扇与门套、门扇与门楣、门扇与门口处轿壁、门扇下端与地坎的间隙，乘客电梯不应大于 6mm，载货电梯不应大于 8mm。";
const FRAG = "4.5.8 门扇与门扇、门扇与门套、门扇与门楣、门扇与门口处轿壁、门扇下端与地坎的间隙，乘客电梯不应大于 6mm，载货电梯不应大于 8mm。".slice(0, 40);

function fixture() {
  const evidence = {
    schema_version: "evidence-manifest/v1",
    evidence_fingerprint: "fp",
    evidence: [
      { evidence_id: "evidence:1", kind: "clause", role: "primary", locator: "line:355", text: TEXT, text_sha256: "x", requires_disposition: true },
      { evidence_id: "evidence:2", kind: "clause", role: "primary", locator: "line:571", text: "另一条证据原文。", text_sha256: "y", requires_disposition: true },
    ],
  } as unknown as EvidenceManifest;
  let registry: SourceSpanRegistry = initialSourceSpanRegistry("fp");
  const start = TEXT.indexOf(FRAG);
  const registered = registerSourceSpan(registry, {
    source_id: "evidence:1",
    text: TEXT,
    evidence_id: "evidence:1",
    atom_id: "evidence:1",
  }, start, start + FRAG.length);
  registry = registered.registry;
  return { evidence, registry, spanId: registered.span.span_id };
}

function reviewWith(binding: Record<string, unknown>) {
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
        evidence_bindings: [binding],
        reason: "r",
      },
    ],
    findings: [],
  };
}

describe("materializeCoverageSpanBindings", () => {
  test("materializes exact_fragment from span offsets; model never retypes", () => {
    const { evidence, registry, spanId } = fixture();
    const { value, issues, materialized } = materializeCoverageSpanBindings(
      reviewWith({ evidence_id: "evidence:1", span_id: spanId }),
      evidence,
      registry,
    );
    expect(issues).toHaveLength(0);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({ span_id: spanId, evidence_id: "evidence:1", exact_fragment: FRAG });
    const binding = (value as ReturnType<typeof reviewWithFragment>).semantic_coverage[0]!.evidence_bindings[0]!;
    expect(binding.exact_fragment).toBe(FRAG);
    expect(binding.span_id).toBe(spanId);
  });

  test("rejects span from a different evidence resource", () => {
    const { evidence, registry, spanId } = fixture();
    const { issues } = materializeCoverageSpanBindings(
      reviewWith({ evidence_id: "evidence:2", span_id: spanId }),
      evidence,
      registry,
    );
    expect(issues.map((issue) => issue.code)).toContain("coverage_review_span_evidence_mismatch");
  });

  test("rejects unknown span ids", () => {
    const { evidence, registry } = fixture();
    const { issues } = materializeCoverageSpanBindings(
      reviewWith({ evidence_id: "evidence:1", span_id: "span:00000000000000000000000000000000" }),
      evidence,
      registry,
    );
    expect(issues.map((issue) => issue.code)).toContain("coverage_review_unknown_span");
  });

  test("span bindings without a registry raise an explicit issue", () => {
    const { evidence, spanId } = fixture();
    const { issues } = materializeCoverageSpanBindings(
      reviewWith({ evidence_id: "evidence:1", span_id: spanId }),
      evidence,
      undefined,
    );
    expect(issues.map((issue) => issue.code)).toContain("coverage_review_span_registry_unavailable");
  });

  test("legacy exact-fragment bindings pass through untouched", () => {
    const { evidence, registry } = fixture();
    const legacy = reviewWith({ evidence_id: "evidence:1", exact_fragment: FRAG });
    const { value, issues, materialized } = materializeCoverageSpanBindings(legacy, evidence, registry);
    expect(issues).toHaveLength(0);
    expect(materialized).toHaveLength(0);
    expect((value as ReturnType<typeof reviewWithFragment>).semantic_coverage[0]!.evidence_bindings[0]!
      .exact_fragment).toBe(FRAG);
  });

  test("finding-level span_id materializes too", () => {
    const { evidence, registry, spanId } = fixture();
    const review = reviewWith({ evidence_id: "evidence:1", exact_fragment: FRAG }) as Record<string, unknown>;
    review.findings = [{
      finding_id: "finding:1",
      finding_type: "semantic_coverage_gap",
      evidence_id: "evidence:1",
      span_id: spanId,
      affected_item_ids: ["item:1"],
      description: "d",
      reason: "r",
    }];
    const { value, issues } = materializeCoverageSpanBindings(review, evidence, registry);
    expect(issues).toHaveLength(0);
    expect(((value as Record<string, unknown>).findings as Array<{ exact_fragment: string }>)[0]!
      .exact_fragment).toBe(FRAG);
  });
});

describe("validateCoverageReview span consistency", () => {
  function validateWith(binding: Record<string, unknown>, registry: SourceSpanRegistry | undefined, evidence: EvidenceManifest) {
    return validateCoverageReview(reviewWith(binding), "plan", evidence, undefined, undefined, undefined, registry);
  }

  test("consistent span binding raises no span issue", () => {
    const { evidence, registry, spanId } = fixture();
    const result = validateWith({ evidence_id: "evidence:1", exact_fragment: FRAG, span_id: spanId }, registry, evidence);
    expect(result.issues.filter((issue) => issue.code.startsWith("coverage_review_span"))).toHaveLength(0);
  });

  test("tampered fragment contradicting the span is rejected", () => {
    const { evidence, registry, spanId } = fixture();
    const tampered = `${FRAG.slice(0, -1)}X`;
    const result = validateWith({ evidence_id: "evidence:1", exact_fragment: tampered, span_id: spanId }, registry, evidence);
    expect(result.issues.map((issue) => issue.code)).toContain("coverage_review_span_fragment_mismatch");
  });

  test("span citing another evidence is rejected", () => {
    const { evidence, registry, spanId } = fixture();
    const result = validateWith({ evidence_id: "evidence:2", exact_fragment: FRAG, span_id: spanId }, registry, evidence);
    expect(result.issues.map((issue) => issue.code)).toContain("coverage_review_span_evidence_mismatch");
  });
});
