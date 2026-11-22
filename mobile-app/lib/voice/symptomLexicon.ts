/**
 * Shared symptom and hedge vocabulary for the emergency voice check.
 *
 * Single source of truth for which spoken words name a symptom (and in which
 * category) and which phrases mark an uncommitted answer ("maybe", "no sé").
 * The wellness-language, Gemma-grounding and verdict-combining layers read
 * from here instead of keeping their own word lists.
 *
 * Invariants: pure and deterministic (no state, no I/O); a symptom token is
 * negated only by a nearby cue with intervening modifiers, so a negative
 * cannot cross another symptom or a contrast clause. Text is
 * re-normalised defensively, so callers may pass raw or already-normalised
 * transcripts.
 */
import { normalise } from './normalise.ts';

export type SymptomCategory =
  | 'fatigue' | 'dizziness' | 'cardiovascular' | 'respiratory'
  | 'neural' | 'pain' | 'nausea' | 'other'; // 'other' = lexicon token with no finer category
export type SymptomScan = {
  kind: 'affirmative' | 'negated_only' | 'historical_only' | 'none';
  hedged: boolean;
  categories: SymptomCategory[]; // categories of this statement's symptom tokens, empty when kind==='none'
};

// Uncommitted positive answers clarify; neither classifier may clear them.
export const HEDGES: RegExp =
  /\b(?:maybe|perhaps|might|possibly|not sure|unsure|i don't know|i dont know|i think|i guess|i suppose|no se|no estoy segur[oa]|tal vez|quiza|quizas|creo|supongo|not feeling myself)\b/i;

// Lexicon as data: accent-stripped forms only (matching happens after
// normalise), single words match on word boundaries, multi-word tokens match
// as substrings of the normalised text. Spanish feminine/masculine endings
// are listed out because word-boundary matching cannot truncate them.
const LEXICON: Readonly<Record<SymptomCategory, readonly string[]>> = {
  fatigue: ['tired', 'sleepy', 'exhausted', 'worn out', 'cansada', 'cansado', 'agotada', 'agotado', 'sueno', 'fatigue', 'fatiga', 'cansancio'],
  dizziness: ['dizzy', 'lightheaded', 'mareada', 'mareado', 'mareo'],
  cardiovascular: ['chest pain', 'chest hurts', 'heart racing', 'heart pounding', 'taquicardia', 'dolor en el pecho', 'me duele el pecho'],
  respiratory: ["can't breathe", 'cant breathe', 'short of breath', 'hard to breathe', 'no puedo respirar', 'me falta el aire'],
  neural: ['headache', 'head hurts', 'numb', 'blurry vision', "can't see well", 'cant see well', 'dolor de cabeza', 'me duele la cabeza', 'entumecida', 'entumecido', 'vision borrosa',
    "can't focus", 'cant focus', 'cannot focus', "can't concentrate", 'cannot concentrate',
    'vision just went dark', 'vision went dark', 'no puedo concentrarme', 'se me oscurecio la vista'],
  pain: ['pain', 'hurts', 'ache', 'my arm hurts', 'dolor', 'duele', 'dolor de'],
  nausea: ['nauseous', 'sick to my stomach', 'throw up', 'nauseas', 'vomitar'],
  other: ['weak', 'unwell', 'under the weather', 'not feeling myself', 'weird', 'debil', 'enferma', 'enfermo', 'me siento mal'],
};

// Bounded negation permits articles/intensifiers but never an intervening
// symptom or clause connector ("not dizzy but weak" still reports weakness).
const NEGATION_CUES: readonly string[] = ['not', 'no', 'no longer', "don't feel", 'dont feel', 'do not feel',
  "don't have", 'dont have', 'do not have', 'not have', 'without',
  'no estoy', 'no me siento', 'no tengo', 'no siento', 'no me duele', 'no me', 'sin'];
const NEGATION_GAP = /^(?:a|any|really|very|so|quite|feeling|having|much|chest|el|un|una|ningun|ninguna|nada|muy|tan|poco)$/;

function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

/** Char offset where each word of the normalised text begins. */
function wordStarts(words: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const word of words) { starts.push(at); at += word.length + 1; }
  return starts;
}

function wordIndexAt(starts: readonly number[], charAt: number): number {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= charAt) index += 1;
  return index;
}

/** True iff a nearby cue and its intervening modifiers negate this token. */
function isNegated(words: readonly string[], tokenWord: number): boolean {
  for (const cue of NEGATION_CUES) {
    const parts = cue.split(' ');
    for (let p = 0; p + parts.length <= words.length; p += 1) {
      const last = p + parts.length - 1;
      if (tokenWord > last && tokenWord - last <= 5 && parts.every((w, k) => words[p + k] === w)
          && words.slice(last + 1, tokenWord).every(word => NEGATION_GAP.test(word))) return true;
    }
  }
  return false;
}

/** Keep correction/contrast boundaries before punctuation is normalized away.
 * A standalone "no" in one clause cannot negate a symptom in the next. */
export function wellnessClauses(text: string): readonly string[] {
  return text.split(/[,.!?;:—–-]+|\b(?:but|however|yet|pero|sin embargo)\b|\b(?:and|y)\s+(?=(?:i|i'm|im|estoy|me|no|not|sin)\b)/iu)
    .map(clause => normalise(clause)).filter(Boolean);
}

// Only this reviewed auxiliary construction is exempt from English "he"
// reporting detection. Other pronouns still use the existing scope rules.
export const SPANISH_LONG_DAY = '(?:solo |solamente )?(?:tuve|he tenido|ha sido) un dia (largo|dificil)';
const spanishLongDayAuxiliary = /\bhe(?= tenido un dia (?:largo|dificil)\b)/g;

export function withoutSpanishLongDayAuxiliary(text: string) {
  return text.replace(spanishLongDayAuxiliary, '');
}

export type StatementSegment = Readonly<{
  text: string;
  ownership: 'driver' | 'quoted' | 'reported' | 'unresolved';
}>;

/** Bounded ownership, not a general language parser. Unquoted reporting scope
 * survives coordination; a contrast or sentence boundary can end that scope.
 * Quote scanning precedes segmentation so words inside quotes cannot escape. */
export function statementSegments(text: string): readonly StatementSegment[] {
  const segments: StatementSegment[] = [];
  let scope: 'driver' | 'reported' | 'unresolved' = 'driver';
  const reporting = /\b(?:she|he|they|someone|my (?:wife|husband|partner|friend|mom|dad|brother|sister|son|daughter)|said|says|told|ella|ellos|mi (?:esposa|esposo|pareja|amig[oa]|mama|papa|herman[oa]|hij[oa])|dice|dijo|dijeron)\b/;
  const hypothetical = /\b(?:if|what if|si estuviera|que (?:pasaria|hago) si|(?:no se|no estoy segur[oa](?: de)?) si|en caso de que)\b/;
  // Preserve the distinction between Spanish conditional si and affirmative sí.
  const conditionalSpanish = /^\s*[¿¡]?si\s+(?:me (?:est[aá]|sigue|duele|cuesta)|no puedo|apenas puedo|estoy luchando|se me|tengo|siento|esto fuera|estuviera|tuviera|sintiera|me doliera|no pudiera)(?=\s|$)/iu;
  const boundary = /[,.!?;:—–-]+|\b(?:but|however|yet|pero|sin embargo)\b|\b(?:and|y)\b/giu;
  const emit = (raw: string) => {
    const t = normalise(raw);
    if (!t) return;
    const ownership = hypothetical.test(t) || conditionalSpanish.test(raw) ? 'unresolved'
      : reporting.test(withoutSpanishLongDayAuxiliary(t)) ? 'reported'
      : scope === 'driver' ? 'driver' : 'unresolved';
    segments.push({ text: t, ownership });
    scope = ownership;
  };
  const unquoted = (raw: string) => {
    let start = 0;
    for (const match of raw.matchAll(boundary)) {
      emit(raw.slice(start, match.index));
      // Commas/colons and coordination cannot silently end an unquoted report.
      if (/[.!?;]/.test(match[0]) || /^(?:but|however|yet|pero|sin embargo)$/i.test(match[0])) scope = 'driver';
      start = match.index + match[0].length;
    }
    emit(raw.slice(start));
  };
  const closing: Readonly<Record<string, string>> = { '"': '"', '“': '”', '«': '»', "'": "'", '‘': '’' };
  const wordAt = (at: number) => at >= 0 && at < text.length && /[\p{L}\p{N}]/u.test(text[at]!);
  const apostropheInWord = (at: number) => wordAt(at - 1) && wordAt(at + 1);
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const close = closing[text[at]!];
    if (!close || (text[at] === "'" || text[at] === '‘') && (apostropheInWord(at) || wordAt(at - 1))) continue;
    unquoted(text.slice(start, at));
    let end = at + 1;
    while (end < text.length && (text[end] !== close || (close === "'" || close === '’') && apostropheInWord(end))) end += 1;
    const closed = end < text.length;
    segments.push({ text: normalise(text.slice(at + 1, end)), ownership: closed ? 'quoted' : 'unresolved' });
    // A complete quotation bounds its report; an unfinished quote never does.
    scope = closed ? 'driver' : 'unresolved';
    at = end;
    start = closed ? end + 1 : end;
  }
  unquoted(text.slice(start));
  return segments;
}

export function assertedWellnessClauses(text: string): readonly string[] {
  return statementSegments(text).filter(segment => segment.ownership === 'driver').map(segment => segment.text);
}

const URGENT_PHYSICAL_MENTION = /\b(?:chest|breathe|breathing|breath|heart attack|stroke|pass out|passing out|faint|fainted|dying|pecho|respirar|infarto|desmay\w*|me falta el aire)\b/;
const URGENT_PHYSICAL_COMPLAINT = /\b(?:chest (?:pain|hurts?|is hurting|feels tight|tightness)|pain in (?:my|the) chest|dolor (?:en el|de) pecho|me (?:duele|esta doliendo|sigue doliendo) (?:el )?pecho|heart attack|stroke|pass out|passing out|fainted|(?:i'm|im|i am|feel|feeling|felt|might|may|could|going to|about to) faint|dying|infarto|desmay\w*|(?:can't|cant|cannot|unable to|hard to) breathe|(?:can't|cant|cannot) catch (?:my|a) breath|short of breath|(?:trouble|difficulty) breathing|(?:no puedo|dificultad para) respirar|me falta el aire)\b|^faint$/g;
const PAST_URGENT = /\b(?:yesterday|ayer|last (?:week|year|night|month)|(?:days?|weeks?|months?|years?) ago|used to|anoche|la semana pasada|hace (?:dias|semanas|meses|anos))\b/;
const CURRENT_TIME = /\b(?:now|ahora|still|todavia)\b/;
const CURRENT_TIME_AFTER_SYMPTOM = /^\s*(?:now|ahora|still|todavia)\b/;
const CONTINUING_TIME = /\b(?:since|desde)\b/;

/** A keyword mention is insufficient without a current, locally asserted complaint. */
export function urgentPhysicalEvidence(asserted: readonly string[]): 'current' | 'unconfirmed' | 'none' {
  let mentioned = false;
  for (const clause of asserted) {
    if (!URGENT_PHYSICAL_MENTION.test(clause)) continue;
    mentioned = true;
    const words = clause.split(' '), starts = wordStarts(words);
    for (const match of clause.matchAll(URGENT_PHYSICAL_COMPLAINT)) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      // A later "now" must not turn an earlier historical symptom into a current one.
      const historical = !CONTINUING_TIME.test(clause) && !CURRENT_TIME_AFTER_SYMPTOM.test(after) && (
        (PAST_URGENT.test(before) && !CURRENT_TIME.test(before.split(PAST_URGENT).at(-1) ?? ''))
        || (PAST_URGENT.test(after) && !CURRENT_TIME.test(before))
      );
      if (!historical && !isNegated(words, wordIndexAt(starts, match.index))) return 'current';
    }
  }
  return mentioned ? 'unconfirmed' : 'none';
}

// Require a complete current first-person impairment. These are stronger
// than being tired or having had a long day, but use the ordinary NOT OK path.
const DROWSINESS_TIMING = / (?:right now|now|while driving|mientras conduzco|ahora mismo|ahora|al volante)$/;
const DROWSINESS = [
  /^(?:i(?:'m|m| am) )?(?:barely able to|(?:really )?(?:struggling|fighting) to) (?:stay awake|keep my eyes open)$/,
  /^i (?:barely|can barely|(?:can't|cant|cannot)(?: seem to)?) (?:stay awake|keep my eyes open)$/,
  /^(?:i keep (?:nodding off|falling asleep)|(?:i have|i'm having|i am having) (?:trouble|difficulty) staying awake)$/,
  /^(?:me cuesta(?: mucho)?|me esta costando(?: mucho)?|apenas puedo|no puedo) (?:mantenerme despiert[oa]|mantener los ojos abiertos)$/,
  /^(?:(?:estoy luchando|lucho) por mantenerme despiert[oa]|se me (?:cierran|estan cerrando) los ojos|me estoy quedando dormid[oa])$/,
];
const NEGATED_DROWSINESS = [
  /^(?:i(?:'m| am) )?(?:not|no longer) (?:struggling|fighting) to (?:stay awake|keep my eyes open)$/,
  /^i (?:can stay awake|can keep my eyes open)$/,
  /^(?:(?:no me cuesta|no me esta costando) (?:mantenerme despiert[oa]|mantener los ojos abiertos)|(?:no estoy luchando|no lucho) por mantenerme despiert[oa]|no se me cierran los ojos)$/,
];

export function drowsinessEvidence(clauses: readonly string[]): 'current' | 'negated' | 'none' {
  const reports = clauses.map(clause => clause.replace(DROWSINESS_TIMING, ''));
  if (reports.some(clause => DROWSINESS.some(pattern => pattern.test(clause)))) return 'current';
  return reports.some(clause => NEGATED_DROWSINESS.some(pattern => pattern.test(clause))) ? 'negated' : 'none';
}

export function symptomScan(normalised: string): SymptomScan {
  const t = normalise(normalised);
  const hedged = HEDGES.test(t);
  const affirmative = new Set<SymptomCategory>();
  const negated = new Set<SymptomCategory>();
  const historical = new Set<SymptomCategory>();
  for (const clause of wellnessClauses(normalised)) {
    const words = clause.split(' ');
    const starts = wordStarts(words);
    for (const [category, tokens] of Object.entries(LEXICON) as [SymptomCategory, readonly string[]][]) {
      for (const token of tokens) {
        const pattern = tokenPattern(token);
        for (let m = pattern.exec(clause); m; m = pattern.exec(clause)) {
          const before = clause.slice(0, m.index);
          const past = PAST_URGENT.test(clause)
            && !CONTINUING_TIME.test(clause)
            && /\b(?:had|was|were|felt|used to|tuve|tenia|estaba|sentia)\b/.test(before)
            && !/\b(?:now|ahora|today|hoy)\b/.test(before.split(/\b(?:had|was|were|felt|tuve|tenia|estaba|sentia)\b/).at(-1)!);
          if (isNegated(words, wordIndexAt(starts, m.index))) negated.add(category);
          else if (past) historical.add(category);
          else affirmative.add(category);
        }
      }
    }
  }
  for (const category of affirmative) negated.delete(category);
  const categories = affirmative.size ? [...affirmative] : negated.size ? [...negated] : [...historical];
  const kind: SymptomScan['kind'] = affirmative.size ? 'affirmative' : negated.size ? 'negated_only' : historical.size ? 'historical_only' : 'none';
  return { kind, hedged, categories };
}
