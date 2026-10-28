import { selectorFieldDiagnostic } from "./selector-diagnostics.js";
import { selectorIssueProbes, type SelectorIssueProbe } from "./selector-blocker-progress.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

export interface SelectorRepairFocus {
  identity: string;
  code: string;
  path: string;
  record_read?: { tool: "read_target_selectors"; arguments: { collection: string; key: string } };
  diagnostic_cursor: number;
}

/** Scheduling only: prefer an addressable author record over a collection-wide
 * investigation, retain its stable identity until current diagnostics close it.
 * Nothing here chooses a business value or declares global validation passed. */
export function selectSelectorRepairFocus(issues: readonly unknown[], selectors: TargetSelectorPlan,
  previous?: SelectorRepairFocus, eligible: (issue: unknown) => boolean = () => true):
  { focus: SelectorRepairFocus; probe: SelectorIssueProbe; diagnostic: Record<string, any>; remaining_diagnostic_count: number } | undefined {
  const candidates = issues.flatMap((issue, diagnostic_cursor) => {
    if (!eligible(issue)) return [];
    const diagnostic = selectorFieldDiagnostic(issue);
    if (diagnostic.severity !== "error" || !diagnostic.writable_paths?.length) return [];
    const probe = selectorIssueProbes([issue], selectors)[0]!;
    const read = diagnostic.record_read;
    const focus: SelectorRepairFocus = { identity: probe.identity, code: diagnostic.code,
      path: diagnostic.path, diagnostic_cursor,
      ...(read?.tool === "read_target_selectors" && read.arguments?.key ? { record_read: read } : {}) };
    return [{ focus, probe, diagnostic }];
  });
  const selected = candidates.find(row => row.focus.identity === previous?.identity)
    ?? candidates.find(row => row.focus.record_read)
    ?? candidates[0];
  return selected ? { ...selected, remaining_diagnostic_count: candidates.length } : undefined;
}
