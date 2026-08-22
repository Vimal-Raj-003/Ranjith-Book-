import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, isPublicAddress, isPublicUrl } from "../src/lib/media/fetch-guard";

/**
 * Every URL these guard functions see came out of somebody else's README, and
 * the server is what reaches out to it. The cloud metadata address is the one
 * that matters most: it is unauthenticated, it answers to anything that can
 * make an HTTP request from the instance, and a README is a request the app
 * makes on the reader's behalf.
 */

test("the cloud metadata address is not public", () => {
  assert.equal(isPublicAddress("169.254.169.254"), false);
});

test("loopback, private and link-local ranges are all refused", () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be refused`);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("a literal private address in a URL is refused without a DNS lookup", async () => {
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /non-public/);
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1:3000/api/settings"), /non-public/);
  await assert.rejects(() => assertPublicUrl("http://[::1]:3000/"), /non-public/);
});

test("localhost is refused by name as well as by address", async () => {
  assert.equal(await isPublicUrl("http://localhost:3000/api/settings"), false);
});

test("only http and https are ever fetched", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /only http and https/);
  await assert.rejects(() => assertPublicUrl("gopher://example.com/"), /only http and https/);
  await assert.rejects(() => assertPublicUrl("data:text/html,hi"), /only http and https/);
});

test("nonsense is refused rather than thrown at the network", async () => {
  await assert.rejects(() => assertPublicUrl("not a url"), /Not a URL/);
  assert.equal(await isPublicUrl(""), false);
});

test("a normal image URL passes and comes back parsed", async () => {
  const url = await assertPublicUrl("https://raw.githubusercontent.com/acme/x/main/hero.png");
  assert.equal(url.hostname, "raw.githubusercontent.com");
  assert.equal(url.pathname, "/acme/x/main/hero.png");
});
