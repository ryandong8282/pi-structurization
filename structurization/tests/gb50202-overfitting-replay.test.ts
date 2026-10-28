import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { EvidenceManifest } from "../src/contracts.js";
import {
  compileTargetSelectors,
  TargetSelectorCompileError,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";

const regressionRoot = join(process.cwd(), "data", "selector-regression");

interface ReplayRevision {
  run: string;
  target: string;
  revision: string;
  root: string;
}

async function gb50202Revisions(): Promise<ReplayRevision[]> {
  const revisions: ReplayRevision[] = [];
  for (const run of (await readdir(regressionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const jobsRoot = join(regressionRoot, run.name, "artifacts", "jobs");
    if (!existsSync(jobsRoot)) continue;
    for (const job of (await readdir(jobsRoot, { withFileTypes: true })).filter((entry) => (
      entry.isDirectory() && entry.name.toLowerCase().endsWith("-gb50202")
    ))) {
      const targetsRoot = join(jobsRoot, job.name, "targets");
      for (const target of (await readdir(targetsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
        const targetRevisionsRoot = join(targetsRoot, target.name, "revisions");
        for (const revision of (await readdir(targetRevisionsRoot, { withFileTypes: true })).filter((entry) => (
          entry.isDirectory() && /^\d{6}$/.test(entry.name)
        ))) {
          const root = join(targetRevisionsRoot, revision.name);
          if (
            existsSync(join(root, "target-selectors.json"))
            && existsSync(join(root, "source-span-registry.json"))
            && existsSync(join(root, "evidence", "evidence.json"))
          ) {
            revisions.push({ run: run.name, target: target.name, revision: revision.name, root });
          }
        }
      }
    }
  }
  return revisions.sort((left, right) => left.root.localeCompare(right.root));
}

describe("read-only GB50202 selector counterexample scan", () => {
  test.runIf(existsSync(regressionRoot))("runs every locally persisted GB50202 selector through the current compiler", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const replay of await gb50202Revisions()) {
      const [selectors, registry, manifest] = await Promise.all([
        readFile(join(replay.root, "target-selectors.json"), "utf8").then(JSON.parse) as Promise<TargetSelectorPlan>,
        readFile(join(replay.root, "source-span-registry.json"), "utf8").then(JSON.parse) as Promise<SourceSpanRegistry>,
        readFile(join(replay.root, "evidence", "evidence.json"), "utf8").then(JSON.parse) as Promise<EvidenceManifest>,
      ]);
      try {
        const compiled = compileTargetSelectors(selectors, registry, manifest);
        rows.push({
          run: replay.run,
          target: replay.target,
          revision: replay.revision,
          compile_ok: true,
          item_count: compiled.acceptance_items.length,
          issues: [],
        });
      } catch (error) {
        if (!(error instanceof TargetSelectorCompileError)) throw error;
        const spans = new Map(registry.spans.map((span) => [span.span_id, span]));
        const evidence = new Map(manifest.evidence.map((record) => [record.evidence_id, record.text]));
        rows.push({
          run: replay.run,
          target: replay.target,
          revision: replay.revision,
          compile_ok: false,
          item_count: selectors.items.length,
          issues: error.issues.map((issue) => {
            const itemIndex = /^\/items\/(\d+)/.exec(issue.path)?.[1];
            const item = itemIndex === undefined ? undefined : selectors.items[Number(itemIndex)];
            const details = issue.details as { offending_binding?: { span_id?: string } } | undefined;
            const spanId = details?.offending_binding?.span_id ?? "";
            const span = spanId ? spans.get(spanId) : undefined;
            return {
              code: issue.code,
              path: issue.path,
              item_key: item?.key ?? "",
              item_name: item?.name ?? "",
              span_id: spanId,
              span_text: span ? evidence.get(span.evidence_id)?.slice(span.start, span.end) ?? "" : "",
              details: issue.details,
            };
          }),
        });
      }
    }
    const summary = rows.map((row) => {
      const issues = row.issues as Array<Record<string, unknown>>;
      const issueCounts = issues.reduce<Record<string, number>>((counts, issue) => {
        const code = String(issue.code);
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {});
      return {
        run: row.run,
        target: row.target,
        revision: row.revision,
        compile_ok: row.compile_ok,
        item_count: row.item_count,
        issue_counts: issueCounts,
        samples: issues.slice(0, 5).map((issue) => ({
          code: issue.code,
          path: issue.path,
          item_key: issue.item_key,
          item_name: issue.item_name,
          span_text: issue.span_text,
        })),
      };
    });
    console.info(`GB50202_OVERFITTING_SCAN=${JSON.stringify(summary)}`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });
});
