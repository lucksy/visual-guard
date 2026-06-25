import { describe, it, expect } from "vitest";
import { diffCodeMapping, type CodeKeyRef } from "../scripts/lib/studio/rename";

const ref = (instance: string, name: string): CodeKeyRef => ({
  key: `${instance}/${name}`,
  instance,
  name,
});

describe("diffCodeMapping — instance-anchored code rename detection", () => {
  it("pairs an unambiguous same-instance 1↔1 change as an applied rename (confidence 1.0)", () => {
    const prior = [ref("inst", "Button"), ref("inst", "Card")];
    const fresh = [ref("inst", "PrimaryButton"), ref("inst", "Card")];
    const diff = diffCodeMapping(prior, fresh);
    expect(diff.renames).toEqual([
      {
        fromKey: "inst/Button",
        toKey: "inst/PrimaryButton",
        fromName: "Button",
        toName: "PrimaryButton",
        instance: "inst",
        confidence: 1,
        anchor: "code-instance",
      },
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.fuzzyCandidates).toEqual([]);
  });

  it("treats a genuine add and a genuine remove as add/remove, not a rename", () => {
    const prior = [ref("inst", "Button")];
    const fresh = [ref("inst", "Button"), ref("inst", "Card")]; // Card added, nothing removed
    expect(diffCodeMapping(prior, fresh)).toMatchObject({
      renames: [],
      fuzzyCandidates: [],
      added: ["inst/Card"],
      removed: [],
    });
  });

  it("refuses to guess when an instance has 2 lost + 2 gained (ambiguous) → all add/remove", () => {
    const prior = [ref("inst", "Button"), ref("inst", "Card")];
    const fresh = [ref("inst", "Btn"), ref("inst", "Crd")];
    const diff = diffCodeMapping(prior, fresh);
    expect(diff.renames).toEqual([]); // no unique anchor → no silent pairing
    expect(diff.added.sort()).toEqual(["inst/Btn", "inst/Crd"]);
    expect(diff.removed.sort()).toEqual(["inst/Button", "inst/Card"]);
  });

  it("surfaces a cross-instance same-name move as an ADVISORY fuzzy candidate (confidence 0.5)", () => {
    const prior = [ref("storybook", "Button")];
    const fresh = [ref("ladle", "Button")]; // same normalized name, different instance = a move
    const diff = diffCodeMapping(prior, fresh);
    expect(diff.renames).toEqual([]); // never auto-applied
    expect(diff.fuzzyCandidates).toEqual([
      {
        fromKey: "storybook/Button",
        toKey: "ladle/Button",
        fromName: "Button",
        toName: "Button",
        instance: "ladle",
        confidence: 0.5,
        anchor: "fuzzy",
      },
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("is a no-op when the populations are identical", () => {
    const same = [ref("inst", "Button"), ref("inst", "Card")];
    expect(diffCodeMapping(same, same)).toEqual({
      renames: [],
      fuzzyCandidates: [],
      added: [],
      removed: [],
    });
  });

  it("normalizes names when pairing a rename (Primary Button ≡ primary-button is NOT the anchor; key is)", () => {
    // The anchor is the instance + 1↔1 uniqueness, so a styled rename within one instance still pairs.
    const prior = [ref("inst", "primary-button")];
    const fresh = [ref("inst", "Primary Button")];
    const diff = diffCodeMapping(prior, fresh);
    expect(diff.renames).toHaveLength(1);
    expect(diff.renames[0]?.fromKey).toBe("inst/primary-button");
    expect(diff.renames[0]?.toKey).toBe("inst/Primary Button");
  });
});
