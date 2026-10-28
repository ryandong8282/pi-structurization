/** Shared lexical contract; matching never decides business applicability. */
export const SOURCE_SEARCH_MODE = "space_separated_terms_any_ranked";

export function sourceSearchNavigation(query: string, scope: "registered_target_evidence" | "directly_readable_full_document", count: number) {
  const continueSearch = scope === "registered_target_evidence" && query.trim().length >= 2;
  return {
    query,
    search_scope: scope,
    search_mode: SOURCE_SEARCH_MODE,
    query_terms: [...new Set(query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean))],
    navigation_is_exhaustive: false,
    total_match_resources: count,
    unresolved: count === 0,
    ...(count === 0 ? {
      empty_result_meaning: "no_lexical_hit_in_this_scope_not_absence_of_applicable_rules",
      next_tool: continueSearch ? "search_global_document_resources" : "list_global_document_resources",
      next_tool_arguments: continueSearch ? { query: query.trim() } : { cursor: 0, limit: 20 },
    } : {}),
  };
}
