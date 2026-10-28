import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildDocumentGraph, DocumentGraphStore } from "../src/document-graph/index.js";

const roots: string[] = [];

async function tempDatabase(): Promise<string> {
  const root = resolve(".tmp-tests", `document-graph-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return resolve(root, "graph.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const MARKDOWN = [
  "# 8 工程电气测试",
  "8.0.1 综合布线工程电气性能测试应符合规定。",
  "8.0.2 综合布线系统工程的电气测试应按验收项目执行。",
  "",
  "| 检查项目 | 允许值 | 方法 |",
  "| --- | --- | --- |",
  "| 插入损耗 | ≤ 2.5 dB | 仪表测试 |",
  "| 回波损耗 | ≥ 20 dB | 仪表测试 |",
  "",
  "## 8.1 测试记录",
  "测试记录应保留。",
  "<table><tr><th>对象</th><th>要求</th></tr><tr><td>光纤</td><td>测试衰减</td></tr></table>",
].join("\n");

describe("immutable document evidence graph", () => {
  test("builds stable structural nodes, exact spans, tables and deterministic edges", () => {
    const first = buildDocumentGraph(MARKDOWN);
    const second = buildDocumentGraph(MARKDOWN);
    expect(second).toEqual(first);
    expect(first.document_id).toMatch(/^document:[a-f0-9]{64}$/u);
    expect(first.graph_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.nodes.filter((node) => node.node_type === "heading")).toHaveLength(2);
    expect(first.nodes.filter((node) => node.node_type === "clause")).toHaveLength(2);
    expect(first.nodes.filter((node) => node.node_type === "table")).toHaveLength(2);
    expect(first.nodes.some((node) => node.node_type === "table_cell" && node.metadata.text === "测试衰减")).toBe(true);
    expect(first.edges.some((edge) => edge.relation === "contains")).toBe(true);
    expect(first.edges.some((edge) => edge.relation === "precedes")).toBe(true);
    for (const span of first.spans) {
      expect(span.text_sha256).toBeTruthy();
      expect(span.end_offset).toBeGreaterThanOrEqual(span.start_offset);
    }
  });

  test("persists, seals, reopens, verifies and queries one immutable SQLite graph", async () => {
    const path = await tempDatabase();
    const store = await DocumentGraphStore.create(path, MARKDOWN);
    let seal;
    try {
      seal = store.getSeal();
      expect(seal.node_count).toBeGreaterThan(10);
      expect(store.verify(MARKDOWN)).toMatchObject({ ok: true, issues: [] });
      expect(store.verify(`${MARKDOWN}\nchanged`)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "source_hash_mismatch" })]) });

      const clause = store.getNodesByLocator("clause:8.0.1")[0]!;
      const document = store.getNodesByLocator("document")[0]!;
      expect(clause.metadata).toMatchObject({ number: "8.0.1" });
      expect(store.getChildren(document.node_id)).not.toHaveLength(0);
      expect(store.getNeighborhood(clause.node_id, ["contains", "precedes", "next_sibling"], 2).total_count).toBeGreaterThan(1);
      expect(store.search("插入损耗").rows.some((node) => node.node_type === "table_cell")).toBe(true);
      expect(store.findPath(document.node_id, clause.node_id, ["contains"], 4)?.node_ids.at(-1)).toBe(clause.node_id);
    } finally {
      store.close();
    }

    const reopened = DocumentGraphStore.open(path);
    try {
      expect(reopened.getSeal()).toEqual(seal);
      expect(reopened.verify(MARKDOWN).ok).toBe(true);
    } finally {
      reopened.close();
    }
  });

  test("reuses an existing sealed graph only for identical source bytes", async () => {
    const path = await tempDatabase();
    const first = await DocumentGraphStore.create(path, MARKDOWN);
    const seal = first.getSeal();
    first.close();
    const second = await DocumentGraphStore.create(path, MARKDOWN);
    expect(second.getSeal()).toEqual(seal);
    second.close();
    await expect(DocumentGraphStore.create(path, `${MARKDOWN}\nchanged`)).rejects.toThrow("different or unsealed source bytes");
  });
});
