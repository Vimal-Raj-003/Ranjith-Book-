/**
 * Idea episodes run one at a time.
 *
 * A render starts a dozen headless Chrome workers (see `video/render.ts`), and
 * the voice is one local model: two episodes rendering at once would each run
 * at half speed at best and starve each other at worst. So "Generate videos"
 * on five ideas queues five episodes, and each starts when the one before it
 * settles.
 *
 * The queue lives in memory (`./live`): a server restart loses it, and
 * `reap.ts` then marks the waiting episodes interrupted, as it does any run
 * that dies with its process.
 */
import { runEpisode } from "../pipeline";
import { queueState as state, isEpisodeLive } from "./live";

export { isEpisodeLive };

export function enqueueEpisode(id: string): void {
  if (isEpisodeLive(id)) return;
  state.waiting.push(id);
  void drain();
}

async function drain(): Promise<void> {
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.waiting.length) {
      const id = state.waiting.shift()!;
      state.current = id;
      try {
        await runEpisode(id);
      } catch {
        // Recorded on the Episode row by runEpisode; the next one still runs.
      } finally {
        state.current = null;
      }
    }
  } finally {
    state.draining = false;
  }
}
