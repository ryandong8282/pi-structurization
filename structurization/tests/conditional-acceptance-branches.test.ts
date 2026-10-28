import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Text } from "../src/canonical.js";
import { ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE, SELECTOR_FIELD_ROLE_GUIDANCE } from "../src/acceptance-delivery-contract.js";
import { TARGET_SELECTOR_PROTOCOLS, LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE } from "../src/acceptance-prompt-suite.js";
import { TARGET_SELECTOR_SYSTEM_PROMPT, COVERAGE_REVIEW_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { classifySelectorIssue } from "../src/selector-issue-ownership.js";
import { CoverageReviewController } from "../src/coverage-review.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  TARGET_SELECTOR_ITEM_JSON_SCHEMA,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  sourceSpanCoveredBy,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:conditional-acceptance";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "conditional-acceptance-job",
    target_id: "target-installation",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-installation",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "安装与连接",
      selection_reason: "合成条件分支回归",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`evidence\0${text}`),
  };
}

function fixture() {
  const text = "表9.3.9 构件垂直度 柱、墙板安装后的高度 ≤6m 5mm >6m 10mm 相邻构件平整度 梁、楼板底面 外露 3mm 允许偏差(mm) 经纬仪或吊线、尺量";
  const manifest = manifestFor(text);
  const source = {
    source_id: manifest.evidence[0]!.evidence_id,
    evidence_id: manifest.evidence[0]!.evidence_id,
    atom_id: manifest.evidence[0]!.evidence_id,
    text,
  };
  let registry: SourceSpanRegistry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
  const ids = new Map<string, string>();
  for (const quote of [
    text, "表9.3.9", "构件垂直度", "柱、墙板安装后的高度", "≤6m", "5mm", ">6m", "10mm",
    "相邻构件平整度", "梁、楼板底面", "外露", "3mm", "允许偏差(mm)", "经纬仪或吊线、尺量",
  ]) {
    const located = locateAndRegisterSourceQuote(registry, source, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  const id = (quote: string) => ids.get(quote)!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "installation", name: "安装与连接", scope_span_ids: [id(text)], reason: "表9.3.9验收范围" });
  const item = (
    key: string,
    dimension: string,
    applicability: string,
    condition: string,
    allowedValue: string,
  ): TargetSelectorPlan["items"][number] => ({
    key,
    lot_key: "installation",
    name: `${dimension}${applicability}`,
    category: "一般项目",
    criterion_span_ids: [id(dimension), id(applicability), id(condition), id(allowedValue)],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [id(dimension), id(applicability)], separator: " ", reason: "同一受检维度" },
      requirement: { composition: "verbatim", span_ids: [id(condition), id(allowedValue)], separator: " ", reason: "条件及允许值" },
      method: { composition: "verbatim", span_ids: [id("经纬仪或吊线、尺量")], separator: "", reason: "表列方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "本合成例不测试抽样" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: {
      source_kind: "direct",
      table_key: "9.3.9",
      properties: {
        table_no_span_ids: [id("表9.3.9")],
        table_title_span_ids: [],
        applicability_span_ids: [id(applicability)],
        row_path_span_ids: [[id(dimension), id(applicability), id(condition)]],
        column_path_span_ids: [[id("允许偏差(mm)")]],
        unit_span_ids: [id("允许偏差(mm)")],
        condition_span_ids: [id(condition)],
        allowed_value_span_ids: [id(allowedValue)],
        inspection_method_span_ids: [id("经纬仪或吊线、尺量")],
      },
      reference_span_ids: [],
      reason: "表格条件允许值分支",
    },
    inspection_data_type: "measurement",
    inspection_data_type_reason: "按允许偏差进行量测判定。",
    inspection_data_type_span_ids: [id(allowedValue)],
    sampling: {
      status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "本合成例不测试抽样", confidence: 1,
    },
    reason: "一个可独立判定的表格维度",
  });
  return { manifest, registry, selectors, id, item };
}

function compile(prepared: ReturnType<typeof fixture>) {
  return hydrateSemanticSourcePlan(
    compileTargetSelectors(prepared.selectors, prepared.registry, prepared.manifest),
    prepared.manifest,
  );
}

function mergeHeightBranches(prepared: ReturnType<typeof fixture>) {
  const item = prepared.item("verticality", "构件垂直度", "柱、墙板安装后的高度", "≤6m", "5mm");
  const properties = item.table!.properties;
  item.criterion_span_ids.push(prepared.id(">6m"), prepared.id("10mm"));
  item.fields.requirement.span_ids = [prepared.id("≤6m"), prepared.id("5mm"), prepared.id(">6m"), prepared.id("10mm")];
  item.inspection_data_type_span_ids.push(prepared.id("10mm"));
  properties.row_path_span_ids.push([prepared.id("构件垂直度"), prepared.id("柱、墙板安装后的高度"), prepared.id(">6m")]);
  properties.condition_span_ids = [prepared.id("≤6m"), prepared.id(">6m")];
  properties.allowed_value_span_ids = [prepared.id("5mm"), prepared.id("10mm")];
  properties.acceptance_branches = [
    { key: "height-le6", condition_span_ids: [prepared.id("≤6m")], requirement_span_ids: [prepared.id("≤6m"), prepared.id("5mm")], allowed_value_span_ids: [prepared.id("5mm")], reason: "高度不大于6m时" },
    { key: "height-gt6", condition_span_ids: [prepared.id(">6m")], requirement_span_ids: [prepared.id(">6m"), prepared.id("10mm")], allowed_value_span_ids: [prepared.id("10mm")], reason: "高度大于6m时" },
  ];
  prepared.selectors.items.push(item);
}

function registerQuote(prepared: ReturnType<typeof fixture>, quote: string, evidenceIndex = 0): string {
  const evidence = prepared.manifest.evidence[evidenceIndex]!;
  const located = locateAndRegisterSourceQuote(prepared.registry, {
    source_id: evidence.evidence_id, evidence_id: evidence.evidence_id, atom_id: evidence.evidence_id, text: evidence.text,
  }, quote);
  prepared.registry = located.registry;
  return located.spans[0]!.span_id;
}

function compileIssues(prepared: ReturnType<typeof fixture>) {
  try { compile(prepared); return []; } catch (error) {
    if (!(error instanceof TargetSelectorCompileError)) throw error;
    return error.issues;
  }
}

describe("conditional acceptance branches", () => {
  test.each(["branch", "visible", "both"] as const)("accepts same-source interval coverage in %s requirements without copying child IDs", (level) => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const item = prepared.selectors.items[0]!;
    const whole = [registerQuote(prepared, "≤6m 5mm"), registerQuote(prepared, ">6m 10mm")];
    item.criterion_span_ids.push(...whole);
    if (level !== "visible") item.table!.properties.acceptance_branches!.forEach((branch, index) => { branch.requirement_span_ids = [whole[index]!]; });
    if (level !== "branch") item.fields.requirement.span_ids = whole;
    // In the branch-only case keep the separating spaces, so the smaller spans
    // jointly cover the whole source interval without introducing a gap.
    if (level === "branch") item.fields.requirement.span_ids = [registerQuote(prepared, "≤6m "), prepared.id("5mm"), registerQuote(prepared, ">6m "), prepared.id("10mm")];
    const before = structuredClone(prepared.selectors);
    const persisted = compileTargetSelectors(prepared.selectors, prepared.registry, prepared.manifest);
    const plan = hydrateSemanticSourcePlan(persisted, prepared.manifest);
    expect(validatePlanText(JSON.stringify(persisted), prepared.manifest).issues).toEqual([]);
    expect(prepared.selectors).toEqual(before);
    expect(plan.acceptance_items).toHaveLength(1);
    expect(plan.acceptance_items[0]!.table_semantics!.acceptance_branches).toHaveLength(2);
  });

  test("still rejects partial coverage and points visibility repair at the visible field", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const item = prepared.selectors.items[0]!;
    const partial = registerQuote(prepared, "≤6m 5m");
    item.criterion_span_ids.push(partial);
    item.fields.requirement.span_ids = [partial, prepared.id(">6m"), prepared.id("10mm")];
    const issue = compileIssues(prepared).find(issue => issue.code === "selector_acceptance_branch_requirement_not_visible");
    expect(issue).toMatchObject({ details: {
      writable_path: "/items/0/fields/requirement/span_ids",
      actual: { uncovered_spans: [expect.objectContaining({ span_id: prepared.id("5mm"), text: "5mm" })] },
      candidate_read_tools: expect.arrayContaining(["read_target_selectors", "read_table_summary", "read_table_rows"]),
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "items", key: item.key },
      save_tool: "stage_target_selector_draft",
    } });
    expect(classifySelectorIssue("selector-local", issue!)).toMatchObject({
      owner: "selector_input_error", details: {
        writable_path: "/items/0/fields/requirement/span_ids", next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: item.key }, save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("fields.requirement.span_ids"), actual: { item_key: item.key },
      },
    });
  });

  test("does not equate identical text from a different source", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const duplicate = { ...prepared.manifest.evidence[0]!, evidence_id: "atom:another-source", requires_disposition: false };
    prepared.manifest.evidence.push(duplicate);
    const other = registerQuote(prepared, "≤6m 5mm", 1);
    prepared.selectors.items[0]!.fields.requirement.span_ids = [other, prepared.id(">6m"), prepared.id("10mm")];
    expect(compileIssues(prepared).some(issue => issue.code === "selector_acceptance_branch_requirement_not_visible")).toBe(true);
  });

  test("still rejects a branch requirement that genuinely omits its selected allowed value", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    prepared.selectors.items[0]!.table!.properties.acceptance_branches![0]!.requirement_span_ids = [prepared.id("≤6m")];
    expect(compileIssues(prepared)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "selector_acceptance_branch_requirement_incomplete",
      details: expect.objectContaining({ writable_path: "/items/0/table/properties/acceptance_branches/0/requirement_span_ids" }),
    })]));
  });

  test("compiled validation also rejects equal text from another evidence atom", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const plan = compileTargetSelectors(prepared.selectors, prepared.registry, prepared.manifest);
    const duplicate = { ...prepared.manifest.evidence[0]!, evidence_id: "atom:another-source", requires_disposition: false };
    prepared.manifest.evidence.push(duplicate);
    const other = registerQuote(prepared, "≤6m", 1);
    const { atom_id: _atom, ...span } = prepared.registry.spans.find(span => span.span_id === other)!;
    plan.source_spans.push(span);
    plan.acceptance_items[0]!.field_bindings.requirement.source_span_ids[0] = other;
    plan.acceptance_items[0]!.field_bindings.requirement.evidence_ids.push(duplicate.evidence_id);
    expect(validatePlanText(JSON.stringify(plan), prepared.manifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_acceptance_branch_relation", details: expect.objectContaining({
        missing_requirement_fragments: [{ evidence_id: prepared.manifest.evidence[0]!.evidence_id, text: "≤6m" }],
      }) }),
    ]));
  });

  test("coverage uses source coordinates, accepts adjacent pieces and rejects holes or other positions", () => {
    const target = { evidence_id: "source", start: 10, end: 20 };
    expect(sourceSpanCoveredBy(target, [{ ...target, end: 15 }, { ...target, start: 15 }])).toBe(true);
    expect(sourceSpanCoveredBy(target, [{ ...target, end: 14 }, { ...target, start: 15 }])).toBe(false);
    expect(sourceSpanCoveredBy(target, [{ ...target, start: 30, end: 40 }])).toBe(false);
    expect(sourceSpanCoveredBy(target, [{ ...target, evidence_id: "other" }])).toBe(false);
  });

  test("system/tool shared guidance and item schema describe the same source-only coverage contract", () => {
    expect(TARGET_SELECTOR_PROTOCOLS.branches).toBe(ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE);
    expect(JSON.stringify(TARGET_SELECTOR_ITEM_JSON_SCHEMA)).toContain(ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE);
    expect(ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE).toContain("不需重复内部子 span");
    expect(ACCEPTANCE_BRANCH_SOURCE_COVERAGE_GUIDANCE).toContain("由你决定配对含义");
  });

  test("accepts mutually exclusive height cases as lossless split leaves", () => {
    const prepared = fixture();
    prepared.selectors.items.push(
      prepared.item("verticality-le6", "构件垂直度", "柱、墙板安装后的高度", "≤6m", "5mm"),
      prepared.item("verticality-gt6", "构件垂直度", "柱、墙板安装后的高度", ">6m", "10mm"),
    );

    expect(compile(prepared).acceptance_items.map((candidate) => candidate.name)).toEqual([
      "构件垂直度柱、墙板安装后的高度",
      "构件垂直度柱、墙板安装后的高度",
    ]);
  });

  test("materializes one leaf with two authoritative condition-to-requirement/value branches and exact provenance", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);

    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(prepared);
    } catch (error) {
      throw new Error(JSON.stringify((error as TargetSelectorCompileError).issues));
    }
    expect(compiled.acceptance_items).toHaveLength(1);
    expect(compiled.acceptance_items[0]!.note).toBe("");
    expect(compiled.acceptance_items[0]!.table_semantics?.acceptance_branches).toEqual([
      expect.objectContaining({ condition: "≤6m", requirement: "≤6m 5mm", allowed_value: "5mm", condition_fragments: [{ evidence_id: prepared.manifest.evidence[0]!.evidence_id, text: "≤6m" }] }),
      expect.objectContaining({ condition: ">6m", requirement: ">6m 10mm", allowed_value: "10mm", condition_fragments: [{ evidence_id: prepared.manifest.evidence[0]!.evidence_id, text: ">6m" }] }),
    ]);
    expect(validatePlanText(JSON.stringify(compiled), prepared.manifest, new Set([prepared.manifest.evidence[0]!.evidence_id])))
      .toMatchObject({ ok: true, issues: [] });
  });

  test("duplicate branch diagnostics identify exact branch keys and condition coverage diffs", () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const branches = prepared.selectors.items[0]!.table!.properties.acceptance_branches!;
    branches[1]!.condition_span_ids = [...branches[0]!.condition_span_ids];
    try {
      compile(prepared);
      throw new Error("Expected duplicate condition branches to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_acceptance_branch_condition_duplicate",
          message: "互斥的验收分支不得重复使用同一条件。",
          details: expect.objectContaining({
            duplicate_condition_groups: [expect.objectContaining({
              branches: expect.arrayContaining([
                expect.objectContaining({ key: "height-le6" }),
                expect.objectContaining({ key: "height-gt6" }),
              ]),
            })],
          }),
        }),
        expect.objectContaining({
          code: "selector_acceptance_branch_condition_coverage",
          message: "验收分支必须完整且仅覆盖当前验收项的权威表格条件来源区间。",
          details: expect.objectContaining({
            missing_from_branches: [prepared.id(">6m")],
            extra_in_branches: [],
          }),
        }),
      ]));
    }
  });

  test("exposes the authoritative acceptance branch contract in Coverage leaf details", async () => {
    const prepared = fixture();
    mergeHeightBranches(prepared);
    const plan = compile(prepared);
    const validation = validatePlanText(JSON.stringify(plan), prepared.manifest);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    const root = await mkdtemp(join(tmpdir(), "coverage-acceptance-branches-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        prepared.manifest.job_id,
        prepared.manifest.target_id,
        { manifest: prepared.manifest, markdown: Buffer.from(prepared.manifest.evidence[0]!.text, "utf8") },
      );
      await writeFile(workspace.lastValidPlanPath, JSON.stringify(plan), "utf8");
      const state = await workspace.readState();
      state.last_valid_fingerprint = validation.fingerprint!;
      state.last_valid_plan_sha256 = validation.plan_sha256!;
      await workspace.writeState(state);
      const controller = await CoverageReviewController.create(workspace, validation.fingerprint!);
      const details = await controller.dispatch("read_candidate_leaf_details", { item_ids: [plan.acceptance_items[0]!.item_id] });
      expect(details).toMatchObject({
        ok: true,
        details: [{
          item_id: plan.acceptance_items[0]!.item_id,
          acceptance_branch_contract: [
            expect.objectContaining({ condition: "≤6m", requirement: "≤6m 5mm", allowed_value: "5mm" }),
            expect.objectContaining({ condition: ">6m", requirement: ">6m 10mm", allowed_value: "10mm" }),
          ],
        }],
      });
      expect(JSON.stringify(details)).not.toContain('"note":"≤6m');
      expect(details.instruction).toContain("do not request separate leaves solely as a representation preference");
      expect(details.instruction).toContain("Lossless split items are also valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps genuinely different dimensions independent when their applicability conditions differ", () => {
    const prepared = fixture();
    prepared.selectors.items.push(
      prepared.item("verticality", "构件垂直度", "柱、墙板安装后的高度", "≤6m", "5mm"),
      prepared.item("flatness", "相邻构件平整度", "梁、楼板底面", "外露", "3mm"),
    );

    expect(compile(prepared).acceptance_items.map((candidate) => candidate.name)).toEqual([
      "构件垂直度柱、墙板安装后的高度",
      "相邻构件平整度梁、楼板底面",
    ]);
  });

  test("keeps selector and Coverage reviewer on the same lossless-alternative, no-note contract", () => {
    for (const prompt of [TARGET_SELECTOR_SYSTEM_PROMPT, COVERAGE_REVIEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE);
    }
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain("可以无损拆项，也可以用 acceptance_branches");
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain("条件—限值—单位—判据—来源");
    expect(LOSSLESS_REPRESENTATION_EQUIVALENCE_RULE).toContain("不用平铺并集、名称或 note 替代配对");
    expect(TARGET_SELECTOR_PROTOCOLS.branches).toContain("requirement_span_ids");
  });
});
