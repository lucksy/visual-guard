import type { AppTarget, Config, StorybookTarget, Target } from "./config";

/**
 * Target resolution: turn a validated {@link Config} into the flat list of individual
 * renders the capture step takes one screenshot for. Pure apart from an injected `fetch`,
 * so it is fully unit-testable with a mock.
 *
 * Storybook discovery queries `/index.json` and falls back to `/stories.json`. Only
 * Storybook >= 7 (the `index.json` / `entries` format) is supported; the legacy SB6
 * `stories.json` shape is rejected with an actionable error. An explicit story or route
 * list in config bypasses discovery entirely.
 */

/** One render to capture: a single component/page in one state at one viewport width. */
export interface RenderTarget {
  /**
   * Instance namespace — the source target's `name`, or its URL host:port. Keeps renders
   * from different Storybook/app instances in distinct output/baseline paths so two
   * instances exposing the same component never collide.
   */
  instance: string;
  /** Component (Storybook) or page (app) name — capture groups output by this. */
  name: string;
  /** A distinct state: a Storybook story name, or a config `states` entry for an app. */
  state: string;
  /** Viewport width in pixels. */
  viewport: number;
  /** Fully-resolved URL Playwright navigates to. */
  url: string;
  /** Origin of this target — tells capture how to realize the state. */
  kind: "storybook" | "app";
}

/** Minimal structural subset of the DOM `Response` that this module needs. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injected fetch — defaults to the runtime global; mocked in tests. */
export type FetchLike = (url: string) => Promise<FetchResponse>;

const defaultFetch: FetchLike = (url) => globalThis.fetch(url);

const PREFIX = "Visual Guard targets";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The component grouping for a story — the last segment of its Storybook title path. */
function componentFromTitle(title: string): string {
  const segments = title
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last ?? title;
}

/**
 * Split a Storybook story id (`kebab-title--story-name`) into a component + state.
 * Used only for explicit story lists, where the rich `index.json` title/name are absent.
 */
function parseStoryId(id: string): { name: string; state: string } {
  const separator = id.lastIndexOf("--");
  if (separator === -1) {
    return { name: id, state: "default" };
  }
  const name = id.slice(0, separator);
  const state = id.slice(separator + 2);
  return { name: name.length > 0 ? name : id, state: state.length > 0 ? state : "default" };
}

/** A discovered or explicitly-listed story, normalized for expansion. */
interface StoryRef {
  id: string;
  component: string;
  state: string;
}

function refFromEntry(id: string, title: string | undefined, name: string | undefined): StoryRef {
  // `component` and `state` become path segments and derive from untrusted story metadata,
  // so they are sanitized here at the single point both discovered and explicit refs pass through.
  if (title !== undefined) {
    return {
      id,
      component: sanitizePathSegment(componentFromTitle(title)),
      state: sanitizePathSegment(name ?? "default"),
    };
  }
  const parsed = parseStoryId(id);
  return {
    id,
    component: sanitizePathSegment(parsed.name),
    state: sanitizePathSegment(name ?? parsed.state),
  };
}

function iframeUrl(base: string, id: string): string {
  return `${stripTrailingSlash(base)}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`;
}

function routeUrl(base: string, route: string): string {
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${stripTrailingSlash(base)}${path}`;
}

/** A filesystem-safe page name from a route: "/" → "index", "/user/settings" → "user-settings". */
function nameFromRoute(route: string): string {
  const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return "index";
  }
  return trimmed.replace(/\//g, "-");
}

/**
 * Make a string safe to use as a single filesystem path segment. `instance`, `name`, and
 * `state` flow into the capture/baseline path, and some of them come from untrusted sources
 * (Storybook story titles/names fetched over HTTP, config strings) — so a value like
 * "../../etc/x" must never escape the run directory (RULES.md: prevent path traversal).
 * Replaces path separators / control chars / spaces with "-", collapses parent-dir runs,
 * and strips leading dots; an empty result becomes "_".
 */
export function sanitizePathSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-") // separators, NUL, spaces, etc. → dash
    .replace(/\.\.+/g, ".") // collapse "..", "..." → "." (no parent-dir refs)
    .replace(/^\.+/, ""); // no leading dot (no ".", "..", or hidden files)
  return cleaned.length > 0 ? cleaned : "_";
}

/** A filesystem-safe instance label from a URL host:port, e.g. "localhost:6006" → "localhost-6006". */
function instanceFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return fail(`target url ${JSON.stringify(url)} is not a valid URL.`);
  }
  return host.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** The instance namespace for a target: its explicit `name`, else the URL host:port (sanitized). */
function instanceLabel(target: Target): string {
  return sanitizePathSegment(target.name ?? instanceFromUrl(target.url));
}

/**
 * Parse a Storybook story index (from `/index.json` or `/stories.json`) into story refs.
 * The modern shape is `{ v: >=4, entries: { id: { id, title, name, type } } }`; the legacy
 * SB6 shape `{ v: 3, stories: {...} }` is rejected. `docs` entries are not renderable and
 * are filtered out.
 */
function parseStoryIndex(payload: unknown, sourceUrl: string, base: string): StoryRef[] {
  if (!isRecord(payload)) {
    fail(`Storybook index at ${sourceUrl} was not a JSON object.`);
  }

  const version = typeof payload.v === "number" ? payload.v : undefined;

  // Legacy SB6 `stories.json` — explicitly unsupported.
  if (isRecord(payload.stories) && !isRecord(payload.entries)) {
    fail(
      `Storybook ${version ?? "< 7"} detected at ${base} (legacy "stories.json" format). ` +
        `Visual Guard supports Storybook >= 7 (index.json "entries"). Upgrade Storybook, or ` +
        `list explicit story ids in config to bypass discovery.`,
    );
  }

  if (version !== undefined && version < 4) {
    fail(
      `Storybook index at ${sourceUrl} reports v${version}; Visual Guard supports ` +
        `Storybook >= 7 (index v4+).`,
    );
  }

  const entries = payload.entries;
  if (!isRecord(entries)) {
    fail(`Storybook index at ${sourceUrl} has no "entries"; is this Storybook >= 7?`);
  }

  const refs: StoryRef[] = [];
  for (const value of Object.values(entries)) {
    if (!isRecord(value)) continue;
    const type = typeof value.type === "string" ? value.type : undefined;
    if (type === "docs") continue; // documentation pages aren't component renders
    // A blank id would yield an empty component name and a broken "//" capture path —
    // skip junk entries rather than emit a meaningless render.
    const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : undefined;
    if (id === undefined) continue;
    const title = typeof value.title === "string" ? value.title : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    refs.push(refFromEntry(id, title, name));
  }
  return refs;
}

/** Query `/index.json`, falling back to `/stories.json`, and parse whichever responds. */
async function discoverStories(base: string, fetchImpl: FetchLike): Promise<StoryRef[]> {
  const indexUrl = `${stripTrailingSlash(base)}/index.json`;
  const storiesUrl = `${stripTrailingSlash(base)}/stories.json`;
  const reasons: string[] = [];

  const tryFetch = async (url: string): Promise<unknown | null> => {
    let response: FetchResponse;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      reasons.push(`${url}: ${detailOf(err)}`);
      return null;
    }
    if (!response.ok) {
      reasons.push(`${url}: HTTP ${response.status}`);
      return null;
    }
    try {
      return await response.json();
    } catch (err) {
      reasons.push(`${url}: invalid JSON (${detailOf(err)})`);
      return null;
    }
  };

  const indexPayload = await tryFetch(indexUrl);
  if (indexPayload !== null) {
    return parseStoryIndex(indexPayload, indexUrl, base);
  }

  const storiesPayload = await tryFetch(storiesUrl);
  if (storiesPayload !== null) {
    return parseStoryIndex(storiesPayload, storiesUrl, base);
  }

  return fail(
    `could not discover Storybook stories at ${base} (tried /index.json then ` +
      `/stories.json — ${reasons.join("; ")}). Is Storybook running? You can also list ` +
      `explicit story ids in config to bypass discovery.`,
  );
}

async function expandStorybook(
  target: StorybookTarget,
  instance: string,
  viewports: number[],
  fetchImpl: FetchLike,
): Promise<RenderTarget[]> {
  // An explicit `stories` list (even an empty one) bypasses discovery entirely — only an
  // omitted `stories` field triggers a network fetch. Blank ids are dropped so they can
  // never produce an empty-named render.
  const refs =
    target.stories !== undefined
      ? target.stories
          .filter((id) => id.trim().length > 0)
          .map((id) => refFromEntry(id, undefined, undefined))
      : await discoverStories(target.url, fetchImpl);

  const renders: RenderTarget[] = [];
  for (const ref of refs) {
    for (const viewport of viewports) {
      renders.push({
        instance,
        name: ref.component,
        state: ref.state,
        viewport,
        url: iframeUrl(target.url, ref.id),
        kind: "storybook",
      });
    }
  }
  return renders;
}

function expandApp(
  target: AppTarget,
  instance: string,
  viewports: number[],
  states: string[],
): RenderTarget[] {
  if (target.routes === undefined || target.routes.length === 0) {
    fail(
      `app target ${target.url} has no "routes". Phase 0 cannot auto-discover app routes — ` +
        `list them in config (e.g. "routes": ["/login"]).`,
    );
  }

  const renders: RenderTarget[] = [];
  for (const route of target.routes) {
    // `name` and `state` become path segments; sanitize (route + config state are user-controlled).
    const name = sanitizePathSegment(nameFromRoute(route));
    const url = routeUrl(target.url, route);
    for (const viewport of viewports) {
      for (const state of states) {
        renders.push({
          instance,
          name,
          state: sanitizePathSegment(state),
          viewport,
          url,
          kind: "app",
        });
      }
    }
  }
  return renders;
}

/**
 * Expand a validated config into the flat list of renders to capture. Storybook targets
 * cross each discovered/listed story with every viewport (the story name is the state);
 * app targets cross each route with every viewport and every config state. `fetchImpl`
 * is injected for testing and defaults to the runtime global `fetch`.
 */
export async function resolveTargets(
  config: Config,
  fetchImpl: FetchLike = defaultFetch,
): Promise<RenderTarget[]> {
  // Resolve every instance label first and reject collisions up front, so two targets can
  // never silently overwrite each other's renders/baselines (always-nested path scheme).
  const labels = config.targets.map((target) => instanceLabel(target));
  const seen = new Set<string>();
  labels.forEach((label, index) => {
    if (seen.has(label)) {
      fail(
        `duplicate instance label ${JSON.stringify(label)} (targets[${index}] collides with an ` +
          `earlier target). Give each target a unique "name".`,
      );
    }
    seen.add(label);
  });

  const renders: RenderTarget[] = [];
  for (let index = 0; index < config.targets.length; index++) {
    const target = config.targets[index];
    const instance = labels[index];
    if (target === undefined || instance === undefined) continue;
    if (target.type === "storybook") {
      renders.push(...(await expandStorybook(target, instance, config.viewports, fetchImpl)));
    } else {
      renders.push(...expandApp(target, instance, config.viewports, config.states));
    }
  }
  return renders;
}
