import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** OS-backed exclusive lock: released on close or process death, no stale PID reclaim race. */
export async function withBatchWriterLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = new DatabaseSync(join(directory, "batch-writer.sqlite"));
  try {
    try {
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch (error) {
      if (error && typeof error === "object" && "errcode" in error && error.errcode === 5) {
        throw new Error("batch_already_running: 当前 job 已有批次写入者，本次未启动。请等待原批次结束或停止其进程后恢复同一 job；不要删除工件、改 checkpoint 或另开同 job 进程。");
      }
      throw error;
    }
    return await operation();
  } finally {
    lock.close();
  }
}
