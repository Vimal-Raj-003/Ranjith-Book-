# BookReel

## Running locally

```bash
npm install
npm run setup        # prisma db push + generate, fetches ffmpeg
npm run setup:voice  # sets up the TTS voice
npm run dev          # starts the app on http://localhost:3000
```

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

## What this milestone is

BookReel turns a photographed book page into a narrated video episode:
upload photos, OCR extracts the text, and a rendering pipeline produces a
video with narration and highlighting, in a single theme (marginalia).
There is no publishing, no scheduling, and no thumbnail generation in this
milestone.
