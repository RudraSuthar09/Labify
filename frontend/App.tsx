import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from './src/screens/HomeScreen';
import ScanScreen from './src/screens/ScanScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ScanDetailScreen from './src/screens/ScanDetailScreen';
import BarcodeCheckScreen from './src/screens/BarcodeCheckScreen';
import { startSyncOrchestrator } from './src/services/offlineQueue';
import type { RootStackParamList, RootTabParamList } from './src/types/navigation';
// Load typed env early so any missing-var warnings surface on startup.
import './src/config/env';

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Bottom-tab surface — the app's primary UI. Owns its own headers so the
 * per-tab gear/sound/clear buttons keep working via `navigation.setOptions`.
 */
function TabsNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerTitleAlign: 'center',
        tabBarActiveTintColor: '#0a7ea4',
      }}
    >
      <Tab.Screen
        name="Scan"
        component={ScanScreen}
        options={{
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>⬛</Text>,
        }}
      />
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>🕘</Text>,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  // Kick off the connectivity listener once. Idempotent, so a hot reload
  // doesn't double-register.
  useEffect(() => {
    startSyncOrchestrator();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Home">
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: 'Labify', headerTitleAlign: 'center' }}
          />
          <Stack.Screen
            name="Tabs"
            component={TabsNavigator}
            // Hide the stack header so only the tabs' per-screen headers show
            // — otherwise every tab renders two stacked headers.
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="BarcodeCheck"
            component={BarcodeCheckScreen}
            options={{ title: 'Quick Barcode Check', headerTitleAlign: 'center' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Settings', headerTitleAlign: 'center' }}
          />
          <Stack.Screen
            name="ScanDetail"
            component={ScanDetailScreen}
            options={{ title: 'Scan Detail', headerTitleAlign: 'center' }}
          />
        </Stack.Navigator>
        <StatusBar style="auto" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
