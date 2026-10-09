import { reportedDrivingConcern, PULL_OVER_GUIDANCE } from './driverWellnessSafety.ts';
import { contactRequestDecision, normalise, mentionsEmergencyServices, understandCallAnswer } from '../../lib/voice/intent.ts';
import { conversationalReply, finalTranscript, contactLabel, contactHandoffMessage } from './conversationPolicy.ts';
import type { DriverInterpretationResponse, OfflineTranscription } from './index.ts';

export type ConversationPhase = 'idle' | 'checking' | 'speaking question' | 'listening' | 'finalizing'
  | 'interpreting' | 'speaking response' | 'contact offer' | 'phone interface' | 'complete' | 'stopping' | 'cancelled' | 'error';
export const CONVERSATION_REVISION = 'natural-conversation-v3-safety-2026-10-09';
export type Turn = { driver: string; assistant: string; fallback?: boolean; fallbackReason?: string };
export type DecisionDiagnostic = { acceptedFinalTranscript: string; normalizedText: string; direct: boolean; reason: string;
  callAnswer: string; activeOffer: boolean; servicesExcluded: boolean; handoffOutcome?: string };
export type ConversationState = { phase: ConversationPhase; turns: Turn[]; transcript: string;
  recognitionAttempts?: { turn: number; attempt: number; result: OfflineTranscription }[];
  decisions?: DecisionDiagnostic[];
  interpretation?: DriverInterpretationResponse; message?: string; timings: Record<string, number> };
export type AssistantDeps = {
  diagnostics?: boolean;
  contactAvailability?: () => 'available' | 'missing_contact' | 'invalid_phone';
  contactName?: () => string | null | undefined;
  prepare(): Promise<void>;
  acquire(stop: () => Promise<void>): Promise<() => void>;
  speak(text: string, id: string): Promise<void>;
  listen(id: string, progress: (phase: 'listening' | 'finalizing', transcript: string) => void): Promise<OfflineTranscription>;
  interpret(text: string, context: string, id: string): Promise<DriverInterpretationResponse>;
  cancel(kind: 'speech' | 'listening' | 'inference', id: string): Promise<void>;
  handoff(text: string, offered: boolean, current: () => boolean): Promise<string>;
  onChange(state: ConversationState): void;
};

/** No React or app services: deterministic orchestration around injected on-device I/O. */
export class AssistantConversation {
  private active: { cancelled: boolean; interrupt: () => void; done: Promise<void> } | null = null;
  private sequence = 0;
  private readonly deps: AssistantDeps;
  private readonly stageMs: number;
  private readonly maxTurns: number;
  private readonly totalMs: number;
  constructor(deps: AssistantDeps, stageMs = 30000, maxTurns = 4, totalMs = 180000) {
    this.deps = deps; this.stageMs = stageMs; this.maxTurns = maxTurns; this.totalMs = totalMs;
  }
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    active.interrupt();
    await active.done;
  }
  async start(): Promise<void> {
    if (this.active) throw new Error('A conversation is already active.');
    let finish!: () => void;
    let interrupt!: () => void;
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    const done = new Promise<void>(resolve => { finish = resolve; });
    const active = { cancelled: false, interrupt, done };
    this.active = active;
    const prefix = `assistant-${Date.now()}-${++this.sequence}`;
    const started = Date.now();
    const state: ConversationState = { phase: 'checking', turns: [], transcript: '', timings: {}, recognitionAttempts: [], ...(this.deps.diagnostics ? { decisions: [] } : {}) };
    let guidanceDelivered = false;
    const guidedSymptoms = new Set<string>();
    let worseningGuided = false;
    let release: (() => void) | undefined;
    const current = () => this.active === active && !active.cancelled;
    const assertCurrent = () => { if (!current()) throw new Error('Conversation cancelled.'); };
    const emit = (phase: ConversationPhase, message?: string) => {
      state.phase = phase; state.message = message;
      this.deps.onChange({ ...state, turns: [...state.turns], recognitionAttempts: [...(state.recognitionAttempts ?? [])], ...(state.decisions ? { decisions: state.decisions.map(d => ({ ...d })) } : {}), timings: { ...state.timings } });
    };
    async function stage<T>(key: string, action: () => Promise<T>, cancel?: () => Promise<void>, ownsAudio = false): Promise<T> {
      assertCurrent();
      const at = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = Promise.resolve().then(action);
      try {
        return await Promise.race([pending, interrupted.then(() => { throw new Error('Conversation cancelled.'); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${key} timed out.`)),
            Math.max(1, Math.min(stageMs, totalMs - (Date.now() - started)))); })]);
      } catch (error) {
        if (cancel) {
          try { await cancel(); }
          finally {
            // Even a failed cancel bridge must not release ownership over live audio.
            if (ownsAudio) await pending.catch(() => {});
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        state.timings[key] = Date.now() - at;
      }
    }
    const { stageMs, totalMs } = this;
    const speak = async (text: string, turn: number) => {
      const id = `${prefix}-${turn}-speech`;
      await stage(`speech-${turn}`, () => this.deps.speak(text, id), () => this.deps.cancel('speech', id), true);
      assertCurrent();
      if (/pull over (?:safely|when (?:it is |it's )?safe)/i.test(text.replace(/’/g, "'"))) guidanceDelivered = true;
    };
    try {
      emit('checking');
      await stage('prepare', () => this.deps.prepare());
      assertCurrent();
      // Do not leave a lease behind if cancellation occurs while acquiring it.
      release = await this.deps.acquire(() => this.stop());
      assertCurrent();
      let prompt = 'How are you feeling?';
      let offered = false;
      let contactDeclined = false;
      let servicesExcluded = false;
      for (let turn = 0; turn < this.maxTurns; turn++) {
        emit(turn === 0 ? 'speaking question' : offered ? 'contact offer' : 'speaking response');
        await speak(prompt, turn);
        let text = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          const captureId = `${prefix}-${turn}-capture${attempt ? '-retry' : ''}`;
          state.transcript = '';
          emit('listening');
          const capture = await stage(`recognition-${turn}-${attempt}`, () => this.deps.listen(captureId, (phase, transcript) => {
            if (current()) { state.transcript = transcript; emit(phase); }
          }), () => this.deps.cancel('listening', captureId), true);
          assertCurrent();
          // Publish the failed envelope and timing before applying the final-only gate.
          state.recognitionAttempts!.push({ turn: turn + 1, attempt: attempt + 1, result: capture });
          state.transcript = capture.transcript;
          state.timings[`listening-${turn}-${attempt}`] = capture.listeningTimeMs;
          state.timings[`finalizing-${turn}-${attempt}`] = capture.finalizationTimeMs;
          emit('finalizing');
          const incomplete = capture.status === 'incomplete'
            || (capture.status === 'timeout' && !!capture.transcript.trim());
          if (incomplete && attempt === 0) {
            const explanation = "Your response wasn't confirmed. Please answer again.";
            emit(offered ? 'contact offer' : 'speaking question', explanation);
            const retryPrompt = guidanceDelivered ? (prompt.match(/[^.!?]+[.!?]?/g) ?? []).filter(sentence =>
              !/pull over (?:safely|when (?:it is |it's )?safe)/i.test(sentence.replace(/’/g, "'"))).join(' ').trim() : prompt;
            await speak(`${explanation} ${retryPrompt}`, turn + 200);
            continue; // a new capture; never reuse previous partial words as consent
          }
          if (incomplete) throw new Error('Your response was not confirmed after the retry. No number was opened.');
          text = finalTranscript(capture);
          state.transcript = text;
          break;
        }
        if (/^(?:stop|cancel|stop talking|end conversation|goodbye|bye|that's all|that is all)[.!]?$/i.test(text.trim())) {
          emit('complete', 'Conversation ended.'); return;
        }
        servicesExcluded ||= mentionsEmergencyServices(text);
        const decision = contactRequestDecision(text);
        const direct = decision.explicit;
        const callAnswer = understandCallAnswer(text);
        const refusedContact = callAnswer === 'no' && /\b(?:call|contact|phone|dial)\b/i.test(text);
        const consent = offered ? callAnswer : 'unclear';
        contactDeclined ||= refusedContact || offered && callAnswer === 'no';
        const concern = reportedDrivingConcern(text);
        if (concern.worsening && !concern.symptoms.length) concern.symptoms.push(...guidedSymptoms);
        const needsGuidance = concern.symptoms.length > 0 && (!guidanceDelivered
          || concern.symptoms.some(symptom => !guidedSymptoms.has(symptom)) || concern.worsening && !worseningGuided);
        const guidance = needsGuidance ? PULL_OVER_GUIDANCE : '';
        if (needsGuidance) { concern.symptoms.forEach(symptom => guidedSymptoms.add(symptom)); worseningGuided ||= concern.worsening; }
        const contactAvailability = this.deps.contactAvailability?.() ?? 'missing_contact';
        const diagnostic: DecisionDiagnostic = { acceptedFinalTranscript: text, normalizedText: normalise(text),
          direct, reason: decision.reason, callAnswer, activeOffer: offered, servicesExcluded };
        state.decisions?.push(diagnostic);
        if (!servicesExcluded && (direct || consent === 'yes')) {
          // Raw final transcript, never model fields. No redundant direct-request confirmation.
          if (guidance) { emit('speaking response', guidance); await speak(guidance, turn + 300); }
          assertCurrent();
          emit('phone interface');
          const handoff = await this.deps.handoff(text, offered, current);
          assertCurrent();
          diagnostic.handoffOutcome = handoff;
          const outcome = contactHandoffMessage(handoff, this.deps.contactName?.());
          if (handoff !== 'opened' && handoff !== 'cancelled') { emit('speaking response'); await speak(outcome, turn + 301); }
          state.turns.push({ driver: text, assistant: `${guidance ? guidance + ' ' : ''}${outcome}` });
          emit(handoff === 'opened' ? 'complete' : 'error', state.turns.at(-1)!.assistant);
          return;
        }
        if (servicesExcluded) {
          const reply = `${guidance || (!guidanceDelivered ? PULL_OVER_GUIDANCE : '')} This assistant cannot arrange emergency help.`.trim();
          state.turns.push({ driver: text, assistant: reply });
          emit('speaking response'); await speak(reply, turn + 100);
          emit('complete', 'No number was opened.'); return;
        }
        if (offered) {
          const answer = consent === 'no' ? 'Okay, I won’t.' : "I didn’t get clear agreement. No number was opened.";
          const reply = `${guidance ? guidance + ' ' : ''}${answer}`;
          state.turns.push({ driver: text, assistant: reply });
          emit('speaking response'); await speak(reply, turn + 100);
          emit('complete'); return;
        }
        // Safety-critical dialogue bypasses generation, but never authorizes a call.
        if (concern.symptoms.length > 0) {
          offered = !contactDeclined && contactAvailability === 'available';
          prompt = contactAvailability !== 'available'
            ? `${guidance ? guidance + ' ' : ''}${contactHandoffMessage(contactAvailability)}`
            : offered ? `${guidance ? guidance + ' ' : ''}Would you like to call ${contactLabel(this.deps.contactName?.())}?`
              : `${guidance ? guidance + ' ' : ''}${refusedContact ? 'Okay, I won’t. ' : ''}${turn === 0 ? 'Is the discomfort getting better or worse?' : turn === 1 ? 'What feels different now?' : 'Tell me what you notice.'}`;
          if (turn === this.maxTurns - 1 && offered) {
            prompt = `${guidance ? guidance + ' ' : ''}No number was opened. You can start again.`;
            offered = false;
          }
          state.turns.push({ driver: text, assistant: prompt });
          if (!offered && (!prompt.includes('?') || turn === this.maxTurns - 1)) {
            emit('speaking response'); await speak(prompt, turn + 100); emit('complete'); return;
          }
          continue;
        }
        const inferenceId = `${prefix}-${turn}-inference`;
        emit('interpreting');
        const context = JSON.stringify(state.turns.slice(-3).map(({ driver, assistant }) => ({ driver, assistant }))).slice(0, 2400);
        const result = await stage(`inference-${turn}`, () => this.deps.interpret(text, context, inferenceId),
          () => this.deps.cancel('inference', inferenceId));
        assertCurrent();
        state.interpretation = result;
        if (result.status !== 'success') throw new Error(`${result.error.code}: ${result.error.message}`);
        // Validate advisory shape even when a deterministic offer replaces generated text.
        const reply = conversationalReply(result.interpretation, state.turns.map(item => item.assistant), guidanceDelivered);
        const modelSuggestsContact = result.interpretation.requestsSavedEmergencyContact || result.interpretation.explicitContactRequest;
        offered = !contactDeclined && contactAvailability === 'available' && modelSuggestsContact;
        const contactUnavailable = !contactDeclined && modelSuggestsContact && contactAvailability !== 'available';
        const generatedUsed = !refusedContact && !offered && !contactUnavailable;
        const advisoryGuidance = result.interpretation.wellness === 'not_ok' && !guidanceDelivered ? PULL_OVER_GUIDANCE + ' ' : '';
        prompt = refusedContact ? `${advisoryGuidance}Okay, I won’t. How are you feeling otherwise?`
          : contactUnavailable ? `${advisoryGuidance}${contactHandoffMessage(contactAvailability)}`
          : offered ? `${advisoryGuidance}Would you like to call ${contactLabel(this.deps.contactName?.())}?` : reply.text;
        state.turns.push({ driver: text, assistant: prompt,
          ...(generatedUsed ? { fallback: reply.usedFallback, fallbackReason: reply.fallbackReason } : {}) });
        if (!offered && !prompt.includes('?')) {
          emit('speaking response'); await speak(prompt, turn + 100);
          emit('complete'); return;
        }
        if (turn === this.maxTurns - 1) {
          // Do not make an offer that this bounded conversation cannot hear answered.
          prompt = offered ? `${advisoryGuidance}No number was opened. You can start again.` : prompt;
          state.turns[state.turns.length - 1]!.assistant = prompt;
          emit('speaking response'); await speak(prompt, turn + 100);
          emit('complete', 'Conversation limit reached. You can start again.');
        }
      }
    } catch (error) {
      emit(active.cancelled ? 'cancelled' : 'error', error instanceof Error ? error.message : String(error));
    } finally {
      release?.();
      state.timings.total = Date.now() - started;
      this.deps.onChange({ ...state, turns: [...state.turns], recognitionAttempts: [...(state.recognitionAttempts ?? [])], ...(state.decisions ? { decisions: state.decisions.map(d => ({ ...d })) } : {}), timings: { ...state.timings } });
      if (this.active === active) this.active = null;
      finish();
    }
  }
}
