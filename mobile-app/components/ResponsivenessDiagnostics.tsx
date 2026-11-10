import { useTheme } from '../lib/theme/ThemeProvider';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { responsiveness, debugSessionAlignmentEnabled, setDebugSessionAlignmentEnabled } from '../lib/voice/responsivenessDiagnostics';
import { checkOfflineSpeechCapability, checkSpanishTranscriberCapability, spanishTranscriberReadiness, type OfflineSpeechCapability, type SpanishTranscriberCapability } from '../modules/local-foundation-models';
import { Btn } from './ui';
import { SpanishTranscriberMicrophoneDiagnostic } from './SpanishTranscriberMicrophoneDiagnostic';

const SPANISH_LOCALES = ['es-US', 'es-ES', 'es-MX'] as const;
type SpanishCapabilityResult = {
  locale: string;
  capability?: OfflineSpeechCapability;
  error?: string;
};

/** Explicit refresh avoids rendering or subscriber work in audio callbacks. */
export function ResponsivenessDiagnostics({ blocked = false }: { blocked?: boolean }) {
  const { tokens } = useTheme();
  const [snapshot, setSnapshot] = useState(() => responsiveness.snapshot());
  const [alignedSession, setAlignedSession] = useState(() => debugSessionAlignmentEnabled());
  const [checkingSpanish, setCheckingSpanish] = useState(false);
  const [spanishResults, setSpanishResults] = useState<SpanishCapabilityResult[]>([]);
  const [checkingTranscriber, setCheckingTranscriber] = useState(false);
  const [transcriber, setTranscriber] = useState<SpanishTranscriberCapability | null>(null);
  const [transcriberError, setTranscriberError] = useState('');
  async function checkTranscriber() {
    if (!__DEV__ || checkingTranscriber) return;
    setCheckingTranscriber(true);
    setTranscriber(null);
    setTranscriberError('');
    try { setTranscriber(await checkSpanishTranscriberCapability()); }
    catch (error) { setTranscriberError(error instanceof Error ? error.message : 'SpeechTranscriber capability check failed.'); }
    finally { setCheckingTranscriber(false); }
  }
  async function checkSpanishSupport() {
    if (!__DEV__ || checkingSpanish) return;
    setCheckingSpanish(true);
    setSpanishResults([]);
    try {
      // Capability queries only: no capture, authorization requests or VoiceCheck.
      const results = await Promise.allSettled(SPANISH_LOCALES.map(locale => checkOfflineSpeechCapability(locale)));
      setSpanishResults(results.map((result, index) => result.status === 'fulfilled'
        ? { locale: SPANISH_LOCALES[index], capability: result.value }
        : { locale: SPANISH_LOCALES[index], error: result.reason instanceof Error ? result.reason.message : 'Capability check failed.' }));
    } finally {
      setCheckingSpanish(false);
    }
  }
  if (!__DEV__) return null;
  const enabled = responsiveness.isEnabled();
  const update = () => setSnapshot(responsiveness.snapshot());
  return <View style={{ gap: 8 }}>
    <Text style={{ color: tokens.textSecondary }}>Developer responsiveness comparison · {enabled ? 'recording' : 'off'}</Text>
    <Text style={{ color: tokens.textSecondary }}>RAM only; no transcripts, replies, phone numbers, files or uploads. Test while parked, outside a drive. Warning entries include any phone voice check while enabled.</Text>
    <Btn title={enabled ? 'Stop timing capture (clear)' : 'Start timing capture'} kind="ghost" onPress={() => { responsiveness.setEnabled(!enabled); update(); }} />
    <Btn title={alignedSession ? 'Disable Debug aligned VoiceCheck session' : 'Enable Debug aligned VoiceCheck session'} kind="ghost" disabled={blocked} onPress={() => {
      const enabled = !alignedSession; setDebugSessionAlignmentEnabled(enabled); setAlignedSession(enabled);
    }} />
    <Text style={{ color: tokens.textSecondary }}>Opt-in Debug test, reset on app restart. Uses a recording-compatible session for the prompt without starting microphone capture; built-in iPhone audio only. Other routes or unavailable setup use the existing sequential session. Check the exact selected voice, volume and route before relying on it.</Text>
    <Btn title="Refresh timing snapshot" kind="ghost" onPress={update} />
    <Btn title="Clear timing snapshot" kind="ghost" onPress={() => { responsiveness.clear(); update(); }} />
    <Text style={{ color: tokens.textSecondary }}>Times are milliseconds. startedMs is relative to capture/reset; event elapsedMs is relative to its operation. Missing events are unknown, not zero. Microphone events report native capture startup, not proof of the first usable audio sample. Return times include bridge and cleanup.</Text>
    <Text selectable style={{ color: tokens.textSecondary }}>{JSON.stringify(snapshot, null, 2)}</Text>
    <Btn title="Check Spanish offline recognition support" kind="ghost" busy={checkingSpanish} onPress={() => void checkSpanishSupport()} />
    <Text style={{ color: tokens.textSecondary }}>Read-only capability check; does not record audio or request permissions.</Text>
    {checkingSpanish ? <Text accessibilityLiveRegion="polite" style={{ color: tokens.textSecondary }}>Checking Spanish locales…</Text> : null}
    {spanishResults.map(({ locale, capability, error }) => <View key={locale} style={{ gap: 2 }}>
      <Text style={{ color: tokens.textSecondary, fontWeight: '600' }}>{locale}</Text>
      {capability ? <>
        <Text style={{ color: tokens.textSecondary }}>Offline recognition support: {capability.supportsOnDeviceRecognition ? 'Yes' : 'No'}</Text>
        <Text style={{ color: tokens.textSecondary }}>Recognizer available: {capability.recognizerAvailable ? 'Yes' : 'No'}</Text>
        {capability.reason && capability.reason !== 'supported' ? <Text style={{ color: tokens.textSecondary }}>Reason: {capability.reason}</Text> : null}
        {capability.speechPermission ? <Text style={{ color: tokens.textSecondary }}>Speech recognition permission: {capability.speechPermission}</Text> : null}
      </> : <Text selectable style={{ color: tokens.textSecondary }}>Offline recognition support: Unknown · Recognizer available: Unknown{ '\n' }Reason: {error}</Text>}
    </View>)}
    <Btn title="Check Spanish SpeechTranscriber support" kind="ghost" busy={checkingTranscriber} onPress={() => void checkTranscriber()} />
    <Text style={{ color: tokens.textSecondary }}>iOS 26 on-device engine · Read-only; no audio, permission requests, or asset downloads.</Text>
    {checkingTranscriber ? <Text accessibilityLiveRegion="polite" style={{ color: tokens.textSecondary }}>Checking SpeechTranscriber…</Text> : null}
    {transcriberError ? <Text selectable style={{ color: tokens.textSecondary }}>{transcriberError}</Text> : null}
    {transcriber ? <View style={{ gap: 4 }}>
      <Text style={{ color: tokens.textSecondary }}>iOS: {transcriber.osVersion}</Text>
      <Text style={{ color: tokens.textSecondary }}>Device compatibility: {transcriber.status === 'requires_ios_26' ? 'Requires iOS 26 or later' : transcriber.deviceAvailable ? 'Available' : 'Hardware/capabilities unavailable'}</Text>
      <Text style={{ color: tokens.textSecondary }}>App-reserved locales: {transcriber.reservedLocales?.join(', ') || 'None'} · Maximum reservations: {transcriber.maximumReservedLocales ?? 'Unknown (rebuild Debug app)'}</Text>
      {transcriber.deviceAvailable ? <>
        <Text style={{ color: tokens.textSecondary }}>Supported Spanish locales: {transcriber.supportedSpanishLocales.join(', ') || 'None'}</Text>
        <Text style={{ color: tokens.textSecondary }}>Installed Spanish locales: {transcriber.installedSpanishLocales.join(', ') || 'None'}</Text>
        {transcriber.requestedLocales.map(row => <Text key={row.locale} style={{ color: tokens.textSecondary }}>{row.locale}: {row.exactSupported ? 'Exact locale supported' : 'Exact locale unsupported'} · Equivalent: {row.equivalentLocale ?? 'None'}</Text>)}
        {transcriber.assets.map(row => <Text key={row.locale} style={{ color: tokens.textSecondary }}>{row.locale}: raw AssetInventory status: {row.assetStatus} · Installed-locale list: {row.installedLocale ? 'Yes' : 'No'} · {spanishTranscriberReadiness(row)}</Text>)}
      </> : null}
    </View> : null}
    <SpanishTranscriberMicrophoneDiagnostic blocked={blocked} />
  </View>;
}
