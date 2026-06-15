# Component Studio — SPEC

> **Status:** Proposed (design complete, not yet implemented)
> **Companion:** [`PLAN.md`](./PLAN.md) — the phased implementation plan
> **Scope:** turns Visual Guard from a self-regression screenshot tool into a **design-system
> parity tool**: for every component, a **Figma baseline** (the design, with history) *and* a
> **code baseline** (the rendered implementation, with history), a **current** state, a **status**,
> and a bundled, interactive **web app** to browse it all.

---

## 1. TL;DR

Today a Visual Guard "baseline" is the first approved screenshot of your *own* rendered UI — it
answers **"did my UI change since I last approved it?"** (self-regression). It knows nothing about
Figma.

Component Studio adds the **design** as a first-class source. For each component we keep two
independent, versioned image streams:

- **Figma baseline** — the component exported from Figma, with history.
- **Code baseline** — the component rendered from Storybook/your app, with history.

…and we show them side by side, per component, in a bundled localhost web app with a **timeline**
(scrub backward through history), **variants** (from Figma *and* code), **where it's used**, and a
**status** badge (In sync · Changed · Figma-only · Code-only · New). It is **plug-and-play**:
code-only works with zero Figma config; connecting Figma is an additive, consent-gated step.

**One honest framing up front:** *regression* (code vs. its own previous render) is a hard,
trustworthy pixel check — that's the existing engine. *Conformance* (code vs. Figma) is **advisory
only** — font hinting, anti-aliasing, and intentional implementation latitude mean code never
matches a design pixel-for-pixel, so we present it as an **overlay + a tolerant signal**, never a
pass/fail gate, and **never** a CI gate.

---

## 2. Problem & vision

**Problem.** A design system has two sources of truth that drift: the **Figma library** (what
designers maintain) and the **coded components** (what ships). Today nothing in Visual Guard sees
the design side, so "is the Button in code still the Button in Figma?" and "what's designed but not
built / built but not in Figma?" are invisible. Designers and developers can't see parity at a
glance, and there's no shared history of how a component evolved on either side.

**Vision.** A single, local, plug-and-play tool where a design-system team opens one screen and
immediately sees every component with its **design** beside its **implementation**, the **drift**
between them, the **history** of both, and the **gaps** (designed-not-built, built-not-in-Figma).

---

## 3. Personas & top user stories

| Persona | Story |
|---|---|
| **DS engineer** | "Show me which coded components have drifted from their Figma design, and let me scrub the history of each to see when." |
| **DS designer / owner** | "Show me what's been **designed but not yet built**, and what's **built but missing from the library** — that's my backlog." |
| **Reviewer** | "On this PR, did any component visually regress vs. its last approved code baseline?" (today's job, now per-component with history.) |
| **New contributor** | "Open the studio, browse every component, its variants, and where it's used — a living catalog." |

---

## 4. What it is

1. **Per-component dual baselines with history.** A `snapshots` timeline per component per source
   (`figma` / `code`), plus the live `current` render. Newest = current; scrub left to go back.
2. **A status per component** rolling up presence + drift across both sources.
3. **A bundled web app** (localhost-only, no build step) — a gallery of components and a detail
   page with the timeline, the Figma‖Code comparison, variants, and usages.
4. **A sync** that populates both streams (Figma via the **Figma MCP**, code via the existing
   capture engine).

It is built **on top of** the existing engine (`capture.ts`, `compare.ts`/`diff.ts`,
`baseline.ts`, `config.ts`, the `install-deps.mjs` bootstrap + `/visual-setup` consent gate) — not a
rewrite. Code baselines stay exactly where they live today (`.visual-baselines/`); Figma is additive.

---

## 5. Scope

**In scope (v1):**
- Figma access via the **Figma MCP** (`mcp__figma-desktop`) — **no token**, no rate limits; an
  availability check (is the Figma desktop app open?).
- **Multi-Figma-file** libraries (`figma.files: [{ key, label? }]`).
- Local SQLite index of components, variants, usages, snapshots (history), and comparisons.
- An **agent-driven** sync (`/visual-sync`) that captures Figma component images via the MCP
  (fanned out across subagents) and renders code components via the engine, recording both.
- The bundled web app: gallery + component detail (timeline, comparison, variants, usages).
- Component-level Figma↔code matching (normalized name + an override map).
- Code-vs-code **regression** (the existing pixel gate) and Figma-vs-code **conformance** (advisory).

**Out of scope (v1) — see [Non-goals](#15-non-goals):**
- The **REST API + PAT** provider, and therefore **headless / CI / server-triggered Figma sync**
  (the Figma side is interactive-only; code regression still runs headless/CI). REST is a designed-for
  future provider if CI design-parity is ever needed.
- Per-variant cross-source linking / parity badges (variants are listed side-by-side per source).
- Figma-side "where used" (only code usage via grep in v1).
- Conformance as a CI gate (it is advisory, forever).
- App-route (non-Storybook) targets as Studio components (Studio is Storybook-centric for v1).

---

## 6. Key architecture decisions (resolved)

These settle the cross-cutting forks (several of which the design's own review flagged as
contradictory across sub-designs). Each is a **decision**, not an option.

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | **Figma access = the Figma MCP** (`mcp__figma-desktop`: `get_metadata` to enumerate component nodes, `get_screenshot` per node for the design image, `get_variable_defs` for tokens). **No token, no rate limits.** | Truly plug-and-play — no secret to create/store/scrub, no rate ceiling, already configured in this environment. MCP tools are agent-callable, which makes the "dynamic workflow" fan-out the *correct* parallelism. | REST API + PAT: headless + CI-capable + bulk-batch, **but** needs a token and hits a 10–20/min rate limit. Kept as a **designed-for future provider** for CI design-parity. |
| D2 | **No secret to manage.** Figma auth lives entirely in the desktop app / MCP session; Studio reads designs through MCP tool calls and stores only **images + non-secret metadata** (node ids, names, variant defs). Nothing sensitive is ever written to config, the DB, logs, or thumbnails. | Eliminates the entire token-handling/security surface — the single biggest simplification of choosing MCP. | REST would reintroduce a PAT + `.visual-guard.env` + masking/scrubbing — deliberately avoided. |
| D3 | **Source of truth = committed PNGs + a committed `figma_meta.json`; the SQLite DB is a gitignored, rebuildable index.** | Satisfies "history is **team-shared**" (a teammate clones and has the history) while avoiding binary-DB merge conflicts. `reindex` rebuilds the DB from the committed artifacts. | Commit the DB (binary churn/conflicts); store history only in the gitignored data dir (per-machine — breaks team-shared history). |
| D4 | **SQLite driver = `better-sqlite3`**, shipped through the existing `ENGINE_DEPS` bootstrap. | The repo's Node floor is **20**, so `node:sqlite` (Node 22+, experimental) is not reliably present. `better-sqlite3` is native — but the repo **already** ships a native module (`sharp`) through the same bridge, so the risk is proven-solved. Sync API matches the engine's pure-lib style. | `node:sqlite` (not available at Node 20); `sql.js` (re-serializes whole DB per write); JSON store (no indexed history queries). |
| D5 | **Parallelism = a dynamic Workflow fanning out subagents that call the Figma MCP.** MCP tools are **agent-callable only** (a plain `tsx` script can't invoke them), so the right model for "capture many components fast" is the Workflow tool fanning out subagents, each capturing a batch of component nodes via the MCP and recording snapshots through the engine. Code capture stays in the engine (Playwright). | Exactly what the Workflow runtime is for (orchestrating subagents) — and it finally makes the original "use dynamic workflows to speed up Figma access" the *correct* tool. No rate limit to bound; cap fan-out at the workflow's concurrency default. | A serial in-process loop (and a non-agent script can't call MCP anyway). |
| D6 | **Two comparison axes, separated.** `current_vs_baseline` (code vs. its previous code) = the existing **pixelmatch regression** gate (valid, trustworthy). `figma_vs_code` = **conformance**, shown as overlay + a tolerant dimension/palette signal — **advisory only, never a gate, never CI**. | Cross-source pixel diff is noise (Figma renders at intrinsic size/scale 2; code at a viewport width — the engine crops to the top-left intersection, so a naive diff is ~100% bogus). | Reusing `compare.ts` pixelmatch for Figma-vs-code (would ship a "Diff" tab that lies). |
| D7 | **Matching = explicit override map > normalized-name match > surfaced as `figma-only`/`code-only`.** Component-level only in v1; variants listed side-by-side per source (no cross-source variant link). User-overridable in the UI. | Honest "unmatched" beats a wrong silent match in a DS tool; normalization handles the common case with zero input. | Fuzzy/AI auto-match (silent wrong pairs); exact-name only (everything unmatched). |
| D8 | **Web app = prebuilt, zero-build, committed vanilla-ES-module SPA** served by a tiny `node:http` server (run via the bundled `tsx`, **no new deps**). | "Ships inside a plugin, no per-user build step." A 2-screen app needs no framework; CSS custom properties give theming with zero runtime. | React/Vite (build step + committed bundle); Express (transitive-dep weight). Preact is a documented maintainer-side upgrade path. |
| D9 | **Server: loopback-only (`127.0.0.1`), OS-assigned port, launched backgrounded/detached, pidfile single-instance.** The page makes **zero external calls** — it's a pure consumer of already-captured images (and there's no token anywhere to leak). | A foreground `listen()` would hang the agent turn; loopback + CSP = minimal surface. | Foreground server (hangs the turn); `0.0.0.0` (LAN exposure). |
| D10 | **Config grows by an additive, validated `figma?` block** (`parseFigma`, mirroring `parseTokens`). Absent `figma` = today's code-only behavior, byte-for-byte. | Backward compatibility must be **proven** (parseConfig returns a fixed object and drops unknown keys), not assumed. | Asserting "compatible by construction" (false); a separate config file (drift). |
| D11 | **Multi-Figma-file in v1:** `figma.files: [{ key, label? }]` (a single `fileKey` string accepted as a one-file shorthand). Matching is namespaced per file; the gallery gets a library filter. | A design system often spans several Figma files; supporting it now avoids a later schema break. | Single-file only (a real DS outgrows it). **MCP caveat:** the MCP is bound to the *currently-open* desktop file, so `/visual-sync` syncs the open file and maps it by key — see §8. |

---

## 7. Data model

`better-sqlite3`, single file at `.visual-guard/studio.db` (gitignored, rebuildable via
`reindex`). The **source of truth** is the committed PNGs + `.visual-baselines/figma_meta.json`.

### Image layout

```
# COMMITTED (source of truth)
.visual-baselines/<instance>/<target>/<state>@<viewport>.png            # approved CODE baselines (unchanged today)
.visual-baselines/.figma/<fileKey>/<nodeId>/<variant>@<viewport>.png    # approved FIGMA baselines (new; namespaced under .figma/)
.visual-baselines/figma_meta.json                                       # figma ids/versions/variant defs (committed, diffable JSON)

# GITIGNORED (derived/transient, under the existing .visual-guard/ boundary)
.visual-guard/studio.db                                                 # the SQLite index (rebuildable)
.visual-guard/cache/blobs/<sha256>.png                                  # content-addressed: current renders + unapproved Figma pulls
```

### Schema (essential tables)

```sql
PRAGMA journal_mode = WAL;     -- local server reads while a capture writes
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;        -- migration counter

CREATE TABLE components (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,              -- stable slug, e.g. "buttons/primary-button"
  name TEXT NOT NULL,
  description TEXT,
  figma_file_key TEXT, figma_node_id TEXT,           -- Figma linkage (nullable)
  code_instance TEXT, code_target TEXT, story_id TEXT,-- code linkage (nullable)
  status TEXT NOT NULL DEFAULT 'unknown'              -- denormalized rollup (recomputed)
    CHECK (status IN ('same','changed','regression','new','error','unknown')),
  parity_status TEXT                                  -- figma↔code axis (nullable: no figma link)
    CHECK (parity_status IS NULL OR parity_status IN ('same','changed','regression','new','error','unknown')),
  sync_state TEXT NOT NULL DEFAULT 'synced'           -- resumable-sync state (see §9.5)
    CHECK (sync_state IN ('synced','figma-pending','code-pending','error')),
  last_attempt_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE variants (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('figma','code')),
  name TEXT NOT NULL,                    -- "size=lg, state=hover" or a story name
  props_json TEXT, figma_node_id TEXT, story_id TEXT,
  UNIQUE (component_id, source, name)
);

CREATE TABLE component_usages (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('code-import','figma-instance','route','story','doc')),
  used_in TEXT NOT NULL, detail TEXT,
  UNIQUE (component_id, kind, used_in)
);

-- THE TIMELINE TABLE — append-only; powers both histories + the timeline control.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,   -- NULL = default
  source TEXT NOT NULL CHECK (source IN ('figma','code','current')),
  image_path TEXT NOT NULL,              -- repo-relative
  image_hash TEXT NOT NULL,              -- sha256 (content address / dedupe)
  width INTEGER, height INTEGER, viewport INTEGER,
  version_seq INTEGER NOT NULL,          -- writer-assigned, monotonic per (component,variant,source)
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  figma_version_id TEXT, git_sha TEXT,
  approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),   -- 1 = baseline
  UNIQUE (component_id, variant_id, source, version_seq)
);
CREATE INDEX idx_snapshots_timeline ON snapshots(component_id, source, variant_id, version_seq DESC);
CREATE INDEX idx_snapshots_hash ON snapshots(image_hash);

CREATE TABLE regressions (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK (axis IN ('current_vs_baseline','figma_vs_code')),
  from_snapshot INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  to_snapshot   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  diff_ratio REAL,                       -- 0..1 from diff.ts (NULL for new/error)
  status TEXT NOT NULL CHECK (status IN ('same','changed','regression','new','error')),
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

**Key writer rules:** `version_seq` is assigned inside a `BEGIN IMMEDIATE` transaction (monotonic,
race-safe via the `UNIQUE` constraint). A snapshot row is appended **only when the sha256 differs**
from the latest in its lane — so the timeline has **one tick per real visual change**, never one per
re-run (this is why no "collapse identical ticks" mechanism is needed).

### Status mapping (one source of truth with the engine)

| engine `ComparisonStatus` | `regressions.status` | `components.status` |
|---|---|---|
| `pass` | `same` | `same` |
| `fail` (ratio > maxDiffRatio or dim delta) | `regression` | `regression` |
| `new` (no baseline) | `new` | `new` |
| `error` | `error` | `error` |
| `0 < ratio ≤ maxDiffRatio` | `changed` | `changed` (informational, below the gate) |

---

## 8. Figma access (via the Figma MCP)

Studio reads Figma through the **Figma desktop MCP** (`mcp__figma-desktop`) — **no token, no REST,
no rate limit.** Auth is whatever the user is already signed into in the Figma desktop app.

**MCP tools used:**

| Purpose | MCP tool | Notes |
|---|---|---|
| Enumerate components | `get_metadata` | returns the node tree of the open file / a node subtree; we pick `type===COMPONENT`/`COMPONENT_SET` nodes (a set = a component, its children = variants). |
| Capture the design image | `get_screenshot` | a faithful render of a node by id → the **Figma baseline** PNG (no expiring-URL/rate-limit concerns). |
| Tokens / variables | `get_variable_defs` | design-token values for the component (feeds the existing token features). |
| Extra context | `get_design_context` | optional richer node context for descriptions / props. |

**Availability check (the honest "can we reach Figma?"):** before a sync, probe that the
`mcp__figma-desktop` server is present and a file is open (a cheap `get_metadata`). If it isn't,
**stop with an actionable message**: *"Open your Figma file in the Figma desktop app, then re-run
`/visual-sync`."* (Per the runtime's own caveat, an interactively-authenticated MCP may be absent in
headless/cron runs — which is exactly why the Figma side is interactive-only and there's no CI parity.)

**No secret, no security surface.** There is no PAT, no `.visual-guard.env`, no masking/scrubbing.
Studio persists only **images + non-secret metadata** (node ids, names, variant defs). This is the
biggest simplification of choosing MCP over REST.

**File key + multi-file (D11):** config lists `figma.files: [{ key, label? }]`. A pasted Figma URL
is normalized to a bare key with one regex (`figma.(com|site)/(file|design|board|proto|slides)/<key>`)
for convenience. **Because the MCP is bound to the *currently-open* desktop file,** `/visual-sync`
syncs the file that is open, identifies it by its key, and maps it to the matching `figma.files`
entry; to sync several files the user opens each and re-runs (or runs `/visual-sync <label>`). The
stored key is non-secret and committed in `visual.config.json`.

---

## 9. Capture / sync pipeline

### 9.1 Enumeration
- **Code side:** reuse `targets.ts` Storybook `/index.json` discovery — a story title's last
  segment is the **component**, each story is a **variant/state** (the existing `componentFromTitle`
  grouping). Engine-driven, headless.
- **Figma side (via MCP):** `get_metadata` on the open file → pick `COMPONENT` / `COMPONENT_SET`
  nodes (a set = a component, its child components = variants). Agent-driven.

### 9.2 Matching (D7)
Override map wins → normalized-name match (Figma node name ↔ code component name) → leftovers
surfaced as `figma-only` / `code-only` (never dropped). Accepted pairs persist as
`figma.componentMap`. Component-level only in v1.

### 9.3 The concurrency model (D5)
- **Figma capture = the `/visual-sync` dynamic Workflow fanning out subagents over the MCP.** MCP
  tools are agent-callable only, so this is both the correct *and* the fast model: `get_metadata`
  enumerates once, then subagents capture batches of component nodes in parallel via `get_screenshot`,
  saving each PNG and recording its snapshot through the engine. No rate limit to bound; fan-out is
  capped at the workflow's concurrency default. *(This is the "use dynamic workflows to speed up
  Figma access" idea — now the right tool, because MCP is agent-driven.)*
- **Code capture = the engine** (`capture.ts` / Playwright), driven by `scripts/studio/sync.ts`
  (headless-capable, reused unchanged).

### 9.4 Compare (D6)
- `current_vs_baseline` = `diff.ts` pixelmatch vs. the previous **code** snapshot → real regression.
- `figma_vs_code` = a **tolerant conformance** signal (dimension delta + coarse palette/dominant-
  color distance via `sharp` downscale + `culori`) → `aligned | minor | divergent`, **advisory**.
  Presented as overlay + side-by-side; **never** a pass/fail, **never** wired into `/visual-ci`.

### 9.5 Idempotency, incremental, resumable
- Content-hash dedupe: identical bytes → no new history row.
- Incremental: code re-render keyed on Storybook story-set hash + `uiGlobs` mtime (reuse
  `detect-ui-change.mjs`); Figma re-capture relies on **content-hash dedupe** (an identical
  screenshot adds no history row), and skips unchanged nodes when `get_metadata` exposes a node
  `lastModified`.
- Resumable: per-component `sync_state` (`synced | figma-pending | code-pending | error`); a
  re-run retries only non-synced rows. A partial sync is a clearly-labeled valid state, never a
  silent half-truth. (Figma sync requires the desktop app open; if it's closed mid-run, the
  remaining components stay `figma-pending` and `/visual-sync` resumes them next time.)

---

## 10. Web app architecture

- **Server:** `scripts/studio/server.ts` — tiny `node:http`, run via bundled `tsx`, **no new deps**.
  `server.listen(0, "127.0.0.1")` (loopback, ephemeral port), pidfile single-instance guard, launched
  **backgrounded/detached** so the agent turn completes; SIGINT/SIGTERM closes server + DB + pidfile.
- **API (read-mostly):** `GET /api/health`, `/api/components` (`?status=&q=`),
  `/api/components/:id`, `/api/components/:id/history?source=`, `/api/components/:id/variants`,
  `/api/snapshots/:id`, `/api/snapshots/:id/image` (PNG stream, immutable cache). `POST /api/sync`
  triggers a sync. Error contract `{ error: { code, message } }`.
- **Image serving:** by DB key, **path-confined** — normalize and hard-refuse any path outside
  `.visual-baselines/` or `.visual-guard/` (mirrors `baseline.ts`; a `..`-escape test is mandatory).
- **Security:** CSP `default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self';
  object-src 'none'; base-uri 'none'`. The browser makes **zero external calls** — there is no token
  anywhere, and the page only consumes already-captured local images.
- **Sync button:** `POST /api/sync` re-runs the **code** capture (engine, headless). The **Figma**
  capture needs the MCP (agent-only), so the button's Figma action is "run `/visual-sync` in Claude
  Code (Figma desktop open)" rather than a server-triggered fetch.
- **Freshness:** manual Refresh + re-query on window focus; SSE is a later additive upgrade.

---

## 11. Web app UX

### 11.1 Status vocabulary (the badge)
Five component-level statuses, layered on the engine's per-image `pass|new|error|fail` (which still
drives the Diff caption):

| Status | Meaning | Color |
|---|---|---|
| **In sync** | Figma ≈ Code (≤ threshold) | green |
| **Changed** | both exist, differ above threshold | amber |
| **Figma-only** | designed, not built | blue |
| **Code-only** | built, not in the library | gray |
| **New** | first sync, no history yet | indigo (accent) |

Status is always **dot + word** (never color alone) for colorblind-safety.

### 11.2 Gallery (default screen)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  ◧ Component Studio   Acme Design System            ⟳ Synced 4m ago   [ ⟳ Sync ] ◐  │
├───────────────────────────────────────────────────────────────────────────────────┤
│  🔍 Search…                              Status ▾  | Sort: Urgency ▾  | ▦ ▤          │
│  [ All 48 ] [ In sync 31 ] [ Changed 9 ] [ Figma-only 5 ] [ Code-only 2 ] [ New 1 ] │
├───────────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐   │
│  │ ┌────────┬────────┐    │  │ ┌────────┬────────┐    │  │ ┌────────┬────────┐    │   │
│  │ │ FIGMA  │  CODE  │    │  │ │ FIGMA  │  CODE  │    │  │ │ FIGMA  │  CODE  │    │   │
│  │ └────────┴────────┘    │  │ └────────┴────────┘    │  │ └────────┴────────┘    │   │
│  │ Button        ● Changed│  │ Card          ●In sync │  │ Tooltip    ●Figma-only │   │
│  │ Primary action trigger │  │ Content container      │  │ Hover hint popover     │   │
│  │ 4 variants · used 23×  │  │ 3 variants · used 12×  │  │ 2 variants · used 0×   │   │
│  └───────────────────────┘  └───────────────────────┘  └───────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- Dual thumbnail per card (Figma | Code) on a checkerboard (transparent PNGs read correctly).
- Missing-baseline halves show a dashed "No code render" / "Not in Figma" so the grid stays stable.
- **Hero metric on first open:** the *Figma-only* and *Code-only* counts (designed-not-built /
  built-not-in-Figma) are a DS owner's most valuable immediate signal — surfaced as headline
  filter chips, plus a per-card and per-source "last synced" freshness so a stale DB can't
  masquerade as trustworthy.
- Whole card = one `<a>` → detail; `aria-label="Button, status Changed, 3.1% diff, 4 variants"`.

### 11.3 Component detail (timeline + comparison + variants + usages)

```
│  ‹ Back            Button                            ● Changed   pixel diff 3.18%   │
├───────────────────────────────────────────────────────────────────────────────────┤
│  TIMELINE                                                       ◀ older   newer ▶   │
│  ●───────●──────────●─────────●────────────●────────────────────────[◉]            │  ← playhead ◉ = Current (right)
│  v1.0    v1.1       v1.2      v1.3 (amber=changed)  v1.4               Current       │
│  Viewing: Current (Jun 14 · code 4d77ab · figma v28)            [ Compare to ▾ ]    │
├───────────────────────────────────────────┬─────────────────────────────────────────┤
│  VIEW: [F][C][Side-by-side][Overlay][Diff] │  VARIANT  [Default][Hover][Disabled][Loading⚠]│
│  ┌──────────────────┬──────────────────┐  │  DESCRIPTION  Primary action trigger…   │
│  │   FIGMA (v28)    │   CODE (4d77ab)   │  │  USED IN (23)  LoginPage.tsx · …        │
│  └──────────────────┴──────────────────┘  │  RELATED  IconButton · ButtonGroup      │
│   ● Changed · spacing drift (padding-y)    │  VARIANTS PARITY                        │
│   [Overlay] Figma ──●──── Code  58%        │   Loading ▸ in Figma, no code story ⚠   │
└────────────────────────────────────────────┴─────────────────────────────────────────┘
```

- **Timeline:** an ARIA `slider`, one tick per stored snapshot, **newest pinned right = Current**,
  amber tick where status changed; `←/→` step, `Shift+←/→` jump to changed, `Home/End` ends; each
  tick carries `{version, date, git sha, figma version}` provenance.
- **Comparison:** default Side-by-side; toggles `F C S O D`. **Overlay (opacity blend) is the
  default honest view for Figma-vs-code**; the **Diff** toggle is labeled clearly as *code
  regression (vs previous code)* so anti-aliasing noise is never misread as a design violation.
- **Variants:** union of Figma + code variants with origin chips (`Figma+Code` / `Figma only ◆` /
  `Code only ◇`); selecting one re-renders the comparison + timeline. (Per-variant *parity linking*
  is v2 — see Non-goals.)
- **Launchpad:** per side, "Open in Figma" (deep link via `fileKey`+`node-id`) and "Open the story"
  (Storybook iframe URL) — the studio launches you into the real tools.

### 11.4 Visual design system (minimal, professional)
CSS custom properties only, no UI kit: a 10-step cool-neutral gray ramp + a single **indigo accent**
+ 6 status colors; system font stack; **14px** base; 4px spacing scale; 2 radii (`6px`/`10px`); two
subtle shadows (borders at rest, shadow on hover); full **light + dark** via `[data-theme]` honoring
`prefers-color-scheme`; `prefers-reduced-motion` disables shimmer/scrub animation. Every text/bg
pair meets **WCAG AA**.

### 11.5 States & a11y
First-run panel ("Open your Figma file in the desktop app, then run `/visual-sync`" — no token to
enter), streaming skeleton cards during sync (cards resolve in place — value appears within
seconds), empty-filter, and **inline, non-blocking** errors (Figma desktop not open / MCP
unavailable → code halves still render, Figma halves show "Open Figma & run /visual-sync";
per-component sync-failed retry; code-render-missing shows the URL it tried). Full keyboard map,
focus rings, alt text from metadata, live-region sync progress.

---

## 12. End-to-end plug-and-play UX

```
install plugin
   └─ /visual-setup        engine consent install (already shipped)
   └─ /visual-init         project config wizard — NOW also a "Design system (Figma)" section:
        • paste Figma file URL(s) → file key(s) + label(s)   • NO token to enter
        • check the Figma MCP is available (desktop app open?)   • auto-map Figma↔code (confirm/edit/add)
        • offer to run the first sync
   └─ /visual-sync         dedicated sync → populates studio.db (code via engine; Figma via the MCP workflow)
   └─ /visual-studio       opens the bundled localhost SPA → components visible immediately
```

- The Figma section is **fully skippable** — code-only mode is the on-ramp and works with zero
  Figma config (timeline = the existing approved-baseline lineage; first sync seeds one tick).
- **Be honest:** design-system *parity* value requires Figma (and the Figma desktop app open for a
  sync); code-only is today's self-regression tool with a catalog UI. The gallery leads with a
  non-nagging "Open Figma & run /visual-sync to see designs" affordance, never empty frames.
- **Config delta** (additive, backward-compatible — D10/D11; **no token**):
  ```jsonc
  "figma": {
    "files": [{ "key": "abc123", "label": "Core" }],
    "componentMap": { "BtnPrimary": "Button" }
  },
  "studio": { "retainPerSource": 20, "retainCurrent": 3, "pruneOrphanBlobs": true }
  ```

---

## 13. New commands

| Command | What it does |
|---|---|
| `/visual-init` *(extended)* | adds the optional **Design system (Figma)** section (file key(s), Figma-MCP availability check, component mapping, offer sync — **no token**). |
| `/visual-sync` *(new)* | runs the sync (Figma fetch + code capture → DB). Re-runnable; incremental; resumable. |
| `/visual-studio` *(new)* | boots the bundled localhost web app (backgrounded) and opens the browser. |

Every command keeps the existing engine-detect-and-consent preflight (`install-deps.mjs --check`).
`/visual-ci` is **unchanged** and consumes only the regression axis — conformance never gates a build.

---

## 14. Status, regression, and conformance (the honest contract)

- **Regression** (`current_vs_baseline`): trustworthy, hard, pixel-exact (the existing engine). Can
  gate CI.
- **Conformance** (`figma_vs_code`): advisory, tolerant, human-judged. **Never** gates anything. A
  test enforces that a `divergent` conformance row cannot change the `/visual-ci` exit code.

---

## 15. Non-goals (v1)

- Per-variant cross-source parity badges (variants shown side-by-side per source; linking is v2).
- The **REST/PAT provider** and therefore **headless / CI / server-triggered Figma sync** — Figma is
  interactive-only via the MCP in v1 (code regression still runs headless/CI). REST is a
  designed-for future provider.
- Figma-side "where used" (code usage via grep only).
- Conformance as a gate, ever.
- Non-Storybook app-route targets as Studio components.

---

## 16. Decisions (resolved)

All prior open questions are now locked:

1. **Figma access = the Figma MCP — no token.** Figma is read through `mcp__figma-desktop`; there is
   **no PAT, env var, or secret file** to manage. *(If a REST provider is ever added for CI parity,
   it would lead with `FIGMA_TOKEN`; not in v1.)*
2. **Commit Figma baseline PNGs:** **yes** — committed under `.visual-baselines/.figma/`,
   content-addressed (dedupes identical frames) and retention-bounded, so design history is
   team-shared. A documented opt-out (gitignore `.figma/` + rebuild-from-Figma) exists for
   repo-size-sensitive teams.
3. **Figma constraint = the desktop app must be open** (the MCP is bound to the loaded file). No REST
   rate limit and no expiring URLs to manage. A sync is **interactive-only** (no headless/CI Figma);
   capture parallelism is **subagent fan-out** in the `/visual-sync` workflow (§9.3). *(The verified
   REST limits — Tier-1 10/15/20 req-min, 30-day image-URL expiry — are recorded only for the future
   REST provider; they don't apply to the MCP path.)*
4. **Command name:** **`/visual-studio`** (opens the bundled web app).
5. **Multi-Figma-file libraries: in v1.** Config takes `figma.files: [{ key, label? }]` (a single
   `fileKey` string is accepted as a one-file shorthand). Matching is namespaced per file; the
   gallery gets a library filter (§11.2). With MCP, syncing a given file requires that file open.
6. **"Used in":** **code-grep only in v1** (Figma-side instance usage deferred to v2).

Remaining standing rule (not a question): conformance (`figma_vs_code`) is **advisory forever** —
never a CI gate.

---

## 17. Risks (and where they're mitigated — see PLAN phases)

| Risk | Mitigation | Phase |
|---|---|---|
| Figma MCP unavailable (desktop app closed) | availability check before sync → actionable "open Figma & re-run"; un-captured components stay `figma-pending` and resume next sync | P0/P2 |
| Figma sync is interactive-only (no CI/headless) | documented; **code regression still runs headless/CI**; the REST provider is the future path if CI design-parity is ever needed | — |
| Bulk MCP capture is agent-token-cost / slow on big libraries | bounded subagent fan-out + content-hash **incremental** (only changed nodes re-captured); code-first so value shows immediately | P2/P5 |
| `better-sqlite3` native build | reuse the proven `sharp` bootstrap; prebuilds for Node 20; verify bridge resolution | P1 |
| Cross-source diff is noisy | conformance is a **separate, advisory** axis; overlay-first; never the pixel gate | P1/P5 |
| Blocking server hangs the agent turn | server launched **backgrounded/detached**; pidfile reopens instead of double-starting | P3 |
| Path traversal serving PNGs | hard path-confinement + escape test (mirrors `baseline.ts`) | P3 |
| `parseConfig` backward-compat | additive `parseFigma`; explicit "no-`figma` config round-trips unchanged" test | P0 |
| Matching false positives | override > normalized > surfaced; never fuzzy; user-overridable in UI | P2 |
| Unbounded DB/cache growth | retention config + `studio prune` + content-addressed dedupe; DB rebuildable | P5 |
| "Value immediately" vs. slow first sync | code-first ordering + streamed cards + live progress; open partial components | P2/P4 |

---

*Implementation sequencing, per-phase deliverables, testing strategy, and exit criteria are in
[`PLAN.md`](./PLAN.md).*
