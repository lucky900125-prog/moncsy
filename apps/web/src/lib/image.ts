const isHeic = (f: File) => /image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name);

/**
 * Re-encodes a photo as JPEG, at most 1600px, before upload. Every image goes through the canvas, small ones too, so
 * the EXIF data (GPS position, device) never leaves the browser. PDFs pass through unchanged.
 * HEIC is always re-encoded (Safari can decode it); the AI providers cannot read HEIC, so an undecodable HEIC is an error.
 */
export async function shrinkImage(file: File, max = 1600): Promise<File> {
  const heic = isHeic(file);
  if (!file.type.startsWith("image/") && !heic) return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    if (heic) {
      throw new Error("Ez a böngésző nem tudja megnyitni a HEIC képet. Küldd JPG-ként, vagy állítsd az iPhone kamerát „Legkompatibilisebb” formátumra.");
    }
    // Sent as is, the file would carry its EXIF data; a format the browser cannot open is refused instead.
    throw new Error("Ez a böngésző nem tudja megnyitni a képet. Küldd JPG, PNG vagy WebP formátumban.");
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
