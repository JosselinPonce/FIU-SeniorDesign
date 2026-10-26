import type { ConversationMessage } from '../../modules/local-foundation-models/assistantConversation.ts';
import type { AssistantMode } from './mode.ts';
import type { CheckQuestion, CheckResult } from '../voice/voiceCheck.ts';

/** Transient display state only. Never persist this or derive consent from it. */
export type SafetyConversation = { episodeId: string; mode: AssistantMode; messages: ConversationMessage[]; finished: boolean; simulation?: boolean; acknowledgmentSource?: 'gemma' | 'fallback' };
export function canOfferSafetyContinuation(result: CheckResult): boolean {
  return result.outcome === 'ok' && result.contactCall === 'not_requested';
}
export function safetyButtonText(question: CheckQuestion, positive: boolean): string {
  return question === 'contact_offer' ? positive ? 'Open phone interface' : 'No thanks' : positive ? "I'm OK" : "I'm not OK";
}
export function simulationCompletion(result: CheckResult): string {
  return result.contactCall === 'explicit_request' || result.contactCall === 'accepted_offer'
    ? 'Simulation complete. In a real emergency, DriveSense would open the phone interface.'
    : result.contactCall === 'declined_offer'
    ? 'Simulation complete. You declined the call. No phone interface was opened.'
    : 'Simulation complete. No phone interface was opened.';
}
