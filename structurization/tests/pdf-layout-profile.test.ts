import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { buildGranularProseCoverageEvidence } from "../src/evidence.js";
import {
  PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
  PDF_LAYOUT_SEAL_MAX_ATTEMPTS,
  PdfLayoutSealError,
  buildPdfLayoutCatalog,
  inspectPdfLayoutLines,
  layoutCatalogExampleText,
  pdfLayoutSealToolReject,
  pdfNativeEvidenceForMarkdownWindow,
  sealPdfLayoutProfile,
  type PdfLayoutCatalog,
  type PdfLayoutRule,
} from "../src/pdf-layout-profile.js";

describe("PDF-learned layout profile", () => {
  test("keeps an explicit Markdown clause id when PDF spacing truncates its promotion", () => {
    const markdown = "## 4.2.11 预制构件模板安装的偏差及检验方法应符合表 4.2.11 的规定。";
    const evidence = buildGranularProseCoverageEvidence(
      markdown,
      "source-sha",
      [{ start_line: 1, end_exclusive_line: 2 }],
      {
        promotedHeadings: new Map([
          [1, { markdown_line: 1, role: "clause", clause_id: "4.2.1" }],
        ]),
      },
    );

    expect(evidence).toEqual([
      expect.objectContaining({
        locator: "line:1",
        text: "4.2.11 预制构件模板安装的偏差及检验方法应符合表 4.2.11 的规定。",
        clause_id: "4.2.11",
      }),
    ]);
  });

  test("promotes learned clauses and components while retaining structural headings as context", () => {
    const markdown = [
      "## 4.10 电气装置 [PDF p.16]",
      "4.10.1 电气设备接地必须符合下列规定:",
      "## 4.10.6 接地支线应采用黄绿相间的绝缘导线。 [PDF p.17]",
      "## 一般项目",
      "## 1)断相、错相保护装置或功能",
    ].join("\n");

    const evidence = buildGranularProseCoverageEvidence(
      markdown,
      "source-sha",
      [{ start_line: 1, end_exclusive_line: 6 }],
      {
        promotedHeadings: new Map([
          [3, { markdown_line: 3, role: "clause", clause_id: "4.10.6" }],
          [5, { markdown_line: 5, role: "clause_component", clause_id: "4.10.6" }],
        ]),
        structuralHeadingLines: new Set([1, 4]),
      },
    );

    expect(evidence.map((record) => record.text)).toEqual([
      "## 4.10 电气装置 [PDF p.16]",
      "4.10.1 电气设备接地必须符合下列规定:",
      "4.10.6 接地支线应采用黄绿相间的绝缘导线。",
      "## 一般项目",
      "1)断相、错相保护装置或功能",
    ]);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ locator: "line:1", kind: "heading", role: "section_heading", requires_disposition: false }),
      expect.objectContaining({ locator: "line:3", clause_id: "4.10.6", role: "supporting_clause" }),
      expect.objectContaining({ locator: "line:4", kind: "heading", role: "section_heading", requires_disposition: false }),
      expect.objectContaining({ locator: "line:5", clause_id: "4.10.6", role: "supporting_clause" }),
    ]));
    expect(evidence.find((record) => record.locator === "line:4")).not.toHaveProperty("clause_id");
  });

  test("inherits the unique formal parent clause across nested GB 50310 headings", () => {
    const sourceLines = [
      "# 6.1 设备进场验收 [PDF p.25]",
      "## 6.1.1 必须提供以下资料: [PDF p.25]",
      "## 1 技术资料 [PDF p.25]",
      "1)梯级或踏板的型式试验报告复印件；2)扶手带的断裂强度证书复印件。",
      "## 2 随机文件 [PDF p.25]",
      "1)土建布置图；",
      "2)产品出厂合格证。",
      "6.1.2 随机文件还应提供以下资料；",
      "1 装箱单；",
      "## 4.11.1 安全保护验收必须符合下列规定: [PDF p.17]",
      "## 1 必须检查以下安全装置或功能: [PDF p.17]",
      "## 1)断相、错相保护装置或功能 [PDF p.17]",
      "断相、错相保护装置或功能应使电梯不发生危险故障。",
    ];
    const markdown = sourceLines.flatMap((line) => [line, ""]).join("\n");
    const evidence = buildGranularProseCoverageEvidence(
      markdown,
      "source-sha",
      sourceLines.map((_line, index) => ({
        start_line: index * 2 + 1,
        end_exclusive_line: index * 2 + 2,
      })),
      {
        promotedHeadings: new Map([
          [3, { markdown_line: 3, role: "clause", clause_id: "6.1.1" }],
          [5, { markdown_line: 5, role: "clause_component", clause_id: "6.1.1" }],
          [9, { markdown_line: 9, role: "clause_component", clause_id: "6.1.1" }],
          [19, { markdown_line: 19, role: "clause", clause_id: "4.11.1" }],
          [21, { markdown_line: 21, role: "clause_component", clause_id: "4.11.1" }],
          [23, { markdown_line: 23, role: "clause_component", clause_id: "4.11.1" }],
        ]),
      },
    );
    const clauseByLine = new Map(evidence.map((record) => [record.locator, record.clause_id]));

    for (const line of [3, 5, 7, 9, 11, 13]) {
      expect(clauseByLine.get(`line:${line}`)).toBe("6.1.1");
    }
    expect(clauseByLine.get("line:15")).toBe("6.1.2");
    expect(clauseByLine.get("line:17")).toBe("6.1.2");
    for (const line of [19, 21, 23, 25]) {
      expect(clauseByLine.get(`line:${line}`)).toBe("4.11.1");
    }
  });

  test("applies sample-backed learned rules to every aligned heading without a prefilter", () => {
    const catalog: PdfLayoutCatalog = {
      schema_version: PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
      pdf_sha256: "pdf",
      markdown_sha256: "markdown",
      page_count: 2,
      matched_candidate_count: 4,
      unmatched_candidate_count: 0,
      document_route: "native",
      page_routes: [{
        pdf_page: 1,
        route: "native",
        char_count: 100,
        bad_char_ratio: 0,
        valid_geometry_ratio: 1,
        image_operation_count: 0,
        reason: "fixture",
      }, {
        pdf_page: 2,
        route: "native",
        char_count: 100,
        bad_char_ratio: 0,
        valid_geometry_ratio: 1,
        image_operation_count: 0,
        reason: "fixture",
      }],
      styles: [{
        style_id: "style:body",
        font_size: 12,
        start_x_ratio: 0.1,
        alignment: "left",
        dominant_font: "body",
        plain_line_count: 1,
        heading_line_count: 3,
        examples: [],
      }],
      sample_pages: [],
      pdf_lines: [
        { pdf_line_id: "pdf-line:1:1", pdf_page: 1, line_index: 1, text: "4.10.1 普通条文", font_size: 12, start_x: 60, width: 200, y: 700, page_width: 600, page_height: 800, dominant_font: "body", zone: "body", page_furniture: false },
        { pdf_line_id: "pdf-line:2:1", pdf_page: 2, line_index: 1, text: "4.10.6 标题形式条文", font_size: 12, start_x: 60, width: 200, y: 700, page_width: 600, page_height: 800, dominant_font: "body", zone: "body", page_furniture: false },
        { pdf_line_id: "pdf-line:2:2", pdf_page: 2, line_index: 2, text: "1)断相保护装置", font_size: 12, start_x: 60, width: 200, y: 680, page_width: 600, page_height: 800, dominant_font: "body", zone: "body", page_furniture: false },
        { pdf_line_id: "pdf-line:2:3", pdf_page: 2, line_index: 3, text: "一般项目", font_size: 12, start_x: 60, width: 200, y: 660, page_width: 600, page_height: 800, dominant_font: "body", zone: "body", page_furniture: false },
      ],
      candidates: [
        {
          candidate_id: "layout:2",
          markdown_line: 2,
          pdf_page: 1,
          markdown_heading: false,
          text: "4.10.1 普通条文",
          pdf_text: "4.10.1普通条文",
          style_id: "style:body",
          pdf_line_id: "pdf-line:1:1",
        },
        {
          candidate_id: "layout:3",
          markdown_line: 3,
          pdf_page: 2,
          markdown_heading: true,
          text: "4.10.6 标题形式条文",
          pdf_text: "4.10.6标题形式条文",
          style_id: "style:body",
          pdf_line_id: "pdf-line:2:1",
        },
        {
          candidate_id: "layout:4",
          markdown_line: 4,
          pdf_page: 2,
          markdown_heading: true,
          text: "1)断相保护装置",
          pdf_text: "1)断相保护装置",
          style_id: "style:body",
          pdf_line_id: "pdf-line:2:2",
        },
        {
          candidate_id: "layout:5",
          markdown_line: 5,
          pdf_page: 2,
          markdown_heading: true,
          text: "一般项目",
          pdf_text: "一般项目",
          style_id: "style:body",
          pdf_line_id: "pdf-line:2:3",
        },
      ],
    };
    const rules: PdfLayoutRule[] = [
      {
        rule_id: "formal-clause",
        role: "clause",
        pattern: "^\\d+(?:\\.\\d+){2,}\\s*",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:1:1", "pdf-line:2:1"],
        reason: "formal numbered clause",
      },
      {
        rule_id: "paren-component",
        role: "clause_component",
        pattern: "^\\d+\\)",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:2:2"],
        reason: "nested component",
      },
      {
        rule_id: "column-heading",
        role: "structural",
        pattern: "^一般项目$",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:2:3"],
        reason: "structural column marker",
      },
    ];

    expect(sealPdfLayoutProfile(catalog, rules, "learned from representative pages"))
      .toMatchObject({
        rules: expect.arrayContaining([expect.objectContaining({ rule_id: "paren-component" })]),
        structural_heading_lines: [5],
        promoted_headings: [
          { markdown_line: 3, role: "clause", clause_id: "4.10.6" },
          { markdown_line: 4, role: "clause_component", clause_id: "4.10.6" },
        ],
      });
  });

  function nativeLine(
    pdfLineId: string,
    text: string,
    extras: Partial<PdfLayoutCatalog["pdf_lines"][number]> = {},
  ): PdfLayoutCatalog["pdf_lines"][number] {
    const [, page, index] = /^pdf-line:(\d+):(\d+)$/.exec(pdfLineId) ?? ["", "1", "1"];
    return {
      pdf_line_id: pdfLineId,
      pdf_page: Number(page),
      line_index: Number(index),
      text,
      font_size: 12,
      start_x: 60,
      width: 200,
      y: 700,
      page_width: 600,
      page_height: 800,
      dominant_font: "body",
      zone: "body",
      page_furniture: false,
      ...extras,
    };
  }

  function catalogStyle(styleId: string): PdfLayoutCatalog["styles"][number] {
    return {
      style_id: styleId,
      font_size: 12,
      start_x_ratio: 0.1,
      alignment: "left",
      dominant_font: "body",
      plain_line_count: 1,
      heading_line_count: 1,
      examples: [],
    };
  }

  function catalogWithLines(
    lines: PdfLayoutCatalog["pdf_lines"],
    options: { candidateStyle?: string; extraStyleIds?: string[] } = {},
  ): PdfLayoutCatalog {
    const candidateStyle = options.candidateStyle ?? "style:body";
    const pages = [...new Set(lines.map((line) => line.pdf_page))];
    return {
      schema_version: PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
      pdf_sha256: "pdf",
      markdown_sha256: "markdown",
      page_count: Math.max(1, ...pages),
      matched_candidate_count: lines.length,
      unmatched_candidate_count: 0,
      document_route: "native",
      page_routes: pages.map((pdf_page) => ({
        pdf_page,
        route: "native",
        char_count: 100,
        bad_char_ratio: 0,
        valid_geometry_ratio: 1,
        image_operation_count: 0,
        reason: "fixture",
      })),
      styles: [
        catalogStyle(candidateStyle),
        ...(options.extraStyleIds ?? []).map(catalogStyle),
      ],
      sample_pages: [],
      pdf_lines: lines,
      candidates: lines.map((line, index) => ({
        candidate_id: `layout:${index + 1}`,
        markdown_line: index + 1,
        pdf_page: line.pdf_page,
        markdown_heading: false,
        text: line.text.replace(/(?<=\d)\s+(?=\d)/g, "").replace(/(?<=\d)(?=\S)/, " "),
        pdf_text: line.text,
        style_id: candidateStyle,
        pdf_line_id: line.pdf_line_id,
      })),
    };
  }

  test("seals role=clause samples against raw PDF numbering, not Markdown spacing", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:32:50", "5.3.1施工前应对放线尺寸进行检验。"),
      nativeLine("pdf-line:48:7", "6. 1.3地基基础施工应合理安排施工程序，防止施工用水和场地"),
    ]);
    const profile = sealPdfLayoutProfile(catalog, [{
      rule_id: "clause.numbered.observed",
      role: "clause",
      pattern: "^[0-9]+\\.\\s*[0-9]+\\.\\s*[0-9]+\\s+\\S",
      style_ids: ["style:body"],
      sample_line_ids: ["pdf-line:32:50", "pdf-line:48:7"],
      reason: "formal numbered clause",
    }], "raw pdf numbering");
    expect(profile.promoted_pdf_lines.map((line) => line.clause_id).sort()).toEqual(["5.3.1", "6.1.3"]);
  });

  test("rejects every failing sample at once with the raw line the regex actually saw", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:1:1", "4.10.1 普通条文"),
      nativeLine("pdf-line:1:2", "一般项目"),
    ], { extraStyleIds: ["style:other"] });
    const rules: PdfLayoutRule[] = [{
      rule_id: "ok-clause",
      role: "clause",
      pattern: "^\\d+(?:\\.\\d+){2,}",
      style_ids: ["style:body"],
      sample_line_ids: ["pdf-line:1:1"],
      reason: "good",
    }, {
      rule_id: "bad-clause",
      role: "clause",
      pattern: "^\\d+(?:\\.\\d+){2,}\\s+\\S",
      style_ids: ["style:other"],
      sample_line_ids: ["pdf-line:1:2"],
      reason: "wrong style and not a clause",
    }];
    expect(() => sealPdfLayoutProfile(catalog, rules, "partial")).toThrow(PdfLayoutSealError);
    try {
      sealPdfLayoutProfile(catalog, rules, "partial");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfLayoutSealError);
      const reject = (error as PdfLayoutSealError).toToolReject();
      expect(reject).toMatchObject({
        ok: false,
        error: "pdf_layout_rule_samples_rejected",
        passing_rule_ids: ["ok-clause"],
        writable_collection: "seal_pdf_layout_profile.rules",
        required_action: "drop_failing_sample_line_ids_or_drop_the_failing_rules_then_resubmit",
        candidate_read_tool: "inspect_pdf_layout_lines",
      });
      expect(reject.instruction).toMatch(/raw PDF/i);
      expect(reject.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule_id: "bad-clause",
          pdf_line_id: "pdf-line:1:2",
          actual_text: "一般项目",
          actual_style_id: "style:body",
        }),
      ]));
      expect(reject.failures.some((row) => /style|regex|clause/.test(row.mismatch))).toBe(true);
    }
  });

  test("reports every failing sample in one rule instead of stopping at the first", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:1:1", "一般项目"),
      nativeLine("pdf-line:1:2", "检验标准"),
    ]);
    try {
      sealPdfLayoutProfile(catalog, [{
        rule_id: "bad-clause",
        role: "clause",
        pattern: "^\\d+(?:\\.\\d+){2,}\\s+\\S",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:1:1", "pdf-line:1:2"],
        reason: "not clauses",
      }], "all-bad");
      throw new Error("expected PdfLayoutSealError");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfLayoutSealError);
      const reject = (error as PdfLayoutSealError).toToolReject();
      expect(reject.failures.map((row) => row.pdf_line_id)).toEqual(["pdf-line:1:1", "pdf-line:1:2"]);
      expect(reject.failures.map((row) => row.actual_text)).toEqual(["一般项目", "检验标准"]);
    }
  });

  test("role=clause_component still requires the submitted regex on raw PDF text", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:46:1", "6浮运沉井应进行起浮可能性检验。"),
    ]);
    try {
      sealPdfLayoutProfile(catalog, [{
        rule_id: "numbered-list",
        role: "clause_component",
        pattern: "^[0-9]+\\s+\\S",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:46:1"],
        reason: "numbered list",
      }], "component");
      throw new Error("expected PdfLayoutSealError");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfLayoutSealError);
      expect((error as PdfLayoutSealError).toToolReject().failures).toEqual([
        expect.objectContaining({
          rule_id: "numbered-list",
          pdf_line_id: "pdf-line:46:1",
          actual_text: "6浮运沉井应进行起浮可能性检验。",
          mismatch: expect.stringMatching(/regex/),
        }),
      ]);
    }
  });

  test("rejects catch-all patterns instead of sealing a ^.* grammar", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:1:1", "5.3.1施工前应对放线尺寸进行检验。"),
    ]);
    try {
      sealPdfLayoutProfile(catalog, [{
        rule_id: "catch-all",
        role: "clause",
        pattern: "^.*",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:1:1"],
        reason: "force seal",
      }], "vacuous");
      throw new Error("expected PdfLayoutSealError");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfLayoutSealError);
      expect((error as PdfLayoutSealError).toToolReject().failures).toEqual([
        expect.objectContaining({
          rule_id: "catch-all",
          mismatch: "catch_all_pattern",
        }),
      ]);
    }
  });

  test("seals role=clause appendix ids such as A.0.1 on raw PDF text", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:80:3", "A.0.1附录条文应列出检验项目。"),
    ]);
    const profile = sealPdfLayoutProfile(catalog, [{
      rule_id: "appendix-clause",
      role: "clause",
      pattern: "^[A-Z]\\.\\d+",
      style_ids: ["style:body"],
      sample_line_ids: ["pdf-line:80:3"],
      reason: "appendix clause",
    }], "appendix");
    expect(profile.promoted_pdf_lines.map((line) => line.clause_id)).toEqual(["A.0.1"]);
  });

  test("catalog style examples use raw PDF text rather than Markdown spacing", () => {
    expect(layoutCatalogExampleText({
      candidate_id: "layout:1",
      markdown_line: 1,
      pdf_page: 32,
      markdown_heading: false,
      text: "5.3.1 施工前应对放线尺寸进行检验。",
      pdf_text: "5.3.1施工前应对放线尺寸进行检验。",
      style_id: "style:body",
      pdf_line_id: "pdf-line:32:50",
    })).toBe("5.3.1施工前应对放线尺寸进行检验。");
  });

  test("layout seal attempt budget tells the model to stop after repeated rejects", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:1:1", "一般项目"),
    ]);
    let caught: PdfLayoutSealError | undefined;
    try {
      sealPdfLayoutProfile(catalog, [{
        rule_id: "bad",
        role: "clause",
        pattern: "^\\d+(?:\\.\\d+){2,}",
        style_ids: ["style:body"],
        sample_line_ids: ["pdf-line:1:1"],
        reason: "not a clause",
      }], "budget");
    } catch (error) {
      caught = error as PdfLayoutSealError;
    }
    expect(caught).toBeInstanceOf(PdfLayoutSealError);
    const exhausted = pdfLayoutSealToolReject(caught!, PDF_LAYOUT_SEAL_MAX_ATTEMPTS);
    expect(exhausted).toMatchObject({
      ok: false,
      error: "pdf_layout_profile_seal_attempt_budget_exhausted",
      seal_attempt: PDF_LAYOUT_SEAL_MAX_ATTEMPTS,
      max_seal_attempts: PDF_LAYOUT_SEAL_MAX_ATTEMPTS,
    });
    expect(exhausted.instruction).toMatch(/Stop calling seal_pdf_layout_profile/i);
    expect(pdfLayoutSealToolReject(caught!, 1).error).toBe("pdf_layout_rule_samples_rejected");
  });

  test("inspectPdfLayoutLines returns raw text and style for cited line ids", () => {
    const catalog = catalogWithLines([
      nativeLine("pdf-line:46:1", "6浮运沉井应进行起浮可能性检验。"),
    ]);
    expect(inspectPdfLayoutLines(catalog, ["pdf-line:46:1", "pdf-line:9:9"])).toMatchObject({
      ok: true,
      matching_surface: "catalog.pdf_lines[].text",
      lines: [
        expect.objectContaining({
          pdf_line_id: "pdf-line:46:1",
          actual_text: "6浮运沉井应进行起浮可能性检验。",
          aligned: true,
        }),
        expect.objectContaining({
          pdf_line_id: "pdf-line:9:9",
          missing: true,
        }),
      ],
    });
  });

  test("merges PDF-only lines only inside the aligned target interval on shared pages", () => {
    const baseLine = {
      pdf_page: 1,
      font_size: 12,
      start_x: 60,
      width: 200,
      y: 600,
      page_width: 600,
      page_height: 800,
      dominant_font: "body",
      zone: "body" as const,
      page_furniture: false,
    };
    const profile = {
      schema_version: "pdf-layout-profile/v5" as const,
      pdf_sha256: "pdf",
      markdown_sha256: "markdown",
      rules: [],
      promoted_headings: [],
      promoted_pdf_lines: [],
      pdf_only_lines: [
        { ...baseLine, pdf_line_id: "pdf-line:1:1", line_index: 1, text: "相邻目标内容" },
        { ...baseLine, pdf_line_id: "pdf-line:1:3", line_index: 3, text: "目标内PDF独有内容" },
        { ...baseLine, pdf_line_id: "pdf-line:1:5", line_index: 5, text: "下一个目标内容" },
      ],
      markdown_alignments: [
        { markdown_line: 2, pdf_line_id: "pdf-line:1:2", pdf_page: 1, pdf_line_index: 2 },
        { markdown_line: 3, pdf_line_id: "pdf-line:1:4", pdf_page: 1, pdf_line_index: 4 },
      ],
      summary: "fixture",
    };
    const evidence = pdfNativeEvidenceForMarkdownWindow(
      profile,
      "# 标题 [PDF p.1]\n目标开始\n目标结束\n# 下一目标",
      2,
      4,
    );
    expect(evidence.map((record) => record.text)).toEqual(["目标内PDF独有内容"]);
    expect(evidence[0]).toMatchObject({
      locator: "pdf-page:1/line:3",
      evidence_scope: "reference",
      requires_disposition: false,
    });
  });

  const pdfPath = resolve("data/jobs/20260818-094250-1d70/input.pdf");
  const markdownPath = resolve(
    "data/jobs/20260818-094250-1d70/output/01_GB_50310-2002_电梯工程施工质量验收规范.md",
  );
  test.skipIf(!existsSync(pdfPath) || !existsSync(markdownPath))(
    "exposes GB 50310 formal clauses and 1) components to the same PDF rule learner",
    async () => {
      const catalog = await buildPdfLayoutCatalog(pdfPath, markdownPath);
      const clause4106 = catalog.candidates.find((candidate) => candidate.markdown_line === 457);
      const clause4107 = catalog.candidates.find((candidate) => candidate.markdown_line === 459);
      const component = catalog.candidates.find((candidate) => candidate.markdown_line === 469);
      expect(clause4106).toMatchObject({ pdf_page: 17, markdown_heading: true });
      expect(clause4107).toMatchObject({ pdf_page: 17, markdown_heading: true });
      expect(component).toMatchObject({ pdf_page: 17, markdown_heading: true });

      const rules: PdfLayoutRule[] = [
        {
          rule_id: "formal-clause",
          role: "clause",
          pattern: "^\\d+(?:\\.\\d+){2,}\\s*",
          style_ids: [...new Set([clause4106!.style_id, clause4107!.style_id])],
          sample_line_ids: [clause4106!.pdf_line_id, clause4107!.pdf_line_id],
          reason: "PDF body clause",
        },
        {
          rule_id: "paren-component",
          role: "clause_component",
          pattern: "^\\d+\\)",
          style_ids: [component!.style_id],
          sample_line_ids: [component!.pdf_line_id],
          reason: "PDF nested list component",
        },
      ];
      const profile = sealPdfLayoutProfile(catalog, rules, "GB 50310 grammar");
      expect(profile.promoted_headings).toEqual(expect.arrayContaining([
        { markdown_line: 457, role: "clause", clause_id: "4.10.6" },
        { markdown_line: 459, role: "clause", clause_id: "4.10.7" },
        { markdown_line: 469, role: "clause_component", clause_id: "4.11.1" },
      ]));
      expect(catalog.sample_pages.some((page) => page.lines.some((line) => line.text.startsWith("1)")))).toBe(true);
    },
    30_000,
  );
});
