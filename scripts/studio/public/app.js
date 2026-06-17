/* eslint-env browser */
// @ts-check
/**
 * Component Studio SPA entry (P4). A tiny hash router (`#/` gallery · `#/component/:id` detail) over a
 * persistent top bar (brand + theme toggle). Gallery filters live in the hash query (`#/?badge=&q=&sort=
 * &density=`) so views are shareable/back-restorable. Everything is same-origin; the page makes zero
 * external calls (the only off-origin URLs are user-clicked "Open in Figma/Story" navigations).
 */

import { el, setChildren } from "./dom.js";
import { getHealth } from "./api.js";
import { renderGallery, resetGalleryCaches } from "./gallery.js";
import { renderDetail } from "./detail.js";

const THEME_KEY = "vg-studio-theme";
const THEMES = ["", "light", "dark"]; // "" = follow the OS

function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", value);
}
function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || "";
  } catch {
    return "";
  }
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode — theme just won't persist */
  }
  applyTheme(next);
  return next;
}
function themeLabel(value) {
  return value === "dark" ? "Dark" : value === "light" ? "Light" : "System";
}

/** Parse the hash into a route: { path: "gallery"|"component", id?, query }. */
function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = hash.split("?");
  const usp = new URLSearchParams(queryPart);
  const query = {
    q: usp.get("q") || "",
    badge: usp.get("badge") || "all",
    sort: usp.get("sort") || "urgency",
    density: usp.get("density") || "",
  };
  const m = /^\/component\/(\d+)$/.exec(pathPart);
  if (m) {
    return { path: "component", id: Number(m[1]), query };
  }
  return { path: "gallery", query };
}

let viewEl;
// The project's Storybook base URL (from /api/health) for "Open the story" deep links — fetched once.
let storyBaseUrl = null;
let healthLoaded = false;
async function ensureHealth() {
  if (!healthLoaded) {
    try {
      const health = await getHealth();
      storyBaseUrl = (health && health.storybookBaseUrl) || null;
    } catch {
      storyBaseUrl = null;
    }
    healthLoaded = true;
  }
}

const helpers = {
  /** Merge `partial` into the gallery query, reflect it in the URL (no history spam), and re-render. */
  setQuery(partial) {
    const { query } = parseRoute();
    const merged = { ...query, ...partial };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      // Drop defaults so the URL stays clean.
      if (v && !(k === "badge" && v === "all") && !(k === "sort" && v === "urgency")) {
        usp.set(k, v);
      }
    }
    const qs = usp.toString();
    history.replaceState(null, "", `#/${qs ? `?${qs}` : ""}`);
    renderGallery(viewEl, merged, helpers);
  },
  /**
   * Reflect a query change in the URL WITHOUT re-rendering — used by the live search field so typing
   * doesn't rebuild the gallery (which would drop input focus mid-keystroke). The grid is refreshed in
   * place by the caller.
   */
  reflectQuery(partial) {
    const { query } = parseRoute();
    const merged = { ...query, ...partial };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) {
      if (v && !(k === "badge" && v === "all") && !(k === "sort" && v === "urgency")) {
        usp.set(k, v);
      }
    }
    const qs = usp.toString();
    history.replaceState(null, "", `#/${qs ? `?${qs}` : ""}`);
  },
  /** Re-render the gallery with the current query (used by the sync poller). */
  rerender() {
    renderGallery(viewEl, parseRoute().query, helpers);
  },
};

function route() {
  const r = parseRoute();
  viewEl.setAttribute("aria-busy", "true");
  if (r.path === "component") {
    // Ensure the Storybook base URL is loaded (cached) before rendering, so the launchpad's
    // "Open the story" link can appear for Storybook-sourced components.
    ensureHealth().then(() => renderDetail(viewEl, r.id, { storyBaseUrl }));
  } else {
    renderGallery(viewEl, r.query, helpers);
  }
}

function mount() {
  applyTheme(currentTheme());

  const themeBtn = el(
    "button",
    {
      class: "btn icon-btn",
      type: "button",
      title: `Theme: ${themeLabel(currentTheme())}`,
      "aria-label": `Theme: ${themeLabel(currentTheme())}. Click to change.`,
    },
    "◐",
  );
  themeBtn.addEventListener("click", () => {
    const next = cycleTheme();
    themeBtn.title = `Theme: ${themeLabel(next)}`;
    themeBtn.setAttribute("aria-label", `Theme: ${themeLabel(next)}. Click to change.`);
  });

  const topbar = el(
    "header",
    { class: "topbar" },
    el(
      "a",
      { class: "brand", href: "#/", "aria-label": "Component Studio home" },
      el("span", { class: "mark", "aria-hidden": "true" }),
      "Component Studio",
    ),
    el("div", { class: "spacer" }),
    themeBtn,
  );

  viewEl = el("div", { id: "view", "aria-busy": "true" });
  const app = document.getElementById("app");
  if (app) {
    setChildren(app, [topbar, viewEl]);
    app.removeAttribute("aria-busy"); // busy now tracked per-view on #view, not the whole app
  }

  window.addEventListener("hashchange", route);
  route();
}

// Re-fetch fresh data on a real reload (cache lives only for the session's soft navigations).
resetGalleryCaches();
mount();
