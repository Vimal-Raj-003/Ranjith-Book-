import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import * as sidebarModule from "../src/components/Sidebar";
import * as inspectorModule from "../src/components/Inspector";
import { RailToggle, readFlag, writeFlag } from "../src/components/ui";
import { strings } from "../src/lib/strings";

/* ===========================================================================
 * The collapsible workspace shell
 *
 * The operator's complaint was that the front end has "no collapsible things
 * for each section". What went in to answer it is mostly layout, and layout is
 * checked in a browser (`scripts/e2e-shell.mjs`). What is checked HERE is the
 * part a screenshot cannot see and a refactor can quietly break: that the
 * toggles are real buttons with `aria-expanded`, that a folded rail still says
 * what it is hiding, that nothing uses the `disabled` attribute, and that the
 * remembered state survives a browser with storage switched off.
 * ======================================================================== */

// The components are CJS/ESM default-export wrappers when loaded through tsx —
// the same unwrap `tests/client-ui.test.mts` does.
function unwrap(mod: unknown): React.ComponentType<Record<string, unknown>> {
  const d = (mod as { default: unknown }).default as { default?: unknown };
  return (d?.default ?? d) as React.ComponentType<Record<string, unknown>>;
}
const Sidebar = unwrap(sidebarModule);
const Inspector = unwrap(inspectorModule);

const render = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/**
 * The sidebar calls `useRouter()` (it navigates to /login after signing out),
 * and that throws "invariant expected app router to be mounted" outside an app
 * route. The context is provided here rather than reaching for a module mock:
 * it is one object, it is what Next itself puts there, and it keeps the
 * component under test exactly as it ships.
 */
const ROUTER = {
  push: () => {}, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: () => {},
} as unknown as React.ContextType<typeof AppRouterContext>;

function sidebar(props: Record<string, unknown>): string {
  return render(
    React.createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      React.createElement(Sidebar, { view: "studio", onView: () => {}, email: "a@b.test", ...props }),
    ),
  );
}

function inspector(props: Record<string, unknown>): string {
  return render(React.createElement(Inspector, { episode: null, ...props }));
}

/** Every `<button>` in a blob of markup. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

/* --- the toggles -------------------------------------------------------- */

test("a rail toggle is a real button carrying aria-expanded and a name", () => {
  const open = render(
    React.createElement(RailToggle, { rail: "side", expanded: true, label: "Sections rail", onToggle: () => {} }),
  );
  assert.match(open, /<button[^>]*type="button"/, "a real button, so Enter and Space work for free");
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-label="Sections rail"/);
  assert.match(open, /data-rail-toggle="side"/);
  // A disabled control drops out of the tab order; nothing in this shell may
  // use the attribute.
  assert.doesNotMatch(open, /\sdisabled[\s=>]/);

  const shut = render(
    React.createElement(RailToggle, { rail: "side", expanded: false, label: "Sections rail", onToggle: () => {} }),
  );
  assert.match(shut, /aria-expanded="false"/, "the state is on the button, not in its name");
  // The NAME must not move with the state. `aria-expanded` already says
  // "collapsed"/"expanded"; a name that also says it reads it twice, once as
  // an instruction and once as a fact.
  assert.match(shut, /aria-label="Sections rail"/);
});

test("the rail toggles are rendered from one position, open or shut", () => {
  // The defect this prevents: a rail that early-returns a different subtree
  // when collapsed unmounts the toggle and mounts a new one, so every click
  // drops keyboard focus to <body> and a screen reader never hears
  // `aria-expanded` change. Both rails keep it as the first child of
  // `.rail-top`, which exists either way.
  for (const html of [sidebar({ onToggleCollapsed: () => {} }), sidebar({ collapsed: true, onToggleCollapsed: () => {} })]) {
    const top = html.match(/<div class="rail-top">([\s\S]*?)<button/);
    assert.ok(top, "a .rail-top wrapper whose first element is the toggle");
    assert.equal(top[1].trim(), "", "nothing may come between .rail-top and its toggle");
  }
  for (const html of [inspector({ onToggleCollapsed: () => {} }), inspector({ collapsed: true, onToggleCollapsed: () => {} })]) {
    const top = html.match(/<div class="rail-top">([\s\S]*?)<button/);
    assert.ok(top, "the inspector does the same");
    assert.equal(top[1].trim(), "");
  }
});

test("a rail with no toggle handler renders no toggle, and still renders", () => {
  // The inspector is rendered without these props by two other test files and
  // by any caller that does not want a collapsible rail.
  const html = inspector({});
  assert.doesNotMatch(html, /data-rail-toggle/);
  assert.match(html, /Settings/);
});

/* --- the folded rails --------------------------------------------------- */

test("a folded sections rail keeps every section, named", () => {
  const html = sidebar({ collapsed: true, onToggleCollapsed: () => {} });
  for (const label of [strings.nav.studio, strings.nav.books, strings.nav.library, strings.nav.freeBooks]) {
    assert.ok(
      html.includes(`aria-label="${strings.layout.goTo(label)}"`),
      `${label} must still be reachable, and named, from the folded rail`,
    );
  }
  // The current section is still announced as current.
  assert.match(html, /data-view="studio"[^>]*aria-current="page"/);
});

test("a folded settings rail says what each group holds without being opened", () => {
  const html = inspector({ collapsed: true, onToggleCollapsed: () => {} });
  // No setting has been read in a server render, so each summary is its
  // "nothing known yet" form — which is exactly what must be carried through.
  for (const summary of [strings.themePanel.summaryUnknown, strings.voicePanel.summaryUnknown, strings.musicPanel.summaryUnknown]) {
    assert.ok(
      html.includes(`aria-label="${strings.layout.openSettingsFor(summary)}"`),
      `the folded rail must carry "${summary}" as a chip name`,
    );
  }
  assert.ok(html.includes(`title="${strings.thumbnails.summary(0)}"`), "and the thumbnail count");
});

test("the folded settings rail offers a real download, and only for a finished video", () => {
  const done = {
    id: "e1", bookTitle: "B", title: "T", status: "DONE", step: "DONE", error: null, notes: [],
    partNumber: 1, seriesTotal: 1, hasVideo: true, startedAt: null, finishedAt: null, totalMs: null,
  };
  const html = inspector({ episode: done, collapsed: true, onToggleCollapsed: () => {} });
  assert.match(html, /<a href="\/api\/episodes\/e1\/video" download/, "a real link, not a chip that reopens the rail");

  const unfinished = inspector({ episode: { ...done, hasVideo: false }, collapsed: true, onToggleCollapsed: () => {} });
  assert.doesNotMatch(unfinished, /download/, "nothing to download is shown as nothing, never as a dead control");
});

test("both shapes of each rail are in the markup, with the inactive one hidden", () => {
  // This is what keeps the toggle mounted AND what stops the Voice and Music
  // disclosures resetting to their defaults every time a rail is folded:
  // `hidden` removes a subtree from layout, the tab order and the
  // accessibility tree without destroying it.
  const open = sidebar({ onToggleCollapsed: () => {} });
  assert.match(open, /<nav[^>]*class="rail-strip-nav"[^>]*hidden/, "the folded strip is present but hidden");
  assert.doesNotMatch(open, /<nav class="side-nav"[^>]*hidden/, "the full nav is not");

  const shut = sidebar({ collapsed: true, onToggleCollapsed: () => {} });
  assert.match(shut, /class="side-nav"[^>]*hidden/, "and the other way round when folded");

  const inspOpen = inspector({ onToggleCollapsed: () => {} });
  assert.match(inspOpen, /class="rail-strip-chips"[^>]*hidden/);
  assert.doesNotMatch(inspOpen, /class="insp-groups"[^>]*hidden/);
  const inspShut = inspector({ collapsed: true, onToggleCollapsed: () => {} });
  assert.match(inspShut, /class="insp-groups"[^>]*hidden/);
});

/* --- aria-disabled, never disabled -------------------------------------- */

test("nothing in the sidebar uses the disabled attribute", () => {
  for (const props of [{ onToggleCollapsed: () => {} }, { collapsed: true, onToggleCollapsed: () => {} }]) {
    const html = sidebar(props);
    for (const b of buttons(html)) {
      assert.doesNotMatch(b, /\sdisabled[\s=>]/, `a disabled control drops keyboard focus: ${b.slice(0, 90)}`);
    }
  }
});

test("Queue is offered, refused with aria-disabled, and still reachable by keyboard", () => {
  const open = sidebar({ onToggleCollapsed: () => {} });
  const queue = open.match(/<button[^>]*data-view="queue"[^>]*>/)?.[0];
  assert.ok(queue, "Queue is listed — the operator asked to see where the app is going");
  assert.match(queue, /aria-disabled="true"/);
  assert.doesNotMatch(queue, /\sdisabled[\s=>]/);
  assert.ok(open.includes(strings.nav.comingSoonHint), "and it says why");

  const shut = sidebar({ collapsed: true, onToggleCollapsed: () => {} });
  const chip = shut.match(/<button[^>]*data-view="queue"[^>]*>/)?.[0];
  assert.ok(chip && /aria-disabled="true"/.test(chip) && !/\sdisabled[\s=>]/.test(chip), "folded too");
});

test("Sign out refuses a second click with aria-disabled rather than losing focus", () => {
  const html = sidebar({ onToggleCollapsed: () => {} });
  const signOut = html.match(/<button[^>]*>\s*Sign out\s*<\/button>/)?.[0];
  assert.ok(signOut, "a Sign out button");
  assert.match(signOut, /aria-disabled="false"/, "idle, so not refused — but the attribute is the mechanism");
  assert.doesNotMatch(signOut, /\sdisabled[\s=>]/);
});

/* --- the remembered rail state ------------------------------------------ */

test("a remembered flag survives a browser with storage switched off", () => {
  // These tests run in node, where `window` does not exist at all — which is
  // the same code path as a browser that throws on `localStorage` (private
  // mode, storage blocked by policy). The point of the in-memory fallback is
  // that not being able to REMEMBER the choice must not stop making it.
  assert.equal(readFlag("bookreel.test.unset"), null, "an unset flag is null, not a guessed default");

  writeFlag("bookreel.test.rail", true);
  assert.equal(readFlag("bookreel.test.rail"), "1");
  writeFlag("bookreel.test.rail", false);
  assert.equal(readFlag("bookreel.test.rail"), "0", "and the second write wins");

  // Two keys do not share a slot.
  writeFlag("bookreel.test.other", true);
  assert.equal(readFlag("bookreel.test.rail"), "0");
  assert.equal(readFlag("bookreel.test.other"), "1");
});

test("the shell's layout copy is in the strings module", () => {
  for (const key of ["sectionsRail", "settingsRail", "toggleSections", "toggleSettings"] as const) {
    assert.equal(typeof strings.layout[key], "string", `strings.layout.${key}`);
  }
  assert.equal(typeof strings.layout.goTo("Library"), "string");
  assert.equal(typeof strings.layout.openSettingsFor("Voice · Charles"), "string");
  assert.equal(typeof strings.themePanel.summary("Dark Academia"), "string");
  assert.equal(strings.themePanel.summary("Dark Academia"), "Theme · Dark Academia");
  assert.equal(strings.books.listSummary(0), "Your books · none yet");
  assert.equal(strings.books.listSummary(1), "Your books · 1");
  assert.equal(strings.books.listSummary(17), "Your books · 17");
});
