import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Check } from "typebox/value";
import { sha256Json, sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION } from "../src/contracts.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { ToolController, createPiTools } from "../src/tools.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(label = "一般项目") {
  const lines = ["# 1 通用检查", "1.0.1 本文件各装置的样本下限为7件，批量不足7件时全数检查。", "",
    "# 6 虚构湿度记录单元", "## 主控项目", "6.1.1 电源端子应连接牢固。", `## ${label}`,
    "6.1.2 外壳尺寸应符合表6.1.2。", "表6.1.2 外壳尺寸", '<table><tr><th>项目</th><th>要求</th></tr><tr><td>接缝宽度</td><td>不大于4mm</td></tr></table>'];
  const source = lines.join("\n"), structured = buildStructuredTargetEvidence(source, sha256Text(source), [{ start_line: 4, end_exclusive_line: 11 }], false);
  const raw = { schema_version: EVIDENCE_SCHEMA_VERSION, job_id: "neutral-search-heading", target_id: "target:neutral-search-heading",
    source: { adapter: "document-domain-agent/v1" as const, file_name: "neutral.md", sha256: sha256Text(source), semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
    scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered" as const, target_id: "target:neutral-search-heading",
      selected_heading: "虚构湿度记录单元", selection_reason: "仅确认本章范围，其他章节可作共同依据调查。", selected_atom_ids: structured.evidence.map(row => row.evidence_id), candidates: [] },
    evidence: structured.evidence, table_fragments: structured.table_fragments, reference_occurrences: structured.reference_occurrences };
  const manifest = { ...raw, evidence_fingerprint: sha256Json(raw) };
  const root = await mkdtemp(join(tmpdir(), "neutral-search-heading-")); roots.push(root);
  const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(source) });
  return { workspace, manifest, controller: await ToolController.create(workspace) };
}

test("single and batch searches share ranked alternative terms and explicit target scope", async () => {
  const { controller } = await fixture();
  const single = await controller.dispatch("search_evidence", { query: "外壳 不存在词" }) as any;
  expect(single).toMatchObject({ search_scope: "registered_target_evidence", search_mode: "space_separated_terms_any_ranked", query_terms: ["外壳", "不存在词"], unresolved: false });
  expect(single.matches.length).toBeGreaterThan(0);
  expect(single.matches.every((row: any) => row.matched_terms.includes("外壳"))).toBe(true);
  const batch = await controller.dispatch("batch_search_evidence", { queries: ["外壳 不存在词", "样本 下限"] }) as any;
  expect(batch.results[0].matches).toEqual(single.matches.slice(0, 20));
  expect(batch.results[1]).toMatchObject({ search_scope: "registered_target_evidence", matches: [],
    next_tool: "search_global_document_resources", next_tool_arguments: { query: "样本 下限" } });
});

test("empty target search routes to full text, then actual common-rule source, without changing the author or validation counters", async () => {
  const { controller, workspace } = await fixture();
  const before = await workspace.readState(), draft = await readFile(workspace.workingSelectorPath, "utf8");
  const local = await controller.dispatch("search_evidence", { query: "样本 下限" }) as any;
  expect(local).toMatchObject({ matches: [], empty_result_meaning: "no_lexical_hit_in_this_scope_not_absence_of_applicable_rules" });
  expect(Check(createPiTools(controller).find(t => t.name === local.next_tool)!.parameters, local.next_tool_arguments)).toBe(true);
  const global = await controller.dispatch(local.next_tool, local.next_tool_arguments) as any;
  expect(global).toMatchObject({ search_scope: "directly_readable_full_document", search_mode: local.search_mode, unresolved: false });
  const match = global.matches.find((row: any) => row.preview.includes("样本下限为7件"));
  expect(match).toBeDefined();
  const body = await controller.dispatch(match.read_tool, match.tool_arguments);
  expect(JSON.stringify(body)).toContain("批量不足7件时全数检查");
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  const after = await workspace.readState();
  expect(after.selector_protocol).toEqual(before.selector_protocol);
  expect(after.validation_attempts).toBe(before.validation_attempts);
  expect(after.next_history_sequence).toBe(before.next_history_sequence);
});

test("full-text empty results route to a valid unfiltered directory instead of repeating the same search", async () => {
  const { controller } = await fixture();
  const empty = await controller.dispatch("search_global_document_resources", { query: "中性不存在词ZZZ" }) as any;
  expect(empty).toMatchObject({ matches: [], unresolved: true, next_tool: "list_global_document_resources", next_tool_arguments: { cursor: 0, limit: 20 } });
  expect(Check(createPiTools(controller).find(t => t.name === empty.next_tool)!.parameters, empty.next_tool_arguments)).toBe(true);
  expect(await controller.dispatch(empty.next_tool, empty.next_tool_arguments)).toMatchObject({ ok: true });
});

test("a one-character unmatched query returns a legal directory route rather than an invalid full-text search", async () => {
  const { controller } = await fixture();
  const empty = await controller.dispatch("search_evidence", { query: "铍" }) as any;
  expect(empty).toMatchObject({ matches: [], next_tool: "list_global_document_resources" });
  expect(Check(createPiTools(controller).find(t => t.name === empty.next_tool)!.parameters, empty.next_tool_arguments)).toBe(true);
});

test.each(["read_table_rows", "batch_open_evidence", "read_document_reference_evidence"])("%s carries the same row-to-heading original-source association", async tool => {
  const { controller, manifest } = await fixture();
  const row = manifest.evidence.find(e => e.kind === "table_row" && e.table_row_kind === "data")!;
  const args = tool === "read_table_rows" ? { table_key: manifest.table_fragments[0]!.fragment_id }
    : tool === "batch_open_evidence" ? { evidence_ids: [row.evidence_id] }
      : { target_key: documentReferenceTargetReadIdentity(manifest.reference_occurrences[0]!).target_key };
  const response = await controller.dispatch(tool, args) as any;
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true, table_heading_context: {
    headings: expect.arrayContaining([expect.objectContaining({ text: "## 一般项目" })]),
    rows: expect.arrayContaining([expect.objectContaining({ evidence_id: row.evidence_id })]), category_assigned: false } });
});

test.each(["一般项目", "主控项目", "观察组"])("table rows carry original preceding heading %s without choosing a category", async label => {
  const { controller, workspace, manifest } = await fixture(label);
  const row = manifest.evidence.find(e => e.kind === "table_row" && e.table_row_kind === "data")!;
  const heading = manifest.evidence.find(e => e.kind === "heading" && e.locator === "line:7")!;
  const draft = await readFile(workspace.workingSelectorPath, "utf8");
  const result = await controller.dispatch("open_evidence", { evidence_id: row.evidence_id }) as any;
  expect(result.table_heading_context).toMatchObject({ decision_owner: "model", category_assigned: false,
    headings: expect.arrayContaining([expect.objectContaining({ evidence_id: heading.evidence_id, locator: "line:7", text: `## ${label}` })]),
    rows: expect.arrayContaining([expect.objectContaining({ evidence_id: row.evidence_id, heading_evidence_ids: expect.arrayContaining([heading.evidence_id]) })]) });
  expect(result.table_heading_context.headings).not.toContainEqual(expect.objectContaining({ category: expect.any(String) }));
  expect((await workspace.readState()).opened_evidence_ids).toContain(heading.evidence_id);
  expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draft);
  const handles = await ModelSourceHandles.open(workspace.root);
  const encoded = await handles.encode(result) as any;
  expect(encoded.table_heading_context.headings.find((h: any) => h.text === `## ${label}`).evidence_id).toMatch(/^e\d+$/u);
});

test("table context does not expose an isolated heading or mark it read", async () => {
  const { controller, workspace, manifest } = await fixture("仅隔离可见标题");
  const row = manifest.evidence.find(e => e.kind === "table_row" && e.table_row_kind === "data")!;
  const heading = manifest.evidence.find(e => e.locator === "line:7")!;
  vi.spyOn(controller as any, "evidenceAccessIndex").mockResolvedValue(new Map([[heading.evidence_id,
    { access_mode: "isolated_reference", read_tool: "read_reference_facts", target_key: "isolated-neutral", open_evidence_allowed: false }]]));
  const result = await controller.dispatch("open_evidence", { evidence_id: row.evidence_id });
  expect(JSON.stringify(result)).not.toContain("仅隔离可见标题");
  expect((await workspace.readState()).opened_evidence_ids).not.toContain(heading.evidence_id);
});
