import { z } from "zod";
import { CONTEXT_OPERATIONS } from "./capability.js";

export const ContextRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1).max(200),
    capability: z.string().min(1).max(32_768),
    projectId: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    operation: z.enum(CONTEXT_OPERATIONS),
    arguments: z.record(z.string(), z.unknown())
  })
  .strict();

export type ContextRequest = z.infer<typeof ContextRequestSchema>;

export const ContextResponseSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string()
      })
      .optional(),
    truncated: z.boolean(),
    continuation: z.string().nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && value.error !== undefined) {
      context.addIssue({ code: "custom", message: "Successful response cannot include error" });
    }
    if (!value.ok && value.error === undefined) {
      context.addIssue({ code: "custom", message: "Failed response must include error" });
    }
  });

export type ContextResponse = z.infer<typeof ContextResponseSchema>;
