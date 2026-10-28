import { describe, expect, test } from "vitest";

import type { SemanticEvidenceNode, SemanticSourcePlan } from "../src/contracts.js";
import {
  semanticReferenceEvidenceIdsForDestination,
  semanticReferenceTargetNodesForDestination,
} from "../src/semantic-draft.js";

function node(semanticId: string, materializedItemId: string): SemanticEvidenceNode {
  return {
    semantic_id: semanticId,
    role: "referenced_clause",
    evidence_id: `evidence:${semanticId}`,
    exact_fragment: semanticId,
    parent_semantic_id: "",
    materialized_item_id: materializedItemId,
    reason: "test",
  };
}

describe("semantic reference destination coverage", () => {
  test("requires shared nodes and only the table branch assigned to each expanded item", () => {
    const nodes = [
      node("table-root", ""),
      node("branch-a", "item-a"),
      node("branch-b", "item-b"),
    ];

    expect(semanticReferenceTargetNodesForDestination(nodes, "item-a").map((entry) => entry.semantic_id))
      .toEqual(["table-root", "branch-a"]);
    expect(semanticReferenceTargetNodesForDestination(nodes, "item-b").map((entry) => entry.semantic_id))
      .toEqual(["table-root", "branch-b"]);
  });

  test("routes semantic anchor and target evidence to the declared destination field", () => {
    const anchor: SemanticEvidenceNode = {
      semantic_id: "anchor",
      role: "reference_anchor",
      evidence_id: "evidence:anchor",
      exact_fragment: "anchor",
      parent_semantic_id: "",
      materialized_item_id: "",
      reason: "test",
    };
    const plan = {
      semantic_evidence: [
        anchor,
        node("table-root", ""),
        node("branch-a", "item-a"),
        node("branch-b", "item-b"),
      ],
      semantic_references: [{
        expansion_id: "expansion",
        anchor_semantic_id: "anchor",
        status: "resolved",
        target_semantic_ids: ["table-root", "branch-a", "branch-b"],
        destination_bindings: [{ item_id: "item-a", fields: ["requirement"] }],
        reason: "test",
      }],
    } as unknown as SemanticSourcePlan;

    expect([...semanticReferenceEvidenceIdsForDestination(plan, "item-a", "requirement")])
      .toEqual(["evidence:anchor", "evidence:table-root", "evidence:branch-a"]);
    expect([...semanticReferenceEvidenceIdsForDestination(plan, "item-a", "method")])
      .toEqual([]);
  });
});
