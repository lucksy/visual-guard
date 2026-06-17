import { describe, it, expect } from "vitest";
import { parseFigmaMetadata } from "../scripts/lib/studio/figma-nodes";

// A trimmed but faithful slice of a real `get_metadata` dump: a <canvas> page with a <symbol>
// (= COMPONENT), an <instance>, and ordinary layers. Confirms the real-world tag naming.
const REAL = `<canvas id="0:1" name="Page 1" x="0" y="0" width="0" height="0">
  <text id="1:8" name="Start here ↓" x="0" y="0" width="1" height="1" />
  <frame id="1:2" name="01" x="0" y="0" width="10" height="10">
    <rounded-rectangle id="1:4" name="Background" x="0" y="0" width="10" height="10" />
  </frame>
  <symbol id="411:2" name="Cursor/Default" x="0" y="0" width="32" height="32" />
  <instance id="411:3" name="Cursor/Default" x="0" y="0" width="32" height="32" />
</canvas>`;

// A component SET with two variant children, plus a standalone component.
const SET = `<frame id="0:1" name="Page">
  <component-set id="1:10" name="Button" x="0" y="0" width="80" height="32">
    <component id="1:11" name="State=Default" x="0" y="0" width="80" height="32" />
    <component id="1:12" name="State=Hover" x="0" y="0" width="80" height="32" />
  </component-set>
  <component id="1:20" name="Card" x="0" y="0" width="200" height="120" />
</frame>`;

describe("parseFigmaMetadata", () => {
  it("picks the COMPONENT (<symbol>) out of a real page and ignores instances/layers", () => {
    expect(parseFigmaMetadata(REAL)).toEqual([
      { nodeId: "411:2", name: "Cursor/Default", kind: "component", variants: [] },
    ]);
  });

  it("treats a COMPONENT_SET as one component whose child COMPONENTs are its variants", () => {
    expect(parseFigmaMetadata(SET)).toEqual([
      {
        nodeId: "1:10",
        name: "Button",
        kind: "component-set",
        variants: [
          { nodeId: "1:11", name: "State=Default" },
          { nodeId: "1:12", name: "State=Hover" },
        ],
      },
      { nodeId: "1:20", name: "Card", kind: "component", variants: [] },
    ]);
  });

  it("accepts the <symbol-set> spelling as a component set (MCP naming synonym)", () => {
    const xml = `<symbol-set id="2:1" name="Chip"><symbol id="2:2" name="tone=info" /></symbol-set>`;
    expect(parseFigmaMetadata(xml)).toEqual([
      { nodeId: "2:1", name: "Chip", kind: "component-set", variants: [{ nodeId: "2:2", name: "tone=info" }] },
    ]);
  });

  it("decodes XML entities in names", () => {
    const xml = `<symbol id="3:1" name="A &amp; B &#39;x&#39; &lt;y&gt;" />`;
    expect(parseFigmaMetadata(xml)[0]?.name).toBe("A & B 'x' <y>");
  });

  it("returns [] for empty or component-free input (never throws)", () => {
    expect(parseFigmaMetadata("")).toEqual([]);
    expect(parseFigmaMetadata("<frame id='1:1' name='X' />")).toEqual([]);
    expect(parseFigmaMetadata("not xml at all")).toEqual([]);
    expect(parseFigmaMetadata(undefined as unknown as string)).toEqual([]);
  });

  it("skips a component node that has no id", () => {
    expect(parseFigmaMetadata(`<symbol name="No id" />`)).toEqual([]);
  });

  it("still parses a tag carrying a single-quoted or valueless attribute (permissive)", () => {
    // a component-set with a valueless attr + single-quoted name, and a child with a valueless attr —
    // a strict double-quoted-only parser would drop the set and mis-promote its child to standalone.
    const xml = `<symbol-set id="1:1" name='Chip' data-locked><symbol id="1:2" name="tone=info" hidden /></symbol-set>`;
    expect(parseFigmaMetadata(xml)).toEqual([
      {
        nodeId: "1:1",
        name: "Chip",
        kind: "component-set",
        variants: [{ nodeId: "1:2", name: "tone=info" }],
      },
    ]);
  });
});
