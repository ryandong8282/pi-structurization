import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { buildItemFieldBindings } from "../src/domain-contract.js";
import {
  COVERAGE_REVIEW_SCHEMA_VERSION,
  coverageMandatoryEvidenceIds,
  validateCoverageReview,
  type DomainCoverageReview,
} from "../src/coverage-review.js";

type GoldDisposition = {
  judgment_id: string;
  disposition: "acceptance_item" | "shared_context" | "irrelevant";
  exact_fragment: string;
  qualifier_field?: "method" | "quantity" | "note";
  applies_to_judgments?: string[];
};

type GoldCase = {
  id: string;
  standard: string;
  variant: string;
  equivalence_group: string;
  source_text: string;
  dispositions: GoldDisposition[];
};

type GoldFixture = {
  schema_version: "semantic-coverage-gold/v1";
  cases: GoldCase[];
};

type BindingMode = "by-judgment" | "merge-independent" | "split-inseparable";

const goldPath = resolve(
  "fixtures/gold/semantic-coverage-gold.json",
);

async function readGold(): Promise<GoldFixture> {
  return JSON.parse(await readFile(goldPath, "utf8")) as GoldFixture;
}

function scenario(gold: GoldCase, mode: BindingMode = "by-judgment"): {
  evidence: EvidenceManifest;
  plan: SemanticSourcePlan;
  review: DomainCoverageReview;
  planFingerprint: string;
} {
  const evidenceId = `atom:${gold.id}`;
  const evidenceFingerprint = sha256Text(`evidence:${gold.id}:${gold.source_text}`);
  const evidence: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: `gold:${gold.id}`,
    target_id: `target:${gold.id}`,
    source: {
      adapter: "document-domain-agent/v1",
      file_name: `${gold.id}.md`,
      sha256: sha256Text(gold.source_text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: "markdown-target-scope/v1",
      mode: "agent_discovered",
      target_id: `target:${gold.id}`,
      source_line_count: gold.source_text.split("\n").length,
      selected_start_line: 0,
      selected_end_exclusive_line: gold.source_text.split("\n").length,
      selected_heading: "",
      selection_reason: "Gold semantic scope; formatting is deliberately not authoritative.",
      selected_atom_ids: [evidenceId],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "context",
      locator: `char:0-${gold.source_text.length}`,
      text: gold.source_text,
      text_sha256: sha256Text(gold.source_text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: evidenceFingerprint,
  };

  const itemRows = gold.dispositions
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.disposition === "acceptance_item");
  const groupKey = ({ entry, index }: (typeof itemRows)[number]): string => {
    if (mode === "merge-independent") return "merged";
    if (mode === "split-inseparable") return `${entry.judgment_id}:${index}`;
    return entry.judgment_id;
  };
  const groups = new Map<string, typeof itemRows>();
  for (const row of itemRows) {
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const itemIdByDispositionIndex = new Map<number, string>();
  const acceptanceItems = [...groups.entries()].map(([key, rows], itemIndex) => {
    const itemId = `item:${itemIndex + 1}`;
    for (const row of rows) itemIdByDispositionIndex.set(row.index, itemId);
    const fragments = rows.map(({ entry }) => entry.exact_fragment);
    const requirement = fragments.join("；");
    const judgmentIds = new Set(rows.map(({ entry }) => entry.judgment_id));
    const qualifiers = gold.dispositions.filter((entry) =>
      entry.qualifier_field
      && entry.applies_to_judgments?.some((judgmentId) => judgmentIds.has(judgmentId))
    );
    const method = qualifiers
      .filter((entry) => entry.qualifier_field === "method")
      .map((entry) => entry.exact_fragment)
      .join("；");
    const quantity = qualifiers
      .filter((entry) => entry.qualifier_field === "quantity")
      .map((entry) => entry.exact_fragment)
      .join("；");
    const note = qualifiers
      .filter((entry) => entry.qualifier_field === "note")
      .map((entry) => entry.exact_fragment)
      .join("；");
    return {
      item_id: itemId,
      lot_id: "lot:gold",
      name: fragments[0]!,
      category: "一般项目" as const,
      requirement,
      method,
      quantity,
      note,
      evidence_ids: [evidenceId],
      reference_evidence_ids: [],
      field_bindings: buildItemFieldBindings({
        name: fragments[0]!,
        requirement,
        method,
        quantity,
        note,
      }, [evidenceId], evidence),
      sampling: {
        status: quantity ? "explicit" as const : "not_sampling" as const,
        min_sampling: quantity,
        script: quantity || "Gold case does not invent a sampling rule.",
        reason: quantity
          ? "The exact shared sampling qualifier applies to this independent judgment."
          : "Sampling meaning stays in its explicit semantic disposition.",
        confidence: 1,
        evidence_ids: quantity ? [evidenceId] : [],
      },
      _group_key: key,
    };
  }).map(({ _group_key: _unused, ...item }) => item);

  const plan: SemanticSourcePlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: evidence.job_id,
    target_id: evidence.target_id,
    evidence_fingerprint: evidenceFingerprint,
    table_assembly: {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidenceFingerprint,
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: acceptanceItems.length ? [{
      lot_id: "lot:gold",
      name: `${gold.standard} semantic gold`,
      evidence_ids: [],
      item_ids: acceptanceItems.map((item) => item.item_id),
    }] : [],
    acceptance_items: acceptanceItems,
    reference_resolutions: [],
    evidence_dispositions: [{
      evidence_id: evidenceId,
      disposition: acceptanceItems.length ? "used" : "context",
      item_ids: acceptanceItems.map((item) => item.item_id),
      reason: "Every business meaning is independently disposed by the semantic gold.",
    }],
    semantic_evidence: gold.dispositions.map((entry, index) => {
      const itemId = itemIdByDispositionIndex.get(index) ?? "";
      const firstForItem = itemId
        ? itemIdByDispositionIndex.get(
          gold.dispositions.findIndex((candidate, candidateIndex) =>
            candidateIndex <= index && itemIdByDispositionIndex.get(candidateIndex) === itemId
          ),
        ) === itemId
        : false;
      return {
        semantic_id: `semantic:${index + 1}`,
        role: entry.disposition === "acceptance_item"
          ? (firstForItem ? "acceptance_item" as const : "continuation" as const)
          : "acceptance_condition" as const,
        evidence_id: evidenceId,
        exact_fragment: entry.exact_fragment,
        parent_semantic_id: "",
        materialized_item_id: itemId,
        reason: `Gold disposition: ${entry.disposition}`,
      };
    }),
    semantic_references: [],
    shared_sampling_rules: [],
  };
  const planFingerprint = sha256Text(`plan:${gold.id}:${mode}`);
  const review: DomainCoverageReview = {
    schema_version: COVERAGE_REVIEW_SCHEMA_VERSION,
    plan_fingerprint: planFingerprint,
    evidence_fingerprint: evidenceFingerprint,
    status: "approved",
    semantic_coverage: acceptanceItems.map((item, itemIndex) => {
      const acceptanceIndexes = gold.dispositions.flatMap((entry, index) =>
        entry.disposition === "acceptance_item" && itemIdByDispositionIndex.get(index) === item.item_id
          ? [index]
          : []
      );
      const judgmentIds = new Set(acceptanceIndexes.map((index) => gold.dispositions[index]!.judgment_id));
      const bindings = gold.dispositions.flatMap((entry, index) => {
        const directlyBound = acceptanceIndexes.includes(index);
        const sharedQualifier = entry.applies_to_judgments?.some((judgmentId) => judgmentIds.has(judgmentId));
        return directlyBound || sharedQualifier
          ? [{ evidence_id: evidenceId, exact_fragment: entry.exact_fragment }]
          : [];
      });
      return {
        coverage_id: `coverage:leaf:${itemIndex + 1}`,
        disposition: "acceptance_item" as const,
        judgment_id: [...judgmentIds].sort().join("+"),
        item_ids: [item.item_id],
        evidence_bindings: bindings,
        reason: `Gold final-leaf assertion for ${gold.id}.`,
      };
    }),
    findings: [],
    summary: "Every proposition, shared condition, and irrelevant instruction has an exact disposition.",
  };
  const unboundContext = gold.dispositions.filter((entry) =>
    entry.disposition !== "acceptance_item" && !(entry.applies_to_judgments?.length)
  );
  if (unboundContext.length) {
    review.semantic_coverage.push({
      coverage_id: "coverage:unbound-primary-context",
      disposition: unboundContext.every((entry) => entry.disposition === "irrelevant") ? "irrelevant" : "shared_context",
      judgment_id: "",
      item_ids: [],
      evidence_bindings: unboundContext.map((entry) => ({ evidence_id: evidenceId, exact_fragment: entry.exact_fragment })),
      reason: "Primary meaning outside final leaves receives one grouped exact disposition.",
    });
  }
  return { evidence, plan, review, planFingerprint };
}

function openedReviewEvidence(review: DomainCoverageReview): Set<string> {
  return new Set(review.semantic_coverage.flatMap((entry) =>
    entry.evidence_bindings.map((binding) => binding.evidence_id)
  ));
}

describe("proposition-level semantic coverage gold", () => {
  test("mandatory set excludes navigation-only resources but includes actual bindings, registered dependencies, and reviewer promotions", async () => {
    const gold = await readGold();
    const { evidence, plan, review } = scenario(gold.cases[0]!);
    const optional = {
      ...evidence.evidence[0]!,
      evidence_id: "atom:optional-navigation",
      text: "可全文搜索的中性导航资源",
      text_sha256: sha256Text("可全文搜索的中性导航资源"),
      requires_disposition: false,
      evidence_scope: undefined,
    };
    const registered = {
      ...optional,
      evidence_id: "atom:registered-dependency",
      text: "已登记外部依赖",
      text_sha256: sha256Text("已登记外部依赖"),
      evidence_scope: "reference" as const,
      registered_dependency: true,
    };
    evidence.evidence.push(optional, registered);

    expect(coverageMandatoryEvidenceIds(evidence, plan)).toEqual([
      evidence.scope.selected_atom_ids![0],
      registered.evidence_id,
    ].sort());

    plan.acceptance_items[0]!.reference_evidence_ids.push(optional.evidence_id);
    expect(coverageMandatoryEvidenceIds(evidence, plan)).toContain(optional.evidence_id);

    plan.acceptance_items[0]!.reference_evidence_ids = [];
    review.semantic_coverage.push({
      coverage_id: "coverage:reviewer-promoted",
      disposition: "irrelevant",
      judgment_id: "",
      item_ids: [],
      evidence_bindings: [{ evidence_id: optional.evidence_id, exact_fragment: optional.text }],
      reason: "Reviewer searched and explicitly promoted this optional resource.",
    });
    expect(coverageMandatoryEvidenceIds(evidence, plan, review)).toContain(optional.evidence_id);
  });

  test("primary evidence stays mandatory even when requires_disposition is false", async () => {
    const gold = await readGold();
    const { evidence, plan } = scenario(gold.cases[0]!);
    evidence.evidence[0]!.requires_disposition = false;
    expect(coverageMandatoryEvidenceIds(evidence, plan)).toEqual([
      evidence.evidence[0]!.evidence_id,
    ]);
  });

  test("accepts complete evidence-bound dispositions across standards and damaged formats", async () => {
    const gold = await readGold();
    expect(gold.schema_version).toBe("semantic-coverage-gold/v1");
    for (const goldCase of gold.cases) {
      for (const disposition of goldCase.dispositions) {
        expect(goldCase.source_text).toContain(disposition.exact_fragment);
      }
      const { evidence, plan, review, planFingerprint } = scenario(goldCase);
      const validated = validateCoverageReview(
        review,
        planFingerprint,
        evidence,
        openedReviewEvidence(review),
        plan,
      );
      expect(validated.issues, goldCase.id).toEqual([]);
      expect(validated.ok, goldCase.id).toBe(true);
      expect(plan.acceptance_items, goldCase.id).toHaveLength(
        new Set(
          goldCase.dispositions
            .filter((entry) => entry.disposition === "acceptance_item")
            .map((entry) => entry.judgment_id),
        ).size,
      );
      expect(review.semantic_coverage.filter((entry) => entry.disposition === "acceptance_item"))
        .toHaveLength(plan.acceptance_items.length);
      for (const node of plan.semantic_evidence ?? []) {
        expect(review.semantic_coverage.some((entry) => entry.evidence_bindings.some((binding) =>
          binding.evidence_id === node.evidence_id && binding.exact_fragment === node.exact_fragment
        )), `${goldCase.id}: ${node.semantic_id}`).toBe(true);
      }
    }
  });

  test("keeps equivalent plain, OCR-broken, and table-serialized semantics equally discoverable", async () => {
    const gold = await readGold();
    const grouped = Map.groupBy(gold.cases, (entry) => entry.equivalence_group);
    for (const cases of grouped.values()) {
      if (cases.length < 2) continue;
      const counts = cases.map((entry) => scenario(entry).plan.acceptance_items.length);
      expect(new Set(counts).size, cases.map((entry) => entry.id).join(", ")).toBe(1);
    }
  });

  test("routes reviewer-detected independent-judgment merges as semantic repair", async () => {
    const gold = await readGold();
    for (const id of [
      "gb50576-5.2.5-human-review",
      "gb50576-10.3.3-human-review",
    ]) {
      const goldCase = gold.cases.find((entry) => entry.id === id)!;
      const { evidence, plan, review, planFingerprint } = scenario(
        goldCase,
        "merge-independent",
      );
      review.status = "repair";
      review.findings = [{
        finding_id: `finding:${id}`,
        finding_type: "semantic_coverage_gap",
        evidence_id: evidence.evidence[0]!.evidence_id,
        exact_fragment: goldCase.dispositions.find((entry) => entry.disposition === "acceptance_item")!.exact_fragment,
        affected_item_ids: [plan.acceptance_items[0]!.item_id],
        description: "Independent pass/fail judgments were merged into one final leaf.",
        reason: "Semantic independence is reviewer-owned and requests a bounded model repair.",
      }];
      const validated = validateCoverageReview(
        review,
        planFingerprint,
        evidence,
        openedReviewEvidence(review),
        plan,
      );
      expect(validated.issues, id).toEqual([]);
      expect(validated.review?.status, id).toBe("repair");
    }
  });

  test("rejects splitting two bounds of the same speed judgment into duplicate leaves", async () => {
    const gold = await readGold();
    const goldCase = gold.cases.find((entry) =>
      entry.id === "gb50310-4.11.9-one-measurement-two-bounds"
    )!;
    const { evidence, plan, review, planFingerprint } = scenario(
      goldCase,
      "split-inseparable",
    );
    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      openedReviewEvidence(review),
      plan,
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.map((issue) => issue.code))
      .toContain("coverage_review_judgment_split");
  });

  test("requires shared methods and sampling to remain bound to every leaf they qualify", async () => {
    const gold = await readGold();
    const goldCase = gold.cases.find((entry) =>
      entry.id === "gb50576-10.3.3-human-review"
    )!;
    const { evidence, plan, review, planFingerprint } = scenario(goldCase);
    const second = plan.acceptance_items[1]!;
    second.method = "";
    second.field_bindings = buildItemFieldBindings({
      name: second.name,
      requirement: second.requirement,
      method: "",
      quantity: second.quantity,
      note: second.note,
    }, second.evidence_ids, evidence);
    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      openedReviewEvidence(review),
      plan,
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.map((issue) => issue.code))
      .toContain("coverage_review_item_fragment_unbound");
  });

  test("an empty leaf review cannot approve a semantically incomplete plan", async () => {
    const gold = await readGold();
    const goldCase = gold.cases.find((entry) =>
      entry.id === "gb50576-10.3.3-human-review"
    )!;
    const { evidence, plan, review, planFingerprint } = scenario(goldCase);
    const incomplete = { ...review, semantic_coverage: [] };
    const validated = validateCoverageReview(
      incomplete,
      planFingerprint,
      evidence,
      openedReviewEvidence(review),
      plan,
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "coverage_review_uncovered_final_items",
      "coverage_review_candidate_semantic_gap",
    ]));
  });

  test("non-exact reviewer citations receive exact evidence repair candidates", async () => {
    const gold = await readGold();
    const goldCase = gold.cases[0]!;
    const { evidence, plan, review, planFingerprint } = scenario(goldCase);
    review.semantic_coverage[0]!.evidence_bindings[0]!.exact_fragment = "semantic paraphrase that is not source text";

    const validated = validateCoverageReview(
      review,
      planFingerprint,
      evidence,
      openedReviewEvidence(review),
      plan,
    );
    const issue = validated.issues.find((entry) =>
      entry.code === "coverage_review_semantic_fragment_not_exact"
    );
    expect(issue).toBeDefined();
    const details = issue!.details as {
      evidence_id: string;
      exact_fragment_candidates: string[];
    };
    expect(details.evidence_id).toBe(review.semantic_coverage[0]!.evidence_bindings[0]!.evidence_id);
    expect(details.exact_fragment_candidates.length).toBeGreaterThan(0);
    const source = evidence.evidence.find((entry) => entry.evidence_id === details.evidence_id)!.text;
    for (const candidate of details.exact_fragment_candidates) {
      expect(source).toContain(candidate);
    }
  });
});
