/**
 * Token bucket used to hold indexing to a deliberate rate. Without it the
 * initial index saturates the network and main thread, and the resulting
 * render churn makes scrolling stutter.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties so the file remains plain type-erasable TypeScript.
 */
export class Pacer {
  private tokens: number
  private ratePerSec: number
  private readonly burst: number
  private lastRefill = Date.now()

  /**
   * @param ratePerSec tokens granted per second
   * @param burst maximum tokens that can accumulate; must be at least the
   *   largest single `take`, otherwise that call could never be satisfied
   * @param initialTokens starting balance, so the first request need not wait
   */
  constructor(ratePerSec: number, burst: number, initialTokens = 0) {
    this.ratePerSec = ratePerSec
    this.burst = burst
    this.tokens = Math.min(initialTokens, burst)
  }

  setRate(ratePerSec: number): void {
    this.refill()
    this.ratePerSec = ratePerSec
  }

  private refill(): void {
    const now = Date.now()
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec,
    )
    this.lastRefill = now
  }

  /** Resolve once `n` tokens are available, consuming them. */
  async take(n: number): Promise<void> {
    const want = Math.min(n, this.burst)
    for (;;) {
      this.refill()
      if (this.tokens >= want) {
        this.tokens -= want
        return
      }
      const waitMs = ((want - this.tokens) / this.ratePerSec) * 1000
      await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.ceil(waitMs))))
    }
  }
}
