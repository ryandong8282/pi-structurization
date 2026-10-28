import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { sha256Json } from "../src/canonical.js";
import { atomicWriteJson } from "../src/atomic.js";
import { DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { pdfLayoutCacheKey, readPdfLayoutCache, writePdfLayoutCache } from "../src/pdf-layout-cache.js";
import { PDF_LAYOUT_CATALOG_SCHEMA_VERSION, pdfLayoutCatalogPage, sealPdfLayoutProfile, type PdfLayoutCatalog, type PdfLayoutRule } from "../src/pdf-layout-profile.js";
import { runLivePdfLayoutProfile } from "../src/pi-runtime.js";
import * as pdfNative from "../src/pdf-native-source.js";
import { buildPdfLayoutCatalog } from "../src/pdf-layout-profile.js";

function fixture(label: string) {
  const text = `8.4.1 ${label}应符合要求。`;
  const catalog: PdfLayoutCatalog = {
    schema_version: PDF_LAYOUT_CATALOG_SCHEMA_VERSION, pdf_sha256: sha256Json(label), markdown_sha256: sha256Json(text),
    page_count: 1, matched_candidate_count: 1, unmatched_candidate_count: 0, document_route: "native",
    page_routes: [{ pdf_page: 1, route: "native", char_count: 100, bad_char_ratio: 0, valid_geometry_ratio: 1, image_operation_count: 0, reason: "fixture" }],
    styles: [{ style_id: "body", font_size: 12, start_x_ratio: 0.1, alignment: "left", dominant_font: "body", plain_line_count: 0, heading_line_count: 1, examples: [] }],
    pdf_lines: [{ pdf_line_id: "pdf-line:1:1", pdf_page: 1, line_index: 1, text, font_size: 12, start_x: 60, width: 200, y: 700, page_width: 600, page_height: 800, dominant_font: "body", zone: "body", page_furniture: false }],
    candidates: [{ candidate_id: "layout:1", markdown_line: 1, pdf_page: 1, markdown_heading: true, text, pdf_text: text, style_id: "body", pdf_line_id: "pdf-line:1:1" }],
    sample_pages: [{ pdf_page: 1, lines: [{ pdf_line_id: "pdf-line:1:1", style_id: "body", zone: "body", page_furniture: false, text }] }],
  };
  const rules: PdfLayoutRule[] = [{ rule_id: "formal-clause", role: "clause", pattern: "^\\d+(?:\\.\\d+){2,}", style_ids: ["body"], sample_line_ids: ["pdf-line:1:1"], reason: "来源样式及编号支持正式条文" }];
  return { catalog, rules, profile: sealPdfLayoutProfile(catalog, rules, "source-supported layout") };
}

describe("source-verified cross-job layout cache", () => {
  test("reuses the layout when PDF.js changes its runtime document font prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-layout-font-identity-"));
    const markdown = join(root, "source.md");
    const text = "8.4.1 Equipment shall conform to approved requirements.";
    await writeFile(markdown, `## ${text}`);
    const native = (font: string) => pdfNative.classifyPdfNativePages("same-pdf", [{
      pdf_page: 1, page_width: 600, page_height: 800, item_count: 1,
      valid_geometry_count: 1, image_operation_count: 0,
      lines: [{ text, font_size: 12, start_x: 60, width: 400, y: 600,
        page_width: 600, page_height: 800, dominant_font: font }],
    }]);
    const extract = vi.spyOn(pdfNative, "extractPdfNativeDocument")
      .mockResolvedValueOnce(native("g_d0_f12")).mockResolvedValueOnce(native("g_d37_f12"));
    try {
      const first = await buildPdfLayoutCatalog("unused.pdf", markdown);
      const candidate = first.candidates[0]!;
      const profile = sealPdfLayoutProfile(first, [{ rule_id: "source-clause", role: "clause",
        pattern: "^8\\.4\\.1", style_ids: [candidate.style_id],
        sample_line_ids: [candidate.pdf_line_id], reason: "Source clause number and body font" }], "source layout");
      await writePdfLayoutCache(root, first, profile);
      const second = await buildPdfLayoutCatalog("unused.pdf", markdown);
      expect(second).toEqual(first);
      expect(await readPdfLayoutCache(root, second)).toMatchObject({ status: "hit", profile });
    } finally { extract.mockRestore(); }
  });

  test.each(["机电设备", "防水构件", "支护材料"])("reuses only matching source and current derived coordinates: %s", async (label) => {
    const root = await mkdtemp(join(tmpdir(), "pi-layout-cache-"));
    const f = fixture(label);
    expect(await readPdfLayoutCache(root, f.catalog)).toMatchObject({ status: "miss" });
    await writePdfLayoutCache(root, f.catalog, f.profile);
    expect(await readPdfLayoutCache(root, f.catalog)).toMatchObject({ status: "hit", profile: f.profile });
    expect(await readPdfLayoutCache(root, { ...f.catalog, markdown_sha256: "changed" })).toMatchObject({ status: "miss" });
    expect(await readPdfLayoutCache(root, { ...f.catalog, pdf_sha256: "changed" })).toMatchObject({ status: "miss" });
    const path = join(root, `${pdfLayoutCacheKey(f.catalog)}.json`);
    const entry = JSON.parse(await readFile(path, "utf8"));
    entry.profile.promoted_headings[0].markdown_line = 900;
    // Even a matching envelope digest cannot authorize fabricated derived coordinates.
    entry.profile_sha256 = sha256Json(entry.profile);
    await atomicWriteJson(path, entry);
    expect(await readPdfLayoutCache(root, f.catalog)).toMatchObject({ status: "invalid" });
    await writeFile(path, "{interrupted");
    expect(await readPdfLayoutCache(root, f.catalog)).toMatchObject({ status: "invalid" });
    await writePdfLayoutCache(root, f.catalog, f.profile);
    const old = JSON.parse(await readFile(path, "utf8"));
    old.version = "old-contract";
    await atomicWriteJson(path, old);
    expect(await readPdfLayoutCache(root, f.catalog)).toMatchObject({ status: "invalid" });
  });

  test("complete rerun in a new job uses no provider session; independent source reading remains empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-layout-rerun-"));
    const markdown = join(root, "source.md");
    await writeFile(markdown, "## 8.4.1 设备应符合要求。");
    const f = fixture("设备");
    const buildCatalog = vi.fn(async () => f.catalog);
    let calls = 0;
    const runSession: NonNullable<Parameters<typeof runLivePdfLayoutProfile>[4]>["runSession"] = async (_workspace, options) => {
      calls++;
      expect(options.effortOverride).toBe("low");
      expect(options.telemetryPhase).toBe("pdf_layout");
      const invoke = async (name: string, args: unknown) => options.customTools.find(tool => tool.name === name)!.execute("test", args as never, undefined as never, undefined as never);
      expect((await invoke("seal_pdf_layout_profile", { rules: f.rules, summary: f.profile.summary })).details).toMatchObject({ error: "pdf_layout_samples_unread" });
      await invoke("read_pdf_layout_catalog", {});
      const sealed = await invoke("seal_pdf_layout_profile", { rules: f.rules, summary: f.profile.summary });
      expect(sealed.details).toMatchObject({ ok: true, rule_count: 1 });
      expect(sealed.details).not.toHaveProperty("profile");
      return { session_id: "layout-test", session_file: "layout.jsonl", completed: true, model: "fixture" };
    };
    const cacheRoot = join(root, "shared-cache");
    const first = await DocumentDiscoveryWorkspace.openOrCreate(root, "first", markdown);
    expect((await runLivePdfLayoutProfile(first, "unused.pdf", undefined, undefined, { cacheRoot, buildCatalog, runSession })).profile).toEqual(f.profile);
    const second = await DocumentDiscoveryWorkspace.openOrCreate(root, "second", markdown);
    expect(await runLivePdfLayoutProfile(second, "unused.pdf", undefined, undefined, { cacheRoot, buildCatalog, runSession })).toMatchObject({ profile: f.profile, model: "cached-pdf-layout-profile" });
    expect(calls).toBe(1);
    expect(await second.readState()).toMatchObject({ opened_atom_ids: [], reviewer_opened_atom_ids: [] });
    expect(await readFile(second.transcriptPath, "utf8")).toContain('"status":"hit"');
    const abort = new AbortController(); abort.abort();
    await expect(runLivePdfLayoutProfile(second, "unused.pdf", abort.signal, undefined, { cacheRoot, buildCatalog, runSession })).rejects.toThrow();
    expect(calls).toBe(1);
  }, 30_000);

  test("catalog pagination preserves every representative PDF line without style-example duplication", () => {
    const { catalog } = fixture("设备");
    catalog.sample_pages = Array.from({ length: 8 }, (_, index) => ({ pdf_page: index + 1,
      lines: Array.from({ length: 40 }, (_, line) => ({ ...catalog.sample_pages[0]!.lines[0]!, pdf_line_id: `pdf-line:${index + 1}:${line + 1}`, text: "原始页面字形".repeat(60) })) }));
    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = pdfLayoutCatalogPage(catalog, cursor);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
      expect(page.styles[0]).not.toHaveProperty("examples");
      seen.push(...page.sample_pages.flatMap(sample => sample.lines.map(line => line.pdf_line_id)));
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(catalog.sample_pages.flatMap(page => page.lines.map(line => line.pdf_line_id)));
  });
});
