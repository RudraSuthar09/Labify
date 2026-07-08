import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from 'expo-camera';

import { verifyLabel, VerificationCallError } from '../services/verification';
import { enqueue } from '../services/offlineQueue';
import type {
  VerificationResult,
  VerificationError,
  VerificationStatus,
  CodesDetected,
} from '../types/verification';
import { useResultFeedback } from '../hooks/useResultFeedback';
import { usePendingSync } from '../hooks/usePendingSync';
import { extractRsn } from '../utils/barcode';

// Barcode formats we care about on battery-pack labels. The scanner reports the
// linear barcode AND the QR code from the same frame, which Check A relies on.
const BARCODE_TYPES: BarcodeType[] = [
  'qr',
  'code128',
  'code39',
  'datamatrix',
  'pdf417',
  'ean13',
];

// After the FIRST code is seen, keep collecting for this long so we can capture
// both the linear barcode and the QR code before firing verification (Check A).
const COLLECT_WINDOW_MS = 2000;

// Ignore repeat detections of the same code within this window (ms).
const DEBOUNCE_MS = 2000;

// Monospace face for serials — Menlo on iOS, monospace on Android.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// Result banner colours (Tailwind green-600 / red-600 / amber-500).
const BANNER: Record<VerificationStatus, { bg: string; label: string }> = {
  pass: { bg: '#16A34A', label: 'PASS' },
  fail: { bg: '#DC2626', label: 'FAIL' },
  warning: { bg: '#F59E0B', label: 'WARNING · Review Required' },
};

/** Per-check row status. Drives the icon + colour in the Checks panel. */
type CheckState = 'pass' | 'fail' | 'warning' | 'skipped';

const CHECK_ICON: Record<CheckState, { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: '#16A34A' },
  fail: { glyph: '✗', color: '#DC2626' },
  warning: { glyph: '⚠', color: '#F59E0B' },
  skipped: { glyph: '—', color: '#9CA3AF' },
};

type Phase =
  | 'idle'
  | 'collecting'
  | 'capturing'
  | 'verifying'
  | 'success'
  | 'queued'
  | 'error';

/** True for QR (and QR-like 2D) codes; everything else is a linear barcode. */
function isQrType(type: string): boolean {
  return type === 'qr';
}

export default function ScanScreen() {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const playFeedback = useResultFeedback();
  const { count: pendingCount } = usePendingSync();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<VerificationError | null>(null);
  // What we've collected in the current window, for the "Detecting…" overlay.
  const [detected, setDetected] = useState<{ barcode: string | null; qr: string | null }>({
    barcode: null,
    qr: null,
  });
  const [soundEnabled, setSoundEnabled] = useState(true);

  // The image captured for the current scan — kept so Retry can reuse it.
  const pendingImageRef = useRef('');
  // The codes collected for the current scan — kept so Retry can reuse them.
  const pendingCodesRef = useRef<{ barcode: string | null; qr: string | null }>({
    barcode: null,
    qr: null,
  });
  // Hard lock so the async capture/verify pipeline only runs once per scan.
  const busyRef = useRef(false);
  // True while inside the 2s collection window (readable from the scan callback).
  const collectingRef = useRef(false);
  // Codes accumulated during the current collection window.
  const collectedRef = useRef<{ barcode: string | null; qr: string | null }>({
    barcode: null,
    qr: null,
  });
  // Handle for the collection-window timer, so we can cancel it on reset.
  const collectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce guard: last code + time so rapid re-fires are dropped.
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  // Generation counter — bumping it invalidates any in-flight capture/verify
  // (used by Cancel and Scan Next so stale results never land on screen).
  const genRef = useRef(0);
  // Latest soundEnabled, readable from async callbacks without stale closures.
  const soundRef = useRef(soundEnabled);
  useEffect(() => {
    soundRef.current = soundEnabled;
  }, [soundEnabled]);

  // Clean up any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (collectTimerRef.current) clearTimeout(collectTimerRef.current);
    };
  }, []);

  // Header sound toggle (the only setting for now).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          {pendingCount > 0 ? (
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              hitSlop={12}
              accessibilityLabel={`${pendingCount} scans pending sync`}
              style={styles.pendingBadge}
            >
              <Text style={styles.pendingBadgeText}>↑ {pendingCount}</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setSoundEnabled((v) => !v)}
            hitSlop={12}
            accessibilityLabel={soundEnabled ? 'Mute result sounds' : 'Unmute result sounds'}
            style={styles.headerButton}
          >
            <Text style={styles.headerIcon}>{soundEnabled ? '🔊' : '🔇'}</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            hitSlop={12}
            accessibilityLabel="Open settings"
            style={styles.headerButton}
          >
            <Text style={styles.headerIcon}>⚙️</Text>
          </Pressable>
        </View>
      ),
    });
  }, [navigation, soundEnabled, pendingCount]);

  const resetToIdle = useCallback(() => {
    genRef.current += 1; // invalidate anything in flight
    if (collectTimerRef.current) {
      clearTimeout(collectTimerRef.current);
      collectTimerRef.current = null;
    }
    busyRef.current = false;
    collectingRef.current = false;
    collectedRef.current = { barcode: null, qr: null };
    lastScanRef.current = null;
    pendingImageRef.current = '';
    pendingCodesRef.current = { barcode: null, qr: null };
    // Clear result/error and return to scanning in the same batch so no stale
    // data is visible for even a frame.
    setResult(null);
    setError(null);
    setDetected({ barcode: null, qr: null });
    setPhase('idle');
  }, []);

  const runVerification = useCallback(
    async (
      barcode: string | null,
      qr: string | null,
      imageUri: string,
      gen: number,
    ) => {
      try {
        const res = await verifyLabel(barcode, qr, imageUri);
        if (gen !== genRef.current) return; // cancelled / reset meanwhile
        setResult(res);
        setError(null);
        setPhase('success');
        playFeedback(res.status, soundRef.current);
      } catch (e) {
        if (gen !== genRef.current) return;
        const info: VerificationError =
          e instanceof VerificationCallError
            ? e.info
            : { kind: 'unknown', message: 'Something went wrong. Please try again.' };

        // Never lose a scan — persist to the offline queue so it retries when
        // connectivity comes back. The only case where we can't queue is when
        // the camera never produced a usable image; then there's nothing worth
        // saving and we show the raw error instead.
        const enqueued = await enqueue({
          barcodeValue: barcode,
          qrValue: qr,
          labelType: 'battery_pack',
          imageUri,
          cause: info,
        });
        if (gen !== genRef.current) return;

        if (enqueued.ok) {
          setResult(null);
          setError(info); // kept so the QueuedView can show "why" it was queued
          setPhase('queued');
        } else {
          // No image to queue — surface the error and let the operator rescan.
          setError(info);
          setResult(null);
          setPhase('error');
        }
      }
    },
    [playFeedback],
  );

  // Runs when the 2s collection window closes: capture the still and verify with
  // whatever codes were gathered (barcode, qr, or both).
  const finishCollection = useCallback(
    async (gen: number) => {
      if (gen !== genRef.current) return; // cancelled during the window
      collectingRef.current = false;
      collectTimerRef.current = null;
      busyRef.current = true;

      const codes = collectedRef.current;
      pendingCodesRef.current = codes;
      setPhase('capturing');

      // Yield one frame so the CameraView finishes handling the barcode scan
      // before we ask it to capture a still — on Android, calling
      // takePictureAsync inside onBarcodeScanned races the scanner and throws
      // "Failed to capture image".
      await new Promise((r) => setTimeout(r, 350));

      let imageUri = '';
      const takeOnce = async () => {
        // No skipProcessing — we want a correctly EXIF-oriented image so OCR
        // reads the label the right way up (matters on iOS).
        return cameraRef.current?.takePictureAsync({ quality: 0.6 });
      };
      try {
        let photo = await takeOnce();
        if (!photo?.uri) {
          // Android sometimes needs autofocus to settle after the scan frame
          // before it will hand us a still — one retry with a longer wait.
          await new Promise((r) => setTimeout(r, 500));
          photo = await takeOnce();
        }
        imageUri = photo?.uri ?? '';
      } catch {
        // Non-fatal: the verify call will surface a clear error if the image
        // is missing.
      }

      if (gen !== genRef.current) return; // cancelled during capture
      pendingImageRef.current = imageUri;
      setPhase('verifying');
      void runVerification(codes.barcode, codes.qr, imageUri, gen);
    },
    [runVerification],
  );

  const handleBarcode = useCallback(
    (scan: BarcodeScanningResult) => {
      if (busyRef.current) return;

      const now = Date.now();
      const last = lastScanRef.current;
      // Reduce the QR XML / linear payload to the bare RSN before storing.
      const rsn = extractRsn(scan.data);
      const isQr = isQrType(scan.type);

      if (!collectingRef.current) {
        // First code of a new scan → open the collection window.
        if (
          last &&
          last.value === scan.data &&
          now - last.at < DEBOUNCE_MS
        ) {
          return; // still cooling down from the previous scan
        }
        lastScanRef.current = { value: scan.data, at: now };

        const gen = ++genRef.current;
        collectingRef.current = true;
        collectedRef.current = { barcode: null, qr: null };
        if (isQr) collectedRef.current.qr = rsn;
        else collectedRef.current.barcode = rsn;
        setDetected({ ...collectedRef.current });
        setPhase('collecting');

        collectTimerRef.current = setTimeout(() => {
          void finishCollection(gen);
        }, COLLECT_WINDOW_MS);
        return;
      }

      // Already collecting → record the first value seen for each type.
      if (isQr) {
        if (!collectedRef.current.qr) {
          collectedRef.current.qr = rsn;
          setDetected({ ...collectedRef.current });
        }
      } else if (!collectedRef.current.barcode) {
        collectedRef.current.barcode = rsn;
        setDetected({ ...collectedRef.current });
      }
    },
    [finishCollection],
  );

  const handleRetry = useCallback(() => {
    const gen = ++genRef.current;
    busyRef.current = true;
    setError(null);
    setResult(null);
    setPhase('verifying');
    const { barcode, qr } = pendingCodesRef.current;
    void runVerification(barcode, qr, pendingImageRef.current, gen);
  }, [runVerification]);

  const handleCancelInFlight = useCallback(() => {
    // Invalidate the in-flight request and go back to scanning.
    resetToIdle();
  }, [resetToIdle]);

  // --- Permission states -----------------------------------------------------

  if (!permission) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain;
    return (
      <SafeAreaView style={styles.centered}>
        <View style={styles.messageBox}>
          <Text style={styles.title}>Camera access needed</Text>
          <Text style={styles.body}>
            Labify uses the camera to scan barcodes on battery-pack labels.
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => (canAskAgain ? requestPermission() : Linking.openSettings())}
          >
            <Text style={styles.primaryButtonText}>
              {canAskAgain ? 'Grant camera access' : 'Open Settings'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // --- Camera + overlays -----------------------------------------------------

  const scannerActive = phase === 'idle' || phase === 'collecting';

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        // Listen while idle AND during the collection window so both codes land.
        onBarcodeScanned={scannerActive ? handleBarcode : undefined}
      />

      {phase === 'idle' && (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.scanFrame} />
          <Text style={styles.guideText}>
            Align the label so the barcode and QR code are both in the frame
          </Text>
        </View>
      )}

      {phase === 'collecting' && (
        <View style={styles.overlayDim} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.verifyingText}>Detecting all codes…</Text>
          <View style={styles.detectRow}>
            <Text style={[styles.detectChip, detected.barcode && styles.detectChipOn]}>
              {detected.barcode ? '✓' : '○'} Barcode
            </Text>
            <Text style={[styles.detectChip, detected.qr && styles.detectChipOn]}>
              {detected.qr ? '✓' : '○'} QR
            </Text>
          </View>
        </View>
      )}

      {phase === 'capturing' && (
        <View style={styles.overlayDim} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.verifyingText}>Captured</Text>
        </View>
      )}

      {phase === 'verifying' && (
        <VerifyingOverlay
          barcode={pendingCodesRef.current.barcode ?? pendingCodesRef.current.qr ?? ''}
          onCancel={handleCancelInFlight}
        />
      )}

      {phase === 'success' && result && (
        <ResultView result={result} onScanNext={resetToIdle} />
      )}

      {phase === 'queued' && (
        <QueuedView
          barcode={pendingCodesRef.current.barcode ?? pendingCodesRef.current.qr ?? ''}
          cause={error}
          onScanNext={resetToIdle}
          onOpenSettings={() => navigation.navigate('Settings')}
        />
      )}

      {phase === 'error' && error && (
        <ErrorView error={error} onRetry={handleRetry} onCancel={resetToIdle} />
      )}
    </View>
  );
}

// --- Verifying overlay (with escalating messaging) ---------------------------

function VerifyingOverlay({
  barcode,
  onCancel,
}: {
  barcode: string;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(id);
  }, []);

  const message =
    elapsed >= 5000
      ? 'Still verifying… (server may be waking up, the first scan can take up to a minute)'
      : 'Verifying…';

  return (
    <View style={styles.overlayDim}>
      <ActivityIndicator size="large" color="#fff" />
      <Text style={styles.verifyingText}>{message}</Text>
      {barcode ? (
        <Text style={styles.capturedCode} numberOfLines={2}>
          {barcode}
        </Text>
      ) : null}
      {elapsed >= 15000 ? (
        <Pressable style={styles.secondaryButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// --- Per-check status derivation ---------------------------------------------

/** Codes-match row: compare every present code value (barcode / qr / printed). */
function codesRowState(codes: CodesDetected): { state: CheckState; summary: string } {
  const present = [codes.barcode, codes.qr, codes.printedRsn].filter(
    (v): v is string => !!v,
  );
  if (present.length === 0) {
    return { state: 'skipped', summary: 'No codes detected' };
  }
  const allEqual = present.every((v) => v === present[0]);
  if (!allEqual) {
    return { state: 'fail', summary: 'Detected codes disagree' };
  }
  if (present.length === 3) {
    return { state: 'pass', summary: 'Barcode = QR = Printed RSN' };
  }
  return {
    state: 'warning',
    summary: `Only ${present.length} of 3 detected; they agree`,
  };
}

function configRowState(
  match: boolean | null,
  headerConfig: string | null,
  rsnConfigChar: string | null,
): { state: CheckState; summary: string } {
  if (match === null) {
    return { state: 'skipped', summary: 'Config code not readable' };
  }
  if (match) {
    return {
      state: 'pass',
      summary: `Header ${headerConfig}S1P ↔ RSN digit ${rsnConfigChar}`,
    };
  }
  return {
    state: 'fail',
    summary: `Header ${headerConfig}S1P ≠ RSN digit ${rsnConfigChar}`,
  };
}

function fieldsRowState(missingFields: string[]): { state: CheckState; summary: string } {
  const missing = missingFields.filter((f) => f !== 'ConfigCode');
  if (missing.length === 0) {
    return { state: 'pass', summary: 'All fields readable' };
  }
  return {
    state: 'warning',
    summary: `Missing: ${missing.join(', ')}`,
  };
}

function externalRowState(
  status: VerificationResult['externalValidation']['status'],
  rawMessage: string,
): { state: CheckState; summary: string } {
  switch (status) {
    case 'ok':
      return { state: 'pass', summary: 'Message1: OK' };
    case 'not_ok':
      return { state: 'fail', summary: 'Message1: NOT_OK' };
    case 'error':
      return { state: 'warning', summary: rawMessage || 'API unreachable' };
    case 'skipped':
    default:
      return { state: 'skipped', summary: rawMessage || 'Skipped' };
  }
}

function CheckRow({
  state,
  title,
  summary,
}: {
  state: CheckState;
  title: string;
  summary: string;
}) {
  const icon = CHECK_ICON[state];
  return (
    <View style={styles.checkRow}>
      <Text style={[styles.checkIcon, { color: icon.color }]}>{icon.glyph}</Text>
      <View style={styles.checkTextCol}>
        <Text style={styles.checkTitle}>{title}</Text>
        <Text style={styles.checkSummary} numberOfLines={2}>
          {summary}
        </Text>
      </View>
    </View>
  );
}

// --- Result view -------------------------------------------------------------

function ResultView({
  result,
  onScanNext,
}: {
  result: VerificationResult;
  onScanNext: () => void;
}) {
  const banner = BANNER[result.status];
  const fields = Object.entries(result.extractedFields);
  const [showDetails, setShowDetails] = useState(false);

  const codesRow = codesRowState(result.codesDetected);
  const configRow = configRowState(
    result.configCheck.match,
    result.configCheck.headerConfig,
    result.configCheck.rsnConfigChar,
  );
  const fieldsRow = fieldsRowState(result.missingFields);
  const externalRow = externalRowState(
    result.externalValidation.status,
    result.externalValidation.rawMessage,
  );

  return (
    <SafeAreaView style={styles.resultRoot} edges={['top', 'bottom']}>
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Text style={styles.bannerText}>{banner.label}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.cardScroll}>
        {/* Checks panel — the at-a-glance summary operators scan first. */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Checks</Text>
          <CheckRow state={codesRow.state} title="Codes Match" summary={codesRow.summary} />
          <CheckRow state={configRow.state} title="Config Check" summary={configRow.summary} />
          <CheckRow
            state={fieldsRow.state}
            title="Field Extraction"
            summary={fieldsRow.summary}
          />
          <CheckRow
            state={externalRow.state}
            title="External API"
            summary={externalRow.summary}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Scanned Barcode</Text>
          <Text style={styles.serialLarge} numberOfLines={2} selectable>
            {result.decodedBarcode ?? '—'}
          </Text>

          <Text style={[styles.fieldLabel, styles.spacedTop]}>Scanned QR</Text>
          <Text
            style={[styles.serialLarge, !result.decodedQr && styles.mutedSerial]}
            numberOfLines={2}
            selectable
          >
            {result.decodedQr ?? 'Not detected'}
          </Text>

          <Text style={[styles.fieldLabel, styles.spacedTop]}>Expected (from label)</Text>
          <Text
            style={[styles.serialLarge, !result.expectedValue && styles.mutedSerial]}
            numberOfLines={2}
            selectable
          >
            {result.expectedValue ?? 'Not found'}
          </Text>

          <View style={styles.divider} />

          <Text style={styles.sectionTitle}>Extracted Fields</Text>
          {fields.length === 0 ? (
            <Text style={styles.mutedText}>No fields were read from the label.</Text>
          ) : (
            fields.map(([key, value]) => (
              <View key={key} style={styles.kvRow}>
                <Text style={styles.kvKey}>{key}</Text>
                <Text style={styles.kvValue} selectable>
                  {value}
                </Text>
              </View>
            ))
          )}

          {result.mismatches.length > 0 && (
            <View style={[styles.calloutBox, styles.mismatchBox]}>
              <Text style={[styles.calloutTitle, styles.mismatchTitle]}>Mismatches</Text>
              {result.mismatches.map((m, i) => (
                <Text key={`${m.field}-${i}`} style={styles.calloutItem}>
                  • {m.field}: expected {m.expected}, got {m.got}
                </Text>
              ))}
            </View>
          )}

          {result.missingFields.length > 0 && (
            <View style={[styles.calloutBox, styles.missingBox]}>
              <Text style={[styles.calloutTitle, styles.missingTitle]}>Missing Fields</Text>
              {result.missingFields.map((f) => (
                <Text key={f} style={styles.calloutItem}>
                  • {f}
                </Text>
              ))}
            </View>
          )}

          <Text style={styles.reasonText}>{result.reason}</Text>

          {/* Details toggle — full OCR text, raw API response, detected codes. */}
          <Pressable
            style={styles.detailsToggle}
            onPress={() => setShowDetails((v) => !v)}
          >
            <Text style={styles.detailsToggleText}>
              {showDetails ? '▾ Hide details' : '▸ Details'}
            </Text>
          </Pressable>

          {showDetails && (
            <View style={styles.detailsBox}>
              <Text style={styles.detailsHeading}>Detected codes</Text>
              <Text style={styles.detailsMono} selectable>
                barcode: {result.codesDetected.barcode ?? '—'}
                {'\n'}qr: {result.codesDetected.qr ?? '—'}
                {'\n'}printed: {result.codesDetected.printedRsn ?? '—'}
              </Text>

              <Text style={[styles.detailsHeading, styles.spacedTop]}>
                External API response
              </Text>
              <Text style={styles.detailsMono} selectable>
                status: {result.externalValidation.status}
                {'\n'}Message1: {result.externalValidation.rawMessage || '—'}
                {result.externalValidation.error
                  ? `\nerror: ${result.externalValidation.error}`
                  : ''}
                {'\n'}durationMs: {result.externalValidation.durationMs}
              </Text>

              <Text style={[styles.detailsHeading, styles.spacedTop]}>Full OCR text</Text>
              <Text style={styles.detailsMono} selectable>
                {result.ocrText || '(empty)'}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={styles.primaryButton} onPress={onScanNext}>
          <Text style={styles.primaryButtonText}>Scan Next</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// --- Queued view (verification failed but scan is safe in the offline queue) -

function QueuedView({
  barcode,
  cause,
  onScanNext,
  onOpenSettings,
}: {
  barcode: string;
  cause: VerificationError | null;
  onScanNext: () => void;
  onOpenSettings: () => void;
}) {
  const humanReason =
    cause?.kind === 'network' || cause?.kind === 'timeout'
      ? 'You’re offline. This scan is safe on the device and will verify automatically when you’re back on the network.'
      : 'The server couldn’t verify this scan just now. It’s safe on the device and will retry automatically.';
  return (
    <SafeAreaView style={styles.queuedRoot} edges={['top', 'bottom']}>
      <View style={styles.queuedBanner}>
        <Text style={styles.bannerText}>QUEUED · Will verify later</Text>
      </View>
      <ScrollView contentContainerStyle={styles.cardScroll}>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Scanned Barcode</Text>
          <Text style={styles.serialLarge} numberOfLines={2} selectable>
            {barcode || '—'}
          </Text>

          <View style={styles.divider} />

          <Text style={styles.reasonText}>{humanReason}</Text>
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Pressable style={styles.primaryButton} onPress={onScanNext}>
          <Text style={styles.primaryButtonText}>Scan Next</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, styles.secondaryButtonOnLight]}
          onPress={onOpenSettings}
        >
          <Text style={[styles.secondaryButtonText, styles.secondaryButtonTextOnLight]}>
            View queue
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// --- Error view --------------------------------------------------------------

function ErrorView({
  error,
  onRetry,
  onCancel,
}: {
  error: VerificationError;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <SafeAreaView style={styles.errorRoot} edges={['top', 'bottom']}>
      <View style={styles.errorCard}>
        <Text style={styles.errorEmoji}>⚠️</Text>
        <Text style={styles.errorTitle}>Couldn’t verify</Text>
        <Text style={styles.errorMessage}>{error.message}</Text>
      </View>
      <View style={styles.footer}>
        <Pressable style={styles.primaryButton} onPress={onRetry}>
          <Text style={styles.primaryButtonText}>Retry</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, styles.secondaryButtonOnLight]}
          onPress={onCancel}
        >
          <Text style={[styles.secondaryButtonText, styles.secondaryButtonTextOnLight]}>
            Cancel &amp; Rescan
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    padding: 24,
  },

  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerButton: { paddingHorizontal: 10, paddingVertical: 4 },
  headerIcon: { fontSize: 20 },
  pendingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginRight: 4,
  },
  pendingBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  // Permission message
  messageBox: { alignItems: 'center', gap: 16, maxWidth: 360 },
  title: { fontSize: 26, fontWeight: '800', color: '#111', textAlign: 'center' },
  body: { fontSize: 17, color: '#333', textAlign: 'center', lineHeight: 24 },

  // Scanning overlay
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: '80%',
    aspectRatio: 1.4,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  guideText: {
    marginTop: 24,
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 24,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },

  // Dimmed overlays (collecting / capturing / verifying)
  overlayDim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 24,
    gap: 16,
  },
  verifyingText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  capturedCode: {
    color: '#fff',
    fontSize: 18,
    fontFamily: MONO,
    textAlign: 'center',
    opacity: 0.9,
  },
  detectRow: { flexDirection: 'row', gap: 12 },
  detectChip: {
    color: '#D1D5DB',
    fontSize: 16,
    fontWeight: '700',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    overflow: 'hidden',
  },
  detectChipOn: {
    color: '#052e16',
    backgroundColor: '#4ADE80',
    borderColor: '#4ADE80',
  },

  // Result view
  resultRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: '#F3F4F6' },
  // Queued view reuses the result layout with a neutral blue-grey banner.
  queuedRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: '#F3F4F6' },
  queuedBanner: {
    width: '100%',
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#475569',
  },
  banner: {
    width: '100%',
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerText: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 1,
    textAlign: 'center',
  },
  cardScroll: { padding: 16, gap: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#6B7280', textTransform: 'uppercase' },
  spacedTop: { marginTop: 12 },
  serialLarge: { fontSize: 24, fontFamily: MONO, color: '#111827', marginTop: 2 },
  mutedSerial: { color: '#9CA3AF' },
  divider: { height: 1, backgroundColor: '#E5E7EB', marginVertical: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#374151', marginBottom: 6 },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 4,
    gap: 12,
  },
  kvKey: { fontSize: 15, color: '#4B5563', flexShrink: 1 },
  kvValue: {
    fontSize: 15,
    fontFamily: MONO,
    color: '#111827',
    textAlign: 'right',
    flexShrink: 1,
  },
  mutedText: { fontSize: 14, color: '#9CA3AF', fontStyle: 'italic' },

  // Checks panel
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  checkIcon: { fontSize: 22, fontWeight: '900', width: 26, textAlign: 'center' },
  checkTextCol: { flex: 1 },
  checkTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  checkSummary: { fontSize: 13, color: '#6B7280', marginTop: 1 },

  calloutBox: { borderWidth: 1.5, borderRadius: 12, padding: 12, marginTop: 14, gap: 3 },
  calloutTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  calloutItem: { fontSize: 14, color: '#374151', lineHeight: 20 },
  mismatchBox: { borderColor: '#DC2626', backgroundColor: '#FEF2F2' },
  mismatchTitle: { color: '#DC2626' },
  missingBox: { borderColor: '#F59E0B', backgroundColor: '#FFFBEB' },
  missingTitle: { color: '#B45309' },

  reasonText: { fontSize: 14, color: '#6B7280', marginTop: 16, lineHeight: 20 },

  // Details toggle
  detailsToggle: { marginTop: 16, paddingVertical: 8 },
  detailsToggleText: { fontSize: 15, fontWeight: '700', color: '#0a7ea4' },
  detailsBox: {
    marginTop: 4,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  detailsHeading: { fontSize: 13, fontWeight: '700', color: '#374151' },
  detailsMono: {
    fontSize: 12,
    fontFamily: MONO,
    color: '#4B5563',
    marginTop: 4,
    lineHeight: 18,
  },

  // Error view
  errorRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F3F4F6',
    justifyContent: 'space-between',
  },
  errorCard: {
    margin: 16,
    marginTop: 40,
    backgroundColor: '#fff',
    borderRadius: 16,
    borderLeftWidth: 6,
    borderLeftColor: '#DC2626',
    padding: 24,
    alignItems: 'center',
    gap: 10,
  },
  errorEmoji: { fontSize: 40 },
  errorTitle: { fontSize: 22, fontWeight: '800', color: '#111827' },
  errorMessage: { fontSize: 16, color: '#374151', textAlign: 'center', lineHeight: 22 },

  // Footer / buttons
  footer: { padding: 16, gap: 12 },
  primaryButton: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  secondaryButton: {
    backgroundColor: 'transparent',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#9CA3AF',
  },
  secondaryButtonText: { color: '#E5E7EB', fontSize: 17, fontWeight: '700' },
  // On a light background (error view) the border + text need to be darker.
  secondaryButtonOnLight: { borderColor: '#9CA3AF' },
  secondaryButtonTextOnLight: { color: '#374151' },
});
