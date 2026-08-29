import { describe, expect, it } from "vitest";
import {
  capacityStatus,
  capacityWindow,
  exhaustedCapacity,
  isCapacityExhaustionMessage,
  releaseExpiredCapacity,
  unreportedCapacity
} from "./provider-capacity.js";

describe("provider capacity normalization", () => {
  it("normalizes percentage and reset representations", () => {
    expect(capacityWindow({ id: "none", label: "None" })).toMatchObject({
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null
    });
    expect(capacityWindow({ id: "low", label: "Low", usedPercent: -5 })).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100
    });
    expect(capacityWindow({ id: "high", label: "High", usedPercent: 140 })).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0
    });
    expect(capacityWindow({ id: "seconds", label: "Seconds", resetsAt: 1_700_000_000 }).resetsAt)
      .toBe("2023-11-14T22:13:20.000Z");
    expect(capacityWindow({ id: "milliseconds", label: "Milliseconds", resetsAt: 1_700_000_000_000 }).resetsAt)
      .toBe("2023-11-14T22:13:20.000Z");
    expect(capacityWindow({ id: "iso", label: "ISO", resetsAt: "2026-08-29T12:00:00Z" }).resetsAt)
      .toBe("2026-08-29T12:00:00.000Z");
    expect(capacityWindow({ id: "invalid", label: "Invalid", resetsAt: "not-a-date" }).resetsAt)
      .toBeNull();
  });

  it("derives available, warning, exhausted, and unreported status", () => {
    expect(capacityStatus([])).toBe("not_reported");
    expect(capacityStatus([capacityWindow({ id: "unknown", label: "Unknown" })])).toBe("available");
    expect(capacityStatus([capacityWindow({ id: "available", label: "Available", usedPercent: 50 })]))
      .toBe("available");
    expect(capacityStatus([capacityWindow({ id: "warning", label: "Warning", usedPercent: 80 })]))
      .toBe("warning");
    expect(capacityStatus([capacityWindow({ id: "exhausted", label: "Exhausted", usedPercent: 100 })]))
      .toBe("exhausted");
  });

  it("recognizes provider exhaustion language without treating ordinary failures as limits", () => {
    for (const message of [
      "usage limit reached",
      "rate limited",
      "quota has been exhausted",
      "weekly limit",
      "session limit",
      "limit reached; reset tomorrow",
      "credit balance is too low",
      "insufficient credits",
      "all configured credentials are exhausted"
    ]) {
      expect(isCapacityExhaustionMessage(message)).toBe(true);
    }
    expect(isCapacityExhaustionMessage("network connection failed")).toBe(false);
  });

  it("creates truthful provider-specific exhausted and unreported snapshots", () => {
    expect(unreportedCapacity("codex")).toMatchObject({
      provider: "codex",
      status: "not_reported",
      detail: "This harness has not reported subscription capacity."
    });
    expect(unreportedCapacity("codex", "Refresh pending").detail).toBe("Refresh pending");

    const prior = unreportedCapacity("codex");
    prior.windows = [capacityWindow({ id: "weekly", label: "Weekly", usedPercent: 100 })];
    expect(exhaustedCapacity("codex", "raw provider detail", prior)).toMatchObject({
      provider: "codex",
      detail: "Codex reported that its current usage capacity is exhausted.",
      windows: prior.windows
    });
    expect(exhaustedCapacity("claude", "raw provider detail")).toMatchObject({
      detail: "Claude Code reported that its current usage capacity is exhausted.",
      windows: []
    });
    expect(exhaustedCapacity("hermes", "raw provider detail").detail)
      .toBe("Hermes reported that its current usage capacity is exhausted.");
  });

  it("releases only exhausted snapshots whose known or inferred reset has elapsed", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const available = unreportedCapacity("codex");
    expect(releaseExpiredCapacity(available, now)).toBe(available);

    const future = exhaustedCapacity("codex", "limit");
    future.observedAt = "2026-08-29T11:59:30.000Z";
    future.windows = [capacityWindow({
      id: "weekly",
      label: "Weekly",
      usedPercent: 100,
      resetsAt: "2026-08-29T13:00:00.000Z"
    })];
    expect(releaseExpiredCapacity(future, now)).toBe(future);

    const elapsed = exhaustedCapacity("codex", "limit", future);
    elapsed.windows = [capacityWindow({
      id: "weekly",
      label: "Weekly",
      usedPercent: 100,
      resetsAt: "2026-08-29T11:00:00.000Z"
    })];
    expect(releaseExpiredCapacity(elapsed, now)).toMatchObject({
      status: "not_reported",
      detail: "The prior limit window may have reset; capacity will refresh on the next harness response."
    });

    const recentUnknown = exhaustedCapacity("hermes", "limit");
    recentUnknown.observedAt = "2026-08-29T11:59:30.000Z";
    recentUnknown.windows = [capacityWindow({ id: "unknown", label: "Unknown", usedPercent: 100 })];
    expect(releaseExpiredCapacity(recentUnknown, now)).toBe(recentUnknown);

    const staleUnknown = exhaustedCapacity("hermes", "limit");
    staleUnknown.observedAt = "not-a-date";
    expect(releaseExpiredCapacity(staleUnknown, now, 1)).toMatchObject({ status: "not_reported" });
  });
});
