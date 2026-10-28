import { canonicalize, sha256Text } from "./canonical.js";
import { planHasContextReference } from "./context-reference.js";
import {
  referenceOccurrenceLiterals,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type AcceptanceItemField,
  type EvidenceManifest,
  type ReferenceTargetField,
  type SemanticEvidenceNode,
  type SemanticSourcePlan,
  type ValidationIssue,
} from "./contracts.js";

export interface SemanticDraftValidation {
  ok: boolean;
  issues: ValidationIssue[];
  fingerprint?: string;
}

export function semanticReferenceTargetNodesForDestination(
  nodes: SemanticEvidenceNode[],
  itemId: string,
): SemanticEvidenceNode[] {
  return nodes.filter((node) => (
    !node.materialized_item_id || node.materialized_item_id === itemId
  ));
}

export function semanticReferenceEvidenceIdsForDestination(
  plan: SemanticSourcePlan,
  itemId: string,
  field: ReferenceTargetField,
): Set<string> {
  const nodeById = new Map(
    (plan.semantic_evidence ?? []).map((node) => [node.semantic_id, node]),
  );
  const evidenceIds = new Set<string>();
  for (const expansion of plan.semantic_references ?? []) {
    if (expansion.status !== "resolved") continue;
    const destination = expansion.destination_bindings.find((binding) =>
      binding.item_id === itemId && binding.fields.includes(field)
    );
    if (!destination) continue;
    const anchor = nodeById.get(expansion.anchor_semantic_id);
    if (anchor) evidenceIds.add(anchor.evidence_id);
    const targetNodes = expansion.target_semantic_ids
      .map((semanticId) => nodeById.get(semanticId))
      .filter((node): node is SemanticEvidenceNode => Boolean(node));
    for (const node of semanticReferenceTargetNodesForDestination(targetNodes, itemId)) {
      evidenceIds.add(node.evidence_id);
    }
  }
  return evidenceIds;
}

export function semanticDraftProjection(
  plan: SemanticSourcePlan,
): Record<string, unknown> {
  return {
    schema_version: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    semantic_evidence: plan.semantic_evidence ?? [],
    semantic_references: plan.semantic_references ?? [],
    shared_sampling_rules: plan.shared_sampling_rules ?? [],
  };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function exactFragmentExists(
  evidenceById: Map<string, { text: string }>,
  evidenceId: string,
  fragment: string,
): boolean {
  return Boolean(fragment && evidenceById.get(evidenceId)?.text.includes(fragment));
}

function uniqueFragmentInterval(
  evidenceById: Map<string, { text: string }>,
  evidenceId: string,
  fragment: string,
): { start: number; end: number } | undefined {
  if (!fragment) return undefined;
  const text = evidenceById.get(evidenceId)?.text;
  if (!text) return undefined;
  const start = text.indexOf(fragment);
  if (start < 0 || text.indexOf(fragment, start + 1) >= 0) return undefined;
  return { start, end: start + fragment.length };
}

function itemCarriesFragment(
  plan: SemanticSourcePlan,
  itemId: string,
  node: SemanticEvidenceNode,
): boolean {
  const item = plan.acceptance_items.find((candidate) => candidate.item_id === itemId);
  if (!item) return false;
  if (!item.evidence_ids.includes(node.evidence_id) && !item.reference_evidence_ids.includes(node.evidence_id)) {
    return false;
  }
  const fieldCarries = Object.values(item.field_bindings).some((binding) =>
    binding.source_fragments.some((fragment) =>
      fragment.evidence_id === node.evidence_id
      && (fragment.text.includes(node.exact_fragment) || node.exact_fragment.includes(fragment.text))
    )
  );
  if (fieldCarries) return true;
  if (node.role !== "table_criterion" || !item.table_semantics) return false;
  return [
    ...item.table_semantics.cell_evidence,
    ...item.table_semantics.reference_fragments,
  ].some((fragment) =>
    fragment.evidence_id === node.evidence_id
    && (fragment.text.includes(node.exact_fragment) || node.exact_fragment.includes(fragment.text))
  );
}

function fieldBindingCarriesNode(
  plan: SemanticSourcePlan,
  itemId: string,
  field: AcceptanceItemField,
  node: SemanticEvidenceNode,
): boolean {
  const item = plan.acceptance_items.find((candidate) => candidate.item_id === itemId);
  if (!item) return false;
  const semanticallyRouted = semanticReferenceEvidenceIdsForDestination(
    plan,
    itemId,
    field,
  );
  if (
    !item.evidence_ids.includes(node.evidence_id)
    && !item.reference_evidence_ids.includes(node.evidence_id)
    && !semanticallyRouted.has(node.evidence_id)
  ) {
    return false;
  }
  const binding = item.field_bindings[field];
  return binding.composition === "reference"
    && binding.source_fragments.some((fragment) =>
      fragment.evidence_id === node.evidence_id
      && (fragment.text.includes(node.exact_fragment) || node.exact_fragment.includes(fragment.text))
    );
}

function destinationCarriesNode(
  plan: SemanticSourcePlan,
  itemId: string,
  field: ReferenceTargetField,
  node: SemanticEvidenceNode,
): boolean {
  if (["name", "requirement", "method", "quantity", "note"].includes(field)) {
    return fieldBindingCarriesNode(plan, itemId, field as AcceptanceItemField, node);
  }
  const item = plan.acceptance_items.find((candidate) => candidate.item_id === itemId);
  if (!item) return false;
  if (field === "sampling") {
    return item.evidence_ids.includes(node.evidence_id)
      || item.reference_evidence_ids.includes(node.evidence_id)
      || item.sampling.evidence_ids.includes(node.evidence_id);
  }
  const semanticallyRouted = semanticReferenceEvidenceIdsForDestination(
    plan,
    itemId,
    "reference_only",
  );
  return item.evidence_ids.includes(node.evidence_id)
    || item.reference_evidence_ids.includes(node.evidence_id)
    || semanticallyRouted.has(node.evidence_id);
}

export function validateSemanticDraft(
  plan: SemanticSourcePlan,
  manifest: EvidenceManifest,
  openedEvidenceIds?: Set<string>,
): SemanticDraftValidation {
  if (!manifest.source.semantic_workflow) return { ok: true, issues: [] };
  const issues: ValidationIssue[] = [];
  if (!plan.semantic_evidence || !plan.semantic_references || !plan.shared_sampling_rules) {
    return {
      ok: false,
      issues: [{
        code: "semantic_draft_missing",
        path: "/semantic_evidence",
        message: "This evidence package requires semantic_evidence, semantic_references, and shared_sampling_rules before item materialization",
        details: {
          required_action: "Populate semantic_evidence, semantic_references, and shared_sampling_rules before materializing items",
        },
      }],
    };
  }

  const evidenceById = new Map(manifest.evidence.map((record) => [record.evidence_id, record]));
  const itemById = new Map(plan.acceptance_items.map((item) => [item.item_id, item]));
  const nodes = plan.semantic_evidence;
  const nodeById = new Map(nodes.map((node) => [node.semantic_id, node]));
  const duplicateNodeIds = duplicateValues(nodes.map((node) => node.semantic_id));
  if (duplicateNodeIds.length) {
    issues.push({
      code: "semantic_duplicate_id",
      path: "/semantic_evidence",
      message: "semantic_id values must be unique",
      details: { required_action: "semantic_id values must be unique", actual: duplicateNodeIds },
    });
  }
  nodes.forEach((node, index) => {
    const path = `/semantic_evidence/${index}`;
    if (!exactFragmentExists(evidenceById, node.evidence_id, node.exact_fragment)) {
      issues.push({
        code: "semantic_fragment_not_exact",
        path: `${path}/exact_fragment`,
        message: "A semantic role must cite an exact fragment of immutable evidence",
        details: { required_action: "A semantic role must cite an exact fragment of immutable evidence", evidence_id: node.evidence_id },
      });
    }
    if (openedEvidenceIds && !openedEvidenceIds.has(node.evidence_id)) {
      issues.push({
        code: "semantic_evidence_not_opened",
        path: `${path}/evidence_id`,
        message: "Open every evidence atom used by the semantic draft before validating it",
        details: { required_action: "Open every evidence atom used by the semantic draft before validating it", evidence_id: node.evidence_id },
      });
    }
    if (node.role === "acceptance_item" || node.role === "table_criterion") {
      if (!node.materialized_item_id || !itemById.has(node.materialized_item_id)) {
        issues.push({
          code: "semantic_item_not_materialized",
          path: `${path}/materialized_item_id`,
          message: "An acceptance_item or table_criterion semantic node must name one final acceptance item",
        details: { required_action: "An acceptance_item or table_criterion semantic node must name one final acceptance item" }
});
      } else if (!itemCarriesFragment(plan, node.materialized_item_id, node)) {
        issues.push({
          code: "semantic_item_fragment_not_materialized",
          path: `${path}/materialized_item_id`,
          message: "The receiving item must carry the semantic item's exact source meaning in its field bindings",
          details: { required_action: "The receiving item must carry the semantic item's exact source meaning in its field bindings",
            semantic_id: node.semantic_id,
            evidence_id: node.evidence_id,
            exact_fragment: node.exact_fragment,
            materialized_item_id: node.materialized_item_id,
          },
        });
      }
      if (
        node.role === "table_criterion"
        && node.materialized_item_id
        && !itemById.get(node.materialized_item_id)?.table_semantics
      ) {
        issues.push({
          code: "semantic_table_criterion_not_structured",
          path: `${path}/materialized_item_id`,
          message: "A table_criterion must materialize the structured table_semantics contract",
        details: { required_action: "A table_criterion must materialize the structured table_semantics contract" }
});
      }
      return;
    }
    if (node.role === "continuation") {
      const parent = nodeById.get(node.parent_semantic_id);
      if (
        !parent
        || !["acceptance_item", "table_criterion", "continuation"].includes(parent.role)
        || !node.materialized_item_id
        || node.materialized_item_id !== parent.materialized_item_id
      ) {
        issues.push({
          code: "semantic_continuation_relation",
          path,
          message: "A continuation must share the materialized item of an acceptance-item parent instead of becoming a standalone item",
        details: { required_action: "A continuation must share the materialized item of an acceptance-item parent instead of becoming a standalone item" }
});
      } else if (!itemCarriesFragment(plan, node.materialized_item_id, node)) {
        issues.push({
          code: "semantic_continuation_not_merged",
          path: `${path}/materialized_item_id`,
          message: "The continuation fragment must be merged into its parent's final item fields",
        details: { required_action: "The continuation fragment must be merged into its parent's final item fields" }
});
      }
      return;
    }
    if (node.materialized_item_id) {
      issues.push({
        code: "semantic_non_item_materialized",
        path: `${path}/materialized_item_id`,
        message: `${node.role} is semantic context and cannot be materialized as an acceptance item`,
        details: { required_action: "Fix semantic non item materialized" }
});
    }
    if (node.role === "referenced_clause") {
      const parent = nodeById.get(node.parent_semantic_id);
      if (parent?.role !== "reference_anchor") {
        issues.push({
          code: "semantic_referenced_clause_parent",
          path: `${path}/parent_semantic_id`,
          message: "A referenced_clause must name the reference_anchor whose dependency it resolves",
        details: { required_action: "A referenced_clause must name the reference_anchor whose dependency it resolves" }
});
      }
    } else if (node.parent_semantic_id) {
      issues.push({
        code: "semantic_unexpected_parent",
        path: `${path}/parent_semantic_id`,
        message: `${node.role} must not invent a semantic parent relation`,
        details: { required_action: "Fix semantic unexpected parent" }
});
    }
    if (node.role === "acceptance_condition") {
      const nodeInterval = uniqueFragmentInterval(
        evidenceById,
        node.evidence_id,
        node.exact_fragment,
      );
      const isWholeEvidenceEnvelope = nodeInterval?.start === 0
        && nodeInterval.end === evidenceById.get(node.evidence_id)?.text.length;
      const carryingItems = nodeInterval && !isWholeEvidenceEnvelope ? plan.acceptance_items.filter((item) =>
        Object.values(item.field_bindings).some((binding) =>
          binding.source_fragments.some((fragment) => {
            if (fragment.evidence_id !== node.evidence_id) return false;
            const fieldInterval = uniqueFragmentInterval(
              evidenceById,
              fragment.evidence_id,
              fragment.text,
            );
            return Boolean(fieldInterval && (
              (nodeInterval.start <= fieldInterval.start && nodeInterval.end >= fieldInterval.end)
              || (fieldInterval.start <= nodeInterval.start && fieldInterval.end >= nodeInterval.end)
            ));
          })
        )
      ) : [];
      if (carryingItems.length > 0) {
        issues.push({
          code: "semantic_context_emitted_as_item",
          path,
          message: `${node.role} fragment was emitted as item ${carryingItems[0]!.item_id}`,
        details: { required_action: "Fix semantic context emitted as item" }
});
      }
    }
  });

  const selectedAtomIds = manifest.scope.selected_atom_ids ?? [];
  const materializedEvidenceIds = new Set(
    manifest.evidence.map((record) => record.evidence_id),
  );
  for (const evidenceId of selectedAtomIds) {
    // Exact-scope manifests retain selected atom IDs only as navigation addresses. Their granular
    // primary records carry the semantic obligations; an on-demand raw atom is classified only
    // after it is materialized into the manifest.
    if (!materializedEvidenceIds.has(evidenceId)) continue;
    const hasSemanticRole = nodes.some((node) => node.evidence_id === evidenceId);
    const hasExplicitDisposition = plan.evidence_dispositions.some((row) => row.evidence_id === evidenceId);
    if (!hasSemanticRole && !hasExplicitDisposition) {
      issues.push({
        code: "semantic_primary_atom_unclassified",
        path: "/semantic_evidence",
        message: "Every discovery-selected atom must receive a semantic role or an explicit evidence disposition",
        details: { required_action: "Every discovery-selected atom must receive a semantic role or an explicit evidence disposition", evidence_id: evidenceId },
      });
    }
  }
  for (const item of plan.acceptance_items) {
    if (!nodes.some((node) =>
      ["acceptance_item", "table_criterion"].includes(node.role)
      && node.materialized_item_id === item.item_id
    )) {
      issues.push({
        code: "semantic_unplanned_item",
        path: `/acceptance_items/${plan.acceptance_items.indexOf(item)}`,
        message: "Every final item must originate from an acceptance_item semantic node",
        details: { required_action: "Every final item must originate from an acceptance_item semantic node" }
});
    }
  }

  const anchors = nodes.filter((node) => node.role === "reference_anchor");
  const placeholderAnchorKeys = new Set(
    plan.reference_resolutions.flatMap((resolution) => {
      if (resolution.application_mode !== "reference_placeholder" && !planHasContextReference(plan, manifest, resolution)) return [];
      const occurrence = manifest.reference_occurrences.find((entry) =>
        entry.occurrence_id === resolution.occurrence_id
      );
      if (!occurrence) return [];
      const literals = referenceOccurrenceLiterals(occurrence);
      if (literals.length === 0) {
        return occurrence.raw_reference
          ? [`${occurrence.origin_evidence_id}\0${occurrence.raw_reference.normalize("NFKC").replace(/\s+/gu, "")}`]
          : [];
      }
      return literals.flatMap((literal) => {
        const origin = evidenceById.get(literal.evidence_id);
        const text = origin?.text.slice(literal.start, literal.end) ?? "";
        return text ? [`${literal.evidence_id}\0${text.normalize("NFKC").replace(/\s+/gu, "")}`] : [];
      });
    }),
  );
  const expansionIds = plan.semantic_references.map((entry) => entry.expansion_id);
  const duplicateExpansionIds = duplicateValues(expansionIds);
  if (duplicateExpansionIds.length) {
    issues.push({
      code: "semantic_duplicate_reference",
      path: "/semantic_references",
      message: "expansion_id values must be unique",
      details: { required_action: "expansion_id values must be unique", actual: duplicateExpansionIds },
    });
  }
  anchors.forEach((anchor) => {
    const expansions = plan.semantic_references!.filter((entry) =>
      entry.anchor_semantic_id === anchor.semantic_id
    );
    if (expansions.length !== 1) {
      issues.push({
        code: "semantic_reference_resolution_count",
        path: "/semantic_references",
        message: "Every reference_anchor must have exactly one explicit expansion decision",
        details: { required_action: "Every reference_anchor must have exactly one explicit expansion decision", anchor_semantic_id: anchor.semantic_id, count: expansions.length },
      });
    }
  });
  nodes.filter((node) => node.role === "referenced_clause").forEach((node) => {
    if (!plan.semantic_references!.some((entry) =>
      entry.target_semantic_ids.includes(node.semantic_id)
    )) {
      issues.push({
        code: "semantic_referenced_clause_orphan",
        path: "/semantic_references",
        message: "Every referenced_clause must be consumed by at least one semantic reference decision",
        details: { required_action: "Every referenced_clause must be consumed by at least one semantic reference decision", semantic_id: node.semantic_id },
      });
    }
  });
  plan.semantic_references.forEach((entry, index) => {
    const path = `/semantic_references/${index}`;
    const anchor = nodeById.get(entry.anchor_semantic_id);
    if (anchor?.role !== "reference_anchor") {
      issues.push({
        code: "semantic_reference_anchor_role",
        path: `${path}/anchor_semantic_id`,
        message: "A semantic reference must originate from a reference_anchor node",
        details: { required_action: "A semantic reference must originate from a reference_anchor node" }
});
    }
    if (entry.status === "review") {
      issues.push({
        code: "semantic_reference_unresolved",
        path: `${path}/status`,
        message: "A review reference cannot pass materialization",
        details: { required_action: "A review reference cannot pass materialization" }
});
    }
    if (entry.status === "resolved" && entry.target_semantic_ids.length === 0) {
      issues.push({
        code: "semantic_reference_empty_expansion",
        path: `${path}/target_semantic_ids`,
        message: "A resolved reference must expand to semantic target nodes",
        details: { required_action: "A resolved reference must expand to semantic target nodes" }
});
    }
    if (
      entry.status === "resolved"
      && entry.destination_bindings.length === 0
      && !placeholderAnchorKeys.has(
        anchor
          ? `${anchor.evidence_id}\0${anchor.exact_fragment.normalize("NFKC").replace(/\s+/gu, "")}`
          : "",
      )
    ) {
      issues.push({
        code: "semantic_reference_destination_missing",
        path: `${path}/destination_bindings`,
        message: "A resolved semantic reference must name the receiving item fields",
        details: { required_action: "A resolved semantic reference must name the receiving item fields" }
});
    }
    if (entry.status !== "resolved" && entry.destination_bindings.length > 0) {
      issues.push({
        code: "semantic_reference_unresolved_destination",
        path: `${path}/destination_bindings`,
        message: "Only a resolved semantic reference may route content into item fields",
        details: { required_action: "Only a resolved semantic reference may route content into item fields" }
});
    }
    if (entry.status !== "resolved" && entry.target_semantic_ids.length > 0) {
      issues.push({
        code: "semantic_reference_unresolved_targets",
        path: `${path}/target_semantic_ids`,
        message: "An unresolved or non-applicable semantic reference cannot claim resolved target nodes",
        details: { required_action: "An unresolved or non-applicable semantic reference cannot claim resolved target nodes" }
});
    }
    const targetNodes: SemanticEvidenceNode[] = [];
    for (const targetId of entry.target_semantic_ids) {
      const target = nodeById.get(targetId);
      if (!target || !["referenced_clause", "acceptance_item", "table_criterion"].includes(target.role)) {
        issues.push({
          code: "semantic_reference_target_role",
          path: `${path}/target_semantic_ids`,
          message: "Reference expansion targets must be referenced_clause, acceptance_item, or table_criterion nodes",
          details: { required_action: "Reference expansion targets must be referenced_clause, acceptance_item, or table_criterion nodes", semantic_id: targetId },
        });
      } else {
        targetNodes.push(target);
      }
    }
    const destinationRoutes = new Set<string>();
    entry.destination_bindings.forEach((destination, destinationIndex) => {
      const item = itemById.get(destination.item_id);
      if (!item) {
        issues.push({
          code: "semantic_reference_unknown_destination",
          path: `${path}/destination_bindings/${destinationIndex}/item_id`,
          message: "A semantic reference destination must name an existing acceptance item",
        details: { required_action: "A semantic reference destination must name an existing acceptance item" }
});
        return;
      }
      destination.fields.forEach((field) => {
        const route = `${destination.item_id}|${field}`;
        if (destinationRoutes.has(route)) {
          issues.push({
            code: "semantic_reference_duplicate_destination",
            path: `${path}/destination_bindings/${destinationIndex}/fields`,
            message: "A semantic reference may route to an item field only once",
            details: { required_action: "A semantic reference may route to an item field only once", item_id: destination.item_id, field },
          });
        }
        destinationRoutes.add(route);
        if (!anchor || anchor.role !== "reference_anchor") return;
        const destinationTargetNodes = semanticReferenceTargetNodesForDestination(
          targetNodes,
          destination.item_id,
        );
        // The anchor proves where and why the reference applies, and remains in
        // semantic provenance. It is not display-field content. Only resolved
        // target nodes must be projected into an authoritative replace_field;
        // reference_only routes are validated through their typed
        // semantic destination instead of mutating the anchor item.
        const missingNodes = destinationTargetNodes.filter((node) =>
          !destinationCarriesNode(plan, destination.item_id, field, node)
        );
        if (missingNodes.length) {
          issues.push({
            code: "semantic_reference_not_materialized",
            path: `/acceptance_items/${plan.acceptance_items.indexOf(item)}/field_bindings/${field}`,
            message: "A projected reference field must bind the resolved target nodes assigned to that item; the reference anchor remains semantic provenance only",
            details: { required_action: "A projected reference field must bind the resolved target nodes assigned to that item; the reference anchor remains semantic provenance only",
              expansion_id: entry.expansion_id,
              missing_semantic_ids: missingNodes.map((node) => node.semantic_id),
            },
          });
        }
      });
    });
  });

  const rules = plan.shared_sampling_rules;
  const ruleById = new Map(rules.map((rule) => [rule.rule_id, rule]));
  const duplicateRuleIds = duplicateValues(rules.map((rule) => rule.rule_id));
  if (duplicateRuleIds.length) {
    issues.push({
      code: "semantic_duplicate_sampling_rule",
      path: "/shared_sampling_rules",
      message: "rule_id values must be unique",
      details: { required_action: "rule_id values must be unique", actual: duplicateRuleIds },
    });
  }
  rules.forEach((rule, ruleIndex) => {
    const path = `/shared_sampling_rules/${ruleIndex}`;
    const sourceNode = nodeById.get(rule.source_semantic_id);
    if (sourceNode?.role !== "sampling_rule") {
      issues.push({
        code: "semantic_sampling_source_role",
        path: `${path}/source_semantic_id`,
        message: "A shared sampling rule must originate from a sampling_rule semantic node",
        details: { required_action: "A shared sampling rule must originate from a sampling_rule semantic node" }
});
    }
    const sourceTexts = rule.evidence_ids.map((id) => evidenceById.get(id)?.text ?? "");
    if (!sourceTexts.some((text) => text.includes(rule.complete_source_fragment))) {
      issues.push({
        code: "semantic_sampling_source_incomplete",
        path: `${path}/complete_source_fragment`,
        message: "The complete shared rule must be an exact source fragment, not a single specialized branch",
        details: { required_action: "The complete shared rule must be an exact source fragment, not a single specialized branch" }
});
    }
    const branchIds = rule.branches.map((branch) => branch.branch_id);
    const duplicateBranchIds = duplicateValues(branchIds);
    if (duplicateBranchIds.length) {
      issues.push({
        code: "semantic_duplicate_sampling_branch",
        path: `${path}/branches`,
        message: "branch_id values must be unique within a shared rule",
        details: { required_action: "branch_id values must be unique within a shared rule", actual: duplicateBranchIds },
      });
    }
    rule.branches.forEach((branch, branchIndex) => {
      if (!exactFragmentExists(evidenceById, branch.evidence_id, branch.exact_fragment)) {
        issues.push({
          code: "semantic_sampling_branch_not_exact",
          path: `${path}/branches/${branchIndex}/exact_fragment`,
          message: "Every sampling branch must retain an exact source fragment",
        details: { required_action: "Every sampling branch must retain an exact source fragment" }
});
      }
      (branch.conditions ?? []).forEach((condition, conditionIndex) => {
        if (!exactFragmentExists(evidenceById, condition.evidence_id, condition.exact_fragment)) {
          issues.push({
            code: "semantic_sampling_branch_condition_not_exact",
            path: `${path}/branches/${branchIndex}/conditions/${conditionIndex}/exact_fragment`,
            message: "Every branch-local sampling condition must retain an exact source fragment",
        details: { required_action: "Every branch-local sampling condition must retain an exact source fragment" }
});
        }
      });
    });
    rule.shared_conditions.forEach((condition, conditionIndex) => {
      if (!exactFragmentExists(evidenceById, condition.evidence_id, condition.exact_fragment)) {
        issues.push({
          code: "semantic_sampling_condition_not_exact",
          path: `${path}/shared_conditions/${conditionIndex}/exact_fragment`,
          message: "Every shared sampling condition must retain an exact source fragment",
        details: { required_action: "Every shared sampling condition must retain an exact source fragment" }
});
      }
    });
    for (const itemId of rule.receiving_item_ids) {
      const item = itemById.get(itemId);
      if (!item) {
        issues.push({
          code: "semantic_sampling_unknown_receiver",
          path: `${path}/receiving_item_ids`,
          message: "A shared sampling rule names an unknown receiving item",
          details: { required_action: "A shared sampling rule names an unknown receiving item", item_id: itemId },
        });
        continue;
      }
      const selectedBranches = rule.branches.filter((branch) =>
        item.sampling.branch_ids?.includes(branch.branch_id)
      );
      const selectedBranchIds = item.sampling.branch_ids ?? [];
      const declaredBranchIds = new Set(rule.branches.map((branch) => branch.branch_id));
      const unknownBranchIds = selectedBranchIds.filter((branchId) => !declaredBranchIds.has(branchId));
      const inapplicableBranchIds = selectedBranches.filter((branch) =>
        branch.applies_to_category !== "all_items" && branch.applies_to_category !== item.category
      ).map((branch) => branch.branch_id);
      if (
        !item.sampling.rule_ids?.includes(rule.rule_id)
        || selectedBranches.length === 0
        || unknownBranchIds.length > 0
        || inapplicableBranchIds.length > 0
      ) {
        issues.push({
          code: "semantic_sampling_branch_application",
          path: `/acceptance_items/${plan.acceptance_items.indexOf(item)}/sampling`,
          message: "Each receiving item must reference the shared rule and a non-empty declared, category-applicable branch selection",
          details: { required_action: "Each receiving item must reference the shared rule and a non-empty declared, category-applicable branch selection",
            rule_id: rule.rule_id,
            item_id: itemId,
            actual_branch_ids: selectedBranches.map((branch) => branch.branch_id),
            unknown_branch_ids: unknownBranchIds,
            inapplicable_branch_ids: inapplicableBranchIds,
          },
        });
      }
    }
  });
  plan.acceptance_items.forEach((item, index) => {
    const ruleIds = item.sampling.rule_ids ?? [];
    const branchIds = item.sampling.branch_ids ?? [];
    if (
      (item.sampling.status === "reference" || item.sampling.status === "reference_unspecified_quantity")
      && item.sampling.evidence_ids.length > 0
    ) {
      if (ruleIds.length === 0 || branchIds.length === 0) {
        issues.push({
          code: "semantic_sampling_reference_unstructured",
          path: `/acceptance_items/${index}/sampling`,
          message: "Referenced sampling must select a structured shared rule and at least one applicable branch",
        details: { required_action: "Referenced sampling must select a structured shared rule and at least one applicable branch" }
});
      }
    }
    for (const ruleId of ruleIds) {
      const rule = ruleById.get(ruleId);
      if (!rule || !rule.receiving_item_ids.includes(item.item_id)) {
        issues.push({
          code: "semantic_sampling_rule_relation",
          path: `/acceptance_items/${index}/sampling/rule_ids`,
          message: "Item rule_ids must point to shared rules that name the item as a receiver",
          details: { required_action: "Item rule_ids must point to shared rules that name the item as a receiver", rule_id: ruleId },
        });
      }
    }
  });

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    fingerprint: sha256Text(canonicalize({
      evidence_fingerprint: manifest.evidence_fingerprint,
      ...semanticDraftProjection(plan),
    })),
  };
}
