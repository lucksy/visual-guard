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
4. **A sync** that populates both streams (Figma via REST, code via the existing capture engine).

It is built **on top of** the existing engine (`capture.ts`, `compare.ts`/`diff.ts`,
`baseline.ts`, `config.ts`, the `install-deps.mjs` bootstrap + `/visual-setup` consent gate) — not a
rewrite. Code baselines stay exactly where they live today (`.visual-baselines/`); Figma is additive.

---

## 5. Scope

**In scope (v1):**
- Figma REST access via a Personal Access Token; secure token handling; an access check.
- Local SQLite index of components, variants, usages, snapshots (history), and comparisons.
- A sync that fetches Figma component images + renders code components and records both.
- The bundled web app: gallery + component detail (timeline, comparison, variants, usages).
- Component-level Figma↔code matching (normalized name + an override map).
- Code-vs-code **regression** (the existing pixel gate) and Figma-vs-code **conformance** (advisory).

**Out of scope (v1) — see [Non-goals](#15-non-goals):**
- Per-variant cross-source linking / parity badges (variants are listed side-by-side per source).
- Browser-side token entry (token entry stays in the terminal flow).
- Figma-side "where used" (only code usage via grep in v1).
- Multi-Figma-file libraries (single `fileKey`; schema leaves room for `fileKeys[]` later).
- Conformance as a CI gate (it is advisory, forever).
- App-route (non-Storybook) targets as Studio components (Studio is Storybook-centric for v1).

---

## 6. Key architecture decisions (resolved)

These settle the cross-cutting forks (several of which the design's own review flagged as
contradictory across sub-designs). Each is a **decision**, not an option.

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | **Figma access = REST API + Personal Access Token** (`X-Figma-Token` header). | Headless, deterministic, parallelizable, works in CI — required for "plug-and-play + fast bulk fetch". | Figma Desktop MCP: GUI-bound, interactive, can't fan out, no CI. |
| D2 | **Token via env var** (`FIGMA_TOKEN`, also `VISUAL_GUARD_FIGMA_TOKEN`), with **opt-in** persist to a gitignored, `0600` `.visual-guard.env`. **Never** in config/DB/logs/thumbnails; masked `figd_…<last4>`. | Mirrors the proven ds-bridge `.ds-bridge.env` precedent; survives the Claude Code "sensitive config dropped on restart" issue; opt-in = we never store a secret unasked. | Token in config (leaks to git); OS keychain (not portable/CI); browser-entered token (crosses the trust boundary). |
| D3 | **Source of truth = committed PNGs + a committed `figma_meta.json`; the SQLite DB is a gitignored, rebuildable index.** | Satisfies "history is **team-shared**" (a teammate clones and has the history) while avoiding binary-DB merge conflicts. `reindex` rebuilds the DB from the committed artifacts. | Commit the DB (binary churn/conflicts); store history only in the gitignored data dir (per-machine — breaks team-shared history). |
| D4 | **SQLite driver = `better-sqlite3`**, shipped through the existing `ENGINE_DEPS` bootstrap. | The repo's Node floor is **20**, so `node:sqlite` (Node 22+, experimental) is not reliably present. `better-sqlite3` is native — but the repo **already** ships a native module (`sharp`) through the same bridge, so the risk is proven-solved. Sync API matches the engine's pure-lib style. | `node:sqlite` (not available at Node 20); `sql.js` (re-serializes whole DB per write); JSON store (no indexed history queries). |
| D5 | **Concurrency model — corrected.** The parallel **network I/O** (batched Figma image exports + eager downloads, with a bounded concurrency limiter + `Retry-After` backoff) lives **inside a single `tsx` engine script**. The **dynamic Workflow** orchestrates the sync *phases* with live progress **and** fans out the parts that genuinely need an LLM (ambiguous component matching, conformance classification). | The Workflow runtime orchestrates **subagents** and "can't touch the filesystem itself" — it is **not** a raw parallel-HTTP engine. Putting HTTP fan-out in-process is both correct and faster; reserving the workflow for orchestration + LLM judgment is what it's actually good at. | "The dynamic workflow makes the parallel HTTP calls" — mechanically wrong for this runtime. |
| D6 | **Two comparison axes, separated.** `current_vs_baseline` (code vs. its previous code) = the existing **pixelmatch regression** gate (valid, trustworthy). `figma_vs_code` = **conformance**, shown as overlay + a tolerant dimension/palette signal — **advisory only, never a gate, never CI**. | Cross-source pixel diff is noise (Figma renders at intrinsic size/scale 2; code at a viewport width — the engine crops to the top-left intersection, so a naive diff is ~100% bogus). | Reusing `compare.ts` pixelmatch for Figma-vs-code (would ship a "Diff" tab that lies). |
| D7 | **Matching = explicit override map > normalized-name match > surfaced as `figma-only`/`code-only`.** Component-level only in v1; variants listed side-by-side per source (no cross-source variant link). User-overridable in the UI. | Honest "unmatched" beats a wrong silent match in a DS tool; normalization handles the common case with zero input. | Fuzzy/AI auto-match (silent wrong pairs); exact-name only (everything unmatched). |
| D8 | **Web app = prebuilt, zero-build, committed vanilla-ES-module SPA** served by a tiny `node:http` server (run via the bundled `tsx`, **no new deps**). | "Ships inside a plugin, no per-user build step." A 2-screen app needs no framework; CSS custom properties give theming with zero runtime. | React/Vite (build step + committed bundle); Express (transitive-dep weight). Preact is a documented maintainer-side upgrade path. |
| D9 | **Server: loopback-only (`127.0.0.1`), OS-assigned port, launched backgrounded/detached, pidfile single-instance, token never reaches the browser.** | A foreground `listen()` would hang the agent turn; loopback + CSP + server-only token = minimal attack surface; the page is a pure consumer of already-fetched data. | Foreground server (hangs the turn); `0.0.0.0` (LAN exposure); proxying live Figma at view time (online dependence + rate-limit exposure). |
| D10 | **Config grows by an additive, validated `figma?` block** (`parseFigma`, mirroring `parseTokens`). Absent `figma` = today's code-only behavior, byte-for-byte. | Backward compatibility must be **proven** (parseConfig returns a fixed object and drops unknown keys), not assumed. | Asserting "compatible by construction" (false); a separate config file (drift). |

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

## 8. Figma access & security

**Endpoints used** (verify exact limits against live June-2026 Figma docs before shipping — see
[Open questions](#16-open-questions)):

| Purpose | Call | Notes |
|---|---|---|
| Validate token + identity | `GET /v1/me` | cheapest auth proof |
| File reachable by this seat | `GET /v1/files/:key?depth=1` | catches the **View-seat throttle** that `/v1/me` misses |
| Published components | `GET /v1/files/:key/components`, `/component_sets` | **fall back to a tree scan** for `type===COMPONENT/COMPONENT_SET` when empty (unpublished) |
| Render to image | `GET /v1/images/:key?ids=<batch>&format=png&scale=2` (svg for vectors) | URLs **expire (~30 days)** → download eagerly; batch ids per call |

**Token handling (the security boundary):**
- Resolution precedence: `flag` > `VISUAL_GUARD_FIGMA_TOKEN` > `FIGMA_TOKEN` >
  `CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN`, resolved at read time.
- Opt-in persist to `.visual-guard.env` (atomic temp+rename, `chmod 0600`, merge-preserving).
  `/visual-init` **adds an explicit `.visual-guard.env` line to `.gitignore`** (the `.env.*` glob
  does **not** match it) and verifies with `git check-ignore`.
- **Never** written to `visual.config.json`, the DB, manifests, logs, or thumbnails. A single
  `maskToken()` / `scrubSecrets()` runs on every surfaced string. A test asserts no `figd_` token
  appears in any artifact or thrown error.

**Access check** (the honest "can we reach Figma?"): two-stage `GET /v1/me` then
`GET /v1/files/:key?depth=1`, branching on `401` (bad token) / `403` (no file access) / `404`
(wrong key) / `429` (View-seat throttle / rate limit) / network (offline), each with actionable copy.

**File key:** accept a pasted Figma URL or a bare key; normalize with one regex
(`figma.(com|site)/(file|design|board|proto|slides)/<key>`), parse optional `?node-id`. Store the
bare (non-secret) `fileKey` in `visual.config.json`.

---

## 9. Capture / sync pipeline

### 9.1 Enumeration
- **Code side:** reuse `targets.ts` Storybook `/index.json` discovery — a story title's last
  segment is the **component**, each story is a **variant/state** (the existing `componentFromTitle`
  grouping).
- **Figma side:** published `components` / `component_sets` (a `COMPONENT_SET` = a component, its
  child `COMPONENT`s = variants), with a tree-scan fallback when the published list is empty.

### 9.2 Matching (D7)
Override map wins → normalized-name match → leftovers surfaced as `figma-only` / `code-only`
(never dropped). Accepted pairs persist as `figma.componentMap`. Component-level only in v1.

### 9.3 The concurrency model (D5 — the correction)
- **Network fan-out lives in a `tsx` engine script** (`scripts/studio/figma-export.ts` /
  `sync.ts`): a bounded in-process concurrency limiter (default 6), batched `GET /v1/images`
  (≤ a verified ids-per-call cap), **eager** download of the expiring S3 URLs (no barrier — a slow
  tail must not outlive its URL; on a 404 it **re-exports**, not just re-downloads), and shared
  `Retry-After` backoff (reuse the ds-bridge 3×-retry client pattern).
- **The dynamic Workflow** (`skills/visual-sync/`) orchestrates the *phases* with visible progress
  and reserves subagent fan-out for **LLM work**: judging ambiguous component matches and
  classifying conformance ("spacing drift", "off-palette"). The token is passed to the engine by
  **env-var name only**, never as a value.
- **Code capture** reuses `capture.ts` (Playwright) unchanged.

### 9.4 Compare (D6)
- `current_vs_baseline` = `diff.ts` pixelmatch vs. the previous **code** snapshot → real regression.
- `figma_vs_code` = a **tolerant conformance** signal (dimension delta + coarse palette/dominant-
  color distance via `sharp` downscale + `culori`) → `aligned | minor | divergent`, **advisory**.
  Presented as overlay + side-by-side; **never** a pass/fail, **never** wired into `/visual-ci`.

### 9.5 Idempotency, incremental, resumable
- Content-hash dedupe: identical bytes → no new history row.
- Incremental: Figma re-export keyed on node `lastModified` / file `version`; code re-render keyed
  on Storybook story-set hash + `uiGlobs` mtime (reuse `detect-ui-change.mjs`).
- Resumable: per-component `sync_state` (`synced | figma-pending | code-pending | error`); a
  re-run retries only non-synced rows. A partial sync is a clearly-labeled valid state, never a
  silent half-truth.

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
  object-src 'none'; base-uri 'none'`. The token is **server-side only**; the browser makes zero
  external calls and is served zero secrets.
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
First-run panel (Connect Figma & Sync, with a "your token stays on this machine" note), streaming
skeleton cards during sync (cards resolve in place — value appears within seconds), empty-filter,
and **inline, non-blocking** errors (token missing → code halves still render; 429 → stale chip;
per-component sync-failed retry; code-render-missing shows the URL it tried). Full keyboard map,
focus rings, alt text from metadata, live-region sync progress.

---

## 12. End-to-end plug-and-play UX

```
install plugin
   └─ /visual-setup        engine consent install (already shipped)
   └─ /visual-init         project config wizard — NOW also a "Design system (Figma)" section:
        • paste Figma file URL/key   • name the token env var (validate with the access check)
        • offer opt-in secure persist   • auto-map Figma↔code components (confirm/edit/add)
        • offer to run the first sync
   └─ /visual-sync         dedicated sync → populates studio.db (code first, Figma streams in)
   └─ /visual-app          opens the bundled localhost SPA → components visible immediately
```

- The Figma section is **fully skippable** — code-only mode is the on-ramp and works with zero
  Figma config (timeline = the existing approved-baseline lineage; first sync seeds one tick).
- **Be honest:** design-system *parity* value requires Figma; code-only is today's self-regression
  tool with a catalog UI. The gallery leads with a non-nagging "Connect Figma to see designs"
  affordance, never empty frames or a blocking spinner.
- **Config delta** (additive, backward-compatible — D10):
  ```jsonc
  "figma": { "fileKey": "abc123", "tokenEnv": "FIGMA_TOKEN", "componentMap": { "BtnPrimary": "Button" }, "scale": 2 },
  "studio": { "retainPerSource": 20, "retainCurrent": 3, "pruneOrphanBlobs": true }
  ```

---

## 13. New commands

| Command | What it does |
|---|---|
| `/visual-init` *(extended)* | adds the optional **Design system (Figma)** section (file key, token, access check, mapping, offer sync). |
| `/visual-sync` *(new)* | runs the sync (Figma fetch + code capture → DB). Re-runnable; incremental; resumable. |
| `/visual-app` *(new)* | boots the bundled localhost web app (backgrounded) and opens the browser. |

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
- Browser-side token entry (the web "Connect Figma" CTA **instructs/deep-links** to the terminal
  flow — it never captures a secret).
- Figma-side "where used" (code usage via grep only).
- Multi-Figma-file libraries (single `fileKey`; `fileKeys[]` is a designed-for future).
- Conformance as a gate, ever.
- Non-Storybook app-route targets as Studio components.

---

## 16. Open questions (need a decision before/within implementation)

1. **Token env name to lead with:** `FIGMA_TOKEN` (instant reuse if already set for ds-bridge) vs.
   `VISUAL_GUARD_FIGMA_TOKEN` (no collisions). *Recommendation: accept both, lead docs with
   `FIGMA_TOKEN`.* Should we also read ds-bridge's `.ds-bridge.env` (convenient, but couples plugins)?
2. **Commit Figma baseline PNGs?** Default yes (team-shared design history, content-addressed +
   retention-bounded) — but it adds binary churn; offer a gitignore-and-rebuild-from-Figma opt-out.
3. **Verified Figma limits:** the per-`/v1/images` ids cap, rate ceiling, and URL expiry must be
   pinned against **live June-2026 docs** (RULES flags Figma knowledge as possibly outdated) before
   the concurrency defaults (6 / batch ≤50) are trusted.
4. **Command names:** `/visual-app` vs `/visual-studio`? (Spec uses `/visual-app`.)
5. **Multi-file** support timing (`fileKey` vs `fileKeys[]`).
6. **"Used in"** depth in v1 (code-grep only confirmed; Figma-instance usage deferred).

---

## 17. Risks (and where they're mitigated — see PLAN phases)

| Risk | Mitigation | Phase |
|---|---|---|
| PAT leak (config/DB/logs/committed) | single mask/scrub, opt-in `0600` file, explicit gitignore + `git check-ignore`, "token never in artifacts" test | P0 |
| `better-sqlite3` native build | reuse the proven `sharp` bootstrap; prebuilds for Node 20; verify bridge resolution | P1 |
| Figma rate limits / expiring URLs | bounded in-process concurrency + `Retry-After` backoff; eager download; **re-export** on 404 | P2 |
| View-seat throttle | two-stage access check before the fan-out | P0 |
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
