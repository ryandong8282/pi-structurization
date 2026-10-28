import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  htmlTableCellSpans,
  locateAndRegisterSourceQuote,
  registerHtmlTableCellSpans,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";

const officialReplayRoot = join(
  process.cwd(),
  "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A176af3d53841d4fbf8792d67/revisions/000005",
);

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:typed-table-visible-field";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "job:typed-table-visible-field",
    target_id: "target:typed-table-visible-field",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "typed-table-visible-field.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:typed-table-visible-field",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "Exact structural table counterexample",
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
    evidence_fingerprint: sha256Text(`typed-table-visible-field\0${text}`),
  };
}

function tableFixture(): {
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  selectors: TargetSelectorPlan;
  spans: { value: string; method: string };
} {
  const criterion = "验收判据见下表。";
  const row = '<tr><td>构件偏差</td><td>2.0</td><td>用卡尺检查</td></tr>';
  const text = `${criterion}\n<table><tr><td>项目</td><td>允许偏差</td><td>检验方法</td></tr>${row}</table>`;
  const manifest = manifestFor(text);
  const evidenceId = manifest.evidence[0]!.evidence_id;
  const source: ImmutableTextSource = {
    source_id: evidenceId,
    evidence_id: evidenceId,
    atom_id: evidenceId,
    text,
  };
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
  const locate = (quote: string): string => {
    const located = locateAndRegisterSourceQuote(registry, source, quote);
    registry = located.registry;
    return located.spans[0]!.span_id;
  };
  const criterionSpan = locate(criterion);
  const rowSpan = locate(row);
  registry = registerHtmlTableCellSpans(registry, [source]).registry;
  const cellSpan = (value: string): string => {
    const cell = htmlTableCellSpans(text).find((candidate) => candidate.text === value)!;
    return registry.spans.find((span) => (
      span.evidence_id === evidenceId
      && span.start === cell.start
      && span.end === cell.end
    ))!.span_id;
  };
  const fullSpan = registry.spans.find((span) => (
    span.evidence_id === evidenceId && span.start === 0 && span.end === text.length
  ))!.span_id;
  const nameSpan = cellSpan("构件偏差");
  const valueSpan = cellSpan("2.0");
  const methodSpan = cellSpan("用卡尺检查");
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpan], reason: "一个精确范围 fixture" });
  selectors.items.push({
    key: "item",
    lot_key: "lot",
    name: "构件偏差",
    category: "一般项目",
    criterion_span_ids: [criterionSpan],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [nameSpan], separator: "", reason: "精确的业务标签 fixture" },
      requirement: { composition: "verbatim", span_ids: [rowSpan], separator: "", reason: "故意绑定整行原始文本 fixture" },
      method: { composition: "verbatim", span_ids: [rowSpan], separator: "", reason: "故意绑定整行原始文本 fixture" },
      quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "无检查数量 fixture" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
    },
    table: {
      source_kind: "direct",
      table_key: "typed-row",
      properties: {
        table_no_span_ids: [],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[nameSpan]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [valueSpan],
        inspection_method_span_ids: [methodSpan],
      },
      reference_span_ids: [criterionSpan],
      reason: "定型单元格承载该行判定 fixture",
    },
    inspection_data_type: "measurement",
    inspection_data_type_reason: "该取值单元格为量测值 fixture",
    inspection_data_type_span_ids: [valueSpan],
    sampling: {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "无抽样声明 fixture",
      confidence: 1,
    },
    reason: "一条独立的定型表格判定 fixture",
  });
  return { manifest, registry, selectors, spans: { value: valueSpan, method: methodSpan } };
}

describe("visible table-field cell granularity", () => {
  test("anchors cell offsets after the opening tag even when content repeats a span attribute", () => {
    const text = '<table><tr><td colspan="2">2</td><td rowspan="2">2</td></tr><tr><td></td></tr></table>';
    const cells = htmlTableCellSpans(text);
    expect(cells[0]!.start).toBe(text.indexOf(">2<") + 1);
    expect(cells[1]!.start).toBe(text.lastIndexOf(">2<") + 1);
    expect(cells[2]!.start).toBe(text.indexOf("<td></td>") + 4);
    expect(cells[2]!.end).toBe(cells[2]!.start);
  });

  test("rejects a raw row reused by requirement and method when distinct typed cells prove the conflation", () => {
    const fixture = tableFixture();
    try {
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
      throw new Error("expected a typed table-cell role conflation");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "selector_table_visible_field_role_conflation",
          path: "/items/0",
          details: expect.objectContaining({
            conflicting_fields: expect.arrayContaining([
              expect.objectContaining({ field: "requirement" }),
              expect.objectContaining({ field: "method" }),
            ]),
            required_action: "replace_visible_table_container_spans_with_exact_typed_cell_spans_in_source_order",
          }),
        }),
      ]));
    }

    const repaired = structuredClone(fixture.selectors);
    repaired.items[0]!.fields.requirement.span_ids = [fixture.spans.value];
    repaired.items[0]!.fields.method.span_ids = [fixture.spans.method];
    expect(compileTargetSelectors(repaired, fixture.registry, fixture.manifest).acceptance_items[0])
      .toMatchObject({ requirement: "2.0", method: "用卡尺检查" });
  });

  test("allows one indivisible exact prose interval to support both visible roles", () => {
    const text = "观感符合设计要求";
    const manifest = manifestFor(text);
    const evidenceId = manifest.evidence[0]!.evidence_id;
    const source: ImmutableTextSource = { source_id: evidenceId, evidence_id: evidenceId, atom_id: evidenceId, text };
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [source]);
    const spanId = registry.spans[0]!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [spanId], reason: "一个精确范围 fixture" });
    selectors.items.push({
      key: "item",
      lot_key: "lot",
      name: "观感验收",
      category: "一般项目",
      criterion_span_ids: [spanId],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [spanId], separator: "", reason: "精简的业务归纳 fixture" },
        requirement: { composition: "verbatim", span_ids: [spanId], separator: "", reason: "一句不可再分的精确原文 fixture" },
        method: { composition: "verbatim", span_ids: [spanId], separator: "", reason: "一句不可再分的精确原文 fixture" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "无检查数量 fixture" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
      },
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "未登记更细的结构角色边界 fixture",
      inspection_data_type_span_ids: [spanId],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "无抽样声明 fixture",
        confidence: 1,
      },
      reason: "不可再分的正文反例 fixture",
    });
    expect(compileTargetSelectors(selectors, registry, manifest).acceptance_items[0])
      .toMatchObject({ requirement: text, method: text });
  });

  test.runIf(existsSync(join(officialReplayRoot, "working.target-selectors.json")))(
    "rejects the four real 176 rev5 truss raw-row bindings and accepts exact cell repairs",
    async () => {
      const [selectors, registry, manifest] = await Promise.all([
        readFile(join(officialReplayRoot, "working.target-selectors.json"), "utf8").then((text) => JSON.parse(text) as TargetSelectorPlan),
        readFile(join(officialReplayRoot, "source-span-registry.json"), "utf8").then((text) => JSON.parse(text) as SourceSpanRegistry),
        readFile(join(officialReplayRoot, "evidence/evidence.json"), "utf8").then((text) => JSON.parse(text) as EvidenceManifest),
      ]);
      const registeredById = new Map(registry.spans.map((span) => [span.span_id, span]));
      const polluted = structuredClone(selectors);
      for (const item of polluted.items.filter((candidate) => candidate.key.startsWith("item-truss-"))) {
        const propertySpanIds = [
          ...item.table!.properties.condition_span_ids,
          ...item.table!.properties.allowed_value_span_ids,
          ...item.table!.properties.inspection_method_span_ids,
        ];
        const propertySpans = propertySpanIds.map((spanId) => registeredById.get(spanId)!);
        const evidenceId = propertySpans[0]!.evidence_id;
        const start = Math.min(...propertySpans.map((span) => span.start));
        const end = Math.max(...propertySpans.map((span) => span.end));
        const rowContainer = registry.spans
          .filter((span) => (
            span.evidence_id === evidenceId
            && span.start <= start
            && span.end >= end
            && (span.start < start || span.end > end)
          ))
          .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]!;
        item.fields.requirement.span_ids = [rowContainer.span_id];
        item.fields.requirement.separator = "";
        item.fields.method.span_ids = [rowContainer.span_id];
        item.fields.method.separator = "";
      }
      let issues: TargetSelectorCompileError["issues"] = [];
      try {
        compileTargetSelectors(polluted, registry, manifest);
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        issues = (error as TargetSelectorCompileError).issues.filter((issue) => (
          issue.code === "selector_table_visible_field_role_conflation"
        ));
      }
      expect(issues).toHaveLength(4);
      expect(issues.map((issue) => (issue.details as { item_key: string }).item_key).sort()).toEqual([
        "item-truss-camber",
        "item-truss-interface-section-misalignment",
        "item-truss-node-member-axis-misalignment",
        "item-truss-outer-support-span",
      ]);

      const repaired = structuredClone(selectors);
      for (const item of repaired.items.filter((candidate) => candidate.key.startsWith("item-truss-"))) {
        const properties = item.table!.properties;
        item.fields.requirement.span_ids = [
          ...properties.condition_span_ids,
          ...properties.allowed_value_span_ids,
        ].sort((left, right) => registeredById.get(left)!.start - registeredById.get(right)!.start);
        item.fields.requirement.separator = "；";
        item.fields.method.span_ids = [...properties.inspection_method_span_ids];
      }
      const compiled = compileTargetSelectors(repaired, registry, manifest);
      const trussItemIds = new Set([
        "item:78e0e37502a551888822",
        "item:b8986e107ceced4dbc04",
        "item:13d03e2bf89616ae9d36",
        "item:fd54f7bb57c1f306c1c3",
      ]);
      const trussItems = compiled.acceptance_items.filter((item) => trussItemIds.has(item.item_id));
      expect(trussItems).toHaveLength(4);
      expect(trussItems.every((item) => !item.requirement.includes("<tr>") && !item.method.includes("<tr>")))
        .toBe(true);
    },
  );
});
