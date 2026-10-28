import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import type { EvidenceManifest, ReferenceOccurrence, RevisionState } from "../src/contracts.js";
import { materializeCoverageSpanBindings } from "../src/coverage-review.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";
import {
  readReferenceCatalog,
  referenceCatalogDeliveryWork,
  referenceAnalysisIssues,
  referenceCatalogPending,
} from "../src/reference-analysis.js";
import type { ReferenceCatalogRules } from "../src/reference-catalog.js";
import { registryWithFullSourceSpans } from "../src/source-span-registry.js";
import type { RevisionWorkspace } from "../src/workspace.js";

interface FixtureRecord {
  evidence_id: string;
  kind: string;
  role: string;
  locator: string;
  text: string;
}

function fixtureFromRecords(records: FixtureRecord[], targetTableId: string) {
  const occurrence = {
    occurrence_id: `reference:${targetTableId}`, reference_kind: "table", target_table_id: targetTableId,
    origin_evidence_id: records[0]!.evidence_id, origin_fields: ["requirement"], raw_reference: `表${targetTableId}`,
    target_evidence_ids: records.map((record) => record.evidence_id), required: true, status: "resolved", depth: 1, path: [],
  } as ReferenceOccurrence;
  const manifest = {
    evidence_fingerprint: sha256Text(`fixture:${targetTableId}`), evidence: records, reference_occurrences: [occurrence],
  } as unknown as EvidenceManifest;
  const targetKey = documentReferenceTargetReadIdentity(occurrence).target_key;
  const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, records.map((record) => ({
    source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
  })));
  const state = {} as RevisionState;
  const rebuildWorkspace = () => ({
    readState: async () => structuredClone(state),
    updateState: async (update: (current: RevisionState) => void) => { update(state); return structuredClone(state); },
    readSourceSpanRegistry: async () => structuredClone(registry),
  } as unknown as RevisionWorkspace);
  const workspace = rebuildWorkspace();
  return { records, occurrence, manifest, targetKey, registry, state, workspace, rebuildWorkspace };
}

function fixture(firstText?: string, count = 25) {
  const records = Array.from({ length: count }, (_, i) => ({
    evidence_id: `evidence:${sha256Text(`row-${i}`)}`,
    kind: "table_row", role: "formal_table_row", locator: `line:804/table:5.13.4/row:${i + 3}`,
    text: i === 0 ? firstText ?? "混凝土强度 | 不小于设计值 | 28d试块强度或钻芯法" : `测试表格 ${i + 3}`,
  }));
  return fixtureFromRecords(records, "5.13.4");
}

describe("reference catalog row citation handles", () => {
  test.each(["虚构温控箱", "虚构隔声板"])("%s locates a late diagnostic source without claiming a read or a business decision", async subject => {
    const records = Array.from({ length: 73 }, (_, index) => ({
      evidence_id: `evidence:${sha256Text(`${subject}-${index}`)}`, kind: "paragraph", role: "context",
      locator: `line:${index + 1}`, text: `${subject}条件记录${index + 1}。`,
    }));
    const { workspace, manifest, targetKey, state } = fixtureFromRecords(records, "neutral-source-route");
    await readReferenceCatalog(workspace, manifest, targetKey);
    const before = structuredClone(state);
    const route = await readReferenceCatalog(workspace, manifest, targetKey, { evidence_ids: [records[70]!.evidence_id] } as any) as any;
    expect(route).toMatchObject({ ok: true, metadata_only: true, source_routes: [{ evidence_id: records[70]!.evidence_id,
      entry_id: "seg:3", row_index: 22 }], next_tool: "read_reference_facts",
      next_tool_arguments: { target_key: targetKey, entry_ids: ["seg:3"], row_cursor: 22, row_offset: 0 } });
    expect(JSON.stringify(route)).not.toContain(records[70]!.text);
    expect(state).toEqual(before);
    const opened = await readReferenceCatalog(workspace, manifest, targetKey, route.next_tool_arguments) as any;
    expect(opened.entries[0].rows[0]).toEqual([22, records[70]!.text]);
    expect(opened.resolved_rows[0]).toMatchObject({ evidence_id: records[70]!.evidence_id, span_id: expect.stringMatching(/^span:/u) });
  });

  test("source navigation rejects a foreign identity and mixed read/write requests without changing read history", async () => {
    const { workspace, manifest, targetKey, records, state } = fixture();
    await readReferenceCatalog(workspace, manifest, targetKey);
    const before = structuredClone(state);
    const foreign = await readReferenceCatalog(workspace, manifest, targetKey, { evidence_ids: ["evidence:foreign"] } as any);
    expect(foreign).toMatchObject({ ok: false, error: "reference_catalog_evidence_not_found", writable_paths: ["/evidence_ids"] });
    const mixed = await readReferenceCatalog(workspace, manifest, targetKey, {
      evidence_ids: [records[0]!.evidence_id], entry_ids: ["seg:1"], skip_rest: { reason: "不能借导航改变处置" },
    } as any);
    expect(mixed).toMatchObject({ ok: false, error: "reference_catalog_navigation_arguments_conflict" });
    expect(state).toEqual(before);
  });

  test.each(["虚构传感盒检验", "虚构织带接头检验"])("%s keeps requested delivery separate from complete reading history", async subject => {
    const records = Array.from({ length: 65 }, (_, index) => ({
      evidence_id: `evidence:${sha256Text(`${subject}-${index}`)}`,
      kind: "paragraph", role: "context", locator: `line:${index + 1}`, text: `${subject}记录${index + 1}。`,
    }));
    const { workspace, manifest, targetKey, state, rebuildWorkspace } = fixtureFromRecords(records, "neutral-delivery");
    // A prior provider session already saw everything. Keep those receipts intact.
    for (const id of ["seg:1", "seg:2", "seg:3"]) await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: [id] });
    const history = structuredClone(state.reference_catalog_dispositions![`target:${targetKey}`]!.opened_ranges);
    const result = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, { entry_ids: ["seg:1", "seg:2", "seg:3"] });
    expect(result).toMatchObject({ disposition: { pending: 0 }, disposition_scope: "cumulative_read_history_not_current_delivery",
      deferred_entry_ids: ["seg:2", "seg:3"], deferred_reason: "per_call_row_limit_24",
      delivery: { returned_rows: 24, pending_count: 2, complete: false },
      required_action: "complete_requested_reference_delivery",
      next_tool_arguments: { target_key: targetKey, entry_ids: ["seg:2"], row_cursor: 0, row_offset: 0 } });
    expect(state.reference_catalog_dispositions![`target:${targetKey}`]!.opened_ranges).toEqual(history);
    const delivered: string[] = [];
    let next = result;
    while (!((next.delivery as any).complete)) {
      const work = referenceCatalogDeliveryWork(await rebuildWorkspace().readState())!;
      expect(work.diagnostic_read.arguments).toEqual(next.next_tool_arguments);
      const args = work.diagnostic_read.arguments;
      next = await readReferenceCatalog(rebuildWorkspace(), manifest, args.target_key, args);
      delivered.push(...(next.entries as any[]).flatMap(entry => entry.rows.map((row: any) => row[1])));
      expect(delivered.length).toBeLessThanOrEqual(41);
    }
    expect(delivered).toEqual(records.slice(24).map(row => row.text));
    expect(referenceCatalogDeliveryWork(state)).toBeUndefined();
    expect(state.reference_catalog_dispositions![`target:${targetKey}`]!.opened_ranges).toEqual(history);
  });

  test("byte-limited delivery returns a durable executable character cursor", async () => {
    const { workspace, rebuildWorkspace, manifest, targetKey, state } = fixture("中🙂".repeat(12000), 1);
    let output = await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"] });
    expect(output).toMatchObject({ delivery: { complete: false }, next_tool_arguments: { row_cursor: 0, row_offset: expect.any(Number) } });
    expect(output).not.toHaveProperty("resolved_rows");
    expect(JSON.stringify(output)).not.toContain("quote_locator");
    const pieces = [(output.entries as any[])[0].rows[0][1]];
    while (output.next_tool_arguments) {
      output = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, output.next_tool_arguments as any);
      pieces.push((output.entries as any[])[0].rows[0][1]);
    }
    expect(pieces.join("")).toBe("中🙂".repeat(12000));
    expect(output).toMatchObject({ resolved_rows: [{ quote_locator: { tool: "locate_evidence_span" } }] });
    expect(referenceCatalogDeliveryWork(state)).toBeUndefined();
  });
  test.each(["target", "coverage"] as const)("%s returns verified row spans without expanding catalog or body responses", async (phase) => {
    const { workspace, manifest, targetKey, registry, records } = fixture();
    const catalog = await readReferenceCatalog(workspace, manifest, targetKey, {}, phase);
    expect(catalog).toMatchObject({ ok: true, rule_source: "fallback" });
    expect(catalog).not.toHaveProperty("resolved_rows");
    const opened = await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"] }, phase);
    expect(JSON.stringify(opened.entries)).not.toContain("span:");
    const openedRows = opened.resolved_rows as Array<{ entry_id: string; row_index: number; evidence_id: string; span_id: string }>;
    expect(openedRows).toHaveLength(24);
    expect(openedRows[0]).toMatchObject({
      entry_id: "seg:1",
      row_index: 0,
      evidence_id: records[0]!.evidence_id,
      span_id: expect.stringMatching(/^span:/u),
    });
    if (phase === "target") {
      expect(openedRows[0]).toHaveProperty("quote_locator", {
        tool: "locate_evidence_span", fixed_arguments: { evidence_id: records[0]!.evidence_id },
        author_required_parameters: ["quote"], optional_parameters: ["prefix", "suffix"],
      });
    } else {
      expect(JSON.stringify(opened)).not.toContain("quote_locator");
    }
    const reopened = await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"] }, phase);
    expect(reopened.resolved_rows).toEqual(openedRows);
    const request = { resolve_rows: Array.from({ length: 13 }, (_, row_index) => ({ entry_id: "seg:1", row_index })) };
    const before = structuredClone(registry);
    const output = await readReferenceCatalog(workspace, manifest, targetKey, request, phase);
    expect(output).toMatchObject({ ok: true, citation_scope: "full_row" });
    const rows = output.resolved_rows as Array<{ evidence_id: string; span_id: string }>;
    expect(rows).toHaveLength(13);
    const firstSpan = registry.spans.find((span) => span.evidence_id === records[0]!.evidence_id)!;
    expect(rows[0]).toMatchObject({ evidence_id: records[0]!.evidence_id, span_id: firstSpan.span_id });
    expect(JSON.stringify(rows)).not.toContain(records[0]!.text);
    const materialized = materializeCoverageSpanBindings({ semantic_coverage: [{ evidence_bindings: rows.map(({ evidence_id, span_id }) => ({ evidence_id, span_id })) }], findings: [] }, manifest, registry);
    expect(materialized.issues).toEqual([]);
    expect(materialized.materialized).toHaveLength(13);
    expect(materialized.materialized[0]!.exact_fragment).toBe(records[0]!.text);
    expect((await readReferenceCatalog(workspace, manifest, targetKey, request, phase)).resolved_rows).toEqual(rows);
    expect(registry).toEqual(before);
  });

  test("requires an opened entry, but permits opening and resolving it in one request", async () => {
    const { workspace, manifest, targetKey } = fixture();
    const resolve_rows = [{ entry_id: "seg:1", row_index: 0 }];
    expect(await readReferenceCatalog(workspace, manifest, targetKey, { resolve_rows }))
      .toMatchObject({ ok: false, error: "reference_catalog_entry_not_opened" });
    const openedAndResolved = await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"], resolve_rows });
    expect(openedAndResolved).toMatchObject({ ok: true });
    expect(openedAndResolved.resolved_rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ row_index: 0, span_id: expect.stringMatching(/^span:/u) }),
    ]));
  });

  test.each([-1, 0.5, 24, 999])("rejects invalid row index %s without a misleading partial success", async (row_index) => {
    const { workspace, manifest, targetKey } = fixture();
    expect(await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"], resolve_rows: [{ entry_id: "seg:1", row_index }] }))
      .toMatchObject({ ok: false, error: "reference_catalog_row_out_of_bounds" });
  });

  test("rejects oversized batches and unknown entries", async () => {
    const { workspace, manifest, targetKey } = fixture();
    expect(await readReferenceCatalog(workspace, manifest, targetKey, { resolve_rows: Array.from({ length: 25 }, () => ({ entry_id: "seg:1", row_index: 0 })) }))
      .toMatchObject({ ok: false, error: "reference_catalog_row_batch_limit" });
    const unknownEntry = await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["entry:0"] });
    expect(unknownEntry).toMatchObject({
      ok: false,
      error: "reference_catalog_entry_not_found",
      target_key: targetKey,
      unknown_entry_ids: ["entry:0"],
      unknown_entry_parameters: [{
        entry_id: "entry:0",
        parameter: "entry_ids",
        index: 0,
        path: "/entry_ids/0",
      }],
      required_action: "read_reference_catalog_then_use_listed_entry_ids",
      next_tool: "read_reference_facts",
      writable_parameters: ["entry_ids"],
      do_not_edit: expect.any(String),
    });
    expect(unknownEntry.tool_arguments).toEqual({ target_key: targetKey });
    expect(unknownEntry.instruction).toMatch(/先只传.*target_key.*取得当前目录/u);
    expect(unknownEntry.instruction).toMatch(/从返回目录逐字复制.*entry_id/u);
    expect(unknownEntry.instruction).toContain("不要猜测、改写或沿用目录中不存在的 entry_id");

    const unknownSkip = await readReferenceCatalog(workspace, manifest, targetKey, {
      skip: [{ entry_id: "skip:missing", reason: "与当前目标无关" }],
    });
    expect(unknownSkip).toMatchObject({
      ok: false,
      error: "reference_catalog_entry_not_found",
      target_key: targetKey,
      unknown_entry_ids: ["skip:missing"],
      unknown_entry_parameters: [{
        entry_id: "skip:missing",
        parameter: "skip",
        index: 0,
        path: "/skip/0/entry_id",
      }],
      tool_arguments: { target_key: targetKey },
      writable_parameters: ["skip"],
    });
    expect(unknownSkip.instruction).toContain("skip[].entry_id");
    expect(unknownSkip.instruction).toContain("保留同一 skip 记录的 reason");

    const unknownResolveRow = await readReferenceCatalog(workspace, manifest, targetKey, {
      resolve_rows: [{ entry_id: "resolve:missing", row_index: 7 }],
    });
    expect(unknownResolveRow).toMatchObject({
      ok: false,
      error: "reference_catalog_entry_not_found",
      target_key: targetKey,
      unknown_entry_ids: ["resolve:missing"],
      unknown_entry_parameters: [{
        entry_id: "resolve:missing",
        parameter: "resolve_rows",
        index: 0,
        path: "/resolve_rows/0/entry_id",
      }],
      tool_arguments: { target_key: targetKey },
      writable_parameters: ["resolve_rows"],
    });
    expect(unknownResolveRow.instruction).toContain("resolve_rows[].entry_id");
    expect(unknownResolveRow.instruction).toContain("保留同一 resolve_rows 记录的 row_index");
    for (const feedback of [unknownEntry, unknownSkip, unknownResolveRow]) {
      expect(JSON.stringify(feedback)).not.toContain('"seg:1"');
      expect(JSON.stringify(feedback)).not.toContain('"seg:2"');
    }
  });

  test.each(["missing", "tampered"])("fails explicitly on a %s registered span instead of inventing a handle", async (kind) => {
    const { workspace, manifest, targetKey, registry, records } = fixture();
    if (kind === "missing") registry.spans = [];
    else registry.spans.find((span) => span.evidence_id === records[0]!.evidence_id)!.text_sha256 = "invalid";
    expect(await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"], resolve_rows: [{ entry_id: "seg:1", row_index: 0 }] }))
      .toMatchObject({ ok: false, terminal: true, error: "reference_catalog_row_span_unavailable" });
  });

  test("rolls back a catalog disposition when its caller aborts during the durable write", async () => {
    const { workspace, manifest, targetKey, state } = fixture();
    const caller = new AbortController();
    const reason = new Error("job cancelled during disposition write");
    const updateState = workspace.updateState.bind(workspace);
    workspace.updateState = async (update) => {
      const updated = await updateState(update);
      if (!caller.signal.aborted && state.reference_catalog_dispositions) caller.abort(reason);
      return updated;
    };

    await expect(readReferenceCatalog(
      workspace,
      manifest,
      targetKey,
      { skip_rest: { reason: "not needed" } },
      "target",
      undefined,
      caller.signal,
    )).rejects.toBe(reason);
    expect(state.reference_catalog_dispositions?.[`target:${targetKey}`]).toBeUndefined();
  });

  test("opens clause and table entries independently when they share one displayed source label", async () => {
    const records: FixtureRecord[] = [
      {
        evidence_id: `evidence:${sha256Text("shared-label-clause")}`,
        kind: "paragraph", role: "context", locator: "line:1", text: "D.0.1 构件应完成复核。",
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        evidence_id: `evidence:${sha256Text(`shared-label-clause-row-${index}`)}`,
        kind: "paragraph", role: "context", locator: `line:${index + 2}`, text: `${index + 1}) 条文记录 ${index + 1}`,
      })),
      {
        evidence_id: `evidence:${sha256Text("shared-label-table")}`,
        kind: "paragraph", role: "context", locator: "line:20", text: "表 D.0.1 复核项目",
      },
      {
        evidence_id: `evidence:${sha256Text("shared-label-table-header")}`,
        kind: "table_row", role: "formal_table_header", locator: "line:21/table-row:1",
        text: "<tr><td>项目</td><td>要求</td></tr>",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        evidence_id: `evidence:${sha256Text(`shared-label-table-row-${index}`)}`,
        kind: "table_row", role: "formal_table_row", locator: `line:21/table-row:${index + 2}`,
        text: `<tr><td>项目${index + 1}</td><td>要求${index + 1}</td></tr>`,
      })),
    ];
    const { workspace, manifest, targetKey, state } = fixtureFromRecords(records, "D.0.1");
    const catalog = await readReferenceCatalog(workspace, manifest, targetKey);
    const entries = catalog.catalog as Array<{ entry_id: string; source_label: string; kind: string }>;
    const clause = entries.find((entry) => entry.kind === "clause")!;
    const table = entries.find((entry) => entry.kind === "table")!;
    expect(clause.source_label).toBe("D.0.1");
    expect(table.source_label).toBe("D.0.1");
    expect(clause.entry_id).not.toBe(table.entry_id);

    expect(await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: [table.entry_id] }))
      .toMatchObject({ ok: true, disposition: { used: 1, ignored: 0, pending: 1 } });
    const persisted = state.reference_catalog_dispositions?.[`target:${targetKey}`]!;
    expect(persisted.used).toContain(table.entry_id);
    expect(persisted.used).not.toContain(clause.entry_id);

    expect(await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: [clause.entry_id] }))
      .toMatchObject({ ok: true, disposition: { used: 2, ignored: 0, pending: 0 } });
  });

  test("preserves target disposition across unrelated manifest changes and invalidates on target evidence changes", async () => {
    const { workspace, manifest, targetKey, state } = fixture();
    await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"] });
    const readKey = `target:${targetKey}`;
    expect(state.reference_catalog_dispositions?.[readKey]?.opened_ranges?.["seg:1"]).toBeDefined();

    const unrelatedEvidenceId = `evidence:${sha256Text("unrelated-reference")}`;
    manifest.evidence.push({
      evidence_id: unrelatedEvidenceId,
      kind: "paragraph",
      role: "context",
      locator: "line:999",
      text: "另一个引用目标。",
    } as typeof manifest.evidence[number]);
    manifest.reference_occurrences.push({
      occurrence_id: "reference:unrelated",
      reference_kind: "table",
      target_table_id: "Z.9",
      origin_evidence_id: unrelatedEvidenceId,
      origin_fields: ["requirement"],
      raw_reference: "表 Z.9",
      target_evidence_ids: [unrelatedEvidenceId],
      required: true,
      status: "resolved",
      depth: 1,
      path: [],
    } as ReferenceOccurrence);
    manifest.evidence_fingerprint = sha256Text("fixture-with-unrelated-reference");

    expect(await readReferenceCatalog(workspace, manifest, targetKey))
      .toMatchObject({ ok: true, disposition: { used: 1, ignored: 0, pending: 1 } });
    expect(state.reference_catalog_dispositions?.[readKey]?.opened_ranges?.["seg:1"]).toBeDefined();

    manifest.evidence[0]!.text += " 已修订";
    manifest.evidence_fingerprint = sha256Text("fixture-with-revised-target");
    expect(await readReferenceCatalog(workspace, manifest, targetKey))
      .toMatchObject({ ok: true, disposition: { used: 0, ignored: 0, pending: 2 } });
    expect(state.reference_catalog_dispositions?.[readKey]?.opened_ranges).toBeUndefined();
  });

  test("invalidates a matching legacy unversioned disposition exactly once", async () => {
    const { workspace, manifest, targetKey, state } = fixture();
    await readReferenceCatalog(workspace, manifest, targetKey);
    const readKey = `target:${targetKey}`;
    const legacy = state.reference_catalog_dispositions?.[readKey]!;
    legacy.used = ["seg:1"];
    delete legacy.fingerprint_version;

    expect(await readReferenceCatalog(workspace, manifest, targetKey))
      .toMatchObject({ ok: true, disposition: { used: 0, ignored: 0, pending: 2 } });
    expect(state.reference_catalog_dispositions?.[readKey]).toMatchObject({
      fingerprint_version: "reference-catalog-disposition-fingerprint/v2",
      used: [],
    });
  });

  test.each(["target", "coverage"] as const)("%s fails closed when a persisted opened range is malformed", async (phase) => {
    const { workspace, rebuildWorkspace, manifest, occurrence, targetKey, state, records } = fixture();
    await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: ["seg:1"] }, phase);
    await readReferenceCatalog(workspace, manifest, targetKey, {
      entry_ids: ["seg:1"],
      row_cursor: 24,
      row_offset: 0,
    }, phase);
    const readKey = `${phase}:${targetKey}`;
    state.reference_catalog_dispositions![readKey]!.opened_ranges!["seg:1"]!["0"] = [
      [-1, records[0]!.text.length],
    ];

    expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
      .toContain("seg:1");
  });

  test.each(["target", "coverage"] as const)("%s skip_rest never ignores an explicitly requested entry deferred by the call budget", async (phase) => {
    const { workspace, manifest, targetKey } = fixture();
    const receipt = await readReferenceCatalog(workspace, manifest, targetKey, {
      entry_ids: ["seg:1", "seg:2"],
      skip_rest: { reason: "未点名的目录条目与本目标无关" },
    }, phase);

    expect(receipt).toMatchObject({
      ok: true,
      deferred_entry_ids: ["seg:2"],
      disposition: { used: 1, ignored: 0, pending: 1 },
      pending_entry_ids: ["seg:2"],
    });
  });

  test("invalidates disposition when the ordered catalog structure changes over the same evidence", async () => {
    const records: FixtureRecord[] = [
      ["Section A First", 1],
      ...Array.from({ length: 7 }, (_, index) => [`detail a1-${index}`, index + 2] as const),
      ["Section A Second", 10],
      ...Array.from({ length: 7 }, (_, index) => [`detail a2-${index}`, index + 11] as const),
      ["Section B Third", 20],
      ...Array.from({ length: 8 }, (_, index) => [`detail b-${index}`, index + 21] as const),
    ].map(([text, line], index) => ({
      evidence_id: `evidence:${sha256Text(`catalog-structure-${index}`)}`,
      kind: "paragraph",
      role: "context",
      locator: `line:${line}`,
      text,
    }));
    const { workspace, manifest, targetKey, state } = fixtureFromRecords(records, "X.1");
    const broadRules: ReferenceCatalogRules = {
      table_title: "^NEVER_TABLE$",
      table_continuation: "^NEVER_CONTINUATION$",
      clause: "^Section ([AB]) (.+)$",
      subitem: "^detail ",
    };
    const preciseRules: ReferenceCatalogRules = {
      ...broadRules,
      clause: "^(Section [AB] (?:First|Second|Third))\\s*(.*)$",
    };
    state.reference_catalog_rules = { [targetKey]: broadRules };
    const first = await readReferenceCatalog(workspace, manifest, targetKey);
    const firstEntry = (first.catalog as Array<{ entry_id: string }>)[0]!.entry_id;
    await readReferenceCatalog(workspace, manifest, targetKey, { entry_ids: [firstEntry] });
    expect(state.reference_catalog_dispositions?.[`target:${targetKey}`]?.used).toEqual([firstEntry]);

    state.reference_catalog_rules[targetKey] = preciseRules;
    expect(await readReferenceCatalog(workspace, manifest, targetKey))
      .toMatchObject({ ok: true, disposition: { used: 0, ignored: 0, pending: 3 } });
  });
});


test.each(["target", "coverage"] as const)("%s paginates an oversized first row without loss or premature citation", async (phase) => {
  const original = "甲🙂".repeat(12000);
  const {workspace, manifest, targetKey} = fixture(original);
  let row_cursor = 0, row_offset = 0, assembled = "", calls = 0;
  while (row_cursor === 0) {
    const output = await readReferenceCatalog(workspace, manifest, targetKey, {entry_ids:["seg:1"], row_cursor, row_offset}, phase);
    expect(output.ok).toBe(true);
    const entry = (output.entries as Array<{rows:Array<[number,string]>;next_row_cursor:number|null;next_row_offset:number|null}>)[0]!;
    expect(entry.rows.reduce((sum, [,text]) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(32 * 1024);
    assembled += entry.rows.filter(([index])=>index===0).map(([,text])=>text).join("");
    calls++;
    if (entry.next_row_cursor === 0) {
      expect(await readReferenceCatalog(workspace, manifest, targetKey, {resolve_rows:[{entry_id:"seg:1",row_index:0}]}, phase)).toMatchObject({ok:false,error:"reference_catalog_entry_not_opened"});
      row_offset = entry.next_row_offset!;
    } else break;
    expect(calls).toBeLessThan(10);
  }
  expect(calls).toBeGreaterThan(1);
  expect(assembled).toBe(original);
  expect(await readReferenceCatalog(workspace, manifest, targetKey, {resolve_rows:[{entry_id:"seg:1",row_index:0}]}, phase)).toMatchObject({ok:true,resolved_rows:[{span_id:expect.stringMatching(/^span:/)}]});
});

test.each(["target", "coverage"] as const)("%s keeps an entry pending until an oversized row is fully read across workspace rebuild", async (phase) => {
  const original = "乙🙂".repeat(12000);
  const { workspace, rebuildWorkspace, manifest, occurrence, targetKey } = fixture(original, 1);
  const first = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids: ["seg:1"], row_cursor: 0, row_offset: 0,
  }, phase);
  const firstEntry = (first.entries as Array<{
    next_row_cursor: number | null;
    next_row_offset: number | null;
  }>)[0]!;
  expect(firstEntry.next_row_cursor).toBe(0);
  expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
    .toContain("seg:1");
  expect(await referenceAnalysisIssues(rebuildWorkspace(), manifest, phase)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
  ]));

  let rowCursor = firstEntry.next_row_cursor;
  let rowOffset = firstEntry.next_row_offset;
  let calls = 0;
  while (rowCursor !== null) {
    const next = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, {
      entry_ids: ["seg:1"], row_cursor: rowCursor, row_offset: rowOffset ?? 0,
    }, phase);
    const entry = (next.entries as Array<{
      next_row_cursor: number | null;
      next_row_offset: number | null;
    }>)[0]!;
    rowCursor = entry.next_row_cursor;
    rowOffset = entry.next_row_offset;
    calls += 1;
    expect(calls).toBeLessThan(10);
  }
  expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
    .toEqual([]);
  expect(await referenceAnalysisIssues(rebuildWorkspace(), manifest, phase)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
  ]));
});

test.each(["target", "coverage"] as const)("%s can explicitly skip a partially read entry and later reopen it from its durable cursor", async (phase) => {
  const original = "乙".repeat(12000);
  const { workspace, rebuildWorkspace, manifest, occurrence, targetKey, state } = fixture(original, 1);
  const first = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids: ["seg:1"], row_cursor: 0, row_offset: 0,
  }, phase);
  const firstEntry = (first.entries as Array<{
    next_row_cursor: number | null;
    next_row_offset: number | null;
  }>)[0]!;
  expect(firstEntry.next_row_cursor).toBe(0);
  expect(firstEntry.next_row_offset).toBeGreaterThan(0);

  const skipped = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, {
    skip: [{ entry_id: "seg:1", reason: "本目标不采用该目录条目" }],
  }, phase);
  expect(skipped).toMatchObject({
    ok: true,
    disposition: { used: 0, ignored: 1, pending: 0 },
  });
  expect(state.reference_catalog_dispositions?.[`${phase}:${targetKey}`]).toMatchObject({
    used: [],
    ignored: [{ entry_id: "seg:1", reason: "本目标不采用该目录条目" }],
  });
  expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
    .toEqual([]);
  expect(await referenceAnalysisIssues(rebuildWorkspace(), manifest, phase)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
  ]));

  const reopened = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, {
    entry_ids: ["seg:1"],
    row_cursor: firstEntry.next_row_cursor!,
    row_offset: firstEntry.next_row_offset!,
  }, phase);
  expect(reopened).toMatchObject({
    ok: true,
    entries: [expect.objectContaining({ next_row_cursor: null, next_row_offset: null })],
    disposition: { used: 1, ignored: 0, pending: 0 },
  });
  expect(state.reference_catalog_dispositions?.[`${phase}:${targetKey}`]).toMatchObject({
    used: ["seg:1"],
    ignored: [],
  });
});

test.each(["target", "coverage"] as const)("%s keeps an entry pending until every row beyond the 24-row page is read", async (phase) => {
  const entryId = "A.1";
  const records: FixtureRecord[] = [
    {
      evidence_id: "table-title",
      kind: "paragraph",
      role: "context",
      locator: "line:1",
      text: "表 A.1 中性项目",
    },
    ...Array.from({ length: 25 }, (_, index) => ({
      evidence_id: `table-row-${index + 1}`,
      kind: "table_row" as const,
      role: "formal_table_row" as const,
      locator: `line:${index + 2}/table-row:${index + 1}`,
      text: `<tr><td>中性行 ${index + 1}</td><td>内容 ${index + 1}</td></tr>`,
    })),
  ];
  const { workspace, rebuildWorkspace, manifest, occurrence, targetKey } = fixtureFromRecords(records, entryId);
  const first = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids: [entryId], row_cursor: 0, row_offset: 0,
  }, phase);
  const firstEntry = (first.entries as Array<{
    next_row_cursor: number | null;
    next_row_offset: number | null;
  }>)[0]!;
  expect(firstEntry.next_row_cursor).toBe(24);
  expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
    .toContain(entryId);
  expect(await referenceAnalysisIssues(rebuildWorkspace(), manifest, phase)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
  ]));

  const completed = await readReferenceCatalog(rebuildWorkspace(), manifest, targetKey, {
    entry_ids: [entryId],
    row_cursor: firstEntry.next_row_cursor!,
    row_offset: firstEntry.next_row_offset ?? 0,
  }, phase);
  expect(completed).toMatchObject({
    ok: true,
    entries: [expect.objectContaining({ next_row_cursor: null, next_row_offset: null })],
  });
  expect((await referenceCatalogPending(rebuildWorkspace(), manifest, targetKey, occurrence, phase)).pending)
    .toEqual([]);
  expect(await referenceAnalysisIssues(rebuildWorkspace(), manifest, phase)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reference_catalog_entries_undisposed" }),
  ]));
});


test("catalog metadata pages retain every entry without loading source text", async () => {
  const {workspace, manifest, targetKey} = fixture(undefined, 625);
  const first = await readReferenceCatalog(workspace, manifest, targetKey, {});
  expect(first.catalog).toHaveLength(24);
  expect(first.entries).toBeUndefined();
  expect(first.next_catalog_cursor).toBe(24);
  const second = await readReferenceCatalog(workspace, manifest, targetKey, {catalog_cursor:24});
  expect(second.next_catalog_cursor).toBeNull();
  const ids = [...first.catalog as Array<{entry_id:string}>, ...second.catalog as Array<{entry_id:string}>].map(row=>row.entry_id);
  expect(new Set(ids).size).toBe(first.total_entries);
});

test.each([-1, 0.5, NaN])("rejects invalid pagination cursor %s", async (row_cursor) => {
  const {workspace, manifest, targetKey} = fixture();
  expect(await readReferenceCatalog(workspace, manifest, targetKey, {entry_ids:["seg:1"],row_cursor}))
    .toMatchObject({ok:false,error:"reference_catalog_cursor_invalid"});
});

test.each([
  {
    label: "negative row cursor",
    request: {entry_ids: ["seg:1"], row_cursor: -1},
    field: "row_cursor",
    value: -1,
    returnedCursor: "next_row_cursor",
    omittedCursor: "row_cursor 和 row_offset",
  },
  {
    label: "fractional row offset",
    request: {entry_ids: ["seg:1"], row_offset: 0.5},
    field: "row_offset",
    value: 0.5,
    returnedCursor: "next_row_offset",
    omittedCursor: "row_cursor 和 row_offset",
  },
  {
    label: "negative catalog cursor",
    request: {catalog_cursor: -1},
    field: "catalog_cursor",
    value: -1,
    returnedCursor: "next_catalog_cursor",
    omittedCursor: "catalog_cursor",
  },
])("$label receives field-specific cursor value guidance", async ({request, field, value, returnedCursor, omittedCursor}) => {
  const {workspace, manifest, targetKey} = fixture();
  const rejected = await readReferenceCatalog(workspace, manifest, targetKey, request);

  expect(rejected).toMatchObject({
    ok: false,
    error: "reference_catalog_cursor_invalid",
    reason: expect.stringContaining("不是非负整数"),
    actual: {
      invalid_cursor_fields: [{field, value, displayed_value: String(value)}],
    },
    expected: {
      invalid_cursor_fields: {[field]: `${field} 必须是非负整数。`},
    },
    allowed_actions: [expect.stringContaining(returnedCursor)],
    next_tool: "read_reference_facts",
    next_tool_arguments: request.entry_ids
      ? {target_key: targetKey, entry_ids: request.entry_ids}
      : {target_key: targetKey},
    how_to_pass: expect.stringContaining(omittedCursor),
  });
  expect(rejected.how_to_pass).not.toContain("打开多个条目");
  expect(rejected.instruction).toContain("actual.invalid_cursor_fields");
});

test("drops both paired body cursors from suggested arguments when either value is invalid", async () => {
  const {workspace, manifest, targetKey} = fixture();
  const rejected = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids: ["seg:1"],
    row_cursor: -1,
    row_offset: 3,
    catalog_cursor: 0,
  });

  expect(rejected).toMatchObject({
    ok: false,
    error: "reference_catalog_cursor_invalid",
    actual: {
      row_cursor: -1,
      row_offset: 3,
      invalid_cursor_fields: [{field: "row_cursor", value: -1, displayed_value: "-1"}],
    },
    allowed_actions: [expect.stringMatching(/同时原样替换 row_cursor 和 row_offset.*同时省略 row_cursor 和 row_offset/u)],
    next_tool_arguments: {target_key: targetKey, entry_ids: ["seg:1"], catalog_cursor: 0},
  });
  expect(rejected.next_tool_arguments).not.toHaveProperty("row_cursor");
  expect(rejected.next_tool_arguments).not.toHaveProperty("row_offset");
});

test("explains both executable repairs when a body continuation cursor is combined with multiple entries", async () => {
  const {workspace, manifest, targetKey} = fixture();
  const entry_ids = ["seg:1", "seg:2"];
  const rejected = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids,
    row_cursor: 6,
    row_offset: 0,
    catalog_cursor: 0,
  });

  expect(rejected).toMatchObject({
    ok: false,
    error: "reference_catalog_cursor_invalid",
    reason: expect.stringContaining("恰好一个 entry_id"),
    actual: {entry_ids, entry_id_count: 2, row_cursor: 6, row_offset: 0, catalog_cursor: 0},
    expected: {
      source_continuation: expect.stringContaining("entry_ids 必须恰好包含一个"),
      multiple_entries: expect.stringContaining("省略 row_cursor 和 row_offset"),
      catalog_pagination: expect.stringContaining("相互独立"),
    },
    allowed_actions: [expect.stringContaining("继续单一条目"), expect.stringContaining("打开多个条目")],
    next_tool: "read_reference_facts",
    next_tool_arguments: {target_key: targetKey, entry_ids},
    how_to_pass: expect.stringContaining("二选一修正"),
  });
  expect(rejected.instruction).toMatch(/没有修改只读原文.*没有写入目录处置状态/u);

  const continuedSingleEntry = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids: ["seg:1"],
    row_cursor: 6,
    row_offset: 0,
    catalog_cursor: 0,
  });
  expect(continuedSingleEntry).toMatchObject({ok: true});

  const openedMultipleEntriesFromStart = await readReferenceCatalog(workspace, manifest, targetKey, {
    entry_ids,
    catalog_cursor: 0,
  });
  expect(openedMultipleEntriesFromStart).toMatchObject({ok: true});
});
