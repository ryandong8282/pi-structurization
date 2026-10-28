import { describe, expect, test } from "vitest";
import {
  composeSamplingScript,
  deriveSamplingScript,
  samplingConfidenceForStatus,
  samplingScriptForStatus,
  supportedSamplingScript,
  supportedSamplingScriptValue,
} from "../src/sampling-script.js";

const examples = [
  "全", "灰显", "永远10", "抽查50%", "每1座4点",
  "10%，且不少于10处，少于10按全", "抽查1%，且不少于3根",
  "5%，取样不少于3处，少于取3", "抽查50%，少于20按全",
  "每20m取1点，不少于5处，少于5按全",
  "每500m³取样5处，500m³以下，取样不少于3处，少于3按全",
  "每20m取1点，且不少于5处", "每50m取3点，不足50取2点",
  "每500m³取样5处，500m³以下，取样不少于3处，少于取3", "抽查30%*2点",
  "每构件（每类抽查10%且不少于5块），每构件2点，少于5按全",
  "每构件（每类抽查10%且不少于5块），每构件2点", "每种3件，且不少于3件",
  "表3.0.9", "表3.0.9，2倍",
  "2孔及以下按全，3孔至6孔抽试2孔，6孔以上每增加5孔多抽试1孔",
  "至少3处，不足3按全", "方案Ⅱ", "表3.4.4", "表3.0.9，至少5处", "方案Ⅰ",
  "表3.0.9，至少5处，少于5按全",
];

describe("restricted sampling script", () => {
  test.each(examples)("derives and retains supported template: %s", (script) => {
    expect(supportedSamplingScript(script)).toBe(script);
    const evidence = `检查数量：${script}。`;
    expect(deriveSamplingScript(evidence, evidence)).toBe(script);
  });
  test.each(["全验", "全数检查。", "检查数量：全部检验。"])("derives full inspection: %s", (source) => {
    expect(deriveSamplingScript(source, source)).toBe("全");
  });
  test.each(["按抽样检验方案确定", "原文未规定具体数量", "一般项目应抽验", "方案Ⅰ/Ⅱ", "按表执行", "必要时全数检查", "抽查101%", "抽查0%", "抽查1 0%", "抽查50%，必要时复验", ""])("rejects unsupported or ambiguous evidence: %s", (source) => {
    expect(deriveSamplingScript(source, source)).toBe("");
    expect(supportedSamplingScript(source)).toBe("");
  });
  test("normalizes typography without changing values or inventing quantities", () => {
    expect(deriveSamplingScript("检查数量：抽查 12.5％,且不少于 7 根。", "抽查12.5%，且不少于7根")).toBe("抽查12.5%，且不少于7根");
    expect(supportedSamplingScript("每750m^3取样6处，750m3以下，取样不少于4处，少于取4")).toBe("每750m³取样6处，750m³以下，取样不少于4处，少于取4");
    expect(supportedSamplingScript("全数检查。")).toBe("");
    expect(deriveSamplingScript("抽查50%", "抽查50%，必要时复验")).toBe("");
    expect(deriveSamplingScript("抽查50%", "抽查50%", "必要时复验")).toBe("");
    expect(deriveSamplingScript("全数检查", "观察检查")).toBe("");
  });
  test("derives safe aliases from source wording", () => {
    expect(deriveSamplingScript("抽检数量：每检验批抽查不应少于5处。", "抽检数量：每检验批抽查不应少于5处。")).toBe("永远5");
    expect(deriveSamplingScript("4.3.1-3：检验数量：按Ⅱ方案。", "4.3.1-3：检验数量：按Ⅱ方案。")).toBe("方案Ⅱ");
    expect(deriveSamplingScript("最小抽样数量应符合表3.0.9的要求。", "最小抽样数量应符合表3.0.9的要求。")).toBe("表3.0.9");
    expect(deriveSamplingScript("按检验批抽查10%，且不得少于10处。", "按检验批抽查10%，且不得少于10处。")).toBe("抽查10%，且不少于10处");
    expect(deriveSamplingScript("在同一检验批内抽查总数的5%，且不应少于5处。", "在同一检验批内抽查总数的5%，且不应少于5处。")).toBe("抽查5%，且不少于5处");
    expect(deriveSamplingScript("每20m抽查1点，且不应少于5处。", "每20m抽查1点，且不应少于5处。")).toBe("每20m取1点，且不少于5处");
    expect(deriveSamplingScript("每一座抽查4点。", "每一座抽查4点。")).toBe("每1座4点");
  });
  test("derives category-scoped full inspection from source wording used by the current job", () => {
    expect(deriveSamplingScript("主控项目应进行全验", "主控项目应进行全验", [], "主控项目")).toBe("全");
    expect(deriveSamplingScript("主控项目全验", "主控项目全验", [], "主控项目")).toBe("全");
    expect(deriveSamplingScript("各分项工程中的主控项目应进行全验", "各分项工程中的主控项目应进行全验", [], "主控项目")).toBe("全");
    expect(deriveSamplingScript("主控项目全验和一般项目抽验", "主控项目全验和一般项目抽验", [], "主控项目")).toBe("全");
    expect(deriveSamplingScript("主控项目全验和一般项目抽验", "主控项目全验和一般项目抽验", [], "一般项目")).toBe("");
    expect(deriveSamplingScript("一般项目应进行抽验", "一般项目应进行抽验", [], "一般项目")).toBe("");
  });
  test("normalizes explicit no-sampling and uncertain fallback to gray with different confidence", () => {
    expect(samplingScriptForStatus("not_sampling", "")).toBe("灰显");
    expect(samplingConfidenceForStatus("not_sampling", 0.2)).toBe(1);
    expect(samplingScriptForStatus("fallback", "全")).toBe("灰显");
    expect(samplingConfidenceForStatus("fallback", 0.9)).toBe(0);
    expect(samplingScriptForStatus("reference_unspecified_quantity", "灰显")).toBe("");
    expect(samplingConfidenceForStatus("reference_unspecified_quantity", 1)).toBe(1);
  });
  test("retains conditions represented by the restricted script", () => {
    const source = "抽查50%，少于20按全";
    expect(deriveSamplingScript(source, source, "少于20按全")).toBe(source);
    expect(deriveSamplingScript("抽查50%", source, "少于20按全")).toBe(source);
    expect(deriveSamplingScript("抽查50%", "抽查50%", "少于20按全")).toBe("");
  });
  test("serializes multiple work conditions as independently validated lines", () => {
    const script = [
      "大开挖基础：表3.0.9",
      "独立基础：每1座4点",
      "基槽：抽查5%",
    ].join("\n");
    expect(composeSamplingScript([
      { conditions: ["大开挖基础"], script: "表3.0.9" },
      { conditions: ["独立基础"], script: "每1座4点" },
      { conditions: ["基槽"], script: "抽查5%" },
    ])).toBe(script);
    expect(supportedSamplingScriptValue(script)).toBe(script);
    expect(supportedSamplingScript(script)).toBe("");
  });
  test("rejects incomplete or ambiguous multi-condition scripts", () => {
    expect(composeSamplingScript([
      { conditions: ["大开挖基础"], script: "表3.0.9" },
      { conditions: [], script: "抽查5%" },
    ])).toBe("");
    expect(composeSamplingScript([
      { conditions: ["基槽"], script: "抽查5%" },
      { conditions: ["基槽"], script: "抽查10%" },
    ])).toBe("");
    expect(supportedSamplingScriptValue("大开挖基础：表3.0.9\n基槽：原文未规定具体数量")).toBe("");
  });
});
