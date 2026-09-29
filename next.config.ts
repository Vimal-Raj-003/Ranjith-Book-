import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit reads its built-in font metrics from disk at runtime, so it has to be
  // resolved by Node rather than bundled — otherwise the .afm paths are rewritten
  // and PDF generation fails with ENOENT.
  //
  // tesseract.js spawns a `worker_threads.Worker` from a `__dirname`-derived
  // absolute path and that worker script in turn `require()`s the WASM core
  // (`tesseract.js-core`) and language data relative to itself. Bundled by
  // Turbopack, those paths point into the bundle graph instead of real files
  // on disk: `createWorker()` never resolves and never rejects — confirmed by
  // running `measurePage` inside an actual Next.js route, where it hung with
  // zero CPU while the identical call in a standalone `tsx` script returns
  // normally. Same failure mode as pdfkit above, and `sharp` gets it for the
  // same underlying reason (a native/WASM module that must see its own real
  // path on disk).
  //
  // playwright-core is here for the same reason: it resolves its driver, its
  // browser registry (`browsers.json`) and the cached Chromium executable from
  // paths derived from its own package directory, so bundling it points those
  // lookups into the bundle graph rather than at real files. Thumbnails are
  // rendered by `src/lib/thumbnails` from inside the pipeline, which runs in
  // the Next.js server runtime, so it must be resolved by Node.
  //
  // @huggingface/transformers and onnxruntime-node (book analysis embeddings)
  // load a native ONNX Runtime binding and model files from their own package
  // directories — the same failure mode again if bundled.
  // NOT here: @tabler/icons. It is data, not code — it ships only SVGs and a
  // metadata JSON, with no JavaScript entry point at all — and Turbopack
  // refuses to externalise it: "Package @tabler/icons can't be external …
  // Only .mjs, .cjs, .js, .json, or .node can be handled by Node.js."
  // Listing it therefore buys nothing and emits that warning on every build.
  // `video/scenes/icons.ts` locates the package by walking the filesystem
  // instead, and never asks the bundler to resolve an asset.
  serverExternalPackages: [
    "pdfkit",
    "tesseract.js",
    "sharp",
    "playwright-core",
    "@huggingface/transformers",
    "onnxruntime-node",
  ],
};

export default nextConfig;
