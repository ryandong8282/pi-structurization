import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { selectorDispositionCoverage } from "../src/evidence-disposition-coverage.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { registryWithFullSourceSpans, tableEvidenceTextFormat } from "../src/source-span-registry.js";
import { initialTableStructurePlan, validateTableStructurePlan } from "../src/table-structure.js";
import { compileTargetSelectors, TargetSelectorCompileError, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

const markdown = `表 9.2.7 预制构件尺寸允许偏差及检验方法
<table><tr><td rowspan="2">项目</td><td colspan="2">允许偏差(mm)</td><td rowspan="2">检验方法</td></tr><tr><td>构件</td><td>数值</td></tr><tr><td>长度</td><td>墙板</td><td>±4</td><td>尺量</td></tr></table>
续表 9.2.7
<table><tr><td>项目</td><td>部位</td><td>允许偏差(mm)</td><td>检验方法</td></tr><tr><td>表面平整度</td><td>墙板外表面</td><td>3</td><td>2m靠尺和塞尺量测</td></tr></table>`;
const sourceSha = sha256Text(markdown);
const structured = buildStructuredTargetEvidence(markdown, sourceSha, [{ start_line: 1, end_exclusive_line: 5 }], false);
const manifest: EvidenceManifest = {
  schema_version: EVIDENCE_SCHEMA_VERSION,
  job_id: "verify-table-structure",
  target_id: "target:9.2.7",
  source: { adapter: "document-domain-agent/v1", file_name: "verify.md", sha256: sourceSha, semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION },
  scope: { schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION, mode: "agent_discovered", target_id: "target:9.2.7", source_line_count: 5, selected_start_line: 1, selected_end_exclusive_line: 5, selected_heading: "表9.2.7", selection_reason: "offline contract check", selected_atom_ids: [], target_evidence_fragments: [], candidates: [] },
  evidence: structured.evidence,
  table_fragments: structured.table_fragments,
  reference_occurrences: [],
  evidence_fingerprint: sha256Text(`verify\0${sourceSha}`),
};
const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((record) => ({ source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text })));
const header = manifest.evidence.find((record) => record.role === "formal_table_header")!;
assert.equal(header.text, header.cells!.join(" | "));
assert.equal(header.text.includes("数据行"), false);
assert.equal(tableEvidenceTextFormat(header), "cell_values_v1");
assert.equal(manifest.evidence.filter((record) => record.role === "formal_table_title").length, 1);
assert.equal(manifest.evidence.filter((record) => record.role === "table_continuation_caption").length, 1);
const structure = initialTableStructurePlan(manifest, registry);
const table = structure.tables[0]!;
const headers = manifest.evidence.filter((record) => record.role === "formal_table_header").map((record) => record.evidence_id);
const nestedHeader = manifest.evidence.find((record) => record.table_row_kind === "data" && record.text === "项目 | 构件 | 数值 | 检验方法")!;
table.status = "confirmed";
table.header_rows = [...headers.slice(0, 1), nestedHeader.evidence_id];
table.repeated_header_rows = headers.slice(1);
table.data_rows = manifest.evidence.filter((record) => record.table_row_kind === "data" && record.evidence_id !== nestedHeader.evidence_id).map((record) => record.evidence_id);
table.review_rows = [];
table.row_role_overrides = [{ row_id: nestedHeader.evidence_id, program_hint: "data_candidate", selected_role: "header", reason: "merged two-level header" }];
table.reason = "offline confirmed from caption, merged cells, repeated header and continuation marker";
assert.deepEqual(validateTableStructurePlan(structure, manifest, registry), []);
const toolRoot = await mkdtemp(join(tmpdir(), "verify-table-structure-tools-"));
let toolSummary: Record<string, unknown> = {};
try {
  const workspace = await RevisionWorkspace.createFromEvidence(toolRoot, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
  const controller = await ToolController.create(workspace);
  const summary = await controller.dispatch("read_table_summary", { table_key: "9.2.7" });
  const rows = await controller.dispatch("read_table_rows", { table_key: "9.2.7", cursor: 0, limit: 20 });
  const staged = await controller.dispatch("stage_table_structure", { table });
  const reopened = await ToolController.create(workspace);
  const saved = await reopened.dispatch("read_saved_table_structure", {});
  assert.equal(summary.ok, true);
  assert.equal(rows.ok, true);
  assert.equal((rows.rows as unknown[]).length, table.header_rows.length + table.repeated_header_rows.length + table.data_rows.length);
  assert.equal(staged.draft_status, "saved_structure_validation_passed");
  assert.equal((saved.structure as { tables: Array<{ status: string }> }).tables[0]!.status, "confirmed");
  toolSummary = { summary: summary.ok, rows: (rows.rows as unknown[]).length, stage: staged.draft_status, resumed: true };
} finally {
  await rm(toolRoot, { recursive: true, force: true });
}

const liveRoot = resolve("data/jobs/20260907-094050-gb50204-selfreview-luna-medium/pi-agent/jobs/20260907-094050-gb50204-selfreview-luna-medium/targets/target_3Ad107f9a59ae6b0d9d9dd1d13/revisions/000006");
let liveSummary: Record<string, unknown> = { available: false };
if (existsSync(join(liveRoot, "evidence/evidence.json"))) {
  const liveManifest = JSON.parse(await readFile(join(liveRoot, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
  const liveRegistry = JSON.parse(await readFile(join(liveRoot, "source-span-registry.json"), "utf8"));
  const liveSelectors = JSON.parse(await readFile(join(liveRoot, "working.target-selectors.json"), "utf8")) as TargetSelectorPlan;
  const liveHeader = liveManifest.evidence.find((record) => record.table_id === "9.2.7" && record.role === "formal_table_header")!;
  assert.equal(tableEvidenceTextFormat(liveHeader), "legacy_navigation_mixed_v0");
  const liveHeaderSpan = liveRegistry.spans.find((span: { evidence_id: string; start: number; end: number }) => span.evidence_id === liveHeader.evidence_id && span.start === 0 && span.end === liveHeader.text.length)!.span_id;
  const suffixes = ["warpage", "diagonal", "reserved-hole", "reserved-opening", "embedded-parts", "reserved-rebar", "keyway"];
  const contaminated = structuredClone(liveSelectors);
  const affected = contaminated.items.filter((item) => suffixes.some((suffix) => item.key.endsWith(`:${suffix}`)));
  affected.forEach((item) => { item.table!.properties.table_title_span_ids = [liveHeaderSpan]; });
  let groupedTitleIssues = 0;
  try {
    compileTargetSelectors(contaminated, liveRegistry, liveManifest);
  } catch (error) {
    assert.ok(error instanceof TargetSelectorCompileError);
    groupedTitleIssues = error.issues.filter((issue) => issue.code === "selector_table_title_role_invalid").length;
  }
  assert.equal(affected.length, 7);
  assert.equal(groupedTitleIssues, 1);
  const cleaned = structuredClone(liveSelectors);
  cleaned.items.filter((item) => item.table?.table_key === "9.2.7").forEach((item) => { item.table!.properties.table_title_span_ids = []; });
  const coverage = selectorDispositionCoverage({ selectors: cleaned, evidence: liveManifest.evidence, spans: liveRegistry.spans });
  assert.ok(coverage.bound_evidence_ids.includes(liveHeader.evidence_id));
  assert.ok(!coverage.uncovered_required_ids.includes(liveHeader.evidence_id));
  const legacyToolRoot = await mkdtemp(join(tmpdir(), "verify-legacy-table-tools-"));
  let legacyChunkExposed = true;
  try {
    const source = await readFile(join(liveRoot, "evidence/source.md"));
    const workspace = await RevisionWorkspace.createFromEvidence(legacyToolRoot, liveManifest.job_id, liveManifest.target_id, { manifest: liveManifest, markdown: source });
    const controller = await ToolController.create(workspace);
    const opened = await controller.dispatch("open_evidence", { evidence_id: liveHeader.evidence_id });
    legacyChunkExposed = Object.hasOwn(opened, "chunk_span");
    assert.equal(legacyChunkExposed, false);
    assert.equal((opened.resource as { table_text_format: string }).table_text_format, "legacy_navigation_mixed_v0");
  } finally {
    await rm(legacyToolRoot, { recursive: true, force: true });
  }
  const liveStructure = initialTableStructurePlan(liveManifest, liveRegistry);
  const liveTable = liveStructure.tables.find((entry) => entry.table_key === "9.2.7")!;
  const liveRows = liveManifest.evidence.filter((record) => liveTable.fragment_ids.includes(record.table_fragment_id ?? "") && record.kind === "table_row");
  const liveHeaders = liveRows.filter((record) => record.table_row_kind === "header").map((record) => record.evidence_id);
  liveTable.status = "confirmed";
  liveTable.header_rows = liveHeaders.slice(0, 1);
  liveTable.repeated_header_rows = liveHeaders.slice(1);
  liveTable.data_rows = liveRows.filter((record) => record.table_row_kind === "data").map((record) => record.evidence_id);
  liveTable.review_rows = [];
  liveTable.reason = "offline GB50204 9.2f snapshot confirmation";
  assert.equal(liveTable.data_rows.length, 29);
  assert.deepEqual(validateTableStructurePlan(liveStructure, liveManifest, liveRegistry), []);
  liveSummary = { available: true, affected_items: affected.length, grouped_title_issues: groupedTitleIssues, data_rows: liveTable.data_rows.length, header_unhandled: coverage.uncovered_required_ids.includes(liveHeader.evidence_id), legacy_chunk_exposed: legacyChunkExposed };
}

console.log(JSON.stringify({ generated_contract: { fragments: manifest.table_fragments.length, headers: headers.length, data_rows: table.data_rows.length, issues: 0 }, typed_tools: toolSummary, live_9_2_7: liveSummary }, null, 2));
