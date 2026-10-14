import { pickComposerImages, renderPhotoAsJpeg } from "../../lib/composerImages";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";

export interface CanvasImage {
  readonly dataURL: string;
  readonly mimeType: string;
}

export interface CanvasImagePick {
  readonly images: ReadonlyArray<CanvasImage>;
  readonly error: string | null;
}

/** Photos from the library. The canvas page shrinks them before saving. */
export async function pickCanvasImages(): Promise<CanvasImagePick> {
  const result = await pickComposerImages({ existingCount: 0 });
  return {
    images: result.images.flatMap((image) =>
      image.dataUrl ? [{ dataURL: image.dataUrl, mimeType: image.mimeType }] : [],
    ),
    error: result.error,
  };
}

export async function takeCanvasPhoto(): Promise<CanvasImagePick> {
  let picker: typeof import("expo-image-picker");
  try {
    picker = await import("expo-image-picker");
  } catch {
    return { images: [], error: "The camera is unavailable right now." };
  }
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { images: [], error: "Allow camera access in Settings to take a photo." };
  }
  // The camera covers the Android activity, which reports the app as backgrounded.
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof picker.launchCameraAsync>>;
  try {
    result = await picker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : "Could not open the camera.",
    };
  } finally {
    endHandoff();
  }
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return { images: [], error: null };
  try {
    const photo = await renderPhotoAsJpeg(asset.uri);
    return {
      images: [{ dataURL: `data:image/jpeg;base64,${photo.base64}`, mimeType: "image/jpeg" }],
      error: null,
    };
  } catch {
    return { images: [], error: "Could not read the photo." };
  }
}

export async function pasteCanvasImage(): Promise<CanvasImagePick> {
  let clipboard: typeof import("expo-clipboard");
  try {
    clipboard = await import("expo-clipboard");
  } catch {
    return { images: [], error: "Clipboard paste is unavailable right now." };
  }
  const image = (await clipboard.hasImageAsync())
    ? await clipboard.getImageAsync({ format: "png" })
    : null;
  return image
    ? { images: [{ dataURL: image.data, mimeType: "image/png" }], error: null }
    : { images: [], error: "The clipboard has no image." };
}
