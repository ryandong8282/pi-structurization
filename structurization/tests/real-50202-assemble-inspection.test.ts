import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { scanDocumentLedger } from "../src/document-ledger.js";
import { assembleEditorHierarchyFromLedger, loadStandaloneSpecTree } from "../src/editor-hierarchy-assemble.js";
import { validateEditorHierarchyPlan } from "../src/editor-hierarchy.js";

const dir = "data/jobs/20260918-234108-7d3a/pi-agent/jobs/20260918-234108-7d3a/hierarchy";
const hasLocalData = existsSync(dir);

describe.skipIf(!hasLocalData)("real 50202 hierarchy assembly validation", () => {
  it("assembles real 50202 evidence with distinct authentic evidence fragments", async () => {
    const markdown = await readFile(dir + "/source.md", "utf8");
    const evidence = JSON.parse(await readFile(dir + "/editor-hierarchy-evidence.json", "utf8"));
    const ledger = scanDocumentLedger(markdown, "source.md");
    const specTree = await loadStandaloneSpecTree("d:/Dev/pdf_extractor/data/jobs/20260918-234108-7d3a");
    const result = assembleEditorHierarchyFromLedger({ evidence, ledger, specTree });

    expect(result.plan.nodes.length).toBeGreaterThan(10);
    expect(result.plan.lot_bindings.length).toBe(77);

    // Previously, 75 out of 77 lot_bindings had identical evidence fragment: '## 4.2 素土、灰土地基'
    // Now verify that lot bindings have multiple distinct evidence fragments corresponding to their real targets!
    const fragmentTexts = result.plan.lot_bindings.map((b) => b.evidence_fragments[0]?.text);
    const uniqueFragments = new Set(fragmentTexts);
    console.log(`[50202 Real Assembly] Unique lot evidence texts: ${uniqueFragments.size} across 77 lots`);
    expect(uniqueFragments.size).toBeGreaterThan(30);

    // Verify concrete non-4.2 lots have non-4.2 evidence
    const concreteLots = result.plan.lot_bindings.filter(
      (b) => !b.display_name.includes("素土") && !b.display_name.includes("灰土"),
    );
    for (const lot of concreteLots.slice(0, 10)) {
      const fragText = lot.evidence_fragments[0]?.text ?? "";
      expect(fragText).not.toContain("4.2 素土、灰土地基");
    }

    // Verify authority atoms are actually mapped to the used atoms across nodes and lots
    const authorityAtoms = result.plan.atom_dispositions.filter((a) => a.disposition === "hierarchy_authority");
    console.log(`[50202 Real Assembly] Authority atoms count: ${authorityAtoms.length}`);
    expect(authorityAtoms.length).toBeGreaterThan(15);

    // Verify initial validation issue is ONLY inspection_unit_coverage (draft awaiting semantic organization)
    const openedAtoms = new Set(evidence.document.atoms.map((a: { atom_id: string }) => a.atom_id));
    const openedLots = new Set(evidence.lots.map((l: { lot_key: string }) => l.lot_key));
    const validation = validateEditorHierarchyPlan(result.plan, evidence, openedAtoms, openedLots);
    const issueCodes = [...new Set(validation.issues.map((i) => i.code))];
    expect(issueCodes).toEqual(["inspection_unit_coverage"]);
  });
});
