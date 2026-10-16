/** By type or name; a file without either is recognised by its content in shrinkImage. */
export const isHeic = (f: File) => /image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name);

async function head(file: File, n: number) {
  return String.fromCharCode(...new Uint8Array(await file.slice(0, n).arrayBuffer()));
}

/** By content, not by type or name: a file can come with neither, and the server also goes by its first bytes. */
async function isPdf(file: File) {
  return (await head(file, 5)) === "%PDF-";
}

/** The brands the server also reads as HEIC (apps/api/src/routes/ai.ts). */
async function isHeifContent(file: File) {
  return /^ftyp(heic|heix|hevc|mif1|msf1|heif)/.test((await head(file, 12)).slice(4));
}

/**
 * Decodes a HEIC with libheif compiled to WebAssembly, for the browsers that cannot open one themselves (all but
 * Safari). The decoder (about 2 MB) is loaded only when such a photo comes. libheif applies the photo's rotation.
 */
async function decodeHeic(file: File): Promise<ImageBitmap> {
  const { default: libheif } = await import("libheif-js/libheif-wasm/libheif-bundle.mjs");
  const image = new (libheif().HeifDecoder)().decode(new Uint8Array(await file.arrayBuffer()))[0];
  if (!image) throw new Error("A HEIC fájlban nincs kép.");
  try {
    const pixels = new ImageData(image.get_width(), image.get_height());
    await new Promise<void>((resolve, reject) =>
      image.display(pixels, (shown) => (shown ? resolve() : reject(new Error("A HEIC képet nem sikerült kibontani.")))),
    );
    return await createImageBitmap(pixels);
  } finally {
    image.free();
  }
}

/**
 * Re-encodes a photo as JPEG, at most 1600px, before upload. Everything but a PDF goes through the canvas, small
 * images and files without a type too, so the EXIF data (GPS position, device) never leaves the browser.
 * The AI providers cannot read HEIC, so a HEIC the browser cannot open is decoded with libheif and sent as JPEG too.
 */
export async function shrinkImage(file: File, max = 1600): Promise<File> {
  if (await isPdf(file)) return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    if (isHeic(file) || (await isHeifContent(file))) {
      bmp = await decodeHeic(file);
    } else {
      // Sent as is, the file would carry its EXIF data; a format the browser cannot open is refused instead.
      throw new Error("Ez a böngésző nem tudja megnyitni a képet. Küldd JPG, PNG, WebP vagy HEIC formátumban.");
    }
  }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("A képet nem sikerült feltöltésre előkészíteni.");
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}
