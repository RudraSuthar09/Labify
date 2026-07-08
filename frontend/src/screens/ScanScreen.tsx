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
} from '../types/verification';
import { useResultFeedback } from '../hooks/useResultFeedback';
import { usePendingSync } from '../hooks/usePendingSync';
import { extractRsn } from '../utils/barcode';

// Barcode formats we care about on battery-pack labels.
const BARCODE_TYPES: BarcodeType[] = [
  'qr',
  'code128',
  'code39',
  'datamatrix',
  'pdf417',
  'ean13',
];

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

type Phase = 'idle' | 'capturing' | 'verifying' | 'success' | 'queued' | 'error';

export default function ScanScreen() {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const playFeedback = useResultFeedback();
  const { count: pendingCount } = usePendingSync();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<VerificationError | null>(null);
  const [pendingBarcode, setPendingBarcode] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);

  // The image captured for the current scan — kept so Retry can reuse it.
  const pendingImageRef = useRef('');
  // Hard lock so the async capture/verify pipeline only runs once per scan.
  const busyRef = useRef(false);
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

  // Header actions: pending-sync badge (only when > 0) + sound toggle + settings
  // shortcut. `navigation.navigate` bubbles up from the tab navigator to the
  // root stack, so 'Settings' resolves even though it lives on a different
  // navigator.
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
    busyRef.current = false;
    lastScanRef.current = null;
    pendingImageRef.current = '';
    // Clear result/error and return to scanning in the same batch so no stale
    // data is visible for even a frame.
    setResult(null);
    setError(null);
    setPendingBarcode('');
    setPhase('idle');
  }, []);

  const runVerification = useCallback(
    async (barcode: string, imageUri: string, gen: number) => {
      try {
        const res = await verifyLabel(barcode, imageUri);
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

  const handleBarcode = useCallback(
    async (scan: BarcodeScanningResult) => {
      const now = Date.now();
      const last = lastScanRef.current;
      if (
        busyRef.current ||
        (last && last.value === scan.data && now - last.at < DEBOUNCE_MS)
      ) {
        return;
      }
      busyRef.current = true;
      lastScanRef.current = { value: scan.data, at: now };
      const gen = ++genRef.current;

      // The label's QR encodes an XML doc with the RSN inside <SRNO_7S>; the 1-D
      // barcode encodes the RSN directly. Reduce either to the bare RSN.
      const rsn = extractRsn(scan.data);

      // Show what was detected immediately, before the photo/verify round-trip.
      setPendingBarcode(rsn);
      setResult(null);
      setError(null);
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
      void runVerification(rsn, imageUri, gen);
    },
    [runVerification],
  );

  const handleRetry = useCallback(() => {
    const gen = ++genRef.current;
    setError(null);
    setResult(null);
    setPhase('verifying');
    void runVerification(pendingBarcode, pendingImageRef.current, gen);
  }, [pendingBarcode, runVerification]);

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

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        // Only listen while idle — pauses re-firing during capture/verify/result.
        onBarcodeScanned={phase === 'idle' ? handleBarcode : undefined}
      />

      {phase === 'idle' && (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.scanFrame} />
          <Text style={styles.guideText}>Align the label barcode inside the frame</Text>
        </View>
      )}

      {phase === 'capturing' && (
        <View style={styles.overlayDim} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.verifyingText}>Captured</Text>
          {pendingBarcode ? (
            <Text style={styles.capturedCode} numberOfLines={2}>
              {pendingBarcode}
            </Text>
          ) : null}
        </View>
      )}

      {phase === 'verifying' && (
        <VerifyingOverlay barcode={pendingBarcode} onCancel={handleCancelInFlight} />
      )}

      {phase === 'success' && result && (
        <ResultView result={result} onScanNext={resetToIdle} />
      )}

      {phase === 'queued' && (
        <QueuedView
          barcode={pendingBarcode}
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

  return (
    <SafeAreaView style={styles.resultRoot} edges={['top', 'bottom']}>
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Text style={styles.bannerText}>{banner.label}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.cardScroll}>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Scanned Barcode</Text>
          <Text style={styles.serialLarge} numberOfLines={2} selectable>
            {result.decodedBarcode}
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

  // Dimmed overlays (capturing / verifying)
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

  // Queued view (offline / server-hiccup safe state)
  queuedRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: '#F3F4F6' },
  queuedBanner: {
    width: '100%',
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0369A1', // slate/blue: distinct from pass/fail/warn
  },

  // Result view
  resultRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: '#F3F4F6' },
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
  cardScroll: { padding: 16 },
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

  calloutBox: { borderWidth: 1.5, borderRadius: 12, padding: 12, marginTop: 14, gap: 3 },
  calloutTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  calloutItem: { fontSize: 14, color: '#374151', lineHeight: 20 },
  mismatchBox: { borderColor: '#DC2626', backgroundColor: '#FEF2F2' },
  mismatchTitle: { color: '#DC2626' },
  missingBox: { borderColor: '#F59E0B', backgroundColor: '#FFFBEB' },
  missingTitle: { color: '#B45309' },

  reasonText: { fontSize: 14, color: '#6B7280', marginTop: 16, lineHeight: 20 },

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
