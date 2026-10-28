import { describe, expect, test } from "vitest";

import { classifyPdfNativePages, type PdfRawPage } from "../src/pdf-native-source.js";

function line(text: string, y: number): PdfRawPage["lines"][number] {
  return {
    text,
    font_size: 12,
    start_x: 60,
    width: 200,
    y,
    page_width: 600,
    page_height: 800,
    dominant_font: "body",
  };
}

describe("PDF native/OCR routing", () => {
  test("font identity is document-local, not the PDF.js process document counter", () => {
    const classify = (font: string) => classifyPdfNativePages("same-pdf", [{
      pdf_page: 1, page_width: 600, page_height: 800, item_count: 1,
      valid_geometry_count: 1, image_operation_count: 0,
      lines: [{ ...line("足够长且来自同一文档的正文用于验证字体身份稳定性。", 600), dominant_font: font }],
    }]);
    expect(classify("g_d0_f12")).toEqual(classify("g_d9_f12"));
    expect(classify("g_d0_f12")).not.toEqual(classify("g_d9_f13"));
    expect(classify("custom-font").lines[0]!.dominant_font).toBe("custom-font");
  });

  test("routes per page, removes broad page numbers, and preserves short repeated table headers", () => {
    const pages: PdfRawPage[] = Array.from({ length: 8 }, (_, index) => {
      const page = index + 1;
      if (page === 7) {
        return {
          pdf_page: page,
          page_width: 600,
          page_height: 800,
          item_count: 0,
          valid_geometry_count: 0,
          image_operation_count: 1,
          lines: [],
        };
      }
      if (page === 8) {
        return {
          pdf_page: page,
          page_width: 600,
          page_height: 800,
          item_count: 0,
          valid_geometry_count: 0,
          image_operation_count: 0,
          lines: [],
        };
      }
      return {
        pdf_page: page,
        page_width: 600,
        page_height: 800,
        item_count: 3,
        valid_geometry_count: 3,
        image_operation_count: 0,
        lines: [
          ...(page <= 2 ? [line("检查项目 允许偏差 检查方法", 720)] : []),
          line(`${page}.1.1 本页正文要求应符合规定。`, 600),
          line(`第${page}页`, 30),
        ],
      };
    });

    const result = classifyPdfNativePages("pdf", pages);
    expect(result.document_route).toBe("hybrid");
    expect(result.page_routes.map((page) => page.route)).toEqual([
      "native", "native", "native", "native", "native", "native", "ocr", "ocr",
    ]);
    expect(result.lines.filter((row) => row.text.startsWith("第"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ page_furniture: true, furniture_reason: "page_number" })]),
    );
    expect(result.lines.filter((row) => row.text.startsWith("检查项目"))).toEqual([
      expect.objectContaining({ page_furniture: false }),
      expect.objectContaining({ page_furniture: false }),
    ]);
  });

  test("fails a corrupt native text page closed to OCR", () => {
    const result = classifyPdfNativePages("pdf", [{
      pdf_page: 1,
      page_width: 600,
      page_height: 800,
      item_count: 1,
      valid_geometry_count: 1,
      image_operation_count: 0,
      lines: [line("\uE000\uE001正常文字", 600)],
    }]);
    expect(result.document_route).toBe("ocr");
    expect(result.page_routes[0]).toMatchObject({ route: "ocr", reason: "native text contains too many invalid glyphs" });
  });
});
