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
  serverExternalPackages: ["pdfkit", "tesseract.js", "sharp"],
};

export default nextConfig;
