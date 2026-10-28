import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { inlineReferenceEvidenceIdsForItem, materialize } from "../src/materializer.js";
import {
  htmlTableCellSpans,
  initialSourceSpanRegistry,
  registerSourceSpan,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TARGET_SELECTOR_PLAN_JSON_SCHEMA,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { validatePlanText } from "../src/validator.js";

interface TestEvidence {
  evidence_id: string;
  text: string;
  primary?: boolean;
}

function manifestFor(evidence: TestEvidence[]): EvidenceManifest {
  const primary = evidence.find((entry) => entry.primary) ?? evidence[0]!;
  const fingerprint = sha256Text(evidence.map((entry) => `${entry.evidence_id}\0${entry.text}`).join("\0"));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "reference-projection-job",
    target_id: "target-reference-projection",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: fingerprint,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-reference-projection",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "全文语义选择",
      selected_atom_ids: evidence.filter((entry) => entry.primary).map((entry) => entry.evidence_id),
      target_evidence_fragments: [{ atom_id: primary.evidence_id, text: primary.text }],
      candidates: [],
    },
    evidence: evidence.map((entry) => ({
      evidence_id: entry.evidence_id,
      kind: "paragraph" as const,
      role: "supporting_clause" as const,
      locator: `char:0-${entry.text.length}`,
      text: entry.text,
      text_sha256: sha256Text(entry.text),
      requires_disposition: entry.primary === true,
      evidence_scope: entry.primary === true ? "primary" as const : "reference" as const,
    })),
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: fingerprint,
  };
}

function registerQuotes(
  manifest: EvidenceManifest,
  quotes: Array<{ evidence_id: string; quote: string; key: string }>,
): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  let registry = initialSourceSpanRegistry(manifest.evidence_fingerprint);
  const ids = new Map<string, string>();
  for (const { evidence_id: evidenceId, quote, key } of quotes) {
    const evidence = manifest.evidence.find((entry) => entry.evidence_id === evidenceId)!;
    const start = evidence.text.indexOf(quote);
    expect(start, `fixture quote ${quote}`).toBeGreaterThanOrEqual(0);
    const registered = registerSourceSpan(registry, {
      source_id: evidenceId,
      evidence_id: evidenceId,
      atom_id: evidenceId,
      text: evidence.text,
    }, start, start + quote.length);
    registry = registered.registry;
    ids.set(key, registered.span.span_id);
  }
  return { registry, ids };
}

function baseSelectors(
  manifest: EvidenceManifest,
  anchorSpanId: string,
): TargetSelectorPlan {
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "lot",
    name: "检验批 lot",
    scope_span_ids: [anchorSpanId],
    reason: "目标业务范围",
  });
  selectors.items.push({
    key: "item",
    lot_key: "lot",
    name: "验收项目",
    category: "一般项目",
    criterion_span_ids: [anchorSpanId],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [anchorSpanId], separator: "", reason: "被检对象" },
      requirement: { composition: "verbatim", span_ids: [anchorSpanId], separator: "", reason: "本地要求" },
      method: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给方法" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未给数量" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "原文无备注" },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "依据文本核验",
    inspection_data_type_span_ids: [anchorSpanId],
    sampling: {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "原文未形成抽样规则",
      confidence: 1,
    },
    reason: "独立验收判断",
  });
  return selectors;
}

function compile(
  selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry,
  manifest: EvidenceManifest,
): SemanticSourcePlan {
  const prepared = structuredClone(selectors);
  for (const reference of prepared.references) {
    reference.import_scope ??= {
      mode: "full_acceptance_procedure",
      allowed_fields: ["name", "requirement", "method", "quantity", "note", "sampling"],
      reason: "Existing projection fixture explicitly permits every supported imported field.",
    };
  }
  return hydrateSemanticSourcePlan(compileTargetSelectors(prepared, registry, manifest), manifest);
}

describe("typed reference projection contract", () => {
  test("does not expose the retired expand_items mode to selector authors", () => {
    expect(JSON.stringify(TARGET_SELECTOR_PLAN_JSON_SCHEMA)).not.toContain("expand_items");
  });

  test("requires an explicit import_scope on every new selector reference", () => {
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: "构件应符合目标条款。", primary: true },
      { evidence_id: "atom:target", text: "目标条款实质要求。" },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: "构件应符合目标条款。", key: "anchor" },
      { evidence_id: "atom:target", quote: "目标条款实质要求。", key: "target" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "missing-import-scope",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "adopt",
      application_mode: "reference_only",
      destinations: [
        { item_key: "item", target_field: "requirement" },
        { item_key: "item", target_field: "method" },
      ],
      reason: "故意省略新的必填导入范围",
    } as never);

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({
          code: "selector_schema",
          path: "/references/0/import_scope",
          details: expect.objectContaining({
            actual_present: false,
            expected: expect.objectContaining({ required: ["mode", "allowed_fields", "reason"] }),
            writable_path: "/references/0/import_scope",
          }),
        })]),
      }) as TargetSelectorCompileError,
    );
  });

  test("full acceptance procedure permits referenced sampling declared by the Agent", () => {
    const localText = "构件应合格。检验应符合目标附录的规定。";
    const targetText = "检查数量为每批一次。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: localText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: "构件应合格。", key: "criterion" },
      { evidence_id: "atom:anchor", quote: "检验应符合目标附录的规定。", key: "literal" },
      { evidence_id: "atom:target", quote: targetText, key: "target" },
    ]);
    manifest.reference_occurrences = [{
      occurrence_id: "reference:full-procedure",
      origin_evidence_id: "atom:anchor",
      reference_literal_span_id: registered.ids.get("literal")!,
      reference_literal: {
        evidence_id: "atom:anchor",
        start: localText.indexOf("检验应符合目标附录的规定。"),
        end: localText.indexOf("检验应符合目标附录的规定。") + "检验应符合目标附录的规定。".length,
      },
      origin_fields: ["requirement"],
      raw_reference: "目标附录",
      target_evidence_ids: ["atom:target"],
      required: true,
      status: "resolved",
      depth: 1,
      path: ["appendix:target"],
      reference_kind: "clause",
      target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "appendix:target" },
    }];
    const selectors = baseSelectors(manifest, registered.ids.get("criterion")!);
    selectors.items[0]!.fields.requirement.span_ids = [registered.ids.get("criterion")!, registered.ids.get("literal")!];
    selectors.items[0]!.sampling = {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [registered.ids.get("target")!],
      script_span_ids: [registered.ids.get("target")!],
      condition_span_ids: [],
      reason: "被引附录提供完整抽样程序",
      confidence: 1,
    };
    selectors.references.push({
      key: "full-procedure",
      occurrence_id: "reference:full-procedure",
      anchor_span_ids: [registered.ids.get("literal")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: {
        mode: "full_acceptance_procedure",
        allowed_fields: ["requirement", "method", "quantity", "sampling"],
        reason: "本地引用委托目标附录规定的完整验收程序。",
      },
      destinations: [
        { item_key: "item", target_field: "requirement" },
        { item_key: "item", target_field: "method" },
      ],
      reason: "保留本地引用并导入完整程序",
    });

    const persisted = compileTargetSelectors(selectors, registered.registry, manifest);
    const validation = validatePlanText(JSON.stringify(persisted), manifest);
    expect(validation).toMatchObject({ ok: true, issues: [] });
    expect(materialize(persisted, manifest, validation.fingerprint!).result.inspection_lots[0]!.items[0]!.requirement)
      .toContain("构件应合格。");
    expect(persisted.reference_resolutions[0]).toMatchObject({
      origin_binding: { target_field: "requirement" },
      destination_bindings: expect.arrayContaining([
        expect.objectContaining({ target_field: "requirement" }),
        expect.objectContaining({ target_field: "method" }),
      ]),
    });
    expect(persisted.reference_resolutions[0]!.import_scope).toEqual(selectors.references[0]!.import_scope);
    expect(persisted.semantic_references![0]!.import_scope).toEqual(selectors.references[0]!.import_scope);
    expect(hydrateSemanticSourcePlan(persisted, manifest).reference_resolutions[0]!.import_scope)
      .toEqual(selectors.references[0]!.import_scope);
    expect(materialize(persisted, manifest, validation.fingerprint!).result.inspection_lots[0]!.items[0]!.inline_references[0]!.import_scope)
      .toEqual(selectors.references[0]!.import_scope);
    const missingTargetEvidence = structuredClone(persisted);
    missingTargetEvidence.reference_resolutions[0]!.target_evidence_ids = [];
    expect(validatePlanText(JSON.stringify(missingTargetEvidence), manifest).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "reference_resolved_target_required" })]));
  });

  test("origin quantity binding remains separate from an allowed referenced method destination", () => {
    const localText = "构件应合格。检查数量按目标条款确定。";
    const targetText = "检查方法为量测。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: localText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: "构件应合格。", key: "criterion" },
      { evidence_id: "atom:anchor", quote: "检查数量按目标条款确定。", key: "literal" },
      { evidence_id: "atom:target", quote: targetText, key: "target" },
    ]);
    manifest.reference_occurrences = [{
      occurrence_id: "reference:quantity-only",
      origin_evidence_id: "atom:anchor",
      reference_literal_span_id: registered.ids.get("literal")!,
      origin_fields: ["quantity"],
      raw_reference: "目标条款",
      target_evidence_ids: ["atom:target"],
      required: true,
      status: "resolved",
      depth: 1,
      path: ["clause:target"],
      reference_kind: "clause",
      target_address: { source_id: manifest.source.sha256, locator_kind: "clause", locator: "clause:target" },
    }];
    const selectors = baseSelectors(manifest, registered.ids.get("criterion")!);
    selectors.items[0]!.fields.quantity = { composition: "verbatim", span_ids: [registered.ids.get("literal")!], separator: "", reason: "本地数量引用" };
    selectors.items[0]!.fields.method = { composition: "verbatim", span_ids: [registered.ids.get("target")!], separator: "", reason: "故意越界导入被引方法" };
    selectors.references.push({
      key: "quantity-only",
      occurrence_id: "reference:quantity-only",
      anchor_span_ids: [registered.ids.get("literal")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "adopt",
      application_mode: "reference_only",
      import_scope: {
        mode: "field_specific",
        allowed_fields: ["quantity", "sampling"],
        reason: "本地引用只委托检查数量和抽样程序。",
      },
      destinations: [{ item_key: "item", target_field: "quantity" }],
      reason: "保留本地数量引用",
    });

    const persisted = compileTargetSelectors(selectors, registered.registry, manifest);
    expect(validatePlanText(JSON.stringify(persisted), manifest).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "reference_import_scope_exceeded",
        details: expect.objectContaining({ outside_import_scope: ["method"] }),
      }),
    ]));
    const originDrift = structuredClone(persisted);
    originDrift.reference_resolutions[0]!.import_scope.allowed_fields.push("method");
    originDrift.reference_resolutions[0]!.destination_bindings[0]!.target_field = "method";
    expect(originDrift.reference_resolutions[0]!.origin_binding).toMatchObject({ target_field: "quantity" });
    expect(validatePlanText(JSON.stringify(originDrift), manifest).issues)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "reference_destination_field_mismatch" })]));
  });

  test("empty origin candidates return evidence, bindings, and writable repair routes instead of an impossible choice", () => {
    const manifest = manifestFor([
      { evidence_id: "atom:local", text: "构件应合格。", primary: true },
      { evidence_id: "atom:origin-a", text: "检验要求应符合本规范附录" },
      { evidence_id: "atom:origin-b", text: "B 的规定。" },
      { evidence_id: "atom:target", text: "B.1 判定要求。" },
    ]);
    manifest.evidence[1] = { ...manifest.evidence[1]!, locator: "line:10", atom_id: "atom:shared", clause_id: "9.2.2" };
    manifest.evidence[2] = { ...manifest.evidence[2]!, locator: "line:12", atom_id: "atom:shared", clause_id: "9.2.2" };
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:local", quote: "构件应合格。", key: "criterion" },
      { evidence_id: "atom:origin-a", quote: "检验要求应符合本规范附录", key: "origin-a" },
      { evidence_id: "atom:origin-a", quote: "本规范附录", key: "literal-a" },
      { evidence_id: "atom:origin-b", quote: "B 的规定。", key: "origin-b" },
      { evidence_id: "atom:origin-b", quote: "B", key: "literal-b" },
      { evidence_id: "atom:target", quote: "B.1 判定要求。", key: "target" },
    ]);
    manifest.reference_occurrences = [{
      occurrence_id: "reference:split-b",
      origin_evidence_id: "atom:origin-a",
      origin_evidence_ids: ["atom:origin-a", "atom:origin-b"],
      origin_span_id: registered.ids.get("origin-a")!,
      origin_span_ids: [registered.ids.get("origin-a")!, registered.ids.get("origin-b")!],
      reference_literal_span_id: registered.ids.get("literal-a")!,
      reference_literal_span_ids: [registered.ids.get("literal-a")!, registered.ids.get("literal-b")!],
      reference_literal: { evidence_id: "atom:origin-a", start: "检验要求应符合本规范附录".indexOf("本规范附录"), end: "检验要求应符合本规范附录".length },
      reference_literals: [
        { evidence_id: "atom:origin-a", start: "检验要求应符合本规范附录".indexOf("本规范附录"), end: "检验要求应符合本规范附录".length },
        { evidence_id: "atom:origin-b", start: 0, end: 1 },
      ],
      origin_fields: ["requirement"], raw_reference: "本规范附录B", normalized_reference: "本规范附录 B",
      target_evidence_ids: ["atom:target"], required: true, status: "resolved", depth: 1, path: ["appendix:B"],
      reference_kind: "clause", target_address: { source_id: manifest.source.sha256, locator_kind: "appendix", locator: "appendix:B" },
    }];
    const selectors = baseSelectors(manifest, registered.ids.get("criterion")!);
    selectors.references.push({
      key: "split-b", occurrence_id: "reference:split-b",
      anchor_span_ids: [registered.ids.get("literal-a")!, registered.ids.get("literal-b")!],
      target_span_ids: [registered.ids.get("target")!], action: "adopt", application_mode: "reference_only",
      import_scope: { mode: "full_acceptance_procedure", allowed_fields: ["requirement", "method"], reason: "B.1 与 B.2 分别提供判定和方法。" },
      destinations: [{ item_key: "item", target_field: "requirement" }, { item_key: "item", target_field: "method" }],
      reason: "组合引用等待本地 origin 字段补全。",
    });
    try {
      compileTargetSelectors(selectors, registered.registry, manifest);
      throw new Error("Expected missing origin binding candidates to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_reference_origin_binding_missing",
          path: "/references/0/origin_binding",
          details: expect.objectContaining({
            candidate_target_fields: [],
            adjacent_source_window: expect.arrayContaining([expect.objectContaining({ text: "B 的规定。" })]),
            current_item_field_bindings: expect.any(Array),
            repair_options: expect.arrayContaining([expect.objectContaining({ kind: "fix_immutable_occurrence", next_tool: "resolve_document_reference" })]),
            required_action: "repair_local_field_binding_or_reresolve_occurrence_do_not_choose_from_empty_list",
          }),
        }),
      ]));
    }
  });

  test("reference_only exposes only the table row owned by each authored item", () => {
    const item = {
      table_semantics: {
        cell_evidence: [{ role: "allowed_value", evidence_id: "cell:a" }],
        reference_fragments: [],
      },
    } as unknown as SemanticSourcePlan["acceptance_items"][number];
    const occurrence = {
      target_evidence_ids: ["row:a", "row:b"],
    } as unknown as EvidenceManifest["reference_occurrences"][number];
    const records = new Map([
      ["cell:a", { locator: "line:10/table-row:2" }],
      ["row:a", { locator: "line:10/table:5.5.3/row:2" }],
      ["row:b", { locator: "line:10/table:5.5.3/row:3" }],
    ]) as never;

    expect(inlineReferenceEvidenceIdsForItem(item, occurrence, records)).toEqual(["row:a"]);
    expect(inlineReferenceEvidenceIdsForItem({ table_semantics: null } as never, occurrence))
      .toEqual(["row:a", "row:b"]);
  });

  test("rejects a pure reference-only anchor used as a visible requirement", () => {
    const anchorText = "构件应符合引用规定。";
    const targetText = "引用规定的实质要求。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: targetText, key: "target" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "reference-only-anchor",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "引用锚点只能作为来源，不得冒充可见要求",
    });

    expect(() => compile(selectors, registered.registry, manifest)).toThrow();
  });

  test("rejects authored replace_field instead of projecting it into visible fields", () => {
    const anchorText = "构件表面应符合引用规定。";
    const targetText = "构件表面应平整、洁净。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: targetText, key: "target" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "prose-reference",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "adopt",
      application_mode: "replace_field",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "目标条款替换本地引用话述",
    } as TargetSelectorPlan["references"][number]);

    try {
      compile(selectors, registered.registry, manifest);
      throw new Error("expected selector compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_reference_replace_field_forbidden",
        path: "/references/0/application_mode",
      }));
    }
  });

  test("rejects a structural table navigation line projected into authoritative visible fields", () => {
    const anchorText = "构件按引用表执行。";
    const targetText = "编号 导航标题\n\n<table><tr><td>项目</td><td>允许值</td></tr><tr><td>长度</td><td>2</td></tr></table>";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: "编号", key: "table-no" },
      { evidence_id: "atom:target", quote: "导航标题", key: "title" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "table-navigation-projection",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("title")!],
      action: "adopt",
      application_mode: "replace_field",
      destinations: [
        { item_key: "item", target_field: "requirement" },
        { item_key: "item", target_field: "method" },
      ],
      reason: "A navigation line cannot stand in for table judgments",
    } as TargetSelectorPlan["references"][number]);

    try {
      compile(selectors, registered.registry, manifest);
      throw new Error("expected selector compilation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        issues: [expect.objectContaining({
          code: "selector_reference_replace_field_forbidden",
          path: "/references/0/application_mode",
        })],
      });
    }
  });

  test("rejects structural reference-only navigation without a resolved occurrence", () => {
    const anchorText = "构件按引用表执行。";
    const targetText = "编号 导航标题\n\n<table><tr><td>项目</td><td>允许值</td></tr></table>";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: "编号", key: "table-no" },
      { evidence_id: "atom:target", quote: "导航标题", key: "title" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "table-navigation-only",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("title")!],
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "Navigation-only provenance remains legal",
    });

    expect(() => compile(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
  });

  test("does not classify an unpartitioned exact prose clause as navigation merely because a table follows", () => {
    const anchorText = "构件按引用条款执行。";
    const clause = "构件应保持平整并按实测值验收。";
    const targetText = `${clause}\n\n<table><tr><td>记录</td></tr></table>`;
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const localRequirement = "按引用条款执行。";
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:anchor", quote: localRequirement, key: "local-requirement" },
      { evidence_id: "atom:target", quote: clause, key: "clause" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.items[0]!.fields.requirement.span_ids = [registered.ids.get("local-requirement")!];
    selectors.references.push({
      key: "adjacent-prose-clause",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("clause")!],
      action: "adopt",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "Exact prose remains authoritative even when followed by a table",
    });

    const item = compile(selectors, registered.registry, manifest).acceptance_items[0];
    expect(item?.requirement).toBe(localRequirement);
    expect(item?.requirement).not.toBe(clause);
  });

  const assemblyRevisionRoot = resolve(
    "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A3824d7428378f5b113c9abb4/revisions/000001",
  );
  test.runIf(existsSync(resolve(assemblyRevisionRoot, "last-valid.target-selectors.json")))(
    "rejects the GB50576 Table C.0.1 title projection at the reference target path",
    () => {
      const manifest = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "evidence/evidence.json"),
        "utf8",
      )) as EvidenceManifest;
      const registry = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "source-span-registry.json"),
        "utf8",
      )) as SourceSpanRegistry;
      const selectors = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "last-valid.target-selectors.json"),
        "utf8",
      )) as TargetSelectorPlan;

      try {
        compileTargetSelectors(selectors, registry, manifest);
        throw new Error("expected selector compilation to fail");
      } catch (error) {
        const issues = (error as { issues?: Array<Record<string, unknown>> }).issues ?? [];
        expect(issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: "selector_reference_table_navigation_visible_field_projection",
            path: "/references/0/target_span_ids/0",
            details: expect.objectContaining({
              destination_bindings: [
                expect.objectContaining({ path: "/references/0/destinations/0" }),
                expect.objectContaining({ path: "/references/0/destinations/1" }),
              ],
            }),
          }),
        ]));
      }
    },
  );

  test.runIf(existsSync(resolve(assemblyRevisionRoot, "last-valid.target-selectors.json")))(
    "compiles a real-derived Table C.0.1 repair as six independently typed table leaves",
    () => {
      const manifest = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "evidence/evidence.json"),
        "utf8",
      )) as EvidenceManifest;
      let registry = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "source-span-registry.json"),
        "utf8",
      )) as SourceSpanRegistry;
      const selectors = JSON.parse(readFileSync(
        resolve(assemblyRevisionRoot, "last-valid.target-selectors.json"),
        "utf8",
      )) as TargetSelectorPlan;
      const badReference = selectors.references.find((reference) =>
        reference.key === "unit-component-assembly-table-c-0-1"
      )!;
      const titleRecord = registry.spans.find((span) => span.span_id === badReference.target_span_ids[0])!;
      const sourceRecord = manifest.evidence.find((record) => record.evidence_id === titleRecord.evidence_id)!;
      const source = {
        source_id: sourceRecord.evidence_id,
        evidence_id: sourceRecord.evidence_id,
        atom_id: sourceRecord.evidence_id,
        text: sourceRecord.text,
      };
      const cells = htmlTableCellSpans(sourceRecord.text).filter((cell) => cell.table_index === 0);
      const spanByCell = new Map<string, string>();
      for (const cell of cells) {
        const registered = registerSourceSpan(registry, source, cell.start, cell.end);
        registry = registered.registry;
        spanByCell.set(`${cell.row_index}:${cell.column_index}`, registered.span.span_id);
      }
      const tableNumber = registerSourceSpan(registry, source, 345, 352);
      registry = tableNumber.registry;
      const tableTitle = registerSourceSpan(registry, source, 353, 364);
      registry = tableTitle.registry;

      const origin = selectors.items.find((item) => item.key === "unit-component-assembly-deviation")!;
      selectors.references = selectors.references.filter((reference) => reference !== badReference);
      selectors.items = selectors.items.filter((item) => item !== origin);
      const groups = [
        { propertyRow: 1, rows: [1, 2] },
        { propertyRow: 3, rows: [3, 4] },
        { propertyRow: 5, rows: [5, 6] },
        { propertyRow: 7, rows: [7] },
        { propertyRow: 8, rows: [8] },
        { propertyRow: 9, rows: [9] },
      ];
      const requiredCell = (row: number, column: number): string => {
        const spanId = spanByCell.get(`${row}:${column}`);
        expect(spanId, `Table C.0.1 cell ${row}:${column}`).toBeTruthy();
        return spanId!;
      };
      for (const [index, group] of groups.entries()) {
        const property = requiredCell(group.propertyRow, 1);
        const conditions = group.rows.map((row) => requiredCell(row, 2));
        const values = group.rows.map((row) => requiredCell(row, 3));
        const method = requiredCell(group.propertyRow, 4);
        selectors.items.push({
          ...structuredClone(origin),
          key: `unit-component-assembly-table-c-0-1-leaf-${index + 1}`,
          name: `Table C.0.1 criterion ${index + 1}`,
          criterion_span_ids: [origin.criterion_span_ids[0]!, property, ...conditions, ...values, method],
          fields: {
            ...structuredClone(origin.fields),
            name: { composition: "semantic_summary", span_ids: [property], separator: "", reason: "Exact row property names this leaf" },
            requirement: { composition: "verbatim", span_ids: values, separator: " / ", reason: "Exact allowed-value cells govern this leaf" },
            method: { composition: "verbatim", span_ids: [method], separator: "", reason: "Exact method cell governs this leaf" },
          },
          table: {
            source_kind: "direct",
            table_key: "unit-component-assembly-table-c-0-1",
            properties: {
              table_no_span_ids: [tableNumber.span.span_id],
              table_title_span_ids: [tableTitle.span.span_id],
              applicability_span_ids: [origin.criterion_span_ids[0]!],
              row_path_span_ids: [[property]],
              column_path_span_ids: [[requiredCell(0, 3)]],
              unit_span_ids: [],
              condition_span_ids: conditions,
              allowed_value_span_ids: values,
              inspection_method_span_ids: [method],
            },
            reference_span_ids: [...badReference.anchor_span_ids],
            reason: "One independently executable Table C.0.1 property leaf",
          },
          inspection_data_type_span_ids: [property, ...values],
          reason: "Real-derived typed repair with one leaf per independent table property",
        });
      }

      const plan = compile(selectors, registry, manifest);
      const repairedItems = plan.acceptance_items.filter((item) =>
        item.table_semantics?.table_title === sourceRecord.text.slice(353, 364)
      );
      expect(repairedItems).toHaveLength(6);
      expect(new Set(repairedItems.map((item) => item.table_semantics?.row_path.join(" / "))).size).toBe(6);
      expect(repairedItems.every((item) => (
        item.table_semantics?.allowed_value.length
        && item.table_semantics.inspection_method.length
      ))).toBe(true);
    },
  );

  test("does not infer replace_field ownership from sampling receivers", () => {
    const anchorText = "当前项目采用引用要求。";
    const targetText = "第一项应合格。抽查两个。第二项应合格。抽查三个。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: targetText, key: "target-envelope" },
      { evidence_id: "atom:target", quote: "第一项应合格。", key: "first-criterion" },
      { evidence_id: "atom:target", quote: "抽查两个。", key: "first-sampling" },
      { evidence_id: "atom:target", quote: "第二项应合格。", key: "second-criterion" },
      { evidence_id: "atom:target", quote: "抽查三个。", key: "second-sampling" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    for (const [key, criterionKey, samplingKey] of [
      ["first", "first-criterion", "first-sampling"],
      ["second", "second-criterion", "second-sampling"],
    ] as const) {
      const sourceItem = structuredClone(selectors.items[0]!);
      sourceItem.key = key;
      sourceItem.name = key;
      sourceItem.criterion_span_ids = [registered.ids.get(criterionKey)!];
      sourceItem.fields.name.span_ids = [registered.ids.get(criterionKey)!];
      sourceItem.fields.requirement.span_ids = [registered.ids.get(criterionKey)!];
      sourceItem.fields.quantity = {
        composition: "verbatim",
        span_ids: [registered.ids.get(samplingKey)!],
        separator: "",
        reason: "精确抽样数量",
      };
      sourceItem.inspection_data_type_span_ids = [registered.ids.get(criterionKey)!];
      sourceItem.sampling = {
        status: "explicit",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [registered.ids.get(samplingKey)!],
        script_span_ids: [registered.ids.get(samplingKey)!],
        condition_span_ids: [],
        reason: "仅由该源项目接收",
        confidence: 1,
      };
      selectors.items.push(sourceItem);
    }
    selectors.references.push({
      key: "projected-envelope",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("target-envelope")!],
      action: "adopt",
      application_mode: "replace_field",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "整体目标区间不能把其他项目的抽样规则投影进当前显示字段",
    } as TargetSelectorPlan["references"][number]);

    try {
      compile(selectors, registered.registry, manifest);
    } catch (error) {
      expect((error as TargetSelectorCompileError).issues.map((issue) => issue.code))
        .not.toContain("selector_sampling_source_projected_to_nonreceiver_item");
    }
  });

  test("rejects an unresolved explicit caption route instead of inferring import authority", () => {
    const anchorText = "主体总高度应符合所引用表格。检查数量为四列。检验方法为仪器实测。";
    const captionText = "总高度允许偏差表（mm）";
    const factsText = "相对标高安装 5.0；设计标高安装 10.0。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:caption", text: captionText },
      { evidence_id: "atom:facts", text: factsText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:anchor", quote: "检查数量为四列。", key: "quantity" },
      { evidence_id: "atom:anchor", quote: "检验方法为仪器实测。", key: "method" },
      { evidence_id: "atom:caption", quote: captionText, key: "caption" },
      { evidence_id: "atom:caption", quote: "mm", key: "unit" },
      { evidence_id: "atom:facts", quote: "相对标高安装", key: "row-a" },
      { evidence_id: "atom:facts", quote: "设计标高安装", key: "row-b" },
      { evidence_id: "atom:facts", quote: "5.0", key: "value-a" },
      { evidence_id: "atom:facts", quote: "10.0", key: "value-b" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    const item = selectors.items[0]!;
    item.criterion_span_ids = [
      registered.ids.get("anchor")!,
      registered.ids.get("row-a")!,
      registered.ids.get("row-b")!,
      registered.ids.get("value-a")!,
      registered.ids.get("value-b")!,
    ];
    item.fields.requirement = {
      composition: "verbatim",
      span_ids: [registered.ids.get("value-a")!, registered.ids.get("value-b")!],
      separator: "\n",
      reason: "两个条件各自的允许值",
    };
    item.fields.method = {
      composition: "verbatim",
      span_ids: [registered.ids.get("method")!],
      separator: "",
      reason: "明确检验方法",
    };
    item.fields.quantity = {
      composition: "verbatim",
      span_ids: [registered.ids.get("quantity")!],
      separator: "",
      reason: "明确检查数量",
    };
    item.table = {
      source_kind: "reference",
      table_key: "logical-table",
      properties: {
        table_no_span_ids: [registered.ids.get("caption")!],
        table_title_span_ids: [registered.ids.get("caption")!],
        applicability_span_ids: [registered.ids.get("anchor")!],
        row_path_span_ids: [
          [registered.ids.get("row-a")!],
          [registered.ids.get("row-b")!],
        ],
        column_path_span_ids: [],
        unit_span_ids: [registered.ids.get("unit")!],
        condition_span_ids: [registered.ids.get("row-a")!, registered.ids.get("row-b")!],
        allowed_value_span_ids: [registered.ids.get("value-a")!, registered.ids.get("value-b")!],
        inspection_method_span_ids: [registered.ids.get("method")!],
      },
      reference_span_ids: [registered.ids.get("anchor")!],
      reason: "引用表的行级事实",
    };
    selectors.references.push({
      key: "explicit-table-reference",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("caption")!],
      action: "adopt",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "显式记录引用来源",
    });

    expect(() => compile(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);

    const automaticOnly = structuredClone(selectors);
    automaticOnly.references = [];
    expect(() => compile(automaticOnly, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
  });

  test("rejects reference_only navigation without a materializing occurrence", () => {
    const anchorText = "本项目按引用条款执行。";
    const targetText = "引用来源仅用于导航。";
    const manifest = manifestFor([
      { evidence_id: "atom:anchor", text: anchorText, primary: true },
      { evidence_id: "atom:target", text: targetText },
    ]);
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:anchor", quote: anchorText, key: "anchor" },
      { evidence_id: "atom:target", quote: targetText, key: "target" },
    ]);
    const selectors = baseSelectors(manifest, registered.ids.get("anchor")!);
    selectors.references.push({
      key: "navigation-only",
      anchor_span_ids: [registered.ids.get("anchor")!],
      target_span_ids: [registered.ids.get("target")!],
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "只保留引用来源导航",
    });

    expect(() => compile(selectors, registered.registry, manifest)).toThrow(TargetSelectorCompileError);
  });

  // 一条条文引两张表：两个 occurrence 的 origin_evidence_id 是同一条，锚点分不开。
  // 退路 target_span_ids 在正文路上也不成立——作者能选的跨度落在整块原子上，
  // occurrence.target_evidence_ids 是表的行级证据，两套坐标恒无交集。
  // 形态取自 GB/T 50312 `8.0.7 …表格形式与内容宜符合表 8.0.7-1 和表 8.0.7-2 的规定`。
  function twoTableCitation(): {
    manifest: EvidenceManifest;
    registered: ReturnType<typeof registerQuotes>;
    clauseText: string;
  } {
    const clauseText = "8.0.7 测试记录的表格形式与内容宜符合表 8.0.7-1 和表 8.0.7-2 的规定。";
    const cableAtom = "表 8.0.7-1 电缆性能指标测试记录";
    const fiberAtom = "表 8.0.7-2 光纤性能指标测试记录";
    const manifest = manifestFor([
      { evidence_id: "atom:clause", text: clauseText, primary: true },
      { evidence_id: "atom:cable", text: cableAtom },
      { evidence_id: "atom:fiber", text: fiberAtom },
    ]);
    manifest.reference_occurrences = ["8.0.7-1", "8.0.7-2"].map((tableId) => ({
      occurrence_id: `reference:${tableId}`,
      reference_kind: "table" as const,
      origin_evidence_id: "atom:clause",
      origin_fields: ["requirement" as const],
      raw_reference: `表${tableId}`,
      target_table_id: tableId,
      // 行级证据，作者的跨度落不到这里。
      target_evidence_ids: [`row:${tableId}`],
      required: true,
      status: "resolved" as const,
      depth: 0,
      path: [tableId],
    }));
    const registered = registerQuotes(manifest, [
      { evidence_id: "atom:clause", quote: clauseText, key: "clause" },
      { evidence_id: "atom:cable", quote: cableAtom, key: "cable" },
      { evidence_id: "atom:fiber", quote: fiberAtom, key: "fiber" },
    ]);
    return { manifest, registered, clauseText };
  }

  test("one clause citing two tables stays ambiguous without occurrence_id", () => {
    const { manifest, registered } = twoTableCitation();
    const selectors = baseSelectors(manifest, registered.ids.get("clause")!);
    selectors.references.push({
      key: "ref-cable-record",
      anchor_span_ids: [registered.ids.get("clause")!],
      target_span_ids: [registered.ids.get("cable")!],
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "电缆记录表非本检验批依据，仅保留格式引用。",
    });
    let issues: unknown[] = [];
    try {
      compile(selectors, registered.registry, manifest);
    } catch (error) {
      issues = (error as { issues: unknown[] }).issues;
    }
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_reference_ambiguous" }),
    ]));
  });

  test("occurrence_id names the cited table so a two-table citation resolves", () => {
    const { manifest, registered } = twoTableCitation();
    const selectors = baseSelectors(manifest, registered.ids.get("clause")!);
    selectors.references.push({
      key: "ref-fiber-record",
      anchor_span_ids: [registered.ids.get("clause")!],
      target_span_ids: [registered.ids.get("fiber")!],
      occurrence_id: "reference:8.0.7-2",
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "光纤记录表作为本检验批测试记录格式参照。",
    });
    const plan = compile(selectors, registered.registry, manifest);
    expect(plan.reference_resolutions).toEqual([
      expect.objectContaining({
        occurrence_id: "reference:8.0.7-2",
        application_mode: "reference_only",
      }),
    ]);
  });

  test("occurrence_id must name an occurrence the anchor already covers", () => {
    const { manifest, registered } = twoTableCitation();
    const selectors = baseSelectors(manifest, registered.ids.get("clause")!);
    selectors.references.push({
      key: "ref-unanchored",
      anchor_span_ids: [registered.ids.get("clause")!],
      target_span_ids: [registered.ids.get("fiber")!],
      occurrence_id: "reference:not-anchored-here",
      action: "mention",
      application_mode: "reference_only",
      destinations: [{ item_key: "item", target_field: "requirement" }],
      reason: "点名一个锚点没有覆盖的 occurrence。",
    });
    let issues: unknown[] = [];
    try {
      compile(selectors, registered.registry, manifest);
    } catch (error) {
      issues = (error as { issues: unknown[] }).issues;
    }
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "selector_reference_occurrence_not_found" }),
    ]));
  });
});
