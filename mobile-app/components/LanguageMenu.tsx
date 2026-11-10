import { Alert, Pressable, Text, View } from 'react-native';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
export function LanguageMenu() {
  const { language, setLanguage, t, error } = useAppLanguage();
  const { tokens } = useTheme();
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={t('App language')}
      onPress={() => Alert.alert(t('App language'), t('Choose the interface language. VoiceCheck language is configured separately for each driver.'), [
        { text: `${language === 'en' ? '✓ ' : ''}English`, onPress: () => { void setLanguage('en'); } },
        { text: `${language === 'es' ? '✓ ' : ''}Español`, onPress: () => { void setLanguage('es'); } },
        { text: t('Cancel'), style: 'cancel' },
      ])} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
      <Text style={{ color: tokens.text, fontWeight: '600' }}>{language === 'es' ? 'ES' : 'EN'} ⌄</Text>
    </Pressable>
    {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{t(error)}</Text> : null}
  </View>;
}
