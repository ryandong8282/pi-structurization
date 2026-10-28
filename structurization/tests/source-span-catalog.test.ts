import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { createPiTools, ToolController } from "../src/tools.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { RevisionWorkspace } from "../src/workspace.js";
import { buildDocumentEvidence } from "../src/document-discovery.js";
import { createDocumentHeadingNavigation } from "../src/source-provenance-ranges.js";

function manifestFor(texts: string[]): EvidenceManifest {
  const evidence = texts.map((text, index) => ({
    evidence_id: `atom:${index}`,
    kind: "paragraph" as const,
    role: "supporting_clause" as const,
    locator: `chunk:${index}`,
    text,
    text_sha256: sha256Text(text),
    requires_disposition: true,
    evidence_scope: "primary" as const,
  }));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "resource-job",
    target_id: "resource-target",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "source.md",
      sha256: sha256Text(texts.join("")),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "resource-target",
      source_line_count: texts.join("\n").split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: 2,
      selected_heading: "资源模式测试目标",
      selection_reason: "Agent 按需调查",
      selected_atom_ids: evidence.map((record) => record.evidence_id),
      target_evidence_fragments: evidence.map((record) => ({ atom_id: record.evidence_id, text: record.text })),
      candidates: [],
    },
    evidence,
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`resources\0${texts.join("\0")}`),
  };
}

async function withController<T>(
  texts: string[],
  operation: (controller: ToolController, workspace: RevisionWorkspace) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "selector-resources-"));
  try {
    const manifest = manifestFor(texts);
    const workspace = await RevisionWorkspace.createFromEvidence(root, manifest.job_id, manifest.target_id, {
      manifest,
      markdown: Buffer.from(texts.join("\n")),
    });
    return await operation(await ToolController.create(workspace), workspace);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("agentic bounded evidence resources", () => {
  it("does not reconstruct a title when a readable range starts or ends inside its source line", () => {
    const heading = "## 7 中性范围标题";
    const source = `前文\r\n${heading}\r\n正文`;
    const start = source.indexOf(heading);
    const end = start + heading.length;
    const navigation = createDocumentHeadingNavigation(buildDocumentEvidence(source, "neutral.md"));
    expect(navigation({ start, end })).toMatchObject({ heading_count: 1, headings: [{ line: 2, preview: heading }] });
    expect(navigation({ start: start + 1, end })).toMatchObject({ heading_count: 0, headings: [] });
    expect(navigation({ start, end: end - 1 })).toMatchObject({ heading_count: 0, headings: [] });
  });

  it("lists a late source heading as navigation without reading its body or choosing its applicability", async () => {
    const heading = "## 9 后文共同范围说明";
    const body = "仅属于正文的判定与例外，需要打开后独立核对。";
    const source = `${"甲".repeat(280)}\n${heading}\n${body}`;
    await withController([source], async (controller, workspace) => {
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await tools.find(tool => tool.name === name)!.execute("call", args, undefined as never, undefined as never);
        return JSON.parse((result.content[0] as any).text);
      };
      const stateBefore = await workspace.readState();
      const registryBefore = await workspace.readSourceSpanRegistry();
      const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const directory = await invoke("list_global_document_resources", { cursor: 0, limit: 1 });
      expect(directory).toMatchObject({ ok: true, applicability_checked: false, resources: [{ heading_navigation: {
        navigation_only: true, heading_count: 1, headings_complete: true,
        headings: [{ line: 2, preview: heading, preview_truncated: false }],
      } }] });
      expect(JSON.stringify(directory)).not.toContain(body);
      expect(directory.instruction).toContain("不是正文、适用结论或调查完成证明");
      expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
      const { next_event_sequence: _afterEvent, ...afterState } = await workspace.readState();
      const { next_event_sequence: _beforeEvent, ...beforeState } = stateBefore;
      expect(afterState).toEqual(beforeState);
      const row = directory.resources[0];
      expect(row.atom_id).toMatch(/^a\d+$/u);
      expect(await invoke(row.read_tool, { ...row.tool_arguments, source_handle_scope: directory.source_handle_scope }))
        .toMatchObject({ ok: true, text: source });
    });
  });

  it("bounds directory heading previews and reports incomplete navigation without dropping source", async () => {
    const source = Array.from({ length: 12 }, (_, index) => `## ${index + 1} ${"标题".repeat(70)}\n正文${index}`).join("\r\n");
    await withController([source], async (controller, workspace) => {
      const before = await readFile(workspace.evidenceManifestPath, "utf8");
      const directory = await controller.dispatch("list_global_document_resources", { cursor: 0, limit: 30 }) as any;
      const nav = directory.resources[0].heading_navigation;
      expect(nav).toMatchObject({ navigation_only: true, heading_count: 12, headings_complete: false });
      expect(nav.headings).toHaveLength(8);
      expect(nav.headings.every((heading: any) => heading.preview.length <= 80 && heading.preview_truncated)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(directory), "utf8")).toBeLessThanOrEqual(128 * 1024);
      const row = directory.resources[0];
      expect(await controller.dispatch(row.read_tool, row.tool_arguments)).toMatchObject({ ok: true, text: source });
      expect(await readFile(workspace.evidenceManifestPath, "utf8")).toBe(before);
    });
  });

  it("rejects a rewritten split sentence and offers separate exact-fragment bindings without weakening quote identity", async () => {
    const text = "对象甲需保持贴实，并保持平直。";
    await withController([text], async (controller, workspace) => {
      await controller.dispatch("open_evidence", { evidence_id: "atom:0" });
      const before = await workspace.readSourceSpanRegistry();
      const stateBefore = await workspace.readState();
      const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const rejected = await controller.dispatch("locate_evidence_span", {
        evidence_id: "atom:0", quote: "对象甲需保持平直",
      }) as any;
      expect(rejected).toMatchObject({ ok: false, error: "selector_span_not_found", issues: [{ details: {
        actual: { quote: "对象甲需保持平直" }, quote_match_count: 0,
        expected: { quote_is_one_contiguous_source_fragment: true, discontiguous_fragments_require_separate_spans: true },
        fragment_binding_tools: ["locate_evidence_span", "batch_locate_evidence_spans", "stage_target_selector_draft"],
      } }] });
      expect(rejected.instruction).toContain("span_ids");
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      expect({ ...await workspace.readState(), next_event_sequence: stateBefore.next_event_sequence }).toEqual(stateBefore);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
      const located = await controller.dispatch("batch_locate_evidence_spans", { requests: [
        { evidence_id: "atom:0", quote: "对象甲需保持贴实" },
        { evidence_id: "atom:0", quote: "并保持平直" },
      ] }) as any;
      expect(located).toMatchObject({ ok: true, results: [{ ok: true }, { ok: true }] });
      const manifest = await workspace.readEvidenceManifest();
      expect(manifest.evidence[0]!.text).toBe(text);
      expect(located.results.map((row: any) => text.slice(row.span.start, row.span.end)))
        .toEqual(["对象甲需保持贴实", "并保持平直"]);
    });
  });

  it("zero-match feedback permits correcting the selected source without inventing disambiguation candidates", async () => {
    const quote = "涂层厚度应符合设计要求";
    await withController([`${quote}。`, "表面不得有裂纹。"], async (controller, workspace) => {
      await controller.dispatch("batch_open_evidence", { evidence_ids: ["atom:0", "atom:1"] });
      const before = await workspace.readSourceSpanRegistry();
      const failed = await controller.dispatch("locate_evidence_span", { evidence_id: "atom:1", quote }) as any;
      expect(failed).toMatchObject({ ok: false, error: "selector_span_not_found", issues: [{ details: {
        quote_match_count: 0, disambiguation_candidates: [], writable_paths: ["/evidence_id", "/quote"],
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: "atom:1", cursor: 0 }, candidate_read_tool: "open_evidence",
      } }] });
      expect(failed.instruction).toContain("evidence_id");
      expect(failed.instruction).not.toContain("根据返回的 disambiguation_candidates");
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      const batch = await controller.dispatch("batch_locate_evidence_spans", { requests: [{ evidence_id: "atom:1", quote }] }) as any;
      expect(batch).toMatchObject({ ok: false, error: "batch_locate_failed", succeeded_indexes: [], failed_indexes: [0] });
      expect(batch.results[0].issues[0].details).toMatchObject({
        writable_paths: ["/requests/0/evidence_id", "/requests/0/quote"],
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: "atom:1" },
      });
      const patch = { quote_bindings: [{ key: "$scope", evidence_id: "atom:1", quote }],
        draft: { lots: [{ key: "lot", name: "涂层", scope_span_ids: ["$scope"], reason: "原文规定涂层要求。" }] } };
      const staged = await controller.dispatch("stage_target_selector_draft", patch) as any;
      expect(staged).toMatchObject({ ok: false, durable_mutation: false, budget_consumed: false,
        selector_issues: expect.arrayContaining([expect.objectContaining({ issues: [expect.objectContaining({ details: expect.objectContaining({
          writable_paths: ["/quote_bindings/0/evidence_id", "/quote_bindings/0/quote"], next_tool: "stage_target_selector_draft",
        }) })] })]) });
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      patch.quote_bindings[0]!.evidence_id = "atom:0";
      expect(await controller.dispatch("stage_target_selector_draft", patch)).toMatchObject({ ok: true });
      expect(await controller.dispatch("locate_evidence_span", { evidence_id: "atom:0", quote })).toMatchObject({ ok: true });
    });
  });

  it("a wrapped zero-match locator advertises a read of its actual source and does not guess another source", async () => {
    await withController(["甲装置应完整。", "乙装置表面应清洁。"], async (controller, workspace) => {
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const invoke = async (name: string, args: Record<string, unknown>) => (await tools.find(tool => tool.name === name)!
        .execute("call", args, undefined as never, undefined as never)).details as any;
      const directory = await invoke("list_evidence_resources", {});
      const ids = directory.resources.map((r: { evidence_id: string }) => r.evidence_id);
      await invoke("batch_open_evidence", { source_handle_scope: codec.scope, evidence_ids: ids });
      const before = await workspace.readSourceSpanRegistry();
      const stateBefore = await workspace.readState();
      const requested = { source_handle_scope: codec.scope, evidence_id: ids[1], quote: "甲装置应完整" };
      const rejected = await invoke("locate_evidence_span", requested);
      expect(rejected).toMatchObject({ ok: false, error: "selector_span_not_found", evidence_id: ids[1],
        next_tool: "open_evidence", next_tool_arguments: { evidence_id: ids[1], cursor: 0 }, retry_tool: "locate_evidence_span" });
      expect(rejected.issues[0]).toMatchObject({ actual: { quote_match_count: 0, quote: requested.quote },
        related_information: { disambiguation_candidates: [] }, severity: "error", decision_owner: "program",
        writable_paths: ["/evidence_id", "/quote"], next_tool: rejected.next_tool, next_tool_arguments: rejected.next_tool_arguments });
      expect(JSON.stringify(rejected)).not.toContain(ids[0]);
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      const reread = await invoke(rejected.next_tool, { ...rejected.next_tool_arguments, source_handle_scope: rejected.source_handle_scope });
      expect(reread).toMatchObject({ ok: true, resource: { evidence_id: ids[1] }, text_window: { text: "乙装置表面应清洁。" } });
      expect(await invoke("locate_evidence_span", requested)).toMatchObject({ ok: false, error: "selector_span_not_found" });
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
      expect((await workspace.readState()).selector_protocol).toEqual(stateBefore.selector_protocol);
      expect(await invoke(rejected.retry_tool, { source_handle_scope: codec.scope, evidence_id: ids[1], quote: reread.text_window.text }))
        .toMatchObject({ ok: true });
      const contextMismatch = await invoke("locate_evidence_span", { source_handle_scope: codec.scope,
        evidence_id: ids[1], quote: "表面应清洁", prefix: "不存在的前文" });
      expect(contextMismatch).toMatchObject({ ok: false, next_tool: "locate_evidence_span",
        issues: [{ actual: { quote_match_count: 1, match_count: 0 }, writable_paths: ["/prefix", "/suffix"] }] });
      expect(contextMismatch).not.toHaveProperty("next_tool_arguments");
    });
  });

  it("legacy coverage repair contract does not advertise an unlimited new repair transaction", async () => {
    await withController(["原文来源。"], async (_controller, workspace) => {
      await workspace.updateState(state => { state.selector_stage = "coverage_repair"; });
      const controller = await ToolController.create(workspace);
      const contract = await controller.dispatch("get_target_selector_contract", {}) as any;
      expect(contract.submission_protocol.selector_stage).toBe("coverage_repair");
      expect(contract.rules.join("\n")).toContain("不表示可以另开覆盖修复事务");
      expect((contract.authoring_protocols as any).lifecycle).toContain("terminal=true");
    });
  });

  it("unregistered locator sources give an exact directory recovery and preserve successful batch spans", async () => {
    await withController(["甲装置应完整。", "乙装置表面应清洁。"], async (controller, workspace) => {
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await tools.find(tool => tool.name === name)!.execute("call", args, undefined as never, undefined as never);
        return JSON.parse((result.content[0] as any).text);
      };
      const before = await workspace.readSourceSpanRegistry(), stateBefore = await workspace.readState(), selectorsBefore = await readFile(workspace.workingSelectorPath, "utf8");
      // Compatibility allows a previously emitted atom/evidence alias; it is still absent from this manifest.
      const outside = await codec.encode({ atom_id: "atom:outside", evidence_id: "atom:outside" }) as any;
      const request = { evidence_id: outside.evidence_id, quote: "甲装置应完整", source_handle_scope: codec.scope };
      const rejected = await invoke("locate_evidence_span", request);
      expect(rejected).toMatchObject({ error: "unknown_evidence_id", actual: { evidence_id: outside.evidence_id, registered_in_current_evidence: false },
        writable_paths: ["/evidence_id"], next_tool: "list_evidence_resources", next_tool_arguments: { cursor: 0 },
        retry_tool: "locate_evidence_span", durable_mutation: false, budget_consumed: false });
      expect(await workspace.readSourceSpanRegistry()).toEqual(before);
      const directory = await invoke(rejected.next_tool, { ...rejected.next_tool_arguments, source_handle_scope: rejected.source_handle_scope });
      expect(directory.resources).toHaveLength(2); expect(JSON.stringify(directory)).not.toContain("甲装置应完整");
      expect(await invoke("locate_evidence_span", request)).toMatchObject({ error: "unknown_evidence_id" });
      const selectedId = directory.resources[0].evidence_id;
      await invoke("open_evidence", { evidence_id: selectedId, source_handle_scope: codec.scope });
      const batch = await invoke("batch_locate_evidence_spans", { requests: [{ evidence_id: selectedId, quote: request.quote },
        { evidence_id: outside.evidence_id, quote: "乙装置表面应清洁" }], source_handle_scope: codec.scope });
      expect(batch).toMatchObject({ error: "batch_locate_partial_failure", succeeded_indexes: [0], failed_indexes: [1] });
      expect(batch.results[1]).toMatchObject({ error: "unknown_evidence_id", writable_paths: ["/requests/1/evidence_id"],
        next_tool: "list_evidence_resources", next_tool_arguments: { cursor: 0 }, retry_tool: "batch_locate_evidence_spans" });
      const spans = await workspace.readSourceSpanRegistry();
      expect(await invoke("locate_evidence_span", request)).toMatchObject({ error: "unknown_evidence_id" });
      expect(await workspace.readSourceSpanRegistry()).toEqual(spans);
      expect((await workspace.readState()).validation_attempts).toBe(stateBefore.validation_attempts);
      expect((await workspace.readState()).selector_protocol).toEqual(stateBefore.selector_protocol);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(selectorsBefore);
    });
  });

  it("a legacy atom emitted as evidence can be reread for a wrong span type without treating the atom as a span", async () => {
    await withController(["甲装置应完整。"], async (controller, workspace) => {
      const codec = await ModelSourceHandles.open(workspace.root);
      const tools = codec.wrapTools(createPiTools(controller));
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await tools.find(tool => tool.name === name)!.execute("call", args, undefined as never, undefined as never);
        return JSON.parse((result.content[0] as any).text);
      };
      const directory = await invoke("list_evidence_resources", {});
      const evidenceId = directory.resources[0].evidence_id;
      expect(evidenceId).toBe("a1");
      const before = await readFile(workspace.workingSelectorPath, "utf8");
      const request = { operation: "upsert", collection: "lots", draft: { lots: [{ key: "author-lot", name: "作者保留的名称",
        scope_span_ids: [evidenceId], reason: "作者依据原文选择的范围" }] }, source_handle_scope: codec.scope };
      const rejected = await invoke("stage_target_selector_draft", request);
      expect(rejected).toMatchObject({ error: "source_handle_wrong_type", expected_type: "span", actual_type: "atom",
        writable_path: "/draft/lots/0/scope_span_ids/0", next_tool: "open_evidence", retry_tool: "stage_target_selector_draft",
        tool_arguments: { evidence_id: evidenceId, source_handle_scope: codec.scope } });
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(before);
      expect(await codec.decodeArguments(rejected.tool_arguments)).toEqual({ evidence_id: "atom:0" });
      const body = await invoke(rejected.next_tool, rejected.tool_arguments);
      expect(body).toMatchObject({ ok: true, resource: { evidence_id: evidenceId }, text_window: { text: "甲装置应完整。" } });
      const located = await invoke("locate_evidence_span", { evidence_id: evidenceId, quote: body.text_window.text, source_handle_scope: codec.scope });
      expect(located.ok).toBe(true);
      expect(await invoke(rejected.retry_tool, { ...request, draft: { lots: [{ ...request.draft.lots[0], scope_span_ids: [located.span.span_id] }] } }))
        .toMatchObject({ ok: true });
      expect(JSON.parse(await readFile(workspace.workingSelectorPath, "utf8")).lots[0]).toMatchObject({ key: "author-lot", name: "作者保留的名称" });
    });
  });

  it.each(["direct-validation/v1", "same-agent-self-review/v1"] as const)("%s contract explains that preflight repairs do not spend formal submissions", async protocol => {
    await withController(["原文来源。"], async (_controller, workspace) => {
      await workspace.updateState(state => { state.target_review_protocol = protocol; });
      const controller = await ToolController.create(workspace);
      const contract = await controller.dispatch("get_target_selector_contract", {}) as any;
      expect(contract.submission_protocol).toMatchObject({ review_protocol: protocol });
      expect(contract.rules.join("\n")).toContain("预检失败不消耗正式提交或语义修正预算");
      expect(contract.rules.join("\n")).not.toContain("只有聚合的 selector_input_error 后才提供一次语义修正");
    });
  });

  it("keeps initial context and inventory body-free while every resource remains discoverable", async () => {
    const texts = ["绝密正文甲-仅打开后可见", "绝密正文乙-不得预加载", "绝密正文丙-不得预加载"];
    await withController(texts, async (controller, workspace) => {
      const context = await controller.dispatch("get_target_context", { limit: 1 });
      const serializedContext = JSON.stringify(context);
      expect(context.ok).toBe(true);
      expect(Buffer.byteLength(serializedContext, "utf8")).toBeLessThanOrEqual(128 * 1024);
      for (const text of texts) expect(serializedContext).not.toContain(text);
      expect(serializedContext).not.toContain("text_window");
      expect((await workspace.readState()).opened_evidence_ids).toEqual([]);
      expect(context.resource_tools).toEqual(expect.arrayContaining(["read_document_reference_evidence"]));
      expect(controller.selectorProviderPolicy().allowed_tools)
        .toEqual(expect.arrayContaining(["read_document_reference_evidence"]));

      const repeated = await controller.dispatch("get_target_context", { limit: 1 });
      expect(repeated).toMatchObject({
        ok: true,
        context_page_already_returned: true,
        next_resource_cursor: 1,
      });
      expect(repeated).not.toHaveProperty("resource_inventory");
      expect(Buffer.byteLength(JSON.stringify(repeated), "utf8"))
        .toBeLessThan(Buffer.byteLength(serializedContext, "utf8"));

      const discovered: string[] = [];
      let cursor: number | null = 0;
      do {
        const page = await controller.dispatch("list_evidence_resources", { cursor, limit: 1 });
        const serialized = JSON.stringify(page);
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(128 * 1024);
        for (const text of texts) expect(serialized).not.toContain(text);
        discovered.push(...(page.resources as Array<{ evidence_id: string }>).map((resource) => resource.evidence_id));
        cursor = page.next_cursor as number | null;
      } while (cursor !== null);
      expect(discovered).toEqual(["atom:0", "atom:1", "atom:2"]);
    });
  });

  it("only injects explicitly opened source windows and preserves exact oversized content", async () => {
    const oversized = `${"中".repeat(70_000)}特殊边界甲\n${Array.from({ length: 1_000 }, (_, index) => `| 第${index}行 | 值${index} |`).join("\n")}`;
    const unopened = "另一个资源绝不能随打开动作进入上下文";
    await withController([oversized, unopened], async (controller, workspace) => {
      const windows: Array<{ start: number; end: number; text: string }> = [];
      let cursor: number | null = 0;
      do {
        const opened = await controller.dispatch("open_evidence", { evidence_id: "atom:0", cursor });
        const serialized = JSON.stringify(opened);
        expect(opened.ok).toBe(true);
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(128 * 1024);
        expect(serialized).not.toContain(unopened);
        windows.push(opened.text_window as { start: number; end: number; text: string });
        cursor = opened.next_cursor as number | null;
        if (cursor !== null) expect((await workspace.readState()).opened_evidence_ids).not.toContain("atom:0");
      } while (cursor !== null);
      expect(windows.map((window) => window.text).join("")).toBe(oversized);
      windows.forEach((window, index) => {
        expect(window.text).toBe(oversized.slice(window.start, window.end));
        if (index > 0) expect(window.start).toBe(windows[index - 1]!.end);
      });
      expect((await workspace.readState()).opened_evidence_ids).toEqual(["atom:0"]);
    });
  }, 15_000);

  it("batch open and search return only explicitly requested resources and queries", async () => {
    const texts = ["甲资源唯一词苹果", "乙资源唯一词香蕉", "丙资源唯一词梨子"];
    await withController(texts, async (controller) => {
      const opened = await controller.dispatch("batch_open_evidence", { evidence_ids: ["atom:0", "atom:2"] });
      const serializedOpen = JSON.stringify(opened);
      expect(opened.ok).toBe(true);
      expect(Buffer.byteLength(serializedOpen, "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect(serializedOpen).toContain(texts[0]!);
      expect(serializedOpen).toContain(texts[2]!);
      expect(serializedOpen).not.toContain(texts[1]!);
      expect(opened.opened).toEqual([
        expect.objectContaining({
          resource: { evidence_id: "atom:0" },
          chunk_span: { span_id: expect.stringMatching(/^span:[a-f0-9]{32}$/) },
        }),
        expect.objectContaining({
          resource: { evidence_id: "atom:2" },
          chunk_span: { span_id: expect.stringMatching(/^span:[a-f0-9]{32}$/) },
        }),
      ]);
      expect(serializedOpen).not.toContain("text_sha256");
      expect(serializedOpen).not.toContain("atom_id");

      const searched = await controller.dispatch("batch_search_evidence", { queries: ["苹果", "梨子"] });
      const results = searched.results as Array<{ query: string; matches: Array<{ evidence_id: string }> }>;
      expect(results.map((result) => result.query)).toEqual(["苹果", "梨子"]);
      expect(results.flatMap((result) => result.matches.map((match) => match.evidence_id))).toEqual(["atom:0", "atom:2"]);
      expect(JSON.stringify(searched)).not.toContain("香蕉");
    });
  });

  it("batch locate returns exactly one result per explicit request and never exposes the registry", async () => {
    const texts = ["甲资源包含定位词甲", "乙资源包含定位词乙", "丙资源未请求定位词丙"];
    await withController(texts, async (controller, workspace) => {
      await controller.dispatch("batch_open_evidence", { evidence_ids: ["atom:0", "atom:1"] });
      const before = await workspace.readSourceSpanRegistry();
      const unrelatedSpanId = before.spans.find((span) => span.evidence_id === "atom:2")!.span_id;
      const located = await controller.dispatch("batch_locate_evidence_spans", {
        requests: [
          { evidence_id: "atom:0", quote: "定位词甲" },
          { evidence_id: "atom:1", quote: "定位词乙" },
        ],
      });
      const serialized = JSON.stringify(located);
      expect(located.ok).toBe(true);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect((located.results as Array<{ evidence_id: string }>).map((result) => result.evidence_id)).toEqual(["atom:0", "atom:1"]);
      expect(Object.keys(located)).not.toContain("registry");
      expect(serialized).not.toContain(unrelatedSpanId);
      expect(serialized).not.toContain("atom:2");
      expect(await controller.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: "atom:0", quote: "定位词甲" }],
      })).toMatchObject({
        ok: true,
      });
      expect((await workspace.readState()).selector_batch_requires_stage).not.toBe(true);
    });
  });

  it("accepts more than ten explicit locate requests within the neutral batch bound", async () => {
    const texts = Array.from({ length: 11 }, (_, index) => `资源 ${index} 包含定位词 ${index}`);
    await withController(texts, async (controller) => {
      const tool = createPiTools(controller).find((candidate) => candidate.name === "batch_locate_evidence_spans")!;
      expect((tool.parameters as any).properties.requests.maxItems).toBe(100);

      const evidenceIds = texts.map((_, index) => `atom:${index}`);
      await controller.dispatch("batch_open_evidence", { evidence_ids: evidenceIds });
      const located = await controller.dispatch("batch_locate_evidence_spans", {
        requests: evidenceIds.map((evidenceId, index) => ({ evidence_id: evidenceId, quote: `定位词 ${index}` })),
      });
      expect(located).toMatchObject({ ok: true });
      expect((located.results as Array<{ index: number; evidence_id: string }>).map((result) => [result.index, result.evidence_id]))
        .toEqual(evidenceIds.map((evidenceId, index) => [index, evidenceId]));

      expect(await controller.dispatch("batch_locate_evidence_spans", {
        requests: Array.from({ length: 101 }, () => ({ evidence_id: "atom:0", quote: "定位词 0" })),
      })).toMatchObject({ ok: false, error: "batch_locate_requires_1_to_100_requests" });
    });
  });

  it("continues after a partially successful locate batch and ignores a legacy save gate on resume", async () => {
    await withController(["甲词；重复词；重复词；乙词"], async (controller, workspace) => {
      await controller.dispatch("open_evidence", { evidence_id: "atom:0" });
      const partial = await controller.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: "atom:0", quote: "甲词" }, { evidence_id: "atom:0", quote: "重复词" }],
      });
      expect(partial).toMatchObject({
        ok: false, error: "batch_locate_partial_failure", succeeded_indexes: [0], failed_indexes: [1],
        results: [{ ok: true }, { ok: false }],
      });
      expect(partial.instruction).toContain("已登记并保留");
      const successfulSpanId = (partial.results as Array<{ span?: { span_id: string } }>)[0]!.span!.span_id;
      expect((await workspace.readSourceSpanRegistry()).spans.some((span) => span.span_id === successfulSpanId)).toBe(true);
      expect(await controller.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: "atom:0", quote: "乙词" }],
      })).toMatchObject({ ok: true });
      await workspace.updateState((state) => { state.selector_batch_requires_stage = true; });
      const reopened = await ToolController.create(workspace);
      expect((await workspace.readState()).selector_batch_requires_stage).toBeUndefined();
      expect(await reopened.dispatch("batch_locate_evidence_spans", {
        requests: [{ evidence_id: "atom:0", quote: "重复词", prefix: "甲词；", suffix: "；重复词" }],
      })).toMatchObject({ ok: true });
      expect(await reopened.dispatch("advance_target_selector_stage", { next_stage: "sampling" }))
        .toMatchObject({ok:false,error:"selector_stage_incomplete",draft_status:"saved_stage_incomplete",content_validation_performed:true,current_stage:"primary"});
    });
  });

  it("reports an oversized locate receipt as wholly unsaved and preserves every request for smaller retries", async () => {
    await withController(["甲部件需保持贴实；乙部件需保持平直。"], async (controller, workspace) => {
      await controller.dispatch("open_evidence", { evidence_id: "atom:0" });
      const requests = [
        { evidence_id: "atom:0", quote: "甲部件需保持贴实" },
        ...Array.from({ length: 99 }, (_, index) => ({ evidence_id: "atom:0", quote: `不存在的原文${index}` })),
      ];
      const inputBefore = JSON.stringify(requests);
      const registryBefore = await workspace.readSourceSpanRegistry();
      const draftBefore = await readFile(workspace.workingSelectorPath, "utf8");
      const stateBefore = await workspace.readState();
      const rejected = await controller.dispatch("batch_locate_evidence_spans", { requests }) as any;
      expect(rejected).toMatchObject({
        ok: false, error: "batch_locate_payload_limit_internal", saved: false,
        durable_mutation: false, budget_consumed: false,
        actual: { request_count: 100, located_in_memory_count: 1, failed_in_memory_count: 99, persisted_request_count: 0 },
        expected: { max_serialized_bytes: 128 * 1024, request_count: { minimum: 1, maximum: 100 } },
        writable_paths: ["/requests"], next_tool: "batch_locate_evidence_spans", retry_tool: "batch_locate_evidence_spans",
      });
      expect(rejected.actual.serialized_bytes).toBeGreaterThan(rejected.expected.max_serialized_bytes);
      expect(rejected.instruction).toContain("未保存");
      expect(rejected.how_to_pass).toContain("每个原始请求");
      expect(rejected).not.toHaveProperty("results");
      expect(Buffer.byteLength(JSON.stringify(rejected), "utf8")).toBeLessThanOrEqual(128 * 1024);
      expect(JSON.stringify(requests)).toBe(inputBefore);
      expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
      expect(await readFile(workspace.workingSelectorPath, "utf8")).toBe(draftBefore);
      expect({ ...await workspace.readState(), next_event_sequence: stateBefore.next_event_sequence }).toEqual(stateBefore);

      let retriedCount = 0;
      for (let cursor = 0; cursor < requests.length; cursor += 10) {
        const smaller = await controller.dispatch("batch_locate_evidence_spans", { requests: requests.slice(cursor, cursor + 10) }) as any;
        expect(smaller.error).not.toBe("batch_locate_payload_limit_internal");
        expect(smaller.results).toHaveLength(10);
        retriedCount += smaller.results.length;
        if (cursor === 0) {
          expect(smaller).toMatchObject({ error: "batch_locate_partial_failure", succeeded_indexes: [0] });
          expect((await workspace.readSourceSpanRegistry()).spans.some(span => span.span_id === smaller.results[0].span.span_id)).toBe(true);
        }
      }
      expect(retriedCount).toBe(requests.length);
      expect(JSON.stringify(requests)).toBe(inputBefore);
    });
  });

  it("uses prefix and suffix to disambiguate repeated locate quotes", async () => {
    const text = "甲条件：厚度应合格；乙条件：厚度应合格。";
    await withController([text], async (controller) => {
      await controller.dispatch("open_evidence", { evidence_id: "atom:0" });
      const ambiguous = await controller.dispatch("locate_evidence_span", {
        evidence_id: "atom:0",
        quote: "厚度应合格",
      });
      expect(ambiguous).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "selector_span_not_unique" })] });
      const candidates = (ambiguous.issues as Array<{ details: { disambiguation_candidates: unknown[] } }>)[0]!.details.disambiguation_candidates;
      expect(candidates).toEqual([
        expect.objectContaining({ prefix: "甲条件：", suffix: "；乙条件：厚度应合格。" }),
        expect.objectContaining({ prefix: "甲条件：厚度应合格；乙条件：", suffix: "。" }),
      ]);
      const located = await controller.dispatch("locate_evidence_span", {
        evidence_id: "atom:0",
        quote: "厚度应合格",
        prefix: "乙条件：",
        suffix: "。",
      });
      expect(located).toMatchObject({ ok: true, disambiguated_by_context: true, span: { span_id: expect.stringMatching(/^span:[a-f0-9]{32}$/) } });
    });
  });

  it("rejects empty batch requests and reconstructs cross-chunk meaning from explicitly opened chunks", async () => {
    const texts = ["跨块业务片段前半", "后半及验收要求"];
    await withController(texts, async (controller) => {
      expect(await controller.dispatch("batch_open_evidence", { evidence_ids: [] }))
        .toMatchObject({ ok: false, error: "batch_open_requires_1_to_50_evidence_ids" });
      expect(await controller.dispatch("batch_open_evidence", { evidence_ids: ["atom:0", "atom:0"] }))
        .toMatchObject({ ok: false, error: "batch_open_duplicate_evidence_ids" });
      expect(await controller.dispatch("batch_search_evidence", { queries: [] }))
        .toMatchObject({ ok: false, error: "batch_search_requires_1_to_20_queries" });
      expect(await controller.dispatch("batch_search_evidence", { queries: [""] }))
        .toMatchObject({ ok: false, error: "batch_search_requires_1_to_20_queries" });
      expect(await controller.dispatch("search_evidence", { query: "" }))
        .toMatchObject({ ok: false, error: "search_query_required" });
      expect(await controller.dispatch("batch_locate_evidence_spans", { requests: [] }))
        .toMatchObject({ ok: false, error: "batch_locate_requires_1_to_100_requests" });
      expect(await controller.dispatch("batch_locate_evidence_spans", { requests: [{ evidence_id: "atom:0", quote: "" }] }))
        .toMatchObject({ ok: false, error: "invalid_batch_locate_request" });

      const opened = await controller.dispatch("batch_open_evidence", { evidence_ids: ["atom:0", "atom:1"] });
      const units = opened.opened as Array<{ text_window: { text: string }; chunk_span?: { span_id: string } }>;
      expect(units.map((unit) => unit.text_window.text).join("")).toBe(texts.join(""));
      expect(units.map((unit) => unit.chunk_span?.span_id).filter(Boolean)).toHaveLength(2);
    });
  });
});


it("single and batch quote feedback preserve bounded ambiguity and expose an executable source read route", async () => {
  const quote = "虚构定位要求";
  const padding = "重复".repeat(220);
  const text = ["甲", "乙"].map(label => label + padding + quote + padding + label).join(" | ");
  await withController([text], async (controller, workspace) => {
    await controller.dispatch("open_evidence", { evidence_id: "atom:0" });
    const registryBefore = await workspace.readSourceSpanRegistry();
    const request = { evidence_id: "atom:0", quote };
    const single = await controller.dispatch("locate_evidence_span", request) as any;
    const batch = await controller.dispatch("batch_locate_evidence_spans", { requests: [request] }) as any;
    for (const result of [single, batch.results[0]]) {
      expect(result).toMatchObject({ ok: false, error: "selector_span_not_unique" });
      expect(result.instruction).toContain("仍有歧义");
      expect(result.instruction).toContain("context_unique=true");
      const details = result.issues[0].details;
      expect(details.disambiguation_candidates.every((candidate: any) => !candidate.context_unique)).toBe(true);
      const directory = await controller.dispatch(details.context_read.tool, details.context_read.arguments) as any;
      expect(directory.ok).toBe(true);
      const resource = directory.resources.find((entry: any) => entry.evidence_id === details.context_read.evidence_id);
      expect(resource).toMatchObject({ read_tool: "open_evidence" });
      expect(await controller.dispatch(resource.read_tool, { evidence_id: resource.evidence_id })).toMatchObject({ ok: true });
    }
    expect(await workspace.readSourceSpanRegistry()).toEqual(registryBefore);
    expect(await controller.dispatch("locate_evidence_span", { ...request, prefix: "乙" + padding })).toMatchObject({ ok: true });
  });
});
