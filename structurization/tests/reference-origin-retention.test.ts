import { expect, test } from "vitest";
import { retainsCompleteReferenceUnit } from "../src/validator.js";

const first = "甲部件的安装应符合第 2.1.1 条的规定";
const second = "乙部件的安装应符合第 2.1.2 条的规定";
const refs = ["第 2.1.1 条", "第 2.1.2 条"];
const origin = `4.1.1 ${first}；${second}。`;

test("retains a complete parallel forwarder without importing its sibling object", () => {
  expect(retainsCompleteReferenceUnit(origin, [first], refs[0]!, refs)).toBe(true);
  expect(retainsCompleteReferenceUnit(origin, [second], refs[1]!, refs)).toBe(true);
});

test.each([
  [refs[0]!],
  ["应符合第 2.1.1 条的规定"],
  ["甲部件的安装"],
  [second],
  ["甲部件的安装应符合第 2.1.3 条的规定"],
].map(fragments => ({ fragments })))("does not treat partial or unrelated fragments $fragments as the complete origin", ({ fragments }) => {
  expect(retainsCompleteReferenceUnit(origin, fragments, refs[0]!, refs)).toBe(false);
});

test.each([
  `4.1.1 甲部件不得有裂纹。${second}。`,
  `4.1.1 甲部件不得有裂纹；${second}。`,
  `4.1.1 ${second}。甲部件不得有裂纹。`,
  `4.1.1 甲部件的尺寸应符合第2.1.1条的有关规定；${second}。`,
])("retains the complete current reference in a mixed paragraph: %s", (mixed) => {
  expect(retainsCompleteReferenceUnit(mixed, [second], refs[1]!, refs)).toBe(true);
});

test("retains a complete conditional forwarder without importing another independent requirement", () => {
  const conditional = `固定件穿过乙构件时，${second}`;
  const mixed = `4.1.1 甲部件应采用耐水材料。${conditional}。`;
  expect(retainsCompleteReferenceUnit(mixed, [conditional], refs[1]!, refs)).toBe(true);
  expect(retainsCompleteReferenceUnit(mixed, [second], refs[1]!, refs)).toBe(false);
});

test("does not drop a local condition or an explicit introduction shared across clauses", () => {
  expect(retainsCompleteReferenceUnit(`4.1.1 潮湿时，${first}；${second}。`, [first], refs[0]!, refs)).toBe(false);
  const shared = `4.1.1 潮湿时：${first}；${second}。`;
  expect(retainsCompleteReferenceUnit(shared, [second], refs[1]!, refs)).toBe(false);
  expect(retainsCompleteReferenceUnit(shared, ["潮湿时：", second], refs[1]!, refs)).toBe(true);
});

test("rejects repeated reference occurrences and unregistered current citations", () => {
  expect(retainsCompleteReferenceUnit(`4.1.1 ${first}；${first}。`, [first], refs[0]!, refs)).toBe(false);
  expect(retainsCompleteReferenceUnit(`4.1.1 ${first}和${refs[0]}。`, [first], refs[0]!, refs)).toBe(false);
  expect(retainsCompleteReferenceUnit(origin, [first], refs[0]!, [refs[1]!])).toBe(false);
  expect(retainsCompleteReferenceUnit(origin, [first], "", refs)).toBe(false);
});


test("retains an exact forwarding unit split across visible fields without dropping conditions", () => {
  expect(retainsCompleteReferenceUnit(origin, ["甲部件的安装", "应符合第 2.1.1 条的规定"], refs[0]!, refs)).toBe(true);
  const conditional = `潮湿时，${first}`;
  expect(retainsCompleteReferenceUnit(conditional, ["甲部件的安装", "应符合第 2.1.1 条的规定"], refs[0]!, refs)).toBe(false);
  expect(retainsCompleteReferenceUnit(conditional, ["潮湿时，甲部件的安装", "应符合第 2.1.1 条的规定"], refs[0]!, refs)).toBe(true);
  expect(retainsCompleteReferenceUnit(origin, ["甲部件", "应符合第 2.1.1 条的规定"], refs[0]!, refs)).toBe(false);
});
