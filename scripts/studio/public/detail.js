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

import { el, setChildren, announce } from "./dom.js";
import {
  getComponent,
  getHistory,
  getRegressions,
  approveSnapshot,
  imageUrl,
  diffImageUrl,
  ApiError,
} from "./api.js";
import {
  deriveBadge,
  deriveAxisDiffBadge,
  isCodeRegressed,
  variantUnion,
  timelineTicks,
  figmaDeepLink,
  storyLink,
  livePreviewUrl,
  formatDiffRatio,
  regressionSeries,
  sparklinePath,
  describeParityDrift,
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

/** A pane showing the engine-computed pixel-diff overlay (changed pixels in red) for two snapshots. */
function diffPane(fromSnap, toSnap, alt) {
  if (!fromSnap || !toSnap) {
    return el("div", { class: "pane" }, el("span", { style: { color: "var(--text-faint)" } }, "—"));
  }
  const pane = el("div", { class: "pane diff-pixels" });
  const img = el("img", { src: diffImageUrl(fromSnap.id, toSnap.id), alt });
  img.addEventListener("error", () => {
    // The server couldn't compute the diff (e.g. an undecodable stored image) — show a note, not a broken icon.
    setChildren(pane, el("p", { class: "live-empty" }, "Diff image unavailable for this pair."));
  });
  pane.append(img);
  return pane;
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
    const fromSnap = baselineSnap || codeSnap;
    // The engine's pixel-diff overlay (changed pixels in red) is the honest diff; the CSS blend is the
    // fallback when the user toggles "changed pixels" off (or one side is missing).
    if (state.showDiffPixels && fromSnap && codeSnap) {
      return el(
        "div",
        { class: "stage single diff" },
        diffPane(fromSnap, codeSnap, `${component.name} — changed pixels`),
      );
    }
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
    const sel = state.ticks[state.tickIndex];
    const selLabel = sel && sel.isCurrent ? "Current" : `v${sel ? sel.versionSeq : "?"}`;
    const pinned =
      state.compareIndex != null && state.ticks[state.compareIndex]
        ? state.ticks[state.compareIndex]
        : null;
    const against = pinned ? `the pinned ${pinned.isCurrent ? "Current" : `v${pinned.versionSeq}`}` : "the previous code render";
    if (state.showDiffPixels) {
      return `Diff — changed pixels (red) between ${selLabel} and ${against}, from the engine's pixel comparison. Anti-aliasing is ignored; not a design violation.`;
    }
    return `Diff — ${selLabel} blended over ${against}. Anti-aliasing noise is normal; not a design violation. Toggle "Show changed pixels" for the engine's exact diff.`;
  }
  if (state.mode === "O") {
    let base = "Overlay — Figma blended over code. The honest Figma-vs-code view; use the slider to fade between them.";
    // Explain WHICH axis drifted, from the advisory conformance breakdown (v4) — if we have it.
    const parity = state.comparisons && state.comparisons.parity;
    const drift = parity ? describeParityDrift(parity.dimension_delta, parity.palette_delta) : null;
    if (drift) {
      base += ` Advisory: ${drift}.`;
    }
    return base;
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
            state.writeUrl({ variant: state.selectedVariant, mode: state.mode });
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
  if (state.mode === "D") {
    // Toggle between the engine's pixel-diff overlay (changed pixels in red) and the raw CSS blend.
    const toggle = el(
      "button",
      {
        class: "toggle",
        type: "button",
        "aria-pressed": String(state.showDiffPixels),
        onClick: () => {
          state.showDiffPixels = !state.showDiffPixels;
          rerender();
        },
      },
      "Show changed pixels",
    );
    parts.push(el("div", { class: "diff-control" }, toggle));
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
    const cls =
      `tick${t.isCurrent ? " current" : ""}${i === selectedIndex ? " selected" : ""}` +
      `${i === state.compareIndex ? " compare" : ""}`;
    const tick = el("div", { class: cls, title: tickLabel(t, i, ticks.length) });
    // Click selects a tick; Shift-click pins/un-pins it as the A/B compare baseline (Diff view diffs the
    // selected tick against the pin instead of the immediately-previous one).
    tick.addEventListener("click", (e) => {
      if (e.shiftKey) {
        state.compareIndex = state.compareIndex === i ? null : i;
      } else {
        state.tickIndex = i;
      }
      applyTickSelection(state);
      rerender();
    });
    track.append(tick);
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
  const provenance = [el("span", {}, tickLabel(sel, selectedIndex, ticks.length))];
  if (state.compareIndex != null && state.compareIndex !== selectedIndex && ticks[state.compareIndex]) {
    const cmp = ticks[state.compareIndex];
    provenance.push(
      el(
        "span",
        { class: "compare-note" },
        ` · comparing vs ${cmp.isCurrent ? "Current" : `v${cmp.versionSeq}`} `,
        el(
          "button",
          {
            class: "linkbtn",
            type: "button",
            onClick: () => {
              state.compareIndex = null;
              applyTickSelection(state);
              rerender();
            },
          },
          "clear",
        ),
      ),
    );
  }
  return el(
    "div",
    { class: "timeline" },
    el(
      "div",
      { class: "timeline-head" },
      el("strong", {}, "TIMELINE"),
      el("span", {}, "◀ older   newer ▶   ·   shift-click to compare"),
    ),
    track,
    el("div", { class: "provenance" }, provenance),
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

/** Recompute the code/baseline snapshots shown, from the selected timeline tick + the A/B compare pin. */
function applyTickSelection(state) {
  const ticks = state.ticks;
  if (!ticks.length) {
    return;
  }
  const sel = ticks[state.tickIndex];
  // The selected code snapshot id maps back to the history row.
  state.codeSnap = state.historyById.get(sel.id) || state.codeSnap;
  // Baseline for the Diff view: the pinned A/B compare tick if set, else the immediately-previous tick.
  const baseIdx =
    state.compareIndex != null && state.compareIndex >= 0 && state.compareIndex < ticks.length
      ? state.compareIndex
      : Math.max(0, state.tickIndex - 1);
  const prev = ticks[baseIdx];
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
            state.writeUrl({ variant: state.selectedVariant, mode: state.mode });
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
  // This lane's live render + committed baseline (newest of each) — what the Approve action promotes,
  // computed per-variant so approving signs off the variant the reviewer is actually looking at.
  const bySeqDesc = (a, b) => b.version_seq - a.version_seq;
  const currents = state.history
    .filter((s) => s.source === "current" && s.variant_id === laneId)
    .sort(bySeqDesc);
  const baselines = state.history
    .filter((s) => s.source === "code" && s.variant_id === laneId)
    .sort(bySeqDesc);
  state.laneCurrent = currents[0] || null;
  state.laneBaseline = baselines[0] || null;
  // Code lineage for the lane: approved 'code' snapshots, else fall back to 'current' renders.
  let lane = baselines.length ? baselines : currents;
  state.ticks = timelineTicks(lane);
  state.tickIndex = Math.max(0, state.ticks.length - 1); // default to Current (rightmost)
  state.compareIndex = null; // an A/B pin doesn't carry across a lane switch
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

/** A "Approve current render as baseline" bar — shown only when the selected lane's live render differs
 *  from (or has no) committed baseline, so it appears exactly when there's something to sign off. */
function approveBar(state, rerender) {
  const cur = state.laneCurrent;
  if (!cur) {
    return null; // no live render in this lane (e.g. a Figma-only component) — nothing to approve
  }
  const base = state.laneBaseline;
  const differs = !base || base.image_hash !== cur.image_hash;
  if (!differs) {
    return null; // the live render already matches the committed baseline
  }
  const hint = base
    ? "This render differs from the committed baseline."
    : "No committed baseline yet for this variant.";
  const btn = el(
    "button",
    { class: "btn btn-primary", type: "button", disabled: state.approving || undefined },
    state.approving ? "Approving…" : "✓ Approve as baseline",
  );
  btn.addEventListener("click", () => approveCurrent(state, btn, rerender));
  return el(
    "div",
    { class: "approve-bar" },
    el("span", { class: "approve-hint" }, hint),
    btn,
  );
}

/** Promote the selected lane's live render to the committed baseline, then reload the view. */
async function approveCurrent(state, btn, rerender) {
  if (state.approving || !state.laneCurrent) {
    return;
  }
  state.approving = true;
  btn.disabled = true;
  btn.textContent = "Approving…";
  try {
    const res = await approveSnapshot(state.laneCurrent.id);
    announce(
      res && res.promoted === false
        ? "Already the committed baseline."
        : "Approved — this render is now the committed baseline.",
    );
    state.reload(); // re-fetch so the regression clears and the new baseline shows
  } catch (err) {
    state.approving = false;
    rerender();
    const message = err instanceof ApiError ? err.message : "Approve failed.";
    announce(`Approve failed: ${message}`);
    const bar = btn.closest && btn.closest(".approve-bar");
    if (bar) {
      bar.append(el("span", { class: "inline-error", role: "alert" }, message));
    }
  }
}

/** A drift sparkline over the component's code-regression history (diff ratio per recorded change). */
function driftTrend(state) {
  const series = regressionSeries(state.regressions);
  if (series.length < 2) {
    return null; // a single point isn't a trend
  }
  const W = 160;
  const H = 28;
  const points = sparklinePath(series.map((p) => p.ratio), W, H);
  const last = series[series.length - 1];
  const lastPct = formatDiffRatio(last.ratio) || "0%";
  const peak = Math.max(...series.map((p) => p.ratio));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Code drift trend over ${series.length} changes; latest ${lastPct}, peak ${formatDiffRatio(peak) || "0%"}.`,
  );
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", points);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "currentColor");
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("stroke-linecap", "round");
  svg.append(poly);
  return el(
    "div",
    { class: "drift-trend" },
    el("strong", {}, "DRIFT"),
    svg,
    el("span", { class: "drift-meta" }, `${series.length} changes · latest ${lastPct}`),
  );
}

function render(root, state) {
  const rerender = () => render(root, state);
  const dr = formatDiffRatio(state.diffRatio);
  const diffPct = dr ? ` · pixel diff ${dr}` : "";
  // v5 (F4): advisory variant-axis badge — null (hidden) for the synthetic-only / no-figma-axes case.
  const axisBadge = deriveAxisDiffBadge(state.axisDiff);

  const head = el(
    "div",
    { class: "detail-head" },
    el("a", { class: "btn", href: "#/" }, "‹ Back"),
    el("h1", { id: "main", tabindex: "-1" }, state.component.name),
    badge(state.component),
    axisBadge
      ? el(
          "span",
          { class: `badge tone-${axisBadge.tone}`, title: "Figma↔code variant-axis parity (advisory)" },
          el("span", { class: "dot" }),
          axisBadge.label,
        )
      : null,
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
    el(
      "div",
      { class: "detail" },
      head,
      approveBar(state, rerender),
      timeline(state, rerender),
      driftTrend(state),
      tabs,
      body,
    ),
  );
  root.removeAttribute("aria-busy");
}

/** Mount the detail view for `id` into `root`. */
export async function renderDetail(root, id, options) {
  root.setAttribute("aria-busy", "true");
  setChildren(root, el("div", { class: "panel" }, el("p", {}, "Loading…")));
  let detail;
  let history;
  let regressions = [];
  try {
    [detail, history, regressions] = await Promise.all([
      getComponent(id),
      getHistory(id),
      // The drift history is best-effort chrome — never fail the whole view if it can't load.
      getRegressions(id).catch(() => []),
    ]);
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
  const comparisons = detail.comparisons || { code: null, parity: null };
  const liveCurrent = detail.latest.current || null;
  const liveBaseline = detail.latest.code || null;
  // Deep-link seeding (P6): a shared `#/component/:id?variant=&mode=` restores the same review view.
  const deep = (options && options.detailQuery) || {};
  const MODES = new Set(["F", "C", "S", "O", "D", "L"]);
  const computedMode = detail.latest.figma && (detail.latest.current || detail.latest.code) ? "O" : "S";
  const seedVariant = union.find((v) => norm(v.name) === norm(deep.variant || ""));
  const state = {
    id,
    component: detail.component,
    variants: detail.variants,
    usages: detail.usages || [],
    union,
    history,
    historyById,
    regressions,
    comparisons,
    // v5 (F4): the advisory variant-axis diff for the detail badge (informational; not a CI signal).
    axisDiff: detail.axisDiff || null,
    // The live render + committed baseline (separate from the timeline lane, which is baseline lineage).
    liveCurrent,
    liveBaseline,
    storyBaseUrl: (options && options.storyBaseUrl) || null,
    // Pixel-diff magnitude of the latest code regression — the engine computed it; now we show it.
    diffRatio: comparisons.code ? comparisons.code.diff_ratio : null,
    approving: false,
    // Compare: a valid deep-linked mode wins; else Overlay when both sides exist, else Side-by-side.
    mode: deep.mode && MODES.has(deep.mode) ? deep.mode : computedMode,
    opacity: 0.5,
    // Diff mode shows the engine's real changed-pixels overlay by default (toggleable to the CSS blend).
    showDiffPixels: true,
    figmaSnap: detail.latest.figma,
    codeSnap: detail.latest.current || detail.latest.code,
    baselineSnap: detail.latest.code,
    // A deep-linked variant wins; else default to a variant that has a CODE lane so the timeline isn't
    // empty (Figma/code variant names differ by @viewport, so the alphabetically-first union entry is
    // often Figma-only). Falls back to the first entry for a Figma-only component.
    selectedVariant: (seedVariant || union.find((v) => v.inCode) || union[0] || { name: "" }).name,
    ticks: [],
    tickIndex: 0,
    // A/B compare: the tick index to diff the selected tick AGAINST (null = the immediately-previous tick).
    compareIndex: null,
    codeRenderUrl: null,
    // Reflect variant/mode into the URL so a review view is a shareable permalink (no-op if not wired).
    writeUrl: (options && options.writeDetailUrl) || (() => {}),
    // Re-fetch + re-render this view (used after an approve mutates the baseline).
    reload: () => renderDetail(root, id, options),
  };
  selectVariantLane(state);
  render(root, state);
}
