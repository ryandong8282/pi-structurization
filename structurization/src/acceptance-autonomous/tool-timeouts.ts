/** These operations already own durable progress, bounded parser/reviewer work and job cancellation. */
export const ACCEPTANCE_TOOL_TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  // A local original may need MinerU preparation. Its parser limits and job abort remain authoritative.
  resolve_acceptance_reference: Number.POSITIVE_INFINITY,
  parallel_acceptance_extract: Number.POSITIVE_INFINITY,
  extract_acceptance_lot_batch: Number.POSITIVE_INFINITY,
  sweep_acceptance_tables: Number.POSITIVE_INFINITY,
  experiment_acceptance_table_method: Number.POSITIVE_INFINITY,
  review_acceptance_groups: Number.POSITIVE_INFINITY,
  review_acceptance_group: Number.POSITIVE_INFINITY,
  investigate_acceptance_exception: Number.POSITIVE_INFINITY,
  seal_acceptance_delivery: Number.POSITIVE_INFINITY,
  seal_acceptance_group: Number.POSITIVE_INFINITY,
});
