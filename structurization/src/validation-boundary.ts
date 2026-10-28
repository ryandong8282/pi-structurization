/** The author chooses business meaning; deterministic validation checks the declaration. */
export const STRUCTURAL_VALIDATION_BOUNDARY = "structure-and-references/v1" as const;
export type ValidationBoundary = typeof STRUCTURAL_VALIDATION_BOUNDARY;

// Explicitly reviewed heuristics, not a permissive prefix filter. Unknown errors
// remain blocking. Source IDs, offsets, required decisions and route consistency
// are deliberately absent from this list.
const MODEL_REVIEW_CODES = new Set([
  "selector_duplicate_item_payload",
  "selector_independent_items_merged",
  "selector_name_short_form_required",
  "selector_display_field_span_role_overlap",
  "selector_method_span_conflates_display_roles",
  "selector_display_field_span_role_conflict",
  "selector_scalar_span_crosses_typed_role_boundary",
  "selector_scalar_span_conflates_item_roles",
  "selector_scalar_span_crosses_item_boundaries",
  "selector_table_distinct_core_properties_merged",
  "selector_acceptance_branches_required",
  "selector_acceptance_branch_note_misuse",
  "selector_acceptance_branch_condition_duplicate",
  "selector_table_expansion_obligations_pending",
  "selector_table_block_required_for_table_origin_items",
  "selector_reference_placeholder_local_requirement",
  "selector_source_language_mismatch",
  "selector_name_verdict_sentence",
  "selector_table_identity_without_criterion",
  "selector_table_navigation_leaf_role_conflict",
  "selector_table_method_role_conflict",
  "selector_table_visible_field_role_conflation",
  "selector_table_row_path_role_mismatch",
  "selector_group_scope_used_as_continuation",
  "selector_full_inspection_sampling_required",
  "selector_sampling_unspecified_quantity_is_full_inspection",
  "selector_field_clause_line_mismatch",
  "selector_field_heading_evidence_forbidden",
  "selector_field_source_role_mismatch",
  "selector_ledger_required_clause_gap",
  "selector_source_clause_missing",
  "selector_source_clause_ambiguous",
  "selector_source_clause_unresolved",
  "table_acceptance_branch_note_misuse",
  "reference_target_not_data_row",
  "agent_primary_atom_not_used",
]);

export function isModelReviewIssue(issue: { code?: unknown }): boolean {
  return typeof issue.code === "string" && MODEL_REVIEW_CODES.has(issue.code);
}

export function partitionValidationIssues<T extends { code?: unknown }>(issues: readonly T[]): {
  errors: T[]; model_review: T[];
} {
  return {
    errors: issues.filter(issue => !isModelReviewIssue(issue)),
    model_review: issues.filter(isModelReviewIssue),
  };
}
