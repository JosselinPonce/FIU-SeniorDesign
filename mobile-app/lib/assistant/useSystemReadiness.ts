import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { checkOfflineSpeechCapability } from '../../modules/local-foundation-models';
import { listVoices, onDeviceLanguages } from '../voice/speechIO';
import { getSetting } from '../db/repositories';
import type { ReadinessSnapshot } from './systemReadiness';

/** Transient, read-only UI observations. No model/capture/audio lifecycle calls. */
export function useSystemReadiness(visible: boolean, language: 'en' | 'es') {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot & { language: 'en' | 'es' }>(() => ({ language,
    speech: null, installedLocales: [], responses: 'checking', foreground: AppState.currentState === 'active' }));
  useEffect(() => {
    if (!visible) return;
    let current = true, generation = 0;
    const patch = (value: Partial<ReadinessSnapshot & { language: 'en' | 'es' }>) => { if (current) setSnapshot(previous => ({ ...previous, ...value })); };
    const refresh = () => {
      const epoch = ++generation;
      if (!current || AppState.currentState !== 'active') {
        patch({ foreground: false, speech: null, installedLocales: [], responses: 'unknown' }); return;
      }
      patch({ language, foreground: true, speech: null, installedLocales: [], responses: 'checking' });
      const fresh = () => current && epoch === generation && AppState.currentState === 'active';
      void checkOfflineSpeechCapability(language === 'es' ? 'es-US' : 'en-US').then(speech => { if (fresh()) patch({ speech }); }).catch(() => {});
      if (language === 'en') void onDeviceLanguages().then(installedLocales => { if (fresh()) patch({ installedLocales }); }).catch(() => {});
      void Promise.all([listVoices(language), getSetting(`voice:${language}`)]).then(([voices, preferred]) => {
        if (fresh()) patch({ responses: voices.length && (!preferred || voices.some(voice => voice.id === preferred)) ? 'available' : 'unavailable' });
      }).catch(() => { if (fresh()) patch({ responses: 'unknown' }); });
    };
    refresh();
    const app = AppState.addEventListener('change', refresh);
    return () => { current = false; generation++; app.remove(); };
  }, [visible, language]);
  // A language change must not briefly advertise the previous language's voice.
  return snapshot.language === language ? snapshot : { ...snapshot, speech: null, installedLocales: [], responses: 'checking' as const };
}
