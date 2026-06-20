import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ensureBrowsersPath } from "../scripts/lib/browsers-path";

describe("ensureBrowsersPath", () => {
  it("resolves PLAYWRIGHT_BROWSERS_PATH from CLAUDE_PLUGIN_DATA when unset", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_PLUGIN_DATA: "/data" };
    expect(ensureBrowsersPath(env)).toBe(join("/data", "browsers"));
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(join("/data", "browsers"));
  });

  it("never overrides a value a caller already set (orchestrators keep precedence)", () => {
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: "/explicit", CLAUDE_PLUGIN_DATA: "/data" };
    expect(ensureBrowsersPath(env)).toBe("/explicit");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/explicit");
  });

  it("returns null and sets nothing when neither var is available", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(ensureBrowsersPath(env)).toBeNull();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});
