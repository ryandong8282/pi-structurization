import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { outerTransportSessionSettings } from "../src/pi-runtime.js";

import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test.each([false, true])("the installed SDK avoids nested retries with outer transport ownership=%s", owned => {
  return run(owned);
});

async function run(owned: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pi-outer-transport-")); roots.push(root);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const settings = owned ? outerTransportSessionSettings(root, agentDir) : SettingsManager.create(root, agentDir);
  if (!owned) settings.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 }, compaction: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  const model: any = { id: "neutral-model", name: "neutral-model", api: "openai-completions", provider: "neutral-provider",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 32,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Only exercise neutral transport failures." });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, noTools: "all",
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });
  const stream = vi.fn(() => {
    const events = new AssistantMessageEventStream();
    events.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "error", errorMessage: "HTTP 503 neutral service unavailable",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    return events;
  });
  session.agent.streamFunction = stream;
  try {
    await session.prompt("Exercise one provider failure.");
    expect(stream).toHaveBeenCalledTimes(owned ? 1 : 3);
    expect(session.autoRetryEnabled).toBe(!owned);
    if (owned) expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "HTTP 503 neutral service unavailable" });
  } finally { session.dispose(); }
}
