/* eslint-env browser */
// @ts-check
/**
 * Tiny DOM helper for the Component Studio SPA (P4). Render code uses `el()` to build nodes with
 * `textContent`/`createTextNode` for all dynamic data — NEVER `innerHTML` — so component names,
 * descriptions, and other DB-sourced strings (which originate from Figma/code and are untrusted) can
 * never inject markup. There is no template-string HTML anywhere in the SPA.
 */

/**
 * Create an element. `props`: `class`, `dataset` (object), `on*` (event handlers), `style` (object), any
 * other key → attribute (skipped when null/undefined/false). Children are appended as text (strings) or
 * nodes; nullish/false children are skipped. Arrays are flattened.
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "class") {
        node.className = String(v);
      } else if (k === "dataset") {
        Object.assign(node.dataset, v);
      } else if (k === "style" && typeof v === "object") {
        // setProperty (not Object.assign) so CSS custom properties (--foo) actually apply.
        for (const [prop, val] of Object.entries(v)) {
          node.style.setProperty(prop, String(val));
        }
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(node, children);
  return node;
}

/** Append children (text/nodes/arrays), skipping nullish/false. Dynamic strings become text nodes. */
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace all children of `node` with `content` (text/node/array). */
export function setChildren(node, content) {
  node.replaceChildren();
  append(node, [content]);
}

/** Announce a message in the polite live region (a11y). */
export function announce(message) {
  const live = document.getElementById("live");
  if (live) {
    live.textContent = message;
  }
}
