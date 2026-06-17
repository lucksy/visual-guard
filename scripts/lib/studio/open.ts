/**
 * Cross-platform "open this URL in the default browser" command selection (P3, SPEC §10). **Pure** — it
 * only chooses the command + argv for a platform; the actual detached spawn lives in `serve.ts`. Keeping
 * the selection pure makes the per-OS mapping unit-testable without spawning anything, and keeps the
 * launcher free of any new dependency (no `open` npm package — zero new deps is a P3 constraint).
 */

export interface OpenCommand {
  cmd: string;
  args: string[];
}

/**
 * The command to open `url` in the default browser on `platform` (a `process.platform` value):
 *  - `darwin` → `open <url>`
 *  - `win32`  → `cmd /c start "" <url>` (the empty `""` is `start`'s title arg, so a URL with `&` is
 *               passed as the target, not parsed as a window title)
 *  - everything else (Linux/BSD) → `xdg-open <url>`
 *
 * The URL is always passed as a **separate argv element** (never interpolated into a shell string), so a
 * crafted URL cannot inject shell tokens when the caller spawns without a shell.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [url] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", "", url] };
    default:
      return { cmd: "xdg-open", args: [url] };
  }
}
