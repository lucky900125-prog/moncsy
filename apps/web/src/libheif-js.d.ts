// The parts of libheif-js's WebAssembly bundle that lib/image.ts uses; the package ships no types for this file.
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: ImageData, done: (shown: ImageData | null) => void): void;
    free(): void;
  }
  export default function libheif(): { HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] } };
}
