export type DominantSourceLanguage = "han" | "latin" | "undetermined";

export interface SourceLanguageStats {
  han_characters: number;
  latin_characters: number;
}

export interface SourceLanguageMismatch {
  source_language: Exclude<DominantSourceLanguage, "undetermined">;
  authored_language: Exclude<DominantSourceLanguage, "undetermined">;
  source_stats: SourceLanguageStats;
  authored_stats: SourceLanguageStats;
}

function visibleNaturalText(value: string): string {
  return value
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/\$[^$]*\$/gu, " ")
    .replace(/\\\([\s\S]*?\\\)/gu, " ")
    .replace(/\\\[[\s\S]*?\\\]/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&[A-Za-z0-9#]+;/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ");
}

export function sourceLanguageStats(value: string): SourceLanguageStats {
  const visible = visibleNaturalText(value);
  return {
    han_characters: visible.match(/\p{Script=Han}/gu)?.length ?? 0,
    latin_characters: visible.match(/\p{Script=Latin}/gu)?.length ?? 0,
  };
}

export function dominantSourceLanguage(values: readonly string[]): DominantSourceLanguage {
  const stats = sourceLanguageStats(values.join("\n"));
  if (stats.han_characters >= 6 && stats.han_characters > stats.latin_characters) return "han";
  if (stats.latin_characters >= 6 && stats.latin_characters > stats.han_characters) return "latin";
  return "undetermined";
}

/**
 * Rejects a full prose translation while preserving short source tokens such as
 * GB 50576, H/1500, alloy grades, model numbers, and genuinely mixed evidence.
 */
export function sourceLanguageMismatch(
  authoredValue: string,
  evidenceValues: readonly string[],
): SourceLanguageMismatch | undefined {
  const sourceLanguage = dominantSourceLanguage(evidenceValues);
  if (sourceLanguage === "undetermined") return undefined;
  const sourceStats = sourceLanguageStats(evidenceValues.join("\n"));
  const authoredStats = sourceLanguageStats(authoredValue);
  if (
    sourceLanguage === "han"
    && authoredStats.han_characters === 0
    && authoredStats.latin_characters >= 4
  ) {
    return {
      source_language: "han",
      authored_language: "latin",
      source_stats: sourceStats,
      authored_stats: authoredStats,
    };
  }
  if (
    sourceLanguage === "latin"
    && authoredStats.latin_characters === 0
    && authoredStats.han_characters >= 2
  ) {
    return {
      source_language: "latin",
      authored_language: "han",
      source_stats: sourceStats,
      authored_stats: authoredStats,
    };
  }
  return undefined;
}
