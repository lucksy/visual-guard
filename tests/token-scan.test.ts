import { describe, it, expect } from "vitest";
import { parseConfig, type Config } from "../scripts/lib/config";
import { auditTokens, loadTokens } from "../scripts/lib/tokens";
import { detectDrift, scanContent } from "../scripts/lib/token-scan";

const config = (tokens: unknown): Config =>
  parseConfig({ targets: [{ type: "storybook", url: "http://localhost:6006" }], tokens });

const ioOf = (files: Record<string, string>) => ({
  readFile: (path: string): string => {
    const contents = files[path];
    if (contents === undefined) {
      throw new Error(`missing ${path}`);
    }
    return contents;
  },
});

describe("scanContent — literal extraction", () => {
  it("extracts CSS value-position literals and skips var() references", () => {
    const lits = scanContent("a.css", ".b{ padding: 8px; color: #fff; margin: var(--space-md); }");
    expect(lits.map((l) => l.value)).toEqual(["8px", "#fff"]);
    expect(lits[0]).toMatchObject({ property: "padding", typeHint: "dimension" });
    expect(lits[1]).toMatchObject({ property: "color", typeHint: "color" });
  });

  it("splits a shorthand into sub-literals with shape-inferred types", () => {
    const lits = scanContent("a.css", ".b{ border: 1px solid #ccc; }");
    expect(lits.map((l) => l.value)).toEqual(["1px", "solid", "#ccc"]);
    expect(lits.every((l) => l.typeHint === undefined)).toBe(true); // shorthand → auto
  });

  it("reads JSX style props (numeric length → px) and string colors", () => {
    const lits = scanContent(
      "C.tsx",
      `export const C = () => <div style={{ padding: 8, color: "#ffffff" }} />;`,
    );
    expect(lits.find((l) => l.property === "padding")).toMatchObject({
      value: "8px",
      source: "jsx-style",
    });
    expect(lits.find((l) => l.property === "color")).toMatchObject({ value: "#ffffff" });
  });

  it("reads Tailwind arbitrary-value utility classes", () => {
    const lits = scanContent(
      "C.tsx",
      `export const C = () => <div className="p-[8px] text-[#3b82f6] z-[1000]" />;`,
    );
    expect(lits.find((l) => l.property === "p")).toMatchObject({
      value: "8px",
      typeHint: "dimension",
    });
    expect(lits.find((l) => l.property === "text")).toMatchObject({
      value: "#3b82f6",
      typeHint: "color",
    });
    expect(lits.find((l) => l.property === "z")).toMatchObject({
      value: "1000",
      typeHint: "zIndex",
    });
  });

  it("ignores non-UI extensions", () => {
    expect(scanContent("readme.md", "padding: 8px")).toEqual([]);
  });
});

describe("typeHint mapping — CSS properties", () => {
  const hint = (prop: string, value: string): string | undefined =>
    scanContent("a.css", `.b{ ${prop}: ${value}; }`)[0]?.typeHint;
  it.each([
    ["border-radius", "4px", "radius"],
    ["font-weight", "700", "fontWeight"],
    ["line-height", "1.5", "lineHeight"],
    ["letter-spacing", "2px", "letterSpacing"],
    ["z-index", "10", "zIndex"],
    ["opacity", "0.5", "opacity"],
    ["font-family", "Inter", "fontFamily"],
    ["text-shadow", "red", "shadow"],
    ["transition-duration", "200ms", "duration"],
    ["min-width", "8px", "dimension"],
    ["max-height", "8px", "dimension"],
    ["background", "#fff", "color"],
    ["fill", "#000", "color"],
    ["width", "100px", "dimension"],
  ])("%s → %s", (prop, value, expected) => {
    expect(hint(prop, value)).toBe(expected);
  });
});

describe("typeHint mapping — Tailwind utilities", () => {
  const hint = (cls: string): string | undefined =>
    scanContent("C.tsx", `export const C = () => <div className="${cls}" />;`)[0]?.typeHint;
  it.each([
    ["rounded-[4px]", "radius"],
    ["leading-[1.5]", "lineHeight"],
    ["tracking-[2px]", "letterSpacing"],
    ["duration-[200ms]", "duration"],
    ["opacity-[0.5]", "opacity"],
    ["shadow-[0_1px_2px_#000]", "shadow"],
    ["font-[700]", "fontWeight"],
    ["border-[#ccc]", "color"],
    ["border-[1px]", "dimension"],
    ["m-[1rem]", "dimension"],
    ["w-[120px]", "dimension"],
    ["fill-[#f00]", "color"],
  ])("%s → %s", (cls, expected) => {
    expect(hint(cls)).toBe(expected);
  });
});

describe("auditTokens — the CP5 gap (inlined value vs token use)", () => {
  const files = {
    "tokens.css": ":root{ --space-md: 8px; --color-bg: #ffffff; }",
    "Button.css": ".btn{ padding: 8px; color: #fff; }",
    "Good.css": ".btn{ padding: var(--space-md); color: var(--color-bg); }",
  };
  const cfg = config({ sources: [{ source: "tokens.css", format: "auto" }] });

  it("flags a hardcoded value that inlines a token", () => {
    const findings = auditTokens(cfg, ["Button.css"], ioOf(files));
    const padding = findings.find((f) => f.cssProperty === "padding");
    expect(padding).toMatchObject({
      suggestedToken: "--space-md",
      literal: "8px",
      confidence: "high",
    });
    const color = findings.find((f) => f.cssProperty === "color");
    expect(color).toMatchObject({ suggestedToken: "--color-bg", canonicalValue: "#ffffff" });
  });

  it("does NOT flag a file that uses the token (var())", () => {
    expect(auditTokens(cfg, ["Good.css"], ioOf(files))).toEqual([]);
  });
});

describe("auditTokens — recolor below the pixel threshold (SPEC criterion)", () => {
  it("flags a hardcoded color even with no geometry change", () => {
    const files = {
      "t.css": ":root{ --color-brand: #3b82f6; }",
      "Card.tsx": `export const C = () => <div className="bg-[#3b82f6]" />;`,
    };
    const findings = auditTokens(
      config({ sources: [{ source: "t.css", format: "auto" }] }),
      ["Card.tsx"],
      ioOf(files),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ suggestedToken: "--color-brand", type: "color" });
  });
});

describe("detectDrift — ranking, ignoreValues, confidence", () => {
  it("prefers the context-appropriate token among value-equal candidates", () => {
    const set = loadTokens(
      config({ sources: [{ source: "t.css", format: "auto" }] }),
      ioOf({ "t.css": ":root{ --space-md: 8px; --font-size-xs: 8px; }" }),
    );
    const [finding] = detectDrift(set, scanContent("b.css", ".b{ padding: 8px; }"));
    expect(finding?.suggestedToken).toBe("--space-md");
    expect(finding?.alternatives).toContain("--font-size-xs");
  });

  it("honors ignoreValues (raw and canonical)", () => {
    const cfg = config({ sources: [{ source: "t.css", format: "auto" }], ignoreValues: ["0"] });
    const files = { "t.css": ":root{ --space-0: 0px; }", "b.css": ".b{ margin: 0; }" };
    expect(auditTokens(cfg, ["b.css"], ioOf(files))).toEqual([]);
  });

  it("downgrades confidence for an em literal (element-relative)", () => {
    const set = loadTokens(
      config({ sources: [{ source: "t.css", format: "auto" }] }),
      ioOf({ "t.css": ":root{ --space-md: 16px; }" }),
    );
    const [finding] = detectDrift(set, scanContent("b.css", ".b{ padding: 1em; }"));
    expect(finding?.suggestedToken).toBe("--space-md");
    expect(finding?.confidence).toBe("medium");
  });

  it("returns nothing when there are no tokens", () => {
    const set = loadTokens(
      config({ sources: [{ source: "missing.css", format: "auto" }] }),
      ioOf({}),
    );
    expect(detectDrift(set, scanContent("b.css", ".b{ padding: 8px; }"))).toEqual([]);
  });
});

describe("loadTokens — multi-source merge (static)", () => {
  it("merges tokens from multiple static sources", () => {
    const cfg = config({
      sources: [
        { source: "a.css", format: "auto" },
        { source: "b.scss", format: "auto" },
      ],
    });
    const set = loadTokens(cfg, ioOf({ "a.css": ":root{ --x: 8px; }", "b.scss": "$y: #fff;" }));
    expect(set.byName.has("--x")).toBe(true);
    expect(set.byName.has("$y")).toBe(true);
    expect(set.tokens).toHaveLength(2);
  });
});
