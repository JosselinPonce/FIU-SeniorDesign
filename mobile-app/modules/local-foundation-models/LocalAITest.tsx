import { useEffect, useRef, useState } from 'react';
import { Modal, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Btn, C } from '../../components/ui';
import { OfflineSpeechTest } from './OfflineSpeechTest';
import { VoiceConversationTest } from './VoiceConversationTest';
import {
  cancelDriverInterpretation, checkFoundationModelsAvailability, interpretDriverResponse,
  type DriverInterpretationResponse, type FoundationModelsAvailability,
} from './index';

/** Temporary development-only entry, independent of driver/session navigation. */
export function LocalAITest(props: { onAudioBusyChange?: (busy: boolean) => void }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FoundationModelsAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [interpreting, setInterpreting] = useState(false);
  const [interpretation, setInterpretation] = useState<DriverInterpretationResponse | null>(null);
  const [interpretationError, setInterpretationError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const audioActive = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const checking = useRef(false);
  const counter = useRef(0);
  const active = useRef<{ id: string; cancelled: boolean } | null>(null);

  function updateAudioBusy(value: boolean) {
    audioActive.current = value;
    if (mounted.current) {
      setAudioBusy(value);
      props.onAudioBusyChange?.(value);
    }
  }

  function tryBeginAudioOperation(): boolean {
    if (audioActive.current || checking.current || active.current) return false;
    updateAudioBusy(true); // synchronous lease before any React render/await
    return true;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      const request = active.current;
      if (request && !request.cancelled) {
        request.cancelled = true;
        void cancelDriverInterpretation(request.id).catch(() => {});
      }
    };
  }, []);

  function cancel() {
    const request = active.current;
    if (!request || request.cancelled) return;
    const version = epoch.current;
    request.cancelled = true;
    setInterpretationError('Cancellation requested. Waiting for native inference to finish.');
    void cancelDriverInterpretation(request.id).catch((cause: unknown) => {
      if (mounted.current && epoch.current === version && active.current === request) {
        setInterpretationError(`Cancellation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    });
  }

  function close() {
    epoch.current += 1;
    cancel();
    setVisible(false);
  }

  async function testInterpretation() {
    // Ref lock closes the gap before React renders disabled buttons.
    if (active.current || checking.current || audioActive.current || !text.trim()) return;
    const request = { id: `${Date.now()}-${++counter.current}`, cancelled: false };
    const version = epoch.current;
    const started = performance.now();
    active.current = request;
    setInterpreting(true);
    setInterpretation(null);
    setInterpretationError(null);
    setElapsedMs(null);
    try {
      const response = await interpretDriverResponse(text.trim(), request.id);
      if (mounted.current && epoch.current === version && !request.cancelled) {
        setInterpretation(response);
      }
    } catch (cause) {
      if (mounted.current && epoch.current === version && !request.cancelled) {
        setInterpretationError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (active.current === request) active.current = null;
      if (mounted.current) {
        setInterpreting(false);
        // Closing/unmounting invalidates all result and timing updates.
        if (epoch.current === version) {
          setElapsedMs(performance.now() - started);
          if (request.cancelled) setInterpretationError('Interpretation cancelled; result discarded.');
        }
      }
    }
  }

  async function check() {
    if (checking.current || active.current || audioActive.current) return;
    checking.current = true;
    const version = epoch.current;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const status = await checkFoundationModelsAvailability();
      if (mounted.current && epoch.current === version) setResult(status);
    } catch (cause) {
      if (mounted.current && epoch.current === version) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      checking.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (!__DEV__) return null;

  return (
    <>
      <View style={styles.entry}>
        <Btn title="Local AI Test" kind="ghost" onPress={() => setVisible(true)} />
      </View>
      <Modal visible={visible} animationType="slide" onRequestClose={close}>
        <SafeAreaView style={styles.modal}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Local AI Test</Text>
            <Text style={styles.text}>Development only · Foundation Models prototype</Text>
            <Text style={styles.text}>No driver, drive session, or Raspberry Pi connection required.</Text>
            <Btn title="Check availability" busy={busy} disabled={interpreting || audioBusy} onPress={() => void check()} />
            <View accessibilityLiveRegion="polite" style={styles.result}>
              <Text selectable style={styles.text}>available: {result ? String(result.available) : '—'}</Text>
              <Text selectable style={styles.text}>reason: {result?.reason ?? (error !== null ? 'check_failed' : busy ? 'checking' : 'not_checked')}</Text>
              <Text selectable style={[styles.text, error !== null && styles.error]}>
                message: {result?.message ?? error ?? (busy ? 'Checking…' : 'Tap Check availability.')}
              </Text>
            </View>
            <Text style={styles.text}>AI interpretation is advisory only. Existing deterministic consent rules remain authoritative. This test never calls anyone or triggers emergency actions.</Text>
            <Text style={styles.text}>Typed answer to “Are you feeling okay?” (no prior contact offer)</Text>
            <TextInput
              accessibilityLabel="Typed driver response"
              placeholder="I'm feeling dizzy, please call my mom."
              value={text}
              onChangeText={setText}
              multiline
              maxLength={500}
              editable={!interpreting && !audioBusy}
              style={styles.input}
            />
            <Btn title="Test Interpretation" busy={interpreting} disabled={busy || audioBusy || !text.trim()} onPress={() => void testInterpretation()} />
            {interpreting ? <Btn title="Cancel interpretation" kind="ghost" onPress={cancel} /> : null}
            <View accessibilityLiveRegion="polite" style={styles.result}>
              <Text selectable style={styles.text}>Processing time (native): {interpretation ? `${Math.round(interpretation.processingTimeMs)} ms` : '—'}</Text>
              <Text selectable style={styles.text}>Total time (including bridge): {elapsedMs !== null ? `${Math.round(elapsedMs)} ms` : interpreting ? 'Processing…' : '—'}</Text>
              <Text selectable style={styles.text}>{interpretation ? JSON.stringify(interpretation, null, 2) : 'No interpretation result.'}</Text>
              {interpretationError !== null ? <Text selectable style={[styles.text, styles.error]}>{interpretationError}</Text> : null}
              {interpretation?.status === 'error' ? <Text selectable style={[styles.text, styles.error]}>{interpretation.error.code}: {interpretation.error.message}</Text> : null}
            </View>
            {visible ? <OfflineSpeechTest disabled={busy || interpreting || audioBusy}
              tryBegin={tryBeginAudioOperation} onBusyChange={updateAudioBusy} /> : null}
            {visible ? <VoiceConversationTest disabled={busy || interpreting || audioBusy}
              tryBegin={tryBeginAudioOperation} onBusyChange={updateAudioBusy} /> : null}
            <Btn title="Close" kind="ghost" onPress={close} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  entry: { paddingTop: 54, paddingHorizontal: 18, paddingBottom: 8, backgroundColor: C.bg },
  modal: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', color: C.ink },
  text: { fontSize: 16, color: C.ink },
  result: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: C.card },
  error: { color: C.bad },
  input: { minHeight: 90, padding: 12, borderWidth: 1, borderColor: C.line, borderRadius: 12, backgroundColor: C.card, color: C.ink, fontSize: 16, textAlignVertical: 'top' },
});
