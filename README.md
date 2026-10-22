# Fiszki

Personal flashcards PWA for learning vocabulary from a textbook (built for
*Aula Internacional 1*, tested on Android Chrome). Photograph a textbook page,
let Gemini pull out the word pairs, review them, and study with spaced repetition.

Runs as a **local-first Progressive Web App (PWA)** entirely in your phone's
browser: data is stored in **IndexedDB** on your device, and Gemini extraction
calls Google's API directly from the browser over HTTPS. **Zero backend server required.**

```
flashcarrds/
├── frontend/   React + TypeScript + Vite + Tailwind PWA (Dexie / IndexedDB)
├── server/     Optional: Rust (axum) + SQLite server for self-hosting
├── Makefile    one-liners for dev / build / test / run
└── data/       fiszki.db used only in self-hosted server mode (git-ignored)
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
4. **Local-first & offline** – all cards, decks, review history, and settings
   are persisted in IndexedDB on the device. Full offline study support via
   service worker precaching.
5. **Privacy & safety** – your Gemini API key is stored only in your local
   browser and never sent to any intermediary server. Extraction includes daily
   caps and sliding-window rate limiters.
6. **Data portability** – full JSON backup export and import with deduplication.

---

## Deploy to GitHub Pages & Install on Android

The easiest way to use Fiszki on your phone is via GitHub Pages:

### 1. Enable GitHub Pages in your repo
1. Open your GitHub repository (e.g. `kamilWyszynski1/flashcarrds`).
2. Go to **Settings** → **Pages**.
3. Under **Build and deployment** → **Source**, select **GitHub Actions**.

### 2. Deploy
Push to `master` (or `main`). The included `.github/workflows/deploy-pages.yml`
workflow automatically runs tests, builds the subpath-safe PWA, and deploys it to:
```
https://<username>.github.io/<repository-name>/
```
*(e.g. `https://kamilwyszynski1.github.io/flashcarrds/`)*

### 3. Install on Android
1. Open your GitHub Pages URL in **Google Chrome on Android**.
2. Tap the in-app **Settings** → **Install as app**, or open the Chrome menu
   (**⋮**) and tap **Add to Home screen** / **Install app**.
3. Fiszki will be installed on your home screen with an app icon and standalone
   display mode, operating fully offline.

### 4. Configure Gemini Photo Extraction
1. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Open Fiszki on your phone, go to **Settings**, and paste your API key
   (`AIza...`) into the **API key** field and tap **Save**.
3. The key is stored securely in your browser's IndexedDB and used directly for
   HTTPS calls to Google's Gemini API when extracting textbook photos.

---

## Local Development (Frontend)

Prerequisites: Node.js 20+.

```bash
cd frontend
npm install
npm test            # run vitest suite (61 tests)
npm run dev         # start Vite dev server on http://localhost:5173
npm run build       # build production PWA to frontend/dist
```

To test building for a GitHub Pages subpath locally:
```bash
cd frontend
VITE_BASE_PATH=/flashcarrds/ npm run build
npx vite preview --host 127.0.0.1 --port 18131
```

---

## Optional: Self-Hosted Server Mode (`VITE_BACKEND=http`)

If you prefer hosting a central backend with SQLite on a home server (Raspberry Pi,
NAS, or VM) instead of on-device IndexedDB:

Prerequisites: Rust (stable) and Node 20+.

```bash
make build          # builds frontend with VITE_BACKEND=http + cargo release binary
make run            # serves http://localhost:8080 (axum API + static PWA)
```

Photo extraction in server mode uses `GEMINI_API_KEY` configured on the server:
```bash
GEMINI_API_KEY=AIza...            # required for "Cards from photo" in server mode
FISZKI_GEMINI_MODEL=gemini-flash-latest   # optional
```

### Server Configuration (env vars, `.env` is read)

| Variable                    | Default               | Meaning                                                        |
|-----------------------------|-----------------------|----------------------------------------------------------------|
| `FISZKI_ADDR`               | `0.0.0.0:8080`        | listen address                                                 |
| `FISZKI_DB`                 | `./data/fiszki.db`    | SQLite file (created, WAL mode)                                |
| `FISZKI_STATIC`             | `../frontend/dist`    | built frontend to serve                                        |
| `FISZKI_BASIC_AUTH`         | – (off)               | `user:password` → HTTP Basic auth for the whole app            |
| `FISZKI_EXTRACT_DAILY_CAP`  | `60`                  | max `/api/extract` calls per local day (`0` = unlimited)       |
| `FISZKI_EXTRACT_PER_MINUTE` | `6`                   | max `/api/extract` calls per minute (`0` = unlimited)          |
| `GEMINI_API_KEY`            | –                     | the Gemini key (server-side only, never stored in DB)          |
| `FISZKI_GEMINI_MODEL`       | `gemini-flash-latest` | model id (`models/` prefix accepted; validated at startup)     |
| `FISZKI_GEMINI_TIMEOUT_SECS`| `30`                  | per-attempt Gemini timeout (5–300); one retry on a fast `503`  |
| `RUST_LOG`                  | `info`                | tracing filter (`fiszki_server=debug` logs each Gemini call)   |

---

## Scheduling

An SM‑2 style spaced repetition scheduler (`srs.ts` in frontend, `srs.rs` in server):
- New / learning cards: Again → 1 min, Hard → 6 min, Good → 1 day, Easy → 4 days.
- Review cards multiply the interval by ease factor (Hard ×1.2, Good ×ease, Easy ×ease×1.3).
- Again lapses back into relearning (10 min) and decreases ease.
- Intervals are capped and formatted into human-readable labels.

---

## Testing

- `frontend`: 61 vitest unit and integration tests covering scheduling, Dexie
  IndexedDB operations, duplicate detection, sliding-window rate limiters, and
  Gemini prompt/response parsing.
- `server`: 59 cargo unit and integration tests for SQLite migrations, scheduler,
  and HTTP API endpoints.
