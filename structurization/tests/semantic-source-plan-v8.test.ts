import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { auditSealedRevision } from "../src/audit.js";
import { canonicalize, prettyJson, sha256Json, sha256Text } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import {
  compileSemanticDecisions,
  compileSemanticDecisionsV8,
  SemanticDecisionCompileError,
  type EvidenceSpanDecision,
  type SemanticDecisionPlan,
} from "../src/semantic-decision-compiler.js";
import { createPlanSourceResolver } from "../src/plan-source-resolver.js";
import { hydrateSemanticSourcePlan } from "../src/plan-hydration.js";
import { materialize } from "../src/materializer.js";
import { upgradePlanToCurrent } from "../src/plan-migration.js";
import { validatePlanText } from "../src/validator.js";
import {
  semanticPlanValidatorVersion,
  ToolController,
  validationReceiptMatchesPlanVersion,
} from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

function fixture(): { manifest: EvidenceManifest; decisions: SemanticDecisionPlan } {
  const text = "连接件外观应完整。检查方法：观察。共同判据。条件甲例外。条件乙备注。";
  const evidenceId = "atom:criterion";
  const span = (value: string): EvidenceSpanDecision => {
    const start = text.indexOf(value);
    return { evidence_id: evidenceId, start, end: start + value.length };
  };
  const evidence = [{
    evidence_id: evidenceId,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: "p1",
    text,
    text_sha256: sha256Text(text),
    requires_disposition: true,
  }];
  const payload = {
    schema_version: "evidence-manifest/v6" as const,
    job_id: "job:v8",
    target_id: "target:v8",
    source: { adapter: "markdown-target-scope/v3" as const, file_name: "fixture.md", sha256: sha256Text(text) },
    scope: {
      schema_version: "markdown-target-scope/v1" as const,
      mode: "target_section" as const,
      target_id: "target:v8",
      source_line_count: 1,
      selected_start_line: 0,
      selected_end_exclusive_line: 1,
      selected_heading: "",
      selection_reason: "fixture",
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
  };
  const manifest = { ...payload, evidence_fingerprint: sha256Json(payload) };
  const full = { evidence_id: evidenceId, start: 0, end: text.length };
  const name = span("连接件外观");
  const requirement = span("连接件外观应完整");
  const method = span("观察");
  const notApplicable = { value: "", composition: "not_applicable" as const, spans: [], reason: "not present" };
  const decisions: SemanticDecisionPlan = {
    schema_version: "semantic-decision-plan/v1",
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: { tables: [], fragment_dispositions: [] },
    lots: [{ key: "lot", name: "连接件", evidence_spans: [full], reason: "fixture" }],
    items: [{
      key: "item",
      lot_key: "lot",
      category: "一般项目",
      fields: {
        name: { value: "连接件外观", composition: "verbatim", spans: [name], reason: "fixture" },
        requirement: { value: "连接件外观应完整", composition: "verbatim", spans: [requirement], reason: "fixture" },
        method: { value: "观察", composition: "verbatim", spans: [method], reason: "fixture" },
        quantity: notApplicable,
        note: notApplicable,
      },
      primary_spans: [full],
      table: null,
      inspection_data_type: "review",
      inspection_data_type_reason: "fixture",
      inspection_data_type_spans: [requirement, method],
      sampling: {
        status: "fallback",
        min_sampling: "",
        script: "fallback",
        reason: "fixture",
        confidence: 1,
        evidence_spans: [],
        rule_keys: [],
        branch_keys: [],
      },
    }],
    semantic_nodes: [],
    references: [],
    sampling_rules: [],
    occurrence_resolutions: [],
    evidence_dispositions: [{ evidence_id: evidenceId, disposition: "context", reason: "fixture" }],
  };
  return { manifest, decisions };
}

function samplingFixture(): { manifest: EvidenceManifest; decisions: SemanticDecisionPlan } {
  const source = fixture();
  const { evidence_fingerprint: _oldFingerprint, ...manifestPayload } = source.manifest;
  const semanticPayload = {
    ...manifestPayload,
    source: {
      ...manifestPayload.source,
      semantic_workflow: "semantic-evidence-plan/v1" as const,
    },
  };
  source.manifest = {
    ...semanticPayload,
    evidence_fingerprint: sha256Json(semanticPayload),
  };
  source.decisions.evidence_fingerprint = source.manifest.evidence_fingerprint;
  const record = source.manifest.evidence[0]!;
  const span = (value: string): EvidenceSpanDecision => {
    const start = record.text.indexOf(value);
    return { evidence_id: record.evidence_id, start, end: start + value.length };
  };
  source.decisions.semantic_nodes = [{
    key: "sampling-node",
    role: "sampling_rule",
    span: { evidence_id: record.evidence_id, start: 0, end: record.text.length },
    parent_key: "",
    item_key: "",
    reason: "fixture",
  }];
  source.decisions.sampling_rules = [{
    key: "shared-rule",
    source_semantic_key: "sampling-node",
    complete_span: { evidence_id: record.evidence_id, start: 0, end: record.text.length },
    components: [{
      key: "criterion",
      role: "acceptance_criterion",
      disposition: "present",
      spans: [span("共同判据")],
      reason: "shared fixture",
    }],
    branches: [{
      key: "branch-a",
      applies_to_category: "all_items",
      min_sampling: "甲",
      script: "甲分支",
      span: span("条件甲例外"),
      components: [{
        key: "exception-a",
        role: "exception",
        disposition: "present",
        spans: [span("条件甲例外")],
        reason: "branch a fixture",
      }],
      conditions: [],
    }, {
      key: "branch-b",
      applies_to_category: "all_items",
      min_sampling: "乙",
      script: "乙分支",
      span: span("条件乙备注"),
      components: [{
        key: "note-b",
        role: "note",
        disposition: "present",
        spans: [span("条件乙备注")],
        reason: "branch b fixture",
      }],
      conditions: [],
    }],
    shared_conditions: [],
    reason: "fixture",
  }];
  source.decisions.items[0]!.sampling = {
    status: "reference",
    min_sampling: "",
    script: "",
    reason: "fixture",
    confidence: 1,
    evidence_spans: [],
    rule_keys: ["shared-rule"],
    branch_keys: ["branch-a", "branch-b"],
  };
  return source;
}

describe("semantic source plan v8 compiler", () => {
  it("persists provenance as a deduplicated plan-local span catalog", () => {
    const { manifest, decisions } = fixture();
    const plan = compileSemanticDecisionsV8(decisions, manifest);
    const serialized = JSON.stringify(plan);

    expect(plan.schema_version).toBe("semantic-source-plan/v8");
    expect(serialized).not.toContain("source_fragments");
    expect(serialized).not.toContain("exact_fragment");
    expect(serialized).not.toContain("complete_source_fragment");
    expect(plan.acceptance_items[0]!.field_bindings.requirement.source_span_ids).toHaveLength(1);

    const referenced = new Set(Object.values(plan.acceptance_items[0]!.field_bindings)
      .flatMap((binding) => binding.source_span_ids));
    expect(plan.source_spans.filter((span) => referenced.has(span.span_id))).toHaveLength(referenced.size);

    const issues: Array<{ code: string }> = [];
    const resolver = createPlanSourceResolver(plan, manifest);
    expect(resolver.resolveMany([...referenced], "/fields", issues).map((span) => span.text)).toEqual([
      "连接件外观",
      "连接件外观应完整",
      "观察",
    ]);
    expect(issues).toEqual([]);
  });

  it("orders final items by their most specific source entry instead of authoring order", () => {
    const { manifest, decisions } = fixture();
    manifest.evidence[0]!.locator = `char:100-${100 + manifest.evidence[0]!.text.length}`;
    const source = manifest.evidence[0]!.text;
    const span = (value: string): EvidenceSpanDecision => {
      const start = source.indexOf(value);
      return { evidence_id: manifest.evidence[0]!.evidence_id, start, end: start + value.length };
    };
    const base = decisions.items[0]!;
    const tableItem = (
      key: string,
      name: string,
      rowValue: string,
    ): SemanticDecisionPlan["items"][number] => ({
      ...structuredClone(base),
      key,
      fields: {
        ...structuredClone(base.fields),
        name: {
          value: name,
          composition: "semantic_summary",
          spans: [span(rowValue)],
          reason: "Concise entry name.",
        },
        requirement: {
          value: "",
          composition: "verbatim",
          spans: [span(rowValue)],
          reason: "Exact row requirement.",
        },
      },
      primary_spans: [{ evidence_id: manifest.evidence[0]!.evidence_id, start: 0, end: source.length }],
      table: {
        source_kind: "direct",
        table_key: "table",
        table_no: "",
        table_title: "",
        applicability: "",
        row_path: [rowValue],
        column_path: [],
        unit: "",
        condition: "",
        allowed_value: rowValue,
        inspection_method: "",
        cell_evidence: [
          { role: "row_header", span: span(rowValue) },
          { role: "allowed_value", span: span(rowValue) },
        ],
        reference_spans: [],
      },
    });
    decisions.items = [
      tableItem("later", "条件乙", "条件乙备注"),
      tableItem("earlier", "条件甲", "条件甲例外"),
    ];

    const expanded = compileSemanticDecisions(decisions, manifest);
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    expect(expanded.acceptance_items.map((item) => item.name)).toEqual(["条件甲", "条件乙"]);
    expect(expanded.inspection_lots[0]!.item_ids).toEqual(
      expanded.acceptance_items.map((item) => item.item_id),
    );
    expect(compact.acceptance_items.map((item) => item.name)).toEqual(["条件甲", "条件乙"]);
    expect(materialize(compact, manifest, "fingerprint").result.inspection_lots[0]!.items
      .map((item) => item.name)).toEqual(["条件甲", "条件乙"]);

    const invalid = structuredClone(decisions);
    invalid.items[0]!.lot_key = "missing-lot";
    for (const compile of [compileSemanticDecisions, compileSemanticDecisionsV8]) {
      try {
        compile(invalid, manifest);
        throw new Error("expected unknown lot rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SemanticDecisionCompileError);
        expect((error as SemanticDecisionCompileError).issues).toContainEqual(expect.objectContaining({
          code: "decision_unknown_lot",
          path: "/items/0/lot_key",
        }));
      }
    }
  });

  it("keeps compact applied-branch issue paths in authoring order after source sorting", () => {
    const { manifest, decisions } = samplingFixture();
    manifest.evidence[0]!.locator = `char:100-${100 + manifest.evidence[0]!.text.length}`;
    const source = manifest.evidence[0]!.text;
    const span = (value: string): EvidenceSpanDecision => {
      const start = source.indexOf(value);
      return { evidence_id: manifest.evidence[0]!.evidence_id, start, end: start + value.length };
    };
    const base = decisions.items[0]!;
    const orderedItem = (key: string, name: string, value: string) => ({
      ...structuredClone(base),
      key,
      fields: {
        ...structuredClone(base.fields),
        name: { value: name, composition: "semantic_summary" as const, spans: [span(value)], reason: "Concise name." },
        requirement: { value: "", composition: "verbatim" as const, spans: [span(value)], reason: "Exact judgment." },
      },
      primary_spans: [{ evidence_id: manifest.evidence[0]!.evidence_id, start: 0, end: source.length }],
    });
    const later = orderedItem("later", "条件乙", "条件乙备注");
    const earlier = orderedItem("earlier", "条件甲", "条件甲例外");
    earlier.sampling = {
      status: "fallback",
      min_sampling: "",
      script: "fallback",
      reason: "fixture",
      confidence: 1,
      evidence_spans: [],
      rule_keys: [],
      branch_keys: [],
    };
    decisions.items = [later, earlier];
    const sharedComponent = decisions.sampling_rules[0]!.components![0]!;
    decisions.sampling_rules[0]!.components!.push(structuredClone(sharedComponent));

    expect(compileSemanticDecisions(decisions, manifest).acceptance_items.map((item) => item.name))
      .toEqual(["条件甲", "条件乙"]);
    try {
      compileSemanticDecisionsV8(decisions, manifest);
      throw new Error("expected duplicate sampling component rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticDecisionCompileError);
      expect((error as SemanticDecisionCompileError).issues).toContainEqual(expect.objectContaining({
        code: "decision_sampling_component_duplicate",
        path: "/items/0/sampling/applied_branches/0/effective_components/shared/1",
      }));
    }
  });

  it("orders independently split prose judgments by their exact requirement occurrence", () => {
    const { manifest, decisions } = fixture();
    manifest.evidence[0]!.locator = `char:500-${500 + manifest.evidence[0]!.text.length}`;
    const source = manifest.evidence[0]!.text;
    const span = (value: string): EvidenceSpanDecision => {
      const start = source.indexOf(value);
      return { evidence_id: manifest.evidence[0]!.evidence_id, start, end: start + value.length };
    };
    const base = decisions.items[0]!;
    const proseItem = (key: string, name: string, value: string): SemanticDecisionPlan["items"][number] => ({
      ...structuredClone(base),
      key,
      fields: {
        ...structuredClone(base.fields),
        name: { value: name, composition: "semantic_summary", spans: [span(value)], reason: "Concise name." },
        requirement: { value: "", composition: "verbatim", spans: [span(value)], reason: "Exact judgment." },
      },
      primary_spans: [{ evidence_id: manifest.evidence[0]!.evidence_id, start: 0, end: source.length }],
      table: null,
    });
    decisions.items = [
      proseItem("later", "条件乙", "条件乙备注"),
      proseItem("earlier", "条件甲", "条件甲例外"),
    ];

    const compact = compileSemanticDecisionsV8(decisions, manifest);
    expect(compact.acceptance_items.map((item) => item.name)).toEqual(["条件甲", "条件乙"]);
    expect(compact.inspection_lots[0]!.item_ids).toEqual(compact.acceptance_items.map((item) => item.item_id));
  });

  it("orders multi-row reference expansion targets by immutable source occurrence", () => {
    const { manifest, decisions } = fixture();
    manifest.evidence.push({
      evidence_id: "row:earlier",
      kind: "table_row",
      role: "supporting_table",
      locator: "char:1000-1010",
      text: "项目甲 10",
      text_sha256: sha256Text("项目甲 10"),
      requires_disposition: false,
      table_row_kind: "data",
      table_id: "table:reference",
      row_index: 1,
      columns: ["项目", "允许值"],
      cells: ["项目甲", "10"],
    }, {
      evidence_id: "row:later",
      kind: "table_row",
      role: "supporting_table",
      locator: "char:1100-1110",
      text: "项目乙 20",
      text_sha256: sha256Text("项目乙 20"),
      requires_disposition: false,
      table_row_kind: "data",
      table_id: "table:reference",
      row_index: 2,
      columns: ["项目", "允许值"],
      cells: ["项目乙", "20"],
    });
    manifest.reference_occurrences = [{
      occurrence_id: "occurrence:table",
      reference_kind: "table",
      origin_evidence_id: manifest.evidence[0]!.evidence_id,
      origin_fields: ["requirement"],
      raw_reference: "共同判据",
      target_table_id: "table:reference",
      target_evidence_ids: ["row:earlier", "row:later"],
      required: true,
      status: "resolved",
      depth: 0,
      path: ["table:reference"],
    }];
    manifest.evidence_fingerprint = sha256Text("reference-order-fixture");
    decisions.evidence_fingerprint = manifest.evidence_fingerprint;
    decisions.occurrence_resolutions = [{
      key: "resolution",
      occurrence_id: "occurrence:table",
      action: "adopt",
      application_mode: "expand_items",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "Rows expand requirement fields." },
      target_spans: [
        { evidence_id: "row:later", start: 0, end: "项目乙 20".length },
        { evidence_id: "row:earlier", start: 0, end: "项目甲 10".length },
      ],
      destinations: [{ item_key: decisions.items[0]!.key, target_field: "requirement" }],
      reason: "Every selected row becomes one derived item.",
    }];

    expect(compileSemanticDecisionsV8(decisions, manifest).reference_resolutions[0]!.target_evidence_ids)
      .toEqual(["row:earlier", "row:later"]);
  });

  it("hydrates only in memory and preserves deterministic business materialization", () => {
    const { manifest, decisions } = fixture();
    const legacy = compileSemanticDecisions(decisions, manifest);
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const hydrated = hydrateSemanticSourcePlan(compact, manifest);

    expect(hydrated.acceptance_items[0]!.field_bindings.requirement.source_fragments).toEqual(
      legacy.acceptance_items[0]!.field_bindings.requirement.source_fragments,
    );
    expect(materialize(compact, manifest, "fingerprint").result.inspection_lots).toEqual(
      materialize(legacy, manifest, "fingerprint").result.inspection_lots,
    );
    expect(JSON.stringify(compact)).not.toContain("source_fragments");
    expect(upgradePlanToCurrent(compact, manifest)).toEqual(compact);
  });

  it("validates the compact artifact while returning separate persisted and hydrated views", () => {
    const { manifest, decisions } = fixture();
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const validation = validatePlanText(JSON.stringify(compact), manifest);

    expect(validation.ok).toBe(true);
    expect(validation.persisted_plan).toEqual(compact);
    expect(validation.persisted_plan?.schema_version).toBe("semantic-source-plan/v8");
    expect(validation.plan?.schema_version).toBe("semantic-source-plan/v7");
    expect(validation.plan_sha256).toBe(sha256Text(canonicalize(compact)));
    expect(validation.fingerprint).toBe(sha256Text(canonicalize({
      validator: "semantic-source-plan-validator/v5",
      evidence_fingerprint: manifest.evidence_fingerprint,
      plan_sha256: validation.plan_sha256,
    })));
  });

  it("rejects a compact catalog whose immutable source hash no longer resolves", () => {
    const { manifest, decisions } = fixture();
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    compact.source_spans[0]!.text_sha256 = "0".repeat(64);

    const validation = validatePlanText(JSON.stringify(compact), manifest);

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain("plan_span_hash_mismatch");
    expect(validation.persisted_plan).toBeUndefined();
  });

  it("preserves shared and branch-local sampling component provenance without crossing branches", () => {
    const { manifest, decisions } = samplingFixture();
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const hydrated = hydrateSemanticSourcePlan(compact, manifest);
    const materialized = materialize(compact, manifest, "fingerprint");
    const branches = materialized.result.inspection_lots[0]!.items[0]!.sampling.applied_branches!;

    expect(hydrated.acceptance_items[0]!.sampling.applied_branches?.map((branch) =>
      branch.components?.map(({ source_fragments: _sourceFragments, ...component }) => component)
    )).toEqual(
      compact.acceptance_items[0]!.sampling.applied_branches?.map((branch) => branch.effective_components),
    );
    expect(branches[0]!.components?.map((component) => component.role)).toEqual([
      "acceptance_criterion",
      "exception",
    ]);
    expect(branches[1]!.components?.map((component) => component.role)).toEqual([
      "acceptance_criterion",
      "note",
    ]);
    expect(branches[0]!.components?.some((component) => component.key === "note-b")).toBe(false);
    expect(branches[1]!.components?.some((component) => component.key === "exception-a")).toBe(false);
    expect(branches[0]!.components?.find((component) => component.key === "criterion")?.source_fragments)
      .toEqual([{ evidence_id: "atom:criterion", text: "共同判据" }]);
    expect(branches[0]!.components?.find((component) => component.key === "exception-a")?.source_fragments)
      .toEqual([{ evidence_id: "atom:criterion", text: "条件甲例外" }]);
    expect(branches[1]!.components?.find((component) => component.key === "note-b")?.source_fragments)
      .toEqual([{ evidence_id: "atom:criterion", text: "条件乙备注" }]);
    expect((materialized.provenance as { source_spans?: unknown[] }).source_spans).toEqual(compact.source_spans);
  });

  it("serializes multiple selected sampling conditions as one script line per branch", () => {
    const { manifest, decisions } = samplingFixture();
    const record = manifest.evidence[0]!;
    const span = (value: string): EvidenceSpanDecision => {
      const start = record.text.indexOf(value);
      return { evidence_id: record.evidence_id, start, end: start + value.length };
    };
    const branches = decisions.sampling_rules[0]!.branches;
    branches[0]!.script = "表3.0.9";
    branches[0]!.conditions = [{
      key: "condition-a",
      text: "大开挖基础",
      span: span("条件甲例外"),
    }];
    branches[1]!.script = "每1座4点";
    branches[1]!.conditions = [{
      key: "condition-b",
      text: "独立基础",
      span: span("条件乙备注"),
    }];

    const expected = "大开挖基础：表3.0.9\n独立基础：每1座4点";
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const materialized = materialize(compact, manifest, "fingerprint");
    const sampling = materialized.result.inspection_lots[0]!.items[0]!.sampling;

    expect(compact.acceptance_items[0]!.sampling.script).toBe(expected);
    expect(sampling.script).toBe(expected);
    expect(sampling.applied_branches?.map((branch) => branch.script)).toEqual([
      "表3.0.9",
      "每1座4点",
    ]);
  });

  it("rejects a materialized branch that omits any registered effective component", () => {
    const { manifest, decisions } = samplingFixture();
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    compact.acceptance_items[0]!.sampling.applied_branches![0]!.effective_components = [
      compact.acceptance_items[0]!.sampling.applied_branches![0]!.effective_components[1]!,
    ];
    expect(compact.shared_sampling_rules![0]!.components).toHaveLength(1);
    expect(compact.shared_sampling_rules![0]!.branches[0]!.components).toHaveLength(1);
    expect(compact.acceptance_items[0]!.sampling.applied_branches![0]!.effective_components).toHaveLength(1);

    const validation = validatePlanText(JSON.stringify(compact), manifest);

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain("sampling_applied_components_incomplete");
  });

  it("keeps working, last-valid, and sealed plan artifacts compact with a v5 receipt", async () => {
    const { manifest, decisions } = fixture();
    const tableTitle = "共同判据";
    const tableTitleStart = manifest.evidence[0]!.text.indexOf(tableTitle);
    decisions.table_assembly.tables.push({
      key: "table",
      canonical_title: tableTitle,
      title_spans: [{
        evidence_id: manifest.evidence[0]!.evidence_id,
        start: tableTitleStart,
        end: tableTitleStart + tableTitle.length,
      }],
      evidence_spans: [{
        evidence_id: manifest.evidence[0]!.evidence_id,
        start: tableTitleStart,
        end: tableTitleStart + tableTitle.length,
      }],
      fragment_ids: [],
      reason: "Exercise compact and hydrated table-assembly projections.",
      confidence: 1,
    });
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const root = resolve(".tmp-tests", `semantic-plan-v8-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const workspace = await RevisionWorkspace.createFromEvidence(
        root,
        manifest.job_id,
        manifest.target_id,
        { manifest, markdown: Buffer.from(manifest.evidence[0]!.text) },
      );
      const controller = await ToolController.create(workspace);
      await controller.dispatch("open_evidence", { evidence_id: manifest.evidence[0]!.evidence_id });
      expect(await controller.dispatch("replace_working_plan", { content: JSON.stringify(compact) }))
        .toMatchObject({ ok: true });

      const validation = await controller.dispatch("validate_working_plan", {});
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true, fingerprint: expect.any(String) });
      const working = JSON.parse(await readFile(workspace.workingPlanPath, "utf8"));
      const lastValid = JSON.parse(await readFile(workspace.lastValidPlanPath, "utf8"));
      const receipt = JSON.parse(await readFile(workspace.validationReceiptPath, "utf8"));
      expect(working).toEqual(compact);
      expect(lastValid).toEqual(compact);
      expect(receipt).toMatchObject({
        ok: true,
        validator: "semantic-source-plan-validator/v5",
        plan_sha256: sha256Text(canonicalize(compact)),
        validation_fingerprint: validation.fingerprint,
      });
      const validated = validatePlanText(JSON.stringify(compact), manifest);
      expect(validated.ok).toBe(true);
      expect(validated.plan?.table_assembly).not.toEqual(compact.table_assembly);
      const reviewedResultFingerprint = sha256Json(materialize(
        validated.plan!,
        manifest,
        validated.fingerprint!,
      ).result);

      expect(await controller.dispatch("seal_validated_plan", { fingerprint: validation.fingerprint }))
        .toMatchObject({ ok: true, status: "passed", audit_status: "passed" });
      expect(JSON.parse(await readFile(workspace.sealedPlanPath, "utf8"))).toEqual(compact);
      const sealedResult = JSON.parse(await readFile(workspace.resultPath, "utf8"));
      const publishedTableAssembly = JSON.parse(await readFile(workspace.tableAssemblyPlanPath, "utf8"));
      expect(sha256Json(sealedResult)).toBe(reviewedResultFingerprint);
      expect(sealedResult.table_assembly_fingerprint).toBe(sha256Json(publishedTableAssembly));

      const writeResultFixture = async (value: typeof sealedResult): Promise<void> => {
        const content = prettyJson(value);
        await chmod(workspace.resultPath, 0o644);
        await writeFile(workspace.resultPath, content, "utf8");
        const sealedManifest = JSON.parse(await readFile(workspace.manifestPath, "utf8"));
        sealedManifest.fingerprints.files["result.json"] = sha256Text(content);
        await chmod(workspace.manifestPath, 0o644);
        await writeFile(workspace.manifestPath, prettyJson(sealedManifest), "utf8");
      };
      const legacyResult = structuredClone(sealedResult);
      for (const lot of legacyResult.inspection_lots) for (const item of lot.items) delete item.source_anchors;
      await writeResultFixture(legacyResult);
      expect(await auditSealedRevision(workspace)).toMatchObject({ status: "passed", findings: [] });
      // Compatibility is only for the absent new metadata, never changed facts.
      legacyResult.inspection_lots[0].items[0].name += " changed";
      await writeResultFixture(legacyResult);
      expect(await auditSealedRevision(workspace)).toMatchObject({
        status: "failed",
        findings: expect.arrayContaining([expect.objectContaining({ rule_id: "materializer.result_replay" })]),
      });
      const alteredPosition = structuredClone(sealedResult);
      alteredPosition.inspection_lots[0].items[0].source_anchors = [{ line: 999, row: 0, column: 0 }];
      await writeResultFixture(alteredPosition);
      expect(await auditSealedRevision(workspace)).toMatchObject({
        status: "failed",
        findings: expect.arrayContaining([expect.objectContaining({ rule_id: "materializer.result_replay" })]),
      });
      await writeResultFixture(sealedResult);

      const writeLegacyProvenance = async (provenance: Record<string, unknown>): Promise<void> => {
        const content = prettyJson(provenance);
        await chmod(workspace.provenancePath, 0o644);
        await writeFile(workspace.provenancePath, content, "utf8");
        const sealedManifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as {
          fingerprints: { files: Record<string, string> };
        };
        sealedManifest.fingerprints.files["provenance.json"] = sha256Text(content);
        await chmod(workspace.manifestPath, 0o644);
        await writeFile(workspace.manifestPath, prettyJson(sealedManifest), "utf8");
      };
      const currentProvenance = JSON.parse(
        await readFile(workspace.provenancePath, "utf8"),
      ) as Record<string, unknown>;
      await writeLegacyProvenance({
        ...currentProvenance,
        source_spans: compact.source_spans,
      });
      expect(await auditSealedRevision(workspace)).toMatchObject({
        status: "passed",
        findings: [],
      });

      const tamperedCatalog = structuredClone(compact.source_spans);
      tamperedCatalog[0]!.text_sha256 = "0".repeat(64);
      await writeLegacyProvenance({
        ...currentProvenance,
        source_spans: tamperedCatalog,
      });
      expect(await auditSealedRevision(workspace)).toMatchObject({
        status: "failed",
        findings: [expect.objectContaining({ rule_id: "materializer.provenance_replay" })],
      });

      await writeLegacyProvenance({
        ...currentProvenance,
        source_spans: compact.source_spans,
        unexpected_projection: true,
      });
      expect(await auditSealedRevision(workspace)).toMatchObject({
        status: "failed",
        findings: [expect.objectContaining({ rule_id: "materializer.provenance_replay" })],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("isolates v4 and v5 validation receipts by persisted plan format", () => {
    const { manifest, decisions } = fixture();
    const legacy = compileSemanticDecisions(decisions, manifest);
    const compact = compileSemanticDecisionsV8(decisions, manifest);
    const v4 = { validator: "semantic-source-plan-validator/v4" };
    const v5 = { validator: "semantic-source-plan-validator/v5" };

    expect(semanticPlanValidatorVersion(legacy)).toBe(v4.validator);
    expect(semanticPlanValidatorVersion(compact)).toBe(v5.validator);
    expect(validationReceiptMatchesPlanVersion(v4, legacy)).toBe(true);
    expect(validationReceiptMatchesPlanVersion(v4, compact)).toBe(false);
    expect(validationReceiptMatchesPlanVersion(v5, compact)).toBe(true);
    expect(validationReceiptMatchesPlanVersion(v5, legacy)).toBe(false);
  });
});
