# BookReel

## Running locally

```bash
npm install
npm run setup        # prisma db push + generate, fetches ffmpeg
npm run setup:voice  # sets up the TTS voice (Pocket TTS, local)
npm run setup:pdf    # PyMuPDF, for reading book PDFs
npm run setup:align  # faster-whisper, for word-level subtitle timing
npm run dev          # starts the app on http://localhost:3000
```

`setup:pdf` and `setup:align` are needed only for the book-PDF flow below.
Without `setup:align` the app still renders, but subtitle and highlight
timing falls back to an estimate — and says so, on the episode and in its
`timingSource`.

### Signing in

Sign-in is passwordless: you request a six-digit code by email and enter it
to get a session. Two things gate that flow:

- **Allowlist** — only addresses in `AUTH_ALLOWED_EMAILS` (comma/space
  separated; exact addresses, `*@domain` wildcards, or a bare `*`) may sign
  in. If unset, only the SMTP account itself (`SMTP_USER`) is allowed.
- **Delivery** — the code is normally emailed via SMTP.

For local development, create a `.env.local` (git-ignored, never committed):

```bash
AUTH_ALLOWED_EMAILS=you@example.com
AUTH_DEV_LOGIN=1
```

With `AUTH_DEV_LOGIN=1` set and no SMTP configured, `POST /api/auth/request`
skips sending an email and instead returns the generated code directly in
its JSON response (`devCode`) and logs it to the server console, both
clearly marked as a development bypass. Everything else about the code is
unchanged — it's still hashed before being stored, still expires after 10
minutes, and still respects the attempt limit and the allowlist; only
*delivery* is swapped out.

This bypass is double-guarded and cannot be switched on in production: it
requires **both** `NODE_ENV !== "production"` and `AUTH_DEV_LOGIN=1`. If
either condition isn't met, `/api/auth/request` behaves exactly as it does
today and requires real SMTP.

Quick round trip once the dev server is running:

```bash
curl -X POST http://localhost:3000/api/auth/request \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
# => {"ok":true,"email":"you@example.com","dev":true,"devCode":"123456",...}

curl -X POST http://localhost:3000/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","code":"123456"}' \
  -c cookies.txt
# => {"ok":true,"user":{...}}, and a bookreel_session cookie is set
```

### Using real SMTP instead

Set these in `.env.local` (or your deployment's env) and the app emails
codes as usual — real SMTP is used whenever it's configured, regardless of
`AUTH_DEV_LOGIN`:

```bash
SMTP_USER=you@yourdomain.com
SMTP_PASS=your-smtp-password
SMTP_HOST=smtp.zoho.in   # optional, defaults to smtp.zoho.in
SMTP_PORT=465            # optional, defaults to 465
SMTP_FROM="BookReel <you@yourdomain.com>"  # optional
```

If `AUTH_ALLOWED_EMAILS` is unset, `SMTP_USER` also becomes the sole
allowed address.

## What this is

BookReel turns a book into short narrated videos, by either of two routes.

**Photographs.** Upload photos of pages. A vision model reads them, OCR
measures where each word sits, and the pipeline writes a script, records
the narration and renders a 9:16 video in which the real page scrolls
behind the voice and a marker sweeps the words being spoken.

**A book PDF.** Upload a book of up to 200 pages, under **Book PDFs**.
PyMuPDF extracts the text and word positions, scanned pages go through
OCR, chapters are detected, and the whole book is searched for ideas that
could each carry a 1–2 minute video. Every idea is checked against the
book's own words and keeps the pages it came from. Pick the ones you want
and each becomes a video.

Either way the finished video is 1080×1920 at 30 fps, with a local
voice-over, subtitles timed to the recorded audio word by word, and — for
a PDF idea — a plan of 8–15 scenes drawn from a fixed catalogue (the real
page, a close crop, a pulled quote, kinetic text, icons, a comparison, a
list, a timeline, a curve, a number).

Nothing on screen is invented: a quote must be found in the page text, a
number must be said in the narration, and a label must appear in what is
actually spoken. Anything that fails those checks falls back to showing
the narration itself, and the substitution is recorded on the episode.

There is no publishing or scheduling yet.

## How it fits together

```
photos ─┐
        ├─ OCR / vision ─ script ─ grounding check ─ voice ─ word timing ─┐
PDF  ───┘   analysis ─ ideas ─ selection ──────────────────── scene plan ─┴─ composition ─ render ─ MP4
```

- `src/lib/pdf`, `src/lib/analysis` — reading a book and finding its ideas
- `src/lib/content` — writing a script and proving it is grounded
- `src/lib/media` — voice, music, and word timing from the recording
- `src/lib/video` — the composition, the scene system and the renderer
- `src/lib/pipeline.ts` — the controller that runs a stage at a time

Useful commands:

```bash
npm test             # the full suite
npm run e2e:seek     # every frame renders the same however it is reached
npm run e2e:book -- book.pdf "Title"   # a real book, end to end
```
