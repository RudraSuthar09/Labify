/**
 * React hook wrapping the offlineQueue subscription. Any component that
 * displays the pending-sync count / list re-renders live when the queue
 * mutates (enqueue, sync success, mark).
 */
import { useEffect, useState } from 'react';

import { subscribe, type QueueEntry } from '../services/offlineQueue';

export interface PendingSync {
  entries: QueueEntry[];
  count: number;
}

const EMPTY: PendingSync = { entries: [], count: 0 };

export function usePendingSync(): PendingSync {
  const [snapshot, setSnapshot] = useState<PendingSync>(EMPTY);
  useEffect(() => {
    const unsub = subscribe((entries) => {
      setSnapshot({ entries, count: entries.length });
    });
    return unsub;
  }, []);
  return snapshot;
}
