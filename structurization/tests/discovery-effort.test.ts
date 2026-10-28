import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configuredModel } from "../src/pi-runtime.js";
import { PI_AGENT_MODEL_STAGES, type PiAgentRuntimeModelConfig } from "../src/presets.js";

test("layout effort override does not mutate semantic discovery or independent review settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discovery-effort-"));
  const settings = { apiType: "openai", endpoint: "https://llm.example/v1", apiKey: "unit-test-key", model: "reasoning-model", effort: "high" };
  const config = { stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, { ...settings }])) } as PiAgentRuntimeModelConfig;
  try {
    expect((await configuredModel(root, "discovery", config, "low")).configured?.effort).toBe("low");
    expect((await configuredModel(root, "discovery", config)).configured?.effort).toBe("high");
    expect((await configuredModel(root, "discovery_review", config)).configured?.effort).toBe("high");
    expect(config.stages.discovery.effort).toBe("high");
  } finally { await rm(root, { recursive: true, force: true }); }
});
