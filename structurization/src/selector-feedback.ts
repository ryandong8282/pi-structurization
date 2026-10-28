/** One current author-work route; diagnostic/source subroutes are supporting reads. */
export function selectorWorkNextStep(work: {
  record_read?: { tool: string; arguments: Record<string, unknown> };
  diagnostic_read?: { tool: string; arguments: Record<string, unknown> };
} | undefined) {
  const read = work?.record_read ?? work?.diagnostic_read;
  return read ? { next_tool: read.tool, next_tool_arguments: read.arguments } : {};
}

/** Submission bookkeeping only: no business inference and no draft mutation. */
export function selectorPatchReceipt(args: unknown, status: "not_applied" | "saved") {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const draft = input.draft && typeof input.draft === "object" ? input.draft as Record<string, unknown> : {};
  const collections = ["lots", "items", "sampling_rules", "references", "source_dispositions", "residual_source_dispositions"]
    .filter(collection => Array.isArray(draft[collection]))
    .map(collection => {
      const submitted_keys: string[] = [], unkeyed_record_paths: string[] = [];
      (draft[collection] as unknown[]).forEach((row, index) => {
        const key = row && typeof row === "object" ? (row as { key?: unknown }).key : undefined;
        if (typeof key === "string") submitted_keys.push(key);
        else unkeyed_record_paths.push(`/draft/${collection}/${index}`);
      });
      return { collection, submitted_keys, unkeyed_record_paths };
    });
  return {
    status,
    operation: input.operation ?? "upsert",
    collections,
    ...(Array.isArray(input.remove_keys) ? { remove_keys: input.remove_keys, remove_collection: input.collection } : {}),
  };
}
