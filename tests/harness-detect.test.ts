import { describe, it, expect } from "vitest";
import { detectFramework, pickHarnessFor } from "../scripts/lib/harness/detect";

describe("detectFramework", () => {
  it("detects react from react or react-dom", () => {
    expect(detectFramework(["react", "react-dom"])).toBe("react");
    expect(detectFramework(["react-dom"])).toBe("react");
  });

  it("detects vue and svelte", () => {
    expect(detectFramework(["vue"])).toBe("vue");
    expect(detectFramework(["svelte"])).toBe("svelte");
  });

  it("classifies meta-frameworks by their underlying renderer", () => {
    expect(detectFramework(["next", "react", "react-dom"])).toBe("react");
    expect(detectFramework(["nuxt", "vue"])).toBe("vue");
  });

  it("uses react → vue → svelte precedence when several are present", () => {
    expect(detectFramework(["svelte", "vue", "react"])).toBe("react");
    expect(detectFramework(["svelte", "vue"])).toBe("vue");
  });

  it("returns unknown when no known framework is declared", () => {
    expect(detectFramework([])).toBe("unknown");
    expect(detectFramework(["@angular/core", "rxjs"])).toBe("unknown");
  });
});

describe("pickHarnessFor", () => {
  it("maps each framework to its scaffoldable harness", () => {
    expect(pickHarnessFor("react")).toBe("ladle");
    expect(pickHarnessFor("vue")).toBe("histoire");
    expect(pickHarnessFor("svelte")).toBe("histoire");
    expect(pickHarnessFor("unknown")).toBe("storybook");
  });
});
