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
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { materialize } from "../src/materializer.js";
import { validatePlanText } from "../src/validator.js";
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";

const replayRevision = join(
  process.cwd(),
  "data", "jobs", "20260812-161216-c005", "pi-agent", "jobs", "20260812-161216-c005",
  "targets", "target_3A056505dae2e7e713c865f3fe", "revisions", "000002",
);

const replayWholeSourceSpanId = "span:e7acef7600e968d6460316dc2f374b4a";

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:inline-sampling";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "inline-sampling-job",
    target_id: "inline-sampling-target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "inline-sampling-target",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
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
    evidence_fingerprint: sha256Text(`inline-sampling\0${text}`),
  };
}

function registerQuotes(
  manifest: EvidenceManifest,
  quotes: string[],
): { registry: SourceSpanRegistry; ids: Map<string, string> } {
  const source = manifest.evidence[0]!;
  const immutableSource: ImmutableTextSource = {
    source_id: source.evidence_id,
    evidence_id: source.evidence_id,
    atom_id: source.evidence_id,
    text: source.text,
  };
  let registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, [immutableSource]);
  const ids = new Map<string, string>();
  for (const quote of quotes) {
    const located = locateAndRegisterSourceQuote(registry, immutableSource, quote);
    registry = located.registry;
    ids.set(quote, located.spans[0]!.span_id);
  }
  return { registry, ids };
}

function addExplicitItem(
  selectors: TargetSelectorPlan,
  input: {
    key: string;
    criterion_span_id: string;
    quantity_span_id: string;
    script_span_id: string;
  },
): void {
  selectors.items.push({
    key: input.key,
    lot_key: "lot",
    name: `验收项目 item ${input.key}`,
    category: "一般项目",
    criterion_span_ids: [input.criterion_span_id],
    continuation_span_ids: [],
    fields: {
      name: { composition: "semantic_summary", span_ids: [input.criterion_span_id], separator: "", reason: "独立验收对象 fixture" },
      requirement: { composition: "verbatim", span_ids: [input.criterion_span_id], separator: "", reason: "验收要求原文 fixture" },
      method: { composition: "verbatim", span_ids: [input.script_span_id], separator: "", reason: "检查方法原文 fixture" },
      quantity: { composition: "verbatim", span_ids: [input.quantity_span_id], separator: "", reason: "检查数量原文 fixture" },
      note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
    },
    table: null,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "检查形成测量或复核结果 fixture",
    inspection_data_type_span_ids: [input.script_span_id],
    sampling: {
      status: "explicit",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [input.quantity_span_id],
      script_span_ids: [input.script_span_id],
      condition_span_ids: [],
      reason: "项内明确给出数量和执行方法 fixture",
      confidence: 1,
    },
    reason: "独立验收判断 fixture",
  });
}

describe("inline sampling scalar span granularity", () => {
  test.each([
    ["检查数量：全数检查。", "全"],
    ["检查数量：抽查1%，且不少于3根。", "抽查1%，且不少于3根"],
    ["检查数量：每20m取1点，且不少于5处。", "每20m取1点，且不少于5处"],
  ])("separates derived script from explicit evidence: %s", (quantity, script) => {
    const criterion = "构件尺寸应符合设计要求。";
    const manifest = manifestFor(`${criterion}\n${quantity}`);
    const registered = registerQuotes(manifest, [criterion, quantity]);
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "尺寸检验批", scope_span_ids: [registered.ids.get(criterion)!], reason: "构件尺寸范围" });
    addExplicitItem(selectors, {
      key: "dimension",
      criterion_span_id: registered.ids.get(criterion)!,
      quantity_span_id: registered.ids.get(quantity)!,
      script_span_id: registered.ids.get(quantity)!,
    });
    selectors.items[0]!.fields.method = { composition: "not_applicable", span_ids: [], separator: "", reason: "原文未规定检验方法" };
    const plan = hydrateSemanticSourcePlan(compileTargetSelectors(selectors, registered.registry, manifest), manifest);
    const sampling = plan.acceptance_items[0]!.sampling;
    expect(sampling.min_sampling).toBe(quantity);
    expect(sampling.script).toBe(script);
    expect(sampling.applied_branches![0]!.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "quantity", source_fragments: [expect.objectContaining({ text: quantity })] }),
    ]));
    const validation = validatePlanText(JSON.stringify(compileTargetSelectors(selectors, registered.registry, manifest)), manifest);
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
    const delivered = materialize(plan, manifest, "sampling-regression").result.inspection_lots[0]!.items[0]!.sampling;
    expect(delivered).toMatchObject({ min_sampling: quantity, script });
    expect(delivered.applied_branches).toEqual(sampling.applied_branches);
    plan.acceptance_items[0]!.sampling.script = quantity;
    plan.acceptance_items[0]!.sampling.applied_branches![0]!.script = quantity;
    const legacy = materialize(plan, manifest, "legacy-sampling-regression").result.inspection_lots[0]!.items[0]!.sampling;
    expect(legacy.script).toBe("");
    expect(legacy.applied_branches![0]!.script).toBe("");
    expect(legacy.applied_branches![0]!.components).toEqual(sampling.applied_branches![0]!.components);
  });
  test.runIf(existsSync(replayRevision))(
    "rejects the real 056 multi-item source-window binding before it reaches compilation",
    async () => {
      const [manifest, registry, selectors] = await Promise.all([
        readFile(join(replayRevision, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
        readFile(join(replayRevision, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
        readFile(join(replayRevision, "target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
      ]);

      try {
        compileTargetSelectors(selectors, registry, manifest);
        throw new Error("expected the multi-item scalar bindings to fail preflight");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetSelectorCompileError);
        const issues = (error as TargetSelectorCompileError).issues.filter((issue) => (
          issue.code === "selector_scalar_span_crosses_item_boundaries"
        ));
        expect(issues).toHaveLength(4);
        expect(issues.map((issue) => issue.path)).toEqual([
          "/items/0", "/items/1", "/items/2", "/items/3",
        ]);
        issues.forEach((issue, itemIndex) => {
          const details = issue.details as {
            offending_binding: { span_id: string };
            affected_paths: string[];
            contained_item_bindings: Array<{ item_key: string }>;
            required_action: string;
          };
          expect(details.offending_binding.span_id).toBe(replayWholeSourceSpanId);
          expect(details.affected_paths).toEqual([
            `/items/${itemIndex}/fields/quantity/span_ids/0`,
            `/items/${itemIndex}/sampling/quantity_span_ids/0`,
            `/items/${itemIndex}/sampling/script_span_ids/0`,
          ]);
          expect(details.contained_item_bindings.map((binding) => binding.item_key)).toEqual(
            expect.arrayContaining([
              "bolt_sphere_raw_material",
              "bolt_sphere_surface_defects",
              "bolt_sphere_thread_basic_size",
              "bolt_sphere_thread_tolerance",
            ]),
          );
          expect(details.required_action).toBe("locate_exact_role_spans_and_replace_affected_bindings");
        });
      }
    },
  );

  test("does not reject a large plain-text source solely because one item owns the source window", () => {
    const criterion = `single item source ${"neutral content ".repeat(700)} final check.`;
    const quantity = "检查数量:全数检查。";
    const method = "检验方法:观察检查。";
    const text = `${criterion}\n${quantity}\n${method}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [criterion, quantity, method]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "单项证据范围 fixture" });
    addExplicitItem(selectors, {
      key: "single-large-item",
      criterion_span_id: registered.ids.get(criterion)!,
      quantity_span_id: registered.ids.get(quantity)!,
      script_span_id: registered.ids.get(method)!,
    });

    expect(() => compileTargetSelectors(selectors, registered.registry, manifest)).not.toThrow();
  });

  test("keeps exact ordinary plain-text spans valid without formal table fragments", () => {
    const firstRequirement = "第一项验收要求。";
    const secondRequirement = "第二项验收要求。";
    const firstClause = `${firstRequirement}检查数量甲。检验方法甲。`;
    const secondClause = `${secondRequirement}检查数量乙。检验方法乙。`;
    const text = `${firstClause}\n${secondClause}`;
    const manifest = manifestFor(text);
    const registered = registerQuotes(manifest, [
      firstClause,
      secondClause,
      firstRequirement,
      secondRequirement,
      "检查数量甲。",
      "检验方法甲。",
      "检查数量乙。",
      "检验方法乙。",
    ]);
    const fullSpanId = registered.registry.spans.find((span) => (
      span.start === 0 && span.end === text.length
    ))!.span_id;
    const selectors = initialTargetSelectorPlan(manifest);
    selectors.lots.push({ key: "lot", name: "检验批 lot", scope_span_ids: [fullSpanId], reason: "普通文本证据范围 fixture" });
    addExplicitItem(selectors, {
      key: "first",
      criterion_span_id: registered.ids.get(firstRequirement)!,
      quantity_span_id: registered.ids.get("检查数量甲。")!,
      script_span_id: registered.ids.get("检验方法甲。")!,
    });
    addExplicitItem(selectors, {
      key: "second",
      criterion_span_id: registered.ids.get(secondRequirement)!,
      quantity_span_id: registered.ids.get("检查数量乙。")!,
      script_span_id: registered.ids.get("检验方法乙。")!,
    });

    const hydrated = hydrateSemanticSourcePlan(
      compileTargetSelectors(selectors, registered.registry, manifest),
      manifest,
    );
    expect(hydrated.acceptance_items.map((item) => item.quantity)).toEqual([
      "检查数量甲。",
      "检查数量乙。",
    ]);
    expect(manifest.table_fragments).toEqual([]);
  });
});
