import { createHash } from "node:crypto";
import { canonicalJson } from "../../../../packages/protocol/src/index.js";
import type {
  EffectivePolicy,
  EventType,
  Provider,
  ProviderCapacity
} from "../../../../packages/protocol/src/index.js";

export interface ProviderHealth {
  provider: Provider;
  available: boolean;
  version: string | null;
  detail: string;
  reason: ProviderAvailabilityReason;
}

export type ProviderAvailabilityReason =
  | "ready"
  | "authentication_required"
  | "not_installed"
  | "unsupported_version"
  | "probe_timed_out"
  | "probe_failed"
  | "not_configured";

export interface ProviderModel {
  id: string;
  displayName: string;
  description: string | null;
}

export interface ProviderTurnInput {
  conversationId: string;
  turnId: string;
  text: string;
  model?: string;
  cwd: string;
  context: {
    recentEvents: unknown[];
    synchronizedThroughSequence: number;
    cliCommand?: string;
  };
  signal: AbortSignal;
}

export interface NormalizedProviderEvent {
  type: EventType;
  payload: Record<string, unknown>;
}

export interface ProviderApprovalDecisionInput {
  turnId: string;
  requestId: string;
  actionCommitment: string;
  choice: string;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  probe(): Promise<ProviderHealth>;
  listModels?(): Promise<ProviderModel[]>;
  observeCapacity?(): Promise<ProviderCapacity>;
  observeEffectivePolicy(cwd?: string): Promise<EffectivePolicy>;
  bindSession?(
    conversationId: string,
    nativeSessionId: string,
    metadata: Record<string, unknown>,
    synchronizedThroughSequence: number
  ): void;
  startTurn(input: ProviderTurnInput): AsyncIterable<NormalizedProviderEvent>;
  interruptTurn(turnId: string): Promise<void>;
  respondToApproval(input: ProviderApprovalDecisionInput): Promise<void>;
}

export class ProviderCapacityExhaustedError extends Error {
  constructor(
    readonly provider: Provider,
    readonly capacity: ProviderCapacity,
    readonly retrySafe = false
  ) {
    super(capacity.detail);
    this.name = "ProviderCapacityExhaustedError";
  }
}

export function providerProbeFailure(
  provider: Provider,
  displayName: string,
  error: unknown
): ProviderHealth {
  const code = errorCode(error);
  if (code === "ENOENT") {
    return {
      provider,
      available: false,
      version: null,
      detail: `${displayName} was not found in EXARCH's configured executable locations. Rescan harnesses after installing or moving it.`,
      reason: "not_installed"
    };
  }
  if (code === "ETIMEDOUT" || errorMessage(error).toLowerCase().includes("timed out")) {
    return {
      provider,
      available: false,
      version: null,
      detail: `${displayName} did not respond to its version check within 5 seconds.`,
      reason: "probe_timed_out"
    };
  }
  return {
    provider,
    available: false,
    version: null,
    detail: `${displayName} version check failed: ${errorMessage(error)}`,
    reason: "probe_failed"
  };
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "unknown process error";
}

export function providerApprovalActionCommitment(action: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson({
    domain: "exarch/provider-approval-action/1",
    action
  })).digest("hex")}`;
}

export function providerApprovalHandle(identity: unknown): string {
  return `approval-native:${createHash("sha256").update(canonicalJson({
    domain: "exarch/provider-approval-handle/1",
    identity
  })).digest("base64url")}`;
}

export const PROVIDER_EVENT_BUFFER_ITEMS = 1_024;
export const PROVIDER_EVENT_BUFFER_BYTES = 8 * 1024 * 1024;
export const PROVIDER_PENDING_APPROVAL_LIMIT = 128;

export function providerEventSize(event: NormalizedProviderEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
