import { describe, expect, test } from "vitest";

import {
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type TableAssemblyPlan,
} from "../src/contracts.js";
import { validateTableAssembly } from "../src/table-assembly.js";

function manifest(adapter: string): EvidenceManifest {
  return {
    source: {
      adapter,
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    evidence_fingerprint: "evidence-fingerprint",
    evidence: [{ evidence_id: "row-evidence" }],
    table_fragments: [{
      fragment_id: "fragment-adjacent-table",
      formal_row_evidence_ids: ["row-evidence"],
      title_candidate_evidence_ids: [],
      header_evidence_ids: [],
    }],
  } as unknown as EvidenceManifest;
}

const contextualAssembly: TableAssemblyPlan = {
  schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
  evidence_fingerprint: "evidence-fingerprint",
  logical_tables: [],
  fragment_dispositions: [{
    fragment_id: "fragment-adjacent-table",
    disposition: "context",
    logical_table_id: "",
    reason: "The domain Agent determined this physical table belongs to an adjacent target.",
  }],
};

describe("semantic table context disposition", () => {
  test("allows a domain Agent to exclude an adjacent formal table from this target", () => {
    expect(validateTableAssembly(
      contextualAssembly,
      manifest("document-domain-agent/v1"),
    )).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "formal_table_fragment_unassigned" }),
    ]));
  });

  test("keeps the strict formal-fragment gate for non-semantic legacy inputs", () => {
    expect(validateTableAssembly(
      contextualAssembly,
      manifest("target-section/v1"),
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "formal_table_fragment_unassigned" }),
    ]));
  });

  test("accepts uncolumned logical tables with immutable data rows", () => {
    const evidence = manifest("document-domain-agent/v1");
    evidence.evidence = [{
      evidence_id: "row-evidence",
      table_row_kind: "data",
      text: "轴线位置 | 5 | 尺量",
    }] as EvidenceManifest["evidence"];
    evidence.table_fragments[0] = {
      ...evidence.table_fragments[0]!,
      row_evidence_ids: ["row-evidence"],
      formal_row_evidence_ids: [],
    };
    const assembly: TableAssemblyPlan = {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [{
        logical_table_id: "logical-table",
        canonical_title: "现浇结构模板安装允许偏差",
        canonical_title_fragments: [],
        evidence_ids: ["row-evidence"],
        fragment_ids: ["fragment-adjacent-table"],
        reason: "表格具有数据行但没有主控/一般分栏。",
        confidence: 1,
      }],
      fragment_dispositions: [{
        fragment_id: "fragment-adjacent-table",
        disposition: "assigned",
        logical_table_id: "logical-table",
        reason: "数据行属于当前逻辑表。",
      }],
    };

    expect(validateTableAssembly(assembly, evidence)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "logical_table_without_formal_rows" }),
    ]));
  });

  test("accepts an exact same-atom fallback title when the parser registered no candidate", () => {
    const evidence = manifest("document-domain-agent/v1");
    evidence.evidence = [
      {
        evidence_id: "adjacent-title",
        atom_id: "atom:table-source",
        kind: "paragraph",
        role: "context",
        locator: "line:2",
        text: "额定载重量与轿厢最大有效面积之间关系",
        text_sha256: "title-sha",
        requires_disposition: true,
      },
      {
        evidence_id: "row-evidence",
        atom_id: "atom:table-source",
        kind: "table_row",
        role: "formal_table_row",
        locator: "line:4#row-1",
        text: "100 | 0.37",
        text_sha256: "row-sha",
        requires_disposition: true,
        table_row_kind: "data",
      },
    ];
    evidence.table_fragments[0] = {
      ...evidence.table_fragments[0]!,
      row_evidence_ids: ["row-evidence"],
      formal_row_evidence_ids: ["row-evidence"],
    };
    const assembly: TableAssemblyPlan = {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [{
        logical_table_id: "logical-table",
        canonical_title: "额定载重量与轿厢最大有效面积之间关系",
        canonical_title_fragments: [{ evidence_id: "adjacent-title", text: "额定载重量与轿厢最大有效面积之间关系" }],
        evidence_ids: ["adjacent-title", "row-evidence"],
        fragment_ids: ["fragment-adjacent-table"],
        reason: "模型根据相邻原文确认该完整段落是表题。",
        confidence: 1,
      }],
      fragment_dispositions: [{
        fragment_id: "fragment-adjacent-table",
        disposition: "assigned",
        logical_table_id: "logical-table",
        reason: "物理表属于该逻辑表。",
      }],
    };

    expect(validateTableAssembly(assembly, evidence)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_title_fragment_mismatch" }),
      expect.objectContaining({ code: "table_assembly_evidence_out_of_scope" }),
    ]));

    evidence.evidence[0]!.atom_id = "atom:unrelated";
    expect(validateTableAssembly(assembly, evidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_title_fragment_mismatch" }),
    ]));
  });

  test("does not require a fabricated title for a genuinely untitled physical table", () => {
    const evidence = manifest("document-domain-agent/v1");
    evidence.evidence = [{
      evidence_id: "row-evidence",
      atom_id: "atom:table-source",
      kind: "table_row",
      role: "formal_table_row",
      locator: "line:4#row-1",
      text: "100 | 0.37",
      text_sha256: "row-sha",
      requires_disposition: true,
      table_row_kind: "data",
    }];
    const assembly: TableAssemblyPlan = {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [{
        logical_table_id: "logical-table",
        canonical_title: "",
        canonical_title_fragments: [],
        evidence_ids: ["row-evidence"],
        fragment_ids: ["fragment-adjacent-table"],
        reason: "原文中没有表题，保持为空。",
        confidence: 1,
      }],
      fragment_dispositions: [{
        fragment_id: "fragment-adjacent-table",
        disposition: "assigned",
        logical_table_id: "logical-table",
        reason: "物理表属于该逻辑表。",
      }],
    };

    expect(validateTableAssembly(assembly, evidence)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_title_fragment_mismatch" }),
    ]));
  });

  test("allows distinct title fragments from the same immutable evidence atom", () => {
    const evidence: EvidenceManifest = {
      ...manifest("document-domain-agent/v1"),
      evidence: [{
        evidence_id: "title-evidence",
        text: "表 10.3.4 构件垂直度和\n侧向弯曲矢高允许偏差",
      }],
      table_fragments: [],
    } as unknown as EvidenceManifest;
    const assembly: TableAssemblyPlan = {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [{
        logical_table_id: "logical-table",
        canonical_title: "构件垂直度和侧向弯曲矢高允许偏差",
        canonical_title_fragments: [
          { evidence_id: "title-evidence", text: "构件垂直度和" },
          { evidence_id: "title-evidence", text: "侧向弯曲矢高允许偏差" },
        ],
        evidence_ids: ["title-evidence"],
        fragment_ids: [],
        reason: "原文标题在同一原子内换行",
        confidence: 1,
      }],
      fragment_dispositions: [],
    };

    expect(validateTableAssembly(assembly, evidence)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_table_title_fragment" }),
    ]));

    assembly.logical_tables[0]!.canonical_title_fragments.push({
      evidence_id: "title-evidence",
      text: "侧向弯曲矢高允许偏差",
    });
    expect(validateTableAssembly(assembly, evidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_table_title_fragment" }),
    ]));
  });

  test("accepts a continuation caption as structural provenance of its assigned fragment", () => {
    const evidence = manifest("document-domain-agent/v1");
    evidence.evidence = [
      { evidence_id: "title-evidence", text: "表 9.2.7 尺寸允许偏差" },
      { evidence_id: "continuation-evidence", text: "续表 9.2.7", role: "table_continuation_caption" },
      { evidence_id: "row-evidence", text: "长度 | ±5 | 尺量", table_row_kind: "data" },
    ] as EvidenceManifest["evidence"];
    evidence.table_fragments[0] = {
      ...evidence.table_fragments[0]!,
      title_candidate_evidence_ids: ["title-evidence"],
      continuation_caption_evidence_ids: ["continuation-evidence"],
      row_evidence_ids: ["row-evidence"],
      formal_row_evidence_ids: [],
    };
    const assembly: TableAssemblyPlan = {
      schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
      evidence_fingerprint: evidence.evidence_fingerprint,
      logical_tables: [{
        logical_table_id: "9.2.7",
        canonical_title: "表 9.2.7 尺寸允许偏差",
        canonical_title_fragments: [{ evidence_id: "title-evidence", text: "表 9.2.7 尺寸允许偏差" }],
        evidence_ids: ["title-evidence", "continuation-evidence"],
        fragment_ids: ["fragment-adjacent-table"],
        reason: "续表题注仅证明同一逻辑表连续性。",
        confidence: 1,
      }],
      fragment_dispositions: [{ fragment_id: "fragment-adjacent-table", disposition: "assigned", logical_table_id: "9.2.7", reason: "同一逻辑表。" }],
    };
    expect(validateTableAssembly(assembly, evidence)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "table_assembly_evidence_out_of_scope" }),
    ]));
  });
});
