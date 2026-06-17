import { describe, it, expect } from "vitest";
import { browserOpenCommand } from "../scripts/lib/studio/open";

const URL = "http://127.0.0.1:54123/?a=1&b=2";

describe("browserOpenCommand", () => {
  it("selects the right opener per platform and always passes the URL as a separate argv", () => {
    expect(browserOpenCommand("darwin", URL)).toEqual({ cmd: "open", args: [URL] });
    expect(browserOpenCommand("linux", URL)).toEqual({ cmd: "xdg-open", args: [URL] });
    expect(browserOpenCommand("freebsd", URL)).toEqual({ cmd: "xdg-open", args: [URL] });
    // Windows: empty title arg so a URL with `&` is the target, not parsed by `start`.
    expect(browserOpenCommand("win32", URL)).toEqual({ cmd: "cmd", args: ["/c", "start", "", URL] });
  });

  it("never interpolates the URL into a shell string (each arg is discrete)", () => {
    const { args } = browserOpenCommand("darwin", "http://x/; rm -rf /");
    expect(args).toEqual(["http://x/; rm -rf /"]); // the whole URL is one argv element
  });
});
