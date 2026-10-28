import { describe, expect, test } from "vitest";
import { applyJsonPatch } from "../src/json-patch.js";
import { hierarchyRecordCatalog, hierarchyRecordEditOperations, hierarchyIssueRepairContext } from "../src/hierarchy-record-edits.js";

const plan = () => ({ nodes: [
  { node_id: "third", name: "末尾补充对象", parent_node_id: "correct-parent" },
  { node_id: "first", name: "前一对象", parent_node_id: "group" },
  { node_id: "second", name: "另一对象", parent_node_id: "group" },
], lot_bindings: [], semantic_constraints: [], atom_dispositions: [], inspection_units: [] });

describe("stable hierarchy record editing", () => {
  test("edits item membership by unit identity without replacing other units or sealed source facts", () => {
    const before = { ...plan(), inspection_units: [{ unit_id: 'unit-b', name: '乙', item_selections: [{ lot_key: 'shared', item_ids: ['item-b'] }] },
      { unit_id: 'unit-a', name: '甲', item_selections: [{ lot_key: 'shared', item_ids: ['item-a'] }] }] };
    const after = applyJsonPatch(before, hierarchyRecordEditOperations(before, [
      { collection: 'inspection_units', key: 'unit-a', op: 'update', value: { parent_node_id: 'division-a' } },
    ])) as typeof before;
    expect(after.inspection_units[0]).toEqual(before.inspection_units[0]);
    expect(after.inspection_units[1]).toMatchObject({ parent_node_id: 'division-a', item_selections: before.inspection_units[1]!.item_selections });
    expect(hierarchyRecordCatalog(after).inspection_units).toContainEqual(expect.objectContaining({ key: 'unit-a', path: '/inspection_units/1' }));
    expect(hierarchyIssueRepairContext(after, '/inspection_units/1/item_selections/0/item_ids')).toMatchObject({ key: 'unit-a', next_tool: 'edit_hierarchy_records', actual: ['item-a'] });
  });
  test("updates identities after earlier removals without inferring business grouping from order", () => {
    const before = plan(), snapshot = structuredClone(before);
    const ops = hierarchyRecordEditOperations(before, [
      { collection: "nodes", key: "first", op: "remove" },
      { collection: "nodes", key: "second", op: "update", value: { parent_node_id: "new-parent" } },
      { collection: "nodes", key: "added", op: "upsert", value: { name: "新对象" } },
    ]);
    const after = applyJsonPatch(before, ops) as ReturnType<typeof plan>;
    expect(after.nodes).toEqual([before.nodes[0], { ...before.nodes[2], parent_node_id: "new-parent" }, { node_id: "added", name: "新对象" }]);
    expect(before).toEqual(snapshot);
    expect(hierarchyRecordCatalog(after).nodes).toContainEqual(expect.objectContaining({ key: "second", path: "/nodes/1", name: "另一对象" }));
  });
  test.each([
    [{ collection: "nodes", key: "missing", op: "update", value: {} }],
    [{ collection: "nodes", key: "first", op: "update", value: { node_id: "second" } }],
    [{ collection: "__proto__", key: "x", op: "upsert", value: {} }],
    [{ collection: "nodes", key: "first", op: "remove" }, { collection: "nodes", key: "missing", op: "remove" }],
  ])("rejects invalid transactions without changing the plan: %j", (...edits) => {
    const before = plan(), snapshot = structuredClone(before);
    expect(() => hierarchyRecordEditOperations(before, edits)).toThrow();
    expect(before).toEqual(snapshot);
  });
  test("rejects ambiguous duplicate identities", () => {
    const before = plan(); before.nodes.push({ ...before.nodes[0]! });
    expect(() => hierarchyRecordEditOperations(before, [{ collection: "nodes", key: "third", op: "remove" }])).toThrow(/duplicate/);
  });
  test("attaches exact writable identity and source read arguments to fragment failures", () => {
    const before = { semantic_constraints: [{ constraint_id: "scope", evidence_fragments: [{ atom_id: "source", text: "not exact" }] }] };
    expect(hierarchyIssueRepairContext(before, "/semantic_constraints/0/evidence_fragments/0")).toMatchObject({
      collection: "semantic_constraints", key: "scope", actual_fragment: { atom_id: "source", text: "not exact" },
      source_read_tool: "open_document_atom", source_read_arguments: { atom_id: "source" }, next_tool: "edit_hierarchy_records",
    });
  });
  test("inspection units are keyed records: upsert by unit_id and list them in the catalog (GB 50210 实测回归)", () => {
    const before = plan();
    const unit = { unit_id: "unit-a", name: "共同验收单元", lot_keys: ["T-A::L-1"], source_title_fragments: [], evidence_fragments: [{ atom_id: "a", text: "原文" }], reason: "原文共同范围" };
    const ops = hierarchyRecordEditOperations(before, [{ collection: "inspection_units", key: "unit-a", op: "upsert", value: unit }]);
    const after = applyJsonPatch(structuredClone(before), ops);
    expect(after.inspection_units).toEqual([unit]);
    expect(hierarchyRecordCatalog(after).inspection_units).toContainEqual(expect.objectContaining({ key: "unit-a", path: "/inspection_units/0", name: "共同验收单元" }));
    const renamed = hierarchyRecordEditOperations(after, [{ collection: "inspection_units", key: "unit-a", op: "update", value: { name: "更名单元" } }]);
    const renamedPlan = applyJsonPatch(after, renamed);
    expect(renamedPlan.inspection_units[0]).toMatchObject({ unit_id: "unit-a", name: "更名单元" });
  });
});
