import { describe, expect, test } from "vitest";

import { prettyJson } from "../src/canonical.js";
import {
  buildSelectorStageScenario,
  clauseRecord,
  fullSpanFor,
  itemRecord,
  seedPlan,
} from "./selector-stage-fixture.js";

describe("stage receipt echoes saved records", () => {
  test("stage_target_selector_draft returns the effective saved records with read keys", async () => {
    const { workspace, controller, manifest } = await buildSelectorStageScenario();
    const c11 = clauseRecord(manifest, "2.1.1");
    const c13 = clauseRecord(manifest, "2.1.3");
    expect(await controller.dispatch("open_evidence", { evidence_id: c11.evidence_id })).toMatchObject({ ok: true });
    expect(await controller.dispatch("open_evidence", { evidence_id: c13.evidence_id })).toMatchObject({ ok: true });
    const registry = await workspace.readSourceSpanRegistry();
    const span11 = fullSpanFor(registry, c11.evidence_id, c11.text.length);
    const span13 = fullSpanFor(registry, c13.evidence_id, c13.text.length);
    await workspace.writeWorkingSelectors(prettyJson(seedPlan(manifest, span13)));
    const staged = await controller.dispatch("stage_target_selector_draft", {
      operation: "upsert",
      draft: {
        items: [itemRecord(
          "item-2.1.1",
          "桩身承载力",
          "主控项目",
          span11,
          "数量条文以锚定条目承载归属。",
        )],
      },
    });
    const receipt = JSON.stringify(staged);
    expect(staged, receipt).toMatchObject({ ok: true });
    const saved = (staged as { saved_records?: Record<string, Array<{ key?: string; read_key?: string }>> }).saved_records;
    const items = saved?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("item-2.1.1");
    // 自带稳定 key 的集合不重复回传 read_key；source_dispositions（内容哈希读取键）才会附 read_key。
    expect(items[0]?.read_key).toBeUndefined();
    // 未涉及的记录不回传：避免大草稿下回条膨胀。
    expect((saved?.items ?? []).find(row => row.key === "item-2.1.3")).toBeUndefined();
  });
});
