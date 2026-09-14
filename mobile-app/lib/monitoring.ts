import { loadProfile } from './profiles';
import { supabase } from './supabase';
import { classifyVitals, type TelemetryEvent, type VitalsAlert } from './types';

/**
 * Subscribes to real-time inserts on public.telemetry_events.
 * `ping` events are ignored; vitals events are classified and only
 * abnormal readings are passed to onAlert.
 * Returns an unsubscribe function.
 */
export function subscribeToVitals(
  onAlert: (alert: VitalsAlert) => void
): () => void {
  // TODO: Scope this subscription to the selected driver/session once identity exists.
  const channel = supabase
    .channel('telemetry-events')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'telemetry_events' },
      (payload) => {
        const event = payload.new as TelemetryEvent;

        if (event.event_type !== 'vitals') {
          return;
        }

        // The Pi's uploader currently sends vitals rows with null bpm/spo2.
        if (event.bpm === null && event.spo2 === null) {
          return;
        }

        const { status, severity } = classifyVitals(event.bpm, event.spo2);

        if (status === 'NORMAL') {
          return;
        }

        onAlert({
          eventId: event.id,
          sessionId: event.session_id,
          heart_rate: event.bpm ?? 0,
          spo2: event.spo2 ?? 0,
          signal_quality: event.signal_quality,
          status,
          severity,
          timestamp: event.received_at,
        });
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/** Load only the contact belonging to the selected prototype driver. */
export async function getEmergencyContact(profileId: string | null): Promise<{
  name: string;
  phone: string;
}> {
  if (!profileId) throw new Error('Select and save a driver profile in Profile / Setup first.');
  const profile = await loadProfile(profileId);
  if (!profile.emergency_contact_phone?.trim()) {
    throw new Error('The selected driver has no emergency contact phone number. Update Profile / Setup.');
  }
  return {
    name: profile.emergency_contact_name || profile.display_name || 'your emergency contact',
    phone: profile.emergency_contact_phone,
  };
}

/**
 * Records what the voice agent said and did about an anomaly
 * in the public.incidents table.
 */
export async function logIncident(alert: VitalsAlert, input: {
  driverReply: string;
  response: string;
  action: 'none' | 'log' | 'escalate';
  askedEmergencyCall?: boolean;
  callPlaced?: boolean;
}): Promise<void> {
  const { error } = await supabase.from('incidents').insert({
    telemetry_event_id: alert.eventId,
    session_id: alert.sessionId,
    heart_rate: Math.round(alert.heart_rate),
    spo2: Math.round(alert.spo2),
    status: alert.status,
    severity: alert.severity,
    driver_reply: input.driverReply,
    response: input.response,
    action: input.action,
    asked_emergency_call: input.askedEmergencyCall ?? false,
    call_placed: input.callPlaced ?? false,
  });

  if (error) {
    throw new Error(`Failed to log incident: ${error.message}`);
  }
}