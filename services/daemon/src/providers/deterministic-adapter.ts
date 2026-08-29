import { createHash } from "node:crypto";
import { canonicalJson, type EffectivePolicy, type Provider } from "../../../../packages/protocol/src/index.js";
import type {
  NormalizedProviderEvent,
  ProviderApprovalDecisionInput,
  ProviderAdapter,
  ProviderHealth,
  ProviderTurnInput
} from "./provider-adapter.js";

export class DeterministicProviderAdapter implements ProviderAdapter {
  readonly policy: EffectivePolicy;
  readonly interruptedTurns = new Set<string>();

  constructor(
    readonly provider: Provider,
    private readonly response: (input: ProviderTurnInput) => string = (input) =>
      `${provider}: ${input.text}`
  ) {
    const native = { mode: "deterministic-test", approval_policy: "on-request" };
    const revision = `sha256:${createHash("sha256").update(canonicalJson(native)).digest("hex")}`;
    this.policy = {
      provider,
      status: "verified",
      revision,
      observedAt: "2026-08-23T12:00:00.000Z",
      source: "deterministic-adapter",
      native,
      normalized: {
        mayExecuteWithoutPrompt: false,
        sandbox: "test",
        reviewer: "user"
      }
    };
  }

  async probe(): Promise<ProviderHealth> {
    return { provider: this.provider, available: true, version: "test", detail: "ready", reason: "ready" };
  }

  async observeEffectivePolicy(_cwd?: string): Promise<EffectivePolicy> {
    return this.policy;
  }

  async *startTurn(input: ProviderTurnInput): AsyncIterable<NormalizedProviderEvent> {
    yield { type: "assistant.message.started", payload: {} };
    if (input.signal.aborted || this.interruptedTurns.has(input.turnId)) {
      throw new Error("Turn interrupted");
    }
    const text = this.response(input);
    yield { type: "assistant.message.delta", payload: { text } };
    yield { type: "assistant.message.completed", payload: { text } };
  }

  async interruptTurn(turnId: string): Promise<void> {
    this.interruptedTurns.add(turnId);
  }

  async respondToApproval(_input: ProviderApprovalDecisionInput): Promise<void> {
    throw new Error("Deterministic provider has no pending approvals");
  }
}
