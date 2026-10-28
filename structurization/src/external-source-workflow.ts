import type { ExternalEditionProof } from "./external-source-edition.js";

/** External documents supply evidence, never a precomputed acceptance answer. */
export interface ExternalStandardDocument {
  standard_no: string;
  markdown: string;
  markdown_sha256: string;
  /** Private path for resolving the original Markdown's local companion images. */
  markdown_path?: string;
  edition_proof?: ExternalEditionProof;
}

export interface ExternalSourceRequest {
  standard_no: string;
  standard_title?: string;
  target_id: string;
  occurrence_id: string;
  origin_excerpt: string;
  origin_locator: string;
  dependent_fields: Array<"requirement" | "method" | "quantity" | "sampling">;
  reason: string;
}

/** An explicit host/UI decision, never a model-authored resolver argument. */
export interface ExternalSourceIgnoreDecision {
  decision_id: string;
  standard_no: string;
  job_id: string;
  created_at: string;
  reason: string;
}

export interface ExternalSourceWorkflow {
  lookup(standardNo: string): Promise<ExternalStandardDocument | undefined>;
  require(request: ExternalSourceRequest): Promise<void>;
  ignored?(standardNo: string): Promise<ExternalSourceIgnoreDecision | undefined>;
  /** Host-only original lookup, bound to an already admitted Markdown digest. Never accepts a client path. */
  originalPdf?(markdownSha256: string): Promise<{ path: string; sha256: string; kind?: 'original_pdf' | 'converted_pdf' } | undefined>;
}

export class ExternalSourceWaitError extends Error {
  readonly code = "waiting_for_external_source";
  constructor() {
    super("等待补充外部引用资料；已保留整批进度");
    this.name = "ExternalSourceWaitError";
  }
}

/** Publish a waiting state only after every cooperative worker has stopped. */
export class ExternalSourcePause {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private request: ExternalSourceRequest | undefined;
  constructor(private readonly parent?: AbortSignal) {
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
  }
  pause(request: ExternalSourceRequest): void {
    this.request ??= request;
    this.controller.abort(new ExternalSourceWaitError());
  }
  async finish(workers: Promise<unknown>[]): Promise<ExternalSourceRequest | undefined> {
    const outcomes = await Promise.allSettled(workers);
    this.parent?.throwIfAborted();
    if (this.request) return this.request;
    const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return undefined;
  }
}

export function normalizeStandardNo(value: string): string {
  return value.normalize("NFKC").replace(/[—–－−]/gu, "-").replace(/\s+/gu, "").toUpperCase();
}

export function standardNumberTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toUpperCase().replace(/[—–－−]/gu, "-");
  return [...normalized.matchAll(/(?<![A-Z0-9])([A-Z]{1,8}\d*(?:\s*\/\s*[A-Z]{1,8})?(?:[ \t]+[A-Z])?\s*(?:-\s*)?\d+(?:[ \t]*[.\-]\s*\d+)*)/gu)]
    .map(match => normalizeStandardNo(match[1]!));
}

/** Only the opening document declaration earns identity, never a filename or a later citation. */
export function declaredStandardNo(markdown: string): string | undefined {
  const head = markdown.slice(0, 2000).replace(/!\[[^\]]*\]\([^)]*\)|<img[^>]*>/giu, "");
  const declarations = head.split(/\r?\n/u).flatMap(line => /备案号|ISBN/iu.test(line) ? [] : standardNumberTokens(line))
    .filter(token => !/^(?:UDC|ICS|ISBN)/u.test(token));
  return declarations[0];
}

export function standardIdentityMatches(markdown: string, standardNo: string): boolean {
  const expected = normalizeStandardNo(standardNo);
  if (!expected || !/^[A-Z][A-Z0-9/.-]*\d$/u.test(expected)) return false;
  const declared = declaredStandardNo(markdown);
  if (!declared) return false;
  return /-\d{4}$/u.test(expected) ? declared === expected : declared.replace(/-\d{4}$/u, "") === expected;
}
