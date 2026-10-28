import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDocumentEvidence, buildAgentScopedEvidenceManifest, targetEvidenceLineSpan } from "../src/document-discovery.js";
import { prefillDocumentSelectorsFromLedger, scanDocumentLedger } from "../src/document-ledger.js";
import { compileDocumentSelectors } from "../src/document-selector-compiler.js";
import { approveScopeFixture } from "./scope-fixture.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";
import { clipSourceToLineWindow } from "../src/source-window.js";
import { targetOwnScopeForTarget, targetPrimaryScope } from "../src/batch.js";
import { buildStructuredTargetEvidence } from "../src/evidence.js";
import { sha256Text } from "../src/canonical.js";

function table(id: string, name: string, rows = [[name, "设计要求"]]): string {
  return `表 ${id} ${name}质量检验标准\n<table><tr><td>项</td><td>序</td><td>检查项目</td><td>允许值</td><td>检查方法</td></tr>${rows.map(([label, value], i) => `<tr><td>主控项目</td><td>${i + 1}</td><td>${label}</td><td>${value}</td><td>尺量检查</td></tr>`).join("")}</table>`;
}

const SOURCE = [
  "# 4 质量验收", "## 4.1 前段工程", "### 主控项目",
  "4.1.1 前段工程应符合表4.1.1的规定。", table("4.1.1", "前段专属项目"),
  "前段背景。".repeat(240),
  "## 4.2 本段工程", "### 主控项目", "4.2.1 本段工程应符合表4.2.1的规定。",
  table("4.2.1", "本段工程", [["本段长度", "±10"], ["本段直径", "±5"]]),
  "## 4.3 后段工程", "### 主控项目", "4.3.1 后段工程应符合表4.3.1的规定。",
  table("4.3.1", "后段专属项目"), "后段背景。".repeat(240),
].join("\n\n");

function prefill(markdown: string, atomChars = 1000) {
  const evidence = buildDocumentEvidence(markdown, "scope.md", atomChars);
  const ledger = scanDocumentLedger(markdown, "scope.md");
  const registry = registryWithFullSourceSpans(evidence.evidence_fingerprint, evidence.atoms.map((atom) => ({
    source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
  })));
  const draft = prefillDocumentSelectorsFromLedger("scope-test", evidence.atoms, ledger, registry);
  const plan = compileDocumentSelectors(approveScopeFixture(draft.selectors, draft.registry, evidence), draft.registry, evidence, "scope-test");
  const target = plan.targets.find((target) => target.name === "本段工程")!;
  expect(target).toBeDefined();
  const window = { ...ledger.windows.find((window) => window.number === "4.2")!,
    start_line: target.work_scope!.start_line, end_exclusive_line: target.work_scope!.end_exclusive_line };
  // ledger 导航窗口可含末尾空行；准备器只能接收上游已确认的精确范围。
  return { evidence, ledger, draft, plan, target, window };
}

describe("exact target ownership versus transport/navigation scope", () => {
  test("clips atom text at real line boundaries and drops whitespace-only contact", () => {
    const source = { start_line: 5, text: "\n后段内容\r\n再一行" };
    expect(clipSourceToLineWindow(source, { start_line: 4, end_exclusive_line: 6 })).toBeUndefined();
    const range = clipSourceToLineWindow(source, { start_line: 6, end_exclusive_line: 7 })!;
    expect(source.text.slice(range.start, range.end)).toBe("后段内容");
  });

  test("ledger prefill binds section intersections, not whole overlapping transport atoms", () => {
    const { target, window, evidence } = prefill(SOURCE);
    const text = target.evidence_fragments.map((fragment) => fragment.text).join("\n");
    expect(text).toContain("本段长度");
    expect(text).toContain("本段直径");
    expect(text).not.toContain("前段专属项目");
    expect(text).not.toContain("后段专属项目");
    const span = targetEvidenceLineSpan(target, evidence);
    expect(span.start_line).toBe(window.start_line);
    expect(span.end_exclusive_line).toBeLessThanOrEqual(window.end_exclusive_line);
    expect(targetOwnScopeForTarget(target, undefined, evidence.atoms)?.start_line).toBe(window.start_line);
  });

  test("confirmed work scope takes precedence over legacy broad fragments and stale coordinates without rewriting the target", () => {
    const { target, ledger, evidence, window } = prefill(SOURCE);
    const legacy = { ...structuredClone(target),
      ledger_window_id: window.window_id, start_line: 1, end_exclusive_line: 3,
      evidence_fragments: evidence.atoms.map((atom) => ({ atom_id: atom.atom_id, text: atom.text })),
    };
    expect(targetOwnScopeForTarget(legacy, ledger, evidence.atoms)).toEqual({
      start_line: window.start_line, end_exclusive_line: window.end_exclusive_line,
    });
    expect(targetPrimaryScope(legacy, ledger, evidence.atoms, [legacy])).toEqual(target.work_scope);
    expect(legacy.start_line).toBe(1);
  });

  test("explicitly authored subtargets retain their separate source blocks despite stale legacy coordinates", () => {
    const markdown = SOURCE.replace("4.2.1 本段工程应符合表4.2.1的规定。",
      "4.2.1 本段长度应符合设计要求。\n\n4.2.2 本段直径应符合设计要求。");
    const { ledger, evidence, draft } = prefill(markdown, 6000);
    const quotes = ["4.2.1 本段长度应符合设计要求。", "4.2.2 本段直径应符合设计要求。"];
    const parent = draft.selectors.targets.find(target => target.name === "本段工程")!;
    let registry = draft.registry;
    draft.selectors.targets = quotes.map((quote, index) => {
      const atom = evidence.atoms.find((atom) => atom.text.includes(quote))!;
      const located = locateAndRegisterSourceQuote(registry, {
        source_id: atom.atom_id, evidence_id: atom.atom_id, atom_id: atom.atom_id, text: atom.text,
      }, quote);
      registry = located.registry;
      const span = located.spans[0]!.span_id;
      return { ...structuredClone(parent), key: `metric-${index}`, name: `独立指标${index + 1}`,
        scope_span_ids: [span], lot_basis_span_ids: [span], reference_span_ids: [],
        source_blocks: [{ kind: "explicit_range" as const, anchor_span_id: span,
          start_span_id: span, end_span_id: span, reason: "夹具显式选择单项条款，不授权准备器扩张范围。" }] };
    });
    const targets = compileDocumentSelectors(approveScopeFixture(draft.selectors, registry, evidence), registry, evidence, "scope-test")
      .targets.map(target => ({ ...target, start_line: 1, end_exclusive_line: 3 }));
    const scopes = targets.map((target) => targetPrimaryScope(target, ledger, evidence.atoms, targets)!);
    expect(scopes[0]!.end_exclusive_line).toBeLessThanOrEqual(scopes[1]!.start_line);
    for (const [index, target] of targets.entries()) {
      expect(scopes[index]).toEqual(target.work_scope);
      expect(target.work_scope!.primary_fragments!.map(fragment => fragment.text).join("")).toBe(quotes[index]);
      const anchor = targetEvidenceLineSpan(target, evidence).start_line;
      expect(anchor).toBeGreaterThanOrEqual(scopes[index]!.start_line);
      expect(anchor).toBeLessThan(scopes[index]!.end_exclusive_line);
    }
  });

  test("an explicit work scope takes precedence over broad legacy evidence", () => {
    const scope = { start_line: 30, end_exclusive_line: 40 };
    expect(targetOwnScopeForTarget({ start_line: 1, end_exclusive_line: 200, work_scope: scope })).toEqual(scope);
  });

  test("table and prose lanes obey the same confirmed boundary without automatically importing neighboring tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-primary-boundary-"));
    try {
      const file = join(root, "scope.md");
      await writeFile(file, SOURCE, "utf8");
      const { target, evidence, window } = prefill(SOURCE);
      // Keep the old, overbroad discovery shape: an exact primaryScope must win
      // in both the table lane and prose lane, and in public scope metadata.
      target.evidence_fragments = evidence.atoms.map((atom) => ({ atom_id: atom.atom_id, text: atom.text }));
      target.evidence_atom_ids = evidence.atoms.map((atom) => atom.atom_id);
      const { manifest } = await buildAgentScopedEvidenceManifest(file, "scope-test", target, evidence, undefined, window);
      const required = manifest.evidence.filter((record) => record.requires_disposition || record.evidence_scope === "primary");
      expect(required.length).toBeGreaterThan(0);
      expect(required.every((record) => {
        const line = Number(/^line:(\d+)/u.exec(record.locator)?.[1]);
        return line >= window.start_line && line < window.end_exclusive_line;
      })).toBe(true);
      expect(required.filter((record) => record.role === "formal_table_row")).toHaveLength(2);
      expect(manifest.evidence.some((record) => record.table_id === "4.1.1")).toBe(false);
      expect(manifest.evidence.some((record) => record.table_id === "4.3.1")).toBe(false);
      expect(manifest.scope.selected_start_line).toBe(window.start_line);
      expect(manifest.scope.selected_end_exclusive_line).toBe(window.end_exclusive_line);
      expect(manifest.scope.target_evidence_fragments?.some((fragment) => /前段专属|后段专属/u.test(fragment.text))).toBe(false);
      expect(await readFile(file, "utf8")).toBe(SOURCE);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("uncolumned criteria tables remain required row evidence without pre-expanding items", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-uncolumned-table-evidence-"));
    try {
      const uncolumnedTable = [
        "表 4.2.1 本段工程质量检验标准",
        "<table><tr><td>项目</td><td>允许值</td><td>检查方法</td></tr><tr><td>本段长度</td><td>±10</td><td>尺量检查</td></tr><tr><td>本段直径</td><td>±5</td><td>尺量检查</td></tr></table>",
      ].join("\n");
      const markdown = SOURCE.replace(
        table("4.2.1", "本段工程", [["本段长度", "±10"], ["本段直径", "±5"]]),
        uncolumnedTable,
      );
      const file = join(root, "scope.md");
      await writeFile(file, markdown, "utf8");
      const { target, evidence, window } = prefill(markdown);
      const { manifest } = await buildAgentScopedEvidenceManifest(
        file,
        "scope-test",
        target,
        evidence,
        undefined,
        window,
      );
      const rows = manifest.evidence.filter((record) =>
        record.table_id === "4.2.1" && record.table_row_kind === "data"
      );
      expect(manifest.table_fragments).toHaveLength(1);
      expect(rows).toHaveLength(2);
      expect(rows.every((record) =>
        record.evidence_scope === "primary" && record.requires_disposition
      )).toBe(true);
      expect(manifest.scope.selected_start_line).toBe(target.work_scope!.start_line);
      expect(manifest.scope.selected_end_exclusive_line).toBe(target.work_scope!.end_exclusive_line);
      expect(manifest.scope.target_evidence_fragments).toEqual(target.work_scope!.primary_fragments!.map(({ atom_id, text }) => ({ atom_id, text })));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("changing transport chunk size cannot change primary evidence ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-chunk-invariance-"));
    try {
      const file = join(root, "scope.md");
      await writeFile(file, SOURCE, "utf8");
      const ids: string[][] = [];
      for (const size of [1000, 2000, 6000]) {
        const { target, evidence, window } = prefill(SOURCE, size);
        const { manifest } = await buildAgentScopedEvidenceManifest(file, "scope-test", target, evidence, undefined, window);
        ids.push(manifest.evidence.filter((record) => record.requires_disposition || record.evidence_scope === "primary").map((record) => record.evidence_id).sort());
      }
      expect(ids[1]).toEqual(ids[0]);
      expect(ids[2]).toEqual(ids[0]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("an invalid explicit primary scope is rejected instead of silently widening it", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-invalid-scope-"));
    try {
      const file = join(root, "scope.md");
      await writeFile(file, SOURCE, "utf8");
      const { target, evidence } = prefill(SOURCE);
      await expect(buildAgentScopedEvidenceManifest(file, "scope-test", target, evidence, undefined,
        { start_line: 0, end_exclusive_line: 99999 })).rejects.toThrow("target_scope_revision_required");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a referenced table outside the core remains reference evidence, not a new primary task", () => {
    const markdown = ["4.2.1 本段应符合表4.2.1规定。", table("4.2.1", "本段", [["本段尺寸", "本标准表4.3.1"]]),
      "## 4.3 其他工程", table("4.3.1", "引用尺寸")].join("\n");
    const end = markdown.split("\n").findIndex((line) => line.startsWith("## 4.3")) + 1;
    const result = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 1, end_exclusive_line: end }]);
    expect(result.evidence.some((record) => record.table_id === "4.2.1" && record.evidence_scope === "primary")).toBe(true);
    expect(result.evidence.some((record) => record.table_id === "4.3.1" && record.evidence_scope === "reference")).toBe(true);
    expect(result.evidence.some((record) => record.table_id === "4.3.1" && record.evidence_scope === "primary")).toBe(false);
  });

  test("an actual continued table is retained without adopting unrelated neighboring tables", () => {
    const first = table("4.2.1", "本段第一项");
    const continuation = table("4.2.1", "本段第二项").replace("表 4.2.1 本段第二项质量检验标准", "续表 4.2.1");
    const markdown = [first, "<!-- next page -->", continuation, table("4.3.1", "后段专属项目")].join("\n");
    const result = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 2, end_exclusive_line: 3 }]);
    const primaryRows = result.evidence.filter((record) => record.evidence_scope === "primary" && record.role === "formal_table_row");
    expect(primaryRows).toHaveLength(2);
    expect(primaryRows.every((record) => record.table_id === "4.2.1")).toBe(true);
  });

  test("a window inside a multiline table retains the full table but not trailing prose", () => {
    const markdown = [
      "表 4.2.1 本段质量检验标准", "<table>",
      "<tr><td>项</td><td>序</td><td>检查项目</td><td>允许值</td><td>检查方法</td></tr>",
      "<tr><td>主控项目</td><td>1</td><td>长度</td><td>±10</td><td>尺量检查</td></tr>",
      "</table>", "4.3.1 后段要求不得混入。",
    ].join("\n");
    const result = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 4, end_exclusive_line: 5 }]);
    expect(result.evidence.filter((record) => record.role === "formal_table_row")).toHaveLength(1);
    expect(result.evidence.some((record) => record.text.includes("后段要求"))).toBe(false);
    expect(result.table_fragments[0]?.provisional_title).toBe("表 4.2.1 本段质量检验标准");
  });

  test("uncertain caption context outside the selected table remains support, not a primary obligation", () => {
    const markdown = ["相邻背景说明。", "", "可能的表名", table("4.2.1", "长度").split("\n")[1]!].join("\n");
    const result = buildStructuredTargetEvidence(markdown, sha256Text(markdown), [{ start_line: 4, end_exclusive_line: 5 }]);
    expect(result.evidence.filter((record) => record.role === "formal_table_row")).toHaveLength(1);
    const context = result.evidence.find((record) => record.text === "相邻背景说明。");
    expect(context).toMatchObject({ evidence_scope: "reference", requires_disposition: false });
  });
});
