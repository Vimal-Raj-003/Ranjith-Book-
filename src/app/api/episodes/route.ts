import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { errorBody, errorStatus } from "@/lib/errors";

export async function GET() {
  try {
    const rows = await prisma.episode.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { book: { select: { title: true } } },
    });

    return NextResponse.json({
      episodes: rows.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        step: e.step,
        theme: e.theme,
        partNumber: e.partNumber,
        seriesTotal: e.seriesTotal,
        durationSec: e.durationSec,
        createdAt: e.createdAt,
        bookTitle: e.book.title,
      })),
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
