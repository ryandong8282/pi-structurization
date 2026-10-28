import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildDocumentEvidence, buildAgentScopedEvidenceManifest } from "../src/document-discovery.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { discoveryScopeWindows, prefillDocumentSelectorsFromLedger, scanDocumentLedger } from "../src/document-ledger.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { targetOwnScopeForTarget, targetPrimaryScope } from "../src/batch.js";

// Two repository fixtures and two existing local job artifacts. The latter are
// intentionally optional outside this workstation; synthetic boundary tests are
// always runnable. No original file, old job, model service or config is changed.
const samples = [
  ["GB50202", "fixtures/real/GB_50202-2018.md"],
  ["GB50310", "fixtures/real/GB_50310-2002.md"],
  ["GB50576", "data/jobs/20260826-182543-95c1/output/01_GB_50576-2010_铝合金结构工程施工质量验收规范.md"],
  ["GB50209", "data/jobs/20260810-090307-6b03/output/01_GB_50209-2010_建筑地面工程施工质量验收规范.md"],
] as const;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("real-file target scope matrix", () => {
  for (const [label, relativePath] of samples) {
    const path = resolve(projectRoot, relativePath);
    test.skipIf(!existsSync(path))(`${label}: all prefilled targets retain their own section without foreign primary prose/tables`, async () => {
      const markdown = await readFile(path, "utf8");
      const evidence = buildDocumentEvidence(markdown, basename(path));
      const ledger = scanDocumentLedger(markdown, basename(path));
      const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map((atom) => ({
        source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
      })));
      const jobId = `scope-matrix-${label}`;
      const prefilled = prefillDocumentSelectorsFromLedger(jobId, evidence.atoms, ledger, registry);
      const scopeWindows = discoveryScopeWindows(ledger);
      const plan = compileDocumentSelectors(
        approveScopeFixture(prefilled.selectors, prefilled.registry, evidence),
        prefilled.registry,
        evidence,
        jobId,
        { discoveryScopeCandidates: scopeWindows },
      );
      expect(plan.targets.length).toBeGreaterThan(0);
      let primaryRows = 0;
      let neutralRecords = 0;
      let delegatedScopes = 0;
      for (const target of plan.targets) {
        const window = scopeWindows.find((window) => target.materialization.lot_basis_fragments.some((fragment) =>
          fragment.text.trim() === window.heading_text.trim()
        ));
        expect(window, `${label}: no source window for ${target.name}`).toBeDefined();
        const own = targetOwnScopeForTarget(target, ledger, evidence.atoms)!;
        expect(own.start_line).toBe(window!.start_line);
        expect(own.end_exclusive_line).toBeGreaterThan(own.start_line);
        const manifest = (await buildAgentScopedEvidenceManifest(path, jobId, target, evidence, undefined, own)).manifest;
        expect(manifest.scope.selected_start_line).toBe(own.start_line);
        expect(manifest.scope.selected_end_exclusive_line).toBe(own.end_exclusive_line);
        const primary = manifest.evidence.filter((record) => record.requires_disposition || record.evidence_scope === "primary");
        const localTableIds = new Set(primary.filter((record) => {
          const line = Number(/^line:(\d+)/u.exec(record.locator)?.[1]);
          return record.table_id && line >= own.start_line && line < own.end_exclusive_line;
        }).map((record) => record.table_id));
        const foreign = primary.filter((record) => {
          const line = Number(/^line:(\d+)/u.exec(record.locator)?.[1]);
          const inside = line >= own.start_line && line < own.end_exclusive_line;
          const continuation = record.table_id && localTableIds.has(record.table_id);
          return !inside && !continuation;
        });
        expect(foreign.map((record) => ({ locator: record.locator, text: record.text.slice(0, 70) })),
          `${label}: foreign primary evidence in ${target.name}`).toEqual([]);
        primaryRows += primary.filter((record) => record.role === "formal_table_row").length;
        neutralRecords += manifest.evidence.length - primary.length;
        if (label === "GB50202" && target.name === "排桩") {
          expect(primary.filter((record) => record.role === "formal_table_row")).toHaveLength(59);
          expect([...localTableIds].sort()).toEqual(["7.2.10", "7.2.11", "7.2.6", "7.2.8", "7.2.9"]);
          const legacy = { ...target, ledger_window_id: window!.window_id, start_line: 871, end_exclusive_line: 919 };
          expect(targetPrimaryScope(legacy, ledger, evidence.atoms, [legacy])).toMatchObject(own);
        }
      }
      if (label === "GB50310") {
        // 11 + 11 + 3 independently named acceptance scopes. Seven are
        // single-clause delegations and must remain their own referenced targets.
        expect(scopeWindows).toHaveLength(25);
        expect(plan.targets).toHaveLength(25);
        const delegations = ledger.clauses.filter((clause) => clause.delegates_to_section);
        expect(delegations).toHaveLength(7);
        for (const clause of delegations) {
          const section = clause.clause_id.replace(/\.\d+$/u, "");
          const target = plan.targets.find((candidate) =>
            candidate.materialization.lot_basis_fragments.some((fragment) =>
              fragment.text.includes(`# ${section} `) || fragment.text.includes(`## ${section} `)
            )
          );
          expect(target, `${label}: delegated scope ${section} was not prefilled`).toBeDefined();
          delegatedScopes += 1;
        }
      }
      expect(await readFile(path, "utf8")).toBe(markdown);
      console.info(`${label}: ${plan.targets.length + delegatedScopes} target scopes verified (${delegatedScopes} delegated); ${primaryRows} formal rows; ${neutralRecords} retained reference/navigation records`);
    }, 180_000);
  }
});
