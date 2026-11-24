import { baselineStatusAnswer, isBaselineStatusQuestion } from '../lib/assistant/askBaselineStatus';
import type { Baseline } from '../lib/analysis/baseline';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Keyboard, Modal, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, Switch, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { LocalizedAlert as Alert, LocalizedText as Text, LocalizedTextInput as TextInput } from '../lib/i18n/native';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import { sensiCloudAuth } from '../lib/assistant/phoneCloudAuth';
import { askSensiPreferenceKey, askSensiSharingKey, createAskSensiClient, type AskError } from '../lib/assistant/askSensiClient';
import { formatRecordedDriveSummary, isDriveOverview } from '../lib/assistant/askSensiDriveSummary';
import { loadAskSensiContext } from '../lib/assistant/askSensiContext';
import { appendAskTurn, newAskConversation, type AskConversation, type AskTurn } from '../lib/assistant/askSensiConversation';
import * as chatStore from '../lib/db/askSensiConversations';
import { AskSensiHistory } from './AskSensiHistory';
import { AskSensiResponse } from './AskSensiResponse';
import * as repo from '../lib/db/repositories';
import { uuidv4 } from '../lib/ble/protocol';
import { DRIVE_HELP, MAX_QUESTION, MAX_ASK_TURNS, MAX_ASK_HISTORY_ANSWER, WARNING_LABELS, wantsAskSafetyContext, type AskRequest, type AskSafetyContext, type AskTopic, type DriveContext, type Metric } from '../supabase/functions/_shared/askSensi';
import { Btn } from './ui';
import { SensiGlyph } from './DashboardAssistantEntry';
import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import { SensiCloudAccess, useSensiAccount } from './SensiCloudAccess';

const sendAsk = createAskSensiClient({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  publicKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
});

const errors: Record<AskError, string> = {
  auth: 'Your session expired. Sign in again to retry.',
  consent: 'Enable Ask Sensi and approve the selected data before sending.',
  inactive: 'The request stopped when the app or account changed. Review your question before sending again.',
  offline: 'Could not reach Ask Sensi. Check your internet connection.',
  busy: 'Ask Sensi is already answering a question. Try again in a moment.',
  quota: 'Ask Sensi reached a usage limit. Try again later.',
  denied: 'This cloud account does not have access to Ask Sensi.',
  unavailable: 'Ask Sensi could not answer. Try again later or use the local drive summary and help.',
};
const starters: Record<AskTopic, string> = {
  drive: 'What does this drive summary show?',
  biometrics: 'What do the recorded heart rate and oxygen readings mean?',
  warnings: 'What do these recorded warnings mean?',
  help: 'How do I record a drive and review its history?',
};
const generalSuggestions = [
  { icon: 'activity', question: 'What do heart rate and SpO₂ mean?' },
  { icon: 'alert-circle', question: 'What can trigger a safety warning?' },
  { icon: 'navigation', question: 'How do I record a drive and review its history?' },
] as const;
const driveSuggestions = [
  { icon: 'navigation', topic: 'drive' }, { icon: 'activity', topic: 'biometrics' }, { icon: 'alert-circle', topic: 'warnings' },
] as const;
type Attachment = { id: string; data: DriveContext };
type SuggestedQuestion = { question: string; topic: AskTopic };
type SharingConsent = { suggestion?: SuggestedQuestion; generalOnly?: boolean; attachment: Attachment; question: string; revision: number; token: string; retryTurn?: AskTurn };
const display = (value: string | number | null) => value ?? 'Not recorded';


function MetricText({ label, metric, unit }: { label: string; metric: Metric; unit: string }) {
  const { tokens } = useTheme();
  const { t } = useAppLanguage();
  const value = (n: number | null) => n === null ? t('Not recorded') : n + ' ' + unit;
  return <Text style={{ color: tokens.textSecondary }}>{t(label)}{': '}{t('Min') + ' ' + value(metric.min) + ' · ' + t('Max') + ' ' + value(metric.max)}</Text>;
}

function ContextPreview({ context, details, date, duration }: { context: DriveContext; details: boolean; date: string; duration: string }) {
  const { tokens } = useTheme();
  const muted = { color: tokens.textSecondary };
  const tiles = [
    { label: 'Heart rate', metric: context.heartRate, unit: 'bpm' },
    { label: 'Estimated SpO₂', metric: context.oxygen, unit: '%' },
  ];
  return <View style={{ gap: 8 }}>
    <Text localize={false} style={muted}>{date} · {duration}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tiles.map(({ label, metric, unit }) => <View key={label} style={{ flexGrow: 1, flexBasis: 130, padding: 10, gap: 4,
        borderRadius: 12, backgroundColor: tokens.surfaceMuted }}>
        <Text style={muted}>{label}</Text>
        <Text style={{ color: tokens.text, fontSize: 20, fontWeight: '600' }}>{metric.average === null ? 'Not recorded' : metric.average + ' ' + unit}</Text>
        <MetricText label="Recorded range" metric={metric} unit={unit} />
      </View>)}
    </View>
    <Text style={muted}>Recorded warnings: {context.warningCount} · Usable samples: {context.samples}</Text>
    {details ? <>
      <Text style={muted}>Duration in seconds: {display(context.durationSeconds)}</Text>
      {context.trend ? <>
        <Text style={muted}>Average heart rate, first and second halves: {display(context.trend.heartRateFirst)} / {display(context.trend.heartRateLast)} bpm</Text>
        <Text style={muted}>Average SpO₂, first and second halves: {display(context.trend.oxygenFirst)} / {display(context.trend.oxygenLast)} %</Text>
      </> : <Text style={muted}>No first-half or second-half averages were recorded.</Text>}
      {context.warnings.map((warning, index) => <Text key={index} style={muted}>
        {WARNING_LABELS[warning.kind]} · Level: {display(warning.level)} · Reading: {display(warning.value)} · Threshold: {display(warning.threshold)}
      </Text>)}
      {context.warningCount > context.warnings.length ? <Text style={muted}>The preview includes the most recent {context.warnings.length} warnings.</Text> : null}
    </> : null}
    <Text style={muted}>These are recorded sensor measurements and app events. They cannot establish a medical diagnosis.</Text>
  </View>;
}

export function AskSensi({ driverId, safety = null, baseline = null, onBack, settingsOnly = false }: { driverId: string; safety?: AskSafetyContext | null; baseline?: Baseline | null; onBack(): void; settingsOnly?: boolean }) {
  const auth = useSensiAccount();
  const accountId = sensiCloudAuth.cachedCredential()?.userId ?? null;
  return <AskSensiChat key={JSON.stringify([driverId, accountId])} driverId={driverId} accountId={accountId} safety={safety} baseline={baseline} auth={auth} onBack={onBack} settingsOnly={settingsOnly} />;
}

function AskSensiChat({ driverId, accountId, safety, baseline, auth, onBack, settingsOnly }: {
  driverId: string; accountId: string | null; safety: AskSafetyContext | null; baseline: Baseline | null; auth: ReturnType<typeof useSensiAccount>; onBack(): void; settingsOnly: boolean;
}) {
  const { tokens } = useTheme();
  const { t, language } = useAppLanguage();
  const [draft, setDraft] = useState('');
  const [chat, setChat] = useState<AskConversation | null>(null);
  const [chats, setChats] = useState<AskConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatsReady, setChatsReady] = useState(false);
  const [removing, setRemoving] = useState(false);
  const deleting = useRef(false);
  const turns = chat?.turns ?? [];
  const locked = chat !== null;
  const [sessions, setSessions] = useState<repo.AskSensiSession[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [consent, setConsent] = useState<SharingConsent | null>(null);
  const consentNow = useRef<SharingConsent | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sharing = useRef({ drive: false, safety: false });
  const safetyNow = useRef(safety);
  safetyNow.current = safety;
  const personalPrompt = useRef<object | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sessionPicker, setSessionPicker] = useState(false);
  const [localError, setLocalError] = useState('');
  const [error, setError] = useState('');
  const [retryDelay, setRetryDelay] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [prefBusy, setPrefBusy] = useState(false);
  const enabledNow = useRef(false);
  const writingPreference = useRef(false);
  const alive = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const jumpToEnd = useRef(false);
  const preferenceKey = accountId ? askSensiPreferenceKey(accountId, driverId) : null;
  const sharingKey = accountId ? askSensiSharingKey(accountId, driverId) : null;

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!preferenceKey || !sharingKey) return;
    let current = true;
    setPrefBusy(true);
    void Promise.all([SecureStore.getItemAsync(preferenceKey), SecureStore.getItemAsync(sharingKey)]).then(([value, sharing]) => {
      if (current) {
        enabledNow.current = value === 'enabled';
        setEnabled(enabledNow.current);
        const scope = sharing === 'expanded-v1';
        setSharing(sharing === 'enabled' || scope, scope);
      }
    }).catch(() => { if (current) setError('Could not read the secure Ask Sensi preference.'); })
      .finally(() => { if (current) setPrefBusy(false); });
    return () => { current = false; };
  }, [preferenceKey, sharingKey]);
  useEffect(() => {
    if (!sessionPicker && !historyOpen && !sessionId) return;
    let current = true;
    void repo.listAskSensiSessions(driverId).then(rows => { if (current) setSessions(rows); })
      .catch(() => { if (current) setLocalError('Could not load local drive history.'); });
    return () => { current = false; };
  }, [driverId, sessionPicker, historyOpen, sessionId]);
  useEffect(() => {
    if (settingsOnly || !accountId) return;
    let current = true;
    void chatStore.listAskConversations(accountId, driverId).then(items => {
      if (current) { setChats(items); setChatsReady(true); }
    }).catch(() => { if (current) setError('Could not load saved Ask Sensi conversations. Reopen Ask Sensi to try again.'); });
    return () => { current = false; };
  }, [accountId, driverId, settingsOnly]);

  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    void loadAskSensiContext(repo, driverId, sessionId).then(data => {
      if (!current) return;
      if (data) setPreview({ id: sessionId, data });
      else setLocalError('This session is no longer available for the active driver.');
    }).catch(() => { if (current) setLocalError('Could not read the selected drive.'); });
    return () => { current = false; };
  }, [driverId, sessionId]);

  function closeConsent() {
    consentNow.current = null;
    setConsent(null);
    setDetailsOpen(false);
  }

  async function changePreference(next: boolean) {
    if (!preferenceKey || prefBusy || writingPreference.current || sensiCloudAuth.cachedCredential()?.userId !== accountId) return;
    writingPreference.current = true;
    pending.current?.abort();
    enabledNow.current = false;
    setEnabled(false);
    closeConsent();
    setError('');
    setPrefBusy(true);
    try {
      await SecureStore.setItemAsync(preferenceKey, next ? 'enabled' : 'disabled', {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      if (alive.current && sensiCloudAuth.cachedCredential()?.userId === accountId) {
        enabledNow.current = next;
        setEnabled(next);
      }
    } catch { if (alive.current) setError('Could not save that preference. Cloud requests are disabled for this visit.'); }
    finally { writingPreference.current = false; if (alive.current) setPrefBusy(false); }
  }
  function setSharing(drive: boolean, safety: boolean) {
    sharing.current = { drive, safety };
    setRemember(drive);
    setExpanded(safety);
  }

  async function changeRemember(next: boolean, includeSafety = false): Promise<boolean> {
    if (!sharingKey || prefBusy || writingPreference.current || sensiCloudAuth.cachedCredential()?.userId !== accountId) return false;
    writingPreference.current = true;
    pending.current?.abort();
    closeConsent();
    setSharing(false, false);
    setError('');
    setPrefBusy(true);
    try {
      await SecureStore.setItemAsync(sharingKey, next ? (includeSafety ? 'expanded-v1' : 'enabled') : 'disabled', {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      if (!alive.current || sensiCloudAuth.cachedCredential()?.userId !== accountId) return false;
      setSharing(next, next && includeSafety);
      return true;
    } catch {
      if (alive.current) setError('Could not save that preference. Remembered sharing is off for this visit.');
      return false;
    } finally {
      writingPreference.current = false;
      if (alive.current) setPrefBusy(false);
    }
  }

  function openChat(next: AskConversation | null) {
    if (pending.current || deleting.current) return;
    personalPrompt.current = null;
    setChat(next);
    setDraft('');
    setRetryDelay(undefined);
    const drive = next?.driveId ?? null;
    if (drive !== sessionId) {
      setPreview(null);
      setLocalError('');
      setSessionId(drive);
    }
    closeConsent();
    setError('');
    setPreviewOpen(false);
    setPrivacyOpen(false);
    setSessionPicker(false);
    setHistoryOpen(false);
    nearBottom.current = true;
    jumpToEnd.current = true;
    requestAnimationFrame(() => { if (alive.current) scroll.current?.scrollToEnd({ animated: false }); });
  }

  function confirmDelete(item: AskConversation) {
    if (!accountId || deleting.current || pending.current) return;
    Alert.alert('Delete conversation?', 'This removes the chat from this device. The recorded drive stays in History.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        if (deleting.current || pending.current || !alive.current || sensiCloudAuth.cachedCredential()?.userId !== accountId) return;
        deleting.current = true;
        setRemoving(true);
        void chatStore.deleteAskConversation(accountId, driverId, item.id).then(() => {
          if (!alive.current) return;
          deleting.current = false;
          if (chat?.id === item.id) openChat(null);
          setChats(previous => previous.filter(saved => saved.id !== item.id));
        }).catch(() => {
          if (alive.current) { setHistoryOpen(false); setError('Could not delete the conversation. Try again.'); }
        }).finally(() => {
          deleting.current = false;
          if (alive.current) setRemoving(false);
        });
      } },
    ]);
  }

  function submit(suggestion?: SuggestedQuestion) {
    if (!alive.current || busy || prefBusy || removing || pending.current || consentNow.current) return;
    if (!accountId || !enabled) {
      Keyboard.dismiss();
      setPrivacyOpen(true);
      return;
    }
    void send(undefined, undefined, suggestion);
  }

  function setHomeSharing(next = !remember) {
    if (!accountId || prefBusy || busy || writingPreference.current) return;
    if (!next) {
      void changeRemember(false);
      return;
    }
    Alert.alert('Allow access to my drive data', 'When you send, OpenAI can receive the selected drive summary and, for personalized safety questions, recorded baseline medians and configured warning and critical thresholds. You can revoke this permission anytime.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Allow', onPress: () => { if (alive.current) void changeRemember(true, true); } },
    ]);
  }

  function chooseSession(id: string | null) {
    if (locked || pending.current) return;
    personalPrompt.current = null;
    closeConsent();
    setError('');
    setPreviewOpen(false);
    if (sessionId !== id) { setLocalError(''); setPreview(null); setSessionId(id); }
    setSessionPicker(false);
  }

  const selectedPreview = preview?.id === sessionId ? preview : null;
  const readyToSend = !busy && !prefBusy && !removing && !!accountId && enabled && chatsReady;
  const canSend = readyToSend && !!draft.trim() && draft.trim().length <= MAX_QUESTION;
  const unanswered = turns.at(-1)?.answer === null ? turns.at(-1) : undefined;

  async function send(authorization?: SharingConsent, retryTurn?: AskTurn, suggestion?: SuggestedQuestion, generalOnly = false) {
    const question = retryTurn?.question ?? suggestion?.question ?? draft.trim(), credential = sensiCloudAuth.cachedCredential();
    if (!alive.current || !readyToSend || !question || question.length > MAX_QUESTION
      || (retryTurn && retryTurn.id !== unanswered?.id)
      || writingPreference.current || pending.current || !enabledNow.current || !credential || credential.userId !== accountId
      || !accountId || AppState.currentState !== 'active') return;
    if (authorization && (authorization.attachment !== selectedPreview || authorization.question !== question
      || authorization.token !== credential.token || authorization.revision !== credential.revision)) return;
    const localBaseline = isBaselineStatusQuestion(question);
    if (sessionId && !selectedPreview && !localBaseline) {
      setError(localError || 'Wait for the selected drive to load before sending.');
      return;
    }
    const personalQuestion = localBaseline || wantsAskSafetyContext(question, turns.at(-1)?.sharedSafety);
    if (personalQuestion && (safetyNow.current || localBaseline) && !sharing.current.safety && !generalOnly) {
      if (personalPrompt.current) return;
      const prompt = {};
      personalPrompt.current = prompt;
      const clear = () => {
        if (personalPrompt.current !== prompt) return false;
        personalPrompt.current = null;
        return alive.current && sensiCloudAuth.cachedCredential()?.token === credential.token;
      };
      Alert.alert('Share safety baseline and thresholds?', 'OpenAI can receive recorded baseline medians and effective warning and critical thresholds for this question. This also remembers permission to share a selected drive when you send. Names and contact information are excluded.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => { clear(); } },
          { text: 'Continue without baseline and thresholds', onPress: () => { if (clear()) void send(authorization, retryTurn, suggestion, true); } },
          { text: 'Allow and send', onPress: () => {
            if (clear()) void changeRemember(true, true).then(allowed => {
              if (allowed && sensiCloudAuth.cachedCredential()?.token === credential.token) void send(authorization, retryTurn, suggestion);
            });
          } },
        ], { cancelable: true, onDismiss: () => { clear(); } });
      return;
    }
    const safetyContext = personalQuestion && sharing.current.safety && !generalOnly ? safetyNow.current : null;
    if (selectedPreview && !localBaseline && !sharing.current.drive && !authorization) {
      if (consentNow.current) return;
      const approval = { attachment: selectedPreview, question, revision: credential.revision, token: credential.token, retryTurn, suggestion, generalOnly };
      consentNow.current = approval;
      Keyboard.dismiss();
      setDetailsOpen(false);
      setConsent(approval);
      return;
    }
    const attachment = selectedPreview;
    const context = attachment?.data ?? null;
    const currentTopic = retryTurn?.topic ?? suggestion?.topic ?? 'help';
    const requestTopic: AskTopic = context && currentTopic !== 'help' ? currentTopic : context ? 'drive' : 'help';
    const history = turns.filter(turn => !turn.sharedSafety || !!safetyContext).flatMap(({ question, answer }) => answer === null ? [] : [{ question, answer: answer.length > MAX_ASK_HISTORY_ANSWER ? answer.slice(0, MAX_ASK_HISTORY_ANSWER - 1) + '…' : answer }]).slice(-MAX_ASK_TURNS);
    const operation = new AbortController();
    pending.current = operation;
    setSessionPicker(false);
    setPreviewOpen(false);
    setBusy(true);
    setRetryDelay(undefined);
    setError('');
    const unsubscribe = sensiCloudAuth.subscribe(() => {
      const current = sensiCloudAuth.cachedCredential();
      if (current?.userId !== credential.userId || current.revision !== credential.revision) operation.abort();
    });
    async function persist(item: AskConversation) {
      await chatStore.saveAskConversation(credential!.userId, driverId, item);
      if (!alive.current) return;
      setChat(item);
      setChats(previous => {
        const items = previous.filter(saved => saved.id !== item.id);
        return [...items, item].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      });
    }
    try {
      if (attachment) {
        const latest = await loadAskSensiContext(repo, driverId, attachment.id);
        if (!alive.current || operation.signal.aborted) return;
        if (!latest || JSON.stringify(latest) !== JSON.stringify(context)) {
          setPreview(latest ? { id: attachment.id, data: latest } : null);
          closeConsent();
          if (!latest) setLocalError('This session is no longer available for the active driver.');
          setError('The selected record changed. Review the preview before sharing again.');
          return;
        }
      }
      const requestId = uuidv4();
      const now = new Date().toISOString();
      const currentChat = chat ?? newAskConversation(uuidv4(), sessionId, question, now);
      const previous = turns.at(-1);
      const turn = { id: retryTurn?.id ?? (previous?.answer === null && previous.question === question ? previous.id : requestId), question, answer: null, topic: requestTopic, ...((safetyContext || localBaseline) && sharing.current.safety && !generalOnly ? { sharedSafety: true } : {}) };
      const submitted = appendAskTurn(currentChat, turn, now);
      jumpToEnd.current = true;
      await persist(submitted);
      if (alive.current) setDraft(current => current.trim() === question ? '' : current);
      if (!alive.current || operation.signal.aborted) return;
      const base = { kind: 'ask_sensi' as const, requestId, topic: requestTopic, question, context };
      const request: AskRequest = safetyContext ? { ...base, version: 3, history, safetyContext }
        : history.length ? { ...base, version: 2, history } : { ...base, version: 1 };
      while (history.length && JSON.stringify(request).length * 3 > 12_288) history.shift();
      const result = localBaseline
        ? { ok: true as const, message: baselineStatusAnswer(baseline, sharing.current.safety && !generalOnly, t) }
        : context && isDriveOverview(question)
        ? { ok: true as const, message: formatRecordedDriveSummary(context, driveDateTime, t) }
        : await sendAsk(request, () => {
            const current = sensiCloudAuth.cachedCredential();
            return {
              credential: current,
              active: alive.current && AppState.currentState === 'active' && pending.current === operation
                && current?.userId === credential.userId && current.revision === credential.revision && current.token === credential.token,
              enabled: enabledNow.current, sharingApproved: !context || !!attachment, safetySharingApproved: sharing.current.safety,
            };
        }, operation.signal);
      if (!alive.current || pending.current !== operation || operation.signal.aborted) return;
      if (result.ok) {
        const answered = appendAskTurn(submitted, { ...turn, answer: result.message }, new Date().toISOString());
        try { await persist(answered); }
        catch {
          if (alive.current) { setChat(answered); setError('The response could not be saved to conversation history.'); }
        }
      } else {
        setError(errors[result.error]);
        setRetryDelay(result.retryAfterSeconds);
      }
    } catch {
      if (alive.current && !operation.signal.aborted) setError('Could not verify the selected drive or save the conversation. Try again.');
    } finally {
      unsubscribe();
      if (pending.current === operation) pending.current = null;
      if (alive.current) setBusy(false);
    }
  }

  async function approve(approval: SharingConsent, persistSharing: boolean) {
    if (consentNow.current !== approval) return;
    closeConsent();
    if (persistSharing && !await changeRemember(true)) return;
    await send(approval, approval.retryTurn, approval.suggestion, approval.generalOnly);
  }

  const body = { color: tokens.text, fontSize: 16 };
  const muted = { color: tokens.textSecondary, fontSize: 13 };
  const sendEnabled = canSend || (!busy && !prefBusy && !!draft.trim() && (!accountId || !enabled));
  const selected = sessions?.find(session => session.id === sessionId);
  const locale = language === 'es' ? 'es' : 'en';
  const dateLabel = (timestamp?: string | null) => timestamp && Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toLocaleDateString(locale, { dateStyle: 'medium' }) : t('Date unavailable');
  const timeLabel = (timestamp: string) => Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : t('Time unavailable');
  const durationLabel = (seconds?: number | null) => typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds < 60 ? Math.round(seconds) + ' s' : Math.round(seconds / 60) + ' min' : t('Duration unavailable');
  const groups = new Map<string, repo.AskSensiSession[]>();
  for (const session of sessions ?? []) {
    const date = dateLabel(session.started_at);
    const entries = groups.get(date) ?? [];
    entries.push(session);
    groups.set(date, entries);
  }
  const selectedTimestamp = selected?.started_at ?? chat?.driveStartedAt;
  const selectedDate = dateLabel(selectedTimestamp);
  const driveDateTime = selectedTimestamp ? selectedDate + ' · ' + timeLabel(selectedTimestamp)
    : [selectedPreview?.data.date, selectedPreview?.data.localTime].filter(Boolean).join(' · ');
  const selectedDuration = durationLabel(selected?.duration_seconds ?? preview?.data.durationSeconds);
  const driveChip = !sessionId ? t('General conversation') : selected ? driveDateTime
    : localError ? t('Drive unavailable') : t('Recorded drive');
  const iconButton = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' } as const;
  const chip = { backgroundColor: tokens.surfaceMuted, borderRadius: 16, minHeight: 44, paddingHorizontal: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6 } as const;
  const row = { minHeight: 48, flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 8 } as const;
  function sheet(title: string, onClose: () => void, children: ReactNode) {
    return <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: tokens.overlay }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose}
          style={{ flex: 1 }} />
        <SafeAreaView accessibilityViewIsModal style={{ maxHeight: '78%', backgroundColor: tokens.background,
          borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
          <View style={{ ...row, paddingHorizontal: 16 }}>
            <Text accessibilityRole="header" style={{ ...body, flex: 1, fontWeight: '700' }}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Close sheet')} onPress={onClose} style={iconButton}>
              <Feather name="x" size={20} color={tokens.text} />
            </Pressable>
          </View>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 8 }}>
            {children}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>;
  }
  function choice(label: string, icon: 'message-circle' | 'navigation', active: boolean, onPress: () => void, detail?: string, key = label, accessibilityLabel = label) {
    return <Pressable key={key} accessibilityRole="radio" accessibilityLabel={accessibilityLabel}
      accessibilityHint={detail} accessibilityState={{ selected: active }} onPress={onPress}
      style={{ ...row, borderBottomWidth: 1, borderBottomColor: tokens.border }}>
      <Feather name={icon} size={17} color={tokens.textSecondary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text localize={false} style={{ ...body, fontWeight: active ? '700' : '500' }}>{label}</Text>
        {detail ? <Text localize={false} style={muted}>{detail}</Text> : null}
      </View>
      {active ? <Feather name="check" size={18} color={tokens.primary} /> : null}
    </Pressable>;
  }
  const privacySheet = () => sheet(t('Ask Sensi settings'), settingsOnly ? onBack : () => setPrivacyOpen(false), <>
      <Text accessibilityRole="header" style={body}>Cloud account</Text>
      <SensiCloudAccess blocked={busy} state={auth} />
      {accountId ? <>
        <View style={{ ...row, borderBottomWidth: 1, borderBottomColor: tokens.border }}>
          <View style={{ flex: 1 }}>
            <Text style={body}>Enable Ask Sensi</Text>
            <Text style={muted}>Send your typed questions to OpenAI when you choose Send.</Text>
          </View>
          <Switch accessibilityLabel={t('Enable Ask Sensi')} disabled={prefBusy || busy}
            value={enabled} onValueChange={value => void changePreference(value)} />
        </View>
        <View style={{ ...row, borderBottomWidth: 1, borderBottomColor: tokens.border }}>
          <View style={{ flex: 1 }}>
            <Text style={body}>Remember drive sharing</Text>
            <Text style={muted}>Share the selected drive only when you send. Personalized safety questions require permission to share baseline medians and thresholds.</Text>
          </View>
          <Switch accessibilityLabel={t('Remember drive sharing')} disabled={prefBusy || busy}
            value={remember} onValueChange={setHomeSharing} />
        </View>
      </> : null}
      <Text accessibilityRole="header" style={body}>Privacy and data usage</Text>
      <Text style={muted}>Chat history is saved on this device. When you press Send, OpenAI receives the question and relevant recent turns. Sharing drive data requires separate approval.</Text>
      {expanded ? <Text style={muted}>Includes baseline and thresholds for personalized safety questions.</Text> : null}
      <Text style={muted}>Safety Sensi remains available offline.</Text>
      <Btn kind="ghost" title="Offline DriveSense help" accessibilityState={{ expanded: helpOpen }} onPress={() => setHelpOpen(!helpOpen)} />
      {helpOpen ? DRIVE_HELP.map(item => <Text key={item} style={muted}>{item}</Text>) : null}
  </>);

  if (settingsOnly) return privacySheet();
  const questions = sessionId
    ? driveSuggestions.map(({ icon, topic }) => ({ icon, topic, question: starters[topic] }))
    : generalSuggestions.map(({ icon, question }) => ({ icon, question, topic: 'help' as const }));
  return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} style={iconButton} onPress={onBack}>
          <Feather name="chevron-left" size={23} color={tokens.text} />
        </Pressable>
        <Text accessibilityRole="header" style={{ ...body, fontWeight: '700', flex: 1 }}>Ask Sensi</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Conversation history')} style={iconButton}
          disabled={busy || removing} onPress={() => { Keyboard.dismiss(); setHistoryOpen(true); }}>
          <Feather name="sidebar" size={18} color={tokens.text} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('New Chat')} style={iconButton}
          disabled={busy || removing} onPress={() => openChat(null)}>
          <Feather name="edit" size={18} color={tokens.text} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Ask Sensi settings')} style={iconButton}
          onPress={() => { Keyboard.dismiss(); setPrivacyOpen(true); }}>
          <Feather name="settings" size={18} color={tokens.text} />
        </Pressable>
      </View>
      {(sessionId || !locked) ? <View style={{ paddingHorizontal: 12, alignItems: 'flex-start' }}>
        {locked ? <View style={chip}>
          <Feather name="lock" size={13} color={tokens.textSecondary} />
          <Text localize={false} style={muted}>{driveChip}</Text>
        </View> : <Pressable accessibilityRole="button" accessibilityLabel={driveChip}
          accessibilityState={{ expanded: sessionPicker, disabled: busy }} disabled={busy} style={chip}
          onPress={() => { Keyboard.dismiss(); setSessionPicker(true); }}>
          <Feather name={sessionId ? 'navigation' : 'message-circle'} size={14} color={tokens.textSecondary} />
          <Text localize={false} numberOfLines={1} style={{ ...muted, flexShrink: 1 }}>{driveChip}</Text>
          <Feather name="chevron-down" size={15} color={tokens.textSecondary} />
        </Pressable>}
        {!locked ? <Pressable accessibilityRole="checkbox" accessibilityLabel={t('Allow access to my drive data')}
          accessibilityHint={t(remember && !expanded ? 'Saved permission covers selected drives. Personalized values need new approval.' : 'Share a selected drive when you send, plus baseline and thresholds for relevant questions.')}
          accessibilityState={{ checked: remember, disabled: !accountId || prefBusy || busy }}
          disabled={!accountId || prefBusy || busy} onPress={() => setHomeSharing()}
          style={{ ...row, minHeight: 44 }}>
          <Feather name={remember ? 'check-square' : 'square'} size={16} color={tokens.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text style={muted}>Allow access to my drive data</Text>
            <Text style={muted}>{remember && !expanded
              ? 'Saved permission covers selected drives. Personalized values need new approval.'
              : 'Share a selected drive when you send, plus baseline and thresholds for relevant questions.'}</Text>
          </View>
        </Pressable> : null}
      </View> : null}
      <ScrollView ref={scroll} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" scrollEventThrottle={32}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 90;
        }}
        onContentSizeChange={() => {
          if (jumpToEnd.current || locked && nearBottom.current) scroll.current?.scrollToEnd({ animated: false });
          jumpToEnd.current = false;
        }}
        contentContainerStyle={{ padding: 14, gap: 12, flexGrow: 1 }}>
        {!locked && !busy ? <View style={{ gap: 10, paddingVertical: 12 }}>
          <View accessible={false} style={{ alignSelf: 'center', width: 50, height: 50, borderRadius: 18,
            alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.primary }}>
            <SensiGlyph color={tokens.onPrimary} />
          </View>
          <Text accessibilityRole="header" style={{ ...body, fontSize: 25, fontWeight: '700', textAlign: 'center' }}>How can I help?</Text>
          <Text style={{ ...muted, textAlign: 'center' }}>Ask about your drives, biometrics, or safety warnings.</Text>
          <View style={{ gap: 6 }}>
            {questions.map(({ icon, topic, question }) => <Pressable key={question} accessibilityRole="button"
              accessibilityLabel={t(question)} onPress={() => submit({ topic, question: t(question) })}
              style={{ ...row, paddingHorizontal: 12, borderRadius: 12, backgroundColor: tokens.surfaceMuted }}>
              <Feather name={icon} size={16} color={tokens.textSecondary} />
              <Text style={{ ...body, flex: 1, fontSize: 14 }}>{question}</Text>
              <Feather name="arrow-up-right" size={15} color={tokens.textSecondary} />
            </Pressable>)}
          </View>
        </View> : null}
        {selectedPreview ? <>
          <Pressable accessibilityRole="button" accessibilityLabel={t(previewOpen ? 'Hide drive preview' : 'Preview drive data')}
            accessibilityState={{ expanded: previewOpen }} onPress={() => { setDetailsOpen(false); setPreviewOpen(!previewOpen); }} style={row}>
            <Feather name={previewOpen ? 'chevron-up' : 'chevron-down'} size={15} color={tokens.textSecondary} />
            <Text style={muted}>{previewOpen ? 'Hide drive preview' : 'Preview drive data'}</Text>
          </Pressable>
          {previewOpen ? <>
            <ContextPreview context={selectedPreview.data} details={detailsOpen} date={driveDateTime || selectedDate} duration={selectedDuration} />
            <Btn kind="ghost" title={detailsOpen ? 'Hide shared data' : 'View shared data'}
              accessibilityState={{ expanded: detailsOpen }} onPress={() => setDetailsOpen(!detailsOpen)} />
          </> : null}
        </> : null}
        {sessionId && !preview && !localError ? <ActivityIndicator color={tokens.primary} /> : null}
        {localError ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{localError}</Text> : null}
        {turns.map(turn => <View key={turn.id} style={{ gap: 10 }}>
          <View style={{ alignSelf: 'flex-end', maxWidth: '86%', backgroundColor: tokens.surfaceMuted, padding: 11, borderRadius: 16 }}>
            <Text localize={false} style={body}>{turn.question}</Text>
          </View>
          {turn.answer ? <AskSensiResponse message={turn.answer} /> : null}
          {unanswered?.id === turn.id && !busy ? <Pressable accessibilityRole="button" accessibilityLabel={t('Retry')}
            accessibilityState={{ disabled: !readyToSend }} disabled={!readyToSend} onPress={() => void send(undefined, turn)}
            style={{ ...row, alignSelf: 'flex-end', paddingHorizontal: 8 }}>
            <Feather name="rotate-ccw" size={14} color={tokens.textSecondary} />
            <Text style={muted}>Retry</Text>
          </Pressable> : null}
        </View>)}
        {busy ? <View style={row}>
          <ActivityIndicator size="small" color={tokens.textSecondary} />
          <Text accessibilityLiveRegion="polite" style={muted}>Sensi is thinking…</Text>
        </View> : null}
      </ScrollView>
      <View style={{ padding: 10, gap: 5 }}>
        {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{error}</Text> : null}
        {retryDelay !== undefined ? <Text localize={false} style={muted}>{t('Server suggests waiting {seconds} s.').replace('{seconds}', String(retryDelay))}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, padding: 4, backgroundColor: tokens.surfaceMuted, borderRadius: 24 }}>
          <TextInput accessibilityLabel={t('Ask Sensi question')} placeholder="Type a question" placeholderTextColor={tokens.textMuted}
            value={draft} onChangeText={setDraft} multiline maxLength={MAX_QUESTION} editable={!busy && !prefBusy}
            style={{ ...body, flex: 1, padding: 10, minHeight: 44, maxHeight: 112 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={t('Send')} accessibilityState={{ disabled: !sendEnabled, busy }}
            disabled={!sendEnabled} style={{ ...iconButton, borderRadius: 22, backgroundColor: sendEnabled ? tokens.primary : tokens.border }}
            onPress={() => submit()}>
            <Feather name="arrow-up" size={21} color={sendEnabled ? tokens.onPrimary : tokens.textMuted} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
    {sessionPicker ? sheet(t('Choose a drive'), () => setSessionPicker(false), <>
      {choice(t('General conversation'), 'message-circle', !sessionId, () => chooseSession(null))}
      {sessions === null && !localError ? <ActivityIndicator color={tokens.primary} /> : null}
      {localError ? <Text accessibilityRole="alert" style={muted}>{localError}</Text> : null}
      {sessions?.length === 0 ? <Text style={muted}>No finished drives are recorded for this driver.</Text> : null}
      {[...groups].map(([date, drives]) => <View key={date}>
        <Text localize={false} accessibilityRole="header" style={{ ...muted, fontWeight: '700', paddingTop: 8 }}>{date}</Text>
        {drives.map(drive => choice(timeLabel(drive.started_at), 'navigation', drive.id === sessionId, () => chooseSession(drive.id),
          durationLabel(drive.duration_seconds) + (Number.isInteger(drive.warning_count) ? ' · ' + t('Recorded warnings:') + ' ' + drive.warning_count : ''), drive.id, date + ' · ' + timeLabel(drive.started_at)))}
      </View>)}
    </>) : null}
    {consent ? sheet(t('Share this drive?'), closeConsent, <>
      <Text style={muted}>Send your question, recent chat, and this drive summary to OpenAI.</Text>
      <ContextPreview context={consent.attachment.data} details={detailsOpen} date={driveDateTime || selectedDate} duration={selectedDuration} />
      <Btn kind="ghost" title={detailsOpen ? 'Hide shared data' : 'View shared data'}
        accessibilityState={{ expanded: detailsOpen }} onPress={() => setDetailsOpen(!detailsOpen)} />
      <Btn title="Allow once and send" onPress={() => void approve(consent, false)} />
      <Btn kind="ghost" title="Remember permission and send" onPress={() => void approve(consent, true)} />
      <Btn kind="ghost" title="Cancel" onPress={closeConsent} />
    </>) : null}
    {privacyOpen ? privacySheet() : null}
    {historyOpen ? <AskSensiHistory chats={chats} activeId={chat?.id} driveLabel={item => {
      const start = sessions?.find(session => session.id === item.driveId)?.started_at ?? item.driveStartedAt;
      return start ? dateLabel(start) + ' · ' + timeLabel(start) : item.driveStartedAt === null ? t('Drive unavailable') : t('Recorded drive');
    }} onClose={() => setHistoryOpen(false)} onNew={() => openChat(null)} onSelect={openChat} onDelete={confirmDelete} /> : null}
  </SafeAreaView>;
}
