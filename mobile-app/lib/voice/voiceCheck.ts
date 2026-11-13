/**
 * The spoken "Are you feeling okay?" check, run when the flag engine confirms
 * an emergency. It reacts to a flag; it never looks at the vitals itself.
 *
 *   speak prompt → listen (6 s) → understand
 *     ok      → reassure, done (outcome ok)
 *     not_ok  → safety instructions, then offer a saved-contact phone handoff
 *     explicit contact request → skip the offer; caller handles the handoff
 *     unclear → the on-device Gemma classifier gets one bounded window
 *       (reAskWaitMs, default 2000 ms) to resolve the answer (its verdict is
 *       combined with the deterministic vetoes, never with consent state).
 *       The consult covers only this first unclear answer's bounded wait; a
 *       re-asked answer opens no consult and is decided by the deterministic
 *       pipeline alone → resolved, or ask once more, simpler → listen (6 s)
 *       ok / not_ok as above; still unclear or silent → no_response
 *
 * No response is treated like "not okay" by the caller (proposal: escalate
 * when the driver does not respond). The on-screen buttons stay available the
 * whole time and win immediately (answerByButton), so the check also works
 * when the microphone or speech recognition is unavailable.
 *
 * Wording is honest about the prototype: it never says help is on the way,
 * because opening the phone interface does not establish that a call connected.
 *
 * Speech I/O is injected (see speechIO.ts for the phone implementation), so
 * the dialogue policy is unit-tested without a device (tests/voiceCheck.test.ts).
 * Transcripts are used in memory only and never stored.
 */
import { semanticCombinedDecision, semanticEligible, type SemanticTask, type SemanticContext, type SemanticResult } from '../assistant/safetySemantic.ts';
import { completeSafetyResponsePlan, promptSentences, safetyGuidancePlan } from './responsePlan.ts';
import { understand, understandCallAnswer, mentionsEmergencyServices } from './intent.ts';

import { approvedAcknowledgment, acknowledgmentContext, type AcknowledgmentContext } from '../assistant/safetyAcknowledgment.ts';
import { responsivenessProbe } from './responsivenessDiagnostics.ts';
import { successfulFinal, type CoreRecognition } from './coreRecognition.ts';

let nextCheck = 0;

export type Lang = 'en' | 'es';

export type RecognitionPhase = 'preparing' | 'ready' | 'listening' | 'finalizing';
export type VoiceIO = {
  /** Register microphone-free preparation for the next prompt; never accepts an answer. */
  prepareRecognition?(lang: Lang, captureId: string): void;
  pause?(): Promise<void>;
  speak(text: string, lang: Lang): Promise<void | { status: 'unavailable' }>;
  /** Only scoped successful final evidence is accepted; legacy strings are unconfirmed. */
  listen(lang: Lang, ms: number, hints: string[], captureId: string, onPhase?: (phase: RecognitionPhase) => void): Promise<CoreRecognition | string | null>;
  responseUnavailable?(): void;
  /** Stops any speech or listening in progress. */
  cancel(): void;
};

export type CheckQuestion = 'wellness' | 'contact_offer';
export type AnswerScope = { captureId: string; question: CheckQuestion };
type ManualAnswer = { button: CheckAnswer | 'cancel' } | { typed: string };
export type CheckAnswer = 'ok' | 'not_ok' | 'call_yes' | 'call_no';
export type ContactCallDecision = 'not_requested' | 'explicit_request' | 'accepted_offer' | 'declined_offer' | 'unconfirmed_offer' | 'contact_unavailable' | 'emergency_services' | 'cancelled';

export type CheckOutcome = 'ok' | 'not_ok' | 'no_response';
export type CheckResult = {
  contactCall: ContactCallDecision;
  outcome: CheckOutcome;
  urgent: boolean;
  channel: 'voice' | 'button' | 'typed' | 'none';
  attempts: number;
  confidence: number | null;
};

export const LISTEN_MS = 6000;

export type AcceptedSafetyAnswer = { question: CheckQuestion; text: string; channel: 'voice' | 'button' | 'typed' };

type Reason = 'bpm_high' | 'bpm_low' | 'spo2_low';

const TEXT = {
  en: {
    ask: (name: string, r: Reason) =>
      `${name ? `${name}, ` : ''}${
        r === 'bpm_high' ? 'your heart rate has been unusually high' : r === 'bpm_low' ? 'your heart rate has been unusually low' : 'your oxygen level has been low'
      }. Are you feeling okay? Please say yes, or no.`,
    again: "I didn't catch that. Are you feeling okay? Say yes or no.",
    ok: "Okay. I'll keep an eye on things. Drive safely.",
    notOk: 'Please pull over as soon as it is safe. If you need emergency help, call 911.',
    urgent: 'Pull over as soon as it is safe and call 911 now.',
    hints: ['yes', 'no', "I'm okay", "I'm fine", 'not okay', 'I need help', 'help', 'call 911'],
  },
  es: {
    ask: (name: string, r: Reason) =>
      `${name ? `${name}, ` : ''}${
        r === 'bpm_high' ? 'tu ritmo cardíaco ha estado inusualmente alto' : r === 'bpm_low' ? 'tu ritmo cardíaco ha estado inusualmente bajo' : 'tu nivel de oxígeno ha estado bajo'
      }. ¿Te sientes bien? Por favor di sí, o no.`,
    again: 'No te entendí. ¿Te sientes bien? Di sí o no.',
    ok: 'Muy bien. Sigo pendiente. Maneja con cuidado.',
    notOk: 'Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al 911.',
    urgent: 'Detente en cuanto sea seguro y llama al 911 ahora.',
    hints: ['sí', 'no', 'estoy bien', 'no estoy bien', 'ayuda', 'necesito ayuda', 'llama al 911'],
  },
} as const;

export class VoiceCheck {
  private buttonAnswer: ((r: ManualAnswer) => void) | null = null;
  private cancelled = false;
  private readonly checkId = ++nextCheck;
  private captureNumber = 0;
  private captureId = '';
  private consent: { captureId: string; decision: ContactCallDecision; evidence?: CoreRecognition; button?: true; typed?: true } | null = null;

  authorizesContact(result: CheckResult): boolean {
    const proof = this.consent;
    return !this.cancelled && !this.emergencyServices && !!proof
      && proof.captureId === this.captureId && proof.decision === result.contactCall
      && (proof.button === true || proof.typed === true || (!!proof.evidence && successfulFinal(proof.evidence, proof.captureId)));
  }
  /** Read-only exclusion for post-check continuation; never an authorization grant. */
  get emergencyServicesExcluded(): boolean { return this.emergencyServices; }
  private semanticTask: SemanticTask | null = null;
  private cancelSemantic() {
    try { this.semanticTask?.cancel(); } catch { /* Advisory cleanup cannot alter safety. */ }
    this.semanticTask = null;
  }
  private knownWellness: CheckResult | null = null;
  private responseIssue: 'silence' | 'unfinished' | 'failure' | 'ambiguous' = 'silence';
  private noteIssue(issue: 'silence' | 'unfinished' | 'failure' | 'ambiguous') {
    const priority = { silence: 0, unfinished: 1, failure: 2, ambiguous: 3 };
    if (priority[issue] > priority[this.responseIssue]) this.responseIssue = issue;
  }
  private emergencyServices = false;
  private question: CheckQuestion = 'wellness';
  private readonly io: VoiceIO;
  private readonly lang: Lang;
  private readonly name: string;
  private readonly options: { startSemantic?: (context: SemanticContext) => SemanticTask; reAskWaitMs?: number; contactAvailable?: boolean; onQuestion?: (q: CheckQuestion, captureId: string) => void; onAnswer?: (answer: AcceptedSafetyAnswer) => void; cancelAcknowledgment?: () => void; startAcknowledgment?: (context: AcknowledgmentContext) => void; acknowledgment?: (context: AcknowledgmentContext) => string; contactName?: string };

  constructor(io: VoiceIO, lang: Lang, name: string,
    options: { startSemantic?: (context: SemanticContext) => SemanticTask; reAskWaitMs?: number; contactAvailable?: boolean; onQuestion?: (q: CheckQuestion, captureId: string) => void; onAnswer?: (answer: AcceptedSafetyAnswer) => void; cancelAcknowledgment?: () => void; startAcknowledgment?: (context: AcknowledgmentContext) => void; acknowledgment?: (context: AcknowledgmentContext) => string; contactName?: string } = {}) {
    this.io = io;
    this.lang = lang;
    this.name = name;
    this.options = options;
  }

  /** Presentation callbacks lose ownership as soon as a manual answer wins. */
  isAwaitingResponse(captureId: string): boolean {
    return !this.cancelled && this.captureId === captureId && this.buttonAnswer !== null;
  }

  private submit(answer: ManualAnswer, scope?: AnswerScope): boolean {
    if (this.cancelled || !this.buttonAnswer || scope && (scope.captureId !== this.captureId || scope.question !== this.question)) return false;
    const resolve = this.buttonAnswer;
    this.buttonAnswer = null; // A second manual action cannot win the same question.
    resolve(answer);
    return true;
  }

  answerByButton(r: CheckAnswer, scope?: AnswerScope): boolean {
    if ((this.question === 'wellness') !== (r === 'ok' || r === 'not_ok')) return false;
    return this.submit({ button: r }, scope);
  }

  answerByText(text: string, scope: AnswerScope): boolean {
    const trimmed = text.trim();
    if (!scope || !trimmed || trimmed.length > 500) return false;
    return this.submit({ typed: trimmed }, scope);
  }

  cancel() {
    this.cancelled = true;
    this.cancelSemantic();
    this.buttonAnswer?.({ button: 'cancel' });
    this.io.cancel();
  }

  /** Cancellation revokes call consent, but never erases an answer already captured. */
  get cancelledResult(): CheckResult | null {
    return this.cancelled && this.knownWellness ? { ...this.knownWellness, contactCall: 'cancelled' } : null;
  }

  /** Each question owns its answer promise; a wellness tap cannot consent to a call. */
  private async ask(prompt: string | string[], question: CheckQuestion, hints: string[]) {
    if (this.cancelled) throw new Error('Check cancelled');
    this.question = question;
    const captureId = this.captureId = `core-${this.checkId}-${++this.captureNumber}`;
    const button = new Promise<ManualAnswer>((resolve) => {
      this.buttonAnswer = (answer) => resolve(answer);
    });
    this.options.onQuestion?.(question, captureId);
    const trace = responsivenessProbe('warning', 'VoiceCheck decision');
    trace('question opened', { captureId, question, locale: this.lang });
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        (async () => {
          if (this.cancelled || settled) return { text: null, final: false, captureId, evidence: undefined };
          this.io.prepareRecognition?.(this.lang, captureId);
          let playbackFailed = false;
          try {
            const sentences = Array.isArray(prompt) ? prompt : promptSentences(prompt);
            for (const [i, sentence] of sentences.entries()) {
              if (this.cancelled || settled) break;
              if (i) await this.io.pause?.();
              if (this.cancelled || settled) break;
              playbackFailed ||= (await this.io.speak(sentence, this.lang))?.status === 'unavailable';
              if (playbackFailed) break;
            }
          }
          catch { playbackFailed = true; }
          if (settled || this.cancelled) return { text: null, final: false, captureId, evidence: undefined };
          // The question and choices remain visible. Never accept an unheard
          // contact prompt's queued speech as consent; allow a full button window.
          if (playbackFailed) {
            if (question === 'wellness') this.noteIssue('failure');
            this.io.cancel();
            await new Promise<void>(resolve => { fallbackTimer = setTimeout(resolve, LISTEN_MS); });
            return { text: null, final: false, captureId, evidence: undefined };
          }
          if (settled || this.cancelled) return { text: null, final: false, captureId, evidence: undefined };
          let evidence: CoreRecognition | string | null;
          try { evidence = await this.io.listen(this.lang, LISTEN_MS, hints, captureId); }
          catch {
            if (question === 'wellness') this.noteIssue('failure');
            trace('listen rejected', { captureId, question, settled, cancelled: this.cancelled });
            if (!settled && !this.cancelled) {
              this.io.cancel();
              this.io.responseUnavailable?.();
              await new Promise<void>(resolve => { fallbackTimer = setTimeout(resolve, LISTEN_MS); });
            }
            evidence = null;
          }
          trace('result received', { captureId, question, settled, cancelled: this.cancelled, captureMatches: this.captureId === captureId,
            status: typeof evidence === 'object' && evidence ? evidence.status : 'missing',
            usable: typeof evidence === 'object' && evidence ? successfulFinal(evidence, captureId) : false });
          if (settled || this.cancelled || this.captureId !== captureId) return { text: null, final: false, captureId, evidence: undefined };
          if (typeof evidence === 'string' || evidence === null) return { text: null, final: false, captureId, evidence: undefined };
          if (evidence.status === 'error' || evidence.status === 'incomplete') {
            // A failed recognizer is not evidence of silence. Keep this question
            // answerable after native cleanup, without accepting partial text.
            trace('unavailable requested', { captureId, question, status: evidence.status });
            this.io.responseUnavailable?.();
            await new Promise<void>(resolve => { fallbackTimer = setTimeout(resolve, LISTEN_MS); });
            if (settled || this.cancelled) return { text: null, final: false, captureId, evidence: undefined };
          }
          const usable = successfulFinal(evidence, captureId);
          if (question === 'wellness' && !usable) {
            this.noteIssue(evidence.captureId !== captureId || evidence.status === 'error' || evidence.status === 'cancelled' || evidence.status === 'stale' ? 'failure' : evidence.transcript.trim() ? 'unfinished' : 'silence');
          }
          return { text: usable ? evidence.transcript : null, final: usable && successfulFinal(evidence, captureId), captureId, evidence };
        })(),
        button,
      ]);
      trace('answer selected', { captureId, question, channel: 'button' in answer ? 'button' : 'typed' in answer ? 'typed' : answer.final ? 'voice' : 'none', cancelled: this.cancelled });
      if ('button' in answer || 'typed' in answer) this.io.cancel();
      if (this.cancelled || ('button' in answer && answer.button === 'cancel')) throw new Error('Check cancelled');
      // Observation only, after the winning response. Never feeds back into interpretation.
      try {
        if ('button' in answer) this.options.onAnswer?.({ question, channel: 'button',
          text: this.lang === 'es' ? answer.button === 'ok' ? 'Estoy bien' : answer.button === 'not_ok' ? 'No me siento bien' : answer.button === 'call_yes' ? 'Abrir el teléfono' : 'No, gracias' : answer.button === 'ok' ? "I'm OK" : answer.button === 'not_ok' ? "I'm not OK" : answer.button === 'call_yes' ? 'Open phone interface' : 'No thanks' });
        else if ('typed' in answer) this.options.onAnswer?.({ question, channel: 'typed', text: answer.typed });
        else if (answer.final && answer.text) this.options.onAnswer?.({ question, channel: 'voice', text: answer.text });
      } catch { /* Presentation failure cannot alter safety decisions. */ }
      if ('typed' in answer) return { text: answer.typed, final: true, captureId, evidence: undefined, typed: true as const };
      return answer;
    } finally {
      trace('question closed', { captureId, question, cancelled: this.cancelled });
      settled = true;
      clearTimeout(fallbackTimer);
      this.buttonAnswer = null;
    }
  }

  private async announce(text: string) {
    if (this.cancelled) throw new Error('Check cancelled');
    let played = false;
    try {
      for (const [i, sentence] of promptSentences(text).entries()) {
        if (this.cancelled) throw Error('Check cancelled');
        if (i) await this.io.pause?.();
        if (this.cancelled) throw Error('Check cancelled');
        played = (await this.io.speak(sentence, this.lang))?.status !== 'unavailable';
        if (!played) break;
      }
    } catch { /* Visible safety copy remains available. */ }
    if (this.cancelled) throw new Error('Check cancelled');
    return played;
  }

  async run(reason: Reason): Promise<CheckResult> {
    const t = TEXT[this.lang];
    let result: CheckResult | null = null;
    let statement: string | null = null;
    let semanticContext: SemanticContext | null = null;
    let semanticChannel: 'voice' | 'typed' = 'voice';
    for (const [index, prompt] of [t.ask(this.name, reason), t.again].entries()) {
      // Scoped to this iteration only. A later attempt must re-arm the
      // statement/consent capture below: a typed-unclear manual answer during
      // an earlier attempt's wait must never suppress a later attempt's own
      // explicit contact request and its consent evidence.
      let manualDecided = false;
      const heard = await this.ask(prompt, 'wellness', [...t.hints]);
      if ('button' in heard) {
        result = { outcome: heard.button === 'ok' ? 'ok' : 'not_ok', urgent: false,
          channel: 'button', attempts: 0, confidence: null, contactCall: 'not_requested' };
      } else {
        this.emergencyServices ||= mentionsEmergencyServices(heard.text);
        const u = understand(heard.text);
        if (typeof __DEV__ !== 'undefined' && __DEV__) responsivenessProbe('warning', 'VoiceCheck semantic eligibility')('eligibility', { captureId: heard.captureId, question: 'wellness', usable: !!heard.final && !!heard.text && semanticEligible({ event: reason, language: this.lang, statement: heard.text }), outcome: u.intent });
        responsivenessProbe('warning', 'VoiceCheck interpretation')('wellness interpreted', { captureId: heard.captureId, question: 'wellness', outcome: u.intent, hasText: !!heard.text });
        if (u.intent === 'ok' || u.intent === 'not_ok') {
          // Pre-filters keep deciding instantly: no semantic task, no waiting.
          result = { outcome: u.intent, urgent: u.urgent, channel: 'typed' in heard ? 'typed' : 'voice', attempts: index + 1,
            confidence: u.confidence, contactCall: u.contactCallRequested && heard.final ? 'explicit_request' : 'not_requested' };
          if (typeof __DEV__ !== 'undefined' && __DEV__) responsivenessProbe('warning', 'VoiceCheck semantic decision')('combined decision', { captureId: heard.captureId, question: 'wellness', outcome: u.intent, source: 'pre-filter' });
        } else if (heard.final && heard.text && u.intent === 'unclear') {
          this.noteIssue('ambiguous');
          semanticContext = Object.freeze({ event: reason, language: this.lang, statement: heard.text });
          semanticChannel = 'typed' in heard ? 'typed' : 'voice';
          // The consult covers the FIRST unclear answer only: its bounded
          // pre-re-ask window owns the attempt-0 verdict. A re-asked answer
          // opens no consult and is decided by the deterministic pipeline
          // exactly as pre-branch (escalation unchanged and fail-safe).
          this.cancelSemantic();
          if (index === 0 && semanticEligible(semanticContext)) {
            try { this.semanticTask = this.options.startSemantic?.(semanticContext) ?? null; } catch { /* Clarification is unchanged. */ }
            const task = this.semanticTask;
            const settled = task?.settled;
            if (settled && index === 0) {
              // Bounded pre-re-ask window: the in-flight classification gets one
              // bounded chance (reAskWaitMs, default 2000 ms) to land before the
              // simpler second question plays. settled() is a non-destructive
              // probe — the task is still consumed exactly once afterwards; when
              // the window expires the task is cancelled and never consumed as
              // if fresh. A task without the probe (no semantic lane) gets no
              // wait here and is dead before attempt 2 opens anything new.
              // The question scope stays open and on screen during this window,
              // so per the header contract a button tap or typed answer is still
              // accepted for it and WINS IMMEDIATELY: the window ends at once, the
              // in-flight verdict is cancelled and never applied.
              const manual = new Promise<ManualAnswer>((resolve) => { this.buttonAnswer = resolve; });
              let won: ManualAnswer | null = null;
              manual.then(answer => { won = answer; });
              try {
                // Flush already-queued microtask work before any timer-based poll:
                // a lane that resolves without timers (mock/immediate adapters)
                // records its verdict within that drain, so the combined decision
                // lands in the same event-loop turn as the answer itself. Each hop
                // lets the queued prefix drain, so the cap just bounds the flush;
                // everything slower is polled below.
                for (let hops = 0; hops < 64 && !settled() && won === null && !this.cancelled; hops++) await Promise.resolve();
                const ceiling = Math.max(0, this.options.reAskWaitMs ?? 2000);
                for (let waited = 0; !settled() && waited < ceiling && !this.cancelled && won === null; waited += 50) {
                  await Promise.race([
                    new Promise<void>(resolve => { setTimeout(resolve, Math.min(50, ceiling - waited)); }),
                    manual.then(answer => { won = answer; }),
                  ]);
                }
              } finally { this.buttonAnswer = null; }
              // `winner` is read fresh with an explicit annotation to defeat
              // control-flow narrowing: `won` is only ever assigned from the
              // manual-answer callback, so the flow thinks it can only be null.
              const winner = won as ManualAnswer | null;
              if (winner === null || this.cancelled || ('button' in winner && winner.button === 'cancel')) {
                let advice: SemanticResult | null = null;
                try { advice = this.semanticTask?.get() ?? null; } catch { /* Conservative fallback. */ }
                this.cancelSemantic();
                const combined = semanticCombinedDecision(semanticContext, advice);
                if (typeof __DEV__ !== 'undefined' && __DEV__) responsivenessProbe('warning', 'VoiceCheck semantic decision')('combined decision', { captureId: heard.captureId, question: 'wellness', outcome: combined.intent, decisionSource: combined.source, source: combined.source === 'gemma' ? 'gemma-primary' : 'fallback-deterministic' });
                if (combined.intent !== 'unclear') {
                  result = { outcome: combined.intent, urgent: false, channel: semanticChannel, attempts: index + 1,
                    confidence: null, contactCall: 'not_requested' };
                }
              } else {
                // The tap wins; the semantic verdict is discarded without ever
                // being read (cancel first — a consumed task can never be treated
                // as fresh advice later).
                this.cancelSemantic();
                manualDecided = true;
                let winText: string;
                let decided: CheckResult | null;
                if ('button' in winner) {
                  winText = this.lang === 'es' ? winner.button === 'ok' ? 'Estoy bien' : 'No me siento bien' : winner.button === 'ok' ? "I'm OK" : "I'm not OK";
                  decided = { outcome: winner.button === 'ok' ? 'ok' : 'not_ok', urgent: false,
                    channel: 'button', attempts: index + 1, confidence: null, contactCall: 'not_requested' };
                } else {
                  const typedUnderstood = understand(winner.typed);
                  this.emergencyServices ||= mentionsEmergencyServices(winner.typed);
                  statement = winner.typed;
                  winText = winner.typed;
                  if (typedUnderstood.contactCallRequested) this.consent = { captureId: this.captureId, decision: 'explicit_request', typed: true as const };
                  decided = typedUnderstood.intent === 'ok' || typedUnderstood.intent === 'not_ok'
                    ? { outcome: typedUnderstood.intent, urgent: typedUnderstood.urgent, channel: 'typed', attempts: index + 1,
                      confidence: typedUnderstood.confidence, contactCall: typedUnderstood.contactCallRequested ? 'explicit_request' : 'not_requested' }
                    : null;   // a typed answer the rules still find unclear falls through to the re-ask
                }
                result = decided;
                if (typeof __DEV__ !== 'undefined' && __DEV__ && decided) responsivenessProbe('warning', 'VoiceCheck semantic decision')('combined decision', { captureId: this.captureId, question: 'wellness', outcome: decided.outcome, source: 'pre-filter' });
                try { this.options.onAnswer?.({ question: 'wellness', channel: decided?.channel === 'button' ? 'button' : 'typed', text: winText }); } catch { /* Presentation failure cannot alter safety decisions. */ }
              }
            }
          }
        }
      }
      if (result) {
        if (!manualDecided) {
          // A manual win during the wait already decided statement/consent from
          // its own channel; the voice answer it beat must not decide instead.
          if ('text' in heard && heard.final) statement = heard.text;
          if (result.contactCall === 'explicit_request' && 'text' in heard) this.consent = { captureId: heard.captureId, decision: 'explicit_request', ...('typed' in heard ? { typed: true as const } : { evidence: heard.evidence }) };
        }
        break;
      }
    }
    // Attempt-2 answers open no semantic consult and no post-loop consume
    // block exists: the consult is scoped to the first unclear answer's
    // bounded wait, so a re-asked answer falls to the deterministic pipeline
    // exactly as pre-branch (escalation unchanged, fail-safe).
    this.cancelSemantic();
    this.knownWellness = result;
    if (!result) {
      const prefix = this.lang === 'en'
        ? { silence: 'No answer was confirmed.', unfinished: 'Speech was detected, but no final response was confirmed.', failure: 'Voice input was unavailable. No answer was confirmed.', ambiguous: "I couldn't understand your answer." }[this.responseIssue]
        : { silence: 'No se confirmó ninguna respuesta.', unfinished: 'Se detectó voz, pero no se confirmó una respuesta final.', failure: 'La entrada de voz no estuvo disponible. No se confirmó una respuesta.', ambiguous: 'No pude entender tu respuesta.' }[this.responseIssue];
      if (typeof __DEV__ !== 'undefined' && __DEV__) responsivenessProbe('warning', 'VoiceCheck unresolved response')('classified', { captureId: this.captureId, question: 'wellness', reason: this.responseIssue });
      await this.announce(`${prefix} ${t.notOk}`);
      return { outcome: 'no_response', urgent: false, channel: 'none', attempts: 2,
        confidence: null, contactCall: 'not_requested' };
    }
    if (result.outcome === 'ok') {
      if (statement && /\b(long day|rough day|dia largo|día largo|día difícil|dia dificil)\b/i.test(statement)) {
        await this.announce(this.lang === 'es' ? 'Me alegra que te sientas bien. Parece que ha sido un día largo.' : "Glad you're feeling okay. It sounds like a long day.");
      }
      await this.announce(t.ok);
      return result;
    }
    const context = acknowledgmentContext(reason, this.lang, statement);
    const canAcknowledge = !result.urgent && !this.emergencyServices && result.contactCall !== 'explicit_request'
      && !!this.options.contactAvailable && !!this.options.acknowledgment;
    if (canAcknowledge) {
      try { this.options.startAcknowledgment?.(context); } catch { /* Fixed fallback. */ }
    }
    // Inference runs during immediate mandatory guidance, never as a blocking step.
    const planTrace = typeof __DEV__ !== 'undefined' && __DEV__ ? responsivenessProbe('warning', 'Sensi sentence response plan') : () => {};
    const guidance = safetyGuidancePlan(this.lang, result.urgent);
    let guidancePlayed = true;
    for (const [i, segment] of guidance.entries()) {
      if (i) await this.io.pause?.();
      if (typeof __DEV__ !== 'undefined' && __DEV__) planTrace(segment.role, { stage: segment.role, captureId: this.captureId, locale: this.lang });
      guidancePlayed = await this.announce(segment.text) && guidancePlayed;
    }
    let empathy = '';
    if (canAcknowledge && guidancePlayed) {
      let acknowledgment: string | undefined;
      try { acknowledgment = this.options.acknowledgment?.(context); } catch { /* Fixed fallback. */ }
      empathy = approvedAcknowledgment(acknowledgment, this.lang, context);
    }
    if (this.cancelled) throw new Error('Check cancelled');
    if (this.emergencyServices) return { ...result, contactCall: 'emergency_services' };
    if (!this.options.contactAvailable) return { ...result, contactCall: 'contact_unavailable' };
    if (result.contactCall === 'explicit_request') return result;

    const contactName = this.options.contactName?.trim();
    const label = contactName && contactName.length <= 60 && /^[\p{L}\p{M} .'’-]+$/u.test(contactName) ? contactName : null;
    const offer = this.lang === 'en'
      ? label ? `Would you like me to call ${label}?` : 'Would you like me to call your emergency contact?'
      : label ? `¿Quieres que llame a ${label}?` : '¿Quieres que llame a tu contacto de emergencia?';
    const retry = this.lang === 'en'
      ? `I didn't catch that. ${offer}`
      : `No te entendí. ${offer}`;
    if (!guidancePlayed) { try { this.options.cancelAcknowledgment?.(); } catch { /* Presentation only. */ } }
    const responsePlan = completeSafetyResponsePlan(guidance, empathy, offer);
    for (const segment of responsePlan.slice(guidance.length, -1)) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) planTrace('acknowledgment', { stage: 'acknowledgment', captureId: this.captureId, locale: this.lang });
      await this.io.pause?.(); await this.announce(segment.text);
    }
    await this.io.pause?.();
    const response = [responsePlan.at(-1)!.text];
    if (typeof __DEV__ !== 'undefined' && __DEV__) planTrace('contact_offer', { stage: 'contact_offer', captureId: this.captureId, locale: this.lang });
    if (typeof __DEV__ !== 'undefined' && __DEV__) responsivenessProbe('warning', 'Sensi response composition')('coordinated response', { captureId: this.captureId, question: 'contact_offer', source: 'sentence_plan', locale: this.lang });
    for (const prompt of [response, retry]) {
      let heard: Awaited<ReturnType<VoiceCheck['ask']>>;
      try {
        heard = await this.ask(prompt, 'contact_offer', ['yes please', 'go ahead', 'no thanks', 'do not call', 'sí', 'no']);
      } catch (error) {
        if (this.cancelled) throw error;
        // An unavailable follow-up must not erase the driver's NOT OK answer.
        return { ...result, contactCall: 'unconfirmed_offer' };
      }
      if ('text' in heard) this.emergencyServices ||= mentionsEmergencyServices(heard.text);
      // End this call branch; a later yes or button tap cannot undo the exclusion.
      if (this.emergencyServices) return { ...result, contactCall: 'emergency_services' };
      const answer = 'button' in heard ? (heard.button === 'call_yes' ? 'yes' : 'no') : understandCallAnswer(heard.text);
      if (answer === 'yes' && ('button' in heard || heard.final)) {
        this.consent = { captureId: this.captureId, decision: 'accepted_offer', ...('button' in heard ? { button: true as const } : 'typed' in heard ? { typed: true as const } : { evidence: heard.evidence }) };
        return { ...result, contactCall: 'accepted_offer' };
      }
      if (answer === 'no') return { ...result, contactCall: 'declined_offer' };
    }
    return { ...result, contactCall: 'unconfirmed_offer' };
  }
}
