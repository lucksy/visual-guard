/**
 * Shared HTTP readiness probe (extracted from `init.ts` so the managed-harness serve lifecycle can
 * reuse the exact same R2 semantics). Two layers:
 *
 *  - {@link isReachable} — a single probe: any HTTP response means the origin is up; only a refused/
 *    timed-out connection counts as unreachable (the engine's R2 rule, mirrored in capture.ts).
 *  - {@link waitUntilReachable} — poll {@link isReachable} until it succeeds or a total budget elapses
 *    (used to wait on a freshly-spawned Ladle/Storybook dev server before capturing).
 *
 * `fetch`, `sleep`, and `now` are injectable so the polling loop is deterministically unit-testable
 * without real timers or sockets.
 */

/** Minimal fetch shape: we only care whether the call resolves (reachable) or throws (not). */
export type ReachFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>;

const defaultFetch: ReachFetch = (url, init) => globalThis.fetch(url, init);

export interface ReachableOptions {
  /** Per-probe timeout in ms (an unanswered socket is aborted). Defaults to 5000. */
  timeoutMs?: number;
  /** Injected fetch (tests); defaults to the runtime global. */
  fetchImpl?: ReachFetch;
}

/** Any HTTP response = reachable; a thrown fetch (ECONNREFUSED / abort) = unreachable. */
export async function isReachable(origin: string, options: ReachableOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(origin, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  /** Overall budget in ms before giving up. Defaults to 30000 (cold dev-server boot). */
  totalTimeoutMs?: number;
  /** Delay between probe attempts in ms. Defaults to 500. */
  intervalMs?: number;
  /** Per-probe timeout in ms. Defaults to 2000. */
  perProbeTimeoutMs?: number;
  fetchImpl?: ReachFetch;
  /** Injected sleep (tests); defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
}

/**
 * Poll {@link isReachable} until the origin answers or `totalTimeoutMs` elapses. Returns true as soon
 * as a probe succeeds, false if the budget runs out. Always attempts at least one probe even when the
 * budget is tiny, so a zero/short timeout still gives the server one chance.
 */
export async function waitUntilReachable(origin: string, options: WaitOptions = {}): Promise<boolean> {
  const totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const perProbeTimeoutMs = options.perProbeTimeoutMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const deadline = now() + totalTimeoutMs;
  for (;;) {
    if (await isReachable(origin, { timeoutMs: perProbeTimeoutMs, fetchImpl: options.fetchImpl })) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}
