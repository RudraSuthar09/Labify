/**
 * Today's scan totals — sits above the HistoryScreen list.
 *
 * Refreshed via the `refreshKey` prop (parent bumps it after a pull-to-refresh
 * or a filter change) rather than a focus effect, so it stays in sync with the
 * list beneath it.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { fetchStats, ScanApiError, type TodayStats } from '../services/scanApi';

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; stats: TodayStats }
  | { phase: 'unavailable' }
  | { phase: 'error' };

export interface StatsHeaderProps {
  /** Bump to refetch. Any change in value triggers a reload. */
  refreshKey: number;
}

export default function StatsHeader({ refreshKey }: StatsHeaderProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    fetchStats(controller.signal)
      .then((stats) => {
        if (!controller.signal.aborted) setState({ phase: 'ok', stats });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ScanApiError && err.info.kind === 'unavailable') {
          setState({ phase: 'unavailable' });
        } else {
          setState({ phase: 'error' });
        }
      });
    return () => controller.abort();
  }, [refreshKey]);

  if (state.phase === 'loading') {
    return (
      <View style={styles.card}>
        <ActivityIndicator size="small" color="#0a7ea4" />
      </View>
    );
  }
  if (state.phase === 'unavailable') {
    // Server is up but stats endpoint is off — silent card, not an error.
    return null;
  }
  if (state.phase === 'error') {
    return (
      <View style={[styles.card, styles.errorCard]}>
        <Text style={styles.errorText}>Couldn’t load today’s stats.</Text>
      </View>
    );
  }

  const { total, pass, passRate } = state.stats;
  const passRatePct = passRate === null ? '—' : `${Math.round(passRate * 100)}%`;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Today</Text>
      <View style={styles.row}>
        <Stat label="Scanned" value={String(total)} />
        <Stat label="Pass rate" value={passRatePct} tint={passRateColor(passRate)} />
        <Stat label="Passes" value={String(pass)} />
      </View>
    </View>
  );
}

function Stat({
  label,
  value,
  tint,
}: {
  label: string;
  value: string;
  tint?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** Green ≥ 95%, amber 80–94%, red < 80%. Null (no data) stays neutral. */
function passRateColor(rate: number | null): string | undefined {
  if (rate === null) return undefined;
  if (rate >= 0.95) return '#16A34A';
  if (rate >= 0.8) return '#F59E0B';
  return '#DC2626';
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
    gap: 8,
  },
  errorCard: { alignItems: 'center' },
  errorText: { fontSize: 12, color: '#DC2626' },

  title: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 22, fontWeight: '800', color: '#111827' },
  statLabel: { fontSize: 11, color: '#6B7280', marginTop: 2 },
});
