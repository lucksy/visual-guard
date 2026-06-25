import { describe, it, expect } from "vitest";
import { parseFigmaMeta, upsertFigmaMetaImage } from "../scripts/lib/studio/figma-meta";

const valid = {
  version: 1,
  files: [
    {
      fileKey: "AbC123",
      label: "Core",
      components: [
        {
          nodeId: "1:23",
          name: "Button",
          description: "Primary action",
          images: [
            { path: ".visual-baselines/.figma/AbC123/1-23/default@0.png" },
            { path: ".visual-baselines/.figma/AbC123/1-23/hover@0.png", variant: "hover", viewport: 0 },
          ],
        },
      ],
    },
  ],
};

describe("parseFigmaMeta", () => {
  it("validates and normalizes a well-formed meta", () => {
    const meta = parseFigmaMeta(valid);
    expect(meta.version).toBe(1);
    expect(meta.files[0]?.components[0]?.images).toHaveLength(2);
    expect(meta.files[0]?.components[0]?.images[1]).toEqual({
      path: ".visual-baselines/.figma/AbC123/1-23/hover@0.png",
      variant: "hover",
      viewport: 0,
    });
  });

  it("defaults version to 1 when omitted and accepts an empty files array", () => {
    expect(parseFigmaMeta({ files: [] })).toEqual({ version: 1, files: [] });
  });

  it("rejects a non-object root", () => {
    expect(() => parseFigmaMeta(null)).toThrow(/figma_meta/);
    expect(() => parseFigmaMeta("nope")).toThrow(/object/);
  });

  it("rejects a missing files array", () => {
    expect(() => parseFigmaMeta({ version: 1 })).toThrow(/files/);
  });

  it("names the field for a component missing its nodeId/name", () => {
    expect(() =>
      parseFigmaMeta({ files: [{ fileKey: "K", components: [{ name: "X", images: [{ path: "p" }] }] }] }),
    ).toThrow(/files\[0\]\.components\[0\]\.nodeId/);
  });

  it("rejects a component with an empty images array", () => {
    expect(() =>
      parseFigmaMeta({ files: [{ fileKey: "K", components: [{ nodeId: "1:2", name: "X", images: [] }] }] }),
    ).toThrow(/images/);
  });

  it("names the field for an image missing its path", () => {
    expect(() =>
      parseFigmaMeta({
        files: [{ fileKey: "K", components: [{ nodeId: "1:2", name: "X", images: [{ variant: "v" }] }] }],
      }),
    ).toThrow(/images\[0\]\.path/);
  });

  it("preserves an image's figmaVersionId provenance", () => {
    const meta = parseFigmaMeta({
      files: [
        {
          fileKey: "K",
          components: [
            { nodeId: "1:2", name: "X", images: [{ path: "p", figmaVersionId: "v28" }] },
          ],
        },
      ],
    });
    expect(meta.files[0]?.components[0]?.images[0]?.figmaVersionId).toBe("v28");
  });

  it("rejects a non-object file entry and a non-array components field", () => {
    expect(() => parseFigmaMeta({ files: [42] })).toThrow(/files\[0\]/);
    expect(() => parseFigmaMeta({ files: [{ fileKey: "K", components: "nope" }] })).toThrow(
      /components/,
    );
  });

  it("rejects a negative viewport", () => {
    expect(() =>
      parseFigmaMeta({
        files: [
          { fileKey: "K", components: [{ nodeId: "1:2", name: "X", images: [{ path: "p", viewport: -1 }] }] },
        ],
      }),
    ).toThrow(/viewport/);
  });
});

describe("upsertFigmaMetaImage", () => {
  const empty = { version: 1, files: [] };
  const entry = (path: string) => ({
    fileKey: "K",
    label: "Core",
    nodeId: "1:2",
    name: "Button",
    image: { path },
  });

  it("creates file → component → image in an empty meta", () => {
    const meta = upsertFigmaMetaImage(empty, entry("a.png"));
    expect(meta).toEqual({
      version: 1,
      files: [
        {
          fileKey: "K",
          label: "Core",
          components: [{ nodeId: "1:2", name: "Button", images: [{ path: "a.png" }] }],
        },
      ],
    });
  });

  it("appends a new image to an existing component, replaces a same-path image in place (idempotent)", () => {
    let meta = upsertFigmaMetaImage(empty, entry("a.png"));
    meta = upsertFigmaMetaImage(meta, entry("b.png"));
    expect(meta.files[0]?.components[0]?.images.map((i) => i.path)).toEqual(["a.png", "b.png"]);
    // re-record the same path → updated in place, no duplicate
    meta = upsertFigmaMetaImage(meta, { ...entry("a.png"), image: { path: "a.png", viewport: 2 } });
    expect(meta.files[0]?.components[0]?.images).toEqual([
      { path: "a.png", viewport: 2 },
      { path: "b.png" },
    ]);
  });

  it("adds a second component under the same file without disturbing the first", () => {
    let meta = upsertFigmaMetaImage(empty, entry("a.png"));
    meta = upsertFigmaMetaImage(meta, {
      fileKey: "K",
      nodeId: "9:9",
      name: "Card",
      image: { path: "c.png" },
    });
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0]?.components.map((c) => c.nodeId)).toEqual(["1:2", "9:9"]);
  });

  it("does not mutate the input meta", () => {
    const before = JSON.stringify(empty);
    upsertFigmaMetaImage(empty, entry("a.png"));
    expect(JSON.stringify(empty)).toBe(before);
  });
});

describe("v5 durable drift fields (codeKey / lastModified / axes)", () => {
  it("parses and round-trips the optional component + image drift fields", () => {
    const meta = parseFigmaMeta({
      files: [
        {
          fileKey: "K",
          components: [
            {
              nodeId: "1:2",
              name: "Button",
              codeKey: "buttons/button",
              lastModified: "2026-06-01T00:00:00.000Z",
              axes: { State: ["Default", "Hover"], Size: ["Sm", "Lg"] },
              images: [
                {
                  path: "a.png",
                  variant: "State=Hover",
                  axes: { State: "Hover" },
                  figmaLastModified: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });
    const comp = meta.files[0]?.components[0];
    expect(comp?.codeKey).toBe("buttons/button");
    expect(comp?.lastModified).toBe("2026-06-01T00:00:00.000Z");
    expect(comp?.axes).toEqual({ State: ["Default", "Hover"], Size: ["Sm", "Lg"] });
    expect(comp?.images[0]?.axes).toEqual({ State: "Hover" });
    expect(comp?.images[0]?.figmaLastModified).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rejects malformed drift fields with field-named errors", () => {
    const base = (over: Record<string, unknown>) => ({
      files: [{ fileKey: "K", components: [{ nodeId: "1:2", name: "X", images: [{ path: "p" }], ...over }] }],
    });
    expect(() => parseFigmaMeta(base({ codeKey: 7 }))).toThrow(/codeKey/);
    expect(() => parseFigmaMeta(base({ axes: { State: "Hover" } }))).toThrow(/axes\.State/);
    expect(() => parseFigmaMeta(base({ axes: { State: [1] } }))).toThrow(/axes\.State\[0\]/);
    expect(() =>
      parseFigmaMeta({
        files: [
          {
            fileKey: "K",
            components: [{ nodeId: "1:2", name: "X", images: [{ path: "p", axes: { S: 1 } }] }],
          },
        ],
      }),
    ).toThrow(/axes\.S/);
  });

  it("keeps pre-v5 metas byte-identical (all new fields absent → unchanged)", () => {
    const v4 = { version: 1, files: [{ fileKey: "K", components: [{ nodeId: "1:2", name: "X", images: [{ path: "p" }] }] }] };
    expect(parseFigmaMeta(v4)).toEqual(v4);
  });

  it("upsert sets codeKey/lastModified/axes when provided and preserves them across a sibling upsert", () => {
    const empty = { version: 1, files: [] };
    let meta = upsertFigmaMetaImage(empty, {
      fileKey: "K",
      nodeId: "1:2",
      name: "Button",
      codeKey: "buttons/button",
      lastModified: "2026-06-01T00:00:00.000Z",
      axes: { State: ["Default", "Hover"] },
      image: { path: "a.png", axes: { State: "Hover" } },
    });
    expect(meta.files[0]?.components[0]?.codeKey).toBe("buttons/button");

    // a later image-only upsert (no codeKey) must PRESERVE the component-level codeKey/axes
    meta = upsertFigmaMetaImage(meta, {
      fileKey: "K",
      nodeId: "1:2",
      name: "Button",
      image: { path: "b.png" },
    });
    const comp = meta.files[0]?.components[0];
    expect(comp?.codeKey).toBe("buttons/button"); // preserved
    expect(comp?.axes).toEqual({ State: ["Default", "Hover"] }); // preserved
    expect(comp?.images.map((i) => i.path)).toEqual(["a.png", "b.png"]);

    // a code rename re-points codeKey in place (last-write-wins) — a diffable signal
    meta = upsertFigmaMetaImage(meta, {
      fileKey: "K",
      nodeId: "1:2",
      name: "Button",
      codeKey: "buttons/cta",
      image: { path: "a.png", axes: { State: "Hover" } },
    });
    expect(meta.files[0]?.components[0]?.codeKey).toBe("buttons/cta");
  });

  it("codeKey: null CLEARS a stale mapping (a node that un-matched), while undefined preserves it", () => {
    const empty = { version: 1, files: [] };
    let meta = upsertFigmaMetaImage(empty, {
      fileKey: "K",
      nodeId: "1:2",
      name: "Button",
      codeKey: "inst/Button",
      image: { path: "a.png" },
    });
    expect(meta.files[0]?.components[0]?.codeKey).toBe("inst/Button");
    // un-match → null clears it (so reindex can't wrongly re-link the old code component)
    meta = upsertFigmaMetaImage(meta, { fileKey: "K", nodeId: "1:2", name: "Button", codeKey: null, image: { path: "a.png" } });
    expect(meta.files[0]?.components[0]?.codeKey).toBeUndefined();
    // re-match → set; then an image-only (undefined) upsert preserves it
    meta = upsertFigmaMetaImage(meta, { fileKey: "K", nodeId: "1:2", name: "Button", codeKey: "inst/Btn2", image: { path: "b.png" } });
    meta = upsertFigmaMetaImage(meta, { fileKey: "K", nodeId: "1:2", name: "Button", image: { path: "a.png" } });
    expect(meta.files[0]?.components[0]?.codeKey).toBe("inst/Btn2");
  });
});
