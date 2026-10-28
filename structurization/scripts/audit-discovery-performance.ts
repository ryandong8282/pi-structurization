import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeDiscoveryPerformance } from "../src/discovery-performance.js";

// Usage: npx tsx scripts/audit-discovery-performance.ts <session.events.jsonl>
// stdout only. The source path and its sibling job artifacts are never written.
const path = process.argv[2];
if (!path) throw new Error("Provide a discovery session.events.jsonl path (read-only).");
const lines = (await readFile(resolve(path), "utf8")).trim().split(/\r?\n/);
const events = lines.map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`Invalid or incomplete event line ${index + 1}; retry after the writer finishes.`); }
});
console.log(JSON.stringify(summarizeDiscoveryPerformance(events), null, 2));
