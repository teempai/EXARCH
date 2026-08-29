import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { ProviderSchema } from "./events.js";

export const ApprovalDecisionRequestSchema = z
  .object({
    choice: z.string().min(1).max(100),
    decidedAt: z.string().datetime({ offset: true }),
    signature: z.string().min(32).max(512)
  })
  .strict();

export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export interface ApprovalDigestInput {
  approvalId: string;
  conversationId: string;
  turnId: string;
  provider: z.infer<typeof ProviderSchema>;
  providerRequestId: string;
  /** The directory the provider is running in, so an approval names its own blast radius. */
  cwd: string;
  request: Record<string, unknown>;
  choices: string[];
  expiresAt: string;
}

export interface ApprovalDecisionSignatureInput {
  approvalId: string;
  approvalDigest: string;
  choice: string;
  deviceId: string;
  decidedAt: string;
}

/**
 * The exact bytes the digest is taken over. These are shipped to the device
 * alongside the digest so it can verify by hashing what it received and then
 * comparing the fields inside against what it rendered, rather than by
 * reproducing this encoding. Byte-identical canonical JSON across TypeScript
 * and Swift is not something to put in an authorization path.
 */
export function approvalDigestPayload(input: ApprovalDigestInput): Buffer {
  return Buffer.from(canonicalJson({ version: 1, ...input }), "utf8");
}

export function approvalDigest(input: ApprovalDigestInput): string {
  return `sha256:${createHash("sha256").update(approvalDigestPayload(input)).digest("hex")}`;
}

export function approvalDecisionSignaturePayload(input: ApprovalDecisionSignatureInput): Buffer {
  return Buffer.from(canonicalJson({ version: 1, ...input }), "utf8");
}
