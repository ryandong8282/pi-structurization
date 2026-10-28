import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  type EvidenceManifest,
  type InspectionDataType,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import { upgradePlanToCurrent } from "../src/plan-migration.js";
import { SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { prettyJson } from "../src/canonical.js";
import { validFixturePlan } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";

interface GoldCase {
  id: string;
  domain: string;
  criterion: string;
  method: string;
  context?: string;
  expected: InspectionDataType;
  reason: string;
  variants: string[];
}

const gold = JSON.parse(await readFile(
  new URL("./fixtures/inspection-data-type-gold.json", import.meta.url),
  "utf8",
)) as GoldCase[];

function manifestFor(text: string, id: string): EvidenceManifest {
  const evidenceId = `evidence:${id}`;
  const contextId = `context:${id}`;
  const fingerprint = sha256Text(text);
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: `gold-${id}`,
    target_id: id,
    source: {
      adapter: "markdown-target-scope/v3",
      file_name: `${id}.md`,
      sha256: fingerprint,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "target_section",
      target_id: id,
      source_line_count: 2,
      selected_start_line: 1,
      selected_end_exclusive_line: 3,
      selected_heading: "",
      selection_reason: "inspection data type gold",
      candidates: [],
    },
    evidence: [
      {
        evidence_id: evidenceId,
        kind: "paragraph",
        role: "supporting_clause",
        locator: "line:1",
        text,
        text_sha256: sha256Text(text),
        requires_disposition: true,
      },
      {
        evidence_id: contextId,
        kind: "paragraph",
        role: "context",
        locator: "line:2",
        text: "相邻但未路由给当前项目的上下文。",
        text_sha256: sha256Text("相邻但未路由给当前项目的上下文。"),
        requires_disposition: false,
      },
    ],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: fingerprint,
  };
}

function authoredPlan(testCase: GoldCase, text: string) {
  const manifest = manifestFor(text, testCase.id);
  const plan = validFixturePlan(manifest);
  const item = plan.acceptance_items[0]!;
  item.inspection_data_type = testCase.expected;
  item.inspection_data_type_reason = testCase.reason;
  item.inspection_data_type_evidence_ids = [...item.evidence_ids];
  return { manifest, plan };
}

describe("inspection data type professional judgement contract", () => {
  it("defines the domain decision and explicitly rejects deterministic proxies", () => {
    expect(SYSTEM_PROMPT).toContain("产生什么数据");
    expect(SYSTEM_PROMPT).toContain("单个检验单元怎样判断");
    expect(SYSTEM_PROMPT).toContain("最终怎样评价");
    expect(SYSTEM_PROMPT).toContain("数字缺陷限值仍可为counting");
    expect(SYSTEM_PROMPT).toContain("无书面数字但实际要求测量比较仍可为measurement");
    expect(SYSTEM_PROMPT).toContain("不以数字、单位、表格、关键词或版式做代理");
    expect(SYSTEM_PROMPT).toContain("确实不可分才mixed");
    expect(SYSTEM_PROMPT).toContain("证据不足用review");
    expect(SYSTEM_PROMPT).toContain("分类仅元数据，不反向改变项目成立");
  });

  it.each(gold)("round-trips Agent-authored gold classification: $id", (testCase) => {
    const text = [testCase.criterion, testCase.method, testCase.context ?? ""].filter(Boolean).join("\n");
    const { manifest, plan } = authoredPlan(testCase, text);
    const validation = validatePlanText(prettyJson(plan), manifest);
    expect(validation.ok).toBe(true);
    const result = materialize(plan, manifest, validation.fingerprint!).result;
    expect(result.inspection_lots[0]!.items[0]).toMatchObject({
      inspection_data_type: testCase.expected,
      inspection_data_type_reason: testCase.reason,
      inspection_data_type_evidence_ids: plan.acceptance_items[0]!.evidence_ids,
    });
  });

  it.each(gold.flatMap((testCase) => testCase.variants.map((variant, variantIndex) => ({
    testCase,
    variant,
    variantIndex,
  }))))("preserves the Agent decision across format/OCR perturbation: $testCase.id/$variantIndex", ({ testCase, variant }) => {
    const { manifest, plan } = authoredPlan(testCase, variant);
    const validation = validatePlanText(prettyJson(plan), manifest);
    expect(validation.ok).toBe(true);
    expect(materialize(plan, manifest, validation.fingerprint!).result.inspection_lots[0]!.items[0]!.inspection_data_type)
      .toBe(testCase.expected);
  });

  it("validates only enum, rationale, evidence binding, and structural consistency", () => {
    const testCase = gold[0]!;
    const { manifest, plan } = authoredPlan(testCase, testCase.criterion);
    (plan.acceptance_items[0] as unknown as Record<string, unknown>).inspection_data_type = "numeric-keyword-guess";
    expect(validatePlanText(prettyJson(plan), manifest).ok).toBe(false);

    const missingReason = authoredPlan(testCase, testCase.criterion);
    missingReason.plan.acceptance_items[0]!.inspection_data_type_reason = "   ";
    expect(validatePlanText(prettyJson(missingReason.plan), missingReason.manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inspection_data_type_reason" }),
      ]),
    );

    const unrelatedEvidence = authoredPlan(testCase, testCase.criterion);
    unrelatedEvidence.plan.acceptance_items[0]!.inspection_data_type_evidence_ids = [`context:${testCase.id}`];
    expect(validatePlanText(prettyJson(unrelatedEvidence.plan), unrelatedEvidence.manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inspection_data_type_evidence_relation" }),
      ]),
    );
  });

  it("keeps classification metadata out of lot, item, category, and sampling decisions", () => {
    const testCase = gold[0]!;
    const snapshots = (["measurement", "counting", "mixed", "review"] as const).map((dataType) => {
      const { manifest, plan } = authoredPlan(testCase, testCase.criterion);
      plan.acceptance_items[0]!.inspection_data_type = dataType;
      const result = materialize(plan, manifest, sha256Text(dataType)).result;
      const item = result.inspection_lots[0]!.items[0]!;
      return {
        lot_id: result.inspection_lots[0]!.lot_id,
        lot_name: result.inspection_lots[0]!.name,
        item_id: item.item_id,
        item_name: item.name,
        category: item.category,
        sampling: item.sampling,
      };
    });
    expect(snapshots.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0])))
      .toBe(true);
  });

  it.each(["selected", "unselected", "missing_receiver", "unrouted"])("checks classification provenance through actual shared sampling routing: %s", (mode) => {
    const testCase = gold[0]!;
    const {manifest, plan} = authoredPlan(testCase, testCase.criterion);
    const item = plan.acceptance_items[0]!;
    const context = manifest.evidence[1]!;
    item.inspection_data_type_evidence_ids = [context.evidence_id];
    item.sampling.evidence_ids = [context.evidence_id];
    item.sampling.rule_ids = mode === "unrouted" ? [] : ["shared"];
    item.sampling.applied_branches = [{rule_id:"shared",branch_id:mode === "unselected" ? "other" : "selected",min_sampling:"1件",script:"抽查",conditions:[],evidence_ids:[context.evidence_id]}];
    plan.shared_sampling_rules = [{
      rule_id:"shared",source_semantic_id:"source",evidence_ids:[context.evidence_id],complete_source_fragment:context.text,
      branches:[{branch_id:"selected",applies_to_category:"all_items",min_sampling:"1件",script:"抽查",evidence_id:context.evidence_id,exact_fragment:context.text}],
      shared_conditions:[],receiving_item_ids:mode === "missing_receiver" ? ["another-item"] : [item.item_id],reason:"共享抽样依据",
    }];
    const codes = validatePlanText(prettyJson(plan),manifest).issues.map((issue) => issue.code);
    expect(codes).not.toContain("schema");
    if (mode === "selected") expect(codes).not.toContain("inspection_data_type_evidence_relation");
    else expect(codes).toContain("inspection_data_type_evidence_relation");
  });

  it("migrates a v5 plan to review instead of guessing or changing item semantics", () => {
    const testCase = gold[0]!;
    const { manifest, plan } = authoredPlan(testCase, testCase.criterion);
    const legacy = structuredClone(plan) as unknown as Record<string, any>;
    legacy.schema_version = "semantic-source-plan/v5";
    delete legacy.acceptance_items[0].inspection_data_type;
    delete legacy.acceptance_items[0].inspection_data_type_reason;
    delete legacy.acceptance_items[0].inspection_data_type_evidence_ids;
    const migrated = upgradePlanToCurrent(legacy, manifest);
    expect(migrated.acceptance_items[0]).toMatchObject({
      item_id: plan.acceptance_items[0]!.item_id,
      inspection_data_type: "review",
      inspection_data_type_reason: expect.stringContaining("旧计划"),
    });
    expect(migrated.acceptance_items[0]!.sampling).toEqual(plan.acceptance_items[0]!.sampling);
  });
});
