/** Ambient type for `postcss-less` — it ships no resolvable declarations. It exposes a PostCSS
 *  `Syntax` (we use only `.parse`); Less variables surface as `AtRule`s with `variable === true`. */
declare module "postcss-less" {
  import type { Root } from "postcss";
  const syntax: { parse(css: string): Root };
  export default syntax;
}
