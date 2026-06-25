// @ts-check
/**
 * Component Studio view-model (P4) — the PURE, framework-free transforms the SPA renders from. It is a
 * browser-loadable ES module (zero-build: the browser imports it directly) and is ALSO imported by the
 * vitest unit tests under the ≥80% coverage gate, so the gallery/detail logic (badge derivation,
 * filter/sort, variant union, timeline mapping, freshness) has one tested source of truth. The render
 * code (gallery.js / detail.js) stays thin and is browser-validated, not unit-tested.
 *
 * Types live in the sibling `view-model.d.ts` (consumed by the .ts tests; the browser ignores it).
 */

// --- Status badge (SPEC §11.1) ---------------------------------------------

/**
 * The five component-level UI statuses, derived from presence (Figma/code linkage) + the advisory
 * `parity_status` (figma↔code). This is NOT the engine's per-image status — that drives the Diff
 * caption in the detail view. Always rendered dot+word (never color alone) for colorblind safety.
 */
export function deriveBadge(component) {
  const hasFigma = Boolean(component.figma_node_id || component.figma_file_key);
  const hasCode = Boolean(component.code_target || component.code_instance);
  if (hasFigma && !hasCode) {
    return { key: "figma-only", label: "Figma-only", tone: "blue" };
  }
  if (hasCode && !hasFigma) {
    return { key: "code-only", label: "Code-only", tone: "gray" };
  }
  if (hasFigma && hasCode) {
    const parity = component.parity_status;
    if (parity === "same") {
      return { key: "in-sync", label: "In sync", tone: "green" };
    }
    if (parity === "changed" || parity === "regression") {
      return { key: "changed", label: "Changed", tone: "amber" };
    }
    // null / new / unknown / error → not yet meaningfully compared.
    return { key: "new", label: "New", tone: "indigo" };
  }
  return { key: "new", label: "New", tone: "indigo" }; // neither side linked yet (a fresh row)
}

/**
 * Whether the component has a CODE regression (current vs approved baseline) — the trustworthy pixel
 * axis. Surfaced as a secondary marker so the code-only self-regression signal stays visible even when
 * the parity badge is "Code-only"/"In sync".
 */
export function isCodeRegressed(component) {
  return component.status === "regression";
}

/** Counts per badge key (+ `all`) for the filter chips' live counts. */
export function countByBadge(components) {
  const counts = {
    all: components.length,
    "in-sync": 0,
    changed: 0,
    "figma-only": 0,
    "code-only": 0,
    new: 0,
  };
  for (const c of components) {
    counts[deriveBadge(c).key] += 1;
  }
  return counts;
}

// --- Filter + sort (SPEC §11.2) --------------------------------------------

/**
 * Filter by a case-insensitive substring over name + key + description and/or a derived badge key
 * (`all` = no badge filter). The search corpus is broadened past name/key (P6) so a user can find a
 * component by what its description says (e.g. "checkout", "deprecated") — descriptions already render on
 * the card, so this just searches what's shown.
 */
export function filterComponents(components, options = {}) {
  let out = components;
  const q = options.q;
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter((c) =>
      `${c.name} ${c.key} ${c.description || ""}`.toLowerCase().includes(needle),
    );
  }
  const badge = options.badge;
  if (badge && badge !== "all") {
    out = out.filter((c) => deriveBadge(c).key === badge);
  }
  return out;
}

/** Urgency order: a regressed component sorts first, then by badge urgency, then by name. */
const BADGE_URGENCY = {
  changed: 0,
  "figma-only": 1,
  "code-only": 2,
  new: 3,
  "in-sync": 4,
};

/** Sort a copy of `components` by `mode` (`urgency` default | `name` | `recent`). Stable, non-mutating. */
export function sortComponents(components, mode = "urgency") {
  const arr = [...components];
  if (mode === "name") {
    arr.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    return arr;
  }
  if (mode === "recent") {
    arr.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return arr;
  }
  // urgency
  arr.sort((a, b) => {
    const ra = isCodeRegressed(a) ? 0 : 1;
    const rb = isCodeRegressed(b) ? 0 : 1;
    if (ra !== rb) {
      return ra - rb; // regressed first
    }
    const ua = BADGE_URGENCY[deriveBadge(a).key];
    const ub = BADGE_URGENCY[deriveBadge(b).key];
    if (ua !== ub) {
      return ua - ub;
    }
    return a.name.localeCompare(b.name);
  });
  return arr;
}

// --- Variants (SPEC §11.3) -------------------------------------------------

function normalizeVariantName(name) {
  return String(name).trim().toLowerCase();
}

/**
 * Union of Figma + code variants, keyed by normalized name, each tagged with its origin
 * (`both` | `figma-only` | `code-only`) — the basis for the variant tabs' origin chips and the
 * "variants parity" panel. Sorted by display name.
 */
export function variantUnion(variants) {
  const map = new Map();
  for (const v of variants) {
    const norm = normalizeVariantName(v.name);
    const entry = map.get(norm) || { name: v.name, inFigma: false, inCode: false };
    if (v.source === "figma") {
      entry.inFigma = true;
    } else {
      entry.inCode = true;
    }
    map.set(norm, entry);
  }
  return [...map.values()]
    .map((e) => ({
      name: e.name,
      inFigma: e.inFigma,
      inCode: e.inCode,
      origin: e.inFigma && e.inCode ? "both" : e.inFigma ? "figma-only" : "code-only",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Timeline (SPEC §11.3) -------------------------------------------------

/**
 * Map a source+variant lane's snapshots to timeline ticks, oldest→newest, with the latest flagged
 * `isCurrent` (pinned right = Current). Each tick carries provenance for the hover/aria readout.
 */
export function timelineTicks(snapshots) {
  const sorted = [...snapshots].sort((a, b) => a.version_seq - b.version_seq);
  return sorted.map((s, i) => ({
    id: s.id,
    versionSeq: s.version_seq,
    capturedAt: s.captured_at,
    gitSha: s.git_sha || null,
    figmaVersionId: s.figma_version_id || null,
    isCurrent: i === sorted.length - 1,
  }));
}

// --- Freshness + labels ----------------------------------------------------

/** A short relative-time string ("just now" / "4m ago" / "3h ago" / "5d ago") given `nowMs`. Pure. */
export function freshness(iso, nowMs) {
  if (!iso) {
    return "never";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 45) {
    return "just now";
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.round(hr / 24)}d ago`;
}

/** Accessible label for a gallery card: "Button, status Changed, code regression, 4 variants". */
export function cardAriaLabel(component, variantCount) {
  const badge = deriveBadge(component);
  const parts = [component.name, `status ${badge.label}`];
  if (isCodeRegressed(component)) {
    parts.push("code regression");
  }
  if (typeof variantCount === "number" && variantCount > 0) {
    parts.push(`${variantCount} variant${variantCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

// --- External deep links (navigations, not fetches — CSP-safe) -------------

/** Figma deep link for a node (`1:2` → URL `node-id=1-2`), or null if either part is missing. */
export function figmaDeepLink(fileKey, nodeId) {
  if (!fileKey || !nodeId) {
    return null;
  }
  const node = String(nodeId).replace(/:/g, "-");
  return `https://www.figma.com/file/${encodeURIComponent(fileKey)}?node-id=${encodeURIComponent(node)}`;
}

/**
 * The live-preview iframe URL for a code variant's captured render, or null. The stored `renderUrl` is
 * exactly what capture navigated to (Storybook `iframe.html` / Ladle `?mode=preview`), so it embeds the
 * bare component. Validated to an http(s) LOOPBACK URL — matching the server's `frame-src` — so a hostile
 * config can never make the SPA frame a remote or `javascript:`/`data:` origin (it'd be CSP-blocked too).
 */
export function livePreviewUrl(renderUrl) {
  if (!renderUrl) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(String(renderUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    return null;
  }
  return String(renderUrl);
}

/** Storybook story deep link from a base URL + story id, or null. Trailing slash on base is tolerated.
 *  `baseUrl` (from project config) must be an http(s) URL, so a hostile config can't produce a
 *  `javascript:`/`data:` href — mirroring figmaDeepLink's hardcoded-origin safety. */
export function storyLink(baseUrl, storyId) {
  if (!baseUrl || !storyId) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return `${String(baseUrl).replace(/\/$/, "")}/?path=/story/${encodeURIComponent(storyId)}`;
}

// --- Diff & comparison (P6) ------------------------------------------------

/**
 * Format a 0..1 diff ratio as a percentage string ("1.23%"), or null when there's no numeric ratio (a
 * `new`/`error` comparison records NULL). Two decimals — sub-percent pixel deltas are the common case.
 */
export function formatDiffRatio(ratio) {
  if (typeof ratio !== "number" || Number.isNaN(ratio)) {
    return null;
  }
  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * Map a regression-history array (newest-first, as the API returns it) to an oldest→newest series for the
 * drift sparkline: `{ ratio, status, at }` per point, ratio coerced to a finite number (NULL → 0). Pure.
 */
export function regressionSeries(regressions) {
  return [...(regressions || [])]
    .reverse()
    .map((r) => ({
      ratio: typeof r.diff_ratio === "number" && !Number.isNaN(r.diff_ratio) ? r.diff_ratio : 0,
      status: r.status,
      at: r.computed_at || null,
    }));
}

/**
 * Build an SVG `<polyline>` `points` string for a drift sparkline from a numeric series (0..1 ratios),
 * scaled into a `width`×`height` box (y inverted so higher diff = higher line). The series is normalized
 * to its own max (a flat-but-nonzero series still reads as a line near the top, not a baseline). Returns
 * "" for an empty series and a single centered point for one sample. Pure + unit-tested.
 */
export function sparklinePath(values, width, height) {
  const xs = (values || []).map((v) =>
    typeof v === "number" && !Number.isNaN(v) ? Math.max(0, v) : 0,
  );
  if (xs.length === 0) {
    return "";
  }
  const w = width > 0 ? width : 100;
  const h = height > 0 ? height : 24;
  const max = Math.max(...xs, 0);
  const y = (v) => (max <= 0 ? h : h - (v / max) * h);
  if (xs.length === 1) {
    return `0,${y(xs[0]).toFixed(2)} ${w},${y(xs[0]).toFixed(2)}`;
  }
  const step = w / (xs.length - 1);
  return xs.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
}

/**
 * Summarize an advisory drift report (F5) into a few short, emoji-free chips for the gallery header
 * strip — only the NON-zero signals (new-since-last-sync, removed, stale, renamed). Returns [] when there
 * is nothing to show (so the strip hides). Pure + unit-tested.
 */
export function summarizeDrift(drift) {
  if (!drift) return [];
  const chips = [];
  const delta = drift.delta || {};
  const newCount = (delta.newFigma || []).length + (delta.newCode || []).length;
  if (newCount > 0) chips.push({ key: "new", label: `${newCount} new since last sync` });
  if ((drift.removed || []).length > 0) chips.push({ key: "removed", label: `${drift.removed.length} removed` });
  if ((drift.stale || []).length > 0) chips.push({ key: "stale", label: `${drift.stale.length} stale` });
  if (drift.renamed > 0) chips.push({ key: "renamed", label: `${drift.renamed} renamed` });
  return chips;
}

/**
 * Map an advisory variant-axis diff (F4) to a small detail-view badge, or null when there is nothing
 * meaningful to show (`unknown` — no Figma axes, or a synthetic-only code side, the honesty guard). Plain
 * words, never color alone. Advisory: it reflects nothing about the CI-relevant code regression axis.
 */
export function deriveAxisDiffBadge(axisDiff) {
  if (!axisDiff || axisDiff.level === "unknown") {
    return null;
  }
  if (axisDiff.level === "aligned") {
    return { key: "axes-aligned", label: "Axes aligned", tone: "green" };
  }
  if (axisDiff.level === "minor") {
    return { key: "axes-minor", label: "Axes differ (minor)", tone: "amber" };
  }
  return { key: "axes-divergent", label: "Axes diverge", tone: "red" };
}

/**
 * Describe the advisory figma↔code conformance breakdown (dimension vs palette delta) in plain words for
 * the Overlay caption — so a "Changed" parity badge says WHICH axis drifted. Both deltas are 0..1;
 * null/absent (a code-axis comparison, or a pre-v4 row) yields null. Pure + unit-tested.
 */
export function describeParityDrift(dimensionDelta, paletteDelta) {
  const dim = typeof dimensionDelta === "number" && !Number.isNaN(dimensionDelta) ? dimensionDelta : null;
  const pal = typeof paletteDelta === "number" && !Number.isNaN(paletteDelta) ? paletteDelta : null;
  if (dim === null && pal === null) {
    return null;
  }
  const d = dim ?? 0;
  const p = pal ?? 0;
  const NOISE = 0.06; // below the "minor" conformance threshold — treat as aligned on that axis
  const dimDrift = d > NOISE;
  const palDrift = p > NOISE;
  if (!dimDrift && !palDrift) {
    return "aligned with the design (size and color within tolerance)";
  }
  if (dimDrift && palDrift) {
    return "size and color both drift from the design";
  }
  if (dimDrift) {
    return "size drifts from the design (color is aligned)";
  }
  return "color drifts from the design (size is aligned)";
}
