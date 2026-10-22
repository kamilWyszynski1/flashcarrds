# Fiszki

Personal flashcards app for learning vocabulary from a textbook (built for
*Aula Internacional 1*, used on a Samsung Galaxy S23). Photograph a page, let
Gemini pull out the word pairs, review them, and study with spaced repetition.

```
flashcarrds/
├── backend/    Rust (axum) API server + SQLite, serves the built frontend
├── frontend/   React + TypeScript + Vite + Tailwind PWA
├── Makefile    one-liners for dev / build / run
└── data/       fiszki.db is created here on first run (git-ignored)
```

## Features

1. **Card creation**
   - *From a photo*: native camera (or gallery, multi-page), image downscaled in
     the browser, free-text hint ("only the blue box, nouns with article"),
     Gemini returns structured pairs with a confidence score. You review and
     edit every pair before saving; duplicates of existing cards are flagged and
     pre-unchecked.
   - *Type a card* (with "Save + next" for batches) and *Paste a list*
     (`palabra – słowo` per line).
2. **Grouping** – two levels mirroring the book: Unit (Unidad) → Lesson
   (Lección) → cards. Create/rename/move/delete; pick the target lesson before
   or after extraction.
3. **Viewing & study** – group detail with progress strip, search and filters;
   "All cards" tab; study per lesson, per unit, everything due, or any filtered
   selection. Flip card, four grades (Again / Hard / Good / Easy) with the next
   interval shown, in-session re-queue of missed cards, session summary with
   "repeat the missed".

Also: installable PWA (offline shell + last-known lists), dark mode, Android
back gesture closes sheets/screens like a native app, JSON backup
export/import, languages are a setting (defaults Español → Polski; change to
Polski → English or anything else in Settings).

## Run it

Prerequisites: Rust (stable), Node 20+.

```bash
make build      # npm install + vite build + cargo build --release
make run        # serves http://localhost:8080  (API + PWA)
```

Then open Settings → paste your Gemini API key (from
<https://aistudio.google.com/apikey>). The key is stored server-side in SQLite
and never sent to the browser. Alternatively `export GEMINI_API_KEY=...`
before starting the server (a key saved in Settings takes precedence).

### Development

```bash
make dev-backend    # cargo run, API on :8080 (auto-detects ../frontend/dist if built)
make dev-frontend   # vite on :5173 with /api proxied to :8080, hot reload
make test           # cargo test + vitest
```

### Configuration (env vars, `.env` is read)

| Variable                    | Default               | Meaning                                                        |
|-----------------------------|-----------------------|----------------------------------------------------------------|
| `FISZKI_ADDR`               | `0.0.0.0:8080`        | listen address                                                 |
| `FISZKI_DB`                 | `./data/fiszki.db`    | SQLite file (created, WAL mode)                                |
| `FISZKI_STATIC`             | `../frontend/dist`    | built frontend to serve                                        |
| `FISZKI_BASIC_AUTH`         | – (off)               | `user:password` → HTTP Basic auth for the whole app            |
| `FISZKI_EXTRACT_DAILY_CAP`  | `60`                  | max `/api/extract` calls per local day (`0` = unlimited)       |
| `FISZKI_EXTRACT_PER_MINUTE` | `6`                   | max `/api/extract` calls per minute (`0` = unlimited)          |
| `GEMINI_API_KEY`            | –                     | fallback key if none is saved in Settings                      |
| `GEMINI_BASE_URL`           | Google's endpoint     | override (tests / proxies)                                     |
| `RUST_LOG`                  | `info`                | tracing filter                                                 |

### Using it on the phone

Service workers and "Install app" need a **secure context**: `https://` or
`http://localhost`. Plain `http://<ip>:8080` over Wi‑Fi still works as a
website, just without install/offline. Options, simplest first:

1. **USB + adb** (phone appears as localhost):
   `adb reverse tcp:8080 tcp:8080` → open `http://localhost:8080` in Chrome →
   menu → *Install app*.
2. **Tailscale / any VPN with HTTPS** (e.g. `tailscale serve 8080` gives you an
   `https://…ts.net` URL) – the nicest permanent setup.
3. Put a reverse proxy with a real certificate (Caddy does it automatically)
   in front of the server.

The server itself is a single binary (`backend/target/release/fiszki-server`)
plus the `frontend/dist` folder and the SQLite file – trivial to move to a
Raspberry Pi, a NAS or a small VM.

### Safeguards (PoC level)

Single-user app, so the protection is deliberately simple:

- **`FISZKI_BASIC_AUTH=user:password`** puts the whole app (PWA + API, except
  `/api/health`) behind HTTP Basic auth. Off by default; the server logs a
  warning when it listens on a non-loopback address without it. Only use it
  over HTTPS (or a VPN) – Basic auth is plaintext otherwise.
- **Extraction budget**: `/api/extract` is limited per minute (in memory) and
  per local day (persisted in the DB, survives restarts). Failed Gemini calls
  count too. Over the limit → `429 rate_limited`.
- **Pause switch** in Settings rejects every extraction with `409 paused`
  without touching Gemini – flip it if a key or device gets lost.
- **Usage counter** (today / cap · total) is shown in Settings.
- **Input caps**: ≤ 4 images, ≤ 8 MB base64 each, ≤ 20 MB together, hint
  ≤ 2000 chars, request body ≤ 21 MB; the model name is validated
  (`[A-Za-z0-9._-]`, `models/` prefix stripped).

The Gemini key itself is never returned by the API. Still: keep the port on
`localhost`, a VPN (Tailscale) or behind an authenticating HTTPS proxy.

## API (all JSON, under `/api`)

| Method & path                     | Purpose                                              |
|-----------------------------------|------------------------------------------------------|
| `GET  /overview`                  | units → lessons with counts, due today, new budget   |
| `POST /units` · `PATCH/DELETE /units/{id}`         | unit CRUD                           |
| `POST /lessons` · `GET/PATCH/DELETE /lessons/{id}` | lesson CRUD (+ cards in GET)        |
| `GET  /cards?q=&status=&lesson_id=&unit_id=&sort=` | list/search                         |
| `POST /cards` · `POST /cards/bulk` · `PATCH/DELETE /cards/{id}` | card CRUD              |
| `GET  /study/queue?scope=all\|lesson:ID\|unit:ID&mode=due\|all&ids=` | cards to study    |
| `POST /study/review {card_id, grade, direction}`  | apply a grade                        |
| `POST /extract {images:[{mime_type,data}], hint}` | Gemini extraction                    |
| `GET/PATCH /settings`             | languages, direction, limits, Gemini key (masked)    |
| `GET /export` · `POST /import`    | JSON backup                                          |

## Scheduling

An SM‑2 style scheduler with Anki‑like learning steps (`backend/src/srs.rs`):
new/learning cards: Again → 1 min, Hard → 6 min, Good → 1 day, Easy → 4 days;
review cards multiply the interval by ease (Hard ×1.2, Good ×ease, Easy
×ease×1.3), Again lapses to 10 min and shrinks the interval. All state is on
the card row, so the algorithm can be swapped (e.g. for FSRS) without a
migration.

## Android app later?

The UI is a standard React web app, so the path to Android is a **Trusted Web
Activity** (Bubblewrap/PWABuilder wrap the installed PWA into a Play‑Store
APK) or **Capacitor** (same web build inside a WebView with native plugins).
Both reuse this codebase as is; React Native would have meant rewriting the
UI and giving up the Tailwind design tokens from the Stitch mock.

## Tests

- `backend`: unit tests for the scheduler, repository (in‑memory SQLite),
  Gemini prompt/response parsing; integration tests drive the real router,
  including `/api/extract` against a fake Gemini server.
- `frontend`: vitest for the in‑session queue logic, paste parser and
  formatting; `tsc --noEmit` on build.
