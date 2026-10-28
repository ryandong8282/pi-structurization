import { describe, expect, test } from "vitest";
import { applyJsonPatch } from "../src/json-patch.js";

describe("json patch 指针错误自带恢复现场", () => {
  test("数组索引越界时报出当前数组长度与索引漂移提示", () => {
    const document = { targets: [{ key: "a" }, { key: "b" }] };
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/targets/5/key", value: "c" }]))
      .toThrow(/Invalid array path segment 5 \(array length 2\)/);
    expect(() => applyJsonPatch(document, [{ op: "remove", path: "/targets/0" }, { op: "remove", path: "/targets/1" }]))
      .toThrow(/Invalid array index 1 \(array length 1\)/);
  });

  test("对象指针不存在时列出当前层可用字段", () => {
    const document = { targets: [{ key: "a", name: "目标" }] };
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/targets/0/rationale", value: "x" }]))
      .toThrow(/JSON pointer does not exist: \/targets\/0\/rationale \(当前层可用字段: key, name\)/);
  });

  test("追加数组仍然接受 - 并保留原有语义", () => {
    const document = { contexts: [{ key: "c0" }] };
    const patched = applyJsonPatch(document, [{ op: "add", path: "/contexts/-", value: { key: "c1" } }]);
    expect((patched as { contexts: Array<{ key: string }> }).contexts.map(entry => entry.key)).toEqual(["c0", "c1"]);
  });
});
