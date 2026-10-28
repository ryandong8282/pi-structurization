/** Offline replay: npx tsx scripts/replay-reference-catalog-spans.ts --revision <path> */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256Text } from "../src/canonical.js";
import { atomicWriteJson } from "../src/atomic.js";
import type { EvidenceManifest, RevisionState } from "../src/contracts.js";
import {
  materializeCoverageSpanBindings,
  validateCoverageReview,
  CoverageReviewController,
  type CoverageReviewScope,
  type DomainCoverageReview,
} from "../src/coverage-review.js";
import type { ReferenceCatalogRequest } from "../src/reference-analysis.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import { validateSemanticPlanViews } from "../src/validator.js";
import type { RevisionWorkspace } from "../src/workspace.js";

const argument = process.argv.indexOf("--revision");
assert(argument >= 0 && process.argv[argument + 1], "Pass --revision <saved revision directory>");
const root = resolve(process.argv[argument + 1]!);
const originals = new Map<string, string>();
async function source(path: string): Promise<string> {
  const content = await readFile(path, "utf8");
  originals.set(path, sha256Text(content));
  return content;
}
const state = JSON.parse(await source(join(root, "state.json"))) as RevisionState;
const manifest = JSON.parse(await source(join(root, "evidence/evidence.json"))) as EvidenceManifest;
const registry = JSON.parse(await source(join(root, "source-span-registry.json"))) as SourceSpanRegistry;
const fingerprint = state.last_valid_fingerprint;
const reviewRoot = join(root, "coverage-review", fingerprint);
const review = JSON.parse(await source(join(reviewRoot, "working.coverage-review.json"))) as DomainCoverageReview;
const reviewState = JSON.parse(await source(join(reviewRoot, "state.json"))) as { opened_evidence_ids: string[] };
const plan = validateSemanticPlanViews(await source(join(root, "last-valid.semantic-source-plan.json")), manifest, { expected_fingerprint: fingerprint });
assert(plan.ok, plan.ok ? "" : JSON.stringify(plan.issues));

interface ToolEvent {
  event_type: string;
  payload: {
    tool_name: string;
    input?: ReferenceCatalogRequest & { target_key: string };
    output?: { coverage_checkpoint?: {
      mode: CoverageReviewScope["mode"];
      required_item_ids: string[];
      uncovered_primary_evidence_ids: string[];
    } };
  };
}
const events = (await source(join(reviewRoot, "session.events.jsonl")))
  .split(/\r?\n/u)
  .filter((line) => line.includes('"event_type":"tool_execution_start"') || line.includes('"event_type":"tool_execution_end"'))
  .map((line) => JSON.parse(line) as ToolEvent);
const originalRequest = events.find((event) => event.event_type === "tool_execution_start"
  && event.payload.tool_name === "read_reference_facts" && event.payload.input?.resolve_rows?.length)?.payload.input;
assert(originalRequest, "Snapshot has no row-resolution request to replay");
const checkpoint = events.findLast((event) => event.payload.output?.coverage_checkpoint)?.payload.output?.coverage_checkpoint;
assert(checkpoint, "Snapshot has no recorded coverage checkpoint");
const scope: CoverageReviewScope = {
  mode: checkpoint.mode,
  affected_item_ids: checkpoint.required_item_ids,
  affected_evidence_ids: checkpoint.uncovered_primary_evidence_ids,
  finding_ids: review.findings.map((finding) => finding.finding_id),
};

// Target state stays in memory and review writes use a new isolated directory.
// Do not open the original workspace or start any provider/model session.
await mkdir(resolve(".tmp-tests"), { recursive: true });
const replayRoot = await mkdtemp(join(resolve(".tmp-tests"), "reference-catalog-span-replay-"));
const replayRevision = join(replayRoot, "revisions", "000001");
for (const [key, policy] of Object.entries(state.reference_analysis_modes ?? {})) {
  if (!key.startsWith("coverage:") || policy.analysis_mode !== "isolated") continue;
  const hash = key.split(":").at(-1)!;
  assert(/^[a-f0-9]{64}$/u.test(hash), "Unexpected reference target identity");
  const originalAnalysis = resolve(root, "..", "..", "reference-analysis", hash);
  const copiedAnalysis = join(replayRoot, "reference-analysis", hash);
  await mkdir(copiedAnalysis, { recursive: true });
  for (const file of ["state.json", "working.reference-facts.json", "reference-facts.json", "seal-receipt.json"]) {
    await atomicWriteJson(join(copiedAnalysis, file), JSON.parse(await source(join(originalAnalysis, file))));
  }
}
const workspace = {
  root: replayRevision,
  coverageReviewDirectory: join(replayRevision, "coverage-review"),
  lastValidPlanPath: join(root, "last-valid.semantic-source-plan.json"),
  readEvidenceManifest: async () => structuredClone(manifest),
  readState: async () => structuredClone(state),
  updateState: async (mutate: (current: RevisionState) => void) => { mutate(state); return structuredClone(state); },
  readSourceSpanRegistry: async () => structuredClone(registry),
  appendEvent: async () => undefined,
} as unknown as RevisionWorkspace;
const controller = await CoverageReviewController.create(workspace, fingerprint, scope);
await atomicWriteJson(controller.workingPath, review);
const initialReviewState = JSON.parse(await readFile(controller.statePath, "utf8"));
await atomicWriteJson(controller.statePath, { ...initialReviewState, opened_evidence_ids: reviewState.opened_evidence_ids });
const before = validateCoverageReview(review, fingerprint, manifest, new Set(reviewState.opened_evidence_ids), plan.value.semantic_plan, scope, registry);
const response = await controller.dispatch("read_reference_facts", { ...originalRequest });
assert(response.ok, JSON.stringify(response));
const rows = response.resolved_rows as Array<{ evidence_id: string; span_id: string }>;
const spanByEvidence = new Map(rows.map((row) => [row.evidence_id, row.span_id]));
const repaired = structuredClone(review);
const coverageUpserts: DomainCoverageReview["semantic_coverage"] = [];
const findingUpserts: DomainCoverageReview["findings"] = [];
let repairedBindings = 0;
let repairedFindings = 0;
for (const row of repaired.semantic_coverage) {
  let changed = false;
  for (const binding of row.evidence_bindings) {
    const spanId = spanByEvidence.get(binding.evidence_id);
    if (!binding.span_id && typeof binding.exact_fragment !== "string" && spanId) {
      binding.span_id = spanId;
      repairedBindings += 1;
      changed = true;
    }
  }
  if (changed) coverageUpserts.push(row);
}
for (const finding of repaired.findings) {
  const spanId = spanByEvidence.get(finding.evidence_id);
  if (!finding.span_id && typeof finding.exact_fragment !== "string" && spanId) {
    finding.span_id = spanId;
    repairedFindings += 1;
    findingUpserts.push(finding);
  }
}
const materialized = materializeCoverageSpanBindings(repaired, manifest, registry);
assert.deepEqual(materialized.issues, []);
const staged = await controller.dispatch("stage_coverage_review_draft", { semantic_coverage_upserts: coverageUpserts, finding_upserts: findingUpserts });
const currentReviewState = await controller.readState();
const after = validateCoverageReview(materialized.value, fingerprint, manifest, new Set(currentReviewState.opened_evidence_ids), plan.value.semantic_plan, scope, registry);
const sealed = staged.ready_for_seal === true && typeof staged.fingerprint === "string"
  ? await controller.dispatch("seal_coverage_review", { fingerprint: staged.fingerprint })
  : { ok: false, error: "review_not_ready" };
for (const [path, hash] of originals) assert.equal(sha256Text(await readFile(path, "utf8")), hash, `Original artifact changed: ${path}`);
const report = {
  mode: "offline-real-snapshot-replay",
  revision: root,
  requested_rows: originalRequest.resolve_rows!.length,
  returned_row_spans: rows.length,
  repaired_evidence_bindings: repairedBindings,
  repaired_finding_citations: repairedFindings,
  added_review_read_receipts: currentReviewState.opened_evidence_ids.filter((id) => !reviewState.opened_evidence_ids.includes(id)).length,
  additional_locate_calls: 0,
  before_valid: before.ok,
  before_issue_codes: [...new Set(before.issues.map((issue) => issue.code))],
  after_valid: after.ok,
  after_issues: after.issues,
  ready_for_seal: staged.ready_for_seal === true,
  review_sealed: sealed.ok === true,
  ...(!sealed.ok ? { seal_error: sealed } : {}),
  resulting_review_status: after.review?.status,
  business_findings_preserved: repaired.findings.map((finding) => ({ id: finding.finding_id, type: finding.finding_type })),
  originals_unchanged: true,
  provider_requests: 0,
  replay_directory: replayRoot,
};
await atomicWriteJson(join(replayRoot, "report.json"), report);
console.log(JSON.stringify(report, null, 2));
assert(after.ok, "Citation replay still has validation issues; inspect after_issues, do not declare the target approved");
assert.equal(staged.ready_for_seal, true, "Real review staging must reach ready_for_seal without bypassing validation");
assert.equal(sealed.ok, true, "The review must actually seal, retaining its blocking business findings");
