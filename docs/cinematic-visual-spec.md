# Cinematic BookReel — visual reference analysis and design spec

Source: the 10 clips in `Referances/` (4.9–32 s each, 132 s total, ~550×970 screen recordings; player UI ignored). Studied as *look and craft only*; nothing here copies their content or assets. Method: contact sheets of every clip, shot-change detection, mean luma/saturation, and per-second motion energy (mean frame difference). Audio was measured for loudness only, not listened to. Clips are short, so they say nothing about how to structure 60–120 s; that is inferred.

Clips are numbered V01–V10 in file-time order.

| ID | Len | Audio | Look | What to learn |
|---|---|---|---|---|
| V01 | 4.9 s | none | Low-key macro hourglass, teal glow, blurred grey background | One hero, one accent, shallow focus; almost static |
| V02 | 10.2 s | −14.5 LUFS | Clock inside a gold/blue particle vortex | Spiral leading lines; a morph that keeps rotating; ~1 s settled hold at the end |
| V03 | 10.4 s | none | Amber backlit orrery, engraved orbit line-art | Parallax by scale, line-art laid over 3D bodies, steady slow drift |
| V04 | 20.1 s | −14.1 LUFS | Hand holding a globe, camera carries it out into a galaxy | One continuous scale-shift; motion peaks, settles, then returns |
| V05 | 7.1 s | none | Open book releasing a helix of 3D letters, grey studio | Closest book reference; sustained push-in |
| V06 | 13.2 s | none | "LIFE" drawn as a clock, red hand sweeping | Type as the metaphor; palette inverts at ~7 s and back at ~13 s |
| V07 | 8.3 s | −14.2 LUFS | Black stage, batter hits ball, CHANCE becomes CHANGE | A wordplay enacted physically; bloom saved for the payoff |
| V08 | 6.6 s | none | Glowing silhouette climbing a staircase of words, "PAST" ball and chain | Abstract idea as a physical object; the world scrolls, the subject stays |
| V09 | 32.4 s | −14.3 LUFS | Vector figures on black→green gradient, then rapid word cards | Pacing that accelerates; its near-motionless opening is the cautionary example |
| V10 | 19.5 s | −16.1 LUFS | Black-and-white cut-out collage, type tucked behind subjects | Layered type, rack-focus transitions, three-stage text builds |

## Rules every strong clip obeys

1. **One idea, one hero, one accent colour.** Mean saturation is 1–12 of 255 in nine clips: near-monochrome with a single hue used sparingly.
2. **The hero is on screen at frame 0 and moving.** 9 of 10 clips do this; V09 opens on a motionless figure for ~9 s (frame difference ≤0.1 apart from one slide at ~4 s) and is the outlier.
3. **The abstract word becomes a physical object doing a physical verb** (time → hourglass; progress → staircase climbed; past → dragged ball and chain).
4. **Type is an object in the scene,** not a subtitle laid on top: extruded, built into the picture, occluded, struck, climbed.
5. **Nothing cinematic is dead-static.** Every 3D/photographic shot has slow continuous camera or subject motion.
6. **Depth comes from layering,** never from a flat plane: blurred background, subject, foreground particles or type.
7. **Light is motivated:** one rim or key light, or soft studio light, never flat fill.
8. **Pacing is hold-and-burst,** not constant motion.

## Spec by area

**Opening hook**
- Frame 0 carries the hero and a short claim: a small lead-in line plus a 1–3 word keyword (V07, V10).
- The first visible *event* (an action, morph or reveal) lands at 1.0–2.5 s.
- No slow build or motionless establishing hold (V09 shows what not to do).

**Composition (9:16)**
- Text zone in the upper third (V07, V10 at ~15–30% height); subject in the lower-middle; 35–60% of the frame left as quiet space (V07, V08).
- Use vertical leading lines (helix, staircase, stack) and spirals or diagonals for energy (V02, V03).
- A single dominant subject per shot, centred or on a clear third.

**Lighting**
- Low-key (mean luma 24–63 of 255) in six clips: one rim/edge light plus an emissive accent.
- Complementary warm/cool pairs: amber on navy, gold on blue, skin-orange on cosmic blue, teal on grey.
- High-key (luma 150–180) in three clips: soft studio light, large soft cast shadows, and a visible vignette with darker corners (V10).
- Bloom and glow are saved for the payoff or the hero (V07's swapped letter, V08's silhouette halo).

**Camera**
- Default: slow continuous drift (V01 barely moves, motion 0.3; V03 steady, 1.7). Recommended ~1–3% scale across a shot.
- Emphasis: a sustained push-in, about 1.5–2× over ~5 s read from frames (V05, which then resets).
- Orbit or rotation for spirals (V02); follow the subject by moving the world instead (V08).
- Figures marked "recommended" or "read from frames" are estimates; exact scale changes were not measured.
- Never a locked frame for more than ~1 s on a cinematic scene. Graphic/typographic scenes (V06, V07) stay locked but animate objects.

**Depth and 3D**
- At least three planes per cinematic scene: soft background, subject, foreground particles or type.
- Parallax by scale and speed, roughly 1 : 2 : 4 (V03: near planet ≈3× the far ones).
- Occlusion: type placed *behind* the subject's legs or a cloud (V10).
- Atmosphere: dust or particles, cloud, radial light rays (V09), contact shadows and floor reflection (V01, V06).
- 3D objects get soft physically plausible light, not flat colour (V05, V03).

**Motion graphics**
- Particle swirls and debris on impact; concentric ripple rings around a hero (V04); ghost-echo trails (V08).
- Fine line-art orbits or grids over the scene (V03; V10's faint grid).
- A sweeping hand or timer as the heartbeat (V06); neon ring around the one accent object (V08).
- Each scene uses one motion vocabulary (spiral, ascent, or impact), not several.

**Typography**
- Two tiers: lead-in at ~25–30% of the keyword's size in regular weight, keyword heavy; 1–3 words.
- Heavy grotesque sans (V07, V09, V10) or heavy condensed (V06); serif only on the 3D book letters (V05).
- Accent colour on a single glyph or word (V07's red C, V06's red hand).
- Lists: at most three lines with a glyph bullet, each appearing ~1 s apart (V10).
- Word stacks fade by distance from the subject (V08); single-word cards use a letter-spaced reveal (V09).
- 3D-letter scenes (V05) are texture, not message: keep the actual message legible elsewhere.

**Scene transitions** (most frequent first)
1. **Continuity morph:** the same hero changes while the motion keeps going (V02 at ~3.5 s, all of V04).
2. **Rack-focus:** blur out then in, ≈0.2–0.5 s (V10, several times: roughly 1 s, 6–7 s, 12 s and 14–15 s).
3. **Palette inversion:** a full theme flip inside ~1 s, returning at the end (V06).
4. **Lateral slide** of the old subject out and the new one in (V09 at ~4 s).
5. **Hard cut,** used only to raise tempo (V09 from 25 s on).
- Dissolves stay under 0.5 s; zero to three real cuts per 10 s outside an accelerating montage.

**Pacing**
- One visual idea per 3–6 s; each scene gets setup ~2–3 s → event ~1 s → resolve/hold 1–2 s.
- Motion curves seen: steady (V03, V06, V08), peak–lull–second wave (V04: 3.9 → 0.5 → 1.7), hold-and-burst (V07, V10), accelerating montage (V09: motion 1.8→8.7, shots 1–2 s).
- Hold the final frame ~0.7–1 s with motion settled (V02).
- For a 60–120 s video: strong hook scene (≤4 s), 4–8 s idea scenes each with one event, accelerate into a 10–15 s montage near the call to action, end on a hold. (Inferred, not measured.)

**Concept-to-visual matching**
- Five patterns: a literal object for an abstract noun (hourglass, clock, orrery, staircase, ball and chain, boats, chess queen); a wordplay enacted physically (CHANCE→CHANGE); a letterform pun (LIFE = clock); a scale shift for importance (hand → cosmos); many-versus-one repetition (a crowd of small boats against one large).
- Rule: match the *claim of the sentence*, not its topic keywords. For each beat define one hero object plus one physical verb (rise, climb, strike, drag, spin, fall).

**Book / real-world presentation**
- Book as ground plane: V05 puts the open book in the bottom third on a soft shadow with fanned pages, and the content rises out of it.
- Real-world scale in one clip (V04's hand) gives intimacy; skin-texture realism is out of reach for us.
- For BookReel: the book's own scanned page, tilted, with curl, a soft contact shadow and a light sweep; highlighted words lift off the page and become the kinetic text; the book returns as the ground plane in at least three scenes.

## Fit with the current system (read-only survey)

- **Already there:** 10 scene templates (kinetic text, book page and crop, quote, icons, comparison, steps, growth curve, timeline, stat); five themes; page depth drift, light sweep, scene glow, crop zoom; Three.js primitives and Lottie accents.
- **Gaps:** scene-to-scene transitions (morph, rack-focus, palette flip); type occluded by a subject; a hero-object-plus-verb library beyond Tabler icons; particles and bloom; hold-and-accelerate pacing; a "words leave the page" effect.
- **Binding constraint:** no stock footage and no AI imagery (decision of 2026-09-28). V01–V04 are photoreal AI footage, so match their *lighting, depth and motion grammar* with procedural 3D, particles and the book's own imagery, not their pixels.
- **Feasibility is my estimate, not tested.** Straightforward with the current stack: rack-focus, palette flip, parallax layers, silhouette plus glow, type effects, drift and push. Needs new Three.js or CSS-3D work: extruded letters, vortex and orrery scenes, bloom. Avoid: photoreal people and hands (use silhouettes, vector figures or book imagery instead).
