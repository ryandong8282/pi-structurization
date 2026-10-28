/**
 * 选择器草稿「主证据必须处置」的单一判定。
 *
 * Prompt、阶段提示、compiler 兑现 residual、compiler invariant、strict validator
 * 都问这里：什么叫必须交代、绑没绑、兜底覆盖谁、提交时还漏谁。
 * 各层可以决定「现在拦不拦」，但不能各自发明「齐全」的定义。
 */

export type ResidualSourceDisposition = {
  disposition: "context" | "ignored";
  reason: string;
};

export type EvidenceDispositionRecord = {
  evidence_id: string;
  requires_disposition: boolean;
  evidence_scope?: "primary" | "reference" | "sampling";
  role?: string;
  table_fragment_id?: string;
};

export type SelectorDispositionCoverage = {
  required_evidence_ids: string[];
  bound_evidence_ids: string[];
  residual: ResidualSourceDisposition | undefined;
  residual_evidence_ids: string[];
  uncovered_required_ids: string[];
};

/** Selector authoring / compile / strict `unhandled_evidence` 的必处置集合。 */
export function evidenceRequiresSelectorDisposition(
  record: Pick<EvidenceDispositionRecord, "requires_disposition">,
): boolean {
  return record.requires_disposition;
}

/**
 * residual 可以一次性交代的集合：必处置，外加 primary（含 requires_disposition=false 的标题等）。
 * 多填的 primary 处置对 validator 无害；漏填必处置才会被打回。
 */
export function evidenceEligibleForResidualDisposition(
  record: EvidenceDispositionRecord,
): boolean {
  return record.requires_disposition || record.evidence_scope === "primary";
}

export function collectSelectorSpanIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (child: unknown, key = ""): void => {
    if (Array.isArray(child)) {
      if (key === "span_ids" || key.endsWith("_span_ids")) {
        const collect = (entry: unknown): void => {
          if (Array.isArray(entry)) entry.forEach(collect);
          else if (typeof entry === "string") ids.add(entry);
        };
        child.forEach(collect);
        return;
      }
      for (const entry of child) visit(entry);
      return;
    }
    if (!child || typeof child !== "object") return;
    for (const [childKey, grandchild] of Object.entries(child as Record<string, unknown>)) {
      visit(grandchild, childKey);
    }
  };
  visit(value);
  return ids;
}

export function compiledUnhandledEvidenceIds(
  plan: { evidence_dispositions: readonly { evidence_id: string }[] },
  evidence: readonly EvidenceDispositionRecord[],
): string[] {
  const disposed = new Set(plan.evidence_dispositions.map((row) => row.evidence_id));
  return evidence
    .filter((record) => evidenceRequiresSelectorDisposition(record) && !disposed.has(record.evidence_id))
    .map((record) => record.evidence_id);
}

/** Record-level disposition accounting only. Spans may overlap and are created on demand;
 * neither a bound record nor counting registered spans proves semantic completeness. */
export function selectorDispositionCoverage(input: {
  selectors: unknown;
  evidence: readonly EvidenceDispositionRecord[];
  spans: readonly { span_id: string; evidence_id: string }[];
  alreadyDisposedIds?: ReadonlySet<string>;
}): SelectorDispositionCoverage {
  const selectedSpanIds = collectSelectorSpanIds(input.selectors);
  const selectorRecord = input.selectors && typeof input.selectors === "object" && !Array.isArray(input.selectors)
    ? input.selectors as Record<string, unknown>
    : {};
  const businessSelectedSpanIds = collectSelectorSpanIds({
    ...selectorRecord,
    source_dispositions: [],
    residual_source_dispositions: [],
  });
  const evidenceById = new Map(input.evidence.map((record) => [record.evidence_id, record]));
  const selectedTableFragmentIds = new Set(input.spans
    .filter((span) => businessSelectedSpanIds.has(span.span_id))
    .flatMap((span) => {
      const fragmentId = evidenceById.get(span.evidence_id)?.table_fragment_id;
      return fragmentId ? [fragmentId] : [];
    }));
  const boundEvidenceIds = new Set(
    input.spans
      .filter((span) => selectedSpanIds.has(span.span_id))
      .map((span) => span.evidence_id),
  );
  for (const record of input.evidence) {
    if (
      record.table_fragment_id
      && selectedTableFragmentIds.has(record.table_fragment_id)
      && (record.role === "formal_table_header" || record.role === "table_continuation_caption")
    ) {
      boundEvidenceIds.add(record.evidence_id);
    }
  }
  const alreadyDisposed = input.alreadyDisposedIds ?? new Set<string>();
  const residual = residualFromSelectors(input.selectors);
  const required_evidence_ids = input.evidence
    .filter(evidenceRequiresSelectorDisposition)
    .map((record) => record.evidence_id);
  const residual_evidence_ids = residual
    ? input.evidence
      .filter((record) =>
        evidenceEligibleForResidualDisposition(record)
        && !boundEvidenceIds.has(record.evidence_id)
        && !alreadyDisposed.has(record.evidence_id)
      )
      .map((record) => record.evidence_id)
    : [];
  const residualCovered = new Set(residual_evidence_ids);
  const uncovered_required_ids = required_evidence_ids.filter((evidenceId) =>
    !boundEvidenceIds.has(evidenceId)
    && !alreadyDisposed.has(evidenceId)
    && !residualCovered.has(evidenceId)
  );
  return {
    required_evidence_ids,
    bound_evidence_ids: input.evidence
      .filter((record) => boundEvidenceIds.has(record.evidence_id))
      .map((record) => record.evidence_id),
    residual,
    residual_evidence_ids,
    uncovered_required_ids,
  };
}

function residualFromSelectors(selectors: unknown): ResidualSourceDisposition | undefined {
  if (!selectors || typeof selectors !== "object") return undefined;
  const residual = (selectors as { residual_source_dispositions?: unknown }).residual_source_dispositions;
  const first = Array.isArray(residual) ? residual[0] : undefined;
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const disposition = (first as { disposition?: unknown }).disposition;
  const reason = (first as { reason?: unknown }).reason;
  if ((disposition !== "context" && disposition !== "ignored") || typeof reason !== "string") {
    return undefined;
  }
  return { disposition, reason };
}
