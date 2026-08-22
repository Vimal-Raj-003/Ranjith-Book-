import type { Box, OcrWord } from "./ocr";

export interface AlignedWord {
  visionIndex: number;
  word: string;
  ocrIndex: number | null;
  box: Box | null;
}

/**
 * Below this share of words carrying a box, a page highlights by paragraph block
 * instead of by word. A marker that lands on the wrong words is worse than one
 * that covers a whole paragraph.
 */
export const ALIGNMENT_FLOOR = 0.55;

/**
 * Case, punctuation and quote marks differ between the two engines constantly,
 * and printed text carries diacritics ("Márquez") that a phone-camera OCR pass
 * often flattens to plain ASCII ("Marquez"). `NFKD` splits an accented letter
 * into its base letter plus a combining mark; the following `replace` strips
 * just the combining marks (U+0300 - U+036F, written as an explicit escape
 * rather than pasted literal combining characters, which do not survive
 * round-tripping through plain text reliably), leaving the bare base letter so
 * the two spellings normalize to the same token.
 */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Longest common subsequence between what the vision model read and what OCR
 * measured.
 *
 * A subsequence rather than a nearest-neighbour walk, because the two failure
 * modes are insertion and deletion: OCR invents a token from a speck of dust, or
 * misses a word entirely. Either one shifts a positional walk by one and every
 * subsequent highlight lands on the wrong word — visibly, for the rest of the
 * video. LCS absorbs both without drift.
 *
 * A vision word with no confident counterpart gets `null`, never a nearby box.
 */
export function alignWords(
  visionWords: string[],
  ocrWords: OcrWord[],
): { aligned: AlignedWord[]; confidence: number } {
  const a = visionWords.map(normalizeToken);
  const b = ocrWords.map((w) => normalizeToken(w.text));

  const n = a.length;
  const m = b.length;

  const aligned: AlignedWord[] = visionWords.map((word, visionIndex) => ({
    visionIndex,
    word,
    ocrIndex: null,
    box: null,
  }));

  if (n === 0 || m === 0) return { aligned, confidence: 0 };

  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      aligned[i].ocrIndex = j;
      aligned[i].box = ocrWords[j].box;
      matched++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++; // this vision word has no counterpart
    } else {
      j++; // this OCR token is spurious
    }
  }

  return { aligned, confidence: matched / n };
}
