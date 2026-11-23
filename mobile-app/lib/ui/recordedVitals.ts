import type { RecordedVital } from '../db/repositories';

export const RECORDED_WINDOW_SECONDS = 60;

export function recordedVitalPoints(rows: readonly RecordedVital[], start: number, seconds: number) {
  const heart = Array.from({ length: seconds }, (_, index) => ({ t: start + index * 1000, v: null as number | null }));
  const oxygen = heart.map(point => ({ ...point }));
  for (const row of rows) {
    const index = Math.floor((Date.parse(row.received_at) - start) / 1000);
    if (!heart[index] || !oxygen[index]) continue;
    // Rows arrive in recording order. Use the latest recorded frame in each second.
    heart[index].v = row.bpm;
    oxygen[index].v = row.spo2;
  }
  return { heart, oxygen };
}
