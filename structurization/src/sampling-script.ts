import { isDirectFullInspectionQuantity } from "./acceptance-delivery-contract.js";

const number = String.raw`(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)`;
const unit = "(?:点|处|根|件|块|孔|座|套|个|台|道)";
const minimum = `(?:且)?(?:取样)?(?:不少于|至少)${number}${unit}`;
const allBelow = `(?:少于|不足)${number}按全`;
const interval = `每${number}(?:m|m²|m³)取(?:样)?${number}(?:点|处)`;
const patterns = [
  "全|灰显|方案[ⅠⅡ]",
  `永远${number}`,
  `抽查${number}%`,
  `每1(?:座|个系统|构件)${number}(?:点|处|件)`,
  `(?:抽查)?${number}%,${minimum}(?:,${allBelow}|,少于取${number})?`,
  `抽查${number}%,${allBelow}`,
  `${interval}(?:,${minimum}(?:,${allBelow})?)?`,
  `每${number}m取${number}点,不足${number}取${number}点`,
  `每${number}m³取样${number}处,${number}m³以下,取样不少于${number}处,(?:${allBelow}|少于取${number})`,
  `抽查${number}%\\*${number}点`,
  `每构件（每类抽查${number}%且不少于${number}块）,每构件${number}点(?:,${allBelow})?`,
  `每种${number}件,且不少于${number}件`,
  `表\\d+(?:\\.\\d+){2}(?:,${number}倍|,至少${number}处(?:,${allBelow})?)?`,
  `${number}孔及以下按全,${number}孔至${number}孔抽试${number}孔,${number}孔以上每增加${number}孔多抽试${number}孔`,
  `至少${number}处,${allBelow}`,
].map((pattern) => new RegExp(`^(?:${pattern})$`, "u"));

export type SamplingScriptCategory = "主控项目" | "一般项目" | "all_items";

export type SamplingScriptStatus =
  | "explicit"
  | "reference"
  | "reference_unspecified_quantity"
  | "fallback"
  | "not_sampling";

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, "").replace(/，/gu, ",")
    .replace(/％/gu, "%").replace(/\(/gu, "（").replace(/\)/gu, "）")
    .replace(/m(?:\^3|3)/gu, "m³").replace(/m(?:\^2|2)/gu, "m²")
    .replace(/[。；;]$/u, "");
}

function sourceText(value: string): string {
  return normalized(value)
    .replace(/^\d+(?:\.\d+)*(?:-\d+)?[:：]/u, "")
    .replace(/^(?:检查|检验|检测|抽样|抽检|抽查)数量[:：]?/u, "");
}

function categoryFullInspectionAlias(value: string, category?: SamplingScriptCategory): string {
  if (!category || /(?:不|无需|免于)(?:进行)?全验/u.test(value)) return "";
  if (category === "主控项目" && /(?:各分项工程中的)?主控项目(?:均|应)?(?:进行)?全验/u.test(value)) return "全";
  if (category === "一般项目" && /(?:各分项工程中的)?一般项目(?:均|应)?(?:进行)?全验/u.test(value)) return "全";
  if (category === "all_items" && /(?:所有|全部|各)(?:分项工程中的)?项目(?:均|应)?(?:进行)?全验/u.test(value)) return "全";
  return "";
}

function derivedAlias(value: string, category?: SamplingScriptCategory): string {
  const categoryFullInspection = categoryFullInspectionAlias(value, category);
  if (categoryFullInspection) return categoryFullInspection;

  const plan = value.match(/^(?:按)?(?:方案([ⅠⅡ])|([ⅠⅡ])方案)(?:执行|进行)?$/u);
  if (plan) return `方案${plan[1] ?? plan[2]}`;

  const directTable = value.match(/^(?:按|按照|见)?表(\d+(?:\.\d+){2})(?:的?(?:规定|要求))?(?:执行|确定)?$/u);
  if (directTable) return `表${directTable[1]}`;
  const tableRequirement = value.match(/^(?:最小)?抽样数量(?:应)?(?:符合|按照|按)表(\d+(?:\.\d+){2})(?:的)?(?:规定|要求)$/u);
  if (tableRequirement) return `表${tableRequirement[1]}`;

  const fixed = value.match(new RegExp(
    `^(?:按)?(?:每检验批)?(?:抽查|抽检|检查|检验|检测|取样)(?:(?:不应|不得|应)?少于|不少于|至少)?(${number})${unit}$`,
    "u",
  ));
  if (fixed) return `永远${fixed[1]}`;

  const candidate = value
    .replace(new RegExp(`^.*?(?:抽查|抽检)(?:总数|数量)?的?(${number})%`, "u"), "抽查$1%")
    .replace(new RegExp(`每(${number})(m|m²|m³)(?:应)?(?:抽查|抽检|检查|检验|取样|取)(${number})(点|处)`, "gu"), "每$1$2取$3$4")
    .replace(new RegExp(`每(?:一|1)(座|个系统|构件)(?:应)?(?:抽查|抽检|检查|检验)?(${number})(点|处|件)`, "gu"), "每1$1$2$3")
    .replace(new RegExp(`每(种)(?:应)?(?:抽查|抽检|检查|检验)?(${number})件`, "gu"), "每$1$2件")
    .replace(new RegExp(`^按[^,%]*?(?=抽查${number}%)`, "u"), "")
    .replace(/(?:并|且)(?:应)?(?:各)?(?:不应|不得)少于/gu, "且不少于")
    .replace(new RegExp(`(?:少于|不足)(${number})${unit}?(?:时)?(?:应)?(?:按)?(?:全部|全数)检查`, "gu"), "少于$1按全")
    .replace(/^每一(?=座|个系统|构件)/u, "每1");
  return supportedSamplingScript(candidate);
}

export function supportedSamplingScript(value: unknown): string {
  if (typeof value !== "string" || /\d\s+\d/u.test(value)) return "";
  const script = normalized(value);
  if (!patterns.some((pattern) => pattern.test(script))) return "";
  if ([...script.matchAll(/(\d+(?:\.\d+)?)%/gu)].some((match) => Number(match[1]) > 100)) return "";
  return script.replace(/,/gu, "，");
}

function conditionLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const label = value.trim().replace(/\s+/gu, " ");
  return label && !/[\r\n:：]/u.test(label) ? label : "";
}

export function supportedSamplingScriptValue(value: unknown): string {
  const single = supportedSamplingScript(value);
  if (single) return single;
  if (typeof value !== "string") return "";
  const lines = value.split(/\r?\n/u);
  if (lines.length < 2 || lines.some((line) => !line.trim())) return "";
  const labels = new Set<string>();
  const normalizedLines: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf("：");
    if (separator <= 0) return "";
    const label = conditionLabel(line.slice(0, separator));
    const script = supportedSamplingScript(line.slice(separator + 1));
    if (!label || !script || labels.has(label)) return "";
    labels.add(label);
    normalizedLines.push(`${label}：${script}`);
  }
  return normalizedLines.join("\n");
}

export function composeSamplingScript(
  branches: readonly { script: unknown; conditions: readonly string[] }[],
): string {
  if (branches.length === 0) return "";
  if (branches.length === 1) return supportedSamplingScript(branches[0]!.script);
  const lines: string[] = [];
  for (const branch of branches) {
    const script = supportedSamplingScript(branch.script);
    const labels = [...new Set(branch.conditions.map(conditionLabel).filter(Boolean))];
    if (!script || labels.length === 0) return "";
    lines.push(`${labels.join("、")}：${script}`);
  }
  return supportedSamplingScriptValue(lines.join("\n"));
}

export function samplingScriptForStatus(status: SamplingScriptStatus, value: unknown): string {
  if (status === "not_sampling" || status === "fallback") return "灰显";
  if (status === "reference_unspecified_quantity") return "";
  return supportedSamplingScriptValue(value);
}

export function samplingConfidenceForStatus(status: SamplingScriptStatus, value: unknown): number {
  if (status === "not_sampling") return 1;
  if (status === "fallback") return 0;
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
}

export function deriveSamplingScript(
  quantity: string,
  basis: string,
  conditions: string | readonly string[] = [],
  category?: SamplingScriptCategory,
): string {
  if (/\d\s+\d/u.test(quantity) || /\d\s+\d/u.test(basis)) return "";
  const quantityText = sourceText(quantity);
  const basisText = sourceText(basis);
  if (isDirectFullInspectionQuantity(quantity) && isDirectFullInspectionQuantity(basis)) return "全";
  if (!quantityText || !basisText) return "";
  if (!quantityText.includes(basisText) && !basisText.includes(quantityText)) return "";
  const completeText = quantityText.length >= basisText.length ? quantityText : basisText;
  const conditionTexts = typeof conditions === "string" ? [conditions] : conditions;
  if (conditionTexts.some((condition) => {
    const text = sourceText(condition);
    return text && !completeText.includes(text);
  })) return "";
  return supportedSamplingScript(completeText) || derivedAlias(completeText, category);
}
