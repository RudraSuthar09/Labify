/**
 * Detail view for a single archived scan.
 *
 * Receives the scan payload via nav params (the list already has everything —
 * no re-fetch needed) and displays image + banner + fields + mismatches +
 * reason. The layout mirrors `ScanScreen`'s ResultView so switching between
 * "just scanned it" and "reviewing it from history" is visually seamless.
 */
import { useLayoutEffect } from 'react';
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import type { VerificationStatus } from '../types/verification';
import type { RootStackParamList } from '../types/navigation';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const BANNER: Record<VerificationStatus, { bg: string; label: string }> = {
  pass: { bg: '#16A34A', label: 'PASS' },
  fail: { bg: '#DC2626', label: 'FAIL' },
  warning: { bg: '#F59E0B', label: 'WARNING · Review Required' },
};

export default function ScanDetailScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'ScanDetail'>>();
  const { scan } = route.params;
  const banner = BANNER[scan.status];
  const fields = Object.entries(scan.extractedFields);

  useLayoutEffect(() => {
    navigation.setOptions({ title: banner.label.split(' ')[0] });
  }, [navigation, banner.label]);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Text style={styles.bannerText}>{banner.label}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {scan.imageUrl ? (
          <Image source={{ uri: scan.imageUrl }} style={styles.image} resizeMode="contain" />
        ) : (
          <View style={[styles.image, styles.imagePlaceholder]}>
            <Text style={styles.imagePlaceholderText}>Image not archived</Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Scanned Barcode</Text>
          <Text style={styles.serialLarge} selectable>
            {scan.decodedBarcode}
          </Text>

          <Text style={[styles.fieldLabel, styles.spacedTop]}>Expected (from label)</Text>
          <Text
            style={[styles.serialLarge, !scan.expectedValue && styles.mutedSerial]}
            selectable
          >
            {scan.expectedValue ?? 'Not found'}
          </Text>

          <Text style={[styles.fieldLabel, styles.spacedTop]}>Scanned</Text>
          <Text style={styles.value}>{formatFullTimestamp(scan.createdAt)}</Text>

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

          {scan.mismatches.length > 0 && (
            <View style={[styles.calloutBox, styles.mismatchBox]}>
              <Text style={[styles.calloutTitle, styles.mismatchTitle]}>Mismatches</Text>
              {scan.mismatches.map((m, i) => (
                <Text key={`${m.field}-${i}`} style={styles.calloutItem}>
                  • {m.field}: expected {m.expected}, got {m.got}
                </Text>
              ))}
            </View>
          )}

          {scan.missingFields.length > 0 && (
            <View style={[styles.calloutBox, styles.missingBox]}>
              <Text style={[styles.calloutTitle, styles.missingTitle]}>Missing Fields</Text>
              {scan.missingFields.map((f) => (
                <Text key={f} style={styles.calloutItem}>
                  • {f}
                </Text>
              ))}
            </View>
          )}

          <Text style={styles.reasonText}>{scan.reason}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** "Jul 8, 2026 · 14:32:07 UTC" — verbose because a detail view has room. */
function formatFullTimestamp(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${hh}:${mm}:${ss}`;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F3F4F6' },
  banner: { width: '100%', paddingVertical: 22, alignItems: 'center' },
  bannerText: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 1,
    textAlign: 'center',
  },

  scroll: { padding: 16 },
  image: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 12,
    backgroundColor: '#E5E7EB',
    marginBottom: 12,
  },
  imagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  imagePlaceholderText: { color: '#9CA3AF', fontSize: 13 },

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
  spacedTop: { marginTop: 12 },
  value: { fontSize: 15, color: '#111827' },
  serialLarge: { fontSize: 22, fontFamily: MONO, color: '#111827', marginTop: 2 },
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
});
