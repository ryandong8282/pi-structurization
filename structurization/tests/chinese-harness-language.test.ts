import { describe, expect, test } from "vitest";
import * as runtime from "../src/pi-runtime.js";
import * as suite from "../src/acceptance-prompt-suite.js";
import { MODEL_OUTPUT_LANGUAGE_GUIDANCE } from "../src/acceptance-delivery-contract.js";
import { createPiTools, type ToolController } from "../src/tools.js";
import { createDocumentDiscoveryTools, type DocumentDiscoveryController } from "../src/document-discovery.js";
import { createCoverageReviewTools, type CoverageReviewController } from "../src/coverage-review.js";
import { createReferenceAnalysisTools, type ReferenceAnalysisController } from "../src/reference-analysis.js";
import { createEditorHierarchyTools, type EditorHierarchyController } from "../src/editor-hierarchy.js";
import { createDocumentGraphTools } from "../src/document-graph/tools.js";
import type { DocumentGraphStore } from "../src/document-graph/store.js";
import type { SemanticGraphOverlayStore } from "../src/document-graph/overlay.js";
import { createExternalStandardReferenceTool } from "../src/external-standard-reference.js";

const chinese = /[\u3400-\u9fff]/u;

// Only construct metadata: none of these stubs can read files, call a model, or run a job.
function surfaces() {
  return [
    ...[false, true].flatMap(usesSelectorCompiler => createPiTools({ usesSelectorCompiler } as ToolController)),
    ...["candidate", "review"].flatMap(phase => createDocumentDiscoveryTools({ phase } as DocumentDiscoveryController)),
    ...createCoverageReviewTools({} as CoverageReviewController),
    ...createReferenceAnalysisTools({} as ReferenceAnalysisController),
    ...["candidate", "review"].flatMap(phase => createEditorHierarchyTools({ phase } as EditorHierarchyController)),
    ...createDocumentGraphTools({} as DocumentGraphStore, {} as SemanticGraphOverlayStore),
    createExternalStandardReferenceTool(async () => { throw new Error("metadata-only test"); }),
  ];
}

describe("model-facing Chinese language contract", () => {
  test("all actual tool surfaces keep machine names and use Chinese labels/descriptions", () => {
    const tools = surfaces();
    expect(tools.length).toBeGreaterThan(90);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]+$/u);
      expect(tool.label, tool.name).toMatch(chinese);
      expect(tool.description, tool.name).toMatch(chinese);
      const visit = (node: unknown, path: string): void => {
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (key === "description" && typeof value === "string") expect(value, path).toMatch(chinese);
          else visit(value, path + "/" + key);
        }
      };
      visit(tool.parameters, tool.name);
    }
  });

  test("target and coverage reference readers distinguish copied machine IDs from display or fingerprint fields", () => {
    const targetTools = new Map(createPiTools({ usesSelectorCompiler: true } as ToolController)
      .map((tool) => [tool.name, tool]));
    const coverageTools = new Map(createCoverageReviewTools({} as CoverageReviewController)
      .map((tool) => [tool.name, tool]));
    for (const tools of [targetTools, coverageTools]) {
      const inline = tools.get("read_document_reference_evidence")!;
      const isolated = tools.get("read_reference_facts")!;
      const sourceProtocol = suite.SOURCE_ACCESS_PROTOCOL + suite.SOURCE_HANDLE_INSTRUCTION;
      const visible = inline.description + isolated.description + sourceProtocol;
      expect(visible).toContain("target_key");
      expect(visible).toMatch(/不.*fingerprint/u);
      expect(visible).toMatch(/公开.*target_key|本会话公开工具回条/u);
      expect(visible).toMatch(/完整读取|全部片段/u);
      expect(visible).toMatch(/used.*(?:开始读取|已选择)/u);
      expect(visible).toMatch(/不解除 pending|不能独自解除 pending/u);
      expect(inline.description).not.toContain("只能从");
      expect(isolated.description).not.toContain("只能从");
      expect(visible).toContain("source_label");
      expect(visible).toContain("entry_id");
      expect(JSON.stringify(inline.parameters)).toMatch(/不[^。]*target_fingerprint/u);
      expect(JSON.stringify(inline.parameters)).toMatch(/当前公开工具返回|本会话公开工具回条/u);
    }
  });

  test("target and coverage inline reader schemas match the 24-row runtime page limit", () => {
    const targetTool = createPiTools({ usesSelectorCompiler: true } as ToolController)
      .find((tool) => tool.name === "read_document_reference_evidence")!;
    const coverageTool = createCoverageReviewTools({} as CoverageReviewController)
      .find((tool) => tool.name === "read_document_reference_evidence")!;
    expect.soft((targetTool.parameters as any).properties.limit.maximum).toBe(24);
    expect.soft((coverageTool.parameters as any).properties.limit.maximum).toBe(24);
  });

  test("assembled system prompts carry the common language rule through their central exports", async () => {
    const names = ["SYSTEM_PROMPT", "TARGET_SELECTOR_SYSTEM_PROMPT", "COVERAGE_REVIEW_SYSTEM_PROMPT", "HIERARCHY_SYSTEM_PROMPT",
      "HIERARCHY_CONFIRM_SYSTEM_PROMPT", "HIERARCHY_REVIEW_SYSTEM_PROMPT"] as const;
    for (const name of names) {
      expect(runtime[name], name).toBe(suite[name]);
      expect(runtime[name], name).toContain(MODEL_OUTPUT_LANGUAGE_GUIDANCE);
    }
    const source = await readFile(new URL('../src/pi-runtime.ts', import.meta.url), 'utf8');
    for (const name of ['DISCOVERY_SYSTEM_PROMPT', 'DISCOVERY_REVIEW_SYSTEM_PROMPT'] as const) {
      expect(source).toContain(`const ${name} = prompt_${name}`);
      expect(suite[name]).toContain(MODEL_OUTPUT_LANGUAGE_GUIDANCE);
    }
    expect(suite.REFERENCE_ANALYSIS_SYSTEM_PROMPT).toContain(MODEL_OUTPUT_LANGUAGE_GUIDANCE);
    expect(runtime.CATALOG_SELF_REVIEW_SYSTEM_PROMPT).toContain(MODEL_OUTPUT_LANGUAGE_GUIDANCE);
    expect(MODEL_OUTPUT_LANGUAGE_GUIDANCE).toContain("简体中文");
    for (const token of ["工具名", "字段", "枚举", "错误码", "ID", "路径", "公式", "精确原文保持原样"]) {
      expect(MODEL_OUTPUT_LANGUAGE_GUIDANCE).toContain(token);
    }
    expect(MODEL_OUTPUT_LANGUAGE_GUIDANCE).toContain("业务名称沿用原文主语言");
  });
});
import { readFile } from "node:fs/promises";
