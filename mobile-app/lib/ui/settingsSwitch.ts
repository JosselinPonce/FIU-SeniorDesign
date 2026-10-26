import type { ThemeTokens } from '../theme/tokens.ts';

/** Keep native off tracks visible on iOS as well as Android. */
export function settingsSwitchColors(t: ThemeTokens) {
  return { trackColor: { false: t.switchOff, true: t.switchOn }, thumbColor: t.switchThumb,
    ios_backgroundColor: t.switchOff };
}
