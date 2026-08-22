import { prisma } from "../db";
import { AppError } from "../errors";

export class IdeaTakenError extends AppError {
  constructor(ideaKey: string) {
    super("idea_taken", `This book already has an episode about "${ideaKey}".`, 409);
  }
}

/**
 * Claimed BEFORE the script is written, not after.
 *
 * Reserved afterwards, a run stores one angle while the video argues another,
 * and the guarantee that no two episodes of a book make the same point becomes
 * a hope. The unique index on (bookId, ideaKey) is what makes it enforceable.
 *
 * Throwing `IdeaTakenError` here is for a second EPISODE of the same book
 * proposing the same idea at a later time (a later upload, a later planning
 * run) — a genuine cross-run collision the database is the only reliable
 * witness to. A single planning run producing two episodes with the same
 * ideaKey is `validatePlan`'s business, not this function's: it already
 * drops the duplicate before anything reaches here, so by the time
 * `reserveIdea` is called, "already claimed" always means "claimed by some
 * other run", not "claimed earlier in this same plan".
 */
export async function reserveIdea(bookId: string, ideaKey: string): Promise<string> {
  try {
    await prisma.usedIdea.create({ data: { bookId, ideaKey } });
    return ideaKey;
  } catch {
    throw new IdeaTakenError(ideaKey);
  }
}

/**
 * A claim burned by a failed run is an angle no future episode of that book
 * could ever use, so this must be safe to call on every failing path: when
 * nothing was ever reserved (deleteMany on zero rows is a no-op, not an
 * error), when it's called twice for the same idea (the second call also
 * finds nothing and no-ops), and it must never itself throw — a cleanup
 * function that throws inside a catch block replaces the real error with
 * its own. Any database failure here is swallowed rather than propagated:
 * losing the release is a stuck idea an operator can clear manually, but a
 * cleanup throw in a catch block is a worse failure — the original error
 * that explains what actually went wrong.
 */
export async function releaseIdea(bookId: string, ideaKey: string): Promise<void> {
  try {
    await prisma.usedIdea.deleteMany({ where: { bookId, ideaKey } });
  } catch {
    // Never throw from cleanup. See doc comment above.
  }
}
