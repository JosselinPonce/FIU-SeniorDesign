import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { maskedContactPhone } from '../lib/ui/profileSummary';
import { hasSystemPhoneConfirmation } from '../lib/voice/phoneHandoff';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn, Card, SectionTitle } from './ui';
/** One app confirmation only on platforms without the documented system safeguard.
 * Supported iOS proceeds from scoped offer consent directly to its native prompt. */
export function RealContactDemoConfirmation({ drive }: { drive: ReturnType<typeof useDriveSession> }) {
  const pending = drive.safety.pendingDemoContact;
  const { tokens } = useTheme();
  const busy = useRef(false);
  const [message, setMessage] = useState('');
  const live = useRef(false), latest = useRef(pending?.confirmationId);
  if (pending) latest.current = pending.confirmationId;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (pending) setMessage(''); }, [pending?.confirmationId]);
  if (hasSystemPhoneConfirmation(Platform.OS, Platform.Version)) return null;
  if (!pending) return message ? <Text style={{ color: tokens.textSecondary }}>{message}</Text> : null;
  return <Card>
    <SectionTitle>Open saved contact?</SectionTitle>
    <Text style={{ color: tokens.textSecondary }}>Confirmation expires after 30 seconds. This can lead to a real call.</Text>
    <Text localize={false} style={{ color: tokens.text }}>{pending.name || '—'} · {maskedContactPhone(pending.phone)}</Text>
    <Btn title="Yes, open phone" disabled={busy.current} onPress={async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const result = await drive.confirmRealContactDemo(pending.confirmationId);
        if (live.current && latest.current === pending.confirmationId) setMessage(result === 'requested' ? 'Phone interface requested. Call connection is not confirmed.' : 'Real-contact demonstration expired or could not open.');
      } finally { busy.current = false; }
    }} />
    <Btn title="Cancel demonstration" kind="ghost" onPress={() => drive.cancelRealContactDemo()} />
  </Card>;
}
