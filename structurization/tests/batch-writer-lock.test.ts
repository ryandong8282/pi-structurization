import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { withBatchWriterLock } from "../src/batch-writer-lock.js";

test("only one batch writer enters; rejection and failure do not strand the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-writer-"));
  const state = join(root, "batch.json");
  await writeFile(state, "unchanged");
  await withBatchWriterLock(root, async () => {
    await expect(withBatchWriterLock(root, () => writeFile(state, "wrong writer"))).rejects.toThrow("batch_already_running");
    expect(await readFile(state, "utf8")).toBe("unchanged");
    await withBatchWriterLock(join(root, "another-job"), async () => undefined);
  });
  await expect(withBatchWriterLock(root, async () => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
  await expect(withBatchWriterLock(root, async () => "resumed")).resolves.toBe("resumed");
});

test("process death releases the job lock without deleting a PID file or job artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-writer-crash-"));
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');console.log('locked');setInterval(()=>{},1000);",
    join(root, "batch-writer.sqlite")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    await expect(withBatchWriterLock(root, async () => undefined)).rejects.toThrow("batch_already_running");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await expect(withBatchWriterLock(root, async () => "resumed")).resolves.toBe("resumed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
