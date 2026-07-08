/**
 * HistoryScreen — server-sourced audit log.
 *
 * Backed by GET /api/scans (paginated) and GET /api/stats (header card). Local
 * AsyncStorage is NOT consulted here — the source of truth is the backend so
 * the operator sees the same list on any device. Offline resilience lives in
 * `offlineQueue`, not here.
 *
 * Pagination is keyset (opaque cursor). We hold two arrays — the accumulated
 * `items` and the cursor for the next page — and re-request from scratch on
 * filter change or pull-to-refresh. In-flight fetches carry an AbortController
 * so a quick filter switch cancels the previous page instead of racing to
 * append stale rows.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import StatsHeader from '../components/StatsHeader';
import {
  fetchScans,
  ScanApiError,
  type ScanListItem,
} from '../services/scanApi';
import type { VerificationStatus } from '../types/verification';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const STATUS_STYLE: Record<VerificationStatus, { bg: string; label: string }> = {
  pass: { bg: '#16A34A', label: 'PASS' },
  fail: { bg: '#DC2626', label: 'FAIL' },
  warning: { bg: '#F59E0B', label: 'WARN' },
};

type Filter = 'all' | VerificationStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pass', label: 'Pass' },
  { key: 'fail', label: 'Fail' },
  { key: 'warning', label: 'Warning' },
];

const PAGE_LIMIT = 20;

interface LoadState {
  items: ScanListItem[];
  nextCursor: string | null;
  /** True during the initial load and on filter changes. */
  loading: boolean;
  /** True when a next page is being appended. */
  loadingMore: boolean;
  /** Pull-to-refresh spinner control. */
  refreshing: boolean;
  error: ScanApiError | null;
}

const INITIAL: LoadState = {
  items: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  refreshing: false,
  error: null,
};

export default function HistoryScreen() {
  const navigation = useNavigation();
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<LoadState>(INITIAL);
  const [refreshKey, setRefreshKey] = useState(0);

  // The controller for the current in-flight page fetch. Aborted on
  // filter change / refresh / unmount so stale pages don't overwrite fresh
  // data.
  const currentRequest = useRef<AbortController | null>(null);

  const load = useCallback(
    async (opts: { filter: Filter; cursor?: string; kind: 'initial' | 'refresh' | 'more' }) => {
      // Cancel any prior in-flight page.
      currentRequest.current?.abort();
      const controller = new AbortController();
      currentRequest.current = controller;

      setState((s) => ({
        ...s,
        loading: opts.kind === 'initial',
        refreshing: opts.kind === 'refresh',
        loadingMore: opts.kind === 'more',
        error: opts.kind === 'more' ? s.error : null,
      }));

      try {
        const page = await fetchScans({
          status: opts.filter === 'all' ? undefined : opts.filter,
          cursor: opts.cursor,
          limit: PAGE_LIMIT,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState((s) => ({
          items: opts.kind === 'more' ? [...s.items, ...page.items] : page.items,
          nextCursor: page.nextCursor,
          loading: false,
          loadingMore: false,
          refreshing: false,
          error: null,
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        const apiErr =
          err instanceof ScanApiError
            ? err
            : new ScanApiError({ kind: 'unknown', message: 'Failed to load history.' });
        setState((s) => ({
          ...s,
          loading: false,
          loadingMore: false,
          refreshing: false,
          // Keep already-loaded items on a "more" failure — only wipe on a
          // fresh load where there's nothing useful to display.
          items: opts.kind === 'more' ? s.items : [],
          nextCursor: opts.kind === 'more' ? s.nextCursor : null,
          error: apiErr,
        }));
      }
    },
    [],
  );

  // Initial load + reload on filter change.
  useEffect(() => {
    void load({ filter, kind: 'initial' });
    return () => {
      currentRequest.current?.abort();
    };
  }, [filter, load]);

  // Reload on focus so a fresh scan in the other tab shows up. Skip on the
  // very first mount (the effect above already fetched).
  const isFirstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (isFirstFocus.current) {
        isFirstFocus.current = false;
        return;
      }
      void load({ filter, kind: 'refresh' });
      setRefreshKey((k) => k + 1);
    }, [filter, load]),
  );

  const handleRefresh = useCallback(() => {
    void load({ filter, kind: 'refresh' });
    setRefreshKey((k) => k + 1);
  }, [filter, load]);

  const handleEndReached = useCallback(() => {
    if (state.loading || state.loadingMore || state.refreshing) return;
    if (!state.nextCursor) return;
    void load({ filter, cursor: state.nextCursor, kind: 'more' });
  }, [filter, load, state.loading, state.loadingMore, state.refreshing, state.nextCursor]);

  const handleOpen = useCallback(
    (item: ScanListItem) => {
      navigation.navigate('ScanDetail', { scan: item });
    },
    [navigation],
  );

  // Header — gear-to-settings (kept from previous work).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={12}
          accessibilityLabel="Open settings"
          style={styles.headerButton}
        >
          <Text style={styles.headerIcon}>⚙️</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <FilterChips value={filter} onChange={setFilter} />

      <FlatList
        data={state.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={<StatsHeader refreshKey={refreshKey} />}
        renderItem={({ item }) => <HistoryRow entry={item} onPress={() => handleOpen(item)} />}
        refreshing={state.refreshing}
        onRefresh={handleRefresh}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          state.loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#0a7ea4" />
            </View>
          ) : state.error ? (
            <ErrorState error={state.error} onRetry={handleRefresh} />
          ) : (
            <EmptyState filter={filter} />
          )
        }
        ListFooterComponent={
          state.loadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator size="small" color="#0a7ea4" />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

// --- Filter chip row -----------------------------------------------------

function FilterChips({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
}) {
  return (
    <View style={styles.chipsRow}>
      {FILTERS.map((f) => {
        const active = f.key === value;
        return (
          <Pressable
            key={f.key}
            onPress={() => onChange(f.key)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// --- Row -----------------------------------------------------------------

function HistoryRow({
  entry,
  onPress,
}: {
  entry: ScanListItem;
  onPress: () => void;
}) {
  const status = STATUS_STYLE[entry.status];
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      {entry.imageUrl ? (
        <Image source={{ uri: entry.imageUrl }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <Text style={styles.thumbPlaceholderText}>No image</Text>
        </View>
      )}

      <View style={styles.rowBody}>
        <View style={styles.rowTopLine}>
          <View style={[styles.statusPill, { backgroundColor: status.bg }]}>
            <Text style={styles.statusPillText}>{status.label}</Text>
          </View>
          <Text style={styles.timestamp}>{formatTimestamp(entry.createdAt)}</Text>
        </View>

        <Text style={styles.barcode} numberOfLines={1}>
          {entry.decodedBarcode}
        </Text>
        {entry.expectedValue && entry.expectedValue !== entry.decodedBarcode ? (
          <Text style={styles.expected} numberOfLines={1}>
            expected {entry.expectedValue}
          </Text>
        ) : null}
        <Text style={styles.reason} numberOfLines={2}>
          {entry.reason}
        </Text>
      </View>
    </Pressable>
  );
}

// --- Empty / error states ------------------------------------------------

function EmptyState({ filter }: { filter: Filter }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyTitle}>No scans yet</Text>
      <Text style={styles.emptySubtitle}>
        {filter === 'all'
          ? 'Past label verifications will appear here.'
          : `No ${filter} scans on record.`}
      </Text>
    </View>
  );
}

function ErrorState({ error, onRetry }: { error: ScanApiError; onRetry: () => void }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.errorTitle}>Couldn’t load history</Text>
      <Text style={styles.errorSubtitle}>{error.message}</Text>
      <Pressable style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

// --- Formatting ----------------------------------------------------------

/** "Today, 14:32" / "Yesterday, 09:04" / "Jul 3, 14:32". Accepts ISO string. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const isSameDay = d.toDateString() === now.toDateString();
  if (isSameDay) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${time}`;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// --- Styles --------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F4F6' },

  headerButton: { paddingHorizontal: 10, paddingVertical: 4 },
  headerIcon: { fontSize: 20 },

  chipsRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#0a7ea4', borderColor: '#0a7ea4' },
  chipText: { fontSize: 13, fontWeight: '600', color: '#4B5563' },
  chipTextActive: { color: '#fff' },

  listContent: { padding: 12, flexGrow: 1 },
  separator: { height: 10 },

  row: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  rowPressed: { opacity: 0.7 },
  thumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#E5E7EB' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { fontSize: 10, color: '#9CA3AF', textAlign: 'center' },

  rowBody: { flex: 1, gap: 4 },
  rowTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusPillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  timestamp: { fontSize: 12, color: '#6B7280' },

  barcode: { fontSize: 15, fontFamily: MONO, color: '#111827' },
  expected: { fontSize: 12, fontFamily: MONO, color: '#6B7280' },
  reason: { fontSize: 12, color: '#4B5563', marginTop: 2 },

  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 6,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#111' },
  emptySubtitle: { fontSize: 14, color: '#6B7280', textAlign: 'center' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#991B1B' },
  errorSubtitle: { fontSize: 13, color: '#7F1D1D', textAlign: 'center', marginBottom: 12 },
  retryButton: {
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 8,
  },
  retryButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  footerLoader: { paddingVertical: 20, alignItems: 'center' },
});
