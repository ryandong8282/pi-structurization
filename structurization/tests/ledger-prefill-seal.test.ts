import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { atomicWriteJson } from "../src/atomic.js";
import { targetOwnScopeForTarget, trySealTargetFromLedgerPrefill } from "../src/batch.js";
import { prettyJson, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  UNLABELED_ITEM_CATEGORY,
  type EvidenceManifest,
} from "../src/contracts.js";
import { prefillDocumentSelectorsFromLedger, scanDocumentLedger } from "../src/document-ledger.js";
import { buildAgentScopedEvidenceManifest, buildDocumentEvidence } from "../src/document-discovery.js";
import { selectorDispositionCoverage } from "../src/evidence-disposition-coverage.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { prefillTargetSelectorsFromLedger } from "../src/ledger-target-selectors.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { ToolController, tableExpansionOscillation } from "../src/tools.js";
import { compileTargetSelectors, tableExpansionState, targetSelectorFingerprint, TargetSelectorCompileError, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { initialTableStructurePlan, validateTableStructurePlan } from "../src/table-structure.js";
import { RevisionWorkspace } from "../src/workspace.js";

const MARKDOWN = `
# 4 原材料及成品进场验收 [PDF p.12]

## 4.2 铝合金材料 [PDF p.13]

### 主控项目 [PDF p.13]

4.2.1 铝合金材料的品种、规格、性能应符合设计文件要求。

检查数量：全数检查。

检验方法：检查质量证明文件。

### 一般项目 [PDF p.14]

4.2.3 铝合金材料外观不应有明显损伤。

检查数量：抽查10%，且不少于3件。

检验方法：观察检查。
`.trim();

function manifestFor(text: string, jobId: string, targetId: string): EvidenceManifest {
  const evidenceId = "atom:ledger-seal";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: jobId,
    target_id: targetId,
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "ledger-seal.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: targetId,
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
      selected_heading: "4.2 铝合金材料",
      selection_reason: "ledger seal fixture",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: "line:1",
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`ledger-seal\0${text}`),
  };
}

describe("ledger prefill requires initial model extraction before review", () => {
  const livePrecastRevision = resolve(import.meta.dirname, "../../..", "data/jobs/20260907-094050-gb50204-selfreview-luna-medium/pi-agent/jobs/20260907-094050-gb50204-selfreview-luna-medium/targets/target_3Ad107f9a59ae6b0d9d9dd1d13/revisions/000005");
  const livePrecastSplitRevision = resolve(import.meta.dirname, "../../..", "data/jobs/20260907-094050-gb50204-selfreview-luna-medium/pi-agent/jobs/20260907-094050-gb50204-selfreview-luna-medium/targets/target_3Ad107f9a59ae6b0d9d9dd1d13/revisions/000006");
  test("prefills a source-backed clause without inventing a category from general provisions", () => {
    const markdown = [
      "# 3 构件验收",
      "## 3.2 构件接缝",
      "### 一般规定",
      "3.2.1 构件接缝应连续。",
      "检查数量：全数检查。",
      "检验方法：观察检查。",
    ].join("\n");
    const ledger = scanDocumentLedger(markdown, "neutral.md");
    expect(ledger.clauses.find((clause) => clause.clause_id === "3.2.1")?.column).toBeUndefined();
    const manifest = manifestFor(markdown, "job:neutral-category", "target:neutral-category");
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((record) => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));

    const prefilled = prefillTargetSelectorsFromLedger({
      ledger, markdown, manifest, registry,
      start_line: 2, end_exclusive_line: markdown.split("\n").length + 1,
    });
    expect(prefilled.selectors.items).toHaveLength(1);
    expect(prefilled.selectors.items[0]!.category).toBe(UNLABELED_ITEM_CATEGORY);
  });

  test.each([2,5])("pending table rows distinguish samples from the full %i-row repair inventory", rowCount => {
    const manifest = manifestFor("表 T 检查记录", "job:neutral", "target:neutral");
    const base = manifest.evidence[0]!;
    manifest.evidence = Array.from({length:rowCount},(_,index)=>["连接尺寸 允许值 ±3 直尺测量", "表面平整度 允许值 2 靠尺测量"][index%2]!).map((text, index) => ({
      ...base,
      evidence_id: `atom:neutral-row-${index + 1}`,
      kind: "table_row" as const,
      role: "formal_table_row" as const,
      locator: `line:10/table:T/row:${index + 1}`,
      text,
      text_sha256: sha256Text(text),
      table_id: "T",
      table_row_kind: "data" as const,
      columns: ["检查项目", "允许值", "检查方法"],
      cells: index === 0 ? ["连接尺寸", "±3", "直尺测量"] : ["表面平整度", "2", "靠尺测量"],
    }));

    const issue = tableExpansionState(manifest).issues.find((entry) => entry.code === "selector_table_expansion_obligations_pending");
    expect(issue).toMatchObject({
      path: "/items",
      details: {
        pending_evidence_ids: manifest.evidence.map(row=>row.evidence_id),
        unresolved_rows_reported_count: Math.min(rowCount,3),
        unresolved_rows_complete: rowCount<=3,
        current_item_groups_role: "existing_source_receivers_for_navigation_not_suggested_repair_targets",
        next_tool: "open_evidence",
        next_tool_arguments: { evidence_id: "atom:neutral-row-1", cursor: 0 },
        candidate_read_tools: expect.arrayContaining(["read_table_summary", "read_table_rows", "read_target_selectors"]),
        writable_paths: ["/items", "/sampling_rules", "/source_dispositions"],
        writable_collections: ["items", "sampling_rules", "source_dispositions"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("unresolved_rows"),
      },
    });
    expect(issue?.details?.how_to_pass).toContain("真实表头、条件、单位和方法");
    expect((issue?.details?.unresolved_rows as unknown[]).length).toBe(Math.min(rowCount,3));
    expect(issue?.details?.how_to_pass).toContain("pending_evidence_ids是完整来源清单");
    expect(issue?.details?.how_to_pass).toContain("布局分组不裁决业务，也不要求一行一项");
  });

  test.skipIf(!existsSync(join(livePrecastRevision, "evidence/evidence.json")))("GB50204 表9.2.7预填为29行待展开任务，整表大item不能绕过", async () => {
    const manifest = JSON.parse(await readFile(join(livePrecastRevision, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const markdown = await readFile(join(livePrecastRevision, "evidence/source.md"), "utf8");
    const ledger = scanDocumentLedger(markdown, "GB50204.md");
    const registry = JSON.parse(await readFile(join(livePrecastRevision, "source-span-registry.json"), "utf8"));
    const window = ledger.windows.find(entry => entry.number === "9.2")!;
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger, markdown, manifest, registry,
      start_line: window.start_line, end_exclusive_line: window.end_exclusive_line,
    });
    expect(prefilled.selectors.items.some(item => item.key === "ledger-clause:9.2.7")).toBe(false);
    const pending = tableExpansionState(manifest, prefilled.registry, prefilled.selectors);
    const workPackage = pending.work_packages.find(entry => entry.table_id === "9.2.7")!;
    expect(workPackage).toMatchObject({ row_count: 29 });
    expect(workPackage.rows.every(row => row.disposition === "pending")).toBe(true);
    expect(workPackage.candidate_core_property_groups.map(group => group.core_property)).toEqual(expect.arrayContaining([
      "长度", "宽度、高(厚)度", "表面平整度", "侧向弯曲", "翘曲", "对角线", "预留孔", "预留洞", "预埋件", "预留插筋", "键槽",
    ]));
    expect(pending.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_table_expansion_obligations_pending",
        details: expect.objectContaining({ unresolved_rows: expect.arrayContaining([expect.objectContaining({
          parent_property: "长度", allowed_value: "±5", method: "尺量", locator: expect.any(String),
        })]) }),
      }),
    ]));

    const current = JSON.parse(await readFile(join(livePrecastRevision, "working.target-selectors.json"), "utf8")) as TargetSelectorPlan;
    const merged = tableExpansionState(manifest, registry, current);
    expect(merged.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_table_distinct_core_properties_merged",
        details: expect.objectContaining({
          core_properties: expect.arrayContaining(["长度", "表面平整度", "侧向弯曲", "翘曲"]),
          readable_row_matrix: expect.arrayContaining([expect.objectContaining({ row_path: expect.any(Array), allowed_value: expect.any(String), method: expect.any(String) })]),
        }),
      }),
    ]));
    const withoutBranches = structuredClone(current);
    const tableItem = withoutBranches.items.find(item => item.table?.table_key.includes("9.2.7"))!;
    delete tableItem.table!.properties.acceptance_branches;
    expect(tableExpansionState(manifest, registry, withoutBranches).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "selector_table_distinct_core_properties_merged" })]));

    const split = structuredClone(current);
    split.items = split.items.filter(item => item.key !== tableItem.key);
    const fullSpan = (evidenceId: string) => registry.spans.find((span: { evidence_id: string; start: number; end: number }) => {
      const record = manifest.evidence.find(entry => entry.evidence_id === evidenceId)!;
      return span.evidence_id === evidenceId && span.start === 0 && span.end === record.text.length;
    })!.span_id;
    for (const group of workPackage.candidate_core_property_groups) {
      const rows = workPackage.rows.filter(row => group.row_ids.includes(row.row_id));
      const rowSpanIds = rows.map(row => fullSpan(row.evidence_id));
      split.items.push({
        key: `split:${group.core_property}`,
        lot_key: tableItem.lot_key,
        name: group.core_property,
        category: tableItem.category,
        criterion_span_ids: rowSpanIds,
        continuation_span_ids: [],
        fields: {
          name: { composition: "semantic_summary", span_ids: rowSpanIds, separator: "", reason: "按父属性拆分" },
          requirement: { composition: "verbatim", span_ids: rowSpanIds, separator: "\n", reason: "该父属性全部行" },
          method: { composition: "not_applicable", span_ids: [], separator: "", reason: "本测试只核对展开义务" },
          quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "本测试只核对展开义务" },
          note: { composition: "not_applicable", span_ids: [], separator: "", reason: "本测试只核对展开义务" },
        },
        table: null,
        inspection_data_type: "review",
        inspection_data_type_reason: "本测试只核对展开义务",
        inspection_data_type_span_ids: rowSpanIds,
        sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], reason: "仅测试表格展开义务", confidence: 1 },
        reason: "按同一父属性分组",
      });
    }
    expect(tableExpansionState(manifest, registry, split).issues).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), "table-expansion-work-package-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) },
      );
      await workspace.writeWorkingSelectors(prettyJson(current));
      await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
      const controller = await ToolController.create(workspace);
      expect(existsSync(join(workspace.root, "table-expansion-obligations.json"))).toBe(true);
      const listed = await controller.dispatch("list_table_fragments", { cursor: 0, limit: 10 });
      expect(listed).toMatchObject({
        ok: true,
        fragments: expect.arrayContaining([
          expect.objectContaining({
            access_mode: "isolated_reference",
            read_tool: "read_reference_facts",
            open_table_fragment_allowed: false,
            target_keys: expect.any(Array),
          }),
        ]),
        table_expansion_work_packages: [],
      });
      const serialized = JSON.stringify(listed);
      for (const row of workPackage.rows) {
        expect(serialized).not.toContain(row.evidence_id);
        expect(serialized).not.toContain(row.locator);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const directRoot = await mkdtemp(join(tmpdir(), "table-expansion-direct-work-package-"));
    try {
      const directManifest = { ...manifest, reference_occurrences: [] };
      const workspace = await RevisionWorkspace.createFromEvidence(
        directRoot, directManifest.job_id, directManifest.target_id,
        { manifest: directManifest, markdown: Buffer.from(markdown) },
      );
      await workspace.writeWorkingSelectors(prettyJson(current));
      await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
      const controller = await ToolController.create(workspace);
      expect(JSON.parse(await readFile(
        join(workspace.root, "table-expansion-obligations.json"),
        "utf8",
      ))).toMatchObject({
        work_packages: expect.arrayContaining([
          expect.objectContaining({ table_id: "9.2.7", row_count: 29, rows: expect.any(Array) }),
        ]),
      });
      expect(await controller.dispatch("list_table_fragments", { cursor: 0, limit: 10 })).toMatchObject({
        ok: true,
        table_expansion_work_packages: expect.arrayContaining([
          expect.objectContaining({ table_id: "9.2.7", row_count: 29, rows: expect.any(Array) }),
        ]),
      });
    } finally {
      await rm(directRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(!existsSync(join(livePrecastSplitRevision, "evidence/evidence.json")))("GB50204 表9.2.7旧混合表头兼容：7+1归并并由逻辑表结构消除", async () => {
    const manifest = JSON.parse(await readFile(join(livePrecastSplitRevision, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
    const registry = JSON.parse(await readFile(join(livePrecastSplitRevision, "source-span-registry.json"), "utf8"));
    const selectors = JSON.parse(await readFile(join(livePrecastSplitRevision, "working.target-selectors.json"), "utf8")) as TargetSelectorPlan;
    const header = manifest.evidence.find(record => record.table_id === "9.2.7" && record.role === "formal_table_header")!;
    expect(header.text).toContain("数据行 1");
    const headerSpan = registry.spans.find((span: { evidence_id: string; start: number; end: number }) =>
      span.evidence_id === header.evidence_id && span.start === 0 && span.end === header.text.length
    )!.span_id;
    const affected = selectors.items.filter(item => [
      "warpage", "diagonal", "reserved-hole", "reserved-opening", "embedded-parts", "reserved-rebar", "keyway",
    ].some(suffix => item.key.endsWith(`:${suffix}`)));
    expect(affected).toHaveLength(7);
    const contaminated = structuredClone(selectors);
    contaminated.items.filter(item => affected.some(candidate => candidate.key === item.key))
      .forEach(item => { item.table!.properties.table_title_span_ids = [headerSpan]; });
    try {
      compileTargetSelectors(contaminated, registry, manifest);
      throw new Error("expected grouped title-role failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      const titleIssues = (error as TargetSelectorCompileError).issues.filter(issue => issue.code === "selector_table_title_role_invalid");
      expect(titleIssues).toHaveLength(1);
      expect(titleIssues[0]).toMatchObject({
        details: expect.objectContaining({
          affected_item_keys: expect.arrayContaining(affected.map(item => item.key)),
          offending_bindings: expect.arrayContaining([expect.objectContaining({ evidence_id: header.evidence_id, evidence_role: "formal_table_header" })]),
        }),
      });
    }

    const cleaned = structuredClone(selectors);
    cleaned.items.filter(item => item.table?.table_key === "9.2.7")
      .forEach(item => { item.table!.properties.table_title_span_ids = []; });
    const coverage = selectorDispositionCoverage({ selectors: cleaned, evidence: manifest.evidence, spans: registry.spans });
    expect(coverage.bound_evidence_ids).toContain(header.evidence_id);
    expect(coverage.uncovered_required_ids).not.toContain(header.evidence_id);

    const structure = initialTableStructurePlan(manifest, registry);
    const table = structure.tables.find(entry => entry.table_key === "9.2.7")!;
    const rowRecords = manifest.evidence.filter(record => table.fragment_ids.includes(record.table_fragment_id ?? "") && record.kind === "table_row");
    const headerRows = rowRecords.filter(record => record.table_row_kind === "header").map(record => record.evidence_id);
    table.status = "confirmed";
    table.header_rows = headerRows.slice(0, 1);
    table.repeated_header_rows = headerRows.slice(1);
    table.data_rows = rowRecords.filter(record => record.table_row_kind === "data").map(record => record.evidence_id);
    table.review_rows = [];
    table.reason = "表9.2.7与续表共享编号；首表头为正式表头，续表首行为重复表头，29个数据行保持逐行 provenance。";
    expect(table.data_rows).toHaveLength(29);
    expect(table.formal_title_span_ids).toHaveLength(1);
    expect(validateTableStructurePlan(structure, manifest, registry)).toEqual([]);
  });

  test("表格表示 A-B-A 往返会停止", () => {
    expect(tableExpansionOscillation([
      { item_key: "table-9.2.7", issue_codes: ["selector_acceptance_branches_required"], issue_fingerprint: "a" },
      { item_key: "table-9.2.7", issue_codes: ["selector_acceptance_branch_condition_duplicate"], issue_fingerprint: "b" },
      { item_key: "table-9.2.7", issue_codes: ["selector_acceptance_branches_required"], issue_fingerprint: "a" },
    ])).toMatchObject({ item_key: "table-9.2.7" });
  });
  test("keeps row-only evidence pending after prefill, partial staging and reopening", async () => {
    const path = resolve(import.meta.dirname, "../fixtures/real/GB_50202-2018.md");
    const markdown = await readFile(path, "utf8");
    const document = buildDocumentEvidence(markdown, "GB_50202-2018.md");
    const ledger = scanDocumentLedger(markdown, "GB_50202-2018.md");
    const docRegistry = registryWithFullSourceSpans(document.evidence_fingerprint, document.atoms.map(atom => ({
      source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
    })));
    const docPrefill = prefillDocumentSelectorsFromLedger("job-row-prefill", document.atoms, ledger, docRegistry);
    const target = compileDocumentSelectors(
      approveScopeFixture(docPrefill.selectors, docPrefill.registry, document),
      docPrefill.registry, document, "job-row-prefill",
    ).targets.find(t => t.name === "排桩")!;
    const scope = targetOwnScopeForTarget(target, ledger, document.atoms)!;
    const { manifest } = await buildAgentScopedEvidenceManifest(path, "job-row-prefill", target, document, undefined, scope);
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger, markdown, manifest, registry, ...scope,
    });
    expect(prefilled.clause_item_count).toBeGreaterThan(0);
    expect(prefilled.table_item_count).toBe(0);
    expect(prefilled.selectors.source_dispositions).toEqual([]);
    const root = await mkdtemp(join(tmpdir(), "ledger-row-prefill-"));
    try {
      const ws = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, { manifest, markdown: Buffer.from(markdown) });
      await ws.writeWorkingSelectors(prettyJson(prefilled.selectors));
      await atomicWriteJson(ws.sourceSpanRegistryPath, prefilled.registry);
      await ws.updateState(state => { state.selector_prefill_fingerprint = targetSelectorFingerprint(prefilled.selectors); });
      const controller = await ToolController.create(ws);
      expect(controller.selectorStartupContext().current_selector_checkpoint).toBe("program_prefill");
      const contract = await controller.dispatch("get_target_selector_contract", {});
      expect((contract.authoring_protocols as any).tables).toContain("每个 row obligation 须由真实 item、同属性 branch");
      expect(JSON.stringify(contract)).not.toContain("One coarse item");
      const rows = manifest.evidence.filter(e => e.role === "formal_table_row" && e.evidence_scope === "primary");
      expect(rows.length).toBeGreaterThan(1);
      const spanFor = (id: string) => prefilled.registry.spans.find(s => s.evidence_id === id && s.start === 0)!.span_id;
      await controller.dispatch("read_target_selectors", { view: "summary" });
      await controller.dispatch("open_evidence", { evidence_id: rows[0]!.evidence_id });
      const partial = structuredClone(prefilled.selectors.items[0]!);
      partial.key = "model-row-one";
      partial.name = "孔深";
      partial.criterion_span_ids = [spanFor(rows[0]!.evidence_id)];
      expect(await controller.dispatch("stage_target_selector_draft", { operation: "upsert", draft: { items: [partial] } })).toMatchObject({ ok: true });
      // Explicitly reviewed background is allowed; prefill must not guess it.
      const background = manifest.evidence.find(e => e.evidence_scope === "primary" && e.text.startsWith("7.2.1 "))!;
      await controller.dispatch("open_evidence", { evidence_id: background.evidence_id });
      expect(await controller.dispatch("stage_target_selector_draft", { operation: "upsert", draft: { source_dispositions: [{
        span_ids: [spanFor(background.evidence_id)], disposition: "context", reason: "这是适用范围说明，不是独立验收判据。",
      }] } })).toMatchObject({ ok: true });
      const reopened = await ToolController.create(ws);
      expect(reopened.selectorStartupContext().current_selector_checkpoint).toBe("unvalidated_draft");
      const beforeGate = await ws.readState();
      const gate = await reopened.dispatch("advance_target_selector_stage", { next_stage: "sampling" });
      expect(gate).toMatchObject({
        ok:false,
        error:"selector_repair_required",
        content_validation_performed:false,
        full_stage_check_performed:false,
        budget_consumed:false,
        current_stage:"primary",
        next_tool:expect.any(String),
        next_tool_arguments:expect.any(Object),
      });
      expect(gate).toHaveProperty("selector_issues");
      expect((gate.selector_issues as unknown[]).length).toBeGreaterThan(0);
      const afterGate = await ws.readState();
      expect(afterGate.selector_stage).toBe(beforeGate.selector_stage);
      expect(afterGate.validation_attempts).toBe(beforeGate.validation_attempts);
      expect(afterGate.next_history_sequence).toBe(beforeGate.next_history_sequence);
      const saved = JSON.parse(await readFile(ws.workingSelectorPath, "utf8"));
      expect(saved.items.some((i: { key: string }) => i.key === partial.key)).toBe(true);
      expect(saved.source_dispositions).toHaveLength(1);
      expect(saved.source_dispositions[0].span_ids).toEqual([spanFor(background.evidence_id)]);
      expect((await ws.readState()).last_valid_fingerprint).toBe("");
      const found=await reopened.dispatch("search_global_document_resources",{query:"7.1.4 除强度"});
      const atom=(found.matches as Array<{atom_id:string}>)[0]!;
      await reopened.dispatch("open_global_document_resource",{atom_id:atom.atom_id});
      const draftBeforeExtension=await readFile(ws.workingSelectorPath,"utf8");
      const extension=await reopened.dispatch("register_external_dependency",{atom_id:atom.atom_id,mode:"scope_extension",reason:"这个宽原子同时含一般规定和已在范围内的排桩正文"});
      expect(extension).toMatchObject({ok:false,terminal:false,error:"scope_extension_mixed_resource"});
      expect(extension).toMatchObject({ next_tool: "open_evidence", next_tool_arguments: { evidence_id: expect.any(String), cursor: 0 }, writable_path: "report_target_blocker.evidence_span_ids" });
      expect(extension.instruction).toContain("完整读取");
      expect(extension.instruction).toContain("report_target_blocker(kind=scope_extension_required");
      const existingEvidence=extension.existing_evidence as Array<{evidence_id:string}>;
      expect(existingEvidence.length).toBeGreaterThan(0);
      expect(existingEvidence.every(e=>manifest.evidence.some(record=>record.evidence_id===e.evidence_id))).toBe(true);
      expect(await readFile(ws.workingSelectorPath,"utf8")).toBe(draftBeforeExtension);
      expect((await ws.readState()).status).toBe("working");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    MARKDOWN,
    MARKDOWN.replace("4.2.3 铝合金材料外观不应有明显损伤。", "4.2.3 铝合金材料尺寸允许偏差应符合表4.2.3的规定。")
      + "\n\n表4.2.3 铝合金材料尺寸允许偏差\n<table><tr><th>检查项目</th><th>允许偏差</th></tr><tr><td>长度</td><td>±2mm</td></tr></table>",
  ])("keeps prose/table prefill as an unvalidated draft without opening evidence for the model (%#)", async (markdown) => {
    const root = await mkdtemp(join(tmpdir(), "ledger-prefill-seal-"));
    const jobId = "job-ledger-seal";
    const targetId = "target:4.2";
    try {
      const manifest = manifestFor(markdown, jobId, targetId);
      const ledger = scanDocumentLedger(markdown, "ledger-seal.md");
      const registry = registryWithFullSourceSpans(
        manifest.evidence_fingerprint,
        manifest.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      const window = ledger.windows.find((entry) => entry.title.includes("铝合金"))
        ?? ledger.windows[0]!;
      const prefilled = prefillTargetSelectorsFromLedger({
        ledger,
        markdown,
        manifest,
        registry,
        start_line: window.start_line,
        end_exclusive_line: window.end_exclusive_line,
      });
      expect(prefilled.selectors.items.length).toBeGreaterThan(0);
      expect(prefilled.selectors.source_dispositions).toEqual([]);

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        jobId,
        targetId,
        { manifest, markdown: Buffer.from(markdown, "utf8") },
      );
      await workspace.writeWorkingSelectors(prettyJson(prefilled.selectors));
      await atomicWriteJson(workspace.sourceSpanRegistryPath, prefilled.registry);

      const discoveryDir = join(root, "jobs", encodeURIComponent(jobId), "discovery");
      await mkdir(discoveryDir, { recursive: true });
      const ledgerPath = join(discoveryDir, "document-ledger.json");
      await atomicWriteJson(ledgerPath, ledger);

      const controller = await ToolController.create(workspace);
      const stateBefore = await workspace.readState();
      const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const dispatch = vi.spyOn(controller, "dispatch");
      const sealed = await trySealTargetFromLedgerPrefill({
        workspace,
        controller,
        target: {
          target_id: targetId,
          name: window.title,
          ledger_window_id: window.window_id,
          start_line: window.start_line,
          end_exclusive_line: window.end_exclusive_line,
          table_count: 0,
          row_count: 0,
          status: "running",
          attempts: 1,
          revision: workspace.revision,
          workdir: workspace.root,
          model: "",
          error: "",
        },
        ledgerPath,
        artifactRoot: root,
        jobId,
        ledgerPrefill: {
          clause_item_count: prefilled.clause_item_count,
          table_item_count: prefilled.table_item_count,
        },
      });

      expect(sealed.sealed).toBe(false);
      expect(sealed.model).toContain("ledger-prefill");
      expect(sealed.model).not.toContain("skipped_ledger_complete");
      expect(dispatch).not.toHaveBeenCalled();
      expect(await workspace.readState()).toEqual({
        ...stateBefore, next_event_sequence: stateBefore.next_event_sequence + 1,
      });
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
      await expect(readFile(workspace.lastValidPlanPath, "utf8")).rejects.toThrow();
      await expect(readFile(workspace.manifestPath, "utf8")).rejects.toThrow();
      expect(await readFile(workspace.transcriptPath, "utf8"))
        .toContain('"reason":"initial_target_extraction_required"');
      const revisionState = JSON.parse(await readFile(workspace.statePath, "utf8")) as {
        status?: string;
      };
      expect(revisionState.status).not.toBe("sealed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defers to LLM when the prefilled plan leaves a ledger gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "ledger-prefill-gap-"));
    const jobId = "job-ledger-gap";
    const targetId = "target:4.2-gap";
    try {
      const manifest = manifestFor(MARKDOWN, jobId, targetId);
      const ledger = scanDocumentLedger(MARKDOWN, "ledger-seal.md");
      const registry = registryWithFullSourceSpans(
        manifest.evidence_fingerprint,
        manifest.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      const window = ledger.windows.find((entry) => entry.title.includes("铝合金"))
        ?? ledger.windows[0]!;
      const prefilled = prefillTargetSelectorsFromLedger({
        ledger,
        markdown: MARKDOWN,
        manifest,
        registry,
        start_line: window.start_line,
        end_exclusive_line: window.end_exclusive_line,
      });
      // 故意只留一条，制造缺口。
      prefilled.selectors.items = prefilled.selectors.items.slice(0, 1);
      expect(prefilled.selectors.items).toHaveLength(1);

      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        jobId,
        targetId,
        { manifest, markdown: Buffer.from(MARKDOWN, "utf8") },
      );
      await workspace.writeWorkingSelectors(prettyJson(prefilled.selectors));
      await atomicWriteJson(workspace.sourceSpanRegistryPath, prefilled.registry);

      const discoveryDir = join(root, "jobs", encodeURIComponent(jobId), "discovery");
      await mkdir(discoveryDir, { recursive: true });
      const ledgerPath = join(discoveryDir, "document-ledger.json");
      await atomicWriteJson(ledgerPath, ledger);

      const controller = await ToolController.create(workspace);
      const sealed = await trySealTargetFromLedgerPrefill({
        workspace,
        controller,
        target: {
          target_id: targetId,
          name: window.title,
          ledger_window_id: window.window_id,
          start_line: window.start_line,
          end_exclusive_line: window.end_exclusive_line,
          table_count: 0,
          row_count: 0,
          status: "running",
          attempts: 1,
          revision: workspace.revision,
          workdir: workspace.root,
          model: "",
          error: "",
        },
        ledgerPath,
        artifactRoot: root,
        jobId,
        ledgerPrefill: {
          clause_item_count: 1,
          table_item_count: 0,
        },
      });

      expect(sealed.sealed).toBe(false);
      expect(sealed.model).toContain("ledger-prefill");
      expect((await workspace.readState()).last_valid_fingerprint).toBe("");
      await expect(readFile(workspace.manifestPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
