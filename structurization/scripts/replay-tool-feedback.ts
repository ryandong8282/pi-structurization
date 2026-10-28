/** Replay public tool calls only. No model requests, business dispatch or source writes. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteJson } from "../src/atomic.js";
import { sha256Text } from "../src/canonical.js";
import { ModelSourceHandles } from "../src/model-source-handles.js";
import { createPiTools } from "../src/tools.js";

const directory = process.argv[2];
assert(directory, "Pass a saved revision's pi-session directory");
const { validateToolArguments } = await import('@earendil-works/pi-ai');
const scratch = await mkdtemp(join(tmpdir(), "pi-feedback-replay-"));
const codec = await ModelSourceHandles.open(scratch);
let dispatched = 0;
const tool = codec.wrapTools(createPiTools({ usesSelectorCompiler: true, dispatch: async () => {
  dispatched++; throw new Error("Replay must not execute business tools");
} } as any)).find(tool => tool.name === "stage_target_selector_draft")!;
const results: unknown[] = [];
let successfulCallsAccepted = 0;
for (const name of (await readdir(directory)).filter(name => name.endsWith(".jsonl"))) {
  const path = resolve(directory, name), original = await readFile(path, "utf8");
  const events = original.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const calls = new Map(events.flatMap(event => (event.message?.content ?? [])
    .filter((part: any) => part.type === "toolCall" && part.name === tool.name)
    .map((part: any) => [part.id, part] as const)));
  for (const event of events) {
    const message = event.message;
    if (message?.role !== "toolResult" || message.toolName !== tool.name) continue;
    const call: any = calls.get(message.toolCallId);
    if (!call) continue;
    const before = JSON.stringify(call.arguments);
    let error: string | undefined;
    try {
      validateToolArguments(tool, { ...call, arguments: tool.prepareArguments!(call.arguments) });
    } catch (caught) { error = (caught as Error).message; }
    assert.equal(JSON.stringify(call.arguments), before, "Admission mutated a recorded call");
    if (!message.isError) {
      assert.equal(error, undefined, "Previously admitted call is now rejected");
      successfulCallsAccepted++;
      continue;
    }
    assert(error, "Previously rejected shape must remain rejected");
    const receipt = JSON.parse(error);
    assert.equal(receipt.mutation_receipt?.status, "not_applied");
    for (const [collection, rows] of Object.entries(call.arguments.draft ?? {})) {
      if (!Array.isArray(rows)) continue;
      const expectedKeys = rows.flatMap(row => typeof row?.key === "string" ? [row.key] : []);
      assert.deepEqual(receipt.mutation_receipt.collections.find((entry: any) => entry.collection === collection)?.submitted_keys, expectedKeys);
    }
    results.push({ timestamp: event.timestamp, issue_count: receipt.issue_count,
      issue_paths: receipt.issues?.map((issue: any) => issue.path), mutation_receipt: receipt.mutation_receipt,
      arguments_unchanged: true });
  }
  assert.equal(sha256Text(await readFile(path, "utf8")), sha256Text(original), "Source transcript changed");
}
assert.equal(dispatched, 0);
const report = { source: resolve(directory), results, successfulCallsAccepted, dispatched, model_requests: 0, source_unchanged: true };
await atomicWriteJson(join(scratch, "report.json"), report);
console.log(JSON.stringify({ report_path: join(scratch, "report.json"), ...report }));
