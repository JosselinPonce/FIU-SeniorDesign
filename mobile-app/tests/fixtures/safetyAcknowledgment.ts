/** Prompt/output fixtures only; these are not recorded GGUF completions. */
export const safetyAcknowledgmentFixtures = [
  { event: 'bpm_high', language: 'en', statement: "I'm dizzy", output: "I'm sorry you're feeling dizzy." },
  { event: 'bpm_low', language: 'en', statement: 'I feel weak', output: "I hear that you're feeling weak." },
  { event: 'spo2_low', language: 'es', statement: 'Me siento mareada', output: 'Lamento que te sientas mareada.' },
  { event: 'bpm_high', language: 'es', statement: 'Estoy mal', output: 'Entiendo que te sientes mal.' },
] as const;
