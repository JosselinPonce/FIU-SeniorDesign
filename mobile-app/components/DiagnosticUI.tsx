import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SettingsRow } from './SettingsGroup';

const labels = {
  PASS: 'Passed',
  FAIL: 'Failed',
  WARNING: 'Warning',
  'NOT TESTED': 'Not Tested',
  RUNNING: 'Running',
  UNAVAILABLE: 'Unavailable',
} as const;
export type DiagnosticVerdict = keyof typeof labels;

/** Presentation only. The caller supplies evidence; this component never starts tests. */
export function DiagnosticResult({ title, status, divider, children }: {
  title: string; status: DiagnosticVerdict; divider?: boolean; children?: ReactNode;
}) {
  const { tokens: t } = useTheme();
  const color = status === 'PASS' ? t.connected : status === 'FAIL' ? t.danger : status === 'WARNING' ? t.warning : t.textSecondary;
  return <View>
    <SettingsRow title={title} divider={divider} trailing={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, maxWidth: '46%' }}>
      {status === 'RUNNING' ? <ActivityIndicator color={color} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />}
      <Text accessibilityLiveRegion="polite" style={{ flexShrink: 1, color, fontSize: 13, fontWeight: '600' }}>{labels[status]}</Text>
    </View>} />
    {children ? <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>{children}</View> : null}
  </View>;
}

/** Mounted children preserve existing diagnostic state even when details are collapsed. */
export function DiagnosticDetails({ title = 'Technical details', children, divider = true }: {
  title?: string; children: ReactNode; divider?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <View>
    <SettingsRow title={title} divider={divider} expanded={open} onPress={() => setOpen(value => !value)} />
    <View style={open ? { paddingHorizontal: 14, paddingBottom: 12, gap: 8 } : { display: 'none' }}
      accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>{children}</View>
  </View>;
}
