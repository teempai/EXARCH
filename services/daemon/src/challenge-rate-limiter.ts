const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_PER_DEVICE_LIMIT = 120;
const DEFAULT_CONNECTION_LIMIT = 600;

/**
 * The laptop API is loopback-only and the relay bridge carries one pinned Noise
 * device connection. Its global budget is therefore the current connection
 * budget; device-ID buckets additionally prevent one claimed ID from consuming
 * all legitimate retries. No proxy-provided address is trusted here.
 */
export class ChallengeRateLimiter {
  private windowStartedAt: number;
  private total = 0;
  private readonly devices = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly perDeviceLimit = DEFAULT_PER_DEVICE_LIMIT,
    private readonly connectionLimit = DEFAULT_CONNECTION_LIMIT
  ) {
    if (
      !Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(perDeviceLimit) || perDeviceLimit < 1 ||
      !Number.isSafeInteger(connectionLimit) || connectionLimit < perDeviceLimit
    ) {
      throw new Error("Challenge rate-limit configuration is invalid");
    }
    this.windowStartedAt = now();
  }

  consume(deviceId: string): boolean {
    const current = this.now();
    if (current - this.windowStartedAt >= this.windowMs || current < this.windowStartedAt) {
      this.windowStartedAt = current;
      this.total = 0;
      this.devices.clear();
    }
    if (this.total >= this.connectionLimit) return false;
    const deviceCount = this.devices.get(deviceId) ?? 0;
    if (deviceCount >= this.perDeviceLimit) return false;
    this.total += 1;
    this.devices.set(deviceId, deviceCount + 1);
    return true;
  }

  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.windowStartedAt + this.windowMs - this.now()) / 1_000));
  }
}
