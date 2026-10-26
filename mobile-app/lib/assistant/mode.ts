/** Historical presentation values remain accepted by deterministic regression fixtures.
 * There is no runtime provider selector; the application always uses Gemma. */
export type AssistantMode = 'gemma' | 'core' | 'local' | 'connected';
export const SENSI_MODE = 'gemma' as const;
