/* eslint-env browser */
// @ts-check
/**
 * Component Studio gallery (P4, SPEC §11.2). The default screen: search + status chips (live counts) +
 * sort + density, a responsive grid of dual-thumbnail cards, and the Sync button. Pure logic
 * (badge/filter/sort/counts/freshness/aria) comes from view-model.js; this file is thin render + wiring.
 *
 * The list endpoint carries each card's figma/code thumbnail ids + variant count, so a card renders fully
 * from a SINGLE list fetch — no per-card detail request (no thumbnail N+1). During a sync we re-poll the
 * list so cards update in place ("stream in"). Search is debounced and `.card`s use `content-visibility`
 * (app.css) so a large library stays responsive while typing.
 */

import { el, setChildren, announce } from "./dom.js";
import { getComponents, getDrift, getHealth, imageUrl, postSync, ApiError } from "./api.js";
import {
  deriveBadge,
  isCodeRegressed,
  countByBadge,
  filterComponents,
  sortComponents,
  summarizeDrift,
  cardAriaLabel,
  freshness,
} from "./view-model.js";

/** @type {any[] | null} */
let componentsCache = null;
let syncing = false;

async function ensureComponents(force) {
  if (componentsCache === null || force) {
    componentsCache = await getComponents();
  }
  return componentsCache;
}

function badge(component) {
  const b = deriveBadge(component);
  return el("span", { class: `badge tone-${b.tone}` }, el("span", { class: "dot" }), b.label);
}

function thumb(src, snapshotId, alt) {
  if (!snapshotId) {
    return el("div", { class: "thumb missing" }, src === "figma" ? "Not in Figma" : "No code render");
  }
  return el(
    "div",
    { class: "thumb" },
    el("span", { class: "src-tag" }, src),
    el("img", { src: imageUrl(snapshotId), alt, loading: "lazy" }),
  );
}

function card(component) {
  // Thumbnail ids + variant count come straight from the list payload — no per-card fetch.
  const variantCount = component.variant_count || 0;
  const thumbs = el(
    "div",
    { class: "thumbs" },
    thumb("figma", component.figma_snapshot_id, `${component.name} in Figma`),
    thumb("code", component.code_snapshot_id, `${component.name} rendered from code`),
  );

  const meta = el(
    "div",
    { class: "card-meta" },
    el("span", {}, `${variantCount} variant${variantCount === 1 ? "" : "s"}`),
    el("span", {}, freshness(component.updated_at, Date.now())),
  );

  const title = el(
    "div",
    { class: "card-title" },
    el("span", {}, component.name),
    badge(component),
  );

  const body = el("div", { class: "card-body" }, title);
  if (component.description) {
    body.append(el("div", { class: "card-desc" }, component.description));
  }
  if (isCodeRegressed(component)) {
    body.append(el("div", { class: "regression-flag" }, "⚠ code regression"));
  }
  body.append(meta);

  return el(
    "a",
    {
      class: "card",
      href: `#/component/${component.id}`,
      "aria-label": cardAriaLabel(component, variantCount),
    },
    thumbs,
    body,
  );
}

function chip(label, key, count, active, helpers, hero) {
  return el(
    "button",
    {
      class: hero ? "chip hero" : "chip",
      type: "button",
      "aria-pressed": String(active),
      onClick: () => helpers.setQuery({ badge: key }),
    },
    label,
    el("span", { class: "count" }, String(count)),
  );
}

function toolbar(query, counts, helpers, refreshGrid) {
  const search = el("input", {
    class: "search",
    type: "search",
    name: "q",
    placeholder: "Search components…",
    "aria-label": "Search components",
    value: query.q || "",
  });
  // Reflect the query in the URL + refresh the grid in place — NO full re-render, so focus is kept.
  // Debounced: a burst of keystrokes triggers ONE filter+rebuild, not one per character (keeps a large
  // library responsive while typing).
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      helpers.reflectQuery({ q: search.value });
      refreshGrid(search.value);
    }, 150);
  });

  const sort = el(
    "select",
    { name: "sort", "aria-label": "Sort", onChange: (e) => helpers.setQuery({ sort: e.target.value }) },
    el("option", { value: "urgency", selected: (query.sort || "urgency") === "urgency" }, "Sort: Urgency"),
    el("option", { value: "name", selected: query.sort === "name" }, "Sort: Name"),
    el("option", { value: "recent", selected: query.sort === "recent" }, "Sort: Recent"),
  );

  const density = el(
    "button",
    {
      class: "btn icon-btn",
      type: "button",
      title: query.density === "compact" ? "Comfortable density" : "Compact density",
      "aria-label": query.density === "compact" ? "Comfortable density" : "Compact density",
      onClick: () => helpers.setQuery({ density: query.density === "compact" ? "" : "compact" }),
    },
    query.density === "compact" ? "▤" : "▦",
  );

  return el("div", { class: "toolbar" }, search, sort, density);
}

function chipRow(counts, query, helpers) {
  const active = query.badge || "all";
  return el(
    "div",
    { class: "chips", role: "group", "aria-label": "Filter by status" },
    chip("All", "all", counts.all, active === "all", helpers),
    chip("In sync", "in-sync", counts["in-sync"], active === "in-sync", helpers),
    chip("Changed", "changed", counts.changed, active === "changed", helpers),
    // Hero metrics — the DS owner's most valuable immediate signal (designed-not-built / built-not-in-Figma).
    chip("Figma-only", "figma-only", counts["figma-only"], active === "figma-only", helpers, true),
    chip("Code-only", "code-only", counts["code-only"], active === "code-only", helpers, true),
    chip("New", "new", counts.new, active === "new", helpers),
  );
}

function firstRunPanel() {
  return el(
    "div",
    { class: "panel" },
    el(
      "div",
      { class: "first-run-hero" },
      el("div", { class: "hero-logo", "aria-hidden": "true" }),
      el("div", { class: "hero-wordmark" }, "Visual Guard"),
    ),
    el("h2", {}, "No components yet"),
    el(
      "p",
      {},
      "Open your Figma file in the desktop app, then run ",
      el("code", {}, "/visual-sync"),
      " to populate the studio. There is no token to enter — code-only projects work too.",
    ),
  );
}

/** Run a sync: trigger it, poll the list so cards update in place, then refresh + announce. */
async function runSync(root, query, helpers, syncBtn) {
  if (syncing) {
    return;
  }
  syncing = true;
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing…";
  announce("Sync started");
  let polling = true;
  const poll = async () => {
    while (polling) {
      // 3s cadence — a human watching a sync doesn't need sub-second refreshes, and the list now carries
      // thumbnails so each poll is one request (not one-per-card). The cache is refreshed, never cleared.
      await new Promise((r) => setTimeout(r, 3000));
      if (!polling) {
        break;
      }
      try {
        await ensureComponents(true);
        helpers.rerender();
      } catch {
        /* transient — keep polling */
      }
    }
  };
  poll();
  try {
    const result = await postSync();
    polling = false;
    await ensureComponents(true);
    helpers.rerender();
    const s = result.summary || {};
    announce(`Sync complete. ${s.components ?? 0} components processed.`);
  } catch (err) {
    polling = false;
    const message = err instanceof ApiError ? err.message : "Sync failed.";
    announce(`Sync failed: ${message}`);
    const main = root.querySelector("main");
    if (main) {
      main.prepend(el("div", { class: "inline-error", role: "alert" }, `Sync failed: ${message}`));
    }
  } finally {
    syncing = false;
    syncBtn.disabled = false;
    syncBtn.textContent = "⟳ Sync";
  }
}

/**
 * Render the gallery into `root`. `query` = { q, badge, sort, density }. `helpers` = { setQuery(partial),
 * rerender() } provided by the router so filter changes reflect in the URL and re-render here.
 */
export async function renderGallery(root, query, helpers) {
  // Header (brand + freshness + sync + theme slot filled by app.js separately).
  const components = await ensureComponents(false).catch(() => []);

  if (!components.length) {
    setChildren(root, firstRunPanel());
    root.removeAttribute("aria-busy");
    return;
  }

  const counts = countByBadge(components);
  // F5: the advisory drift strip (best-effort; absent on older servers or an empty DB → no strip).
  const driftChips = summarizeDrift(await getDrift().catch(() => null));
  const grid = el("div", { class: query.density === "compact" ? "grid compact" : "grid", id: "main" });

  // Re-fill the grid in place for a given search string — used by the live search field so typing never
  // rebuilds the toolbar (which would drop input focus). Badge/sort/density still do a full re-render.
  const refreshGrid = (q) => {
    const visible = sortComponents(
      filterComponents(components, { q, badge: query.badge }),
      query.sort || "urgency",
    );
    if (!visible.length) {
      setChildren(grid, el("div", { class: "panel" }, el("p", {}, "No components match the current filters.")));
    } else {
      setChildren(grid, visible.map((c) => card(c)));
    }
  };
  refreshGrid(query.q);

  const syncBtn = el("button", { class: "btn btn-primary", type: "button" }, "⟳ Sync");
  syncBtn.addEventListener("click", () => runSync(root, query, helpers, syncBtn));

  setChildren(
    root,
    el(
      "div",
      {},
      el(
        "div",
        { class: "toolbar-wrap" },
        toolbar(query, counts, helpers, refreshGrid),
        chipRow(counts, query, helpers),
        driftChips.length
          ? el(
              "div",
              { class: "drift-strip" },
              el("span", { class: "drift-strip-label" }, "Drift (advisory):"),
              ...driftChips.map((c) => el("span", { class: `drift-chip drift-${c.key}` }, c.label)),
            )
          : null,
        el("div", { style: { padding: "0 var(--sp-5) var(--sp-3)" } }, syncBtn),
      ),
      el("main", {}, grid),
    ),
  );
  root.removeAttribute("aria-busy");
}

/** Reset module caches (used when navigating fresh / after data changes). */
export function resetGalleryCaches() {
  componentsCache = null;
  lastHealthSnapshots = null;
}

// Snapshot count from the last health poll — a cheap change-detector for an EXTERNAL sync (a CLI
// `/visual-sync`) so the gallery becomes a live mirror, not a stale snapshot.
let lastHealthSnapshots = null;

/**
 * Poll `/api/health` and, if the snapshot count changed since the last poll (an external sync wrote new
 * renders), refetch the component list and re-render in place. Skipped while an in-app sync is running
 * (its own poller already refreshes). Cheap: one tiny request, no work when nothing changed. Best-effort
 * — the caller swallows errors so a transient blip never disrupts the view.
 */
export async function maybeAutoRefresh(helpers) {
  if (syncing) {
    return;
  }
  const health = await getHealth();
  const n = health && health.counts ? health.counts.snapshots : null;
  if (typeof n !== "number") {
    return;
  }
  if (lastHealthSnapshots === null) {
    lastHealthSnapshots = n; // seed on first poll — never refresh on the very first observation
    return;
  }
  if (n !== lastHealthSnapshots) {
    lastHealthSnapshots = n;
    await ensureComponents(true);
    helpers.rerender();
  }
}
