import type { DriverInterpretation } from './index.ts';
import { safeSpokenReply } from './conversationPolicy.ts';
import { PULL_OVER_GUIDANCE } from './driverWellnessSafety.ts';

// This is a conservative prose filter, not a semantic safety proof or an action
// authorization boundary. Final driver speech and SafetyController own all actions.
const ACTION_OR_MEDICAL = /\b(?:call\w*|dial\w*|phone\w*|contact\w*|consent\w*|authoriz\w*|dispatch\w*|ambulance|police|emergency|paramedic\w*|rescue|mom|mum|dad|diagnos\w*|medic\w*|treat\w*|prescri\w*|dosage|dose|aspirin|ibuprofen|pill\w*|drug\w*|heart attack|stroke|disease|blood pressure|blood sugar|dehydrat\w*|monitor\w*|track\w*|record\w*|guarantee\w*|promise\w*)\b|help (?:is|has been|was)|(?:sent|summoned|arranged|notified|alerted)\b/i;
const UNSAFE_DRIVING = /\b(?:keep|continue|resume|carry on|go on)\b[^.!?]*\b(?:driv\w*|journey|trip)\b|\b(?:safe|okay|ok|fine|fit|able) to drive\b|\b(?:you (?:are|seem)|you're)\s+(?:perfectly |completely )?(?:safe|fine|okay|ok|healthy)\b|\b(?:don't|do not|shouldn't|should not|mustn't|must not|never|no need to|need not|not necessary to)(?: need to| have to)?\s+(?:stop|pull|rest|worry|seek)\b|\b(?:ignore|disregard|dismiss|push through|power through|drive through)\b|\b(?:symptoms?|dizziness|pain|discomfort)\b[^.!?]*\b(?:harmless|normal|nothing|pass|go away)\b|\b(?:speed up|drive faster|close your eyes|look away|take your eyes|use your phone|text while)\b/i;
const MEDICAL_INSTRUCTION = /\b(?:swallow|inject|drink|eat|breathe|breathing exercise\w*|hold your breath|stop taking|start taking|cure\w*|remedy|insulin|antibiotic\w*|supplement\w*)\b|\b(?:take|use|apply)\b(?!\s+(?:care\b|a (?:break|moment)\b|your time\b))/i;
const UNSAFE_CONTEXT = /\b(?:driv\w*|journey|trip)\b[^.!?]*\b(?:despite|even if|even though|while (?:dizzy|sleepy|unwell))\b|\b(?:don't|do not|never)\b[^.!?]*\b(?:safely|safe|attention|road)\b|\b(?:nothing to worry about|just relax|push on|keep going|carry on)\b/i;
const UNSAFE_STOPPING = /\bpull over\b(?! (?:safely\b|when (?:it is |it's )?safe\b))|\b(?:stop|park) (?:now|immediately|in (?:the |a )?(?:road|lane|traffic))\b/i;

// Do not interpret negation or quotation as evidence that a safety claim is safe.
// Even a denied/quoted diagnosis or driving instruction is unsuitable for playback.
const MEDICAL_TOPIC = /\b(?:symptom\w*|anxiet\w*|panic|depress\w*|infection\w*|illness\w*|sick|dizz\w*|vertigo|migraine\w*|seizure\w*|hypoglyc\w*|diabet\w*|lightheaded|faint\w*|nause\w*|pain\w*|serious|harmless|benign|normal|healthy|health|condition|stress|fatigue|exhaust\w*|sleep\w*|drows\w*)\b/i;
const MEDICAL_CLAIM = /\b(?:you|your body)\s+(?:(?:do not|don't|may|might|probably|likely|possibly|definitely|certainly)\s+)*(?:have|suffer\w*|need treatment|need help)\b|\b(?:you are|you're|you may be|you might be) (?:suffering|experiencing|showing|displaying|exhibiting|dealing with)\b|\b(?:nothing (?:is )?wrong|nothing serious|not serious|no big deal|just (?:anxiety|stress)|you(?:'re| are) (?:not )?(?:ill|sick|unwell))\b/i;
const DRIVING_CLEARANCE = /\b(?:proceed|onward|onwards|accelerat\w*|overtak\w*|swer\w*|weav\w*|speed\w*|hurry|hurrying|rush\w*|racing|race)\b|\b(?:continue|resume|finish|complete|head|go|carry)\b[^.!?]*\b(?:driv\w*|journey|trip|destination|home|on)\b|\b(?:good|clear|ready|fit|well enough) to (?:go|driv\w*|continue)\b|\b(?:run|jump) (?:the |a )?(?:red|light|signal)\b/i;
// Restrict driving-related clauses to safe-reminder constructions, not a list of
// permitted conversation words. Unknown road instructions fail closed.
const DRIVING_TOPIC = /\b(?:driv\w*|journey|trip|road|lane\w*|traffic|intersection\w*|pedestrian\w*|wheel|brak\w*|steer\w*|eyes|red light|signal|destination|car|vehicle|turn|turning|merge|merging|reverse|reversing)\b/i;
const SAFE_REMINDER = /^(?:(?:please |remember to )?(?:drive safely|stay focused|keep (?:your )?(?:attention|eyes) on the road))(?: and (?:(?:please )?(?:drive safely|stay focused|keep (?:your )?(?:attention|eyes) on the road)))*$/i;
const SAFE_STOP = /^(?:please )?pull over (?:safely|when (?:it is |it's )?safe)$/i;
const CONDITIONAL_STOP = /^if you (?:feel|are|become|start feeling) (?:tired|dizzy|unwell|sleepy|drowsy|faint|uncomfortable),? (?:please )?pull over (?:safely|when (?:it is |it's )?safe)$/i;

/** Only the engine may supply this, from final driver speech and its own safety
 * state. Never copy provider history, model wellness or model prose into it. */
export type ConnectedSafetyContext = Readonly<{ stoppingRequired: boolean }>;

export function connectedConversationalReply(value: DriverInterpretation, previous: string[] = [],
  safetyGuidanceDelivered = false, parkingStatusNeeded = false,
  trustedContext?: ConnectedSafetyContext): { text: string; usedFallback: boolean; fallbackReason?: string } {
  // Preserve the shared advisory shape boundary. Never accept model consent flags.
  safeSpokenReply(value, '');
  // Known safety concerns are not a prose-classification problem: deterministic
  // stopping guidance wins, even if the model says the driver feels well.
  if (trustedContext?.stoppingRequired || safetyGuidanceDelivered)
    return { text: PULL_OVER_GUIDANCE, usedFallback: true, fallbackReason: 'trusted_stopping_required' };
  const original = value.suggestedReply?.trim() ?? '';
  const normalized = original.replace(/’/g, "'").replace(/\s+/g, ' ');
  const words = normalized.match(/[a-z]+(?:'[a-z]+)?/gi) ?? [];
  const bounded = original.length > 0 && original.length <= 240 && words.length <= 40
    && /^[a-zA-Z\s.,?!'’—-]+$/.test(original) && (original.match(/\?/g)?.length ?? 0) <= 1;
  const parkingQuestion = /(?:^|[.!]\s*)are you safely parked\?\s*$/i.test(normalized);
  const assumesParked = /\b(?:parked|parking|stationary|stopped|off the road)\b/i.test(normalized.replace(/are you safely parked\?/ig, ''));
  const diagnostic = /\b(?:symptom\w*|what feels|better or worse|what.*(?:changed|different))\b[^.!]*\?/i.test(normalized)
    || /\btell me (?:more about|what you notice|what feels)\b/i.test(normalized);
  // Match whole sentences. A safe clause inside a quotation, denial or unsafe
  // instruction must not legitimize the rest of the message.
  const sentences = normalized.split(/[.!?]+/).map(sentence => sentence.trim()).filter(Boolean);
  const unsafeTopic = sentences.some(sentence => {
    if (SAFE_STOP.test(sentence) || CONDITIONAL_STOP.test(sentence)) return false;
    return MEDICAL_TOPIC.test(sentence) || MEDICAL_CLAIM.test(sentence)
      || DRIVING_TOPIC.test(sentence) && !SAFE_REMINDER.test(sentence);
  });
  const prohibited = value.explicitContactRequest || value.requestsSavedEmergencyContact
    || ACTION_OR_MEDICAL.test(normalized) || MEDICAL_INSTRUCTION.test(normalized)
    || UNSAFE_DRIVING.test(normalized) || UNSAFE_CONTEXT.test(normalized) || UNSAFE_STOPPING.test(normalized)
    || MEDICAL_CLAIM.test(normalized) || DRIVING_CLEARANCE.test(normalized) || unsafeTopic
    || assumesParked || diagnostic || parkingQuestion && !parkingStatusNeeded
    || (value.wellness === 'not_ok' || safetyGuidanceDelivered) && /\bdriv\w*\b/i.test(normalized)
    || (value.wellness === 'not_ok' || safetyGuidanceDelivered) && normalized.includes('?') && !parkingQuestion;
  const guidance = safetyGuidanceDelivered || value.wellness !== 'not_ok'
    || sentences.some(sentence => SAFE_STOP.test(sentence));
  const comparable = (text: string) => text.toLowerCase().replace(/’/g, "'").replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
  const questions = (text: string) => (text.match(/[^.!?]*\?/g) ?? []).map(comparable);
  const repeated = previous.some(old => comparable(old) === comparable(original)
    || questions(original).some(question => questions(old).includes(question)));
  if (bounded && !prohibited && guidance && !repeated) return { text: original, usedFallback: false };
  // Do not imply that a generated-text rejection was a recognition failure.
  const fallback = value.wellness === 'not_ok' || safetyGuidanceDelivered
    ? PULL_OVER_GUIDANCE : 'Thanks for letting me know. Keep your attention on the road.';
  return { text: fallback, usedFallback: true, fallbackReason: !bounded ? 'length_or_format'
    : prohibited ? 'prohibited_connected_advisory' : !guidance ? 'missing_safe_pull_over_guidance' : 'repeated_reply_or_question' };
}
