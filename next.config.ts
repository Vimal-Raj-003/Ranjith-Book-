import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit reads its built-in font metrics from disk at runtime, so it has to be
  // resolved by Node rather than bundled — otherwise the .afm paths are rewritten
  // and PDF generation fails with ENOENT.
  serverExternalPackages: ["pdfkit"],
};

export default nextConfig;
