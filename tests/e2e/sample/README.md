# Visual Guard sample project

A minimal, deterministic web target used to prove the **canonical flow** (CP5) and the **Phase-1
fan-out review** (CP6) end-to-end:

- `index.html` — the Button component demo, served at the route `/button`.
- `src/Button.css` — the Button's styles + the `:root` design tokens; the padding comes from a
  spacing token (`--vg-space-pad`).
- `badge.html` + `src/Badge.css` — a **2nd component** (the Badge), served at `/badge`. Its
  background is the brand **color token** (`--vg-brand`). It exists for the Phase-1 exit (CP6):
  `review-flow.e2e` inlines that token as its identical hardcoded hex, which leaves the pixels
  unchanged yet is still caught by the token-drift auditor.
- `visual.config.json` — the one-target config the canonical (CP5) flow uses. `review-flow.e2e`
  drives **both** components via its own two-route config (`/button`, `/badge`).

`tests/e2e/canonical-flow.e2e.test.ts` (CP5) copies this project into a temp dir, serves it, and
drives the real engine through the full Button lifecycle:

1. capture → compare with **no baseline** → every render is `new`,
2. `/visual-baseline` (approve) → re-capture → **0 regressions**,
3. replace the `padding: var(--vg-space-pad)` rule with a hardcoded, larger `padding: 48px 40px`
   (a deliberate geometry change that grows the button) → capture → compare → the `button`
   target is flagged **`fail`** and tied back to `src/Button.css`,
4. approve the change → re-capture → **clean** again.

`tests/e2e/review-flow.e2e.test.ts` (CP6) drives **both** components and proves the Phase-1 exit
criterion: a **sub-threshold token drift** on the Badge (the `--vg-brand` color inlined as its
identical hex) is **invisible to the pixel diff** (the Badge target passes) yet **flagged by the
token-drift auditor** — alongside the Button's pixel-visible geometry regression. It also merges a
structured reviewer verdict back into the manifest (the `/visual-check` Phase-1 contract).

See the repository [`README.md`](../../../README.md) for the human-facing walkthrough.
