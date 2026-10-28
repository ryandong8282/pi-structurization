import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import type {
  AcceptanceItemPlan,
  EvidenceManifest,
  MaterializedAcceptanceItem,
  PersistedSemanticSourcePlan,
  SemanticSourcePlan,
} from "../src/contracts.js";
import { normalizePlanAuthorizedCompilerFindings } from "../src/coverage-finding-ownership.js";
import {
  type DomainCoverageReview,
  validateCoverageReview,
} from "../src/coverage-review.js";
import { materialize } from "../src/materializer.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";

const evidenceId = "atom:table";
const exactRow = "<tr><td>selected row</td><td>+5</td></tr>";
const wholeTable = `<table>${exactRow}<tr><td>sibling row</td><td>2</td></tr></table>`;

function candidateItem(requirement: string, fragments = [wholeTable]): AcceptanceItemPlan {
  const binding = (value: string, sourceFragments: string[] = []) => ({
    status: "bound" as const,
    composition: "verbatim" as const,
    evidence_ids: sourceFragments.length ? [evidenceId] : [],
    source_fragments: sourceFragments.map((text) => ({ evidence_id: evidenceId, text })),
    value_sha256: sha256Text(value),
    reason: "test binding",
  });
  return {
    item_id: "item:1",
    lot_id: "lot:1",
    name: "selected row",
    category: "一般项目",
    requirement,
    method: "measure",
    quantity: "all",
    note: "",
    evidence_ids: [evidenceId],
    reference_evidence_ids: [],
    table_semantics: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "test",
    inspection_data_type_evidence_ids: [evidenceId],
    field_bindings: {
      name: binding("selected row", ["selected row"]),
      requirement: binding(requirement, fragments),
      method: binding("measure", ["measure"]),
      quantity: binding("all", ["all"]),
      note: {
        status: "not_applicable",
        composition: "not_applicable",
        evidence_ids: [],
        source_fragments: [],
        value_sha256: sha256Text(""),
        reason: "not applicable",
      },
    },
    sampling: {
      status: "not_sampling",
      min_sampling: "",
      script: "灰显",
      reason: "test",
      confidence: 1,
      evidence_ids: [],
      rule_ids: [],
      branch_ids: [],
      applied_branches: [],
    },
  };
}

function plan(item: AcceptanceItemPlan): SemanticSourcePlan {
  return {
    schema_version: "semantic-source-plan/v6",
    job_id: "job:1",
    target_id: "target:1",
    evidence_fingerprint: "evidence",
    table_assembly: { schema_version: "table-assembly-plan/v1", tables: [], fragment_dispositions: [] },
    inspection_lots: [{ lot_id: "lot:1", name: "lot", evidence_ids: [evidenceId], item_ids: [item.item_id] }],
    acceptance_items: [item],
    reference_resolutions: [],
    evidence_dispositions: [],
    semantic_evidence: [],
    semantic_references: [],
    shared_sampling_rules: [],
  } as SemanticSourcePlan;
}

function materialized(requirement: string): MaterializedAcceptanceItem {
  return {
    item_id: "item:1",
    name: "selected row",
    category: "一般项目",
    requirement,
    method: "measure",
    quantity: "all",
    note: "",
    evidence_ids: [evidenceId],
    reference_evidence_ids: [],
    reference_resolution_ids: [],
    reference_origin_item_id: "item:1",
    reference_path: [],
    source_clause: "",
    reference_source_clause: "",
    reference_from_clause: "",
    table_semantics: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "test",
    inspection_data_type_evidence_ids: [evidenceId],
    sampling: {
      status: "not_sampling",
      min_sampling: "",
      script: "灰显",
      reason: "test",
      confidence: 1,
      evidence_ids: [],
      rule_ids: [],
      branch_ids: [],
      applied_branches: [],
    },
  };
}

function crossBranchSampling(): AcceptanceItemPlan["sampling"] {
  return {
    status: "reference",
    min_sampling: "branch A; branch B",
    script: "run branch A\nrun branch B",
    reason: "both branches were selected by the semantic plan",
    confidence: 1,
    evidence_ids: [evidenceId],
    rule_ids: ["sampling:1"],
    branch_ids: ["branch:a", "branch:b"],
    applied_branches: ["a", "b"].map((key) => ({
      rule_id: "sampling:1",
      branch_id: `branch:${key}`,
      min_sampling: `branch ${key.toUpperCase()}`,
      script: `run branch ${key.toUpperCase()}`,
      conditions: [{
        condition_id: `condition:${key}`,
        text: `condition ${key.toUpperCase()}`,
        evidence_id: evidenceId,
        exact_fragment: `condition ${key.toUpperCase()}`,
      }],
      evidence_ids: [evidenceId],
      components: [],
    })),
  };
}

function compilerFinding(): Record<string, unknown> {
  return {
    findings: [{
      finding_id: "finding:1",
      finding_type: "compiler_materialization_defect",
      evidence_id: evidenceId,
      exact_fragment: exactRow,
      affected_item_ids: ["item:1"],
      description: "The final field includes sibling content.",
      reason: "Reported as a materializer defect.",
    }],
  };
}

describe("coverage finding ownership", () => {
  test("routes plan-authorized field content to semantic repair", () => {
    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(candidateItem(wholeTable)),
      [materialized(wholeTable)],
    );

    expect(result.changed).toBe(true);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
    ]);
  });

  test("keeps a narrow compiled field that drifts during materialization as a harness defect", () => {
    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(candidateItem("+5", [exactRow])),
      [materialized(wholeTable)],
    );

    expect(result.changed).toBe(false);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "compiler_materialization_defect" }),
    ]);
  });

  test("keeps a compiled table projection drift as a harness defect", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    sourceItem.table_semantics = {
      source_kind: "direct",
      table_id: "table:1",
      table_no: "table 1",
      table_title: "selected criteria",
      applicability: "selected scope",
      row_path: ["selected row"],
      column_path: [],
      unit: "mm",
      condition: "",
      allowed_value: "+5",
      inspection_method: "measure",
      cell_evidence: [
        { role: "row_header", evidence_id: evidenceId, text: "selected row" },
        { role: "allowed_value", evidence_id: evidenceId, text: "+5" },
      ],
      reference_fragments: [],
    };
    const finalItem = materialized("+5");
    finalItem.table_semantics = { ...sourceItem.table_semantics, allowed_value: "2" };

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(sourceItem),
      [finalItem],
    );

    expect(result.changed).toBe(false);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "compiler_materialization_defect" }),
    ]);
  });

  test("routes plan-authorized cross-branch sampling to semantic repair", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    sourceItem.sampling = crossBranchSampling();
    const finalItem = materialized("+5");
    finalItem.sampling = structuredClone(sourceItem.sampling);
    finalItem.sampling.script = "";
    finalItem.sampling.applied_branches?.forEach((branch) => { branch.script = ""; });

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(sourceItem),
      [finalItem],
    );

    expect(result.changed).toBe(true);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
    ]);
  });

  test("keeps a sampling branch drift as a harness defect", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    sourceItem.sampling = crossBranchSampling();
    const finalItem = materialized("+5");
    finalItem.sampling = structuredClone(sourceItem.sampling);
    finalItem.sampling.script = "";
    finalItem.sampling.applied_branches?.forEach((branch) => { branch.script = ""; });
    finalItem.sampling.applied_branches = finalItem.sampling.applied_branches?.slice(0, 1);

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(sourceItem),
      [finalItem],
    );

    expect(result.changed).toBe(false);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "compiler_materialization_defect" }),
    ]);
  });

  test("routes an aggregated finding when every affected leaf preserves its full compiled projection", () => {
    const first = candidateItem("+5", [exactRow]);
    const second = structuredClone(first);
    second.item_id = "item:2";
    second.name = "sibling criterion";
    second.field_bindings.name = {
      ...second.field_bindings.name,
      source_fragments: [{ evidence_id: evidenceId, text: "sibling criterion" }],
      value_sha256: sha256Text(second.name),
    };
    const sourcePlan = plan(first);
    sourcePlan.acceptance_items.push(second);
    sourcePlan.inspection_lots[0]!.item_ids.push(second.item_id);
    const secondFinal = {
      ...materialized("+5"),
      item_id: second.item_id,
      name: second.name,
      reference_origin_item_id: second.item_id,
    };
    const review = compilerFinding();
    (review.findings as Array<Record<string, unknown>>)[0]!.affected_item_ids = [first.item_id, second.item_id];
    // Deliberately names only the first leaf's fragment. Ownership is proven by
    // each leaf's complete projection, not by forcing one fragment onto all leaves.
    (review.findings as Array<Record<string, unknown>>)[0]!.exact_fragment = exactRow;

    const result = normalizePlanAuthorizedCompilerFindings(
      review,
      sourcePlan,
      [materialized("+5"), secondFinal],
    );

    expect(result.changed).toBe(true);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
    ]);
  });

  test("keeps an aggregated finding when any affected leaf drifts", () => {
    const first = candidateItem("+5", [exactRow]);
    const second = structuredClone(first);
    second.item_id = "item:2";
    const sourcePlan = plan(first);
    sourcePlan.acceptance_items.push(second);
    sourcePlan.inspection_lots[0]!.item_ids.push(second.item_id);
    const review = compilerFinding();
    (review.findings as Array<Record<string, unknown>>)[0]!.affected_item_ids = [first.item_id, second.item_id];

    const result = normalizePlanAuthorizedCompilerFindings(
      review,
      sourcePlan,
      [materialized("+5"), { ...materialized("+5"), item_id: second.item_id, method: "drifted" }],
    );

    expect(result.changed).toBe(false);
  });

  test("keeps a materialized name drift as a harness defect", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    const finalItem = { ...materialized("+5"), name: "drifted name" };

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(sourceItem),
      [finalItem],
    );

    expect(result.changed).toBe(false);
  });

  test("routes a faithful one-to-one replace-field projection to semantic repair", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    const sourcePlan = plan(sourceItem);
    sourcePlan.semantic_references = [{
      expansion_id: "semantic-reference:1",
      anchor_semantic_id: "semantic:anchor",
      status: "resolved",
      target_semantic_ids: ["semantic:target"],
      destination_bindings: [{ item_id: sourceItem.item_id, fields: ["requirement"] }],
      reason: "test reference",
    }];

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      sourcePlan,
      [materialized("+5")],
    );

    expect(result.changed).toBe(true);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
    ]);
  });

  test("keeps an actual replace-field materialization drift as a harness defect", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    const sourcePlan = plan(sourceItem);
    sourcePlan.semantic_references = [{
      expansion_id: "semantic-reference:1",
      anchor_semantic_id: "semantic:anchor",
      status: "resolved",
      target_semantic_ids: ["semantic:target"],
      destination_bindings: [{ item_id: sourceItem.item_id, fields: ["requirement"] }],
      reason: "test reference",
    }];

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      sourcePlan,
      [materialized("drifted after compilation")],
    );

    expect(result.changed).toBe(false);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "compiler_materialization_defect" }),
    ]);
  });

  test("keeps a one-to-many sampling projection conservative", () => {
    const sourceItem = candidateItem("+5", [exactRow]);
    sourceItem.sampling = crossBranchSampling();
    const first = materialized("+5");
    first.sampling = structuredClone(sourceItem.sampling);
    const second = { ...materialized("+5"), item_id: "item:expanded" };
    second.sampling = structuredClone(sourceItem.sampling);

    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(sourceItem),
      [first, second],
    );

    expect(result.changed).toBe(false);
  });

  const assemblyRev1Root = resolve(
    "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A3824d7428378f5b113c9abb4/revisions/000001",
  );
  const assemblyRev1Fingerprint = "05f1313eb5ebefbabaf5d1728a88d3d94065da127e216d9ea0754c57a5a5e7e0";
  test.runIf(existsSync(resolve(
    assemblyRev1Root,
    "coverage-review",
    assemblyRev1Fingerprint,
    "coverage-review.json",
  )))(
    "routes the faithful GB50576 Table C.0.1 title projection to semantic repair while retaining a drift backstop",
    () => {
      const evidence = JSON.parse(readFileSync(
        resolve(assemblyRev1Root, "evidence/evidence.json"),
        "utf8",
      )) as EvidenceManifest;
      const persistedPlan = JSON.parse(readFileSync(
        resolve(assemblyRev1Root, "last-valid.semantic-source-plan.json"),
        "utf8",
      )) as PersistedSemanticSourcePlan;
      const candidatePlan = hydrateSemanticSourcePlan(persistedPlan, evidence);
      const review = JSON.parse(readFileSync(resolve(
        assemblyRev1Root,
        "coverage-review",
        assemblyRev1Fingerprint,
        "coverage-review.json",
      ), "utf8")) as DomainCoverageReview;
      const materializedItems = materialize(persistedPlan, evidence, assemblyRev1Fingerprint)
        .result.inspection_lots.flatMap((lot) => lot.items);

      const normalized = normalizePlanAuthorizedCompilerFindings(
        review as unknown as Record<string, unknown>,
        candidatePlan,
        materializedItems,
      );
      expect(normalized.changed).toBe(true);
      expect(normalized.value.findings).toEqual([
        expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
      ]);

      const affectedId = (review.findings[0]?.affected_item_ids ?? [])[0]!;
      const driftedItems = materializedItems.map((item) => (
        item.item_id === affectedId ? { ...item, requirement: `${item.requirement} drift` } : item
      ));
      const drifted = normalizePlanAuthorizedCompilerFindings(
        review as unknown as Record<string, unknown>,
        candidatePlan,
        driftedItems,
      );
      expect(drifted.changed).toBe(false);
      expect(drifted.value.findings).toEqual([
        expect.objectContaining({ finding_type: "compiler_materialization_defect" }),
      ]);
    },
  );

  const rev4Root = resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A8c4a81e09e641fa8a42f032b/revisions/000004",
  );
  const rev4Fingerprint = "8a687d032f086c9bc3bcbd520e6c2877483e6a96973d1d2119a8dd0b94258daf";
  test.runIf(existsSync(resolve(rev4Root, "coverage-review", rev4Fingerprint, "coverage-review.json")))(
    "routes all 8c4 rev4 faithful-plan findings to semantic repair",
    () => {
      const evidence = JSON.parse(readFileSync(resolve(rev4Root, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
      const persistedPlan = JSON.parse(readFileSync(
        resolve(rev4Root, "last-valid.semantic-source-plan.json"),
        "utf8",
      )) as PersistedSemanticSourcePlan;
      const candidatePlan = hydrateSemanticSourcePlan(persistedPlan, evidence);
      const review = JSON.parse(readFileSync(
        resolve(rev4Root, "coverage-review", rev4Fingerprint, "coverage-review.json"),
        "utf8",
      )) as DomainCoverageReview;
      const revisionState = JSON.parse(readFileSync(resolve(rev4Root, "state.json"), "utf8")) as {
        coverage_recheck: {
          affected_item_ids: string[];
          affected_evidence_ids: string[];
          finding_ids: string[];
        };
      };
      const materializedItems = materialize(persistedPlan, evidence, rev4Fingerprint)
        .result.inspection_lots.flatMap((lot) => lot.items);

      const normalized = normalizePlanAuthorizedCompilerFindings(
        review as unknown as Record<string, unknown>,
        candidatePlan,
        materializedItems,
      );

      expect(normalized.changed).toBe(true);
      expect((normalized.value.findings as Array<{ finding_type: string }>))
        .toHaveLength(9);
      expect((normalized.value.findings as Array<{ finding_type: string }>).filter((finding) =>
        finding.finding_type === "compiler_materialization_defect"
      )).toHaveLength(1);

      expect(revisionState.coverage_recheck.finding_ids.length).toBeGreaterThan(0);
    },
  );

  const rev6Root = resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3A8c4a81e09e641fa8a42f032b/revisions/000006",
  );
  const rev6Fingerprint = "667c0b81c87831789f4673a72817ae6b555707ce64154a378342aca03dfc20c9";
  test.runIf(existsSync(resolve(rev6Root, "coverage-review", rev6Fingerprint, "coverage-review.json")))(
    "routes the 8c4 rev6 three-item aggregated method finding by complete projection",
    () => {
      const evidence = JSON.parse(readFileSync(resolve(rev6Root, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
      const persistedPlan = JSON.parse(readFileSync(
        resolve(rev6Root, "last-valid.semantic-source-plan.json"),
        "utf8",
      )) as PersistedSemanticSourcePlan;
      const candidatePlan = hydrateSemanticSourcePlan(persistedPlan, evidence);
      const review = JSON.parse(readFileSync(
        resolve(rev6Root, "coverage-review", rev6Fingerprint, "coverage-review.json"),
        "utf8",
      )) as DomainCoverageReview;
      const materializedItems = materialize(persistedPlan, evidence, rev6Fingerprint)
        .result.inspection_lots.flatMap((lot) => lot.items);

      const normalized = normalizePlanAuthorizedCompilerFindings(
        review as unknown as Record<string, unknown>,
        candidatePlan,
        materializedItems,
      );
      const methodFinding = (normalized.value.findings as Array<{
        finding_id: string;
        finding_type: string;
      }>).find((finding) =>
        finding.finding_id === "finding:e04-method-prefixed-with-reference-anchor"
      );

      expect(normalized.changed).toBe(true);
      expect(methodFinding?.finding_type).toBe("semantic_coverage_gap");
      expect((normalized.value.findings as Array<{ finding_type: string }>).every((finding) =>
        finding.finding_type === "semantic_coverage_gap"
      )).toBe(true);
    },
  );

  const fastenerRev2Root = resolve(
    "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A587b3a30ad2b3c947120dd40/revisions/000002",
  );
  const fastenerRev2Fingerprint = "8013ab0fafb9b762754b9952e8741e4db08929788527d83c297df10f3242da6c";
  test.runIf(existsSync(resolve(
    fastenerRev2Root,
    "coverage-review",
    fastenerRev2Fingerprint,
    "coverage-review.json",
  )))(
    "routes the 587b rev2 selector-authorized cross-branch sampling findings to semantic repair",
    () => {
      const evidence = JSON.parse(readFileSync(
        resolve(fastenerRev2Root, "evidence/evidence.json"),
        "utf8",
      )) as EvidenceManifest;
      const persistedPlan = JSON.parse(readFileSync(
        resolve(fastenerRev2Root, "last-valid.semantic-source-plan.json"),
        "utf8",
      )) as PersistedSemanticSourcePlan;
      const candidatePlan = hydrateSemanticSourcePlan(persistedPlan, evidence);
      const review = JSON.parse(readFileSync(resolve(
        fastenerRev2Root,
        "coverage-review",
        fastenerRev2Fingerprint,
        "coverage-review.json",
      ), "utf8")) as DomainCoverageReview;
      const materializedItems = materialize(persistedPlan, evidence, fastenerRev2Fingerprint)
        .result.inspection_lots.flatMap((lot) => lot.items);

      const normalized = normalizePlanAuthorizedCompilerFindings(
        review as unknown as Record<string, unknown>,
        candidatePlan,
        materializedItems,
      );
      const findings = normalized.value.findings as Array<{
        finding_id: string;
        finding_type: string;
      }>;

      expect(normalized.changed).toBe(true);
      expect(findings.find((finding) =>
        finding.finding_id === "finding:compiler-cross-branch-torque-leaf"
      )?.finding_type).toBe("semantic_coverage_gap");
      expect(findings.find((finding) =>
        finding.finding_id === "finding:compiler-cross-branch-pretension-leaf"
      )?.finding_type).toBe("semantic_coverage_gap");

      // This live replay directory can advance to a later candidate while the
      // earlier immutable coverage review remains on disk. Keep this assertion
      // scoped to ownership normalization; synthetic tests above cover the
      // validation route against a matching candidate plan.
    },
  );

  test("accepts only the deterministic display normalization of a raw compiled field", () => {
    const raw = "$d \\leqslant 120\\text{mm}$";
    const sourceItem = candidateItem(raw, [raw]);
    const sourcePlan = plan(sourceItem);
    const finalItem = materialized("d≤120mm");
    const review = compilerFinding();
    (review.findings as Array<Record<string, unknown>>)[0]!.exact_fragment = raw;
    const normalized = normalizePlanAuthorizedCompilerFindings(
      review,
      sourcePlan,
      [finalItem],
    );
    expect(normalized.changed).toBe(true);
    expect((normalized.value.findings as Array<{ finding_type: string }>)[0]!.finding_type)
      .toBe("semantic_coverage_gap");

    const drifted = normalizePlanAuthorizedCompilerFindings(
      review,
      sourcePlan,
      [{ ...finalItem, requirement: "d≤120mm 2.0mm" }],
    );
    expect(drifted.changed).toBe(false);
  });

  test("routes a faithfully materialized plan with missing target provenance to semantic repair", () => {
    const result = normalizePlanAuthorizedCompilerFindings(
      compilerFinding(),
      plan(candidateItem(wholeTable, [])),
      [materialized(wholeTable)],
    );

    expect(result.changed).toBe(true);
    expect(result.value.findings).toEqual([
      expect.objectContaining({ finding_type: "semantic_coverage_gap" }),
    ]);
  });

  // Revision 000003 is the immutable candidate that produced this review.
  // Later recovery revisions legitimately replace last-valid, so pairing an
  // old review with the latest mutable plan would test a stale combination.
  const replayRoot = resolve(
    "data/jobs/20260812-161216-c005/pi-agent/jobs/20260812-161216-c005/targets/target_3Afe8d42fc9aa243778c8c3791/revisions/000003",
  );
  const replayFingerprint = "50798ae685708d9caec7e8a4a830c7021f59300dba6d04985b3866523745b5f0";
  test.runIf(existsSync(resolve(replayRoot, "coverage-review", replayFingerprint, "coverage-review.json")))(
    "replays fe8 as a semantic repair because the compiled requirement already contains the whole table",
    () => {
      const evidence = JSON.parse(readFileSync(resolve(replayRoot, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
      const candidatePlan = JSON.parse(readFileSync(resolve(replayRoot, "last-valid.semantic-source-plan.json"), "utf8")) as SemanticSourcePlan;
      const review = JSON.parse(readFileSync(
        resolve(replayRoot, "coverage-review", replayFingerprint, "coverage-review.json"),
        "utf8",
      )) as DomainCoverageReview;
      const revisionState = JSON.parse(readFileSync(resolve(replayRoot, "state.json"), "utf8")) as {
        coverage_recheck: {
          affected_item_ids: string[];
          affected_evidence_ids: string[];
          finding_ids: string[];
        };
      };

      const validation = validateCoverageReview(
        review,
        replayFingerprint,
        evidence,
        undefined,
        candidatePlan,
        {
          mode: "repair_delta",
          affected_item_ids: revisionState.coverage_recheck.affected_item_ids,
          affected_evidence_ids: revisionState.coverage_recheck.affected_evidence_ids,
          finding_ids: revisionState.coverage_recheck.finding_ids,
        },
      );

      expect(validation.ok).toBe(true);
      expect(validation.review).toMatchObject({
        status: "repair",
        findings: [expect.objectContaining({
          finding_id: "finding:materialized-truss-span-requirement-includes-entire-table",
          finding_type: "semantic_coverage_gap",
        })],
      });
    },
  );
});
