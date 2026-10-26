import { Platform, AppState } from 'react-native';
import { File } from 'expo-file-system';
import * as FS from 'expo-file-system/legacy';
import { nativeFileHash } from '../model-file-hash';
import { verifyNativeFile } from '../model-file-hash/verification';
import { GEMMA_ARTIFACT, MODEL_URL } from './artifact';
import { GemmaPoc } from './controller';
import { ModelProvisioner } from './provisioning';
import { VerifiedModelFile } from './verifiedFile';
import { startSafetyAcknowledgment } from '../../lib/assistant/safetyAcknowledgment';
import { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT } from '../../lib/onboarding/gemmaTerms';

function supported() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw new Error('Gemma requires a native iOS or Android development build.');
  if (!FS.documentDirectory) throw new Error('Persistent model storage is unavailable.');
}
function paths() {
  supported();
  const directory = `${FS.documentDirectory}gemma-poc/`;
  return { directory, model: directory + GEMMA_ARTIFACT.filename, staging: directory + 'download.part' };
}
/** Presence only: never hash, load, download or claim runtime readiness on navigation. */
export function inspectGemmaModelFile(): 'present' | 'missing' | 'unavailable' {
  try {
    const file = new File(paths().model);
    return file.exists && file.size === GEMMA_ARTIFACT.bytes ? 'present' : 'missing';
  } catch { return 'unavailable'; }
}
function checkCancelled(signal: AbortSignal) { if (signal.aborted) throw new Error('Gemma operation cancelled.'); }
const verifiedModel = new VerifiedModelFile({
  identity: uri => {
    const file = new File(uri);
    return file.exists ? { size: file.size, modified: file.modificationTime, created: file.creationTime } : null;
  },
  read: async () => JSON.parse(await FS.readAsStringAsync(paths().directory + 'verified-installation.json')),
  write: receipt => FS.writeAsStringAsync(paths().directory + 'verified-installation.json', JSON.stringify(receipt)),
  hash: (uri, signal, progress) => verifyNativeFile(nativeFileHash(), uri, GEMMA_ARTIFACT, signal, progress),
}, GEMMA_ARTIFACT);
async function verifyFile(uri: string, signal: AbortSignal, progress?: (bytes: number) => void, force = false) {
  checkCancelled(signal);
  const verified = await verifiedModel.verify(uri, signal, progress, force);
  if (verified) {
    const directory = paths().directory;
    await Promise.all([
      FS.writeAsStringAsync(directory + 'NOTICE', 'Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms\n'),
      FS.writeAsStringAsync(directory + 'GEMMA_TERMS.txt', GEMMA_TERMS_TEXT),
      FS.writeAsStringAsync(directory + 'GEMMA_USE_POLICY.txt', GEMMA_POLICY_TEXT),
    ]);
    checkCancelled(signal);
  }
  return verified;
}

// One staging-file owner, including native cleanup after a cancelled transfer.
const provisioner = new ModelProvisioner({
  bytes: GEMMA_ARTIFACT.bytes,
  prepare: async () => {
    const p = paths();
    if (await FS.getFreeDiskStorageAsync() < GEMMA_ARTIFACT.bytes * 2)
      throw new Error('At least 483 MB of free storage is required for safe model provisioning.');
    await FS.makeDirectoryAsync(p.directory, { intermediates: true });
    await FS.deleteAsync(p.staging, { idempotent: true });
  },
  transfer: progress => {
    const download = FS.createDownloadResumable(MODEL_URL, paths().staging, {},
      event => progress(event.totalBytesWritten));
    return {
      download: async () => {
        try {
          const result = await download.downloadAsync();
          if (!result || result.status !== 200) throw new Error(`Model download failed (${result?.status ?? 'cancelled'}).`);
        } finally {
          // Expo's legacy API otherwise retains the progress subscription after
          // completion. Its UUID-scoped cancel is harmless once the task ended.
          void download.cancelAsync().catch(() => {});
        }
      },
      // We discard partial files: cancel directly rather than generating resume data.
      cancel: () => download.cancelAsync(),
    };
  },
  verify: async (signal, progress) => {
    if (!await verifyFile(paths().staging, signal, progress, true)) throw new Error('Downloaded model file is missing.');
  },
  activate: async signal => {
    const p = paths(); checkCancelled(signal);
    await FS.deleteAsync(p.model, { idempotent: true });
    checkCancelled(signal);
    await FS.moveAsync({ from: p.staging, to: p.model });
    checkCancelled(signal);
    await verifiedModel.remember(p.model);
  },
  discard: () => FS.deleteAsync(paths().staging, { idempotent: true }),
});

// A single process-wide controller prevents two native contexts.
export const gemmaPoc = new GemmaPoc({
  verify: (signal, progress, force) => verifyFile(paths().model, signal, progress, force),
  provision: (signal, progress) => provisioner.run(signal, progress),
  initialize: async () => {
    supported();
    try {
      const { initLlama } = await import('llama.rn');
      const context = await initLlama({ model: paths().model, n_ctx: 512, n_batch: 64,
        n_threads: 2, n_gpu_layers: Platform.OS === 'ios' ? 99 : 0, use_mlock: false, use_mmap: true });
      return {
        generate: async prompt => (await context.completion({ messages: [{ role: 'user', content: prompt }],
          n_predict: 32, temperature: 0, stop: ['<end_of_turn>', '<eos>'] })).text,
        stop: () => context.stopCompletion(), release: () => context.release(),
      };
    } catch (error) {
      throw new Error(`Gemma native initialization failed. Use a rebuilt compatible physical device (not Expo Go); check memory and Metal support. ${String(error)}`);
    }
  },
});

let safetyGemmaOwned = false;
/** Event-only warm request. Never provisions or downloads a model. */
export function phoneSafetyAcknowledgment() {
  return startSafetyAcknowledgment(async signal => {
    if (safetyGemmaOwned || gemmaPoc.state.busy || AppState.currentState !== 'active') throw new Error('Gemma is busy or app is inactive.');
    safetyGemmaOwned = true;
    let current = true;
    const cancel = () => gemmaPoc.cancel();
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { current = false; cancel(); }
    });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted || !current) return '';
      if (!gemmaPoc.state.loaded) await gemmaPoc.load();
      if (signal.aborted || !current || !gemmaPoc.state.loaded) return '';
      const text = await gemmaPoc.selectSafetyAcknowledgment();
      return signal.aborted || !current ? '' : text;
    } finally {
      signal.removeEventListener('abort', cancel);
      subscription.remove();
      await gemmaPoc.dispose();
      safetyGemmaOwned = false;
    }
  });
}
