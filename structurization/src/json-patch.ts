export interface JsonPatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("JSON pointer must be empty or start with /");
  const segments = path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw new Error("Unsafe JSON pointer segment");
  }
  return segments;
}

export function applyJsonPatchOperation(document: unknown, operation: JsonPatchOperation): unknown {
  const segments = decodePointer(operation.path);
  if (segments.length === 0) {
    if (operation.op === "remove") throw new Error("The document root cannot be removed");
    return structuredClone(operation.value);
  }
  const result = structuredClone(document);
  let parent: unknown = result;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
        throw new Error(`Invalid array path segment ${segment} (array length ${parent.length}); 数组索引在 remove/add 后会漂移，请重新 read_document_selectors 后再按当前索引或稳定 key 定位。path=${operation.path}`);
      }
      parent = parent[index];
    } else if (parent !== null && typeof parent === "object") {
      if (!Object.hasOwn(parent, segment)) {
        throw new Error(`JSON pointer does not exist: ${operation.path} (当前层可用字段: ${Object.keys(parent).slice(0, 24).join(", ")})`);
      }
      parent = (parent as Record<string, unknown>)[segment];
    } else {
      throw new Error(`JSON pointer traverses a scalar: ${operation.path}`);
    }
  }
  const leaf = segments.at(-1)!;
  if (Array.isArray(parent)) {
    if (operation.op === "add") {
      if (leaf === "-") parent.push(structuredClone(operation.value));
      else {
        const index = Number(leaf);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) {
          throw new Error(`Invalid array insertion index ${leaf} (array length ${parent.length}); 追加请用 "-" 作为索引。path=${operation.path}`);
        }
        parent.splice(index, 0, structuredClone(operation.value));
      }
    } else {
      const index = Number(leaf);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
        throw new Error(`Invalid array index ${leaf} (array length ${parent.length}); 数组索引在 remove/add 后会漂移，请重新 read_document_selectors 后再按当前索引或稳定 key 定位。path=${operation.path}`);
      }
      if (operation.op === "replace") parent[index] = structuredClone(operation.value);
      else parent.splice(index, 1);
    }
  } else if (parent !== null && typeof parent === "object") {
    const object = parent as Record<string, unknown>;
    if (operation.op !== "add" && !Object.hasOwn(object, leaf)) {
      throw new Error(`JSON pointer does not exist: ${operation.path} (当前层可用字段: ${Object.keys(object).slice(0, 24).join(", ")})`);
    }
    if (operation.op === "remove") delete object[leaf];
    else object[leaf] = structuredClone(operation.value);
  } else {
    throw new Error(`JSON pointer parent is a scalar: ${operation.path}`);
  }
  return result;
}

export function applyJsonPatch(document: unknown, operations: JsonPatchOperation[]): unknown {
  return operations.reduce(
    (current, operation) => applyJsonPatchOperation(current, operation),
    document,
  );
}
