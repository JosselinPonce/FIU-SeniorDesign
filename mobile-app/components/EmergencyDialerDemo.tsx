import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { LocalizedAlert as Alert, LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { openDemoPhoneInterface } from '../lib/voice/demoPhoneHandoff';
import { Btn, Card, SectionTitle } from './ui';

/** A fresh button confirmation is required even after simulated contact consent. */
export function EmergencyDialerDemo({ blocked = false }: { blocked?: boolean }) {
  const { tokens: t } = useTheme();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const pending = useRef(false);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && !blockedRef.current && AppState.currentState === 'active';
  return <Card>
    <SectionTitle>Test Emergency Dialer</SectionTitle>
    <Text style={{ color: t.warning, fontWeight: '800' }}>DEMO MODE — fictional number only</Text>
    <Text style={{ color: t.textSecondary }}>Demonstrates the iOS phone confirmation using +1 202-555-0123, a fictional non-working number. No saved contact or emergency service is used. No call is placed automatically. Choose Cancel in the system prompt; this is not a dial-pad-only preview.</Text>
    <Btn title="Demonstrate native phone handoff" kind="ghost" disabled={blocked || busy} onPress={() => {
      if (!current() || pending.current) return;
      pending.current = true; setBusy(true);
      Alert.alert('DEMO MODE', 'Open the system phone confirmation for the fictional number +1 202-555-0123? Choose Cancel in that prompt. This does not test emergency calling.', [
        { text: 'Cancel', style: 'cancel', onPress: () => { pending.current = false; if (live.current) setBusy(false); } },
        { text: 'Open demo confirmation', onPress: async () => {
          const result = await openDemoPhoneInterface({ platform: Platform.OS, version: Platform.Version, current,
            canOpen: url => Linking.canOpenURL(url), open: url => Linking.openURL(url) });
          pending.current = false;
          if (!live.current) return;
          setBusy(false);
          setMessage(result === 'requested' ? 'System handoff requested. Call connection is not confirmed.'
            : result === 'unsupported' ? 'This device cannot show the iOS phone confirmation for this demo destination.'
            : result === 'cancelled' ? 'Demo cancelled.' : 'The phone confirmation was cancelled or could not be opened.');
        } },
      ], { cancelable: true, onDismiss: () => { pending.current = false; if (live.current) setBusy(false); } });
    }} />
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{message}</Text> : null}
  </Card>;
}
