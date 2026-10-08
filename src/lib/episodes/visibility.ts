import type { Prisma } from "@prisma/client";

/**
 * Which episodes a signed-in user may see: their own, and the ones nobody owns.
 *
 * This is the rule `listEpisodes`, `GET /api/episodes/[id]` and the video route
 * already applied, written once so the routes that follow cannot drift from it.
 * It is the poster routes that did drift: they looked an episode up with
 * `findFirst({ where: { id, userId } })`, and SQL's `NULL = 'x'` is never true,
 * so an episode with no owner was LISTED by the library, had its video served,
 * and then had every one of its posters answer 404 -- a card with an initials
 * tile where its picture should be.
 *
 * Episodes created before sign-in existed, and ones made by tooling with no
 * session, carry no `userId`. Excluding them would empty the operator's own
 * library, which is why the list includes them; the detail, video and poster
 * routes must agree or the library shows rows that fail when opened.
 *
 * This does not widen who can see anything: those episodes were already listed
 * to every signed-in user and their video already served to every signed-in
 * user. A poster is the less sensitive half of that. What it must never do is
 * match another account's episode: `userId` is either the viewer's or null.
 *
 * There are two spellings because there are two shapes of call site, and for a
 * while only three of seven used this module at all -- the other four spelled
 * `episode.userId && episode.userId !== user.id` by hand, which is exactly the
 * drift that produced the poster bug:
 *
 *  - `visibleTo(userId)` for a query. Spread it: `{ id, ...visibleTo(user.id) }`.
 *  - `canSee(row, userId)` for a row already fetched. A route that needs
 *    `include`s, or that wants to tell "no such episode" apart from "not
 *    yours", reads it with `findUnique` and asks afterwards.
 *
 * WHAT THIS AUTHORISES. Reading, and non-destructive writing (choosing which
 * poster a card shows, retitling one, setting a release date). It is
 * deliberately generous about ownerless episodes because the alternative was an
 * empty library. Anything DESTRUCTIVE or externally visible -- delete, publish,
 * re-queue, re-render, cancel -- hands an ownerless episode to whoever signs in
 * first, and must be reconsidered on its own terms rather than inheriting this.
 * `POST /api/episodes/[id]/cancel` uses `canSee` today, which matches what it
 * has always done; it is the one call site worth revisiting if ownership is
 * ever tightened.
 *
 * One write that IS permitted on an ownerless upload, and why: `POST
 * /api/uploads/[id]/cover` (Regenerate) uses `visibleTo`. It deletes only the
 * cached cover files, which are re-derivable from the page image, and
 * `regenerateCover` clears nothing unless that page is still on disk. A write
 * that deletes something irreplaceable does not get to inherit this reasoning.
 */
export function visibleTo(userId: string) {
  return { OR: [{ userId }, { userId: null }] } satisfies Prisma.EpisodeWhereInput;
}

/** The row shape the rule needs: anything with a nullable owner. */
export interface OwnedRow {
  userId: string | null;
}

/**
 * The same rule, for a row that has already been fetched.
 *
 * `visibleTo` cannot serve these call sites: they use `findUnique` (so they can
 * `include` relations, and so a missing episode and someone else's are not the
 * same answer) and then decide. This is that decision, so there is one place
 * the rule lives rather than four hand-rolled copies of it.
 *
 * Null is "may not see it", so `canSee(await findUnique(...), id)` is safe —
 * and it is a type predicate, so the one `if` both authorises the request and
 * narrows the row away from null, instead of leaving the caller to repeat
 * `!episode ||` and get the two halves out of step.
 */
export function canSee<T extends OwnedRow>(row: T | null | undefined, userId: string): row is T {
  if (!row) return false;
  return row.userId === null || row.userId === userId;
}
