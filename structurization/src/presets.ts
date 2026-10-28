export interface PdfExCodePreset {
  preset: string;
  providerId: string;
  modelId: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  apiKey: string;
  extraBodyJson: string;
  serviceTier: "" | "priority";
  thinkingFormat: "" | "qwen" | "zai" | "deepseek";
  supportsReasoningEffort: boolean;
  supportsDeveloperRole: boolean;
  reasoningEffort: "" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxTokensField: "" | "max_tokens" | "max_completion_tokens";
}
export const PI_AGENT_MODEL_STAGES = [
  "discovery",
  "discovery_review",
  "target_extraction",
  "coverage_review",
  "hierarchy",
] as const;

export type PiAgentModelStage = typeof PI_AGENT_MODEL_STAGES[number];
export type PiAgentApiType = "openai" | "anthropic";
export type PiAgentAuthMode = "api_key" | "chatgpt";
export type PiAgentEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiAgentModelSettings {
  /** Missing in saved legacy settings means API key authentication. */
  authMode?: PiAgentAuthMode;
  apiType: PiAgentApiType;
  endpoint: string;
  apiKey: string;
  model: string;
  effort: PiAgentEffort;
}

export interface PiAgentRuntimeModelConfig {
  stages: Record<PiAgentModelStage, PiAgentModelSettings>;
  /** Server-owned shared OAuth store; never copied into a job workspace. */
  subscriptionAuthPath?: string;
}

interface ProtocolPreset {
  api: PdfExCodePreset["api"];
  toolChoice?: "auto";
  defaultEffort?: "low";
  supportsReasoningEffort: boolean;
  supportsDeveloperRole: boolean;
}

const PRESETS: Record<string, ProtocolPreset> = {
  "opencodemuse1.3": {
    api: "openai-responses",
    toolChoice: "auto",
    defaultEffort: "low",
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  },
  "gpt5.6luna": {
    api: "openai-completions",
    supportsReasoningEffort: true,
    supportsDeveloperRole: true,
  },
  "gpt6luna": {
    api: "openai-responses",
    supportsReasoningEffort: true,
    supportsDeveloperRole: true,
  },
  "deepseekflash": {
    api: "openai-completions",
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  },
  "step": {
    api: "anthropic-messages",
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  },
};

export function resolvePdfExCodeProtocolPreset(requested: string | undefined): {
  preset: string;
  definition: ProtocolPreset;
} | undefined {
  const preset = requested?.trim();
  if (!preset) return undefined;
  const definition = PRESETS[preset.toLocaleLowerCase().replaceAll("-", "").replaceAll("_", "")];
  if (!definition) {
    throw new Error(
      `Unknown LLM_PRESET=${preset}; expected OpenCodeMuse1.3, Gpt5.6Luna, Gpt6Luna, DeepseekFlash, or Step`,
    );
  }
  return { preset, definition };
}

/** Muse uses Responses plus a narrower tool contract. The selected protocol
 * profile takes precedence; the model-name check preserves saved legacy config.
 */
export function museModelCompatibility(model: string, protocol?: string) {
  const selectedProtocol = protocol || process.env.LLM_PROTOCOL || "";
  if (selectedProtocol) {
    return selectedProtocol === "openai-responses" ? {
      api: "openai-responses" as const,
      toolChoice: "auto" as const,
      defaultEffort: "low" as const,
    } : undefined;
  }
  const selectedPreset = process.env.LLM_PRESET?.trim().toLocaleLowerCase();
  return selectedPreset === "opencodemuse1.3" || /^muse-spark-/i.test(model) ? {
    api: "openai-responses" as const,
    toolChoice: "auto" as const,
    defaultEffort: "low" as const,
  } : undefined;
}

/** DeepSeek thinking endpoints require reasoning_content replay across tool
 * turns and reject tool_choice=required with HTTP 400, including when settings
 * come from the persisted UI config instead of a preset. The pi-ai SDK also
 * auto-detects api.deepseek.com endpoints; this check covers custom endpoints.
 */
export function deepseekModelCompatibility(model: string) {
  return /^deepseek-/i.test(model) ? {
    thinkingFormat: "deepseek" as const,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
  } : undefined;
}

/** Preserve nullable schema semantics using Muse's supported type-array spelling.
 * OpenCode Muse serializes anyOf(object, null) as a JSON string, even with strict:true.
 * Keep genuine unions and constrained null branches unchanged.
 */
function museNullableParameters(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(museNullableParameters);
  if (!schema || typeof schema !== "object") return schema;
  const node = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, ["enum", "const", "default", "examples"].includes(key) ? value : museNullableParameters(value)]));
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2 || node.type) return node;
  const branches = node.anyOf as Record<string, unknown>[];
  const nullBranch = branches.find(branch => branch?.type === "null" && Object.keys(branch).length === 1);
  const valueBranch = branches.find(branch => branch && typeof branch.type === "string" && branch.type !== "null");
  if (!nullBranch || !valueBranch || valueBranch.enum || Object.hasOwn(valueBranch, "const")) return node;
  const { anyOf: _anyOf, ...rest } = node;
  return { ...valueBranch, ...rest, type: [valueBranch.type, "null"] };
}

/** Muse rejects tool schemas deeper than ten inline levels (including local refs).
 * Keep deep record contracts in their descriptions. This is a provider-only
 * projection: the original typed tool schema still validates every tool call.
 */
export function museToolParameters(schema: unknown): unknown {
  const normalized = museNullableParameters(schema);
  const visit = (value: unknown, depth: number): unknown => {
    if (Array.isArray(value)) return value.map(entry => visit(entry, depth + 1));
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (depth >= 6 && (node.properties || node.items)) {
      return {
        type: node.type,
        description: `${node.description ?? ""} Exact record contract (validated locally): ${JSON.stringify(node)}`,
        ...(node.properties ? { additionalProperties: true } : { items: {} }),
      };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key,
      ["enum", "const", "default", "examples"].includes(key) ? child : visit(child, depth + 1)]));
  };
  return visit(normalized, 0);
}

/** Resolve the protocol profile plus independent connection settings. */
export function resolvePdfExCodePreset(
  environment: NodeJS.ProcessEnv,
): PdfExCodePreset | undefined {
  const profile = resolvePdfExCodeProtocolPreset(environment.LLM_PRESET);
  if (!profile) return undefined;
  const modelId = requiredSetting(environment, "LLM_MODEL", profile.preset);
  const baseUrl = requiredSetting(environment, "LLM_ENDPOINT", profile.preset);
  const apiKey = requiredSetting(environment, "LLM_API_KEY", profile.preset);
  const requestedEffort = profile.definition.supportsReasoningEffort
    ? environment.LLM_REASONING_EFFORT?.trim().toLocaleLowerCase()
      || profile.definition.defaultEffort
      || ""
    : "";
  if (
    requestedEffort
    && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedEffort)
  ) {
    throw new Error(
      `LLM_REASONING_EFFORT=${requestedEffort} is invalid; expected minimal, low, medium, high, xhigh, or max`,
    );
  }
  return {
    preset: profile.preset,
    api: profile.definition.api,
    providerId: `pdf-ex-code-${profile.preset.toLocaleLowerCase()}`,
    modelId,
    baseUrl,
    apiKey,
    extraBodyJson: "",
    serviceTier: "",
    thinkingFormat: "",
    supportsReasoningEffort: profile.definition.supportsReasoningEffort,
    supportsDeveloperRole: profile.definition.supportsDeveloperRole,
    reasoningEffort: requestedEffort as PdfExCodePreset["reasoningEffort"],
    maxTokensField: "",
  };
}

function requiredSetting(
  environment: NodeJS.ProcessEnv,
  name: "LLM_MODEL" | "LLM_ENDPOINT" | "LLM_API_KEY",
  preset: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `LLM_PRESET=${preset} requires ${name}; configure LLM_MODEL, LLM_ENDPOINT, and LLM_API_KEY.`,
    );
  }
  return value;
}
