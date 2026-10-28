import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { prettyJson, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import {
  initialTargetSelectorPlan,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { materialize } from "../src/materializer.js";

async function inspectCurrentSourceClauses(controller: ToolController, workspace: RevisionWorkspace) {
  const selectors = JSON.parse(await readFile(workspace.workingSelectorPath, "utf8"));
  // Inspect model observations without finalizing the candidate under study.
  const preflight = await (controller as any).evaluateTargetSelectorPreflight(selectors);
  return { ...preflight.response, compiled_plan: preflight.compiled };
}

interface ClauseFixture {
  clauseId?: string;
  evidenceScope?: "primary" | "reference" | "sampling";
  line: number;
  text: string;
}

function sourceClauseFixture(clauses: ClauseFixture[]): {
  manifest: EvidenceManifest;
  selectors: TargetSelectorPlan;
  spanIds: string[];
} {
  const markdown = clauses
    .reduce<string[]>((lines, clause) => {
      while (lines.length < clause.line - 1) lines.push("");
      lines.push(clause.text);
      return lines;
    }, [])
    .join("\n");
  const evidence = clauses.map((clause, index) => ({
    evidence_id: `atom:source-clause-priority-${index}`,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: `line:${clause.line}`,
    text: clause.text,
    text_sha256: sha256Text(clause.text),
    requires_disposition: true,
    ...(clause.clauseId ? { clause_id: clause.clauseId } : {}),
    ...(clause.evidenceScope ? { evidence_scope: clause.evidenceScope } : {}),
  }));
  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "source-clause-priority-job",
    target_id: "target-source-clause-priority",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(markdown),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target-source-clause-priority",
      source_line_count: markdown.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: markdown.split("\n").length + 1,
      selected_heading: "",
      selection_reason: "中性来源归属优先级测试",
      selected_atom_ids: evidence.map((record) => record.evidence_id),
      target_evidence_fragments: evidence.map((record) => ({ atom_id: record.evidence_id, text: record.text })),
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`source-clause-priority\0${markdown}`),
  };
  const registry = registryWithFullSourceSpans(
    manifest.evidence_fingerprint,
    evidence.map((record) => ({
      source_id: record.evidence_id,
      evidence_id: record.evidence_id,
      atom_id: record.evidence_id,
      text: record.text,
    })),
  );
  const spanIds = evidence.map((record) => registry.spans.find((span) => (
    span.evidence_id === record.evidence_id
    && span.start === 0
    && span.end === record.text.length
  ))!.span_id);
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "neutral-lot",
    name: "中性检验批",
    scope_span_ids: [spanIds[0]!],
    reason: "父条款定义当前检验批范围。",
  });
  selectors.items.push({
    key: "neutral-item",
    lot_key: "neutral-lot",
    name: "连接质量",
    category: "一般项目",
    criterion_span_ids: spanIds.slice(1),
    continuation_span_ids: [],
    fields: {
      name: {
        composition: "semantic_summary",
        span_ids: [spanIds[1]!],
        separator: "",
        reason: "按原文概括受检属性。",
      },
      requirement: {
        composition: "verbatim",
        span_ids: [spanIds[0]!],
        separator: "",
        reason: "父条款完整规定验收要求。",
      },
      method: spanIds[2]
        ? {
            composition: "verbatim",
            span_ids: [spanIds[2]],
            separator: "",
            reason: "另一来源记录检查方法。",
          }
        : {
            composition: "not_applicable",
            span_ids: [],
            separator: "",
            reason: "原文未另行规定方法。",
          },
      quantity: {
        composition: "not_applicable",
        span_ids: [],
        separator: "",
        reason: "原文未规定数量。",
      },
      note: {
        composition: "verbatim",
        span_ids: [spanIds[1]!],
        separator: "",
        reason: "保留声明的辅助判据原文，不以概括名称代替来源内容。",
      },
    },
    table: null,
    inspection_data_type: "review",
    inspection_data_type_reason: "按原文核查连接质量。",
    inspection_data_type_span_ids: [spanIds[1]!],
    sampling: {
      status: "fallback",
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "当前原文没有形成抽样数量。",
      confidence: 1,
    },
    reason: "该质量属性可独立检查和判定。",
  });
  return { manifest, selectors, spanIds };
}

async function writeLedger(
  workspace: RevisionWorkspace,
  manifest: EvidenceManifest,
  clauses: ClauseFixture[],
): Promise<void> {
  await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
  await writeFile(workspace.documentLedgerPath, prettyJson({
    schema_version: "document-ledger/v1",
    source_sha256: manifest.source.sha256,
    file_name: manifest.source.file_name,
    clauses: clauses.flatMap((clause) => clause.clauseId ? [{
      clause_id: clause.clauseId,
      line: clause.line,
      end_exclusive_line: clause.line + 1,
      text: clause.text,
      kind: "item_candidate",
      has_quantity: false,
      has_method: true,
    }] : []),
    headings: [],
    windows: [],
    record_tables: [],
    tables: [],
    anomalies: [],
  }), "utf8");
}

describe("source-clause feedback follows materializer priority", () => {
  test("does not promise that rebinding an already-bound requirement overrides conflicting semantic ownership", async () => {
    const clauses: ClauseFixture[] = [
      { clauseId: "10.2.1", evidenceScope: "primary", line: 1, text: "10.2.1 连接部位应牢固。" },
      { clauseId: "7.1.1", line: 3, text: "7.1.1 检查连接部位。" },
      { clauseId: "8.1.1", line: 5, text: "8.1.1 采用目视检查。" },
    ];
    const { manifest, selectors, spanIds } = sourceClauseFixture(clauses);
    const root = await mkdtemp(join(tmpdir(), "source-clause-priority-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(clauses.map((clause) => clause.text).join("\n\n")) },
      );
      const registry = registryWithFullSourceSpans(
        manifest.evidence_fingerprint,
        manifest.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await writeLedger(workspace, manifest, clauses);
      const controller = await ToolController.create(workspace);
      await controller.dispatch("batch_open_evidence", {
        evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: selectors.lots, items: selectors.items },
      })).toMatchObject({ ok: true });

      const first = await inspectCurrentSourceClauses(controller, workspace);
      expect(first.model_review).toMatchObject({ blocking: false, decision_owner: "model" });
      const firstIssue = first.model_review.observations.find((issue: any) => issue.code === "selector_source_clause_unresolved");
      expect(firstIssue).toMatchObject({
        actual: {
          source_clause: "",
          current_bindings: {
            criterion_span_ids: [spanIds[1], spanIds[2]],
            continuation_span_ids: [],
            field_span_ids: expect.objectContaining({ requirement: [spanIds[0]] }),
          },
          ledger_clause_candidates_by_binding: {
            criterion: ["7.1.1", "8.1.1"],
            continuation: [],
            fields: expect.objectContaining({ requirement: ["10.2.1"] }),
          },
          ledger_clause_candidate_note: expect.stringContaining("不表示 materializer 已采用"),
        },
        details: {
          derivation_priority: expect.arrayContaining([
            expect.objectContaining({ source: "semantic_item_ownership", conflict_blocks_lower_priority: true }),
            expect.objectContaining({
              source: "field_binding_fallback",
              conditional: true,
              available_when: expect.stringContaining("按文字长度降序"),
            }),
          ]),
          repair_options: expect.arrayContaining([
            expect.objectContaining({ kind: "repair_semantic_item_ownership", writable_path: "/items/0/criterion_span_ids" }),
            expect.objectContaining({
              kind: "use_text_field_fallback",
              conditional: true,
              how_to_pass: expect.stringContaining("按文字长度降序"),
            }),
          ]),
          required_action: expect.stringMatching(/ledger 候选条款.*核对.*定位条件/u),
        },
        how_to_pass: expect.stringMatching(/高优先级.*requirement.*fallback/u),
      });
      expect(firstIssue.how_to_pass).not.toContain("三类 writable_paths 中绑定");
      expect(firstIssue.details.required_action).not.toContain("实际阻塞");
      expect(firstIssue.details.required_action).not.toContain("真实父条款");

      const read = await controller.dispatch("read_target_selectors", {
        collection: "items",
        key: "neutral-item",
      }) as any;
      expect(read.rows[0].fields.requirement.span_ids).toEqual([spanIds[0]]);
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        draft: { items: [read.rows[0]] },
      })).toMatchObject({ ok: true });
      const repeated = await inspectCurrentSourceClauses(controller, workspace);
      expect(repeated.preflight_reused).toBe(true);
      expect(repeated.model_review.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_clause_unresolved" }),
      ]));

      const repairedItem = structuredClone(read.rows[0]);
      repairedItem.criterion_span_ids.push(spanIds[0]);
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        draft: { items: [repairedItem] },
      })).toMatchObject({ ok: true });
      expect(await controller.dispatch("compile_target_selectors", {})).toMatchObject({ ok: true });
      const finalPlan = hydrateSemanticSourcePlan(JSON.parse(await readFile(workspace.lastValidPlanPath, "utf8")), manifest);
      expect(materialize(finalPlan, manifest, "neutral-priority").result.inspection_lots[0]!.items[0]!.source_clause).toBe("10.2.1");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  test("keeps requirement field fallback legal when higher-priority ownership has no clause conflict", async () => {
    const clauses: ClauseFixture[] = [
      { clauseId: "10.3.1", evidenceScope: "primary", line: 1, text: "10.3.1 接缝应严密。" },
      { line: 3, text: "接缝质量检查。" },
    ];
    const { manifest, selectors } = sourceClauseFixture(clauses);
    const root = await mkdtemp(join(tmpdir(), "source-clause-field-fallback-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(clauses.map((clause) => clause.text).join("\n\n")) },
      );
      const registry = registryWithFullSourceSpans(
        manifest.evidence_fingerprint,
        manifest.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await writeLedger(workspace, manifest, clauses);
      const controller = await ToolController.create(workspace);
      await controller.dispatch("batch_open_evidence", {
        evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      });
      const staged = await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: selectors.lots, items: selectors.items },
      });
      expect(staged).toMatchObject({ ok: true });
      expect(await controller.dispatch("compile_target_selectors", {})).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  test("routes a direct-table ownership conflict to table.properties before semantic or field bindings", async () => {
    const clauses: ClauseFixture[] = [
      { clauseId: "10.4.1", evidenceScope: "primary", line: 1, text: "10.4.1 表内连接质量应符合规定。" },
      { clauseId: "7.2.1", line: 3, text: "7.2.1 连接部位" },
      { clauseId: "8.2.1", line: 5, text: "8.2.1 牢固" },
    ];
    const { manifest, selectors, spanIds } = sourceClauseFixture(clauses);
    selectors.items[0]!.table = {
      source_kind: "direct",
      table_key: "neutral-table",
      reference_span_ids: [],
      reason: "中性对照使用显式表格角色来源。",
      properties: {
        table_no_span_ids: [],
        table_title_span_ids: [],
        applicability_span_ids: [],
        row_path_span_ids: [[spanIds[1]!]],
        column_path_span_ids: [],
        unit_span_ids: [],
        condition_span_ids: [],
        allowed_value_span_ids: [spanIds[2]!],
        inspection_method_span_ids: [],
      },
    };
    const root = await mkdtemp(join(tmpdir(), "source-clause-direct-table-"));
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(clauses.map((clause) => clause.text).join("\n\n")) },
      );
      const registry = registryWithFullSourceSpans(
        manifest.evidence_fingerprint,
        manifest.evidence.map((record) => ({
          source_id: record.evidence_id,
          evidence_id: record.evidence_id,
          atom_id: record.evidence_id,
          text: record.text,
        })),
      );
      await writeFile(workspace.sourceSpanRegistryPath, prettyJson(registry), "utf8");
      await writeLedger(workspace, manifest, clauses);
      const controller = await ToolController.create(workspace);
      await controller.dispatch("batch_open_evidence", {
        evidence_ids: manifest.evidence.map((record) => record.evidence_id),
      });
      expect(await controller.dispatch("stage_target_selector_draft", {
        draft: { lots: selectors.lots, items: selectors.items },
      })).toMatchObject({ ok: true });

      const compiled = await inspectCurrentSourceClauses(controller, workspace);
      expect(compiled.model_review).toMatchObject({ blocking: false, decision_owner: "model" });
      const issue = compiled.model_review.observations.find((candidate: any) => candidate.code === "selector_source_clause_unresolved");
      expect(issue).toMatchObject({
        path: "/items/0/table/properties",
        writable_paths: expect.arrayContaining(["/items/0/table/properties"]),
        details: {
          derivation_priority: expect.arrayContaining([
            expect.objectContaining({ source: "direct_table_cell_ownership", applies: true, conflict_blocks_lower_priority: true }),
          ]),
          repair_options: expect.arrayContaining([
            expect.objectContaining({
              kind: "repair_direct_table_ownership",
              writable_paths: ["/items/0/table/properties"],
              how_to_pass: expect.stringContaining("不把 criterion 当成覆盖表格冲突的捷径"),
            }),
          ]),
        },
      });
      expect(issue.how_to_pass).toContain("任何文本字段 fallback 都不会执行");
      expect(issue.how_to_pass).not.toMatch(/criterion.*覆盖表格冲突/u);

      const criterionOnlyRepair = structuredClone(selectors.items[0]!);
      criterionOnlyRepair.criterion_span_ids.push(spanIds[0]!);
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        draft: { items: [criterionOnlyRepair] },
      })).toMatchObject({ ok: true });
      const afterCriterionRepair = await inspectCurrentSourceClauses(controller, workspace);
      expect(afterCriterionRepair.model_review.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_clause_unresolved" }),
      ]));

      const tableOwnershipRepair = structuredClone(criterionOnlyRepair);
      tableOwnershipRepair.table!.properties.row_path_span_ids = [];
      tableOwnershipRepair.table!.properties.allowed_value_span_ids = [spanIds[0]!];
      expect(await controller.dispatch("stage_target_selector_draft", {
        collection: "items",
        draft: { items: [tableOwnershipRepair] },
      })).toMatchObject({ ok: true });
      const afterTableRepair = await inspectCurrentSourceClauses(controller, workspace);
      expect(afterTableRepair.model_review.observations ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "selector_source_clause_unresolved" }),
      ]));
      const finalPlan = hydrateSemanticSourcePlan(afterTableRepair.compiled_plan, manifest);
      expect(materialize(finalPlan, manifest, "neutral-table-priority").result.inspection_lots[0]!.items[0]!.source_clause).toBe("10.4.1");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
