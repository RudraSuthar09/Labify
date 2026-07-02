import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ScanScreen from './src/screens/ScanScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import type { RootTabParamList } from './src/types/navigation';
// Load typed env early so any missing-var warnings surface on startup.
import './src/config/env';

const Tab = createBottomTabNavigator<RootTabParamList>();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
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
        <StatusBar style="auto" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
