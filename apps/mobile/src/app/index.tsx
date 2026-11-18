import { TASK_STATUS } from '@taskplanner/core';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Home() {
  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>TaskPlanner</Text>
      <Text style={styles.hint}>Szkielet z Etapu 0 — ekrany powstają od MVP-3.</Text>
      <View style={styles.row}>
        {Object.entries(TASK_STATUS).map(([status, label]) => (
          <Text key={status} style={styles.chip}>
            {label}
          </Text>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '600' },
  hint: { opacity: 0.7 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, fontSize: 12 },
});
