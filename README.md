# Labify

Scan a battery-pack label, verify that the barcode matches the RSN printed on
the label (via backend OCR), and show PASS / FAIL / WARNING to the operator.

- **`frontend/`** — Expo (SDK 54) React Native app. Camera scanning + result UI.
- **`backend/`** — Node/Express OCR + verification API (see `backend/README.md`).

## Backend

Deployed on Render:

```
https://labify-nl4m.onrender.com
```

Health check: `curl https://labify-nl4m.onrender.com/health`

The app reads this URL from `frontend/.env` (`API_BASE_URL`). See
[`backend/README.md`](backend/README.md) for deploying and configuring the API.

> ⚠️ **Render free-tier cold start:** the backend sleeps after ~15 minutes of
> inactivity and takes **~30–60 seconds** to wake on the first request. The
> first scan after idle will sit on "Still verifying…" for up to a minute, then
> succeed; subsequent scans are fast. The app's request timeout is 45s to
> accommodate this. For always-on, upgrade Render to the Starter plan or migrate
> to Cloud Run.

## Running the app

```bash
cd frontend
npm install
cp .env.example .env      # API_BASE_URL is already set to the Render URL
npm start                 # starts Metro / Expo Dev Tools
```

The camera and haptics require a **physical device** (simulators/emulators have
no real camera). Use Expo Go or a development build.

### Test on Android

- **Expo Go:** install Expo Go from the Play Store, run `npm start`, scan the QR
  code from the terminal. Grant camera permission.
- **Dev/preview build:** `eas build --profile preview --platform android`, then
  install the resulting APK.

### Test on iOS

- **Expo Go:** install Expo Go from the App Store, run `npm start`, scan the QR
  code with the Camera app. Grant camera permission.
- **Dev/preview build:** `eas build --profile preview --platform ios`, then
  install via the provided link (requires an Apple developer account / TestFlight
  for distribution).

> Notch / status bar are handled with `react-native-safe-area-context`; result
> haptics use `expo-haptics` and fire on both platforms.

## Deployment — shareable Android APK (EAS Build)

The preview profile produces a standalone `.apk` you can send to testers as a
download link. It bundles the JS, bakes in the backend URL, and installs without
Expo Go.

### Prerequisites

- An [Expo account](https://expo.dev/signup) (free).
- Logged in on this machine: `npx eas-cli whoami` (log in with `npx eas-cli login`).
- **First-time only** — create the EAS project so `extra.eas.projectId` gets
  written into `app.json`:

  ```bash
  cd frontend
  npx eas init
  ```

  Run this once; commit the resulting `projectId` change to `app.json`.

### Building a preview APK

From `frontend/`:

```bash
npm run build:preview
# equivalent to:
npx eas build --platform android --profile preview
```

### What happens during a build

1. EAS uploads your project to Expo's servers.
2. A remote worker installs deps, runs prebuild, and compiles the APK
   (**~10–15 minutes**; longer on first build / queue).
3. When done, the terminal prints a **build details URL** and a **direct APK
   download URL**. The build also appears at
   `https://expo.dev/accounts/<account>/projects/labify/builds`.

> **Env vars:** EAS remote builds do **not** read `frontend/.env`. The values the
> app needs (`API_BASE_URL`, `OCR_PROVIDER`) are baked in via the `env` block of
> the `preview`/`production` profiles in [`frontend/eas.json`](frontend/eas.json).
> `API_BASE_URL` is a public URL, so it lives in `eas.json` in plaintext — no
> `eas secret` needed. If you ever add a real secret (an API key), use
> `npx eas secret:create` instead of putting it in `eas.json`.

### Sharing the APK link

- Grab the **APK download URL** from the terminal output (or from the build's
  page on expo.dev → "Install").
- Send testers that link. It's a direct `.apk` download — no Expo account or
  Play Store needed on their end.

### Tester install instructions (send this to your testers)

1. Open the link on an **Android phone** (Chrome or any browser).
2. Tap the download; wait for the `.apk` to finish.
3. Open the downloaded file. If Android blocks it with *"For your security…"*:
   **Settings → Security → Install unknown apps →** pick the browser you used →
   enable **Allow from this source**, then reopen the APK.
4. Tap **Install**, then **Open**.
5. On first launch, **grant the camera permission** when prompted (required to
   scan). If you tapped "Deny", enable it later at **Settings → Apps → Labify →
   Permissions → Camera**.

### Common issues

| Symptom | Cause & fix |
|---|---|
| **"Network Error" / can't verify** | `API_BASE_URL` wasn't baked in. Confirm the `env` block in `eas.json`'s `preview` profile, then rebuild. |
| **Camera doesn't work / black screen** | Permission denied. Guide the tester to **Settings → Apps → Labify → Permissions → Camera → Allow**. |
| **First scan is very slow (~30–60s)** | Render free-tier cold start (see backend note above). Wait it out; later scans are fast. |
| **Build fails on EAS** | Run `npx expo-doctor` and `npx expo install --check` locally first (both must be clean), then read the EAS build logs at the build URL. |

### Pushing an update

1. Bump `android.versionCode` in [`frontend/app.json`](frontend/app.json) (e.g.
   `1` → `2`). Optionally bump `version` (the human-readable name).
2. Rebuild: `npm run build:preview`.
3. Share the new APK link. Testers install it **over the top** of the old one —
   app data (scan history, offline queue) is preserved because the package name
   (`com.labify.app`) is unchanged.

> The Android package name `com.labify.app` is **permanent** — changing it makes
> Android treat it as a different app (fresh install, no data carryover). Don't
> change it after the first release.

## How it works

1. The camera continuously scans for barcodes/QR codes.
2. On detection it captures a still photo of the label.
3. The photo + decoded barcode are POSTed to `POST /api/verify` (multipart).
4. The backend runs OCR, reads the printed RSN, and compares it to the barcode.
5. The app shows a result banner + details:
   - **PASS** (green) — barcode matches the label's RSN.
   - **FAIL** (red) — they disagree, or the RSN couldn't be read.
   - **WARNING** (amber) — off by one character, likely an OCR misread; review.
6. Audio + haptic feedback fire on the result (sound toggle in the header) so
   operators get confirmation without watching the screen.

## Not yet implemented (planned)

Result history, offline queue/caching, and auth are intentionally out of scope
for now — the current app is focused on: **scan → verify → show result → scan
again.**
