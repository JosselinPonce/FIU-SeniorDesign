import type { PocState } from '../../modules/gemma-poc/controller.ts';

/** Presentation only: never grants model readiness or starts runtime work. */
export function gemmaStatusLabels(state: PocState) {
  const model = state.installed ? 'Verified · 241 MB' : 'Not verified in this app session';
  let session: string;
  if (state.busy && (state.phase === 'Unloading model' || state.cleanupRequired)) session = 'Releasing Gemma…';
  else if (state.busy && state.phase === 'Stopping') session = 'Stopping; waiting for native cleanup…';
  else if (state.busy && state.phase === 'Loading model') session = 'Preparing Gemma…';
  else if (state.busy && /Verifying/.test(state.phase)) session = 'Checking model…';
  else if (state.busy && /Downloading/.test(state.phase)) session = 'Downloading model…';
  else if (state.busy) session = 'Gemma is working…';
  else if (state.error || state.cleanupRequired) session = 'Needs attention';
  else if (state.loaded) session = 'Model loaded';
  else session = 'Not prepared';
  return { model, session };
}
