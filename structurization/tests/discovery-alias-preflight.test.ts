import { describe, expect, test } from "vitest";
import { assertDiscoveryAliasReferences, resolveDiscoveryAliases, type DiscoverySourceAlias } from "../src/discovery-source-bindings.js";
import { SourceSpanRegistryError } from "../src/source-span-registry.js";

const aliases = new Map<string, DiscoverySourceAlias>([
  ["known", { span_ids: ["span:a", "span:b"], anchor_span_id: "span:anchor" }],
]);

function issues(value: unknown, defined = aliases, prefix?: string) {
  try {
    assertDiscoveryAliasReferences(value, defined, prefix);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceSpanRegistryError);
    return (error as SourceSpanRegistryError).issues;
  }
  throw new Error("Expected missing aliases to be rejected");
}

describe("Discovery call-local alias preflight", () => {
  test("reports every unknown alias and its exact edit path in one rejection", () => {
    const result = issues([
      { value: { span_ids: ["$c632", "$known", "$c633"] } },
      { value: { source_blocks: [{ end_before_span_id: "$h710z" }] } },
    ]);
    expect(result.map(issue => [issue.path, (issue.details as { actual: string }).actual])).toEqual([
      ["/edits/0/value/span_ids/0", "$c632"],
      ["/edits/0/value/span_ids/2", "$c633"],
      ["/edits/1/value/source_blocks/0/end_before_span_id", "$h710z"],
    ]);
    expect(result.every(issue => issue.code === "discovery_binding_alias_unknown")).toBe(true);
    expect(result[0]!.details).toMatchObject({
      unknown_reference_count: 3, unknown_alias_count: 3,
      missing_alias_keys: ["c632", "c633", "h710z"], defined_keys: ["known"],
      reported_reference_count: 3, omitted_reference_count: 0,
      writable_collection: "source_bindings", next_tools: ["read_document_selectors", "edit_document_selectors"],
    });
    expect(result[0]!.message).toContain("same edit_document_selectors call");
    expect(result[0]!.message).toContain("current draft_id");
    expect(result[0]!.message).toContain("Aliases from earlier calls are not retained");
    expect(result[0]!.message).toContain("Do not guess bindings");
    expect(result[1]!.details).not.toHaveProperty("defined_keys");
  });

  test("accepts known aliases and canonical IDs without mutating or resolving input", () => {
    const value = [{ value: { span_ids: ["$known", "span:canonical"], anchor_span_id: "$known" } }];
    const before = structuredClone(value);
    const aliasesBefore = structuredClone(aliases);
    expect(() => assertDiscoveryAliasReferences(value, aliases)).not.toThrow();
    expect(value).toEqual(before);
    expect(aliases).toEqual(aliasesBefore);
  });

  test("ignores aliases in ordinary text or unrelated arrays but visits nested span fields", () => {
    const value = { reason: "$missing", name: "$missing", values: ["$missing"],
      nested: [{ reason: "$missing", acceptance_span_ids: ["$known"] }] };
    expect(() => assertDiscoveryAliasReferences(value, aliases)).not.toThrow();
    const result = issues({ nested: [{ reason: "$missing", atom_span_id: "$real" }] });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("/edits/nested/0/atom_span_id");
  });

  test("escapes JSON pointer segments and honors a supplied root prefix", () => {
    const result = issues({ "a/b~c": { anchor_span_id: "$missing" } }, aliases, "/actions");
    expect(result[0]!.path).toBe("/actions/a~1b~0c/anchor_span_id");
    expect(result[0]!.details).toMatchObject({ writable_path: "/actions/a~1b~0c/anchor_span_id" });
  });

  test("counts repeated references independently while counting unique aliases once", () => {
    const value = [{ span_ids: ["$same", "$same"] }, { start_span_id: "$same" }];
    const before = structuredClone(value);
    const result = issues(value);
    expect(result).toHaveLength(3);
    expect(result[0]!.details).toMatchObject({ unknown_reference_count: 3, unknown_alias_count: 1 });
    expect(value).toEqual(before);
  });

  test("bounds locations and key lists but reports total missing reference counts", () => {
    const manyAliases = new Map<string, DiscoverySourceAlias>(Array.from({ length: 101 }, (_, index) =>
      [`known${index}`, { span_ids: [`span:${index}`], anchor_span_id: `span:${index}` }]));
    const result = issues({ span_ids: Array.from({ length: 45 }, (_, index) => `$missing${index}`) }, manyAliases);
    expect(result).toHaveLength(40);
    expect(result[39]!.path).toBe("/edits/span_ids/39");
    expect(result[0]!.details).toMatchObject({
      unknown_reference_count: 45, unknown_alias_count: 45,
      reported_reference_count: 40, omitted_reference_count: 5,
      omitted_alias_count: 5, omitted_defined_key_count: 1,
    });
    const details = result[0]!.details as { missing_alias_keys: string[]; defined_keys: string[] };
    expect(details.missing_alias_keys).toHaveLength(40);
    expect(details.defined_keys).toHaveLength(100);
  });

  test("does not change the existing resolver's strict unknown-alias rejection", () => {
    expect(() => resolveDiscoveryAliases({ span_ids: ["$previous_call"] }, aliases)).toThrow(SourceSpanRegistryError);
    try {
      resolveDiscoveryAliases({ span_ids: ["$previous_call"] }, aliases);
    } catch (error) {
      expect(error).toMatchObject({ issues: [expect.objectContaining({ code: "discovery_binding_alias_unknown" })] });
    }
    expect(resolveDiscoveryAliases({ span_ids: ["$known"] }, aliases)).toEqual({ span_ids: ["span:a", "span:b"] });
  });
});
