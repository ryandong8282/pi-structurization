import { applyJsonPatch, type JsonPatchOperation } from "./json-patch.js";

export const HIERARCHY_RECORD_KEYS = {
  nodes: "node_id", lot_bindings: "lot_key", inspection_units: "unit_id",
  semantic_constraints: "constraint_id", atom_dispositions: "atom_id",
} as const;

type Collection = keyof typeof HIERARCHY_RECORD_KEYS;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hierarchyRecordCatalog(plan: unknown): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(HIERARCHY_RECORD_KEYS).map(([collection, keyField]) => [
    collection, record(plan) && Array.isArray(plan[collection]) ? plan[collection].map((entry, index) => ({
      collection, key: record(entry) ? entry[keyField] : undefined,
      path: `/${collection}/${index}`,
      ...(record(entry) ? { name: entry.name ?? entry.display_name, parent_node_id: entry.parent_node_id } : {}),
    })) : [],
  ]));
}

/** Resolve every edit against the current transaction, never against a guessed array offset. */
export function hierarchyRecordEditOperations(plan: unknown, edits: unknown): JsonPatchOperation[] {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 40) throw new Error("edits must contain 1–40 keyed record edits");
  let current = structuredClone(plan);
  const operations: JsonPatchOperation[] = [];
  for (const [editIndex, edit] of edits.entries()) {
    if (!record(edit) || typeof edit.collection !== "string" || !Object.hasOwn(HIERARCHY_RECORD_KEYS, edit.collection)
      || typeof edit.key !== "string" || !edit.key.trim()
      || !["update", "upsert", "remove"].includes(String(edit.op))) {
      throw new Error(`edits/${editIndex}: require collection=nodes|lot_bindings|semantic_constraints|atom_dispositions|inspection_units, stable key, and op=update|upsert|remove`);
    }
    const collection = edit.collection as Collection, keyField = HIERARCHY_RECORD_KEYS[collection];
    const rows = record(current) ? current[collection] : undefined;
    if (!Array.isArray(rows)) throw new Error(`/${collection} is not an array; read_hierarchy_plan before editing`);
    const matches = rows.flatMap((row, index) => record(row) && row[keyField] === edit.key ? [index] : []);
    if (matches.length > 1) throw new Error(`/${collection}: duplicate ${keyField}=${edit.key}; keyed editing cannot choose between duplicate identities`);
    const index = matches[0];
    if (index === undefined && edit.op !== "upsert") throw new Error(`/${collection}: ${keyField}=${edit.key} does not exist; read_hierarchy_plan for current keys, or use upsert only for an intended new record`);
    if (edit.op !== "remove" && !record(edit.value)) throw new Error(`edits/${editIndex}/value must be an object; update supplies changed fields, upsert supplies the complete record`);
    if (record(edit.value) && Object.hasOwn(edit.value, keyField) && edit.value[keyField] !== edit.key) {
      throw new Error(`edits/${editIndex}/value/${keyField} cannot change identity; preserve ${edit.key}`);
    }
    const operation: JsonPatchOperation = edit.op === "remove"
      ? { op: "remove", path: `/${collection}/${index}` }
      : { op: index === undefined ? "add" : "replace", path: `/${collection}/${index ?? "-"}`,
        value: { ...(edit.op === "update" ? rows[index!] as Record<string, unknown> : {}), ...edit.value as Record<string, unknown>, [keyField]: edit.key } };
    current = applyJsonPatch(current, [operation]);
    operations.push(operation);
  }
  return operations;
}

export function hierarchyIssueRepairContext(plan: unknown, path: string): Record<string, unknown> {
  const [, collection, rowIndex, ...fields] = path.split("/");
  if (!collection || !Object.hasOwn(HIERARCHY_RECORD_KEYS, collection) || !record(plan)) return {};
  const rows = plan[collection], entry = Array.isArray(rows) ? rows[Number(rowIndex)] : undefined;
  if (!record(entry)) return { collection, candidate_read_tool: "read_hierarchy_plan" };
  let actual: unknown = entry;
  for (const field of fields) actual = actual !== null && typeof actual === "object" ? (actual as Record<string, unknown>)[field] : undefined;
  const fragmentIndex = fields.indexOf("evidence_fragments");
  const fragment = fragmentIndex >= 0 && Array.isArray(entry.evidence_fragments)
    ? entry.evidence_fragments[Number(fields[fragmentIndex + 1])] : undefined;
  return {
    collection, key: entry[HIERARCHY_RECORD_KEYS[collection as Collection]],
    name: entry.name ?? entry.display_name, parent_node_id: entry.parent_node_id,
    writable_field: fields.join("/"), actual,
    next_tool: "edit_hierarchy_records", candidate_read_tool: "read_hierarchy_plan",
    ...(record(fragment) ? { actual_fragment: fragment, source_read_tool: "open_document_atom", source_read_arguments: { atom_id: fragment.atom_id } } : {}),
    instruction: "按稳定 key 读取并修改此记录；只提交需要改变的顶层字段。父子关系按名称、身份和原文语义判断，不按数组区间分组。证据必须复制指定 atom 的逐字原文；不要改不可变来源、封存检验批或业务抽取结果。修改后重新 validate_hierarchy_plan。",
  };
}
