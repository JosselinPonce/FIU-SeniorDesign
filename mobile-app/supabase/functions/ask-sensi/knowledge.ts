// Reviewed reference notes. See mobile-app/docs/ask-sensi-knowledge.md.
const cards = {
  overview: 'DriveSense is a prototype that records driving sessions, monitors available pulse and oxygen estimates from the steering wheel, and can run a local safety check. In the wheel-and-relay setup, MAX30102 sensors feed the ESP32, which acquires red and infrared samples and estimates vitals. The Raspberry Pi relays BLE frames verbatim to the phone. The mobile app evaluates configured warning thresholds and confirmed abnormality; the Pi relay does not make emergency decisions. The app stores session history locally. A direct ESP32 bench mode can bypass the relay. Cloud Ask Sensi is optional and separate from local monitoring.',
  sensors: 'The current prototype has six MAX30102 optical sensors at different grip positions to improve the chance of usable contact. The six-source firmware selects one qualified source per BLE packet and can switch if that source becomes unusable. Six positions do not guarantee coverage or reliable readings from all sensors. DriveSense does not measure environmental conditions or directly detect drowsiness. Reflective photoplethysmography (PPG) shines red and infrared light into the skin and measures changes in reflected light as blood volume pulses. Pulse timing estimates BPM, and relative red and infrared changes help estimate SpO₂.',
  pulse: 'BPM means beats per minute, the number of heartbeats in one minute. Heart rate reflects how fast the heart is beating. For most adults, 60–100 BPM is a typical resting range when calm and well. Fitness, medications and other factors can affect it. While driving, attention, stress, exertion and recent caffeine can change heart rate, so a driving reading is not the same as a resting baseline. Bradycardia and tachycardia describe slower and faster rates relative to clinical context. Rest, activity and individual physiology affect their interpretation. General ranges are educational and are not DriveSense warning thresholds.',
  oxygen: 'SpO₂ is an optical estimate of the percentage of hemoglobin carrying oxygen. It helps describe blood oxygenation. In most healthy people near sea level, 95–100% is typical, with 95% at the lower end. A reduced estimate can reflect lower oxygen saturation, optical measurement limits, or both. Altitude, circulation, temperature, skin pigmentation, sensor contact and motion can affect readings or their accuracy. An isolated steering-wheel estimate cannot establish what is normal for an individual or whether they are safe to drive.',
  quality: 'Readings require adequate hand contact and signal quality. Motion, changing grip, cold hands and poor circulation can weaken the optical signal. DriveSense checks contact, validity flags and plausible metric ranges. Local safety evaluation also rejects stale or discontinuous readings and requires a firmware quality score of at least 50 when available and rejects readings when the applicable phone-side quality verdict fails. Missing or rejected readings mean there was insufficient usable data, not that a value was normal.',
  flags: 'In production, the phone filters unusable samples and outliers and evaluates a rolling median. Upper pulse limits compare at or above their boundaries. Lower pulse and oxygen limits compare at or below, including equality. A warning or critical median opens tracking; it does not activate the safety conversation. A critical median sets a more severe level and a shorter confirmation window. Production confirmation uses the latest 15 one-second slots for warning or 8 for critical, after tracking opens. At least 70% of slots must be usable and at least 80% of usable readings must meet or cross the warning boundary in the abnormal direction, even for a critical episode. Recovery can clear tracking; insufficient evidence can leave it unconfirmed. Only a confirmed production episode can start the local Safety Sensi conversation, which cannot displace a conversation already in progress. One abnormal BPM or SpO₂ reading cannot confirm an event or start the conversation. Configured boundaries can depend on the effective profile and baseline. Population ranges are educational.',
  demo: 'The accelerated Hardware Demo is an isolated simulation. It projects high pulse or low oxygen from qualified sensor input and evaluates it in a separate engine with five confirmation slots for either severity. The demo keeps signal qualification, filtering and evidence checks. A separate manual Hardware Demo trigger directly rehearses the dialogue with a fabricated episode. Neither path changes production thresholds, confirmation windows or live monitoring.',
  safety: 'A confirmed abnormality can start a local VoiceCheck. Sensi asks about wellness, accepts a usable final voice response or manual input, and can give pull-over guidance. Unavailable or unclear speech is handled conservatively. Safety Sensi works offline and does not rely on cloud AI or internet access. The app never automatically places a call. Opening the saved contact in the dialer requires separate explicit driver authorization and iOS confirmation. Ask Sensi only explains these features and cannot start or control them. DriveSense is a monitoring prototype and does not diagnose medical conditions or determine fitness to drive.',
  history: 'History shows available recorded sessions, trends and alerts without cloud AI. Chart gaps indicate missing readings. A shaded heart-rate band represents the usual range within warning thresholds. Ask Sensi can explain only a session summary explicitly shared with it. If no summary is supplied, it cannot see the latest or any other personal drive. If the user wants a personal analysis, explain how to select and explicitly share the drive. Unrecorded metrics and warnings cannot be inferred.',
  appHelp: 'Start Drive begins a session recording. Safety monitoring can run independently of recording. Sensor connectivity and cloud sync are separate. Safety Testing simulates warnings, and its simulated readings are excluded from learning. History opens recorded sessions and available summaries. The floating Sensi launcher opens Sensi Standby when no active safety conversation takes priority. From Standby, Ask Sensi is optional and text-only.',
};

type Card = keyof typeof cards;

const topics: readonly [Card, RegExp][] = [
  ['demo', /\b(?:hardware demo|fast demo|accelerated demo|demo (?:mode|confirmation|timing)|simulated biometric)\b/i],
  ['quality', /\b(?:missing|unusable|no readings?|signal quality|hand contact|sensor contact|accuracy|accurate|motion|grip|poor circulation|didn['’]?t (?:DriveSense )?(?:record|measure|show)|why.{0,45}(?:not|no) .{0,35}(?:record|reading|measure))\b/i],
  ['flags', /\b(?:abnormal\w*|warn\w*|critical|personaliz\w*|baselines?|threshold\w*|confirmation|false alarms?)\b/i],
  ['safety', /\b(?:voice ?check|safety sensi|emergenc\w*|pull[ -]over|medical device|diagnos\w*|fit(?:ness)? to drive|detects? (?:a|an) (?:problem|issue|abnormal\w*)|safety (?:check|conversation|features?|function\w*|limitations?))\b/i],
  ['sensors', /\b(?:sensors?|max30102|ppg|photoplethysmograph\w*|optical|red (?:and |or )?infrared)\b/i],
  ['pulse', /\b(?:bpm|heart ?rate|bradycardia|tachycardia|heartbeat\w*|pulse rate|beats per minute|(?:these|both) measurements? (?:important|matter))\b/i],
  ['oxygen', /(?:\b(?:spo[2₂]|oximetr\w*|oxygen|saturation|(?:these|both) measurements? (?:important|matter))\b|spo₂|\b95\s*%)/i],
  ['history', /\b(?:(?:last|latest|previous|my|selected|this) (?:drive|trip|session)\b|drive history\b|share (?:a |my |drive )?data\b)/i],
  ['appHelp', /\b(?:start drive|dashboard|settings|launcher|safety testing|cloud sync|how (?:can|do) i (?:use|start|find|open|export|record|connect)|offline help|features?)\b/i],
];

function matchingCards(question: string): Card[] {
  const measurement = /\b(?:measure\w*|estimate\w*|estimating|calculate\w*|detecting|sensing)\b/i.test(question)
    && /\b(?:drivesense|sensi|readings?|biometrics?|heart rate|oxygen|spo[2₂])/i.test(question);
  if (/\b(?:out of range|normal for me|warning (?:ranges?|limits?)|reference ranges?)\b/i.test(question)) return ['flags', 'pulse', 'oxygen'];
  const topicsMatched = topics.filter(([, pattern]) => pattern.test(question)).map(([card]) => card);
  const detection = /\b(?:trigger\w*|cutoff|single (?:reading|sample)|sustained|cross(?:es|ed|ing)?|confirm\w*|activat\w*|unreliable)\b/i;
  if (detection.test(question) && (topicsMatched.length > 0 || /\b(?:reading|check|warning|drivesense)\b/i.test(question))) {
    const priority: Card[] = topicsMatched.includes('demo') ? ['demo', 'flags', 'quality'] : ['flags', 'quality'];
    return [...new Set<Card>([...priority, ...topicsMatched])];
  }
  return measurement ? [...new Set<Card>(['sensors', 'overview', ...topicsMatched])] : topicsMatched;
}

export function getKnowledgeNotes(question: string, priorQuestions: readonly string[] = []): string[] {
  const matches = matchingCards(question);
  const followUp = /\b(?:more (?:detail|technical|about)|elaborate|explain further|(?:what|how|why|does|is|are|can) (?:about |does |do )?(?:that|it|this|they|those|these)\b|what do you mean|why\s*\?\s*$)/i;
  if (matches.length === 0 && followUp.test(question)) {
    for (const prior of [...priorQuestions].reverse()) {
      matches.push(...matchingCards(prior));
      if (matches.length > 0) break;
      if (/\bDriveSense\b/i.test(prior)) {
        matches.push('overview');
        break;
      }
    }
  }
  if (matches.length === 0 && /\bDriveSense\b/i.test(question)) matches.push('overview');
  return matches.slice(0, 3).map(card => cards[card]);
}
