/**
 * The shared `fingerprints.json` schema for capture fingerprint-skip — kept in its own tiny,
 * dependency-free module so BOTH `scope.ts` (which emits the CURRENT fingerprints and must not import
 * Playwright via capture.ts) and `capture.ts` (which reads them) agree on the shape + version.
 */

/** Bump to invalidate the on-disk format (distinct from FP_VERSION, which invalidates the hashes). */
export const FINGERPRINTS_VERSION = 1;

/**
 * One render's fingerprint entry. `fp` is the per-render INPUT fingerprint (lib/fingerprint.ts).
 * `png` — the sha1 of the APPROVED baseline PNG's bytes — is present ONLY in the committed approved
 * file; it is tamper-evidence (a corrupted/hand-edited baseline must NOT be laundered as a pass), so a
 * skip verifies the live baseline still hashes to it. The current (scope-emitted) file omits `png`.
 */
export interface FingerprintEntry {
  fp: string;
  png?: string;
}

/**
 * A `fingerprints.json` — renderRelPath → {@link FingerprintEntry}. Two instances exist: the CURRENT
 * fps scope.ts emits for a run (`--fingerprints`, fp only), and the APPROVED fps committed at
 * `baselineDir/fingerprints.json` (written by /visual-baseline, fp + png).
 */
export interface FingerprintsFile {
  version: number;
  renders: Record<string, FingerprintEntry>;
  /**
   * CURRENT file only (scope-emitted): the content inputs behind the fps — relPosix path → byte-hash,
   * the union of globals + emitted closures. Capture re-hashes these AFTER screenshotting and drops the
   * run's persisted fps if any changed, closing the scope-hash → screenshot TOCTOU. Absent in the
   * committed approved file.
   */
  inputs?: Record<string, string>;
}
