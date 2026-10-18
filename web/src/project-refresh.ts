/** Coalesce background state changes while keeping explicit actions fresh. */
export function createProjectRefreshScheduler(load: () => Promise<void>, intervalMs = 2_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let followUp: Promise<void> | undefined;
  let pending = false;
  let disposed = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    if (disposed) return;
    pending = true;
    if (timer !== undefined || inFlight) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(() => undefined);
    }, Math.max(120, lastStartedAt + intervalMs - Date.now()));
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    clearTimer();
    if (inFlight) {
      // All explicit refreshes during this request share one fresh follow-up.
      followUp ??= inFlight.catch(() => undefined).then(() => {
        followUp = undefined;
        return refresh();
      });
      return followUp;
    }
    pending = false;
    lastStartedAt = Date.now();
    const request = Promise.resolve().then(load);
    inFlight = request;
    const settled = () => {
      if (inFlight !== request) return;
      inFlight = undefined;
      if (pending) schedule();
    };
    void request.then(settled, settled);
    return request;
  }

  return {
    schedule,
    refresh,
    dispose() {
      disposed = true;
      pending = false;
      clearTimer();
    }
  };
}
