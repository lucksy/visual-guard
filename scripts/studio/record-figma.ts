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
  recordFigmaCodeLink,
  recordRenameEvent,
  rollupLifecycle,
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
import { axesToJson, parseVariantAxes } from "../lib/studio/variant-axes";
import { withFileLock, writeFileAtomic } from "../lib/studio/file-lock";

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
  /** v5 (F5): the Figma node's lastModified (ISO8601) from get_metadata — drives staleness detection. */
  lastModified?: string;
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

  // F1: the durable node↔code mapping. `componentKey` is the matched CODE key for a matched node, or the
  // `figma/<fileKey>/<nodeId>` fallback for a figma-only node. Persist `codeKey` into figma_meta.json ONLY
  // for the matched case, so a reindex can re-link the rebuilt DB; a figma-only node carries no codeKey.
  const figmaOnlyKey = figmaComponentKey(opts.fileKey, opts.nodeId);
  const codeKey = opts.componentKey !== figmaOnlyKey ? opts.componentKey : undefined;

  const metaAbs = resolve(cwd, figmaMetaPath(opts.baselineDir));

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
    figmaLastModified: opts.lastModified ?? null,
  });
  // Mirror the node↔code edge into the durable link table (a bonus of the figma_meta.json codeKey).
  if (codeKey !== undefined) {
    recordFigmaCodeLink(opts.db, {
      figmaFileKey: opts.fileKey,
      figmaNodeId: opts.nodeId,
      componentKey: codeKey,
    });
  }
  // F4: persist the parsed Figma variant-axis labels (e.g. "State=Hover" → {State:"Hover"}) that the
  // `variant@viewport` lane key alone discards, so the advisory axis set-diff can use them.
  const figmaAxes = parseVariantAxes(opts.variant ?? "default");
  const variantId = upsertVariant(opts.db, {
    componentId,
    source: "figma",
    name: `${opts.variant ?? "default"}@${opts.viewport ?? 0}`,
    propsJson: axesToJson(figmaAxes),
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
    figmaLastModified: opts.lastModified ?? null,
    approved: true,
  });
  // (Intentionally no recomputeStatus here: a Figma capture must not touch the code regression rollup,
  // and figma_vs_code conformance is a P5 axis. The code status is owned by the code sync.)
  // F1/F3: derive lifecycle from presence now, so a figma-only node lands at `figma-only` (and a matched
  // node confirms `matched`) on a LIVE /visual-sync — not only after a reindex. (The single rollup point
  // for the figma record path; the code sync rolls up its own touched set.)
  rollupLifecycle(opts.db, componentId);

  // Keep the committed figma_meta.json index in sync so a reindex can rebuild this baseline. ALL of the
  // meta access — the rename-name read, the per-node merge, and the write — happens inside ONE
  // cross-process lock (figma_meta.json is shared, and /visual-sync fans out concurrent recorder
  // SUBPROCESSES), with an atomic temp+rename write. This is what stops two concurrent recorders from
  // clobbering each other's just-added entry (last-writer-wins would silently drop a committed baseline,
  // since reindex rebuilds the Figma side from this meta alone). The rename event is collected here and
  // emitted to the DB AFTER releasing, so the lock only ever holds pure-filesystem work.
  let figmaRenameFrom: string | undefined;
  withFileLock(metaAbs, () => {
    const meta = readMeta(metaAbs);
    // F2: figma-side rename — the SAME node id (the stable anchor) now carries a different display name
    // than the committed meta recorded. The merge below adopts the new name (so a re-record in the same
    // run won't re-fire). A brand-new node (no prior name) is not a rename.
    const priorFigmaName = meta.files
      .find((f) => f.fileKey === opts.fileKey)
      ?.components.find((c) => c.nodeId === opts.nodeId)?.name;
    if (priorFigmaName !== undefined && priorFigmaName !== opts.name) {
      figmaRenameFrom = priorFigmaName;
    }
    const merged = upsertFigmaMetaImage(meta, {
      fileKey: opts.fileKey,
      nodeId: opts.nodeId,
      name: opts.name,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      // F1: matched → persist the codeKey; figma-only → explicitly CLEAR it (null), so a node that was
      // previously matched but is now unmatched can't keep a stale codeKey that wrongly re-links on reindex.
      codeKey: codeKey ?? null,
      ...(opts.lastModified !== undefined ? { lastModified: opts.lastModified } : {}),
      image: {
        path: toPosix(committedRel),
        ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
        ...(opts.viewport !== undefined ? { viewport: opts.viewport } : {}),
        ...(opts.figmaVersionId !== undefined ? { figmaVersionId: opts.figmaVersionId } : {}),
        ...(Object.keys(figmaAxes).length > 0 ? { axes: figmaAxes } : {}),
        ...(opts.lastModified !== undefined ? { figmaLastModified: opts.lastModified } : {}),
      },
    });
    writeFileAtomic(metaAbs, `${JSON.stringify(merged, null, 2)}\n`);
  });
  if (figmaRenameFrom !== undefined) {
    recordRenameEvent(opts.db, {
      side: "figma",
      componentId,
      figmaFileKey: opts.fileKey,
      figmaNodeId: opts.nodeId,
      fromName: figmaRenameFrom,
      toName: opts.name,
      anchor: "figma-node-id",
      confidence: 1,
      resolution: "applied",
    });
  }

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
        lastModified: flag(rest, "--last-modified"),
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
