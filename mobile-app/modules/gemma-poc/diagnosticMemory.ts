import { requireOptionalNativeModule } from 'expo';
import { requireDebugDiagnostic, type MemorySample } from './contextualDiagnostic';

/** Optional Debug bridge; a missing rebuild never prevents the inference suite. */
export async function readGemmaDiagnosticMemory(): Promise<MemorySample> {
  requireDebugDiagnostic();
  const native = requireOptionalNativeModule<{ gemmaMemorySnapshot?(): Promise<MemorySample> }>('ModelFileHash');
  return native?.gemmaMemorySnapshot ? native.gemmaMemorySnapshot()
    : { status: 'unavailable', reason: 'rebuild_debug_native_bridge' };
}
