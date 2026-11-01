import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";

export async function setIdeasSelection(
  uploadId: string,
  userId: string | null,
  selected: boolean,
  ideaIds?: string[] | null,
): Promise<{ ok: true; selected: boolean; updated: number }> {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.kind !== "pdf" || (upload.userId && upload.userId !== userId)) {
    throw new AppError("not_found", "Not found", 404);
  }

  const validIds = Array.isArray(ideaIds)
    ? ideaIds.filter((v): v is string => typeof v === "string")
    : null;

  const result = await prisma.contentIdea.updateMany({
    where: {
      uploadId,
      ...(validIds && validIds.length > 0 ? { id: { in: validIds } } : {}),
    },
    data: { status: selected ? "SELECTED" : "PROPOSED" },
  });

  return { ok: true, selected, updated: result.count };
}
