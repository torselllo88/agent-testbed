/**
 * Caps simultaneous in-flight requests to one provider across the whole
 * process — every experiment, every batch. Batch concurrency limits how many
 * experiments run at once; this limits what actually hits the provider
 * (a single experiment's voting step is one request per agent, and the
 * router adds more). FIFO, so no request starves.
 *
 * A first version on purpose: no RPM/TPM accounting, just a semaphore.
 */
export class ConcurrencyGate {
  private inFlight = 0;
  private peak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.inFlight < this.maxConcurrent) return Promise.resolve(this.take());

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.take());
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private take(): () => void {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.waiters.shift()?.();
    };
  }

  stats(): { maxConcurrent: number; inFlight: number; queued: number; peak: number } {
    return { maxConcurrent: this.maxConcurrent, inFlight: this.inFlight, queued: this.waiters.length, peak: this.peak };
  }
}
