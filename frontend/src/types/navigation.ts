import type { NavigatorScreenParams } from '@react-navigation/native';

import type { ScanListItem } from '../services/scanApi';

/** Route params for the bottom-tab navigator (the app's primary surface). */
export type RootTabParamList = {
  Scan: undefined;
  History: undefined;
};

/**
 * Route params for the root native-stack. The tab navigator is nested inside
 * as the initial route; auxiliary screens like Settings and ScanDetail are
 * pushed on top of it.
 */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<RootTabParamList>;
  Settings: undefined;
  /**
   * Detail view for a single archived scan. The row payload is passed as-is —
   * no re-fetch on the detail screen — since the list already has everything.
   */
  ScanDetail: { scan: ScanListItem };
};

// Makes `navigation`/`route` typed app-wide via useNavigation() without props.
// We extend with the root-most navigator so `navigate('Settings')` and
// `navigate('ScanDetail', ...)` from a tab screen resolve correctly (React
// Navigation traverses up to find the route).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
