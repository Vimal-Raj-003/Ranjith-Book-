/**
 * Writing the four platform fields — YouTube keyword tags, and the Instagram
 * hook, caption and hashtags — for an episode that does not have them yet.
 *
 * There are exactly two callers, and the point of this module is that they share
 * ONE implementation:
 *
 *   - the render (`pipeline.ts`), a best-effort step after the script is stored,
 *     so every NEW video opens its Publish panel already filled in; and
 *   - `POST /api/episodes/[id]/publish/generate`, for a video rendered before
 *     that step existed, run when the panel is opened.
 *
 * Both do the same thing: find which of the four fields are empty and not the
 * operator's, ask `generatePlatformMetadata` once, and store the answer into the
 * fields that are still empty — never over a value, never over a hand edit
 * (`storeGeneratedPlatform` makes that a property of the write, not of a check).
 *
 * Who may do it is NOT decided here. The route establishes the viewer and
 * visibility; the pipeline is the system itself acting on the episode it is
 * rendering. This module is given an episode id and trusts its caller.
 */
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { runCliJson } from "@/lib/content/cli-provider";
import type { CliProvider } from "@/lib/content/cli";
import { generatePlatformMetadata, type PlatformMetadata, type RegenerateSource } from "./regenerate";
import { missingFromRow, storeGeneratedPlatform, type PlatformField } from "./state";

/** What the generator is injected with in a test: a stub model call, or the whole generator. */
export interface GenerateDeps {
  generate?: typeof generatePlatformMetadata;
  call?: typeof runCliJson;
  provider?: CliProvider;
  model?: string;
}

export interface GenerateOutcome {
  /** Fields that were empty and not the operator's when the call started. */
  missing: PlatformField[];
  /** Fields the answer was actually stored into. A subset of `missing`: someone may have written one meanwhile. */
  filled: PlatformField[];
}

const SELECT = {
  id: true,
  title: true,
  hook: true,
  cta: true,
  script: true,
  voScript: true,
  description: true,
  youtubeTags: true,
  igHook: true,
  igCaption: true,
  igHashtags: true,
  youtubeTagsEditedAt: true,
  igHookEditedAt: true,
  igCaptionEditedAt: true,
  igHashtagsEditedAt: true,
  book: { select: { title: true, author: true, authorVerified: true, archetype: true } },
} as const;

/**
 * The model's ground truth for one episode: its own stored script.
 *
 * `author` is the pipeline's own rule, not a copy of the condition — an author
 * that was never verified is ABSENT, never a placeholder. `bookLink` is null on
 * purpose: this writes tags and Instagram copy, and neither carries a purchase
 * link (the YouTube description gets it in code, in `regenerateField`).
 */
function sourceOf(row: NonNullable<Awaited<ReturnType<typeof load>>>): RegenerateSource {
  return {
    bookTitle: row.book.title,
    author: row.book.authorVerified ? row.book.author : null,
    archetype: row.book.archetype,
    bookLink: null,
    title: row.title,
    hook: row.hook,
    cta: row.cta,
    script: row.script,
    voScript: row.voScript,
    // Never shown to the model: only used to refuse a caption that copies it.
    description: row.description,
  };
}

function load(episodeId: string) {
  return prisma.episode.findUnique({ where: { id: episodeId }, select: SELECT });
}

async function run(episodeId: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  const row = await load(episodeId);
  if (!row) throw new AppError("not_found", "Not found", 404);

  const missing = missingFromRow(row);
  // Nothing to write means no model call at all. A panel opened on a complete
  // episode, or on one whose fields the operator emptied on purpose, costs nothing.
  if (missing.length === 0) return { missing, filled: [] };

  const generate = deps.generate ?? generatePlatformMetadata;
  const generated: PlatformMetadata = await generate(sourceOf(row), {
    call: deps.call,
    provider: deps.provider,
    model: deps.model,
  });

  // Re-read inside `storeGeneratedPlatform`: the model took long enough for an
  // operator to have typed into one of these fields.
  const filled = await storeGeneratedPlatform(episodeId, generated);
  return { missing, filled };
}

/**
 * One generation per episode at a time. Opening a panel twice (two tabs, a
 * double-click on Generate, React re-running an effect) must not run two model
 * calls that each take a minute or two and then race to write the same fields —
 * the second caller simply waits for the first one's answer.
 */
// On `globalThis`, like the Prisma client in `db.ts`: the render and the route handler are bundled
// separately by Next and each gets its own copy of this module, and a map per copy would let the
// render's call and the panel's call run side by side. (The compare-and-swap in
// `storeGeneratedPlatform` keeps the data correct either way; this saves the second model call.)
const shared = globalThis as unknown as { __bookreelPlatformCopyInflight?: Map<string, Promise<GenerateOutcome>> };
const inflight: Map<string, Promise<GenerateOutcome>> = (shared.__bookreelPlatformCopyInflight ??= new Map());

/**
 * Write whichever of the four platform fields this episode is missing.
 * Throws an `AppError` (no script, writer unreachable, a reply over a cap); the
 * stored fields are untouched when it does.
 */
export function generateMissingPlatformMetadata(episodeId: string, deps: GenerateDeps = {}): Promise<GenerateOutcome> {
  const running = inflight.get(episodeId);
  if (running) return running;
  const job = run(episodeId, deps).finally(() => {
    inflight.delete(episodeId);
  });
  inflight.set(episodeId, job);
  return job;
}

/**
 * The render's version: the same work, as a step that CANNOT fail the render.
 *
 * Returns a note for the episode's run log when something went wrong, and null
 * when the step did its job or had nothing to do. It never throws and never
 * rejects: a CLI that is down, a reply over a cap, a script that is missing, a
 * row that vanished — all of them cost the operator these four fields (which the
 * Publish panel will offer to generate) and nothing else. The same contract the
 * music bed and the thumbnails follow in `pipeline.ts`.
 */
export async function runPlatformMetadataStep(episodeId: string, deps: GenerateDeps = {}): Promise<string | null> {
  try {
    await generateMissingPlatformMetadata(episodeId, deps);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `YouTube tags and Instagram copy were not written (${detail}) — the video is unaffected. Open Publish and press Generate to try again.`;
  }
}
