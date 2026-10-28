import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { sha256Json, sha256Text } from "../canonical.js";
import { buildDocumentGraph } from "./builder.js";
import {
  DOCUMENT_GRAPH_SCHEMA_VERSION,
  type BuiltDocumentGraph,
  type DocumentGraphEdge,
  type DocumentGraphNode,
  type DocumentGraphPage,
  type DocumentGraphPath,
  type DocumentGraphRelation,
  type DocumentGraphSeal,
  type DocumentGraphSpan,
  type DocumentGraphVerification,
} from "./contracts.js";

type SqliteDatabase = InstanceType<typeof Database>;

function schema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS documents (
      document_id TEXT PRIMARY KEY,
      source_sha256 TEXT NOT NULL UNIQUE,
      markdown_bytes INTEGER NOT NULL,
      graph_schema_version TEXT NOT NULL,
      graph_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('building', 'sealed'))
    );
    CREATE TABLE IF NOT EXISTS nodes (
      node_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      node_type TEXT NOT NULL,
      locator TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_exclusive_line INTEGER NOT NULL,
      text_sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      edge_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      relation TEXT NOT NULL,
      from_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      to_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      producer TEXT NOT NULL,
      status TEXT NOT NULL,
      provenance_span_ids_json TEXT NOT NULL,
      edge_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_seals (
      document_id TEXT PRIMARY KEY REFERENCES documents(document_id),
      seal_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nodes_locator ON nodes(document_id, locator);
    CREATE INDEX IF NOT EXISTS nodes_type_ordinal ON nodes(document_id, node_type, ordinal);
    CREATE INDEX IF NOT EXISTS edges_from_relation ON edges(from_node_id, relation);
    CREATE INDEX IF NOT EXISTS edges_to_relation ON edges(to_node_id, relation);
    CREATE VIRTUAL TABLE IF NOT EXISTS node_text USING fts5(node_id UNINDEXED, locator, text);
  `);
}

function nodeFromRow(row: Record<string, unknown>): DocumentGraphNode {
  return {
    node_id: String(row.node_id),
    document_id: String(row.document_id),
    node_type: String(row.node_type) as DocumentGraphNode["node_type"],
    locator: String(row.locator),
    ordinal: Number(row.ordinal),
    start_offset: Number(row.start_offset),
    end_offset: Number(row.end_offset),
    start_line: Number(row.start_line),
    end_exclusive_line: Number(row.end_exclusive_line),
    text_sha256: String(row.text_sha256),
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
  };
}

function edgeFromRow(row: Record<string, unknown>): DocumentGraphEdge {
  return {
    edge_id: String(row.edge_id),
    document_id: String(row.document_id),
    relation: String(row.relation) as DocumentGraphRelation,
    from_node_id: String(row.from_node_id),
    to_node_id: String(row.to_node_id),
    producer: "deterministic",
    status: "sealed",
    provenance_span_ids: JSON.parse(String(row.provenance_span_ids_json)) as string[],
    edge_fingerprint: String(row.edge_fingerprint),
  };
}

export class DocumentGraphStore implements Disposable {
  private constructor(
    readonly path: string,
    private readonly db: SqliteDatabase,
  ) {}

  static async create(path: string, markdown: string): Promise<DocumentGraphStore> {
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path);
    schema(db);
    const store = new DocumentGraphStore(path, db);
    const sourceSha256 = sha256Text(markdown);
    const existing = db.prepare("SELECT source_sha256, status FROM documents LIMIT 1").get() as { source_sha256: string; status: string } | undefined;
    if (existing) {
      if (existing.source_sha256 !== sourceSha256 || existing.status !== "sealed") {
        db.close();
        throw new Error("Document graph file belongs to different or unsealed source bytes");
      }
      const verification = store.verify(markdown);
      if (!verification.ok) {
        db.close();
        throw new Error(`Persisted document graph verification failed: ${JSON.stringify(verification.issues)}`);
      }
      return store;
    }
    store.persist(buildDocumentGraph(markdown), markdown);
    return store;
  }

  static open(path: string): DocumentGraphStore {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    schema(db);
    return new DocumentGraphStore(path, db);
  }

  private persist(graph: BuiltDocumentGraph, markdown: string): void {
    const insertDocument = this.db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)");
    const insertNode = this.db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEdge = this.db.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertSpan = this.db.prepare("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?)");
    const insertText = this.db.prepare("INSERT INTO node_text(node_id, locator, text) VALUES (?, ?, ?)");
    const insertSeal = this.db.prepare("INSERT INTO graph_seals(document_id, seal_json) VALUES (?, ?)");
    const transaction = this.db.transaction(() => {
      insertDocument.run(graph.document_id, graph.source_sha256, graph.markdown_bytes, graph.schema_version, graph.graph_fingerprint, "building");
      for (const node of graph.nodes) {
        insertNode.run(node.node_id, node.document_id, node.node_type, node.locator, node.ordinal, node.start_offset, node.end_offset, node.start_line, node.end_exclusive_line, node.text_sha256, JSON.stringify(node.metadata));
        insertText.run(node.node_id, node.locator, markdown.slice(node.start_offset, node.end_offset));
      }
      for (const edge of graph.edges) insertEdge.run(edge.edge_id, edge.document_id, edge.relation, edge.from_node_id, edge.to_node_id, edge.producer, edge.status, JSON.stringify(edge.provenance_span_ids), edge.edge_fingerprint);
      for (const span of graph.spans) insertSpan.run(span.span_id, span.document_id, span.node_id, span.start_offset, span.end_offset, span.text_sha256);
      const seal: DocumentGraphSeal = {
        schema_version: "document-evidence-graph-seal/v1",
        document_id: graph.document_id,
        source_sha256: graph.source_sha256,
        graph_fingerprint: graph.graph_fingerprint,
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
        span_count: graph.spans.length,
      };
      insertSeal.run(graph.document_id, JSON.stringify(seal));
      this.db.prepare("UPDATE documents SET status = 'sealed' WHERE document_id = ?").run(graph.document_id);
    });
    transaction();
  }

  getSeal(): DocumentGraphSeal {
    const row = this.db.prepare("SELECT seal_json FROM graph_seals LIMIT 1").get() as { seal_json: string } | undefined;
    if (!row) throw new Error("Document graph has no seal");
    return JSON.parse(row.seal_json) as DocumentGraphSeal;
  }

  getNode(nodeId: string): DocumentGraphNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE node_id = ?").get(nodeId) as Record<string, unknown> | undefined;
    return row ? nodeFromRow(row) : undefined;
  }

  hasNode(nodeId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM nodes WHERE node_id = ?").get(nodeId));
  }

  hasSpan(spanId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM spans WHERE span_id = ?").get(spanId));
  }

  getSpansForNode(nodeId: string): DocumentGraphSpan[] {
    return (this.db.prepare("SELECT * FROM spans WHERE node_id = ? ORDER BY start_offset, end_offset").all(nodeId) as Array<Record<string, unknown>>).map((span) => ({
      span_id: String(span.span_id),
      document_id: String(span.document_id),
      node_id: String(span.node_id),
      start_offset: Number(span.start_offset),
      end_offset: Number(span.end_offset),
      text_sha256: String(span.text_sha256),
    }));
  }

  getNodeText(nodeId: string): string | undefined {
    const row = this.db.prepare("SELECT text FROM node_text WHERE node_id = ?").get(nodeId) as { text: string } | undefined;
    return row?.text;
  }

  getDocumentSummary(): {
    document_id: string;
    source_sha256: string;
    graph_fingerprint: string;
    markdown_bytes: number;
    node_count: number;
    edge_count: number;
    span_count: number;
    node_counts_by_type: Record<string, number>;
  } {
    const document = this.db.prepare("SELECT * FROM documents LIMIT 1").get() as Record<string, unknown>;
    const nodeCounts = this.db.prepare("SELECT node_type, count(*) AS count FROM nodes GROUP BY node_type ORDER BY node_type").all() as Array<{ node_type: string; count: number }>;
    return {
      document_id: String(document.document_id),
      source_sha256: String(document.source_sha256),
      graph_fingerprint: String(document.graph_fingerprint),
      markdown_bytes: Number(document.markdown_bytes),
      node_count: Number((this.db.prepare("SELECT count(*) AS count FROM nodes").get() as { count: number }).count),
      edge_count: Number((this.db.prepare("SELECT count(*) AS count FROM edges").get() as { count: number }).count),
      span_count: Number((this.db.prepare("SELECT count(*) AS count FROM spans").get() as { count: number }).count),
      node_counts_by_type: Object.fromEntries(nodeCounts.map((entry) => [entry.node_type, Number(entry.count)])),
    };
  }

  getNodesByLocator(locator: string): DocumentGraphNode[] {
    return (this.db.prepare("SELECT * FROM nodes WHERE locator = ? ORDER BY ordinal").all(locator) as Record<string, unknown>[]).map(nodeFromRow);
  }

  getChildren(nodeId: string, relation: DocumentGraphRelation = "contains"): DocumentGraphNode[] {
    return (this.db.prepare(`
      SELECT n.* FROM edges e
      JOIN nodes n ON n.node_id = e.to_node_id
      WHERE e.from_node_id = ? AND e.relation = ?
      ORDER BY n.ordinal
    `).all(nodeId, relation) as Record<string, unknown>[]).map(nodeFromRow);
  }

  getNeighborhood(
    nodeId: string,
    relations: DocumentGraphRelation[],
    depth = 1,
    cursor = 0,
    limit = 100,
  ): DocumentGraphPage<DocumentGraphNode> {
    const relationSet = new Set(relations);
    const seen = new Set([nodeId]);
    let frontier = [nodeId];
    for (let level = 0; level < Math.max(0, depth); level += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        const rows = this.db.prepare("SELECT relation, from_node_id, to_node_id FROM edges WHERE from_node_id = ? OR to_node_id = ?").all(current, current) as Array<{ relation: DocumentGraphRelation; from_node_id: string; to_node_id: string }>;
        for (const row of rows) {
          if (!relationSet.has(row.relation)) continue;
          const adjacent = row.from_node_id === current ? row.to_node_id : row.from_node_id;
          if (seen.has(adjacent)) continue;
          seen.add(adjacent);
          next.push(adjacent);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    const ids = [...seen];
    const rows = ids.map((id) => this.getNode(id)).filter((node): node is DocumentGraphNode => Boolean(node)).sort((left, right) => left.ordinal - right.ordinal);
    const boundedCursor = Math.max(0, Math.trunc(cursor));
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const page = rows.slice(boundedCursor, boundedCursor + boundedLimit);
    return { rows: page, next_cursor: boundedCursor + page.length < rows.length ? boundedCursor + page.length : null, total_count: rows.length };
  }

  search(query: string, cursor = 0, limit = 50): DocumentGraphPage<DocumentGraphNode & { rank: number }> {
    const boundedCursor = Math.max(0, Math.trunc(cursor));
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const ftsTotal = Number((this.db.prepare("SELECT count(*) AS count FROM node_text WHERE node_text MATCH ?").get(query) as { count: number }).count);
    const ftsRows = this.db.prepare(`
      SELECT n.*, bm25(node_text) AS rank
      FROM node_text JOIN nodes n ON n.node_id = node_text.node_id
      WHERE node_text MATCH ?
      ORDER BY rank, n.ordinal LIMIT ? OFFSET ?
    `).all(query, boundedLimit, boundedCursor) as Array<Record<string, unknown>>;
    const useSubstringFallback = ftsTotal === 0 && /[^\x00-\x7F]/u.test(query);
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const total = useSubstringFallback
      ? Number((this.db.prepare("SELECT count(*) AS count FROM node_text WHERE text LIKE ? ESCAPE '\\'").get(`%${escaped}%`) as { count: number }).count)
      : ftsTotal;
    const rows = useSubstringFallback
      ? this.db.prepare(`
          SELECT n.*, 0 AS rank
          FROM node_text JOIN nodes n ON n.node_id = node_text.node_id
          WHERE node_text.text LIKE ? ESCAPE '\\'
          ORDER BY n.ordinal LIMIT ? OFFSET ?
        `).all(`%${escaped}%`, boundedLimit, boundedCursor) as Array<Record<string, unknown>>
      : ftsRows;
    return {
      rows: rows.map((row) => ({ ...nodeFromRow(row), rank: Number(row.rank) })),
      next_cursor: boundedCursor + rows.length < total ? boundedCursor + rows.length : null,
      total_count: total,
    };
  }

  findPath(fromNodeId: string, toNodeId: string, relations: DocumentGraphRelation[], maxDepth = 8): DocumentGraphPath | undefined {
    const relationSet = new Set(relations);
    const queue: Array<{ node_id: string; node_ids: string[]; edge_ids: string[] }> = [{ node_id: fromNodeId, node_ids: [fromNodeId], edge_ids: [] }];
    const seen = new Set([fromNodeId]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.node_id === toNodeId) return { node_ids: current.node_ids, edge_ids: current.edge_ids };
      if (current.edge_ids.length >= maxDepth) continue;
      const edges = this.db.prepare("SELECT * FROM edges WHERE from_node_id = ?").all(current.node_id) as Record<string, unknown>[];
      for (const raw of edges) {
        const edge = edgeFromRow(raw);
        if (!relationSet.has(edge.relation) || seen.has(edge.to_node_id)) continue;
        seen.add(edge.to_node_id);
        queue.push({ node_id: edge.to_node_id, node_ids: [...current.node_ids, edge.to_node_id], edge_ids: [...current.edge_ids, edge.edge_id] });
      }
    }
    return undefined;
  }

  verify(markdown: string): DocumentGraphVerification {
    const issues: DocumentGraphVerification["issues"] = [];
    const document = this.db.prepare("SELECT * FROM documents LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!document) return { ok: false, source_sha256: sha256Text(markdown), expected_graph_fingerprint: "", actual_graph_fingerprint: "", issues: [{ code: "document_missing", message: "Graph database has no document record" }] };
    const sourceSha256 = sha256Text(markdown);
    if (String(document.source_sha256) !== sourceSha256) issues.push({ code: "source_hash_mismatch", message: "Markdown bytes differ from sealed document source" });
    const nodes = (this.db.prepare("SELECT * FROM nodes ORDER BY ordinal").all() as Record<string, unknown>[]).map(nodeFromRow);
    const edges = (this.db.prepare("SELECT * FROM edges ORDER BY edge_id").all() as Record<string, unknown>[]).map(edgeFromRow);
    const spans = this.db.prepare("SELECT * FROM spans ORDER BY span_id").all() as Array<Record<string, unknown>>;
    for (const span of spans) {
      const start = Number(span.start_offset);
      const end = Number(span.end_offset);
      if (start < 0 || end < start || end > markdown.length) issues.push({ code: "span_out_of_bounds", message: "Graph span is outside source bytes", details: { span_id: span.span_id } });
      else if (sha256Text(markdown.slice(start, end)) !== String(span.text_sha256)) issues.push({ code: "span_hash_mismatch", message: "Graph span no longer matches source text", details: { span_id: span.span_id } });
    }
    const fingerprintPayload = {
      schema_version: DOCUMENT_GRAPH_SCHEMA_VERSION,
      document_id: String(document.document_id),
      source_sha256: String(document.source_sha256),
      nodes,
      edges,
      spans: spans.map((span) => ({ span_id: String(span.span_id), document_id: String(span.document_id), node_id: String(span.node_id), start_offset: Number(span.start_offset), end_offset: Number(span.end_offset), text_sha256: String(span.text_sha256) })),
    };
    const actualGraphFingerprint = sha256Json(fingerprintPayload);
    const expectedGraphFingerprint = String(document.graph_fingerprint);
    if (actualGraphFingerprint !== expectedGraphFingerprint) issues.push({ code: "graph_fingerprint_mismatch", message: "Persisted nodes, edges or spans differ from the sealed graph" });
    return { ok: issues.length === 0, source_sha256: sourceSha256, expected_graph_fingerprint: expectedGraphFingerprint, actual_graph_fingerprint: actualGraphFingerprint, issues };
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
