/* eslint-env browser */
// @ts-check
/**
 * Component Studio detail view (P4, SPEC §11.3): a timeline (ARIA slider over the code-baseline lineage,
 * newest pinned right = Current), a comparison viewer (F / C / Side / Overlay / Diff — Overlay is the
 * honest default for Figma-vs-code; Diff is labeled "code regression vs previous code"), variant tabs
 * (union + origin chips), and a side panel (description / variants parity / launchpad deep links).
 *
 * Per-variant cross-source LINKING is a v2 non-goal, so the Figma half always shows the component's
 * latest Figma render; the timeline + code half follow the selected variant's code lane.
 */

import { el, setChildren, append } from "./dom.js";
import { getComponent, getHistory, imageUrl } from "./api.js";
import {
  deriveBadge,
  isCodeRegressed,
  variantUnion,
  timelineTicks,
  figmaDeepLink,
  storyLink,
  livePreviewUrl,
} from "./view-model.js";

const norm = (s) => String(s).trim().toLowerCase();

function badge(component) {
  const b = deriveBadge(component);
  return el("span", { class: `badge tone-${b.tone}` }, el("span", { class: "dot" }), b.label);
}

function paneImg(snapshot, alt, extraClass) {
  return el(
    "div",
    { class: `pane ${extraClass || ""}` },
    snapshot
      ? el("img", { src: imageUrl(snapshot.id), alt })
      : el("span", { style: { color: "var(--text-faint)" } }, "—"),
  );
}

/** Build the comparison stage for the current mode (state.mode) + selected images. */
function stage(state) {
  const { figmaSnap, codeSnap, baselineSnap, component } = state;
  const figmaAlt = `${component.name} in Figma`;
  const codeAlt = `${component.name} rendered from code`;

  if (state.mode === "F") {
    return el("div", { class: "stage single" }, paneImg(figmaSnap, figmaAlt));
  }
  if (state.mode === "C") {
    return el("div", { class: "stage single" }, paneImg(codeSnap, codeAlt));
  }
  if (state.mode === "O") {
    return el(
      "div",
      { class: "stage single overlay", style: { "--overlay-opacity": String(state.opacity) } },
      paneImg(figmaSnap, figmaAlt, "bottom"),
      paneImg(codeSnap, codeAlt, "top"),
    );
  }
  if (state.mode === "D") {
    // current code over the previous code baseline, blended to surface the pixel delta.
    return el(
      "div",
      { class: "stage single diff" },
      paneImg(baselineSnap || codeSnap, "previous code", "bottom"),
      paneImg(codeSnap, codeAlt, "top"),
    );
  }
  if (state.mode === "L") {
    // Live: embed the running harness's preview of this component (best-effort — blank if it's down).
    if (state.codeRenderUrl) {
      return el(
        "div",
        { class: "stage single live" },
        el("iframe", {
          class: "live-frame",
          src: state.codeRenderUrl,
          title: `${component.name} — live preview`,
          loading: "lazy",
          // allow-scripts + allow-same-origin lets the harness actually render (it's a different
          // loopback origin, so it still can't touch the Studio); withholding the other tokens blocks a
          // misbehaving harness from navigating the top Studio tab or spawning popups.
          sandbox: "allow-scripts allow-same-origin",
        }),
      );
    }
    return el(
      "div",
      { class: "stage single live" },
      el(
        "p",
        { class: "live-empty" },
        "No live URL for this variant — capture from a running story explorer (Storybook / Ladle) to enable a live preview.",
      ),
    );
  }
  // Side-by-side (default fallback)
  return el(
    "div",
    { class: "stage split" },
    paneImg(figmaSnap, figmaAlt),
    paneImg(codeSnap, codeAlt),
  );
}

function compareCaption(state) {
  if (state.mode === "D") {
    return "Diff — code regression (current code vs the previous code render). Anti-aliasing noise is normal; not a design violation.";
  }
  if (state.mode === "O") {
    return "Overlay — Figma blended over code. The honest Figma-vs-code view; use the slider to fade between them.";
  }
  if (state.mode === "L") {
    return "Live — the component rendered by your running harness. Blank means the harness isn't running; the Code view shows the last capture.";
  }
  return null;
}

function compareViewer(state, rerender) {
  const modes = [
    ["F", "Figma"],
    ["C", "Code"],
    ["S", "Side-by-side"],
    ["O", "Overlay"],
    ["D", "Diff"],
  ];
  // Offer Live only when the selected variant has a (loopback) harness URL to embed.
  if (state.codeRenderUrl) {
    modes.push(["L", "Live"]);
  }
  const toggles = el(
    "div",
    { class: "compare-toggles", role: "group", "aria-label": "Comparison view" },
    modes.map(([key, label]) =>
      el(
        "button",
        {
          class: "toggle",
          type: "button",
          "aria-pressed": String(state.mode === key),
          onClick: () => {
            state.mode = key;
            rerender();
          },
        },
        label,
      ),
    ),
  );

  const parts = [toggles, stage(state)];
  if (state.mode === "O") {
    const slider = el("input", {
      type: "range",
      name: "overlay-opacity",
      min: "0",
      max: "100",
      value: String(Math.round(state.opacity * 100)),
      "aria-label": "Overlay opacity (Figma over code)",
    });
    slider.addEventListener("input", () => {
      state.opacity = Number(slider.value) / 100;
      const st = parts[1];
      if (st instanceof HTMLElement) {
        st.style.setProperty("--overlay-opacity", String(state.opacity));
      }
    });
    parts.push(el("div", { class: "overlay-control" }, "Figma", slider, "Code"));
  }
  const caption = compareCaption(state);
  if (caption) {
    parts.push(el("div", { class: "compare-caption" }, caption));
  }
  return el("div", { class: "compare" }, parts);
}

/** ARIA-slider timeline over the selected variant's code lane. Keyboard: ←/→ step, Home/End ends. */
function timeline(state, rerender) {
  const ticks = state.ticks;
  if (!ticks.length) {
    return el(
      "div",
      { class: "timeline" },
      el("div", { class: "timeline-head" }, el("strong", {}, "TIMELINE"), el("span", {}, "no code history")),
      el("p", { style: { color: "var(--text-muted)", margin: "0" } }, "No code snapshots recorded for this variant yet."),
    );
  }
  const selectedIndex = state.tickIndex;
  const track = el("div", {
    class: "track",
    role: "slider",
    tabindex: "0",
    "aria-label": "Snapshot timeline",
    "aria-valuemin": "1",
    "aria-valuemax": String(ticks.length),
    "aria-valuenow": String(selectedIndex + 1),
    "aria-valuetext": tickLabel(ticks[selectedIndex], selectedIndex, ticks.length),
  });
  track.append(el("div", { class: "rail" }));
  ticks.forEach((t, i) => {
    track.append(
      el("div", {
        class: `tick${t.isCurrent ? " current" : ""}${i === selectedIndex ? " selected" : ""}`,
        title: tickLabel(t, i, ticks.length),
      }),
    );
  });
  track.addEventListener("keydown", (e) => {
    let next = selectedIndex;
    // Shift+←/→ jumps to the ends (every stored tick IS a real visual change — snapshots are appended
    // only on a hash change — so a per-tick "changed" jump degenerates to step; jump-to-end is the
    // meaningful coarse move). Home/End also jump to the ends.
    if (e.key === "ArrowRight") next = e.shiftKey ? ticks.length - 1 : Math.min(ticks.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowLeft") next = e.shiftKey ? 0 : Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ticks.length - 1;
    else return;
    e.preventDefault();
    state.tickIndex = next;
    applyTickSelection(state);
    rerender();
  });

  const sel = ticks[selectedIndex];
  return el(
    "div",
    { class: "timeline" },
    el(
      "div",
      { class: "timeline-head" },
      el("strong", {}, "TIMELINE"),
      el("span", {}, "◀ older   newer ▶"),
    ),
    track,
    el("div", { class: "provenance" }, tickLabel(sel, selectedIndex, ticks.length)),
  );
}

function tickLabel(tick, index, total) {
  if (!tick) {
    return "";
  }
  const bits = [tick.isCurrent ? "Current" : `v${tick.versionSeq}`];
  if (tick.capturedAt) bits.push(tick.capturedAt.slice(0, 10));
  if (tick.gitSha) bits.push(`code ${String(tick.gitSha).slice(0, 7)}`);
  if (tick.figmaVersionId) bits.push(`figma ${tick.figmaVersionId}`);
  return `${bits.join(" · ")} (${index + 1}/${total})`;
}

/** Recompute the code/baseline snapshots shown, from the selected timeline tick. */
function applyTickSelection(state) {
  const ticks = state.ticks;
  if (!ticks.length) {
    return;
  }
  const sel = ticks[state.tickIndex];
  // The selected code snapshot id maps back to the history row.
  state.codeSnap = state.historyById.get(sel.id) || state.codeSnap;
  // Baseline for the Diff view = the previous tick (or the same if at the start).
  const prev = ticks[Math.max(0, state.tickIndex - 1)];
  state.baselineSnap = state.historyById.get(prev.id) || state.codeSnap;
}

function variantTabs(state, rerender) {
  if (!state.union.length) {
    return null;
  }
  // A single-select toggle group (aria-pressed), not an ARIA tablist: there is no separate tabpanel and
  // no roving-tabindex arrow nav, so aria-pressed buttons (matching the compare toggles) are the honest,
  // keyboard-operable semantics — not an incomplete tabs pattern.
  return el(
    "div",
    { class: "variant-tabs", role: "group", "aria-label": "Variant" },
    state.union.map((v) => {
      const originLabel = v.origin === "both" ? "Figma+Code" : v.origin === "figma-only" ? "Figma only ◆" : "Code only ◇";
      return el(
        "button",
        {
          class: "toggle",
          type: "button",
          "aria-pressed": String(norm(v.name) === norm(state.selectedVariant)),
          onClick: () => {
            state.selectedVariant = v.name;
            selectVariantLane(state);
            rerender();
          },
        },
        v.name,
        el("span", { class: "origin-chip" }, originLabel),
      );
    }),
  );
}

/** Switch the code lane (timeline + code image) to the selected variant's code snapshots. */
function selectVariantLane(state) {
  const codeVariant = state.variants.find(
    (v) => v.source === "code" && norm(v.name) === norm(state.selectedVariant),
  );
  const laneId = codeVariant ? codeVariant.id : null;
  // The selected code variant's live-preview URL (validated loopback http(s)), or null.
  state.codeRenderUrl = codeVariant ? livePreviewUrl(codeVariant.render_url) : null;
  // Code lineage for the lane: approved 'code' snapshots, else fall back to 'current' renders.
  let lane = state.history.filter((s) => s.source === "code" && s.variant_id === laneId);
  if (!lane.length) {
    lane = state.history.filter((s) => s.source === "current" && s.variant_id === laneId);
  }
  state.ticks = timelineTicks(lane);
  state.tickIndex = Math.max(0, state.ticks.length - 1); // default to Current (rightmost)
  applyTickSelection(state);
}

function sidePanel(state) {
  const { component } = state;
  const sections = [];
  if (component.description) {
    sections.push(el("section", {}, el("h3", {}, "Description"), el("p", {}, component.description)));
  }

  const figmaOnly = state.union.filter((v) => v.origin === "figma-only");
  const codeOnly = state.union.filter((v) => v.origin === "code-only");
  if (figmaOnly.length || codeOnly.length) {
    const items = [];
    for (const v of figmaOnly) {
      items.push(el("li", {}, `${v.name} `, el("span", { class: "regression-flag" }, "▸ in Figma, no code")));
    }
    for (const v of codeOnly) {
      items.push(el("li", {}, `${v.name} `, el("span", { style: { color: "var(--text-muted)" } }, "▸ in code, not in Figma")));
    }
    sections.push(el("section", {}, el("h3", {}, "Variants parity"), el("ul", {}, items)));
  }

  if (state.usages && state.usages.length) {
    sections.push(
      el(
        "section",
        {},
        el("h3", {}, `Used in (${state.usages.length})`),
        el("ul", {}, state.usages.slice(0, 12).map((u) => el("li", {}, u.used_in))),
      ),
    );
  }

  // Launchpad — external navigations (target=_blank); allowed by CSP (not a fetch/connect).
  const figmaUrl = figmaDeepLink(component.figma_file_key, component.figma_node_id);
  const story = storyLink(state.storyBaseUrl, component.story_id);
  const links = [];
  if (figmaUrl) {
    links.push(el("a", { class: "btn", href: figmaUrl, target: "_blank", rel: "noopener noreferrer" }, "Open in Figma"));
  }
  if (story) {
    links.push(el("a", { class: "btn", href: story, target: "_blank", rel: "noopener noreferrer" }, "Open the story"));
  }
  if (links.length) {
    sections.push(el("section", {}, el("h3", {}, "Launchpad"), el("div", { class: "launchpad" }, links)));
  }

  return el("aside", { class: "sidepanel" }, sections);
}

function render(root, state) {
  const rerender = () => render(root, state);
  const diffPct =
    typeof state.diffRatio === "number" ? ` · pixel diff ${(state.diffRatio * 100).toFixed(2)}%` : "";

  const head = el(
    "div",
    { class: "detail-head" },
    el("a", { class: "btn", href: "#/" }, "‹ Back"),
    el("h1", { id: "main", tabindex: "-1" }, state.component.name),
    badge(state.component),
    isCodeRegressed(state.component) ? el("span", { class: "regression-flag" }, `regression${diffPct}`) : null,
    el("div", { class: "spacer" }),
  );

  const body = el(
    "div",
    { class: "detail-body" },
    el("div", {}, compareViewer(state, rerender)),
    sidePanel(state),
  );
  const tabs = variantTabs(state, rerender);

  setChildren(
    root,
    el("div", { class: "detail" }, head, timeline(state, rerender), tabs, body),
  );
  root.removeAttribute("aria-busy");
}

/** Mount the detail view for `id` into `root`. */
export async function renderDetail(root, id, options) {
  root.setAttribute("aria-busy", "true");
  setChildren(root, el("div", { class: "panel" }, el("p", {}, "Loading…")));
  let detail;
  let history;
  try {
    [detail, history] = await Promise.all([getComponent(id), getHistory(id)]);
  } catch (err) {
    setChildren(
      root,
      el(
        "div",
        { class: "panel" },
        el("a", { class: "btn", href: "#/" }, "‹ Back"),
        el("div", { class: "inline-error", role: "alert" }, err && err.message ? err.message : "Could not load this component."),
      ),
    );
    root.removeAttribute("aria-busy");
    return;
  }

  const historyById = new Map(history.map((s) => [s.id, s]));
  const union = variantUnion(detail.variants);
  const state = {
    component: detail.component,
    variants: detail.variants,
    usages: detail.usages || [],
    union,
    history,
    historyById,
    storyBaseUrl: (options && options.storyBaseUrl) || null,
    diffRatio: null,
    // Compare: Overlay is the honest default when both sides exist, else Side-by-side.
    mode: detail.latest.figma && (detail.latest.current || detail.latest.code) ? "O" : "S",
    opacity: 0.5,
    figmaSnap: detail.latest.figma,
    codeSnap: detail.latest.current || detail.latest.code,
    baselineSnap: detail.latest.code,
    // Default to a variant that has a CODE lane so the timeline isn't empty (Figma/code variant names
    // differ by @viewport, so the alphabetically-first union entry is often Figma-only). Falls back to
    // the first entry for a Figma-only component.
    selectedVariant: (union.find((v) => v.inCode) || union[0] || { name: "" }).name,
    ticks: [],
    tickIndex: 0,
    codeRenderUrl: null,
  };
  selectVariantLane(state);
  render(root, state);
}
