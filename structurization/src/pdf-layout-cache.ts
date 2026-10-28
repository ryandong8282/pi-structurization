import { join } from "node:path";
import { atomicWriteJson, readJson } from "./atomic.js";
import { sha256Json } from "./canonical.js";
import { PDF_LAYOUT_CATALOG_SCHEMA_VERSION, PDF_LAYOUT_PROFILE_SCHEMA_VERSION, sealPdfLayoutProfile, type PdfLayoutCatalog, type PdfLayoutProfile } from "./pdf-layout-profile.js";

// Bump when alignment/promotion semantics change without a public schema change.
export const PDF_LAYOUT_CACHE_VERSION = "pdf-layout-cache/v2-stable-font-identity";

export function pdfLayoutCacheKey(catalog: Pick<PdfLayoutCatalog, "pdf_sha256" | "markdown_sha256">): string {
  return sha256Json({ version: PDF_LAYOUT_CACHE_VERSION, catalog: PDF_LAYOUT_CATALOG_SCHEMA_VERSION,
    profile: PDF_LAYOUT_PROFILE_SCHEMA_VERSION, pdf: catalog.pdf_sha256, markdown: catalog.markdown_sha256 });
}

/** Recompile against current immutable source; cached derived coordinates are never trusted. */
export function verifiedPdfLayoutProfile(catalog: PdfLayoutCatalog, value: PdfLayoutProfile): PdfLayoutProfile | undefined {
  try {
    if (value.schema_version !== PDF_LAYOUT_PROFILE_SCHEMA_VERSION || !Array.isArray(value.structural_heading_lines)
      || value.pdf_sha256 !== catalog.pdf_sha256 || value.markdown_sha256 !== catalog.markdown_sha256) return undefined;
    const compiled = sealPdfLayoutProfile(catalog, value.rules, value.summary);
    return sha256Json(compiled) === sha256Json(value) ? compiled : undefined;
  } catch { return undefined; }
}

export async function readPdfLayoutCache(root: string, catalog: PdfLayoutCatalog): Promise<{
  status: "hit" | "miss" | "invalid"; key: string; profile?: PdfLayoutProfile;
}> {
  const key = pdfLayoutCacheKey(catalog);
  try {
    const entry = await readJson<{ version: string; key: string; profile_sha256: string; profile: PdfLayoutProfile }>(join(root, `${key}.json`));
    const profile = entry.version === PDF_LAYOUT_CACHE_VERSION && entry.key === key
      && sha256Json(entry.profile) === entry.profile_sha256 ? verifiedPdfLayoutProfile(catalog, entry.profile) : undefined;
    return profile ? { status: "hit", key, profile } : { status: "invalid", key };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "miss" : "invalid", key };
  }
}

export async function writePdfLayoutCache(root: string, catalog: PdfLayoutCatalog, profile: PdfLayoutProfile): Promise<void> {
  const verified = verifiedPdfLayoutProfile(catalog, profile);
  if (!verified) throw new Error("Cannot cache an unverified PDF layout profile");
  const key = pdfLayoutCacheKey(catalog);
  await atomicWriteJson(join(root, `${key}.json`), { version: PDF_LAYOUT_CACHE_VERSION, key, profile_sha256: sha256Json(verified), profile: verified });
}
