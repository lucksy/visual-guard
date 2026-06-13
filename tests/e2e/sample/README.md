# Visual Guard sample project

A minimal, deterministic web target used to prove the **canonical flow** end-to-end (CP5):

- `index.html` — a single Button component demo, served at the route `/button`.
- `src/Button.css` — the component's styles; the padding comes from a spacing token (`--vg-space-pad`).
- `visual.config.json` — a one-target, one-viewport, one-state config (fast to run).

`tests/e2e/canonical-flow.e2e.test.ts` copies this project into a temp dir, serves it, and
drives the real engine through the full lifecycle:

1. capture → compare with **no baseline** → every render is `new`,
2. `/visual-baseline` (approve) → re-capture → **0 regressions**,
3. replace the `padding: var(--vg-space-pad)` rule with a hardcoded, larger `padding: 48px 40px`
   (a deliberate geometry change that grows the button) → capture → compare → the `button`
   target is flagged **`fail`** and tied back to `src/Button.css`,
4. approve the change → re-capture → **clean** again.

See the repository [`README.md`](../../../README.md) for the human-facing walkthrough.
