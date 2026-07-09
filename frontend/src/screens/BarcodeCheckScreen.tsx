import { useCallback, useEffect, useRef, useState } from 'react';
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

import { extractRsn } from '../utils/barcode';
import { checkRilBarcode, RilCheckError, type RilCheckResult } from '../services/rilCheck';

const BARCODE_TYPES: BarcodeType[] = [
  'qr',
  'code128',
  'code39',
  'datamatrix',
  'pdf417',
  'ean13',
];

const DEBOUNCE_MS = 2000;

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type Phase = 'idle' | 'checking' | 'result' | 'error';

const STATUS_BANNER: Record<RilCheckResult['status'], { bg: string; label: string }> = {
  ok: { bg: '#16A34A', label: 'OK' },
  not_ok: { bg: '#DC2626', label: 'NOT OK' },
  unknown: { bg: '#F59E0B', label: 'UNKNOWN RESPONSE' },
};

export default function BarcodeCheckScreen() {
  const navigation = useNavigation();
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>('idle');
  const [scannedCode, setScannedCode] = useState<string>('');
  const [result, setResult] = useState<RilCheckResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const busyRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);

  useEffect(() => {
    navigation.setOptions({
      title: 'Quick Barcode Check',
      headerTitleAlign: 'center',
    });
  }, [navigation]);

  const resetToIdle = useCallback(() => {
    busyRef.current = false;
    lastScanRef.current = null;
    setScannedCode('');
    setResult(null);
    setErrorMessage('');
    setPhase('idle');
  }, []);

  const runCheck = useCallback(async (code: string) => {
    try {
      const res = await checkRilBarcode(code);
      setResult(res);
      setErrorMessage('');
      setPhase('result');
    } catch (e) {
      const msg =
        e instanceof RilCheckError
          ? e.message
          : 'Something went wrong. Please try again.';
      setErrorMessage(msg);
      setResult(null);
      setPhase('error');
    }
  }, []);

  const handleBarcode = useCallback(
    (scan: BarcodeScanningResult) => {
      if (busyRef.current) return;
      const now = Date.now();
      const last = lastScanRef.current;
      if (last && last.value === scan.data && now - last.at < DEBOUNCE_MS) {
        return;
      }
      lastScanRef.current = { value: scan.data, at: now };

      const rsn = extractRsn(scan.data);
      busyRef.current = true;
      setScannedCode(rsn);
      setPhase('checking');
      void runCheck(rsn);
    },
    [runCheck],
  );

  const handleRetry = useCallback(() => {
    if (!scannedCode) {
      resetToIdle();
      return;
    }
    setErrorMessage('');
    setResult(null);
    setPhase('checking');
    void runCheck(scannedCode);
  }, [scannedCode, runCheck, resetToIdle]);

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
            Labify uses the camera to scan barcodes.
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

  const scannerActive = phase === 'idle';

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        onBarcodeScanned={scannerActive ? handleBarcode : undefined}
      />

      {phase === 'idle' && (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.scanFrame} />
          <Text style={styles.guideText}>Scan the barcode</Text>
        </View>
      )}

      {phase === 'checking' && (
        <View style={styles.overlayDim}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.verifyingText}>Checking with RIL…</Text>
          {scannedCode ? (
            <Text style={styles.capturedCode} numberOfLines={2}>
              {scannedCode}
            </Text>
          ) : null}
        </View>
      )}

      {phase === 'result' && result && (
        <ResultView code={scannedCode} result={result} onScanNext={resetToIdle} />
      )}

      {phase === 'error' && (
        <ErrorView
          code={scannedCode}
          message={errorMessage}
          onRetry={handleRetry}
          onCancel={resetToIdle}
        />
      )}
    </View>
  );
}

function ResultView({
  code,
  result,
  onScanNext,
}: {
  code: string;
  result: RilCheckResult;
  onScanNext: () => void;
}) {
  const banner = STATUS_BANNER[result.status];
  return (
    <SafeAreaView style={styles.resultRoot} edges={['top', 'bottom']}>
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Text style={styles.bannerText}>{banner.label}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.cardScroll}>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Scanned Barcode</Text>
          <Text style={styles.serialLarge} numberOfLines={2} selectable>
            {code || '—'}
          </Text>

          <View style={styles.divider} />

          <Text style={styles.fieldLabel}>API Response</Text>
          <Text style={[styles.serialLarge, styles.messageValue]} selectable>
            {result.message || '(empty)'}
          </Text>

          <View style={styles.divider} />

          <Text style={styles.fieldLabel}>Raw response</Text>
          <Text style={styles.detailsMono} selectable>
            {JSON.stringify(result.raw, null, 2)}
          </Text>
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

function ErrorView({
  code,
  message,
  onRetry,
  onCancel,
}: {
  code: string;
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <SafeAreaView style={styles.errorRoot} edges={['top', 'bottom']}>
      <View style={styles.errorCard}>
        <Text style={styles.errorEmoji}>⚠️</Text>
        <Text style={styles.errorTitle}>Couldn’t check barcode</Text>
        {code ? (
          <Text style={styles.errorCode} numberOfLines={2} selectable>
            {code}
          </Text>
        ) : null}
        <Text style={styles.errorMessage}>{message}</Text>
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
  messageBox: { alignItems: 'center', gap: 16, maxWidth: 360 },
  title: { fontSize: 26, fontWeight: '800', color: '#111', textAlign: 'center' },
  body: { fontSize: 17, color: '#333', textAlign: 'center', lineHeight: 24 },

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
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
  },
  serialLarge: { fontSize: 24, fontFamily: MONO, color: '#111827', marginTop: 2 },
  messageValue: { fontFamily: undefined, fontWeight: '700' },
  divider: { height: 1, backgroundColor: '#E5E7EB', marginVertical: 16 },
  detailsMono: {
    fontSize: 12,
    fontFamily: MONO,
    color: '#4B5563',
    marginTop: 4,
    lineHeight: 18,
  },

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
  errorCode: { fontSize: 16, fontFamily: MONO, color: '#374151' },
  errorMessage: { fontSize: 16, color: '#374151', textAlign: 'center', lineHeight: 22 },

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
  secondaryButtonOnLight: { borderColor: '#9CA3AF' },
  secondaryButtonTextOnLight: { color: '#374151' },
});
