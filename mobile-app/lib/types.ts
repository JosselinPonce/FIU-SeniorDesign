/**
 * Row shape of public.telemetry_events (Supabase).
 * The Raspberry Pi pushes `ping` (heartbeat) and `vitals` events per drive session.
 */
export type TelemetryEvent = {
  id: string;
  session_id: string;
  sequence_number: number | null;
  event_type: string;
  bpm: number | null;
  spo2: number | null;
  signal_quality: number | null;
  battery: number | null;
  received_at: string;
  uploaded_at: string;
};

export type PiStatus =
  | 'NORMAL'
  | 'HIGH_HEART_RATE'
  | 'LOW_HEART_RATE'
  | 'LOW_SPO2';

export type Severity = 'normal' | 'warning' | 'critical';

/**
 * A vitals reading (real, from telemetry_events, or simulated)
 * classified for the voice agent.
 */
export type VitalsAlert = {
  /** telemetry_events.id, or null for the simulated demo button. */
  eventId: string | null;
  sessionId: string | null;
  heart_rate: number;
  spo2: number;
  signal_quality: number | null;
  status: PiStatus;
  severity: Severity;
  timestamp: string;
};

export type AgentAction = 'none' | 'log' | 'escalate';

export type AgentDecision = {
  reply: string;
  action: AgentAction;
};

// Anomaly thresholds. The Pi does not classify readings; the app does.
export const THRESHOLDS = {
  highHeartRate: 120,
  lowHeartRate: 50,
  lowSpo2: 92,
  criticalHeartRate: 150,
  criticalLowHeartRate: 40,
  criticalSpo2: 88,
} as const;

export function classifyVitals(
  bpm: number | null,
  spo2: number | null
): { status: PiStatus; severity: Severity } {
  const t = THRESHOLDS;

  if (spo2 !== null && spo2 > 0 && spo2 < t.lowSpo2) {
    return {
      status: 'LOW_SPO2',
      severity: spo2 < t.criticalSpo2 ? 'critical' : 'warning',
    };
  }
  if (bpm !== null && bpm > t.highHeartRate) {
    return {
      status: 'HIGH_HEART_RATE',
      severity: bpm > t.criticalHeartRate ? 'critical' : 'warning',
    };
  }
  if (bpm !== null && bpm > 0 && bpm < t.lowHeartRate) {
    return {
      status: 'LOW_HEART_RATE',
      severity: bpm < t.criticalLowHeartRate ? 'critical' : 'warning',
    };
  }
  return { status: 'NORMAL', severity: 'normal' };
}