/** Bound a third-party Promise even when it ignores the supplied AbortSignal. No retry is implied. */
export function withAbortSignal<T>(task: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(task);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("OperationAborted"));
    };
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
