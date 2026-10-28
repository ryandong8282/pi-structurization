import { describe, expect, test } from "vitest";
import { TARGET_SELECTOR_ITEM_JSON_SCHEMA, TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA } from "../src/target-selector-compiler.js";

describe("model-facing acceptance branch guidance", () => {
  test("acceptance_branches schema tells the model to omit the field instead of submitting an empty array", () => {
    const schema = JSON.stringify(TARGET_SELECTOR_ITEM_JSON_SCHEMA);
    // minItems:2 rejects []; the receipt echoes this description, so it must carry the fix.
    expect(schema).toContain("仅当同一维度确实存在至少两个互斥分支时才提交本字段");
    expect(schema).toContain("必须整体省略本字段");
    expect(schema).toContain("不要提交空数组");
    const draftSchema = JSON.stringify(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    expect(draftSchema).toContain("不要提交空数组");
  });
});
