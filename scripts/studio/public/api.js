/* eslint-env browser */
// @ts-check
/**
 * Component Studio API client (P4). Thin fetch wrappers over the P3 JSON API — all same-origin (the page
 * makes zero external calls; CSP `connect-src 'self'`). Errors surface as thrown `ApiError` carrying the
 * server's `{ error: { code, message } }` contract so the UI can show inline, actionable messages.
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body && body.error ? body.error : {};
    throw new ApiError(res.status, err.code || "error", err.message || `request failed (${res.status})`);
  }
  return body;
}

/** GET /api/health → { status, schemaVersion, counts }. */
export function getHealth() {
  return getJson("/api/health");
}

/** GET /api/components(?status=&q=) → { components }. The SPA fetches ALL and filters client-side. */
export function getComponents() {
  return getJson("/api/components").then((b) => b.components);
}

/** GET /api/components/:id → { component, variants, latest }. */
export function getComponent(id) {
  return getJson(`/api/components/${id}`);
}

/** GET /api/components/:id/history(?source=) → snapshot[]. */
export function getHistory(id, source) {
  const q = source ? `?source=${encodeURIComponent(source)}` : "";
  return getJson(`/api/components/${id}/history${q}`).then((b) => b.history);
}

/** The same-origin image URL for a snapshot (immutable; safe in <img src>). */
export function imageUrl(snapshotId) {
  return `/api/snapshots/${snapshotId}/image`;
}

/**
 * POST /api/sync → { ok, summary }. Same-origin, so the server's CSRF guard (Sec-Fetch-Site) admits it.
 * A 409 (already running) and 500 (sync_failed) both throw an ApiError with the contract's code/message.
 */
export async function postSync() {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "X-Requested-By": "visual-studio" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body && body.error ? body.error : {};
    throw new ApiError(res.status, err.code || "error", err.message || `sync failed (${res.status})`);
  }
  return body;
}
