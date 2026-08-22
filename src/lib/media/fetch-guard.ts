/**
 * Every URL in this app's image path comes out of somebody else's README.
 *
 * The pipeline reads a repository nobody here controls, then *fetches* the
 * image URLs it finds and *opens* the site links it finds in a real browser —
 * both from the server. That is a server-side request forgery surface with an
 * attacker-supplied target: a README pointing at `http://169.254.169.254/` asks
 * this app to read a cloud instance's metadata service, and one pointing at
 * `http://127.0.0.1:3000/api/...` asks it to call itself from inside the trust
 * boundary.
 *
 * So a URL is checked before it is used: the scheme has to be http(s), and
 * every address the host resolves to has to be a public one.
 *
 * This closes the obvious hole, not every hole. A hostile DNS server can still
 * answer with a public address for the check and a private one for the fetch
 * that follows — defeating that needs the connection pinned to the address that
 * was verified, which is a bigger change than this file. Redirects are handled
 * where it matters by fetching with `redirect: "manual"` and re-checking.
 */

import dns from "node:dns/promises";
import net from "node:net";

/** Where the check refused, in words, so a skipped image can be explained. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 192 && b === 0) || // IETF protocol assignments
    a === 198 || // benchmarking + reserved ranges overlap here; refuse the lot
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  // Mapped IPv4 (::ffff:10.0.0.1) is judged as the IPv4 address it carries.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return (
    v.startsWith("fc") || // unique local
    v.startsWith("fd") ||
    v.startsWith("fe80") || // link-local
    v.startsWith("ff") // multicast
  );
}

export function isPublicAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return !isPrivateIPv4(ip);
  if (version === 6) return !isPrivateIPv6(ip);
  return false;
}

/**
 * Throw unless this URL is safe for the server to reach out to. Returns the
 * parsed URL so the caller can use the normalised form.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a URL: ${raw.slice(0, 120)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Refusing a ${url.protocol} URL — only http and https are fetched.`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address needs no lookup, and must not get one: a hostile README
  // can write the address directly.
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new BlockedUrlError(`Refusing to fetch a non-public address: ${host}`);
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }

  if (!addresses.length) throw new BlockedUrlError(`Could not resolve ${host}`);

  // Every answer has to be public. One private address among them is enough to
  // refuse, because which one the socket picks is not ours to decide.
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) {
    throw new BlockedUrlError(`${host} resolves to a non-public address (${bad.address}); refusing to fetch it.`);
  }

  return url;
}

/** True when the URL is safe to reach, with no throwing for the caller to catch. */
export async function isPublicUrl(raw: string): Promise<boolean> {
  try {
    await assertPublicUrl(raw);
    return true;
  } catch {
    return false;
  }
}
