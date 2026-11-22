import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { CLOUD_PRIVACY_DETAILS, CLOUD_PRIVACY_SUMMARY } from '../lib/ui/sensiPresentation';
import { InformationButton } from './Information';
import { SectionTitle } from './ui';
/** Same disclosure in Settings and onboarding; never grants consent. */
export function CloudPrivacyInfo() {
  const { tokens } = useTheme();
  return <>
    <SectionTitle right={<InformationButton title="Cloud AI Processing" body={CLOUD_PRIVACY_DETAILS} compact />}>Cloud AI Processing</SectionTitle>
    <Text style={{ color: tokens.textSecondary, fontSize: 14 }}>{CLOUD_PRIVACY_SUMMARY}</Text>
  </>;
}
