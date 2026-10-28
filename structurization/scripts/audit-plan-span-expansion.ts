import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { materialize } from "../src/materializer.js";

type JsonRecord = Record<string, unknown>;

interface BatchTarget extends JsonRecord {
  target_id: string;
  name?: string;
  status?: string;
}

interface BatchFile extends JsonRecord {
  job_id: string;
  targets: BatchTarget[];
}

interface SpanRecord extends JsonRecord {
  span_id: string;
  evidence_id: string;
  start: number;
  end: number;
}

interface SpanUse {
  span_id: string;
  path: string;
  role_path: string;
}

interface ResolvedSpan extends SpanUse {
  evidence_id: string;
  start: number;
  end: number;
  length: number;
  source_length: number;
  is_full_source: boolean;
  text_preview: string;
  html_table_indices: number[];
  is_exact_html_cell: boolean;
}

interface StructuralFinding extends JsonRecord {
  code: string;
  severity: "risk" | "info";
  path: string;
  span_id: string;
  evidence_id: string;
  message: string;
}

interface ArtifactMetric {
  source_file: string;
  pretty_bytes: number;
  minified_bytes: number;
}

interface TargetAudit extends JsonRecord {
  target_id: string;
  target_name: string;
  batch_status: string;
  revision: number;
  revision_name: string;
  revision_status: string;
  seal: JsonRecord;
  artifacts: JsonRecord;
  counts: JsonRecord;
  bytes_per_item: JsonRecord;
  top_level_collections: JsonRecord;
  acceptance_item_fields: JsonRecord;
  selector_item_fields: JsonRecord;
  spans: JsonRecord;
  plan_string_deduplication: JsonRecord;
  legacy_read_candidate_plan_estimate: JsonRecord;
  structural_findings: StructuralFinding[];
  errors: string[];
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const isRecord = (value: unknown): value is JsonRecord => Boolean(value && typeof value === "object" && !Array.isArray(value));

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value: unknown): string {
  return sha256(canonical(value));
}

function preview(value: string, limit = 120): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function jsonMetric(value: unknown, sourceFile: string): ArtifactMetric {
  return {
    source_file: sourceFile,
    pretty_bytes: utf8Bytes(`${JSON.stringify(value, null, 2)}\n`),
    minified_bytes: utf8Bytes(JSON.stringify(value)),
  };
}

function collectionMetrics(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, {
    kind: Array.isArray(entry) ? "array" : isRecord(entry) ? "object" : typeof entry,
    count: Array.isArray(entry) ? entry.length : isRecord(entry) ? Object.keys(entry).length : 1,
    pretty_bytes: utf8Bytes(JSON.stringify(entry, null, 2)),
    minified_bytes: utf8Bytes(JSON.stringify(entry)),
  }]));
}

function perObjectFieldMetrics(values: unknown[]): JsonRecord {
  const fields = new Map<string, { occurrences: number; minified_bytes: number; pretty_bytes: number }>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      const current = fields.get(key) ?? { occurrences: 0, minified_bytes: 0, pretty_bytes: 0 };
      current.occurrences += 1;
      current.minified_bytes += utf8Bytes(JSON.stringify(entry));
      current.pretty_bytes += utf8Bytes(JSON.stringify(entry, null, 2));
      fields.set(key, current);
    }
  }
  return Object.fromEntries([...fields.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, metric]) => [key, {
      ...metric,
      average_minified_bytes: metric.occurrences ? Math.round(metric.minified_bytes / metric.occurrences) : 0,
    }]));
}

function collectStrings(value: unknown): JsonRecord {
  const groups = new Map<string, { value: string; paths: string[]; count: number; bytes_each: number }>();
  const visit = (entry: unknown, path: string): void => {
    if (typeof entry === "string") {
      const hash = sha256(entry);
      const group = groups.get(hash) ?? { value: entry, paths: [], count: 0, bytes_each: utf8Bytes(JSON.stringify(entry)) };
      group.count += 1;
      if (group.paths.length < 8) group.paths.push(path);
      groups.set(hash, group);
      return;
    }
    if (Array.isArray(entry)) entry.forEach((child, index) => visit(child, `${path}/${index}`));
    else if (isRecord(entry)) Object.entries(entry).forEach(([key, child]) => visit(child, `${path}/${key}`));
  };
  visit(value, "");
  const all = [...groups.entries()];
  const gross = all.reduce((sum, [, group]) => sum + group.count * group.bytes_each, 0);
  const unique = all.reduce((sum, [, group]) => sum + group.bytes_each, 0);
  const duplicateGroups = all.filter(([, group]) => group.count > 1)
    .sort(([, a], [, b]) => (b.count - 1) * b.bytes_each - (a.count - 1) * a.bytes_each)
    .slice(0, 30)
    .map(([hash, group]) => ({
      sha256: hash,
      count: group.count,
      bytes_each: group.bytes_each,
      duplicate_bytes: (group.count - 1) * group.bytes_each,
      value_preview: preview(group.value),
      sample_paths: group.paths,
    }));
  return {
    string_occurrences: all.reduce((sum, [, group]) => sum + group.count, 0),
    unique_exact_strings: all.length,
    gross_string_bytes: gross,
    unique_net_string_bytes: unique,
    duplicate_string_bytes: gross - unique,
    duplicate_byte_ratio: gross ? Number(((gross - unique) / gross).toFixed(4)) : 0,
    exact_duplicate_groups: duplicateGroups,
  };
}

function rolePath(path: string): string {
  return path.replaceAll(/\/\d+(?=\/|$)/g, "/[]");
}

function collectSpanUses(value: unknown): SpanUse[] {
  const uses: SpanUse[] = [];
  const visit = (entry: unknown, path: string): void => {
    if (typeof entry === "string" && /^span:[a-f0-9]{32}$/.test(entry)) {
      uses.push({ span_id: entry, path, role_path: rolePath(path) });
      return;
    }
    if (Array.isArray(entry)) entry.forEach((child, index) => visit(child, `${path}/${index}`));
    else if (isRecord(entry)) Object.entries(entry).forEach(([key, child]) => visit(child, `${path}/${key}`));
  };
  visit(value, "");
  return uses;
}

interface HtmlRange { index: number; start: number; end: number }
interface HtmlCell extends HtmlRange { table_index: number }

function htmlGeometry(source: string): { tables: HtmlRange[]; cells: HtmlCell[] } {
  const tables: HtmlRange[] = [];
  const cells: HtmlCell[] = [];
  [...source.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].forEach((match, tableIndex) => {
    const tableText = match[0];
    const tableStart = match.index ?? 0;
    tables.push({ index: tableIndex, start: tableStart, end: tableStart + tableText.length });
    [...tableText.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].forEach((cell, cellIndex) => {
      const content = cell[1] ?? "";
      const cellStart = tableStart + (cell.index ?? 0) + cell[0].indexOf(content);
      cells.push({ index: cellIndex, table_index: tableIndex, start: cellStart, end: cellStart + content.length });
    });
  });
  return { tables, cells };
}

function intersects(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

function resolveSpans(
  uses: SpanUse[],
  registry: JsonRecord,
  evidence: JsonRecord,
): { resolved: ResolvedSpan[]; missing: SpanUse[] } {
  const spans = Array.isArray(registry.spans) ? registry.spans.filter(isRecord) as SpanRecord[] : [];
  const records = Array.isArray(evidence.evidence) ? evidence.evidence.filter(isRecord) : [];
  const spanById = new Map(spans.map((span) => [span.span_id, span]));
  const sourceById = new Map(records.map((record) => [String(record.evidence_id), String(record.text ?? "")]));
  const geometryById = new Map<string, ReturnType<typeof htmlGeometry>>();
  const resolved: ResolvedSpan[] = [];
  const missing: SpanUse[] = [];
  for (const use of uses) {
    const span = spanById.get(use.span_id);
    if (!span) { missing.push(use); continue; }
    const source = sourceById.get(span.evidence_id) ?? "";
    const geometry = geometryById.get(span.evidence_id) ?? htmlGeometry(source);
    geometryById.set(span.evidence_id, geometry);
    const tableIndices = geometry.tables
      .filter((table) => intersects(span.start, span.end, table.start, table.end))
      .map((table) => table.index);
    resolved.push({
      ...use,
      evidence_id: span.evidence_id,
      start: span.start,
      end: span.end,
      length: span.end - span.start,
      source_length: source.length,
      is_full_source: span.start === 0 && span.end === source.length && source.length > 0,
      text_preview: preview(source.slice(span.start, span.end)),
      html_table_indices: tableIndices,
      // A selector may legitimately choose a narrower exact value inside one cell.
      // The unsafe shape is a single role span escaping that cell and absorbing
      // siblings/rows/tables, not a substring of a mechanically identified cell.
      is_exact_html_cell: geometry.cells.some((cell) => span.start >= cell.start && span.end <= cell.end),
    });
  }
  return { resolved, missing };
}

function findingForSpan(code: string, severity: "risk" | "info", span: ResolvedSpan, message: string): StructuralFinding {
  return { code, severity, path: span.path, span_id: span.span_id, evidence_id: span.evidence_id, message,
    span_length: span.length, source_length: span.source_length, text_preview: span.text_preview };
}

function structuralFindings(selectors: JsonRecord, resolved: ResolvedSpan[]): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const byPath = new Map(resolved.map((span) => [span.path, span]));
  const rules = Array.isArray(selectors.sampling_rules) ? selectors.sampling_rules.filter(isRecord) : [];
  const items = Array.isArray(selectors.items) ? selectors.items.filter(isRecord) : [];
  rules.forEach((rule, ruleIndex) => {
    const completeIds = Array.isArray(rule.complete_span_ids) ? rule.complete_span_ids.filter((id): id is string => typeof id === "string") : [];
    const receiverKeys = items.filter((item) => isRecord(item.sampling) && item.sampling.rule_key === rule.key)
      .map((item) => String(item.key));
    const candidateUses = resolved.filter((span) =>
      span.path.startsWith(`/sampling_rules/${ruleIndex}/branches/`)
      || items.some((item, itemIndex) => receiverKeys.includes(String(item.key)) && span.path.startsWith(`/items/${itemIndex}/`))
    );
    completeIds.forEach((id, completeIndex) => {
      const complete = byPath.get(`/sampling_rules/${ruleIndex}/complete_span_ids/${completeIndex}`);
      if (!complete?.is_full_source) return;
      const narrower = candidateUses.filter((span) => span.evidence_id === complete.evidence_id
        && span.start >= complete.start && span.end <= complete.end && span.length < complete.length);
      if (!narrower.length) return;
      findings.push({
        ...findingForSpan(
          "sampling_complete_full_source_with_narrower_branch_or_receiver",
          "risk",
          complete,
          "Sampling complete source binds the entire immutable source although the same rule already has narrower branch or receiving-item spans.",
        ),
        rule_key: String(rule.key ?? ""),
        receiver_item_keys: receiverKeys,
        narrower_span_count: narrower.length,
        narrower_examples: narrower.slice(0, 8).map((span) => ({ path: span.path, span_id: span.span_id, length: span.length })),
      });
    });
  });

  for (const span of resolved) {
    const tableRole = /^\/items\/\d+\/table\/properties\/([^/]+)/.exec(span.path)?.[1] ?? "";
    const fieldRole = /^\/items\/\d+\/fields\/([^/]+)\/span_ids\//.exec(span.path)?.[1] ?? "";
    if (span.html_table_indices.length > 1 && tableRole) {
      findings.push(findingForSpan(
        "table_role_span_crosses_multiple_html_tables", "risk", span,
        `Table role ${tableRole} crosses ${span.html_table_indices.length} HTML table boundaries.`,
      ));
    }
    if (span.html_table_indices.length > 1 && fieldRole) {
      findings.push(findingForSpan(
        "acceptance_field_span_crosses_multiple_html_tables", "risk", span,
        `Acceptance-item field ${fieldRole} crosses ${span.html_table_indices.length} HTML table boundaries.`,
      ));
    }
    if (
      tableRole
      && /^(row_path_span_ids|column_path_span_ids|unit_span_ids|condition_span_ids|allowed_value_span_ids)$/.test(tableRole)
      && span.html_table_indices.length > 0
      && !span.is_exact_html_cell
    ) {
      findings.push(findingForSpan(
        "table_cell_role_span_not_single_html_cell", "risk", span,
        `Table cell role ${tableRole} intersects HTML table markup but is not contained within one td/th cell.`,
      ));
    }
    if (span.is_full_source && /^\/source_dispositions\//.test(span.path)) {
      findings.push(findingForSpan(
        "source_disposition_full_source_span", "info", span,
        "A source disposition uses a full-source span; recorded as scope bookkeeping, not a business-field error.",
      ));
    }
    if (span.is_full_source && /^\/lots\//.test(span.path)) {
      findings.push(findingForSpan(
        "lot_scope_full_source_span", "info", span,
        "A lot scope uses a full-source span; recorded as scope bookkeeping, not a business-field error.",
      ));
    }
  }
  return findings.filter((finding, index, all) => all.findIndex((candidate) =>
    candidate.code === finding.code && candidate.path === finding.path && candidate.span_id === finding.span_id
  ) === index);
}

function percentile(sorted: number[], value: number): number {
  if (!sorted.length) return 0;
  return Number((sorted.filter((entry) => entry <= value).length / sorted.length).toFixed(4));
}

function distribution(values: number[]): JsonRecord {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted.at(-1) ?? 0,
  };
}

async function locateBatch(jobRoot: string): Promise<{ jobRoot: string; batchRoot: string; batchPath: string }> {
  const direct = join(jobRoot, "batch.json");
  if (await exists(direct)) return { jobRoot: dirname(dirname(dirname(jobRoot))), batchRoot: jobRoot, batchPath: direct };
  const expected = join(jobRoot, "pi-agent", "jobs", basename(jobRoot), "batch.json");
  if (await exists(expected)) return { jobRoot, batchRoot: dirname(expected), batchPath: expected };
  const jobsRoot = join(jobRoot, "pi-agent", "jobs");
  if (await exists(jobsRoot)) {
    for (const entry of await readdir(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(jobsRoot, entry.name, "batch.json");
      if (await exists(candidate)) return { jobRoot, batchRoot: dirname(candidate), batchPath: candidate };
    }
  }
  throw new Error(`Cannot locate pi-agent batch.json under ${jobRoot}`);
}

async function preferredJson(root: string, names: string[]): Promise<{ value: JsonRecord; file: string } | undefined> {
  for (const name of names) {
    const path = join(root, name);
    if (!(await exists(path))) continue;
    const value = await readJson(path);
    if (isRecord(value)) return { value, file: name };
  }
  return undefined;
}

async function auditTarget(batchRoot: string, target: BatchTarget): Promise<TargetAudit> {
  const encoded = encodeURIComponent(target.target_id).replaceAll("%", "_");
  const revisionsRoot = join(batchRoot, "targets", encoded, "revisions");
  const revisionNames = (await readdir(revisionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
    .map((entry) => entry.name).sort();
  const revisionName = revisionNames.at(-1) ?? "";
  if (!revisionName) throw new Error(`Target ${target.target_id} has no numeric revision`);
  const revisionRoot = join(revisionsRoot, revisionName);
  const errors: string[] = [];
  const [stateEntry, planEntry, selectorEntry, registryEntry, evidenceEntry] = await Promise.all([
    preferredJson(revisionRoot, ["state.json"]),
    preferredJson(revisionRoot, ["semantic-source-plan.json", "last-valid.semantic-source-plan.json", "working.semantic-source-plan.json"]),
    preferredJson(revisionRoot, ["target-selectors.json", "last-valid.target-selectors.json", "working.target-selectors.json"]),
    preferredJson(revisionRoot, ["source-span-registry.json"]),
    preferredJson(join(revisionRoot, "evidence"), ["evidence.json"]),
  ]);
  const state = stateEntry?.value ?? {};
  const plan = planEntry?.value ?? {};
  const selectors = selectorEntry?.value ?? {};
  const registry = registryEntry?.value ?? {};
  const evidence = evidenceEntry?.value ?? {};
  let materialized: JsonRecord = {};
  let materializedSource = "";
  const persistedResult = await preferredJson(revisionRoot, ["result.json"]);
  if (persistedResult) {
    materialized = persistedResult.value;
    materializedSource = persistedResult.file;
  } else if (planEntry && evidenceEntry) {
    try {
      materialized = materialize(plan as never, evidence as never, sha256Json(plan)).result as unknown as JsonRecord;
      materializedSource = "deterministic materialize(plan,evidence) audit replay";
    } catch (error) {
      errors.push(`materialize: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const registrySpans = Array.isArray(registry.spans) ? registry.spans.filter(isRecord) as SpanRecord[] : [];
  const uses = collectSpanUses(selectors);
  const { resolved: usedSpans, missing } = resolveSpans(uses, registry, evidence);
  if (missing.length) errors.push(`${missing.length} selector span reference(s) are missing from the registry`);
  const uniqueUsed = new Map<string, ResolvedSpan>();
  usedSpans.forEach((span) => uniqueUsed.set(span.span_id, span));
  const evidenceTextById = new Map((Array.isArray(evidence.evidence) ? evidence.evidence.filter(isRecord) : [])
    .map((record) => [String(record.evidence_id), String(record.text ?? "")]));
  const allResolved = registrySpans.map((span) => ({
    span_id: span.span_id,
    evidence_id: span.evidence_id,
    start: span.start,
    end: span.end,
    length: span.end - span.start,
    source_length: (evidenceTextById.get(span.evidence_id) ?? "").length,
  })).sort((a, b) => b.length - a.length);
  const usedSorted = [...uniqueUsed.values()].sort((a, b) => b.length - a.length);
  const roleStats = new Map<string, { references: number; unique_span_ids: Set<string>; lengths: number[] }>();
  usedSpans.forEach((span) => {
    const metric = roleStats.get(span.role_path) ?? { references: 0, unique_span_ids: new Set<string>(), lengths: [] };
    metric.references += 1;
    metric.unique_span_ids.add(span.span_id);
    metric.lengths.push(span.length);
    roleStats.set(span.role_path, metric);
  });
  const tableRoleFanout = new Map<string, Set<string>>();
  usedSpans.forEach((span) => {
    const match = /^\/items\/(\d+)\/table\/properties\//.exec(span.path);
    if (!match) return;
    const itemIds = tableRoleFanout.get(span.span_id) ?? new Set<string>();
    itemIds.add(match[1]!);
    tableRoleFanout.set(span.span_id, itemIds);
  });
  const tableRoleFanoutRows = [...tableRoleFanout.entries()].map(([spanId, itemIndices]) => ({
    span_id: spanId,
    item_count: itemIndices.size,
    item_indices: [...itemIndices].map(Number).sort((a, b) => a - b),
    role_paths: [...new Set(usedSpans.filter((span) => span.span_id === spanId && span.path.includes("/table/properties/"))
      .map((span) => span.role_path))].sort(),
  })).sort((a, b) => b.item_count - a.item_count || a.span_id.localeCompare(b.span_id));
  const planItems = Array.isArray(plan.acceptance_items) ? plan.acceptance_items : [];
  const selectorItems = Array.isArray(selectors.items) ? selectors.items : [];
  const materializedLots = Array.isArray(materialized.inspection_lots) ? materialized.inspection_lots.filter(isRecord) : [];
  const materializedItems = materializedLots.flatMap((lot) => Array.isArray(lot.items) ? lot.items : []);
  const artifactMetrics = {
    plan: jsonMetric(plan, planEntry?.file ?? "missing"),
    selectors: jsonMetric(selectors, selectorEntry?.file ?? "missing"),
    registry: jsonMetric(registry, registryEntry?.file ?? "missing"),
    materialized: jsonMetric(materialized, materializedSource || "missing"),
  };
  const legacyResponse = { ok: true, candidate_plan: plan, materialized_preview: materialized };
  const legacyResponseBytes = utf8Bytes(JSON.stringify(legacyResponse));
  const itemCount = planItems.length;
  return {
    target_id: target.target_id,
    target_name: String(target.name ?? ""),
    batch_status: String(target.status ?? ""),
    revision: Number(revisionName),
    revision_name: revisionName,
    revision_status: String(state.status ?? "unknown"),
    revision_root: revisionRoot,
    seal: {
      manifest_exists: await exists(join(revisionRoot, "manifest.json")),
      seal_receipt_exists: await exists(join(revisionRoot, "seal-receipt.json")),
      sealed_plan_exists: await exists(join(revisionRoot, "semantic-source-plan.json")),
      result_exists: await exists(join(revisionRoot, "result.json")),
    },
    artifacts: artifactMetrics,
    expansion_chain: {
      selector_minified_bytes: artifactMetrics.selectors.minified_bytes,
      plan_minified_bytes: artifactMetrics.plan.minified_bytes,
      selector_to_plan_ratio: artifactMetrics.selectors.minified_bytes
        ? Number((artifactMetrics.plan.minified_bytes / artifactMetrics.selectors.minified_bytes).toFixed(4))
        : 0,
      materialized_minified_bytes: artifactMetrics.materialized.minified_bytes,
      plan_to_materialized_ratio: artifactMetrics.plan.minified_bytes
        ? Number((artifactMetrics.materialized.minified_bytes / artifactMetrics.plan.minified_bytes).toFixed(4))
        : 0,
      legacy_read_candidate_plan_dual_storage_bytes: legacyResponseBytes * 2,
      selector_to_legacy_dual_storage_ratio: artifactMetrics.selectors.minified_bytes
        ? Number(((legacyResponseBytes * 2) / artifactMetrics.selectors.minified_bytes).toFixed(4))
        : 0,
    },
    counts: {
      plan_items: itemCount,
      selector_items: selectorItems.length,
      materialized_items: materializedItems.length,
      plan_lots: Array.isArray(plan.inspection_lots) ? plan.inspection_lots.length : 0,
      selector_lots: Array.isArray(selectors.lots) ? selectors.lots.length : 0,
      registry_spans: registrySpans.length,
      selector_span_references: uses.length,
      selector_unique_used_spans: uniqueUsed.size,
    },
    bytes_per_item: Object.fromEntries(Object.entries(artifactMetrics).map(([key, metric]) => [key, {
      pretty: itemCount ? Math.round(metric.pretty_bytes / itemCount) : metric.pretty_bytes,
      minified: itemCount ? Math.round(metric.minified_bytes / itemCount) : metric.minified_bytes,
    }])),
    top_level_collections: {
      plan: collectionMetrics(plan),
      selectors: collectionMetrics(selectors),
      registry: collectionMetrics(registry),
      materialized: collectionMetrics(materialized),
    },
    acceptance_item_fields: perObjectFieldMetrics(planItems),
    selector_item_fields: perObjectFieldMetrics(selectorItems),
    spans: {
      registry_max_span: allResolved[0] ?? null,
      used_max_span: usedSorted[0] ?? null,
      missing_used_span_count: missing.length,
      table_role_max_item_fanout: tableRoleFanoutRows[0]?.item_count ?? 0,
      table_role_fanout_examples: tableRoleFanoutRows.slice(0, 12),
      full_source_used_spans: usedSorted.filter((span) => span.is_full_source).map((span) => ({
        span_id: span.span_id, evidence_id: span.evidence_id, length: span.length,
        role_paths: [...new Set(usedSpans.filter((entry) => entry.span_id === span.span_id).map((entry) => entry.role_path))],
      })),
      role_paths: Object.fromEntries([...roleStats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, metric]) => [path, {
        references: metric.references,
        unique_span_count: metric.unique_span_ids.size,
        max_span_length: Math.max(...metric.lengths),
        average_span_length: Math.round(metric.lengths.reduce((sum, length) => sum + length, 0) / metric.lengths.length),
      }])),
    },
    plan_string_deduplication: collectStrings(plan),
    legacy_read_candidate_plan_estimate: {
      note: "Estimate only: legacy response serializes the complete plan and materialized preview once into Pi content text and once into Pi details.",
      response_minified_bytes: legacyResponseBytes,
      pi_content_text_bytes: legacyResponseBytes,
      pi_details_bytes: legacyResponseBytes,
      estimated_content_plus_details_bytes: legacyResponseBytes * 2,
    },
    structural_findings: structuralFindings(selectors, usedSpans),
    errors,
  };
}

function markdown(audit: JsonRecord): string {
  const targets = Array.isArray(audit.targets) ? audit.targets.filter(isRecord) as unknown as TargetAudit[] : [];
  const distributions = isRecord(audit.distributions) ? audit.distributions : {};
  const findingCounts = new Map<string, number>();
  targets.flatMap((target) => target.structural_findings).forEach((finding) => findingCounts.set(finding.code, (findingCounts.get(finding.code) ?? 0) + 1));
  const lines = [
    "# Plan / span expansion audit",
    "",
    `- Job: \`${String(audit.job_id)}\``,
    `- Generated: \`${String(audit.generated_at)}\``,
    `- Targets: ${targets.length}`,
    "- Nature: read-only structural audit; findings are derived from span/provenance geometry, not target names, titles, numbering, or business keywords.",
    "- Byte comparisons are distributional. No fixed byte threshold is used as a correctness verdict.",
    "",
    "## Distribution baseline",
    "",
    "```json",
    JSON.stringify(distributions, null, 2),
    "```",
    "",
    "## Structural findings",
    "",
    ...(findingCounts.size ? [...findingCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `- \`${code}\`: ${count}`) : ["- None"]),
    "",
    "## Targets",
    "",
    "| target | rev/status | items | plan pretty/min | selector pretty/min | used max span | risk/info | plan pct |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const target of targets) {
    const artifacts = target.artifacts as Record<string, ArtifactMetric>;
    const counts = target.counts as JsonRecord;
    const spans = target.spans as JsonRecord;
    const usedMax = isRecord(spans.used_max_span) ? Number(spans.used_max_span.length ?? 0) : 0;
    const risks = target.structural_findings.filter((finding) => finding.severity === "risk").length;
    const infos = target.structural_findings.filter((finding) => finding.severity === "info").length;
    const comparison = isRecord(target.distribution_comparison) ? target.distribution_comparison : {};
    lines.push(`| \`${target.target_id}\` ${target.target_name} | ${target.revision_name}/${target.revision_status} | ${counts.plan_items ?? 0} | ${artifacts.plan.pretty_bytes}/${artifacts.plan.minified_bytes} | ${artifacts.selectors.pretty_bytes}/${artifacts.selectors.minified_bytes} | ${usedMax} | ${risks}/${infos} | ${comparison.plan_pretty_percentile ?? ""} |`);
    if (target.structural_findings.length) {
      lines.push("", ...target.structural_findings.map((finding) =>
        `  - ${finding.severity === "risk" ? "RISK" : "INFO"} \`${finding.code}\` \`${finding.path}\`: ${finding.message}`
      ), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: tsx scripts/audit-plan-span-expansion.ts <job-root>");
  const located = await locateBatch(resolve(input));
  const batchValue = await readJson(located.batchPath);
  if (!isRecord(batchValue) || !Array.isArray(batchValue.targets)) throw new Error(`Invalid batch file: ${located.batchPath}`);
  const batch = batchValue as unknown as BatchFile;
  const targets: TargetAudit[] = [];
  for (const target of batch.targets) {
    try {
      targets.push(await auditTarget(located.batchRoot, target));
    } catch (error) {
      targets.push({
        target_id: target.target_id, target_name: String(target.name ?? ""), batch_status: String(target.status ?? ""),
        revision: 0, revision_name: "", revision_status: "unreadable", seal: {}, artifacts: {}, counts: {}, bytes_per_item: {},
        top_level_collections: {}, acceptance_item_fields: {}, selector_item_fields: {}, spans: {}, plan_string_deduplication: {},
        legacy_read_candidate_plan_estimate: {}, structural_findings: [], errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  const planPretty = targets.map((target) => Number((target.artifacts as Record<string, ArtifactMetric>).plan?.pretty_bytes ?? 0));
  const selectorPretty = targets.map((target) => Number((target.artifacts as Record<string, ArtifactMetric>).selectors?.pretty_bytes ?? 0));
  const registryPretty = targets.map((target) => Number((target.artifacts as Record<string, ArtifactMetric>).registry?.pretty_bytes ?? 0));
  const usedMax = targets.map((target) => isRecord((target.spans as JsonRecord).used_max_span) ? Number(((target.spans as JsonRecord).used_max_span as JsonRecord).length ?? 0) : 0);
  const duplicateRatio = targets.map((target) => Number((target.plan_string_deduplication as JsonRecord).duplicate_byte_ratio ?? 0));
  const tableRoleFanout = targets.map((target) => Number((target.spans as JsonRecord).table_role_max_item_fanout ?? 0));
  targets.forEach((target, index) => {
    target.distribution_comparison = {
      plan_pretty_percentile: percentile([...planPretty].sort((a, b) => a - b), planPretty[index]!),
      selector_pretty_percentile: percentile([...selectorPretty].sort((a, b) => a - b), selectorPretty[index]!),
      registry_pretty_percentile: percentile([...registryPretty].sort((a, b) => a - b), registryPretty[index]!),
      used_max_span_percentile: percentile([...usedMax].sort((a, b) => a - b), usedMax[index]!),
      plan_duplicate_ratio_percentile: percentile([...duplicateRatio].sort((a, b) => a - b), duplicateRatio[index]!),
      table_role_fanout_percentile: percentile([...tableRoleFanout].sort((a, b) => a - b), tableRoleFanout[index]!),
    };
    const comparison = target.distribution_comparison as JsonRecord;
    if (
      Number(comparison.plan_pretty_percentile) >= 0.9
      && Number(comparison.plan_duplicate_ratio_percentile) >= 0.9
      && Number(comparison.table_role_fanout_percentile) >= 0.9
    ) {
      const duplicateBytes = Number((target.plan_string_deduplication as JsonRecord).duplicate_string_bytes ?? 0);
      target.structural_findings.push({
        code: "table_provenance_fanout_plan_expansion_outlier",
        severity: "risk",
        path: "/items/*/table/properties",
        span_id: "",
        evidence_id: "",
        message: "The same table provenance spans fan out across many selector items and this target is simultaneously in the corpus upper tail for plan size and exact-string duplication. Review the expansion boundary; this is distribution-derived and does not assert that shared provenance is semantically wrong.",
        max_item_fanout: tableRoleFanout[index],
        plan_pretty_bytes: planPretty[index],
        duplicate_string_bytes: duplicateBytes,
        distribution_percentiles: comparison,
      });
    }
  });
  const audit: JsonRecord = {
    schema_version: "plan-span-expansion-audit/v1",
    job_id: batch.job_id,
    generated_at: new Date().toISOString(),
    job_root: located.jobRoot,
    batch_root: located.batchRoot,
    batch_status: String(batch.status ?? ""),
    target_count: targets.length,
    methodology: {
      latest_revision: "highest six-digit numeric revision directory per configured target",
      findings: "mechanical span containment and HTML table/cell boundaries only",
      full_source_scope_spans: "source_disposition and lot full spans are informational, not business-field errors",
      distribution_policy: "percentile comparisons only; no fixed byte cutoff is used as a correctness verdict",
      legacy_response_estimate: "complete plan + materialized preview serialized in both Pi content text and details",
    },
    distributions: {
      plan_pretty_bytes: distribution(planPretty),
      selector_pretty_bytes: distribution(selectorPretty),
      registry_pretty_bytes: distribution(registryPretty),
      used_max_span_length: distribution(usedMax),
      plan_duplicate_byte_ratio: distribution(duplicateRatio),
      table_role_max_item_fanout: distribution(tableRoleFanout),
    },
    finding_summary: Object.fromEntries([...new Set(targets.flatMap((target) => target.structural_findings.map((finding) => finding.code)))].sort()
      .map((code) => [code, {
        occurrences: targets.flatMap((target) => target.structural_findings).filter((finding) => finding.code === code).length,
        target_ids: targets.filter((target) => target.structural_findings.some((finding) => finding.code === code)).map((target) => target.target_id),
      }])),
    targets,
  };
  const outputRoot = join(located.jobRoot, "output", "plan-span-audit");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(join(outputRoot, "audit.md"), markdown(audit), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, output_root: outputRoot, targets: targets.length, finding_summary: audit.finding_summary }, null, 2)}\n`);
}

await main();
