/**
 * The spoken "Are you feeling okay?" check, run when the flag engine confirms
 * an emergency. It reacts to a flag; it never looks at the vitals itself.
 *
 *   speak prompt → listen (6 s) → understand
 *     ok      → reassure, done (outcome ok)
 *     not_ok  → safety instructions, then offer a saved-contact phone handoff
 *     explicit contact request → skip the offer; caller handles the handoff
 *     unclear or silence → ask once more, simpler → listen (6 s)
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
import { understand, understandCallAnswer, mentionsEmergencyServices } from './intent.ts';

import { approvedAcknowledgment } from '../assistant/safetyAcknowledgment.ts';
import { successfulFinal, type CoreRecognition } from './coreRecognition.ts';

let nextCheck = 0;

export type Lang = 'en' | 'es';

export type VoiceIO = {
  speak(text: string, lang: Lang): Promise<void | { status: 'unavailable' }>;
  /** Only scoped successful final evidence is accepted; legacy strings are unconfirmed. */
  listen(lang: Lang, ms: number, hints: string[], captureId: string): Promise<CoreRecognition | string | null>;
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
    again: "Sorry, I didn't catch that. Are you okay? Say yes if you're fine, or no if you need help.",
    ok: "Okay. I'll keep an eye on things. Drive safely.",
    notOk: 'Please pull over as soon as it is safe. If you need emergency help, call nine one one.',
    urgent: 'Pull over as soon as it is safe and call nine one one now.',
    none: "I didn't hear an answer. Please pull over when it is safe. This has been recorded as an emergency.",
    hints: ['yes', 'no', "I'm okay", "I'm fine", 'not okay', 'I need help', 'help', 'call 911'],
  },
  es: {
    ask: (name: string, r: Reason) =>
      `${name ? `${name}, ` : ''}${
        r === 'bpm_high' ? 'tu ritmo cardíaco ha estado inusualmente alto' : r === 'bpm_low' ? 'tu ritmo cardíaco ha estado inusualmente bajo' : 'tu nivel de oxígeno ha estado bajo'
      }. ¿Te sientes bien? Por favor di sí, o no.`,
    again: 'Perdón, no te entendí. ¿Estás bien? Di sí si estás bien, o no si necesitas ayuda.',
    ok: 'Muy bien. Sigo pendiente. Maneja con cuidado.',
    notOk: 'Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al nueve uno uno.',
    urgent: 'Detente en cuanto sea seguro y llama al nueve uno uno ahora.',
    none: 'No escuché respuesta. Por favor detente cuando sea seguro. Esto quedó registrado como una emergencia.',
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
  private knownWellness: CheckResult | null = null;
  private emergencyServices = false;
  private question: CheckQuestion = 'wellness';
  private readonly io: VoiceIO;
  private readonly lang: Lang;
  private readonly name: string;
  private readonly options: { contactAvailable?: boolean; onQuestion?: (q: CheckQuestion, captureId: string) => void; onAnswer?: (answer: AcceptedSafetyAnswer) => void; acknowledgment?: () => string; contactName?: string };

  constructor(io: VoiceIO, lang: Lang, name: string,
    options: { contactAvailable?: boolean; onQuestion?: (q: CheckQuestion, captureId: string) => void; onAnswer?: (answer: AcceptedSafetyAnswer) => void; acknowledgment?: () => string; contactName?: string } = {}) {
    this.io = io;
    this.lang = lang;
    this.name = name;
    this.options = options;
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
    this.buttonAnswer?.({ button: 'cancel' });
    this.io.cancel();
  }

  /** Cancellation revokes call consent, but never erases an answer already captured. */
  get cancelledResult(): CheckResult | null {
    return this.cancelled && this.knownWellness ? { ...this.knownWellness, contactCall: 'cancelled' } : null;
  }

  /** Each question owns its answer promise; a wellness tap cannot consent to a call. */
  private async ask(prompt: string, question: CheckQuestion, hints: string[]) {
    if (this.cancelled) throw new Error('Check cancelled');
    this.question = question;
    const captureId = this.captureId = `core-${this.checkId}-${++this.captureNumber}`;
    const button = new Promise<ManualAnswer>((resolve) => {
      this.buttonAnswer = (answer) => resolve(answer);
    });
    this.options.onQuestion?.(question, captureId);
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        (async () => {
          if (this.cancelled || settled) return { text: null, final: false, captureId, evidence: undefined };
          let playbackFailed = false;
          try { playbackFailed = (await this.io.speak(prompt, this.lang))?.status === 'unavailable'; }
          catch { playbackFailed = true; }
          if (settled || this.cancelled) return { text: null, final: false, captureId, evidence: undefined };
          // The question and choices remain visible. Never accept an unheard
          // contact prompt's queued speech as consent; allow a full button window.
          if (playbackFailed) {
            this.io.cancel();
            await new Promise<void>(resolve => { fallbackTimer = setTimeout(resolve, LISTEN_MS); });
            return { text: null, final: false, captureId, evidence: undefined };
          }
          if (settled || this.cancelled) return { text: null, final: false, captureId, evidence: undefined };
          let evidence: CoreRecognition | string | null;
          try { evidence = await this.io.listen(this.lang, LISTEN_MS, hints, captureId); }
          catch {
            if (!settled && !this.cancelled) {
              this.io.cancel();
              await new Promise<void>(resolve => { fallbackTimer = setTimeout(resolve, LISTEN_MS); });
            }
            evidence = null;
          }
          if (settled || this.cancelled || this.captureId !== captureId) return { text: null, final: false, captureId, evidence: undefined };
          if (typeof evidence === 'string' || evidence === null) return { text: null, final: false, captureId, evidence: undefined };
          const usable = successfulFinal(evidence, captureId);
          return { text: usable ? evidence.transcript : null, final: usable && successfulFinal(evidence, captureId), captureId, evidence };
        })(),
        button,
      ]);
      if ('button' in answer || 'typed' in answer) this.io.cancel();
      if (this.cancelled || ('button' in answer && answer.button === 'cancel')) throw new Error('Check cancelled');
      // Observation only, after the winning response. Never feeds back into interpretation.
      try {
        if ('button' in answer) this.options.onAnswer?.({ question, channel: 'button',
          text: answer.button === 'ok' ? "I'm OK" : answer.button === 'not_ok' ? "I'm not OK" : answer.button === 'call_yes' ? 'Open phone interface' : 'No thanks' });
        else if ('typed' in answer) this.options.onAnswer?.({ question, channel: 'typed', text: answer.typed });
        else if (answer.final && answer.text) this.options.onAnswer?.({ question, channel: 'voice', text: answer.text });
      } catch { /* Presentation failure cannot alter safety decisions. */ }
      if ('typed' in answer) return { text: answer.typed, final: true, captureId, evidence: undefined, typed: true as const };
      return answer;
    } finally {
      settled = true;
      clearTimeout(fallbackTimer);
      this.buttonAnswer = null;
    }
  }

  private async announce(text: string) {
    if (this.cancelled) throw new Error('Check cancelled');
    try { await this.io.speak(text, this.lang); } catch { /* Visible safety copy remains available. */ }
    if (this.cancelled) throw new Error('Check cancelled');
  }

  async run(reason: Reason): Promise<CheckResult> {
    const t = TEXT[this.lang];
    let result: CheckResult | null = null;
    for (const [index, prompt] of [t.ask(this.name, reason), t.again].entries()) {
      const heard = await this.ask(prompt, 'wellness', [...t.hints]);
      if ('button' in heard) {
        result = { outcome: heard.button === 'ok' ? 'ok' : 'not_ok', urgent: false,
          channel: 'button', attempts: 0, confidence: null, contactCall: 'not_requested' };
      } else {
        this.emergencyServices ||= mentionsEmergencyServices(heard.text);
        const u = understand(heard.text);
        if (u.intent === 'ok' || u.intent === 'not_ok') {
          result = { outcome: u.intent, urgent: u.urgent, channel: 'typed' in heard ? 'typed' : 'voice', attempts: index + 1,
            confidence: u.confidence, contactCall: u.contactCallRequested && heard.final ? 'explicit_request' : 'not_requested' };
        }
      }
      if (result) {
        if (result.contactCall === 'explicit_request' && 'text' in heard) this.consent = { captureId: heard.captureId, decision: 'explicit_request', ...('typed' in heard ? { typed: true as const } : { evidence: heard.evidence }) };
        break;
      }
    }
    this.knownWellness = result;
    if (!result) {
      await this.announce(t.none);
      return { outcome: 'no_response', urgent: false, channel: 'none', attempts: 2,
        confidence: null, contactCall: 'not_requested' };
    }
    if (result.outcome === 'ok') {
      await this.announce(t.ok);
      return result;
    }
    let acknowledgment: string | undefined;
    try { acknowledgment = this.options.acknowledgment?.(); } catch { /* Deterministic fallback. */ }
    const empathy = this.options.acknowledgment ? approvedAcknowledgment(acknowledgment, this.lang) : '';
    await this.announce(result.urgent ? `${t.urgent}${empathy ? ' ' + empathy : ''}` : `${empathy ? empathy + ' ' : ''}${t.notOk}`);
    if (this.cancelled) throw new Error('Check cancelled');
    if (this.emergencyServices) return { ...result, contactCall: 'emergency_services' };
    if (!this.options.contactAvailable) return { ...result, contactCall: 'contact_unavailable' };
    if (result.contactCall === 'explicit_request') return result;

    const contactName = this.options.contactName?.trim();
    const label = contactName && contactName.length <= 60 && /^[\p{L}\p{M} .'’-]+$/u.test(contactName) ? contactName : null;
    const offer = this.lang === 'en'
      ? label ? `Would you like me to call ${label}?` : 'Would you like me to call your emergency contact?'
      : '¿Quieres que llame a tu contacto de emergencia?';
    const retry = this.lang === 'en'
      ? `I didn't catch that. ${offer}`
      : 'No te entendí. ¿Quieres que llame a tu contacto de emergencia?';
    for (const prompt of [offer, retry]) {
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
