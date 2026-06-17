/**
 * Pure Figma URL / id helpers (Component Studio P0). No I/O, no MCP, no secret — these only
 * normalize the strings a user pastes during `/visual-init` into the non-secret values Studio
 * stores: a Figma **file key** (committed in `visual.config.json`) and, later (P2), an API-form
 * **node id**. Figma itself is read through the Figma desktop MCP, so there is no token anywhere.
 */

/**
 * A Figma URL embeds the file key after one of the product path words, e.g.
 * `https://www.figma.com/design/<key>/<name>?node-id=…`. Figma Sites uses `figma.site`. The key is
 * base62 (alphanumeric); the capture stops at the first non-key character (`/`, `?`, `#`).
 *
 * The host is **anchored** — `figma.(com|site)` must sit at a host boundary (start of input, after
 * the `//` of a scheme, after whitespace, optionally with subdomains) — so a `figma.com/…` substring
 * embedded in *another* host or query string (`evil.com/?to=figma.com/design/<key>`) is NOT mined.
 * Scheme-less pastes (`figma.com/design/<key>`, `www.figma.com/…`) still match.
 */
const FIGMA_URL_KEY =
  /(?:^|\/\/|\s)(?:[a-z0-9-]+\.)*figma\.(?:com|site)\/(?:file|design|board|proto|slides)\/([A-Za-z0-9]+)/i;

/** Cheap "does this string contain a Figma host?" guard, used to decide URL-vs-bare handling. */
const FIGMA_HOST = /figma\.(?:com|site)\//i;

/** A bare Figma file key: base62, and long enough not to collide with a stray word. */
const FIGMA_KEY = /^[A-Za-z0-9]{16,128}$/;

/**
 * True when `input` looks like a bare Figma file key (base62, 16–128 chars) — i.e. something that
 * can be stored as a `figma.files[].key` without first extracting it from a URL. Conservative on
 * purpose: a URL or a short word is not a key.
 */
export function looksLikeFigmaKey(input: string): boolean {
  return FIGMA_KEY.test(input.trim());
}

/**
 * Normalize a pasted Figma reference into a stored **file key**, returning a key that is always
 * shape-valid ({@link looksLikeFigmaKey}: base62, 16–128) or `null`. Accepts either a full Figma URL
 * (`figma.com|figma.site/{file,design,board,proto,slides}/<key>/…`) or an already-bare key. Returns
 * `null` for a non-Figma URL, a Figma host with no key segment, a too-short/garbage URL key segment,
 * or any bare string that isn't itself a valid key — so a caller can never end up storing arbitrary
 * input (e.g. a `../`-bearing path) as a "key".
 */
export function extractFigmaFileKey(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = FIGMA_URL_KEY.exec(trimmed);
  if (match) {
    const key = match[1];
    // A real Figma key is base62 and bounded; a too-short/garbage URL segment is not a key.
    return key !== undefined && looksLikeFigmaKey(key) ? key : null;
  }
  return looksLikeFigmaKey(trimmed) ? trimmed : null;
}

/**
 * Normalize a Figma node id into the **API form** (`123:456`). Accepts:
 *  - a full Figma URL carrying `?node-id=123-456` (or url-encoded `123%3A456`),
 *  - the bare URL form `123-456`,
 *  - the bare API form `123:456` (returned verbatim).
 * Returns `null` for a Figma URL without a `node-id`, or anything that isn't a `<digits><sep><digits>`
 * pair. (Composite instance ids like `I1:2;3:4` are out of scope for P0 — they arrive in P2.)
 */
export function parseNodeId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let raw = trimmed;
  const fromUrl = /[?&]node-id=([^&#]+)/i.exec(trimmed);
  if (fromUrl && fromUrl[1] !== undefined) {
    try {
      raw = decodeURIComponent(fromUrl[1]);
    } catch {
      return null; // malformed percent-encoding
    }
  } else if (FIGMA_HOST.test(trimmed)) {
    return null; // a Figma URL with no node-id carries no node to normalize
  }

  if (/^[0-9]+:[0-9]+$/.test(raw)) {
    return raw; // already API form
  }
  const dash = /^([0-9]+)-([0-9]+)$/.exec(raw);
  if (dash && dash[1] !== undefined && dash[2] !== undefined) {
    return `${dash[1]}:${dash[2]}`;
  }
  return null;
}
