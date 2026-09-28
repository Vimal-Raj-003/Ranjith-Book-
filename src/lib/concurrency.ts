/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Vision and OCR
 * are independent per-page work, so a straight `Promise.all` over every page
 * would open one CLI process and one OCR job per page simultaneously — fine
 * for three pages, a self-inflicted denial of service for twenty (and for a
 * 200-page PDF, two hundred).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
