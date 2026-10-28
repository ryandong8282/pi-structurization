import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { Check } from "typebox/value";
import { componentPlanView, componentStepAccounting, componentStepDiagnosticScope, readComponentPlans, saveComponentPlan } from "../src/component-work-plan.js";
import { referenceFieldSelectionCapability } from "../src/reference-field-selection.js";
import { compactSourceReadRoutes, prioritizeWorkRoutes, selectorWorkAction } from "../src/selector-feedback.js";
import { selectorDiagnosticToolResponse } from "../src/selector-diagnostics.js";
import { resolvedReferenceComponentCoverageIssues } from "../src/reference-component-coverage.js";
import { referenceOccurrenceLiteralSpanIds } from "../src/contracts.js";
import { targetSelectorFingerprint } from "../src/target-selector-compiler.js";
import { ToolController, createPiTools } from "../src/tools.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

describe("mechanical source-route presentation", () => {
  test('source inventory work outside the selected step asks the model to realign without approving either step', () => {
    const step = { key: 'seal', span_ids: ['s-seal'], question: '封口条件如何接收？', status: 'active' as const, next_step: '保存封口决定', outcome: '' };
    const spans = [{ span_id: 's-seal', evidence_id: 'e-seal' }, { span_id: 's-label', evidence_id: 'e-label' }];
    const scope = componentStepDiagnosticScope(step, ['e-label'], spans);
    expect(scope).toMatchObject({ active_step_evidence_ids: ['e-seal'], current_diagnostic_evidence_ids: ['e-label'], current_diagnostic_outside_active_step: true });
    const work = { model_step: step, step_accounting: { ...scope, current_missing_selection_is_outside_active_step: scope.current_diagnostic_outside_active_step } };
    expect(selectorWorkAction(work)).toMatchObject({ kind: 'review_model_plan_against_current_todo', decision_owner: 'model', plan_tool: 'save_target_component_plan' });
    expect(componentStepDiagnosticScope(step, ['e-label', 'e-seal'], spans).current_diagnostic_outside_active_step).toBe(false);
    expect(componentStepDiagnosticScope({ ...step, span_ids: [] }, ['e-label'], spans).current_diagnostic_outside_active_step).toBe(false);
    expect(componentStepDiagnosticScope({ ...step, span_ids: ['unknown'] }, ['e-label'], spans).current_diagnostic_outside_active_step).toBe(false);
    expect(step.status).toBe('active');
  });
  test("groups identical routes without changing source identity, permissions, or distinct targets", () => {
    const route = (id: string, key = "target-a") => ({ evidence_id: id, access_mode: "isolated_reference", read_tool: "read_reference_facts",
      target_key: key, open_evidence_allowed: false, tool_arguments: { target_key: key } });
    const input = { related_information: { source_access: [
      ...Array.from({ length: 65 }, (_, i) => route(`e${i + 1}`)), route("other", "target-b"),
      { evidence_id: "direct-1", read_tool: "open_evidence", tool_arguments: { evidence_id: "direct-1" } },
      { evidence_id: "direct-2", read_tool: "open_evidence", tool_arguments: { evidence_id: "direct-2" } },
    ] } };
    const before = structuredClone(input), result = compactSourceReadRoutes(input);
    const groups = result.related_information.source_access as any[];
    expect(groups).toHaveLength(4);
    expect(groups[0]).toEqual({ access_mode: "isolated_reference", read_tool: "read_reference_facts", target_key: "target-a",
      open_evidence_allowed: false, tool_arguments: { target_key: "target-a" }, evidence_ids: Array.from({ length: 65 }, (_, i) => `e${i + 1}`) });
    expect(groups[1]).toMatchObject({ evidence_id: "other", target_key: "target-b" });
    expect(groups.slice(2).map(row => row.tool_arguments.evidence_id)).toEqual(["direct-1", "direct-2"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)) / 4);
    expect(input).toEqual(before);
    expect(compactSourceReadRoutes(result)).toEqual(result);
  });

  test("secondary hints retain data and a scoped supporting read through SDK normalization", () => {
    const output = prioritizeWorkRoutes({ ok: true,
      selector_repair_work: { record_read: { tool: "read_target_selectors", arguments: { collection: "references", key: "r" } } },
      model_review: { observations: [{ code: "selector_table_expansion_obligations_pending", path: "/items", message: "来源待判断",
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: "row" }, how_to_pass: "按next_tool_arguments读取，业务由模型判断。" }] },
    });
    const normalized = selectorDiagnosticToolResponse(output) as any;
    expect(normalized).toMatchObject({ next_tool: "read_target_selectors", next_tool_arguments: { key: "r" },
      model_review: { blocking: false, priority: "secondary_candidates", observations: [{
        supporting_read: { tool: "open_evidence", arguments: { evidence_id: "row" } },
      }] } });
    expect(normalized.model_review.observations[0]).not.toHaveProperty("next_tool");
    expect(normalized.model_review.observations[0].how_to_pass).toContain("supporting_read.arguments");
  });

  test("a model-chosen step becomes the main action without reissuing an already delivered record read", () => {
    const step = { key: "compare-types", span_ids: ["s1"], question: "两种虚构零件的条件如何保留？", status: "active", next_step: "保存已经确认的组件决定。", outcome: "" };
    const work = { model_step: step, record_read: { tool: "read_target_selectors", arguments: { collection: "references", key: "r" } } };
    const input = { ok: true, selector_repair_work: work, next_tool: work.record_read.tool, next_tool_arguments: work.record_read.arguments };
    const result = selectorDiagnosticToolResponse(prioritizeWorkRoutes(input)) as any;
    expect(result.next_action).toMatchObject({ kind: "execute_model_authored_step", decision_owner: "model", step });
    expect(result).not.toHaveProperty("next_tool");
    expect(result.selector_repair_work.record_read).toEqual(work.record_read);
    // A real parameter rejection still retains its precise correction route.
    expect(prioritizeWorkRoutes({ ...input, ok: false, error: "neutral_parameter_error" }).next_tool).toBe("read_target_selectors");
    const accounting = componentStepAccounting(step, { target_span_ids: ["s1", "s2"], component_dispositions: [{ component_span_ids: ["s1"] }] });
    expect(accounting).toMatchObject({ declared_exact_span_ids: ["s1"], undeclared_active_step_span_ids: [],
      missing_or_duplicate_selected_span_ids: ["s2"], business_completion_proven: false, model_plan_status_unchanged: true });
    const original = structuredClone(step);
    const realigned = prioritizeWorkRoutes({ ok: true, selector_repair_work: { ...work,
      step_accounting: { ...accounting, current_missing_selection_is_outside_active_step: true } } });
    expect(realigned.next_action).toMatchObject({ kind: "review_model_plan_against_current_todo", decision_owner: "model", plan_tool: "save_target_component_plan" });
    expect(step).toEqual(original);
    expect(componentStepAccounting(step, { target_span_ids: ["s1"], component_dispositions: [
      { component_span_ids: ["s1"] }, { component_span_ids: ["s1"] },
    ] }).undeclared_active_step_span_ids).toEqual(["s1"]);
  });
});

test.each(["虚构探测盒", "虚构隔振垫"])("%s: model chooses groups and active step; replay never judges applicability", async subject => {
  const root = await mkdtemp(join(tmpdir(), "component-plan-"));
  const first = { occurrence_id: "reference:fictional", active_step_key: "compare-second", steps: [
    { key: "read-first", span_ids: [], question: `${subject}的条件原文是什么？`, status: "pending" as const, next_step: "按原文位置取资料。", outcome: "" },
    { key: "compare-second", span_ids: [], question: "这两种对象是否是同一条件分支？", status: "active" as const, next_step: "由模型核对已读的两个对象定义。", outcome: "" },
  ] };
  expect(await saveComponentPlan(root, "source", first)).toMatchObject({ ok: true });
  const restored = await readComponentPlans(root, "source");
  expect(componentPlanView(restored.plans[first.occurrence_id], first.occurrence_id).active_step?.key).toBe("compare-second");
  // The program stores even an incorrect model conclusion; it cannot infer business correctness.
  expect(await saveComponentPlan(root, "source", { ...first, active_step_key: "read-first", steps: [
    { ...first.steps[1]!, status: "done", outcome: "模型声明不适用，程序不裁定这条业务判断。", next_step: "" },
  ] })).toMatchObject({ ok: true });
  const updated = await readComponentPlans(root, "source");
  expect(updated.plans[first.occurrence_id]!.steps).toHaveLength(2);
  expect(updated.plans[first.occurrence_id]!.steps[0]).toEqual(first.steps[0]);
  expect(updated.plans[first.occurrence_id]!.steps[1]!.status).toBe("done");
  expect(componentPlanView(updated.plans[first.occurrence_id], first.occurrence_id).business_completion_proven).toBe(false);
  const directory = componentPlanView(updated.plans[first.occurrence_id], first.occurrence_id);
  expect(directory.read_full_plan.arguments.component_plan_cursor).toBe(0);
  const fullPage = componentPlanView(updated.plans[first.occurrence_id], first.occurrence_id, 1, 1, true);
  expect(fullPage.steps[0]).toMatchObject({ key: "compare-second", status: "done", outcome: "模型声明不适用，程序不裁定这条业务判断。", span_ids: [] });
  expect(await readdir(join(root, "component-plan-history"))).toHaveLength(2);
  const snapshot = await readFile(join(root, "component-work-plans.json"), "utf8");
  expect(await saveComponentPlan(root, "source", { ...first, active_step_key: "missing", steps: [] })).toMatchObject({ ok: false });
  expect(await readFile(join(root, "component-work-plans.json"), "utf8")).toBe(snapshot);
});

test("a missing reference receipt continues a model step and accepts an unfinished author save without approving it", async () => {
  const { workspace, manifest, controller } = await buildSelectorStageScenario([
    "# 2 虚构标定盒", "", "## 2.1 主控项目", "", "2.1.1 标定盒封口应符合附录 A 的规定。检验数量：每批3件。", "",
    "# 附录 A", "", "A.0.1 标定盒封口不得开裂，特殊工况应增设防护盖。", "",
  ].join("\n"));
  const origin = clauseRecord(manifest, "2.1.1");
  const span = fullSpanFor(await workspace.readSourceSpanRegistry(), origin.evidence_id, origin.text.length);
  await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id });
  expect(await controller.dispatch("resolve_document_reference", { origin_span_id: span, raw_reference: "附录 A",
    target: { kind: "appendix", number: "A" }, relation: "shared_appendix_requirement" })).toMatchObject({ ok: true });
  const current = await workspace.readEvidenceManifest(), occurrence = current.reference_occurrences.find(row => row.raw_reference === "附录 A")!;
  const selectors = seedPlan(current, span);
  selectors.references = [];
  selectors.items = [itemRecord("seal", "封口完整性", "主控项目", span, "模型尚待判断的虚构要求。")];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const reopened = await ToolController.create(workspace), before = await workspace.readState();
  expect(await reopened.dispatch("save_target_component_plan", { occurrence_id: occurrence.occurrence_id, active_step_key: "seal-condition", steps: [{
    key: "seal-condition", span_ids: [span], question: "封口条件与防护盖如何关联？", status: "active", next_step: "先保存已经确认的封口决定，其余继续判断。", outcome: "",
  }] })).toMatchObject({ ok: true });
  const step = await reopened.selectorExecutionStep();
  expect(step.work).toMatchObject({ code: "selector_registered_reference_receipt_missing", model_step: { key: "seal-condition" },
    partial_save: { reference_receipt_creation: { occurrence_id: occurrence.occurrence_id,
      anchor_span_ids: referenceOccurrenceLiteralSpanIds(occurrence), key_owner: "model", stageable_action: "review", completion_proven: false } } });
  expect(step.next_action).toMatchObject({ kind: "execute_model_authored_step" });
  expect(step.work?.partial_save).not.toHaveProperty("component_decisions");
  expect(step.work?.partial_save.instruction).not.toContain("使用component_decisions");
  const staged = await reopened.dispatch("stage_target_selector_draft", { draft: { references: [{
    key: "pending-appendix", occurrence_id: occurrence.occurrence_id, anchor_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
    target_span_ids: [], action: "review", application_mode: "reference_only", import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "质量要求仍待模型逐组件判断。" },
    destinations: [], reason: "只建立真实引用回执，未决组件不猜测不适用。",
  }] } });
  expect(staged).toMatchObject({ ok: true, execution_state: "authoring" });
  expect((await workspace.readState()).next_history_sequence).toBeGreaterThan(before.next_history_sequence);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect((await workspace.readState()).status).toBe("working");
  expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).references[0].action).toBe("review");
  expect(await reopened.dispatch("commit_target_selector_draft", { draft_fingerprint: targetSelectorFingerprint(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"))) })).toMatchObject({ ok: false });
  expect((await workspace.readState()).status).toBe("working");
});

test("real controller restores the model plan while preserving author errors, history and budgets", async () => {
  const { workspace, manifest, controller } = await buildSelectorStageScenario([
    "# 2 虚构探测盒", "", "## 2.1 主控项目", "", "2.1.1 探测盒封口应符合附录 A 的规定。检验数量：每批3件。", "",
    "# 附录 A 检查方法", "", "A.0.1 室内探测盒观察封口，室外型还应检查防护盖。", "",
  ].join("\n"));
  const origin = clauseRecord(manifest, "2.1.1");
  const span = fullSpanFor(await workspace.readSourceSpanRegistry(), origin.evidence_id, origin.text.length);
  await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id });
  const registered = await controller.dispatch("resolve_document_reference", { origin_span_id: span, raw_reference: "附录 A",
    target: { kind: "appendix", number: "A" }, relation: "shared_appendix_requirement" });
  expect(registered.ok).toBe(true);
  const currentManifest = await workspace.readEvidenceManifest();
  const occurrence = currentManifest.reference_occurrences.find(row => row.raw_reference === "附录 A")!;
  const selectors = seedPlan(currentManifest, span);
  selectors.items = [itemRecord("seal", "封口完整性", "主控项目", span, "虚构原文的质量要求。")];
  selectors.references = [{ key: "appendix-reference", occurrence_id: occurrence.occurrence_id,
    anchor_span_ids: [span], target_span_ids: [], action: "review", application_mode: "reference_only",
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "虚构附录的判据待模型核对。" },
    destinations: [], reason: "模型尚未判断附录组件如何与当前项目关联。" }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const restarted = await ToolController.create(workspace);
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const focusBefore = await restarted.selectorRepairWork();
  const args = { occurrence_id: occurrence.occurrence_id, active_step_key: "compare", steps: [{
    key: "compare", span_ids: [span], question: "两类探测盒各有哪些本地和引用条件？", status: "active",
    next_step: "核对本地条款和附录的对象定义，再选择是否需要独立项或条件分支。", outcome: "",
  }] };
  expect(restarted.selectorProviderPolicy().allowed_tools).toContain("save_target_component_plan");
  expect(Check(createPiTools(restarted).find(t => t.name === "save_target_component_plan")!.parameters, args)).toBe(true);
  expect(await restarted.dispatch("save_target_component_plan", args)).toMatchObject({ ok: true, selector_mutation: false, business_completion_proven: false });
  const reopened = await ToolController.create(workspace);
  const focusAfter = await reopened.selectorRepairWork();
  expect(focusAfter?.identity).toBe(focusBefore?.identity);
  expect(focusAfter?.component_plan?.active_step).toMatchObject({ key: "compare", question: args.steps[0]!.question });
  expect(focusAfter?.next_action).toEqual(selectorWorkAction(focusAfter));
  expect(focusAfter?.next_action).toEqual(prioritizeWorkRoutes({ ok: true, selector_repair_work: focusAfter }).next_action);
  expect(await reopened.dispatch("get_target_context", { component_plan_occurrence_id: occurrence.occurrence_id }))
    .toMatchObject({ ok: true, component_plan: { active_step_key: "compare", business_completion_proven: false,
      steps: [{ key: "compare", span_ids: [span], next_step: args.steps[0]!.next_step }] } });
  expect((await workspace.readState()).next_history_sequence).toBe(before.next_history_sequence);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
  expect((await workspace.readState()).selector_protocol).toEqual(before.selector_protocol);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  const bad = await reopened.dispatch("save_target_component_plan", { ...args, steps: [{ ...args.steps[0], span_ids: ["span:unknown"] }] });
  expect(bad).toMatchObject({ ok: false, error: "component_plan_source_unknown" });
  expect((await reopened.selectorRepairWork())?.component_plan?.active_step_key).toBe("compare");
  // A diagnostic can identify the same author record by key without repeating occurrence_id.
  const referenceKey = selectors.references.find(row => row.occurrence_id === occurrence.occurrence_id)!.key;
  vi.spyOn(reopened as any, "currentFieldDiagnostics").mockResolvedValue({ inputs: "current", cached: { issues: [{
    code: "selector_reference_components_unaccounted", path: "/references/0/component_dispositions", message: "中性组件尚未处置。",
    details: { reference_key: referenceKey, actual: { missing: 1 }, expected: "explicit author decision" },
  }] } });
  const keyedFocus = await reopened.selectorRepairWork();
  expect(keyedFocus?.diagnostic.record).not.toHaveProperty("occurrence_id");
  expect(keyedFocus?.component_plan?.active_step_key).toBe("compare");
  expect(keyedFocus?.model_step?.key).toBe("compare");
  vi.mocked((reopened as any).currentFieldDiagnostics).mockResolvedValue({ inputs: 'current-field-error', cached: { issues: [{
    code: 'reference_import_scope_exceeded', path: '/references/0/import_scope/allowed_fields', message: '实际导入字段不在声明范围。',
    record_read: { tool: 'read_target_selectors', arguments: { collection: 'references', key: referenceKey } },
    details: { reference_key: referenceKey, occurrence_id: occurrence.occurrence_id,
      actual: { imported: ['method'], allowed: ['requirement'] } },
  }] } });
  const fieldWork = await reopened.selectorRepairWork();
  expect(fieldWork?.record_read?.arguments.key).toBe(referenceKey);
  expect(fieldWork).not.toHaveProperty('model_step');
  expect(fieldWork?.next_action).toBeUndefined();
  expect(prioritizeWorkRoutes({ ok: true, selector_repair_work: fieldWork })).toMatchObject({
    next_tool: 'read_target_selectors', next_tool_arguments: { collection: 'references', key: referenceKey },
  });
  expect(fieldWork?.component_plan).toMatchObject({ active_step_key: 'compare', execution_priority: 'supporting_navigation' });
  const registry = await workspace.readSourceSpanRegistry();
  const outside = registry.spans.find(row => row.evidence_id !== origin.evidence_id)!;
  expect(outside).toBeDefined();
  vi.mocked((reopened as any).currentFieldDiagnostics).mockResolvedValue({ inputs: 'current-other-source', cached: { issues: [{
    code: 'selector_resolved_reference_components_unaccounted', path: '/references/0/component_dispositions', message: '另一中性来源尚未处置。',
    details: { reference_key: referenceKey, occurrence_id: occurrence.occurrence_id, unaccounted_evidence_ids: [outside.evidence_id],
      evidence_ids: [outside.evidence_id], actual: { unaccounted_component_count: 1 } },
  }] } });
  const redirected = await reopened.selectorRepairWork();
  expect(redirected?.next_action).toMatchObject({ kind: 'review_model_plan_against_current_todo', decision_owner: 'model' });
  expect(redirected?.step_accounting).toMatchObject({ current_diagnostic_outside_active_step: true, current_diagnostic_evidence_ids: [outside.evidence_id] });
  expect(redirected?.model_step?.key).toBe('compare');
  expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(draft);
  expect((await workspace.readState()).validation_attempts).toBe(before.validation_attempts);
});

test("a partial author decision is saved while the rest of a fictional chapter remains unresolved", async () => {
  const { workspace, controller, manifest } = await buildSelectorStageScenario([
    "# 2 虚构仪器匣", "", "## 2.1 主控项目", "", "2.1.1 仪器匣应符合第3章的规定。检验数量：每批3件。", "",
    "# 3 虚构配件规定", "", "3.1.1 备用配件应保留包装编号。", "", "3.1.2 连接片表面不得有裂纹。", "",
  ].join("\n"));
  const origin = clauseRecord(manifest, "2.1.1"), span = fullSpanFor(await workspace.readSourceSpanRegistry(), origin.evidence_id, origin.text.length);
  await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id });
  const resolved = await controller.dispatch("resolve_document_reference", { origin_span_id: span, raw_reference: "第3章",
    target: { kind: "section", number: "3" }, relation: "shared_requirement" });
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  if (resolved.analysis_mode === "isolated") {
    const catalog = await controller.dispatch("read_reference_facts", { target_key: resolved.target_key });
    for (const entry of catalog.catalog as any[]) await controller.dispatch("read_reference_facts", { target_key: resolved.target_key, entry_ids: [entry.entry_id] });
  } else await controller.dispatch("read_document_reference_evidence", { target_key: resolved.target_key });
  const current = await workspace.readEvidenceManifest(), occurrence = current.reference_occurrences.find(row => row.raw_reference === "第3章")!;
  const registry = await workspace.readSourceSpanRegistry(), targetId = occurrence.target_evidence_ids[0]!;
  const targetSpan = registry.spans.find(row => row.evidence_id === targetId)!;
  expect(occurrence.target_evidence_ids.length).toBeGreaterThan(1);
  const selectors = seedPlan(current, span);
  const reference = { key: "chapter-three", occurrence_id: occurrence.occurrence_id, anchor_span_ids: referenceOccurrenceLiteralSpanIds(occurrence),
    target_span_ids: occurrence.target_evidence_ids.map(id => registry.spans.find(row => row.evidence_id === id)!.span_id), action: "review" as const, application_mode: "reference_only" as const,
    import_scope: { mode: "field_specific" as const, allowed_fields: ["requirement" as const], reason: "虚构引用范围由作者核对。" },
    destinations: [], reason: "作者尚未完成逐组件判断，保留未决。" };
  selectors.references = [reference];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const before = resolvedReferenceComponentCoverageIssues(selectors, current, registry, new Map());
  const partial = { ...reference, target_span_ids: [targetSpan.span_id], component_dispositions: [{
    component_span_ids: [targetSpan.span_id], decision: "not_applicable" as const, item_keys: [], reason: "虚构作者判断这一组件不属于当前匣体验收，其他组件仍待判断。" }] };
  const restarted = await ToolController.create(workspace), stateBefore = await workspace.readState();
  const saved = await restarted.dispatch("stage_target_selector_draft", { draft: { references: [partial] } });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
  const after = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  const issues = resolvedReferenceComponentCoverageIssues(after, current, await workspace.readSourceSpanRegistry(), new Map());
  expect(issues[0]!.details.actual.unaccounted_component_count).toBe(before[0]!.details.actual.unaccounted_component_count - 1);
  expect(after.references[0].action).toBe("review");
  expect((await workspace.readEvidenceManifest()).reference_occurrences.find(row => row.occurrence_id === occurrence.occurrence_id)!.target_evidence_ids)
    .toEqual(occurrence.target_evidence_ids);
  expect(referenceFieldSelectionCapability(after.references[0])).toMatchObject({ write_mode: "full_records", reasons: ["excluded_components"] });
  expect(referenceFieldSelectionCapability(reference)).toMatchObject({ write_mode: "field_selection", reasons: [] });
  expect(issues.length).toBeGreaterThan(0);
  expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
  expect((await workspace.readState()).status).not.toBe("sealed");
  const selected = registry.spans.find(row => row.evidence_id === occurrence.target_evidence_ids[1])!;
  const beforeProjection = await readFile(workspace.workingSelectorPath, "utf8");
  const adopted = await restarted.dispatch("stage_target_selector_draft", {
    draft_fingerprint: targetSelectorFingerprint(after), reference_selections: [{ occurrence_id: occurrence.occurrence_id,
      action: "adopt", reason: "虚构作者选择一个已确认的引用组件，保留其他未决组件。", bindings: [{
        item_key: after.items[0].key, target_field: "requirement", target_span_ids: [selected.span_id],
        component_decision: "independent_item", local_context_fields: [{ field: "requirement", span_ids: [span], reason: "保留本地引用及数量上下文。" }],
        reason: "本次只接收已经判断的这个组件。",
      }] }],
  });
  expect(adopted, JSON.stringify(adopted)).toMatchObject({ ok: false, error: "reference_selection_invalid",
    selector_issues: [expect.objectContaining({ code: "reference_field_selection_complex_reference" })] });
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(beforeProjection);
  const item = structuredClone(after.items[0]);
  item.fields.requirement = { composition: "reference", span_ids: [span, selected.span_id], separator: " ", reason: "保留本地条件并接收本次选择的虚构组件。" };
  const fullReference = { ...partial, action: "adopt", target_span_ids: [...partial.target_span_ids, selected.span_id],
    origin_binding: { item_key: item.key, target_field: "requirement" },
    destinations: [{ item_key: item.key, target_field: "requirement" }], component_dispositions: [...partial.component_dispositions,
      { component_span_ids: [selected.span_id], decision: "independent_item", item_keys: [item.key], reason: "作者选择这个独立组件进入当前真实项目。" }],
  };
  expect(await restarted.dispatch("stage_target_selector_draft", { operation: "upsert", draft: { items: [item], references: [fullReference] } }))
    .toMatchObject({ ok: true });
  const adoptedDraft = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  expect(adoptedDraft.references[0]).toMatchObject({ action: "adopt", destinations: expect.arrayContaining([
    { item_key: after.items[0].key, target_field: "requirement" },
  ]) });
  expect(adoptedDraft.references[0].component_dispositions).toEqual(expect.arrayContaining(partial.component_dispositions));
  // The source permission is not a declaration of applicability or whole-chapter completion.
  const remaining = resolvedReferenceComponentCoverageIssues(adoptedDraft, current, await workspace.readSourceSpanRegistry(), new Map());
  expect(remaining.length).toBeGreaterThan(0);
  expect((await restarted.selectorRepairWork())?.reference_source_permission).toMatchObject({
    source_role: "registered_reference", primary_range_expansion_required: false, applicability_decision_owner: "model",
  });
  vi.spyOn(restarted as any, "readFrozenTargetSemanticBasis").mockResolvedValue({ subject: "虚构仪器匣", boundary_reason: "同一装配范围。" });
  const blocked = await restarted.dispatch("report_target_blocker", { kind: "frozen_scope_conflict", evidence_span_ids: [span],
    affected_selector_paths: ["/references/0"], explanation: "虚构作者误以为引用正文必须先加入primary范围。" });
  expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: false, terminal: false, error: "frozen_scope_conflict_unverified",
    actual: { registered_references_for_supplied_source: [expect.objectContaining({ occurrence_id: occurrence.occurrence_id,
      primary_range_expansion_required: false, applicability_decision_owner: "model" })] }, current_work: expect.any(Object) });
  expect(blocked.next_tool).not.toBe("commit_target_selector_draft");
  expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
});
