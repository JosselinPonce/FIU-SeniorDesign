import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { loadProfiles, saveProfile, type DriverProfile } from './lib/profiles';
import { openPhone } from './lib/phone';
import { supabase } from './lib/supabase';
import {
  AudioModule,
  createAudioPlayer,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
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
const SILENCE_DB_THRESHOLD = -30;
// Stop listening after this much continuous silence once speech was heard.
const SILENCE_STOP_MS = 1250;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [testLabel, setTestLabel] = useState('Testing microphone');
  const [reading, setReading] = useState('');
  const [sendStatus, setSendStatus] = useState('Waiting...');
  const [alert, setAlert] = useState<VitalsAlert | null>(null);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentError, setAgentError] = useState('');

  const [profiles, setProfiles] = useState<DriverProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [driverName, setDriverName] = useState('');
  const [age, setAge] = useState('');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [gender, setGender] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [profileStatus, setProfileStatus] = useState('Loading profiles...');
  const [profileBusy, setProfileBusy] = useState(true);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const profileIdRef = useRef<string | null>(null);
  const profileBusyRef = useRef(false);

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  // Synchronous lock: state updates alone cannot exclude two callbacks in one tick.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const stopRecordingRef = useRef<(() => void) | null>(null);
  const playbackRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

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

  function populateProfile(profile: DriverProfile | null) {
    profileIdRef.current = profile?.id ?? null;
    setProfileId(profile?.id ?? null);
    setDriverName(profile?.display_name ?? '');
    setAge(profile?.age?.toString() ?? '');
    setHeight(profile?.height_cm?.toString() ?? '');
    setWeight(profile?.weight_kg?.toString() ?? '');
    setGender(profile?.gender ?? '');
    setContactName(profile?.emergency_contact_name ?? '');
    setContactPhone(profile?.emergency_contact_phone ?? '');
  }

  async function refreshProfiles() {
    if (profileBusyRef.current || busyRef.current) return;
    profileBusyRef.current = true;
    setProfileBusy(true);
    setProfilesLoaded(false);
    try {
      const rows = await loadProfiles();
      ensureMounted();
      setProfiles(rows);
      populateProfile(rows.length === 1 ? rows[0] : null);
      setProfilesLoaded(true);
      setProfileStatus(rows.length === 0 ? 'Create your driver profile to get started.' :
        rows.length === 1 ? 'Profile loaded.' : 'Multiple profiles found. This app requires one driver profile.');
    } catch (error) {
      if (mountedRef.current) setProfileStatus(error instanceof Error ? error.message : 'Could not load profiles.');
    } finally {
      profileBusyRef.current = false;
      if (mountedRef.current) setProfileBusy(false);
    }
  }

  useEffect(() => { void refreshProfiles(); }, []);

  async function saveSetup() {
    if (busyRef.current || profileBusyRef.current || !profilesLoaded) return;
    if (!profileIdRef.current && profiles.length > 0) {
      setProfileStatus('Unable to save: this app requires one driver profile.');
      return;
    }
    profileBusyRef.current = true;
    setProfileBusy(true);
    try {
      const saved = await saveProfile(profileIdRef.current, {
        display_name: driverName,
        age,
        height_cm: height,
        weight_kg: weight,
        gender,
        emergency_contact_name: contactName,
        emergency_contact_phone: contactPhone,
      });
      ensureMounted();
      populateProfile(saved);
      setProfiles(previous => [...previous.filter(row => row.id !== saved.id), saved]);
      setProfileStatus('Profile saved. Emergency calls use this saved contact.');
    } catch (error) {
      if (mountedRef.current) setProfileStatus(error instanceof Error ? error.message : 'Could not save profile.');
    } finally {
      profileBusyRef.current = false;
      if (mountedRef.current) setProfileBusy(false);
    }
  }

  async function testEmergencyContact() {
    if (busyRef.current || profileBusyRef.current) return;
    setTestLabel('Emergency contact test');
    busyRef.current = true;
    setAgentState('testing');
    try {
      const contact = await getEmergencyContact(profileIdRef.current);
      ensureMounted();
      await openPhone(contact.phone);
      if (mountedRef.current) setProfileStatus('Phone interface opened for the saved emergency contact.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Emergency contact test failed.';
      console.error(message);
      if (mountedRef.current) setProfileStatus(message);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setAgentState('idle');
    }
  }

  async function say(text: string) {
    ensureMounted();
    setAssistantPrompt(text);
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
          // Read native metering directly, without waiting for a React render.
          const db = recorder.getStatus().metering ?? null;
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
    setAssistantPrompt('');
    setTranscript('');
    setAgentError('');
    if (next.status === 'NORMAL') {
      setSendStatus('Biometric readings are normal.');
      return;
    }
    busyRef.current = true;
    setAgentState('alerting');
    const conversationProfileId = profileIdRef.current;
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
      // Entering this pathway is logged even if contact lookup/dialing fails.
      askedEmergencyCall = result.callRequested || result.offerCall;
      setAgentState('responding');
      await say(result.reply);
      if (askedEmergencyCall) {
        const contact = await getEmergencyContact(conversationProfileId);
        ensureMounted();
        if (contact) {
          if (result.callRequested) {
            await say(`Okay. Opening the dialer for ${contact.name} now.`);
            await openPhone(contact.phone);
            dialerOpened = true;
            return;
          }
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
              await openPhone(contact.phone);
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
      console.error(error instanceof Error ? error.message : 'Voice agent failed.');
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
    setTestLabel('Testing microphone');
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

  const warning = alert !== null && alert.status !== 'NORMAL';
  const profileEditable = !profileBusy && agentState === 'idle' && profilesLoaded &&
    (profileId !== null || profiles.length === 0);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const activeDriverName = selectedProfile?.display_name || (profileBusy ? 'Loading driver...' : 'Set up your driver profile');
  const driverInitial = selectedProfile?.display_name?.trim().charAt(0).toUpperCase() || '?';
  function closeMenu() {
    Keyboard.dismiss();
    setMenuOpen(false);
  }
  const statusTitle = !alert ? 'Waiting for readings' : warning
    ? alert.severity === 'critical' ? 'Critical reading detected' : 'Attention needed'
    : 'Vitals are normal';
  const statusDetail = !alert ? 'Your latest biometric readings will appear here.'
    : alert.status === 'HIGH_HEART_RATE' ? 'Elevated heart rate detected.'
    : alert.status === 'LOW_HEART_RATE' ? 'Low heart rate detected.'
    : alert.status === 'LOW_SPO2' ? 'Low blood oxygen detected.'
    : 'No abnormal readings detected in the latest update.';

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container} contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.header}>
          <View style={styles.row}>
            <Text style={styles.eyebrow}>DRIVER WELLNESS</Text>
            <View style={styles.headerActions}>
              <View style={styles.liveBadge} accessibilityLabel="Live monitoring dashboard">
                <View style={styles.liveDot} /><Text style={styles.liveText}>LIVE</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Open driver menu"
                accessibilityState={{ expanded: menuOpen }} onPress={() => setMenuOpen(true)}
                style={({ pressed }) => [styles.menuButton, pressed && styles.pressedButton]}>
                <Text style={styles.blueText}>{driverInitial}</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.title}>Biometric Drive Monitor</Text>
          <Text style={styles.muted}>Your vitals. Your drive. In view.</Text>
        </View>

        <View style={styles.vitalsRow}>
          <View style={[styles.vitalCard, warning && alert.status !== 'LOW_SPO2' && styles.warningBorder]}>
            <Text style={styles.heartIcon} accessibilityElementsHidden>♥</Text>
            <Text style={styles.cardLabel}>Heart Rate</Text>
            <Text style={[styles.vitalValue, warning && alert.status !== 'LOW_SPO2' && styles.warningText]}>
              {alert?.heart_rate ?? '—'}
            </Text>
            <Text style={styles.muted}>BPM</Text>
          </View>
          <View style={[styles.vitalCard, alert?.status === 'LOW_SPO2' && styles.warningBorder]}>
            <Text style={styles.oxygenIcon} accessibilityElementsHidden>O₂</Text>
            <Text style={styles.cardLabel}>Blood Oxygen</Text>
            <Text style={[styles.vitalValue, alert?.status === 'LOW_SPO2' && styles.warningText]}>
              {alert?.spo2 ?? '—'}<Text style={styles.unit}> %</Text>
            </Text>
            <Text style={styles.muted}>SpO₂</Text>
          </View>
        </View>

        <View style={[styles.statusCard, alert && !warning && styles.normalCard, warning && styles.warningCard]}
          accessibilityLiveRegion="polite">
          <Text style={[styles.eyebrow, warning ? styles.warningText : alert ? styles.greenText : styles.muted]}>
            {warning ? `${alert.severity.toUpperCase()} · CHECK-IN` : alert ? 'NORMAL · MONITORING' : 'MONITORING · STANDBY'}
          </Text>
          <Text style={styles.sectionTitle}>{statusTitle}</Text>
          <Text style={styles.body}>{statusDetail}</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.sectionTitle}>Driver Assistant</Text>
            <View style={styles.assistantIcon}><Text style={styles.blueText}>✦</Text></View>
          </View>
          <View style={styles.agentStatusRow} accessibilityLiveRegion="polite">
            {agentState === 'thinking' ? <ActivityIndicator size="small" color="#8DBAFF" />
              : <View style={[styles.liveDot, agentState === 'listening' && styles.listeningDot]} />}
            <Text style={styles.agentStatus}>{agentState === 'testing' ? testLabel : AGENT_STATE_LABEL[agentState]}</Text>
          </View>
          <View style={styles.promptBox}>
            <Text style={styles.body}>{assistantPrompt || (warning ? CHECK_IN_LINES[alert.status]
              : 'I’m here to check in when your readings need attention.')}</Text>
          </View>
          {agentState === 'listening' && (
            <>
              <Text style={styles.blueText}>Microphone on · Speak, then pause.</Text>
              <ActionButton title="Done speaking" onPress={() => stopRecordingRef.current?.()} primary />
            </>
          )}
          {transcript !== '' && <Text style={styles.body}>You: “{transcript}”</Text>}
          {agentError !== '' && <Text style={styles.errorText} accessibilityLiveRegion="polite">{agentError}</Text>}
        </View>

        <View style={styles.sessionBox}>
          <Text style={styles.eyebrow}>DRIVE SESSION</Text>
          <Text style={styles.cardLabel}>{activeDriverName}</Text>
          <View style={styles.summaryRow}>
            <Text style={styles.muted}>Signal quality</Text>
            <Text style={styles.body}>{alert?.signal_quality != null ? `${alert.signal_quality}%` : '—'}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.muted}>Last reading</Text>
            <Text style={styles.body}>{alert ? new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Awaiting data'}</Text>
          </View>
          {alert && <Text style={styles.caption}>{alert.sessionId ? `Session ${alert.sessionId}` : 'Simulated reading · No drive session'}</Text>}
        </View>

        <ActionButton title="Simulate abnormal reading" onPress={simulatePiMessage}
          disabled={agentState !== 'idle'} subtle />

        <Text style={styles.footer}>BIOMETRIC DRIVE MONITOR · DRIVER WELLNESS</Text>
      </ScrollView>
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={closeMenu}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel="Close driver menu"
            onPress={closeMenu} />
          <SafeAreaView style={styles.drawer} accessibilityViewIsModal>
            <KeyboardAvoidingView style={styles.drawerBody} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
              <View style={styles.drawerHeader}>
                <View style={styles.drawerHeading}>
                  <Text style={styles.eyebrow}>YOUR DRIVE</Text>
                  <Text style={styles.sectionTitle}>Profile & setup</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close driver menu" onPress={closeMenu}
                  style={({ pressed }) => [styles.menuButton, pressed && styles.pressedButton]}>
                  <Text style={styles.blueText}>X</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.drawerContent} keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag">
                <View style={styles.activeDriverCard}>
                  <View style={styles.avatar}><Text style={styles.avatarText}>{driverInitial}</Text></View>
                  <View style={styles.drawerHeading}>
                    <Text style={styles.sectionTitle}>{activeDriverName}</Text>
                    <View style={styles.headerActions}>
                      {selectedProfile && <View style={styles.liveDot} />}
                      <Text style={selectedProfile ? styles.greenText : styles.caption}>
                        {selectedProfile ? 'Active driver' : 'Profile setup'}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.menuSection}>
                  <Text style={styles.sectionTitle}>Personal information</Text>
                  <Text style={styles.cardLabel}>Driver name</Text>
                  <TextInput style={styles.input} accessibilityLabel="Driver name" value={driverName}
                    onChangeText={setDriverName} editable={profileEditable} autoComplete="name" />
                  <Text style={styles.cardLabel}>Age</Text>
                  <TextInput style={styles.input} accessibilityLabel="Age" value={age}
                    onChangeText={setAge} editable={profileEditable} keyboardType="number-pad" />
                  <Text style={styles.cardLabel}>Height (cm)</Text>
                  <TextInput style={styles.input} accessibilityLabel="Height in centimeters" value={height}
                    onChangeText={setHeight} editable={profileEditable} keyboardType="decimal-pad" />
                  <Text style={styles.cardLabel}>Weight (kg)</Text>
                  <TextInput style={styles.input} accessibilityLabel="Weight in kilograms" value={weight}
                    onChangeText={setWeight} editable={profileEditable} keyboardType="decimal-pad" />
                  <Text style={styles.cardLabel}>Gender</Text>
                  <TextInput style={styles.input} accessibilityLabel="Gender" value={gender}
                    onChangeText={setGender} editable={profileEditable} placeholder="Optional"
                    placeholderTextColor="#94A5C0" />
                </View>

                <View style={styles.menuSection}>
                  <Text style={styles.sectionTitle}>Emergency contact</Text>
                  <Text style={styles.cardLabel}>Contact name</Text>
                  <TextInput style={styles.input} accessibilityLabel="Emergency contact name" value={contactName}
                    onChangeText={setContactName} editable={profileEditable} />
                  <Text style={styles.cardLabel}>Phone number</Text>
                  <TextInput style={styles.input} accessibilityLabel="Emergency contact phone number" value={contactPhone}
                    onChangeText={setContactPhone} keyboardType="phone-pad" editable={profileEditable} />
                  <ActionButton title="Save profile" onPress={saveSetup} primary disabled={!profileEditable} />
                  <ActionButton title="Test emergency contact" onPress={testEmergencyContact}
                    disabled={profileBusy || agentState !== 'idle' || profileId === null} />
                  <Text style={styles.caption}>Opens the phone interface using your saved contact.</Text>
                  <Text style={styles.muted} accessibilityLiveRegion="polite">{profileStatus}</Text>
                </View>

                <View style={styles.menuSection}>
                  <Text style={styles.sectionTitle}>Device & connection tests</Text>
                  <Text style={styles.cardLabel}>Test reading</Text>
                  <TextInput style={styles.input} accessibilityLabel="Test reading" placeholder="Enter test reading"
                    placeholderTextColor="#94A5C0" keyboardType="decimal-pad" returnKeyType="done"
                    onSubmitEditing={Keyboard.dismiss} value={reading} onChangeText={setReading} />
                  <ActionButton title="Send test reading" onPress={sendTestReading} />
                  {agentState === 'idle' && <ActionButton title="Test microphone" onPress={testMic} />}
                  <Text style={styles.muted} accessibilityLiveRegion="polite">{sendStatus}</Text>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ActionButton({ title, onPress, disabled = false, primary = false, subtle = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  subtle?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, primary && styles.primaryButton, subtle && styles.subtleButton,
        disabled && styles.disabledButton, pressed && styles.pressedButton]}>
      <Text style={[styles.buttonText, primary && styles.primaryButtonText, subtle && styles.muted]}>{title}</Text>
    </Pressable>
  );
}

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: 'Monitoring',
  testing: 'Testing',
  alerting: 'Speaking',
  listening: 'Listening',
  thinking: 'Processing your response',
  responding: 'Speaking',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#080F20' },
  container: { flexGrow: 1, gap: 16, padding: 20, paddingTop: 16, paddingBottom: 36, width: '100%', maxWidth: 560, alignSelf: 'center' },
  header: { gap: 10, paddingTop: 8, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  eyebrow: { color: '#9AACC8', fontSize: 11, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: '#F4F7FF', fontSize: 32, fontWeight: '700', letterSpacing: -0.8 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#12332E', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#58D9AA' },
  liveText: { color: '#78E6BD', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  vitalsRow: { flexDirection: 'row', gap: 12 },
  vitalCard: { flex: 1, minWidth: 0, backgroundColor: '#111F37', borderColor: '#243854', borderWidth: 1, borderRadius: 22, padding: 18, gap: 8 },
  heartIcon: { color: '#FB8EAA', fontSize: 25 },
  oxygenIcon: { color: '#7CBFFF', fontSize: 25, fontWeight: '700' },
  cardLabel: { color: '#D9E4F7', fontSize: 14, fontWeight: '600' },
  vitalValue: { color: '#F4F7FF', fontSize: 44, fontWeight: '700', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 18, color: '#AABBD5', letterSpacing: 0 },
  muted: { color: '#A4B4CD', fontSize: 13, lineHeight: 20 },
  body: { color: '#D4E0F3', fontSize: 14, lineHeight: 22 },
  caption: { color: '#9AACC8', fontSize: 12, lineHeight: 18 },
  statusCard: { backgroundColor: '#14223A', borderColor: '#2A3E5F', borderWidth: 1, borderRadius: 20, padding: 18, gap: 8 },
  normalCard: { backgroundColor: '#102D2C', borderColor: '#245249' },
  warningCard: { backgroundColor: '#322719', borderColor: '#806035' },
  warningBorder: { borderColor: '#BD8946' },
  warningText: { color: '#FFD08A' },
  greenText: { color: '#78E6BD' },
  sectionTitle: { color: '#F0F5FF', fontSize: 18, fontWeight: '700', flexShrink: 1 },
  card: { backgroundColor: '#111C31', borderColor: '#26354F', borderWidth: 1, borderRadius: 20, padding: 18, gap: 14 },
  assistantIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#203B61', alignItems: 'center', justifyContent: 'center' },
  blueText: { color: '#94C4FF', fontSize: 14, fontWeight: '600' },
  agentStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  agentStatus: { color: '#AFCFFF', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  listeningDot: { backgroundColor: '#91C4FF' },
  promptBox: { backgroundColor: '#192A45', borderLeftWidth: 3, borderLeftColor: '#6AA6FA', borderRadius: 10, padding: 14 },
  errorText: { color: '#FFACB7', fontSize: 13, lineHeight: 20 },
  sessionBox: { padding: 4, gap: 10 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  menuButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1A2C48', borderColor: '#365074', borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  modalRoot: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0, 5, 16, 0.72)' },
  drawer: { width: '88%', maxWidth: 420, backgroundColor: '#0D182B', borderLeftWidth: 1, borderLeftColor: '#30415D' },
  drawerBody: { flex: 1 },
  drawerHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 20, borderBottomWidth: 1, borderBottomColor: '#26354F' },
  drawerHeading: { flex: 1, gap: 6 },
  drawerContent: { padding: 20, paddingBottom: 40, gap: 24 },
  activeDriverCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, backgroundColor: '#152A3C', borderRadius: 18, borderWidth: 1, borderColor: '#2C4D55' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#28466C', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#C6DFFF', fontSize: 22, fontWeight: '700' },
  menuSection: { gap: 12, borderTopWidth: 1, borderTopColor: '#26354F', paddingTop: 20 },
  input: { backgroundColor: '#0B1528', color: '#F0F5FF', borderColor: '#344765', borderWidth: 1, borderRadius: 12, padding: 13, fontSize: 16, minHeight: 48 },
  button: { minHeight: 46, justifyContent: 'center', alignItems: 'center', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#365074', backgroundColor: '#1A2C48' },
  primaryButton: { backgroundColor: '#8BBAFF', borderColor: '#8BBAFF' },
  subtleButton: { backgroundColor: 'transparent', borderColor: '#293952' },
  buttonText: { color: '#BED7FF', fontWeight: '600', fontSize: 13, textAlign: 'center' },
  primaryButtonText: { color: '#0B1B32' },
  disabledButton: { opacity: 0.4 },
  pressedButton: { opacity: 0.7 },
  footer: { color: '#8395B2', fontSize: 10, letterSpacing: 1.2, textAlign: 'center', marginTop: 8 },
});
