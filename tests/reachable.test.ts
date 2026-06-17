import { describe, it, expect } from "vitest";
import { isReachable, waitUntilReachable, type ReachFetch } from "../scripts/lib/reachable";

// reachable.ts does its only I/O through an injected fetch (+ injected sleep/now for the poll loop),
// so every case runs deterministically with no real timers or sockets.

describe("isReachable", () => {
  it("returns true when the fetch resolves (any HTTP response = reachable)", async () => {
    const fetchImpl: ReachFetch = async () => ({ ok: false, status: 404 });
    expect(await isReachable("http://localhost:6006", { fetchImpl })).toBe(true);
  });

  it("returns false when the fetch throws (connection refused)", async () => {
    const fetchImpl: ReachFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await isReachable("http://localhost:6006", { fetchImpl })).toBe(false);
  });

  it("aborts and returns false when the probe outlives the timeout", async () => {
    // A fetch that only settles when its AbortSignal fires — exercises the timer/abort path.
    const fetchImpl: ReachFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await isReachable("http://localhost:6006", { timeoutMs: 5, fetchImpl })).toBe(false);
  });
});

describe("waitUntilReachable", () => {
  function controllableClock() {
    let clock = 0;
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
  }

  it("returns true as soon as a probe succeeds, after retries", async () => {
    let attempts = 0;
    const fetchImpl: ReachFetch = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not up yet");
      return { ok: true };
    };
    const { now, sleep } = controllableClock();
    const ok = await waitUntilReachable("http://localhost:61000", {
      totalTimeoutMs: 10_000,
      intervalMs: 500,
      fetchImpl,
      now,
      sleep,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("returns false when the budget elapses, and stops probing", async () => {
    let attempts = 0;
    const fetchImpl: ReachFetch = async () => {
      attempts += 1;
      throw new Error("never up");
    };
    const { now, sleep } = controllableClock();
    const ok = await waitUntilReachable("http://localhost:61000", {
      totalTimeoutMs: 1000,
      intervalMs: 500,
      fetchImpl,
      now,
      sleep,
    });
    expect(ok).toBe(false);
    // probes at 0ms, 500ms, then 1000ms >= deadline → stop. Three attempts, no infinite loop.
    expect(attempts).toBe(3);
  });

  it("always probes at least once even with a zero budget", async () => {
    let attempts = 0;
    const fetchImpl: ReachFetch = async () => {
      attempts += 1;
      return { ok: true };
    };
    const { now, sleep } = controllableClock();
    const ok = await waitUntilReachable("http://localhost:61000", {
      totalTimeoutMs: 0,
      fetchImpl,
      now,
      sleep,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(1);
  });
});
