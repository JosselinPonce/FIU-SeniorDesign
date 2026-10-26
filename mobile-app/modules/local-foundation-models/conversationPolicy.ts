import type { DriverInterpretation, OfflineTranscription } from './index.ts';

/** Prototype-only input gate. Never forward partial/error/cancelled results to AI. */
export function finalTranscript(response: OfflineTranscription): string {
  if (response.status !== 'success' || response.isFinal !== true || response.requiresOnDeviceRecognition !== true
      || response.locale !== 'en-US' || response.hasFinalTranscript === false
      || response.finalResultReceived === false) {
    throw new Error(`No successful final offline en-US transcript: ${response.reason}. ${response.message}`);
  }
  const text = (response.finalTranscript ?? response.transcript).trim();
  if (!text || text.length > 500) throw new Error('Final transcript must contain 1–500 characters.');
  return text;
}

const REPLIES = {
  contact: 'I heard your request. This test does not place calls.',
  callTopic: 'I heard you. This test does not place calls.',
  ok: 'Thanks for letting me know. Drive safely.',
  not_ok: 'Please pull over when it is safe.',
  uncertain: "I couldn't tell how you feel. Please pull over if you feel unwell.",
};

/** No production consent imports. AI controls advisory classification only.
 * Free-form suggestions are displayed, but only this finite vocabulary is spoken. */
export function safeSpokenReply(value: DriverInterpretation, transcript: string): string {
  if (value.advisoryOnly !== true || value.callAuthorized !== false
      || !['ok', 'not_ok', 'uncertain'].includes(value.wellness)
      || typeof value.explicitContactRequest !== 'boolean'
      || typeof value.requestsSavedEmergencyContact !== 'boolean') {
    throw new Error('Invalid advisory interpretation; response playback refused.');
  }
  const reply = value.explicitContactRequest || value.requestsSavedEmergencyContact ? REPLIES.contact
    : /\b(call|dial|phone|contact|911|ambulance|police)\b/i.test(transcript) ? REPLIES.callTopic
    : REPLIES[value.wellness];
  // A matching model suggestion may be used; otherwise replace it with the
  // context-appropriate template. No generated medical/dialing promises are spoken.
  return value.suggestedReply?.trim() === reply ? value.suggestedReply.trim() : reply;
}

/** Small permitted subject vocabulary, plus forbidden constructions. This is a
 * conservative spoken-output gate, not a claim that arbitrary AI text is safe. */
const WORDS = new Set((`i i'm i've i'd i'll you you're you've you'd your yours we we're me my us our
it it's its that that's this these those a an the and or but so if when while then than to of for
with without in on at from as about how what do does did is isn't are aren't was were be been
being have has had can can't cannot could couldn't would wouldn't should shouldn't will won't
not no yes okay ok fine well unwell better worse unsure uncertain sure comfortable uncomfortable
hot overheating overheated feel feels feeling felt dizzy dizziness tired sleepy alert awake relaxed calm nervous worried
thanks thank thankyou telling sharing letting know hear heard sounds sound seems seem
please try take taking stop stopping stopped pull pulling over safely safe parked park rest resting
break pause help need needs want wants like prefer ready anything something more again little bit
now today right moment here there still just really very too also any some short breath breathing
slow slowly briefly talk talking tell telling say said ask question answer understand understood
sorry didn't don't doesn't let's keep focus focused road driving drive trip comfort wellness
check checking let later done goodbye bye enough finish finished conversation contact request
heard unsure sorry got gently much tell me can may start before after yourself yours time
would feeling how doing been getting getting glad happy uneasy able stay already longer
sit sitting place away traffic attention noticed difficult difficultly easy ease listen listening
 sorry uncomfortable discomfort hear manage manageable settled steadier steady sound changes changed since`).split(/\s+/));
const UNSAFE = /\b(call|called|calling|dial|dialed|dialing|contacted|contacting|dispatch|ambulance|police|911|diagnos\w*|medic\w*|treatment|heart attack|stroke|disease|monitor\w*|tracking|record\w*|promise|guarantee)\b|help is (?:coming|on the way)|(?:keep|continue|resume) driving|(?:safe|okay|ok|fine) to drive|(?:you (?:are|seem)|you're) (?:safe|fine|okay|ok|healthy)|(?:don't|do not|shouldn't|should not|mustn't|must not|won't|will not|never|no need to)(?: need to| have to)? (?:stop|pull|rest)|ignore/i;

/** Dialogue context only, never contact consent or an inference that parking is safe. */
export function drivingSafetyAnswer(text: string, precedingPrompt: string): 'not_parked' | 'parked' | 'improving' | null {
  const answer = text.toLowerCase().replace(/’/g, "'").replace(/[.,!?]/g, '').trim();
  const parkingQuestion = /(?:^|[.!]\s*)are you safely parked\?\s*$/i.test(precedingPrompt);
  if (/^(?:no[ ,]* )?(?:i'm |i am )?(?:not (?:safely )?parked(?: yet)?|still driving)$/.test(answer)
      || parkingQuestion && /^(?:no|not yet|no not yet)$/.test(answer)) return 'not_parked';
  if (/^(?:yes )?(?:i'm|i am) safely parked(?: now)?$/.test(answer)
      || parkingQuestion && /^(?:yes|yes i am|yes now|i am)$/.test(answer)) return 'parked';
  if (/^(?:yes )?(?:(?:i'm|i am|i feel|feeling|it's|it is)(?: getting| feeling)? )?better(?: now)?$/.test(answer)) return 'improving';
  return null;
}

export function conversationalReply(value: DriverInterpretation, previous: string[] = [], safetyGuidanceDelivered = false, parkingStatusNeeded = false): { text: string; usedFallback: boolean; fallbackReason?: string } {
  // Reuse the existing shape/advisory gate without taking its canned output.
  safeSpokenReply(value, '');
  let text = value.suggestedReply?.trim() ?? '';
  const unsafeGenerated = UNSAFE.test(text.replace(/’/g, "'"));
  if (safetyGuidanceDelivered) text = (text.match(/[^.!?]+[.!?]?/g) ?? []).filter(sentence =>
    !/pull over (?:safely|when (?:it is |it's )?safe)/i.test(sentence.replace(/’/g, "'"))).join(' ').trim();
  const words = text.toLowerCase().replace(/’/g, "'").match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  const bounded = text.length > 0 && text.length <= 240 && words.length <= 30
    && /^[a-zA-Z\s.,?!'’—-]+$/.test(text) && (text.match(/\?/g)?.length ?? 0) <= 1;
  const safetyQuestion = /(?:^|[.!]\s*)are you safely parked\?\s*$/i.test(text);
  const diagnosticQuestion = /(?:better or worse|what feels|what.*(?:changed|different)|discomfort|symptom)/i.test(text) && text.includes('?')
    || /\btell me (?:what (?:you notice|feels|has changed)|more about (?:your|the) (?:symptoms|discomfort))\b/i.test(text);
  const assumesParked = /\bparked\b/i.test(text.replace(/are you safely parked\?/ig, ''));
  const safe = (!safetyQuestion || parkingStatusNeeded) && !unsafeGenerated && !UNSAFE.test(text.replace(/’/g, "'")) && !/\b(?:drive|driving)\b/i.test(text)
    && !assumesParked && !diagnosticQuestion && words.every(word => WORDS.has(word))
    && (!(value.wellness === 'not_ok' || safetyGuidanceDelivered) || !text.includes('?') || safetyQuestion);
  // Unwell replies must contain actionable advice with an explicit safe qualifier.
  const guidance = safetyGuidanceDelivered || value.wellness !== 'not_ok' || /pull over (?:safely|when (?:it is |it's )?safe)/i.test(text.replace(/’/g, "'"));
  const comparable = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
  const questions = (s: string) => s.match(/[^.!?]*\?/g)?.map(comparable) ?? [];
  const isRepeated = (candidate: string) => previous.some(old => comparable(old) === comparable(candidate)
    || questions(candidate).some(question => questions(old).includes(question)));
  const repeated = isRepeated(text);
  if (bounded && safe && guidance && !repeated) return { text, usedFallback: false };
  const options = value.wellness === 'not_ok' && safetyGuidanceDelivered
    ? ['Please focus on stopping safely.']
    : value.wellness === 'not_ok'
    ? ["Please pull over when it's safe."]
    : value.wellness === 'uncertain'
      ? ['Could you clarify your answer?', 'Thanks for letting me know.']
      : ['Thanks for checking in.', 'Thanks for letting me know.'];
  return { text: options.find(option => !isRepeated(option)) ?? options[options.length - 1]!,
    usedFallback: true, fallbackReason: !bounded ? 'length_or_format' : !safe ? 'unsafe_or_outside_vocabulary'
      : !guidance ? 'missing_safe_pull_over_guidance' : 'repeated_reply_or_question' };

}

export function selectAssistantVoice<T extends { id: string }>(voices: T[], preferred: string | null): T {
  if (preferred) {
    const voice = voices.find(item => item.id === preferred);
    if (!voice) throw new Error('Your selected voice is unavailable for en-US. Choose an installed voice in Settings; your preference has not been replaced.');
    return voice;
  }
  if (!voices[0]) throw new Error('No installed en-US Apple voice is available.');
  return voices[0];
}

export function assertAssistantPlatform(platform: string, language: string): void {
  if (platform !== 'ios') throw new Error('Apple Driver Assistant is unavailable on this platform. Existing monitoring and safety controls remain available.');
  if (language !== 'en') throw new Error('The local assistant currently supports English (US) only. Existing safety checks remain available.');
}

export function assertAssistantCapabilities(model: { available: boolean; message: string },
  speech: { supportsOnDeviceRecognition: boolean; recognizerAvailable: boolean; message: string }): void {
  if (!model.available) throw new Error(model.message);
  assertAssistantSpeechCapabilities(speech);
}

export function assertAssistantSpeechCapabilities(speech: { supportsOnDeviceRecognition: boolean; recognizerAvailable: boolean; message: string }): void {
  if (!speech.supportsOnDeviceRecognition || !speech.recognizerAvailable) throw new Error(speech.message);
}

/** Trusted orchestration copy, separate from generated language and call authorization. */
export function contactLabel(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length <= 60 && /^[\p{L}\p{M} .'’-]+$/u.test(trimmed) ? trimmed : 'your contact';
}
export function contactHandoffMessage(outcome: string, name?: string | null): string {
  if (outcome === 'simulated') return 'Simulation complete. In a real emergency, DriveSense would open the phone interface.';
  if (outcome === 'opened') return `${contactLabel(name) === 'your contact' ? 'Your contact' : contactLabel(name)}'s number is open. Tap Call to connect.`;
  if (outcome === 'missing_contact') return "You haven't added a contact number yet. You can add one in Settings.";
  if (outcome === 'invalid_phone') return 'Your contact number needs fixing. Please check it in Settings.';
  if (outcome === 'cancelled') return 'Cancelled. No number was opened.';
  if (outcome === 'not_authorized') return "I didn't get clear agreement. No number was opened.";
  return "I couldn't open the number. Please try your Phone app.";
}
export function conversationStatus(phase: string): string {
  return ({ idle: 'Ready when you are', checking: 'Getting ready…', 'speaking question': 'Speaking…', listening: 'Listening…',
    finalizing: 'Finishing listening…', interpreting: 'Thinking…', 'speaking response': 'Speaking…', 'contact offer': 'Speaking…',
    'phone interface': 'Opening the number…', complete: 'Finished', stopping: 'Stopping…', cancelled: 'Stopped', error: 'Please try again' } as Record<string, string>)[phase] ?? '';
}
export function conversationMessage(phase: string, message?: string): string | undefined {
  if (!message || phase !== 'error') return message;
  if (/contact number|number was opened|Phone app/i.test(message)) return message;
  if (/timed out/i.test(message)) return "That took too long. Please try again when it's safe.";
  if (/transcript|response was not confirmed|no_speech/i.test(message)) return "I couldn't confirm what you said. Please try again when it's safe.";
  if (/ownership|driver|session|cancel/i.test(message)) return 'The conversation stopped. You can start again.';
  return "I couldn't finish that response. Please try again when it's safe.";
}

/** Parking status is relevant only to an explicit request for help stopping, not routine wellness. */
export function needsParkingStatus(text: string): boolean {
  return /^(?:can you |could you |please )?help me (?:stop|pull over|park)(?: safely)?[.!?]*$/i.test(text.trim());
}
