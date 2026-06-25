import { mkdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process advisory file lock + atomic write — for the committed `figma_meta.json` (Component
 * Studio). `/visual-sync` fans out BATCH=6 `record-figma` SUBPROCESSES concurrently, all doing a
 * read-modify-write of the ONE shared `figma_meta.json`; a plain `writeFileSync` there is
 * last-writer-wins, silently dropping a just-committed baseline (the PNG survives on disk, but `reindex`
 * rebuilds the Figma side from the meta ALONE, so the dropped entry vanishes on the next reindex). An
 * in-process mutex is useless across separate OS processes.
 *
 * The lock is a DIRECTORY (`mkdir` is atomic on POSIX + NTFS) with stale-lock recovery (a holder that
 * crashed leaves an orphan dir; one older than `staleMs` is broken). The write is temp-file + `rename`
 * (atomic on a single filesystem), so a reader never observes a half-written file and a crash mid-write
 * leaves only an orphan temp, never a corrupt committed index. Pure-ish + unit-testable.
 */

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing (default 10s). */
  timeoutMs?: number;
  /** A held lock older than this is presumed orphaned (a crashed holder) and broken (default 30s). */
  staleMs?: number;
  /** Blocking backoff between acquisition attempts (default 25ms) — via Atomics.wait, no busy CPU spin. */
  retryMs?: number;
}

/** Block the current thread for `ms` WITHOUT a busy CPU spin (Atomics.wait on a throwaway buffer). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Age of the lock dir in ms (by mtime), or null if it's gone. */
function lockAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null; // already removed
  }
}

/**
 * Run `fn` while holding an exclusive lock on `targetPath` (a sibling `<targetPath>.lock` directory).
 * Acquisition spins with a BLOCKING backoff (no CPU busy-wait) until the lock is free or `timeoutMs`
 * elapses (then throws). A lock older than `staleMs` is presumed orphaned by a crashed holder and broken
 * (re-checked immediately before removal to shrink the TOCTOU window). The lock is ALWAYS released in
 * `finally`. Returns whatever `fn` returns.
 */
export function withFileLock<T>(targetPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 25;
  const lockDir = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir); // atomic create — succeeds only when the lock is free
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Held by someone. Break it only if it is demonstrably stale (re-stat right before rmdir so we do
      // not steal a holder that just renewed/replaced it).
      const age = lockAgeMs(lockDir);
      if (age !== null && age > staleMs) {
        try {
          if ((lockAgeMs(lockDir) ?? 0) > staleMs) rmdirSync(lockDir);
        } catch {
          /* someone else broke it (or it became fresh) — fall through and re-loop */
        }
        continue; // retry mkdir immediately (a broken stale lock should let us in next attempt)
      }
      if (Date.now() >= deadline) {
        throw new Error(`withFileLock: timed out after ${timeoutMs}ms waiting for ${lockDir}`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      /* best-effort release (already broken by a stale-breaker, or otherwise gone) */
    }
  }
}

/**
 * Atomically write `contents` to `targetPath`: write a unique temp sibling, then `rename` it over the
 * target (rename is atomic on the same filesystem). A reader concurrently reading `targetPath` sees
 * either the old or the new complete file, never a partial one; a crash mid-write leaves only an orphan
 * temp, never a corrupt target. Callers hold {@link withFileLock} to serialize writers.
 */
export function writeFileAtomic(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp may not have been created */
    }
    throw err;
  }
}
