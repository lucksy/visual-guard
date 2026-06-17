/**
 * Component export scanner (pure). Given a component source file's path + contents, find the React
 * component(s) it exports so the scaffolder can generate a Ladle story per component. Intentionally
 * **regex/heuristic, not a full AST parse** — matching the repo's dependency-free style (cf. token-scan).
 *
 * KNOWN LIMITATIONS (documented, not bugs): `forwardRef`/`memo`-wrapped exports and re-exports
 * (`export { X } from './x'`) are detected by name but their props can't be analyzed (so they default to
 * `likelyNeedsProps: false`); generic components and unusual export forms may be missed. Every generated
 * story is user-editable and never overwritten, so a wrong/blank guess is cheap to correct by hand. An
 * AST-accurate pass (TypeScript is already an engine dep) is a later drop-in behind this same signature.
 */

export interface ComponentExport {
  /** Project-relative POSIX path of the source file. */
  file: string;
  /** Exported identifier (PascalCase). For an anonymous default export, derived from the file name. */
  name: string;
  kind: "default" | "named";
  /** Heuristic: the component's destructured props include at least one with no default (likely required). */
  likelyNeedsProps: boolean;
}

/** Components are PascalCase by React convention — this filters out hooks/utils/constants. */
const PASCAL = /^[A-Z][A-Za-z0-9_$]*$/;

/** Strip the extension and return the basename, e.g. "src/ui/Button.tsx" → "Button". */
function basenameNoExt(file: string): string {
  const last = file.split("/").pop() ?? file;
  return last.replace(/\.[^.]+$/, "");
}

/** PascalCase an identifier from a file path; for an `index` file, use the parent directory name. */
export function componentNameFromFile(file: string): string {
  let base = basenameNoExt(file);
  if (base.toLowerCase() === "index") {
    const segments = file.split("/");
    base = segments.length >= 2 ? (segments[segments.length - 2] ?? base) : base;
  }
  const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return pascal.length > 0 ? pascal : "Component";
}

/** From `src[openIndex]` === open, return the index of the matching close (or -1). Depth-aware. */
function matchingIndex(src: string, openIndex: number, open: string, close: string): number {
  if (src[openIndex] !== open) return -1;
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a destructuring body on top-level commas (ignoring nested (), [], {}). */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/**
 * Does this parameter source imply required props? Only a **destructured** first param is analyzed
 * (`({ a, b = 1 })`): a property with no `=` default and not a `...rest` is "required". An empty param
 * list, or an opaque single param (`props`/`props: P`), returns false — we don't guess, to keep the
 * warning high-signal rather than flagging every component that merely accepts props.
 */
function paramLikelyNeedsProps(paramSrc: string): boolean {
  const trimmed = paramSrc.trim();
  if (!trimmed.startsWith("{")) return false;
  const close = matchingIndex(trimmed, 0, "{", "}");
  if (close === -1) return false;
  const inner = trimmed.slice(1, close);
  const props = splitTopLevel(inner)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return props.some((p) => !p.startsWith("...") && !p.includes("="));
}

/** Extract the `(...)` parameter substring beginning at the `(` at `parenIndex` (or "" if absent). */
function paramsAt(src: string, parenIndex: number): string {
  if (src[parenIndex] !== "(") return "";
  const close = matchingIndex(src, parenIndex, "(", ")");
  return close === -1 ? "" : src.slice(parenIndex + 1, close);
}

/**
 * Find the component exports in a source file. Deduped by `kind:name`, deterministic in source order.
 * Non-PascalCase identifiers are dropped (hooks/utilities are not components).
 */
export function extractComponentExports(file: string, source: string): ComponentExport[] {
  const found: ComponentExport[] = [];
  const seen = new Set<string>();

  const add = (rawName: string, kind: "default" | "named", paramSrc: string): void => {
    const name = rawName.length > 0 ? rawName : componentNameFromFile(file);
    if (!PASCAL.test(name)) return;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file, name, kind, likelyNeedsProps: paramLikelyNeedsProps(paramSrc) });
  };

  let match: RegExpExecArray | null;

  // export default function Name(...)  /  export default function (...)  (anonymous → name from file)
  const defFn = /export\s+default\s+function\s*([A-Za-z0-9_$]*)\s*\(/g;
  while ((match = defFn.exec(source)) !== null) {
    add(match[1] ?? "", "default", paramsAt(source, defFn.lastIndex - 1));
  }

  // export default class Name  (props live on this.props — not analyzed)
  const defClass = /export\s+default\s+class\s+([A-Za-z0-9_$]+)/g;
  while ((match = defClass.exec(source)) !== null) {
    add(match[1] ?? "", "default", "");
  }

  // export default (props) => ...  /  export default props => ...  (anonymous arrow → name from file)
  const defArrow = /export\s+default\s+(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g;
  while ((match = defArrow.exec(source)) !== null) {
    const captured = (match[1] ?? "").trim();
    const paramSrc = captured.startsWith("(") ? captured.slice(1, -1) : "";
    add("", "default", paramSrc);
  }

  // export default Name;  (a previously-declared identifier; PascalCase only)
  const defIdent = /export\s+default\s+([A-Z][A-Za-z0-9_$]*)\s*;?/g;
  while ((match = defIdent.exec(source)) !== null) {
    add(match[1] ?? "", "default", "");
  }

  // export function Name(...)
  const namedFn = /export\s+function\s+([A-Za-z0-9_$]+)\s*\(/g;
  while ((match = namedFn.exec(source)) !== null) {
    add(match[1] ?? "", "named", paramsAt(source, namedFn.lastIndex - 1));
  }

  // export class Name
  const namedClass = /export\s+class\s+([A-Za-z0-9_$]+)/g;
  while ((match = namedClass.exec(source)) !== null) {
    add(match[1] ?? "", "named", "");
  }

  // export const Name = ...  (arrow / function expr / FC); extract params when the value is a direct
  // arrow or function expression. forwardRef(...)/memo(...) wrappers are named but not param-analyzed.
  const namedConst = /export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*/g;
  while ((match = namedConst.exec(source)) !== null) {
    const name = match[1] ?? "";
    const valueStart = namedConst.lastIndex;
    let paramSrc = "";
    if (source[valueStart] === "(") {
      paramSrc = paramsAt(source, valueStart);
    } else {
      const fnExpr = /^function\s*[A-Za-z0-9_$]*\s*\(/.exec(source.slice(valueStart));
      if (fnExpr !== null) {
        paramSrc = paramsAt(source, valueStart + fnExpr[0].length - 1);
      }
    }
    add(name, "named", paramSrc);
  }

  return found;
}
