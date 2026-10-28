import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { compileTargetSelectors, initialTargetSelectorPlan, TargetSelectorCompileError } from "../src/target-selector-compiler.js";
import { registryWithFullSourceSpans, locateAndRegisterSourceQuote } from "../src/source-span-registry.js";
import { validatePlanText } from "../src/validator.js";
import { materialize } from "../src/materializer.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";

// Synthetic evidence only: no live-job names, expected business answers or counts.
function fixture(requirementText = "2.1.1 涂层表面应平整。", otherText = "另一个分支检查三件。") {
  const texts = ["1.1.1 检验应符合本规范第2.1节的规定。", requirementText, "样本应均匀分布。", "每批抽查两件。", otherText];
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "coverage-fixture", target_id: "coverage-target",
    source: { adapter: "document-domain-agent/v1", file_name: "source.md", sha256: sha256Text(texts.join("\n")), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "coverage-target", source_line_count: 5,
      selected_start_line: 1, selected_end_exclusive_line: 2, selected_heading: "", selection_reason: "测试范围", selected_atom_ids: ["e:0"], target_evidence_fragments: [{ atom_id: "e:0", text: texts[0]! }], candidates: [] },
    evidence: texts.map((text, i) => ({ evidence_id: `e:${i}`, kind: "paragraph", role: "supporting_clause", locator: `line:${i + 1}`, text, text_sha256: sha256Text(text), requires_disposition: i === 0, evidence_scope: i === 0 ? "primary" : "reference" })),
    table_fragments: [], reference_occurrences: [], evidence_fingerprint: sha256Text(texts.join("\0")),
  };
  const sources = manifest.evidence.map(e => ({ source_id: e.evidence_id, evidence_id: e.evidence_id, atom_id: e.evidence_id, text: e.text }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const ids = sources.map(source => registry.spans.find(s => s.evidence_id === source.evidence_id)!.span_id);
  const literal = locateAndRegisterSourceQuote(registry, sources[0]!, "本规范第2.1节");
  registry = literal.registry;
  const anchor = literal.spans[0]!.span_id;
  manifest.reference_occurrences.push({ occurrence_id: "reference:fixture", origin_evidence_id: "e:0", origin_fields: ["requirement"],
    origin_span_id: ids[0]!, reference_literal_span_id: anchor, reference_literal: { evidence_id: "e:0", start: literal.spans[0]!.start, end: literal.spans[0]!.end },
    raw_reference: "本规范第2.1节", relation: "测试章节引用", reference_kind: "clause", target_address: { source_id: "source", locator_kind: "section", locator: "section:2.1" },
    // The unselected sibling is in the rule envelope, outside this reference.
    target_evidence_ids: ["e:1", "e:2", "e:3"], required: true, status: "resolved", depth: 1, path: ["source:section:2.1"] });
  const plan = initialTargetSelectorPlan(manifest);
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const, span_ids, separator: "", reason: "保留绑定" });
  plan.lots.push({ key: "lot", name: "涂层检验批", scope_span_ids: [ids[0]!], reason: "引用范围" });
  plan.items.push({ key: "surface", lot_key: "lot", name: "涂层表面质量", category: "一般项目", criterion_span_ids: [ids[1]!], continuation_span_ids: [],
    fields: { name: { ...field([ids[1]!]), composition: "semantic_summary" }, requirement: field([ids[1]!]), method: field([]), quantity: field([ids[3]!]), note: field([]) },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "原文核查", inspection_data_type_span_ids: [ids[1]!],
    sampling: { status: "reference", rule_key: "shared", branch_keys: ["selected"], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "明确选用", confidence: 1 }, reason: "真实判断" });
  const roles = ["applicability", "branch_condition", "method", "quantity", "acceptance_criterion", "exception", "note"] as const;
  plan.sampling_rules.push({ key: "shared", complete_span_ids: [ids[2]!, ids[3]!, ids[4]!], components: roles.map(role => ({ key: role, role,
    disposition: role === "applicability" || role === "quantity" ? "present" : "absent", span_ids: role === "applicability" ? [ids[2]!] : role === "quantity" ? [ids[3]!] : [], reason: "显式组件" })),
    branches: [{ key: "selected", applies_to_category: "all_items", components: [], reason: "已选分支" },
      { key: "other", applies_to_category: "all_items", components: [{ key: "quantity", role: "quantity", disposition: "present", span_ids: [ids[4]!], reason: "未选分支" }], reason: "其他分支" }], reason: "共享规则" });
  plan.references.push({ key: "reference", occurrence_id: "reference:fixture", anchor_span_ids: [anchor], target_span_ids: [ids[1]!, ids[2]!, ids[3]!], action: "keep_reference",
    application_mode: "reference_placeholder", import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["name", "requirement", "quantity", "sampling"], reason: "章节占位" }, destinations: [], reason: "内容已有接收" });
  return { manifest, registry, plan, ids };
}

function issues(f: ReturnType<typeof fixture>) {
  try { compileTargetSelectors(f.plan, f.registry, f.manifest); return []; }
  catch (error) { if (!(error instanceof TargetSelectorCompileError)) throw error; return error.issues; }
}

function bindRequirementFragments(f: ReturnType<typeof fixture>, quotes: string[]) {
  const evidence = f.manifest.evidence[1]!;
  const ids = quotes.flatMap(quote => {
    const located = locateAndRegisterSourceQuote(f.registry, { source_id: evidence.evidence_id, evidence_id: evidence.evidence_id, text: evidence.text }, quote);
    f.registry = located.registry;
    return located.spans.map(span => span.span_id);
  });
  const item = f.plan.items[0]!;
  item.criterion_span_ids = ids;
  item.fields.name.span_ids = ids;
  item.fields.requirement.span_ids = ids;
  item.inspection_data_type_span_ids = ids;
}

describe("reference coverage feedback", () => {
  function referencedMethodFixture() {
    const f = fixture("2.1.1 涂层表面应平整。方法按本规范第2.1.2条执行。", "检验方法：用偏振片观察表面纹理。");
    f.plan.sampling_rules[0]!.complete_span_ids = [f.ids[2]!, f.ids[3]!];
    f.plan.sampling_rules[0]!.branches = [f.plan.sampling_rules[0]!.branches[0]!];
    f.manifest.reference_occurrences[0]!.target_evidence_ids.push("e:4");
    f.plan.references[0]!.target_span_ids.push(f.ids[4]!);
    f.plan.references[0]!.import_scope.allowed_fields.push("method");
    const located = locateAndRegisterSourceQuote(f.registry, { source_id: "e:1", evidence_id: "e:1", text: f.manifest.evidence[1]!.text }, "本规范第2.1.2条");
    f.registry = located.registry;
    const anchor = located.spans[0]!;
    f.manifest.reference_occurrences.push({ ...f.manifest.reference_occurrences[0]!, occurrence_id: "reference:method", origin_evidence_id: "e:1", origin_fields: ["method"],
      origin_span_id: f.ids[1]!, reference_literal_span_id: anchor.span_id, reference_literal: { evidence_id: "e:1", start: anchor.start, end: anchor.end },
      raw_reference: "本规范第2.1.2条", target_evidence_ids: ["e:4"], target_address: { source_id: "source", locator_kind: "clause", locator: "clause:2.1.2" } });
    f.plan.references.push({ key: "method", occurrence_id: "reference:method", anchor_span_ids: [anchor.span_id], target_span_ids: [f.ids[4]!], action: "keep_reference", application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["method"], reason: "嵌套方法引用" }, destinations: [{ item_key: "surface", target_field: "method" }], reason: "实际方法字段接收" });
    f.plan.items[0]!.fields.method = { composition: "reference", span_ids: [f.ids[1]!, f.ids[4]!], separator: "", reason: "方法由被引章节的实际方法句承接。" };
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    return { ...f, compiled, hydrated };
  }

  test("a real referenced method closes a chapter placeholder without becoming direct evidence or a destination", () => {
    const f = referencedMethodFixture(), before = structuredClone(f.compiled);
    expect(f.hydrated.acceptance_items[0]!.evidence_ids).not.toContain("e:4");
    expect(f.hydrated.acceptance_items[0]!.field_bindings.method.evidence_ids).toContain("e:4");
    expect(f.compiled.reference_resolutions[0]!.destination_bindings).toEqual([]);
    expect(validatePlanText(JSON.stringify(f.compiled), f.manifest)).toMatchObject({ ok: true, issues: [] });
    expect(materialize(f.hydrated, f.manifest, "fixture").result.inspection_lots[0]!.items[0]!.method).toContain(f.manifest.evidence[4]!.text);
    expect(f.compiled).toEqual(before);
  });

  test("table placeholder coverage also counts a row actually received by a method field", () => {
    const f = referencedMethodFixture();
    Object.assign(f.manifest.evidence[4]!, { kind: "table_row", table_row_kind: "data", table_id: "T" });
    Object.assign(f.manifest.reference_occurrences[0]!, { reference_kind: "table", target_table_id: "T", target_evidence_ids: ["e:4"] });
    f.compiled.reference_resolutions[0]!.target_evidence_ids = ["e:4"];
    expect(validatePlanText(JSON.stringify(f.compiled), f.manifest)).toMatchObject({ ok: true, issues: [] });
  });

  test.each(["clause", "table"].flatMap(referenceKind => ["unbound", "wrong_source", "claim_only", "invalid_fragment", "hidden_fragment", "bad_hash"].map(kind => ({ referenceKind, kind }))))("$referenceKind: $kind cannot prove received field coverage", ({ referenceKind, kind }) => {
    const f = referencedMethodFixture(), item = f.hydrated.acceptance_items[0]!;
    if (referenceKind === "table") {
      Object.assign(f.manifest.evidence[4]!, { kind: "table_row", table_row_kind: "data", table_id: "T" });
      Object.assign(f.manifest.reference_occurrences[0]!, { reference_kind: "table", target_table_id: "T", target_evidence_ids: ["e:4"] });
      f.hydrated.reference_resolutions[0]!.target_evidence_ids = ["e:4"];
    }
    // Exercise persisted v7 diagnostics too; hydrated v8 sampling extensions
    // are deliberately not part of the legacy persisted schema.
    item.sampling.applied_branches?.forEach(branch => { delete branch.components; });
    f.hydrated.shared_sampling_rules?.forEach(rule => { delete rule.components; rule.branches.forEach(branch => { delete branch.components; }); });
    if (kind === "unbound" || kind === "claim_only") {
      item.method = "";
      item.field_bindings.method = { status: "not_applicable", composition: "not_applicable", evidence_ids: [], source_fragments: [], value_sha256: sha256Text(""), reason: "已接收该方法的声明不能代替内容" };
    }
    if (kind === "claim_only") item.reference_evidence_ids = [...new Set([...item.reference_evidence_ids, "e:4"])];
    if (kind === "wrong_source") {
      item.method = f.manifest.evidence[1]!.text;
      Object.assign(item.field_bindings.method, { evidence_ids: ["e:1"], source_fragments: [{ evidence_id: "e:1", text: item.method }], value_sha256: sha256Text(item.method) });
    }
    if (kind === "invalid_fragment") item.field_bindings.method.source_fragments.find(fragment => fragment.evidence_id === "e:4")!.text = "不存在的检查方法";
    if (kind === "hidden_fragment") { item.method = "没有显示原方法"; item.field_bindings.method.value_sha256 = sha256Text(item.method); }
    if (kind === "bad_hash") item.field_bindings.method.value_sha256 = sha256Text("旧值");
    const result = validatePlanText(JSON.stringify(f.hydrated), f.manifest);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: referenceKind === "table" ? "reference_placeholder_table_leaf_missing" : "reference_placeholder_item_coverage_missing",
      details: expect.objectContaining({ [referenceKind === "table" ? "uncovered_data_row_evidence_ids" : "uncovered_evidence_ids"]: expect.arrayContaining(["e:4"]) }),
    }));
  });

  test.each([
    { text: "2.1.1 涂层表面应平整。", quotes: ["涂层表面应平整"], gaps: [{ start: 0, end: 6 }, { start: 13, end: 14 }] },
    { text: "甲项；乙项。丙项！", quotes: ["甲项", "乙项", "丙项"], gaps: [{ start: 2, end: 3 }, { start: 5, end: 6 }, { start: 8, end: 9 }] },
    { text: "表面必须连续且平整", quotes: ["表面"], gaps: [{ start: 2, end: 9 }] },
  ])("reports exact gaps without deciding their semantic role: $text", ({ text, quotes, gaps }) => {
    const f = fixture(text);
    bindRequirementFragments(f, quotes);
    const before = structuredClone(f);
    const issue = issues(f).find(i => i.code === "selector_reference_placeholder_target_uncovered")!;
    expect(issue.details).toMatchObject({
      actual: {
        uncovered_target_span_ids: [f.ids[1]],
        uncovered_intervals: gaps.map(gap => ({ span_id: f.ids[1], evidence_id: "e:1", ...gap })),
        uncovered_interval_count: gaps.length,
        uncovered_intervals_complete: true,
      },
      expected: { for_reference_placeholder: expect.stringContaining("完整覆盖") },
    });
    expect(issue.details.how_to_pass).toContain("未覆盖区间");
    expect(f).toEqual(before);
  });

  test("bounds interval feedback without hiding the total or interpreting source punctuation", () => {
    const f = fixture("0A1B2C3D4E5F6G7H8I9J!");
    bindRequirementFragments(f, [..."ABCDEFGHIJ"]);
    const issue = issues(f).find(i => i.code === "selector_reference_placeholder_target_uncovered")!;
    expect(issue.details.actual).toMatchObject({
      uncovered_intervals: Array.from({ length: 8 }, (_, i) => ({ span_id: f.ids[1], evidence_id: "e:1", start: i * 2, end: i * 2 + 1 })),
      uncovered_interval_count: 11,
      uncovered_intervals_complete: false,
    });
  });

  test("adjacent real-item fragments retain the existing full-union coverage", () => {
    const f = fixture();
    bindRequirementFragments(f, ["2.1.1 ", "涂层表面应平整。"]);
    expect(issues(f).map(i => i.code)).not.toContain("selector_reference_placeholder_target_uncovered");
  });

  test("unknown source IDs still fail and are not given invented gap coordinates", () => {
    const f = fixture();
    f.plan.references[0]!.target_span_ids.push("span:00000000000000000000000000000000");
    const issue = issues(f).find(i => i.code === "selector_reference_placeholder_target_uncovered")!;
    expect(issue.details).toMatchObject({ missing_or_unknown_span_count: 1, actual: {
      uncovered_intervals: [], uncovered_interval_count: 0, uncovered_intervals_complete: true,
    } });
  });

  test("selected shared components close a placeholder through compile, strict validation and materialization", () => {
    const f = fixture();
    const before = structuredClone(f.plan);
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(validatePlanText(JSON.stringify(compiled), f.manifest)).toMatchObject({ ok: true, issues: [] });
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    expect(materialize(hydrated, f.manifest, "fixture").result.inspection_lots[0]!.items).toHaveLength(1);
    expect(compiled.reference_resolutions[0]!.destination_bindings).toEqual([]);
    expect(f.plan).toEqual(before);
  });

  test.each(["unselected", "unused", "absent", "no-criterion"])("%s sources cannot close a placeholder", kind => {
    const f = fixture();
    if (kind === "unselected") {
      f.manifest.reference_occurrences[0]!.target_evidence_ids.push("e:4");
      f.plan.references[0]!.target_span_ids.push(f.ids[4]!);
    }
    if (kind === "unused") f.plan.items[0]!.sampling = { ...f.plan.items[0]!.sampling, status: "not_sampling", rule_key: "", branch_keys: [] };
    if (kind === "absent") f.plan.sampling_rules[0]!.components[0] = { ...f.plan.sampling_rules[0]!.components[0]!, disposition: "absent", span_ids: [] };
    if (kind === "no-criterion") f.plan.items[0]!.criterion_span_ids = [];
    expect(issues(f).map(i => i.code)).toContain("selector_reference_placeholder_target_uncovered");
  });

  test("strict validation cannot use an unselected sibling's evidence envelope to prove coverage", () => {
    const f = fixture();
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    f.manifest.reference_occurrences[0]!.target_evidence_ids.push("e:4");
    compiled.reference_resolutions[0]!.target_evidence_ids.push("e:4");
    const result = validatePlanText(JSON.stringify(compiled), f.manifest);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "reference_placeholder_item_coverage_missing",
      details: expect.objectContaining({ uncovered_evidence_ids: ["e:4"] }) }));
  });

  test.each(["present", "absent"] as const)("selected %s override follows the existing shared-component merge contract", disposition => {
    const f = fixture();
    f.plan.sampling_rules[0]!.branches[0]!.components.push({ key: "applicability", role: "applicability", disposition,
      span_ids: disposition === "present" ? [f.ids[4]!] : [], reason: "分支处置" });
    const codes = issues(f).map(i => i.code);
    if (disposition === "present") expect(codes).toContain("selector_reference_placeholder_target_uncovered");
    else expect(codes).not.toContain("selector_reference_placeholder_target_uncovered");
  });

  test("nested authored table paths count as coverage without using references to prove themselves", () => {
    const f = fixture();
    f.plan.references[0]!.target_span_ids = [f.ids[1]!, f.ids[2]!];
    f.plan.sampling_rules[0]!.components[0] = { ...f.plan.sampling_rules[0]!.components[0]!, disposition: "absent", span_ids: [] };
    f.plan.items[0]!.table = { source_kind: "direct", table_key: "table", reference_span_ids: [], reason: "结构绑定", properties: { table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [], row_path_span_ids: [[f.ids[1]!]], column_path_span_ids: [[f.ids[2]!]], unit_span_ids: [], condition_span_ids: [], allowed_value_span_ids: [f.ids[1]!], inspection_method_span_ids: [] } };
    // Other table-shape checks remain independent; this test isolates coverage.
    const codes = issues(f).map(i => i.code);
    expect(codes).not.toContain("selector_schema");
    expect(codes).not.toContain("selector_reference_placeholder_target_uncovered");
    f.plan.items[0]!.table.properties.column_path_span_ids = [];
    expect(issues(f).map(i => i.code)).toContain("selector_reference_placeholder_target_uncovered");
  });

  test("an uncovered clause placeholder reports source-grounded item, non-item and routing repairs", () => {
    const f = fixture();
    f.manifest.reference_occurrences[0]!.target_evidence_ids.push("e:4");
    f.plan.references[0]!.target_span_ids.push(f.ids[4]!);
    const issue = issues(f).find(i => i.code === "selector_reference_placeholder_target_uncovered")!;
    expect(issue.details).toMatchObject({
      reference_key: "reference",
      occurrence_id: "reference:fixture",
      writable_paths: expect.arrayContaining([
        "/references/0/application_mode", "/references/0/destinations",
        "/references/0/import_scope", "/references/0/component_dispositions",
        "/items", "/sampling_rules",
      ]),
      allowed_actions: expect.arrayContaining([expect.stringContaining("reference_placeholder"), expect.stringContaining("source_dispositions"), expect.stringContaining("reference_only")]),
      uncovered_target_span_ids: [f.ids[4]],
      uncovered_source_count: 1,
      uncovered_source_preview: [expect.objectContaining({
        span_id: f.ids[4], evidence_id: "e:4", source_kind: "paragraph",
      })],
      preferred_uncovered_source: { span_id: f.ids[4], evidence_id: "e:4" },
      candidate_read_tool: "list_reference_occurrences",
      candidate_read_tools: expect.arrayContaining(["list_reference_occurrences", "read_document_reference_evidence", "read_reference_facts", "open_evidence", "locate_evidence_span"]),
      next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: 0, limit: 100 },
      next_tools: expect.arrayContaining(["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"]),
      save_tool: "stage_target_selector_draft",
    });
    expect(issue.details.how_to_pass).toContain("reference_only");
    expect(issue.details.how_to_pass).toContain("按原文");
    expect(issue.details.how_to_pass).toContain("lots[].scope_span_ids");
    expect(issue.details.how_to_pass).toContain("source_dispositions");
    expect(JSON.stringify(issue.details)).not.toContain("删除纯指针父 item");
  });

  test("source-first repair skips a structural heading when substantive content is also uncovered", () => {
    const f = fixture();
    f.manifest.reference_occurrences[0]!.target_evidence_ids.push("e:4");
    f.manifest.evidence[2]!.kind = "heading";
    f.plan.items[0]!.sampling = { ...f.plan.items[0]!.sampling, status: "not_sampling", rule_key: "", branch_keys: [] };
    f.plan.references[0]!.target_span_ids = [f.ids[2]!, f.ids[4]!];
    const issue = issues(f).find(i => i.code === "selector_reference_placeholder_target_uncovered")!;
    expect(issue.details).toMatchObject({
      uncovered_source_preview: [
        expect.objectContaining({ evidence_id: "e:2", source_kind: "heading" }),
        expect.objectContaining({ evidence_id: "e:4", source_kind: "paragraph" }),
      ],
      preferred_uncovered_source: { span_id: f.ids[4], evidence_id: "e:4" },
      next_tool: "list_reference_occurrences",
      next_tool_arguments: { cursor: 0, limit: 100 },
    });
  });

  test("a resolved clause may use reference_only when an actual item field receives it", () => {
    const f = fixture();
    f.plan.references[0]!.application_mode = "reference_only";
    f.plan.references[0]!.destinations = [{ item_key: "surface", target_field: "requirement" }];
    f.plan.references[0]!.import_scope = {
      mode: "field_specific", allowed_fields: ["requirement"], reason: "被引要求导入真实检查项目",
    };
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(compiled.reference_resolutions[0]!.destination_bindings).toEqual(
      [expect.objectContaining({ item_id: expect.any(String), target_field: "requirement" })],
    );
  });
});
