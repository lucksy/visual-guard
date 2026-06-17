/**
 * `figma_meta.json` model + parser (Component Studio P1). This committed, diffable JSON is the
 * **source of truth** for the Figma side of a library — it indexes every committed Figma baseline
 * image with its node id, variant, viewport, and repo-relative path. `reindex` reads it (not the
 * raw `.figma/` tree) to rebuild the Figma components/variants/snapshots, so there is no lossy
 * path-reverse-engineering. Pure validation, mirroring `config.ts`'s field-named errors.
 *
 * No secret is ever stored here — only non-secret node ids, names, variant defs, and paths.
 */

export interface FigmaMetaImage {
  /** Repo-relative path of the committed PNG (must resolve under `<baselineDir>/.figma/`). */
  path: string;
  /** Variant name; omitted/empty = the component's default render (snapshot `variant_id` NULL). */
  variant?: string;
  /** Render viewport/scale tag (Figma renders at intrinsic size; defaults to 0 downstream). */
  viewport?: number;
  /** The Figma version this image was captured at (provenance for the timeline). */
  figmaVersionId?: string;
}

export interface FigmaMetaComponent {
  /** Figma node id (API form, e.g. `1:23`). */
  nodeId: string;
  name: string;
  description?: string;
  images: FigmaMetaImage[];
}

export interface FigmaMetaFile {
  /** Non-secret Figma file key (matches a `config.figma.files[].key`). */
  fileKey: string;
  label?: string;
  components: FigmaMetaComponent[];
}

export interface FigmaMeta {
  version: number;
  files: FigmaMetaFile[];
}

const PREFIX = "Visual Guard figma_meta";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`"${field}" must be a non-empty string.`);
  }
  return value;
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`"${field}" must be a non-negative integer.`);
  }
  return value;
}

function parseImage(raw: unknown, label: string): FigmaMetaImage {
  if (!isObject(raw)) {
    fail(`${label} must be an object with a "path".`);
  }
  const image: FigmaMetaImage = { path: asNonEmptyString(raw.path, `${label}.path`) };
  if (raw.variant !== undefined) {
    image.variant = asNonEmptyString(raw.variant, `${label}.variant`);
  }
  if (raw.viewport !== undefined) {
    image.viewport = asNonNegativeInt(raw.viewport, `${label}.viewport`);
  }
  if (raw.figmaVersionId !== undefined) {
    image.figmaVersionId = asNonEmptyString(raw.figmaVersionId, `${label}.figmaVersionId`);
  }
  return image;
}

function parseComponent(raw: unknown, label: string): FigmaMetaComponent {
  if (!isObject(raw)) {
    fail(`${label} must be an object.`);
  }
  if (!Array.isArray(raw.images) || raw.images.length === 0) {
    fail(`"${label}.images" must be a non-empty array.`);
  }
  const component: FigmaMetaComponent = {
    nodeId: asNonEmptyString(raw.nodeId, `${label}.nodeId`),
    name: asNonEmptyString(raw.name, `${label}.name`),
    images: raw.images.map((image, index) => parseImage(image, `${label}.images[${index}]`)),
  };
  if (raw.description !== undefined) {
    component.description = asNonEmptyString(raw.description, `${label}.description`);
  }
  return component;
}

function parseFile(raw: unknown, label: string): FigmaMetaFile {
  if (!isObject(raw)) {
    fail(`${label} must be an object.`);
  }
  if (!Array.isArray(raw.components)) {
    fail(`"${label}.components" must be an array.`);
  }
  const file: FigmaMetaFile = {
    fileKey: asNonEmptyString(raw.fileKey, `${label}.fileKey`),
    components: raw.components.map((c, index) => parseComponent(c, `${label}.components[${index}]`)),
  };
  if (raw.label !== undefined) {
    file.label = asNonEmptyString(raw.label, `${label}.label`);
  }
  return file;
}

/**
 * Validate + normalize a parsed `figma_meta.json` object. Throws an actionable, field-named error on
 * any malformed input. `reindex` calls this so a corrupt meta fails loudly rather than silently
 * producing a half-built Figma index.
 */
export function parseFigmaMeta(raw: unknown): FigmaMeta {
  if (!isObject(raw)) {
    fail(`expected a JSON object, got ${raw === null ? "null" : typeof raw}.`);
  }
  if (!Array.isArray(raw.files)) {
    fail(`"files" must be an array.`);
  }
  return {
    version: raw.version === undefined ? 1 : asNonNegativeInt(raw.version, "version"),
    files: raw.files.map((file, index) => parseFile(file, `files[${index}]`)),
  };
}

export interface FigmaMetaEntry {
  fileKey: string;
  label?: string;
  nodeId: string;
  name: string;
  description?: string;
  image: FigmaMetaImage;
}

/**
 * Merge one captured Figma image into a {@link FigmaMeta} (pure; returns a new object). Upserts the
 * file → component → image by `fileKey` / `nodeId` / `image.path`, so the figma recorder can keep the
 * committed `figma_meta.json` (the reindex source of truth) in sync without clobbering sibling entries.
 * Re-recording the same path updates that one image in place — idempotent for the committed index.
 */
export function upsertFigmaMetaImage(meta: FigmaMeta, entry: FigmaMetaEntry): FigmaMeta {
  const files = meta.files.map((file) => ({
    ...file,
    components: file.components.map((component) => ({ ...component, images: [...component.images] })),
  }));

  let file = files.find((f) => f.fileKey === entry.fileKey);
  if (file === undefined) {
    file = { fileKey: entry.fileKey, components: [] };
    if (entry.label !== undefined) {
      file.label = entry.label;
    }
    files.push(file);
  } else if (entry.label !== undefined && file.label === undefined) {
    file.label = entry.label;
  }

  let component = file.components.find((c) => c.nodeId === entry.nodeId);
  if (component === undefined) {
    component = { nodeId: entry.nodeId, name: entry.name, images: [] };
    if (entry.description !== undefined) {
      component.description = entry.description;
    }
    file.components.push(component);
  } else {
    component.name = entry.name;
    if (entry.description !== undefined) {
      component.description = entry.description;
    }
  }

  const existing = component.images.findIndex((img) => img.path === entry.image.path);
  if (existing >= 0) {
    component.images[existing] = entry.image;
  } else {
    component.images.push(entry.image);
  }

  return { version: meta.version, files };
}
