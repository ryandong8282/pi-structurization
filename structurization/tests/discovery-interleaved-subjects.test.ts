import { describe, expect, test } from "vitest";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors, discoveryScopeReviewHints, initialDocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";

describe("review hints for subjects interleaved inside one physical window", () => {
  test.each([7, 21])("shows actual clause owners and permits disjoint source blocks (chapter %i)", chapter => {
    const first = `${chapter}.2.1 装置甲的外壳应完整。`;
    const middle = `${chapter}.2.2 装置乙的接线应牢固。`;
    const last = `${chapter}.2.3 装置甲的标识应清晰。`;
    const source = `## ${chapter}.2 装置检验\n${first}\n${middle}\n${last}\n`;
    const evidence = buildDocumentEvidence(source, "synthetic.md");
    const atom = evidence.atoms[0]!;
    let registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [{ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }]);
    const full = registry.spans[0]!.span_id;
    const locate = (quote: string) => {
      const result = locateAndRegisterSourceQuote(registry, { source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }, quote);
      registry = result.registry;
      return result.spans[0]!.span_id;
    };
    const a = locate(first), b = locate(middle), a2 = locate(last), coarseB = locate(`${middle}\n${last}`);
    const block = (span: string) => ({ kind: "explicit_range" as const, anchor_span_id: span, start_span_id: span, end_span_id: span, reason: "作者确认的原文范围" });
    const selectors = initialDocumentSelectorPlan("job");
    selectors.targets = [["a", "装置甲", a], ["b", "装置乙", coarseB]].map(([key, name, span]) => ({
      key: key!, name: name!, group_key: "devices", group_name: "装置检验", group_reason: "同组不同对象",
      lot_basis_summary: "原文质量要求", scope_span_ids: [span!], source_blocks: [block(span!)], lot_basis_span_ids: [span!], reason: "具有直接质量判据",
      semantic_basis: { subject: name!, subject_kind: "product", acceptance_kind: "direct_criterion", acceptance_span_ids: [span!], acceptance_reason: "原文判据", boundary_reason: "按受检装置划分" },
    }));
    selectors.dispositions = [{ atom_span_id: full, disposition: "target", target_keys: ["a", "b"], reason: "两种装置共处本节" }];
    const windows = [{ window_id: "shared", number: `${chapter}.2`, title: "装置检验", start_line: 1, end_exclusive_line: 5 }];
    const ledger = scanDocumentLedger(source, "synthetic.md");
    const hints = () => discoveryScopeReviewHints(compileDocumentSelectors(selectors, registry, evidence, "job"), selectors, evidence, windows, ledger.clauses);
    const shared = hints().find(hint => hint.code === "candidate_window_shared_by_targets") as any;
    expect(shared).toMatchObject({ source_atom_ids: [atom.atom_id], targets: [
      { key: "a", semantic_basis: { subject: "装置甲" } }, { key: "b", semantic_basis: { subject: "装置乙" } },
    ], clause_owners: [{ clause_id: `${chapter}.2.1`, target_keys: ["a"] },
      { clause_id: `${chapter}.2.2`, target_keys: ["b"] }, { clause_id: `${chapter}.2.3`, target_keys: ["b"] }] });
    expect(shared.next_tools).toContain("edit_document_selectors");
    selectors.targets[0]!.source_blocks.push(block(a2));
    selectors.targets[0]!.scope_span_ids.push(a2);
    selectors.targets[1]!.source_blocks = [block(b)];
    selectors.targets[1]!.scope_span_ids = [b];
    selectors.targets[1]!.lot_basis_span_ids = [b];
    selectors.targets[1]!.semantic_basis!.acceptance_span_ids = [b];
    const corrected = hints().find(hint => hint.code === "candidate_window_shared_by_targets") as any;
    expect(corrected.clause_owners[2]).toMatchObject({ clause_id: `${chapter}.2.3`, target_keys: ["a"] });
    expect(corrected.targets[0].primary_ranges).toHaveLength(2);
  });
});
