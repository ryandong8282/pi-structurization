import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import type {
  EvidenceManifest,
  MaterializedAcceptanceItem,
  TableCriterionSemantics,
} from "../src/contracts.js";
import {
  buildAgentScopedEvidenceManifest,
  buildDocumentEvidence,
} from "../src/document-discovery.js";
import {
  evaluateTargetLedgerCoverage,
  prefillDocumentSelectorsFromLedger,
  scanDocumentLedger,
} from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { targetOwnScopeForTarget } from "../src/batch.js";
import { deriveCoverageRiskGate } from "../src/coverage-risk-gate.js";
import { createCoverageReviewTools } from "../src/coverage-review.js";
import { COVERAGE_REVIEW_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { SOURCE_HANDLE_INSTRUCTION } from "../src/model-source-handles.js";
import { PiSessionTelemetry } from "../src/session-telemetry.js";

const projectRoot = resolve(process.env.PDF_EX_CODEX_ROOT ?? process.cwd());

const cases = [
  {
    id: "GB 50204-2015",
    markdown: "markdown/02_GB_50204-2015_混凝土结构工程施工质量验收规范.md",
    pdf: "pdf/GB 50204-2015 混凝土结构工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50205-2020",
    markdown: "markdown/03_GB_50205-2020_钢结构工程施工质量验收标准.md",
    pdf: "pdf/GB 50205-2020 钢结构工程施工质量验收标准.pdf",
  },
  {
    id: "GB 50243-2016",
    markdown: "markdown/10_GB_50243-2016_通风与空调工程施工质量验收规范.md",
    pdf: "pdf/GB 50243-2016 通风与空调工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50310-2002",
    markdown: "markdown/12_GB_50310-2002_电梯工程施工质量验收规范.md",
    pdf: "pdf/GB 50310-2002 电梯工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50339-2013",
    markdown: "markdown/13_GB_50339-2013_智能建筑工程质量验收规范.md",
    pdf: "pdf/GB 50339-2013 智能建筑工程质量验收规范.pdf",
  },
  {
    id: "GB 50576-2010",
    markdown: "markdown/15_GB_50576-2010_铝合金结构工程施工质量验收规范.md",
    pdf: "pdf/GB 50576-2010 铝合金结构工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50628-2010",
    markdown: "markdown/17_GB_50628-2010_钢管混凝土工程施工质量验收规范.md",
    pdf: "pdf/GB 50628-2010 钢管混凝土工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50207-2012",
    markdown: "markdown/05_GB_50207-2012_屋面工程质量验收规范.md",
    pdf: "pdf/GB 50207-2012 屋面工程质量验收规范.pdf",
  },
  {
    id: "GB 50208-2011",
    markdown: "markdown/06_GB_50208-2011_地下防水工程质量验收规范.md",
    pdf: "pdf/GB 50208-2011 地下防水工程质量验收规范.pdf",
  },
  {
    id: "GB 50303-2015",
    markdown: "markdown/11_GB_50303-2015_建筑电气工程施工质量验收规范.md",
    pdf: "pdf/GB 50303-2015 建筑电气工程施工质量验收规范.pdf",
  },
  {
    id: "GB 50411-2019",
    markdown: "markdown/14_GB_50411-2019_建筑节能工程施工质量验收标准.md",
    pdf: "pdf/GB 50411-2019 建筑节能工程施工质量验收标准.pdf",
  },
  {
    id: "GB/T 50312-2016",
    markdown: "markdown/20_GB_T_50312-2016_综合布线系统工程验收规范.md",
    pdf: "pdf/GB／T 50312-2016 综合布线系统工程验收规范.pdf",
  },
] as const;

function utf8(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function reduction(before: number, after: number): number {
  return before === 0 ? 0 : Number((((before - after) / before) * 100).toFixed(1));
}

function directTableItem(
  specId: string,
  targetName: string,
  row: EvidenceManifest["evidence"][number],
  index: number,
): MaterializedAcceptanceItem {
  const tableId = row.table_id ?? "";
  const tableSemantics: TableCriterionSemantics = {
    source_kind: "direct",
    table_id: tableId,
    table_no: tableId,
    table_title: "",
    applicability: "",
    row_path: [`row:${row.row_index ?? index + 1}`],
    column_path: [],
    unit: "",
    condition: "",
    allowed_value: "",
    inspection_method: "",
    cell_evidence: [{
      role: "row_header",
      evidence_id: row.evidence_id,
      text: row.text.slice(0, Math.min(row.text.length, 120)),
    }],
    reference_fragments: [],
  };
  return {
    item_id: `multi-spec:${specId}:${targetName}:row:${String(index + 1).padStart(3, "0")}`,
    name: row.text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 90) || `表格行 ${index + 1}`,
    category: "一般项目",
    requirement: row.text,
    method: "",
    quantity: "",
    note: "",
    evidence_ids: [row.evidence_id],
    reference_evidence_ids: [],
    reference_resolution_ids: [],
    reference_origin_item_id: "",
    reference_path: [],
    source_clause: tableId || row.clause_id || "",
    reference_source_clause: "",
    reference_from_clause: "",
    table_semantics: tableSemantics,
    inspection_data_type: "measurement",
    inspection_data_type_reason: "Cross-spec benchmark represents one real formal table row as one final leaf solely to isolate Coverage Review routing cost.",
    inspection_data_type_evidence_ids: [row.evidence_id],
    sampling: {
      status: "not_sampling",
      min_sampling: "",
      script: "灰显",
      reason: "Cross-spec benchmark does not rerun semantic extraction or sampling inference.",
      confidence: 1,
      evidence_ids: [],
    },
  };
}

function providerToolSchemas(): unknown[] {
  return createCoverageReviewTools({} as never).map((tool) => {
    const row = tool as unknown as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: row.name,
        description: row.description,
        parameters: row.parameters,
      },
    };
  });
}

function wireTelemetry(
  mode: "full" | "risk_delta",
  targetName: string,
  items: MaterializedAcceptanceItem[],
  evidence: EvidenceManifest["evidence"],
): ReturnType<PiSessionTelemetry["snapshot"]> {
  const systemPrompt = `${COVERAGE_REVIEW_SYSTEM_PROMPT}\n\n${SOURCE_HANDLE_INSTRUCTION}`;
  const prompt = mode === "full"
    ? `Independently review target ${targetName} for lossless semantic coverage.`
    : `Review only deterministic risk_delta obligations for target ${targetName}.`;
  const telemetry = new PiSessionTelemetry(`coverage_review:${mode}:multi_spec_wire`, systemPrompt);
  telemetry.recordPrompt(prompt);
  const tools = providerToolSchemas();
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  const observe = () => telemetry.observeProviderRequest({
    model: "wire-emulation",
    messages,
    tools,
    max_tokens: 32_768,
  });
  const addTool = (name: string, args: Record<string, unknown>, result: unknown) => {
    const callId = `call-${messages.length}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    });
    const text = JSON.stringify(result);
    messages.push({ role: "tool", tool_call_id: callId, content: text });
    telemetry.recordToolResult(name, {
      content: [{ type: "text", text }],
      details: result,
    });
    observe();
  };

  observe();
  addTool("get_coverage_review_contract", {}, {
    ok: true,
    review_scope: {
      mode,
      affected_item_ids: items.map((item) => item.item_id),
      affected_evidence_ids: evidence.map((record) => record.evidence_id),
      finding_ids: [],
    },
    coverage_obligations: {
      mode,
      required_item_ids: items.map((item) => item.item_id),
      uncovered_primary_evidence_ids: evidence.map((record) => record.evidence_id),
      review_record_count: items.length + evidence.length,
      searchable_evidence_count: evidence.length,
    },
  });
  addTool("read_candidate_plan", { cursor: 0, max_items: 128 }, {
    ok: true,
    items: items.map((item) => ({
      item_id: item.item_id,
      name: item.name,
      category: item.category,
      source_clause: item.source_clause,
      evidence_ids: item.evidence_ids,
    })),
    next_cursor: null,
  });
  if (items.length > 0) {
    addTool("read_candidate_leaf_details", {
      item_ids: items.slice(0, 8).map((item) => item.item_id),
    }, {
      ok: true,
      items: items.slice(0, 8),
    });
  }
  addTool("batch_open_review_evidence", {
    evidence_ids: evidence.slice(0, 50).map((record) => record.evidence_id),
  }, {
    ok: true,
    evidence: evidence.slice(0, 50).map((record) => ({
      evidence_id: record.evidence_id,
      locator: record.locator,
      clause_id: record.clause_id,
      table_id: record.table_id,
      text: record.text,
    })),
  });
  return telemetry.snapshot();
}

describe("multi-spec Coverage Review risk gate benchmark", () => {
  // Private uploaded PDF/Markdown pairs remain in the consuming application.
  const sourcesAvailable = cases.every(spec => existsSync(resolve(projectRoot, spec.markdown)) && existsSync(resolve(projectRoot, spec.pdf)));
  test.skipIf(!sourcesAvailable)("samples representative newly uploaded specification pairs and measures risk_delta reduction", async () => {
    const reports: Array<Record<string, unknown>> = [];

    for (const spec of cases) {
      const markdownPath = resolve(projectRoot, spec.markdown);
      const pdfPath = resolve(projectRoot, spec.pdf);
      const [markdown, pdfStat] = await Promise.all([
        readFile(markdownPath, "utf8"),
        stat(pdfPath),
      ]);
      expect(pdfStat.size).toBeGreaterThan(0);

      const document = buildDocumentEvidence(markdown, basename(markdownPath));
      const ledger = scanDocumentLedger(markdown, basename(markdownPath));
      const registry = registryWithFullSourceSpans(
        document.evidence_fingerprint,
        document.atoms.map((atom) => ({
          source_id: atom.atom_id,
          evidence_id: atom.atom_id,
          atom_id: atom.atom_id,
          text: atom.text,
        })),
      );
      const jobId = `multi-spec-risk-${spec.id.replace(/[^A-Za-z0-9]+/gu, "-")}`;
      const prefilled = prefillDocumentSelectorsFromLedger(jobId, document.atoms, ledger, registry);
      let selectors: ReturnType<typeof compileDocumentSelectors>;
      try {
        selectors = compileDocumentSelectors(prefilled.selectors, prefilled.registry, document, jobId);
      } catch (error) {
        const issues = error && typeof error === "object" && "issues" in error
          ? (error as { issues?: unknown }).issues
          : undefined;
        reports.push({
          spec: spec.id,
          source_pair: {
            markdown: spec.markdown,
            pdf: spec.pdf,
            pdf_bytes: pdfStat.size,
          },
          recognition_status: "selector_compile_failed",
          document_probe: {
            atom_count: document.atoms.length,
            prefilled_target_count: prefilled.selectors.targets.length,
            ledger_anomaly_count: ledger.anomalies.length,
          },
          compile_issues: issues ?? [error instanceof Error ? error.message : String(error)],
          note: "The uploaded PDF/Markdown pair was present, but deterministic selector compilation could not produce a bounded target. This is a real recognition failure and is reported instead of aborting the remaining sample run.",
        });
        continue;
      }

      let best:
        | {
            target: typeof selectors.targets[number];
            own: NonNullable<ReturnType<typeof targetOwnScopeForTarget>>;
            manifest: EvidenceManifest;
            formalRows: EvidenceManifest["evidence"];
          }
        | undefined;

      for (const target of selectors.targets) {
        const own = targetOwnScopeForTarget(target, ledger, document.atoms);
        if (!own) continue;
        const manifest = (await buildAgentScopedEvidenceManifest(
          markdownPath,
          jobId,
          target,
          document,
          undefined,
          own,
        )).manifest;
        const formalRows = manifest.evidence.filter((record) =>
          record.role === "formal_table_row"
          && record.table_row_kind === "data"
          && record.evidence_scope === "primary"
        );
        if (
          !best
          || formalRows.length > best.formalRows.length
          || (
            formalRows.length === best.formalRows.length
            && manifest.evidence.length > best.manifest.evidence.length
          )
        ) {
          best = { target, own, manifest, formalRows };
        }
      }

      expect(best, `${spec.id} must produce at least one bounded target`).toBeDefined();

      const items = best!.formalRows.map((row, index) =>
        directTableItem(spec.id, best!.target.name, row, index)
      );
      const coverage = evaluateTargetLedgerCoverage({
        ledger,
        start_line: best!.own.start_line,
        end_exclusive_line: best!.own.end_exclusive_line,
        source_clauses: items.map((item) => item.source_clause),
        evidence: best!.manifest.evidence,
      });
      const scopeAnomalies = ledger.anomalies.filter((anomaly) =>
        anomaly.line >= best!.own.start_line && anomaly.line < best!.own.end_exclusive_line
      );
      const gate = deriveCoverageRiskGate({
        evidence: best!.manifest,
        items,
        ledger_available: true,
        ledger_scope_resolved: true,
        ledger_vacuous: coverage.vacuous,
        ledger_scope_has_anomalies: scopeAnomalies.length > 0,
        gap_clause_ids: coverage.gap_clause_ids,
        gap_evidence_ids: coverage.gap_evidence_ids,
        unaccounted_candidate_clause_ids: coverage.unaccounted_candidate_clause_ids,
      });

      const itemById = new Map(items.map((item) => [item.item_id, item]));
      const evidenceById = new Map(best!.manifest.evidence.map((record) => [record.evidence_id, record]));
      const riskItems = gate.scope.affected_item_ids
        .map((itemId) => itemById.get(itemId))
        .filter((item): item is MaterializedAcceptanceItem => Boolean(item));
      const riskEvidence = gate.scope.affected_evidence_ids
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter((record): record is EvidenceManifest["evidence"][number] => Boolean(record));
      const primaryEvidence = best!.manifest.evidence.filter((record) =>
        record.evidence_scope === "primary" || record.requires_disposition
      );

      const fullLeafBytes = utf8(items);
      const riskLeafBytes = utf8(riskItems);
      const fullSourceBytes = primaryEvidence.reduce((sum, record) => sum + utf8(record.text), 0);
      const riskSourceBytes = riskEvidence.reduce((sum, record) => sum + utf8(record.text), 0);
      const fullWorksetBytes = fullLeafBytes + fullSourceBytes;
      const riskWorksetBytes = riskLeafBytes + riskSourceBytes;
      const fullWire = wireTelemetry("full", best!.target.name, items, primaryEvidence);
      const riskWire = wireTelemetry("risk_delta", best!.target.name, riskItems, riskEvidence);

      reports.push({
        spec: spec.id,
        source_pair: {
          markdown: spec.markdown,
          pdf: spec.pdf,
          pdf_bytes: pdfStat.size,
        },
        selected_target: {
          name: best!.target.name,
          start_line: best!.own.start_line,
          end_exclusive_line: best!.own.end_exclusive_line,
        },
        source_scope: {
          evidence_count: best!.manifest.evidence.length,
          primary_evidence_count: primaryEvidence.length,
          formal_table_row_count: best!.formalRows.length,
          table_ids: [...new Set(best!.formalRows.map((row) => row.table_id).filter(Boolean))].sort(),
          parser_shape: best!.formalRows.length > 0
            ? "formal_table_rows_available"
            : "no_formal_table_rows_in_selected_target",
        },
        ledger: {
          gap_clause_ids: coverage.gap_clause_ids,
          unaccounted_candidate_clause_ids: coverage.unaccounted_candidate_clause_ids,
          anomaly_count: scopeAnomalies.length,
        },
        full_review: {
          leaf_count: items.length,
          workset_bytes: fullWorksetBytes,
          provider_request_peak_bytes: fullWire.provider_request_peak_utf8_bytes,
          tool_response_bytes: fullWire.tool_response_cumulative_utf8_bytes,
        },
        risk_delta: {
          leaf_count: riskItems.length,
          evidence_count: riskEvidence.length,
          workset_bytes: riskWorksetBytes,
          reason_codes: [...new Set(gate.reasons.map((reason) => reason.code))].sort(),
          provider_request_peak_bytes: riskWire.provider_request_peak_utf8_bytes,
          tool_response_bytes: riskWire.tool_response_cumulative_utf8_bytes,
        },
        reduction: {
          leaf_percent: reduction(items.length, riskItems.length),
          workset_percent: reduction(fullWorksetBytes, riskWorksetBytes),
          provider_request_peak_percent: reduction(
            fullWire.provider_request_peak_utf8_bytes,
            riskWire.provider_request_peak_utf8_bytes,
          ),
          tool_response_percent: reduction(
            fullWire.tool_response_cumulative_utf8_bytes,
            riskWire.tool_response_cumulative_utf8_bytes,
          ),
        },
        note: best!.formalRows.length > 0
          ? "Real uploaded Markdown parser/ledger/scope and real formal table-row evidence are used. PDF pairing is verified by file presence/size. Semantic extraction and live provider calls are not rerun; provider request bytes are production-shaped wire emulation, not provider token usage."
          : "This selected target produced no formal_table_row records in the current parser. The benchmark therefore measures source-evidence routing only and intentionally does not invent semantic final leaves. PDF pairing is verified, but semantic extraction/live provider calls are not rerun.",
      });
    }

    console.info(`MULTI_SPEC_COVERAGE_RISK_BENCHMARK=${JSON.stringify(reports)}`);
    expect(reports).toHaveLength(cases.length);
  }, 240_000);
});
