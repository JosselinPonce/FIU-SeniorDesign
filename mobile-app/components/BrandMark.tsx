import { Image, Text, View, type ImageSourcePropType } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';

/** Asset integration point: supply ONLY the approved steering-wheel/heart-ECG image.
 * No approved asset is currently identified in the repository.
 * Expected future asset: assets/branding/drivesense-logo.png (exact approved original).
 * Supply it through approvedLogo only after visual verification; no asset is bundled yet.
 * Do not use the generic Expo launcher image or synthesize a replacement logo here.
 */
export function BrandMark({ approvedLogo }: { approvedLogo?: ImageSourcePropType }) {
  const { tokens } = useTheme();
  return <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
    {approvedLogo ? <Image source={approvedLogo} accessible={false}
      style={{ width: 36, height: 36 }} resizeMode="contain" /> : null}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 20, fontWeight: '800', letterSpacing: .3 }}>DriveSense</Text>
      <Text style={{ color: tokens.textSecondary, fontSize: 10, lineHeight: 14 }}>Driven by Safety. Powered by Insight.</Text>
    </View>
  </View>;
}
