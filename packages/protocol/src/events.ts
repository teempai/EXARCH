import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

export const PROVIDERS = ["codex", "claude", "hermes"] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

export const EVENT_TYPES = [
  "conversation.created",
  "conversation.renamed",
  "user.message",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "turn.started",
  "turn.steered",
  "turn.interrupt.requested",
  "turn.completed",
  "turn.failed",
  "tool.started",
  "tool.output.delta",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.decided",
  "file.changed",
  "artifact.created",
  "repository.checkpointed",
  "context.snapshot.created",
  "context.decision.recorded",
  "context.task.changed",
  "provider.session.bound",
  "provider.sync.advanced",
  "provider.handoff.started",
  "provider.handoff.completed",
  "provider.process.exited",
  "security.redaction.applied",
  "provider.policy.observed"
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    sequence: z.number().int().positive(),
    type: EventTypeSchema,
    provider: ProviderSchema.nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
    previousHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    eventHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export type EventHashInput = Omit<EventEnvelope, "eventHash">;

export function hashEvent(input: EventHashInput): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;
