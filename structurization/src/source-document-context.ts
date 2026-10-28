import type { EvidenceManifest } from "./contracts.js";

type SourceNames = Pick<EvidenceManifest["source"], "file_name" | "pdf_file_name">;

/** Presentation metadata is deliberately separate from frozen evidence identity. */
export function modelSourceDocumentContext(source: SourceNames, pdfDisplayName?: string) {
  const pdfName = pdfDisplayName?.trim() ? pdfDisplayName : source.pdf_file_name;
  return {
    markdown_file_name: source.file_name,
    ...(pdfName ? { pdf_file_name: pdfName } : {}),
    instruction: "文件名仅供资料导航和区分；标准身份、版本与引用依据必须核对正文和已登记来源。",
  };
}

export function sourceDocumentSessionNote(source: SourceNames, pdfDisplayName?: string): string {
  if (!pdfDisplayName?.trim()) return "";
  return `<source_document_context>\n${JSON.stringify(modelSourceDocumentContext(source, pdfDisplayName))}\n本轮主文档显示名以本段为准；历史内部文件名只是存储别名。此显示信息不改变原文、证据身份、检查点或已有识别结果。\n</source_document_context>`;
}
