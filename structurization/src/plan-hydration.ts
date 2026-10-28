import {
  COMPACT_PLAN_SCHEMA_VERSION,
  type EvidenceManifest,
  type PersistedSemanticSourcePlan,
  type SemanticSourcePlan,
  type SemanticSourcePlanV8,
  type SourceFragment,
} from "./contracts.js";
import { createPlanSourceResolver } from "./plan-source-resolver.js";
import type { SourceSpanIssue } from "./source-span-registry.js";

export class PlanHydrationError extends Error {
  constructor(public readonly issues: SourceSpanIssue[]) {
    super(`Compact semantic source plan hydration failed with ${issues.length} issue(s)`);
  }
}

export function isCompactSemanticSourcePlan(
  plan: PersistedSemanticSourcePlan | unknown,
): plan is SemanticSourcePlanV8 {
  return Boolean(
    plan
    && typeof plan === "object"
    && !Array.isArray(plan)
    && (plan as { schema_version?: unknown }).schema_version === COMPACT_PLAN_SCHEMA_VERSION,
  );
}

/**
 * Produces the legacy in-memory semantic view consumed by deterministic code.
 * The returned strings are derived from immutable offsets and are never written
 * back as a v8 persisted plan.
 */
export function hydrateSemanticSourcePlan(
  persisted: PersistedSemanticSourcePlan,
  manifest: EvidenceManifest,
): SemanticSourcePlan {
  if (!isCompactSemanticSourcePlan(persisted)) return persisted;
  const issues: SourceSpanIssue[] = [];
  const resolver = createPlanSourceResolver(persisted, manifest);
  const fragments = (spanIds: readonly string[], path: string): SourceFragment[] =>
    resolver.resolveMany(spanIds, path, issues).map((span) => ({
      evidence_id: span.evidence_id,
      text: span.text,
    }));
  const oneFragment = (spanId: string, path: string): SourceFragment =>
    fragments(spanId ? [spanId] : [], path)[0] ?? { evidence_id: "", text: "" };
  const joined = (spanIds: readonly string[], path: string, separator = ""): SourceFragment => {
    const selected = fragments(spanIds, path);
    const evidenceIds = [...new Set(selected.map((fragment) => fragment.evidence_id))];
    if (selected.length > 1 && evidenceIds.length > 1) {
      issues.push({
        code: "plan_span_cross_evidence_fragment",
        path,
        message: "A legacy-compatible exact fragment view cannot join source spans from different evidence atoms",
        details: { evidence_ids: evidenceIds },
      });
    }
    return {
      evidence_id: evidenceIds[0] ?? "",
      text: selected.map((fragment) => fragment.text).join(separator),
    };
  };

  const semanticNodes = persisted.semantic_evidence?.map((node, nodeIndex) => {
    const fragment = oneFragment(node.span_id, `/semantic_evidence/${nodeIndex}/span_id`);
    const { span_id: _spanId, ...rest } = node;
    return { ...rest, evidence_id: fragment.evidence_id, exact_fragment: fragment.text };
  });
  const semanticNodeById = new Map((semanticNodes ?? []).map((node) => [node.semantic_id, node]));

  const tableAssembly = {
    ...persisted.table_assembly,
    logical_tables: persisted.table_assembly.logical_tables.map((table, tableIndex) => {
      const { canonical_title_span_ids: spanIds, ...rest } = table;
      return {
        ...rest,
        canonical_title_fragments: fragments(
          spanIds,
          `/table_assembly/logical_tables/${tableIndex}/canonical_title_span_ids`,
        ),
      };
    }),
  };

  const acceptanceItems = persisted.acceptance_items.map((item, itemIndex) => {
    const fieldBindings = Object.fromEntries(Object.entries(item.field_bindings).map(([field, binding]) => {
      const { source_span_ids: spanIds, ...rest } = binding;
      return [field, {
        ...rest,
        source_fragments: fragments(
          spanIds,
          `/acceptance_items/${itemIndex}/field_bindings/${field}/source_span_ids`,
        ),
      }];
    })) as SemanticSourcePlan["acceptance_items"][number]["field_bindings"];
    const tableSemantics = item.table_semantics
      ? (() => {
          const {
            reference_span_ids: referenceSpanIds,
            acceptance_branches: compactAcceptanceBranches,
            ...rest
          } = item.table_semantics!;
          return {
            ...rest,
            cell_evidence: item.table_semantics!.cell_evidence.map((cell, cellIndex) => {
              const fragment = oneFragment(
                cell.span_id,
                `/acceptance_items/${itemIndex}/table_semantics/cell_evidence/${cellIndex}/span_id`,
              );
              return { role: cell.role, ...fragment };
            }),
            reference_fragments: fragments(
              referenceSpanIds,
              `/acceptance_items/${itemIndex}/table_semantics/reference_span_ids`,
            ),
            ...(compactAcceptanceBranches?.length ? {
              acceptance_branches: compactAcceptanceBranches.map((branch, branchIndex) => ({
                branch_id: branch.branch_id,
                condition: branch.condition,
                requirement: branch.requirement,
                allowed_value: branch.allowed_value,
                condition_fragments: fragments(
                  branch.condition_span_ids,
                  `/acceptance_items/${itemIndex}/table_semantics/acceptance_branches/${branchIndex}/condition_span_ids`,
                ),
                requirement_fragments: fragments(
                  branch.requirement_span_ids,
                  `/acceptance_items/${itemIndex}/table_semantics/acceptance_branches/${branchIndex}/requirement_span_ids`,
                ),
                allowed_value_fragments: fragments(
                  branch.allowed_value_span_ids,
                  `/acceptance_items/${itemIndex}/table_semantics/acceptance_branches/${branchIndex}/allowed_value_span_ids`,
                ),
              })),
            } : {}),
          };
        })()
      : null;
    const appliedBranches = item.sampling.applied_branches?.map((branch, branchIndex) => ({
      rule_id: branch.rule_id,
      branch_id: branch.branch_id,
      min_sampling: branch.min_sampling,
      script: branch.script,
      conditions: branch.conditions.map((condition, conditionIndex) => {
        const fragment = joined(
          condition.source_span_ids,
          `/acceptance_items/${itemIndex}/sampling/applied_branches/${branchIndex}/conditions/${conditionIndex}/source_span_ids`,
        );
        return {
          condition_id: condition.condition_id,
          text: condition.text,
          evidence_id: fragment.evidence_id,
          exact_fragment: fragment.text,
        };
      }),
      evidence_ids: branch.evidence_ids,
      components: branch.effective_components.map((component) => ({
        ...component,
        source_span_ids: [...component.source_span_ids],
        source_fragments: fragments(
          component.source_span_ids,
          `/acceptance_items/${itemIndex}/sampling/applied_branches/${branchIndex}/effective_components/${component.key}/source_span_ids`,
        ),
      })),
    }));
    const { applied_branches: _appliedBranches, ...samplingRest } = item.sampling;
    return {
      ...item,
      table_semantics: tableSemantics,
      field_bindings: fieldBindings,
      sampling: {
        ...samplingRest,
        ...(appliedBranches ? { applied_branches: appliedBranches } : {}),
      },
    };
  });

  const sharedSamplingRules = persisted.shared_sampling_rules?.map((rule, ruleIndex) => {
    const semanticSource = semanticNodeById.get(rule.source_semantic_id);
    const complete = semanticSource
      ? { evidence_id: semanticSource.evidence_id, text: semanticSource.exact_fragment }
      : joined(rule.complete_span_ids, `/shared_sampling_rules/${ruleIndex}/complete_span_ids`);
    return {
      rule_id: rule.rule_id,
      source_semantic_id: rule.source_semantic_id,
      evidence_ids: rule.evidence_ids,
      complete_source_fragment: complete.text,
      branches: rule.branches.map((branch, branchIndex) => {
        const fragment = joined(
          branch.source_span_ids.slice(0, 1),
          `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/source_span_ids`,
        );
        return {
          branch_id: branch.branch_id,
          applies_to_category: branch.applies_to_category,
          min_sampling: branch.min_sampling,
          script: branch.script,
          evidence_id: fragment.evidence_id,
          exact_fragment: fragment.text,
          conditions: (branch.conditions ?? []).map((condition, conditionIndex) => {
            const conditionFragment = joined(
              condition.source_span_ids,
              `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/conditions/${conditionIndex}/source_span_ids`,
            );
            return {
              condition_id: condition.condition_id,
              text: condition.text,
              evidence_id: conditionFragment.evidence_id,
              exact_fragment: conditionFragment.text,
            };
          }),
          components: branch.components.map((component) => ({
            ...component,
            source_span_ids: [...component.source_span_ids],
            source_fragments: fragments(
              component.source_span_ids,
              `/shared_sampling_rules/${ruleIndex}/branches/${branchIndex}/components/${component.key}/source_span_ids`,
            ),
          })),
        };
      }),
      shared_conditions: rule.shared_conditions.map((condition, conditionIndex) => {
        const fragment = joined(
          condition.source_span_ids,
          `/shared_sampling_rules/${ruleIndex}/shared_conditions/${conditionIndex}/source_span_ids`,
        );
        return {
          condition_id: condition.condition_id,
          text: condition.text,
          evidence_id: fragment.evidence_id,
          exact_fragment: fragment.text,
        };
      }),
      components: rule.components.map((component) => ({
        ...component,
        source_span_ids: [...component.source_span_ids],
        source_fragments: fragments(
          component.source_span_ids,
          `/shared_sampling_rules/${ruleIndex}/components/${component.key}/source_span_ids`,
        ),
      })),
      receiving_item_ids: rule.receiving_item_ids,
      reason: rule.reason,
    };
  });

  if (issues.length) throw new PlanHydrationError(issues);
  return {
    schema_version: "semantic-source-plan/v7",
    job_id: persisted.job_id,
    target_id: persisted.target_id,
    evidence_fingerprint: persisted.evidence_fingerprint,
    table_assembly: tableAssembly,
    inspection_lots: persisted.inspection_lots,
    acceptance_items: acceptanceItems,
    reference_resolutions: persisted.reference_resolutions,
    evidence_dispositions: persisted.evidence_dispositions,
    ...(semanticNodes ? { semantic_evidence: semanticNodes } : {}),
    ...(persisted.semantic_references ? { semantic_references: persisted.semantic_references } : {}),
    ...(sharedSamplingRules ? { shared_sampling_rules: sharedSamplingRules } : {}),
  };
}
