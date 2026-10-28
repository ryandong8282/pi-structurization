import { canonicalize, sha256Text } from "./canonical.js";
import {
  TABLE_ASSEMBLY_SCHEMA_VERSION,
  type EvidenceManifest,
  type LogicalTableAssembly,
  type TableAssemblyPlan,
  type ValidationIssue,
} from "./contracts.js";
import { fallbackTableTitleEvidenceIds } from "./table-structure.js";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function titleFragmentsFor(
  logicalFragments: EvidenceManifest["table_fragments"],
  manifest: EvidenceManifest,
): LogicalTableAssembly["canonical_title_fragments"] {
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  const candidateSets = logicalFragments.map((fragment) =>
    fragment.title_candidate_evidence_ids
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((record) => record !== undefined)
      .map((record) => ({ evidence_id: record.evidence_id, text: record.text }))
  );
  return candidateSets.find((fragments) =>
    fragments.length > 0
    && !/^续表/.test(fragments.map((fragment) => fragment.text).join(""))
  ) ?? candidateSets.find((fragments) => fragments.length > 0) ?? [];
}

export function buildReviewableTableAssembly(
  manifest: EvidenceManifest,
): TableAssemblyPlan {
  const formalFragments = manifest.table_fragments.filter((fragment) =>
    fragment.formal_row_evidence_ids.length > 0
  );
  const grouped = new Map<string, typeof formalFragments>();
  for (const fragment of formalFragments) {
    const provisionalId = fragment.provisional_table_id || fragment.fragment_id;
    grouped.set(provisionalId, [
      ...(grouped.get(provisionalId) ?? []),
      fragment,
    ]);
  }
  const logicalTables = [...grouped.entries()].map(([logicalTableId, fragments]) => {
    const canonicalTitleFragments = titleFragmentsFor(fragments, manifest);
    return {
      logical_table_id: logicalTableId,
      canonical_title: canonicalTitleFragments.map((fragment) => fragment.text).join(""),
      canonical_title_fragments: canonicalTitleFragments,
      evidence_ids: unique(fragments.flatMap((fragment) => [
        ...fragment.title_candidate_evidence_ids,
        ...(fragment.continuation_caption_evidence_ids ?? []),
        fragment.header_evidence_ids[0] ?? "",
        fragment.formal_row_evidence_ids[0] ?? "",
        fragment.formal_row_evidence_ids.at(-1) ?? "",
      ])),
      fragment_ids: fragments.map((fragment) => fragment.fragment_id),
      reason: "确定性适配器仅给出候选分组，必须由语义组表判断确认或改写。",
      confidence: 0,
    };
  });
  return {
    schema_version: TABLE_ASSEMBLY_SCHEMA_VERSION,
    evidence_fingerprint: manifest.evidence_fingerprint,
    logical_tables: logicalTables,
    fragment_dispositions: manifest.table_fragments.map((fragment) => ({
      fragment_id: fragment.fragment_id,
      disposition: fragment.formal_row_evidence_ids.length ? "review" : "context",
      logical_table_id: fragment.formal_row_evidence_ids.length
        ? fragment.provisional_table_id || fragment.fragment_id
        : "",
      reason: fragment.formal_row_evidence_ids.length
        ? "待语义确认该物理表块属于哪一个规范逻辑表。"
        : "未识别到主控项目或一般项目数据行，作为上下文表块保留。",
    })),
  };
}

export function confirmProvisionalTableAssembly(
  manifest: EvidenceManifest,
): TableAssemblyPlan {
  const assembly = buildReviewableTableAssembly(manifest);
  assembly.logical_tables.forEach((logical) => {
    logical.reason = "离线测试确认候选物理表块属于同一规范逻辑表。";
    logical.confidence = 0.5;
  });
  assembly.fragment_dispositions.forEach((disposition) => {
    if (disposition.disposition === "review") {
      disposition.disposition = "assigned";
      disposition.reason = "离线测试确认该物理表块的逻辑表归属。";
    }
  });
  return assembly;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

export function tableAssemblyFingerprint(assembly: TableAssemblyPlan): string {
  return sha256Text(canonicalize(assembly));
}

export function validateTableAssembly(
  assembly: TableAssemblyPlan,
  manifest: EvidenceManifest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (assembly.evidence_fingerprint !== manifest.evidence_fingerprint) {
    issues.push({
      code: "table_assembly_evidence_mismatch",
      path: "/table_assembly/evidence_fingerprint",
      message: "Table assembly was not built against this exact evidence package",
        details: { required_action: "Table assembly was not built against this exact evidence package" }
});
  }
  const fragmentsById = new Map(
    manifest.table_fragments.map((fragment) => [fragment.fragment_id, fragment]),
  );
  const evidenceById = new Map(
    manifest.evidence.map((record) => [record.evidence_id, record]),
  );
  const semanticWorkflow = manifest.source.adapter === "document-domain-agent/v1"
    && Boolean(manifest.source.semantic_workflow);
  const logicalIds = assembly.logical_tables.map((logical) => logical.logical_table_id);
  for (const duplicate of duplicates(logicalIds)) {
    issues.push({
      code: "duplicate_logical_table_id",
      path: "/table_assembly/logical_tables",
      message: `Logical table ID is duplicated: ${duplicate}`,
        details: { required_action: "Fix duplicate logical table id" }
});
  }
  const dispositionIds = assembly.fragment_dispositions.map((row) => row.fragment_id);
  for (const duplicate of duplicates(dispositionIds)) {
    issues.push({
      code: "duplicate_table_fragment_disposition",
      path: "/table_assembly/fragment_dispositions",
      message: `Table fragment has multiple dispositions: ${duplicate}`,
        details: { required_action: "Fix duplicate table fragment disposition" }
});
  }
  const unknownDispositions = dispositionIds.filter((id) => !fragmentsById.has(id));
  if (unknownDispositions.length) {
    issues.push({
      code: "unknown_table_fragment",
      path: "/table_assembly/fragment_dispositions",
      message: "Table assembly names unknown physical fragments",
        details: {
          required_action: "Name only fragments that exist in this table assembly",
          actual: unique(unknownDispositions),
        },
});
  }
  const missingDispositions = [...fragmentsById.keys()].filter((id) =>
    !dispositionIds.includes(id)
  );
  if (missingDispositions.length) {
    issues.push({
      code: "missing_table_fragment_disposition",
      path: "/table_assembly/fragment_dispositions",
      message: "Every physical table fragment must be assigned, contextualized, or left for review",
      details: { required_action: "Every physical table fragment must be assigned, contextualized, or left for review", actual: missingDispositions },
    });
  }

  const assignedByLogical = new Map<string, string[]>();
  assembly.fragment_dispositions.forEach((row, index) => {
    const fragment = fragmentsById.get(row.fragment_id);
    if (row.disposition === "review") {
      issues.push({
        code: "table_fragment_review_required",
        path: `/table_assembly/fragment_dispositions/${index}`,
        message: "A semantic table-assembly decision is still unresolved",
        details: { required_action: "A semantic table-assembly decision is still unresolved" }
});
    }
    if (row.disposition === "assigned") {
      if (!logicalIds.includes(row.logical_table_id)) {
        issues.push({
          code: "unknown_logical_table_relation",
          path: `/table_assembly/fragment_dispositions/${index}/logical_table_id`,
          message: "Assigned fragment names an unknown logical table",
        details: { required_action: "Assigned fragment names an unknown logical table" }
});
      }
      assignedByLogical.set(row.logical_table_id, [
        ...(assignedByLogical.get(row.logical_table_id) ?? []),
        row.fragment_id,
      ]);
    } else if (row.disposition === "context" && row.logical_table_id) {
      issues.push({
        code: "non_assigned_fragment_relation",
        path: `/table_assembly/fragment_dispositions/${index}/logical_table_id`,
        message: "Context or review fragments must not claim a logical table relation",
        details: { required_action: "Context or review fragments must not claim a logical table relation" }
});
    }
    if (
      fragment?.formal_row_evidence_ids.length
      && row.disposition !== "assigned"
      && !semanticWorkflow
    ) {
      issues.push({
        code: "formal_table_fragment_unassigned",
        path: `/table_assembly/fragment_dispositions/${index}`,
        message: "Every fragment containing formal quality rows must belong to exactly one logical table",
        details: { required_action: "Every fragment containing formal quality rows must belong to exactly one logical table" }
});
    }
  });

  const fragmentOwners = new Map<string, string>();
  assembly.logical_tables.forEach((logical, index) => {
    const path = `/table_assembly/logical_tables/${index}`;
    if (/(?:^|[:_-])line(?:[:_-]|$)/i.test(logical.logical_table_id)
      || /^table-fragment:/i.test(logical.logical_table_id)) {
      issues.push({
        code: "physical_locator_as_logical_table_id",
        path: `${path}/logical_table_id`,
        message: "A line or physical-fragment locator cannot become an authoritative logical table ID",
        details: { required_action: "A line or physical-fragment locator cannot become an authoritative logical table ID" }
});
    }
    if (/^续表/.test(logical.canonical_title) || /表@line|line-\d+/i.test(logical.canonical_title)) {
      issues.push({
        code: "noncanonical_table_title",
        path: `${path}/canonical_title`,
        message: "Canonical inspection-lot names cannot be continuation captions or line-based fallbacks",
        details: { required_action: "Canonical inspection-lot names cannot be continuation captions or line-based fallbacks" }
});
    }
    if (!logical.reason.trim()) {
      issues.push({
        code: "table_assembly_reason_missing",
        path: `${path}/reason`,
        message: "Every logical table decision needs an auditable semantic reason",
        details: { required_action: "Every logical table decision needs an auditable semantic reason" }
});
    }
    if (logical.row_roles) {
      const expectedRows = unique(logical.fragment_ids.flatMap(id => fragmentsById.get(id)?.row_evidence_ids ?? []))
        .filter(id => Boolean(evidenceById.get(id)?.text.trim()));
      const actualRows = logical.row_roles.map(row => row.evidence_id);
      const invalid = logical.row_roles.filter(row => !row.reason.trim()
        || !["header", "data", "repeated_header", "note", "context"].includes(row.role));
      const missing = expectedRows.filter(id => !actualRows.includes(id));
      const foreign = actualRows.filter(id => !expectedRows.includes(id));
      const repeated = duplicates(actualRows);
      if (missing.length || foreign.length || repeated.length || invalid.length) issues.push({
        code: "table_assembly_row_roles_invalid", path: `${path}/row_roles`,
        message: "Confirmed row roles must partition exactly the rows owned by this logical table, with source-based reasons",
        details: { actual: { missing, foreign, repeated, invalid },
          required_action: "Read the saved table structure and repair its complete row partition; do not edit compiled row roles",
          next_tool: "read_saved_table_structure", not_writable: "Compiled table_assembly.row_roles" },
      });
    }
    const unknownFragments = logical.fragment_ids.filter((id) => !fragmentsById.has(id));
    if (unknownFragments.length) {
      issues.push({
        code: "unknown_logical_table_fragment",
        path: `${path}/fragment_ids`,
        message: "Logical table contains unknown physical fragments",
        details: {
          required_action: "Remove unknown fragment ids, or add those fragments to the assembly",
          actual: unique(unknownFragments),
        },
});
    }
    for (const fragmentId of logical.fragment_ids) {
      const previousOwner = fragmentOwners.get(fragmentId);
      if (previousOwner) {
        issues.push({
          code: "duplicate_table_fragment_owner",
          path: `${path}/fragment_ids`,
          message: `Physical fragment ${fragmentId} is already owned by ${previousOwner}`,
        details: { required_action: "Fix duplicate table fragment owner" }
});
      }
      fragmentOwners.set(fragmentId, logical.logical_table_id);
    }
    const expectedFragments = [...(assignedByLogical.get(logical.logical_table_id) ?? [])].sort();
    if (canonicalize([...logical.fragment_ids].sort()) !== canonicalize(expectedFragments)) {
      issues.push({
        code: "table_fragment_relation_mismatch",
        path: `${path}/fragment_ids`,
        message: "Logical-table fragment_ids must exactly match assigned fragment dispositions",
        details: { required_action: "Logical-table fragment_ids must exactly match assigned fragment dispositions", expected: expectedFragments, actual: logical.fragment_ids },
      });
    }
    const hasPhysicalFragments = logical.fragment_ids.length > 0;
    if (logical.row_roles?.length) {
      const rowIds = logical.row_roles.map(row => row.evidence_id);
      const memberRows = new Set(logical.fragment_ids.flatMap(id => fragmentsById.get(id)?.row_evidence_ids ?? []));
      // A fragment's corrected roles are a complete partition, not a list of
      // individual rows that downstream checks should silently exempt.
      const touchedRows = unique(logical.fragment_ids.flatMap(id => {
        const rows = fragmentsById.get(id)?.row_evidence_ids ?? [];
        return rows.some(row => rowIds.includes(row)) ? rows : [];
      }));
      const foreignRows = rowIds.filter(id => !memberRows.has(id) || evidenceById.get(id)?.kind !== "table_row");
      const missingRows = touchedRows.filter(id => !rowIds.includes(id));
      const duplicateRows = duplicates(rowIds);
      const missingReasons = logical.row_roles.filter(row => !row.reason.trim()).map(row => row.evidence_id);
      if (foreignRows.length || missingRows.length || duplicateRows.length || missingReasons.length) {
        issues.push({
          code: "table_assembly_row_roles_invalid",
          path: `${path}/row_roles`,
          message: "Confirmed row roles must cover every row of each corrected physical fragment exactly once, with a reason",
          details: {
            actual: logical.row_roles,
            foreign_row_ids: foreignRows, missing_row_ids: missingRows,
            duplicate_row_ids: duplicateRows, missing_reason_row_ids: missingReasons,
            required_action: "Read the saved table structure, correct its row partition and reasons, confirm it, then recompile the selectors. Do not edit generated table_assembly metadata.",
            writable_surface: "table_structure.tables: header_rows, data_rows, repeated_header_rows, note_rows, context_rows, row_role_overrides, reason",
            next_tool: "read_saved_table_structure",
          },
        });
      }
    }
    const hasQualityRows = logical.fragment_ids.some((id) => {
      const fragment = fragmentsById.get(id);
      return (fragment?.formal_row_evidence_ids.length ?? 0) > 0
        || (fragment?.row_evidence_ids ?? []).some((evidenceId) =>
          evidenceById.get(evidenceId)?.table_row_kind === "data"
        );
    });
    if (hasPhysicalFragments && !hasQualityRows) {
      issues.push({
        code: "logical_table_without_formal_rows",
        path: `${path}/fragment_ids`,
        message: "A logical inspection table must contain formal quality rows",
        details: { required_action: "A logical inspection table must contain formal quality rows" }
});
    }
    const allowedTitleEvidence = hasPhysicalFragments
      ? new Set(logical.fragment_ids.flatMap((id) =>
          fragmentsById.get(id)?.title_candidate_evidence_ids ?? []
        ))
      : new Set(evidenceById.keys());
    const fallbackTitleEvidence = hasPhysicalFragments && allowedTitleEvidence.size === 0
      ? fallbackTableTitleEvidenceIds(logical.fragment_ids, manifest)
      : new Set<string>();
    const allowedAssemblyEvidence = hasPhysicalFragments
      ? new Set(logical.fragment_ids.flatMap((id) => {
          const fragment = fragmentsById.get(id);
          return fragment
            ? [
                ...fragment.title_candidate_evidence_ids,
                ...fallbackTitleEvidence,
                ...(fragment.continuation_caption_evidence_ids ?? []),
                ...fragment.header_evidence_ids,
                ...fragment.formal_row_evidence_ids,
                ...(logical.row_roles ?? []).filter(row =>
                  (row.role === "header" || row.role === "repeated_header")
                  && fragment.row_evidence_ids.includes(row.evidence_id)
                ).map(row => row.evidence_id),
              ]
            : [];
        }))
      : new Set(evidenceById.keys());
    const unknownEvidence = logical.evidence_ids.filter((id) =>
      !evidenceById.has(id) || !allowedAssemblyEvidence.has(id)
    );
    if (unknownEvidence.length) {
      issues.push({
        code: "table_assembly_evidence_out_of_scope",
        path: `${path}/evidence_ids`,
        message: hasPhysicalFragments
          ? "Logical table may cite only title, continuation-caption, header, or formal-row evidence attached to its physical fragments"
          : "Semantic-only logical table may cite only evidence registered in this manifest",
        details: {
          required_action: "Cite only evidence attached to this logical table's fragments",
          actual: unique(unknownEvidence),
        },
});
    }
    const fragmentsWithoutRowEvidence = logical.fragment_ids.filter((id) => {
      const fragment = fragmentsById.get(id);
      return fragment?.formal_row_evidence_ids.length
        && !fragment.formal_row_evidence_ids.some((evidenceId) =>
          logical.evidence_ids.includes(evidenceId)
        );
    });
    if (fragmentsWithoutRowEvidence.length) {
      issues.push({
        code: "table_fragment_semantic_evidence_missing",
        path: `${path}/evidence_ids`,
        message: "Every assigned formal fragment needs representative row evidence for semantic assembly",
        details: { required_action: "Every assigned formal fragment needs representative row evidence for semantic assembly", actual: fragmentsWithoutRowEvidence },
      });
    }
    const fragmentKeys = logical.canonical_title_fragments.map((fragment) =>
      `${fragment.evidence_id}\0${fragment.text}`
    );
    const invalidTitleFragments = logical.canonical_title_fragments.filter((fragment) => {
      const evidence = evidenceById.get(fragment.evidence_id);
      return !(allowedTitleEvidence.has(fragment.evidence_id) || fallbackTitleEvidence.has(fragment.evidence_id))
        || !logical.evidence_ids.includes(fragment.evidence_id)
        || !evidence
        || !evidence.text.includes(fragment.text);
    });
    const missingRequiredTitleFragments = Boolean(logical.canonical_title.trim())
      && logical.canonical_title_fragments.length === 0;
    if (missingRequiredTitleFragments || invalidTitleFragments.length) {
      issues.push({
        code: "table_title_fragment_mismatch",
        path: `${path}/canonical_title_fragments`,
        message: hasPhysicalFragments
          ? "Canonical title fragments must be exact text from a registered title candidate or an explicitly selected in-scope fallback paragraph"
          : "Canonical title fragments must be exact text from cited manifest evidence",
        details: { required_action: "Fix table title fragment mismatch", actual: invalidTitleFragments },
      });
    }
    if (duplicates(fragmentKeys).length) {
      issues.push({
        code: "duplicate_table_title_fragment",
        path: `${path}/canonical_title_fragments`,
        message: "The same exact canonical title fragment must not be repeated",
        details: { required_action: "The same exact canonical title fragment must not be repeated" }
});
    }
    const composedTitle = logical.canonical_title_fragments
      .map((fragment) => fragment.text)
      .join("");
    if (normalizedTitle(logical.canonical_title) !== normalizedTitle(composedTitle)) {
      issues.push({
        code: "table_title_composition_mismatch",
        path: `${path}/canonical_title`,
        message: "Canonical title must be composed only from its exact source fragments",
        details: { required_action: "Canonical title must be composed only from its exact source fragments", composed_title: composedTitle },
      });
    }
  });
  return issues;
}
