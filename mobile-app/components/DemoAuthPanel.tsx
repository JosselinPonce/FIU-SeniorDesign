import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { sensiSessionStorage, sensiSupabase } from '../lib/assistant/sensiSupabase';
import { signInDemo, signOutDemo } from '../lib/assistant/demoAuth';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn, Card, SectionTitle } from './ui';

/** Mounted only in development Settings; no account creation or cloud activation. */
export function DemoAuthPanel() {
  const { colors: C } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const live = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    live.current = true;
    let changed = false;
    const { data: { subscription } } = sensiSupabase.auth.onAuthStateChange((_event, session) => {
      changed = true;
      if (live.current) { setSignedIn(!!session); setPassword(''); }
    });
    void sensiSupabase.auth.getSession().then(({ data, error }) => {
      if (live.current && !changed) {
        setSignedIn(!error && !!data.session);
        if (error) setMessage('Unable to check sign-in. Please try again.');
      }
    }).catch(() => { if (live.current) setMessage('Unable to check sign-in. Please try again.'); });
    return () => { live.current = false; subscription.unsubscribe(); };
  }, []);
  async function submit() {
    if (!__DEV__ || pending.current) return;
    pending.current = true;
    setBusy(true); setMessage('');
    const credential = password;
    setPassword('');
    let ok = false;
    try {
      if (signedIn) ok = await signOutDemo(sensiSupabase.auth);
      else {
        await sensiSessionStorage.select(false);
        ok = await signInDemo(sensiSupabase.auth, email, credential);
      }
    } catch { ok = false; }
    if (live.current) {
      setBusy(false);
      setMessage(ok ? (signedIn ? 'Signed out on this device.' : 'Signed in. Connected AI remains disabled.')
        : 'Unable to complete sign-in or sign-out. Please try again.');
      if (ok) setEmail('');
    }
    pending.current = false;
  }
  if (!__DEV__) return null;
  const input = { color: C.ink, backgroundColor: C.bg, borderColor: C.line,
    borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 48 };
  return <Card>
    <SectionTitle>Developer — Sensi demo sign-in</SectionTitle>
    <Text style={{ color: C.sub }}>Connected AI remains disabled. Sign-out clears the Sensi session without closing the dashboard. Sign-in here is session-only.</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: C.ink }}>{signedIn ? 'Signed in on this device' : 'Signed out'}</Text>
    {!signedIn ? <View style={{ gap: 10 }}>
      <TextInput accessibilityLabel="Demo account email" placeholder="Email" placeholderTextColor={C.sub}
        value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
        autoCorrect={false} autoComplete="off" editable={!busy} style={input} />
      <TextInput accessibilityLabel="Demo account password" placeholder="Password" placeholderTextColor={C.sub}
        value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
        autoCorrect={false} autoComplete="off" textContentType="none" editable={!busy} style={input} />
    </View> : null}
    <Btn title={busy ? 'Please wait…' : signedIn ? 'Sign out on this device' : 'Sign in to demo account'}
      disabled={busy || (!signedIn && (!email.trim() || !password))} onPress={() => void submit()} />
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: C.sub }}>{message}</Text> : null}
  </Card>;
}
