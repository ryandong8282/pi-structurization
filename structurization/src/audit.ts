import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  atomicWriteNewJson,
  makeReadOnly,
  pathExists,
  readJson,
} from "./atomic.js";
import { canonicalize, prettyJson, sha256Json, sha256Text } from "./canonical.js";
import type {
  AcceptanceItemField,
  EvidenceManifest,
  SemanticSourcePlan,
} from "./contracts.js";
import { materialize } from "./materializer.js";
import { isCompactSemanticSourcePlan } from "./plan-hydration.js";
import { createPlanSourceResolver } from "./plan-source-resolver.js";
import type { SourceSpanIssue } from "./source-span-registry.js";
import { validatePlanText } from "./validator.js";
import type { RevisionWorkspace } from "./workspace.js";

export interface AuditFinding {
  finding_id: string;
  severity: "error" | "review";
  rule_id: string;
  message: string;
  item_id: string;
  field: AcceptanceItemField | "sampling" | "";
  evidence_ids: string[];
}

export interface AuditReceipt {
  schema_version: "sealed-plan-audit/v1";
  revision: number;
  job_id: string;
  target_id: string;
  status: "passed" | "review" | "failed";
  source_manifest_sha256: string;
  validation_fingerprint: string;
  findings: AuditFinding[];
  audit_fingerprint: string;
}

export interface RepairAction {
  action_id: string;
  route: "revise_plan" | "rebuild_evidence" | "manual_review";
  item_id: string;
  allowed_fields: Array<AcceptanceItemField | "sampling">;
  evidence_ids: string[];
  finding_ids: string[];
  reason: string;
}

function compactSourceSpanCatalogIsCompatible(
  sealedProvenanceText: string,
  replayProvenance: unknown,
  persistedPlan: unknown,
  evidence: EvidenceManifest,
): boolean {
  let sealedProvenance: unknown;
  try {
    sealedProvenance = JSON.parse(sealedProvenanceText);
  } catch {
    return false;
  }
  if (
    !isCompactSemanticSourcePlan(persistedPlan)
    || !sealedProvenance
    || typeof sealedProvenance !== "object"
    || Array.isArray(sealedProvenance)
    || !replayProvenance
    || typeof replayProvenance !== "object"
    || Array.isArray(replayProvenance)
  ) return false;
  const {
    source_spans: sealedSourceSpans,
    ...sealedWithoutSourceSpans
  } = sealedProvenance as Record<string, unknown>;
  if (
    sealedSourceSpans === undefined
    || canonicalize(sealedSourceSpans) !== canonicalize(persistedPlan.source_spans)
  ) return false;
  const spanIssues: SourceSpanIssue[] = [];
  const resolved = createPlanSourceResolver(persistedPlan, evidence).resolveMany(
    persistedPlan.source_spans.map((span) => span.span_id),
    "/source_spans",
    spanIssues,
  );
  return spanIssues.length === 0
    && resolved.length === persistedPlan.source_spans.length
    && canonicalize(sealedWithoutSourceSpans) === canonicalize(replayProvenance);
}

export interface BoundedRepairPlan {
  schema_version: "bounded-repair-plan/v1";
  source_audit_fingerprint: string;
  source_revision: number;
  creates_new_revision: true;
  max_rounds: 1;
  max_changes: number;
  actions: RepairAction[];
  repair_fingerprint: string;
}

interface SealedManifest {
  job_id: string;
  target_id: string;
  fingerprints: {
    files: Record<string, string>;
  };
}

function finding(
  severity: AuditFinding["severity"],
  ruleId: string,
  message: string,
  itemId = "",
  field: AuditFinding["field"] = "",
  evidenceIds: string[] = [],
): AuditFinding {
  const normalizedEvidence = [...new Set(evidenceIds)].sort();
  return {
    finding_id: `finding:${sha256Text(
      canonicalize({
        severity,
        rule_id: ruleId,
        message,
        item_id: itemId,
        field,
        evidence_ids: normalizedEvidence,
      }),
    )}`,
    severity,
    rule_id: ruleId,
    message,
    item_id: itemId,
    field,
    evidence_ids: normalizedEvidence,
  };
}

function itemTerms(name: string): string[] {
  const normalized = name.replace(/\s+/g, "");
  return [...new Set([
    normalized,
    ...normalized.split(/[\/、，,;；()（）]/),
  ].filter((part) => part.length >= 2))];
}

export function domainFindings(
  plan: SemanticSourcePlan,
  evidence: EvidenceManifest,
): AuditFinding[] {
  const recordsById = new Map(
    evidence.evidence.map((record) => [record.evidence_id, record]),
  );
  const explicitOccurrences = evidence.evidence.filter((record) =>
    record.sampling_occurrence?.kind === "explicit_quantity"
  );
  const findings: AuditFinding[] = [];
  for (const item of plan.acceptance_items) {
    if (item.sampling.status === "fallback") {
      const applicable = explicitOccurrences.filter((record) =>
        itemTerms(item.name).some((term) =>
          record.text.replace(/\s+/g, "").includes(term)
        )
      );
      if (applicable.length) {
        findings.push(finding(
          "review",
          "sampling.more_specific_occurrence",
          "当前使用兜底规则，但证据中存在与项目名称直接相交的显式数量 occurrence；应在新 revision 中核对适用条件。",
          item.item_id,
          "sampling",
          applicable.map((record) => record.evidence_id),
        ));
      }
    }
    if (item.sampling.status === "reference" || item.sampling.status === "reference_unspecified_quantity") {
      if (evidence.source.adapter === "document-domain-agent/v1") {
        continue;
      }
      const cited = item.sampling.evidence_ids.map((evidenceId) =>
        recordsById.get(evidenceId)
      );
      const hasReference = cited.some((record) =>
        record?.sampling_occurrence?.kind === "reference"
      );
      const resolvedExplicit = plan.reference_resolutions
        .filter((resolution) =>
          resolution.destination_bindings.some((destination) =>
            destination.item_id === item.item_id
            && destination.target_field === "sampling"
          )
        )
        .flatMap((resolution) => resolution.target_evidence_ids)
        .some((evidenceId) =>
          recordsById.get(evidenceId)?.sampling_occurrence?.kind
            === "explicit_quantity"
        );
      const requiresExplicitQuantityEndpoint = item.sampling.status === "reference";
      if (!hasReference || (requiresExplicitQuantityEndpoint && !resolvedExplicit)) {
        findings.push(finding(
          "review",
          "sampling.incomplete_reference_chain",
          "reference 抽样决策尚未同时证明引用起点和显式数量终点。",
          item.item_id,
          "sampling",
          item.sampling.evidence_ids,
        ));
      }
    }
  }
  return findings;
}

export async function auditSealedRevision(
  workspace: RevisionWorkspace,
): Promise<AuditReceipt> {
  const findings: AuditFinding[] = [];
  const evidence = await workspace.readEvidenceManifest();
  const manifestText = await readFile(workspace.manifestPath, "utf8");
  const sealedManifest = JSON.parse(manifestText) as SealedManifest;
  const sealedFiles: Record<string, string> = {
    "table-assembly-plan.json": workspace.tableAssemblyPlanPath,
    "semantic-source-plan.json": workspace.sealedPlanPath,
    "result.json": workspace.resultPath,
    "provenance.json": workspace.provenancePath,
    "seal-receipt.json": workspace.sealReceiptPath,
  };
  for (const [name, path] of Object.entries(sealedFiles)) {
    const actual = sha256Text(await readFile(path, "utf8"));
    const expected = sealedManifest.fingerprints.files[name];
    if (!expected || actual !== expected) {
      findings.push(finding(
        "error",
        "sealed.file_fingerprint",
        `封存文件 ${name} 的当前 hash 与 manifest 不一致。`,
      ));
    }
  }

  const planText = await readFile(workspace.sealedPlanPath, "utf8");
  const validation = validatePlanText(planText, evidence);
  if (!validation.ok || !validation.plan || !validation.fingerprint) {
    findings.push(...validation.issues.map((issue) =>
      finding(
        "error",
        `validator.${issue.code}`,
        `${issue.path}: ${issue.message}`,
      )
    ));
  } else {
    if (
      prettyJson(validation.plan.table_assembly)
      !== await readFile(workspace.tableAssemblyPlanPath, "utf8")
    ) {
      findings.push(finding(
        "error",
        "table_assembly.plan_relation",
        "独立封存的 table assembly 与 semantic source plan 中的语义组表决策不一致。",
      ));
    }
    const replay = materialize(
      validation.plan,
      evidence,
      validation.fingerprint,
    );
    const sealedResultText = await readFile(workspace.resultPath, "utf8");
    // The file is the untrusted subject of this audit. A damaged JSON/shape must
    // produce a replay finding, not crash while checking additive compatibility.
    const oldItems = new Map<string, { source_anchors?: unknown }>();
    try {
      const sealedResult = JSON.parse(sealedResultText);
      if (Array.isArray(sealedResult?.inspection_lots)) {
        for (const lot of sealedResult.inspection_lots) {
          if (!Array.isArray(lot?.items)) continue;
          for (const item of lot.items) {
            if (item && typeof item === "object" && typeof item.item_id === "string") {
              oldItems.set(item.item_id, item);
            }
          }
        }
      }
    } catch {
      // Invalid JSON cannot receive legacy compatibility; byte comparison below fails.
    }
    const compatibleReplay = structuredClone(replay.result);
    for (const lot of compatibleReplay.inspection_lots) for (const item of lot.items) {
      // Only an absent additive display field is compatible. Existing anchors,
      // source hashes, business facts, member counts and IDs remain checked.
      if (oldItems.has(item.item_id) && oldItems.get(item.item_id)!.source_anchors === undefined) delete item.source_anchors;
    }
    if (prettyJson(compatibleReplay) !== sealedResultText) {
      findings.push(finding(
        "error",
        "materializer.result_replay",
        "从封存 plan 重放生成的 result 与封存 result 字节不一致。",
      ));
    }
    const sealedProvenanceText = await readFile(workspace.provenancePath, "utf8");
    const provenanceMatches = prettyJson(replay.provenance) === sealedProvenanceText
      || compactSourceSpanCatalogIsCompatible(
        sealedProvenanceText,
        replay.provenance,
        validation.persisted_plan,
        evidence,
      );
    if (!provenanceMatches) {
      findings.push(finding(
        "error",
        "materializer.provenance_replay",
        "从封存 plan 重放生成的 provenance 与封存 provenance 字节不一致。",
      ));
    }
    findings.push(...domainFindings(validation.plan, evidence));
  }

  const status: AuditReceipt["status"] = findings.some((row) =>
    row.severity === "error"
  )
    ? "failed"
    : findings.length
      ? "review"
      : "passed";
  const payload = {
    schema_version: "sealed-plan-audit/v1" as const,
    revision: workspace.revision,
    job_id: sealedManifest.job_id,
    target_id: sealedManifest.target_id,
    status,
    source_manifest_sha256: sha256Text(manifestText),
    validation_fingerprint: validation.fingerprint ?? "",
    findings,
  };
  return {
    ...payload,
    audit_fingerprint: sha256Json(payload),
  };
}

export function buildBoundedRepairPlan(audit: AuditReceipt): BoundedRepairPlan {
  const grouped = new Map<string, AuditFinding[]>();
  for (const row of audit.findings) {
    const key = `${row.item_id}|${row.field}|${row.severity}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const actions: RepairAction[] = [...grouped.values()].map((rows) => {
    const first = rows[0]!;
    const allowedFields = first.field
      ? [first.field as AcceptanceItemField | "sampling"]
      : [];
    const route: RepairAction["route"] = first.rule_id.startsWith("validator.")
      || first.rule_id.startsWith("sampling.")
      ? "revise_plan"
      : first.rule_id === "sealed.file_fingerprint"
        ? "manual_review"
        : "rebuild_evidence";
    return {
      action_id: `repair:${sha256Text(rows.map((row) => row.finding_id).join("|"))}`,
      route,
      item_id: first.item_id,
      allowed_fields: allowedFields,
      evidence_ids: [...new Set(rows.flatMap((row) => row.evidence_ids))].sort(),
      finding_ids: rows.map((row) => row.finding_id).sort(),
      reason: rows.map((row) => row.message).join("；"),
    };
  });
  const payload = {
    schema_version: "bounded-repair-plan/v1" as const,
    source_audit_fingerprint: audit.audit_fingerprint,
    source_revision: audit.revision,
    creates_new_revision: true as const,
    max_rounds: 1 as const,
    max_changes: actions.length,
    actions,
  };
  return {
    ...payload,
    repair_fingerprint: sha256Json(payload),
  };
}

export async function persistAuditArtifacts(
  workspace: RevisionWorkspace,
  audit: AuditReceipt,
): Promise<{ audit_path: string; repair_plan_path: string }> {
  const targetRoot = dirname(dirname(workspace.root));
  const directory = join(
    targetRoot,
    "audits",
    `revision-${String(workspace.revision).padStart(6, "0")}`,
  );
  const auditPath = join(directory, `audit-${audit.audit_fingerprint}.json`);
  const repair = buildBoundedRepairPlan(audit);
  const repairPath = join(directory, `repair-${repair.repair_fingerprint}.json`);
  if (!(await pathExists(auditPath))) {
    await atomicWriteNewJson(auditPath, audit);
    await makeReadOnly(auditPath);
  }
  if (!(await pathExists(repairPath))) {
    await atomicWriteNewJson(repairPath, repair);
    await makeReadOnly(repairPath);
  }
  return { audit_path: auditPath, repair_plan_path: repairPath };
}

export async function auditAndPersist(
  workspace: RevisionWorkspace,
): Promise<{
  audit: AuditReceipt;
  repair: BoundedRepairPlan;
  paths: { audit_path: string; repair_plan_path: string };
}> {
  const audit = await auditSealedRevision(workspace);
  const repair = buildBoundedRepairPlan(audit);
  const paths = await persistAuditArtifacts(workspace, audit);
  return { audit, repair, paths };
}
