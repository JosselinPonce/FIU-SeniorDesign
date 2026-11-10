import { SafeAreaView, ScrollView, View } from 'react-native';
import { useRef } from 'react';
import { LocalizedText as Text } from '../lib/i18n/native';
import type { DriverProfile } from '../lib/db/repositories';
import { useTheme } from '../lib/theme/ThemeProvider';
import { LanguageMenu } from './LanguageMenu';
import { Btn } from './ui';
/** Confirmation precedes selectDriver, so the existing hook still owns all profile/safety transitions. */
export function DriverConfirmation({ profile, onConfirm, onBack }: { profile: DriverProfile; onConfirm(): void; onBack(): void }) {
  const { tokens } = useTheme();
  const confirmed = useRef(false);
  return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
    <ScrollView contentContainerStyle={{ padding: 24, gap: 20, flexGrow: 1, justifyContent: 'center' }}>
      <LanguageMenu />
      <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 26, fontWeight: '700' }}>Choose and confirm your driver</Text>
      <Text localize={false} style={{ color: tokens.text, fontSize: 22 }}>{profile.display_name}</Text>
      <Text style={{ color: tokens.textSecondary }}>VoiceCheck language</Text>
      <Text localize={false} style={{ color: tokens.text }}>{profile.language === 'es' ? 'Español' : 'English'}</Text>
      <Text style={{ color: tokens.textSecondary }}>Emergency contact (optional, stays on this phone)</Text>
      <Text localize={false} style={{ color: tokens.text }}>{profile.emergency_name || '—'} · {profile.emergency_phone || '—'}</Text>
      <Text style={{ color: tokens.textSecondary }}>Confirm the driver before monitoring. To change profile details or VoiceCheck language, go back and use Edit.</Text>
      <View style={{ gap: 8 }}><Btn title="Use this driver" onPress={() => {
        if (!confirmed.current) { confirmed.current = true; onConfirm(); }
      }} /><Btn title="Back" kind="ghost" onPress={onBack} /></View>
    </ScrollView>
  </SafeAreaView>;
}
