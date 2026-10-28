import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
} from "../src/document-discovery.js";
import {
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { targetOwnScopeForTarget } from "../src/batch.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(projectRoot, "fixtures/real/GB_50202-2018.md");

describe("GB50202 subagent live replay packet", () => {
  test("prints the exact current 7.2 primary evidence packet for an external/subagent model boundary", async () => {
    const markdown = await readFile(fixturePath, "utf8");
    const document = buildDocumentEvidence(markdown, basename(fixturePath));
    const ledger = scanDocumentLedger(markdown, basename(fixturePath));
    const registry = registryWithFullSourceSpans(
      document.evidence_fingerprint,
      document.atoms.map((atom) => ({
        source_id: atom.atom_id,
        evidence_id: atom.atom_id,
        atom_id: atom.atom_id,
        text: atom.text,
      })),
    );
    const jobId = "subagent-live-gb50202";
    const prefilled = prefillDocumentSelectorsFromLedger(jobId, document.atoms, ledger, registry);
    const selectors = compileDocumentSelectors(approveScopeFixture(prefilled.selectors, prefilled.registry, document), prefilled.registry, document, jobId);
    const target = selectors.targets.find((candidate) => candidate.name === "排桩");
    expect(target).toBeDefined();
    const own = targetOwnScopeForTarget(target!, ledger, document.atoms);
    expect(own).toBeDefined();
    const manifest = (await buildAgentScopedEvidenceManifest(
      fixturePath,
      jobId,
      target!,
      document,
      undefined,
      own!,
    )).manifest;

    const primary = manifest.evidence.filter((record) =>
      record.evidence_scope === "primary" || record.requires_disposition
    );
    const packet = {
      schema_version: "gb50202-subagent-packet/v1",
      target: {
        id: target!.target_id,
        name: target!.name,
        start_line: own!.start_line,
        end_exclusive_line: own!.end_exclusive_line,
      },
      evidence_fingerprint: manifest.evidence_fingerprint,
      primary: primary.map((record) => ({
        evidence_id: record.evidence_id,
        clause_id: record.clause_id ?? "",
        role: record.role,
        kind: record.kind,
        table_id: record.table_id ?? "",
        table_row_kind: record.table_row_kind ?? "",
        row_index: record.row_index ?? null,
        locator: record.locator,
        requires_disposition: record.requires_disposition,
        text: record.text,
      })),
    };
    console.info(`GB50202_SUBAGENT_PACKET=${JSON.stringify(packet)}`);
    expect(packet.primary.filter((record) => record.role === "formal_table_row" && record.table_row_kind === "data"))
      .toHaveLength(59);
  }, 180_000);
});
