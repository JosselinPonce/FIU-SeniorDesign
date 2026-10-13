import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { sensiSessionStorage, sensiSupabase } from '../lib/assistant/sensiSupabase';
import { signInDemo, signOutDemo } from '../lib/assistant/demoAuth';
import { demoEmail, DEMO_USERNAME, restoreDemoSession, startupRoute } from '../lib/assistant/demoStartup';
import { Btn } from './ui';

const enabled = __DEV__ && process.env.EXPO_PUBLIC_SENSI_DEMO_MODE === 'true';
const configuredEmail = process.env.EXPO_PUBLIC_SENSI_DEMO_EMAIL ?? '';

/** Admission is latched. Expiry/sign-out never unmounts an admitted dashboard. */
export function DemoStartup({ children }: { children: ReactNode }) {
  const { colors: C } = useTheme();
  const [admitted, setAdmitted] = useState(false);
  const [checking, setChecking] = useState(enabled);
  const [username, setUsername] = useState(DEMO_USERNAME);
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    let active = true;
    const email = demoEmail(DEMO_USERNAME, configuredEmail);
    let timer: ReturnType<typeof setTimeout>;
    const brief = new Promise<void>(resolve => { timer = setTimeout(resolve, 700); });
    let timerDeadline: ReturnType<typeof setTimeout>;
    const deadline = new Promise<boolean>(resolve => { timerDeadline = setTimeout(() => resolve(false), 12_000); });
    void Promise.all([brief, Promise.race([
      email ? restoreDemoSession(sensiSupabase.auth, email) : Promise.resolve(false), deadline,
    ])]).then(([, valid]) => {
      if (!active) return;
      clearTimeout(timerDeadline);
      if (valid && !sensiSessionStorage.hasError()) setAdmitted(true);
      setChecking(false);
      if (sensiSessionStorage.hasError()) setMessage('Secure sign-in storage is unavailable. Please try again after unlocking your phone.');
    });
    return () => { active = false; alive.current = false; clearTimeout(timer); clearTimeout(timerDeadline); };
  }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    const credential = password;
    setPassword('');
    let ok = false;
    try {
      const email = demoEmail(username, configuredEmail);
      if (email) {
        // End any restored session before choosing where the new session lives.
        if (!await signOutDemo(sensiSupabase.auth)) throw new Error('Sign-in unavailable');
        await sensiSessionStorage.select(keep);
        ok = await signInDemo(sensiSupabase.auth, email, credential)
          && await restoreDemoSession(sensiSupabase.auth, email)
          && !sensiSessionStorage.hasError();
        if (!ok) await signOutDemo(sensiSupabase.auth);
      }
    } catch { ok = false; }
    if (alive.current) {
      setBusy(false);
      if (ok) setAdmitted(true);
      else setMessage('Unable to sign in. Check your details, connection and device storage, then try again.');
    }
    pending.current = false;
  }
  if (startupRoute(enabled, admitted, false) === 'dashboard') return <>{children}</>;
  const input = { color: C.ink, backgroundColor: C.card, borderColor: C.line,
    borderWidth: 1, borderRadius: 12, padding: 14, minHeight: 48 };
  return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 16 }}>
          <Image source={require('../assets/branding/drivesense-logo.png')} accessibilityLabel="DriveSense logo"
            resizeMode="contain" style={{ width: 144, height: 144, alignSelf: 'center' }} />
          <Text accessibilityRole="header" style={{ color: C.ink, fontSize: 28, fontWeight: '800', textAlign: 'center' }}>DriveSense</Text>
          <Text style={{ color: C.sub, textAlign: 'center' }}>Driven by Safety. Powered by Insight.</Text>
          {checking ? <Text accessibilityLiveRegion="polite" style={{ color: C.sub, textAlign: 'center' }}>Getting ready…</Text> : <>
            <Text style={{ color: C.sub }}>Senior Design demo sign-in</Text>
            {!demoEmail(DEMO_USERNAME, configuredEmail) ? <Text style={{ color: C.sub }}>Demo account mapping is not configured.</Text> : null}
            <TextInput accessibilityLabel="Demo username" value={username} onChangeText={setUsername}
              autoCapitalize="none" autoCorrect={false} autoComplete="off" editable={!busy} style={input} />
            <TextInput accessibilityLabel="Demo password" placeholder="Password" placeholderTextColor={C.sub}
              value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
              autoCorrect={false} autoComplete="off" textContentType="none" editable={!busy} style={input} />
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: keep, disabled: busy }}
              disabled={busy} onPress={() => setKeep(value => !value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
              <View style={{ width: 24, height: 24, borderWidth: 1, borderColor: C.sub, borderRadius: 5, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: C.ink }}>{keep ? '✓' : ''}</Text>
              </View>
              <Text style={{ color: C.ink }}>Keep me signed in</Text>
            </Pressable>
            <Btn title={busy ? 'Signing in…' : 'Sign In'} disabled={busy || !password || !demoEmail(username, configuredEmail)} onPress={() => void submit()} />
            {message ? <Text accessibilityLiveRegion="polite" style={{ color: C.sub }}>{message}</Text> : null}
          </>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
