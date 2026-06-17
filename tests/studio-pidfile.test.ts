import { describe, it, expect } from "vitest";
import {
  decidePidfileAction,
  formatPidfile,
  isPidAlive,
  parsePidfile,
  type PidfileInfo,
} from "../scripts/lib/studio/pidfile";

const info: PidfileInfo = {
  pid: 4242,
  port: 54123,
  url: "http://127.0.0.1:54123/",
  startedAt: "2026-06-16T00:00:00.000Z",
};

describe("format/parse pidfile", () => {
  it("round-trips a valid info", () => {
    expect(parsePidfile(formatPidfile(info))).toEqual(info);
  });

  it("returns null for garbage / half-written / wrong-shaped files", () => {
    expect(parsePidfile("")).toBeNull();
    expect(parsePidfile("{not json")).toBeNull();
    expect(parsePidfile("null")).toBeNull();
    expect(parsePidfile("123")).toBeNull();
    expect(parsePidfile(JSON.stringify({ pid: 0, port: 1, url: "x", startedAt: "t" }))).toBeNull(); // pid <= 0
    expect(parsePidfile(JSON.stringify({ pid: 1, port: -1, url: "x", startedAt: "t" }))).toBeNull(); // bad port
    expect(parsePidfile(JSON.stringify({ pid: 1.5, port: 1, url: "x", startedAt: "t" }))).toBeNull(); // non-int pid
    expect(parsePidfile(JSON.stringify({ pid: 1, port: 1, url: "", startedAt: "t" }))).toBeNull(); // empty url
    expect(parsePidfile(JSON.stringify({ pid: 1, port: 1, url: "x" }))).toBeNull(); // missing startedAt
  });

  it("rejects a well-formed file whose url is not a loopback http URL (a launcher won't open it)", () => {
    const withUrl = (url: string): string => formatPidfile({ ...info, url });
    expect(parsePidfile(withUrl("http://evil.example.com:54123/"))).toBeNull(); // non-loopback host
    expect(parsePidfile(withUrl("https://127.0.0.1:54123/"))).toBeNull(); // wrong scheme
    expect(parsePidfile(withUrl("file:///etc/passwd"))).toBeNull(); // non-http scheme
    expect(parsePidfile(withUrl("not a url"))).toBeNull(); // unparseable
    expect(parsePidfile(withUrl("http://localhost:6006/"))).not.toBeNull(); // loopback name is allowed
  });
});

describe("decidePidfileAction", () => {
  it("reuses iff the file is valid AND the pid is alive; otherwise starts fresh", () => {
    expect(decidePidfileAction(info, () => true)).toBe("reuse");
    expect(decidePidfileAction(info, () => false)).toBe("start"); // stale → overwrite
    expect(decidePidfileAction(null, () => true)).toBe("start"); // no file → start
  });
});

describe("isPidAlive", () => {
  it("reports the current process alive and rejects bogus pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // A very high pid is almost certainly free → ESRCH → not alive.
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });
});
