import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch } from 'react-native';
import { LocalizedText as Text, LocalizedTextInput as TextInput } from '../lib/i18n/native';
import { sensiCloudAuth } from '../lib/assistant/phoneCloudAuth';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn } from './ui';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsGroup';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch';

export function useSensiAccount() {
  const [state, setState] = useState(sensiCloudAuth.state);
  useEffect(() => sensiCloudAuth.subscribe(setState), []);
  return state;
}

/** Release-accessible optional cloud access. Passwords remain transient and are never logged. */
export function SensiCloudAccess({ blocked, state }: { blocked: boolean; state: ReturnType<typeof useSensiAccount> }) {
  const { tokens } = useTheme();
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const live = useRef(false), pending = useRef(false), blockedRef = useRef(blocked); blockedRef.current = blocked;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (blocked) setPassword(''); }, [blocked]);
  async function signIn() {
    if (pending.current || blockedRef.current) return;
    const credential = password; setPassword(''); pending.current = true; setBusy(true); setMessage('');
    try {
      const ok = await sensiCloudAuth.signIn(username, credential, remember);
      if (live.current && !ok) setMessage('Cloud sign-in unavailable. Basic and offline safety remain available.');
    } finally { pending.current = false; if (live.current) setBusy(false); }
  }
  const field = { color: tokens.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, minHeight: 48 };
  const signedIn = state.status === 'signed_in';
  return <>
    <SettingsGroup>
      <SettingsRow title={signedIn ? 'Signed in' : state.status === 'checking' ? 'Checking session…' : state.status === 'unavailable' ? 'Session unavailable' : 'Signed out'}
        subtitle={signedIn ? 'Connected account' : 'Sign-in is optional'} />
    </SettingsGroup>
    {!signedIn ? <>
      <SettingsGroup>
        <TextInput accessibilityLabel="Sensi email or demo username" placeholder="Email or drivesense-demo" placeholderTextColor={tokens.textMuted}
          value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} editable={!busy && !blocked} style={field} />
        <TextInput accessibilityLabel="Sensi password" placeholder="Password" placeholderTextColor={tokens.textMuted} value={password} onChangeText={setPassword}
          secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" editable={!busy && !blocked}
          style={[field, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.border }]} />
        <SettingsRow divider title="Keep me signed in"
          trailing={<Switch {...settingsSwitchColors(tokens)} accessibilityLabel="Remember optional Sensi session" value={remember} disabled={busy || blocked} onValueChange={setRemember} />} />
      </SettingsGroup>
      <Btn title="Sign In" disabled={busy || blocked || !username.trim() || !password} onPress={() => { void signIn(); }} />
    </> : null}
    <SettingsGroup>
      <SettingsRow action title="Refresh Cloud Session" disabled={busy || blocked} onPress={() => { void sensiCloudAuth.restore(); }} />
      {state.status !== 'signed_out' ? <SettingsRow divider action title="Sign Out" tone="danger" onPress={() => {
        setPassword(''); setMessage('');
        void sensiCloudAuth.signOut().then(ok => { if (live.current && !ok) setMessage('Cloud access is disabled locally. Secure sign-out could not be fully confirmed; retry when available.'); });
      }} /> : null}
    </SettingsGroup>
    <SettingsNote>Cloud processing requires separate consent and backend approval. Safety responses remain available offline.</SettingsNote>
    {message ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{message}</Text> : null}
  </>;
}
