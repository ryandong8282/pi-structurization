import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  AcceptanceResult,
  EvidenceManifest,
  SemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import { validateSemanticPlanViews } from "../src/validator.js";

type JsonRecord = Record<string, unknown>;

interface BatchTarget extends JsonRecord {
  target_id: string;
  group_id?: string;
  group_name?: string;
  name?: string;
  status: "sealed" | "failed" | "running" | string;
  revision?: number;
  workdir: string;
  error?: string;
}

interface BatchFile extends JsonRecord {
  job_id: string;
  status: string;
  targets: BatchTarget[];
}

const PREVIEW_WARNING = [
  "人工预验收预览，不是正式 Gate 2 工件。",
  "UNSEALED/未封存 target 使用 latest durable last-valid candidate，必须标红人工复核。",
  "预览层级仅按已发现的语义 target/group 提供导航，不代表独立 hierarchy Agent 已复核。",
].join(" ");

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value: unknown): string {
  return sha256Text(canonical(value));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function atomicText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%", "_");
}

interface CoverageArtifact {
  plan_fingerprint: string;
  artifact_status: "sealed" | "validated" | "working";
  matches_current_plan: boolean;
  review: JsonRecord;
}

async function coverageReviews(
  revisionRoot: string,
  fingerprint: string,
): Promise<CoverageArtifact[]> {
  const root = join(revisionRoot, "coverage-review");
  if (!(await exists(root))) return [];
  const directories = await readdir(root, { withFileTypes: true });
  const artifacts: CoverageArtifact[] = [];
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    for (const [file, artifactStatus] of [
      ["coverage-review.json", "sealed"],
      ["last-valid.coverage-review.json", "validated"],
      ["working.coverage-review.json", "working"],
    ] as const) {
      const path = join(root, directory.name, file);
      if (!(await exists(path))) continue;
      artifacts.push({
        plan_fingerprint: directory.name,
        artifact_status: artifactStatus,
        matches_current_plan: directory.name === fingerprint,
        review: await readJson<JsonRecord>(path),
      });
      break;
    }
  }
  return artifacts.sort((left, right) =>
    Number(right.matches_current_plan) - Number(left.matches_current_plan)
    || ["sealed", "validated", "working"].indexOf(left.artifact_status)
      - ["sealed", "validated", "working"].indexOf(right.artifact_status)
    || left.plan_fingerprint.localeCompare(right.plan_fingerprint)
  );
}

function sourceBindings(
  item: SemanticSourcePlan["acceptance_items"][number] | undefined,
): JsonRecord {
  if (!item) return {};
  return Object.fromEntries(Object.entries(item.field_bindings).map(([field, binding]) => [
    field,
    {
      composition: binding.composition,
      reason: binding.reason,
      value_sha256: binding.value_sha256,
      exact_source_fragments: binding.source_fragments,
    },
  ]));
}

function evidenceDetails(
  evidence: EvidenceManifest,
  ids: readonly string[],
): JsonRecord[] {
  const byId = new Map(evidence.evidence.map((entry) => [entry.evidence_id, entry]));
  return [...new Set(ids)].flatMap((evidenceId) => {
    const entry = byId.get(evidenceId);
    return entry ? [{
      evidence_id: evidenceId,
      locator: entry.locator,
      evidence_scope: entry.evidence_scope ?? "",
      requires_disposition: entry.requires_disposition,
    }] : [];
  });
}

function markdownText(value: unknown): string {
  return String(value ?? "").replaceAll("\r", "").trim() || "（空）";
}

function confidenceLabel(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 0.8) return "高";
  if (number >= 0.5) return "中";
  return "低";
}

function cleanStandardIdentity(markdownName: string, prepared: JsonRecord): {
  standard_no: string;
  standard_name: string;
  source_pdf: string;
} {
  const withoutPrefix = markdownName.replace(/^\d+_/, "").replace(/\.md$/i, "");
  const match = withoutPrefix.match(/^([A-Za-z]+_[0-9]+-[0-9]+)_(.+)$/);
  const inferredNo = match?.[1]?.replace("_", " ") ?? String(prepared.standard_no ?? "");
  const inferredName = match?.[2] ?? String(prepared.standard_name ?? "");
  return {
    standard_no: inferredNo,
    standard_name: inferredName,
    source_pdf: `${inferredNo}${inferredName ? ` ${inferredName}` : ""}.pdf`,
  };
}

function editorPreview(
  jobId: string,
  targetPackages: JsonRecord[],
  standard: { standard_no: string; standard_name: string; source_pdf: string },
  markdownFile: string,
  pageCount: number,
): JsonRecord {
  let nextId = 1;
  const makeNode = (
    name: string,
    parentId: number,
    nodeType: string,
    type: number,
    extra: JsonRecord = {},
  ): JsonRecord & { children: JsonRecord[] } => ({
    id: nextId++,
    pid: parentId,
    name,
    type,
    type_name: nodeType === "单位" ? "分部" : nodeType,
    node_type: nodeType,
    standard_no: standard.standard_no,
    standard_name: standard.standard_name,
    ...extra,
    children: [],
  });
  const root = makeNode(
    standard.standard_no ? `${standard.standard_name}（${standard.standard_no}）` : standard.standard_name,
    0,
    "单位",
    3,
    {
      pi_source: "pi_agent_pdf_manual_preview",
      manual_preview: true,
      official_gate2_complete: false,
    },
  );
  const groupNodes = new Map<string, ReturnType<typeof makeNode>>();
  const chapters: JsonRecord[] = [];
  let lotCount = 0;
  let itemCount = 0;
  for (const target of targetPackages) {
    const groupId = String(target.group_id ?? "ungrouped");
    let group = groupNodes.get(groupId);
    if (!group) {
      group = makeNode(String(target.group_name ?? "未分组"), Number(root.id), "子分部", 2, {
        pi_source: "pi_agent_pdf_manual_preview",
        manual_preview: true,
        provisional_navigation_only: true,
      });
      root.children.push(group);
      groupNodes.set(groupId, group);
    }
    const sealed = target.gate_status === "sealed";
    const targetName = `${sealed ? "" : "🔴 [UNSEALED/未封存] "}${String(target.target_name ?? target.target_id)}`;
    const division = makeNode(targetName, Number(group.id), "分项", 1, {
      pi_target_id: target.target_id,
      pi_source: "pi_agent_pdf_manual_preview",
      manual_preview: true,
      manual_preview_gate_status: target.gate_status,
      manual_preview_status_color: sealed ? "green" : "red",
      official_gate2_eligible: sealed,
      provisional_navigation_only: true,
    });
    group.children.push(division);
    chapters.push({
      chapter_no: "",
      chapter_title: targetName,
      markdown_line: 0,
      pi_target_id: target.target_id,
      manual_preview_gate_status: target.gate_status,
    });
    for (const lot of target.inspection_lots as JsonRecord[]) {
      const lotNode = makeNode(String(lot.name ?? "检验批"), Number(division.id), "检验批", 0, {
        source_title: String(lot.name ?? ""),
        pi_target_id: target.target_id,
        pi_lot_id: lot.lot_id,
        pi_evidence_ids: lot.evidence_ids ?? [],
        pi_source: "pi_agent_pdf_manual_preview",
        manual_preview: true,
        manual_preview_gate_status: target.gate_status,
        official_gate2_eligible: sealed,
      });
      division.children.push(lotNode);
      lotCount += 1;
      const items = lot.items as JsonRecord[];
      for (let index = 0; index < items.length; index += 1) {
        const wrapped = items[index]!;
        const item = wrapped.materialized as JsonRecord;
        const sampling = item.sampling as JsonRecord;
        const table = item.table_semantics as JsonRecord | null;
        const minSampling = String(sampling.min_sampling ?? "").trim();
        const itemNode = makeNode(String(item.name ?? "验收项目"), Number(lotNode.id), "验收项目", 0, {
          item_no: index + 1,
          item_category: item.category ?? "",
          ...(table ? {
            table_no: String(table.table_no ?? "") || undefined,
            deviation_unit: String(table.unit ?? "") || undefined,
            pi_table_semantics: table,
          } : {}),
          deviation_value: String(item.requirement ?? ""),
          check_method: String(item.method ?? ""),
          params: String(item.quantity ?? ""),
          source_clause: String(item.source_clause ?? "") || undefined,
          reference_source_clause: String(item.reference_source_clause ?? "") || undefined,
          reference_from_clause: String(item.reference_from_clause ?? "") || undefined,
          min_sampling: minSampling || sampling.status === "not_sampling" ? minSampling || "不按数量抽样" : "",
          min_sampling_script: String(sampling.script ?? ""),
          min_sampling_reason: String(sampling.reason ?? ""),
          min_sampling_confidence: confidenceLabel(sampling.confidence),
          pi_item_id: item.item_id,
          pi_requirement: String(item.requirement ?? ""),
          pi_method: String(item.method ?? ""),
          pi_quantity: String(item.quantity ?? ""),
          pi_note: String(item.note ?? ""),
          inspection_data_type: item.inspection_data_type ?? "review",
          inspection_data_type_reason: item.inspection_data_type_reason ?? "",
          inspection_data_type_evidence_ids: item.inspection_data_type_evidence_ids ?? [],
          pi_evidence_ids: item.evidence_ids ?? [],
          pi_reference_evidence_ids: item.reference_evidence_ids ?? [],
          pi_reference_resolution_ids: item.reference_resolution_ids ?? [],
          pi_reference_origin_item_id: item.reference_origin_item_id ?? "",
          pi_reference_path: item.reference_path ?? [],
          pi_sampling: sampling,
          pi_source: "pi_agent_pdf_manual_preview",
          manual_preview: true,
          manual_preview_gate_status: target.gate_status,
          manual_preview_status_color: sealed ? "green" : "red",
          official_gate2_eligible: sealed,
          manual_review_provenance: wrapped.exact_field_provenance,
          manual_review_coverage_findings: wrapped.coverage_findings,
        });
        lotNode.children.push(itemNode);
        itemCount += 1;
      }
    }
  }
  const sealedCount = targetPackages.filter((target) => target.gate_status === "sealed").length;
  return {
    source_pdf: standard.source_pdf,
    standard_no: standard.standard_no,
    standard_name: standard.standard_name,
    extraction: {
      mode: "pi_agent_manual_preview",
      chapter_count: chapters.length,
      attached_chapter_count: chapters.length,
      pi_target_count: targetPackages.length,
      pi_inspection_lot_count: lotCount,
      pi_acceptance_item_count: itemCount,
      manual_preview: true,
      official_gate2_complete: false,
      sealed_target_count: sealedCount,
      unsealed_target_count: targetPackages.length - sealedCount,
    },
    chapters,
    tree: [root],
    page_count: pageCount,
    markdown_file: markdownFile,
    acceptance_item_engine: "pi_agent_pdf_manual_preview",
    manual_preview: {
      schema_version: "pi-editor-manual-preview/v1",
      warning: PREVIEW_WARNING,
      official_gate2_complete: false,
      sealed_target_count: sealedCount,
      unsealed_target_count: targetPackages.length - sealedCount,
    },
    pi_agent: {
      schema_version: "pdf-ex-code-pi-integration/v2",
      mode: "manual-preview",
      status: "partial_unsealed",
      official_gate2_complete: false,
      source_job_id: jobId,
      preview_manifest: "output/manual-review-preview/manifest.json",
    },
  };
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (!requested) {
    throw new Error("Usage: npx tsx scripts/build-partial-review-preview.ts <job-dir> [output-dir]");
  }
  const jobDir = resolve(requested);
  const jobId = basename(jobDir);
  const batchRoot = join(jobDir, "pi-agent", "jobs", encodedSegment(jobId));
  const batchPath = join(batchRoot, "batch.json");
  const aggregatePath = join(batchRoot, "result.json");
  const outputDir = resolve(process.argv[3] ?? join(jobDir, "output", "manual-review-preview"));
  const previewJobId = `${jobId}-manual-preview`;
  const previewJobDir = resolve(dirname(jobDir), previewJobId);
  const [batchText, aggregateText] = await Promise.all([
    readFile(batchPath, "utf8"),
    readFile(aggregatePath, "utf8"),
  ]);
  const batch = JSON.parse(batchText) as BatchFile;
  const sealedAggregate = JSON.parse(aggregateText) as JsonRecord & { targets: JsonRecord[] };
  if (batch.job_id !== jobId) throw new Error(`Batch job_id ${batch.job_id} does not match ${jobId}`);
  if (!Array.isArray(batch.targets) || !Array.isArray(sealedAggregate.targets)) {
    throw new Error("Invalid batch/result artifact shape");
  }
  const sealedById = new Map(sealedAggregate.targets.map((target) => [String(target.target_id), target]));
  const prepared = await readJson<JsonRecord>(join(jobDir, "pi-agent", "input.json"));
  const originalMeta = await readJson<JsonRecord>(join(jobDir, "meta.json"));
  const markdownRelative = String(prepared.markdown_file ?? "");
  const markdownSource = resolve(jobDir, markdownRelative);
  const markdownName = basename(markdownSource);
  const standard = cleanStandardIdentity(markdownName, prepared);
  const targetPackages: JsonRecord[] = [];
  const hierarchyGroups = new Map<string, JsonRecord & { targets: JsonRecord[] }>();
  const markdown: string[] = [
    `# ${jobId} 人工预验收包`,
    "",
    `> **警告：${PREVIEW_WARNING}**`,
    "",
  ];

  for (const target of batch.targets) {
    const revisionRoot = resolve(target.workdir);
    const [state, planSource, evidence, validationReceipt] = await Promise.all([
      readJson<JsonRecord>(join(revisionRoot, "state.json")),
      readFile(join(revisionRoot, "last-valid.semantic-source-plan.json"), "utf8"),
      readJson<EvidenceManifest>(join(revisionRoot, "evidence", "evidence.json")),
      readJson<JsonRecord>(join(revisionRoot, "validation-receipt.json")),
    ]);
    const fingerprint = String(state.last_valid_fingerprint ?? validationReceipt.validation_fingerprint ?? "");
    if (!fingerprint) {
      throw new Error(`Missing last-valid fingerprint for ${target.target_id}`);
    }
    const planViews = validateSemanticPlanViews(planSource, evidence, {
      expected_fingerprint: fingerprint,
    });
    if (!planViews.ok) {
      throw new Error(
        `Invalid last-valid plan for ${target.target_id}: ${JSON.stringify(planViews.issues)}`,
      );
    }
    const plan = planViews.value.semantic_plan;
    const candidate = materialize(
      planViews.value.persisted_plan,
      evidence,
      planViews.value.fingerprint,
    ).result;
    const sealed = target.status === "sealed";
    const aggregateTarget = sealedById.get(target.target_id);
    const candidateTarget = {
      target_id: target.target_id,
      target_definition: Object.fromEntries(Object.entries(target).filter(([key]) => [
        "target_id", "group_id", "group_name", "name", "description", "reason",
        "start_line", "end_exclusive_line", "evidence_atom_ids", "evidence_fragments",
      ].includes(key))),
      inspection_lots: candidate.inspection_lots,
    };
    const aggregateMatchesCandidate = sealed && aggregateTarget
      ? sha256Json(aggregateTarget.inspection_lots) === sha256Json(candidateTarget.inspection_lots)
      : false;
    if (sealed && !aggregateMatchesCandidate) {
      throw new Error(`Sealed aggregate drift for ${target.target_id}; preview assembly stopped`);
    }
    const reviewArtifacts = await coverageReviews(revisionRoot, fingerprint);
    const currentReviewArtifact = reviewArtifacts.find((artifact) => artifact.matches_current_plan);
    const review = currentReviewArtifact?.review;
    const findings = Array.isArray(review?.findings) ? review.findings as JsonRecord[] : [];
    const planItemById = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
    const semanticByItem = new Map<string, JsonRecord[]>();
    for (const node of plan.semantic_evidence ?? []) {
      if (!node.materialized_item_id) continue;
      semanticByItem.set(node.materialized_item_id, [
        ...(semanticByItem.get(node.materialized_item_id) ?? []),
        node as unknown as JsonRecord,
      ]);
    }
    const lots = candidate.inspection_lots.map((lot) => ({
      ...lot,
      items: lot.items.map((item) => {
        const sourceItem = planItemById.get(item.reference_origin_item_id) ?? planItemById.get(item.item_id);
        const itemFindings = findings.filter((finding) =>
          Array.isArray(finding.affected_item_ids)
          && finding.affected_item_ids.includes(item.item_id)
        );
        return {
          materialized: item,
          exact_field_provenance: sourceBindings(sourceItem),
          table_provenance: sourceItem?.table_semantics ? {
            cell_evidence: sourceItem.table_semantics.cell_evidence,
            reference_fragments: sourceItem.table_semantics.reference_fragments,
          } : null,
          semantic_evidence: semanticByItem.get(sourceItem?.item_id ?? item.item_id) ?? [],
          evidence_locators: evidenceDetails(evidence, [
            ...item.evidence_ids,
            ...item.reference_evidence_ids,
            ...item.sampling.evidence_ids,
          ]),
          coverage_findings: itemFindings,
        };
      }),
    }));
    const gate = sealed ? "sealed" : "UNSEALED";
    const targetPackage: JsonRecord = {
      target_id: target.target_id,
      target_name: target.name ?? target.target_id,
      group_id: target.group_id ?? "ungrouped",
      group_name: target.group_name ?? "未分组",
      gate_status: gate,
      status_color: sealed ? "green" : "red",
      official_gate2_eligible: sealed,
      candidate_only: !sealed,
      revision: target.revision ?? null,
      plan_fingerprint: fingerprint,
      strict_validation_ok: validationReceipt.ok === true,
      coverage_status: review?.status ?? "missing",
      coverage_artifact_status: currentReviewArtifact?.artifact_status ?? "missing_current_plan",
      coverage_summary: review?.summary ?? "",
      coverage_findings: findings,
      coverage_review_history: reviewArtifacts,
      terminal_error: sealed ? "" : target.error ?? "",
      revision_root: revisionRoot,
      inspection_lots: lots,
    };
    targetPackages.push(targetPackage);
    const groupKey = target.group_id ?? `group:${target.group_name ?? "ungrouped"}`;
    const group = hierarchyGroups.get(groupKey) ?? {
      group_id: groupKey,
      name: target.group_name ?? "未分组",
      provisional_navigation_only: true,
      targets: [],
    };
    group.targets.push({
      target_id: target.target_id,
      name: `${sealed ? "" : "[UNSEALED/未封存] "}${target.name ?? target.target_id}`,
      gate_status: gate,
      status_color: sealed ? "green" : "red",
      lots: candidate.inspection_lots.map((lot) => ({
        lot_id: lot.lot_id,
        name: lot.name,
        items: lot.items.map((item) => ({ item_id: item.item_id, name: item.name })),
      })),
    });
    hierarchyGroups.set(groupKey, group);

    markdown.push(
      `## ${sealed ? "✅ SEALED" : "🔴 UNSEALED / 未封存"} — ${markdownText(target.name ?? target.target_id)}`,
      "",
      `- Target: \`${target.target_id}\``,
      `- Revision: ${target.revision ?? "?"}`,
      `- Strict validation: ${validationReceipt.ok === true ? "通过" : "未通过"}`,
      `- Coverage: ${markdownText(review?.status ?? "missing")}`,
      `- Terminal error: ${sealed ? "（无）" : markdownText(target.error)}`,
      "",
    );
    for (const lot of lots) {
      markdown.push(`### 检验批：${markdownText(lot.name)}`, "");
      for (const wrapped of lot.items) {
        const item = wrapped.materialized;
        markdown.push(
          `#### ${sealed ? "" : "🔴 "}${markdownText(item.name)}`,
          "",
          `- 类别：${markdownText(item.category)}`,
          `- 验收要求：${markdownText(item.requirement)}`,
          `- 检验方法：${markdownText(item.method)}`,
          `- 检查数量：${markdownText(item.quantity)}`,
          `- 备注：${markdownText(item.note)}`,
          `- 抽样：${markdownText(item.sampling.script || item.sampling.min_sampling)}`,
          "- 精确字段出处：",
        );
        for (const [field, binding] of Object.entries(wrapped.exact_field_provenance)) {
          const fragments = (binding as JsonRecord).exact_source_fragments as Array<{ evidence_id: string; text: string }> | undefined;
          markdown.push(`  - ${field}:`);
          for (const fragment of fragments ?? []) {
            markdown.push(`    - \`${fragment.evidence_id}\`: ${markdownText(fragment.text)}`);
          }
        }
        if (wrapped.coverage_findings.length) {
          markdown.push("- Coverage findings:");
          for (const finding of wrapped.coverage_findings) {
            markdown.push(`  - **${markdownText(finding.finding_type)}**: ${markdownText(finding.description)}`);
          }
        }
        markdown.push("");
      }
    }
  }

  const sealedCount = targetPackages.filter((target) => target.gate_status === "sealed").length;
  const unsealedCount = targetPackages.length - sealedCount;
  const manifest = {
    schema_version: "pi-manual-review-preview/v1",
    job_id: jobId,
    generated_at: new Date().toISOString(),
    warning: PREVIEW_WARNING,
    official_gate2_complete: false,
    target_count: targetPackages.length,
    sealed_target_count: sealedCount,
    unsealed_target_count: unsealedCount,
    source_artifacts: {
      batch_file: batchPath,
      batch_sha256: sha256Text(batchText),
      sealed_aggregate_file: aggregatePath,
      sealed_aggregate_sha256: sha256Text(aggregateText),
    },
    files: {
      hierarchy: "preview-hierarchy.json",
      materialization: "preview-materialization.json",
      manual_review_json: "manual-review.json",
      manual_review_markdown: "manual-review.md",
    },
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    atomicJson(join(outputDir, "manifest.json"), manifest),
    atomicJson(join(outputDir, "preview-hierarchy.json"), {
      schema_version: "pi-preview-hierarchy/v1",
      job_id: jobId,
      warning: PREVIEW_WARNING,
      official_hierarchy_reviewed: false,
      groups: [...hierarchyGroups.values()],
    }),
    atomicJson(join(outputDir, "preview-materialization.json"), {
      schema_version: "pi-preview-materialization/v1",
      job_id: jobId,
      warning: PREVIEW_WARNING,
      official_gate2_complete: false,
      targets: targetPackages.map((target) => ({
        target_id: target.target_id,
        target_name: target.target_name,
        gate_status: target.gate_status,
        status_color: target.status_color,
        candidate_only: target.candidate_only,
        revision: target.revision,
        plan_fingerprint: target.plan_fingerprint,
        inspection_lots: (target.inspection_lots as JsonRecord[]).map((lot) => ({
          lot_id: lot.lot_id,
          name: lot.name,
          items: (lot.items as JsonRecord[]).map((item) => item.materialized),
        })),
      })),
    }),
    atomicJson(join(outputDir, "manual-review.json"), {
      ...manifest,
      targets: targetPackages,
    }),
    atomicText(join(outputDir, "manual-review.md"), `${markdown.join("\n")}\n`),
  ]);
  const editorStem = `${standard.standard_no.replaceAll(" ", "_")}_${standard.standard_name}_人工预验收`;
  const editorJsonName = `${editorStem}.json`;
  const editorResult = editorPreview(
    jobId,
    targetPackages,
    standard,
    markdownName,
    Number(prepared.page_count ?? 0),
  );
  const previewOutput = join(previewJobDir, "output");
  await mkdir(previewOutput, { recursive: true });
  await Promise.all([
    atomicJson(join(previewOutput, editorJsonName), editorResult),
    copyFile(markdownSource, join(previewOutput, markdownName)),
    cp(outputDir, join(previewOutput, "manual-review-preview"), { recursive: true, force: true }),
    exists(join(jobDir, "output", "images")).then((hasImages) => hasImages
      ? cp(join(jobDir, "output", "images"), join(previewOutput, "images"), { recursive: true, force: true })
      : undefined),
    exists(join(jobDir, "input.pdf")).then((hasPdf) => hasPdf
      ? copyFile(join(jobDir, "input.pdf"), join(previewJobDir, "input.pdf"))
      : undefined),
  ]);
  const generatedAt = new Date().toISOString();
  const input: JsonRecord = originalMeta.input && typeof originalMeta.input === "object"
    ? structuredClone(originalMeta.input as JsonRecord)
    : {};
  input.pdf_name = `${standard.standard_no} ${standard.standard_name}.pdf`;
  await atomicJson(join(previewJobDir, "meta.json"), {
    job_id: previewJobId,
    status: "succeeded",
    kind: "acceptance_pi",
    input,
    output: {
      stem: editorStem,
      markdown: markdownName,
      json: editorJsonName,
    },
    stages: [
      { key: "page_count", status: "done", finished_at: generatedAt, detail: `${Number(prepared.page_count ?? 0)} 页（复用源 job）` },
      { key: "mineru", status: "done", finished_at: generatedAt, detail: "复用源 job Markdown" },
      { key: "merge_markdown", status: "done", finished_at: generatedAt, detail: "复用源 job Markdown" },
      { key: "pi_target_discovery", status: "done", finished_at: generatedAt, items_total: targetPackages.length, detail: `复用源 job 的 ${targetPackages.length} 个 target` },
      { key: "pi_agent_extraction", status: "done", finished_at: generatedAt, items_total: targetPackages.length, items_done: sealedCount, detail: `人工预验收包组装完成：${sealedCount}/${targetPackages.length} sealed；${unsealedCount} 个候选标红待复核` },
      { key: "pi_editor_hierarchy", status: "skipped", finished_at: generatedAt, detail: "未运行正式 hierarchy Agent；使用 provisional preview navigation" },
      { key: "pi_result_materialization", status: "done", finished_at: generatedAt, detail: "已生成 editor-compatible 人工预览；不是正式 Gate 2 工件" },
    ],
    created_at: generatedAt,
    started_at: generatedAt,
    finished_at: generatedAt,
    manual_preview: {
      schema_version: "pi-manual-preview-job/v1",
      source_job_id: jobId,
      warning: PREVIEW_WARNING,
      official_gate2_complete: false,
      sealed_target_count: sealedCount,
      unsealed_target_count: unsealedCount,
      review_manifest: "output/manual-review-preview/manifest.json",
    },
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output_dir: outputDir,
    preview_job_dir: previewJobDir,
    editor_json: join(previewOutput, editorJsonName),
    sealed: sealedCount,
    unsealed: unsealedCount,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
