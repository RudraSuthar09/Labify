import { useLayoutEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

export default function HomeScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Labify', headerTitleAlign: 'center' });
  }, [navigation]);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <View style={styles.hero}>
        <Text style={styles.title}>Choose a mode</Text>
        <Text style={styles.subtitle}>
          Pick full verification or a quick barcode-only check.
        </Text>
      </View>

      <View style={styles.menu}>
        <Pressable
          style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}
          onPress={() => navigation.navigate('Tabs', { screen: 'Scan' })}
        >
          <Text style={styles.buttonIcon}>🧪</Text>
          <View style={styles.buttonTextCol}>
            <Text style={styles.buttonTitle}>Full Verify</Text>
            <Text style={styles.buttonSubtitle}>
              Barcode + QR + OCR against the label
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]}
          onPress={() => navigation.navigate('BarcodeCheck')}
        >
          <Text style={styles.buttonIcon}>⬛</Text>
          <View style={styles.buttonTextCol}>
            <Text style={[styles.buttonTitle, styles.buttonTitleOnLight]}>
              Quick Barcode Check
            </Text>
            <Text style={[styles.buttonSubtitle, styles.buttonSubtitleOnLight]}>
              Scan a barcode and check it against RIL
            </Text>
          </View>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    padding: 20,
    justifyContent: 'space-between',
  },
  hero: { alignItems: 'center', marginTop: 24, gap: 8 },
  title: { fontSize: 28, fontWeight: '800', color: '#111827' },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 12,
  },
  menu: { gap: 16, marginBottom: 24 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 16,
    paddingVertical: 22,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  primary: { backgroundColor: '#0a7ea4' },
  secondary: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
  },
  pressed: { opacity: 0.85 },
  buttonIcon: { fontSize: 32 },
  buttonTextCol: { flex: 1 },
  buttonTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  buttonSubtitle: { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  buttonTitleOnLight: { color: '#111827' },
  buttonSubtitleOnLight: { color: '#6B7280' },
});
