import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { atomicWriteJson } from "../src/atomic.js";
import { prettyJson } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
} from "../src/document-discovery.js";
import {
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import {
  initialTargetSelectorPlan,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import { DIRECT_VALIDATION_PROTOCOL, ToolController } from "../src/tools.js";
import { targetOwnScopeForTarget } from "../src/batch.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { approveScopeFixture } from "./scope-fixture.js";

/**
 * 合成夹具：2.1 节三条，其中 2.1.1/2.1.2 带检验数量（底账必抽），2.1.3 普通条文。
 * 无表格、无引用，把 commit 预检链上的无关校验降到最少。
 */
const MARKDOWN = [
  "# 2 桩基检验",
  "",
  "## 2.1 桩基检验一般要求",
  "",
  "2.1.1 桩身承载力检验数量不应少于总桩数的2%，且不得少于3根。",
  "",
  "2.1.2 桩身完整性抽检数量不应少于总桩数的10%。",
  "",
  "2.1.3 桩基施工前应进行试成桩。",
  "",
].join("\n");

export async function buildSelectorStageScenario(markdownText = MARKDOWN) {
  const markdownPath = join(await mkdtemp(join(tmpdir(), "selector-stage-src-")), "selector-stage.md");
  await writeFile(markdownPath, markdownText, "utf8");
  const markdown = await readFile(markdownPath, "utf8");
  const document = buildDocumentEvidence(markdown, "selector-stage.md");
  const ledger = scanDocumentLedger(markdown, "selector-stage.md");
  const discoveryRegistry = registryWithFullSourceSpans(
    document.evidence_fingerprint,
    document.atoms.map((atom) => ({
      source_id: atom.atom_id,
      evidence_id: atom.atom_id,
      atom_id: atom.atom_id,
      text: atom.text,
    })),
  );
  const jobId = "selector-stage-fixture-job";
  const prefilled = prefillDocumentSelectorsFromLedger(jobId, document.atoms, ledger, discoveryRegistry);
  const targets = compileDocumentSelectors(
    approveScopeFixture(prefilled.selectors, prefilled.registry, document),
    prefilled.registry,
    document,
    jobId,
  );
  const target = targets.targets.find((candidate) =>
    (candidate.work_scope?.start_line ?? Number.MAX_SAFE_INTEGER) <= 5
  );
  if (!target) throw new Error(`No discovery target for section 2.1: ${JSON.stringify(targets.targets.map(t => t.name))}`);
  const own = targetOwnScopeForTarget(target, ledger, document.atoms);
  if (!own) throw new Error("No own scope for discovery target");
  const { manifest } = await buildAgentScopedEvidenceManifest(
    markdownPath,
    jobId,
    target,
    document,
    undefined,
    own,
  );

  const root = await mkdtemp(join(tmpdir(), "selector-stage-preflight-"));
  const workspace = await RevisionWorkspace.createFromEvidence(
    root,
    manifest.job_id,
    manifest.target_id,
    { manifest, markdown: Buffer.from(markdown, "utf8") },
  );
  await mkdir(dirname(workspace.documentLedgerPath), { recursive: true });
  await atomicWriteJson(workspace.documentLedgerPath, ledger);
  await atomicWriteJson(join(dirname(workspace.documentLedgerPath), "document-evidence.json"), document);
  await atomicWriteJson(workspace.batchTargetPath, {
    schema_version: "pi-batch/v1",
    targets: [{
      target_id: target.target_id,
      name: target.name,
      ledger_window_id: target.ledger_window_id ?? "",
      start_line: target.work_scope?.start_line,
      end_exclusive_line: target.work_scope?.end_exclusive_line,
      materialization: target.materialization,
      evidence_fragments: target.evidence_fragments,
      status: "running",
    }],
  });
  const controller = await ToolController.create(workspace);
  return { workspace, controller, manifest, ledger, target };
}

export function fullSpanFor(
  registry: Awaited<ReturnType<RevisionWorkspace["readSourceSpanRegistry"]>>,
  evidenceId: string,
  textLength: number,
): string {
  const span = registry.spans.find((candidate) =>
    candidate.evidence_id === evidenceId
    && candidate.start === 0
    && candidate.end === textLength
  );
  if (!span) throw new Error(`Missing full span for ${evidenceId}`);
  return span.span_id;
}

export function clauseRecord(manifest: EvidenceManifest, clauseId: string) {
  const prefix = new RegExp(`^${clauseId.replaceAll(".", "\\.")}\\s`, "u");
  const record = manifest.evidence.find((candidate) =>
    candidate.evidence_scope === "primary" && prefix.test(candidate.text)
  );
  if (!record) throw new Error(`Missing primary evidence for ${clauseId}`);
  return record;
}

export function itemRecord(
  key: string,
  name: string,
  category: "主控项目" | "一般项目",
  span: string,
  reason: string,
): TargetSelectorPlan["items"][number] {
  return {
    key,
    lot_key: "lot:2.1",
    name,
    category,
    criterion_span_ids: [span],
    continuation_span_ids: [],
    fields: {
      name: {
        composition: "semantic_summary" as const,
        span_ids: [span],
        separator: "" as const,
        reason,
      },
      requirement: {
        composition: "verbatim" as const,
        span_ids: [span],
        separator: "" as const,
        reason,
      },
      method: {
        composition: "not_applicable" as const,
        span_ids: [],
        separator: "" as const,
        reason: "夹具条文不含独立检验方法字段。",
      },
      quantity: {
        composition: "not_applicable" as const,
        span_ids: [],
        separator: "" as const,
        reason: "夹具条文不含独立数量字段。",
      },
      note: {
        composition: "not_applicable" as const,
        span_ids: [],
        separator: "" as const,
        reason: "夹具条目不使用备注。",
      },
    },
    inspection_data_type: "review" as const,
    inspection_data_type_reason: "夹具不建模测量类型。",
    inspection_data_type_span_ids: [span],
    table: null,
    sampling: {
      status: "fallback" as const,
      rule_key: "",
      branch_keys: [],
      quantity_span_ids: [],
      script_span_ids: [],
      condition_span_ids: [],
      reason: "夹具条目不带抽样语义。",
      confidence: 1,
    },
    reason,
  };
}

export function seedPlan(manifest: EvidenceManifest, span: string): TargetSelectorPlan {
  const selectors = initialTargetSelectorPlan(manifest);
  selectors.lots.push({
    key: "lot:2.1",
    name: "桩基检验一般要求",
    scope_span_ids: [],
    reason: "夹具检验批覆盖 2.1 节。",
  });
  selectors.items = [itemRecord(
    "item-2.1.3",
    "试成桩",
    "一般项目",
    span,
    "夹具基线条目锚定 2.1.3。",
  )];
  selectors.residual_source_dispositions = [{
    key: "remaining-primary",
    disposition: "context",
    reason: "未绑定到基线条目的正文保留为上下文。",
  }];
  return selectors;
}

export async function enterCommitStage(
  workspace: RevisionWorkspace,
): Promise<void> {
  await workspace.updateState((state) => {
    state.selector_stage = "commit";
    state.target_review_protocol = DIRECT_VALIDATION_PROTOCOL;
  });
}

export async function currentFingerprint(controller: ToolController): Promise<string> {
  const reply = await controller.dispatch("read_target_selectors", {}) as {
    summary?: { draft_fingerprint?: string };
  };
  const fingerprint = reply?.summary?.draft_fingerprint;
  if (!fingerprint) throw new Error(`Missing draft fingerprint: ${JSON.stringify(reply)}`);
  return fingerprint;
}
