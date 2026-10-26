/** Publisher metadata and immutable Git LFS pointer independently checked 2026-10-25. */
export const GEMMA_ARTIFACT = Object.freeze({
  repository: 'ggml-org/gemma-3-270m-it-qat-GGUF',
  revision: '7dba9faa7cdb58c7dc44b238c7dbb00e391fbf65',
  filename: 'gemma-3-270m-it-qat-Q4_0.gguf',
  bytes: 241410624,
  sha256: '3626e245220ca4a1c5911eb4010b3ecb7bdbf5bc53c79403c21355354d1e2dc6',
});
export const MODEL_URL = `https://huggingface.co/${GEMMA_ARTIFACT.repository}/resolve/${GEMMA_ARTIFACT.revision}/${GEMMA_ARTIFACT.filename}`;
export const TEST_PROMPT = 'A driver has said they feel unwell. Select a brief empathetic acknowledgment only. Do not ask questions, diagnose, give instructions, or claim any action. Reply exactly: I hear you.';
export function assertArtifact(bytes: number, hash: string) {
  if (bytes !== GEMMA_ARTIFACT.bytes || hash !== GEMMA_ARTIFACT.sha256)
    throw new Error('Model integrity check failed. Provision the approved artifact again.');
}
