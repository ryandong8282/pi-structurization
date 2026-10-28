import { sha256Text } from "./canonical.js";
import { compiledUnhandledEvidenceIds } from "./evidence-disposition-coverage.js";
import type {
  AcceptanceItemField,
  PersistedSemanticSourcePlan,
  EvidenceManifest,
  SemanticSourcePlan,
  SemanticSourcePlanV8,
  ValidationIssue,
} from "./contracts.js";
import { semanticItemIdForSelectorKey } from "./semantic-decision-compiler.js";
import { validateSemanticDraft } from "./semantic-draft.js";
import { validateTableAssembly } from "./table-assembly.js";
import type { TargetSelectorPlan } from "./target-selector-compiler.js";

export interface CompilerInvariantIssue extends ValidationIssue {
  owner: "compiler_invariant_violation";
  selector_path?: string;
}

function invariant(
  code: string,
  path: string,
  message: string,
  details?: unknown,
  selectorPath?: string,
): CompilerInvariantIssue {
  const payload = details !== undefined && typeof details === "object" && details !== null && !Array.isArray(details)
    ? { required_action: message, ...(details as Record<string, unknown>) }
    : { required_action: message, ...(details === undefined ? {} : { actual: details }) };
  return {
    code,
    path,
    message,
    details: payload,
    owner: "compiler_invariant_violation",
    ...(selectorPath ? { selector_path: selectorPath } : {}),
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function compactSamplingContextIssues(
  plan: SemanticSourcePlanV8,
  manifest: EvidenceManifest,
  selectors: TargetSelectorPlan,
): CompilerInvariantIssue[] {
  const spanById = new Map(plan.source_spans.map((span) => [span.span_id, span]));
  const semanticById = new Map((plan.semantic_evidence ?? []).map((node, index) => [
    node.semantic_id,
    { node, index },
  ]));
  const intervalKey = (span: SemanticSourcePlanV8["source_spans"][number]) => (
    `${span.evidence_id}\0${span.start}\0${span.end}`
  );
  type SamplingSource = {
    span: SemanticSourcePlanV8["source_spans"][number];
    receiver_item_ids: Set<string>;
    source_paths: Set<string>;
    semantic_indexes: Set<number>;
  };
  const issues: CompilerInvariantIssue[] = [];
  const sourcesByInterval = new Map<string, SamplingSource>();
  const addSource = (
    spanId: string,
    path: string,
    receiverItemIds: readonly string[],
    semanticIndex: number | undefined,
  ) => {
    const span = spanById.get(spanId);
    if (!span) return;
    const key = intervalKey(span);
    const source = sourcesByInterval.get(key) ?? {
      span,
      receiver_item_ids: new Set<string>(),
      source_paths: new Set<string>(),
      semantic_indexes: new Set<number>(),
    };
    receiverItemIds.forEach((itemId) => source.receiver_item_ids.add(itemId));
    source.source_paths.add(path);
    if (semanticIndex !== undefined) source.semantic_indexes.add(semanticIndex);
    sourcesByInterval.set(key, source);
  };
  const exactValueMember = (
    evidenceIds: readonly string[],
    value: string,
    path: string,
  ): { spanId: string; path: string }[] => {
    if (!value) return [];
    const matches = evidenceIds.flatMap((evidenceId) => {
      const text = manifest.evidence.find((record) => record.evidence_id === evidenceId)?.text;
      if (!text) return [];
      const start = text.indexOf(value);
      if (start < 0 || text.indexOf(value, start + 1) >= 0) return [];
      const span = plan.source_spans.find((candidate) => (
        candidate.evidence_id === evidenceId
        && candidate.start === start
        && candidate.end === start + value.length
      ));
      return span ? [{ spanId: span.span_id, path }] : [];
    });
    return matches.length === 1 ? matches : [];
  };
  const branchReceivers = new Map<string, Set<string>>();
  plan.acceptance_items.forEach((item) => {
    (item.sampling.applied_branches ?? []).forEach((branch) => {
      const key = `${branch.rule_id}\0${branch.branch_id}`;
      const receivers = branchReceivers.get(key) ?? new Set<string>();
      receivers.add(item.item_id);
      branchReceivers.set(key, receivers);
    });
  });
  for (const [ruleIndex, rule] of (plan.shared_sampling_rules ?? []).entries()) {
    const semanticEntry = semanticById.get(rule.source_semantic_id);
    const semanticIndex = semanticEntry?.index;
    const ruleMembers = rule.components.flatMap((component, componentIndex) => (
      component.disposition === "present"
        ? component.source_span_ids.map((spanId, spanIndex) => ({
            spanId,
            path: `/shared_sampling_rules/${ruleIndex}/components/${componentIndex}/source_span_ids/${spanIndex}`,
          }))
        : []
    ));
    ruleMembers.forEach((member) => addSource(
      member.spanId,
      member.path,
      rule.receiving_item_ids,
      semanticIndex,
    ));
    const branchMembers = rule.branches.flatMap((branch, branchIndex) => {
      const componentMembers = branch.components.flatMap((component, componentIndex) => (
        component.disposition === "present"
          ? component.source_span_ids.map((spanId, spanIndex) => ({
              spanId,
              path: `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/components/${componentIndex}/source_span_ids/${spanIndex}`,
            }))
          : []
      ));
      const conditionMembers = (branch.conditions ?? []).flatMap((condition, conditionIndex) => (
        condition.source_span_ids.map((spanId, spanIndex) => ({
          spanId,
          path: `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/conditions/${conditionIndex}/source_span_ids/${spanIndex}`,
        }))
      ));
      const exactValueMembers = [
        ...exactValueMember(
          rule.evidence_ids,
          branch.min_sampling,
          `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/min_sampling`,
        ),
        ...exactValueMember(
          rule.evidence_ids,
          branch.script,
          `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/script`,
        ),
      ];
      // Inline explicit rules do not author compact component records. Their
      // branch source spans are normally the durable method/script members.
      // Exact hydrated values recover a separately registered quantity when
      // the branch span catalog contains only the method member.
      const members = [
        ...(componentMembers.length > 0
          ? componentMembers
          : [
              ...branch.source_span_ids.map((spanId, spanIndex) => ({
                spanId,
                path: `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/source_span_ids/${spanIndex}`,
              })),
              ...exactValueMembers,
            ]),
        ...conditionMembers,
      ];
      const receivers = branchReceivers.get(`${rule.rule_id}\0${branch.branch_id}`) ?? new Set<string>();
      members.forEach((member) => addSource(
        member.spanId,
        member.path,
        [...receivers],
        semanticIndex,
      ));
      return members;
    });
    const sharedConditionMembers = rule.shared_conditions.flatMap((condition, conditionIndex) => (
      condition.source_span_ids.map((spanId, spanIndex) => ({
        spanId,
        path: `/shared_sampling_rules/${ruleIndex}/shared_conditions/${conditionIndex}/source_span_ids/${spanIndex}`,
      }))
    ));
    sharedConditionMembers.forEach((member) => addSource(
      member.spanId,
      member.path,
      rule.receiving_item_ids,
      semanticIndex,
    ));
    const typedMembers = [...ruleMembers, ...branchMembers, ...sharedConditionMembers];
    if (typedMembers.length === 0) {
      rule.complete_span_ids.forEach((spanId, spanIndex) => addSource(
        spanId,
        `/shared_sampling_rules/${ruleIndex}/complete_span_ids/${spanIndex}`,
        rule.receiving_item_ids,
        semanticIndex,
      ));
    }
    const semanticSpan = semanticEntry ? spanById.get(semanticEntry.node.span_id) : undefined;
    const typedSpans = typedMembers.flatMap((member) => {
      const span = spanById.get(member.spanId);
      return span ? [{ ...member, span }] : [];
    });
    const semanticContainsTypedMembers = semanticSpan
      && typedSpans.length === typedMembers.length
      && typedSpans.every(({ span }) => (
        span.evidence_id === semanticSpan.evidence_id
        && span.start >= semanticSpan.start
        && span.end <= semanticSpan.end
      ));
    const typedMemberEvidenceIds = new Set(typedSpans.map(({ span }) => span.evidence_id));
    const semanticAnchorsTypedMember = semanticSpan
      && typedSpans.length === typedMembers.length
      && typedSpans.some(({ span }) => (
        span.evidence_id === semanticSpan.evidence_id
        && span.start >= semanticSpan.start
        && span.end <= semanticSpan.end
      ));
    const semanticBindingValid = typedMemberEvidenceIds.size > 1
      ? semanticAnchorsTypedMember
      : semanticContainsTypedMembers;
    if (
      typedMembers.length > 0
      && (semanticEntry?.node.role !== "sampling_rule" || !semanticBindingValid)
    ) {
      issues.push(invariant(
        "compiler_sampling_source_semantic_member_mismatch",
        semanticIndex === undefined ? `/shared_sampling_rules/${ruleIndex}/source_semantic_id` : `/semantic_evidence/${semanticIndex}`,
        typedMemberEvidenceIds.size > 1
          ? "A multi-evidence sampling rule must use a sampling_rule semantic anchor that contains one durable typed member; every member remains bound independently"
          : "The compiled sampling source semantic interval must contain every durable typed member of its rule",
        {
          rule_id: rule.rule_id,
          source_semantic_id: rule.source_semantic_id,
          source_semantic_span_id: semanticEntry?.node.span_id ?? "",
          source_semantic_role: semanticEntry?.node.role ?? "",
          member_bindings: typedSpans.map(({ spanId, path, span }) => ({
            span_id: spanId,
            path,
            evidence_id: span.evidence_id,
            start: span.start,
            end: span.end,
          })),
        },
      ));
    }
  }
  return issues;
}

export function checkTargetCompilerInvariants(
  selectors: TargetSelectorPlan,
  plan: SemanticSourcePlan,
  manifest: EvidenceManifest,
  persistedPlan?: PersistedSemanticSourcePlan,
): CompilerInvariantIssue[] {
  const issues: CompilerInvariantIssue[] = [];
  const items = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
  const itemIds = new Set(items.keys());
  const selectorItemsByCompiledId = new Map(selectors.items.map((item, index) => [
    semanticItemIdForSelectorKey(selectors.target_id, item.key),
    { item, index },
  ]));

  if (plan.job_id !== selectors.job_id || plan.target_id !== selectors.target_id) {
    issues.push(invariant(
      "compiler_identity_mismatch",
      "/",
      "Compiled job/target identity must equal the selector identity",
      { selector_job_id: selectors.job_id, selector_target_id: selectors.target_id },
    ));
  }
  if (plan.evidence_fingerprint !== manifest.evidence_fingerprint) {
    issues.push(invariant(
      "compiler_evidence_fingerprint_mismatch",
      "/evidence_fingerprint",
      "Compiled plan must retain the immutable evidence fingerprint",
    ));
  }

  const compiledLotByName = new Map(plan.inspection_lots.map((lot) => [lot.name, lot]));
  selectors.lots.forEach((selectorLot, lotIndex) => {
    const lot = compiledLotByName.get(selectorLot.name);
    if (!lot) {
      issues.push(invariant(
        "compiler_lot_missing",
        "/inspection_lots",
        "Every selector lot must materialize exactly once",
        { lot_key: selectorLot.key, name: selectorLot.name },
        `/lots/${lotIndex}`,
      ));
      return;
    }
    const expectedItemIds = plan.acceptance_items
      .filter((item) => item.lot_id === lot.lot_id)
      .map((item) => item.item_id);
    if (!sameStrings(lot.item_ids, expectedItemIds)) {
      issues.push(invariant(
        "compiler_lot_membership_mismatch",
        `/inspection_lots/${plan.inspection_lots.indexOf(lot)}/item_ids`,
        "Lot membership must be derived from selector item lot_key values",
        { expected: expectedItemIds, actual: lot.item_ids },
        `/lots/${lotIndex}`,
      ));
    }
  });
  plan.inspection_lots.forEach((lot, lotIndex) => {
    for (const itemId of lot.item_ids) {
      const item = items.get(itemId);
      if (!item || item.lot_id !== lot.lot_id) {
        issues.push(invariant(
          "compiler_lot_item_relation_mismatch",
          `/inspection_lots/${lotIndex}/item_ids`,
          "Lot item_ids and item lot_id must form the same bidirectional relation",
          { item_id: itemId, item_lot_id: item?.lot_id ?? "" },
        ));
      }
    }
  });

  const fields: AcceptanceItemField[] = ["name", "requirement", "method", "quantity", "note"];
  plan.acceptance_items.forEach((item, itemIndex) => {
    const selectorEntry = selectorItemsByCompiledId.get(item.item_id);
    const selectorItem = selectorEntry?.item;
    const selectorItemIndex = selectorEntry?.index ?? itemIndex;
    if (!plan.inspection_lots.some((lot) => lot.lot_id === item.lot_id && lot.item_ids.includes(item.item_id))) {
      issues.push(invariant(
        "compiler_item_membership_missing",
        `/acceptance_items/${itemIndex}/lot_id`,
        "Every compiled item must belong to exactly one compiled lot",
      ));
    }
    for (const field of fields) {
      const binding = item.field_bindings[field];
      if (!binding) {
        issues.push(invariant(
          "compiler_field_binding_missing",
          `/acceptance_items/${itemIndex}/field_bindings/${field}`,
          "Compiler must generate every field binding",
        ));
        continue;
      }
      if (binding.value_sha256 !== sha256Text(item[field])) {
        issues.push(invariant(
          "compiler_field_hash_mismatch",
          `/acceptance_items/${itemIndex}/field_bindings/${field}/value_sha256`,
          "Field binding hash must be derived from the compiled field value",
        ));
      }
      const fragmentEvidence = [...new Set(binding.source_fragments.map((fragment) => fragment.evidence_id))];
      if (!sameStrings(binding.evidence_ids, fragmentEvidence)) {
        issues.push(invariant(
          "compiler_field_evidence_mismatch",
          `/acceptance_items/${itemIndex}/field_bindings/${field}/evidence_ids`,
          "Binding evidence_ids must be derived from its exact source fragments",
          { expected: fragmentEvidence, actual: binding.evidence_ids },
        ));
      }
    }
    if (item.table_semantics) {
      const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record.text]));
      const requiredRoles = ([
        ["table_no", item.table_semantics.table_no],
        ["table_title", item.table_semantics.table_title],
        ["applicability", item.table_semantics.applicability],
        ["unit", item.table_semantics.unit],
        ["condition", item.table_semantics.condition],
        ["allowed_value", item.table_semantics.allowed_value],
        ["inspection_method", item.table_semantics.inspection_method],
      ] as const).filter(([, value]) => Boolean(value));
      for (const [role] of requiredRoles) {
        if (!item.table_semantics.cell_evidence.some((cell) => cell.role === role)) {
          issues.push(invariant(
            "compiler_table_property_evidence_missing",
            `/acceptance_items/${itemIndex}/table_semantics/cell_evidence`,
            "Every non-empty compiled table fact must retain role-specific source evidence",
            { role },
          ));
        }
      }
      item.table_semantics.cell_evidence.forEach((cell, cellIndex) => {
        if (!evidenceById.get(cell.evidence_id)?.includes(cell.text)) {
          issues.push(invariant(
            "compiler_table_cell_not_exact",
            `/acceptance_items/${itemIndex}/table_semantics/cell_evidence/${cellIndex}`,
            "Table cell evidence must be exact immutable source text",
            { evidence_id: cell.evidence_id, role: cell.role },
          ));
        }
      });
      const expectedAcceptanceBranches = selectorItem?.table?.properties.acceptance_branches ?? [];
      const compiledAcceptanceBranches = item.table_semantics.acceptance_branches ?? [];
      if (compiledAcceptanceBranches.length !== expectedAcceptanceBranches.length) {
        issues.push(invariant(
          "compiler_table_acceptance_branch_mismatch",
          `/acceptance_items/${itemIndex}/table_semantics/acceptance_branches`,
          "Compiler must preserve every selector-authored condition -> requirement/allowed-value branch on the same item",
          { expected_count: expectedAcceptanceBranches.length, actual_count: compiledAcceptanceBranches.length },
          `/items/${selectorItemIndex}/table/properties/acceptance_branches`,
        ));
      }
      compiledAcceptanceBranches.forEach((branch, branchIndex) => {
        for (const [field, fragments] of [
          ["condition", branch.condition_fragments],
          ["requirement", branch.requirement_fragments],
          ["allowed_value", branch.allowed_value_fragments],
        ] as const) {
          fragments.forEach((fragment, fragmentIndex) => {
            if (evidenceById.get(fragment.evidence_id)?.includes(fragment.text)) return;
            issues.push(invariant(
              "compiler_table_acceptance_branch_not_exact",
              `/acceptance_items/${itemIndex}/table_semantics/acceptance_branches/${branchIndex}/${field}_fragments/${fragmentIndex}`,
              "Compiled acceptance branch provenance must remain exact immutable source text",
              { branch_id: branch.branch_id, evidence_id: fragment.evidence_id },
            ));
          });
        }
      });
    }
    if (
      selectorItem?.sampling.status === "reference"
      || selectorItem?.sampling.status === "reference_unspecified_quantity"
    ) {
      const selectorRuleIndex = selectors.sampling_rules.findIndex((rule) => rule.key === selectorItem.sampling.rule_key);
      const selectorRule = selectors.sampling_rules[selectorRuleIndex];
      const compiledRule = (plan.shared_sampling_rules ?? [])[selectorRuleIndex];
      if (selectorRule && compiledRule) {
        const selectedBranchKeys = new Set(selectorItem.sampling.branch_keys);
        const selectedIndexes = selectorRule.branches.flatMap((branch, branchIndex) =>
          selectedBranchKeys.has(branch.key) ? [branchIndex] : []
        );
        const expectedBranches = selectedIndexes.flatMap((branchIndex) => {
          const branch = compiledRule.branches[branchIndex];
          return branch ? [branch] : [];
        });
        const expectedBranchIds = expectedBranches.map((branch) => branch.branch_id);
        const appliedBranches = item.sampling.applied_branches ?? [];
        if (
          !sameStrings(item.sampling.branch_ids ?? [], expectedBranchIds)
          || !sameStrings(appliedBranches.map((branch) => branch.branch_id), expectedBranchIds)
        ) {
          issues.push(invariant(
            "compiler_sampling_branch_selection_mismatch",
            `/acceptance_items/${itemIndex}/sampling/applied_branches`,
            "Compiler must materialize exactly the shared-rule branches explicitly selected for the item",
            {
              expected_branch_ids: expectedBranchIds,
              actual_branch_ids: item.sampling.branch_ids ?? [],
              applied_branch_ids: appliedBranches.map((branch) => branch.branch_id),
            },
            `/items/${selectorItemIndex}/sampling/branch_keys`,
          ));
        }
        for (const [appliedIndex, applied] of appliedBranches.entries()) {
          const expected = expectedBranches.find((branch) => branch.branch_id === applied.branch_id);
          if (!expected) continue;
          if (
            applied.rule_id !== compiledRule.rule_id
            || applied.min_sampling !== expected.min_sampling
            || applied.script !== expected.script
            || JSON.stringify(applied.conditions) !== JSON.stringify(expected.conditions ?? [])
          ) {
            issues.push(invariant(
              "compiler_sampling_branch_relation_mismatch",
              `/acceptance_items/${itemIndex}/sampling/applied_branches/${appliedIndex}`,
              "Compiler must preserve each applied branch's condition, method, and quantity relation",
              { expected, actual: applied },
              `/items/${selectorItemIndex}/sampling/branch_keys`,
            ));
          }
        }
      }
    }
  });

  for (const [ruleIndex, rule] of (plan.shared_sampling_rules ?? []).entries()) {
    const expectedReceivers = plan.acceptance_items
      .filter((item) => item.sampling.rule_ids?.includes(rule.rule_id))
      .map((item) => item.item_id);
    if (!sameStrings(rule.receiving_item_ids, expectedReceivers)) {
      issues.push(invariant(
        "compiler_sampling_receiver_mismatch",
        `/shared_sampling_rules/${ruleIndex}/receiving_item_ids`,
        "Sampling receivers must be derived from item rule selections",
        { expected: expectedReceivers, actual: rule.receiving_item_ids },
      ));
    }
    for (const itemId of rule.receiving_item_ids) {
      if (!itemIds.has(itemId)) {
        issues.push(invariant(
          "compiler_sampling_unknown_receiver",
          `/shared_sampling_rules/${ruleIndex}/receiving_item_ids`,
          "Sampling receiver must name a compiled item",
          { item_id: itemId },
        ));
      }
    }
  }

  const dispositions = plan.evidence_dispositions;
  const dispositionIds = dispositions.map((row) => row.evidence_id);
  const duplicateDispositionIds = [...new Set(dispositionIds.filter((id, index) => dispositionIds.indexOf(id) !== index))];
  if (duplicateDispositionIds.length) {
    issues.push(invariant(
      "compiler_duplicate_evidence_disposition",
      "/evidence_dispositions",
      "Compiler must emit exactly one disposition per evidence atom",
      { evidence_ids: duplicateDispositionIds },
    ));
  }
  const missingDispositions = compiledUnhandledEvidenceIds(plan, manifest.evidence);
  if (missingDispositions.length) {
    issues.push(invariant(
      "compiler_unhandled_evidence",
      "/evidence_dispositions",
      "Compiler must materialize every required source disposition",
      { evidence_ids: missingDispositions },
    ));
  }

  for (const issue of validateTableAssembly(plan.table_assembly, manifest)) {
    if (issue.code === "table_title_fragment_mismatch" || issue.code === "noncanonical_table_title") {
      const logicalIndex = Number(/^\/table_assembly\/logical_tables\/(\d+)\/canonical_title(?:_fragments)?$/u.exec(issue.path)?.[1] ?? -1);
      const logicalTable = plan.table_assembly.logical_tables[logicalIndex];
      const compactLogicalTable = persistedPlan?.schema_version === "semantic-source-plan/v8"
        ? persistedPlan.table_assembly.logical_tables[logicalIndex]
        : undefined;
      const logicalFragmentEvidenceIds = new Set(logicalTable?.fragment_ids.flatMap((fragmentId) => {
        const fragment = manifest.table_fragments.find((entry) => entry.fragment_id === fragmentId);
        return fragment ? [
          ...fragment.title_candidate_evidence_ids,
          ...fragment.header_evidence_ids,
          ...fragment.row_evidence_ids,
        ] : [];
      }) ?? []);
      const compactSpanById = new Map(
        persistedPlan?.schema_version === "semantic-source-plan/v8"
          ? persistedPlan.source_spans.map((span) => [span.span_id, span])
          : [],
      );
      const selectorEntries = logicalTable
        ? [...selectorItemsByCompiledId.values()].filter(({ item }) => {
            if (!item.table) return false;
            const tableSpanIds = Object.values(item.table.properties)
              .flat(2)
              .filter((value): value is string => typeof value === "string");
            return tableSpanIds.some((spanId) =>
              logicalFragmentEvidenceIds.has(compactSpanById.get(spanId)?.evidence_id ?? "")
            );
          })
        : [];
      const authoredSpanIds = [...new Set(selectorEntries.flatMap(({ item }) =>
        item.table?.properties.table_title_span_ids ?? []
      ))];
      const compiledSpanIds = compactLogicalTable?.canonical_title_span_ids ?? [];
      const faithful = selectorEntries.length > 0
        && authoredSpanIds.length > 0
        && sameStrings(authoredSpanIds, compiledSpanIds);
      const selectorPaths = selectorEntries.map(({ index }) =>
        `/items/${index}/table/properties/table_title_span_ids`
      );
      const invalidTitleFragments = issue.code === "table_title_fragment_mismatch"
        && issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
        && Array.isArray((issue.details as { actual?: unknown }).actual)
        ? (issue.details as { actual: unknown[] }).actual.flatMap((fragment) => (
            fragment && typeof fragment === "object" && !Array.isArray(fragment)
              && typeof (fragment as { evidence_id?: unknown }).evidence_id === "string"
              && typeof (fragment as { text?: unknown }).text === "string"
              ? [{
                  evidence_id: (fragment as { evidence_id: string }).evidence_id,
                  text: (fragment as { text: string }).text,
                }]
              : []
          ))
        : [];
      const invalidTitleKeys = new Set(invalidTitleFragments.map((fragment) =>
        `${fragment.evidence_id}\0${fragment.text}`
      ));
      const evidenceTextById = new Map(manifest.evidence.map((record) => [record.evidence_id, record.text]));
      const offendingSelectorEntries = invalidTitleKeys.size > 0
        ? selectorEntries.flatMap(({ item, index }) => {
            const offendingTitleSpanIds = (item.table?.properties.table_title_span_ids ?? []).filter((spanId) => {
              const span = compactSpanById.get(spanId);
              const text = span ? evidenceTextById.get(span.evidence_id)?.slice(span.start, span.end) : undefined;
              return Boolean(span && text !== undefined && invalidTitleKeys.has(`${span.evidence_id}\0${text}`));
            });
            return offendingTitleSpanIds.length > 0 ? [{ item, index, offendingTitleSpanIds }] : [];
          })
        : [];
      if (faithful && offendingSelectorEntries.length > 0) {
        const offendingSelectorPaths = offendingSelectorEntries.map(({ index }) =>
          `/items/${index}/table/properties/table_title_span_ids`
        );
        const offendingFragments = offendingSelectorEntries.flatMap(({ item, index, offendingTitleSpanIds }) =>
          offendingTitleSpanIds.flatMap((spanId) => {
            const span = compactSpanById.get(spanId);
            const text = span ? evidenceTextById.get(span.evidence_id)?.slice(span.start, span.end) : undefined;
            return span && text !== undefined ? [{
              item_key: item.key,
              item_name: item.name,
              selector_path: `/items/${index}/table/properties/table_title_span_ids`,
              span_id: spanId,
              evidence_id: span.evidence_id,
              text,
            }] : [];
          })
        );
        issues.push(invariant(
          `compiler_${issue.code}`,
          issue.path,
          issue.message,
          {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            actual: offendingFragments,
            affected_item_keys: offendingSelectorEntries.map(({ item }) => item.key),
            logical_table_id: logicalTable?.logical_table_id ?? "",
            fragment_ids: logicalTable?.fragment_ids ?? [],
            authored_title_span_ids: authoredSpanIds,
            compiled_title_span_ids: compiledSpanIds,
            offending_title_span_ids: [...new Set(offendingSelectorEntries.flatMap((entry) => entry.offendingTitleSpanIds))],
            selector_paths: offendingSelectorPaths,
            affected_paths: offendingSelectorPaths,
            related_selector_paths: selectorPaths,
            faithful_selector_projection: true,
            actual_title: logicalTable?.canonical_title ?? "",
            writable_collection: "items",
            next_tool: "stage_target_selector_draft",
            source_read_tool: "list_table_fragments",
            allowed_title: "Use registered spans of the formal title belonging to this physical table; continuation captions and line-number placeholders are not canonical titles.",
            immutable_paths: [issue.path, "source Markdown", "source-span-registry.json"],
            required_action: "clear_all_offending_item_title_spans_in_one_patch_and_use_the_one_logical_table_title",
          },
          offendingSelectorPaths[0],
        ));
        continue;
      }
      if (selectorEntries.length > 0 && authoredSpanIds.length === 0) {
        issues.push(invariant(
          `compiler_${issue.code}`,
          issue.path,
          issue.message,
          {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            affected_item_keys: selectorEntries.map(({ item }) => item.key),
            logical_table_id: logicalTable?.logical_table_id ?? "",
            fragment_ids: logicalTable?.fragment_ids ?? [],
            selector_paths: selectorPaths,
            affected_paths: selectorPaths,
            related_selector_paths: selectorPaths,
            faithful_selector_projection: true,
            writable_collection: "items",
            next_tool: "stage_target_selector_draft",
            source_read_tool: "list_table_fragments",
            allowed_title: "Use registered spans of the formal title belonging to this physical table; continuation captions and line-number placeholders are not canonical titles.",
            immutable_paths: [issue.path, "source Markdown", "source-span-registry.json"],
            required_action: "select_registered_table_title_spans_for_all_table_items_belonging_to_this_table",
          },
          selectorPaths[0],
        ));
        continue;
      }
      issues.push(invariant(
        `compiler_${issue.code}`,
        issue.path,
        issue.message,
        faithful
          ? {
              ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
                ? issue.details
                : {}),
              logical_table_id: logicalTable?.logical_table_id ?? "",
              fragment_ids: logicalTable?.fragment_ids ?? [],
              authored_title_span_ids: authoredSpanIds,
              compiled_title_span_ids: compiledSpanIds,
              selector_paths: selectorPaths,
              faithful_selector_projection: true,
              actual_title: logicalTable?.canonical_title ?? "",
              writable_collection: "items",
              next_tool: "stage_target_selector_draft",
              source_read_tool: "list_table_fragments",
              allowed_title: "Use registered spans of the formal title belonging to this physical table; continuation captions and line-number placeholders are not canonical titles.",
              immutable_paths: [issue.path, "source Markdown", "source-span-registry.json"],
              required_action: "select_the_registered_formal_title_candidate_span_for_this_physical_table",
            }
          : issue.details,
        faithful ? selectorPaths[0] : undefined,
      ));
      continue;
    }
    issues.push(invariant(`compiler_${issue.code}`, issue.path, issue.message, issue.details));
  }
  const compactPlan = persistedPlan?.schema_version === "semantic-source-plan/v8"
    ? persistedPlan
    : undefined;
  if (compactPlan) issues.push(...compactSamplingContextIssues(compactPlan, manifest, selectors));
  for (const issue of validateSemanticDraft(plan, manifest).issues) {
    const compiledIssue = invariant(`compiler_${issue.code}`, issue.path, issue.message, issue.details);
    if (["semantic_reference_unresolved", "semantic_reference_unresolved_targets"].includes(issue.code)) {
      const semanticIndex = Number(/^\/semantic_references\/(\d+)\//u.exec(issue.path)?.[1] ?? -1);
      const semanticReference = plan.semantic_references?.[semanticIndex];
      const matchingSelectorIndexes = semanticReference
        ? selectors.references.flatMap((reference, referenceIndex) =>
          reference.action === "review" && reference.reason === semanticReference.reason
            ? [referenceIndex]
            : []
        )
        : [];
      const selectorReferenceIndex = matchingSelectorIndexes.length === 1
        ? matchingSelectorIndexes[0]!
        : selectors.references[semanticIndex]?.action === "review"
        ? semanticIndex
        : -1;
      if (selectorReferenceIndex >= 0) {
        issues.push({
          ...compiledIssue,
          selector_path: `/references/${selectorReferenceIndex}/action`,
          details: {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            reference_key: selectors.references[selectorReferenceIndex]!.key,
            required_action: "change_review_to_an_applicable_resolved_reference_action_or_remove_unproven_targets",
            allowed_resolved_actions: ["adopt", "conditional", "compare", "mention", "keep_reference"],
          },
        });
        continue;
      }
    }
    if (issue.code === "semantic_item_fragment_not_materialized") {
      const semanticIndex = Number(/^\/semantic_evidence\/(\d+)\/materialized_item_id$/u.exec(issue.path)?.[1] ?? -1);
      const node = plan.semantic_evidence?.[semanticIndex];
      const selectorItemIndex = node
        ? selectors.items.findIndex((item) =>
            semanticItemIdForSelectorKey(selectors.target_id, item.key) === node.materialized_item_id
          )
        : -1;
      if (node && selectorItemIndex >= 0) {
        issues.push({
          ...compiledIssue,
          selector_path: `/items/${selectorItemIndex}/criterion_span_ids`,
          details: {
            ...(issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
              ? issue.details
              : {}),
            evidence_id: node.evidence_id,
            exact_fragment: node.exact_fragment,
            item_key: selectors.items[selectorItemIndex]!.key,
            required_action: "bind_the_exact_semantic_fragment_to_this_item_criterion_and_one_visible_field",
          },
        });
        continue;
      }
    }
    issues.push(compiledIssue);
  }
  return issues;
}
