/**
 * Conservative public-domain detection from PDF front matter (first ~12 pages)
 * and archive filenames. Only returns `isPublicDomain: true` when front matter
 * carries unambiguous public-domain or pre-1930 copyright evidence with no
 * post-1929 copyright notice.
 */
export function detectPublicDomainFrontMatter(
  frontPageTexts: string[],
  bookTitle = "",
): { isPublicDomain: boolean; reason: string | null } {
  const joined = frontPageTexts.slice(0, 12).join("\n");
  if (!joined.trim()) return { isPublicDomain: false, reason: null };

  if (
    /project\s+gutenberg\s+ebook|this\s+ebook\s+is\s+for\s+the\s+use\s+of\s+anyone\s+anywhere/i.test(
      joined,
    )
  ) {
    return { isPublicDomain: true, reason: "Project Gutenberg public-domain edition detected in front matter." };
  }

  if (
    /\bpublic\s+domain\s+mark\b|\bnot\s+protected\s+by\s+u\.?s\.?\s+copyright\b/i.test(joined) &&
    !/\bnot\s+in\s+the\s+public\s+domain\b/i.test(joined)
  ) {
    return { isPublicDomain: true, reason: "Explicit public-domain declaration detected in front matter." };
  }

  const copyrightYears: number[] = [];
  const copyrightRe = /\bcopyright(?:\s*,|\s+©|\s*\(c\)|\s+by)?[^.\n]{0,45}?\b(1[789]\d{2}|20\d{2})\b/gi;
  for (const match of joined.matchAll(copyrightRe)) {
    const year = Number(match[1]);
    if (Number.isFinite(year)) copyrightYears.push(year);
  }

  if (copyrightYears.length > 0) {
    const earliest = Math.min(...copyrightYears);
    const latest = Math.max(...copyrightYears);
    if (earliest >= 1700 && latest <= 1929) {
      return {
        isPublicDomain: true,
        reason: `Front matter lists copyright ${earliest}${latest !== earliest ? `–${latest}` : ""} (pre-1930 public domain).`,
      };
    }
  }

  // Internet Archive USDA / Library of Congress CAT scans with pre-1930 publication dates
  const isInternetArchiveScan =
    /\bdigitized\s+by\s+the\s+internet\s+archive\b/i.test(joined) ||
    /\bIA[_\s-]+[A-Za-z0-9]{5,}\b/i.test(bookTitle);
  if (isInternetArchiveScan && copyrightYears.length === 0) {
    const pubDateMatch = joined.match(/\b(?:published|printed|washington\s*:\s*government\s+printing\s+office)[^.\n]{0,50}?\b(1[78]\d{2}|19[012]\d)\b/i);
    if (pubDateMatch) {
      return {
        isPublicDomain: true,
        reason: `Internet Archive digitization of a ${pubDateMatch[1]} publication (pre-1930 public domain).`,
      };
    }
  }

  return { isPublicDomain: false, reason: null };
}
