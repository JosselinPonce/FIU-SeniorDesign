/**
 * Application state for one driver's drive.
 *
 * The only place BLE, the frame decoder, the database, the alert logic and
 * the live uploader meet. Plain useReducer rather than a state library: the
 * reactive surface is a handful of values on a few screens.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Linking } from 'react-native';
import type { CheckAnswer } from '../voice/voiceCheck';
import * as Haptics from 'expo-haptics';

import { WheelConnection, type ConnectionState, type RelayStatus, type Source } from '../ble/bleService';
import { Deframer, SeqTracker, uuidv4 } from '../ble/protocol';
import { LiveUploader, type LinkState, type LiveStatus } from '../db/liveSync';
import * as repo from '../db/repositories';
import { syncToSupabase } from '../db/sync';
import { saveSelectedProfile } from '../db/profileEditing';
import { syncProfiles } from '../db/profileSync';
import { appAudio } from '../voice/audioOwnership';
import { processPendingDeletes } from '../db/deletion';
import type { DriveSession, DriverProfile, StorageMode } from '../db/repositories';
import { foldSession, type ArchiveInfo } from '../archive/archiveStore';
import type { Baseline } from '../analysis/baseline';
import { SignalAnalyzer, type SignalQuality } from '../analysis/signal';
import { CAL_SECONDS, applyCalibration } from '../analysis/calibration';
import { computeTrend, type Trend } from '../analysis/trend';
import { SafetyController, initialSafety, type DemoScenario, type SafetyState } from '../analysis/safetyController';
import { phoneVoiceIO, prepareVoice, releaseAudio, resetVoiceCache, setPreferredVoice } from '../voice/speechIO';

/** Seconds of vitals kept for the on-screen charts. */
export const CHART_SECONDS = 120;
/** Seconds of throughput history for the data-rate indicator. */
export const RATE_SECONDS = 60;
const AVG_WINDOW = 5;

export type Point = { t: number; v: number | null }; // v null = unusable second
export type LinkInfo = { source: Source; name: string; id: string; connectedAt: Date };
export type RatePoint = { t: number; rx: number; tx: number }; // bytes/s in from the Pi, out to Supabase

export type FoldState =
  | { state: 'idle' }
  | { state: 'folding' }
  | { state: 'done'; info: ArchiveInfo }
  | { state: 'failed'; error: string };

type State = {
  connection: ConnectionState;
  error: string | null;
  link: LinkInfo | null;
  relay: RelayStatus | null;
  driver: DriverProfile | null;
  session: DriveSession | null;
  bpm: number | null;
  spo2: number | null;
  avgBpm: number | null;
  avgSpo2: number | null;
  finger: boolean;
  quality: number | null;
  sampleRate: number | null;
  samplesPerPacket: number | null;
  bpmSeries: Point[];
  spo2Series: Point[];
  rateSeries: RatePoint[];
  packets: number;
  stored: number;
  lastSeq: number | null;
  lastRx: Date | null;
  lost: number;
  crcErrors: number;
  duplicates: number;
  ignoredNoSession: number;
  /** Sessions auto-started because the ESP32 restarted (new ignition cycle). */
  rollovers: number;
  notice: string | null;
  live: LiveStatus | null;
  /** Phone-side analysis of the last 10 s of waveform (signal.ts). */
  signal: SignalQuality | null;
  /** This week's driving heart rate vs the driver's usual (trend.ts). */
  trend: Trend | null;
  storageMode: StorageMode;
  baseline: Baseline | null;
  /** Flags, the voice check and the rhythm advisory (lib/analysis/safetyController.ts). */
  safety: SafetyState;
  voice: { granted: boolean; onDevice: boolean } | null;
  fold: FoldState;
};

type Action =
  | { type: 'connection'; state: ConnectionState; error?: string }
  | { type: 'link'; link: LinkInfo }
  | { type: 'relay'; relay: RelayStatus }
  | { type: 'driver'; driver: DriverProfile | null }
  | { type: 'driverUpdated'; driver: DriverProfile }
  | { type: 'session'; session: DriveSession | null }
  | { type: 'frame'; frame: import('../ble/protocol').Frame; rx: Date; avgBpm: number | null; avgSpo2: number | null; lost: number; crc: number; signal: SignalQuality | null }
  | { type: 'stored' }
  | { type: 'duplicate' }
  | { type: 'ignored' }
  | { type: 'storeError'; error: string }
  | { type: 'rollover'; session: DriveSession }
  | { type: 'resetSession' }
  | { type: 'live'; live: LiveStatus }
  | { type: 'rate'; point: RatePoint }
  | { type: 'storageMode'; mode: StorageMode }
  | { type: 'baseline'; baseline: Baseline | null; trend: Trend | null }
  | { type: 'safety'; safety: SafetyState }
  | { type: 'voice'; voice: State['voice'] }
  | { type: 'fold'; fold: FoldState };

const initial: State = {
  connection: 'idle',
  error: null,
  link: null,
  relay: null,
  driver: null,
  session: null,
  bpm: null,
  spo2: null,
  avgBpm: null,
  avgSpo2: null,
  finger: false,
  quality: null,
  sampleRate: null,
  samplesPerPacket: null,
  bpmSeries: [],
  spo2Series: [],
  rateSeries: [],
  packets: 0,
  stored: 0,
  lastSeq: null,
  lastRx: null,
  lost: 0,
  crcErrors: 0,
  duplicates: 0,
  ignoredNoSession: 0,
  rollovers: 0,
  notice: null,
  live: null,
  signal: null,
  trend: null,
  storageMode: 'vitals',
  baseline: null,
  safety: initialSafety,
  voice: null,
  fold: { state: 'idle' },
};

const trim = (s: Point[], now: number) => s.filter((p) => now - p.t <= CHART_SECONDS * 1000);

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'connection':
      return {
        ...s,
        connection: a.state,
        error: a.error ?? null,
        link: a.state === 'disconnected' || a.state === 'failed' ? null : s.link,
        relay: a.state === 'disconnected' || a.state === 'failed' ? null : s.relay,
      };
    case 'link':
      return { ...s, link: a.link };
    case 'relay':
      return { ...s, relay: a.relay };
    case 'driver':
      // Keep the link and preferences; everything about the previous driver goes.
      return {
        ...initial,
        connection: s.connection,
        link: s.link,
        relay: s.relay,
        storageMode: s.storageMode,
        rateSeries: s.rateSeries,
        voice: s.voice,
        driver: a.driver,
      };
    case 'driverUpdated':
      return { ...s, driver: a.driver };
    case 'session':
      return { ...s, session: a.session };
    case 'frame': {
      const t = a.rx.getTime();
      const f = a.frame;
      return {
        ...s,
        bpm: f.usable ? f.heartRate : null,
        spo2: f.usable ? f.spo2 : null,
        avgBpm: a.avgBpm,
        avgSpo2: a.avgSpo2,
        finger: f.finger,
        quality: f.version >= 3 ? f.quality : null,
        sampleRate: f.rateHz || s.sampleRate,
        samplesPerPacket: f.samples.length,
        bpmSeries: trim([...s.bpmSeries, { t, v: f.usable ? f.heartRate : null }], t),
        spo2Series: trim([...s.spo2Series, { t, v: f.usable ? f.spo2 : null }], t),
        packets: s.packets + 1,
        lastSeq: f.seq,
        lastRx: a.rx,
        lost: a.lost,
        crcErrors: a.crc,
        signal: a.signal,
      };
    }
    case 'stored':
      return { ...s, stored: s.stored + 1 };
    case 'duplicate':
      return { ...s, duplicates: s.duplicates + 1 };
    case 'ignored':
      return { ...s, ignoredNoSession: s.ignoredNoSession + 1 };
    case 'storeError':
      return { ...s, error: a.error };
    case 'rollover':
      return {
        ...s,
        session: a.session,
        stored: 0,
        duplicates: 0,
        rollovers: s.rollovers + 1,
        notice: `Sensor restarted at ${new Date().toLocaleTimeString()} — continued in a new session.`,
      };
    case 'resetSession':
      return { ...s, stored: 0, duplicates: 0, ignoredNoSession: 0, fold: { state: 'idle' } };
    case 'live':
      return { ...s, live: a.live };
    case 'rate':
      return { ...s, rateSeries: [...s.rateSeries, a.point].slice(-RATE_SECONDS) };
    case 'storageMode':
      return { ...s, storageMode: a.mode };
    case 'baseline':
      return { ...s, baseline: a.baseline, trend: a.trend };
    case 'safety':
      return { ...s, safety: a.safety };
    case 'voice':
      return { ...s, voice: a.voice };
    case 'fold':
      return { ...s, fold: a.fold };
    default:
      return s;
  }
}

export function useDriveSession() {
  const [state, dispatch] = useReducer(reducer, initial);

  // Refs: the BLE callback is created once and must see current values.
  const sessionRef = useRef<DriveSession | null>(null);
  const profileEdit = useRef<string | null>(null);
  const startingSession = useRef(false);
  const endingSession = useRef(false);
  const deframer = useRef(new Deframer());
  const seq = useRef(new SeqTracker());
  const avgBpm = useRef<number[]>([]);
  const avgSpo2 = useRef<number[]>([]);
  const seen = useRef<Set<number>>(new Set());
  const connected = useRef(false);
  const lastRx = useRef(0);
  const espOnPi = useRef(true);
  const rxBytes = useRef(0);
  const analyzer = useRef(new SignalAnalyzer());
  // Personal calibration offsets of the selected driver, and an in-progress
  // calibration measurement (raw, uncalibrated clean readings).
  const calRef = useRef<{ hr: number | null; spo2: number | null }>({ hr: null, spo2: null });
  const measuring = useRef<{ until: number; bpm: number[]; spo2: number[]; done: (r: { bpm: number[]; spo2: number[] }) => void } | null>(null);
  // Serialises database writes so back-to-back frames cannot interleave.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Flags → voice check. Created once; reports its state into the reducer.
  const safety = useMemo(
    () =>
      new SafetyController({
        voiceIO: phoneVoiceIO,
        handoffContact: (phone) => Linking.openURL(`tel:${phone}`),
        releaseAudio,
        save: repo.saveAlert,
        saveAck: repo.setAck,
        saveSnapshot: repo.saveSnapshot,
        haptic: (k) =>
          void Haptics.notificationAsync(
            k === 'error' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning,
          ),
        onChange: (st) => dispatch({ type: 'safety', safety: st }),
        newId: uuidv4,
      }),
    [],
  );

  // What the dashboard's "link" pill shows, reported with every heartbeat.
  const linkState = useCallback((): LinkState => {
    if (!connected.current) return 'pi_lost';
    if (!espOnPi.current || Date.now() - lastRx.current > 3000) return 'sensor_lost';
    return 'streaming';
  }, []);

  // Streams the active session to Supabase; local storage never waits on it.
  const live = useMemo(() => new LiveUploader(linkState, (l) => dispatch({ type: 'live', live: l })), [linkState]);

  // Throughput for the moving-dot indicator: bytes/s received from the Pi and
  // sent to Supabase, sampled once a second.
  useEffect(() => {
    let lastTx = 0;
    const t = setInterval(() => {
      const tx = live.status.bytesSent;
      dispatch({ type: 'rate', point: { t: Date.now(), rx: rxBytes.current, tx: Math.max(0, tx - lastTx) } });
      rxBytes.current = 0;
      lastTx = tx;
    }, 1000);
    return () => clearInterval(t);
  }, [live]);

  const onBytes = useCallback(
    (bytes: Uint8Array) => {
      const rx = new Date(); // stamped on arrival, before any queueing
      rxBytes.current += bytes.length;
      for (const raw of deframer.current.feed(bytes)) {
        // Calibration: corrected vitals everywhere downstream; raw bytes untouched.
        const c = calRef.current;
        const f =
          raw.usable && (c.hr || c.spo2)
            ? (() => {
                const adj = applyCalibration(raw.heartRate, raw.spo2, c);
                return { ...raw, heartRate: adj.bpm, spo2: adj.spo2 };
              })()
            : raw;
        lastRx.current = rx.getTime();
        const resetsBefore = seq.current.resets;
        const missingNow = seq.current.update(f.seq); // frames lost just before this one
        const lost = seq.current.lost;
        // The ESP32's sequence restarts at 0 whenever it reboots -- every
        // ignition cycle in the car. Without handling this, the new numbers
        // collide with ones already stored in this session: the duplicate guard
        // and the UNIQUE(session_id, sequence_number) index would silently
        // discard every frame until the count passed the old maximum.
        const esp32Restarted = seq.current.resets > resetsBefore;
        if (f.usable) {
          avgBpm.current = [...avgBpm.current, f.heartRate].slice(-AVG_WINDOW);
          avgSpo2.current = [...avgSpo2.current, f.spo2].slice(-AVG_WINDOW);
        }
        const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
        // Independent beat-based HR + quality from the raw waveform (v3 frames).
        const sq =
          f.version >= 3 && f.rateHz
            ? analyzer.current.feed(f.samples.map((x) => x.ir), f.rateHz, f.finger && missingNow === 0, raw.usable ? raw.heartRate : null)
            : null;
        // Calibration measurement collects the RAW values of clean seconds.
        const m = measuring.current;
        if (m) {
          if (raw.usable && sq?.good !== false) {
            m.bpm.push(raw.heartRate);
            m.spo2.push(raw.spo2);
          }
          if (rx.getTime() >= m.until) {
            measuring.current = null;
            m.done({ bpm: m.bpm, spo2: m.spo2 });
          }
        }
        dispatch({
          type: 'frame',
          frame: f,
          rx,
          avgBpm: mean(avgBpm.current),
          avgSpo2: mean(avgSpo2.current),
          lost,
          crc: deframer.current.crcErrors,
          signal: sq,
        });
        const rolloverSession = esp32Restarted && sessionRef.current?.status === 'active' ? sessionRef.current : null;
        // Revoke consent immediately, before queued database work can yield to a dialogue.
        if (rolloverSession) safety.endSession();
        if (sessionRef.current?.status === 'active') {
          safety.onFrame(f, rx, missingNow, sq);
          live.nudge(); // flags and answers reach the dashboard without waiting for the tick
        }

        queue.current = queue.current
          .then(async () => {
            if (rolloverSession && sessionRef.current === rolloverSession) {
              // A restart is a new drive segment: close this session and carry on
              // in a fresh one for the same driver, so no data is dropped.
              const old = sessionRef.current;
              await repo.endSession(old);
              if (sessionRef.current !== old) return;
              const next = await repo.startSession(old.profile_id, old.storage_mode ?? 'vitals');
              if (sessionRef.current !== old) {
                await repo.endSession(next);
                return;
              }
              sessionRef.current = next;
              safety.startSession(next.id);
              seen.current.clear();
              dispatch({ type: 'rollover', session: next });
              void (async () => {
                if (old.storage_mode === 'full') await foldSession(old.id, 'smart-wheel-app').catch(() => null);
                await live.finish(old.id);
              })();
              live.follow(next.id);
            }
            const session = sessionRef.current;
            if (!session || session.status !== 'active') {
              // Never attribute data to no session or to a previous one.
              dispatch({ type: 'ignored' });
              return;
            }
            if (seen.current.has(f.seq)) {
              dispatch({ type: 'duplicate' });
              return;
            }
            seen.current.add(f.seq);
            try {
              if (f.rateHz && !session.sample_rate_hz) {
                session.sample_rate_hz = f.rateHz;
                await repo.setSessionSampleRate(session.id, f.rateHz);
              }
              const r = await repo.storeFrame(session.id, f, rx, session.storage_mode === 'full', sq);
              dispatch({ type: r === 'stored' ? 'stored' : 'duplicate' });
            } catch {
              seen.current.delete(f.seq); // let a retry through
              dispatch({ type: 'storeError', error: 'Could not save telemetry locally.' });
            }
          })
          .catch(() => undefined);
      }
    },
    [live, safety],
  );

  const connection = useMemo(
    () =>
      new WheelConnection({
        onStateChange: (s, error) => {
          connected.current = s === 'connected';
          if (s === 'connected') {
            // A new link starts a fresh byte stream: no half-frame carries over.
            deframer.current = new Deframer();
          }
          dispatch({ type: 'connection', state: s, error });
        },
        onConnected: (i) => dispatch({ type: 'link', link: { ...i, connectedAt: i.at } }),
        onBytes,
        onRelayStatus: (relay) => {
          espOnPi.current = relay.esp;
          dispatch({ type: 'relay', relay });
        },
      }),
    [onBytes],
  );

  useEffect(() => {
    void (async () => {
      // Sessions a crash left open: close them locally, then publish that.
      void processPendingDeletes().then(() => syncProfiles()).catch(() => undefined);
      const closed = await repo.recoverInterruptedSessions();
      if (closed) void syncToSupabase().catch(() => undefined);
      dispatch({ type: 'storageMode', mode: await repo.getStorageMode() });
      // Voices picked in Settings.
      for (const lang of ['en', 'es'] as const) setPreferredVoice(lang, await repo.getSetting(`voice:${lang}`));
    })();
    return () => {
      safety.endSession();
      sessionRef.current = null;
      selectedProfile.current = null;
      void connection.stop();
      live.stop();
    };
  }, [connection, live, safety]);

  // In the car nobody should have to tap "connect": as soon as a driver is
  // chosen the app keeps a link to the Pi up, reconnecting on its own.
  const driverId = state.driver?.id;
  useEffect(() => {
    if (driverId) connection.start();
  }, [driverId, connection]);

  const selectedProfile = useRef<{ id: string } | null>(null);
  const loadBaseline = useCallback(
    async (driver: DriverProfile, reason = 'drive') => {
      const selection = selectedProfile.current;
      const b = await repo.driverBaseline(driver.id);
      const ack = await repo.getAck(driver.id);
      if (selectedProfile.current !== selection || selection?.id !== driver.id) return null;
      safety.configure(driver, b, ack, reason);
      const trend = computeTrend(await repo.driveMedians(driver.id), Date.now());
      if (selectedProfile.current !== selection) return null;
      dispatch({ type: 'baseline', baseline: b, trend });
      return trend;
    },
    [safety],
  );

  const selectDriver = useCallback(
    (driver: DriverProfile) => {
      safety.endSession();
      selectedProfile.current = { id: driver.id };
      safety.configure(driver, null, { high: null, low: null }, 'profile');
      calRef.current = { hr: driver.cal_hr ?? null, spo2: driver.cal_spo2 ?? null };
      sessionRef.current = null;
      seen.current.clear();
      avgBpm.current = [];
      avgSpo2.current = [];
      dispatch({ type: 'driver', driver });
      void loadBaseline(driver, 'profile');
    },
    [loadBaseline, safety],
  );

  const beginProfileEdit = useCallback(async () => {
    if (!state.driver || sessionRef.current || startingSession.current || endingSession.current || profileEdit.current)
      throw new Error('End and save the current drive before editing.');
    const id = state.driver.id;
    profileEdit.current = id;
    const selection = { id };
    selectedProfile.current = selection; // invalidate pending baseline/profile loads
    safety.cancelCheck();
    try {
      await appAudio.stopActive();
      const latest = await repo.getProfile(id);
      if (selectedProfile.current !== selection || !latest) throw new Error('The selected driver changed or was removed.');
      await loadBaseline(latest, 'profile');
      if (selectedProfile.current !== selection) throw new Error('The selected driver changed.');
      dispatch({ type: 'driverUpdated', driver: latest });
      return latest;
    } catch (e) { profileEdit.current = null; throw e; }
  }, [state.driver, safety, loadBaseline]);

  const saveProfileEdit = useCallback(async (original: DriverProfile, input: repo.NewProfileInput) => {
    const selection = selectedProfile.current;
    const current = () => profileEdit.current === original.id && selection === selectedProfile.current
      && selection?.id === original.id && !sessionRef.current && !startingSession.current && !endingSession.current;
    await saveSelectedProfile(original, input, {
      isCurrent: current,
      cancel: async () => { safety.cancelCheck(); await appAudio.stopActive(); },
      save: repo.updateProfile,
      load: async saved => {
        const [baseline, ack, medians] = await Promise.all([
          repo.driverBaseline(saved.id), repo.getAck(saved.id), repo.driveMedians(saved.id),
        ]);
        return { baseline, ack, trend: computeTrend(medians, Date.now()) };
      },
      publish: (saved, context) => {
        safety.refreshProfile(saved, context.baseline, context.ack);
        calRef.current = { hr: saved.cal_hr ?? null, spo2: saved.cal_spo2 ?? null };
        dispatch({ type: 'driverUpdated', driver: saved });
        dispatch({ type: 'baseline', baseline: context.baseline, trend: context.trend });
      },
    });
    void syncProfiles().catch(() => undefined);
  }, [safety]);

  const closeProfileEdit = useCallback(() => { profileEdit.current = null; }, []);
  useEffect(() => {
    const timer = setInterval(() => { void syncProfiles().catch(() => undefined); }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const startSession = useCallback(async () => {
    if (sessionRef.current || !state.driver || profileEdit.current || startingSession.current || endingSession.current) return;
    startingSession.current = true;
    try {
      seen.current.clear();
      dispatch({ type: 'resetSession' });
      const selection = selectedProfile.current;
      const session = await repo.startSession(state.driver.id, state.storageMode);
      if (selectedProfile.current !== selection || selection?.id !== state.driver.id) {
        await repo.endSession(session);
        return;
      }
      sessionRef.current = session;
      safety.startSession(session.id);
      dispatch({ type: 'session', session });
      live.follow(session.id);
      // Microphone + speech permission now, so an emergency is never blocked by a dialog.
      if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
    } finally { startingSession.current = false; }
  }, [state.driver, state.storageMode, state.voice, live, safety]);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || endingSession.current) return;
    endingSession.current = true;
    try {
      safety.endSession();
      const ended = await repo.endSession(session);
      sessionRef.current = null;
      dispatch({ type: 'session', session: ended });
      await queue.current; // every frame of this session is stored before folding
      if (ended.storage_mode === 'full') {
        dispatch({ type: 'fold', fold: { state: 'folding' } });
        try {
          const info = await foldSession(ended.id, 'smart-wheel-app');
          dispatch({ type: 'fold', fold: info ? { state: 'done', info } : { state: 'idle' } });
        } catch (e) {
          dispatch({ type: 'fold', fold: { state: 'failed', error: e instanceof Error ? e.message : String(e) } });
        }
      }
      await live.finish(ended.id);
      if (state.driver) {
        // This drive now counts toward the baseline and the weekly trend. An
        // elevated trend is logged once per week as an advisory on this drive.
        const driver = state.driver;
        const trend = await loadBaseline(driver);
        if (trend?.status === 'elevated') {
          const key = `trend:${driver.id}`;
          const last = Number((await repo.getSetting(key)) ?? 0);
          if (Date.now() - last > 7 * 86_400_000) {
            await repo.setSetting(key, String(Date.now()));
            await repo.saveAlert({
              id: uuidv4(), session_id: ended.id, kind: 'hr_trend', value: trend.delta, threshold: 4,
              started_at: new Date().toISOString(), prompted_at: null, response: null, responded_at: null,
              escalated: 0, level: 'notice', channel: null, answer_confidence: null,
            });
          }
        }
        void live.finish(ended.id); // re-push: uploads the new snapshot / advisory rows
      }
    } finally { endingSession.current = false; }
  }, [live, safety, loadBaseline, state.driver]);

  /** Back to the driver list. An active session is ended first, never dropped. */
  const leaveDriver = useCallback(async () => {
    const selection = selectedProfile.current;
    safety.cancelCheck();
    if (sessionRef.current) await endSession();
    if (selectedProfile.current !== selection) return;
    selectedProfile.current = null;
    dispatch({ type: 'driver', driver: null });
  }, [endSession, safety]);

  const setStorageMode = useCallback(async (mode: StorageMode) => {
    await repo.setSetting('storage_mode', mode);
    dispatch({ type: 'storageMode', mode });
  }, []);

  /** Settings: hear and answer the real voice check once (nothing recorded). */
  const rehearseVoice = useCallback(async () => {
    if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
    resetVoiceCache(); // pick up a voice downloaded since the app started
    return safety.rehearse();
  }, [safety, state.voice]);

  /** On-screen answer to the voice check (always available). */
  const respondAlert = useCallback((response: CheckAnswer) => safety.answer(response), [safety]);

  return {
    ...state,
    isConnected: state.connection === 'connected',
    hasActiveSession: state.session?.status === 'active',
    selectDriver,
    leaveDriver,
    autoConnect: useCallback(() => connection.start(), [connection]),
    stopConnecting: useCallback(() => connection.stop(), [connection]),
    setAllowDirect: useCallback((v: boolean) => connection.setAllowDirect(v), [connection]),
    startSession,
    beginProfileEdit,
    saveProfileEdit,
    closeProfileEdit,
    endSession,
    setStorageMode,
    respondAlert,
    assistantContactAvailability: useCallback(() => safety.assistantContactAvailability(), [safety]),
    assistantOwnership: useCallback(() => safety.assistantOwnership(), [safety]),
    assistantContact: useCallback((text: string, offered: boolean, current: () => boolean) =>
      safety.assistantContact(text, offered, current), [safety]),
    rehearseVoice,
    /** Demo: fabricated readings through the real engine + voice check. Nothing saved. */
    simulate: useCallback(
      async (scenario: DemoScenario) => {
        if (!state.voice?.granted) dispatch({ type: 'voice', voice: await prepareVoice() });
        return safety.simulate(scenario);
      },
      [safety, state.voice],
    ),
    resetAck: useCallback(() => safety.resetAck(), [safety]),
    /** Records CAL_SECONDS of clean raw readings for a calibration. */
    measureCalibration: useCallback(
      () =>
        new Promise<{ bpm: number[]; spo2: number[] }>((done) => {
          measuring.current = { until: Date.now() + CAL_SECONDS * 1000, bpm: [], spo2: [], done };
        }),
      [],
    ),
    /** Saves (or clears, with nulls) the selected driver's offsets. */
    saveCalibration: useCallback(
      async (hr: number | null, spo2: number | null) => {
        if (!state.driver) return;
        await repo.setCalibration(state.driver.id, hr, spo2);
        calRef.current = { hr, spo2 };
        const updated = await repo.getProfile(state.driver.id);
        if (updated) dispatch({ type: 'driverUpdated', driver: updated });
      },
      [state.driver],
    ),
  };
}
