const MATH_COMMANDS: Readonly<Record<string, string>> = {
  "\\leqslant": "≤",
  "\\geqslant": "≥",
  "\\pm": "±",
  "\\sim": "～",
  "\\circ": "°",
};

const FINAL_DISPLAY_MATH_COMMANDS: Readonly<Record<string, string>> = {
  ...MATH_COMMANDS,
  "\\mu": "μ",
  "\\Delta": "Δ",
  "\\sum": "∑",
};

const FINAL_DISPLAY_MATH_COMMAND_PATTERN = /\\(?:leqslant|geqslant|pm|sim|circ|mu|Delta|sum)(?![A-Za-z])/g;

const SUBSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
};

const SUPERSCRIPT_CHARACTERS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻",
};

const SUBSCRIPT_LETTERS: Readonly<Record<string, string>> = {
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

function subscriptDigits(value: string): string {
  return [...value].map((digit) => SUBSCRIPT_DIGITS[digit] ?? digit).join("");
}

function subscriptLetter(value: string): string {
  return SUBSCRIPT_LETTERS[value] ?? `_${value}`;
}

function normalizeMathExpression(expression: string): string | null {
  let normalized = expression;
  // MinerU commonly keeps plain units and labels inside TeX text groups. This
  // is display-only normalization: unwrap only a flat, command-free payload so
  // an unknown or nested TeX expression still falls through intact below.
  normalized = normalized.replace(/\\text\s*\{([^{}\\]*)\}/g, "$1");
  for (const [command, symbol] of Object.entries(MATH_COMMANDS)) {
    normalized = normalized.replaceAll(command, symbol);
  }
  normalized = normalized.replaceAll("\\%", "%");
  if (/\\[A-Za-z]+/.test(normalized)) {
    return null;
  }
  normalized = normalized
    .replace(/\^\{°\}/g, "°")
    .replace(/_\{(\d+)\}/g, (_match, digits: string) => subscriptDigits(digits))
    .replace(/_(\d+)/g, (_match, digits: string) => subscriptDigits(digits))
    .replace(/\s*([≤≥±～])\s*/g, "$1")
    .trim();
  return normalized;
}

function normalizeFinalDisplayMathExpression(expression: string, inlineMath = false): string | null {
  let normalized = expression
    .replace(/\\underline\s*\{\s*\\text\s*\{([^{}\\]*)\}\s*\}/g, "$1")
    .replace(/\\underline\s*\{([^{}\\]*)\}/g, "$1")
    .replace(/\\text\s*\{([^{}\\]*)\}/g, "$1")
    .replace(/_\{\\mathrm\s*\{([A-Za-z])\}\}/g, (_match, letter: string) => subscriptLetter(letter))
    .replace(/\\mathrm\s*\{([^{}\\]*)\}/g, (_match, unit: string) => unit.trim())
    .replace(FINAL_DISPLAY_MATH_COMMAND_PATTERN, (command) => FINAL_DISPLAY_MATH_COMMANDS[command] ?? command)
    .replaceAll("\\%", "%");
  if (/\\[A-Za-z]+/.test(normalized)) {
    return null;
  }
  // TeX ignores spaces between math digits; prose outside $...$ may use them
  // to separate real values, so only join digits from an explicit math span.
  if (inlineMath) normalized = normalized.replace(/(\d)\s+(?=\d)/g, "$1");
  normalized = normalized
    .replace(/\^\{°\}/g, "°")
    .replace(/\s*\^\s*\{\s*([+-]?\d+)\s*\}/g, (_match, exponent: string) =>
      [...exponent].map(character => SUPERSCRIPT_CHARACTERS[character]).join(""))
    .replace(/\^(\d)/g, (_match, digit: string) => SUPERSCRIPT_CHARACTERS[digit]!)
    .replace(/_\{(\d+)\}/g, (_match, digits: string) => subscriptDigits(digits))
    .replace(/_(\d+)/g, (_match, digits: string) => subscriptDigits(digits))
    .replace(/_\{([A-Za-z])\}/g, (_match, letter: string) => subscriptLetter(letter))
    .replace(/\s*([≤≥±～∑])\s*/g, "$1")
    .trim();
  return normalized;
}

function decodeNumericHtmlEntities(value: string): string {
  return value.replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (source, hex: string | undefined, decimal: string | undefined) => {
    const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return source;
    }
    return String.fromCodePoint(codePoint);
  });
}

function normalizeDisplaySpacing(value: string): string {
  return value
    .replace(/([A-Za-z0-9)%])\s+([<>≤≥±～])/g, "$1$2")
    .replace(/([<>≤≥±～])\s+/g, "$1");
}

function normalizeFinalDisplaySpacing(value: string): string {
  return normalizeDisplaySpacing(value)
    .replace(/\s*∑\s*/g, "∑")
    .replace(/μ\s+m\b/g, "μm");
}

function normalizeInlineMathWith(
  value: string,
  normalizeExpression: (expression: string) => string | null,
  normalizeSpacing: (value: string) => string,
): string {
  const displayValue = decodeNumericHtmlEntities(value);
  if (!displayValue.includes("$")) {
    return displayValue;
  }
  let changed = false;
  const normalized = displayValue.replace(
    /\$([^$]+)\$/g,
    (source, expression: string) => {
      const replacement = normalizeExpression(expression);
      if (replacement === null) {
        return source;
      }
      changed = true;
      return replacement;
    },
  );
  return changed ? normalizeSpacing(normalized) : displayValue;
}

/** Narrow comparison-only normalization for OCR/entity glyph presentation. */
export function canonicalizeSourceGlyphsForComparison(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decodeNumericHtmlEntities(decoded.replace(/&amp;/giu, "&"));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/[\u0027\u2019\u2032\uff07]/gu, "'");
}

/** Convert the safe MinerU inline-math subset into plain Unicode for display. */
export function normalizeMineruInlineMath(value: string): string {
  return normalizeInlineMathWith(value, normalizeMathExpression, normalizeDisplaySpacing);
}

/**
 * Final UI projection for legacy aggregates which already lost MinerU's
 * `$...$` wrappers. This is intentionally not used by semantic materializers:
 * unknown or nested TeX keeps the complete original string unchanged.
 */
export function normalizeMineruDisplayText(value: string): string {
  const inline = normalizeInlineMathWith(
    value,
    (expression) => normalizeFinalDisplayMathExpression(expression, true),
    normalizeFinalDisplaySpacing,
  );
  const hasSafeCommand = /\\(?:leqslant|geqslant|pm|sim|circ|mu|Delta|sum|text|underline|mathrm)(?![A-Za-z])|\\%/u.test(inline);
  const hasSafeSimpleSubscript = /[A-Za-z\u0370-\u03ff]_\{(?:[A-Za-z]|\d+)\}/u.test(inline);
  if (inline.includes("$") || (!hasSafeCommand && !hasSafeSimpleSubscript)) {
    return inline;
  }
  const replacement = normalizeFinalDisplayMathExpression(inline);
  return replacement === null ? inline : normalizeFinalDisplaySpacing(replacement);
}

/**
 * 并拢排版为对齐而在汉字之间撑开的空白（`驱 动 主 机` → `驱动主机`）。
 *
 * 国标里两三个字的小节标题常被排成等宽拉开，OCR 原样带出这些空格：语料 22 份里
 * 有 132 处编号标题是这个形态（`总 则`、`降 排 水`、`挡 土 墙`、`液 压 系 统`）。
 * 检验批名取自这些标题，不并拢就会跟金标逐字对不上。
 *
 * 判据是「空白两侧都是汉字」，不是「名称里有空白」——中文不用空格分词，
 * 两个汉字之间的空白只可能是排版产物；而 `GB 50300`、`10 mm`、`第 4.2 节`
 * 里的空白至少有一侧不是汉字，一律不动。
 *
 * 紧贴汉字排版的括号顿号之类（`对 重 (平 衡 重 )`）与汉字同属被拉开的一串，
 * 但只有另一侧确实是汉字时才并——`GB 50300 (2013)` 的括号两侧都不是汉字，不动。
 */
const HAN_ADJACENT_PUNCTUATION = "（）()【】《》「」〔〕、，。：；·";
const HAN_TYPESETTING_SPACING = [
  new RegExp(`([一-鿿])[ \t　]+([一-鿿${HAN_ADJACENT_PUNCTUATION}])`, "g"),
  new RegExp(`([${HAN_ADJACENT_PUNCTUATION}])[ \t　]+([一-鿿])`, "g"),
];

export function collapseHanTypesettingSpacing(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    // 逐轮替换：`总 则 书` 这类连续拉开的形态里，相邻两处共用中间那个字符，
    // 一次全局替换只能消掉其中一半。
    for (const pattern of HAN_TYPESETTING_SPACING) result = result.replace(pattern, "$1$2");
  } while (result !== previous);
  return result;
}
// A joined Chinese body may start a numbered unit; a bare citation-unit suffix
// such as number+条的 must remain a reference fragment, not a new clause.
export const NUMBERED_PROSE_BOUNDARY = String.raw`(?:\s+|(?=(?![章节条款](?:的|[。；;，,]|$))\p{Script=Han}))`;
