import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CatalogReviewRuntimeController } from "../src/catalog-review-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "catalog-review-"));
  roots.push(root);
  const controller = await CatalogReviewRuntimeController.create({
    workspaceRoot: root,
    runId: "run-1",
    anomalies: [{
      id: "issue-1",
      code: "cross_source_title_mismatch",
      severity: "error",
      message: "same code, different title",
      recordIds: ["master:m1", "forms:f1"],
      sourceRefs: [{ pageNumber: 3 }, { pageNumber: 8 }],
      details: { masterRecordId: "master:m1", formRecordId: "forms:f1" },
    }],
    records: [
      {
        recordId: "master:m1", candidateId: "master", sourceRole: "master_catalog", nodeType: "document",
        name: "工程开工令", rawName: "工程开工令", identifiers: { itemCode: "B1-13" }, path: [],
        sourceRefs: [{ pageNumber: 3 }], confidence: 1, reviewFlags: [],
      },
      {
        recordId: "forms:f1", candidateId: "forms", sourceRole: "form_collection", nodeType: "form",
        name: "经审查，本工程已具备开工条件", rawName: "经审查，本工程已具备开工条件", identifiers: { archiveNo: "B1-13" }, path: [],
        sourceRefs: [{ pageNumber: 8 }], confidence: 0.8, reviewFlags: [],
      },
    ],
    openPage: async (pageNumber) => ({ pageNumber, text: pageNumber === 8 ? "工程开工令" : "资料目录" }),
  });
  return { root, controller };
}

describe("catalog review runtime", () => {
  test.each([
    [[], "evidence_page_required", [3, 8], []],
    [[3, 8], "evidence_page_not_opened", [], []],
    [[3, 8, 9], "evidence_page_outside_anomaly", [], [9]],
  ])("reports actionable evidence page repair for %s", async (pages, error, missing, extra) => {
    const { controller } = await fixture();
    if (extra.length) {
      for (const page of pages) await controller.dispatch("open_catalog_page", { page_number: page });
    }
    expect(await controller.dispatch("record_catalog_decision", {
      anomaly_id: "issue-1", action: "replace_title", reason: "source comparison",
      evidence_pages: pages, replacement_title: "工程开工令",
    })).toMatchObject({
      ok: false, error,
      details: { actual: pages, required_pages: [3, 8], missing_pages: missing, extra_pages: extra, saved: false },
    });
    expect(controller.result().decisions).toEqual([]);
    expect(await controller.dispatch("get_catalog_review_contract", {})).toMatchObject({
      rules: expect.arrayContaining([expect.stringContaining("全部来源页")]),
    });
  });

  test("requires opened page evidence before accepting a bounded decision", async () => {
    const { controller } = await fixture();
    const blocked = await controller.dispatch("record_catalog_decision", {
      anomaly_id: "issue-1",
      action: "replace_title",
      reason: "page header proves the title",
      evidence_pages: [8],
      replacement_title: "工程开工令",
    });
    expect(blocked).toMatchObject({ ok: false, error: "evidence_page_not_opened" });

    await controller.dispatch("open_catalog_page", { page_number: 8 });
    const incomplete = await controller.dispatch("record_catalog_decision", {
      anomaly_id: "issue-1",
      action: "replace_title",
      reason: "page header proves the title",
      evidence_pages: [8],
      replacement_title: "工程开工令",
    });
    expect(incomplete).toMatchObject({
      ok: false, error: "all_affected_source_pages_required",
      details: {
        path: "/evidence_pages", actual: [8], required_pages: [3, 8], missing_pages: [3],
        unopened_pages: [3], saved: false,
        next_tool_calls: [{ tool: "open_catalog_page", arguments: { page_number: 3 } }],
      },
    });
    expect(controller.result().decisions).toEqual([]);
    await controller.dispatch("open_catalog_page", { page_number: 3 });
    const accepted = await controller.dispatch("record_catalog_decision", {
      anomaly_id: "issue-1", action: "replace_title", reason: "both source pages prove the title",
      evidence_pages: [3, 8], replacement_title: "工程开工令",
    });
    expect(accepted).toMatchObject({ ok: true });
    expect(await controller.dispatch("seal_catalog_review", {})).toMatchObject({ ok: true, decision_count: 1 });

    const persisted = JSON.parse(await readFile(controller.statePath, "utf8"));
    expect(persisted).toMatchObject({ sealed: true, anomaly_count: 1 });
    expect(persisted.opened_pages).toEqual([3, 8]);
  });

  test("rejects actions that cannot resolve the anomaly type", async () => {
    const { controller } = await fixture();
    await controller.dispatch("open_catalog_page", { page_number: 8 });
    const result = await controller.dispatch("record_catalog_decision", {
      anomaly_id: "issue-1",
      action: "accept_as_is",
      reason: "ignore it",
      evidence_pages: [8],
    });
    expect(result).toMatchObject({ ok: false, error: "action_not_allowed_for_anomaly" });
    expect(await controller.dispatch("seal_catalog_review", {})).toMatchObject({ ok: false, error: "catalog_review_incomplete" });
  });

  test("allows the agent to accept or replace a repeated form title after opening its page", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-review-repeat-"));
    roots.push(root);
    const controller = await CatalogReviewRuntimeController.create({
      workspaceRoot: root,
      runId: "run-repeat",
      anomalies: [{
        id: "repeat-1",
        code: "repeated_form_title",
        severity: "warning",
        message: "distinct forms share a candidate title",
        recordIds: ["forms:f1"],
        sourceRefs: [{ pageNumber: 12 }],
        details: { peerRecordIds: ["forms:f2"] },
      }],
      records: [{
        recordId: "forms:f1", candidateId: "forms", sourceRole: "form_collection", nodeType: "form",
        name: "相同候选标题", rawName: "相同候选标题", identifiers: { formIndexNo: "X.1.1" }, path: [],
        sourceRefs: [{ pageNumber: 12 }], confidence: 0.9, reviewFlags: [],
      }],
      openPage: async (pageNumber) => ({ pageNumber, text: "表 X.1.1 第一类质量验收记录" }),
    });

    await controller.dispatch("open_catalog_page", { page_number: 12 });
    expect(await controller.dispatch("record_catalog_decision", {
      anomaly_id: "repeat-1",
      action: "replace_title",
      reason: "page title block proves a longer title",
      evidence_pages: [12],
      replacement_title: "第一类质量验收记录",
    })).toMatchObject({ ok: true });
  });

  test("allows a split TOC entry to be replaced only after its source page is opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-review-toc-"));
    roots.push(root);
    const controller = await CatalogReviewRuntimeController.create({
      workspaceRoot: root,
      runId: "run-toc",
      anomalies: [{
        id: "toc-1",
        code: "incomplete_toc_entry",
        severity: "warning",
        message: "TOC entry has no parsed page tail",
        recordIds: ["toc:r1"],
        sourceRefs: [{ pageNumber: 3 }],
        details: { extractionFlag: "toc_target_page_missing" },
      }],
      records: [{
        recordId: "toc:r1", candidateId: "toc", sourceRole: "toc", nodeType: "document",
        name: "1 候选片段", rawName: "1 候选片段", identifiers: {}, path: [],
        sourceRefs: [{ pageNumber: 3 }], confidence: 0.78, reviewFlags: ["toc_target_page_missing"],
      }],
      openPage: async (pageNumber) => ({ pageNumber, text: "1 候选片段\n完整标题 ........ 1" }),
    });
    const decision = {
      anomaly_id: "toc-1",
      action: "replace_title",
      reason: "same-baseline page evidence completes the title",
      evidence_pages: [3],
      replacement_title: "1 完整目录标题",
    };

    expect(await controller.dispatch("record_catalog_decision", decision))
      .toMatchObject({ ok: false, error: "evidence_page_not_opened" });
    await controller.dispatch("open_catalog_page", { page_number: 3 });
    expect(await controller.dispatch("record_catalog_decision", decision)).toMatchObject({ ok: true });
  });
});
