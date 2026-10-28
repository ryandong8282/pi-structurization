export interface FailFastResult<T> {
  status: "fulfilled" | "failed" | "cancelled";
  value?: T;
  error?: string;
}

export async function runBoundedFailFast<TInput, TOutput>(options: {
  inputs: readonly TInput[];
  concurrency: number;
  failFast?: boolean;
  signal?: AbortSignal;
  worker(input: TInput, signal: AbortSignal): Promise<TOutput>;
  isHardFailure(value: TOutput): boolean;
}): Promise<FailFastResult<TOutput>[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const results: FailFastResult<TOutput>[] = Array.from({ length: options.inputs.length }, () => ({ status: "cancelled" }));
  let nextIndex = 0;
  const take = (): number | undefined => {
    if (controller.signal.aborted || nextIndex >= options.inputs.length) return undefined;
    const value = nextIndex;
    nextIndex += 1;
    return value;
  };
  const worker = async () => {
    for (;;) {
      const index = take();
      if (index === undefined) return;
      try {
        const value = await options.worker(options.inputs[index]!, controller.signal);
        results[index] = { status: options.isHardFailure(value) ? "failed" : "fulfilled", value };
        if (options.failFast !== false && options.isHardFailure(value)) {
          controller.abort(new Error(`Hard gate failed at index ${index}`));
        }
      } catch (error) {
        const cancelled = controller.signal.aborted || options.signal?.aborted;
        results[index] = {
          status: cancelled ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        if (!cancelled && options.failFast !== false) controller.abort(error);
      }
    }
  };
  try {
    const concurrency = Math.max(1, Math.min(options.inputs.length || 1, Math.floor(options.concurrency) || 1));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
