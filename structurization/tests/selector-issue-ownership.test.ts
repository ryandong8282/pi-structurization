import { describe, expect, it } from "vitest";

import {
  applyRepeatedSourceLanguageNamePolicy,
  applyRepeatedVerdictNamePolicy,
  classifyStrictSelectorIssues,
  classifySelectorIssue,
  decideStrictSelectorPreflight,
} from "../src/selector-issue-ownership.js";
import {
  semanticItemIdForSelectorKey,
  semanticLotIdForSelectorKey,
  semanticResolutionIdForSelectorKey,
} from "../src/semantic-decision-compiler.js";
import type { EvidenceManifest, PersistedSemanticSourcePlan } from "../src/contracts.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { TARGET_SELECTOR_ITEM_JSON_SCHEMA, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA } from "../src/target-selector-compiler.js";
import { Check } from "typebox/value";
import { selectorFieldDiagnostic } from "../src/selector-diagnostics.js";

const issue = (code: string) => ({ code, path: "/x", message: code });

describe("selector issue ownership", () => {
  describe("missing reference resolution ownership", () => {
    function fixture(kind: "table" | "clause" = "table") {
      const occurrenceId = "reference:interlock-source";
      const selectors = {
        target_id: "target:interlock-panel", items: [], lots: [], references: [],
      } as unknown as TargetSelectorPlan;
      const registry = { spans: [{
        span_id: "span:panel-anchor", evidence_id: "evidence:panel-source", start: 4, end: 10,
      }] } as SourceSpanRegistry;
      const compiled = {
        schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [],
        inspection_lots: [], reference_resolutions: [],
      } as unknown as PersistedSemanticSourcePlan;
      const manifest = { reference_occurrences: [{
        occurrence_id: occurrenceId, reference_kind: kind, status: "resolved", required: true,
        origin_evidence_id: "evidence:panel-source", origin_fields: ["requirement"],
        reference_literal_span_ids: [], target_evidence_ids: ["evidence:interlock-limit"],
        raw_reference: kind === "table" ? "表9.4" : "第6.3.2条",
        target_table_id: kind === "table" ? "9.4" : "",
        target_address: { source_id: "fictional-panel", locator: "clause:6.3.2" },
      }] } as unknown as EvidenceManifest;
      const diagnostic = {
        code: "reference_resolution_missing", path: "/reference_resolutions",
        message: "The registered interlock reference has no compiled resolution.",
        details: { occurrence_id: occurrenceId, manifest_index: 0, required_action: "author a real reference record" },
      };
      return { selectors, registry, compiled, manifest, diagnostic, occurrenceId };
    }

    it.each(["table", "clause"] as const)("returns an absent %s author declaration to the writable collection", kind => {
      const f = fixture(kind), before = JSON.stringify(f);
      const [mapped] = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest);
      expect(mapped).toMatchObject({ owner: "selector_input_error", path: "/references",
        details: { occurrence_id: f.occurrenceId, compiled_path: "/reference_resolutions",
          actual: { authored_reference_count: 0, compiled_resolution_count: 0 },
          expected: { authored_reference_count: 1, compiled_resolution_count: 1 },
          writable_paths: ["/references"], next_tool: "list_reference_occurrences", save_tool: "stage_target_selector_draft" } });
      expect(selectorFieldDiagnostic(mapped)).toMatchObject({ path: "/references", writable_paths: ["/references"] });
      expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: true, issueOwner: "selector_input_error" });
      expect(JSON.stringify(f)).toBe(before);
    });

    it.each(["explicit", "implicit"] as const)("keeps a dropped %s author declaration compiler-owned", mode => {
      const f = fixture();
      f.selectors.references.push({ key: "interlock-limit", anchor_span_ids: ["span:panel-anchor"],
        ...(mode === "explicit" ? { occurrence_id: f.occurrenceId } : {}),
      } as TargetSelectorPlan["references"][number]);
      const before = JSON.stringify(f);
      const [mapped] = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest);
      expect(mapped).toMatchObject({ owner: "compiler_invariant_violation",
        details: { actual: { authored_reference_keys: ["interlock-limit"], compiled_resolution_count: 0 }, writable_paths: [] } });
      expect(selectorFieldDiagnostic(mapped).writable_paths).toEqual([]);
      expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: false, issueOwner: "compiler_invariant_violation" });
      expect(JSON.stringify(f)).toBe(before);
    });

    it.each(["missing-id", "unknown-id", "missing-manifest", "already-compiled"] as const)("does not turn a %s snapshot contradiction into author work", scenario => {
      const f = fixture();
      if (scenario === "missing-id") Reflect.deleteProperty(f.diagnostic.details, "occurrence_id");
      if (scenario === "unknown-id") f.diagnostic.details.occurrence_id = "reference:unregistered";
      if (scenario === "already-compiled") f.compiled.reference_resolutions.push({
        resolution_id: "resolution:already-present", occurrence_id: f.occurrenceId,
      } as PersistedSemanticSourcePlan["reference_resolutions"][number]);
      const before = JSON.stringify(f);
      const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic],
        scenario === "missing-manifest" ? undefined : f.manifest);
      expect(mapped[0]?.owner).toBe("compiler_invariant_violation");
      expect(decideStrictSelectorPreflight(mapped).selectorOwned).toBe(false);
      expect(JSON.stringify(f)).toBe(before);
    });

    it("does not confuse another explicitly named reference at the same origin with the missing declaration", () => {
      const f = fixture();
      f.selectors.references.push({ key: "separate-inspection-method", occurrence_id: "reference:separate-method",
        anchor_span_ids: ["span:panel-anchor"],
      } as TargetSelectorPlan["references"][number]);
      f.compiled.reference_resolutions.push({
        resolution_id: semanticResolutionIdForSelectorKey(f.selectors.target_id, "separate-inspection-method"),
        occurrence_id: "reference:separate-method",
      } as PersistedSemanticSourcePlan["reference_resolutions"][number]);
      const before = JSON.stringify(f);
      const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest);
      expect(mapped[0]?.owner).toBe("selector_input_error");
      expect(JSON.stringify(f)).toBe(before);
    });

    it("reads the current occurrence page instead of trusting a stale diagnostic index", () => {
      const f = fixture();
      f.manifest.reference_occurrences.unshift({ ...f.manifest.reference_occurrences[0]!,
        occurrence_id: "reference:another-panel-check", raw_reference: "表4.2", target_table_id: "4.2",
      });
      f.diagnostic.details.manifest_index = 99;
      const before = JSON.stringify(f);
      const [mapped] = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest);
      expect(mapped).toMatchObject({ owner: "selector_input_error", details: {
        next_tool: "list_reference_occurrences", next_tool_arguments: { cursor: 1, limit: 1 },
      } });
      expect(JSON.stringify(f)).toBe(before);
    });

    it("keeps an unrelated compiler defect terminal in the same issue group", () => {
      const f = fixture();
      const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic, {
        code: "reference_unexpected_projection_loss", path: "/reference_resolutions/0",
        message: "A different compiled reference projection was lost.", details: { required_action: "inspect compiler projection" },
      }], f.manifest);
      expect(mapped.map(entry => entry.owner)).toEqual(["selector_input_error", "compiler_invariant_violation"]);
      expect(decideStrictSelectorPreflight(mapped)).toMatchObject({ selectorOwned: false, issueOwner: "compiler_invariant_violation" });
      expect(classifySelectorIssue("strict-validator", f.diagnostic).owner).toBe("compiler_invariant_violation");
    });
  });

  describe("unregistered static reference literal ownership", () => {
    function fixture() {
      const occurrenceId = "reference:adjustment-box-table", originId = "evidence:adjustment-box-clause";
      const targetId = "evidence:adjustment-box-limit", referenceKey = "box-latch-table";
      const selectors = { target_id: "target:adjustment-box", items: [{ key: "latch-clearance" }], lots: [], references: [{
        key: referenceKey, occurrence_id: occurrenceId, anchor_span_ids: ["span:box-origin"],
        target_span_ids: ["span:box-limit"], action: "adopt", application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "采用锁合指标" },
        destinations: [{ item_key: "latch-clearance", target_field: "requirement" }], reason: "原文明示表格要求",
      }] } as unknown as TargetSelectorPlan;
      const originText = "9.2 调节盒扣合应符合本规程表5.7的规定。";
      const registry = { spans: [
        { span_id: "span:box-origin", evidence_id: originId, start: 0, end: originText.length },
        { span_id: "span:box-limit", evidence_id: targetId, start: 0, end: 8 },
      ] } as SourceSpanRegistry;
      const resolution = { resolution_id: semanticResolutionIdForSelectorKey(selectors.target_id, referenceKey),
        occurrence_id: occurrenceId, origin_evidence_id: originId, action: "adopt", application_mode: "reference_only",
        import_scope: structuredClone(selectors.references[0]!.import_scope), target_evidence_ids: [targetId],
        destination_bindings: [{ item_id: semanticItemIdForSelectorKey(selectors.target_id, "latch-clearance"), target_field: "requirement" }],
        reason: selectors.references[0]!.reason,
      } as PersistedSemanticSourcePlan["reference_resolutions"][number];
      const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [],
        inspection_lots: [], reference_resolutions: [resolution] } as unknown as PersistedSemanticSourcePlan;
      const manifest = { source: { sha256: "fictional-adjustment-box" }, evidence: [
        { evidence_id: originId, text: originText }, { evidence_id: targetId, text: "扣合间隙不大于3格" },
      ], reference_occurrences: [{ occurrence_id: occurrenceId, origin_evidence_id: originId, origin_fields: ["requirement"],
        raw_reference: "表5.7", reference_kind: "table", target_table_id: "5.7", status: "resolved", required: true,
        target_evidence_ids: [targetId], target_address: { source_id: "fictional-adjustment-box", locator_kind: "table", locator: "table:5.7" },
      }] } as unknown as EvidenceManifest;
      const diagnostic = { code: "reference_only_mode_with_field", path: "/reference_resolutions/0/destination_bindings/0",
        message: "The registered static table occurrence has no literal." };
      return { selectors, compiled, registry, manifest, diagnostic, occurrenceId };
    }

    it("returns only a proven editable static occurrence to the normal registration tool", () => {
      const f = fixture(), before = JSON.stringify(f);
      const [mapped] = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest,
        { canRegisterDocumentReferences: true });
      expect(mapped).toMatchObject({ owner: "selector_input_error", path: "/references/0/occurrence_id", details: {
        occurrence_id: f.occurrenceId, reference_key: "box-latch-table", compiled_path: f.diagnostic.path,
        actual: { reference_literal_span_ids: [], application_mode: "reference_only" },
        expected: { registered_occurrence_literal: true, same_occurrence_id: f.occurrenceId },
        next_tool: "resolve_document_reference", next_tool_arguments: { origin_span_id: "span:box-origin", raw_reference: "表5.7" },
        save_tool: "resolve_document_reference",
      } });
      expect((mapped!.details as any).how_to_pass).toContain("不能只 locate");
      expect((mapped!.details as any).how_to_pass).toContain("origin_field");
      expect((mapped!.details as any).do_not_edit).toContain("occurrence_id");
      expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: true });
      expect(JSON.stringify(f)).toBe(before);
    });

    it.each([undefined, false])("keeps registration unavailable (%s) compiler-owned", canRegisterDocumentReferences => {
      const f = fixture();
      const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic], f.manifest,
        canRegisterDocumentReferences === undefined ? undefined : { canRegisterDocumentReferences });
      expect(mapped[0]!.owner).toBe("compiler_invariant_violation");
      expect(decideStrictSelectorPreflight(mapped).selectorOwned).toBe(false);
    });

    it.each(["missing-manifest", "unknown-occurrence", "literal-present", "coordinate-present", "external", "non-table",
      "missing-author", "duplicate-author", "resolution-id", "mode", "action", "origin", "targets", "missing-span",
      "destination-item", "destination-field", "destination-missing", "duplicate-resolution"] as const)(
      "keeps %s contradictions compiler-owned", scenario => {
        const f = fixture(), occurrence = f.manifest.reference_occurrences[0]!, resolution = f.compiled.reference_resolutions[0]!;
        if (scenario === "unknown-occurrence") occurrence.occurrence_id = "reference:other";
        if (scenario === "literal-present") occurrence.reference_literal_span_id = "span:literal";
        if (scenario === "coordinate-present") occurrence.reference_literal = { evidence_id: occurrence.origin_evidence_id, start: 4, end: 6 };
        if (scenario === "external") occurrence.external_standard = { standard_no: "EXTERNAL-9", status: "resolved" };
        if (scenario === "non-table") occurrence.reference_kind = "clause";
        if (scenario === "missing-author") f.selectors.references = [];
        if (scenario === "duplicate-author") f.selectors.references.push({ ...f.selectors.references[0]!, key: "duplicate" });
        if (scenario === "resolution-id") resolution.resolution_id = "resolution:other";
        if (scenario === "mode") resolution.application_mode = "replace_field";
        if (scenario === "action") resolution.action = "compare";
        if (scenario === "origin") resolution.origin_evidence_id = "evidence:other";
        if (scenario === "targets") resolution.target_evidence_ids = ["evidence:other"];
        if (scenario === "missing-span") f.registry.spans.splice(1, 1);
        if (scenario === "destination-item") resolution.destination_bindings[0]!.item_id = "item:other";
        if (scenario === "destination-field") resolution.destination_bindings[0]!.target_field = "method";
        if (scenario === "destination-missing") resolution.destination_bindings = [];
        if (scenario === "duplicate-resolution") f.compiled.reference_resolutions.push(structuredClone(resolution));
        const before = JSON.stringify(f);
        const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic],
          scenario === "missing-manifest" ? undefined : f.manifest, { canRegisterDocumentReferences: true });
        expect(mapped[0]!.owner).toBe("compiler_invariant_violation");
        expect(decideStrictSelectorPreflight(mapped).selectorOwned).toBe(false);
        expect(JSON.stringify(f)).toBe(before);
      });

    it("does not hide another actual compiler failure or broadly downgrade reference codes", () => {
      const f = fixture();
      const mapped = classifyStrictSelectorIssues(f.selectors, f.compiled, f.registry, [f.diagnostic, {
        ...f.diagnostic, code: "reference_projection_corrupted",
      }], f.manifest, { canRegisterDocumentReferences: true });
      expect(mapped.map(entry => entry.owner)).toEqual(["selector_input_error", "compiler_invariant_violation"]);
      expect(decideStrictSelectorPreflight(mapped).issueOwner).toBe("compiler_invariant_violation");
    });
  });

  it.each(["optional", "required", "unselected", "unfaithful"] as const)("missing nested target keeps %s source ownership", kind => {
    const selectors = { target_id: "nested-target", items: [], references: [{
      key: "parent-reference", occurrence_id: "parent", target_span_ids: ["span:selected"], destinations: [],
    }] } as unknown as TargetSelectorPlan;
    const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [],
      reference_resolutions: [{ resolution_id: semanticResolutionIdForSelectorKey(selectors.target_id, "parent-reference"),
        occurrence_id: "parent", target_evidence_ids: [kind === "unselected" ? "other-source" : "nested-origin"] }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [{ span_id: "span:selected", evidence_id: kind === "unfaithful" ? "other-source" : "nested-origin" }] } as SourceSpanRegistry;
    const occurrence = { occurrence_id: "nested", origin_evidence_id: "nested-origin", required: kind === "required",
      status: "target_not_found", target_evidence_ids: [], raw_reference: "表 Q" };
    const manifest = { reference_occurrences: [occurrence] } as unknown as EvidenceManifest;
    const original = JSON.stringify({ selectors, compiled, registry, manifest });
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "reference_target_not_found", path: "/reference_occurrences/0", message: "nested target unavailable", details: { actual: occurrence },
    }], manifest);
    if (kind === "optional") {
      expect(mapped).toMatchObject({ owner: "selector_input_error", path: "/references/0/target_span_ids",
        details: { actual: occurrence, writable_collection: "references", writable_paths: ["/references/0/target_span_ids"],
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "parent-reference" },
          activating_references: [{ reference_key: "parent-reference", occurrence_id: "parent", matching_span_ids: ["span:selected"] }] } });
      expect((mapped!.details as any).how_to_pass).toContain("不能为消错排除真实适用内容");
      expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: true });
    } else {
      expect(mapped!.owner).toBe("compiler_invariant_violation");
    }
    expect(JSON.stringify({ selectors, compiled, registry, manifest })).toBe(original);
  });

  it.each(["field_binding_relation", "field_binding_reference_route"])("%s identifies only the rejected source in mixed-source fields", (code) => {
    const spans = ["local", "routed", "unrelated"].map((key, index) => ({
      span_id: `span:${key}`, evidence_id: `evidence:${key}`, start: index, end: index + 5,
    }));
    const selectors = {
      target_id: "target:mixed", items: [{ key: "receiver", fields: {
        requirement: { composition: "reference", span_ids: spans.map(span => span.span_id) },
      } }], references: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: spans,
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(selectors.target_id, "receiver"),
        evidence_ids: ["evidence:local"], reference_evidence_ids: ["evidence:routed"],
        field_bindings: { requirement: { composition: "reference", source_span_ids: spans.map(span => span.span_id) } },
      }],
    } as unknown as PersistedSemanticSourcePlan;
    for (const details of [["evidence:unrelated"], { required_action: "route source", actual: ["evidence:unrelated"] }]) {
      const mapped = classifyStrictSelectorIssues(selectors, compiled, { spans } as SourceSpanRegistry, [{
        code, path: "/acceptance_items/0/field_bindings/requirement/evidence_ids", message: "unrelated", details,
      }]);
      expect(mapped).toHaveLength(1);
      expect(mapped[0]).toMatchObject({
        owner: "selector_input_error", path: "/items/0/fields/requirement/span_ids/2",
        details: {
          actual: {
            item_key: "receiver", item_index: 0, field: "requirement",
            span_id: spans[2]!.span_id, evidence_id: spans[2]!.evidence_id,
            start: spans[2]!.start, end: spans[2]!.end,
          },
          writable_path: "/items/0/fields/requirement/span_ids/2",
          affected_item_key: "receiver",
          affected_field: "requirement",
          next_tool: "open_evidence",
          next_tool_arguments: { evidence_id: "evidence:unrelated", cursor: 0 },
          next_tools: expect.arrayContaining([
            "open_evidence", "read_target_selectors", "list_reference_occurrences",
            "read_document_reference_evidence", "read_reference_facts", "locate_evidence_span", "stage_target_selector_draft",
          ]),
          candidate_read_tools: expect.arrayContaining([
            "open_evidence", "read_target_selectors", "list_reference_occurrences",
            "read_document_reference_evidence", "read_reference_facts", "locate_evidence_span",
          ]),
          save_tool: "stage_target_selector_draft",
          writable_collections: ["items", "references"],
          matching_reference_routes: [],
          allowed_actions: expect.arrayContaining([
            expect.stringContaining("确实属于当前 item.field"),
            expect.stringContaining("来源选错"),
          ]),
          how_to_pass: expect.stringContaining("open_evidence"),
        },
      });
      expect((mapped[0]!.details as any).how_to_pass).toContain("read_target_selectors");
      expect((mapped[0]!.details as any).how_to_pass).toContain("references");
      expect((mapped[0]!.details as any).tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
      expect((mapped[0]!.details as any).save_tool_instruction).toContain("operation=upsert");
      expect((mapped[0]!.details as any).save_tool_instruction).toContain("draft.items");
      expect((mapped[0]!.details as any).save_tool_instruction).toContain("draft.references");
      expect((mapped[0]!.details as any).how_to_pass).toContain("不得替模型");
    }
  });

  it.each(["measurement", "counting", "mixed", "review"])("translates empty %s classification evidence into an executable authored span repair", inspectionType => {
    const selectors = {
      target_id: "target:coating",
      items: [{ key: "item-repaired-coating-quality", inspection_data_type: inspectionType,
        inspection_data_type_reason: "中性分类依据", inspection_data_type_span_ids: [], fields: {} }],
      references: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(selectors.target_id, "item-repaired-coating-quality"),
        inspection_data_type: inspectionType, inspection_data_type_reason: "中性分类依据", inspection_data_type_evidence_ids: [] }],
    } as unknown as PersistedSemanticSourcePlan;
    const mapped = classifyStrictSelectorIssues(selectors, compiled, { spans: [] } as SourceSpanRegistry, [{
      code: "schema",
      path: "/acceptance_items/0/inspection_data_type_evidence_ids",
      message: "must NOT have fewer than 1 items",
      details: { limit: 1 },
    }]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      owner: "selector_input_error",
      path: "/items/0/inspection_data_type_span_ids",
      details: {
        item_key: "item-repaired-coating-quality",
        current_type: inspectionType,
        actual: { inspection_data_type: inspectionType, inspection_data_type_span_ids: [], compiled_evidence_ids: [] },
        expected: { inspection_data_type_span_ids_min_items: 1 },
        writable_path: "/items/0/inspection_data_type_span_ids",
        required_action: "bind_exact_inspection_data_type_source_and_keep_classification_consistent",
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: "item-repaired-coating-quality" },
        save_tool: "stage_target_selector_draft",
      },
    });
    const howToPass = String((mapped[0]!.details as any).how_to_pass);
    expect(howToPass).not.toContain("not_applicable");
    expect(howToPass).toContain("inspection_data_type_span_ids");
    expect(howToPass).toContain("不得填写编译字段 inspection_data_type_evidence_ids");
    expect(howToPass).toContain("stage_target_selector_draft");
    const details = mapped[0]!.details as any;
    for (const value of details.expected.inspection_data_type_allowed_values) {
      expect(Check(TARGET_SELECTOR_ITEM_JSON_SCHEMA.properties.inspection_data_type, value)).toBe(true);
    }
    expect(Check(TARGET_SELECTOR_ITEM_JSON_SCHEMA.properties.inspection_data_type, "not_applicable")).toBe(false);
    for (const path of details.writable_paths) expect(TARGET_SELECTOR_ITEM_JSON_SCHEMA.properties).toHaveProperty(path.split("/").at(-1)!);
    expect(decideStrictSelectorPreflight(mapped)).toMatchObject({ selectorOwned: true, issueOwner: "selector_input_error" });
  });

  it("does not ask an author to repair classification evidence dropped by the compiler", () => {
    const spanId = "span:" + "a".repeat(64), evidenceId = "evidence:" + "b".repeat(64);
    const selectors = { target_id: "target:neutral-classification", items: [{ key: "retained",
      inspection_data_type: "review", inspection_data_type_reason: "已选择真实分类依据", inspection_data_type_span_ids: [spanId], fields: {} }],
      references: [] } as unknown as TargetSelectorPlan;
    const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [{
      item_id: semanticItemIdForSelectorKey(selectors.target_id, "retained"), inspection_data_type_evidence_ids: [],
    }] } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [{ span_id: spanId, evidence_id: evidenceId }] } as SourceSpanRegistry;
    const before = JSON.stringify({ selectors, compiled, registry });
    const mapped = classifyStrictSelectorIssues(selectors, compiled, registry, [{ code: "schema",
      path: "/acceptance_items/0/inspection_data_type_evidence_ids", message: "must NOT have fewer than 1 items" }]);
    expect(mapped[0]).toMatchObject({ owner: "compiler_invariant_violation", path: "/acceptance_items/0/inspection_data_type_evidence_ids",
      details: { actual: { authored_span_ids: [spanId], compiled_evidence_ids: [] }, expected: { evidence_ids: [evidenceId] },
        writable_paths: [], next_tool_scope: "none", next_tools: [], required_action: "report_compiler_dropped_inspection_data_type_evidence" } });
    expect(mapped[0]!.details).not.toHaveProperty("next_tool");
    expect(decideStrictSelectorPreflight(mapped)).toMatchObject({ selectorOwned: false, issueOwner: "compiler_invariant_violation" });
    expect(JSON.stringify({ selectors, compiled, registry })).toBe(before);
  });

  it.each(["field_binding_relation", "field_binding_reference_route"])("%s exposes the current destination indexes without inventing a route", (code) => {
    const spans = ["local", "routed"].map((key, index) => ({
      span_id: `span:${key}`,
      evidence_id: `evidence:${key}`,
      start: index,
      end: index + 5,
    }));
    const selectors = {
      target_id: "target:route-snapshot",
      items: [{ key: "receiver", fields: {
        requirement: { composition: "reference", span_ids: spans.map((span) => span.span_id) },
      } }],
      references: [{
        key: "reference-current",
        occurrence_id: "occurrence:current",
        application_mode: "reference_only",
        target_span_ids: ["span:reference-target"],
        import_scope: {
          mode: "field_specific",
          allowed_fields: ["requirement"],
          reason: "记录当前允许导入字段。",
        },
        destinations: [
          { item_key: "other", target_field: "requirement" },
          { item_key: "receiver", target_field: "method" },
          { item_key: "receiver", target_field: "requirement" },
        ],
      }, {
        key: "placeholder-source", occurrence_id: "occurrence:placeholder", application_mode: "reference_placeholder",
        target_span_ids: [spans[1]!.span_id], destinations: [],
      }],
    } as unknown as TargetSelectorPlan;
    const before = structuredClone(selectors);
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: spans,
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "receiver"),
        evidence_ids: ["evidence:local"],
        reference_evidence_ids: [],
        field_bindings: {
          requirement: {
            composition: "reference",
            source_span_ids: spans.map((span) => span.span_id),
          },
        },
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const mapped = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans } as SourceSpanRegistry,
      [{
        code,
        path: "/acceptance_items/0/field_bindings/requirement/evidence_ids",
        message: "routed evidence needs review",
        details: { actual: ["evidence:routed"] },
      }],
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      details: {
        affected_item_key: "receiver",
        affected_field: "requirement",
        matching_reference_routes: [{
          path: "/references/0",
          key: "reference-current",
          occurrence_id: "occurrence:current",
          target_span_ids: ["span:reference-target"],
          import_scope: {
            mode: "field_specific",
            allowed_fields: ["requirement"],
            reason: "记录当前允许导入字段。",
          },
          destination_snapshot: [
            { destination_index: 0, item_key: "other", target_fields: ["requirement"] },
            { destination_index: 1, item_key: "receiver", target_fields: ["method"] },
            { destination_index: 2, item_key: "receiver", target_fields: ["requirement"] },
          ],
          matching_destination_indexes: [2],
        }],
        matching_reference_routes_basis: "same_item_and_field_destination_only_not_source_membership",
        matching_placeholder_sources: [{
          reference_key: "placeholder-source", path: "/references/1", occurrence_id: "occurrence:placeholder",
          matching_target_span_ids: [spans[1]!.span_id], destinations: [],
          match_basis: "authored_target_span_contains_rejected_span",
        }],
        allowed_actions: expect.arrayContaining([expect.stringContaining("placeholder destinations 必须保持为空")]),
        reference_source_instruction: expect.stringContaining("不能把另一 occurrence 的来源塞入已有上游引用"),
      },
    });
    expect(selectors).toEqual(before);
  });

  it("keeps each field-binding repair tool pointed at its own implicated evidence", () => {
    const spans = [
      { span_id: "span:bad-a", evidence_id: "evidence:bad-a", start: 0, end: 2 },
      { span_id: "span:bad-b", evidence_id: "evidence:bad-b", start: 3, end: 5 },
    ];
    const selectors = {
      target_id: "target:two-evidence", items: [{ key: "receiver", fields: {
        requirement: { composition: "reference", span_ids: spans.map(span => span.span_id) },
      } }], references: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: spans,
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(selectors.target_id, "receiver"),
        evidence_ids: ["evidence:bad-a", "evidence:bad-b"], reference_evidence_ids: [],
        field_bindings: { requirement: { composition: "reference", source_span_ids: spans.map(span => span.span_id) } },
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const mapped = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans } as SourceSpanRegistry,
      [{
        code: "field_binding_relation",
        path: "/acceptance_items/0/field_bindings/requirement/evidence_ids",
        message: "unrelated evidence",
        details: ["evidence:bad-a", "evidence:bad-b"],
      }],
    );
    expect(mapped).toHaveLength(2);
    expect(mapped.map(entry => ({
      path: entry.path,
      evidence_id: (entry.details as any).actual.evidence_id,
      next_evidence_id: (entry.details as any).next_tool_arguments.evidence_id,
      hinted_evidence_id: (entry.details as any).tool_argument_hints.open_evidence.evidence_id,
    }))).toEqual([
      { path: "/items/0/fields/requirement/span_ids/0", evidence_id: "evidence:bad-a", next_evidence_id: "evidence:bad-a", hinted_evidence_id: "evidence:bad-a" },
      { path: "/items/0/fields/requirement/span_ids/1", evidence_id: "evidence:bad-b", next_evidence_id: "evidence:bad-b", hinted_evidence_id: "evidence:bad-b" },
    ]);
  });

  it("does not recommend a failing reference receiver merely because its criterion contains the origin",()=>{
    const full=`span:${"a".repeat(32)}`,literal=`span:${"b".repeat(32)}`,current=`span:${"c".repeat(32)}`;
    const selectors={target_id:"target:origin",items:[{key:"mud",criterion_span_ids:[full],continuation_span_ids:[],fields:{name:{span_ids:[literal]},requirement:{span_ids:[current]}}}],references:[{occurrence_id:"ref",destinations:[{item_key:"mud",target_field:"requirement"}]}]} as unknown as TargetSelectorPlan;
    const compiled={schema_version:"semantic-source-plan/v8",source_spans:[],acceptance_items:[],reference_resolutions:[{occurrence_id:"ref",destination_bindings:[{item_id:semanticItemIdForSelectorKey(selectors.target_id,"mud"),target_field:"requirement"}]}]} as unknown as PersistedSemanticSourcePlan;
    const registry={spans:[{span_id:full,evidence_id:"evidence:origin",start:0,end:80},{span_id:literal,evidence_id:"evidence:origin",start:20,end:30},{span_id:current,evidence_id:"evidence:origin",start:8,end:32}]} as SourceSpanRegistry;
    const [mapped]=classifyStrictSelectorIssues(selectors,compiled,registry,[{code:"reference_origin_relation",path:"/reference_resolutions/0/destination_bindings/0",message:"visible origin missing",details:{origin_evidence_id:"evidence:origin",reference_literal_span_id:literal}}]);
    expect(mapped).toMatchObject({owner:"selector_input_error",details:{candidate_item_keys:[],affected_item_key:"mud",affected_field_path:"/items/0/fields",origin_context_span_ids:[full],required_action:"inspect_origin_and_repair_visible_field_provenance_or_select_the_real_receiver"}});
    expect(mapped!.details).toMatchObject({
      writable_path: "/items/0/fields",
      writable_paths: ["/items/0/fields", "/references/0/destinations/0/item_key"],
      how_to_pass: expect.stringContaining("接收项选错"),
      candidate_read_tool: "open_evidence",
      candidate_read_tools: ["open_evidence", "read_target_selectors"],
      next_tool: "open_evidence",
      save_tool: "stage_target_selector_draft",
      full_origin_span_ids: [full],
      current_origin_field_spans: [
        { field: "name", path: "/items/0/fields/name/span_ids/0", span_id: literal,
          evidence_id: "evidence:origin", start: 20, end: 30, covers_reference_literal: true },
        { field: "requirement", path: "/items/0/fields/requirement/span_ids/0", span_id: current,
          evidence_id: "evidence:origin", start: 8, end: 32, covers_reference_literal: true },
      ],
    });
    expect((mapped!.details as any).how_to_pass).toContain("追加与 current_origin_field_spans 区间重叠的 span");
    expect((mapped!.details as any).instruction).toContain("不是强制复制答案");
    const [provenanceOnly] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "reference_origin_relation", path: "/reference_resolutions/0/destination_bindings/0", message: "provenance missing",
      details: { origin_evidence_id: "evidence:origin", reference_literal_span_id: literal,
        actual: { missing_origin_evidence_ids: ["evidence:origin"], origin_context_retained: true } },
    }]);
    expect(provenanceOnly!.details).toMatchObject({ actual: { origin_context_retained: true },
      writable_path: "/items/0/criterion_span_ids", writable_paths: expect.arrayContaining(["/items/0/continuation_span_ids"]),
      how_to_pass: expect.stringContaining("显示字段已保留"), instruction: expect.stringContaining("不要重复显示") });
    expect((provenanceOnly!.details as any).how_to_pass).not.toContain("只改 reason、criterion_span_ids");
  });

  it("routes empty shared-rule min_sampling schema failures back to the authored branch", () => {
    const selectors = {
      target_id: "target:sampling-schema",
      items: [{ key: "pad" }],
      sampling_rules: [{ key: "rule-default-or-local", branches: [{ key: "has-local-clause" }, { key: "inspection-lot" }] }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "pad"),
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const [mapped] = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [{
        code: "schema",
        path: "/shared_sampling_rules/0/branches/0/min_sampling",
        message: "must NOT have fewer than 1 characters",
        details: { required_action: "must NOT have fewer than 1 characters" },
      }],
    );
    expect(mapped).toMatchObject({
      owner: "selector_input_error",
      path: "/sampling_rules/0/branches/0",
      details: {
        compiled_path: "/shared_sampling_rules/0/branches/0/min_sampling",
        writable_collection: "sampling_rules",
        required_action: "remove_source_routing_branch_or_bind_an_executable_quantity",
      },
    });
  });

  it("keeps model input, compiler, final contract, and coverage failures separate", () => {
    expect(classifySelectorIssue("selector-local", issue("selector_role_conflict")).owner)
      .toBe("selector_input_error");
    expect(classifySelectorIssue("selector-local", issue("selector_sampling_selected_branch_quantity_missing")).owner)
      .toBe("selector_input_error");
    expect(classifySelectorIssue("selector-local", issue("selector_sampling_branch_quantity_missing")).owner)
      .toBe("selector_input_error");
    expect(classifySelectorIssue("selector-local", issue("selector_registry_mismatch")).owner)
      .toBe("compiler_invariant_violation");
    expect(classifySelectorIssue("selector-local", issue("selector_evidence_mismatch")).owner)
      .toBe("compiler_invariant_violation");
    expect(classifySelectorIssue("compiler-invariant", issue("compiler_receiver_mismatch")).owner)
      .toBe("compiler_invariant_violation");
    expect(classifySelectorIssue("compiler-invariant", {
      code: "compiler_unhandled_evidence",
      path: "/evidence_dispositions",
      message: "Compiler must materialize every required source disposition",
      details: { evidence_ids: ["evidence:unhandled"] },
    })).toMatchObject({
      owner: "selector_input_error",
      path: "/source_dispositions",
      details: {
        compiled_path: "/evidence_dispositions",
        evidence_ids: ["evidence:unhandled"],
        writable_collection: "source_dispositions",
        required_action: "bind_semantically_or_stage_an_explicit_source_disposition",
        next_tool: "list_evidence_resources",
        next_tool_arguments: { cursor: 0, limit: 100 },
      },
    });
    expect(classifySelectorIssue("compiler-invariant", {
      code: "compiler_semantic_primary_atom_unclassified",
      path: "/semantic_evidence",
      message: "Every discovery-selected atom must receive a semantic role or an explicit evidence disposition",
      details: { evidence_id: "evidence:unclassified" },
    })).toMatchObject({
      owner: "selector_input_error",
      path: "/source_dispositions",
      details: {
        compiled_path: "/semantic_evidence",
        writable_collection: "source_dispositions",
        required_action: "bind_semantically_or_stage_an_explicit_source_disposition",
      },
    });
    expect(classifySelectorIssue("compiler-invariant", {
      code: "compiler_semantic_reference_unresolved",
      path: "/semantic_references/0/status",
      message: "A review reference cannot pass materialization",
    })).toMatchObject({
      owner: "selector_input_error",
      path: "/references",
      details: {
        compiled_path: "/semantic_references/0/status",
        writable_collection: "references",
      },
    });
    expect(classifySelectorIssue("compiler-invariant", {
      code: "compiler_table_assembly_evidence_out_of_scope",
      path: "/table_assembly/logical_tables/0/evidence_ids",
      message: "Logical table may cite only title, header, or formal-row evidence attached to its physical fragments",
      details: { actual: ["evidence:extra"] },
    })).toMatchObject({
      owner: "selector_input_error",
      path: "/items",
      details: {
        compiled_path: "/table_assembly/logical_tables/0/evidence_ids",
        writable_collection: "items",
      },
    });
    expect(classifySelectorIssue("compiler-invariant", {
      ...issue("compiler_semantic_item_fragment_not_materialized"),
      path: "/semantic_evidence/2/materialized_item_id",
      selector_path: "/items/3/criterion_span_ids",
    } as ReturnType<typeof issue> & { selector_path: string })).toMatchObject({
      owner: "selector_input_error",
      path: "/items/3/criterion_span_ids",
      details: { compiled_path: "/semantic_evidence/2/materialized_item_id" },
    });
    const faithfulTitleMismatch = {
      code: "compiler_table_title_fragment_mismatch",
      path: "/table_assembly/logical_tables/0/canonical_title_fragments",
      message: "title mismatch",
      selector_path: "/items/4/table/properties/table_title_span_ids",
      details: { required_action: "title mismatch", faithful_selector_projection: true },
    };
    expect(classifySelectorIssue("compiler-invariant", faithfulTitleMismatch)).toMatchObject({
      owner: "selector_input_error",
      path: "/items/4/table/properties/table_title_span_ids",
      details: { compiled_path: faithfulTitleMismatch.path, faithful_selector_projection: true },
    });
    expect(classifySelectorIssue("compiler-invariant", {
      ...faithfulTitleMismatch, code: "compiler_noncanonical_table_title",
    })).toMatchObject({owner: "selector_input_error", path: faithfulTitleMismatch.selector_path});
    expect(classifySelectorIssue("compiler-invariant", {
      ...faithfulTitleMismatch, code: "compiler_noncanonical_table_title", details: {},
    }).owner).toBe("compiler_invariant_violation");
    expect(classifySelectorIssue("compiler-invariant", {
      ...faithfulTitleMismatch,
      selector_path: undefined,
      details: {},
    }).owner).toBe("compiler_invariant_violation");
    expect([
      classifySelectorIssue("compiler-invariant", faithfulTitleMismatch),
      classifySelectorIssue("compiler-invariant", issue("compiler_unhandled_evidence")),
    ].every((entry) => entry.owner === "selector_input_error")).toBe(true);
    expect(classifySelectorIssue("compiler-invariant", issue("compiler_duplicate_table_title_fragment"))).toMatchObject({
      owner: "selector_input_error",
      path: "/items",
      details: { writable_collection: "items" },
    });
    expect(classifySelectorIssue("strict-validator", issue("semantic_reference_not_materialized")).owner)
      .toBe("compiler_invariant_violation");
    expect(classifySelectorIssue("strict-validator", issue("domain_business_rule")).owner)
      .toBe("final_contract_violation");
    expect(classifySelectorIssue("coverage-review", issue("missing_domain_item")).owner)
      .toBe("coverage_finding");
  });

  it("routes a faithfully compiled cross-item explicit sampling rule back to selector repair", () => {
    const selectors = {
      target_id: "target:sampling-owner",
      items: [{ key: "bearing-capacity" }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "bearing-capacity"),
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const issues = [
      issue("sampling_non_rule_evidence"),
      issue("explicit_sampling_without_specific_evidence"),
    ].map((entry) => ({
      ...entry,
      path: "/acceptance_items/0/sampling/evidence_ids",
    }));

    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      issues,
    )).toEqual(issues.map((entry) => expect.objectContaining({
      code: entry.code,
      owner: "selector_input_error",
      path: "/items/0/sampling/status",
      details: expect.objectContaining({
        compiled_path: "/acceptance_items/0/sampling/evidence_ids",
        sampling_rule_selector_path: "/sampling_rules",
      }),
    })));
  });

  it("routes faithful reference target selection errors back to the authored reference spans", () => {
    const firstSpanId = `span:${"d".repeat(32)}`;
    const secondSpanId = `span:${"e".repeat(32)}`;
    const firstEvidenceId = "evidence:table-row-1";
    const secondEvidenceId = "evidence:table-row-2";
    const selectors = {
      target_id: "target:reference-owner",
      items: [],
      // The author may register rows in any order; compilation sorts them by source order.
      references: [{
        key: "ref-table", occurrence_id: "reference:table", target_span_ids: [secondSpanId, firstSpanId],
        anchor_span_ids: [firstSpanId], action: "adopt", application_mode: "reference_only",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "按已读原文采用判据" },
        destinations: [{ item_key: "receiver", target_field: "requirement" }],
        reason: "保留原条文引用位置和受影响项目的正确字段",
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [],
      reference_resolutions: [{
        occurrence_id: "reference:table",
        target_evidence_ids: [firstEvidenceId, secondEvidenceId],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [
      { span_id: firstSpanId, evidence_id: firstEvidenceId, atom_id: firstEvidenceId,
        start: 0, end: 8, text_sha256: "hash-1" },
      { span_id: secondSpanId, evidence_id: secondEvidenceId, atom_id: secondEvidenceId,
        start: 0, end: 8, text_sha256: "hash-2" },
    ] } as unknown as SourceSpanRegistry;
    const issues = ["reference_target_outside_occurrence", "reference_target_not_data_row"].map((code) => ({
      code,
      path: "/reference_resolutions/0/target_evidence_ids",
      message: code,
      details: code === "reference_target_outside_occurrence"
        ? { outside_target_evidence_ids: [secondEvidenceId], allowed_target_evidence_ids: [firstEvidenceId] }
        : { non_data_row_evidence_ids: [secondEvidenceId], allowed_target_evidence_ids: [firstEvidenceId] },
    }));

    expect(classifyStrictSelectorIssues(selectors, compiled, registry, issues)).toEqual(
      issues.map((entry) => expect.objectContaining({
        code: entry.code,
        owner: "selector_input_error",
        path: "/references/0/target_span_ids",
        details: expect.objectContaining({
          compiled_path: entry.path,
          reference_key: "ref-table",
          occurrence_id: "reference:table",
          offending_target_spans: [{
            index: 0, span_id: secondSpanId, evidence_id: secondEvidenceId, atom_id: secondEvidenceId,
            start: 0, end: 8, writable_path: "/references/0/target_span_ids/0",
            save_template_path: "/draft/references/0/target_span_ids/0",
          }],
          writable_path: "/references/0/target_span_ids",
          writable_paths: ["/references/0/target_span_ids"],
          candidate_read_tools: expect.arrayContaining([
            "read_target_selectors",
            "list_reference_occurrences",
            "read_reference_facts",
            "locate_evidence_span",
          ]),
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "references", key: "ref-table" },
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("只在 allowed_target_evidence_ids"),
          do_not_edit: expect.stringContaining("未被本条点名"),
        }),
      })),
    );

    for (const mapped of classifyStrictSelectorIssues(selectors, compiled, registry, issues)) {
      const details = mapped.details as any;
      const save = details.tool_argument_hints.stage_target_selector_draft;
      expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, save)).toBe(true);
      expect(save).toEqual({ operation: "upsert", draft: { references: [selectors.references[0]] } });
      expect(details.required_edit_before_save.path).toBe("/draft/references/0/target_span_ids");
      // Editing the copied save template must preserve the current authored record.
      save.draft.references[0].target_span_ids = [firstSpanId];
      expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, save)).toBe(true);
      expect(selectors.references[0]!.target_span_ids).toEqual([secondSpanId, firstSpanId]);
      expect(save.draft.references[0].destinations).toEqual(selectors.references[0]!.destinations);
      expect(save.draft.references[0].import_scope).toEqual(selectors.references[0]!.import_scope);
    }

    const drifted = structuredClone(compiled);
    drifted.reference_resolutions[0]!.target_evidence_ids = ["evidence:compiler-drift"];
    expect(classifyStrictSelectorIssues(selectors, drifted, registry, issues)[0]?.owner)
      .toBe("compiler_invariant_violation");
  });

  it("gives a writable empty-target repair for an unresolved occurrence", () => {
    const anchorSpanId = `span:${"a".repeat(32)}`;
    const foreignSpanId = `span:${"b".repeat(32)}`;
    const reference = {
      key: "unresolved-reference", occurrence_id: "occurrence:unresolved",
      anchor_span_ids: [anchorSpanId], target_span_ids: [foreignSpanId],
      action: "adopt", application_mode: "reference_only",
      import_scope: { mode: "field_specific", allowed_fields: ["requirement"], reason: "原引用位置" },
      destinations: [{ item_key: "receiver", target_field: "requirement" }],
      reason: "保留原引用及其目标状态",
    };
    const selectors = { target_id: "target:unresolved", items: [], references: [reference] } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [],
      reference_resolutions: [{ occurrence_id: "occurrence:unresolved", target_evidence_ids: ["evidence:foreign"] }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [{ span_id: foreignSpanId, evidence_id: "evidence:foreign", start: 0, end: 5 }] } as SourceSpanRegistry;
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "reference_target_outside_occurrence", path: "/reference_resolutions/0/target_evidence_ids",
      message: "target is outside occurrence",
      details: { occurrence_status: "target_not_found", allowed_target_evidence_ids: [], outside_target_evidence_ids: ["evidence:foreign"] },
    }]);
    expect(mapped).toMatchObject({
      owner: "selector_input_error", path: "/references/0/target_span_ids",
      details: { reference_key: reference.key, next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft" },
    });
    const details = mapped!.details as any;
    expect(details.how_to_pass).toContain("清空本条 target_span_ids");
    expect(details.how_to_pass).toContain("不能生成 resolved route");
    expect(details.how_to_pass).not.toContain("从 allowed_target_evidence_ids");
    const save = details.tool_argument_hints.stage_target_selector_draft;
    expect(Check(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA, save)).toBe(true);
    expect(save.draft.references[0]).toMatchObject({
      key: reference.key, anchor_span_ids: reference.anchor_span_ids,
      target_span_ids: [], action: "keep_reference", application_mode: "reference_only",
      destinations: reference.destinations,
    });
    expect(selectors.references[0]!.target_span_ids).toEqual([foreignSpanId]);
    expect(decideStrictSelectorPreflight([mapped!]).selectorOwned).toBe(true);
  });

  it("maps an implicitly inferred duplicate occurrence to both writable references", () => {
    const targetId = "target:duplicate-occurrence";
    const selectors = { target_id: targetId, items: [], references: [
      { key: "first-reference", occurrence_id: "occurrence:shared", anchor_span_ids: ["span:origin"] },
      { key: "second-reference", anchor_span_ids: ["span:origin"] },
    ] } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [],
      reference_resolutions: selectors.references.map((reference) => ({
        resolution_id: semanticResolutionIdForSelectorKey(targetId, reference.key),
        occurrence_id: "occurrence:shared", target_evidence_ids: [],
      })),
    } as unknown as PersistedSemanticSourcePlan;
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, { spans: [] } as SourceSpanRegistry, [{
      code: "duplicate_reference_occurrence_resolution", path: "/reference_resolutions",
      message: "occurrence resolved twice", details: { occurrence_id: "occurrence:shared", count: 2 },
    }]);
    expect(mapped).toMatchObject({
      owner: "selector_input_error", path: "/references",
      details: {
        matching_reference_keys: ["first-reference", "second-reference"],
        matching_reference_paths: ["/references/0", "/references/1"],
        next_tool: "read_target_selectors", save_tool: "stage_target_selector_draft",
      },
    });
    expect((mapped!.details as any).how_to_pass).toContain("remove_keys");
    expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: true, issueOwner: "selector_input_error" });
  });

  it("maps duplicate routes to both authored references without confusing authorization with routing", () => {
    const targetId = "target:duplicate-routes";
    const itemId = semanticItemIdForSelectorKey(targetId, "receiver");
    const shared = `span:${"a".repeat(32)}`, unique = `span:${"b".repeat(32)}`;
    const refs = [
      { key: "current", occurrence_id: "occurrence:current", target_span_ids: [shared, unique], destinations: [
        { item_key: "receiver", target_field: "method" }, { item_key: "receiver", target_field: "requirement" },
      ] },
      { key: "earlier", occurrence_id: "occurrence:earlier", target_span_ids: [shared], destinations: [{ item_key: "receiver", target_field: "requirement" }] },
      { key: "other-field", occurrence_id: "occurrence:other-field", target_span_ids: [shared], destinations: [{ item_key: "receiver", target_field: "method" }] },
      { key: "other-item", occurrence_id: "occurrence:other-item", target_span_ids: [shared], destinations: [{ item_key: "other", target_field: "requirement" }] },
    ].map(reference => ({ ...reference, application_mode: "reference_only", import_scope: { mode: "field_specific", allowed_fields: ["requirement", "method"], reason: "现有授权" } }));
    const selectors = { target_id: targetId, items: [{ key: "receiver" }, { key: "other" }], references: refs } as unknown as TargetSelectorPlan;
    const registry = { spans: [{ span_id: shared, evidence_id: "evidence:shared", start: 0, end: 4 }, { span_id: unique, evidence_id: "evidence:unique", start: 0, end: 5 }] } as unknown as SourceSpanRegistry;
    const compiled = { schema_version: "semantic-source-plan/v8", source_spans: registry.spans, acceptance_items: [], reference_resolutions: [1, 2, 3, 0].map(index => ({
      occurrence_id: refs[index]!.occurrence_id,
      target_evidence_ids: index === 0 ? ["evidence:shared", "evidence:unique"] : ["evidence:shared"],
      destination_bindings: refs[index]!.destinations.map(destination => ({ item_id: semanticItemIdForSelectorKey(targetId, destination.item_key), target_field: destination.target_field })),
    })) } as unknown as PersistedSemanticSourcePlan;
    const before = structuredClone(selectors);
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "duplicate_reference_route", path: "/reference_resolutions/3/destination_bindings/1", message: "duplicate route",
      details: { route: `${itemId}|requirement|evidence:shared` },
    }]);
    expect(mapped).toMatchObject({
      owner: "selector_input_error", path: "/references/0/destinations/1/target_field",
      details: {
        reference_key: "current", affected_item_key: "receiver", affected_field: "requirement",
        actual: { evidence_ids: ["evidence:shared"], current_destination: { item_key: "receiver", target_field: "requirement" } },
        conflicting_reference_routes: [{ reference_key: "earlier", path: "/references/1/destinations/0", matching_evidence_ids: ["evidence:shared"], matching_target_span_ids: [shared] }],
        writable_paths: expect.arrayContaining(["/references/0/destinations", "/references/1/destinations"]),
        next_tool: "read_target_selectors", next_tool_arguments: { collection: "references", key: "current" },
        save_tool: "stage_target_selector_draft", save_tool_instruction: expect.stringContaining("draft.references"),
        route_instruction: expect.stringContaining("不要求新增 destination"),
        how_to_pass: expect.stringContaining("conflicting_reference_routes"),
      },
    });
    const details = mapped!.details as any;
    expect(details.writable_paths.some((entry: string) => entry.startsWith("/references/2/") || entry.startsWith("/references/3/"))).toBe(false);
    expect(details.tool_argument_hints.stage_target_selector_draft).toBeUndefined();
    expect(details.tool_argument_hints.read_target_selectors).toEqual([{ collection: "references", key: "current" }, { collection: "references", key: "earlier" }, { collection: "items", key: "receiver" }]);
    expect(selectors).toEqual(before);
  });

  it("routes a faithful reference import-scope violation back to selector repair", () => {
    const targetId = "target:reference-import-scope";
    const itemId = semanticItemIdForSelectorKey(targetId, "receiver");
    const selectors = {
      target_id: targetId,
      items: [{ key: "receiver" }],
      references: [{
        occurrence_id: "reference:table",
        import_scope: { mode: "field_specific", allowed_fields: ["requirement"] },
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [],
      reference_resolutions: [{ occurrence_id: "reference:table" }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_import_scope_exceeded",
      path: "/reference_resolutions/0/import_scope/allowed_fields",
      message: "name was imported outside the authored requirement-only scope",
      details: { item_id: itemId, imported_fields: ["name", "requirement"], outside_import_scope: ["name"] },
    };

    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_import_scope_exceeded",
      owner: "selector_input_error",
      path: "/references/0/import_scope/allowed_fields",
      message: expect.stringMatching(/[\u3400-\u9fff]/),
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:table",
        required_action: "align_import_scope_allowed_fields_with_the_exact_reference_content_used_by_each_destination_field_or_remove_the_unauthorized_import",
        actual: expect.objectContaining({
          allowed_fields: ["requirement"],
          imported_fields: ["name", "requirement"],
          outside_import_scope: ["name"],
          item_id: itemId,
          item_key: "receiver",
        }),
        writable_paths: [
          "/references/0/import_scope/allowed_fields",
          "/references/0/target_span_ids",
          "/references/0/destinations",
          "/references/0/component_dispositions",
          "/items/0/fields/name",
        ],
        candidate_read_tool: "read_target_selectors",
        candidate_read_tools: ["read_target_selectors"],
        next_tool: "read_target_selectors",
        next_tools: ["read_target_selectors", "stage_target_selector_draft"],
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("三种合法修法"),
        route_instruction: expect.stringContaining("不要求新增 destination"),
      }),
    })]);
  });

  it("import-scope feedback exposes overbroad target selection without deleting another reference's legitimate receiver bindings", () => {
    const targetId = "target:neutral-selection", receiverId = semanticItemIdForSelectorKey(targetId, "receiver");
    const registry = { spans: [
      { span_id: "span:criterion", evidence_id: "evidence:criterion", start: 0, end: 12 },
      { span_id: "span:quantity", evidence_id: "evidence:quantity", start: 0, end: 8 },
    ] } as SourceSpanRegistry;
    const selectors = { target_id: targetId, items: [{ key: "receiver", fields: {
      requirement: { composition: "reference", span_ids: ["span:criterion"] },
      quantity: { composition: "reference", span_ids: ["span:quantity"] },
    }, sampling: { rule_key: "neutral-sampling" } }], sampling_rules: [{ key: "neutral-sampling" }], references: [
      { key: "quantity-reference", occurrence_id: "quantity-occurrence", target_span_ids: ["span:criterion", "span:quantity"],
        destinations: [{ item_key: "receiver", target_field: "quantity" }], import_scope: { allowed_fields: ["quantity"] } },
      { key: "criterion-reference", occurrence_id: "criterion-occurrence", target_span_ids: ["span:criterion"],
        destinations: [{ item_key: "receiver", target_field: "requirement" }], import_scope: { allowed_fields: ["requirement"] } },
    ] } as unknown as TargetSelectorPlan;
    const compiled = { schema_version: "semantic-source-plan/v8", source_spans: [], acceptance_items: [], reference_resolutions: [
      { occurrence_id: "quantity-occurrence", target_evidence_ids: ["evidence:criterion", "evidence:quantity"],
        destination_bindings: [{ item_id: receiverId, target_field: "quantity" }] },
      { occurrence_id: "criterion-occurrence", target_evidence_ids: ["evidence:criterion"],
        destination_bindings: [{ item_id: receiverId, target_field: "requirement" }] },
    ] } as unknown as PersistedSemanticSourcePlan;
    const original = JSON.stringify({ selectors, compiled, registry });
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "reference_import_scope_exceeded", path: "/reference_resolutions/0/import_scope/allowed_fields", message: "scope mismatch",
      details: { item_id: receiverId, imported_fields: ["quantity", "requirement", "sampling"], outside_import_scope: ["requirement", "sampling"] },
    }]);
    const details = mapped!.details as any;
    expect(details.actual).toMatchObject({ selected_target_span_ids: ["span:criterion", "span:quantity"],
      selected_target_evidence_ids: ["evidence:criterion", "evidence:quantity"],
      current_destinations: [{ item_key: "receiver", target_field: "quantity" }],
      direct_matching_author_field_spans: [
        { field: "requirement", span_id: "span:criterion", evidence_id: "evidence:criterion", start: 0, end: 12 },
        { field: "quantity", span_id: "span:quantity", evidence_id: "evidence:quantity", start: 0, end: 8 },
      ],
      other_same_receiver_reference_routes: [{ reference_key: "criterion-reference", occurrence_id: "criterion-occurrence",
        destination_fields: ["requirement"], overlapping_evidence_ids: ["evidence:criterion"] }] });
    expect(details.allowed_actions).toHaveLength(3);
    expect(details.writable_paths).toContain("/references/0/target_span_ids");
    expect(details.next_tool_arguments).toEqual({ collection: "references", key: "quantity-reference" });
    expect(details.tool_argument_hints.read_target_selectors).toEqual([
      { collection: "references", key: "quantity-reference" }, { collection: "items", key: "receiver" },
      { collection: "references", key: "criterion-reference" }, { collection: "sampling_rules", key: "neutral-sampling" },
    ]);
    expect(details.how_to_pass).toContain("保留其他引用合法承载的字段");
    expect(details.how_to_pass).toContain("补齐授权不要求新增 destination");
    expect(details.how_to_pass).toContain("只改 reason、component_dispositions 或 destinations 不会移除");
    expect(details.expected).toContain("授权不是 destinations 的副本");
    expect(details).not.toHaveProperty("correct_target_span_ids");
    expect(JSON.stringify({ selectors, compiled, registry })).toBe(original);
  });

  it("treats empty destination_bindings on external keep_reference as fixable selector input", () => {
    const selectors = {
      target_id: "target:external-sampling-ref",
      items: [{ key: "dynamic-compaction" }],
      references: [{
        occurrence_id: "reference:external-gb50300",
        action: "keep_reference",
        application_mode: "reference_only",
        target_span_ids: [],
        destinations: [],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "dynamic-compaction"),
      }],
      reference_resolutions: [{
        occurrence_id: "reference:external-gb50300",
        action: "keep_reference",
        application_mode: "reference_only",
        target_evidence_ids: [],
        destination_bindings: [],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_destination_required",
      path: "/reference_resolutions/0/destination_bindings",
      message: "非占位引用必须关联到原引用实际所在的业务字段。",
      details: { origin_field: "sampling" },
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_destination_required",
      owner: "selector_input_error",
      path: "/references/0/destinations",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:external-gb50300",
        required_action: expect.stringMatching(/origin_field|sampling|destination/i),
      }),
    })]);
  });

  it("routes a faithfully empty resolved target back to authored target_span_ids", () => {
    const selectors = {
      target_id: "target:resolved-empty",
      items: [{ key: "saline-soil" }],
      references: [{
        occurrence_id: "reference:clause-8.2.1",
        target_span_ids: [],
        destinations: [{ item_key: "saline-soil", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "saline-soil"),
      }],
      reference_resolutions: [{
        occurrence_id: "reference:clause-8.2.1",
        target_evidence_ids: [],
        destination_bindings: [{
          item_id: semanticItemIdForSelectorKey(selectors.target_id, "saline-soil"),
          target_field: "requirement",
        }],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_resolved_target_required",
      path: "/reference_resolutions/0/target_evidence_ids",
      message: "resolved 引用必须包含被引证据",
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_resolved_target_required",
      owner: "selector_input_error",
      path: "/references/0/target_span_ids",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:clause-8.2.1",
        required_action: "select_resolved_target_spans_or_keep_target_not_found_receipt",
      }),
    })]);
    expect(classifyStrictSelectorIssues(
      selectors,
      { ...compiled, schema_version: "semantic-source-plan/v7" } as unknown as PersistedSemanticSourcePlan,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )[0]?.owner).toBe("selector_input_error");
  });

  it("keeps a compiled-empty resolved target as a compiler invariant when the selector already named targets", () => {
    const spanId = `span:${"t".repeat(32)}`;
    const selectors = {
      target_id: "target:resolved-dropped",
      items: [{ key: "saline-soil" }],
      references: [{
        occurrence_id: "reference:clause-8.2.1",
        target_span_ids: [spanId],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [],
      reference_resolutions: [{
        occurrence_id: "reference:clause-8.2.1",
        target_evidence_ids: [],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = {
      spans: [{ span_id: spanId, evidence_id: "evidence:target", start: 0, end: 4 }],
    } as unknown as SourceSpanRegistry;
    const strictIssue = {
      code: "reference_resolved_target_required",
      path: "/reference_resolutions/0/target_evidence_ids",
      message: "resolved 引用必须包含被引证据",
    };

    expect(classifyStrictSelectorIssues(selectors, compiled, registry, [strictIssue])[0]).toMatchObject({
      owner: "compiler_invariant_violation",
      path: strictIssue.path,
    });
  });

  it("routes a faithful replace_field scalar-target-count error back to application_mode", () => {
    const firstSpan = `span:${"1".repeat(32)}`;
    const secondSpan = `span:${"2".repeat(32)}`;
    const selectors = {
      target_id: "target:replace-count",
      items: [{ key: "saline-soil" }],
      references: [{
        occurrence_id: "reference:table-6.4.2",
        application_mode: "replace_field",
        target_span_ids: [firstSpan, secondSpan],
        destinations: [{ item_key: "saline-soil", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "saline-soil"),
      }],
      reference_resolutions: [{
        occurrence_id: "reference:table-6.4.2",
        application_mode: "replace_field",
        target_evidence_ids: ["evidence:row-a", "evidence:row-b"],
        destination_bindings: [{
          item_id: semanticItemIdForSelectorKey(selectors.target_id, "saline-soil"),
          target_field: "requirement",
        }],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_scalar_target_count",
      path: "/reference_resolutions/0/target_evidence_ids",
      message: "replace_field 会重建整个目标字段，因此必须且只能选择一条目标证据",
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_scalar_target_count",
      owner: "selector_input_error",
      path: "/references/0/application_mode",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:table-6.4.2",
        required_action: "set_application_mode_to_reference_only_or_keep_exactly_one_target_span",
      }),
    })]);
  });

  it("routes a faithful replace_field retained-literal error back to application_mode", () => {
    const itemId = semanticItemIdForSelectorKey("target:replace-literal", "saline-soil");
    const selectors = {
      target_id: "target:replace-literal",
      items: [{ key: "saline-soil" }],
      references: [{
        occurrence_id: "reference:gb50300",
        application_mode: "replace_field",
        destinations: [{ item_key: "saline-soil", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: itemId,
        requirement: "地基处理尚应符合现行国家标准《建筑地基基础工程施工质量验收标准》GB 50300 的规定。",
      }],
      reference_resolutions: [{
        occurrence_id: "reference:gb50300",
        application_mode: "replace_field",
        destination_bindings: [{ item_id: itemId, target_field: "requirement" }],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_literal_retained",
      path: "/acceptance_items/0/requirement",
      message: "replace_field 会删除目标字段全部本地值",
      details: { alternative_application_mode: "reference_only", retained_literal: "GB 50300" },
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_literal_retained",
      owner: "selector_input_error",
      path: "/references/0/application_mode",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:gb50300",
        required_action: "set_application_mode_to_reference_only_and_keep_local_field",
      }),
    })]);
  });

  it("routes a faithful destination-field mismatch back to the authored target_field", () => {
    const itemId = semanticItemIdForSelectorKey("target:field-mismatch", "compaction");
    const selectors = {
      target_id: "target:field-mismatch",
      items: [{ key: "compaction" }],
      references: [{
        occurrence_id: "reference:gb50300-sampling",
        destinations: [{ item_key: "compaction", target_field: "quantity" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{ item_id: itemId }],
      reference_resolutions: [{
        occurrence_id: "reference:gb50300-sampling",
        destination_bindings: [{ item_id: itemId, target_field: "quantity" }],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "reference_destination_field_mismatch",
      path: "/reference_resolutions/0/destination_bindings",
      message: "引用 destinations 必须精确覆盖 occurrence 原本所在的业务字段",
      details: { item_id: itemId, expected: ["sampling"], actual: ["quantity"] },
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      code: "reference_destination_field_mismatch",
      owner: "selector_input_error",
      path: "/references/0/destinations/0/target_field",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:gb50300-sampling",
        required_action: "bind_destination_to_origin_field_sampling",
      }),
    })]);
  });

  it("routes a referenced-table route gap back to the authored table item", () => {
    const targetId = "target:table-route-owner";
    const selectors = {
      target_id: targetId,
      items: [{ key: "rebound-core", table: { source_kind: "reference" } }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(targetId, "rebound-core") }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "table_reference_route_missing",
      path: "/acceptance_items/0/table_semantics",
      message: "referenced table has no route",
    };

    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      owner: "selector_input_error",
      path: "/items/0/table/reference_span_ids",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        affected_item_key: "rebound-core",
        required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
        actual: { item_key: "rebound-core", reference_span_ids: [], destination_reference_keys: [] },
        required_condition: expect.stringContaining("status=resolved"),
        writable_paths: ["/references", "/items/0/table/reference_span_ids"],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "items", key: "rebound-core" },
        how_to_pass: expect.stringContaining("reference_placeholder 要求 destinations=[]"),
      }),
    })]);
  });

  it("does not prescribe a destination edit when a referenced table's occurrence has no target", () => {
    const targetId = "target:unresolved-table-route";
    const selectors = {
      target_id: targetId,
      items: [{ key: "table-row", table: { source_kind: "reference", reference_span_ids: ["span:reference"] } }],
      references: [{
        key: "table-reference", occurrence_id: "occurrence:unresolved",
        anchor_span_ids: ["span:reference"],
        destinations: [{ item_key: "table-row", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8", source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(targetId, "table-row") }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [{
      span_id: "span:reference", evidence_id: "evidence:origin", start: 0, end: 5,
    }] } as SourceSpanRegistry;
    const manifest = { reference_occurrences: [{
      occurrence_id: "occurrence:unresolved", status: "target_not_found", target_evidence_ids: [],
    }] } as unknown as EvidenceManifest;
    const [mapped] = classifyStrictSelectorIssues(selectors, compiled, registry, [{
      code: "table_reference_route_missing", path: "/acceptance_items/0/table_semantics",
      message: "referenced table has no route",
    }], manifest);
    expect(mapped).toMatchObject({
      owner: "compiler_invariant_violation", path: "/items/0/table/reference_span_ids",
      details: {
        affected_item_key: "table-row",
        unresolved_reference_routes: [{ reference_key: "table-reference", occurrence_id: "occurrence:unresolved" }],
        required_action: "repair_unresolved_reference_target_before_sealing_its_table_route",
      },
    });
    expect((mapped!.details as any).how_to_pass).toContain("destinations 不能生成本项需要的 resolved route");
    expect(decideStrictSelectorPreflight([mapped!])).toMatchObject({ selectorOwned: false, issueOwner: "compiler_invariant_violation" });
  });

  it.each(["row_path_span_ids", "applicability_span_ids", "reference_span_ids", "acceptance_branches"] as const)("routes unowned table evidence to ownership and the authored %s binding", (role) => {
    const targetId = "target:table-evidence-owner";
    const ownedSpanId = `span:${"e".repeat(32)}`;
    const unownedSpanId = `span:${"f".repeat(32)}`;
    const ownedEvidenceId = "evidence:owned";
    const unownedEvidenceId = "evidence:unowned";
    const selectors = {
      target_id: targetId,
      items: [{
        key: "rebound-core",
        criterion_span_ids: [ownedSpanId],
        continuation_span_ids: [],
        fields: {},
        table: {
          reference_span_ids: role === "reference_span_ids" ? [unownedSpanId] : [],
          properties: {
            table_no_span_ids: [ownedSpanId],
            table_title_span_ids: [],
            applicability_span_ids: role === "applicability_span_ids" ? [unownedSpanId] : [],
            row_path_span_ids: role === "row_path_span_ids" ? [[unownedSpanId]] : [],
            column_path_span_ids: [],
            unit_span_ids: [],
            condition_span_ids: [],
            allowed_value_span_ids: [],
            inspection_method_span_ids: [],
            acceptance_branches: role === "acceptance_branches"
              ? [{ key: "branch", condition_span_ids: [unownedSpanId] }] : [],
          },
        },
      }],
      references: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(targetId, "rebound-core") }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [
      { span_id: ownedSpanId, evidence_id: ownedEvidenceId },
      { span_id: unownedSpanId, evidence_id: unownedEvidenceId, start: 2, end: 9 },
    ] } as unknown as SourceSpanRegistry;
    const strictIssue = {
      code: "table_evidence_relation",
      path: "/acceptance_items/0/table_semantics",
      message: "mixed table evidence relation",
      details: [ownedEvidenceId, unownedEvidenceId],
    };

    const [tableIssue] = classifyStrictSelectorIssues(selectors, compiled, registry, [strictIssue]);
    const sourcePath = role === "reference_span_ids" ? "/items/0/table/reference_span_ids/0"
      : role === "acceptance_branches" ? "/items/0/table/properties/acceptance_branches/0/condition_span_ids/0"
      : `/items/0/table/properties/${role}/${role === "row_path_span_ids" ? "0/0" : "0"}`;
    expect((tableIssue!.details as any).tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
    expect((tableIssue!.details as any).save_tool_instruction).toContain("operation=upsert");
    expect((tableIssue!.details as any).save_tool_instruction).toContain("draft.items");
    expect((tableIssue!.details as any).save_tool_instruction).toContain("draft.references");
    expect([tableIssue]).toEqual([
      expect.objectContaining({
        owner: "selector_input_error",
        path: "/items/0/criterion_span_ids",
        details: expect.objectContaining({
          actual: expect.objectContaining({
            item_key: "rebound-core",
            unowned_table_evidence_ids: [unownedEvidenceId],
            current_table_source_bindings: [{ path: sourcePath, span_id: unownedSpanId, evidence_id: unownedEvidenceId, start: 2, end: 9 }],
          }),
          affected_item_key: "rebound-core",
          unowned_table_evidence_ids: [unownedEvidenceId],
          matching_table_span_ids: [unownedSpanId],
          reference_routes_to_item: [],
          writable_paths: [
            "/items/0/criterion_span_ids",
            "/items/0/continuation_span_ids",
            "/items/0/fields",
            "/references",
            sourcePath,
          ],
          writable_collections: ["items", "references"],
          allowed_actions: expect.arrayContaining([
            expect.stringContaining("直接业务来源"),
            expect.stringContaining("被引内容"),
            expect.stringContaining("误选"),
          ]),
          candidate_read_tools: expect.arrayContaining([
            "read_target_selectors",
            "list_table_fragments",
            "open_evidence",
            "list_reference_occurrences",
            "read_reference_facts",
          ]),
          next_tool: "read_target_selectors",
          next_tool_arguments: { collection: "items", key: "rebound-core" },
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("回条不替模型决定"),
        }),
      }),
    ]);
    expect((tableIssue!.details as any).writable_paths).not.toContain("/items/0/table/properties/table_no_span_ids/0");
    expect((tableIssue!.details as any).how_to_pass).toContain("current_table_source_bindings");
    expect(classifyStrictSelectorIssues(selectors, compiled, registry, [{
      ...strictIssue, details: { actual: ["evidence:not-authored"] },
    }])[0]?.owner).toBe("compiler_invariant_violation");
    expect(classifyStrictSelectorIssues(selectors, compiled, registry, [{
      ...strictIssue,
      details: {
        actual: [ownedEvidenceId, unownedEvidenceId],
        required_action: "Bind table cell/header/reference fragments only to evidence already on this item or its semantic reference route",
      },
    }])).toEqual([
      expect.objectContaining({
        owner: "selector_input_error",
        path: "/items/0/criterion_span_ids",
        details: expect.objectContaining({
          unowned_table_evidence_ids: [unownedEvidenceId],
          matching_table_span_ids: [unownedSpanId],
          next_tool: "read_target_selectors",
          save_tool: "stage_target_selector_draft",
        }),
      }),
    ]);
  });

  it("routes table evidence on a referenced-table child without destinations back to the authored reference", () => {
    const targetId = "target:referenced-table-no-dest";
    const selectors = {
      target_id: targetId,
      items: [{
        key: "hammer-weld-undercut-depth",
        table: { source_kind: "reference", properties: {}, reference_span_ids: [`span:${"a".repeat(32)}`] },
      }],
      references: [{
        key: "ref-weld",
        application_mode: "reference_only",
        destinations: [{ item_key: "hammer-weld-quality", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(targetId, "hammer-weld-undercut-depth") }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code: "table_evidence_relation",
      path: "/acceptance_items/0/table_semantics",
      message: "citation evidence is not on this item",
      details: { actual: ["evidence:citation-row"] },
    };

    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    )).toEqual([expect.objectContaining({
      owner: "selector_input_error",
      path: "/items/0/table/reference_span_ids",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        affected_item_key: "hammer-weld-undercut-depth",
        required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
        writable_collection: "references",
        next_tool: "list_reference_occurrences",
      }),
    })]);
  });

  it("pairs a compiler-owned table evidence twin with the selector-owned route gap", () => {
    const targetId = "target:table-route-twins";
    const selectors = {
      target_id: targetId,
      items: [{
        key: "static-weld-undercut-depth",
        criterion_span_ids: [],
        continuation_span_ids: [],
        fields: {},
        table: { source_kind: "reference", properties: {} },
      }],
      references: [{
        key: "ref-weld",
        application_mode: "reference_only",
        destinations: [{ item_key: "static-weld-undercut-depth", target_field: "requirement" }],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{ item_id: semanticItemIdForSelectorKey(targetId, "static-weld-undercut-depth") }],
    } as unknown as PersistedSemanticSourcePlan;
    const mapped = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [
        {
          code: "table_reference_route_missing",
          path: "/acceptance_items/0/table_semantics",
          message: "referenced table has no route",
        },
        {
          code: "table_evidence_relation",
          path: "/acceptance_items/0/table_semantics",
          message: "citation evidence is not on this item",
          details: { actual: ["evidence:citation-row"] },
        },
      ],
    );
    expect(mapped).toEqual([
      expect.objectContaining({
        code: "table_reference_route_missing",
        owner: "selector_input_error",
        details: expect.objectContaining({ affected_item_key: "static-weld-undercut-depth" }),
      }),
      expect.objectContaining({
        code: "table_evidence_relation",
        owner: "selector_input_error",
        details: expect.objectContaining({
          companion_issue: "table_reference_route_missing",
          required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
        }),
      }),
    ]);
    expect(decideStrictSelectorPreflight([
      {
        code: "table_reference_route_missing",
        path: "/items/0/table/reference_span_ids",
        message: "referenced table has no route",
        owner: "selector_input_error",
        details: {
          compiled_path: "/acceptance_items/0/table_semantics",
          affected_item_key: "static-weld-undercut-depth",
        },
      },
      {
        code: "table_evidence_relation",
        path: "/acceptance_items/0/table_semantics",
        message: "citation evidence is not on this item",
        owner: "compiler_invariant_violation",
        details: { compiled_path: "/acceptance_items/0/table_semantics" },
      },
    ])).toMatchObject({
      selectorOwned: true,
      issueOwner: "selector_input_error",
      reportedIssues: [
        expect.objectContaining({ code: "table_reference_route_missing", owner: "selector_input_error" }),
        expect.objectContaining({
          code: "table_evidence_relation",
          owner: "selector_input_error",
          details: expect.objectContaining({
            required_action: "add_or_retarget_the_resolved_reference_destination_to_this_table_item",
          }),
        }),
      ],
    });
    expect(decideStrictSelectorPreflight([
      {
        code: "table_reference_route_missing",
        path: "/items/0/table/reference_span_ids",
        message: "referenced table has no route",
        owner: "selector_input_error",
      },
      {
        code: "unhandled_evidence",
        path: "/evidence/0",
        message: "harness gap",
        owner: "compiler_invariant_violation",
      },
    ])).toMatchObject({
      selectorOwned: false,
      issueOwner: "compiler_invariant_violation",
    });
  });

  it("routes a faithfully compiled inspection-data evidence relation back to its selector spans", () => {
    const targetId = "target:inspection-data-owner";
    const spanId = `span:${"c".repeat(32)}`;
    const retainedSpanId = `span:${"b".repeat(32)}`;
    const evidenceId = "evidence:wrong-item";
    const retainedEvidenceId = "evidence:current-item";
    const selectors = {
      target_id: targetId,
      items: [{
        key: "dimension",
        inspection_data_type: "measurement",
        inspection_data_type_reason: "按原文判断。",
        inspection_data_type_span_ids: [spanId, retainedSpanId],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(targetId, "dimension"),
        inspection_data_type_evidence_ids: [evidenceId, retainedEvidenceId],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = { spans: [
      { span_id: spanId, evidence_id: evidenceId, atom_id: evidenceId,
        start: 0, end: 8, text_sha256: "hash" },
      { span_id: retainedSpanId, evidence_id: retainedEvidenceId, atom_id: retainedEvidenceId,
        start: 0, end: 8, text_sha256: "retained-hash" },
    ] } as unknown as SourceSpanRegistry;
    const strictIssue = {
      code: "inspection_data_type_evidence_relation",
      path: "/acceptance_items/0/inspection_data_type_evidence_ids",
      message: "inspection type evidence belongs to another item",
      details: { required_action: "use item-local inspection evidence", actual: [evidenceId] },
    };
    expect(classifyStrictSelectorIssues(selectors, compiled, registry, [strictIssue])).toEqual([
      expect.objectContaining({
        owner: "selector_input_error",
        path: "/items/0/inspection_data_type_span_ids/0",
        details: expect.objectContaining({
          compiled_path: strictIssue.path,
          required_action: "select_only_exact_evidence_that_supports_this_item_inspection_data_type",
          actual: {
            item_key: "dimension",
            inspection_data_type: "measurement",
            invalid_evidence_ids: [evidenceId],
            current_span_id: spanId,
            current_evidence_id: evidenceId,
          },
          writable_paths: [
            "/items/0/inspection_data_type",
            "/items/0/inspection_data_type_reason",
            "/items/0/inspection_data_type_span_ids",
          ],
          candidate_read_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span"],
          next_tool: "read_target_selectors",
          next_tools: ["read_target_selectors", "open_evidence", "locate_evidence_span", "stage_target_selector_draft"],
          save_tool: "stage_target_selector_draft",
          how_to_pass: expect.stringContaining("不得仅为消错更改业务类型"),
        }),
      }),
    ]);

    const drifted = structuredClone(compiled);
    drifted.acceptance_items[0]!.inspection_data_type_evidence_ids = ["evidence:compiler-drift"];
    expect(classifyStrictSelectorIssues(selectors, drifted, registry, [strictIssue])[0]?.owner)
      .toBe("final_contract_violation");
  });

  it("routes the full empty-lot strict failure cluster back to the authored lot", () => {
    const selectors = {
      target_id: "target:empty-lot-owner",
      lots: [{ key: "empty-curtain-lot" }],
      items: [],
    } as unknown as TargetSelectorPlan;
    const evidenceId = "evidence:empty-lot-title";
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      inspection_lots: [{
        lot_id: semanticLotIdForSelectorKey(selectors.target_id, "empty-curtain-lot"),
        evidence_ids: [evidenceId],
        item_ids: [],
      }],
      acceptance_items: [],
      evidence_dispositions: [{
        evidence_id: evidenceId,
        disposition: "used",
        item_ids: [],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const issues = [
      { code: "agent_empty_lot", path: "/inspection_lots/0/item_ids", message: "empty lot" },
      { code: "used_evidence_without_item", path: "/evidence_dispositions/0/item_ids", message: "used evidence has no receiver" },
    ];

    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      issues,
    )).toEqual(issues.map((entry) => expect.objectContaining({
      code: entry.code,
      owner: "selector_input_error",
      path: "/lots/0",
      details: expect.objectContaining({
        compiled_path: entry.path,
        lot_key: "empty-curtain-lot",
        required_action: "add_at_least_one_acceptance_item_to_this_lot_or_remove_the_unsupported_lot",
      }),
    })));
  });

  it("keeps repairable agent inventory issues nonterminal but preserves the package boundary", () => {
    const selectors = {
      target_id: "target:inventory-owner",
      lots: [],
      items: [],
      source_dispositions: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      inspection_lots: [],
      acceptance_items: [],
      evidence_dispositions: [],
    } as unknown as PersistedSemanticSourcePlan;
    const repairable = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [
        issue("agent_target_zero_lots"),
        issue("agent_target_zero_items"),
        { ...issue("agent_primary_atom_unhandled"), details: { evidence_id: "evidence:unhandled" } },
      ],
    );

    expect(repairable).toEqual([
      expect.objectContaining({ owner: "selector_input_error", path: "/lots" }),
      expect.objectContaining({ owner: "selector_input_error", path: "/items" }),
      expect.objectContaining({ owner: "selector_input_error", path: "/source_dispositions" }),
    ]);
    expect(classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [issue("agent_target_without_primary_atoms")],
    )[0]?.owner).toBe("final_contract_violation");
  });

  it("routes unhandled evidence onto source_dispositions like primary-atom inventory", () => {
    const spanId = `span:${"d".repeat(32)}`;
    const evidenceId = "evidence:unhandled";
    const selectors = {
      target_id: "target:unhandled-owner",
      lots: [],
      items: [],
      source_dispositions: [],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      inspection_lots: [],
      acceptance_items: [],
      evidence_dispositions: [],
    } as unknown as PersistedSemanticSourcePlan;
    const registry = {
      spans: [{ span_id: spanId, evidence_id: evidenceId, atom_id: evidenceId, start: 0, end: 12, text_sha256: "hash" }],
    } as unknown as SourceSpanRegistry;
    const mapped = classifyStrictSelectorIssues(
      selectors,
      compiled,
      registry,
      [{
        code: "unhandled_evidence",
        path: "/evidence_dispositions",
        message: "Every evidence atom marked requires_disposition must be explicitly handled",
        details: {
          required_action: "Bind each listed evidence id to an item, or stage an explicit source_disposition",
          evidence_ids: [evidenceId],
        },
      }],
    );

    expect(mapped).toEqual([expect.objectContaining({
      code: "unhandled_evidence",
      owner: "selector_input_error",
      path: "/source_dispositions",
      details: expect.objectContaining({
        compiled_path: "/evidence_dispositions",
        evidence_ids: [evidenceId],
        candidate_span_ids: [spanId],
        writable_collection: "source_dispositions",
        required_action: "bind_semantically_or_stage_an_explicit_source_disposition",
        next_tool: "list_evidence_resources",
      }),
    })]);
    expect(decideStrictSelectorPreflight(mapped)).toMatchObject({
      selectorOwned: true,
      issueOwner: "selector_input_error",
    });

    const withDisposition = {
      ...selectors,
      source_dispositions: [{ span_ids: [spanId], disposition: "context", reason: "标题上下文" }],
    } as unknown as TargetSelectorPlan;
    const [compilerUnhandled] = classifyStrictSelectorIssues(
      withDisposition,
      compiled,
      registry,
      [{
        code: "compiler_unhandled_evidence",
        path: "/evidence_dispositions",
        message: "Compiler must materialize every required source disposition",
        details: { evidence_ids: [evidenceId] },
      }],
    );
    expect(compilerUnhandled).toEqual(expect.objectContaining({
      message: "编译器未能物化所有必须处理的来源；请依据原文补齐真实业务绑定或显式来源处置。",
      owner: "selector_input_error",
      path: "/source_dispositions/0",
      details: expect.objectContaining({
        compiled_path: "/evidence_dispositions",
        candidate_span_ids: [spanId],
        actual: {
          evidence_ids: [evidenceId],
          reference_anchor_bindings: [],
          candidate_spans: [{
            span_id: spanId,
            evidence_id: evidenceId,
            atom_id: evidenceId,
            start: 0,
            end: 12,
          }],
        },
        writable_paths: ["/items", "/sampling_rules", "/references", "/lots", "/source_dispositions"],
        writable_collections: ["items", "sampling_rules", "references", "lots", "source_dispositions"],
        allowed_actions: [
          expect.stringContaining("真实业务内容"),
          expect.stringContaining("lots[].scope_span_ids"),
          expect.stringContaining("非业务上下文"),
        ],
        source_disposition_schema: {
          required: ["span_ids", "disposition", "reason"],
          span_ids: expect.any(String),
          disposition: ["context", "ignored"],
          reason: expect.any(String),
          additional_properties: false,
        },
        repair_identity: {
          kind: "evidence_id",
          evidence_ids: [evidenceId],
        },
        post_save_verification: expect.objectContaining({
          tool: "advance_target_selector_stage",
          same_identity_meaning: expect.stringContaining("仍未形成有效的来源处置"),
          required_action: expect.stringContaining("actual.evidence_ids 与 actual.candidate_spans"),
        }),
        candidate_read_tools: ["list_evidence_resources", "read_target_selectors", "locate_evidence_span"],
        next_tool: "list_evidence_resources",
        next_tool_arguments: { cursor: 0, limit: 100 },
        next_tools: ["list_evidence_resources", "read_target_selectors", "locate_evidence_span", "stage_target_selector_draft"],
        tool_argument_hints: expect.objectContaining({
          list_evidence_resources: { cursor: 0, limit: 100 },
        }),
        save_tool: "stage_target_selector_draft",
        how_to_pass: expect.stringContaining("由模型仅依据原文选择与来源含义一致的合法路径"),
        writable_collection: "source_dispositions",
      }),
    }));
    expect((compilerUnhandled!.details as any).how_to_pass).toContain("draft.source_dispositions");
    expect((compilerUnhandled!.details as any).how_to_pass).toContain("不替模型决定");
    expect((compilerUnhandled!.details as any).how_to_pass).toContain("同一 evidence_id 再次出现");
    expect((compilerUnhandled!.details as any).how_to_pass).toContain("不要逐条保存后逐条重检");
    expect((compilerUnhandled!.details as any).post_save_verification.required_action).toContain("完成已知修复后");
    expect((compilerUnhandled!.details as any).do_not_edit).toContain("未列入 actual.evidence_ids 的其他来源");
    expect((compilerUnhandled!.details as any).tool_argument_hints).not.toHaveProperty("stage_target_selector_draft");
    expect((compilerUnhandled!.details as any).tool_argument_hints).not.toHaveProperty("locate_evidence_span");
    expect((compilerUnhandled!.details as any).save_tool_instruction).toContain("draft.source_dispositions");
  });

  it.each([
    "reference_placeholder_item_coverage_missing",
    "reference_placeholder_table_leaf_missing",
  ])("routes %s through neutral reads and all source-grounded receiver collections", (code) => {
    const selectors = {
      target_id: "target:placeholder-coverage",
      items: [{ key: "saline-soil" }],
      references: [{
        key: "reference-see-section",
        occurrence_id: "reference:see-4.2",
        application_mode: "reference_placeholder",
        destinations: [],
      }],
    } as unknown as TargetSelectorPlan;
    const compiled = {
      schema_version: "semantic-source-plan/v8",
      source_spans: [],
      acceptance_items: [{
        item_id: semanticItemIdForSelectorKey(selectors.target_id, "saline-soil"),
        evidence_ids: [],
      }],
      reference_resolutions: [{
        occurrence_id: "reference:see-4.2",
        application_mode: "reference_placeholder",
        target_evidence_ids: ["evidence:clause-4.2"],
        destination_bindings: [],
      }],
    } as unknown as PersistedSemanticSourcePlan;
    const strictIssue = {
      code,
      path: "/reference_resolutions/0/target_evidence_ids",
      message: "章节或条款纯引用占位要求全部选定的被引内容已经由其他真实验收叶物化。",
      details: { uncovered_evidence_ids: ["evidence:clause-4.2"] },
    };

    expect(classifySelectorIssue("strict-validator", strictIssue).owner)
      .toBe("selector_input_error");
    const mapped = classifyStrictSelectorIssues(
      selectors,
      compiled,
      { spans: [] } as unknown as SourceSpanRegistry,
      [strictIssue],
    );
    expect(mapped).toEqual([expect.objectContaining({
      owner: "selector_input_error",
      path: "/references/0/application_mode",
      details: expect.objectContaining({
        compiled_path: strictIssue.path,
        occurrence_id: "reference:see-4.2",
        writable_collection: "references",
        required_action: "account_for_uncovered_referenced_content_from_actual_source",
        actual: {
          reference_key: "reference-see-section",
          occurrence_id: "reference:see-4.2",
          application_mode: "reference_placeholder",
        },
        writable_collections: ["references", "items", "sampling_rules", "lots", "source_dispositions"],
        writable_paths: [
          "/references/0/application_mode",
          "/references/0/destinations",
          "/references/0/component_dispositions",
          "/references/0/import_scope",
          "/items",
          "/sampling_rules",
          "/lots",
          "/source_dispositions",
        ],
        candidate_read_tool: "read_target_selectors",
        candidate_read_tools: [
          "read_target_selectors",
          "list_reference_occurrences",
          "read_reference_facts",
          "read_document_reference_evidence",
        ],
        next_tool: "read_target_selectors",
        next_tool_arguments: { collection: "references", key: "reference-see-section" },
        next_tools: [
          "read_target_selectors",
          "list_reference_occurrences",
          "read_reference_facts",
          "read_document_reference_evidence",
          "stage_target_selector_draft",
        ],
        save_tool: "stage_target_selector_draft",
        allowed_actions: expect.arrayContaining([
          expect.stringContaining("保留 reference_placeholder"),
          expect.stringContaining("若原文关系并非纯占位"),
        ]),
        how_to_pass: expect.stringContaining("由模型依据原文"),
      }),
    })]);
    const details = mapped[0]!.details as Record<string, unknown>;
    expect(details.uncovered_evidence_ids).toEqual(["evidence:clause-4.2"]);
    expect(details.how_to_pass).toContain("collection=items");
    expect(details.how_to_pass).toContain("collection=sampling_rules");
    expect(details.how_to_pass).toContain("collection=lots");
    expect(details.how_to_pass).toContain("collection=source_dispositions");
    expect(details.how_to_pass).toContain("先只传 target_key 调用 read_reference_facts");
    expect(details.how_to_pass).not.toContain("saline-soil");
    expect(decideStrictSelectorPreflight(mapped)).toMatchObject({
      selectorOwned: true,
      issueOwner: "selector_input_error",
    });
  });

  it("blocks one reported language correction, then records an internal marker without changing the name", () => {
    const selectors = {
      items: [{ key: "weld-undercut", name: "Weld undercut depth" }],
    } as unknown as TargetSelectorPlan;
    const issues = [{
      code: "selector_source_language_mismatch",
      path: "/items/0/name",
      message: "use Chinese",
    }];
    const first = applyRepeatedSourceLanguageNamePolicy(
      selectors,
      issues,
      {},
      "fingerprint-a",
    );
    expect(first.markers).toEqual([]);
    expect(first.correction_attempts).toEqual({
      "/items/0/name": "fingerprint-a",
    });
    expect(first.selectors.items[0]!.name).toBe("Weld undercut depth");

    const unchanged = applyRepeatedSourceLanguageNamePolicy(
      selectors,
      issues,
      first.correction_attempts,
      "fingerprint-a",
    );
    expect(unchanged.markers).toEqual([]);

    const repeated = applyRepeatedSourceLanguageNamePolicy(
      selectors,
      issues,
      first.correction_attempts,
      "fingerprint-b",
    );
    expect(repeated.selectors.items[0]!.name).toBe("Weld undercut depth");
    expect(repeated.markers).toEqual([{
      path: "/items/0/name",
      item_key: "weld-undercut",
      original_name: "Weld undercut depth",
      marked_name: "Weld undercut depth",
    }]);
  });

  it("blocks one reported verdict-name correction, then records an internal marker without changing the name", () => {
    const selectors = {
      items: [{ key: "guide-rail-position", name: "导轨安装位置必须符合土建布置图要求。" }],
    } as unknown as TargetSelectorPlan;
    const issues = [{
      code: "selector_name_verdict_sentence",
      path: "/items/0/name",
      message: "verdict sentence copied as the item name",
      details: { signals: ["sentence_punctuation"] },
    }];
    const first = applyRepeatedVerdictNamePolicy(
      selectors,
      issues,
      {},
      "fingerprint-a",
    );
    expect(first.markers).toEqual([]);
    expect(first.correction_attempts).toEqual({
      "/items/0/name": "fingerprint-a",
    });
    expect(first.selectors.items[0]!.name).toBe("导轨安装位置必须符合土建布置图要求。");

    const unchanged = applyRepeatedVerdictNamePolicy(
      selectors,
      issues,
      first.correction_attempts,
      "fingerprint-a",
    );
    expect(unchanged.markers).toEqual([]);

    const repeated = applyRepeatedVerdictNamePolicy(
      selectors,
      issues,
      first.correction_attempts,
      "fingerprint-b",
    );
    expect(repeated.selectors.items[0]!.name).toBe("导轨安装位置必须符合土建布置图要求。");
    expect(repeated.markers).toEqual([{
      path: "/items/0/name",
      item_key: "guide-rail-position",
      original_name: "导轨安装位置必须符合土建布置图要求。",
      marked_name: "导轨安装位置必须符合土建布置图要求。",
      signals: ["sentence_punctuation"],
    }]);
  });

  it("never writes the review prefix into a source-backed conditional business name", () => {
    const name = "构件垂直度（柱、墙板安装后高度≤6m）";
    const selectors = {
      items: [{ key: "column-wall-verticality-le6", name }],
    } as unknown as TargetSelectorPlan;
    const issues = [{
      code: "selector_name_verdict_sentence",
      path: "/items/0/name",
      message: "review a possible acceptance limit",
      details: { signals: ["acceptance_limit"] },
    }];
    const first = applyRepeatedVerdictNamePolicy(selectors, issues, {}, "fingerprint-a");
    const repeated = applyRepeatedVerdictNamePolicy(
      selectors,
      issues,
      first.correction_attempts,
      "fingerprint-b",
    );

    expect(repeated.selectors.items[0]!.name).toBe(name);
    expect(repeated.markers).toEqual([expect.objectContaining({
      item_key: "column-wall-verticality-le6",
      original_name: name,
      marked_name: name,
      signals: ["acceptance_limit"],
    })]);
  });

  it("does not consume a correction for an unreported issue page", () => {
    const selectors = {
      items: Array.from({ length: 9 }, (_, index) => ({ name: `English name ${index}` })),
    } as unknown as TargetSelectorPlan;
    const issues = selectors.items.map((_, index) => ({
      code: "selector_source_language_mismatch",
      path: `/items/${index}/name`,
      message: "use Chinese",
    }));
    const policy = applyRepeatedSourceLanguageNamePolicy(
      selectors,
      issues,
      {},
      "fingerprint-a",
      8,
    );
    expect(Object.keys(policy.correction_attempts)).toHaveLength(8);
    expect(policy.correction_attempts["/items/8/name"]).toBeUndefined();
  });
});
