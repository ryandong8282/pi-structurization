import { describe, expect, test } from "vitest";

import { withWindowsTransientOpenRetry } from "../src/atomic.js";

function fileError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
}

describe("Windows transient file retry", () => {
  test("retries transient failures only while acquiring an open handle", async () => {
    let attempts = 0;
    const result = await withWindowsTransientOpenRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw fileError("EBUSY", "open");
      return "opened";
    });

    expect(result).toBe("opened");
    expect(attempts).toBe(3);
  });

  test.each([
    ["EBUSY", "write"],
    ["ENOENT", "open"],
  ])("does not retry %s from %s", async (code, syscall) => {
    let attempts = 0;
    await expect(withWindowsTransientOpenRetry(async () => {
      attempts += 1;
      throw fileError(code, syscall);
    })).rejects.toMatchObject({ code, syscall });
    expect(attempts).toBe(1);
  });
});
