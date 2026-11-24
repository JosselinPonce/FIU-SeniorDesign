import { useState } from 'react';
import { AskSensi } from './AskSensi';
import { askSafetyContext } from '../lib/assistant/askSensiContext';
import { SensiGlyph } from './DashboardAssistantEntry';
import { ScreenHeader } from './ScreenHeader';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { SafeAreaView, ScrollView, View } from 'react-native';
import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { systemReadiness, readinessIndicator } from '../lib/assistant/systemReadiness';
import { useSystemReadiness } from '../lib/assistant/useSystemReadiness';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Card } from './ui';

/** Passive event-only home. Read-only inventory and subscriptions never start safety work. */
export function SensiStandby({ visible, drive, mode, onClose, onTrySafetyCheck }: {
  visible: boolean; drive: ReturnType<typeof useDriveSession>; mode: AssistantMode | null; onClose(): void; onTrySafetyCheck(): void;
}) {
  const { tokens: t } = useTheme();
  const { t: translate } = useAppLanguage();
  const [askOpen, setAskOpen] = useState(false);
  const snapshot = useSystemReadiness(visible && !askOpen, drive?.driver?.language === 'es' ? 'es' : 'en');
  if (!visible) return null;
  if (askOpen && drive.driver?.id) return <AskSensi driverId={drive.driver.id} baseline={drive.baseline ?? null} safety={askSafetyContext(drive.baseline ?? null, drive.safety?.th ?? null)} onBack={() => setAskOpen(false)} />;
  const readiness = systemReadiness({ hasDriver: !!drive.driver, connection: drive.connection, source: drive.link?.source,
    relayConnected: drive.relay?.esp, monitoring: drive.safety?.monitoring }, snapshot, drive.driver?.language === 'es' ? 'es' : 'en');
  const features = [
    { title: 'Ask Sensi', icon: 'message-circle', description: 'Explore your drive history, understand your biometrics and get answers about DriveSense.',
      detail: 'AI-powered insights · Internet required', disabled: !drive.driver?.id, onPress: () => setAskOpen(true) },
    { title: 'Try Sensi', icon: 'shield', description: 'Experience how Sensi checks on you when unusual biometric readings are detected.',
      detail: 'Offline · Simulated safety check', disabled: drive.hasActiveSession || !!drive.safety?.check || !!drive.safety?.demo, onPress: onTrySafetyCheck },
  ] as const;
  const readinessIcons = { sensors: 'radio', recognition: 'mic', responses: 'volume-2', manual: 'edit-3' } as const;
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <ScreenHeader title="Sensi" onBack={onClose} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 20 }}>
      <View style={{ alignItems: 'center', gap: 5, paddingVertical: 4 }}>
        <View style={{ width: 52, height: 52, borderRadius: 17, backgroundColor: t.primary,
          alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}><SensiGlyph color={t.onPrimary} /></View>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 27, fontWeight: '800', textAlign: 'center' }}>Hi, I'm Sensi!</Text>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', textAlign: 'center' }}>Your driving safety companion.</Text>
        <Text style={{ color: t.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>I check in when readings are unusual and help you understand your recorded drives.</Text>
      </View>
      <Card>
        <View style={{ gap: 5 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}>
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 16, fontWeight: '700', flexGrow: 1 }}>System Readiness</Text>
            <Text accessibilityLiveRegion="polite" style={{ color: t.textSecondary, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>{readiness.overall}</Text>
          </View>
          {readiness.items.filter(item => item.id !== 'recognition').map(item => {
            const status = item.status;
            const indicator = readinessIndicator(status);
            const color = { success: t.connected, warning: t.warning, danger: t.danger, neutral: t.textMuted }[indicator.tone];
            return <View key={item.id} accessible accessibilityLabel={[translate(item.label), translate(status)].join('. ')}
              style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 7, rowGap: 3, paddingVertical: 2 }}>
              <Feather name={readinessIcons[item.id]} size={15} color={t.textSecondary} accessible={false} />
              <Text style={{ color: t.textSecondary, fontSize: 13, flexGrow: 1, flexShrink: 1 }}>{item.label}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '100%', minWidth: 0, flexShrink: 1, gap: 5 }}>
                <Feather name={indicator.icon} size={13} color={color} accessible={false} />
                <Text style={{ color, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{status}</Text>
              </View>
            </View>;
          })}
        </View>
      </Card>
      <View style={{ gap: 7 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Explore Sensi</Text>
        {features.map(({ title, icon, description, detail, disabled, onPress }, index) => {
          const primary = index === 0;
          return <Pressable key={title} accessibilityRole="button" accessibilityLabel={translate(title)}
            accessibilityHint={[description, detail, ...(primary ? [] : ['No live emergency actions'])].map(translate).join('. ')}
            accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
            style={({ pressed }) => ({ minHeight: 52, borderRadius: 14, padding: 12, gap: 10,
              flexDirection: 'row', alignItems: 'flex-start', backgroundColor: primary ? t.primary : t.surfaceMuted,
              opacity: disabled ? 0.55 : pressed ? 0.8 : 1 })}>
            <Feather name={icon} size={19} color={primary ? t.onPrimary : t.primary} accessible={false} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: primary ? t.onPrimary : t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
              <Text style={{ color: primary ? t.onPrimary : t.textSecondary, fontSize: 13, lineHeight: 18 }}>{description}</Text>
              <Text style={{ color: primary ? t.onPrimary : t.textSecondary, fontSize: 12, fontWeight: '600' }}>{detail}</Text>
              {!primary ? <Text style={{ color: t.textSecondary, fontSize: 12 }}>No live emergency actions</Text> : null}
            </View>
            <Feather name="chevron-right" size={17} color={primary ? t.onPrimary : t.textSecondary} accessible={false} />
          </Pressable>;
        })}
      </View>
    </ScrollView>
  </SafeAreaView>;
}
