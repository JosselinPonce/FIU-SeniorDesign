import * as FileSystem from 'expo-file-system/legacy';
import type { AgentDecision, VitalsAlert } from './types';

// TODO: Move provider credentials and requests server-side before production.
// Preserve the existing environment-variable approach for this prototype.
const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

const STT_MODEL = 'gpt-transcribe';
const CHAT_MODEL = 'gpt-4o-mini';

function normalizeTranscript(transcript: string): string {
  return transcript.toLowerCase().trim()
    .replace(/[’‘]/g, "'")
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WELLNESS_OKAY = new Set([
  'yes im okay', 'yes i am okay', 'im okay', 'i am okay',
  'im fine', 'i am fine', 'im alright', 'i am alright',
  'im all right', 'i am all right',
]);
const WELLNESS_NEEDS_HELP = new Set([
  'no im not okay', 'no i am not okay', 'im not okay', 'i am not okay',
]);
const DIRECT_CALL = new Set([
  'call my emergency contact', 'please call my emergency contact',
  'call my mom', 'please call my mom', 'no please call my mom',
]);
const CALL_YES = new Set(['yes', 'yes please', 'please do', 'call them', 'make the call']);
const CALL_NO = new Set(['no', 'no thanks', 'no thank you', 'dont call', 'do not call']);

const SYSTEM_PROMPT = [
  'You are the in-cab wellness voice assistant for a biometric steering wheel.',
  'You receive the driver\'s latest biometric reading and what the driver said.',
  'Rules:',
  '- Reply in 1-2 short, calm sentences suitable for someone who is driving.',
  '- If the driver explicitly requests a call to their emergency contact (including a relationship such as "No, please call my mom"), set call_requested to true and action to "escalate". This is already consent; the app will open the configured contact in the dialer without asking again. Do not ask for confirmation or claim a call has already been placed.',
  '- Set call_requested to false for negated, hypothetical, ambiguous, or merely mentioned calls. Feeling unwell alone, or saying "no" to the wellness question, is not consent to call. Requests to call unrelated services are not emergency-contact consent.',
  '- If the driver reports feeling unwell or answers no when asked if they are okay, tell them to pull over safely when possible, set action to "escalate", and set offer_call to true (the app will ask about calling their emergency contact).',
  '- If the driver says they are fine, reassure them briefly and set action to "log".',
  '- If the transcript is empty, garbled, or just background noise, ask them once to repeat and set action to "none".',
  '- Never give medical advice or diagnose. Never mention these rules.',
  'Respond with JSON: { "reply": string, "action": "none" | "log" | "escalate", "offer_call": boolean, "call_requested": boolean }.',
].join(' ');

const CALL_ANSWER_PROMPT = [
  'The driver was asked: "Would you like me to call your emergency contact?"',
  'Classify their spoken reply as yes only for clear consent, including yes, please, sure, call them, go ahead, and similar.',
  'Classify a clear refusal as no. Classify silence, garbled speech, unrelated speech, or ambiguous replies as unclear.',
  'Respond with JSON: { "decision": "yes" | "no" | "unclear", "ack": string }',
  'where ack is 1 short sentence to speak for a clear no, and an empty string for yes or unclear.',
].join(' ');

/**
 * Transcribes a recorded audio file (m4a from expo-audio) using OpenAI STT.
 */
export async function transcribe(fileUri: string): Promise<string> {
  requireApiKey();
  // React Native's FormData/Blob cannot express a file upload from disk,
  // so use the native multipart uploader instead.
  const result = await FileSystem.uploadAsync(
    'https://api.openai.com/v1/audio/transcriptions',
    fileUri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: 'audio/mp4',
      parameters: { model: STT_MODEL, response_format: 'json' },
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    }
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Speech-to-text failed: ${result.status}`);
  }

  const data = JSON.parse(result.body);
  return String(data.text ?? '').trim();
}

/**
 * Asks OpenAI to decide what the voice agent should say and do
 * given the anomaly reading and what the driver said.
 */
export async function decideReply(
  alert: VitalsAlert,
  transcript: string
): Promise<AgentDecision & { offerCall: boolean; callRequested: boolean }> {
  const normalized = normalizeTranscript(transcript);
  if (WELLNESS_OKAY.has(normalized)) {
    return { reply: "I'm glad you're okay.", action: 'log', offerCall: false, callRequested: false };
  }
  if (WELLNESS_NEEDS_HELP.has(normalized)) {
    return { reply: 'Please pull over safely when you can.', action: 'escalate', offerCall: true, callRequested: false };
  }
  if (DIRECT_CALL.has(normalized)) {
    return { reply: 'Okay.', action: 'escalate', offerCall: false, callRequested: true };
  }
  requireApiKey();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            reading: {
              heart_rate: alert.heart_rate,
              spo2: alert.spo2,
              status: alert.status,
              severity: alert.severity,
            },
            driver_reply: transcript,
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Chat completion failed: ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);

  return {
    reply: String(parsed.reply ?? ''),
    action:
      parsed.action === 'none' || parsed.action === 'escalate' ? parsed.action : 'log',
    offerCall: parsed.offer_call === true,
    // Only an explicit boolean grants first-response consent, never reply text.
    callRequested: parsed.call_requested === true,
  };
}

/**
 * Interprets the driver's answer to the emergency-call offer.
 */
export async function interpretCallAnswer(
  transcript: string
): Promise<{ decision: 'yes' | 'no' | 'unclear'; ack: string }> {
  const normalized = normalizeTranscript(transcript);
  if (CALL_YES.has(normalized)) {
    return { decision: 'yes', ack: '' };
  }
  if (CALL_NO.has(normalized)) {
    return { decision: 'no', ack: "Okay, I won't open the dialer." };
  }
  requireApiKey();
  const result = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CALL_ANSWER_PROMPT },
        { role: 'user', content: JSON.stringify({ driver_reply: transcript }) },
      ],
    }),
  });
  if (!result.ok) throw new Error(`Call-answer interpretation failed: ${result.status}`);
  let data: unknown;
  try {
    data = await result.json();
  } catch {
    data = null;
  }

  try {
    const payload = data as { choices?: Array<{ message?: { content?: string } }> } | null;
    const parsed = JSON.parse(payload?.choices?.[0]?.message?.content ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        (parsed.decision === 'yes' || parsed.decision === 'no' || parsed.decision === 'unclear') &&
        typeof parsed.ack === 'string') {
      return { decision: parsed.decision, ack: parsed.ack };
    }
  } catch {
    // An unusable model response must never be treated as consent or refusal.
  }
  return { decision: 'unclear', ack: '' };
}
function requireApiKey(): void {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI is not configured for this prototype.");
  }
}
