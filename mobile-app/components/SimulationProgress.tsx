import { View } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { simulationProgress } from '../lib/ui/simulationProgress';
export function SimulationProgress({ demo }: { demo: Parameters<typeof simulationProgress>[0] }) {
  const { tokens } = useTheme();
  const p = simulationProgress(demo);
  return <View style={{ gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: tokens.border }}>
    <Text style={{ color: tokens.text, fontWeight: '700' }}>SIMULATED</Text>
    <Text style={{ color: tokens.text }}>Elapsed simulated seconds: {p.seconds}</Text>
    <Text localize={false} style={{ color: tokens.text, fontSize: 24 }}>{p.value} {p.unit}</Text>
    <Text style={{ color: tokens.textSecondary }}>{p.phase}</Text>
    <Text style={{ color: tokens.textSecondary }}>Fabricated readings — separate from live sensors.</Text>
  </View>;
}
