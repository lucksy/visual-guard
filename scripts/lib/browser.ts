/**
 * R1 determinism settings for capture, isolated as pure values so they can be unit-tested
 * without launching a browser. Capture (`scripts/capture.ts`) owns the Playwright I/O and
 * applies these. The goal: the same component captured twice yields byte-identical pixels
 * (the CP3 gate) and baselines are portable across machines.
 *
 * Determinism contract — what these settings neutralize vs. what is the component's job:
 *  - NEUTRALIZED: HiDPI scaling, CSS animations/transitions, the text caret, OS scrollbar
 *    width, text-selection highlights, dark-mode defaults, web-font FOUT (we await
 *    `document.fonts.ready`), and `<img>` load races (we await image completion).
 *  - COMPONENT'S RESPONSIBILITY: JS-driven animation libraries (Framer Motion, React
 *    Spring, GSAP, etc.) only settle if they honor `prefers-reduced-motion`; and fixtures
 *    must not render live timestamps / `Math.random()` content. Such renders are
 *    non-deterministic regardless of these settings (documented Phase-0 limitation).
 */

/** Default context height; capture uses full-page screenshots so content taller than this still lands. */
export const DEFAULT_VIEWPORT_HEIGHT = 900;

/** The deterministic subset of Playwright's BrowserContext options Visual Guard pins. */
export interface DeterministicContextOptions {
  viewport: { width: number; height: number };
  /** Pin to 1 so HiDPI machines don't double the pixel count (R1). */
  deviceScaleFactor: number;
  /** Honor prefers-reduced-motion so CSS animations resolve to their end state instantly. */
  reducedMotion: "reduce";
  /** Pin the color scheme so dark-mode defaults don't make baselines machine-dependent. */
  colorScheme: "light";
}

/**
 * Build the deterministic context options for a given viewport width. Throws on a
 * non-positive width — capture must never silently render at a bogus size.
 */
export function contextOptions(
  width: number,
  height: number = DEFAULT_VIEWPORT_HEIGHT,
): DeterministicContextOptions {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Visual Guard browser: viewport width must be a positive number (got ${width}).`);
  }
  return {
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
  };
}

/**
 * CSS injected before the page renders: collapse animation/transition timing to zero, hide
 * the blinking caret, neutralize selection highlights, and remove the OS scrollbar (whose
 * width varies by platform). Pairs with `reducedMotion: "reduce"` for belt-and-suspenders
 * determinism (R1).
 */
export const FREEZE_STYLE = `*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
::selection { background-color: transparent !important; }
html { scrollbar-width: none !important; }
::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }`;

/**
 * Init script (string, runs in the browser) that injects FREEZE_STYLE at document start —
 * BEFORE any page CSS/JS executes — so a load-time animation can never be caught mid-flight.
 * Passed to `context.addInitScript` as a raw string to avoid pulling DOM lib types into the
 * Node build.
 */
export const FREEZE_INIT_SCRIPT = `(() => {
  const css = ${JSON.stringify(FREEZE_STYLE)};
  const inject = () => {
    const style = document.createElement('style');
    style.setAttribute('data-visual-guard', 'freeze');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.head || document.documentElement) { inject(); }
  else { document.addEventListener('DOMContentLoaded', inject); }
})();`;

/**
 * Settle script (string, runs in the browser via `page.evaluate`) awaited just before the
 * screenshot: wait for web fonts and `<img>` loads to finish (both race past `networkidle`),
 * then reset scroll so the capture is stable and portable.
 */
export const SETTLE_SCRIPT = `(async () => {
  try { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } } catch (e) { void e; }
  try {
    await Promise.all(Array.from(document.images).map((img) =>
      img.complete
        ? null
        : new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          })));
  } catch (e) { void e; }
  window.scrollTo(0, 0);
})();`;
