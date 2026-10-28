import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { EvidenceManifest } from "../src/contracts.js";
import { applyJsonPatch } from "../src/json-patch.js";
import {
  locateAndRegisterSourceQuote,
  registryWithFullSourceSpans,
  type ImmutableTextSource,
  type SourceSpanRegistry,
} from "../src/source-span-registry.js";
import {
  initialTargetSelectorPlan,
  type TargetSelectorPlan,
} from "../src/target-selector-compiler.js";

const SOURCE_RUN_ID = "selector-regression-2026-08-10T08-19-16-559Z-58a4088e";
const SOURCE_RUN_ROOT = resolve("data", "selector-regression", SOURCE_RUN_ID);
const FIXTURE_ROOT = resolve(
  "packages",
  "pi-agent-pdf",
  "tests",
  "fixtures",
  "gray-soil-selector-failure-v1",
);

interface AgentEvent {
  sequence: number;
  timestamp: string;
  event_type: string;
  payload: Record<string, unknown>;
}

interface ToolEnd {
  timestamp: string;
  output: Record<string, unknown>;
}

async function findSingle(root: string, fileName: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const pending = [root];
  const matches: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name === fileName) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${fileName} below ${root}, found ${matches.length}`);
  }
  return matches[0]!;
}

function evidenceSources(manifest: EvidenceManifest): Map<string, ImmutableTextSource> {
  return new Map(manifest.evidence.map((record) => [record.evidence_id, {
    source_id: record.evidence_id,
    evidence_id: record.evidence_id,
    atom_id: record.atom_id,
    text: record.text,
  }]));
}

async function main(): Promise<void> {
  const eventsPath = await findSingle(SOURCE_RUN_ROOT, "session.events.jsonl");
  const revisionRoot = dirname(eventsPath);
  const evidencePath = join(revisionRoot, "evidence", "evidence.json");
  const manifest = JSON.parse(await readFile(evidencePath, "utf8")) as EvidenceManifest;
  const events = (await readFile(eventsPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentEvent)
    .sort((left, right) => left.sequence - right.sequence);

  const ends = new Map<string, ToolEnd>();
  for (const event of events) {
    if (event.event_type !== "tool_execution_end") continue;
    const toolCallId = String(event.payload.tool_call_id ?? "");
    ends.set(toolCallId, {
      timestamp: event.timestamp,
      output: (event.payload.output ?? {}) as Record<string, unknown>,
    });
  }

  const sources = evidenceSources(manifest);
  let registry: SourceSpanRegistry = registryWithFullSourceSpans(
    manifest.evidence_fingerprint,
    [...sources.values()],
  );
  let selector: TargetSelectorPlan = initialTargetSelectorPlan(manifest);
  const snapshots: Array<{
    attempt: number;
    timestamp: string;
    selector: TargetSelectorPlan;
    registry: SourceSpanRegistry;
    receipt: Record<string, unknown>;
  }> = [];

  for (const event of events) {
    if (event.event_type !== "tool_execution_start") continue;
    const input = (event.payload.input ?? {}) as Record<string, unknown>;
    const toolName = String(event.payload.tool_name ?? "");
    const toolCallId = String(event.payload.tool_call_id ?? "");
    const end = ends.get(toolCallId);
    if (toolName === "locate_evidence_span") {
      if (end?.output.ok !== true) continue;
      const evidenceId = String(input.evidence_id ?? "");
      const source = sources.get(evidenceId);
      if (!source) throw new Error(`Unknown evidence in locate event: ${evidenceId}`);
      const located = locateAndRegisterSourceQuote(registry, source, String(input.quote ?? ""));
      registry = located.registry;
    } else if (toolName === "replace_target_selectors") {
      if (typeof end?.output.after_sha256 !== "string") continue;
      selector = JSON.parse(String(input.content ?? "")) as TargetSelectorPlan;
    } else if (toolName === "patch_target_selectors") {
      if (typeof end?.output.after_sha256 !== "string") continue;
      selector = applyJsonPatch(selector, input.operations as never[]) as TargetSelectorPlan;
    } else if (toolName === "compile_target_selectors") {
      const attempt = Number(end?.output.validation_sequence ?? 0);
      if (attempt >= 1 && attempt <= 3) {
        snapshots.push({
          attempt,
          timestamp: end!.timestamp,
          selector: structuredClone(selector),
          registry: structuredClone(registry),
          receipt: structuredClone(end!.output),
        });
      }
    }
  }

  if (snapshots.length !== 3) {
    throw new Error(`Expected exactly 3 validator snapshots, found ${snapshots.length}`);
  }
  await mkdir(FIXTURE_ROOT, { recursive: true });
  await writeFile(join(FIXTURE_ROOT, "evidence.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const snapshot of snapshots) {
    const directory = join(FIXTURE_ROOT, `attempt-${snapshot.attempt}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "selector.json"), `${JSON.stringify(snapshot.selector, null, 2)}\n`, "utf8");
    await writeFile(join(directory, "source-span-registry.json"), `${JSON.stringify(snapshot.registry, null, 2)}\n`, "utf8");
    await writeFile(join(directory, "validation-receipt.json"), `${JSON.stringify(snapshot.receipt, null, 2)}\n`, "utf8");
  }
  const fixtureManifest = {
    schema_version: "selector-failure-fixture/v1",
    fixture_id: "gb50209-gray-soil-2026-08-10",
    source_run_id: SOURCE_RUN_ID,
    source_revision_relative_path: revisionRoot.slice(SOURCE_RUN_ROOT.length + 1).replaceAll("\\", "/"),
    target_id: manifest.target_id,
    evidence_fingerprint: manifest.evidence_fingerprint,
    attempts: snapshots.map((snapshot) => ({
      attempt: snapshot.attempt,
      timestamp: snapshot.timestamp,
      selector_fingerprint: snapshot.receipt.selector_fingerprint,
      compiled_plan_sha256: snapshot.receipt.compiled_plan_sha256,
      issue_codes: ((snapshot.receipt.issues ?? []) as Array<{ code: string }>).map((issue) => issue.code),
    })),
    note: "Reconstructed from immutable tool events immediately before each of the three strict validator calls. Post-budget selector patches are intentionally excluded.",
  };
  await writeFile(join(FIXTURE_ROOT, "fixture.json"), `${JSON.stringify(fixtureManifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${FIXTURE_ROOT}\n`);
}

await main();
