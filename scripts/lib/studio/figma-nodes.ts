/**
 * Parse a Figma desktop MCP `get_metadata` payload (XML) into the component nodes Studio cares about
 * (Component Studio P2, SPEC §9.1). Pure — no MCP, no I/O — so it is unit-tested against fixtures.
 *
 * `get_metadata` returns an XML node tree where the element name is the (kebab-cased) layer type and
 * attributes carry `id`, `name`, `x`, `y`, `width`, `height` — e.g.
 *   <canvas id="0:1" name="Page 1"><symbol id="411:2" name="Cursor/Default" .../></canvas>
 * Figma renders a COMPONENT as `<symbol>` and (observed) a COMPONENT_SET as `<symbol-set>`; we also
 * accept the literal `<component>` / `<component-set>` spellings so a future MCP naming change still
 * parses. A COMPONENT_SET is one Studio component whose child COMPONENTs are its variants; a
 * standalone COMPONENT is a component with no variant axis.
 */

export interface FigmaVariant {
  /** API-form node id of the child COMPONENT. */
  nodeId: string;
  /** Variant label, e.g. "State=Hover" (the child component's name). */
  name: string;
}

export interface FigmaComponent {
  /** API-form node id of the COMPONENT / COMPONENT_SET node. */
  nodeId: string;
  name: string;
  kind: "component" | "component-set";
  /** Child COMPONENTs for a set; empty for a standalone component. */
  variants: FigmaVariant[];
  /**
   * v5 (F5): the node's lastModified timestamp (ISO8601), when `get_metadata` reports it. Drives
   * mapping-staleness detection + the figma capture skip ({@link figmaNodeUnchanged}). Omitted when the
   * payload carries no such attribute (older MCP, or a node type that doesn't report it).
   */
  lastModified?: string;
}

interface RawNode {
  id: string;
  tag: string;
  name: string;
  lastModified?: string;
  children: RawNode[];
}

/** Permissively pick a node's lastModified attribute across plausible spellings (MCP naming drift). */
function pickLastModified(attrs: Record<string, string>): string | undefined {
  const value =
    attrs.lastModified ?? attrs["last-modified"] ?? attrs.lastmodified ?? attrs.updatedAt ?? attrs.updated;
  return value !== undefined && value.length > 0 ? value : undefined;
}

// Permissive: attributes may be double- OR single-quoted, or valueless (e.g. `disabled`), so a tag
// carrying an unusual attribute is still recognized rather than silently dropped.
const TAG = /<(\/)?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/)?>/g;
const ATTR = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/** Decode the XML entities `get_metadata` emits in names (`&#39;`, `&amp;`, `&#xNN;`, …). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // ampersand last, so a literal "&amp;amp;" is not double-decoded
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function parseAttrs(attrsStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(attrsStr)) !== null) {
    if (m[0].length === 0) {
      ATTR.lastIndex += 1; // a zero-width match (valueless tail) can't advance on its own
      continue;
    }
    const key = m[1];
    const val = m[2] ?? m[3]; // double- or single-quoted value; undefined for a valueless attribute
    if (key !== undefined && val !== undefined) {
      attrs[key] = val;
    }
  }
  return attrs;
}

/** Build the node forest from the XML, tolerating malformed nesting (a stray close is ignored). */
function buildForest(xml: string): RawNode[] {
  const roots: RawNode[] = [];
  const stack: RawNode[] = [];
  let m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(xml)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2] ?? "";
    const selfClose = m[4] === "/";
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = parseAttrs(m[3] ?? "");
    const node: RawNode = {
      id: attrs.id ?? "",
      tag,
      name: decodeEntities(attrs.name ?? ""),
      lastModified: pickLastModified(attrs),
      children: [],
    };
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(node);
    if (!selfClose) {
      stack.push(node);
    }
  }
  return roots;
}

/** Normalize a tag for type comparison: lowercase, drop `-`/`_` (`symbol-set` → `symbolset`). */
function normTag(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, "");
}

function isComponentTag(tag: string): boolean {
  const t = normTag(tag);
  return t === "component" || t === "symbol";
}

function isComponentSetTag(tag: string): boolean {
  const t = normTag(tag);
  return t === "componentset" || t === "symbolset";
}

function collect(nodes: RawNode[], out: FigmaComponent[]): void {
  for (const node of nodes) {
    if (isComponentSetTag(node.tag)) {
      if (node.id.length > 0) {
        const variants = node.children
          .filter((child) => isComponentTag(child.tag) && child.id.length > 0)
          .map((child) => ({ nodeId: child.id, name: child.name }));
        out.push({
          nodeId: node.id,
          name: node.name,
          kind: "component-set",
          variants,
          ...(node.lastModified !== undefined ? { lastModified: node.lastModified } : {}),
        });
      }
      continue; // a set's children are its variants — never standalone components
    }
    if (isComponentTag(node.tag)) {
      if (node.id.length > 0) {
        out.push({
          nodeId: node.id,
          name: node.name,
          kind: "component",
          variants: [],
          ...(node.lastModified !== undefined ? { lastModified: node.lastModified } : {}),
        });
      }
      continue; // do not descend into a component looking for more components
    }
    collect(node.children, out);
  }
}

/**
 * Parse a `get_metadata` XML payload into the COMPONENT / COMPONENT_SET nodes it contains, in
 * document order. Returns `[]` for empty/garbage input (never throws) — so an enumerate step can
 * report "no components found" rather than crashing the sync workflow.
 */
export function parseFigmaMetadata(xml: string): FigmaComponent[] {
  if (typeof xml !== "string" || xml.length === 0) {
    return [];
  }
  const out: FigmaComponent[] = [];
  collect(buildForest(xml), out);
  return out;
}
