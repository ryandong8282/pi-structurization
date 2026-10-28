import { describe, expect, it } from "vitest";

import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest, SemanticSourcePlanV8 } from "../src/contracts.js";
import { createPlanSourceResolver } from "../src/plan-source-resolver.js";
import { sourceSpanIdFor } from "../src/source-span-registry.js";

function fixture() {
  const evidenceId = "atom:source";
  const text = "前缀精确片段后缀";
  const start = text.indexOf("精确片段");
  const end = start + "精确片段".length;
  const textSha256 = sha256Text(text.slice(start, end));
  const spanId = sourceSpanIdFor(evidenceId, start, end, textSha256);
  const manifest = {
    evidence_fingerprint: "f".repeat(64),
    evidence: [{ evidence_id: evidenceId, text }],
  } as unknown as EvidenceManifest;
  const plan = {
    schema_version: "semantic-source-plan/v8",
    evidence_fingerprint: manifest.evidence_fingerprint,
    source_spans: [{
      span_id: spanId,
      evidence_id: evidenceId,
      start,
      end,
      text_sha256: textSha256,
    }],
  } as unknown as SemanticSourcePlanV8;
  return { manifest, plan, spanId };
}

describe("compact plan source resolver", () => {
  it("resolves registered offsets without searching source text", () => {
    const { manifest, plan, spanId } = fixture();
    const issues: Array<{ code: string }> = [];
    const resolved = createPlanSourceResolver(plan, manifest).resolve(spanId, "/binding", issues);

    expect(issues).toEqual([]);
    expect(resolved).toMatchObject({
      span_id: spanId,
      evidence_id: "atom:source",
      text: "精确片段",
    });
  });

  it("rejects hash, coordinate, ID, and catalog corruption deterministically", () => {
    const cases: Array<[string, (plan: SemanticSourcePlanV8) => void, string]> = [
      ["hash", (plan) => { plan.source_spans[0]!.text_sha256 = "0".repeat(64); }, "plan_span_hash_mismatch"],
      ["bounds", (plan) => { plan.source_spans[0]!.end = 999; }, "plan_span_out_of_bounds"],
      ["id", (plan) => { plan.source_spans[0]!.span_id = `span:${"0".repeat(32)}`; }, "plan_span_id_mismatch"],
      ["duplicate", (plan) => { plan.source_spans.push({ ...plan.source_spans[0]! }); }, "plan_span_id_duplicate"],
    ];

    for (const [, corrupt, expectedCode] of cases) {
      const { manifest, plan } = fixture();
      corrupt(plan);
      const requested = plan.source_spans[0]!.span_id;
      const issues: Array<{ code: string }> = [];
      expect(createPlanSourceResolver(plan, manifest).resolve(requested, "/binding", issues)).toBeUndefined();
      expect(issues.map((issue) => issue.code)).toContain(expectedCode);
    }
  });

  it("does not fall back to an unknown or malformed handle", () => {
    const { manifest, plan } = fixture();
    const resolver = createPlanSourceResolver(plan, manifest);
    const issues: Array<{ code: string }> = [];

    resolver.resolve("span:not-a-hash", "/bad", issues);
    resolver.resolve(`span:${"1".repeat(32)}`, "/missing", issues);

    expect(issues.map((issue) => issue.code)).toEqual([
      "plan_span_id_format",
      "plan_unknown_span",
    ]);
  });
});
