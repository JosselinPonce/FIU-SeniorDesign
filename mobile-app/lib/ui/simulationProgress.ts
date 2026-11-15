/** Presentation only: no live readings, engine decisions or countdown prediction. */
export function simulationProgress(demo: { scenario: string; second: number; value: number; step: string }) {
  return { label: 'SIMULATED', seconds: demo.second, value: demo.value,
    unit: demo.scenario === 'spo2' ? '%' : 'BPM', phase: demo.step };
}
