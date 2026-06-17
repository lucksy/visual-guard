import { describe, it, expect } from "vitest";
import { extractFigmaFileKey, looksLikeFigmaKey, parseNodeId } from "../scripts/lib/figma/url";

const KEY = "AbCdEf1234567890"; // 16-char base62 — a representative Figma file key

describe("looksLikeFigmaKey", () => {
  it("accepts a base62 key of 16–128 chars", () => {
    expect(looksLikeFigmaKey(KEY)).toBe(true);
    expect(looksLikeFigmaKey("a".repeat(22))).toBe(true);
    expect(looksLikeFigmaKey("a".repeat(128))).toBe(true);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(looksLikeFigmaKey(`  ${KEY}  `)).toBe(true);
  });

  it("rejects short words, over-long strings, and non-base62 input", () => {
    expect(looksLikeFigmaKey("Button")).toBe(false); // too short
    expect(looksLikeFigmaKey("a".repeat(129))).toBe(false); // too long
    expect(looksLikeFigmaKey("has space here")).toBe(false);
    expect(looksLikeFigmaKey("has-dash-and_underscore")).toBe(false);
    expect(looksLikeFigmaKey("")).toBe(false);
    expect(looksLikeFigmaKey("https://figma.com/design/" + KEY)).toBe(false); // a URL is not a key
  });
});

describe("extractFigmaFileKey", () => {
  it("extracts the key from a figma.com /design URL with name + node-id", () => {
    expect(extractFigmaFileKey(`https://www.figma.com/design/${KEY}/Acme?node-id=12-34`)).toBe(KEY);
  });

  it("extracts from each supported product path word", () => {
    for (const word of ["file", "design", "board", "proto", "slides"]) {
      expect(extractFigmaFileKey(`https://figma.com/${word}/${KEY}/Whatever`)).toBe(KEY);
    }
  });

  it("extracts from a figma.site (Figma Sites) URL", () => {
    expect(extractFigmaFileKey(`https://figma.site/design/${KEY}/Landing`)).toBe(KEY);
  });

  it("is case-insensitive on the host/path words but preserves the key's case", () => {
    expect(extractFigmaFileKey(`HTTPS://WWW.FIGMA.COM/DESIGN/${KEY}/X`)).toBe(KEY);
  });

  it("stops at the first non-key character (trailing slash / query)", () => {
    expect(extractFigmaFileKey(`https://figma.com/file/${KEY}/`)).toBe(KEY);
    expect(extractFigmaFileKey(`https://figma.com/file/${KEY}?t=abc`)).toBe(KEY);
  });

  it("returns a bare key unchanged", () => {
    expect(extractFigmaFileKey(`  ${KEY}  `)).toBe(KEY);
  });

  it("returns null for a non-Figma URL, a Figma host with no key, and a short word", () => {
    expect(extractFigmaFileKey("https://example.com/design/foo")).toBeNull();
    expect(extractFigmaFileKey("https://www.figma.com/")).toBeNull();
    expect(extractFigmaFileKey("https://www.figma.com/files/recents")).toBeNull();
    expect(extractFigmaFileKey("Button")).toBeNull();
    expect(extractFigmaFileKey("   ")).toBeNull();
  });

  it("returns null for a too-short or over-long URL key segment (shape-validated)", () => {
    expect(extractFigmaFileKey("https://www.figma.com/design/short/x")).toBeNull();
    expect(extractFigmaFileKey(`https://figma.com/file/${"a".repeat(200)}/x`)).toBeNull();
  });

  it("returns null for a Figma community URL (community/file is out of scope)", () => {
    expect(extractFigmaFileKey(`https://www.figma.com/community/file/${KEY}/Material`)).toBeNull();
  });

  it("does not mine a figma.com substring embedded in another host or query (host-anchored)", () => {
    expect(extractFigmaFileKey(`https://evil.com/redirect?to=figma.com/design/${KEY}/x`)).toBeNull();
    expect(extractFigmaFileKey(`https://mycdn.net/assets/figma.com/design/${KEY}.png`)).toBeNull();
  });

  it("still extracts from a scheme-less paste (figma.com / www.figma.com at the start)", () => {
    expect(extractFigmaFileKey(`figma.com/design/${KEY}/Acme`)).toBe(KEY);
    expect(extractFigmaFileKey(`www.figma.com/design/${KEY}/Acme`)).toBe(KEY);
  });
});

describe("parseNodeId", () => {
  it("normalizes the URL dash form to the API colon form", () => {
    expect(parseNodeId("123-456")).toBe("123:456");
  });

  it("passes an already-API-form id through unchanged", () => {
    expect(parseNodeId("123:456")).toBe("123:456");
  });

  it("pulls node-id out of a full Figma URL (dash form)", () => {
    expect(parseNodeId(`https://www.figma.com/design/${KEY}/Acme?node-id=12-34&t=xyz`)).toBe(
      "12:34",
    );
  });

  it("url-decodes a percent-encoded colon in a node-id query", () => {
    expect(parseNodeId(`https://figma.com/design/${KEY}/Acme?node-id=12%3A34`)).toBe("12:34");
  });

  it("returns null for a Figma URL with no node-id", () => {
    expect(parseNodeId(`https://www.figma.com/design/${KEY}/Acme`)).toBeNull();
  });

  it("returns null for malformed percent-encoding in node-id", () => {
    expect(parseNodeId(`https://figma.com/design/${KEY}?node-id=%E0%A4%A`)).toBeNull();
  });

  it("returns null for empty input and non-numeric / composite ids", () => {
    expect(parseNodeId("")).toBeNull();
    expect(parseNodeId("   ")).toBeNull();
    expect(parseNodeId("abc-def")).toBeNull();
    expect(parseNodeId("1-2-3")).toBeNull();
    expect(parseNodeId("I1:2;3:4")).toBeNull(); // composite instance id — out of scope for P0
  });
});
