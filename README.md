# Visual Guard

Visual Guard is a Claude Code plugin that catches visual bugs in your UI before they merge.

It takes screenshots of your components and pages, compares them to a set of approved
"known-good" images (called **baselines**), and tells you exactly what changed — so you never
have to eyeball screenshots by hand.

## What it does

- **Captures** your UI — Storybook stories or app pages — in a headless browser.
- **Compares** each screenshot to its approved baseline and flags anything that changed.
- **Explains** the change in plain language: what moved, and which file caused it.
- **Lets you sign off.** You approve intended changes as the new baseline. Nothing is approved automatically.

Everything runs on your machine. No screenshots are sent anywhere.

## Requirements

- Claude Code
- A running **Storybook** or **dev server** for Visual Guard to screenshot

## Install

Run these steps inside Claude Code.

**1. Add the marketplace**

```text
/plugin marketplace add lucksy/visual-guard
```

**2. Install the plugin**

```text
/plugin install visual-guard@lucksy
```

The first time it loads it sets itself up automatically (downloads a browser and the tools it
needs). This happens once.

> **First-time setup.** The engine installs automatically on the first session. If you added the
> plugin **mid-session** (so that one-time setup didn't run), run **`/visual-setup`** — it shows
> exactly what it downloads (and where) and asks before installing. Nothing leaves your machine.

**3. Start your UI**

Start your Storybook or dev server, for example:

```bash
npm run storybook     # or: npm run dev
```

**4. Create the config**

```text
/visual-init
```

A short wizard: it finds your running server and design-token files, asks you to **confirm each one**
(or enter your own / add what's missing), then writes `visual.config.json`.

**5. Run your first check**

```text
/visual-check
```

It screenshots your UI, compares against the baseline, and reports what changed. The very first
run has no baseline yet — approve it with `/visual-baseline`.

## Everyday use

1. You change some UI code.
2. Run `/visual-check` — it shows you what changed visually.
3. If the change is intended, run `/visual-baseline` to approve it. If it's a bug, fix it and check again.

```text
> /visual-check button

⚠️  button changed — 3.18% of pixels differ
  cause: src/Button.css — padding changed from a design token to a hardcoded 48px 40px
  the button grew taller

Approve as the new baseline?  →  /visual-baseline button
```

Commit your baselines (the `.visual-baselines/` folder) so your whole team shares the same
known-good images.

## Commands

| Command | What it does |
|---|---|
| `/visual-init` | Guided setup wizard — detects your server and tokens, asks you to confirm or fill in each, then writes `visual.config.json`. |
| `/visual-setup` | Install the engine (browser + tools) if it didn't auto-install — shows what it downloads and asks first. |
| `/visual-check [name]` | Screenshot your UI, compare to the baseline, and explain what changed. |
| `/visual-baseline [name]` | Approve the latest screenshots as the new baseline. |
| `/visual-review` | A deeper review across many components, with each finding double-checked. |
| `/visual-coverage` | Show which components have baselines — and which are missing. |
| `/visual-ci` | Run the full check in CI and write a PR comment; fails the build on unapproved changes. |

## Configuration

`/visual-init` writes this for you, but you can edit `visual.config.json` by hand:

```json
{
  "targets": [
    { "type": "storybook", "url": "http://localhost:6006" }
  ],
  "viewports": [375, 768, 1280],
  "states": ["default", "hover"],
  "tokens": { "source": "src/styles/tokens.css" }
}
```

| Field | What it's for |
|---|---|
| `targets` | The Storybook or app server(s) to screenshot. |
| `viewports` | Screen widths (in pixels) to capture at. |
| `states` | UI states to capture, e.g. `hover` (for apps). |
| `tokens.source` | Your design-tokens file — lets Visual Guard catch hardcoded values that should be tokens. |

## Good to know

- Visual Guard never edits your code, and never approves a baseline on its own.
- Your dev server or Storybook must be running before you run `/visual-check`.
- Everything stays local — nothing is uploaded.

## Development

To work on the plugin itself, point Claude Code at this folder:

```bash
claude --plugin-dir .
```

```bash
npm test           # run all tests
npm run typecheck
npm run lint
```

See [SPEC.md](SPEC.md) for the full design and [TASKS.md](TASKS.md) for the build log.

## License

MIT
