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
