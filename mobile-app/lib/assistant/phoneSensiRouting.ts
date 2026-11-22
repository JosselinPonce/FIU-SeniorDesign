import { VOICECHECK_BASIC_OFFLINE } from '../voice/basicOfflineAcknowledgment';
import { sensiCloudAuth } from './phoneCloudAuth';
import { createOpenAIAcknowledgment } from './openaiAcknowledgment';
import { uuidv4 } from '../ble/protocol';
import { AppState } from 'react-native';
import { sensiSetup } from '../onboarding/phone';
import { beginGemmaWarmLease, gemmaPoc, isGemmaAcknowledgmentReady, generateReadyGemmaAcknowledgment, waitForGemmaWarmCleanup, type GemmaWarmLease } from '../../modules/gemma-poc/phone';
import { sensiPreferences } from './phoneSensiPreferences';
import { createLocalAcknowledgmentRouter, type SensiAcknowledgmentScope } from './acknowledgmentRouter';
import type { AcknowledgmentContext } from './safetyAcknowledgment';

export { sensiPreferences };
const cloud = createOpenAIAcknowledgment(sensiCloudAuth, {
  url: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '', publicKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '', requestId: uuidv4,
});
export const isOpenAIAcknowledgmentReady = cloud.ready;
export const isPhoneGemmaAcknowledgmentReady = () => sensiSetup.state.terms && isGemmaAcknowledgmentReady();

const localRouter = createLocalAcknowledgmentRouter(sensiPreferences, {
  ready: isPhoneGemmaAcknowledgmentReady,
  generate: generateReadyGemmaAcknowledgment,
}, cloud);
export function phoneSensiAcknowledgment(context: AcknowledgmentContext, scope?: SensiAcknowledgmentScope) {
  return localRouter(context, scope ?? { driverId: null, simulation: true, current: () => false });
}

let prepared: GemmaWarmLease | null = null;
let preparation: AbortController | null = null;
let suppression: 'stopped' | 'memory' | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(notify => notify());

export const isGemmaPreparing = () => preparation !== null;
export const isGemmaExplicitlyStopped = () => suppression === 'stopped';
export function subscribeGemmaPreparation(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

function releasePreparation() {
  preparation?.abort(); preparation = null;
  prepared?.release(); prepared = null;
  publish();
}

export function stopPreparedGemma() {
  suppression = 'stopped';
  releasePreparation();
}

export function resumePreparedGemma() {
  suppression = null;
  prepareGemma(true);
  publish();
}

function prepareGemma(explicit = false) {
  if (VOICECHECK_BASIC_OFFLINE && !explicit) return;
  const eligible = () => sensiPreferences.state.loaded && sensiPreferences.state.preference === 'gemma'
    && sensiSetup.state.terms && sensiSetup.state.ready && !sensiSetup.state.busy && !suppression && AppState.currentState === 'active';
  if (!eligible() || preparation || isGemmaAcknowledgmentReady()) return;
  const operation = new AbortController();
  preparation = operation;
  publish();
  const deadline = setTimeout(() => { if (preparation === operation) releasePreparation(); }, 30000);
  void (async () => {
    let lease: GemmaWarmLease | null = null;
    try {
      await waitForGemmaWarmCleanup();
      if (operation.signal.aborted || !eligible() || isGemmaAcknowledgmentReady()) return;
      prepared?.release();
      prepared = lease = beginGemmaWarmLease(true);
      if (!lease) return;
      await new Promise<void>(resolve => {
        let unsubscribe: (() => void) | undefined;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          operation.signal.removeEventListener('abort', finish);
          unsubscribe?.();
          resolve();
        };
        operation.signal.addEventListener('abort', finish, { once: true });
        unsubscribe = gemmaPoc.subscribe(state => { if (!state.busy) finish(); });
        if (done) unsubscribe();
      });
    } finally {
      clearTimeout(deadline);
      if (preparation === operation) {
        preparation = null;
        if (!eligible() || !isGemmaAcknowledgmentReady()) {
          lease?.release();
          if (prepared === lease) prepared = null;
        }
        publish();
      }
    }
  })().catch(() => { /* The existing fixed acknowledgment remains available. */ });
}

let previousPreference: string | undefined;
sensiPreferences.subscribe(state => {
  if (!state.loaded || state.preference === previousPreference) return;
  const reselected = previousPreference !== undefined;
  previousPreference = state.preference;
  if (state.preference === 'gemma') {
    if (reselected) suppression = null;
    prepareGemma();
  } else if (state.preference === 'basic' || preparation) releasePreparation();
});
let wasSetupReady = false;
let wasSetupBusy = false;
sensiSetup.subscribe(state => {
  const ready = state.terms && state.ready;
  const shouldPrepare = ready && !state.busy && (!wasSetupReady || (wasSetupBusy && state.modelReady));
  if (!ready && wasSetupReady) releasePreparation();
  wasSetupReady = ready;
  wasSetupBusy = state.busy;
  if (shouldPrepare) prepareGemma();
});
let previousAppState = AppState.currentState;
AppState.addEventListener('change', state => {
  if (state === previousAppState) return;
  previousAppState = state;
  if (state === 'active') {
    if (suppression === 'memory') suppression = null;
    prepareGemma();
  } else releasePreparation();
});
AppState.addEventListener('memoryWarning', () => {
  if (!suppression) suppression = 'memory';
  releasePreparation();
});
