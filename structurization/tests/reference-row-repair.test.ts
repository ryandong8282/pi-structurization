import {expect, test} from "vitest";
import type {EvidenceManifest, EvidenceRecord} from "../src/contracts.js";
import {referenceRowRepairCandidates} from "../src/reference-row-repair.js";

function row(id: string, raw: boolean, line = 40, table = "A.2", index = 7): EvidenceRecord {
  return {evidence_id:id, kind:"table_row", role:"formal_table_row", locator:raw ? `line:${line}/table-row:${index}` : `line:${line}/table:${table}/row:${index}`,
    text:raw ? "<tr><td>12</td></tr>" : "整理后的检查项目，数值=12", text_sha256:"test", requires_disposition:false, table_id:table, row_index:index};
}
test.each(["A.2", "12.6"])("suggests only the unique allowed representation of the same physical row in table %s", table => {
  const manifest={evidence:[row("selected",false,40,table),row("allowed",true,40,table),row("other",true,80,table)]} as EvidenceManifest;
  const before=structuredClone(manifest);
  expect(referenceRowRepairCandidates(manifest,["selected"],["allowed","other"])).toEqual([{outside_evidence_id:"selected",allowed_evidence_id:"allowed",locator:"line:40/table-row:7"}]);
  expect(manifest).toEqual(before);
});
test("does not suggest similar text at another line, table, row or ambiguous coordinate", () => {
  const manifest={evidence:[row("selected",false),row("other-line",true,41),row("other-table",true,40,"B.2"),row("other-row",true,40,"A.2",8)]} as EvidenceManifest;
  expect(referenceRowRepairCandidates(manifest,["selected"],manifest.evidence.slice(1).map(r=>r.evidence_id))).toEqual([]);
  manifest.evidence.push(row("a",true),row("b",true));
  expect(referenceRowRepairCandidates(manifest,["selected"],["a","b"])).toEqual([]);
});
test("requires explicit and internally consistent coordinates", () => {
  const selected=row("selected",false); selected.row_index=8;
  const manifest={evidence:[selected,row("allowed",true)]} as EvidenceManifest;
  expect(referenceRowRepairCandidates(manifest,["selected"],["allowed"])).toEqual([]);
});
