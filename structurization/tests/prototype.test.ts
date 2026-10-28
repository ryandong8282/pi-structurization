import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { readJson } from "../src/atomic.js";
import {
  auditSealedRevision,
  buildBoundedRepairPlan,
} from "../src/audit.js";
import { prettyJson, sha256Bytes, sha256Json, sha256Text } from "../src/canonical.js";
import {
  buildEvidenceManifest,
  discoverFormalTargets,
  selectTargetScope,
} from "../src/evidence.js";
import type {
  AcceptanceResult,
  EvidenceManifest,
  RevisionState,
  SemanticSourcePlan,
} from "../src/contracts.js";
import { PLAN_SCHEMA_VERSION } from "../src/contracts.js";
import {
  runOfflineFixture,
  ToolController,
  createPiTools,
  validFixturePlan,
} from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { resolvePdfExCodePreset } from "../src/presets.js";
import { capturePiSdkEvent } from "../src/pi-runtime.js";
import {
  CoverageReviewController,
  coverageReviewObligations,
  createCoverageReviewTools,
  readSealedCoverageReview,
} from "../src/coverage-review.js";
import { buildPlanContract } from "../src/source-plan-contract.js";
import { confirmProvisionalTableAssembly } from "../src/table-assembly.js";
import { upgradePlanToCurrent } from "../src/plan-migration.js";
import { materialize } from "../src/materializer.js";
import { RevisionWorkspace } from "../src/workspace.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureMarkdown = resolve(packageRoot, "fixtures/stage1-like.md");
const realMarkdown = resolve(packageRoot, "fixtures/real/GB_50310-2002.md");
const realPdf = resolve(packageRoot, "fixtures/real/GB_50310-2002.pdf");
const gb50202Markdown = resolve(packageRoot, "fixtures/real/GB_50202-2018.md");

async function artifactRoot(label: string): Promise<string> {
  const root = resolve(".tmp-tests", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function workspace(label: string, target = "4.1"): Promise<RevisionWorkspace> {
  return RevisionWorkspace.create(
    await artifactRoot(label),
    "test-job",
    target,
    fixtureMarkdown,
  );
}

async function manifestFor(label: string): Promise<{
  workspace: RevisionWorkspace;
  manifest: EvidenceManifest;
  plan: SemanticSourcePlan;
}> {
  const revision = await workspace(label);
  const manifest = await revision.readEvidenceManifest();
  return { workspace: revision, manifest, plan: validFixturePlan(manifest) };
}

function confirmedPlan(manifest: EvidenceManifest): SemanticSourcePlan {
  return neutralSamplingForNonSamplingTests(buildPlanContract(
    manifest,
    confirmProvisionalTableAssembly(manifest),
  ).plan_template);
}

function neutralSamplingForNonSamplingTests(plan: SemanticSourcePlan): SemanticSourcePlan {
  const copy = structuredClone(plan);
  for (const item of copy.acceptance_items) {
    item.sampling = {
      status: "not_sampling",
      min_sampling: "",
      script: "本结构测试不评估抽样语义。",
      reason: "抽样语义由单独用例覆盖。",
      confidence: 1,
      evidence_ids: [],
    };
  }
  return copy;
}

describe("target-scoped evidence adapter", () => {
  test("prefers normative evidence over an alternate commentary occurrence", () => {
    const markdown = [
      "# 条文说明",
      "## 4.1 设备进场验收",
      "4.1.1 本段只是条文说明。",
      "# 规范正文",
      "# 4.1 设备进场验收",
      "4.1.1 随机文件必须齐全。",
      "表 4.1.1 设备进场验收",
      "<table><tr><td>检查项目</td><td>随机文件</td></tr></table>",
      "## 4.2 土建交接检验",
      "4.2.1 井道应符合要求。",
    ].join("\n");
    const scope = selectTargetScope(markdown, "4.1");
    expect(scope.mode).toBe("target_section");
    expect(scope.candidates).toHaveLength(2);
    expect(scope.selected_start_line).toBe(5);
    expect(scope.selected_end_exclusive_line).toBe(9);
    expect(scope.candidates.find((candidate) => candidate.start_line === 2)).toMatchObject({
      selected: false,
    });
  });

  test("does not treat a heading-like line inside an HTML table as a section boundary", () => {
    const markdown = [
      "# 4.1 设备进场验收",
      "<table>",
      "<tr><td># 4.2 这是单元格文本</td></tr>",
      "</table>",
      "# 4.2 土建交接检验",
    ].join("\n");
    const scope = selectTargetScope(markdown, "4.1");
    expect(scope.selected_start_line).toBe(1);
    expect(scope.selected_end_exclusive_line).toBe(5);
  });

  test("ends the final subsection when the next top-level chapter begins", () => {
    const markdown = [
      "# 4.14 边坡工程",
      "4.14.1 边坡工程应符合要求。",
      "<table><tr><td>检查项目</td><td>允许值</td></tr></table>",
      "# 5 桩基础工程",
      "# 5.1 一般规定",
      "5.1.1 本章内容不得进入 4.14。",
    ].join("\n");
    const scope = selectTargetScope(markdown, "4.14");
    expect(scope.selected_start_line).toBe(1);
    expect(scope.selected_end_exclusive_line).toBe(4);
  });

  test("rejects a missing numeric target instead of silently using the full document", () => {
    expect(() => selectTargetScope("# 4.2 土建交接检验\n", "4.1")).toThrow(
      /Target section 4\.1 was not found/,
    );
  });

  test("expands GB50202 target 5.5 into two formal lots and 25 row items", async () => {
    const markdown = await readFile(gb50202Markdown, "utf8");
    const targets = discoverFormalTargets(markdown);
    const target = targets.find((candidate) => candidate.target_id === "5.5");
    expect(target).toMatchObject({ table_count: 2, row_count: 25 });

    const { manifest } = await buildEvidenceManifest(
      gb50202Markdown,
      "gb50202-contract-test",
      "5.5",
    );
    const formalRows = manifest.evidence.filter((record) =>
      record.role === "formal_table_row"
      && record.evidence_scope !== "reference"
    );
    expect(formalRows).toHaveLength(25);
    expect(formalRows[0]).toMatchObject({
      kind: "table_row",
      table_id: "5.5.4-1",
      cells: ["主控项目", "1", "承载力", "不小于设计值", "不小于设计值", "静载试验、高应变法等"],
      requires_disposition: true,
    });
    const contract = buildPlanContract(manifest);
    expect(contract.plan_template.inspection_lots).toHaveLength(2);
    expect(contract.plan_template.acceptance_items).toHaveLength(25);
    const requiredReferences = manifest.reference_occurrences.filter(
      (occurrence) => occurrence.required,
    );
    expect(requiredReferences).toHaveLength(5);
    expect(requiredReferences.map((occurrence) => ({
      target: occurrence.target_table_id,
      fields: occurrence.origin_fields,
      status: occurrence.status,
    }))).toEqual(expect.arrayContaining([
      { target: "5.1.2", fields: ["requirement"], status: "resolved" },
      { target: "5.10.4", fields: ["requirement", "method"], status: "resolved" },
      { target: "5.5.4-1", fields: ["requirement"], status: "resolved" },
    ]));
    expect(requiredReferences.every((occurrence) =>
      occurrence.target_evidence_ids.length > 0
    )).toBe(true);
    expect(manifest.evidence.filter((record) => record.role === "sampling_rule"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ clause_id: "5.1.6" }),
        expect.objectContaining({ clause_id: "5.1.7" }),
      ]));
    expect(manifest.evidence.some((record) => record.clause_id === "3.0.6")).toBe(false);
    expect(validatePlanText(prettyJson(contract.plan_template), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reference_resolution_missing" }),
      ]),
    );
  });




  test("classifies only executable sampling occurrences instead of whole referenced chapters", async () => {
    const { manifest: pileManifest } = await buildEvidenceManifest(
      gb50202Markdown,
      "gb50202-occurrences",
      "5.5",
    );
    expect(pileManifest.evidence
      .filter((record) => record.role === "sampling_rule")
      .map((record) => ({
        clause: record.clause_id,
        kind: record.sampling_occurrence?.kind,
      }))).toEqual([
        { clause: "5.1.6", kind: "explicit_quantity" },
        { clause: "5.1.7", kind: "explicit_quantity" },
      ]);

    const { manifest: slopeManifest } = await buildEvidenceManifest(
      gb50202Markdown,
      "gb50202-occurrences",
      "10.4",
    );
    expect(slopeManifest.evidence
      .filter((record) => record.role === "sampling_rule")
      .map((record) => record.clause_id)).toEqual([]);
  });





  test("blocks missing reference targets and document-level table cycles", async () => {
    const cycleMarkdown = [
      "# 4.1 循环引用测试",
      "表 4.1.1 A表",
      "<table><tr><td>项</td><td>序</td><td>检查项目</td><td>单位</td><td>数值</td><td>检查方法</td></tr><tr><td>主控项目</td><td>1</td><td>A项目</td><td>本标准表4.1.2</td><td>本标准表4.1.2</td><td>观察</td></tr></table>",
      "表 4.1.2 B表",
      "<table><tr><td>项</td><td>序</td><td>检查项目</td><td>单位</td><td>数值</td><td>检查方法</td></tr><tr><td>主控项目</td><td>1</td><td>B项目</td><td>本标准表4.1.1</td><td>本标准表4.1.1</td><td>观察</td></tr></table>",
    ].join("\n");
    const cyclePath = resolve(await artifactRoot("reference-cycle"), "cycle.md");
    await writeFile(cyclePath, cycleMarkdown, "utf8");
    const { manifest: cycleManifest } = await buildEvidenceManifest(
      cyclePath,
      "reference-cycle",
      "4.1",
    );
    expect(cycleManifest.reference_occurrences.filter((row) => row.required))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "cycle" }),
      ]));
    expect(validatePlanText(
      prettyJson(confirmedPlan(cycleManifest)),
      cycleManifest,
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_cycle" }),
    ]));

    const missingPath = resolve(await artifactRoot("reference-missing"), "missing.md");
    await writeFile(
      missingPath,
      cycleMarkdown.replaceAll("本标准表4.1.2", "本标准表9.9.9")
        .replace("表 4.1.2 B表", "表 4.1.3 B表"),
      "utf8",
    );
    const { manifest: missingManifest } = await buildEvidenceManifest(
      missingPath,
      "reference-missing",
      "4.1",
    );
    expect(validatePlanText(
      prettyJson(confirmedPlan(missingManifest)),
      missingManifest,
    ).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_target_not_found", details: expect.objectContaining({
        actual: expect.objectContaining({ status: "target_not_found" }), required_status: "resolved",
        next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 0, limit: 100 },
        writable_paths: expect.arrayContaining(["resolve_document_reference.target"]),
        how_to_pass: expect.stringContaining("当前不能封存"),
        do_not_edit: expect.stringContaining("不可变 reference occurrence"),
      }) }),
    ]));
  });
});

describe("strict parsing and domain validation", () => {
  test("keeps final Pi events but omits cumulative streaming updates", () => {
    expect(capturePiSdkEvent({
      type: "message_update",
      message: { role: "assistant", content: "cumulative content" },
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    })).toBeUndefined();
    expect(capturePiSdkEvent({
      type: "message_end",
      message: { role: "assistant", content: "final content" },
    })).toEqual({
      type: "message_end",
      message: { role: "assistant", content: "final content" },
    });
  });

  test("serializes concurrent transcript and state mutations", async () => {
    const revision = await workspace("concurrent-state");
    await Promise.all([
      ...Array.from({ length: 50 }, (_, index) =>
        revision.appendEvent("concurrent-test", { index })
      ),
      ...Array.from({ length: 20 }, () =>
        revision.updateState((state) => {
          state.validation_attempts += 1;
        })
      ),
    ]);
    const state = await revision.readState();
    const transcript = await readFile(revision.transcriptPath, "utf8");
    const events = transcript
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });
    const prefix = await revision.transcriptPrefix();
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(state.next_event_sequence).toBe(51);
    expect(state.validation_attempts).toBe(20);
    expect(prefix).toEqual({
      through_sequence: 50,
      sha256: sha256Text(transcript),
      byte_length: Buffer.byteLength(transcript, "utf8"),
    });
  });

  test("resolves the two protocol profiles from independent connection settings", () => {
    expect(resolvePdfExCodePreset({
      LLM_PRESET: "OpenCodeMuse1.3",
      LLM_MODEL: "custom-muse-model",
      LLM_ENDPOINT: "https://llm.example/v1",
      LLM_API_KEY: "configured-secret",
    })).toMatchObject({
      api: "openai-responses",
      modelId: "custom-muse-model",
      baseUrl: "https://llm.example/v1",
      apiKey: "configured-secret",
      supportsDeveloperRole: false,
      reasoningEffort: "low",
    });
    expect(resolvePdfExCodePreset({
      LLM_PRESET: "Gpt5.6Luna",
      LLM_MODEL: "gpt-5.6-luna",
      LLM_ENDPOINT: "http://127.0.0.1:8317/v1",
      LLM_API_KEY: "local-secret",
      LLM_REASONING_EFFORT: "max",
    })).toMatchObject({
      api: "openai-completions",
      modelId: "gpt-5.6-luna",
      baseUrl: "http://127.0.0.1:8317/v1",
      supportsReasoningEffort: true,
      reasoningEffort: "max",
    });
    expect(() => resolvePdfExCodePreset({
      LLM_PRESET: "Deepseek4Pro",
      LLM_MODEL: "configured-model",
      LLM_ENDPOINT: "https://llm.example/v1",
      LLM_API_KEY: "configured-secret",
    })).toThrow(/Unknown LLM_PRESET/);
    expect(() => resolvePdfExCodePreset({
      LLM_PRESET: "Minimaxm3",
      LLM_MODEL: "configured-model",
      LLM_ENDPOINT: "https://llm.example/v1",
      LLM_API_KEY: "configured-secret",
    })).toThrow(/Unknown LLM_PRESET/);
    expect(() => resolvePdfExCodePreset({ LLM_PRESET: "Gpt5.6Luna" }))
      .toThrow(/LLM_MODEL/);
  });

  test("rejects invalid JSON and duplicate keys", async () => {
    const { manifest, plan } = await manifestFor("json");
    const invalid = validatePlanText('{"schema_version":', manifest);
    expect(invalid.ok).toBe(false);
    expect(invalid.issues[0]?.code).toBe("invalid_json");

    const validText = prettyJson(plan);
    const duplicate = validText.replace(
      '"job_id": "test-job",',
      '"job_id": "test-job",\n  "job_id": "other",',
    );
    const result = validatePlanText(duplicate, manifest);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("duplicate_json_key");
  });

  test("rejects schema extras, unknown evidence, and untreated evidence", async () => {
    const { manifest, plan } = await manifestFor("schema-business");
    const extra = { ...plan, model_commentary: "must not be accepted" };
    expect(validatePlanText(prettyJson(extra), manifest).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "schema" })]),
    );

    const unknown: SemanticSourcePlan = structuredClone(plan);
    unknown.acceptance_items[0]!.evidence_ids.push("evidence:does-not-exist");
    expect(validatePlanText(prettyJson(unknown), manifest).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown_evidence" })]),
    );

    const untreated: SemanticSourcePlan = structuredClone(plan);
    untreated.evidence_dispositions.pop();
    expect(validatePlanText(prettyJson(untreated), manifest).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unhandled_evidence" })]),
    );
  });

  test("rejects stale field hashes and source fragments not present in evidence", async () => {
    const { manifest, plan } = await manifestFor("field-bindings");
    const stale: SemanticSourcePlan = structuredClone(plan);
    stale.acceptance_items[0]!.name = "修改后但未同步绑定的名称";
    expect(validatePlanText(prettyJson(stale), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "field_binding_value_mismatch" }),
      ]),
    );

    const fabricated: SemanticSourcePlan = structuredClone(plan);
    fabricated.acceptance_items[0]!.field_bindings.name.source_fragments[0]!.text =
      "证据中不存在的片段";
    expect(validatePlanText(prettyJson(fabricated), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "field_binding_fragment_mismatch" }),
      ]),
    );
  });

  test("migrates a sealed v2 plan into a validated current revision candidate", async () => {
    const { manifest, plan } = await manifestFor("v2-migration");
    const legacy = structuredClone(plan) as unknown as Record<string, unknown>;
    legacy.schema_version = "semantic-source-plan/v2";
    delete legacy.reference_resolutions;
    for (const item of legacy.acceptance_items as Array<Record<string, unknown>>) {
      delete item.field_bindings;
    }
    const migrated = upgradePlanToCurrent(legacy, manifest);
    expect(migrated.schema_version).toBe(PLAN_SCHEMA_VERSION);
    expect(migrated.reference_resolutions).toEqual([]);
    expect(validatePlanText(prettyJson(migrated), manifest).ok).toBe(true);
  });

  test("keeps v5 artifacts compatible by adding an explicit null table contract", async () => {
    const { manifest, plan } = await manifestFor("v5-table-migration");
    const legacy = structuredClone(plan) as unknown as Record<string, unknown>;
    legacy.schema_version = "semantic-source-plan/v5";
    for (const item of legacy.acceptance_items as Array<Record<string, unknown>>) {
      delete item.table_semantics;
    }
    const migrated = upgradePlanToCurrent(legacy, manifest);
    expect(migrated.schema_version).toBe(PLAN_SCHEMA_VERSION);
    expect(migrated.acceptance_items[0]!.table_semantics).toBeNull();
    expect(validatePlanText(prettyJson(migrated), manifest).ok).toBe(true);
  });

  test("rejects wrong lot, citation, and reference relations", async () => {
    const { manifest, plan } = await manifestFor("relations");
    const wrongLot: SemanticSourcePlan = structuredClone(plan);
    wrongLot.inspection_lots[0]!.item_ids = [];
    expect(validatePlanText(prettyJson(wrongLot), manifest).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "lot_item_relation" })]),
    );

    const wrongCitation: SemanticSourcePlan = structuredClone(plan);
    wrongCitation.evidence_dispositions[0]!.item_ids = [];
    expect(validatePlanText(prettyJson(wrongCitation), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "used_evidence_without_item" }),
        expect.objectContaining({ code: "citation_disposition_relation" }),
      ]),
    );

    const wrongReference: SemanticSourcePlan = structuredClone(plan);
    const cited = wrongReference.acceptance_items[0]!.evidence_ids.pop()!;
    wrongReference.acceptance_items[0]!.reference_evidence_ids = [cited];
    expect(validatePlanText(prettyJson(wrongReference), manifest).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reference_relation" })]),
    );
  });


  test("rejects an explicit quantity cited from another item's table row", async () => {
    const { manifest } = await buildEvidenceManifest(
      gb50202Markdown,
      "gb50202-sampling-validator-cross-row",
      "5.5",
    );
    const plan = confirmedPlan(manifest);
    plan.acceptance_items[0]!.sampling = {
      status: "explicit",
      min_sampling: "1%",
      script: "抽取 1%。",
      reason: "故意构造跨项目错误引用。",
      confidence: 1,
      evidence_ids: [plan.acceptance_items[1]!.evidence_ids[0]!],
    };
    expect(validatePlanText(prettyJson(plan), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sampling_non_rule_evidence" }),
      ]),
    );
  });

  test("does not inject a standard-specific fallback answer into a generic target contract", async () => {
    const { manifest } = await buildEvidenceManifest(
      gb50202Markdown,
      "gb50202-sampling-validator-generic",
      "5.5",
    );
    expect(manifest.evidence.some((record) =>
      record.role === "sampling_rule" && record.clause_id === "3.0.6"
    )).toBe(false);
    const contract = buildPlanContract(manifest, confirmProvisionalTableAssembly(manifest));
    expect(contract.plan_template.acceptance_items.every((item) =>
      item.sampling.confidence === 0
      && item.sampling.evidence_ids.length === 0
      && item.sampling.min_sampling === ""
    )).toBe(true);
  });

});

describe("isolated agent revision workflow", () => {

  test("exposes only the constrained candidate Pi tools", async () => {
    const revision = await workspace("pi-tools");
    const tools = createPiTools(await ToolController.create(revision));
    expect(tools.map((tool) => tool.name)).toEqual([
      "get_plan_contract",
      "resolve_document_reference",
      "list_table_fragments",
      "read_table_summary",
      "read_table_rows",
      "read_adjacent_source",
      "read_saved_table_structure",
      "stage_table_structure",
      "list_sampling_rules",
      "list_reference_occurrences",
      "read_document_reference_evidence",
      "read_reference_facts",
      "open_evidence",
      "search_evidence",
      "read_working_plan",
      "read_coverage_review",
      "prepare_field_bindings",
      "replace_working_plan",
      "patch_working_plan",
      "reconcile_evidence_dispositions",
      "apply_table_assembly",
      "validate_working_plan",
      "seal_validated_plan",
    ]);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["bash", "read", "write", "edit"]),
    );
  });

  test("blocks path escape and unsafe patch segments", async () => {
    const revision = await workspace("path-escape");
    expect(() => revision.resolveWritable("../../escape.json")).toThrow(/allowlist|escapes/i);
    expect(() => revision.resolveWritable("history/../../escape.json")).toThrow(/escapes/i);
    expect(() => revision.resolveWritable(resolve("outside.json"))).toThrow(/absolute/i);

    const controller = await ToolController.create(revision);
    await expect(controller.dispatch("patch_working_plan", {
      operations: [{ op: "add", path: "/__proto__/polluted", value: true }],
    })).resolves.toMatchObject({ ok: false, error: "target_tool_rejected", actual_error: expect.stringMatching(/unsafe/i), instruction: expect.any(String) });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("bounds patch size and acceptance-item changes before durable writes", async () => {
    const revision = await workspace("bounded-plan-patch");
    const controller = await ToolController.create(revision);
    const before = await readFile(revision.workingPlanPath, "utf8");
    const tooManyItems = await controller.dispatch("patch_working_plan", {
      operations: Array.from({ length: 5 }, (_, index) => ({
        op: "add",
        path: "/acceptance_items/-",
        value: { item_id: `bounded-item-${index}` },
      })),
    });
    expect(tooManyItems).toMatchObject({
      ok: false,
      error: "bounded_patch_item_limit",
      changed_item_count: 5,
      max_changed_item_count: 4,
    });
    expect(await readFile(revision.workingPlanPath, "utf8")).toBe(before);

    const tooLarge = await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "replace",
        path: "/evidence_dispositions",
        value: ["x".repeat(140 * 1024)],
      }],
    });
    expect(tooLarge).toMatchObject({ ok: false, error: "bounded_patch_size_limit" });
    expect(await readFile(revision.workingPlanPath, "utf8")).toBe(before);
  });

  test("bounds typed coverage-review staging", async () => {
    const { workspace: revision, plan } = await manifestFor("bounded-coverage-patch");
    const planController = await ToolController.create(revision);
    await planController.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await planController.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    const reviewController = await CoverageReviewController.create(
      revision,
      String(validated.fingerprint),
    );
    const before = await readFile(reviewController.workingPath, "utf8");
    const result = await reviewController.dispatch("stage_coverage_review_draft", {
      semantic_coverage_upserts: Array.from({ length: 33 }, (_, index) => ({
          coverage_id: `coverage-${index}`,
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{ evidence_id: `evidence-${index}`, exact_fragment: "exact" }],
          reason: "bounded patch fixture",
      })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: "bounded_coverage_stage_semantic_limit",
      changed_record_count: 33,
      max_changed_record_count: 32,
    });
    expect(await readFile(reviewController.workingPath, "utf8")).toBe(before);
  });

  test("quarantines a validator-stale coverage seal while preserving its durable draft", async () => {
    const { workspace: revision, plan } = await manifestFor("coverage-stale-seal-recovery");
    const planController = await ToolController.create(revision);
    await planController.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await planController.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    const planFingerprint = String(validated.fingerprint);
    const reviewController = await CoverageReviewController.create(revision, planFingerprint);
    const opened = reviewController.evidence.evidence[0]!;
    await reviewController.dispatch("open_review_evidence", { evidence_id: opened.evidence_id });
    const staleReview = {
      schema_version: "domain-coverage-review/v4",
      plan_fingerprint: planFingerprint,
      evidence_fingerprint: reviewController.evidence.evidence_fingerprint,
      status: "approved",
      semantic_coverage: [],
      findings: [],
      summary: "This former seal no longer satisfies the current final-leaf contract.",
    };
    await writeFile(reviewController.sealedPath, prettyJson(staleReview), "utf8");
    await writeFile(
      reviewController.materializedFingerprintPath,
      `${sha256Json(materialize(plan, reviewController.evidence, planFingerprint).result)}\n`,
      "utf8",
    );

    await expect(readSealedCoverageReview(
      revision,
      planFingerprint,
      reviewController.evidence,
    )).resolves.toBeUndefined();
    const recovered = await CoverageReviewController.create(revision, planFingerprint);
    expect(JSON.parse(await readFile(recovered.workingPath, "utf8"))).toEqual(staleReview);
    expect((await recovered.readState()).opened_evidence_ids).toContain(opened.evidence_id);
    expect(existsSync(recovered.sealedPath)).toBe(false);
    expect((await readdir(recovered.root)).some((name) => name.startsWith("coverage-review.stale-")))
      .toBe(true);
  });

  test("incomplete typed coverage staging does not spend validation and full-text search remains available", async () => {
    const { workspace: revision, plan } = await manifestFor("coverage-preflight-search");
    const planController = await ToolController.create(revision);
    await planController.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await planController.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    const reviewController = await CoverageReviewController.create(
      revision,
      String(validated.fingerprint),
    );
    const searchable = reviewController.evidence.evidence[0]!;
    searchable.requires_disposition = false;
    searchable.evidence_scope = undefined;
    const query = searchable.text.slice(0, Math.min(6, searchable.text.length));
    const search = await reviewController.dispatch("search_review_evidence", { query });
    expect(search).toMatchObject({ ok: true });
    expect((search.matches as Array<{ evidence_id: string }>).map((entry) => entry.evidence_id))
      .toContain(searchable.evidence_id);

    const toolNames = createCoverageReviewTools(reviewController).map((tool) => tool.name);
    expect(toolNames).toContain("stage_coverage_review_draft");
    expect(toolNames).not.toContain("validate_coverage_review");
    expect(toolNames).not.toContain("patch_working_coverage_review");
    expect(toolNames).not.toContain("replace_working_coverage_review");

    const result = await reviewController.dispatch("stage_coverage_review_draft", {
      status: "approved",
      summary: "Incomplete checkpoint fixture.",
    });
    expect(result).toMatchObject({
      budget_consumed: false,
      coverage_checkpoint: {
        ready_for_validation: false,
        readiness_issues: expect.arrayContaining([
          expect.objectContaining({ code: "coverage_checkpoint_missing_final_items" }),
        ]),
      },
    });
    expect((await reviewController.readState()).validation_attempts).toBe(0);
  });

  test("mechanically invalid leaf evidence bindings do not spend coverage validation", async () => {
    const { workspace: revision, plan } = await manifestFor("coverage-local-binding-preflight");
    const planController = await ToolController.create(revision);
    await planController.dispatch("replace_working_plan", { content: prettyJson(plan) });
    for (const record of planController.evidence.evidence) {
      await planController.dispatch("open_evidence", { evidence_id: record.evidence_id });
    }
    const validated = await planController.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    const reviewController = await CoverageReviewController.create(revision, String(validated.fingerprint));
    const item = materialize(plan, planController.evidence, String(validated.fingerprint))
      .result.inspection_lots[0]!.items[0]!;
    const source = plan.acceptance_items[0]!;
    const validBinding = Object.values(source.field_bindings)
      .flatMap((binding) => binding.source_fragments)
      .map((fragment) => ({ evidence_id: fragment.evidence_id, exact_fragment: fragment.text }))[0]!;
    const unbound = planController.evidence.evidence.find((record) =>
      !item.evidence_ids.includes(record.evidence_id)
      && !item.reference_evidence_ids.includes(record.evidence_id)
    )!;
    await reviewController.dispatch("open_review_evidence", { evidence_id: validBinding.evidence_id });
    await reviewController.dispatch("open_review_evidence", { evidence_id: unbound.evidence_id });
    const primaryDispositions = coverageReviewObligations(planController.evidence, plan)
      .uncovered_primary_evidence_ids.map((evidenceId, index) => {
        const record = planController.evidence.evidence.find((candidate) => candidate.evidence_id === evidenceId)!;
        return {
          coverage_id: `coverage:primary:${index + 1}`,
          disposition: "irrelevant",
          judgment_id: "",
          item_ids: [],
          evidence_bindings: [{ evidence_id: record.evidence_id, exact_fragment: record.text }],
          reason: "This primary boundary context is not an independent final leaf.",
        };
      });
    for (const row of primaryDispositions) {
      await reviewController.dispatch("open_review_evidence", {
        evidence_id: row.evidence_bindings[0]!.evidence_id,
      });
    }

    const staged = await reviewController.dispatch("stage_coverage_review_draft", {
      status: "approved",
      summary: "Complete mandatory leaf with one mechanically invalid navigation binding.",
      semantic_coverage_upserts: [{
        coverage_id: "coverage:leaf:1",
        disposition: "acceptance_item",
        judgment_id: `judgment:${item.item_id}`,
        item_ids: [item.item_id],
        evidence_bindings: [validBinding, {
          evidence_id: unbound.evidence_id,
          exact_fragment: unbound.text,
        }],
        reason: "The valid source fragment covers the final leaf.",
      }, ...primaryDispositions],
    });

    expect(staged).toMatchObject({
      ok: true,
      error: "coverage_review_local_validation",
      budget_consumed: false,
      coverage_checkpoint: { ready_for_validation: true },
      local_issues: expect.arrayContaining([
        expect.objectContaining({
          code: "coverage_review_item_fragment_unbound",
          details: expect.objectContaining({
            allowed_bindings: expect.arrayContaining([
              expect.objectContaining({
                evidence_id: validBinding.evidence_id,
                exact_fragment_candidates: expect.arrayContaining([validBinding.exact_fragment]),
              }),
            ]),
          }),
        }),
      ]),
    });
    expect((await reviewController.readState()).validation_attempts).toBe(0);
    expect(await reviewController.dispatch("read_working_coverage_review", {})).toMatchObject({
      coverage_checkpoint: { ready_for_validation: true },
      local_preflight: {
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "coverage_review_item_fragment_unbound" }),
        ]),
      },
    });
  });

  test("mechanically prepares hashes only for Agent-selected exact field fragments", async () => {
    const revision = await workspace("prepare-field-bindings");
    const controller = await ToolController.create(revision);
    const evidence = controller.evidence.evidence.find((record) => record.text.length > 8)!;
    await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
    const exact = evidence.text.slice(0, 8);
    const empty = {
      value: "",
      composition: "not_applicable",
      source_fragments: [],
      reason: "原文未提供该字段",
    };
    const bindingInput = {
      fields: {
        name: {
          value: exact,
          composition: "verbatim",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: exact }],
          reason: "Agent 选择的项目名称原文",
        },
        requirement: empty,
        method: empty,
        quantity: empty,
        note: empty,
      },
    };
    const prepared = await controller.dispatch("prepare_field_bindings", bindingInput);
    expect(prepared).toMatchObject({
      ok: true,
      fields: { name: exact },
      field_bindings: {
        name: {
          status: "bound",
          composition: "verbatim",
          evidence_ids: [evidence.evidence_id],
          value_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    const rejected = await controller.dispatch("prepare_field_bindings", {
      fields: {
        name: {
          value: "伪造",
          composition: "verbatim",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: "证据中不存在的片段" }],
          reason: "不得通过",
        },
        requirement: empty,
        method: empty,
        quantity: empty,
        note: empty,
      },
    });
    expect(rejected).toMatchObject({ ok: false, error: "field_binding_fragment_not_exact" });

    for (let count = 2; count <= 4; count += 1) {
      expect(await controller.dispatch("prepare_field_bindings", bindingInput)).toMatchObject({
        ok: true,
        prepared_bindings_since_checkpoint: count,
        checkpoint_required: count === 4,
      });
    }
    expect(await controller.dispatch("prepare_field_bindings", bindingInput)).toMatchObject({
      ok: false,
      error: "incremental_checkpoint_required",
    });
    expect(await controller.dispatch("replace_working_plan", { content: "{}" })).toMatchObject({
      ok: false,
      error: "incremental_checkpoint_required_before_replace",
    });
    await controller.dispatch("patch_working_plan", {
      operations: [{
        op: "replace",
        path: "/evidence_dispositions",
        value: [{
          evidence_id: evidence.evidence_id,
          disposition: "context",
          item_ids: [],
          reason: "测试仅用该真实变更形成持久化检查点",
        }],
      }],
    });
    expect(await controller.dispatch("prepare_field_bindings", bindingInput)).toMatchObject({
      ok: true,
      prepared_bindings_since_checkpoint: 1,
      checkpoint_required: false,
    });
    expect(await controller.dispatch("prepare_field_bindings", {
      ...bindingInput,
      fields: {
        ...bindingInput.fields,
        name: {
          value: "检查点标题",
          composition: "semantic_summary",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: exact }],
          reason: "名称按对象和核心质量特性语义压缩，引用仍保持逐字原文",
        },
      },
    })).toMatchObject({
      ok: true,
      fields: { name: "检查点标题" },
      field_bindings: {
        name: {
          status: "bound",
          composition: "semantic_summary",
          evidence_ids: [evidence.evidence_id],
          value_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      prepared_bindings_since_checkpoint: 2,
    });
  });

  test("persists opened evidence across an interrupted Agent restart", async () => {
    const root = await artifactRoot("opened-evidence-restart");
    const revision = await RevisionWorkspace.create(
      root,
      "opened-evidence-restart-job",
      "4.1",
      fixtureMarkdown,
    );
    const first = await ToolController.create(revision);
    const evidence = first.evidence.evidence.find((record) => record.text.length > 8)!;
    await first.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
    expect((await readJson<RevisionState>(revision.statePath)).opened_evidence_ids)
      .toContain(evidence.evidence_id);
    await revision.updateState((state) => {
      delete state.opened_evidence_ids;
    });

    const reopened = await RevisionWorkspace.openLatest(
      root,
      "opened-evidence-restart-job",
      "4.1",
    );
    const second = await ToolController.create(reopened);
    expect((await readJson<RevisionState>(reopened.statePath)).opened_evidence_ids)
      .toContain(evidence.evidence_id);
    const exact = evidence.text.slice(0, 8);
    const empty = {
      value: "",
      composition: "not_applicable",
      source_fragments: [],
      reason: "原文未提供该字段",
    };
    expect(await second.dispatch("prepare_field_bindings", {
      fields: {
        name: {
          value: exact,
          composition: "verbatim",
          source_fragments: [{ evidence_id: evidence.evidence_id, text: exact }],
          reason: "重启后仍可使用已打开的证据",
        },
        requirement: empty,
        method: empty,
        quantity: empty,
        note: empty,
      },
    })).toMatchObject({ ok: true, fields: { name: exact } });
  });

  test("records a real failed validation, repairs, and seals", async () => {
    const revision = await workspace("offline-loop");
    const controller = await ToolController.create(revision);
    const sealed = await runOfflineFixture(revision, controller);
    expect(sealed).toMatchObject({ ok: true, status: "passed", revision: 1 });

    const state = await readJson<RevisionState>(revision.statePath);
    expect(state.status).toBe("sealed");
    expect(state.validation_attempts).toBe(2);
    const validations = await readdir(revision.validationDirectory);
    expect(validations).toEqual(["000001.json", "000002.json"]);
    expect((await readJson<{ ok: boolean }>(join(revision.validationDirectory, validations[0]!))).ok).toBe(false);
    expect((await readJson<{ ok: boolean }>(join(revision.validationDirectory, validations[1]!))).ok).toBe(true);

    const events = (await readFile(revision.transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    expect(events.some((event) =>
      event.event_type === "tool_execution_start"
      && event.payload.tool_name === "validate_working_plan"
    )).toBe(true);
    expect(events.some((event) => event.event_type === "agent_run_end")).toBe(true);
    const historyFiles = await readdir(revision.historyDirectory);
    expect(historyFiles).toEqual(["000001.json", "000002.json"]);
    expect(await readJson<{ operation: string }>(join(revision.historyDirectory, "000001.json")))
      .toMatchObject({ operation: "replace" });
    expect(await readJson<{ operation: string }>(join(revision.historyDirectory, "000002.json")))
      .toMatchObject({ operation: "json-patch" });
  });

  test("validated state prevents mutation and rejects a mismatched seal fingerprint", async () => {
    const { workspace: revision, plan } = await manifestFor("fingerprint");
    const controller = await ToolController.create(revision);
    const unverified = await controller.dispatch("seal_validated_plan", { fingerprint: "x" });
    expect(unverified).toMatchObject({ ok: false, error: "fingerprint_mismatch_or_unverified" });

    await controller.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await controller.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    expect(await controller.dispatch("patch_working_plan", {
      operations: [{ op: "replace", path: "/acceptance_items/0/name", value: "偷改后的项目" }],
    })).toMatchObject({ ok: false, error: "validated_plan_requires_seal" });
    const rejected = await controller.dispatch("seal_validated_plan", {
      fingerprint: `${validated.fingerprint}-mismatch`,
    });
    expect(rejected).toMatchObject({ ok: false, error: "fingerprint_mismatch_or_unverified" });
    expect(await readFile(revision.manifestPath, "utf8").catch(() => "")).toBe("");
  });

  test("records pre-validation normalization when derived dispositions actually change", async () => {
    const { workspace: revision, plan } = await manifestFor("normalization-history");
    const controller = await ToolController.create(revision);
    const removed = plan.evidence_dispositions.shift()!;
    await controller.dispatch("replace_working_plan", { content: prettyJson(plan) });
    expect(await controller.dispatch("validate_working_plan", {})).toMatchObject({ ok: true });
    expect(await readdir(revision.historyDirectory)).toEqual(["000001.json", "000002.json"]);
    const normalization = await readJson<{ operation: string; before_sha256: string; after_sha256: string }>(
      join(revision.historyDirectory, "000002.json"),
    );
    expect(normalization.operation).toBe("pre-validation-normalization");
    expect(normalization.before_sha256).not.toBe(normalization.after_sha256);
    const saved = await readJson<SemanticSourcePlan>(revision.workingPlanPath);
    expect(saved.evidence_dispositions).toContainEqual(expect.objectContaining({
      evidence_id: removed.evidence_id, disposition: "used",
    }));
  });

  test("recovers validated working state after restart", async () => {
    const root = await artifactRoot("restart");
    const revision = await RevisionWorkspace.create(root, "restart-job", "4.1", fixtureMarkdown);
    const first = await ToolController.create(revision);
    const plan = validFixturePlan(first.evidence);
    await first.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await first.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);

    const reopened = await RevisionWorkspace.openLatest(root, "restart-job", "4.1");
    const second = await ToolController.create(reopened);
    const sealed = await second.dispatch("seal_validated_plan", {
      fingerprint: validated.fingerprint,
    });
    expect(sealed.ok).toBe(true);
    expect((await readJson<RevisionState>(reopened.statePath)).status).toBe("sealed");
  });

  test("retires an interrupted partial seal into a new revision", async () => {
    const root = await artifactRoot("interrupted-seal");
    const revision = await RevisionWorkspace.create(
      root,
      "interrupted-seal-job",
      "4.1",
      fixtureMarkdown,
    );
    const controller = await ToolController.create(revision);
    const plan = validFixturePlan(controller.evidence);
    await controller.dispatch("replace_working_plan", { content: prettyJson(plan) });
    const validated = await controller.dispatch("validate_working_plan", {});
    expect(validated.ok).toBe(true);
    await revision.updateState((state) => {
      state.selector_stage = "coverage_repair";
      state.opened_evidence_ids = [controller.evidence.evidence[0]!.evidence_id];
      state.selector_protocol!.submissions = 1;
      state.repair = {
        ...(state.repair!),
        mode: "repair",
        repair_source: "coverage",
        coverage_review_fingerprint: String(validated.fingerprint),
        coverage_finding_ids: ["finding:test"],
        coverage_evidence_ids: [controller.evidence.evidence[0]!.evidence_id],
        coverage_item_ids: ["item:test"],
      };
    });
    const selectorsBefore = await readFile(revision.workingSelectorPath, "utf8");
    const registryBefore = await readFile(revision.sourceSpanRegistryPath, "utf8");
    await writeFile(revision.sealedPlanPath, "{\"partial\":true}\n", "utf8");

    const recovered = await RevisionWorkspace.reviseFromInterruptedSeal(
      root,
      "interrupted-seal-job",
      "4.1",
    );
    expect(recovered.revision).toBe(2);
    expect(await readFile(recovered.workingPlanPath, "utf8"))
      .toBe(await readFile(revision.lastValidPlanPath, "utf8"));
    expect(await readFile(revision.sealedPlanPath, "utf8"))
      .toBe("{\"partial\":true}\n");
    expect(await readFile(recovered.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    expect(await readFile(recovered.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
    expect(await recovered.readState()).toMatchObject({
      status: "working",
      selector_stage: "coverage_repair",
      opened_evidence_ids: [controller.evidence.evidence[0]!.evidence_id],
      selector_protocol: { submissions: 1 },
      repair: {
        mode: "repair",
        repair_source: "coverage",
        coverage_finding_ids: ["finding:test"],
        coverage_evidence_ids: [controller.evidence.evidence[0]!.evidence_id],
        coverage_item_ids: ["item:test"],
      },
      agent_runtime: { kind: "unassigned", session_id: "", session_file: "" },
    });
  });

  test("rejects terminal recovery without a trusted checkpoint or sealed ancestor", async () => {
    const root = await artifactRoot("terminal-failure");
    const first = await RevisionWorkspace.create(
      root,
      "terminal-failure-job",
      "4.1",
      fixtureMarkdown,
    );
    const selectors = await readFile(first.workingSelectorPath, "utf8");
    await first.writeBestSelectors(selectors);
    await writeFile(join(first.historyDirectory, "000003.json"), selectors, "utf8");
    await writeFile(join(first.validationDirectory, "000002.json"), "{}\n", "utf8");
    await writeFile(first.validationReceiptPath, "{\"ok\":true}\n", "utf8");
    await writeFile(join(first.coverageReviewDirectory, "checkpoint.json"), "{}\n", "utf8");
    await first.updateState((state) => {
      state.selector_stage = "commit";
      state.next_history_sequence = 4;
      state.next_validation_sequence = 3;
      state.opened_evidence_ids = ["evidence:test-opened"];
      state.opened_evidence_window_keys = ["evidence:test-opened:0:10"];
      state.opened_global_resource_ids = ["atom:test-global"];
      state.selector_protocol.submissions = 1;
      state.selector_protocol.last_issue_owner = "selector_input_error";
      state.selector_protocol.last_issue_fingerprint = "a".repeat(64);
      state.agent_runtime = {
        kind: "pi-sdk",
        session_id: "old-session",
        session_file: "old-session.jsonl",
      };
    });
    await first.markTerminal("failed", "compiler_invariant_violation");

    await expect(RevisionWorkspace.reviseFromTerminalFailure(
      root,
      "terminal-failure-job",
      "4.1",
    )).rejects.toThrow(
      "Terminal failure recovery requires a trusted selector checkpoint or sealed ancestor",
    );
    expect(await first.readState()).toMatchObject({
      status: "failed",
      terminal_reason: "compiler_invariant_violation",
    });
    expect((await readdir(join(first.root, "..")))
      .filter((name) => /^\d{6}$/u.test(name))).toEqual(["000001"]);
  });

  test("rebuilds opened evidence from committed selector spans after a legacy recovery cleared the cache", async () => {
    const root = await artifactRoot("opened-from-selectors");
    const revision = await RevisionWorkspace.create(
      root,
      "opened-from-selectors-job",
      "4.1",
      fixtureMarkdown,
    );
    const firstController = await ToolController.create(revision);
    const evidenceId = firstController.evidence.evidence[0]!.evidence_id;
    const registry = await revision.readSourceSpanRegistry();
    const fullSpan = registry.spans.find((span) => span.evidence_id === evidenceId)!;
    const selectors = await readJson<Record<string, unknown>>(revision.workingSelectorPath);
    selectors.source_dispositions = [{
      span_ids: [fullSpan.span_id],
      disposition: "context",
      reason: "Committed selector evidence checkpoint",
    }];
    await revision.writeWorkingSelectors(prettyJson(selectors));
    await revision.updateState((state) => {
      state.selector_protocol.submissions = 1;
      state.opened_evidence_ids = [];
    });

    await ToolController.create(revision);
    expect((await revision.readState()).opened_evidence_ids).toContain(evidenceId);
  });

  test("sealed revision cannot be edited and changes require a new revision", async () => {
    const root = await artifactRoot("immutable");
    const first = await RevisionWorkspace.create(root, "immutable-job", "4.1", fixtureMarkdown);
    const controller = await ToolController.create(first);
    await runOfflineFixture(first, controller);
    const sealedBefore = await readFile(first.sealedPlanPath, "utf8");
    await expect(
      controller.dispatch("replace_working_plan", { content: "{}\n" }),
    ).resolves.toMatchObject({ ok: false, error: "target_tool_rejected", actual_error: expect.stringMatching(/sealed/i), instruction: expect.any(String) });
    expect(await readFile(first.sealedPlanPath, "utf8")).toBe(sealedBefore);

    const second = await RevisionWorkspace.reviseFromSealed(root, "immutable-job", "4.1");
    expect(second.revision).toBe(2);
    expect(await readFile(second.workingPlanPath, "utf8")).toBe(sealedBefore);
    const secondController = await ToolController.create(second);
    await expect(secondController.dispatch("patch_working_plan", {
      operations: [{ op: "replace", path: "/acceptance_items/0/note", value: "新 revision" }],
    })).resolves.toMatchObject({ ok: true });
    expect(await readFile(first.sealedPlanPath, "utf8")).toBe(sealedBefore);
  });

  test("same input and plan produce byte-identical business results", async () => {
    const left = await RevisionWorkspace.create(
      await artifactRoot("deterministic-left"),
      "deterministic-job",
      "4.1",
      fixtureMarkdown,
    );
    const right = await RevisionWorkspace.create(
      await artifactRoot("deterministic-right"),
      "deterministic-job",
      "4.1",
      fixtureMarkdown,
    );
    await runOfflineFixture(left, await ToolController.create(left));
    await runOfflineFixture(right, await ToolController.create(right));
    const leftResult = await readFile(left.resultPath, "utf8");
    const rightResult = await readFile(right.resultPath, "utf8");
    expect(rightResult).toBe(leftResult);
    const result = JSON.parse(leftResult) as AcceptanceResult;
    expect(result.inspection_lots[0]?.items).toHaveLength(1);
  });

  test("manifest fingerprints sealed bytes and transcript prefix", async () => {
    const revision = await workspace("manifest");
    await runOfflineFixture(revision, await ToolController.create(revision));
    const manifest = await readJson<{
      status: string;
      validated_submit: boolean;
      fingerprints: { files: Record<string, string> };
      transcript_prefix: { through_sequence: number; sha256: string };
    }>(revision.manifestPath);
    expect(manifest).toMatchObject({ status: "passed", validated_submit: true });
    const sealed = await readFile(revision.sealedPlanPath, "utf8");
    expect(manifest.fingerprints.files["semantic-source-plan.json"]).toBe(sha256Text(sealed));
    const tableAssembly = await readFile(revision.tableAssemblyPlanPath, "utf8");
    expect(manifest.fingerprints.files["table-assembly-plan.json"])
      .toBe(sha256Text(tableAssembly));
    expect(JSON.parse(sealed).table_assembly).toEqual(JSON.parse(tableAssembly));
    expect(manifest.transcript_prefix.through_sequence).toBeGreaterThan(0);
    expect(manifest.transcript_prefix.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not manufacture repairs after sealing a valid current-contract candidate", async () => {
    const revision = await workspace("sealed-audit");
    await runOfflineFixture(revision, await ToolController.create(revision));
    const before = await readFile(revision.sealedPlanPath, "utf8");
    const audit = await auditSealedRevision(revision);
    expect(audit.status).toBe("passed");
    expect(audit.findings).toEqual([]);
    const repair = buildBoundedRepairPlan(audit);
    expect(repair).toMatchObject({ creates_new_revision: true, max_rounds: 1 });
    expect(repair.actions).toEqual([]);
    expect(await readFile(revision.sealedPlanPath, "utf8")).toBe(before);
  });

  test.each([
    ["missing lots", "{}\n"],
    ["invalid JSON", "{\n"],
    ["null result", "null\n"],
    ["wrong lots type", '{"inspection_lots":{}}\n'],
    ["null lot", '{"inspection_lots":[null]}\n'],
    ["missing items", '{"inspection_lots":[{}]}\n'],
    ["null item", '{"inspection_lots":[{"items":[null]}]}\n'],
  ])("independent audit reports external mutation without crashing: %s", async (_name, content) => {
    const revision = await workspace("sealed-audit-tamper");
    await runOfflineFixture(revision, await ToolController.create(revision));
    await chmod(revision.resultPath, 0o644);
    await writeFile(revision.resultPath, content, "utf8");
    const audit = await auditSealedRevision(revision);
    expect(audit.status).toBe("failed");
    expect(audit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "sealed.file_fingerprint" }),
      expect.objectContaining({ rule_id: "materializer.result_replay" }),
    ]));
  });

  test("separate targets never share a working JSON file", async () => {
    const root = await artifactRoot("multi-target");
    const left = await RevisionWorkspace.create(root, "multi-job", "4.1", fixtureMarkdown);
    const right = await RevisionWorkspace.create(root, "multi-job", "5.1", realMarkdown);
    expect(left.workingPlanPath).not.toBe(right.workingPlanPath);
    await runOfflineFixture(left, await ToolController.create(left));
    expect((await readJson<RevisionState>(right.statePath)).status).toBe("working");
  });

  test("binds the real pdf_ex_code PDF/Markdown pair and seals it offline", async () => {
    const revision = await RevisionWorkspace.create(
      await artifactRoot("real-pair"),
      "gb50310-real",
      "4.1",
      realMarkdown,
      realPdf,
    );
    const manifest = await revision.readEvidenceManifest();
    const pdfBytes = await readFile(realPdf);
    expect(manifest.source.pdf_file_name).toBe("GB_50310-2002.pdf");
    expect(manifest.source.pdf_sha256).toBe(sha256Bytes(pdfBytes));
    expect(manifest.scope).toMatchObject({
      mode: "target_section",
      selected_start_line: 191,
      selected_end_exclusive_line: 217,
    });
    expect(manifest.evidence.length).toBeGreaterThan(5);
    expect(manifest.evidence.length).toBeLessThan(30);
    expect(manifest.evidence.every((record) => {
      if (record.role === "sampling_rule") return true;
      const line = Number(record.locator.slice("line:".length));
      return line >= 191 && line < 217;
    })).toBe(true);
    expect(manifest.evidence.some((record) => record.text.includes("4.2 土建交接检验"))).toBe(false);
    expect(await readJson(revision.evidenceScopePath)).toEqual(manifest.scope);
    await runOfflineFixture(revision, await ToolController.create(revision));
    expect((await readJson<RevisionState>(revision.statePath)).status).toBe("sealed");
  });
});
