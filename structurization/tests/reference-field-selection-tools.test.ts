import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Check } from "typebox/value";
import { prettyJson, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { registryWithFullSourceSpans, registerSourceSpan } from "../src/source-span-registry.js";
import { initialTargetSelectorPlan, targetSelectorFingerprint, TARGET_SELECTOR_PLAN_JSON_SCHEMA, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { createPiTools, ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reference-selection-tools-"));
  roots.push(root);
  const texts = {
    origin: "5.4 在干燥条件下，指示器的检验方法按第8.2条执行。",
    method: "8.2 将指示器接入校验器，读取偏移值。甲组记录结果。乙组记录结果。",
    criterion: "5.5 指示器示值误差不大于4格。",
    untouched: "5.6 备用端子外观应完整。",
  };
  const evidenceIds = Object.fromEntries(Object.keys(texts).map(key => [key, "evidence:" + sha256Text("fictional-indicator-" + key)])) as Record<keyof typeof texts, string>;
  const markdown = Object.values(texts).join("\n\n"), sourceHash = sha256Text(markdown);
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "fictional-indicator", target_id: "indicator-arrival",
    source: { adapter: "document-domain-agent/v1", file_name: "indicator.md", sha256: sourceHash, semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "indicator-arrival", source_line_count: 7,
      selected_start_line: 1, selected_end_exclusive_line: 8, selected_heading: "指示器到货检查", selection_reason: "只验证引用选择事务，虚构业务内容",
      selected_atom_ids: Object.values(evidenceIds), target_evidence_fragments: [], candidates: [] },
    evidence: Object.entries(texts).map(([key, text], index) => ({ evidence_id: evidenceIds[key as keyof typeof texts], kind: "paragraph", role: "supporting_clause",
      locator: "line:" + (index * 2 + 1), text, text_sha256: sha256Text(text), requires_disposition: true, evidence_scope: "primary" })),
    table_fragments: [], reference_occurrences: [], evidence_fingerprint: sha256Text("neutral-selection\0" + markdown),
  };
  const sources = manifest.evidence.map(record => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text }));
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, sources);
  const quote = (key: keyof typeof texts, value: string) => {
    const source = sources.find(row => row.evidence_id === evidenceIds[key])!;
    const start = source.text.indexOf(value);
    if (start < 0) throw new Error("Missing neutral fixture quote");
    const registered = registerSourceSpan(registry, source, start, start + value.length);
    registry = registered.registry;
    return registered.span.span_id;
  };
  const ids = { origin: quote("origin", texts.origin), literal: quote("origin", "第8.2条"), name: quote("criterion", "指示器示值误差"),
    criterion: quote("criterion", "指示器示值误差不大于4格。"), untouched: quote("untouched", "备用端子外观应完整。") };
  const occurrenceId = "reference:" + sha256Text("indicator-method-occurrence");
  manifest.reference_occurrences.push({ occurrence_id: occurrenceId, origin_evidence_id: evidenceIds.origin,
    reference_literal_span_id: ids.literal, origin_fields: [], raw_reference: "第8.2条", target_evidence_ids: [evidenceIds.method],
    required: true, status: "resolved", depth: 1, path: [], reference_kind: "clause",
    target_address: { source_id: sourceHash, locator_kind: "clause", locator: "8.2" } });
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots = [{ key: "indicators", name: "指示器到货批", scope_span_ids: [ids.origin], reason: "虚构的独立验收范围" }];
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const,
    span_ids, separator: "" as const, reason: span_ids.length ? "作者选择的逐字来源" : "尚未向此字段导入来源" });
  selectors.items = ["indicator-error", "terminal-appearance"].map((key, index) => ({ key, lot_key: "indicators",
    name: index ? "备用端子外观" : "指示器示值误差", category: "一般项目", criterion_span_ids: [index ? ids.untouched : ids.criterion], continuation_span_ids: [],
    fields: { name: { ...field([index ? ids.untouched : ids.name]), composition: "semantic_summary" as const },
      requirement: field([index ? ids.untouched : ids.criterion]), method: field([]), quantity: field([]), note: field([]) },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "仅验证来源事务的中性项", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "本用例不声明抽样规则", confidence: 1 },
    reason: "保留完整作者记录以验证投影只修改点名字段" }));
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
  await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; state.selector_stage = "primary"; state.validation_attempts = 2; });
  const controller = await ToolController.create(workspace);
  for (const evidence_id of Object.values(evidenceIds)) {
    expect(await controller.dispatch("open_evidence", { evidence_id })).toMatchObject({ ok: true });
  }
  const codec = await ModelSourceHandles.open(workspace.root);
  const tools = codec.wrapTools(createPiTools(controller));
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(candidate => candidate.name === name)!;
    expect(Check(tool.parameters, args)).toBe(true);
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const result = await tool.execute("selection-test", (prepared ?? args) as any, undefined as any, undefined as any, undefined as any);
    const block = result.content.find(entry => entry.type === "text") as { text: string };
    return JSON.parse(block.text);
  };
  const publicIds = await codec.encode({ occurrence_id: occurrenceId, origin_evidence_id: evidenceIds.origin,
    target_evidence_id: evidenceIds.method, draft_fingerprint: targetSelectorFingerprint(selectors) }) as any;
  const request = () => ({ draft_fingerprint: publicIds.draft_fingerprint, source_handle_scope: codec.scope,
    quote_bindings: [
      { key: "$local_context", evidence_id: publicIds.origin_evidence_id, quote: "在干燥条件下，指示器的检验方法按第8.2条执行。" },
      { key: "$selected_method", evidence_id: publicIds.target_evidence_id, quote: "读取偏移值。" },
    ],
    reference_selections: [{ occurrence_id: publicIds.occurrence_id, action: "adopt", reason: "采用当前条款明确引用的方法",
      bindings: [{ item_key: "indicator-error", target_field: "method", target_span_ids: ["$selected_method"], component_decision: "same_judgment",
        local_context_fields: [{ field: "note", span_ids: ["$local_context"], reason: "保留干燥条件及本地引用文字" }], reason: "采用读取偏移值的方法" }] }],
  });
  return { workspace, controller, codec, tools, call, request, selectors, ids, occurrenceId, publicIds };
}

async function snapshot(workspace: RevisionWorkspace) {
  const historyNames = (await readdir(workspace.historyDirectory)).sort();
  const state = await workspace.readState();
  return { selectors: await readFile(workspace.workingSelectorPath, "utf8"), registry: await readFile(workspace.sourceSpanRegistryPath, "utf8"),
    history: await Promise.all(historyNames.map(async name => [name, await readFile(join(workspace.historyDirectory, name), "utf8")])),
    counters: { history: state.next_history_sequence, validation_attempts: state.validation_attempts, next_validation_sequence: state.next_validation_sequence,
      selector_protocol: state.selector_protocol } };
}

describe("reference field selection through real staging tools", () => {
  test("the wrapped schema and same-call quote aliases derive two collections with one history write", async () => {
    const f = await fixture(), before = await snapshot(f.workspace), input = f.request(), untouched = structuredClone(input);
    const props = TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA.properties;
    expect(props).toHaveProperty("reference_selections"); expect(props).toHaveProperty("draft_fingerprint");
    expect(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties).not.toHaveProperty("reference_selections");
    expect(TARGET_SELECTOR_PLAN_JSON_SCHEMA.properties).not.toHaveProperty("draft_fingerprint");
    const receipt = await f.call("stage_target_selector_draft", input);
    expect(receipt).toMatchObject({ ok: true, terminal: false, collections: ["items", "references"], budget_consumed: false,
      mutation_receipt: { status: "saved", collections: [
        { collection: "items", submitted_keys: ["indicator-error"] },
        { collection: "references", submitted_keys: [expect.any(String)] },
      ] } });
    expect(receipt.reference_selection_projection.derived_relations).toHaveLength(1);
    const after = await snapshot(f.workspace), saved = JSON.parse(after.selectors) as TargetSelectorPlan;
    expect(after.counters.history).toBe(before.counters.history + 1);
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(after.counters.validation_attempts).toBe(2);
    expect(saved.items[1]).toEqual(f.selectors.items[1]); expect(saved.lots).toEqual(f.selectors.lots);
    expect(saved.items[0]!.fields.requirement).toEqual(f.selectors.items[0]!.fields.requirement);
    expect(saved.items[0]!.sampling).toEqual(f.selectors.items[0]!.sampling);
    const method = saved.items[0]!.fields.method.span_ids[0]!, local = saved.items[0]!.fields.note.span_ids[0]!;
    expect(method).toMatch(/^span:[a-f0-9]{32}$/); expect(local).toMatch(/^span:[a-f0-9]{32}$/);
    expect(saved.references).toHaveLength(1);
    expect(saved.references[0]).toMatchObject({ occurrence_id: f.occurrenceId, anchor_span_ids: [f.ids.literal], target_span_ids: [method],
      destinations: [{ item_key: "indicator-error", target_field: "method" }], origin_binding: { item_key: "indicator-error", target_field: "note" },
      import_scope: { allowed_fields: ["method"] }, component_dispositions: [{ component_span_ids: [method], decision: "same_judgment", item_keys: ["indicator-error"] }] });
    expect(after.selectors).not.toContain("$selected_method"); expect(after.selectors).not.toContain("$local_context");
    expect(after.selectors).not.toContain("reference_selections"); expect(after.selectors).not.toContain("source_handle_scope");
    expect(input).toEqual(untouched);
  });

  test("a stale fingerprint rejects the whole call before registering its valid new quotes", async () => {
    const f = await fixture(), before = await snapshot(f.workspace), input = { ...f.request(), draft_fingerprint: "f".repeat(64) };
    const receipt = await f.call("stage_target_selector_draft", input);
    expect(receipt).toMatchObject({ ok: false, terminal: false, durable_mutation: false, budget_consumed: false,
      error: "selector_draft_fingerprint_mismatch", writable_path: "/draft_fingerprint", mutation_receipt: { status: "not_applied" } });
    expect(await snapshot(f.workspace)).toEqual(before);
  });

  test("an ambiguous later quote rolls back earlier successful temporary bindings", async () => {
    const f = await fixture(), before = await snapshot(f.workspace), input = f.request();
    input.quote_bindings[1]!.quote = "记录结果。";
    const receipt = await f.call("stage_target_selector_draft", input);
    expect(receipt).toMatchObject({ ok: false, durable_mutation: false, budget_consumed: false, error: "selector_draft_quote_bindings_invalid" });
    expect(receipt.selector_issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/quote_bindings/1" })]));
    expect(await snapshot(f.workspace)).toEqual(before);
  });

  test("ambiguous origin ownership does not choose a receiver or persist derived records", async () => {
    const f = await fixture(), before = await snapshot(f.workspace), input = f.request();
    input.reference_selections[0]!.bindings.push({ ...structuredClone(input.reference_selections[0]!.bindings[0]!), item_key: "terminal-appearance" });
    const receipt = await f.call("stage_target_selector_draft", input);
    expect(receipt).toMatchObject({ ok: false, durable_mutation: false, budget_consumed: false, error: "reference_selection_invalid" });
    expect(receipt.selector_issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "reference_field_selection_origin_binding_required", path: "/reference_selections/0/origin_binding",
    })]));
    expect(await snapshot(f.workspace)).toEqual(before);
  });

  test("repeating the same choice with its current fingerprint is idempotent", async () => {
    const f = await fixture(), first = await f.call("stage_target_selector_draft", f.request());
    expect(first.ok).toBe(true);
    const before = await snapshot(f.workspace);
    const repeated = await f.call("stage_target_selector_draft", { ...f.request(), draft_fingerprint: first.draft_fingerprint });
    expect(repeated).toMatchObject({ ok: true, unchanged: true, budget_consumed: false, mutation_receipt: { status: "saved" } });
    expect(repeated.reference_selection_projection.changed_paths).toEqual([]);
    expect(await snapshot(f.workspace)).toEqual(before);
  });

  test("a full-record fallback exposes executable reads and author paths without saving or spending counters", async () => {
    const f = await fixture();
    expect((await f.call("stage_target_selector_draft", f.request())).ok).toBe(true);
    const current = JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8")) as TargetSelectorPlan;
    current.references[0]!.destinations.push({ item_key: "indicator-error", target_field: "sampling" });
    // Neutral setup: a legacy reference that the shorthand cannot safely rewrite.
    await f.workspace.writeWorkingSelectors(prettyJson(current));
    const before = await snapshot(f.workspace);
    const receipt = await f.call("stage_target_selector_draft", { ...f.request(), draft_fingerprint: targetSelectorFingerprint(current) });
    expect(receipt).toMatchObject({ ok: false, terminal: false, durable_mutation: false, budget_consumed: false,
      error: "reference_selection_invalid", writable_paths: ["/references/0", "/items/0"],
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: current.references[0]!.key },
      selector_issues: [expect.objectContaining({ write_mode: "full_records", writable_paths: ["/references/0", "/items/0"],
        save_tool: "stage_target_selector_draft", record_reads: [
          { tool: "read_target_selectors", arguments: { collection: "references", key: current.references[0]!.key } },
          { tool: "read_target_selectors", arguments: { collection: "items", key: "indicator-error" } },
        ] })] });
    expect(receipt).not.toHaveProperty("writable_path");
    expect(receipt.instruction).toContain("draft.items/draft.references");
    for (const read of receipt.selector_issues[0].record_reads) expect((await f.call(read.tool, read.arguments)).ok).toBe(true);
    expect(await snapshot(f.workspace)).toEqual(before);
  });
});
