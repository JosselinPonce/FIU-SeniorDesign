/** Presentation compatibility values, independent of the optional provider policy.
 * Basic responses retain the same Sensi conversation rather than switching to core UI. */
export type AssistantMode = 'gemma' | 'core' | 'local' | 'connected';
export const SENSI_MODE = 'gemma' as const;
