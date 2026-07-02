import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Placeholder for the verification history. Past scans and their pass/fail
 * results (persisted via AsyncStorage) will be listed here.
 */
export default function HistoryScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        <Text style={styles.title}>History</Text>
        <Text style={styles.subtitle}>Past label verifications will appear here.</Text>
        <Text style={styles.hint}>No scans yet.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 15, color: '#444', textAlign: 'center' },
  hint: { fontSize: 13, color: '#999', marginTop: 12 },
});
