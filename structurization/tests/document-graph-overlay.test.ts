import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDocumentGraphTools,
  DocumentGraphStore,
  SemanticGraphOverlayStore,
} from "../src/document-graph/index.js";

const roots: string[] = [];

async function fixture() {
  const root = resolve(".tmp-tests", `document-graph-overlay-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  const markdown = ["# 8 工程电气测试", "8.0.7 测试记录应符合附录要求。", "测试记录应保存。"].join("\n");
  const graph = await DocumentGraphStore.create(resolve(root, "graph.sqlite"), markdown);
  const overlay = await SemanticGraphOverlayStore.create(resolve(root, "overlay.sqlite"), graph, "target:engineering-electrical");
  return { root, markdown, graph, overlay };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("semantic document graph overlay", () => {
  test("keeps Agent proposals separate until harness validation and sealing", async () => {
    const { graph, overlay } = await fixture();
    try {
      const clause = graph.getNodesByLocator("clause:8.0.7")[0]!;
      const target = overlay.stageNodes([{ node_type: "target", semantic_key: "engineering-electrical", producer: "discovery_agent", metadata: { name: "工程电气测试" } }])[0]!;
      const provenance = graph.getSpansForNode(clause.node_id)[0]!.span_id;
      const edge = overlay.stageEdges([{ relation: "target_scope", from_node_id: target.node_id, to_node_id: clause.node_id, producer: "discovery_agent", provenance_span_ids: [provenance], reason: "条款属于该目标范围" }])[0]!;
      expect(target.status).toBe("proposed");
      expect(edge.status).toBe("proposed");
      expect(overlay.validate()).toMatchObject({ ok: true, issues: [] });
      expect(() => overlay.seal()).toThrow("unvalidated Agent proposals");
      expect(overlay.promoteValidated([target.node_id], [edge.edge_id])).toMatchObject({ ok: true });
      expect(overlay.seal()).toMatchObject({ node_count: 1, edge_count: 1, overlay_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(() => overlay.stageNodes([{ node_type: "item", semantic_key: "late", producer: "target_agent" }])).toThrow("overlay is sealed");
    } finally {
      overlay.close();
      graph.close();
    }
  });

  test("rejects unknown endpoints and provenance spans", async () => {
    const { graph, overlay } = await fixture();
    try {
      overlay.stageEdges([{ relation: "supports_field", from_node_id: "missing:a", to_node_id: "missing:b", producer: "target_agent", provenance_span_ids: ["graph-span:missing"], reason: "错误夹具" }]);
      expect(overlay.validate().issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "overlay_unknown_from_node" }),
        expect.objectContaining({ code: "overlay_unknown_to_node" }),
        expect.objectContaining({ code: "overlay_unknown_provenance_span" }),
      ]));
    } finally {
      overlay.close();
      graph.close();
    }
  });

  test("exposes only bounded graph queries and proposed overlay mutation tools", async () => {
    const { graph, overlay } = await fixture();
    try {
      const tools = createDocumentGraphTools(graph, overlay);
      expect(tools.map((tool) => tool.name)).toEqual([
        "get_document_graph_summary",
        "get_document_graph_node",
        "get_document_graph_neighborhood",
        "search_document_graph",
        "explain_document_graph_path",
        "read_semantic_graph_overlay",
        "stage_semantic_graph_nodes",
        "stage_semantic_graph_edges",
      ]);
      expect(tools.map((tool) => tool.name)).not.toContain("seal_semantic_graph_overlay");
      const summary = await tools[0]!.execute("summary", {}, undefined as never, undefined as never) as { details: Record<string, unknown> };
      expect(summary.details).toMatchObject({ ok: true, node_count: expect.any(Number), graph_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      const search = await tools[3]!.execute("search", { query: "工程电气测试", limit: 5 }, undefined as never, undefined as never) as { details: Record<string, unknown> };
      expect(search.details).toMatchObject({ ok: true, total_count: expect.any(Number) });
      expect(Buffer.byteLength(JSON.stringify(search.details), "utf8")).toBeLessThan(32 * 1024);
    } finally {
      overlay.close();
      graph.close();
    }
  });
});
