/** A receipt is reusable only for unchanged sandbox file metadata and this exact
 * approved artifact. Missing metadata/receipt or any change requires native SHA-256. */
export type FileIdentity = { size: number; modified: number | null; created: number | null };
export type VerifiedReceipt = FileIdentity & { version: 1; uri: string; sha256: string; revision: string };
type Deps = {
  identity(uri: string): FileIdentity | null;
  read(): Promise<unknown>;
  write(receipt: VerifiedReceipt | null): Promise<void>;
  hash(uri: string, signal: AbortSignal, progress?: (bytes: number) => void): Promise<boolean>;
};
export class VerifiedModelFile {
  private deps: Deps;
  private artifact: { bytes: number; sha256: string; revision: string };
  constructor(deps: Deps, artifact: { bytes: number; sha256: string; revision: string }) { this.deps = deps; this.artifact = artifact; }
  private same(a: FileIdentity, b: FileIdentity) {
    return a.size === b.size && typeof a.modified === 'number' && Number.isFinite(a.modified)
      && a.modified === b.modified && a.created === b.created;
  }
  async remember(uri: string) {
    const identity = this.deps.identity(uri);
    if (!identity || identity.size !== this.artifact.bytes || identity.modified === null) return;
    await this.deps.write({ ...identity, version: 1, uri, sha256: this.artifact.sha256, revision: this.artifact.revision });
  }
  async verify(uri: string, signal: AbortSignal, progress?: (bytes: number) => void, force = false) {
    const check = () => { if (signal.aborted) throw new Error('Model verification cancelled.'); };
    check();
    const before = this.deps.identity(uri);
    if (!before) return false;
    if (before.size !== this.artifact.bytes) throw new Error('Model size is incorrect. Provision the model again.');
    let receipt: any;
    try { receipt = await this.deps.read(); } catch { /* Native verification below. */ }
    check();
    if (!force && receipt?.version === 1 && receipt.uri === uri && receipt.sha256 === this.artifact.sha256
        && receipt.revision === this.artifact.revision && this.same(before, receipt)) {
      progress?.(before.size); return true;
    }
    // A forced verification failure must never leave an earlier receipt trusted.
    await this.deps.write(null); check();
    if (!await this.deps.hash(uri, signal, progress)) return false;
    check();
    const after = this.deps.identity(uri);
    if (!after || before.size !== after.size || before.modified !== after.modified || before.created !== after.created)
      throw new Error('Model changed during verification. Retry setup.');
    if (after.modified !== null) {
      try { await this.deps.write({ ...after, version: 1, uri, sha256: this.artifact.sha256, revision: this.artifact.revision }); }
      catch { /* A failed receipt write never substitutes for hashing. */ }
    }
    check(); return true;
  }
}
