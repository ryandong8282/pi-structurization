export const DOCUMENT_GRAPH_SCHEMA_VERSION = "document-evidence-graph/v1" as const;

export type DocumentGraphNodeType =
  | "document"
  | "heading"
  | "clause"
  | "paragraph"
  | "table"
  | "table_row"
  | "table_cell";

export type DocumentGraphRelation =
  | "contains"
  | "precedes"
  | "next_sibling"
  | "row_of"
  | "cell_of";

export interface DocumentGraphNode {
  node_id: string;
  document_id: string;
  node_type: DocumentGraphNodeType;
  locator: string;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_exclusive_line: number;
  text_sha256: string;
  metadata: Record<string, unknown>;
}

export interface DocumentGraphEdge {
  edge_id: string;
  document_id: string;
  relation: DocumentGraphRelation;
  from_node_id: string;
  to_node_id: string;
  producer: "deterministic";
  status: "sealed";
  provenance_span_ids: string[];
  edge_fingerprint: string;
}

export interface DocumentGraphSpan {
  span_id: string;
  document_id: string;
  node_id: string;
  start_offset: number;
  end_offset: number;
  text_sha256: string;
}

export interface BuiltDocumentGraph {
  schema_version: typeof DOCUMENT_GRAPH_SCHEMA_VERSION;
  document_id: string;
  source_sha256: string;
  markdown_bytes: number;
  nodes: DocumentGraphNode[];
  edges: DocumentGraphEdge[];
  spans: DocumentGraphSpan[];
  graph_fingerprint: string;
}

export interface DocumentGraphSeal {
  schema_version: "document-evidence-graph-seal/v1";
  document_id: string;
  source_sha256: string;
  graph_fingerprint: string;
  node_count: number;
  edge_count: number;
  span_count: number;
}

export interface DocumentGraphVerification {
  ok: boolean;
  source_sha256: string;
  expected_graph_fingerprint: string;
  actual_graph_fingerprint: string;
  issues: Array<{ code: string; message: string; details?: unknown }>;
}

export interface DocumentGraphPage<T> {
  rows: T[];
  next_cursor: number | null;
  total_count: number;
}

export interface DocumentGraphPath {
  node_ids: string[];
  edge_ids: string[];
}

export type SemanticOverlayRelation =
  | "target_scope"
  | "context_of"
  | "continuation_of"
  | "resolves_to"
  | "analyzed_as"
  | "supports_field"
  | "routed_to"
  | "materializes_to"
  | "covered_by"
  | "conflicts_with";

export type SemanticOverlayProducer =
  | "discovery_agent"
  | "target_agent"
  | "reference_agent"
  | "coverage_reviewer"
  | "compiler";

export interface SemanticOverlayNode {
  node_id: string;
  node_type: "target" | "reference_occurrence" | "reference_target" | "reference_fact" | "lot" | "item" | "item_field" | "coverage_finding";
  semantic_key: string;
  producer: SemanticOverlayProducer;
  status: "proposed" | "validated";
  metadata: Record<string, unknown>;
  node_fingerprint: string;
}

export interface SemanticOverlayEdge {
  edge_id: string;
  relation: SemanticOverlayRelation;
  from_node_id: string;
  to_node_id: string;
  producer: SemanticOverlayProducer;
  status: "proposed" | "validated";
  provenance_span_ids: string[];
  reason: string;
  edge_fingerprint: string;
}

export interface SemanticOverlaySeal {
  schema_version: "semantic-graph-overlay-seal/v1";
  overlay_id: string;
  document_id: string;
  base_graph_fingerprint: string;
  overlay_fingerprint: string;
  node_count: number;
  edge_count: number;
}

export interface SemanticOverlayValidation {
  ok: boolean;
  overlay_fingerprint: string;
  issues: Array<{ code: string; path: string; message: string; details?: unknown }>;
}
