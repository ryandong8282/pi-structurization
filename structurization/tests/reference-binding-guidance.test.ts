import { describe, expect, test } from "vitest";
import { TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA } from "../src/target-selector-compiler.js";

describe("model-facing reference binding guidance", () => {
  test("distinguishes citation anchors, literal-bearing fields and import destinations", () => {
    const schema = JSON.stringify(TARGET_SELECTOR_TOOL_DRAFT_PATCH_JSON_SCHEMA);
    expect(schema).toContain("引用原话在原始文档中的位置");
    expect(schema).toContain("不表示该字段的判据来自这次引用");
    expect(schema).toContain("即内容导入位置");
    expect(schema).toContain("不要虚填 origin_binding");
    expect(schema).toContain("通过 preflight 确认");
    expect(schema).toContain("不要删除必要条件");
    expect(schema).toContain("reference_placeholder 的 destinations 必须为空");
  });
});
