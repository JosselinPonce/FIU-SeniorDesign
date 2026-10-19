import type { ConversationMessage } from '../../modules/local-foundation-models/assistantConversation.ts';

/** Completion confirms playback, never that a person heard it. */
export function playbackLabel(playback: ConversationMessage['playback']): string | undefined {
  return playback ? ({ pending: 'Waiting for playback', playing: 'Playing…', completed: 'Playback completed',
    interrupted: 'Playback interrupted · may be incomplete', failed: 'Playback unconfirmed · may be incomplete' })[playback] : undefined;
}
export function nearThreadBottom(contentHeight: number, viewportHeight: number, offset: number): boolean {
  return contentHeight - viewportHeight - offset <= 80;
}
