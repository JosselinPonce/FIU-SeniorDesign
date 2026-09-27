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

export type Lang = 'en' | 'es';

export type VoiceIO = {
  speak(text: string, lang: Lang): Promise<void>;
  /** Resolves with what was heard, or null if nothing (or recognition is unavailable). */
  listen(lang: Lang, ms: number, hints: string[]): Promise<string | null>;
  /** Stops any speech or listening in progress. */
  cancel(): void;
};

export type CheckQuestion = 'wellness' | 'contact_offer';
export type CheckAnswer = 'ok' | 'not_ok' | 'call_yes' | 'call_no';
export type ContactCallDecision = 'not_requested' | 'explicit_request' | 'accepted_offer' | 'declined_offer' | 'unconfirmed_offer' | 'contact_unavailable' | 'emergency_services' | 'cancelled';

export type CheckOutcome = 'ok' | 'not_ok' | 'no_response';
export type CheckResult = {
  contactCall: ContactCallDecision;
  outcome: CheckOutcome;
  urgent: boolean;
  channel: 'voice' | 'button' | 'none';
  attempts: number;
  confidence: number | null;
};

export const LISTEN_MS = 6000;

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
  private buttonAnswer: ((r: CheckAnswer | 'cancel') => void) | null = null;
  private cancelled = false;
  private knownWellness: CheckResult | null = null;
  private emergencyServices = false;
  private question: CheckQuestion = 'wellness';
  private readonly io: VoiceIO;
  private readonly lang: Lang;
  private readonly name: string;
  private readonly options: { contactAvailable?: boolean; onQuestion?: (q: CheckQuestion) => void };

  constructor(io: VoiceIO, lang: Lang, name: string,
    options: { contactAvailable?: boolean; onQuestion?: (q: CheckQuestion) => void } = {}) {
    this.io = io;
    this.lang = lang;
    this.name = name;
    this.options = options;
  }

  answerByButton(r: CheckAnswer) {
    if ((this.question === 'wellness') === (r === 'ok' || r === 'not_ok')) this.buttonAnswer?.(r);
  }

  cancel() {
    this.cancelled = true;
    this.buttonAnswer?.('cancel');
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
    const button = new Promise<{ button: CheckAnswer | 'cancel' }>((resolve) => {
      this.buttonAnswer = (answer) => resolve({ button: answer });
    });
    this.options.onQuestion?.(question);
    let settled = false;
    try {
      const answer = await Promise.race([
        (async () => {
          await this.io.speak(prompt, this.lang);
          if (settled || this.cancelled) return { text: null };
          return { text: await this.io.listen(this.lang, LISTEN_MS, hints) };
        })(),
        button,
      ]);
      if ('button' in answer) this.io.cancel();
      if (this.cancelled || ('button' in answer && answer.button === 'cancel')) throw new Error('Check cancelled');
      return answer;
    } finally {
      settled = true;
      this.buttonAnswer = null;
    }
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
          result = { outcome: u.intent, urgent: u.urgent, channel: 'voice', attempts: index + 1,
            confidence: u.confidence, contactCall: u.contactCallRequested ? 'explicit_request' : 'not_requested' };
        }
      }
      if (result) break;
    }
    this.knownWellness = result;
    if (!result) {
      await this.io.speak(t.none, this.lang);
      return { outcome: 'no_response', urgent: false, channel: 'none', attempts: 2,
        confidence: null, contactCall: 'not_requested' };
    }
    if (result.outcome === 'ok') {
      await this.io.speak(t.ok, this.lang);
      return result;
    }
    await this.io.speak(result.urgent ? t.urgent : t.notOk, this.lang).catch(() => undefined);
    if (this.cancelled) throw new Error('Check cancelled');
    if (this.emergencyServices) return { ...result, contactCall: 'emergency_services' };
    if (!this.options.contactAvailable) return { ...result, contactCall: 'contact_unavailable' };
    if (result.contactCall === 'explicit_request') return result;

    const offer = this.lang === 'en'
      ? 'Would you like me to call your emergency contact?'
      : '¿Quieres que llame a tu contacto de emergencia?';
    const retry = this.lang === 'en'
      ? "I didn't catch that. Would you like me to call your emergency contact?"
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
      if (answer === 'yes') return { ...result, contactCall: 'accepted_offer' };
      if (answer === 'no') return { ...result, contactCall: 'declined_offer' };
    }
    return { ...result, contactCall: 'unconfirmed_offer' };
  }
}
