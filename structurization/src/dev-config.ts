import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PI_AGENT_MODEL_STAGES, type PiAgentModelSettings, type PiAgentRuntimeModelConfig } from "./presets.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Intentionally accepts runtime settings, never the application's saved UI configuration. */
export async function loadDevModelConfig(path: string | undefined, env: NodeJS.ProcessEnv): Promise<PiAgentRuntimeModelConfig> {
  let root: Record<string, unknown> = {};
  if (path) {
    try { root = record(JSON.parse(await readFile(path, "utf8")), "config"); }
    catch { throw new Error("Cannot read runtime config JSON (expected { stages, subscriptionAuthPath? })"); }
    if (Object.keys(root).some(key => !["stages", "subscriptionAuthPath"].includes(key))) throw new Error("Unknown runtime config field; saved web configuration is not supported");
  }
  const stages = root.stages === undefined ? {} : record(root.stages, "stages");
  if (Object.keys(stages).some(key => !PI_AGENT_MODEL_STAGES.includes(key as typeof PI_AGENT_MODEL_STAGES[number]))) throw new Error("Unknown model stage");
  const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const output = {} as PiAgentRuntimeModelConfig["stages"];
  for (const stage of PI_AGENT_MODEL_STAGES) {
    const saved = stages[stage] === undefined ? {} : record(stages[stage], `stages.${stage}`);
    if (Object.keys(saved).some(key => !["authMode", "apiType", "endpoint", "apiKey", "model", "effort"].includes(key))) throw new Error(`Unknown model setting in ${stage}`);
    const fields = { authMode: "AUTH_MODE", apiType: "API_TYPE", endpoint: "ENDPOINT", apiKey: "API_KEY", model: "MODEL", effort: "EFFORT" } as const;
    const merged: Record<string, unknown> = { authMode: "api_key", effort: "off", ...saved };
    for (const [field, suffix] of Object.entries(fields)) {
      const value = env[`STRUCTURIZATION_${stage.toUpperCase()}_${suffix}`] ?? env[`STRUCTURIZATION_${suffix}`];
      if (value !== undefined) merged[field] = value;
    }
    if (!["api_key", "chatgpt"].includes(String(merged.authMode))) throw new Error(`Invalid authMode in ${stage}`);
    if (!["openai", "anthropic"].includes(String(merged.apiType))) throw new Error(`Missing or invalid apiType in ${stage}`);
    if (!effortValues.includes(String(merged.effort))) throw new Error(`Invalid effort in ${stage}`);
    for (const field of ["endpoint", "model"]) {
      if (typeof merged[field] !== "string" || !merged[field].trim()) throw new Error(`Missing ${field} in ${stage}`);
    }
    let url: URL;
    try { url = new URL(String(merged.endpoint)); } catch { throw new Error(`Invalid endpoint in ${stage}`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Endpoint in ${stage} must be HTTP(S) without credentials/query/fragment`);
    if (merged.authMode === "api_key" && (typeof merged.apiKey !== "string" || !merged.apiKey.trim())) throw new Error(`Missing apiKey in ${stage}`);
    if (merged.apiKey !== undefined && typeof merged.apiKey !== "string") throw new Error(`apiKey must be a string in ${stage}`);
    if (merged.authMode === "chatgpt" && merged.apiType !== "openai") throw new Error(`ChatGPT requires apiType=openai in ${stage}`);
    output[stage] = { authMode: merged.authMode, apiType: merged.apiType, endpoint: merged.endpoint, model: merged.model, apiKey: merged.apiKey ?? "", effort: merged.effort } as PiAgentModelSettings;
  }
  const auth = env.STRUCTURIZATION_SUBSCRIPTION_AUTH_PATH ?? root.subscriptionAuthPath;
  if (auth !== undefined && (typeof auth !== "string" || !auth.trim())) throw new Error("subscriptionAuthPath must be a nonempty path");
  if (Object.values(output).some(s => s.authMode === "chatgpt") && !auth) throw new Error("ChatGPT requires an existing external subscriptionAuthPath; this CLI does not log in");
  return { stages: output, ...(typeof auth === "string" ? { subscriptionAuthPath: resolve(env.STRUCTURIZATION_SUBSCRIPTION_AUTH_PATH === undefined && path ? dirname(path) : process.cwd(), auth) } : {}) };
}

/** Provider errors can echo request headers or keys. Never serialize the config itself. */
export function redactDevMessage(value: string, config?: PiAgentRuntimeModelConfig): string {
  let text = value;
  for (const settings of Object.values(config?.stages ?? {})) {
    if (settings.apiKey) text = text.split(settings.apiKey).join("[REDACTED]");
  }
  return text.replace(/(Bearer\s+)\S+/giu, "$1[REDACTED]");
}
