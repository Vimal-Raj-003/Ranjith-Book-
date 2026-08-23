/**
 * A CSV reader that survives `pg_catalog.csv`.
 *
 * That file is 21MB of RFC 4180 with every awkward feature switched on, and
 * two of them are why this exists rather than a `split(",")`:
 *
 *  - **Quoted fields contain commas.** `"Jefferson, Thomas, 1743-1826"` is one
 *    author, not three. Splitting on commas turns roughly a third of the
 *    catalogue into rows with the wrong number of columns.
 *  - **Quoted fields contain newlines.** Row 2 of the real file is
 *    `"The United States Bill of Rights\nThe Ten Original Amendments…"`. The
 *    file has ~90,500 physical lines and ~76,000 records; splitting on `\n`
 *    corrupts fourteen thousand of them, and — worse — corrupts them silently,
 *    because the fragments still parse as *something*.
 *
 * It also has `""` for a literal quote, and CRLF line endings throughout.
 *
 * The parser is an incremental state machine rather than a whole-string one
 * because the caller streams: 21MB of UTF-8 becomes ~42MB as a JS string, and
 * ~76,000 nine-field row objects on top of that is a heap the sync does not
 * need to hold. `push()` may be handed a chunk that ends *anywhere* — inside a
 * quoted field, between the two halves of a `""`, or between the `\r` and the
 * `\n` of a line ending — so every one of those is a state this carries across
 * calls rather than a case that happens to work on whole input.
 *
 * No dependency, because the shape of the problem is small and a parser whose
 * failure mode is "tens of thousands of quietly wrong rows" is worth being able
 * to read end to end. `tests/gutenberg-catalog.test.mts` drives every case
 * above, including the chunk boundaries, one byte at a time.
 */

type State =
  | "field-start" // nothing read for this field yet; a `"` here opens a quoted field
  | "bare" // reading an unquoted field
  | "quoted" // inside `"…"`
  | "after-quote"; // just read a `"` inside a quoted field: `""` or the closer

export class CsvParser {
  private state: State = "field-start";
  private field = "";
  private row: string[] = [];
  /** Set when a chunk ended on `\r`, so a `\n` opening the next one is eaten. */
  private pendingCr = false;
  private done = false;

  /**
   * Feed one chunk. Returns every record that *completed* within it; a record
   * straddling the boundary is carried over and returned by a later call.
   */
  push(chunk: string): string[][] {
    if (this.done) throw new Error("CsvParser.push after end()");
    const rows: string[][] = [];

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];

      // A CRLF split across two chunks. Only swallowed outside a quoted field:
      // inside one, `\r\n` is content and both halves are kept.
      if (this.pendingCr) {
        this.pendingCr = false;
        if (c === "\n") continue;
      }

      switch (this.state) {
        case "field-start":
          if (c === '"') {
            this.state = "quoted";
          } else if (c === ",") {
            this.endField();
          } else if (c === "\n") {
            rows.push(this.endRow());
          } else if (c === "\r") {
            this.pendingCr = true;
            rows.push(this.endRow());
          } else {
            this.field += c;
            this.state = "bare";
          }
          break;

        case "bare":
          if (c === ",") {
            this.endField();
          } else if (c === "\n") {
            rows.push(this.endRow());
          } else if (c === "\r") {
            this.pendingCr = true;
            rows.push(this.endRow());
          } else {
            this.field += c;
          }
          break;

        case "quoted":
          // Everything is content here, including `,` `\n` and `\r`. Only a
          // quote is structural, and even then only maybe — see below.
          if (c === '"') this.state = "after-quote";
          else this.field += c;
          break;

        case "after-quote":
          if (c === '"') {
            // `""` — an escaped literal quote, still inside the field.
            this.field += '"';
            this.state = "quoted";
          } else if (c === ",") {
            this.endField();
          } else if (c === "\n") {
            rows.push(this.endRow());
          } else if (c === "\r") {
            this.pendingCr = true;
            rows.push(this.endRow());
          } else {
            // Junk after a closing quote (`"a"b`). Excel writes this; refusing
            // the whole file over it would be worse than keeping the text.
            this.field += c;
            this.state = "bare";
          }
          break;
      }
    }

    return rows;
  }

  /**
   * Flush whatever is left. A file that ends without a trailing newline still
   * has a last record, and it is the one most likely to be dropped by a parser
   * that forgets this.
   *
   * A file that ends *inside* a quoted field is truncated — the caller is told
   * so via `unterminated`, because a truncated 21MB download that produced
   * 74,000 plausible rows must not be mistaken for a complete catalogue.
   */
  end(): { rows: string[][]; unterminated: boolean } {
    if (this.done) return { rows: [], unterminated: false };
    this.done = true;

    const unterminated = this.state === "quoted";
    const empty = this.state === "field-start" && this.field === "" && this.row.length === 0;
    const rows = empty ? [] : [this.endRow()];
    return { rows, unterminated };
  }

  private endField() {
    this.row.push(this.field);
    this.field = "";
    this.state = "field-start";
  }

  private endRow(): string[] {
    this.row.push(this.field);
    const out = this.row;
    this.field = "";
    this.row = [];
    this.state = "field-start";
    return out;
  }
}

/** Whole-string convenience. Used by the tests and by nothing that streams. */
export function parseCsv(text: string): string[][] {
  const parser = new CsvParser();
  const rows = parser.push(text);
  const tail = parser.end();
  return [...rows, ...tail.rows];
}
