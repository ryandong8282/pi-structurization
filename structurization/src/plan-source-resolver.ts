import type {
  EvidenceManifest,
  PlanSourceSpan,
  SemanticSourcePlanV8,
} from "./contracts.js";
import { sha256Text } from "./canonical.js";
import { sourceSpanIdFor, type ResolvedSourceSpan, type SourceSpanIssue } from "./source-span-registry.js";

export interface PlanSourceResolver {
  resolve(spanId: string, path: string, issues: SourceSpanIssue[]): ResolvedSourceSpan | undefined;
  resolveMany(spanIds: readonly string[], path: string, issues: SourceSpanIssue[]): ResolvedSourceSpan[];
  evidenceIds(spanIds: readonly string[], path: string, issues: SourceSpanIssue[]): string[];
}

const SPAN_ID_PATTERN = /^span:[a-f0-9]{32}$/u;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Resolves compact plan provenance only from immutable evidence offsets. It
 * performs no substring search, fuzzy matching, or formatting inference.
 */
export function createPlanSourceResolver(
  plan: SemanticSourcePlanV8,
  manifest: EvidenceManifest,
): PlanSourceResolver {
  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const spansById = new Map<string, PlanSourceSpan>();
  const duplicateIds = new Set<string>();
  for (const span of plan.source_spans) {
    if (spansById.has(span.span_id)) duplicateIds.add(span.span_id);
    else spansById.set(span.span_id, span);
  }

  const resolve = (
    spanId: string,
    path: string,
    issues: SourceSpanIssue[],
  ): ResolvedSourceSpan | undefined => {
    if (!SPAN_ID_PATTERN.test(spanId)) {
      issues.push({
        code: "plan_span_id_format",
        path,
        message: "Plan source span handles must match ^span:[a-f0-9]{32}$",
        details: { span_id: spanId },
      });
      return undefined;
    }
    if (duplicateIds.has(spanId)) {
      issues.push({
        code: "plan_span_id_duplicate",
        path,
        message: "A compact plan source span handle must have exactly one catalog entry",
        details: { span_id: spanId },
      });
      return undefined;
    }
    const span = spansById.get(spanId);
    if (!span) {
      issues.push({
        code: "plan_unknown_span",
        path,
        message: "The compact plan names a source span absent from its plan-local catalog",
        details: { span_id: spanId },
      });
      return undefined;
    }
    const evidence = evidenceById.get(span.evidence_id);
    if (!evidence) {
      issues.push({
        code: "plan_span_unknown_evidence",
        path,
        message: "The plan-local source span names evidence outside the immutable manifest",
        details: { span_id: spanId, evidence_id: span.evidence_id },
      });
      return undefined;
    }
    if (
      !Number.isInteger(span.start)
      || !Number.isInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > evidence.text.length
    ) {
      issues.push({
        code: "plan_span_out_of_bounds",
        path,
        message: "Plan source span offsets must select non-empty text inside immutable evidence",
        details: {
          span_id: spanId,
          start: span.start,
          end: span.end,
          text_length: evidence.text.length,
        },
      });
      return undefined;
    }
    const text = evidence.text.slice(span.start, span.end);
    const textSha256 = sha256Text(text);
    if (textSha256 !== span.text_sha256) {
      issues.push({
        code: "plan_span_hash_mismatch",
        path,
        message: "Plan source span hash no longer matches the immutable evidence bytes",
        details: { span_id: spanId, expected: span.text_sha256, actual: textSha256 },
      });
      return undefined;
    }
    const expectedSpanId = sourceSpanIdFor(span.evidence_id, span.start, span.end, textSha256);
    if (spanId !== expectedSpanId) {
      issues.push({
        code: "plan_span_id_mismatch",
        path,
        message: "Plan source span handle is not the deterministic ID for its source coordinates",
        details: { span_id: spanId, expected: expectedSpanId },
      });
      return undefined;
    }
    return {
      ...span,
      atom_id: span.evidence_id,
      text,
    };
  };

  return {
    resolve,
    resolveMany(spanIds, path, issues) {
      return spanIds.flatMap((spanId, index) => {
        const span = resolve(spanId, `${path}/${index}`, issues);
        return span ? [span] : [];
      });
    },
    evidenceIds(spanIds, path, issues) {
      return unique(this.resolveMany(spanIds, path, issues).map((span) => span.evidence_id));
    },
  };
}
