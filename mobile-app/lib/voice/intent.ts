/**
 * Understands the driver's spoken answer to "Are you feeling okay?".
 *
 * Runs entirely on the phone: a small logistic-regression model (≈120 KB of
 * weights, trained by tools/intent/train.py on ~4.7k English + Spanish
 * phrasings) behind a rule layer that is deliberately biased toward safety:
 *
 *   1. URGENT words ("help", "911", "ambulance", "chest", "can't breathe",
 *      "ayuda", …) → not_ok + urgent, whatever the model says, unless the
 *      help is explicitly negated ("I don't need help").
 *   2. Explicit negation of being fine ("not okay", "I don't feel well",
 *      "no estoy bien") → not_ok.
 *   3. Model: not_ok if P(not_ok) ≥ 0.5; ok only if P(ok) ≥ 0.75 — anything
 *      in between is "unclear" and the driver is asked again. A wrong "ok"
 *      is the one mistake that matters, so "ok" needs the most evidence.
 *
 * This module never sees vitals. It only interprets words, and only when the
 * flag engine has already decided to ask (see lib/voice/voiceCheck.ts).
 *
 * The featuriser must stay identical to tools/intent/train.py (parity test in
 * tests/intent.test.ts).
 */
import model from './intentModel.ts';

export type Intent = 'ok' | 'not_ok' | 'unclear' | 'silent';
export type Understood = {
  contactCallRequested: boolean;
  intent: Intent;
  urgent: boolean;
  confidence: number;
  probs: [number, number, number] | null; // ok, not_ok, unclear
  reason: 'empty' | 'urgent-keyword' | 'negation' | 'model';
};

const DIM: number = model.dim;
const WEIGHTS = new Map<number, number[]>();
for (const row of model.weights as number[][]) WEIGHTS.set(row[0]!, row.slice(1));

// Accents removed so "sí"/"si" and "está"/"esta" match (as Python's NFD + Mn strip).
const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ñ: 'n', ç: 'c',
};

export function normalise(text: string): string {
  let out = '';
  for (const ch0 of text.toLowerCase().replace(/’/g, "'")) {
    const ch = ACCENTS[ch0] ?? ch0;
    const isAlnum = /[a-z0-9]/.test(ch) || (ch.length === 1 && ch.charCodeAt(0) > 127 && ch.toLowerCase() !== ch.toUpperCase());
    out += isAlnum || ch === "'" ? ch : ' ';
  }
  return out.split(' ').filter(Boolean).join(' ');
}

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** 32-bit FNV-1a over UTF-8 bytes (Math.imul keeps the multiply in 32 bits). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function features(text: string): Map<number, number> {
  const t = normalise(text);
  const words = t ? t.split(' ') : [];
  const keys = words.map((w) => `w:${w}`);
  for (let i = 0; i + 1 < words.length; i += 1) keys.push(`b:${words[i]}_${words[i + 1]}`);
  const padded = ` ${t} `;
  const chars = Array.from(padded);
  for (const n of [3, 4, 5]) {
    for (let i = 0; i + n <= chars.length; i += 1) keys.push(`c:${chars.slice(i, i + n).join('')}`);
  }
  const idx = new Set(keys.map((k) => fnv1a(k) % DIM));
  const v = idx.size ? 1 / Math.sqrt(idx.size) : 0;
  return new Map([...idx].map((i) => [i, v]));
}

export function modelProbs(text: string): [number, number, number] {
  const z = [...(model.bias as number[])];
  for (const [i, v] of features(text)) {
    const w = WEIGHTS.get(i);
    if (w) for (let k = 0; k < 3; k += 1) z[k]! += v * w[k]!;
  }
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s) as [number, number, number];
}

const URGENT =
  /\b(help|911|nine one one|ambulance|emergency|sos|hospital|doctor|chest|breathe|breathing|heart attack|stroke|pass out|passing out|faint|dying|ayuda|ayudame|auxilio|ambulancia|emergencia|pecho|respirar|infarto|desmay\w*|hospital|medico)\b/;
const NEGATED_HELP =
  /\b(don't|dont|do not|no) need (any )?(help|a doctor|an ambulance)\b|\bno help needed\b|\bnot an emergency\b|\bno emergency\b|\bno necesito (ayuda|nada|un medico)\b|\bdon't call\b|\bno llames\b/;
const NEGATED_FINE =
  /\b(not|n't) (really |feeling |doing |so |too |that |very )?(ok|okay|fine|good|well|great|alright|all right|right)\b|\bdon't feel (so |too |very )?(good|well|right|ok|okay|fine)\b|\bno (estoy|me siento|me encuentro) (nada |muy |tan |para nada )?bien\b|\bnada bien\b/;

const SYMPTOM =
  /\b(dizzy|sick|pain|hurts?|faint|nause\w*|numb|weak|blurry|racing|pounding|tired|sleepy|shaking|sweating|scared|mareado|mareada|dolor|duele|mal|debil|nauseas|miedo)\b/;

export const OK_MIN = 0.75;
export const NOT_OK_MIN = 0.5;

function wellness(transcript: string | null | undefined): Omit<Understood, 'contactCallRequested'> {
  const t = normalise(transcript ?? '');
  if (!t) return { intent: 'silent', urgent: false, confidence: 1, probs: null, reason: 'empty' };
  const probs = modelProbs(t);
  const negatedHelp = NEGATED_HELP.test(t);
  if (URGENT.test(t) && !negatedHelp) {
    return { intent: 'not_ok', urgent: true, confidence: 1, probs, reason: 'urgent-keyword' };
  }
  // "No, I don't need help" answers "are you okay?" with a yes -- unless the
  // driver also names a symptom ("I don't need help, just dizzy").
  if (negatedHelp && !SYMPTOM.test(t) && !NEGATED_FINE.test(t)) {
    return { intent: 'ok', urgent: false, confidence: 0.8, probs, reason: 'negation' };
  }
  if (NEGATED_FINE.test(t) && !/\bnot bad\b/.test(t)) {
    return { intent: 'not_ok', urgent: false, confidence: Math.max(probs[1], 0.9), probs, reason: 'negation' };
  }
  if (probs[1] >= NOT_OK_MIN) return { intent: 'not_ok', urgent: false, confidence: probs[1], probs, reason: 'model' };
  if (probs[0] >= OK_MIN) return { intent: 'ok', urgent: false, confidence: probs[0], probs, reason: 'model' };
  return { intent: 'unclear', urgent: false, confidence: Math.max(...probs), probs, reason: 'model' };
}

/** Call consent is contextual and rule-based, never a wellness probability. */
export type CallAnswer = 'yes' | 'no' | 'unclear' | 'silent';
const CALL_REFUSAL = /\b(don't|dont|do not|never|not now|rather not|no need|no thanks|no thank you|don't want|dont want|do not want|no quiero|no llames|no llamar|ahora no)\b/;
const UNCERTAIN_CALL = /\b(maybe|perhaps|if|what if|might|possibly|unless|not sure|unsure|quiza|quizas|tal vez)\b/;
const OTHER_DESTINATION = /\b(911|nine one one|112|999|police|ambulance|taxi|uber|policia|ambulancia)\b/;

/** A service destination excludes automatic contact handoff for the whole dialogue.
 * Conservatively include mentions/negations: these must never become contact consent. */
export function mentionsEmergencyServices(transcript: string | null | undefined): boolean {
  return /\b(911|9 1 1|nine one one|nine eleven|112|999|emergency services|police|ambulance|policia|ambulancia|servicios de emergencia|nueve uno uno)\b/.test(normalise(transcript ?? ''));
}

export function explicitContactCallRequest(transcript: string): boolean {
  const t = normalise(transcript).replace(/^no (?=please call\b)/, '');
  if (CALL_REFUSAL.test(t) || UNCERTAIN_CALL.test(t) || OTHER_DESTINATION.test(t) || /\bno\b/.test(t)) return false;
  return /^(?:please |(?:can|could|would) you (?:please )?|i need you to |i want you to )?call (?:my (?:emergency contact|contact|mom|mother|dad|father|wife|husband|partner)|them)(?: please| now| for me)?$/.test(t)
    || /^(?:por favor )?(?:llama|llame) (?:a )?(?:mi (?:contacto de emergencia|contacto|mama|papa|esposa|esposo)|ellos)(?: por favor)?$/.test(t);
}

export function understandCallAnswer(transcript: string | null | undefined): CallAnswer {
  const t = normalise(transcript ?? '');
  if (!t) return 'silent';
  if (OTHER_DESTINATION.test(t)) return 'unclear';
  if (CALL_REFUSAL.test(t) || /^(?:no|no please|no por favor)$/.test(t)) return 'no';
  if (UNCERTAIN_CALL.test(t)) return 'unclear';
  if (explicitContactCallRequest(t)) return 'yes';
  if (/^(?:yes|yeah|yep|sure|okay|ok|absolutely|si|claro)(?: please| por favor| go ahead| do it)?$/.test(t)
    || /^(?:please do|go ahead|please go ahead|do it|make the call|that would help|yes that would help|yes i would|sure please do|adelante|hazlo)$/.test(t)) return 'yes';
  return 'unclear';
}

export function understand(transcript: string | null | undefined): Understood {
  const result = wellness(transcript);
  const contactCallRequested = explicitContactCallRequest(transcript ?? '');
  return { ...result, intent: contactCallRequested ? 'not_ok' : result.intent, contactCallRequested };
}
