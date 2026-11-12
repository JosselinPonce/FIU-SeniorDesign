import { SensiGlyph } from './DashboardAssistantEntry';
import { ScreenHeader } from './ScreenHeader';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useEffect, useState } from 'react';
import { AppState, SafeAreaView, ScrollView, View } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { standbyReadiness, type GemmaFileStatus } from '../lib/assistant/sensiStandby';
import { inspectGemmaModelFile } from '../modules/gemma-poc/phone';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn } from './ui';

/** Safety standby and navigation to the existing simulation; no chat, audio or inference. */
export function SensiStandby({ visible, drive, mode, onClose, onTrySafetyCheck }: {
  visible: boolean; drive: ReturnType<typeof useDriveSession>; mode: AssistantMode | null; onClose(): void; onTrySafetyCheck(): void;
}) {
  const { tokens: t } = useTheme();
  const [model, setModel] = useState<GemmaFileStatus>('checking');
  useEffect(() => {
    if (!visible) return;
    let current = true;
    function refresh() {
      setModel('checking');
      void Promise.resolve().then(inspectGemmaModelFile).then(status => { if (current) setModel(status); })
        .catch(() => { if (current) setModel('unavailable'); });
    }
    refresh();
    const app = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { current = false; app.remove(); };
  }, [visible]);
  if (!visible) return null;
  const readiness = standbyReadiness({ hasDriver: !!drive.driver, activeDrive: drive.hasActiveSession,
    connected: drive.isConnected, voice: drive.voice, model, core: false, monitoring: drive.safety?.monitoring });
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <ScreenHeader title="Sensi" onBack={onClose} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 16 }}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}><SensiGlyph color={t.onPrimary} /></View>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>Hi, I'm Sensi!</Text>
        <Text style={{ color: t.textSecondary, fontSize: 17 }}>Your safety companion. When sensors detect unusual readings, I'll check in while DriveSense is open.</Text>
        <View accessibilityLiveRegion="polite" style={{ padding: 18, gap: 12, borderRadius: 14, backgroundColor: t.surface }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>Current readiness</Text>
          {[readiness[0], readiness[2]].map(line => <Text key={line} style={{ color: t.textSecondary }}>{line}</Text>)}
          <Text style={{ color: t.textSecondary }}>Voice readiness is checked at each safety check. Typed and button responses remain available.</Text>
        </View>
        <Text style={{ color: t.textSecondary }}>Standing by for sensor events. No open-ended chat.</Text>
        <Btn title="Try a Safety Check" disabled={drive.hasActiveSession || !!drive.safety?.check || !!drive.safety?.demo} onPress={onTrySafetyCheck} />
        <Text style={{ color: t.textSecondary }}>Opens Safety Testing. Simulated readings are not saved or uploaded. Real-contact demonstrations require separate approval.</Text>
      </ScrollView>
    </SafeAreaView>;
}
