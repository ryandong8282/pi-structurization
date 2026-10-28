import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { sha256Json, sha256Text } from "../canonical.js";
import type {
  SemanticOverlayEdge,
  SemanticOverlayNode,
  SemanticOverlayProducer,
  SemanticOverlayRelation,
  SemanticOverlaySeal,
  SemanticOverlayValidation,
} from "./contracts.js";
import type { DocumentGraphStore } from "./store.js";

type SqliteDatabase = InstanceType<typeof Database>;

function overlaySchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS overlay_manifest (
      overlay_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      base_graph_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('working', 'sealed')),
      overlay_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_nodes (
      node_id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      semantic_key TEXT NOT NULL UNIQUE,
      producer TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'validated')),
      metadata_json TEXT NOT NULL,
      node_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_edges (
      edge_id TEXT PRIMARY KEY,
      relation TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      producer TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'validated')),
      provenance_span_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      edge_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS overlay_seal (
      overlay_id TEXT PRIMARY KEY,
      seal_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS overlay_edges_from ON semantic_edges(from_node_id, relation);
    CREATE INDEX IF NOT EXISTS overlay_edges_to ON semantic_edges(to_node_id, relation);
  `);
}

function semanticNodeId(overlayId: string, nodeType: SemanticOverlayNode["node_type"], semanticKey: string): string {
  return `semantic-node:${sha256Text([overlayId, nodeType, semanticKey].join("\0"))}`;
}

function nodeFromRow(row: Record<string, unknown>): SemanticOverlayNode {
  return {
    node_id: String(row.node_id),
    node_type: String(row.node_type) as SemanticOverlayNode["node_type"],
    semantic_key: String(row.semantic_key),
    producer: String(row.producer) as SemanticOverlayProducer,
    status: String(row.status) as SemanticOverlayNode["status"],
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    node_fingerprint: String(row.node_fingerprint),
  };
}

function edgeFromRow(row: Record<string, unknown>): SemanticOverlayEdge {
  return {
    edge_id: String(row.edge_id),
    relation: String(row.relation) as SemanticOverlayRelation,
    from_node_id: String(row.from_node_id),
    to_node_id: String(row.to_node_id),
    producer: String(row.producer) as SemanticOverlayProducer,
    status: String(row.status) as SemanticOverlayEdge["status"],
    provenance_span_ids: JSON.parse(String(row.provenance_span_ids_json)) as string[],
    reason: String(row.reason),
    edge_fingerprint: String(row.edge_fingerprint),
  };
}

export interface StageSemanticNodeInput {
  node_type: SemanticOverlayNode["node_type"];
  semantic_key: string;
  producer: Exclude<SemanticOverlayProducer, "compiler">;
  metadata?: Record<string, unknown>;
}

export interface StageSemanticEdgeInput {
  relation: SemanticOverlayRelation;
  from_node_id: string;
  to_node_id: string;
  producer: Exclude<SemanticOverlayProducer, "compiler">;
  provenance_span_ids: string[];
  reason: string;
}

export class SemanticGraphOverlayStore implements Disposable {
  private constructor(
    readonly path: string,
    readonly baseGraph: DocumentGraphStore,
    private readonly db: SqliteDatabase,
  ) {}

  static async create(path: string, baseGraph: DocumentGraphStore, overlayKey: string): Promise<SemanticGraphOverlayStore> {
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path);
    overlaySchema(db);
    const store = new SemanticGraphOverlayStore(path, baseGraph, db);
    const base = baseGraph.getDocumentSummary();
    const overlayId = `semantic-overlay:${sha256Text([base.document_id, base.graph_fingerprint, overlayKey].join("\0"))}`;
    const existing = db.prepare("SELECT * FROM overlay_manifest LIMIT 1").get() as Record<string, unknown> | undefined;
    if (existing) {
      if (String(existing.overlay_id) !== overlayId || String(existing.base_graph_fingerprint) !== base.graph_fingerprint) {
        db.close();
        throw new Error("Semantic overlay belongs to another base graph or overlay key");
      }
      return store;
    }
    db.prepare("INSERT INTO overlay_manifest VALUES (?, ?, ?, 'working', '')").run(overlayId, base.document_id, base.graph_fingerprint);
    return store;
  }

  private manifest(): { overlay_id: string; document_id: string; base_graph_fingerprint: string; status: "working" | "sealed"; overlay_fingerprint: string } {
    const row = this.db.prepare("SELECT * FROM overlay_manifest LIMIT 1").get() as Record<string, unknown>;
    return {
      overlay_id: String(row.overlay_id),
      document_id: String(row.document_id),
      base_graph_fingerprint: String(row.base_graph_fingerprint),
      status: String(row.status) as "working" | "sealed",
      overlay_fingerprint: String(row.overlay_fingerprint),
    };
  }

  private assertWorking(): void {
    if (this.manifest().status !== "working") throw new Error("Semantic graph overlay is sealed");
  }

  stageNodes(inputs: StageSemanticNodeInput[]): SemanticOverlayNode[] {
    this.assertWorking();
    if (inputs.length < 1 || inputs.length > 32) throw new Error("One semantic node transaction must contain 1-32 records");
    const overlayId = this.manifest().overlay_id;
    const upsert = this.db.prepare(`
      INSERT INTO semantic_nodes VALUES (?, ?, ?, ?, 'proposed', ?, ?)
      ON CONFLICT(semantic_key) DO UPDATE SET
        node_type = excluded.node_type,
        producer = excluded.producer,
        status = 'proposed',
        metadata_json = excluded.metadata_json,
        node_fingerprint = excluded.node_fingerprint
    `);
    const transaction = this.db.transaction(() => inputs.map((input) => {
      const metadata = input.metadata ?? {};
      const nodeId = semanticNodeId(overlayId, input.node_type, input.semantic_key);
      const fingerprint = sha256Json({ node_id: nodeId, node_type: input.node_type, semantic_key: input.semantic_key, producer: input.producer, metadata });
      upsert.run(nodeId, input.node_type, input.semantic_key, input.producer, JSON.stringify(metadata), fingerprint);
      return this.getNode(nodeId)!;
    }));
    return transaction();
  }

  stageEdges(inputs: StageSemanticEdgeInput[]): SemanticOverlayEdge[] {
    this.assertWorking();
    if (inputs.length < 1 || inputs.length > 32) throw new Error("One semantic edge transaction must contain 1-32 records");
    const insert = this.db.prepare("INSERT OR REPLACE INTO semantic_edges VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)");
    const transaction = this.db.transaction(() => inputs.map((input) => {
      const facts = { relation: input.relation, from_node_id: input.from_node_id, to_node_id: input.to_node_id, producer: input.producer, provenance_span_ids: [...new Set(input.provenance_span_ids)].sort(), reason: input.reason };
      const fingerprint = sha256Json(facts);
      const edgeId = `semantic-edge:${fingerprint}`;
      insert.run(edgeId, input.relation, input.from_node_id, input.to_node_id, input.producer, JSON.stringify(facts.provenance_span_ids), input.reason, fingerprint);
      return this.getEdge(edgeId)!;
    }));
    return transaction();
  }

  getNode(nodeId: string): SemanticOverlayNode | undefined {
    const row = this.db.prepare("SELECT * FROM semantic_nodes WHERE node_id = ?").get(nodeId) as Record<string, unknown> | undefined;
    return row ? nodeFromRow(row) : undefined;
  }

  getEdge(edgeId: string): SemanticOverlayEdge | undefined {
    const row = this.db.prepare("SELECT * FROM semantic_edges WHERE edge_id = ?").get(edgeId) as Record<string, unknown> | undefined;
    return row ? edgeFromRow(row) : undefined;
  }

  read(): { manifest: ReturnType<SemanticGraphOverlayStore["manifest"]>; nodes: SemanticOverlayNode[]; edges: SemanticOverlayEdge[] } {
    return {
      manifest: this.manifest(),
      nodes: (this.db.prepare("SELECT * FROM semantic_nodes ORDER BY semantic_key").all() as Record<string, unknown>[]).map(nodeFromRow),
      edges: (this.db.prepare("SELECT * FROM semantic_edges ORDER BY edge_id").all() as Record<string, unknown>[]).map(edgeFromRow),
    };
  }

  validate(): SemanticOverlayValidation {
    const overlay = this.read();
    const issues: SemanticOverlayValidation["issues"] = [];
    const overlayNodeIds = new Set(overlay.nodes.map((node) => node.node_id));
    const endpointExists = (nodeId: string) => overlayNodeIds.has(nodeId) || this.baseGraph.hasNode(nodeId);
    overlay.edges.forEach((edge, index) => {
      if (!endpointExists(edge.from_node_id)) issues.push({ code: "overlay_unknown_from_node", path: `/edges/${index}/from_node_id`, message: "Semantic edge source is not present in the base graph or overlay", details: { node_id: edge.from_node_id } });
      if (!endpointExists(edge.to_node_id)) issues.push({ code: "overlay_unknown_to_node", path: `/edges/${index}/to_node_id`, message: "Semantic edge destination is not present in the base graph or overlay", details: { node_id: edge.to_node_id } });
      if (edge.provenance_span_ids.length === 0) issues.push({ code: "overlay_provenance_missing", path: `/edges/${index}/provenance_span_ids`, message: "Every semantic edge requires exact base-graph provenance" });
      edge.provenance_span_ids.forEach((spanId, spanIndex) => {
        if (!this.baseGraph.hasSpan(spanId)) issues.push({ code: "overlay_unknown_provenance_span", path: `/edges/${index}/provenance_span_ids/${spanIndex}`, message: "Semantic edge names an unknown base-graph span", details: { span_id: spanId } });
      });
    });
    const overlayFingerprint = sha256Json({ overlay_id: overlay.manifest.overlay_id, document_id: overlay.manifest.document_id, base_graph_fingerprint: overlay.manifest.base_graph_fingerprint, nodes: overlay.nodes, edges: overlay.edges });
    return { ok: issues.length === 0, overlay_fingerprint: overlayFingerprint, issues };
  }

  promoteValidated(nodeIds: string[], edgeIds: string[]): SemanticOverlayValidation {
    this.assertWorking();
    const before = this.validate();
    if (!before.ok) return before;
    const updateNode = this.db.prepare("UPDATE semantic_nodes SET status = 'validated' WHERE node_id = ?");
    const updateEdge = this.db.prepare("UPDATE semantic_edges SET status = 'validated' WHERE edge_id = ?");
    this.db.transaction(() => {
      nodeIds.forEach((id) => {
        if (updateNode.run(id).changes !== 1) throw new Error(`Unknown semantic node: ${id}`);
      });
      edgeIds.forEach((id) => {
        if (updateEdge.run(id).changes !== 1) throw new Error(`Unknown semantic edge: ${id}`);
      });
    })();
    return this.validate();
  }

  seal(): SemanticOverlaySeal {
    this.assertWorking();
    const validation = this.validate();
    if (!validation.ok) throw new Error(`Semantic overlay validation failed: ${JSON.stringify(validation.issues)}`);
    const overlay = this.read();
    if (overlay.nodes.some((node) => node.status !== "validated") || overlay.edges.some((edge) => edge.status !== "validated")) {
      throw new Error("Semantic overlay contains unvalidated Agent proposals");
    }
    const seal: SemanticOverlaySeal = {
      schema_version: "semantic-graph-overlay-seal/v1",
      overlay_id: overlay.manifest.overlay_id,
      document_id: overlay.manifest.document_id,
      base_graph_fingerprint: overlay.manifest.base_graph_fingerprint,
      overlay_fingerprint: validation.overlay_fingerprint,
      node_count: overlay.nodes.length,
      edge_count: overlay.edges.length,
    };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO overlay_seal VALUES (?, ?)").run(seal.overlay_id, JSON.stringify(seal));
      this.db.prepare("UPDATE overlay_manifest SET status = 'sealed', overlay_fingerprint = ? WHERE overlay_id = ?").run(seal.overlay_fingerprint, seal.overlay_id);
    })();
    return seal;
  }

  close(): void { this.db.close(); }
  [Symbol.dispose](): void { this.close(); }
}
