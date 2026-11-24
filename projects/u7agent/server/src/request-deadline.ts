export function startRequestDeadline(timeoutMs: number, userSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onUserAbort = () => controller.abort();
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  if (userSignal?.aborted) onUserAbort();

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get aborted() {
      return userSignal?.aborted === true;
    },
    clear() {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onUserAbort);
    },
  };
}
