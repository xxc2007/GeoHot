/** A bounded admission gate: rejected work allocates no queue entry. */
export class CapacityExceeded extends Error {}

export class CapacityGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  private readonly queueLimit: number;
  constructor(limit: number, queueLimit: number) { this.limit = limit; this.queueLimit = queueLimit; }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queueLimit) throw new CapacityExceeded("capacity temporarily exhausted");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
