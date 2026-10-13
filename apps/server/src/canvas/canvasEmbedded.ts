// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads the scene Excalidraw embeds in exported images when "Embed scene" is
 * on: SVG keeps it in a base64 comment block, PNG in a tEXt chunk. Both hold
 * the same envelope around deflated JSON. Such files open read-only.
 */
import * as NodeZlib from "node:zlib";

const MIME = "application/vnd.excalidraw+json";

const latin1Bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** The scene JSON inside Excalidraw's `{ encoded, compressed }` envelope. */
function openEnvelope(json: string): string | null {
  try {
    const envelope = JSON.parse(json) as {
      encoding?: unknown;
      compressed?: unknown;
      encoded?: unknown;
    };
    if (typeof envelope.encoded !== "string") return null;
    const bytes = latin1Bytes(envelope.encoded);
    const raw = envelope.compressed === true ? NodeZlib.inflateSync(bytes) : bytes;
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/** The embedded scene's JSON text, or null when the SVG carries none. */
export function embeddedSceneFromSvg(svg: string): string | null {
  if (!svg.includes(`payload-type:${MIME}`)) return null;
  const payload = /<!-- payload-start -->\s*([A-Za-z0-9+/=\s]+?)\s*<!-- payload-end -->/u.exec(
    svg,
  )?.[1];
  if (payload === undefined) return null;
  const decoded = Buffer.from(payload, "base64").toString("latin1");
  // Version 1 stored the scene JSON directly; version 2 wraps it.
  return svg.includes("payload-version:1")
    ? Buffer.from(decoded, "latin1").toString("utf8")
    : openEnvelope(decoded);
}

/** The embedded scene's JSON text, or null when the PNG carries none. */
export function embeddedSceneFromPng(png: Uint8Array): string | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 8 || view.getUint32(0) !== 0x89504e47) return null;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const split = data.indexOf(0);
      const keyword = Buffer.from(data.subarray(0, split)).toString("latin1");
      if (keyword === MIME) {
        return openEnvelope(Buffer.from(data.subarray(split + 1)).toString("latin1"));
      }
    }
    if (type === "IEND") return null;
    offset += 12 + length;
  }
  return null;
}
