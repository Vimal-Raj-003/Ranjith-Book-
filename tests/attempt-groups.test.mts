import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { groupVideoAttempts, latestIdeaAttempt, videoIdentity } from "../src/lib/episodes/attempt-groups";
import { readAttemptHistory } from "../src/lib/episodes/attempt-history";
import { IdeaEpisodeVideo } from "../src/components/BookAnalysis";
import { AttemptHistoryList } from "../src/components/AttemptHistory";
import type { EpisodeState, IdeaView } from "../src/components/types";
import { prisma } from "../src/lib/db";
import { WORK_ROOT } from "../src/lib/paths";
import { requireIsolatedDatabase } from "./setup/isolation";

requireIsolatedDatabase("attempt grouping fixtures must not modify application data");
const stamp = (day: number) => `2026-11-${String(day).padStart(2, "0")}T09:00:00.000Z`;
const attempt = (id: string, day: number, extra = {}) => ({
  id, createdAt: stamp(day), startedAt: stamp(day), bookId: "book-a", contentIdeaId: "idea-a", kind: "idea", status: "FAILED", ...extra,
});

test("three failed episode rows produce one stable group with latest attempt and complete history", () => {
  const rows = [attempt("old", 1), attempt("latest", 5), attempt("middle", 3)];
  const before = structuredClone(rows);
  const groups = groupVideoAttempts(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].latest.id, "latest");
  assert.deepEqual(groups[0].previous.map((e) => e.id), ["middle", "old"]);
  assert.deepEqual(rows, before, "presentation never mutates source records");
  assert.equal(groupVideoAttempts([rows[0]])[0].key, groups[0].key);
});

test("different ideas, books and photo episodes stay separate even with identical titles", () => {
  const rows = [
    attempt("a", 1, { title: "Same title" }),
    attempt("b", 2, { title: "Same title", contentIdeaId: "idea-b" }),
    attempt("c", 3, { title: "Same title", bookId: "book-b" }),
    attempt("photo-a", 4, { title: "Same title", contentIdeaId: null, ideaKey: "shared", kind: "photo" }),
    attempt("photo-b", 5, { title: "Same title", contentIdeaId: null, ideaKey: "shared", kind: "photo" }),
  ];
  assert.equal(groupVideoAttempts(rows).length, 5);
});

test("legacy idea keys are book-scoped and missing identity falls back to episode ID", () => {
  assert.equal(groupVideoAttempts([attempt("a", 1, { contentIdeaId: null, ideaKey: "legacy" }), attempt("b", 2, { contentIdeaId: null, ideaKey: "legacy" })]).length, 1);
  assert.equal(groupVideoAttempts([{ id: "a" }, { id: "b" }]).length, 2);
  assert.notEqual(videoIdentity(attempt("a", 1)), videoIdentity(attempt("b", 1, { contentIdeaId: null, ideaKey: "idea-a" })));
});

test("retrying an older row selects its new attempt; metadata edits do not change latest attempt", () => {
  const newer = attempt("newer-row", 3, { updatedAt: stamp(9) });
  const retried = attempt("older-row", 1, { startedAt: stamp(5), status: "RUNNING" });
  assert.equal(groupVideoAttempts([newer, retried])[0].latest.id, retried.id);
  assert.equal(latestIdeaAttempt([newer, { ...retried, status: "QUEUED", startedAt: stamp(1), updatedAt: stamp(5) }])?.id, retried.id);
});

test("retry success and new episode attempts refresh one group without duplicate IDs", () => {
  const old = attempt("old", 1);
  const current = attempt("current", 3);
  const failed = groupVideoAttempts([old, current]);
  const successful = groupVideoAttempts([old, { ...current, status: "DONE" }, { ...current, status: "DONE" }]);
  assert.equal(successful.length, 1);
  assert.equal(successful[0].key, failed[0].key);
  assert.equal(successful[0].latest.status, "DONE");
  assert.equal(successful[0].attempts.length, 2);
  const generatedAgain = groupVideoAttempts([old, current, attempt("replacement", 5)]);
  assert.equal(generatedAgain.length, 1);
  assert.equal(generatedAgain[0].key, failed[0].key);
  assert.equal(generatedAgain[0].latest.id, "replacement");
});

test("stale list snapshots cannot replace a more recent live retry", () => {
  const live = attempt("retried", 1, { startedAt: stamp(5), updatedAt: stamp(5), status: "RUNNING" });
  const stale = attempt("retried", 1, { updatedAt: stamp(1), status: "FAILED" });
  const group = groupVideoAttempts([live, attempt("other-attempt", 3), stale])[0];
  assert.equal(group.latest.id, "retried");
  assert.equal(group.latest.status, "RUNNING");
});

const state = (id: string, status = "FAILED"): EpisodeState => ({
  ...attempt(id, 5), status, bookTitle: "Fixture book", title: "Same video", step: status === "DONE" ? "Rendering the video" : "Grounding check",
  error: status === "DONE" ? null : `error-${id}`, notes: [], partNumber: 1, seriesTotal: 1,
  hasVideo: status === "DONE", finishedAt: stamp(5), totalMs: 4000,
});

test("the reported episode has distinct sibling keys for its card and preview", () => {
  const id = "cmw3aluok00lrn61s4zo3oopk";
  const renderSlot = (episodes: IdeaView["episodes"]) => IdeaEpisodeVideo({
    idea: { id: "idea-key-fixture", episode: null, episodes } as IdeaView,
    states: {}, activeId: id, onSelect() {}, onState() {},
  });
  const keys = (slot: React.ReactElement<{ children: React.ReactNode }>) => {
    const result: (string | null)[] = [];
    React.Children.forEach(slot.props.children, (child) => {
      if (React.isValidElement(child)) result.push(child.key);
    });
    return result;
  };
  const row = attempt(id, 5);
  const first = keys(renderSlot([row]));
  assert.equal(first.length, 2, "one card and one preview are intentional siblings");
  assert.equal(new Set(first).size, 2, "siblings must not share the episode ID as their entire key");
  assert.ok(first.every((key) => key?.includes(id)), "keys remain tied to the episode, never array position");
  assert.deepEqual(keys(renderSlot([{ ...row, status: "RUNNING" }])), first, "progress updates retain component identity");
  assert.deepEqual(keys(renderSlot([row, attempt("old", 1), row])), first, "duplicate entries and reordered history do not duplicate or change sibling keys");
  const replacement = keys(renderSlot([row, attempt("replacement", 6)]));
  assert.equal(new Set(replacement).size, 2);
  assert.ok(replacement.every((key) => key?.includes("replacement")), "new attempts reset both components to the new episode");
});

test("duplicate episode entries still render exactly one main card and preview slot", () => {
  const row = attempt("latest", 5);
  const episodes = [row, attempt("old", 1), { ...row }];
  const before = structuredClone(episodes);
  const html = renderToStaticMarkup(React.createElement(IdeaEpisodeVideo, {
    idea: { id: "idea-a", episode: null, episodes } as IdeaView,
    states: { latest: state("latest", "DONE") }, activeId: "latest", onSelect() {}, onState() {},
  }));
  assert.equal((html.match(/data-idea-video=/g) ?? []).length, 1);
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
  assert.equal((html.match(/>Attempt History<\/summary>/g) ?? []).length, 1);
  assert.deepEqual(episodes, before, "rendering preserves attempt records");
});

test("actual book video slot renders one card, latest error, preview and collapsed Attempt History", () => {
  const idea = { id: "idea-a", episode: null, episodes: [attempt("old", 1), attempt("middle", 3), attempt("latest", 5)] } as IdeaView;
  const html = renderToStaticMarkup(React.createElement(IdeaEpisodeVideo, {
    idea, states: { old: state("old"), middle: state("middle"), latest: state("latest") }, activeId: "latest", onSelect() {}, onState() {},
  }));
  assert.equal((html.match(/data-idea-video=/g) ?? []).length, 1);
  assert.match(html, /data-idea-video="latest"/);
  assert.match(html, /error-latest/);
  assert.doesNotMatch(html, /error-old|error-middle/);
  assert.match(html, /<summary[^>]*>Attempt History<\/summary>/);
  assert.doesNotMatch(html, /<video\b/);
  const success = renderToStaticMarkup(React.createElement(IdeaEpisodeVideo, {
    idea, states: { latest: state("latest", "DONE") }, activeId: "latest", onSelect() {}, onState() {},
  }));
  assert.equal((success.match(/data-idea-video=/g) ?? []).length, 1);
  assert.match(success, /<video\b/);
  assert.match(success, /data-video-group="idea-a"/);
  assert.doesNotMatch(success, /error-latest/);
});

test("different idea slots with matching titles render distinct main cards", () => {
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...["one", "two"].map((id) =>
    React.createElement(IdeaEpisodeVideo, { key: id, idea: { id, episodes: [attempt(id, 1)], episode: null } as IdeaView,
      states: { [id]: state(id) }, activeId: null, onSelect() {}, onState() {} }))));
  assert.equal((html.match(/data-idea-video=/g) ?? []).length, 2);
});

test("history combines archived retries and older records without changing records or files", async () => {
  const book = await prisma.book.create({ data: { title: `History fixture ${randomUUID()}` } });
  try {
    const upload = await prisma.upload.create({ data: { bookId: book.id } });
    const old = await prisma.episode.create({ data: { bookId: book.id, uploadId: upload.id, kind: "idea", ideaKey: "shared", status: "FAILED", error: "older failure", createdAt: new Date(stamp(1)), startedAt: new Date(stamp(1)) } });
    const latest = await prisma.episode.create({ data: { bookId: book.id, uploadId: upload.id, kind: "idea", ideaKey: "shared", status: "DONE", videoPath: "fixture.mp4", createdAt: new Date(stamp(3)), startedAt: new Date(stamp(5)) } });
    await prisma.episode.create({ data: { bookId: book.id, uploadId: upload.id, kind: "idea", ideaKey: "different", title: latest.title } });
    const dir = path.join(WORK_ROOT, "generation-evidence", latest.id);
    await fs.mkdir(dir, { recursive: true });
    const snapshot = JSON.stringify({ reason: "before-retry", episode: { ...latest, startedAt: stamp(3), status: "FAILED", error: "prior retry failure" }, steps: [{ step: "Writing the script", status: "FAILED", durationMs: 100 }] });
    await fs.writeFile(path.join(dir, "retry.json"), snapshot);
    await fs.writeFile(path.join(dir, "duplicate-snapshot.json"), snapshot);
    await fs.writeFile(path.join(dir, "validation.json"), JSON.stringify({ error: { message: "extra evidence, not another attempt" } }));
    const before = await prisma.episode.findMany({ where: { bookId: book.id } });
    const result = await readAttemptHistory(old.id, "viewer");
    assert.equal(result?.latestEpisodeId, latest.id);
    assert.equal(result?.attempts.length, 2, "one older row and one archived retry, not duplicate snapshots");
    assert.deepEqual(result?.attempts.map((a) => a.error), ["prior retry failure", "older failure"]);
    const html = renderToStaticMarkup(React.createElement(AttemptHistoryList, { attempts: result!.attempts }));
    assert.match(html, /prior retry failure/);
    assert.match(html, /older failure/);
    assert.match(html, /Writing the script/);
    assert.deepEqual(await prisma.episode.findMany({ where: { bookId: book.id } }), before);
    assert.equal(await fs.readFile(path.join(dir, "retry.json"), "utf8"), snapshot);
    await fs.writeFile(path.join(dir, "broken.json"), "{");
    assert.equal((await readAttemptHistory(latest.id, "viewer"))?.incomplete, true);
  } finally { await prisma.book.delete({ where: { id: book.id } }); }
});

test("attempt history respects ownership and refuses unknown episodes", async () => {
  const user = await prisma.user.create({ data: { email: `history-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({ data: { title: "Private history" } });
  try {
    const upload = await prisma.upload.create({ data: { bookId: book.id } });
    const ep = await prisma.episode.create({ data: { bookId: book.id, uploadId: upload.id, userId: user.id } });
    assert.equal(await readAttemptHistory(ep.id, "another-user"), null);
    assert.equal(await readAttemptHistory("missing", user.id), null);
    assert.equal((await readAttemptHistory(ep.id, user.id))?.latestEpisodeId, ep.id);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
