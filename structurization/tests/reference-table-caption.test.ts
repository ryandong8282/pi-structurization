import { describe, expect, test } from "vitest";
import { sha256Text } from "../src/canonical.js";
import { EVIDENCE_SCHEMA_VERSION, EVIDENCE_SCOPE_SCHEMA_VERSION, SEMANTIC_EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "../src/contracts.js";
import { resolveDocumentReferenceTarget } from "../src/document-reference.js";
import { initialTargetSelectorPlan, compileTargetSelectors as compileTargetSelectorsPersisted, TargetSelectorCompileError, type TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { registryWithFullSourceSpans, locateAndRegisterSourceQuote, type SourceSpanRegistry } from "../src/source-span-registry.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:selector-compiler";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "selector-job",
    target_id: "target-base-layer",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-base-layer",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "全文语义选择",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`evidence\0${text}`),
  };
}

function registerQuotes(manifest: EvidenceManifest, quotes: string[]): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  const source = manifest.evidence[0]!;
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [{
    source_id: source.evidence_id,
    evidence_id: source.evidence_id,
    atom_id: source.evidence_id,
    text: source.text,
  }]);
  const ids = new Map<string, string>();
  for (const quote of quotes) {
    const located = locateAndRegisterSourceQuote(registry, {
      source_id: source.evidence_id,
      evidence_id: source.evidence_id,
      atom_id: source.evidence_id,
      text: source.text,
    }, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function fixture(text = "基层表面应平整、密实。检验方法：用2m靠尺检查。"): {
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  selectors: TargetSelectorPlan;
} {
  const manifest = manifestFor(text);
  const registered = registerQuotes(manifest, [text]);
  const full = registered.ids.get(text)!;
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "base", name: "基层检验批", scope_span_ids: [full], reason: "同一基层验收范围" });
  selectors.items.push({
    key: "surface",
    lot_key: "base",
    name: "基层表面质量",
    category: "一般项目",
    criterion_span_ids: [full],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [full], separator: "", reason: "被检对象和质量特性" },
      requirement: { composition: "verbatim", span_ids: [full], separator: "", reason: "完整要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "最小用例不拆字段" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "靠尺产生测量结果。",
    inspection_data_type_span_ids: [full],
    sampling: {
      status: "fallback", rule_key: "", branch_keys: [],
      quantity_span_ids: [], script_span_ids: [], condition_span_ids: [],
      reason: "原文未形成抽样数量", confidence: 1,
    },
    reason: "可以独立检查并判定",
  });
  return { manifest, registry: registered.registry, selectors };
}


describe("reference table caption provenance", () => {
  test("retains the formal caption identity of a narrow appendix table", () => {
    const caption = "表 Q.0.1 构件检验方法";
    const source = [
      "# 附录 Q 构件检验",
      "Q.0.1 构件按下表检验。",
      caption,
      "<table><tr><td>项目</td><td>方法</td></tr><tr><td>尺寸</td><td>尺量</td></tr></table>",
    ].join("\n");
    const resolved = resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "appendix", number: "Q" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected appendix evidence");
    expect(resolved.evidence.find((record) => record.text === caption)).toMatchObject({
      kind: "paragraph", role: "formal_table_title", table_id: "Q.0.1", table_title: caption,
      evidence_scope: "reference", registered_dependency: true,
      table_fragment_id: "reference-table-fragment:line:4",
    });
    expect(resolved.evidence.find((record) => record.table_row_kind === "data"))
      .toMatchObject({ table_id: "Q.0.1", table_title: caption, table_fragment_id: "reference-table-fragment:line:4" });
  });

  test("does not promote a prose table mention separated from the actual table", () => {
    const mention = "表 Q.0.1 的要求另见说明。";
    const source = ["# 附录 Q 构件检验", mention, "另一个段落。",
      "<table><tr><td>项目</td><td>方法</td></tr><tr><td>尺寸</td><td>尺量</td></tr></table>"].join("\n");
    const resolved = resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "appendix", number: "Q" });
    if (!resolved.ok) throw new Error("expected appendix evidence");
    expect(resolved.evidence.find((record) => record.text === mention))
      .toMatchObject({ kind: "paragraph", role: "context" });
  });

  test("keeps a registered narrow-table caption when field provenance imports another table", () => {
    const titleA = "表 Q.0.1 构件检验方法";
    const titleB = "表 4.2.9 构件允许偏差";
    const rowA = "尺寸 | 尺量";
    const rowB = "尺寸 | 2mm";
    const manifest = manifestFor(rowA);
    const base = manifest.evidence[0]!;
    const record = (id: string, text: string, title: boolean, tableId: string) => ({
      ...base, evidence_id: id, text, text_sha256: sha256Text(text),
      kind: title ? "paragraph" as const : "table_row" as const,
      role: title ? "formal_table_title" as const : "formal_table_row" as const,
      ...(title ? {} : { table_row_kind: "data" as const }),
      table_id: tableId, table_title: tableId === "Q.0.1" ? titleA : titleB,
      evidence_scope: "reference" as const, registered_dependency: true, requires_disposition: false,
    });
    const origin = "1.2.3 构件检验方法应符合表 Q.0.1 的规定。";
    manifest.evidence = [{ ...base, evidence_id: "origin", text: origin, text_sha256: sha256Text(origin) },
      { ...record("title:a", titleA, true, "Q.0.1"), table_fragment_id: "fragment:a" },
      { ...record("row:a", rowA, false, "Q.0.1"), table_fragment_id: "fragment:a" },
      { ...record("title:b", titleB, true, "4.2.9"), table_fragment_id: "fragment:b" },
      { ...record("row:b", rowB, false, "4.2.9"), table_fragment_id: "fragment:b" }];
    const ownFragment = { fragment_id: "fragment:a", source_order: 1, locator: "a",
      provisional_table_id: "Q.0.1", provisional_title: titleA, title_candidate_evidence_ids: ["title:a"],
      header_evidence_ids: [], row_evidence_ids: ["row:a"], formal_row_evidence_ids: ["row:a"], columns: [] };
    manifest.table_fragments = [ownFragment, { fragment_id: "fragment:b", source_order: 2, locator: "b",
      provisional_table_id: "4.2.9", provisional_title: titleB, title_candidate_evidence_ids: ["title:b"],
      header_evidence_ids: [], row_evidence_ids: ["row:b"], formal_row_evidence_ids: ["row:b"], columns: [] }];
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint,
      manifest.evidence.map((entry) => ({ source_id: entry.evidence_id, evidence_id: entry.evidence_id, atom_id: entry.evidence_id, text: entry.text })));
    const span = (id: string) => registry.spans.find((entry) => entry.evidence_id === id)!.span_id;
    const selectors = fixture(rowA).selectors;
    selectors.lots[0]!.scope_span_ids = [span("origin")];
    const item = selectors.items[0]!;
    Object.assign(item, { criterion_span_ids: [span("origin")], inspection_data_type_span_ids: [span("row:a")] });
    item.fields.name.span_ids = [span("row:a")]; item.fields.requirement.span_ids = [span("origin")];
    item.table = { source_kind: "reference", table_key: "opaque-owner-key", reference_span_ids: [span("origin")], reason: "独立表题与借用限值", properties: {
      table_no_span_ids: [], table_title_span_ids: [span("title:a")], applicability_span_ids: [],
      row_path_span_ids: [[span("row:a")]], column_path_span_ids: [], unit_span_ids: [], condition_span_ids: [],
      allowed_value_span_ids: [span("row:b")], inspection_method_span_ids: [span("row:a")],
    } };
    const compiled = compileTargetSelectorsPersisted(selectors, registry, manifest);
    expect(compiled.acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
    expect(compiled.table_assembly.logical_tables[0]!.canonical_title_span_ids).toEqual([span("title:a")]);
    const tableStructurePlan = { schema_version: "table-structure-decisions/v1" as const,
      source_version: manifest.source.sha256, evidence_fingerprint: manifest.evidence_fingerprint,
      tables: [{ table_key: "foreign-table", status: "confirmed" as const, source_version: manifest.source.sha256,
        formal_title_span_ids: [span("title:b")], fragment_ids: ["fragment:b"], header_rows: [], data_rows: ["row:b"],
        repeated_header_rows: [], note_rows: [], context_rows: [], review_rows: [], row_role_overrides: [],
        continuation_caption_span_ids: [], note_span_ids: [], reason: "借用表的独立结构" }] };
    expect(compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan })
      .acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
    const ownStructure = { ...tableStructurePlan, tables: [{
      ...tableStructurePlan.tables[0]!, table_key: item.table.table_key,
      formal_title_span_ids: [span("title:a")], fragment_ids: ["fragment:a"], data_rows: ["row:a"],
    }] };
    // Row navigation identifies this table; its allowed value may still come from a referenced table.
    expect(compileTargetSelectorsPersisted(selectors, registry, manifest, { tableStructurePlan: ownStructure })
      .acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
    const wrongNavigation = structuredClone(selectors);
    wrongNavigation.items[0]!.table!.properties.row_path_span_ids = [[span("row:b")]];
    let navigationError: unknown;
    try { compileTargetSelectorsPersisted(wrongNavigation, registry, manifest, { tableStructurePlan: ownStructure }); }
    catch (error) { navigationError = error; }
    expect(navigationError).toBeInstanceOf(TargetSelectorCompileError);
    expect((navigationError as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selector_table_navigation_outside_structure",
        path: "/items/0/table/properties/row_path_span_ids",
        details: expect.objectContaining({
          actual: expect.objectContaining({
            item_key: item.key, table_key: item.table.table_key,
            structure_fragment_ids: ["fragment:a"],
            offending_bindings: [expect.objectContaining({
              span_id: span("row:b"), evidence_id: "row:b", fragment_ids: ["fragment:b"],
            })],
          }),
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: item.key },
          save_tool: "stage_target_selector_draft",
        }),
      }),
    ]));
    // Both offered routes are executable without confining borrowed values or methods.
    wrongNavigation.items[0]!.table!.properties.row_path_span_ids = [[span("row:a")]];
    expect(compileTargetSelectorsPersisted(wrongNavigation, registry, manifest, { tableStructurePlan: ownStructure })
      .acceptance_items[0]!.table_semantics?.table_title).toBe(titleA);
    wrongNavigation.items[0]!.table!.properties.row_path_span_ids = [[span("row:b")]];
    wrongNavigation.items[0]!.table!.table_key = "foreign-table";
    wrongNavigation.items[0]!.table!.properties.table_title_span_ids = [span("title:b")];
    expect(compileTargetSelectorsPersisted(wrongNavigation, registry, manifest, { tableStructurePlan })
      .acceptance_items[0]!.table_semantics?.table_title).toBe(titleB);
    // Caption metadata without a complete registered fragment remains insufficient.
    manifest.table_fragments = manifest.table_fragments.filter((fragment) => fragment.fragment_id !== "fragment:a");
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
    manifest.table_fragments.unshift(ownFragment);
    // A header or ordinary context must never gain caption authority from its table id.
    manifest.evidence.find((record) => record.evidence_id === "title:a")!.role = "formal_table_header";
    expect(() => compileTargetSelectorsPersisted(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
  });

  test("registers reference fragments only after all immutable table records are present", async () => {
    const source = ["# 附录 Q 构件检验", "Q.0.1 构件按下表检验。", "表 Q.0.1 构件检验方法",
      "<table><tr><td>项目</td><td>方法</td></tr><tr><td>尺寸</td><td>尺量</td></tr></table>"].join("\n");
    const resolved = resolveDocumentReferenceTarget(source, sha256Text(source), { kind: "appendix", number: "Q" });
    if (!resolved.ok) throw new Error("expected appendix evidence");
    const root = await mkdtemp(join(tmpdir(), "reference-caption-"));
    try {
      for (const complete of [false, true]) {
        const manifest = manifestFor(source);
        const workspace = await RevisionWorkspace.createFromEvidence(join(root, String(complete)), manifest.job_id,
          manifest.target_id, { manifest, markdown: Buffer.from(source) });
        const records = resolved.evidence.filter((record) => complete || record.table_row_kind !== "data");
        const registered = await workspace.registerDocumentReferenceDependency(records, {
          occurrence_id: "reference:caption", reference_kind: "clause",
          origin_evidence_id: manifest.evidence[0]!.evidence_id, origin_fields: ["requirement"],
          raw_reference: "附录 Q", relation: "方法引用", target_evidence_ids: records.map((record) => record.evidence_id),
          required: true, status: "resolved", depth: 1, path: ["source:appendix:Q"],
          target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "appendix:Q" },
        });
        const fragment = registered.manifest.table_fragments.find((entry) => entry.fragment_id === "reference-table-fragment:line:4");
        if (!complete) expect(fragment).toBeUndefined();
        else {
          expect(fragment?.title_candidate_evidence_ids).toEqual([records.find((entry) => entry.role === "formal_table_title")!.evidence_id]);
          expect(fragment?.formal_row_evidence_ids).toEqual([records.find((entry) => entry.table_row_kind === "data")!.evidence_id]);
        }
      }
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep + "reference-caption-")) throw new Error("Unexpected temporary root");
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

});
