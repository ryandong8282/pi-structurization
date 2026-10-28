import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Check } from "typebox/value";

import { sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import * as runtime from "../src/pi-runtime.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { repairStateOrDefault } from "../src/repair-convergence.js";
import { classifyStrictSelectorIssues, decideStrictSelectorPreflight } from "../src/selector-issue-ownership.js";
import { semanticItemIdForSelectorKey } from "../src/semantic-decision-compiler.js";
import * as compilerContext from "../src/selector-compiler-context.js";
import { initialSourceSpanRegistry, registerSourceSpan } from "../src/source-span-registry.js";
import { compileTargetSelectors, targetSelectorFingerprint, TargetSelectorCompileError } from "../src/target-selector-compiler.js";
import { actionableSelectorIssue, createPiTools, selectorIssueToolPage, ToolController, type TargetSelectorStage } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(stage: TargetSelectorStage = "primary", unit = "mm", locatorPadding = "") {
  const root = await mkdtemp(join(tmpdir(), "selector-repair-feedback-"));
  roots.push(root);
  const markdown = `表 A 构件检查\n\n<table><tr><td>项目</td><td>允许值(${unit})</td><td>检验方法</td></tr><tr><td>属性甲</td><td>4</td><td>仪器检查</td></tr><tr><td>属性乙</td><td>3</td><td>仪器检查</td></tr></table>`;
  const hash = sha256Text(markdown);
  const structured = buildStructuredTargetEvidence(markdown, hash, [{ start_line: 1, end_exclusive_line: 4 }], false);
  for (const record of structured.evidence) record.locator += locatorPadding;
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "repair-feedback", target_id: "table-target",
    source: { adapter: "document-domain-agent/v1", file_name: "table.md", sha256: hash, semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "table-target", source_line_count: 3, selected_start_line: 1, selected_end_exclusive_line: 4, selected_heading: "", selection_reason: "验证修复路径，不预设业务拆项答案", selected_atom_ids: [], target_evidence_fragments: [], candidates: [] },
    evidence: structured.evidence, table_fragments: structured.table_fragments, reference_occurrences: [], evidence_fingerprint: sha256Text(`repair-feedback\0${hash}`),
  };
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; state.selector_stage = stage; });
  const controller = await ToolController.create(workspace);
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  return { workspace, controller, manifest, selectors, fingerprint: targetSelectorFingerprint(selectors) };
}

function offeredTools(controller: ToolController): string[] {
  return (runtime.constrainSelectorProviderPayload(
    { tools: createPiTools(controller).map(tool => ({ name: tool.name })) },
    controller.selectorProviderPolicy(),
  ).tools as Array<{ name: string }>).map(tool => tool.name);
}

// These unit tests supply a completed formal-check result. Author-work admission
// is exercised separately with real records in selector-repair-work.test.ts.
function mockCompletedStageCheck(controller: ToolController, result: unknown) {
  vi.spyOn(controller, "selectorRepairWork").mockResolvedValue(undefined);
  return vi.spyOn(controller as any, "validateSelectorStageCompleteness").mockResolvedValue(result);
}

test.each(["primary", "sampling"] as const)("explicit finite source repair works in %s before any stage retry", async stage => {
  const { workspace, controller, manifest } = await fixture(stage);
  for (const source of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: source.evidence_id });
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const fullCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const preflight = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
  expect(before.selector_protocol?.stage_retries).toBeUndefined();
  const result = await controller.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
  expect(result).toMatchObject({ ok: true, current_source_repair: {
    budget_consumed: false, full_stage_check_performed: false,
    actual: { issue_count: expect.any(Number) },
  } });
  expect(result.current_source_repair.actual.issue_count).toBeGreaterThan(0);
  expect(result.current_source_repair.selector_issues[0].next_tool).toBeTruthy();
  expect(fullCheck).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
});

test("an oversized resource context returns measured facts and a usable same-cursor retry without skipping resources", async () => {
  const { workspace, controller, manifest } = await fixture("table", "mm", "中性定位元数据".repeat(2600));
  const scope = await (controller as any).publicTargetScope(new Map(), new Set());
  vi.spyOn(controller as any, "publicTargetScope").mockResolvedValue({ ...scope, synthetic_metadata: "附加元数据".repeat(3000) });
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const compile = vi.spyOn(controller as any, "selectorCompilerIssues");
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const rejected = await (controller as any).targetContext({ cursor: 0, limit: 100 });
  expect(rejected).toMatchObject({ ok: false, terminal: false, error: "target_context_payload_limit_internal",
    full_stage_check_performed: false, budget_consumed: false, next_tool: "get_target_context",
    actual: { cursor: 0, requested_limit: 100 }, expected: { max_serialized_bytes: 128 * 1024 },
    next_tool_arguments: { cursor: 0, limit: 1 } });
  expect(rejected.actual.serialized_bytes).toBeGreaterThan(rejected.expected.max_serialized_bytes);
  expect(rejected.actual.fixed_context_bytes).toBeLessThan(rejected.expected.max_serialized_bytes);
  expect(Check(createPiTools(controller).find(tool => tool.name === rejected.next_tool)!.parameters, rejected.next_tool_arguments)).toBe(true);
  const received: string[] = [];
  let args = rejected.next_tool_arguments;
  do {
    const response = await (controller as any).targetContext(args);
    expect(response.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(128 * 1024);
    received.push(...response.resource_inventory.map((row: any) => row.evidence_id));
    if (response.next_resource_cursor === null) break;
    args = { cursor: response.next_resource_cursor, limit: rejected.next_tool_arguments.limit };
    expect(received.length).toBeLessThan(manifest.evidence.length);
  } while (true);
  expect(received).toEqual(manifest.evidence.map(row => row.evidence_id));
  expect(check).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
  expect(await workspace.readState()).toEqual(before);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
});

test("fixed oversized context does not prescribe a resource page reduction that cannot recover it", async () => {
  const { workspace, controller } = await fixture("table");
  vi.spyOn(controller as any, "publicTargetScope").mockResolvedValue({ synthetic_metadata: "固定元数据".repeat(12000) });
  const before = await workspace.readState();
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const result = await (controller as any).targetContext({ cursor: 0, limit: 1 });
  expect(result).toMatchObject({ ok: false, error: "target_context_payload_limit_internal", full_stage_check_performed: false,
    budget_consumed: false, next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", cursor: 0 },
    additional_read: { tool: "get_target_context", arguments: { source_repair_cursor: 0, source_repair_limit: 1 } } });
  expect(result.actual.fixed_context_bytes).toBeGreaterThan(result.expected.max_serialized_bytes);
  expect(result.instruction).toContain("降低资源 limit 不能保证恢复");
  expect(Check(createPiTools(controller).find(tool => tool.name === result.next_tool)!.parameters, result.next_tool_arguments)).toBe(true);
  expect(check).not.toHaveBeenCalled(); expect(await workspace.readState()).toEqual(before);
});

test("stale checks retain only verified current author-key navigation through reorder and deletion, including empty finite source diagnostics", async () => {
  const { workspace, controller, manifest, selectors } = await fixture("table");
  const registry = await workspace.readSourceSpanRegistry(), spanId = registry.spans[0]!.span_id;
  const item = (key: string) => ({ key, lot_key: "neutral-scope", name: "中性属性", category: "一般项目",
    criterion_span_ids: [spanId], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable", span_ids: field === "name" ? [spanId] : [], separator: "", reason: "只验证作者导航。",
    }])), table: null, inspection_data_type: "review", inspection_data_type_reason: "中性记录", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "中性记录", confidence: 1 }, reason: "不指定业务修法" });
  const reference = (key: string) => ({ key, occurrence_id: `registered-${key}`, anchor_span_ids: [], target_span_ids: [],
    action: "keep_reference", application_mode: "reference_only", destinations: [],
    import_scope: { mode: "field_specific", allowed_fields: [], reason: "中性引用" }, reason: "只验证导航" });
  selectors.lots = [{ key: "neutral-scope", name: "中性范围", scope_span_ids: [spanId], reason: "只验证导航" }];
  selectors.items = [item("first-item"), item("second-item"), item("ambiguous-item"), item("ambiguous-item")];
  selectors.references = [reference("first-reference"), reference("deleted-reference"), reference("second-reference")];
  selectors.source_dispositions = [{ span_ids: registry.spans.map(row => row.span_id), disposition: "context", reason: "合成导航夹具来源已交代，不作业务通过证明" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await (controller as any).recordSelectorStageRetry({ issues: [
    { code: "reference_origin_relation", path: "/references/0/destinations/0/item_key", actual: "旧实际值禁止重放", how_to_pass: "旧修法禁止重放",
      details: { affected_item_key: "first-item", reference_key: "first-reference" } },
    { code: "duplicate_reference_route", path: "/references/2/destinations/0/target_field",
      details: { affected_item_key: "second-item", reference_key: "second-reference", conflicting_reference_routes: [{ reference_key: "deleted-reference" }],
        tool_argument_hints: { read_target_selectors: [{ collection: "items", key: "ambiguous-item" }, { collection: "items", key: "absent-item" }] } } },
    { code: "reference_import_scope_exceeded", path: "/references/0/import_scope/allowed_fields",
      actual: "旧实际值禁止重放", how_to_pass: "旧修法禁止重放",
      details: { affected_item_key: "first-item", reference_key: "first-reference" } },
  ] });
  selectors.items.reverse(); selectors.references = [selectors.references[2], selectors.references[0]];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await workspace.updateState(state => { state.selector_protocol!.last_stage_diagnostics!.contract_version = "obsolete-contract";
    state.selector_protocol!.stage_retries!.consecutive_non_improvements = 3; });
  const restored = await ToolController.create(workspace);
  vi.spyOn(restored as any, "targetFieldRoleIssues").mockResolvedValue([]);
  const check = vi.spyOn(restored as any, "validateSelectorStageCompleteness");
  const compile = vi.spyOn(restored as any, "selectorCompilerIssues");
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8"), source = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const startup = restored.selectorStartupContext();
  expect(startup.resume_focus).toBeUndefined();
  const stale = await (restored as any).stageDiagnosticPage({ stage_diagnostic_cursor: 0 });
  expect(stale).toMatchObject({ ok: false, error: "selector_stage_diagnostic_checkpoint_stale" });
  const finite = await (restored as any).targetContext({ source_repair_cursor: 0 });
  expect(finite.current_source_repair).toBeNull();
  const navigation = finite.historical_repair_navigation;
  expect(navigation).toEqual(startup.historical_repair_navigation);
  expect(navigation).toEqual(stale.historical_repair_navigation);
  expect(navigation).toMatchObject({ validation_scope: "historical_author_record_navigation", current_validation_performed: false,
    total_records: 4, listed_records: 4 });
  expect(navigation.record_reads.map((read: any) => read.arguments.key)).toEqual(["first-item", "first-reference", "second-item", "second-reference"]);
  expect(navigation.current_repair_contracts).toEqual([{ issue_code: "reference_import_scope_exceeded", instruction: expect.stringContaining("target_span_ids") }]);
  expect(navigation.current_repair_contracts[0].instruction).toContain("不指定应选目标子集");
  expect(navigation.current_repair_contracts[0].instruction).toContain("历史问题代码不表示当前仍有同一错误");
  expect(finite.next_repair_record_read).toEqual(navigation.record_reads[0]);
  for (const value of [startup, stale, finite]) {
    expect(JSON.stringify(value)).not.toContain("旧实际值禁止重放"); expect(JSON.stringify(value)).not.toContain("旧修法禁止重放");
    expect(JSON.stringify(value)).not.toContain("/references/0/destinations/0/item_key");
  }
  for (const read of navigation.record_reads) {
    expect(Check(createPiTools(restored).find(tool => tool.name === read.tool)!.parameters, read.arguments)).toBe(true);
  }
  const prompt = runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId, recovering_coverage_failure: false,
    resume: true, ...startup });
  expect(prompt).not.toContain("first-item"); expect(prompt).not.toContain("旧修法禁止重放");
  expect(prompt).toContain("get_target_context.historical_repair_navigation");
  expect(prompt).toContain("历史完整导航保留在当前只读上下文");
  expect(check).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
  expect(await workspace.readState()).toEqual(before); expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(source);
  expect(manifest.reference_occurrences).toEqual([]);
});

test("keyed reference reads expose current authored source bindings without inferring receivers or running checks", async () => {
  const { workspace, controller, manifest, selectors } = await fixture("table");
  let registry = await workspace.readSourceSpanRegistry();
  const first = registry.spans[0]!, unrelated = registry.spans.find(span => span.evidence_id !== first.evidence_id)!;
  const source = manifest.evidence.find(row => row.evidence_id === first.evidence_id)!;
  const registered = registerSourceSpan(registry, source, 1, Math.min(4, source.text.length));
  registry = registered.registry; await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry), "utf8");
  const partial = registered.span.span_id;
  const item = { key: "actual-receiver", lot_key: "neutral-lot", name: "中性记录", category: "一般项目",
    criterion_span_ids: [], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: "verbatim", span_ids: field === "requirement" ? [first.span_id] : field === "quantity" ? [partial] : field === "method" ? [unrelated.span_id] : [], separator: "", reason: "只验证已写入事实",
    }])), table: null, inspection_data_type: "review", inspection_data_type_reason: "中性记录", inspection_data_type_span_ids: [],
    sampling: { status: "explicit", rule_key: "actual-rule", branch_keys: [], quantity_span_ids: [partial], script_span_ids: [], condition_span_ids: [], reason: "只测试读取", confidence: 1 }, reason: "未授予业务通过" };
  selectors.items = [item, { ...structuredClone(item), key: "ambiguous-receiver" }, { ...structuredClone(item), key: "ambiguous-receiver" }];
  const reference = (key: string, itemKey: string, span: string) => ({ key, occurrence_id: `occurrence-${key}`, anchor_span_ids: [], target_span_ids: [span],
    action: "keep_reference", application_mode: "reference_only", destinations: [{ item_key: itemKey, target_field: "quantity" }],
    import_scope: { mode: "field_specific", allowed_fields: ["quantity"], reason: "当前作者授权" }, reason: "不预设应选目标" });
  selectors.references = [reference("current-reference", item.key, first.span_id), reference("other-authored-reference", item.key, unrelated.span_id), reference("unrelated-reference", "absent-receiver", first.span_id)];
  selectors.references[0].destinations.push({ item_key: "ambiguous-receiver", target_field: "quantity" }, { item_key: "absent-receiver", target_field: "quantity" });
  selectors.sampling_rules = [{ key: "actual-rule", quantity_span_ids: [first.span_id], reason: "只验证既有读取地址" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8"), sourceBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness"), compile = vi.spyOn(controller as any, "selectorCompilerIssues");
  const response = await (controller as any).readTargetSelectors({ collection: "references", key: "current-reference" });
  const facts = response.current_reference_binding_facts;
  expect(facts).toMatchObject({ validation_scope: "current_author_reference_bindings", current_validation_performed: false,
    matching_basis: "same_registered_evidence_as_selected_target", binding_facts_complete: true, unavailable_receiver_keys: ["ambiguous-receiver", "absent-receiver"] });
  expect(facts.author_bindings).toEqual([
    { item_key: item.key, author_binding_path: "/fields/requirement/span_ids/0", span_id: first.span_id, evidence_id: first.evidence_id },
    { item_key: item.key, author_binding_path: "/fields/quantity/span_ids/0", span_id: partial, evidence_id: first.evidence_id },
    { item_key: item.key, author_binding_path: "/sampling/quantity_span_ids/0", span_id: partial, evidence_id: first.evidence_id },
  ]);
  expect(facts.record_reads.map((row: any) => row.arguments)).toEqual([{ collection: "items", key: item.key },
    { collection: "references", key: "other-authored-reference" }, { collection: "sampling_rules", key: "actual-rule" }]);
  expect(facts).not.toHaveProperty("imported_fields"); expect(facts).not.toHaveProperty("correct_target_span_ids");
  expect(facts.import_scope_contract).toContain("target_span_ids"); expect(facts.import_scope_contract).toContain("不指定应选目标子集");
  expect(JSON.stringify(facts)).not.toContain(source.text);
  expect(await workspace.readState()).toEqual(before); expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(sourceBefore);
  selectors.references[0].target_span_ids = [unrelated.span_id]; await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const changed = await (controller as any).readTargetSelectors({ collection: "references", key: "current-reference" });
  expect(changed.current_reference_binding_facts.author_bindings).toEqual([{ item_key: item.key,
    author_binding_path: "/fields/method/span_ids/0", span_id: unrelated.span_id, evidence_id: unrelated.evidence_id }]);
  selectors.references.push(structuredClone(selectors.references[0])); await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  expect((await (controller as any).readTargetSelectors({ collection: "references", key: "current-reference" })).current_reference_binding_facts).toBeUndefined();
  expect(check).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
});

test("reference binding facts include nested typed table paths without treating prose as source bindings", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  const registry = await workspace.readSourceSpanRegistry();
  const selected = registry.spans[0]!;
  const unrelated = registry.spans.find(span => span.evidence_id !== selected.evidence_id)!;
  selectors.items = [{ key: "table-receiver", fields: {}, sampling: { rule_key: "" },
    table: { properties: {
      row_path_span_ids: [[selected.span_id, unrelated.span_id], [selected.span_id]],
      column_path_span_ids: [[selected.span_id]],
      allowed_value_span_ids: [selected.span_id],
      reason: selected.span_id,
    } }, reason: selected.span_id }];
  selectors.references = [{ key: "table-reference", target_span_ids: [selected.span_id],
    destinations: [{ item_key: "table-receiver", target_field: "requirement" }] }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const stateBefore = await workspace.readState();
  const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const response = await (controller as any).readTargetSelectors({ collection: "references", key: "table-reference" });
  expect(response.current_reference_binding_facts).toMatchObject({ total_binding_count: 4,
    listed_binding_count: 4, binding_facts_complete: true, current_validation_performed: false });
  expect(response.current_reference_binding_facts.author_bindings).toEqual([
    "/table/properties/row_path_span_ids/0/0", "/table/properties/row_path_span_ids/1/0",
    "/table/properties/column_path_span_ids/0/0", "/table/properties/allowed_value_span_ids/0",
  ].map(author_binding_path => ({ item_key: "table-receiver", author_binding_path,
    span_id: selected.span_id, evidence_id: selected.evidence_id })));
  expect(await workspace.readState()).toEqual(stateBefore);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
});

test("reference binding facts declare their bounded completeness and cannot overflow an otherwise readable record", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!;
  selectors.items = [{ key: "bounded-receiver", fields: { requirement: { span_ids: Array.from({ length: 100 }, () => span.span_id) } }, sampling: { rule_key: "" } }];
  selectors.references = [{ key: "bounded-reference", occurrence_id: "bounded-occurrence", anchor_span_ids: [], target_span_ids: [span.span_id],
    action: "keep_reference", application_mode: "reference_only", destinations: [{ item_key: "bounded-receiver", target_field: "requirement" }],
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "当前事实" }, reason: "只验证体积边界" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const response = await (controller as any).readTargetSelectors({ collection: "references", key: "bounded-reference" });
  expect(response.current_reference_binding_facts).toMatchObject({ total_binding_count: 100, binding_facts_complete: false });
  expect(response.current_reference_binding_facts.listed_binding_count).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(response.current_reference_binding_facts.author_bindings), "utf8")).toBeLessThanOrEqual(8192);
  selectors.references[0].reason = "x".repeat(129000); await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const large = await (controller as any).readTargetSelectors({ collection: "references", key: "bounded-reference" });
  expect(large.ok).toBe(true); expect(large.rows[0].reason).toBe(selectors.references[0].reason);
  expect(large.current_reference_binding_facts).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeLessThanOrEqual(128 * 1024);
});

test("a reference occurrence id is not silently accepted as an absent author record key", async () => {
  const { workspace, controller, selectors } = await fixture();
  selectors.references = [{ key: "authored-link", occurrence_id: "occurrence-registered", anchor_span_ids: [], target_span_ids: [],
    action: "keep_reference", application_mode: "reference_only", destinations: [],
    import_scope: { mode: "field_specific", allowed_fields: [], reason: "合成引用身份" }, reason: "合成引用身份，不预设接收字段" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  const rejected = await controller.dispatch("read_target_selectors", { collection: "references", key: "occurrence-registered" }) as any;
  expect(rejected).toMatchObject({ ok: false, error: "selector_record_key_not_found", budget_consumed: false,
    actual: { collection: "references", key: "occurrence-registered", record_count: 1 },
    matching_occurrence_record_keys: ["authored-link"], next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "references", key: "authored-link" } });
  expect(rejected.how_to_pass).toContain("occurrence_id");
  expect(await controller.dispatch(rejected.next_tool, rejected.next_tool_arguments)).toMatchObject({ ok: true, rows: [{ key: "authored-link" }] });
  const absent = await controller.dispatch("read_target_selectors", { collection: "items", key: "unregistered-author-key" }) as any;
  expect(absent).toMatchObject({ ok: false, error: "selector_record_key_not_found",
    next_tool_arguments: { collection: "items", cursor: 0 } });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
});

test("a resumed stage repair retains the complete instruction including its final constraints", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  selectors.lots = [{ key: "saved-lot", name: "保存的测试范围", scope_span_ids: [(await workspace.readSourceSpanRegistry()).spans[0]!.span_id], reason: "保留作者检查点" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const how = "先读取真实来源并核对作者记录。".repeat(35) + "不得删除必要来源，不得猜测接收字段；保存完整记录后重检。";
  mockCompletedStageCheck(controller, { ok: false, globalCandidateComplete: false,
    issues: [{ code: "selector_synthetic_source_conflict", path: "/references", how_to_pass: how,
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references" } }] });
  await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
  const startup = (await ToolController.create(workspace)).selectorStartupContext();
  expect(startup.resume_focus?.[0]?.how_to_pass).toBe(how);
  expect(runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
    recovering_coverage_failure: false, resume: true, ...startup })).toContain(how);
});

test.each(["obsolete-contract", "selector-stage-diagnostics/v2", "selector-stage-diagnostics/v3", "selector-stage-diagnostics/v4", "selector-stage-diagnostics/v5", "selector-stage-diagnostics/v6", "selector-stage-diagnostics/v7", "selector-stage-diagnostics/v8", "selector-stage-diagnostics/v15", "selector-stage-diagnostics/v17", "selector-stage-diagnostics/v18", "selector-stage-diagnostics/v22", "selector-stage-diagnostics/v23", undefined])("old complete diagnostic contract %s is not replayed in startup or paging", async contractVersion => {
  const { workspace, controller } = await fixture("table");
  mockCompletedStageCheck(controller, { ok: false, issues: [{
    code: "selector_synthetic_old_receipt", path: "/references/0", how_to_pass: "旧修法要求不存在的目标。",
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references" },
  }] });
  await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
  const currentContract = (await workspace.readState()).selector_protocol!.last_stage_diagnostics!.contract_version;
  await workspace.updateState(state => {
    state.selector_protocol!.last_stage_diagnostics!.contract_version = contractVersion;
    state.selector_protocol!.stage_retries!.consecutive_non_improvements = 3;
  });
  const before = await workspace.readState();
  const draft = await readFile(workspace.workingSelectorPath, "utf8");
  const registry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const restored = await ToolController.create(workspace);
  expect(restored.selectorStartupContext().resume_focus).toBeUndefined();
  const validate = vi.spyOn(restored as any, "validateSelectorStageCompleteness");
  const response = await restored.dispatch("get_target_context", { stage_diagnostic_cursor: 0 }) as any;
  expect(response).toMatchObject({ ok: false, error: "selector_stage_diagnostic_checkpoint_stale", budget_consumed: false,
    full_stage_check_performed: false, actual: { matches_current_inputs: true, matches_current_contract: false,
      diagnostic_contract_version: contractVersion ?? "legacy_unknown" },
    expected: { diagnostic_contract_version: currentContract },
    next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
  expect(JSON.stringify(response)).not.toContain("旧修法要求不存在的目标");
  expect(Check(createPiTools(restored).find(tool => tool.name === response.next_tool)!.parameters, response.next_tool_arguments)).toBe(true);
  const current = await restored.dispatch(response.next_tool, response.next_tool_arguments) as any;
  expect(current).toMatchObject({ ok: true });
  expect(current.instruction).toContain("不等于阶段通过或业务正确");
  expect(validate).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registry);
});

test("an expired sampling receipt navigates unique current author keys with a generic inherited-source repair contract and retained retries", async () => {
  const { workspace, controller, selectors } = await fixture("sampling");
  const rule = { key: "current-rule", complete_span_ids: [], components: [], branches: [], reason: "未完成的中性共享规则" };
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, sampling_rules: [rule] }));
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "selector_sampling_unspecified_quantity_is_full_inspection",
    path: "/items/99/sampling", actual: "过期业务事实", how_to_pass: "过期且不可执行的原建议",
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "sampling_rules", key: rule.key } }] });
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries!.consecutive_non_improvements = 3;
    state.selector_protocol!.last_stage_diagnostics!.contract_version = "selector-stage-diagnostics/v9";
  });
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const resumed = await ToolController.create(workspace);
  const fullCheck = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
  const compile = vi.spyOn(resumed as any, "selectorCompilerIssues");
  const startup = resumed.selectorStartupContext();
  expect(startup.resume_focus).toBeUndefined();
  expect(startup.historical_repair_navigation).toMatchObject({ current_validation_performed: false,
    record_reads: [{ arguments: { collection: "sampling_rules", key: rule.key } }],
    current_repair_contracts: [{ issue_code: "selector_sampling_unspecified_quantity_is_full_inspection", instruction: expect.stringContaining("共享") }] });
  const contract = startup.historical_repair_navigation!.current_repair_contracts![0]!;
  expect(contract.instruction).toContain("历史代码只导航");
  expect(contract.instruction).toContain("不重存同状态/reason消错");
  for (const old of ["过期业务事实", "/items/99", "过期且不可执行的原建议"]) expect(JSON.stringify(startup)).not.toContain(old);
  const route = startup.historical_repair_navigation!.record_reads[0]!;
  expect(Check(createPiTools(resumed).find(tool => tool.name === route.tool)!.parameters, route.arguments)).toBe(true);
  const read = await resumed.dispatch(route.tool, route.arguments) as any;
  expect(read.rows[0].key).toBe(rule.key);
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(fullCheck).not.toHaveBeenCalled();
  expect(compile).not.toHaveBeenCalled();
  await workspace.updateState(state => { (state.selector_protocol!.last_stage_diagnostics!.issues[0] as any).next_tool_arguments.key = "missing-key"; });
  expect((await ToolController.create(workspace)).selectorStartupContext().historical_repair_navigation).toBeUndefined();
});

test("expired pending sampling preserves the last retry and exposes the current conditional-authoring contract", async () => {
  const { workspace, controller, selectors } = await fixture("sampling");
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!;
  selectors.items = [{ key: "pending-neutral", lot_key: "scope", name: "中性属性", category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable", span_ids: field === "name" ? [span.span_id] : [], separator: "", reason: "仅验证恢复通信" }])),
    table: null, inspection_data_type: "review", inspection_data_type_reason: "中性分类", inspection_data_type_span_ids: [],
    sampling: { status: "pending", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "未确定型式", confidence: 0 }, reason: "中性作者记录" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "selector_sampling_decision_pending", path: "/items/99/sampling",
    actual: "过期事实", how_to_pass: "过期修法", next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "pending-neutral" } }] });
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries!.consecutive_non_improvements = 2;
    state.selector_protocol!.last_stage_diagnostics!.contract_version = "selector-stage-diagnostics/v9";
  });
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const resumed = await ToolController.create(workspace), check = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
  const startup = resumed.selectorStartupContext();
  expect(startup.resume_focus).toBeUndefined();
  const navigation = startup.historical_repair_navigation!;
  expect(navigation).toMatchObject({ current_validation_performed: false, current_repair_contracts: [{
    issue_code: "selector_sampling_decision_pending", instruction: expect.stringContaining("现场参数"),
  }] });
  expect(navigation.current_repair_contracts![0]!.instruction).toContain("sampling_rules");
  for (const old of ["过期事实", "过期修法", "/items/99"]) expect(JSON.stringify(startup)).not.toContain(old);
  const route = navigation.record_reads[0]!;
  expect(await resumed.dispatch(route.tool, route.arguments)).toMatchObject({ ok: true, rows: [{ key: "pending-neutral" }] });
  expect(check).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
});

test.each(["table", "primary"] as const)("%s context and author summary stop advertising a stale diagnostic page without a new check", async stage => {
  const { workspace, controller } = await fixture(stage);
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "synthetic-protocol-pending", path: "/items", actual: "旧诊断事实" }] });
  const initial = await (controller as any).targetContext({});
  expect(initial.selector_protocol.last_stage_diagnostic_read).toMatchObject({ snapshot_status: "current",
    complete_diagnostics_available: true, next_tool: "get_target_context", next_tool_arguments: { stage_diagnostic_cursor: 0 } });
  await workspace.writeWorkingSelectors(await readFile(workspace.workingSelectorPath, "utf8") + "\n");
  await workspace.updateState(state => { state.selector_protocol!.stage_retries!.consecutive_non_improvements = 3; });
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const compile = vi.spyOn(controller as any, "selectorCompilerIssues");
  const expectedRoute = { next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } };
  const repeated = await (controller as any).targetContext({});
  expect(repeated.context_page_already_returned).toBe(true);
  const finite = await (controller as any).targetContext({ source_repair_cursor: 0 });
  const author = await (controller as any).readTargetSelectors({});
  for (const protocol of [repeated.selector_protocol, finite.selector_protocol, author.summary.selector_protocol]) {
    expect(protocol.last_stage_diagnostic_read).toMatchObject({ snapshot_status: "stale",
      historical_snapshot_present: true, complete_diagnostics_available: false, ...expectedRoute });
    expect(protocol.last_stage_diagnostic_read.next_tool_arguments).not.toHaveProperty("stage_diagnostic_cursor");
    expect(JSON.stringify(protocol)).not.toContain("旧诊断事实");
    expect(protocol.stage_retries.consecutive_non_improvements).toBe(3);
  }
  expect(check).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
  expect(await workspace.readState()).toEqual(before); expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
});

test("a changed diagnostic contract invalidates the public read route even with identical input bytes", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  selectors.lots = [{ key: "neutral-scope", name: "中性范围", scope_span_ids: [(await workspace.readSourceSpanRegistry()).spans[0]!.span_id], reason: "保留真实非空检查点" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "synthetic-old-contract", path: "/items" }] });
  await workspace.updateState(state => { state.selector_protocol!.last_stage_diagnostics!.contract_version = "obsolete-contract"; });
  const restored = await ToolController.create(workspace);
  const before = await workspace.readState();
  const check = vi.spyOn(restored as any, "evaluateTargetSelectorPreflight");
  const response = await (restored as any).targetContext({ source_repair_cursor: 0 });
  expect(response.selector_protocol.last_stage_diagnostic_read).toMatchObject({ snapshot_status: "stale", complete_diagnostics_available: false,
    next_tool: "get_target_context", next_tool_arguments: { field_diagnostic_cursor: 0 } });
  const prompt = runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
    recovering_coverage_failure: false, resume: true, ...restored.selectorStartupContext() });
  expect(prompt).toContain("selector_protocol.last_stage_diagnostic_read");
  expect(prompt).toContain("不自动追加stage_diagnostic_cursor");
  expect(check).not.toHaveBeenCalled(); expect(await workspace.readState()).toEqual(before);
});

test("a recovered stage failure pages the completed check without another validation or budget change", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  selectors.lots = [{ key: "neutral-scope", name: "合成范围", scope_span_ids: [(await workspace.readSourceSpanRegistry()).spans[0]!.span_id], reason: "只测试诊断传递" }];
  const spanId = selectors.lots[0].scope_span_ids[0];
  selectors.items = [{ key: "neutral-item", lot_key: "neutral-scope", name: "合成属性", category: "一般项目",
    criterion_span_ids: [spanId], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable", span_ids: field === "name" ? [spanId] : [], separator: "", reason: "只验证诊断传递。",
    }])), table: null, inspection_data_type: "review", inspection_data_type_reason: "合成记录", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "合成记录", confidence: 1 }, reason: "不预设业务答案" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const issues = Array.from({ length: 13 }, (_, index) => ({ code: "selector_synthetic_pending", path: `/items/${index}/fields`,
    actual: { state: "pending", neutral_metadata: "合成检查元数据".repeat(800) }, how_to_pass: "核对原文及准确作者记录后增量保存，不预设业务答案。",
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "references" } }));
  await workspace.updateState(state => { state.selector_protocol!.stage_retries = {
    stage: "table", best_stage_rank: 1, best_issue_count: issues.length, consecutive_non_improvements: 3,
  }; });
  mockCompletedStageCheck(controller, { ok: false, issues });
  const failed = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(failed).toMatchObject({ terminal: true, next_tool: null, next_tools: [], writable_paths: [], next_diagnostic_page: null,
    recovery_guidance: { next_diagnostic_page: { next_tool: "get_target_context", tool_scope: "recovered_revision_only" },
      budget_policy: "preserve_existing_counters" } });
  expect(failed).not.toHaveProperty("next_tool_arguments");
  expect(failed.selector_issue_page.raw_issue_count).toBe(13);
  await workspace.markTerminal("failed", "selector_stage_incomplete");
  const recovered = await RevisionWorkspace.reviseFromTerminalFailure(workspace.artifactRoot, workspace.jobId, workspace.targetId, { resumeModelingPhaseBudget: true });
  const resumed = await ToolController.create(recovered);
  const check = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
  const preflight = vi.spyOn(resumed as any, "evaluateTargetSelectorPreflight");
  const before = await recovered.readState(), draft = await readFile(recovered.workingSelectorPath, "utf8");
  const first = await resumed.dispatch("get_target_context", { stage_diagnostic_cursor: 0 }) as any;
  expect(first).toMatchObject({ ok: true, complete_diagnostics_available: true, budget_consumed: false, full_stage_check_performed: false });
  const received = [...first.selector_issues];
  let page = first;
  while (page.next_diagnostic_page) {
    page = await resumed.dispatch(page.next_diagnostic_page.next_tool, page.next_diagnostic_page.next_tool_arguments) as any;
    expect(received.map(issue => issue.path)).not.toContain(page.selector_issues[0].path);
    received.push(...page.selector_issues);
    expect(received.length).toBeLessThanOrEqual(13);
  }
  expect(received).toHaveLength(13);
  expect(check).not.toHaveBeenCalled();
  expect(preflight).not.toHaveBeenCalled();
  expect({ ...await recovered.readState(), next_event_sequence: before.next_event_sequence }).toEqual(before);
  expect(await readFile(recovered.workingSelectorPath, "utf8")).toBe(draft);
  const checkpoint = (await recovered.readState()).selector_protocol!.last_stage_diagnostics;
  await resumed.recordSelectorTransportFailure("synthetic transport bookkeeping");
  expect((await recovered.readState()).selector_protocol!.last_stage_diagnostics).toEqual(checkpoint);
});

test.each(["actual", "candidate"])("current finite repair omits a field diagnostic with inaccessible %s source", async hidden => {
  const { workspace, controller, manifest } = await fixture("table");
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 0.5, best_issue_count: 1, consecutive_non_improvements: 3 };
  });
  const visibleId = manifest.evidence[0]!.evidence_id;
  vi.spyOn(controller as any, "targetFieldRoleIssues").mockResolvedValue([{
    code: "selector_field_clause_line_mismatch", path: "/items/0/fields/method/span_ids/0",
    details: { actual: { evidence_id: hidden === "actual" ? "inaccessible-source" : visibleId, text: "受限诊断文字" },
      expected_candidates: [{ evidence_id: hidden === "candidate" ? "inaccessible-source" : visibleId, text: "受限候选文字" }] },
  }]);
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const before = await workspace.readState();
  const reply = await controller.dispatch("get_target_context", { source_repair_cursor: 0 });
  expect(JSON.stringify(reply)).not.toContain("受限");
  expect(JSON.stringify(reply)).not.toContain("selector_field_clause_line_mismatch");
  expect(check).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect((await workspace.readState()).opened_evidence_ids).toEqual(before.opened_evidence_ids);
});

test("finite repair keeps complete facts once and does not repeat saved recovery prose", async () => {
  const { workspace, controller, manifest } = await fixture("table");
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 0.5, best_issue_count: 1, consecutive_non_improvements: 3 };
    state.selector_protocol!.last_stage_issues = [{ code: "synthetic-old-focus", path: "/items", how_to_pass: "旧恢复提示".repeat(2000) }];
  });
  const actual = { evidence_id: manifest.evidence[0]!.evidence_id, text: "中性实际来源" };
  const how = "核对实际依据并保留正确字段。".repeat(120);
  vi.spyOn(controller as any, "targetFieldRoleIssues").mockResolvedValue([{
    code: "selector_field_clause_line_mismatch", path: "/items/0/fields/method", message: "中性来源冲突",
    details: { actual, expected: { owner: "neutral-owner" }, how_to_pass: how, expected_candidates: [],
      writable_collection: "items", next_tool: "stage_target_selector_draft" },
  }]);
  const check = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const before = await workspace.readState();
  const reply = await controller.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
  expect(reply.resume_focus).toBeUndefined();
  expect(JSON.stringify(reply)).not.toContain("旧恢复提示");
  const issue = reply.model_review.observations.find((issue: any) => issue.code === "selector_field_clause_line_mismatch");
  expect(reply.model_review).toMatchObject({ blocking: false, decision_owner: "model" });
  expect(issue.actual).toEqual(actual);
  expect(issue.how_to_pass).toBe(how);
  expect(issue.details.expected).toEqual({ owner: "neutral-owner" });
  expect(issue.detail_fields_at_issue_level).toEqual(expect.arrayContaining(["actual", "how_to_pass"]));
  expect(issue.details.actual).toBeUndefined();
  expect(issue.details.how_to_pass).toBeUndefined();
  for (const key of issue.detail_fields_at_issue_level) expect(Object.hasOwn(issue, key)).toBe(true);
  const bytes = reply.current_source_repair.selector_issues.reduce((n: number, row: unknown) => n + Buffer.byteLength(JSON.stringify(row)), 0);
  expect(reply.current_source_repair.issue_page.reported_issue_utf8_bytes).toBe(bytes);
  expect(check).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
});

test("source diagnostic index identifies the full backlog without repeating generic repair messages", async () => {
  const { workspace } = await fixture("table");
  const ids = Array.from({ length: 64 }, (_, index) => `evidence:${sha256Text(`neutral-index-${index}`)}`);
  const page = selectorIssueToolPage(ids.map(id => ({ code: "compiler_unhandled_evidence", path: "/source_dispositions",
    message: "尚未处置来源，需依据原文判断。".repeat(20), details: { required_affected_evidence_ids: [id] } })), 1, 0);
  expect(page.issues).toHaveLength(1);
  expect(page.page).toMatchObject({ raw_issue_count: 64, index_complete: true, indexed_issue_count: 64 });
  expect(page.page.issue_index.flatMap((entry: any) => entry.evidence_ids)).toEqual(ids);
  expect(page.page.issue_index.every((entry: any) => !Object.hasOwn(entry, "message"))).toBe(true);
  const codec = await ModelSourceHandles.open(workspace.root);
  const encoded = await codec.encode(page) as any;
  const handles = encoded.page.issue_index.flatMap((entry: any) => entry.evidence_ids);
  expect(handles.every((id: string) => /^e\d+$/.test(id))).toBe(true);
  expect(await codec.decodeArguments({ evidence_ids: handles, source_handle_scope: codec.scope })).toEqual({ evidence_ids: ids });
});

test.each(["selectors", "registry", "manifest", "table", "access", "ledger"])("saved diagnostic paging refuses stale %s inputs without rechecking", async input => {
  const { workspace, controller } = await fixture("table");
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "selector_synthetic_pending", path: "/items", actual: "old-check-only" }] });
  if (input === "selectors") await workspace.writeWorkingSelectors((await readFile(workspace.workingSelectorPath, "utf8")) + "\n");
  if (input === "registry") { const registry = await workspace.readSourceSpanRegistry(); registry.evidence_fingerprint += "-changed"; await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry)); }
  if (input === "manifest") { const manifest = await workspace.readEvidenceManifest(); manifest.source.file_name = "changed.md"; vi.spyOn(workspace, "readEvidenceManifest").mockResolvedValue(manifest); }
  if (input === "table") await writeFile(join(workspace.root, "table-structure.json"), "{}");
  if (input === "access") await workspace.updateState(state => { state.reference_analysis_modes = { synthetic: {} as any }; });
  if (input === "ledger") {
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, JSON.stringify({ schema_version: "document-ledger/v1",
      source_sha256: sha256Text(await readFile(workspace.sourceMarkdownPath, "utf8")), file_name: "source.md",
      clauses: [], headings: [], windows: [], record_tables: [], anomalies: [] }));
  }
  const before = await workspace.readState();
  const check = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
  const result = await controller.dispatch("get_target_context", { stage_diagnostic_cursor: 0 }) as any;
  expect(result).toMatchObject({ ok: false, terminal: false, error: "selector_stage_diagnostic_checkpoint_stale", budget_consumed: false, full_stage_check_performed: false });
  expect(result.selector_issues).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("old-check-only");
  expect(check).not.toHaveBeenCalled();
  expect({ ...await workspace.readState(), next_event_sequence: before.next_event_sequence }).toEqual(before);
});

test.each(["selectors", "registry", "manifest", "table", "access", "ledger", "stage"])("resume and context suppress old repair paths after %s inputs change without checking or resetting counters", async input => {
  const { workspace, controller, selectors } = await fixture("table");
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  selectors.lots = ["first", "second"].map(key => ({ key, name: `保存范围${key}`, scope_span_ids: [span], reason: "仅验证当前作者地址" }));
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await workspace.updateState(state => {
    state.lineage = { schema_version: "revision-lineage/v1", source_revision: 1,
      selector_checkpoint_revision: 1, registry_checkpoint_revision: 1, recovery_kind: "terminal_checkpoint" };
  });
  await (controller as any).recordSelectorStageRetry({ issues: [{ code: "selector_synthetic_old_record", path: "/lots/0/name",
    actual: "旧检查事实", how_to_pass: "旧定点修法", next_tool: "read_target_selectors", next_tool_arguments: { collection: "lots", key: "first" } }] });
  await workspace.updateState(state => { state.selector_protocol!.stage_retries!.consecutive_non_improvements = 2; });
  expect((await ToolController.create(workspace)).selectorStartupContext()).toMatchObject({
    read_target_selectors_required: false, resume_focus: [{ path: "/lots/0/name", how_to_pass: "旧定点修法" }],
  });
  if (input === "selectors") { selectors.lots.reverse(); await workspace.writeWorkingSelectors(JSON.stringify(selectors)); }
  if (input === "registry") { const registry = await workspace.readSourceSpanRegistry(); registry.evidence_fingerprint += "-changed"; await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry)); }
  if (input === "manifest") { const manifest = await workspace.readEvidenceManifest(); manifest.source.file_name = "changed.md"; vi.spyOn(workspace, "readEvidenceManifest").mockResolvedValue(manifest); }
  if (input === "table") await writeFile(join(workspace.root, "table-structure.json"), (await readFile(join(workspace.root, "table-structure.json"), "utf8")) + "\n");
  if (input === "access") await workspace.updateState(state => { state.reference_analysis_modes = { synthetic: {} as any }; });
  if (input === "ledger") {
    await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
    await writeFile(workspace.documentLedgerPath, JSON.stringify({ schema_version: "document-ledger/v1",
      source_sha256: sha256Text(await readFile(workspace.sourceMarkdownPath, "utf8")), file_name: "source.md",
      clauses: [], headings: [], windows: [], record_tables: [], anomalies: [] }));
  }
  if (input === "stage") await workspace.updateState(state => { state.selector_stage = "sampling"; });
  const before = await workspace.readState();
  const draft = await readFile(workspace.workingSelectorPath, "utf8"), registry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const check = vi.spyOn(ToolController.prototype as any, "evaluateTargetSelectorPreflight");
  const validate = vi.spyOn(ToolController.prototype as any, "validateSelectorStageCompleteness");
  const resumed = await ToolController.create(workspace);
  const startup = resumed.selectorStartupContext();
  expect(startup.resume_focus).toBeUndefined();
  expect(startup.read_target_selectors_required).toBe(true);
  expect(startup.inherited_stage_retry).toEqual(before.selector_protocol.stage_retries);
  expect(startup.historical_repair_navigation).toMatchObject({ current_validation_performed: false,
    record_reads: [{ arguments: { collection: "lots", key: "first" } }] });
  const prompt = runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
    recovering_coverage_failure: false, resume: true, ...startup });
  for (const oldValue of ["旧检查事实", "旧定点修法", "/lots/0/name"]) expect(prompt).not.toContain(oldValue);
  for (const reader of [controller, resumed]) {
    const response = await reader.dispatch("get_target_context", {}) as any;
    expect(response.resume_focus).toBeUndefined();
    expect(response.selector_protocol.last_stage_diagnostic_read.snapshot_status).toBe("stale");
    for (const oldValue of ["旧检查事实", "旧定点修法", "/lots/0/name"]) expect(JSON.stringify(response)).not.toContain(oldValue);
  }
  // Existing source-read gates remain active until the current saved draft is read.
  expect(offeredTools(resumed)).not.toContain("stage_target_selector_draft");
  const read = startup.historical_repair_navigation!.record_reads[0]!;
  expect(await resumed.dispatch(read.tool, read.arguments)).toMatchObject({ ok: true, rows: [{ key: "first" }] });
  expect(offeredTools(resumed)).toContain("stage_target_selector_draft");
  expect(check).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registry);
});

test("empty inspection classification feedback reads and saves the real author span field while preserving other records and budgets", async () => {
  const { workspace, controller, selectors, manifest } = await fixture("table");
  const registry = await workspace.readSourceSpanRegistry(), span = registry.spans[0]!;
  selectors.lots = [{ key: "retained-lot", name: "测试范围", scope_span_ids: [span.span_id], reason: "保留当前范围" }];
  selectors.items = ["current", "neighbor"].map(key => ({ key, lot_key: "retained-lot", name: `中性记录${key}`, category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [], fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable", span_ids: field === "name" ? [span.span_id] : [], separator: "", reason: "仅核对作者接口" }])),
    table: null, inspection_data_type: "review", inspection_data_type_reason: "中性分类理由", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "中性测试记录", confidence: 1 },
    reason: "仅验证修复通信，不预设业务答案" }));
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  for (const record of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
  const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [{
    item_id: semanticItemIdForSelectorKey(selectors.target_id, "neighbor"), inspection_data_type: "review", inspection_data_type_reason: "中性分类理由", inspection_data_type_evidence_ids: [],
  }, { item_id: semanticItemIdForSelectorKey(selectors.target_id, "current"), inspection_data_type: "review", inspection_data_type_reason: "中性分类理由", inspection_data_type_evidence_ids: [] }] } as any;
  const issues = classifyStrictSelectorIssues(selectors, compiled, registry, [{ code: "schema",
    path: "/acceptance_items/1/inspection_data_type_evidence_ids", message: "must NOT have fewer than 1 items", details: { limit: 1 } }]);
  mockCompletedStageCheck(controller, { ok: false,
    issues: issues.map(row => actionableSelectorIssue(row, selectors)) });
  const rejected = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  const issue = rejected.selector_issues[0];
  expect(issue).toMatchObject({ path: "/items/0/inspection_data_type_span_ids", actual: {
    item_key: "current", inspection_data_type: "review", inspection_data_type_span_ids: [], compiled_evidence_ids: [],
  }, details: { expected: { inspection_data_type_span_ids_min_items: 1 } }, next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "items", key: "current" }, writable_path: "/items/0/inspection_data_type_span_ids" });
  expect(issue).not.toHaveProperty("actual_unavailable");
  expect(issue.how_to_pass).not.toContain("not_applicable");
  const before = await workspace.readState(), registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const read = await controller.dispatch(issue.next_tool, issue.next_tool_arguments) as any;
  expect(read).toMatchObject({ ok: true, rows: [{ key: "current" }] });
  const authored = read.rows[0];
  authored.inspection_data_type_span_ids = [span.span_id];
  const saveArgs = { operation: "upsert", collection: "items", draft: { items: [authored] } };
  expect(Check(createPiTools(controller).find(tool => tool.name === issue.save_tool)!.parameters, saveArgs)).toBe(true);
  expect(await controller.dispatch(issue.save_tool, saveArgs)).toMatchObject({ ok: true, staged_record_count: 1 });
  const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  expect(saved.items[0].inspection_data_type_span_ids).toEqual([span.span_id]);
  expect(saved.items[0]).not.toHaveProperty("inspection_data_type_evidence_ids");
  expect({ ...saved.items[0], inspection_data_type_span_ids: [] }).toEqual(selectors.items[0]);
  expect(saved.items[1]).toEqual(selectors.items[1]);
  expect(saved.lots).toEqual(selectors.lots);
  expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
  // A previous-contract issue must not replay its illegal repair. Its still-unique
  // current author key may expose the new generic contract, never old facts.
  await workspace.updateState(state => {
    state.selector_protocol.last_stage_diagnostics!.contract_version = "selector-stage-diagnostics/v9";
    state.selector_protocol.last_stage_diagnostics!.issues = [{ code: "schema", path: "/items/99/inspection_data_type_evidence_ids",
      owner: "selector_input_error", details: { compiled_path: "/acceptance_items/1/inspection_data_type_evidence_ids" },
      actual: "过时的分类事实", how_to_pass: "旧修法选择 not_applicable",
      record_read: { tool: "read_target_selectors", arguments: { collection: "items", key: "current" } } }];
  });
  const beforeResume = await workspace.readState();
  const resumed = await ToolController.create(workspace), startup = resumed.selectorStartupContext();
  expect(startup.resume_focus).toBeUndefined();
  expect(startup.historical_repair_navigation).toMatchObject({ current_validation_performed: false,
    record_reads: [{ arguments: { collection: "items", key: "current" } }],
    current_repair_contracts: [{ issue_code: "schema", author_field: "inspection_data_type_span_ids" }] });
  const contract = startup.historical_repair_navigation!.current_repair_contracts![0]!;
  expect(contract.instruction).toContain("不证明当前记录仍有历史错误");
  expect(contract.instruction).toContain("measurement/counting/mixed/review");
  for (const old of ["过时的分类事实", "/items/99", "not_applicable"]) expect(JSON.stringify(startup)).not.toContain(old);
  expect((await workspace.readState()).selector_protocol).toEqual(beforeResume.selector_protocol);
  // Missing/ambiguous keys do not become proposed replacement author records.
  await workspace.updateState(state => {
    (state.selector_protocol.last_stage_diagnostics!.issues[0] as any).record_read.arguments.key = "unknown-key";
  });
  expect((await ToolController.create(workspace)).selectorStartupContext().historical_repair_navigation).toBeUndefined();
});

test("legacy stage focus paging declares the missing full snapshot and preserves its counters", async () => {
  const { workspace, controller } = await fixture("table");
  await workspace.updateState(state => { state.selector_protocol!.last_stage_issues = [{ code: "selector_synthetic_pending", path: "/items", how_to_pass: "核对真实记录" }]; });
  const before = await workspace.readState();
  const result = await controller.dispatch("get_target_context", { stage_diagnostic_cursor: 0 });
  expect(result).toMatchObject({ ok: true, validation_scope: "legacy_stage_focus_only", complete_diagnostics_available: false });
  expect({ ...await workspace.readState(), next_event_sequence: before.next_event_sequence }).toEqual(before);
});

test("old origin relation focus receives the current check scope without a new validation or persisted note rewrite", async () => {
  const { workspace, controller } = await fixture("table");
  await workspace.updateState(state => { state.selector_protocol!.last_stage_issues = [{ code: "reference_origin_relation", path: "/references", how_to_pass: "历史修法" }]; });
  const before = await workspace.readState();
  const startup = (await ToolController.create(workspace)).selectorStartupContext();
  expect(startup.resume_focus![0]!.how_to_pass).toContain("所有可见字段片段的并集");
  const check = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
  const page = await controller.dispatch("get_target_context", { stage_diagnostic_cursor: 0 }) as any;
  expect(page.selector_issues[0].how_to_pass).toContain("不能据此推断必须写 method");
  expect(check).not.toHaveBeenCalled();
  expect({ ...await workspace.readState(), next_event_sequence: before.next_event_sequence }).toEqual(before);
});

test("stage focus retains exact author reads and groups repeated receiver diagnostics without changing progress counts", async () => {
  const { workspace, controller, selectors } = await fixture("table");
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!;
  selectors.lots = [{ key: "scope", name: "测试范围", scope_span_ids: [span.span_id], reason: "仅测试恢复通信" }];
  selectors.items = Array.from({ length: 5 }, (_, index) => ({
    key: `receiver-${index}`, lot_key: "scope", name: `测试属性${index}`, category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable", span_ids: field === "name" ? [span.span_id] : [],
      separator: "", reason: "只验证作者记录地址。",
    }])),
    table: null, inspection_data_type: "review", inspection_data_type_reason: "测试记录", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "测试记录", confidence: 1 },
    reason: "只验证恢复通信，不预设业务答案。",
  }));
  selectors.references = [{ key: "saved-reference", anchor_span_ids: [span.span_id], target_span_ids: [], action: "keep_reference",
    application_mode: "reference_only", destinations: selectors.items.flatMap((item: any) => ["requirement", "method"].map(field => ({ item_key: item.key, target_field: field }))),
    import_scope: { mode: "field_specific", allowed_fields: ["requirement", "method"], reason: "测试作者地址" }, reason: "测试作者地址" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const issues = selectors.items.flatMap((item: any, index: number) => [0, 1].map(offset => ({
    code: "reference_origin_relation", path: `/references/0/destinations/${index * 2 + offset}/item_key`,
    details: { occurrence_id: "registered-neutral", item_id: `compiled-${index}`, item_key: item.key,
      origin_evidence_ids: [span.evidence_id], writable_path: `/items/${index}/fields` },
    how_to_pass: "读取各真实作者项，依据原文分别判断。", next_tool: "open_evidence", next_tool_arguments: { evidence_id: span.evidence_id },
  })));
  mockCompletedStageCheck(controller, { ok: false, issues });
  await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
  const state = await workspace.readState();
  expect(state.selector_protocol.stage_retries?.best_issue_count).toBe(10);
  expect(state.selector_protocol.last_stage_issues).toHaveLength(5);
  const resumed = await ToolController.create(workspace);
  const focus = resumed.selectorStartupContext().resume_focus!;
  expect(focus.map(issue => issue.record_read?.arguments.key)).toEqual(selectors.items.map((item: any) => item.key));
  for (const issue of focus) expect(await resumed.dispatch(issue.record_read!.tool, issue.record_read!.arguments))
    .toMatchObject({ ok: true, rows: [{ key: issue.record_read!.arguments.key }] });
  const prompt = runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
    recovering_coverage_failure: false, resume: true, ...resumed.selectorStartupContext() });
  const visibleFocus = JSON.parse(prompt.match(/<repair_navigation>\s*([\s\S]*?)\s*<\/repair_navigation>/u)![1]!);
  expect(visibleFocus).toContainEqual(expect.objectContaining({ record_read: {
    tool: "read_target_selectors", arguments: { collection: "items", key: "receiver-4" } } }));
  expect(TARGET_SELECTOR_PROTOCOLS.diagnostics).toContain("核对全部实际相关项");

  // Historical focus has only a numeric destination path. Recover its exact
  // current receiver address, without claiming it is a semantic repair choice.
  await workspace.updateState(current => { current.selector_protocol.last_stage_issues = [{
    code: "reference_origin_relation", path: "/references/0/destinations/8/item_key",
  }, { code: "reference_origin_relation", path: "/references/0/destinations/100/item_key" }]; });
  const historical = (await ToolController.create(workspace)).selectorStartupContext().resume_focus!;
  expect(historical[0].record_read?.arguments).toEqual({ collection: "items", key: "receiver-4" });
  expect(historical[1]).not.toHaveProperty("record_read");
  expect((await workspace.readState()).selector_protocol.last_stage_issues?.[0]).not.toHaveProperty("record_read");
});

test("repeated context returns the current stage and fresh retry receipt without another validation", async () => {
  const { controller, workspace } = await fixture("table");
  const initial = await controller.dispatch("get_target_context", {}) as any;
  expect(initial.selector_stage).toBe("table");
  const checked = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
  expect(checked).toMatchObject({ ok: false, current_stage: "table" });
  const before = await workspace.readState();
  expect(before.selector_protocol.stage_retries).toBeDefined();
  const firstIssue = (checked as any).selector_issues[0];
  expect((await ToolController.create(workspace)).selectorStartupContext().resume_focus?.[0]).toMatchObject({
    next_tool: firstIssue.next_tool, next_tool_arguments: firstIssue.next_tool_arguments,
  });
  const repeated = await controller.dispatch("get_target_context", {}) as any;
  expect(repeated).toMatchObject({ ok: true, context_page_already_returned: true,
    selector_stage: "table", selector_protocol: { stage_retries: before.selector_protocol.stage_retries } });
  expect(repeated).not.toHaveProperty("resource_inventory");
  const { next_event_sequence: _beforeEvents, ...beforeAuthorState } = before;
  const { next_event_sequence: _afterEvents, ...afterAuthorState } = await workspace.readState();
  expect(afterAuthorState).toEqual(beforeAuthorState);
});

test("resume read parameters use the session source handles and remain executable", async () => {
  const { workspace, manifest, selectors } = await fixture();
  const evidenceId = manifest.evidence[0]!.evidence_id;
  selectors.lots = [{ key: "saved-lot", name: "已保存范围", scope_span_ids: [(await workspace.readSourceSpanRegistry()).spans[0]!.span_id], reason: "保留现有检查点" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  await workspace.updateState(state => { state.selector_protocol.last_stage_issues = [{
    code: "compiler_unhandled_evidence", path: "/source_dispositions", evidence_ids: [evidenceId],
    next_tool: "open_evidence", next_tool_arguments: { evidence_id: evidenceId, cursor: 0 },
  }]; });
  const controller = await ToolController.create(workspace);
  const codec = await ModelSourceHandles.open(workspace.root);
  const encoded = await codec.encode(controller.selectorStartupContext()) as ReturnType<ToolController["selectorStartupContext"]>;
  const focus = encoded.resume_focus![0]!;
  const prompt = runtime.targetSelectorStartupPrompt({ job_id: workspace.jobId, target_id: workspace.targetId,
    recovering_coverage_failure: false, resume: true, ...encoded });
  expect(prompt).not.toContain(evidenceId);
  const visibleFocus = JSON.parse(prompt.match(/<repair_navigation>\s*([\s\S]*?)\s*<\/repair_navigation>/u)![1]!);
  expect(visibleFocus[0]).toMatchObject({ next_tool: "open_evidence", next_tool_arguments: focus.next_tool_arguments });
  expect(focus.next_tool_arguments!.evidence_id).toMatch(/^e\d+$/u);
  const decoded = await codec.decodeArguments({ ...focus.next_tool_arguments, source_handle_scope: codec.scope });
  expect(decoded).toEqual({ evidence_id: evidenceId, cursor: 0 });
  expect(await controller.dispatch(focus.next_tool!, decoded)).toMatchObject({ ok: true });
});

test.each(["primary", "table"] as const)("unknown table selector collection redirects to an executable structure read in %s", async stage => {
  const { controller, workspace } = await fixture(stage);
  const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const structurePath = join(workspace.root, "table-structure.json");
  const structureBefore = await readFile(structurePath, "utf8");
  const rejected = await controller.dispatch("read_target_selectors", { collection: "table_structure", key: "unverified-table" }) as any;
  expect(rejected).toMatchObject({
    ok: false, error: "unknown_selector_collection", terminal: false, durable_mutation: false, budget_consumed: false,
    actual: { collection: "table_structure", key: "unverified-table" },
    allowed_collections: expect.arrayContaining(["items", "references", "source_dispositions"]),
    next_tool: "read_saved_table_structure", next_tool_arguments: {},
    save_tool: "stage_table_structure", writable_paths: ["stage_table_structure.table"],
  });
  expect(rejected.how_to_pass).toContain("read_table_summary");
  expect(rejected.how_to_pass).toContain("stage_table_structure");
  expect(offeredTools(controller)).toContain(rejected.next_tool);
  const tool = createPiTools(controller).find(tool => tool.name === rejected.next_tool)!;
  expect(Check(tool.parameters, rejected.next_tool_arguments)).toBe(true);
  const saved = await controller.dispatch(rejected.next_tool, rejected.next_tool_arguments) as any;
  expect(saved).toMatchObject({ ok: true, structure: { tables: expect.any(Array) } });
  const summary = await controller.dispatch("read_table_summary", { table_key: saved.structure.tables[0].table_key }) as any;
  expect(summary).toMatchObject({ ok: true, saved_decision: expect.any(Object) });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
  expect(await readFile(structurePath, "utf8")).toBe(structureBefore);
});

test("unknown selector collection exposes actual author collections without choosing a business collection", async () => {
  const { controller } = await fixture();
  const rejected = await controller.dispatch("read_target_selectors", { collection: "unknown_records" }) as any;
  expect(rejected).toMatchObject({
    ok: false, actual: { collection: "unknown_records", key: "" },
    allowed_collections: ["lots", "items", "sampling_rules", "references", "source_dispositions", "residual_source_dispositions"],
    next_tool: "get_target_selector_contract", next_tool_arguments: {}, writable_paths: ["/collection"],
    durable_mutation: false, terminal: false, budget_consumed: false,
  });
  expect(offeredTools(controller)).toContain(rejected.next_tool);
  expect(await controller.dispatch(rejected.next_tool, rejected.next_tool_arguments)).toMatchObject({ ok: true });
});

test("inherited repair focus keeps its table save tool available without a selector orientation read", async () => {
  const { workspace, selectors } = await fixture("table");
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  selectors.lots = [{ key: "existing-lot", name: "已有范围", scope_span_ids: [span], reason: "保留已保存的范围" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const retries = { stage: "table" as const, best_stage_rank: 0, best_issue_count: 1, consecutive_non_improvements: 2 };
  await workspace.updateState(state => {
    state.lineage = { schema_version: "revision-lineage/v1", source_revision: 1,
      selector_checkpoint_revision: 1, registry_checkpoint_revision: 1, recovery_kind: "terminal_checkpoint" };
    state.selector_protocol.stage_retries = retries;
    state.selector_protocol.last_stage_issues = [{ code: "table_structure_confirmation_pending",
      path: "/table_structure/tables/0/status", how_to_pass: "read_table_summary 后 stage_table_structure 保存。" }];
  });
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  const resumed = await ToolController.create(workspace);
  expect(resumed.selectorStartupContext()).toMatchObject({ current_selector_state: "inherited_existing",
    read_target_selectors_required: false, inherited_stage_retry: retries });
  expect(offeredTools(resumed)).toContain("stage_table_structure");
  const saved = await resumed.dispatch("read_saved_table_structure", {}) as any;
  const staged = await resumed.dispatch("stage_table_structure", { table: { ...saved.structure.tables[0], reason: "原文尚待确认，保留 review 状态。" } });
  expect(staged).toMatchObject({ ok: true });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(retries);
  expect((await ToolController.create(workspace)).selectorStartupContext().read_target_selectors_required).toBe(false);

  await workspace.updateState(state => { state.selector_protocol.last_stage_issues = []; });
  const withoutFocus = await ToolController.create(workspace);
  expect(withoutFocus.selectorStartupContext().read_target_selectors_required).toBe(true);
  expect(offeredTools(withoutFocus)).not.toContain("stage_table_structure");
});

test("investigation receipt names unopened evidence and executes the read-then-save route", async () => {
  const { controller, workspace, manifest } = await fixture();
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  const args = { summary: "已核对表题，等待其他来源。", evidence_ids: [title.evidence_id], next_steps: "继续核对数据行。" };
  const rejected = await controller.dispatch("save_target_investigation", args) as any;
  expect(rejected).toMatchObject({ ok: false, next_tool: "batch_open_evidence", unopened_evidence_ids: [title.evidence_id], unknown_evidence_ids: [], tool_arguments: { evidence_ids: [title.evidence_id] }, durable_mutation: false });
  expect(rejected.instruction).toContain("原调查内容");
  expect(offeredTools(controller)).toContain(rejected.next_tool);
  expect(Check(createPiTools(controller).find(tool => tool.name === rejected.next_tool)!.parameters, rejected.tool_arguments)).toBe(true);
  await controller.dispatch(rejected.next_tool, rejected.tool_arguments);
  const selectorsBefore = await readFile(workspace.workingSelectorPath,"utf8");
  const investigation = await controller.dispatch("save_target_investigation", args) as any;
  expect(investigation).toMatchObject({ ok: true, terminal: false, selector_mutation: false, full_stage_check_performed: false });
  expect(investigation.instruction).toContain("本工具不结束任务、不换会话、不重置预算");
  expect(await readFile(workspace.workingSelectorPath,"utf8")).toBe(selectorsBefore);
  const saved = await readFile(join(workspace.root, "investigation-checkpoint.json"), "utf8");
  const unknown = await controller.dispatch("save_target_investigation", { ...args, evidence_ids: ["not-a-real-evidence"] });
  expect(unknown).toMatchObject({ ok: false, unknown_evidence_ids: ["not-a-real-evidence"], next_tool: "list_evidence_resources" });
  expect(await readFile(join(workspace.root, "investigation-checkpoint.json"), "utf8")).toBe(saved);
});

test("an empty investigation key-source directory preserves conclusions, reads and author state", async () => {
  const { controller, workspace, manifest } = await fixture();
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  await controller.dispatch("open_evidence", { evidence_id: title.evidence_id });
  const state = await workspace.readState();
  const selectors = await readFile(workspace.workingSelectorPath, "utf8");
  const registry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const args = { summary: "完整调查结论仍在交接中，业务记录尚待核对。", evidence_ids: [], next_steps: "继续按实际来源完善判据和条件。" };
  expect(Check(createPiTools(controller).find(tool => tool.name === "save_target_investigation")!.parameters, args)).toBe(true);
  expect(await controller.dispatch("save_target_investigation", args)).toMatchObject({ ok: true, selector_mutation: false, full_stage_check_performed: false });
  expect(JSON.parse(await readFile(join(workspace.root, "investigation-checkpoint.json"), "utf8"))).toMatchObject(args);
  const after = await workspace.readState();
  expect(after.opened_evidence_ids).toEqual(state.opened_evidence_ids);
  expect(after.selector_protocol).toEqual(state.selector_protocol);
  expect(after.validation_attempts).toBe(state.validation_attempts);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectors);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registry);
  const reopened = await ToolController.create(workspace);
  expect(await reopened.dispatch("get_target_context", {})).toMatchObject({ investigation_checkpoint: args });
  // An empty directory does not grant a read receipt for a separately named source.
  const unread = manifest.evidence.find(row => row.evidence_id !== title.evidence_id)!;
  expect(await reopened.dispatch("save_target_investigation", { ...args, evidence_ids: [unread.evidence_id] }))
    .toMatchObject({ ok: false, unopened_evidence_ids: [unread.evidence_id] });
});

test("table summary records only the caption text actually returned, durably across reopen", async () => {
  const { controller, workspace, manifest } = await fixture();
  const saved = await controller.dispatch("read_saved_table_structure", {}) as any;
  const summary = await controller.dispatch("read_table_summary", { table_key: saved.structure.tables[0].table_key }) as any;
  const titleIds = summary.title_candidates.map(row => row.evidence_id);
  expect(titleIds.length).toBeGreaterThan(0);
  expect((await workspace.readState()).opened_evidence_ids).toEqual(expect.arrayContaining(titleIds));
  for (const row of manifest.evidence.filter(row => row.table_row_kind)) {
    expect((await workspace.readState()).opened_evidence_ids).not.toContain(row.evidence_id);
  }
  const reopened = await ToolController.create(workspace);
  expect(await reopened.dispatch("save_target_investigation", { summary: "仅阅读了摘要返回的完整题注。", evidence_ids: titleIds, next_steps: "继续读取表头和数据行，尚未完成语义判断。" })).toMatchObject({ ok: true });
});

test("an unkeyed context disposition can be removed by an explicit empty replacement", async () => {
  const { controller, workspace, manifest } = await fixture();
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  await controller.dispatch("open_evidence", { evidence_id: title.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === title.evidence_id)!;
  await controller.dispatch("stage_target_selector_draft", { draft: {
    lots: [{ key: "scope", name: "构件检查", scope_span_ids: [span.span_id], reason: "题注作为组织范围" }],
    source_dispositions: [{ span_ids: [span.span_id], disposition: "context", reason: "重复登记的背景" }],
  } });
  const before = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  const arguments_ = { operation: "replace_collection", collection: "source_dispositions", draft: { source_dispositions: [] } };
  expect(Check(createPiTools(controller).find(tool => tool.name === "stage_target_selector_draft")!.parameters, arguments_)).toBe(true);
  const cleared = await controller.dispatch("stage_target_selector_draft", arguments_);
  expect(cleared, JSON.stringify(cleared)).toMatchObject({ ok: true, local_validation: { ok: true } });
  const after = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  expect(after.source_dispositions).toEqual([]);
  expect(after.lots).toEqual(before.lots);
  expect(after.items).toEqual(before.items);
  const noOp = await controller.dispatch("stage_target_selector_draft", { operation: "upsert", draft: { source_dispositions: [] } });
  expect(noOp).toMatchObject({ ok: false, error: "selector_draft_batch_empty" });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(JSON.stringify(after, null, 2) + "\n");
});

test("unkeyed removal rejects invented addresses and points back to the readable record index", async () => {
  const { controller } = await fixture();
  const result = await controller.dispatch("stage_target_selector_draft", { collection: "source_dispositions", remove_keys: ["0"] });
  expect(result).toMatchObject({ ok: false, next_tool: "read_target_selectors", writable_path: "/remove_keys" });
  expect(result.instruction).toContain("读取键");
});

test("source lookup reads only authored dispositions matching registered evidence identities", async () => {
  const { controller, workspace, manifest, selectors } = await fixture();
  for (const evidence of manifest.evidence.slice(0, 3)) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const spans = manifest.evidence.slice(0, 3).map(evidence => registry.spans.find(span => span.evidence_id === evidence.evidence_id)!);
  const records = [
    { span_ids: spans.slice(0, 2).map(span => span.span_id), disposition: "context", reason: "作者保存的合并来源记录" },
    { span_ids: [spans[2].span_id], disposition: "ignored", reason: "作者保存的另一来源记录" },
  ];
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, source_dispositions: records }, null, 2) + "\n");
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  const stateBefore = await workspace.readState();
  const args = { collection: "source_dispositions", evidence_ids: [manifest.evidence[1].evidence_id] };
  const result = await controller.dispatch("read_target_selectors", args) as any;
  expect(result).toMatchObject({ ok: true, view: "records", rows: [records[0]], matching_record_count: 1, next_cursor: null, budget_consumed: false });
  expect(Check(createPiTools(controller).find(tool => tool.name === "read_target_selectors")!.parameters, args)).toBe(true);
  expect(result.read_keys).toHaveLength(1);
  expect(await controller.dispatch("read_target_selectors", { collection: "source_dispositions", key: result.read_keys[0] }))
    .toMatchObject({ ok: true, rows: [records[0]] });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  expect((await workspace.readState()).opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect((await workspace.readState()).selector_protocol).toEqual(stateBefore.selector_protocol);
});

test("source lookup reports an empty authored match without declaring the source absent", async () => {
  const { controller, workspace, manifest, selectors } = await fixture();
  for (const evidence of manifest.evidence.slice(0, 2)) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === manifest.evidence[0].evidence_id)!;
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, source_dispositions: [{ span_ids: [span.span_id], disposition: "context", reason: "已有来源记录" }] }, null, 2) + "\n");
  const result = await controller.dispatch("read_target_selectors", { collection: "source_dispositions", evidence_ids: [manifest.evidence[1].evidence_id] }) as any;
  expect(result).toMatchObject({ ok: true, view: "records", rows: [], read_keys: [], matching_record_count: 0, next_cursor: null });
  expect(result.instruction).toContain("不证明原文缺失");
});

test("a misplaced source filter offers executable reads without discarding the selected author record", async () => {
  const { controller, workspace, manifest, selectors } = await fixture();
  const evidence = manifest.evidence[0];
  await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const span = (await workspace.readSourceSpanRegistry()).spans.find(row => row.evidence_id === evidence.evidence_id)!;
  const item = {
    key: "authored-item", lot_key: "authored-lot", name: "作者项目", category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable",
      span_ids: field === "name" ? [span.span_id] : [], separator: "", reason: "仅验证已有作者记录的读取。",
    }])),
    table: null, inspection_data_type: "review", inspection_data_type_reason: "已有作者判断。", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "已有作者判断。", confidence: 1 },
    reason: "已有作者项目。",
  };
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, items: [item] }, null, 2) + "\n");
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  const stateBefore = await workspace.readState();
  const args = { collection: "items", key: item.key, evidence_ids: [evidence.evidence_id], cursor: 0, limit: 1 };
  const rejected = await controller.dispatch("read_target_selectors", args) as any;
  expect(rejected).toMatchObject({ ok: false, terminal: false, budget_consumed: false,
    actual: args, next_tool: "read_target_selectors",
    retry_arguments: { collection: "items", key: item.key, cursor: 0, limit: 1 },
  });
  expect(rejected.retry_arguments).not.toHaveProperty("evidence_ids");
  expect(rejected.next_tool_arguments).toEqual(rejected.retry_arguments);
  const parameters = createPiTools(controller).find(tool => tool.name === "read_target_selectors")!.parameters;
  expect(Check(parameters, rejected.retry_arguments)).toBe(true);
  expect(await controller.dispatch(rejected.next_tool, rejected.retry_arguments)).toMatchObject({ ok: true, rows: [item] });
  const sourceRoute = rejected.repair_options.find((route: any) => route.kind === "lookup_source_dispositions");
  expect(sourceRoute.next_tool_arguments).toEqual({ collection: "source_dispositions", evidence_ids: [evidence.evidence_id], cursor: 0, limit: 1 });
  expect(await controller.dispatch(sourceRoute.next_tool, sourceRoute.next_tool_arguments))
    .toMatchObject({ ok: true, matching_record_count: 0, rows: [] });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
  expect((await workspace.readState()).opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect((await workspace.readState()).selector_protocol).toEqual(stateBefore.selector_protocol);
});

test("an empty source filter gives a valid directory retry without inventing source identities", async () => {
  const { controller } = await fixture();
  const rejected = await controller.dispatch("read_target_selectors", { collection: "source_dispositions", evidence_ids: [] }) as any;
  expect(rejected).toMatchObject({ ok: false, terminal: false, retry_arguments: { collection: "source_dispositions" } });
  expect(rejected.retry_arguments).not.toHaveProperty("evidence_ids");
  expect(rejected.next_tool_arguments).toEqual(rejected.retry_arguments);
  expect(await controller.dispatch(rejected.next_tool, rejected.retry_arguments)).toMatchObject({ ok: true, view: "index" });
});

test("source lookup paginates the matching authored records rather than the entire directory", async () => {
  const { controller, workspace, manifest, selectors } = await fixture();
  for (const evidence of manifest.evidence.slice(0, 3)) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const records = manifest.evidence.slice(0, 3).map((evidence, index) => ({
    span_ids: [registry.spans.find(span => span.evidence_id === evidence.evidence_id)!.span_id], disposition: "context", reason: `作者记录 ${index}`,
  }));
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, source_dispositions: records }, null, 2) + "\n");
  const args = { collection: "source_dispositions", evidence_ids: manifest.evidence.slice(0, 2).map(evidence => evidence.evidence_id), limit: 1 };
  const first = await controller.dispatch("read_target_selectors", args) as any;
  expect(first).toMatchObject({ rows: [records[0]], matching_record_count: 2, next_cursor: 1 });
  expect(await controller.dispatch("read_target_selectors", { ...args, cursor: first.next_cursor }))
    .toMatchObject({ rows: [records[1]], matching_record_count: 2, next_cursor: null });
});

test.each(["primary", "coverage_repair"] as const)("%s reads and surgically removes an unkeyed record through model-visible tools after reopen", async stage => {
  const { controller, workspace, manifest } = await fixture(stage);
  for (const evidence of manifest.evidence.slice(0, 3)) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const spans = manifest.evidence.slice(0, 3).map(evidence => registry.spans.find(span => span.evidence_id === evidence.evidence_id && span.start === 0 && span.end === evidence.text.length)!);
  const records = [
    { span_ids: [spans[0]!.span_id, spans[1]!.span_id], disposition: "context", reason: "需要局部纠正的记录" },
    { span_ids: [spans[2]!.span_id], disposition: "context", reason: "与本次修改无关的记录" },
  ];
  await controller.dispatch("stage_target_selector_draft", { draft: { source_dispositions: records } });
  if (stage === "coverage_repair") await workspace.updateState(state => {
    state.selector_stage = stage;
    state.repair = { ...repairStateOrDefault(state.repair), repair_source: "coverage", mode: "modeling", coverage_evidence_ids: spans.slice(0, 2).map(span => span.evidence_id), coverage_item_ids: [], coverage_finding_ids: ["scope-record-repair"] };
  });
  const reopened = await ToolController.create(workspace);
  const first = await reopened.dispatch("read_target_selectors", { collection: "source_dispositions", limit: 1 }) as any;
  expect(first.rows[0].key).toEqual(expect.stringMatching(/^disposition:[a-f0-9]{64}$/));
  const firstKey = first.rows[0].key;
  const second = await reopened.dispatch("read_target_selectors", { collection: "source_dispositions", cursor: first.next_cursor, limit: 1 }) as any;
  expect(second.rows[0].key).not.toBe(firstKey);
  const detail = await reopened.dispatch("read_target_selectors", { collection: "source_dispositions", key: firstKey }) as any;
  expect(detail.rows).toEqual([records[0]]);
  const kept = { ...detail.rows[0], span_ids: [detail.rows[0].span_ids[1]] };
  const arguments_ = { collection: "source_dispositions", remove_keys: [firstKey], draft: { source_dispositions: [kept] } };
  expect(Check(createPiTools(reopened).find(tool => tool.name === "stage_target_selector_draft")!.parameters, arguments_)).toBe(true);
  const changed = await reopened.dispatch("stage_target_selector_draft", arguments_);
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  const saved = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  expect(saved.source_dispositions).toEqual([records[1], kept]);
  expect(saved.source_dispositions.every(record => !Object.hasOwn(record, "key"))).toBe(true);
  const beforeStaleRetry = await readFile(workspace.workingSelectorPath, "utf8");
  const stale = await reopened.dispatch("stage_target_selector_draft", arguments_);
  expect(stale).toMatchObject({ ok: false, next_tool: "read_target_selectors", budget_consumed: false });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeStaleRetry);
  const staleRead = await reopened.dispatch("read_target_selectors", { collection: "source_dispositions", key: firstKey });
  expect(staleRead).toMatchObject({ ok: false, next_tool: "read_target_selectors" });
  if (stage === "coverage_repair") {
    const replace = await reopened.dispatch("stage_target_selector_draft", { operation: "replace_collection", draft: { source_dispositions: [] } });
    expect(replace).toMatchObject({ ok: false, error: "coverage_repair_replace_collection_forbidden" });
  }
});

test("unkeyed read addresses change when the same spans receive a newer disposition", async () => {
  const { controller, workspace, manifest } = await fixture();
  await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const record = { span_ids: [registry.spans[0]!.span_id], disposition: "context", reason: "原始说明" };
  await controller.dispatch("stage_target_selector_draft", { draft: { source_dispositions: [record] } });
  const before = await controller.dispatch("read_target_selectors", { collection: "source_dispositions" }) as any;
  await controller.dispatch("stage_target_selector_draft", { draft: { source_dispositions: [{ ...record, reason: "更新后的说明" }] } });
  const after = await controller.dispatch("read_target_selectors", { collection: "source_dispositions" }) as any;
  expect(after.rows[0].key).not.toBe(before.rows[0].key);
  const saved = await readFile(workspace.workingSelectorPath, "utf8");
  expect(await controller.dispatch("stage_target_selector_draft", { collection: "source_dispositions", remove_keys: [before.rows[0].key] }))
    .toMatchObject({ ok: false, next_tool: "read_target_selectors" });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(saved);
});

test("the transport accepts an invalid component role only to return an actionable rejection without saving", async () => {
  const { controller, workspace } = await fixture();
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  const args = { draft: { sampling_rules: [{ key: "shared", complete_span_ids: [], components: [{ key: "quantity", role: "absent", disposition: "absent", span_ids: [], reason: "原文没有数量" }], branches: [], reason: "测试角色与处置值的区别" }] } };
  const samplingDescription = createPiTools(controller).find(tool => tool.name === "list_sampling_rules")!.description;
  expect(samplingDescription).toContain("非穷尽抽样定位线索");
  const samplingProtocol = ((await controller.dispatch("get_target_selector_contract", {})) as any).authoring_protocols.sampling;
  expect(samplingProtocol).toContain("reference_unspecified_quantity");
  expect(samplingProtocol).toContain("默认结构 branch");
  expect(Check(createPiTools(controller).find(tool => tool.name === "stage_target_selector_draft")!.parameters, args)).toBe(true);
  const rejected = await controller.dispatch("stage_target_selector_draft", args);
  expect(rejected).toMatchObject({ ok: false, error: "selector_sampling_component_role_invalid", durable_mutation: false, next_tool: "stage_target_selector_draft", selector_issues: [expect.objectContaining({ actual: "absent", writable_path: "/draft/sampling_rules/0/components/0/role", allowed_values: expect.arrayContaining(["quantity", "method", "note"]) })] });
  expect(rejected.instruction).toContain("disposition");
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
});

test("partial table authoring defers global missing rows without hiding a malformed authored table record", async () => {
  const { controller, selectors } = await fixture();
  const pending = { code: "selector_table_expansion_obligations_pending", path: "/items", message: "尚未建项的数据行" };
  const invalid = { code: "selector_table_source_required", path: "/items/0/table", message: "当前表项目缺 table" };
  const compiler = vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([pending]);
  expect(await (controller as any).validateStagedSelectorRecords(selectors, ["/items/0"]))
    .toMatchObject({ ok: true, global_completeness_checked: false, deferred_nonlocal_issue_count: 1,
      deferred_issues: [expect.objectContaining({ code: pending.code })] });
  compiler.mockResolvedValue([pending, invalid]);
  expect(await (controller as any).validateStagedSelectorRecords(selectors, ["/items/0"]))
    .toMatchObject({ ok: false, issues: [expect.objectContaining({ code: invalid.code })], deferred_nonlocal_issue_count: 1,
      deferred_issues: [expect.objectContaining({ code: pending.code })] });
});

test("one large diagnostic pages its exact source arrays without exceeding the response budget or rechecking", async () => {
  const { controller, workspace } = await fixture("table");
  const ids = Array.from({ length: 3000 }, (_, i) => `evidence:${String(i).padStart(64, "0")}`);
  const routes = ids.map(evidence_id => ({ evidence_id, target_key: "reference-target:neutral", access_mode: "isolated_reference",
    next_tool: "read_reference_facts", tool_arguments: { target_key: "reference-target:neutral" },
    instruction: "先读目录再按真实条目读取完整来源，不猜测业务结论。" }));
  const issue = { code: "selector_synthetic_uncovered_sources", path: "/lots/0", message: "中性来源组件尚未处置。",
    details: { actual: { unaccounted_component_count: ids.length }, expected: { disposition: "source-grounded" },
      evidence_ids: ids, source_access: routes, how_to_pass: "核对真实来源后增量保存，保留其余正确记录。",
      writable_paths: ["/source_dispositions", "/items", "/references"], next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "references" }, save_tool: "stage_target_selector_draft" } };
  const compile = vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([issue]);
  const fullCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  await controller.dispatch("read_target_selectors", { collection: "lots" });
  const span = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  const saved = await controller.dispatch("stage_target_selector_draft", { draft: { lots: [{ key: "neutral", name: "中性范围", scope_span_ids: [span], reason: "合成范围来源。" }] } }) as any;
  expect(saved.ok).toBe(true);
  expect(saved.mutation_receipt.durable_mutation).not.toBe(false);
  expect(Buffer.byteLength(JSON.stringify(saved), "utf8")).toBeLessThan(48 * 1024);
  const diagnostic = saved.local_validation.issues[0];
  expect(diagnostic).toMatchObject({ code: issue.code, actual: issue.details.actual,
    how_to_pass: issue.details.how_to_pass, save_tool: "stage_target_selector_draft" });
  const state = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const registry = await readFile(workspace.sourceSpanRegistryPath, "utf8");
  const checks = compile.mock.calls.length;
  for (const [path, original] of [["/details/evidence_ids", ids], ["/details/source_access", routes]] as const) {
    const descriptor = diagnostic.diagnostic_array_pages.find((p: any) => p.path === path);
    expect(descriptor.total_count).toBe(3000);
    const received = [...(path.endsWith("evidence_ids") ? diagnostic.details.evidence_ids : diagnostic.details.source_access)];
    let next = descriptor.next_page;
    while (next) {
      expect(Check(createPiTools(controller).find(t => t.name === next.next_tool)!.parameters, next.next_tool_arguments)).toBe(true);
      const page = await controller.dispatch(next.next_tool, next.next_tool_arguments) as any;
      expect(page.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(48 * 1024);
      received.push(...page.entries);
      next = page.next_page;
    }
    expect(received).toEqual(original);
  }
  expect(compile).toHaveBeenCalledTimes(checks);
  expect(fullCheck).not.toHaveBeenCalled();
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registry);
  const { next_event_sequence: _a, ...before } = state;
  const { next_event_sequence: _b, ...after } = await workspace.readState();
  expect(after).toEqual(before);
  const next = diagnostic.diagnostic_array_pages[0].next_page;
  const invalid = await controller.dispatch(next.next_tool, { ...next.next_tool_arguments, diagnostic_detail_path: "/details/missing" }) as any;
  expect(invalid).toMatchObject({ ok: false, error: "selector_diagnostic_detail_page_invalid" });
  expect(invalid.entries).toBeUndefined();
  const snapshotPath = join(workspace.root, "selector-diagnostic-array-pages.json");
  const snapshotText = await readFile(snapshotPath, "utf8");
  for (const change of [{ revision: workspace.revision + 1 }, { schema_version: "older-contract" }]) {
    await writeFile(snapshotPath, JSON.stringify({ ...JSON.parse(snapshotText), ...change }));
    const obsolete = await controller.dispatch(next.next_tool, next.next_tool_arguments) as any;
    expect(obsolete).toMatchObject({ ok: false, error: "selector_diagnostic_detail_checkpoint_stale" });
    expect(obsolete.entries).toBeUndefined();
  }
  await writeFile(snapshotPath, snapshotText);
  await workspace.writeWorkingSelectors(JSON.stringify({ ...JSON.parse(draft), rationale: "合成输入已修改" }));
  const stale = await controller.dispatch(next.next_tool, next.next_tool_arguments) as any;
  expect(stale).toMatchObject({ ok: false, error: "selector_diagnostic_detail_checkpoint_stale", budget_consumed: false, full_stage_check_performed: false });
  expect(stale.entries).toBeUndefined();
  expect(compile).toHaveBeenCalledTimes(checks);
});

test("large local and deferred save diagnostics retain every full repair through read-only snapshot pages", async () => {
  const { controller, workspace, selectors } = await fixture("table");
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 3, best_issue_count: 1, consecutive_non_improvements: 3 };
  });
  const issues = ["/items/0/fields/method", "/items/0/fields/quantity", "/references/0", "/references/1", "/sampling_rules/0"].map((path, index) => ({
    code: `selector_synthetic_saved_${index}`, path, message: "合成保存诊断，非业务答案。",
    details: { actual: { value: `actual-${index}` }, expected: { condition: `expected-${index}` },
      how_to_pass: "核对当前作者记录和已读原文，再按实际含义增量保存。".repeat(300) + `完整末尾约束-${index}`,
      next_tool: "read_target_selectors", next_tool_arguments: { collection: path.startsWith("/items") ? "items" : "references" },
      writable_paths: [path], save_tool: "stage_target_selector_draft" },
  }));
  const compiler = vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue(issues);
  const fullCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  const reply = await (controller as any).validateStagedSelectorRecords(selectors, ["/items/0"]);
  expect(reply).toMatchObject({ ok: false, validation_scope: "touched_records", global_completeness_checked: false,
    issue_count: 2, deferred_nonlocal_issue_count: 3, issues: [{ code: issues[0]!.code }], deferred_issues: [],
    saved_diagnostic_page: { next_tool: "get_target_context", next_tool_arguments: { saved_diagnostic_scope: "local", saved_diagnostic_cursor: 1 } } });
  expect(reply.issues[0].how_to_pass).toBe(issues[0]!.details.how_to_pass);
  expect(reply.issue_page.raw_issue_count).toBe(2);
  expect(reply.deferred_issue_page.raw_issue_count).toBe(3);
  expect(reply.deferred_issue_page.reported_issue_count).toBe(0);
  expect(reply.deferred_issue_page.issue_index.every((row: any) => !row.detail_in_page)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(48 * 1024);
  const reopened = await ToolController.create(workspace);
  const paths = [workspace.statePath, workspace.workingSelectorPath, workspace.sourceSpanRegistryPath,
    workspace.evidenceManifestPath, join(workspace.root, "saved-selector-diagnostics.json")];
  const before = await Promise.all(paths.map(p => readFile(p, "utf8")));
  compiler.mockClear();
  const results: any[] = [];
  let args: any = { saved_diagnostic_scope: "local", saved_diagnostic_cursor: 0 };
  for (let i = 0; args && i < 20; i++) {
    expect(Check(createPiTools(reopened).find(t => t.name === "get_target_context")!.parameters, args)).toBe(true);
    const page = await (reopened as any).targetContext(args);
    expect(page).toMatchObject({ ok: true, full_stage_check_performed: false, budget_consumed: false,
      global_completeness_checked: false, validation_scope: "staged_selector_records",
      actual: { local_issue_count: 2, deferred_nonlocal_issue_count: 3 } });
    results.push(...page.selector_issues);
    args = page.next_diagnostic_page?.next_tool_arguments;
  }
  expect(args).toBeUndefined();
  expect(results.map(row => row.code)).toEqual(issues.map(row => row.code));
  results.forEach((row, index) => {
    expect(row.how_to_pass).toBe(issues[index]!.details.how_to_pass);
    expect(row.actual).toEqual(issues[index]!.details.actual);
    expect(row.details.expected).toEqual(issues[index]!.details.expected);
  });
  expect(await Promise.all(paths.map(p => readFile(p, "utf8")))).toEqual(before);
  expect(compiler).not.toHaveBeenCalled();
  expect(fullCheck).not.toHaveBeenCalled();
  expect((await workspace.readState()).selector_protocol!.stage_retries!.consecutive_non_improvements).toBe(3);
});

test.each(["selector", "identity", "contract"])("saved diagnostic %s changes reject old repair details without a check", async change => {
  const { controller, workspace, selectors } = await fixture("table");
  // Exceed the combined page budget even after display-only deduplication.
  const how = "合成保存修法。".repeat(2000);
  const compiler = vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([
    { code: "saved-local", path: "/items/0", details: { how_to_pass: how } },
    { code: "saved-other", path: "/references/0", details: { how_to_pass: how } },
  ]);
  await (controller as any).validateStagedSelectorRecords(selectors, ["/items/0"]);
  const cachePath = join(workspace.root, "saved-selector-diagnostics.json");
  if (change === "selector") await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, rationale: "作者已修改说明" }));
  else {
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    if (change === "identity") cache.revision += 1;
    else cache.contract_version = "selector-stage-diagnostics/v4";
    await writeFile(cachePath, JSON.stringify(cache));
  }
  const before = await workspace.readState();
  compiler.mockClear();
  const response = await (controller as any).targetContext({ saved_diagnostic_cursor: 0, saved_diagnostic_scope: "local" });
  expect(response).toMatchObject({ ok: false, error: "saved_selector_diagnostic_checkpoint_stale",
    budget_consumed: false, full_stage_check_performed: false, next_tool: "read_target_selectors" });
  expect(response.selector_issues).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain(how);
  expect(compiler).not.toHaveBeenCalled();
  expect(await workspace.readState()).toEqual(before);
});

test("invalid stage transition keeps machine tokens stable and returns executable Chinese feedback", async () => {
  const { controller } = await fixture("primary");
  const result = await controller.dispatch("advance_target_selector_stage", { next_stage: "table" });
  expect(result).toMatchObject({
    ok: false,
    error: "invalid_selector_stage_transition",
    expected_next_stage: "sampling",
    next_tool: "advance_target_selector_stage",
    writable_path: "next_stage",
    how_to_pass: expect.stringMatching(/[\u3400-\u9fff]/),
    do_not_edit: expect.stringMatching(/[\u3400-\u9fff]/),
  });
  expect(result.how_to_pass).toContain("next_stage");
});

test("the stage repair summary keeps the selected issue's read arguments instead of falling back to another collection", async () => {
  const { controller, workspace } = await fixture("table");
  const before = await readFile(workspace.workingSelectorPath, "utf8");
  mockCompletedStageCheck(controller, { ok: false, issues: [
    { code: "neutral_source_attention", path: "/source_dispositions", message: "核对作者保存的来源处置。",
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "source_dispositions" }, writable_paths: ["/source_dispositions"] },
    { code: "neutral_item_attention", path: "/items", message: "核对作者保存的项目。",
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items" }, writable_paths: ["/items"] },
  ] });
  const reply = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(reply).toMatchObject({ ok: false, terminal: false, next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "source_dispositions" } });
  expect(reply.next_tool_arguments).toEqual(reply.selector_issues[0].next_tool_arguments);
  expect(Check(createPiTools(controller).find(tool => tool.name === reply.next_tool)!.parameters, reply.next_tool_arguments)).toBe(true);
  expect(await controller.dispatch(reply.next_tool, reply.next_tool_arguments)).toMatchObject({ ok: true, collection: "source_dispositions" });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
});

test("verified stage continuation exposes current source repair before another budgeted check", async () => {
  const { controller, workspace, manifest } = await fixture("table");
  for (const evidence of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === title.evidence_id)!;
  await controller.dispatch("stage_target_selector_draft", { draft: {
    lots: [{ key: "scope", name: "构件检查", scope_span_ids: [span.span_id], reason: "原文组织范围" }],
    source_dispositions: [{ span_ids: [span.span_id], disposition: "context", reason: "表题提供组织背景" }],
  } });
  await workspace.updateState(state => {
    state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 1, best_issue_count: 2, consecutive_non_improvements: 3 };
  });
  await workspace.markTerminal("failed", "selector_stage_incomplete");
  const proof = {
    revision: workspace.revision,
    selector_sha256: sha256Text(await readFile(workspace.workingSelectorPath, "utf8")),
    registry_sha256: sha256Text(await readFile(workspace.sourceSpanRegistryPath, "utf8")),
    evidence_sha256: sha256Text(await readFile(workspace.evidenceManifestPath, "utf8")),
    markdown_sha256: sha256Text(await readFile(workspace.sourceMarkdownPath, "utf8")),
    table_structure_sha256: sha256Text(await readFile(join(workspace.root, "table-structure.json"), "utf8")),
  };
  const restored = await RevisionWorkspace.reviseFromModelingCheckpoint(workspace.artifactRoot, workspace.jobId, workspace.targetId, proof);
  const before = await readFile(restored.workingSelectorPath, "utf8");
  const stateBefore = await restored.readState();
  const resumed = await ToolController.create(restored);
  const context = await resumed.dispatch("get_target_context", { limit: 100 }) as any;
  expect(context.current_source_repair).toMatchObject({
    validation_scope: "source_disposition_coverage", budget_consumed: false, full_stage_check_performed: false,
    actual: { counts: { lots: 1, items: 0, source_dispositions: 1 } },
    next_tool: "read_target_selectors", next_tool_arguments: { collection: "source_dispositions" },
    writable_paths: expect.arrayContaining(["/items", "/source_dispositions"]),
    selector_issues: expect.arrayContaining([expect.objectContaining({ code: "compiler_unhandled_evidence" })]),
  });
  expect(context.current_source_repair.actual.issue_count).toBeGreaterThan(0);
  expect(context.current_source_repair.next_tool_arguments.evidence_ids)
    .toEqual(context.current_source_repair.selector_issues[0].actual.evidence_ids);
  expect(context.current_source_repair.selector_issues).toHaveLength(1);
  expect(context.current_source_repair.issue_page).toMatchObject({ max_issue_count: 1, reported_issue_count: 1 });
  expect(context.current_source_repair.instruction).toContain("先保存");
  const fullStageCheck = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
  const seen = new Set(context.current_source_repair.selector_issues.flatMap((issue: any) => issue.actual.evidence_ids));
  let navigation = context.current_source_repair.next_diagnostic_page;
  expect(navigation).toMatchObject({ next_tool: "get_target_context", next_tool_arguments: { source_repair_cursor: 1 } });
  while (navigation) {
    expect(Check(createPiTools(resumed).find(tool => tool.name === navigation.next_tool)!.parameters, navigation.next_tool_arguments)).toBe(true);
    const next = await resumed.dispatch(navigation.next_tool, navigation.next_tool_arguments) as any;
    expect(next.current_source_repair.actual.issue_count).toBe(context.current_source_repair.actual.issue_count);
    expect(next.current_source_repair.stage_retry).toEqual(stateBefore.selector_protocol?.stage_retries);
    for (const id of next.current_source_repair.selector_issues.flatMap((issue: any) => issue.actual.evidence_ids)) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    navigation = next.current_source_repair.next_diagnostic_page;
  }
  expect(seen.size).toBe(context.current_source_repair.actual.issue_count);
  const refreshed = await resumed.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
  expect(refreshed.current_source_repair.selector_issues).toEqual(context.current_source_repair.selector_issues);
  expect(fullStageCheck).not.toHaveBeenCalled();
  expect(await resumed.dispatch(context.current_source_repair.next_tool, context.current_source_repair.next_tool_arguments))
    .toMatchObject({ ok: true, collection: "source_dispositions", view: "records", matching_record_count: 0, rows: [] });
  expect((await restored.readState()).selector_protocol?.stage_retries).toEqual(stateBefore.selector_protocol?.stage_retries);
  expect((await restored.readState()).opened_evidence_ids).toEqual(stateBefore.opened_evidence_ids);
  expect(await readFile(restored.workingSelectorPath, "utf8")).toBe(before);
});

test("terminal checkpoint recovery gets current unresolved receipt guidance without another stage retry", async () => {
  const original = await fixture("table");
  const { manifest, selectors } = original;
  const registry = await original.workspace.readSourceSpanRegistry();
  const origin = manifest.evidence[0]!;
  const span = registry.spans.find(row => row.evidence_id === origin.evidence_id)!;
  manifest.reference_occurrences.push({ occurrence_id: "registered-missing", origin_evidence_id: origin.evidence_id,
    origin_span_id: span.span_id, reference_literal_span_id: span.span_id, origin_fields: ["requirement"],
    raw_reference: origin.text, relation: "合成未解析引用", reference_kind: "clause", target_evidence_ids: [],
    required: false, status: "target_not_found", depth: 1, path: ["synthetic:missing"] });
  const root = await mkdtemp(join(tmpdir(), "restored-reference-receipt-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id,
    { manifest, markdown: await readFile(original.workspace.sourceMarkdownPath) });
  const setup = await ToolController.create(workspace);
  selectors.lots = [{ key: "retained", name: "保存的测试范围", scope_span_ids: [span.span_id], reason: "保留作者范围" }];
  const item = {
    key: "retained-item", lot_key: "retained", name: "保存的测试项目", category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [],
    fields: Object.fromEntries(["name", "requirement", "method", "quantity", "note"].map(field => [field, {
      composition: field === "name" ? "semantic_summary" : "not_applicable",
      span_ids: field === "name" ? [span.span_id] : [], separator: "", reason: "仅验证恢复入口，不预设业务答案。",
    }])),
    table: null, inspection_data_type: "review", inspection_data_type_reason: "测试作者判断。", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "测试作者判断。", confidence: 1 },
    reason: "保留恢复检查点中的作者项目。",
  };
  selectors.source_dispositions = [{ span_ids: registry.spans.map(row => row.span_id), disposition: "context", reason: "合成测试来源已显式交代" }];
  for (const record of manifest.evidence) await setup.dispatch("open_evidence", { evidence_id: record.evidence_id });
  expect(await setup.dispatch("stage_target_selector_draft", { draft: {
    lots: selectors.lots, items: [item], source_dispositions: selectors.source_dispositions,
  } })).toMatchObject({ ok: true });
  await workspace.updateState(state => {
    state.target_review_protocol = "direct-validation/v1";
    state.selector_stage = "table";
    state.selector_protocol.stage_retries = { stage: "table", best_stage_rank: 1.5, best_issue_count: 1, consecutive_non_improvements: 3 };
    state.selector_protocol.last_stage_issues = [{ code: "selector_registered_reference_receipt_missing", path: "/references", how_to_pass: "过往被截断的修法" }];
  });
  const terminal = await ToolController.create(workspace);
  mockCompletedStageCheck(terminal, { ok: false, issues: [{
    code: "selector_registered_reference_receipt_missing", path: "/references", how_to_pass: "过往被截断的修法",
  }] });
  expect(await terminal.dispatch("advance_target_selector_stage", { next_stage: "commit" })).toMatchObject({ terminal: true });
  await workspace.markTerminal("failed", "selector_stage_incomplete");
  const restored = await RevisionWorkspace.reviseFromTerminalFailure(workspace.artifactRoot, workspace.jobId, workspace.targetId,
    { resumeModelingPhaseBudget: true });
  const resumed = await ToolController.create(restored);
  const before = await restored.readState();
  const selectorsBefore = await readFile(restored.workingSelectorPath, "utf8");
  expect(before.lineage?.recovery_kind).toBe("terminal_checkpoint");
  const startupPrompt = runtime.targetSelectorStartupPrompt({ job_id: restored.jobId, target_id: restored.targetId,
    recovering_coverage_failure: false, resume: true, ...resumed.selectorStartupContext() });
  expect(startupPrompt).toContain("<repair_navigation>");
  expect(JSON.parse(startupPrompt.match(/<repair_navigation>\s*([\s\S]*?)\s*<\/repair_navigation>/u)[1])).toEqual(resumed.selectorStartupContext().resume_focus);
  expect(startupPrompt).toContain("未列出不等于通过");
  const fullStageCheck = vi.spyOn(resumed as any, "validateSelectorStageCompleteness");
  const context = await resumed.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
  expect(context.current_source_repair).toMatchObject({ budget_consumed: false, full_stage_check_performed: false,
    validation_scope: "source_and_reference_receipt_coverage", actual: { issue_count: 1 },
    selector_issues: [{ code: "selector_registered_reference_receipt_missing", actual: { status: "target_not_found", required: false },
      how_to_pass: expect.stringContaining("不会把未解析目标变成通过") }] });
  expect(fullStageCheck).not.toHaveBeenCalled();
  expect((await restored.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
  expect(await readFile(restored.workingSelectorPath, "utf8")).toBe(selectorsBefore);
});

test("ordinary target context does not run a continuation source check", async () => {
  const { controller } = await fixture("table");
  expect(await controller.dispatch("get_target_context", {})).not.toHaveProperty("current_source_repair");
});

test("stage retries track actual improvement across reopen and cannot be reset by saving explanations", async () => {
  const { controller, workspace, manifest } = await fixture();
  const first = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }) as any;
  expect(first).toMatchObject({ terminal: false, stage_retry: { count: 0, progress: "initial", best_issue_count: 2 } });
  expect(first).toMatchObject({ budget_consumed: false, budget_scope: "candidate_validation", full_stage_check_performed: true,
    stage_retry_accounting: { scope: "consecutive_non_improvements", consumed: false, count: 0, limit: 3 } });
  expect(first.stage_retry.evaluation_basis).toEqual({stage_rank:1,issue_count:2,count_unit:'validation_issue'});
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  await controller.dispatch("open_evidence", { evidence_id: title.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === title.evidence_id)!;
  const lot = { key: "scope", name: "构件检查", scope_span_ids: [span.span_id], reason: "由原文绑定检验范围" };
  expect(await controller.dispatch("stage_target_selector_draft", { draft: { lots: [lot] } })).toMatchObject({ ok: true });
  const improved = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
  expect(improved).toMatchObject({ terminal: false, stage_retry: { count: 0, progress: "improved", best_issue_count: 1 } });
  expect(improved).toMatchObject({ stage_retry_accounting: { consumed: false, count: 0 } });
  const reopened = await ToolController.create(workspace);
  for (let count = 1; count <= 3; count++) {
    expect(await reopened.dispatch("stage_target_selector_draft", { draft: { lots: [{ ...lot, reason: `修订说明 ${count}` }] } })).toMatchObject({ ok: true });
    const result = await reopened.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
    expect(result).toMatchObject({ terminal: count === 3, stage_retry: { count, progress: "stagnation", best_issue_count: 1 } });
    expect(result).toMatchObject({ budget_consumed: false, budget_scope: "candidate_validation",
      stage_retry_accounting: { consumed: true, count, limit: 3 } });
    expect(result.next_tool_scope).toBe(count===3?'none':'current_revision');
    if (count === 3) {
      expect(result).toMatchObject({ next_tool: null, next_tools: [], writable_paths: [], next_diagnostic_page: null,
        diagnostic_action_scope: "recovered_revision_only", recovery_guidance: { tool_scope: "recovered_revision_only", budget_policy: "preserve_existing_counters" } });
      expect(result).not.toHaveProperty("next_tool_arguments");
      expect(result.selector_issue_page.required_action).toBe("stop_current_session_and_preserve_checkpoint");
      expect(result.instruction).toContain("原计数持续保留");
      expect(runtime.terminalToolFailure(result)).toBeDefined();
    }
    expect(result.instruction).toContain(count===3?'当前目标已终止':'当前作者错误清空后再执行原检查');
    expect(result.how_to_pass).toContain(count === 3 ? "本 revision 已终止" : "以本工具重新校验");
  }
  expect((await workspace.readState()).selector_protocol).toMatchObject({ protocol_failures: 0, submissions: 0, corrections: 0 });
});

test("improving sampling checks and a completed stage do not terminate the first table feedback", async () => {
  const { controller, workspace } = await fixture("sampling");
  const issues = Array.from({ length: 12 }, (_, index) => ({
    code: "selector_sampling_decision_pending", path: `/items/${index}/sampling/status`, message: "待判断",
  }));
  const validate = vi.spyOn(controller as any, "validateSelectorStageCompleteness")
    .mockResolvedValueOnce({ ok: false, issues })
    .mockResolvedValueOnce({ ok: false, issues: issues.slice(2) })
    .mockResolvedValueOnce({ ok: true, issues: [], globalCandidateComplete: false })
    .mockResolvedValue({ ok: false, issues: Array.from({ length: 3 }, () => ({
      code: "compiler_unhandled_evidence", path: "/source_dispositions", message: "尚未处置的原文",
    })) });
  expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }))
    .toMatchObject({ terminal: false, stage_retry: { count: 0, progress: "initial" } });
  expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }))
    .toMatchObject({ terminal: false, stage_retry: { count: 0, progress: "improved" } });
  expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" })).toMatchObject({ ok: true, stage: "table" });
  expect((await workspace.readState()).selector_protocol?.stage_retries).toBeUndefined();
  expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }))
    .toMatchObject({ terminal: false, current_stage: "table", actual: { issue_count: 3 }, stage_retry: { count: 0, progress: "initial" } });
  expect(validate).toHaveBeenCalledTimes(4);
});

test("stage retry improvement uses the existing preflight score rather than a changed issue fingerprint", async () => {
  const { controller } = await fixture("table");
  const issues = (count: number) => Array.from({ length: count }, (_, index) => ({ code: "compiler_unhandled_evidence", path: `/source_dispositions/${index}`, message: "未覆盖" }));
  const validate = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  for (const [rank, count, progress, retries] of [[1, 2, "initial", 0], [2, 4, "improved", 0], [1, 1, "regression", 1], [2, 5, "regression", 2], [2, 4, "stagnation", 3]] as const) {
    validate.mockResolvedValue({ ok: false, issues: issues(count), preflight: { stage_rank: rank, response: { ok: false } } });
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }))
      .toMatchObject({ terminal: retries === 3, stage_retry: { count: retries, progress } });
  }
});

test("clearing field ownership advances to source coverage even when the revealed source list is larger", async () => {
  const { controller, workspace, manifest } = await fixture("table");
  for (const evidence of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const saved = await controller.dispatch("read_saved_table_structure", {}) as any;
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  expect(await controller.dispatch("stage_table_structure", { table: {
    ...saved.structure.tables[0],
    formal_title_span_ids: [registry.spans.find(span => span.evidence_id === title.evidence_id)!.span_id],
    header_rows: manifest.evidence.filter(row => row.table_row_kind === "header").map(row => row.evidence_id),
    data_rows: manifest.evidence.filter(row => row.table_row_kind === "data").map(row => row.evidence_id),
    review_rows: [], status: "confirmed", reason: "中性夹具只确认结构，不替模型处置验收正文。",
  } })).toMatchObject({ ok: true });
  const fieldCheck = vi.spyOn(controller as any, "targetFieldRoleIssues").mockResolvedValueOnce([
    { code: "selector_field_span_crosses_table_boundaries", path: "/items/0/fields/method/span_ids/0", message: "中性物理来源越界" },
  ]).mockResolvedValue([]);
  const fields = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(fields).toMatchObject({ actual: { issue_count: 1 }, stage_retry: { best_stage_rank: 0.5, count: 0 } });
  // A changed source binding represents a saved repair. An unchanged second
  // check must reuse its result rather than call a mock that silently changes.
  const source = manifest.evidence[0]!;
  const repairedRegistry = registerSourceSpan(await workspace.readSourceSpanRegistry(),
    { source_id: source.evidence_id, evidence_id: source.evidence_id, atom_id: source.atom_id ?? source.evidence_id, text: source.text }, 0, 1);
  await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(repairedRegistry.registry));
  const sources = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(fieldCheck).toHaveBeenCalledTimes(2);
  expect(sources.actual.issue_count).toBeGreaterThan(fields.actual.issue_count);
  expect(sources.selector_issues.every((issue: any) => issue.code === "compiler_unhandled_evidence")).toBe(true);
  expect(sources).toMatchObject({ terminal: false, stage_retry: { progress: "improved", count: 0, best_stage_rank: 1 } });
});

test.each([false, true])("a complete retained field receipt reclassifies its legacy gate after restore, inherited=%s", async inherited => {
  const original = await fixture("table");
  await original.workspace.appendEvent("tool_execution_end", { tool_name: "advance_target_selector_stage", output: {
    current_stage: "table", actual: { issue_count: 1 }, selector_issues: [{ code: "selector_field_clause_line_mismatch" }],
    stage_retry: { progress: "improved", best_stage_rank: 1, best_issue_count: 1, evaluation_basis: { stage_rank: 1 } },
  } });
  await original.workspace.updateState(state => { state.selector_protocol!.stage_retries = {
    stage: "table", best_stage_rank: 1, best_issue_count: 1, consecutive_non_improvements: 3,
  }; });
  const originalState = await original.workspace.readState();
  let workspace = original.workspace;
  if (inherited) {
    workspace = await RevisionWorkspace.createFromEvidence(workspace.artifactRoot, workspace.jobId, workspace.targetId,
      { manifest: original.manifest, markdown: Buffer.from(await readFile(workspace.sourceMarkdownPath, "utf8")) });
    await workspace.updateState(state => {
      state.target_review_protocol = "direct-validation/v1"; state.selector_stage = "table";
      state.selector_protocol = structuredClone(originalState.selector_protocol);
      state.lineage = { schema_version: "revision-lineage/v1", source_revision: original.workspace.revision,
        selector_checkpoint_revision: original.workspace.revision, registry_checkpoint_revision: original.workspace.revision,
        evidence_checkpoint_revision: original.workspace.revision, recovery_kind: "terminal_checkpoint" };
    });
  }
  const restored = await ToolController.create(workspace);
  await restored.dispatch("read_target_selectors", {});
  expect((await workspace.readState()).selector_protocol?.stage_retries).toEqual(originalState.selector_protocol?.stage_retries);
  const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
  const validate = vi.spyOn(restored as any, "validateSelectorStageCompleteness");
  for (const count of [9, 4]) {
    validate.mockResolvedValue({ ok: false, issues: Array.from({ length: count }, () => ({ code: "compiler_unhandled_evidence" })),
      preflight: { stage_rank: 1, response: { ok: false } } });
    const result = await restored.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
    expect(result).toMatchObject({ terminal: false, stage_retry: { count: 0, progress: "improved", best_stage_rank: 1, best_issue_count: count } });
    if (count === 9) expect(result.stage_retry.retained_best_score).toMatchObject({ original_stage_rank: 1, stage_rank: 0.5,
      issue_count: 1, receipt_revision: original.workspace.revision, counter_before_check: 3 });
    else expect(result.stage_retry.retained_best_score).toBeUndefined();
  }
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
  if (inherited) expect((await original.workspace.readState()).selector_protocol?.stage_retries).toEqual(originalState.selector_protocol?.stage_retries);
});

test("a complete current source-gate receipt overrides an ancestor field-gate receipt with the same coarse score", async () => {
  const original = await fixture("table");
  const output = (code: string) => ({ current_stage: "table", actual: { issue_count: 1 }, selector_issues: [{ code }],
    stage_retry: { progress: "improved", best_stage_rank: 1, best_issue_count: 1, evaluation_basis: { stage_rank: 1 } } });
  await original.workspace.appendEvent("tool_execution_end", { tool_name: "advance_target_selector_stage", output: output("selector_field_clause_line_mismatch") });
  await original.workspace.updateState(state => { state.selector_protocol!.stage_retries = {
    stage: "table", best_stage_rank: 1, best_issue_count: 1, consecutive_non_improvements: 2,
  }; });
  const previous = await original.workspace.readState();
  const workspace = await RevisionWorkspace.createFromEvidence(original.workspace.artifactRoot, original.workspace.jobId,
    original.workspace.targetId, { manifest: original.manifest, markdown: Buffer.from(await readFile(original.workspace.sourceMarkdownPath, "utf8")) });
  await workspace.updateState(state => {
    state.target_review_protocol = "direct-validation/v1"; state.selector_stage = "table";
    state.selector_protocol = structuredClone(previous.selector_protocol);
    state.lineage = { schema_version: "revision-lineage/v1", source_revision: original.workspace.revision,
      selector_checkpoint_revision: original.workspace.revision, registry_checkpoint_revision: original.workspace.revision,
      recovery_kind: "terminal_checkpoint" };
  });
  await workspace.appendEvent("tool_execution_end", { tool_name: "advance_target_selector_stage", output: output("compiler_unhandled_evidence") });
  const controller = await ToolController.create(workspace);
  await controller.dispatch("read_target_selectors", {});
  mockCompletedStageCheck(controller, { ok: false,
    issues: Array.from({ length: 4 }, () => ({ code: "compiler_unhandled_evidence" })), preflight: { stage_rank: 1, response: { ok: false } } });
  const result = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(result).toMatchObject({ terminal: true, stage_retry: { count: 3, progress: "regression" } });
  expect(result.stage_retry.retained_best_score).toBeUndefined();
});

test.each(["absent", "other_stage", "other_count", "source_gate", "incomplete", "malformed"])("does not guess an old field gate from %s receipt", async kind => {
  const { workspace } = await fixture("table");
  if (kind !== "absent") await workspace.appendEvent("tool_execution_end", { tool_name: "advance_target_selector_stage", output: {
    current_stage: kind === "other_stage" ? "primary" : "table",
    actual: { issue_count: kind === "other_count" ? 2 : 1 },
    selector_issues: kind === "incomplete" ? [] : [kind === "malformed" ? null : {
      code: kind === "source_gate" ? "compiler_unhandled_evidence" : "selector_field_clause_line_mismatch",
    }], stage_retry: { progress: "improved", best_stage_rank: 1, best_issue_count: 1, evaluation_basis: { stage_rank: 1 } },
  } });
  await workspace.updateState(state => { state.selector_protocol!.stage_retries = {
    stage: "table", best_stage_rank: 1, best_issue_count: 1, consecutive_non_improvements: 2,
  }; });
  const restored = await ToolController.create(workspace);
  expect((await workspace.readState()).selector_protocol?.stage_retries?.consecutive_non_improvements).toBe(2);
  vi.spyOn(restored as any, "validateSelectorStageCompleteness").mockResolvedValue({ ok: false,
    issues: Array.from({ length: 4 }, () => ({ code: "compiler_unhandled_evidence" })), preflight: { stage_rank: 1, response: { ok: false } } });
  const rejected = await restored.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(rejected).toMatchObject({ terminal: true, stage_retry: { count: 3, progress: "regression", best_stage_rank: 1, best_issue_count: 1 } });
  expect(rejected.stage_retry.retained_best_score).toBeUndefined();
});

test("clearing source coverage advances to newly revealed compiler findings without clearing retries on restore", async () => {
  const { controller, workspace, manifest, selectors } = await fixture("table");
  for (const evidence of manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const saved = await controller.dispatch("read_saved_table_structure", {}) as any;
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  expect(await controller.dispatch("stage_table_structure", { table: {
    ...saved.structure.tables[0],
    formal_title_span_ids: [registry.spans.find(span => span.evidence_id === title.evidence_id)!.span_id],
    header_rows: manifest.evidence.filter(row => row.table_row_kind === "header").map(row => row.evidence_id),
    data_rows: manifest.evidence.filter(row => row.table_row_kind === "data").map(row => row.evidence_id),
    review_rows: [], status: "confirmed", reason: "只确认中性夹具的表结构，不完成验收判断。",
  } })).toMatchObject({ ok: true });
  const dispositions = manifest.evidence.filter(row => row.requires_disposition).map(row => ({
    span_ids: [registry.spans.find(span => span.evidence_id === row.evidence_id)!.span_id],
    disposition: "context", reason: "仅验证中性夹具的校验检查点顺序。",
  }));
  expect(dispositions.length).toBeGreaterThan(1);
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, source_dispositions: dispositions.slice(1) }, null, 2) + "\n");
  const source = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(source).toMatchObject({ actual: { issue_count: 1 }, stage_retry: { best_stage_rank: 1, best_issue_count: 1 } });
  expect(source.selector_issues.map((issue: any) => issue.code)).toEqual(["compiler_unhandled_evidence"]);
  await workspace.updateState(state => { state.selector_protocol!.stage_retries!.consecutive_non_improvements = 3; });
  const reopened = await ToolController.create(workspace);
  expect((await workspace.readState()).selector_protocol?.stage_retries?.consecutive_non_improvements).toBe(3);
  await workspace.writeWorkingSelectors(JSON.stringify({ ...selectors, source_dispositions: dispositions }, null, 2) + "\n");
  vi.spyOn(compilerContext, "compileTargetSelectorsWithContext").mockImplementation(() => {
    throw new TargetSelectorCompileError([0, 1].map(index => ({
      code: "selector_sampling_decision_pending", path: `/items/${index}/sampling/status`, message: "中性编译检查未完成。",
      details: { item_key: `neutral-${index}`, actual: "pending" },
    })));
  });
  const compiler = await reopened.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(compiler, JSON.stringify(compiler)).toHaveProperty("actual.issue_count");
  expect(compiler.actual.issue_count).toBeGreaterThan(source.actual.issue_count);
  expect(compiler.selector_issues.every((issue: any) => issue.code !== "compiler_unhandled_evidence")).toBe(true);
  expect(compiler).toMatchObject({ terminal: false, global_candidate_complete: false, stage_retry: { progress: "improved", count: 0, best_stage_rank: 1.5 } });
  expect(await reopened.dispatch("advance_target_selector_stage", { next_stage: "commit" }))
    .toMatchObject({ terminal: false, stage_retry: { progress: "unchanged_inputs_reused", count: 0, best_stage_rank: 1.5 } });
});

test("fixing table structure advances the checkpoint before newly revealed selector findings are counted", async () => {
  const { controller } = await fixture("table");
  const validate = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
  for (const [stage, count, expectedRank, progress] of [
    ["table-structure", 2, 0, "initial"],
    ["target-selectors", 150, 1, "improved"],
    ["target-selectors", 148, 1, "improved"],
  ] as const) {
    validate.mockResolvedValue({ ok: false, issues: Array.from({ length: count }, (_, index) => ({
      code: "selector_test_pending", path: `/source_dispositions/${index}`, message: "待完成的来源决定",
    })), preflight: { stage_rank: 1, response: { ok: false, stage } } });
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }))
      .toMatchObject({ terminal: false, stage_retry: { count: 0, best_stage_rank: expectedRank, best_issue_count: count, progress } });
  }
});

test("actionable selector feedback never exposes required_action as the human repair instruction", async () => {
  const { controller } = await fixture("primary");
  vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([{
    code: "selector_test_generic_repair",
    path: "/items/0/fields/requirement",
    message: "Legacy English diagnostic.",
    details: { required_action: "keep_machine_action" },
  }]);
  const result = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }) as any;
  const issue = result.selector_issues.find((row: any) => row.code === "selector_test_generic_repair");
  expect(issue.details.required_action).toBe("keep_machine_action");
  expect(issue.how_to_pass).toMatch(/[\u3400-\u9fff]/);
  expect(issue.how_to_pass).not.toContain("keep_machine_action");
  expect(issue.how_to_pass).not.toContain("Legacy English diagnostic");
});

test("generic selector repair fallback follows distinct and shared next/save tools", async () => {
  const { controller, selectors } = await fixture("table");
  vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue([
    {
      code: "selector_reference_origin_field_ambiguous",
      path: "/references/0/origin_binding",
      message: "引用原话有多个本地来源候选。",
      details: {
        candidate_origin_bindings: [
          { item_key: "neutral-item-a", target_field: "requirement" },
          { item_key: "neutral-item-b", target_field: "requirement" },
        ],
        repair_options: [
          { kind: "fix_origin_binding", writable_path: "/references/0/origin_binding" },
        ],
        required_action: "choose_one_candidate_origin_binding",
      },
    },
    {
      code: "selector_sampling_branch_quantity_missing",
      path: "/sampling_rules/0/branches/0/components",
      message: "当前抽样分支缺少数量处置。",
      details: {
        writable_collection: "sampling_rules",
        writable_collections: ["sampling_rules", "items"],
        required_action: "bind_source_quantity_or_declare_supported_unspecified_exception",
        next_tool: "stage_target_selector_draft",
      },
    },
  ]);

  const result = await (controller as any).validateStagedSelectorRecords(
    selectors,
    ["/references", "/sampling_rules"],
  ) as any;
  const origin = result.issues.find((issue: any) => issue.code === "selector_reference_origin_field_ambiguous");
  expect(origin).toMatchObject({
    next_tool: "read_target_selectors",
    save_tool: "stage_target_selector_draft",
  });
  expect(origin.how_to_pass).toContain("先调用 next_tool（read_target_selectors）");
  expect(origin.how_to_pass).toContain("再用 save_tool（stage_target_selector_draft）保存修改");
  expect(origin.how_to_pass.indexOf("next_tool（read_target_selectors）"))
    .toBeLessThan(origin.how_to_pass.indexOf("save_tool（stage_target_selector_draft）"));

  const shared = result.issues.find((issue: any) => issue.code === "selector_sampling_branch_quantity_missing");
  expect(shared).toMatchObject({
    next_tool: "stage_target_selector_draft",
    save_tool: "stage_target_selector_draft",
  });
  expect(shared.how_to_pass).toContain("next_tool 与 save_tool 均为 stage_target_selector_draft");
  expect(shared.how_to_pass).toContain("只调用该工具完成修改和保存");
  expect(shared.how_to_pass).not.toContain("先调用 next_tool");
  expect(shared.how_to_pass).not.toContain("再用 save_tool");
});

test("primary required fallback does not invent a save step without save_tool", async () => {
  const { controller } = await fixture("primary");
  const result = await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" }) as any;
  const issue = result.selector_issues.find((row: any) => row.code === "selector_primary_item_required");

  expect(issue).toMatchObject({ next_tool: "stage_target_selector_draft" });
  expect(issue).not.toHaveProperty("save_tool");
  expect(issue.how_to_pass).toContain("当前回条没有 save_tool");
  expect(issue.how_to_pass).toContain("按 next_tool（stage_target_selector_draft）完成当前修复或读取步骤");
  expect(issue.how_to_pass).not.toContain("保存");
});

test("origin binding feedback exposes every source-faithful repair route without choosing a receiver", async () => {
  const root = await mkdtemp(join(tmpdir(), "selector-origin-feedback-"));
  roots.push(root);
  const markdown = "## 6.1 部件\n\n6.1.1 若设置限位装置，应符合本规范附录 A 的规定。\n\n## 附录 A\n\nA.1 限位装置应牢固。";
  const hash = sha256Text(markdown);
  const structured = buildStructuredTargetEvidence(
    markdown,
    hash,
    [{ start_line: 1, end_exclusive_line: 8 }],
    false,
    new Set([1, 5]),
  );
  const origin = structured.evidence.find(row => row.text.startsWith("6.1.1"))!;
  const target = structured.evidence.find(row => row.text.startsWith("A.1"))!;
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "origin-feedback", target_id: "neutral-reference-target",
    source: { adapter: "document-domain-agent/v1", file_name: "neutral.md", sha256: hash, semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "neutral-reference-target",
      source_line_count: 7, selected_start_line: 1, selected_end_exclusive_line: 8, selected_heading: "",
      selection_reason: "验证引用来源反馈，不指定接收项目", selected_atom_ids: structured.evidence.map(row => row.evidence_id),
      target_evidence_fragments: structured.evidence.map(row => ({ atom_id: row.evidence_id, text: row.text })), candidates: [],
    },
    evidence: structured.evidence, table_fragments: [], reference_occurrences: [],
    evidence_fingerprint: sha256Text(`origin-feedback\0${hash}`),
  };
  const originSource = { source_id: origin.evidence_id, evidence_id: origin.evidence_id, atom_id: origin.evidence_id, text: origin.text };
  const targetSource = { source_id: target.evidence_id, evidence_id: target.evidence_id, atom_id: target.evidence_id, text: target.text };
  let registry = initialSourceSpanRegistry(manifest.evidence_fingerprint);
  const add = (source: typeof originSource, start: number, end: number) => {
    const registered = registerSourceSpan(registry, source, start, end);
    registry = registered.registry;
    return registered.span;
  };
  const originFull = add(originSource, 0, origin.text.length);
  const conditionText = "若设置限位装置";
  const conditionStart = origin.text.indexOf(conditionText);
  const condition = add(originSource, conditionStart, conditionStart + conditionText.length);
  const literalText = "本规范附录 A";
  const literalStart = origin.text.indexOf(literalText);
  const literal = add(originSource, literalStart, literalStart + literalText.length);
  expect(condition.end).toBeLessThanOrEqual(literal.start);
  const targetFull = add(targetSource, 0, target.text.length);
  manifest.reference_occurrences = [{
    occurrence_id: "reference:neutral-appendix-a",
    origin_evidence_id: origin.evidence_id,
    origin_evidence_ids: [origin.evidence_id],
    origin_span_id: originFull.span_id,
    origin_span_ids: [originFull.span_id],
    reference_literal_span_id: literal.span_id,
    reference_literal_span_ids: [literal.span_id],
    reference_literal: { evidence_id: origin.evidence_id, start: literal.start, end: literal.end },
    reference_literals: [{ evidence_id: origin.evidence_id, start: literal.start, end: literal.end }],
    origin_fields: ["requirement"], raw_reference: literalText, normalized_reference: "本规范附录 A",
    target_evidence_ids: [target.evidence_id], required: true, status: "resolved", depth: 1, path: ["appendix:A"],
    reference_kind: "clause", target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "appendix:A" },
  }];
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; state.selector_stage = "table"; });
  const controller = await ToolController.create(workspace);
  await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id });
  await controller.dispatch("open_evidence", { evidence_id: target.evidence_id });
  const item = {
    key: "item-neutral", lot_key: "lot-neutral", name: "限位装置牢固性", category: "一般项目",
    criterion_span_ids: [condition.span_id, targetFull.span_id], continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [targetFull.span_id], separator: "", reason: "按原文概括被检对象与属性。" },
      requirement: { composition: "reference", span_ids: [condition.span_id, targetFull.span_id], separator: "", reason: "保留本地条件与被引判据。" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定方法。" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定数量。" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定备注。" },
    },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "按原文核对牢固状态。", inspection_data_type_span_ids: [targetFull.span_id],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "原文未规定抽样。", confidence: 1 },
    reason: "承载本地条件与被引验收判据。",
  };
  const reference = {
    key: "ref-neutral", anchor_span_ids: [literal.span_id], target_span_ids: [targetFull.span_id],
    occurrence_id: "reference:neutral-appendix-a",
    component_dispositions: [{ component_span_ids: [targetFull.span_id], decision: "independent_item", item_keys: [item.key], reason: "被引条款提供实际验收判据。" }],
    action: "adopt", application_mode: "reference_only",
    origin_binding: { item_key: item.key, target_field: "requirement" },
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "只向 requirement 导入被引判据。" },
    destinations: [{ item_key: item.key, target_field: "requirement" }],
    reason: "保留本地引用及被引内容的来源关系。",
  };
  const staged = await controller.dispatch("stage_target_selector_draft", { draft: {
    lots: [{ key: "lot-neutral", name: "部件检验批", scope_span_ids: [originFull.span_id], reason: "同一验收范围。" }],
    items: [item], references: [reference],
  } }) as any;
  expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, local_validation: { ok: false } });
  const issue = staged.local_validation.issues.find((row: any) => row.code === "selector_reference_origin_binding_missing");
  expect(issue, JSON.stringify(staged.local_validation.issues)).toMatchObject({
    code: "selector_reference_origin_binding_missing",
    path: "/references/0/origin_binding",
    writable_path: "/items",
    writable_collections: ["items", "references"],
    allowed_actions: ["bind_local_field_spans", "fix_origin_binding", "fix_immutable_occurrence", "fix_destinations_or_components"],
    candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "open_evidence", "locate_evidence_span"],
    save_tool: "stage_target_selector_draft",
    next_tool: "read_target_selectors",
    details: {
      candidate_origin_bindings: [],
      required_action: "repair_local_field_binding_or_reresolve_occurrence_do_not_choose_from_empty_list",
    },
  });
  expect(issue.writable_paths).toEqual(expect.arrayContaining([
    "/items", "/items/<index>/fields/<field>/span_ids",
    "/references/0/origin_binding", "/references/0/destinations",
    "/references/0/component_dispositions", "/references/0/import_scope",
  ]));
  expect(issue.next_tools).toEqual(expect.arrayContaining([
    "read_target_selectors", "stage_target_selector_draft", "resolve_document_reference",
  ]));
  expect(issue.how_to_pass).toContain("仅修改 origin_binding 或 reason");
  expect(issue.how_to_pass).toContain("不得由 harness 指定接收 item 或字段");
  expect(issue.how_to_pass).not.toContain(item.key);
  for (const tool of issue.next_tools) expect(offeredTools(controller)).toContain(tool);

  const advanced = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" }) as any;
  expect(advanced, JSON.stringify(advanced)).toMatchObject({
    ok: false,
    error: "selector_repair_required",
    next_tool: "read_target_selectors",
  });
  expect(advanced.next_tools).toEqual(expect.arrayContaining([
    "read_target_selectors", "stage_target_selector_draft", "resolve_document_reference",
  ]));
  expect(advanced.writable_paths).toEqual(expect.arrayContaining([
    "/items", "/references/0/origin_binding", "/references/0/destinations",
    "/references/0/component_dispositions", "/references/0/import_scope",
  ]));
  const advancedIssue = advanced.selector_issues.find((row: any) => row.code === "selector_reference_origin_binding_missing");
  expect(advancedIssue).toMatchObject({ next_tools: issue.next_tools, candidate_read_tools: issue.candidate_read_tools });
  for (const tool of advanced.next_tools) expect(offeredTools(controller)).toContain(tool);

  // A literal may be covered by a field that conflicts with the immutable
  // occurrence. Never offer that field as an immediately valid choice.
  const misbound = structuredClone(item);
  misbound.fields.quantity = { composition: "reference", span_ids: [originFull.span_id], separator: "", reason: "故意把完整来源放入另一角色以验证反馈。" };
  const conflictResult = await controller.dispatch("stage_target_selector_draft", { draft: { items: [misbound], references: [reference] } }) as any;
  const conflict = conflictResult.local_validation.issues.find((row: any) => row.code === "selector_reference_origin_field_ambiguous");
  expect(conflict, JSON.stringify(conflictResult.local_validation)).toMatchObject({ details: {
    occurrence_origin_fields: ["requirement"],
    candidate_origin_bindings: [],
    observed_literal_bindings: [{ item_key: item.key, target_field: "quantity", occurrence_role_compatible: false }],
    required_action: "repair_field_binding_or_reresolve_conflicting_origin",
  } });
  expect(conflict.message).not.toContain("多个");
  expect(conflict.how_to_pass).toContain("同时");

  const savedMisbound = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  // An empty/multi-role occurrence has no single-field constraint in the
  // validator. The navigation feedback must preserve that existing boundary.
  for (const originFields of [[], ["requirement", "method"]]) {
    try {
      compileTargetSelectors(savedMisbound, registry, { ...manifest,
        reference_occurrences: manifest.reference_occurrences.map(row => ({ ...row, origin_fields: originFields as typeof row.origin_fields })),
      });
      throw new Error("fixture must retain its intentionally missing origin binding");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const diagnostic = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_origin_field_ambiguous");
      expect(diagnostic).toMatchObject({ details: {
        candidate_origin_bindings: [{ item_key: item.key, target_field: "quantity" }],
        required_action: "choose_one_candidate_origin_binding",
      } });
      expect(diagnostic!.message).toContain("1 个");
    }
  }

  const repairedItem = structuredClone(item);
  repairedItem.criterion_span_ids = [originFull.span_id, targetFull.span_id];
  repairedItem.fields.requirement.span_ids = [originFull.span_id, targetFull.span_id];
  const repaired = await controller.dispatch("stage_target_selector_draft", { collection: "items", draft: { items: [repairedItem] } }) as any;
  expect(repaired, JSON.stringify(repaired)).toMatchObject({ ok: true });
  expect(repaired.local_validation.issues).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "selector_reference_origin_binding_missing" }),
  ]));
});

test("ToolController compiler-issue wrapping exposes every repair path without changing machine tokens", async () => {
  const { controller, selectors } = await fixture("table");
  const compilerIssues = [
    {
      code: "selector_nonempty_field_unbound", path: "/items/0/fields/method", message: "字段缺少来源。",
      details: { required_action: "bind_evidence_spans_or_mark_field_not_applicable", actual: { field: "method" }, writable_paths: ["/items/0/fields/method"], candidate_read_tool: "read_target_selectors", next_tool: "stage_target_selector_draft", how_to_pass: "读取当前 item 后，在绑定来源与标记不适用之间按原文选择。" },
    },
    {
      code: "selector_sampling_rule_missing", path: "/items/0/sampling/rule_key", message: "抽样引用没有对应规则。",
      details: { required_action: "declare_real_shared_sampling_rule_or_change_item_sampling_mode", actual: { rule_key: "missing" }, writable_paths: ["/sampling_rules", "/items/0/sampling"], candidate_read_tool: "read_target_selectors", next_tool: "stage_target_selector_draft", how_to_pass: "读取规则和 item 后，在声明真实规则与取消 reference 之间按原文选择。" },
    },
    {
      code: "selector_acceptance_branches_required", path: "/items/0/table/properties/acceptance_branches", message: "表格条件和值需要明确结构。",
      details: {
        required_action: "choose_same_property_branches_or_split_distinct_properties_into_items",
        actual: { acceptance_branches: [] },
        writable_paths: ["/items/0/table/properties/acceptance_branches", "/items"],
        candidate_read_tools: ["read_target_selectors", "list_table_fragments", "read_table_summary", "read_table_rows"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: "surface" },
        save_tool: "stage_target_selector_draft",
        how_to_pass: "读取当前 item 和表格 fragment 后，在同一属性分支与不同属性拆项之间按原文选择，再保存完整记录。",
      },
    },
    {
      code: "reference_import_scope_exceeded", path: "/references/0/import_scope/allowed_fields", message: "引用导入范围与实际使用不一致。",
      details: { required_action: "align_import_scope_allowed_fields_with_the_exact_reference_content_used_by_each_destination_field_or_remove_the_unauthorized_import", actual: { outside_import_scope: ["name"] }, writable_paths: ["/references/0/import_scope/allowed_fields", "/references/0/destinations", "/references/0/component_dispositions", "/items/0/fields/name"], candidate_read_tool: "read_target_selectors", next_tool: "stage_target_selector_draft", how_to_pass: "读取引用和接收 item 后，在扩大准确授权与删除不应导入来源之间按原文选择。" },
    },
    {
      code: "selector_display_field_span_role_conflict", path: "/items/0", message: "方法和数量字段错误复用了同一来源区间。",
      details: { required_action: "locate_exact_method_and_quantity_spans_and_replace_conflicting_fields", actual: { item_key: "item", roles: ["method", "quantity"] }, writable_paths: ["/items/0/fields/method/span_ids/0", "/items/0/fields/quantity/span_ids/0"], candidate_spans: [{ span_id: "span:method", exact_fragment: "观察检查" }], candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"], next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "item" }, save_tool: "stage_target_selector_draft", how_to_pass: "先读取 item 与原文，再只替换冲突字段的精确来源。" },
    },
    {
      code: "selector_criterion_not_materialized", path: "/items/0/criterion_span_ids/0", message: "判据来源未由当前 item 承载。",
      details: { required_action: "replace_criterion_or_bind_it_to_the_same_item", actual: { item_key: "item" }, writable_paths: ["/items/0/criterion_span_ids", "/items/0/fields", "/items/0/table"], candidate_read_tool: "read_target_selectors", candidate_read_tools: ["read_target_selectors"], next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "item" }, next_tools: ["read_target_selectors", "stage_target_selector_draft"], save_tool: "stage_target_selector_draft", how_to_pass: "先读取当前 item，再由模型依据原文选择修复路径。" },
    },
    {
      code: "selector_scalar_span_conflates_item_roles", path: "/items/0", message: "数量来源区间混入了其他角色。",
      details: { required_action: "replace_scalar_bindings_with_exact_role_spans", actual: { item_key: "item" }, writable_paths: ["/items/0/fields/quantity/span_ids/0"], candidate_spans: [{ span_id: "span:quantity", exact_fragment: "抽查五件" }], candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"], next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft", how_to_pass: "先读取 item 与原文，再只替换数量来源。" },
    },
    {
      code: "selector_reference_component_item_mismatch", path: "/references/0/component_dispositions/0/item_keys", message: "被引组件与接收 item 的来源覆盖不一致。",
      details: { required_action: "组件处置点名的真实 item 必须用自身 provenance 完整覆盖这些 component spans。", actual: { reference_key: "ref", item_keys: ["item"] }, writable_paths: ["/references/0/component_dispositions/0/item_keys", "/items/0/criterion_span_ids", "/items/0/fields", "/items/0/table", "/items/0/sampling"], candidate_read_tools: ["read_target_selectors", "list_reference_occurrences", "read_reference_facts"], next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft", how_to_pass: "读取引用和 item 后，在修正接收者与补全真实 provenance 之间按原文选择。" },
    },
    {
      code: "table_evidence_relation", path: "/items/0/criterion_span_ids", message: "表格结构使用的来源尚未由同一验收项的作者来源或指向该项的显式引用路由承载。",
      details: {
        required_action: "由模型核对原文后，把报错表格来源绑定到同一 item 的真实作者来源，或补齐、修正指向该 item 的显式引用路由。",
        actual: { item_key: "item", unowned_table_evidence_ids: ["evidence:table-row"] },
        writable_paths: ["/items/0/criterion_span_ids", "/items/0/continuation_span_ids", "/items/0/fields", "/references"],
        writable_collections: ["items", "references"],
        allowed_actions: ["按原文绑定同项作者来源。", "按原文补齐显式引用路由。"],
        candidate_read_tools: [
          "read_target_selectors",
          "list_table_fragments",
          "read_table_summary",
          "read_table_rows",
          "open_evidence",
          "list_reference_occurrences",
          "read_document_reference_evidence",
          "read_reference_facts",
          "locate_evidence_span",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: "item" },
        save_tool: "stage_target_selector_draft",
        how_to_pass: "先读取当前 item、references 和实际原文，再由模型依据原文选择作者来源或显式引用路由；回条不指定业务归属或答案。",
      },
    },
  ];
  vi.spyOn(controller as any, "selectorCompilerIssues").mockResolvedValue(compilerIssues);
  const result = await (controller as any).validateStagedSelectorRecords(
    selectors,
    ["/items", "/sampling_rules", "/references"],
  ) as any;
  for (const expected of compilerIssues) {
    const issue = result.issues.find((row: any) => row.code === expected.code);
    expect(issue).toMatchObject({
      code: expected.code,
      message: expect.stringMatching(/[\u3400-\u9fff]/),
      actual: expected.details.actual,
      how_to_pass: expect.stringMatching(/[\u3400-\u9fff]/),
      writable_paths: expected.details.writable_paths,
      next_tool: expected.details.next_tool,
      details: { required_action: expected.details.required_action },
    });
    const candidateReadTools = "candidate_read_tools" in expected.details
      ? expected.details.candidate_read_tools
      : [expected.details.candidate_read_tool];
    expect(offeredTools(controller)).toEqual(expect.arrayContaining(candidateReadTools));
    if ("next_tool_arguments" in expected.details) {
      expect(issue.next_tool_arguments).toEqual(expected.details.next_tool_arguments);
    }
    if ("save_tool" in expected.details) expect(issue.save_tool).toBe(expected.details.save_tool);
  }
  for (const code of ["selector_display_field_span_role_conflict", "selector_criterion_not_materialized"]) {
    const issue = result.issues.find((row: any) => row.code === code);
    expect(issue).toMatchObject({
      next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "items", key: "item" },
      save_tool: "stage_target_selector_draft",
    });
    expect(issue.next_tools[0]).toBe(issue.next_tool);
    expect(issue.next_tools).toContain(issue.save_tool);
  }
  const criterionIssue = result.issues.find((row: any) => row.code === "selector_criterion_not_materialized");
  expect(criterionIssue.details).not.toHaveProperty("correct_span_id");
  expect(criterionIssue.details).not.toHaveProperty("answer");
  expect(criterionIssue.details).not.toHaveProperty("canonical_quantity");
  const tableRelationIssue = result.issues.find((row: any) => row.code === "table_evidence_relation");
  expect(tableRelationIssue).toMatchObject({
    next_tool: "read_target_selectors",
    next_tool_arguments: { collection: "items", key: "item" },
    save_tool: "stage_target_selector_draft",
    writable_paths: ["/items/0/criterion_span_ids", "/items/0/continuation_span_ids", "/items/0/fields", "/references"],
    candidate_read_tools: expect.arrayContaining([
      "list_table_fragments",
      "read_table_summary",
      "read_table_rows",
      "list_reference_occurrences",
      "read_document_reference_evidence",
      "read_reference_facts",
    ]),
    allowed_actions: ["按原文绑定同项作者来源。", "按原文补齐显式引用路由。"],
  });
  expect(tableRelationIssue.next_tools).toEqual(expect.arrayContaining([
    "read_target_selectors",
    "stage_target_selector_draft",
  ]));
  expect(tableRelationIssue.details).not.toHaveProperty("correct_item_key");
  expect(tableRelationIssue.details).not.toHaveProperty("answer");
});

test("sampling branch quantity feedback exposes the same two author repair routes after stage and advance", async () => {
  const { controller, workspace, manifest } = await fixture("sampling");
  const evidence = manifest.evidence.find(row => row.role === "formal_table_title")!;
  await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === evidence.evidence_id)!;
  const branchComponents = [
    { key: "default:quantity", role: "quantity", disposition: "absent", span_ids: [], reason: "当前分支尚未绑定数量" },
    { key: "default:method", role: "method", disposition: "present", span_ids: [span.span_id], reason: "保留真实抽验义务" },
    { key: "default:condition", role: "branch_condition", disposition: "absent", span_ids: [], reason: "无业务条件" },
  ];
  const samplingRule = {
    key: "shared-sampling", complete_span_ids: [span.span_id],
    components: [
      { key: "shared:applicability", role: "applicability", disposition: "absent", span_ids: [], reason: "无共享适用条件" },
      { key: "shared:criterion", role: "acceptance_criterion", disposition: "absent", span_ids: [], reason: "无共享判定标准" },
      { key: "shared:exception", role: "exception", disposition: "absent", span_ids: [], reason: "无共享例外" },
      { key: "shared:note", role: "note", disposition: "absent", span_ids: [], reason: "无共享备注" },
    ],
    branches: [{ key: "default", applies_to_category: "all_items", components: branchComponents, reason: "默认结构分支" }],
    reason: "构造缺少数量的真实共享抽样分支",
  };
  const item = {
    key: "sampled-item", lot_key: "sampled-lot", name: "构件检查", category: "一般项目",
    criterion_span_ids: [span.span_id], continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [span.span_id], separator: "", reason: "被检对象" },
      requirement: { composition: "verbatim", span_ids: [span.span_id], separator: "", reason: "检查要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "由共享抽样规则表达" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "由共享抽样规则表达" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "review", inspection_data_type_reason: "按原文核对。", inspection_data_type_span_ids: [span.span_id],
    sampling: { status: "reference", rule_key: samplingRule.key, branch_keys: ["default"], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "选择共享抽样分支", confidence: 1 },
    reason: "独立验收项",
  };

  const staged = await controller.dispatch("stage_target_selector_draft", { draft: {
    lots: [{ key: "sampled-lot", name: "构件检验批", scope_span_ids: [span.span_id], reason: "同一验收范围" }],
    items: [item], sampling_rules: [samplingRule],
  } }) as any;
  expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, budget_consumed: false, local_validation: { ok: false } });
  const stagedIssue = staged.local_validation.issues.find((row: any) => row.code === "selector_sampling_branch_quantity_missing");
  const branchPath = "/sampling_rules/0/branches/0";
  const branchComponentsPath = `${branchPath}/components`;
  expect(stagedIssue).toMatchObject({
    code: "selector_sampling_branch_quantity_missing",
    path: branchPath,
    actual: { rule_key: samplingRule.key, branch_key: "default", components: branchComponents },
    writable_path: branchComponentsPath,
    writable_paths: [branchComponentsPath, "/items"],
    next_tool: "stage_target_selector_draft",
    writable_collections: ["sampling_rules", "items"],
    candidate_read_tools: ["read_target_selectors", "list_sampling_rules", "open_evidence"],
    allowed_actions: [expect.stringContaining("branch.components"), expect.stringContaining("item.sampling")],
    details: {
      rule_key: samplingRule.key,
      branch_key: "default",
      writable_collection: "sampling_rules",
      required_action: "bind_source_quantity_or_declare_supported_unspecified_exception; remove_only_source_routing_branches",
      candidate_read_tool: "list_sampling_rules",
      related_writable_path: "/items",
    },
  });
  expect(stagedIssue.how_to_pass).toContain("由模型依据原文二选一");
  expect(stagedIssue.how_to_pass).toContain("不得由 harness 指定接收 item");

  const beforeAdvance = await readFile(workspace.workingSelectorPath, "utf8");
  expect(staged.draft_fingerprint).toBe(targetSelectorFingerprint(JSON.parse(beforeAdvance)));
  const advanced = await controller.dispatch("advance_target_selector_stage", { next_stage: "table" }) as any;
  expect(advanced).toMatchObject({ ok: false, error: "selector_repair_required", budget_consumed: false,
    full_stage_check_performed: false, current_stage: "sampling", requested_next_stage: "table" });
  const advancedIssue = advanced.selector_issues.find((row: any) => row.code === "selector_sampling_branch_quantity_missing");
  expect(advancedIssue).toEqual(stagedIssue);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeAdvance);

  const visibleTools = offeredTools(controller);
  for (const tool of [...stagedIssue.candidate_read_tools, stagedIssue.next_tool]) {
    expect(visibleTools).toContain(tool);
  }
});

test.each(["commit", "advance", "blocker"])("%s preserves and executes the table-structure repair route", async (entry) => {
  const { controller, manifest, workspace, fingerprint } = await fixture("table");
  const call = async () => {
    if (entry === "commit") return controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
    if (entry === "advance") return controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
    await controller.dispatch("compile_target_selectors", {});
    const registry = await workspace.readSourceSpanRegistry();
    return controller.dispatch("report_target_blocker", {
      kind: "harness_contract_defect", evidence_span_ids: [registry.spans[0]!.span_id], affected_selector_paths: ["/lots"],
      finding_ids: ["table_structure_confirmation_pending"], explanation: "结构未确认；测试拒绝 blocker 时保留真实修复路线。",
    });
  };
  const rejected = await call();
  const issue = (rejected.selector_issues as any[]).find(row => row.code === "table_structure_confirmation_pending");
  expect(issue).toMatchObject({ next_tool: "read_table_summary", next_tool_arguments: { table_key: expect.any(String) }, save_tool: "stage_table_structure", writable_path: "/tables/0", how_to_pass: expect.stringContaining("只确认结构") });
  expect(rejected).toMatchObject({ terminal: false, next_tool: "read_table_summary", writable_paths: ["/tables/0"], budget_consumed: false });
  expect(offeredTools(controller)).toContain(rejected.next_tool);
  expect(rejected.instruction).not.toContain("用 stage_target_selector_draft 修正");
  if (entry === "blocker") {
    expect(rejected.required_tools).toContain("stage_table_structure");
    expect((rejected.actionable_issues as any[])[0]).toMatchObject({ next_tool: "read_table_summary", save_tool: "stage_table_structure", writable_path: "/tables/0" });
  }

  // Execute the named repair tool using its actual argument schema, not a selector patch.
  const saved = await controller.dispatch("read_saved_table_structure", {}) as any;
  const table = saved.structure.tables[0];
  const readTool = createPiTools(controller).find(tool => tool.name === issue.next_tool)!;
  expect(Check(readTool.parameters, issue.next_tool_arguments)).toBe(true);
  expect(await controller.dispatch(issue.next_tool, issue.next_tool_arguments)).toMatchObject({ ok: true });
  await controller.dispatch("read_table_rows", { table_key: table.table_key });
  const registry = await workspace.readSourceSpanRegistry();
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  const titleSpan = registry.spans.find(span => span.evidence_id === title.evidence_id && span.start === 0 && span.end === title.text.length)!;
  const repairArguments = { table: {
    ...table,
    formal_title_span_ids: [titleSpan.span_id],
    header_rows: manifest.evidence.filter(row => row.table_row_kind === "header").map(row => row.evidence_id),
    data_rows: manifest.evidence.filter(row => row.table_row_kind === "data").map(row => row.evidence_id),
    review_rows: [], status: "confirmed", reason: "已核对真实题注、各行单元格和表头，结构角色明确。",
  } };
  const repairTool = createPiTools(controller).find(tool => tool.name === issue.save_tool)!;
  expect(Check(repairTool.parameters, repairArguments)).toBe(true);
  const repaired = await controller.dispatch(repairTool.name, repairArguments);
  expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
  const retried = await call();
  const remaining = (retried.selector_issues ?? retried.issues ?? []) as any[];
  expect(remaining.map(row => row.code)).not.toContain("table_structure_confirmation_pending");
  // Missing acceptance items are still rejected; repairing structure cannot bypass semantic checks.
  expect(retried.ok).toBe(false);
});

test("a missing authored reference reaches the model as a repairable receipt without consuming validation budget", async () => {
  const { controller, selectors, fingerprint, workspace, manifest } = await fixture("table");
  const before = await workspace.readState();
  const occurrence = { occurrence_id: "reference:neutral-latch", origin_evidence_id: "evidence:latch",
    reference_kind: "table", raw_reference: "表 9.4", target_evidence_ids: [] };
  const issues = classifyStrictSelectorIssues(selectors, {
    schema_version: "semantic-source-plan/v8", source_spans: [], reference_resolutions: [],
  } as any, { spans: [] } as any, [{ code: "reference_resolution_missing", path: "/reference_resolutions",
    message: "Required reference has no resolution", details: { occurrence_id: occurrence.occurrence_id },
  }], { ...manifest, reference_occurrences: [occurrence] } as any);
  const decision = decideStrictSelectorPreflight(issues);
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({
    ok: false, selectors, issues, issue_count: 1, stage_name: "strict-validator", issue_owner: decision.issueOwner,
    response: { ok: false, terminal: !decision.selectorOwned, error: decision.issueOwner, issues },
  });
  const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
  expect(result).toMatchObject({ terminal: false, issue_owner: "selector_input_error", budget_consumed: false,
    next_tool: "list_reference_occurrences", writable_paths: ["/references"] });
  expect(runtime.terminalToolFailure(result)).toBeUndefined();
  const nextTool = createPiTools(controller).find(tool => tool.name === result.next_tool)!;
  expect(offeredTools(controller)).toContain(nextTool.name);
  expect(Check(nextTool.parameters, result.next_tool_arguments)).toBe(true);
  const after = await workspace.readState();
  expect(after.validation_attempts).toEqual(before.validation_attempts);
  expect(after.selector_protocol?.submissions).toEqual(before.selector_protocol?.submissions);
  expect(after.next_history_sequence).toEqual(before.next_history_sequence);
});

test.each(["commit", "advance"])("%s preserves terminal compiler ownership instead of requesting a selector repair", async (entry) => {
  const { controller, selectors, fingerprint, workspace } = await fixture("table");
  const before = await workspace.readState();
  const issue = { code: "compiler_test_invariant", path: "/acceptance_items/0/evidence_ids", owner: "compiler_invariant_violation", message: "隔离注入的编译不变量故障。" };
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({
    ok: false, selectors, issues: [issue], issue_count: 1, stage_name: "compiler-invariant", issue_owner: "compiler_invariant_violation",
    response: { ok: false, terminal: true, error: "compiler_invariant_violation", issue_owner: "compiler_invariant_violation", issues: [issue], instruction: "停止当前目标；程序故障不属于模型修复任务。" },
  });
  const result = await controller.dispatch(entry === "commit" ? "commit_target_selector_draft" : "advance_target_selector_stage", entry === "commit" ? { draft_fingerprint: fingerprint } : { next_stage: "commit" });
  expect(result).toMatchObject({ terminal: true, error: "compiler_invariant_violation", issue_owner: "compiler_invariant_violation", next_tool: null, budget_consumed: false });
  expect(result.writable_paths ?? []).toEqual([]);
  expect(result.instruction).toContain("停止当前目标");
  expect(runtime.terminalToolFailure(result)).toBeDefined();
  expect((result.issues as any[])[0]).not.toHaveProperty("writable_path");
  const after = await workspace.readState();
  expect(after.selector_protocol).toEqual(before.selector_protocol);
  expect(after.validation_attempts).toEqual(before.validation_attempts);
});

test.each(["commit", "advance"])("%s bounds terminal diagnostics without masking the compiler failure", async (entry) => {
  const { controller, selectors, fingerprint, workspace } = await fixture("table");
  const before = await workspace.readState();
  const issues = Array.from({ length: 60 }, (_, index) => ({
    code: index === 59 ? "compiler_test_invariant" : "selector_test_binding",
    path: `/acceptance_items/${index}/evidence_ids`,
    owner: index === 59 ? "compiler_invariant_violation" : "selector_input_error",
    message: "保留终止故障依据与原始问题计数。",
    details: { actual: "已公开的来源依据。".repeat(350) },
  }));
  expect(Buffer.byteLength(JSON.stringify(issues), "utf8")).toBeGreaterThan(131072);
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({
    ok: false, selectors, issues, issue_count: issues.length, stage_name: "strict-validator", issue_owner: "compiler_invariant_violation",
    response: { ok: false, terminal: true, error: "compiler_invariant_violation", issues, instruction: "停止当前目标，保留检查点和公开回条。" },
  });
  const result = await controller.dispatch(entry === "commit" ? "commit_target_selector_draft" : "advance_target_selector_stage", entry === "commit" ? { draft_fingerprint: fingerprint } : { next_stage: "commit" });
  expect(result).toMatchObject({ terminal: true, error: "compiler_invariant_violation", next_tool: null, next_tools: [], writable_paths: [], budget_consumed: false });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(131072);
  expect(result.selector_issue_page).toMatchObject({ raw_issue_count: 60, remaining_issue_count: expect.any(Number) });
  expect((result.selector_issue_page as any).remaining_issue_count).toBeGreaterThan(0);
  expect((result.issues as any[])[0].code).toBe("compiler_test_invariant");
  expect((result.selector_issue_page as any).required_action).toContain("停止");
  expect(runtime.terminalToolFailure(result)).toBeDefined();
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
});

test("repair summaries preserve alternative actions and every authored writable path", async () => {
  const { controller, selectors, fingerprint } = await fixture("table");
  const paths = ["/sampling_rules/0/components", "/sampling_rules/0/branches/0/components", "/items/0/sampling"];
  const options = ["若数量适用于本分支，绑定数量。", "若数量只属于相邻分支，缩小当前分支原文，保留数量未规定状态。"];
  const issue = { code: "selector_sampling_unspecified_quantity_is_full_inspection", path: "/items/0/sampling/branch_keys/0", owner: "selector_input_error", details: { writable_paths: paths, repair_options: options, required_action: "不能用这个单向内部摘要代替完整修法", next_tool: "stage_target_selector_draft" } };
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({ ok: false, selectors, issues: [issue], issue_count: 1, issue_owner: "selector_input_error", response: { ok: false } });
  const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
  expect(result).toMatchObject({ writable_paths: paths, next_tool: "stage_target_selector_draft", selector_issues: [expect.objectContaining({ writable_path: paths[0], writable_paths: paths, how_to_pass: options.join("\n") })] });
});

test.each(["compiler_invariant_violation", "final_contract_violation"])("%s remains terminal even if an inner receipt omitted its terminal flag", async issueOwner => {
  const { controller, selectors, fingerprint } = await fixture();
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({
    ok: false, selectors, issues: [], issue_count: 0, issue_owner: issueOwner,
    response: { ok: false, error: issueOwner, instruction: "程序契约不一致，停止当前目标。" },
  });
  const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
  expect(runtime.terminalToolFailure(result)).toMatchObject({ error: issueOwner });
});

test.each(["primary", "commit"] as const)("successful draft save in %s names a reachable next action", async stage => {
  const { controller, workspace, manifest } = await fixture(stage);
  const title = manifest.evidence.find(row => row.role === "formal_table_title")!;
  await controller.dispatch("open_evidence", { evidence_id: title.evidence_id });
  const registry = await workspace.readSourceSpanRegistry();
  const span = registry.spans.find(row => row.evidence_id === title.evidence_id)!;
  const saved = await controller.dispatch("stage_target_selector_draft", { draft: { source_dispositions: [{ span_ids: [span.span_id], disposition: "context", reason: "题注提供表格上下文，本身没有独立验收判据。" }] } });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, local_validation: { ok: true } });
  const nextTool = stage === "commit" ? "commit_target_selector_draft" : "advance_target_selector_stage";
  expect(saved.next_tool).toBe(nextTool);
  expect(Check(createPiTools(controller).find(tool => tool.name === saved.next_tool)!.parameters, saved.next_tool_arguments)).toBe(true);
  expect(offeredTools(controller)).toContain(nextTool);
  if (stage === "commit") expect(saved.instruction).not.toContain("advance_target_selector_stage");
});

test.each([
  { method: "recordTableExpansionIssueProgress", codes: ["selector_table_distinct_core_properties_merged", "selector_acceptance_branches_required"], details: { item_key: "same-item" } },
  { method: "recordReferenceIssueProgress", codes: ["selector_reference_origin_field_mismatch", "reference_destination_field_mismatch"], details: { occurrence_id: "same-occurrence" } },
])("$method stops on oscillation without instructing this session to keep editing", async ({ method, codes, details }) => {
  const { controller } = await fixture();
  let result: any;
  for (const code of [codes[0], codes[1], codes[0]]) {
    result = await (controller as any)[method]([{ code, details }]);
  }
  expect(result).toMatchObject({ terminal: true, required_action: expect.stringMatching(/^stop_target_and_preserve_/) });
  expect(result.instruction).toContain("当前目标已终止");
  expect(result.instruction).toContain("不再读取、修改或重交");
  expect(runtime.TARGET_SELECTOR_SYSTEM_PROMPT).toContain("terminal=true 后不再读、写、修复、验证或封存");
});

test("final validation termination keeps its stop instruction through selector commit", async () => {
  const { controller, selectors, fingerprint, workspace } = await fixture();
  const content = await readFile(workspace.workingPlanPath, "utf8");
  const compilerContext = (await (controller as any).evaluateTargetSelectorPreflight(
    selectors,
    false,
    false,
  )).compiler_context;
  expect(compilerContext).toBeDefined();
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({
    ok: true, selectors, issues: [], issue_count: 0, issue_owner: "", compiled: JSON.parse(content), compiled_content: content, compiler_context: compilerContext, response: { ok: true },
  });
  const instruction = "验证次数已耗尽；停止当前 revision 并保留检查点，不再提交。";
  vi.spyOn(controller as any, "validateWorkingPlan").mockResolvedValue({ ok: false, terminal: true, error: "final_validator_attempt_limit", instruction });
  const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
  expect(result).toMatchObject({ terminal: true, instruction: expect.stringContaining("当前目标已终止"), error: "final_validator_attempt_limit", budget_consumed: false });
  expect(runtime.terminalToolFailure(result)).toMatchObject({ error: "final_validator_attempt_limit" });
});

test("mixed repair routes retain exact metadata and do not rewrite read-first errors as draft edits", async () => {
  const { controller, selectors, fingerprint } = await fixture();
  const issues = [
    { code: "reference_facts_required", path: "/references/0", owner: "selector_input_error", actual: "尚未读取引用事实", how_to_pass: "先读取目标引用事实，保留已有正确绑定。", writable_path: "/references/0/import_scope", next_tool: "read_reference_facts", do_not_edit: "已解析引用原文" },
    { code: "table_structure_confirmation_pending", path: "/table_structure/tables/0/status", owner: "selector_input_error", message: "结构待确认", details: { actual: "review", how_to_pass: "读表后确认结构。", writable_path: "/tables/0", next_tool: "stage_table_structure" } },
  ];
  vi.spyOn(controller as any, "evaluateTargetSelectorPreflight").mockResolvedValue({ ok: false, selectors, issues, issue_count: 2, issue_owner: "selector_input_error", response: { ok: false, terminal: false } });
  const result = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: fingerprint });
  expect(result).toMatchObject({ next_tool: "read_reference_facts", next_tools: ["read_reference_facts", "stage_table_structure"], writable_paths: ["/references/0/import_scope", "/tables/0"] });
  expect((result.selector_issues as any[])[0]).toMatchObject(issues[0]);
  expect((result.selector_issues as any[])[1]).toMatchObject(issues[1].details!);
  expect(offeredTools(controller)).toEqual(expect.arrayContaining(result.next_tools as string[]));
});

test.each(["primary", "sampling", "table", "commit"] as const)("%s provides the read tools required by repair feedback and startup", async stage => {
  const { controller } = await fixture(stage);
  const offered = offeredTools(controller);
  expect(offered).toEqual(expect.arrayContaining(["get_target_context", "get_target_selector_contract", "list_sampling_rules", "read_saved_table_structure", "read_table_summary", "read_table_rows", "read_adjacent_source"]));
  expect(offered).not.toContain("patch_working_plan");
  expect(offered).not.toContain("review_target_selector_draft");
});

test("failed-receipt recovery renders selector-only repair instructions using available tools", async () => {
  const { workspace } = await fixture("commit");
  await writeFile(workspace.validationReceiptPath, JSON.stringify({ ok: false, issues: [{ code: "field_binding_value_mismatch", path: "/acceptance_items/0/requirement", message: "字段值与绑定不一致。" }] }));
  await workspace.updateState(state => { delete state.repair; });
  const recovered = await ToolController.create(workspace);
  const repair = await recovered.repairStatus();
  expect(repair).toMatchObject({ mode: "repair", repair_source: "validation" });
  const prompt = runtime.targetRepairPrompt(repair, true);
  for (const tool of ["read_target_selectors", "commit_target_selector_draft", "stage_target_selector_draft"]) {
    expect(prompt).toContain(tool);
    expect(offeredTools(recovered)).toContain(tool);
  }
  expect(prompt).not.toContain("patch_working_plan");
  expect(prompt).not.toContain("同事务更新相关 semantic_evidence");
  expect(prompt).toContain("旧验证回执");
  expect(prompt).toContain("不是可写路径");
});

test("legacy validation repair keeps its supported patch protocol and modeling gets no repair prompt", () => {
  const repair = { ...repairStateOrDefault(undefined), mode: "repair" as const };
  expect(runtime.targetRepairPrompt(repair, false)).toContain("patch_working_plan");
  expect(runtime.targetRepairPrompt(repairStateOrDefault(undefined), true)).toBe("");
});

test.each(["mm", "MPa"])("%s unit guidance leads to a real header span instead of nonexistent data-row labels", async unit => {
  const { controller, manifest } = await fixture("commit", unit);
  const contract = await controller.dispatch("get_target_selector_contract", {}) as any;
  expect(contract.authoring_protocols.tables).toContain("真实表头/表注");
  expect(contract.authoring_protocols.tables).toContain("整行不复制到每个标量");
  const row = manifest.evidence.find(record => record.cells?.includes("属性甲"))!;
  const opened = await controller.dispatch("open_evidence", { evidence_id: row.evidence_id }) as any;
  expect(opened.cells.every((cell: any) => !cell.label_span_id && !cell.label_fragments.length)).toBe(true);
  const header = manifest.evidence.find(record => record.cells?.includes(`允许值(${unit})`))!;
  await controller.dispatch("open_evidence", { evidence_id: header.evidence_id });
  const located = await controller.dispatch("locate_evidence_span", { evidence_id: header.evidence_id, quote: unit }) as any;
  expect(located).toMatchObject({ ok: true, span: { evidence_id: header.evidence_id, span_id: expect.any(String) } });
});
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
