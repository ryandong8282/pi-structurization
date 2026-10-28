import { expect, test } from "vitest";
import { externalReferenceFieldPolicy } from "../src/external-reference-policy.js";
import type { EvidenceRecord } from "../src/contracts.js";

function row(cells: string[], columns = cells.map((_, i) => `列${i + 1}`)) {
  const text = cells.join(" | ");
  const record: EvidenceRecord = { evidence_id: "synthetic-row", kind: "table_row", role: "formal_table_row",
    locator: "synthetic:row", text, text_sha256: "test", requires_disposition: true,
    table_text_format: "cell_values_v1", row_index: 1, cells, columns };
  const at = (column: number) => {
    const start = cells.slice(0, column).reduce((n, cell) => n + cell.length + 3, 0);
    return { evidence_id: record.evidence_id, start, end: start + cells[column]!.length };
  };
  return { record, at, manifest: { evidence: [record] } };
}

test("same standard has independent allowance and acceptance-basis occurrences in one row", () => {
  const f = row(["允许偏差", "按 XQ 701-2001 执行", "验收依据", "按 XQ 701-2001 执行"]);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1)])).toEqual({ field: "allowable_deviation", literal_only: true });
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(3)])).toEqual({ field: "acceptance_basis", literal_only: false });
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1), f.at(3)]).literal_only).toBe(false);
});

test("real column labels classify separate cells without taking another column's role", () => {
  const f = row(["按 XQ 701 执行", "按 XQ 702 执行"], ["允许偏差(mm)", "验收依据"]);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(0)]).literal_only).toBe(true);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1)]).field).toBe("acceptance_basis");
});

test("an inherited form header cannot override the actual allowance row label", () => {
  const f = row(["质量检验标准或允许偏差", "参照 XQ 701 执行"], ["项目", "工程名称 / 验收依据"]);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1)]).literal_only).toBe(true);
});

test("a cited title containing allowance is not an allowance field", () => {
  const f = row(["参照《允许偏差试验标准》XQ 701", "按 XQ 702 执行"]);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1)]).literal_only).toBe(false);
});

test("missing, invalid and noncanonical coordinates cannot waive a content dependency", () => {
  const f = row(["允许偏差", "按 XQ 701 执行"]);
  expect(externalReferenceFieldPolicy(f.manifest, []).literal_only).toBe(false);
  expect(externalReferenceFieldPolicy(f.manifest, [{ ...f.at(1), end: 999 }]).literal_only).toBe(false);
  f.record.text = "unknown rendered layout";
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(1)]).literal_only).toBe(false);
});

test.each(["设计要求及规范规定", "质量检验标准"])("requirement column %s retains its citation literally", label => {
  const f = row(["按 XQ 701 执行"], [label]);
  expect(externalReferenceFieldPolicy(f.manifest, [f.at(0)]).literal_only).toBe(true);
});

function formRows() {
  const basis = row(["验收依据", "XQ 700-2001", "", ""]);
  const header = row(["类别", "验收项目", "设计要求及规范规定", "检查结果"]);
  const data = row(["主控项目", "试验构件", "按 XQ 701 执行", ""], ["单位名称 / 施工单位", "XQ 700-2001", "列3", "验收依据"]);
  const secondHeader = row(["类别", "验收项目", "验收依据", "检查结果"]);
  const secondData = row(["主控项目", "另一构件", "按 XQ 702 执行", ""], ["类别", "验收项目", "允许偏差", "检查结果"]);
  for (const [index, f] of [basis, header, data, secondHeader, secondData].entries()) {
    f.record.evidence_id = `form-row-${index}`;
    f.record.row_index = index + 1;
    f.record.table_id = "synthetic-form";
    f.record.table_fragment_id = "synthetic-fragment";
  }
  return { basis, header, data, secondHeader, secondData,
    manifest: { evidence: [basis.record, header.record, data.record, secondHeader.record, secondData.record] } };
}

test("canonical local table headers override stale administrative column labels, separately from the basis row", () => {
  const f = formRows();
  expect(externalReferenceFieldPolicy(f.manifest, [f.data.at(2)]).literal_only).toBe(true);
  expect(externalReferenceFieldPolicy(f.manifest, [f.basis.at(1)])).toEqual({ field: "acceptance_basis", literal_only: false });
  expect(externalReferenceFieldPolicy(f.manifest, [f.secondData.at(2)])).toEqual({ field: "acceptance_basis", literal_only: false });
});

test.each(["different_table", "different_fragment", "different_scope", "noncanonical", "later_header", "not_header"])("a header cannot classify a citation across an unproven boundary: %s", boundary => {
  const f = formRows();
  if (boundary === "different_table") f.header.record.table_id = "another-table";
  if (boundary === "different_fragment") f.header.record.table_fragment_id = "another-fragment";
  if (boundary === "different_scope") f.header.record.evidence_scope = "reference";
  if (boundary === "noncanonical") f.header.record.text = "unverified rendering";
  if (boundary === "later_header") f.header.record.row_index = 99;
  if (boundary === "not_header") {
    f.header.record.cells![1] = "普通说明";
    f.header.record.text = f.header.record.cells!.join(" | ");
  }
  expect(externalReferenceFieldPolicy(f.manifest, [f.data.at(2)]).literal_only).toBe(false);
});
