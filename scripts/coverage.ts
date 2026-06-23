import { pathToFileURL } from "node:url";
import { walkPngFiles } from "./compare";
import { loadConfig, type Config } from "./lib/config";
import { resolveTargets, type FetchLike, type RenderTarget } from "./lib/targets";

/**
 * Coverage map (T-23): cross the config's **resolved render grid** (the same `resolveTargets`
 * expansion capture uses — targets × discovered stories / config states × viewports) with the
 * committed baselines on disk, to show per `<instance>/<target>` which `state@viewport` cells are
 * covered, which are **gaps** (config expects a render but no baseline exists), and which baselines
 * are **orphans** (on disk but no longer expected by config).
 *
 * Read-only: it resolves targets, walks the baseline dir, and prints a map — it never captures,
 * never writes a baseline, and sends nothing external. `buildCoverage` is pure and unit-tested.
 *
 * Storybook auto-discovery needs the Storybook running (or an explicit `stories` list in config);
 * app targets resolve fully offline. Coverage uses the capture-time expansion so the "expected"
 * grid can never drift from what capture actually shoots.
 */

const PREFIX = "Visual Guard coverage";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

/**
 * The baseline/current/diff key for a render. Mirrors `capture.ts` `renderRelPath` and is held in
 * lockstep by a drift-guard in tests/coverage.test.ts — duplicated here only to avoid importing
 * capture.ts (which would pull in its heavy `playwright` import for a no-browser command).
 */
export function renderKey(
  render: Pick<RenderTarget, "instance" | "name" | "state" | "viewport">,
): string {
  return `${render.instance}/${render.name}/${render.state}@${render.viewport}.png`;
}

export interface CoverageCell {
  state: string;
  viewport: number;
  covered: boolean;
}

export interface CoverageTarget {
  instance: string;
  target: string;
  cells: CoverageCell[];
  /** Cells expected by config that have no baseline (the actionable gaps). */
  gaps: { state: string; viewport: number }[];
}

export interface CoverageMap {
  targets: CoverageTarget[];
  /** Baseline keys on disk that no config render expects (stale baselines worth pruning). */
  orphans: string[];
  summary: { targets: number; expected: number; covered: number; gaps: number; orphans: number };
}

/**
 * Build the coverage map from the resolved render grid and the on-disk baseline keys (pure).
 * Duplicate keys in `renders` (two renders resolving to the same `<instance>/<target>/<state>@vw`)
 * collapse to a single cell — matching capture, which writes one PNG per key.
 */
export function buildCoverage(renders: RenderTarget[], baselineKeys: string[]): CoverageMap {
  const baselineSet = new Set(baselineKeys);
  const expectedKeys = new Set<string>();
  const groups = new Map<string, CoverageTarget>();

  for (const render of renders) {
    const key = renderKey(render);
    if (expectedKeys.has(key)) {
      continue; // a duplicate render maps to one baseline cell (capture overwrites by key)
    }
    expectedKeys.add(key);

    const groupKey = `${render.instance} ${render.name}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { instance: render.instance, target: render.name, cells: [], gaps: [] };
      groups.set(groupKey, group);
    }
    const covered = baselineSet.has(key);
    group.cells.push({ state: render.state, viewport: render.viewport, covered });
    if (!covered) {
      group.gaps.push({ state: render.state, viewport: render.viewport });
    }
  }

  const targets = [...groups.values()];
  const orphans = baselineKeys.filter((key) => !expectedKeys.has(key)).sort();
  const covered = targets.reduce(
    (total, target) => total + target.cells.filter((cell) => cell.covered).length,
    0,
  );

  return {
    targets,
    orphans,
    summary: {
      targets: targets.length,
      expected: expectedKeys.size,
      covered,
      gaps: expectedKeys.size - covered,
      orphans: orphans.length,
    },
  };
}

export interface CoverageOptions {
  /** Baseline directory; defaults to `config.baselineDir`. */
  baselineDir?: string;
}

export interface CoverageDeps {
  /** Injected fetch for Storybook discovery (defaults to the runtime global via resolveTargets). */
  fetch?: FetchLike;
  /** Injected baseline-dir walker (defaults to compare.ts `walkPngFiles`). */
  walk?: (dir: string) => string[];
}

/** Resolve the render grid + walk the baseline dir, then build the coverage map. */
export async function runCoverage(
  config: Config,
  options: CoverageOptions = {},
  deps: CoverageDeps = {},
): Promise<CoverageMap> {
  const baselineDir = options.baselineDir ?? config.baselineDir;
  const walk = deps.walk ?? walkPngFiles;
  const renders = await resolveTargets(config, deps.fetch);
  // walkPngFiles returns [] for a missing/unreadable dir, so no existsSync guard is needed (and
  // guarding on the real fs would defeat an injected `walk` in tests).
  const baselineKeys = walk(baselineDir);
  return buildCoverage(renders, baselineKeys);
}

// --- Text rendering -------------------------------------------------------

/** Render the coverage map as a human-readable matrix (x = covered, . = gap), per target. */
export function renderCoverageText(map: CoverageMap, baselineDir: string): string {
  const out: string[] = [];
  const { summary } = map;
  out.push(
    `${PREFIX}: ${summary.covered}/${summary.expected} cell(s) covered across ` +
      `${summary.targets} target(s) — ${summary.gaps} gap(s), ${summary.orphans} orphan(s) ` +
      `(baselines: ${baselineDir})`,
  );

  for (const target of map.targets) {
    const states = [...new Set(target.cells.map((cell) => cell.state))].sort();
    const viewports = [...new Set(target.cells.map((cell) => cell.viewport))].sort((a, b) => a - b);
    const lookup = new Map(target.cells.map((cell) => [`${cell.state}@${cell.viewport}`, cell.covered]));

    out.push("");
    out.push(`  ${target.instance}/${target.target}`);
    out.push(`    ${["state \\ vw", ...viewports.map(String)].join("  ")}`);
    for (const state of states) {
      const row = viewports.map((vw) => (lookup.get(`${state}@${vw}`) ? "x" : "."));
      out.push(`    ${[state, ...row].join("  ")}`);
    }
  }

  if (map.orphans.length > 0) {
    out.push("");
    out.push(`  orphan baselines (no config render expects these — consider pruning):`);
    for (const orphan of map.orphans) {
      out.push(`    · ${orphan}`);
    }
  }
  return `${out.join("\n")}\n`;
}

// --- CLI ------------------------------------------------------------------

export interface CoverageCliArgs {
  config: string;
  baselineDir?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): CoverageCliArgs {
  let config = "config/visual.config.json";
  let baselineDir: string | undefined;
  let json = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) {
      fail(`missing value for ${flag}.`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        config = value(++i, "--config");
        break;
      case "--baseline":
        baselineDir = value(++i, "--baseline");
        break;
      case "--json":
        json = true;
        break;
      default:
        fail(`unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  return { config, baselineDir, json };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.config);
  const baselineDir = args.baselineDir ?? config.baselineDir;
  const map = await runCoverage(config, { baselineDir });
  if (args.json) {
    console.log(JSON.stringify(map));
  } else {
    process.stdout.write(renderCoverageText(map, baselineDir));
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
