# LabelVerify — Backend

OCR + barcode comparison API. Given a photo of a battery-pack label and the
value decoded from its barcode, it reads the RSN printed on the label (via
Google Cloud Vision OCR) and reports whether the two agree.

- **PASS** — the barcode exactly matches the RSN on the label.
- **WARNING** — they differ by a hair (≤ 1 edit, e.g. an `O`↔`0` misread) —
  probably OCR noise; a human should eyeball it.
- **FAIL** — they genuinely disagree, or the RSN couldn't be read at all.

---

## Table of contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Setting up Google Cloud Vision](#setting-up-google-cloud-vision)
- [Persistent image storage (Supabase)](#persistent-image-storage-supabase)
- [API reference](#api-reference)
- [Testing with curl](#testing-with-curl)
- [How verification works](#how-verification-works)
- [Adding new label profiles](#adding-new-label-profiles)
- [Swapping the OCR provider](#swapping-the-ocr-provider)
- [Deploy to Render](#deploy-to-render)
- [Project layout](#project-layout)

---

## Quick start

```bash
cd backend
npm install
cp .env.example .env        # then edit .env (see below)
npm run dev                 # ts-node-dev, reloads on change
```

The server listens on `http://localhost:4000` by default. Health check:

```bash
curl http://localhost:4000/health
```

**Want to try it without any cloud credentials?** Set `OCR_PROVIDER=mock` and
`MOCK_OCR_TEXT="RSN:RKBBPFM7C000167"` in `.env`. The mock provider "reads" that
text from any uploaded image, so you can exercise the whole pipeline offline.

Other scripts:

```bash
npm run build       # compile TypeScript → dist/
npm start           # run the compiled server (dist/server.js)
npm run typecheck   # tsc --noEmit
```

---

## Environment variables

Copy `.env.example` → `.env` and fill it in. Config is validated at startup with
zod; a missing/invalid value fails fast with a clear message instead of a
cryptic runtime crash.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `4000` | HTTP port. |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test`. Gates the debug endpoint and stack traces. |
| `OCR_PROVIDER` | no | `google` | `google` \| `mock`. |
| `GOOGLE_VISION_API_KEY` | see note | — | An `AIza…` Vision API key. **Provide this _or_** `GOOGLE_APPLICATION_CREDENTIALS` when `OCR_PROVIDER=google`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | see note | — | Path to a service-account JSON key. Read automatically by the Vision client. Preferred for production. |
| `MOCK_OCR_TEXT` | no | `""` | Text returned by the `mock` provider. |
| `ALLOWED_ORIGINS` | no | `""` | Comma-separated CORS allowlist. Requests without an `Origin` (curl, mobile apps) are always allowed. |
| `DATABASE_URL` | no | — | Placeholder for later; not used yet. |
| `SUPABASE_URL` | no | — | Supabase project URL (`https://<ref>.supabase.co`). Enables persistent image archive when set alongside `SUPABASE_SERVICE_KEY`. |
| `SUPABASE_SERVICE_KEY` | no | — | Supabase **service_role** key (Project settings → API). Server-only — never expose to the frontend. |
| `SUPABASE_STORAGE_BUCKET` | no | `label-scans` | Bucket the scans are written into. |
| `LOG_LEVEL` | no | `debug`(dev)/`info`(prod) | pino level override. |

> **Auth note:** when `OCR_PROVIDER=google`, at least one of
> `GOOGLE_VISION_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS` must be set — the
> server refuses to start otherwise.

---

## Setting up Google Cloud Vision

You can authenticate with either a simple **API key** (fastest) or a
**service-account JSON key** (preferred for production, finer-grained IAM).

### 1. Create a project & enable the API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one) — note the **Project ID**.
3. **Enable billing** for the project (Vision has a free monthly tier but still
   requires a billing account).
4. Enable the Vision API:
   **APIs & Services → Library → search "Cloud Vision API" → Enable**
   (or visit
   [console.cloud.google.com/apis/library/vision.googleapis.com](https://console.cloud.google.com/apis/library/vision.googleapis.com)).

### Option A — API key (quickest)

1. **APIs & Services → Credentials → Create credentials → API key.**
2. Copy the `AIza…` key.
3. **Recommended:** click the key → **Restrict key** → under *API restrictions*
   limit it to **Cloud Vision API** so a leaked key can't be abused elsewhere.
4. Put it in `.env`:

   ```dotenv
   OCR_PROVIDER=google
   GOOGLE_VISION_API_KEY=AIza...your-key...
   ```

### Option B — Service account (preferred for production)

1. **APIs & Services → Credentials → Create credentials → Service account.**
2. Give it a name (e.g. `labelverify-vision`). Grant the role
   **Cloud Vision AI → Cloud Vision AI User** (or *Project → Viewer* for a quick
   start).
3. Open the created service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads — **this is a secret, treat it like a password.**
4. Move it somewhere outside version control. A `credentials/` folder in the
   backend is already git-ignored:

   ```bash
   mkdir -p backend/credentials
   mv ~/Downloads/labelverify-vision-*.json backend/credentials/vision-service-account.json
   ```

5. Point the env var at it (the Vision client reads this automatically — you do
   **not** also set the API key):

   ```dotenv
   OCR_PROVIDER=google
   GOOGLE_APPLICATION_CREDENTIALS=./credentials/vision-service-account.json
   ```

> **Never commit credentials.** `.gitignore` already excludes `.env`,
> `credentials/`, and common service-account filename patterns
> (`service-account*.json`, `*-credentials.json`, …). Double-check before
> pushing.

---

## Persistent image storage (Supabase)

Every scanned label photo can be archived to Supabase Storage for audit. The
returned public URL is included in the `/api/verify` response as `imageUrl`.
Images are re-encoded before upload (max 1600 px wide, JPEG q80) to keep the
free tier honest.

**Storage is optional.** If `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is unset,
verification still succeeds and `imageUrl` is `null`. An upload failure at
runtime is logged and also nulls out `imageUrl` — it never fails the request.

### 1. Create a project

1. Sign up / log in at [supabase.com](https://supabase.com).
2. **New project** → pick an organisation, name it (e.g. `labify`), choose the
   nearest region, set a strong DB password (unused here, but required).
3. Wait for provisioning to finish.

### 2. Create the storage bucket

1. In the project dashboard, go to **Storage** in the left sidebar.
2. **New bucket** → name it `label-scans` (match `SUPABASE_STORAGE_BUCKET`).
3. Toggle **Public bucket = ON** so the returned URLs resolve without a signed
   link. (For a private bucket, swap `getPublicUrl` for
   `createSignedUrl(path, ttl)` in [`src/services/storage.ts`](src/services/storage.ts).)
4. Click **Create bucket**.

### 3. Grab the keys

1. **Project settings → API.**
2. Copy the **Project URL** (`https://<ref>.supabase.co`) into `SUPABASE_URL`.
3. Copy the **`service_role` secret** into `SUPABASE_SERVICE_KEY`.
   > ⚠️ The service_role key bypasses Row Level Security. Keep it server-side
   > only — never ship it to the mobile app or a browser.

### 4. Set the env vars

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOi...  # service_role
SUPABASE_STORAGE_BUCKET=label-scans
```

Restart the server. On boot you should see:

```
Image storage provider initialised { provider: 'supabase', bucket: 'label-scans' }
```

### 5. Verify it end-to-end

Run a scan (see [Testing with curl](#testing-with-curl)). The response now
contains an `imageUrl`:

```jsonc
{
  "status": "pass",
  "imageUrl": "https://your-project.supabase.co/storage/v1/object/public/label-scans/scans/2026/07/07/8f1b….jpg",
  …
}
```

Open the URL in a browser to confirm the image resolves, or check
**Storage → label-scans → scans/YYYY/MM/DD/** in the Supabase dashboard.

### Filename layout

```
scans/YYYY/MM/DD/{uuid}.jpg
```

Date-partitioned so listings and lifecycle rules (e.g. "delete after 90 days")
can operate on `scans/2026/07/` prefixes without scanning the whole bucket. UUIDs
avoid collisions and don't leak scan count.

### Swapping storage backends

The app depends only on the `StorageProvider` interface and the
`getStorageProvider()` factory in [`src/services/storage.ts`](src/services/storage.ts).
To move to S3, GCS, or local disk, add a class implementing `uploadImage` and
extend the factory — the route is untouched.

---

## API reference

### `POST /api/verify`

`multipart/form-data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `image` | file | yes | The captured label photo. Images only, ≤ 10 MB. |
| `barcodeValue` | text | yes | The decoded barcode string, e.g. `RKBBPFM7C000167`. |
| `labelType` | text | no | Defaults to `battery_pack`. Must be a known profile. |

**Response `200 OK`** (for pass, warning, **and** fail — a fail is a valid
business outcome, not an HTTP error):

```jsonc
{
  "status": "pass",                 // "pass" | "warning" | "fail"
  "decodedBarcode": "RKBBPFM7C000167",
  "expectedValue": "RKBBPFM7C000167", // RSN read from the label, or null
  "extractedFields": {
    "RSN": "RKBBPFM7C000167",
    "ModelNo": "JBP000001-7S",
    "NominalVoltage": "22.4 V",
    "NominalEnergy": "7.04 kWh",
    "Capacity": "314 Ah"
  },
  "mismatches": [],                 // [{ field, expected, got }]
  "missingFields": [],              // required fields OCR couldn't read
  "ocrText": "…full OCR output…",   // for debugging
  "reason": "Barcode matches the RSN on the label (RKBBPFM7C000167).",
  "imageUrl": "https://<ref>.supabase.co/storage/v1/object/public/label-scans/scans/2026/07/07/8f1b….jpg"
                                    // null when Supabase storage is unconfigured or upload failed
}
```

**Error responses:**

| Status | When |
| --- | --- |
| `400` | Missing/invalid `barcodeValue`, missing image, non-image upload, file > 10 MB, unknown `labelType`. Body: `{ error: { status, message, details? } }`. |
| `502` | OCR provider failed (auth, quota, network). The request was fine; the upstream wasn't. |

### `POST /api/verify/debug` *(dev only)*

Identical to `/api/verify` but the response additionally includes `rawOcr` (the
provider's untouched payload) plus `ocrDurationMs` / `totalDurationMs` — handy
for tuning the label-profile regexes. **Not registered when
`NODE_ENV=production`** (returns 404 there).

---

## Testing with curl

Assuming a sample photo at `./sample-label.jpg` and the server on port 4000:

```bash
# Expected PASS — barcode matches the RSN printed on the label
curl -X POST http://localhost:4000/api/verify \
  -F "image=@./sample-label.jpg;type=image/jpeg" \
  -F "barcodeValue=RKBBPFM7C000167"

# Expected FAIL — barcode differs from the label's RSN
curl -X POST http://localhost:4000/api/verify \
  -F "image=@./sample-label.jpg;type=image/jpeg" \
  -F "barcodeValue=RKBBPFM7C000999"

# Debug variant (dev only) — includes the raw OCR response
curl -X POST http://localhost:4000/api/verify/debug \
  -F "image=@./sample-label.jpg;type=image/jpeg" \
  -F "barcodeValue=RKBBPFM7C000167"
```

Pipe through `jq` for readable output: `… | jq`.

**No sample image or credentials?** Run the mock provider:

```bash
# In .env:  OCR_PROVIDER=mock  and  MOCK_OCR_TEXT=RSN:RKBBPFM7C000167
# Any image file works — its contents are ignored by the mock.
curl -X POST http://localhost:4000/api/verify \
  -F "image=@./anything.png;type=image/png" \
  -F "barcodeValue=RKBBPFM7C000167"      # → PASS

curl -X POST http://localhost:4000/api/verify \
  -F "image=@./anything.png;type=image/png" \
  -F "barcodeValue=RKBBPFM7CO00167"      # → WARNING (O vs 0)
```

---

## How verification works

1. **Preprocess** the uploaded image with [sharp](https://sharp.pixelplumbing.com/):
   auto-rotate from EXIF, resize to max 2000 px wide, normalise contrast, and
   sharpen. These meaningfully improve OCR on angled, low-contrast factory
   photos. (If preprocessing fails, we fall back to the original bytes rather
   than erroring.)
2. **OCR** the processed image → full text.
3. **Extract fields** by running each regex from the label profile over the OCR
   text (RSN, Model No., Nominal Voltage, etc.).
4. **Compare** the scanned `barcodeValue` against the extracted RSN:
   - exact match (after uppercase + whitespace-stripping) → **pass**;
   - within the profile's fuzzy tolerance (Levenshtein ≤ 1, treating common OCR
     confusions `O↔0 I↔1 S↔5 B↔8 …` as candidate substitutions) → **warning**,
     with the differing character(s) called out;
   - otherwise, or if the RSN couldn't be read → **fail**.
5. Missing **required** fields are folded into the `reason` regardless of status.

Every verification is logged via pino with `barcodeValue`, `status`, `reason`,
`ocrDurationMs`, and `totalDurationMs`.

---

## Adding new label profiles

A label is described declaratively in
[`src/config/labelProfiles.ts`](src/config/labelProfiles.ts) — no verifier code
changes are needed.

1. Define a new profile object:

   ```ts
   const chargerProfile: LabelProfile = {
     type: 'charger',                 // matches the request's `labelType`
     displayName: 'Charger',
     barcodeField: 'SerialNo',        // which extracted field the barcode matches
     fuzzyTolerance: 1,               // max edit distance for a WARNING
     fieldsToExtract: [
       { name: 'SerialNo', regex: /S\/N\s*[:.]?\s*([A-Z0-9]{8,20})/i, required: true },
       { name: 'OutputVoltage', regex: /Output\s*[:.]?\s*([\d.]+\s*V)/i, required: false },
     ],
   };
   ```

   Each field's regex must expose the value in its **first capture group**.
   Avoid line anchors (`^`/`$`) — OCR line order is unreliable, so match against
   the whole blob.

2. Register it:

   ```ts
   export const LABEL_PROFILES = {
     [batteryPackProfile.type]: batteryPackProfile,
     [chargerProfile.type]: chargerProfile,   // ← add
   };
   ```

3. Callers may now send `labelType=charger`. Unknown types are rejected with a
   `400` listing the known types.

**Tip:** use `POST /api/verify/debug` to see the raw OCR text and iterate on your
regexes.

---

## Swapping the OCR provider

The app depends only on the `OcrProvider` interface and the `getOcrProvider()`
factory in [`src/services/ocr.ts`](src/services/ocr.ts). To add, say, AWS
Textract or a self-hosted PaddleOCR:

1. Implement the interface:

   ```ts
   export class TextractOCR implements OcrProvider {
     readonly name = 'textract';
     async detectText(imageBuffer: Buffer): Promise<OcrResult> {
       // …call Textract, return { text, raw }
     }
   }
   ```

2. Add a case to the factory `switch` and extend the `OCR_PROVIDER` enum in
   [`src/config/env.ts`](src/config/env.ts).

No route or verification code changes.

---

## Deploy to Render

This gives the mobile app a permanent public HTTPS URL to talk to, instead of
your laptop's LAN IP.

### Credentials in the cloud

Render can't easily host the service-account **file**, so the backend also
accepts the key **inline** via `GOOGLE_CREDENTIALS_JSON`. At startup
[`src/config/env.ts`](src/config/env.ts) writes that JSON to a temp file and
points `GOOGLE_APPLICATION_CREDENTIALS` at it — so **local dev uses a file,
production uses an env var**, and the Vision client works either way.

### Steps

1. **Push to GitHub.** Commit the repo (the `backend/` folder included) and push
   it to a GitHub repository. Double-check `gcp-key.json` and `.env` are **not**
   committed — they're git-ignored, but verify with `git status` before pushing.

2. **Sign up / log in at [render.com](https://render.com)** and connect your
   GitHub account.

3. **New → Web Service**, and select your repository. Render reads
   [`render.yaml`](render.yaml) (the Blueprint) and pre-fills the service:
   - **Name:** `labify-backend`
   - **Root Directory:** `backend`
   - **Build Command:** `npm install --include=dev && npm run build`
   - **Start Command:** `node dist/server.js`
   - **Plan:** Free

   > `--include=dev` is deliberate: with `NODE_ENV=production` set, a plain
   > `npm install` skips devDependencies and the TypeScript compiler wouldn't be
   > available for the build. If Render doesn't pick up `render.yaml`
   > automatically, create the Web Service manually and enter the values above
   > (set **Root Directory** to `backend`).

4. **Set the environment variables** (Dashboard → your service → Environment).
   `PORT` is injected by Render automatically — leave it unset.

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `OCR_PROVIDER` | `google` |
   | `ALLOWED_ORIGINS` | `*` |
   | `GOOGLE_CREDENTIALS_JSON` | *paste the **entire** contents of your GCP service-account JSON as a single line* |

   **Getting the one-line JSON:** open `backend/gcp-key.json`, copy everything,
   and paste it into the value box. It's fine if it wraps visually — just don't
   introduce real newlines between fields. To minify it to a guaranteed single
   line:

   ```bash
   # prints the key as one line — copy the output into the Render env var
   node -e "process.stdout.write(JSON.stringify(require('./gcp-key.json')))"
   ```

5. **Deploy.** Render builds and starts the service, then gives you a public URL
   like `https://labify-backend.onrender.com`.

6. **Test it:**

   ```bash
   curl https://labify-backend.onrender.com/health
   # → {"status":"ok","timestamp":"..."}

   curl -X POST https://labify-backend.onrender.com/api/verify \
     -F "image=@label.jpg;type=image/jpeg" \
     -F "barcodeValue=RKBBPFM7C000167"
   ```

7. **Point the app at it:** set the mobile app's `API_BASE_URL` to your Render
   URL (see the frontend's `src/config/env.ts`).

### ⚠️ Free-tier gotcha: cold starts

Render's **free** plan **spins the service down after ~15 minutes of
inactivity**. The next request then has to wake it, which takes **~30–60
seconds** (you'll see the first `curl`/scan hang, then succeed). Subsequent
requests are fast.

This is fine for a demo. For production, either:

- upgrade to Render's **Starter plan (~$7/month)**, which stays always-on, or
- migrate to **Google Cloud Run** (scales to zero but cold-starts in ~1–2s, and
  you're already on GCP as `labify-501316`).

---

## Project layout

```
backend/
├── src/
│   ├── config/
│   │   ├── env.ts            # zod-validated environment config
│   │   └── labelProfiles.ts  # declarative label definitions (regexes, tolerance)
│   ├── middleware/
│   │   ├── cors.ts
│   │   └── errorHandler.ts   # every error leaves as JSON
│   ├── routes/
│   │   ├── health.ts
│   │   └── verify.ts         # POST /api/verify (+ /debug); multer + zod
│   ├── services/
│   │   ├── ocr.ts            # OcrProvider interface, GoogleVisionOCR, sharp preprocess
│   │   └── verification.ts   # verifyLabel(): the pass/warning/fail decision
│   ├── utils/
│   │   ├── fuzzyMatch.ts     # Levenshtein + OCR-aware fuzzy matching
│   │   ├── httpError.ts
│   │   └── logger.ts         # pino
│   └── server.ts             # bootstrap
├── .env.example
└── README.md
```
