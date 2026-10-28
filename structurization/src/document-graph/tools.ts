import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { toolReject } from "../actionable-error.js";
import type { DocumentGraphRelation } from "./contracts.js";
import type { SemanticGraphOverlayStore } from "./overlay.js";
import type { DocumentGraphStore } from "./store.js";

function resultContent(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function compactNode(graph: DocumentGraphStore, nodeId: string, includeText = false) {
  const node = graph.getNode(nodeId);
  if (!node) return undefined;
  const text = includeText ? graph.getNodeText(nodeId) ?? "" : "";
  return {
    ...node,
    ...(includeText ? { text: text.length <= 4096 ? text : `${text.slice(0, 4096)}…`, text_truncated: text.length > 4096 } : {}),
  };
}

const RelationSchema = Type.Union([
  Type.Literal("contains"), Type.Literal("precedes"), Type.Literal("next_sibling"), Type.Literal("row_of"), Type.Literal("cell_of"),
]);

export function createDocumentGraphTools(
  graph: DocumentGraphStore,
  overlay?: SemanticGraphOverlayStore,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool({
      name: "get_document_graph_summary",
      label: "读取文档图摘要",
      description: "读取已封存文档图的精简计数和不可变指纹。",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => resultContent({ ok: true, ...graph.getDocumentSummary() }),
    }),
    defineTool({
      name: "get_document_graph_node",
      label: "读取文档图节点",
      description: "读取一个明确指定的不可变图节点，可附带有界的精确原文摘录。",
      parameters: Type.Object({ node_id: Type.String({ minLength: 1 }), include_text: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => {
        const node = compactNode(graph, String(input.node_id), input.include_text === true);
        return resultContent(node
          ? { ok: true, node }
          : toolReject({
            error: "graph_node_not_found",
            instruction: "Copy node_id from get_document_graph_summary, get_document_graph_neighborhood, or search_document_graph. Do not invent node ids.",
            actual_node_id: input.node_id,
            candidate_read_tool: "get_document_graph_summary",
          }));
      },
    }),
    defineTool({
      name: "get_document_graph_neighborhood",
      label: "读取文档图邻域",
      description: "读取指定节点周围的有界局部子图，不返回完整文档图。",
      parameters: Type.Object({ node_id: Type.String({ minLength: 1 }), relations: Type.Array(RelationSchema, { minItems: 1, maxItems: 5, uniqueItems: true }), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => resultContent({ ok: true, ...graph.getNeighborhood(String(input.node_id), input.relations as DocumentGraphRelation[], Number(input.depth ?? 1), Number(input.cursor ?? 0), Number(input.limit ?? 50)) }),
    }),
    defineTool({
      name: "search_document_graph",
      label: "检索文档图",
      description: "检索不可变节点文本和定位信息，返回有界结果；检索仅供定位，不是语义判定依据。",
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => resultContent({ ok: true, ...graph.search(String(input.query), Number(input.cursor ?? 0), Number(input.limit ?? 20)) }),
    }),
    defineTool({
      name: "explain_document_graph_path",
      label: "解释文档图路径",
      description: "通过指定物理关系，确定性查找两个明确节点间的一条有界有向路径。",
      parameters: Type.Object({ from_node_id: Type.String({ minLength: 1 }), to_node_id: Type.String({ minLength: 1 }), relations: Type.Array(RelationSchema, { minItems: 1, maxItems: 5, uniqueItems: true }), max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => {
        const path = graph.findPath(String(input.from_node_id), String(input.to_node_id), input.relations as DocumentGraphRelation[], Number(input.max_depth ?? 8));
        return resultContent(path
          ? { ok: true, path }
          : toolReject({
            error: "graph_path_not_found",
            instruction: "No path exists through the requested relations within max_depth. Copy both node ids from the graph and try a broader relation set or greater depth.",
            actual_from_node_id: input.from_node_id,
            actual_to_node_id: input.to_node_id,
          }));
      },
    }),
  ];
  if (!overlay) return tools;
  tools.push(
    defineTool({
      name: "read_semantic_graph_overlay",
      label: "读取语义图叠加层",
      description: "读取当前任务的精简语义叠加层；Agent 提议未经 harness 验证前不具有权威性。",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => resultContent({ ok: true, ...overlay.read(), validation: overlay.validate() }),
    }),
    defineTool({
      name: "stage_semantic_graph_nodes",
      label: "暂存语义图节点",
      description: "以 proposed 状态暂存当前任务的 1–32 个语义节点，不能创建不可变文档节点。",
      parameters: Type.Object({ nodes: Type.Array(Type.Object({ node_type: Type.Union([Type.Literal("target"), Type.Literal("reference_occurrence"), Type.Literal("reference_target"), Type.Literal("reference_fact"), Type.Literal("lot"), Type.Literal("item"), Type.Literal("item_field"), Type.Literal("coverage_finding")]), semantic_key: Type.String({ minLength: 1 }), producer: Type.Union([Type.Literal("discovery_agent"), Type.Literal("target_agent"), Type.Literal("reference_agent"), Type.Literal("coverage_reviewer")]), metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => resultContent({ ok: true, nodes: overlay.stageNodes(input.nodes as never) }),
    }),
    defineTool({
      name: "stage_semantic_graph_edges",
      label: "暂存语义图关系",
      description: "以 proposed 状态暂存 1–32 条带来源绑定的语义关系；未知端点或 span 会导致叠加层验证失败。",
      parameters: Type.Object({ edges: Type.Array(Type.Object({ relation: Type.Union([Type.Literal("target_scope"), Type.Literal("context_of"), Type.Literal("continuation_of"), Type.Literal("resolves_to"), Type.Literal("analyzed_as"), Type.Literal("supports_field"), Type.Literal("routed_to"), Type.Literal("materializes_to"), Type.Literal("covered_by"), Type.Literal("conflicts_with")]), from_node_id: Type.String({ minLength: 1 }), to_node_id: Type.String({ minLength: 1 }), producer: Type.Union([Type.Literal("discovery_agent"), Type.Literal("target_agent"), Type.Literal("reference_agent"), Type.Literal("coverage_reviewer")]), provenance_span_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16, uniqueItems: true }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input) => resultContent({ ok: true, edges: overlay.stageEdges(input.edges as never), validation: overlay.validate() }),
    }),
  );
  return tools;
}
