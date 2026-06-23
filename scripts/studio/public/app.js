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
import { renderGallery, resetGalleryCaches, maybeAutoRefresh } from "./gallery.js";
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
    // Detail views carry their own shareable state (selected variant + compare mode).
    return {
      path: "component",
      id: Number(m[1]),
      detailQuery: { variant: usp.get("variant") || "", mode: usp.get("mode") || "" },
      query,
    };
  }
  return { path: "gallery", query };
}

/** Build a deep-linkable detail hash from the live detail state (variant + compare mode). */
function buildDetailHash(id, detailQuery) {
  const usp = new URLSearchParams();
  if (detailQuery.variant) {
    usp.set("variant", detailQuery.variant);
  }
  if (detailQuery.mode) {
    usp.set("mode", detailQuery.mode);
  }
  const qs = usp.toString();
  return `#/component/${id}${qs ? `?${qs}` : ""}`;
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
    ensureHealth().then(() =>
      renderDetail(viewEl, r.id, {
        storyBaseUrl,
        detailQuery: r.detailQuery,
        // Reflect variant/mode into the URL (no history spam) so the view is a shareable permalink.
        writeDetailUrl: (q) => history.replaceState(null, "", buildDetailHash(r.id, q)),
      }),
    );
  } else {
    renderGallery(viewEl, r.query, helpers);
  }
}

// --- Keyboard layer (P6) ---------------------------------------------------

/** Is focus in a text-entry control? (Don't hijack typing for single-key shortcuts.) */
function isTypingTarget(t) {
  if (!t) {
    return false;
  }
  const tag = t.tagName;
  return Boolean(t.isContentEditable) || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function focusSearch() {
  const s = document.querySelector("input.search");
  if (s) {
    s.focus();
    if (typeof s.select === "function") {
      s.select();
    }
    return true;
  }
  return false;
}

let helpOpen = false;
// The element focused before the help modal opened — focus is restored to it on close (a11y).
let helpOpener = null;
/** Toggle (or force) the keyboard-shortcuts help overlay. */
function toggleHelp(force) {
  helpOpen = typeof force === "boolean" ? force : !helpOpen;
  const existing = document.getElementById("help-overlay");
  if (!helpOpen) {
    if (existing) {
      existing.remove();
    }
    // Restore focus to whatever opened the dialog (if it's still in the document).
    if (helpOpener && document.contains(helpOpener) && typeof helpOpener.focus === "function") {
      helpOpener.focus();
    }
    helpOpener = null;
    return;
  }
  if (existing) {
    return;
  }
  helpOpener = document.activeElement;
  const rows = [
    ["/", "Search components"],
    ["j / k", "Next / previous component"],
    ["Enter", "Open the focused component"],
    ["g", "Go to the gallery"],
    ["?", "Toggle this help"],
    ["Esc", "Close / clear focus"],
  ];
  const closeBtn = el("button", { class: "btn", id: "help-close", type: "button", onClick: () => toggleHelp(false) }, "Close");
  const overlay = el(
    "div",
    { id: "help-overlay", class: "help-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts" },
    el(
      "div",
      { class: "help-card" },
      el("h2", {}, "Keyboard shortcuts"),
      el("dl", { class: "help-list" }, rows.flatMap(([k, d]) => [el("dt", {}, k), el("dd", {}, d)])),
      closeBtn,
    ),
  );
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      toggleHelp(false);
    }
  });
  document.body.append(overlay);
  // Move focus INTO the dialog so the keyboard/SR user is placed in the modal, not left behind it.
  closeBtn.focus();
}

/** Move keyboard focus to the next/previous gallery card (j/k). */
function moveCardFocus(delta) {
  const cards = [...document.querySelectorAll("a.card")];
  if (!cards.length) {
    return;
  }
  const idx = cards.indexOf(document.activeElement);
  const next = idx === -1 ? (delta > 0 ? 0 : cards.length - 1) : Math.min(cards.length - 1, Math.max(0, idx + delta));
  cards[next].focus();
}

function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    return; // never shadow browser/OS chords
  }
  // While the help modal is open it is a genuine modal: it OWNS the keyboard. Escape closes it, Tab is
  // trapped to the dialog, and every other key is swallowed so nothing leaks to the page behind it (which
  // has no `inert` support across all targets) — honoring the aria-modal=true contract.
  if (helpOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleHelp(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const close = document.getElementById("help-close");
      if (close) {
        close.focus(); // only one focusable control → keep focus on it
      }
    }
    return;
  }
  if (e.key === "Escape") {
    if (isTypingTarget(document.activeElement)) {
      document.activeElement.blur();
    }
    return;
  }
  if (isTypingTarget(document.activeElement)) {
    return; // let the field handle the key
  }
  if (e.key === "?") {
    e.preventDefault();
    toggleHelp();
    return;
  }
  if (e.key === "/") {
    if (focusSearch()) {
      e.preventDefault();
    }
    return;
  }
  if (e.key === "g") {
    e.preventDefault();
    location.hash = "#/";
    return;
  }
  if ((e.key === "j" || e.key === "k") && parseRoute().path === "gallery") {
    e.preventDefault();
    moveCardFocus(e.key === "j" ? 1 : -1);
  }
}

/** Poll for external data changes so the gallery stays a live mirror (10s; cheap health check). */
const AUTO_REFRESH_MS = 10000;
function startAutoRefresh() {
  setInterval(() => {
    // Don't rebuild the gallery while the help modal is open, off the gallery, or — critically — while the
    // user is typing in the search box: a rerender destroys + recreates that input, dropping focus and the
    // in-flight keystroke. Defer to a later tick (after the field blurs).
    if (helpOpen || parseRoute().path !== "gallery" || isTypingTarget(document.activeElement)) {
      return;
    }
    maybeAutoRefresh(helpers).catch(() => {
      /* transient — try again next tick */
    });
  }, AUTO_REFRESH_MS);
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
  window.addEventListener("keydown", onKeydown);
  startAutoRefresh();
  route();
}

// Re-fetch fresh data on a real reload (cache lives only for the session's soft navigations).
resetGalleryCaches();
mount();
