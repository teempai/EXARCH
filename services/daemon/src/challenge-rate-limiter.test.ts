import { describe, expect, it } from "vitest";
import { ChallengeRateLimiter } from "./challenge-rate-limiter.js";

describe("ChallengeRateLimiter", () => {
  it("preserves concurrent retries while bounding one claimed device", () => {
    const limiter = new ChallengeRateLimiter(() => 1_000, 10_000, 3, 10);
    expect(limiter.consume("device_1")).toBe(true);
    expect(limiter.consume("device_1")).toBe(true);
    expect(limiter.consume("device_1")).toBe(true);
    expect(limiter.consume("device_1")).toBe(false);
    expect(limiter.consume("device_2")).toBe(true);
  });

  it("bounds random-ID floods with one connection budget", () => {
    const limiter = new ChallengeRateLimiter(() => 1_000, 10_000, 2, 4);
    expect([0, 1, 2, 3].map((index) => limiter.consume(`unknown_${index}`))).toEqual([
      true, true, true, true
    ]);
    expect(limiter.consume("device_legitimate")).toBe(false);
  });

  it("clears all bounded state when the window resets", () => {
    let now = 1_000;
    const limiter = new ChallengeRateLimiter(() => now, 10_000, 1, 2);
    expect(limiter.consume("device_1")).toBe(true);
    expect(limiter.consume("device_1")).toBe(false);
    expect(limiter.retryAfterSeconds()).toBe(10);
    now = 11_000;
    expect(limiter.consume("device_1")).toBe(true);
  });
});
