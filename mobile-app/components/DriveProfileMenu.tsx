import { useEffect, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useLanguagePicker } from './LanguageMenu';
import { useTheme } from '../lib/theme/ThemeProvider';
import { driverInitials } from '../lib/ui/profileSummary';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

export function DriveProfileMenu({ name, onSwitch, onEdit, dashboardMode, onDashboardMode, blocked }: {
  name: string;
  blocked?: boolean;
  onSwitch(): void;
  onEdit(): void;
  dashboardMode?: boolean;
  onDashboardMode?(demo: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const { tokens: t, preference, setPreference, error: themeError } = useTheme();
  const { language, open: openLanguage, t: translate, error: languageError } = useLanguagePicker();
  const appearance = { light: 'Light', dark: 'Dark', system: 'System' } as const;
  const close = () => setOpen(false);
  useEffect(() => { if (blocked) setOpen(false); }, [blocked]);
  function segments<T extends string>(values: readonly T[], selected: T, label: (value: T) => string, choose: (value: T) => void) {
    return <View style={{ flexDirection: 'row', backgroundColor: t.surfaceMuted, borderRadius: 10, marginHorizontal: 14, marginBottom: 8, padding: 3 }}>
      {values.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: selected === value }}
        onPress={() => choose(value)} style={{ flex: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: 4,
          alignItems: 'center', borderRadius: 8, backgroundColor: selected === value ? t.surface : t.surfaceMuted }}>
        <Text style={{ color: t.text, textAlign: 'center', fontWeight: selected === value ? '700' : '500' }}>{label(value)}</Text>
      </Pressable>)}
    </View>;
  }
  return <View style={{ maxWidth: '60%' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${translate('Driver profile menu')}: ${name}`} accessibilityState={{ expanded: open && !blocked, disabled: blocked }} disabled={blocked}
      onPress={() => setOpen(true)} style={{ minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Text accessible={false} localize={false} style={{ backgroundColor: t.surfaceMuted, color: t.text,
        borderRadius: 14, padding: 6, fontWeight: '800' }}>{driverInitials(name)}</Text>
      <Text localize={false} numberOfLines={1} style={{ color: t.text, flexShrink: 1, fontWeight: '700' }}>{name}</Text>
      <Text accessible={false} style={{ color: t.textSecondary }}>⌄</Text>
    </Pressable>
    <Modal visible={open && !blocked} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 18 }} accessibilityViewIsModal>
        <Pressable accessibilityRole="button" accessibilityLabel="Close profile menu" onPress={close}
          style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: 0, backgroundColor: t.overlay }} />
        <View style={{ backgroundColor: t.surface, alignSelf: 'center', width: '100%', maxWidth: 440, borderRadius: 16, maxHeight: '90%' }}>
          <ScrollView>
            <SettingsGroup>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 }}>
                <Text accessible={false} localize={false} style={{ color: t.text, backgroundColor: t.surfaceMuted, borderRadius: 20, padding: 10, fontWeight: '800' }}>{driverInitials(name)}</Text>
                <View style={{ flex: 1 }}>
                  <Text localize={false} accessibilityRole="header" style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>{name}</Text>
                  <Text style={{ color: t.textSecondary }}>Active driver</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close profile menu" onPress={close}
                  style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: t.text, fontSize: 24 }}>×</Text>
                </Pressable>
              </View>
              <SettingsRow title="Edit Profile" onPress={() => { close(); onEdit(); }} />
              <SettingsRow divider title="Switch Driver" onPress={() => { close(); onSwitch(); }} />
              <SettingsRow divider title="Appearance" />
              {segments(['light', 'dark', 'system'], preference, value => appearance[value], value => { void setPreference(value); })}
              <SettingsRow divider title="Language" subtitle={language === 'es' ? 'Español' : 'English'} onPress={openLanguage} />
              {__DEV__ && dashboardMode !== undefined && onDashboardMode ? <>
                <SettingsRow divider title="Dashboard Mode" />
                {segments(['normal', 'demo'], dashboardMode ? 'demo' : 'normal', value => value === 'demo' ? 'Hardware Demo' : 'Normal Drive',
                  value => { onDashboardMode(value === 'demo'); close(); })}
              </> : null}
              {themeError || languageError ? <Text accessibilityRole="alert" style={{ color: t.danger, marginHorizontal: 14 }}>{themeError ?? languageError}</Text> : null}
            </SettingsGroup>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </View>;
}
