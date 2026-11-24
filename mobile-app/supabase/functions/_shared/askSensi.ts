export const ASK_TOPICS = {
  drive: 'Explain a Drive',
  biometrics: 'Explain My Biometrics',
  warnings: 'Explain Safety Warnings',
  help: 'DriveSense Help',
} as const;
export type AskTopic = keyof typeof ASK_TOPICS;
export const MAX_QUESTION = 800;
export const MAX_ASK_ANSWER = 3600;
export const MAX_ASK_HISTORY_ANSWER = 600;
export const MAX_WARNINGS = 8;
export const WARNING_LABELS = {
  bpm_high: 'Heart rate above the configured threshold',
  bpm_low: 'Heart rate below the configured threshold',
  spo2_low: 'Estimated oxygen saturation below the configured threshold',
  no_contact: 'Sensor contact or usable readings missing',
  other: 'Other recorded warning',
} as const;
export type WarningKind = keyof typeof WARNING_LABELS;
export type Metric = { min: number | null; average: number | null; max: number | null };
export type VitalTrend = { heartRateFirst: number | null; heartRateLast: number | null; oxygenFirst: number | null; oxygenLast: number | null };
export type DriveContext = {
  date: string | null;
  localTime?: string; // Optional HH:mm wall time carried in the attached-drive request header.
  durationSeconds: number | null;
  samples: number;
  heartRate: Metric;
  oxygen: Metric;
  trend: VitalTrend | null;
  warningCount: number;
  warningGroups?: { kind: string; level: string | null; count: number }[]; // Local presentation only.
  warnings: { kind: WarningKind; level: 'notice' | 'warning' | 'critical' | null;
    value: number | null; threshold: number | null }[];
};
export const MAX_ASK_TURNS = 4;
export type AskTurn = { question: string; answer: string };
type AskInput = {
  kind: 'ask_sensi';
  requestId: string;
  topic: AskTopic;
  question: string;
  context: DriveContext | null;
};
export type AskSafetyContext = {
  baseline: { heartRateMedian: number | null; spo2Median: number | null };
  thresholds: { highWarn: number; highCrit: number; lowWarn: number; lowCrit: number; spo2Warn: number; spo2Crit: number } | null;
};

export function wantsAskSafetyContext(question: string, previousPersonal = false): boolean {
  const text = question.normalize('NFKD').replace(/\p{M}/gu, '');
  const personal = /\b(?:for me|my|mine|para mi|mis?)\b/i;
  const limits = /\b(?:baseline|thresholds?|ranges?|abnormal|normal for me|umbrales?|rangos?|basal|anormal)\b/i;
  const personalVitals = /\b(?:typical|usual|habitual|tipic[oa])\b.*\b(?:heart rate|oxygen|bpm|frecuencia cardiaca|oxigeno|spo2)\b/i;
  return personal.test(text) && (limits.test(text) || personalVitals.test(text))
    || /\b(?:do i have|have i|is (?:the|a)|tengo|esta)\b.*\b(?:baseline|referencia personal)\b/i.test(text)
    || previousPersonal && /^\s*(?:what about|and what|tell me more|can you explain|how about|why|y que)/i.test(text);
}

export type AskRequest = AskInput & ({ version: 1 } | { version: 2; history: AskTurn[] }
  | { version: 3; history: AskTurn[]; safetyContext: AskSafetyContext });
export const DRIVE_HELP = [
  'Start Drive begins a trip recording. Safety monitoring can operate separately from trip recording.',
  'History shows recorded drives, available heart rate and estimated oxygen saturation (SpO₂), and recorded alerts. Chart gaps indicate missing readings.',
  'The wheel can send readings through the Raspberry Pi. Direct ESP32 bench mode bypasses the Pi. Sensor connectivity and cloud sync are separate.',
  'Heart rate is measured in beats per minute (bpm). SpO₂ is the sensor’s estimate of blood oxygen saturation, expressed as a percentage.',
  'Personalized vitals use the driver profile as a starting point and can learn from recorded drives. The shaded heart-rate band shows the usual range within warning thresholds.',
  'The safety engine watches persistent out-of-range measurements before a check. A warning marks a recorded measurement or sensor condition, not a medical diagnosis.',
  'Safety Testing simulates warnings. Its fabricated readings are not real biometric measurements and are not used for learning.',
] as const;
