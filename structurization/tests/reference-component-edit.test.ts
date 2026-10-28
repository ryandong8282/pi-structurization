import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { Check } from "typebox/value";
import { referenceOccurrenceLiteralSpanIds } from "../src/contracts.js";
import { targetSelectorFingerprint } from "../src/target-selector-compiler.js";
import { editReferenceComponents } from "../src/reference-component-edit.js";
import { ToolController, createPiTools } from "../src/tools.js";
import { TARGET_MODELING_PHASE_LIMITS, TargetModelingPhaseBudget, withTargetModelingPhaseBudget } from "../src/pi-runtime.js";
import { buildSelectorStageScenario, clauseRecord, fullSpanFor, itemRecord, seedPlan } from "./selector-stage-fixture.js";

async function scenario(subject: string) {
  const { workspace, controller, manifest } = await buildSelectorStageScenario([
    `# 2 ${subject}`, "", "## 2.1 主控项目", "", `2.1.1 ${subject}应符合第3章的规定。检验数量：每批3件。`, "",
    "# 3 虚构配件规定", "", "3.1.1 备用件应保留包装编号。", "", "3.1.2 连接片不得有裂纹。", "", "3.1.3 卡口表面应平整。", "",
  ].join("\n"));
  const origin = clauseRecord(manifest, "2.1.1"), registry = await workspace.readSourceSpanRegistry();
  const originSpan = fullSpanFor(registry, origin.evidence_id, origin.text.length);
  await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id });
  const resolved = await controller.dispatch("resolve_document_reference", { origin_span_id: originSpan,
    raw_reference: "第3章", target: { kind: "section", number: "3" }, relation: "shared_requirement" });
  expect(resolved.ok).toBe(true);
  if (resolved.analysis_mode === "isolated") {
    const catalog = await controller.dispatch("read_reference_facts", { target_key: resolved.target_key });
    for (const entry of catalog.catalog as any[]) await controller.dispatch("read_reference_facts", { target_key: resolved.target_key, entry_ids: [entry.entry_id] });
  } else await controller.dispatch("read_document_reference_evidence", { target_key: resolved.target_key });
  const current = await workspace.readEvidenceManifest(), spans = await workspace.readSourceSpanRegistry();
  const occurrence = current.reference_occurrences.find(row => row.raw_reference === "第3章")!;
  const ids = occurrence.target_evidence_ids.map(id => spans.spans.find(span => span.evidence_id === id)!.span_id);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  const selectors = seedPlan(current, originSpan);
  selectors.items = [itemRecord("surface", "表面完整性", "主控项目", originSpan, "虚构作者保存的决定。")];
  selectors.references = [{ key: "chapter-three", occurrence_id: occurrence.occurrence_id,
    anchor_span_ids: referenceOccurrenceLiteralSpanIds(occurrence), target_span_ids: ids,
    action: "conditional", application_mode: "reference_only", import_scope: { mode: "field_specific", allowed_fields: ["requirement", "sampling"], reason: "保留作者现有范围。" },
    destinations: [{ item_key: "surface", target_field: "requirement" }], reason: "已有复杂引用与排除决定。",
    component_dispositions: [{ component_span_ids: ids.slice(0, 2), decision: "not_applicable", item_keys: [], reason: "原有作者判断。" },
      { component_span_ids: [ids[2]!], decision: "independent_item", item_keys: ["surface"], reason: "原有接收判断。" }],
  }];
  await workspace.writeWorkingSelectors(JSON.stringify(selectors));
  const restarted = await ToolController.create(workspace);
  await restarted.dispatch("read_target_selectors", { collection: "references", key: "chapter-three" });
  return { workspace, controller: restarted, manifest: current, registry: spans, selectors, ids, originSpan };
}

test.each(["虚构探测匣", "虚构隔振盒"])("%s: local component edit preserves complex receivers, grouped decisions and historical counts", async subject => {
  const { workspace, controller, selectors, ids } = await scenario(subject);
  const before = await workspace.readState();
  const input = { draft_fingerprint: targetSelectorFingerprint(selectors), reference_key: "chapter-three",
    component_dispositions: [{ component_span_ids: [ids[1]!], decision: "same_judgment", item_keys: ["surface"], reason: "模型修正本次组件决定，程序不评价业务正确性。" }] };
  expect(controller.selectorProviderPolicy().allowed_tools).toContain("stage_reference_component_decisions");
  expect(Check(createPiTools(controller).find(tool => tool.name === "stage_reference_component_decisions")!.parameters, input)).toBe(true);
  const result = await controller.dispatch("stage_reference_component_decisions", input);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, component_update: { destinations_preserved: true, other_components_preserved: true } });
  const after = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  expect({ ...after, references: [] }).toEqual({ ...selectors, references: [] });
  expect({ ...after.references[0], component_dispositions: [] }).toEqual({ ...selectors.references[0], component_dispositions: [] });
  expect(after.references[0].component_dispositions).toEqual([
    { ...selectors.references[0]!.component_dispositions![0], component_span_ids: [ids[0]] },
    selectors.references[0]!.component_dispositions![1], input.component_dispositions[0],
  ]);
  const state = await workspace.readState();
  expect(state.next_history_sequence).toBeGreaterThan(before.next_history_sequence);
  expect(state.validation_attempts).toBe(before.validation_attempts);
  expect(state.status).not.toBe("sealed");
});

test("stale draft, duplicate spans, cross-reference sources and unknown receivers are atomic rejections", async () => {
  const { workspace, controller, selectors, ids, originSpan } = await scenario("虚构测量片");
  const before = await readFile(workspace.workingSelectorPath, "utf8"), history = (await workspace.readState()).next_history_sequence;
  const input = { draft_fingerprint: targetSelectorFingerprint(selectors), reference_key: "chapter-three",
    component_dispositions: [{ component_span_ids: [ids[1]!], decision: "not_applicable", item_keys: [], reason: "模型明确的业务决定。" }] };
  const cases = [
    { args: { ...input, draft_fingerprint: "stale" }, error: "selector_draft_fingerprint_mismatch" },
    { args: { ...input, component_dispositions: [...input.component_dispositions, ...input.component_dispositions] }, error: "reference_component_duplicate" },
    { args: { ...input, component_dispositions: [{ ...input.component_dispositions[0], component_span_ids: [originSpan] }] }, error: "reference_component_source_invalid" },
    { args: { ...input, component_dispositions: [{ ...input.component_dispositions[0], decision: "independent_item", item_keys: ["missing"] }] }, error: "reference_component_receivers_invalid" },
  ];
  for (const { args, error } of cases) {
    expect(await controller.dispatch("stage_reference_component_decisions", args)).toMatchObject({ ok: false, error, durable_mutation: false, budget_consumed: false });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await workspace.readState()).next_history_sequence).toBe(history);
  }
});

test.each(["虚构探测匣", "虚构隔振盒"])("%s: persisted component decisions renew the existing read slice without changing historical counts", async subject => {
  const { workspace, controller, selectors, ids } = await scenario(subject);
  const before = await workspace.readState();
  const budget = new TargetModelingPhaseBudget();
  const chunk = { content: [{ type: "text", text: "x".repeat(96 * 1024) }] };
  for (let remaining = TARGET_MODELING_PHASE_LIMITS.max_tool_response_bytes - 64 * 1024; remaining > 0;) {
    const size = Math.min(96 * 1024, remaining);
    expect(budget.recordToolResult("neutral_read", { content: [{ type: "text", text: "x".repeat(size) }] }, "sampling").exceeded).toBe(false);
    remaining -= size;
  }
  const tool = createPiTools(controller).find(tool => tool.name === "stage_reference_component_decisions")!;
  const [bounded] = withTargetModelingPhaseBudget([tool], budget, () => "sampling", async () => ({
    checkpoint_fingerprint: "neutral-checkpoint", working_selector_sha256: "neutral-selectors",
    history_sequence: before.next_history_sequence, selector_stage: "sampling",
  }));
  const result = await bounded!.execute("neutral-component-save", {
    draft_fingerprint: targetSelectorFingerprint(selectors), reference_key: "chapter-three",
    component_dispositions: [{ component_span_ids: [ids[1]!], decision: "same_judgment", item_keys: ["surface"], reason: "作者保存本组件的中性判断。" }],
  }, undefined as never, undefined as never);
  expect(result.details).toMatchObject({ ok: true, component_update: { destinations_preserved: true } });
  const state = await workspace.readState();
  expect(state.next_history_sequence).toBeGreaterThan(before.next_history_sequence);
  expect(state.validation_attempts).toBe(before.validation_attempts);
  expect(state.selector_protocol).toEqual(before.selector_protocol);
  expect(state.status).not.toBe("sealed");
  expect(budget.recordToolResult("neutral_followup_read", chunk, "sampling")).toMatchObject({ exceeded: false, cumulative_tool_response_bytes: 96 * 1024 });
});

test("the program only merges selected identities and does not turn them into receiving relationships", async () => {
  const { manifest, registry, selectors, ids } = await scenario("虚构热传感片");
  const before = structuredClone(selectors), reference = selectors.references[0]!;
  reference.target_span_ids = [ids[0]!];
  const result = editReferenceComponents(selectors, manifest, registry, {
    draft_fingerprint: targetSelectorFingerprint(selectors), reference_key: reference.key,
    component_dispositions: [{ component_span_ids: [ids[1]!], decision: "independent_item", item_keys: ["surface"], reason: "模型选择该项目，未表示关联已经通过。" }],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reference.target_span_ids).toEqual([ids[0], ids[1]]);
  expect(result.reference.destinations).toEqual(before.references[0]!.destinations);
  expect(selectors.references[0]!.target_span_ids).toEqual([ids[0]]);
  expect(result.reference.import_scope).toEqual(before.references[0]!.import_scope);
});
