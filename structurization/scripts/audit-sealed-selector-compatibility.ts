import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { auditSealedRevision, type AuditReceipt } from "../src/audit.js";
import { canonicalize, sha256Bytes, sha256Text } from "../src/canonical.js";
import type {
  EvidenceManifest,
  PersistedSemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import {
  compileTargetSelectors,
  migrateTargetSelectorPlanForAuthoring,
  TargetSelectorCompileError,
  type TargetSelectorIssue,
} from "../src/target-selector-compiler.js";
import { normalizeMineruInlineMath } from "../src/text-normalization.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

interface BatchTarget {
  target_id: string;
  name?: string;
  status: string;
  revision?: number;
  workdir?: string;
}

interface BatchReceipt {
  schema_version?: string;
  job_id: string;
  status?: string;
  targets: BatchTarget[];
}

interface FileSnapshot {
  relative_path: string;
  sha256: string;
  bytes: number;
}

interface StructuralFinding {
  code: string;
  path: string;
  message: string;
  details?: unknown;
}

interface TargetAuditResult {
  target_id: string;
  target_name: string;
  revision: number;
  revision_root: string;
  sealed_status_preserved: true;
  workspace_matches_batch_revision: boolean;
  artifact_guard: {
    before: FileSnapshot[];
    after: FileSnapshot[];
    unchanged: boolean;
  };
  legacy_plan: {
    schema_version: string;
    pretty_bytes: number;
    minified_bytes: number | null;
    source_sha256: string;
    current_validation_ok: boolean;
    current_validation_fingerprint: string;
    current_validation_issues: StructuralFinding[];
    sealed_audit: AuditReceipt | null;
    sealed_audit_error: string;
  };
  selector_authoring_compatibility: {
    source_schema_version: string;
    target_schema_version: string;
    migrated: boolean;
    sampling_rule_count: number;
    migration_issues: StructuralFinding[];
    legacy_unknown_roles_left_actionable: boolean;
    compile_attempted: true;
    compile_ok: boolean;
    compile_issues: StructuralFinding[];
    compile_error: string;
  };
  current_v8_recompile: {
    produced: boolean;
    schema_version: string;
    pretty_bytes: number | null;
    minified_bytes: number | null;
    source_span_count: number | null;
    validation_ok: boolean;
    validation_fingerprint: string;
    validation_issues: StructuralFinding[];
    materialized_full_result_matches_sealed: boolean | null;
    materialized_inspection_lots_match_sealed: boolean | null;
    materialized_inspection_lots_difference_count: number | null;
    materialized_inspection_lots_difference_examples: Array<{
      path: string;
      sealed: unknown;
      recompiled: unknown;
    }>;
    materialized_inspection_lots_compatibility_normalized_match: boolean | null;
  };
  fatal_error: string;
}

const GUARDED_ARTIFACTS = [
  "state.json",
  "manifest.json",
  "seal-receipt.json",
  "semantic-source-plan.json",
  "target-selectors.json",
  "source-span-registry.json",
  "evidence/evidence.json",
] as const;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function structuralFindings(issues: readonly TargetSelectorIssue[] | undefined): StructuralFinding[] {
  return (issues ?? []).map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.details === undefined ? {} : { details: issue.details }),
  }));
}

function compactDiffValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 240) {
    return { preview: value.slice(0, 240), truncated: true, sha256: sha256Text(value) };
  }
  return value;
}

function jsonDifferences(
  sealed: unknown,
  recompiled: unknown,
  path = "",
  output: Array<{ path: string; sealed: unknown; recompiled: unknown }> = [],
  maxExamples = 24,
): { count: number; examples: Array<{ path: string; sealed: unknown; recompiled: unknown }> } {
  let count = 0;
  const visit = (left: unknown, right: unknown, currentPath: string): void => {
    if (canonicalize(left) === canonicalize(right)) return;
    const leftRecord = left && typeof left === "object" && !Array.isArray(left)
      ? left as Record<string, unknown>
      : null;
    const rightRecord = right && typeof right === "object" && !Array.isArray(right)
      ? right as Record<string, unknown>
      : null;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        count += 1;
        if (output.length < maxExamples) output.push({
          path: `${currentPath}/length`,
          sealed: left.length,
          recompiled: right.length,
        });
      }
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) visit(left[index], right[index], `${currentPath}/${index}`);
      return;
    }
    if (leftRecord && rightRecord) {
      const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
      for (const key of keys) visit(leftRecord[key], rightRecord[key], `${currentPath}/${key}`);
      return;
    }
    count += 1;
    if (output.length < maxExamples) output.push({
      path: currentPath || "/",
      sealed: compactDiffValue(left),
      recompiled: compactDiffValue(right),
    });
  };
  visit(sealed, recompiled, path);
  return { count, examples: output };
}

function compatibilityNormalizedMaterializedValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeMineruInlineMath(value);
  if (Array.isArray(value)) return value.map(compatibilityNormalizedMaterializedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, nested]) => !(key === "components" && Array.isArray(nested) && nested.length === 0))
      .map(([key, nested]) => [key, compatibilityNormalizedMaterializedValue(nested)]));
  }
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function snapshotArtifacts(revisionRoot: string): Promise<FileSnapshot[]> {
  return Promise.all(GUARDED_ARTIFACTS.map(async (relativePath) => {
    const content = await readFile(resolve(revisionRoot, relativePath));
    return {
      relative_path: relativePath,
      sha256: sha256Bytes(content),
      bytes: content.length,
    };
  }));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function artifactRootForBatch(batchPath: string): string {
  // <artifactRoot>/jobs/<jobId>/batch.json
  return dirname(dirname(dirname(resolve(batchPath))));
}

async function auditTarget(
  target: BatchTarget,
  batch: BatchReceipt,
  batchPath: string,
): Promise<TargetAuditResult> {
  const revisionRoot = resolve(String(target.workdir ?? ""));
  const revision = Number(target.revision ?? 0);
  const empty: TargetAuditResult = {
    target_id: target.target_id,
    target_name: String(target.name ?? target.target_id),
    revision,
    revision_root: revisionRoot,
    sealed_status_preserved: true,
    workspace_matches_batch_revision: false,
    artifact_guard: { before: [], after: [], unchanged: false },
    legacy_plan: {
      schema_version: "",
      pretty_bytes: 0,
      minified_bytes: null,
      source_sha256: "",
      current_validation_ok: false,
      current_validation_fingerprint: "",
      current_validation_issues: [],
      sealed_audit: null,
      sealed_audit_error: "",
    },
    selector_authoring_compatibility: {
      source_schema_version: "",
      target_schema_version: "target-selector-plan/v5",
      migrated: false,
      sampling_rule_count: 0,
      migration_issues: [],
      legacy_unknown_roles_left_actionable: false,
      compile_attempted: true,
      compile_ok: false,
      compile_issues: [],
      compile_error: "",
    },
    current_v8_recompile: {
      produced: false,
      schema_version: "",
      pretty_bytes: null,
      minified_bytes: null,
      source_span_count: null,
      validation_ok: false,
      validation_fingerprint: "",
      validation_issues: [],
      materialized_full_result_matches_sealed: null,
      materialized_inspection_lots_match_sealed: null,
      materialized_inspection_lots_difference_count: null,
      materialized_inspection_lots_difference_examples: [],
      materialized_inspection_lots_compatibility_normalized_match: null,
    },
    fatal_error: "",
  };

  try {
    if (!target.workdir) throw new Error("Sealed batch target has no workdir");
    empty.artifact_guard.before = await snapshotArtifacts(revisionRoot);
    const [planText, selectors, registry, evidence, sealedResultText] = await Promise.all([
      readFile(resolve(revisionRoot, "semantic-source-plan.json"), "utf8"),
      readJson<unknown>(resolve(revisionRoot, "target-selectors.json")),
      readJson<SourceSpanRegistry>(resolve(revisionRoot, "source-span-registry.json")),
      readJson<EvidenceManifest>(resolve(revisionRoot, "evidence/evidence.json")),
      readFile(resolve(revisionRoot, "result.json"), "utf8"),
    ]);
    const parsedPlan = JSON.parse(planText) as PersistedSemanticSourcePlan;
    const originalValidation = validatePlanText(planText, evidence);
    empty.legacy_plan = {
      ...empty.legacy_plan,
      schema_version: String(parsedPlan.schema_version ?? ""),
      pretty_bytes: utf8Bytes(planText),
      minified_bytes: (() => {
        try {
          return utf8Bytes(canonicalize(parsedPlan));
        } catch {
          return null;
        }
      })(),
      source_sha256: sha256Text(planText),
      current_validation_ok: originalValidation.ok,
      current_validation_fingerprint: originalValidation.fingerprint ?? "",
      current_validation_issues: structuralFindings(originalValidation.issues),
    };

    const workspace = await RevisionWorkspace.openLatest(
      artifactRootForBatch(batchPath),
      batch.job_id,
      target.target_id,
    );
    empty.workspace_matches_batch_revision = samePath(workspace.root, revisionRoot);
    if (!empty.workspace_matches_batch_revision) {
      empty.legacy_plan.sealed_audit_error = `Latest workspace ${workspace.root} differs from sealed batch workdir`;
    } else {
      try {
        empty.legacy_plan.sealed_audit = await auditSealedRevision(workspace);
      } catch (error) {
        empty.legacy_plan.sealed_audit_error = errorMessage(error);
      }
    }

    const migration = migrateTargetSelectorPlanForAuthoring(selectors);
    const migrationIssues = structuralFindings(migration.issues);
    const samplingRuleCount = Array.isArray((selectors as { sampling_rules?: unknown }).sampling_rules)
      ? ((selectors as { sampling_rules: unknown[] }).sampling_rules).length
      : 0;
    empty.selector_authoring_compatibility = {
      ...empty.selector_authoring_compatibility,
      source_schema_version: migration.source_schema_version,
      target_schema_version: String(migration.plan.schema_version ?? ""),
      migrated: migration.migrated,
      sampling_rule_count: samplingRuleCount,
      migration_issues: migrationIssues,
      legacy_unknown_roles_left_actionable: migrationIssues.some((issue) =>
        issue.code === "selector_sampling_component_migration_required"
      ),
    };

    try {
      const recompiled = compileTargetSelectors(selectors, registry, evidence, {
        allowLegacyExpandItems: true,
      });
      empty.selector_authoring_compatibility.compile_ok = true;
      const recompiledText = prettyJson(recompiled);
      const recompiledValidation = validatePlanText(recompiledText, evidence);
      const recompiledFingerprint = recompiledValidation.fingerprint ?? sha256Text(canonicalize(recompiled));
      let materializedFullResultMatchesSealed: boolean | null = null;
      let materializedInspectionLotsMatchSealed: boolean | null = null;
      let materializedInspectionLotsDifferenceCount: number | null = null;
      let materializedInspectionLotsDifferenceExamples: Array<{
        path: string;
        sealed: unknown;
        recompiled: unknown;
      }> = [];
      let materializedInspectionLotsCompatibilityNormalizedMatch: boolean | null = null;
      if (recompiledValidation.ok) {
        const replay = materialize(recompiled, evidence, recompiledFingerprint).result;
        const sealedResult = JSON.parse(sealedResultText) as { inspection_lots?: unknown };
        materializedFullResultMatchesSealed = canonicalize(replay) === canonicalize(sealedResult);
        materializedInspectionLotsMatchSealed = canonicalize(replay.inspection_lots)
          === canonicalize(sealedResult.inspection_lots);
        const differences = jsonDifferences(sealedResult.inspection_lots, replay.inspection_lots);
        materializedInspectionLotsDifferenceCount = differences.count;
        materializedInspectionLotsDifferenceExamples = differences.examples;
        materializedInspectionLotsCompatibilityNormalizedMatch = canonicalize(
          compatibilityNormalizedMaterializedValue(sealedResult.inspection_lots),
        ) === canonicalize(compatibilityNormalizedMaterializedValue(replay.inspection_lots));
      }
      empty.current_v8_recompile = {
        produced: true,
        schema_version: String(recompiled.schema_version ?? ""),
        pretty_bytes: utf8Bytes(recompiledText),
        minified_bytes: utf8Bytes(canonicalize(recompiled)),
        source_span_count: "source_spans" in recompiled && Array.isArray(recompiled.source_spans)
          ? recompiled.source_spans.length
          : null,
        validation_ok: recompiledValidation.ok,
        validation_fingerprint: recompiledValidation.fingerprint ?? "",
        validation_issues: structuralFindings(recompiledValidation.issues),
        materialized_full_result_matches_sealed: materializedFullResultMatchesSealed,
        materialized_inspection_lots_match_sealed: materializedInspectionLotsMatchSealed,
        materialized_inspection_lots_difference_count: materializedInspectionLotsDifferenceCount,
        materialized_inspection_lots_difference_examples: materializedInspectionLotsDifferenceExamples,
        materialized_inspection_lots_compatibility_normalized_match: materializedInspectionLotsCompatibilityNormalizedMatch,
      };
    } catch (error) {
      empty.selector_authoring_compatibility.compile_error = errorMessage(error);
      if (error instanceof TargetSelectorCompileError) {
        empty.selector_authoring_compatibility.compile_issues = structuralFindings(error.issues);
      }
    }
  } catch (error) {
    empty.fatal_error = errorMessage(error);
  } finally {
    try {
      empty.artifact_guard.after = await snapshotArtifacts(revisionRoot);
      empty.artifact_guard.unchanged = canonicalize(empty.artifact_guard.before)
        === canonicalize(empty.artifact_guard.after);
    } catch (error) {
      empty.artifact_guard.unchanged = false;
      empty.fatal_error ||= `Artifact guard failed: ${errorMessage(error)}`;
    }
  }
  return empty;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

async function main(): Promise<void> {
  const batchPath = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) {
    throw new Error("Usage: tsx audit-sealed-selector-compatibility.ts <batch.json> [output.json]");
  }
  const batch = await readJson<BatchReceipt>(batchPath);
  const sealedTargets = batch.targets.filter((target) => target.status === "sealed");
  const results: TargetAuditResult[] = [];
  for (const target of sealedTargets) {
    results.push(await auditTarget(target, batch, batchPath));
  }
  const reportPayload = {
    schema_version: "sealed-selector-compatibility-audit/v1",
    generated_at: new Date().toISOString(),
    policy: {
      read_only: true,
      sealed_revisions_mutated: false,
      existing_seals_revoked: false,
      legacy_unknown_sampling_roles_defaulted: false,
      legacy_unknown_sampling_roles_remain_actionable_findings: true,
      recompile_result_is_diagnostic_only: true,
    },
    source: {
      batch_path: batchPath,
      batch_sha256: sha256Text(await readFile(batchPath, "utf8")),
      batch_schema_version: batch.schema_version ?? "",
      job_id: batch.job_id,
      configured_target_count: batch.targets.length,
      sealed_target_count: sealedTargets.length,
      unsealed_target_count: batch.targets.length - sealedTargets.length,
    },
    summary: {
      audited_target_count: results.length,
      artifact_guard_unchanged_count: results.filter((row) => row.artifact_guard.unchanged).length,
      original_plan_current_validation_ok_count: results.filter((row) => row.legacy_plan.current_validation_ok).length,
      sealed_audit_status_counts: countBy(results.map((row) => row.legacy_plan.sealed_audit?.status ?? "not_run")),
      selector_source_schema_counts: countBy(results.map((row) => row.selector_authoring_compatibility.source_schema_version || "unknown")),
      targets_without_sampling_rules: results.filter((row) => row.selector_authoring_compatibility.sampling_rule_count === 0).length,
      targets_with_sampling_rules: results.filter((row) => row.selector_authoring_compatibility.sampling_rule_count > 0).length,
      targets_with_actionable_unknown_sampling_roles: results.filter((row) =>
        row.selector_authoring_compatibility.legacy_unknown_roles_left_actionable
      ).length,
      current_v8_recompile_success_count: results.filter((row) => row.current_v8_recompile.produced).length,
      current_v8_validation_ok_count: results.filter((row) => row.current_v8_recompile.validation_ok).length,
      current_v8_materialized_full_result_match_count: results.filter((row) =>
        row.current_v8_recompile.materialized_full_result_matches_sealed === true
      ).length,
      current_v8_materialized_full_result_mismatch_count: results.filter((row) =>
        row.current_v8_recompile.materialized_full_result_matches_sealed === false
      ).length,
      current_v8_materialized_inspection_lots_match_count: results.filter((row) =>
        row.current_v8_recompile.materialized_inspection_lots_match_sealed === true
      ).length,
      current_v8_materialized_inspection_lots_mismatch_count: results.filter((row) =>
        row.current_v8_recompile.materialized_inspection_lots_match_sealed === false
      ).length,
      current_v8_materialized_inspection_lots_compatibility_normalized_match_count: results.filter((row) =>
        row.current_v8_recompile.materialized_inspection_lots_compatibility_normalized_match === true
      ).length,
      current_v8_materialized_inspection_lots_compatibility_normalized_mismatch_count: results.filter((row) =>
        row.current_v8_recompile.materialized_inspection_lots_compatibility_normalized_match === false
      ).length,
      fatal_error_count: results.filter((row) => row.fatal_error).length,
    },
    targets: results,
  };
  const report = {
    ...reportPayload,
    report_fingerprint: sha256Text(canonicalize(reportPayload)),
  };
  const outputPath = resolve(
    process.argv[3]
      ?? resolve(dirname(dirname(dirname(dirname(batchPath)))), "output", "audits", "sealed-selector-compatibility.json"),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, prettyJson(report), { encoding: "utf8", flag: "w" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output_path: outputPath,
    report_fingerprint: report.report_fingerprint,
    summary: report.summary,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
