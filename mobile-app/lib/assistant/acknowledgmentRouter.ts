import { CLOUD_ACKNOWLEDGMENT_TIMEOUT_MS } from '../../supabase/functions/_shared/acknowledgmentTiming.ts';
import { startSafetyAcknowledgment, validateAcknowledgment, type AcknowledgmentContext, type SafetyAcknowledgment, type AcknowledgmentTerminalReason } from './safetyAcknowledgment.ts';
import { responsivenessProbe } from '../voice/responsivenessDiagnostics.ts';
import type { SensiPreferencesState } from './sensiPreferences.ts';
export type SensiAcknowledgmentScope = Readonly<{ driverId: string | null; simulation: boolean; cloudSimulation?: boolean; current(): boolean }>;
export type GemmaNativeFailure = 'native_readiness_loss' | 'timeout' | 'cancellation' | 'inference_error';
type Policy = { readonly state: SensiPreferencesState; subscribe(fn: (state: SensiPreferencesState) => void): () => void };

/** Presentation routing only. Cloud consent and identity never authorize safety actions. */
export function createLocalAcknowledgmentRouter(policy: Policy, gemma: {
  ready(): boolean;
  generate(context: AcknowledgmentContext, signal: AbortSignal, reportFailure?: (reason: GemmaNativeFailure) => void): Promise<string>;
}, cloud?: { identity?(): string | null; ready(): boolean; generate(context: AcknowledgmentContext, signal: AbortSignal, authority: { driverId: string; current(): boolean }): Promise<string> }) {
  return (context: AcknowledgmentContext, scope: SensiAcknowledgmentScope): SafetyAcknowledgment => {
    const snapshot = policy.state;
    const cloudIdentity = cloud?.identity?.();
    const current = () => scope.current() && policy.state.revision === snapshot.revision;
    const cloudCurrent = () => current() && (!scope.simulation || scope.cloudSimulation === true)
      && cloud?.identity?.() === cloudIdentity && !!scope.driverId && policy.state.loaded && !!policy.state.accountId
      && policy.state.driverId === scope.driverId && policy.state.consent
      && (policy.state.preference === 'automatic' || policy.state.preference === 'openai');
    const cloudEligible = cloudCurrent() && !!cloud?.ready();
    const trace = responsivenessProbe('warning', 'Sensi acknowledgment routing');
    let gemmaAvailableAtDispatch: boolean | undefined;
    const debug = typeof __DEV__ !== 'undefined' && __DEV__;
    let nativeFailure: GemmaNativeFailure | undefined;
    const reportNativeFailure = debug ? (reason: GemmaNativeFailure) => { nativeFailure = reason; } : undefined;
    const reportFallback = debug ? (reason: AcknowledgmentTerminalReason) => {
      if (snapshot.preference !== 'gemma' && gemmaAvailableAtDispatch === undefined) return;
      trace('Gemma terminal fallback', { locale: context.language, source: 'fallback', reason:
        reason === 'cancellation' || reason === 'timeout' ? reason
          : gemmaAvailableAtDispatch === false ? 'unavailable_at_dispatch' : nativeFailure ?? reason });
    } : undefined;
    let selected: 'openai' | 'gemma' = 'gemma';
    const task = startSafetyAcknowledgment(async signal => {
      if (!current() || signal.aborted || !snapshot.loaded || snapshot.preference === 'basic') return '';
      if (scope.driverId && cloud && cloudCurrent() && cloud.ready()) {
        try {
          const text = await cloud.generate(context, signal, { driverId: scope.driverId, current: cloudCurrent });
          if (!signal.aborted && current() && validateAcknowledgment(text, context)) { selected = 'openai'; return text; }
        } catch { /* Cloud availability never controls safety guidance. */ }
      }
      if (signal.aborted || !current()) return '';
      gemmaAvailableAtDispatch = gemma.ready();
      if (!gemmaAvailableAtDispatch) return '';
      selected = 'gemma'; return gemma.generate(context, signal, reportNativeFailure);
    }, context, cloudEligible ? CLOUD_ACKNOWLEDGMENT_TIMEOUT_MS : 5000, reportFallback);
    let unsubscribe = policy.subscribe(state => { if (state.revision !== snapshot.revision) task.cancel(); });
    const finish = () => { unsubscribe(); unsubscribe = () => {}; };
    return {
      get(lang) {
        if (!current() || (selected === 'openai' && (cloud?.identity?.() !== cloudIdentity || !cloud?.ready()))) task.cancel();
        finish();
        const text = task.get(lang);
        trace('provider at VoiceCheck selection', {
          locale: lang, source: task.source === 'fallback' ? 'fallback' : selected,
          reason: gemmaAvailableAtDispatch === undefined ? 'gemma_not_dispatched'
            : gemmaAvailableAtDispatch ? 'gemma_ready_at_dispatch' : 'gemma_unavailable_at_dispatch',
        });
        return text;
      },
      cancel() { finish(); task.cancel(); },
      get source() { return task.source === 'fallback' ? 'fallback' : selected; },
    };
  };
}
