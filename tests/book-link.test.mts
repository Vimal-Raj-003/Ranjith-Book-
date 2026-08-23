import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBookLink,
  appendBookLink,
  BOOK_LINK_PREFIX,
  MAX_BOOK_LINK_LENGTH,
} from "../src/lib/content/book-link";

test("a real web link is kept, and normalised rather than echoed back", () => {
  assert.equal(normalizeBookLink("https://example.com/book"), "https://example.com/book");
  assert.equal(normalizeBookLink("http://example.com/book"), "http://example.com/book");
  assert.equal(
    normalizeBookLink("  https://example.com/book?ref=bookreel  "),
    "https://example.com/book?ref=bookreel",
    "surrounding whitespace from a paste is trimmed, not stored",
  );
  assert.equal(
    normalizeBookLink("HTTPS://Example.com/Book"),
    "https://example.com/Book",
    "the scheme and host are case-insensitive; the path is not and must survive",
  );
});

/**
 * The whole point of the allow-list. This value is typed by hand and then
 * rendered into an HTML video composition and a public description — a
 * `javascript:` or `data:` URL reaching either is a script in someone else's
 * page, not a broken link.
 */
test("anything that is not an http(s) URL is refused", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/book.pdf",
  ]) {
    assert.equal(normalizeBookLink(bad), null, `${bad} must not be stored`);
  }
});

test("a bare word, a relative path or an empty field is absent, not an empty string", () => {
  for (const bad of ["", "   ", "\t\n ", "atomichabits", "example.com/book", "/books/1", "//evil.example"]) {
    assert.equal(normalizeBookLink(bad), null, `${JSON.stringify(bad)} is not a link`);
  }
});

/**
 * `form.get()` returns `FormDataEntryValue | null` — a File if someone posts
 * one under this name. The validator takes `unknown` precisely so the ingest
 * path never has to guess.
 */
test("a non-string field is absent, not a crash", () => {
  assert.equal(normalizeBookLink(null), null);
  assert.equal(normalizeBookLink(undefined), null);
  assert.equal(normalizeBookLink(42), null);
  assert.equal(normalizeBookLink({ href: "https://example.com" }), null);
  assert.equal(normalizeBookLink(new File([], "x.jpg")), null);
});

test("an absurdly long link is refused rather than carried into the description", () => {
  const huge = `https://example.com/${"a".repeat(MAX_BOOK_LINK_LENGTH)}`;
  assert.equal(normalizeBookLink(huge), null);
});

/**
 * The stored value is embedded in HTML by the composition. Whatever quoting
 * the eventual template picks, the link itself must not be able to close an
 * attribute or open a tag.
 */
test("a link with HTML-significant characters cannot break out of an embedding", () => {
  const hostile = normalizeBookLink(`https://example.com/x"><script>alert(1)</script>`);
  assert.ok(hostile, "it is still a valid https URL, so it is kept — but neutered");
  for (const ch of ['"', "'", "<", ">", "`"]) {
    assert.ok(!hostile.includes(ch), `the stored link still contains ${ch}`);
  }

  const quoted = normalizeBookLink("https://example.com/it's-a-book");
  assert.ok(quoted && !quoted.includes("'"), "an apostrophe would end href='...'");

  // The same guarantee has to hold once it is inside the description, since
  // that string is what the description card renders.
  const described = appendBookLink("A description.", `https://example.com/'"<>\``);
  for (const ch of ['"', "'", "<", ">", "`"]) {
    assert.ok(!described.includes(ch), `the description carries a raw ${ch}`);
  }
});

test("with a link, the description ends with it", () => {
  const out = appendBookLink("Why the two-minute rule works.", "https://example.com/book");

  assert.ok(out.startsWith("Why the two-minute rule works."), "the writer's description is untouched");
  assert.ok(out.endsWith("https://example.com/book"), "the link is the last thing in the description");
  assert.ok(out.includes(BOOK_LINK_PREFIX), "the link is introduced, not dropped in bare");
  assert.equal(out.split("https://example.com/book").length - 1, 1, "the link appears exactly once");
});

test("with no link, there is no line and no placeholder", () => {
  const description = "Why the two-minute rule works.";

  assert.equal(appendBookLink(description, null), description);
  assert.equal(appendBookLink(description, ""), description);
  assert.equal(appendBookLink(description, "   "), description);
  assert.ok(
    !appendBookLink(description, null).includes(BOOK_LINK_PREFIX),
    "an empty 'Get the book:' advertises a missing thing to every viewer",
  );
});

/**
 * Validated at the boundary AND here. The database can hold a row written by
 * an older build, a migration, or a path that has not been written yet — the
 * description must be safe regardless of how the value got there.
 */
test("a hostile link that somehow reached storage still never reaches the description", () => {
  const description = "Why the two-minute rule works.";
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
    assert.equal(appendBookLink(description, bad), description, `${bad} was rendered anyway`);
  }
});

test("an empty description with a link is the link alone, with no leading blank lines", () => {
  const out = appendBookLink("", "https://example.com/book");
  assert.equal(out, `${BOOK_LINK_PREFIX} https://example.com/book`);
  assert.equal(out, out.trim());
});
