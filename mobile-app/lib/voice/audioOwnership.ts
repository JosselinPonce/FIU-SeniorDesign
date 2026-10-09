/** Shared ownership of app speech. Safety interrupts optional conversations/previews. */
export class AudioOwnership {
  private owner: { token: object; stop: () => Promise<void>; priority: 'optional' | 'safety' } | null = null;
  private safetyPending = false;
  get available(): boolean { return this.owner === null && !this.safetyPending; }

  async stopActive(): Promise<void> {
    const previous = this.owner;
    if (previous) await previous.stop();
    if (!this.available) throw new Error('Speech cleanup is still in progress. Please try again.');
  }

  async acquire(priority: 'optional' | 'safety', stop: () => Promise<void>): Promise<() => void> {
    if (this.safetyPending) throw new Error('Safety audio is starting.');
    if (this.owner) {
      if (priority !== 'safety' || this.owner.priority === 'safety') throw new Error('Another speech operation is active.');
      this.safetyPending = true;
      const previous = this.owner;
      try {
        await previous.stop(); // must finish capture/playback cleanup before handover
        if (this.owner === previous) throw new Error('Previous audio has not released ownership.');
      } finally { this.safetyPending = false; }
    }
    const token = {};
    this.owner = { token, stop, priority };
    return () => { if (this.owner?.token === token) this.owner = null; };
  }
}
export const appAudio = new AudioOwnership();
