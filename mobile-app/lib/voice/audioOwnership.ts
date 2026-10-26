/** Shared ownership of app speech. Safety interrupts optional conversations/previews. */
export class AudioOwnership {
  private owner: { token: object; stop: () => Promise<void>; priority: 'optional' | 'safety' } | null = null;
  private safetyPending = false;
  get available(): boolean { return this.owner === null && !this.safetyPending; }

  private async stopWithinDeadline(stop: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(stop), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Speech cleanup timed out; audio ownership is retained.')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async stopActive(): Promise<void> {
    const previous = this.owner;
    if (previous) await this.stopWithinDeadline(previous.stop);
    if (!this.available) throw new Error('Speech cleanup is still in progress. Please try again.');
  }

  async acquire(priority: 'optional' | 'safety', stop: () => Promise<void>): Promise<() => void> {
    if (this.safetyPending) throw new Error('Safety audio is starting.');
    if (this.owner) {
      if (priority !== 'safety' || this.owner.priority === 'safety') throw new Error('Another speech operation is active.');
      this.safetyPending = true;
      const previous = this.owner;
      try {
        await this.stopWithinDeadline(previous.stop); // never hand over before cleanup
        if (this.owner === previous) throw new Error('Previous audio has not released ownership.');
      } finally { this.safetyPending = false; }
    }
    const token = {};
    this.owner = { token, stop, priority };
    return () => { if (this.owner?.token === token) this.owner = null; };
  }
}
export const appAudio = new AudioOwnership();
