import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from 'expo-camera';

import { verifyLabel, type VerificationResult } from '../services/verification';

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

type Phase = 'scanning' | 'verifying' | 'result';

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [phase, setPhase] = useState<Phase>('scanning');
  const [result, setResult] = useState<VerificationResult | null>(null);

  // Debounce guard: remember the last code + time so rapid re-fires are dropped.
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  // Hard lock so the async capture/verify pipeline only runs once per scan.
  const busyRef = useRef(false);

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

      setPhase('verifying');
      setResult(null);

      let imageUri = '';
      try {
        // Note: no `skipProcessing` — we want a correctly EXIF-oriented image so
        // OCR (later) reads the label the right way up. This matters on iOS.
        const photo = await cameraRef.current?.takePictureAsync({
          quality: 0.6,
        });
        imageUri = photo?.uri ?? '';
      } catch {
        // Non-fatal: verification can still proceed with just the barcode value.
      }

      try {
        const res = await verifyLabel(scan.data, imageUri);
        setResult(res);
      } catch (err) {
        setResult({
          status: 'fail',
          message: err instanceof Error ? err.message : 'Verification failed.',
          barcodeValue: scan.data,
        });
      } finally {
        setPhase('result');
      }
    },
    [],
  );

  const scanNext = useCallback(() => {
    setResult(null);
    lastScanRef.current = null;
    busyRef.current = false;
    setPhase('scanning');
  }, []);

  // --- Permission states -----------------------------------------------------

  if (!permission) {
    // Permissions still loading.
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
            LabelVerify uses the camera to scan barcodes on battery-pack labels.
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() =>
              canAskAgain ? requestPermission() : Linking.openSettings()
            }
          >
            <Text style={styles.primaryButtonText}>
              {canAskAgain ? 'Grant camera access' : 'Open Settings'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // --- Camera + overlay ------------------------------------------------------

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        // Only listen while actively scanning — this pauses re-firing.
        onBarcodeScanned={phase === 'scanning' ? handleBarcode : undefined}
      />

      {/* Scanning frame guide */}
      {phase === 'scanning' && (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.scanFrame} />
          <Text style={styles.guideText}>Align the label barcode inside the frame</Text>
        </View>
      )}

      {/* Verifying state */}
      {phase === 'verifying' && (
        <View style={styles.overlayDim}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.verifyingText}>Verifying…</Text>
        </View>
      )}

      {/* Result state */}
      {phase === 'result' && result && (
        <View style={styles.overlayDim}>
          <ResultCard result={result} />
          <Pressable style={styles.primaryButton} onPress={scanNext}>
            <Text style={styles.primaryButtonText}>Scan Next</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function ResultCard({ result }: { result: VerificationResult }) {
  const { bg, label } =
    result.status === 'pass'
      ? { bg: '#1b8a3a', label: 'PASS' }
      : result.status === 'fail'
        ? { bg: '#c0261e', label: 'FAIL' }
        : { bg: '#8a6d1b', label: 'PENDING' };

  return (
    <View style={[styles.resultCard, { backgroundColor: bg }]}>
      <Text style={styles.resultLabel}>{label}</Text>
      {result.barcodeValue ? (
        <Text style={styles.resultValue} numberOfLines={2}>
          {result.barcodeValue}
        </Text>
      ) : null}
      {result.message ? <Text style={styles.resultMessage}>{result.message}</Text> : null}
    </View>
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

  // Permission message
  messageBox: { alignItems: 'center', gap: 16, maxWidth: 360 },
  title: { fontSize: 26, fontWeight: '800', color: '#111', textAlign: 'center' },
  body: { fontSize: 17, color: '#333', textAlign: 'center', lineHeight: 24 },

  // Overlay + scan frame
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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

  // Dimmed overlays (verifying / result)
  overlayDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 24,
    gap: 24,
  },
  verifyingText: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 12 },

  // Result card
  resultCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    gap: 10,
  },
  resultLabel: { color: '#fff', fontSize: 48, fontWeight: '900', letterSpacing: 2 },
  resultValue: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  resultMessage: { color: 'rgba(255,255,255,0.9)', fontSize: 15, textAlign: 'center' },

  // Buttons — big touch targets, high contrast
  primaryButton: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 14,
    minWidth: 240,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 20, fontWeight: '800' },
});
