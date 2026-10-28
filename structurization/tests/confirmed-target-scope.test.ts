import { describe, expect, test, vi } from "vitest";
// 此处只测试本地范围与工具契约，不初始化 SDK 的交互终端/模型连接。
vi.mock("@earendil-works/pi-coding-agent", () => ({ defineTool: (tool: unknown) => tool }));
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText, atomicWriteJson } from "../src/atomic.js";
import { buildDocumentEvidence, buildAgentScopedEvidenceManifest, validateDocumentTargetPlan } from "../src/document-discovery.js";
import { compileDocumentSelectors, initialDocumentSelectorPlan, type DocumentSelectorPlan } from "../src/document-selector-compiler.js";
import { registryWithFullSourceSpans, locateAndRegisterSourceQuote } from "../src/source-span-registry.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import { confirmedTargetScope, TargetScopeConflict } from "../src/confirmed-target-scope.js";
import { persistedManifestExtendsPreparedBase, targetOwnScopeForTarget, targetPrimaryScope } from "../src/batch.js";
import { sha256Text } from "../src/canonical.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { ToolController, createPiTools } from "../src/tools.js";
import { TARGET_SELECTOR_SYSTEM_PROMPT } from "../src/pi-runtime.js";
import { clipSourceToLineWindow } from "../src/source-window.js";
import type { DocumentEvidence, DocumentTargetPlan } from "../src/document-discovery.js";

const text = `# 10.2 工程验收
10.2.1 正文要求。
# 附录 A 空白记录
空白验收表。
# 附录 B 结构性能检验
## B.1 判定
B.1.1 构件应满足判定指标。
## B.2 试验
B.2.1 检验方法：加载并测量。
# 附录 C 其他检验
C.0.1 其他要求。
# 没有标准编号的标题
构件外观应完整。
# 附录 AA 特殊构件
AA.1 应检查连接。
# 附录 AB 后续内容
AB.1 不属于 AA。
# 一、中文结构
中文编号内容。
# Ⅱ 罗马结构
罗马编号内容。
OCR 压平标题：围护结构检验
围护结构应完整。
<table><tr><td>项目</td><td>允许值</td></tr><tr><td>挠度</td><td>L/200</td></tr></table>
`;

function fixture(primary: string[], refs: string[] = []) {
  const document = buildDocumentEvidence(text, "source.md");
  const sources = document.atoms.map(atom => ({ source_id: atom.atom_id, atom_id: atom.atom_id, evidence_id: atom.atom_id, text: atom.text }));
  let registry = registryWithFullSourceSpans(document.evidence_fingerprint, sources);
  const locate = (quote: string) => {
    const source = sources.find(source => source.text.includes(quote))!;
    const result = locateAndRegisterSourceQuote(registry, source, quote);
    registry = result.registry;
    return result.spans[0]!.span_id;
  };
  const plan = initialDocumentSelectorPlan("scope-test");
  const primarySpanIds = primary.map(locate);
  const anchorSpanIds = primary.map(value => locate(value.split("\n")[0]!));
  plan.targets.push({
    key: "b", group_key: "tests", group_name: "检验", group_reason: "按原文任务分组", name: "结构性能检验",
    lot_basis_summary: "已阅读并选择主资料", scope_span_ids: primarySpanIds, reference_span_ids: refs.map(locate),
    source_blocks: primarySpanIds.map((spanId, index) => ({
      kind: primary[index]!.startsWith("#") ? "heading_section" as const : "explicit_range" as const,
      anchor_span_id: anchorSpanIds[index]!, start_span_id: spanId, end_span_id: spanId,
      reason: "Agent 已根据原文语义明确确认这个连续主资料块的起止边界",
    })),
    lot_basis_span_ids: anchorSpanIds, reason: "按原文确定主资料和共享参考范围",
  });
  plan.dispositions = sources.map(source => ({ atom_span_id: locate(source.text), disposition: "target" as const, target_keys: ["b"], reason: "已核对所有原文" }));
  return { target: compileDocumentSelectors(plan, registry, document, "scope-test").targets[0]!, document };
}

const appendix = text.slice(text.indexOf("# 附录 B"), text.indexOf("# 附录 C")).trimEnd();

describe("Agent 确认的主资料范围", () => {
  const liveRoot = "data/jobs/20260907-094050-gb50204-selfreview-luna-medium/pi-agent/jobs/20260907-094050-gb50204-selfreview-luna-medium";
  const livePlanPath = join(liveRoot, "discovery/document-target-plan.json");
  const liveSelectorPath = join(liveRoot, "discovery/working.document-selectors.json");
  test.skipIf(!existsSync(liveSelectorPath))("000008 当前迁移 selector 可离线编译，22 个目标边界互不污染", async () => {
    const document = JSON.parse(await readFile(join(liveRoot, "discovery/document-evidence.json"), "utf8")) as DocumentEvidence;
    const selectors = JSON.parse(await readFile(liveSelectorPath, "utf8")) as DocumentSelectorPlan;
    const registry = JSON.parse(await readFile(join(liveRoot, "discovery/source-span-registry.json"), "utf8")) as SourceSpanRegistry;
    const plan = compileDocumentSelectors(selectors, registry, document, selectors.job_id);
    expect(plan.targets).toHaveLength(22);
    expect(validateDocumentTargetPlan(plan, document, plan.job_id, new Set(document.atoms.map(atom => atom.atom_id))))
      .toMatchObject({ ok: true, issues: [] });
    const structure = plan.targets.find(target => target.name === "受弯预制构件结构性能检验")!;
    const structureText = structure.work_scope!.primary_fragments!.map(fragment => fragment.text).join("");
    expect(structureText).toContain("B.1.6"); expect(structureText).toContain("B.2.11");
    expect(structureText).not.toContain("附录 A"); expect(structureText).not.toContain("附录 C");
    const entity = plan.targets.find(target => target.name === "结构实体检验")!;
    const entityText = entity.work_scope!.primary_fragments!.map(fragment => fragment.text).join("");
    expect(entityText).toContain("10.1.5"); expect(entityText).not.toContain("10.2 混凝土结构子分部工程验收");
  });
  test.skipIf(!existsSync(livePlanPath))("000008 封存目标范围可复核；离线重建附录 B 后正文完整且无 A/10.2 污染", async () => {
    const planPath = livePlanPath;
    const before = await readFile(planPath, "utf8");
    const plan = JSON.parse(before) as DocumentTargetPlan;
    const target = plan.targets.find(target => target.target_id === "target:4aa90b6d1d0305c69650d3f6")!;
    const document = JSON.parse(await readFile(join(liveRoot, "discovery/document-evidence.json"), "utf8")) as DocumentEvidence;
    expect(() => confirmedTargetScope(target, document)).not.toThrow();
    const sourcePath = join(liveRoot, "discovery/source.md");
    const source = await readFile(sourcePath, "utf8");
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex(line => /^#+\s*附录\s*B\s/.test(line)) + 1;
    const end = lines.findIndex((line, i) => i >= start && /^#+\s*附录\s*C\s/.test(line)) + 1;
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    // 仅用于验证准备器的人工固定输入，不写回发现计划，不声称已完成线上 Agent 修订。
    const fragments = document.atoms.flatMap(atom => {
      const range = clipSourceToLineWindow(atom, { start_line: start, end_exclusive_line: end });
      if (!range) return [];
      const text = atom.text.slice(range.start, range.end);
      return [{ atom_id: atom.atom_id, start: range.start, end: range.end, text, text_sha256: sha256Text(text) }];
    });
    const last = fragments.at(-1)!;
    const lastAtom = document.atoms.find(atom => atom.atom_id === last.atom_id)!;
    const endLine = lastAtom.start_line + (lastAtom.text.slice(0, last.start).match(/\n/g)?.length ?? 0) + (last.text.match(/\n/g)?.length ?? 0) + (last.text.endsWith("\n") ? 0 : 1);
    const anchors = target.work_scope!.anchor_fragments!.filter(fragment => fragment.text.length < 200);
    const anchor = anchors.find(fragment => /附录\s*B/u.test(fragment.text)) ?? anchors[0]!;
    const fixed = { ...structuredClone(target), work_scope: {
      start_line: start, end_exclusive_line: endLine, source_sha256: document.source.sha256,
      primary_fragments: fragments, reference_fragments: [], anchor_fragments: anchors,
      source_blocks: [{ kind: "heading_section" as const, anchor_fragment: anchor, start_fragment: fragments[0]!, end_fragment: fragments.at(-1)!, reason: "离线确认附录 B 从标题起至附录 C 前结束" }],
      reason: "离线回归固定选择附录 B 全部正文",
    } };
    const prepared = await buildAgentScopedEvidenceManifest(sourcePath, plan.job_id, fixed, document);
    const primary = prepared.manifest.evidence.filter(row => row.evidence_scope === "primary").map(row => row.text).join("\n");
    expect(primary).toContain("B.1.6");
    expect(primary).toContain("B.2");
    expect(primary).not.toMatch(/10\.2\.[1-4]/);
    expect(primary).not.toContain("附录 A");
    expect(primary).not.toContain("附录 C");
    expect(primary).not.toContain("附录 D");
    expect(await readFile(planPath, "utf8")).toBe(before);
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  });
  test("附录整体包括 B.2，引用正文不移动范围，不吞 10.2 或附录 A", async () => {
    const { target, document } = fixture([appendix], ["10.2.1 正文要求。"]);
    const scope = confirmedTargetScope(target, document);
    expect(scope.ranges).toEqual([{ start_line: 5, end_exclusive_line: 10 }]);
    const ledger = scanDocumentLedger(text, "source.md");
    expect(targetOwnScopeForTarget(target, ledger, document.atoms)).toMatchObject({ start_line: 5, end_exclusive_line: 10 });
    expect(targetPrimaryScope(target as never, ledger, document.atoms, [target])).toMatchObject({ start_line: 5, end_exclusive_line: 10 });
    const root = await mkdtemp(join(tmpdir(), "confirmed-scope-"));
    try {
      const path = join(root, "source.md");
      await atomicWriteText(path, text);
      const { manifest } = await buildAgentScopedEvidenceManifest(path, "scope-test", target, document, undefined, scope);
      const primary = manifest.evidence.filter(row => row.evidence_scope === "primary").map(row => row.text).join("\n");
      expect(primary).toContain("B.2.1");
      expect(primary).not.toContain("10.2.1");
      expect(primary).not.toContain("空白验收表");
      expect(manifest.scope.selection_reason).toContain("不能覆盖或扩大");
      const old = structuredClone(manifest);
      delete old.scope.confirmed_scope_fingerprint;
      expect(persistedManifestExtendsPreparedBase(old, manifest)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("end_before_span 以 Agent 指定的后继边界结束，不解析附录编号", () => {
    const { target, document } = fixture([appendix]);
    const quote = "# 附录 C 其他检验";
    const atom = document.atoms.find(candidate => candidate.text.includes(quote))!;
    const start = atom.text.indexOf(quote);
    const boundary = { atom_id: atom.atom_id, start, end: start + quote.length, text: quote, text_sha256: sha256Text(quote) };
    const block = target.work_scope!.source_blocks![0]!;
    delete block.end_fragment;
    block.end_before_fragment = boundary;
    expect(() => confirmedTargetScope(target, document)).not.toThrow();
  });

  test("重复参考 span 被规范化，不重复生成引用 evidence", () => {
    const { target, document } = fixture([appendix], ["10.2.1 正文要求。", "10.2.1 正文要求。"]);
    expect(target.work_scope!.reference_fragments).toHaveLength(1);
    expect(() => confirmedTargetScope(target, document)).not.toThrow();
  });

  test("顶层标题锚点只选标题和末行时，必须补齐全部子节", () => {
    const { target, document } = fixture([appendix]);
    const fragment = (quote: string) => {
      const atom = document.atoms.find(atom => atom.text.includes(quote))!;
      const start = atom.text.indexOf(quote);
      return { atom_id: atom.atom_id, start, end: start + quote.length, text: quote, text_sha256: sha256Text(quote) };
    };
    target.work_scope!.primary_fragments = [structuredClone(target.work_scope!.anchor_fragments![0]!), fragment("B.1.1 构件应满足判定指标。")];
    target.work_scope!.start_line = 5;
    target.work_scope!.end_exclusive_line = 8;
    expect(() => confirmedTargetScope(target, document)).toThrow("存在未提交的非空主资料");
  });

  test.each([
    ["附录子节", ["## B.2 试验\nB.2.1 检验方法：加载并测量。"], [8, 10]],
    ["非标准标题", ["# 没有标准编号的标题\n构件外观应完整。"], [12, 14]],
  ])("%s 使用原文范围，不寻找上一数字节", (_name, fragments, expected) => {
    const { target, document } = fixture(fragments as string[]);
    const scope = confirmedTargetScope(target, document);
    expect([scope.start_line, scope.end_exclusive_line]).toEqual(expected);
  });

  test("不连续片段独立准备，中间未选原文不成为 primary", async () => {
    const { target, document } = fixture(["## B.1 判定\nB.1.1 构件应满足判定指标。", "# 没有标准编号的标题\n构件外观应完整。"]);
    const scope = confirmedTargetScope(target, document);
    expect(scope.ranges).toHaveLength(2);
    const root = await mkdtemp(join(tmpdir(), "disjoint-scope-"));
    try {
      const path = join(root, "source.md"); await atomicWriteText(path, text);
      const { manifest } = await buildAgentScopedEvidenceManifest(path, "scope-test", target, document, undefined, scope);
      const primary = manifest.evidence.filter(row => row.evidence_scope === "primary").map(row => row.text).join("\n");
      expect(primary).toContain("B.1.1"); expect(primary).toContain("构件外观");
      expect(primary).not.toContain("B.2.1"); expect(primary).not.toContain("C.0.1");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    ["双字母附录", "# 附录 AA 特殊构件\nAA.1 应检查连接。"],
    ["中文编号", "# 一、中文结构\n中文编号内容。"],
    ["罗马编号", "# Ⅱ 罗马结构\n罗马编号内容。"],
    ["无 Markdown 标题的 OCR 正文", "OCR 压平标题：围护结构检验\n围护结构应完整。"],
    ["独立表格", "<table><tr><td>项目</td><td>允许值</td></tr><tr><td>挠度</td><td>L/200</td></tr></table>"],
  ])("%s 的边界由 Agent 坐标声明，不依赖编号正则", (_name, source) => {
    const { target, document } = fixture([source]);
    expect(() => confirmedTargetScope(target, document)).not.toThrow();
  });

  test("拒绝整 atom 越过已声明块边界，也拒绝重复或重叠 primary", () => {
    const { target, document } = fixture([appendix]);
    const atom = document.atoms[0]!;
    const whole = { atom_id: atom.atom_id, start: 0, end: atom.text.length, text: atom.text, text_sha256: sha256Text(atom.text) };
    target.work_scope!.primary_fragments = [whole];
    target.work_scope!.start_line = 1;
    target.work_scope!.end_exclusive_line = text.split(/\r?\n/u).length;
    expect(() => confirmedTargetScope(target, document)).toThrow("只落入一个已声明 source block");

    const valid = fixture([appendix]);
    valid.target.work_scope!.primary_fragments!.push(structuredClone(valid.target.work_scope!.primary_fragments![0]!));
    expect(() => confirmedTargetScope(valid.target, valid.document)).toThrow("重复或重叠");
  });

  test("冲突返回发现 Agent 的任务、锚点和可写路径，不改变计划", () => {
    const { target, document } = fixture([appendix]);
    const before = JSON.stringify(target);
    try { confirmedTargetScope(target, document, { start_line: 1, end_exclusive_line: 10 }); throw Error("应拒绝"); }
    catch (error) {
      expect(error).toBeInstanceOf(TargetScopeConflict);
      expect((error as TargetScopeConflict).details).toMatchObject({ owner: "document_discovery_agent", original_task: { name: target.name }, anchors: target.materialization.lot_basis_fragments, next_tools: expect.arrayContaining(["patch_document_selectors"]) });
    }
    expect(JSON.stringify(target)).toBe(before);
    const stale = structuredClone(document); stale.source.sha256 = "0".repeat(64);
    expect(() => confirmedTargetScope(target, stale)).toThrow("原文版本不一致");
    const legacy = structuredClone(target); delete legacy.work_scope;
    expect(() => confirmedTargetScope(legacy, document)).toThrow("缺少 Agent 明确提交");
  });

  test("调查结论在同一证据版本恢复可读，不能冒充验证或重置预算", async () => {
    const { target, document } = fixture([appendix]);
    const root = await mkdtemp(join(tmpdir(), "investigation-scope-"));
    try {
      const path = join(root, "source.md"); await atomicWriteText(path, text);
      const prepared = await buildAgentScopedEvidenceManifest(path, "scope-test", target, document);
      const ws = await RevisionWorkspace.createFromEvidence(root, "scope-test", target.target_id, prepared);
      const controller = await ToolController.create(ws);
      expect(createPiTools(controller).some(tool => tool.name === "save_target_investigation")).toBe(true);
      const id = prepared.manifest.evidence[0]!.evidence_id;
      await controller.dispatch("open_evidence", { evidence_id: id });
      expect(await controller.dispatch("save_target_investigation", { summary: "已核对附录试验适用对象", evidence_ids: [id], next_steps: "继续填写判据" })).toMatchObject({ ok: true });
      const reopened = await ToolController.create(ws);
      expect(await reopened.dispatch("get_target_context", {})).toMatchObject({ investigation_checkpoint: { summary: "已核对附录试验适用对象", next_steps: "继续填写判据" } });
      expect((await ws.readState()).last_valid_fingerprint).toBe("");
      await atomicWriteJson(join(ws.root, "investigation-checkpoint.json"), { evidence_fingerprint: "old", summary: "旧结论" });
      expect(await (await ToolController.create(ws)).dispatch("get_target_context", {})).toMatchObject({ investigation_checkpoint: { stale: true } });
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).toContain("本地通过");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("optional bookkeeping");
    expect(TARGET_SELECTOR_SYSTEM_PROMPT).not.toContain("do not run content-rule checks");
  });

  test("容器失败时返回确定性诊断：行号、原文摘录、逐块重叠/间距与判定", () => {
    const { target, document } = fixture(["# 附录 B 结构性能检验\n## B.1 判定\nB.1.1 构件应满足判定指标。"]);
    const outsideAtom = document.atoms.find(atom => atom.text.includes("C.0.1 其他要求。"))!;
    const quote = "C.0.1 其他要求。";
    const start = outsideAtom.text.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    target.work_scope!.selection_fragments = [{
      atom_id: outsideAtom.atom_id,
      start,
      end: start + quote.length,
      text: quote,
      text_sha256: sha256Text(quote),
    }];
    try {
      confirmedTargetScope(target, document);
      throw new Error("expected TargetScopeConflict");
    } catch (error) {
      if (!(error instanceof TargetScopeConflict)) throw error;
      const actual = (error.details as { actual?: {
        diagnosis?: {
          interval_lines: { start_line: number; end_exclusive_line: number };
          interval_text: string;
          verdict: string;
          per_block_overlap_or_gap: Array<{ block: { start: number; end: number }; overlap_chars?: number; gap_chars?: number }>;
        };
      } }).actual;
      expect(actual?.diagnosis).toBeDefined();
      const diagnosis = actual!.diagnosis!;
      expect(diagnosis.verdict).toBe("outside_all_declared_blocks");
      expect(diagnosis.interval_text).toContain("其他要求");
      expect(diagnosis.interval_lines.start_line).toBeGreaterThan(0);
      expect(diagnosis.per_block_overlap_or_gap.length).toBeGreaterThanOrEqual(1);
      expect(diagnosis.per_block_overlap_or_gap[0]!.gap_chars).toBeGreaterThan(0);
    }
  });
});
