/** One-use, in-memory authorization. Never a VoiceCheck consent substitute. */
export class RealContactDemoPermit {
  private used = false;
  private revoked = false;
  private readonly current: () => boolean;
  private readonly expiresAt: number;
  private readonly now: () => number;
  constructor(current: () => boolean, expiresAt: number, now: () => number = Date.now) {
    this.current = current; this.expiresAt = expiresAt; this.now = now;
  }
  claim(): boolean {
    if (this.used || this.revoked || this.now() >= this.expiresAt || !this.current()) return false;
    this.used = true; return true;
  }
  revoke() { this.revoked = true; }
}
