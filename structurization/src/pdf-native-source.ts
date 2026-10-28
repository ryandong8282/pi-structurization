import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { sha256Bytes } from "./canonical.js";

export const PDF_TEXT_ROUTE_SCHEMA_VERSION = "pdf-text-route/v1" as const;

export type PdfPageTextRoute = "native" | "ocr";
export type PdfDocumentTextRoute = "native" | "hybrid" | "ocr";

export interface PdfNativeLine {
  pdf_line_id: string;
  pdf_page: number;
  line_index: number;
  text: string;
  font_size: number;
  start_x: number;
  width: number;
  y: number;
  page_width: number;
  page_height: number;
  dominant_font: string;
  zone: "top" | "body" | "bottom";
  page_furniture: boolean;
  furniture_reason?: "page_number" | "repeated_margin_text";
}

export interface PdfPageRouteRecord {
  pdf_page: number;
  route: PdfPageTextRoute;
  char_count: number;
  bad_char_ratio: number;
  valid_geometry_ratio: number;
  image_operation_count: number;
  reason: string;
}

export interface PdfNativeDocument {
  schema_version: typeof PDF_TEXT_ROUTE_SCHEMA_VERSION;
  pdf_sha256: string;
  page_count: number;
  document_route: PdfDocumentTextRoute;
  page_routes: PdfPageRouteRecord[];
  lines: PdfNativeLine[];
}

export interface PdfRawPage {
  pdf_page: number;
  page_width: number;
  page_height: number;
  item_count: number;
  valid_geometry_count: number;
  image_operation_count: number;
  lines: Array<Omit<PdfNativeLine, "pdf_line_id" | "pdf_page" | "line_index" | "zone" | "page_furniture" | "furniture_reason">>;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

function textItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<PdfTextItem>;
  return typeof row.str === "string"
    && Array.isArray(row.transform)
    && row.transform.length >= 6
    && typeof row.width === "number"
    && typeof row.fontName === "string";
}

function compactText(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]/g, "");
}

function marginPattern(value: string): string {
  return compactText(value).replace(/\d+/g, "#").replace(/[·•—_\-]+/g, "");
}

function pageNumberLike(value: string): boolean {
  const compact = compactText(value);
  return /^(?:第)?\d+(?:页)?$|^[·•\-—]*\d+[·•\-—]*$/.test(compact);
}

function badCharacterCount(value: string): number {
  return (value.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length;
}

function rawPageLines(items: unknown[], pageWidth: number, pageHeight: number): PdfRawPage["lines"] {
  const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of items.filter(textItem)) {
    if (!item.str.trim()) continue;
    const y = item.transform[5] ?? 0;
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 1.5);
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => {
      const ordered = row.items.sort((left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0));
      const startX = Math.min(...ordered.map((item) => item.transform[4] ?? 0));
      const endX = Math.max(...ordered.map((item) => (item.transform[4] ?? 0) + item.width));
      const fonts = new Map<string, number>();
      for (const item of ordered) fonts.set(item.fontName, (fonts.get(item.fontName) ?? 0) + item.str.length);
      const dominantFont = [...fonts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
      const dominantItems = ordered.filter((item) => item.fontName === dominantFont);
      const fontSize = dominantItems.length
        ? dominantItems.reduce((sum, item) => sum + Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0), 0) / dominantItems.length
        : 0;
      return {
        text: ordered.map((item) => item.str).join("").trim(),
        font_size: fontSize,
        start_x: startX,
        width: Math.max(0, endX - startX),
        y: row.y,
        page_width: pageWidth,
        page_height: pageHeight,
        dominant_font: dominantFont,
      };
    })
    .filter((line) => line.text.length > 0);
}

export function classifyPdfNativePages(
  pdfSha256: string,
  pages: readonly PdfRawPage[],
): PdfNativeDocument {
  const pageRoutes: PdfPageRouteRecord[] = [];
  const lines: PdfNativeLine[] = [];
  for (const page of pages) {
    const text = page.lines.map((line) => line.text).join("");
    const charCount = compactText(text).length;
    const badRatio = charCount > 0 ? badCharacterCount(text) / charCount : 0;
    const geometryRatio = page.item_count > 0 ? page.valid_geometry_count / page.item_count : 1;
    const route: PdfPageTextRoute = badRatio >= 0.01 || geometryRatio < 0.98 || charCount < 20
      ? "ocr"
      : "native";
    const reason = route === "ocr"
        ? badRatio >= 0.01
          ? "native text contains too many invalid glyphs"
          : geometryRatio < 0.98
            ? "native text geometry is incomplete"
            : "page has no meaningful native text"
        : "native text and geometry are usable";
    pageRoutes.push({
      pdf_page: page.pdf_page,
      route,
      char_count: charCount,
      bad_char_ratio: Number(badRatio.toFixed(4)),
      valid_geometry_ratio: Number(geometryRatio.toFixed(4)),
      image_operation_count: page.image_operation_count,
      reason,
    });
    page.lines.forEach((line, index) => {
      const zone = line.y >= line.page_height * 0.88
        ? "top"
        : line.y <= line.page_height * 0.12
          ? "bottom"
          : "body";
      lines.push({
        ...line,
        // PDF.js prefixes font handles with its process-local document counter
        // (g_d0_f1, g_d1_f1, ...). Only the font suffix identifies a font within
        // this PDF; keeping the counter makes identical sources miss the cache.
        dominant_font: line.dominant_font.replace(/^g_d\d+_(f\d+)$/u, "pdfjs:$1"),
        pdf_line_id: `pdf-line:${page.pdf_page}:${index + 1}`,
        pdf_page: page.pdf_page,
        line_index: index + 1,
        zone,
        page_furniture: false,
      });
    });
  }

  const marginGroups = new Map<string, PdfNativeLine[]>();
  for (const line of lines) {
    if (line.zone === "body") continue;
    const pattern = marginPattern(line.text);
    if (pattern.length < 1) continue;
    const key = `${line.zone}|${pattern}`;
    const rows = marginGroups.get(key) ?? [];
    rows.push(line);
    marginGroups.set(key, rows);
  }
  const broadRepeatThreshold = Math.max(5, Math.ceil(pages.length * 0.5));
  for (const rows of marginGroups.values()) {
    const uniquePages = new Set(rows.map((row) => row.pdf_page));
    const isPageNumber = rows.every((row) => pageNumberLike(row.text)) && uniquePages.size >= 3;
    const isBroadRepeat = uniquePages.size >= broadRepeatThreshold;
    if (!isPageNumber && !isBroadRepeat) continue;
    for (const row of rows) {
      row.page_furniture = true;
      row.furniture_reason = isPageNumber ? "page_number" : "repeated_margin_text";
    }
  }

  const nativeCount = pageRoutes.filter((page) => page.route === "native").length;
  const ocrCount = pageRoutes.filter((page) => page.route === "ocr").length;
  const documentRoute: PdfDocumentTextRoute = ocrCount === 0
    ? "native"
    : nativeCount === 0
      ? "ocr"
      : "hybrid";
  return {
    schema_version: PDF_TEXT_ROUTE_SCHEMA_VERSION,
    pdf_sha256: pdfSha256,
    page_count: pages.length,
    document_route: documentRoute,
    page_routes: pageRoutes,
    lines,
  };
}

export async function extractPdfNativeDocument(pdfPath: string): Promise<PdfNativeDocument> {
  const bytes = await readFile(pdfPath);
  const pdfJsRoot = dirname(dirname(dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs"),
  )));
  const document = await getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${join(pdfJsRoot, "cmaps").replaceAll("\\", "/")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(pdfJsRoot, "standard_fonts").replaceAll("\\", "/")}/`,
  }).promise;
  const pages: PdfRawPage[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof content.items[number] & PdfTextItem => textItem(item));
    const lines = rawPageLines(content.items, viewport.width, viewport.height);
    pages.push({
      pdf_page: pageNumber,
      page_width: viewport.width,
      page_height: viewport.height,
      item_count: items.length,
      valid_geometry_count: items.filter((item) => item.transform.length >= 6 && item.transform.every(Number.isFinite)).length,
      image_operation_count: 0,
      lines,
    });
  }
  return classifyPdfNativePages(sha256Bytes(bytes), pages);
}
