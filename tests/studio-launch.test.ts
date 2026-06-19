import { describe, it, expect } from "vitest";
import { parseLaunchArgs, waitForPidfile } from "../scripts/studio-launch";

describe("parseLaunchArgs", () => {
  it("parses --config and --cwd", () => {
    expect(parseLaunchArgs(["--config", "/c.json", "--cwd", "/p"])).toEqual({ config: "/c.json", cwd: "/p" });
  });

  it("requires --config", () => {
    expect(() => parseLaunchArgs(["--cwd", "/p"])).toThrow(/--config is required/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseLaunchArgs(["--config", "/c.json", "--nope"])).toThrow(/unknown argument --nope/);
  });
});

describe("waitForPidfile", () => {
  it("returns true as soon as the pidfile appears (and stops polling)", async () => {
    let checks = 0;
    let sleeps = 0;
    const ok = await waitForPidfile("/x/studio.pid", {
      attempts: 10,
      delayMs: 1,
      exists: () => ++checks >= 3, // appears on the 3rd check
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(true);
    expect(checks).toBe(3);
    expect(sleeps).toBe(2); // slept between the first two failed checks only
  });

  it("returns false when the pidfile never appears within the attempts", async () => {
    let sleeps = 0;
    const ok = await waitForPidfile("/x/studio.pid", {
      attempts: 4,
      delayMs: 1,
      exists: () => false,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(false);
    expect(sleeps).toBe(4); // one sleep per failed attempt
  });
});
