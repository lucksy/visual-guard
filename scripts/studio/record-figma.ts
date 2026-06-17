import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config";
import { readPngDimensions } from "../capture";
import { openDb, type DB } from "../lib/studio/db";
import {
  appendSnapshot,
  listComponents,
  markFigmaPending,
  setFigmaLink,
  upsertComponent,
  upsertVariant,
  type AppendSnapshotResult,
} from "../lib/studio/store";
import {
  figmaComponentKey,
  figmaImagePath,
  figmaMetaPath,
  studioDbPath,
  DEFAULT_OUT_ROOT,
} from "../lib/studio/keys";
import { parseFigmaMetadata, type FigmaComponent } from "../lib/studio/figma-nodes";
import { parseFigmaMeta, upsertFigmaMetaImage, type FigmaMeta } from "../lib/studio/figma-meta";
import { matchComponents, type CodeRef, type FigmaRef } from "../lib/studio/match";

/**
 * Component Studio Figma recorder (P2, SPEC §9.3 / §9.5). MCP tools are agent-callable only, so the
 * `/visual-sync` workflow's subagents call the Figma MCP (`get_metadata` / `get_screenshot`) and hand
 * the bytes + metadata to this CLI — the token-free analogue of an export script. Three modes
 * (`enumerate` / `match` / `record`), each a thin wrapper over an exported, unit-testable core. No
 * token, ever — Figma auth lives in the desktop app; only non-secret ids/names/paths are stored.
 */

const PREFIX = "Visual Guard record-figma";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

const toPosix = (path: string): string => path.split(sep).join("/");
const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

// --- enumerate -------------------------------------------------------------

/** Parse a `get_metadata` XML dump (at `metadataPath`) into the component nodes Studio cares about. */
export function enumerateFigma(metadataPath: string, cwd: string = process.cwd()): FigmaComponent[] {
  return parseFigmaMetadata(readFileSync(resolve(cwd, metadataPath), "utf8"));
}

// --- match -----------------------------------------------------------------

export interface ResolvedFigmaNode {
  nodeId: string;
  name: string;
  /** The component key this node should be recorded under (matched code key, or a figma-only key). */
  componentKey: string;
}

export interface MatchFigmaResult {
  resolved: ResolvedFigmaNode[];
  codeOnly: string[];
}

/**
 * Resolve each enumerated Figma component to the Studio component key it should record under, using
 * the DB's current code components + the override map. Matched → the code component's key (so figma
 * and code land in ONE row); unmatched → a figma-only key. `codeOnly` reports code with no design.
 */
export function matchFigma(opts: {
  db: DB;
  figmaComponents: { nodeId: string; name: string }[];
  fileKey: string;
  overrides: Record<string, string>;
}): MatchFigmaResult {
  const figmaRefs: FigmaRef[] = opts.figmaComponents.map((c) => ({
    nodeId: c.nodeId,
    name: c.name,
    fileKey: opts.fileKey,
  }));
  const codeRefs: CodeRef[] = listComponents(opts.db)
    .filter((c) => c.code_target !== null)
    .map((c) => ({ key: c.key, name: c.code_target ?? c.name }));
  const result = matchComponents(codeRefs, figmaRefs, opts.overrides);
  // Persist the link now (before capture), so a component whose design capture is later skipped (Figma
  // closed mid-run) is left figma-linked-but-uncaptured → marked figma-pending and resumed next run.
  for (const m of result.matched) {
    setFigmaLink(opts.db, m.code.key, opts.fileKey, m.figma.nodeId);
  }
  return {
    resolved: [
      ...result.matched.map((m) => ({
        nodeId: m.figma.nodeId,
        name: m.figma.name,
        componentKey: m.code.key,
      })),
      ...result.figmaOnly.map((f) => ({
        nodeId: f.nodeId,
        name: f.name,
        componentKey: figmaComponentKey(f.fileKey, f.nodeId),
      })),
    ],
    codeOnly: result.codeOnly.map((c) => c.key),
  };
}

// --- record ----------------------------------------------------------------

export interface RecordFigmaOptions {
  db: DB;
  componentKey: string;
  fileKey: string;
  nodeId: string;
  name: string;
  /** The captured Figma node screenshot bytes (PNG). */
  bytes: Buffer;
  baselineDir: string;
  variant?: string;
  viewport?: number;
  figmaVersionId?: string;
  description?: string;
  cwd?: string;
}

export type RecordFigmaResult = AppendSnapshotResult & { componentKey: string; path: string };

function readMeta(metaAbs: string): FigmaMeta {
  if (!existsSync(metaAbs)) {
    return { version: 1, files: [] };
  }
  return parseFigmaMeta(JSON.parse(readFileSync(metaAbs, "utf8")));
}

/**
 * Commit one captured Figma baseline under `<baselineDir>/.figma/`, dedupe-append its `source='figma'`
 * snapshot to the DB (under the resolved component key, adding the figma linkage), and merge the entry
 * into the committed `figma_meta.json` so a reindex can rebuild it. Content-hash deduped: identical
 * bytes add no new history row. Returns the append result + the committed path.
 */
export function recordFigma(opts: RecordFigmaOptions): RecordFigmaResult {
  const cwd = opts.cwd ?? process.cwd();
  const hash = sha256(opts.bytes);
  const dims = readPngDimensions(opts.bytes);

  // Commit the Figma baseline PNG (the diffable, team-shared source of truth).
  const committedRel = figmaImagePath(opts.baselineDir, opts.fileKey, opts.nodeId, opts.variant, opts.viewport);
  const committedAbs = resolve(cwd, committedRel);
  mkdirSync(dirname(committedAbs), { recursive: true });
  writeFileSync(committedAbs, opts.bytes);

  const componentId = upsertComponent(opts.db, {
    key: opts.componentKey,
    name: opts.name,
    description: opts.description ?? null,
    figmaFileKey: opts.fileKey,
    figmaNodeId: opts.nodeId,
  });
  const variantId = upsertVariant(opts.db, {
    componentId,
    source: "figma",
    name: `${opts.variant ?? "default"}@${opts.viewport ?? 0}`,
  });
  const result = appendSnapshot(opts.db, {
    componentId,
    variantId,
    source: "figma",
    imagePath: toPosix(committedRel),
    imageHash: hash,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    viewport: opts.viewport ?? null,
    figmaVersionId: opts.figmaVersionId ?? null,
    approved: true,
  });
  // (Intentionally no recomputeStatus here: a Figma capture must not touch the code regression rollup,
  // and figma_vs_code conformance is a P5 axis. The code status is owned by the code sync.)

  // Keep the committed figma_meta.json index in sync so a reindex can rebuild this baseline.
  const metaAbs = resolve(cwd, figmaMetaPath(opts.baselineDir));
  const merged = upsertFigmaMetaImage(readMeta(metaAbs), {
    fileKey: opts.fileKey,
    nodeId: opts.nodeId,
    name: opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    image: {
      path: toPosix(committedRel),
      ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
      ...(opts.viewport !== undefined ? { viewport: opts.viewport } : {}),
      ...(opts.figmaVersionId !== undefined ? { figmaVersionId: opts.figmaVersionId } : {}),
    },
  });
  mkdirSync(dirname(metaAbs), { recursive: true });
  writeFileSync(metaAbs, `${JSON.stringify(merged, null, 2)}\n`);

  return { ...result, componentKey: opts.componentKey, path: toPosix(committedRel) };
}

// --- CLI ------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = argv[i + 1];
  if (value === undefined) {
    fail(`missing value for ${name}.`);
  }
  return value;
}

function required(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (value === undefined) {
    fail(`${name} is required.`);
  }
  return value;
}

function parseViewport(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`--viewport must be a non-negative integer (got ${JSON.stringify(raw)}).`);
  }
  return n;
}

function main(argv: string[]): void {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "enumerate") {
    const components = enumerateFigma(required(rest, "--metadata"));
    console.log(JSON.stringify({ command: "enumerate", components }));
    return;
  }

  if (command === "pending") {
    const outRoot = flag(rest, "--out") ?? DEFAULT_OUT_ROOT;
    const db = openDb(studioDbPath(outRoot));
    try {
      const flipped = markFigmaPending(db);
      console.log(JSON.stringify({ command: "pending", flipped }));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "match") {
    const config = loadConfig(flag(rest, "--config") ?? "config/visual.config.json");
    const outRoot = flag(rest, "--out") ?? DEFAULT_OUT_ROOT;
    const figmaJson = JSON.parse(readFileSync(resolve(required(rest, "--figma")), "utf8")) as {
      components?: { nodeId: string; name: string }[];
    };
    const db = openDb(studioDbPath(outRoot));
    try {
      const out = matchFigma({
        db,
        figmaComponents: figmaJson.components ?? [],
        fileKey: required(rest, "--file-key"),
        overrides: config.figma?.componentMap ?? {},
      });
      console.log(JSON.stringify({ command: "match", ...out }));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "record") {
    const outRoot = flag(rest, "--out") ?? DEFAULT_OUT_ROOT;
    const baselineDir = flag(rest, "--baseline") ?? loadConfig(flag(rest, "--config") ?? "config/visual.config.json").baselineDir;
    const bytes = readFileSync(resolve(required(rest, "--image")));
    const db = openDb(studioDbPath(outRoot));
    try {
      const out = recordFigma({
        db,
        componentKey: required(rest, "--component-key"),
        fileKey: required(rest, "--file-key"),
        nodeId: required(rest, "--node-id"),
        name: required(rest, "--name"),
        bytes,
        baselineDir,
        variant: flag(rest, "--variant"),
        viewport: parseViewport(flag(rest, "--viewport")),
        figmaVersionId: flag(rest, "--figma-version"),
        description: flag(rest, "--description"),
      });
      console.log(JSON.stringify({ command: "record", ...out }));
    } finally {
      db.close();
    }
    return;
  }

  fail(`expected a command: "enumerate", "match", "record", or "pending" (got ${JSON.stringify(command ?? "")}).`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
