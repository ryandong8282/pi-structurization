import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { prettyJson } from "./canonical.js";

const WINDOWS_TRANSIENT_FILE_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorProperty(error: unknown, property: "code" | "syscall"): unknown {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)[property]
    : undefined;
}

function isWindowsTransientFileError(error: unknown): boolean {
  return WINDOWS_TRANSIENT_FILE_ERROR_CODES.has(String(errorProperty(error, "code")));
}

async function waitBeforeWindowsRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, Math.min(25 * (2 ** attempt), 500));
  });
}

export async function withWindowsTransientOpenRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 7
        || errorProperty(error, "syscall") !== "open"
        || !isWindowsTransientFileError(error)
      ) {
        throw error;
      }
      await waitBeforeWindowsRetry(attempt);
    }
  }
}

async function renameWithWindowsRetry(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (
        attempt >= 7
        || !isWindowsTransientFileError(error)
      ) {
        throw error;
      }
      await waitBeforeWindowsRetry(attempt);
    }
  }
}

async function writeSyncedTemporaryFile(
  destination: string,
  content: string | Uint8Array,
): Promise<string> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  const handle = await withWindowsTransientOpenRetry(
    () => open(temporary, "wx", 0o600),
  );
  try {
    if (typeof content === "string") {
      await handle.writeFile(content, "utf8");
    } else {
      await handle.writeFile(content);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

export async function appendText(destination: string, content: string): Promise<void> {
  // Retry only acquisition of the append handle. Once a handle is acquired, a write
  // failure is not replayed because the kernel may already have appended some bytes.
  const handle = await withWindowsTransientOpenRetry(() => open(destination, "a", 0o600));
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export async function atomicWriteText(destination: string, content: string): Promise<void> {
  const temporary = await writeSyncedTemporaryFile(destination, content);
  try {
    await renameWithWindowsRetry(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  await atomicWriteText(destination, prettyJson(value));
}

export async function atomicWriteNewText(destination: string, content: string): Promise<void> {
  const temporary = await writeSyncedTemporaryFile(destination, content);
  try {
    // Linking a fully flushed temporary file publishes the destination atomically and
    // fails when the immutable artifact already exists.
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function atomicWriteNewBytes(
  destination: string,
  content: Uint8Array,
): Promise<void> {
  const temporary = await writeSyncedTemporaryFile(destination, content);
  try {
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function atomicWriteNewJson(destination: string, value: unknown): Promise<void> {
  await atomicWriteNewText(destination, prettyJson(value));
}

export async function makeReadOnly(path: string): Promise<void> {
  await chmod(path, 0o444);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
