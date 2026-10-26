import { requireOptionalNativeModule } from 'expo';
import type { HashBridge } from './verification.ts';

export function nativeFileHash(): HashBridge {
  const native = requireOptionalNativeModule<HashBridge>('ModelFileHash');
  if (!native?.hashFile || !native.cancelHash || !native.addListener)
    throw new Error('Native SHA-256 module is missing. Rebuild the iOS/Android development app; reloading Metro alone is insufficient.');
  return native;
}
