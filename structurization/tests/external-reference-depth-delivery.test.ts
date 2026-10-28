import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { buildGranularProseCoverageEvidence } from "../src/evidence.js";
import { materialize } from "../src/materializer.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { compileTargetSelectors, initialTargetSelectorPlan, TargetSelectorCompileError } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

const parent = resolve(".tmp-tests");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(parent, "external-depth-delivery-"))) throw new Error("Unsafe test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

async function scenario() {
  const origin = "3.1.1 示例装置表面应完整，并应符合《一级测试标准》XQ 901-2001第2.1.1条的规定。";
  const nestedOrigin = "2.1.1 表面复核应符合《二级测试标准》XQ 902-2002第4.1.1条的规定。";
  const markdown = ["# 一级测试标准", "XQ 901-2001", nestedOrigin].join("\n");
  const records = buildGranularProseCoverageEvidence(origin, sha256Text(origin), [{ start_line: 1, end_exclusive_line: 2 }]);
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "external-depth-delivery", target_id: "target:surface",
    source: { adapter: "document-domain-agent/v1" as const, file_name: "synthetic.md", sha256: sha256Text(origin), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered" as const, target_id: "target:surface", source_line_count: 1,
      selected_start_line: 1, selected_end_exclusive_line: 2, selected_heading: "示例表面", selection_reason: "虚构二层引用交付回归",
      selected_atom_ids: records.map(record => record.evidence_id), target_evidence_fragments: records.map(record => ({ atom_id: record.evidence_id, text: record.text })), candidates: [] },
    evidence: records.map(record => ({ ...record, requires_disposition: true })), table_fragments: [], reference_occurrences: [],
  };
  const manifest: EvidenceManifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "external-depth-delivery-"));
  roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(origin) });
  const controller = await ToolController.create(workspace);
  const lookup = vi.fn(async (standardNo: string) => standardNo === "XQ 901-2001"
    ? { standard_no: standardNo, markdown, markdown_sha256: sha256Text(markdown) } : undefined);
  const require = vi.fn(async () => {});
  controller.externalSourceWorkflow = { lookup, require };
  const originSpanId = (await workspace.readSourceSpanRegistry()).spans[0]!.span_id;
  const first = await controller.dispatch("resolve_external_standard_reference", {
    origin_span_id: originSpanId, origin_field: "requirement", raw_reference: "《一级测试标准》XQ 901-2001第2.1.1条", standard_no: "XQ 901-2001",
    target: { kind: "clause", number: "2.1.1" }, relation: "表面复核要求", usage: "content_required", dependent_fields: ["requirement"], reason: "直接引用指定条款。",
  });
  expect(first).toMatchObject({ ok: true, content_available: true });
  const expanded = await workspace.readEvidenceManifest();
  const firstOccurrence = expanded.reference_occurrences.find(row => row.occurrence_id === first.occurrence_id)!;
  const nestedRecord = expanded.evidence.find(row => firstOccurrence.target_evidence_ids.includes(row.evidence_id) && row.text === nestedOrigin)!;
  expect(nestedRecord).toBeDefined();
  const nestedSpanId = (await workspace.readSourceSpanRegistry()).spans.find(span => span.evidence_id === nestedRecord.evidence_id && span.start === 0 && span.end === nestedOrigin.length)!.span_id;
  const nested = await controller.dispatch("resolve_external_standard_reference", {
    origin_span_id: nestedSpanId, origin_field: "requirement", raw_reference: "《二级测试标准》XQ 902-2002第4.1.1条", standard_no: "XQ 902-2002",
    target: { kind: "clause", number: "4.1.1" }, relation: "保留二层原文", usage: "content_required", dependent_fields: ["requirement"], reason: "一级条款继续引用另一标准。",
  });
  expect(nested).toMatchObject({ ok: true, status: "external_reference_placeholder", content_available: false,
    external_standard: { usage: "content_required", status: "placeholder", expansion: "literal_only", expansion_reason: "nested_source_unavailable" } });
  expect(lookup.mock.calls.map(call => call[0])).toEqual(["XQ 901-2001", "XQ 902-2002"]);
  expect(require).not.toHaveBeenCalled();
  const current = await workspace.readEvidenceManifest();
  const registry = await workspace.readSourceSpanRegistry();
  const selectors = initialTargetSelectorPlan(current);
  const field = (span_ids: string[]) => ({ composition: span_ids.length ? "verbatim" as const : "not_applicable" as const, span_ids, separator: "", reason: "逐字保留合成原文。" });
  selectors.lots.push({ key: "lot", name: "示例装置", scope_span_ids: [originSpanId], reason: "合成测试范围。" });
  selectors.items.push({ key: "surface", lot_key: "lot", name: "装置表面", category: "一般项目", criterion_span_ids: [originSpanId], continuation_span_ids: [nestedSpanId],
    fields: { name: { ...field([originSpanId]), composition: "semantic_summary" }, requirement: { ...field([originSpanId, nestedSpanId]), composition: "reference" }, method: field([]), quantity: field([]), note: field([]) },
    table: null, inspection_data_type: "review", inspection_data_type_reason: "合成核查项。", inspection_data_type_span_ids: [originSpanId],
    sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "合成例无抽样要求。", confidence: 1 }, reason: "保留直接要求和一级引用正文。" });
  for (const [index, receipt] of [first, nested].entries()) selectors.references.push({
    key: `reference-${index}`, occurrence_id: receipt.occurrence_id as string,
    anchor_span_ids: receipt.reference_literal_span_ids as string[], target_span_ids: index === 0 ? [nestedSpanId] : [],
    action: "keep_reference", application_mode: "reference_only", origin_binding: { item_key: "surface", target_field: "requirement" },
    import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "保持原文字段。" }, destinations: [{ item_key: "surface", target_field: "requirement" }],
    reason: index === 0 ? "展开直接引用。" : "下一层标准查本地后未找到，只保留引用原文，不声明取得其正文。",
  });
  return { current, registry, selectors, origin, nestedOrigin, nestedSpanId, nested, originSpanId, controller, workspace };
}

test("an unavailable nested content dependency delivers its exact original field and unverified literal-only provenance", async () => {
  const f = await scenario();
  const plan = hydrateSemanticSourcePlan(compileTargetSelectors(f.selectors, f.registry, f.current), f.current);
  expect(validatePlanText(prettyJson(plan), f.current)).toMatchObject({ ok: true, issues: [] });
  const item = materialize(plan, f.current, "synthetic-depth-policy").result.inspection_lots[0]!.items[0]!;
  const occurrence = f.current.reference_occurrences.find(reference => reference.occurrence_id === f.nested.occurrence_id)!;
  expect(item.requirement).toContain(f.origin);
  expect(item.requirement).toContain(f.nestedOrigin);
  expect(item.inline_references?.find(reference => reference.occurrence_id === f.nested.occurrence_id)).toMatchObject({
    field: "requirement", raw_reference: "《二级测试标准》XQ 902-2002第4.1.1条", origin_evidence_id: occurrence.origin_evidence_id,
    reference_literal_span_id: occurrence.reference_literal_span_id, reference_literal: occurrence.reference_literal, resolved_content: { records: [] },
    external_standard: { status: "placeholder", usage: "content_required", expansion: "literal_only", expansion_reason: "nested_source_unavailable" },
  });
});

test("the depth boundary does not authorize dropping the actual second-layer quotation", async () => {
  const f = await scenario();
  f.selectors.items[0]!.fields.requirement.span_ids = [f.originSpanId];
  let issues: Array<{ code: string }> = [];
  try { compileTargetSelectors(f.selectors, f.registry, f.current); }
  catch (error) { if (!(error instanceof TargetSelectorCompileError)) throw error; issues = error.issues; }
  expect(issues.map(issue => issue.code)).toContain("selector_continuation_not_merged");
});

test("the depth boundary cannot borrow another occurrence's evidence as verified second-layer content", async () => {
  const f = await scenario();
  const plan = hydrateSemanticSourcePlan(compileTargetSelectors(f.selectors, f.registry, f.current), f.current);
  const nestedResolution = plan.reference_resolutions.find(row => row.occurrence_id === f.nested.occurrence_id)!;
  nestedResolution.target_evidence_ids = [...plan.reference_resolutions.find(row => row.occurrence_id !== f.nested.occurrence_id)!.target_evidence_ids];
  const validation = validatePlanText(prettyJson(plan), f.current);
  expect(validation.ok).toBe(false);
  expect(validation.issues.map(issue => issue.code)).toContain("reference_target_outside_occurrence");
});

test.each(["missing_external_source", "ambiguous_source"])("the depth boundary cannot become a terminal %s blocker", async kind => {
  const f = await scenario();
  await f.workspace.writeWorkingSelectors(prettyJson(f.selectors));
  const before = await f.workspace.readState();
  const output = await f.controller.dispatch("report_target_blocker", { kind, evidence_span_ids: [f.nestedSpanId],
    affected_selector_paths: ["/items/0/fields/requirement"], explanation: "合成二层依赖未展开。" });
  expect(output).toMatchObject({ ok: false, terminal: false, budget_consumed: false,
    error: "external_reference_expansion_limited", next_tool: "read_target_selectors" });
  const after = await f.workspace.readState();
  expect(after.repair).toEqual(before.repair);
  expect(after.status).toBe(before.status);
  expect(JSON.parse(await readFile(f.workspace.workingSelectorPath, "utf8"))).toEqual(f.selectors);
});
