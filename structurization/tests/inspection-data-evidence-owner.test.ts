import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { prettyJson, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest, type PersistedSemanticSourcePlan } from "../src/contracts.js";
import { semanticItemIdForSelectorKey } from "../src/semantic-decision-compiler.js";
import { classifyStrictSelectorIssues, decideStrictSelectorPreflight } from "../src/selector-issue-ownership.js";
import { registryWithFullSourceSpans, type SourceSpanRegistry } from "../src/source-span-registry.js";
import { initialTargetSelectorPlan, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

function projection(type: "measurement" | "counting" | "mixed" | "review" = "review") {
  const target = "target:empty-classification-basis";
  const item = { key: "current", inspection_data_type: type, inspection_data_type_reason: "作者依据原文判断。", inspection_data_type_span_ids: [] };
  // Compiled order deliberately differs from selector order.
  const selectors = { target_id: target, items: [{ ...item, key: "other" }, item] } as unknown as TargetSelectorPlan;
  const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [{
    item_id: semanticItemIdForSelectorKey(target, item.key), inspection_data_type: type,
    inspection_data_type_reason: item.inspection_data_type_reason, inspection_data_type_evidence_ids: [],
  }] } as unknown as PersistedSemanticSourcePlan;
  const registry = { spans: [] } as unknown as SourceSpanRegistry;
  const issue = { code: "schema", path: "/acceptance_items/0/inspection_data_type_evidence_ids", message: "must NOT have fewer than 1 items", details: { required_action: "must NOT have fewer than 1 items", limit: 1 } };
  return { selectors, compiled, registry, issue };
}

describe("empty authored inspection-data evidence ownership", () => {
  it.each(["measurement", "counting", "mixed", "review"] as const)("returns %s to the exact author record without choosing evidence or a type", (type) => {
    const f = projection(type), before = structuredClone(f);
    const issues = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.issue]);
    expect(issues).toMatchObject([{ owner: "selector_input_error", path: "/items/1/inspection_data_type_span_ids", details: {
      compiled_path: f.issue.path, actual: { item_key: "current", inspection_data_type: type, inspection_data_type_span_ids: [], compiled_evidence_ids: [] },
      required_min_evidence_count: 1, writable_collections: ["items"],
      writable_paths: ["/items/1/inspection_data_type", "/items/1/inspection_data_type_reason", "/items/1/inspection_data_type_span_ids"],
      next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: "current" },
      next_tools: expect.arrayContaining(["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"]), save_tool: "stage_target_selector_draft",
    } }]);
    expect(decideStrictSelectorPreflight(issues)).toMatchObject({ selectorOwned: true, issueOwner: "selector_input_error" });
    expect(f).toEqual(before);
  });

  it.each(["lost-nonempty", "unknown-item", "changed-type", "changed-reason", "nonarray", "other-schema"])("keeps %s outside the author-empty exception", (caseName) => {
    const f = projection();
    if (caseName === "lost-nonempty") f.selectors.items[1]!.inspection_data_type_span_ids = ["span:authored"];
    if (caseName === "unknown-item") f.compiled.acceptance_items[0]!.item_id = "item:unknown";
    if (caseName === "changed-type") f.compiled.acceptance_items[0]!.inspection_data_type = "counting";
    if (caseName === "changed-reason") f.compiled.acceptance_items[0]!.inspection_data_type_reason = "Compiler changed it";
    if (caseName === "nonarray") delete (f.compiled.acceptance_items[0] as unknown as Record<string, unknown>).inspection_data_type_evidence_ids;
    if (caseName === "other-schema") f.issue.details.limit = 2;
    const issues = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.issue]);
    expect(issues[0]?.owner).toBe("compiler_invariant_violation");
    expect(decideStrictSelectorPreflight(issues).selectorOwned).toBe(false);
  });

  it("preserves a saved empty draft, returns a no-budget repair, and seals only after an explicit author binding", async () => {
    const text = "构件外观应完整。检验方法：观察检查。", evidenceId = "atom:neutral-component";
    const manifest: EvidenceManifest = {
      schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "neutral-classification-job", target_id: "neutral-component",
      source: { adapter: "document-domain-agent/v1", file_name: "source.md", sha256: sha256Text(text), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
      scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "neutral-component", source_line_count: 1,
        selected_start_line: 1, selected_end_exclusive_line: 2, selected_heading: "", selection_reason: "中性夹具", selected_atom_ids: [evidenceId],
        target_evidence_fragments: [{ atom_id: evidenceId, text }], candidates: [] },
      evidence: [{ evidence_id: evidenceId, kind: "paragraph", role: "supporting_clause", locator: "char:0-" + text.length, text, text_sha256: sha256Text(text),
        requires_disposition: true, evidence_scope: "primary" }], table_fragments: [], reference_occurrences: [], evidence_fingerprint: sha256Text("neutral-evidence"),
    };
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [{ source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text }]);
    const span = registry.spans[0]!.span_id, selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "component", name: "构件检验批", scope_span_ids: [span], reason: "中性范围" });
    const absent = { composition: "not_applicable" as const, span_ids: [], separator: "" as const, reason: "中性夹具未拆分此字段。" };
    selectors.items.push({ key: "appearance", lot_key: "component", name: "构件外观", category: "一般项目", criterion_span_ids: [span], continuation_span_ids: [],
      fields: { name: { composition: "semantic_summary", span_ids: [span], separator: "", reason: "被检对象" },
        requirement: { composition: "verbatim", span_ids: [span], separator: "", reason: "原文要求" }, method: { ...absent }, quantity: { ...absent }, note: { ...absent } },
      table: null, inspection_data_type: "review", inspection_data_type_reason: "作者核查原文并判断外观结果。", inspection_data_type_span_ids: [],
      sampling: { status: "fallback", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "原文未形成抽样数量", confidence: 1 }, reason: "独立判断" });
    const root = await mkdtemp(join(tmpdir(), "classification-owner-"));
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(text) });
    await workspace.updateState(state => { state.target_review_protocol = "direct-validation/v1"; });
    await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
    let controller = await ToolController.create(workspace);
    await controller.dispatch("open_evidence", { evidence_id: evidenceId });
    await controller.dispatch("stage_target_selector_draft", { draft: { lots: selectors.lots, items: selectors.items } });
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "sampling" })).toMatchObject({ ok: true });
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "table" })).toMatchObject({ ok: true });
    const before = await readFile(workspace.workingSelectorPath, "utf8"), stateBefore = await workspace.readState();
    const rejected = await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" });
    expect(rejected).toMatchObject({ ok: false, terminal: false, error: "selector_stage_incomplete", budget_consumed: false,
      selector_issues: [expect.objectContaining({ path: "/items/0/inspection_data_type_span_ids", owner: "selector_input_error" })] });
    expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
    expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
    controller = await ToolController.create(workspace);
    const read = await controller.dispatch("read_target_selectors", { collection: "items", key: "appearance" });
    const item = (read.rows as TargetSelectorPlan["items"])[0]!;
    expect(item.inspection_data_type_span_ids).toEqual([]);
    item.inspection_data_type_span_ids = [span];
    const saved = await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
    expect(saved).toMatchObject({ ok: true, local_validation: { ok: true } });
    expect(await controller.dispatch("advance_target_selector_stage", { next_stage: "commit" })).toMatchObject({ ok: true });
    const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: saved.draft_fingerprint });
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    expect(await controller.dispatch("seal_validated_plan", { fingerprint: committed.fingerprint })).toMatchObject({ ok: true, status: "passed" });
  }, 20_000);
});
