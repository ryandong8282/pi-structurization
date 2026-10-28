import { afterEach, expect, test, vi } from "vitest";
import { retryBackoff } from "../src/batch.js";

afterEach(() => vi.useRealTimers());

test("transport backoff waits its scheduled delay and leaves no timer", async () => {
  vi.useFakeTimers();
  const completed = vi.fn();
  const pending = retryBackoff("TLS handshake: EOF", undefined, 30_000).then(completed);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(completed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(completed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("cancellation during transport backoff is immediate and cleans its timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = retryBackoff("TLS handshake: EOF", controller.signal, 60_000);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await expect(retryBackoff("EOF", controller.signal, 60_000)).rejects.toMatchObject({ name: "AbortError" });
  expect(vi.getTimerCount()).toBe(0);
});
