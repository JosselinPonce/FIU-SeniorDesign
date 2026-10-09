import { useState } from 'react';
import { Text, View } from 'react-native';
import { responsiveness } from '../lib/voice/responsivenessDiagnostics';
import { Btn } from './ui';

/** Explicit refresh avoids rendering or subscriber work in audio callbacks. */
export function ResponsivenessDiagnostics() {
  const [snapshot, setSnapshot] = useState(() => responsiveness.snapshot());
  if (!__DEV__) return null;
  const enabled = responsiveness.isEnabled();
  const update = () => setSnapshot(responsiveness.snapshot());
  return <View style={{ gap: 8 }}>
    <Text>Developer responsiveness comparison · {enabled ? 'recording' : 'off'}</Text>
    <Text>RAM only; no transcripts, replies, phone numbers, files or uploads. Test while parked, outside a drive. Warning entries include any phone voice check while enabled.</Text>
    <Btn title={enabled ? 'Stop timing capture (clear)' : 'Start timing capture'} kind="ghost" onPress={() => { responsiveness.setEnabled(!enabled); update(); }} />
    <Btn title="Refresh timing snapshot" kind="ghost" onPress={update} />
    <Btn title="Clear timing snapshot" kind="ghost" onPress={() => { responsiveness.clear(); update(); }} />
    <Text>Times are milliseconds. startedMs is relative to capture/reset; event elapsedMs is relative to its operation. Missing events are unknown, not zero. Microphone events report native capture startup, not proof of the first usable audio sample. Return times include bridge and cleanup.</Text>
    <Text selectable>{JSON.stringify(snapshot, null, 2)}</Text>
  </View>;
}
