import type {
  Provider,
  ProviderCapacity,
  ProviderCapacityWindow
} from "../../../../packages/protocol/src/index.js";

const CAPACITY_PATTERNS = [
  /usage limit/i,
  /rate limit(?:ed| reached| exceeded)?/i,
  /quota (?:has been )?(?:exceeded|exhausted|reached)/i,
  /weekly limit/i,
  /session limit/i,
  /limit reached.*reset/i,
  /credit balance (?:is )?too low/i,
  /insufficient (?:credits|quota)/i,
  /all .*credentials.*exhausted/i
];

export function unreportedCapacity(
  provider: Provider,
  detail = "This harness has not reported subscription capacity."
): ProviderCapacity {
  return {
    provider,
    status: "not_reported",
    observedAt: new Date().toISOString(),
    source: `${provider} provider`,
    detail,
    windows: []
  };
}

export function capacityWindow(input: {
  id: string;
  label: string;
  usedPercent?: number | null;
  resetsAt?: number | string | null;
}): ProviderCapacityWindow {
  const usedPercent = input.usedPercent == null
    ? null
    : Math.max(0, Math.min(100, input.usedPercent));
  return {
    id: input.id,
    label: input.label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: timestamp(input.resetsAt)
  };
}

export function capacityStatus(windows: ProviderCapacityWindow[]): ProviderCapacity["status"] {
  if (windows.some((window) => window.usedPercent !== null && window.usedPercent >= 100)) {
    return "exhausted";
  }
  if (windows.some((window) => window.usedPercent !== null && window.usedPercent >= 80)) {
    return "warning";
  }
  return windows.length === 0 ? "not_reported" : "available";
}

export function isCapacityExhaustionMessage(message: string): boolean {
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(message));
}

export function exhaustedCapacity(
  provider: Provider,
  _message: string,
  prior?: ProviderCapacity
): ProviderCapacity {
  return {
    provider,
    status: "exhausted",
    observedAt: new Date().toISOString(),
    source: `${provider} provider error`,
    detail: `${providerDisplayName(provider)} reported that its current usage capacity is exhausted.`,
    windows: prior?.windows ?? []
  };
}

export function releaseExpiredCapacity(
  capacity: ProviderCapacity,
  now = Date.now(),
  unknownResetCooldownMs = 60_000
): ProviderCapacity {
  if (capacity.status !== "exhausted") return capacity;
  const resets = capacity.windows.flatMap((window) => {
    if (window.resetsAt === null) return [];
    const value = new Date(window.resetsAt).getTime();
    return Number.isNaN(value) ? [] : [value];
  });
  const observedAt = new Date(capacity.observedAt).getTime();
  const shouldRelease = resets.length > 0
    ? resets.every((reset) => reset <= now)
    : Number.isNaN(observedAt) || now - observedAt >= unknownResetCooldownMs;
  if (!shouldRelease) return capacity;
  return unreportedCapacity(
    capacity.provider,
    "The prior limit window may have reset; capacity will refresh on the next harness response."
  );
}

function timestamp(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function providerDisplayName(provider: Provider): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  return "Hermes";
}
