import { describe, expect, test } from "vitest";
import {
  applyCoverageReferenceRebindings,
  coverageReferenceRepairOptions,
  isCoverageReferenceRebinding,
} from "../src/coverage-reference-repair.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";

type Item = TargetSelectorPlan["items"][number];

function fixture() {
  const registry: SourceSpanRegistry = {
    schema_version: "source-span-registry/v1", source_fingerprint: "source",
    spans: [
      ["origin", "clause", 0, 40], ["literal", "clause", 20, 27],
      ["whole-clause", "clause", 0, 100], ["other-condition", "clause", 40, 60],
      ["value", "row", 0, 5], ["changed-value", "row", 6, 10],
    ].map(([id, evidence, start, end]) => ({
      span_id: String(id), evidence_id: String(evidence), atom_id: String(evidence),
      start: Number(start), end: Number(end), text_sha256: String(id),
    })),
  };
  const field = (ids: string[]): Item["fields"]["requirement"] => ({
    composition: "verbatim", span_ids: ids, separator: "", reason: "source",
  });
  const owner: Item = {
    key: "generic", lot_key: "lot", name: "表格总项", category: "一般项目",
    criterion_span_ids: ["origin"], continuation_span_ids: [],
    fields: { name: field(["origin"]), requirement: field(["origin", "whole-clause"]),
      method: field([]), quantity: field([]), note: field([]) },
    table: null, inspection_data_type: "measurement", inspection_data_type_reason: "measure",
    inspection_data_type_span_ids: ["origin"],
    sampling: { status: "not_sampling", rule_key: "", branch_keys: [], quantity_span_ids: [],
      script_span_ids: [], condition_span_ids: [], reason: "none", confidence: 1 },
    reason: "source",
  };
  const receiver: Item = { ...structuredClone(owner), key: "dimension", name: "尺寸偏差",
    criterion_span_ids: ["value"], fields: { ...structuredClone(owner.fields),
      name: field(["value", "literal"]), requirement: field(["value"]) } };
  const source = {
    schema_version: "target-selector-plan/v6", lots: [{ key: "lot", name: "检验批", scope_span_ids: [], reason: "scope" }],
    items: [owner, receiver], sampling_rules: [], source_dispositions: [],
    references: [{ key: "table-ref", occurrence_id: "occurrence:1", action: "adopt", application_mode: "reference_only",
      anchor_span_ids: ["literal"], target_span_ids: ["value"],
      destinations: [{ item_key: owner.key, target_field: "requirement" }], reason: "table provenance" }],
  } as TargetSelectorPlan;
  const repaired = structuredClone(source);
  repaired.items = [structuredClone(receiver)];
  repaired.items[0]!.fields.requirement.span_ids.push("origin");
  repaired.items[0]!.fields.requirement.separator = " ";
  repaired.references[0]!.destinations = [{ item_key: receiver.key, target_field: "requirement" }];
  const options = () => coverageReferenceRepairOptions(source, new Set([owner.key]), registry);
  const allowed = () => isCoverageReferenceRebinding(receiver, repaired.items[0], source, repaired, options(), registry);
  return { registry, source, repaired, owner, receiver, options, allowed };
}

describe("bounded coverage reference rebinding", () => {
  test("offers only pre-existing receivers and the narrowest authored citation context", () => {
    const f = fixture();
    expect(f.options()).toEqual([{
      reference_key: "table-ref", occurrence_id: "occurrence:1", source_item_key: "generic",
      target_field: "requirement", eligible_receiver_keys: ["dimension"],
      allowed_origin_span_ids: ["origin"],
    }]);
    expect(f.allowed()).toBe(true);
  });

  test("applies the mechanical citation move after the model chooses an eligible receiver", () => {
    const f = fixture();
    const chosen = structuredClone(f.source);
    chosen.items = [structuredClone(f.receiver)];
    chosen.references[0]!.destinations = [{ item_key: f.receiver.key, target_field: "requirement" }];

    const applied = applyCoverageReferenceRebindings(f.source, chosen, f.options());

    expect(applied.receiver_item_keys).toEqual([f.receiver.key]);
    expect(applied.selectors.items[0]!.fields.requirement.span_ids).toEqual(["value", "origin"]);
    expect(isCoverageReferenceRebinding(
      f.receiver,
      applied.selectors.items[0],
      f.source,
      applied.selectors,
      f.options(),
      f.registry,
    )).toBe(true);
  });

  test("does not overwrite a receiver that the model changed semantically", () => {
    const f = fixture();
    const chosen = structuredClone(f.source);
    chosen.items = [structuredClone(f.receiver)];
    chosen.items[0]!.name = "模型改写的项目";
    chosen.references[0]!.destinations = [{ item_key: f.receiver.key, target_field: "requirement" }];

    const applied = applyCoverageReferenceRebindings(f.source, chosen, f.options());

    expect(applied.receiver_item_keys).toEqual([]);
    expect(applied.selectors).toEqual(chosen);
  });

  test.each([
    ["changed existing value", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids[0] = "changed-value"; }],
    ["removed existing value", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids = ["origin"]; }],
    ["changed name", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.name = "另一项目"; }],
    ["changed category", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.category = "主控项目"; }],
    ["changed method", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.method.span_ids = ["origin"]; }],
    ["changed sampling", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.sampling.confidence = 0; }],
    ["changed criterion", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.criterion_span_ids = ["origin"]; }],
    ["unrelated source condition", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids.push("other-condition"); }],
    ["whole resource instead of narrow context", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids.push("whole-clause"); }],
    ["unknown span", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids.push("invented"); }],
    ["duplicated old span", (f: ReturnType<typeof fixture>) => { f.repaired.items[0]!.fields.requirement.span_ids.push("value"); }],
    ["changed occurrence", (f: ReturnType<typeof fixture>) => { f.repaired.references[0]!.occurrence_id = "other"; }],
    ["changed reference target", (f: ReturnType<typeof fixture>) => { f.repaired.references[0]!.target_span_ids = ["changed-value"]; }],
    ["field replacement mode", (f: ReturnType<typeof fixture>) => {
      (f.repaired.references[0] as { application_mode: string }).application_mode = "replace_field";
    }],
    ["moved citation to a different field", (f: ReturnType<typeof fixture>) => { f.repaired.references[0]!.destinations[0]!.target_field = "note"; }],
    ["affected owner still exists", (f: ReturnType<typeof fixture>) => { f.repaired.items.push(f.owner); }],
    ["receiver had no prior citation relationship", (f: ReturnType<typeof fixture>) => {
      f.receiver.fields.name.span_ids = ["value"];
      f.repaired.items[0]!.fields.name.span_ids = ["value"];
    }],
    ["broad shared source is not a citation relationship", (f: ReturnType<typeof fixture>) => {
      f.receiver.fields.name.span_ids = ["whole-clause"];
      f.repaired.items[0]!.fields.name.span_ids = ["whole-clause"];
    }],
  ])("rejects collateral edits: %s", (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(f.allowed()).toBe(false);
  });

  test("does not manufacture a repair allowance for a reference outside the affected items", () => {
    const f = fixture();
    expect(coverageReferenceRepairOptions(f.source, new Set(["unrelated"]), f.registry)).toEqual([]);
  });

  test("does not authorize broad extra anchors as transferable citation context", () => {
    const f = fixture();
    f.source.references[0]!.anchor_span_ids.push("whole-clause");
    f.repaired.references[0]!.anchor_span_ids.push("whole-clause");
    expect(f.options()).toEqual([]);
    expect(f.allowed()).toBe(false);
  });

  test("preserves a split citation prefix without importing the following independent condition", () => {
    const f = fixture();
    f.registry.spans.push({ span_id: "prefix", evidence_id: "clause", atom_id: "clause",
      start: 6, end: 20, text_sha256: "prefix" });
    f.owner.fields.requirement.span_ids = ["prefix", "literal", "other-condition"];
    f.repaired.items[0]!.fields.requirement.span_ids = ["value", "prefix", "literal"];
    expect(f.options()[0]!.allowed_origin_span_ids).toEqual(["prefix", "literal"]);
    expect(f.allowed()).toBe(true);
    f.repaired.items[0]!.fields.requirement.span_ids.push("other-condition");
    expect(f.allowed()).toBe(false);
  });

  test("preserves existing destinations when relocating a removed owner", () => {
    const f = fixture();
    f.source.references[0]!.destinations.push({ item_key: f.receiver.key, target_field: "note" });
    expect(f.allowed()).toBe(false);
    f.repaired.references[0]!.destinations.push({ item_key: f.receiver.key, target_field: "note" });
    expect(f.allowed()).toBe(true);
  });
});
