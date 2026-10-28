import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { initialTargetSelectorPlan, targetSelectorFingerprint } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const testRoot = resolve(".tmp-tests"), roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(testRoot + sep)) throw new Error("Unexpected fixture cleanup path");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function fixture() {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "literal-registration-")); roots.push(root);
  const rawReference = "本规程表7.6", originText = `4.1.1 遮光盒的搭扣应符合${rawReference}的规定。`;
  const markdown = ["# 4 虚构遮光盒", originText, "", "# 7 共用要求", "表7.6 搭扣要求",
    "<table><tr><td>项目</td><td>指标</td></tr><tr><td>搭扣锁合</td><td>锁合间隙不大于3格</td></tr></table>"].join("\n");
  const structured = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 1, end_exclusive_line: 3 }], false);
  const raw = { schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "neutral-literal-registration", target_id: "target:light-shield-latch",
    source: { adapter: "document-domain-agent/v1" as const, file_name: "fictional-light-shield.md", sha256: sha256Text(markdown), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered" as const, target_id: "target:light-shield-latch",
      source_line_count: 6, selected_start_line: 1, selected_end_exclusive_line: 3, selected_heading: "遮光盒",
      selection_reason: "中性引用登记事务", selected_atom_ids: structured.evidence.filter(e => e.evidence_scope === "primary").map(e => e.evidence_id),
      target_evidence_fragments: [], candidates: [] }, evidence: structured.evidence, table_fragments: structured.table_fragments,
    reference_occurrences: structured.reference_occurrences };
  const manifest: EvidenceManifest = { ...raw, evidence_fingerprint: sha256Json(raw) };
  const workspace = await RevisionWorkspace.createFromEvidence(root, raw.job_id, raw.target_id, { manifest, markdown: Buffer.from(markdown) });
  const controller = await ToolController.create(workspace), current = await workspace.readEvidenceManifest();
  const occurrence = current.reference_occurrences[0]!, registry = await workspace.readSourceSpanRegistry();
  const origin = current.evidence.find(e => e.text === originText)!;
  const originSpan = registry.spans.find(s => s.evidence_id === origin.evidence_id && s.start === 0 && s.end === originText.length)!;
  const row = current.evidence.find(e => e.text.includes("搭扣锁合") && e.text.includes("3格"))!;
  const targetSpan = registry.spans.find(s => s.evidence_id === row.evidence_id)!;
  const selectors = initialTargetSelectorPlan(current);
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const,
    span_ids, separator: "" as const, reason: span_ids.length ? "保留虚构来源" : "尚未选择该字段内容" });
  selectors.lots = [{ key: "light-shields", name: "遮光盒", scope_span_ids: [originSpan.span_id], reason: "原文验收范围" }];
  selectors.items = [{ key: "latch", lot_key: "light-shields", name: "搭扣锁合", category: "一般项目",
    criterion_span_ids: [originSpan.span_id], continuation_span_ids: [], table: null,
    fields: { name: { ...field([originSpan.span_id]), composition: "semantic_summary" }, requirement: field([]),
      method: field([]), quantity: field([]), note: field([originSpan.span_id]) },
    inspection_data_type: "review", inspection_data_type_reason: "中性事务验证", inspection_data_type_span_ids: [],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "本用例不决定抽样", confidence: 1 },
    reason: "既有作者项目" }];
  await workspace.writeWorkingSelectors(prettyJson(selectors));
  await workspace.updateState(state => { state.selector_stage = "primary"; state.target_review_protocol = "direct-validation/v1"; });
  expect(await controller.dispatch("open_evidence", { evidence_id: origin.evidence_id })).toMatchObject({ ok: true });
  const request = () => ({ draft_fingerprint: targetSelectorFingerprint(selectors), reference_selections: [{
    occurrence_id: occurrence.occurrence_id, action: "adopt", reason: "原文采用表格判据",
    bindings: [{ item_key: "latch", target_field: "requirement", target_span_ids: [targetSpan.span_id], component_decision: "same_judgment",
      local_context_fields: [{ field: "requirement", span_ids: [originSpan.span_id], reason: "保留原文采用表格的完整要求" }], reason: "选择搭扣锁合的完整指标" }],
  }] });
  return { workspace, controller, selectors, occurrence, rawReference, origin, originSpan, request };
}

async function snapshot(workspace: RevisionWorkspace) {
  const state = await workspace.readState();
  return { selectors: await readFile(workspace.workingSelectorPath, "utf8"), manifest: await workspace.readEvidenceManifest(),
    registry: await workspace.readSourceSpanRegistry(), history: await readdir(workspace.historyDirectory),
    counts: { validation_attempts: state.validation_attempts, next_history_sequence: state.next_history_sequence,
      next_validation_sequence: state.next_validation_sequence, selector_protocol: state.selector_protocol } };
}

describe("normal registration of an existing static literal", () => {
  test("ordinary locate is insufficient; resolve preserves identity and enables one atomic projection", async () => {
    const f = await fixture();
    expect(f.occurrence.reference_literal_span_id).toBeUndefined();
    expect(await f.controller.dispatch("locate_evidence_span", { evidence_id: f.origin.evidence_id, quote: f.rawReference })).toMatchObject({ ok: true });
    const before = await snapshot(f.workspace);
    const rejected = await f.controller.dispatch("stage_target_selector_draft", f.request());
    expect(rejected).toMatchObject({ ok: false, terminal: false, durable_mutation: false, next_tool: "resolve_document_reference" });
    expect(rejected.selector_issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "reference_field_selection_literal_required" })]));
    expect(await snapshot(f.workspace)).toEqual(before);
    const registered = await f.controller.dispatch("resolve_document_reference", { origin_span_id: f.originSpan.span_id,
      origin_field: "requirement", raw_reference: f.rawReference, target: { kind: "table", number: "7.6" }, relation: "原文明示搭扣质量要求" });
    expect(registered).toMatchObject({ ok: true, occurrence_id: f.occurrence.occurrence_id });
    const manifest = await f.workspace.readEvidenceManifest();
    expect(manifest.reference_occurrences).toHaveLength(1);
    expect(manifest.reference_occurrences[0]).toMatchObject({ occurrence_id: f.occurrence.occurrence_id,
      target_evidence_ids: f.occurrence.target_evidence_ids, reference_literal_span_id: expect.any(String) });
    const afterRegister = await snapshot(f.workspace);
    expect(afterRegister.counts).toEqual(before.counts);
    const saved = await f.controller.dispatch("stage_target_selector_draft", f.request());
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, mutation_receipt: { status: "saved", collections: [
      { collection: "items", submitted_keys: ["latch"] }, { collection: "references", submitted_keys: [expect.any(String)] },
    ] } });
    const after = await snapshot(f.workspace);
    expect(after.history.length).toBe(before.history.length + 1);
    expect(after.counts.next_history_sequence).toBe(before.counts.next_history_sequence + 1);
    expect(after.counts.validation_attempts).toBe(before.counts.validation_attempts);
    expect(JSON.parse(after.selectors).references[0].occurrence_id).toBe(f.occurrence.occurrence_id);
  });

  test("a frozen checkpoint rejects registration repair without changing saved data or counters", async () => {
    const f = await fixture();
    await f.workspace.updateState(state => { state.validation_attempts = 2; state.last_valid_fingerprint = "f".repeat(64); });
    const before = await snapshot(f.workspace);
    expect(await f.controller.dispatch("stage_target_selector_draft", f.request())).toMatchObject({ ok: false, terminal: true,
      error: "reference_registration_checkpoint_frozen", durable_mutation: false, budget_consumed: false });
    expect(await snapshot(f.workspace)).toEqual(before);
  });

  test("a saved diagnostic page becomes stale when the same author state can no longer register literals", async () => {
    const f = await fixture();
    await (f.controller as any).validateStagedSelectorRecords(f.selectors, ["/items/0"]);
    const before = await snapshot(f.workspace);
    const inputFingerprint = await (f.controller as any).stageDiagnosticInputsFingerprint();
    await f.workspace.updateState(state => { state.validation_attempts = 1; });
    expect(await (f.controller as any).stageDiagnosticInputsFingerprint()).not.toBe(inputFingerprint);
    const frozen = await snapshot(f.workspace);
    expect(frozen.selectors).toBe(before.selectors); expect(frozen.manifest).toEqual(before.manifest); expect(frozen.registry).toEqual(before.registry);
    expect(await f.controller.dispatch("get_target_context", { saved_diagnostic_scope: "local", saved_diagnostic_cursor: 0 })).toMatchObject({
      ok: false, error: "saved_selector_diagnostic_checkpoint_stale", full_stage_check_performed: false, budget_consumed: false,
      actual: { snapshot_present: true, matches_current_inputs: false },
    });
    expect(await snapshot(f.workspace)).toEqual(frozen);
  });
});
