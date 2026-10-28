import { describe, expect, test } from "vitest";

import { sha256Text } from "../src/canonical.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_SCOPE_SCHEMA_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
} from "../src/contracts.js";
import { scanDocumentLedger } from "../src/document-ledger.js";
import { prefillTargetSelectorsFromLedger } from "../src/ledger-target-selectors.js";
import {
  compileTargetSelectors,
  TargetSelectorCompileError,
} from "../src/target-selector-compiler.js";
import { locateAndRegisterSourceQuote, registryWithFullSourceSpans } from "../src/source-span-registry.js";

const SAMPLE = `
# 4 原材料及成品进场验收 [PDF p.12]

## 4.2 铝合金材料 [PDF p.13]

### 主控项目 [PDF p.13]

4.2.1 铝合金材料的品种、规格、性能应符合设计文件要求。

检查数量：全数检查。

检验方法：检查质量证明文件。

### 一般项目 [PDF p.14]

4.2.3 铝合金材料外观不应有明显损伤。

检查数量：抽查10%，且不少于3件。

检验方法：观察检查。

## 7.2 切割 [PDF p.30]

7.2.2 铝合金零部件切割允许偏差应符合表 7.2.2 的规定。

检查数量：按数量抽查10%，且不少于3件。

检验方法：用钢尺、塞尺检查。

表 7.2.2 切割的允许偏差

<table><tr><td>检查项目</td><td>允许偏差</td></tr><tr><td>零部件的宽度,长度</td><td>±1.0mm</td></tr><tr><td>切割平面度</td><td>0.3mm</td></tr><tr><td>割纹深度</td><td>0.3mm</td></tr><tr><td>局部缺口深度</td><td>0.5mm</td></tr></table>

7.4.3 螺栓球加工允许偏差应符合表 7.4.3 的规定。

检查数量：每种规格抽查5%，且不应少于5只。

检验方法：见本规范表 7.4.3。

表 7.4.3 螺栓球加工的允许偏差

<table><tr><td colspan="2">检查项目</td><td>允许偏差</td><td>检验方法</td></tr><tr><td rowspan="2">圆度</td><td>d≤120mm</td><td>1.0mm</td><td rowspan="2">用卡尺和游标卡尺检查</td></tr><tr><td>d>120mm</td><td>1.5mm</td></tr><tr><td colspan="2">铣平面距球中心距离</td><td>±0.1mm</td><td>用游标卡尺检查</td></tr></table>
`.trim();

function manifestFor(text: string): EvidenceManifest {
  const evidenceId = "atom:ledger-prefill";
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    job_id: "job:ledger-prefill",
    target_id: "target:ledger-prefill",
    source: {
      adapter: "document-domain-agent/v1",
      file_name: "ledger-prefill.md",
      sha256: sha256Text(text),
      semantic_workflow: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    },
    scope: {
      schema_version: EVIDENCE_SCOPE_SCHEMA_VERSION,
      mode: "agent_discovered",
      target_id: "target:ledger-prefill",
      source_line_count: text.split("\n").length,
      selected_start_line: 1,
      selected_end_exclusive_line: text.split("\n").length + 1,
      selected_heading: "4.2 铝合金材料",
      selection_reason: "ledger prefill fixture",
      selected_atom_ids: [evidenceId],
      target_evidence_fragments: [{ atom_id: evidenceId, text }],
      candidates: [],
    },
    evidence: [{
      evidence_id: evidenceId,
      kind: "paragraph",
      role: "supporting_clause",
      locator: `char:0-${text.length}`,
      text,
      text_sha256: sha256Text(text),
      requires_disposition: true,
      evidence_scope: "primary",
    }],
    table_fragments: [],
    reference_occurrences: [],
    evidence_fingerprint: sha256Text(`ledger-prefill\0${text}`),
  };
}

function granularManifestFor(text: string): EvidenceManifest {
  const base = manifestFor(text);
  const evidence = text.split("\n").flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const lineNumber = index + 1;
    const evidenceId = `evidence:${sha256Text(`${lineNumber}\0${trimmed}`)}`;
    return [{
      evidence_id: evidenceId,
      kind: "paragraph" as const,
      role: "supporting_clause" as const,
      locator: `line:${lineNumber}`,
      text: trimmed,
      text_sha256: sha256Text(trimmed),
      requires_disposition: true,
      evidence_scope: "primary" as const,
    }];
  });
  return {
    ...base,
    evidence,
    scope: {
      ...base.scope,
      selected_atom_ids: evidence.map((record) => record.evidence_id),
    },
    evidence_fingerprint: sha256Text(`ledger-prefill-granular\0${text}`),
  };
}

describe("ledger target selector prefill", () => {
  const SCOPED = [
    "## 7.3 构件安装", "### 主控项目",
    "7.3.2 材料性能应符合设计要求。", "检查数量：全数检查。", "检验方法：检查证明文件。",
    "7.3.3 安装位置应符合设计要求。", "检查数量：全数检查。", "检验方法：测量。",
    "7.3.20 构件外观应完整。", "检查数量：全数检查。", "检验方法：观察。", "续表 7.3.20",
  ].join("\n");
  function prefillScoped(manifest: EvidenceManifest) {
    return prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(SCOPED, "scope.md"), markdown: SCOPED, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: 13,
    });
  }

  test("intersects the discovery window with non-contiguous confirmed primary blocks", () => {
    const manifest = granularManifestFor(SCOPED);
    manifest.scope.primary_source_ranges = [
      { start_line: 3, end_exclusive_line: 6 }, { start_line: 9, end_exclusive_line: 12 },
    ];
    const result = prefillScoped(manifest);
    expect(result.selectors.items.map(item => item.key)).toEqual(["ledger-clause:7.3.2", "ledger-clause:7.3.20"]);
  });

  test("honors legacy selected bounds when no confirmed ranges are present", () => {
    const manifest = granularManifestFor(SCOPED);
    manifest.scope.selected_start_line = 6;
    manifest.scope.selected_end_exclusive_line = 9;
    expect(prefillScoped(manifest).selectors.items.map(item => item.key)).toEqual(["ledger-clause:7.3.3"]);
  });

  test("never seeds an item from reference evidence even if it requires disposition", () => {
    const manifest = granularManifestFor(SCOPED);
    manifest.evidence.filter(record => ["line:3", "line:4", "line:5"].includes(record.locator))
      .forEach(record => { record.evidence_scope = "reference"; });
    expect(prefillScoped(manifest).selectors.items.map(item => item.key)).not.toContain("ledger-clause:7.3.2");
  });

  test("does not substitute a clause-number prefix from a continuation caption for missing prose", () => {
    const manifest = granularManifestFor(SCOPED);
    manifest.evidence = manifest.evidence.filter(record => record.locator !== "line:3");
    const caption = manifest.evidence.find(record => record.locator === "line:12")!;
    caption.role = "table_continuation_caption";
    caption.table_id = "7.3.20";
    expect(prefillScoped(manifest).selectors.items.map(item => item.key)).not.toContain("ledger-clause:7.3.2");
    // Legacy whole-source lookup must also require the complete clause text.
    manifest.evidence.forEach(record => { record.locator = `char:0-${record.text.length}`; });
    expect(prefillScoped(manifest).selectors.items.map(item => item.key)).not.toContain("ledger-clause:7.3.2");
  });

  test("does not borrow an identical quantity from a sibling clause when the original line is missing", () => {
    const manifest = granularManifestFor(SCOPED);
    manifest.evidence = manifest.evidence.filter(record => record.locator !== "line:4");
    const item = prefillScoped(manifest).selectors.items.find(item => item.key === "ledger-clause:7.3.2");
    // A labeled quantity with no exact source cannot seed a complete candidate.
    expect(item).toBeUndefined();
  });

  test("does not manufacture a forty-character requirement when the complete multiline source cannot bind", () => {
    const markdown = [
      "## 4.2 防护涂层", "### 主控项目", "4.2.1 涂层性能应符合下列规定：",
      "1 试验后涂层应保持完整，不得出现影响防护性能的开裂、剥落以及露底等缺陷，边缘区域也应符合相同要求；",
      "2 涂层附着强度应符合设计要求。", "检查数量：全数检查。", "检验方法：检查试验报告。",
    ].join("\n\n");
    const manifest = granularManifestFor(markdown);
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const result = prefillTargetSelectorsFromLedger({ ledger: scanDocumentLedger(markdown, "multiline.md"), markdown, manifest, registry, start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 });
    expect(result.selectors.items.find(item => item.key === "ledger-clause:4.2.1")).toBeUndefined();
    expect(result.selectors.source_dispositions).toEqual([]);
  });

  test.each([
    ["method", manifestFor], ["method", granularManifestFor],
    ["quantity", manifestFor], ["quantity", granularManifestFor],
  ] as const)("keeps a complete wrapped %s block or leaves the candidate pending (%#)", (field, makeManifest) => {
    const block = field === "method"
      ? ["检验方法：用测厚仪测定涂层", "<!-- page:2 -->", "厚度，并记录测定结果。", "检查数量：全数检查。"]
      : ["检查数量：每批抽查2件，", "<!-- page:2 -->", "不足2件时全数检查。", "检验方法：观察检查。"];
    const expected = field === "method"
      ? "检验方法：用测厚仪测定涂层厚度，并记录测定结果。"
      : "检查数量：每批抽查2件，不足2件时全数检查。";
    const markdown = ["## 4.2 涂层复核", "### 主控项目", "4.2.1 涂层表面应完整。", ...block].join("\n\n");
    const manifest = makeManifest(markdown);
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(markdown, "wrapped-role.md"), markdown, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: markdown.split("\n").length + 1,
    });
    const item = prefilled.selectors.items.find(row => row.key === "ledger-clause:4.2.1");
    if (makeManifest === granularManifestFor) {
      expect(item).toBeUndefined();
    } else {
      expect(item).toBeDefined();
      const selected = item!.fields[field].span_ids.map(id => {
        const span = prefilled.registry.spans.find(row => row.span_id === id)!;
        return manifest.evidence.find(row => row.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
      }).join("");
      expect(selected.replace(/<!--[^>]*-->|\s/gu, "")).toBe(expected);
      expect(selected).not.toContain(field === "method" ? "检查数量" : "检验方法");
    }
    expect(prefilled.selectors.source_dispositions).toEqual([]);
  });

  test.each(["method", "quantity"] as const)("retains the first and later %s labels in one complete block", (field) => {
    const block = field === "method"
      ? ["检验方法：观察涂层表面。", "检验方法：核查检测报告。", "检查数量：全数检查。"]
      : ["检查数量：每批抽查2件。", "检查数量：不足2件时全数检查。", "检验方法：观察检查。"];
    const markdown = ["## 4.2 涂层复核", "### 主控项目", "4.2.1 涂层表面应完整。", ...block].join("\n\n");
    const manifest = manifestFor(markdown);
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(markdown, "repeated-role-label.md"), markdown, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: markdown.split("\n").length + 1,
    });
    const item = prefilled.selectors.items[0]!;
    const selected = item.fields[field].span_ids.map(id => {
      const span = prefilled.registry.spans.find(row => row.span_id === id)!;
      return manifest.evidence.find(row => row.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
    }).join("");
    expect(selected.replace(/\s/gu, "")).toBe(block.slice(0, 2).join(""));
  });

  test.each(["注：检测记录归档。", "续表 4.2.1"])("keeps %s out of a wrapped method block", (boundary) => {
    const markdown = ["## 4.2 涂层复核", "### 主控项目", "4.2.1 涂层表面应完整。",
      "检查数量：全数检查。", "检验方法：观察表面，", "并核查检测报告。", boundary].join("\n\n");
    const manifest = manifestFor(markdown);
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(markdown, "role-structure-boundary.md"), markdown, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: markdown.split("\n").length + 1,
    });
    const item = prefilled.selectors.items[0]!;
    const selected = item.fields.method.span_ids.map(id => {
      const span = prefilled.registry.spans.find(row => row.span_id === id)!;
      return manifest.evidence.find(row => row.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
    }).join("");
    expect(selected.replace(/\s/gu, "")).toBe("检验方法：观察表面，并核查检测报告。");
  });

  test.each([manifestFor, granularManifestFor])("keeps the clause lead with a wrapped requirement or leaves the whole candidate pending (%#)", (makeManifest) => {
    const lead = "4.2.1 涂层质量应符合设计要求和检测报";
    const continuation = "告的规定，表面应完整。";
    const markdown = ["## 4.2 涂层复核", "### 主控项目", lead,
      "<!-- page:2 -->", continuation, "检验方法：观察检查。", "检查数量：全数检查。"].join("\n\n");
    const manifest = makeManifest(markdown);
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(markdown, "wrapped-requirement.md"), markdown, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: markdown.split("\n").length + 1,
    });
    const item = prefilled.selectors.items.find(row => row.key === "ledger-clause:4.2.1");
    if (makeManifest === granularManifestFor) {
      // The prefill's existing exact-binding policy leaves a multi-source
      // requirement for authoring; it must never seed only the tail paragraph.
      expect(item).toBeUndefined();
    } else {
      expect(item).toBeDefined();
      const selected = item!.fields.requirement.span_ids.map(id => {
        const span = prefilled.registry.spans.find(row => row.span_id === id)!;
        return manifest.evidence.find(row => row.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
      }).join("");
      expect(selected.replace(/<!--[^>]*-->|\s/gu, "")).toBe((lead.replace(/^4\.2\.1\s*/u, "") + continuation).replace(/\s/gu, ""));
      expect(selected).not.toContain("检验方法");
      expect(selected).not.toContain("检查数量");
    }
    expect(prefilled.selectors.source_dispositions).toEqual([]);
  });

  test.each([
    ["检验方法：核查检测报告。", "并记录核查结果。", "检查数量：全数检查。"],
    ["检查数量：全数检查。", "每批记录检查数量。", "检验方法：观察检查。"],
    ["检验方法：观察检查。", "检验方法：核查检测报告。", "并记录核查结果。", "检查数量：全数检查。"],
  ])("ends the requirement at the first method or quantity block (%#)", (...body) => {
    const lead = "4.2.1 涂层表面应完整。";
    const markdown = ["## 4.2 涂层复核", "### 主控项目", lead, ...body].join("\n\n");
    const manifest = manifestFor(markdown);
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger: scanDocumentLedger(markdown, "role-boundary.md"), markdown, manifest,
      registry: registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, text: record.text,
      }))), start_line: 1, end_exclusive_line: markdown.split("\n").length + 1,
    });
    const item = prefilled.selectors.items.find(row => row.key === "ledger-clause:4.2.1")!;
    expect(item).toBeDefined();
    const selected = item.fields.requirement.span_ids.map(id => {
      const span = prefilled.registry.spans.find(row => row.span_id === id)!;
      return manifest.evidence.find(row => row.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
    }).join("");
    expect(selected).toBe(lead);
  });

  test("prefills an explicit local full-inspection quantity rather than not_sampling", () => {
    const manifest = granularManifestFor(SAMPLE);
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const result = prefillTargetSelectorsFromLedger({ ledger: scanDocumentLedger(SAMPLE, "full-inspection.md"), markdown: SAMPLE, manifest, registry, start_line: 1, end_exclusive_line: 22 });
    const item = result.selectors.items.find(item => item.key === "ledger-clause:4.2.1")!;
    expect(item.sampling).toMatchObject({ status: "explicit", rule_key: "", branch_keys: [], quantity_span_ids: item.fields.quantity.span_ids, script_span_ids: item.fields.quantity.span_ids });
  });

  test("keeps complete source name candidates and unresolved sampling pending in program prefill", () => {
    const titles = [
      "2020型构件在条件甲下的方向、完整性及长期性能应符合记录要求。",
      "构件Q的水平距离偏差为0～+3mm时应核对对应连接条件。",
      `${"另一构件的完整对象质量属性与适用条件".repeat(10)}均应核对源记录。`,
    ];
    const markdown = ["## 4.2 示例对象", "### 主控项目",
      ...titles.flatMap((title, index) => [`4.2.${index + 1} ${title}`,
        ...(index === 1 ? ["检查数量：按适用范围另行确定。"] : []), "检验方法：核对记录。"]),
    ].join("\n\n");
    const manifest = granularManifestFor(markdown);
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const result = prefillTargetSelectorsFromLedger({ ledger: scanDocumentLedger(markdown, "neutral-prefill.md"),
      markdown, manifest, registry, start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 });
    expect(result.selectors.items.map(item => item.name)).toEqual(titles);
    expect(result.selectors.items).toHaveLength(3);
    for (const item of result.selectors.items) {
      expect(item.sampling).toMatchObject({ status: "pending", rule_key: "", branch_keys: [],
        quantity_span_ids: [], script_span_ids: [], condition_span_ids: [], confidence: 0 });
      expect(item.sampling.reason).not.toBe("未单列检查数量");
      const requirement = result.registry.spans.find(span => item.fields.requirement.span_ids.includes(span.span_id));
      const source = manifest.evidence.find(record => record.evidence_id === requirement?.evidence_id)!;
      expect(source.text.slice(requirement!.start, requirement!.end)).toContain(item.name);
    }
    expect(result.selectors.items[1]?.fields.quantity.span_ids).toHaveLength(1);
  });

  test("preserves the whole multiline requirement and defers it when no complete source can bind", () => {
    const first = "构件Q的方向应满足条件甲；";
    const second = "处于条件乙时，其连接范围还应覆盖完整限定。";
    const markdown = ["## 4.2 示例对象", "### 主控项目", `4.2.1 ${first}`, second, "检验方法：核对记录。"].join("\n\n");
    for (const makeManifest of [manifestFor, granularManifestFor]) {
      const manifest = makeManifest(markdown);
      const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
        source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
      })));
      const result = prefillTargetSelectorsFromLedger({ ledger: scanDocumentLedger(markdown, "multiline-candidate.md"),
        markdown, manifest, registry, start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 });
      if (makeManifest === granularManifestFor) {
        expect(result.selectors.items).toEqual([]);
      } else {
        expect(result.selectors.items).toHaveLength(1);
        const item = result.selectors.items[0]!;
        const span = result.registry.spans.find(row => row.span_id === item.fields.requirement.span_ids[0])!;
        const source = manifest.evidence.find(row => row.evidence_id === span.evidence_id)!;
        expect(source.text.slice(span.start, span.end)).toContain(first);
        expect(source.text.slice(span.start, span.end)).toContain(second);
        expect(item.sampling.status).toBe("pending");
      }
    }
  });
  test.each([manifestFor, granularManifestFor])("keeps body and applicability notes out of structural lot scope (%#)", (makeManifest) => {
    const note = "注：垂直度项括号中数值适用于灌注桩排桩采用桩墙合一设计的情况。";
    const markdown = ["## 7.2 排桩", "7.2.1 施工前应检查定位放线。", "7.2.6 垂直度应符合设计要求。", "检查数量：全数检查。", "检验方法：测量检查。", note].join("\n\n");
    const manifest = makeManifest(markdown);
    const ledger = scanDocumentLedger(markdown, "scope-note.md");
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map((record) => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const result = prefillTargetSelectorsFromLedger({ ledger, markdown, manifest, registry, start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 });
    const scopeTexts = result.selectors.lots[0]!.scope_span_ids.map((id) => {
      const span = result.registry.spans.find((span) => span.span_id === id)!;
      return manifest.evidence.find((e) => e.evidence_id === span.evidence_id)!.text.slice(span.start, span.end);
    });
    expect(scopeTexts).toEqual(["## 7.2 排桩"]);
    expect(JSON.stringify(result.selectors.source_dispositions)).not.toContain(result.selectors.lots[0]!.scope_span_ids[0]);
    const record = manifest.evidence.find((record) => record.text.includes(note))!;
    const { registry: withNote, spans } = locateAndRegisterSourceQuote(result.registry, {
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    }, note);
    const span = spans[0]!;
    const item = result.selectors.items.find((item) => item.key === "ledger-clause:7.2.6")!;
    item.name = "杆件垂直度";
    item.continuation_span_ids = [span.span_id];
    item.fields.note = { composition: "verbatim", span_ids: [span.span_id], separator: "", reason: "保留垂直度适用条件" };
    // This fixture's administrative clause has no quantity; an author must
    // complete that decision before testing the unrelated scope projection.
    result.selectors.items.filter(row => row.sampling.status === "pending").forEach(row => {
      row.sampling = { ...row.sampling, status: "not_sampling", reason: "已核对原文，仅为施工前检查程序。", confidence: 1 };
    });
    expect(() => compileTargetSelectors(result.selectors, withNote, manifest)).not.toThrow();
  });
  test("binds repeated quantity and method text to each clause's own evidence line", () => {
    const markdown = `
## 14.3 涂装

14.3.4 电泳涂漆后的漆膜应均匀、整洁。

检查数量：全数检查。

检验方法：观察检查。

14.3.5 粉末喷涂型材装饰面上的涂层应平滑、均匀。

检查数量：全数检查。

检验方法：观察检查。
`.trim();
    const ledger = scanDocumentLedger(markdown, "repeated-direct-fields.md");
    const manifest = granularManifestFor(markdown);
    const registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger,
      markdown,
      manifest,
      registry,
      start_line: 1,
      end_exclusive_line: markdown.split("\n").length + 1,
    });
    const second = prefilled.selectors.items.find((item) => item.key === "ledger-clause:14.3.5")!;
    const evidenceForSpan = (spanId: string) => {
      const evidenceId = prefilled.registry.spans.find((span) => span.span_id === spanId)?.evidence_id;
      return manifest.evidence.find((record) => record.evidence_id === evidenceId);
    };

    expect(evidenceForSpan(second.fields.quantity.span_ids[0]!)?.locator).toBe("line:11");
    expect(evidenceForSpan(second.fields.method.span_ids[0]!)?.locator).toBe("line:13");
  });

  test("builds source candidates per quantity clause and requires author names before final compilation", () => {
    const markdown = SAMPLE.split("## 7.2")[0]!.trim();
    const ledger = scanDocumentLedger(markdown, "ledger-prefill.md");
    const manifest = manifestFor(markdown);
    const registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger,
      markdown,
      manifest,
      registry,
      start_line: 1,
      end_exclusive_line: markdown.split("\n").length + 1,
    });
    expect(prefilled.clause_item_count).toBe(2);
    expect(prefilled.table_item_count).toBe(0);
    expect(prefilled.selectors.items.map((item) => item.key)).toEqual([
      "ledger-clause:4.2.1",
      "ledger-clause:4.2.3",
    ]);
    expect(prefilled.selectors.items[0]?.sampling.status).toBe("explicit");
    expect(prefilled.selectors.items[1]?.sampling.status).toBe("explicit");
    expect(() => compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest)).toThrow(/selector_name_verdict_sentence/);
    prefilled.selectors.items[0]!.name = "铝合金材料品种、规格及性能";
    prefilled.selectors.items[1]!.name = "铝合金材料外观";
    expect(() => compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest)).not.toThrow();
  });

  test("expands an in-window HTML 允许偏差 table by checkpoint, not by mechanical cell", () => {
    const ledger = scanDocumentLedger(SAMPLE, "ledger-prefill.md");
    const manifest = manifestFor(SAMPLE);
    const registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger,
      markdown: SAMPLE,
      manifest,
      registry,
      start_line: 1,
      end_exclusive_line: SAMPLE.split("\n").length + 1,
    });
    expect(prefilled.selectors.items.some((item) => item.key === "ledger-clause:7.2.2")).toBe(false);
    const cutting = prefilled.selectors.items.filter((item) => item.key.startsWith("ledger-table:7.2.2:"));
    expect(cutting.map((item) => item.name)).toEqual([
      "零部件的宽度,长度",
      "切割平面度",
      "割纹深度",
      "局部缺口深度",
    ]);
    const bolt = prefilled.selectors.items.filter((item) => item.key.startsWith("ledger-table:7.4.3:"));
    expect(bolt.map((item) => item.name)).toEqual(["圆度", "铣平面距球中心距离"]);
    expect(bolt[0]?.table?.properties.allowed_value_span_ids).toHaveLength(2);
    prefilled.selectors.items.find(item => item.key === "ledger-clause:4.2.1")!.name = "铝合金材料品种、规格及性能";
    prefilled.selectors.items.find(item => item.key === "ledger-clause:4.2.3")!.name = "铝合金材料外观";
    try {
      compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest);
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      throw error;
    }
  });

test.each(["每个供货批取2件。", "样本不得少于4件。"])("leaves unclassified quantity %s pending with its exact source and a writable recovery route", (quantity) => {
    const markdown = ["## 4.2 材料复核", "### 主控项目", "4.2.1 材料性能应符合设计要求。", `检查数量：${quantity}`, "检验方法：核查报告。"].join("\n\n");
    const manifest = granularManifestFor(markdown);
    const registry = registryWithFullSourceSpans(manifest.evidence_fingerprint, manifest.evidence.map(record => ({
      source_id: record.evidence_id, evidence_id: record.evidence_id, atom_id: record.evidence_id, text: record.text,
    })));
    const prefilled = prefillTargetSelectorsFromLedger({ ledger: scanDocumentLedger(markdown, "quantity-review.md"), markdown, manifest, registry, start_line: 1, end_exclusive_line: markdown.split("\n").length + 1 });
    const item = prefilled.selectors.items[0]!;
    expect(item.sampling).toMatchObject({ status: "pending", confidence: 0 });
    // The author names the unverified candidate independently of sampling.
    item.name = "材料性能";
    const preserved = structuredClone(item);
    const quantitySpan = prefilled.registry.spans.find(span => span.span_id === item.fields.quantity.span_ids[0])!;
    const evidence = manifest.evidence.find(entry => entry.evidence_id === quantitySpan.evidence_id)!;
    expect(evidence.text.slice(quantitySpan.start, quantitySpan.end)).toContain(quantity);
    try {
      compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest);
      throw new Error("Unreviewed sampling must not compile");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetSelectorCompileError);
      expect((error as TargetSelectorCompileError).issues).toContainEqual(expect.objectContaining({
        code: "selector_sampling_decision_pending", path: "/items/0/sampling/status",
        details: expect.objectContaining({
          writable_record_key: item.key, writable_path: "/items/0/sampling",
          next_tool: "read_target_selectors", next_tool_arguments: { collection: "items", key: item.key },
          save_tool: "stage_target_selector_draft",
        }),
      }));
    }
    // An author chooses the supported mode using the preserved source; the
    // prefill does not infer it from a new vocabulary or modify business fields.
    item.sampling = { ...item.sampling, status: "explicit", quantity_span_ids: item.fields.quantity.span_ids,
      script_span_ids: item.fields.quantity.span_ids, reason: "已核对本地数量来源并选择直接数量。", confidence: 1 };
    expect(() => compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest)).not.toThrow();
    expect({ ...item, sampling: preserved.sampling }).toEqual(preserved);
  });

test("builds source-complete candidates per 检查数量 clause that compile after authored naming", () => {
    const markdown = SAMPLE.split("## 7.2")[0]!.trim();
    const ledger = scanDocumentLedger(markdown, "ledger-prefill.md");
    const manifest = manifestFor(markdown);
    const registry = registryWithFullSourceSpans(
      manifest.evidence_fingerprint,
      manifest.evidence.map((record) => ({
        source_id: record.evidence_id,
        evidence_id: record.evidence_id,
        atom_id: record.evidence_id,
        text: record.text,
      })),
    );
    const prefilled = prefillTargetSelectorsFromLedger({
      ledger,
      markdown,
      manifest,
      registry,
      start_line: 1,
      end_exclusive_line: markdown.split("\n").length + 1,
    });
    expect(prefilled.clause_item_count).toBe(2);
    expect(prefilled.table_item_count).toBe(0);
    expect(prefilled.selectors.items.map((item) => item.key)).toEqual([
      "ledger-clause:4.2.1",
      "ledger-clause:4.2.3",
    ]);
    expect(prefilled.selectors.items[0]?.sampling.status).toBe("explicit");
    expect(prefilled.selectors.items[1]?.sampling.status).toBe("explicit");
    prefilled.selectors.items[0]!.name = "铝合金材料品种、规格及性能";
    prefilled.selectors.items[1]!.name = "铝合金材料外观";
    expect(() => compileTargetSelectors(prefilled.selectors, prefilled.registry, manifest)).not.toThrow();
  });
});
