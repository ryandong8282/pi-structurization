import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import {
  renderedTableCellSpans,
  registryWithFullSourceSpans,
  tableEvidenceTextFormat,
} from "../src/source-span-registry.js";
import {
  initialTableStructurePlan,
  pendingComplexTableStructureIssues,
  tableStructureProgress,
  validateTableStructurePlan,
} from "../src/table-structure.js";
import { ToolController } from "../src/tools.js";
import { tableExpansionState } from "../src/target-selector-compiler.js";
import { RevisionWorkspace } from "../src/workspace.js";

const MARKDOWN = `
9.2.7 预制构件尺寸偏差及检验方法应符合表 9.2.7 的规定。

表 9.2.7 预制构件尺寸允许偏差及检验方法

<table><tr><td rowspan="2">项目</td><td colspan="2">允许偏差(mm)</td><td rowspan="2">检验方法</td></tr><tr><td>构件</td><td>数值</td></tr><tr><td>长度</td><td>墙板</td><td>±4</td><td>尺量</td></tr><tr><td>宽度、高(厚)度</td><td>墙板</td><td>±4</td><td>尺量</td></tr></table>

续表 9.2.7

<table><tr><td>项目</td><td>部位</td><td>允许偏差(mm)</td><td>检验方法</td></tr><tr><td>表面平整度</td><td>墙板外表面</td><td>3</td><td>2m靠尺和塞尺量测</td></tr></table>

注：L 为构件长度。
`.trim();

function fixture(): { manifest: EvidenceManifest; registry: ReturnType<typeof registryWithFullSourceSpans> } {
  const sourceSha = sha256Text(MARKDOWN);
  const structured = buildStructuredTargetEvidence(
    MARKDOWN,
    sourceSha,
    [{ start_line: 1, end_exclusive_line: MARKDOWN.split("\n").length + 1 }],
    false,
  );
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "table-structure-contract",
    target_id: "target:9.2.7",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "9.2.7.md",
      sha256: sourceSha,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:9.2.7",
      source_line_count: MARKDOWN.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: MARKDOWN.split("\n").length + 1,
      selected_heading: "表 9.2.7",
      selection_reason: "结构契约回归",
      selected_atom_ids: [],
      target_evidence_fragments: [],
      candidates: [],
    },
    evidence: structured.evidence,
    table_fragments: structured.table_fragments,
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`table-structure\0${sourceSha}`),
  };
  return {
    manifest,
    registry: registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    ),
  };
}

describe("agentic table structure contract", () => {
  test.each(["header_rows", "data_rows", "repeated_header_rows", "note_rows", "context_rows", "review_rows"] as const)(
    "foreign sources in %s receive a removal route, not a different row role",
    (field) => {
      const { manifest, registry } = fixture();
      const plan = initialTableStructurePlan(manifest, registry);
      const table = plan.tables[0]!;
      const note = manifest.evidence.find((record) => record.role === "table_note")!;
      const noteSpan = registry.spans.find((span) => span.evidence_id === note.evidence_id)!;
      table.note_span_ids = [noteSpan.span_id];
      table[field].push(note.evidence_id);
      const issue = validateTableStructurePlan(plan, manifest, registry)
        .find((entry) => entry.code === "table_structure_row_partition_invalid")!;
      expect(issue).toMatchObject({ details: {
        table_key: table.table_key,
        actual: { missing_rows: [], duplicate_rows: [], foreign_rows: [note.evidence_id] },
        next_tool: "read_table_summary",
        next_tool_arguments: { table_key: table.table_key },
        save_tool: "stage_table_structure",
        tool_writable_path: "table",
        readable_rows: [expect.objectContaining({ row_id: note.evidence_id, role: "table_note" })],
        do_not_edit: expect.any(String),
      } });
      expect(issue.details?.how_to_pass).toContain("foreign_rows");
      expect(issue.details?.how_to_pass).toContain("移除");
      expect(issue.details?.how_to_pass).toContain("note_span_ids");
      expect(issue.details?.how_to_pass).not.toContain("放入 review_rows");

      // Remove only the mistaken row assignment; the source and note span remain.
      table[field] = table[field].filter((id) => id !== note.evidence_id);
      expect(validateTableStructurePlan(plan, manifest, registry)
        .filter((entry) => entry.code === "table_structure_row_partition_invalid")).toEqual([]);
      expect(table.note_span_ids).toEqual([noteSpan.span_id]);
      expect(manifest.evidence).toContain(note);
    },
  );

  test("missing and duplicate rows retain distinct repair conditions", () => {
    const { manifest, registry } = fixture();
    const plan = initialTableStructurePlan(manifest, registry);
    const table = plan.tables[0]!;
    const missing = table.review_rows.shift()!;
    const duplicate = table.review_rows[0]!;
    table.context_rows.push(duplicate);
    const issue = validateTableStructurePlan(plan, manifest, registry)
      .find((entry) => entry.code === "table_structure_row_partition_invalid")!;
    expect(issue).toMatchObject({ details: { actual: {
      missing_rows: [missing],
      duplicate_rows: [{ row_id: duplicate, roles: ["context", "review"] }],
      foreign_rows: [],
    } } });
    expect(issue.details?.how_to_pass).toContain("missing_rows");
    expect(issue.details?.how_to_pass).toContain("duplicate_rows");
    expect(issue.details?.how_to_pass).toContain("放入 review_rows");
    expect(issue.details?.how_to_pass).not.toContain("foreign_rows");
    table.review_rows.push(missing);
    table.context_rows = [];
    expect(validateTableStructurePlan(plan, manifest, registry)
      .filter((entry) => entry.code === "table_structure_row_partition_invalid")).toEqual([]);
  });

  test("version errors identify the stable table key independently of array order", () => {
    const { manifest, registry } = fixture();
    const plan = initialTableStructurePlan(manifest, registry);
    const first = { ...structuredClone(plan.tables[0]!), table_key: "table:components" };
    const broken = { ...structuredClone(first), table_key: "table:connections", source_version: "mistyped-version" };
    for (const tables of [[first, broken], [broken, first]]) {
      const issue = validateTableStructurePlan({ ...plan, tables }, manifest, registry)
        .find((entry) => entry.code === "table_structure_table_source_version_mismatch");
      expect(issue).toMatchObject({
        details: {
          table_key: broken.table_key,
          actual: "mistyped-version",
          expected: manifest.source.sha256,
          next_tool: "read_table_summary",
          next_tool_arguments: { table_key: broken.table_key },
          save_tool: "stage_table_structure",
          writable_path: `/tables/${tables.indexOf(broken)}/source_version`,
          tool_writable_path: "table.source_version",
          do_not_edit: expect.any(String),
        },
      });
    }
  });

  test("decodes short evidence handles in every typed row-role array", async () => {
    const root = await mkdtemp(join(tmpdir(), "table-structure-handles-"));
    try {
      const codec = await ModelSourceHandles.open(root);
      const canonical = "evidence:row-role-source";
      const encoded = await codec.encode({
        row_id: canonical,
        header_rows: [canonical],
        data_rows: [canonical],
        repeated_header_rows: [canonical],
        note_rows: [canonical],
        context_rows: [canonical],
        review_rows: [canonical],
        row_role_overrides: [{ row_id: canonical, program_hint: "data_candidate", selected_role: "header", reason: "多层表头" }],
      }) as Record<string, unknown>;
      expect(encoded).toMatchObject({ row_id: "e1", header_rows: ["e1"], data_rows: ["e1"], review_rows: ["e1"] });
      expect(await codec.decodeArguments({ ...encoded, source_handle_scope: codec.scope })).toMatchObject({
        row_id: canonical,
        header_rows: [canonical],
        data_rows: [canonical],
        repeated_header_rows: [canonical],
        note_rows: [canonical],
        context_rows: [canonical],
        review_rows: [canonical],
        row_role_overrides: [{ row_id: canonical, program_hint: "data_candidate", selected_role: "header", reason: "多层表头" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("separates title/navigation metadata from bindable header and data text", () => {
    const { manifest } = fixture();
    const title = manifest.evidence.find((record) => record.role === "formal_table_title")!;
    const continuation = manifest.evidence.find((record) => record.role === "table_continuation_caption")!;
    const header = manifest.evidence.find((record) => record.role === "formal_table_header")!;
    const data = manifest.evidence.find((record) => record.table_row_kind === "data")!;

    expect(title.text).toBe("表 9.2.7 预制构件尺寸允许偏差及检验方法");
    expect(continuation.text).toBe("续表 9.2.7");
    expect(header.text).toBe(header.cells!.join(" | "));
    expect(header.text).not.toContain("数据行");
    expect(header.text).not.toContain(title.text);
    expect(data.text).toBe(data.cells!.join(" | "));
    expect(data.text).not.toMatch(/项目=/u);
    expect(header.table_text_format).toBe("cell_values_v1");
    expect(header.requires_disposition).toBe(false);
    expect(header.cell_geometry).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "项目", rowspan: 2, colspan: 1 }),
      expect.objectContaining({ text: "允许偏差(mm)", rowspan: 1, colspan: 2 }),
    ]));
    expect(manifest.table_fragments[0]!.title_candidate_evidence_ids).toContain(title.evidence_id);
    expect(manifest.table_fragments[1]!.title_candidate_evidence_ids).not.toContain(continuation.evidence_id);
    expect(manifest.table_fragments[1]!.continuation_caption_evidence_ids).toContain(continuation.evidence_id);
  });

  test("recognizes historical mixed rows explicitly without trusting the whole chunk", () => {
    const title = "表 9.2.7 预制构件尺寸允许偏差及检验方法";
    const legacy = {
      kind: "table_row",
      text: `${title} | 数据行 1 | 项目=项目 | 允许偏差(mm)=允许偏差(mm)`,
      table_title: title,
      row_index: 1,
      columns: ["项目", "允许偏差(mm)"],
      cells: ["项目", "允许偏差(mm)"],
    };
    expect(tableEvidenceTextFormat(legacy)).toBe("legacy_navigation_mixed_v0");
    expect(renderedTableCellSpans(legacy).map((cell) => cell.text)).toEqual(legacy.cells);
  });

  test("persists one reviewable logical-table decision and resumes confirmed fragments", async () => {
    const { manifest, registry } = fixture();
    const plan = initialTableStructurePlan(manifest, registry);
    expect(plan.tables).toHaveLength(1);
    const table = plan.tables[0]!;
    expect(table).toMatchObject({
      table_key: "9.2.7",
      status: "review",
      fragment_ids: expect.arrayContaining(manifest.table_fragments.map((fragment) => fragment.fragment_id)),
      formal_title_span_ids: [expect.any(String)],
      continuation_caption_span_ids: [expect.any(String)],
    });
    expect(pendingComplexTableStructureIssues(plan, manifest)).toEqual([
      expect.objectContaining({ code: "table_structure_confirmation_pending", path: "/table_structure/tables/0/status" }),
    ]);
    const invalidTitlePlan = structuredClone(plan);
    const headerEvidence = manifest.evidence.find((record) => record.role === "formal_table_header")!;
    invalidTitlePlan.tables[0]!.formal_title_span_ids = [registry.spans.find((span) =>
      span.evidence_id === headerEvidence.evidence_id
      && span.start === 0
      && span.end === headerEvidence.text.length
    )!.span_id];
    expect(validateTableStructurePlan(invalidTitlePlan, manifest, registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "table_structure_formal_title_invalid",
        details: expect.objectContaining({
          next_tool: "read_table_summary",
          next_tool_arguments: { table_key: "9.2.7" },
          next_tools: ["read_table_summary", "stage_table_structure"],
          save_tool: "stage_table_structure",
        }),
      }),
    ]));
    const headerIds = manifest.evidence.filter((record) => record.role === "formal_table_header").map((record) => record.evidence_id);
    const nestedHeader = manifest.evidence.find((record) =>
      record.table_row_kind === "data" && record.text === "项目 | 构件 | 数值 | 检验方法"
    )!;
    const dataIds = manifest.evidence.filter((record) =>
      record.table_row_kind === "data" && record.evidence_id !== nestedHeader.evidence_id
    ).map((record) => record.evidence_id);
    expect(tableStructureProgress(plan, manifest, registry).confirmed_keys).toEqual([]);
    table.status = "confirmed";
    table.header_rows = [...headerIds.slice(0, 1), nestedHeader.evidence_id];
    table.repeated_header_rows = headerIds.slice(1);
    table.data_rows = dataIds;
    table.review_rows = [];
    table.row_role_overrides = [{
      row_id: nestedHeader.evidence_id,
      program_hint: "data_candidate",
      selected_role: "header",
      reason: "第一物理表使用两层表头；该行与上方 rowspan/colspan 共同组成列路径。",
    }];
    table.reason = "根据正式题注、两段物理表的重复列名、rowspan/colspan 和续表标记确认。";
    expect(validateTableStructurePlan(plan, manifest, registry)).toEqual([]);
    const structureProgress = tableStructureProgress(plan, manifest, registry);
    expect(structureProgress.confirmed_keys).toEqual(["9.2.7"]);
    expect(structureProgress.fingerprint).not.toBe("");
    const explanationOnly = structuredClone(plan);
    explanationOnly.tables[0]!.reason = "换一种表述不改变已确认结构。";
    explanationOnly.tables[0]!.row_role_overrides[0]!.reason = "同一行角色的另一解释。";
    explanationOnly.tables[0]!.data_rows.reverse();
    expect(tableStructureProgress(explanationOnly, manifest, registry)).toEqual(structureProgress);
    const invalidProgress = structuredClone(plan);
    invalidProgress.tables[0]!.data_rows.push("foreign-neutral-row");
    expect(tableStructureProgress(invalidProgress, manifest, registry).fingerprint).toBe("");
    const overlappingProgress = structuredClone(plan);
    overlappingProgress.tables.push({ ...structuredClone(table), table_key: "different-neutral-key" });
    expect(tableStructureProgress(overlappingProgress, manifest, registry).fingerprint).toBe("");
    expect(validateTableStructurePlan(plan, { ...manifest, evidence_fingerprint: "reference-expanded-manifest" }, registry)).toEqual([]);
    const silentHeaderToData = structuredClone(plan);
    const repeatedHeader = silentHeaderToData.tables[0]!.repeated_header_rows[0]!;
    silentHeaderToData.tables[0]!.repeated_header_rows = [];
    silentHeaderToData.tables[0]!.data_rows.push(repeatedHeader);
    expect(validateTableStructurePlan(silentHeaderToData, manifest, registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "table_structure_program_hint_override_required",
        details: expect.objectContaining({
          actual: [expect.objectContaining({ row_id: repeatedHeader, program_hint: "header_candidate", selected_role: "data" })],
        }),
      }),
    ]));
    expect(pendingComplexTableStructureIssues(plan, manifest)).toEqual([]);
    const eligibleEvidenceIds = new Set(dataIds);
    const expansion = tableExpansionState(manifest, registry, undefined, plan, eligibleEvidenceIds);
    expect(expansion.work_packages[0]!.rows.map((row) => row.evidence_id)).toEqual(dataIds);
    expect(expansion.work_packages[0]!.rows.map((row) => row.parent_property)).not.toContain("项目");
    const reboundExpansion = tableExpansionState(
      { ...manifest, evidence_fingerprint: "isolated-hidden-evidence-change" },
      registry,
      undefined,
      plan,
      eligibleEvidenceIds,
    );
    expect(reboundExpansion.work_packages.map((entry) => entry.obligation_id))
      .toEqual(expansion.work_packages.map((entry) => entry.obligation_id));

    const root = await mkdtemp(join(tmpdir(), "table-structure-tools-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(MARKDOWN) },
      );
      const controller = await ToolController.create(workspace);
      await workspace.updateState((state) => { state.selector_stage = "table"; });
      const tableStageController = await ToolController.create(workspace);
      expect(await tableStageController.dispatch("advance_target_selector_stage", { next_stage: "commit" })).toMatchObject({
        ok: false,
        error: "selector_stage_incomplete",
        selector_issues: expect.arrayContaining([expect.objectContaining({ code: "table_structure_confirmation_pending" })]),
      });
      expect(await controller.dispatch("read_table_summary", { table_key: "9.2.7" })).toMatchObject({
        ok: true,
        table_key: "9.2.7",
        row_count: table.header_rows.length + table.repeated_header_rows.length + dataIds.length,
        title_candidates: [expect.objectContaining({ role: "formal_table_title", text: expect.stringContaining("预制构件尺寸") })],
      });
      const rows = await controller.dispatch("read_table_rows", { table_key: "9.2.7", cursor: 0, limit: 20 });
      expect(rows).toMatchObject({
        ok: true,
        rows: expect.arrayContaining([expect.objectContaining({
          row_kind_hint: "header_candidate",
          table_title: expect.stringContaining("表 9.2.7"),
          bindable_text: expect.not.stringContaining("数据行"),
          cells: expect.arrayContaining([expect.objectContaining({ cell_id: expect.any(String), span_id: expect.any(String), rowspan: expect.any(Number), colspan: expect.any(Number) })]),
        })]),
      });
      const wrongVersion = { ...structuredClone(table), source_version: "mistyped-version" };
      const rejected = await controller.dispatch("stage_table_structure", { table: wrongVersion });
      const versionIssue = (rejected.validation as { issues: Array<{ code: string; details: Record<string, unknown> }> }).issues
        .find((entry) => entry.code === "table_structure_table_source_version_mismatch")!;
      expect(versionIssue.details.table_key).toBe(table.table_key);
      const repairSource = await controller.dispatch(String(versionIssue.details.next_tool), versionIssue.details.next_tool_arguments as Record<string, unknown>);
      expect(repairSource.saved_decision).toEqual(wrongVersion);
      const corrected = { ...(repairSource.saved_decision as typeof table), source_version: String(repairSource.source_version) };
      expect(corrected).toEqual(table);
      const structureSave = await controller.dispatch(String(versionIssue.details.save_tool), { table: corrected });
      expect(structureSave).toMatchObject({
        ok: true,
        draft_status: "saved_structure_validation_passed",
        pending_complex_tables: [],
        current_work: { code: "author_table_rows_pending", advisory_only: true, path: "/items",
          table_key: table.table_key, evidence_ids: [dataIds[0]], save_tool: "stage_target_selector_draft" },
        next_action: { kind: "author_source_decision_and_save", decision_owner: "model" },
      });
      expect(structureSave).not.toHaveProperty("next_tool");
      const restarted = await ToolController.create(workspace);
      expect(await restarted.selectorExecutionWork()).toMatchObject({ code: "author_table_rows_pending",
        source_delivery: { current_execution_complete: false } });
      const delivered = await restarted.dispatch("read_table_rows", { table_key: table.table_key,
        cursor: manifest.table_fragments[0]!.row_evidence_ids.indexOf(dataIds[0]!), limit: 1 });
      expect(delivered).toMatchObject({ ok: true, current_work: { code: "author_table_rows_pending",
        source_delivery: { current_execution_complete: true } }, next_action: { kind: "author_source_decision_and_save" } });
      const outsideNote = manifest.evidence.find((record) => record.role === "table_note")!;
      const wrongRows = { ...structuredClone(corrected), note_rows: [outsideNote.evidence_id] };
      const rowReceipt = await controller.dispatch("stage_table_structure", { table: wrongRows });
      const rowIssue = (rowReceipt.validation as { issues: Array<{ code: string; details: Record<string, unknown> }> }).issues
        .find((entry) => entry.code === "table_structure_row_partition_invalid")!;
      const rowRepairSource = await controller.dispatch(String(rowIssue.details.next_tool), rowIssue.details.next_tool_arguments as Record<string, unknown>);
      expect(rowRepairSource.saved_decision).toEqual(wrongRows);
      const repairedRows = { ...(rowRepairSource.saved_decision as typeof table), note_rows: [] };
      expect(repairedRows).toEqual(corrected);
      expect(await controller.dispatch(String(rowIssue.details.save_tool), { table: repairedRows })).toMatchObject({
        ok: true,
        draft_status: "saved_structure_validation_passed",
        pending_complex_tables: [],
      });
      expect(await controller.dispatch("list_table_fragments", { cursor: 0, limit: 10 })).toMatchObject({
        ok: true,
        table_expansion_work_packages: expect.arrayContaining([
          expect.objectContaining({
            table_id: "9.2.7",
            row_count: dataIds.length,
            rows: expect.arrayContaining(dataIds.map((evidence_id) =>
              expect.objectContaining({ evidence_id })
            )),
          }),
        ]),
      });
      const reopened = await ToolController.create(workspace);
      expect(await reopened.dispatch("read_saved_table_structure", {})).toMatchObject({
        ok: true,
        structure: { tables: [expect.objectContaining({ table_key: "9.2.7", status: "confirmed", review_rows: [] })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("accepts an Agent-selected exact adjacent paragraph only when no title candidate was registered", () => {
    const { manifest, registry } = fixture();
    const title = manifest.evidence.find((record) => record.role === "formal_table_title")!;
    const titleAtomId = "atom:table-source";
    const tableMemberIds = new Set(manifest.table_fragments.flatMap((fragment) => [
      ...fragment.header_evidence_ids,
      ...fragment.row_evidence_ids,
      ...fragment.formal_row_evidence_ids,
    ]));
    manifest.evidence.forEach((record) => {
      if (tableMemberIds.has(record.evidence_id)) record.atom_id = titleAtomId;
    });
    title.role = "context";
    title.atom_id = titleAtomId;
    manifest.table_fragments.forEach((fragment) => {
      fragment.title_candidate_evidence_ids = [];
    });

    const plan = initialTableStructurePlan(manifest, registry);
    const table = plan.tables[0]!;
    expect(table.formal_title_span_ids).toEqual([]);
    table.formal_title_span_ids = [registry.spans.find((span) =>
      span.evidence_id === title.evidence_id
      && span.start === 0
      && span.end === title.text.length
    )!.span_id];
    expect(validateTableStructurePlan(plan, manifest, registry)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_structure_formal_title_invalid" }),
    ]));

    const unrelated = manifest.evidence.find((record) =>
      record.kind === "paragraph" && record.evidence_id !== title.evidence_id
    );
    if (unrelated) {
      unrelated.atom_id = "atom:outside-table-source";
      table.formal_title_span_ids = [registry.spans.find((span) =>
        span.evidence_id === unrelated.evidence_id
        && span.start === 0
        && span.end === unrelated.text.length
      )!.span_id];
      expect(validateTableStructurePlan(plan, manifest, registry)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "table_structure_formal_title_invalid" }),
      ]));
    }
  });
});
