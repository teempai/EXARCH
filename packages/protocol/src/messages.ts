import { z } from "zod";
import { ProviderSchema } from "./events.js";

export const MessageRequestSchema = z
  .object({
    clientMessageId: z.string().min(1).max(200),
    text: z.string().min(1).max(200_000),
    provider: ProviderSchema,
    model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/).nullable().optional(),
    effectivePolicyRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();

export type MessageRequest = z.infer<typeof MessageRequestSchema>;

export const EffectivePolicySchema = z
  .object({
    provider: ProviderSchema,
    status: z.enum(["verified", "partial", "unavailable"]),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    observedAt: z.string().datetime({ offset: true }),
    source: z.string().min(1),
    native: z.record(z.string(), z.unknown()),
    normalized: z.object({
      mayExecuteWithoutPrompt: z.boolean().nullable(),
      sandbox: z.string().nullable(),
      reviewer: z.string().nullable()
    })
  })
  .strict();

export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const ProviderCapacityWindowSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
    usedPercent: z.number().min(0).max(100).nullable(),
    remainingPercent: z.number().min(0).max(100).nullable(),
    resetsAt: z.string().datetime({ offset: true }).nullable()
  })
  .strict();

export const ProviderCapacitySchema = z
  .object({
    provider: ProviderSchema,
    status: z.enum(["available", "warning", "exhausted", "not_reported"]),
    observedAt: z.string().datetime({ offset: true }),
    source: z.string().min(1).max(200),
    detail: z.string().min(1).max(500),
    windows: z.array(ProviderCapacityWindowSchema).max(20)
  })
  .strict();

export type ProviderCapacityWindow = z.infer<typeof ProviderCapacityWindowSchema>;
export type ProviderCapacity = z.infer<typeof ProviderCapacitySchema>;
