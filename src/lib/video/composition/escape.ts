/**
 * The two ways data reaches the rendered page, and the escaping each needs.
 *
 * Shared by the skeleton (`build.ts`) and the scene layers (`scenes/render.ts`)
 * rather than copied into both: a `</script>` in book text closes the tag
 * early, GSAP never runs and the render comes out blank — a failure that looks
 * like a renderer bug and is not. Two copies of that guard would be two places
 * for it to rot, and `tests/composition.test.mts` already holds the line that
 * escaping must work "everywhere embedded data is written, not just in the
 * JSON payload".
 */

/** Data read back by script: JSON, with `<` neutralised. */
export function embed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** Text the server writes into the document as literal markup. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
