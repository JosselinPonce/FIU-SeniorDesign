import { useTheme } from '../lib/theme/ThemeProvider';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { responsiveness } from '../lib/voice/responsivenessDiagnostics';
import { checkSpanishTranscriberCapability, spanishTranscriberReadiness, type SpanishTranscriberCapability } from '../modules/local-foundation-models';
import { Btn } from './ui';
import { SpanishTranscriberMicrophoneDiagnostic } from './SpanishTranscriberMicrophoneDiagnostic';

/** Explicit refresh avoids rendering or subscriber work in audio callbacks. */
export function ResponsivenessDiagnostics({ blocked = false }: { blocked?: boolean }) {
  const { tokens } = useTheme();
  const [snapshot, setSnapshot] = useState(() => responsiveness.snapshot());
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
  if (!__DEV__) return null;
  const enabled = responsiveness.isEnabled();
  const update = () => setSnapshot(responsiveness.snapshot());
  return <View style={{ gap: 8 }}>
    <Text style={{ color: tokens.textSecondary }}>Developer responsiveness comparison · {enabled ? 'recording' : 'off'}</Text>
    <Text style={{ color: tokens.textSecondary }}>RAM only; no transcripts, replies, phone numbers, files or uploads. Test while parked, outside a drive. Warning entries include any phone voice check while enabled.</Text>
    <Btn title={enabled ? 'Stop timing capture (clear)' : 'Start timing capture'} kind="ghost" onPress={() => { responsiveness.setEnabled(!enabled); update(); }} />
    <Btn title="Refresh timing snapshot" kind="ghost" onPress={update} />
    <Btn title="Clear timing snapshot" kind="ghost" onPress={() => { responsiveness.clear(); update(); }} />
    <Text style={{ color: tokens.textSecondary }}>Times are milliseconds. startedMs is relative to capture/reset; event elapsedMs is relative to its operation. Missing events are unknown, not zero. Microphone events report native capture startup, not proof of the first usable audio sample. Return times include bridge and cleanup.</Text>
    <Text selectable style={{ color: tokens.textSecondary }}>{JSON.stringify(snapshot, null, 2)}</Text>
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
