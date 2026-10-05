/**
 * Inline images inside tool inputs and results.
 *
 * Providers carry images as base64 in several shapes:
 * - MCP content blocks: `{ type: "image", data, mimeType }`
 * - Anthropic content blocks: `{ type: "image", source: { type: "base64", media_type, data } }`
 * - Claude Code's Read result: `{ type: "image", file: { base64, type, originalSize, dimensions } }`
 * - data URLs: `"data:image/png;base64,..."`
 *
 * Everything here is pure so the server can bound a value before it goes on
 * the wire and clients can recognize what it left behind.
 */

/** An image normalized from any provider shape. `data` is base64 without a data-URL prefix. */
export interface ToolImage {
  readonly type: "image";
  readonly mimeType?: string;
  readonly data?: string;
  /** Size of the decoded image in bytes. */
  readonly byteLength?: number;
  readonly width?: number;
  readonly height?: number;
  /** The server dropped `data` to keep the value small. */
  readonly dataOmitted?: true;
}

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/iu;
const MAX_WALK_DEPTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function imageMimeType(value: unknown): string | undefined {
  return typeof value === "string" && /^image\/[a-z0-9.+-]+$/iu.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/** Decoded size of a base64 payload, without decoding it. */
export function base64DecodedByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function withoutUndefined(image: {
  mimeType?: string | undefined;
  data?: string | undefined;
  byteLength?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  dataOmitted?: true | undefined;
}): ToolImage {
  return {
    type: "image",
    ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
    ...(image.data === undefined ? {} : { data: image.data }),
    ...(image.byteLength === undefined ? {} : { byteLength: image.byteLength }),
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
    ...(image.dataOmitted === undefined ? {} : { dataOmitted: image.dataOmitted }),
  };
}

/** Recognizes one image node. Returns undefined for anything that is not an image. */
export function toolImageFromValue(value: unknown): ToolImage | undefined {
  if (typeof value === "string") {
    const match = DATA_URL_PATTERN.exec(value);
    if (match === null) return undefined;
    const data = value.slice(match[0].length);
    return withoutUndefined({
      mimeType: match[1]!.toLowerCase(),
      data,
      byteLength: base64DecodedByteLength(data),
    });
  }
  if (!isRecord(value) || value.type !== "image") return undefined;

  // Already normalized (or left behind by the server with its data dropped).
  if (value.dataOmitted === true || (typeof value.data === "string" && "byteLength" in value)) {
    return withoutUndefined({
      mimeType: imageMimeType(value.mimeType),
      data: typeof value.data === "string" ? value.data : undefined,
      byteLength: positiveNumber(value.byteLength),
      width: positiveNumber(value.width),
      height: positiveNumber(value.height),
      dataOmitted: value.dataOmitted === true ? true : undefined,
    });
  }

  // MCP: { type: "image", data, mimeType }
  if (typeof value.data === "string") {
    const fromUrl = toolImageFromValue(value.data);
    if (fromUrl !== undefined) return fromUrl;
    return withoutUndefined({
      mimeType: imageMimeType(value.mimeType ?? value.mime_type),
      data: value.data,
      byteLength: base64DecodedByteLength(value.data),
    });
  }

  // Anthropic: { type: "image", source: { type: "base64", media_type, data } }
  if (isRecord(value.source)) {
    const source = value.source;
    if (typeof source.data === "string") {
      return withoutUndefined({
        mimeType: imageMimeType(source.media_type ?? source.mediaType),
        data: source.data,
        byteLength: base64DecodedByteLength(source.data),
      });
    }
    if (typeof source.url === "string") {
      return toolImageFromValue(source.url) ?? withoutUndefined({});
    }
  }

  // Claude Code Read: { type: "image", file: { base64, type, originalSize, dimensions } }
  if (isRecord(value.file)) {
    const file = value.file;
    const dimensions = isRecord(file.dimensions) ? file.dimensions : undefined;
    const data = typeof file.base64 === "string" ? file.base64 : undefined;
    return withoutUndefined({
      mimeType: imageMimeType(file.type ?? file.mimeType),
      data,
      byteLength:
        positiveNumber(file.originalSize) ??
        (data === undefined ? undefined : base64DecodedByteLength(data)),
      width: positiveNumber(dimensions?.originalWidth ?? dimensions?.width),
      height: positiveNumber(dimensions?.originalHeight ?? dimensions?.height),
    });
  }

  // OpenAI style: { type: "image", image_url | imageUrl | url }
  for (const key of ["image_url", "imageUrl", "url"] as const) {
    const url = value[key];
    const image = toolImageFromValue(isRecord(url) ? url.url : url);
    if (image !== undefined) return image;
  }
  return undefined;
}

/**
 * Replaces every inline image in `value` with a normalized {@link ToolImage}.
 * Images keep their base64 while `inlineBudgetBytes` lasts (in base64
 * characters, counted across the whole value); later or larger ones keep only
 * their metadata. Non-image values are returned untouched.
 */
export function boundToolMedia(value: unknown, inlineBudgetBytes: number): unknown {
  let remaining = Math.max(0, inlineBudgetBytes);
  const walk = (node: unknown, depth: number): unknown => {
    const image = toolImageFromValue(node);
    if (image !== undefined) {
      const dataLength = image.data?.length ?? 0;
      if (image.data !== undefined && dataLength <= remaining) {
        remaining -= dataLength;
        return image;
      }
      const { data: _data, ...metadata } = image;
      return { ...metadata, ...(image.data === undefined ? {} : { dataOmitted: true as const }) };
    }
    if (depth >= MAX_WALK_DEPTH) return node;
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((entry) => {
        const bounded = walk(entry, depth + 1);
        if (bounded !== entry) changed = true;
        return bounded;
      });
      return changed ? next : node;
    }
    if (isRecord(node)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        const bounded = walk(entry, depth + 1);
        if (bounded !== entry) changed = true;
        next[key] = bounded;
      }
      return changed ? next : node;
    }
    return node;
  };
  return walk(value, 0);
}

/** A data URL a client can put in `<img src>`, when the image still carries its data. */
export function toolImageDataUrl(image: ToolImage): string | undefined {
  if (image.data === undefined || image.data.length === 0) return undefined;
  return `data:${image.mimeType ?? "image/png"};base64,${image.data}`;
}
