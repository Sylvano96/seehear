// Image helpers shared by the service worker and extension pages.
// Everything uses OffscreenCanvas so it also works inside the service worker.

import { loadEntry, storeEntry } from "./session.js";

// Kept small: images live in RAM (session storage) until the browser closes.
const MAX_SIDE = 1600;
const MAX_PNG_BYTES = 1.5 * 1024 * 1024;
const KEEP_IMAGES = 3;

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// Draws `source` (optionally cropped) to a canvas no larger than MAX_SIDE and
// re-encodes it: PNG keeps text sharp, JPEG is used when PNG gets too heavy.
async function encode(bitmap, sx, sy, sw, sh) {
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);

  let blob = await canvas.convertToBlob({ type: "image/png" });
  if (blob.size > MAX_PNG_BYTES) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  }
  return { blob, width: w, height: h };
}

// Normalizes any image blob (import, paste, drag & drop, remote fetch).
// Limits for imported files: a huge file, or a small one that decodes into a
// gigantic image ("decompression bomb"), could exhaust the browser's memory.
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;

export class ImageTooLargeError extends Error {
  constructor() {
    super("This image is too large (40 MB and 50 megapixels max).");
  }
}

export async function normalizeImage(blob) {
  if (blob.size > MAX_INPUT_BYTES) throw new ImageTooLargeError();
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > MAX_INPUT_PIXELS) throw new ImageTooLargeError();
    return await encode(bitmap, 0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

// Lighter JPEG copy for APIs that reject big uploads (Bing answers 400 to
// multi-megabyte images).
export async function shrinkDataURL(dataUrl, maxSide = 1000) {
  const bitmap = await createImageBitmap(await dataURLToBlob(dataUrl));
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return blobToDataURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 }));
  } finally {
    bitmap.close();
  }
}

// Crops a screenshot. `rect` is in CSS pixels relative to the viewport;
// `viewportWidth` lets us derive the real scale (DPI + browser zoom).
export async function cropScreenshot(screenshotDataUrl, rect, viewportWidth) {
  const bitmap = await createImageBitmap(await dataURLToBlob(screenshotDataUrl));
  try {
    const scale = bitmap.width / viewportWidth;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));
    return await encode(bitmap, sx, sy, sw, sh);
  } finally {
    bitmap.close();
  }
}

// Hands an image to the search page through session storage (memory only,
// cleared when the browser closes — nothing is saved permanently).
export const storeImage = (entry) => storeEntry("img", entry, KEEP_IMAGES);
export const loadImage = (id) => loadEntry("img", id);
