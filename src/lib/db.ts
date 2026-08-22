import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Resolve the database URL without requiring a .env file: SQLite by default for
 * local/self-hosted runs, DATABASE_URL when one is provided (e.g. Postgres on Vercel).
 */
export const DATABASE_URL =
  process.env.DATABASE_URL || `file:${path.join(process.cwd(), "prisma", "dev.db")}`;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * A long-running dev server holds the Prisma client it started with. Add a
 * model to the schema, run `prisma generate`, and that process keeps the old
 * client — so `prisma.publishJob` is `undefined` and every route that touches
 * it throws "Cannot read properties of undefined (reading 'findMany')" with an
 * empty 500 body. That is a genuinely confusing failure to debug from the
 * browser, so it gets named here instead.
 */
export function assertModels(...names: string[]): void {
  const client = prisma as unknown as Record<string, unknown>;
  const missing = names.filter((n) => !client[n]);
  if (missing.length) {
    throw new Error(
      `The database client in this process does not know about: ${missing.join(", ")}. ` +
        "Run `npx prisma generate` and restart the server — a running dev server keeps the client it booted with.",
    );
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}
