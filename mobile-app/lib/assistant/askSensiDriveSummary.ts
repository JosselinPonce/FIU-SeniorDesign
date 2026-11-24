import { WARNING_LABELS, type DriveContext } from '../../supabase/functions/_shared/askSensi.ts';

export function isDriveOverview(question: string): boolean {
  const text = question.trim().toLowerCase().replace(/[.!?]+$/u, '');
  return /^(?:please )?(?:(?:summari[sz]e|give me a summary of|show me a summary of) (?:my|this|the)(?: selected| last)? (?:drive|trip|session)(?: in a table)?|what does this drive summary show|resume (?:mi|este|el) viaje|¿?qué muestra este resumen del viaje)$/u.test(text);
}

export function formatRecordedDriveSummary(context: DriveContext, when: string, t: (key: string) => string): string {
  const metric = (value: number | null, unit: string) => value === null ? t('Not recorded') : `${Number(value.toFixed(1))} ${unit}`;
  const metrics = [
    [t('Heart rate'), context.heartRate, 'bpm'],
    [t('Estimated SpO₂'), context.oxygen, '%'],
  ] as const;
  const summary = [
    `**${t('Recorded drive')}**${when ? ` · ${when}` : ''}`,
    `### ${t('Recorded biometrics')}`,
    `| ${t('Measurement')} | ${t('Avg')} | ${t('Min')} | ${t('Max')} |`,
    '| --- | --- | --- | --- |',
    ...metrics.map(([label, values, unit]) =>
      `| **${label}** | ${metric(values.average, unit)} | ${metric(values.min, unit)} | ${metric(values.max, unit)} |`),
    '',
    `- ${t('Usable samples:')} ${context.samples}`,
  ];
  if (context.trend) {
    for (const [label, first, last, unit] of [
      [t('Heart rate'), context.trend.heartRateFirst, context.trend.heartRateLast, 'bpm'],
      [t('Estimated SpO₂'), context.trend.oxygenFirst, context.trend.oxygenLast, '%'],
    ] as const) {
      if (first !== null && last !== null) {
        summary.push(`- ${label} · ${t('First-half average')}: ${metric(first, unit)} · ${t('Second-half average')}: ${metric(last, unit)}`);
      }
    }
  }
  summary.push('', `### ${t('Recorded safety events')}`);
  if (context.warningCount) {
    summary.push(`- ${t('Recorded warnings:')} ${context.warningCount}`);
    const groups = new Map<string, { kind: keyof typeof WARNING_LABELS; level: string | null; count: number }>();
    for (const row of context.warningGroups ?? context.warnings.map(warning => ({ ...warning, count: 1 }))) {
      const kind = Object.hasOwn(WARNING_LABELS, row.kind) ? row.kind as keyof typeof WARNING_LABELS : 'other';
      const level = row.level === 'critical' || row.level === 'warning' || row.level === 'notice' ? row.level : null;
      const key = `${kind}:${level}`;
      const existing = groups.get(key);
      groups.set(key, { kind, level, count: (existing?.count ?? 0) + row.count });
    }
    for (const { kind, level, count } of groups.values()) {
      const severity = level ? ` (${t({ critical: 'Critical', warning: 'Warning', notice: 'Notice' }[level] ?? level)})` : '';
      const occurrences = t(count === 1 ? '{count} recorded occurrence' : '{count} recorded occurrences').replace('{count}', String(count));
      summary.push(`- ${t(WARNING_LABELS[kind])}${severity} — ${occurrences}`);
    }
  } else summary.push(t('No warnings were recorded.'));
  summary.push('', `### ${t('Limitations')}`, t('Recorded sensor estimates and app events cannot establish a diagnosis or fitness to drive.'));
  return summary.join('\n');
}
