import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { prettyJson, sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  type AcceptanceItemPlan,
  type EvidenceManifest,
  type FieldSourceBinding,
  type SemanticSourcePlan,
} from "../src/contracts.js";
import { materialize } from "../src/materializer.js";
import { buildPlanContract } from "../src/source-plan-contract.js";
import { validatePlanText } from "../src/validator.js";

interface CorpusSource {
  source_id: string;
  role: "item" | "context";
  text: string;
}

interface CorpusItem {
  item_id: string;
  source_id: string;
  name: string;
  category: "主控项目" | "一般项目";
  requirement: string;
  method: string;
  quantity: string;
  must_preserve: string[];
}

interface CorpusDocument {
  document_id: string;
  semantic_suite: string;
  format: string;
  lot_name: string;
  sources: CorpusSource[];
  gold_items: CorpusItem[];
}

interface Corpus {
  schema_version: "inspection-point-name-corpus/v1";
  documents: CorpusDocument[];
}

function fieldBinding(
  value: string,
  evidenceId: string,
  exactFragment: string,
  composition: FieldSourceBinding["composition"],
): FieldSourceBinding {
  if (!value) {
    return {
      status: "not_applicable",
      composition: "not_applicable",
      evidence_ids: [],
      source_fragments: [],
      value_sha256: sha256Text(""),
      reason: "该字段在当前语义 gold 中不适用",
    };
  }
  return {
    status: "bound",
    composition,
    evidence_ids: [evidenceId],
    source_fragments: [{ evidence_id: evidenceId, text: exactFragment }],
    value_sha256: sha256Text(value),
    reason: composition === "semantic_summary"
      ? "名称是对象加核心质量特性的语义压缩，原文引用保持逐字精确"
      : "字段逐字来自当前证据",
  };
}

function manifestFor(document: CorpusDocument): EvidenceManifest {
  const evidence = document.sources.map((source, index) => ({
    evidence_id: `evidence:${document.document_id}:${source.source_id}`,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: `source:${index}`,
    text: source.text,
    text_sha256: sha256Text(source.text),
    requires_disposition: true,
  }));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: `job:${document.document_id}`,
    target_id: `target:${document.document_id}`,
    source: {
      adapter: "document-domain-agent/v1",
      file_name: `${document.document_id}.md`,
      sha256: sha256Text(document.sources.map((source) => source.text).join("\n")),
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "target_section",
      target_id: `target:${document.document_id}`,
      source_line_count: document.sources.reduce(
        (count, source) => count + source.text.split("\n").length,
        0,
      ),
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "",
      selection_reason: `跨文件语义 gold：${document.semantic_suite} / ${document.format}`,
      candidates: [],
      selected_atom_ids: document.sources
        .filter((source) => source.role === "item")
        .map((source) => `evidence:${document.document_id}:${source.source_id}`),
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`fingerprint:${document.document_id}`),
  };
}

function planFor(document: CorpusDocument, manifest: EvidenceManifest): SemanticSourcePlan {
  const evidenceBySource = new Map(
    document.sources.map((source) => [
      source.source_id,
      `evidence:${document.document_id}:${source.source_id}`,
    ]),
  );
  const sourceById = new Map(document.sources.map((source) => [source.source_id, source]));
  const acceptanceItems: AcceptanceItemPlan[] = document.gold_items.map((gold) => {
    const evidenceId = evidenceBySource.get(gold.source_id)!;
    const source = sourceById.get(gold.source_id)!;
    return {
      item_id: gold.item_id,
      lot_id: `lot:${document.document_id}`,
      name: gold.name,
      category: gold.category,
      requirement: gold.requirement,
      method: gold.method,
      quantity: gold.quantity,
      note: "",
      evidence_ids: [evidenceId],
      reference_evidence_ids: [],
      table_semantics: null,
      inspection_data_type: "review" as const,
      inspection_data_type_reason: "名称契约 fixture 不执行专业分类，保留为待复核。",
      inspection_data_type_evidence_ids: [evidenceId],
      field_bindings: {
        name: fieldBinding(gold.name, evidenceId, gold.requirement, "semantic_summary"),
        requirement: fieldBinding(gold.requirement, evidenceId, gold.requirement, "verbatim"),
        method: fieldBinding(gold.method, evidenceId, gold.method, "verbatim"),
        quantity: fieldBinding(gold.quantity, evidenceId, gold.quantity, "verbatim"),
        note: fieldBinding("", evidenceId, "", "not_applicable"),
      },
      sampling: {
        status: "not_sampling",
        min_sampling: "",
        script: "名称回归只验证字段职责；抽样决定不在此 fixture 的识别范围。",
        reason: "不以名称措辞推导抽样。",
        confidence: 1,
        evidence_ids: [],
      },
    };
  });
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    job_id: manifest.job_id,
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    table_assembly: {
      schema_version: "table-assembly-plan/v1",
      evidence_fingerprint: manifest.evidence_fingerprint,
      logical_tables: [],
      fragment_dispositions: [],
    },
    inspection_lots: [{
      lot_id: `lot:${document.document_id}`,
      name: document.lot_name,
      evidence_ids: [],
      item_ids: acceptanceItems.map((item) => item.item_id),
    }],
    acceptance_items: acceptanceItems,
    reference_resolutions: [],
    evidence_dispositions: document.sources.map((source) => ({
      evidence_id: evidenceBySource.get(source.source_id)!,
      disposition: source.role === "item" ? "used" as const : "context" as const,
      item_ids: source.role === "item"
        ? document.gold_items
          .filter((item) => item.source_id === source.source_id)
          .map((item) => item.item_id)
        : [],
      reason: source.role === "item"
        ? "语义 gold 证明该证据形成一个或多个独立可检验命题"
        : "施工过程前提仅作上下文，不因强制措辞生成验收叶项",
    })),
  };
}

describe("inspection-point name contract", () => {
  test("keeps cross-file semantic recall and exact evidence across format/OCR perturbations", async () => {
    const corpus = JSON.parse(await readFile(
      resolve("fixtures/inspection-point-name-corpus.json"),
      "utf8",
    )) as Corpus;
    expect(corpus.schema_version).toBe("inspection-point-name-corpus/v1");

    const suiteInventories = new Map<string, string[]>();
    for (const document of corpus.documents) {
      const manifest = manifestFor(document);
      const contractRules = buildPlanContract(manifest).rules.join("\n");
      expect(contractRules).toContain(
        "A short name never decides whether content is an item or whether two quality dimensions merge",
      );
      expect(contractRules).toContain("composition=semantic_summary");

      const sourcePlan = planFor(document, manifest);
      const validation = validatePlanText(
        prettyJson(sourcePlan),
        manifest,
        new Set(manifest.evidence.map((record) => record.evidence_id)),
      );
      expect(validation, document.document_id).toMatchObject({ ok: true, issues: [] });

      const result = materialize(
        sourcePlan,
        manifest,
        String(validation.fingerprint),
      ).result;
      const items = result.inspection_lots.flatMap((lot) => lot.items);
      expect(items.map((item) => item.item_id), document.document_id).toEqual(
        document.gold_items.map((item) => item.item_id),
      );
      expect(items.map((item) => item.name), document.document_id).toEqual(
        document.gold_items.map((item) => item.name),
      );

      for (const [index, gold] of document.gold_items.entries()) {
        const item = items[index]!;
        expect(item.requirement).toBe(gold.requirement);
        expect(item.method).toBe(gold.method);
        expect(item.quantity).toBe(gold.quantity);
        for (const token of gold.must_preserve) {
          expect(item.requirement).toContain(token);
        }
        const planItem = sourcePlan.acceptance_items[index]!;
        expect(planItem.field_bindings.name.composition).toBe("semantic_summary");
        expect(planItem.field_bindings.name.source_fragments).toEqual([{
          evidence_id: `evidence:${document.document_id}:${gold.source_id}`,
          text: gold.requirement,
        }]);
        for (const field of ["requirement", "method", "quantity", "note"] as const) {
          expect(planItem.field_bindings[field].composition).not.toBe("semantic_summary");
        }
      }

      const contextIds = new Set(
        document.sources
          .filter((source) => source.role === "context")
          .map((source) => `evidence:${document.document_id}:${source.source_id}`),
      );
      expect(items.flatMap((item) => item.evidence_ids).some((id) => contextIds.has(id))).toBe(false);
      suiteInventories.set(
        `${document.semantic_suite}:${document.format}`,
        items.map((item) => `${item.item_id}|${item.name}`),
      );
    }

    const weldingVariants = [...suiteInventories.entries()]
      .filter(([key]) => key.startsWith("welding-format-perturbation:"))
      .map(([, inventory]) => inventory);
    expect(weldingVariants).toHaveLength(3);
    expect(weldingVariants[1]).toEqual(weldingVariants[0]);
    expect(weldingVariants[2]).toEqual(weldingVariants[0]);
  });

  test("reserves semantic_summary for names without weakening lossless requirement fields", async () => {
    const corpus = JSON.parse(await readFile(
      resolve("fixtures/inspection-point-name-corpus.json"),
      "utf8",
    )) as Corpus;
    const document = corpus.documents[0]!;
    const manifest = manifestFor(document);
    const sourcePlan = planFor(document, manifest);
    sourcePlan.acceptance_items[0]!.field_bindings.requirement.composition = "semantic_summary";
    expect(validatePlanText(prettyJson(sourcePlan), manifest).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "semantic_summary_wrong_field" }),
      ]),
    );
  });

  test("allows the same concise business phrase as both name and requirement", () => {
    const document: CorpusDocument = {
      document_id: "concise-name-equals-requirement",
      semantic_suite: "concise-name-contract",
      format: "prose",
      lot_name: "基层检验批",
      sources: [{
        source_id: "flatness",
        role: "item",
        text: "基层表面平整度",
      }],
      gold_items: [{
        item_id: "base-surface-flatness",
        source_id: "flatness",
        name: "基层表面平整度",
        category: "一般项目",
        requirement: "基层表面平整度",
        method: "",
        quantity: "",
        must_preserve: ["基层表面平整度"],
      }],
    };
    const manifest = manifestFor(document);
    const sourcePlan = planFor(document, manifest);
    expect(validatePlanText(prettyJson(sourcePlan), manifest)).toEqual(
      expect.objectContaining({ ok: true, issues: [] }),
    );
  });
});
