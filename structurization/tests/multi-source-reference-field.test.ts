import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { prettyJson, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { compileTargetSelectors, initialTargetSelectorPlan, registeredDocumentReferenceReceiptIssues, unresolvedReferenceDestinationIssues, requiredReferenceAnchorOnlyEvidenceIds, requiredReferenceFieldOnlyEvidenceIds, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, TargetSelectorCompileError } from "../src/target-selector-compiler.js";
import { compiledUnhandledEvidenceIds, selectorDispositionCoverage } from "../src/evidence-disposition-coverage.js";
import { registryWithFullSourceSpans, locateAndRegisterSourceQuote } from "../src/source-span-registry.js";
import { validatePlanText } from "../src/validator.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { materialize } from "../src/materializer.js";
import { MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE, TABLE_SOURCE_OWNERSHIP_GUIDANCE } from "../src/acceptance-delivery-contract.js";
import { TARGET_SELECTOR_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { TARGET_SELECTOR_PROTOCOLS } from "../src/acceptance-prompt-suite.js";
import { ToolController, createPiTools, actionableSelectorIssue } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { classifySelectorIssue, classifyStrictSelectorIssues } from "../src/selector-issue-ownership.js";

// Synthetic combination, unrelated to any live document or expected answer.
function fixture(mode: "reference_only" | "reference_placeholder", targets = ["用湿膜测厚规测量。", "干燥后复测厚度。"], tableTarget = false, originText = "初测按本规范第2.1条执行。") {
  const texts = ["涂层厚度应符合设计要求。", originText, tableTarget ? "复测按表 T 执行。" : "复测按本规范第3.1条执行。", ...targets];
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "multi-source", target_id: "coating",
    source: { adapter: "document-domain-agent/v1", file_name: "source.md", sha256: sha256Text(texts.join("\n")), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "coating", source_line_count: 5,
      selected_start_line: 1, selected_end_exclusive_line: 4, selected_heading: "", selection_reason: "合成范围", selected_atom_ids: ["e:0", "e:1", "e:2"], target_evidence_fragments: [], candidates: [] },
    evidence: texts.map((text, i) => ({ evidence_id: `e:${i}`, kind: "paragraph", role: "supporting_clause", locator: `line:${i + 1}`, text, text_sha256: sha256Text(text), requires_disposition: i < 3, evidence_scope: i < 3 ? "primary" : "reference" })),
    table_fragments: [], reference_occurrences: [], evidence_fingerprint: sha256Text(texts.join("\0")),
  };
  const sources = manifest.evidence.map(e => ({ source_id: e.evidence_id, evidence_id: e.evidence_id, atom_id: e.evidence_id, text: e.text }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const ids = sources.map(source => registry.spans.find(s => s.evidence_id === source.evidence_id)!.span_id);
  const plan = initialTargetSelectorPlan(manifest);
  for (const [index, literal] of ["本规范第2.1条", tableTarget ? "表 T" : "本规范第3.1条"].entries()) {
    const origin = index + 1, target = index + 3;
    const located = locateAndRegisterSourceQuote(registry, sources[origin]!, literal);
    registry = located.registry;
    const anchor = located.spans[0]!;
    manifest.reference_occurrences.push({ occurrence_id: `reference:${index}`, origin_evidence_id: `e:${origin}`, origin_fields: ["method"],
      origin_span_id: ids[origin]!, reference_literal_span_id: anchor.span_id, reference_literal: { evidence_id: `e:${origin}`, start: anchor.start, end: anchor.end },
      raw_reference: literal, relation: "同项目方法来源", reference_kind: "clause", target_address: { source_id: "source", locator_kind: "clause", locator: `clause:${index + 2}.1` },
      target_evidence_ids: [`e:${target}`], required: true, status: "resolved", depth: 1, path: [`source:clause:${index + 2}.1`] });
    plan.references.push({ key: `ref${index}`, occurrence_id: `reference:${index}`, anchor_span_ids: [anchor.span_id], target_span_ids: [ids[target]!], action: "keep_reference", application_mode: mode,
      import_scope: { mode: "field_specific", allowed_fields: ["method"], reason: "只接收该次引用的方法来源" },
      destinations: mode === "reference_only" ? [{ item_key: "thickness", target_field: "method" }] : [], reason: "分别保留每处引用身份，方法由同一个真实项目接收。" });
  }
  const methodIds = mode === "reference_only" ? [ids[1]!, ids[3]!, ids[2]!, ids[4]!] : [ids[3]!, ids[4]!];
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const, span_ids, separator: "", reason: "逐字来源" });
  plan.lots.push({ key: "lot", name: "涂层检验", scope_span_ids: [ids[0]!], reason: "固定测试范围" });
  if (mode === "reference_placeholder") plan.source_dispositions.push({ span_ids: [ids[1]!, ids[2]!], disposition: "context", reason: "引用入口以非计数占位保留，不新增项目" });
  plan.items.push({ key: "thickness", lot_key: "lot", name: "涂层厚度", category: "一般项目", criterion_span_ids: [ids[0]!], continuation_span_ids: [ids[3]!, ids[4]!],
    fields: { name: { ...field([ids[0]!]), composition: "semantic_summary" }, requirement: field([ids[0]!]), method: { ...field(methodIds), composition: "reference" }, quantity: field([]), note: field([]) },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "固定测试分类", inspection_data_type_span_ids: [ids[0]!],
    sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "本合成例无抽样要求", confidence: 1 }, reason: "一个真实验收项目" });
  return { manifest, registry, plan, texts, ids };
}

function methodProofEvidenceIds(compiled: ReturnType<typeof compileTargetSelectors>, manifest: EvidenceManifest) {
  const hydrated = hydrateSemanticSourcePlan(compiled, manifest);
  return hydrated.semantic_references!.filter(r => r.destination_bindings.some(d => d.fields.includes("method")))
    .map(r => r.target_semantic_ids.map(id => hydrated.semantic_evidence!.find(node => node.semantic_id === id)!.evidence_id));
}

test.each([false, true])("finite repair exposes a saved reference field whose local source has no compiled receiver (residual=%s)", async residual => {
  const f = fixture("reference_only");
  const source = { evidence_id: "e:local-method", kind: "paragraph" as const, role: "supporting_clause" as const,
    locator: "line:6", text: "采用成膜测厚仪进行本地复核。", text_sha256: sha256Text("采用成膜测厚仪进行本地复核。"),
    requires_disposition: true, evidence_scope: "primary" as const };
  f.manifest.evidence.push(source);
  const added = registryWithFullSourceSpans(f.manifest.evidence_fingerprint,
    [{ source_id: source.evidence_id, evidence_id: source.evidence_id, atom_id: source.evidence_id, text: source.text }]).spans[0]!;
  f.registry.spans.push(added);
  f.plan.items[0]!.fields.method.span_ids.push(added.span_id);
  if (residual) f.plan.residual_source_dispositions = [{ key: "residual", disposition: "context", reason: "合成背景，不能替代已保存字段的来源归属。" }];
  expect(selectorDispositionCoverage({ selectors: f.plan, evidence: f.manifest.evidence, spans: f.registry.spans }).uncovered_required_ids).toEqual([]);
  expect(compiledUnhandledEvidenceIds(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest.evidence)).toContain(source.evidence_id);
  expect(requiredReferenceFieldOnlyEvidenceIds(f.plan, f.manifest, f.registry)).toEqual([source.evidence_id]);
  const root = await mkdtemp(join(tmpdir(), "reference-field-source-recovery-"));
  try {
    const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
      { manifest: f.manifest, markdown: Buffer.from([...f.texts, source.text].join("\n")) });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
    await workspace.writeWorkingSelectors(prettyJson(f.plan));
    await workspace.updateState(state => {
      state.selector_stage = "table";
      state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 3, best_issue_count: 1, consecutive_non_improvements: 3 };
    });
    const controller = await ToolController.create(workspace);
    for (const evidence of f.manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: evidence.evidence_id });
    const fullCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
    const protectedPaths = [workspace.statePath, workspace.workingSelectorPath, workspace.sourceSpanRegistryPath, workspace.evidenceManifestPath];
    const before = await Promise.all(protectedPaths.map(p => readFile(p, "utf8")));
    const finite = await (controller as any).targetContext({ source_repair_cursor: 0 }) as any;
    expect(finite.current_source_repair).toMatchObject({ actual: { issue_count: 1 }, full_stage_check_performed: false, budget_consumed: false });
    const issue = finite.current_source_repair.selector_issues[0];
    expect(issue).toMatchObject({ code: "compiler_unhandled_evidence", next_tool: "read_target_selectors",
      next_tool_arguments: { collection: "items", key: "thickness" },
      actual: { evidence_ids: [source.evidence_id], author_field_bindings: [{ item_key: "thickness", field: "method",
        composition: "reference", span_id: added.span_id, path: "/items/0/fields/method/span_ids/4", item_basis_contains_source: false }] } });
    expect(issue.details.saved_field_binding_instruction).toContain("重复保存相同 span");
    expect(issue.how_to_pass).toContain("不是要求再猜接收项");
    expect(await Promise.all(protectedPaths.map(p => readFile(p, "utf8")))).toEqual(before);
    expect(fullCheck).not.toHaveBeenCalled();
    expect(await controller.dispatch(issue.next_tool, issue.next_tool_arguments)).toMatchObject({ ok: true });
    const sameSave = await controller.dispatch("stage_target_selector_draft", { draft: { items: [f.plan.items[0]!] } }) as any;
    expect(sameSave).toMatchObject({ ok: true, reference_locator_source_repair: {
      validation_scope: "required_reference_field_and_locator_sources", full_stage_check_performed: false, budget_consumed: false,
      actual: { evidence_count: 1 } } });
    expect((await workspace.readState()).selector_protocol!.stage_retries!.consecutive_non_improvements).toBe(3);
    // The synthetic author chooses actual item ownership; the harness never edits it.
    f.plan.items[0]!.continuation_span_ids.push(added.span_id);
    expect(compiledUnhandledEvidenceIds(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest.evidence)).not.toContain(source.evidence_id);
    expect(requiredReferenceFieldOnlyEvidenceIds(f.plan, f.manifest, f.registry)).toEqual([]);
    const saved = await controller.dispatch("stage_target_selector_draft", { draft: { items: [f.plan.items[0]!] } }) as any;
    expect(saved).toMatchObject({ ok: true });
    expect(saved.reference_locator_source_repair).toBeUndefined();
    expect((await controller.dispatch("get_target_context", { source_repair_cursor: 0 }) as any).current_source_repair).toBeNull();
    expect((await workspace.readState()).selector_protocol!.stage_retries!.consecutive_non_improvements).toBe(3);
    expect(fullCheck).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference field source accounting accepts actual route targets and local origins without requiring duplicate item basis", () => {
  const f = fixture("reference_only");
  f.plan.items[0]!.continuation_span_ids = [];
  const before = prettyJson(f.plan);
  expect(compiledUnhandledEvidenceIds(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest.evidence)).toEqual([]);
  expect(requiredReferenceFieldOnlyEvidenceIds(f.plan, f.manifest, f.registry)).toEqual([]);
  expect(prettyJson(f.plan)).toBe(before);
});

test.each([false,true])('recovery diagnoses a required source retained only as a reference locator (residual=%s)', async residual => {
  const f = fixture('reference_only');
  const originalItem = structuredClone(f.plan.items[0]!);
  const originSpans = new Set(f.registry.spans.filter(span=>span.evidence_id==='e:1').map(span=>span.span_id));
  const item = f.plan.items[0]!;
  item.criterion_span_ids = item.criterion_span_ids.filter(id=>!originSpans.has(id));
  item.continuation_span_ids = item.continuation_span_ids.filter(id=>!originSpans.has(id));
  for(const field of Object.values(item.fields))field.span_ids=field.span_ids.filter(id=>!originSpans.has(id));
  if(residual)f.plan.residual_source_dispositions=[{key:'neutral-residual',disposition:'context',reason:'合成剩余来源说明，不代替既有引用定位'}];
  expect(selectorDispositionCoverage({selectors:f.plan,evidence:f.manifest.evidence,spans:f.registry.spans}).uncovered_required_ids).toEqual([]);
  const compiled = compileTargetSelectors(f.plan,f.registry,f.manifest);
  expect(compiledUnhandledEvidenceIds(compiled,f.manifest.evidence)).toContain('e:1');
  expect(requiredReferenceAnchorOnlyEvidenceIds(f.plan,f.manifest,f.registry)).toEqual(['e:1']);
  const root=await mkdtemp(join(tmpdir(),'reference-anchor-only-recovery-'));
  try {
    const workspace=await RevisionWorkspace.createFromEvidence(root,f.manifest.job_id,f.manifest.target_id,{manifest:f.manifest,markdown:Buffer.from(f.texts.join('\n'))});
    await writeFile(workspace.sourceSpanRegistryPath,prettyJson(f.registry));
    await workspace.writeWorkingSelectors(prettyJson(f.plan));
    await writeFile(join(workspace.root,'modeling-handoff.json'),JSON.stringify({job_id:workspace.jobId,target_id:workspace.targetId,revision:workspace.revision}));
    await workspace.updateState(state=>{state.selector_stage='table';state.selector_protocol!.stage_retries={stage:'table',best_stage_rank:3,best_issue_count:4,consecutive_non_improvements:3};});
    const controller=await ToolController.create(workspace);
    for(const evidence of f.manifest.evidence)await controller.dispatch('open_evidence',{evidence_id:evidence.evidence_id});
    const before=await workspace.readState(),selectorBytes=await readFile(workspace.workingSelectorPath,'utf8');
    const context=await controller.dispatch('get_target_context',{source_repair_cursor:0}) as any;
    expect(context.current_source_repair).toMatchObject({budget_consumed:false,full_stage_check_performed:false,
      selector_issues:[{code:'compiler_unhandled_evidence',actual:{evidence_ids:['e:1']}}]});
    const issue=context.current_source_repair.selector_issues[0];
    expect(await controller.dispatch(issue.next_tool,issue.next_tool_arguments)).toMatchObject({ok:true});
    expect(await readFile(workspace.workingSelectorPath,'utf8')).toBe(selectorBytes);
    expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
    const refOnlySave=await controller.dispatch('stage_target_selector_draft',{draft:{references:[f.plan.references[0]!]}}) as any;
    expect(refOnlySave).toMatchObject({ok:true,draft_status:'saved_local_validation_passed',
      reference_locator_source_repair:{validation_scope:'required_reference_locator_sources',full_stage_check_performed:false,budget_consumed:false,
        actual:{evidence_count:1},selector_issues:[{code:'compiler_unhandled_evidence',actual:{evidence_ids:['e:1']}}]}});
    const saveIssue=refOnlySave.reference_locator_source_repair.selector_issues[0];
    expect(await controller.dispatch(saveIssue.next_tool,saveIssue.next_tool_arguments)).toMatchObject({ok:true});
    expect(refOnlySave.instruction).toContain('当前唯一下一步入口');
    expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
    const repairedSave=await controller.dispatch('stage_target_selector_draft',{draft:{items:[originalItem]}}) as any;
    expect(repairedSave).toMatchObject({ok:true});
    expect(repairedSave.reference_locator_source_repair).toBeUndefined();
    expect((await controller.dispatch('get_target_context',{source_repair_cursor:0}) as any).current_source_repair).toBeNull();
    expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
  } finally {await rm(root,{recursive:true,force:true});}
});

function contextualMentionFixture() {
  const f = fixture("reference_only");
  f.plan.items[0]!.fields.method.span_ids = [f.ids[1]!, f.ids[3]!];
  f.plan.items[0]!.continuation_span_ids = [f.ids[3]!];
  f.plan.source_dispositions.push({ span_ids: [f.ids[2]!], disposition: "context", reason: "本次调查确认此来源只作背景说明，没有进入当前验收内容。" });
  f.plan.references[1]!.action = "mention";
  f.plan.references[1]!.destinations = [];
  f.plan.references[1]!.reason = "保留已经解析的背景引用身份与目标来源，不向验收字段导入。";
  return f;
}

function sharedSamplingFixture() {
  const f = fixture("reference_placeholder", ["用湿膜测厚规测量。", "每批抽查两件。"]);
  f.manifest.reference_occurrences[1]!.target_evidence_ids = ["e:3", "e:4"];
  f.plan.references[1]!.target_span_ids = [f.ids[3]!, f.ids[4]!];
  const item = f.plan.items[0]!;
  item.continuation_span_ids = [f.ids[3]!];
  item.fields.method.span_ids = [f.ids[3]!];
  item.fields.quantity = { composition: "reference", span_ids: [f.ids[4]!], separator: "", reason: "由选中共享规则接收数量来源" };
  item.sampling = { ...item.sampling, status: "reference", rule_key: "shared", branch_keys: ["selected"] };
  const roles = ["applicability", "branch_condition", "method", "quantity", "acceptance_criterion", "exception", "note"] as const;
  f.plan.sampling_rules.push({ key: "shared", complete_span_ids: [f.ids[4]!], components: roles.map(role => ({ key: role, role,
    disposition: role === "quantity" ? "present" : "absent", span_ids: role === "quantity" ? [f.ids[4]!] : [], reason: "测试显式组件" })),
    branches: [{ key: "selected", applies_to_category: "all_items", components: [], reason: "选中分支" },
      { key: "other", applies_to_category: "all_items", components: [], reason: "未选分支" }], reason: "独立保存共享抽样来源" });
  return f;
}

function typedTableFixture() {
  const f = fixture("reference_placeholder", ["用湿膜测厚规测量。", "涂层复测 | 应符合设计 | 测厚规测量", "另一属性 | 另一要求 | 另一方法"], true);
  Object.assign(f.manifest.evidence[4]!, { kind: "table_row", table_id: "T", table_row_kind: "data", row_index: 1, registered_dependency: true });
  Object.assign(f.manifest.evidence[5]!, { kind: "table_row", table_id: "T", table_row_kind: "data", row_index: 2, registered_dependency: true });
  Object.assign(f.manifest.reference_occurrences[1]!, { reference_kind: "table", target_table_id: "T",
    target_address: { source_id: "source", locator_kind: "table", locator: "table:T" } });
  const item = f.plan.items[0]!;
  item.continuation_span_ids = [f.ids[3]!];
  item.table = { source_kind: "reference", table_key: "T", reference_span_ids: [...f.plan.references[1]!.anchor_span_ids], reason: "逐格绑定表内实际来源",
    properties: { table_no_span_ids: [], table_title_span_ids: [], applicability_span_ids: [], row_path_span_ids: [[f.ids[4]!]], column_path_span_ids: [],
      unit_span_ids: [], condition_span_ids: [f.ids[4]!], allowed_value_span_ids: [f.ids[4]!], inspection_method_span_ids: [f.ids[4]!] } };
  return f;
}

describe("multi-source reference field", () => {
  test.each([false, true])("an unresolved mention receives missing-target and local-origin guidance, required=%s", required => {
    const f = contextualMentionFixture();
    const occurrence = f.manifest.reference_occurrences[1]!;
    occurrence.status = "target_not_found";
    occurrence.target_evidence_ids = [];
    occurrence.required = required;
    f.plan.references[1]!.target_span_ids = [];
    const before = JSON.stringify({ plan: f.plan, registry: f.registry, manifest: f.manifest });
    let issues: any[] = [];
    try { compileTargetSelectors(f.plan, f.registry, f.manifest); }
    catch (error) { expect(error).toBeInstanceOf(TargetSelectorCompileError); issues = (error as TargetSelectorCompileError).issues; }
    const target = issues.find(issue => issue.code === "selector_reference_target_required");
    expect(target).toMatchObject({ path: "/references/1/target_span_ids", details: {
      actual: { status: "target_not_found", required, action: "mention", target_span_ids: [], target_evidence_ids: [] },
      allowed_unresolved_values: { action: "keep_reference", application_mode: "reference_only", target_span_ids: [] },
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "ref1" },
      save_tool: "stage_target_selector_draft",
    } });
    expect(actionableSelectorIssue(classifySelectorIssue("selector-local", target))).toMatchObject({
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "ref1" },
      save_tool: "stage_target_selector_draft",
    });
    expect(target.details.how_to_pass).toContain("已有 target_not_found 不需重复解析");
    expect(target.details.candidate_read_tools).not.toContain("resolve_document_reference");
    const receiver = issues.find(issue => issue.code === "selector_reference_destination_required");
    expect(receiver).toMatchObject({ details: {
      actual: { status: "target_not_found", required, action: "mention", target_span_count: 0 },
      expected: { action: "keep_reference", target_span_ids: [], destination_count: "at_least_one_real_local_origin_field" },
      next_tool_arguments: { collection: "references", key: "ref1" },
    } });
    expect(receiver.details).not.toHaveProperty("expected_context_receipt");
    expect(receiver.details).not.toHaveProperty("context_reference_alternative");
    expect(receiver.details.how_to_pass).toContain("不要读取不存在的目标");
    expect(receiver.details.how_to_pass).not.toContain("再保存 mention/reference_only");
    expect(JSON.stringify({ plan: f.plan, registry: f.registry, manifest: f.manifest })).toBe(before);
  });

  test.each([false, true])("missing unresolved receipt has a truthful route while required=%s remains immutable", async required => {
    const f = fixture("reference_only");
    const occurrence = f.manifest.reference_occurrences[1]!;
    occurrence.status = "target_not_found";
    occurrence.target_evidence_ids = [];
    occurrence.required = required;
    f.plan.references.pop();
    const issue = registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry).find(row => row.code === "selector_registered_reference_receipt_missing")!;
    expect(issue.details).toMatchObject({ actual: { status: "target_not_found", required, target_evidence_ids: [] },
      allowed_unresolved_values: { action: "keep_reference", application_mode: "reference_only", target_span_ids: [] },
      next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 1, limit: 1 } });
    const guidance = (issue.details as any).how_to_pass;
    expect(guidance).toContain("target_not_found");
    expect(guidance).toContain("不会把未解析目标变成通过");
    expect(guidance).not.toContain("读组件");
    expect(occurrence.required).toBe(required);
    expect(occurrence.status).toBe("target_not_found");
    const root = await mkdtemp(join(tmpdir(), "missing-reference-receipt-navigation-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
        { manifest: f.manifest, markdown: Buffer.from(f.texts.join("\n")) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
      await workspace.writeWorkingSelectors(prettyJson(f.plan));
      const controller = await ToolController.create(workspace);
      const protectedPaths = [workspace.evidenceManifestPath, workspace.workingSelectorPath];
      const before = await Promise.all(protectedPaths.map(path => readFile(path, "utf8")));
      const navigation = issue.details as { next_tool: string; next_tool_arguments: Record<string, unknown> };
      const listed = await controller.dispatch(navigation.next_tool, navigation.next_tool_arguments) as any;
      expect(listed).toMatchObject({ ok: true });
      expect(listed.occurrences).toEqual([expect.objectContaining({
        occurrence_id: "reference:1", status: "target_not_found", required, target_evidence_count: 0,
      })]);
      expect(await Promise.all(protectedPaths.map(path => readFile(path, "utf8")))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each([false, true])("unresolved receiver feedback preserves the local origin independently of missing target content, required=%s", required => {
    const f = fixture("reference_only");
    const occurrence = f.manifest.reference_occurrences[1]!;
    occurrence.status = "target_not_found";
    occurrence.target_evidence_ids = [];
    occurrence.required = required;
    const reference = f.plan.references[1]!;
    reference.target_span_ids = [];
    reference.destinations = [];
    reference.origin_binding = { item_key: "thickness", target_field: "method" };
    const [limited] = unresolvedReferenceDestinationIssues(f.plan, f.manifest, f.registry);
    expect(limited).toMatchObject({ code: "selector_reference_destination_required", details: {
      actual: { status: "target_not_found", required, target_span_count: 0, destination_count: 0,
        origin_binding: reference.origin_binding, origin_fields: ["method"] },
      expected: { destination_count: "at_least_one_real_local_origin_field", target_span_ids: [] },
      writable_collections: ["references", "items"], next_tool_arguments: { collection: "references", key: "ref1" },
    } });
    let compiledIssue: any;
    try { compileTargetSelectors(f.plan, f.registry, f.manifest); }
    catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      compiledIssue = (error as TargetSelectorCompileError).issues.find(issue => issue.code === limited.code);
    }
    expect(compiledIssue.details.how_to_pass).toBe((limited.details as any).how_to_pass);
    expect(compiledIssue.details.actual).toEqual((limited.details as any).actual);
    expect(compiledIssue.details.how_to_pass).toContain("origin_binding 不是接收回执");
    expect(compiledIssue.details.how_to_pass).toContain("不要读取不存在的目标");
    expect(compiledIssue.details).not.toHaveProperty("placeholder_values");
    reference.destinations = [{ item_key: "thickness", target_field: "method" }];
    expect(unresolvedReferenceDestinationIssues(f.plan, f.manifest, f.registry)).toEqual([]);
    expect(occurrence.required).toBe(required);
    expect(occurrence.status).toBe("target_not_found");
  });

  test("overwriting an existing registered reference cannot silently drop its occurrence identity", async () => {
    const f = fixture("reference_only");
    const root = await mkdtemp(join(tmpdir(), "reference-identity-preservation-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
        { manifest: f.manifest, markdown: Buffer.from(f.texts.join("\n")) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
      await workspace.writeWorkingSelectors(prettyJson(f.plan));
      await workspace.updateState(state => { state.selector_stage = "table"; });
      const controller = await ToolController.create(workspace);
      for (const record of f.manifest.evidence) await controller.dispatch("open_evidence", { evidence_id: record.evidence_id });
      const selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const registryBefore = await readFile(workspace.sourceSpanRegistryPath, "utf8");
      const protocolBefore = (await workspace.readState()).selector_protocol;
      const incomplete = structuredClone(f.plan.references[0]!);
      delete incomplete.occurrence_id;
      const rejected = await controller.dispatch("stage_target_selector_draft", {
        quote_bindings: [{ key: "$neutral_unused", evidence_id: "e:0", quote: "涂层厚度" }],
        draft: { references: [incomplete] },
      }) as any;
      expect(rejected).toMatchObject({ ok: false, error: "selector_existing_reference_occurrence_id_required",
        durable_mutation: false, budget_consumed: false, terminal: false,
        selector_issues: [{ actual: { reference_key: "ref0", submitted_occurrence_id: null, saved_occurrence_id: "reference:0" },
          writable_path: "/draft/references/0/occurrence_id" }],
        next_tool_arguments: { collection: "references", key: "ref0" } });
      expect(await controller.dispatch(rejected.next_tool, rejected.next_tool_arguments)).toMatchObject({ ok: true, rows: [{ occurrence_id: "reference:0" }] });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
      expect(await readFile(workspace.sourceSpanRegistryPath, "utf8")).toBe(registryBefore);
      expect((await workspace.readState()).selector_protocol).toEqual(protocolBefore);
      expect(await controller.dispatch("stage_target_selector_draft", { draft: { references: [f.plan.references[0]] } })).toMatchObject({ ok: true });

      // A historical damaged record is a read candidate, not a new business answer.
      f.plan.references[0] = incomplete;
      const missing = registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry)
        .find(issue => issue.code === "selector_registered_reference_receipt_missing")!;
      expect(missing.details).toMatchObject({ actual: { exact_anchor_author_records: [{ key: "ref0", current_occurrence_id: null }] },
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "ref0" } });
      expect((missing.details as any).how_to_pass).toContain("尚不证明业务路由正确");
      expect((missing.details as any).required_action).toContain("不默认新增重复 reference");
      expect((missing.details as any).save_tool_instruction).toContain("完整原 key 记录");
      expect((missing.details as any).how_to_pass).not.toContain("再增 draft.references");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains a resolved contextual mention without inventing a receiving acceptance item", () => {
    const f = contextualMentionFixture();
    f.manifest.reference_occurrences[1]!.target_evidence_ids.push("e:3");
    const before = JSON.stringify({ plan: f.plan, manifest: f.manifest });
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(validatePlanText(JSON.stringify(compiled), f.manifest).issues).toEqual([]);
    expect(compiled.reference_resolutions).toHaveLength(2);
    expect(compiled.reference_resolutions[1]).toMatchObject({ action: "mention", application_mode: "reference_only", destination_bindings: [] });
    expect(f.manifest.reference_occurrences[1]!.required).toBe(true);
    const result = materialize(compiled, f.manifest, "context-mention").result;
    expect(result.inspection_lots[0]!.items).toHaveLength(1);
    expect(result.inspection_lots[0]!.items[0]!.method).not.toContain(f.texts[4]);
    expect(JSON.stringify({ plan: f.plan, manifest: f.manifest })).toBe(before);
  });

  test("external content dependencies retain component obligations for context-shaped author records", () => {
    const f = contextualMentionFixture();
    f.manifest.reference_occurrences[1]!.external_standard = { standard_no: "XQ 902-2001", status: "resolved", usage: "content_required", markdown_sha256: sha256Text(f.texts[4]!) };
    const before = JSON.stringify({ plan: f.plan, manifest: f.manifest });
    try { compileTargetSelectors(f.plan, f.registry, f.manifest); throw new Error("expected external content guard"); }
    catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_resolved_reference_components_unaccounted", path: "/references/1/component_dispositions",
      }));
    }
    expect(JSON.stringify({ plan: f.plan, manifest: f.manifest })).toBe(before);
  });

  test.each(["item", "lot", "sampling", "other-reference", "partial", "ignored", "residual", "adopt"] as const)("%s cannot bypass a real reference receiver through a contextual mention", kind => {
    const f = contextualMentionFixture();
    if (kind === "item") f.plan.items[0]!.continuation_span_ids.push(f.ids[2]!);
    if (kind === "lot") f.plan.lots[0]!.scope_span_ids.push(f.ids[2]!);
    if (kind === "sampling") f.plan.items[0]!.sampling.condition_span_ids.push(f.ids[2]!);
    if (kind === "other-reference") f.plan.references[0]!.target_span_ids = [f.ids[2]!];
    if (kind === "partial") f.plan.source_dispositions[0]!.span_ids = f.plan.references[1]!.anchor_span_ids;
    if (kind === "ignored") f.plan.source_dispositions[0]!.disposition = "ignored";
    if (kind === "residual") {
      f.plan.source_dispositions = [];
      f.plan.residual_source_dispositions = [{ key: "residual", disposition: "context", reason: "未逐条审查的背景兜底" }];
    }
    if (kind === "adopt") f.plan.references[1]!.action = "adopt";
    try { compileTargetSelectors(f.plan, f.registry, f.manifest); throw new Error("expected reference receiver guard"); }
    catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({ code: "selector_reference_destination_required", path: "/references/1/destinations" }));
      if (kind === "item") {
        const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_destination_required")!;
        expect(issue.details).toMatchObject({ actual: { business_origin_bindings: [{ collection: "items", key: "thickness", evidence_id: "e:2", path: "/items/0/continuation_span_ids/1" }] },
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "thickness" } });
      }
    }
  });

  test("strict validation rechecks a context receipt after an item starts using its origin", () => {
    const f = contextualMentionFixture();
    const compiled = hydrateSemanticSourcePlan(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest);
    compiled.acceptance_items[0]!.evidence_ids.push("e:2");
    expect(validatePlanText(JSON.stringify(compiled), f.manifest).issues).toContainEqual(expect.objectContaining({ code: "reference_destination_required" }));
  });

  test.each([false, true])("empty receiver feedback exposes the existing context route without approving business-conflicting origins=%s", businessOrigin => {
    const f = contextualMentionFixture();
    const reference = f.plan.references[1]!;
    reference.action = "conditional";
    if (businessOrigin) f.plan.items[0]!.continuation_span_ids.push(f.ids[2]!);
    const before = JSON.stringify(f.plan), manifestBefore = JSON.stringify(f.manifest);
    let issue: any;
    try { compileTargetSelectors(f.plan, f.registry, f.manifest); throw new Error("expected existing receiver guard"); }
    catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_reference_destination_required");
    }
    expect(issue.details).toMatchObject({ context_reference_alternative: {
      actual: { origin_evidence_ids: ["e:2"], incomplete_context_evidence_ids: [], context_receipt_available: !businessOrigin },
      expected: { action: "mention", application_mode: "reference_only", business_origin_bindings: [], destinations: [], origin_binding: "omit" },
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: reference.key },
      source_read_tool_arguments: { collection: "source_dispositions", evidence_ids: ["e:2"] }, save_tool: "stage_target_selector_draft",
    }, writable_collections: expect.arrayContaining(["references", "source_dispositions"]) });
    expect(issue.details.allowed_actions.join(" ")).toContain("无 destinations 或被引内容不适用本身不证明来源属于背景");
    expect(JSON.stringify(f.plan)).toBe(before);
    expect(JSON.stringify(f.manifest)).toBe(manifestBefore);
    reference.action = "mention";
    if (businessOrigin) {
      expect(issue.details.context_reference_alternative.actual.business_origin_bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ collection: "items", key: "thickness", evidence_id: "e:2" }),
      ]));
      expect(() => compileTargetSelectors(f.plan, f.registry, f.manifest)).toThrow(TargetSelectorCompileError);
    } else {
      const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
      expect(validatePlanText(JSON.stringify(compiled), f.manifest).issues).toEqual([]);
    }
  });

  test("missing contextual receipt feedback offers an executable provenance path without deleting the occurrence", () => {
    const f = contextualMentionFixture();
    f.plan.references.pop();
    const issue = registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry).find(row => row.code === "selector_registered_reference_receipt_missing")!;
    expect(issue.details).toMatchObject({ actual: { context_receipt_available: true, origin_evidence_ids: ["e:2"] },
      context_receipt_values: { action: "mention", application_mode: "reference_only", destinations: [], origin_binding: "omit" } });
    expect((issue.details as any).how_to_pass).toContain("不得删除已登记 occurrence");
  });

  test("recovered empty receiver gets current context alternatives without rerunning the stage or clearing inherited budgets", async () => {
    const f = contextualMentionFixture();
    const reference = f.plan.references[1]!; reference.action = "conditional";
    const root = await mkdtemp(join(tmpdir(), "current-reference-repair-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
        { manifest: f.manifest, markdown: Buffer.from(f.texts.join("\n")) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
      await workspace.writeWorkingSelectors(prettyJson(f.plan));
      await workspace.updateState(state => {
        state.selector_stage = "table";
        state.lineage = { schema_version: "revision-lineage/v1", source_revision: 1, selector_checkpoint_revision: 1, registry_checkpoint_revision: 1, recovery_kind: "terminal_checkpoint" };
        state.selector_protocol.stage_retries = { stage: "table", best_stage_rank: 3, best_issue_count: 2, consecutive_non_improvements: 3 };
      });
      const controller = await ToolController.create(workspace);
      const fullCheck = vi.spyOn(controller as any, "validateSelectorStageCompleteness");
      const before = await workspace.readState(), selectorBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const receipt = await controller.dispatch("get_target_context", { source_repair_cursor: 0 }) as any;
      expect(receipt.current_source_repair).toMatchObject({ budget_consumed: false, full_stage_check_performed: false,
        actual: { issue_count: 1 }, selector_issues: [{ code: "selector_reference_destination_required", details: {
          context_reference_alternative: { actual: { context_receipt_available: true }, expected: { action: "mention", business_origin_bindings: [] } },
        }, next_tool_arguments: { collection: "references", key: reference.key } }] });
      expect(fullCheck).not.toHaveBeenCalled();
      expect((await workspace.readState()).selector_protocol.stage_retries).toEqual(before.selector_protocol.stage_retries);
      expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("existing reference_only routes two occurrences to one field without changing its content", () => {
    const f = fixture("reference_only");
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const validated = validatePlanText(JSON.stringify(compiled), f.manifest);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    expect(hydrated.acceptance_items[0]!.method).toBe([f.texts[1], f.texts[3], f.texts[2], f.texts[4]].join(""));
    expect(compiled.reference_resolutions).toHaveLength(2);
    const result = materialize(hydrated, f.manifest, "test").result;
    expect(result.inspection_lots[0]!.items).toHaveLength(1);
  });

  test("origin relation feedback distinguishes missing provenance from missing visible context", () => {
    const f = fixture("reference_only");
    const plan = hydrateSemanticSourcePlan(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest);
    const missingProvenance = structuredClone(plan);
    missingProvenance.acceptance_items[0]!.evidence_ids = plan.acceptance_items[0]!.evidence_ids.filter(id => id !== "e:1");
    expect(validatePlanText(JSON.stringify(missingProvenance), f.manifest).issues).toContainEqual(expect.objectContaining({
      code: "reference_origin_relation", details: expect.objectContaining({
        actual: expect.objectContaining({ origin_provenance_present: false, missing_origin_evidence_ids: ["e:1"], origin_context_retained: true }),
        expected: { origin_provenance_present: true, origin_context_retained: true },
      }),
    }));
    const missingContext = structuredClone(plan);
    missingContext.acceptance_items[0]!.field_bindings.method.source_fragments = plan.acceptance_items[0]!.field_bindings.method.source_fragments.filter(fragment => fragment.evidence_id !== "e:1");
    expect(validatePlanText(JSON.stringify(missingContext), f.manifest).issues).toContainEqual(expect.objectContaining({
      code: "reference_origin_relation", details: expect.objectContaining({
        actual: expect.objectContaining({ origin_provenance_present: true, missing_origin_evidence_ids: [], origin_field_fragment_count: 0, origin_context_retained: false }),
      }),
    }));
  });

  test.each(["requirement", "note"] as const)("origin context checks the visible-field union when retained in %s while occurrence metadata says method", field => {
    const f = fixture("reference_only");
    const plan = hydrateSemanticSourcePlan(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest);
    const item = plan.acceptance_items[0]!;
    const origin = item.field_bindings.method.source_fragments.filter(fragment => fragment.evidence_id === "e:1");
    item.field_bindings.method.source_fragments = item.field_bindings.method.source_fragments.filter(fragment => fragment.evidence_id !== "e:1");
    item.field_bindings[field].source_fragments.push(...origin);
    const relations = validatePlanText(JSON.stringify(plan), f.manifest).issues.filter(issue => issue.code === "reference_origin_relation");
    expect(relations).toEqual([]);
    item.evidence_ids = item.evidence_ids.filter(id => id !== "e:1");
    expect(validatePlanText(JSON.stringify(plan), f.manifest).issues).toContainEqual(expect.objectContaining({
      code: "reference_origin_relation", details: expect.objectContaining({ actual: expect.objectContaining({
        origin_context_field_scope: "union_of_visible_fields", occurrence_origin_fields: ["method"],
        origin_context_fields_present: [field], origin_context_retained: true, origin_provenance_present: false,
      }) }),
    }));
    expect(f.manifest.reference_occurrences[0]!.origin_fields).toEqual(["method"]);
  });

  test.each([
    "涂层厚度应符合本规范第2.1条的规定。",
    "一般项目 | 2 | 涂层厚度 | 应符合本规范第2.1条的规定 | / |",
  ])("same-origin subject and pure forwarding criterion may occupy different visible fields: %s", originText => {
    const f = fixture("reference_only", undefined, false, originText);
    if (originText.includes(" | ")) {
      f.manifest.evidence[1] = { ...f.manifest.evidence[1]!, kind: "table_row", cells: originText.split(" | ") };
    }
    const source = { source_id: "e:1", evidence_id: "e:1", atom_id: "e:1", text: originText };
    const subject = locateAndRegisterSourceQuote(f.registry, source, "涂层厚度");
    const pointer = locateAndRegisterSourceQuote(subject.registry, source, "应符合本规范第2.1条的规定");
    f.registry = pointer.registry;
    const item = f.plan.items[0]!;
    item.fields.name.span_ids = [subject.spans[0]!.span_id];
    item.fields.method.span_ids = [pointer.spans[0]!.span_id, f.ids[3]!, f.ids[2]!, f.ids[4]!];
    const before = prettyJson(f.plan);
    const manifestBefore = prettyJson(f.manifest);
    const plan = hydrateSemanticSourcePlan(compileTargetSelectors(f.plan, f.registry, f.manifest), f.manifest);
    const relations = (candidate: typeof plan) => validatePlanText(prettyJson(candidate), f.manifest).issues
      .filter(issue => issue.code === "reference_origin_relation");
    expect(relations(plan)).toEqual([]);
    expect(prettyJson(f.plan)).toBe(before);
    expect(prettyJson(f.manifest)).toBe(manifestBefore);

    // Another evidence's subject cannot provide this occurrence's local context.
    const unrelatedSubject = structuredClone(plan);
    unrelatedSubject.acceptance_items[0]!.field_bindings.name.source_fragments = [{ evidence_id: "e:0", text: f.texts[0]! }];
    expect(relations(unrelatedSubject)).toContainEqual(expect.objectContaining({ details: expect.objectContaining({
      actual: expect.objectContaining({ origin_provenance_present: true, origin_context_retained: false }),
    }) }));
    // Keeping a subject alone does not retain this occurrence's literal.
    const missingLiteral = structuredClone(plan);
    missingLiteral.acceptance_items[0]!.field_bindings.method.source_fragments =
      missingLiteral.acceptance_items[0]!.field_bindings.method.source_fragments.filter(fragment => fragment.evidence_id !== "e:1");
    expect(relations(missingLiteral)).toHaveLength(1);
    // Local display and evidence ownership remain independent requirements.
    const missingProvenance = structuredClone(plan);
    missingProvenance.acceptance_items[0]!.evidence_ids = missingProvenance.acceptance_items[0]!.evidence_ids.filter(id => id !== "e:1");
    expect(relations(missingProvenance)).toContainEqual(expect.objectContaining({ details: expect.objectContaining({
      actual: expect.objectContaining({ origin_provenance_present: false, origin_context_retained: true }),
    }) }));
  });

  test("two non-counting placeholders can supply distinct method fragments of one real item", () => {
    const f = fixture("reference_placeholder");
    const before = structuredClone(f.plan);
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const validation = validatePlanText(JSON.stringify(compiled), f.manifest);
    expect(validation, JSON.stringify(validation.issues)).toMatchObject({ ok: true, issues: [] });
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    expect(hydrated.acceptance_items[0]!.method).toBe(f.texts[3]! + f.texts[4]!);
    expect(compiled.reference_resolutions.map(r => r.destination_bindings)).toEqual([[], []]);
    const proofs = compiled.semantic_references!.filter(r => r.destination_bindings.some(d => d.fields.includes("method")));
    expect(proofs).toHaveLength(2);
    expect(methodProofEvidenceIds(compiled, f.manifest)).toEqual([["e:3"], ["e:4"]]);
    expect(proofs.map(r => hydrated.semantic_evidence!.find(node => node.semantic_id === r.anchor_semantic_id)!.evidence_id)).toEqual(["e:1", "e:2"]);
    const result = materialize(hydrated, f.manifest, "test").result;
    expect(result.inspection_lots[0]!.items).toHaveLength(1);
    expect(result.inspection_lots[0]!.items[0]).toMatchObject({ method: f.texts[3]! + f.texts[4]!, inline_references: [] });
    expect(result.reference_occurrences).toEqual(f.manifest.reference_occurrences);
    expect(f.plan).toEqual(before);
  });

  test("local origins and two target sources retain the model's order without repeating anchors", () => {
    const f = fixture("reference_placeholder");
    f.plan.items[0]!.continuation_span_ids.push(f.ids[1]!, f.ids[2]!);
    f.plan.items[0]!.fields.method.span_ids = [f.ids[2]!, f.ids[4]!, f.ids[1]!, f.ids[3]!];
    f.plan.source_dispositions = [];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(validatePlanText(prettyJson(compiled), f.manifest)).toMatchObject({ ok: true, issues: [] });
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    expect(hydrated.acceptance_items[0]!.method).toBe([f.texts[2], f.texts[4], f.texts[1], f.texts[3]].join(""));
    expect(methodProofEvidenceIds(compiled, f.manifest)).toEqual([["e:3"], ["e:4"]]);
  });

  test("overlapping registered references retain both provenances without duplicating displayed content", () => {
    const f = fixture("reference_placeholder");
    f.manifest.reference_occurrences[1]!.target_evidence_ids = ["e:3", "e:4"];
    f.plan.references[1]!.target_span_ids = [f.ids[3]!, f.ids[4]!];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(validatePlanText(prettyJson(compiled), f.manifest)).toMatchObject({ ok: true, issues: [] });
    expect(methodProofEvidenceIds(compiled, f.manifest)).toEqual([["e:3"], ["e:3", "e:4"]]);
    expect(hydrateSemanticSourcePlan(compiled, f.manifest).acceptance_items[0]!.method).toBe(f.texts[3]! + f.texts[4]!);
  });

  test("an ordinary import and a non-counting placeholder can contribute to the same field", () => {
    const f = fixture("reference_placeholder");
    f.plan.references[0]!.application_mode = "reference_only";
    f.plan.references[0]!.destinations = [{ item_key: "thickness", target_field: "method" }];
    f.plan.items[0]!.fields.method.span_ids.unshift(f.ids[1]!);
    f.plan.source_dispositions[0]!.span_ids = [f.ids[2]!];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const validation = validatePlanText(prettyJson(compiled), f.manifest);
    expect(validation, JSON.stringify(validation.issues)).toMatchObject({ ok: true, issues: [] });
    expect(hydrateSemanticSourcePlan(compiled, f.manifest).acceptance_items[0]!.method).toBe(f.texts[1]! + f.texts[3]! + f.texts[4]!);
    expect(compiled.reference_resolutions.map(r => r.destination_bindings.length)).toEqual([1, 0]);
    expect(methodProofEvidenceIds(compiled, f.manifest)).toContainEqual(["e:4"]);
  });

  test("a typed referenced-table row proves its field without duplicating the row into criterion or continuation", () => {
    const f = typedTableFixture();
    expect(registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry)).toEqual([]);
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(methodProofEvidenceIds(compiled, f.manifest)).toContainEqual(["e:4"]);
    expect(f.plan.items[0]!.criterion_span_ids).toEqual([f.ids[0]]);
    expect(f.plan.items[0]!.continuation_span_ids).toEqual([f.ids[3]]);
    expect(f.plan.references.every(reference => reference.destinations.length === 0)).toBe(true);
  });

  test("mixed ordinary and typed-table placeholder sources retain separate field proofs", () => {
    const f = typedTableFixture();
    f.plan.references[0]!.application_mode = "reference_only";
    f.plan.references[0]!.destinations = [{ item_key: "thickness", target_field: "method" }];
    f.plan.items[0]!.fields.method.span_ids.unshift(f.ids[1]!);
    f.plan.source_dispositions[0]!.span_ids = [f.ids[2]!];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(methodProofEvidenceIds(compiled, f.manifest)).toContainEqual(["e:4"]);
    expect(compiled.reference_resolutions.map(r => r.destination_bindings.length)).toEqual([1, 0]);
    const validation = validatePlanText(prettyJson(compiled), f.manifest);
    expect(validation.issues.filter(issue => issue.code.startsWith("field_binding_"))).toEqual([]);
    f.plan.items[0]!.fields.method.span_ids.push(f.ids[5]!);
    const unowned = compileTargetSelectors(f.plan, f.registry, f.manifest);
    expect(methodProofEvidenceIds(unowned, f.manifest)).toContainEqual(["e:4"]);
    expect(methodProofEvidenceIds(unowned, f.manifest).flat()).not.toContain("e:5");
    expect(validatePlanText(prettyJson(unowned), f.manifest).issues).toContainEqual(expect.objectContaining({
      code: "field_binding_relation", details: expect.objectContaining({ actual: expect.arrayContaining(["e:5"]) }),
    }));
  });

  test.each(["anchor", "header-only", "foreign-table", "no-criterion", "unowned"] as const)("%s cannot establish typed-table placeholder ownership", kind => {
    const f = typedTableFixture();
    const item = f.plan.items[0]!;
    if (kind === "anchor") item.table!.reference_span_ids = [];
    if (kind === "header-only") f.manifest.evidence[4]!.table_row_kind = "header";
    if (kind === "foreign-table") f.manifest.evidence[4]!.table_id = "Other";
    if (kind === "no-criterion") item.criterion_span_ids = [];
    if (kind === "unowned") {
      item.table!.properties.row_path_span_ids = [];
      item.table!.properties.condition_span_ids = [];
      item.table!.properties.allowed_value_span_ids = [];
      item.table!.properties.inspection_method_span_ids = [];
    }
    expect(registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry)).toContainEqual(expect.objectContaining({
      code: "selector_reference_composition_without_resolve_receipt", path: "/items/0/fields/method/composition",
    }));
    expect(() => compileTargetSelectors(f.plan, f.registry, f.manifest)).toThrow(TargetSelectorCompileError);
  });

  test.each(["unowned", "outside", "anchor", "unresolved", "wrong-target"] as const)("%s does not borrow another source's proof and returns the failing condition", kind => {
    const f = fixture("reference_placeholder");
    if (kind === "unowned") f.plan.items[0]!.continuation_span_ids = [f.ids[3]!];
    if (kind === "outside") f.plan.items[0]!.fields.method.span_ids.push(f.ids[0]!);
    if (kind === "anchor") f.plan.references[1]!.anchor_span_ids = [f.ids[2]!];
    if (kind === "unresolved") f.manifest.reference_occurrences[1]!.status = "target_not_found";
    if (kind === "wrong-target") f.manifest.reference_occurrences[1]!.target_evidence_ids = ["e:3"];
    const issue = registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry).find(i =>
      i.code === "selector_reference_composition_without_resolve_receipt" && i.path === "/items/0/fields/method/composition")!;
    expect(issue).toBeDefined();
    expect(issue.details).toMatchObject({
      next_tool: "read_target_selectors",
      candidate_read_tool: "read_target_selectors",
      candidate_read_tools: expect.arrayContaining(["list_reference_occurrences", "open_evidence", "locate_evidence_span"]),
      save_tool: "stage_target_selector_draft",
      writable_paths: expect.arrayContaining(["/items/0/continuation_span_ids", "/items/0/fields/method"]),
      required_action: "inspect_the_current_field_sources_then_choose_local_composition_or_a_proved_reference_route",
      allowed_actions: expect.arrayContaining([expect.stringContaining("本地原文"), expect.stringContaining("reference_only")]),
      how_to_pass: expect.stringContaining("不得把所有字段机械改成同一种 composition"),
    });
    if (kind === "anchor" || kind === "unresolved") {
      expect(issue.details!.reference_checks).toContainEqual(expect.objectContaining({ reference_key: "ref1",
        failed_conditions: expect.arrayContaining([kind === "anchor" ? "reference_anchor_missing" : "occurrence_not_resolved"]) }));
    } else {
      expect(issue.details!.source_checks).toContainEqual(expect.objectContaining({ span_id: kind === "outside" ? f.ids[0] : f.ids[4],
        status: kind === "unowned" ? "item_source_not_bound" : "outside_reference_targets" }));
    }
    expect(() => compileTargetSelectors(f.plan, f.registry, f.manifest)).toThrow(TargetSelectorCompileError);
  });

  test("multiple reference_only routes still require field import authorization", () => {
    const f = fixture("reference_only");
    f.plan.references[1]!.import_scope.allowed_fields = ["requirement"];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const validation = validatePlanText(prettyJson(compiled), f.manifest);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map(i => i.code).some(code => code.includes("import_scope"))).toBe(true);
  });

  test("another reference's permissions do not authorize the current overlapping reference", () => {
    const f = fixture("reference_only");
    const item = f.plan.items[0]!, other = f.plan.references[0]!, current = f.plan.references[1]!;
    f.manifest.reference_occurrences[1]!.target_evidence_ids = ["e:3"];
    current.target_span_ids = [f.ids[3]!];
    item.continuation_span_ids = [f.ids[3]!];
    item.fields.method.span_ids = [f.ids[1]!, f.ids[2]!, f.ids[3]!];
    item.fields.requirement = { ...item.fields.requirement, composition: "reference", span_ids: [f.ids[0]!, f.ids[2]!, f.ids[3]!] };
    other.import_scope.allowed_fields = ["requirement", "method"];
    current.destinations = [{ item_key: item.key, target_field: "requirement" }];
    current.origin_binding = { item_key: item.key, target_field: "method" };
    current.import_scope.allowed_fields = ["requirement"];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const before = validatePlanText(prettyJson(compiled), f.manifest);
    const scopeIssues = before.issues.filter(issue => issue.code === "reference_import_scope_exceeded");
    expect(scopeIssues).toHaveLength(1);
    expect(scopeIssues[0]!.details).toMatchObject({ allowed_fields: ["requirement"], outside_import_scope: ["method"] });
    const owned = classifyStrictSelectorIssues(f.plan, compiled, f.registry, scopeIssues, f.manifest);
    expect(owned[0]!.details!.how_to_pass).toContain("另一条引用的授权或接收路由，不会替当前引用授权");
    const destinations = structuredClone(current.destinations);
    current.import_scope.allowed_fields = ["requirement", "method"];
    const after = validatePlanText(prettyJson(compileTargetSelectors(f.plan, f.registry, f.manifest)), f.manifest);
    expect(after.issues).toEqual(before.issues.filter(issue => issue.code !== "reference_import_scope_exceeded"));
    expect(current.destinations).toEqual(destinations);
  });

  test("zero local save diagnostics do not claim that strict reference authorization was checked", async () => {
    const f = fixture("reference_only");
    f.plan.references[1]!.import_scope.allowed_fields = ["requirement"];
    const root = await mkdtemp(join(tmpdir(), "local-save-strict-scope-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
        { manifest: f.manifest, markdown: Buffer.from(f.texts.join("\n")) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
      await workspace.updateState(state => {
        state.selector_stage = "table"; state.target_review_protocol = "direct-validation/v1";
        state.selector_protocol!.stage_retries = { stage: "table", best_stage_rank: 3, best_issue_count: 1, consecutive_non_improvements: 3 };
      });
      const controller = await ToolController.create(workspace);
      await controller.dispatch("batch_open_evidence", { evidence_ids: f.manifest.evidence.map(record => record.evidence_id) });
      const ledger = await controller.dispatch("list_reference_occurrences", {}) as any;
      for (const occurrence of ledger.occurrences) await controller.dispatch("read_document_reference_evidence", { target_key: occurrence.target_key });
      const fullCheck = vi.spyOn(controller as any, "evaluateTargetSelectorPreflight");
      const before = (await workspace.readState()).selector_protocol!.stage_retries;
      const saved = await controller.dispatch("stage_target_selector_draft", { draft: {
        lots: f.plan.lots, items: f.plan.items, references: f.plan.references, source_dispositions: f.plan.source_dispositions,
      } }) as any;
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, full_stage_check_performed: false, budget_consumed: false,
        local_validation: { ok: true, issue_count: 0, deferred_nonlocal_issue_count: 0,
          checks_performed: ["selector_compilation", "field_source_roles"], strict_plan_validation_performed: false } });
      expect(saved.local_validation.count_note).toContain("不是完整严格 plan 校验的剩余问题数");
      expect(fullCheck).not.toHaveBeenCalled();
      expect((await workspace.readState()).selector_protocol!.stage_retries).toEqual(before);
      const authored = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
      const validation = validatePlanText(prettyJson(compileTargetSelectors(authored, f.registry, f.manifest)), f.manifest);
      expect(validation.issues).toContainEqual(expect.objectContaining({ code: "reference_import_scope_exceeded" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("quantity authorization does not authorize the same source in sampling or require another destination", () => {
    const f = fixture("reference_only", ["采用测厚仪检查。", "每批抽查两件。"]);
    const item = f.plan.items[0]!, reference = f.plan.references[1]!;
    item.fields.method.span_ids = [f.ids[1]!, f.ids[3]!];
    item.fields.quantity = { composition: "reference", span_ids: [f.ids[2]!, f.ids[4]!], separator: "", reason: "合成引用数量来源" };
    item.sampling = { status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: [f.ids[4]!], script_span_ids: [f.ids[4]!],
      condition_span_ids: [], reason: "同一合成来源用于抽样", confidence: 1 };
    reference.destinations = [{ item_key: item.key, target_field: "quantity" }];
    reference.import_scope.allowed_fields = ["quantity"];
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const before = validatePlanText(prettyJson(compiled), f.manifest);
    const scopeIssues = before.issues.filter(issue => issue.code === "reference_import_scope_exceeded");
    expect(scopeIssues).toHaveLength(1);
    expect(scopeIssues[0]!.details).toMatchObject({ imported_fields: ["quantity", "sampling"], outside_import_scope: ["sampling"] });
    const owned = classifyStrictSelectorIssues(f.plan, compiled, f.registry, scopeIssues, f.manifest);
    expect(owned[0]!.details!.how_to_pass).toContain("quantity 授权不隐含 sampling 授权");
    const destinations = structuredClone(reference.destinations);
    reference.import_scope.allowed_fields = ["quantity", "sampling"];
    const after = validatePlanText(prettyJson(compileTargetSelectors(f.plan, f.registry, f.manifest)), f.manifest);
    expect(after.issues.filter(issue => issue.code === "reference_import_scope_exceeded")).toEqual([]);
    expect(after.issues).toEqual(before.issues.filter(issue => issue.code !== "reference_import_scope_exceeded"));
    expect(reference.destinations).toEqual(destinations);
  });

  test.each(["shared", "branch-absent"])("%s effective sampling components prove a visible field without copying them into criterion", kind => {
    const f = sharedSamplingFixture();
    if (kind === "branch-absent") f.plan.sampling_rules[0]!.branches[0]!.components.push({ key: "quantity", role: "quantity", disposition: "absent", span_ids: [], reason: "本分支无额外数量，不删除共同数量" });
    const before = structuredClone(f.plan);
    const compiled = compileTargetSelectors(f.plan, f.registry, f.manifest);
    const validation = validatePlanText(prettyJson(compiled), f.manifest);
    expect(validation, JSON.stringify(validation.issues)).toMatchObject({ ok: true, issues: [] });
    const hydrated = hydrateSemanticSourcePlan(compiled, f.manifest);
    expect(materialize(hydrated, f.manifest, "test").result.inspection_lots[0]!.items[0]!.quantity).toBe(f.texts[4]);
    expect(f.plan).toEqual(before);
    expect(f.plan.items[0]!.continuation_span_ids).not.toContain(f.ids[4]);
  });

  test.each(["unselected", "unused", "absent", "overridden", "no-real-target-source"])("%s sampling cannot authorize the field through an envelope or another receiver", kind => {
    const f = sharedSamplingFixture();
    const rule = f.plan.sampling_rules[0]!, component = rule.components.find(c => c.role === "quantity")!;
    if (kind === "unselected") {
      rule.branches[1]!.components.push(structuredClone(component));
      component.disposition = "absent"; component.span_ids = [];
    }
    if (kind === "absent") { component.disposition = "absent"; component.span_ids = []; }
    if (kind === "unused") f.plan.items[0]!.sampling.status = "fallback";
    if (kind === "overridden") rule.branches[0]!.components.push({ ...component, span_ids: [f.ids[3]!] });
    if (kind === "no-real-target-source") f.plan.items[0]!.continuation_span_ids = [];
    const issues = registeredDocumentReferenceReceiptIssues(f.plan, f.manifest, f.registry);
    expect(issues).toContainEqual(expect.objectContaining({ code: "selector_reference_composition_without_resolve_receipt", path: "/items/0/fields/quantity/composition" }));
    expect(() => compileTargetSelectors(f.plan, f.registry, f.manifest)).toThrow(TargetSelectorCompileError);
  });

  test("the same shared contract reaches prompt, tool schema, contract reply and an executable repair round", async () => {
    const f = fixture("reference_placeholder");
    const root = await mkdtemp(join(tmpdir(), "multi-source-field-feedback-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(root, f.manifest.job_id, f.manifest.target_id,
        { manifest: f.manifest, markdown: Buffer.from(f.texts.join("\n")) });
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(f.registry));
      await workspace.updateState(state => { state.selector_stage = "commit"; state.target_review_protocol = "direct-validation/v1"; });
      const controller = await ToolController.create(workspace);
      expect(TARGET_SELECTOR_PROTOCOLS.reference_routes).toBe(MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE);
      expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("以本叶 criterion/typed table 的精确来源证明归属");
      expect(JSON.stringify(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA)).not.toContain(JSON.stringify(MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE).slice(1, -1));
      expect(JSON.stringify(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA)).toContain('authoring_protocols.reference_routes');
      expect((await controller.dispatch("get_target_selector_contract", {}) as any).authoring_protocols.reference_routes).toBe(MULTI_SOURCE_REFERENCE_FIELD_GUIDANCE);
      for (const surface of [JSON.stringify(TARGET_SELECTOR_PROTOCOLS),
        JSON.stringify(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA),
        JSON.stringify(await controller.dispatch("get_target_selector_contract", {}))]) {
        expect(surface).toContain(JSON.stringify(TABLE_SOURCE_OWNERSHIP_GUIDANCE).slice(1, -1));
        expect(surface).not.toContain("须包含共同表题");
        expect(surface).not.toContain("只放在 table.properties 或 context 不能建立项目归属");
        expect(surface).not.toContain("只放 table.properties 或 source_dispositions=context 不建立项目证据归属");
      }
      await controller.dispatch("batch_open_evidence", { evidence_ids: f.manifest.evidence.map(e => e.evidence_id) });
      const ledger = await controller.dispatch("list_reference_occurrences", {}) as any;
      for (const occurrence of ledger.occurrences) {
        expect(await controller.dispatch("read_document_reference_evidence", { target_key: occurrence.target_key })).toMatchObject({ ok: true, done: true });
      }
      const broken = structuredClone(f.plan);
      broken.items[0]!.continuation_span_ids = [f.ids[3]!];
      const first = await controller.dispatch("stage_target_selector_draft", { draft: {
        lots: broken.lots, items: broken.items, references: broken.references, source_dispositions: broken.source_dispositions,
      } }) as any;
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, local_validation: { ok: false } });
      const issue = first.local_validation.issues.find(row => row.code === "selector_reference_composition_without_resolve_receipt");
      expect(issue).toMatchObject({
        next_tool: "read_target_selectors",
        save_tool: "stage_target_selector_draft",
        candidate_read_tools: expect.arrayContaining(["read_target_selectors", "list_reference_occurrences", "open_evidence"]),
        how_to_pass: expect.stringContaining("item_source_not_bound"),
        allowed_actions: expect.arrayContaining([expect.stringContaining("本地原文"), expect.stringContaining("reference_only")]),
        detail_fields_at_issue_level: expect.arrayContaining(["allowed_actions"]),
        details: expect.objectContaining({
          source_checks: expect.arrayContaining([expect.objectContaining({ span_id: f.ids[4], status: "item_source_not_bound" })]),
        }),
      });
      const repaired = await controller.dispatch(issue.save_tool, { draft: { items: f.plan.items } }) as any;
      expect(repaired, JSON.stringify(repaired)).toMatchObject({ ok: true, local_validation: { ok: true } });
      expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).items).toEqual(f.plan.items);
      const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: repaired.draft_fingerprint });
      expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
