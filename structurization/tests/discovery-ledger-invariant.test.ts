import { expect, test } from "vitest";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { evaluateDiscoveryLedgerAgreement, scanDocumentLedger } from "../src/document-ledger.js";
import { bindDiscoverySources } from "../src/discovery-source-bindings.js";
import { registryWithFullSourceSpans, sourceSpanCoveredBy, sourceSpanGaps } from "../src/source-span-registry.js";

test.each(["\n", "\r\n"])("global accounting requires the last character, but not a fictitious trailing empty line (%j)", (newline) => {
  const source = ["7.2.1 设备外壳应完整。", "检查数量：全数检查。", "检查方法：观察检查。", ""].join(newline);
  const evidence = buildDocumentEvidence(source, "synthetic.md");
  const ledger = scanDocumentLedger(source, "synthetic.md");
  const atom = evidence.atoms[0]!;
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, [{ source_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text }]);
  const open = new Set([atom.atom_id]);
  const bound = bindDiscoverySources([{ key: "clause", start_line: 1, extent: "clause" }], evidence, ledger, open, registry);
  expect(bindDiscoverySources([{ key: "clause", start_line: 1, end_exclusive_line: 4, extent: "clause" }], evidence, ledger, open, registry).aliases).toEqual(bound.aliases);
  const target = (end: number) => ({ target_id: "device", evidence_atom_ids: [atom.atom_id], work_scope: {
    start_line: 1, end_exclusive_line: atom.end_line + 1,
    primary_fragments: [{ atom_id: atom.atom_id, start: 0, end, text: source.slice(0, end), text_sha256: "fixture" }],
  } });
  const full = target(source.trimEnd().length);
  const short = target(source.trimEnd().length - 1);
  expect(evaluateDiscoveryLedgerAgreement({ targets: [full] }, ledger, evidence.atoms)).toMatchObject({ complete: true, uncovered_clause_ids: [] });
  expect(evaluateDiscoveryLedgerAgreement({ targets: [short] }, ledger, evidence.atoms)).toMatchObject({ complete: false, uncovered_clause_ids: ["7.2.1"] });
  expect(evaluateDiscoveryLedgerAgreement({ targets: [full, { ...full, target_id: "duplicate" }] }, ledger, evidence.atoms)).toMatchObject({ complete: false, overlapping_clause_ids: ["7.2.1"] });
});

test("gap diagnostics and coverage use the same source-coordinate accounting", () => {
  const target = { evidence_id: "source", start: 10, end: 30 };
  const ranges = [[18, 24], [10, 15], [27, 35], [13, 17]].map(([start, end]) => ({ evidence_id: "source", start: start!, end: end! }));
  expect(sourceSpanGaps(target, ranges)).toEqual([{ start: 17, end: 18 }, { start: 24, end: 27 }]);
  expect(sourceSpanCoveredBy(target, ranges)).toBe(false);
  expect(sourceSpanCoveredBy(target, [...ranges, { evidence_id: "other", start: 0, end: 40 }])).toBe(false);
  expect(sourceSpanGaps(target, [...ranges, { evidence_id: "source", start: 17, end: 27 }])).toEqual([]);
  expect(sourceSpanCoveredBy(target, [...ranges, { evidence_id: "source", start: 17, end: 27 }])).toBe(true);
});

test.each(["\n", "\r\n"])("source-bound semantic splits preserve complete coverage without hiding gaps or partial overlap (%j)", newline => {
  const source = ["# 12 检测设施", "## 12.2 外壳", "12.2.1 外壳应完整。", "检查数量：全数检查。", "12.3 接头", "12.3.1 接头应牢固。", "检查数量：全数检查。"].join(newline);
  const evidence = buildDocumentEvidence(source, "synthetic.md");
  const ledger = scanDocumentLedger(source, "synthetic.md");
  const atom = evidence.atoms[0]!;
  const boundary = source.indexOf("12.3 接头");
  const firstRequiredEnd = source.indexOf("检查数量：全数检查。") + "检查数量：全数检查。".length;
  const secondRequiredStart = source.indexOf("12.3.1");
  const target = (id: string, start: number, end: number) => ({ target_id: id, evidence_atom_ids: [atom.atom_id], work_scope: {
    start_line: 1, end_exclusive_line: atom.end_line + 1,
    primary_fragments: [{ atom_id: atom.atom_id, start, end, text: source.slice(start, end), text_sha256: "fixture" }],
  } });
  const evaluate = (leftEnd: number, rightStart = boundary) => evaluateDiscoveryLedgerAgreement({ targets: [target("shell", 0, leftEnd), target("joint", rightStart, source.length)] }, ledger, evidence.atoms);
  expect(evaluate(boundary)).toMatchObject({ complete: true, uncovered_clause_ids: [], overlapping_clause_ids: [], unclaimed_candidate_clause_ids: [] });
  // Flat headings are now recognized boundaries, not required text belonging
  // to the preceding clause. Exercise real missing/duplicated clause bytes,
  // independently of newline width and the intervening title.
  expect(evaluate(firstRequiredEnd - 1)).toMatchObject({ complete: false, uncovered_clause_ids: ["12.2.1"], unclaimed_candidate_clause_ids: ["12.2.1"] });
  expect(evaluate(secondRequiredStart + 2)).toMatchObject({ complete: false, overlapping_clause_ids: ["12.3.1"] });
});
