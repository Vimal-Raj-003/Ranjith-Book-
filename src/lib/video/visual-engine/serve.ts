import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canSee } from "@/lib/episodes/visibility";
import { parseVisualManifest } from "./index";

/**
 * Stream a generated scene visual image (`scene-0`, `scene-2`, ...) to an
 * authorised operator for UI preview in the Episode Inspector.
 */
export async function serveSceneVisual(
  userId: string,
  episodeId: string,
  key: string,
): Promise<Response> {
  if (!/^scene-\d{1,3}$/.test(key)) {
    return NextResponse.json({ error: "Invalid visual key." }, { status: 400 });
  }

  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, userId: true, visualManifest: true },
  });
  if (!episode || !canSee(episode, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const manifest = parseVisualManifest(episode.visualManifest);
  const item = manifest?.scenes.find((s) => s.key === key);
  if (!item?.imagePath) {
    return NextResponse.json({ error: "Scene visual not available." }, { status: 404 });
  }

  try {
    const bytes = await fsp.readFile(item.imagePath);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Scene visual file missing." }, { status: 404 });
  }
}
