/**
 * Which poster represents an episode, and what an operator's headline edit is
 * allowed to look like.
 *
 * Pure and import-free on purpose: `pickPoster` runs in the browser (the
 * library grid and the inspector both call it), so nothing in here may reach
 * for `path`, Prisma or the work directory.
 */

/** Longer than this is not a headline, it is a paragraph that will not fit. */
const MAX_HEADLINE = 120;

/**
 * An operator's headline override, or null when there is not one.
 *
 * Whitespace-only is null rather than the empty string: an operator who
 * selects the field and deletes everything means "go back to the generated
 * headline", not "render a poster with no words on it".
 *
 * Markup is deliberately NOT stripped. The value is stored raw and escaped
 * at render time by the existing `escapeHtml`, which is the one place that
 * decision belongs. Stripping here would quietly mangle an ampersand or an
 * angle bracket that genuinely belongs in a book title.
 */
export function normaliseHeadline(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_HEADLINE);
}

/**
 * Whether the Retitle button should be live.
 *
 * Normally only when the field differs from what is saved: there is nothing to
 * redraw otherwise. The exception is the aftermath of a partial redraw. By then
 * the server has already stored the headline, so the field equals the saved
 * text, yet some posters were dropped -- and submitting that same text again is
 * the only way the operator can ask for them back. `failed` is how many posters
 * the last redraw could not draw; while it is above zero the button stays live.
 * Disabling it there left a dead end whose only exit was clearing the field,
 * paying for a full redraw to the generated headline, and retyping the words.
 */
export function canRetitle(draft: string, saved: string, failed: number): boolean {
  return draft.trim() !== saved || failed > 0;
}

/**
 * The poster to show for an episode: the operator's choice when it still
 * exists, otherwise the first 9:16, otherwise the first of anything.
 *
 * A stale `thumbChoice` is expected, not exceptional -- a retitle can drop a
 * poster that failed to redraw, and a row can be edited by hand. It degrades to
 * the default silently, because the alternative the operator would see is a
 * broken image icon.
 *
 * `choice` is tested for truthiness, not for `!== null`: a column holding the
 * empty string means "no choice made", exactly as NULL does.
 *
 * Generic over the thumbnail type so the same rule serves the server's
 * `PublicThumb` and the client's looser `ThumbnailRef` (whose `aspect` is a
 * plain string) without either being cast to the other.
 */
export function pickPoster<T extends { key: string; aspect: string }>(
  thumbs: T[],
  choice: string | null | undefined,
): T | null {
  const chosen = choice ? thumbs.find((t) => t.key === choice) : undefined;
  return chosen ?? thumbs.find((t) => t.aspect === "9:16") ?? thumbs[0] ?? null;
}
