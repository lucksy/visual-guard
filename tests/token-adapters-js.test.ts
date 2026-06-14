import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evalThemeFile,
  flattenThemeTokens,
  parseJsThemeFile,
  parseTailwindConfigFile,
} from "../scripts/lib/token-adapters/js-eval";
import { parseConfig } from "../scripts/lib/config";
import { auditTokens } from "../scripts/lib/tokens";
import type { Token, TokenType } from "../scripts/lib/tokens-model";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tokens");
const themeFile = join(fixtures, "theme.ts");
const tailwindFile = join(fixtures, "tailwind.config.cjs");
const ctx = { source: "test" };
const allow = { allowJsEval: true };
const EVAL_TIMEOUT = 20_000;

const by = (tokens: Token[], name: string): Token => {
  const found = tokens.find((t) => t.name === name);
  if (!found) {
    throw new Error(`token "${name}" not found in [${tokens.map((t) => t.name).join(", ")}]`);
  }
  return found;
};

describe("flattenThemeTokens (pure)", () => {
  it("flattens nested objects, scale arrays, DEFAULT, and font stacks", () => {
    const theme = {
      colors: { brand: "#3b82f6", text: { DEFAULT: "#111111", muted: "#666666" } },
      space: [0, "4px", "8px"],
      fontFamily: { sans: ["Inter", "sans-serif"] },
      fontSize: { body: ["16px", { lineHeight: "24px" }] },
    };
    const map: Record<string, TokenType> = {
      colors: "color",
      space: "dimension",
      fontFamily: "fontFamily",
      fontSize: "fontSize",
    };
    const tokens = flattenThemeTokens(theme, map, ctx);
    expect(by(tokens, "colors.brand")).toMatchObject({ value: "#3b82f6", type: "color" });
    expect(by(tokens, "colors.text").value).toBe("#111111"); // DEFAULT collapses to parent
    expect(by(tokens, "colors.text.muted").value).toBe("#666666");
    expect(by(tokens, "space.1").value).toBe("4px");
    expect(by(tokens, "fontFamily.sans").value).toBe("Inter, sans-serif");
    expect(by(tokens, "fontSize.body").value).toBe("16px"); // [size, config] → size
  });

  it("returns [] for a non-object theme", () => {
    expect(flattenThemeTokens(null, {}, ctx)).toEqual([]);
  });
});

describe("evalThemeFile — sandbox guard", () => {
  it("refuses to evaluate without allowJsEval", () => {
    expect(() => evalThemeFile(themeFile, "js-theme", { allowJsEval: false })).toThrow(
      /allowJsEval/,
    );
  });
});

describe("parseJsThemeFile — child-process eval of a TS theme", () => {
  it(
    "evaluates the module into typed tokens",
    () => {
      const tokens = parseJsThemeFile(themeFile, ctx, allow);
      expect(by(tokens, "colors.brand")).toMatchObject({ value: "#3b82f6", type: "color" });
      expect(by(tokens, "colors.text.primary")).toMatchObject({ value: "#111827", type: "color" });
      expect(by(tokens, "space.2")).toMatchObject({ value: "8px", type: "dimension" });
      expect(by(tokens, "radii.md")).toMatchObject({ value: "6px", type: "radius" });
      expect(by(tokens, "fontWeights.bold")).toMatchObject({ value: "700", type: "fontWeight" });
    },
    EVAL_TIMEOUT,
  );
});

describe("parseTailwindConfigFile — child-process eval of a tailwind.config.js", () => {
  it(
    "merges theme + extend into typed tokens",
    () => {
      const tokens = parseTailwindConfigFile(tailwindFile, ctx, allow);
      expect(by(tokens, "colors.primary")).toMatchObject({ value: "#3b82f6", type: "color" });
      expect(by(tokens, "colors.gray.100")).toMatchObject({ value: "#f3f4f6", type: "color" });
      expect(by(tokens, "spacing.sm")).toMatchObject({ value: "8px", type: "dimension" });
      expect(by(tokens, "borderRadius.card")).toMatchObject({ value: "12px", type: "radius" });
      expect(by(tokens, "fontSize.body")).toMatchObject({ value: "16px", type: "fontSize" });
      expect(by(tokens, "fontFamily.sans").value).toBe("Inter, sans-serif");
    },
    EVAL_TIMEOUT,
  );
});

describe("auditTokens — drift against a JS-eval token source", () => {
  it(
    "flags hardcoded values that inline tokens from a tailwind config",
    () => {
      const cfg = parseConfig({
        targets: [{ type: "storybook", url: "http://localhost:6006" }],
        tokens: {
          allowJsEval: true,
          sources: [{ source: tailwindFile, format: "tailwind-config" }],
        },
      });
      const io = {
        readFile: (path: string): string => {
          if (path === "Card.tsx") {
            return `export const C = () => <div className="bg-[#3b82f6] p-[8px]" />;`;
          }
          throw new Error(`missing ${path}`);
        },
      };
      const findings = auditTokens(cfg, ["Card.tsx"], io);
      expect(findings.find((f) => f.suggestedToken === "colors.primary")).toBeTruthy();
      expect(findings.find((f) => f.suggestedToken === "spacing.sm")).toBeTruthy();
    },
    EVAL_TIMEOUT,
  );
});
