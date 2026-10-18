import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn, Card, SectionTitle } from './ui';
import { appAudio } from '../lib/voice/audioOwnership';
import { getSetting } from '../lib/db/repositories';
import { listLocalVoices, speakLocal, cancelLocalSpeech, listenOffline, cancelOfflineListening,
  subscribeOfflineSpeechProgress, type LocalVoice } from '../modules/local-foundation-models';
import { selectAssistantVoice } from '../modules/local-foundation-models/conversationPolicy';
import type { ConversationState } from '../modules/local-foundation-models/assistantConversation';
import { createSensiVoicePlaybackTest, SENSI_VOICE_TRANSCRIPT, SENSI_VOICE_RESPONSE } from '../lib/assistant/sensiVoicePlaybackTest';

export function SensiVoicePlaybackDiagnostic(props: { blocked: boolean }) {
  const [open, setOpen] = useState(false);
  if (!__DEV__) return null;
  return <Card>
    <SectionTitle>Developer — Sensi voice fixture</SectionTitle>
    {open ? <PlaybackPanel blocked={props.blocked} onClose={() => setOpen(false)} />
      : <Btn title="Open Sensi voice playback test" disabled={props.blocked} onPress={() => setOpen(true)} />}
  </Card>;
}

function PlaybackPanel(props: { blocked: boolean; onClose(): void }) {
  const { colors: C } = useTheme();
  const [state, setState] = useState<ConversationState | null>(null);
  const [voice, setVoice] = useState<LocalVoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState('Ready.');
  const [playback, setPlayback] = useState('No playback yet.');
  const fixture = useRef<ReturnType<typeof createSensiVoicePlaybackTest> | null>(null);
  const alive = useRef(false);
  const running = useRef(false);
  const microphoneTest = useRef(false);
  const blocked = useRef(props.blocked); blocked.current = props.blocked;
  useEffect(() => {
    alive.current = true;
    const test = createSensiVoicePlaybackTest({
      development: __DEV__, audio: appAudio,
      prepare: async () => {
        if (Platform.OS !== 'ios') throw new Error('Use a physical iPhone development build.');
        if (blocked.current) throw new Error('Safety workflow is active.');
        const selected = selectAssistantVoice(await listLocalVoices(), await getSetting('voice:en'));
        if (alive.current) setVoice(selected);
        return selected;
      },
      speak: speakLocal, cancelSpeech: cancelLocalSpeech,
      useMicrophone: () => microphoneTest.current,
      listen: async (id, progress) => {
        const subscription = subscribeOfflineSpeechProgress(event => {
          if (event.requestId === id) progress(event.phase, event.transcript);
        });
        try { return await listenOffline('en-US', id, 15000); }
        finally { subscription.remove(); }
      },
      cancelListening: cancelOfflineListening,
      onChange: next => { if (alive.current) setState(next); },
      onPlayback: (text, result) => {
        if (alive.current) setPlayback(`${result.status} · ${result.reason} · ${result.voiceId} · ${Math.round(result.elapsedMs)} ms\nNative: ${result.nativeRevision ?? 'unknown; native rebuild required'} · started: ${String(result.playbackStarted)} · callback: ${result.completionEvent ?? 'unknown'}\n${text}`);
      },
    });
    fixture.current = test;
    const subscription = AppState.addEventListener('change', status => {
      if (status !== 'active') void test.stop().catch(() => {});
    });
    return () => {
      alive.current = false; fixture.current = null; subscription.remove();
      void test.close().catch(() => {});
    };
  }, []);
  useEffect(() => { if (props.blocked) void fixture.current?.stop().catch(() => {}); }, [props.blocked]);

  async function start(useMicrophone = false) {
    if (!fixture.current || running.current || closing || blocked.current) return;
    running.current = true;
    microphoneTest.current = useMicrophone;
    setBusy(true); setNotice('Running fixture.'); setPlayback('Waiting for native playback.');
    try { await fixture.current.start(); }
    catch (error) { if (alive.current) setNotice(String(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function stop(close = false) {
    if (close) setClosing(true);
    try {
      if (close) await fixture.current?.close(); else await fixture.current?.stop();
      if (alive.current) { setNotice('Native cleanup completed.'); if (close) props.onClose(); }
    } catch (error) { if (alive.current) { setNotice(String(error)); setClosing(false); } }
  }
  async function preempt() {
    try {
      await fixture.current?.preemptWithSafety();
      if (alive.current) setNotice('Safety preemption completed after optional audio cleanup; simulated lease released.');
    } catch (error) { if (alive.current) setNotice(String(error)); }
  }
  const turn = state?.turns.at(-1);
  return <View style={{ gap: 10 }}>
    <Text style={{ color: C.ink }}>Test while parked. No backend, contacts or calls. Standard playback uses a synthetic transcript. The microphone test uses strict on-device recognition after the opening question; say “stop” or the fixture transcript.</Text>
    <Text selectable style={{ color: C.ink }}>Transcript: {SENSI_VOICE_TRANSCRIPT}{'\n'}Response: {SENSI_VOICE_RESPONSE}</Text>
    <Text style={{ color: C.ink }}>Voice: {voice ? `${voice.name} · ${voice.quality} · ${voice.language} · ${voice.id}` : 'Checked on Start using your saved English voice preference.'}</Text>
    <Btn title="Start fixture playback" disabled={busy || closing || props.blocked} onPress={() => void start()} />
    <Btn title="Test prompt then microphone (offline)" disabled={busy || closing || props.blocked} onPress={() => void start(true)} />
    <Btn title="Stop fixture" disabled={!busy || closing} onPress={() => void stop()} />
    <Btn title="Simulate safety preemption" disabled={!busy || closing || props.blocked} onPress={() => void preempt()} />
    <Btn title={closing ? 'Closing after cleanup…' : 'Close voice test'} disabled={closing} onPress={() => void stop(true)} />
    <Text accessibilityLiveRegion="polite" style={{ color: C.ink }}>{state?.phase ?? 'idle'} · {state?.message ?? notice}</Text>
    <Text style={{ color: C.ink }}>{notice}</Text>
    <Text selectable style={{ color: C.ink }}>Policy: connected · usedFallback: {turn ? String(turn.fallback) : 'pending'}{'\n'}Final transcript: {turn?.driver ?? state?.transcript ?? 'pending'}{'\n'}Final reply: {turn?.assistant ?? 'pending'}{'\n'}Native result: {playback}</Text>
  </View>;
}
