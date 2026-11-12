import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import { SafeAreaView, ScrollView, View } from 'react-native';
import { useRef } from 'react';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import type { DriverProfile } from '../lib/db/repositories';
import { useTheme } from '../lib/theme/ThemeProvider';
import { driverInitials, maskedContactPhone } from '../lib/ui/profileSummary';
import { ScreenHeader } from './ScreenHeader';
import { LanguageMenu } from './LanguageMenu';
import { Btn, Card } from './ui';
/** Confirmation precedes selection; editing never implicitly confirms the driver. */
export function DriverConfirmation({ profile, onConfirm, onBack, onEdit }: {
  profile: DriverProfile; onConfirm(): void; onBack(): void; onEdit?(): void;
}) {
  const { tokens } = useTheme();
  const confirmed = useRef(false);
  const phoneDisplay = maskedContactPhone(profile.emergency_phone);
  const lastFour = phoneDisplay.match(/\d{4}$/)?.[0];
  return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
    <ScreenHeader title="Confirm driver" onBack={onBack} right={<LanguageMenu />} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 24, fontWeight: '800' }}>Confirm your driver</Text>
        <Text style={{ color: tokens.textSecondary, fontSize: 14, lineHeight: 20 }}>Make sure these details are correct.</Text>
      </View>
      <Card style={{ padding: 14, gap: 0 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingBottom: 12 }}>
          <View style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 22, backgroundColor: tokens.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
            <Text accessible={false} maxFontSizeMultiplier={1.2} localize={false} style={{ color: tokens.text, fontSize: 18, fontWeight: '800' }}>{driverInitials(profile.display_name)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text localize={false} style={{ color: tokens.text, fontSize: 18, fontWeight: '700' }}>{profile.display_name}</Text>
            <Text style={{ color: tokens.textSecondary, fontSize: 12 }}>Selected driver</Text>
          </View>
          {onEdit ? <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${profile.display_name}'s profile`} onPress={onEdit}
            style={{ minWidth: 52, minHeight: 44, paddingHorizontal: 10, borderRadius: 10, backgroundColor: tokens.surfaceMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' }}>
            <Text style={{ color: tokens.text, fontSize: 14, fontWeight: '600' }}>Edit</Text>
          </Pressable> : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: tokens.border }}>
          <ConfirmationOutlineIcon name="microphone" color={tokens.textSecondary} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ color: tokens.textSecondary, fontSize: 12 }}>VoiceCheck language</Text>
            <Text localize={false} style={{ color: tokens.text, fontSize: 15 }}>{profile.language === 'es' ? 'Español' : 'English'}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: tokens.border }}>
          <ConfirmationOutlineIcon name="phone" color={tokens.textSecondary} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ color: tokens.textSecondary, fontSize: 12 }}>Emergency contact</Text>
            {profile.emergency_phone ? <>
              {profile.emergency_name ? <Text localize={false} style={{ color: tokens.text, fontSize: 15 }}>{profile.emergency_name}</Text> : null}
              <Text localize={false} accessibilityLabel={lastFour ? `Phone number ending in ${lastFour}` : 'Phone number hidden'} style={{ color: tokens.textSecondary, fontSize: 14 }}>{phoneDisplay}</Text>
            </> : <Text style={{ color: tokens.textSecondary, fontSize: 14 }}>No emergency contact saved.</Text>}
          </View>
        </View>
      </Card>
      <Btn title="Confirm & Continue" onPress={() => { if (!confirmed.current) { confirmed.current = true; onConfirm(); } }} />
    </ScrollView>
  </SafeAreaView>;
}

/** Preserve the native microphone; use Expo's bundled Feather phone outline. */
function ConfirmationOutlineIcon({ name, color }: { name: 'microphone' | 'phone'; color: string }) {
  const stroke = 1.6;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
    style={{ width: 22, height: 22, flexShrink: 0 }}>
    {name === 'microphone' ? <>
      <View style={{ position: 'absolute', left: 8, top: 1, width: 6, height: 11, borderWidth: stroke, borderColor: color, borderRadius: 3 }} />
      <View style={{ position: 'absolute', left: 5, top: 7, width: 12, height: 10, borderLeftWidth: stroke, borderRightWidth: stroke,
        borderBottomWidth: stroke, borderColor: color, borderBottomLeftRadius: 6, borderBottomRightRadius: 6 }} />
      <View style={{ position: 'absolute', left: 10.2, top: 17, width: stroke, height: 3, backgroundColor: color }} />
      <View style={{ position: 'absolute', left: 7, top: 20, width: 8, height: stroke, borderRadius: 1, backgroundColor: color }} />
    </> : <Feather name="phone" size={22} color={color} allowFontScaling={false}
      style={{ width: 22, height: 22, lineHeight: 22, textAlign: 'center' }} />}
  </View>;
}
