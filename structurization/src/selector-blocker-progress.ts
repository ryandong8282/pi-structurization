import { sha256Json } from "./canonical.js";
import type { SourceSpanRegistry } from "./source-span-registry.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

export interface SelectorIssueProbe {
  identity: string;
  code: string;
  path: string;
  bindings: Array<{ collection: string; key: string; suffix: string }>;
  evidence_ids: string[];
  requires_location: boolean;
  unresolved_units: string[];
  check_scope?: string;
  assessed?: boolean;
}

export interface SelectorBlockerObservation {
  identity: string; fingerprint: string;
  units?: string[];
  source_work?: string[];
  assessed?: boolean;
}
export interface SelectorBlockerHistory {
  blockers: Array<SelectorBlockerObservation & { unchanged_rounds: number }>;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Author explanations and confidence are not evidence of a repaired binding. */
function facts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(facts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "reason" && !key.endsWith("_reason") && key !== "confidence"
  ).map(([key, child]) => [key, facts(child)]));
}

/** Saved author decisions, without explanations, confidence or record ordering.
 * This detects an actual edit; it never declares that the business choice passed. */
export function selectorAuthorFactsFingerprint(selectors: TargetSelectorPlan): string {
  const normalized = facts(selectors) as Record<string, unknown>;
  for (const key of ["lots", "items", "sampling_rules", "references", "source_dispositions", "residual_source_dispositions"]) {
    const rows = normalized[key];
    if (Array.isArray(rows)) normalized[key] = [...rows].sort((left, right) => sha256Json(left).localeCompare(sha256Json(right)));
  }
  return sha256Json(normalized);
}

function sourceIds(value: unknown, found = new Set<string>(), key = ""): Set<string> {
  if (typeof value === "string" && (value.startsWith("evidence:") || key === "evidence_id" || key.endsWith("evidence_ids"))) found.add(value);
  else if (Array.isArray(value)) value.forEach(child => sourceIds(child, found, key));
  else if (value && typeof value === "object") Object.entries(facts(value) as object).forEach(([name, child]) => sourceIds(child, found, name));
  return found;
}

/** Stable author keys replace array positions; collection-wide edits are not
 * credited to a particular blocking issue. No business decision is inferred. */
export function selectorIssueProbes(issues: readonly unknown[], selectors: TargetSelectorPlan): SelectorIssueProbe[] {
  return issues.map(value => {
    const issue = record(value), details = record(issue.details);
    const writable = issue.writable_paths ?? details.writable_paths;
    const paths = [...new Set([issue.path, ...(Array.isArray(writable) ? writable : []),
      issue.writable_path ?? details.writable_path].filter((path): path is string => typeof path === "string"))];
    const bindings = paths.flatMap(path => {
      const match = /^\/(items|references|sampling_rules|lots)\/(\d+)(.*)$/u.exec(path);
      if (!match) return [];
      const row = (selectors as unknown as Record<string, any>)[match[1]!]?.[Number(match[2])];
      return typeof row?.key === "string" ? [{ collection: match[1]!, key: row.key, suffix: match[3]! }] : [];
    });
    const path = bindings[0] ? `/${bindings[0].collection}/${bindings[0].key}${bindings[0].suffix}` : String(issue.path ?? "");
    const primary = issue.evidence_ids ?? details.evidence_ids ?? issue.origin_evidence_ids ?? details.origin_evidence_ids;
    const primarySources = Array.isArray(primary) ? [...primary].sort() : [];
    const unitArrays = Object.entries({ ...details, ...issue }).filter(([key, child]) =>
      /^(?:missing|unaccounted|uncovered|outside|non_data|invalid|conflicting)/u.test(key) && Array.isArray(child));
    const units = unitArrays.flatMap(([key, children]) => (children as unknown[]).map(child => `${key}:${sha256Json(facts(child))}`));
    const unresolvedUnits = units.length ? units : Array.isArray(issue.evidence_ids ?? details.evidence_ids) && primarySources.length
      ? primarySources.map(id => `evidence:${id}`)
      : Array.from({ length: Number(issue.original_issue_count ?? details.original_issue_count ?? 1) }, (_, index) => `${path}:${index}`);
    return {
      identity: sha256Json({ code: issue.code, path, source_anchor: bindings.length ? undefined : primarySources[0],
        occurrence_id: details.occurrence_id ?? issue.occurrence_id }),
      code: String(issue.code ?? "selector_issue"), path, bindings,
      requires_location: ["locate_evidence_span", "batch_locate_evidence_spans"]
        .includes(issue.next_tool ?? details.next_tool),
      unresolved_units: unresolvedUnits.sort(),
      evidence_ids: [...sourceIds({ actual: issue.actual ?? details.actual,
        evidence_ids: primarySources, source_access: details.source_access,
        next_tool_arguments: issue.next_tool_arguments ?? details.next_tool_arguments })].sort(),
    };
  });
}

export function selectorBlockerObservations(probes: readonly SelectorIssueProbe[], _selectors: TargetSelectorPlan,
  registry: SourceSpanRegistry, openedEvidenceIds: ReadonlySet<string>, openedWindows: readonly string[] = []): SelectorBlockerObservation[] {
  return probes.map(probe => {
    const sourceSet = new Set(probe.evidence_ids);
    // A changed author input is an attempted repair, not convergence. Only a
    // fresh validation's remaining obligations or explicitly required source
    // work can advance this observation.
    const sourceWork = [ ...probe.evidence_ids.filter(id => openedEvidenceIds.has(id)).map(id => `read:${id}`),
      ...openedWindows.filter(key => probe.evidence_ids.some(id => key.startsWith(`${id}:`))).map(key => `window:${key}`),
      ...(probe.requires_location ? registry.spans.filter(span => sourceSet.has(span.evidence_id)) : [])
        .map(({ evidence_id, start, end, text_sha256 }) => ({ evidence_id, start, end, text_sha256 }))
        .map(span => `located:${sha256Json(span)}`) ].sort();
    return { identity: probe.identity, units: probe.unresolved_units, source_work: sourceWork,
      fingerprint: sha256Json({ units: probe.unresolved_units, source_work: sourceWork }),
      ...(probe.assessed === false ? { assessed: false } : {}) };
  });
}

/** Persist these observations across provider sessions. An unrelated draft
 * change cannot reset a blocker; fresh validation or necessary source work can. */
export function selectorBlockerImproved(prior: SelectorBlockerObservation, row: SelectorBlockerObservation): boolean {
  return prior.units && row.units
    ? prior.units.some(unit => !row.units!.includes(unit))
      || (row.source_work ?? []).some(unit => !(prior.source_work ?? []).includes(unit))
    : prior.fingerprint !== row.fingerprint;
}

export function observeSelectorBlockers(previous: SelectorBlockerHistory | undefined,
  before: readonly SelectorBlockerObservation[], after: readonly SelectorBlockerObservation[], limit = 3) {
  const old = new Map((previous?.blockers ?? before.map(row => ({ ...row, unchanged_rounds: 0 })))
    .map(row => [row.identity, row]));
  const blockers = after.map(row => {
    const prior = old.get(row.identity);
    return { ...row, unchanged_rounds: prior && !selectorBlockerImproved(prior, row)
      ? prior.unchanged_rounds + (row.assessed === false ? 0 : 1) : 0 };
  });
  const progress = before.some(row => {
    const next = after.find(candidate => candidate.identity === row.identity);
    return !next || selectorBlockerImproved(row, next);
  });
  return { history: { blockers }, progress,
    stalled: blockers.filter(row => row.assessed !== false && row.unchanged_rounds >= limit).map(row => row.identity) };
}
