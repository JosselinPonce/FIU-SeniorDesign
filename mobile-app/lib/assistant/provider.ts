import type { DriverInterpretationResponse, OfflineTranscription } from '../../modules/local-foundation-models/index.ts';
import type { Turn } from '../../modules/local-foundation-models/assistantConversation.ts';

export type GenerationInput = { transcript: string; context: string; finalRecognition?: OfflineTranscription; history?: readonly Turn[] };
export type AssistantProvider = {
  readonly mode: 'local' | 'connected';
  prepare(): Promise<void>;
  generate(input: GenerationInput, requestId: string): Promise<DriverInterpretationResponse>;
  cancel(requestId: string): Promise<void>;
  dispose(): void;
  isCurrent(): boolean;
};
/** Keeps the current native generation result, context and cancellation unchanged. */
export function localAssistantProvider(native: {
  check(): Promise<{ available: boolean; message: string }>;
  interpret(text: string, context: string, id: string): Promise<DriverInterpretationResponse>;
  cancel(id: string): Promise<void>;
}): AssistantProvider {
  return {
    mode: 'local',
    async prepare() { const result = await native.check(); if (!result.available) throw new Error(result.message); },
    generate: (input, id) => native.interpret(input.transcript, input.context, id),
    cancel: id => native.cancel(id), dispose: () => {}, isCurrent: () => true,
  };
}
/** Provider identity is fixed for the interaction; there is no fallback callback. */
export function selectAssistantProvider(mode: 'local' | 'connected', factories: {
  local(): AssistantProvider; connected(): AssistantProvider;
}): AssistantProvider {
  if (mode !== 'local' && mode !== 'connected') throw new Error('Unsupported AI mode.');
  return mode === 'local' ? factories.local() : factories.connected();
}
