import { SensiGlyph } from './DashboardAssistantEntry';
import { ScreenHeader } from './ScreenHeader';
import { LocalizedText as Text } from '../lib/i18n/native';
import { SafeAreaView, ScrollView, View } from 'react-native';
import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { systemReadiness, readinessIndicator } from '../lib/assistant/systemReadiness';
import { useSystemReadiness } from '../lib/assistant/useSystemReadiness';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn, Card } from './ui';

/** Passive event-only home. Read-only inventory and subscriptions never start safety work. */
export function SensiStandby({ visible, drive, mode, onClose, onTrySafetyCheck }: {
  visible: boolean; drive: ReturnType<typeof useDriveSession>; mode: AssistantMode | null; onClose(): void; onTrySafetyCheck(): void;
}) {
  const { tokens: t } = useTheme();
  const { t: translate } = useAppLanguage();
  const snapshot = useSystemReadiness(visible, drive?.driver?.language === 'es' ? 'es' : 'en');
  if (!visible) return null;
  const readiness = systemReadiness({ hasDriver: !!drive.driver, connection: drive.connection, source: drive.link?.source,
    relayConnected: drive.relay?.esp, monitoring: drive.safety?.monitoring }, snapshot, drive.driver?.language === 'es' ? 'es' : 'en');
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <ScreenHeader title="Sensi" onBack={onClose} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 20 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, flexShrink: 0, borderRadius: 20, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}><SensiGlyph color={t.onPrimary} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>Hi, I'm Sensi!</Text>
            <Text style={{ color: t.textSecondary, fontSize: 17 }}>Your driving safety companion.</Text>
          </View>
        </View>
        <Text style={{ color: t.textSecondary, fontSize: 16, lineHeight: 24 }}>If DriveSense detects unusual health readings, I'll check in to see how you're feeling.</Text>
      </View>
      <Card>
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>System Readiness</Text>
          <View style={{ alignSelf: 'flex-start', maxWidth: '100%', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: t.surfaceMuted }}>
            <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }}>{readiness.overall}</Text>
          </View>
          {readiness.items.filter(item => item.id !== 'recognition').map(item => {
            const status = item.status;
            const indicator = readinessIndicator(status);
            const color = { success: t.connected, warning: t.warning, danger: t.danger, neutral: t.textMuted }[indicator.tone];
            return <View key={item.id} accessible accessibilityLabel={[translate(item.label), translate(status), item.percent === undefined ? '' : `${item.percent}%`].filter(Boolean).join('. ')}
              style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4, paddingVertical: 4 }}>
              <Text style={{ color: t.textSecondary, fontSize: 14, flexGrow: 1, flexShrink: 1, flexBasis: 140 }}>{item.label}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '100%', minWidth: 0, flexShrink: 1, gap: 6 }}>
                <Feather name={indicator.icon} size={16} color={color} accessible={false} />
                <Text style={{ color, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>{status}{item.percent === undefined ? '' : ` · ${item.percent}%`}</Text>
              </View>
            </View>;
          })}
        </View>
      </Card>
      <View style={{ gap: 8 }}>
        <Btn title="Try Sensi" disabled={drive.hasActiveSession || !!drive.safety?.check || !!drive.safety?.demo} onPress={onTrySafetyCheck} />
        <Text style={{ color: t.textSecondary, fontSize: 13 }}>Simulated safety check · No live emergency actions</Text>
      </View>
    </ScrollView>
  </SafeAreaView>;
}
