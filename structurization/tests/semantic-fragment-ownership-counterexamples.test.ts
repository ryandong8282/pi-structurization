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
import {
  compileTargetSelectors,
  initialTargetSelectorPlan,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { checkTargetCompilerInvariants } from "../src/target-compiler-invariants.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";

const officialFailedReplayRoot = join(
  process.cwd(),
  "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A748abda913bf42c3f8152a7d/revisions/000004",
);
const officialCurrentReplayRoot = join(
  process.cwd(),
  "data/jobs/20260814-091359-a3ad/pi-agent/jobs/20260814-091359-a3ad/targets/target_3A748abda913bf42c3f8152a7d/revisions/000005",
);

async function readOfficialReplay(root: string): Promise<{
  selectors: TargetSelectorPlan;
  registry: SourceSpanRegistry;
  manifest: EvidenceManifest;
}> {
  const [selectors, registry, manifest] = await Promise.all([
    readFile(join(root, "working.target-selectors.json"), "utf8").then((text) => JSON.parse(text) as TargetSelectorPlan),
    readFile(join(root, "source-span-registry.json"), "utf8").then((text) => JSON.parse(text) as SourceSpanRegistry),
    readFile(join(root, "evidence/evidence.json"), "utf8").then((text) => JSON.parse(text) as EvidenceManifest),
  ]);
  return { selectors, registry, manifest };
}

function syntheticFixture(): {
  manifest: EvidenceManifest;
  registry: SourceSpanRegistry;
  selectors: TargetSelectorPlan;
  spans: { whole: string; area: string; gap: string };
} {
  const evidenceId = "atom:semantic-fragment-split";
  const text = "验收要求：紧贴面积不应小于75%，边缘间隙不应大于0.8mm。";
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "semantic-fragment-job",
    target_id: "target:semantic-fragment",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "semantic-fragment.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:semantic-fragment",
      source_line_count: 1,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: "Exact structural counterexample",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "acceptance_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`semantic-fragment\0${text}`),
  };
  const source = {
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
  const spans = {
    whole: locate(text),
    area: locate("紧贴面积不应小于75%"),
    gap: locate("边缘间隙不应大于0.8mm"),
  };
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({ key: "lot", name: "连接面", scope_span_ids: [spans.whole], reason: "一个精确范围 fixture" });
  const addItem = (key: string, name: string, requirementSpanId: string): void => {
    selectors.items.push({
      key,
      lot_key: "lot",
      name,
      category: "一般项目",
      criterion_span_ids: [spans.whole],
      continuation_span_ids: [],
      fields: {
        name: { composition: "semantic_summary", span_ids: [requirementSpanId], separator: "", reason: "精简的受检概念 fixture" },
        requirement: { composition: "verbatim", span_ids: [requirementSpanId], separator: "", reason: "精确的验收要求 fixture" },
        method: { composition: "not_applicable", span_ids: [], separator: "", reason: "无检验方法 fixture" },
        quantity: { composition: "not_applicable", span_ids: [], separator: "", reason: "无检查数量 fixture" },
        note: { composition: "not_applicable", span_ids: [], separator: "", reason: "无备注 fixture" },
      },
      table: null,
      inspection_data_type: "measurement",
      inspection_data_type_reason: "该判据是可量测的限值 fixture",
      inspection_data_type_span_ids: [requirementSpanId],
      sampling: {
        status: "fallback",
        rule_key: "",
        branch_keys: [],
        quantity_span_ids: [],
        script_span_ids: [],
        condition_span_ids: [],
        reason: "无抽样表述 fixture",
        confidence: 1,
      },
      reason: "一条可独立检验的判据 fixture",
    });
  };
  addItem("area", "紧贴面积", spans.area);
  addItem("gap", "边缘间隙", spans.gap);
  return { manifest, registry, selectors, spans };
}

describe("semantic item fragment ownership", () => {
  test.skipIf(!existsSync(join(officialFailedReplayRoot, "working.target-selectors.json")))(
    "routes the official disjoint criterion replay to its selector path",
    async () => {
      const { selectors, registry, manifest } = await readOfficialReplay(officialFailedReplayRoot);
      expect(() => compileTargetSelectors(selectors, registry, manifest)).toThrow(TargetSelectorCompileError);
      try {
        compileTargetSelectors(selectors, registry, manifest);
      } catch (error) {
        expect((error as TargetSelectorCompileError).issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: "selector_criterion_not_materialized",
            path: "/items/13/criterion_span_ids/0",
            details: expect.objectContaining({ required_action: "replace_criterion_or_bind_it_to_the_same_item" }),
          }),
        ]));
      }
    },
  );

  test.skipIf(!existsSync(join(officialCurrentReplayRoot, "working.target-selectors.json")))(
    "keeps the rolled-back revision 5 working selector valid",
    async () => {
      const { selectors, registry, manifest } = await readOfficialReplay(officialCurrentReplayRoot);
      const compiled = hydrateSemanticSourcePlan(
        compileTargetSelectors(selectors, registry, manifest),
        manifest,
      );
      expect(checkTargetCompilerInvariants(selectors, compiled, manifest)).toEqual([]);
    },
  );

  test("rejects a split item whose criterion is disjoint from all of its materializing spans", () => {
    const fixture = syntheticFixture();
    fixture.selectors.items[1]!.criterion_span_ids = [fixture.spans.area];
    expect(() => compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest)).toThrow(TargetSelectorCompileError);
    try {
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest);
    } catch (error) {
      const issue = (error as TargetSelectorCompileError).issues.find(row => row.code === "selector_criterion_not_materialized") as any;
      expect(issue).toMatchObject({
        code: "selector_criterion_not_materialized",
        path: "/items/1/criterion_span_ids/0",
        message: expect.stringMatching(/[\u3400-\u9fff]/),
        details: {
          required_action: "replace_criterion_or_bind_it_to_the_same_item",
          how_to_pass: expect.stringMatching(/[\u3400-\u9fff]/),
          allowed_actions: [expect.stringMatching(/[\u3400-\u9fff]/), expect.stringMatching(/[\u3400-\u9fff]/)],
          candidate_read_tool: "read_target_selectors",
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: fixture.selectors.items[1]!.key },
          next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
        },
      });
      expect(issue.details).not.toHaveProperty("correct_span_id");
      expect(issue.details).not.toHaveProperty("answer");
      expect(issue.details).not.toHaveProperty("canonical_quantity");
    }
  });

  test("allows one complete criterion to fan out when each item carries a contained exact fragment", () => {
    const fixture = syntheticFixture();
    const compiled = hydrateSemanticSourcePlan(
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest),
      fixture.manifest,
    );
    expect(checkTargetCompilerInvariants(fixture.selectors, compiled, fixture.manifest)).toEqual([]);
  });

  test("keeps the semantic invariant as a backstop for compiler-side field loss", () => {
    const fixture = syntheticFixture();
    const compiled = hydrateSemanticSourcePlan(
      compileTargetSelectors(fixture.selectors, fixture.registry, fixture.manifest),
      fixture.manifest,
    );
    Object.values(compiled.acceptance_items[1]!.field_bindings).forEach((binding) => {
      binding.source_fragments = [];
      binding.evidence_ids = [];
    });
    expect(checkTargetCompilerInvariants(fixture.selectors, compiled, fixture.manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "compiler_semantic_item_fragment_not_materialized",
        owner: "compiler_invariant_violation",
      }),
    ]));
  });
});
