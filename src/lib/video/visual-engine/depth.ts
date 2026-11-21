import sharp from "sharp";

export const DEPTH_MAP_W = 180;
export const DEPTH_MAP_H = 320;

/**
 * Synthesize a smooth, artifact-free 2.5D depth map (`180×320` grayscale PNG)
 * from a generated portrait image using multi-scale saliency, atmospheric
 * perspective, and Gaussian smoothing.
 *
 * Brighter pixels (`255`) = closer foreground; darker pixels (`0`) = distant background.
 * Smoothed intentionally (`blur(4.0)`) so Three.js vertex displacement produces
 * sculptural 3D parallax without jagged triangle edges.
 */
export async function generateSmoothDepthMap(
  imageBuffer: Buffer,
  outDepthPngPath: string,
): Promise<void> {
  const W = DEPTH_MAP_W;
  const H = DEPTH_MAP_H;

  // Coarse structure (low-frequency luminance) + medium-frequency detail.
  const [coarseRaw, fineRaw] = await Promise.all([
    sharp(imageBuffer)
      .resize(W, H, { fit: "cover" })
      .greyscale()
      .blur(8)
      .raw()
      .toBuffer(),
    sharp(imageBuffer)
      .resize(W, H, { fit: "cover" })
      .greyscale()
      .blur(1.8)
      .raw()
      .toBuffer(),
  ]);

  // Estimate whether the scene is bright-subject-on-dark or dark-silhouette-on-bright-sky.
  let topSum = 0;
  let midSum = 0;
  const topRows = Math.floor(H * 0.28);
  const midStart = Math.floor(H * 0.35);
  const midEnd = Math.floor(H * 0.75);

  for (let y = 0; y < topRows; y++) {
    for (let x = 0; x < W; x++) topSum += coarseRaw[y * W + x];
  }
  for (let y = midStart; y < midEnd; y++) {
    for (let x = 0; x < W; x++) midSum += coarseRaw[y * W + x];
  }
  const topMean = topSum / Math.max(1, topRows * W);
  const midMean = midSum / Math.max(1, (midEnd - midStart) * W);
  // If sky/top is much brighter than the center, foreground silhouettes are darker than sky.
  const silhouetteMode = topMean > midMean + 22;

  const depthRaw = Buffer.alloc(W * H);

  for (let y = 0; y < H; y++) {
    const ny = y / (H - 1); // 0 top .. 1 bottom
    // Ground-plane perspective ramp: bottom is closer than top sky.
    const groundRamp = Math.pow(ny, 1.15);

    for (let x = 0; x < W; x++) {
      const nx = x / (W - 1); // 0 left .. 1 right
      const idx = y * W + x;

      const lum = coarseRaw[idx] / 255;
      const detail = Math.min(1, Math.abs(fineRaw[idx] - coarseRaw[idx]) / 64);

      // Subject prominence around the lower-center cinematic focal zone.
      const dx = (nx - 0.5) / 0.46;
      const dy = (ny - 0.56) / 0.42;
      const radialSubject = Math.exp(-(dx * dx + dy * dy) * 1.15);

      const tonalDepth = silhouetteMode ? 1 - lum : lum;

      const combined =
        0.38 * groundRamp +
        0.30 * tonalDepth * (0.45 + 0.55 * radialSubject) +
        0.20 * radialSubject +
        0.12 * detail;

      depthRaw[idx] = Math.max(0, Math.min(255, Math.round(combined * 255)));
    }
  }

  await sharp(depthRaw, { raw: { width: W, height: H, channels: 1 } })
    .blur(3.6)
    .normalise()
    .png({ compressionLevel: 6 })
    .toFile(outDepthPngPath);
}
