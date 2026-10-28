/**
 * Offline revalidation of saved target field bindings in an isolated workspace.
 * Usage: npx tsx scripts/replay-target-field-roles.ts <revision-dir> [...]
 * Replays the model's own draft, not expected answers; never writes the source job.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest } from "../src/contracts.js";
import { scanDocumentLedger, type DocumentLedger } from "../src/document-ledger.js";
import { ToolController } from "../src/tools.js";
import { RevisionWorkspace } from "../src/workspace.js";

assert(process.argv.length > 2, "Pass at least one saved revision directory");
const base = resolve(import.meta.dirname, "../../../data/target-field-role-replays");
await mkdir(base, { recursive: true });
const outputRoot = await mkdtemp(join(base, "replay-"));
const reports = [];
for (const argument of process.argv.slice(2)) {
  const source = resolve(argument);
  const originals = new Map<string, string>();
  async function original(path: string): Promise<string> {
    const text = await readFile(path, "utf8");
    originals.set(path, sha256Text(text));
    return text;
  }
  const evidence = JSON.parse(await original(join(source, "evidence/evidence.json"))) as EvidenceManifest;
  const markdown = await original(join(source, "evidence/source.md"));
  const selectorsText = await original(join(source, "working.target-selectors.json"));
  const selectors = JSON.parse(selectorsText);
  const registry = JSON.parse(await original(join(source, "source-span-registry.json")));
  const ledger = JSON.parse(await original(resolve(source, "../../../../discovery/document-ledger.json"))) as DocumentLedger;
  const rescanned = scanDocumentLedger(markdown, evidence.source.file_name);
  const workspace = await RevisionWorkspace.createFromEvidence(outputRoot, evidence.job_id, evidence.target_id, {
    manifest: evidence, markdown: Buffer.from(markdown),
  });
  await atomicWriteJson(workspace.sourceSpanRegistryPath, registry);
  await workspace.writeWorkingSelectors(selectorsText);
  // Retain the historical ledger too: resumed jobs must handle its stale hints.
  await atomicWriteJson(workspace.documentLedgerPath, ledger);
  const controller = await ToolController.create(workspace);
  const roleIssueMap = new Map<string, { code: string; path?: string }>();
  // Use the same bounded per-record writes as the tool contract; a whole
  // target can exceed the draft payload limit even when every record is valid.
  for (const item of selectors.items) {
    const response = await controller.dispatch("stage_target_selector_draft", { draft: { items: [item] } });
    const validation = response.local_validation as { issues?: Array<{ code: string; path?: string }> } | undefined;
    assert(validation?.issues, `Revalidation did not reach field checks: ${response.error ?? "unknown"}`);
    for (const issue of validation.issues.filter((issue) => issue.code.startsWith("selector_field_"))) {
      roleIssueMap.set(`${issue.code}:${issue.path}`, issue);
    }
  }
  const roleIssues = [...roleIssueMap.values()];
  const changedHints = ledger.clauses.flatMap((clause) => {
    const fresh = rescanned.clauses.find((candidate) => candidate.clause_id === clause.clause_id);
    return fresh && (fresh.method_line !== clause.method_line || fresh.quantity_line !== clause.quantity_line)
      ? [{ clause_id: clause.clause_id, before: { method_line: clause.method_line, quantity_line: clause.quantity_line },
          after: { method_line: fresh.method_line, quantity_line: fresh.quantity_line } }]
      : [];
  });
  for (const [path, hash] of originals) assert.equal(sha256Text(await readFile(path, "utf8")), hash, `Source changed: ${path}`);
  const report = { source, workspace: workspace.root, target_id: evidence.target_id,
    item_count: selectors.items.length, role_issues: roleIssues, changed_ledger_hints: changedHints,
    source_unchanged: true, live_model_used: false };
  await atomicWriteJson(join(workspace.root, "field-role-replay.json"), report);
  reports.push(report);
  console.log(JSON.stringify({ target_id: evidence.target_id, item_count: report.item_count,
    role_issue_count: roleIssues.length, source_unchanged: true, live_model_used: false }));
}
await atomicWriteJson(join(outputRoot, "report.json"), reports);
console.log(JSON.stringify({ output_root: outputRoot }));
