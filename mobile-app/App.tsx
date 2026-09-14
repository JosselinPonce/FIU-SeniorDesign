import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from './lib/supabase';
import {
  AudioModule,
  createAudioPlayer,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { speak, stopSpeaking } from './lib/elevenlabs';
import { decideReply, interpretCallAnswer, transcribe } from './lib/openai';
import {
  getEmergencyContact,
  logIncident,
  subscribeToVitals,
} from './lib/monitoring';
import type { AgentDecision, PiStatus, VitalsAlert } from './lib/types';

type AgentState =
  | 'testing'
  | 'idle'
  | 'alerting'
  | 'listening'
  | 'thinking'
  | 'responding';

// --- Voice-agent tuning constants ---
// Metering is in negative decibels: closer to 0 is louder.
const SILENCE_DB_THRESHOLD = -35;
// Stop listening after this much continuous silence once speech was heard.
const SILENCE_STOP_MS = 1500;
// Never listen longer than this (safety cap; metering handles the normal case).
const HARD_CAP_SECONDS = 15;
// Shorter cap for the yes/no emergency-call round.
const CALL_LISTEN_CAP_SECONDS = 8;
// Ignore silence stops before this so the mic has time to pick up speech.
const MIN_LISTEN_MS = 1500;
const MIC_TEST_SECONDS = 3;
// Below this size a recording cannot contain meaningful speech.
const MIN_RECORDING_BYTES = 2048;

const CHECK_IN_LINES: Record<PiStatus, string> = {
  NORMAL: '',
  HIGH_HEART_RATE:
    'Your heart rate is elevated. Are you feeling okay?',
  LOW_HEART_RATE:
    'Your heart rate is low. Are you feeling okay?',
  LOW_SPO2:
    'Your oxygen level is low. Are you feeling okay?',
};

export default function App() {
  const [reading, setReading] = useState('');
  const [sendStatus, setSendStatus] = useState('Waiting...');
  const [alert, setAlert] = useState<VitalsAlert | null>(null);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentError, setAgentError] = useState('');

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 150);

  // Synchronous lock: state updates alone cannot exclude two callbacks in one tick.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const stopRecordingRef = useRef<(() => void) | null>(null);
  const meteringRef = useRef<number | null>(null);
  const playbackRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  meteringRef.current = recorderState.metering ?? null;

  function ensureMounted() {
    if (!mountedRef.current) {
      throw new Error('Voice session cancelled.');
    }
  }

  // Read the latest handler without resubscribing or capturing an old alert/recorder.
  const handleAlertRef = useRef(handleAlert);
  handleAlertRef.current = handleAlert;
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeToVitals((next) => {
      void handleAlertRef.current(next);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      stopRecordingRef.current?.();
      playbackRef.current?.release();
      playbackRef.current = null;
      void stopSpeaking();
    };
  }, []);

  async function say(text: string) {
    ensureMounted();
    await speak(text);
    ensureMounted();
  }

  // One owner stops the recorder. Manual completion, silence and timeout all
  // resolve the same promise, so none can launch a second processing pipeline.
  async function recordAudio(seconds: number, detectSilence: boolean) {
    ensureMounted();
    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    ensureMounted();
    if (!granted) {
      throw new Error('Microphone permission denied.');
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    ensureMounted();
    await recorder.prepareToRecordAsync();
    if (!mountedRef.current) {
      await recorder.stop();
      ensureMounted();
    }
    try {
      recorder.record();
      setAgentState(detectSilence ? 'listening' : 'testing');
      await new Promise<void>((resolve) => {
        const started = Date.now();
        let heardSpeech = false;
        let lastLoud = started;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearInterval(interval);
          clearTimeout(timeout);
          stopRecordingRef.current = null;
          resolve();
        };
        const interval = setInterval(() => {
          const now = Date.now();
          const db = meteringRef.current;
          if (db !== null && db > SILENCE_DB_THRESHOLD) {
            heardSpeech = true;
            lastLoud = now;
          }
          if (detectSilence && heardSpeech && now - started > MIN_LISTEN_MS &&
              now - lastLoud > SILENCE_STOP_MS) finish();
        }, 200);
        const timeout = setTimeout(finish, seconds * 1000);
        stopRecordingRef.current = finish;
      });
    } finally {
      await recorder.stop();
    }
    ensureMounted();
    return recorder.uri;
  }

  async function listen(seconds: number): Promise<string> {
    const uri = await recordAudio(seconds, true);
    setAgentState('thinking');
    if (!uri) return '';
    const file = new File(uri);
    try {
      if (file.size < MIN_RECORDING_BYTES) return '';
      const heard = await transcribe(uri);
      ensureMounted();
      setTranscript(heard);
      return heard;
    } finally {
      if (file.exists) file.delete();
    }
  }

  async function handleAlert(next: VitalsAlert) {
    // Prototype policy: ignore new alerts while a conversation or mic test owns
    // the audio session. Never overwrite that conversation's incident reading.
    if (busyRef.current || !mountedRef.current) return;
    setAlert(next);
    setTranscript('');
    setAgentError('');
    if (next.status === 'NORMAL') {
      setSendStatus('Biometric readings are normal.');
      return;
    }
    busyRef.current = true;
    setAgentState('alerting');
    const heard: string[] = [];
    let decision: AgentDecision | null = null;
    let askedEmergencyCall = false;
    let dialerOpened = false;
    try {
      await say(CHECK_IN_LINES[next.status]);
      const reply = await listen(HARD_CAP_SECONDS);
      heard.push(reply);
      if (!reply) {
        setAgentState('responding');
        await say("I didn't catch that. Please try again.");
        return;
      }
      // Use the immutable argument, never render-local alert state.
      const result = await decideReply(next, reply);
      ensureMounted();
      decision = result;
      setAgentState('responding');
      await say(result.reply);
      if (result.offerCall) {
        const contact = await getEmergencyContact();
        ensureMounted();
        if (contact) {
          askedEmergencyCall = true;
          setAgentState('alerting');
          await say(`Would you like me to call ${contact.name}?`);
          const answerText = await listen(CALL_LISTEN_CAP_SECONDS);
          heard.push(answerText);
          if (answerText) {
            const answer = await interpretCallAnswer(answerText);
            ensureMounted();
            setAgentState('responding');
            if (answer.placeCall) {
              await say(`Okay. Opening the dialer for ${contact.name} now.`);
              // Keep contact local and open the dialer BEFORE cleanup/logging.
              await Linking.openURL(`tel:${contact.phone}`);
              dialerOpened = true;
            } else if (answer.ack) {
              await say(answer.ack);
            }
          } else {
            setAgentState('responding');
            await say("I didn't catch that. I won't open the dialer.");
          }
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setAgentError(error instanceof Error ? error.message : 'Voice agent failed.');
      }
    } finally {
      try {
        if (mountedRef.current) {
          await logIncident(next, {
            driverReply: heard.filter(Boolean).join(' / '),
            response: decision?.reply ?? 'No response captured',
            action: decision?.action ?? 'log',
            askedEmergencyCall,
            // TODO: Existing prototype column means dialer opened, not a
            // confirmed connected call. Revisit semantics without a migration here.
            callPlaced: dialerOpened,
          });
        }
      } catch (error) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : 'Incident logging failed.';
          setAgentError((previous) => previous ? `${previous} ${message}` : message);
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setAgentState('idle');
      }
    }
  }

  function simulatePiMessage() {
    void handleAlert({
      eventId: null,
      sessionId: null,
      heart_rate: 135,
      spo2: 97,
      signal_quality: 90,
      status: 'HIGH_HEART_RATE',
      severity: 'warning',
      timestamp: new Date().toISOString(),
    });
  }

  async function testMic() {
    if (busyRef.current || !mountedRef.current) return;
    busyRef.current = true;
    setAgentState('testing');
    setAgentError('');
    setSendStatus('Mic test: speak now...');
    let file: File | null = null;
    try {
      const uri = await recordAudio(MIC_TEST_SECONDS, false);
      if (!uri) throw new Error('No recording was produced.');
      file = new File(uri);
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      ensureMounted();
      setSendStatus('Mic test: playing back your recording...');
      await new Promise<void>((resolve, reject) => {
        const player = createAudioPlayer(uri);
        playbackRef.current = player;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          stopRecordingRef.current = null;
          player.release();
          playbackRef.current = null;
          if (error) reject(error); else resolve();
        };
        const timeout = setTimeout(finish, (MIC_TEST_SECONDS + 5) * 1000);
        stopRecordingRef.current = finish;
        player.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) finish();
        });
        try { player.play(); } catch (error) { finish(error); }
      });
      ensureMounted();
      setSendStatus('Mic test complete.');
    } catch (error) {
      if (mountedRef.current) {
        setSendStatus(error instanceof Error ? `Mic test failed: ${error.message}` : 'Mic test failed.');
      }
    } finally {
      try { if (file?.exists) file.delete(); } finally {
        busyRef.current = false;
        if (mountedRef.current) setAgentState('idle');
      }
    }
  }

  async function sendTestReading() {
    const numericReading = Number(reading);

    if (reading.trim() === '' || Number.isNaN(numericReading)) {
      setSendStatus('Please enter a valid number.');
      return;
    }

    setSendStatus('Sending...');

    const { error } = await supabase
      .from('test_readings')
      .insert({
        value: numericReading,
        device_name: 'test-iphone',
      });

    if (error) {
      console.error(error);
      setSendStatus(`Error: ${error.message}`);
      return;
    }

    setSendStatus(`Reading ${numericReading} sent successfully!`);
    setReading('');
  }

  return (
    <Pressable style={styles.container} onPress={Keyboard.dismiss}>
      <Text style={styles.title}>Sensor Test App</Text>

      <TextInput
        style={styles.input}
        placeholder="Enter test reading"
        keyboardType="decimal-pad"
        returnKeyType="done"
        onSubmitEditing={Keyboard.dismiss}
        value={reading}
        onChangeText={setReading}
      />

      <Button
        title="SEND TEST READING"
        onPress={sendTestReading}
      />

      {agentState === 'idle' && (
        <Button title="TEST MIC" onPress={testMic} />
      )}

      <Button
        title="SIMULATE PI MESSAGE"
        onPress={simulatePiMessage}
        disabled={agentState !== 'idle'}
      />

      {alert && (
        <View>
          <Text>Heart Rate: {alert.heart_rate} BPM</Text>
          <Text>SpO₂: {alert.spo2}%</Text>
          <Text>Status: {alert.status}</Text>
          <Text>Severity: {alert.severity}</Text>
          {alert.signal_quality !== null && (
            <Text>Signal Quality: {alert.signal_quality}%</Text>
          )}
        </View>
      )}

      <View style={styles.agentBox}>
        <View style={styles.agentStatusRow}>
          {agentState === 'thinking' && <ActivityIndicator size="small" />}
          <Text style={styles.agentStatus}>{AGENT_STATE_LABEL[agentState]}</Text>
        </View>

        {agentState === 'listening' && (
          <Button title="DONE SPEAKING" onPress={() => stopRecordingRef.current?.()} />
        )}

        {transcript !== '' && <Text>Heard: "{transcript}"</Text>}
      </View>

      {agentError !== '' && (
        <Text style={styles.errorText}>{agentError}</Text>
      )}

      <Text style={styles.status}>{sendStatus}</Text>
    </Pressable>
  );
}

// Status labels for the voice agent state machine.
const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: 'Monitoring.',
  testing: 'Testing microphone...',
  alerting: 'Speaking...',
  listening: 'Listening — speak, then pause.',
  thinking: 'Thinking...',
  responding: 'Responding...',
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  input: {
    width: '80%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
  },
  status: {
    fontSize: 16,
    textAlign: 'center',
  },
  agentBox: {
    alignItems: 'center',
    gap: 8,
  },
  agentStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  agentStatus: {
    fontSize: 16,
    fontWeight: '600',
  },
  errorText: {
    color: '#b3261e',
    textAlign: 'center',
    fontSize: 13,
  },
});