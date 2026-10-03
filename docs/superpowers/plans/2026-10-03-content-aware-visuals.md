# Content-Aware Cinematic Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each scene's visual follow from what the narration means, and make unrelated videos look genuinely different, by replacing keyword-matched visual selection with semantic selection, widening the concept catalogue, and giving every scene its own environment instead of one global backdrop.

**Architecture:** Three existing mechanisms are extended rather than replaced. (1) `heroForText` keeps its signature but scores by sentence-embedding similarity against each hero's description, using the local `transformersEmbedder` already in the repo. (2) The hero catalogue gains the concept families it cannot currently express, each with a `cine-runtime.js` builder. (3) The per-scene `#scene-glow` layer — which already varies by `scene.tone` — becomes a real per-scene environment driven by an `environment` the director chooses. Text sizing stops being a character-count estimate and is measured in the browser once at init.

**Tech Stack:** TypeScript, Next.js 16, Three.js 0.160 (UMD, inlined), GSAP 3.14 (CDN), HyperFrames CLI renderer, `@xenova/transformers` + ONNX (already a dependency, local, Apache-2.0), `node:test` + `tsx`, `playwright-core`.

**Spec:** The operator's brief of 2026-10-03 (in-conversation) plus the root-cause report derived from it. Root causes, measured:
- **RC1** `theme.backdrop()` is emitted once at `build.ts:1918` from a global app setting (`idea-episode.ts:126`); no per-scene environment exists. 40 episodes produced 2 backgrounds.
- **RC2** `heroForText` keyword-scores a closed 15-object catalogue. Over all 82 real cinematic scenes: 12% matched nothing (fell to `orb`), 67% matched on a single incidental word, only 5% scored 3+.
- **RC3** No video-level identity or progression; heroes are picked per sentence with an immediate-repeat `avoid` list only.
- **RC4** Type size is always estimated (`fitSize = max − chars × per`); `measureText`/`getBoundingClientRect` appear nowhere in the rendering path.

## Global Constraints

- Finished videos stay **45–90 s**; never exceed 90 s. Duration tiers in `src/lib/content/duration.ts` are unchanged by this plan.
- Target generation time ~7–10 min. **No render-time network fetches.** The embedder runs at plan time, not render time, and its model is already cached under `CACHE_ROOT/models`.
- **No new dependencies.** `@xenova/transformers` is already present and used by book analysis.
- Do not break: PDF ingestion (1–200 pages), 14–20 idea extraction, source grounding and quote verification, script/voice generation, audio word timing and subtitle sync, book-page references and word-level highlights, cancellation/progress/failure handling, browser preview and seeking, existing fallbacks.
- **Seek-safety is absolute.** One tween per element per property, non-overlapping; anything `onUpdate`-driven computes from `tl.time()` and never accumulates. `scripts/e2e-seek.mjs` must print `Seek-safe: 5 theme(s) × 24 timestamps.`
- Every absolutely positioned element uses `top:`, never `bottom:`.
- The timeline JS is built inside a TS template literal — no raw backticks, no raw `${`, in inserted JavaScript.
- Three.js: **single-group geometries only** (Cylinder/Cone/Box paint blank in a real screenshot render). Use the `lathe()`/`poly()`/`sprite()`/`points()` helpers in `cine-runtime.js`.
- A hero frame must be a pure function of `(hero, t, p)` — no `Math.random`, `Date.now`, `requestAnimationFrame`, `setTimeout`, or network. `tests/cinematic.test.mts` enforces this.
- Embedding must degrade: if `transformersEmbedder` is unavailable, fall back to `lexicalEmbedder` and record it, exactly as book analysis does. A degraded run must never fail a render.
- Run one test file: `DATABASE_URL="file:./dev.db" npx tsx --test tests/<name>.test.mts`
- Full suite: `npm test`. Known Windows baseline ≈ 607 pass / 10 fail / 1 cancelled / 4 skipped; those 10 are pre-existing and unrelated. Report counts; the failure count must not grow.
- Work on branch `frame-legibility-highlighting`. Do not merge, rebase, push, or switch branches.

## Review Focus

Five failure modes the brief implies that no task's happy path would catch.

1. **Embedding unavailable or slow** — first run with no cached model, or an offline machine. Hero selection must fall back to lexical scoring and the render must still complete, with the degradation recorded. (Task 1)
2. **A concept matching no hero well even semantically** — the top similarity is still low. The system must pick the best available and say so, never emit an undefined hero or crash. (Task 1)
3. **A new hero that renders blank in the real screenshot renderer** — the multi-group-geometry trap that has already cost this repo. Each new hero must be proven to paint pixels in a real browser, not just compile. (Task 2)
4. **Environment crossfades overlapping** — two environment layers tweening the same property at once breaks seek-safety and shows both backgrounds. (Task 3)
5. **Measured text fitting that never runs, or runs after the first captured frame** — the renderer screenshots frame 0; a fit performed on a later tick leaves the first frames wrong. (Task 4)

---

### Task 1: Semantic hero selection

**Files:**
- Modify: `src/lib/video/scenes/heroes.ts`
- Modify: `src/lib/video/scenes/validate.ts` (lines ~398, ~516, ~533, ~576 — the four `heroForText` call sites)
- Modify: `tests/cinematic.test.mts`
- Create: `tests/hero-semantics.test.mts`

**Interfaces:**
- Consumes: `transformersEmbedder`, `lexicalEmbedder`, `cosine`, `type Embedder` from `src/lib/analysis/embed`.
- Produces: `heroForTextSync(text, avoid)` (the existing keyword behaviour, renamed, kept as the fallback), and `async heroRanker(embedder?): Promise<HeroRanker>` where `HeroRanker = { pick(text: string, avoid?: readonly HeroId[]): HeroId; score(text: string): number; source: "embedding" | "lexical" }`. `ValidateContext` gains `heroRanker?: HeroRanker`.

- [ ] **Step 1: Write the failing test**

Create `tests/hero-semantics.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { heroRanker, heroForTextSync, HERO_IDS } from "../src/lib/video/scenes/heroes";
import { lexicalEmbedder } from "../src/lib/analysis/embed";

test("a ranker built on the lexical fallback still returns a real hero for anything", async () => {
  const r = await heroRanker(lexicalEmbedder);
  assert.equal(r.source, "lexical");
  for (const text of ["", "zzz qqq xyzzy", "Pleasure and pain happen inside the skull"]) {
    assert.ok(HERO_IDS.includes(r.pick(text)), `"${text}" produced a real hero`);
  }
});

test("semantic ranking beats keyword counting on concepts the catalogue states but does not spell", async () => {
  const r = await heroRanker();
  // These are the exact sentences that scored 0 against the keyword matcher and fell to `orb`.
  const cases: [string, string[]][] = [
    ["Pleasure and pain happen inside the skull", ["mind"]],
    ["Your memory fails you when you need it most", ["mind"]],
    ["Sleep repairs the body while you do nothing", ["rest"]],
    ["Fear keeps you from ever starting", ["storm", "wall"]],
    ["Anger floods you before you can think", ["storm"]],
    ["A conversation changes how both people see it", ["dialogue"]],
  ];
  for (const [text, acceptable] of cases) {
    const got = r.pick(text);
    assert.ok(acceptable.includes(got), `"${text}" -> ${got}, wanted one of ${acceptable.join("/")}`);
  }
});

test("the ranker respects `avoid`, and falls back to its best pick when everything is used", async () => {
  const r = await heroRanker();
  const text = "Time runs out while you wait";
  const first = r.pick(text);
  const second = r.pick(text, [first]);
  assert.notEqual(second, first);
  assert.equal(r.pick(text, HERO_IDS), first, "when all are used the best pick repeats rather than failing");
});

test("the synchronous keyword matcher is still available as the never-unavailable fallback", () => {
  assert.ok(HERO_IDS.includes(heroForTextSync("time is running out")));
  assert.equal(heroForTextSync("zzz qqq"), "orb");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/hero-semantics.test.mts`
Expected: FAIL — `heroRanker` and `heroForTextSync` are not exported.

- [ ] **Step 3: Implement the ranker**

In `heroes.ts`: rename the existing `heroForText` to `heroForTextSync` (keep its behaviour exactly), keep `heroScores`/`heroMatch` as they are, and add:

```ts
import { transformersEmbedder, lexicalEmbedder, cosine, type Embedder } from "../../analysis/embed";

/** What a hero means, as a sentence an embedder can compare narration against. */
function heroDescription(id: HeroId): string {
  const g = HERO_GUIDE[id];
  return `${g.shows}. Use for: ${g.use}. ${g.words.join(", ")}`;
}

export interface HeroRanker {
  pick(text: string, avoid?: readonly HeroId[]): HeroId;
  /** Cosine similarity of the best match, 0..1 — how well the catalogue actually fits. */
  score(text: string): number;
  source: "embedding" | "lexical";
}

/**
 * Rank heroes by MEANING rather than by keyword count.
 *
 * Measured on 82 real scenes, the keyword matcher scored 0 on 12% (which then
 * fell to the generic `orb`) and 1 — a single incidental word — on 67%. The
 * catalogue states what each hero is for in prose; comparing that prose to the
 * narration uses the information the keyword list throws away.
 *
 * Built once per plan (15-25 short vectors), never at render time.
 */
export async function heroRanker(embedder?: Embedder): Promise<HeroRanker> {
  let chosen: Embedder = embedder ?? transformersEmbedder;
  let vectors: Float32Array[];
  try {
    vectors = await chosen.embed(HERO_IDS.map(heroDescription));
  } catch {
    // A machine with no cached model and no network still gets a working ranker.
    chosen = lexicalEmbedder;
    vectors = await chosen.embed(HERO_IDS.map(heroDescription));
  }
  const source = chosen.id === lexicalEmbedder.id ? "lexical" as const : "embedding" as const;
  const cache = new Map<string, { ranked: HeroId[]; best: number }>();

  const rank = (text: string) => {
    const key = text.slice(0, 400);
    const hit = cache.get(key);
    if (hit) return hit;
    // Synchronous consumers (the validator's repair passes) need this to be
    // callable without awaiting, so every text they can ask about is embedded
    // up front by `prepare` below; anything else degrades to the keyword matcher.
    const pre = prepared.get(key);
    if (!pre) {
      const fallback = { ranked: [heroForTextSync(text)] as HeroId[], best: 0 };
      cache.set(key, fallback);
      return fallback;
    }
    const scored = HERO_IDS.map((id, i) => ({ id, s: cosine(pre, vectors[i]) }))
      .sort((a, b) => b.s - a.s);
    const out = { ranked: scored.map((x) => x.id), best: scored[0]?.s ?? 0 };
    cache.set(key, out);
    return out;
  };

  const prepared = new Map<string, Float32Array>();
  const ranker: HeroRanker & { prepare(texts: string[]): Promise<void> } = {
    source,
    async prepare(texts: string[]) {
      const want = [...new Set(texts.map((t) => t.slice(0, 400)))].filter((t) => t && !prepared.has(t));
      if (want.length === 0) return;
      const vecs = await chosen.embed(want);
      want.forEach((t, i) => prepared.set(t, vecs[i]));
    },
    pick(text, avoid = []) {
      const { ranked } = rank(text);
      return ranked.find((id) => !avoid.includes(id)) ?? ranked[0] ?? "orb";
    },
    score(text) {
      return rank(text).best;
    },
  };
  return ranker;
}
```

Note the shape: `prepare()` embeds every candidate text in one batch before the synchronous `pick()` calls happen, because the validator's repair passes are synchronous. Export `prepare` on the type.

In `validate.ts`, add `heroRanker?: HeroRanker` to `ValidateContext`, and at each of the four `heroForText` call sites use `ctx.heroRanker?.pick(text, avoid) ?? heroForTextSync(text, avoid)`. At the top of `validateScenes`, if a ranker is present, call `await ranker.prepare([...])` with every text the repair passes may ask about (each scene's concept + narration, and the hook).

In `scenes/index.ts`'s `planScenes`, build the ranker once (`await heroRanker()`) and pass it into the context. Record `ranker.source` in the plan's notes when it is `"lexical"`, so a degraded run is visible.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/hero-semantics.test.mts tests/scenes.test.mts tests/cinematic.test.mts && npx tsc --noEmit`
Expected: PASS, tsc silent. Note: the semantic test needs the heroes added in Task 2 — if `mind`/`rest`/`storm`/`dialogue` do not exist yet, that test is expected to fail until Task 2 lands. Mark it `{ todo: true }` with a comment naming Task 2, and remove the todo in Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/video/scenes/heroes.ts src/lib/video/scenes/validate.ts src/lib/video/scenes/index.ts tests/hero-semantics.test.mts
git commit -m "feat(scenes): choose heroes by meaning, not by incidental keywords"
```

---

### Task 2: The concept families the catalogue cannot express

**Files:**
- Modify: `src/lib/video/scenes/heroes.ts` (HERO_IDS, HERO_GUIDE)
- Modify: `src/lib/video/scenes/cine-runtime.js` (one builder per new hero)
- Modify: `tests/cinematic.test.mts`, `tests/hero-semantics.test.mts` (remove the todo)

**Interfaces:**
- Consumes: the `cine-runtime.js` helpers `box()`, `poly()`, `lathe()`, `sprite()`, `points()`, `contactShadow()`, `std()`, `mulberry()`, `smooth()`, `lerp()`, `clamp()`, `ease()`, `fract()`.
- Produces: seven new `HeroId`s — `mind`, `storm`, `rest`, `dialogue`, `wall`, `heart`, `loop` — each with a `HERO_GUIDE` entry and a `HEROES.<id> = function (E) { … }` builder returning `{ group, update(t, p), cam(t, p, cam) }`, and a `FIT` entry.

These seven cover exactly the families measured as unreachable: mind/memory/attention; fear/anger/turmoil; sleep/rest/recovery; conversation/relationship; obstacle/barrier/resistance; health/body/vitality; habit/routine/repetition.

- [ ] **Step 1: Write the failing test**

Add to `tests/cinematic.test.mts`:

```ts
test("every concept family the narration actually uses has a hero that can show it", () => {
  for (const id of ["mind", "storm", "rest", "dialogue", "wall", "heart", "loop"] as const) {
    assert.ok(HERO_IDS.includes(id), `${id} is in the catalogue`);
    assert.ok(HERO_GUIDE[id].shows.length > 5 && HERO_GUIDE[id].words.length >= 6, `${id} is described well enough to embed`);
  }
});
```

The existing tests in that file already assert that every `HERO_ID` has a builder in `cine-runtime.js` and vice versa, that the runtime compiles, and that no banned geometry or impure call appears — so adding the ids makes those fail until the builders exist. That is the RED.

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/cinematic.test.mts`
Expected: FAIL — the new ids have no builder.

- [ ] **Step 3: Add the catalogue entries**

In `heroes.ts`, add to `HERO_IDS` and `HERO_GUIDE`. Write each `shows`/`use`/`words` as prose an embedder can match narration against — this is now load-bearing, not documentation. For example:

```ts
  mind: {
    shows: "a translucent head in profile with thoughts orbiting inside it",
    use: "the mind itself — thinking, memory, attention, what happens inside your head",
    words: ["mind", "brain", "skull", "head", "thought", "thinking", "memory", "remember", "attention", "concentrate", "mental", "imagination", "consciousness"],
  },
  storm: {
    shows: "a dark churning cloud lit from within by lightning",
    use: "fear, anger, stress, turmoil, an emotion that floods and overwhelms",
    words: ["fear", "afraid", "anger", "angry", "rage", "stress", "anxiety", "panic", "turmoil", "overwhelm", "storm", "chaos", "worry"],
  },
  rest: {
    shows: "a still horizon under a slow moon, everything at rest",
    use: "sleep, rest, recovery, stillness, doing nothing on purpose",
    words: ["sleep", "rest", "recover", "recovery", "still", "stillness", "calm", "quiet", "pause", "night", "slow", "breathe"],
  },
```

and the same shape for `dialogue` (two forms exchanging light — conversation, relationships, other people), `wall` (a barrier that cracks — obstacles, resistance, what blocks you), `heart` (a beating form with a pulse line — health, the body, vitality), and `loop` (a closed ring of spheres cycling forever — habit, routine, repetition, the cycle you repeat).

- [ ] **Step 4: Write the builders**

In `cine-runtime.js`, add one `HEROES.<id>` per new hero, following the contract exactly. Rules that are not negotiable, each learned from a real failure in this repo:
- **Single-group geometries only.** `SphereGeometry`, `TorusGeometry`, `CircleGeometry`, `PlaneGeometry`, `BufferGeometry` and the file's own `lathe()`/`poly()` are safe. `CylinderGeometry`, `ConeGeometry`, `BoxGeometry`, `CapsuleGeometry` paint **blank** in the real screenshot renderer — the existing test bans them.
- **Pure frames.** No `Math.random` (use `mulberry(seed)`), no `Date.now`, no timers.
- Respect `E.light` for light vs dark palettes, as every existing builder does.
- Add a `FIT` entry per hero (`{ z, dy }`) so the object sits below the headline; copy the convention from neighbouring entries.

- [ ] **Step 5: Verify they actually paint, in a real browser**

Each new hero must be proven to render pixels — compiling is not enough, because the multi-group trap produces a blank canvas with no error. Add to `tests/cinematic.test.mts`, beside the existing live-browser hero test:

```ts
test("every new hero paints real pixels in a real browser (live)", async () => {
  const html = composition("marginalia");
  await withPage(html, async (page) => {
    for (const id of ["mind", "storm", "rest", "dialogue", "wall", "heart", "loop"] as const) {
      const painted = await page.evaluate((hero) => {
        const eng = (window as any).CINE.create({ THREE: (window as any).THREE, width: 360, height: 640, accent: "#d9531e", light: false });
        eng.ensure(hero);
        eng.draw(hero, 1.2, 0.5);
        const c = document.createElement("canvas");
        c.width = 360; c.height = 640;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(eng.canvas, 0, 0);
        const d = ctx.getImageData(0, 0, 360, 640).data;
        let n = 0;
        for (let k = 3; k < d.length; k += 4 * 7) if (d[k] > 8) n++;
        eng.dispose();
        return n;
      }, id);
      assert.ok(painted > 400, `${id} painted only ${painted} samples — likely a multi-group geometry`);
    }
  });
});
```

- [ ] **Step 6: Run everything and remove the Task 1 todo**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/cinematic.test.mts tests/hero-semantics.test.mts && npx tsc --noEmit`
Expected: PASS including the previously-todo semantic test, now that `mind`/`rest`/`storm`/`dialogue` exist.

- [ ] **Step 7: Commit**

```bash
git add src/lib/video/scenes/heroes.ts src/lib/video/scenes/cine-runtime.js tests/cinematic.test.mts tests/hero-semantics.test.mts
git commit -m "feat(scenes): heroes for mind, storm, rest, dialogue, wall, heart and habit"
```

---

### Task 3: A per-scene environment instead of one global backdrop

**Files:**
- Modify: `src/lib/video/scenes/types.ts` (`Environment`, `Scene.environment`)
- Modify: `src/lib/video/scenes/director.ts` (schema + prompt)
- Modify: `src/lib/video/scenes/validate.ts` (resolve/repair `environment`)
- Modify: `src/lib/video/composition/build.ts` (the environment layer, its CSS and its driver)
- Modify: `tests/scenes.test.mts`, `tests/composition.test.mts`

**Interfaces:**
- Produces: `export type Environment = "void" | "dawn" | "dusk" | "storm" | "deep" | "paper" | "grid" | "warm"`, `Scene.environment?: Environment`, and `environmentKeys(scenes: Scene[], shift: number): (Keyed & { env: Environment })[]` exported from `src/lib/video/composition/highlight.ts`'s sibling — put it in `build.ts` beside `glowKeys`, which it generalises.

**Design.** `#scene-glow` already varies per scene by `scene.tone` via `glowKeys` — the mechanism exists and is simply too weak to see. Generalise it: each environment is a full-frame gradient + atmosphere, crossfaded scene to scene on **one** element pair (A/B), so only one tween per element per window and seek-safety is preserved. The theme still supplies the palette the environments are tinted from, so a video keeps one visual identity while its environment evolves.

- [ ] **Step 1: Write the failing test**

Add to `tests/composition.test.mts`:

```ts
test("each scene carries its own environment, and the crossfades never overlap", () => {
  const theme = bookThemeById("marginalia");
  const base = fixtureInput({ theme, withScenes: true }) as unknown as CompositionInput;
  const scenes = (base.scenes as Scene[]).map((s, i) => ({ ...s, environment: (["void", "dawn", "storm", "deep"] as const)[i % 4] }));
  const html = buildComposition({ ...base, scenes, bookTitle: "T" });
  const data = JSON.parse(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]) as {
    env: { t: number; d: number; env: string }[];
  };
  assert.ok(data.env.length >= 3, "the environment actually changes through the video");
  for (let i = 1; i < data.env.length; i++) {
    assert.ok(data.env[i - 1].t + data.env[i - 1].d <= data.env[i].t + 1e-9, "two environment crossfades never run at once");
  }
  assert.ok(html.includes('id="env-a"') && html.includes('id="env-b"'), "two layers, so one can fade over the other");
});

test("a photo episode has no environment layer at all", () => {
  const html = buildComposition({ ...(fixtureInput({ theme: bookThemeById("marginalia") }) as unknown as CompositionInput), bookTitle: "T" });
  assert.ok(!html.includes('id="env-a"'));
  const data = JSON.parse(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]) as { env: unknown[] };
  assert.deepEqual(data.env, []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — `data.env` is undefined.

- [ ] **Step 3: Add the type and let the director choose it**

In `types.ts` add the `Environment` union and `Scene.environment?: Environment`. In `director.ts` add `environment: { type: "string", enum: [...ENVIRONMENTS] }` to the item schema, and to `DIRECTOR_SYSTEM` add a short section naming what each environment is for, with the instruction that the environment must follow the meaning of the sentence and that consecutive scenes should not all share one.

In `validate.ts`, resolve it: keep the director's choice when valid; otherwise derive it from the scene's tone (the existing `SceneTone`) so there is always a value. Never leave it undefined on a cinematic or page scene.

- [ ] **Step 4: Render the environment layer**

In `build.ts`, beside `glowKeys`, add `environmentKeys(scenes, shift)` which emits one entry per environment **change** (not per scene), clipping each entry's duration to end before the next starts — the same discipline `cardZooms`/`dimKeys` already use.

Add two stacked full-frame layers inside the scene clip, before the card:

```ts
      ${scenes.length ? `<div class="env" id="env-a"></div><div class="env" id="env-b"></div>` : ""}
```

Their CSS defines one gradient per environment as a class (`.env-void`, `.env-dawn`, …), each built from the theme's own palette roles so a theme keeps its identity — no literal colours, which `tests/scenes.test.mts` already refuses. In the timeline, alternate A/B: set the incoming layer's class, then one `tl.to` opacity tween per crossfade, alternating which layer receives it so no element gets two overlapping tweens.

- [ ] **Step 5: Run the tests**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts tests/scenes.test.mts && npx tsc --noEmit`
Expected: PASS, tsc silent.

- [ ] **Step 6: Prove seek-safety**

Run: `node --import tsx scripts/e2e-seek.mjs`
Expected: `Seek-safe: 5 theme(s) × 24 timestamps.`

- [ ] **Step 7: Commit**

```bash
git add src/lib/video/scenes src/lib/video/composition/build.ts tests/composition.test.mts tests/scenes.test.mts
git commit -m "feat(video): a per-scene environment, so the background follows the meaning"
```

---

### Task 4: Measure text instead of estimating it

**Files:**
- Modify: `src/lib/video/composition/build.ts` (a `fitText` pass in the timeline JS)
- Modify: `tests/frame-live.test.mts`

**Interfaces:**
- Produces: a `fitText()` routine run once at timeline init, before any frame is captured, that shrinks a text element's font-size until it fits its own box.

**Why in the browser.** The server cannot know the rendered width of a string: `fitSize()` is `max − chars × per`, a guess, and it is the root cause of split, clipped and overlapping text. The browser knows exactly. Running the fit once at init — not in a tween — keeps it out of the seek path entirely.

- [ ] **Step 1: Write the failing test**

Add to `tests/frame-live.test.mts`:

```ts
test("no text element overflows its own box, at any sampled instant (live browser)", async () => {
  const theme = bookThemeById("editorial");
  const html = buildComposition({ ...(fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput), bookTitle: "A Fixture Book" });
  await withComposition(html, async (page) => {
    const duration = await page.evaluate(() => (window as unknown as { __tl: { duration(): number } }).__tl.duration());
    for (let i = 0; i < 12; i++) {
      const t = (duration * (i + 0.5)) / 12;
      const bad = await within(page.evaluate((time) => {
        (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl.seek(time, false);
        const out: string[] = [];
        document.querySelectorAll(".sc-kinetic, .sc-quote-text, .cine-key, .caption-line, .hook-text").forEach((el) => {
          const e = el as HTMLElement;
          const cs = getComputedStyle(e);
          if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return;
          // Overflow of the element's own content box is the defect: clipped or spilling type.
          if (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2) {
            out.push(`${e.className}: content ${e.scrollWidth}x${e.scrollHeight} vs box ${e.clientWidth}x${e.clientHeight}`);
          }
        });
        return out;
      }, t), 30_000, `overflow at ${t}`);
      assert.deepEqual(bad, [], `at t=${t.toFixed(2)}s`);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame-live.test.mts`
Expected: FAIL on at least one element, naming its overflow — that is the defect this task fixes.

- [ ] **Step 3: Implement the fit**

In the timeline JS in `build.ts`, before the timeline is registered, add:

```js
  // Type sizes from the server are estimates (character counts); the browser is
  // the only thing that knows the real width. Shrink until it fits, once, before
  // any frame is captured. Not a tween: it never participates in a seek.
  function fitText(el, minPx) {
    if (!el) return;
    var size = parseFloat(getComputedStyle(el).fontSize) || 0;
    var guard = 0;
    while (guard++ < 40 && size > minPx && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      size = Math.max(minPx, Math.floor(size * 0.94));
      el.style.fontSize = size + "px";
    }
  }
  [".sc-kinetic", ".sc-quote-text", ".cine-key", ".cine-hook", ".caption-line", ".hook-text"].forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) { fitText(el, 28); });
  });
```

Each of those elements needs a bounded box for `scrollWidth`/`clientWidth` to mean anything — give the ones that currently size to their content an explicit `max-width`/`max-height` from the frame grid, so "fits" is defined.

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame-live.test.mts tests/composition.test.mts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/video/composition/build.ts tests/frame-live.test.mts
git commit -m "fix(video): measure text in the browser instead of guessing its size"
```

---

### Task 5: The two point defects

**Files:**
- Modify: `src/lib/video/scenes/render.ts` (line ~285, the quote reference)
- Modify: `src/lib/video/scenes/cine-runtime.js` (the `mountain` builder's flag)
- Modify: `tests/scenes.test.mts`

- [ ] **Step 1: Write the failing tests**

```ts
test("a quote shows the book's words, not a page number label", () => {
  const r = renderScene(sceneOf("quote", { quote: { text: "What stands in the way becomes the way", page: 16 } }), RECT, ACCENT)!;
  assert.doesNotMatch(r.markup, /page\s*17/i, "the PAGE label is not part of the design");
  assert.doesNotMatch(r.markup, /sc-quote-ref/);
  assert.match(r.markup, /What stands in the way/);
});
```

For the flag, assert the builder has the parts that make it read as fabric on a pole — a pole mesh and a deforming plane:

```ts
test("the mountain's flag is fabric on a pole, not a floating triangle", () => {
  const src = cineRuntimeSource();
  const body = src.slice(src.indexOf("HEROES.mountain"), src.indexOf("HEROES.", src.indexOf("HEROES.mountain") + 10));
  assert.match(body, /pole/i, "there is a pole");
  assert.match(body, /PlaneGeometry|flagPos|needsUpdate/, "the flag has vertices that move");
  assert.match(body, /Math\.sin/, "the cloth is driven by a wave, not static");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/scenes.test.mts`
Expected: FAIL on both.

- [ ] **Step 3: Remove the page label**

Delete the `.sc-quote-ref` div from the quote template in `render.ts` and its CSS rule, and renumber the remaining `data-el` indices and their anims so they stay contiguous. Check `overlappingAnims` still returns `[]` for a quote scene.

- [ ] **Step 4: Rebuild the flag**

In `cine-runtime.js`'s `mountain` builder, replace the floating triangle with: a thin pole (a `lathe()` column — **not** `CylinderGeometry`), and a flag made from a `PlaneGeometry` whose vertices are displaced in `update(t, p)` by a travelling sine so it ripples, attached at the pole edge (x = 0 vertices pinned, displacement scaling with x). Give it `side: T.DoubleSide` and recompute normals so the lighting reads as cloth.

- [ ] **Step 5: Run the tests, and prove the hero still paints**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/scenes.test.mts tests/cinematic.test.mts && npx tsc --noEmit`
Expected: PASS, including the existing live-browser hero-paints check.

- [ ] **Step 6: Commit**

```bash
git add src/lib/video/scenes tests/scenes.test.mts
git commit -m "fix(scenes): drop the page-number label and make the summit flag behave like cloth"
```

---

### Task 6: Validate on three real videos

**Not delegated — the controller runs this.** It needs the dev server, a temporary database session, and an aesthetic judgement on rendered frames.

- [ ] Run the full suite and the seek harness; compare against the baseline.
- [ ] Generate three episodes on substantially different subjects (time management; focus/attention; money or self-improvement), from the existing test books.
- [ ] For each: confirm duration is 45–90 s, record generation time, and extract frames at every scene.
- [ ] Verify against rendered output, not code: backgrounds differ by scene and between videos; visuals match the narration; text is readable throughout; highlights are positioned and visible; no page label; captions still in sync; grounding intact.
- [ ] Report honestly which claims the rendered output supports and which it does not.
