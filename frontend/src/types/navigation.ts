/** Route params for the root bottom-tab navigator. */
export type RootTabParamList = {
  Scan: undefined;
  History: undefined;
};

// Makes `navigation`/`route` typed app-wide via useNavigation() without props.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootTabParamList {}
  }
}
