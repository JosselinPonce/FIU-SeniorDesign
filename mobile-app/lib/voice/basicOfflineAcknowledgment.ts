import { utteranceFeatures } from '../../supabase/functions/_shared/contextualAcknowledgment.ts';
import { HEDGES, drowsinessEvidence, SPANISH_LONG_DAY, statementSegments, symptomScan, urgentPhysicalEvidence } from './symptomLexicon.ts';
import { clearWellnessAffirmation } from './wellnessLanguage.ts';
import type { Lang } from './voiceCheck.ts';

/** Revert the VoiceCheck presentation policy independently of provider settings. */
export const VOICECHECK_BASIC_OFFLINE = true;

const longDay = {
  en: /\b(?:i )?just had a (long|rough) day$/,
  es: new RegExp(`\\b${SPANISH_LONG_DAY}$`),
};
const additional = {
  en: {
    chest: /^(?:(?:i (?:have|feel)|i'm (?:having|feeling)) (?:some )?(?:chest pain|pain in my chest)|my chest (?:hurts|is hurting))$/,
    breathing: /^(?:i (?:can't|cant|cannot) (?:breathe(?: well)?|catch my breath)|i(?:'m| am) short of breath|i(?: have|'m having) (?:trouble|difficulty) breathing)$/,
    faintness: /^(?:i (?:might|may|could) (?:faint|pass out)|i feel like i (?:might|could|may|am going to) (?:faint|pass out)|i(?:'m| am) about to (?:faint|pass out))$/,
    fear: /^(?:i(?:'m| am| feel) (?:really |very |a little )?(?:scared|afraid|frightened))$/,
    stress: /^(?:i(?:'m| am| feel) (?:(?:really |very |a little )?stressed(?: out)?|under (?:a lot of|severe) stress))$/,
    unwell: /^(?:i(?:'m| am) not feeling (?:very )?well|i (?:don't|dont|do not) feel (?:very )?well)$/,
  },
  es: {
    chest: /^(?:me (?:duele|esta doliendo|sigue doliendo) el pecho|(?:tengo|siento) dolor (?:en el|de) pecho)$/,
    breathing: /^(?:no puedo respirar(?: bien)?|me falta el aire|(?:tengo dificultad para|me cuesta) respirar)$/,
    faintness: /^(?:creo que me voy a desmayar|siento que me voy a desmayar|me voy a desmayar|podria desmayarme)$/,
    fear: /^(?:(?:tengo|siento) (?:mucho |un poco de )?miedo|(?:estoy|me siento) (?:muy |un poco )?asustad[oa])$/,
    stress: /^(?:(?:estoy|me siento) (?:muy |un poco )?(?:estresad[oa]|agobiad[oa])|tengo mucho estres|estoy bajo mucho estres)$/,
    unwell: /^no me siento (?:muy )?bien$/,
  },
};

const replies = {
  en: {
    dizzy: "I'm sorry you're feeling dizzy.", lightheaded: "I'm sorry you're feeling lightheaded.",
    chest: "I'm sorry you're experiencing chest pain.", breathing: "I'm sorry it's hard to breathe.",
    faintness: 'I hear that you might faint.', weak: "I'm sorry you're feeling weak.",
    tired: "I hear how tired you feel.", sleepy: "I hear you're feeling sleepy.",
    drowsy: "I'm concerned you're struggling to stay awake.",
    stress: "I'm sorry you're feeling stressed.", fear: 'I understand this may feel frightening, and I’m here to help.',
    worried: "I hear you're worried.", nervous: "I hear you're feeling nervous.",
    unwell: "I'm sorry you're not feeling well.", sick: "I'm sorry you're feeling sick.",
    shaky: "I'm sorry you're feeling shaky.", nauseous: "I'm sorry you're feeling nauseous.",
    longDay: "I'm glad you're okay. Sounds like it's been a long day.",
    roughDay: "I'm glad you're okay. Sounds like it's been a tough day.",
    uncertainty: "That's okay — let's focus on keeping you safe.", generic: 'Thank you for telling me.',
  },
  es: {
    dizzy: 'Siento que tengas mareo.', lightheaded: 'Siento que tengas mareo.',
    chest: 'Siento que te duela el pecho.', breathing: 'Siento que te cueste respirar.',
    faintness: 'Entiendo que sientas que podrías desmayarte.', weak: 'Siento que sientas debilidad.',
    tired: 'Entiendo que sientas cansancio.', sleepy: 'Entiendo que tengas sueño.',
    drowsy: 'Me preocupa que te venza el sueño.',
    stress: 'Siento que estés pasando por estrés.', fear: 'Entiendo que esto pueda dar miedo, y estoy aquí para ayudarte.',
    worried: 'Entiendo que esto te preocupe.', nervous: 'Entiendo que sientas nervios.',
    unwell: 'Siento que no te encuentres bien.', sick: 'Siento que te sientas mal.',
    shaky: 'Siento que tengas temblores.', nauseous: 'Siento que tengas náuseas.',
    longDay: 'Me alegra que estés bien. Parece que ha sido un día largo.',
    roughDay: 'Me alegra que estés bien. Parece que ha sido un día difícil.',
    uncertainty: 'Está bien, lo primero es tu seguridad.', generic: 'Gracias por decírmelo.',
  },
} as const;
type Signal = Exclude<keyof typeof replies.en, 'longDay' | 'roughDay' | 'uncertainty' | 'generic'>;
const priority: readonly Signal[] = ['chest', 'breathing', 'faintness', 'drowsy', 'dizzy', 'lightheaded', 'weak', 'nauseous',
  'shaky', 'sleepy', 'tired', 'fear', 'stress', 'nervous', 'worried', 'sick', 'unwell'];
const emotional: readonly Signal[] = ['fear', 'stress', 'nervous', 'worried'];
const assistance = {
  en: /^(?:i (?:need|want) (?:some )?help|(?:can|could) you help me|help me)(?: please)?$/,
  es: /^(?:necesito ayuda|ayudame|puedes ayudarme)(?: por favor)?$/,
};

export function offlineContext(text: string | null, lang: Lang) {
  const clauses = text && text.length <= 240 ? statementSegments(text).filter(clause => clause.ownership === 'driver') : [];
  const findings = new Set<Signal>();
  for (const { text: clause } of clauses) {
    const bounded = clause.replace(/^(?:no|nah)(?= i(?: |'m\b)) |^(?:um|uh|bueno|pues) /, '');
    for (const signal of utteranceFeatures(lang, clause) ?? []) findings.add(signal);
    for (const [signal, pattern] of Object.entries(additional[lang]) as [Signal, RegExp][]) {
      if (!pattern.test(bounded) && !pattern.test(clause)) continue;
      if (signal === 'faintness') {
        if (urgentPhysicalEvidence([clause]) !== 'current') continue;
      }
      findings.add(signal);
    }
  }
  // An explicit denial elsewhere may be a correction. Suppress specific
  // echoes when the reviewed clauses disagree rather than guessing which won.
  for (const { text: clause } of clauses) {
    const denial = symptomScan(clause);
    if (denial.kind === 'negated_only') {
      const categoryBySignal = { dizzy: 'dizziness', lightheaded: 'dizziness', chest: 'cardiovascular',
        breathing: 'respiratory', tired: 'fatigue', sleepy: 'fatigue', weak: 'other', unwell: 'other',
        sick: 'other', shaky: 'other', nauseous: 'nausea' } as const;
      for (const [signal, category] of Object.entries(categoryBySignal)) {
        if (denial.categories.includes(category)) findings.delete(signal as Signal);
      }
    }
  }
  const hasEmotionalDenial = clauses.some(({ text: clause }) => /\b(?:not|no longer|no estoy|no me siento) (?:really |muy )?(?:scared|afraid|stressed|worried|nervous|ansios[oa]|asustad[oa]|estresad[oa]|preocupad[oa])\b/.test(clause));
  if (hasEmotionalDenial) for (const signal of emotional) findings.delete(signal);
  if (drowsinessEvidence(clauses.map(clause => clause.text)) === 'current') findings.add('drowsy');
  const symptom = priority.find(signal => findings.has(signal) && !emotional.includes(signal)) ?? null;
  const emotion = emotional.find(signal => findings.has(signal)) ?? null;
  // ASR may omit punctuation between reassurance and a bounded long-day suffix.
  let situation: 'long_day' | 'rough_day' | null = null;
  let reassurance = clauses.some(clause => clearWellnessAffirmation(clause.text));
  for (const { text: clause } of clauses) {
    const suffix = clause.match(longDay[lang]);
    if (!suffix || suffix.index === undefined) continue;
    const head = clause.slice(0, suffix.index).trim();
    if (head && !clearWellnessAffirmation(head)) continue;
    if (head) reassurance = true;
    situation = suffix[1] === 'long' || suffix[1] === 'largo' ? 'long_day' : 'rough_day';
  }
  const help = clauses.some(clause => assistance[lang].test(clause.text));
  const uncertain = clauses.some(clause => HEDGES.test(clause.text));
  return {
    symptom, emotion, reassurance, help,
    situation,
    intent: reassurance && (symptom || emotion || help) ? 'conflicting' : help ? 'assistance'
      : symptom || emotion ? 'disclosure' : uncertain ? 'uncertainty' : reassurance ? 'reassurance' : 'unknown',
    certainty: uncertain ? 'uncertain' : symptom || emotion || reassurance || help ? 'explicit' : 'unknown',
  } as const;
}

export function basicOfflineAcknowledgment(context: ReturnType<typeof offlineContext>, lang: Lang, outcome: 'ok' | 'not_ok' | 'unclear') {
  const copy = replies[lang];
  if (outcome === 'ok') return context.reassurance && context.situation
    && !context.symptom && !context.emotion && !context.help && context.certainty === 'explicit' ? (context.situation === 'long_day' ? copy.longDay : copy.roughDay) : null;
  if (outcome === 'unclear') return context.intent === 'uncertainty' ? copy.uncertainty
    : context.emotion === 'stress' && !context.symptom && !context.help ? copy.stress : null;
  return copy[context.symptom ?? context.emotion ?? 'generic'];
}
