import type { CanvasBinaryFile } from "@t3tools/contracts";
import { CANVAS_IMAGE_MAX_SIZE } from "@t3tools/shared/canvas";

// Pasted images above this size are re-encoded even when small in pixels.
const IMAGE_MAX_BYTES = 1_500_000;

/**
 * Re-encodes a pasted raster image as WebP no larger than the size canvas
 * files keep, the same limit the server applies to images agents add.
 */
export async function shrinkCanvasImage(file: CanvasBinaryFile): Promise<CanvasBinaryFile> {
  if (!/^image\/(png|jpeg|webp|bmp)$/u.test(file.mimeType)) return file;
  const image = new Image();
  image.src = file.dataURL;
  try {
    await image.decode();
  } catch {
    return file;
  }
  const bytes = (file.dataURL.length - file.dataURL.indexOf(",") - 1) * 0.75;
  const scale = Math.min(
    1,
    CANVAS_IMAGE_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight),
  );
  if (scale === 1 && bytes <= IMAGE_MAX_BYTES) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL("image/webp", 0.9);
  return dataURL.startsWith("data:image/webp")
    ? { ...file, mimeType: "image/webp", dataURL }
    : file;
}
