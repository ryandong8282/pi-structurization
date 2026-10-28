import { sha256Json, sha256Text } from "../canonical.js";
import {
  DOCUMENT_GRAPH_SCHEMA_VERSION,
  type BuiltDocumentGraph,
  type DocumentGraphEdge,
  type DocumentGraphNode,
  type DocumentGraphNodeType,
  type DocumentGraphRelation,
  type DocumentGraphSpan,
} from "./contracts.js";

interface SourceLine {
  number: number;
  start: number;
  content_end: number;
  end: number;
  text: string;
}

interface MutableGraph {
  document_id: string;
  markdown: string;
  nodes: DocumentGraphNode[];
  edges: DocumentGraphEdge[];
  spans: DocumentGraphSpan[];
  parent_by_node: Map<string, string>;
  last_child_by_parent: Map<string, string>;
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  let number = 1;
  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const end = newline < 0 ? markdown.length : newline + 1;
    const contentEnd = newline < 0
      ? markdown.length
      : newline > offset && markdown[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ number, start: offset, content_end: contentEnd, end, text: markdown.slice(offset, contentEnd) });
    offset = end;
    number += 1;
  }
  if (markdown.length === 0) lines.push({ number: 1, start: 0, content_end: 0, end: 0, text: "" });
  return lines;
}

function stableNodeId(
  documentId: string,
  type: DocumentGraphNodeType,
  locator: string,
  start: number,
  end: number,
  textSha256: string,
): string {
  return `graph-node:${sha256Text([documentId, type, locator, start, end, textSha256].join("\0"))}`;
}

function stableSpanId(documentId: string, start: number, end: number, textSha256: string): string {
  return `graph-span:${sha256Text([documentId, start, end, textSha256].join("\0"))}`;
}

function addNode(
  graph: MutableGraph,
  input: Omit<DocumentGraphNode, "node_id" | "document_id" | "ordinal" | "text_sha256">,
  parentId?: string,
): DocumentGraphNode {
  const text = graph.markdown.slice(input.start_offset, input.end_offset);
  const textSha256 = sha256Text(text);
  const node: DocumentGraphNode = {
    node_id: stableNodeId(graph.document_id, input.node_type, input.locator, input.start_offset, input.end_offset, textSha256),
    document_id: graph.document_id,
    ordinal: graph.nodes.length,
    text_sha256: textSha256,
    ...input,
  };
  graph.nodes.push(node);
  const span: DocumentGraphSpan = {
    span_id: stableSpanId(graph.document_id, node.start_offset, node.end_offset, node.text_sha256),
    document_id: graph.document_id,
    node_id: node.node_id,
    start_offset: node.start_offset,
    end_offset: node.end_offset,
    text_sha256: node.text_sha256,
  };
  graph.spans.push(span);
  if (parentId) {
    graph.parent_by_node.set(node.node_id, parentId);
    addEdge(graph, "contains", parentId, node.node_id, [span.span_id]);
    const previousSibling = graph.last_child_by_parent.get(parentId);
    if (previousSibling) addEdge(graph, "next_sibling", previousSibling, node.node_id, [span.span_id]);
    graph.last_child_by_parent.set(parentId, node.node_id);
  }
  return node;
}

function addEdge(
  graph: MutableGraph,
  relation: DocumentGraphRelation,
  fromNodeId: string,
  toNodeId: string,
  provenanceSpanIds: string[],
): DocumentGraphEdge {
  const facts = { document_id: graph.document_id, relation, from_node_id: fromNodeId, to_node_id: toNodeId, provenance_span_ids: provenanceSpanIds };
  const edge: DocumentGraphEdge = {
    edge_id: `graph-edge:${sha256Json(facts)}`,
    document_id: graph.document_id,
    relation,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    producer: "deterministic",
    status: "sealed",
    provenance_span_ids: provenanceSpanIds,
    edge_fingerprint: sha256Json(facts),
  };
  if (!graph.edges.some((candidate) => candidate.edge_id === edge.edge_id)) graph.edges.push(edge);
  return edge;
}

function markdownTableStart(lines: SourceLine[], index: number): boolean {
  const current = lines[index]?.text ?? "";
  const next = lines[index + 1]?.text ?? "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(next) && next.includes("|");
}

function splitMarkdownCells(line: string): Array<{ text: string; start: number; end: number }> {
  const cells: Array<{ text: string; start: number; end: number }> = [];
  const separators = [...line.matchAll(/\|/gu)].map((match) => match.index ?? 0);
  const boundaries = [-1, ...separators, line.length];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]! + 1;
    const end = boundaries[index + 1]!;
    if (end <= start) continue;
    const raw = line.slice(start, end);
    if (!raw.trim()) continue;
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const cellStart = start + leading;
    const cellEnd = Math.max(cellStart, end - trailing);
    cells.push({ text: line.slice(cellStart, cellEnd), start: cellStart, end: cellEnd });
  }
  return cells;
}

function addMarkdownTable(
  graph: MutableGraph,
  lines: SourceLine[],
  startIndex: number,
  parentId: string,
  tableOrdinal: number,
): number {
  let endIndex = startIndex + 2;
  while (endIndex < lines.length && lines[endIndex]!.text.includes("|") && lines[endIndex]!.text.trim()) endIndex += 1;
  const first = lines[startIndex]!;
  const last = lines[endIndex - 1]!;
  const table = addNode(graph, {
    node_type: "table",
    locator: `table:auto:${tableOrdinal}`,
    start_offset: first.start,
    end_offset: last.content_end,
    start_line: first.number,
    end_exclusive_line: last.number + 1,
    metadata: { syntax: "gfm", row_count: endIndex - startIndex - 1 },
  }, parentId);
  const rowIndices = [startIndex, ...Array.from({ length: Math.max(0, endIndex - startIndex - 2) }, (_, index) => startIndex + index + 2)];
  rowIndices.forEach((lineIndex, rowIndex) => {
    const line = lines[lineIndex]!;
    const row = addNode(graph, {
      node_type: "table_row",
      locator: `${table.locator}/row:${rowIndex}`,
      start_offset: line.start,
      end_offset: line.content_end,
      start_line: line.number,
      end_exclusive_line: line.number + 1,
      metadata: { row_index: rowIndex, header: rowIndex === 0 },
    }, table.node_id);
    addEdge(graph, "row_of", row.node_id, table.node_id, [graph.spans.at(-1)!.span_id]);
    splitMarkdownCells(line.text).forEach((cell, columnIndex) => {
      const node = addNode(graph, {
        node_type: "table_cell",
        locator: `${row.locator}/cell:${columnIndex}`,
        start_offset: line.start + cell.start,
        end_offset: line.start + cell.end,
        start_line: line.number,
        end_exclusive_line: line.number + 1,
        metadata: { row_index: rowIndex, column_index: columnIndex },
      }, row.node_id);
      addEdge(graph, "cell_of", node.node_id, row.node_id, [graph.spans.at(-1)!.span_id]);
    });
  });
  return endIndex;
}

function addHtmlTable(
  graph: MutableGraph,
  lines: SourceLine[],
  startIndex: number,
  parentId: string,
  tableOrdinal: number,
): number {
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !lines[endIndex - 1]!.text.toLowerCase().includes("</table>")) endIndex += 1;
  const first = lines[startIndex]!;
  const last = lines[Math.max(startIndex, endIndex - 1)]!;
  const start = first.start;
  const end = last.content_end;
  const tableText = graph.markdown.slice(start, end);
  const table = addNode(graph, {
    node_type: "table",
    locator: `table:auto:${tableOrdinal}`,
    start_offset: start,
    end_offset: end,
    start_line: first.number,
    end_exclusive_line: last.number + 1,
    metadata: { syntax: "html" },
  }, parentId);
  [...tableText.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].forEach((rowMatch, rowIndex) => {
    const relativeRowStart = rowMatch.index ?? 0;
    const rowStart = start + relativeRowStart;
    const rowEnd = rowStart + rowMatch[0].length;
    const row = addNode(graph, {
      node_type: "table_row",
      locator: `${table.locator}/row:${rowIndex}`,
      start_offset: rowStart,
      end_offset: rowEnd,
      start_line: first.number,
      end_exclusive_line: last.number + 1,
      metadata: { row_index: rowIndex, header: /<th\b/iu.test(rowMatch[0]) },
    }, table.node_id);
    addEdge(graph, "row_of", row.node_id, table.node_id, [graph.spans.at(-1)!.span_id]);
    [...rowMatch[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].forEach((cellMatch, columnIndex) => {
      const cellStart = rowStart + (cellMatch.index ?? 0);
      const cellEnd = cellStart + cellMatch[0].length;
      const cell = addNode(graph, {
        node_type: "table_cell",
        locator: `${row.locator}/cell:${columnIndex}`,
        start_offset: cellStart,
        end_offset: cellEnd,
        start_line: first.number,
        end_exclusive_line: last.number + 1,
        metadata: { row_index: rowIndex, column_index: columnIndex, text: cellMatch[1]?.replace(/<[^>]+>/gu, "").trim() ?? "" },
      }, row.node_id);
      addEdge(graph, "cell_of", cell.node_id, row.node_id, [graph.spans.at(-1)!.span_id]);
    });
  });
  return endIndex;
}

export function buildDocumentGraph(markdown: string): BuiltDocumentGraph {
  const sourceSha256 = sha256Text(markdown);
  const documentId = `document:${sourceSha256}`;
  const graph: MutableGraph = {
    document_id: documentId,
    markdown,
    nodes: [],
    edges: [],
    spans: [],
    parent_by_node: new Map(),
    last_child_by_parent: new Map(),
  };
  const lines = sourceLines(markdown);
  const document = addNode(graph, {
    node_type: "document",
    locator: "document",
    start_offset: 0,
    end_offset: markdown.length,
    start_line: 1,
    end_exclusive_line: lines.at(-1)!.number + 1,
    metadata: {},
  });
  const headingStack: Array<{ depth: number; node_id: string }> = [];
  const clauseByLocator = new Map<string, string>();
  let previousBlock: DocumentGraphNode | undefined;
  let tableOrdinal = 0;
  let paragraphOrdinal = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (!trimmed) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line.text);
    let node: DocumentGraphNode | undefined;
    if (heading) {
      const depth = heading[1]!.length;
      while (headingStack.length && headingStack.at(-1)!.depth >= depth) headingStack.pop();
      const parentId = headingStack.at(-1)?.node_id ?? document.node_id;
      const title = heading[2]!.trim();
      node = addNode(graph, {
        node_type: "heading",
        locator: `heading:${headingStack.map((entry) => entry.node_id.slice(-8)).join("/")}:${sha256Text(title).slice(0, 12)}`,
        start_offset: line.start,
        end_offset: line.content_end,
        start_line: line.number,
        end_exclusive_line: line.number + 1,
        metadata: { depth, title },
      }, parentId);
      headingStack.push({ depth, node_id: node.node_id });
      index += 1;
    } else if (line.text.trimStart().toLowerCase().startsWith("<table")) {
      tableOrdinal += 1;
      const parentId = headingStack.at(-1)?.node_id ?? document.node_id;
      const next = addHtmlTable(graph, lines, index, parentId, tableOrdinal);
      node = graph.nodes.find((candidate) => candidate.node_type === "table" && candidate.locator === `table:auto:${tableOrdinal}`)!;
      index = next;
    } else if (markdownTableStart(lines, index)) {
      tableOrdinal += 1;
      const parentId = headingStack.at(-1)?.node_id ?? document.node_id;
      const next = addMarkdownTable(graph, lines, index, parentId, tableOrdinal);
      node = graph.nodes.find((candidate) => candidate.node_type === "table" && candidate.locator === `table:auto:${tableOrdinal}`)!;
      index = next;
    } else {
      const clause = /^\s*((?:\d+\.)+\d+)(?=\s|$)/u.exec(line.text);
      if (clause) {
        const locator = `clause:${clause[1]}`;
        const parentLocator = clause[1]!.split(".").slice(0, -1).join(".");
        const parentId = clauseByLocator.get(`clause:${parentLocator}`)
          ?? headingStack.at(-1)?.node_id
          ?? document.node_id;
        node = addNode(graph, {
          node_type: "clause",
          locator,
          start_offset: line.start,
          end_offset: line.content_end,
          start_line: line.number,
          end_exclusive_line: line.number + 1,
          metadata: { number: clause[1] },
        }, parentId);
        clauseByLocator.set(locator, node.node_id);
      } else {
        paragraphOrdinal += 1;
        const parentId = headingStack.at(-1)?.node_id ?? document.node_id;
        node = addNode(graph, {
          node_type: "paragraph",
          locator: `paragraph:${paragraphOrdinal}`,
          start_offset: line.start,
          end_offset: line.content_end,
          start_line: line.number,
          end_exclusive_line: line.number + 1,
          metadata: {},
        }, parentId);
      }
      index += 1;
    }
    if (node && previousBlock) {
      const span = graph.spans.find((candidate) => candidate.node_id === node!.node_id)!;
      addEdge(graph, "precedes", previousBlock.node_id, node.node_id, [span.span_id]);
    }
    if (node) previousBlock = node;
  }
  const nodes = [...graph.nodes].sort((left, right) => left.ordinal - right.ordinal);
  const edges = [...graph.edges].sort((left, right) => left.edge_id.localeCompare(right.edge_id));
  const spans = [...graph.spans].sort((left, right) => left.span_id.localeCompare(right.span_id));
  const graphFingerprint = sha256Json({ schema_version: DOCUMENT_GRAPH_SCHEMA_VERSION, document_id: documentId, source_sha256: sourceSha256, nodes, edges, spans });
  return {
    schema_version: DOCUMENT_GRAPH_SCHEMA_VERSION,
    document_id: documentId,
    source_sha256: sourceSha256,
    markdown_bytes: Buffer.byteLength(markdown, "utf8"),
    nodes,
    edges,
    spans,
    graph_fingerprint: graphFingerprint,
  };
}
