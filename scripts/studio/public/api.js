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

/** GET /api/components/:id/regressions(?axis=) → regression[] (newest-first), for the drift sparkline. */
export function getRegressions(id, axis) {
  const q = axis ? `?axis=${encodeURIComponent(axis)}` : "";
  return getJson(`/api/components/${id}/regressions${q}`).then((b) => b.regressions);
}

/** GET /api/summary → { total, byStatus, bySyncState, byLifecycle, presence } — the cheap header rollup. */
export function getSummary() {
  return getJson("/api/summary").then((b) => b.summary);
}

/** GET /api/drift → the advisory drift report (new/removed/stale/renamed/presence) for the header strip. */
export function getDrift() {
  return getJson("/api/drift").then((b) => b.drift);
}

/** The same-origin image URL for a snapshot (immutable; safe in <img src>). */
export function imageUrl(snapshotId) {
  return `/api/snapshots/${snapshotId}/image`;
}

/** Same-origin URL for the engine's pixel-diff overlay between two snapshots (changed pixels in red). */
export function diffImageUrl(fromId, toId) {
  return `/api/diff?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`;
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

/**
 * POST /api/snapshots/:id/approve → promote a captured render to the committed code baseline (the durable
 * sign-off). Same-origin, so the server's CSRF guard admits it; failures throw an ApiError carrying the
 * contract's code/message (e.g. `not_approvable` for a Figma snapshot).
 */
export async function approveSnapshot(snapshotId) {
  const res = await fetch(`/api/snapshots/${snapshotId}/approve`, {
    method: "POST",
    headers: { "X-Requested-By": "visual-studio" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body && body.error ? body.error : {};
    throw new ApiError(res.status, err.code || "error", err.message || `approve failed (${res.status})`);
  }
  return body;
}
