import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME,
  BANDS,
  TEXT_BANDS,
  RESERVED,
  CONTENT_WIDTH,
  CONTENT_X,
  bandBox,
  overlaps,
  gridViolations,
  type BandName,
} from "../src/lib/video/composition/frame";

test("the bands run down the frame in order, never touching", () => {
  const order: BandName[] = ["progress", "title", "stage", "caption"];
  let prevBottom = -1;
  for (const name of order) {
    const b = BANDS[name];
    assert.ok(b.top > prevBottom, `${name} starts below the band above it`);
    assert.ok(b.bottom > b.top, `${name} has height`);
    assert.ok(b.bottom <= FRAME.height, `${name} is inside the frame`);
    prevBottom = b.bottom;
  }
});

test("no band that carries TEXT reaches a region the platforms cover with their own UI", () => {
  for (const name of TEXT_BANDS) {
    for (const r of RESERVED) {
      assert.equal(overlaps(bandBox(name), r.box), false, `the ${name} band overlaps ${r.name}`);
    }
  }
});

test("content is narrow enough to clear the action rail, and stays centred", () => {
  const rail = RESERVED.find((r) => r.name === "action-rail")!;
  assert.equal(CONTENT_X + CONTENT_WIDTH, rail.box.x, "content ends exactly where the rail begins");
  assert.equal(CONTENT_X, FRAME.width - (CONTENT_X + CONTENT_WIDTH), "equal margins either side");
});

test("a two-line caption fits its band and still clears the page card", () => {
  // 60px type, 1.2 line-height, 16px padding top and bottom.
  const twoLines = 60 * 1.2 * 2 + 32;
  const caption = BANDS.caption;
  assert.ok(twoLines <= caption.bottom - caption.top, `two lines (${twoLines}px) fit the caption band`);
  assert.ok(caption.bottom - twoLines > BANDS.stage.bottom, "a two-line caption starts below the stage");
});

test("gridViolations names what is wrong, and says nothing when all is well", () => {
  assert.deepEqual(gridViolations([{ name: "caption", box: bandBox("caption") }]), []);

  const sunk = gridViolations([{ name: "caption", box: { x: 130, y: 1700, w: 820, h: 100 } }]);
  assert.equal(sunk.length, 1);
  assert.match(sunk[0], /caption.*reels-bottom/);

  const wide = gridViolations([{ name: "caption", box: { x: 130, y: 1400, w: 900, h: 100 } }]);
  assert.match(wide[0], /caption.*action-rail/);

  const clash = gridViolations([
    { name: "byline", box: { x: 0, y: 300, w: 100, h: 100 } },
    { name: "caption", box: { x: 50, y: 350, w: 100, h: 100 } },
  ]);
  assert.match(clash[0], /byline.*overlaps.*caption/);

  const outside = gridViolations([{ name: "stray", box: { x: -10, y: 300, w: 50, h: 50 } }]);
  assert.match(outside[0], /stray.*outside the frame/);
});

test("touching edges are not an overlap", () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }), true);
});
