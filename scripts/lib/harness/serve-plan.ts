import type { Config, LadleTarget } from "../config";
import { isAllowedHost } from "../studio/router";

/**
 * Pure planning for the managed-harness serve lifecycle (the impure spawn/poll lives in
 * `scripts/managed-serve.ts`). A Visual-Guard-scaffolded Ladle target is marked `managed: true`; its
 * dev server isn't expected to be already running, so `/visual-check` starts it, captures, and stops it.
 */

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/** The `managed: true` Ladle targets in a config — the ones whose dev server VG starts/stops. */
export function managedLadleTargets(config: Config): LadleTarget[] {
  return config.targets.filter(
    (target): target is LadleTarget => target.type === "ladle" && target.managed === true,
  );
}

/**
 * Is `url` a loopback `http:` URL? A managed harness is always served locally, and the harness pidfile
 * round-trips through the same loopback-only `parsePidfile` the Studio uses — so `start` requires this
 * up front, otherwise `stop` would read the pidfile back as invalid and silently leak the dev server.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && isAllowedHost(parsed.host);
  } catch {
    return false;
  }
}

/** The port a target URL serves on (defaults by scheme when the URL omits an explicit port). */
export function portOf(url: string): number {
  const parsed = new URL(url);
  if (parsed.port.length > 0) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

/** The recommended install command for a package manager (after the dev dep is in package.json). */
export function installCommand(pm: PackageManager): string {
  return pm === "yarn" ? "yarn" : `${pm} install`;
}

/**
 * The command + args to start Ladle's dev server on `port`, via the project's package-manager runner so
 * it resolves the locally-installed `@ladle/react` bin (never fetches from the registry).
 */
export function ladleServeCommand(
  pm: PackageManager,
  port: number,
): { command: string; args: string[] } {
  const serve = ["serve", "--port", String(port)];
  switch (pm) {
    case "pnpm":
      return { command: "pnpm", args: ["exec", "ladle", ...serve] };
    case "yarn":
      return { command: "yarn", args: ["ladle", ...serve] };
    case "bun":
      return { command: "bunx", args: ["ladle", ...serve] };
    default:
      return { command: "npx", args: ["--no-install", "ladle", ...serve] };
  }
}
